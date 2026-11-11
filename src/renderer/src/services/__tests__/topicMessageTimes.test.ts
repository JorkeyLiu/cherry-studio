/**
 * Runtime topic ordering service: the authoritative latest-message-instant
 * read, the continuous single-topic moves, and the stale-response / lifecycle
 * guards that keep a late read from overwriting a newer observation or moving
 * topics after the policy was disabled.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const testBed = vi.hoisted(() => ({
  state: null as any,
  dispatched: [] as any[],
  fetchTopicMessageTimes: null as any
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }
}))

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => testBed.state,
    dispatch: (action: any) => {
      testBed.dispatched.push(action)
      // Minimal reducer: the real store applies these actions, so the tests see
      // the same state transitions the app sees.
      const assistants = testBed.state?.assistants?.assistants ?? []
      if (action?.type === 'assistants/updateTopics') {
        const assistant = assistants.find((item: any) => item.id === action.payload.assistantId)
        if (assistant) assistant.topics = action.payload.topics
      }
      if (action?.type === 'assistants/updateAssistant') {
        const assistant = assistants.find((item: any) => item.id === action.payload.id)
        if (assistant) Object.assign(assistant, action.payload)
      }
      return action
    }
  }
}))

vi.mock('@renderer/store/assistants', () => ({
  updateAssistant: (payload: unknown) => ({ type: 'assistants/updateAssistant', payload }),
  updateTopics: (payload: unknown) => ({ type: 'assistants/updateTopics', payload })
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    fetchTopicMessageTimes: (...args: unknown[]) => testBed.fetchTopicMessageTimes(...args)
  }
}))
import type { FetchTopicMessageTimesResponse } from '@shared/chatDb'

import {
  enableUpdateTimeOrder,
  initializeTopicOrderDefaults,
  noteTopicMessageWrite,
  noteTopicReferenceInvalidation,
  prepareTopicMessageWrite,
  primeTopicMessageTimesBaseline,
  readTopicMessageTimes,
  resetTopicMessageTimes,
  subscribeTopicMessageTimeInvalidation,
  unsubscribeTopicMessageTimeInvalidationForTests
} from '../topicMessageTimes'

type T = { id: string; name: string; assistantId: string; createdAt: string; pinned?: boolean; messages: never[] }

function topic(id: string, createdAt: string, pinned = false): T {
  return { id, name: id, assistantId: 'a1', createdAt, pinned, messages: [] }
}

function buildState(mode: 'manual' | 'updated' | undefined, topics: T[]) {
  const assistant: any = { id: 'a1', name: 'A', topics: topics.map((item) => ({ ...item })) }
  if (mode) assistant.topicOrderMode = mode
  testBed.state = { assistants: { assistants: [assistant] } }
  return assistant
}

function response(entries: Record<string, string | null>): FetchTopicMessageTimesResponse {
  const topics = Object.entries(entries).map(([topicId, latestMessageAt]) => ({ topicId, latestMessageAt }))
  return {
    topics,
    messageTimes: {
      completeness: 'topic-activity',
      requestedTopicCount: topics.length,
      returnedTopicCount: topics.length
    }
  }
}

/** Static Main read: every requested id is answered from the given table. */
function serve(times: Record<string, string | null>) {
  testBed.fetchTopicMessageTimes = vi.fn(async (topicIds: string[]) => {
    const entries: Record<string, string | null> = {}
    for (const id of topicIds) {
      if (Object.prototype.hasOwnProperty.call(times, id)) entries[id] = times[id]
    }
    return response(entries)
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const topicOrderDispatches = () => testBed.dispatched.filter((action) => action.type === 'assistants/updateTopics')

const lastOrder = () => {
  const calls = topicOrderDispatches()
  const last = calls.at(-1)
  if (!last) throw new Error('no topic order was written')
  return (last.payload.topics as T[]).map((item) => item.id)
}

const assistantDispatches = () => testBed.dispatched.filter((action) => action.type === 'assistants/updateAssistant')

/** Lets the fire-and-forget refresh (dynamic import + chunked read) settle. */
async function flush(): Promise<void> {
  for (let index = 0; index < 14; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

beforeEach(() => {
  testBed.dispatched = []
  unsubscribeTopicMessageTimeInvalidationForTests()
  testBed.fetchTopicMessageTimes = vi.fn(async (topicIds: string[]) =>
    response(Object.fromEntries(topicIds.map((id) => [id, null])))
  )
  resetTopicMessageTimes()
})

describe('readTopicMessageTimes', () => {
  it('deduplicates ids and returns a caller-local map', async () => {
    serve({ a: '2026-01-01T00:00:00.000Z', b: null })
    const times = await readTopicMessageTimes(['a', 'a', 'b'])
    expect(times.get('a')).toBe('2026-01-01T00:00:00.000Z')
    expect(times.get('b')).toBeNull()
    expect(testBed.fetchTopicMessageTimes).toHaveBeenCalledTimes(1)
  })

  it('splits ids above the per-call bound into chunks', async () => {
    const ids = Array.from({ length: 1203 }, (_, index) => `t${index}`)
    await readTopicMessageTimes(ids)
    expect(testBed.fetchTopicMessageTimes).toHaveBeenCalledTimes(3)
    expect((testBed.fetchTopicMessageTimes.mock.calls[0][0] as string[]).length).toBe(500)
  })
})

describe('enableUpdateTimeOrder', () => {
  it("orders non-pinned topics by Main's latest message instant and persists the policy", async () => {
    buildState(undefined, [
      topic('a', '2026-01-01T00:00:00.000Z'),
      topic('b', '2026-01-02T00:00:00.000Z'),
      topic('c', '2026-01-03T00:00:00.000Z'),
      topic('p', '2025-01-01T00:00:00.000Z', true)
    ])
    // The persisted topic timestamps deliberately conflict with the real
    // message instants: a is newest by messages, c is oldest.
    serve({
      a: '2026-05-01T00:00:00.000Z',
      b: '2026-04-01T00:00:00.000Z',
      p: '2026-06-01T00:00:00.000Z'
    })

    const ok = await enableUpdateTimeOrder('a1')

    expect(ok).toBe(true)
    expect(lastOrder()).toEqual(['p', 'a', 'b', 'c'])
    expect(assistantDispatches().at(-1)?.payload).toEqual({ id: 'a1', topicOrderMode: 'updated' })
    // Pinned topic keeps its own order and is never reordered by its key.
  })

  it('falls back to the real topic createdAt when no message instant exists', async () => {
    buildState(undefined, [topic('old', '2026-01-01T00:00:00.000Z'), topic('new', '2026-06-01T00:00:00.000Z')])
    serve({})

    await enableUpdateTimeOrder('a1')

    expect(lastOrder()).toEqual(['new', 'old'])
  })

  it('never clones a stale snapshot over a changed topic list read while awaiting', async () => {
    buildState(undefined, [topic('a', '2026-01-01T00:00:00.000Z'), topic('b', '2026-01-02T00:00:00.000Z')])
    const read = deferred<FetchTopicMessageTimesResponse>()
    testBed.fetchTopicMessageTimes = vi.fn(() => read.promise)

    const pending = enableUpdateTimeOrder('a1')
    await flush()
    // A new topic arrives while the read is in flight.
    const assistant = testBed.state.assistants.assistants[0]
    assistant.topics = [...assistant.topics, topic('c', '2026-07-01T00:00:00.000Z')]
    read.resolve(response({ a: null, b: null }))

    await pending

    // c arrived with no message read entry yet, so it orders by its real
    // createdAt; a and b have no message instant either and fall back to theirs.
    expect(lastOrder()).toEqual(['c', 'b', 'a'])
  })

  it('writes nothing when the assistant no longer exists', async () => {
    buildState(undefined, [topic('a', '2026-01-01T00:00:00.000Z')])
    testBed.state = { assistants: { assistants: [] } }
    const ok = await enableUpdateTimeOrder('a1')
    expect(ok).toBe(false)
    expect(testBed.dispatched).toHaveLength(0)
  })
})

describe('continuous single-topic refresh', () => {
  async function activate() {
    buildState('updated', [
      topic('a', '2026-01-01T00:00:00.000Z'),
      topic('b', '2026-01-02T00:00:00.000Z'),
      topic('c', '2026-01-03T00:00:00.000Z')
    ])
    serve({
      a: '2026-05-03T00:00:00.000Z',
      b: '2026-05-01T00:00:00.000Z',
      c: '2026-05-02T00:00:00.000Z'
    })
    await enableUpdateTimeOrder('a1')
    expect(lastOrder()).toEqual(['a', 'c', 'b'])
    testBed.dispatched = []
  }

  it('does not move anything when the latest instant is unchanged', async () => {
    await activate()
    // Middle insert / edit / block update: the max instant stays the same.
    noteTopicMessageWrite('b')
    await flush()
    expect(topicOrderDispatches()).toHaveLength(0)

    noteTopicMessageWrite('a')
    await flush()
    expect(topicOrderDispatches()).toHaveLength(0)
  })

  it('moves exactly the topic whose instant advanced to the ordinary head', async () => {
    await activate()
    serve({
      a: '2026-05-03T00:00:00.000Z',
      b: '2026-05-10T00:00:00.000Z',
      c: '2026-05-02T00:00:00.000Z'
    })

    noteTopicMessageWrite('b')
    await flush()

    expect(lastOrder()).toEqual(['b', 'a', 'c'])
  })

  it('places exactly the topic whose instant regressed, keeping the others in order', async () => {
    await activate()
    // The newest message of a was deleted/undone: its new max drops below b.
    serve({
      a: '2026-05-01T00:30:00.000Z',
      b: '2026-05-01T00:00:00.000Z',
      c: '2026-05-02T00:00:00.000Z'
    })

    noteTopicMessageWrite('a')
    await flush()

    expect(lastOrder()).toEqual(['c', 'a', 'b'])
  })

  it('never moves a pinned topic even when its instant changes', async () => {
    buildState('updated', [topic('p', '2025-01-01T00:00:00.000Z', true), topic('a', '2026-01-01T00:00:00.000Z')])
    serve({ p: '2026-04-01T00:00:00.000Z', a: '2026-05-01T00:00:00.000Z' })
    await enableUpdateTimeOrder('a1')
    testBed.dispatched = []

    serve({ p: '2026-09-01T00:00:00.000Z', a: '2026-05-01T00:00:00.000Z' })
    noteTopicMessageWrite('p')
    await flush()

    expect(topicOrderDispatches()).toHaveLength(0)
  })

  it('never fabricates a key from the first write of a session that has no baseline', async () => {
    buildState('updated', [topic('a', '2026-01-01T00:00:00.000Z'), topic('b', '2026-01-02T00:00:00.000Z')])
    serve({ a: '2026-09-01T00:00:00.000Z', b: null })

    noteTopicMessageWrite('a')
    await flush()

    // Reading this topic now would record the just-written maximum as a "first
    // observation" and swallow the real change: no read happens at all.
    expect(testBed.fetchTopicMessageTimes).not.toHaveBeenCalled()
    expect(topicOrderDispatches()).toHaveLength(0)
  })

  it('ignores a late-returning older read instead of overwriting the newer key', async () => {
    await activate()
    const older = deferred<FetchTopicMessageTimesResponse>()
    const newer = deferred<FetchTopicMessageTimesResponse>()
    const queue = [older, newer]
    testBed.fetchTopicMessageTimes = vi.fn(() => queue.shift()!.promise)

    noteTopicMessageWrite('c')
    noteTopicMessageWrite('c')
    await flush()

    // The newer read returns first and applies.
    newer.resolve(response({ c: '2026-05-20T00:00:00.000Z' }))
    await flush()
    expect(lastOrder()).toEqual(['c', 'a', 'b'])
    const orderAfterNewer = lastOrder()
    testBed.dispatched = []

    // The older read returns late with a different value: it must be dropped.
    older.resolve(response({ c: '2026-05-01T00:00:00.000Z' }))
    await flush()

    expect(topicOrderDispatches()).toHaveLength(0)
    expect(orderAfterNewer).toEqual(['c', 'a', 'b'])
  })

  it('does not move anything when the policy was disabled while the read was in flight', async () => {
    await activate()
    const read = deferred<FetchTopicMessageTimesResponse>()
    testBed.fetchTopicMessageTimes = vi.fn(() => read.promise)

    noteTopicMessageWrite('b')
    await flush()
    // The user switched back to "by creation time" mid-flight.
    testBed.state.assistants.assistants[0].topicOrderMode = 'manual'
    read.resolve(response({ b: '2026-09-01T00:00:00.000Z' }))
    await flush()

    expect(topicOrderDispatches()).toHaveLength(0)
  })

  it('does not move anything when the topic vanished from Main during the read', async () => {
    await activate()
    serve({})

    noteTopicMessageWrite('b')
    await flush()

    expect(topicOrderDispatches()).toHaveLength(0)
  })

  it('does not move anything when the assistant or topic is gone from the store', async () => {
    await activate()
    testBed.state = { assistants: { assistants: [] } }
    serve({ b: '2026-09-01T00:00:00.000Z' })

    noteTopicMessageWrite('b')
    await flush()

    expect(topicOrderDispatches()).toHaveLength(0)
  })

  it('does nothing at all while the policy is inactive', async () => {
    buildState('manual', [topic('a', '2026-01-01T00:00:00.000Z')])
    serve({ a: '2026-09-01T00:00:00.000Z' })

    noteTopicMessageWrite('a')
    await flush()

    expect(testBed.fetchTopicMessageTimes).not.toHaveBeenCalled()
    expect(testBed.dispatched).toHaveLength(0)
  })
})

describe('boot baseline (cold start)', () => {
  const coldTopics = () => [
    topic('a', '2026-01-01T00:00:00.000Z'),
    topic('b', '2026-01-02T00:00:00.000Z'),
    topic('c', '2026-01-03T00:00:00.000Z')
  ]

  it('establishes the baseline BEFORE the first send so that send moves the topic', async () => {
    // Cold start: the policy is persisted on the assistant but the runtime key
    // cache is empty (beforeEach resets it, exactly like a fresh renderer boot).
    buildState('updated', coldTopics())
    // The startup primer fails here (e.g. Main is not ready yet): nothing is
    // recorded and no key is invented.
    testBed.fetchTopicMessageTimes = vi.fn(async () => {
      throw new Error('Main unavailable')
    })
    expect(await primeTopicMessageTimesBaseline()).toBe(false)
    expect(topicOrderDispatches()).toHaveLength(0)

    // The pre-write preparation retries the single enabled batch read BEFORE
    // the message mutation reaches Main.
    const events: string[] = []
    testBed.fetchTopicMessageTimes = vi.fn(async (topicIds: string[]) => {
      events.push(`read:${topicIds.join(',')}`)
      return response({
        a: '2026-05-03T00:00:00.000Z',
        b: '2026-05-01T00:00:00.000Z',
        c: '2026-05-02T00:00:00.000Z'
      })
    })
    await prepareTopicMessageWrite('b')
    expect(events).toEqual(['read:a,b,c'])
    // The baseline records keys only: the persisted order is untouched.
    expect(topicOrderDispatches()).toHaveLength(0)

    // The first real send of the session advances b's instant, and only now is
    // the post-write observation issued.
    testBed.fetchTopicMessageTimes = vi.fn(async () => {
      events.push('read:post-write')
      return response({
        a: '2026-05-03T00:00:00.000Z',
        b: '2026-05-10T00:00:00.000Z',
        c: '2026-05-02T00:00:00.000Z'
      })
    })
    noteTopicMessageWrite('b')
    await flush()

    expect(events).toEqual(['read:a,b,c', 'read:post-write'])
    expect(lastOrder()).toEqual(['b', 'a', 'c'])
  })

  it('leaves the first no-op write of the session unmoved: same instant before and after', async () => {
    buildState('updated', coldTopics())
    testBed.fetchTopicMessageTimes = vi.fn(async () => {
      throw new Error('Main unavailable')
    })
    expect(await primeTopicMessageTimesBaseline()).toBe(false)

    const events: string[] = []
    const keys = {
      a: '2026-05-03T00:00:00.000Z',
      b: '2026-05-01T00:00:00.000Z',
      c: '2026-05-02T00:00:00.000Z'
    }
    testBed.fetchTopicMessageTimes = vi.fn(async () => {
      events.push('read:pre-write')
      return response(keys)
    })
    await prepareTopicMessageWrite('a')
    testBed.fetchTopicMessageTimes = vi.fn(async () => {
      events.push('read:post-write')
      // An edge edit of an older message: the maximum instant is unchanged.
      return response(keys)
    })
    noteTopicMessageWrite('a')
    await flush()

    expect(events).toEqual(['read:pre-write', 'read:post-write'])
    expect(topicOrderDispatches()).toHaveLength(0)
  })

  it('never turns a failed baseline into a fabricated key, and retries only before the next write', async () => {
    buildState('updated', [topic('a', '2026-01-01T00:00:00.000Z'), topic('b', '2026-01-02T00:00:00.000Z')])
    testBed.fetchTopicMessageTimes = vi.fn(async () => {
      throw new Error('Main unavailable')
    })
    expect(await primeTopicMessageTimesBaseline()).toBe(false)

    // A write lands while no trusted baseline exists. The post-write
    // observation must not read (that would record the just-written maximum as
    // a "first observation" and swallow the real change).
    testBed.fetchTopicMessageTimes = vi.fn(async () =>
      response({ a: '2026-05-03T00:00:00.000Z', b: '2026-05-10T00:00:00.000Z' })
    )
    noteTopicMessageWrite('b')
    await flush()
    expect(topicOrderDispatches()).toHaveLength(0)
    expect(testBed.fetchTopicMessageTimes).not.toHaveBeenCalled()

    // The next PRE-write preparation retries and establishes the real
    // baseline, which only records keys — it never reorders on recovery.
    serve({ a: '2026-05-03T00:00:00.000Z', b: '2026-05-01T00:00:00.000Z' })
    await prepareTopicMessageWrite('b')
    expect(topicOrderDispatches()).toHaveLength(0)

    // Only the following REAL change moves the topic, which also proves the
    // swallowed 05-10 value was never cached by the failed-baseline write.
    serve({ a: '2026-05-03T00:00:00.000Z', b: '2026-05-10T00:00:00.000Z' })
    noteTopicMessageWrite('b')
    await flush()
    expect(lastOrder()).toEqual(['b', 'a'])
  })

  it('reads nothing before a write when the assistant does not order by update time', async () => {
    buildState('manual', coldTopics())

    await prepareTopicMessageWrite('b')

    expect(testBed.fetchTopicMessageTimes).not.toHaveBeenCalled()
  })

  it('reads nothing before a write for a topic with no Redux row yet', async () => {
    // A brand-new topic has no row when its first message is sent; it keeps the
    // original prepend behavior and needs no baseline.
    buildState('updated', coldTopics())
    serve({ a: '2026-05-03T00:00:00.000Z', b: '2026-05-01T00:00:00.000Z', c: '2026-05-02T00:00:00.000Z' })

    await prepareTopicMessageWrite('brand-new-topic')

    expect(testBed.fetchTopicMessageTimes).not.toHaveBeenCalled()
  })

  it('resolves immediately before a write once the topic keys are already primed', async () => {
    buildState('updated', [topic('a', '2026-01-01T00:00:00.000Z'), topic('b', '2026-01-02T00:00:00.000Z')])
    serve({ a: '2026-04-01T00:00:00.000Z', b: '2026-05-01T00:00:00.000Z' })
    await primeTopicMessageTimesBaseline()

    testBed.fetchTopicMessageTimes = vi.fn(async () => {
      throw new Error('must not be read again')
    })
    await prepareTopicMessageWrite('b')

    expect(testBed.fetchTopicMessageTimes).not.toHaveBeenCalled()
  })

  it('covers a topic added after the baseline settled, so its first send moves it', async () => {
    buildState('updated', coldTopics())
    serve({ a: '2026-05-03T00:00:00.000Z', b: '2026-05-01T00:00:00.000Z', c: '2026-05-02T00:00:00.000Z' })
    await enableUpdateTimeOrder('a1')
    expect(lastOrder()).toEqual(['a', 'c', 'b'])

    // The user creates a topic while the policy is already active: it enters
    // Redux at the end of the ordinary group and was never covered by the
    // settled baseline, so it has no key yet.
    const assistant = testBed.state.assistants.assistants[0]
    assistant.topics = [...assistant.topics, topic('d', '2026-01-04T00:00:00.000Z')]
    testBed.dispatched = []
    expect(topicOrderDispatches()).toHaveLength(0)

    // Pre-write coverage reads ONLY the uncovered topic (never the keyed ones).
    serve({
      a: '2026-05-03T00:00:00.000Z',
      b: '2026-05-01T00:00:00.000Z',
      c: '2026-05-02T00:00:00.000Z',
      d: null
    })
    testBed.fetchTopicMessageTimes = vi.fn(async (topicIds: string[]) =>
      response(Object.fromEntries(topicIds.map((id) => [id, id === 'd' ? null : '2026-05-01T00:00:00.000Z'])))
    )
    await prepareTopicMessageWrite('d')
    expect(testBed.fetchTopicMessageTimes.mock.calls[0][0] as string[]).toEqual(['d'])
    expect(topicOrderDispatches()).toHaveLength(0)

    // Its first real message advances its instant: it moves to the ordinary
    // head, and the previously keyed topics keep their relative order.
    serve({
      a: '2026-05-03T00:00:00.000Z',
      b: '2026-05-01T00:00:00.000Z',
      c: '2026-05-02T00:00:00.000Z',
      d: '2026-06-01T00:00:00.000Z'
    })
    noteTopicMessageWrite('d')
    await flush()
    expect(lastOrder()).toEqual(['d', 'a', 'c', 'b'])
  })

  it('leaves the first edit of a newly added topic unmoved when its instant does not change', async () => {
    buildState('updated', coldTopics())
    serve({ a: '2026-05-03T00:00:00.000Z', b: '2026-05-01T00:00:00.000Z', c: '2026-05-02T00:00:00.000Z' })
    await enableUpdateTimeOrder('a1')

    // An imported topic created after the baseline, placed at the group's end.
    const assistant = testBed.state.assistants.assistants[0]
    assistant.topics = [...assistant.topics, topic('d', '2026-01-04T00:00:00.000Z')]
    testBed.dispatched = []

    // Its real maximum already exists (imported messages); the pre-write read
    // records it, then an updatedAt-only edit leaves it identical.
    const keys = {
      a: '2026-05-03T00:00:00.000Z',
      b: '2026-05-01T00:00:00.000Z',
      c: '2026-05-02T00:00:00.000Z',
      d: '2026-02-01T00:00:00.000Z'
    }
    serve(keys)
    await prepareTopicMessageWrite('d')
    expect(topicOrderDispatches()).toHaveLength(0)

    serve(keys)
    noteTopicMessageWrite('d')
    await flush()
    expect(topicOrderDispatches()).toHaveLength(0)
  })

  it('waits for the in-flight baseline instead of observing without it', async () => {
    buildState('updated', [topic('a', '2026-01-01T00:00:00.000Z'), topic('b', '2026-01-02T00:00:00.000Z')])
    const baseline = deferred<FetchTopicMessageTimesResponse>()
    const observation = deferred<FetchTopicMessageTimesResponse>()
    let call = 0
    testBed.fetchTopicMessageTimes = vi.fn(() => {
      call += 1
      return call === 1 ? baseline.promise : observation.promise
    })

    const priming = primeTopicMessageTimesBaseline()
    await flush()
    // A message write lands while the boot baseline is still running.
    noteTopicMessageWrite('b')
    await flush()

    baseline.resolve(response({ a: '2026-05-03T00:00:00.000Z', b: '2026-05-01T00:00:00.000Z' }))
    await priming
    await flush()

    // The observation is now compared against the real baseline, so b's
    // advanced instant moves it once the observation resolves.
    observation.resolve(response({ b: '2026-05-10T00:00:00.000Z' }))
    await flush()
    expect(lastOrder()).toEqual(['b', 'a'])
  })
})

describe('enableUpdateTimeOrder — user ordering actions during an in-flight read', () => {
  it('discards an activation overtaken by "by creation time"', async () => {
    buildState('manual', [topic('a', '2026-01-01T00:00:00.000Z'), topic('b', '2026-01-02T00:00:00.000Z')])
    const read = deferred<FetchTopicMessageTimesResponse>()
    testBed.fetchTopicMessageTimes = vi.fn(() => read.promise)

    const pending = enableUpdateTimeOrder('a1')
    await flush()
    // The user picks "by creation time" while the activation read is in flight.
    resetTopicMessageTimes()
    const assistant = testBed.state.assistants.assistants[0]
    assistant.topics = [topic('b', '2026-06-01T00:00:00.000Z'), topic('a', '2026-01-01T00:00:00.000Z')]
    assistant.topicOrderMode = 'manual'
    testBed.dispatched = []

    read.resolve(response({ a: null, b: null }))
    const ok = await pending

    // The later user decision wins: no re-sort and no mode flip.
    expect(ok).toBe(false)
    expect(topicOrderDispatches()).toHaveLength(0)
    expect(assistantDispatches()).toHaveLength(0)
    expect(testBed.state.assistants.assistants[0].topics.map((item: T) => item.id)).toEqual(['b', 'a'])
    expect(testBed.state.assistants.assistants[0].topicOrderMode).toBe('manual')
  })

  it('persists the policy but never re-sorts a list the user dragged while awaiting', async () => {
    buildState('manual', [
      topic('a', '2026-01-01T00:00:00.000Z'),
      topic('b', '2026-01-02T00:00:00.000Z'),
      topic('c', '2026-01-03T00:00:00.000Z')
    ])
    const read = deferred<FetchTopicMessageTimesResponse>()
    testBed.fetchTopicMessageTimes = vi.fn(() => read.promise)

    const pending = enableUpdateTimeOrder('a1')
    await flush()
    // The user drags the list while the activation read is in flight (the real
    // drag path writes a reordered array through updateTopics).
    const assistant = testBed.state.assistants.assistants[0]
    assistant.topics = [assistant.topics[2], assistant.topics[0], assistant.topics[1]]
    testBed.dispatched = []

    read.resolve(response({ a: '2026-05-03T00:00:00.000Z', b: '2026-05-01T00:00:00.000Z' }))
    const ok = await pending

    expect(ok).toBe(true)
    // The dragged order is preserved verbatim; only the policy is persisted.
    expect(topicOrderDispatches()).toHaveLength(0)
    expect(assistantDispatches().at(-1)?.payload).toEqual({ id: 'a1', topicOrderMode: 'updated' })
    expect(testBed.state.assistants.assistants[0].topics.map((item: T) => item.id)).toEqual(['c', 'a', 'b'])
  })

  it('never lets the older activation snapshot overwrite a newer observation', async () => {
    buildState('updated', [
      topic('a', '2026-01-01T00:00:00.000Z'),
      topic('b', '2026-01-02T00:00:00.000Z'),
      topic('c', '2026-01-03T00:00:00.000Z')
    ])
    serve({ a: '2026-05-03T00:00:00.000Z', b: '2026-05-01T00:00:00.000Z', c: '2026-05-02T00:00:00.000Z' })
    await primeTopicMessageTimesBaseline()
    testBed.dispatched = []

    // Double activation: its snapshot still says b is 05-01.
    const activation = deferred<FetchTopicMessageTimesResponse>()
    let call = 0
    testBed.fetchTopicMessageTimes = vi.fn(() => {
      call += 1
      if (call === 1) return activation.promise
      return Promise.resolve(response({ b: '2026-05-20T00:00:00.000Z' }))
    })

    const pending = enableUpdateTimeOrder('a1')
    await flush()
    // A message-write observation lands while the activation is awaiting.
    noteTopicMessageWrite('b')
    await flush()
    expect(lastOrder()).toEqual(['b', 'a', 'c'])

    activation.resolve(response({ a: '2026-05-03T00:00:00.000Z', b: '2026-05-01T00:00:00.000Z', c: '2026-05-02' }))
    await pending
    expect(lastOrder()[0]).toBe('b')

    // The retained key is the newer one: an equal-instant observation is a no-op,
    // which proves the stale 05-01 value never made it back into the cache.
    testBed.dispatched = []
    testBed.fetchTopicMessageTimes = vi.fn(async () => response({ b: '2026-05-20T00:00:00.000Z' }))
    noteTopicMessageWrite('b')
    await flush()
    expect(topicOrderDispatches()).toHaveLength(0)
  })

  it('never applies a late key from a previous policy period after off → on', async () => {
    buildState('updated', [
      topic('a', '2026-01-01T00:00:00.000Z'),
      topic('b', '2026-01-02T00:00:00.000Z'),
      topic('c', '2026-01-03T00:00:00.000Z')
    ])
    serve({ a: '2026-05-03T00:00:00.000Z', b: '2026-05-01T00:00:00.000Z', c: '2026-05-02T00:00:00.000Z' })
    await primeTopicMessageTimesBaseline()
    testBed.dispatched = []

    // Period 1 observation that stays in flight.
    const stale = deferred<FetchTopicMessageTimesResponse>()
    testBed.fetchTopicMessageTimes = vi.fn(() => stale.promise)
    noteTopicMessageWrite('c')
    await flush()

    // off ("by creation time") then on again, while the stale read is pending.
    resetTopicMessageTimes()
    testBed.fetchTopicMessageTimes = vi.fn(async () =>
      response({ a: '2026-05-03T00:00:00.000Z', b: '2026-05-01T00:00:00.000Z', c: '2026-05-02T00:00:00.000Z' })
    )
    await enableUpdateTimeOrder('a1')
    testBed.dispatched = []

    stale.resolve(response({ c: '2026-07-01T00:00:00.000Z' }))
    await flush()
    expect(topicOrderDispatches()).toHaveLength(0)
  })
})

describe('reference invalidation — existing Main push event', () => {
  /** Assistant a1 owns the reference target and orders by update time; a2 owns the source. */
  function buildSourceAndTarget(): void {
    const targetAssistant: any = {
      id: 'a1',
      name: 'Target owner',
      topicOrderMode: 'updated',
      topics: [topic('t-old', '2026-01-01T00:00:00.000Z'), topic('t-a', '2026-01-02T00:00:00.000Z')]
    }
    const sourceAssistant: any = {
      id: 'a2',
      name: 'Source owner',
      // Explicit manual: the source owner keeps its own order, so this test
      // covers only the reference-target baseline of the enabled assistant.
      topicOrderMode: 'manual',
      topics: [topic('src', '2026-01-03T00:00:00.000Z')]
    }
    testBed.state = { assistants: { assistants: [targetAssistant, sourceAssistant] } }
  }

  it('moves an unopened reference target when its source prefix maximum changes', async () => {
    buildSourceAndTarget()
    serve({ 't-old': '2026-04-01T00:00:00.000Z', 't-a': '2026-03-01T00:00:00.000Z' })
    await primeTopicMessageTimesBaseline()
    testBed.dispatched = []

    // The source write changed the prefix the target sees; the target itself
    // was never opened. Main pushed the exact target ids.
    serve({ 't-old': '2026-04-01T00:00:00.000Z', 't-a': '2026-06-01T00:00:00.000Z' })
    noteTopicReferenceInvalidation(['t-a'])
    await flush()

    expect(lastOrder()).toEqual(['t-a', 't-old'])
    // Only the target's own assistant list was written.
    expect(topicOrderDispatches()).toHaveLength(1)
    expect(topicOrderDispatches()[0].payload.assistantId).toBe('a1')
    expect(testBed.state.assistants.assistants[1].topics.map((item: T) => item.id)).toEqual(['src'])
  })

  it('covers a reference target added after the baseline settled before the source write', async () => {
    buildSourceAndTarget()
    serve({ 't-old': '2026-04-01T00:00:00.000Z', 't-a': '2026-03-01T00:00:00.000Z' })
    await primeTopicMessageTimesBaseline()

    // A new reference target enters the enabled assistant's list AFTER that
    // baseline: it has no key, and its current prefix maximum already exists.
    const targetAssistant = testBed.state.assistants.assistants[0]
    targetAssistant.topics = [...targetAssistant.topics, topic('t-new', '2026-01-04T00:00:00.000Z')]
    testBed.dispatched = []

    // The source write's pre-write preparation covers ONLY this uncovered
    // target and records its pre-write prefix maximum.
    testBed.fetchTopicMessageTimes = vi.fn(async (topicIds: string[]) =>
      response(Object.fromEntries(topicIds.map((id) => [id, '2026-03-15T00:00:00.000Z'])))
    )
    await prepareTopicMessageWrite('src')
    expect(testBed.fetchTopicMessageTimes.mock.calls[0][0] as string[]).toEqual(['t-new'])
    expect(topicOrderDispatches()).toHaveLength(0)

    // The source write now raises the target's prefix maximum: the comparison
    // has a real pre-write baseline, so the target moves instead of being
    // recorded as a first observation.
    serve({
      't-old': '2026-04-01T00:00:00.000Z',
      't-a': '2026-03-01T00:00:00.000Z',
      't-new': '2026-06-01T00:00:00.000Z'
    })
    noteTopicReferenceInvalidation(['t-new'])
    await flush()

    expect(lastOrder()).toEqual(['t-new', 't-old', 't-a'])
    expect(topicOrderDispatches()).toHaveLength(1)
    expect(topicOrderDispatches()[0].payload.assistantId).toBe('a1')
  })

  it('leaves the target alone when the source append is after the captured anchor', async () => {
    buildSourceAndTarget()
    serve({ 't-old': '2026-04-01T00:00:00.000Z', 't-a': '2026-03-01T00:00:00.000Z' })
    await primeTopicMessageTimesBaseline()
    testBed.dispatched = []

    // Main re-reads the target's real prefix instant: unchanged.
    noteTopicReferenceInvalidation(['t-a'])
    await flush()

    expect(topicOrderDispatches()).toHaveLength(0)
  })

  it('ignores targets whose assistant does not order by update time', async () => {
    buildSourceAndTarget()
    testBed.state.assistants.assistants[0].topicOrderMode = 'manual'

    noteTopicReferenceInvalidation(['t-a', 'src'])
    await flush()

    expect(testBed.fetchTopicMessageTimes).not.toHaveBeenCalled()
    expect(testBed.dispatched).toHaveLength(0)
  })

  it('subscribes once at bootstrap and refreshes exactly the pushed targets', async () => {
    buildSourceAndTarget()
    serve({ 't-old': '2026-04-01T00:00:00.000Z', 't-a': '2026-03-01T00:00:00.000Z' })
    await primeTopicMessageTimesBaseline()
    testBed.dispatched = []

    let handler: ((event: unknown) => void) | null = null
    const unsubscribeSpy = vi.fn()
    ;(window as any).api = {
      chatDb: {
        onHistoryReferenceInvalidated: (callback: (event: unknown) => void) => {
          handler = callback
          return unsubscribeSpy
        }
      }
    }
    const first = subscribeTopicMessageTimeInvalidation()
    const second = subscribeTopicMessageTimeInvalidation()
    expect(second).toBe(first)
    expect(unsubscribeSpy).not.toHaveBeenCalled()

    // Payload-driven: only the pushed target is re-read, even though it is not
    // the active topic of any mounted list.
    testBed.fetchTopicMessageTimes = vi.fn(async () => response({ 't-a': '2026-06-01T00:00:00.000Z' }))
    handler!({ sourceTopicId: 'src', targetTopicIds: ['t-a'] })
    await flush()

    expect(lastOrder()).toEqual(['t-a', 't-old'])
    expect(testBed.fetchTopicMessageTimes.mock.calls[0][0] as string[]).toEqual(['t-a'])

    first()
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1)
    testBed.dispatched = []
    handler!({ sourceTopicId: 'src', targetTopicIds: ['t-a'] })
    await flush()
    expect(topicOrderDispatches()).toHaveLength(0)

    delete (window as any).api
  })
})

describe('initializeTopicOrderDefaults — the one-time default for assistants that never chose', () => {
  it('orders the non-pinned topics by the authoritative instant once and persists the default', async () => {
    buildState(undefined, [
      topic('t1', '2026-01-01T00:00:00.000Z'),
      topic('t2', '2026-01-02T00:00:00.000Z'),
      topic('t3', '2026-01-03T00:00:00.000Z'),
      topic('pin', '2025-01-01T00:00:00.000Z', true)
    ])
    // Main instants conflict with the topic metadata: t1 is newest, t2 middle,
    // and the empty t3 has no message at all so it falls back to its createdAt.
    serve({ t1: '2026-05-01T00:00:00.000Z', t2: '2026-03-01T00:00:00.000Z', t3: null })

    expect(await initializeTopicOrderDefaults()).toBe(true)

    expect(lastOrder()).toEqual(['pin', 't1', 't2', 't3'])
    expect(assistantDispatches().at(-1)?.payload).toEqual({ id: 'a1', topicOrderMode: 'updated' })

    // The persisted mode is the marker: a second pass reads nothing and writes
    // nothing (no repeated full sort, no per-render churn).
    testBed.dispatched = []
    const readsAfterFirstPass = testBed.fetchTopicMessageTimes.mock.calls.length
    expect(await initializeTopicOrderDefaults()).toBe(true)
    expect(topicOrderDispatches()).toHaveLength(0)
    expect(assistantDispatches()).toHaveLength(0)
    expect(testBed.fetchTopicMessageTimes.mock.calls.length).toBe(readsAfterFirstPass)
  })

  it('never touches an assistant that already chose manual or updated', async () => {
    buildState('manual', [topic('a', '2026-01-01T00:00:00.000Z'), topic('b', '2026-01-02T00:00:00.000Z')])
    serve({ a: '2026-06-01T00:00:00.000Z', b: '2026-07-01T00:00:00.000Z' })
    expect(await initializeTopicOrderDefaults()).toBe(true)
    expect(testBed.fetchTopicMessageTimes).not.toHaveBeenCalled()
    expect(testBed.dispatched).toHaveLength(0)
    expect(testBed.state.assistants.assistants[0].topics.map((item: T) => item.id)).toEqual(['a', 'b'])
    expect(testBed.state.assistants.assistants[0].topicOrderMode).toBe('manual')
  })

  it('leaves everything untouched when the read fails and retries on the next pass', async () => {
    buildState(undefined, [topic('a', '2026-01-01T00:00:00.000Z'), topic('b', '2026-01-02T00:00:00.000Z')])
    serve({ a: '2026-04-01T00:00:00.000Z', b: '2026-05-01T00:00:00.000Z' })
    testBed.fetchTopicMessageTimes.mockRejectedValueOnce(new Error('main read failed'))

    expect(await initializeTopicOrderDefaults()).toBe(false)
    // No fabricated key, no order write, no mode write: still undecided.
    expect(testBed.dispatched).toHaveLength(0)
    expect(testBed.state.assistants.assistants[0].topicOrderMode).toBeUndefined()
    expect(testBed.state.assistants.assistants[0].topics.map((item: T) => item.id)).toEqual(['a', 'b'])

    expect(await initializeTopicOrderDefaults()).toBe(true)
    expect(lastOrder()).toEqual(['b', 'a'])
    expect(assistantDispatches().at(-1)?.payload).toEqual({ id: 'a1', topicOrderMode: 'updated' })
  })

  it('never re-sorts a list the user dragged while the read was in flight', async () => {
    buildState(undefined, [
      topic('a', '2026-01-01T00:00:00.000Z'),
      topic('b', '2026-01-02T00:00:00.000Z'),
      topic('c', '2026-01-03T00:00:00.000Z')
    ])
    const read = deferred<FetchTopicMessageTimesResponse>()
    testBed.fetchTopicMessageTimes = vi.fn(() => read.promise)

    const pending = initializeTopicOrderDefaults()
    await flush()
    const assistant = testBed.state.assistants.assistants[0]
    assistant.topics = [assistant.topics[2], assistant.topics[0], assistant.topics[1]]
    testBed.dispatched = []

    read.resolve(response({ a: '2026-05-01T00:00:00.000Z', b: '2026-04-01T00:00:00.000Z' }))
    expect(await pending).toBe(true)

    // The dragged order survives; only the default preference is persisted.
    expect(topicOrderDispatches()).toHaveLength(0)
    expect(assistantDispatches().at(-1)?.payload).toEqual({ id: 'a1', topicOrderMode: 'updated' })
    expect(testBed.state.assistants.assistants[0].topics.map((item: T) => item.id)).toEqual(['c', 'a', 'b'])
  })

  it('respects an explicit choice made while the read was in flight', async () => {
    buildState(undefined, [topic('a', '2026-01-01T00:00:00.000Z'), topic('b', '2026-01-02T00:00:00.000Z')])
    const read = deferred<FetchTopicMessageTimesResponse>()
    testBed.fetchTopicMessageTimes = vi.fn(() => read.promise)

    const pending = initializeTopicOrderDefaults()
    await flush()
    // The user picks "by creation time" meanwhile: it persists `manual`.
    const assistant = testBed.state.assistants.assistants[0]
    assistant.topicOrderMode = 'manual'
    assistant.topics = [assistant.topics[1], assistant.topics[0]]
    testBed.dispatched = []

    read.resolve(response({ a: '2026-05-01T00:00:00.000Z' }))
    expect(await pending).toBe(true)

    expect(testBed.dispatched).toHaveLength(0)
    expect(assistant.topicOrderMode).toBe('manual')
    expect(assistant.topics.map((item: T) => item.id)).toEqual(['b', 'a'])
  })

  it('discards the pass when a later user ordering action happened while awaiting', async () => {
    buildState(undefined, [topic('a', '2026-01-01T00:00:00.000Z'), topic('b', '2026-01-02T00:00:00.000Z')])
    const read = deferred<FetchTopicMessageTimesResponse>()
    testBed.fetchTopicMessageTimes = vi.fn(() => read.promise)

    const pending = initializeTopicOrderDefaults()
    await flush()
    // "By creation time" bumps the ordering epoch (and leaves the mode manual).
    resetTopicMessageTimes()
    testBed.state.assistants.assistants[0].topicOrderMode = 'manual'
    testBed.dispatched = []

    read.resolve(response({ a: '2026-12-01T00:00:00.000Z' }))
    expect(await pending).toBe(true)

    expect(testBed.dispatched).toHaveLength(0)
    expect(testBed.state.assistants.assistants[0].topics.map((item: T) => item.id)).toEqual(['a', 'b'])
  })
})
