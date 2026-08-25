/**
 * Phase 5 bounded slice — per-topic FIFO serializer for paginated/message-slice
 * window reads.
 *
 * Covers: same-topic FIFO completion order without overlap, distinct-topic
 * independence (no cross-topic blocking), rejection recovery (a failed read
 * never deadlocks later same-topic reads), structured queue-depth / wait-time
 * observability through loggerService, and the queue-depth diagnostic helper.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __test_getWindowReadQueue,
  __test_getWindowReadQueueCount,
  __test_hasWindowReadQueue,
  getWindowReadQueueDepth,
  runTopicWindowRead,
  type WindowReadQueueLogFields
} from '../windowReadQueue'

// --- Hoisted logger spies ---------------------------------------------------
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

const queuedLogs = (): Array<[string, WindowReadQueueLogFields]> =>
  loggerSpies.silly.mock.calls.filter(([msg]) => msg === '[runTopicWindowRead] window read queued') as unknown as Array<
    [string, WindowReadQueueLogFields]
  >

const startedLogs = (): Array<[string, WindowReadQueueLogFields]> =>
  loggerSpies.silly.mock.calls.filter(
    ([msg]) => msg === '[runTopicWindowRead] window read started'
  ) as unknown as Array<[string, WindowReadQueueLogFields]>

describe('windowReadQueue — per-topic FIFO read serializer', () => {
  // No public clear/dispose API is exposed — clearing out from under queued
  // callers could strand promises. Idle reclamation is internal and
  // identity-safe: a Map entry is removed only after its queue settles and
  // only if `windowReadQueues.get(topicId) === queue && queue.pending === 0 &&
  // queue.size === 0`. Test isolation relies on every test awaiting all of
  // its reads to settle (idle queues are naturally reclaimed) and on topic
  // IDs being unique where depth/order is asserted.
  beforeEach(() => {
    loggerSpies.silly.mockClear()
  })

  it('same-topic reads complete in FIFO enqueue order without overlap', async () => {
    const events: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    const read = async (id: string, delay: number): Promise<string> => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      events.push(`start:${id}`)
      await new Promise((resolve) => setTimeout(resolve, delay))
      events.push(`end:${id}`)
      inFlight--
      return id
    }

    // `b` and `c` are faster than `a`; FIFO must still force a -> b -> c.
    const results = await Promise.all([
      runTopicWindowRead('t1', 'latest', () => read('a', 25)),
      runTopicWindowRead('t1', 'around', () => read('b', 5)),
      runTopicWindowRead('t1', 'latest', () => read('c', 1))
    ])

    expect(results).toEqual(['a', 'b', 'c'])
    expect(maxInFlight).toBe(1)
    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c'])
  })

  it('reads for distinct topics run independently (never block each other)', async () => {
    const events: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    const read = async (id: string): Promise<string> => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      events.push(`start:${id}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
      events.push(`end:${id}`)
      inFlight--
      return id
    }

    const results = await Promise.all([
      runTopicWindowRead('topic-a', 'latest', () => read('a')),
      runTopicWindowRead('topic-b', 'latest', () => read('b')),
      runTopicWindowRead('topic-c', 'around', () => read('c'))
    ])

    expect(results).toEqual(['a', 'b', 'c'])
    // All three topics were in flight concurrently — cross-topic parallelism.
    expect(maxInFlight).toBe(3)
  })

  it('a rejected read rethrows but does not deadlock later same-topic reads', async () => {
    const failing = runTopicWindowRead('t1', 'latest', () => Promise.reject(new Error('boom')))
    const following = runTopicWindowRead('t1', 'around', () => Promise.resolve('ok'))

    await expect(failing).rejects.toThrow('boom')
    await expect(following).resolves.toBe('ok')

    // A further read enqueued after the failure still executes.
    await expect(runTopicWindowRead('t1', 'latest', () => Promise.resolve('after'))).resolves.toBe('after')
  })

  it('emits structured queue depth and wait duration via loggerService', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    // Slow first read holds the queue while two more reads arrive.
    const p1 = runTopicWindowRead('obs-topic', 'latest', async () => {
      await firstGate
      await new Promise((resolve) => setTimeout(resolve, 5))
      return 'a'
    })
    await flush()
    const p2 = runTopicWindowRead('obs-topic', 'around', () => Promise.resolve('b'))
    await flush()
    const p3 = runTopicWindowRead('obs-topic', 'latest', () => Promise.resolve('c'))
    await flush()
    releaseFirst()
    await Promise.all([p1, p2, p3])

    const queued = queuedLogs()
    const started = startedLogs()

    // Three enqueue events, one per read. queueDepth = reads already ahead
    // when the read joined (0, then 1, then 2); waitMs is always 0.
    expect(queued).toHaveLength(3)
    expect(queued.map(([, f]) => f.queueDepth).sort((a, b) => a - b)).toEqual([0, 1, 2])
    for (const [, f] of queued) {
      expect(f.topicId).toBe('obs-topic')
      expect(f.waitMs).toBe(0)
    }
    expect(queued.find(([, f]) => f.kind === 'around')![1]).toMatchObject({ topicId: 'obs-topic', queueDepth: 1 })

    // Three start events; every read reports wait duration and the backlog
    // it left waiting behind it. The around read (enqueued while the gated
    // first read held the queue) deterministically waited — a real waitMs —
    // and left the third read still queued behind it when it started.
    expect(started).toHaveLength(3)
    for (const [, f] of started) {
      expect(f.topicId).toBe('obs-topic')
      expect(typeof f.queueDepth).toBe('number')
      expect(typeof f.waitMs).toBe('number')
    }
    const startedAround = started.find(([, f]) => f.kind === 'around')!
    expect(startedAround[1].queueDepth).toBeGreaterThanOrEqual(1)
    expect(startedAround[1].waitMs).toBeGreaterThan(0)
    // The read that followed the around read also waited in the queue.
    expect(started.filter(([, f]) => f.kind === 'latest').some(([, f]) => f.waitMs > 0)).toBe(true)
  })

  it('getWindowReadQueueDepth reports in-flight and queued reads and returns to zero when idle', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    expect(getWindowReadQueueDepth('depth-topic')).toBe(0)
    const p1 = runTopicWindowRead('depth-topic', 'latest', async () => {
      await gate
      return 'a'
    })
    await flush()
    expect(getWindowReadQueueDepth('depth-topic')).toBe(1)
    const p2 = runTopicWindowRead('depth-topic', 'around', () => Promise.resolve('b'))
    await flush()
    expect(getWindowReadQueueDepth('depth-topic')).toBe(2)

    release()
    await Promise.all([p1, p2])
    expect(getWindowReadQueueDepth('depth-topic')).toBe(0)
  })

  // --- Idle reclamation (natural-boundary) ----------------------------------

  it('reclaims idle queue after a successful read', async () => {
    const topic = 'reclaim-success-topic'
    expect(__test_hasWindowReadQueue(topic)).toBe(false)
    await runTopicWindowRead(topic, 'latest', () => Promise.resolve('ok'))
    // Settlement triggers identity-safe reclamation when pending+size are 0.
    expect(__test_hasWindowReadQueue(topic)).toBe(false)
    expect(getWindowReadQueueDepth(topic)).toBe(0)
    // Fresh queue still serializes correctly after reclamation.
    const events: string[] = []
    const read = async (id: string, delay: number): Promise<string> => {
      events.push(`start:${id}`)
      await new Promise((resolve) => setTimeout(resolve, delay))
      events.push(`end:${id}`)
      return id
    }
    const results = await Promise.all([
      runTopicWindowRead(topic, 'latest', () => read('x', 10)),
      runTopicWindowRead(topic, 'around', () => read('y', 1))
    ])
    expect(results).toEqual(['x', 'y'])
    expect(events).toEqual(['start:x', 'end:x', 'start:y', 'end:y'])
    expect(__test_hasWindowReadQueue(topic)).toBe(false)
  })

  it('reclaims idle queue even when the read rejects', async () => {
    const topic = 'reclaim-failure-topic'
    await expect(runTopicWindowRead(topic, 'latest', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(__test_hasWindowReadQueue(topic)).toBe(false)
    expect(getWindowReadQueueDepth(topic)).toBe(0)
    // Queue remains usable after a failure.
    await expect(runTopicWindowRead(topic, 'around', () => Promise.resolve('after'))).resolves.toBe('after')
    expect(__test_hasWindowReadQueue(topic)).toBe(false)
  })

  it('does not prematurely delete a queue with running or queued work', async () => {
    const topic = 'no-premature-topic'
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const p1 = runTopicWindowRead(topic, 'latest', async () => {
      await gate
      return 'a'
    })
    await flush()
    expect(__test_hasWindowReadQueue(topic)).toBe(true)
    expect(getWindowReadQueueDepth(topic)).toBe(1)
    const qBefore = __test_getWindowReadQueue(topic)

    let releaseB!: () => void
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve
    })
    const p2 = runTopicWindowRead(topic, 'around', async () => {
      await gateB
      return 'b'
    })
    await flush()
    expect(__test_hasWindowReadQueue(topic)).toBe(true)
    expect(getWindowReadQueueDepth(topic)).toBe(2)
    // Same queue object while work is pending — not replaced.
    expect(__test_getWindowReadQueue(topic)).toBe(qBefore)

    // p1's settlement must not reclaim while p2 is queued/running.
    release()
    await p1
    // Let p-queue advance to p2; p2 is now running (pending=1) before it settles.
    await flush()
    expect(__test_hasWindowReadQueue(topic)).toBe(true)
    expect(getWindowReadQueueDepth(topic)).toBe(1)
    // Still not reclaimed while p2 is in flight.
    releaseB()
    await p2
    expect(__test_hasWindowReadQueue(topic)).toBe(false)
    expect(getWindowReadQueueDepth(topic)).toBe(0)
  })

  it('replacement queue is not deleted by a stale idle check and still serializes', async () => {
    const topic = 'replacement-topic'

    // First queue lifecycle: create and reclaim.
    await runTopicWindowRead(topic, 'latest', () => Promise.resolve('first'))
    expect(__test_hasWindowReadQueue(topic)).toBe(false)

    // Create a new queue and keep it busy.
    let releaseA!: () => void
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    const pA = runTopicWindowRead(topic, 'latest', async () => {
      await gateA
      return 'A'
    })
    await flush()
    const qNew = __test_getWindowReadQueue(topic)
    expect(qNew).toBeDefined()
    expect(__test_hasWindowReadQueue(topic)).toBe(true)

    // Queue a second read behind A — same new queue.
    const pB = runTopicWindowRead(topic, 'around', () => Promise.resolve('B'))
    await flush()
    expect(__test_getWindowReadQueue(topic)).toBe(qNew)
    expect(getWindowReadQueueDepth(topic)).toBe(2)

    // Complete both; new queue should be reclaimed only after B settles.
    releaseA()
    await Promise.all([pA, pB])
    expect(__test_hasWindowReadQueue(topic)).toBe(false)

    // After reclamation, a fresh queue must be a new object and still FIFO.
    let inFlight = 0
    let maxInFlight = 0
    const events: string[] = []
    const read = async (id: string, delay: number): Promise<string> => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      events.push(`start:${id}`)
      await new Promise((resolve) => setTimeout(resolve, delay))
      events.push(`end:${id}`)
      inFlight--
      return id
    }
    const results = await Promise.all([
      runTopicWindowRead(topic, 'latest', () => read('c', 15)),
      runTopicWindowRead(topic, 'around', () => read('d', 1)),
      runTopicWindowRead(topic, 'latest', () => read('e', 1))
    ])
    expect(results).toEqual(['c', 'd', 'e'])
    expect(maxInFlight).toBe(1)
    expect(events).toEqual(['start:c', 'end:c', 'start:d', 'end:d', 'start:e', 'end:e'])
    expect(__test_hasWindowReadQueue(topic)).toBe(false)

    // Fresh queue after idle must be a different object than the reclaimed one.
    await runTopicWindowRead(topic, 'latest', () => Promise.resolve('fresh1'))
    expect(__test_hasWindowReadQueue(topic)).toBe(false)
    const pX = runTopicWindowRead(topic, 'latest', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return 'x'
    })
    await flush()
    const qFresh = __test_getWindowReadQueue(topic)
    expect(qFresh).toBeDefined()
    expect(qFresh).not.toBe(qNew)
    await pX
    expect(__test_hasWindowReadQueue(topic)).toBe(false)
  })

  it('does not expose any public cleanup/clear/dispose API', async () => {
    const mod = await import('../windowReadQueue')
    const forbidden = ['clear', 'dispose', 'cleanup', 'reset', 'destroy', 'teardown']
    for (const name of forbidden) {
      expect((mod as unknown as Record<string, unknown>)[name]).toBeUndefined()
    }
    // The only newly exported symbols beyond the original contract are
    // test-only introspection helpers prefixed with __test_.
    const allowedExports = new Set([
      'getWindowReadQueueDepth',
      'runTopicWindowRead',
      '__test_hasWindowReadQueue',
      '__test_getWindowReadQueueCount',
      '__test_getWindowReadQueue'
    ])
    for (const key of Object.keys(mod)) {
      expect(allowedExports.has(key)).toBe(true)
    }
  })

  it('reclamation preserves cross-topic parallelism', async () => {
    const gateTopic = 'reclaim-parallel-gate'
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    // Gate one topic while other topics remain independent.
    const pGate = runTopicWindowRead(gateTopic, 'latest', async () => {
      await gate
      return 'gate'
    })
    await flush()
    expect(__test_hasWindowReadQueue(gateTopic)).toBe(true)
    const otherResults = await Promise.all([
      runTopicWindowRead('parallel-a', 'latest', () => Promise.resolve('a')),
      runTopicWindowRead('parallel-b', 'around', () => Promise.resolve('b'))
    ])
    expect(otherResults).toEqual(['a', 'b'])
    // Other topics reclaimed immediately; gated topic still present.
    expect(__test_hasWindowReadQueue('parallel-a')).toBe(false)
    expect(__test_hasWindowReadQueue('parallel-b')).toBe(false)
    expect(__test_hasWindowReadQueue(gateTopic)).toBe(true)

    releaseGate()
    await pGate
    expect(__test_hasWindowReadQueue(gateTopic)).toBe(false)
    // Verify count returns to empty when all idle.
    expect(__test_getWindowReadQueueCount()).toBe(0)
  })
})
