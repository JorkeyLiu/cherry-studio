/**
 * Registration/pairing concurrency for the in-memory relay (SYNC-CC-*):
 * concurrent registrations issue distinct codes; concurrent accepts of one
 * request admit exactly one outcome (the loser observes request-accepted).
 */
import { describe, expect, it } from 'vitest'

import { provisionedHeaders, startTestRelay } from './sync-relay'

describe('in-memory relay registration and accept concurrency', () => {
  it('concurrent registrations issue distinct stable codes', async () => {
    const relay = await startTestRelay(`reg-${Date.now()}`)
    try {
      const results = await Promise.all(
        ['r-a', 'r-b', 'r-c'].map((deviceId) =>
          fetch(`${relay.endpoint}/sync/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${relay.token}` },
            body: JSON.stringify({ deviceId })
          }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }))
        )
      )
      for (const r of results) expect(r.status).toBe(200)
      const codes = results.map((r) => (r.body as { deviceCode: string }).deviceCode)
      expect(new Set(codes).size).toBe(3)
      expect(relay.listDeviceCodesForTests().length).toBe(3)
    } finally {
      await relay.close()
    }
  })

  it('concurrent accepts of one request admit exactly one outcome', async () => {
    const relay = await startTestRelay(`accept-${Date.now()}`)
    try {
      const authed = { 'Content-Type': 'application/json', Authorization: `Bearer ${relay.token}` }
      const regA = (await (
        await fetch(`${relay.endpoint}/sync/register`, { method: 'POST', headers: authed, body: JSON.stringify({}) })
      ).json()) as { deviceCode: string; deviceSecret: string }
      const regB = (await (
        await fetch(`${relay.endpoint}/sync/register`, { method: 'POST', headers: authed, body: JSON.stringify({}) })
      ).json()) as { deviceCode: string; deviceSecret: string }
      const req = (await (
        await fetch(`${relay.endpoint}/sync/pair/request`, {
          method: 'POST',
          headers: { ...authed, ...provisionedHeaders({ code: regB.deviceCode, secret: regB.deviceSecret }) },
          body: JSON.stringify({ targetCode: regA.deviceCode })
        })
      ).json()) as { requestId: string }
      const results = await Promise.all(
        [0, 1].map(() =>
          fetch(`${relay.endpoint}/sync/pair/accept`, {
            method: 'POST',
            headers: { ...authed, ...provisionedHeaders({ code: regA.deviceCode, secret: regA.deviceSecret }) },
            body: JSON.stringify({ requestId: req.requestId })
          }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }))
        )
      )
      const ok = results.filter((r) => r.status === 200)
      expect(ok.length).toBe(1)
      const loser = results.find((r) => r.status !== 200)!
      expect(loser.status).toBe(410)
      expect(String((loser.body as { error: string }).error)).toMatch(/request-accepted/)
      // Exactly one channel with both members; no partial membership.
      expect(relay.getChannelOfForTests(regA.deviceCode)).not.toBeNull()
      expect(relay.getChannelOfForTests(regA.deviceCode)).toBe(relay.getChannelOfForTests(regB.deviceCode))
    } finally {
      await relay.close()
    }
  })
})
