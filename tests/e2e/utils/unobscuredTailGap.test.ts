import { describe, expect, it } from 'vitest'

import {
  parseComposerTailInsetPx,
  resolveUnobscuredBottom,
  TAIL_GAP_TOLERANCE_PX,
  tailGapToUnobscuredBand
} from './unobscuredTailGap'

describe('unobscured tail gap', () => {
  it('rejects the obscured -196px reading but accepts the unobscured gap with a 96px overlay', () => {
    const containerBottom = 800
    // Tail rests 196px above the raw container bottom (scroll tail padding):
    // the old oracle over-reports by the obscured strip.
    const tailBottom = containerBottom - 196
    expect(Math.abs(tailBottom - containerBottom)).toBeGreaterThan(TAIL_GAP_TOLERANCE_PX)
    // Correct oracle: tail vs unobscured band edge (96px overlay) => -100.
    const unobscuredBottom = resolveUnobscuredBottom(containerBottom, parseComposerTailInsetPx('96px'))
    expect(unobscuredBottom).toBe(containerBottom - 96)
    expect(tailGapToUnobscuredBand(tailBottom, unobscuredBottom)).toBe(-100)
    expect(Math.abs(tailGapToUnobscuredBand(tailBottom, unobscuredBottom))).toBeLessThanOrEqual(TAIL_GAP_TOLERANCE_PX)
  })

  it('behaves exactly like the old metric when no overlay info is published', () => {
    for (const raw of ['', null, undefined, 'not-a-length', '-12px']) {
      expect(parseComposerTailInsetPx(raw)).toBe(0)
    }
    const containerBottom = 800
    const tailBottom = containerBottom + 40
    const unobscuredBottom = resolveUnobscuredBottom(containerBottom, parseComposerTailInsetPx(''))
    expect(unobscuredBottom).toBe(containerBottom)
    expect(tailGapToUnobscuredBand(tailBottom, unobscuredBottom)).toBe(tailBottom - containerBottom)
  })
})
