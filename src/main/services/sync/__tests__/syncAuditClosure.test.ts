/**
 * Audit closure regressions (AUD-001/AUD-002/AUD-003):
 * - Illegal push / malformed pull never bootstrap relay trust.
 * - SyncClient non-2xx preserves the validated issued credential without
 *   leaking the secret into the message.
 * - getPairingStatus propagates local trust-mirror persistence failure
 *   instead of reporting trusted=true.
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

function openRelayDb(): Database.Database {
  const r = new Database(':memory:')
  r.exec(`
    CREATE TABLE operations (
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
  return r
}

describe('AUD-001: reference relay defers bootstrap until validation passes', () => {
  it('illegal push does not bootstrap trust and issues no credential', async () => {
    const { createRelayServer } = await import('../../../../../scripts/sync-relay/server')
    const relayDb = openRelayDb()
    const server = createRelayServer(relayDb as never)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }
    const base = `http://127.0.0.1:${addr.port}`
    try {
      const badTopic = {
        id: 'op-audit-bad',
        entityType: 'topic',
        op: 'upsert',
        entityId: 't-audit-bad',
        timestamp: Date.now(),
        deviceId: 'd-audit',
        payload: { id: 't-audit-bad', name: 123 }
      }
      const res = await fetch(`${base}/sync/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'd-audit', operations: [badTopic] })
      })
      expect(res.status).toBe(400)
      const body = (await res.json().catch(() => ({}))) as { deviceAuth?: unknown }
      expect(body.deviceAuth).toBeUndefined()
      const count = (relayDb.prepare('SELECT COUNT(*) as n FROM sync_trusted_devices').get() as { n: number }).n
      expect(count).toBe(0)
      const ops = (relayDb.prepare('SELECT COUNT(*) as c FROM operations').get() as { c: number }).c
      expect(ops).toBe(0)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      relayDb.close()
    }
  })

  it('malformed pull cursor does not bootstrap trust', async () => {
    const { createRelayServer } = await import('../../../../../scripts/sync-relay/server')
    const relayDb = openRelayDb()
    const server = createRelayServer(relayDb as never)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }
    const base = `http://127.0.0.1:${addr.port}`
    try {
      const res = await fetch(`${base}/sync/pull?cursor=12junk&deviceId=d-audit`, {
        headers: { 'x-sync-device-id': 'd-audit' }
      })
      expect(res.status).toBe(400)
      const body = (await res.json().catch(() => ({}))) as { deviceAuth?: unknown }
      expect(body.deviceAuth).toBeUndefined()
      const count = (relayDb.prepare('SELECT COUNT(*) as n FROM sync_trusted_devices').get() as { n: number }).n
      expect(count).toBe(0)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      relayDb.close()
    }
  })
})

describe('AUD-002: SyncClient preserves issued credential without leaking secret', () => {
  it('non-2xx push error carries deviceAuth and redacts it from the message', async () => {
    const { syncClient } = await import('../SyncClient')
    const issued = 'ab'.repeat(32)
    const origFetch = globalThis.fetch
    ;(globalThis as unknown as { fetch: unknown }).fetch = (async () =>
      ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: 'invalid operation x: bad', deviceAuth: issued })
      }) as never) as never
    try {
      const err = await syncClient.push('http://127.0.0.1:9', undefined, { deviceId: 'd1', operations: [] }).then(
        () => null,
        (e: unknown) => e as Error & { deviceAuth?: unknown }
      )
      expect(err).not.toBeNull()
      expect(err?.deviceAuth).toBe(issued)
      expect(String(err?.message)).not.toContain(issued)
    } finally {
      ;(globalThis as unknown as { fetch: unknown }).fetch = origFetch
    }
  })

  it('non-2xx pull error carries deviceAuth and redacts it from the message', async () => {
    const { syncClient } = await import('../SyncClient')
    const issued = 'cd'.repeat(32)
    const origFetch = globalThis.fetch
    ;(globalThis as unknown as { fetch: unknown }).fetch = (async () =>
      ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: 'invalid cursor', deviceAuth: issued })
      }) as never) as never
    try {
      const err = await syncClient.pull('http://127.0.0.1:9', undefined, 0, 'd1').then(
        () => null,
        (e: unknown) => e as Error & { deviceAuth?: unknown }
      )
      expect(err).not.toBeNull()
      expect(err?.deviceAuth).toBe(issued)
      expect(String(err?.message)).not.toContain(issued)
    } finally {
      ;(globalThis as unknown as { fetch: unknown }).fetch = origFetch
    }
  })
})

describe('AUD-003: pairing status fails closed when local trust persistence fails', () => {
  it('getPairingStatus rejects instead of reporting trusted=true', async () => {
    const { syncClient } = await import('../SyncClient')
    syncService.getDeviceId()
    vi.spyOn(syncClient, 'getPairingStatus').mockResolvedValue({ trusted: true, pending: false })
    vi.spyOn(syncClient, 'listTrusted').mockResolvedValue({
      devices: [{ deviceId: 'peer-x', trustedAt: new Date().toISOString(), source: 'relay-refresh' }]
    } as never)
    // Break the local trust mirror so refresh persistence fails.
    sqlite.exec('DROP TABLE IF EXISTS sync_trusted_devices')
    await expect(syncService.getPairingStatus()).rejects.toThrow()
  })
})
