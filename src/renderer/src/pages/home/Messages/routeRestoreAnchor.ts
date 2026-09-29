/**
 * Pagination-compensation anchor (NOT route-transition truth).
 *
 * A queued older-edge pagination intent may carry a detached preferred
 * snapshot (`PreferredRestoreAnchorSnapshot`: stable identity + targetOffset,
 * never a live ref) so the immediate compensation prefers the restore row
 * and only falls back to the viewport-top message when the target is
 * missing/disconnected. Ordinary user pagination carries null and behaves
 * exactly as before.
 *
 * Ownership note: route-transition truth (epoch/intent/phase/displayed/
 * rendered/anchor) lives SOLELY in `RouteViewportController`. This module
 * owns no lifecycle, no epoch, no session — it is a pure pagination helper
 * and must never compete with the controller. The former `ActiveRestoreAnchor`
 * lifecycle helpers were removed as dead second truth (zero production
 * callers); pagination snapshots are built directly from
 * `controller.activeAnchor` at queue time in Messages.
 */

/** Detached snapshot attached to a queued older-edge intent (no epoch binding). */
export type PreferredRestoreAnchorSnapshot =
  | { kind: 'divider-row'; dividerKey: string; targetOffset: number }
  | { kind: 'message-row'; messageId: string; targetOffset: number }

type PaginationCompensationDecision =
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
