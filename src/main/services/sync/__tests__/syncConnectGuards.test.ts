/**
 * SYNC-CC review findings 4-7 (Main lane):
 * 4) connect() async boundaries are guarded by config/lifecycle generation,
 *    shutdown, explicitDisconnect, and endpoint/token snapshot; stale results
 *    never write credential/status/channel/cursor.
 * 5) Device code + secret persist as one atomic logical unit with rollback;
 *    half state fails closed and the secret never travels on the error object.
 * 6) Legacy reset critical cleanup never swallows then marks complete;
 *    failures leave the marker unset for retry with an explicit error.
 * 7) SSE/relay disconnect promptly marks observed service state disconnected
 *    without import cycles; a successful authenticated round-trip restores it.
 */
import { randomBytes } from 'node:crypto'

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
    set: (k: string, v: unknown) => configStore.set(k, v),
    has: (k: string) => configStore.has(k)
  },
  ConfigKeys: {}
}))

import { chatDbService } from '../../chatDb'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { syncService } from '../SyncService'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

function freshSecret(): string {
  return randomBytes(32).toString('hex')
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', 'http://127.0.0.1:3999')
  configStore.set('sync:token', 'test-token')
  sqlite = openInMemory()
  db = drizzle(sqlite, { schema })
  runMigrations(db as never, sqlite)
  ;(chatDbService as never as { sqlite: unknown }).sqlite = sqlite
  ;(chatDbService as never as { db: unknown }).db = db
  syncService.clearAllForTests()
  syncService.resetShutdownForTests()
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
  try {
    sqlite.close()
  } catch {}
  ;(chatDbService as never as { sqlite: unknown }).sqlite = null
  ;(chatDbService as never as { db: unknown }).db = null
})

describe('connect async-boundary guards', () => {
  it('stale endpoint result never writes credential/channel/cursor', async () => {
    configStore.delete('sync:deviceCode')
    configStore.delete('sync:deviceAuth')
    const { syncClient } = await import('../SyncClient')
    const gate = deferred<{ deviceCode: string; deviceSecret?: string }>()
    vi.spyOn(syncClient, 'register').mockReturnValue(gate.promise)
    const pending = syncService.connect()
    // Expire the endpoint while the register round-trip is in flight.
    configStore.set('sync:endpoint', 'http://127.0.0.1:4001')
    syncService.invalidateForConfigChange()
    gate.resolve({ deviceCode: 'WXYZ5678', deviceSecret: freshSecret() })
    const err = await pending.then(
      () => null,
      (e: unknown) => e as Error
    )
    expect(err).not.toBeNull()
    expect(String((err as Error)?.name)).toMatch(/SyncStaleConfigError/)
    expect(configStore.get('sync:deviceCode') ?? null).toBeFalsy()
    expect(configStore.get('sync:deviceAuth') ?? null).toBeFalsy()
    expect(syncService.getChannelKey()).toBeNull()
  })

  it('explicit disconnect during connect aborts without credential write', async () => {
    configStore.delete('sync:deviceCode')
    configStore.delete('sync:deviceAuth')
    const { syncClient } = await import('../SyncClient')
    const gate = deferred<{ deviceCode: string; deviceSecret?: string }>()
    vi.spyOn(syncClient, 'register').mockReturnValue(gate.promise)
    const pending = syncService.connect()
    await syncService.disconnect()
    gate.resolve({ deviceCode: 'WXYZ5678', deviceSecret: freshSecret() })
    const err = await pending.then(
      () => null,
      (e: unknown) => e as Error
    )
    expect(err).not.toBeNull()
    expect(configStore.get('sync:deviceAuth') ?? null).toBeFalsy()
  })

  it('code+secret persist atomically: secret failure rolls back the code', async () => {
    configStore.delete('sync:deviceCode')
    configStore.delete('sync:deviceAuth')
    const { syncClient } = await import('../SyncClient')
    const issued = freshSecret()
    const registerSpy = vi
      .spyOn(syncClient, 'register')
      .mockResolvedValue({ deviceCode: 'WXYZ5678', deviceSecret: issued })
    const { configManager } = await import('@main/services/ConfigManager')
    const origSet = configManager.set
    vi.spyOn(configManager, 'set').mockImplementation(((k: string, v: unknown) => {
      // Target only the registration secret write: the pairing-generation
      // reset clears with '' and must keep working so the failure under test
      // is the atomic code+secret persist, not the pre-step.
      if (k === 'sync:deviceAuth' && v !== '') throw new Error('injected secret persist failure')
      return (origSet as (kk: string, vv: unknown) => void)(k, v)
    }) as never)
    const err = (await syncService.connect().then(
      () => null,
      (e: unknown) => e
    )) as (Error & { deviceSecret?: unknown }) | null
    expect(err).not.toBeNull()
    // Secret minimal surface: the production error never carries the secret.
    expect((err as { deviceSecret?: unknown })?.deviceSecret).toBeUndefined()
    expect(String(err?.message)).not.toContain(issued)
    // Rollback: no half code survives; registration state has no half-finished record.
    expect(configStore.get('sync:deviceCode') ?? '').toBe('')
    expect(configStore.get('sync:deviceAuth') ?? '').toBe('')
    expect(syncService.getDeviceCodeOrNull()).toBeNull()
    expect(syncService.getServiceStatus().state).toBe('unregistered')
    // No silent credential-less registration: auto gate stays closed.
    expect(syncService.getAutoCredentials()).toBeNull()
    expect(syncService.isAutoSyncAllowed()).toBe(false)
    expect(registerSpy).toHaveBeenCalledTimes(1)
    // Retry with restored persistence re-registers via transport (never silently attaches).
    vi.restoreAllMocks()
    const retrySecret = freshSecret()
    expect(retrySecret).not.toBe(issued)
    vi.spyOn(syncClient, 'register').mockResolvedValue({ deviceCode: 'WXYZ5678', deviceSecret: retrySecret })
    const retryStatus = await syncService.connect()
    expect(retryStatus.state).toBe('connected')
    expect(configStore.get('sync:deviceCode')).toBe('WXYZ5678')
    expect(configStore.get('sync:deviceAuth')).toBe(retrySecret)
    expect(syncService.getAutoCredentials()).toMatchObject({ deviceCode: 'WXYZ5678', deviceSecret: retrySecret })
  })

  it('legacy reset failure leaves the marker unset for retry', async () => {
    // Force a fresh legacy path: no marker, no registration.
    configStore.delete('sync:deviceCode')
    configStore.delete('sync:deviceAuth')
    // Sabotage the cursor cleanup once via a closed DB proxy is complex;
    // instead sabotage config persistence to prove fail-closed + retry.
    const { configManager } = await import('@main/services/ConfigManager')
    const origSet = configManager.set
    let failOnce = true
    vi.spyOn(configManager, 'set').mockImplementation(((k: string, v: unknown) => {
      if (failOnce && (k === 'sync:deviceAuth' || k === 'sync:deviceCode')) {
        failOnce = false
        throw new Error('injected reset persist failure')
      }
      return (origSet as (kk: string, vv: unknown) => void)(k, v)
    }) as never)
    const firstErr = (() => {
      try {
        syncService.getServiceStatus()
        return null
      } catch (e) {
        return e as Error
      }
    })()
    // Fail closed: the reset failure throws (never disguised as an ordinary
    // unregistered/disconnected state) and stays observable via lastError.
    expect(firstErr).not.toBeNull()
    expect(String(firstErr?.message)).toMatch(/reset failed|pairing reset/i)
    const markerRow = db
      .select()
      .from(schema.syncState)
      .where((await import('drizzle-orm')).eq(schema.syncState.key, 'sync:pairingGeneration'))
      .get()
    // First attempt failed before the marker: retry must succeed explicitly.
    expect(markerRow?.value ?? null).not.toBe('cc-1')
    vi.restoreAllMocks()
    const status = syncService.getServiceStatus()
    expect(['unregistered', 'disconnected']).toContain(status.state)
    const markerRow2 = db
      .select()
      .from(schema.syncState)
      .where((await import('drizzle-orm')).eq(schema.syncState.key, 'sync:pairingGeneration'))
      .get()
    expect(markerRow2?.value).toBe('cc-1')
  })

  it('relay disconnect marks disconnected; successful round-trip restores', async () => {
    configStore.set('sync:deviceCode', 'ABCD2345')
    configStore.set('sync:deviceAuth', freshSecret())
    const { syncClient } = await import('../SyncClient')
    vi.spyOn(syncClient, 'getPairState').mockResolvedValue({
      deviceCode: 'ABCD2345',
      paired: false,
      channelId: null,
      outgoing: null,
      incoming: []
    })
    await syncService.connect()
    expect(syncService.getServiceStatus().state).toBe('connected')
    syncService.notifyRelayDisconnect(new Error('fetch failed'))
    expect(syncService.getServiceStatus().state).toBe('disconnected')
    await syncService.connect()
    expect(syncService.getServiceStatus().state).toBe('connected')
  })
})
