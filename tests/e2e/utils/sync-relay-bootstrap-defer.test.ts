/**
 * Validation-before-write closure for the in-memory test relay (SYNC-CC-*):
 * illegal push / malformed pull framing never writes channel state and
 * issues no credential. Focused transport checks only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  provisionPairedDevices,
  provisionedHeaders,
  startTestRelay,
  type ProvisionedDevice,
  type TestRelayHandle
} from './sync-relay'

const TOKEN = 'bootstrap-defer-token'

let relay: TestRelayHandle
let dev: ProvisionedDevice

beforeEach(async () => {
  relay = await startTestRelay(TOKEN)
  dev = (await provisionPairedDevices(relay.endpoint, TOKEN, 2))[0]
})

afterEach(async () => {
  await relay.close()
})

describe('in-memory relay validates before any channel write', () => {
  it('illegal push writes nothing and issues no credential', async () => {
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
        ...provisionedHeaders(dev)
      },
      body: JSON.stringify({ deviceId: 'd-mem', operations: [badTopic] })
    })
    expect(res.status).toBe(400)
    const body = (await res.json().catch(() => ({}))) as { deviceSecret?: unknown; deviceAuth?: unknown }
    expect(body.deviceSecret).toBeUndefined()
    expect(body.deviceAuth).toBeUndefined()
    expect(relay.getOperationCount()).toBe(0)
  })

  it('malformed pull cursor is rejected before any data access', async () => {
    const res = await fetch(`${relay.endpoint}/sync/pull?cursor=12junk&deviceId=d-mem`, {
      headers: { Authorization: `Bearer ${TOKEN}`, ...provisionedHeaders(dev) }
    })
    expect(res.status).toBe(400)
    const body = (await res.json().catch(() => ({}))) as { deviceSecret?: unknown }
    expect(body.deviceSecret).toBeUndefined()
  })

  it('noncanonical pull limit is rejected without channel access', async () => {
    const res = await fetch(`${relay.endpoint}/sync/pull?cursor=0&limit=07&deviceId=d-mem`, {
      headers: { Authorization: `Bearer ${TOKEN}`, ...provisionedHeaders(dev) }
    })
    expect(res.status).toBe(400)
    expect(relay.getOperationCount()).toBe(0)
  })
})
