/**
 * Route-restore preferred visual anchor.
 *
 * A route restore (divider switch or top-selector switch) declares which row
 * must stay visually still: either the logical divider row
 * (`{ kind: 'divider-row', dividerKey, targetOffset }`) or a saved message row
 * (`{ kind: 'message-row', messageId, targetOffset }`). The anchor is bound to
 * `topicId / routeId / restoreEpoch` and has an explicit lifecycle: route,
 * topic, deletion, unmount, or user-cancel clears the active anchor. A queued
 * older-edge pagination intent carries only a detached snapshot (stable
 * identity + targetOffset, never a live ref) so it cannot cross generations —
 * the existing intent five-tuple guard (topic/route/generation/deletion/
 * resident) still discards stale intents.
 *
 * Pagination compensation prefers the snapshot's current element offset and
 * keeps its targetOffset; only when the target is missing or disconnected does
 * it fall back to the existing viewport-top message path. Ordinary user
 * pagination carries no preferred anchor and behaves exactly as before.
 */

/** Detached snapshot attached to a queued older-edge intent (no epoch binding). */
export type PreferredRestoreAnchorSnapshot =
  | { kind: 'divider-row'; dividerKey: string; targetOffset: number }
  | { kind: 'message-row'; messageId: string; targetOffset: number }

/** Active restore anchor with explicit topic/route/epoch lifecycle binding. */
export type ActiveRestoreAnchor =
  | {
      kind: 'divider-row'
      dividerKey: string
      targetOffset: number
      topicId: string
      routeId: string | null
      restoreEpoch: number
    }
  | {
      kind: 'message-row'
      messageId: string
      targetOffset: number
      topicId: string
      routeId: string | null
      restoreEpoch: number
    }

export const createDividerRestoreAnchor = (input: {
  dividerKey: string
  targetOffset: number
  topicId: string
  routeId: string | null
  restoreEpoch: number
}): ActiveRestoreAnchor => ({
  kind: 'divider-row',
  dividerKey: input.dividerKey,
  targetOffset: input.targetOffset,
  topicId: input.topicId,
  routeId: input.routeId,
  restoreEpoch: input.restoreEpoch
})

export const createMessageRestoreAnchor = (input: {
  messageId: string
  targetOffset: number
  topicId: string
  routeId: string | null
  restoreEpoch: number
}): ActiveRestoreAnchor => ({
  kind: 'message-row',
  messageId: input.messageId,
  targetOffset: input.targetOffset,
  topicId: input.topicId,
  routeId: input.routeId,
  restoreEpoch: input.restoreEpoch
})

/** Pure validity: topic + route + restore epoch must all still match. */
export const isActiveRestoreAnchorCurrent = (
  anchor: ActiveRestoreAnchor | null | undefined,
  live: { topicId: string; routeId: string | null; restoreEpoch: number }
): boolean => {
  if (!anchor) return false
  return anchor.topicId === live.topicId && anchor.routeId === live.routeId && anchor.restoreEpoch === live.restoreEpoch
}

/**
 * Detach a snapshot for a queued intent. Copies only the stable identity plus
 * `targetOffset` (never the live ref/object), and only when the anchor is
 * still current for this topic/route/epoch. Returns null for ordinary user
 * pagination (no active anchor) so its behavior is unchanged.
 */
export const snapshotRestoreAnchor = (
  anchor: ActiveRestoreAnchor | null | undefined,
  live: { topicId: string; routeId: string | null; restoreEpoch: number }
): PreferredRestoreAnchorSnapshot | null => {
  if (!isActiveRestoreAnchorCurrent(anchor, live) || !anchor) return null
  if (anchor.kind === 'divider-row') {
    return { kind: 'divider-row', dividerKey: anchor.dividerKey, targetOffset: anchor.targetOffset }
  }
  return { kind: 'message-row', messageId: anchor.messageId, targetOffset: anchor.targetOffset }
}

export type PaginationCompensationDecision =
  | { kind: 'preferred'; delta: number }
  | { kind: 'fallback'; delta: number }
  | { kind: 'none' }

/**
 * Pure pagination compensation choice.
 *
 * `preferredCurrentOffset` is the snapshot target's current element offset
 * (null when the row is missing/disconnected). `fallbackDelta` is the already
 * computed viewport-top message delta (null when unavailable). Deltas at or
 * below 1px are settled (`none`). A missing preferred target falls through to
 * the fallback path; ordinary pagination passes `preferred: null` and keeps
 * the exact old behavior.
 */
export const decidePaginationCompensation = (input: {
  preferred: PreferredRestoreAnchorSnapshot | null | undefined
  preferredCurrentOffset: number | null | undefined
  fallbackDelta: number | null | undefined
}): PaginationCompensationDecision => {
  const epsilonPx = 1
  if (input.preferred) {
    const current = input.preferredCurrentOffset ?? null
    if (current !== null && Number.isFinite(current)) {
      const delta = current - input.preferred.targetOffset
      if (Math.abs(delta) > epsilonPx) return { kind: 'preferred', delta }
      return { kind: 'none' }
    }
    const fallback = input.fallbackDelta ?? null
    if (fallback !== null && Number.isFinite(fallback) && Math.abs(fallback) > epsilonPx) {
      return { kind: 'fallback', delta: fallback }
    }
    return { kind: 'none' }
  }
  const fallback = input.fallbackDelta ?? null
  if (fallback !== null && Number.isFinite(fallback) && Math.abs(fallback) > epsilonPx) {
    return { kind: 'fallback', delta: fallback }
  }
  return { kind: 'none' }
}

/**
 * Pure second-stabilizer guard: pagination must never start a stabilizer that
 * conflicts with an active route-restore stabilizer. Returns true only when a
 * short bounded pagination stabilizer is allowed (preferred anchor was used
 * for the immediate delta and no restore stabilizer is active).
 */
export const shouldStartPaginationStabilizer = (input: {
  hasActiveRestoreStabilizer: boolean
  usedPreferredAnchor: boolean
}): boolean => !input.hasActiveRestoreStabilizer && input.usedPreferredAnchor
