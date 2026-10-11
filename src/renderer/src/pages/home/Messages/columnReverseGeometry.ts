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
export const isExactlyAtOldest = (metrics: ColumnReverseMetrics): boolean => distanceFromOldest(metrics) <= 1
