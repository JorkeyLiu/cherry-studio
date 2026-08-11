import type { ContextTurn } from '@renderer/services/contextTurnService'
import { resolveAnchorTurnIndex } from '@renderer/services/contextTurnService'
import type { TopicAnchor } from '@renderer/types'

/**
 * Pure, mode-neutral context-window helpers shared by the compute layer
 * (computeContextInfo), the settings UI, and focused tests.
 *
 * There is exactly one context window model: anchor-to-topic-end. When a valid
 * manual anchor exists, the window starts at that turn and grows as the topic
 * grows. When no (valid) anchor exists, the window start is derived from the
 * assistant's default context count (`contextCount`):
 *
 *   - finite N  → start at the most recent N turns (never sends more than N)
 *   - null (∞)  → start at the first turn of the topic
 *
 * The derivation is kept here as a pure function so the UI can persist the
 * derived start as an anchor while the pure compute layer applies the exact
 * same fallback immediately — full history is never transiently sent.
 */

/**
 * Returns the index of the turn that should open the default context window.
 *
 * Semantics:
 *   - Empty turn list → -1 (nothing to anchor).
 *   - `contextCount === null` (unlimited) → 0 (first turn of the topic,
 *     i.e. the whole topic).
 *   - Finite `contextCount` → the turn that leaves at most N turns selected;
 *     clamped to a minimum of 1 (min context count is 1) and to the first
 *     turn when the topic has fewer turns than N.
 *
 * @param turns chronological turns of the topic
 * @param contextCount the assistant's default context count (null = unlimited)
 */
export function resolveDefaultAnchorIndex(turns: readonly ContextTurn[], contextCount: number | null): number {
  if (turns.length === 0) {
    return -1
  }
  if (contextCount === null) {
    return 0
  }
  const n = Math.max(1, Math.floor(contextCount))
  return Math.max(0, turns.length - n)
}

/**
 * Derives the persisted `TopicAnchor.groupKey` for the given turn — the key that
 * `resolveAnchorTurnIndex` resolves back to EXACTLY this turn (LOCK-FIX-1):
 *
 *   - user-initiated turn → the user message id (the canonical group key)
 *   - any other turn      → the first message's OWN id (the assistant or system
 *     message id). The message id is used rather than an askId so the key stays
 *     unique even when an askId references a user message that also appears in an
 *     earlier turn — a derived anchor can therefore never slide to a different
 *     turn (the askId semantics remain supported in the resolver for legacy and
 *     manual anchors).
 *
 * Returns null only for an empty turn (never produced by buildContextTurns), in
 * which case no anchor should be persisted.
 */
export function getTurnAnchorGroupKey(turn: ContextTurn): string | null {
  const userMessage = turn.messages.find((m) => m.role === 'user')
  if (userMessage) {
    return userMessage.id
  }
  const firstMessage = turn.messages[0]
  return firstMessage ? firstMessage.id : null
}

/**
 * Pure decision for the default-anchor persistence effect (LOCK-CTX-2, LOCK-CTX-4,
 * LOCK-FIX-3). Given the topic turns, the assistant's default context count
 * and the currently persisted anchor, decide whether the effect must write an
 * anchor, delete a stale anchor, or do nothing:
 *
 *   1. Empty topic turn list → nothing can be anchored: delete any persisted
 *      anchor, matching TokenCount reset behavior. Deleting only when an anchor
 *      actually exists is what prevents a dispatch loop (one write, then none).
 *   2. A valid active anchor (resolvable to a turn) is authoritative → no write.
 *   3. Otherwise derive the default start and persist it, unless it already
 *      matches the persisted anchor.
 */
export function resolveDefaultAnchorPersistence(
  turns: readonly ContextTurn[],
  contextCount: number | null,
  currentAnchor: TopicAnchor | undefined
): { type: 'none' } | { type: 'delete' } | { type: 'persist'; anchor: TopicAnchor } {
  if (turns.length === 0) {
    return currentAnchor ? { type: 'delete' } : { type: 'none' }
  }
  if (currentAnchor?.kind === 'active' && resolveAnchorTurnIndex(turns, currentAnchor.groupKey) >= 0) {
    return { type: 'none' }
  }
  const derivedIndex = resolveDefaultAnchorIndex(turns, contextCount)
  if (derivedIndex < 0) {
    return { type: 'none' }
  }
  const groupKey = getTurnAnchorGroupKey(turns[derivedIndex])
  if (!groupKey) {
    return { type: 'none' }
  }
  if (currentAnchor?.kind === 'active' && currentAnchor.groupKey === groupKey) {
    return { type: 'none' }
  }
  return { type: 'persist', anchor: { kind: 'active', groupKey } }
}

/**
 * Slider position for a persisted context count (identical semantics on both
 * assistant setting surfaces — LOCK-CTX-9):
 *
 *   - finite 1..99 → the same number
 *   - null (unlimited) → endpoint 100, displayed as ∞
 *   - legacy 0 / undefined → clamped to 1 (minimum valid value)
 */
export function contextCountToSliderValue(contextCount: number | null | undefined): number {
  if (contextCount === null) {
    return 100
  }
  if (typeof contextCount !== 'number' || !Number.isFinite(contextCount)) {
    return 1
  }
  return Math.min(99, Math.max(1, Math.floor(contextCount)))
}

/**
 * Persisted context count for a slider position (inverse of
 * {@link contextCountToSliderValue}):
 *
 *   - endpoint 100 → null (unlimited)
 *   - any other position → the finite number (1..99)
 */
export function sliderValueToContextCount(value: number): number | null {
  if (value >= 100) {
    return null
  }
  return Math.max(1, Math.floor(value))
}
