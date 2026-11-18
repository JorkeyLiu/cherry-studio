import { afterEach, describe, expect, it } from 'vitest'

import {
  createCubicBezierEasing,
  FOLD_BROWSE_MOTION_MS,
  type FoldBrowseMotionScheduler,
  foldBrowseSpaceEasing,
  runFoldBrowseMotion
} from '../foldBrowseMotionDriver'

/** Deterministic frame clock: the test advances time and fires frames by hand. */
const makeScheduler = () => {
  let nextId = 0
  const queued = new Map<number, (now: number) => void>()
  let nowMs = 1000
  const scheduler: FoldBrowseMotionScheduler = {
    requestFrame: (callback) => {
      nextId += 1
      queued.set(nextId, callback)
      return nextId
    },
    cancelFrame: (handle) => {
      queued.delete(handle)
    },
    now: () => nowMs
  }
  return {
    scheduler,
    pending: () => queued.size,
    advance: (dtMs: number) => {
      nowMs += dtMs
      const callbacks = [...queued.values()]
      queued.clear()
      for (const callback of callbacks) callback(nowMs)
    }
  }
}

const makeTarget = (): HTMLElement => {
  const element = document.createElement('div')
  document.body.append(element)
  return element
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('foldBrowseSpaceEasing', () => {
  it('matches the CSS cubic-bezier(0.65, 0, 0.35, 1) contract', () => {
    expect(foldBrowseSpaceEasing(0)).toBe(0)
    expect(foldBrowseSpaceEasing(1)).toBe(1)
    // Symmetric control points (0.65 + 0.35 = 1, 0 + 1 = 1) cross the
    // midpoint exactly, like the CSS curve.
    expect(foldBrowseSpaceEasing(0.5)).toBeCloseTo(0.5, 5)
    let previous = -Infinity
    for (let t = 0; t <= 1; t += 0.05) {
      const value = foldBrowseSpaceEasing(t)
      expect(value).toBeGreaterThanOrEqual(previous)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
      previous = value
    }
  })

  it('builds other CSS curves with exact endpoints', () => {
    const linear = createCubicBezierEasing(0, 0, 1, 1)
    expect(linear(0)).toBe(0)
    expect(linear(1)).toBe(1)
    expect(linear(0.37)).toBeCloseTo(0.37, 4)
  })
})

describe('runFoldBrowseMotion', () => {
  it('writes the start height and settles synchronously before returning', () => {
    const clock = makeScheduler()
    const target = makeTarget()
    const settled: Array<string> = []
    const handle = runFoldBrowseMotion(target, 44, 284, {
      scheduler: clock.scheduler,
      onSettledLayout: () => settled.push(target.style.height)
    })
    // First frame commits synchronously in the caller's pre-paint pass.
    expect(target.style.height).toBe('44px')
    expect(settled).toEqual(['44px'])
    handle.cancel()
    target.remove()
  })

  it('settles synchronously after every height write, before the frame callback returns', () => {
    const clock = makeScheduler()
    const target = makeTarget()
    // Each entry records the inline height already on the box at the moment
    // the keeper is settled: the write always precedes its settlement, and
    // every settlement lands strictly inside its frame callback.
    const events: Array<string> = []
    const innerRequest = clock.scheduler.requestFrame
    const scheduler: FoldBrowseMotionScheduler = {
      ...clock.scheduler,
      requestFrame: (callback) => {
        return innerRequest((now) => {
          events.push('frame-start')
          callback(now)
          events.push('frame-end')
        })
      }
    }
    const settledHeights: Array<string> = []
    const handle = runFoldBrowseMotion(target, 44, 284, {
      scheduler,
      durationMs: 200,
      easing: (t) => t,
      onSettledLayout: () => settledHeights.push(target.style.height)
    })
    expect(settledHeights).toEqual(['44px'])

    clock.advance(100)
    expect(target.style.height).toBe('164px')
    // The mid-frame settlement saw the freshly written height, and both it
    // and the frame-end marker prove the settlement ran before the callback
    // returned — not in a later microtask, timer, or observer loop.
    expect(settledHeights).toEqual(['44px', '164px'])
    expect(events).toEqual(['frame-start', 'frame-end'])

    clock.advance(100)
    expect(target.style.height).toBe('284px')
    expect(settledHeights).toEqual(['44px', '164px', '284px'])
    expect(events).toEqual(['frame-start', 'frame-end', 'frame-start', 'frame-end'])

    handle.cancel()
    target.remove()
  })

  it('resolves completion only after the exact endpoint was written and settled', async () => {
    const clock = makeScheduler()
    const target = makeTarget()
    let resolved = false
    const handle = runFoldBrowseMotion(target, 284, 44, {
      scheduler: clock.scheduler,
      durationMs: FOLD_BROWSE_MOTION_MS
    })
    void handle.finished.then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false)
    clock.advance(FOLD_BROWSE_MOTION_MS)
    await handle.finished
    expect(resolved).toBe(true)
    expect(target.style.height).toBe('44px')
    // Landed: no further frames are scheduled.
    expect(clock.pending()).toBe(0)
    target.remove()
  })

  it('leaves a cancelled motion permanently pending with no further write or settlement', async () => {
    const clock = makeScheduler()
    const target = makeTarget()
    let settled = 0
    let resolved = false
    const handle = runFoldBrowseMotion(target, 44, 284, {
      scheduler: clock.scheduler,
      onSettledLayout: () => {
        settled += 1
      }
    })
    void handle.finished.then(() => {
      resolved = true
    })
    const writesAfterStart = settled
    clock.advance(50)
    expect(settled).toBeGreaterThan(writesAfterStart)
    handle.cancel()
    const settledAtCancel = settled
    const heightAtCancel = target.style.height
    // The pending frame is dropped and the completion never lands, so a
    // superseded (reversed, unmounted) motion cannot write a stale state.
    expect(clock.pending()).toBe(0)
    clock.advance(1000)
    await Promise.resolve()
    await Promise.resolve()
    expect(resolved).toBe(false)
    expect(settled).toBe(settledAtCancel)
    expect(target.style.height).toBe(heightAtCancel)
    target.remove()
  })

  it('settles degenerate inputs immediately with no frames', async () => {
    // Null target: nothing to write, still resolves.
    await runFoldBrowseMotion(null, 44, 284, {
      scheduler: makeScheduler().scheduler,
      onSettledLayout: () => {
        throw new Error('no target, no settlement')
      }
    }).finished

    // Non-finite endpoint: no write, still resolves.
    const untouched = makeTarget()
    let settled = 0
    await runFoldBrowseMotion(untouched, Number.NaN, 284, {
      scheduler: makeScheduler().scheduler,
      onSettledLayout: () => {
        settled += 1
      }
    }).finished
    expect(untouched.style.height).toBe('')
    expect(settled).toBe(0)
    untouched.remove()

    // Zero distance: one endpoint write + one settlement, no frames.
    const clock = makeScheduler()
    const target = makeTarget()
    let zeroSettled = 0
    await runFoldBrowseMotion(target, 120, 120, {
      scheduler: clock.scheduler,
      onSettledLayout: () => {
        zeroSettled += 1
      }
    }).finished
    expect(target.style.height).toBe('120px')
    expect(zeroSettled).toBe(1)
    expect(clock.pending()).toBe(0)
    target.remove()
  })
})
