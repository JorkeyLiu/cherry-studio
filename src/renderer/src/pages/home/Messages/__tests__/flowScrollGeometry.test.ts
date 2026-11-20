/**
 * Single normal-flow scroll geometry primitive: the visual top (oldest) is
 * `scrollTop ≈ 0` and the bottom (newest) is the container's own scroll travel
 * `scrollHeight - clientHeight`. One metrics shape, one set of distances —
 * guards the production/E2E direction confusion (bottom ≠ oldest).
 */
import { describe, expect, it } from 'vitest'

import {
  didRealizeCompensation,
  distanceFromBottom,
  distanceFromOldest,
  FLOW_BOTTOM_THRESHOLD_PX,
  FLOW_COORDINATE_SPACE,
  FLOW_NEWER_PREFETCH_PX,
  FLOW_OLDER_THRESHOLD_PX,
  isAtBottom,
  isAtNewest,
  isAtOldest,
  isExactlyAtNewest,
  isExactlyAtOldest,
  layoutDisplacement,
  maxScrollTop,
  readScrollMetrics,
  rebaseAfterCompensation,
  rebaseLayoutHold,
  resolveLayoutHold
} from '../flowScrollGeometry'

/** 1000px of content in a 400px viewport → 600px of scroll travel. */
const view = (scrollTop: number, scrollHeight = 1000, clientHeight = 400) => ({
  scrollTop,
  scrollHeight,
  clientHeight
})

describe('flowScrollGeometry (single production primitive)', () => {
  it('maxScrollTop is the scrollable travel, clamped at zero', () => {
    expect(maxScrollTop(view(0))).toBe(600)
    expect(maxScrollTop(view(600))).toBe(600)
    // Content fits the viewport: no travel at all.
    expect(maxScrollTop(view(0, 300, 400))).toBe(0)
  })

  it('distanceFromBottom is zero at the container travel and grows toward the top', () => {
    expect(distanceFromBottom(view(600))).toBe(0)
    expect(distanceFromBottom(view(590))).toBe(10)
    expect(distanceFromBottom(view(0))).toBe(600)
    // Never negative, even if a browser reports an over-scrolled value.
    expect(distanceFromBottom(view(700))).toBe(0)
  })

  it('distanceFromOldest is the top distance, clamped at zero', () => {
    expect(distanceFromOldest(view(0))).toBe(0)
    expect(distanceFromOldest(view(10))).toBe(10)
    expect(distanceFromOldest(view(600))).toBe(600)
    expect(distanceFromOldest(view(-5))).toBe(0)
  })

  it('readScrollMetrics is the single adapter and keeps exactly the three readings', () => {
    const source = { scrollTop: 12, scrollHeight: 800, clientHeight: 200 }
    expect(readScrollMetrics(source)).toEqual({ scrollTop: 12, scrollHeight: 800, clientHeight: 200 })
  })

  it('isAtBottom uses the bottom distance with the production threshold', () => {
    expect(FLOW_BOTTOM_THRESHOLD_PX).toBe(50)
    expect(isAtBottom(view(600))).toBe(true)
    expect(isAtBottom(view(551))).toBe(true)
    expect(isAtBottom(view(549))).toBe(false)
    expect(isAtBottom(view(300))).toBe(false)
    expect(isAtBottom(view(480), 120)).toBe(true)
  })

  it('isAtOldest / isAtNewest are the two browse-edge vicinities, never each other', () => {
    expect(FLOW_OLDER_THRESHOLD_PX).toBe(150)
    expect(FLOW_NEWER_PREFETCH_PX).toBe(150)
    expect(isAtOldest(view(0))).toBe(true)
    expect(isAtOldest(view(140))).toBe(true)
    expect(isAtOldest(view(160))).toBe(false)
    expect(isAtNewest(view(600))).toBe(true)
    expect(isAtNewest(view(460))).toBe(true)
    expect(isAtNewest(view(440))).toBe(false)
    // The two edges are never the same point in a scrollable container.
    expect(isAtOldest(view(600))).toBe(false)
    expect(isAtNewest(view(0))).toBe(false)
  })

  it('the exact edge gates are 1px subpixel tolerance only', () => {
    expect(isExactlyAtOldest(view(0))).toBe(true)
    expect(isExactlyAtOldest(view(0.5))).toBe(true)
    expect(isExactlyAtOldest(view(2))).toBe(false)
    expect(isExactlyAtNewest(view(600))).toBe(true)
    expect(isExactlyAtNewest(view(599.5))).toBe(true)
    expect(isExactlyAtNewest(view(598))).toBe(false)
    // Content that fits: one physical park, both edges and the bottom.
    expect(isExactlyAtNewest(view(0, 300, 400))).toBe(true)
    expect(isExactlyAtOldest(view(0, 300, 400))).toBe(true)
  })

  it('fails closed on non-finite readings (never a false edge)', () => {
    expect(isAtBottom(view(NaN))).toBe(false)
    expect(isAtOldest(view(NaN))).toBe(false)
    expect(isExactlyAtNewest(view(NaN))).toBe(false)
    expect(isExactlyAtOldest(view(NaN))).toBe(false)
    expect(Number.isNaN(maxScrollTop(view(0, NaN, 400)))).toBe(true)
  })

  it('names the persisted coordinate space so stored offsets cannot be reinterpreted', () => {
    expect(FLOW_COORDINATE_SPACE).toBe('flow-v1')
  })
})

describe('layout-space hold metric (the keeper hold coordinate, split from scrolling)', () => {
  it('a pure user scroll is zero layout displacement, in both scroll directions', () => {
    // Δoffset = −ΔscrollTop is the container's coupling; the metric must cancel
    // it entirely (this is what makes a hold safe during a live gesture).
    expect(layoutDisplacement({ viewportOffset: -60, scrollTop: 0 }, { viewportOffset: -260, scrollTop: 200 })).toBe(0)
    expect(layoutDisplacement({ viewportOffset: -60, scrollTop: 0 }, { viewportOffset: 140, scrollTop: -200 })).toBe(0)
    expect(
      resolveLayoutHold({ viewportOffset: -60, scrollTop: 0 }, { viewportOffset: -260, scrollTop: 200 })
    ).toBeNull()
    // Sub-pixel noise stays inside the shared tolerance.
    expect(resolveLayoutHold({ viewportOffset: 0.5, scrollTop: -0.5 }, { viewportOffset: 0, scrollTop: 0 })).toBeNull()
  })

  it('a pure layout change is the displacement to hold, with the user scroll removed', () => {
    // +180 content growth under the reading row, no scroll in between.
    expect(resolveLayoutHold({ viewportOffset: -60, scrollTop: 0 }, { viewportOffset: 120, scrollTop: 0 })).toBe(180)
    // Same growth while the user also moved 200 (pure scroll subtraction).
    expect(resolveLayoutHold({ viewportOffset: -60, scrollTop: 0 }, { viewportOffset: -80, scrollTop: 200 })).toBe(180)
    // Symmetric sign: growth that pulls the row up holds negative.
    expect(resolveLayoutHold({ viewportOffset: -60, scrollTop: -20 }, { viewportOffset: -260, scrollTop: -20 })).toBe(
      -200
    )
    // The no-correction threshold is half a native quantum: exactly 0.5 never
    // writes (a rounded write could reverse direction next frame); above it holds.
    expect(resolveLayoutHold({ viewportOffset: 0, scrollTop: 0 }, { viewportOffset: 0.5, scrollTop: 0 })).toBeNull()
    expect(resolveLayoutHold({ viewportOffset: 0, scrollTop: 0 }, { viewportOffset: 1, scrollTop: 0 })).toBe(1)
    expect(resolveLayoutHold({ viewportOffset: 0, scrollTop: 0 }, { viewportOffset: 1.5, scrollTop: 0 })).toBe(1.5)
  })

  it('re-baselines analytically so the next trigger measures only post-write change', () => {
    const sample = { viewportOffset: 120, scrollTop: 0 }
    const displacement = resolveLayoutHold({ viewportOffset: -60, scrollTop: 0 }, sample)
    expect(displacement).toBe(180)
    const rebased = rebaseLayoutHold(sample, displacement as number)
    // The write itself moves the offset back and the scroll forward by the same
    // amount: the same geometry re-observed is then a no-op (idempotent hold).
    expect(rebased).toEqual({ viewportOffset: -60, scrollTop: 180 })
    expect(resolveLayoutHold(rebased, { viewportOffset: -60, scrollTop: 180 })).toBeNull()
    // A user scroll after the write stays cancelled out as well.
    expect(resolveLayoutHold(rebased, { viewportOffset: -260, scrollTop: 380 })).toBeNull()
  })

  it('fails closed on non-finite geometry (never a fabricated hold)', () => {
    expect(resolveLayoutHold({ viewportOffset: NaN, scrollTop: 0 }, { viewportOffset: 10, scrollTop: 0 })).toBeNull()
    expect(resolveLayoutHold({ viewportOffset: 0, scrollTop: 0 }, { viewportOffset: 10, scrollTop: NaN })).toBeNull()
    expect(
      resolveLayoutHold({ viewportOffset: 0, scrollTop: Infinity }, { viewportOffset: 10, scrollTop: 0 })
    ).toBeNull()
  })
})

describe('compensation write truth (realized vs clamped)', () => {
  it('a realized write keeps the analytic rebase', () => {
    const sample = { viewportOffset: 120, scrollTop: -40 }
    const displacement = 180
    expect(didRealizeCompensation(sample.scrollTop + displacement, 140)).toBe(true)
    expect(rebaseAfterCompensation(sample, displacement, { scrollTop: 140, viewportOffset: null })).toEqual({
      viewportOffset: -60,
      scrollTop: 140
    })
  })

  it('a clamped write never seeds the next baseline with an unreachable pair', () => {
    const sample = { viewportOffset: 120, scrollTop: 0 }
    const displacement = 7642.95
    // The browser clamped at the real physical boundary: the container sits at 0.
    const realizedScrollTop = 0
    expect(didRealizeCompensation(sample.scrollTop + displacement, realizedScrollTop)).toBe(false)
    // The re-sampled row geometry becomes the baseline, so the next trigger
    // measures only what happens AFTER the clamp instead of re-charging the
    // unreachable distance to layout.
    const next = rebaseAfterCompensation(sample, displacement, {
      scrollTop: realizedScrollTop,
      viewportOffset: 120
    })
    const realized = { viewportOffset: 120, scrollTop: 0 }
    expect(next).toEqual(realized)
    // The same geometry re-observed after the clamp is a no-op, not a second
    // charge of the unreachable distance.
    expect(resolveLayoutHold(realized, realized)).toBeNull()
    // A later real layout change is still measured from the realized pair.
    expect(resolveLayoutHold(realized, { viewportOffset: 140, scrollTop: 0 })).toBe(20)
  })

  it('an unprovable re-sample invalidates the hold instead of inventing a pair', () => {
    const sample = { viewportOffset: 120, scrollTop: 0 }
    expect(rebaseAfterCompensation(sample, 500, { scrollTop: 0, viewportOffset: null })).toBeNull()
    expect(rebaseAfterCompensation(sample, 500, { scrollTop: NaN, viewportOffset: 10 })).toBeNull()
    expect(rebaseAfterCompensation(sample, 500, { scrollTop: 0, viewportOffset: NaN })).toBeNull()
    // A negligible clamp (sub-pixel rounding) still counts as a realized write:
    // the baseline pins the ACTUAL scrollTop and keeps the owed residual
    // measurable instead of baking the requested fraction.
    expect(rebaseAfterCompensation(sample, 500, { scrollTop: 499.6, viewportOffset: null })).toEqual({
      viewportOffset: 120 - 500,
      scrollTop: 499.6
    })
  })
})
