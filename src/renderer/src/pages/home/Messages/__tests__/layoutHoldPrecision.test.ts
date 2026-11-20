/**
 * Same-route keeper precision contract (failing-first).
 *
 * Business/math invariants the bounded fix must satisfy. The first block is
 * written against the pre-existing pure API so the old implementation fails
 * it and the fixed one passes without changing the test; the second block
 * covers the retain-and-accumulate step policy directly.
 */
import { describe, expect, it } from 'vitest'

import {
  didRealizeCompensation,
  LAYOUT_HOLD_THRESHOLD_PX,
  layoutDisplacement,
  rebaseAfterCompensation,
  resolveDroppedHoldBaseline,
  resolveLayoutHold,
  stepLayoutHold
} from '../flowScrollGeometry'

describe('keeper precision contract (gap-exposing)', () => {
  it('a +0.8px layout growth is held (one native quantum away, not ignored)', () => {
    expect(resolveLayoutHold({ viewportOffset: 0, scrollTop: 0 }, { viewportOffset: 0.8, scrollTop: 0 })).toBe(0.8)
  })

  it('a 1px layout growth is held (exactly one representable step)', () => {
    expect(resolveLayoutHold({ viewportOffset: 0, scrollTop: 0 }, { viewportOffset: 1, scrollTop: 0 })).toBe(1)
  })

  it('accumulated slow drift reaches the hold once it crosses the quantum half', () => {
    // Five retained +0.2px steps sum to +1.0 measured against the ORIGINAL
    // baseline (the keeper must retain, not re-seed on every small null).
    expect(resolveLayoutHold({ viewportOffset: 0, scrollTop: 0 }, { viewportOffset: 1.0, scrollTop: 0 })).toBe(1.0)
  })

  it('rebase seeds the ACTUAL realized scrollTop, not the requested fraction', () => {
    const sample = { viewportOffset: 120, scrollTop: 0 }
    const next = rebaseAfterCompensation(sample, 500, { scrollTop: 499.6, viewportOffset: null })
    expect(next).not.toBeNull()
    expect(next?.scrollTop).toBe(499.6)
  })

  it('a quantized +0.8 write preserves its -0.2 residual instead of hiding it', () => {
    // Base (0,0); layout +0.8 -> sample (0.8,0); native rounds the +0.8
    // request to +1. The next baseline must carry P = P_base + actual (+1),
    // so the still-owed -0.2 stays measurable and accumulates.
    const base = { viewportOffset: 0, scrollTop: 0 }
    const sample = { viewportOffset: 0.8, scrollTop: 0 }
    const d = layoutDisplacement(base, sample)
    expect(d).toBeCloseTo(0.8, 9)
    const rebased = rebaseAfterCompensation(sample, d, { scrollTop: 1, viewportOffset: null })
    expect(rebased).not.toBeNull()
    // Physical post-write geometry: offset moved opposite the actual write.
    const physical = { viewportOffset: 0.8 - 1, scrollTop: 1 }
    const pending = layoutDisplacement(rebased!, physical)
    expect(pending).toBeCloseTo(-0.2, 9)
    // ... yet small enough to stop: no second write, no direction reversal.
    expect(resolveLayoutHold(rebased!, physical)).toBeNull()
  })

  it('negative direction is symmetric: -0.828 via -1 leaves +0.172 pending but quiet', () => {
    const base = { viewportOffset: 100, scrollTop: 0 }
    const sample = { viewportOffset: 100 - 0.828125, scrollTop: 0 }
    const d = layoutDisplacement(base, sample)
    expect(d).toBeCloseTo(-0.828125, 9)
    expect(resolveLayoutHold(base, sample)).toBeCloseTo(-0.828125, 9)
    const rebased = rebaseAfterCompensation(sample, d, { scrollTop: -1, viewportOffset: null })
    expect(rebased).not.toBeNull()
    const physical = { viewportOffset: sample.viewportOffset + 1, scrollTop: -1 }
    const pending = layoutDisplacement(rebased!, physical)
    expect(pending).toBeCloseTo(0.171875, 9)
    expect(resolveLayoutHold(rebased!, physical)).toBeNull()
  })

  it('exact echo (no new layout) is a no-op and never re-writes', () => {
    const pair = { viewportOffset: 42.25, scrollTop: 7 }
    expect(layoutDisplacement(pair, pair)).toBe(0)
    expect(resolveLayoutHold(pair, pair)).toBeNull()
  })

  it('a true clamp never seeds an unreachable analytic pair', () => {
    const sample = { viewportOffset: 120, scrollTop: 0 }
    expect(didRealizeCompensation(sample.scrollTop + 7642.95, 0)).toBe(false)
    const next = rebaseAfterCompensation(sample, 7642.95, { scrollTop: 0, viewportOffset: 120 })
    expect(next).toEqual({ viewportOffset: 120, scrollTop: 0 })
    expect(resolveLayoutHold(next!, next!)).toBeNull()
  })
})

describe('keeper retain-and-accumulate step (stepLayoutHold)', () => {
  it('retains small-but-real layout so slow 0.2px steps accumulate and then hold once', () => {
    expect(LAYOUT_HOLD_THRESHOLD_PX).toBe(0.5)
    const baseline = { viewportOffset: 0, scrollTop: 0 }
    // +0.2px / +0.4px each hold nothing AND keep the original baseline, so
    // the third +0.2px step (total +0.6) holds against the RETAINED origin —
    // a per-frame re-seed would have discarded every step and never held.
    for (let i = 1; i <= 2; i++) {
      const sample = { viewportOffset: 0.2 * i, scrollTop: 0 }
      const step = stepLayoutHold(baseline, sample)
      expect(step.displacement).toBeNull()
      expect(step.retained).toBe(true)
      expect(step.baseline).toEqual(baseline)
    }
    const third = stepLayoutHold(baseline, { viewportOffset: 0.6000000000000001, scrollTop: 0 })
    expect(third.displacement).toBeCloseTo(0.6000000000000001, 9)
    expect(third.retained).toBe(false)
  })

  it('echo and float noise re-seed without writing and never drift', () => {
    const baseline = { viewportOffset: 42.25, scrollTop: 7 }
    const echo = stepLayoutHold(baseline, { viewportOffset: 42.25, scrollTop: 7 })
    expect(echo.displacement).toBeNull()
    expect(echo.retained).toBe(false)
    expect(echo.baseline).toEqual({ viewportOffset: 42.25, scrollTop: 7 })
    const noise = stepLayoutHold(baseline, { viewportOffset: 42.2500005, scrollTop: 7 })
    expect(noise.displacement).toBeNull()
    expect(noise.retained).toBe(false)
  })

  it('exactly half a quantum never writes in either direction (no reverse round-trip)', () => {
    const base = { viewportOffset: 0, scrollTop: 0 }
    expect(stepLayoutHold(base, { viewportOffset: 0.5, scrollTop: 0 }).displacement).toBeNull()
    expect(stepLayoutHold(base, { viewportOffset: -0.5, scrollTop: 0 }).displacement).toBeNull()
    expect(stepLayoutHold(base, { viewportOffset: 0.5001, scrollTop: 0 }).displacement).toBeCloseTo(0.5001, 9)
    expect(stepLayoutHold(base, { viewportOffset: -0.5001, scrollTop: 0 }).displacement).toBeCloseTo(-0.5001, 9)
  })

  it('a pure user scroll stays zero through the step (never held, never vetoed)', () => {
    const base = { viewportOffset: -60, scrollTop: 0 }
    const fwd = stepLayoutHold(base, { viewportOffset: -260, scrollTop: 200 })
    expect(fwd.displacement).toBeNull()
    expect(fwd.retained).toBe(false)
    const back = stepLayoutHold(base, { viewportOffset: 140, scrollTop: -200 })
    expect(back.displacement).toBeNull()
    expect(back.retained).toBe(false)
  })

  it('continuous then reversed drift nets correctly without oscillation', () => {
    // +0.2/+0.4 retained, +0.9 held; after one quantized +1 write the
    // residual (-0.1) plus a -0.3 reversal nets -0.4: retained, never reversed.
    const baseline = { viewportOffset: 0, scrollTop: 0 }
    for (const total of [0.2, 0.4]) {
      const step = stepLayoutHold(baseline, { viewportOffset: total, scrollTop: 0 })
      expect(step.displacement).toBeNull()
      expect(step.baseline).toEqual(baseline)
      expect(step.retained).toBe(true)
    }
    expect(stepLayoutHold(baseline, { viewportOffset: 0.9, scrollTop: 0 }).displacement).toBeCloseTo(0.9, 9)
    // Simulate the keeper write for +0.9 with a 1px-quantum setter: rounds to +1.
    const requested = 0.9
    const realizedDelta = 1
    const before = { viewportOffset: 0.9, scrollTop: 0 }
    const rebased = rebaseAfterCompensation(before, requested, { scrollTop: 1, viewportOffset: null })
    expect(rebased?.scrollTop).toBe(1)
    // Physical post-write geometry, then a -0.3 layout reversal lands on it.
    const physical = { viewportOffset: 0.9 - realizedDelta, scrollTop: 1 }
    const afterReversal = { viewportOffset: physical.viewportOffset - 0.3, scrollTop: 1 }
    const next = stepLayoutHold(rebased, afterReversal)
    expect(next.displacement).toBeNull()
    expect(next.retained).toBe(true)
    expect(next.baseline).toEqual(rebased)
  })

  it('quantum adaptation is proven by the actual setter, not a hard-coded DPR', () => {
    // Same +0.8 layout under three simulated setter quanta: the policy only
    // ever issues ONE write and the residual stays below the threshold.
    // (quantum 2 rounds the request to a no-op: the clamped path re-samples
    // instead of retrying forever.)
    for (const quantum of [1, 0.5, 2]) {
      const base = { viewportOffset: 0, scrollTop: 0 }
      const sample = { viewportOffset: 0.8, scrollTop: 0 }
      const d = layoutDisplacement(base, sample)
      const actual = Math.round(d / quantum) * quantum
      const qrebased = rebaseAfterCompensation(sample, d, {
        scrollTop: actual,
        viewportOffset: sample.viewportOffset - actual
      })
      expect(qrebased?.scrollTop).toBe(actual)
      const qphysical = { viewportOffset: sample.viewportOffset - actual, scrollTop: actual }
      const pending = layoutDisplacement(qrebased!, qphysical)
      expect(Math.abs(pending)).toBeLessThanOrEqual(LAYOUT_HOLD_THRESHOLD_PX)
      expect(resolveLayoutHold(qrebased!, qphysical)).toBeNull()
    }
  })
})

describe('dropped-baseline recovery is a TRUE pair (no mixed-pair rollback)', () => {
  const routeKey = 'topic-t::main'
  const anchorKey = 'message:m1'
  const dropped = { routeKey, anchorKey, viewportOffset: 100, scrollTop: 0 }

  it('a pure 1px user scroll after the drop holds nothing (old mixed pair mis-rolled −1)', () => {
    // Row unreadable for a frame; meanwhile the user scrolled +1 with no
    // layout: the live sample couples offset −1 with scrollTop +1.
    const sample = { viewportOffset: 99, scrollTop: 1 }
    const baseline = resolveDroppedHoldBaseline(dropped, sample, routeKey, anchorKey)
    // TRUE pair restored whole — never { dropped.offset, sample.scrollTop }.
    expect(baseline).toEqual({ viewportOffset: 100, scrollTop: 0 })
    // …so the P-metric cancels the genuine scroll to zero: no write.
    const step = stepLayoutHold(baseline, sample)
    expect(step.displacement).toBeNull()
    // Counterfactual: the old mixed-pair baseline measured an offset
    // difference of −1 and WOULD have fired a −1px rollback here.
    expect(resolveLayoutHold({ viewportOffset: dropped.viewportOffset, scrollTop: sample.scrollTop }, sample)).toBe(-1)
  })

  it('dropped +0.8 layout with no scroll still corrects', () => {
    const sample = { viewportOffset: 100.8, scrollTop: 0 }
    const baseline = resolveDroppedHoldBaseline(dropped, sample, routeKey, anchorKey)
    expect(baseline).toEqual({ viewportOffset: 100, scrollTop: 0 })
    expect(stepLayoutHold(baseline, sample).displacement).toBeCloseTo(0.8, 9)
  })

  it('a stale witness never replays: large scroll invalidates instead of holding', () => {
    // User scrolled +50 while the row was unreadable: the remembered pair is
    // too old to prove anything — no baseline, no hold charged to layout.
    const sample = { viewportOffset: 50, scrollTop: 50 }
    expect(resolveDroppedHoldBaseline(dropped, sample, routeKey, anchorKey)).toBeNull()
    const step = stepLayoutHold(null, sample)
    expect(step.displacement).toBeNull()
    expect(step.baseline).toEqual(sample)
  })

  it('foreign route/anchor and non-finite geometry never replay', () => {
    const sample = { viewportOffset: 100.8, scrollTop: 0 }
    expect(resolveDroppedHoldBaseline(dropped, sample, 'topic-other::main', anchorKey)).toBeNull()
    expect(resolveDroppedHoldBaseline(dropped, sample, routeKey, 'message:other')).toBeNull()
    expect(resolveDroppedHoldBaseline({ ...dropped, viewportOffset: NaN }, sample, routeKey, anchorKey)).toBeNull()
    expect(resolveDroppedHoldBaseline(dropped, { viewportOffset: NaN, scrollTop: 0 }, routeKey, anchorKey)).toBeNull()
  })

  it('a clamp-scale layout through the drop re-samples once and never replays', () => {
    // +7642.95 layout lands while the row was unreadable: the hold fires…
    const sample = { viewportOffset: 100 + 7642.95, scrollTop: 0 }
    const baseline = resolveDroppedHoldBaseline(dropped, sample, routeKey, anchorKey)
    const step = stepLayoutHold(baseline, sample)
    expect(step.displacement).toBeCloseTo(7642.95, 6)
    // …the container clamps at the boundary: re-sampled pair seeds, and the
    // same geometry re-observed is a no-op — no second charge, no loop.
    const next = rebaseAfterCompensation(sample, step.displacement!, {
      scrollTop: 0,
      viewportOffset: sample.viewportOffset
    })
    expect(next).toEqual({ viewportOffset: sample.viewportOffset, scrollTop: 0 })
    expect(resolveLayoutHold(next!, next!)).toBeNull()
  })
})
