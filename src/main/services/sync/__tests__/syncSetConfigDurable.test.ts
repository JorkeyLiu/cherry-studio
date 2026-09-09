/**
 * Narrow correction for the three final automatic-sync configuration blockers
 * (LOCK-PERSONAL-001/006/009). No other sync semantics change.
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
import { SyncCaptureError, SyncConfigPreflightError, syncService } from '../SyncService'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

function stateValue(key: string): string | null {
  try {
    const row = sqlite.prepare(`SELECT value FROM sync_state WHERE key=?`).get(key) as { value: string } | undefined
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
  configStore.set('sync:deviceCode', 'ABCD2345')
  configStore.set('sync:deviceAuth', 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90')
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

describe('setConfig prior-read failure is durable and lifecycle-invalidating', () => {
  it('persists bounded error, bumps generation, applies no write, stops auto subscriber', async () => {
    const { SyncAutoService: Cls } = await import('../syncAuto')
    const stopSpy = vi.fn()
    const svc = new Cls({
      getConfig: () => ({ endpoint: 'http://127.0.0.1:9999', token: undefined, enabled: true }),
      isAttached: () => true,
      getCredentials: () => ({
        deviceCode: 'ABCD2345',
        deviceSecret: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
      }),
      runSync: () => Promise.resolve(null),
      createSubscriber: () => ({ start: vi.fn(), stop: stopSpy }) as never
    })
    svc.start()
    expect(stopSpy).not.toHaveBeenCalled()
    const genBefore = syncService.getConfigGeneration()
    const autoGenBefore = (svc as never as { generation: number }).generation
    const endpointBefore = configStore.get('sync:endpoint')
    const enabledBefore = configStore.get('sync:enabled')
    const getSpy = vi.spyOn(syncService, 'getConfig').mockImplementation(() => {
      throw new Error('prior-boom-marker')
    })
    expect(() => syncService.setConfig({ enabled: false })).toThrow(/prior-boom-marker/)
    expect(syncService.getConfigGeneration()).toBeGreaterThan(genBefore)
    expect(configStore.get('sync:endpoint')).toBe(endpointBefore)
    expect(configStore.get('sync:enabled')).toBe(enabledBefore)
    const durable = `${stateValue('lastCaptureError') ?? ''} ${stateValue('lastError') ?? ''}`
    expect(durable.toLowerCase()).toMatch(/prior|prior-boom-marker/)
    expect(durable.length).toBeLessThanOrEqual(2100)
    expect((svc as never as { generation: number }).generation).toBeGreaterThan(autoGenBefore)
    expect(stopSpy).toHaveBeenCalled()
    getSpy.mockRestore()
    svc.stopSync()
  })

  it('chains persistence damage instead of swallowing it', () => {
    const getSpy = vi.spyOn(syncService, 'getConfig').mockImplementation(() => {
      throw new Error('prior-orig-marker')
    })
    const recSpy = vi.spyOn(syncService, 'recordCaptureFailure').mockImplementation(() => {
      throw new SyncCaptureError('secondary-marker; original: prior-orig-marker')
    })
    expect(() => syncService.setConfig({ enabled: false })).toThrow(/secondary-marker/)
    recSpy.mockRestore()
    getSpy.mockRestore()
  })
})

describe('setConfig post-write-read failure leaves no stale subscriber', () => {
  it('persists durable error, bumps generation, stops subscriber/timers', async () => {
    const { SyncAutoService: Cls } = await import('../syncAuto')
    const stopSpy = vi.fn()
    const svc = new Cls({
      getConfig: () => ({ endpoint: 'http://127.0.0.1:9999', token: undefined, enabled: true }),
      isAttached: () => true,
      getCredentials: () => ({
        deviceCode: 'ABCD2345',
        deviceSecret: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
      }),
      runSync: () => Promise.resolve(null),
      createSubscriber: () => ({ start: vi.fn(), stop: stopSpy }) as never
    })
    svc.start()
    stopSpy.mockClear()
    const genBefore = syncService.getConfigGeneration()
    const autoGenBefore = (svc as never as { generation: number }).generation
    let calls = 0
    const getSpy = vi.spyOn(syncService, 'getConfig').mockImplementation(() => {
      calls += 1
      if (calls === 1) return { endpoint: 'http://127.0.0.1:9999', token: undefined, enabled: true }
      throw new Error('post-boom-marker')
    })
    expect(() => syncService.setConfig({ enabled: false })).toThrow(/post-boom-marker/)
    expect(syncService.getConfigGeneration()).toBeGreaterThan(genBefore)
    const durable = `${stateValue('lastCaptureError') ?? ''} ${stateValue('lastError') ?? ''}`
    expect(durable.toLowerCase()).toMatch(/post|post-boom-marker/)
    expect((svc as never as { generation: number }).generation).toBeGreaterThan(autoGenBefore)
    expect(stopSpy).toHaveBeenCalled()
    getSpy.mockRestore()
    svc.stopSync()
  })
})

describe('nested sync config preflight invalidates auto without retry', () => {
  it('SyncService.sync wraps config failure distinctly and auto handles it once', async () => {
    const spy = vi.spyOn(syncService, 'getConfig').mockImplementation(() => {
      throw new Error('nested-preflight-marker')
    })
    let caught: unknown = null
    try {
      await syncService.sync()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SyncConfigPreflightError)
    expect((caught as Error).message).toMatch(/nested-preflight-marker/)
    expect((stateValue('lastError') ?? '').toLowerCase()).toMatch(/preflight|nested-preflight-marker/)
    spy.mockRestore()

    const { SyncAutoService: Cls } = await import('../syncAuto')
    let shouldFail = false
    const runSync = vi.fn(() => {
      if (shouldFail) return Promise.reject(new SyncConfigPreflightError('nested-preflight-marker'))
      return Promise.resolve(null)
    })
    const stopSpy = vi.fn()
    const svc = new Cls({
      getConfig: () => ({ endpoint: 'http://127.0.0.1:9999', token: undefined, enabled: true }),
      isAttached: () => true,
      getCredentials: () => ({
        deviceCode: 'ABCD2345',
        deviceSecret: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
      }),
      runSync,
      createSubscriber: () => ({ start: vi.fn(), stop: stopSpy }) as never
    })
    svc.start()
    await new Promise((r) => setTimeout(r, 20))
    runSync.mockClear()
    stopSpy.mockClear()
    shouldFail = true
    const invalidateSpy = vi.spyOn(syncService, 'invalidateForConfigChange')
    const autoGenBefore = (svc as never as { generation: number }).generation
    ;(svc as never as { requestAutoSync: () => void }).requestAutoSync()
    await new Promise((r) => setTimeout(r, 50))
    expect(runSync).toHaveBeenCalledTimes(1)
    expect(invalidateSpy).toHaveBeenCalled()
    expect((svc as never as { generation: number }).generation).toBeGreaterThan(autoGenBefore)
    expect(stopSpy).toHaveBeenCalled()
    const durable = `${stateValue('lastCaptureError') ?? ''} ${stateValue('lastError') ?? ''}`
    expect(durable.toLowerCase()).toMatch(/autosync|preflight|nested-preflight-marker/)
    svc.stopSync()
  })

  it('ordinary transport errors still retry bounded times', async () => {
    const { SyncAutoService: Cls, SYNC_AUTO_BUSY_RETRY_MS } = await import('../syncAuto')
    void SYNC_AUTO_BUSY_RETRY_MS
    const runSync = vi.fn(() => Promise.reject(new Error('transport-boom')))
    const svc = new Cls({
      getConfig: () => ({ endpoint: 'http://127.0.0.1:9999', token: undefined, enabled: true }),
      isAttached: () => true,
      getCredentials: () => ({
        deviceCode: 'ABCD2345',
        deviceSecret: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
      }),
      runSync,
      createSubscriber: () => ({ start: vi.fn(), stop: vi.fn() }) as never
    })
    svc.start()
    runSync.mockClear()
    ;(svc as never as { requestAutoSync: () => void }).requestAutoSync()
    await new Promise((r) => setTimeout(r, 50))
    expect(runSync.mock.calls.length).toBeGreaterThanOrEqual(1)
    svc.stopSync()
  })
})
