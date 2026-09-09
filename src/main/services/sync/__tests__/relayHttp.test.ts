import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createRelayServer, ensureRelaySchema } from '../../../../../scripts/sync-relay/server'

describe('relay http hardening (channel protocol)', () => {
  let db: Database.Database
  let server: ReturnType<typeof createRelayServer>
  let baseUrl: string
  const token = 'test-token-123'
  // Registered + paired device codes for the data-plane tests.
  let codeA = ''
  let secretA = ''
  const uuidA = 'uuid-a'

  beforeAll(async () => {
    db = new Database(':memory:')
    ensureRelaySchema(db)
    server = createRelayServer(db, { token })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address() as { port: number }
    baseUrl = `http://127.0.0.1:${addr.port}`
    const authed = (init?: RequestInit): RequestInit => ({
      ...init,
      headers: { ...init?.headers, Authorization: `Bearer ${token}` }
    })
    // Register two devices and pair them: A <- B request, A accepts.
    // Registrations carry their real client device ids so the operation
    // identity binding (push deviceId === registered client id) holds.
    const regA = (await (
      await fetch(
        `${baseUrl}/sync/register`,
        authed({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: uuidA })
        })
      )
    ).json()) as { deviceCode: string; deviceSecret: string }
    const regB = (await (
      await fetch(
        `${baseUrl}/sync/register`,
        authed({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: 'uuid-b' })
        })
      )
    ).json()) as { deviceCode: string; deviceSecret: string }
    codeA = regA.deviceCode
    secretA = regA.deviceSecret
    const req = (await (
      await fetch(
        `${baseUrl}/sync/pair/request`,
        authed({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-sync-device-code': regB.deviceCode,
            'x-sync-device-secret': regB.deviceSecret
          },
          body: JSON.stringify({ targetCode: codeA })
        })
      )
    ).json()) as { requestId: string }
    const accept = await fetch(
      `${baseUrl}/sync/pair/accept`,
      authed({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-sync-device-code': codeA,
          'x-sync-device-secret': secretA
        },
        body: JSON.stringify({ requestId: req.requestId })
      })
    )
    expect(accept.status).toBe(200)
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    db.close()
  })

  async function push(ops: any[], withToken = true): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (withToken) headers['Authorization'] = `Bearer ${token}`
    headers['x-sync-device-code'] = codeA
    headers['x-sync-device-secret'] = secretA
    const res = await fetch(`${baseUrl}/sync/push`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ deviceId: uuidA, operations: ops })
    })
    return res
  }

  async function pull(cursor: number, withToken = true): Promise<Response> {
    const headers: Record<string, string> = {}
    if (withToken) headers['Authorization'] = `Bearer ${token}`
    headers['x-sync-device-code'] = codeA
    headers['x-sync-device-secret'] = secretA
    const res = await fetch(`${baseUrl}/sync/pull?cursor=${cursor}&deviceId=${uuidA}`, { headers })
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
          deviceId: uuidA,
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
        deviceId: uuidA,
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
        deviceId: uuidA,
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
        deviceId: uuidA,
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
      deviceId: uuidA,
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
        deviceId: uuidA,
        payload: largePayload
      }
    ])
    // Should be 413 or 400 due to payload too large (per-op or total)
    expect([400, 413]).toContain(res.status)
  })

  it('cursor paging: pull returns last seq actually returned, not channel max', async () => {
    // Clear the channel log and insert 250 ops directly.
    db.exec('DELETE FROM sync_channel_operations')
    const channelId = (
      db.prepare('SELECT channel_id FROM sync_memberships WHERE device_code = ?').get(codeA) as { channel_id: string }
    ).channel_id
    const insert = db.prepare(
      `INSERT INTO sync_channel_operations (channel_id, seq, id, entity_type, op, entity_id, timestamp, device_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (let i = 0; i < 250; i++) {
      insert.run(
        channelId,
        i + 1,
        `pg-${i}`,
        'topic',
        'upsert',
        `t-pg-${i}`,
        1000 + i,
        uuidA,
        JSON.stringify({ id: `t-pg-${i}`, name: `N${i}` }),
        new Date().toISOString()
      )
    }
    const res1 = await pull(0)
    expect(res1.status).toBe(200)
    const body1 = await res1.json()
    expect(body1.operations.length).toBe(200)
    expect(body1.cursor).toBe(body1.operations[199].seq)
    // Ensure cursor is not channel max (250)
    expect(body1.cursor).not.toBe(250)
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
    db.exec('DELETE FROM sync_channel_operations')
    const channelId = (
      db.prepare('SELECT channel_id FROM sync_memberships WHERE device_code = ?').get(codeA) as { channel_id: string }
    ).channel_id
    const insert = db.prepare(
      `INSERT INTO sync_channel_operations (channel_id, seq, id, entity_type, op, entity_id, timestamp, device_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (let i = 0; i < 5; i++) {
      insert.run(
        channelId,
        i + 1,
        `pre-${i}`,
        'topic',
        'upsert',
        `t-pre-${i}`,
        1000 + i,
        uuidA,
        JSON.stringify({ id: `t-pre-${i}` }),
        new Date().toISOString()
      )
    }
    // First pull
    const r1 = await pull(0)
    const b1 = await r1.json()
    expect(b1.operations.length).toBe(5)
    const cursorBeforePush = b1.cursor
    const pushRes = await push([
      {
        id: 'new-push-1',
        entityType: 'topic',
        op: 'upsert',
        entityId: 't-new',
        timestamp: Date.now(),
        deviceId: uuidA,
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
    db.exec('DELETE FROM sync_channel_operations')
    const op = {
      id: 'op-http-valid',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm1',
      timestamp: Date.now(),
      deviceId: uuidA,
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
