import type { Message, MessageBlock } from '@renderer/types/newMessage'
import type {
  DeleteBranchResponse,
  DeleteMessagesWithDependentsResponse,
  FetchAnswerGroupResponse,
  FetchClipboardGroupsRequest,
  FetchClipboardGroupsResponse,
  FetchContextClosureRequest,
  FetchContextClosureResponse,
  FetchMessagesWindowRequest,
  FetchMessagesWindowResponse,
  FetchTopicActivityResponse,
  FetchTopicNamingContextResponse,
  FetchWholeTopicSnapshotResponse,
  FileCleanupResult,
  InsertMessageGroup,
  ListBranchesResponse,
  MessageBlockEntry,
  RegenerateAssistantMessageRequest,
  RenameBranchResponse,
  ReorderAnswerGroupResponse,
  ResendUserMessagesRequest,
  ResolveContextClosureRequest,
  ResolveContextClosureResult,
  SelectAnswerMessageResponse,
  SemanticResendResponse,
  StreamWriteDiagnostics,
  TopicBranchWire
} from '@shared/chatDb'

import type { SendDiagnosticsContext } from './sendTimingDiagnostics'

export type { TopicBranchWire }

/**
 * Route owner for branch-aware reads/writes: null/undefined = main route,
 * non-null = that branch's effective route within the same logical topic.
 * Switching branches never changes the active topic.
 */
export type BranchRoute = string | null | undefined

/**
 * Message exchange data structure for persisting user-assistant conversations
 */
export interface MessageExchange {
  user?: {
    message: Message
    blocks: MessageBlock[]
  }
  assistant?: {
    message: Message
    blocks: MessageBlock[]
  }
}

/**
 * Unified interface for message data operations
 * Implementations can be backed by Dexie, IPC, or other storage mechanisms
 */
export interface MessageDataSource {
  // ============ Read Operations ============
  /**
   * Fetch all messages and blocks for one route (topic + branch).
   * `branchId` null/undefined = main route.
   */
  fetchMessages(
    topicId: string,
    forceReload?: boolean,
    branchId?: BranchRoute
  ): Promise<{
    messages: Message[]
    blocks: MessageBlock[]
  }>

  /**
   * Get raw topic data (just id and messages)
   */
  getRawTopic(topicId: string): Promise<{ id: string; messages: Message[] } | undefined>

  // ============ Write Operations ============
  /**
   * Append a single message with its blocks to one route.
   *
   * `sendContext` is optional diagnostic-only correlation metadata (LOCK-004):
   * when supplied by the ordinary send path, the append consumes the next
   * ordinal from that send's own context. It never affects persistence.
   */
  appendMessage(
    topicId: string,
    message: Message,
    blocks: MessageBlock[],
    insertIndex?: number,
    sendContext?: SendDiagnosticsContext,
    resendAttemptId?: string,
    branchId?: BranchRoute
  ): Promise<void>

  /**
   * Update an existing message in one route
   */
  updateMessage(
    topicId: string,
    messageId: string,
    updates: Partial<Message>,
    resendAttemptId?: string,
    branchId?: BranchRoute
  ): Promise<void>

  /**
   * Update existing message and its blocks in one route.
   * Returns FileCleanupResult when blocks are deleted, for post-commit
   * consumption by the caller.
   */
  updateMessageAndBlocks(
    topicId: string,
    messageUpdates: Partial<Message> & Pick<Message, 'id'>,
    blocksToUpdate: MessageBlock[],
    blockIdsToDelete?: string[],
    resendAttemptId?: string,
    branchId?: BranchRoute
  ): Promise<FileCleanupResult>

  /**
   * Cross-process authority answer selection in one route.
   *
   * The renderer supplies ONLY the selected message ID; Main resolves the
   * complete answer group in the same SQLite transaction and persists
   * `foldSelected` atomically. Returns the authoritative group for a
   * loaded-projection intersection commit. Dispatches `updateTopicUpdatedAt`
   * exactly once after success (the thunk must NOT dispatch it again).
   */
  selectAnswerMessage(
    topicId: string,
    selectedMessageId: string,
    branchId?: BranchRoute
  ): Promise<SelectAnswerMessageResponse>

  /**
   * Answer-group authority reorder in one route (additive semantic command).
   *
   * The renderer supplies ONLY the stable anchor + desired group order; Main
   * resolves the full group and persists the authority slots permutation
   * atomically. Returns the authoritative group order for a
   * loaded-projection intersection commit. Dispatches `updateTopicUpdatedAt`
   * exactly once after success (the thunk must NOT dispatch it again).
   */
  reorderAnswerGroup(
    topicId: string,
    anchorMessageId: string,
    orderedMessageIds: string[],
    branchId?: BranchRoute
  ): Promise<ReorderAnswerGroupResponse>

  /**
   * Semantic plural deletion with Main-resolved dependents in one route.
   *
   * The renderer supplies ONLY stable root IDs; Main expands user dependents
   * (user + same-askId assistants, or single non-user), deletes in one
   * transaction, and returns the exact expanded deletion set plus block IDs,
   * pre/post user group keys, the post-delete segment catalog, and the full
   * authority undo snapshot (restore groups + affected segment snapshots).
   * Dispatches `updateTopicUpdatedAt` exactly once after success.
   */
  deleteMessagesWithDependents(
    topicId: string,
    messageIds: string[],
    branchId?: BranchRoute
  ): Promise<DeleteMessagesWithDependentsResponse>

  /**
   * Semantic resend by stable user ID (Main-resolved full group).
   *
   * Renderer supplies only stable IDs + assistant/model snapshots; Main
   * resolves the full answer group in one transaction and returns the
   * authority user snapshot, post-write execution entries, removed block IDs,
   * created IDs, cleanup facts, and 1:1 attempt mapping. Dispatches
   * `updateTopicUpdatedAt` exactly once after success.
   */
  resendUserMessages?(request: ResendUserMessagesRequest): Promise<SemanticResendResponse>

  /**
   * Semantic regenerate by stable assistant ID (Main-resolved single reset).
   * Same response shape as resend; exactly one execution entry.
   */
  regenerateAssistantMessage?(request: RegenerateAssistantMessageRequest): Promise<SemanticResendResponse>

  /**
   * Delete a single message and its blocks in one route
   */
  deleteMessage(topicId: string, messageId: string, branchId?: BranchRoute): Promise<void>

  /**
   * Delete multiple messages and their blocks in one route
   */
  deleteMessages(topicId: string, messageIds: string[], branchId?: BranchRoute): Promise<void>

  /**
   * Atomically insert an ordered batch of message+block entries at a
   * position in one Main SQLite transaction (PERF-100 batch paste).
   *
   * Entries are inserted at `insertIndex` (zero-based; absent = append at
   * end) in array order within the addressed route owner's rows. Existing
   * messages keep their position and only receive a metadata patch. Returns
   * the aggregate FileCleanupResult.
   */
  pasteMessagesToTopic(
    topicId: string,
    entries: MessageBlockEntry[],
    insertIndex?: number,
    branchId?: BranchRoute
  ): Promise<FileCleanupResult>

  // ============ Block Operations ============
  /**
   * Update multiple blocks
   *
   * `streamDiag` is optional measurement-only correlation metadata
   * (PERF-STREAM-ATTR-001); never affects persistence.
   */
  updateBlocks(blocks: MessageBlock[], streamDiag?: StreamWriteDiagnostics): Promise<void>

  /**
   * Update single block
   *
   * `streamDiag` is optional measurement-only correlation metadata
   * (PERF-STREAM-ATTR-001); never affects persistence.
   */
  updateSingleBlock?(
    blockId: string,
    updates: Partial<MessageBlock>,
    streamDiag?: StreamWriteDiagnostics
  ): Promise<void>

  /**
   * Bulk add blocks (for cloning operations)
   */
  bulkAddBlocks?(blocks: MessageBlock[]): Promise<void>

  /**
   * Delete multiple blocks
   */
  deleteBlocks(blockIds: string[]): Promise<FileCleanupResult>

  // ============ Branch by stable anchor (S6.2c-1) ============
  /**
   * Branch messages up to an anchor (inclusive) from source to target atomically in Main.
   * Validates source exists and anchor belongs to source; ensures target; clones prefix with fresh IDs,
   * remapping askId exactly as renderer branch behavior. Returns actual cloned wire for projection.
   * Missing/cross-topic anchor fails with no partial target writes.
   */
  branchMessagesToTopic?(
    sourceTopicId: string,
    targetTopicId: string,
    anchorMessageId: string,
    assistantId?: string
  ): Promise<{ messages: Message[]; blocks: MessageBlock[] }>

  // ============ Topic-internal branches (local-only, no prefix cloning) ============
  /**
   * Create one internal branch node inside a logical topic from a parent
   * route anchor. The anchor may itself be inherited
   * (branch-from-inherited). No prefix cloning, no sync intent. Returns the
   * created node plus the effective wire (shared prefix + empty suffix).
   * This is the ONLY true-branch creation method.
   */
  createBranch?(
    topicId: string,
    parentBranchId: BranchRoute,
    anchorMessageId: string,
    name?: string
  ): Promise<{
    branch: TopicBranchWire
    messages: Message[]
    blocks: MessageBlock[]
  }>

  /**
   * List all branch nodes of one logical topic in (createdAt, id) order.
   * Empty when never branched. Pure read.
   */
  listBranches?(topicId: string): Promise<ListBranchesResponse>

  /**
   * Rename a branch node (name-only). Topic rename stays logical.
   */
  renameBranch?(topicId: string, branchId: string, name: string): Promise<RenameBranchResponse>

  /**
   * Delete one branch subtree (selected branch + descendants + only their
   * owned messages/blocks/file references). Shared prefixes and siblings
   * survive.
   */
  deleteBranch?(topicId: string, branchId: string): Promise<DeleteBranchResponse>

  // ============ Insert after stable anchor (S6.2c-2) ============
  /**
   * Insert entries after a stable anchor (group-tail aware) atomically in Main.
   * Validates anchor membership inside the addressed route, resolves ordered
   * authority order (sort_order ASC, id ASC) of the route owner, advances
   * past contiguous assistant group tail when anchor is assistant with
   * askId, then inserts entries with dense-order logic. An inherited anchor
   * lands at the owner tail. No numeric insertIndex in request. Fail closed
   * with no partial writes. Dispatches updateTopicUpdatedAt exactly once
   * after success.
   */
  insertMessagesAfterAnchor?(
    topicId: string,
    afterMessageId: string,
    entries: MessageBlockEntry[],
    branchId?: BranchRoute
  ): Promise<FileCleanupResult>

  /**
   * Insert message groups with stable intents atomically in Main.
   * The renderer supplies only stable intents (after-group-tail /
   * before-message / topic-tail); Main validates anchors against the
   * addressed route order and inserts all groups atomically. Dispatches
   * updateTopicUpdatedAt exactly once after success.
   */
  insertMessageGroups?(
    topicId: string,
    groups: InsertMessageGroup[],
    branchId?: BranchRoute
  ): Promise<FileCleanupResult>

  // ============ Batch Operations ============
  /**
   * Check if topic exists
   */
  topicExists(topicId: string): Promise<boolean>

  /**
   * Create or ensure topic exists
   */
  ensureTopic(topicId: string, assistantId?: string, name?: string | null): Promise<void>

  /**
   * Typed windowed read — R-02 latest / R-03 around (S6.1).
   * Returns authoritative window with complete message+block groups and typed metadata.
   * Missing topic / missing anchor → throws ChatDbResultError (ERR_NOT_FOUND).
   */
  fetchMessagesWindow?(request: FetchMessagesWindowRequest): Promise<FetchMessagesWindowResponse>

  /**
   * Authoritative answer-group READ — S6.2b R-05, route-scoped.
   * Returns complete ordered answer-group for an anchor assistant message
   * inside the addressed route. Missing topic/anchor/cross-topic/anchor
   * without usable askId → throws ChatDbResultError (NOT_FOUND).
   * No mutation, no timestamp dispatch.
   */
  fetchAnswerGroup?(topicId: string, anchorMessageId: string, branchId?: BranchRoute): Promise<FetchAnswerGroupResponse>

  /**
   * Authoritative context closure READ — S6.3 R-06.
   * Returns anchor-through-newest slice for a renderer-owned anchorGroupKey.
   * Missing topic/unresolvable anchor → throws ChatDbResultError (NOT_FOUND).
   * Distinct completeness 'context-closure', no cap, no hasMore.
   */
  fetchContextClosure?(request: FetchContextClosureRequest): Promise<FetchContextClosureResponse>

  /**
   * Authority context-closure resolver — establish / reanchor-default / move / inherit.
   * One Main transaction resolves intent against full ordered turns and returns
   * the same-snapshot closure. Caller-local only (never normal Redux); the
   * caller persists resolvedAnchorGroupKey with stale guards (remove on null).
   * Missing topic/target → ChatDbResultError (NOT_FOUND); ignored move roles → validation.
   * `detail: 'anchor'` (every intent) returns the metadata-only anchor response.
   */
  resolveContextClosure?(request: ResolveContextClosureRequest): Promise<ResolveContextClosureResult>

  /**
   * Explicit short-lived route snapshot for one-shot topic exports /
   * knowledge jobs. Returns the full ordered route with reconstructed block
   * relations and strict whole-topic metadata. Converts wires to domain
   * Message[]/MessageBlock[] and dispatches nothing (caller-local only).
   * Sidebar export/copy stays main-route unless the current active branch
   * is explicitly used from in-chat actions. Missing topic → throws
   * ChatDbResultError (NOT_FOUND).
   */
  fetchWholeTopicSnapshot?(
    topicId: string,
    branchId?: BranchRoute
  ): Promise<{
    messages: Message[]
    blocks: MessageBlock[]
    snapshot: FetchWholeTopicSnapshotResponse['snapshot']
  }>

  /**
   * Group-scoped clipboard READ for copy/cut.
   * Resolves stable clipboard group keys (same values as UI `selectedGroupIds`)
   * to complete messages/blocks plus per-group authority positions in one Main
   * transaction — never a whole-topic snapshot. Missing topic throws
   * ChatDbResultError (NOT_FOUND); zero resolved groups succeeds empty.
   */
  fetchClipboardGroups?(request: FetchClipboardGroupsRequest): Promise<FetchClipboardGroupsResponse>

  /**
   * Bounded naming-context READ for automatic/manual naming, route-scoped.
   * Returns authority naming metadata, exact count, first message (or null),
   * latest at most 5 messages in authority ASC order, and blocks for those
   * returned messages only. Missing topic → throws ChatDbResultError (NOT_FOUND).
   */
  fetchTopicNamingContext?(
    topicId: string,
    branchId?: BranchRoute
  ): Promise<{
    topic: FetchTopicNamingContextResponse['topic']
    messageCount: number
    firstMessage: Message | null
    latestMessages: Message[]
    blocks: MessageBlock[]
    naming: FetchTopicNamingContextResponse['naming']
  }>

  /**
   * Bounded topic activity READ for rate-limit checks, route-scoped.
   * Returns exact count plus latest message id/timestamp; no messages/blocks.
   * Missing topic → throws ChatDbResultError (NOT_FOUND).
   */
  fetchTopicActivity?(topicId: string, branchId?: BranchRoute): Promise<FetchTopicActivityResponse>

  // ============ File Operations (Optional) ============

  /**
   * Update file reference count
   * @param fileId - The file ID to update
   * @param delta - The change in reference count (positive or negative)
   * @param deleteIfZero - Whether to delete the file when count reaches 0
   */
  updateFileCount?(fileId: string, delta: number, deleteIfZero?: boolean): Promise<void>

  /**
   * Update multiple file reference counts
   */
  updateFileCounts?(files: Array<{ id: string; delta: number; deleteIfZero?: boolean }>): Promise<void>
}
