import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('init.ts S7.11 — source-level static and synchronous topology', () => {
  const initPath = path.join(process.cwd(), 'src/renderer/src/init.ts')
  const content = fs.readFileSync(initPath, 'utf-8')

  function extractBootstrapTail(src: string): string {
    const idx = src.search(/^initKeyv\(\)/m)
    return idx === -1 ? '' : src.slice(idx)
  }

  function extractFunctionRegion(src: string, name: string): string {
    const startRe = new RegExp(`^function\\s+${name}\\s*\\(\\)`, 'm')
    const start = src.search(startRe)
    if (start === -1) return ''
    const tailStart = src.search(/^initKeyv\(\)/m)
    const after = src.slice(start + 1)
    const nextRel = after.search(/^\s*function\s+\w+\s*\(\)\s*\{/m)
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

  it('preserves static imports for critical bootstrap services', () => {
    expect(content).toMatch(/import\s+storeSyncService\s+from\s+['"]\.\/services\/StoreSyncService['"]/)
    expect(content).toMatch(
      /import\s+\{\s*subscribeTopicDeletionEvents\s*\}\s+from\s+['"]\.\/services\/topicDeletionSubscription['"]/
    )
    expect(content).toMatch(/import\s+\{\s*webTraceService\s*\}\s+from\s+['"]\.\/services\/WebTraceService['"]/)
  })

  it('does not use dynamic import for critical services', () => {
    expect(content).not.toMatch(/import\(['"]\.\/services\/StoreSyncService['"]\)/)
    expect(content).not.toMatch(/import\(['"]\.\/services\/topicDeletionSubscription['"]\)/)
    expect(content).not.toMatch(/import\(['"]\.\/services\/WebTraceService['"]\)/)
  })

  it('calls critical initializers synchronously in order StoreSync → TopicDeletion → WebTrace', () => {
    // presence of direct calls
    expect(content).toMatch(/storeSyncService\.subscribe\(\)/)
    expect(content).toMatch(/subscribeTopicDeletionEvents\(\)/)
    expect(content).toMatch(/webTraceService\.init\(\)/)

    // order via direct service calls (unique to wrapper bodies)
    const idxStoreSyncCall = content.indexOf('storeSyncService.subscribe()')
    const idxTopicCall = content.indexOf('subscribeTopicDeletionEvents()')
    const idxWebTraceCall = content.indexOf('webTraceService.init()')
    expect(idxStoreSyncCall).toBeGreaterThan(-1)
    expect(idxTopicCall).toBeGreaterThan(-1)
    expect(idxWebTraceCall).toBeGreaterThan(-1)
    expect(idxStoreSyncCall).toBeLessThan(idxTopicCall)
    expect(idxTopicCall).toBeLessThan(idxWebTraceCall)

    // invocation order at bottom — inspect bootstrap-call tail region after function definitions
    const tail = extractBootstrapTail(content)
    expect(tail.length).toBeGreaterThan(0)
    expect(tail).toMatch(/^initKeyv\(\)/m)
    expect(tail).toMatch(/^initAutoSync\(\)/m)
    expect(tail).toMatch(/^initStoreSync\(\)/m)
    expect(tail).toMatch(/^initTopicDeletionSubscription\(\)/m)
    expect(tail).toMatch(/^initWebTrace\(\)/m)

    const idxBottomStoreSync = tail.search(/^initStoreSync\(\)/m)
    const idxBottomTopic = tail.search(/^initTopicDeletionSubscription\(\)/m)
    const idxBottomWebTrace = tail.search(/^initWebTrace\(\)/m)
    expect(idxBottomStoreSync).toBeGreaterThan(-1)
    expect(idxBottomTopic).toBeGreaterThan(-1)
    expect(idxBottomWebTrace).toBeGreaterThan(-1)
    expect(idxBottomStoreSync).toBeLessThan(idxBottomTopic)
    expect(idxBottomTopic).toBeLessThan(idxBottomWebTrace)

    // extracted wrapper regions are non-empty and contain expected direct calls
    const storeSyncRegion = extractFunctionRegion(content, 'initStoreSync')
    const topicRegion = extractFunctionRegion(content, 'initTopicDeletionSubscription')
    const webTraceRegion = extractFunctionRegion(content, 'initWebTrace')
    expect(storeSyncRegion.length).toBeGreaterThan(0)
    expect(topicRegion.length).toBeGreaterThan(0)
    expect(webTraceRegion.length).toBeGreaterThan(0)
    expect(storeSyncRegion).toMatch(/storeSyncService\.subscribe\(\)/)
    expect(topicRegion).toMatch(/subscribeTopicDeletionEvents\(\)/)
    expect(webTraceRegion).toMatch(/webTraceService\.init\(\)/)
  })

  it('uses one bootstrap logger context created once with distinct warning messages', () => {
    // single creation
    const bootstrapCreations = (content.match(/loggerService\.withContext\(['"]Bootstrap['"]\)/g) || []).length
    expect(bootstrapCreations).toBe(1)
    expect(content).toMatch(/const\s+bootstrapLogger\s*=\s*loggerService\.withContext\(['"]Bootstrap['"]\)/)

    // distinct warning messages containing service identifiers
    expect(content).toMatch(/bootstrapLogger\.warn\(.*StoreSync/)
    expect(content).toMatch(/bootstrapLogger\.warn\(.*TopicDeletion/)
    expect(content).toMatch(/bootstrapLogger\.warn\(.*WebTrace/)

    // each wrapped in try/catch
    expect(content).toMatch(/function initStoreSync\(\)\s*\{\s*try\s*\{/)
    expect(content).toMatch(/function initTopicDeletionSubscription\(\)\s*\{\s*try\s*\{/)
    expect(content).toMatch(/function initWebTrace\(\)\s*\{\s*try\s*\{/)
  })

  it('does not introduce timers, microtasks, or async wrappers for critical initializers', () => {
    const storeSyncBody = extractFunctionRegion(content, 'initStoreSync')
    const topicBody = extractFunctionRegion(content, 'initTopicDeletionSubscription')
    const webTraceBody = extractFunctionRegion(content, 'initWebTrace')

    // genuine non-empty bodies with expected direct calls — proves extraction is real, not empty
    expect(storeSyncBody.length).toBeGreaterThan(0)
    expect(topicBody.length).toBeGreaterThan(0)
    expect(webTraceBody.length).toBeGreaterThan(0)
    expect(storeSyncBody).toMatch(/storeSyncService\.subscribe\(\)/)
    expect(topicBody).toMatch(/subscribeTopicDeletionEvents\(\)/)
    expect(webTraceBody).toMatch(/webTraceService\.init\(\)/)

    for (const body of [storeSyncBody, topicBody, webTraceBody]) {
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
  })

  it('preserves initKeyv, initAutoSync, S7.10 0ms maintenance behavior and does not add WebTrace idempotency', () => {
    expect(content).toMatch(/function initKeyv\(\)/)
    expect(content).toMatch(/function initAutoSync\(\)/)
    expect(content).toMatch(/scheduleScrollSnapshotStartupSweep/)
    expect(content).toMatch(/8000/)
    // WebTraceService should not gain idempotency guard — init.ts must not add guard logic
    // Ensure no added flag check for WebTrace in init.ts
    expect(content).not.toMatch(/webTrace.*initialized/)
    expect(content).not.toMatch(/hasInitialized/)
  })
})

describe('init.ts S7.11 — critical bootstrap synchronous failure isolation', () => {
  const unhandled: unknown[] = []
  let handler: (r: unknown) => void

  beforeEach(() => {
    unhandled.length = 0
    handler = (r: unknown) => unhandled.push(r)
    if (typeof process !== 'undefined' && (process as any).on) (process as any).on('unhandledRejection', handler)
    // ensure window stub
    if (!(global as any).window) (global as any).window = {}
    if (!(global as any).window.api) (global as any).window.api = {}
    if (!(global as any).window.electron)
      (global as any).window.electron = { ipcRenderer: { on: vi.fn(), send: vi.fn(), invoke: vi.fn() } }
  })

  afterEach(async () => {
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
    vi.doMock('./services/StoreSyncService', () => ({ default: { subscribe: storeSyncImpl } }))
    vi.doMock('./services/topicDeletionSubscription', () => ({
      subscribeTopicDeletionEvents: topicImpl
    }))
    vi.doMock('./services/WebTraceService', () => ({ webTraceService: { init: webTraceImpl } }))
    vi.doMock('./services/residentRetention', () => ({ startResidentRetention: vi.fn() }))
    vi.doMock('./store', () => ({
      default: { getState: vi.fn(() => ({ settings: {}, nutstore: {} })) }
    }))
    vi.doMock('./services/BackupService', () => ({ startAutoSync: vi.fn() }))
    vi.doMock('./services/NutstoreService', () => ({ startNutstoreAutoSync: vi.fn() }))

    const { loggerService } = await import('@logger')
    const warnSpy = vi.fn()
    const withContextSpy = vi.spyOn(loggerService, 'withContext').mockImplementation(() => {
      // return a context-like object; for any ctx return warnSpy so we can capture
      return {
        warn: warnSpy,
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        silly: vi.fn(),
        verbose: vi.fn()
      } as any
    })

    // ensure window exists before import (initKeyv will assign window.keyv)
    if (!(global as any).window) (global as any).window = {}

    let importError: unknown = null
    try {
      await import('./init')
    } catch (e) {
      importError = e
    }
    // allow top-level dynamic import (residentRetention) microtasks to settle
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    return { events, warnSpy, withContextSpy, importError, storeSyncImpl, topicImpl, webTraceImpl }
  }

  it('successful bootstrap calls in order StoreSync → TopicDeletion → WebTrace with no warning and no unhandled rejection', async () => {
    const { events, warnSpy, withContextSpy, importError } = await loadInit()
    expect(importError).toBeNull()
    expect(events).toEqual(['StoreSync', 'TopicDeletion', 'WebTrace'])
    expect(warnSpy).not.toHaveBeenCalled()
    // bootstrap logger created once with 'Bootstrap'
    const bootstrapCalls = withContextSpy.mock.calls.filter((c) => c[0] === 'Bootstrap')
    expect(bootstrapCalls.length).toBe(1)
    expect(unhandled.length).toBe(0)
  })

  it('StoreSync throw is bounded to one warning with error and later initializers still run', async () => {
    const storeSyncError = new Error('storeSync boom')
    const events: string[] = []
    const storeSyncThrow = vi.fn(() => {
      events.push('StoreSync:throw')
      throw storeSyncError
    })
    const topicOk = vi.fn(() => events.push('TopicDeletion'))
    const webTraceOk = vi.fn(() => events.push('WebTrace'))
    vi.resetModules()
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
    vi.doMock('./services/StoreSyncService', () => ({ default: { subscribe: storeSyncThrow } }))
    vi.doMock('./services/topicDeletionSubscription', () => ({ subscribeTopicDeletionEvents: topicOk }))
    vi.doMock('./services/WebTraceService', () => ({ webTraceService: { init: webTraceOk } }))
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
    await Promise.resolve()
    await Promise.resolve()
    expect(importError).toBeNull()
    expect(events).toEqual(['StoreSync:throw', 'TopicDeletion', 'WebTrace'])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/StoreSync/i)
    expect(warnSpy.mock.calls[0][1]).toBe(storeSyncError)
    expect(topicOk).toHaveBeenCalledTimes(1)
    expect(webTraceOk).toHaveBeenCalledTimes(1)
    expect(withContextSpy.mock.calls.filter((c) => c[0] === 'Bootstrap').length).toBe(1)
    expect(unhandled.length).toBe(0)
  })

  it('TopicDeletion throw is bounded to one warning with error and later initializer still runs', async () => {
    const topicError = new Error('topic boom')
    const events: string[] = []
    const storeSyncMock = vi.fn(() => events.push('StoreSync'))
    const topicThrow = vi.fn(() => {
      events.push('TopicDeletion:throw')
      throw topicError
    })
    const webTraceMock = vi.fn(() => events.push('WebTrace'))
    vi.resetModules()
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
    vi.doMock('./services/StoreSyncService', () => ({ default: { subscribe: storeSyncMock } }))
    vi.doMock('./services/topicDeletionSubscription', () => ({ subscribeTopicDeletionEvents: topicThrow }))
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
    await Promise.resolve()
    await Promise.resolve()
    expect(importError).toBeNull()
    expect(events).toEqual(['StoreSync', 'TopicDeletion:throw', 'WebTrace'])
    expect(storeSyncMock).toHaveBeenCalledTimes(1)
    expect(topicThrow).toHaveBeenCalledTimes(1)
    expect(webTraceMock).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/TopicDeletion/i)
    expect(warnSpy.mock.calls[0][1]).toBe(topicError)
    expect(withContextSpy.mock.calls.filter((c) => c[0] === 'Bootstrap').length).toBe(1)
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
    vi.resetModules()
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
    vi.doMock('./services/StoreSyncService', () => ({ default: { subscribe: storeSyncMock } }))
    vi.doMock('./services/topicDeletionSubscription', () => ({ subscribeTopicDeletionEvents: topicMock }))
    vi.doMock('./services/WebTraceService', () => ({ webTraceService: { init: webTraceThrow } }))
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
    await Promise.resolve()
    await Promise.resolve()
    expect(importError).toBeNull()
    expect(events).toEqual(['StoreSync', 'TopicDeletion', 'WebTrace:throw'])
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
    vi.resetModules()
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
    vi.doMock('./services/StoreSyncService', () => ({ default: { subscribe: storeSyncThrow } }))
    vi.doMock('./services/topicDeletionSubscription', () => ({ subscribeTopicDeletionEvents: topicThrow }))
    vi.doMock('./services/WebTraceService', () => ({ webTraceService: { init: webTraceThrow } }))
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
    await Promise.resolve()
    await Promise.resolve()
    expect(importError).toBeNull()
    expect(events).toEqual(['StoreSync:throw', 'TopicDeletion:throw', 'WebTrace:throw'])
    expect(warnSpy).toHaveBeenCalledTimes(3)
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/StoreSync/i)
    expect(warnSpy.mock.calls[0][1]).toBe(errors[0])
    expect(String(warnSpy.mock.calls[1][0])).toMatch(/TopicDeletion/i)
    expect(warnSpy.mock.calls[1][1]).toBe(errors[1])
    expect(String(warnSpy.mock.calls[2][0])).toMatch(/WebTrace/i)
    expect(warnSpy.mock.calls[2][1]).toBe(errors[2])
    expect(withContextSpy.mock.calls.filter((c) => c[0] === 'Bootstrap').length).toBe(1)
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
    vi.resetModules()
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
    vi.doMock('./services/StoreSyncService', () => ({ default: { subscribe: storeSyncThrow } }))
    vi.doMock('./services/topicDeletionSubscription', () => ({ subscribeTopicDeletionEvents: topicMock }))
    vi.doMock('./services/WebTraceService', () => ({ webTraceService: { init: webTraceMock } }))
    vi.doMock('./services/residentRetention', () => ({ startResidentRetention: vi.fn() }))
    vi.doMock('./store', () => ({ default: { getState: vi.fn(() => ({ settings: {}, nutstore: {} })) } }))
    vi.doMock('./services/BackupService', () => ({ startAutoSync: vi.fn() }))
    vi.doMock('./services/NutstoreService', () => ({ startNutstoreAutoSync: vi.fn() }))
    const { loggerService } = await import('@logger')
    const warnSpy = vi.fn()
    vi.spyOn(loggerService, 'withContext').mockImplementation(
      () => ({ warn: warnSpy, info: vi.fn(), error: vi.fn(), debug: vi.fn(), silly: vi.fn() }) as any
    )
    if (!(global as any).window) (global as any).window = {}
    let threw = false
    try {
      await import('./init')
      // second microtask flush to ensure no async throw
      await Promise.resolve()
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(events).toEqual(['StoreSync:throw', 'TopicDeletion', 'WebTrace'])
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
    vi.resetModules()
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
    vi.doMock('./services/StoreSyncService', () => ({ default: { subscribe: storeSyncThrow } }))
    vi.doMock('./services/topicDeletionSubscription', () => ({ subscribeTopicDeletionEvents: topicMock }))
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
    await import('./init')
    await Promise.resolve()
    await Promise.resolve()
    const bootstrapCalls = withContextSpy.mock.calls.filter((c) => c[0] === 'Bootstrap')
    expect(bootstrapCalls.length).toBe(1)
    expect(unhandled.length).toBe(0)
  })
})
