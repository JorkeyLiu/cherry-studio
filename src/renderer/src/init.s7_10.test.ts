import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('init.ts S7.10 — bootstrap topology and Keyv init — post-bootstrap with immediate correctness and bounded logging', () => {
  const unhandled: unknown[] = []
  const handler = (r: unknown) => unhandled.push(r)
  const events: string[] = []

  beforeEach(() => {
    unhandled.length = 0
    events.length = 0
    if (typeof process !== 'undefined' && (process as any).on) (process as any).on('unhandledRejection', handler)
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
    events.length = 0
    try {
      // cleanup window stub if created
      if ((global as any).window?.keyv) delete (global as any).window.keyv
    } catch {}
  })

  it('does not statically import initScrollSnapshotCache (source-level)', () => {
    const initPath = path.join(process.cwd(), 'src/renderer/src/init.ts')
    const content = fs.readFileSync(initPath, 'utf-8')
    expect(content).not.toMatch(/initScrollSnapshotCache/)
    expect(content).toMatch(/scheduleScrollSnapshotStartupSweep/)
    expect(content).toMatch(/scheduleScrollSnapshotStartupSweep\(\)/)
  })

  it('bootstrap calls scheduleScrollSnapshotStartupSweep and not immediate init, Keyv init order and rejection bounded', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    events.length = 0

    const initMock = vi.fn(() => {
      events.push('initScrollSnapshotCache')
    })
    const scheduleMock = vi.fn(() => {
      events.push('schedule')
    })

    vi.doMock('@kangfenmao/keyv-storage', () => ({
      default: class {
        constructor() {
          events.push('keyv:create')
        }

        init() {
          events.push('keyv:init')
          return Promise.reject(new Error('keyv init boom'))
        }
      }
    }))
    vi.doMock('./services/scrollSnapshotCache', () => ({
      initScrollSnapshotCache: initMock,
      scheduleScrollSnapshotStartupSweep: scheduleMock
    }))
    vi.doMock('./config/title', () => ({ applyMainWindowTitle: vi.fn() }))
    vi.doMock('./services/StoreSyncService', () => ({ default: { subscribe: vi.fn() } }))
    vi.doMock('./services/topicDeletionSubscription', () => ({ subscribeTopicDeletionEvents: vi.fn() }))
    vi.doMock('./services/WebTraceService', () => ({ webTraceService: { init: vi.fn() } }))
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
    await Promise.resolve()
    await Promise.resolve()

    expect(events).toEqual(['keyv:create', 'keyv:init', 'schedule'])
    expect(scheduleMock).toHaveBeenCalledTimes(1)
    expect(initMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    expect(warnSpy).toHaveBeenCalled()
    const warnMsg = String(warnSpy.mock.calls[0]?.[0] ?? '')
    expect(warnMsg).toMatch(/keyv init/i)
    expect(unhandled.length).toBe(0)

    withContextSpy.mockRestore()
  })

  it('Keyv init resolves still schedules sweep without warn', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    events.length = 0

    const scheduleMock = vi.fn(() => {
      events.push('schedule')
    })
    const initMock = vi.fn(() => {
      events.push('initScrollSnapshotCache')
    })

    vi.doMock('@kangfenmao/keyv-storage', () => ({
      default: class {
        constructor() {
          events.push('keyv:create')
        }

        init() {
          events.push('keyv:init')
          return Promise.resolve()
        }
      }
    }))
    vi.doMock('./services/scrollSnapshotCache', () => ({
      initScrollSnapshotCache: initMock,
      scheduleScrollSnapshotStartupSweep: scheduleMock
    }))
    vi.doMock('./config/title', () => ({ applyMainWindowTitle: vi.fn() }))
    vi.doMock('./services/StoreSyncService', () => ({ default: { subscribe: vi.fn() } }))
    vi.doMock('./services/topicDeletionSubscription', () => ({ subscribeTopicDeletionEvents: vi.fn() }))
    vi.doMock('./services/WebTraceService', () => ({ webTraceService: { init: vi.fn() } }))
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

    expect(events).toEqual(['keyv:create', 'keyv:init', 'schedule'])
    expect(scheduleMock).toHaveBeenCalledTimes(1)
    expect(initMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    expect(warnSpy).not.toHaveBeenCalled()
    expect(unhandled.length).toBe(0)

    withContextSpy.mockRestore()
  })
})
