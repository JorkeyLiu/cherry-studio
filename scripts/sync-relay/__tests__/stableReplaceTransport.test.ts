/**
 * Relay data-plane transport for `message_stable_replace` (SYNC-CC-025 /
 * SYNC-DATA-057) on the real reference relay (`createRelayServer`):
 * existing `POST /sync/push` + `GET /sync/pull` with no new endpoint and no
 * relay schema migration. Legal ops accepted; illegal rejected 400;
 * divergent same-id collision 409 with the current row unchanged; identical
 * replay idempotent 200 with no cursor growth; existing 512KiB serialized-op
 * / 2MiB body / 200-ops limits enforced (413 for oversize bodies); pull
 * replays the persisted payload byte-identically (verbatim).
 */
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import { createRelayServer, ensureRelaySchema } from '../server'

const TOKEN = 'stable-replace-transport-token'

let dbs: Database.Database[] = []
let servers: Array<{ close: (cb?: () => void) => void }> = []

afterEach(async () => {
  for (const s of servers) {
    try {
      await new Promise<void>((resolve) => {
        try {
          s.close(() => resolve())
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

async function startServer(): Promise<string> {
  const db = new Database(':memory:')
  dbs.push(db)
  ensureRelaySchema(db)
  const server = createRelayServer(db, { token: TOKEN })
  servers.push(server as unknown as { close: (cb?: () => void) => void })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address() as { port: number }
  return `http://127.0.0.1:${addr.port}`
}

function authed(code: string, secret: string): Record<string, string> {
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

async function pairDevices(base: string, aId: string, bId: string) {
  const a = await register(base, aId)
  const b = await register(base, bId)
  let res = await fetch(`${base}/sync/pair/request`, {
    method: 'POST',
    headers: authed(a.code, a.secret),
    body: JSON.stringify({ targetCode: b.code })
  })
  expect(res.status).toBe(200)
  const reqBody = (await res.json()) as { requestId: string }
  res = await fetch(`${base}/sync/pair/accept`, {
    method: 'POST',
    headers: authed(b.code, b.secret),
    body: JSON.stringify({ requestId: reqBody.requestId })
  })
  expect(res.status).toBe(200)
  return { a, b }
}

function clock(ts: number, opId: string): Record<string, unknown> {
  return { timestamp: ts, operationId: opId }
}

const MESSAGE_FIELDS = [
  'role',
  'content',
  'status',
  'askId',
  'model',
  'modelId',
  'assistantId',
  'createdAt',
  'updatedAt'
]
const BLOCK_FIELDS = ['type', 'content', 'status', 'createdAt', 'updatedAt']

function fieldClocks(keys: string[], ts: number, opId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) out[k] = clock(ts, opId)
  return out
}

function makeStableReplaceOp(args: {
  id: string
  timestamp: number
  deviceId: string
  content?: string
}): Record<string, unknown> {
  const { id, timestamp, deviceId } = args
  const content = args.content ?? 'final answer'
  return {
    id,
    entityType: 'message',
    op: 'message_stable_replace',
    entityId: 'm-1',
    timestamp,
    deviceId,
    payload: {
      replaceVersion: 'message-stable-replace-v1',
      messageId: 'm-1',
      replacementClock: clock(timestamp, id),
      message: {
        id: 'm-1',
        topicId: 't-1',
        role: 'assistant',
        content,
        status: 'success',
        askId: 'a-1',
        model: 'm',
        modelId: 'mid',
        assistantId: 'as-1',
        createdAt: '2026-09-12T00:00:00.000Z',
        updatedAt: '2026-09-12T00:00:01.000Z',
        entityClock: clock(timestamp, id),
        fieldClocks: fieldClocks(MESSAGE_FIELDS, timestamp, id),
        parentMembershipClock: clock(900, 'create-op-1')
      },
      messageBlocks: [
        {
          id: 'b-1',
          messageId: 'm-1',
          type: 'text',
          content: 'block one',
          status: 'success',
          createdAt: '2026-09-12T00:00:00.000Z',
          updatedAt: '2026-09-12T00:00:01.000Z',
          entityClock: clock(timestamp, id),
          fieldClocks: fieldClocks(BLOCK_FIELDS, timestamp, id),
          parentMembershipClock: clock(950, 'create-b-1')
        }
      ],
      activeBlockIds: ['b-1'],
      topicFrame: {
        frameVersion: 'parent-order-frame-v1',
        kind: 'topicMessage',
        parentId: 't-1',
        orderedChildIds: ['m-1'],
        frameClock: clock(timestamp, id)
      },
      messageFrame: {
        frameVersion: 'parent-order-frame-v1',
        kind: 'messageBlock',
        parentId: 'm-1',
        orderedChildIds: ['b-1'],
        frameClock: clock(timestamp, id)
      }
    }
  }
}

async function pushRaw(
  base: string,
  caller: { code: string; secret: string },
  deviceId: string,
  ops: unknown[],
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}/sync/push`, {
    method: 'POST',
    headers: { ...authed(caller.code, caller.secret), ...extraHeaders },
    body: JSON.stringify({ deviceId, operations: ops })
  })
  return { status: res.status, text: await res.text() }
}

async function pullRaw(
  base: string,
  caller: { code: string; secret: string },
  deviceId: string,
  cursor: number
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/sync/pull?cursor=${cursor}&deviceId=${encodeURIComponent(deviceId)}`, {
    headers: authed(caller.code, caller.secret)
  })
  const text = await res.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = { _raw: text }
  }
  return { status: res.status, body }
}

describe('message_stable_replace relay transport (real reference relay)', () => {
  it('accepts a legal op and replays it byte-identically', async () => {
    const base = await startServer()
    const { a, b } = await pairDevices(base, 'dev-a-1', 'dev-b-1')
    const op = makeStableReplaceOp({ id: 'rep-op-1', timestamp: 1000, deviceId: 'dev-a-1' })
    const pushed = await pushRaw(base, a, 'dev-a-1', [op])
    expect(pushed.status).toBe(200)
    const first = JSON.parse(pushed.text) as { cursor: number; acceptedIds: string[] }
    expect(first.acceptedIds).toEqual(['rep-op-1'])
    expect(first.cursor).toBe(1)
    const pulled = await pullRaw(base, b, 'dev-b-1', 0)
    expect(pulled.status).toBe(200)
    const ops = pulled.body.operations as Array<Record<string, unknown>>
    expect(ops).toHaveLength(1)
    expect(ops[0].id).toBe('rep-op-1')
    expect(ops[0].op).toBe('message_stable_replace')
    // Verbatim replay: persisted payload round-trips identically.
    expect(ops[0].payload).toEqual(op.payload)
    // Representation-level verbatim proof: identical serialized form,
    // not only deep equality (key order and values preserved byte-wise
    // through relay persist + replay).
    expect(JSON.stringify(ops[0].payload)).toBe(JSON.stringify(op.payload))
    // Full op verbatim proof apart from the relay-assigned seq.
    const replayedOp = { ...ops[0] }
    delete replayedOp.seq
    expect(JSON.stringify(replayedOp)).toBe(JSON.stringify(op))
    expect(pulled.body.cursor).toBe(1)
  })

  it('rejects illegal ops with 400 (unknown version, bad binding, transient status)', async () => {
    const base = await startServer()
    const { a } = await pairDevices(base, 'dev-a-2', 'dev-b-2')
    const badVersion = makeStableReplaceOp({ id: 'rep-bad-1', timestamp: 1000, deviceId: 'dev-a-2' })
    ;(badVersion.payload as Record<string, unknown>).replaceVersion = 'message-stable-replace-v2'
    const r1 = await pushRaw(base, a, 'dev-a-2', [badVersion])
    expect(r1.status).toBe(400)
    const badBinding = makeStableReplaceOp({ id: 'rep-bad-2', timestamp: 1000, deviceId: 'dev-a-2' })
    badBinding.entityType = 'topic'
    const r2 = await pushRaw(base, a, 'dev-a-2', [badBinding])
    expect(r2.status).toBe(400)
    const transient = makeStableReplaceOp({ id: 'rep-bad-3', timestamp: 1000, deviceId: 'dev-a-2' })
    ;((transient.payload as Record<string, unknown>).message as Record<string, unknown>).status = 'streaming'
    const r3 = await pushRaw(base, a, 'dev-a-2', [transient])
    expect(r3.status).toBe(400)
    // Nothing persisted: pull from 0 is empty with cursor 0.
    const pulled = await pullRaw(base, a, 'dev-a-2', 0)
    expect(pulled.status).toBe(200)
    expect(pulled.body.operations).toEqual([])
    expect(pulled.body.cursor).toBe(0)
  })

  it('divergent same-id collision is 409 with the current row unchanged', async () => {
    const base = await startServer()
    const { a, b } = await pairDevices(base, 'dev-a-3', 'dev-b-3')
    const first = makeStableReplaceOp({ id: 'rep-dup-1', timestamp: 1000, deviceId: 'dev-a-3', content: 'v1' })
    const p1 = await pushRaw(base, a, 'dev-a-3', [first])
    expect(p1.status).toBe(200)
    const cursorAfterFirst = (JSON.parse(p1.text) as { cursor: number }).cursor
    const divergent = makeStableReplaceOp({ id: 'rep-dup-1', timestamp: 1000, deviceId: 'dev-a-3', content: 'v2' })
    const p2 = await pushRaw(base, a, 'dev-a-3', [divergent])
    expect(p2.status).toBe(409)
    // Row unchanged: pull still shows v1 with the original cursor.
    const pulled = await pullRaw(base, b, 'dev-b-3', 0)
    expect(pulled.status).toBe(200)
    const ops = pulled.body.operations as Array<Record<string, unknown>>
    expect(ops).toHaveLength(1)
    expect(((ops[0].payload as Record<string, unknown>).message as Record<string, unknown>).content).toBe('v1')
    expect(pulled.body.cursor).toBe(cursorAfterFirst)
  })

  it('identical replay is idempotent 200 with no cursor growth', async () => {
    const base = await startServer()
    const { a } = await pairDevices(base, 'dev-a-4', 'dev-b-4')
    const op = makeStableReplaceOp({ id: 'rep-idem-1', timestamp: 1000, deviceId: 'dev-a-4' })
    const p1 = await pushRaw(base, a, 'dev-a-4', [op])
    expect(p1.status).toBe(200)
    const c1 = (JSON.parse(p1.text) as { cursor: number }).cursor
    const replay = makeStableReplaceOp({ id: 'rep-idem-1', timestamp: 1000, deviceId: 'dev-a-4' })
    const p2 = await pushRaw(base, a, 'dev-a-4', [replay])
    expect(p2.status).toBe(200)
    const body2 = JSON.parse(p2.text) as { cursor: number; acceptedIds: string[] }
    expect(body2.acceptedIds).toEqual(['rep-idem-1'])
    expect(body2.cursor).toBe(c1)
    const pulled = await pullRaw(base, a, 'dev-a-4', 0)
    expect(pulled.body.operations as unknown[]).toHaveLength(1)
  })

  it('enforces existing limits: >200 ops rejected, oversize body 413', async () => {
    const base = await startServer()
    const { a } = await pairDevices(base, 'dev-a-5', 'dev-b-5')
    const many: unknown[] = []
    for (let i = 0; i < 201; i++) {
      many.push({
        id: `flood-${i}`,
        entityType: 'topic',
        op: 'upsert',
        entityId: `flood-topic-${i}`,
        timestamp: 1000 + i,
        deviceId: 'dev-a-5',
        payload: { id: `flood-topic-${i}`, name: 'x' }
      })
    }
    const tooMany = await pushRaw(base, a, 'dev-a-5', many)
    expect(tooMany.status).toBe(400)
    // Oversize body (>2MiB) is truthfully 413 with no partial persist.
    const big = makeStableReplaceOp({
      id: 'rep-big-1',
      timestamp: 1000,
      deviceId: 'dev-a-5',
      content: 'x'.repeat(3 * 1024 * 1024)
    })
    const oversize = await pushRaw(base, a, 'dev-a-5', [big])
    expect(oversize.status).toBe(413)
    const pulled = await pullRaw(base, a, 'dev-a-5', 0)
    expect(pulled.body.operations).toEqual([])
  })

  it('oversize serialized op payload (>512KiB) is rejected with no partial persist', async () => {
    const base = await startServer()
    const { a } = await pairDevices(base, 'dev-a-6', 'dev-b-6')
    // ~600KiB content stays under the 2MiB body limit but exceeds the
    // 512KiB per-op serialized payload limit (existing relay behavior).
    const big = makeStableReplaceOp({
      id: 'rep-bigop-1',
      timestamp: 1000,
      deviceId: 'dev-a-6',
      content: 'y'.repeat(600 * 1024)
    })
    const res = await pushRaw(base, a, 'dev-a-6', [big])
    expect(res.status).toBe(400)
    expect(res.text).toContain('payload too large')
    const pulled = await pullRaw(base, a, 'dev-a-6', 0)
    expect(pulled.body.operations).toEqual([])
  })
})
