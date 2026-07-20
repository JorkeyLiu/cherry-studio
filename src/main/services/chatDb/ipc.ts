/**
 * ChatDb IPC handler registration.
 *
 * Registers exactly 14 fixed IPC handlers matching the ChatDb IpcChannel entries.
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
 * - Exactly 14 channels; no execute/query/repository CRUD.
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
  ClearMessagesRequest,
  DeleteBlocksRequest,
  DeleteMessageRequest,
  DeleteMessagesRequest,
  EnsureTopicRequest,
  FetchMessagesRequest,
  GetRawTopicRequest,
  TopicExistsRequest,
  UpdateBlocksRequest,
  UpdateMessageAndBlocksRequest,
  UpdateMessageRequest,
  UpdateSingleBlockRequest
} from '@shared/chatDb'
import { ERR_VALIDATION, fail, validateChatDbRequest, validateChatDbResult } from '@shared/chatDb'
import { IpcChannel } from '@shared/IpcChannel'
import { ipcMain } from 'electron'

import { ChatDbAggregateService } from './ChatDbAggregateService'
import { internalStorageFailure, mapErrorToResult, validateConstructedResult } from './errors'
import { chatDbService } from './index'

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
 * Register all 14 ChatDb IPC handlers.
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
    return new ChatDbAggregateService(chatDbService.getDatabase())
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
    // All 14 ChatDb channels are valid ChatDbChannel values.
    // Cast once for shared validator calls.
    const chatDbChannel = channel as ChatDbChannel

    const handler = async (_event: Electron.IpcMainInvokeEvent, request: unknown): Promise<ChatDbResult<any>> => {
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
    }

    ipcMain.handle(channel, handler)
    handlers.push({ channel, handler })
  }

  // -------------------------------------------------------------------------
  // Register exactly 14 handlers
  // -------------------------------------------------------------------------

  // 1. fetch-messages
  handleCommand(IpcChannel.ChatDb_FetchMessages, (agg, req: FetchMessagesRequest) => {
    return agg.fetchMessages(req.topicId)
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
    return agg.ensureTopic(req.topicId, req.assistantId)
  })

  // 5. append-message
  handleCommand(IpcChannel.ChatDb_AppendMessage, (agg, req: AppendMessageRequest) => {
    return agg.appendMessage(req.topicId, req.message, req.blocks, req.insertIndex)
  })

  // 6. update-message
  handleCommand(IpcChannel.ChatDb_UpdateMessage, (agg, req: UpdateMessageRequest) => {
    return agg.updateMessage(req.topicId, req.messageId, req.updates)
  })

  // 7. update-message-and-blocks
  handleCommand(IpcChannel.ChatDb_UpdateMessageAndBlocks, (agg, req: UpdateMessageAndBlocksRequest) => {
    return agg.updateMessageAndBlocks(req.topicId, req.messageUpdates, req.blocksToUpdate)
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
    return agg.updateBlocks(req.blocks)
  })

  // 11. update-single-block
  handleCommand(IpcChannel.ChatDb_UpdateSingleBlock, (agg, req: UpdateSingleBlockRequest) => {
    return agg.updateSingleBlock(req.blockId, req.updates)
  })

  // 12. bulk-add-blocks
  handleCommand(IpcChannel.ChatDb_BulkAddBlocks, (agg, req: BulkAddBlocksRequest) => {
    return agg.bulkAddBlocks(req.blocks)
  })

  // 13. delete-blocks
  handleCommand(IpcChannel.ChatDb_DeleteBlocks, (agg, req: DeleteBlocksRequest) => {
    return agg.deleteBlocks(req.blockIds)
  })

  // 14. clear-messages
  handleCommand(IpcChannel.ChatDb_ClearMessages, (agg, req: ClearMessagesRequest) => {
    return agg.clearMessages(req.topicId)
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
