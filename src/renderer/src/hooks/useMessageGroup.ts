import type { Message } from '@renderer/types/newMessage'
import { useMemo } from 'react'

export interface MessageGroup {
  /** 消息组的 askId（即 user message 的 id） */
  askId: string
  /** 组内的消息列表（按 messageIdsByTopic 顺序） */
  messages: Message[]
  /** 第一条消息在原始列表中的起始索引 */
  startIndex: number
}

/**
 * 将消息列表按消息组（user + 其 assistant 回复）分组
 */
export function useMessageGroups(messages: Message[]): MessageGroup[] {
  return useMemo(() => {
    return getMessageGroups(messages)
  }, [messages])
}

/**
 * 纯函数版本，供非组件场景使用
 */
export function getMessageGroups(messages: Message[]): MessageGroup[] {
  const groups: MessageGroup[] = []
  let currentGroup: MessageGroup | null = null

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role === 'user') {
      // 用户消息开始新组
      currentGroup = { askId: msg.id, messages: [msg], startIndex: i }
      groups.push(currentGroup)
    } else if (msg.role === 'assistant' && msg.askId) {
      // 助手消息：查找是否属于已有组
      const existingGroup = groups.find((g) => g.askId === msg.askId)
      if (existingGroup) {
        existingGroup.messages.push(msg)
      } else {
        // 没有对应的 user 消息，作为独立组
        currentGroup = { askId: msg.id, messages: [msg], startIndex: i }
        groups.push(currentGroup)
      }
    } else if (msg.role === 'system') {
      // system 消息作为独立组
      currentGroup = { askId: msg.id, messages: [msg], startIndex: i }
      groups.push(currentGroup)
    }
    // 'clear' 类型消息忽略或作为独立组
  }

  return groups
}

/**
 * 根据 askId 获取消息组在组列表中的索引
 */
export function getGroupIndex(groups: MessageGroup[], askId: string): number {
  return groups.findIndex((g) => g.askId === askId)
}

/**
 * 获取消息组中最后一条消息在 messageIdsByTopic 中的索引
 */
export function getGroupEndIndex(groups: MessageGroup[], groupIndex: number): number {
  const group = groups[groupIndex]
  if (!group) return -1
  return group.startIndex + group.messages.length - 1
}
