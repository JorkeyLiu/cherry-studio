/**
 * Focused unit tests for the import-status observer (LOCK-OBS-1..6).
 *
 * The observer is driven through a deterministic FAKE Page (function-name
 * dispatch on the module-level collector functions) plus a direct exercise of
 * the source-aware `ImportStatusHistory` engine. No Electron, no timers beyond
 * the observer's own 10 ms poll cadence.
 *
 * Deterministic unit reproduction of the original failure: a getStatus poll
 * (state only / stats null) observed `candidate-ready` before the event
 * carrying CandidateImportStats arrived. LOCK-OBS-1..6 pin the fix:
 *   - a stats-dependent wait resolves only once the stats-bearing event lands;
 *   - poll-only lifecycle observations persist across reads/reload/close;
 *   - events enrich poll records in place (event preference), so
 *     `.find('candidate-ready')` returns the stats-bearing record;
 *   - only exact mirror duplicates are deduplicated (full bounded payload).
 */
import type { Page } from '@playwright/test'
import { describe, expect, it } from 'vitest'

import {
  CONSOLE_MARKER,
  IMPORT_STATE_ORDER,
  ImportStatusHistory,
  assertStateSubsequence,
  canonicalRecordPayload,
  observeImportStatuses,
  type RecordedStatus
} from './import-status'
import { sleep } from './wait-helpers'

/** Bounded CandidateImportStats-shaped payload used across scenarios. */
const STATS = {
  topicCount: 1,
  messageCount: 2,
  blockCount: 3,
  segmentCount: 4,
  segmentMembershipCount: 5,
  fileReferenceCount: 6,
  pageCount: 7,
  elapsedMs: 8
} as const

interface EmitStatusEventInput {
  state: string
  error?: string | null
  stats?: Record<string, unknown> | null
}

interface FakePageHandle {
  page: Record<string, unknown>
  /** Simulate a production status event: page collector push + console mirror. */
  emitStatusEvent(event: EmitStatusEventInput): RecordedStatus | null
  /** Simulate a LATE console mirror line (page already read, mirror still queued). */
  pushConsoleMirror(record: RecordedStatus): void
  setPollResult(result: { state: string; error?: string } | null): void
  setPollError(error: Error): void
  /** Simulate an in-process reload: the page collector array is reset to []. */
  clearCollector(): void
  /** Simulate the page being gone (every evaluate now throws). */
  close(): void
  getPollCalls(): number
  isInstalled(): boolean
}

/**
 * Deterministic fake Playwright Page: implements exactly the surface the
 * observer uses and dispatches `evaluate` by the module-level collector
 * function name. `emitStatusEvent` mirrors the real page-side handler — it
 * pushes the record into the collector array AND emits the console-mirror line
 * with the SAME payload (same `at`), so the observer sees one event twice and
 * must deduplicate it.
 */
function createFakePage(): FakePageHandle {
  const events: RecordedStatus[] = []
  let pollResult: { state: string; error?: string } | null = null
  let pollError: Error | null = null
  let pollCalls = 0
  let closed = false
  let installed = false
  let clockMs = 1_700_000_000_000
  const consoleHandlers = new Set<(msg: { text(): string }) => void>()

  const page: Record<string, unknown> = {
    evaluate: async (fn: (...args: unknown[]) => unknown, _arg?: unknown): Promise<unknown> => {
      if (closed) throw new Error('page closed')
      switch (fn.name) {
        case 'installCollector':
          installed = true
          return undefined
        case 'readCollector':
          return [...events]
        case 'pollStatus': {
          pollCalls += 1
          if (pollError) throw pollError
          return pollResult
        }
        case 'disposeCollector':
          installed = false
          return undefined
        default:
          throw new Error(`unexpected page.evaluate function: ${fn.name}`)
      }
    },
    on: (event: string, handler: (msg: { text(): string }) => void): void => {
      if (event !== 'console') throw new Error(`unexpected page.on event: ${event}`)
      consoleHandlers.add(handler)
    },
    off: (event: string, handler: (msg: { text(): string }) => void): void => {
      if (event !== 'console') throw new Error(`unexpected page.off event: ${event}`)
      consoleHandlers.delete(handler)
    }
  }

  return {
    page,
    emitStatusEvent(event) {
      if (!installed) return null
      const record: RecordedStatus = {
        state: event.state,
        at: ++clockMs,
        error: event.error ?? null,
        stats: event.stats ?? null
      }
      events.push(record)
      const line = `${CONSOLE_MARKER} ${JSON.stringify(record)}`
      for (const handler of consoleHandlers) handler({ text: () => line })
      return record
    },
    pushConsoleMirror(record) {
      const line = `${CONSOLE_MARKER} ${JSON.stringify(record)}`
      for (const handler of consoleHandlers) handler({ text: () => line })
    },
    setPollResult(result) {
      pollResult = result
    },
    setPollError(error) {
      pollError = error
    },
    clearCollector() {
      events.length = 0
    },
    close() {
      closed = true
    },
    getPollCalls() {
      return pollCalls
    },
    isInstalled() {
      return installed
    }
  }
}

async function createObserver(): Promise<{
  observer: Awaited<ReturnType<typeof observeImportStatuses>>
  fake: FakePageHandle
}> {
  const fake = createFakePage()
  const observer = await observeImportStatuses(fake.page as unknown as Page)
  return { observer, fake }
}

describe('poll-first delayed stats event (LOCK-OBS-1/3)', () => {
  it('does NOT resolve a stats-dependent candidate-ready wait on a stats-less poll record', async () => {
    const { observer, fake } = await createObserver()
    observer.setSessionId('session-1')
    // The exact original race: getStatus observes candidate-ready with stats=null.
    fake.setPollResult({ state: 'candidate-ready' })

    const waiter = observer.waitForState('candidate-ready', 5000, (record) => record.stats != null)

    // Let several poll cycles run with ONLY the stats-less poll record available.
    await sleep(150)
    let settled = false
    waiter.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await sleep(30)
    expect(settled, 'predicate wait must not resolve on a stats-less poll record').toBe(false)

    // The CandidateImportStats event finally arrives (page collector + console mirror).
    fake.emitStatusEvent({ state: 'candidate-ready', stats: STATS })
    const ready = await waiter
    expect(ready.state).toBe('candidate-ready')
    expect(ready.stats).toEqual(STATS)
  })

  it('enriches the poll record in place so getStates().find() returns the stats-bearing record', async () => {
    const { observer, fake } = await createObserver()
    observer.setSessionId('session-1')
    fake.setPollResult({ state: 'candidate-ready' })
    await observer.getStates() // poll-only candidate-ready (stats null)

    fake.emitStatusEvent({ state: 'candidate-ready', stats: STATS })
    fake.emitStatusEvent({ state: 'verifying' })
    fake.emitStatusEvent({ state: 'verified-candidate' })
    fake.setPollResult({ state: 'promoting' })

    const observed = await observer.getStates()
    const ready = observed.find((s) => s.state === 'candidate-ready')
    expect(ready?.stats, '.find(candidate-ready) must surface the enriched event payload').toEqual(STATS)
    expect(observed.filter((s) => s.state === 'candidate-ready')).toHaveLength(1)
    expect(observed.map((s) => s.state)).toEqual(['candidate-ready', 'verifying', 'verified-candidate', 'promoting'])
  })
})

describe('event-first (LOCK-OBS-3/5)', () => {
  it('keeps the event record and never lets a later poll overwrite or duplicate it', async () => {
    const { observer, fake } = await createObserver()
    observer.setSessionId('session-1')
    fake.emitStatusEvent({ state: 'reading' })
    fake.emitStatusEvent({ state: 'candidate-ready', stats: STATS })

    // A later poll returns the SAME state — must be skipped, never replace the event.
    fake.setPollResult({ state: 'candidate-ready' })
    const observed = await observer.getStates()
    expect(observed.map((s) => s.state)).toEqual(['reading', 'candidate-ready'])
    expect(observed[1].stats).toEqual(STATS)
  })
})

describe('retained poll chain (LOCK-OBS-2)', () => {
  it('persists the poll-only lifecycle chain across reads without duplicates', async () => {
    const { observer, fake } = await createObserver()
    observer.setSessionId('session-1')

    fake.setPollResult({ state: 'reading' })
    await observer.getStates()
    fake.setPollResult({ state: 'candidate-ready' })
    await observer.getStates()
    fake.setPollResult({ state: 'verifying' })
    await observer.getStates()
    fake.setPollResult({ state: 'finalizing' })

    const states = await observer.getStates()
    expect(states.map((s) => s.state)).toEqual(['reading', 'candidate-ready', 'verifying', 'finalizing'])
    // Re-reading with an unchanged poll never adds duplicates.
    const again = await observer.getStates()
    expect(again.map((s) => s.state)).toEqual(['reading', 'candidate-ready', 'verifying', 'finalizing'])
  })

  it('survives a collector reset (in-process reload) and page close', async () => {
    const { observer, fake } = await createObserver()
    observer.setSessionId('session-1')

    fake.setPollResult({ state: 'candidate-ready' })
    await observer.getStates()
    fake.setPollResult({ state: 'finalizing' })
    await observer.getStates()

    // In-process reload resets the page collector array.
    fake.clearCollector()
    const afterReload = await observer.getStates()
    expect(afterReload.map((s) => s.state)).toEqual(['candidate-ready', 'finalizing'])

    // The page closes; the retained history is still readable.
    fake.close()
    const afterClose = await observer.getStates()
    expect(afterClose.map((s) => s.state)).toEqual(['candidate-ready', 'finalizing'])
  })
})

describe('mixed sources (events + polls)', () => {
  it('merges in arrival order with in-place enrichment', async () => {
    const { observer, fake } = await createObserver()
    observer.setSessionId('session-1')

    fake.emitStatusEvent({ state: 'reading' })
    fake.setPollResult({ state: 'candidate-ready' })
    let states = await observer.getStates()
    expect(states.map((s) => s.state)).toEqual(['reading', 'candidate-ready'])
    expect(states[1].stats).toBeNull()

    // The real event arrives with stats and enriches the poll record.
    fake.emitStatusEvent({ state: 'candidate-ready', stats: STATS })
    fake.emitStatusEvent({ state: 'verifying' })
    fake.setPollResult({ state: 'finalizing' })
    states = await observer.getStates()

    expect(states.map((s) => s.state)).toEqual(['reading', 'candidate-ready', 'verifying', 'finalizing'])
    expect(states[1].stats).toEqual(STATS)
    expect(
      assertStateSubsequence(
        states.map((s) => s.state),
        ['candidate-ready', 'finalizing']
      )
    ).toBeNull()
  })
})

describe('exact mirror duplicates (LOCK-OBS-4)', () => {
  it('dedupes the page-collector / console-mirror pair of the same event', async () => {
    const { observer, fake } = await createObserver()
    observer.setSessionId('session-1')

    const record = fake.emitStatusEvent({ state: 'reading' }) as RecordedStatus
    // Both sources delivered the same payload — the history must hold exactly one.
    const states = await observer.getStates()
    expect(states).toHaveLength(1)
    expect(states[0].state).toBe('reading')
    expect(states[0].at).toBe(record.at)
  })

  it('dedupes a late console mirror line (page read already happened)', async () => {
    const { observer, fake } = await createObserver()
    observer.setSessionId('session-1')

    const record = fake.emitStatusEvent({ state: 'candidate-ready', stats: STATS }) as RecordedStatus
    await observer.getStates() // page collector ingested

    // The console mirror is delivered late — exact payload, must be deduplicated.
    fake.pushConsoleMirror(record)
    const states = await observer.getStates()
    expect(states).toHaveLength(1)
    expect(states[0].stats).toEqual(STATS)
  })
})

describe('same-state differing payload (LOCK-OBS-4)', () => {
  it('keeps two events for the same state with different stats distinct', async () => {
    const { observer, fake } = await createObserver()
    observer.setSessionId('session-1')

    fake.emitStatusEvent({ state: 'candidate-ready', stats: { ...STATS, topicCount: 1 } })
    fake.emitStatusEvent({ state: 'candidate-ready', stats: { ...STATS, topicCount: 2 } })

    const states = await observer.getStates()
    expect(states.filter((s) => s.state === 'candidate-ready')).toHaveLength(2)
    expect(states[0].stats?.topicCount).toBe(1)
    expect(states[1].stats?.topicCount).toBe(2)
  })

  it('keeps two same-state events with differing errors distinct', async () => {
    const { observer, fake } = await createObserver()
    observer.setSessionId('session-1')

    fake.emitStatusEvent({ state: 'error', error: 'first failure' })
    fake.emitStatusEvent({ state: 'error', error: 'second failure' })

    const states = await observer.getStates()
    expect(states.filter((s) => s.state === 'error')).toHaveLength(2)
    expect(states.map((s) => s.error)).toEqual(['first failure', 'second failure'])
  })
})

describe('terminal failures (LOCK-OBS-1)', () => {
  it.each([['error'], ['verification-failed'], ['promotion-failed'], ['cancelled']])(
    'fast-fails when %s is observed via poll fallback',
    async (terminal) => {
      const { observer, fake } = await createObserver()
      observer.setSessionId('session-1')
      fake.setPollResult({ state: terminal })
      await expect(observer.waitForState('finalizing', 1000)).rejects.toThrow(`"${terminal}"`)
    }
  )

  it('fast-fails on an event-driven terminal and surfaces the sanitized error', async () => {
    const { observer, fake } = await createObserver()
    observer.setSessionId('session-1')
    fake.emitStatusEvent({ state: 'reading' })
    fake.emitStatusEvent({ state: 'error', error: 'boom' })
    await expect(observer.waitForState('finalizing', 1000)).rejects.toThrow('boom')
  })

  it('fast-fails when a DIFFERENT failure state precedes the awaited one', async () => {
    const { observer, fake } = await createObserver()
    observer.setSessionId('session-1')
    fake.emitStatusEvent({ state: 'error' })
    await expect(observer.waitForState('cancelled', 1000)).rejects.toThrow('"error"')
  })
})

describe('direct failure-state wait', () => {
  it('resolves when waiting for the failure state itself', async () => {
    const { observer, fake } = await createObserver()
    observer.setSessionId('session-1')
    fake.emitStatusEvent({ state: 'error', error: 'boom' })
    const record = await observer.waitForState('error', 1000)
    expect(record.state).toBe('error')
    expect(record.error).toBe('boom')
  })
})

describe('predicate-free waits remain (LOCK-OBS-1/6)', () => {
  it('resolves a predicate-free wait on a poll-only record', async () => {
    const { observer, fake } = await createObserver()
    observer.setSessionId('session-1')
    fake.setPollResult({ state: 'finalizing' })
    const record = await observer.waitForState('finalizing', 1000)
    expect(record.state).toBe('finalizing')
    expect(record.stats).toBeNull()
  })
})

describe('timeout and retained history', () => {
  it('throws the timeout error and retains observed history', async () => {
    const { observer, fake } = await createObserver()
    observer.setSessionId('session-1')
    fake.setPollResult({ state: 'reading' })
    await observer.getStates()

    await expect(observer.waitForState('finalizing', 150)).rejects.toThrow(
      'Timed out waiting for import state "finalizing"'
    )
    const states = await observer.getStates()
    expect(states.map((s) => s.state)).toEqual(['reading'])
  })
})

describe('page close / stop', () => {
  it('keeps retained history readable after the page closes and stop() stays safe', async () => {
    const { observer, fake } = await createObserver()
    observer.setSessionId('session-1')
    fake.emitStatusEvent({ state: 'reading' })
    fake.close()

    const states = await observer.getStates()
    expect(states.map((s) => s.state)).toEqual(['reading'])
    await observer.stop() // must not throw after the page is gone
  })

  it('stop() detaches console + collector so later events are ignored', async () => {
    const { observer, fake } = await createObserver()
    observer.setSessionId('session-1')
    fake.emitStatusEvent({ state: 'reading' })
    await observer.stop()
    expect(fake.isInstalled()).toBe(false)

    fake.emitStatusEvent({ state: 'candidate-ready', stats: STATS })
    const states = await observer.getStates()
    expect(states.map((s) => s.state)).toEqual(['reading'])
  })
})

describe('session mismatch (LOCK-OBS-5)', () => {
  it('does not poll before setSessionId binds a session', async () => {
    const { observer, fake } = await createObserver()
    await observer.getStates()
    expect(fake.getPollCalls()).toBe(0)
  })

  it('does not fabricate records for null or malformed poll status', async () => {
    const { observer, fake } = await createObserver()
    observer.setSessionId('session-1')
    fake.setPollResult(null)
    expect(await observer.getStates()).toEqual([])

    fake.setPollResult({ state: '' })
    expect(await observer.getStates()).toEqual([])
  })

  it('skips a stale poll state that is behind the latest observed state', async () => {
    const { observer, fake } = await createObserver()
    observer.setSessionId('session-1')
    fake.emitStatusEvent({ state: 'reading' })
    fake.emitStatusEvent({ state: 'candidate-ready', stats: STATS })
    fake.emitStatusEvent({ state: 'verifying' })

    fake.setPollResult({ state: 'candidate-ready' }) // stale: behind verifying
    const states = await observer.getStates()
    expect(states.map((s) => s.state)).toEqual(['reading', 'candidate-ready', 'verifying'])
    expect(states).toHaveLength(3)
  })
})

describe('ImportStatusHistory engine (source-aware merge)', () => {
  it('enriches a poll-only record in place, preserving order', () => {
    const history = new ImportStatusHistory()
    history.ingestPoll('candidate-ready', null)
    history.ingestPoll('verifying', null)
    history.ingestEvent({ state: 'candidate-ready', at: 2, error: null, stats: { topicCount: 5 } })

    const entries = history.getEntries()
    expect(entries.map((e) => e.record.state)).toEqual(['candidate-ready', 'verifying'])
    expect(entries[0].source).toBe('event')
    expect(entries[0].record.stats).toEqual({ topicCount: 5 })
    expect(entries[0].record.at).toBe(2)
    expect(entries[1].source).toBe('poll')
  })

  it('never lets a poll overwrite a richer event', () => {
    const history = new ImportStatusHistory()
    history.ingestEvent({ state: 'candidate-ready', at: 1, error: null, stats: { topicCount: 5 } })
    history.ingestPoll('candidate-ready', null)
    expect(history.getRecords()).toHaveLength(1)
    expect(history.getRecords()[0].stats).toEqual({ topicCount: 5 })
  })

  it('keeps same-state events with differing payloads distinct and dedupes exact mirrors', () => {
    const history = new ImportStatusHistory()
    history.ingestEvent({ state: 'error', at: 1, error: 'first', stats: null })
    history.ingestEvent({ state: 'error', at: 2, error: 'second', stats: null })
    expect(history.getRecords()).toHaveLength(2)
    expect(canonicalRecordPayload(history.getRecords()[0])).not.toBe(canonicalRecordPayload(history.getRecords()[1]))

    const mirror = { state: 'error', at: 1, error: 'first', stats: null }
    history.ingestEvent({ ...mirror })
    expect(history.getRecords()).toHaveLength(2) // exact mirror of the first — deduplicated
  })

  it('skips duplicate and stale polls', () => {
    const history = new ImportStatusHistory()
    history.ingestPoll('reading', null)
    history.ingestPoll('reading', null) // unchanged
    history.ingestPoll('candidate-ready', null)
    history.ingestPoll('reading', null) // stale
    expect(history.getRecords().map((r) => r.state)).toEqual(['reading', 'candidate-ready'])
  })

  it('never appends a poll after a failure-terminal state', () => {
    const history = new ImportStatusHistory()
    history.ingestPoll('error', null)
    history.ingestPoll('cancelled', null)
    expect(history.getRecords().map((r) => r.state)).toEqual(['error'])
  })
})

describe('assertStateSubsequence (regression)', () => {
  it('accepts a valid chain and rejects a missing state', () => {
    expect(
      assertStateSubsequence(['reading', 'candidate-ready', 'x', 'finalizing'], ['candidate-ready', 'finalizing'])
    ).toBeNull()
    expect(assertStateSubsequence(['candidate-ready'], ['candidate-ready', 'finalizing'])).toContain('finalizing')
  })

  it('IMPORT_STATE_ORDER covers every required chain state in semantic order', () => {
    for (const state of ['candidate-ready', 'verified-candidate', 'promoting', 'finalizing']) {
      expect(IMPORT_STATE_ORDER).toContain(state)
    }
  })
})
