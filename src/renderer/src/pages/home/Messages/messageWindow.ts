import type { Message } from '@renderer/types/newMessage'

import { createMessageViewportGroupModel, type MessageViewportGroupModel } from './messageGroups'

export interface MessageGroupRange {
  /** Inclusive index of the visually oldest group in chronological source order. */
  oldestGroupIndex: number
  /** Inclusive index of the visually newest group in chronological source order. */
  newestGroupIndex: number
}

export interface MessageWindow {
  range: MessageGroupRange | null
  /** Whether reconciliation follows newly appended groups or retains this range. */
  edge: 'latest' | 'fixed'
  /** Messages in newest-to-oldest order, as consumed by the column-reverse view. */
  displayMessages: Message[]
  groupCapacity: number
  groupCount: number
  hasMoreOlder: boolean
  hasMoreNewer: boolean
  oldestMessageId?: string
  newestMessageId?: string
}

const createWindowFromRange = (
  model: MessageViewportGroupModel,
  range: MessageGroupRange | null,
  groupCapacity: number,
  edge: MessageWindow['edge']
): MessageWindow => {
  if (!range || model.groups.length === 0) {
    return {
      range: null,
      edge,
      displayMessages: [],
      groupCapacity: Math.max(0, groupCapacity),
      groupCount: 0,
      hasMoreOlder: false,
      hasMoreNewer: false
    }
  }

  const oldestGroupIndex = Math.max(0, range.oldestGroupIndex)
  const newestGroupIndex = Math.min(model.groups.length - 1, range.newestGroupIndex)
  if (oldestGroupIndex > newestGroupIndex) return createWindowFromRange(model, null, groupCapacity, edge)

  const groups = model.groups.slice(oldestGroupIndex, newestGroupIndex + 1)
  const chronologicalMessages = groups.flatMap((group) => group.messages)

  return {
    range: { oldestGroupIndex, newestGroupIndex },
    edge,
    displayMessages: chronologicalMessages.toReversed(),
    groupCapacity: Math.max(0, groupCapacity),
    groupCount: groups.length,
    hasMoreOlder: oldestGroupIndex > 0,
    hasMoreNewer: newestGroupIndex < model.groups.length - 1,
    oldestMessageId: chronologicalMessages[0]?.id,
    newestMessageId: chronologicalMessages.at(-1)?.id
  }
}

export const createLatestMessageWindow = (messages: Message[], groupCapacity: number): MessageWindow => {
  const model = createMessageViewportGroupModel(messages)
  const capacity = Math.max(0, groupCapacity)
  if (capacity === 0 || model.groups.length === 0) return createWindowFromRange(model, null, capacity, 'latest')

  return createWindowFromRange(
    model,
    {
      oldestGroupIndex: Math.max(0, model.groups.length - capacity),
      newestGroupIndex: model.groups.length - 1
    },
    capacity,
    'latest'
  )
}

/**
 * Creates a window anchored at the oldest groups in the topic.
 * Used by the unified 'top' navigation intent.
 */
export const createOldestMessageWindow = (messages: Message[], groupCapacity: number): MessageWindow => {
  const model = createMessageViewportGroupModel(messages)
  const capacity = Math.max(0, groupCapacity)
  if (capacity === 0 || model.groups.length === 0) return createWindowFromRange(model, null, capacity, 'fixed')

  return createWindowFromRange(
    model,
    {
      oldestGroupIndex: 0,
      newestGroupIndex: Math.min(model.groups.length - 1, capacity - 1)
    },
    capacity,
    'fixed'
  )
}

/**
 * Creates a target window with visual quotas on either side. If one edge lacks
 * groups, the unused quota is filled from the opposite edge.
 */
export const createTargetMessageWindow = (
  messages: Message[],
  targetMessageId: string,
  visuallyOlderGroupCount: number,
  visuallyNewerGroupCount: number
): MessageWindow => {
  const model = createMessageViewportGroupModel(messages)
  const capacity = Math.max(0, visuallyOlderGroupCount) + 1 + Math.max(0, visuallyNewerGroupCount)
  const targetGroup = model.messageIdToGroup.get(targetMessageId)
  if (!targetGroup) return createWindowFromRange(model, null, capacity, 'fixed')

  const targetGroupIndex = model.groups.indexOf(targetGroup)
  let oldestGroupIndex = Math.max(0, targetGroupIndex - Math.max(0, visuallyOlderGroupCount))
  let newestGroupIndex = Math.min(model.groups.length - 1, targetGroupIndex + Math.max(0, visuallyNewerGroupCount))
  let missingCount = capacity - (newestGroupIndex - oldestGroupIndex + 1)

  if (missingCount > 0) {
    const availableOlder = oldestGroupIndex
    const addedOlder = Math.min(availableOlder, missingCount)
    oldestGroupIndex -= addedOlder
    missingCount -= addedOlder
    newestGroupIndex = Math.min(model.groups.length - 1, newestGroupIndex + missingCount)
  }

  return createWindowFromRange(model, { oldestGroupIndex, newestGroupIndex }, capacity, 'fixed')
}

const getRangeFromDisplayMessages = (model: MessageViewportGroupModel, displayMessages: Message[]) => {
  const groupIndexes = displayMessages.flatMap((message) => {
    const group = model.messageIdToGroup.get(message.id)
    return group ? [model.groups.indexOf(group)] : []
  })
  if (groupIndexes.length === 0) return null

  return {
    oldestGroupIndex: Math.min(...groupIndexes),
    newestGroupIndex: Math.max(...groupIndexes)
  }
}

export const expandMessageWindowOlder = (
  messages: Message[],
  currentWindow: MessageWindow,
  additionalGroupCount: number
): MessageWindow => {
  const model = createMessageViewportGroupModel(messages)
  const currentRange = getRangeFromDisplayMessages(model, currentWindow.displayMessages)
  if (!currentRange) return createLatestMessageWindow(messages, additionalGroupCount)

  const addedCount = Math.max(0, additionalGroupCount)
  return createWindowFromRange(
    model,
    { ...currentRange, oldestGroupIndex: Math.max(0, currentRange.oldestGroupIndex - addedCount) },
    currentWindow.groupCapacity + addedCount,
    currentWindow.edge
  )
}

export const expandMessageWindowNewer = (
  messages: Message[],
  currentWindow: MessageWindow,
  additionalGroupCount: number
): MessageWindow => {
  const model = createMessageViewportGroupModel(messages)
  const currentRange = getRangeFromDisplayMessages(model, currentWindow.displayMessages)
  if (!currentRange) return createLatestMessageWindow(messages, additionalGroupCount)

  const addedCount = Math.max(0, additionalGroupCount)
  return createWindowFromRange(
    model,
    {
      ...currentRange,
      newestGroupIndex: Math.min(model.groups.length - 1, currentRange.newestGroupIndex + addedCount)
    },
    currentWindow.groupCapacity + addedCount,
    currentWindow.edge
  )
}

/** Refreshes a historical range, or follows the latest edge, at the same group capacity. */
export const reconcileMessageWindow = (
  messages: Message[],
  previousMessages: Message[],
  currentWindow: MessageWindow
): MessageWindow => {
  const capacity = currentWindow.groupCapacity
  if (currentWindow.edge === 'latest') {
    return createLatestMessageWindow(messages, capacity)
  }

  const model = createMessageViewportGroupModel(messages)
  const retainedIndexes = currentWindow.displayMessages.flatMap((message) => {
    const group = model.messageIdToGroup.get(message.id)
    return group ? [model.groups.indexOf(group)] : []
  })
  if (retainedIndexes.length === 0) {
    const previousModel = createMessageViewportGroupModel(previousMessages)
    const previousRange = currentWindow.range
    if (!previousRange || previousModel.groups.length === 0) {
      return createWindowFromRange(model, null, capacity, 'fixed')
    }
    return createWindowFromRange(model, previousRange, capacity, 'fixed')
  }

  let oldestGroupIndex = Math.min(...retainedIndexes)
  let newestGroupIndex = Math.max(...retainedIndexes)
  if (newestGroupIndex - oldestGroupIndex + 1 > capacity) {
    oldestGroupIndex = newestGroupIndex - capacity + 1
  }
  const missingCount = Math.max(0, capacity - (newestGroupIndex - oldestGroupIndex + 1))
  const addedNewer = Math.min(model.groups.length - 1 - newestGroupIndex, missingCount)
  newestGroupIndex += addedNewer
  oldestGroupIndex = Math.max(0, oldestGroupIndex - (missingCount - addedNewer))

  return createWindowFromRange(model, { oldestGroupIndex, newestGroupIndex }, capacity, 'fixed')
}
