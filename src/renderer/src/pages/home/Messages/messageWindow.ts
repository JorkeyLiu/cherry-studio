import type { Message } from '@renderer/types/newMessage'

import {
  createMessageViewportGroupModel,
  type MessageViewportGroup,
  type MessageViewportGroupModel
} from './messageGroups'

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
  /** Sliced visual groups in chronological order, pre-computed from the range.
   *  Consumed directly by MessagesContent to avoid redundant group-model regrouping. */
  displayGroups: MessageViewportGroup[]
  groupCapacity: number
  groupCount: number
  hasMoreOlder: boolean
  hasMoreNewer: boolean
  oldestMessageId?: string
  newestMessageId?: string
  /** Authoritative completeness from validated Main window, retained for pagination. */
  authoritativeHasMoreBefore?: boolean
  authoritativeHasMoreAfter?: boolean
}

const createWindowFromRange = (
  model: MessageViewportGroupModel,
  range: MessageGroupRange | null,
  groupCapacity: number,
  edge: MessageWindow['edge'],
  authoritative?: { hasMoreBefore?: boolean; hasMoreAfter?: boolean }
): MessageWindow => {
  if (!range || model.groups.length === 0) {
    return {
      range: null,
      edge,
      displayMessages: [],
      displayGroups: [],
      groupCapacity: Math.max(0, groupCapacity),
      groupCount: 0,
      hasMoreOlder: authoritative?.hasMoreBefore ?? false,
      hasMoreNewer: authoritative?.hasMoreAfter ?? false,
      authoritativeHasMoreBefore: authoritative?.hasMoreBefore,
      authoritativeHasMoreAfter: authoritative?.hasMoreAfter
    }
  }

  const oldestGroupIndex = Math.max(0, range.oldestGroupIndex)
  const newestGroupIndex = Math.min(model.groups.length - 1, range.newestGroupIndex)
  if (oldestGroupIndex > newestGroupIndex) return createWindowFromRange(model, null, groupCapacity, edge, authoritative)

  const groups = model.groups.slice(oldestGroupIndex, newestGroupIndex + 1)
  const chronologicalMessages = groups.flatMap((group) => group.messages)

  const hasMoreOlder = authoritative?.hasMoreBefore !== undefined ? authoritative.hasMoreBefore : oldestGroupIndex > 0
  const hasMoreNewer =
    authoritative?.hasMoreAfter !== undefined ? authoritative.hasMoreAfter : newestGroupIndex < model.groups.length - 1

  return {
    range: { oldestGroupIndex, newestGroupIndex },
    edge,
    displayMessages: chronologicalMessages.toReversed(),
    displayGroups: groups,
    groupCapacity: Math.max(0, groupCapacity),
    groupCount: groups.length,
    hasMoreOlder,
    hasMoreNewer,
    oldestMessageId: chronologicalMessages[0]?.id,
    newestMessageId: chronologicalMessages.at(-1)?.id,
    authoritativeHasMoreBefore: authoritative?.hasMoreBefore,
    authoritativeHasMoreAfter: authoritative?.hasMoreAfter
  }
}

export const createLatestMessageWindow = (
  messages: Message[],
  groupCapacity: number,
  authoritative?: { hasMoreBefore?: boolean; hasMoreAfter?: boolean }
): MessageWindow => {
  const model = createMessageViewportGroupModel(messages)
  const capacity = Math.max(0, groupCapacity)
  if (capacity === 0 || model.groups.length === 0)
    return createWindowFromRange(model, null, capacity, 'latest', authoritative)

  return createWindowFromRange(
    model,
    {
      oldestGroupIndex: Math.max(0, model.groups.length - capacity),
      newestGroupIndex: model.groups.length - 1
    },
    capacity,
    'latest',
    authoritative
  )
}

/**
 * Creates a window anchored at the oldest groups in the topic.
 * Used by the unified 'top' navigation intent.
 */
export const createOldestMessageWindow = (
  messages: Message[],
  groupCapacity: number,
  authoritative?: { hasMoreBefore?: boolean; hasMoreAfter?: boolean }
): MessageWindow => {
  const model = createMessageViewportGroupModel(messages)
  const capacity = Math.max(0, groupCapacity)
  if (capacity === 0 || model.groups.length === 0)
    return createWindowFromRange(model, null, capacity, 'fixed', authoritative)

  return createWindowFromRange(
    model,
    {
      oldestGroupIndex: 0,
      newestGroupIndex: Math.min(model.groups.length - 1, capacity - 1)
    },
    capacity,
    'fixed',
    authoritative
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
  visuallyNewerGroupCount: number,
  authoritative?: { hasMoreBefore?: boolean; hasMoreAfter?: boolean }
): MessageWindow => {
  const model = createMessageViewportGroupModel(messages)
  const capacity = Math.max(0, visuallyOlderGroupCount) + 1 + Math.max(0, visuallyNewerGroupCount)
  const targetGroup = model.messageIdToGroup.get(targetMessageId)
  if (!targetGroup) return createWindowFromRange(model, null, capacity, 'fixed', authoritative)

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

  return createWindowFromRange(model, { oldestGroupIndex, newestGroupIndex }, capacity, 'fixed', authoritative)
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
  additionalGroupCount: number,
  authoritative?: { hasMoreBefore?: boolean; hasMoreAfter?: boolean }
): MessageWindow => {
  const model = createMessageViewportGroupModel(messages)
  const currentRange = getRangeFromDisplayMessages(model, currentWindow.displayMessages)
  if (!currentRange) {
    const fallbackAuth = {
      hasMoreBefore: authoritative?.hasMoreBefore ?? currentWindow.authoritativeHasMoreBefore,
      hasMoreAfter: authoritative?.hasMoreAfter ?? currentWindow.authoritativeHasMoreAfter
    }
    const cleanAuth =
      fallbackAuth.hasMoreBefore === undefined && fallbackAuth.hasMoreAfter === undefined ? undefined : fallbackAuth
    return createLatestMessageWindow(messages, additionalGroupCount, cleanAuth)
  }

  const addedCount = Math.max(0, additionalGroupCount)
  const effectiveAuth = {
    hasMoreBefore: authoritative?.hasMoreBefore ?? currentWindow.authoritativeHasMoreBefore,
    hasMoreAfter: authoritative?.hasMoreAfter ?? currentWindow.authoritativeHasMoreAfter
  }
  const cleanAuth =
    effectiveAuth.hasMoreBefore === undefined && effectiveAuth.hasMoreAfter === undefined ? undefined : effectiveAuth
  return createWindowFromRange(
    model,
    { ...currentRange, oldestGroupIndex: Math.max(0, currentRange.oldestGroupIndex - addedCount) },
    currentWindow.groupCapacity + addedCount,
    currentWindow.edge,
    cleanAuth
  )
}

export const expandMessageWindowNewer = (
  messages: Message[],
  currentWindow: MessageWindow,
  additionalGroupCount: number,
  authoritative?: { hasMoreBefore?: boolean; hasMoreAfter?: boolean }
): MessageWindow => {
  const model = createMessageViewportGroupModel(messages)
  const currentRange = getRangeFromDisplayMessages(model, currentWindow.displayMessages)
  if (!currentRange) {
    const fallbackAuth = {
      hasMoreBefore: authoritative?.hasMoreBefore ?? currentWindow.authoritativeHasMoreBefore,
      hasMoreAfter: authoritative?.hasMoreAfter ?? currentWindow.authoritativeHasMoreAfter
    }
    const cleanAuth =
      fallbackAuth.hasMoreBefore === undefined && fallbackAuth.hasMoreAfter === undefined ? undefined : fallbackAuth
    return createLatestMessageWindow(messages, additionalGroupCount, cleanAuth)
  }

  const addedCount = Math.max(0, additionalGroupCount)
  const effectiveAuth = {
    hasMoreBefore: authoritative?.hasMoreBefore ?? currentWindow.authoritativeHasMoreBefore,
    hasMoreAfter: authoritative?.hasMoreAfter ?? currentWindow.authoritativeHasMoreAfter
  }
  const cleanAuth =
    effectiveAuth.hasMoreBefore === undefined && effectiveAuth.hasMoreAfter === undefined ? undefined : effectiveAuth
  return createWindowFromRange(
    model,
    {
      ...currentRange,
      newestGroupIndex: Math.min(model.groups.length - 1, currentRange.newestGroupIndex + addedCount)
    },
    currentWindow.groupCapacity + addedCount,
    currentWindow.edge,
    cleanAuth
  )
}

/** Refreshes a historical range, or follows the latest edge, at the same group capacity. */
export const reconcileMessageWindow = (
  messages: Message[],
  previousMessages: Message[],
  currentWindow: MessageWindow
): MessageWindow => {
  const capacity = currentWindow.groupCapacity
  const auth =
    currentWindow.authoritativeHasMoreBefore !== undefined || currentWindow.authoritativeHasMoreAfter !== undefined
      ? {
          hasMoreBefore: currentWindow.authoritativeHasMoreBefore,
          hasMoreAfter: currentWindow.authoritativeHasMoreAfter
        }
      : undefined
  const cleanAuth = auth?.hasMoreBefore === undefined && auth?.hasMoreAfter === undefined ? undefined : auth
  if (currentWindow.edge === 'latest') {
    return createLatestMessageWindow(messages, capacity, cleanAuth)
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
      return createWindowFromRange(model, null, capacity, 'fixed', cleanAuth)
    }
    return createWindowFromRange(model, previousRange, capacity, 'fixed', cleanAuth)
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

  return createWindowFromRange(model, { oldestGroupIndex, newestGroupIndex }, capacity, 'fixed', cleanAuth)
}

// --- S6.1 helpers transplanted from Messages.tsx (single production implementation) ---

/**
 * Canonical disjoint authoritative window union by stable ID with deterministic sort.
 * Deduplicates by stable `id`, preserves all resident tail entries, adds any new
 * incoming entries, and sorts deterministically: ascending `sortOrder` when present,
 * tie-broken by lexicographic `id`, otherwise lexicographic `id` only.
 * Used by R-04 search-hit navigation when the anchor is not resident.
 */
export function unionWindowMessages(existing: Message[], incoming: Message[]): Message[] {
  const existingIds = new Set(existing.map((m) => m.id))
  const newIncoming = incoming.filter((m) => !existingIds.has(m.id))
  if (newIncoming.length === 0) return existing
  const combined = [...existing, ...newIncoming]
  const hasSortOrder = combined.some((m) => typeof (m as any).sortOrder === 'number')
  if (hasSortOrder) {
    return combined.slice().sort((a: any, b: any) => {
      const sa = typeof a.sortOrder === 'number' ? a.sortOrder : Number.MAX_SAFE_INTEGER
      const sb = typeof b.sortOrder === 'number' ? b.sortOrder : Number.MAX_SAFE_INTEGER
      if (sa !== sb) return sa - sb
      return a.id.localeCompare(b.id)
    })
  }
  return combined.slice().sort((a, b) => a.id.localeCompare(b.id))
}

export function mergeWindowIntoTopic(existing: Message[], incoming: Message[], anchorId: string): Message[] {
  const existingIds = new Set(existing.map((m) => m.id))
  const newIds = incoming.filter((m) => !existingIds.has(m.id))
  if (newIds.length === 0) return existing

  const anchorIdxExisting = existing.findIndex((m) => m.id === anchorId)
  const anchorIdxIncoming = incoming.findIndex((m) => m.id === anchorId)
  if (anchorIdxIncoming === -1) return existing

  const beforeIncoming = incoming.slice(0, anchorIdxIncoming).filter((m) => !existingIds.has(m.id))
  const afterIncoming = incoming.slice(anchorIdxIncoming + 1).filter((m) => !existingIds.has(m.id))

  if (anchorIdxExisting === -1) {
    return [...beforeIncoming, ...existing, ...afterIncoming]
  }

  const result = [...existing]
  result.splice(anchorIdxExisting, 0, ...beforeIncoming)
  const newAnchorPos = result.findIndex((m) => m.id === anchorId)
  result.splice(newAnchorPos + 1, 0, ...afterIncoming)
  return result
}

export function clampWindowCount(n: number): number {
  return Math.min(100, Math.max(1, Math.floor(n) || 1))
}

// Authoritative latest-window completeness store (renderer-only, per-topic.
// Populated by loadTopicMessagesThunk after validated latest response;
// consumed by Messages bootstrap to retain hasMoreBefore/hasMoreAfter.)
const latestWindowCompletenessByTopic = new Map<string, { hasMoreBefore: boolean; hasMoreAfter: boolean }>()

export function setLatestWindowCompleteness(
  topicId: string,
  completeness: { hasMoreBefore: boolean; hasMoreAfter: boolean }
): void {
  latestWindowCompletenessByTopic.set(topicId, completeness)
}

export function getLatestWindowCompleteness(
  topicId: string
): { hasMoreBefore: boolean; hasMoreAfter: boolean } | undefined {
  return latestWindowCompletenessByTopic.get(topicId)
}

export function clearLatestWindowCompleteness(topicId: string): void {
  latestWindowCompletenessByTopic.delete(topicId)
}

export function clearAllLatestWindowCompleteness(): void {
  latestWindowCompletenessByTopic.clear()
}
