/**
 * Per-execution stream write ownership (chat lightweight slice 1).
 *
 * Locks the structural guarantees of StreamWriteScheduler without any timing
 * or performance claim:
 *
 * - Two executions streaming the SAME block id never share a throttler or
 *   overwrite each other's trailing context (attempt/barrier/route/mirror).
 * - Cancelling/flushing one execution cannot touch another's pending writes.
 * - Block deletion (`cancelBlockEverywhere`) fans out across every live
 *   scheduler — the only sanctioned cross-execution operation.
 * - `dispose()` cancels pending throttle timers + RAF handles, unregisters
 *   from the live registry, and drops later `schedule` calls (no new write
 *   afterwards); in-flight barrier-tracked DB promises still settle.
 * - `flush()` + barrier preserves final-write ordering (trailing write is
 *   tracked, `quiesce()` resolves only after it lands), and a withheld RAF
 *   never blocks quiescence (RAF only mirrors to Redux, never SQLite).
 * - `drainMirrors()` runs withheld mirrors inline without another DB write
 *   (terminal projection completeness before dispose cancels RAF); cancel
 *   and dispose drop pending mirrors.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ResolvedWriteTarget } from '../streamWriteScheduler'
import { cancelBlockEverywhere, liveSchedulerCount, StreamWriteScheduler } from '../streamWriteScheduler'
import { WriteBarrier } from '../writeBarrier'

const THROTTLE_MS = 50

interface RecordedWrite {
  id: string
  update: any
  target: ResolvedWriteTarget
}

interface RecordedMirror {
  id: string
  update: any
  topicId?: string
}

interface Harness {
  scheduler: StreamWriteScheduler
  writes: RecordedWrite[]
  mirrors: RecordedMirror[]
  barrier: WriteBarrier
}

// One controllable RAF queue per test file: every scheduler created while the
// stubs are installed records here. Firing is explicit, so "withheld RAF"
// and "gate evaluated at frame time" are deterministic.
const pendingRafs = new Map<number, FrameRequestCallback>()
let rafSeq = 0

function fireRafs(): void {
  const pending = [...pendingRafs.entries()]
  pendingRafs.clear()
  for (const [, cb] of pending) {
    cb(0)
  }
}

function createScheduler(
  opts: {
    resendAttemptId?: string
    topicId?: string
    branchId?: string | null
    isLoaded?: () => boolean
    writeImpl?: (id: string, update: any, target: ResolvedWriteTarget) => Promise<unknown> | unknown
  } = {}
): Harness {
  const writes: RecordedWrite[] = []
  const mirrors: RecordedMirror[] = []
  const barrier = new WriteBarrier()
  const scheduler = new StreamWriteScheduler({
    throttleMs: THROTTLE_MS,
    resendAttemptId: opts.resendAttemptId,
    barrier,
    topicId: opts.topicId,
    branchId: opts.branchId,
    isLoaded: opts.isLoaded,
    performWrite: (id, update, target) => {
      writes.push({ id, update, target })
      return opts.writeImpl ? opts.writeImpl(id, update, target) : Promise.resolve()
    },
    mirrorToRedux: (id, update, topicId) => {
      mirrors.push({ id, update, topicId })
    }
  })
  return { scheduler, writes, mirrors, barrier }
}

describe('StreamWriteScheduler per-execution ownership', () => {
  const owned: StreamWriteScheduler[] = []

  beforeEach(() => {
    owned.length = 0
    pendingRafs.clear()
    rafSeq = 0
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafSeq += 1
      pendingRafs.set(rafSeq, cb)
      return rafSeq
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      pendingRafs.delete(id)
    })
  })

  afterEach(() => {
    for (const scheduler of owned) {
      scheduler.dispose()
    }
    owned.length = 0
    vi.unstubAllGlobals()
  })

  function own(h: Harness): Harness {
    owned.push(h.scheduler)
    return h
  }

  it('two executions on the same block keep independent trailing context', () => {
    const a = own(createScheduler({ resendAttemptId: 'attempt-a', topicId: 't', branchId: 'br-a' }))
    const b = own(createScheduler({ resendAttemptId: 'attempt-b', topicId: 't', branchId: 'br-b' }))

    a.scheduler.schedule('b-1', { content: 'a-first' })
    b.scheduler.schedule('b-1', { content: 'b-first' })

    // Leading edge fires synchronously per scheduler: each execution's own
    // attempt/route travels with its own write — never a shared trailing mix.
    expect(a.writes).toHaveLength(1)
    expect(a.writes[0]).toMatchObject({
      id: 'b-1',
      update: { content: 'a-first' },
      target: { resendAttemptId: 'attempt-a', topicId: 't', branchId: 'br-a' }
    })
    expect(b.writes).toHaveLength(1)
    expect(b.writes[0]).toMatchObject({
      id: 'b-1',
      update: { content: 'b-first' },
      target: { resendAttemptId: 'attempt-b', topicId: 't', branchId: 'br-b' }
    })
  })

  it('cancelling one execution leaves the other execution pending write intact', () => {
    const a = own(createScheduler({ resendAttemptId: 'attempt-a' }))
    const b = own(createScheduler({ resendAttemptId: 'attempt-b' }))
    // Two rapid updates per execution: leading fires, trailing stays pending.
    a.scheduler.schedule('b-1', { content: 'a-1' })
    a.scheduler.schedule('b-1', { content: 'a-2' })
    b.scheduler.schedule('b-1', { content: 'b-1' })
    b.scheduler.schedule('b-1', { content: 'b-2' })
    a.scheduler.cancel('b-1')
    a.scheduler.flush('b-1')
    b.scheduler.flush('b-1')
    // A keeps only its leading write; B keeps leading + flushed trailing.
    expect(a.writes.map((w) => w.update)).toEqual([{ content: 'a-1' }])
    expect(b.writes.map((w) => w.update)).toEqual([{ content: 'b-1' }, { content: 'b-2' }])
    expect(b.writes[1].target.resendAttemptId).toBe('attempt-b')
  })
  it('deletion cancel fans out to every live scheduler but a later execution still works', () => {
    const a = own(createScheduler({ resendAttemptId: 'attempt-a' }))
    const b = own(createScheduler({ resendAttemptId: 'attempt-b' }))
    a.scheduler.schedule('b-del', { content: 'a-1' })
    a.scheduler.schedule('b-del', { content: 'a-2' })
    b.scheduler.schedule('b-del', { content: 'b-1' })
    b.scheduler.schedule('b-del', { content: 'b-2' })
    cancelBlockEverywhere('b-del')
    a.scheduler.flush('b-del')
    b.scheduler.flush('b-del')
    // Only the already-fired leading writes remain; both pending trailing
    // writes were dropped by the deletion cancel.
    expect(a.writes.map((w) => w.update)).toEqual([{ content: 'a-1' }])
    expect(b.writes.map((w) => w.update)).toEqual([{ content: 'b-1' }])
    // A later execution reusing the block id is unaffected.
    const c = own(createScheduler({ resendAttemptId: 'attempt-c' }))
    c.scheduler.schedule('b-del', { content: 'c-1' })
    c.scheduler.schedule('b-del', { content: 'c-2' })
    c.scheduler.flush('b-del')
    expect(c.writes.map((w) => w.update)).toEqual([{ content: 'c-1' }, { content: 'c-2' }])
    expect(c.writes[0].target.resendAttemptId).toBe('attempt-c')
  })

  it('dispose cancels pending RAF/timer, unregisters, and drops later writes', async () => {
    const liveBefore = liveSchedulerCount()
    const h = own(createScheduler({}))
    expect(liveSchedulerCount()).toBe(liveBefore + 1)

    h.scheduler.schedule('b-1', { content: 'first' })
    h.scheduler.schedule('b-1', { content: 'second' })
    // Leading fired; trailing + RAF mirror still pending.
    expect(h.writes).toHaveLength(1)
    expect(pendingRafs.size).toBe(1)

    // afterEach also disposes; disposing twice is a no-op by contract.
    h.scheduler.dispose()
    expect(h.scheduler.isDisposed).toBe(true)
    expect(liveSchedulerCount()).toBe(liveBefore)
    expect(pendingRafs.size).toBe(0)

    // Flushing or scheduling after dispose produces nothing, and firing the
    // (cancelled) RAF queue mirrors nothing.
    h.scheduler.flush('b-1')
    h.scheduler.schedule('b-1', { content: 'after-dispose' })
    fireRafs()
    await Promise.resolve()

    expect(h.writes).toHaveLength(1)
    expect(h.mirrors).toHaveLength(0)
  })

  it('flush tracks the trailing write on the barrier, preserving final order', async () => {
    const releases: Array<() => void> = []
    const h = own(
      createScheduler({
        writeImpl: () =>
          new Promise<void>((resolve) => {
            releases.push(resolve)
          })
      })
    )
    h.scheduler.schedule('b-1', { content: 'leading' })
    h.scheduler.schedule('b-1', { content: 'trailing' })
    h.scheduler.flush('b-1')
    expect(h.writes.map((w) => w.update)).toEqual([{ content: 'leading' }, { content: 'trailing' }])
    expect(h.barrier.pendingCount).toBe(2)
    let quiesced = false
    const quiesce = h.barrier.quiesce().then(() => {
      quiesced = true
    })
    // Settle only the leading write: quiescence must still hold for trailing.
    releases[0]()
    await new Promise((r) => setTimeout(r, 0))
    expect(quiesced).toBe(false)
    releases[1]()
    await quiesce
    expect(quiesced).toBe(true)
  })

  it('a withheld RAF never blocks barrier quiescence', async () => {
    const h = own(createScheduler({}))
    h.scheduler.schedule('b-1', { content: 'chunk' })
    expect(pendingRafs.size).toBe(1)

    // Never fire the RAF queue: the DB write is tracked, the mirror is not.
    await h.barrier.quiesce()
    expect(h.writes).toHaveLength(1)
    expect(h.mirrors).toHaveLength(0)

    // Firing later still mirrors without producing another DB write.
    fireRafs()
    expect(h.mirrors).toHaveLength(1)
    expect(h.writes).toHaveLength(1)
  })

  it('drainMirrors runs withheld mirrors inline without another DB write', () => {
    const h = own(createScheduler({}))
    h.scheduler.schedule('b-1', { content: 'chunk' })
    expect(pendingRafs.size).toBe(1)
    expect(h.writes).toHaveLength(1)

    // No frame fired: drain publishes the mirror inline, DB untouched.
    h.scheduler.drainMirrors()
    expect(h.mirrors).toHaveLength(1)
    expect(h.mirrors[0]).toMatchObject({ id: 'b-1', update: { content: 'chunk' } })
    expect(h.writes).toHaveLength(1)
    expect(pendingRafs.size).toBe(0)

    // The drained RAF never fires twice.
    fireRafs()
    expect(h.mirrors).toHaveLength(1)
    expect(h.writes).toHaveLength(1)
  })
  it('drainMirrors after cancel or dispose mirrors nothing', async () => {
    const h = own(createScheduler({}))
    h.scheduler.schedule('b-1', { content: 'cancelled' })
    h.scheduler.cancel('b-1')
    h.scheduler.drainMirrors()
    expect(h.mirrors).toHaveLength(0)

    h.scheduler.schedule('b-2', { content: 'disposed' })
    h.scheduler.dispose()
    h.scheduler.drainMirrors()
    fireRafs()
    await Promise.resolve()
    expect(h.mirrors).toHaveLength(0)
  })

  it('the mirror gate is evaluated when the RAF runs, not at call time', () => {
    let loaded = true
    const h = own(createScheduler({ isLoaded: () => loaded }))
    h.scheduler.schedule('b-1', { content: 'chunk' })

    // Topic evicted between the call and the frame: mirror stops, DB stands.
    loaded = false
    fireRafs()

    expect(h.writes).toHaveLength(1)
    expect(h.mirrors).toHaveLength(0)
  })

  it('execution-bound values flow straight through with no per-call override', () => {
    const mirrorGate = vi.fn(() => true)
    const h = own(
      createScheduler({
        resendAttemptId: 'attempt-exec',
        topicId: 't-exec',
        branchId: 'br-exec',
        isLoaded: mirrorGate
      })
    )
    h.scheduler.schedule('b-1', { content: 'leading' })
    h.scheduler.schedule('b-1', { content: 'trailing' })
    h.scheduler.flush('b-1')
    fireRafs()

    // Leading and trailing writes both carry the execution bindings; only the
    // latest (trailing) mirror survives, since a newer write cancels the
    // withheld RAF before scheduling its own.
    expect(h.writes).toHaveLength(2)
    for (const write of h.writes) {
      expect(write.target).toEqual({ resendAttemptId: 'attempt-exec', topicId: 't-exec', branchId: 'br-exec' })
    }
    expect(mirrorGate).toHaveBeenCalled()
    expect(h.mirrors).toHaveLength(1)
    expect(h.mirrors[0]).toMatchObject({ id: 'b-1', update: { content: 'trailing' } })
  })
})
