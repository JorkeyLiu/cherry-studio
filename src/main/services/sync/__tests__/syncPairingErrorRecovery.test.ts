/**
 * F-001/F-002 blocker closure: pairing invite/request error-carried credential
 * recovery via the Main production path, and reference-relay pull semantic
 * validation before bootstrap.
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

describe('F-001 pairing production-path error credential recovery', () => {
  it('createInvite transport error carrying credential persists via production path and retry recovers', async () => {
    const { syncClient } = await import('../SyncClient')
    const issued = freshDeviceAuth()
    const transportErr = new Error('pairing request failed 500: {"error":"trust-store-unavailable"}')
    ;(transportErr as { deviceAuth?: string }).deviceAuth = issued
    const spy = vi.spyOn(syncClient, 'createInvite').mockRejectedValueOnce(transportErr)
    const err = await syncService.createPairingInvite().then(
      () => null,
      (e: unknown) => e as Error & { deviceAuth?: unknown }
    )
    expect(err).not.toBeNull()
    expect(String(err?.message)).not.toContain(issued)
    // Production path persisted the error-carried credential.
    expect(syncService.getDeviceAuth()).toBe(issued)
    expect(spy).toHaveBeenCalledOnce()
    // Retry with the persisted credential succeeds.
    vi.spyOn(syncClient, 'createInvite').mockResolvedValue({
      code: 'ABCDEFGH',
      expiresAt: new Date().toISOString()
    } as never)
    const ok = await syncService.createPairingInvite()
    expect(ok.code).toBe('ABCDEFGH')
    expect(syncService.getDeviceAuth()).toBe(issued)
  })

  it('requestPairing transport error carrying credential persists and retry recovers', async () => {
    const { syncClient } = await import('../SyncClient')
    const issued = freshDeviceAuth()
    const transportErr = new Error('pairing request failed 500: {"error":"trust-store-unavailable"}')
    ;(transportErr as { deviceAuth?: string }).deviceAuth = issued
    vi.spyOn(syncClient, 'requestPairing').mockRejectedValueOnce(transportErr)
    const err = await syncService.requestPairing('ABCDEFGH').then(
      () => null,
      (e: unknown) => e as Error & { deviceAuth?: unknown }
    )
    expect(err).not.toBeNull()
    expect(String(err?.message)).not.toContain(issued)
    expect(syncService.getDeviceAuth()).toBe(issued)
    vi.spyOn(syncClient, 'requestPairing').mockResolvedValue({
      requestId: 'req-retry',
      status: 'pending',
      deviceAuth: issued
    } as never)
    const ok = await syncService.requestPairing('ABCDEFGH')
    expect(ok.requestId).toBe('req-retry')
  })

  it('error-path persistence failure fails closed with carrier and no success', async () => {
    const { syncClient } = await import('../SyncClient')
    const issued = freshDeviceAuth()
    const transportErr = new Error('pairing request failed 500: {"error":"trust-store-unavailable"}')
    ;(transportErr as { deviceAuth?: string }).deviceAuth = issued
    vi.spyOn(syncClient, 'createInvite').mockRejectedValueOnce(transportErr)
    failDeviceAuthPersist = true
    const err = await syncService.createPairingInvite().then(
      () => null,
      (e: unknown) => e as Error & { deviceAuth?: unknown }
    )
    expect(err).not.toBeNull()
    expect(err?.deviceAuth).toBe(issued)
    expect(String(err?.message)).not.toContain(issued)
    expect(String(err?.message)).toMatch(/persistence failed/i)
    expect(syncService.getDeviceAuth()).toBeUndefined()
  })
})

describe('F-002 reference relay semantic-illegal pull never bootstraps', () => {
  it('legal JSON but protocol-illegal operation rejects before bootstrap with empty trust, then recovers', async () => {
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
    // Valid JSON payload that fails the shared strict validator (unknown
    // entityType is protocol-illegal but parses cleanly).
    const illegalPayload = JSON.stringify({ id: 't1', name: 'x' })
    relayDb
      .prepare(
        `INSERT INTO operations (id, entity_type, op, entity_id, timestamp, device_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'bad-semantic-1',
        'nonsense-type',
        'upsert',
        't1',
        1000,
        'd-bootstrap',
        illegalPayload,
        new Date().toISOString()
      )
    const server = createRelayServer(relayDb, {})
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    try {
      const addr = server.address() as { port: number }
      const base = `http://127.0.0.1:${addr.port}`
      const res = await fetch(`${base}/sync/pull?cursor=0&deviceId=d-bootstrap`, {
        headers: { 'x-sync-device-id': 'd-bootstrap' }
      })
      expect(res.status).toBe(500)
      const body = (await res.json().catch(() => ({}))) as { deviceAuth?: unknown; error?: unknown }
      expect(body.deviceAuth).toBeUndefined()
      const count = (relayDb.prepare('SELECT COUNT(*) as n FROM sync_trusted_devices').get() as { n: number }).n
      expect(count).toBe(0)
      // Recovery: remove the poison row and the same founder bootstraps.
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

  it('SyncClient pull validation failure preserves the issued credential (no bootstrap lockout)', async () => {
    const { SyncClient } = await import('../SyncClient')
    const issued = freshDeviceAuth()
    const illegalOp = {
      seq: 1,
      id: 'bad-1',
      entityType: 'nonsense-type',
      op: 'upsert',
      entityId: 't1',
      timestamp: 1000,
      deviceId: 'd-bootstrap',
      payload: { id: 't1' }
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ operations: [illegalOp], cursor: 1, deviceAuth: issued })
    } as never)
    try {
      const client = new SyncClient()
      const err = await client.pull('http://127.0.0.1:3999', undefined, 0, 'd-bootstrap').then(
        () => null,
        (e: unknown) => e as Error & { deviceAuth?: unknown }
      )
      expect(err).not.toBeNull()
      expect(err?.deviceAuth).toBe(issued)
      expect(String(err?.message)).not.toContain(issued)
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
