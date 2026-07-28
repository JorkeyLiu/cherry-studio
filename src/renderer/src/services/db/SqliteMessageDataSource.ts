/**
 * SqliteMessageDataSource — SQLite-backed implementation of MessageDataSource.
 *
 * Routes all operations through the preload `window.api.chatDb` bridge
 * to Main-side ChatDbAggregateService via 23 named IPC methods.
 *
 * Design:
 * - Constructor injection of a narrow typed ChatDbApi; defaults to window.api.chatDb.
 * - Each method calls exactly one named bridge method and unwraps ChatDbResult.
 * - Structured failure throws ChatDbResultError; transport rejection propagates unchanged.
 * - No retry, no fallback, no second method calls.
 * - updateFileCount(s) are intentionally omitted (stays Dexie/FileManager).
 * - updateTopicUpdatedAt dispatch parity after successful message/topic mutations.
 * - Renderer→wire JSON boundary: cloneForWire recursively clones, strips undefined,
 *   validates JSON safety, rejects unsupported types.
 */

import store from '@renderer/store'
import { updateTopicUpdatedAt } from '@renderer/store/assistants'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import type {
  AppendMessageRequest,
  BulkAddBlocksRequest,
  ChatDbError,
  ChatDbResult,
  ClearMessagesRequest,
  ClearTopicWithSegmentsRequest,
  ClearTopicWithSegmentsResponse,
  CloneMessagesToTopicRequest,
  CloneMessagesToTopicResponse,
  CountFileRefsByFileRequest,
  CountFileRefsByFileResponse,
  DeleteBlocksRequest,
  DeleteMessageRequest,
  DeleteMessagesRequest,
  DeleteMessagesWithSegmentsRequest,
  DeleteMessagesWithSegmentsResponse,
  DeleteSegmentRequest,
  EnsureTopicRequest,
  FetchMessagesRequest,
  FetchMessagesResponse,
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
  ResetMessagesForResendRequest,
  ResetMessagesForResendResponse,
  RestoreTopicRequest,
  SoftDeleteTopicRequest,
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

import type { MessageDataSource } from './types'

// ---------------------------------------------------------------------------
// ChatDbApi — narrow typed interface for the preload bridge
//
// Matches window.api.chatDb shape. Used for constructor injection
// to avoid importing preload implementation (layering).
// ---------------------------------------------------------------------------

export interface ChatDbApi {
  fetchMessages(request: FetchMessagesRequest): Promise<ChatDbResult<FetchMessagesResponse>>
  getRawTopic(request: GetRawTopicRequest): Promise<ChatDbResult<GetRawTopicResponse>>
  topicExists(request: TopicExistsRequest): Promise<ChatDbResult<boolean>>
  ensureTopic(request: EnsureTopicRequest): Promise<ChatDbResult<null>>
  appendMessage(request: AppendMessageRequest): Promise<ChatDbResult<null>>
  updateMessage(request: UpdateMessageRequest): Promise<ChatDbResult<null>>
  updateMessageAndBlocks(request: UpdateMessageAndBlocksRequest): Promise<ChatDbResult<null>>
  deleteMessage(request: DeleteMessageRequest): Promise<ChatDbResult<null>>
  deleteMessages(request: DeleteMessagesRequest): Promise<ChatDbResult<null>>
  updateBlocks(request: UpdateBlocksRequest): Promise<ChatDbResult<null>>
  updateSingleBlock(request: UpdateSingleBlockRequest): Promise<ChatDbResult<null>>
  bulkAddBlocks(request: BulkAddBlocksRequest): Promise<ChatDbResult<null>>
  deleteBlocks(request: DeleteBlocksRequest): Promise<ChatDbResult<null>>
  clearMessages(request: ClearMessagesRequest): Promise<ChatDbResult<null>>
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
  restoreTopic(request: RestoreTopicRequest): Promise<ChatDbResult<null>>
  listTrashTopics(request: ListTrashTopicsRequest): Promise<ChatDbResult<ListTrashTopicsResponse>>
  hardDeleteTopic(request: HardDeleteTopicRequest): Promise<ChatDbResult<HardDeleteTopicResponse>>
  purgeExpiredTopics(request: PurgeExpiredTopicsRequest): Promise<ChatDbResult<PurgeExpiredTopicsResponse>>
  // Phase 5.1B: compound mutations
  cloneMessagesToTopic(request: CloneMessagesToTopicRequest): Promise<ChatDbResult<CloneMessagesToTopicResponse>>
  resetMessagesForResend(request: ResetMessagesForResendRequest): Promise<ChatDbResult<ResetMessagesForResendResponse>>
  deleteMessagesWithSegments(
    request: DeleteMessagesWithSegmentsRequest
  ): Promise<ChatDbResult<DeleteMessagesWithSegmentsResponse>>
  pasteMessagesToTopic(request: PasteMessagesToTopicRequest): Promise<ChatDbResult<PasteMessagesToTopicResponse>>
  clearTopicWithSegments(request: ClearTopicWithSegmentsRequest): Promise<ChatDbResult<ClearTopicWithSegmentsResponse>>
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
// JSON wire boundary — cloneForWire
//
// Recursively clones plain arrays/objects for safe IPC transport.
// - Strips undefined values from objects (omitted).
// - Preserves null and order.
// - Rejects: non-finite numbers, bigint, symbol, function, Date,
//   Map, Set, TypedArray, class instances, sparse arrays, cycles.
// - Does NOT use JSON.stringify/parse. Does NOT mutate inputs.
// ---------------------------------------------------------------------------

const MAX_DEPTH = 20

/**
 * Deep-clone a value for safe IPC transport.
 * Enforces JSON wire safety constraints.
 *
 * @param value  The value to clone.
 * @param depth  Current recursion depth.
 * @param seen   WeakSet for cycle detection.
 * @returns      A deep-cloned, JSON-safe copy.
 * @throws       {TypeError} If the value contains unsupported types.
 */
function cloneForWire<T>(value: T, depth = 0, seen = new WeakSet()): T {
  if (depth > MAX_DEPTH) {
    throw new TypeError(`cloneForWire: nesting depth exceeds maximum (${MAX_DEPTH})`)
  }

  if (value === undefined) {
    return undefined as T
  }

  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`cloneForWire: non-finite number: ${value}`)
    }
    return value
  }

  if (typeof value === 'bigint') {
    throw new TypeError('cloneForWire: bigint is not a valid JSON value')
  }

  if (typeof value === 'symbol') {
    throw new TypeError('cloneForWire: symbol is not a valid JSON value')
  }

  if (typeof value === 'function') {
    throw new TypeError('cloneForWire: function is not a valid JSON value')
  }

  if (value instanceof Date) {
    throw new TypeError('cloneForWire: Date is not a valid JSON value')
  }

  if (value instanceof Map || value instanceof WeakMap) {
    throw new TypeError('cloneForWire: Map is not a valid JSON value')
  }

  if (value instanceof Set || value instanceof WeakSet) {
    throw new TypeError('cloneForWire: Set is not a valid JSON value')
  }

  if (value instanceof RegExp || value instanceof Error) {
    throw new TypeError(`cloneForWire: ${value.constructor.name} is not a valid JSON value`)
  }

  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new TypeError('cloneForWire: TypedArray/Buffer is not a valid JSON value')
  }

  if (Array.isArray(value)) {
    // Cycle detection
    if (seen.has(value as object)) {
      throw new TypeError('cloneForWire: cyclic reference detected')
    }
    seen.add(value as object)

    const result: unknown[] = new Array(value.length)
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) {
        throw new TypeError(`cloneForWire: sparse arrays are not allowed (hole at index ${i})`)
      }
      if (value[i] === undefined) {
        throw new TypeError(`cloneForWire: undefined in arrays is not a valid JSON value (index ${i})`)
      }
      result[i] = cloneForWire(value[i], depth + 1, seen)
    }
    return result as T
  }

  if (typeof value === 'object') {
    // Plain object check
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`cloneForWire: non-plain object (constructor: ${proto?.constructor?.name ?? 'unknown'})`)
    }

    // Cycle detection
    if (seen.has(value as object)) {
      throw new TypeError('cloneForWire: cyclic reference detected')
    }
    seen.add(value as object)

    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const v = (value as Record<string, unknown>)[key]
      if (v === undefined) {
        // Omit undefined values — they are not valid in JSON wire
        continue
      }
      result[key] = cloneForWire(v, depth + 1, seen)
    }
    return result as T
  }

  throw new TypeError(`cloneForWire: unsupported type: ${typeof value}`)
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
// Matches DexieMessageDataSource behavior: dispatch after successful
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
 * Constructor injection allows testing without the actual preload context.
 * Defaults to window.api.chatDb in production.
 */
export class SqliteMessageDataSource implements MessageDataSource {
  private readonly api: ChatDbApi

  constructor(api?: ChatDbApi) {
    this.api = api ?? (window as any).api.chatDb
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

  async appendMessage(topicId: string, message: Message, blocks: MessageBlock[], insertIndex?: number): Promise<void> {
    const sanitizedIndex = sanitizeInsertIndex(insertIndex)
    const request: AppendMessageRequest = {
      topicId,
      message: cloneForWire(message as unknown as JsonObject),
      blocks: cloneForWire(blocks as unknown as JsonObject[]),
      ...(sanitizedIndex !== undefined && { insertIndex: sanitizedIndex })
    }
    unwrap(await this.api.appendMessage(request))
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
    blocksToUpdate: MessageBlock[]
  ): Promise<void> {
    // Clone and strip redundant identity/order fields for Dexie-compatible semantics
    const clonedUpdates = cloneForWire(messageUpdates as unknown as JsonObject) as Record<string, unknown>
    delete clonedUpdates.topicId
    delete clonedUpdates.sortOrder

    const request: UpdateMessageAndBlocksRequest = {
      topicId,
      messageUpdates: clonedUpdates as JsonObject,
      blocksToUpdate: cloneForWire(blocksToUpdate as unknown as JsonObject[])
    }
    unwrap(await this.api.updateMessageAndBlocks(request))
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

  async updateBlocks(blocks: MessageBlock[]): Promise<void> {
    const request: UpdateBlocksRequest = {
      blocks: cloneForWire(blocks as unknown as JsonObject[])
    }
    unwrap(await this.api.updateBlocks(request))
    // No topicUpdatedAt dispatch — block-only operation
  }

  async updateSingleBlock(blockId: string, updates: Partial<MessageBlock>): Promise<void> {
    const request: UpdateSingleBlockRequest = {
      blockId,
      updates: cloneForWire(updates as unknown as JsonObject)
    }
    unwrap(await this.api.updateSingleBlock(request))
    // No topicUpdatedAt dispatch — block-only operation
  }

  async bulkAddBlocks(blocks: MessageBlock[]): Promise<void> {
    const request: BulkAddBlocksRequest = {
      blocks: cloneForWire(blocks as unknown as JsonObject[])
    }
    unwrap(await this.api.bulkAddBlocks(request))
    // No topicUpdatedAt dispatch — block-only operation
  }

  async deleteBlocks(blockIds: string[]): Promise<void> {
    const request: DeleteBlocksRequest = cloneForWire({ blockIds })
    unwrap(await this.api.deleteBlocks(request))
    // No topicUpdatedAt dispatch — block-only operation
  }

  // ============ Batch Operations ============

  async clearMessages(topicId: string): Promise<void> {
    const request: ClearMessagesRequest = cloneForWire({ topicId })
    unwrap(await this.api.clearMessages(request))
    dispatchTopicUpdatedAt(topicId)
  }

  async topicExists(topicId: string): Promise<boolean> {
    const request: TopicExistsRequest = cloneForWire({ topicId })
    return unwrap(await this.api.topicExists(request))
  }

  async ensureTopic(topicId: string): Promise<void> {
    const request: EnsureTopicRequest = cloneForWire({ topicId })
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

  async softDeleteTopic(topicId: string): Promise<void> {
    const request: SoftDeleteTopicRequest = cloneForWire({ topicId })
    unwrap(await this.api.softDeleteTopic(request))
    dispatchTopicUpdatedAt(topicId)
  }

  async restoreTopic(topicId: string): Promise<void> {
    const request: RestoreTopicRequest = cloneForWire({ topicId })
    unwrap(await this.api.restoreTopic(request))
    dispatchTopicUpdatedAt(topicId)
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

  // ============ Compound Mutations (Phase 5.1B) ============

  async cloneMessagesToTopic(targetTopicId: string, entries: MessageBlockEntry[], assistantId?: string): Promise<void> {
    const request: CloneMessagesToTopicRequest = cloneForWire({ targetTopicId, entries, assistantId })
    unwrap(await this.api.cloneMessagesToTopic(request))
    dispatchTopicUpdatedAt(targetTopicId)
  }

  async resetMessagesForResend(
    topicId: string,
    messageIds: string[],
    blockIdsToDelete: string[]
  ): Promise<FileCleanupResult> {
    const request: ResetMessagesForResendRequest = cloneForWire({ topicId, messageIds, blockIdsToDelete })
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

  async clearTopicWithSegments(topicId: string): Promise<FileCleanupResult> {
    const request: ClearTopicWithSegmentsRequest = cloneForWire({ topicId })
    const result = unwrap(await this.api.clearTopicWithSegments(request))
    dispatchTopicUpdatedAt(topicId)
    return result
  }

  // ============ File Operations ============
  // updateFileCount and updateFileCounts are intentionally omitted.
  // They stay in Dexie/FileManager (not routed through ChatDb IPC).

  // ============ Static accessors for testing ============

  /**
   * Expose cloneForWire for testing purposes.
   * Not part of the public API.
   */
  static _cloneForWire = cloneForWire
}
