/**
 * Older-paging clamped-input direction behavior (F1):
 * - input declaration establishes the session only; navigation paging is
 *   decided against post-scroll geometry;
 * - at the exact clamped edge (no scroll event can fire) only provably
 *   toward-older input (upward wheel, PageUp/ArrowUp/Home/Shift+Space) may
 *   request from pre-input geometry — pointer/focus/away keys must not fetch.
 *
 * Behavior tests over the pure direction + exact-edge primitives the
 * production handlers share (no source-string matching).
 */
import { describe, expect, it } from 'vitest'

import { distanceFromOldest, isExactlyAtOldest } from '../columnReverseGeometry'
import { isTowardOlderClampedInput } from '../positionStabilizer'

describe('isTowardOlderClampedInput (semantic direction only, no thresholds)', () => {
  it('allows direct clamped upward wheels of any magnitude', () => {
    expect(isTowardOlderClampedInput({ kind: 'wheel', deltaY: -1 })).toBe(true)
    expect(isTowardOlderClampedInput({ kind: 'wheel', deltaY: -600 })).toBe(true)
    expect(isTowardOlderClampedInput({ kind: 'wheel', deltaY: -0.5 })).toBe(true)
  })

  it('refuses downward, horizontal, and non-finite wheels (away-bound input)', () => {
    expect(isTowardOlderClampedInput({ kind: 'wheel', deltaY: 1 })).toBe(false)
    expect(isTowardOlderClampedInput({ kind: 'wheel', deltaY: 600 })).toBe(false)
    expect(isTowardOlderClampedInput({ kind: 'wheel', deltaY: 0 })).toBe(false)
    expect(isTowardOlderClampedInput({ kind: 'wheel', deltaY: NaN })).toBe(false)
  })

  it('allows toward-older keys: PageUp, ArrowUp, Home, Shift+Space', () => {
    expect(isTowardOlderClampedInput({ kind: 'key', key: 'PageUp' })).toBe(true)
    expect(isTowardOlderClampedInput({ kind: 'key', key: 'ArrowUp' })).toBe(true)
    expect(isTowardOlderClampedInput({ kind: 'key', key: 'Home' })).toBe(true)
    expect(isTowardOlderClampedInput({ kind: 'key', key: ' ', shiftKey: true })).toBe(true)
    expect(isTowardOlderClampedInput({ kind: 'key', key: 'Spacebar', shiftKey: true })).toBe(true)
  })

  it('refuses away keys: PageDown, ArrowDown, End, non-shift Space', () => {
    expect(isTowardOlderClampedInput({ kind: 'key', key: 'PageDown' })).toBe(false)
    expect(isTowardOlderClampedInput({ kind: 'key', key: 'ArrowDown' })).toBe(false)
    expect(isTowardOlderClampedInput({ kind: 'key', key: 'End' })).toBe(false)
    expect(isTowardOlderClampedInput({ kind: 'key', key: ' ' })).toBe(false)
    expect(isTowardOlderClampedInput({ kind: 'key', key: ' ', shiftKey: false })).toBe(false)
    expect(isTowardOlderClampedInput({ kind: 'key', key: 'Spacebar' })).toBe(false)
    expect(isTowardOlderClampedInput({ kind: 'key', key: 'Enter' })).toBe(false)
  })

  it('refuses pointer/touch/focus (direction-agnostic input never fetches)', () => {
    expect(isTowardOlderClampedInput({ kind: 'pointer' })).toBe(false)
    expect(isTowardOlderClampedInput({ kind: 'touch' })).toBe(false)
    expect(isTowardOlderClampedInput({ kind: 'focus' })).toBe(false)
  })
})

describe('isExactlyAtOldest (clamped edge, not vicinity prefetch)', () => {
  // Column-reverse: oldest edge parks at scrollTop = -(scrollHeight - clientHeight).
  const parked = (scrollHeight: number, clientHeight: number, drift = 0) => ({
    scrollTop: -(scrollHeight - clientHeight) + drift,
    scrollHeight,
    clientHeight
  })

  it('holds exactly at the clamped edge (subpixel rounding tolerated)', () => {
    expect(isExactlyAtOldest(parked(4000, 600))).toBe(true)
    expect(isExactlyAtOldest(parked(4000, 600, 1))).toBe(true)
  })

  it('refuses away-from-edge geometry (no pre-input fetch off the edge)', () => {
    expect(isExactlyAtOldest(parked(4000, 600, 2))).toBe(false)
    expect(isExactlyAtOldest(parked(4000, 600, 50))).toBe(false)
    // Mid-list and newest bottom never qualify for the clamped path.
    expect(distanceFromOldest({ scrollTop: -1700, scrollHeight: 4000, clientHeight: 600 })).toBe(1700)
    expect(isExactlyAtOldest({ scrollTop: -1700, scrollHeight: 4000, clientHeight: 600 })).toBe(false)
    expect(isExactlyAtOldest({ scrollTop: 0, scrollHeight: 4000, clientHeight: 600 })).toBe(false)
  })

  it('is strictly tighter than the post-scroll vicinity primitive', () => {
    // 100px inside the edge: post-scroll vicinity pages, clamped pre-input
    // must not (a scroll event WILL fire there, so post-scroll decides).
    const inside = parked(4000, 600, 100)
    expect(distanceFromOldest(inside)).toBe(100)
    expect(isExactlyAtOldest(inside)).toBe(false)
  })
})
