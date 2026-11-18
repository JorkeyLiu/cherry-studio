import store from '@renderer/store'
import type { Message } from '@renderer/types/newMessage'

/**
 * Folded (collapsed) turn participation, for every context consumer.
 *
 * Fold is a MESSAGE-LEVEL fact: every member of a folded turn carries
 * `folded: true` on its own row, so the exclusion set is read from message
 * rows only. The authority set that decides what a REQUEST sends, what the
 * token estimation counts, and what the context counts report is Main
 * authority: every context-closure / whole-topic-snapshot response carries
 * `foldedMessageIds`, read in the same SQLite snapshot as the messages. Those
 * consumers must use that list (`excludeFoldedMessages` / `isMessageFolded`
 * below) and never the renderer projection — an unloaded or stale window says
 * nothing about whether a persisted fold exists, so deriving the set from
 * Redux would silently leak folded bodies.
 *
 * There is no group-level fold: a segment carrying a stale `folded` flag never
 * contributes members here. See `docs/adr/context-window.md` (window
 * continuity with folded participation removal).
 */

/**
 * Remove folded members from an ordered authority slice.
 *
 * The removal is unconditional — including the message the current request
 * answers. A folded turn is hidden from the conversation view, so its bodies
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
 * True when a message is a member of a folded turn, per the authority exclusion
 * set carried by the read that produced the request slice. Used by request
 * preparation to fail closed when the triggering message itself is hidden by a
 * fold (never a silent re-injection, never an empty request).
 */
export function isMessageFolded(
  messageId: string | undefined,
  foldedMessageIds: readonly string[] | undefined
): boolean {
  if (!messageId || !Array.isArray(foldedMessageIds) || foldedMessageIds.length === 0) return false
  return foldedMessageIds.includes(messageId)
}

/**
 * UI-only fallback: the loaded messages of one topic that carry their own fold
 * flag.
 *
 * Never a request input — a folded turn outside the loaded window is invisible
 * here while its persisted fold still exists in Main. Only `computeContextInfo`
 * (the bounded local estimate used before an authority closure is available)
 * may use it, and only as a projection-level estimate.
 */
export function foldedMessageIdsForTopic(topicId: string): Set<string> {
  const ids = new Set<string>()
  try {
    const state = store.getState()
    const messageIds: string[] = state?.messages?.messageIdsByTopic?.[topicId] ?? []
    const entities = state?.messages?.entities ?? {}
    for (const id of messageIds) {
      if (entities[id]?.folded === true) ids.add(id)
    }
  } catch {
    // A store read must never break a caller's render or estimate path.
  }
  return ids
}
