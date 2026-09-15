export interface TopicSegment {
  id: string
  topicId: string
  name: string
  messageIds: string[] // 连续的消息 ID 列表（有序，完整成员，用于本地编辑/兼容包含判断）
  color?: string // 连线颜色（可选，默认 primary color）
  createdAt: string
  updatedAt: string
  /** Authority catalog order from Main SQLite (dense 0..n-1). Never fabricated locally. */
  sortOrder: number
  /** Authority first message ID; stable navigation target (null when empty). */
  firstMessageId: string | null
  /** Authority last message ID (null when empty). */
  lastMessageId: string | null
  /** Authority membership size; always equals messageIds.length. */
  messageCount: number
}
