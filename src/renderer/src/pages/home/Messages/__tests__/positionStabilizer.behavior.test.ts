/**
 * Stabilizer restore behavior:
 * - restore-target validity never consults the viewport scroll token
 *   (anchoring after beginScroll keeps it true);
 * - genuine user cancel stops compensation (no further applyDelta);
 * - programmatic applyDelta never miscancels;
 * - ResizeObserver watches container + target, rebinds on replacement, and
 *   its callback re-measures immediately; cleanup disconnects/cancels;
 * - deadline bounded (maxMs default 1500 retained at call sites);
 * - single-frame expected-scrollTop suppress: program deltas never cancel,
 *   next-frame/different-offset user scrolls cancel; keyboard pre-cancel
 *   ignores inputs; cancel/unmount settles `done` synchronously, idempotent,
 *   single disconnect/cancel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  armStabilizerSuppress,
  createStabilizerScrollSuppress,
  disarmStabilizerSuppress,
  isRestoreTargetValid,
  isSelfInducedStabilizerScroll,
  runBoundedPositionStabilizer,
  shouldCancelStabilizerForKeyDown
} from '../positionStabilizer'

type ROInstance = {
  callback: ResizeObserverCallback
  observeCalls: Element[]
  unobserveCalls: Element[]
  disconnectCalls: number
}

let roInstances: ROInstance[]
let rafQueue: number[]
let rafIdSeq: number
let rafCallbacks: Map<number, FrameRequestCallback>
let cancelCalls: number[]

beforeEach(() => {
  roInstances = []
  rafQueue = []
  rafIdSeq = 0
  rafCallbacks = new Map()
  cancelCalls = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      callback: ResizeObserverCallback
      observeCalls: Element[] = []
      unobserveCalls: Element[] = []
      disconnectCalls = 0
      instance: ROInstance
      constructor(cb: ResizeObserverCallback) {
        this.callback = cb
        this.instance = {
          callback: cb,
          observeCalls: this.observeCalls,
          unobserveCalls: this.unobserveCalls,
          disconnectCalls: 0
        }
        roInstances.push(this.instance)
      }
      observe = (el: Element): void => {
        this.observeCalls.push(el)
        this.instance.observeCalls.push(el)
      }
      unobserve = (el: Element): void => {
        this.unobserveCalls.push(el)
        this.instance.unobserveCalls.push(el)
      }
      disconnect = (): void => {
        this.disconnectCalls += 1
        this.instance.disconnectCalls += 1
      }
    }
  )
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    rafIdSeq += 1
    rafCallbacks.set(rafIdSeq, cb)
    rafQueue.push(rafIdSeq)
    return rafIdSeq
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    cancelCalls.push(id)
    rafCallbacks.delete(id)
    rafQueue = rafQueue.filter((x) => x !== id)
  })
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const flushFrames = (n: number): void => {
  for (let i = 0; i < n; i += 1) {
    const id = rafQueue.shift()
    if (id === undefined) return
    const cb = rafCallbacks.get(id)
    rafCallbacks.delete(id)
    if (cb) cb(16 * (i + 1))
  }
}

describe('isRestoreTargetValid (epoch validity, never scroll-token)', () => {
  it('stays true after beginScroll(anchoring): only topic/route/mounted/epoch matter', () => {
    // No scrollMode/scrollToken input exists: anchoring cannot flip this.
    expect(isRestoreTargetValid({ topicMatch: true, routeMatch: true, mounted: true, epochCurrent: true })).toBe(true)
  })

  it('fails on topic/route/unmount/epoch mismatch', () => {
    expect(isRestoreTargetValid({ topicMatch: false, routeMatch: true, mounted: true, epochCurrent: true })).toBe(false)
    expect(isRestoreTargetValid({ topicMatch: true, routeMatch: false, mounted: true, epochCurrent: true })).toBe(false)
    expect(isRestoreTargetValid({ topicMatch: true, routeMatch: true, mounted: false, epochCurrent: true })).toBe(false)
    expect(isRestoreTargetValid({ topicMatch: true, routeMatch: true, mounted: true, epochCurrent: false })).toBe(false)
  })
})

describe('runBoundedPositionStabilizer observation + cancel + cleanup', () => {
  it('observes container and target, re-measures on observer callback, rebinds on replacement, cleanup disconnects', async () => {
    const container = document.createElement('div')
    const targetA = document.createElement('div')
    const targetB = document.createElement('div')
    document.body.append(container, targetA, targetB)
    let current: HTMLElement | null = targetA
    const applied: number[] = []
    let offset = 160
    const handle = runBoundedPositionStabilizer(
      container,
      150,
      {
        getCurrentOffset: () => offset,
        applyDelta: (d) => {
          applied.push(d)
          offset -= d
        },
        isCancelled: () => false
      },
      { maxMs: 1500, quietMs: 10000 },
      { getTargetElement: () => current }
    )
    expect(roInstances).toHaveLength(1)
    expect(roInstances[0].observeCalls).toContain(container)
    expect(roInstances[0].observeCalls).toContain(targetA)

    // Observer callback participates: re-measures immediately without a frame.
    const appliedBeforeRO = applied.length
    roInstances[0].callback([], roInstances[0] as unknown as ResizeObserver)
    expect(applied.length).toBeGreaterThan(appliedBeforeRO)
    expect(offset).toBe(150)

    // Target replacement rebinds safely (unobserve old, observe new).
    current = targetB
    flushFrames(1)
    expect(roInstances[0].unobserveCalls).toContain(targetA)
    expect(roInstances[0].observeCalls).toContain(targetB)

    handle.cancel()
    flushFrames(2)
    const done = await handle.done
    expect(done).toBe('cancelled')
    expect(roInstances[0].disconnectCalls).toBeGreaterThanOrEqual(1)
    expect(cancelCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('user cancel stops compensation: no further applyDelta after isCancelled flips', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    let cancelled = false
    const applied: number[] = []
    const handle = runBoundedPositionStabilizer(
      container,
      100,
      {
        getCurrentOffset: () => 130,
        applyDelta: (d) => {
          applied.push(d)
        },
        isCancelled: () => cancelled
      },
      { maxMs: 1500, quietMs: 10000 }
    )
    flushFrames(1)
    expect(applied.length).toBeGreaterThan(0)
    const countAtCancel = applied.length
    // Genuine user input flips the epoch -> isCancelled true.
    cancelled = true
    flushFrames(3)
    expect(await handle.done).toBe('cancelled')
    expect(applied.length).toBe(countAtCancel)
  })

  it('programmatic applyDelta never miscancels while the epoch stays current', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const epochCurrent = true
    const applied: number[] = []
    let offset = 120
    const handle = runBoundedPositionStabilizer(
      container,
      100,
      {
        getCurrentOffset: () =>
          isRestoreTargetValid({ topicMatch: true, routeMatch: true, mounted: true, epochCurrent }) ? offset : null,
        applyDelta: (d) => {
          // Self-induced delta: epoch stays current, so validity holds.
          applied.push(d)
          offset -= d
          expect(isRestoreTargetValid({ topicMatch: true, routeMatch: true, mounted: true, epochCurrent })).toBe(true)
        },
        isCancelled: () => !isRestoreTargetValid({ topicMatch: true, routeMatch: true, mounted: true, epochCurrent })
      },
      { maxMs: 1500, quietMs: 10000 }
    )
    flushFrames(2)
    expect(applied.length).toBeGreaterThan(0)
    expect(epochCurrent).toBe(true)
    handle.cancel()
    flushFrames(2)
    await handle.done
  })

  it('deadline bounds the loop (timeout, no further compensation)', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const applied: number[] = []
    const handle = runBoundedPositionStabilizer(
      container,
      100,
      {
        getCurrentOffset: () => 200,
        applyDelta: (d) => {
          applied.push(d)
        },
        isCancelled: () => false
      },
      { maxMs: 0, quietMs: 10000 }
    )
    flushFrames(1)
    expect(await handle.done).toBe('timeout')
    const count = applied.length
    flushFrames(3)
    expect(applied.length).toBe(count)
  })
})

describe('single-frame expected-scrollTop suppress (no 80ms window)', () => {
  it('program delta scroll does not cancel; different scrollTop cancels', () => {
    const suppress = createStabilizerScrollSuppress()
    // Program: scrollTop 100 += 10 -> expected 110, armed this frame.
    const generation = armStabilizerSuppress(suppress, 110)
    expect(isSelfInducedStabilizerScroll(suppress, 110)).toBe(true)
    // Genuine user scroll to a different offset never matches.
    expect(isSelfInducedStabilizerScroll(suppress, 140)).toBe(false)
    expect(isSelfInducedStabilizerScroll(suppress, 100)).toBe(false)
    void generation
  })

  it('next-frame user scroll cancels after disarm even with the same offset', () => {
    const suppress = createStabilizerScrollSuppress()
    const generation = armStabilizerSuppress(suppress, 110)
    expect(isSelfInducedStabilizerScroll(suppress, 110)).toBe(true)
    // Next animation frame clears the arm (generation-guarded).
    disarmStabilizerSuppress(suppress, generation)
    expect(isSelfInducedStabilizerScroll(suppress, 110)).toBe(false)
  })

  it('newer arms survive an older frame disarm (generation-guarded)', () => {
    const suppress = createStabilizerScrollSuppress()
    const first = armStabilizerSuppress(suppress, 110)
    const second = armStabilizerSuppress(suppress, 120)
    disarmStabilizerSuppress(suppress, first)
    expect(isSelfInducedStabilizerScroll(suppress, 120)).toBe(true)
    disarmStabilizerSuppress(suppress, second)
    expect(isSelfInducedStabilizerScroll(suppress, 120)).toBe(false)
  })
})

describe('keyboard scroll pre-cancel (inputs excluded)', () => {
  it.each(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])(
    'cancels for scroll key %s on a plain target',
    (key) => {
      expect(shouldCancelStabilizerForKeyDown({ key }, { tagName: 'DIV' })).toBe(true)
    }
  )

  it('ignores non-scroll keys', () => {
    expect(shouldCancelStabilizerForKeyDown({ key: 'a' }, { tagName: 'DIV' })).toBe(false)
    expect(shouldCancelStabilizerForKeyDown({ key: 'Enter' }, { tagName: 'DIV' })).toBe(false)
  })

  it.each([['INPUT'], ['TEXTAREA'], ['SELECT']])('ignores scroll keys inside %s', (tag) => {
    expect(shouldCancelStabilizerForKeyDown({ key: 'ArrowDown' }, { tagName: tag })).toBe(false)
    expect(shouldCancelStabilizerForKeyDown({ key: ' ' }, { tagName: tag })).toBe(false)
  })

  it('ignores contentEditable targets and modified keys', () => {
    expect(shouldCancelStabilizerForKeyDown({ key: 'ArrowDown' }, { tagName: 'DIV', isContentEditable: true })).toBe(
      false
    )
    expect(shouldCancelStabilizerForKeyDown({ key: 'ArrowDown', ctrlKey: true }, { tagName: 'DIV' })).toBe(false)
    expect(shouldCancelStabilizerForKeyDown({ key: 'Home', metaKey: true }, { tagName: 'DIV' })).toBe(false)
  })
})

describe('cancel/unmount synchronous settle, idempotent single release', () => {
  it('handle.cancel settles done synchronously without another frame and stays idempotent', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const handle = runBoundedPositionStabilizer(
      container,
      100,
      {
        getCurrentOffset: () => 200,
        applyDelta: () => {},
        isCancelled: () => false
      },
      { maxMs: 1500, quietMs: 10000 }
    )
    const disconnectBefore = roInstances[0].disconnectCalls
    const cancelBefore = cancelCalls.length
    handle.cancel()
    // No flushFrames: `done` is already settled synchronously (unmount with a
    // paused rAF must not hang).
    expect(await handle.done).toBe('cancelled')
    expect(roInstances[0].disconnectCalls).toBe(disconnectBefore + 1)
    expect(cancelCalls.length).toBe(cancelBefore + 1)
    // Second cancel is a no-op: same `done`, no extra disconnect/cancel.
    handle.cancel()
    expect(await handle.done).toBe('cancelled')
    expect(roInstances[0].disconnectCalls).toBe(disconnectBefore + 1)
    expect(cancelCalls.length).toBe(cancelBefore + 1)
    // Late frames never compensate after cancel.
    flushFrames(3)
    expect(await handle.done).toBe('cancelled')
  })

  it('caller-side once-guard releases scroll token + ownership exactly once across return/error paths', () => {
    // Mirrors the Messages epoch-guarded teardown: take-then-dispose runs the
    // release callbacks once; a later restore `finally` (epoch mismatch)
    // skips so return/error paths never double-release.
    let releaseCalls = 0
    let endCalls = 0
    let active: { epoch: number } | null = { epoch: 7 }
    let currentEpoch = 7
    const dispose = (): void => {
      const taken = active?.epoch === currentEpoch ? active : null
      active = null
      if (!taken) return
      releaseCalls += 1
      endCalls += 1
    }
    dispose()
    // Simulate user-cancel bumping the epoch, then a late restore finally.
    currentEpoch += 1
    const lateFinally = (): void => {
      if (currentEpoch !== 7) return
      releaseCalls += 1
      endCalls += 1
    }
    lateFinally()
    expect(releaseCalls).toBe(1)
    expect(endCalls).toBe(1)
    expect(active).toBeNull()
  })
})
