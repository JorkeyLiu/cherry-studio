/**
 * Single column-reverse geometry primitive: bottom is `abs(scrollTop)`,
 * oldest is `scrollHeight - clientHeight - abs(scrollTop)` (clamped ≥ 0).
 * Guards the production/E2E direction confusion (bottom ≠ oldest).
 */
import { describe, expect, it } from 'vitest'

import {
  COLUMN_REVERSE_BOTTOM_THRESHOLD_PX,
  distanceFromBottom,
  distanceFromOldest,
  isAtBottom,
  isAtOldest,
  layoutDisplacement,
  rebaseLayoutHold,
  resolveLayoutHold
} from '../columnReverseGeometry'

describe('columnReverseGeometry (single production primitive)', () => {
  it('distanceFromBottom is abs(scrollTop): bottom rests at ≈0', () => {
    expect(distanceFromBottom(0)).toBe(0)
    expect(distanceFromBottom(-10)).toBe(10)
    expect(distanceFromBottom(10)).toBe(10)
    expect(distanceFromBottom(-300)).toBe(300)
  })

  it('distanceFromOldest is the opposite edge, clamped at zero', () => {
    // scrollHeight 1000, client 400 → 600px of scrollable overflow.
    expect(distanceFromOldest({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 })).toBe(600)
    expect(distanceFromOldest({ scrollTop: -600, scrollHeight: 1000, clientHeight: 400 })).toBe(0)
    expect(distanceFromOldest({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })).toBe(0)
    expect(distanceFromOldest({ scrollTop: -590, scrollHeight: 1000, clientHeight: 400 })).toBe(10)
    // Never negative when content fits.
    expect(distanceFromOldest({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 })).toBe(0)
  })

  it('isAtBottom uses the bottom distance with the production threshold', () => {
    expect(COLUMN_REVERSE_BOTTOM_THRESHOLD_PX).toBe(50)
    expect(isAtBottom(0)).toBe(true)
    expect(isAtBottom(-49)).toBe(true)
    expect(isAtBottom(-51)).toBe(false)
    expect(isAtBottom(-300)).toBe(false)
    expect(isAtBottom(-100, 120)).toBe(true)
  })

  it('isAtOldest uses the oldest distance, never the bottom formula', () => {
    const overflow = { scrollHeight: 1000, clientHeight: 400 }
    expect(isAtOldest({ ...overflow, scrollTop: -600 })).toBe(true)
    expect(isAtOldest({ ...overflow, scrollTop: -590 })).toBe(true)
    expect(isAtOldest({ ...overflow, scrollTop: 0 })).toBe(false)
    // Bottom vicinity (≈0) is the farthest point from the oldest edge.
    expect(distanceFromOldest({ ...overflow, scrollTop: 0 })).toBeGreaterThan(200)
    expect(distanceFromBottom(0)).toBe(0)
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
    // The tolerance is a real gate (a 1px wobble is not a hold).
    expect(resolveLayoutHold({ viewportOffset: 0, scrollTop: 0 }, { viewportOffset: 1, scrollTop: 0 })).toBeNull()
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
