import { type RefObject, useLayoutEffect, useRef, useState } from 'react'

import { COMPOSER_FLOATING_CONTROL_BAND_PX } from './composerFloatingBand'

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
 * Measure the floating composer box height (border-box px).
 *
 * First frame is measured synchronously in the layout phase; a single
 * ResizeObserver on the box reports later resizes (textarea growth, tool-row
 * show/hide). Same-height reports are a no-op (no state churn). Without a
 * ResizeObserver the fallback is one sync measure plus a window resize
 * re-measure. Cleanup disconnects/unsubscribes exactly once.
 *
 * Never touches scroll position, focus, snapshots, or shared state.
 */
export const useComposerOverlayHeight = (targetRef: RefObject<HTMLElement | null>): number => {
  const [height, setHeight] = useState(0)
  const heightRef = useRef(0)

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
      if (heightRef.current === next) return
      heightRef.current = next
      setHeight(next)
    }
    measure()
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
        window.removeEventListener('resize', onResize)
      } catch {}
    }
  }, [targetRef])

  return height
}
