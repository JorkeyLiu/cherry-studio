/**
 * TOP-pipeline intent isolation (narrow predicate, no new subsystem).
 *
 * Single-entry contract (coherent ONE activation/load owner):
 * - Detach is owned solely by `RouteViewportProvider` (`controller.detach()`).
 * - Attach reactivation is owned SOLELY by the single Messages TOP pipeline
 *   effect (connection-generation dep): it opens the guarded own-target `top`
 *   fetch-hold AND drives fetch → window → measured layout/quiet/alignment →
 *   atomic reveal → stable commit in the SAME bounded effect. No separate
 *   hook ever half-starts a transaction (request without load) — the prior
 *   split opener consumed `isActivationRequired` before the loader ran, so a
 *   skipped load left the latest window (msg00) instead of the saved anchor.
 * - This module keeps ONLY the narrow TOP-vs-divider isolation predicate
 *   used at the TOP entry points. Ordinary selector sessions are adopted via
 *   `adoptFetchHold`; divider-owned fetch-hold for the same target is never
 *   adopted nor overwritten.
 */

import type { RouteId, RouteViewportController, RouteViewportSnapshot } from './routeViewportController'

/**
 * TOP-pipeline intent isolation (narrow, TOP-specific): true only when a
 * divider-owned session actively owns the controller for this exact
 * topic/target. The TOP route effect + TOP fetch-hold adoption must refuse
 * while true — the TOP pipeline never consumes a divider epoch nor overwrites
 * it with a saved-snapshot plan (divider continue-here owns its clicked
 * offset). Foreign-target divider sessions are not refused here (different
 * target proceeds normally); top/generic/bootstrap sessions never refuse.
 * Shared `commitRouteWindowAtomic` stays generic (divider hidden fallback
 * uses it) — this gate lives only at the TOP entry points.
 */
export const shouldTopPipelineRefuseDividerIntent = (
  controller: RouteViewportController,
  topicId: string,
  targetRoute: RouteId
): boolean => {
  try {
    const live = controller.currentIntent
    if (live === null) return false
    if (live.kind !== 'divider') return false
    if (live.topicId !== topicId || live.targetRoute !== targetRoute) return false
    return controller.programmaticOwned
  } catch {
    return false
  }
}
export type { RouteViewportSnapshot }
