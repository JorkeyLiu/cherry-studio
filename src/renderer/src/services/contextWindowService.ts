import type { ContextTurn } from '@renderer/services/contextTurnService'
import type { ContextStartOverride } from '@renderer/types'

/**
 * Pure, mode-neutral context-window helpers shared by the compute layer
 * (computeContextInfo), the settings UI, and focused tests.
 *
 * There is exactly one context window model: anchor-to-topic-end. When a valid
 * user context-start override exists, the window starts at that turn and grows
 * as the topic grows. When no (valid) override exists, the window start is
 * derived dynamically from the assistant's default context count
 * (`contextCount`):
 *
 *   - finite N  → start at the most recent N turns (never sends more than N)
 *   - null (∞)  → start at the first turn of the topic
 *
 * The resolved anchor is the single expression of the effective window start
 * (derived by `computeContextInfo` as `anchorGroupKey`); the persisted
 * `contextStartOverride[topicId]` holds ONLY a user-specified context start —
 * a derived anchor is projection, never persisted state. This module therefore
 * contains no persistence decision for derived anchors; the compute layer
 * derives the effective start on every call from the current messages and the
 * assistant's `contextCount` (plus a valid user override when present).
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
 * Reset decision for the TokenCount interaction. Deleting the persisted user
 * context-start override for `topicId` makes the effective context start fall
 * back to the dynamic derivation (assistant `contextCount` + current messages);
 * the resolved anchor is recomputed by `computeContextInfo`, never stored here.
 *
 * The `changed` flag is `true` only when an explicit entry actually existed, so
 * callers dispatch at most once and never churn on absent overrides. This helper
 * strictly deletes — it never creates or replaces an override.
 *
 * @param overrides the persisted per-topic override map (may be undefined/absent)
 * @param topicId the topic whose user context-start override is being reset
 */
export function resolveContextStartOverrideReset(
  overrides: Record<string, ContextStartOverride | undefined> | undefined,
  topicId: string
): { changed: boolean; overrides: Record<string, ContextStartOverride | undefined> } {
  const next = { ...overrides }
  if (!(topicId in next)) {
    return { changed: false, overrides: next }
  }
  delete next[topicId]
  return { changed: true, overrides: next }
}

/**
 * Slider position for a persisted context count (identical semantics on both
 * assistant setting surfaces):
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
