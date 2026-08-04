import type {
  ChatImportEnvelope,
  ChatImportProjectionPayload,
  DiscoveryResult,
  ReadPageResponse
} from '@shared/chatImport/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatImportBridge } from './entryPoint'
import { boot, createChatImportLogger, validateLocation, withTimeout } from './entryPoint'

/**
 * Focused tests for the deterministic page-read timeout helper.
 *
 * These verify that the losing timeout can never leak an unhandled rejection
 * or a pending timer, while preserving the existing 120s timeout error
 * semantics used by handleReadPage.
 */
describe('withTimeout', () => {
  const TIMEOUT_MS = 120_000
  const TIMEOUT_MESSAGE = `Page read timed out after ${TIMEOUT_MS}ms`

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('resolves with the operation value before the timeout and clears the timer', async () => {
    const result = await withTimeout(Promise.resolve('page-data'), TIMEOUT_MS, TIMEOUT_MESSAGE)

    expect(result).toBe('page-data')
    // Timer must be cleared once the operation wins (LOCK-R1: success clears timeout).
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects with the operation error before the timeout and clears the timer', async () => {
    const failure = new Error('read failed')

    await expect(withTimeout(Promise.reject(failure), TIMEOUT_MS, TIMEOUT_MESSAGE)).rejects.toBe(failure)
    // Timer must be cleared on failure (LOCK-R1: read failure clears timeout).
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects once with the diagnostic timeout error when the operation never settles', async () => {
    // A never-settling operation forces the timeout branch to win.
    const never = new Promise<string>(() => {})
    const raced = withTimeout(never, TIMEOUT_MS, TIMEOUT_MESSAGE)
    const assertion = expect(raced).rejects.toThrow(TIMEOUT_MESSAGE)

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
    await assertion

    // Timeout fired exactly once; nothing else is pending.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves no pending timer or unhandled rejection after a successful read', async () => {
    const onUnhandled = vi.fn()
    process.on('unhandledRejection', onUnhandled)

    try {
      await withTimeout(Promise.resolve('ok'), TIMEOUT_MS, TIMEOUT_MESSAGE)

      // Advancing well past the timeout must not fire the (already-cleared) timer.
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 2)
      // Flush any pending microtasks so a stray rejection would surface.
      await Promise.resolve()

      expect(vi.getTimerCount()).toBe(0)
      expect(onUnhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

/**
 * Focused tests for the narrow chatImport logging adapter (LOCK-601/602).
 *
 * These verify that info/error calls are routed through the preload `log`
 * bridge with the fixed levels and message/data shape, and that a missing
 * bridge (or a bridge without `log`) degrades to a strict no-op — the
 * CI-safe behavior required for the hidden sandboxed reader.
 */
describe('createChatImportLogger', () => {
  it('routes info through the bridge log with level "info" and the data array', () => {
    const log = vi.fn()
    const logger = createChatImportLogger({ log })

    logger.info('hello world', { context: 1 })

    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('info', 'hello world', [{ context: 1 }])
  })

  it('routes error through the bridge log with level "error" and the data array', () => {
    const log = vi.fn()
    const logger = createChatImportLogger({ log })

    const failure = new Error('boom')
    logger.error('[chatImport] Fatal error:', failure)

    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('error', '[chatImport] Fatal error:', [failure])
  })

  it('passes an empty data array when no extra arguments are given', () => {
    const log = vi.fn()
    const logger = createChatImportLogger({ log })

    logger.info('plain message')

    expect(log).toHaveBeenCalledWith('info', 'plain message', [])
  })

  it('is a strict no-op when the bridge is absent (LOCK-602)', () => {
    const logger = createChatImportLogger(undefined)

    expect(() => {
      logger.info('hello')
      logger.error('boom', new Error('x'))
    }).not.toThrow()
  })

  it('is a strict no-op when the bridge lacks a log method (LOCK-602)', () => {
    const logger = createChatImportLogger({})

    expect(() => {
      logger.info('hello')
      logger.error('boom')
    }).not.toThrow()
  })
})

/**
 * Focused tests for the location validation gate (LOCK-DEV-3).
 *
 * validateLocation accepts:
 * - file: protocol (any file:// URL)
 * - http://localhost:5173 with exact pathname and no search/hash
 *
 * All other protocols, hosts, ports, pathnames, search, hash are rejected.
 */
describe('validateLocation (LOCK-DEV-3)', () => {
  it('accepts file: protocol with any pathname', () => {
    const result = validateLocation({
      protocol: 'file:',
      origin: 'null',
      pathname: '/tmp/chatImport.html',
      search: '',
      hash: '',
      username: 'ignored',
      password: 'ignored'
    })
    expect(result).toEqual({ ok: true, mode: 'file' })
  })

  it('accepts exact dev origin http://localhost:5173', () => {
    const result = validateLocation({
      protocol: 'http:',
      origin: 'http://localhost:5173',
      pathname: '/src/windows/chatImport/chatImport.html',
      search: '',
      hash: '',
      username: '',
      password: ''
    })
    expect(result).toEqual({ ok: true, mode: 'dev' })
  })

  it('rejects https: protocol on dev origin', () => {
    const result = validateLocation({
      protocol: 'https:',
      origin: 'https://localhost:5173',
      pathname: '/src/windows/chatImport/chatImport.html',
      search: '',
      hash: '',
      username: '',
      password: ''
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('WRONG_ORIGIN')
  })

  it('rejects http: on wrong host (127.0.0.1)', () => {
    const result = validateLocation({
      protocol: 'http:',
      origin: 'http://127.0.0.1:5173',
      pathname: '/src/windows/chatImport/chatImport.html',
      search: '',
      hash: '',
      username: '',
      password: ''
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('WRONG_ORIGIN')
  })

  it('rejects http: on wrong host ([::1])', () => {
    const result = validateLocation({
      protocol: 'http:',
      origin: 'http://[::1]:5173',
      pathname: '/src/windows/chatImport/chatImport.html',
      search: '',
      hash: '',
      username: '',
      password: ''
    })
    expect(result.ok).toBe(false)
  })

  it('rejects http: on wrong port', () => {
    const result = validateLocation({
      protocol: 'http:',
      origin: 'http://localhost:3000',
      pathname: '/src/windows/chatImport/chatImport.html',
      search: '',
      hash: '',
      username: '',
      password: ''
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('WRONG_ORIGIN')
  })

  it('rejects http: on wrong pathname', () => {
    const result = validateLocation({
      protocol: 'http:',
      origin: 'http://localhost:5173',
      pathname: '/src/windows/chatImport/index.html',
      search: '',
      hash: '',
      username: '',
      password: ''
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('WRONG_ORIGIN')
  })

  it('rejects http: with search params', () => {
    const result = validateLocation({
      protocol: 'http:',
      origin: 'http://localhost:5173',
      pathname: '/src/windows/chatImport/chatImport.html',
      search: '?v=1',
      hash: '',
      username: '',
      password: ''
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('WRONG_ORIGIN')
  })

  it('rejects http: with hash fragment', () => {
    const result = validateLocation({
      protocol: 'http:',
      origin: 'http://localhost:5173',
      pathname: '/src/windows/chatImport/chatImport.html',
      search: '',
      hash: '#section',
      username: '',
      password: ''
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('WRONG_ORIGIN')
  })

  it('rejects websocket protocol', () => {
    const result = validateLocation({
      protocol: 'ws:',
      origin: 'ws://localhost:5173',
      pathname: '/src/windows/chatImport/chatImport.html',
      search: '',
      hash: '',
      username: '',
      password: ''
    })
    expect(result.ok).toBe(false)
  })

  it('rejects dev origin with username in URL', () => {
    const result = validateLocation({
      protocol: 'http:',
      origin: 'http://admin@localhost:5173',
      pathname: '/src/windows/chatImport/chatImport.html',
      search: '',
      hash: '',
      username: 'admin',
      password: ''
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('WRONG_ORIGIN')
  })

  it('accepts dev origin only with explicit empty credentials', () => {
    const result = validateLocation({
      protocol: 'http:',
      origin: 'http://localhost:5173',
      pathname: '/src/windows/chatImport/chatImport.html',
      search: '',
      hash: '',
      username: '',
      password: ''
    })
    // This one should be accepted (no credentials in origin)
    expect(result).toEqual({ ok: true, mode: 'dev' })
  })

  it('rejects dev origin with both username and password', () => {
    // Simulate a URL with credentials by constructing the origin string
    // In a real browser, origin would strip credentials, but we test the validation logic
    const result = validateLocation({
      protocol: 'http:',
      origin: 'http://user:pass@localhost:5173',
      pathname: '/src/windows/chatImport/chatImport.html',
      search: '',
      hash: '',
      username: 'user',
      password: 'pass'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('WRONG_ORIGIN')
  })

  it('rejects dev origin with percent-encoded credentials', () => {
    const result = validateLocation({
      protocol: 'http:',
      origin: 'http://user%40domain:pass%3Aword@localhost:5173',
      pathname: '/src/windows/chatImport/chatImport.html',
      search: '',
      hash: '',
      username: 'user%40domain',
      password: 'pass%3Aword'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('WRONG_ORIGIN')
  })
})

/**
 * Shared fake preload bridge used by the boot regression suites. `on*` mirrors
 * ipcRenderer: registration pushes the callback; unregistration removes it and
 * increments the counter.
 */
function createFakeBridge(): {
  bridge: ChatImportBridge
  discoverCallbacks: Array<(sessionId: string) => void>
  readPageCallbacks: Array<
    (request: { sessionId: string; tableName: string; cursor: string | null; pageSize: number }) => void
  >
  cancelCallbacks: Array<(sessionId: string) => void>
  unsubscribeCounts: { discover: number; readPage: number; cancel: number }
  ready: ReturnType<typeof vi.fn>
  discoverResult: ReturnType<typeof vi.fn>
  readPageResult: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
  complete: ReturnType<typeof vi.fn>
  localStorageProjection: ReturnType<typeof vi.fn>
  log: ReturnType<typeof vi.fn>
} {
  const discoverCallbacks: Array<(sessionId: string) => void> = []
  const readPageCallbacks: Array<
    (request: { sessionId: string; tableName: string; cursor: string | null; pageSize: number }) => void
  > = []
  const cancelCallbacks: Array<(sessionId: string) => void> = []
  const unsubscribeCounts = { discover: 0, readPage: 0, cancel: 0 }

  const ready = vi.fn().mockResolvedValue({ ok: true })
  const discoverResult = vi.fn().mockResolvedValue({ ok: true })
  const readPageResult = vi.fn().mockResolvedValue({ ok: true })
  const error = vi.fn()
  const complete = vi.fn()
  const localStorageProjection = vi.fn()
  const log = vi.fn()

  const bridge: ChatImportBridge = {
    ready,
    discoverResult,
    readPageResult,
    complete,
    error,
    localStorageProjection,
    log,
    onDiscover: (callback) => {
      discoverCallbacks.push(callback)
      return () => {
        unsubscribeCounts.discover += 1
        const idx = discoverCallbacks.indexOf(callback)
        if (idx !== -1) discoverCallbacks.splice(idx, 1)
      }
    },
    onReadPage: (callback) => {
      readPageCallbacks.push(callback)
      return () => {
        unsubscribeCounts.readPage += 1
        const idx = readPageCallbacks.indexOf(callback)
        if (idx !== -1) readPageCallbacks.splice(idx, 1)
      }
    },
    onCancel: (callback) => {
      cancelCallbacks.push(callback)
      return () => {
        unsubscribeCounts.cancel += 1
        const idx = cancelCallbacks.indexOf(callback)
        if (idx !== -1) cancelCallbacks.splice(idx, 1)
      }
    }
  }

  return {
    bridge,
    discoverCallbacks,
    readPageCallbacks,
    cancelCallbacks,
    unsubscribeCounts,
    ready,
    discoverResult,
    readPageResult,
    error,
    complete,
    localStorageProjection,
    log
  }
}

const FILE_PROTOCOL_OPTIONS = {
  location: {
    protocol: 'file:',
    origin: 'null',
    pathname: '/tmp/chatImport.html',
    search: '',
    hash: '',
    username: '',
    password: ''
  }
}
const DEV_PROTOCOL_OPTIONS = {
  location: {
    protocol: 'http:',
    origin: 'http://localhost:5173',
    pathname: '/src/windows/chatImport/chatImport.html',
    search: '',
    hash: '',
    username: '',
    password: ''
  }
}
const STUB_DISCOVER: DiscoveryResult = {
  databaseName: 'CherryStudio',
  nativeVersion: 110,
  logicalVersion: 11,
  tableNames: ['topics', 'files']
}

/** Flush the microtask queue so async bridge callbacks settle deterministically. */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve()
  }
}

/**
 * Focused regression tests for the ready/discover listener-ordering fix
 * (LOCK-Y1/Y2/Y4).
 *
 * The bug: `main()` awaited `api.ready('pending')` BEFORE registering
 * `onDiscover`/`onReadPage`/`onCancel`. Main's ready IPC handler sends
 * `ChatImport_Discover` synchronously from inside the ready handler (before its
 * `{ ok: true }` reply), so the event reached the renderer while no listener
 * was installed and was silently dropped — stalling genuine imports at
 * `discovering`.
 *
 * These tests use a fake bridge that records listener registration at ready
 * invocation and can emit a discover event synchronously during ready, proving
 * the callback/result path end-to-end rather than by source-order text
 * assertions.
 */
describe('boot ready/discover ordering (LOCK-Y1/Y2/Y4)', () => {
  it('registers onDiscover, onReadPage, and onCancel before invoking ready (LOCK-Y1)', async () => {
    const harness = createFakeBridge()
    const snapshotAtReady = vi.fn(() => ({
      discover: harness.discoverCallbacks.length,
      readPage: harness.readPageCallbacks.length,
      cancel: harness.cancelCallbacks.length
    }))
    harness.ready.mockImplementation(async () => {
      snapshotAtReady()
      return { ok: true }
    })

    await boot(harness.bridge, FILE_PROTOCOL_OPTIONS)

    // The ready IPC handshake is the FIRST interaction with Main. All three
    // listeners must already be installed at that instant (LOCK-Y1), otherwise
    // a Discover sent synchronously by Main's ready handler is dropped.
    expect(snapshotAtReady).toHaveBeenCalledTimes(1)
    expect(snapshotAtReady).toHaveReturnedWith({ discover: 1, readPage: 1, cancel: 1 })
  })

  it('receives a discover event emitted synchronously during ready — no message loss (LOCK-Y1/Y4)', async () => {
    const harness = createFakeBridge()
    harness.ready.mockImplementation(async () => {
      // Mirror Main: sendDiscover runs synchronously inside the ready handler,
      // before the { ok: true } reply is produced.
      const onDiscover = harness.discoverCallbacks[0]
      expect(onDiscover).toBeDefined() // listener installed before ready (LOCK-Y1)
      onDiscover('session-abc')
      return { ok: true }
    })

    await boot(harness.bridge, { ...FILE_PROTOCOL_OPTIONS, discover: async () => STUB_DISCOVER })
    await flushMicrotasks()

    // The discover event fired during ready is NOT lost: the full
    // discovery → discoverResult callback/result path completes.
    expect(harness.discoverResult).toHaveBeenCalledTimes(1)
    const envelope = harness.discoverResult.mock.calls[0][0] as ChatImportEnvelope<DiscoveryResult>
    expect(envelope.sessionId).toBe('session-abc')
    expect(envelope.phase).toBe('discovery')
    expect(envelope.version).toBe(1)
    expect(envelope.data).toEqual(STUB_DISCOVER)
    expect(harness.error).not.toHaveBeenCalled()
  })

  it('unsubscribes all listeners and closes DB state when ready returns !ok (LOCK-Y2)', async () => {
    const harness = createFakeBridge()
    harness.ready.mockResolvedValue({ ok: false, error: 'SESSION_NOT_ACTIVE' })
    const closeDb = vi.fn().mockResolvedValue(undefined)

    await boot(harness.bridge, { ...FILE_PROTOCOL_OPTIONS, closeDb })

    expect(harness.unsubscribeCounts).toEqual({ discover: 1, readPage: 1, cancel: 1 })
    // No listener leak: the callbacks are gone from the fake ipcRenderer.
    expect(harness.discoverCallbacks).toHaveLength(0)
    expect(harness.readPageCallbacks).toHaveLength(0)
    expect(harness.cancelCallbacks).toHaveLength(0)
    expect(closeDb).toHaveBeenCalledTimes(1)
    expect(harness.discoverResult).not.toHaveBeenCalled()
    expect(harness.error).not.toHaveBeenCalled()
  })

  it('unsubscribes all listeners and closes DB state when ready rejects (LOCK-Y2)', async () => {
    const harness = createFakeBridge()
    const readyError = new Error('ready exploded')
    harness.ready.mockRejectedValue(readyError)
    const closeDb = vi.fn().mockResolvedValue(undefined)

    await expect(boot(harness.bridge, { ...FILE_PROTOCOL_OPTIONS, closeDb })).rejects.toBe(readyError)

    expect(harness.unsubscribeCounts).toEqual({ discover: 1, readPage: 1, cancel: 1 })
    expect(harness.discoverCallbacks).toHaveLength(0)
    expect(harness.readPageCallbacks).toHaveLength(0)
    expect(harness.cancelCallbacks).toHaveLength(0)
    expect(closeDb).toHaveBeenCalledTimes(1)
    expect(harness.error).not.toHaveBeenCalled()
  })

  it('keeps normal cleanup idempotent when two terminal signals race (LOCK-Y2)', async () => {
    const harness = createFakeBridge()
    harness.ready.mockImplementation(async () => {
      // Cancel and a discovery failure both drive the shared cleanup path.
      const onCancel = harness.cancelCallbacks[0]
      const onDiscover = harness.discoverCallbacks[0]
      onCancel('session-c')
      onDiscover('session-d')
      return { ok: true }
    })
    const closeDb = vi.fn().mockResolvedValue(undefined)

    await boot(harness.bridge, {
      ...FILE_PROTOCOL_OPTIONS,
      closeDb,
      discover: async () => {
        throw new Error('IDB missing')
      }
    })
    await flushMicrotasks()

    // No listener is unsubscribed twice and the discovery failure is reported
    // exactly once. The shared cleanup path is single-flight (LOCK-S2): the
    // cancel and discovery-failure paths converge on the same cleanup promise,
    // so closeDb runs exactly once even though two terminal signals raced.
    expect(harness.unsubscribeCounts).toEqual({ discover: 1, readPage: 1, cancel: 1 })
    expect(harness.error).toHaveBeenCalledTimes(1)
    expect(harness.error.mock.calls[0][0]).toMatchObject({ data: { code: 'DISCOVERY_FAILED' } })
    expect(closeDb).toHaveBeenCalledTimes(1)
  })

  it('propagates a closeDb rejection to every racing cleanup caller while running closeDb once (LOCK-S2)', async () => {
    const harness = createFakeBridge()
    const closeError = new Error('db close failed')
    const closeDb = vi.fn().mockRejectedValue(closeError)

    // Capture each racing terminal path's settlement with handlers attached at
    // creation time, so the identical rejection is observed for both callers
    // without any unhandled-rejection window.
    let cancelSettled = Promise.resolve(false)
    let cancelRejection: unknown
    let discoverSettled = Promise.resolve(false)
    let discoverRejection: unknown
    harness.ready.mockImplementation(async () => {
      const onCancel = harness.cancelCallbacks[0] as (sessionId: string) => Promise<void>
      const onDiscover = harness.discoverCallbacks[0] as (sessionId: string) => Promise<void>
      cancelSettled = onCancel('session-c').then(
        () => false,
        (error: unknown) => {
          cancelRejection = error
          return true
        }
      )
      discoverSettled = onDiscover('session-d').then(
        () => false,
        (error: unknown) => {
          discoverRejection = error
          return true
        }
      )
      return { ok: true }
    })

    await boot(harness.bridge, {
      ...FILE_PROTOCOL_OPTIONS,
      closeDb,
      discover: async () => {
        throw new Error('IDB missing')
      }
    })

    // Both concurrent cleanups rejected with the exact same closeDb error
    // (shared single-flight promise) while closeDb itself ran exactly once.
    expect(await Promise.all([cancelSettled, discoverSettled])).toEqual([true, true])
    expect(cancelRejection).toBe(closeError)
    expect(discoverRejection).toBe(closeError)
    expect(closeDb).toHaveBeenCalledTimes(1)
    expect(harness.unsubscribeCounts).toEqual({ discover: 1, readPage: 1, cancel: 1 })
    expect(harness.error).toHaveBeenCalledTimes(1)
  })

  it('async terminal IPC disposer: cancel during in-flight discover does not double-unsubscribe (exact-once)', async () => {
    const harness = createFakeBridge()
    const closeDb = vi.fn().mockResolvedValue(undefined)

    // Simulate: ready fires, discover event arrives and starts an async
    // discovery, then cancel arrives before discovery completes.
    // Both drive the shared cleanup path — must unsubscribe exactly once.
    let resolveDiscover: (() => void) | null = null
    harness.ready.mockImplementation(async () => {
      // Emit discover event — this starts the async discovery.
      const onDiscover = harness.discoverCallbacks[0]
      // Kick off the discover handler (it will block on our promise).
      onDiscover('session-async')
      return { ok: true }
    })

    // Make discover slow — it blocks until we resolve it.
    const discoverImpl = async () => {
      await new Promise<void>((r) => {
        resolveDiscover = r
      })
      return STUB_DISCOVER
    }

    await boot(harness.bridge, {
      ...FILE_PROTOCOL_OPTIONS,
      closeDb,
      discover: discoverImpl
    })
    await flushMicrotasks()

    // Now cancel while discover is still in-flight.
    harness.cancelCallbacks[0]('session-async')
    await flushMicrotasks()

    // Cancel drove cleanup — listeners unsubscribed, closeDb called once.
    expect(harness.unsubscribeCounts).toEqual({ discover: 1, readPage: 1, cancel: 1 })
    expect(closeDb).toHaveBeenCalledTimes(1)

    // Now resolve the discover — it should find cleanup already done
    // and not double-unsubscribe or call closeDb again.
    const finishDiscover = resolveDiscover as (() => void) | null
    if (finishDiscover) finishDiscover()
    await flushMicrotasks()

    // Still exactly once — no double-unsubscribe from the late discover completion.
    expect(harness.unsubscribeCounts).toEqual({ discover: 1, readPage: 1, cancel: 1 })
    expect(closeDb).toHaveBeenCalledTimes(1)
  })

  it('aborts before registering listeners when the page protocol is not file: and not dev (R-3)', async () => {
    const harness = createFakeBridge()

    await boot(harness.bridge, {
      location: {
        protocol: 'https:',
        origin: 'https://example.com',
        pathname: '/chatImport.html',
        search: '',
        hash: '',
        username: '',
        password: ''
      }
    })

    expect(harness.ready).not.toHaveBeenCalled()
    expect(harness.discoverCallbacks).toHaveLength(0)
    expect(harness.readPageCallbacks).toHaveLength(0)
    expect(harness.cancelCallbacks).toHaveLength(0)
    expect(harness.error).toHaveBeenCalledTimes(1)
    expect(harness.error.mock.calls[0][0]).toMatchObject({
      data: { code: 'WRONG_ORIGIN' }
    })
  })

  it('accepts dev origin and registers listeners normally', async () => {
    const harness = createFakeBridge()

    await boot(harness.bridge, {
      ...DEV_PROTOCOL_OPTIONS,
      discover: async () => STUB_DISCOVER
    })

    expect(harness.ready).toHaveBeenCalled()
    expect(harness.discoverCallbacks).toHaveLength(1)
    expect(harness.readPageCallbacks).toHaveLength(1)
    expect(harness.cancelCallbacks).toHaveLength(1)
    expect(harness.error).not.toHaveBeenCalled()
  })
})

/**
 * Focused tests for the source Local Storage `persist:cherry-studio`
 * projection bridge (LOCK-PROD-2 / LOCK-I1).
 *
 * The import renderer runs on the source profile's origin (file:// or the
 * exact dev origin), so `localStorage.getItem('persist:cherry-studio')`
 * reads the exact source entry. The raw serialized string is sent verbatim
 * over the import-only `localStorageProjection` bridge on discovery —
 * never a wholesale Local Storage copy/restore, and never through any
 * other IPC channel. A missing key is represented safely as `persist: null`.
 */
describe('source Local Storage projection (LOCK-PROD-2/LOCK-I1)', () => {
  afterEach(() => {
    window.localStorage.clear()
  })

  it('reads exactly the persist:cherry-studio key and sends the raw state over the import-only bridge', async () => {
    const harness = createFakeBridge()
    window.localStorage.setItem('persist:cherry-studio', '{"assistants":{"assistants":[{"id":"a1"}]}}')
    window.localStorage.setItem('other:key', 'MUST-NOT-LEAK')

    await boot(harness.bridge, { ...FILE_PROTOCOL_OPTIONS, discover: async () => STUB_DISCOVER })
    harness.discoverCallbacks[0]('session-proj')
    await flushMicrotasks()

    expect(harness.localStorageProjection).toHaveBeenCalledTimes(1)
    const envelope = harness.localStorageProjection.mock.calls[0][0] as ChatImportEnvelope<ChatImportProjectionPayload>
    expect(envelope.sessionId).toBe('session-proj')
    expect(envelope.phase).toBe('discovery')
    expect(envelope.version).toBe(1)
    // Raw serialized state is sent verbatim — never a parsed/partial copy.
    expect(envelope.data.persist).toBe('{"assistants":{"assistants":[{"id":"a1"}]}}')
    // Unrelated keys are never read or forwarded.
    expect(envelope.data.persist).not.toContain('MUST-NOT-LEAK')
  })

  it('represents a missing source key safely as persist: null', async () => {
    const harness = createFakeBridge()

    await boot(harness.bridge, { ...FILE_PROTOCOL_OPTIONS, discover: async () => STUB_DISCOVER })
    harness.discoverCallbacks[0]('session-proj-null')
    await flushMicrotasks()

    expect(harness.localStorageProjection).toHaveBeenCalledTimes(1)
    const envelope = harness.localStorageProjection.mock.calls[0][0] as ChatImportEnvelope<ChatImportProjectionPayload>
    expect(envelope.data.persist).toBeNull()
  })

  it('reports the projection BEFORE the discovery result for the same session (event ordering)', async () => {
    const harness = createFakeBridge()
    window.localStorage.setItem('persist:cherry-studio', 'raw-state')

    await boot(harness.bridge, { ...FILE_PROTOCOL_OPTIONS, discover: async () => STUB_DISCOVER })
    harness.discoverCallbacks[0]('session-ord')
    await flushMicrotasks()

    expect(harness.localStorageProjection).toHaveBeenCalledTimes(1)
    expect(harness.discoverResult).toHaveBeenCalledTimes(1)
    expect(harness.localStorageProjection.mock.invocationCallOrder[0]).toBeLessThan(
      harness.discoverResult.mock.invocationCallOrder[0]
    )
  })

  it('contains a readPersistedState throw — discovery still proceeds, no projection envelope', async () => {
    const harness = createFakeBridge()

    await boot(harness.bridge, {
      ...FILE_PROTOCOL_OPTIONS,
      discover: async () => STUB_DISCOVER,
      readPersistedState: () => {
        throw new Error('localStorage blocked')
      }
    })
    harness.discoverCallbacks[0]('session-throw')
    await flushMicrotasks()

    expect(harness.discoverResult).toHaveBeenCalledTimes(1)
    expect(harness.error).not.toHaveBeenCalled()
    expect(harness.localStorageProjection).not.toHaveBeenCalled()
  })

  it('reads the source key on the dev origin too (LOCK-I1 selected origin)', async () => {
    const harness = createFakeBridge()
    window.localStorage.setItem('persist:cherry-studio', 'dev-state')

    await boot(harness.bridge, { ...DEV_PROTOCOL_OPTIONS, discover: async () => STUB_DISCOVER })
    harness.discoverCallbacks[0]('session-dev')
    await flushMicrotasks()

    expect(harness.localStorageProjection).toHaveBeenCalledTimes(1)
    const envelope = harness.localStorageProjection.mock.calls[0][0] as ChatImportEnvelope<ChatImportProjectionPayload>
    expect(envelope.data.persist).toBe('dev-state')
  })

  it('never reads Local Storage when the location gate rejects (only file/dev origins)', async () => {
    const harness = createFakeBridge()
    const readPersistedState = vi.fn(() => 'secret')

    await boot(harness.bridge, {
      location: {
        protocol: 'https:',
        origin: 'https://example.com',
        pathname: '/chatImport.html',
        search: '',
        hash: '',
        username: '',
        password: ''
      },
      readPersistedState
    })

    expect(harness.localStorageProjection).not.toHaveBeenCalled()
    expect(readPersistedState).not.toHaveBeenCalled()
    expect(harness.error).toHaveBeenCalledTimes(1)
    expect(harness.error.mock.calls[0][0]).toMatchObject({ data: { code: 'WRONG_ORIGIN' } })
  })
})

/**
 * Focused tests for cloneForWire integration in the paged read flow
 * (LOCK-N2/N5/N6).
 *
 * Proves that:
 * - Success: items with explicit undefined properties are stripped before IPC.
 * - Failure: non-JSON values (e.g., BigInt) in items produce READ_FAILED,
 *   no page result, and the shared cleanup path runs (listeners unsubscribed,
 *   DB closed).
 */
describe('cloneForWire integration in paged reads (LOCK-N2/N5/N6)', () => {
  const PAGE_SIZE = 500

  /** Create a fake DB whose rows contain explicit undefined properties. */
  function createDbWithUndefinedRows() {
    return {
      table: (tableName: string) => {
        const rows: Record<string, unknown>[] =
          tableName === 'topics'
            ? [
                {
                  id: 't-1',
                  messages: [
                    {
                      id: 'm-1',
                      role: 'user',
                      status: 'success',
                      content: 'hello',
                      createdAt: '2026-01-01T00:00:00.000Z',
                      topicId: 't-1',
                      blocks: ['b-1'],
                      // Explicit undefined fields (LOCK-N2/N8)
                      assistantId: undefined,
                      modelId: undefined,
                      model: undefined,
                      type: undefined,
                      useful: undefined,
                      askId: undefined,
                      mentions: undefined,
                      enabledMCPs: undefined,
                      usage: undefined,
                      metrics: undefined,
                      multiModelMessageStyle: undefined,
                      foldSelected: undefined
                    }
                  ],
                  deletedAt: null
                }
              ]
            : tableName === 'message_blocks'
              ? [
                  {
                    id: 'b-1',
                    messageId: 'm-1',
                    type: 'text',
                    status: 'success',
                    content: 'block content',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: null,
                    // Explicit undefined field (LOCK-N2/N8)
                    error: undefined
                  }
                ]
              : []
        return {
          where: () => ({
            above: () => ({
              limit: (count: number) => ({
                toArray: async () => rows.slice(0, count)
              })
            })
          }),
          toCollection: () => ({
            limit: (count: number) => ({
              toArray: async () => rows.slice(0, count)
            })
          })
        }
      }
    }
  }

  /** Create a fake DB whose rows contain non-JSON values (BigInt). */
  function createDbWithUnsafeRows() {
    return {
      table: () => ({
        where: () => ({
          above: () => ({
            limit: () => ({
              toArray: async () => [{ id: 't-1', bad: BigInt(42) }]
            })
          })
        }),
        toCollection: () => ({
          limit: () => ({
            toArray: async () => [{ id: 't-1', bad: BigInt(42) }]
          })
        })
      })
    }
  }

  /**
   * Shared model object referenced by BOTH messages in the topic row.
   *
   * Mirrors the real defect: IndexedDB structured clone preserves shared
   * references (each assistant message stores `model: assistant.model` — the
   * same object), so the Dexie row contains a non-cyclic shared graph. Before
   * LOCK-N6 this was misreported as `cyclic reference detected` and the first
   * topics page failed with READ_FAILED.
   */
  const SHARED_MODEL = {
    id: 'gpt-4',
    provider: 'openai',
    name: 'GPT-4',
    group: 'gpt',
    capabilities: [{ type: 'text' }]
  }

  /** Create a fake DB whose topic row embeds two messages sharing one model object. */
  function createDbWithSharedModelRows() {
    const sharedModel = { ...SHARED_MODEL }
    return {
      table: (tableName: string) => {
        const rows: Record<string, unknown>[] =
          tableName === 'topics'
            ? [
                {
                  id: 't-1',
                  messages: [
                    {
                      id: 'm-1',
                      role: 'assistant',
                      status: 'success',
                      content: 'first',
                      createdAt: '2026-01-01T00:00:00.000Z',
                      topicId: 't-1',
                      blocks: [],
                      // Same object reference on both messages — shared, NOT cyclic.
                      model: sharedModel
                    },
                    {
                      id: 'm-2',
                      role: 'assistant',
                      status: 'success',
                      content: 'second',
                      createdAt: '2026-01-01T00:00:00.000Z',
                      topicId: 't-1',
                      blocks: [],
                      model: sharedModel
                    }
                  ],
                  deletedAt: null
                }
              ]
            : []
        return {
          where: () => ({
            above: () => ({
              limit: (count: number) => ({
                toArray: async () => rows.slice(0, count)
              })
            })
          }),
          toCollection: () => ({
            limit: (count: number) => ({
              toArray: async () => rows.slice(0, count)
            })
          })
        }
      }
    }
  }

  it('strips explicit undefined properties from items via cloneForWire before IPC (LOCK-N2/N6)', async () => {
    const harness = createFakeBridge()
    const openDb = vi.fn().mockResolvedValue(createDbWithUndefinedRows())
    const closeDb = vi.fn().mockResolvedValue(undefined)

    await boot(harness.bridge, {
      ...FILE_PROTOCOL_OPTIONS,
      discover: async () => STUB_DISCOVER,
      openDb,
      closeDb
    })
    harness.discoverCallbacks[0]('session-n2')
    await flushMicrotasks()

    // Read topics page — the DB returns rows with explicit undefined fields.
    harness.readPageCallbacks[0]({ sessionId: 'session-n2', tableName: 'topics', cursor: null, pageSize: PAGE_SIZE })
    await flushMicrotasks()

    expect(harness.error).not.toHaveBeenCalled()
    expect(harness.readPageResult).toHaveBeenCalledTimes(1)
    const envelope = harness.readPageResult.mock.calls[0][0] as ChatImportEnvelope<ReadPageResponse>
    expect(envelope.phase).toBe('reading')

    // cloneForWire must have stripped all explicit undefined properties.
    const items = envelope.data.items
    expect(items).toHaveLength(1)
    const topic = items[0]
    // The topic itself should not have undefined properties.
    expect(topic).not.toHaveProperty('badUndefined')
    // The embedded message must have undefined fields stripped.
    const msg = (topic as any).messages[0]
    expect(msg).toEqual({
      id: 'm-1',
      role: 'user',
      status: 'success',
      content: 'hello',
      createdAt: '2026-01-01T00:00:00.000Z',
      topicId: 't-1',
      blocks: ['b-1']
    })
    // Verify each undefined field was stripped (not just equal).
    expect(Object.prototype.hasOwnProperty.call(msg, 'assistantId')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(msg, 'modelId')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(msg, 'usage')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(msg, 'multiModelMessageStyle')).toBe(false)
  })

  it('strips undefined from nested block fields via cloneForWire (LOCK-N2/N6)', async () => {
    const harness = createFakeBridge()
    const openDb = vi.fn().mockResolvedValue(createDbWithUndefinedRows())
    const closeDb = vi.fn().mockResolvedValue(undefined)

    await boot(harness.bridge, {
      ...FILE_PROTOCOL_OPTIONS,
      discover: async () => STUB_DISCOVER,
      openDb,
      closeDb
    })
    harness.discoverCallbacks[0]('session-n2-block')
    await flushMicrotasks()

    // Read message_blocks page.
    harness.readPageCallbacks[0]({
      sessionId: 'session-n2-block',
      tableName: 'message_blocks',
      cursor: null,
      pageSize: PAGE_SIZE
    })
    await flushMicrotasks()

    expect(harness.error).not.toHaveBeenCalled()
    const envelope = harness.readPageResult.mock.calls[0][0] as ChatImportEnvelope<ReadPageResponse>
    const block = envelope.data.items[0] as Record<string, unknown>
    // The 'error' field was written as undefined, must be stripped.
    expect(Object.prototype.hasOwnProperty.call(block, 'error')).toBe(false)
    expect(block).toEqual({
      id: 'b-1',
      messageId: 'm-1',
      type: 'text',
      status: 'success',
      content: 'block content',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: null
    })
  })

  it('rejects non-JSON values with READ_FAILED and runs shared cleanup (LOCK-N2/N5)', async () => {
    const harness = createFakeBridge()
    const openDb = vi.fn().mockResolvedValue(createDbWithUnsafeRows())
    const closeDb = vi.fn().mockResolvedValue(undefined)

    await boot(harness.bridge, {
      ...FILE_PROTOCOL_OPTIONS,
      discover: async () => STUB_DISCOVER,
      openDb,
      closeDb
    })
    harness.discoverCallbacks[0]('session-n2-fail')
    await flushMicrotasks()

    // Read page — cloneForWire will throw on BigInt.
    harness.readPageCallbacks[0]({
      sessionId: 'session-n2-fail',
      tableName: 'topics',
      cursor: null,
      pageSize: PAGE_SIZE
    })
    await flushMicrotasks()

    // READ_FAILED error sent, no page result.
    expect(harness.readPageResult).not.toHaveBeenCalled()
    expect(harness.error).toHaveBeenCalledTimes(1)
    const envelope = harness.error.mock.calls[0][0] as ChatImportEnvelope<{ code: string; message: string }>
    expect(envelope.phase).toBe('error')
    expect(envelope.data.code).toBe('READ_FAILED')
    expect(envelope.data.message).toContain('bigint')

    // Shared cleanup path ran: listeners unsubscribed, DB closed.
    expect(harness.unsubscribeCounts).toEqual({ discover: 1, readPage: 1, cancel: 1 })
    expect(harness.discoverCallbacks).toHaveLength(0)
    expect(harness.readPageCallbacks).toHaveLength(0)
    expect(harness.cancelCallbacks).toHaveLength(0)
    expect(closeDb).toHaveBeenCalledTimes(1)
  })

  it('emits a paged topic row whose messages share one model object as duplicated valid JSON, no READ_FAILED (LOCK-N6)', async () => {
    const harness = createFakeBridge()
    const openDb = vi.fn().mockResolvedValue(createDbWithSharedModelRows())
    const closeDb = vi.fn().mockResolvedValue(undefined)

    await boot(harness.bridge, {
      ...FILE_PROTOCOL_OPTIONS,
      discover: async () => STUB_DISCOVER,
      openDb,
      closeDb
    })
    harness.discoverCallbacks[0]('session-n6')
    await flushMicrotasks()

    // Read the first topics page — the row embeds two messages that share one
    // model object (the exact real-ZIP shape that previously failed with
    // `cloneForWire: cyclic reference detected` → READ_FAILED).
    harness.readPageCallbacks[0]({ sessionId: 'session-n6', tableName: 'topics', cursor: null, pageSize: PAGE_SIZE })
    await flushMicrotasks()

    // No READ_FAILED: the page result was emitted normally.
    expect(harness.error).not.toHaveBeenCalled()
    expect(harness.readPageResult).toHaveBeenCalledTimes(1)
    const envelope = harness.readPageResult.mock.calls[0][0] as ChatImportEnvelope<ReadPageResponse>
    expect(envelope.phase).toBe('reading')

    const items = envelope.data.items
    expect(items).toHaveLength(1)
    const topic = items[0]
    const messages = (topic as { messages: Array<{ model: Record<string, unknown> }> }).messages
    expect(messages).toHaveLength(2)

    // Shared source identity became duplicated equal-but-independent clones
    // that are themselves valid JSON over the wire (JSON.stringify-compatible).
    const modelA = messages[0].model
    const modelB = messages[1].model
    expect(modelA).toEqual(SHARED_MODEL)
    expect(modelB).toEqual(SHARED_MODEL)
    expect(modelA).not.toBe(modelB)
    expect(JSON.parse(JSON.stringify(modelA))).toEqual(SHARED_MODEL)
    expect(JSON.parse(JSON.stringify(modelB))).toEqual(SHARED_MODEL)
    // No cycle error surfaced anywhere in the pipeline.
    expect(harness.error).not.toHaveBeenCalled()
  })
})

/**
 * Focused regression tests for the production Dexie lifecycle defect
 * (LOCK-RP2/RP3/RP4).
 *
 * The bug: `handleReadPage` closed the DB after every page and only reopened
 * it when `hasMore` was true. After a single-page entity was consumed the DB
 * stayed closed, so the first page of the NEXT entity failed deterministically
 * with `READ_FAILED: Database not initialized. Run discovery first.` — the
 * failure observed in the standard B-class run on message_blocks.
 *
 * The fix: a `discoveryCompleted` flag (set only after successful discovery,
 * reset at every boot) plus an ensure-open-before-read seam — every read
 * request opens the DB if needed and closes it again after the page (R-11
 * retained). Discovery still gates reads (LOCK-RP4): a read before discovery
 * keeps the existing database-not-initialized error, and per-page close is
 * preserved. Only the DB IO seam is injected — no production pipeline mocks.
 */
describe('chatImport paged read lifecycle (LOCK-RP2/RP3/RP4)', () => {
  const PAGE_SIZE = 500

  /** Keyset-paginated in-memory DB matching the `ChatImportReadDb` surface. */
  function createFakeDb(rows: Record<string, Array<{ id: string }>>) {
    return {
      table: (tableName: string) => {
        const tableRows = rows[tableName] ?? []
        return {
          where: () => ({
            above: (cursor: string) => ({
              limit: (count: number) => ({
                toArray: async () => tableRows.filter((row) => row.id > cursor).slice(0, count)
              })
            })
          }),
          toCollection: () => ({
            limit: (count: number) => ({
              toArray: async () => tableRows.slice(0, count)
            })
          })
        }
      }
    }
  }

  /** Boot a fresh session and complete discovery so reads are permitted. */
  async function bootAfterDiscovery(overrides: Parameters<typeof boot>[1] = {}) {
    const harness = createFakeBridge()
    await boot(harness.bridge, {
      ...FILE_PROTOCOL_OPTIONS,
      discover: async () => STUB_DISCOVER,
      ...overrides
    })
    harness.discoverCallbacks[0]('session-rp')
    await flushMicrotasks()
    return harness
  }

  it('reopens the DB for the next entity after a single-page entity closed it (cross-entity regression)', async () => {
    const harness = createFakeBridge()
    const openDb = vi.fn().mockResolvedValue(
      createFakeDb({
        topics: [{ id: 't1' }, { id: 't2' }],
        message_blocks: [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }]
      })
    )
    const closeDb = vi.fn().mockResolvedValue(undefined)

    await boot(harness.bridge, {
      ...FILE_PROTOCOL_OPTIONS,
      discover: async () => STUB_DISCOVER,
      openDb,
      closeDb
    })
    harness.discoverCallbacks[0]('session-rp')
    await flushMicrotasks()

    // First entity (topics) — single page, hasMore=false.
    harness.readPageCallbacks[0]({ sessionId: 'session-rp', tableName: 'topics', cursor: null, pageSize: PAGE_SIZE })
    await flushMicrotasks()

    expect(harness.error).not.toHaveBeenCalled()
    expect(harness.readPageResult).toHaveBeenCalledTimes(1)
    const topicsEnvelope = harness.readPageResult.mock.calls[0][0] as ChatImportEnvelope<ReadPageResponse>
    expect(topicsEnvelope.phase).toBe('reading')
    expect(topicsEnvelope.data).toEqual({
      tableName: 'topics',
      items: [{ id: 't1' }, { id: 't2' }],
      cursor: 't2',
      hasMore: false
    })
    // R-11 retained: the page is closed even though hasMore=false.
    expect(closeDb).toHaveBeenCalledTimes(1)

    // Next entity (message_blocks) — the old hasMore-only reopen left the DB
    // closed here and this read failed with READ_FAILED. The fix ensures open
    // before read, so the first page of the next entity succeeds.
    harness.readPageCallbacks[0]({
      sessionId: 'session-rp',
      tableName: 'message_blocks',
      cursor: null,
      pageSize: PAGE_SIZE
    })
    await flushMicrotasks()

    expect(harness.error).not.toHaveBeenCalled()
    expect(harness.readPageResult).toHaveBeenCalledTimes(2)
    const blocksEnvelope = harness.readPageResult.mock.calls[1][0] as ChatImportEnvelope<ReadPageResponse>
    expect(blocksEnvelope.data).toEqual({
      tableName: 'message_blocks',
      items: [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }],
      cursor: 'b3',
      hasMore: false
    })
    // ensure-open-before-read: exactly one open + one close per read request.
    expect(openDb).toHaveBeenCalledTimes(2)
    expect(closeDb).toHaveBeenCalledTimes(2)
  })

  it('keeps paging one entity across pages, reopening the DB between pages', async () => {
    const harness = createFakeBridge()
    const topics = Array.from({ length: 1200 }, (_, i) => ({ id: `t${String(i).padStart(4, '0')}` }))
    const openDb = vi.fn().mockResolvedValue(createFakeDb({ topics }))
    const closeDb = vi.fn().mockResolvedValue(undefined)

    await boot(harness.bridge, {
      ...FILE_PROTOCOL_OPTIONS,
      discover: async () => STUB_DISCOVER,
      openDb,
      closeDb
    })
    harness.discoverCallbacks[0]('session-rp')
    await flushMicrotasks()

    // Page 1: first 500 rows, cursor continues after t0499.
    harness.readPageCallbacks[0]({ sessionId: 'session-rp', tableName: 'topics', cursor: null, pageSize: PAGE_SIZE })
    await flushMicrotasks()
    const page1 = harness.readPageResult.mock.calls[0][0].data as ReadPageResponse
    expect(page1.items).toHaveLength(500)
    expect(page1.items[0].id).toBe('t0000')
    expect(page1.items[499].id).toBe('t0499')
    expect(page1.cursor).toBe('t0499')
    expect(page1.hasMore).toBe(true)

    // Page 2: keyset continuation.
    harness.readPageCallbacks[0]({ sessionId: 'session-rp', tableName: 'topics', cursor: 't0499', pageSize: PAGE_SIZE })
    await flushMicrotasks()
    const page2 = harness.readPageResult.mock.calls[1][0].data as ReadPageResponse
    expect(page2.items).toHaveLength(500)
    expect(page2.items[0].id).toBe('t0500')
    expect(page2.cursor).toBe('t0999')
    expect(page2.hasMore).toBe(true)

    // Page 3: final partial page.
    harness.readPageCallbacks[0]({ sessionId: 'session-rp', tableName: 'topics', cursor: 't0999', pageSize: PAGE_SIZE })
    await flushMicrotasks()
    const page3 = harness.readPageResult.mock.calls[2][0].data as ReadPageResponse
    expect(page3.items).toHaveLength(200)
    expect(page3.items[199].id).toBe('t1199')
    expect(page3.cursor).toBe('t1199')
    expect(page3.hasMore).toBe(false)

    expect(harness.error).not.toHaveBeenCalled()
    // Every request opened the DB before reading and closed it after the page.
    expect(openDb).toHaveBeenCalledTimes(3)
    expect(closeDb).toHaveBeenCalledTimes(3)
  })

  it('reports a DB read failure as READ_FAILED and runs the shared cleanup', async () => {
    const harness = createFakeBridge()
    const boom = new Error('read exploded')
    const failingDb = {
      table: () => ({
        where: () => ({
          above: () => ({
            limit: () => ({
              toArray: async () => {
                throw boom
              }
            })
          })
        }),
        toCollection: () => ({
          limit: () => ({
            toArray: async () => {
              throw boom
            }
          })
        })
      })
    }
    const openDb = vi.fn().mockResolvedValue(failingDb)
    const closeDb = vi.fn().mockResolvedValue(undefined)

    await boot(harness.bridge, {
      ...FILE_PROTOCOL_OPTIONS,
      discover: async () => STUB_DISCOVER,
      openDb,
      closeDb
    })
    harness.discoverCallbacks[0]('session-rp')
    await flushMicrotasks()

    harness.readPageCallbacks[0]({ sessionId: 'session-rp', tableName: 'topics', cursor: null, pageSize: PAGE_SIZE })
    await flushMicrotasks()

    expect(harness.error).toHaveBeenCalledTimes(1)
    const envelope = harness.error.mock.calls[0][0] as ChatImportEnvelope<{ code: string; message: string }>
    expect(envelope.phase).toBe('error')
    expect(envelope.data.code).toBe('READ_FAILED')
    expect(envelope.data.message).toBe('read exploded')
    expect(harness.readPageResult).not.toHaveBeenCalled()
    // Per-page close is not reached on error; the shared cleanup closes once.
    expect(closeDb).toHaveBeenCalledTimes(1)
    expect(harness.unsubscribeCounts).toEqual({ discover: 1, readPage: 1, cancel: 1 })
  })

  it('closes the DB and unsubscribes all listeners when cancel arrives after a successful read', async () => {
    const harness = createFakeBridge()
    const openDb = vi.fn().mockResolvedValue(createFakeDb({ topics: [{ id: 't1' }] }))
    const closeDb = vi.fn().mockResolvedValue(undefined)

    await boot(harness.bridge, {
      ...FILE_PROTOCOL_OPTIONS,
      discover: async () => STUB_DISCOVER,
      openDb,
      closeDb
    })
    harness.discoverCallbacks[0]('session-rp')
    await flushMicrotasks()

    // One successful page → per-page close (R-11).
    harness.readPageCallbacks[0]({ sessionId: 'session-rp', tableName: 'topics', cursor: null, pageSize: PAGE_SIZE })
    await flushMicrotasks()
    expect(closeDb).toHaveBeenCalledTimes(1)

    // Cancel → shared idempotent cleanup closes once more and removes listeners.
    harness.cancelCallbacks[0]('session-rp')
    await flushMicrotasks()

    expect(harness.unsubscribeCounts).toEqual({ discover: 1, readPage: 1, cancel: 1 })
    expect(harness.discoverCallbacks).toHaveLength(0)
    expect(harness.readPageCallbacks).toHaveLength(0)
    expect(harness.cancelCallbacks).toHaveLength(0)
    expect(closeDb).toHaveBeenCalledTimes(2)
    expect(harness.error).not.toHaveBeenCalled()
  })

  it('rejects a read before discovery with the existing database-not-initialized error (LOCK-RP4)', async () => {
    const harness = createFakeBridge()
    const openDb = vi.fn()
    const closeDb = vi.fn().mockResolvedValue(undefined)

    await boot(harness.bridge, {
      ...FILE_PROTOCOL_OPTIONS,
      discover: async () => STUB_DISCOVER,
      openDb,
      closeDb
    })
    // No discovery emitted — a read must not be allowed to open the DB.
    harness.readPageCallbacks[0]({ sessionId: 'session-rp', tableName: 'topics', cursor: null, pageSize: PAGE_SIZE })
    await flushMicrotasks()

    expect(harness.error).toHaveBeenCalledTimes(1)
    const envelope = harness.error.mock.calls[0][0] as ChatImportEnvelope<{ code: string; message: string }>
    expect(envelope.data.code).toBe('READ_FAILED')
    expect(envelope.data.message).toBe('Database not initialized. Run discovery first.')
    expect(openDb).not.toHaveBeenCalled()
    expect(harness.readPageResult).not.toHaveBeenCalled()
  })

  it('resets discovery completion for a fresh session so reads cannot reuse prior session state (LOCK-RP4)', async () => {
    // Session 1: discovery completes, so reads are allowed.
    const first = await bootAfterDiscovery({
      openDb: vi.fn().mockResolvedValue(createFakeDb({ topics: [{ id: 't1' }] })),
      closeDb: vi.fn().mockResolvedValue(undefined)
    })
    first.readPageCallbacks[0]({ sessionId: 'session-rp', tableName: 'topics', cursor: null, pageSize: PAGE_SIZE })
    await flushMicrotasks()
    expect(first.error).not.toHaveBeenCalled()

    // Session 2 on the same page/module: a fresh boot clears the flag, so a
    // read before session 2's discovery still fails with the same error.
    const second = createFakeBridge()
    const openDb2 = vi.fn()
    const closeDb2 = vi.fn().mockResolvedValue(undefined)
    await boot(second.bridge, {
      ...FILE_PROTOCOL_OPTIONS,
      discover: async () => STUB_DISCOVER,
      openDb: openDb2,
      closeDb: closeDb2
    })
    second.readPageCallbacks[0]({ sessionId: 'session-rp', tableName: 'topics', cursor: null, pageSize: PAGE_SIZE })
    await flushMicrotasks()

    expect(second.error).toHaveBeenCalledTimes(1)
    expect(second.error.mock.calls[0][0]).toMatchObject({
      data: { code: 'READ_FAILED', message: 'Database not initialized. Run discovery first.' }
    })
    expect(openDb2).not.toHaveBeenCalled()
  })
})
