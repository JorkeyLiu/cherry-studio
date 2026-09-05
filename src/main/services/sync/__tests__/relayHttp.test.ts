import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createRelayServer } from '../../../../../scripts/sync-relay/server'

describe('relay http hardening', () => {
  let db: Database.Database
  let server: ReturnType<typeof createRelayServer>
  let baseUrl: string
  const token = 'test-token-123'

  beforeAll(async () => {
    db = new Database(':memory:')
    db.exec(`
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
    server = createRelayServer(db, { token })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address() as { port: number }
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    db.close()
  })

  async function push(ops: any[], withToken = true, deviceId = 'd1'): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (withToken) headers['Authorization'] = `Bearer ${token}`
    headers['x-sync-device-id'] = deviceId
    if (deviceAuthFor(deviceId)) headers['x-sync-device-auth'] = deviceAuthFor(deviceId) as string
    const res = await fetch(`${baseUrl}/sync/push`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ deviceId, operations: ops })
    })
    await captureDeviceAuth(deviceId, res.clone())
    return res
  }

  const deviceAuths = new Map<string, string>()
  function deviceAuthFor(deviceId: string): string | undefined {
    return deviceAuths.get(deviceId)
  }
  async function captureDeviceAuth(deviceId: string, res: Response): Promise<void> {
    try {
      const body = (await res.json()) as { deviceAuth?: unknown }
      if (typeof body?.deviceAuth === 'string') deviceAuths.set(deviceId, body.deviceAuth)
    } catch {}
  }

  async function pull(cursor: number, withToken = true, deviceId = 'd1'): Promise<Response> {
    const headers: Record<string, string> = {}
    if (withToken) headers['Authorization'] = `Bearer ${token}`
    headers['x-sync-device-id'] = deviceId
    if (deviceAuthFor(deviceId)) headers['x-sync-device-auth'] = deviceAuthFor(deviceId) as string
    const res = await fetch(`${baseUrl}/sync/pull?cursor=${cursor}&deviceId=${deviceId}`, { headers })
    await captureDeviceAuth(deviceId, res.clone())
    return res
  }

  it('rejects push without token when required', async () => {
    const res = await push(
      [
        {
          id: 'op-1',
          entityType: 'topic',
          op: 'upsert',
          entityId: 't1',
          timestamp: Date.now(),
          deviceId: 'd1',
          payload: { id: 't1', name: 'A' }
        }
      ],
      false
    )
    expect(res.status).toBe(401)
  })

  it('rejects pull without token', async () => {
    const res = await pull(0, false)
    expect(res.status).toBe(401)
  })

  it('rejects invalid entityType', async () => {
    const res = await push([
      {
        id: 'op-bad-entity',
        entityType: 'credential',
        op: 'upsert',
        entityId: 't1',
        timestamp: Date.now(),
        deviceId: 'd1',
        payload: { id: 't1' }
      }
    ])
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/invalid entityType/)
  })

  it('rejects payload with denied field', async () => {
    const res = await push([
      {
        id: 'op-deny',
        entityType: 'topic',
        op: 'upsert',
        entityId: 't1',
        timestamp: Date.now(),
        deviceId: 'd1',
        payload: { id: 't1', credentials: 'secret' }
      }
    ])
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/denied/)
  })

  it('rejects payload with non-allowlisted field', async () => {
    const res = await push([
      {
        id: 'op-nonallow',
        entityType: 'topic',
        op: 'upsert',
        entityId: 't1',
        timestamp: Date.now(),
        deviceId: 'd1',
        payload: { id: 't1', rogue: 'x' }
      }
    ])
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/not allowlisted/)
  })

  it('rejects too many operations per push', async () => {
    const ops = Array.from({ length: 201 }, (_, i) => ({
      id: `op-many-${i}`,
      entityType: 'topic',
      op: 'upsert',
      entityId: `t-${i}`,
      timestamp: Date.now() + i,
      deviceId: 'd1',
      payload: { id: `t-${i}`, name: 'X' }
    }))
    const res = await push(ops)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/too many/)
  })

  it('enforces body byte limit for push', async () => {
    const largePayload: Record<string, unknown> = { id: 't-large', name: 'A'.repeat(2.5 * 1024 * 1024) } as any
    const res = await push([
      {
        id: 'op-large',
        entityType: 'topic',
        op: 'upsert',
        entityId: 't-large',
        timestamp: Date.now(),
        deviceId: 'd1',
        payload: largePayload
      }
    ])
    // Should be 413 or 400 due to payload too large (per-op or total)
    expect([400, 413]).toContain(res.status)
  })

  it('cursor paging: pull returns last seq actually returned, not global max', async () => {
    // Clear and insert 250 ops
    db.exec('DELETE FROM operations')
    // Reset autoincrement
    db.exec("DELETE FROM sqlite_sequence WHERE name='operations'")
    const insert = db.prepare(
      `INSERT INTO operations (id, entity_type, op, entity_id, timestamp, device_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (let i = 0; i < 250; i++) {
      insert.run(
        `pg-${i}`,
        'topic',
        'upsert',
        `t-pg-${i}`,
        1000 + i,
        'd1',
        JSON.stringify({ id: `t-pg-${i}`, name: `N${i}` }),
        new Date().toISOString()
      )
    }
    const res1 = await pull(0)
    expect(res1.status).toBe(200)
    const body1 = await res1.json()
    expect(body1.operations.length).toBe(200)
    expect(body1.cursor).toBe(body1.operations[199].seq)
    // Ensure cursor is not global max (250)
    const maxSeqRow = db.prepare('SELECT MAX(seq) as m FROM operations').get() as { m: number }
    expect(maxSeqRow.m).toBe(250)
    expect(body1.cursor).not.toBe(maxSeqRow.m)
    expect(body1.cursor).toBe(200)

    const res2 = await pull(body1.cursor)
    expect(res2.status).toBe(200)
    const body2 = await res2.json()
    expect(body2.operations.length).toBe(50)
    expect(body2.cursor).toBe(250)
    // Pull beyond max returns empty with same cursor
    const res3 = await pull(250)
    const body3 = await res3.json()
    expect(body3.operations.length).toBe(0)
    expect(body3.cursor).toBe(250)
  })

  it('push does not advance pull cursor beyond returned page (simulated)', async () => {
    db.exec('DELETE FROM operations')
    db.exec("DELETE FROM sqlite_sequence WHERE name='operations'")
    const insert = db.prepare(
      `INSERT INTO operations (id, entity_type, op, entity_id, timestamp, device_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (let i = 0; i < 5; i++) {
      insert.run(
        `pre-${i}`,
        'topic',
        'upsert',
        `t-pre-${i}`,
        1000 + i,
        'd1',
        JSON.stringify({ id: `t-pre-${i}` }),
        new Date().toISOString()
      )
    }
    // First pull
    const r1 = await pull(0)
    const b1 = await r1.json()
    expect(b1.operations.length).toBe(5)
    const cursorBeforePush = b1.cursor
    // Push new op (seq 6) as the same bootstrap device (cross-device push
    // requires pairing under device-identity binding).
    const pushRes = await push([
      {
        id: 'new-push-1',
        entityType: 'topic',
        op: 'upsert',
        entityId: 't-new',
        timestamp: Date.now(),
        deviceId: 'd1',
        payload: { id: 't-new', name: 'New' }
      }
    ])
    expect(pushRes.status).toBe(200)
    const pushBody = await pushRes.json()
    expect(pushBody.acceptedIds).toContain('new-push-1')
    // Pull from previous cursor should return the newly pushed op, not skip
    const r2 = await pull(cursorBeforePush)
    const b2 = await r2.json()
    expect(b2.operations.some((o: any) => o.id === 'new-push-1')).toBe(true)
  })

  it('actual HTTP push/pull with valid payload succeeds', async () => {
    db.exec('DELETE FROM operations')
    db.exec("DELETE FROM sqlite_sequence WHERE name='operations'")
    const op = {
      id: 'op-http-valid',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm1',
      timestamp: Date.now(),
      deviceId: 'd1',
      payload: { id: 'm1', topicId: 't1', role: 'user', content: 'hi' }
    }
    const pr = await push([op])
    expect(pr.status).toBe(200)
    const pb = await pr.json()
    expect(pb.acceptedIds).toContain('op-http-valid')
    const pullRes = await pull(0)
    expect(pullRes.status).toBe(200)
    const pullBody = await pullRes.json()
    expect(pullBody.operations.some((o: any) => o.id === 'op-http-valid')).toBe(true)
  })
})
