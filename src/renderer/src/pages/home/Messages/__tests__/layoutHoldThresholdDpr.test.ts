/**
 * DPR-aware hold threshold (quantum half).
 *
 * Contract: HOLD threshold = actual layout scroll quantum half; quantum =
 * `1/dpr`, read from `window.devicePixelRatio` by the keeper. DPR1 keeps 0.5,
 * DPR2 uses 0.25. Geometry helpers stay pure (no window); the keeper passes
 * `q/2` explicitly. Defaults preserve the old DPR1 behavior.
 */
import { describe, expect, it } from 'vitest'

import {
  LAYOUT_HOLD_THRESHOLD_PX,
  layoutDisplacement,
  rebaseAfterCompensation,
  resolveLayoutHold,
  resolveLayoutHoldThresholdForDpr,
  resolveLayoutHoldThresholdForPixelQuantum,
  stepLayoutHold
} from '../flowScrollGeometry'
import { resolveKeeperLayoutHoldThreshold } from '../routeViewportContext'

describe('resolveLayoutHoldThresholdForPixelQuantum', () => {
  it('is half the quantum with DPR1 default fallback', () => {
    expect(resolveLayoutHoldThresholdForPixelQuantum(1)).toBe(0.5)
    expect(resolveLayoutHoldThresholdForPixelQuantum(0.5)).toBe(0.25)
    expect(resolveLayoutHoldThresholdForPixelQuantum(2)).toBe(1)
  })

  it('falls back to 0.5 on invalid quantum', () => {
    for (const bad of [0, -1, -0.5, NaN, Infinity, -Infinity, undefined, null, '0.5', {}, []]) {
      expect(resolveLayoutHoldThresholdForPixelQuantum(bad)).toBe(LAYOUT_HOLD_THRESHOLD_PX)
    }
  })
})

describe('resolveLayoutHoldThresholdForDpr', () => {
  it('maps DPR to quantum half (DPR1 0.5, DPR2 0.25)', () => {
    expect(resolveLayoutHoldThresholdForDpr(1)).toBe(0.5)
    expect(resolveLayoutHoldThresholdForDpr(2)).toBe(0.25)
    expect(resolveLayoutHoldThresholdForDpr(1.25)).toBeCloseTo(0.4, 12)
  })

  it('falls back to 0.5 on invalid DPR', () => {
    for (const bad of [0, -1, -0.5, NaN, Infinity, -Infinity, undefined, null, '2', {}, []]) {
      expect(resolveLayoutHoldThresholdForDpr(bad)).toBe(LAYOUT_HOLD_THRESHOLD_PX)
    }
  })
})

describe('DPR1 default behavior is unchanged', () => {
  it('exactly half never writes (strict >) at the default', () => {
    const base = { viewportOffset: 0, scrollTop: 0 }
    expect(resolveLayoutHold(base, { viewportOffset: 0.5, scrollTop: 0 })).toBeNull()
    expect(resolveLayoutHold(base, { viewportOffset: -0.5, scrollTop: 0 })).toBeNull()
    expect(stepLayoutHold(base, { viewportOffset: 0.5, scrollTop: 0 }).displacement).toBeNull()
  })

  it('invalid explicit threshold falls back to the DPR1 default', () => {
    const base = { viewportOffset: 0, scrollTop: 0 }
    for (const bad of [NaN, Infinity, -Infinity, 0, -1]) {
      expect(resolveLayoutHold(base, { viewportOffset: 0.5, scrollTop: 0 }, bad)).toBeNull()
      expect(resolveLayoutHold(base, { viewportOffset: 0.6, scrollTop: 0 }, bad)).toBeCloseTo(0.6, 9)
      const step = stepLayoutHold(base, { viewportOffset: 0.5, scrollTop: 0 }, bad)
      expect(step.displacement).toBeNull()
      expect(step.retained).toBe(true)
    }
  })
})

describe('DPR2 threshold (0.25)', () => {
  const DPR2 = 0.25
  const base = { viewportOffset: 0, scrollTop: 0 }

  it('an exact 0.5 layout is corrected (was ignored at DPR1)', () => {
    expect(resolveLayoutHold(base, { viewportOffset: 0.5, scrollTop: 0 }, DPR2)).toBe(0.5)
    expect(stepLayoutHold(base, { viewportOffset: 0.5, scrollTop: 0 }, DPR2).displacement).toBe(0.5)
  })

  it('exactly +-0.25 retains (strict >) and accumulates toward the quantum half', () => {
    for (const edge of [0.25, -0.25]) {
      const step = stepLayoutHold(base, { viewportOffset: edge, scrollTop: 0 }, DPR2)
      expect(step.displacement).toBeNull()
      expect(step.retained).toBe(true)
      expect(step.baseline).toEqual(base)
    }
    // Two retained quarter steps sum to a half against the RETAINED origin.
    const second = stepLayoutHold(base, { viewportOffset: 0.5, scrollTop: 0 }, DPR2)
    expect(second.displacement).toBe(0.5)
  })

  it('same displacement transforms across DPR: held at DPR2, retained at DPR1', () => {
    const sample = { viewportOffset: 0.4, scrollTop: 0 }
    expect(stepLayoutHold(base, sample, DPR2).displacement).toBeCloseTo(0.4, 9)
    const dpr1 = stepLayoutHold(base, sample)
    expect(dpr1.displacement).toBeNull()
    expect(dpr1.retained).toBe(true)
  })

  it('a quantized DPR2 write leaves no ping-pong: residual retained, reversal held once', () => {
    // +0.4 layout at DPR2 (quantum 0.5): native rounds +0.4 to +0.5.
    const sample = { viewportOffset: 0.4, scrollTop: 0 }
    const d = layoutDisplacement(base, sample)
    const rebased = rebaseAfterCompensation(sample, d, { scrollTop: 0.5, viewportOffset: null })
    expect(rebased?.scrollTop).toBe(0.5)
    const physical = { viewportOffset: 0.4 - 0.5, scrollTop: 0.5 }
    const pending = layoutDisplacement(rebased!, physical)
    expect(pending).toBeCloseTo(-0.1, 9)
    // |-0.1| <= 0.25: no second write, no direction reversal.
    expect(resolveLayoutHold(rebased!, physical, DPR2)).toBeNull()
    const quiet = stepLayoutHold(rebased, physical, DPR2)
    expect(quiet.displacement).toBeNull()
    expect(quiet.retained).toBe(true)
    // A further -0.2 reversal nets -0.3 against the retained baseline:
    // |-0.3| > 0.25 so it holds once, never oscillates.
    const reversed = { viewportOffset: physical.viewportOffset - 0.2, scrollTop: 0.5 }
    const after = stepLayoutHold(rebased, reversed, DPR2)
    expect(after.displacement).toBeCloseTo(-0.3, 9)
  })
})

describe('keeper threshold source (route bridge)', () => {
  it('uses the same DPR source as the quantum sync: DPR1 0.5, DPR2 0.25, invalid 0.5', () => {
    expect(resolveKeeperLayoutHoldThreshold(1)).toBe(0.5)
    expect(resolveKeeperLayoutHoldThreshold(2)).toBe(0.25)
    expect(resolveKeeperLayoutHoldThreshold(1.25)).toBeCloseTo(0.4, 12)
    for (const bad of [0, -1, NaN, Infinity, -Infinity, null, '2', {}, []]) {
      expect(resolveKeeperLayoutHoldThreshold(bad)).toBe(0.5)
    }
  })

  it('defaults to window.devicePixelRatio without new listeners or style writes', () => {
    const prev = window.devicePixelRatio
    try {
      Object.defineProperty(window, 'devicePixelRatio', { value: 2, writable: true, configurable: true })
      expect(resolveKeeperLayoutHoldThreshold()).toBe(0.25)
      Object.defineProperty(window, 'devicePixelRatio', { value: 1, writable: true, configurable: true })
      expect(resolveKeeperLayoutHoldThreshold()).toBe(0.5)
    } finally {
      try {
        Object.defineProperty(window, 'devicePixelRatio', {
          value: prev,
          writable: true,
          configurable: true
        })
      } catch {}
    }
  })
})
