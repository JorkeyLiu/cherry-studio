/**
 * AUD-001 closure for the in-memory test relay: illegal push / malformed
 * pull never bootstrap trust. Focused transport checks only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { startTestRelay, type TestRelayHandle } from './sync-relay'

const TOKEN = 'bootstrap-defer-token'

let relay: TestRelayHandle

beforeEach(async () => {
  relay = await startTestRelay(TOKEN)
})

afterEach(async () => {
  await relay.close()
})

describe('in-memory relay defers bootstrap until validation passes', () => {
  it('illegal push does not bootstrap trust and issues no credential', async () => {
    const badTopic = {
      id: 'op-mem-bad',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-mem-bad',
      timestamp: Date.now(),
      deviceId: 'd-mem',
      payload: { id: 't-mem-bad', name: 123 }
    }
    const res = await fetch(`${relay.endpoint}/sync/push`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'x-sync-device-id': 'd-mem'
      },
      body: JSON.stringify({ deviceId: 'd-mem', operations: [badTopic] })
    })
    expect(res.status).toBe(400)
    const body = (await res.json().catch(() => ({}))) as { deviceAuth?: unknown }
    expect(body.deviceAuth).toBeUndefined()
    expect(relay.listTrustedDeviceIdsForTests()).toEqual([])
    expect(relay.getOperationCount()).toBe(0)
  })

  it('malformed pull cursor does not bootstrap trust', async () => {
    const res = await fetch(`${relay.endpoint}/sync/pull?cursor=12junk&deviceId=d-mem`, {
      headers: { Authorization: `Bearer ${TOKEN}`, 'x-sync-device-id': 'd-mem' }
    })
    expect(res.status).toBe(400)
    const body = (await res.json().catch(() => ({}))) as { deviceAuth?: unknown }
    expect(body.deviceAuth).toBeUndefined()
    expect(relay.listTrustedDeviceIdsForTests()).toEqual([])
  })

  it('payload/cursor validation failure on pull limit does not bootstrap trust', async () => {
    const res = await fetch(`${relay.endpoint}/sync/pull?cursor=0&limit=07&deviceId=d-mem`, {
      headers: { Authorization: `Bearer ${TOKEN}`, 'x-sync-device-id': 'd-mem' }
    })
    expect(res.status).toBe(400)
    expect(relay.listTrustedDeviceIdsForTests()).toEqual([])
  })
})
