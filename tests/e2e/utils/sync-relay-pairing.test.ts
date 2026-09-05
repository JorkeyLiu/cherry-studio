/**
 * Pairing/trust verification for the test relay mirror with device-identity
 * binding (F-001/F-002/F-003): request -> explicit accept -> trusted with a
 * per-device credential; forged identities, body/op mismatches, missing pull
 * identity, and trust-store failures all fail closed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { startTestRelay, type TestRelayHandle } from './sync-relay'

const TOKEN = 'pairing-test-token'

let relay: TestRelayHandle

const authFor = new Map<string, string>()

beforeEach(async () => {
  relay = await startTestRelay(TOKEN)
  authFor.clear()
})

afterEach(async () => {
  await relay.close()
})

function authHeaders(deviceId?: string): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
  if (deviceId) {
    headers['x-sync-device-id'] = deviceId
    const held = authFor.get(deviceId)
    if (held) headers['x-sync-device-auth'] = held
  }
  return headers
}

function pullHeaders(deviceId?: string): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }
  if (deviceId) {
    headers['x-sync-device-id'] = deviceId
    const held = authFor.get(deviceId)
    if (held) headers['x-sync-device-auth'] = held
  }
  return headers
}

async function post(
  path: string,
  body: unknown,
  deviceId?: string,
  token = TOKEN
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  if (deviceId) {
    headers['x-sync-device-id'] = deviceId
    const held = authFor.get(deviceId)
    if (held) headers['x-sync-device-auth'] = held
  }
  const res = await fetch(`${relay.endpoint}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })
  const json = await res.json().catch(() => ({}))
  if (typeof (json as { deviceAuth?: unknown })?.deviceAuth === 'string') {
    const id = (body as { deviceId?: unknown })?.deviceId
    if (typeof id === 'string') authFor.set(id, (json as { deviceAuth: string }).deviceAuth)
  }
  return { status: res.status, json }
}

async function get(path: string, deviceId?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${relay.endpoint}${path}`, { headers: pullHeaders(deviceId) })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}

describe('pairing trust on the test relay', () => {
  it('founder bootstrap issues a credential then enforces trust', async () => {
    // Empty group: founder push auto-trusts and issues the credential once.
    const push = await post('/sync/push', { deviceId: 'device-a', operations: [] }, 'device-a')
    expect(push.status).toBe(200)
    expect(typeof push.json.deviceAuth).toBe('string')
    // Same token but unknown device is now rejected on push and pull.
    const deniedPush = await post('/sync/push', { deviceId: 'device-evil', operations: [] }, 'device-evil')
    expect(deniedPush.status).toBe(403)
    expect(JSON.stringify(deniedPush.json)).toContain('device-not-trusted')
    const pullRes = await fetch(`${relay.endpoint}/sync/pull?cursor=0&deviceId=device-evil`, {
      headers: pullHeaders('device-evil')
    })
    expect(pullRes.status).toBe(403)
    // Founder still passes with its credential.
    const okPull = await fetch(`${relay.endpoint}/sync/pull?cursor=0&deviceId=device-a`, {
      headers: pullHeaders('device-a')
    })
    expect(okPull.status).toBe(200)
  })

  it('request -> accept establishes trust; duplicate request re-issues credential', async () => {
    await post('/sync/push', { deviceId: 'device-a', operations: [] }, 'device-a')
    const invite = await post('/sync/pair/invite', { deviceId: 'device-a' }, 'device-a')
    expect(invite.status).toBe(200)
    const code = invite.json.code as string
    const req1 = await post('/sync/pair/request', { deviceId: 'device-b', code }, undefined)
    expect(req1.status).toBe(200)
    expect(typeof req1.json.deviceAuth).toBe('string')
    const firstAuth = req1.json.deviceAuth as string
    const req2 = await post('/sync/pair/request', { deviceId: 'device-b', code }, undefined)
    expect(req2.status).toBe(200)
    expect(req2.json.requestId).toBe(req1.json.requestId)
    // Replay re-issues: the latest credential is the live one.
    expect(typeof req2.json.deviceAuth).toBe('string')
    authFor.set('device-b', req2.json.deviceAuth as string)
    expect((req2.json.deviceAuth as string) === firstAuth).toBe(false)
    // Untrusted caller cannot list pending.
    const pendingDenied = await get('/sync/pair/pending?deviceId=device-b', 'device-b')
    expect(pendingDenied.status).toBe(403)
    const pending = await get('/sync/pair/pending?deviceId=device-a', 'device-a')
    expect(pending.status).toBe(200)
    expect(pending.json.requests).toHaveLength(1)
    // Explicit accept makes B trusted (promotes the latest credential).
    const accept = await post(
      '/sync/pair/accept',
      { approverDeviceId: 'device-a', requestId: req1.json.requestId },
      'device-a'
    )
    expect(accept.status).toBe(200)
    const status = await get('/sync/pair/status?deviceId=device-b')
    expect(status.json.trusted).toBe(true)
    // B can now push/pull with its issued credential.
    const pushB = await post('/sync/push', { deviceId: 'device-b', operations: [] }, 'device-b')
    expect(pushB.status).toBe(200)
    // Re-accepting the same request cannot duplicate trust.
    const acceptAgain = await post(
      '/sync/pair/accept',
      { approverDeviceId: 'device-a', requestId: req1.json.requestId },
      'device-a'
    )
    expect(acceptAgain.status).toBe(410)
    const trusted = await get('/sync/pair/trusted?deviceId=device-a', 'device-a')
    expect(trusted.json.devices).toHaveLength(2)
  })

  it('rejected request never becomes trusted', async () => {
    await post('/sync/push', { deviceId: 'device-a', operations: [] }, 'device-a')
    const invite = await post('/sync/pair/invite', { deviceId: 'device-a' }, 'device-a')
    const req = await post('/sync/pair/request', { deviceId: 'device-b', code: invite.json.code }, undefined)
    const reject = await post(
      '/sync/pair/reject',
      { approverDeviceId: 'device-a', requestId: req.json.requestId },
      'device-a'
    )
    expect(reject.status).toBe(200)
    const status = await get('/sync/pair/status?deviceId=device-b')
    expect(status.json.trusted).toBe(false)
    const pushB = await post('/sync/push', { deviceId: 'device-b', operations: [] }, 'device-b')
    expect(pushB.status).toBe(403)
  })

  it('revoked device is rejected again', async () => {
    await post('/sync/push', { deviceId: 'device-a', operations: [] }, 'device-a')
    const invite = await post('/sync/pair/invite', { deviceId: 'device-a' }, 'device-a')
    const req = await post('/sync/pair/request', { deviceId: 'device-b', code: invite.json.code }, undefined)
    await post('/sync/pair/accept', { approverDeviceId: 'device-a', requestId: req.json.requestId }, 'device-a')
    const revoke = await post(
      '/sync/pair/revoke',
      { approverDeviceId: 'device-a', targetDeviceId: 'device-b' },
      'device-a'
    )
    expect(revoke.status).toBe(200)
    const pushB = await post('/sync/push', { deviceId: 'device-b', operations: [] }, 'device-b')
    expect(pushB.status).toBe(403)
  })

  it('F-001: forging a trusted deviceId with the shared token alone is rejected', async () => {
    await post('/sync/push', { deviceId: 'device-a', operations: [] }, 'device-a')
    // Attacker holds the shared token and claims device-a without its
    // per-device credential.
    const forged = await fetch(`${relay.endpoint}/sync/push`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'x-sync-device-id': 'device-a'
      },
      body: JSON.stringify({ deviceId: 'device-a', operations: [] })
    })
    expect(forged.status).toBe(403)
    const forgedPull = await fetch(`${relay.endpoint}/sync/pull?cursor=0&deviceId=device-a`, {
      headers: { Authorization: `Bearer ${TOKEN}`, 'x-sync-device-id': 'device-a' }
    })
    expect(forgedPull.status).toBe(403)
  })

  it('F-001: body deviceId and operation deviceId must bind to the authenticated identity', async () => {
    await post('/sync/push', { deviceId: 'device-a', operations: [] }, 'device-a')
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
    // Header/body disagreement is also rejected.
    const disagree = await fetch(`${relay.endpoint}/sync/push`, {
      method: 'POST',
      headers: authHeaders('device-a'),
      body: JSON.stringify({ deviceId: 'device-evil', operations: [] })
    })
    expect(disagree.status).toBe(403)
  })

  it('F-002: pull without a valid device identity is rejected (no legacy compat)', async () => {
    await post('/sync/push', { deviceId: 'device-a', operations: [] }, 'device-a')
    const missing = await fetch(`${relay.endpoint}/sync/pull?cursor=0`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    })
    expect(missing.status).toBe(403)
    const emptyId = await fetch(`${relay.endpoint}/sync/pull?cursor=0&deviceId=`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    })
    expect(emptyId.status).toBe(403)
    const disagree = await fetch(`${relay.endpoint}/sync/pull?cursor=0&deviceId=device-a`, {
      headers: pullHeaders('device-evil')
    })
    expect(disagree.status).toBe(403)
  })

  it('F-003: trust-store failure fails closed with 500, never bootstrap success', async () => {
    relay.setTrustStoreFailure(true)
    const push = await post('/sync/push', { deviceId: 'device-a', operations: [] }, 'device-a')
    expect(push.status).toBe(500)
    expect(JSON.stringify(push.json)).toContain('trust-store-unavailable')
    const pull = await fetch(`${relay.endpoint}/sync/pull?cursor=0&deviceId=device-a`, {
      headers: pullHeaders('device-a')
    })
    expect(pull.status).toBe(500)
    relay.setTrustStoreFailure(false)
    // Recovery works after the failure clears.
    const ok = await post('/sync/push', { deviceId: 'device-a', operations: [] }, 'device-a')
    expect(ok.status).toBe(200)
  })

  it('restart regression: accept persists trust across relay handle restart state', async () => {
    // In-memory relay state is process-local; this guards the accept ->
    // trusted -> push/pull chain twice in a row (duplicate/restart path).
    await post('/sync/push', { deviceId: 'device-a', operations: [] }, 'device-a')
    const invite = await post('/sync/pair/invite', { deviceId: 'device-a' }, 'device-a')
    const req = await post('/sync/pair/request', { deviceId: 'device-b', code: invite.json.code }, undefined)
    await post('/sync/pair/accept', { approverDeviceId: 'device-a', requestId: req.json.requestId }, 'device-a')
    for (let i = 0; i < 2; i += 1) {
      const pushB = await post('/sync/push', { deviceId: 'device-b', operations: [] }, 'device-b')
      expect(pushB.status).toBe(200)
      const pullB = await fetch(`${relay.endpoint}/sync/pull?cursor=0&deviceId=device-b`, {
        headers: pullHeaders('device-b')
      })
      expect(pullB.status).toBe(200)
    }
  })
})
