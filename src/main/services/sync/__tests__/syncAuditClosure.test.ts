/**
 * Audit closure regressions (SYNC-CC-*, Main + relay lanes):
 * - Illegal push / malformed pull framing never writes channel state and
 *   issues no credential.
 * - SyncClient redacts relay error bodies (never carries secrets in text).
 * - Unpaired pull/push is refused without touching channel cursors.
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

async function openRelay(): Promise<{ base: string; relayDb: Database.Database; close: () => Promise<void> }> {
  const { createRelayServer, ensureRelaySchema } = await import('../../../../../scripts/sync-relay/server')
  const relayDb = new Database(':memory:')
  ensureRelaySchema(relayDb)
  const server = createRelayServer(relayDb, {})
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as { port: number }
  return {
    base: `http://127.0.0.1:${addr.port}`,
    relayDb,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

async function registerRaw(base: string): Promise<{ code: string; secret: string }> {
  const res = await fetch(`${base}/sync/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { deviceCode: string; deviceSecret: string }
  return { code: body.deviceCode, secret: body.deviceSecret }
}

describe('relay validation runs before any channel write', () => {
  it('illegal push writes nothing and issues no credential', async () => {
    const { base, relayDb, close } = await openRelay()
    try {
      const reg = await registerRaw(base)
      const headers = {
        'Content-Type': 'application/json',
        'x-sync-device-code': reg.code,
        'x-sync-device-secret': reg.secret
      }
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
        headers,
        body: JSON.stringify({ deviceId: 'd-audit', operations: [badTopic] })
      })
      expect(res.status).toBe(400)
      const body = (await res.json().catch(() => ({}))) as { deviceSecret?: unknown; deviceAuth?: unknown }
      expect(body.deviceSecret).toBeUndefined()
      expect(body.deviceAuth).toBeUndefined()
      const ops = (relayDb.prepare('SELECT COUNT(*) as c FROM sync_channel_operations').get() as { c: number }).c
      expect(ops).toBe(0)
    } finally {
      await close()
      relayDb.close()
    }
  })

  it('malformed pull cursor is rejected before any data access', async () => {
    const { base, relayDb, close } = await openRelay()
    try {
      const reg = await registerRaw(base)
      const res = await fetch(`${base}/sync/pull?cursor=12junk&deviceId=d-audit`, {
        headers: { 'x-sync-device-code': reg.code, 'x-sync-device-secret': reg.secret }
      })
      expect(res.status).toBe(400)
      const body = (await res.json().catch(() => ({}))) as { deviceSecret?: unknown }
      expect(body.deviceSecret).toBeUndefined()
    } finally {
      await close()
      relayDb.close()
    }
  })

  it('unpaired push/pull is refused without channel state', async () => {
    const { base, relayDb, close } = await openRelay()
    try {
      const reg = await registerRaw(base)
      const headers = {
        'Content-Type': 'application/json',
        'x-sync-device-code': reg.code,
        'x-sync-device-secret': reg.secret
      }
      const push = await fetch(`${base}/sync/push`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ deviceId: 'd-audit', operations: [] })
      })
      expect(push.status).toBe(403)
      expect(((await push.json()) as { error: string }).error).toMatch(/pairing-required/)
      const ops = (relayDb.prepare('SELECT COUNT(*) as c FROM sync_channel_operations').get() as { c: number }).c
      expect(ops).toBe(0)
    } finally {
      await close()
      relayDb.close()
    }
  })
})

describe('SyncClient redacts relay error bodies', () => {
  it('non-2xx push error never carries secret material in the message', async () => {
    const { syncClient } = await import('../SyncClient')
    const issued = 'ab'.repeat(32)
    const origFetch = globalThis.fetch
    ;(globalThis as unknown as { fetch: unknown }).fetch = (async () =>
      ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: 'invalid operation x: bad', deviceSecret: issued })
      }) as never) as never
    try {
      const err = await syncClient
        .push('http://127.0.0.1:9', undefined, { deviceId: 'd1', operations: [] }, undefined, 'ABCD2345', issued)
        .then(
          () => null,
          (e: unknown) => e as Error
        )
      expect(err).not.toBeNull()
      expect(String(err?.message)).not.toContain(issued)
      expect(String(err?.message)).toMatch(/invalid operation/)
    } finally {
      ;(globalThis as unknown as { fetch: unknown }).fetch = origFetch
    }
  })

  it('non-2xx pull error never carries secret material in the message', async () => {
    const { syncClient } = await import('../SyncClient')
    const issued = 'cd'.repeat(32)
    const origFetch = globalThis.fetch
    ;(globalThis as unknown as { fetch: unknown }).fetch = (async () =>
      ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: 'invalid cursor', deviceSecret: issued })
      }) as never) as never
    try {
      const err = await syncClient.pull('http://127.0.0.1:9', undefined, 0, 'd1', undefined, 'ABCD2345', issued).then(
        () => null,
        (e: unknown) => e as Error
      )
      expect(err).not.toBeNull()
      expect(String(err?.message)).not.toContain(issued)
    } finally {
      ;(globalThis as unknown as { fetch: unknown }).fetch = origFetch
    }
  })
})

describe('getPairState fails closed when the relay is unreachable', () => {
  it('transport failure propagates instead of a forged unpaired state', async () => {
    const { syncClient } = await import('../SyncClient')
    vi.spyOn(syncClient, 'getPairState').mockRejectedValue(new Error('fetch failed'))
    await expect(syncService.getPairState()).rejects.toThrow(/fetch failed/)
    expect(syncService.getServiceStatus().state).toBe('disconnected')
  })
})
