/**
 * Relay baseline v1 -> v2 transition (SYNC-DATA-056 §10B/§15):
 * same endpoint/single current row/GET verbatim; v1 current replaceable by v2
 * under the existing gate; once current v2, every v1 publish is 409
 * baseline-conflict; same-water idempotency/conflict, N>head, bad
 * envelope/digest unchanged; N+1 retention across the transition.
 */
import { createHash } from 'node:crypto'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import {
  COMPLETENESS_COMPLETE,
  computeSyncDigest,
  DIGEST_SCHEME,
  INVENTORY_VERSION,
  INVENTORY_VERSION_V2,
  ORDER_FRAME_VERSION,
  PAYLOAD_SCHEMA,
  PAYLOAD_SCHEMA_V2,
  SCOPE,
  SCOPE_V2,
  WIRE_VERSION,
  WIRE_VERSION_V2
} from '../../../packages/shared/sync/baselineWire'
import { createRelayServer, ensureRelaySchema } from '../server'

const TOKEN = 'baseline-v2-token'

let dbs: Database.Database[] = []
let servers: Array<{ close: (cb?: () => void) => void }> = []

function trackDb(db: Database.Database): Database.Database {
  dbs.push(db)
  return db
}

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

async function startServer(db: Database.Database): Promise<string> {
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
  // SYNC-CC-026: acceptor `a` holds the seed grant for holder-first PUT fixtures.
  let res = await fetch(`${base}/sync/pair/request`, {
    method: 'POST',
    headers: authed(b.code, b.secret),
    body: JSON.stringify({ targetCode: a.code })
  })
  expect(res.status).toBe(200)
  const reqBody = (await res.json()) as { requestId: string }
  res = await fetch(`${base}/sync/pair/accept`, {
    method: 'POST',
    headers: authed(a.code, a.secret),
    body: JSON.stringify({ requestId: reqBody.requestId })
  })
  expect(res.status).toBe(200)
  res = await fetch(`${base}/sync/state`, { headers: authed(a.code, a.secret) })
  const state = (await res.json()) as { channelId: string | null }
  return { a, b, channelId: state.channelId as string }
}

function hashHex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function v1Payload(): Record<string, unknown> {
  return {
    payloadSchema: PAYLOAD_SCHEMA,
    inventoryVersion: INVENTORY_VERSION,
    orderFrameVersion: ORDER_FRAME_VERSION,
    scope: SCOPE,
    topics: [],
    messages: [],
    messageBlocks: [],
    tombstones: [],
    orderFrames: [],
    manifest: {
      payloadSchema: PAYLOAD_SCHEMA,
      inventoryVersion: INVENTORY_VERSION,
      orderFrameVersion: ORDER_FRAME_VERSION,
      scope: SCOPE,
      liveCounts: { topic: 0, message: 0, messageBlock: 0 },
      tombstoneCounts: { topic: 0, message: 0, messageBlock: 0 },
      frameCounts: { topicMessage: 0, messageBlock: 0 },
      completeness: COMPLETENESS_COMPLETE
    }
  }
}

function v2Payload(registers: unknown[] = []): Record<string, unknown> {
  return {
    payloadSchema: PAYLOAD_SCHEMA_V2,
    inventoryVersion: INVENTORY_VERSION_V2,
    orderFrameVersion: ORDER_FRAME_VERSION,
    scope: SCOPE_V2,
    topics: [],
    messages: [],
    messageBlocks: [],
    tombstones: [],
    orderFrames: [],
    replacementRegisters: registers,
    manifest: {
      payloadSchema: PAYLOAD_SCHEMA_V2,
      inventoryVersion: INVENTORY_VERSION_V2,
      orderFrameVersion: ORDER_FRAME_VERSION,
      scope: SCOPE_V2,
      liveCounts: { topic: 0, message: 0, messageBlock: 0 },
      tombstoneCounts: { topic: 0, message: 0, messageBlock: 0 },
      frameCounts: { topicMessage: 0, messageBlock: 0 },
      replacementCount: registers.length,
      completeness: COMPLETENESS_COMPLETE
    }
  }
}

function v1Envelope(channelId: string, watermark: number): Record<string, unknown> {
  const payload = v1Payload()
  return {
    wireVersion: WIRE_VERSION,
    channelId,
    watermark,
    digestScheme: DIGEST_SCHEME,
    digest: computeSyncDigest(payload as never, hashHex),
    payload
  }
}

function v2Envelope(channelId: string, watermark: number, registers: unknown[] = []): Record<string, unknown> {
  const payload = v2Payload(registers)
  return {
    wireVersion: WIRE_VERSION_V2,
    channelId,
    watermark,
    digestScheme: DIGEST_SCHEME,
    digest: computeSyncDigest(payload as never, hashHex),
    payload
  }
}

async function putBaseline(base: string, caller: { code: string; secret: string }, body: string) {
  const res = await fetch(`${base}/sync/baseline`, { method: 'PUT', headers: authed(caller.code, caller.secret), body })
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, text, json }
}

describe('relay baseline v1->v2 transition', () => {
  it('v1 current is replaceable by v2 under the existing gate; GET persists v2 verbatim', async () => {
    const db = trackDb(new Database(':memory:'))
    const base = await startServer(db)
    const { a, channelId } = await pairDevices(base, 'v2-a1', 'v2-b1')
    const v1 = v1Envelope(channelId, 0)
    const put1 = await putBaseline(base, a, JSON.stringify(v1))
    expect(put1.status).toBe(200)
    const v2 = v2Envelope(channelId, 0, [
      { messageId: 'm-1', replacementClock: { timestamp: 10, operationId: 'op-1' }, activeBlockIds: [] }
    ])
    // Same-N divergent version is conflict (not idempotent across versions).
    const conflict = await putBaseline(base, a, JSON.stringify(v2))
    expect(conflict.status).toBe(409)
    expect(conflict.json).toEqual({ error: 'baseline-conflict' })
    // Higher-N v2 replaces v1 current.
    await fetch(`${base}/sync/push`, {
      method: 'POST',
      headers: authed(a.code, a.secret),
      body: JSON.stringify({
        deviceId: 'v2-a1',
        operations: [
          {
            id: 'op-n1',
            entityType: 'topic',
            op: 'upsert',
            entityId: 't-n1',
            timestamp: 1,
            deviceId: 'v2-a1',
            payload: { id: 't-n1', name: 'T' }
          }
        ]
      })
    })
    const v2Higher = v2Envelope(channelId, 1)
    const put2 = await putBaseline(base, a, JSON.stringify(v2Higher))
    expect(put2.status).toBe(200)
    const got = await fetch(`${base}/sync/baseline`, { headers: authed(a.code, a.secret) })
    expect(got.status).toBe(200)
    const body = await got.json()
    expect(body.wireVersion).toBe(WIRE_VERSION_V2)
    expect(body.payload.inventoryVersion).toBe(INVENTORY_VERSION_V2)
    expect(body.digest).toBe((put2.json as any).digest)
  })

  it('once current v2, every v1 publish is 409 and never downgrades', async () => {
    const db = trackDb(new Database(':memory:'))
    const base = await startServer(db)
    const { a, channelId } = await pairDevices(base, 'v2-a2', 'v2-b2')
    const v2 = v2Envelope(channelId, 0)
    const put = await putBaseline(base, a, JSON.stringify(v2))
    expect(put.status).toBe(200)
    for (const watermark of [0, 1, 5]) {
      const v1 = v1Envelope(channelId, watermark)
      const res = await putBaseline(base, a, JSON.stringify(v1))
      expect(res.status).toBe(409)
      expect(res.json).toEqual({ error: 'baseline-conflict' })
    }
    const got = await fetch(`${base}/sync/baseline`, { headers: authed(a.code, a.secret) })
    expect(got.status).toBe(200)
    const body = await got.json()
    expect(body.wireVersion).toBe(WIRE_VERSION_V2)
  })

  it('same-water idempotency/conflict, N>head, bad envelope/digest unchanged for v2', async () => {
    const db = trackDb(new Database(':memory:'))
    const base = await startServer(db)
    const { a, channelId } = await pairDevices(base, 'v2-a3', 'v2-b3')
    const v2 = v2Envelope(channelId, 0)
    const first = await putBaseline(base, a, JSON.stringify(v2))
    expect(first.status).toBe(200)
    const same = await putBaseline(base, a, JSON.stringify(v2))
    expect(same.status).toBe(200)
    expect(same.json).toEqual(first.json)
    const divergent = v2Envelope(channelId, 0, [
      { messageId: 'm-1', replacementClock: { timestamp: 1, operationId: 'op-1' }, activeBlockIds: [] }
    ])
    const conflict = await putBaseline(base, a, JSON.stringify(divergent))
    expect(conflict.status).toBe(409)
    expect(conflict.json).toEqual({ error: 'baseline-conflict' })
    const above = v2Envelope(channelId, 99)
    const aboveRes = await putBaseline(base, a, JSON.stringify(above))
    expect(aboveRes.status).toBe(400)
    expect(aboveRes.json).toEqual({ error: 'watermark-above-head' })
    const bad = await putBaseline(base, a, '{"wireVersion":"x"}')
    expect(bad.status).toBe(400)
    expect(bad.json).toEqual({ error: 'invalid-envelope' })
    const tampered = JSON.parse(JSON.stringify(v2))
    tampered.digest = '0'.repeat(64)
    const digestRes = await putBaseline(base, a, JSON.stringify(tampered))
    expect(digestRes.status).toBe(400)
    expect(digestRes.json).toEqual({ error: 'digest-mismatch' })
  })

  it('N+1 retention survives the v1->v2 transition', async () => {
    const db = trackDb(new Database(':memory:'))
    const base = await startServer(db)
    const { a, b, channelId } = await pairDevices(base, 'v2-a4', 'v2-b4')
    const push = await fetch(`${base}/sync/push`, {
      method: 'POST',
      headers: authed(a.code, a.secret),
      body: JSON.stringify({
        deviceId: 'v2-a4',
        operations: [
          {
            id: 'op-keep',
            entityType: 'topic',
            op: 'upsert',
            entityId: 't-keep',
            timestamp: 2,
            deviceId: 'v2-a4',
            payload: { id: 't-keep', name: 'Keep' }
          }
        ]
      })
    })
    expect(push.status).toBe(200)
    const v1 = v1Envelope(channelId, 0)
    expect((await putBaseline(base, a, JSON.stringify(v1))).status).toBe(200)
    const v2 = v2Envelope(channelId, 1)
    expect((await putBaseline(base, a, JSON.stringify(v2))).status).toBe(200)
    const pull = await fetch(`${base}/sync/pull?cursor=1&deviceId=${encodeURIComponent('v2-b4')}`, {
      headers: authed(b.code, b.secret)
    })
    expect(pull.status).toBe(200)
    const body = await pull.json()
    expect(Array.isArray(body.operations)).toBe(true)
  })
})
