/**
 * Relay pairing atomicity (SYNC-CC findings 1-3):
 * - ensureRelaySchema never drops current sync_pair_requests; legacy tables
 *   are removed once via a version marker, pending rows survive restarts.
 * - Single outgoing pending is enforced by a partial unique index plus a
 *   single-transaction read/replace/insert; concurrent different-target
 *   requests cannot leave two pendings.
 * - accept/cancel/reject/replace terminal transitions are CAS
 *   (status='pending'); accepted rows are never overwritten, cancelled/
 *   rejected/replaced rows are never accepted, membership + accepted commit
 *   atomically.
 */
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createRelayServer, ensureRelaySchema } from '../server'

const TOKEN = 'atomicity-token'

let dbs: Database.Database[] = []
let servers: Array<{ close: () => void }> = []

function openDb(): Database.Database {
  const db = new Database(':memory:')
  dbs.push(db)
  return db
}

afterEach(async () => {
  for (const s of servers) {
    try {
      await new Promise<void>((resolve) => {
        try {
          ;(s as unknown as { close: (cb?: () => void) => void }).close(() => resolve())
        } catch {
          resolve()
        }
      })
    } catch {}
  }
  servers = []
  for (const db of dbs) {
    try {
      db.close()
    } catch {}
  }
  dbs = []
})

async function startServer(db: Database.Database): Promise<string> {
  ensureRelaySchema(db)
  const server = createRelayServer(db, { token: TOKEN })
  servers.push(server as unknown as { close: () => void })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address() as { port: number }
  return `http://127.0.0.1:${addr.port}`
}

function authHeaders(code: string, secret: string): Record<string, string> {
  return {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    'x-sync-device-code': code,
    'x-sync-device-secret': secret
  }
}

async function register(base: string, deviceId: string): Promise<{ code: string; secret: string }> {
  const res = await fetch(`${base}/sync/register`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId })
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { deviceCode: string; deviceSecret: string }
  return { code: body.deviceCode, secret: body.deviceSecret }
}

describe('relay pairing atomicity', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openDb()
  })

  it('pending requests survive ensureRelaySchema restarts; legacy tables reset once', () => {
    // Simulate a pre-cc-1 legacy DB: old global operations plus superseded
    // invite/founder/trust tables, with no version marker yet. The one-time
    // reset must delete exactly these legacy objects on the first ensure.
    db.exec(`CREATE TABLE operations (id TEXT); INSERT INTO operations (id) VALUES ('legacy-1');`)
    db.exec(
      `CREATE TABLE sync_trusted_devices (device_id TEXT PRIMARY KEY); INSERT INTO sync_trusted_devices (device_id) VALUES ('legacy-dev');`
    )
    db.exec(`CREATE TABLE sync_pairing_invites (code TEXT PRIMARY KEY);`)
    db.exec(`CREATE TABLE sync_pairing_requests (id TEXT PRIMARY KEY);`)
    ensureRelaySchema(db)
    for (const legacy of ['operations', 'sync_trusted_devices', 'sync_pairing_invites', 'sync_pairing_requests']) {
      const found = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(legacy) as
        | { name: string }
        | undefined
      expect(found).toBeUndefined()
    }
    // Current tables exist and were never dropped; marker is recorded once.
    const current = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'sync_pair_requests'")
      .get() as { name: string } | undefined
    expect(current?.name).toBe('sync_pair_requests')
    const metaFirst = db.prepare('SELECT value FROM relay_schema_meta WHERE key = ?').get('schema_version') as
      | { value: string }
      | undefined
    expect(metaFirst?.value).toBe('cc-2')
    // Pending rows survive restarts: current state is never deleted per call.
    db.prepare(
      "INSERT INTO sync_pair_requests (id, requester_code, target_code, status, created_at) VALUES (?, ?, ?, 'pending', ?)"
    ).run('req-1', 'AAAAAAAA', 'BBBBBBBB', new Date().toISOString())
    ensureRelaySchema(db)
    ensureRelaySchema(db)
    const row = db.prepare('SELECT id FROM sync_pair_requests WHERE id = ?').get('req-1') as { id: string } | undefined
    expect(row?.id).toBe('req-1')
    const legacy = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='operations'").get() as
      | { name: string }
      | undefined
    expect(legacy).toBeUndefined()
    const meta = db.prepare('SELECT value FROM relay_schema_meta WHERE key = ?').get('schema_version') as
      | { value: string }
      | undefined
    expect(meta?.value).toBe('cc-2')
  })

  it('partial unique index forbids two pendings for one requester', () => {
    ensureRelaySchema(db)
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO sync_pair_requests (id, requester_code, target_code, status, created_at) VALUES (?, ?, ?, 'pending', ?)"
    ).run('r1', 'AAAAAAAA', 'BBBBBBBB', now)
    expect(() =>
      db
        .prepare(
          "INSERT INTO sync_pair_requests (id, requester_code, target_code, status, created_at) VALUES (?, ?, ?, 'pending', ?)"
        )
        .run('r2', 'AAAAAAAA', 'CCCCCCCC', now)
    ).toThrow(/UNIQUE/i)
  })

  it('concurrent different-target requests leave a single pending (HTTP)', async () => {
    const base = await startServer(db)
    const a = await register(base, 'dev-a')
    const b = await register(base, 'dev-b')
    const c = await register(base, 'dev-c')
    const [r1, r2] = await Promise.all([
      fetch(`${base}/sync/pair/request`, {
        method: 'POST',
        headers: authHeaders(b.code, b.secret),
        body: JSON.stringify({ targetCode: a.code })
      }),
      fetch(`${base}/sync/pair/request`, {
        method: 'POST',
        headers: authHeaders(b.code, b.secret),
        body: JSON.stringify({ targetCode: c.code })
      })
    ])
    const statuses = [r1.status, r2.status].sort()
    // One winner (200), the loser is either replaced-winner (200 with a new
    // id, old replaced) or an explicit 409 — but never two pendings.
    expect(statuses[0]).toBe(200)
    expect([200, 409]).toContain(statuses[1])
    const pendings = db
      .prepare("SELECT COUNT(*) as n FROM sync_pair_requests WHERE requester_code = ? AND status='pending'")
      .get(b.code) as { n: number }
    expect(pendings.n).toBe(1)
    void a
  })

  it('terminal transitions are CAS: accept-after-cancel and double-accept fail', async () => {
    const base = await startServer(db)
    const a = await register(base, 'dev-a')
    const b = await register(base, 'dev-b')
    const req = (await (
      await fetch(`${base}/sync/pair/request`, {
        method: 'POST',
        headers: authHeaders(b.code, b.secret),
        body: JSON.stringify({ targetCode: a.code })
      })
    ).json()) as { requestId: string }
    expect(typeof req.requestId).toBe('string')
    // Cancel then accept must fail with terminal 410, no membership created.
    const cancel = await fetch(`${base}/sync/pair/cancel`, {
      method: 'POST',
      headers: authHeaders(b.code, b.secret),
      body: JSON.stringify({ requestId: req.requestId })
    })
    expect(cancel.status).toBe(200)
    const acceptAfterCancel = await fetch(`${base}/sync/pair/accept`, {
      method: 'POST',
      headers: authHeaders(a.code, a.secret),
      body: JSON.stringify({ requestId: req.requestId })
    })
    expect(acceptAfterCancel.status).toBe(410)
    const stateA = (await (
      await fetch(`${base}/sync/state`, {
        headers: { Authorization: `Bearer ${TOKEN}`, 'x-sync-device-code': a.code, 'x-sync-device-secret': a.secret }
      })
    ).json()) as { paired: boolean }
    expect(stateA.paired).toBe(false)
    // Fresh request -> accept -> second accept/cancel/reject all terminal.
    const req2 = (await (
      await fetch(`${base}/sync/pair/request`, {
        method: 'POST',
        headers: authHeaders(b.code, b.secret),
        body: JSON.stringify({ targetCode: a.code })
      })
    ).json()) as { requestId: string }
    expect(typeof req2.requestId).toBe('string')
    const accept = await fetch(`${base}/sync/pair/accept`, {
      method: 'POST',
      headers: authHeaders(a.code, a.secret),
      body: JSON.stringify({ requestId: req2.requestId })
    })
    expect(accept.status).toBe(200)
    const acceptAgain = await fetch(`${base}/sync/pair/accept`, {
      method: 'POST',
      headers: authHeaders(a.code, a.secret),
      body: JSON.stringify({ requestId: req2.requestId })
    })
    expect(acceptAgain.status).toBe(410)
    const cancelAfterAccept = await fetch(`${base}/sync/pair/cancel`, {
      method: 'POST',
      headers: authHeaders(b.code, b.secret),
      body: JSON.stringify({ requestId: req2.requestId })
    })
    expect([404, 410]).toContain(cancelAfterAccept.status)
    const rejectAfterAccept = await fetch(`${base}/sync/pair/reject`, {
      method: 'POST',
      headers: authHeaders(a.code, a.secret),
      body: JSON.stringify({ requestId: req2.requestId })
    })
    expect(rejectAfterAccept.status).toBe(410)
  })
})
