/**
 * Regression coverage batch for already implemented Phase 4/S6.1 lifecycle contracts:
 * window-read queue serialization/failure progression.
 *
 * This file hardens thin proof around per-topic FIFO queue behavior without
 * changing production semantics (ARCH-001..ARCH-012 locked). It directly
 * exercises the public `runTopicWindowRead` boundary and fails on:
 * - cross-topic serialization regressions (distinct topics must not block each other)
 * - per-topic FIFO regressions (same-topic reads must complete in enqueue order)
 * - failure-stall regressions (a rejected read must advance the queue)
 *
 * Renderer-local only, no IPC/preload/shared-contract, no schema/migration.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __test_getWindowReadQueue,
  __test_getWindowReadQueueCount,
  __test_hasWindowReadQueue,
  getWindowReadQueueDepth,
  runTopicWindowRead
} from '../windowReadQueue'

const { loggerSpies } = vi.hoisted(() => ({
  loggerSpies: {
    silly: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => loggerSpies
  }
}))

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('windowReadQueue regression — cross-topic parallelism with per-topic FIFO', () => {
  beforeEach(() => {
    loggerSpies.silly.mockClear()
  })

  it('distinct topics proceed without cross-topic blocking while each topic remains FIFO', async () => {
    // Gated A1 holds its per-topic queue; A2 is queued behind A1 on same topic.
    // B1 on a distinct topic must proceed concurrently (not blocked by A1).
    // Failure to maintain per-topic isolation would serialize B1 behind A1;
    // failure to maintain FIFO would let A2 start before A1 finishes.
    let releaseA1!: () => void
    const gateA1 = new Promise<void>((resolve) => {
      releaseA1 = resolve
    })

    const events: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    const track = async (id: string, gate?: Promise<void>): Promise<string> => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      events.push(`start:${id}`)
      if (gate) await gate
      else await new Promise((r) => setTimeout(r, 5))
      events.push(`end:${id}`)
      inFlight--
      return id
    }

    let pA1!: Promise<string>
    let pA2!: Promise<string>
    let pB1!: Promise<string>
    try {
      pA1 = runTopicWindowRead('topic-A-regression', 'latest', () => track('A1', gateA1))
      await flush()
      expect(__test_hasWindowReadQueue('topic-A-regression')).toBe(true)
      expect(getWindowReadQueueDepth('topic-A-regression')).toBe(1)
      expect(events).toEqual(['start:A1'])
      const queueABefore = __test_getWindowReadQueue('topic-A-regression')

      pA2 = runTopicWindowRead('topic-A-regression', 'around', () => track('A2'))
      await flush()
      // A2 queued behind A1 — must not have started yet (per-topic FIFO).
      expect(events).not.toContain('start:A2')
      expect(getWindowReadQueueDepth('topic-A-regression')).toBe(2)
      // Same queue instance before/after enqueue while work is pending (not tautological)
      expect(__test_getWindowReadQueue('topic-A-regression')).toBe(queueABefore)

      pB1 = runTopicWindowRead('topic-B-regression', 'latest', () => track('B1'))
      await flush()
      // B1 is on distinct topic — must have started despite A1 still gated (cross-topic parallelism).
      expect(events).toContain('start:B1')
      // A2 still must not have started while A1 gated
      expect(events).not.toContain('start:A2')
      // Distinct queues are independent
      expect(__test_hasWindowReadQueue('topic-B-regression')).toBe(true)
      expect(__test_getWindowReadQueueCount()).toBe(2)
      // At least 2 concurrent in-flight (A1 and B1) proves no global serialization
      expect(maxInFlight).toBeGreaterThanOrEqual(2)

      // B1 completes while A1 still gated — cross-topic not blocked
      await pB1
      expect(events).toEqual(expect.arrayContaining(['start:A1', 'start:B1', 'end:B1']))
      expect(events).not.toContain('start:A2')
      expect(__test_hasWindowReadQueue('topic-B-regression')).toBe(false)
      expect(__test_hasWindowReadQueue('topic-A-regression')).toBe(true)

      // Release A1 — A2 must then run FIFO after A1, and still achieve overall order A1→A2
      releaseA1()
      const [a1, b1, a2] = await Promise.all([pA1, pB1, pA2])
      expect(a1).toBe('A1')
      expect(b1).toBe('B1')
      expect(a2).toBe('A2')
      // Event order proves FIFO per-topic and parallelism across topics:
      // A1 started before B1, B1 ended before A1 ended, A2 only started after A1 ended
      expect(events).toEqual(['start:A1', 'start:B1', 'end:B1', 'end:A1', 'start:A2', 'end:A2'])
      expect(__test_hasWindowReadQueue('topic-A-regression')).toBe(false)
      expect(__test_hasWindowReadQueue('topic-B-regression')).toBe(false)
      expect(__test_getWindowReadQueueCount()).toBe(0)
    } finally {
      try {
        releaseA1?.()
      } catch {}
      await Promise.allSettled([pA1, pA2, pB1].filter(Boolean))
    }
  })

  it('interleaved enqueue preserves per-topic FIFO for each topic independently', async () => {
    // Interleave topics to prove queues are keyed per topic, not global FIFO
    const events: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    const read = async (id: string, delay: number): Promise<string> => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      events.push(`start:${id}`)
      await new Promise((r) => setTimeout(r, delay))
      events.push(`end:${id}`)
      inFlight--
      return id
    }

    // Enqueue order: A1, B1, A2, B2, C1 — but per-topic FIFO must be A1→A2 and B1→B2
    // Faster B2 must not overtake B1, and faster A2 must not overtake A1
    const pA1 = runTopicWindowRead('topic-A-inter', 'latest', () => read('A1', 20))
    const pB1 = runTopicWindowRead('topic-B-inter', 'latest', () => read('B1', 15))
    const pA2 = runTopicWindowRead('topic-A-inter', 'around', () => read('A2', 1))
    const pB2 = runTopicWindowRead('topic-B-inter', 'around', () => read('B2', 1))
    const pC1 = runTopicWindowRead('topic-C-inter', 'latest', () => read('C1', 1))

    const [a1, b1, a2, b2, c1] = await Promise.all([pA1, pB1, pA2, pB2, pC1])
    expect(a1).toBe('A1')
    expect(b1).toBe('B1')
    expect(a2).toBe('A2')
    expect(b2).toBe('B2')
    expect(c1).toBe('C1')

    // Per-topic FIFO: A1 before A2, B1 before B2
    expect(events.indexOf('start:A1')).toBeLessThan(events.indexOf('start:A2'))
    expect(events.indexOf('end:A1')).toBeLessThan(events.indexOf('start:A2'))
    expect(events.indexOf('start:B1')).toBeLessThan(events.indexOf('start:B2'))
    expect(events.indexOf('end:B1')).toBeLessThan(events.indexOf('start:B2'))

    // Cross-topic parallelism: topics ran concurrently (maxInFlight >1)
    expect(maxInFlight).toBeGreaterThanOrEqual(2)

    // All queues reclaimed after idle
    expect(__test_hasWindowReadQueue('topic-A-inter')).toBe(false)
    expect(__test_hasWindowReadQueue('topic-B-inter')).toBe(false)
    expect(__test_hasWindowReadQueue('topic-C-inter')).toBe(false)
  })
})

describe('windowReadQueue regression — failure progression', () => {
  beforeEach(() => {
    loggerSpies.silly.mockClear()
  })

  it('a rejected per-topic read advances the queue so a later read can complete', async () => {
    // First read rejects; second and third queued behind must still execute in FIFO order
    // Regression: failure must not stall queue (PQueue must advance after rejection)
    let releaseFail!: () => void
    const gateFail = new Promise<void>((resolve) => {
      releaseFail = resolve
    })

    const events: string[] = []
    let failing!: Promise<unknown>
    let following1!: Promise<string>
    let following2!: Promise<string>
    try {
      failing = runTopicWindowRead('t-fail-advance', 'latest', async () => {
        events.push('start:fail')
        await gateFail
        events.push('end:fail')
        throw new Error('boom-fail')
      })
      await flush()
      expect(getWindowReadQueueDepth('t-fail-advance')).toBe(1)
      expect(events).toEqual(['start:fail'])

      following1 = runTopicWindowRead('t-fail-advance', 'around', async () => {
        events.push('start:ok1')
        await new Promise((r) => setTimeout(r, 5))
        events.push('end:ok1')
        return 'ok1'
      })
      following2 = runTopicWindowRead('t-fail-advance', 'latest', async () => {
        events.push('start:ok2')
        await new Promise((r) => setTimeout(r, 1))
        events.push('end:ok2')
        return 'ok2'
      })
      await flush()
      // Both following reads queued behind failing — not started yet
      expect(events).not.toContain('start:ok1')
      expect(events).not.toContain('start:ok2')
      expect(getWindowReadQueueDepth('t-fail-advance')).toBe(3)

      releaseFail()
      await expect(failing).rejects.toThrow('boom-fail')
      // After failure, queue must have advanced to ok1
      await expect(following1).resolves.toBe('ok1')
      await expect(following2).resolves.toBe('ok2')

      // FIFO after failure: fail → ok1 → ok2
      expect(events).toEqual(['start:fail', 'end:fail', 'start:ok1', 'end:ok1', 'start:ok2', 'end:ok2'])

      // Further read after failure chain still executes
      await expect(runTopicWindowRead('t-fail-advance', 'latest', () => Promise.resolve('after'))).resolves.toBe(
        'after'
      )
      expect(__test_hasWindowReadQueue('t-fail-advance')).toBe(false)
      expect(getWindowReadQueueDepth('t-fail-advance')).toBe(0)
    } finally {
      try {
        releaseFail?.()
      } catch {}
      await Promise.allSettled([failing, following1, following2].filter(Boolean))
    }
  })

  it('multiple sequential failures each advance the queue independently', async () => {
    const fail1 = runTopicWindowRead('t-multi-fail', 'latest', () => Promise.reject(new Error('fail1')))
    const fail2 = runTopicWindowRead('t-multi-fail', 'around', () => Promise.reject(new Error('fail2')))
    const success = runTopicWindowRead('t-multi-fail', 'latest', () => Promise.resolve('success'))

    await expect(fail1).rejects.toThrow('fail1')
    await expect(fail2).rejects.toThrow('fail2')
    await expect(success).resolves.toBe('success')
    expect(__test_hasWindowReadQueue('t-multi-fail')).toBe(false)
  })

  it('failure on one topic does not affect reads on another topic', async () => {
    let releaseFail!: () => void
    const gateFail = new Promise<void>((resolve) => {
      releaseFail = resolve
    })
    let failingTopicA!: Promise<unknown>
    try {
      failingTopicA = runTopicWindowRead('topic-A-fail-isolated', 'latest', async () => {
        await gateFail
        throw new Error('boom-A')
      })
      await flush()
      expect(__test_hasWindowReadQueue('topic-A-fail-isolated')).toBe(true)

      // Distinct topic B should succeed immediately despite A gated-failing
      const okB = await runTopicWindowRead('topic-B-fail-isolated', 'latest', () => Promise.resolve('ok-B'))
      expect(okB).toBe('ok-B')
      expect(__test_hasWindowReadQueue('topic-B-fail-isolated')).toBe(false)

      releaseFail()
      await expect(failingTopicA).rejects.toThrow('boom-A')

      // Following read on A after failure must still succeed (isolation + progression)
      await expect(
        runTopicWindowRead('topic-A-fail-isolated', 'latest', () => Promise.resolve('after-A'))
      ).resolves.toBe('after-A')
      expect(__test_hasWindowReadQueue('topic-A-fail-isolated')).toBe(false)
    } finally {
      try {
        releaseFail?.()
      } catch {}
      await Promise.allSettled([failingTopicA].filter(Boolean))
    }
  })
})
