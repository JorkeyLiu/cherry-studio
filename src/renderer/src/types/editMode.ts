import type { Message, MessageBlock } from './newMessage'

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

// 剪贴板 state
export interface ClipboardState {
  mode: ClipboardMode | null
  items: ClipboardItem[]
  sourceTopicId: string | null
  timestamp: number
}

// 编辑模式 state
export interface EditModeState {
  enabled: boolean
  selectedGroupIds: string[] // askId 列表
  lastSelectedIndex: number | null // Shift 区域选的锚点
  focusedIndex: number | null // 当前焦点位置
  isProcessing: boolean // 全局操作锁
}

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
}

// 撤销操作类型
export type UndoActionType = 'paste' | 'delete' | 'cut_paste'

interface BaseUndoAction {
  id: string
  type: UndoActionType
  timestamp: number
  /** Topic where the operation's primary effect occurs */
  targetTopicId: string
  /** IDs of messages inserted by this operation (for undo removal / redo re-insert) */
  insertedMessageIds: string[]
  /** Snapshot of inserted messages and blocks (for redo) */
  pastedMessagesSnapshot: Message[]
  pastedBlocksSnapshot: MessageBlock[]
  fileReferenceDeltas: Array<{ fileId: string; delta: number }>
}

export interface DeleteUndoAction extends BaseUndoAction {
  type: 'delete'
  /** Per-group anchors for restoring deleted groups to their original positions */
  groupAnchors: GroupAnchor[]
}

export interface PasteUndoAction extends BaseUndoAction {
  type: 'paste'
  /** Anchor message after the paste region (for redo positioning) */
  targetAnchorMessageId: string | null
  /** Fallback position index for redo */
  targetInsertPositionIndex: number
}

export interface CutPasteUndoAction extends BaseUndoAction {
  type: 'cut_paste'
  /** Anchor message after the paste region in target topic (for redo paste positioning) */
  targetAnchorMessageId: string | null
  /** Fallback position index in target topic for redo */
  targetInsertPositionIndex: number
  /** Source topic ID */
  sourceTopicId: string
  /** Per-group anchors for restoring source groups to their original positions */
  sourceGroupAnchors: GroupAnchor[]
}

export type UndoAction = DeleteUndoAction | PasteUndoAction | CutPasteUndoAction

// 撤销栈 state
export interface UndoStackState {
  undoStack: UndoAction[]
  redoStack: UndoAction[]
}
