/**
 * Registration/channel/pairing verification for the test relay mirror
 * (SYNC-CC-*): explicit registration, code-without-secret authorization
 * failure, request -> explicit accept -> paired channel, forged identities
 * and unpaired data-plane access all fail closed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runRelayConformanceCore } from './sync-relay-conformance'
import { startTestRelay, type TestRelayHandle } from './sync-relay'

const TOKEN = 'pairing-test-token'

let relay: TestRelayHandle

const secrets = new Map<string, string>()
const codes = new Map<string, string>()

beforeEach(async () => {
  relay = await startTestRelay(TOKEN)
  secrets.clear()
  codes.clear()
})

afterEach(async () => {
  await relay.close()
})

async function registerAs(alias: string): Promise<{ code: string; secret: string }> {
  const res = await fetch(`${relay.endpoint}/sync/register`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: alias })
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { deviceCode: string; deviceSecret: string }
  secrets.set(alias, body.deviceSecret)
  codes.set(alias, body.deviceCode)
  return { code: body.deviceCode, secret: body.deviceSecret }
}

function authHeaders(alias: string): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
  const code = codes.get(alias)
  if (code) headers['x-sync-device-code'] = code
  const held = secrets.get(alias)
  if (held) headers['x-sync-device-secret'] = held
  return headers
}

function pullHeaders(alias: string): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }
  const code = codes.get(alias)
  if (code) headers['x-sync-device-code'] = code
  const held = secrets.get(alias)
  if (held) headers['x-sync-device-secret'] = held
  return headers
}

async function post(path: string, body: unknown, alias?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${relay.endpoint}${path}`, {
    method: 'POST',
    headers: authHeaders(alias ?? ''),
    body: JSON.stringify(body)
  })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}

async function getState(alias: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${relay.endpoint}/sync/state`, { headers: pullHeaders(alias) })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}

describe('channel pairing on the test relay', () => {
  it('registration issues code + secret; the code alone authorizes nothing', async () => {
    const reg = await registerAs('device-a')
    expect(reg.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/)
    // Same token but an unregistered well-formed code is rejected.
    const ghost = await fetch(`${relay.endpoint}/sync/push`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'x-sync-device-code': 'ZZZZ9999',
        'x-sync-device-secret': '0'.repeat(64)
      },
      body: JSON.stringify({ deviceId: 'device-evil', operations: [] })
    })
    expect(ghost.status).toBe(403)
    expect(JSON.stringify(await ghost.json().catch(() => ({})))).toContain('unknown-credential')
    const deniedPush = await post('/sync/push', { deviceId: 'device-evil', operations: [] }, 'device-evil')
    expect(deniedPush.status).toBe(403)
    const pullRes = await fetch(`${relay.endpoint}/sync/pull?cursor=0&deviceId=device-evil`, {
      headers: pullHeaders('device-evil')
    })
    expect(pullRes.status).toBe(403)
    // The public code without its secret is refused even though the code is valid.
    const forged = await fetch(`${relay.endpoint}/sync/push`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'x-sync-device-code': reg.code
      },
      body: JSON.stringify({ deviceId: 'device-a', operations: [] })
    })
    expect(forged.status).toBe(403)
  })

  it('request -> accept pairs into a channel; duplicate request is idempotent', async () => {
    await registerAs('device-a')
    const regB = await registerAs('device-b')
    const req1 = await post('/sync/pair/request', { targetCode: codes.get('device-a') }, 'device-b')
    expect(req1.status).toBe(200)
    expect(typeof req1.json.requestId).toBe('string')
    const req2 = await post('/sync/pair/request', { targetCode: codes.get('device-a') }, 'device-b')
    expect(req2.status).toBe(200)
    expect(req2.json.requestId).toBe(req1.json.requestId)
    // Target observes the incoming request via state.
    const stateA = await getState('device-a')
    expect(stateA.status).toBe(200)
    expect(stateA.json.incoming).toHaveLength(1)
    expect(stateA.json.incoming[0].requesterCode).toBe(regB.code)
    // Explicit accept pairs both into one hidden channel.
    const accept = await post('/sync/pair/accept', { requestId: req1.json.requestId }, 'device-a')
    expect(accept.status).toBe(200)
    expect(typeof accept.json.channelId).toBe('string')
    const afterA = await getState('device-a')
    const afterB = await getState('device-b')
    expect(afterA.json.paired).toBe(true)
    expect(afterB.json.paired).toBe(true)
    expect(afterA.json.channelId).toBe(afterB.json.channelId)
    // Both can now push/pull.
    const pushB = await post('/sync/push', { deviceId: 'device-b', operations: [] }, 'device-b')
    expect(pushB.status).toBe(200)
    // Re-accepting the same request cannot duplicate membership.
    const acceptAgain = await post('/sync/pair/accept', { requestId: req1.json.requestId }, 'device-a')
    expect(acceptAgain.status).toBe(410)
  })

  it('rejected request never pairs', async () => {
    await registerAs('device-a')
    await registerAs('device-b')
    const req = await post('/sync/pair/request', { targetCode: codes.get('device-a') }, 'device-b')
    const reject = await post('/sync/pair/reject', { requestId: req.json.requestId }, 'device-a')
    expect(reject.status).toBe(200)
    const stateB = await getState('device-b')
    expect(stateB.json.paired).toBe(false)
    const pushB = await post('/sync/push', { deviceId: 'device-b', operations: [] }, 'device-b')
    expect(pushB.status).toBe(403)
    expect(JSON.stringify(pushB.json)).toContain('pairing-required')
  })

  it('unpair dissolves the channel and the survivor observes unpaired', async () => {
    await registerAs('device-a')
    await registerAs('device-b')
    const req = await post('/sync/pair/request', { targetCode: codes.get('device-a') }, 'device-b')
    await post('/sync/pair/accept', { requestId: req.json.requestId }, 'device-a')
    const unpair = await post('/sync/pair/unpair', {}, 'device-a')
    expect(unpair.status).toBe(200)
    const stateB = await getState('device-b')
    expect(stateB.json.paired).toBe(false)
    expect(stateB.json.channelId).toBeNull()
    // Registration survives: B can pair again immediately.
    await registerAs('device-c')
    const req2 = await post('/sync/pair/request', { targetCode: codes.get('device-c') }, 'device-b')
    expect(req2.status).toBe(200)
  })

  it('paired requester cannot initiate; unpaired data access fails closed', async () => {
    await registerAs('device-a')
    await registerAs('device-b')
    await registerAs('device-c')
    const req = await post('/sync/pair/request', { targetCode: codes.get('device-a') }, 'device-b')
    await post('/sync/pair/accept', { requestId: req.json.requestId }, 'device-a')
    // A (paired) cannot initiate another pairing.
    const bad = await post('/sync/pair/request', { targetCode: codes.get('device-c') }, 'device-a')
    expect(bad.status).toBe(409)
    // C (unpaired) cannot push or pull.
    const pushC = await post('/sync/push', { deviceId: 'device-c', operations: [] }, 'device-c')
    expect(pushC.status).toBe(403)
    const pullC = await fetch(`${relay.endpoint}/sync/pull?cursor=0&deviceId=device-c`, {
      headers: pullHeaders('device-c')
    })
    expect(pullC.status).toBe(403)
  })

  it('late accept after the requester paired settles the stale request without merge', async () => {
    await registerAs('device-a')
    const regB = await registerAs('device-b')
    const regOut = await registerAs('device-outsider')
    // B requests A while both are unpaired (stays pending).
    const stale = await post('/sync/pair/request', { targetCode: codes.get('device-a') }, 'device-b')
    expect(stale.status).toBe(200)
    // Outsider requests B; B accepts first and becomes paired.
    const fresh = await post('/sync/pair/request', { targetCode: regB.code }, 'device-outsider')
    expect(fresh.status).toBe(200)
    const acceptFresh = await post('/sync/pair/accept', { requestId: fresh.json.requestId }, 'device-b')
    expect(acceptFresh.status).toBe(200)
    const channelBefore = relay.getChannelOfForTests(regB.code)
    expect(channelBefore).toBe(relay.getChannelOfForTests(regOut.code))
    // A's late accept of the stale request fails with no merge. Production
    // parity: the accept that paired B atomically replaced B's other pending
    // (B->A), so the late accept observes terminal 410 request-replaced
    // (never a merge, never revivable).
    const late = await post('/sync/pair/accept', { requestId: stale.json.requestId }, 'device-a')
    expect(late.status).toBe(410)
    expect(JSON.stringify(late.json)).toContain('request-replaced')
    // The stale row is terminal via the same-transaction stale-intent cleanup.
    const staleRow = relay.listPairRequestsForTests().find((r) => r.id === stale.json.requestId)
    expect(staleRow?.status).toBe('replaced')
    // The old pending no longer surfaces as incoming/outgoing.
    const stateA = await getState('device-a')
    const stateB = await getState('device-b')
    expect(stateA.json.paired).toBe(false)
    expect(stateA.json.incoming).toEqual([])
    expect(stateA.json.outgoing).toBeNull()
    expect(stateB.json.paired).toBe(true)
    expect(stateB.json.outgoing).toBeNull()
    expect(stateB.json.incoming).toEqual([])
    // Memberships unchanged: A stays unpaired, B/outsider keep their channel.
    expect(relay.getChannelOfForTests(codes.get('device-a')!)).toBeNull()
    expect(relay.getChannelOfForTests(regB.code)).toBe(channelBefore)
    expect(relay.getChannelOfForTests(regOut.code)).toBe(channelBefore)
  })

  it('body deviceId and operation deviceId must agree', async () => {
    await registerAs('device-a')
    await registerAs('device-b')
    const req = await post('/sync/pair/request', { targetCode: codes.get('device-a') }, 'device-b')
    await post('/sync/pair/accept', { requestId: req.json.requestId }, 'device-a')
    const op = {
      id: 'op-mismatch-1',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-mismatch',
      timestamp: Date.now(),
      deviceId: 'device-evil',
      payload: { id: 't-mismatch', name: 'X' }
    }
    const mismatch = await post('/sync/push', { deviceId: 'device-a', operations: [op] }, 'device-a')
    expect(mismatch.status).toBe(400)
    expect(JSON.stringify(mismatch.json)).toContain('mismatch')
  })

  it('shared SYNC-CC core conformance (memory TestRelay observable contract)', async () => {
    await runRelayConformanceCore({ endpoint: relay.endpoint, token: TOKEN })
  })

  it('channels isolate traffic with independent contiguous cursors', async () => {
    const regA = await registerAs('device-a')
    await registerAs('device-b')
    const regC = await registerAs('device-c')
    await registerAs('device-d')
    const reqAB = await post('/sync/pair/request', { targetCode: regA.code }, 'device-b')
    await post('/sync/pair/accept', { requestId: reqAB.json.requestId }, 'device-a')
    const reqCD = await post('/sync/pair/request', { targetCode: regC.code }, 'device-d')
    await post('/sync/pair/accept', { requestId: reqCD.json.requestId }, 'device-c')
    const opA = {
      id: 'op-iso-a',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-iso-a',
      timestamp: 1000,
      deviceId: 'device-a',
      payload: { id: 't-iso-a', name: 'A' }
    }
    const pushA = await post('/sync/push', { deviceId: 'device-a', operations: [opA] }, 'device-a')
    expect(pushA.status).toBe(200)
    expect(pushA.json.cursor).toBe(1)
    const pullD = await fetch(`${relay.endpoint}/sync/pull?cursor=0&deviceId=device-d`, {
      headers: pullHeaders('device-d')
    })
    expect(pullD.status).toBe(200)
    const pullDBody = (await pullD.json()) as { operations: unknown[] }
    expect(pullDBody.operations).toEqual([])
  })
})
