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
  BranchMessagesToTopicRequest,
  BulkAddBlocksRequest,
  ChatDbChannel,
  ChatDbResult,
  CloneMessagesToTopicRequest,
  CountFileRefsByFileRequest,
  CreateBranchRequest,
  CreateReferencedTopicRequest,
  DeleteBlocksRequest,
  DeleteBranchRequest,
  DeleteMessageRequest,
  DeleteMessagesRequest,
  DeleteMessagesWithDependentsRequest,
  DeleteMessagesWithSegmentsRequest,
  DeleteSegmentRequest,
  EmptyTrashTopicsRequest,
  EnsureAssistantTopicsRequest,
  EnsureTopicRequest,
  ExportTopicDataRequest,
  FetchAnswerGroupRequest,
  FetchClipboardGroupsRequest,
  FetchContextClosureRequest,
  FetchMessagesRequest,
  FetchMessagesWindowRequest,
  FetchTopicActivityRequest,
  FetchTopicNamingContextRequest,
  FetchWholeTopicSnapshotRequest,
  GetRawTopicRequest,
  HardDeleteTopicRequest,
  ImportTopicDataRequest,
  InsertMessageGroupsRequest,
  InsertMessagesAfterAnchorRequest,
  ListBlocksByFileRequest,
  ListBranchesRequest,
  ListFileRefsByFileRequest,
  ListLiveAssistantTopicsRequest,
  ListSegmentsRequest,
  ListTrashTopicsRequest,
  MoveSelectedTurnsToNewBranchRequest,
  PasteMessagesToTopicRequest,
  PurgeExpiredTopicsRequest,
  RegenerateAssistantMessageRequest,
  RenameBranchRequest,
  ReorderAnswerGroupRequest,
  ReorderMessagesRequest,
  ReplaceSegmentMembershipRequest,
  ResendUserMessagesRequest,
  ResetAssistantTopicsRequest,
  ResetMessagesForResendRequest,
  ResolveContextClosureRequest,
  RestoreTopicRequest,
  SearchMessagesRequest,
  SelectAnswerMessageRequest,
  SelectUsefulAnswerRequest,
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
import {
  ERR_VALIDATION,
  fail,
  validateChatDbRequest,
  validateChatDbResult,
  validateTopicDeletionEvent
} from '@shared/chatDb'
import { elapsedMs, MAX_APPEND_DIAGNOSTIC_LOGS } from '@shared/diagnostics/sendTiming'
import { IpcChannel } from '@shared/IpcChannel'
import { BrowserWindow, ipcMain } from 'electron'

import { logMainDiagnostic } from '../diagnostics'
import { handleChatDbSuccessForSync, isCapturableSyncChannel } from '../sync/chatDbHook'
import { ChatDbAggregateService } from './ChatDbAggregateService'
import { broadcastChatProjectionInvalidation, broadcastHistoryReferenceInvalidation } from './chatProjectionBroadcast'
import { internalStorageFailure, mapErrorToResult, validateConstructedResult } from './errors'
import { chatDbService } from './index'

const logger = loggerService.withContext('ChatDbIpc')

/**
 * Channels whose sync intent already committed atomically inside the
 * aggregate Drizzle transaction (LOCK-PERSONAL-006). The IPC layer must not
 * invoke post-commit hook capture for them — a second op with a fresh id
 * would duplicate intent. The hook remains as fallback for direct (test)
 * callers whose rows bypassed the aggregate.
 */
const TX_OWNED_SYNC_CHANNELS: ReadonlySet<string> = new Set<string>([
  IpcChannel.ChatDb_EnsureTopic,
  IpcChannel.ChatDb_EnsureAssistantTopics,
  IpcChannel.ChatDb_AppendMessage,
  IpcChannel.ChatDb_UpdateMessage,
  IpcChannel.ChatDb_UpdateMessageAndBlocks,
  IpcChannel.ChatDb_UpdateBlocks,
  IpcChannel.ChatDb_UpdateSingleBlock,
  IpcChannel.ChatDb_BulkAddBlocks,
  IpcChannel.ChatDb_DeleteBlocks,
  IpcChannel.ChatDb_DeleteMessage,
  IpcChannel.ChatDb_DeleteMessages,
  IpcChannel.ChatDb_UpdateTopicMetadata,
  IpcChannel.ChatDb_SoftDeleteTopic,
  IpcChannel.ChatDb_HardDeleteTopic,
  IpcChannel.ChatDb_RestoreTopic
])

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
// Authoritative deletion broadcast — Main → all renderer windows
// ---------------------------------------------------------------------------

const DELETION_BROADCAST_CHANNELS: ReadonlySet<string> = new Set([
  IpcChannel.ChatDb_HardDeleteTopic,
  IpcChannel.ChatDb_PurgeExpiredTopics,
  IpcChannel.ChatDb_EmptyTrashTopics,
  IpcChannel.ChatDb_ResetAssistantTopics
])

function broadcastTopicDeletion(deletedTopicIds: string[], _senderWebContentsId?: number): void {
  if (!Array.isArray(deletedTopicIds) || deletedTopicIds.length === 0) return
  const payload = { deletedTopicIds: [...deletedTopicIds] }
  try {
    validateTopicDeletionEvent(payload)
  } catch {
    logger.warn(`[broadcastTopicDeletion] invalid payload, skipping broadcast`)
    return
  }
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (win.isDestroyed()) continue
      const wc = win.webContents
      if (!wc || wc.isDestroyed()) continue
      wc.send(IpcChannel.ChatDb_TopicDeleted, payload)
    } catch {
      // best-effort, never throw
    }
  }
}

function extractDeletedTopicIds(resultValue: unknown): string[] | undefined {
  if (!resultValue || typeof resultValue !== 'object' || Array.isArray(resultValue)) return undefined
  const v = resultValue as Record<string, unknown>
  if (!('deletedTopicIds' in v)) return undefined
  const ids = v.deletedTopicIds
  if (!Array.isArray(ids)) return undefined
  return ids as string[]
}

/**
 * Local chat-commit channels whose success wakes every live renderer via the
 * chat-projection hint (reason `local-commit`). Pure reads, deletion-family
 * channels (covered by the deletion broadcast), and the read-only directory
 * itself never enter here. Rollback/failure never signals.
 */
const CHAT_PROJECTION_LOCAL_CHANNELS: ReadonlySet<string> = new Set([
  IpcChannel.ChatDb_EnsureTopic,
  IpcChannel.ChatDb_AppendMessage,
  IpcChannel.ChatDb_UpdateMessage,
  IpcChannel.ChatDb_UpdateMessageAndBlocks,
  IpcChannel.ChatDb_SelectAnswerMessage,
  IpcChannel.ChatDb_SelectUsefulAnswer,
  IpcChannel.ChatDb_DeleteMessage,
  IpcChannel.ChatDb_DeleteMessages,
  IpcChannel.ChatDb_UpdateTopicMetadata,
  IpcChannel.ChatDb_SoftDeleteTopic,
  IpcChannel.ChatDb_RestoreTopic,
  IpcChannel.ChatDb_TransferTopicOwnership,
  IpcChannel.ChatDb_ResetAssistantTopics,
  IpcChannel.ChatDb_EnsureAssistantTopics,
  IpcChannel.ChatDb_BranchMessagesToTopic,
  IpcChannel.ChatDb_CreateBranch,
  IpcChannel.ChatDb_DeleteBranch,
  IpcChannel.ChatDb_MoveSelectedTurnsToNewBranch,
  IpcChannel.ChatDb_CloneMessagesToTopic,
  IpcChannel.ChatDb_ResetMessagesForResend,
  IpcChannel.ChatDb_ResendUserMessages,
  IpcChannel.ChatDb_RegenerateAssistantMessage,
  IpcChannel.ChatDb_DeleteMessagesWithSegments,
  IpcChannel.ChatDb_DeleteMessagesWithDependents,
  IpcChannel.ChatDb_PasteMessagesToTopic,
  IpcChannel.ChatDb_InsertMessagesAfterAnchor,
  IpcChannel.ChatDb_InsertMessageGroups,
  IpcChannel.ChatDb_ReorderMessages,
  IpcChannel.ChatDb_ReorderAnswerGroup,
  IpcChannel.ChatDb_UpsertSegment,
  IpcChannel.ChatDb_ReplaceSegmentMembership
])

function topicIdsFromRequest(request: unknown): string[] {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return []
  const r = request as Record<string, unknown>
  const out: string[] = []
  for (const key of ['topicId', 'sourceTopicId', 'targetTopicId'] as const) {
    const v = r[key]
    if (typeof v === 'string' && v.length > 0 && !out.includes(v)) out.push(v)
  }
  return out
}

function assistantIdsFromRequest(request: unknown): string[] {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return []
  const v = (request as Record<string, unknown>).assistantId
  return typeof v === 'string' && v.length > 0 ? [v] : []
}

function branchIdsFromRequest(request: unknown): string[] {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return []
  const r = request as Record<string, unknown>
  const out: string[] = []
  for (const key of ['branchId', 'parentBranchId', 'sourceBranchId'] as const) {
    const v = r[key]
    if (typeof v === 'string' && v.length > 0 && !out.includes(v)) out.push(v)
  }
  return out
}

// ---------------------------------------------------------------------------
// History-reference invalidation broadcast — Main → all renderer windows
//
// When a referenced SOURCE topic changes (rename/mutation/delete), each target
// topic's projection (its LIVE foreign prefix) becomes stale. Reuse the
// existing per-window push pattern: look up target topic IDs for the mutated
// source (indexed) and notify renderers so they re-read affected targets. The
// query is skipped entirely when no target points at the source. Never throws.
// ---------------------------------------------------------------------------

/**
 * Source-mutation channels whose success may stale a reference target. The
 * handler resolves targets by the request `topicId` and broadcasts only when
 * at least one target exists.
 */
const REFERENCE_SOURCE_INVALIDATION_CHANNELS: ReadonlySet<string> = new Set<string>([
  IpcChannel.ChatDb_UpdateTopicMetadata,
  IpcChannel.ChatDb_SoftDeleteTopic,
  IpcChannel.ChatDb_RestoreTopic,
  IpcChannel.ChatDb_UpdateMessage,
  IpcChannel.ChatDb_UpdateMessageAndBlocks,
  IpcChannel.ChatDb_UpdateBlocks,
  IpcChannel.ChatDb_UpdateSingleBlock,
  IpcChannel.ChatDb_BulkAddBlocks,
  IpcChannel.ChatDb_DeleteBlocks,
  IpcChannel.ChatDb_DeleteMessage,
  IpcChannel.ChatDb_DeleteMessages,
  IpcChannel.ChatDb_ReorderMessages,
  IpcChannel.ChatDb_SelectAnswerMessage,
  IpcChannel.ChatDb_SelectUsefulAnswer,
  IpcChannel.ChatDb_ReorderAnswerGroup,
  IpcChannel.ChatDb_InsertMessagesAfterAnchor,
  IpcChannel.ChatDb_InsertMessageGroups,
  IpcChannel.ChatDb_AppendMessage,
  IpcChannel.ChatDb_CloneMessagesToTopic,
  IpcChannel.ChatDb_PasteMessagesToTopic,
  IpcChannel.ChatDb_ResetMessagesForResend,
  IpcChannel.ChatDb_ResendUserMessages,
  IpcChannel.ChatDb_RegenerateAssistantMessage,
  IpcChannel.ChatDb_UpsertSegment,
  IpcChannel.ChatDb_UpdateSegmentMetadata,
  IpcChannel.ChatDb_DeleteSegment,
  IpcChannel.ChatDb_ReplaceSegmentMembership,
  // Branch removal changes a source route: a target whose captured source
  // branch (or an ancestor of it) is removed stales to 'missing', so the
  // source topic's targets re-read.
  IpcChannel.ChatDb_DeleteBranch
])

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
      const t0 = performance.now()
      let appendOutcomeOk = false
      let appendCorrelationId: string | undefined
      let appendOrdinal: number | undefined
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

        // Authoritative deletion broadcast — only after successful transaction/result validation
        // and only for hard-deletion channels with non-empty exact IDs.
        if (result.ok === true && DELETION_BROADCAST_CHANNELS.has(channel)) {
          const ids = extractDeletedTopicIds((result as { value: unknown }).value)
          if (ids && ids.length > 0) {
            const senderId = _event.sender?.id
            broadcastTopicDeletion(ids, senderId)
            // Referenced sources that were deleted stale their targets.
            for (const deletedId of ids) {
              try {
                const targets = aggregate.listReferenceTargets(deletedId)
                if (targets.ok === true && targets.value.targetTopicIds.length > 0) {
                  broadcastHistoryReferenceInvalidation(deletedId, targets.value.targetTopicIds)
                }
              } catch {
                // best-effort invalidation only
              }
            }
          }
        }

        // History-reference invalidation for source-topic mutations (rename,
        // content/order/segment edits): notify target renderers to re-read.
        if (result.ok === true && REFERENCE_SOURCE_INVALIDATION_CHANNELS.has(channel)) {
          const sourceTopicId = (request as { topicId?: unknown })?.topicId
          if (typeof sourceTopicId === 'string' && sourceTopicId.length > 0) {
            try {
              const targets = aggregate.listReferenceTargets(sourceTopicId)
              if (targets.ok === true && targets.value.targetTopicIds.length > 0) {
                broadcastHistoryReferenceInvalidation(sourceTopicId, targets.value.targetTopicIds)
              }
            } catch {
              // best-effort invalidation only
            }
          }
        }

        // Chat-projection hint for local commits — post-commit only, never on
        // failure/rollback. Hints resolve from the committed request intent
        // (stable topic/assistant/branch IDs); the renderer consumes the FULL
        // directory via the read-only API, never this hint as data.
        if (result.ok === true && CHAT_PROJECTION_LOCAL_CHANNELS.has(channel)) {
          try {
            const topicIds = topicIdsFromRequest(request)
            const assistantIds = assistantIdsFromRequest(request)
            const branchIds = branchIdsFromRequest(request)
            // Resolve owning assistants from committed authority when the
            // request carries only topic IDs (never guessed, best-effort).
            if (assistantIds.length === 0 && topicIds.length > 0) {
              try {
                for (const tid of topicIds) {
                  const aid = aggregate.getTopicAssistantId(tid)
                  if (aid && !assistantIds.includes(aid)) assistantIds.push(aid)
                }
              } catch {
                // best-effort; hint still carries topic IDs
              }
            }
            if (assistantIds.length > 0 || topicIds.length > 0) {
              // Origin exclusion: the committing renderer already observes its
              // own write via the Redux projection; only other windows need
              // the hint. Remote/secondary windows keep existing behavior.
              const senderId = typeof _event.sender?.id === 'number' ? _event.sender.id : undefined
              broadcastChatProjectionInvalidation(
                {
                  assistantIds,
                  topicIds,
                  branchIds,
                  reason: 'local-commit'
                },
                senderId === undefined ? undefined : { excludeWebContentsId: senderId }
              )
            }
          } catch {
            // hint broadcast never breaks the ChatDb result envelope
          }
        }

        // Sync outbox — capture failure is surfaced durably via syncState, never affects ChatDb result envelope.
        // Tx-owned channels already committed their intent atomically inside
        // the aggregate transaction: invoking the post-commit hook would
        // enqueue a duplicate op, so it is skipped here by channel.
        // Noncapturable channels (pure reads + explicitly unsupported
        // compound mutations, per the hook's shared classifier) never capture
        // and skip the hook entirely, so a held publish barrier cannot turn a
        // read into a durable capture failure.
        if (result.ok === true && !TX_OWNED_SYNC_CHANNELS.has(channel) && isCapturableSyncChannel(channel)) {
          try {
            handleChatDbSuccessForSync(channel, request, result)
          } catch (e) {
            // hook already records capture failure durably; never break IPC result
            logger.warn(`[ChatDbIpc] sync hook exception for ${channel}: ${(e as Error).message}`)
          }
        }

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
    return agg.fetchMessages(req.topicId, req.branchId)
  })

  // 1b. fetch-messages-window (S6.1 R-02/R-03 typed window)
  handleCommand(IpcChannel.ChatDb_FetchMessagesWindow, (agg, req: FetchMessagesWindowRequest) => {
    return agg.fetchMessagesWindow(req)
  })

  // 1c. fetch-answer-group (S6.2b R-05 authoritative answer-group READ)
  handleCommand(IpcChannel.ChatDb_FetchAnswerGroup, (agg, req: FetchAnswerGroupRequest) => {
    return agg.fetchAnswerGroup(req)
  })

  // 1d. fetch-context-closure (S6.3 R-06 authoritative context closure READ)
  handleCommand(IpcChannel.ChatDb_FetchContextClosure, (agg, req: FetchContextClosureRequest) => {
    return agg.fetchContextClosure(req)
  })

  // 1d2. resolve-context-closure (authority resolver; additive, preserves fetch-context-closure)
  handleCommand(IpcChannel.ChatDb_ResolveContextClosure, (agg, req: ResolveContextClosureRequest) => {
    return agg.resolveContextClosure(req)
  })

  // 1e. fetch-whole-topic-snapshot (one-shot whole-topic snapshot for exports/knowledge)
  handleCommand(IpcChannel.ChatDb_FetchWholeTopicSnapshot, (agg, req: FetchWholeTopicSnapshotRequest) => {
    return agg.fetchWholeTopicSnapshot(req)
  })

  // 1e3. export-topic-data (standalone JSON export: ONE ENTIRE topic incl. all branches)
  handleCommand(IpcChannel.ChatDb_ExportTopicData, (agg, req: ExportTopicDataRequest) => {
    return agg.exportTopicData(req)
  })

  // 1e4. import-topic-data (standalone JSON import: new topic under the target assistant)
  handleCommand(IpcChannel.ChatDb_ImportTopicData, (agg, req: ImportTopicDataRequest) => {
    return agg.importTopicData(req)
  })

  // 1e2. fetch-clipboard-groups (group-scoped copy/cut; selected groups only, never whole-topic)
  handleCommand(IpcChannel.ChatDb_FetchClipboardGroups, (agg, req: FetchClipboardGroupsRequest) => {
    return agg.fetchClipboardGroups(req)
  })

  // 1f. fetch-topic-naming-context (bounded naming authority; never whole-topic)
  handleCommand(IpcChannel.ChatDb_FetchTopicNamingContext, (agg, req: FetchTopicNamingContextRequest) => {
    return agg.fetchTopicNamingContext(req)
  })

  // 1g. fetch-topic-activity (bounded rate-limit authority; no messages/blocks)
  handleCommand(IpcChannel.ChatDb_FetchTopicActivity, (agg, req: FetchTopicActivityRequest) => {
    return agg.fetchTopicActivity(req)
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
    return agg.appendMessage(req.topicId, req.message, req.blocks, req.insertIndex, req.diagnostics, {
      resendAttemptId: req.resendAttemptId,
      branchId: req.branchId
    })
  })

  // 6. update-message (optional conditional usage mode threaded through)
  handleCommand(IpcChannel.ChatDb_UpdateMessage, (agg, req: UpdateMessageRequest) => {
    return agg.updateMessage(req.topicId, req.messageId, req.updates, {
      resendAttemptId: req.resendAttemptId,
      branchId: req.branchId,
      usageCondition: req.usageCondition
    })
  })

  // 7. update-message-and-blocks
  handleCommand(IpcChannel.ChatDb_UpdateMessageAndBlocks, (agg, req: UpdateMessageAndBlocksRequest) => {
    return agg.updateMessageAndBlocks(req.topicId, req.messageUpdates, req.blocksToUpdate, req.blockIdsToDelete, {
      resendAttemptId: req.resendAttemptId,
      branchId: req.branchId
    })
  })

  // 7b. select-answer-message: cross-process authority selection — Main
  // resolves the complete answer group from the selected ID and persists
  // exactly one foldSelected=true in one Main transaction.
  handleCommand(IpcChannel.ChatDb_SelectAnswerMessage, (agg, req: SelectAnswerMessageRequest) => {
    return agg.selectAnswerMessage(req.topicId, req.selectedMessageId, req.branchId)
  })

  // 7c. select-useful-answer (BRANCH-12): group-level atomic useful toggle —
  // Main resolves the complete answer group (including window-outside
  // members) from the toggled ID and persists exactly one useful=true (or
  // a full clear when the target is already useful) in one transaction.
  handleCommand(IpcChannel.ChatDb_SelectUsefulAnswer, (agg, req: SelectUsefulAnswerRequest) => {
    return agg.selectUsefulAnswer(req.topicId, req.messageId, req.branchId)
  })

  // 8. delete-message
  handleCommand(IpcChannel.ChatDb_DeleteMessage, (agg, req: DeleteMessageRequest) => {
    return agg.deleteMessage(req.topicId, req.messageId, req.branchId)
  })

  // 9. delete-messages
  handleCommand(IpcChannel.ChatDb_DeleteMessages, (agg, req: DeleteMessagesRequest) => {
    return agg.deleteMessages(req.topicId, req.messageIds, req.branchId)
  })

  // 10. update-blocks
  handleCommand(IpcChannel.ChatDb_UpdateBlocks, (agg, req: UpdateBlocksRequest) => {
    return agg.updateBlocks(req.blocks, req.diagnostics, {
      resendAttemptId: req.resendAttemptId,
      topicId: req.topicId,
      branchId: req.branchId
    })
  })

  // 11. update-single-block
  handleCommand(IpcChannel.ChatDb_UpdateSingleBlock, (agg, req: UpdateSingleBlockRequest) => {
    return agg.updateSingleBlock(req.blockId, req.updates, req.diagnostics, {
      resendAttemptId: req.resendAttemptId,
      topicId: req.topicId,
      branchId: req.branchId
    })
  })

  // 12. bulk-add-blocks
  handleCommand(IpcChannel.ChatDb_BulkAddBlocks, (agg, req: BulkAddBlocksRequest) => {
    return agg.bulkAddBlocks(req.blocks, {
      resendAttemptId: req.resendAttemptId,
      topicId: req.topicId,
      branchId: req.branchId
    })
  })

  // 13. delete-blocks
  handleCommand(IpcChannel.ChatDb_DeleteBlocks, (agg, req: DeleteBlocksRequest) => {
    return agg.deleteBlocks(req.blockIds, { topicId: req.topicId, branchId: req.branchId })
  })

  // 14. list-segments (Phase 5.1A)
  handleCommand(IpcChannel.ChatDb_ListSegments, (agg, req: ListSegmentsRequest) => {
    return agg.listSegments(req.topicId)
  })

  // 15. upsert-segment (Phase 5.1A)
  handleCommand(IpcChannel.ChatDb_UpsertSegment, (agg, req: UpsertSegmentRequest) => {
    return agg.upsertSegment(req.segmentId, req.topicId, req.name, req.messageIds, req.color, req.branchId)
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
    return agg.replaceSegmentMembership(req.segmentId, req.messageIds, req.branchId)
  })

  // 19. reorder-messages (Phase 5.1A)
  handleCommand(IpcChannel.ChatDb_ReorderMessages, (agg, req: ReorderMessagesRequest) => {
    return agg.reorderMessages(req.topicId, req.messageIds, req.branchId)
  })

  // 19b. reorder-answer-group (additive semantic command, keeps reorder-messages intact)
  handleCommand(IpcChannel.ChatDb_ReorderAnswerGroup, (agg, req: ReorderAnswerGroupRequest) => {
    return agg.reorderAnswerGroup(req.topicId, req.anchorMessageId, req.orderedMessageIds, req.branchId)
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
    return agg.updateTopicMetadata(
      req.topicId,
      req.name,
      req.pinned,
      req.prompt,
      req.isNameManuallyEdited,
      req.expectedName,
      req.expectedIsNameManuallyEdited
    )
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

  // 29b. branch-messages-to-topic (S6.2c-1): stable anchor, atomic prefix clone
  handleCommand(IpcChannel.ChatDb_BranchMessagesToTopic, (agg, req: BranchMessagesToTopicRequest) => {
    return agg.branchMessagesToTopic(
      req.sourceTopicId,
      req.targetTopicId,
      req.anchorMessageId,
      req.assistantId,
      req.branchId
    )
  })

  // 29c. topic-internal branches (016): local-only, no prefix cloning
  handleCommand(IpcChannel.ChatDb_CreateBranch, (agg, req: CreateBranchRequest) => {
    return agg.createBranch(req.topicId, req.parentBranchId, req.anchorMessageId, req.name)
  })

  handleCommand(IpcChannel.ChatDb_ListBranches, (agg, req: ListBranchesRequest) => {
    return agg.listBranches(req.topicId)
  })

  handleCommand(IpcChannel.ChatDb_RenameBranch, (agg, req: RenameBranchRequest) => {
    return agg.renameBranch(req.topicId, req.branchId, req.name)
  })

  handleCommand(IpcChannel.ChatDb_DeleteBranch, (agg, req: DeleteBranchRequest) => {
    return agg.deleteBranch(req.topicId, req.branchId)
  })

  handleCommand(IpcChannel.ChatDb_MoveSelectedTurnsToNewBranch, (agg, req: MoveSelectedTurnsToNewBranchRequest) => {
    return agg.moveSelectedTurnsToNewBranch(
      req.topicId,
      req.sourceBranchId,
      req.selectedGroupIds,
      req.name,
      req.expectedSelectedMessageIds,
      req.contextAnchorInheritance
    )
  })

  // 29d. cross-topic history references (Reference/Copy = Reference): atomic
  // topic + relation creation; local-only live foreign prefix, no duplication.
  handleCommand(IpcChannel.ChatDb_CreateReferencedTopic, (agg, req: CreateReferencedTopicRequest) => {
    return agg.createReferencedTopic(
      req.sourceTopicId,
      req.branchId,
      req.targetTopicId,
      req.anchorMessageId,
      req.assistantId,
      req.name
    )
  })

  // 29. clone-messages-to-topic (Phase 5.1B)
  handleCommand(IpcChannel.ChatDb_CloneMessagesToTopic, (agg, req: CloneMessagesToTopicRequest) => {
    return agg.cloneMessagesToTopic(req.targetTopicId, req.entries, req.assistantId, req.branchId)
  })

  // 30. reset-messages-for-resend (Phase 5.1B)
  handleCommand(IpcChannel.ChatDb_ResetMessagesForResend, (agg, req: ResetMessagesForResendRequest) => {
    return agg.resetMessagesForResend(req.topicId, req.messages, req.blockIdsToDelete, req.branchId)
  })

  // 30b. resend-user-messages: semantic resend by stable user ID (authority group resolve)
  handleCommand(IpcChannel.ChatDb_ResendUserMessages, (agg, req: ResendUserMessagesRequest) => {
    return agg.resendUserMessages(req.topicId, req.userMessageId, req.assistantId, req.currentModel, req.branchId)
  })

  // 30c. regenerate-assistant-message: semantic regenerate by stable assistant ID
  handleCommand(IpcChannel.ChatDb_RegenerateAssistantMessage, (agg, req: RegenerateAssistantMessageRequest) => {
    return agg.regenerateAssistantMessage(
      req.topicId,
      req.assistantMessageId,
      req.assistantId,
      req.currentModel,
      req.branchId
    )
  })

  // 31. delete-messages-with-segments (Phase 5.1B)
  handleCommand(IpcChannel.ChatDb_DeleteMessagesWithSegments, (agg, req: DeleteMessagesWithSegmentsRequest) => {
    return agg.deleteMessagesWithSegments(req.topicId, req.messageIds, req.branchId)
  })

  // 31b. delete-messages-with-dependents: semantic plural delete with Main-resolved cascade + authority undo snapshot
  handleCommand(IpcChannel.ChatDb_DeleteMessagesWithDependents, (agg, req: DeleteMessagesWithDependentsRequest) => {
    return agg.deleteMessagesWithDependents(req.topicId, req.messageIds, req.branchId)
  })

  // 32. paste-messages-to-topic (Phase 5.1B)
  handleCommand(IpcChannel.ChatDb_PasteMessagesToTopic, (agg, req: PasteMessagesToTopicRequest) => {
    return agg.pasteMessagesToTopic(req.topicId, req.entries, req.insertIndex, req.branchId)
  })

  // 32b. insert-messages-after-anchor (S6.2c-2): stable anchor, atomic insert
  handleCommand(IpcChannel.ChatDb_InsertMessagesAfterAnchor, (agg, req: InsertMessagesAfterAnchorRequest) => {
    return agg.insertMessagesAfterAnchor(req.topicId, req.afterMessageId, req.entries, req.branchId)
  })

  // 32c. insert-message-groups: stable intents, atomic multi-group insert
  handleCommand(IpcChannel.ChatDb_InsertMessageGroups, (agg, req: InsertMessageGroupsRequest) => {
    return agg.insertMessageGroups(req.topicId, req.groups as any, req.branchId)
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

  handleCommand(IpcChannel.ChatDb_EnsureAssistantTopics, (agg, req: EnsureAssistantTopicsRequest) => {
    return agg.ensureAssistantTopics(req.assistantId, req.candidateTopicId, req.candidateName ?? null)
  })

  handleCommand(IpcChannel.ChatDb_ListLiveAssistantTopics, (agg, req: ListLiveAssistantTopicsRequest) => {
    return agg.listLiveAssistantTopics(req.assistantId)
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
