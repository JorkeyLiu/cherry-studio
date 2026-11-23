import type { CommittedChromeProjection } from '@renderer/utils/routeCommittedChrome'
import type { RouteScopedSegment } from '@renderer/utils/topicSegmentRoute'
import { useRef } from 'react'

/** Bounded retention: a route switch only ever needs the outgoing + incoming projections. */
const MAX_RETAINED_ROUTES = 4

export interface DisplayedRouteSegments {
  /**
   * Group chrome for the DISPLAYED window (the route the committed DOM belongs
   * to, not the selected route). Structural display only — mutation authority
   * rides `isDisplayCurrent`, never these entries.
   */
  segments: RouteScopedSegment[]
  /**
   * True only when `segments` is the SELECTED route's accepted projection AND
   * the displayed window already belongs to that route (same-route/version
   * co-commit, same visible transaction). Consumers must treat the entries as
   * read-only structure while false — even when an entry claims
   * `headerOwnedByRoute`, it qualifies the displayed (outgoing) route, never
   * the selected (incoming) one, so it must not back a write affordance.
   */
  isDisplayCurrent: boolean
}

/**
 * Resolve the authority segment a group header may render for mutation.
 * Display structure and mutation authority are separate: while the displayed
 * window lags the selected route (`isDisplayCurrent` false) the header keeps
 * its row (no teardown) but renders read-only (null entry ⇒ fail-closed in
 * `TopicSegmentLine`). Pure helper so the gating contract is unit-testable.
 */
export function resolveChromeAuthoritySegment(
  routeSegment: RouteScopedSegment | null | undefined,
  isDisplayCurrent: boolean
): RouteScopedSegment | null {
  if (!isDisplayCurrent) return null
  return routeSegment ?? null
}

/**
 * In-flow group-chrome selector co-committed with the displayed message
 * window.
 *
 * The mounted window lags the synchronous selected route key: on a
 * topic/branch switch the old route's window stays rendered while the new
 * route's snapshot is still pending — and the accepted projection can also
 * land BEFORE the window commits. Selecting chrome by the selected key in
 * either skew direction moves or drops headers above still-visible rows of
 * the other route (a visible 32px anchor round-trip).
 *
 * This selector keys retention by routeKey and exposes the projection for
 * the DISPLAYED route only:
 * - accepted projection + displayed window on the same route ⇒ the accepted
 *   entries, `isDisplayCurrent` true (the single frame both agree; window and
 *   group structure commit in the same visible transaction);
 * - otherwise the last accepted projection OF THE DISPLAYED ROUTE (the old
 *   window keeps its old structure, stably — never blanked, never the new
 *   route's);
 * - window-first (displayed advanced, nothing hook-accepted for it yet): the
 *   window commit's own co-committed structure when present (published in the
 *   same batch as the window, so the first visible frame already hosts the
 *   target route's headers); otherwise the latest retained projection of the
 *   same topic, so shared-prefix groups keep their headers through the
 *   composer's covers-window guard while route-only groups wait for the
 *   accepted projection. Never another topic's, never invented.
 * It never invents chrome:
 * - first mount with a pending projection still yields the (empty) fresh
 *   list — nothing retained, nothing rendered;
 * - a topic switch with nothing retained for the new displayed route yields
 *   the fresh (empty) pending list;
 * - a genuinely empty accepted projection (`isCurrent` with zero groups)
 *   replaces the retained one immediately, so a segment-less route never
 *   shows stale headers (and the composer's own covers-window guard stays
 *   the final fail-closed gate for any window/projection race).
 */
export function useRetainedRouteSegments(
  topicId: string,
  routeKey: string,
  segments: RouteScopedSegment[],
  isCurrent: boolean,
  displayedKey: string,
  committed: CommittedChromeProjection | null = null
): DisplayedRouteSegments {
  const retainedRef = useRef<Map<string, RouteScopedSegment[]>>(new Map())
  const committedKeyRef = useRef<string | null>(null)
  const retain = (key: string, entries: RouteScopedSegment[]): void => {
    const retained = retainedRef.current
    retained.delete(key)
    retained.set(key, entries)
    while (retained.size > MAX_RETAINED_ROUTES) {
      const oldest = retained.keys().next()
      if (oldest.done) break
      retained.delete(oldest.value)
    }
  }
  if (isCurrent) {
    retain(routeKey, segments)
  }
  // Window-commit co-commit: the target route's structure published in the
  // SAME batch as its window. It is the accepted projection for its route
  // (Main-qualified blocks for the addressed route, from the same bundled
  // structure the chat surface's one scoped read projects) — never mere
  // retention — so it reads as current once the displayed window and the
  // selected route both name its route. A later commit for another route
  // overwrites this.
  if (committed) {
    retain(committed.routeKey, committed.segments)
    committedKeyRef.current = committed.routeKey
  }
  // Same-route/version co-commit: the accepted projection is exposed only on
  // the render where the displayed window already belongs to its route.
  if (isCurrent && routeKey === displayedKey) {
    return { segments, isDisplayCurrent: true }
  }
  const committedKey = committedKeyRef.current
  if (committedKey !== null && committedKey === displayedKey && committedKey === routeKey) {
    const forCommitted = retainedRef.current.get(committedKey)
    if (forCommitted) {
      return { segments: forCommitted, isDisplayCurrent: true }
    }
  }
  const retained = retainedRef.current
  const forDisplayed = retained.get(displayedKey)
  if (forDisplayed) {
    return { segments: forDisplayed, isDisplayCurrent: false }
  }
  const topicPrefix = `${topicId}::`
  let latest: RouteScopedSegment[] | undefined
  for (const [key, value] of retained) {
    if (key.startsWith(topicPrefix)) latest = value
  }
  return { segments: latest ?? segments, isDisplayCurrent: false }
}
