import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * init.ts — main-window bootstrap contract (async i18n barrier + dynamic store).
 *
 * Binding production contract:
 * - No static runtime import from `init.ts` may transitively reach
 *   store/assistants before `initialI18nReady` (see also
 *   `__tests__/mainWindowBootGraph.test.ts`, which owns the static
 *   reachability proof — this file asserts only the local source shape).
 * - Store-free initializers (Keyv, StoreSync, WebTrace, ModelMetadata) run
 *   immediately at module evaluation.
 * - Store-dependent initializers (residentRetention, AutoSync, TopicDeletion,
 *   ExactProviderResolver) dynamically import after `await initialI18nReady`,
 *   retain per-step failure isolation/logging, and use the imported store
 *   directly.
 */
describe('init.ts — async-barrier bootstrap topology (source-level)', () => {
  const initPath = path.join(process.cwd(), 'src/renderer/src/init.ts')
  const content = fs.readFileSync(initPath, 'utf-8')

  function extractBootstrapTail(src: string): string {
    const idx = src.search(/^initKeyv\(\)/m)
    return idx === -1 ? '' : src.slice(idx)
  }

  function extractFunctionRegion(src: string, name: string): string {
    const startRe = new RegExp(`^function\\s+${name}\\s*\\(`, 'm')
    const start = src.search(startRe)
    if (start === -1) return ''
    const tailStart = src.search(/^initKeyv\(\)/m)
    const after = src.slice(start + 1)
    const nextRel = after.search(/^\s*(?:async\s+)?function\s+\w+\s*\(\s*[^)]*\)\s*\{/m)
    let end: number
    if (nextRel !== -1) {
      end = start + 1 + nextRel
    } else if (tailStart !== -1 && tailStart > start) {
      end = tailStart
    } else {
      end = src.length
    }
    return src.slice(start, end)
  }

  it('statically imports store-free services but never the store or topicDeletion subscription as values', () => {
    // Store-free services stay static and run immediately.
    expect(content).toMatch(/import\s+storeSyncService\s+from\s+['"]\.\/services\/StoreSyncService['"]/)
    expect(content).toMatch(/import\s+\{\s*webTraceService\s*\}\s+from\s+['"]\.\/services\/WebTraceService['"]/)
    // Readiness barrier itself is a static import.
    expect(content).toMatch(/import\s+\{\s*initialI18nReady\s*\}\s+from\s+['"]\.\/i18n['"]/)
    // No static VALUE import of the store (type-only is erased at runtime and
    // evaluates nothing); same for the transitive store-reaching subscription.
    expect(content).not.toMatch(/^\s*import\s+(?!type\b)[^'\n]*\sfrom\s+['"]\.\/store['"]/m)
    expect(content).not.toMatch(
      /^\s*import\s+(?!type\b)[^'\n]*\sfrom\s+['"]\.\/services\/topicDeletionSubscription['"]/m
    )
  })

  it('gates store-reaching init behind initialI18nReady with dynamic store + topicDeletion imports', () => {
    expect(content).toMatch(/await\s+initialI18nReady/)
    expect(content).toMatch(/await\s+import\(['"]\.\/store['"]\)/)
    expect(content).toMatch(/await\s+import\(['"]\.\/services\/topicDeletionSubscription['"]\)/)
    // The store-dependent bootstrap is invoked at the tail and threads the
    // dynamically imported store into store consumers.
    expect(content).toMatch(/void\s+bootstrapStoreDependent\(\)/)
    expect(content).toMatch(/initAutoSync\(store\)/)
    expect(content).toMatch(/initExactProviderResolver\(store\)/)
  })

  it('runs store-free initializers immediately; topicDeletion subscribes only after the barrier', () => {
    const tail = extractBootstrapTail(content)
    expect(tail.length).toBeGreaterThan(0)
    // Immediate store-free inits at module evaluation.
    expect(tail).toMatch(/^initKeyv\(\)/m)
    expect(tail).toMatch(/^initStoreSync\(\)/m)
    expect(tail).toMatch(/^initWebTrace\(\)/m)
    expect(tail).toMatch(/^initModelMetadata\(\)/m)

    // No synchronous top-level TopicDeletion subscription: the only
    // subscribeTopicDeletionEvents call site lives after `await
    // initialI18nReady` inside the async bootstrap.
    const idxBarrier = content.indexOf('await initialI18nReady')
    const idxTopicCall = content.indexOf('subscribeTopicDeletionEvents()')
    expect(idxBarrier).toBeGreaterThan(-1)
    expect(idxTopicCall).toBeGreaterThan(-1)
    expect(idxTopicCall).toBeGreaterThan(idxBarrier)

    // StoreSync/WebTrace direct calls still exist in their immediate wrappers.
    const storeSyncRegion = extractFunctionRegion(content, 'initStoreSync')
    const webTraceRegion = extractFunctionRegion(content, 'initWebTrace')
    expect(storeSyncRegion.length).toBeGreaterThan(0)
    expect(webTraceRegion.length).toBeGreaterThan(0)
    expect(storeSyncRegion).toMatch(/storeSyncService\.subscribe\(\)/)
    expect(webTraceRegion).toMatch(/webTraceService\.init\(\)/)
  })

  it('uses one bootstrap logger context created once with distinct warning messages', () => {
    const bootstrapCreations = (content.match(/loggerService\.withContext\(['"]Bootstrap['"]\)/g) || []).length
    expect(bootstrapCreations).toBe(1)
    expect(content).toMatch(/const\s+bootstrapLogger\s*=\s*loggerService\.withContext\(['"]Bootstrap['"]\)/)

    // Distinct warning messages containing service identifiers (per-step
    // failure isolation retained across the async barrier).
    expect(content).toMatch(/bootstrapLogger\.warn\(.*StoreSync/)
    expect(content).toMatch(/bootstrapLogger\.warn\(.*TopicDeletion/)
    expect(content).toMatch(/bootstrapLogger\.warn\(.*WebTrace/)

    // Each step individually guarded so one failure never blocks the rest.
    expect(content).toMatch(/function initStoreSync\(\)\s*\{\s*try\s*\{/)
    expect(content).toMatch(/function initWebTrace\(\)\s*\{\s*try\s*\{/)
    expect(content).toMatch(/subscribeTopicDeletionEvents\(\)/)
  })

  it('keeps store-free initializers timer/microtask-free; async is scoped to the store-dependent bootstrap', () => {
    const storeSyncBody = extractFunctionRegion(content, 'initStoreSync')
    const webTraceBody = extractFunctionRegion(content, 'initWebTrace')
    expect(storeSyncBody.length).toBeGreaterThan(0)
    expect(webTraceBody.length).toBeGreaterThan(0)
    expect(storeSyncBody).toMatch(/storeSyncService\.subscribe\(\)/)
    expect(webTraceBody).toMatch(/webTraceService\.init\(\)/)

    for (const body of [storeSyncBody, webTraceBody]) {
      expect(body).not.toMatch(/setTimeout/)
      expect(body).not.toMatch(/setInterval/)
      expect(body).not.toMatch(/queueMicrotask/)
      expect(body).not.toMatch(/requestIdleCallback/)
      expect(body).not.toMatch(/requestAnimationFrame/)
      expect(body).not.toMatch(/Promise/)
      expect(body).not.toMatch(/async/)
      expect(body).not.toMatch(/await/)
      expect(body).not.toMatch(/import\(/)
    }

    // The async barrier itself exists exactly once, scoped to the
    // store-dependent bootstrap (never around the store-free inits above).
    const asyncBarriers = content.match(/async\s+function\s+bootstrapStoreDependent/m)
    expect(asyncBarriers).not.toBeNull()
  })

  it('preserves initKeyv, initAutoSync 8s demand timer, scroll-sweep and does not add WebTrace idempotency', () => {
    expect(content).toMatch(/function initKeyv\(\)/)
    expect(content).toMatch(/function initAutoSync\(/)
    expect(content).toMatch(/scheduleScrollSnapshotStartupSweep/)
    expect(content).toMatch(/8000/)
    // WebTraceService should not gain idempotency guard — init.ts must not add guard logic
    expect(content).not.toMatch(/webTrace.*initialized/)
    expect(content).not.toMatch(/hasInitialized/)
  })
})

describe('init.ts — async-barrier bootstrap failure isolation (behavioral)', () => {
  const unhandled: unknown[] = []
  let handler: (r: unknown) => void
  // Owned-timer interception for the real 8s initAutoSync demand timer:
  // init.ts schedules a native setTimeout(..., 8000) after the readiness
  // barrier; under real timers vi.clearAllTimers() cannot cancel it, so each
  // behavioral import would leak one pending timer. We wrap global setTimeout
  // (microtask/barrier behavior unchanged) and clear every owned id in
  // afterEach. No fake timers — deterministic flushMicrotasks() preserved.
  const ownedTimeoutIds: Array<ReturnType<typeof setTimeout>> = []
  let origSetTimeout: typeof setTimeout | null = null
  let origClearTimeout: typeof clearTimeout | null = null
  let origWindowSetTimeout: typeof setTimeout | null = null

  beforeEach(() => {
    unhandled.length = 0
    handler = (r: unknown) => unhandled.push(r)
    if (typeof process !== 'undefined' && (process as any).on) (process as any).on('unhandledRejection', handler)
    if (origSetTimeout === null) {
      origSetTimeout = globalThis.setTimeout
      origClearTimeout = globalThis.clearTimeout
    }
    ownedTimeoutIds.length = 0
    const activeOrigSet = origSetTimeout as unknown as (...args: any[]) => any
    const track = (id: ReturnType<typeof setTimeout>) => {
      ownedTimeoutIds.push(id)
      return id
    }
    globalThis.setTimeout = ((fn: any, ms?: any, ...args: any[]) => track(activeOrigSet(fn, ms, ...args))) as any
    if ((global as any).window?.setTimeout) {
      if (origWindowSetTimeout === null) origWindowSetTimeout = (global as any).window.setTimeout
      const windowOrigSet = origWindowSetTimeout!.bind((global as any).window)
      ;(global as any).window.setTimeout = (fn: any, ms?: any, ...args: any[]) => track(windowOrigSet(fn, ms, ...args))
    }
    if (!(global as any).window) (global as any).window = {}
    if (!(global as any).window.api) (global as any).window.api = {}
    if (!(global as any).window.electron)
      (global as any).window.electron = { ipcRenderer: { on: vi.fn(), send: vi.fn(), invoke: vi.fn() } }
  })

  afterEach(async () => {
    try {
      const clear = origClearTimeout ?? globalThis.clearTimeout
      for (const id of ownedTimeoutIds) {
        try {
          ;(clear as any)(id)
        } catch {}
      }
      ownedTimeoutIds.length = 0
    } catch {}
    try {
      if (origSetTimeout) globalThis.setTimeout = origSetTimeout
      if (origClearTimeout) globalThis.clearTimeout = origClearTimeout
      if (origWindowSetTimeout && (global as any).window?.setTimeout) {
        try {
          ;(global as any).window.setTimeout = origWindowSetTimeout
        } catch {}
      }
    } catch {}
    origSetTimeout = null
    origClearTimeout = null
    origWindowSetTimeout = null
    try {
      if (typeof process !== 'undefined' && (process as any).off) (process as any).off('unhandledRejection', handler)
    } catch {}
    try {
      vi.useRealTimers()
    } catch {}
    try {
      vi.clearAllTimers()
    } catch {}
    try {
      vi.resetModules()
    } catch {}
    try {
      vi.restoreAllMocks()
    } catch {}
    try {
      vi.clearAllMocks()
    } catch {}
    unhandled.length = 0
    try {
      if ((global as any).window?.keyv) delete (global as any).window.keyv
    } catch {}
  })

  type LoadOpts = {
    storeSyncImpl?: () => void
    topicImpl?: () => void
    webTraceImpl?: () => void
    /** When 'reject', initialI18nReady rejects; when 'never', it stays pending. */
    readiness?: 'resolve' | 'reject' | 'never'
    storeLoadShouldReject?: boolean
    topicLoadShouldReject?: boolean
  }

  async function flushMicrotasks(rounds = 30) {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve()
    }
  }

  async function loadInit(opts: LoadOpts = {}) {
    vi.resetModules()
    const events: string[] = []

    const storeSyncImpl =
      opts.storeSyncImpl ??
      vi.fn(() => {
        events.push('StoreSync')
      })
    const topicImpl =
      opts.topicImpl ??
      vi.fn(() => {
        events.push('TopicDeletion')
      })
    const webTraceImpl =
      opts.webTraceImpl ??
      vi.fn(() => {
        events.push('WebTrace')
      })

    // Controllable readiness barrier — deterministic, no timing sleeps.
    let resolveReadiness!: () => void
    let rejectReadiness!: (e: unknown) => void
    const readinessMode = opts.readiness ?? 'resolve'
    const readinessPromise =
      readinessMode === 'never'
        ? new Promise<void>(() => {})
        : new Promise<void>((resolve, reject) => {
            resolveReadiness = resolve
            rejectReadiness = reject
          })

    vi.doMock('@kangfenmao/keyv-storage', () => ({
      default: class {
        init() {
          return Promise.resolve()
        }
      }
    }))
    vi.doMock('./services/scrollSnapshotCache', () => ({
      scheduleScrollSnapshotStartupSweep: vi.fn(),
      initScrollSnapshotCache: vi.fn()
    }))
    vi.doMock('./config/title', () => ({ applyMainWindowTitle: vi.fn() }))
    vi.doMock('./i18n', () => ({ initialI18nReady: readinessPromise }))
    vi.doMock('./services/exactProviderResolver', () => ({ setExactProviderResolver: vi.fn() }))
    vi.doMock('./services/modelMetadata', () => ({ initModelMetadataRegistry: vi.fn() }))
    vi.doMock('./services/startupStageDiagnostics', () => ({ markStartupStage: vi.fn() }))
    vi.doMock('./services/StoreSyncService', () => ({ default: { subscribe: storeSyncImpl } }))
    if (opts.topicLoadShouldReject) {
      vi.doMock('./services/topicDeletionSubscription', () => {
        throw new Error('topic chunk load failed')
      })
    } else {
      vi.doMock('./services/topicDeletionSubscription', () => ({
        subscribeTopicDeletionEvents: topicImpl
      }))
    }
    vi.doMock('./services/WebTraceService', () => ({ webTraceService: { init: webTraceImpl } }))
    vi.doMock('./services/residentRetention', () => ({ startResidentRetention: vi.fn() }))
    if (opts.storeLoadShouldReject) {
      vi.doMock('./store', () => {
        throw new Error('store chunk load failed')
      })
    } else {
      vi.doMock('./store', () => ({
        default: { getState: vi.fn(() => ({ settings: {}, nutstore: {} })) }
      }))
    }
    vi.doMock('./services/BackupService', () => ({ startAutoSync: vi.fn() }))
    vi.doMock('./services/NutstoreService', () => ({ startNutstoreAutoSync: vi.fn() }))

    const { loggerService } = await import('@logger')
    const warnSpy = vi.fn()
    const withContextSpy = vi.spyOn(loggerService, 'withContext').mockImplementation(() => {
      return {
        warn: warnSpy,
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        silly: vi.fn(),
        verbose: vi.fn()
      } as any
    })

    if (!(global as any).window) (global as any).window = {}

    let importError: unknown = null
    try {
      await import('./init')
    } catch (e) {
      importError = e
    }

    // Store-free inits run synchronously at module evaluation; settle their
    // microtasks without resolving the readiness barrier.
    await flushMicrotasks()

    if (readinessMode === 'resolve') {
      resolveReadiness()
      await flushMicrotasks()
    } else if (readinessMode === 'reject') {
      rejectReadiness(new Error('i18n activation failed'))
      await flushMicrotasks()
    }

    return { events, warnSpy, withContextSpy, importError, storeSyncImpl, topicImpl, webTraceImpl }
  }

  it('runs store-free inits immediately and gates TopicDeletion behind readiness, in order', async () => {
    vi.resetModules()
    const events: string[] = []
    const storeSyncMock = vi.fn(() => events.push('StoreSync'))
    const topicMock = vi.fn(() => events.push('TopicDeletion'))
    const webTraceMock = vi.fn(() => events.push('WebTrace'))

    // Manual harness for the pre-resolution gate assertion.
    let resolveReadiness!: () => void
    const readinessPromise = new Promise<void>((resolve) => {
      resolveReadiness = resolve
    })
    vi.doMock('@kangfenmao/keyv-storage', () => ({
      default: class {
        init() {
          return Promise.resolve()
        }
      }
    }))
    vi.doMock('./services/scrollSnapshotCache', () => ({
      scheduleScrollSnapshotStartupSweep: vi.fn(),
      initScrollSnapshotCache: vi.fn()
    }))
    vi.doMock('./config/title', () => ({ applyMainWindowTitle: vi.fn() }))
    vi.doMock('./i18n', () => ({ initialI18nReady: readinessPromise }))
    vi.doMock('./services/exactProviderResolver', () => ({ setExactProviderResolver: vi.fn() }))
    vi.doMock('./services/modelMetadata', () => ({ initModelMetadataRegistry: vi.fn() }))
    vi.doMock('./services/startupStageDiagnostics', () => ({ markStartupStage: vi.fn() }))
    vi.doMock('./services/StoreSyncService', () => ({ default: { subscribe: storeSyncMock } }))
    vi.doMock('./services/topicDeletionSubscription', () => ({
      subscribeTopicDeletionEvents: topicMock
    }))
    vi.doMock('./services/WebTraceService', () => ({ webTraceService: { init: webTraceMock } }))
    vi.doMock('./services/residentRetention', () => ({ startResidentRetention: vi.fn() }))
    vi.doMock('./store', () => ({ default: { getState: vi.fn(() => ({ settings: {}, nutstore: {} })) } }))
    vi.doMock('./services/BackupService', () => ({ startAutoSync: vi.fn() }))
    vi.doMock('./services/NutstoreService', () => ({ startNutstoreAutoSync: vi.fn() }))
    const { loggerService } = await import('@logger')
    const warnSpy = vi.fn()
    const withContextSpy = vi
      .spyOn(loggerService, 'withContext')
      .mockImplementation(
        () => ({ warn: warnSpy, info: vi.fn(), error: vi.fn(), debug: vi.fn(), silly: vi.fn() }) as any
      )
    if (!(global as any).window) (global as any).window = {}

    let importError: unknown = null
    try {
      await import('./init')
    } catch (e) {
      importError = e
    }
    await flushMicrotasks()

    // Deterministic gate proof: store-free inits already ran, TopicDeletion
    // has not — the barrier is still pending.
    expect(importError).toBeNull()
    expect(events).toEqual(['StoreSync', 'WebTrace'])
    expect(topicMock).not.toHaveBeenCalled()

    resolveReadiness()
    await flushMicrotasks()
    expect(topicMock).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['StoreSync', 'WebTrace', 'TopicDeletion'])
    expect(warnSpy).not.toHaveBeenCalled()
    expect(withContextSpy.mock.calls.filter((c) => c[0] === 'Bootstrap').length).toBe(1)
    expect(unhandled.length).toBe(0)
  })

  it('StoreSync throw is bounded to one warning with error; WebTrace still runs sync and TopicDeletion after barrier', async () => {
    const storeSyncError = new Error('storeSync boom')
    const events: string[] = []
    const storeSyncThrow = vi.fn(() => {
      events.push('StoreSync:throw')
      throw storeSyncError
    })
    const topicOk = vi.fn(() => events.push('TopicDeletion'))
    const webTraceOk = vi.fn(() => events.push('WebTrace'))
    const {
      events: got,
      warnSpy,
      withContextSpy,
      importError
    } = await loadInit({
      storeSyncImpl: storeSyncThrow,
      topicImpl: topicOk,
      webTraceImpl: webTraceOk
    })
    void got
    expect(importError).toBeNull()
    expect(events).toEqual(['StoreSync:throw', 'WebTrace', 'TopicDeletion'])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/StoreSync/i)
    expect(warnSpy.mock.calls[0][1]).toBe(storeSyncError)
    expect(topicOk).toHaveBeenCalledTimes(1)
    expect(webTraceOk).toHaveBeenCalledTimes(1)
    expect(withContextSpy.mock.calls.filter((c) => c[0] === 'Bootstrap').length).toBe(1)
    expect(unhandled.length).toBe(0)
  })

  it('TopicDeletion throw after barrier is bounded to one warning and bootstrap completes', async () => {
    const topicError = new Error('topic boom')
    const events: string[] = []
    const storeSyncMock = vi.fn(() => events.push('StoreSync'))
    const topicThrow = vi.fn(() => {
      events.push('TopicDeletion:throw')
      throw topicError
    })
    const webTraceMock = vi.fn(() => events.push('WebTrace'))
    const { warnSpy, withContextSpy, importError } = await loadInit({
      storeSyncImpl: storeSyncMock,
      topicImpl: topicThrow,
      webTraceImpl: webTraceMock
    })
    expect(importError).toBeNull()
    expect(events).toEqual(['StoreSync', 'WebTrace', 'TopicDeletion:throw'])
    expect(storeSyncMock).toHaveBeenCalledTimes(1)
    expect(topicThrow).toHaveBeenCalledTimes(1)
    expect(webTraceMock).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/TopicDeletion/i)
    expect(warnSpy.mock.calls[0][1]).toBe(topicError)
    expect(withContextSpy.mock.calls.filter((c) => c[0] === 'Bootstrap').length).toBe(1)
    expect(unhandled.length).toBe(0)
  })

  it('TopicDeletion module load rejection is bounded and bootstrap completes', async () => {
    const { events, warnSpy, importError } = await loadInit({ topicLoadShouldReject: true })
    expect(importError).toBeNull()
    // Store-free inits still ran; the gated subscription was skipped with a warning.
    expect(events).toEqual(['StoreSync', 'WebTrace'])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/TopicDeletion/i)
    expect(unhandled.length).toBe(0)
  })

  it('WebTrace throw is bounded to one warning with error and bootstrap completes', async () => {
    const webTraceError = new Error('webTrace boom')
    const events: string[] = []
    const storeSyncMock = vi.fn(() => events.push('StoreSync'))
    const topicMock = vi.fn(() => events.push('TopicDeletion'))
    const webTraceThrow = vi.fn(() => {
      events.push('WebTrace:throw')
      throw webTraceError
    })
    const { warnSpy, withContextSpy, importError } = await loadInit({
      storeSyncImpl: storeSyncMock,
      topicImpl: topicMock,
      webTraceImpl: webTraceThrow
    })
    expect(importError).toBeNull()
    expect(events).toEqual(['StoreSync', 'WebTrace:throw', 'TopicDeletion'])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/WebTrace/i)
    expect(warnSpy.mock.calls[0][1]).toBe(webTraceError)
    expect(withContextSpy.mock.calls.filter((c) => c[0] === 'Bootstrap').length).toBe(1)
    expect(unhandled.length).toBe(0)
  })

  it('each failing initializer produces exactly one bounded warning with distinct message and error, no extra warnings', async () => {
    const errors = [new Error('s1'), new Error('t1'), new Error('w1')]
    const events: string[] = []
    const storeSyncThrow = vi.fn(() => {
      events.push('StoreSync:throw')
      throw errors[0]
    })
    const topicThrow = vi.fn(() => {
      events.push('TopicDeletion:throw')
      throw errors[1]
    })
    const webTraceThrow = vi.fn(() => {
      events.push('WebTrace:throw')
      throw errors[2]
    })
    const { warnSpy, withContextSpy, importError } = await loadInit({
      storeSyncImpl: storeSyncThrow,
      topicImpl: topicThrow,
      webTraceImpl: webTraceThrow
    })
    expect(importError).toBeNull()
    // Store-free failures surface synchronously; the gated failure after the barrier.
    expect(events).toEqual(['StoreSync:throw', 'WebTrace:throw', 'TopicDeletion:throw'])
    expect(warnSpy).toHaveBeenCalledTimes(3)
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/StoreSync/i)
    expect(warnSpy.mock.calls[0][1]).toBe(errors[0])
    expect(String(warnSpy.mock.calls[1][0])).toMatch(/WebTrace/i)
    expect(warnSpy.mock.calls[1][1]).toBe(errors[2])
    expect(String(warnSpy.mock.calls[2][0])).toMatch(/TopicDeletion/i)
    expect(warnSpy.mock.calls[2][1]).toBe(errors[1])
    expect(withContextSpy.mock.calls.filter((c) => c[0] === 'Bootstrap').length).toBe(1)
    expect(unhandled.length).toBe(0)
  })

  it('store import failure skips only store-dependent init with a warning; store-free inits already ran', async () => {
    const { events, warnSpy, importError } = await loadInit({ storeLoadShouldReject: true })
    expect(importError).toBeNull()
    expect(events).toEqual(['StoreSync', 'WebTrace'])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/Store import failed/)
    expect(unhandled.length).toBe(0)
  })

  it('readiness rejection still bootstraps on the fallback language — TopicDeletion still subscribes', async () => {
    const { events, topicImpl, importError } = await loadInit({ readiness: 'reject' })
    expect(importError).toBeNull()
    expect(topicImpl).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['StoreSync', 'WebTrace', 'TopicDeletion'])
    expect(unhandled.length).toBe(0)
  })

  it('bootstrap module completes without unhandled rejection when initializer throws (continuation proof)', async () => {
    const events: string[] = []
    const storeSyncThrow = vi.fn(() => {
      events.push('StoreSync:throw')
      throw new Error('boom')
    })
    const topicMock = vi.fn(() => events.push('TopicDeletion'))
    const webTraceMock = vi.fn(() => events.push('WebTrace'))
    const { warnSpy, importError } = await loadInit({
      storeSyncImpl: storeSyncThrow,
      topicImpl: topicMock,
      webTraceImpl: webTraceMock
    })
    expect(importError).toBeNull()
    expect(events).toEqual(['StoreSync:throw', 'WebTrace', 'TopicDeletion'])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(unhandled.length).toBe(0)
  })

  it('uses exactly one bootstrap logger context (withContext Bootstrap called once) even when failures occur', async () => {
    const events: string[] = []
    const storeSyncThrow = vi.fn(() => {
      events.push('StoreSync:throw')
      throw new Error('x')
    })
    const topicMock = vi.fn(() => events.push('TopicDeletion'))
    const webTraceMock = vi.fn(() => events.push('WebTrace'))
    const { withContextSpy, importError } = await loadInit({
      storeSyncImpl: storeSyncThrow,
      topicImpl: topicMock,
      webTraceImpl: webTraceMock
    })
    expect(importError).toBeNull()
    const bootstrapCalls = withContextSpy.mock.calls.filter((c) => c[0] === 'Bootstrap')
    expect(bootstrapCalls.length).toBe(1)
    expect(unhandled.length).toBe(0)
  })
})
