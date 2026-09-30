/**
 * Atomic viewport transition: target-route visibility gated on first positioning.
 *
 * Contract (approved fix, single solution):
 * - The target route projection may commit and be measured, but must not be
 *   paint-visible until its first correct scroll position is synchronously
 *   applied pre-paint (useLayoutEffect).
 * - While `phase === 'positioning'` the scroll container is hidden but
 *   measurable (`visibility: hidden` keeps layout; never `display: none`).
 * - Reveal is tied to the same topic/route/epoch; stale callbacks fail
 *   visible (never leave the container hidden).
 * - The bounded position stabilizer runs only AFTER reveal for dynamic layout
 *   drift and never owns first placement.
 * - Incremental route loading is preserved: the old viewport stays visible
 *   during the windowed fetch; `positioning` begins only together with the
 *   target `window/apply` commit in the same React batch.
 *
 * Authority/projection/loading semantics are unchanged; this module owns only
 * the visual reveal timing plus the synchronous first-position write.
 */

import { getMessageRowById } from './domVisibility'

/** Visual phase exposed via `data-viewport-phase` (diagnostic, no user strings). */
export type ViewportTransitionPhase = 'idle' | 'positioning' | 'revealed'

/** First-position plan: every supported restoration kind for route switches. */
export type ViewportFirstPositionPlan =
  | { kind: 'bottom' }
  | {
      kind: 'message'
      messageId: string
      wantOffset: number | null
      fallbackScrollTop: number | null
      /** When true and the row + raw fallback both miss, settle at the
       * oldest edge (deterministic route-local default) instead of leaving
       * the commit position untouched. Used by divider switches so a
       * partial window still lands near the pagination edge and auto-pages
       * under the divider anchor during the transition. Never outgoing
       * geometry. */
      edgeFallbackOnMissing?: boolean
    }
  | {
      kind: 'divider'
      dividerKey: string
      anchorMessageId: string
      wantOffset: number
      fallbackMessageId: string | null
      fallbackOffset: number | null
      rawScrollTop: number | null
      /** Same oldest-edge contract as the message kind (see above). */
      edgeFallbackOnMissing?: boolean
    }
  | { kind: 'scrollTop'; scrollTop: number }
  | { kind: 'none' }

/** Live guard for reveal: topic + route + epoch + mounted must all match. */
export const isViewportTransitionCurrent = (input: {
  topicMatch: boolean
  routeMatch: boolean
  epochCurrent: boolean
  mounted: boolean
}): boolean => input.topicMatch && input.routeMatch && input.epochCurrent && input.mounted

/**
 * First-position outcome (explicit restore lifecycle, never a bare boolean).
 * - `placed`: the requested restore identity is resident and aligned (divider
 *   row, requested message row, bottom, same-route explicit fallback, or the
 *   explicitly selected valid shared-message fallback). Final success: the
 *   caller may stabilize for layout quiet and then commit the route stable
 *   snapshot.
 * - `searching`: INTERMEDIATE search placement. The requested identity is
 *   outside the resident window, so the container was parked at the safe
 *   oldest edge only to enable pagination. The target projection may reveal
 *   at this edge, but it remains in a restoring/searching state: the caller
 *   must NOT commit a stable snapshot, must NOT clear the restore intent,
 *   must NOT release ownership, and must drive restore-owned pagination until
 *   the requested identity is resident/aligned/quiet.
 * - `unplaced`: no position applied (caller still reveals fail-visible; the
 *   stabilizer must not drag).
 */
export type ViewportFirstPositionOutcome = 'placed' | 'searching' | 'unplaced'

const cssEscape = (value: string): string => {
  try {
    if (
      typeof CSS !== 'undefined' &&
      typeof (CSS as unknown as { escape?: (v: string) => string }).escape === 'function'
    ) {
      return (CSS as unknown as { escape: (v: string) => string }).escape(value)
    }
  } catch {
    // fall through
  }
  return value
}

const oldestEdgeScrollTop = (container: HTMLElement): number => {
  try {
    return Math.min(0, container.clientHeight - container.scrollHeight)
  } catch {
    return 0
  }
}

/**
 * Synchronously apply the first scroll position. Best-effort but atomic: a
 * single DOM write with no rAF, no async, no stabilizer. Returns the explicit
 * outcome (`placed` vs `searching` vs `unplaced`).
 *
 * Fallback order is route-local only: requested row → shared/fallback row →
 * same-route raw scrollTop (explicit plan value, never inherited outgoing
 * geometry by the callers) → oldest edge when `edgeFallbackOnMissing` is set.
 * The oldest-edge parking is INTERMEDIATE search placement (`searching`), not
 * final success: the requested identity is still outside the resident window
 * and restore-owned pagination must continue under the same ownership.
 *
 * Message-row lookups use the raw DOM id (`getMessageRowById`, i.e. raw
 * `getElementById('message-'+id)` with no `CSS.escape`): writers use the raw
 * id and `getElementById` requires the raw string. `CSS.escape` stays only
 * for `querySelector`/selector contexts (divider rows).
 */
export const applyViewportFirstPosition = (
  container: HTMLElement,
  plan: ViewportFirstPositionPlan
): ViewportFirstPositionOutcome => {
  try {
    if (plan.kind === 'none') {
      return 'unplaced'
    }
    if (plan.kind === 'bottom') {
      if (Math.abs(container.scrollTop) > 1) container.scrollTop = 0
      return 'placed'
    }
    if (plan.kind === 'scrollTop') {
      if (Math.abs(container.scrollTop - plan.scrollTop) > 1) container.scrollTop = plan.scrollTop
      return 'placed'
    }
    const containerRect = container.getBoundingClientRect()
    if (plan.kind === 'message') {
      const el = getMessageRowById(plan.messageId)
      if (!el) {
        // Missing requested DOM target: same-route raw scrollTop when the
        // plan carries one (explicit final fallback → placed), else the
        // oldest edge when the caller armed it (INTERMEDIATE search placement
        // → searching, never a stable success), else unplaced (caller still
        // reveals fail-visible, stabilizer must not drag).
        if (plan.fallbackScrollTop !== null && Number.isFinite(plan.fallbackScrollTop)) {
          if (Math.abs(container.scrollTop - plan.fallbackScrollTop) > 1) {
            container.scrollTop = plan.fallbackScrollTop
          }
          return 'placed'
        }
        if (plan.edgeFallbackOnMissing) {
          const edge = oldestEdgeScrollTop(container)
          if (Math.abs(container.scrollTop - edge) > 1) container.scrollTop = edge
          return 'searching'
        }
        return 'unplaced'
      }
      if (plan.wantOffset === null || !Number.isFinite(plan.wantOffset)) {
        el.scrollIntoView({ behavior: 'auto', block: 'start' })
        return 'placed'
      }
      const have = el.getBoundingClientRect().top - containerRect.top
      const delta = have - plan.wantOffset
      if (Math.abs(delta) > 1) container.scrollTop += delta
      return 'placed'
    }
    // divider: same logical divider row to same offset; fallback chain is
    // shared-message -> oldest edge when armed (never outgoing geometry,
    // never bottom). The fork-message scrollIntoView step applies only
    // without the edge contract: parking the newest row at the top would
    // strand a partial window far from the pagination edge instead of
    // auto-paging under the divider anchor during the transition.
    const row = document.querySelector(`[data-divider-key="${cssEscape(plan.dividerKey)}"]`) as HTMLElement | null
    if (row && row.isConnected) {
      const have = row.getBoundingClientRect().top - containerRect.top
      const delta = have - plan.wantOffset
      if (Math.abs(delta) > 1) container.scrollTop += delta
      return 'placed'
    }
    if (plan.fallbackMessageId) {
      const el = getMessageRowById(plan.fallbackMessageId)
      if (el && plan.fallbackOffset !== null && Number.isFinite(plan.fallbackOffset)) {
        const have = el.getBoundingClientRect().top - containerRect.top
        const delta = have - plan.fallbackOffset
        if (Math.abs(delta) > 1) container.scrollTop += delta
        return 'placed'
      }
      if (el && !plan.edgeFallbackOnMissing) {
        el.scrollIntoView({ behavior: 'auto', block: 'start' })
        return 'placed'
      }
    }
    if (!plan.fallbackMessageId && plan.anchorMessageId && !plan.edgeFallbackOnMissing) {
      const el = getMessageRowById(plan.anchorMessageId)
      if (el) {
        el.scrollIntoView({ behavior: 'auto', block: 'start' })
        return 'placed'
      }
    }
    if (plan.rawScrollTop !== null && Number.isFinite(plan.rawScrollTop)) {
      if (Math.abs(container.scrollTop - plan.rawScrollTop) > 1) {
        container.scrollTop = plan.rawScrollTop
      }
      return 'placed'
    }
    if (plan.edgeFallbackOnMissing) {
      const edge = oldestEdgeScrollTop(container)
      if (Math.abs(container.scrollTop - edge) > 1) container.scrollTop = edge
      return 'searching'
    }
    return 'unplaced'
  } catch {
    return 'unplaced'
  }
}
