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
}

// 撤销操作类型
export type UndoActionType = 'paste' | 'delete' | 'cut_paste'

// 撤销操作
export interface UndoAction {
  id: string
  type: UndoActionType
  timestamp: number
  topicId: string
  insertedMessageIds: string[]
  insertPositionIndex: number
  deletedMessageIds?: string[]
  deletedTopicId?: string
  deletedMessagesSnapshot?: Message[]
  deletedBlocksSnapshot?: MessageBlock[]
  fileReferenceDeltas?: Array<{ fileId: string; delta: number }>
}

// 撤销栈 state
export interface UndoStackState {
  undoStack: UndoAction[]
  redoStack: UndoAction[]
}
