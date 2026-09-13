/**
 * Baseline contract for the in-memory test relay (SYNC-CC-022 / SYNC-DATA-046).
 *
 * Focused mirror of the reference relay's GET/PUT `/sync/baseline` contract
 * (`scripts/sync-relay/server.ts`, covered on the reference side by
 * `scripts/sync-relay/__tests__/baselineResource.test.ts` and
 * `baselineV2Transition.test.ts`): empty GET strict 404, first PUT + GET
 * verbatim, same-N idempotent/divergent, low/high watermark, above-head,
 * auth/channel precedence, bad envelope/digest, v1→v2 upgrade with v1
 * downgrade forbidden, op count/cursor retention, and pause-barrier
 * independence. ABI-neutral: Node crypto hashing only, no better-sqlite3,
 * no reference process.
 *
 * Must NOT be imported by production app code.
 */
import { createHash } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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
import {
  provisionPairedDevices,
  provisionedHeaders,
  startTestRelay,
  type ProvisionedDevice,
  type TestRelayHandle
} from './sync-relay'

const TOKEN = 'inmemory-baseline-token'

let relay: TestRelayHandle

beforeEach(async () => {
  relay = await startTestRelay(TOKEN)
})

afterEach(async () => {
  await relay.close()
})

function hashHex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

// Minimal valid wire payload fixtures (fixtures only; all validation rules
// stay in baselineWire and the relay under test).
function emptyPayload(): Record<string, unknown> {
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

function singleTopicPayload(topicId: string): Record<string, unknown> {
  const clock = { timestamp: 7, operationId: 'blop7' }
  return {
    payloadSchema: PAYLOAD_SCHEMA,
    inventoryVersion: INVENTORY_VERSION,
    orderFrameVersion: ORDER_FRAME_VERSION,
    scope: SCOPE,
    topics: [
      {
        id: topicId,
        name: 'Baseline Topic',
        assistantId: null,
        createdAt: null,
        updatedAt: null,
        deletedAt: null,
        pinned: null,
        prompt: null,
        isNameManuallyEdited: null,
        entityClock: clock,
        fieldClocks: {
          name: clock,
          assistantId: clock,
          createdAt: clock,
          updatedAt: clock,
          deletedAt: clock,
          pinned: clock,
          prompt: clock,
          isNameManuallyEdited: clock
        }
      }
    ],
    messages: [],
    messageBlocks: [],
    tombstones: [],
    orderFrames: [
      {
        frameVersion: ORDER_FRAME_VERSION,
        kind: 'topicMessage',
        parentId: topicId,
        orderedChildIds: [],
        frameClock: clock
      }
    ],
    manifest: {
      payloadSchema: PAYLOAD_SCHEMA,
      inventoryVersion: INVENTORY_VERSION,
      orderFrameVersion: ORDER_FRAME_VERSION,
      scope: SCOPE,
      liveCounts: { topic: 1, message: 0, messageBlock: 0 },
      tombstoneCounts: { topic: 0, message: 0, messageBlock: 0 },
      frameCounts: { topicMessage: 1, messageBlock: 0 },
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

function v1Envelope(channelId: string, watermark: number, payload?: Record<string, unknown>) {
  const p = payload ?? emptyPayload()
  return {
    wireVersion: WIRE_VERSION,
    channelId,
    watermark,
    digestScheme: DIGEST_SCHEME,
    digest: computeSyncDigest(p as never, hashHex),
    payload: p
  }
}

function v2Envelope(channelId: string, watermark: number, registers: unknown[] = []) {
  const p = v2Payload(registers)
  return {
    wireVersion: WIRE_VERSION_V2,
    channelId,
    watermark,
    digestScheme: DIGEST_SCHEME,
    digest: computeSyncDigest(p as never, hashHex),
    payload: p
  }
}

async function channelIdOf(dev: ProvisionedDevice): Promise<string> {
  const res = await fetch(`${relay.endpoint}/sync/state`, {
    headers: { Authorization: `Bearer ${TOKEN}`, ...provisionedHeaders(dev) }
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { channelId: string | null }
  expect(typeof body.channelId).toBe('string')
  return body.channelId as string
}

function authed(dev: ProvisionedDevice): Record<string, string> {
  return {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    ...provisionedHeaders(dev)
  }
}

async function putBaselineRaw(
  dev: ProvisionedDevice,
  raw: string,
  headers?: Record<string, string>
): Promise<{ status: number; text: string; json: unknown }> {
  const res = await fetch(`${relay.endpoint}/sync/baseline`, {
    method: 'PUT',
    headers: headers ?? authed(dev),
    body: raw
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, text, json }
}

async function putBaseline(
  dev: ProvisionedDevice,
  envelope: unknown
): Promise<{ status: number; text: string; json: unknown }> {
  return putBaselineRaw(dev, JSON.stringify(envelope))
}

async function getBaseline(
  dev: ProvisionedDevice,
  headers?: Record<string, string>
): Promise<{ status: number; text: string; json: unknown }> {
  const res = await fetch(`${relay.endpoint}/sync/baseline`, { headers: headers ?? authed(dev) })
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, text, json }
}

async function pushTopicOp(
  dev: ProvisionedDevice,
  deviceId: string,
  tag: string,
  n: number
): Promise<{ status: number; cursor: number }> {
  const res = await fetch(`${relay.endpoint}/sync/push`, {
    method: 'POST',
    headers: authed(dev),
    body: JSON.stringify({
      deviceId,
      operations: [
        {
          id: `bl-${tag}-op-${n}`,
          entityType: 'topic',
          op: 'upsert',
          entityId: `bl-${tag}-topic-${n}`,
          timestamp: 1700000000000 + n,
          deviceId,
          payload: { id: `bl-${tag}-topic-${n}`, name: `Baseline Topic ${n}` }
        }
      ]
    })
  })
  const body = (await res.json()) as { cursor?: number }
  return { status: res.status, cursor: body.cursor ?? -1 }
}

describe('in-memory relay baseline contract', () => {
  it('empty channel: GET strict 404, first PUT N=0 succeeds, GET returns it verbatim', async () => {
    const [a] = await provisionPairedDevices(relay.endpoint, TOKEN, 2)
    const channelId = await channelIdOf(a)

    const empty = await getBaseline(a)
    expect(empty.status).toBe(404)
    expect(empty.json).toEqual({ error: 'baseline-not-found' })

    const envelope = v1Envelope(channelId, 0)
    const put = await putBaseline(a, envelope)
    expect(put.status).toBe(200)
    expect(put.json).toEqual(envelope)

    const fetched = await getBaseline(a)
    expect(fetched.status).toBe(200)
    expect(fetched.text).toBe(put.text)
    expect(fetched.json).toEqual(envelope)
  })

  it('same-N exact and canonical-equivalent re-PUT are idempotent 200; divergent same-N is 409', async () => {
    const [a] = await provisionPairedDevices(relay.endpoint, TOKEN, 2)
    const channelId = await channelIdOf(a)

    const envelope = v1Envelope(channelId, 0, singleTopicPayload('blt-idem'))
    const raw = JSON.stringify(envelope)
    const first = await putBaselineRaw(a, raw)
    expect(first.status).toBe(200)

    const second = await putBaselineRaw(a, raw)
    expect(second.status).toBe(200)
    expect(second.text).toBe(first.text)

    // Same canonical payload/digest, different raw text (reversed outer key
    // order + pretty whitespace): identity is canonical, not textual.
    const reordered = {
      payload: envelope.payload,
      digest: envelope.digest,
      digestScheme: envelope.digestScheme,
      watermark: envelope.watermark,
      channelId: envelope.channelId,
      wireVersion: envelope.wireVersion
    }
    const third = await putBaselineRaw(a, JSON.stringify(reordered, null, 2))
    expect(third.status).toBe(200)
    expect(third.text).toBe(first.text)

    // Same N, different canonical payload: conflict.
    const divergent = v1Envelope(channelId, 0, singleTopicPayload('blt-other'))
    const clash = await putBaseline(a, divergent)
    expect(clash.status).toBe(409)
    expect(clash.json).toEqual({ error: 'baseline-conflict' })

    // Same N, same payload but tampered digest text that still parses: the
    // digest recompute fails first (400), not conflict.
    const tampered = { ...envelope, digest: '0'.repeat(64) }
    const bad = await putBaseline(a, tampered)
    expect(bad.status).toBe(400)
    expect(bad.json).toEqual({ error: 'digest-mismatch' })
  })

  it('lower N conflicts, higher N replaces, above-head is 400, N+1 pull retention holds', async () => {
    const [a, b] = await provisionPairedDevices(relay.endpoint, TOKEN, 2)
    const channelId = await channelIdOf(a)

    const first = await putBaseline(a, v1Envelope(channelId, 0))
    expect(first.status).toBe(200)

    const pushed = await pushTopicOp(a, 'bl-dev', 'lowhigh', 1)
    expect(pushed.status).toBe(200)
    expect(pushed.cursor).toBe(1)

    // Higher legal N replaces; GET serves the replacement verbatim.
    const replacement = v1Envelope(channelId, 1, singleTopicPayload('blt-n1'))
    const replaced = await putBaseline(a, replacement)
    expect(replaced.status).toBe(200)

    // Stale re-publish below current (0 < 1): 409.
    const stale = await putBaseline(a, v1Envelope(channelId, 0))
    expect(stale.status).toBe(409)
    expect(stale.json).toEqual({ error: 'baseline-conflict' })

    // Above relay head: 400 (head is 1 here).
    const above = await putBaseline(a, v1Envelope(channelId, 5))
    expect(above.status).toBe(400)
    expect(above.json).toEqual({ error: 'watermark-above-head' })
    const fetched = await getBaseline(a)
    expect(fetched.status).toBe(200)
    expect(fetched.text).toBe(replaced.text)
    expect(fetched.json).toEqual(replacement)

    // N+1 replay path intact: an op pushed after the baseline is retained
    // and still pulls from the baseline watermark.
    const pushed2 = await pushTopicOp(a, 'bl-dev', 'lowhigh', 2)
    expect(pushed2.status).toBe(200)
    expect(pushed2.cursor).toBe(2)
    const pull = await fetch(`${relay.endpoint}/sync/pull?cursor=1&deviceId=${encodeURIComponent('bl-dev')}`, {
      headers: { Authorization: `Bearer ${TOKEN}`, ...provisionedHeaders(b) }
    })
    expect(pull.status).toBe(200)
    const pullBody = (await pull.json()) as { operations: Array<{ seq: number }>; cursor: number }
    expect(pullBody.operations.map((o) => o.seq)).toEqual([2])
    expect(pullBody.cursor).toBe(2)
  })

  it('auth, pairing-required, and channel-mismatch match the reference order', async () => {
    const [a] = await provisionPairedDevices(relay.endpoint, TOKEN, 2)
    const channelId = await channelIdOf(a)
    const [other] = await provisionPairedDevices(relay.endpoint, TOKEN, 2)
    const otherChannel = await channelIdOf(other)
    expect(otherChannel).not.toBe(channelId)

    const envelope = v1Envelope(channelId, 0)

    // Bearer precedes everything (401 even with valid device headers).
    const noBearerPut = await putBaselineRaw(a, JSON.stringify(envelope), {
      'Content-Type': 'application/json',
      ...provisionedHeaders(a)
    })
    expect(noBearerPut.status).toBe(401)
    const noBearerGet = await getBaseline(a, { ...provisionedHeaders(a) })
    expect(noBearerGet.status).toBe(401)

    // Unknown device credential fails closed.
    const ghostPut = await putBaselineRaw(
      a,
      JSON.stringify(envelope),
      authed({ code: 'ZZZZ9999', secret: '0'.repeat(64) })
    )
    expect(ghostPut.status).toBe(403)
    expect(ghostPut.json).toEqual({ error: 'unknown-credential' })

    // Unpaired device: pairing-required on both verbs.
    const soloRes = await fetch(`${relay.endpoint}/sync/register`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    expect(soloRes.status).toBe(200)
    const solo = (await soloRes.json()) as { deviceCode: string; deviceSecret: string }
    const soloDev: ProvisionedDevice = { code: solo.deviceCode, secret: solo.deviceSecret }
    const soloPut = await putBaseline(soloDev, { ...envelope, channelId: 'no-channel' })
    expect(soloPut.status).toBe(403)
    expect(soloPut.json).toEqual({ error: 'pairing-required' })
    const soloGet = await getBaseline(soloDev)
    expect(soloGet.status).toBe(403)
    expect(soloGet.json).toEqual({ error: 'pairing-required' })

    // Cross-channel publish is refused without disclosure.
    const cross = await putBaseline(a, v1Envelope(otherChannel, 0))
    expect(cross.status).toBe(403)
    expect(cross.json).toEqual({ error: 'channel-mismatch' })
  })

  it('malformed, duplicate-key, and digest-tampered envelopes are 400', async () => {
    const [a] = await provisionPairedDevices(relay.endpoint, TOKEN, 2)
    const channelId = await channelIdOf(a)

    const truncated = await putBaselineRaw(a, '{"wireVersion":')
    expect(truncated.status).toBe(400)
    expect(truncated.json).toEqual({ error: 'invalid-envelope' })

    const envelope = v1Envelope(channelId, 0)
    const raw = JSON.stringify(envelope)
    // Raw duplicate key: inject a second "watermark" member; JSON.parse
    // would accept it (last wins) but the strict scan rejects it.
    const dupRaw = raw.replace('"watermark":0', '"watermark":0,"watermark":0')
    expect(dupRaw).not.toBe(raw)
    const dup = await putBaselineRaw(a, dupRaw)
    expect(dup.status).toBe(400)
    expect(dup.json).toEqual({ error: 'invalid-envelope' })

    // Unknown wire version fails closed as invalid envelope.
    const unknownVersion = { ...envelope, wireVersion: 'sync-baseline-wire-v9' }
    const unknown = await putBaseline(a, unknownVersion)
    expect(unknown.status).toBe(400)
    expect(unknown.json).toEqual({ error: 'invalid-envelope' })
  })

  it('v1 current upgrades to v2 under the gate; any later v1 is 409 and never downgrades', async () => {
    const [a] = await provisionPairedDevices(relay.endpoint, TOKEN, 2)
    const channelId = await channelIdOf(a)

    const v1 = await putBaseline(a, v1Envelope(channelId, 0))
    expect(v1.status).toBe(200)

    // Same-N cross-version publish is divergent: 409, not idempotent.
    const v2SameN = await putBaseline(a, v2Envelope(channelId, 0))
    expect(v2SameN.status).toBe(409)
    expect(v2SameN.json).toEqual({ error: 'baseline-conflict' })

    const pushed = await pushTopicOp(a, 'bl-dev', 'v2up', 1)
    expect(pushed.status).toBe(200)

    const v2Higher = await putBaseline(a, v2Envelope(channelId, 1))
    expect(v2Higher.status).toBe(200)
    const fetched = await getBaseline(a)
    expect(fetched.status).toBe(200)
    expect(fetched.text).toBe(v2Higher.text)
    expect((fetched.json as { wireVersion: string }).wireVersion).toBe(WIRE_VERSION_V2)

    // Downgrade forbidden at any watermark — even above head (the v2
    // transition lock precedes the coverage gate, mirroring the reference).
    const downgradeHigh = await putBaseline(a, v1Envelope(channelId, 5))
    expect(downgradeHigh.status).toBe(409)
    expect(downgradeHigh.json).toEqual({ error: 'baseline-conflict' })
    const downgradeSame = await putBaseline(a, v1Envelope(channelId, 1, singleTopicPayload('blt-d')))
    expect(downgradeSame.status).toBe(409)
    expect(downgradeSame.json).toEqual({ error: 'baseline-conflict' })

    // Current stays v2 verbatim.
    const again = await getBaseline(a)
    expect(again.status).toBe(200)
    expect(again.text).toBe(v2Higher.text)
  })

  it('baseline traffic never touches op count/cursor and ignores pause barriers', async () => {
    const [a] = await provisionPairedDevices(relay.endpoint, TOKEN, 2)
    const channelId = await channelIdOf(a)

    const pushed = await pushTopicOp(a, 'bl-dev', 'counts', 1)
    expect(pushed.status).toBe(200)
    const opsBefore = relay.getOperationCount()
    const cursorBefore = relay.getCursor()
    expect(opsBefore).toBe(1)
    expect(cursorBefore).toBe(1)

    const put = await putBaseline(a, v1Envelope(channelId, 0))
    expect(put.status).toBe(200)
    const put2 = await putBaseline(a, v1Envelope(channelId, 1, singleTopicPayload('blt-c')))
    expect(put2.status).toBe(200)
    expect(relay.getOperationCount()).toBe(opsBefore)
    expect(relay.getCursor()).toBe(cursorBefore)

    // The reference has no 503 baseline semantics: full pause and both
    // direction barriers leave PUT/GET unaffected.
    relay.setPaused(true)
    relay.setPushPaused(true)
    relay.setPullPaused(true)
    try {
      const whilePaused = await getBaseline(a)
      expect(whilePaused.status).toBe(200)
      const rePut = await putBaselineRaw(a, put2.text)
      expect(rePut.status).toBe(200)
      expect(rePut.text).toBe(put2.text)
    } finally {
      relay.setPaused(false)
      relay.setPushPaused(false)
      relay.setPullPaused(false)
    }
    expect(relay.getOperationCount()).toBe(opsBefore)
    expect(relay.getCursor()).toBe(cursorBefore)
  })

  it('baseline GET 200 counts per device: 404 uncounted, 200 isolated, op/cursor/pause untouched', async () => {
    const [a, b] = await provisionPairedDevices(relay.endpoint, TOKEN, 2)
    const channelId = await channelIdOf(a)

    // Fresh counters read 0 fail-closed (unknown code also 0).
    expect(relay.getBaselineGet200CountForTests(a.code)).toBe(0)
    expect(relay.getBaselineGet200CountForTests(b.code)).toBe(0)
    expect(relay.getBaselineGet200CountForTests('UNKNOWN00')).toBe(0)

    // Empty GET is strict 404 and never counts.
    const emptyA = await getBaseline(a)
    expect(emptyA.status).toBe(404)
    const emptyB = await getBaseline(b)
    expect(emptyB.status).toBe(404)
    expect(relay.getBaselineGet200CountForTests(a.code)).toBe(0)
    expect(relay.getBaselineGet200CountForTests(b.code)).toBe(0)

    const put = await putBaseline(a, v1Envelope(channelId, 0))
    expect(put.status).toBe(200)
    const opsBefore = relay.getOperationCount()
    const cursorBefore = relay.getCursor()

    // 200 counts per device, isolated across devices.
    const gotA1 = await getBaseline(a)
    expect(gotA1.status).toBe(200)
    expect(relay.getBaselineGet200CountForTests(a.code)).toBe(1)
    expect(relay.getBaselineGet200CountForTests(b.code)).toBe(0)

    const gotB1 = await getBaseline(b)
    expect(gotB1.status).toBe(200)
    expect(relay.getBaselineGet200CountForTests(a.code)).toBe(1)
    expect(relay.getBaselineGet200CountForTests(b.code)).toBe(1)

    const gotA2 = await getBaseline(a)
    expect(gotA2.status).toBe(200)
    expect(relay.getBaselineGet200CountForTests(a.code)).toBe(2)
    expect(relay.getBaselineGet200CountForTests(b.code)).toBe(1)

    // Counters never move op count/cursor, pause, or in-flight state.
    expect(relay.getOperationCount()).toBe(opsBefore)
    expect(relay.getCursor()).toBe(cursorBefore)
    expect(relay.isPaused()).toBe(false)
    expect(relay.isPushPaused()).toBe(false)
    expect(relay.isPullPaused()).toBe(false)
    await relay.waitForQuiescent()
    expect(relay.getInFlightCount()).toBe(0)
  })
})
