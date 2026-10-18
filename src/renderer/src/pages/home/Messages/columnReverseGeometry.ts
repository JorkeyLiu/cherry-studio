/**
 * Single column-reverse scroll geometry primitive.
 *
 * The messages viewport renders newest-first inside `flex-direction:
 * column-reverse`, so production coordinates are:
 *   - bottom (newest) is `scrollTop ≈ 0`
 *   - visual top (oldest) is the most negative `scrollTop`
 *
 * Two distances, never confused:
 *   - `distanceFromBottom = abs(scrollTop)`
 *   - `distanceFromOldest = max(0, scrollHeight - clientHeight - abs(scrollTop))`
 *
 * All production scroll judgments (bottom snapshots, newer prefetch, oldest
 * replay validity) and pure tests should use these helpers instead of
 * hand-rolled `scrollHeight - scrollTop - clientHeight` formulas, which mix
 * up the oldest distance with the bottom distance under column-reverse.
 */

export const COLUMN_REVERSE_BOTTOM_THRESHOLD_PX = 50
export const COLUMN_REVERSE_OLDER_THRESHOLD_PX = 150
export const COLUMN_REVERSE_NEWER_PREFETCH_PX = 150

export interface ColumnReverseMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** Distance from the newest/bottom edge in a column-reverse container. */
export const distanceFromBottom = (scrollTop: number): number => Math.abs(scrollTop)

/** Distance from the oldest/top edge in a column-reverse container. */
export const distanceFromOldest = (metrics: ColumnReverseMetrics): number =>
  Math.max(0, metrics.scrollHeight - metrics.clientHeight - Math.abs(metrics.scrollTop))

/** True when the viewport rests at the newest/bottom vicinity. */
export const isAtBottom = (scrollTop: number, thresholdPx = COLUMN_REVERSE_BOTTOM_THRESHOLD_PX): boolean =>
  distanceFromBottom(scrollTop) <= thresholdPx

/** True when the viewport rests at the oldest/top vicinity. */
export const isAtOldest = (metrics: ColumnReverseMetrics, thresholdPx = COLUMN_REVERSE_OLDER_THRESHOLD_PX): boolean =>
  distanceFromOldest(metrics) <= thresholdPx

/**
 * True when the viewport is parked EXACTLY at the clamped oldest edge (no
 * scroll movement possible). 1px subpixel rounding tolerance only — never a
 * prefetch vicinity. Used solely for the direction-confirmed clamped-input
 * path (wheel/key with no scroll event); post-scroll paging keeps the
 * vicinity primitive above.
 */

/**
 * True when the viewport rests at the newest/bottom vicinity (browse edge
 * eligibility for the newer direction, mirroring `isAtOldest`).
 */
export const isAtNewest = (metrics: ColumnReverseMetrics, thresholdPx = COLUMN_REVERSE_NEWER_PREFETCH_PX): boolean =>
  distanceFromBottom(metrics.scrollTop) <= thresholdPx

/**
 * True when the viewport is parked EXACTLY at the clamped newest edge
 * (`scrollTop` 0, no scroll movement possible). Mirror of `isExactlyAtOldest`
 * for the direction-confirmed clamped-input path; post-scroll paging keeps the
 * vicinity primitive above.
 */
export const isExactlyAtNewest = (metrics: ColumnReverseMetrics): boolean => distanceFromBottom(metrics.scrollTop) <= 1
export const isExactlyAtOldest = (metrics: ColumnReverseMetrics): boolean => distanceFromOldest(metrics) <= 1

/**
 * Layout-space hold metric for ONE anchor row.
 *
 * The keeper's public hold coordinate is `viewportOffset` (row top minus
 * scroll-container top, i.e. `RouteVisualAnchor.offset`) — a coordinate that
 * moves for TWO independent reasons: CONTENT LAYOUT changed, or the container
 * itself scrolled. Holding `viewportOffset` alone therefore conflates the two
 * and fights a genuine user scroll (which is why a live gesture had to veto the
 * hold altogether).
 *
 * Under this container's fixed convention (see the module header: bottom/newest
 * is `scrollTop ≈ 0`, older is negative, so raising `scrollTop` moves content
 * up and `dViewportOffset/dScrollTop = -1`), the row's layout position is
 * `P = viewportOffset + scrollTop - c`. Differencing two samples of the same
 * row cancels the viewport/scroll coupling and leaves exactly the part of the
 * movement the CONTENT LAYOUT produced, with every pixel the user scrolled
 * removed. A pure user scroll therefore yields `0` (hold nothing, never cancel
 * the movement), and a pure layout change yields the growth to hold.
 */
export interface LayoutHoldSample {
  /** Row top minus scroll-container top (`RouteVisualAnchor.offset`). */
  viewportOffset: number
  /** Container `scrollTop` read in the SAME synchronous read as the offset. */
  scrollTop: number
}

/** Sub-pixel tolerance shared with the existing keeper hold. */
export const LAYOUT_HOLD_TOLERANCE_PX = 1

/** Layout displacement of the row between two consistent samples. */
export const layoutDisplacement = (baseline: LayoutHoldSample, now: LayoutHoldSample): number =>
  now.viewportOffset - baseline.viewportOffset + (now.scrollTop - baseline.scrollTop)

/**
 * The single scroll write that cancels a layout displacement: `scrollTop +=
 * displacement`. With no user scroll in the window this reduces to the plain
 * viewport hold (`scrollTop += Δoffset`); with a live user scroll it holds only
 * the content growth and leaves the user's own scrolling untouched.
 * Fail-closed (`null`, hold nothing) on non-finite input or inside tolerance.
 */
export const resolveLayoutHold = (
  baseline: LayoutHoldSample,
  now: LayoutHoldSample,
  tolerancePx = LAYOUT_HOLD_TOLERANCE_PX
): number | null => {
  if (
    !Number.isFinite(baseline.viewportOffset) ||
    !Number.isFinite(baseline.scrollTop) ||
    !Number.isFinite(now.viewportOffset) ||
    !Number.isFinite(now.scrollTop)
  ) {
    return null
  }
  const displacement = layoutDisplacement(baseline, now)
  return Math.abs(displacement) > tolerancePx ? displacement : null
}

/**
 * Re-baseline after `scrollTop += displacement` was applied: the row's next
 * consistent sample is the one the write itself produces (`viewportOffset`
 * moves opposite to the scroll write by the same amount, `scrollTop` moves by
 * it). Keeping this analytic avoids a second synchronous layout read, and keeps
 * the next trigger measuring ONLY the change that happened after the write.
 */
export const rebaseLayoutHold = (now: LayoutHoldSample, displacement: number): LayoutHoldSample => ({
  viewportOffset: now.viewportOffset - displacement,
  scrollTop: now.scrollTop + displacement
})
