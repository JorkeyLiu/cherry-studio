import type { Message } from '@renderer/types/newMessage'

export const getBranchEndpoint = (messages: Message[], messageId: string): number | null => {
  const messageIndex = messages.findIndex((message) => message.id === messageId)
  return messageIndex === -1 ? null : messageIndex + 1
}
