import type { Message } from '@renderer/types/newMessage'

export interface MessageGroupRange {
  start: number
  end: number
}

export interface MessageViewportGroup {
  key: string
  semanticKey: string
  messages: Message[]
  range: MessageGroupRange
}

export interface MessageViewportGroupModel {
  groups: MessageViewportGroup[]
  messageIdToGroup: ReadonlyMap<string, MessageViewportGroup>
  messageIndexToGroup: readonly MessageViewportGroup[]
}

/**
 * Returns the visual grouping identity for a message. Assistant replies only
 * share an identity when askId is present; all other messages stand alone.
 */
export const getMessageGroupSemanticKey = (message: Message): string =>
  message.role === 'assistant' && message.askId ? `assistant:${message.askId}` : `message:${message.role}:${message.id}`

/** Builds consecutive visual question/answer groups in the input order. */
export const createMessageViewportGroupModel = (messages: Message[]): MessageViewportGroupModel => {
  const groups: MessageViewportGroup[] = []
  const messageIdToGroup = new Map<string, MessageViewportGroup>()
  const messageIndexToGroup: MessageViewportGroup[] = []

  messages.forEach((message, index) => {
    const semanticKey = getMessageGroupSemanticKey(message)
    let group = groups.at(-1)

    if (!group || group.semanticKey !== semanticKey) {
      group = {
        key: `${semanticKey}:${message.id}`,
        semanticKey,
        messages: [],
        range: { start: index, end: index }
      }
      groups.push(group)
    }

    group.messages.push(message)
    group.range.end = index
    messageIdToGroup.set(message.id, group)
    messageIndexToGroup[index] = group
  })

  return { groups, messageIdToGroup, messageIndexToGroup }
}

export const getMessageGroupById = (
  model: MessageViewportGroupModel,
  messageId: string
): MessageViewportGroup | undefined => model.messageIdToGroup.get(messageId)

/** Flattens an inclusive group range while preserving message input order. */
export const flattenMessageGroupRange = (
  model: MessageViewportGroupModel,
  startGroupIndex: number,
  endGroupIndex: number
): Message[] => {
  if (startGroupIndex > endGroupIndex || model.groups.length === 0) return []

  const start = Math.max(0, startGroupIndex)
  const end = Math.min(model.groups.length - 1, endGroupIndex)
  if (start > end) return []

  return model.groups.slice(start, end + 1).flatMap((group) => group.messages)
}
