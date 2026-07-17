export interface TopicSegment {
  id: string
  topicId: string
  name: string
  messageIds: string[] // 连续的消息 ID 列表（有序）
  color?: string // 连线颜色（可选，默认 primary color）
  createdAt: string
  updatedAt: string
}
