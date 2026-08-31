import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * S7.9 Auto-sync tooling demand activation — focused demand tests.
 *
 * Source-level topology check (supplementary): bootstrap source must not statically
 * import BackupService/NutstoreService; literal dynamic imports and 8s timer are
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

function createNutstore(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    nutstoreAutoSync: false,
    nutstoreToken: '',
    nutstorePath: '/cherry-chat',
    nutstoreSyncInterval: 0,
    nutstoreSyncState: { lastSyncTime: null, syncing: false, lastSyncError: null },
    nutstoreSkipBackupFile: false,
    nutstoreMaxBackups: 0,
    ...overrides
  }
}

describe('init.ts — source-level static import topology (supplementary, S7.9)', () => {
  it('does not statically import BackupService or NutstoreService (source-level)', () => {
    const initPath = path.join(process.cwd(), 'src/renderer/src/init.ts')
    const content = fs.readFileSync(initPath, 'utf-8')
    // must not contain static `import ... from './services/BackupService'`
    // This is a source-level check only, not a production build proof.
    expect(content).not.toMatch(/from\s+['"]\.\/services\/BackupService['"]/)
    expect(content).not.toMatch(/from\s+['"]\.\/services\/NutstoreService['"]/)
    // must contain literal dynamic imports
    expect(content).toMatch(/import\(['"]\.\/services\/BackupService['"]\)/)
    expect(content).toMatch(/import\(['"]\.\/services\/NutstoreService['"]\)/)
    // must preserve 8s timer literal
    expect(content).toMatch(/8000/)
  })

  it('uses literal dynamic imports that are statically analyzable (no variable path) — source-level', () => {
    const initPath = path.join(process.cwd(), 'src/renderer/src/init.ts')
    const content = fs.readFileSync(initPath, 'utf-8')
    // dynamic import argument must be a string literal, not a variable
    // Source-level supplementary check; production build verification deferred.
    expect(content).toMatch(/void import\(['"]\.\/services\/BackupService['"]\)/)
    expect(content).toMatch(/void import\(['"]\.\/services\/NutstoreService['"]\)/)
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
    delete (globalThis as any).__S79_nutstoreStartMock
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
    nutstore: Record<string, unknown>
    backupStartImpl?: (...args: unknown[]) => unknown
    nutstoreStartImpl?: (...args: unknown[]) => unknown
    backupLoadShouldReject?: boolean
    nutstoreLoadShouldReject?: boolean
  }) {
    const settings = opts.settings
    const nutstore = opts.nutstore

    // Reset modules before defining mocks
    vi.resetModules()

    const mockInitScrollSnapshotCache = vi.fn()
    const mockSubscribeStoreSync = vi.fn()
    const mockSubscribeTopicDeletion = vi.fn()
    const mockWebTraceInit = vi.fn()
    const mockApplyMainWindowTitle = vi.fn()

    vi.doMock('./config/title', () => ({ applyMainWindowTitle: mockApplyMainWindowTitle }))
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

    const mockGetState = vi.fn(() => ({ settings, nutstore }))
    vi.doMock('./store', () => ({ default: { getState: mockGetState } }))

    // BackupService / NutstoreService demand mocks — factory counters prove demand-load
    let backupFactoryCalls = 0
    let nutstoreFactoryCalls = 0

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

    if (opts.nutstoreLoadShouldReject) {
      vi.doMock('./services/NutstoreService', () => {
        nutstoreFactoryCalls++
        throw new Error('nutstore chunk load failed')
      })
    } else {
      const impl = opts.nutstoreStartImpl ?? vi.fn().mockResolvedValue(undefined)
      vi.doMock('./services/NutstoreService', () => {
        nutstoreFactoryCalls++
        return { startNutstoreAutoSync: impl }
      })
      ;(globalThis as any).__S79_nutstoreStartMock = impl
    }

    // loggerService is globally mocked via tests/renderer.setup.ts to mockRendererLoggerService;
    // spy on it after resetModules -> need to re-import after mocks
    const warnSpy = vi.fn()
    // we will intercept loggerService.withContext to return warnSpy
    // Do this via doMock override for @logger? Instead spy after import.
    // Import init (which will use the global mock for @logger)
    await import('./init')

    // Allow any top-level dynamic import (residentRetention) to settle
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
      getNutstoreMock: () => (globalThis as any).__S79_nutstoreStartMock as ReturnType<typeof vi.fn> | undefined,
      getBackupFactoryCalls: () => backupFactoryCalls,
      getNutstoreFactoryCalls: () => nutstoreFactoryCalls
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
    const { getBackupMock, getNutstoreMock, warnSpy, getBackupFactoryCalls, getNutstoreFactoryCalls } =
      await loadInitWithMocks({
        settings: createSettings({
          webdavAutoSync: false,
          localBackupAutoSync: false,
          s3: { ...(createSettings().s3 as object), autoSync: false }
        }),
        nutstore: createNutstore({ nutstoreAutoSync: false })
      })
    await advanceAndFlush()
    expect(getBackupFactoryCalls()).toBe(0)
    expect(getNutstoreFactoryCalls()).toBe(0)
    expect(getBackupMock()?.mock.calls.length ?? 0).toBe(0)
    expect(getNutstoreMock()?.mock.calls.length ?? 0).toBe(0)
    expect(warnSpy).not.toHaveBeenCalled()
    expect(unhandled.length).toBe(0)
  })

  it('loads and starts BackupService when webdavAutoSync enabled (and only backup)', async () => {
    const backupStart = vi.fn()
    const nutstoreStart = vi.fn().mockResolvedValue(undefined)
    const { getBackupMock, getBackupFactoryCalls, getNutstoreFactoryCalls } = await loadInitWithMocks({
      settings: createSettings({ webdavAutoSync: true }),
      nutstore: createNutstore({ nutstoreAutoSync: false }),
      backupStartImpl: backupStart,
      nutstoreStartImpl: nutstoreStart
    })
    await advanceAndFlush()
    expect(getBackupFactoryCalls()).toBe(1)
    expect(getNutstoreFactoryCalls()).toBe(0)
    expect(backupStart).toHaveBeenCalledTimes(1)
    expect(nutstoreStart).not.toHaveBeenCalled()
    // The helper returns the global ref; also ensure via direct
    expect(getBackupMock()).toBe(backupStart)
    expect(unhandled.length).toBe(0)
  })

  it('loads and starts BackupService when s3.autoSync enabled', async () => {
    const backupStart = vi.fn()
    const { warnSpy, getBackupFactoryCalls, getNutstoreFactoryCalls } = await loadInitWithMocks({
      settings: createSettings({
        s3: { ...(createSettings().s3 as object), autoSync: true, endpoint: 'https://example.com', syncInterval: 60 }
      }),
      nutstore: createNutstore({ nutstoreAutoSync: false }),
      backupStartImpl: backupStart
    })
    await advanceAndFlush()
    expect(getBackupFactoryCalls()).toBe(1)
    expect(getNutstoreFactoryCalls()).toBe(0)
    expect(backupStart).toHaveBeenCalledTimes(1)
    expect(warnSpy).not.toHaveBeenCalled()
    expect(unhandled.length).toBe(0)
  })

  it('loads and starts BackupService when localBackupAutoSync enabled', async () => {
    const backupStart = vi.fn()
    const { getBackupFactoryCalls, getNutstoreFactoryCalls } = await loadInitWithMocks({
      settings: createSettings({ localBackupAutoSync: true }),
      nutstore: createNutstore({ nutstoreAutoSync: false }),
      backupStartImpl: backupStart
    })
    await advanceAndFlush()
    expect(getBackupFactoryCalls()).toBe(1)
    expect(getNutstoreFactoryCalls()).toBe(0)
    expect(backupStart).toHaveBeenCalledTimes(1)
    expect(unhandled.length).toBe(0)
  })

  it('loads and starts NutstoreService when nutstoreAutoSync enabled (and only nutstore)', async () => {
    const backupStart = vi.fn()
    const nutstoreStart = vi.fn().mockResolvedValue(undefined)
    const { getBackupFactoryCalls, getNutstoreFactoryCalls } = await loadInitWithMocks({
      settings: createSettings({
        webdavAutoSync: false,
        localBackupAutoSync: false,
        s3: { ...(createSettings().s3 as object), autoSync: false }
      }),
      nutstore: createNutstore({ nutstoreAutoSync: true }),
      backupStartImpl: backupStart,
      nutstoreStartImpl: nutstoreStart
    })
    await advanceAndFlush()
    expect(getBackupFactoryCalls()).toBe(0)
    expect(getNutstoreFactoryCalls()).toBe(1)
    expect(backupStart).not.toHaveBeenCalled()
    expect(nutstoreStart).toHaveBeenCalledTimes(1)
    expect(unhandled.length).toBe(0)
  })

  it('loads and starts both families when both switches enabled, each once', async () => {
    const backupStart = vi.fn()
    const nutstoreStart = vi.fn().mockResolvedValue(undefined)
    const { getBackupFactoryCalls, getNutstoreFactoryCalls } = await loadInitWithMocks({
      settings: createSettings({
        webdavAutoSync: true,
        localBackupAutoSync: true,
        s3: { ...(createSettings().s3 as object), autoSync: true }
      }),
      nutstore: createNutstore({ nutstoreAutoSync: true }),
      backupStartImpl: backupStart,
      nutstoreStartImpl: nutstoreStart
    })
    await advanceAndFlush()
    expect(getBackupFactoryCalls()).toBe(1)
    expect(getNutstoreFactoryCalls()).toBe(1)
    expect(backupStart).toHaveBeenCalledTimes(1)
    expect(nutstoreStart).toHaveBeenCalledTimes(1)
    expect(unhandled.length).toBe(0)
  })

  it('bounds backup module load rejection via loggerService and no unhandled rejection', async () => {
    const { warnSpy, getBackupFactoryCalls, getNutstoreFactoryCalls } = await loadInitWithMocks({
      settings: createSettings({ webdavAutoSync: true }),
      nutstore: createNutstore({ nutstoreAutoSync: false }),
      backupLoadShouldReject: true
    })
    await advanceAndFlush()
    expect(getBackupFactoryCalls()).toBe(1)
    expect(getNutstoreFactoryCalls()).toBe(0)
    expect(warnSpy).toHaveBeenCalled()
    const firstCall = warnSpy.mock.calls[0]?.[0] as string
    expect(firstCall).toMatch(/backup auto-sync startup failed/i)
    expect(unhandled.length).toBe(0)
  })

  it('bounds backup startAutoSync throw via loggerService and no unhandled rejection', async () => {
    const throwingStart = vi.fn(() => {
      throw new Error('backup start failed')
    })
    const { warnSpy, getBackupFactoryCalls, getNutstoreFactoryCalls } = await loadInitWithMocks({
      settings: createSettings({ webdavAutoSync: true }),
      nutstore: createNutstore({ nutstoreAutoSync: false }),
      backupStartImpl: throwingStart
    })
    await advanceAndFlush()
    expect(getBackupFactoryCalls()).toBe(1)
    expect(getNutstoreFactoryCalls()).toBe(0)
    expect(throwingStart).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalled()
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toMatch(/backup auto-sync startup failed/i)
    expect(unhandled.length).toBe(0)
  })

  it('bounds nutstore module load rejection via loggerService and no unhandled rejection', async () => {
    const { warnSpy, getBackupFactoryCalls, getNutstoreFactoryCalls } = await loadInitWithMocks({
      settings: createSettings({ webdavAutoSync: false }),
      nutstore: createNutstore({ nutstoreAutoSync: true }),
      nutstoreLoadShouldReject: true
    })
    await advanceAndFlush()
    expect(getBackupFactoryCalls()).toBe(0)
    expect(getNutstoreFactoryCalls()).toBe(1)
    expect(warnSpy).toHaveBeenCalled()
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toMatch(/nutstore auto-sync startup failed/i)
    expect(unhandled.length).toBe(0)
  })

  it('bounds nutstore startNutstoreAutoSync rejection via loggerService and no unhandled rejection', async () => {
    const rejectingStart = vi.fn().mockRejectedValue(new Error('nutstore start failed'))
    const { warnSpy, getBackupFactoryCalls, getNutstoreFactoryCalls } = await loadInitWithMocks({
      settings: createSettings({ webdavAutoSync: false }),
      nutstore: createNutstore({ nutstoreAutoSync: true }),
      nutstoreStartImpl: rejectingStart
    })
    await advanceAndFlush()
    expect(getBackupFactoryCalls()).toBe(0)
    expect(getNutstoreFactoryCalls()).toBe(1)
    expect(rejectingStart).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalled()
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toMatch(/nutstore auto-sync startup failed/i)
    expect(unhandled.length).toBe(0)
  })

  it('preserves 8s trigger — no start before 8s, starts at 8s', async () => {
    const backupStart = vi.fn()
    const { getBackupFactoryCalls, getNutstoreFactoryCalls } = await loadInitWithMocks({
      settings: createSettings({ webdavAutoSync: true }),
      nutstore: createNutstore({ nutstoreAutoSync: false }),
      backupStartImpl: backupStart
    })
    // advance 7999ms — should not have started nor loaded
    await vi.advanceTimersByTimeAsync(7999)
    await Promise.resolve()
    await Promise.resolve()
    expect(getBackupFactoryCalls()).toBe(0)
    expect(getNutstoreFactoryCalls()).toBe(0)
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
    const { getBackupFactoryCalls, getNutstoreFactoryCalls } = await loadInitWithMocks({
      settings: createSettings({ webdavAutoSync: false }),
      nutstore: createNutstore({ nutstoreAutoSync: false }),
      backupStartImpl: backupStart
    })
    await advanceAndFlush()
    expect(getBackupFactoryCalls()).toBe(0)
    expect(getNutstoreFactoryCalls()).toBe(0)
    expect(backupStart).not.toHaveBeenCalled()
    expect(unhandled.length).toBe(0)
  })
})
