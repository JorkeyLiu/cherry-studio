import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { startTestRelay, type TestRelayHandle } from './sync-relay'

const TOKEN = 'batch-atomicity-token'

function topicOp(id: string, entityId: string, name = 'N', ts = Date.now()): Record<string, unknown> {
  return {
    id,
    entityType: 'topic',
    op: 'upsert',
    entityId,
    timestamp: ts,
    deviceId: 'd1',
    payload: { id: entityId, name }
  }
}

let relay: TestRelayHandle | null = null

beforeEach(async () => {
  relay = await startTestRelay(TOKEN)
  deviceAuth = undefined
})

afterEach(async () => {
  if (relay) {
    await relay.close()
    relay = null
  }
})

async function push(ops: Record<string, unknown>[]): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${TOKEN}`,
    'x-sync-device-id': 'd1'
  }
  if (deviceAuth) headers['x-sync-device-auth'] = deviceAuth
  const res = await fetch(`${relay!.endpoint}/sync/push`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ deviceId: 'd1', operations: ops })
  })
  const body = await res.json().catch(() => ({}))
  if (typeof body?.deviceAuth === 'string') deviceAuth = body.deviceAuth
  return { status: res.status, body }
}

let deviceAuth: string | undefined

async function pull(cursor = 0): Promise<any> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    'x-sync-device-id': 'd1'
  }
  if (deviceAuth) headers['x-sync-device-auth'] = deviceAuth
  const res = await fetch(`${relay!.endpoint}/sync/pull?cursor=${cursor}&deviceId=d1`, {
    headers
  })
  expect(res.status).toBe(200)
  const body = await res.json()
  if (typeof body?.deviceAuth === 'string') deviceAuth = body.deviceAuth
  return body
}

describe('test relay batch atomicity (LOCK-RT-005/006)', () => {
  it('rejected 409 batch commits no partial ops and does not advance sequence', async () => {
    const ts = Date.now()
    // Seed one op so a later collision is against committed state.
    const seed = await push([topicOp('op-seed-1', 't-seed', 'Seed', ts)])
    expect(seed.status).toBe(200)
    expect(seed.body.cursor).toBe(1)

    // Batch: two fresh ops followed by a colliding id with different content.
    const batch = [
      topicOp('op-batch-a', 't-a', 'A', ts + 1),
      topicOp('op-batch-b', 't-b', 'B', ts + 2),
      { ...topicOp('op-seed-1', 't-seed', 'MISMATCH', ts + 3) }
    ]
    const rejected = await push(batch)
    expect(rejected.status).toBe(409)

    // No partial commit: pull from 0 returns only the seed.
    const pulled = await pull(0)
    expect(pulled.operations.map((o: any) => o.id)).toEqual(['op-seed-1'])
    expect(pulled.cursor).toBe(1)

    // Sequence did not advance: a fresh push gets seq 2.
    const after = await push([topicOp('op-after', 't-after', 'After', ts + 4)])
    expect(after.status).toBe(200)
    expect(after.body.cursor).toBe(2)
    const pulled2 = await pull(0)
    expect(pulled2.operations.map((o: any) => o.id)).toEqual(['op-seed-1', 'op-after'])
  })

  it('duplicate id within the same batch with mismatched content rejects atomically', async () => {
    const ts = Date.now()
    const batch = [topicOp('op-dup', 't-dup', 'First', ts), { ...topicOp('op-dup', 't-dup', 'Second', ts + 1) }]
    const rejected = await push(batch)
    expect(rejected.status).toBe(409)
    const pulled = await pull(0)
    expect(pulled.operations).toEqual([])
    expect(pulled.cursor).toBe(0)
  })

  it('identical replay within batch is idempotent and commits once', async () => {
    const ts = Date.now()
    const op = topicOp('op-replay', 't-replay', 'R', ts)
    const res = await push([op, { ...op }])
    expect(res.status).toBe(200)
    expect(res.body.acceptedIds).toEqual(['op-replay', 'op-replay'])
    const pulled = await pull(0)
    expect(pulled.operations.length).toBe(1)
    expect(pulled.cursor).toBe(1)
  })
})
