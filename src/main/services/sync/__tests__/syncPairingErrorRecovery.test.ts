/**
 * Registration/pairing error recovery (SYNC-CC-004/008/011, Main lane):
 * - Connect transport failure is durable (lastError) with service
 *   disconnected and no partial registration.
 * - Retry after recovery re-attaches; unknown-credential stays fail-closed.
 * - Unpair failure preserves channel observation (no cursor wipe on error).
 */
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
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
import { seedRegisteredAttachedSyncService } from './helpers/syncTestRegistration'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
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
  seedRegisteredAttachedSyncService(configStore, db)
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

describe('connect error recovery', () => {
  it('transport failure is durable with service disconnected and no rotation', async () => {
    configStore.delete('sync:deviceCode')
    configStore.delete('sync:deviceAuth')
    const { syncClient } = await import('../SyncClient')
    vi.spyOn(syncClient, 'register').mockRejectedValue(new Error('fetch failed'))
    const err = await syncService.connect().then(
      () => null,
      (e: unknown) => e as Error
    )
    expect(err).not.toBeNull()
    // Persistent empty-string sentinel + getter normalization: no partial
    // registration survives (code null, secret undefined), regardless of
    // whether the store holds '' or a deleted key.
    expect(configStore.get('sync:deviceCode') ?? '').toBe('')
    expect(configStore.get('sync:deviceAuth') ?? '').toBe('')
    expect(syncService.getDeviceCodeOrNull()).toBeNull()
    expect(syncService.getDeviceAuth()).toBeUndefined()
    expect(syncService.getServiceStatus().state).not.toBe('connected')
    expect(String(syncService.getStatus().lastError)).toMatch(/fetch failed/)
  })

  it('retry after recovery registers; later unknown-credential stays fail-closed', async () => {
    configStore.delete('sync:deviceCode')
    configStore.delete('sync:deviceAuth')
    const { syncClient } = await import('../SyncClient')
    const registerSpy = vi.spyOn(syncClient, 'register')
    registerSpy.mockRejectedValueOnce(new Error('fetch failed'))
    await expect(syncService.connect()).rejects.toThrow(/fetch failed/)
    registerSpy.mockResolvedValueOnce({
      deviceCode: 'WXYZ5678',
      deviceSecret: 'c1b2c3d4e5f60718293a4b5c6d7e8f90c1b2c3d4e5f60718293a4b5c6d7e8f90'
    })
    const status = await syncService.connect()
    expect(status.state).toBe('connected')
    expect(status.deviceCode).toBe('WXYZ5678')
    // A later re-attach with a wiped relay (unknown credential) fails closed
    // without silently re-registering.
    vi.spyOn(syncClient, 'getPairState').mockRejectedValue(
      new Error('sync request failed 403: {"error":"unknown-credential"}')
    )
    await expect(syncService.connect()).rejects.toThrow(/unknown-credential/)
    expect(registerSpy).toHaveBeenCalledTimes(2)
    expect(configStore.get('sync:deviceCode')).toBe('WXYZ5678')
  })
})

describe('unpair failure preserves observation', () => {
  it('failed unpair keeps channel key and cursor', async () => {
    const { syncClient } = await import('../SyncClient')
    db.insert(schema.syncState).values({ key: 'sync:channelKey', value: 'ch-keep' }).run()
    db.insert(schema.syncState).values({ key: 'cursor', value: '5' }).run()
    vi.spyOn(syncClient, 'unpair').mockRejectedValue(new Error('fetch failed'))
    await expect(syncService.unpair()).rejects.toThrow(/fetch failed/)
    expect(syncService.getChannelKey()).toBe('ch-keep')
    const cursorRow = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
    expect(cursorRow?.value).toBe('5')
    // Registration is untouched by the failure.
    expect(configStore.get('sync:deviceCode')).toBe('ABCD2345')
  })
})
