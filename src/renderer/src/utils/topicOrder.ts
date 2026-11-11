/**
 * Topic list ordering helpers.
 *
 * Two user-chosen orders exist per assistant, plus the pinned group that is
 * shared by both:
 * - `updated` — "by update time". The ordering key is the REAL INSTANT of the
 *   latest message `createdAt` inside that topic (every route of the topic,
 *   reference prefix included), as read from Main. It is never the authority
 *   sort tail, never `message.updatedAt`, and never a topic
 *   `updatedAt`/`createdAt` write: enabling it once re-sorts the non-pinned
 *   topics newest-first, then only a topic whose latest message instant
 *   actually changed is repositioned (unchanged instants never move anything).
 *   This is the DEFAULT for assistants that carry no explicit choice.
 * - `manual` — the persisted `assistant.topics` array order is authoritative
 *   (drag & drop writes it directly). It is only ever an explicit choice.
 *
 * "By creation time" is a one-shot action: it applies a newest-first
 * `createdAt` order and returns the assistant to `manual`.
 *
 * Pinned topics are excluded from both orders: they always stay first and
 * keep their own relative order. A topic without a usable message instant
 * falls back to its own `createdAt` for ordering only, and a topic with no
 * usable timestamp at all sorts last instead of pretending to be recent.
 * No timestamp is ever fabricated.
 */
import type { TopicOrderMode } from '@renderer/types'

export const DEFAULT_TOPIC_ORDER_MODE: TopicOrderMode = 'updated'

/**
 * Explicit choice persisted on the assistant. `undefined`/`null`/unknown mean
 * "never decided": that reads as the default and is the only state the
 * one-time default initialization may act on.
 */
export function hasExplicitTopicOrderMode(mode: unknown): boolean {
  return mode === 'manual' || mode === 'updated'
}

/** The effective mode: an explicit choice always wins, otherwise the default. */
export function resolveTopicOrderMode(mode: unknown): TopicOrderMode {
  return hasExplicitTopicOrderMode(mode) ? (mode as TopicOrderMode) : DEFAULT_TOPIC_ORDER_MODE
}

function timeMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms
}

/**
 * Ordering key of one topic: the authoritative latest message instant when it
 * exists, otherwise the topic's own `createdAt` (fallback for ordering only —
 * no clock read, no fabricated value). `null` means "no usable instant".
 */
export function topicSortKeyMs(latestMessageAt: unknown, createdAt: unknown): number | null {
  return timeMs(latestMessageAt) ?? timeMs(createdAt) ?? null
}

/** Newest-first by an optional key; equal and missing keys keep their source order. */
function newestFirst<T>(items: T[], keyOf: (item: T) => number | null): T[] {
  const decorated = items.map((item, index) => ({ item, index, key: keyOf(item) }))
  decorated.sort((a, b) => {
    if (a.key === null && b.key === null) return a.index - b.index
    if (a.key === null) return 1
    if (b.key === null) return -1
    if (a.key !== b.key) return b.key - a.key
    return a.index - b.index
  })
  return decorated.map((entry) => entry.item)
}

function splitPinned<T extends { pinned?: boolean }>(topics: T[]): { pinned: T[]; ordinary: T[] } {
  return {
    pinned: topics.filter((topic) => Boolean(topic.pinned)),
    ordinary: topics.filter((topic) => !topic.pinned)
  }
}

/**
 * One-shot "by creation time": pinned topics keep their own order at the top,
 * every non-pinned topic is ordered newest-created first with stable ties.
 */
export function sortTopicsByCreatedAtDesc<T extends { pinned?: boolean; createdAt?: string }>(topics: T[]): T[] {
  const { pinned, ordinary } = splitPinned(topics)
  return [...pinned, ...newestFirst(ordinary, (topic) => topicSortKeyMs(undefined, topic.createdAt))]
}

/**
 * "By update time", applied once: pinned topics keep their own order at the
 * top, every non-pinned topic is ordered newest-message-instant first with
 * stable ties (missing instants last, in their current relative order).
 */
export function sortTopicsByMessageTimeDesc<T extends { pinned?: boolean }>(
  topics: T[],
  keyOf: (topic: T) => number | null
): T[] {
  const { pinned, ordinary } = splitPinned(topics)
  return [...pinned, ...newestFirst(ordinary, keyOf)]
}

/**
 * Continuous policy, forward move: the topic whose latest message instant
 * advanced goes to the head of the ordinary group. Every other topic keeps
 * its position, the pinned group is untouched, and the same array reference
 * is returned when nothing changes (pinned/missing/absent target or already
 * at the head) so callers can skip a redundant state write.
 */
export function moveTopicToOrdinaryHead<T extends { id: string; pinned?: boolean }>(topics: T[], topicId: string): T[] {
  const target = topics.find((topic) => topic.id === topicId)
  if (!target || target.pinned) return topics

  const { pinned, ordinary } = splitPinned(topics)
  if (ordinary[0]?.id === topicId) return topics
  return [...pinned, target, ...ordinary.filter((topic) => topic.id !== topicId)]
}

/**
 * Continuous policy, backward move: the topic whose latest message instant
 * went backwards (its newest message was deleted/undo-restored) is placed at
 * the position its new instant implies among the other ordinary topics.
 * Every other topic keeps its relative order, the pinned group is untouched,
 * and the same array reference is returned when the resulting order equals
 * the current one (absent/pinned target or already in place).
 *
 * Topics whose instant is unknown sort last, so a known topic is placed
 * before the first unknown one.
 */
export function placeTopicBySortKey<T extends { id: string; pinned?: boolean }>(
  topics: T[],
  topicId: string,
  nextKeyMs: number | null,
  keyOf: (topic: T) => number | null
): T[] {
  const target = topics.find((topic) => topic.id === topicId)
  if (!target || target.pinned) return topics

  const { pinned, ordinary } = splitPinned(topics)
  const others = ordinary.filter((topic) => topic.id !== topicId)
  if (others.length === 0) return topics

  let index = others.length
  if (nextKeyMs !== null) {
    const first = others.findIndex((topic) => {
      const key = keyOf(topic)
      return key === null || key < nextKeyMs
    })
    index = first === -1 ? others.length : first
  }

  const placed = [...others.slice(0, index), target, ...others.slice(index)]
  const unchanged = placed.every((topic, position) => topic.id === ordinary[position]?.id)
  return unchanged ? topics : [...pinned, ...placed]
}

/**
 * Drag & drop on a filtered (searched) list must never drop hidden topics.
 * The visible subset is reordered by the caller; this maps the new visible
 * order back onto the complete list by slot, keeps every hidden topic, and
 * re-applies the pinned-first grouping so a drag can never break it.
 */
export function mergeVisibleTopicReorder<T extends { id: string; pinned?: boolean }>(
  fullTopics: T[],
  visibleBefore: T[],
  reorderedVisible: T[]
): T[] {
  if (visibleBefore.length === 0 || visibleBefore.length !== reorderedVisible.length) return fullTopics

  // The drag result must be a permutation of the visible subset; anything else
  // (duplicates, missing ids, an extra item) is rejected instead of dropping
  // or duplicating topics in the persisted list.
  const visibleIds = new Set(visibleBefore.map((topic) => topic.id))
  const reorderedIds = new Set(reorderedVisible.map((topic) => topic.id))
  if (reorderedIds.size !== visibleIds.size) return fullTopics
  for (const id of visibleIds) {
    if (!reorderedIds.has(id)) return fullTopics
  }
  const byId = new Map(fullTopics.map((topic) => [topic.id, topic]))
  for (const id of visibleIds) {
    if (!byId.has(id)) return fullTopics
  }

  // Slot mapping: the k-th visible slot in the complete list takes the k-th
  // item of the dragged visible order, so hidden topics never move.
  const projection = sortTopicsPinnedFirstByFlag(fullTopics)
  const visibleOrder = reorderedVisible.map((topic) => byId.get(topic.id) as T)
  let cursor = 0
  const merged = projection.map((topic) => (visibleIds.has(topic.id) ? visibleOrder[cursor++] : topic))
  return sortTopicsPinnedFirstByFlag(merged)
}

/**
 * Local copy of the pinned-first projection so this module stays free of
 * import cycles. Stable: each group keeps its relative order.
 */
function sortTopicsPinnedFirstByFlag<T extends { pinned?: boolean }>(topics: T[]): T[] {
  const { pinned, ordinary } = splitPinned(topics)
  return [...pinned, ...ordinary]
}
