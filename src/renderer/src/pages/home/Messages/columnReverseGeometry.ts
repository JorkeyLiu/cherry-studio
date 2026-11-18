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

/** Read equality: at/below this the two samples are the same geometry (echo / float noise). Never a hold, never accumulated drift. */
export const LAYOUT_MEASURE_EPS_PX = 1e-6
/** No-correction threshold: below half a native quantum a request would round to a no-op or oscillate, so the residual is retained and accumulated. Default = DPR1 quantum half (1/2); DPR2 callers pass 0.25. */
export const LAYOUT_HOLD_THRESHOLD_PX = 0.5
/**
 * Hold threshold for a known layout scroll quantum: exactly half the quantum.
 * Pure, no window/DOM access. Invalid quantum (non-finite/<=0) falls back to
 * the DPR1 default so callers stay fail-closed without a second truth.
 */
export const resolveLayoutHoldThresholdForPixelQuantum = (pixelQuantum: unknown): number => {
  if (typeof pixelQuantum !== 'number' || !Number.isFinite(pixelQuantum) || pixelQuantum <= 0) {
    return LAYOUT_HOLD_THRESHOLD_PX
  }
  return pixelQuantum / 2
}
/**
 * Hold threshold for a known device-pixel ratio: half of `1/dpr`.
 * Pure, no window/DOM access. Invalid DPR (non-finite/<=0/non-number)
 * falls back to the DPR1 default (0.5), i.e. DPR=1.
 */
export const resolveLayoutHoldThresholdForDpr = (dpr: unknown): number => {
  if (typeof dpr !== 'number' || !Number.isFinite(dpr) || dpr <= 0) return LAYOUT_HOLD_THRESHOLD_PX
  const quantum = 1 / dpr
  if (!Number.isFinite(quantum) || quantum <= 0) return LAYOUT_HOLD_THRESHOLD_PX
  return quantum / 2
}
/** Clamp/realize witness: at/below half a quantum is rounding, above it proves a real physical clamp. Quantum-safe without DPR hard-coding. */
export const LAYOUT_REALIZE_TOLERANCE_PX = 0.5
/** Scroll-stillness witness for a baseline remembered across an unreadable-geometry frame. Its own true-pair proof; NOT tightened by the visual epsilon. */
export const LAYOUT_DROPPED_WITNESS_TOLERANCE_PX = 1
/** @deprecated Historic single constant (kept = dropped-witness value for compat). New code uses the split contract above. */
export const LAYOUT_HOLD_TOLERANCE_PX = LAYOUT_DROPPED_WITNESS_TOLERANCE_PX

/** Layout displacement of the row between two consistent samples. */
export const layoutDisplacement = (baseline: LayoutHoldSample, now: LayoutHoldSample): number =>
  now.viewportOffset - baseline.viewportOffset + (now.scrollTop - baseline.scrollTop)

/**
 * Keeper precision contract (same-route hold, VIEWPORT-13/14).
 *
 * P = viewportOffset + scrollTop is the row's layout position: a pure user
 * scroll moves the two terms oppositely (Δoffset = −ΔscrollTop) and cancels
 * to 0, while pure CONTENT LAYOUT shifts P by the growth to hold. The hold
 * (`scrollTop += d`) therefore corrects only layout and can never rewind a
 * live gesture.
 *
 * Three separations, never one constant: MEASURE_EPS (read equality) ≠
 * HOLD_THRESHOLD (no-correction, retain-and-accumulate) ≠ REALIZE_TOLERANCE
 * (clamp witness). Baseline math: with hold baseline B, pre-write sample S,
 * requested d = P(S) − P(B) and ACTUAL realized scroll delta r, the next
 * baseline carries P = P(B) + r, i.e. `{ offset: S.offset − d,
 * scrollTop: realized }`. The owed residual (d − r) stays measurable for
 * later accumulation; seeding the requested d instead (P = P(S)) would erase
 * it and bake un-realized precision into the baseline. Exact writes
 * (r == d) reduce to the classic analytic form. Half-quantum bounds reach
 * the nearest representable stable position in one write: finer quanta only
 * shrink rounding (still realized), coarser quanta fail closed into the
 * re-sample path, never a false analytic. No DPR hard-coding, no 1px snap,
 * no settle timer.
 */

/**
 * The single scroll write that cancels a layout displacement: `scrollTop +=
 * displacement`. With no user scroll in the window this reduces to the plain
 * viewport hold (`scrollTop += Δoffset`); with a live user scroll it holds only
 * the content growth and leaves the user's own scrolling untouched.
 * Fail-closed (`null`, hold nothing) on non-finite input or at/below the
 * no-correction threshold (strict `>`: exactly half a quantum never writes,
 * so a rounded write can never reverse direction on the next frame).
 */
export const resolveLayoutHold = (
  baseline: LayoutHoldSample,
  now: LayoutHoldSample,
  tolerancePx = LAYOUT_HOLD_THRESHOLD_PX
): number | null => {
  if (
    !Number.isFinite(baseline.viewportOffset) ||
    !Number.isFinite(baseline.scrollTop) ||
    !Number.isFinite(now.viewportOffset) ||
    !Number.isFinite(now.scrollTop)
  ) {
    return null
  }
  const threshold =
    typeof tolerancePx === 'number' && Number.isFinite(tolerancePx) && tolerancePx > 0
      ? tolerancePx
      : LAYOUT_HOLD_THRESHOLD_PX
  const displacement = layoutDisplacement(baseline, now)
  return Math.abs(displacement) > threshold ? displacement : null
}

/**
 * One keeper observation step: the retain-and-accumulate policy in pure form.
 *
 * - No baseline yet (or unreadable sample): seed from this sample, hold nothing.
 * - `|raw| ≤ MEASURE_EPS`: echo / float noise — re-seed, never write, never drift.
 * - `|raw| ≤ HOLD_THRESHOLD`: small-but-real layout — hold nothing NOW and KEEP
 *   the old baseline so consecutive sub-pixel steps accumulate toward the
 *   quantum half instead of being discarded.
 * - Above it: return the displacement; the caller compensates and re-bases via
 *   `rebaseAfterCompensation` (actual-linked), which owns the baseline update.
 */
export interface LayoutHoldStep {
  displacement: number | null
  baseline: LayoutHoldSample | null
  retained: boolean
}
export const stepLayoutHold = (
  baseline: LayoutHoldSample | null,
  sample: LayoutHoldSample,
  thresholdPx = LAYOUT_HOLD_THRESHOLD_PX
): LayoutHoldStep => {
  if (!baseline) {
    if (!Number.isFinite(sample.viewportOffset) || !Number.isFinite(sample.scrollTop)) {
      return { displacement: null, baseline: null, retained: false }
    }
    return { displacement: null, baseline: sample, retained: false }
  }
  if (
    !Number.isFinite(baseline.viewportOffset) ||
    !Number.isFinite(baseline.scrollTop) ||
    !Number.isFinite(sample.viewportOffset) ||
    !Number.isFinite(sample.scrollTop)
  ) {
    return { displacement: null, baseline, retained: true }
  }
  const raw = layoutDisplacement(baseline, sample)
  if (!Number.isFinite(raw)) return { displacement: null, baseline, retained: true }
  if (Math.abs(raw) <= LAYOUT_MEASURE_EPS_PX) {
    return { displacement: null, baseline: sample, retained: false }
  }
  const threshold =
    typeof thresholdPx === 'number' && Number.isFinite(thresholdPx) && thresholdPx > 0
      ? thresholdPx
      : LAYOUT_HOLD_THRESHOLD_PX
  const hold = resolveLayoutHold(baseline, sample, threshold)
  if (hold === null) return { displacement: null, baseline, retained: true }
  return { displacement: hold, baseline, retained: false }
}
/**
 * Dropped-baseline recovery: the TRUE pair remembered across an
 * unreadable-geometry frame, or null when unusable.
 *
 * The remembered pair (`rememberUnreadableHold` copies the keeper's own last
 * true pair: offset + scrollTop read in one synchronous block) IS a genuine
 * measurement, so recovery restores it whole — `{ dropped.offset,
 * dropped.scrollTop }` — never a mixed pair with the live `sample.scrollTop`.
 * A mixed pair reduces the metric to an offset difference and charges a pure
 * user scroll (Δoffset = −ΔscrollTop) to layout: with the half-quantum
 * threshold a 1px scroll then mis-fires a −1px rollback. The whole-pair form
 * keeps P = offset + scrollTop, so genuine scrolling cancels to zero exactly.
 * The scroll-stillness witness (same route + row, |ΔscrollTop| ≤ witness)
 * only bounds how stale the remembered pair may be; it never enters the
 * geometry. Stale/foreign/non-finite → null (seed fresh, never replay).
 */
export interface DroppedHoldBaseline {
  routeKey: string
  anchorKey: string
  viewportOffset: number
  scrollTop: number
}
export const resolveDroppedHoldBaseline = (
  dropped: DroppedHoldBaseline | null,
  sample: LayoutHoldSample,
  routeKey: string,
  anchorKey: string
): LayoutHoldSample | null => {
  if (!dropped) return null
  if (dropped.routeKey !== routeKey || dropped.anchorKey !== anchorKey) return null
  if (!Number.isFinite(dropped.viewportOffset) || !Number.isFinite(dropped.scrollTop)) return null
  if (!Number.isFinite(sample.viewportOffset) || !Number.isFinite(sample.scrollTop)) return null
  if (Math.abs(sample.scrollTop - dropped.scrollTop) > LAYOUT_DROPPED_WITNESS_TOLERANCE_PX) return null
  return { viewportOffset: dropped.viewportOffset, scrollTop: dropped.scrollTop }
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

/**
 * Did the container realize a compensation write?
 *
 * `scrollTop += displacement` is a REQUEST: a real physical boundary clamps it,
 * and the container then sits somewhere else than the arithmetic says. Only a
 * realized write may seed the next baseline analytically. At/below half a
 * quantum is native rounding (owned proof: nearest 1 CSS px at DPR1); above it
 * proves a true clamp.
 */
export const didRealizeCompensation = (
  requestedScrollTop: number,
  realizedScrollTop: number,
  tolerancePx = LAYOUT_REALIZE_TOLERANCE_PX
): boolean =>
  Number.isFinite(requestedScrollTop) &&
  Number.isFinite(realizedScrollTop) &&
  Math.abs(realizedScrollTop - requestedScrollTop) <= tolerancePx

/**
 * Next layout-hold baseline after `scrollTop += displacement`, decided against
 * what the container ACTUALLY realized.
 *
 * - Realized write: the actual-linked analytic pair `{ offset: before.offset −
 *   displacement, scrollTop: realized.scrollTop }` (P = P(baseline) + actual).
 *   No second layout read; the owed residual (requested − actual) stays
 *   measurable and accumulates instead of being baked away. Exact writes are
 *   identical to the classic analytic rebase.
 * - Clamped write (real physical boundary): the analytic pair describes a
 *   position the container never reached, so it must not seed later
 *   calculations — the caller re-samples the anchor row synchronously and that
 *   realized pair becomes the baseline.
 * - `null` when neither pair is provable (no re-sampled geometry for a clamped
 *   write, or non-finite input): the hold is invalidated and the next
 *   observation only seeds a fresh baseline.
 */
export const rebaseAfterCompensation = (
  before: LayoutHoldSample,
  displacement: number,
  realized: { scrollTop: number; viewportOffset: number | null }
): LayoutHoldSample | null => {
  if (!Number.isFinite(realized.scrollTop)) return null
  if (didRealizeCompensation(before.scrollTop + displacement, realized.scrollTop)) {
    if (!Number.isFinite(before.viewportOffset) || !Number.isFinite(displacement)) return null
    return { viewportOffset: before.viewportOffset - displacement, scrollTop: realized.scrollTop }
  }
  const { viewportOffset } = realized
  if (viewportOffset === null || !Number.isFinite(viewportOffset)) return null
  return { viewportOffset, scrollTop: realized.scrollTop }
}
