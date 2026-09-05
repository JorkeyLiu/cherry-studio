/**
 * F-001 in-memory relay concurrency: concurrent founder invites admit exactly
 * one trusted device; losers get 403 pairing-required (no auto-join).
 */
import { describe, expect, it } from 'vitest'

import { startTestRelay } from './sync-relay'

describe('F-001 in-memory concurrent founder invites', () => {
  it('admits one founder, others need explicit pairing', async () => {
    const relay = await startTestRelay(`founder-${Date.now()}`)
    try {
      const ids = ['mem-a', 'mem-b', 'mem-c']
      const results = await Promise.all(
        ids.map((deviceId) =>
          fetch(`${relay.endpoint}/sync/pair/invite`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${relay.token}`,
              'x-sync-device-id': deviceId
            },
            body: JSON.stringify({ deviceId })
          }).then(async (r) => ({ deviceId, status: r.status, body: await r.json().catch(() => ({})) }))
        )
      )
      const ok = results.filter((r) => r.status === 200)
      expect(ok.length).toBe(1)
      expect(typeof (ok[0].body as { deviceAuth?: unknown }).deviceAuth).toBe('string')
      expect(relay.listTrustedDeviceIdsForTests().length).toBe(1)
      for (const r of results.filter((x) => x.status !== 200)) {
        expect(r.status).toBe(403)
      }
    } finally {
      await relay.close()
    }
  })
})
