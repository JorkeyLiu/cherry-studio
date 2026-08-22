/**
 * SqliteMessageDataSource — SQLite-backed implementation of MessageDataSource.
 *
 * Routes all operations through the preload `window.api.chatDb` bridge
 * to Main-side ChatDbAggregateService via named IPC methods.
 *
 * Design:
 * - Constructor injection of a narrow typed ChatDbApi; the bridge is resolved
 *   lazily at method-call time (injected ?? window.api?.chatDb), never in the
 *   constructor, so isolated renderer contexts without window.api stay safe.
 * - Each method calls exactly one named bridge method and unwraps ChatDbResult.
 * - Structured failure throws ChatDbResultError; transport rejection propagates unchanged.
 * - No retry, no fallback, no second method calls.
 * - updateFileCount(s) are intentionally omitted (stays Dexie/FileManager).
 * - updateTopicUpdatedAt dispatch parity after successful message/topic mutations.
 * - Renderer→wire JSON boundary: cloneForWire recursively clones, strips undefined,
 *   validates JSON safety, rejects unsupported types.
 */

import { currentPhaseCorrelation, recordPhaseDurationForCorrelation } from '@renderer/services/phaseTimingDiagnostics'
import store from '@renderer/store'
import { updateTopicUpdatedAt } from '@renderer/store/assistants'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { cloneForWire } from '@renderer/utils/jsonWire'
import type {
  AppendMessageRequest,
  BulkAddBlocksRequest,
  ChatDbError,
  ChatDbResult,
  CloneMessagesToTopicRequest,
  CloneMessagesToTopicResponse,
  CountFileRefsByFileRequest,
  CountFileRefsByFileResponse,
  DeleteBlocksRequest,
  DeleteBlocksResponse,
  DeleteMessageRequest,
  DeleteMessagesRequest,
  DeleteMessagesWithSegmentsRequest,
  DeleteMessagesWithSegmentsResponse,
  DeleteSegmentRequest,
  EmptyTrashTopicsRequest,
  EmptyTrashTopicsResponse,
  EnsureTopicRequest,
  FetchMessagesRequest,
  FetchMessagesResponse,
  FetchMessagesWindowRequest,
  FetchMessagesWindowResponse,
  FileCleanupResult,
  GetRawTopicRequest,
  GetRawTopicResponse,
  HardDeleteTopicRequest,
  HardDeleteTopicResponse,
  JsonObject,
  ListBlocksByFileRequest,
  ListBlocksByFileResponse,
  ListFileRefsByFileRequest,
  ListFileRefsByFileResponse,
  ListSegmentsRequest,
  ListSegmentsResponse,
  ListTrashTopicsRequest,
  ListTrashTopicsResponse,
  MessageBlockEntry,
  PasteMessagesToTopicRequest,
  PasteMessagesToTopicResponse,
  PurgeExpiredTopicsRequest,
  PurgeExpiredTopicsResponse,
  ReorderMessagesRequest,
  ReplaceSegmentMembershipRequest,
  ReplaceSegmentMembershipResponse,
  ResetAssistantTopicsResponse,
  ResetMessagesForResendRequest,
  ResetMessagesForResendResponse,
  RestoreTopicRequest,
  RestoreTopicResponse,
  SearchMessagesRequest,
  SearchMessagesResponse,
  SelectAnswerMessageRequest,
  SoftDeleteTopicRequest,
  StreamWriteDiagnostics,
  TopicExistsRequest,
  TopicWire,
  UpdateBlocksRequest,
  UpdateMessageAndBlocksRequest,
  UpdateMessageRequest,
  UpdateSegmentMetadataRequest,
  UpdateSegmentMetadataResponse,
  UpdateSingleBlockRequest,
  UpdateTopicMetadataRequest,
  UpdateTopicMetadataResponse,
  UpsertSegmentRequest,
  UpsertSegmentResponse
} from '@shared/chatDb'
import { elapsedMs } from '@shared/diagnostics/sendTiming'

import { consumeNextAppendDiagnostics, logAppendDiagnostic, type SendDiagnosticsContext } from './sendTimingDiagnostics'
import { recordStreamAttrRendererRecord, resolveStreamWriteDiagnostics } from './streamTimingDiagnostics'
import type { MessageDataSource } from './types'

// ---------------------------------------------------------------------------
// ChatDbApi — narrow typed interface for the preload bridge
//
// Matches window.api.chatDb shape. Used for constructor injection
// to avoid importing preload implementation (layering).
// ---------------------------------------------------------------------------

export interface ChatDbApi {
  fetchMessages(request: FetchMessagesRequest): Promise<ChatDbResult<FetchMessagesResponse>>
  fetchMessagesWindow?(request: FetchMessagesWindowRequest): Promise<ChatDbResult<FetchMessagesWindowResponse>>
  getRawTopic(request: GetRawTopicRequest): Promise<ChatDbResult<GetRawTopicResponse>>
  topicExists(request: TopicExistsRequest): Promise<ChatDbResult<boolean>>
  ensureTopic(request: EnsureTopicRequest): Promise<ChatDbResult<null>>
  appendMessage(request: AppendMessageRequest): Promise<ChatDbResult<null>>
  updateMessage(request: UpdateMessageRequest): Promise<ChatDbResult<null>>
  updateMessageAndBlocks(request: UpdateMessageAndBlocksRequest): Promise<ChatDbResult<FileCleanupResult>>
  // PERF-100: one atomic multi-model answer-tab selection
  selectAnswerMessage(request: SelectAnswerMessageRequest): Promise<ChatDbResult<null>>
  deleteMessage(request: DeleteMessageRequest): Promise<ChatDbResult<null>>
  deleteMessages(request: DeleteMessagesRequest): Promise<ChatDbResult<null>>
  updateBlocks(request: UpdateBlocksRequest): Promise<ChatDbResult<null>>
  updateSingleBlock(request: UpdateSingleBlockRequest): Promise<ChatDbResult<null>>
  bulkAddBlocks(request: BulkAddBlocksRequest): Promise<ChatDbResult<null>>
  deleteBlocks(request: DeleteBlocksRequest): Promise<ChatDbResult<DeleteBlocksResponse>>
  // Phase 5.1A: segment commands
  listSegments(request: ListSegmentsRequest): Promise<ChatDbResult<ListSegmentsResponse>>
  upsertSegment(request: UpsertSegmentRequest): Promise<ChatDbResult<UpsertSegmentResponse>>
  updateSegmentMetadata(request: UpdateSegmentMetadataRequest): Promise<ChatDbResult<UpdateSegmentMetadataResponse>>
  deleteSegment(request: DeleteSegmentRequest): Promise<ChatDbResult<null>>
  replaceSegmentMembership(
    request: ReplaceSegmentMembershipRequest
  ): Promise<ChatDbResult<ReplaceSegmentMembershipResponse>>
  // Phase 5.1A: message reorder
  reorderMessages(request: ReorderMessagesRequest): Promise<ChatDbResult<null>>
  // Phase 5.1A: file reference queries (read-only)
  listFileRefsByFile(request: ListFileRefsByFileRequest): Promise<ChatDbResult<ListFileRefsByFileResponse>>
  countFileRefsByFile(request: CountFileRefsByFileRequest): Promise<ChatDbResult<CountFileRefsByFileResponse>>
  listBlocksByFile(request: ListBlocksByFileRequest): Promise<ChatDbResult<ListBlocksByFileResponse>>
  // Phase 5.1B: topic lifecycle
  updateTopicMetadata(request: UpdateTopicMetadataRequest): Promise<ChatDbResult<UpdateTopicMetadataResponse>>
  softDeleteTopic(request: SoftDeleteTopicRequest): Promise<ChatDbResult<null>>
  restoreTopic(request: RestoreTopicRequest): Promise<ChatDbResult<RestoreTopicResponse>>
  listTrashTopics(request: ListTrashTopicsRequest): Promise<ChatDbResult<ListTrashTopicsResponse>>
  hardDeleteTopic(request: HardDeleteTopicRequest): Promise<ChatDbResult<HardDeleteTopicResponse>>
  purgeExpiredTopics(request: PurgeExpiredTopicsRequest): Promise<ChatDbResult<PurgeExpiredTopicsResponse>>
  // Phase 5.2B: atomic assistant empty-trash (LOCK-531)
  emptyTrashTopics(request: EmptyTrashTopicsRequest): Promise<ChatDbResult<EmptyTrashTopicsResponse>>
  transferTopicOwnership?(request: { topicId: string; assistantId: string }): Promise<ChatDbResult<null>>
  resetAssistantTopics?(request: {
    assistantId: string
    replacementTopicId: string
  }): Promise<ChatDbResult<ResetAssistantTopicsResponse>>
  // Phase 5.1B: compound mutations
  cloneMessagesToTopic(request: CloneMessagesToTopicRequest): Promise<ChatDbResult<CloneMessagesToTopicResponse>>
  resetMessagesForResend(request: ResetMessagesForResendRequest): Promise<ChatDbResult<ResetMessagesForResendResponse>>
  deleteMessagesWithSegments(
    request: DeleteMessagesWithSegmentsRequest
  ): Promise<ChatDbResult<DeleteMessagesWithSegmentsResponse>>
  pasteMessagesToTopic(request: PasteMessagesToTopicRequest): Promise<ChatDbResult<PasteMessagesToTopicResponse>>
  // Phase 5.2A: search (read-only)
  searchMessages(request: SearchMessagesRequest): Promise<ChatDbResult<SearchMessagesResponse>>
}

// ---------------------------------------------------------------------------
// ChatDbResultError — structured failure from ChatDb IPC
// ---------------------------------------------------------------------------

/**
 * Thrown when a ChatDb IPC call returns a structured failure result.
 * Carries the error code, message, retryable flag, and optional details
 * from the Main-side error envelope.
 *
 * Transport rejections (e.g. network/Electron IPC errors) propagate
 * unchanged and are NOT wrapped in this class.
 */
export class ChatDbResultError extends Error {
  /** Machine-readable error code (e.g. 'VALIDATION_ERROR', 'NOT_FOUND'). */
  readonly code: string
  /** If true, the operation may succeed if retried. */
  readonly retryable: boolean
  /** Optional structured details from the Main-side error. */
  readonly details: JsonObject | undefined

  constructor(error: ChatDbError) {
    super(error.message)
    this.name = 'ChatDbResultError'
    this.code = error.code
    this.retryable = error.retryable
    this.details = error.details
  }
}

// ---------------------------------------------------------------------------
// insertIndex sentinel handling
//
// The Renderer uses -1 as a sentinel for "no insert index".
// The wire contract expects: absent field = append at end.
// ---------------------------------------------------------------------------

const INSERT_INDEX_SENTINEL = -1

function sanitizeInsertIndex(index: number | undefined): number | undefined {
  if (index === undefined || index === INSERT_INDEX_SENTINEL) {
    return undefined // omit from request
  }
  if (typeof index === 'number' && Number.isFinite(index) && Number.isInteger(index) && index >= 0) {
    return index
  }
  return undefined
}

// ---------------------------------------------------------------------------
// updateTopicUpdatedAt dispatch
//
// Preserve the existing Redux timestamp behavior after successful
// message/topic mutations only.
// ---------------------------------------------------------------------------

function dispatchTopicUpdatedAt(topicId: string): void {
  store.dispatch(updateTopicUpdatedAt({ topicId }))
}

// ---------------------------------------------------------------------------
// unwrap — check result and throw ChatDbResultError on failure
// ---------------------------------------------------------------------------

function unwrap<T>(result: ChatDbResult<T>): T {
  if (result.ok === true) {
    return result.value
  }
  throw new ChatDbResultError(result.error)
}

// ---------------------------------------------------------------------------
// SqliteMessageDataSource
// ---------------------------------------------------------------------------

/**
 * SQLite-backed MessageDataSource using the ChatDb preload bridge.
 *
 * The ChatDb bridge API is resolved lazily at method-call time: a
 * constructor-injected API is preferred, otherwise `window.api?.chatDb` is
 * read on each call. Construction never touches `window.api`, so isolated
 * renderer contexts (e.g. chatImport) that do not expose the ordinary preload
 * bridge can evaluate this module safely. An actual SQLite method call
 * without any available bridge throws a clear, deterministic error.
 */
export class SqliteMessageDataSource implements MessageDataSource {
  /** Optional injected bridge (tests / non-preload contexts). */
  private readonly injectedApi?: ChatDbApi

  constructor(api?: ChatDbApi) {
    this.injectedApi = api
  }

  /**
   * Resolve the ChatDb bridge API at method-call time.
   *
   * Prefers the constructor-injected API; otherwise falls back to
   * `window.api?.chatDb`. Throws a clear, deterministic error when neither is
   * available — a missing API must fail loudly, never silently no-op.
   */
  private get api(): ChatDbApi {
    const resolved = this.injectedApi ?? (typeof window !== 'undefined' ? (window as any)?.api?.chatDb : undefined)
    if (!resolved) {
      throw new Error('ChatDb API unavailable: window.api.chatDb is not exposed in this window')
    }
    return resolved
  }

  // ============ Read Operations ============

  async fetchMessages(
    topicId: string,
    forceReload?: boolean
  ): Promise<{ messages: Message[]; blocks: MessageBlock[] }> {
    // forceReload is accepted per the MessageDataSource interface but never
    // sent over the wire — SQLite reads are always fresh (no renderer cache).
    void forceReload
    const request: FetchMessagesRequest = cloneForWire({ topicId })
    const result = unwrap(await this.api.fetchMessages(request))
    return {
      messages: result.messages as unknown as Message[],
      blocks: result.blocks as unknown as MessageBlock[]
    }
  }

  async getRawTopic(topicId: string): Promise<{ id: string; messages: Message[] } | undefined> {
    const request: GetRawTopicRequest = cloneForWire({ topicId })
    const result = unwrap(await this.api.getRawTopic(request))
    // Map wire null to renderer undefined
    if (result === null) return undefined
    return {
      id: result.id,
      messages: result.messages as unknown as Message[]
    }
  }

  // ============ Write Operations ============

  async appendMessage(
    topicId: string,
    message: Message,
    blocks: MessageBlock[],
    insertIndex?: number,
    sendContext?: SendDiagnosticsContext
  ): Promise<void> {
    // LOCK-004: when this append belongs to the ordinary send path, consume
    // the ordinal from the CALLER'S OWN send context so renderer + main logs
    // share the correct correlation id even when sends overlap or append
    // callers interleave. Callers without a context (uninstrumented append
    // paths) attach no diagnostics and emit no timing logs.
    const sendDiagnostics = consumeNextAppendDiagnostics(sendContext)
    const correlationId = sendDiagnostics?.correlationId
    const ordinal = sendDiagnostics?.ordinal
    const isDiagnosedAppend = correlationId !== undefined

    const t0 = performance.now()
    const sanitizedIndex = sanitizeInsertIndex(insertIndex)
    const request: AppendMessageRequest = {
      topicId,
      message: cloneForWire(message as unknown as JsonObject),
      blocks: cloneForWire(blocks as unknown as JsonObject[]),
      ...(sanitizedIndex !== undefined && { insertIndex: sanitizedIndex }),
      ...(isDiagnosedAppend && { diagnostics: sendDiagnostics })
    }
    const serializeDurationMs = elapsedMs(t0)
    if (isDiagnosedAppend) {
      logAppendDiagnostic('renderer.append.serialize', serializeDurationMs, {
        correlationId,
        ordinal,
        ok: true,
        messageIdPresent: typeof message?.id === 'string' && message.id.length > 0,
        blockCount: blocks.length
      })
    }

    const tIpc = performance.now()
    let result: ChatDbResult<null>
    try {
      result = await this.api.appendMessage(request)
    } catch (error) {
      // Transport rejection propagates unchanged; timing still recorded.
      if (isDiagnosedAppend) {
        logAppendDiagnostic('renderer.append.ipc', elapsedMs(tIpc), {
          correlationId,
          ordinal,
          ok: false
        })
      }
      throw error
    }
    if (ordinal === 1) {
      const active = currentPhaseCorrelation()
      if (active) {
        recordPhaseDurationForCorrelation(
          active.correlationId,
          active.path,
          'echo.userAppendIpc',
          performance.now() - tIpc
        )
      }
    }
    if (isDiagnosedAppend) {
      logAppendDiagnostic('renderer.append.ipc', elapsedMs(tIpc), {
        correlationId,
        ordinal,
        ok: result.ok === true
      })
    }

    unwrap(result)
    if (isDiagnosedAppend) {
      logAppendDiagnostic('renderer.append.total', elapsedMs(t0), {
        correlationId,
        ordinal,
        ok: true
      })
    }
    dispatchTopicUpdatedAt(topicId)
  }

  async updateMessage(topicId: string, messageId: string, updates: Partial<Message>): Promise<void> {
    const request: UpdateMessageRequest = {
      topicId,
      messageId,
      updates: cloneForWire(updates as unknown as JsonObject)
    }
    unwrap(await this.api.updateMessage(request))
    dispatchTopicUpdatedAt(topicId)
  }

  async updateMessageAndBlocks(
    topicId: string,
    messageUpdates: Partial<Message> & Pick<Message, 'id'>,
    blocksToUpdate: MessageBlock[],
    blockIdsToDelete: string[] = []
  ): Promise<FileCleanupResult> {
    // Clone and strip redundant identity/order fields for Dexie-compatible semantics
    const clonedUpdates = cloneForWire(messageUpdates as unknown as JsonObject) as Record<string, unknown>
    delete clonedUpdates.topicId
    delete clonedUpdates.sortOrder

    const request: UpdateMessageAndBlocksRequest = {
      topicId,
      messageUpdates: clonedUpdates as JsonObject,
      blocksToUpdate: cloneForWire(blocksToUpdate as unknown as JsonObject[]),
      blockIdsToDelete: cloneForWire(blockIdsToDelete)
    }
    const result = unwrap(await this.api.updateMessageAndBlocks(request))
    dispatchTopicUpdatedAt(topicId)
    return result
  }

  /**
   * PERF-100: one atomic multi-model answer-tab selection.
   *
   * ONE named bridge call to the Main `selectAnswerMessage` command (ONE
   * root SQLite transaction validating topic ownership of every supplied ID
   * and persisting exactly one foldSelected=true). Unwraps ChatDbResult,
   * throws ChatDbResultError on structured failure, propagates transport
   * rejection unchanged. No retry, no fallback. Dispatches
   * `updateTopicUpdatedAt` exactly once after success — the calling thunk
   * must NOT dispatch it again for the same logical selection.
   */
  async selectAnswerMessage(topicId: string, selectedMessageId: string, messageIds: string[]): Promise<void> {
    const request: SelectAnswerMessageRequest = cloneForWire({ topicId, selectedMessageId, messageIds })
    unwrap(await this.api.selectAnswerMessage(request))
    dispatchTopicUpdatedAt(topicId)
  }

  async deleteMessage(topicId: string, messageId: string): Promise<void> {
    const request: DeleteMessageRequest = cloneForWire({ topicId, messageId })
    unwrap(await this.api.deleteMessage(request))
    dispatchTopicUpdatedAt(topicId)
  }

  async deleteMessages(topicId: string, messageIds: string[]): Promise<void> {
    const request: DeleteMessagesRequest = cloneForWire({ topicId, messageIds })
    unwrap(await this.api.deleteMessages(request))
    dispatchTopicUpdatedAt(topicId)
  }

  // ============ Block Operations ============

  async updateBlocks(blocks: MessageBlock[], streamDiag?: StreamWriteDiagnostics): Promise<void> {
    // PERF-STREAM-ATTR-001: resolve the per-call correlation context (explicit
    // context wins; otherwise auto-created when the renderer switch is on;
    // otherwise undefined — inert). Never affects persistence semantics.
    const ctx = resolveStreamWriteDiagnostics(streamDiag)
    const channel = 'chatdb:update-blocks'
    const t0 = performance.now()
    const tSerialize = performance.now()
    const request: UpdateBlocksRequest = {
      blocks: cloneForWire(blocks as unknown as JsonObject[]),
      ...(ctx && { diagnostics: ctx })
    }
    const blockCount = request.blocks.length
    const serializeDurationMs = elapsedMs(tSerialize)
    const tIpc = performance.now()
    let result: ChatDbResult<null>
    try {
      result = await this.api.updateBlocks(request)
    } catch (error) {
      // Transport rejection: timing still recorded, then rethrown unchanged.
      if (ctx) {
        recordStreamAttrRendererRecord({
          channel,
          stage: 'renderer.serialize',
          correlationId: ctx.correlationId,
          ordinal: ctx.ordinal,
          durationMs: serializeDurationMs,
          ok: false,
          blockCount
        })
        recordStreamAttrRendererRecord({
          channel,
          stage: 'renderer.ipc',
          correlationId: ctx.correlationId,
          ordinal: ctx.ordinal,
          durationMs: elapsedMs(tIpc),
          ok: false,
          blockCount
        })
        recordStreamAttrRendererRecord({
          channel,
          stage: 'renderer.total',
          correlationId: ctx.correlationId,
          ordinal: ctx.ordinal,
          durationMs: elapsedMs(t0),
          ok: false,
          blockCount
        })
      }
      throw error
    }
    if (ctx) {
      recordStreamAttrRendererRecord({
        channel,
        stage: 'renderer.serialize',
        correlationId: ctx.correlationId,
        ordinal: ctx.ordinal,
        durationMs: serializeDurationMs,
        ok: result.ok === true,
        blockCount
      })
      recordStreamAttrRendererRecord({
        channel,
        stage: 'renderer.ipc',
        correlationId: ctx.correlationId,
        ordinal: ctx.ordinal,
        durationMs: elapsedMs(tIpc),
        ok: result.ok === true,
        blockCount
      })
      recordStreamAttrRendererRecord({
        channel,
        stage: 'renderer.total',
        correlationId: ctx.correlationId,
        ordinal: ctx.ordinal,
        durationMs: elapsedMs(t0),
        ok: result.ok === true,
        blockCount
      })
    }
    unwrap(result)
    // No topicUpdatedAt dispatch — block-only operation
  }

  async updateSingleBlock(
    blockId: string,
    updates: Partial<MessageBlock>,
    streamDiag?: StreamWriteDiagnostics
  ): Promise<void> {
    const ctx = resolveStreamWriteDiagnostics(streamDiag)
    const channel = 'chatdb:update-single-block'
    const t0 = performance.now()
    const tSerialize = performance.now()
    const request: UpdateSingleBlockRequest = {
      blockId,
      updates: cloneForWire(updates as unknown as JsonObject),
      ...(ctx && { diagnostics: ctx })
    }
    const serializeDurationMs = elapsedMs(tSerialize)
    const tIpc = performance.now()
    let result: ChatDbResult<null>
    try {
      result = await this.api.updateSingleBlock(request)
    } catch (error) {
      if (ctx) {
        recordStreamAttrRendererRecord({
          channel,
          stage: 'renderer.serialize',
          correlationId: ctx.correlationId,
          ordinal: ctx.ordinal,
          durationMs: serializeDurationMs,
          ok: false
        })
        recordStreamAttrRendererRecord({
          channel,
          stage: 'renderer.ipc',
          correlationId: ctx.correlationId,
          ordinal: ctx.ordinal,
          durationMs: elapsedMs(tIpc),
          ok: false
        })
        recordStreamAttrRendererRecord({
          channel,
          stage: 'renderer.total',
          correlationId: ctx.correlationId,
          ordinal: ctx.ordinal,
          durationMs: elapsedMs(t0),
          ok: false
        })
      }
      throw error
    }
    if (ctx) {
      recordStreamAttrRendererRecord({
        channel,
        stage: 'renderer.serialize',
        correlationId: ctx.correlationId,
        ordinal: ctx.ordinal,
        durationMs: serializeDurationMs,
        ok: result.ok === true
      })
      recordStreamAttrRendererRecord({
        channel,
        stage: 'renderer.ipc',
        correlationId: ctx.correlationId,
        ordinal: ctx.ordinal,
        durationMs: elapsedMs(tIpc),
        ok: result.ok === true
      })
      recordStreamAttrRendererRecord({
        channel,
        stage: 'renderer.total',
        correlationId: ctx.correlationId,
        ordinal: ctx.ordinal,
        durationMs: elapsedMs(t0),
        ok: result.ok === true
      })
    }
    unwrap(result)
    // No topicUpdatedAt dispatch — block-only operation
  }

  async bulkAddBlocks(blocks: MessageBlock[]): Promise<void> {
    const request: BulkAddBlocksRequest = {
      blocks: cloneForWire(blocks as unknown as JsonObject[])
    }
    unwrap(await this.api.bulkAddBlocks(request))
    // No topicUpdatedAt dispatch — block-only operation
  }

  async deleteBlocks(blockIds: string[]): Promise<FileCleanupResult> {
    const request: DeleteBlocksRequest = cloneForWire({ blockIds })
    return unwrap(await this.api.deleteBlocks(request))
    // No topicUpdatedAt dispatch — block-only operation
  }

  // ============ Batch Operations ============

  async topicExists(topicId: string): Promise<boolean> {
    const request: TopicExistsRequest = cloneForWire({ topicId })
    return unwrap(await this.api.topicExists(request))
  }

  async ensureTopic(topicId: string, assistantId?: string, name?: string | null): Promise<void> {
    // LOCK-533: creation paths pass assistantId so ordinary topics exist in
    // SQLite with their assistant ownership before Redux exposure. ensure is
    // create-only on Main: an existing topic's binding is never overwritten.
    const request: EnsureTopicRequest = cloneForWire({ topicId, assistantId, name })
    unwrap(await this.api.ensureTopic(request))
    // No topicUpdatedAt dispatch — create-only, doesn't update existing
  }

  // ============ Segment Operations (Phase 5.1A) ============

  async listSegments(topicId: string): Promise<ListSegmentsResponse> {
    const request: ListSegmentsRequest = cloneForWire({ topicId })
    return unwrap(await this.api.listSegments(request))
  }

  async upsertSegment(
    segmentId: string,
    topicId: string,
    name: string | null | undefined,
    messageIds: string[],
    color?: string | null
  ): Promise<UpsertSegmentResponse> {
    const request: UpsertSegmentRequest = cloneForWire({ segmentId, topicId, name, messageIds, color })
    return unwrap(await this.api.upsertSegment(request))
  }

  async updateSegmentMetadata(
    segmentId: string,
    name: string | null | undefined,
    color?: string | null
  ): Promise<UpdateSegmentMetadataResponse> {
    const request: UpdateSegmentMetadataRequest = cloneForWire({ segmentId, name, color })
    return unwrap(await this.api.updateSegmentMetadata(request))
  }

  async deleteSegment(segmentId: string): Promise<void> {
    const request: DeleteSegmentRequest = cloneForWire({ segmentId })
    unwrap(await this.api.deleteSegment(request))
  }

  async replaceSegmentMembership(segmentId: string, messageIds: string[]): Promise<ReplaceSegmentMembershipResponse> {
    const request: ReplaceSegmentMembershipRequest = cloneForWire({ segmentId, messageIds })
    return unwrap(await this.api.replaceSegmentMembership(request))
  }

  // ============ Message Reorder (Phase 5.1A) ============

  async reorderMessages(topicId: string, messageIds: string[]): Promise<void> {
    const request: ReorderMessagesRequest = cloneForWire({ topicId, messageIds })
    unwrap(await this.api.reorderMessages(request))
  }

  // ============ File Reference Queries (Phase 5.1A, read-only) ============

  async listFileRefsByFile(fileId: string): Promise<ListFileRefsByFileResponse> {
    const request: ListFileRefsByFileRequest = cloneForWire({ fileId })
    return unwrap(await this.api.listFileRefsByFile(request))
  }

  async countFileRefsByFile(fileId: string): Promise<number> {
    const request: CountFileRefsByFileRequest = cloneForWire({ fileId })
    return unwrap(await this.api.countFileRefsByFile(request))
  }

  async listBlocksByFile(fileId: string): Promise<ListBlocksByFileResponse> {
    const request: ListBlocksByFileRequest = cloneForWire({ fileId })
    return unwrap(await this.api.listBlocksByFile(request))
  }

  // ============ Topic Lifecycle (Phase 5.1B) ============

  async updateTopicMetadata(
    topicId: string,
    name?: string | null,
    pinned?: boolean | null,
    prompt?: string | null,
    isNameManuallyEdited?: boolean | null
  ): Promise<TopicWire> {
    const request: UpdateTopicMetadataRequest = cloneForWire({ topicId, name, pinned, prompt, isNameManuallyEdited })
    return unwrap(await this.api.updateTopicMetadata(request))
  }

  async softDeleteTopic(topicId: string, name?: string | null): Promise<void> {
    const request: SoftDeleteTopicRequest = cloneForWire({ topicId, name })
    unwrap(await this.api.softDeleteTopic(request))
    dispatchTopicUpdatedAt(topicId)
  }

  async restoreTopic(topicId: string): Promise<RestoreTopicResponse> {
    // LOCK-532: one Main command that atomically restores and returns the
    // restored TopicWire, or null when no soft-deleted row was restored.
    const request: RestoreTopicRequest = cloneForWire({ topicId })
    const restored = unwrap(await this.api.restoreTopic(request))
    if (restored !== null) {
      dispatchTopicUpdatedAt(topicId)
    }
    return restored
  }

  async listTrashTopics(assistantId?: string, limit?: number, cursor?: string): Promise<ListTrashTopicsResponse> {
    const request: ListTrashTopicsRequest = cloneForWire({ assistantId, limit, cursor })
    return unwrap(await this.api.listTrashTopics(request))
  }

  async hardDeleteTopic(topicId: string): Promise<FileCleanupResult> {
    const request: HardDeleteTopicRequest = cloneForWire({ topicId })
    const result = unwrap(await this.api.hardDeleteTopic(request))
    dispatchTopicUpdatedAt(topicId)
    return result
  }

  async purgeExpiredTopics(cutoffTimestamp: string): Promise<FileCleanupResult> {
    const request: PurgeExpiredTopicsRequest = cloneForWire({ cutoffTimestamp })
    return unwrap(await this.api.purgeExpiredTopics(request))
  }

  /**
   * Empty an assistant's trash in ONE atomic Main transaction (LOCK-531).
   * Returns the single aggregate FileCleanupResult of the transaction.
   */
  async emptyTrashTopics(assistantId: string): Promise<FileCleanupResult> {
    const request: EmptyTrashTopicsRequest = cloneForWire({ assistantId })
    return unwrap(await this.api.emptyTrashTopics(request))
  }

  async transferTopicOwnership(topicId: string, assistantId: string): Promise<void> {
    if (!this.api.transferTopicOwnership) throw new Error('transferTopicOwnership is unavailable')
    unwrap(await this.api.transferTopicOwnership(cloneForWire({ topicId, assistantId })))
  }

  async resetAssistantTopics(assistantId: string, replacementTopicId: string): Promise<ResetAssistantTopicsResponse> {
    if (!this.api.resetAssistantTopics) throw new Error('resetAssistantTopics is unavailable')
    return unwrap(await this.api.resetAssistantTopics(cloneForWire({ assistantId, replacementTopicId })))
  }

  // ============ Compound Mutations (Phase 5.1B) ============

  async cloneMessagesToTopic(targetTopicId: string, entries: MessageBlockEntry[], assistantId?: string): Promise<void> {
    const request: CloneMessagesToTopicRequest = cloneForWire({ targetTopicId, entries, assistantId })
    unwrap(await this.api.cloneMessagesToTopic(request))
    dispatchTopicUpdatedAt(targetTopicId)
  }

  async resetMessagesForResend(
    topicId: string,
    messages: MessageBlockEntry[],
    blockIdsToDelete: string[]
  ): Promise<FileCleanupResult> {
    const request: ResetMessagesForResendRequest = cloneForWire({ topicId, messages, blockIdsToDelete })
    const result = unwrap(await this.api.resetMessagesForResend(request))
    dispatchTopicUpdatedAt(topicId)
    return result
  }

  async deleteMessagesWithSegments(topicId: string, messageIds: string[]): Promise<FileCleanupResult> {
    const request: DeleteMessagesWithSegmentsRequest = cloneForWire({ topicId, messageIds })
    const result = unwrap(await this.api.deleteMessagesWithSegments(request))
    dispatchTopicUpdatedAt(topicId)
    return result
  }

  async pasteMessagesToTopic(
    topicId: string,
    entries: MessageBlockEntry[],
    insertIndex?: number
  ): Promise<FileCleanupResult> {
    const request: PasteMessagesToTopicRequest = cloneForWire({ topicId, entries, insertIndex })
    const result = unwrap(await this.api.pasteMessagesToTopic(request))
    dispatchTopicUpdatedAt(topicId)
    return result
  }

  // ============ Windowed reads (S6.1 R-02/R-03) ============

  async fetchMessagesWindow(request: FetchMessagesWindowRequest): Promise<FetchMessagesWindowResponse> {
    if (!this.api.fetchMessagesWindow) {
      throw new Error('ChatDb API unavailable: window read not exposed')
    }
    const wireRequest = cloneForWire(request as unknown as JsonObject) as unknown as FetchMessagesWindowRequest
    const result = unwrap(await this.api.fetchMessagesWindow(wireRequest))
    return {
      messages: result.messages as unknown as Message[],
      blocks: result.blocks as unknown as MessageBlock[],
      window: result.window
    } as unknown as FetchMessagesWindowResponse
  }

  // ============ Search (Phase 5.2A, read-only) ============

  /**
   * Search message blocks via the Main-side SQLite search surface.
   *
   * Follows the standard pattern: one named bridge call, ChatDbResult
   * unwrapping, structured failure throws ChatDbResultError, transport
   * rejection propagates unchanged. No retry, no fallback.
   */
  async searchMessages(request: SearchMessagesRequest): Promise<SearchMessagesResponse> {
    const wireRequest: SearchMessagesRequest = cloneForWire(request)
    return unwrap(await this.api.searchMessages(wireRequest))
  }

  // ============ File Operations ============
  // updateFileCount and updateFileCounts are intentionally omitted.
  // They stay in Dexie/FileManager (not routed through ChatDb IPC).

  // ============ Static accessors for testing ============

  /**
   * Expose cloneForWire for testing purposes.
   * Re-exported from the shared utility (LOCK-N5).
   * Not part of the public API.
   */
  static _cloneForWire = cloneForWire
}
