import { dbService } from '@renderer/services/db'
import { updateTopicUpdatedAt } from '@renderer/store/assistants'
import type { Message } from '@renderer/types/newMessage'

import type { AppDispatch, RootState } from '../index'
import { newMessagesActions, selectMessagesForTopic } from '../newMessage'

export const buildReorderedMessageGroup = (
  messages: Message[],
  reorderedGroupMessageIds: string[]
): Message[] | undefined => {
  if (reorderedGroupMessageIds.length < 2) {
    return undefined
  }

  if (new Set(reorderedGroupMessageIds).size !== reorderedGroupMessageIds.length) {
    return undefined
  }

  const messageById = new Map(messages.map((message) => [message.id, message]))
  const groupMessages = reorderedGroupMessageIds.map((id) => messageById.get(id))

  if (groupMessages.some((message) => !message || message.role !== 'assistant')) {
    return undefined
  }

  const firstMessage = groupMessages[0]
  const askId = firstMessage?.askId

  if (!askId || groupMessages.some((message) => message?.askId !== askId)) {
    return undefined
  }

  const originalGroupMessages = messages.filter((message) => message.role === 'assistant' && message.askId === askId)

  if (originalGroupMessages.length !== reorderedGroupMessageIds.length) {
    return undefined
  }

  const originalGroupIds = originalGroupMessages.map((message) => message.id)
  const originalGroupIdSet = new Set(originalGroupIds)

  if (
    originalGroupIdSet.size !== reorderedGroupMessageIds.length ||
    reorderedGroupMessageIds.some((id) => !originalGroupIdSet.has(id))
  ) {
    return undefined
  }

  if (originalGroupIds.every((id, index) => id === reorderedGroupMessageIds[index])) {
    return undefined
  }

  const reorderedGroupMessages = reorderedGroupMessageIds.map((id) => messageById.get(id) as Message)
  let replacementIndex = 0

  return messages.map((message) => {
    if (!originalGroupIdSet.has(message.id)) {
      return message
    }

    const reorderedMessage = reorderedGroupMessages[replacementIndex]
    replacementIndex += 1
    return reorderedMessage
  })
}

export const reorderMessageGroupThunk =
  (topicId: string, reorderedGroupMessageIds: string[]) => async (dispatch: AppDispatch, getState: () => RootState) => {
    const messages = selectMessagesForTopic(getState(), topicId)
    const reorderedMessages = buildReorderedMessageGroup(messages, reorderedGroupMessageIds)

    if (!reorderedMessages) {
      return
    }

    await dbService.reorderMessages(
      topicId,
      reorderedMessages.map((message) => message.id)
    )

    dispatch(newMessagesActions.messagesReceived({ topicId, messages: reorderedMessages }))
    dispatch(updateTopicUpdatedAt({ topicId }))
  }
