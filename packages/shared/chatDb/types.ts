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
  /** Initial topic name, persisted only when the topic is created. */
  name?: string | null
}

/**
 * Optional diagnostic-only correlation metadata for one append (LOCK-004).
 *
 * Carried on AppendMessageRequest ONLY to correlate renderer and main timing
 * logs for a single append/send. Never contains message content, prompts,
 * keys, or any user data — only an opaque id and a 1-based ordinal.
 */
export interface AppendDiagnostics {
  /** Opaque per-send correlation id shared by renderer and main log entries. */
  correlationId?: string
  /** 1-based append ordinal within the send (1 = user message, 2 = assistant message). */
  ordinal?: number
}

/**
 * Optional Main-internal resend attempt carrier (SYNC-DATA-055 issuer slice).
 *
 * Carries the Main-authoritative per-message attempt id minted by
 * `resetMessagesForResend` for exactly one resend/regenerate execution.
 * Ordinary paths omit it. Never reuses askId, Message.extra/overflow, or
 * diagnostics correlationId. Unknown keys elsewhere still fail closed.
 */
export type ResendAttemptIdCarrier = {
  /** Main-authoritative attempt id for the covered message (absent = legacy/ordinary). */
  resendAttemptId?: string
}

/** Strictly-closed per-message attempt mapping entry (only messageId + attemptId). */
export interface ResendAttemptMapping {
  messageId: string
  attemptId: string
}

/** @see IpcChannel.ChatDb_AppendMessage */
export interface AppendMessageRequest extends ResendAttemptIdCarrier {
  topicId: string
  /** Full message entity as JSON. Must contain at least `id`. */
  message: JsonObject
  /** Full block entities as JSON. Each must contain at least `id` and `messageId`. */
  blocks: JsonObject[]
  /** Optional insertion index (zero-based). Absent = append at end. */
  insertIndex?: number
  /** Optional diagnostic-only correlation metadata. Ignored for persistence. */
  diagnostics?: AppendDiagnostics
}

/** @see IpcChannel.ChatDb_UpdateMessage */
export interface UpdateMessageRequest extends ResendAttemptIdCarrier {
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
export interface UpdateMessageAndBlocksRequest extends ResendAttemptIdCarrier {
  topicId: string
  /**
   * Partial message patch with required `id` field.
   * Must NOT change id or topicId.
   */
  messageUpdates: JsonObject
  /** Block entities to upsert. Each must contain `id` and `messageId`. */
  blocksToUpdate: JsonObject[]
  blockIdsToDelete?: string[]
}

/**
 * @see IpcChannel.ChatDb_SelectAnswerMessage
 *
 * Cross-process authority: the renderer supplies ONLY the selected message
 * ID. Main resolves the complete answer group in the same SQLite
 * transaction (topic exists; selected belongs to topic, role assistant,
 * non-empty askId; full group = same-topic assistant messages with equal
 * askId in sort_order ASC, id ASC) and persists `foldSelected` for the full
 * group atomically: `true` for the selected, `false` for every other member.
 * No partial write; missing/invalid/cross-topic fails closed.
 *
 * `foldSelected` stays local-only: no sync frame/outbox change.
 */
export interface SelectAnswerMessageRequest {
  topicId: string
  /** The message to select (`foldSelected=true`). Main resolves its group. */
  selectedMessageId: string
}

/**
 * @see IpcChannel.ChatDb_SelectAnswerMessage
 *
 * Main-authoritative answer-group selection result. `messageIds` is the
 * complete answer group resolved by Main (sort_order ASC, id ASC).
 */
export interface SelectAnswerMessageResponse {
  topicId: string
  askId: string
  selectedMessageId: string
  /** Complete ordered answer-group message IDs (sort_order ASC, id ASC). */
  messageIds: string[]
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

/**
 * Optional measurement-only correlation metadata for streaming persistence
 * writes (update-single-block / update-blocks; PERF-STREAM-ATTR-001,
 * LOCK-STREAM-ATTR-001).
 *
 * Carried on UpdateSingleBlockRequest / UpdateBlocksRequest ONLY to pair
 * renderer-side timing records with the Main-side handler/transaction timing
 * of the SAME call. Never affects persistence semantics. Never contains
 * message content, prompts, keys, or any user data — only an opaque id and a
 * 1-based ordinal. Absent (the default) = no measurement correlation for that
 * call.
 */
export interface StreamWriteDiagnostics {
  /** Opaque per-call correlation id shared by renderer and main records. */
  correlationId?: string
  /** 1-based ordinal within the measured streaming write session. */
  ordinal?: number
}

/** @see IpcChannel.ChatDb_UpdateBlocks */
export interface UpdateBlocksRequest extends ResendAttemptIdCarrier {
  /** Block entities to upsert. Each must contain `id` and `messageId`. */
  blocks: JsonObject[]
  /**
   * Optional measurement-only correlation metadata. Ignored for persistence;
   * carries only an opaque id + ordinal (LOCK-STREAM-ATTR-001).
   */
  diagnostics?: StreamWriteDiagnostics
}

/** @see IpcChannel.ChatDb_UpdateSingleBlock */
export interface UpdateSingleBlockRequest extends ResendAttemptIdCarrier {
  blockId: string
  /**
   * Partial block patch. Absent keys are unchanged.
   * Must NOT change id or messageId.
   */
  updates: JsonObject
  /**
   * Optional measurement-only correlation metadata. Ignored for persistence;
   * carries only an opaque id + ordinal (LOCK-STREAM-ATTR-001).
   */
  diagnostics?: StreamWriteDiagnostics
}

/** @see IpcChannel.ChatDb_BulkAddBlocks */
export interface BulkAddBlocksRequest extends ResendAttemptIdCarrier {
  /** Full block entities to insert. Each must contain `id` and `messageId`. */
  blocks: JsonObject[]
}

/** @see IpcChannel.ChatDb_DeleteBlocks */
export interface DeleteBlocksRequest {
  blockIds: string[]
}
export type DeleteBlocksResponse = FileCleanupResult

// ---------------------------------------------------------------------------
// Windowed read DTOs (S6.1 R-02/R-03 — S6.2a bounded group correction)
// ---------------------------------------------------------------------------

/**
 * Latest window — tail N complete viewport groups (R-02).
 * Count is complete groups, not raw messages: consecutive assistant messages
 * sharing a non-empty askId are one group; all other messages are singleton
 * groups (canonical viewport group per getMessageGroupSemanticKey).
 * `returnedCount` remains message-row count; `limit` bounded 1..100.
 */
export interface FetchMessagesLatestWindowRequest {
  kind: 'latest'
  topicId: string
  /** Number of latest viewport groups to return. Caller-provided, bounded 1..100. */
  limit: number
}

/**
 * Around window — neighborhood of a stable anchor (R-03).
 * `before`/`after` count complete viewport groups adjacent to the anchor's
 * entire group (never splits a consecutive same-askId assistant run).
 * `returnedCount` remains message-row count; `before`/`after` bounded 1..100.
 */
export interface FetchMessagesAroundWindowRequest {
  kind: 'around'
  topicId: string
  /** Stable anchor message ID. */
  anchorMessageId: string
  /** Viewport groups before the anchor's group. Caller-provided, bounded 1..100. */
  before: number
  /** Viewport groups after the anchor's group. Caller-provided, bounded 1..100. */
  after: number
}

/** Discriminated window request for typed window reads. */
export type FetchMessagesWindowRequest = FetchMessagesLatestWindowRequest | FetchMessagesAroundWindowRequest

/** Typed window metadata — distinct from whole-topic completeness. */
export interface FetchMessagesWindowMeta {
  /** Which window intent was served. */
  kind: 'latest' | 'around'
  /** Completeness is always 'window' — never masquerades as 'whole-topic'. */
  completeness: 'window'
  /** Topic that was read. */
  topicId: string
  /** Anchor for around windows, null/absent for latest. */
  anchorMessageId?: string | null
  /** Echo of the caller's bounded counts. */
  requested: {
    limit?: number
    before?: number
    after?: number
  }
  /** First returned message ID, or null when no messages. */
  firstMessageId: string | null
  /** Last returned message ID, or null when no messages. */
  lastMessageId: string | null
  /** Number of messages returned (message-row count; group count intent is in requested). */
  returnedCount: number
  /** True when messages exist before the returned window in deterministic order. */
  hasMoreBefore: boolean
  /** True when messages exist after the returned window in deterministic order. */
  hasMoreAfter: boolean
}

/** @see IpcChannel.ChatDb_FetchMessagesWindow */
export interface FetchMessagesWindowResponse {
  messages: JsonObject[]
  blocks: JsonObject[]
  window: FetchMessagesWindowMeta
}

// ---------------------------------------------------------------------------
// Answer-group READ DTOs (S6.2b R-05)
// ---------------------------------------------------------------------------

/** @see IpcChannel.ChatDb_FetchAnswerGroup — additive READ for authoritative answer-group. */
export interface FetchAnswerGroupRequest {
  topicId: string
  anchorMessageId: string
}

/** @see IpcChannel.ChatDb_FetchAnswerGroup */
export interface FetchAnswerGroupResponse {
  /** Completeness is always 'answer-group' — never masquerades as 'window' or 'whole-topic'. */
  completeness: 'answer-group'
  /** Echo of the request topicId. */
  topicId: string
  /** Echo of the request anchorMessageId. */
  anchorMessageId: string
  /** askId of the anchor assistant message. */
  askId: string
  /** Complete ordered answer-group message IDs (sort_order ASC, id ASC). */
  messageIds: string[]
}

// ---------------------------------------------------------------------------
// Context closure DTOs (S6.3 R-06 — additive typed read from renderer-owned anchor)
// ---------------------------------------------------------------------------

/** @see IpcChannel.ChatDb_FetchContextClosure — additive READ for authoritative context closure. */
export interface FetchContextClosureRequest {
  topicId: string
  /** Renderer-owned persisted ContextWindowAnchor groupKey. */
  anchorGroupKey: string
}

/** Typed closure metadata — distinct from window/answer-group/whole-topic completeness. */
export interface FetchContextClosureMeta {
  /** Completeness is always 'context-closure' — never masquerades as window/answer-group/whole-topic. */
  completeness: 'context-closure'
  /** Topic that was read. */
  topicId: string
  /** Echo of the request anchorGroupKey. */
  anchorGroupKey: string
  /** First returned message ID, or null when no messages. */
  firstMessageId: string | null
  /** Last returned message ID, or null when no messages. */
  lastMessageId: string | null
  /** Number of messages returned. */
  returnedCount: number
  /** Total turn count in the topic (authority-ordered context turns). */
  totalTurnCount: number
  /** Selected turn count from anchor through newest. */
  selectedTurnCount: number
  /** Boundary divider message id, null iff selected===total else firstMessageId. */
  boundaryMessageId: string | null
}

/** @see IpcChannel.ChatDb_FetchContextClosure */
export interface FetchContextClosureResponse {
  messages: JsonObject[]
  blocks: JsonObject[]
  closure: FetchContextClosureMeta
}

// ---------------------------------------------------------------------------
// Authority context-closure resolver DTOs (additive; Main never persists settings)
// ---------------------------------------------------------------------------

/** Authority resolver intent for `chatdb:resolve-context-closure`. */
export type ResolveContextClosureIntent = 'establish' | 'reanchor-default' | 'move' | 'inherit'

/**
 * @see IpcChannel.ChatDb_ResolveContextClosure — additive authority resolver.
 *
 * One Main SQLite transaction builds full ordered context turns, resolves
 * `intent`, and returns the same-snapshot closure. Main never persists
 * renderer settings; the caller persists `resolvedAnchorGroupKey` with
 * stale guards (remove key when null for an existing empty target).
 *
 * - establish: `contextCount` + optional `currentAnchorGroupKey`. Preserves a
 *   valid current anchor, repairs a ghost to the default position.
 * - reanchor-default: `contextCount` + optional `currentAnchorGroupKey` (for
 *   `changed`). Always resolves to the default position.
 * - move: exactly one of `messageId` / `groupKey` + optional
 *   `currentAnchorGroupKey` (for `changed`). Resolves the message to its
 *   user / assistant askId-or-own / system turn; ignored roles reject.
 * - inherit: `sourceTopicId` + optional `sourceAnchorGroupKey` + `contextCount`
 *   (fallback when the source anchor is invalid) + optional
 *   `currentAnchorGroupKey` (target, for `changed`). Valid source index maps
 *   to the target by index with clamp to the last target turn.
 *
 * Existing empty target succeeds with null anchor; missing topic/target is NOT_FOUND.
 * Default index: null => 0; otherwise max(0, total - max(1, floor(N))).
 *
 * `detail` selects the response shape (backward-compatible, default
 * `'closure'`): `'closure'` returns the full same-snapshot closure;
 * `'anchor'` (allowed only for `intent: 'establish'`) returns a
 * metadata-only anchor response with no messages/blocks/closure materialization.
 */
export type ResolveContextClosureDetail = 'closure' | 'anchor'

export interface ResolveContextClosureRequest {
  topicId: string
  intent: ResolveContextClosureIntent
  contextCount?: number | null
  currentAnchorGroupKey?: string | null
  messageId?: string
  groupKey?: string
  sourceTopicId?: string
  sourceAnchorGroupKey?: string | null
  detail?: ResolveContextClosureDetail
}

/** Typed resolver closure metadata — same completeness as fetch-context-closure. */
export interface ResolveContextClosureMeta {
  /** Completeness is always 'context-closure'. */
  completeness: 'context-closure'
  /** Target topic that was read. */
  topicId: string
  /** Resolved anchor group key, or null when the target is empty. */
  anchorGroupKey: string | null
  /** First returned message ID, or null when no messages. */
  firstMessageId: string | null
  /** Last returned message ID, or null when no messages. */
  lastMessageId: string | null
  /** Number of messages returned. */
  returnedCount: number
  /** Total turn count in the target topic (authority-ordered context turns). */
  totalTurnCount: number
  /** Selected turn count from resolved anchor through newest (0 when empty). */
  selectedTurnCount: number
  /** Boundary divider message id, null iff selected===total (or empty) else firstMessageId. */
  boundaryMessageId: string | null
}

/** @see IpcChannel.ChatDb_ResolveContextClosure */
export interface ResolveContextClosureResponse {
  messages: JsonObject[]
  blocks: JsonObject[]
  closure: ResolveContextClosureMeta
  /** Resolved anchor group key (mirrors closure.anchorGroupKey). Null when empty. */
  resolvedAnchorGroupKey: string | null
  /** True when resolved anchor differs from (currentAnchorGroupKey ?? null). */
  changed: boolean
}

/**
 * Metadata-only anchor response for `detail: 'anchor'` establish reads.
 * Contains only the resolved anchor + changed flag; no messages, blocks,
 * or closure metadata are materialized, hydrated, or serialized.
 */
export interface ResolveContextClosureAnchorResponse {
  /** Resolved anchor group key. Null when the target has no context turns. */
  resolvedAnchorGroupKey: string | null
  /** True when resolved anchor differs from (currentAnchorGroupKey ?? null). */
  changed: boolean
}

/** Discriminated result for `chatdb:resolve-context-closure` (closure default, anchor metadata-only). */
export type ResolveContextClosureResult = ResolveContextClosureResponse | ResolveContextClosureAnchorResponse

// ---------------------------------------------------------------------------
// Whole-topic snapshot DTOs (one-shot topic exports / knowledge)
// ---------------------------------------------------------------------------

/** @see IpcChannel.ChatDb_FetchWholeTopicSnapshot — additive READ for explicit whole-topic snapshot. */
export interface FetchWholeTopicSnapshotRequest {
  topicId: string
}

/** Typed whole-topic snapshot metadata — distinct from window/answer-group/context-closure completeness. */
export interface FetchWholeTopicSnapshotMeta {
  /** Completeness is always 'whole-topic' — never masquerades as window/answer-group/context-closure. */
  completeness: 'whole-topic'
  /** Topic that was read. */
  topicId: string
  /** First returned message ID, or null when the topic has no messages. */
  firstMessageId: string | null
  /** Last returned message ID, or null when the topic has no messages. */
  lastMessageId: string | null
  /** Number of messages returned. */
  returnedCount: number
}

/** @see IpcChannel.ChatDb_FetchWholeTopicSnapshot */
export interface FetchWholeTopicSnapshotResponse {
  messages: JsonObject[]
  blocks: JsonObject[]
  snapshot: FetchWholeTopicSnapshotMeta
}

// ---------------------------------------------------------------------------
// Bounded naming/activity DTOs (automatic/manual naming + rate-limit authority)
// ---------------------------------------------------------------------------

/** @see IpcChannel.ChatDb_FetchTopicNamingContext — additive bounded READ for topic naming. */
export interface FetchTopicNamingContextRequest {
  topicId: string
}

/** Authority topic naming metadata carried by the naming-context read. */
export interface FetchTopicNamingContextTopic {
  id: string
  name: string | null
  isNameManuallyEdited: boolean | null
}

/** Typed naming-context metadata — distinct from window/answer-group/context-closure/whole-topic completeness. */
export interface FetchTopicNamingContextMeta {
  /** Completeness is always 'naming-context' — never masquerades as 'whole-topic'. */
  completeness: 'naming-context'
  /** Topic that was read. */
  topicId: string
  /** Authority first message ID, or null when the topic has no messages. */
  firstMessageId: string | null
  /** Authority last message ID, or null when the topic has no messages. */
  lastMessageId: string | null
  /** Number of latest messages returned (latestMessages length, at most 5). */
  returnedLatestCount: number
}

/** @see IpcChannel.ChatDb_FetchTopicNamingContext */
export interface FetchTopicNamingContextResponse {
  topic: FetchTopicNamingContextTopic
  /** Exact authority message count (independent of windowing). */
  messageCount: number
  /** Authority first message wire, or null when the topic has no messages. */
  firstMessage: JsonObject | null
  /** Authority latest at most 5 messages in ASC order. */
  latestMessages: JsonObject[]
  /** Blocks owned by the returned messages (first + latest, deduplicated). */
  blocks: JsonObject[]
  naming: FetchTopicNamingContextMeta
}

/** @see IpcChannel.ChatDb_FetchTopicActivity — additive bounded READ for rate-limit checks. */
export interface FetchTopicActivityRequest {
  topicId: string
}

/** Typed activity metadata — distinct from every message-carrying completeness. */
export interface FetchTopicActivityMeta {
  /** Completeness is always 'topic-activity'. */
  completeness: 'topic-activity'
  /** Topic that was read. */
  topicId: string
}

/** @see IpcChannel.ChatDb_FetchTopicActivity */
export interface FetchTopicActivityResponse {
  /** Exact authority message count (independent of windowing). */
  messageCount: number
  /** Authority latest message ID, or null when the topic has no messages. */
  latestMessageId: string | null
  /** Authority latest message createdAt, or null when empty/unset. */
  latestMessageCreatedAt: string | null
  activity: FetchTopicActivityMeta
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
  /** Authority catalog order from Main SQLite `topic_segments.sort_order` (dense 0..n-1). */
  sortOrder: number
  /** First message in authoritative ordered membership, null when empty. */
  firstMessageId: string | null
  /** Last message in authoritative ordered membership, null when empty. */
  lastMessageId: string | null
  /** Authoritative membership size; always equals messageIds.length. */
  messageCount: number
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

/**
 * @see IpcChannel.ChatDb_ReorderAnswerGroup
 *
 * Additive semantic reorder: the renderer supplies ONLY the desired answer-group
 * order plus a stable anchor from that group. Main resolves the complete answer
 * group in the same SQLite transaction (topic exists; anchor belongs to topic,
 * role assistant, non-empty askId; full group = same-topic assistant messages
 * with equal askId in sort_order ASC, id ASC) and persists the group-slots
 * permutation atomically. No content/blocks cross the wire.
 */
export interface ReorderAnswerGroupRequest {
  topicId: string
  /** Stable anchor belonging to the answer group (must be in orderedMessageIds). */
  anchorMessageId: string
  /** Desired complete ordered answer-group message IDs. */
  orderedMessageIds: string[]
}

/**
 * @see IpcChannel.ChatDb_ReorderAnswerGroup
 *
 * Main-authoritative answer-group reorder result. `orderedMessageIds` is the
 * Main final complete answer-group order (no content/blocks).
 */
export interface ReorderAnswerGroupResponse {
  topicId: string
  askId: string
  anchorMessageId: string
  /** Complete ordered answer-group message IDs in final authority order. */
  orderedMessageIds: string[]
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
  /** Current renderer topic name, persisted atomically with deletedAt. */
  name?: string | null
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
export interface HardDeleteTopicResponse extends FileCleanupResult {
  /** Exact topic IDs hard-deleted inside the authoritative transaction. Empty when none deleted. */
  deletedTopicIds: string[]
}

/** @see IpcChannel.ChatDb_PurgeExpiredTopics */
export interface PurgeExpiredTopicsRequest {
  /**
   * ISO 8601 timestamp. Topics with deletedAt < cutoffTimestamp are purged.
   * Generated by caller per LOCK-5113.
   */
  cutoffTimestamp: string
}

/** @see IpcChannel.ChatDb_PurgeExpiredTopics */
export interface PurgeExpiredTopicsResponse extends FileCleanupResult {
  /** Exact topic IDs purged inside the authoritative transaction. Empty when none purged. */
  deletedTopicIds: string[]
}

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
export interface EmptyTrashTopicsResponse extends FileCleanupResult {
  /** Exact topic IDs emptied inside the authoritative transaction. Empty when none deleted. */
  deletedTopicIds: string[]
}

export interface TransferTopicOwnershipRequest {
  topicId: string
  assistantId: string
}

export type TransferTopicOwnershipResponse = null

export interface ResetAssistantTopicsRequest {
  assistantId: string
  replacementTopicId: string
}

export interface ResetAssistantTopicsResponse {
  cleanup: FileCleanupResult
  replacementTopic: TopicWire
  /** Exact topic IDs hard-deleted inside the authoritative transaction (replacement excluded). Empty when none deleted. */
  deletedTopicIds: string[]
}

// ---------------------------------------------------------------------------
// Branch by stable anchor DTOs (S6.2c-1)
// ---------------------------------------------------------------------------

/** @see IpcChannel.ChatDb_BranchMessagesToTopic — Main-authoritative branch by stable anchor */
export interface BranchMessagesToTopicRequest {
  sourceTopicId: string
  targetTopicId: string
  anchorMessageId: string
  assistantId?: string
}

/** @see IpcChannel.ChatDb_BranchMessagesToTopic */
export interface BranchMessagesToTopicResponse {
  messages: JsonObject[]
  blocks: JsonObject[]
}

// ---------------------------------------------------------------------------
// S6.2c-2: insert after stable anchor (additive, Main-authoritative)
// ---------------------------------------------------------------------------

/**
 * @see IpcChannel.ChatDb_InsertMessagesAfterAnchor — Main-authoritative insert after stable anchor
 *
 * One atomic Main transaction:
 * - Validates topic/anchor membership (anchor must belong to topic).
 * - Resolves ordered authority messages sort_order ASC, id ASC.
 * - Advances past contiguous assistant messages with same non-empty ask_id as anchor
 *   (group-tail insertion) when anchor is assistant with askId.
 * - Inserts supplied entries atomically with existing dense-order logic.
 * No numeric insertIndex in request.
 */
export interface InsertMessagesAfterAnchorRequest {
  topicId: string
  afterMessageId: string
  /** Ordered entries to insert. Inserted after anchor/group tail in array order. */
  entries: MessageBlockEntry[]
}

/** @see IpcChannel.ChatDb_InsertMessagesAfterAnchor */
export type InsertMessagesAfterAnchorResponse = FileCleanupResult

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
  /** Complete message payloads to reset or insert. */
  messages: MessageBlockEntry[]
  /** Block IDs to delete as part of the reset. */
  blockIdsToDelete: string[]
}

/**
 * Strict model snapshot for semantic resend/regenerate commands.
 *
 * Carries the renderer `Model` wire shape as JSON-only data without importing
 * renderer types (shared stays dependency-free). All four fields are required
 * and non-empty on the wire: `id` is persisted as `modelId`, the full object
 * is round-tripped through the message `model` overflow slot. Extra JSON keys
 * (capabilities, pricing, etc.) are allowed and preserved verbatim.
 * No `undefined` own properties on the wire.
 */
export interface SemanticModelSnapshot extends JsonObject {
  /** Stable model id (also persisted as `modelId`). */
  id: string
  /** Provider id (renderer `Model.provider`). */
  provider: string
  /** Model display name (renderer `Model.name`). */
  name: string
  /** Model group (renderer `Model.group`). */
  group: string
}

/**
 * @see IpcChannel.ChatDb_ResendUserMessages
 *
 * Semantic resend: renderer supplies only stable IDs + assistant/model
 * snapshots. Main resolves the full assistant answer group (`askId==userId`)
 * in the same SQLite transaction from authority `listByTopic` order.
 */
export interface ResendUserMessagesRequest {
  topicId: string
  /** Stable user message being resent. */
  userMessageId: string
  /** Owning assistant for newly created group members. */
  assistantId: string
  /** Current assistant model snapshot (used for create + single-no-mention reset). */
  currentModel: SemanticModelSnapshot
}

/**
 * @see IpcChannel.ChatDb_RegenerateAssistantMessage
 *
 * Semantic regenerate: renderer supplies only the selected assistant stable
 * ID. Main validates selected/askId/authority user and resets only selected.
 * `currentModel` is optional: absent is legal and Main ignores it when the
 * selected message carries a truthy `modelId` (self-model path). Main
 * requires/uses it only when selected lacks `modelId`; that missing-model
 * case without `currentModel` fails closed (typed conflict).
 */
export interface RegenerateAssistantMessageRequest {
  topicId: string
  /** Stable assistant message to regenerate. */
  assistantMessageId: string
  /** Owning assistant (used only when selected has no truthy `modelId`). */
  assistantId: string
  /** Current assistant model snapshot (fallback when selected lacks `modelId`). Absent = self-model path. */
  currentModel?: SemanticModelSnapshot
}

/**
 * @see IpcChannel.ChatDb_ResendUserMessages
 * @see IpcChannel.ChatDb_RegenerateAssistantMessage
 *
 * Shared semantic resend/regenerate response. `executionMessages` is the
 * post-write wire (`MessageBlockEntry[]` in authority execution order, each
 * entry `blocks` normally `[]`); `attempts` maps exactly one entry per
 * execution message. `createdMessageIds` marks Main-created members so the
 * renderer can conditionally inject only when the authority user is currently
 * loaded. All wire values are JSON-safe with no `undefined` own properties.
 */
export interface SemanticResendResponse extends FileCleanupResult {
  /** Echo of the request topic. */
  topicId: string
  /** Authority user id (`askId` shared by all execution messages). */
  askId: string
  /** Authority user message wire (pre-reset, with `blocks` id array). */
  userMessage: JsonObject
  /** Authority user blocks wire (pre-reset, full block entities). */
  userBlocks: JsonObject[]
  /** Post-write execution entries in authority execution order. */
  executionMessages: MessageBlockEntry[]
  /** All removed original block IDs from reset existing messages. */
  removedBlockIds: string[]
  /** Subset of execution message IDs created by Main in this transaction. */
  createdMessageIds: string[]
  /** Per-message attempt mapping, exactly one entry per execution message. */
  attempts: ResendAttemptMapping[]
}

/**
 * @see IpcChannel.ChatDb_ResetMessagesForResend
 *
 * Existing file-cleanup facts plus the Main-authoritative per-message attempt
 * mapping (SYNC-DATA-055 issuer slice). Each mapping entry is strictly closed
 * (only messageId + attemptId). IpcChannel string unchanged.
 */
export interface ResetMessagesForResendResponse extends FileCleanupResult {
  /** Per-message attempt mapping, one entry per reset message (strictly closed entries). */
  attempts: ResendAttemptMapping[]
}

/** @see IpcChannel.ChatDb_DeleteMessagesWithSegments */
export interface DeleteMessagesWithSegmentsRequest {
  topicId: string
  messageIds: string[]
}

/** @see IpcChannel.ChatDb_DeleteMessagesWithSegments */
export type DeleteMessagesWithSegmentsResponse = FileCleanupResult

/** @see IpcChannel.ChatDb_DeleteMessagesWithDependents */
export interface DeleteMessagesWithDependentsRequest {
  topicId: string
  /** Stable root message IDs; non-empty, unique. Main expands user dependents. */
  messageIds: string[]
}

/**
 * One authority-generated restore entry: full message + owned blocks as JSON.
 */
export interface DeleteMessagesWithDependentsRestoreEntry {
  /** Full message entity as JSON. */
  message: JsonObject
  /** Full block entities owned by the message as JSON. */
  blocks: JsonObject[]
}

/**
 * One authority-generated ordered contiguous restore group.
 *
 * Groups partition the expanded deletion set into maximal contiguous runs in
 * pre-delete authority order (`sort_order ASC, id ASC`), so multiple
 * non-contiguous selections restore without reordering. `positionIndex` is
 * the pre-delete authority index of the group's first entry (fallback when
 * the anchor is gone); `anchorMessageId` is the first surviving message
 * after the run (null when the run reaches the topic tail).
 */
export interface DeleteMessagesWithDependentsRestoreGroup {
  entries: DeleteMessagesWithDependentsRestoreEntry[]
  positionIndex: number
  anchorMessageId: string | null
}

/**
 * @see IpcChannel.ChatDb_DeleteMessagesWithDependents
 *
 * Semantic plural deletion resolved by Main authority. Extends the
 * file-cleanup facts with the exact expanded deletion set plus the pre/post
 * user group keys, the post-delete segment catalog, authority-generated
 * restore groups, and pre-delete affected segment snapshots, so the renderer
 * can converge loaded projection, anchor, segments, and undo without reading
 * a window-derived cascade.
 */
export interface DeleteMessagesWithDependentsResponse extends FileCleanupResult {
  /** Actual expanded message IDs deleted (authority order: sort_order ASC, id ASC). */
  deletedMessageIds: string[]
  /** Block IDs owned by the deleted messages (ordered by message then block order). */
  deletedBlockIds: string[]
  /** Stable user message IDs before deletion (authority order). */
  previousUserMessageIds: string[]
  /** Stable user message IDs after deletion (authority order). */
  remainingUserMessageIds: string[]
  /** Complete topic segment catalog after deletion. */
  segments: SegmentWire[]
  /** Authority-generated ordered contiguous restore groups for undo. */
  restoreGroups: DeleteMessagesWithDependentsRestoreGroup[]
  /** Pre-delete full snapshots of segments intersecting the deleted set. */
  segmentSnapshots: SegmentWire[]
}

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

// ---------------------------------------------------------------------------
// Insert message groups DTOs (stable insertion intents, Main-authoritative)
// ---------------------------------------------------------------------------

/**
 * Stable insertion intent for one message group.
 *
 * - `after-group-tail`: insert after the complete logical group containing
 *   `messageId` (user anchor advances through all assistants whose askId
 *   equals the user ID; assistant anchor advances through all assistants
 *   with its askId, including non-contiguous members).
 * - `before-message`: insert immediately before the surviving `messageId`.
 * - `topic-tail`: append at the topic tail.
 */
export type InsertMessageGroupIntent =
  | { kind: 'after-group-tail'; messageId: string }
  | { kind: 'before-message'; messageId: string }
  | { kind: 'topic-tail' }

/**
 * One ordered group for `insert-message-groups`: entries plus exactly one
 * stable insertion intent.
 */
export interface InsertMessageGroup {
  /** Ordered entries to insert. Inserted at the resolved intent in array order. */
  entries: MessageBlockEntry[]
  /** Exactly one stable insertion intent (discriminated union). */
  intent: InsertMessageGroupIntent
}

/** @see IpcChannel.ChatDb_InsertMessageGroups */
export interface InsertMessageGroupsRequest {
  topicId: string
  /** Ordered groups to insert atomically in array order. */
  groups: InsertMessageGroup[]
}

/** @see IpcChannel.ChatDb_InsertMessageGroups */
export type InsertMessageGroupsResponse = FileCleanupResult

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
  'chatdb:fetch-messages-window': { request: FetchMessagesWindowRequest; response: FetchMessagesWindowResponse }
  'chatdb:get-raw-topic': { request: GetRawTopicRequest; response: GetRawTopicResponse }
  'chatdb:topic-exists': { request: TopicExistsRequest; response: boolean }
  'chatdb:ensure-topic': { request: EnsureTopicRequest; response: null }
  'chatdb:append-message': { request: AppendMessageRequest; response: null }
  'chatdb:update-message': { request: UpdateMessageRequest; response: null }
  'chatdb:update-message-and-blocks': { request: UpdateMessageAndBlocksRequest; response: FileCleanupResult }
  // Cross-process authority answer selection (Main-resolved full group)
  'chatdb:select-answer-message': { request: SelectAnswerMessageRequest; response: SelectAnswerMessageResponse }
  'chatdb:delete-message': { request: DeleteMessageRequest; response: null }
  'chatdb:delete-messages': { request: DeleteMessagesRequest; response: null }
  'chatdb:update-blocks': { request: UpdateBlocksRequest; response: null }
  'chatdb:update-single-block': { request: UpdateSingleBlockRequest; response: null }
  'chatdb:bulk-add-blocks': { request: BulkAddBlocksRequest; response: null }
  'chatdb:delete-blocks': { request: DeleteBlocksRequest; response: null }
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
  // Answer-group authority reorder (additive semantic command)
  'chatdb:reorder-answer-group': { request: ReorderAnswerGroupRequest; response: ReorderAnswerGroupResponse }
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
  'chatdb:transfer-topic-ownership': {
    request: TransferTopicOwnershipRequest
    response: TransferTopicOwnershipResponse
  }
  'chatdb:reset-assistant-topics': { request: ResetAssistantTopicsRequest; response: ResetAssistantTopicsResponse }
  // S6.2c-1: Main-authoritative branch by stable anchor
  'chatdb:branch-messages-to-topic': {
    request: BranchMessagesToTopicRequest
    response: BranchMessagesToTopicResponse
  }
  // S6.2c-2: Main-authoritative insert after stable anchor
  'chatdb:insert-messages-after-anchor': {
    request: InsertMessagesAfterAnchorRequest
    response: InsertMessagesAfterAnchorResponse
  }
  // Phase 5.1B: compound mutations
  'chatdb:clone-messages-to-topic': {
    request: CloneMessagesToTopicRequest
    response: CloneMessagesToTopicResponse
  }
  'chatdb:reset-messages-for-resend': {
    request: ResetMessagesForResendRequest
    response: ResetMessagesForResendResponse
  }
  'chatdb:resend-user-messages': {
    request: ResendUserMessagesRequest
    response: SemanticResendResponse
  }
  'chatdb:regenerate-assistant-message': {
    request: RegenerateAssistantMessageRequest
    response: SemanticResendResponse
  }
  'chatdb:delete-messages-with-segments': {
    request: DeleteMessagesWithSegmentsRequest
    response: DeleteMessagesWithSegmentsResponse
  }
  'chatdb:delete-messages-with-dependents': {
    request: DeleteMessagesWithDependentsRequest
    response: DeleteMessagesWithDependentsResponse
  }
  'chatdb:paste-messages-to-topic': {
    request: PasteMessagesToTopicRequest
    response: PasteMessagesToTopicResponse
  }
  'chatdb:insert-message-groups': {
    request: InsertMessageGroupsRequest
    response: InsertMessageGroupsResponse
  }
  // Phase 5.1B-2: search
  'chatdb:search-messages': {
    request: SearchMessagesRequest
    response: SearchMessagesResponse
  }
  // S6.2b R-05: authoritative answer-group READ
  'chatdb:fetch-answer-group': { request: FetchAnswerGroupRequest; response: FetchAnswerGroupResponse }
  // S6.3 R-06: authoritative context closure READ (anchor through newest)
  'chatdb:fetch-context-closure': { request: FetchContextClosureRequest; response: FetchContextClosureResponse }
  // Authority context-closure resolver (additive; Main never persists settings)
  'chatdb:resolve-context-closure': {
    request: ResolveContextClosureRequest
    response: ResolveContextClosureResult
  }
  // One-shot whole-topic snapshot READ (topic exports / knowledge; short-lived, no Redux residency)
  'chatdb:fetch-whole-topic-snapshot': {
    request: FetchWholeTopicSnapshotRequest
    response: FetchWholeTopicSnapshotResponse
  }
  // Bounded naming/activity authority reads (naming + rate-limit; never whole-topic)
  'chatdb:fetch-topic-naming-context': {
    request: FetchTopicNamingContextRequest
    response: FetchTopicNamingContextResponse
  }
  'chatdb:fetch-topic-activity': { request: FetchTopicActivityRequest; response: FetchTopicActivityResponse }
}

// ---------------------------------------------------------------------------
// Topic deletion event — Main → all renderers (Phase 5 authoritative)
// ---------------------------------------------------------------------------

/**
 * Authoritative Main → renderer push event for permanent deletions.
 * Carries the exact topic IDs that were hard-deleted in the committed
 * Main transaction. Never guessed, never partial. Empty array is not
 * broadcast (no-op).
 */
export interface TopicDeletionEvent {
  /** Exact topic IDs hard-deleted inside the authoritative transaction. */
  deletedTopicIds: string[]
}

/** All valid ChatDb command channel strings. */
export type ChatDbChannel = keyof ChatDbCommands

/** Extract request type for a given channel. */
export type ChatDbRequest<C extends ChatDbChannel> = ChatDbCommands[C]['request']

/** Extract response type for a given channel. */
export type ChatDbResponse<C extends ChatDbChannel> = ChatDbCommands[C]['response']
