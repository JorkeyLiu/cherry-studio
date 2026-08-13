import type { ContextTurn } from '@renderer/services/contextTurnService'
import type { AssistantSettings, ContextWindowAnchor } from '@renderer/types'

/**
 * Pure, model-neutral context-window helpers shared by the compute layer
 * (`computeContextInfo`), the settings UI, the anchor-mutation surfaces
 * (first establishment, TokenCount re-anchor, message anchor click,
 * compatibility repair), and focused tests.
 *
 * There is exactly one context window model: stable anchor-to-topic-end
 * (`docs/context-window.md`). The persisted per-topic anchor
 * (`contextWindowAnchor[topicId]`) is the start turn's group key. A
 * non-empty initialized topic has exactly one anchor; the window is the
 * anchor turn through the topic end. `contextCount` is the assistant default /
 * initial / reset window size and is used ONLY to derive the default window
 * position for first establishment and explicit re-anchor actions — changing
 * it never moves an existing anchor.
 *
 * This module contains no persistence or dispatch decision for derived
 * positions; the mutation helpers below return a decision object that callers
 * apply through ordinary `updateAssistantSettings` dispatch.
 */

export type ContextWindowAnchorMap = Record<string, ContextWindowAnchor | undefined>

/**
 * A pure decision about whether and how a topic's persisted anchor map should
 * change. `changed === true` means the caller should dispatch
 * `updateAssistantSettings({ contextWindowAnchor: anchorMap })`.
 */
export type AnchorDecision = {
  changed: boolean
  anchorMap: ContextWindowAnchorMap
}

/**
 * Returns the index of the turn that should open the default context window.
 *
 * Semantics (shared by first establishment and TokenCount re-anchor):
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
 * The default window position as a turn group key: the key of the turn that
 * `resolveDefaultAnchorIndex` selects, or `null` for an empty turn list.
 *
 * This is the position used for first establishment, TokenCount re-anchor,
 * and compatibility repair — exactly the position `contextCount` defines
 * (CW-1).
 */
export function deriveDefaultAnchorKey(turns: readonly ContextTurn[], contextCount: number | null): string | null {
  const index = resolveDefaultAnchorIndex(turns, contextCount)
  if (index < 0) {
    return null
  }
  return turns[index].key
}

/** Whether an anchor entry is present, active, and resolvable in `turns`. */
export function isResolvableAnchor(
  anchor: ContextWindowAnchor | undefined,
  turns: readonly ContextTurn[]
): anchor is ContextWindowAnchor {
  if (anchor?.kind !== 'active') {
    return false
  }
  // Resolution rules mirror `resolveAnchorTurnIndex`: user message id,
  // assistant askId, then non-user message own id (orphan assistant / system).
  return turns.some(
    (turn) =>
      turn.messages.some((m) => m.role === 'user' && m.id === anchor.groupKey) ||
      turn.messages.some((m) => m.role === 'assistant' && m.askId === anchor.groupKey) ||
      turn.messages.some((m) => m.role !== 'user' && m.id === anchor.groupKey)
  )
}

/**
 * First-establishment / compatibility-repair decision (exactly-once, never
 * recalculates a valid anchor).
 *
 * Rules:
 *   - A valid persisted anchor (active + resolvable in `turns`) is NEVER
 *     touched — returns `changed: false`.
 *   - An empty turn list → no anchor is created (`changed: false`); empty
 *     topics have no anchor.
 *   - Otherwise (missing / unresolvable / legacy anchor) the default window
 *     position (derived from `contextCount`) is persisted for the topic —
 *     `changed: true`.
 *
 * Callers apply the decision idempotently; re-running over an already
 * established anchor is a no-op.
 */
export function resolveAnchorEstablishDecision(
  anchorMap: ContextWindowAnchorMap | undefined,
  topicId: string,
  turns: readonly ContextTurn[],
  contextCount: number | null
): AnchorDecision {
  const current = anchorMap?.[topicId]
  if (isResolvableAnchor(current, turns)) {
    return { changed: false, anchorMap: { ...anchorMap } }
  }
  const defaultKey = deriveDefaultAnchorKey(turns, contextCount)
  if (defaultKey === null) {
    return { changed: false, anchorMap: { ...anchorMap } }
  }
  return {
    changed: true,
    anchorMap: { ...anchorMap, [topicId]: { kind: 'active', groupKey: defaultKey } }
  }
}

/**
 * TokenCount re-anchor decision (CW-4 · TokenCount re-anchor): the anchor is
 * moved to the CURRENT default window position derived from the current turns
 * and the CURRENT `contextCount`. An empty topic is a no-op (empty topics have
 * no anchor). When the anchor already sits at the default position, no change
 * is reported so callers do not churn.
 */
export function resolveAnchorReanchorDecision(
  anchorMap: ContextWindowAnchorMap | undefined,
  topicId: string,
  turns: readonly ContextTurn[],
  contextCount: number | null
): AnchorDecision {
  const defaultKey = deriveDefaultAnchorKey(turns, contextCount)
  if (defaultKey === null) {
    return { changed: false, anchorMap: { ...anchorMap } }
  }
  const current = anchorMap?.[topicId]
  if (current?.kind === 'active' && current.groupKey === defaultKey) {
    return { changed: false, anchorMap: { ...anchorMap } }
  }
  return {
    changed: true,
    anchorMap: { ...anchorMap, [topicId]: { kind: 'active', groupKey: defaultKey } }
  }
}

/**
 * Message-anchor interaction decision (CW-4 · message anchor control):
 *
 *   - Clicking a turn other than the current anchor → the anchor moves to
 *     that turn (`desiredGroupKey`).
 *   - Clicking the CURRENT anchored turn (or a turn that is no longer
 *     resolvable in `turns`) → re-anchor to the current default window
 *     position. The interaction NEVER leaves a non-empty initialized topic
 *     anchorless (CW-3/I-7).
 *   - Empty turn list → no change (empty topics have no anchor).
 */
export function resolveMessageAnchorDecision(
  anchorMap: ContextWindowAnchorMap | undefined,
  topicId: string,
  turns: readonly ContextTurn[],
  desiredGroupKey: string | null,
  contextCount: number | null
): AnchorDecision {
  if (desiredGroupKey === null) {
    return { changed: false, anchorMap: { ...anchorMap } }
  }
  const current = anchorMap?.[topicId]
  const isCurrentAnchor = current?.kind === 'active' && current.groupKey === desiredGroupKey
  const desiredResolvable = turns.some((turn) => turn.key === desiredGroupKey)

  if (!isCurrentAnchor && desiredResolvable) {
    return {
      changed: true,
      anchorMap: { ...anchorMap, [topicId]: { kind: 'active', groupKey: desiredGroupKey } }
    }
  }

  // Clicking the current anchor (or an unresolvable/stale turn) re-anchors to
  // the current default window position; an empty topic stays a no-op.
  return resolveAnchorReanchorDecision(anchorMap, topicId, turns, contextCount)
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

/**
 * Settings patch for a GENERIC assistant-settings reset that PRESERVES the
 * per-topic anchor map (docs/context-window.md CW-1): reset changes defaults
 * (`contextCount`, temperature, ...), never topic anchors.
 *
 * The default template's `contextWindowAnchor` is the empty map — spreading
 * it wholesale would wipe every persisted topic anchor. The current anchor
 * map is carried over instead. All other fields reset to the provided
 * defaults.
 *
 * `currentSettings` accepts the partial settings shape carried by
 * `Assistant.settings`.
 */
export function buildSettingsResetPatch(
  currentSettings: Partial<AssistantSettings> | undefined,
  defaults: AssistantSettings
): Partial<AssistantSettings> {
  return { ...defaults, contextWindowAnchor: currentSettings?.contextWindowAnchor ?? {} }
}
