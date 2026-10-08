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

/**
 * Retained-projection-first admission for page reactivation
 * (Chat→Settings→Chat, same selected route).
 *
 * Pure presentation validation against the CURRENT renderer-owned window and
 * state — never whole-topic completeness/freshness (projection never proves
 * authority; cooperates with current updates/streams). True only when every
 * condition holds:
 * - this is a detached-lifetime reactivation (`wasActivation`) for the same
 *   selected/displayed route (route changes/deletion fall back safely);
 * - no deletion-fallback owns this route (deletion path keeps `latest`);
 * - a non-empty retained window exists;
 * - anchored restores: the requested stable anchor is covered by the retained
 *   window AND the current loaded projection AND a connected DOM row
 *   (measurable geometry; folded-hidden rows still count — the hidden settle
 *   reveals them before measuring);
 * - anchorless restores: only the bottom case restores in place (re-assert
 *   bottom pre-paint); anchorless non-bottom falls back to the existing
 *   route-local default path.
 *
 * Divider sessions never reach here (the narrow refusal above keeps their
 * clicked-offset continuation); this predicate is TOP-only.
 */
export interface RetainedWindowInPlaceInput {
  wasActivation: boolean
  selectedTopicId: string
  selectedRoute: RouteId
  displayedTopicId: string
  displayedRoute: RouteId
  deletionPending: boolean
  hasRetainedWindow: boolean
  /** Canonical saved anchor (`messageId`, legacy `anchorId` fallback). Null = anchorless. */
  canonicalAnchor: string | null
  isAtBottom: boolean
  retainedContainsAnchor: boolean
  loadedContainsAnchor: boolean
  domAnchorResident: boolean
}

export const shouldRestoreRetainedWindowInPlace = (input: RetainedWindowInPlaceInput): boolean => {
  if (!input.wasActivation) return false
  if (input.deletionPending) return false
  if (input.selectedTopicId !== input.displayedTopicId) return false
  if (input.selectedRoute !== input.displayedRoute) return false
  if (!input.hasRetainedWindow) return false
  if (input.canonicalAnchor) {
    return input.retainedContainsAnchor && input.loadedContainsAnchor && input.domAnchorResident
  }
  // Anchorless: bottom re-asserts in place; every other anchorless shape
  // (same-route raw scrollTop, no-snapshot default) uses the existing
  // route-local default path so no bogus stable snapshot is invented here.
  return input.isAtBottom
}

/**
 * Validated-continuation geometric acceptance (production epsilon, NOT E2E
 * measurement tolerance): anchor intra-row offset within 1px and true bottom
 * (column-reverse scrollTop 0) within 1px. This matches the existing
 * production alignment-write epsilon used by the viewport transition
 * (`applyViewportFirstPosition`: `abs(delta) > 1` writes) and the pagination
 * compensation epsilon (`routeRestoreAnchor`: `epsilonPx = 1`). The E2E
 * contract tolerances (12px anchor / 100px bottom) are measurement/test
 * budgets and must never gate production geometry: the snapshot commit stores
 * the target `wantOffset`, so accepted geometry must already be accurate
 * within the same 1px production epsilon. `COLUMN_REVERSE_BOTTOM_THRESHOLD`
 * (50px) only classifies bottom proximity, never geometric alignment.
 */
export const RETAINED_CONTINUATION_ALIGN_EPS_PX = 1

/** Pure offset check: measured anchor offset already at its saved target (1px). */
export const isRetainedAnchorOffsetAligned = (haveOffset: number, wantOffset: number): boolean => {
  if (!Number.isFinite(haveOffset) || !Number.isFinite(wantOffset)) return false
  return Math.abs(haveOffset - wantOffset) <= RETAINED_CONTINUATION_ALIGN_EPS_PX
}

/** Pure bottom check: column-reverse scrollTop already at true bottom (1px). */
export const isRetainedBottomAligned = (scrollTop: number): boolean => {
  if (!Number.isFinite(scrollTop)) return false
  return Math.abs(scrollTop) <= RETAINED_CONTINUATION_ALIGN_EPS_PX
}

/**
 * Single shared retained-continuation geometry helper (production use by the
 * pre-paint retained activation block; unit tests cover it directly).
 *
 * Contract: exact/no-op verified geometry -> zero writes; covered measurable
 * mismatch -> ONE synchronous anchor/bottom correction here, then an
 * immediate remeasure that must verify within the same 1px epsilon.
 * Unmeasurable geometry (missing/disconnected row, hidden row, zero-size
 * container, non-finite rects) or a correction that does not verify
 * (clamped/failed write) returns `aligned: false` with NO fictional success:
 * the caller keeps its guards and falls back to the existing hidden
 * full/in-place restore. Never invents a snapshot; never samples identity,
 * epoch, or ownership (those stay with the controller caller).
 */
export const alignRetainedViewportOnce = (input: {
  container: HTMLElement
  rowEl: HTMLElement | null
  anchorId: string | null
  wantOffset: number | null
  isAtBottom: boolean
  isRowVisible: boolean
}): { aligned: boolean; writes: 0 | 1 } => {
  try {
    const container = input.container
    if (!container || typeof container.getBoundingClientRect !== 'function') return { aligned: false, writes: 0 }
    if (input.anchorId && input.wantOffset !== null && Number.isFinite(input.wantOffset)) {
      const want = input.wantOffset
      const rowEl = input.rowEl
      if (!rowEl || !rowEl.isConnected) return { aligned: false, writes: 0 }
      if (input.isRowVisible !== true) return { aligned: false, writes: 0 }
      const containerRect = container.getBoundingClientRect()
      if (
        !Number.isFinite(containerRect.width) ||
        !Number.isFinite(containerRect.height) ||
        !Number.isFinite(containerRect.top) ||
        containerRect.width <= 0 ||
        containerRect.height <= 0
      ) {
        return { aligned: false, writes: 0 }
      }
      if (!Number.isFinite(container.clientHeight) || container.clientHeight <= 0) {
        return { aligned: false, writes: 0 }
      }
      const rowRect = rowEl.getBoundingClientRect()
      if (!Number.isFinite(rowRect.top) || !Number.isFinite(rowRect.height) || rowRect.height <= 0) {
        return { aligned: false, writes: 0 }
      }
      const have = rowRect.top - containerRect.top
      if (!Number.isFinite(have)) return { aligned: false, writes: 0 }
      if (isRetainedAnchorOffsetAligned(have, want)) return { aligned: true, writes: 0 }
      try {
        container.scrollTop += have - want
      } catch {
        return { aligned: false, writes: 0 }
      }
      try {
        const containerAfter = container.getBoundingClientRect()
        const rowAfter = rowEl.getBoundingClientRect()
        if (!Number.isFinite(containerAfter.top) || !Number.isFinite(rowAfter.top)) {
          return { aligned: false, writes: 1 }
        }
        const haveAfter = rowAfter.top - containerAfter.top
        if (isRetainedAnchorOffsetAligned(haveAfter, want)) return { aligned: true, writes: 1 }
        return { aligned: false, writes: 1 }
      } catch {
        return { aligned: false, writes: 1 }
      }
    }
    if (!input.anchorId && input.isAtBottom === true) {
      if (!Number.isFinite(container.scrollTop)) return { aligned: false, writes: 0 }
      if (!Number.isFinite(container.clientHeight) || container.clientHeight <= 0) {
        return { aligned: false, writes: 0 }
      }
      if (isRetainedBottomAligned(container.scrollTop)) return { aligned: true, writes: 0 }
      try {
        container.scrollTop = 0
      } catch {
        return { aligned: false, writes: 0 }
      }
      try {
        if (isRetainedBottomAligned(container.scrollTop)) return { aligned: true, writes: 1 }
        return { aligned: false, writes: 1 }
      } catch {
        return { aligned: false, writes: 1 }
      }
    }
    return { aligned: false, writes: 0 }
  } catch {
    return { aligned: false, writes: 0 }
  }
}

export interface RetainedContinuationInput extends RetainedWindowInPlaceInput {
  /** Anchored restores require a finite saved intra-row offset target. */
  wantOffsetFinite: boolean
}

/**
 * Validated-continuation admission (pure): the in-place presentation checks
 * PLUS a provable geometry target. Anchored restores need a finite saved
 * offset (otherwise there is nothing measurable to continue); anchorless
 * bottom reuses the in-place bottom rule. Divider sessions never reach here
 * (the narrow refusal keeps their clicked-offset continuation). Identity,
 * coverage, epoch, and ownership guards stay with the controller caller;
 * this predicate never samples geometry itself.
 */
export const shouldContinueRetainedViewport = (input: RetainedContinuationInput): boolean => {
  if (!shouldRestoreRetainedWindowInPlace(input)) return false
  if (input.canonicalAnchor) return input.wantOffsetFinite
  return input.isAtBottom
}

/**
 * Bootstrap restore identity-commit gate (pure, no DOM sampling).
 *
 * The bootstrap `restore` completion preserves ONE immutable requested
 * target (message id + finite desired intra-row offset) captured from the
 * plan before the async navigate. The explicit identity commit
 * (`commitDisplayedStableWithAnchor`) may run ONLY when every condition
 * holds:
 * - a requested id + finite desired offset exists (otherwise the
 *   capture/default fallback owns the completion);
 * - the committed projection still covers the requested target AND its DOM
 *   row is resident + visible (fold-hidden/missing rows never commit);
 * - the current route/epoch/ownership still matches (stale completions never
 *   commit under a newer session);
 * - the requested row's actual geometry already verified aligned within the
 *   shared 1px production epsilon (`alignRetainedViewportOnce.aligned`).
 *
 * A failed/clamped/missing geometry returns false so the caller takes the
 * existing fail-visible path preserving the prior lawful snapshot — never a
 * fabricated identity commit, never a crossing-first capture.
 */
export interface BootstrapRestoreAnchorGate {
  requestedId: string | null
  wantOffset: number | null
  projectionCovers: boolean
  domResident: boolean
  rowVisible: boolean
  topicMatch: boolean
  routeMatch: boolean
  epochCurrent: boolean
  mounted: boolean
  aligned: boolean
}

export const isBootstrapRestoreAnchorCommittable = (gate: BootstrapRestoreAnchorGate): boolean => {
  if (!gate.requestedId) return false
  if (gate.wantOffset === null || !Number.isFinite(gate.wantOffset)) return false
  if (!gate.projectionCovers) return false
  if (!gate.domResident) return false
  if (!gate.rowVisible) return false
  if (!gate.topicMatch) return false
  if (!gate.routeMatch) return false
  if (!gate.epochCurrent) return false
  if (!gate.mounted) return false
  return gate.aligned === true
}
export type { RouteViewportSnapshot }
