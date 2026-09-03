/**
 * Focused regressions for automatic-sync config-read fail-closed handling
 * (LOCK-PERSONAL-001/006/009). Narrow scope: requestAutoSync failure,
 * reconciliation failure, and setConfig prior-read failure. No other sync
 * semantics change, no final-validation claim.
 */
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')
vi.mock('@main/config', () => ({ DATA_PATH: '/tmp' }))

const configStore = new Map<string, unknown>()
vi.mock('@main/services/ConfigManager', () => ({
  configManager: {
    get: (k: string, def?: unknown) => (configStore.has(k) ? configStore.get(k) : def),
    set: (k: string, v: unknown) => configStore.set(k, v)
  },
  ConfigKeys: {}
}))

import { chatDbService } from '../../chatDb'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { SyncCaptureError } from '../SyncService'
import { syncService } from '../SyncService'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

function lastErrorValue(): string | null {
  try {
    const row = sqlite.prepare(`SELECT value FROM sync_state WHERE key='lastError'`).get() as
      | { value: string }
      | undefined
    return row?.value ?? null
  } catch {
    return null
  }
}

function lastCaptureErrorValue(): string | null {
  try {
    const row = sqlite.prepare(`SELECT value FROM sync_state WHERE key='lastCaptureError'`).get() as
      | { value: string }
      | undefined
    return row?.value ?? null
  } catch {
    return null
  }
}

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
  configStore.set('sync:token', '')
  sqlite = openInMemory()
  db = drizzle(sqlite, { schema })
  runMigrations(db as never, sqlite)
  ;(chatDbService as never as { sqlite: unknown }).sqlite = sqlite
  ;(chatDbService as never as { db: unknown }).db = db
  syncService.clearAllForTests()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  try {
    sqlite.close()
  } catch {}
  ;(chatDbService as never as { sqlite: unknown }).sqlite = null
  ;(chatDbService as never as { db: unknown }).db = null
})

describe('requestAutoSync config-read failure is visible and invalidates stale work', () => {
  it('logs + persists durable error, invalidates generations, stops subscriber, never runs sync', async () => {
    const { SyncAutoService: Cls } = await import('../syncAuto')
    const valid = () => ({ endpoint: 'http://127.0.0.1:9999', token: undefined as string | undefined, enabled: true })
    const runSync = vi.fn(() => Promise.resolve(null))
    const stopSpy = vi.fn()
    const fakeSubscriber = { start: vi.fn(), stop: stopSpy }
    const svc = new Cls({
      getConfig: valid,
      runSync,
      createSubscriber: () => fakeSubscriber as never
    })
    svc.start()
    expect(fakeSubscriber.start).toHaveBeenCalled()
    runSync.mockClear()
    stopSpy.mockClear()

    const invalidateSpy = vi.spyOn(syncService, 'invalidateForConfigChange')
    const captureSpy = vi.spyOn(syncService, 'recordCaptureFailure')
    const genBefore = syncService.getConfigGeneration()
    // Fail the next automatic config read only.
    ;(svc as never as { deps: { getConfig: () => unknown } }).deps.getConfig = () => {
      throw new Error('auto-config-boom')
    }
    const autoGenBefore = (svc as never as { generation: number }).generation
    ;(svc as never as { requestAutoSync: () => void }).requestAutoSync()
    expect(runSync).not.toHaveBeenCalled()
    expect(captureSpy).toHaveBeenCalledWith('syncAuto:requestAutoSync', expect.any(Error))
    expect(invalidateSpy).toHaveBeenCalled()
    expect((svc as never as { generation: number }).generation).toBeGreaterThan(autoGenBefore)
    expect(syncService.getConfigGeneration()).toBeGreaterThan(genBefore)
    expect(stopSpy).toHaveBeenCalled()
    const durable = `${lastCaptureErrorValue() ?? ''} ${lastErrorValue() ?? ''}`
    expect(durable.toLowerCase()).toMatch(/requestautosync|auto-config-boom/)
    svc.stopSync()
  })

  it('rethrows when durable reporting is damaged, preserving the original error', async () => {
    const { SyncAutoService: Cls } = await import('../syncAuto')
    const svc = new Cls({
      getConfig: () => ({ endpoint: 'http://127.0.0.1:9999', token: undefined, enabled: true }),
      runSync: () => Promise.resolve(null),
      createSubscriber: () => ({ start: vi.fn(), stop: vi.fn() }) as never
    })
    svc.start()
    ;(svc as never as { deps: { getConfig: () => unknown } }).deps.getConfig = () => {
      throw new Error('auto-orig-boom')
    }
    const recSpy = vi.spyOn(syncService, 'recordCaptureFailure').mockImplementation(() => {
      throw new SyncCaptureError('secondary-boom; original: auto-orig-boom')
    })
    expect(() => (svc as never as { requestAutoSync: () => void }).requestAutoSync()).toThrow(/secondary-boom/)
    svc.stopSync()
    recSpy.mockRestore()
  })
})

describe('reconciliation config-read failure is visible and invalidates stale work', () => {
  it('interval failure persists durable error and invalidates without running sync', async () => {
    vi.useFakeTimers()
    const { SyncAutoService: Cls } = await import('../syncAuto')
    const runSync = vi.fn(() => Promise.resolve(null))
    const stopSpy = vi.fn()
    const fakeSubscriber = { start: vi.fn(), stop: stopSpy }
    const svc = new Cls({
      getConfig: () => ({ endpoint: 'http://127.0.0.1:9999', token: undefined, enabled: true }),
      runSync,
      createSubscriber: () => fakeSubscriber as never
    })
    svc.start()
    runSync.mockClear()
    const invalidateSpy = vi.spyOn(syncService, 'invalidateForConfigChange')
    const captureSpy = vi.spyOn(syncService, 'recordCaptureFailure')
    const genBefore = syncService.getConfigGeneration()
    const autoGenBefore = (svc as never as { generation: number }).generation
    ;(svc as never as { deps: { getConfig: () => unknown } }).deps.getConfig = () => {
      throw new Error('reconcile-config-boom')
    }
    await vi.advanceTimersByTimeAsync(30000)
    expect(captureSpy).toHaveBeenCalledWith('syncAuto:reconcile', expect.any(Error))
    expect(invalidateSpy).toHaveBeenCalled()
    expect((svc as never as { generation: number }).generation).toBeGreaterThan(autoGenBefore)
    expect(syncService.getConfigGeneration()).toBeGreaterThan(genBefore)
    expect(runSync).not.toHaveBeenCalled()
    const durable = `${lastCaptureErrorValue() ?? ''} ${lastErrorValue() ?? ''}`
    expect(durable.toLowerCase()).toMatch(/reconcile|reconcile-config-boom/)
    svc.stopSync()
  })
})

describe('setConfig prior config-read failure never uses a fabricated snapshot', () => {
  it('rethrows original, bumps generation, and applies no update', () => {
    const genBefore = syncService.getConfigGeneration()
    const endpointBefore = configStore.get('sync:endpoint')
    const enabledBefore = configStore.get('sync:enabled')
    const getSpy = vi.spyOn(syncService, 'getConfig').mockImplementation(() => {
      throw new Error('prior-config-boom')
    })
    expect(() => syncService.setConfig({ enabled: false })).toThrow(/prior-config-boom/)
    expect(syncService.getConfigGeneration()).toBe(genBefore + 1)
    // No update applied while the previous snapshot was unknowable.
    expect(configStore.get('sync:endpoint')).toBe(endpointBefore)
    expect(configStore.get('sync:enabled')).toBe(enabledBefore)
    getSpy.mockRestore()
  })

  it('post-write read failure invalidates conservatively instead of comparing against a guess', () => {
    const genBefore = syncService.getConfigGeneration()
    let calls = 0
    const getSpy = vi.spyOn(syncService, 'getConfig').mockImplementation(() => {
      calls += 1
      if (calls === 1) return { endpoint: 'http://127.0.0.1:9999', token: undefined, enabled: true }
      throw new Error('post-config-boom')
    })
    expect(() => syncService.setConfig({ enabled: false })).toThrow(/post-config-boom/)
    expect(syncService.getConfigGeneration()).toBe(genBefore + 1)
    getSpy.mockRestore()
  })
})
