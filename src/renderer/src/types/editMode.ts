import type {
  BranchDeleteSnapshot,
  BranchHistoryRow,
  BranchMoveSnapshot,
  InheritanceBoundarySnapshot,
  InsertMessageGroupIntent
} from '@shared/chatDb'

import type { Message, MessageBlock } from './newMessage'
import type { TopicSegment } from './topicSegment'

// 剪贴板模式
export type ClipboardMode = 'copy' | 'cut'

// 剪贴板中的单个消息组快照
export interface ClipboardItem {
  /** 原始消息组的 askId */
  originalAskId: string
  /** 消息组中的消息快照（深拷贝的 Message 数组） */
  messages: Message[]
  /** 消息组中每个消息对应的 blocks 快照（深拷贝） */
  blocks: MessageBlock[]
  /** 在源 topic 中的排序位置（messageIdsByTopic 中的 index） */
  positionIndex: number
}

/**
 * Snapshot of a fully-selected TopicSegment captured at cut/copy time.
 * Used to rebuild segments on paste via oldId→newId mapping.
 */
export interface ClipboardSegmentSnapshot {
  originalSegmentId: string
  name: string
  color?: string
  /**
   * Folded state of the source group at cut/copy time. Carried so a pasted
   * group keeps the same request-context semantics instead of silently
   * re-enabling folded content.
   */
  folded?: boolean
  originalMessageIds: string[]
}

// 剪贴板 state
/**
 * Cut-time source projection eligibility for a staged cut.
 *
 * Captured once at `cutMessages` time AFTER the edit-selection gate proves
 * the source selection writable through the active loaded route. It records
 * WHICH source rows were loaded (eligible for immediate Redux visibility on
 * undo) — never the authority restore payload itself. Main remains the
 * source of full messages/blocks/anchors at deletion time.
 *
 * `sourceBranchId` uses the same null = main encoding as the staged route and
 * must exactly equal the staged `sourceBranchId` (null vs undefined stays
 * distinct; undefined is legacy/missing and must fail closed).
 */
export interface StagedCutSourceProjection {
  sourceTopicId: string
  sourceBranchId: string | null
  loadedMessageIds: string[]
}

export interface ClipboardState {
  mode: ClipboardMode | null
  items: ClipboardItem[]
  sourceTopicId: string | null
  /**
   * Staged source route captured at cut time (null = main route).
   * Cut-only authority provenance: paste addresses the Main source delete
   * with this route without rerequiring projection capability. Undefined is
   * legacy/missing provenance and must fail closed before any paste write.
   */
  sourceBranchId: string | null
  timestamp: number
  /** Snapshots of fully-selected segments for segment reconstruction on paste */
  segmentSnapshots: ClipboardSegmentSnapshot[]
  /**
   * Cut-time source projection eligibility (cut mode only). Undefined is
   * legacy/missing provenance and must fail closed before any paste write;
   * null is never used (copy mode leaves this undefined). The object route
   * must match `sourceBranchId` exactly when present.
   */
  sourceProjection?: StagedCutSourceProjection | null
}

// 编辑模式 state
export interface EditModeState {
  enabled: boolean
  selectedGroupIds: string[] // askId 列表
  lastSelectedIndex: number | null // 当前已加载组顺序中的 Shift 锚点索引（兼容派生）
  focusedIndex: number | null // 当前已加载组顺序中的活动端点索引（兼容派生）
  anchorGroupId?: string | null // 稳定 Shift 锚点 askId
  focusedGroupId?: string | null // 稳定活动端点 askId
  isProcessing: boolean // 全局操作锁
}

/**
 * Direction of the bounded message-window page an edit-selection edge needs.
 * `older` is toward earlier messages (visual up), `newer` toward later ones.
 */
export type EditSelectionBoundaryDirection = 'older' | 'newer'

/**
 * Selection-boundary page request provided by the chat viewport owner.
 *
 * Resolves `true` once an ordinary bounded page attempt for that direction
 * settled (its window commit or its cancellation) and `false` when no attempt
 * was started — no history left, one already in flight, or another owner holds
 * the viewport. Repeat key auto-repeat must therefore be safe to issue: a
 * request never starts a second copy of an in-flight read.
 */
export type EditSelectionBoundaryPageRequest = (direction: EditSelectionBoundaryDirection) => Promise<boolean>

/**
 * Snapshot of a TopicSegment before message deletion.
 * Used to restore segment membership when undoing a delete.
 */
export type SegmentSnapshot = TopicSegment

/** Per-group position anchor for restoring non-contiguous selections */
export interface GroupAnchor {
  /** Messages in this group (full snapshots for undo) */
  messages: Message[]
  /** Blocks for messages in this group */
  blocks: MessageBlock[]
  /** Original position index in the topic */
  positionIndex: number
  /** First non-deleted message after this group (null if at end) */
  anchorMessageId: string | null
  /**
   * Ordered intersection of this authority restore group with the pre-delete
   * loaded projection. Renderer-only: drives the Redux projection subset on
   * undo. The full `messages`/`blocks` above remain the Main authority
   * restore payload. Empty means inject nothing even for topic-tail.
   */
  loadedMessageIds: string[]
}

// 撤销操作类型
export type UndoActionType =
  | 'paste'
  | 'delete'
  | 'cut_paste'
  | 'branch_create'
  | 'branch_rename'
  | 'branch_move'
  | 'branch_delete'

/**
 * Fields every history action carries: identity, kind, time, and the topic
 * whose authority the operation affects. Kind-specific payloads live on the
 * concrete members, so a branch action never has to satisfy paste-only fields.
 */
interface BaseUndoAction {
  id: string
  type: UndoActionType
  timestamp: number
  /** Topic where the operation's primary effect occurs */
  targetTopicId: string
}

/** History fields shared by message-content operations (paste/delete/cut). */
interface MessageContentUndoAction extends BaseUndoAction {
  /** IDs of messages inserted by this operation (for undo removal / redo re-insert) */
  insertedMessageIds: string[]
  /** Snapshot of inserted messages and blocks (for redo) */
  pastedMessagesSnapshot: Message[]
  pastedBlocksSnapshot: MessageBlock[]
  fileReferenceDeltas: Array<{ fileId: string; delta: number }>
}

export interface DeleteUndoAction extends MessageContentUndoAction {
  type: 'delete'
  /**
   * Original stable root IDs supplied to the semantic delete command.
   * Redo re-issues these roots (Main re-expands user dependents); the
   * expanded `insertedMessageIds` below must never masquerade as user intent.
   */
  rootMessageIds: string[]
  /** Per-group anchors for restoring deleted groups to their original positions */
  groupAnchors: GroupAnchor[]
  /** Snapshots of affected segments before deletion (for undo segment restoration) */
  segmentSnapshots: SegmentSnapshot[]
  /**
   * The route this delete actually addressed (`null` = main route), recorded
   * from the authority execution. Undo restores the deleted rows onto it, so a
   * branch switch between delete and undo can never retarget the restore to
   * another owner. Absent = legacy in-memory action without the fact; those
   * retain the previous live-route behavior only.
   */
  deletedBranchId?: string | null
  /**
   * Inheritance boundaries (branch anchors, cross-topic reference endpoints)
   * that this delete moved in Main. Undo reverts exactly these, in the same
   * Main transaction as the message restore; absent = legacy action with no
   * recorded boundary facts.
   */
  boundarySnapshots?: InheritanceBoundarySnapshot[]
}

export interface PasteUndoAction extends MessageContentUndoAction {
  type: 'paste'
  /**
   * Route the paste actually wrote into (`null` = main route), captured from
   * the authority execution. Undo/redo address that route instead of whatever
   * route happens to be active later, so a branch switch between paste and
   * undo can never retarget the removal or the re-insertion. Absent = legacy
   * in-memory action without the fact (previous live-route behavior).
   */
  targetBranchId?: string | null
  /** Anchor message after the paste region (for redo positioning) */
  targetAnchorMessageId: string | null
  /** Fallback position index for redo */
  targetInsertPositionIndex: number
  /** Stable insertion intent from the original paste (authority for redo DB). */
  targetInsertIntent?: InsertMessageGroupIntent
  /** Snapshots of segments created in target topic (for undo delete / redo restore) */
  targetSegmentSnapshots: TopicSegment[]
}

export interface CutPasteUndoAction extends MessageContentUndoAction {
  type: 'cut_paste'
  /** Anchor message after the paste region in target topic (for redo paste positioning) */
  targetAnchorMessageId: string | null
  /** Fallback position index in target topic for redo */
  targetInsertPositionIndex: number
  /** Stable insertion intent from the original paste (authority for redo DB). */
  targetInsertIntent?: InsertMessageGroupIntent
  /** Source topic ID */
  sourceTopicId: string
  /**
   * Route-bound authority provenance for staged-cut actions (null = main).
   * New actions always carry both; legacy in-memory actions omit them and
   * retain the previous live-route behavior only where safe. New actions with
   * missing fields must fail closed before any write (no silent live fallback).
   */
  sourceBranchId?: string | null
  targetBranchId?: string | null
  /**
   * Stable member roots sent to the semantic delete at paste time: all
   * complete clipboard member message IDs (deduped, authority order).
   * Redo re-issues exactly these roots (Main re-expands user dependents).
   * Optional for backward compatibility with legacy in-memory actions;
   * redo fails closed when source restoration is needed but roots are absent.
   */
  sourceRootIds?: string[]
  /**
   * Cut-time source projection eligibility propagated from the clipboard
   * lifecycle into the undo payload. Redo re-issues the staged source delete
   * with this eligibility (never the live target projection). Undefined is
   * legacy/missing; new staged actions must carry it or fail closed.
   */
  sourceProjection?: StagedCutSourceProjection | null
  /** Per-group anchors for restoring source groups to their original positions */
  sourceGroupAnchors: GroupAnchor[]
  /** Snapshots of affected source segments before deletion (for undo source segment restoration) */
  sourceSegmentSnapshots: SegmentSnapshot[]
  /**
   * Inheritance boundaries the staged source delete moved in Main (branch
   * anchors, cross-topic reference endpoints of the source topic). Undo
   * reverts exactly these in the same Main transaction as the source restore;
   * absent = legacy action with no recorded boundary facts.
   */
  sourceBoundarySnapshots?: InheritanceBoundarySnapshot[]
  /** Snapshots of segments created in target topic (for undo delete / redo restore) */
  targetSegmentSnapshots: TopicSegment[]
}

/**
 * One recorded branch-creation: undo removes the created branch (only while it
 * is still the empty leaf this action produced), redo re-inserts the same row.
 */
export interface BranchCreateUndoAction extends BaseUndoAction {
  type: 'branch_create'
  /** The persisted branch row Main created, replayed back verbatim. */
  branch: BranchHistoryRow
}

/** One recorded branch rename: undo/redo swap the recorded names. */
export interface BranchRenameUndoAction extends BaseUndoAction {
  type: 'branch_rename'
  branchId: string
  beforeName: string | null
  afterName: string | null
}

/**
 * One recorded move of whole turns to a new child branch. The snapshot is
 * Main's own pre/post authority payload (source order before the move, moved
 * message IDs, ancestry that followed its anchor, created branch row).
 */
export interface BranchMoveUndoAction extends BaseUndoAction {
  type: 'branch_move'
  snapshot: BranchMoveSnapshot
}

/**
 * One recorded subtree delete. The snapshot carries every row the delete
 * removed plus the inheritance boundaries it advanced, so undo restores the
 * whole subtree and redo re-runs the same deterministic delete.
 */
export interface BranchDeleteUndoAction extends BaseUndoAction {
  type: 'branch_delete'
  rootBranchId: string
  snapshot: BranchDeleteSnapshot
}

export type BranchUndoAction =
  | BranchCreateUndoAction
  | BranchRenameUndoAction
  | BranchMoveUndoAction
  | BranchDeleteUndoAction

export type UndoAction =
  | DeleteUndoAction
  | PasteUndoAction
  | CutPasteUndoAction
  | BranchCreateUndoAction
  | BranchRenameUndoAction
  | BranchMoveUndoAction
  | BranchDeleteUndoAction

// 撤销栈 state
export interface UndoStackState {
  undoStack: UndoAction[]
  redoStack: UndoAction[]
}
