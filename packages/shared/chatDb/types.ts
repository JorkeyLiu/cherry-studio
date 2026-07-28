/**
 * Wire DTO / request / value types for the ChatDB IPC layer.
 *
 * Design rules:
 * - All types are JSON-only. No Electron, Node, Drizzle, SQLite, or
 *   Renderer imports. Dependency-free at runtime.
 * - JsonObject carries entity data over the wire. Interpretation
 *   (column vs overflow mapping) is the Main aggregate's responsibility.
 * - Patch semantics: absent key = no update, null = clear field.
 *   undefined is rejected by the validator.
 * - Extension metadata fields (overflow/extra) must be explicit JsonObject,
 *   never a bare primitive or array at the top level.
 * - Result<T> is the unified envelope for all ChatDb IPC responses.
 */

// ---------------------------------------------------------------------------
// JSON wire primitives
// ---------------------------------------------------------------------------

/**
 * A finite number. Rejects NaN, ±Infinity.
 * Enforced by the validator; this type documents the contract.
 */
export type JsonPrimitive = null | boolean | string | number

/**
 * Recursive JSON value. No undefined, bigint, symbol, function, Date,
 * Map, Set, Buffer, TypedArray, class instances, or sparse arrays.
 * Enforced by the validator with bounded nesting depth.
 */
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject

/**
 * A plain JSON object. All keys are strings, all values are JsonValue.
 */
export type JsonObject = { [key: string]: JsonValue }

// ---------------------------------------------------------------------------
// Result envelope
// ---------------------------------------------------------------------------

/**
 * Successful result. `value` is the command return value.
 * For void commands (no return data), value is `null`.
 */
export interface ChatDbSuccess<T> {
  ok: true
  value: T
}

/**
 * Failed result. `error` carries structured failure info.
 */
export interface ChatDbFailure {
  ok: false
  error: ChatDbError
}

/**
 * Unified result envelope for all ChatDb IPC responses.
 */
export type ChatDbResult<T> = ChatDbSuccess<T> | ChatDbFailure

/**
 * Structured error in a ChatDb failure result.
 */
export interface ChatDbError {
  /** Machine-readable error code (e.g. 'VALIDATION_ERROR', 'TOPIC_NOT_FOUND'). */
  code: string
  /** Human-readable error message. */
  message: string
  /** If true, the operation may succeed if retried. */
  retryable: boolean
  /** Optional structured details. */
  details?: JsonObject
}

// ---------------------------------------------------------------------------
// Command request DTOs
//
// Each corresponds to one IpcChannel entry. Field names use camelCase.
// Entity data (message, blocks) is carried as JsonObject — the Main
// aggregate maps these to MessageData/MessageBlockData.
// ---------------------------------------------------------------------------

/** @see IpcChannel.ChatDb_FetchMessages */
export interface FetchMessagesRequest {
  topicId: string
}

/** @see IpcChannel.ChatDb_GetRawTopic */
export interface GetRawTopicRequest {
  topicId: string
}

/** @see IpcChannel.ChatDb_TopicExists */
export interface TopicExistsRequest {
  topicId: string
}

/** @see IpcChannel.ChatDb_EnsureTopic */
export interface EnsureTopicRequest {
  topicId: string
  assistantId?: string
}

/** @see IpcChannel.ChatDb_AppendMessage */
export interface AppendMessageRequest {
  topicId: string
  /** Full message entity as JSON. Must contain at least `id`. */
  message: JsonObject
  /** Full block entities as JSON. Each must contain at least `id` and `messageId`. */
  blocks: JsonObject[]
  /** Optional insertion index (zero-based). Absent = append at end. */
  insertIndex?: number
}

/** @see IpcChannel.ChatDb_UpdateMessage */
export interface UpdateMessageRequest {
  topicId: string
  messageId: string
  /**
   * Partial message patch. Absent keys are unchanged.
   * null clears the field. undefined is rejected.
   * Must NOT change id or topicId.
   */
  updates: JsonObject
}

/** @see IpcChannel.ChatDb_UpdateMessageAndBlocks */
export interface UpdateMessageAndBlocksRequest {
  topicId: string
  /**
   * Partial message patch with required `id` field.
   * Must NOT change id or topicId.
   */
  messageUpdates: JsonObject
  /** Block entities to upsert. Each must contain `id` and `messageId`. */
  blocksToUpdate: JsonObject[]
}

/** @see IpcChannel.ChatDb_DeleteMessage */
export interface DeleteMessageRequest {
  topicId: string
  messageId: string
}

/** @see IpcChannel.ChatDb_DeleteMessages */
export interface DeleteMessagesRequest {
  topicId: string
  messageIds: string[]
}

/** @see IpcChannel.ChatDb_UpdateBlocks */
export interface UpdateBlocksRequest {
  /** Block entities to upsert. Each must contain `id` and `messageId`. */
  blocks: JsonObject[]
}

/** @see IpcChannel.ChatDb_UpdateSingleBlock */
export interface UpdateSingleBlockRequest {
  blockId: string
  /**
   * Partial block patch. Absent keys are unchanged.
   * Must NOT change id or messageId.
   */
  updates: JsonObject
}

/** @see IpcChannel.ChatDb_BulkAddBlocks */
export interface BulkAddBlocksRequest {
  /** Full block entities to insert. Each must contain `id` and `messageId`. */
  blocks: JsonObject[]
}

/** @see IpcChannel.ChatDb_DeleteBlocks */
export interface DeleteBlocksRequest {
  blockIds: string[]
}

/** @see IpcChannel.ChatDb_ClearMessages */
export interface ClearMessagesRequest {
  topicId: string
}

// ---------------------------------------------------------------------------
// Command response DTOs
// ---------------------------------------------------------------------------

/** @see IpcChannel.ChatDb_FetchMessages */
export interface FetchMessagesResponse {
  messages: JsonObject[]
  blocks: JsonObject[]
}

/** @see IpcChannel.ChatDb_GetRawTopic */
export type GetRawTopicResponse = { id: string; messages: JsonObject[] } | null

// ---------------------------------------------------------------------------
// Segment command DTOs (Phase 5.1A)
// ---------------------------------------------------------------------------

/** @see IpcChannel.ChatDb_ListSegments */
export interface ListSegmentsRequest {
  topicId: string
}

/** Wire shape for a segment with ordered messageIds. */
export interface SegmentWire {
  id: string
  topicId: string
  name: string | null
  messageIds: string[]
  /** Optional color bridged through SQLite extra overflow. */
  color?: string | null
  createdAt: string | null
  updatedAt: string | null
}

/** @see IpcChannel.ChatDb_ListSegments */
export type ListSegmentsResponse = SegmentWire[]

/** @see IpcChannel.ChatDb_UpsertSegment */
export interface UpsertSegmentRequest {
  segmentId: string
  topicId: string
  name?: string | null
  /** Ordered message IDs for this segment. */
  messageIds: string[]
  /** Optional color stored in extra overflow. */
  color?: string | null
}

/** @see IpcChannel.ChatDb_UpsertSegment */
export type UpsertSegmentResponse = SegmentWire

/** @see IpcChannel.ChatDb_UpdateSegmentMetadata */
export interface UpdateSegmentMetadataRequest {
  segmentId: string
  /** Partial metadata patch. Absent keys unchanged, null clears field. */
  name?: string | null
  color?: string | null
}

/** @see IpcChannel.ChatDb_UpdateSegmentMetadata */
export type UpdateSegmentMetadataResponse = SegmentWire

/** @see IpcChannel.ChatDb_DeleteSegment */
export interface DeleteSegmentRequest {
  segmentId: string
}

/** @see IpcChannel.ChatDb_ReplaceSegmentMembership */
export interface ReplaceSegmentMembershipRequest {
  segmentId: string
  /** Complete ordered message ID list. Empty deletes the segment per repo semantics. */
  messageIds: string[]
}

/** @see IpcChannel.ChatDb_ReplaceSegmentMembership */
export type ReplaceSegmentMembershipResponse = SegmentWire | null

// ---------------------------------------------------------------------------
// Message reorder command DTOs (Phase 5.1A)
// ---------------------------------------------------------------------------

/** @see IpcChannel.ChatDb_ReorderMessages */
export interface ReorderMessagesRequest {
  topicId: string
  /** Complete ordered message ID list for the topic. */
  messageIds: string[]
}

// ---------------------------------------------------------------------------
// File reference query DTOs (Phase 5.1A, read-only)
// ---------------------------------------------------------------------------

/** Wire shape for a file reference entry. */
export interface FileReferenceWire {
  id: string
  blockId: string
  fileId: string
  fileName: string | null
  filePath: string | null
  fileType: string | null
  count: number | null
}

/** @see IpcChannel.ChatDb_ListFileRefsByFile */
export interface ListFileRefsByFileRequest {
  fileId: string
}

/** @see IpcChannel.ChatDb_ListFileRefsByFile */
export type ListFileRefsByFileResponse = FileReferenceWire[]

/** @see IpcChannel.ChatDb_CountFileRefsByFile */
export interface CountFileRefsByFileRequest {
  fileId: string
}

/** @see IpcChannel.ChatDb_CountFileRefsByFile */
export type CountFileRefsByFileResponse = number

/** @see IpcChannel.ChatDb_ListBlocksByFile */
export interface ListBlocksByFileRequest {
  fileId: string
}

/** @see IpcChannel.ChatDb_ListBlocksByFile */
export type ListBlocksByFileResponse = JsonObject[]

// ---------------------------------------------------------------------------
// Topic lifecycle DTOs (Phase 5.1B)
// ---------------------------------------------------------------------------

/** Wire shape for a topic entity. */
export interface TopicWire {
  id: string
  assistantId?: string | null
  name?: string | null
  /** Round-trips through topic extra overflow. */
  pinned?: boolean | null
  /** Round-trips through topic extra overflow. */
  prompt?: string | null
  /** Round-trips through topic extra overflow. */
  isNameManuallyEdited?: boolean | null
  createdAt?: string | null
  updatedAt?: string | null
  deletedAt?: string | null
}

/** Structured result for operations that cascade file_references. */
export interface FileCleanupResult {
  /** Unique file IDs whose file_references were deleted by this operation. */
  affectedFileIds: string[]
  /**
   * Remaining reference count for each affected file after the mutation.
   * Callers use this to determine which files are safe to physically delete.
   */
  remainingReferenceCounts: Record<string, number>
}

/** @see IpcChannel.ChatDb_UpdateTopicMetadata */
export interface UpdateTopicMetadataRequest {
  topicId: string
  /** New name. null clears, absent = no change. */
  name?: string | null
  /** Pinned state (overflow). null clears, absent = no change. */
  pinned?: boolean | null
  /** Prompt (overflow). null clears, absent = no change. */
  prompt?: string | null
  /** isNameManuallyEdited (overflow). null clears, absent = no change. */
  isNameManuallyEdited?: boolean | null
}

/** @see IpcChannel.ChatDb_UpdateTopicMetadata */
export type UpdateTopicMetadataResponse = TopicWire

/** @see IpcChannel.ChatDb_SoftDeleteTopic */
export interface SoftDeleteTopicRequest {
  topicId: string
}

/** @see IpcChannel.ChatDb_RestoreTopic */
export interface RestoreTopicRequest {
  topicId: string
}

/**
 * @see IpcChannel.ChatDb_RestoreTopic
 *
 * The atomically restored topic, or null when no soft-deleted row existed
 * for the ID at command time (missing topic or not in trash). Callers must
 * dispatch only a returned row — never a separately listed one (LOCK-532).
 */
export type RestoreTopicResponse = TopicWire | null

/** @see IpcChannel.ChatDb_ListTrashTopics */
export interface ListTrashTopicsRequest {
  assistantId?: string
  limit?: number
  cursor?: string
}

/** @see IpcChannel.ChatDb_ListTrashTopics */
export interface ListTrashTopicsResponse {
  items: TopicWire[]
  nextCursor?: string
  hasMore: boolean
}

/** @see IpcChannel.ChatDb_HardDeleteTopic */
export interface HardDeleteTopicRequest {
  topicId: string
}

/** @see IpcChannel.ChatDb_HardDeleteTopic */
export type HardDeleteTopicResponse = FileCleanupResult

/** @see IpcChannel.ChatDb_PurgeExpiredTopics */
export interface PurgeExpiredTopicsRequest {
  /**
   * ISO 8601 timestamp. Topics with deletedAt < cutoffTimestamp are purged.
   * Generated by caller per LOCK-5113.
   */
  cutoffTimestamp: string
}

/** @see IpcChannel.ChatDb_PurgeExpiredTopics */
export type PurgeExpiredTopicsResponse = FileCleanupResult

/**
 * @see IpcChannel.ChatDb_EmptyTrashTopics
 *
 * Empty an assistant's trash in ONE Main SQLite transaction over the topics
 * that are still soft-deleted at transaction time (LOCK-531). Never a
 * renderer-side list+loop of hard deletes.
 */
export interface EmptyTrashTopicsRequest {
  assistantId: string
}

/** @see IpcChannel.ChatDb_EmptyTrashTopics */
export type EmptyTrashTopicsResponse = FileCleanupResult

// ---------------------------------------------------------------------------
// Compound mutation DTOs (Phase 5.1B)
// ---------------------------------------------------------------------------

/** An ordered message+blocks entry for compound batch operations. */
export interface MessageBlockEntry {
  /** Full message entity as JSON. Must contain at least `id`. */
  message: JsonObject
  /** Full block entities as JSON. Each must contain `id` and `messageId`. */
  blocks: JsonObject[]
}

/** @see IpcChannel.ChatDb_CloneMessagesToTopic */
export interface CloneMessagesToTopicRequest {
  targetTopicId: string
  assistantId?: string
  /** Ordered entries to insert. Messages are appended in array order. */
  entries: MessageBlockEntry[]
}

/** @see IpcChannel.ChatDb_CloneMessagesToTopic */
export type CloneMessagesToTopicResponse = null

/** @see IpcChannel.ChatDb_ResetMessagesForResend */
export interface ResetMessagesForResendRequest {
  topicId: string
  /** Message IDs to reset. Each must belong to topicId. */
  messageIds: string[]
  /** Block IDs to delete as part of the reset. */
  blockIdsToDelete: string[]
}

/** @see IpcChannel.ChatDb_ResetMessagesForResend */
export type ResetMessagesForResendResponse = FileCleanupResult

/** @see IpcChannel.ChatDb_DeleteMessagesWithSegments */
export interface DeleteMessagesWithSegmentsRequest {
  topicId: string
  messageIds: string[]
}

/** @see IpcChannel.ChatDb_DeleteMessagesWithSegments */
export type DeleteMessagesWithSegmentsResponse = FileCleanupResult

/** @see IpcChannel.ChatDb_PasteMessagesToTopic */
export interface PasteMessagesToTopicRequest {
  topicId: string
  /** Ordered entries to insert. Inserted at insertIndex in array order. */
  entries: MessageBlockEntry[]
  /** Position to insert at (zero-based). Absent = append at end. */
  insertIndex?: number
}

/** @see IpcChannel.ChatDb_PasteMessagesToTopic */
export type PasteMessagesToTopicResponse = FileCleanupResult

/** @see IpcChannel.ChatDb_ClearTopicWithSegments */
export interface ClearTopicWithSegmentsRequest {
  topicId: string
}

/** @see IpcChannel.ChatDb_ClearTopicWithSegments */
export type ClearTopicWithSegmentsResponse = FileCleanupResult

// ---------------------------------------------------------------------------
// Search command DTOs (Phase 5.1B-2)
// ---------------------------------------------------------------------------

/** @see IpcChannel.ChatDb_SearchMessages */
export interface SearchMessagesRequest {
  /** Search keywords/terms. Quoted phrases and whitespace-separated. */
  keywords: string
  /** Match mode: 'whole-word' uses Unicode word boundaries, 'substring' uses plain matching. */
  matchMode: 'whole-word' | 'substring'
  /** Sort order: 'newest' (desc) or 'oldest' (asc) by message createdAt. */
  sortOrder: 'newest' | 'oldest'
  /** Page size. Clamped to [1, 100]. Default: 20. */
  pageSize?: number
  /** Opaque cursor for pagination. Absent = first page. */
  cursor?: string
}

/** Wire shape for a search result entry. */
export interface SearchResultItem {
  /** Block ID matching the search. */
  blockId: string
  /** Parent message ID. */
  messageId: string
  /** Parent topic ID. */
  topicId: string
  /** Topic name (nullable). */
  topicName: string | null
  /** Raw block content (un-normalized, for snippet generation). */
  rawContent: string
  /** Message creation timestamp (ISO 8601). */
  messageCreatedAt: string | null
}

/** @see IpcChannel.ChatDb_SearchMessages */
export interface SearchMessagesResponse {
  /** Matching results. */
  items: SearchResultItem[]
  /** Opaque cursor for next page. Absent when no more results. */
  nextCursor?: string
  /** Whether more results may exist beyond this page. */
  hasMore: boolean
  /** Total matching count (best-effort, may be 0 if not computed). */
  totalCount: number
}

// ---------------------------------------------------------------------------
// Command-to-request/response mapping
//
// Enforces compile-time linkage between IPC channel, request type,
// and response type. Used by contracts.ts for validation dispatch.
// ---------------------------------------------------------------------------

/** Command map: channel string → request type. */
export interface ChatDbCommandMap {
  [key: string]: { request: unknown; response: unknown }
}

/**
 * Typed command map linking each ChatDb channel to its request and
 * response types. Prevents silent drift between channel definitions
 * and their wire contracts.
 */
export interface ChatDbCommands extends ChatDbCommandMap {
  // Original 14 commands
  'chatdb:fetch-messages': { request: FetchMessagesRequest; response: FetchMessagesResponse }
  'chatdb:get-raw-topic': { request: GetRawTopicRequest; response: GetRawTopicResponse }
  'chatdb:topic-exists': { request: TopicExistsRequest; response: boolean }
  'chatdb:ensure-topic': { request: EnsureTopicRequest; response: null }
  'chatdb:append-message': { request: AppendMessageRequest; response: null }
  'chatdb:update-message': { request: UpdateMessageRequest; response: null }
  'chatdb:update-message-and-blocks': { request: UpdateMessageAndBlocksRequest; response: null }
  'chatdb:delete-message': { request: DeleteMessageRequest; response: null }
  'chatdb:delete-messages': { request: DeleteMessagesRequest; response: null }
  'chatdb:update-blocks': { request: UpdateBlocksRequest; response: null }
  'chatdb:update-single-block': { request: UpdateSingleBlockRequest; response: null }
  'chatdb:bulk-add-blocks': { request: BulkAddBlocksRequest; response: null }
  'chatdb:delete-blocks': { request: DeleteBlocksRequest; response: null }
  'chatdb:clear-messages': { request: ClearMessagesRequest; response: null }
  // Phase 5.1A: segment commands
  'chatdb:list-segments': { request: ListSegmentsRequest; response: ListSegmentsResponse }
  'chatdb:upsert-segment': { request: UpsertSegmentRequest; response: UpsertSegmentResponse }
  'chatdb:update-segment-metadata': { request: UpdateSegmentMetadataRequest; response: UpdateSegmentMetadataResponse }
  'chatdb:delete-segment': { request: DeleteSegmentRequest; response: null }
  'chatdb:replace-segment-membership': {
    request: ReplaceSegmentMembershipRequest
    response: ReplaceSegmentMembershipResponse
  }
  // Phase 5.1A: message reorder
  'chatdb:reorder-messages': { request: ReorderMessagesRequest; response: null }
  // Phase 5.1A: file reference queries (read-only)
  'chatdb:list-file-refs-by-file': { request: ListFileRefsByFileRequest; response: ListFileRefsByFileResponse }
  'chatdb:count-file-refs-by-file': { request: CountFileRefsByFileRequest; response: CountFileRefsByFileResponse }
  'chatdb:list-blocks-by-file': { request: ListBlocksByFileRequest; response: ListBlocksByFileResponse }
  // Phase 5.1B: topic lifecycle
  'chatdb:update-topic-metadata': { request: UpdateTopicMetadataRequest; response: UpdateTopicMetadataResponse }
  'chatdb:soft-delete-topic': { request: SoftDeleteTopicRequest; response: null }
  'chatdb:restore-topic': { request: RestoreTopicRequest; response: RestoreTopicResponse }
  'chatdb:list-trash-topics': { request: ListTrashTopicsRequest; response: ListTrashTopicsResponse }
  'chatdb:hard-delete-topic': { request: HardDeleteTopicRequest; response: HardDeleteTopicResponse }
  'chatdb:purge-expired-topics': { request: PurgeExpiredTopicsRequest; response: PurgeExpiredTopicsResponse }
  'chatdb:empty-trash-topics': { request: EmptyTrashTopicsRequest; response: EmptyTrashTopicsResponse }
  // Phase 5.1B: compound mutations
  'chatdb:clone-messages-to-topic': {
    request: CloneMessagesToTopicRequest
    response: CloneMessagesToTopicResponse
  }
  'chatdb:reset-messages-for-resend': {
    request: ResetMessagesForResendRequest
    response: ResetMessagesForResendResponse
  }
  'chatdb:delete-messages-with-segments': {
    request: DeleteMessagesWithSegmentsRequest
    response: DeleteMessagesWithSegmentsResponse
  }
  'chatdb:paste-messages-to-topic': {
    request: PasteMessagesToTopicRequest
    response: PasteMessagesToTopicResponse
  }
  'chatdb:clear-topic-with-segments': {
    request: ClearTopicWithSegmentsRequest
    response: ClearTopicWithSegmentsResponse
  }
  // Phase 5.1B-2: search
  'chatdb:search-messages': {
    request: SearchMessagesRequest
    response: SearchMessagesResponse
  }
}

/** All valid ChatDb command channel strings. */
export type ChatDbChannel = keyof ChatDbCommands

/** Extract request type for a given channel. */
export type ChatDbRequest<C extends ChatDbChannel> = ChatDbCommands[C]['request']

/** Extract response type for a given channel. */
export type ChatDbResponse<C extends ChatDbChannel> = ChatDbCommands[C]['response']
