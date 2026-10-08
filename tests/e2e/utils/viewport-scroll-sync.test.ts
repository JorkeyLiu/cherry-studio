import { describe, expect, it } from 'vitest'

import {
  isAtBoundary,
  isPhaseOk,
  snapshotAgrees,
  waitSettled,
  wheelAndSettle,
  type ScrollGeometry,
  type ScrollSyncDeps
} from './viewport-scroll-sync'

function geom(partial: Partial<ScrollGeometry> = {}): ScrollGeometry {
  return {
    scrollTop: -500,
    scrollHeight: 2000,
    clientHeight: 800,
    phase: 'idle',
    anchorId: 'msg-a',
    anchorOffset: 10,
    snapshotId: 'msg-a',
    ...partial
  }
}

interface MockDeps extends ScrollSyncDeps {
  wheelCalls: number[]
}

function mockDeps(readings: ScrollGeometry[] | (() => ScrollGeometry)): MockDeps {
  let i = 0
  let t = 0
  const wheelCalls: number[] = []
  const next = typeof readings === 'function' ? readings : () => readings[Math.min(i++, readings.length - 1)]
  return {
    wheelCalls,
    read: async () => ({ ...next() }),
    dispatchWheel: async (dy: number) => {
      wheelCalls.push(dy)
    },
    sleep: async (ms: number) => {
      t += ms
    },
    now: () => t
  }
}

describe('isPhaseOk', () => {
  it('admits revealed and idle only', () => {
    expect(isPhaseOk('revealed')).toBe(true)
    expect(isPhaseOk('idle')).toBe(true)
    expect(isPhaseOk('positioning')).toBe(false)
    expect(isPhaseOk('')).toBe(false)
  })
})

describe('isAtBoundary', () => {
  it('detects both extremes', () => {
    expect(isAtBoundary({ scrollTop: 0, scrollHeight: 2000, clientHeight: 800 }, 2)).toBe(true)
    expect(isAtBoundary({ scrollTop: -1200, scrollHeight: 2000, clientHeight: 800 }, 2)).toBe(true)
    expect(isAtBoundary({ scrollTop: -500, scrollHeight: 2000, clientHeight: 800 }, 2)).toBe(false)
  })

  it('rejects non-finite geometry', () => {
    expect(isAtBoundary({ scrollTop: NaN, scrollHeight: 2000, clientHeight: 800 }, 2)).toBe(false)
  })
})

describe('snapshotAgrees', () => {
  it('passes without an allowed set', () => {
    expect(snapshotAgrees({ anchorId: 'a', snapshotId: '' }, null)).toBe(true)
    expect(snapshotAgrees({ anchorId: 'a', snapshotId: 'b' }, undefined)).toBe(true)
  })

  it('requires live anchor to equal an allowed snapshot id', () => {
    expect(snapshotAgrees({ anchorId: 'a', snapshotId: 'a' }, ['a', 'b'])).toBe(true)
    expect(snapshotAgrees({ anchorId: 'a', snapshotId: 'b' }, ['a', 'b'])).toBe(false)
    expect(snapshotAgrees({ anchorId: 'a', snapshotId: 'a' }, ['b'])).toBe(false)
    expect(snapshotAgrees({ anchorId: '', snapshotId: '' }, ['a'])).toBe(false)
  })
})

describe('waitSettled', () => {
  it('resolves on consecutive stable frames', async () => {
    const deps = mockDeps([geom(), geom(), geom(), geom(), geom()])
    const r = await waitSettled(deps, { timeoutMs: 2000 })
    expect(r.id).toBe('msg-a')
    expect(r.offset).toBe(10)
    expect(r.phase).toBe('idle')
    expect(r.samples).toBeGreaterThanOrEqual(3)
  })

  it('throws loudly when the anchor never stabilizes', async () => {
    let n = 0
    const deps = mockDeps(() => geom({ anchorId: `msg-${n++}`, anchorOffset: n }))
    await expect(waitSettled(deps, { timeoutMs: 300 })).rejects.toThrow(/failed to settle within 300ms/)
    expect(deps.wheelCalls).toHaveLength(0)
  })

  it('does not pass early on two old frames that move again', async () => {
    const stable = geom()
    const moved = geom({ anchorId: 'msg-b', anchorOffset: 40 })
    const deps = mockDeps([stable, stable, moved, moved, moved, moved, moved])
    const r = await waitSettled(deps, { timeoutMs: 2000 })
    // Must settle on the NEW geometry after three fresh stable frames, never on the old one.
    expect(r.id).toBe('msg-b')
    expect(r.samples).toBeGreaterThanOrEqual(5)
  })

  it('waits out pagination growth before settling', async () => {
    const a = geom()
    const grown = geom({ scrollHeight: 2400 })
    const deps = mockDeps([a, grown, grown, grown, grown, grown])
    const r = await waitSettled(deps, { timeoutMs: 2000 })
    expect(r.scrollHeight).toBe(2400)
    expect(r.samples).toBeGreaterThanOrEqual(4)
  })

  it('rejects while the phase stays positioning', async () => {
    const deps = mockDeps([geom({ phase: 'positioning' })])
    await expect(waitSettled(deps, { timeoutMs: 300 })).rejects.toThrow(/failed to settle/)
  })

  it('rejects when the snapshot never agrees with the live anchor', async () => {
    const deps = mockDeps([geom({ anchorId: 'live', snapshotId: 'stale' })])
    await expect(waitSettled(deps, { timeoutMs: 300, allowedIds: ['live', 'stale'] })).rejects.toThrow(
      /failed to settle/
    )
  })
})

describe('wheelAndSettle', () => {
  it('proves delivery via observed scroll movement', async () => {
    const readings = [
      geom({ scrollTop: -500 }),
      geom({ scrollTop: -700 }),
      geom({ scrollTop: -700 }),
      geom({ scrollTop: -700 }),
      geom({ scrollTop: -700 })
    ]
    const deps = mockDeps(readings)
    const r = await wheelAndSettle(deps, 560, { timeoutMs: 2000 })
    expect(deps.wheelCalls).toEqual([560])
    expect(r.scrollSeen).toBe(true)
    expect(r.boundaryNoOp).toBe(false)
    expect(r.scrollTop).toBe(-700)
  })

  it('accepts a deterministic boundary no-op without movement', async () => {
    const atBottom = geom({ scrollTop: 0, anchorId: 'last', snapshotId: 'last' })
    const deps = mockDeps([atBottom])
    const r = await wheelAndSettle(deps, 560, { timeoutMs: 2000 })
    expect(deps.wheelCalls).toEqual([560])
    expect(r.scrollSeen).toBe(false)
    expect(r.boundaryNoOp).toBe(true)
  })

  it('never passes a non-boundary wheel with no scroll as success', async () => {
    const stuck = geom({ scrollTop: -500 })
    const deps = mockDeps([stuck])
    await expect(wheelAndSettle(deps, 560, { timeoutMs: 400 })).rejects.toThrow(/failed to settle/)
    // The wheel was still dispatched exactly once: no silent skip, no retry loop.
    expect(deps.wheelCalls).toEqual([560])
  })

  it('reports the last observed state on timeout', async () => {
    let n = 0
    const deps = mockDeps(() => geom({ scrollTop: -500 - n++ * 50 }))
    await expect(wheelAndSettle(deps, -560, { timeoutMs: 300 })).rejects.toThrow(/last=.*st=-/)
  })
})
