/**
 * Stable viewport-top content anchor: crossing-first, never min-abs-distance.
 * Covers contract (4): top picker + unified findFirstVisible* semantics.
 */
import { describe, expect, it } from 'vitest'

import { pickViewportTopAnchor } from '../domVisibility'

describe('pickViewportTopAnchor (stable viewport-top content anchor)', () => {
  it('prefers the row crossing the container top over a nearer-below row in abs distance', () => {
    // Container top = 100. Row A crosses (90..160, abs distance 10);
    // row B is below (108..200, abs distance 8). A min-abs model would pick
    // B; the stable model must pick the crossing row A.
    const out = pickViewportTopAnchor(
      [
        { id: 'a', top: 90, bottom: 160 },
        { id: 'b', top: 108, bottom: 200 }
      ],
      100
    )
    expect(out?.id).toBe('a')
    expect(out?.intraRowOffset).toBe(-10)
  })

  it('never picks a far-above row over the crossing row', () => {
    const out = pickViewportTopAnchor(
      [
        { id: 'above', top: 95, bottom: 99 },
        { id: 'cross', top: 80, bottom: 150 },
        { id: 'below', top: 200, bottom: 300 }
      ],
      100
    )
    expect(out?.id).toBe('cross')
  })

  it('without a crossing row picks the smallest top at/after the edge', () => {
    const out = pickViewportTopAnchor(
      [
        { id: 'b2', top: 300, bottom: 400 },
        { id: 'b1', top: 150, bottom: 250 }
      ],
      100
    )
    expect(out?.id).toBe('b1')
    expect(out?.intraRowOffset).toBe(50)
  })

  it('returns null for empty candidates', () => {
    expect(pickViewportTopAnchor([], 100)).toBeNull()
  })
})
