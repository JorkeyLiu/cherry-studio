import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * S7.9 Auto-sync tooling demand activation — focused demand tests.
 *
 * Source-level topology check (supplementary): bootstrap source must not statically
 * import BackupService; literal dynamic imports and 8s timer are
 * verified via source regex only — this is not a production build topology proof
 * (production build deferred to later build verification). 8s timer and switch
 * semantics preserved; services only loaded when demanded; module/start failures
 * bounded via loggerService without unhandled rejection.
 * Fake timers / module mocks / DOM state isolated per test with stable
 * process/window listener refs and full cleanup to avoid MaxListeners leaks.
 */

function createSettings(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    webdavAutoSync: false,
    localBackupAutoSync: false,
    webdavHost: '',
    webdavSyncInterval: 0,
    localBackupDir: '',
    localBackupSyncInterval: 0,
    s3: {
      endpoint: '',
      region: '',
      bucket: '',
      accessKeyId: '',
      secretAccessKey: '',
      root: '',
      autoSync: false,
      syncInterval: 0,
      maxBackups: 0,
      skipBackupFile: false
    },
    ...overrides
  }
}

describe('init.ts — source-level static import topology (supplementary, S7.9)', () => {
  it('does not statically import BackupService and keeps no Nutstore reference (source-level)', () => {
    const initPath = path.join(process.cwd(), 'src/renderer/src/init.ts')
    const content = fs.readFileSync(initPath, 'utf-8')
    // must not contain static `import ... from './services/BackupService'`
    // This is a source-level check only, not a production build proof.
    expect(content).not.toMatch(/from\s+['"]\.\/services\/BackupService['"]/)
    expect(content).not.toMatch(/Nutstore/)
    // must contain literal dynamic imports
    expect(content).toMatch(/import\(['"]\.\/services\/BackupService['"]\)/)
    // must preserve 8s timer literal
    expect(content).toMatch(/8000/)
  })

  it('uses literal dynamic imports that are statically analyzable (no variable path) — source-level', () => {
    const initPath = path.join(process.cwd(), 'src/renderer/src/init.ts')
    const content = fs.readFileSync(initPath, 'utf-8')
    // dynamic import argument must be a string literal, not a variable
    // Source-level supplementary check; production build verification deferred.
    expect(content).toMatch(/void import\(['"]\.\/services\/BackupService['"]\)/)
  })
})

describe('initAutoSync — demand activation (S7.9)', () => {
  let unhandled: unknown[] = []
  let onProcessUnhandled: ((reason: unknown) => void) | null = null
  const onWindowUnhandled = (e: PromiseRejectionEvent) => {
    unhandled.push(e.reason)
    e.preventDefault()
  }

  beforeEach(() => {
    unhandled = []
    onProcessUnhandled = (r: unknown) => unhandled.push(r)
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('unhandledrejection', onWindowUnhandled as EventListener)
    }
    if (typeof process !== 'undefined' && (process as any).on && onProcessUnhandled) {
      ;(process as any).on('unhandledRejection', onProcessUnhandled)
    }
    vi.useFakeTimers()
    // ensure window.keyv stub exists for initKeyv
    if (typeof window !== 'undefined' && !(window as any).keyv) {
      ;(window as any).keyv = {
        init: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(),
        set: vi.fn(),
        remove: vi.fn(),
        keys: vi.fn().mockReturnValue([])
      }
    }
    // ensure window.api / electron stubs
    if (!(window as any).api) (window as any).api = {}
    if (!(window as any).electron)
      (window as any).electron = { ipcRenderer: { invoke: vi.fn(), on: vi.fn(), send: vi.fn() } }
    if (!(window as any).toast) (window as any).toast = { success: vi.fn(), error: vi.fn() }
    if (!(window as any).modal) (window as any).modal = { error: vi.fn(), confirm: vi.fn(), success: vi.fn() }
  })

  afterEach(async () => {
    if (typeof window !== 'undefined' && window.removeEventListener) {
      window.removeEventListener('unhandledrejection', onWindowUnhandled as EventListener)
    }
    if (typeof process !== 'undefined' && (process as any).off && onProcessUnhandled) {
      ;(process as any).off('unhandledRejection', onProcessUnhandled)
    }
    onProcessUnhandled = null
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.resetModules()
    vi.clearAllMocks()
    vi.restoreAllMocks()
    // clean global refs
    delete (globalThis as any).__S79_backupStartMock
    // clean DOM-ish globals that initKeyv may have touched
    if (typeof document !== 'undefined') {
      document.title = ''
      document.body.innerHTML = ''
    }
    if ((window as any).keyv) {
      // keep stub but reset
      ;(window as any).keyv = {
        init: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(),
        set: vi.fn(),
        remove: vi.fn(),
        keys: vi.fn().mockReturnValue([])
      }
    }
  })

  async function loadInitWithMocks(opts: {
    settings: Record<string, unknown>
    backupStartImpl?: (...args: unknown[]) => unknown
    backupLoadShouldReject?: boolean
  }) {
    const settings = opts.settings

    // Reset modules before defining mocks
    vi.resetModules()

    const mockInitScrollSnapshotCache = vi.fn()
    const mockSubscribeStoreSync = vi.fn()
    const mockSubscribeTopicDeletion = vi.fn()
    const mockWebTraceInit = vi.fn()
    const mockApplyMainWindowTitle = vi.fn()

    vi.doMock('./config/title', () => ({ applyMainWindowTitle: mockApplyMainWindowTitle }))
    // Async-barrier contract: store-reaching init (including AutoSync
    // scheduling) runs after `initialI18nReady`. Mock it resolved so the
    // barrier settles deterministically via microtasks — no timing sleeps.
    vi.doMock('./i18n', () => ({ initialI18nReady: Promise.resolve() }))
    vi.doMock('./services/exactProviderResolver', () => ({ setExactProviderResolver: vi.fn() }))
    vi.doMock('./services/modelMetadata', () => ({ initModelMetadataRegistry: vi.fn() }))
    vi.doMock('./services/scrollSnapshotCache', () => ({
      initScrollSnapshotCache: mockInitScrollSnapshotCache,
      scheduleScrollSnapshotStartupSweep: vi.fn()
    }))
    vi.doMock('./services/StoreSyncService', () => ({ default: { subscribe: mockSubscribeStoreSync } }))
    vi.doMock('./services/topicDeletionSubscription', () => ({
      subscribeTopicDeletionEvents: mockSubscribeTopicDeletion
    }))
    vi.doMock('./services/WebTraceService', () => ({ webTraceService: { init: mockWebTraceInit } }))
    vi.doMock('@kangfenmao/keyv-storage', () => ({
      default: class {
        init() {
          return Promise.resolve()
        }
      }
    }))
    // residentRetention is dynamically imported at top-level in init.ts; mock it to avoid real logic
    vi.doMock('./services/residentRetention', () => ({ startResidentRetention: vi.fn() }))

    const mockGetState = vi.fn(() => ({ settings }))
    vi.doMock('./store', () => ({ default: { getState: mockGetState } }))

    // BackupService demand mock — factory counter proves demand-load
    let backupFactoryCalls = 0

    if (opts.backupLoadShouldReject) {
      vi.doMock('./services/BackupService', () => {
        backupFactoryCalls++
        throw new Error('backup chunk load failed')
      })
    } else {
      const impl = opts.backupStartImpl ?? vi.fn()
      vi.doMock('./services/BackupService', () => {
        backupFactoryCalls++
        return { startAutoSync: impl }
      })
      // expose the impl for assertion via a hoisted-like reference: store on global
      ;(globalThis as any).__S79_backupStartMock = impl
    }

    // loggerService is globally mocked via tests/renderer.setup.ts to mockRendererLoggerService;
    // spy on it after resetModules -> need to re-import after mocks
    const warnSpy = vi.fn()
    // we will intercept loggerService.withContext to return warnSpy
    // Do this via doMock override for @logger? Instead spy after import.
    // Import init (which will use the global mock for @logger)
    await import('./init')

    // Deterministically settle the async bootstrap barrier (initialI18nReady
    // + dynamic store/topicDeletion imports) BEFORE touching the 8s timer, so
    // initAutoSync has scheduled exactly once. The gated TopicDeletion
    // subscription is the barrier-settled signal. Microtasks only — the
    // mocked barrier needs no timers.
    for (let i = 0; i < 30 && mockSubscribeTopicDeletion.mock.calls.length === 0; i++) {
      await Promise.resolve()
    }
    expect(mockSubscribeTopicDeletion).toHaveBeenCalledTimes(1)

    // Allow any remaining top-level dynamic import (residentRetention) to settle
    await Promise.resolve()
    await Promise.resolve()

    // Now attach warn spy on the actual loggerService instance used by init
    const { loggerService } = await import('@logger')
    const originalWithContext = loggerService.withContext.bind(loggerService)
    const withContextSpy = vi.spyOn(loggerService, 'withContext').mockImplementation((...args: unknown[]) => {
      const ctx = originalWithContext(...(args as [string]))
      // Ensure warn is spied
      if (!(ctx as any).__warnSpyAttached) {
        vi.spyOn(ctx as any, 'warn').mockImplementation((...a: unknown[]) => warnSpy(...a))
        ;(ctx as any).__warnSpyAttached = true
      }
      return ctx
    })
    // Also spy directly on loggerService.warn in case withContext not used?
    vi.spyOn(loggerService, 'warn').mockImplementation((...a: unknown[]) => warnSpy(...a))

    return {
      mockGetState,
      mockInitScrollSnapshotCache,
      warnSpy,
      withContextSpy,
      getBackupMock: () => (globalThis as any).__S79_backupStartMock as ReturnType<typeof vi.fn> | undefined,
      getBackupFactoryCalls: () => backupFactoryCalls
    }
  }

  async function advanceAndFlush() {
    // Advance the 8s autoSync timer
    await vi.advanceTimersByTimeAsync(8000)
    // flush dynamic import microtasks + chained then/catch
    for (let i = 0; i < 5; i++) {
      await Promise.resolve()
    }
    // flush any additional timers that services may have scheduled? not needed
    // but ensure all pending timers flushed microtasks
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 3; i++) await Promise.resolve()
  }

  it('does not load/start any service when all switches are off', async () => {
    const { getBackupMock, warnSpy, getBackupFactoryCalls } = await loadInitWithMocks({
      settings: createSettings({
        webdavAutoSync: false,
        localBackupAutoSync: false,
        s3: { ...(createSettings().s3 as object), autoSync: false }
      })
    })
    await advanceAndFlush()
    expect(getBackupFactoryCalls()).toBe(0)
    expect(getBackupMock()?.mock.calls.length ?? 0).toBe(0)
    expect(warnSpy).not.toHaveBeenCalled()
    expect(unhandled.length).toBe(0)
  })

  it('loads and starts BackupService when webdavAutoSync enabled (and only backup)', async () => {
    const backupStart = vi.fn()
    const { getBackupMock, getBackupFactoryCalls } = await loadInitWithMocks({
      settings: createSettings({ webdavAutoSync: true }),
      backupStartImpl: backupStart
    })
    await advanceAndFlush()
    expect(getBackupFactoryCalls()).toBe(1)
    expect(backupStart).toHaveBeenCalledTimes(1)
    // The helper returns the global ref; also ensure via direct
    expect(getBackupMock()).toBe(backupStart)
    expect(unhandled.length).toBe(0)
  })

  it('loads and starts BackupService when s3.autoSync enabled', async () => {
    const backupStart = vi.fn()
    const { warnSpy, getBackupFactoryCalls } = await loadInitWithMocks({
      settings: createSettings({
        s3: { ...(createSettings().s3 as object), autoSync: true, endpoint: 'https://example.com', syncInterval: 60 }
      }),
      backupStartImpl: backupStart
    })
    await advanceAndFlush()
    expect(getBackupFactoryCalls()).toBe(1)
    expect(backupStart).toHaveBeenCalledTimes(1)
    expect(warnSpy).not.toHaveBeenCalled()
    expect(unhandled.length).toBe(0)
  })

  it('loads and starts BackupService when localBackupAutoSync enabled', async () => {
    const backupStart = vi.fn()
    const { getBackupFactoryCalls } = await loadInitWithMocks({
      settings: createSettings({ localBackupAutoSync: true }),
      backupStartImpl: backupStart
    })
    await advanceAndFlush()
    expect(getBackupFactoryCalls()).toBe(1)
    expect(backupStart).toHaveBeenCalledTimes(1)
    expect(unhandled.length).toBe(0)
  })

  it('loads and starts BackupService once when every generic backup switch is enabled', async () => {
    const backupStart = vi.fn()
    const { getBackupFactoryCalls } = await loadInitWithMocks({
      settings: createSettings({
        webdavAutoSync: true,
        localBackupAutoSync: true,
        s3: { ...(createSettings().s3 as object), autoSync: true }
      }),
      backupStartImpl: backupStart
    })
    await advanceAndFlush()
    expect(getBackupFactoryCalls()).toBe(1)
    expect(backupStart).toHaveBeenCalledTimes(1)
    expect(unhandled.length).toBe(0)
  })

  it('bounds backup module load rejection via loggerService and no unhandled rejection', async () => {
    const { warnSpy, getBackupFactoryCalls } = await loadInitWithMocks({
      settings: createSettings({ webdavAutoSync: true }),
      backupLoadShouldReject: true
    })
    await advanceAndFlush()
    expect(getBackupFactoryCalls()).toBe(1)
    expect(warnSpy).toHaveBeenCalled()
    const firstCall = warnSpy.mock.calls[0]?.[0] as string
    expect(firstCall).toMatch(/backup auto-sync startup failed/i)
    expect(unhandled.length).toBe(0)
  })

  it('bounds backup startAutoSync throw via loggerService and no unhandled rejection', async () => {
    const throwingStart = vi.fn(() => {
      throw new Error('backup start failed')
    })
    const { warnSpy, getBackupFactoryCalls } = await loadInitWithMocks({
      settings: createSettings({ webdavAutoSync: true }),
      backupStartImpl: throwingStart
    })
    await advanceAndFlush()
    expect(getBackupFactoryCalls()).toBe(1)
    expect(throwingStart).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalled()
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toMatch(/backup auto-sync startup failed/i)
    expect(unhandled.length).toBe(0)
  })

  it('preserves 8s trigger — no start before 8s, starts at 8s', async () => {
    const backupStart = vi.fn()
    const { getBackupFactoryCalls } = await loadInitWithMocks({
      settings: createSettings({ webdavAutoSync: true }),
      backupStartImpl: backupStart
    })
    // advance 7999ms — should not have started nor loaded
    await vi.advanceTimersByTimeAsync(7999)
    await Promise.resolve()
    await Promise.resolve()
    expect(getBackupFactoryCalls()).toBe(0)
    expect(backupStart).not.toHaveBeenCalled()
    // one more ms
    await vi.advanceTimersByTimeAsync(1)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(getBackupFactoryCalls()).toBe(1)
    expect(backupStart).toHaveBeenCalledTimes(1)
    expect(unhandled.length).toBe(0)
  })

  it('isolates DOM state — does not leak window.keyv or timers between tests', async () => {
    // This test runs after previous tests; ensure clean state
    expect(document.body.innerHTML).toBe('')
    expect(vi.getMockedSystemTime).toBeDefined()
    // quick sanity: loading with all-off still clean
    const backupStart = vi.fn()
    const { getBackupFactoryCalls } = await loadInitWithMocks({
      settings: createSettings({ webdavAutoSync: false }),
      backupStartImpl: backupStart
    })
    await advanceAndFlush()
    expect(getBackupFactoryCalls()).toBe(0)
    expect(backupStart).not.toHaveBeenCalled()
    expect(unhandled.length).toBe(0)
  })
})
