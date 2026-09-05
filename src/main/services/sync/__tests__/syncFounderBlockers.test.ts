/**
 * F-001/F-002/F-003 blocker-closure regressions (focused, Node lane):
 * - F-001: concurrent founder bootstrap on the reference relay registers
 *   exactly one trusted device; losers get 403 pairing-required.
 *   (In-memory relay concurrency lives in
 *   tests/e2e/utils/sync-relay-founder.test.ts to respect project lanes.)
 * - F-002: no trusted-without-secret — confirm failures roll back, commit
 *   failures carry the credential, delivery loss is explicit 403 with
 *   operator-reset recovery (no unauthenticated rotation).
 * - F-003: SyncClient push/invite/request malformed 2xx carries the issued
 *   credential on the error carrier with a redacted message.
 */
import { randomBytes } from 'node:crypto'

import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

function freshAuth(): string {
  return randomBytes(32).toString('hex')
}

function createRelayDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
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
  return db
}

async function listenRelay(db: Database.Database): Promise<{ base: string; close: () => Promise<void> }> {
  const { createRelayServer } = await import('../../../../../scripts/sync-relay/server')
  const server = createRelayServer(db, {})
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as { port: number }
  const base = `http://127.0.0.1:${addr.port}`
  return { base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

describe('F-001 concurrent founder bootstrap admits exactly one device', () => {
  it('reference relay: concurrent pushes with distinct ids leave one trusted row', async () => {
    const db = createRelayDb()
    const { base, close } = await listenRelay(db)
    try {
      const ids = ['founder-a', 'founder-b', 'founder-c', 'founder-d', 'founder-e']
      const results = await Promise.all(
        ids.map((deviceId) =>
          fetch(`${base}/sync/push`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-sync-device-id': deviceId },
            body: JSON.stringify({ deviceId, operations: [] })
          }).then(async (r) => ({ deviceId, status: r.status, body: await r.json().catch(() => ({})) }))
        )
      )
      const ok = results.filter((r) => r.status === 200)
      expect(ok.length).toBe(1)
      expect(typeof ok[0].body.deviceAuth).toBe('string')
      for (const r of results.filter((x) => x.status !== 200)) {
        expect(r.status).toBe(403)
        expect(r.body.error).toMatch(/device-not-trusted/)
        expect(r.body.deviceAuth).toBeUndefined()
      }
      const count = (db.prepare('SELECT COUNT(*) as n FROM sync_trusted_devices').get() as { n: number }).n
      expect(count).toBe(1)
      const winner = (db.prepare('SELECT device_id FROM sync_trusted_devices').get() as { device_id: string }).device_id
      expect(ids).toContain(winner)
      // Second device still needs explicit pairing after the race.
      const loser = ids.find((id) => id !== winner)!
      const retry = await fetch(`${base}/sync/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sync-device-id': loser },
        body: JSON.stringify({ deviceId: loser, operations: [] })
      })
      expect(retry.status).toBe(403)
    } finally {
      await close()
      db.close()
    }
  })
})

describe('F-002 bootstrap consistency without trusted-without-secret lockout', () => {
  it('delivery loss is explicit 403 (no silent rotation); operator reset recovers', async () => {
    const db = createRelayDb()
    const { base, close } = await listenRelay(db)
    try {
      // Founder bootstraps via push; simulate delivery loss by dropping it.
      const first = await fetch(`${base}/sync/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sync-device-id': 'solo-1' },
        body: JSON.stringify({ deviceId: 'solo-1', operations: [] })
      })
      expect(first.status).toBe(200)
      const firstBody = (await first.json()) as { deviceAuth: string }
      expect(typeof firstBody.deviceAuth).toBe('string')
      // Retry without the lost credential stays 403 with no new credential:
      // token+deviceId alone is never proof (no unauthenticated rotation).
      const retry = await fetch(`${base}/sync/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sync-device-id': 'solo-1' },
        body: JSON.stringify({ deviceId: 'solo-1', operations: [] })
      })
      expect(retry.status).toBe(403)
      const retryBody = (await retry.json().catch(() => ({}))) as { deviceAuth?: unknown; error?: unknown }
      expect(retryBody.deviceAuth).toBeUndefined()
      expect(String((retryBody as { error?: unknown }).error)).toMatch(/device-not-trusted/)
      // The held credential still verifies — no trusted-without-secret.
      const fresh = await fetch(`${base}/sync/pull?cursor=0&deviceId=solo-1`, {
        headers: { 'x-sync-device-id': 'solo-1', 'x-sync-device-auth': firstBody.deviceAuth }
      })
      expect(fresh.status).toBe(200)
      // Well-formed wrong secrets never rotate either.
      const stale = await fetch(`${base}/sync/pull?cursor=0&deviceId=solo-1`, {
        headers: { 'x-sync-device-id': 'solo-1', 'x-sync-device-auth': '0'.repeat(64) }
      })
      expect(stale.status).toBe(403)
      // Explicit operator reset (clear the unproven sole row) recovers: the
      // same device bootstraps fresh with a new credential.
      db.prepare('DELETE FROM sync_trusted_devices WHERE device_id = ?').run('solo-1')
      const afterReset = await fetch(`${base}/sync/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sync-device-id': 'solo-1' },
        body: JSON.stringify({ deviceId: 'solo-1', operations: [] })
      })
      expect(afterReset.status).toBe(200)
      const afterResetBody = (await afterReset.json()) as { deviceAuth: string }
      expect(typeof afterResetBody.deviceAuth).toBe('string')
      // Missing-auth forgery of the founder identity stays 403.
      const noAuth = await fetch(`${base}/sync/pull?cursor=0&deviceId=solo-1`, {
        headers: { 'x-sync-device-id': 'solo-1' }
      })
      expect(noAuth.status).toBe(403)
      const noAuthBody = (await noAuth.json().catch(() => ({}))) as { deviceAuth?: unknown }
      expect(noAuthBody.deviceAuth).toBeUndefined()
      // A different device never recovers the founder slot.
      const other = await fetch(`${base}/sync/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sync-device-id': 'intruder' },
        body: JSON.stringify({ deviceId: 'intruder', operations: [] })
      })
      expect(other.status).toBe(403)
      const count = (db.prepare('SELECT COUNT(*) as n FROM sync_trusted_devices').get() as { n: number }).n
      expect(count).toBe(1)
    } finally {
      await close()
      db.close()
    }
  })
})

describe('F-003 malformed 2xx carries the issued credential redacted', () => {
  it('push malformed cursor carries deviceAuth without leaking it', async () => {
    const { SyncClient } = await import('../SyncClient')
    const issued = freshAuth()
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ acceptedIds: ['a'], cursor: 'bad', deviceAuth: issued })
    } as never)
    try {
      const client = new SyncClient()
      const err = await client
        .push('http://127.0.0.1:3999', undefined, { deviceId: 'd1', operations: [] } as never)
        .then(
          () => null,
          (e: unknown) => e as Error & { deviceAuth?: unknown }
        )
      expect(err).not.toBeNull()
      expect(err?.deviceAuth).toBe(issued)
      expect(String(err?.message)).not.toContain(issued)
    } finally {
      spy.mockRestore()
    }
  })

  it('invite malformed code carries deviceAuth without leaking it', async () => {
    const { SyncClient } = await import('../SyncClient')
    const issued = freshAuth()
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ code: 12345, expiresAt: new Date().toISOString(), deviceAuth: issued })
    } as never)
    try {
      const client = new SyncClient()
      const err = await client.createInvite('http://127.0.0.1:3999', undefined, 'd1').then(
        () => null,
        (e: unknown) => e as Error & { deviceAuth?: unknown }
      )
      expect(err).not.toBeNull()
      expect(err?.deviceAuth).toBe(issued)
      expect(String(err?.message)).not.toContain(issued)
    } finally {
      spy.mockRestore()
    }
  })

  it('request malformed requestId carries deviceAuth without leaking it', async () => {
    const { SyncClient } = await import('../SyncClient')
    const issued = freshAuth()
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ requestId: 999, status: 'pending', deviceAuth: issued })
    } as never)
    try {
      const client = new SyncClient()
      const err = await client
        .requestPairing('http://127.0.0.1:3999', undefined, {
          deviceId: 'd1',
          code: 'ABCDEFGH'
        })
        .then(
          () => null,
          (e: unknown) => e as Error & { deviceAuth?: unknown }
        )
      expect(err).not.toBeNull()
      expect(err?.deviceAuth).toBe(issued)
      expect(String(err?.message)).not.toContain(issued)
    } finally {
      spy.mockRestore()
    }
  })
})
