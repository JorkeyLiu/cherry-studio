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
  isAtOldest
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
