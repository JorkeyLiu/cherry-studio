import type { Message } from '@renderer/types/newMessage'

import type { MessageViewportGroup } from './messageGroups'

/**
 * Canonical viewport projection (S6.2a bounded correction).
 *
 * Canonical viewport group = consecutive assistant messages with the same
 * non-empty askId; all other messages are singleton groups. Repeated
 * non-consecutive askId runs remain separate.
 *
 * `displayGroups` and `displayMessages` are sliced from the same
 * MessageWindow, so every group message is present in `displayMessages`.
 *
 * Projection preserves:
 *  1. Outer order newest group first (column-reverse container).
 *  2. Inner order oldest message first per group.
 *  3. Viewport-local index (0 = newest in displayMessages).
 *  4. No input mutation.
 *  5. One-to-one displayGroups -> projected groups (no cross-run merge/split).
 *  6. Stable output key is the canonical group.key.
 */
export type MessageViewportProjectedGroup = readonly [key: string, messages: (Message & { index: number })[]]

export const projectMessageViewportGroups = (
  displayMessages: Message[],
  displayGroups: MessageViewportGroup[]
): MessageViewportProjectedGroup[] => {
  const displayIndexById = new Map<string, number>()
  displayMessages.forEach((message, index) => {
    displayIndexById.set(message.id, index)
  })

  // Iterate precomputed displayGroups newest-first, emit each group one-to-one
  // with its canonical key and oldest-first per-group messages + viewport index.
  return displayGroups
    .slice()
    .reverse()
    .map((group) => {
      const messagesWithIndex = group.messages.map((message) => ({
        ...message,
        index: displayIndexById.get(message.id)!
      }))
      return [group.key, messagesWithIndex] as const
    })
}
