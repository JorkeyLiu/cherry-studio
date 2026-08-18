import type { Message } from '@renderer/types/newMessage'

import type { MessageViewportGroup } from './messageGroups'

/**
 * The old MessagesContent projection consumed `displayMessages` (newest-to-oldest)
 * directly through `getGroupedMessages` + a per-group reversal:
 *
 *   1. Groups were built in `displayMessages` order, so rendered groups ran
 *      NEWEST group first (the first child of the column-reverse container is
 *      visually at the bottom).
 *   2. Each group accumulated its messages newest-first and was then reversed,
 *      so rendered messages within a group ran oldest-first.
 *   3. Group keys were `assistant${askId}` / `${role}${id}` (no prefix). The
 *      key logic compared the PREVIOUS message's base key (not its assigned
 *      key): the FIRST message of a run that repeats an already-seen base key
 *      opened a new `${base}_${displayIndex}` group, while the remaining
 *      messages of that run joined the FIRST-created group with the base key
 *      (the newest run's group).
 *   4. `index` was the viewport-local `displayMessages` position (0 = newest).
 *
 * Phase 2B keeps the precomputed chronological `displayGroups` (no
 * `createMessageViewportGroupModel(displayMessages)` regrouping), but the direct
 * map inverted the group order, used full-topic `group.range` values for
 * `index`, and leaked the model key format. This helper converts the precomputed
 * groups into the exact old effective projection so rendered group order,
 * per-group message order, Fragment keys, and viewport-local indices are
 * preserved without re-deriving the group model.
 *
 * Invariant: `displayGroups` and `displayMessages` are sliced from the same
 * MessageWindow, so every group message is present in `displayMessages`.
 */
export type MessageViewportProjectedGroup = readonly [key: string, messages: (Message & { index: number })[]]

const getOldBaseKey = (message: Message): string =>
  message.role === 'assistant' && message.askId ? `assistant${message.askId}` : `${message.role}${message.id}`

export const projectMessageViewportGroups = (
  displayMessages: Message[],
  displayGroups: MessageViewportGroup[]
): MessageViewportProjectedGroup[] => {
  const displayIndexById = new Map<string, number>()
  displayMessages.forEach((message, index) => {
    displayIndexById.set(message.id, index)
  })

  const createdBaseKeys = new Set<string>()
  const groupsByKey = new Map<string, (Message & { index: number })[]>()
  const orderedKeys: string[] = []

  // Each displayGroups entry is one maximal same-base run in chronological
  // order; reversed, it is the same run in displayMessages order.
  for (let index = displayGroups.length - 1; index >= 0; index--) {
    const group = displayGroups[index]
    const newestMessage = group.messages.at(-1)
    if (!newestMessage) continue
    const baseKey = getOldBaseKey(newestMessage)
    const runNewestFirst = [...group.messages].reverse()

    for (let offset = 0; offset < runNewestFirst.length; offset++) {
      const message = runNewestFirst[offset]
      const displayIndex = displayIndexById.get(message.id)!
      let targetKey: string
      if (!createdBaseKeys.has(baseKey)) {
        createdBaseKeys.add(baseKey)
        targetKey = baseKey
      } else if (offset === 0) {
        // First message of a run repeating an already-seen base key: the old
        // code opened a fresh `${base}_${displayIndex}` group here.
        targetKey = `${baseKey}_${displayIndex}`
      } else {
        // Remaining messages of the run directly follow a same-base message:
        // the old code pushed them into the FIRST-created group with this
        // base key (the newest run's group).
        targetKey = baseKey
      }

      let target = groupsByKey.get(targetKey)
      if (!target) {
        target = []
        groupsByKey.set(targetKey, target)
        orderedKeys.push(targetKey)
      }
      target.push({ ...message, index: displayIndex })
    }
  }

  return orderedKeys.map((key) => [key, [...groupsByKey.get(key)!].reverse()] as const)
}
