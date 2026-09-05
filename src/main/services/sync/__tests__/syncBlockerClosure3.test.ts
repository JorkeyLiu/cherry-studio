/**
 * Blocker-closure regressions for the final re-review increment:
 * - F-001: relay-issued credential persistence failure is recoverable via the
 *   error-carried credential (never in the message/log) and never reports success.
 * - F-002: reference relay pull bootstrap never leaves enrolled-without-credential
 *   trust: fallible reads run before bootstrap; post-bootstrap errors carry
 *   the credential.
 * - F-003: Main trust-mirror accept/refresh batches are atomic under failure.
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
let failDeviceAuthPersist = false
vi.mock('@main/services/ConfigManager', () => ({
  configManager: {
    get: (k: string, def?: unknown) => (configStore.has(k) ? configStore.get(k) : def),
    set: (k: string, v: unknown) => {
      if (failDeviceAuthPersist && k === 'sync:deviceAuth') throw new Error('injected config persist failure')
      configStore.set(k, v)
    },
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

function freshDeviceAuth(): string {
  return randomBytes(32).toString('hex')
}

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', 'http://127.0.0.1:3999')
  configStore.set('sync:token', 'test-token')
  failDeviceAuthPersist = false
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
  failDeviceAuthPersist = false
  try {
    sqlite.close()
  } catch {}
  ;(chatDbService as never as { sqlite: unknown }).sqlite = null
  ;(chatDbService as never as { db: unknown }).db = null
})

describe('F-001 credential persistence failure is recoverable', () => {
  it('sync pull issued credential rides on the persistence error, never in the message', async () => {
    const { syncClient } = await import('../SyncClient')
    const issued = freshDeviceAuth()
    vi.spyOn(syncClient, 'push').mockResolvedValue({ acceptedIds: [], cursor: 0 } as never)
    vi.spyOn(syncClient, 'pull').mockResolvedValue({ operations: [], cursor: 0, deviceAuth: issued } as never)
    failDeviceAuthPersist = true
    const err = await syncService.sync().then(
      () => null,
      (e: unknown) => e as Error & { deviceAuth?: unknown }
    )
    expect(err).not.toBeNull()
    expect(err?.deviceAuth).toBe(issued)
    expect(String(err?.message)).not.toContain(issued)
    expect(syncService.getStatus().lastSyncAt).toBeNull()
    expect(String(syncService.getStatus().lastError)).toMatch(/persistence failed/i)
    // Retry after the store recovers persists the carried credential.
    failDeviceAuthPersist = false
    const carried = err?.deviceAuth as string
    configStore.set('sync:deviceAuth', carried)
    expect(syncService.getDeviceAuth()).toBe(issued)
  })

  it('createInvite persistence failure carries the founder credential', async () => {
    const { syncClient } = await import('../SyncClient')
    const issued = freshDeviceAuth()
    vi.spyOn(syncClient, 'createInvite').mockResolvedValue({
      code: 'ABCDEFGH',
      expiresAt: new Date().toISOString(),
      deviceAuth: issued
    } as never)
    failDeviceAuthPersist = true
    const err = await syncService.createPairingInvite().then(
      () => null,
      (e: unknown) => e as Error & { deviceAuth?: unknown }
    )
    expect(err).not.toBeNull()
    expect(err?.deviceAuth).toBe(issued)
    expect(String(err?.message)).not.toContain(issued)
  })

  it('requestPairing persistence failure carries the joiner credential', async () => {
    const { syncClient } = await import('../SyncClient')
    const issued = freshDeviceAuth()
    vi.spyOn(syncClient, 'requestPairing').mockResolvedValue({
      requestId: 'req-1',
      status: 'pending',
      deviceAuth: issued
    } as never)
    failDeviceAuthPersist = true
    const err = await syncService.requestPairing('ABCDEFGH').then(
      () => null,
      (e: unknown) => e as Error & { deviceAuth?: unknown }
    )
    expect(err).not.toBeNull()
    expect(err?.deviceAuth).toBe(issued)
    expect(String(err?.message)).not.toContain(issued)
  })
})

describe('F-002 reference relay pull bootstrap consistency', () => {
  it('malformed operation row fails before bootstrap without trust or credential', async () => {
    const { createRelayServer } = await import('../../../../../scripts/sync-relay/server')
    const relayDb = new Database(':memory:')
    relayDb.exec(`
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
      CREATE TABLE sync_trusted_devices (
        device_id TEXT PRIMARY KEY,
        device_name TEXT,
        trusted_at TEXT,
        source TEXT,
        device_secret_hash TEXT
      );
      CREATE TABLE sync_pairing_invites (
        code TEXT PRIMARY KEY,
        inviter_device_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE sync_pairing_requests (
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
    relayDb
      .prepare(
        `INSERT INTO operations (id, entity_type, op, entity_id, timestamp, device_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('bad-1', 'topic', 'upsert', 't1', 1000, 'd-bootstrap', '{not-json', new Date().toISOString())
    const server = createRelayServer(relayDb, {})
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    try {
      const addr = server.address() as { port: number }
      const base = `http://127.0.0.1:${addr.port}`
      const res = await fetch(`${base}/sync/pull?cursor=0&deviceId=d-bootstrap`, {
        headers: { 'x-sync-device-id': 'd-bootstrap' }
      })
      expect(res.status).toBe(500)
      const body = (await res.json().catch(() => ({}))) as { deviceAuth?: unknown }
      expect(body.deviceAuth).toBeUndefined()
      const count = (relayDb.prepare('SELECT COUNT(*) as n FROM sync_trusted_devices').get() as { n: number }).n
      expect(count).toBe(0)
      // Deterministic recovery: remove the poison row and the same founder
      // pull bootstraps with a returned credential.
      relayDb.exec(`DELETE FROM operations`)
      const res2 = await fetch(`${base}/sync/pull?cursor=0&deviceId=d-bootstrap`, {
        headers: { 'x-sync-device-id': 'd-bootstrap' }
      })
      expect(res2.status).toBe(200)
      const body2 = (await res2.json().catch(() => ({}))) as { deviceAuth?: unknown }
      expect(typeof body2.deviceAuth).toBe('string')
      const count2 = (relayDb.prepare('SELECT COUNT(*) as n FROM sync_trusted_devices').get() as { n: number }).n
      expect(count2).toBe(1)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      relayDb.close()
    }
  })
})

describe('F-003 trust mirror atomicity under injected failure', () => {
  it('accept rolls back the peer row when the self mirror write fails', async () => {
    const { syncClient } = await import('../SyncClient')
    vi.spyOn(syncClient, 'acceptPairing').mockResolvedValue({
      trusted: { deviceId: 'peer-a', deviceName: 'peer', trustedAt: new Date().toISOString(), source: 'relay' }
    } as never)
    const svc = syncService as unknown as { upsertTrustedDevice: (d: never) => void }
    const real = svc.upsertTrustedDevice.bind(syncService)
    let calls = 0
    vi.spyOn(svc, 'upsertTrustedDevice').mockImplementation(((d: never) => {
      calls += 1
      if (calls === 2) throw new Error('injected mirror failure')
      return real(d)
    }) as never)
    await expect(syncService.acceptPairing('req-1')).rejects.toThrow(/injected mirror failure/)
    expect(syncService.listTrustedDevices()).toEqual([])
  })

  it('refresh rolls back the whole batch when a later row write fails', async () => {
    const { syncClient } = await import('../SyncClient')
    vi.spyOn(syncClient, 'listTrusted').mockResolvedValue({
      devices: [
        { deviceId: 'peer-a', trustedAt: new Date().toISOString(), source: 'relay-refresh' },
        { deviceId: 'peer-b', trustedAt: new Date().toISOString(), source: 'relay-refresh' }
      ]
    } as never)
    const svc = syncService as unknown as { upsertTrustedDevice: (d: never) => void }
    const real = svc.upsertTrustedDevice.bind(syncService)
    let calls = 0
    vi.spyOn(svc, 'upsertTrustedDevice').mockImplementation(((d: never) => {
      calls += 1
      if (calls === 2) throw new Error('injected refresh failure')
      return real(d)
    }) as never)
    await expect(syncService.refreshTrustedDevices()).rejects.toThrow(/injected refresh failure/)
    expect(syncService.listTrustedDevices()).toEqual([])
  })
})
