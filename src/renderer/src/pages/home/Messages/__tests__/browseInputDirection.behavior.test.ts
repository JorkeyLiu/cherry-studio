/**
 * Browse-input direction behavior (both pagination directions):
 * - input declaration establishes the session only; ordinary paging is decided
 *   against post-scroll geometry in the shared edge gate;
 * - at an exact clamped edge (no scroll event can fire) the input adapter
 *   reports the browse DIRECTION it expresses (upward wheel / PageUp / ArrowUp
 *   / Home / Shift+Space toward older; downward wheel / PageDown / ArrowDown /
 *   End / Space toward newer) and the gate re-decides whether that direction may
 *   page — pointer/touch/focus carry no direction and must not fetch.
 *
 * Behavior tests over the pure direction + exact-edge primitives the production
 * handlers share (no source-string matching).
 */
import { describe, expect, it } from 'vitest'

import { distanceFromOldest, isAtNewest, isExactlyAtNewest, isExactlyAtOldest } from '../columnReverseGeometry'
import { browseDirectionForClampedInput } from '../positionStabilizer'

describe('browseDirectionForClampedInput (semantic direction only, no thresholds)', () => {
  it('reads the wheel sign in both directions, any magnitude', () => {
    expect(browseDirectionForClampedInput({ kind: 'wheel', deltaY: -1 })).toBe('older')
    expect(browseDirectionForClampedInput({ kind: 'wheel', deltaY: -600 })).toBe('older')
    expect(browseDirectionForClampedInput({ kind: 'wheel', deltaY: -0.5 })).toBe('older')
    expect(browseDirectionForClampedInput({ kind: 'wheel', deltaY: 1 })).toBe('newer')
    expect(browseDirectionForClampedInput({ kind: 'wheel', deltaY: 600 })).toBe('newer')
  })

  it('refuses a zero or non-finite wheel (no direction expressed)', () => {
    expect(browseDirectionForClampedInput({ kind: 'wheel', deltaY: 0 })).toBeNull()
    expect(browseDirectionForClampedInput({ kind: 'wheel', deltaY: NaN })).toBeNull()
    expect(browseDirectionForClampedInput({ kind: 'wheel', deltaY: Number.POSITIVE_INFINITY })).toBeNull()
  })

  it('maps native page keys to their browse direction', () => {
    expect(browseDirectionForClampedInput({ kind: 'key', key: 'PageUp' })).toBe('older')
    expect(browseDirectionForClampedInput({ kind: 'key', key: 'ArrowUp' })).toBe('older')
    expect(browseDirectionForClampedInput({ kind: 'key', key: 'Home' })).toBe('older')
    expect(browseDirectionForClampedInput({ kind: 'key', key: ' ', shiftKey: true })).toBe('older')
    expect(browseDirectionForClampedInput({ kind: 'key', key: 'Spacebar', shiftKey: true })).toBe('older')
    expect(browseDirectionForClampedInput({ kind: 'key', key: 'PageDown' })).toBe('newer')
    expect(browseDirectionForClampedInput({ kind: 'key', key: 'ArrowDown' })).toBe('newer')
    expect(browseDirectionForClampedInput({ kind: 'key', key: 'End' })).toBe('newer')
    expect(browseDirectionForClampedInput({ kind: 'key', key: ' ' })).toBe('newer')
    expect(browseDirectionForClampedInput({ kind: 'key', key: 'Spacebar', shiftKey: false })).toBe('newer')
  })

  it('refuses keys with no browse direction', () => {
    expect(browseDirectionForClampedInput({ kind: 'key', key: 'Enter' })).toBeNull()
    expect(browseDirectionForClampedInput({ kind: 'key', key: 'Escape' })).toBeNull()
    expect(browseDirectionForClampedInput({ kind: 'key', key: '' })).toBeNull()
  })

  it('refuses pointer/touch/focus (direction-agnostic input never fetches)', () => {
    expect(browseDirectionForClampedInput({ kind: 'pointer' })).toBeNull()
    expect(browseDirectionForClampedInput({ kind: 'touch' })).toBeNull()
    expect(browseDirectionForClampedInput({ kind: 'focus' })).toBeNull()
  })
})

describe('clamped-edge primitives are symmetric (exact edge, not vicinity prefetch)', () => {
  // Column-reverse: oldest edge parks at scrollTop = -(scrollHeight - clientHeight),
  // newest edge parks at the scrollTop 0 clamp.
  const atOldest = (scrollHeight: number, clientHeight: number, drift = 0) => ({
    scrollTop: -(scrollHeight - clientHeight) + drift,
    scrollHeight,
    clientHeight
  })
  const atNewest = (scrollTop: number) => ({ scrollTop, scrollHeight: 4000, clientHeight: 600 })

  it('holds exactly at the oldest clamped edge (subpixel rounding tolerated)', () => {
    expect(isExactlyAtOldest(atOldest(4000, 600))).toBe(true)
    expect(isExactlyAtOldest(atOldest(4000, 600, 1))).toBe(true)
  })

  it('holds exactly at the newest clamped edge (subpixel rounding tolerated)', () => {
    expect(isExactlyAtNewest(atNewest(0))).toBe(true)
    expect(isExactlyAtNewest(atNewest(-1))).toBe(true)
  })

  it('refuses away-from-edge geometry in both directions (no pre-input fetch off the edge)', () => {
    expect(isExactlyAtOldest(atOldest(4000, 600, 2))).toBe(false)
    expect(isExactlyAtOldest(atOldest(4000, 600, 50))).toBe(false)
    expect(distanceFromOldest({ scrollTop: -1700, scrollHeight: 4000, clientHeight: 600 })).toBe(1700)
    expect(isExactlyAtOldest({ scrollTop: -1700, scrollHeight: 4000, clientHeight: 600 })).toBe(false)
    // The opposite edge qualifies for the OTHER direction only.
    expect(isExactlyAtNewest({ scrollTop: -1700, scrollHeight: 4000, clientHeight: 600 })).toBe(false)
    expect(isExactlyAtOldest({ scrollTop: 0, scrollHeight: 4000, clientHeight: 600 })).toBe(false)
    expect(isExactlyAtNewest(atNewest(-2))).toBe(false)
    expect(isExactlyAtNewest(atNewest(-50))).toBe(false)
  })

  it('keeps the post-scroll vicinity wider than the clamped pre-input edge', () => {
    // 100px inside either edge: the post-scroll vicinity pages, the clamped
    // pre-input path must not (a scroll event WILL fire there, so the
    // post-scroll geometry decides).
    const insideOldest = atOldest(4000, 600, 100)
    expect(distanceFromOldest(insideOldest)).toBe(100)
    expect(isExactlyAtOldest(insideOldest)).toBe(false)
    expect(isAtNewest({ scrollTop: -100, scrollHeight: 4000, clientHeight: 600 })).toBe(true)
    expect(isExactlyAtNewest({ scrollTop: -100, scrollHeight: 4000, clientHeight: 600 })).toBe(false)
  })
})
