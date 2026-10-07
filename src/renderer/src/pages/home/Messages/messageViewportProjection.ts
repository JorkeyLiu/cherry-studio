import type { Topic } from '@renderer/types'
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

/**
 * Render-relevant viewport position of a projected message.
 *
 * The ONLY production consumer of the numeric viewport index is
 * `Message.tsx` (`isLastMessage = index === 0 || isGrouped`); context menu
 * and navigation resolve stable IDs live at event time (PROJ-12). A pure
 * non-zero index displacement (e.g. 5 -> 7 after an append) therefore cannot
 * change rendering, while any 0-boundary transition (newest marker hand-off)
 * must invalidate. Undefined (off-window id) counts as non-zero.
 */
export const isViewportNewest = (index: number | undefined): boolean => index === 0

export const isSameViewportPosition = (prevIndex: number | undefined, nextIndex: number | undefined): boolean =>
  isViewportNewest(prevIndex) === isViewportNewest(nextIndex)

/**
 * Complete shallow comparison of two projected messages.
 *
 * No render-relevant field is whitelisted out: every own key of the union is
 * compared, so a change to status/model/fold/useful/blocks membership (or any
 * future message field) invalidates. Two narrow tolerances apply, both proven
 * render-neutral above or delegated to per-message child subscriptions:
 * - `index`: only the 0-boundary matters (see isSameViewportPosition).
 * - `blocks`: ordered id-membership comparison. Same ordered ids mean the
 *   same block membership; block content commits reach MessageMenubar and the
 *   block renderer through their own per-message shallow subscriptions, which
 *   update independently of this boundary.
 */
export const areProjectedMessagesEqual = (
  prev: (Message & { index?: number }) | undefined,
  next: (Message & { index?: number }) | undefined
): boolean => {
  if (prev === next) return true
  if (!prev || !next) return false
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)])
  for (const key of keys) {
    if (key === 'index') {
      if (!isSameViewportPosition(prev.index, next.index)) return false
      continue
    }
    if (key === 'blocks') {
      const prevBlocks = (prev as Message).blocks
      const nextBlocks = (next as Message).blocks
      if (prevBlocks === nextBlocks) continue
      if (!Array.isArray(prevBlocks) || !Array.isArray(nextBlocks)) return false
      if (prevBlocks.length !== nextBlocks.length) return false
      for (let i = 0; i < prevBlocks.length; i += 1) {
        if (prevBlocks[i] !== nextBlocks[i]) return false
      }
      continue
    }
    if (!Object.is((prev as Record<string, unknown>)[key], (next as Record<string, unknown>)[key])) return false
  }
  return true
}

/**
 * Topic comparison for the render isolation boundary.
 *
 * Only the `updatedAt` bump written on every send
 * (`updateTopicUpdatedAt`) is ignored — it carries no rendered semantic for
 * message history. Every other field (including any future field, via union
 * keys) is compared, so real topic changes (name/prompt/pinned/assistant/
 * type/deletedAt/createdAt/...) always invalidate. The legacy `messages`
 * carrier is compared element-wise by canonical entity identity: an entity
 * replacement (the only way rendered content changes) invalidates, while a
 * harmless carrier re-wrap around identical entities does not.
 */
export const areTopicsViewportEqual = (prev: Topic | undefined, next: Topic | undefined): boolean => {
  if (prev === next) return true
  if (!prev || !next) return false
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)])
  for (const key of keys) {
    if (key === 'updatedAt') continue
    if (key === 'messages') {
      const prevMessages = prev.messages
      const nextMessages = next.messages
      if (prevMessages === nextMessages) continue
      if (!Array.isArray(prevMessages) || !Array.isArray(nextMessages)) return false
      if (prevMessages.length !== nextMessages.length) return false
      for (let i = 0; i < prevMessages.length; i += 1) {
        if (prevMessages[i] !== nextMessages[i]) return false
      }
      continue
    }
    if (!Object.is((prev as Record<string, unknown>)[key], (next as Record<string, unknown>)[key])) return false
  }
  return true
}

/**
 * Bounded stable viewport projection cache (per MessagesContent instance).
 *
 * The pure `projectMessageViewportGroups` above clones every message and
 * allocates new group arrays on each call, which defeats `memo` boundaries
 * below it: every append would re-render the full history. This cache reuses
 * the previous projected wrapper when the canonical source entity is
 * referentially identical AND the render-relevant viewport position (0 or
 * non-0) is unchanged, and reuses the whole group tuple when every member
 * is reused. Any entity replacement (status/model/fold/useful/blocks/text
 * edit) or 0-boundary hand-off yields a fresh wrapper for exactly that
 * message, so only its owner group invalidates.
 *
 * Bounds and isolation (no cross-topic/cross-route retention):
 * - One instance per MessagesContent mount (held in a ref, never module
 *   shared), keyed by the caller's `routeKey` (`topicId::route`). A route or
 *   topic change clears all retained wrappers before projecting.
 * - Every projection sweeps ids absent from the current window (trim/switch
 *   eviction), so retention is at most the current window's membership.
 */
export interface ViewportProjectionCache {
  project(
    displayMessages: Message[],
    displayGroups: MessageViewportGroup[],
    routeKey: string
  ): MessageViewportProjectedGroup[]
  clear(): void
  /** Retained wrapper count (diagnostic/test only). */
  size(): number
}

export const createViewportProjectionCache = (): ViewportProjectionCache => {
  let lastRouteKey: string | null = null
  let lastGroups: MessageViewportProjectedGroup[] = []
  const retained = new Map<string, { source: Message; projected: Message & { index: number } }>()

  const clear = (): void => {
    retained.clear()
    lastGroups = []
    lastRouteKey = null
  }

  const project = (
    displayMessages: Message[],
    displayGroups: MessageViewportGroup[],
    routeKey: string
  ): MessageViewportProjectedGroup[] => {
    if (lastRouteKey !== routeKey) {
      retained.clear()
      lastGroups = []
      lastRouteKey = routeKey
    }
    const displayIndexById = new Map<string, number>()
    displayMessages.forEach((message, index) => {
      if (!displayIndexById.has(message.id)) {
        displayIndexById.set(message.id, index)
      }
    })

    const prevByKey = new Map<string, MessageViewportProjectedGroup>()
    for (const group of lastGroups) {
      prevByKey.set(group[0], group)
    }

    const next = displayGroups
      .slice()
      .reverse()
      .map((group) => {
        const prevMessages = prevByKey.get(group.key)?.[1]
        const projectedMessages = group.messages.map((message) => {
          const index = displayIndexById.get(message.id)!
          const cached = retained.get(message.id)
          if (cached && cached.source === message && isSameViewportPosition(cached.projected.index, index)) {
            return cached.projected
          }
          const projected = { ...message, index }
          retained.set(message.id, { source: message, projected })
          return projected
        })
        if (
          prevMessages &&
          prevMessages.length === projectedMessages.length &&
          projectedMessages.every((message, i) => message === prevMessages[i])
        ) {
          return prevByKey.get(group.key)!
        }
        return [group.key, projectedMessages] as const
      })

    if (next.length === lastGroups.length && next.every((group, i) => group === lastGroups[i])) {
      return lastGroups
    }
    lastGroups = next

    // Bounded retention: drop wrappers for messages no longer in the window.
    if (retained.size > displayIndexById.size) {
      for (const id of retained.keys()) {
        if (!displayIndexById.has(id)) {
          retained.delete(id)
        }
      }
    }
    return next
  }

  return {
    project,
    clear,
    size: () => retained.size
  }
}
