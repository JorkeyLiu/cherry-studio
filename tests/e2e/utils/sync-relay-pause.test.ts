import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  provisionPairedDevices,
  provisionedHeaders,
  startTestRelay,
  type ProvisionedDevice,
  type TestRelayHandle
} from './sync-relay'

const TOKEN = 'pause-precedence-token'

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

let dev: ProvisionedDevice | null = null

beforeEach(async () => {
  relay = await startTestRelay(TOKEN)
  dev = (await provisionPairedDevices(relay.endpoint, TOKEN, 2))[0]
})

afterEach(async () => {
  try {
    relay?.setPaused(false)
  } catch {}
  try {
    relay?.setPushPaused(false)
  } catch {}
  try {
    relay?.setPullPaused(false)
  } catch {}
  if (relay) {
    await relay.close()
    relay = null
  }
})

async function pushRaw(ops: Record<string, unknown>[], token: string | null): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...provisionedHeaders(dev!) }
  if (token !== null) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${relay!.endpoint}/sync/push`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ deviceId: 'd1', operations: ops })
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

async function pullRaw(cursor = 0, token: string | null = TOKEN): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { ...provisionedHeaders(dev!) }
  if (token !== null) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${relay!.endpoint}/sync/pull?cursor=${cursor}&deviceId=d1`, { headers })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

describe('test relay pause precedence and determinism (LOCK-007)', () => {
  it('invalid/missing auth stays 401 while paused for both push and pull', async () => {
    relay!.setPaused(true)
    expect(relay!.isPaused()).toBe(true)

    const pushNoAuth = await pushRaw([topicOp('op-pause-auth-1', 't-pause-auth-1')], null)
    expect(pushNoAuth.status).toBe(401)

    const pushBadAuth = await pushRaw([topicOp('op-pause-auth-2', 't-pause-auth-2')], 'wrong-token')
    expect(pushBadAuth.status).toBe(401)

    const pullNoAuth = await pullRaw(0, null)
    expect(pullNoAuth.status).toBe(401)

    const pullBadAuth = await pullRaw(0, 'wrong-token')
    expect(pullBadAuth.status).toBe(401)

    // Rejected auth attempts never touch the log or cursor.
    await relay!.waitForQuiescent()
    expect(relay!.getCursor()).toBe(0)
    expect(relay!.getOperationCount()).toBe(0)
  })

  it('authenticated push and pull are 503 while paused with unchanged counters', async () => {
    const ts = Date.now()
    const seed = await pushRaw([topicOp('op-pause-seed', 't-pause-seed', 'Seed', ts)], TOKEN)
    expect(seed.status).toBe(200)
    await relay!.waitForQuiescent()
    const cursorBefore = relay!.getCursor()
    const opsBefore = relay!.getOperationCount()
    expect(cursorBefore).toBe(1)
    expect(opsBefore).toBe(1)

    relay!.setPaused(true)
    const pushPaused = await pushRaw([topicOp('op-pause-held', 't-pause-held', 'Held', ts + 1)], TOKEN)
    expect(pushPaused.status).toBe(503)
    const pullPaused = await pullRaw(0, TOKEN)
    expect(pullPaused.status).toBe(503)

    // Pause fails closed: no new ops, no cursor motion.
    await relay!.waitForQuiescent()
    expect(relay!.getCursor()).toBe(cursorBefore)
    expect(relay!.getOperationCount()).toBe(opsBefore)
  })

  it('pull barrier blocks pulls while pushes still commit (auth still 401-first)', async () => {
    const ts = Date.now()
    const seed = await pushRaw([topicOp('op-dir-seed', 't-dir-seed', 'Seed', ts)], TOKEN)
    expect(seed.status).toBe(200)
    await relay!.waitForQuiescent()
    const cursorBefore = relay!.getCursor()

    relay!.setPullPaused(true)
    expect(relay!.isPullPaused()).toBe(true)
    expect(relay!.isPushPaused()).toBe(false)
    expect(relay!.isPaused()).toBe(false)

    // Push stays open: commits and advances ops/cursor.
    const pushed = await pushRaw([topicOp('op-dir-push-open', 't-dir-push-open', 'Open', ts + 1)], TOKEN)
    expect(pushed.status).toBe(200)
    await relay!.waitForQuiescent()
    expect(relay!.getCursor()).toBeGreaterThan(cursorBefore)
    expect(relay!.getOperationCount()).toBe(2)

    // Pull stays gated: authenticated pull is 503, log/cursor untouched.
    const pulled = await pullRaw(0, TOKEN)
    expect(pulled.status).toBe(503)
    await relay!.waitForQuiescent()
    expect(relay!.getCursor()).toBe(cursorBefore + 1)

    // Auth precedence holds under the independent barrier.
    const badPush = await pushRaw([topicOp('op-dir-bad', 't-dir-bad')], 'wrong-token')
    expect(badPush.status).toBe(401)
    const badPull = await pullRaw(0, 'wrong-token')
    expect(badPull.status).toBe(401)

    // SSE hint subscription is never gated by the pull barrier (hint-only);
    // it still authenticates as the paired channel member.
    const sseRes = await fetch(`${relay!.endpoint}/sync/subscribe?cursor=0`, {
      headers: { Authorization: `Bearer ${TOKEN}`, ...provisionedHeaders(dev!) }
    })
    expect(sseRes.status).toBe(200)
    await sseRes.body?.cancel?.().catch(() => {})

    relay!.setPullPaused(false)
    expect(relay!.isPullPaused()).toBe(false)
    const after = await pullRaw(cursorBefore, TOKEN)
    expect(after.status).toBe(200)
    expect(after.body.operations.map((o: any) => o.id)).toContain('op-dir-push-open')
  })

  it('push barrier blocks pushes while pulls still serve (auth still 401-first)', async () => {
    const ts = Date.now()
    const seed = await pushRaw([topicOp('op-dir2-seed', 't-dir2-seed', 'Seed', ts)], TOKEN)
    expect(seed.status).toBe(200)
    await relay!.waitForQuiescent()
    const cursorBefore = relay!.getCursor()

    relay!.setPushPaused(true)
    expect(relay!.isPushPaused()).toBe(true)
    expect(relay!.isPullPaused()).toBe(false)

    // Push gated: authenticated push is 503 with no log/cursor motion.
    const held = await pushRaw([topicOp('op-dir2-held', 't-dir2-held', 'Held', ts + 1)], TOKEN)
    expect(held.status).toBe(503)
    await relay!.waitForQuiescent()
    expect(relay!.getCursor()).toBe(cursorBefore)
    expect(relay!.getOperationCount()).toBe(1)

    // Pull stays open.
    const pulled = await pullRaw(0, TOKEN)
    expect(pulled.status).toBe(200)
    expect(pulled.body.operations.map((o: any) => o.id)).toContain('op-dir2-seed')

    // Auth precedence holds under the independent barrier.
    const badPush = await pushRaw([topicOp('op-dir2-bad', 't-dir2-bad')], 'wrong-token')
    expect(badPush.status).toBe(401)

    relay!.setPushPaused(false)
    expect(relay!.isPushPaused()).toBe(false)
    const admitted = await pushRaw([topicOp('op-dir2-ok', 't-dir2-ok', 'Ok', ts + 2)], TOKEN)
    expect(admitted.status).toBe(200)
  })

  it('resume restores access and repeated pause/resume cycles stay consistent', async () => {
    const ts = Date.now()
    for (let round = 0; round < 2; round += 1) {
      relay!.setPaused(true)
      expect(relay!.isPaused()).toBe(true)
      const held = await pushRaw([topicOp(`op-pause-cycle-${round}`, `t-pause-cycle-${round}`)], TOKEN)
      expect(held.status).toBe(503)

      relay!.setPaused(false)
      expect(relay!.isPaused()).toBe(false)
      const op = topicOp(`op-pause-cycle-ok-${round}`, `t-pause-cycle-ok-${round}`, `Ok${round}`, ts + round)
      const admitted = await pushRaw([op], TOKEN)
      expect(admitted.status).toBe(200)
      const pulled = await pullRaw(admitted.body.cursor - 1, TOKEN)
      expect(pulled.status).toBe(200)
      expect(pulled.body.operations.map((o: any) => o.id)).toContain(`op-pause-cycle-ok-${round}`)
    }
    await relay!.waitForQuiescent()
    expect(relay!.getOperationCount()).toBe(2)
    expect(relay!.getCursor()).toBe(2)
  })
})
