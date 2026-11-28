import { type RefObject, useLayoutEffect, useRef, useState } from 'react'

import { COMPOSER_FLOATING_CONTROL_BAND_PX } from './composerFloatingBand'
import type { LayoutOperationRef } from './routeViewportController'

/**
 * Floating composer overlay geometry (single measurement source).
 *
 * The bottom composer (Inputbar) no longer occupies message-flow height: it
 * floats over the bottom of the chat canvas as one measured box
 * (`ComposerPlane`). A single ResizeObserver measures that box's actual
 * border-box height; the tail clearance the scroll content keeps is that
 * measured height plus the existing floating-control band
 * (`composerFloatingBand`, 32px), published as local CSS vars on the canvas.
 * The portaled drawer trigger (document.body) is never measured and the band
 * is never added twice: the measured box is the in-flow composer only.
 *
 * The hook never writes `scrollTop`, never focuses, never writes snapshots —
 * padding changes flow through the existing content ResizeObserver into the
 * shared keeper/follow paths. Local state only, no Redux, no persistence.
 */

/** CSS var on the chat canvas: the measured composer border-box height. */
export const COMPOSER_OVERLAY_HEIGHT_VAR = '--composer-overlay-height'

/** CSS var on the chat canvas: scroll-content tail + button clearance. */
export const COMPOSER_TAIL_INSET_VAR = '--composer-tail-inset'

/**
 * Normal bottom spacing between the composer outer box and the canvas bottom
 * edge. Mirrors the InputbarCore container bottom padding (12px): the plane
 * sits at bottom:0 so this padding is the single owner of the gap, the
 * measured box already includes it, and the tail inset never adds it twice.
 * Kept apart from the floating-control band: the gap is window spacing, the
 * band is the nav-trigger strip — one never substitutes for the other.
 */
export const COMPOSER_OVERLAY_BOTTOM_GAP_PX = 12

/**
 * Tail clearance for a measured composer box height: the actual in-flow box
 * plus the existing floating-control band. Non-finite/non-positive input
 * falls back to the band alone (pre-measure first paint), never to zero —
 * the trigger strip is always reserved.
 */
export const resolveComposerTailInset = (measuredHeightPx: unknown): number => {
  if (typeof measuredHeightPx !== 'number' || !Number.isFinite(measuredHeightPx) || measuredHeightPx <= 0) {
    return COMPOSER_FLOATING_CONTROL_BAND_PX
  }
  return measuredHeightPx + COMPOSER_FLOATING_CONTROL_BAND_PX
}

/**
 * Read the published tail inset (px) off an element inheriting the canvas
 * vars (e.g. `#messages`). Fail-closed 0: unset var, unmeasurable style, or
 * garbage never invents an inset — callers treat 0 as "no overlay info".
 */
export const readComposerTailInsetPx = (from: Element | null | undefined): number => {
  try {
    if (!from) return 0
    const computed = window.getComputedStyle(from)
    if (!computed) return 0
    const raw = computed.getPropertyValue(COMPOSER_TAIL_INSET_VAR)
    if (typeof raw !== 'string' || raw.length === 0) return 0
    const value = Number.parseFloat(raw)
    if (!Number.isFinite(value) || value < 0) return 0
    return value
  } catch {
    return 0
  }
}

/**
 * Composer overlay geometry: the measured border-box height plus the identity
 * of the logical height episode it belongs to.
 *
 * `revision` advances ONLY on a real height change (same-height reports are a
 * no-op, no state churn); `transitioning`/`transitionId` name the logical CSS
 * height animation in flight on the box itself (`transitionrun`/`end`/`cancel`
 * filtered to events whose target IS the box and whose property drives the
 * border-box height — child or non-height transitions never open an episode).
 * Together they let one logical layout operation own one composer height
 * episode (see `stepComposerOverlayOperation`): animated frames share one
 * operation, a non-animated change is one short operation.
 */
export interface ComposerOverlayGeometry {
  height: number
  revision: number
  transitioning: boolean
  transitionId: number
}

/**
 * Settle reason for the explicit composer overlay entry: the only causal
 * entry for composer-padding changes (the container observer never holds for
 * padding-only shapes).
 */
export const COMPOSER_OVERLAY_SETTLE_REASON = 'composer-overlay'

/**
 * Chat-local episode cursor for `stepComposerOverlayOperation`: the live
 * operation (null when no episode is open), the transition id it belongs to,
 * and the last settled geometry revision. Local state only — the controller
 * owns the operation truth, this only remembers where this surface stands.
 */
export interface ComposerOverlayLocalState {
  op: LayoutOperationRef | null
  opTransitionId: number
  lastSettledRevision: number
}

/**
 * One step of the composer overlay settle state machine (pure decision logic,
 * no timers, no rAF): advance one logical layout operation across one observed
 * geometry, settling synchronously through the caller's ports.
 *
 * - A height change outside any animation is one short operation
 *   (begin/advance → settle → end).
 * - Animated frames (`transitioning`, same `transitionId`) share one
 *   operation and settle every new revision; the animation end settles nothing
 *   new but ends the shared operation.
 * - After a genuine declare cancels the operation, remaining frames of the
 *   SAME animation never resume it (no settle, no new begin); a NEW animation
 *   (new `transitionId`) may begin a fresh operation.
 * - Unrelated re-runs (same revision, no transition change) settle nothing
 *   and begin nothing. The end of a cancelled animation only clears the local
 *   cursor, never settles or ends again.
 */
export const stepComposerOverlayOperation = (
  ports: {
    isCurrent: (op: LayoutOperationRef) => boolean
    begin: (source: string, routeKey: string) => LayoutOperationRef
    advance: (op: LayoutOperationRef, revision: number) => boolean
    end: (op: LayoutOperationRef) => boolean
    settle: (reason: string, op: LayoutOperationRef) => void
  },
  routeKey: string,
  geometry: ComposerOverlayGeometry,
  local: ComposerOverlayLocalState
): void => {
  // A locally held operation the controller no longer treats as current was
  // cancelled (genuine declare, supersession, invalidation): drop it. The
  // transition id stays so remaining frames of the same cancelled animation
  // are recognized below and never resume it.
  if (local.op !== null && !ports.isCurrent(local.op)) {
    local.op = null
  }
  if (local.op !== null) {
    const live = local.op
    // A newer logical animation while an episode is still open supersedes it:
    // end the stale episode and fall through to begin a fresh one below.
    if (geometry.transitionId !== local.opTransitionId) {
      try {
        ports.end(live)
      } catch {}
      local.op = null
    } else if (!geometry.transitioning) {
      // Animation end: settle a newer final revision first when the last frame
      // carried one, then end the shared operation. Nothing new settles when
      // the end carries no newer revision.
      if (geometry.revision > local.lastSettledRevision) {
        if (ports.advance(live, geometry.revision)) {
          ports.settle(COMPOSER_OVERLAY_SETTLE_REASON, live)
          local.lastSettledRevision = geometry.revision
        }
      } else {
        try {
          ports.advance(live, local.lastSettledRevision)
        } catch {}
      }
      try {
        ports.end(live)
      } catch {}
      local.op = null
      return
    } else if (geometry.revision > local.lastSettledRevision) {
      if (ports.advance(live, geometry.revision)) {
        ports.settle(COMPOSER_OVERLAY_SETTLE_REASON, live)
        local.lastSettledRevision = geometry.revision
      } else {
        local.op = null
      }
      return
    } else {
      // Same-revision animation frame: nothing new to settle, wait for the
      // next revision or the animation end.
      return
    }
  }
  // No live episode here (never begun, normally ended, or cancelled above).
  // The end of a cancelled animation only clears the local cursor — it never
  // settles under a stale identity.
  if (!geometry.transitioning && geometry.transitionId !== 0 && geometry.transitionId === local.opTransitionId) {
    local.opTransitionId = 0
    return
  }
  // No new revision, no new transition: an unrelated re-run settles nothing.
  if (geometry.revision <= local.lastSettledRevision) return
  if (geometry.transitioning) {
    // Remaining frames of the same cancelled animation never resume it; only
    // a NEW animation (new transition id) begins a fresh operation.
    if (geometry.transitionId === local.opTransitionId && local.opTransitionId !== 0) return
    const op = ports.begin(COMPOSER_OVERLAY_SETTLE_REASON, routeKey)
    local.op = op
    local.opTransitionId = geometry.transitionId
    if (ports.advance(op, geometry.revision)) {
      ports.settle(COMPOSER_OVERLAY_SETTLE_REASON, op)
      local.lastSettledRevision = geometry.revision
    } else {
      local.op = null
    }
    return
  }
  // A non-animated height change is one short operation: settle synchronously
  // (the caller's layout phase already publishes the new padding) and end
  // immediately so the final write's echo is retained for the follow-up
  // native scroll.
  const op = ports.begin(COMPOSER_OVERLAY_SETTLE_REASON, routeKey)
  if (ports.advance(op, geometry.revision)) {
    ports.settle(COMPOSER_OVERLAY_SETTLE_REASON, op)
    local.lastSettledRevision = geometry.revision
  }
  try {
    ports.end(op)
  } catch {}
  local.op = null
  local.opTransitionId = geometry.transitionId
}

/**
 * Measure the floating composer box height (border-box px) with episode
 * identity (see `ComposerOverlayGeometry`).
 *
 * First frame is measured synchronously in the layout phase; a single
 * ResizeObserver on the box reports later resizes (textarea growth, tool-row
 * show/hide). Same-height reports are a no-op (no state churn, no revision).
 * Box-height CSS transitions are bounded by native `transitionrun`/`end`/
 * `cancel` listeners on the box itself (filtered to the box target + the
 * height property); child transitions never open an episode. Without a
 * ResizeObserver the fallback is one sync measure plus a window resize
 * re-measure. Cleanup disconnects/unsubscribes exactly once.
 *
 * Never touches scroll position, focus, snapshots, or shared state.
 */
export const useComposerOverlayHeight = (targetRef: RefObject<HTMLElement | null>): ComposerOverlayGeometry => {
  const [geometry, setGeometry] = useState<ComposerOverlayGeometry>({
    height: 0,
    revision: 0,
    transitioning: false,
    transitionId: 0
  })
  const geometryRef = useRef(geometry)
  geometryRef.current = geometry
  const transitionIdRef = useRef(0)

  useLayoutEffect(() => {
    const target = targetRef.current
    if (!target) return
    let disposed = false
    const measure = (): void => {
      if (disposed) return
      let next = 0
      try {
        const rect = target.getBoundingClientRect()
        if (rect && Number.isFinite(rect.height) && rect.height > 0) {
          next = rect.height
        }
      } catch {
        return
      }
      if (next <= 0) return
      const prev = geometryRef.current
      if (prev.height === next) return
      const revision = prev.revision + 1
      const nextGeometry: ComposerOverlayGeometry = { ...prev, height: next, revision }
      geometryRef.current = nextGeometry
      setGeometry(nextGeometry)
    }
    const isBoxHeightTransition = (e: Event): boolean => {
      try {
        if (e.target !== target) return false
        const propertyName = (e as Event & { propertyName?: unknown }).propertyName
        return propertyName === 'height'
      } catch {
        return false
      }
    }
    const onTransitionRun = (e: Event): void => {
      if (disposed || !isBoxHeightTransition(e)) return
      transitionIdRef.current += 1
      const transitionId = transitionIdRef.current
      const prev = geometryRef.current
      if (prev.transitioning && prev.transitionId === transitionId) return
      const nextGeometry: ComposerOverlayGeometry = { ...prev, transitioning: true, transitionId }
      geometryRef.current = nextGeometry
      setGeometry(nextGeometry)
    }
    const onTransitionDone = (e: Event): void => {
      if (disposed || !isBoxHeightTransition(e)) return
      const prev = geometryRef.current
      if (!prev.transitioning) return
      const nextGeometry: ComposerOverlayGeometry = { ...prev, transitioning: false }
      geometryRef.current = nextGeometry
      setGeometry(nextGeometry)
    }
    measure()
    target.addEventListener('transitionrun', onTransitionRun)
    target.addEventListener('transitionend', onTransitionDone)
    target.addEventListener('transitioncancel', onTransitionDone)
    if (typeof ResizeObserver === 'function') {
      let observer: ResizeObserver | null = null
      try {
        observer = new ResizeObserver(measure)
        observer.observe(target)
      } catch {
        observer = null
      }
      const onResize = (): void => measure()
      window.addEventListener('resize', onResize)
      return () => {
        disposed = true
        try {
          target.removeEventListener('transitionrun', onTransitionRun)
        } catch {}
        try {
          target.removeEventListener('transitionend', onTransitionDone)
        } catch {}
        try {
          target.removeEventListener('transitioncancel', onTransitionDone)
        } catch {}
        try {
          observer?.disconnect()
        } catch {}
        try {
          window.removeEventListener('resize', onResize)
        } catch {}
      }
    }
    const onResize = (): void => measure()
    window.addEventListener('resize', onResize)
    return () => {
      disposed = true
      try {
        target.removeEventListener('transitionrun', onTransitionRun)
      } catch {}
      try {
        target.removeEventListener('transitionend', onTransitionDone)
      } catch {}
      try {
        target.removeEventListener('transitioncancel', onTransitionDone)
      } catch {}
      try {
        window.removeEventListener('resize', onResize)
      } catch {}
    }
  }, [targetRef])

  return geometry
}
