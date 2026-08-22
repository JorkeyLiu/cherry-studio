/**
 * ChatDb IPC handler registration.
 *
 * Registers a fixed set of typed IPC handlers matching the ChatDb IpcChannel entries.
 * Each handler:
 * 1. Validates the request using the shared contract validators.
 * 2. Delegates to ChatDbAggregateService.
 * 3. Maps errors to stable shared error codes.
 * 4. Validates the constructed result via shared validateChatDbResult.
 * 5. If the result is invalid, catches it as an internal error and returns
 *    a valid ERR_STORAGE failure envelope; validates that fallback too.
 * 6. Always resolves (never throws across IPC).
 *
 * Design:
 * - Dedicated module invoked from central src/main/ipc.ts.
 * - Fixed typed channels only; no execute/query/repository CRUD.
 * - No implicit init and no fallback.
 * - Returns disposer/removeHandler for lifecycle management.
 * - Re-registration is safe: a new call disposes the prior registration
 *   before installing fresh handlers. A stale disposer from a prior
 *   registration is a no-op (ownership check).
 * - Logging: context, IDs, and SQLite codes only; never full payloads.
 * - Channel typed as ChatDbChannel, not generic string.
 */

import { loggerService } from '@logger'
import type {
  AppendMessageRequest,
  BulkAddBlocksRequest,
  ChatDbChannel,
  ChatDbResult,
  CloneMessagesToTopicRequest,
  CountFileRefsByFileRequest,
  DeleteBlocksRequest,
  DeleteMessageRequest,
  DeleteMessagesRequest,
  DeleteMessagesWithSegmentsRequest,
  DeleteSegmentRequest,
  EmptyTrashTopicsRequest,
  EnsureTopicRequest,
  FetchMessagesRequest,
  FetchMessagesWindowRequest,
  GetRawTopicRequest,
  HardDeleteTopicRequest,
  ListBlocksByFileRequest,
  ListFileRefsByFileRequest,
  ListSegmentsRequest,
  ListTrashTopicsRequest,
  PasteMessagesToTopicRequest,
  PurgeExpiredTopicsRequest,
  ReorderMessagesRequest,
  ReplaceSegmentMembershipRequest,
  ResetAssistantTopicsRequest,
  ResetMessagesForResendRequest,
  RestoreTopicRequest,
  SearchMessagesRequest,
  SelectAnswerMessageRequest,
  SoftDeleteTopicRequest,
  TopicExistsRequest,
  TransferTopicOwnershipRequest,
  UpdateBlocksRequest,
  UpdateMessageAndBlocksRequest,
  UpdateMessageRequest,
  UpdateSegmentMetadataRequest,
  UpdateSingleBlockRequest,
  UpdateTopicMetadataRequest,
  UpsertSegmentRequest
} from '@shared/chatDb'
import { ERR_VALIDATION, fail, validateChatDbRequest, validateChatDbResult } from '@shared/chatDb'
import { elapsedMs, MAX_APPEND_DIAGNOSTIC_LOGS } from '@shared/diagnostics/sendTiming'
import { IpcChannel } from '@shared/IpcChannel'
import { ipcMain } from 'electron'

import { logMainDiagnostic } from '../diagnostics'
import { ChatDbAggregateService } from './ChatDbAggregateService'
import { internalStorageFailure, mapErrorToResult, validateConstructedResult } from './errors'
import { chatDbService } from './index'
import { recordStreamAttrRecord } from './streamingMeasure'

const logger = loggerService.withContext('ChatDbIpc')

// ---------------------------------------------------------------------------
// Module-level registration state — tracks the active registration for
// safe re-registration and stale-disposer ownership.
// ---------------------------------------------------------------------------

/** Monotonically increasing registration ID. */
let activeRegistrationId = 0

/**
 * The disposer function for the currently active registration.
 * Null if no registration is active.
 */
let activeDisposer: (() => void) | null = null

// ---------------------------------------------------------------------------
// Channel → aggregate method mapping
// ---------------------------------------------------------------------------

/**
 * Register all ChatDb IPC handlers.
 *
 * Re-registration safety:
 * - If a prior registration exists, it is disposed before installing new
 *   handlers. This makes repeated calls safe even when the central caller
 *   ignores the returned disposer.
 * - The returned disposer only removes handlers if it owns the active
 *   registration. A stale disposer from a prior call is a no-op.
 *
 * @returns  A disposer function that removes all registered handlers.
 *           Only effective if this is the active registration at disposal time.
 */
export function registerChatDbIpc(): () => void {
  // Dispose any prior registration before installing new handlers
  if (activeDisposer) {
    logger.info('Disposing prior ChatDb IPC registration before re-registering')
    activeDisposer()
    activeDisposer = null
  }

  const registrationId = ++activeRegistrationId
  const handlers: Array<{ channel: string; handler: (...args: any[]) => any }> = []

  /**
   * Get the aggregate service. Throws if DB is not initialised.
   */
  function getAggregate(): ChatDbAggregateService {
    if (!chatDbService.isInitialised()) {
      throw new Error('ChatDbService has not been initialised')
    }
    return new ChatDbAggregateService(chatDbService.getDatabase(), chatDbService.getSqlite())
  }

  /**
   * Handle a ChatDb command: validate request, delegate, validate result.
   * Always resolves; never throws across IPC.
   *
   * @param channel  IPC channel string. Cast to ChatDbChannel for shared validators.
   */
  function handleCommand(
    channel: string,
    execute: (aggregate: ChatDbAggregateService, request: any) => ChatDbResult<any>
  ): void {
    // All ChatDb channels are valid ChatDbChannel values.
    // Cast once for shared validator calls.
    const chatDbChannel = channel as ChatDbChannel

    const handler = async (_event: Electron.IpcMainInvokeEvent, request: unknown): Promise<ChatDbResult<any>> => {
      // LOCK-001/003/004: bounded append-handler timing (correlation-gated).
      // Fires on success AND failure without changing the result. Correlation
      // metadata is captured ONLY after the request passes validation, so a
      // malformed diagnostics payload never emits a timing log and never
      // echoes unvalidated values (LOCK-002).
      const isAppendChannel = channel === IpcChannel.ChatDb_AppendMessage
      // PERF-STREAM-ATTR-001: the streaming persistence write channels are
      // measurement-gated the same way (LOCK-STREAM-ATTR-001/003): only a
      // validated, closed-field diagnostics payload triggers a bounded record.
      const isStreamWriteChannel =
        channel === IpcChannel.ChatDb_UpdateSingleBlock || channel === IpcChannel.ChatDb_UpdateBlocks
      const t0 = performance.now()
      let appendOutcomeOk = false
      let appendCorrelationId: string | undefined
      let appendOrdinal: number | undefined
      let streamOutcomeOk = false
      let streamCorrelationId: string | undefined
      let streamOrdinal: number | undefined
      try {
        // Step 1: Validate request against contract
        try {
          validateChatDbRequest(chatDbChannel, request)
        } catch (validationError) {
          const message = validationError instanceof Error ? validationError.message : String(validationError)
          logger.warn(`[${channel}] Request validation failed: ${message}`)
          const result = fail(ERR_VALIDATION, message, false)
          validateConstructedResult(result, channel)
          return result
        }

        // LOCK-004: capture validated correlation metadata for the timing log.
        // Only reached after validation, so diagnostics values are contract
        // shaped (string correlationId / positive integer ordinal).
        if (isAppendChannel) {
          const appendDiag = (request as AppendMessageRequest)?.diagnostics
          appendCorrelationId = appendDiag?.correlationId
          appendOrdinal = appendDiag?.ordinal
        }
        // Same closed-shape rule for the streaming write channels.
        if (isStreamWriteChannel) {
          const streamDiag = (request as UpdateSingleBlockRequest | UpdateBlocksRequest)?.diagnostics
          streamCorrelationId = streamDiag?.correlationId
          streamOrdinal = streamDiag?.ordinal
        }

        // Step 2: Get aggregate service (may fail if DB unavailable)
        let aggregate: ChatDbAggregateService
        try {
          aggregate = getAggregate()
        } catch (error) {
          const result = mapErrorToResult(error, `${channel}/init`)
          validateConstructedResult(result, channel)
          return result
        }

        // Step 3: Execute command
        const result = execute(aggregate, request)
        appendOutcomeOk = result.ok === true
        streamOutcomeOk = result.ok === true

        // Step 4: Validate constructed result via shared contract validator
        try {
          validateChatDbResult(chatDbChannel, result)
        } catch (resultValidationError) {
          // Aggregate constructed an invalid result — internal programming error.
          // Return a valid ERR_STORAGE failure envelope instead.
          const reason =
            resultValidationError instanceof Error ? resultValidationError.message : String(resultValidationError)
          const fallback = internalStorageFailure(channel, `Invalid result envelope: ${reason}`)
          // Validate the fallback itself is well-formed
          validateConstructedResult(fallback, channel)
          return fallback
        }

        // Also run the basic structural check (defense in depth)
        validateConstructedResult(result, channel)

        return result
      } finally {
        // LOCK-004: correlate with the renderer's IPC round-trip via the
        // same opaque correlation id; bounded to the first few appends.
        // Only string correlation ids (the contract shape) trigger logging.
        if (isAppendChannel && typeof appendCorrelationId === 'string' && appendCorrelationId.length > 0) {
          logMainDiagnostic('main.append.handler', elapsedMs(t0), MAX_APPEND_DIAGNOSTIC_LOGS, {
            correlationId: appendCorrelationId,
            ordinal: appendOrdinal,
            ok: appendOutcomeOk
          })
        }
        // PERF-STREAM-ATTR-001: bounded measurement records for the streaming
        // write channels (LOCK-STREAM-ATTR-001/003/005). Inert unless the
        // measurement switch is enabled; fires on success AND failure.
        if (isStreamWriteChannel && typeof streamCorrelationId === 'string' && streamCorrelationId.length > 0) {
          recordStreamAttrRecord({
            channel,
            stage: 'main.handler',
            correlationId: streamCorrelationId,
            ordinal: streamOrdinal,
            durationMs: elapsedMs(t0),
            ok: streamOutcomeOk
          })
        }
      }
    }

    ipcMain.handle(channel, handler)
    handlers.push({ channel, handler })
  }

  // =========================================================================
  // Register the fixed ChatDb handler set (Phase 5.1A, Phase 5.1B, search,
  // and Phase 5.2B empty-trash)
  // =========================================================================

  // 1. fetch-messages
  handleCommand(IpcChannel.ChatDb_FetchMessages, (agg, req: FetchMessagesRequest) => {
    return agg.fetchMessages(req.topicId)
  })

  // 1b. fetch-messages-window (S6.1 R-02/R-03 typed window)
  handleCommand(IpcChannel.ChatDb_FetchMessagesWindow, (agg, req: FetchMessagesWindowRequest) => {
    return agg.fetchMessagesWindow(req)
  })

  // 2. get-raw-topic
  handleCommand(IpcChannel.ChatDb_GetRawTopic, (agg, req: GetRawTopicRequest) => {
    return agg.getRawTopic(req.topicId)
  })

  // 3. topic-exists
  handleCommand(IpcChannel.ChatDb_TopicExists, (agg, req: TopicExistsRequest) => {
    return agg.topicExists(req.topicId)
  })

  // 4. ensure-topic
  handleCommand(IpcChannel.ChatDb_EnsureTopic, (agg, req: EnsureTopicRequest) => {
    return agg.ensureTopic(req.topicId, req.assistantId, req.name)
  })

  // 5. append-message
  handleCommand(IpcChannel.ChatDb_AppendMessage, (agg, req: AppendMessageRequest) => {
    return agg.appendMessage(req.topicId, req.message, req.blocks, req.insertIndex, req.diagnostics)
  })

  // 6. update-message
  handleCommand(IpcChannel.ChatDb_UpdateMessage, (agg, req: UpdateMessageRequest) => {
    return agg.updateMessage(req.topicId, req.messageId, req.updates)
  })

  // 7. update-message-and-blocks
  handleCommand(IpcChannel.ChatDb_UpdateMessageAndBlocks, (agg, req: UpdateMessageAndBlocksRequest) => {
    return agg.updateMessageAndBlocks(req.topicId, req.messageUpdates, req.blocksToUpdate, req.blockIdsToDelete)
  })

  // 7b. select-answer-message (PERF-100): one atomic multi-model answer
  // selection — validates topic ownership of every supplied ID and persists
  // exactly one foldSelected=true in one Main transaction.
  handleCommand(IpcChannel.ChatDb_SelectAnswerMessage, (agg, req: SelectAnswerMessageRequest) => {
    return agg.selectAnswerMessage(req.topicId, req.selectedMessageId, req.messageIds)
  })

  // 8. delete-message
  handleCommand(IpcChannel.ChatDb_DeleteMessage, (agg, req: DeleteMessageRequest) => {
    return agg.deleteMessage(req.topicId, req.messageId)
  })

  // 9. delete-messages
  handleCommand(IpcChannel.ChatDb_DeleteMessages, (agg, req: DeleteMessagesRequest) => {
    return agg.deleteMessages(req.topicId, req.messageIds)
  })

  // 10. update-blocks
  handleCommand(IpcChannel.ChatDb_UpdateBlocks, (agg, req: UpdateBlocksRequest) => {
    return agg.updateBlocks(req.blocks, req.diagnostics)
  })

  // 11. update-single-block
  handleCommand(IpcChannel.ChatDb_UpdateSingleBlock, (agg, req: UpdateSingleBlockRequest) => {
    return agg.updateSingleBlock(req.blockId, req.updates, req.diagnostics)
  })

  // 12. bulk-add-blocks
  handleCommand(IpcChannel.ChatDb_BulkAddBlocks, (agg, req: BulkAddBlocksRequest) => {
    return agg.bulkAddBlocks(req.blocks)
  })

  // 13. delete-blocks
  handleCommand(IpcChannel.ChatDb_DeleteBlocks, (agg, req: DeleteBlocksRequest) => {
    return agg.deleteBlocks(req.blockIds)
  })

  // 14. list-segments (Phase 5.1A)
  handleCommand(IpcChannel.ChatDb_ListSegments, (agg, req: ListSegmentsRequest) => {
    return agg.listSegments(req.topicId)
  })

  // 15. upsert-segment (Phase 5.1A)
  handleCommand(IpcChannel.ChatDb_UpsertSegment, (agg, req: UpsertSegmentRequest) => {
    return agg.upsertSegment(req.segmentId, req.topicId, req.name, req.messageIds, req.color)
  })

  // 16. update-segment-metadata (Phase 5.1A)
  handleCommand(IpcChannel.ChatDb_UpdateSegmentMetadata, (agg, req: UpdateSegmentMetadataRequest) => {
    return agg.updateSegmentMetadata(req.segmentId, req.name, req.color)
  })

  // 17. delete-segment (Phase 5.1A)
  handleCommand(IpcChannel.ChatDb_DeleteSegment, (agg, req: DeleteSegmentRequest) => {
    return agg.deleteSegment(req.segmentId)
  })

  // 18. replace-segment-membership (Phase 5.1A)
  handleCommand(IpcChannel.ChatDb_ReplaceSegmentMembership, (agg, req: ReplaceSegmentMembershipRequest) => {
    return agg.replaceSegmentMembership(req.segmentId, req.messageIds)
  })

  // 19. reorder-messages (Phase 5.1A)
  handleCommand(IpcChannel.ChatDb_ReorderMessages, (agg, req: ReorderMessagesRequest) => {
    return agg.reorderMessages(req.topicId, req.messageIds)
  })

  // 20. list-file-refs-by-file (Phase 5.1A, read-only)
  handleCommand(IpcChannel.ChatDb_ListFileRefsByFile, (agg, req: ListFileRefsByFileRequest) => {
    return agg.listFileRefsByFile(req.fileId)
  })

  // 21. count-file-refs-by-file (Phase 5.1A, read-only)
  handleCommand(IpcChannel.ChatDb_CountFileRefsByFile, (agg, req: CountFileRefsByFileRequest) => {
    return agg.countFileRefsByFile(req.fileId)
  })

  // 22. list-blocks-by-file (Phase 5.1A, read-only)
  handleCommand(IpcChannel.ChatDb_ListBlocksByFile, (agg, req: ListBlocksByFileRequest) => {
    return agg.listBlocksByFile(req.fileId)
  })

  // 23. update-topic-metadata (Phase 5.1B)
  handleCommand(IpcChannel.ChatDb_UpdateTopicMetadata, (agg, req: UpdateTopicMetadataRequest) => {
    return agg.updateTopicMetadata(req.topicId, req.name, req.pinned, req.prompt, req.isNameManuallyEdited)
  })

  // 24. soft-delete-topic (Phase 5.1B)
  handleCommand(IpcChannel.ChatDb_SoftDeleteTopic, (agg, req: SoftDeleteTopicRequest) => {
    return agg.softDeleteTopic(req.topicId, req.name)
  })

  // 25. restore-topic (Phase 5.1B)
  handleCommand(IpcChannel.ChatDb_RestoreTopic, (agg, req: RestoreTopicRequest) => {
    return agg.restoreTopic(req.topicId)
  })

  // 26. list-trash-topics (Phase 5.1B)
  handleCommand(IpcChannel.ChatDb_ListTrashTopics, (agg, req: ListTrashTopicsRequest) => {
    return agg.listTrashTopics(req.assistantId, req.limit, req.cursor)
  })

  // 27. hard-delete-topic (Phase 5.1B)
  handleCommand(IpcChannel.ChatDb_HardDeleteTopic, (agg, req: HardDeleteTopicRequest) => {
    return agg.hardDeleteTopic(req.topicId)
  })

  // 28. purge-expired-topics (Phase 5.1B)
  handleCommand(IpcChannel.ChatDb_PurgeExpiredTopics, (agg, req: PurgeExpiredTopicsRequest) => {
    return agg.purgeExpiredTopics(req.cutoffTimestamp)
  })

  // 29. clone-messages-to-topic (Phase 5.1B)
  handleCommand(IpcChannel.ChatDb_CloneMessagesToTopic, (agg, req: CloneMessagesToTopicRequest) => {
    return agg.cloneMessagesToTopic(req.targetTopicId, req.entries, req.assistantId)
  })

  // 30. reset-messages-for-resend (Phase 5.1B)
  handleCommand(IpcChannel.ChatDb_ResetMessagesForResend, (agg, req: ResetMessagesForResendRequest) => {
    return agg.resetMessagesForResend(req.topicId, req.messages, req.blockIdsToDelete)
  })

  // 31. delete-messages-with-segments (Phase 5.1B)
  handleCommand(IpcChannel.ChatDb_DeleteMessagesWithSegments, (agg, req: DeleteMessagesWithSegmentsRequest) => {
    return agg.deleteMessagesWithSegments(req.topicId, req.messageIds)
  })

  // 32. paste-messages-to-topic (Phase 5.1B)
  handleCommand(IpcChannel.ChatDb_PasteMessagesToTopic, (agg, req: PasteMessagesToTopicRequest) => {
    return agg.pasteMessagesToTopic(req.topicId, req.entries, req.insertIndex)
  })

  // 33. search-messages (Phase 5.1B-2)
  handleCommand(IpcChannel.ChatDb_SearchMessages, (agg, req: SearchMessagesRequest) => {
    return agg.searchMessages(req)
  })

  // 35. empty-trash-topics (Phase 5.2B, LOCK-531)
  handleCommand(IpcChannel.ChatDb_EmptyTrashTopics, (agg, req: EmptyTrashTopicsRequest) => {
    return agg.emptyTrashTopics(req.assistantId)
  })

  handleCommand(IpcChannel.ChatDb_TransferTopicOwnership, (agg, req: TransferTopicOwnershipRequest) => {
    return agg.transferTopicOwnership(req.topicId, req.assistantId)
  })

  handleCommand(IpcChannel.ChatDb_ResetAssistantTopics, (agg, req: ResetAssistantTopicsRequest) => {
    return agg.resetAssistantTopics(req.assistantId, req.replacementTopicId)
  })

  logger.info(`Registered ${handlers.length} ChatDb IPC handlers (registration #${registrationId})`)

  // Build disposer with ownership check
  const disposer = () => {
    // Only remove handlers if this is still the active registration.
    // A stale disposer from a prior call is a no-op.
    if (activeRegistrationId !== registrationId) {
      logger.warn(`Stale disposer (registration #${registrationId}) ignored; ` + `active is #${activeRegistrationId}`)
      return
    }

    for (const { channel } of handlers) {
      ipcMain.removeHandler(channel)
    }
    logger.info(`Removed ${handlers.length} ChatDb IPC handlers (registration #${registrationId})`)

    // Clear active state only if this registration is still the active one
    if (activeRegistrationId === registrationId) {
      activeDisposer = null
    }
  }

  activeDisposer = disposer
  return disposer
}
