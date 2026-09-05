/**
 * Eighth-audit regressions: five reliability-boundary blockers.
 * - Identity continuity: missing config repairs from durable DB (no overwrite).
 * - Mismatched valid identities fail closed.
 * - Present NULL/empty/malformed durable identity fails closed (no fallback).
 * - Missing migration_state table is damage (fail closed), not pre-migration proof.
 * - Config-read secondary capture failure stays observable (throw, no empty catch).
 * - Relay strict cursor framing rejects 12junk/07 before DB access (400).
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

import { IpcChannel } from '@shared/IpcChannel'
import { eq } from 'drizzle-orm'

import { createRelayServer } from '../../../../../scripts/sync-relay/server'
import { chatDbService } from '../../chatDb'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { handleChatDbSuccessForSync } from '../chatDbHook'
import { SyncCaptureError, syncService } from '../SyncService'

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
  vi.restoreAllMocks()
  try {
    sqlite.close()
  } catch {}
  ;(chatDbService as never as { sqlite: unknown }).sqlite = null
  ;(chatDbService as never as { db: unknown }).db = null
})

describe('identity continuity: missing config repairs from durable', () => {
  it('does not overwrite a valid durable DB identity with a fresh UUID', () => {
    const durable = 'durable-identity-keep'
    db.insert(schema.syncState)
      .values({ key: 'deviceId', value: durable })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: durable } })
      .run()
    configStore.delete('deviceId')
    const id = syncService.getDeviceId()
    expect(id).toBe(durable)
    expect(configStore.get('deviceId')).toBe(durable)
    const row = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'deviceId')).get()
    expect(row?.value).toBe(durable)
  })

  it('mismatched valid identities fail closed instead of choosing one', () => {
    db.insert(schema.syncState)
      .values({ key: 'deviceId', value: 'durable-B' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: 'durable-B' } })
      .run()
    configStore.set('deviceId', 'config-A')
    expect(() => syncService.getDeviceId()).toThrow(/mismatch|device identity/i)
  })

  it('generates only when both stores prove absence', () => {
    configStore.delete('deviceId')
    sqlite.exec("DELETE FROM sync_state WHERE key = 'deviceId'")
    const id = syncService.getDeviceId()
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
    expect(configStore.get('deviceId')).toBe(id)
    const row = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'deviceId')).get()
    expect(row?.value).toBe(id)
  })
})

describe('durable NULL/empty/malformed identity fails closed', () => {
  it('NULL durable value throws instead of falling back to config', () => {
    db.insert(schema.syncState)
      .values({ key: 'deviceId', value: 'seed' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: 'seed' } })
      .run()
    sqlite.prepare("UPDATE sync_state SET value = NULL WHERE key = 'deviceId'").run()
    configStore.set('deviceId', 'config-fallback')
    expect(() => syncService.getDeviceId()).toThrow(/device identity/i)
  })

  it('empty durable value throws instead of falling back to config', () => {
    db.insert(schema.syncState)
      .values({ key: 'deviceId', value: 'seed' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: 'seed' } })
      .run()
    sqlite.prepare("UPDATE sync_state SET value = '' WHERE key = 'deviceId'").run()
    configStore.set('deviceId', 'config-fallback')
    expect(() => syncService.getDeviceId()).toThrow(/device identity/i)
  })

  it('whitespace durable value throws', () => {
    db.insert(schema.syncState)
      .values({ key: 'deviceId', value: 'seed' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: 'seed' } })
      .run()
    sqlite.prepare("UPDATE sync_state SET value = '   ' WHERE key = 'deviceId'").run()
    configStore.set('deviceId', 'config-fallback')
    expect(() => syncService.getDeviceId()).toThrow(/device identity/i)
  })
})

describe('missing migration_state is damage, not proof', () => {
  it('missing migration_state table with missing sync_state fails closed', () => {
    sqlite.exec('DROP TABLE IF EXISTS sync_state')
    sqlite.exec('DROP TABLE IF EXISTS migration_state')
    configStore.set('deviceId', 'any-device')
    expect(() => syncService.getDeviceId()).toThrow(/device identity/i)
  })

  it('proven pre-005 (present migration_state, absent 005 key) still returns config', () => {
    sqlite.exec("DELETE FROM migration_state WHERE key = '005_sync_metadata'")
    sqlite.exec("DELETE FROM migration_state WHERE key = '006_sync_field_merge'")
    sqlite.exec('DROP TABLE IF EXISTS sync_state')
    sqlite.exec('DROP TABLE IF EXISTS sync_outbox')
    sqlite.exec('DROP TABLE IF EXISTS sync_applied')
    sqlite.exec('DROP TABLE IF EXISTS sync_entity_clock')
    sqlite.exec('DROP TABLE IF EXISTS sync_field_clock')
    sqlite.exec('DROP TABLE IF EXISTS sync_conflict_log')
    configStore.set('deviceId', 'pre005-device')
    expect(syncService.getDeviceId()).toBe('pre005-device')
  })
})

describe('config-read secondary capture failure stays observable', () => {
  it('hook rethrows secondary persistence failure instead of swallowing', () => {
    const getSpy = vi.spyOn(syncService, 'getConfig').mockImplementation(() => {
      throw new Error('config-read-boom')
    })
    const recSpy = vi.spyOn(syncService, 'recordCaptureFailure').mockImplementation(() => {
      throw new SyncCaptureError('secondary-boom; original: config-read-boom')
    })
    expect(() => handleChatDbSuccessForSync(IpcChannel.ChatDb_EnsureTopic, { topicId: 't-x' })).toThrow(
      /secondary-boom/
    )
    getSpy.mockRestore()
    recSpy.mockRestore()
  })

  it('hook returns without throw when secondary persistence succeeds', () => {
    const getSpy = vi.spyOn(syncService, 'getConfig').mockImplementation(() => {
      throw new Error('config-read-boom')
    })
    const recSpy = vi.spyOn(syncService, 'recordCaptureFailure').mockImplementation(() => {})
    expect(() => handleChatDbSuccessForSync(IpcChannel.ChatDb_EnsureTopic, { topicId: 't-x' })).not.toThrow()
    expect(recSpy).toHaveBeenCalled()
    getSpy.mockRestore()
    recSpy.mockRestore()
  })
})

describe('relay strict cursor framing', () => {
  let relayDb: Database.Database
  let server: ReturnType<typeof createRelayServer>
  let baseUrl: string

  beforeEach(async () => {
    relayDb = new Database(':memory:')
    relayDb.exec(`
      CREATE TABLE IF NOT EXISTS operations (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE NOT NULL,
        entity_type TEXT NOT NULL,
        op TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        device_id TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS sync_trusted_devices (
        device_id TEXT PRIMARY KEY,
        device_name TEXT,
        trusted_at TEXT,
        source TEXT,
        device_secret_hash TEXT
      );
      CREATE TABLE IF NOT EXISTS sync_pairing_invites (
        code TEXT PRIMARY KEY,
        inviter_device_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sync_pairing_requests (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        device_name TEXT,
        code TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL,
        device_secret_hash TEXT
      );
    `)
    server = createRelayServer(relayDb, {})
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    relayDb.close()
  })

  it('rejects 12junk and 07 on pull, preserves canonical 0', async () => {
    // Founder bootstrap to obtain the device credential; cursor framing is
    // validated after device-identity authorization.
    const boot = await fetch(`${baseUrl}/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'd1', operations: [] })
    })
    expect(boot.status).toBe(200)
    const bootBody = (await boot.json()) as { deviceAuth?: unknown }
    const auth = bootBody.deviceAuth as string
    const headers: Record<string, string> = { 'x-sync-device-id': 'd1', 'x-sync-device-auth': auth }
    const bad1 = await fetch(`${baseUrl}/sync/pull?cursor=12junk&deviceId=d1`, { headers })
    expect(bad1.status).toBe(400)
    const bad2 = await fetch(`${baseUrl}/sync/pull?cursor=07&deviceId=d1`, { headers })
    expect(bad2.status).toBe(400)
    const bad3 = await fetch(`${baseUrl}/sync/pull?cursor=%2012&deviceId=d1`, { headers })
    expect(bad3.status).toBe(400)
    const bad4 = await fetch(`${baseUrl}/sync/pull?cursor=-1&deviceId=d1`, { headers })
    expect(bad4.status).toBe(400)
    const ok = await fetch(`${baseUrl}/sync/pull?cursor=0&deviceId=d1`, { headers })
    expect(ok.status).toBe(200)
    const body = await ok.json()
    expect(body.cursor).toBe(0)
    expect(body.operations).toEqual([])
  })

  it('rejects malformed cursor on subscribe before streaming', async () => {
    const bad = await fetch(`${baseUrl}/sync/subscribe?cursor=12junk`)
    expect(bad.status).toBe(400)
    const bad2 = await fetch(`${baseUrl}/sync/subscribe?cursor=07`)
    expect(bad2.status).toBe(400)
  })

  it('does not advance or query on failure: 400 carries no operations/cursor', async () => {
    const boot = await fetch(`${baseUrl}/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'd1', operations: [] })
    })
    expect(boot.status).toBe(200)
    const bootBody = (await boot.json()) as { deviceAuth?: unknown }
    const headers: Record<string, string> = {
      'x-sync-device-id': 'd1',
      'x-sync-device-auth': bootBody.deviceAuth as string
    }
    const res = await fetch(`${baseUrl}/sync/pull?cursor=12junk&deviceId=d1`, { headers })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/invalid cursor/i)
    expect(body.operations).toBeUndefined()
    expect(body.cursor).toBeUndefined()
  })
})
