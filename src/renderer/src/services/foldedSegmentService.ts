import store from '@renderer/store'
import type { Message } from '@renderer/types/newMessage'
import type { TopicSegment } from '@renderer/types/topicSegment'

/**
 * Folded (collapsed) topic-segment participation, for every context consumer.
 *
 * The exclusion set that decides what a REQUEST sends, what the token
 * estimation counts, and what the context counts report is Main authority:
 * every context-closure / whole-topic-snapshot response carries
 * `foldedMessageIds`, read in the same SQLite snapshot as the messages. Those
 * consumers must use that list (`excludeFoldedMessages` / `isMessageFolded`
 * below) and never the renderer segment projection — an unloaded or stale
 * catalog says nothing about whether a persisted fold exists, so deriving the
 * set from Redux would silently leak folded bodies.
 *
 * The catalog helpers at the bottom are therefore UI-only (rendering, and the
 * bounded local `computeContextInfo` fallback). See
 * `docs/adr/context-window.md` (window continuity with folded participation
 * removal).
 */

/**
 * Remove folded members from an ordered authority slice.
 *
 * The removal is unconditional — including the message the current request
 * answers. A folded group is hidden from the conversation view, so its bodies
 * must never reach a provider payload; a request whose own prompt is folded
 * therefore fails closed at its call site instead of re-injecting the hidden
 * body. Returns the same array instance when nothing is removed (no needless
 * identity churn downstream).
 */
export function excludeFoldedMessages(messages: Message[], foldedMessageIds: readonly string[] | undefined): Message[] {
  if (!Array.isArray(foldedMessageIds) || foldedMessageIds.length === 0 || messages.length === 0) {
    return messages
  }
  const foldedIds = new Set(foldedMessageIds)
  const kept = messages.filter((message) => !foldedIds.has(message?.id))
  return kept.length === messages.length ? messages : kept
}

/**
 * True when a message is a member of a folded group, per the authority
 * exclusion set carried by the read that produced the request slice. Used by
 * request preparation to fail closed when the triggering message itself is
 * hidden by a fold (never a silent re-injection, never an empty request).
 */
export function isMessageFolded(
  messageId: string | undefined,
  foldedMessageIds: readonly string[] | undefined
): boolean {
  if (!messageId || !Array.isArray(foldedMessageIds) || foldedMessageIds.length === 0) return false
  return foldedMessageIds.includes(messageId)
}

/** Projection-only: segments of one topic currently known to the renderer. */
function catalogSegmentsForTopic(topicId: string): TopicSegment[] {
  try {
    const state = store.getState() as any
    const ids: string[] = state?.topicSegments?.segmentsByTopic?.[topicId] ?? []
    const entities = state?.topicSegments?.segments?.entities ?? {}
    return ids.map((id: string) => entities[id]).filter(Boolean) as TopicSegment[]
  } catch {
    return []
  }
}

/**
 * UI-only: folded segments of one topic, in catalog order.
 *
 * Rendering may legitimately use this (the catalog is exactly what paints the
 * labels). Request/token/count paths must not.
 */
export function foldedSegmentsForTopic(topicId: string): TopicSegment[] {
  return catalogSegmentsForTopic(topicId).filter((segment) => segment.folded === true)
}

/**
 * UI-only fallback: full membership of every folded segment the renderer
 * currently has loaded.
 *
 * Never a request input — a folded group outside the loaded catalog is
 * invisible here while its persisted fold still exists in Main. Only
 * `computeContextInfo` (the bounded local estimate used before an authority
 * closure is available) may use it, and only as a projection-level estimate.
 */
export function foldedMessageIdsForTopic(topicId: string): Set<string> {
  const ids = new Set<string>()
  for (const segment of foldedSegmentsForTopic(topicId)) {
    for (const messageId of segment.messageIds) ids.add(messageId)
  }
  return ids
}
