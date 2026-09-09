/**
 * Channel-protocol closure regressions (SYNC-CC-*, Main lane):
 * - Accept reconciles the observed channel atomically: success records the
 *   new channel with a cursor reset; transport or late-paired failures leave
 *   local channel observation untouched (no partial switch, no merge).
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

describe('channel accept reconciles cursor atomically under failure', () => {
  it('accept success records the channel; accept failure leaves observation untouched', async () => {
    const { syncClient } = await import('../SyncClient')
    const db = chatDbService.getDatabase()
    db.insert(schema.syncState).values({ key: 'sync:channelKey', value: 'ch-old' }).run()
    db.insert(schema.syncState).values({ key: 'cursor', value: '6' }).run()
    vi.spyOn(syncClient, 'acceptPairing').mockRejectedValueOnce(new Error('fetch failed'))
    await expect(syncService.acceptPairing('req-1')).rejects.toThrow(/fetch failed/)
    expect(syncService.getChannelKey()).toBe('ch-old')
    const kept = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
    expect(kept?.value).toBe('6')
    vi.spyOn(syncClient, 'acceptPairing').mockResolvedValueOnce({ channelId: 'ch-new' })
    const ok = await syncService.acceptPairing('req-1')
    expect(ok.channelId).toBe('ch-new')
    expect(syncService.getChannelKey()).toBe('ch-new')
    const reset = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
    expect(reset?.value).toBe('0')
  })

  it('late-paired accept failure changes no local observation', async () => {
    const { syncClient } = await import('../SyncClient')
    const db = chatDbService.getDatabase()
    db.insert(schema.syncState).values({ key: 'sync:channelKey', value: 'ch-old' }).run()
    db.insert(schema.syncState).values({ key: 'cursor', value: '3' }).run()
    vi.spyOn(syncClient, 'acceptPairing').mockRejectedValueOnce(
      new Error('sync request failed 409: {"error":"requester-already-paired"}')
    )
    await expect(syncService.acceptPairing('req-late')).rejects.toThrow(/requester-already-paired/)
    expect(syncService.getChannelKey()).toBe('ch-old')
    const kept = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
    expect(kept?.value).toBe('3')
  })
})
