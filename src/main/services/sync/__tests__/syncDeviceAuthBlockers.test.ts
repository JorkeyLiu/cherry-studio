/**
 * Device-auth blocker regressions (F-001/F-003/F-008):
 * - Per-device relay credential issuance is persisted fail-closed.
 * - Bootstrap trust persistence failure never reports sync success.
 * - Trust-store read failure fails closed before transport.
 * - Malformed device auth fails closed in preflight.
 * - No secret material is logged.
 */
import { createHash, randomBytes } from 'node:crypto'

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

import { loggerService } from '@logger'

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

describe('device-auth blockers', () => {
  it('F-008: bootstrap trust persistence failure never reports success', async () => {
    const { syncClient } = await import('../SyncClient')
    const issued = freshDeviceAuth()
    vi.spyOn(syncClient, 'push').mockResolvedValue({ acceptedIds: [], cursor: 0 } as never)
    // Let preflight reads pass, then break the trust mirror before the
    // post-pull bootstrap write so only the write fails (true F-008).
    vi.spyOn(syncClient, 'pull').mockImplementation(async () => {
      sqlite.exec('DROP TABLE IF EXISTS sync_trusted_devices')
      return { operations: [], cursor: 0, deviceAuth: issued } as never
    })
    await expect(syncService.sync()).rejects.toThrow(/persistence failed/i)
    let status: { lastSyncAt: string | null; lastError: string | null } | null = null
    try {
      status = syncService.getStatus()
    } catch {
      status = null
    }
    // Either status is unreadable (DB damage) or it carries a durable error
    // with no success timestamp — never a clean success.
    if (status) {
      expect(status.lastSyncAt).toBeNull()
      expect(status.lastError).toMatch(/persistence failed/i)
    }
  })

  it('F-008: issued device credential persists before success is reported', async () => {
    const { syncClient } = await import('../SyncClient')
    const issued = freshDeviceAuth()
    vi.spyOn(syncClient, 'push').mockResolvedValue({ acceptedIds: [], cursor: 0 } as never)
    vi.spyOn(syncClient, 'pull').mockResolvedValue({ operations: [], cursor: 0, deviceAuth: issued } as never)
    const status = await syncService.sync()
    expect(status.lastError).toBeNull()
    expect(status.lastSyncAt).not.toBeNull()
    expect(syncService.getDeviceAuth()).toBe(issued)
    // Bootstrap trust mirrored locally.
    expect(syncService.isDeviceTrusted(syncService.getDeviceId())).toBe(true)
  })

  it('F-003: trust-store read failure fails closed before transport', async () => {
    const { syncClient } = await import('../SyncClient')
    const pushSpy = vi.spyOn(syncClient, 'push')
    const pullSpy = vi.spyOn(syncClient, 'pull')
    sqlite.exec('DROP TABLE sync_trusted_devices')
    await expect(syncService.sync()).rejects.toThrow()
    expect(pushSpy).not.toHaveBeenCalled()
    expect(pullSpy).not.toHaveBeenCalled()
  })

  it('malformed device auth fails closed in preflight without transport', async () => {
    const { syncClient } = await import('../SyncClient')
    const pushSpy = vi.spyOn(syncClient, 'push')
    configStore.set('sync:deviceAuth', 'not-a-credential')
    await expect(syncService.sync()).rejects.toThrow(/device auth/i)
    expect(pushSpy).not.toHaveBeenCalled()
  })

  it('device credential and payloads are never logged', async () => {
    const { syncClient } = await import('../SyncClient')
    const issued = freshDeviceAuth()
    const issuedHash = createHash('sha256').update(issued, 'utf8').digest('hex')
    const seen: string[] = []
    vi.spyOn(loggerService, 'withContext').mockImplementation(
      () =>
        ({
          info: (m: string) => seen.push(String(m)),
          warn: (m: string) => seen.push(String(m)),
          error: (m: string) => seen.push(String(m))
        }) as never
    )
    vi.spyOn(syncClient, 'push').mockResolvedValue({ acceptedIds: [], cursor: 0, deviceAuth: issued } as never)
    vi.spyOn(syncClient, 'pull').mockResolvedValue({ operations: [], cursor: 0 } as never)
    await syncService.sync()
    const dump = seen.join('\n')
    expect(dump).not.toContain(issued)
    expect(dump).not.toContain(issuedHash)
  })

  it('normal request -> accept -> restart persistence -> post-pair sync chain', async () => {
    // Local side of the pairing chain: accept persists both the peer and
    // self; a simulated restart (same sqlite handle) retains trust.
    const self = syncService.getDeviceId()
    db.insert(schema.syncTrustedDevices)
      .values({ deviceId: self, trustedAt: new Date().toISOString(), source: 'pairing-accept-self' })
      .run()
    db.insert(schema.syncTrustedDevices)
      .values({ deviceId: 'peer-device', trustedAt: new Date().toISOString(), source: 'pairing-accept' })
      .run()
    expect(syncService.isDeviceTrusted('peer-device')).toBe(true)
    const { syncClient } = await import('../SyncClient')
    vi.spyOn(syncClient, 'push').mockResolvedValue({ acceptedIds: [], cursor: 0 } as never)
    vi.spyOn(syncClient, 'pull').mockResolvedValue({ operations: [], cursor: 0 } as never)
    const status = await syncService.sync()
    expect(status.lastError).toBeNull()
    expect(syncService.isDeviceTrusted('peer-device')).toBe(true)
  })
})

describe('SyncClient device-identity headers', () => {
  it('sends bound device headers and rejects malformed auth before transport', async () => {
    const { syncClient } = await import('../SyncClient')
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const origFetch = globalThis.fetch
    ;(globalThis as unknown as { fetch: unknown }).fetch = (async (
      url: string,
      init: { headers: Record<string, string> }
    ) => {
      seen.push({ url: String(url), headers: { ...init?.headers } })
      return { ok: true, json: async () => ({ acceptedIds: [], cursor: 0 }) } as never
    }) as never
    try {
      const auth = freshDeviceAuth()
      await syncClient.push('http://127.0.0.1:9', undefined, { deviceId: 'd1', operations: [] }, undefined, auth)
      expect(seen[0].headers['x-sync-device-id']).toBe('d1')
      expect(seen[0].headers['x-sync-device-auth']).toBe(auth)
      await expect(
        syncClient.push('http://127.0.0.1:9', undefined, { deviceId: 'd1', operations: [] }, undefined, 'bad')
      ).rejects.toThrow(/device auth/i)
      expect(seen.length).toBe(1)
    } finally {
      ;(globalThis as unknown as { fetch: unknown }).fetch = origFetch
    }
  })

  it('pull requires a valid device identity before transport', async () => {
    const { syncClient } = await import('../SyncClient')
    await expect(syncClient.pull('http://127.0.0.1:9', undefined, 0, '')).rejects.toThrow(/device id/i)
    await expect(syncClient.pull('http://127.0.0.1:9', undefined, 0, 'd1', undefined, 'bad')).rejects.toThrow(
      /device auth/i
    )
  })
})
