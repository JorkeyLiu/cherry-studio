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
}

/** All valid ChatDb command channel strings. */
export type ChatDbChannel = keyof ChatDbCommands

/** Extract request type for a given channel. */
export type ChatDbRequest<C extends ChatDbChannel> = ChatDbCommands[C]['request']

/** Extract response type for a given channel. */
export type ChatDbResponse<C extends ChatDbChannel> = ChatDbCommands[C]['response']
