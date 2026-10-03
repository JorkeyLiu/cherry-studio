/**
 * Relay per-channel current-effective baseline resource for wire v3
 * (true-branch full sync: topic-message-stable-block-order-branch-v3).
 *
 * Same contract shape as `baselineResource.test.ts` (SYNC-CC-022) but over
 * the v3 inventory: empty first publish, GET, idempotent same-N exact and
 * canonical-equivalent, same-N divergent 409, lower 409, higher replace,
 * watermark-above-head 400, wrong-channel 403, auth matrix, strict 400s
 * (unknown keys/versions, digest tamper, raw duplicate keys, transient
 * statuses, branch closure: unknown/mismatched parent, wrong-route anchor,
 * cycles, unknown message branch, missing/foreign frames, live+tombstone
 * overlap, manifest miscount), concurrent serialization, N+1 replay intact
 * across replaces, no downgrade to v1 at same/lower N, and file-backed
 * restart persistence. All literals/keys verified against the actual
 * `packages/shared/sync/baselineWire.ts` v3 section (not copied from a
 * handoff): wire sync-baseline-wire-v3 / payload chat-core-baseline-v3 /
 * inventory topic-message-stable-block-order-branch-v3 / scope
 * chat-core-baseline-v3:topic-message-stable-block-order-branch-v3, payload
 * keys +branches/+replacementRegisters, manifest keys +replacementCount with
 * branch-aware live/tombstone/frame counts, branch keys with
 * name/createdAt/updatedAt field clocks, message branchId owner, tombstone
 * topicBranch, frame kind branchSuffix. No E2E, no client/Main/IPC/UI.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import canonicalizeImport from 'canonicalize'
import { afterEach, describe, expect, it } from 'vitest'

import {
  COMPLETENESS_COMPLETE,
  computeSyncDigest,
  DIGEST_SCHEME,
  INVENTORY_VERSION,
  INVENTORY_VERSION_V3,
  ORDER_FRAME_VERSION,
  PAYLOAD_SCHEMA,
  PAYLOAD_SCHEMA_V3,
  SCOPE,
  SCOPE_V3,
  WIRE_VERSION,
  WIRE_VERSION_V3
} from '../../../packages/shared/sync/baselineWire'
import { createRelayServer, ensureRelaySchema, RELAY_SCHEMA_VERSION } from '../server'

const TOKEN = 'baseline-v3-resource-token'

let dbs: Database.Database[] = []
let servers: Array<{ close: (cb?: () => void) => void }> = []
let tmpDirs: string[] = []

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
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
  tmpDirs = []
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
  // Same direction as baselineResource.test.ts: `b` requests, `a` accepts,
  // so the acceptor `a` holds the one-shot seed grant for first-PUT fixtures.
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
  expect(res.status).toBe(200)
  const state = (await res.json()) as { channelId: string | null }
  expect(typeof state.channelId).toBe('string')
  return { a, b, channelId: state.channelId as string }
}

function buildOp(n: number, deviceId: string, tag: string) {
  return {
    id: `v3-${tag}-op-${n}`,
    entityType: 'topic',
    op: 'upsert',
    entityId: `v3-${tag}-topic-${n}`,
    timestamp: 1700000000000 + n,
    deviceId,
    payload: { id: `v3-${tag}-topic-${n}`, name: `Baseline V3 Topic ${n}` }
  }
}

async function pushOps(
  base: string,
  caller: { code: string; secret: string },
  deviceId: string,
  ops: unknown[]
): Promise<{ status: number; cursor: number }> {
  const res = await fetch(`${base}/sync/push`, {
    method: 'POST',
    headers: authed(caller.code, caller.secret),
    body: JSON.stringify({ deviceId, operations: ops })
  })
  const body = (await res.json()) as { cursor?: number }
  return { status: res.status, cursor: body.cursor ?? -1 }
}

async function pullOps(
  base: string,
  caller: { code: string; secret: string },
  deviceId: string,
  cursor: number
): Promise<{ status: number; ops: Array<{ seq: number; id: string }>; cursor: number }> {
  const res = await fetch(`${base}/sync/pull?cursor=${cursor}&deviceId=${encodeURIComponent(deviceId)}`, {
    headers: authed(caller.code, caller.secret)
  })
  const body = (await res.json()) as { operations?: Array<{ seq: number; id: string }>; cursor?: number }
  return { status: res.status, ops: body.operations ?? [], cursor: body.cursor ?? -1 }
}

// --- Minimal valid v3 wire payloads (fixtures only; all rules stay in baselineWire) ---

function hashHex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function clock(timestamp: number, operationId: string): Record<string, unknown> {
  return { timestamp, operationId }
}

const TOPIC_FIELD_KEYS = [
  'name',
  'assistantId',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'pinned',
  'prompt',
  'isNameManuallyEdited'
] as const
const MESSAGE_FIELD_KEYS = [
  'role',
  'content',
  'status',
  'askId',
  'model',
  'modelId',
  'assistantId',
  'createdAt',
  'updatedAt'
] as const
const BLOCK_FIELD_KEYS = ['type', 'content', 'status', 'createdAt', 'updatedAt'] as const

function fieldClocks(keys: readonly string[], timestamp: number, operationId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) out[k] = clock(timestamp, operationId)
  return out
}

function makeTopic(id: string, name: string, ts: number, op: string): Record<string, unknown> {
  return {
    id,
    name,
    assistantId: null,
    createdAt: null,
    updatedAt: null,
    deletedAt: null,
    pinned: null,
    prompt: null,
    isNameManuallyEdited: null,
    entityClock: clock(ts, op),
    fieldClocks: fieldClocks(TOPIC_FIELD_KEYS, ts, op)
  }
}

function makeMessage(
  id: string,
  topicId: string,
  branchId: string | null,
  ts: number,
  op: string,
  memTs: number,
  memOp: string
): Record<string, unknown> {
  return {
    id,
    topicId,
    branchId,
    role: 'user',
    content: `content-${id}`,
    status: 'success',
    askId: null,
    model: null,
    modelId: null,
    assistantId: null,
    createdAt: null,
    updatedAt: null,
    entityClock: clock(ts, op),
    fieldClocks: fieldClocks(MESSAGE_FIELD_KEYS, ts, op),
    parentMembershipClock: clock(memTs, memOp)
  }
}

function makeBlock(
  id: string,
  messageId: string,
  ts: number,
  op: string,
  memTs: number,
  memOp: string
): Record<string, unknown> {
  return {
    id,
    messageId,
    type: 'main_text',
    content: `content-${id}`,
    status: 'success',
    createdAt: null,
    updatedAt: null,
    entityClock: clock(ts, op),
    fieldClocks: fieldClocks(BLOCK_FIELD_KEYS, ts, op),
    parentMembershipClock: clock(memTs, memOp)
  }
}

function makeBranch(
  id: string,
  topicId: string,
  parentBranchId: string | null,
  anchorMessageId: string,
  name: string,
  ts: number,
  op: string
): Record<string, unknown> {
  const c = clock(ts, op)
  return {
    id,
    topicId,
    parentBranchId,
    anchorMessageId,
    name,
    createdAt: null,
    updatedAt: null,
    entityClock: c,
    fieldClocks: { name: c, createdAt: c, updatedAt: c }
  }
}

function makeFrame(
  kind: string,
  parentId: string,
  orderedChildIds: string[],
  ts: number,
  op: string
): Record<string, unknown> {
  return {
    frameVersion: ORDER_FRAME_VERSION,
    kind,
    parentId,
    orderedChildIds,
    frameClock: clock(ts, op)
  }
}

function makeRegister(messageId: string, ts: number, op: string, activeBlockIds: string[]): Record<string, unknown> {
  return { messageId, replacementClock: clock(ts, op), activeBlockIds }
}

interface V3Parts {
  topics: Record<string, unknown>[]
  messages: Record<string, unknown>[]
  messageBlocks: Record<string, unknown>[]
  branches: Record<string, unknown>[]
  tombstones: Record<string, unknown>[]
  orderFrames: Record<string, unknown>[]
  replacementRegisters: Record<string, unknown>[]
}

function countBy(arr: unknown[], pick: (v: Record<string, unknown>) => string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const v of arr) {
    const k = pick(v as Record<string, unknown>)
    out[k] = (out[k] ?? 0) + 1
  }
  return out
}

function assembleV3(parts: V3Parts): Record<string, unknown> {
  const tomb = countBy(parts.tombstones, (t) => String(t.entityType))
  const frames = countBy(parts.orderFrames, (f) => String(f.kind))
  const manifest = {
    payloadSchema: PAYLOAD_SCHEMA_V3,
    inventoryVersion: INVENTORY_VERSION_V3,
    orderFrameVersion: ORDER_FRAME_VERSION,
    scope: SCOPE_V3,
    liveCounts: {
      topic: parts.topics.length,
      message: parts.messages.length,
      messageBlock: parts.messageBlocks.length,
      branch: parts.branches.length
    },
    tombstoneCounts: {
      topic: tomb.topic ?? 0,
      message: tomb.message ?? 0,
      messageBlock: tomb.messageBlock ?? 0,
      topicBranch: tomb.topicBranch ?? 0
    },
    frameCounts: {
      topicMessage: frames.topicMessage ?? 0,
      messageBlock: frames.messageBlock ?? 0,
      branchSuffix: frames.branchSuffix ?? 0
    },
    replacementCount: parts.replacementRegisters.length,
    completeness: COMPLETENESS_COMPLETE
  }
  return {
    payloadSchema: PAYLOAD_SCHEMA_V3,
    inventoryVersion: INVENTORY_VERSION_V3,
    orderFrameVersion: ORDER_FRAME_VERSION,
    scope: SCOPE_V3,
    topics: parts.topics,
    messages: parts.messages,
    messageBlocks: parts.messageBlocks,
    branches: parts.branches,
    tombstones: parts.tombstones,
    orderFrames: parts.orderFrames,
    replacementRegisters: parts.replacementRegisters,
    manifest
  }
}

function emptyPayloadV3(): Record<string, unknown> {
  return assembleV3({
    topics: [],
    messages: [],
    messageBlocks: [],
    branches: [],
    tombstones: [],
    orderFrames: [],
    replacementRegisters: []
  })
}

/** One topic, two main messages, one branch owning one suffix message, full frames + one register. */
function branchPayloadV3(): Record<string, unknown> {
  return assembleV3({
    topics: [makeTopic('v3t1', 'V3 Topic', 10, 'v3op10')],
    messages: [
      makeMessage('v3m0', 'v3t1', null, 11, 'v3op11', 20, 'v3op20'),
      makeMessage('v3m1', 'v3t1', null, 12, 'v3op12', 21, 'v3op21'),
      makeMessage('v3mb1', 'v3t1', 'v3b1', 31, 'v3op31', 32, 'v3op32')
    ],
    messageBlocks: [
      makeBlock('v3k0', 'v3m0', 13, 'v3op13', 40, 'v3op40'),
      makeBlock('v3k1', 'v3m1', 14, 'v3op14', 41, 'v3op41'),
      makeBlock('v3kb1', 'v3mb1', 33, 'v3op33', 42, 'v3op42')
    ],
    branches: [makeBranch('v3b1', 'v3t1', null, 'v3m1', 'B1', 30, 'v3op30')],
    tombstones: [],
    orderFrames: [
      makeFrame('topicMessage', 'v3t1', ['v3m0', 'v3m1'], 100, 'v3op100'),
      makeFrame('messageBlock', 'v3m0', ['v3k0'], 100, 'v3op100'),
      makeFrame('messageBlock', 'v3m1', ['v3k1'], 100, 'v3op100'),
      makeFrame('messageBlock', 'v3mb1', ['v3kb1'], 100, 'v3op100'),
      makeFrame('branchSuffix', 'v3b1', ['v3mb1'], 100, 'v3op100')
    ],
    replacementRegisters: [makeRegister('v3m1', 50, 'v3op50', ['v3k1'])]
  })
}

/** Same domain but the branch owns nothing yet: branchSuffix [] (valid empty). */
function emptySuffixPayloadV3(): Record<string, unknown> {
  return assembleV3({
    topics: [makeTopic('v3t1', 'V3 Topic', 10, 'v3op10')],
    messages: [
      makeMessage('v3m0', 'v3t1', null, 11, 'v3op11', 20, 'v3op20'),
      makeMessage('v3m1', 'v3t1', null, 12, 'v3op12', 21, 'v3op21')
    ],
    messageBlocks: [
      makeBlock('v3k0', 'v3m0', 13, 'v3op13', 40, 'v3op40'),
      makeBlock('v3k1', 'v3m1', 14, 'v3op14', 41, 'v3op41')
    ],
    branches: [makeBranch('v3bE', 'v3t1', null, 'v3m1', 'BE', 30, 'v3op30')],
    tombstones: [],
    orderFrames: [
      makeFrame('topicMessage', 'v3t1', ['v3m0', 'v3m1'], 100, 'v3op100'),
      makeFrame('messageBlock', 'v3m0', ['v3k0'], 100, 'v3op100'),
      makeFrame('messageBlock', 'v3m1', ['v3k1'], 100, 'v3op100'),
      makeFrame('branchSuffix', 'v3bE', [], 100, 'v3op100')
    ],
    replacementRegisters: []
  })
}

/** Minimal v1 empty payload (downgrade-rejection fixtures only). */
function emptyPayloadV1(): Record<string, unknown> {
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

function makeEnvelope(channelId: string, watermark: number, payload: Record<string, unknown>) {
  const digest = computeSyncDigest(payload as never, hashHex)
  return {
    wireVersion: WIRE_VERSION_V3,
    channelId,
    watermark,
    digestScheme: DIGEST_SCHEME,
    digest,
    payload
  }
}

// Invalid-wire helper: JCS digest over the exact candidate WITHOUT shared
// validation, so the malformed body reaches the real relay and the relay
// contract (400) is asserted — never assert a client-side throw.
const canonicalizeRaw = ((): ((value: unknown) => string | undefined) => {
  const mod = canonicalizeImport as unknown as { default?: (v: unknown) => string | undefined }
  if (typeof (mod as unknown as () => unknown) === 'function') {
    return mod as unknown as (v: unknown) => string | undefined
  }
  if (mod && typeof mod.default === 'function') return mod.default
  return canonicalizeImport as unknown as (v: unknown) => string | undefined
})()

function makeRawEnvelope(channelId: string, watermark: number, payload: Record<string, unknown>) {
  const canonical = canonicalizeRaw(payload)
  if (typeof canonical !== 'string') throw new Error('payload not canonicalizable')
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex')
  return {
    wireVersion: WIRE_VERSION_V3,
    channelId,
    watermark,
    digestScheme: DIGEST_SCHEME,
    digest,
    payload
  }
}

function makeEnvelopeV1(channelId: string, watermark: number, payload: Record<string, unknown>) {
  const digest = computeSyncDigest(payload as never, hashHex)
  return {
    wireVersion: WIRE_VERSION,
    channelId,
    watermark,
    digestScheme: DIGEST_SCHEME,
    digest,
    payload
  }
}

async function putBaseline(
  base: string,
  caller: { code: string; secret: string },
  body: string,
  headers?: Record<string, string>
): Promise<{ status: number; text: string; json: unknown }> {
  const res = await fetch(`${base}/sync/baseline`, {
    method: 'PUT',
    headers: headers ?? authed(caller.code, caller.secret),
    body
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

async function getBaseline(
  base: string,
  caller: { code: string; secret: string },
  headers?: Record<string, string>
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}/sync/baseline`, {
    headers: headers ?? authed(caller.code, caller.secret)
  })
  const json = (await res.json()) as unknown
  return { status: res.status, json }
}

describe('relay baseline v3 resource', () => {
  it('empty channel: GET 404 baseline-not-found, first PUT N=0 succeeds, GET returns it', async () => {
    const db = trackDb(new Database(':memory:'))
    const base = await startServer(db)
    const { a, channelId } = await pairDevices(base, 'v3-empty-a', 'v3-empty-b')

    const empty = await getBaseline(base, a)
    expect(empty.status).toBe(404)
    expect(empty.json).toEqual({ error: 'baseline-not-found' })

    const envelope = makeEnvelope(channelId, 0, emptyPayloadV3())
    const put = await putBaseline(base, a, JSON.stringify(envelope))
    expect(put.status).toBe(200)
    expect(put.json).toEqual(envelope)

    const fetched = await getBaseline(base, a)
    expect(fetched.status).toBe(200)
    expect(fetched.json).toEqual(envelope)
  })

  it('branch payload with empty suffix frame publishes exactly and round-trips', async () => {
    const db = trackDb(new Database(':memory:'))
    const base = await startServer(db)
    const { a, channelId } = await pairDevices(base, 'v3-suffix-a', 'v3-suffix-b')

    const envelope = makeEnvelope(channelId, 0, emptySuffixPayloadV3())
    const put = await putBaseline(base, a, JSON.stringify(envelope))
    expect(put.status).toBe(200)
    expect(put.json).toEqual(envelope)

    const fetched = await getBaseline(base, a)
    expect(fetched.status).toBe(200)
    const payload = (fetched.json as { payload: Record<string, unknown> }).payload
    expect(payload.inventoryVersion).toBe(INVENTORY_VERSION_V3)
    const frames = payload.orderFrames as Array<{ kind: string; parentId: string; orderedChildIds: string[] }>
    expect(frames.find((f) => f.kind === 'branchSuffix' && f.parentId === 'v3bE')?.orderedChildIds).toEqual([])
    expect((payload.branches as Array<{ id: string }>).map((b) => b.id)).toEqual(['v3bE'])
  })

  it('idempotent same-N exact publish returns 200 with identical body', async () => {
    const db = trackDb(new Database(':memory:'))
    const base = await startServer(db)
    const { a, channelId } = await pairDevices(base, 'v3-idem-a', 'v3-idem-b')

    const raw = JSON.stringify(makeEnvelope(channelId, 0, branchPayloadV3()))
    const first = await putBaseline(base, a, raw)
    expect(first.status).toBe(200)
    const second = await putBaseline(base, a, raw)
    expect(second.status).toBe(200)
    expect(second.text).toBe(first.text)
  })

  it('same-N canonical-equivalent envelope (reordered keys, whitespace) is idempotent 200', async () => {
    const db = trackDb(new Database(':memory:'))
    const base = await startServer(db)
    const { a, channelId } = await pairDevices(base, 'v3-canon-a', 'v3-canon-b')

    const envelope = makeEnvelope(channelId, 0, branchPayloadV3())
    const first = await putBaseline(base, a, JSON.stringify(envelope))
    expect(first.status).toBe(200)

    const reordered = {
      payload: envelope.payload,
      digest: envelope.digest,
      digestScheme: envelope.digestScheme,
      watermark: envelope.watermark,
      channelId: envelope.channelId,
      wireVersion: envelope.wireVersion
    }
    const second = await putBaseline(base, a, JSON.stringify(reordered, null, 2))
    expect(second.status).toBe(200)
    expect(second.text).toBe(first.text)

    const fetched = await getBaseline(base, a)
    expect(fetched.status).toBe(200)
    expect(JSON.stringify(fetched.json)).toBe(first.text)
  })

  it('same-N divergent payload is 409 and current stays unchanged', async () => {
    const db = trackDb(new Database(':memory:'))
    const base = await startServer(db)
    const { a, channelId } = await pairDevices(base, 'v3-div-a', 'v3-div-b')

    const first = await putBaseline(base, a, JSON.stringify(makeEnvelope(channelId, 0, emptyPayloadV3())))
    expect(first.status).toBe(200)
    const conflict = await putBaseline(base, a, JSON.stringify(makeEnvelope(channelId, 0, branchPayloadV3())))
    expect(conflict.status).toBe(409)
    expect(conflict.json).toEqual({ error: 'baseline-conflict' })

    const fetched = await getBaseline(base, a)
    expect(fetched.status).toBe(200)
    expect(fetched.json).toEqual(first.json)
  })

  it('lower watermark is 409; higher watermark replaces when coverage holds', async () => {
    const db = trackDb(new Database(':memory:'))
    const base = await startServer(db)
    const { a, b, channelId } = await pairDevices(base, 'v3-mono-a', 'v3-mono-b')

    const pushed = await pushOps(base, a, 'v3-mono-a', [buildOp(1, 'v3-mono-a', 'mono')])
    expect(pushed.status).toBe(200)
    expect(pushed.cursor).toBe(1)

    const atOne = await putBaseline(base, a, JSON.stringify(makeEnvelope(channelId, 1, emptySuffixPayloadV3())))
    expect(atOne.status).toBe(200)

    const lower = await putBaseline(base, b, JSON.stringify(makeEnvelope(channelId, 0, emptySuffixPayloadV3())))
    expect(lower.status).toBe(409)
    expect(lower.json).toEqual({ error: 'baseline-conflict' })

    const pushed2 = await pushOps(base, b, 'v3-mono-b', [buildOp(2, 'v3-mono-b', 'mono')])
    expect(pushed2.status).toBe(200)
    // Higher watermark with a renamed branch header replaces the current row.
    // The digest is computed over the renamed payload (makeEnvelope signs
    // the exact candidate), so this is a clean replace, not a tamper case.
    const renamed = branchPayloadV3()
    ;(renamed.branches as Array<Record<string, unknown>>)[0].name = 'B1-renamed'
    const higher = await putBaseline(base, b, JSON.stringify(makeEnvelope(channelId, 2, renamed)))
    expect(higher.status).toBe(200)

    const fetched = await getBaseline(base, a)
    expect(fetched.status).toBe(200)
    expect((fetched.json as { watermark: number }).watermark).toBe(2)
    expect((fetched.json as { payload: { branches: Array<{ name: string }> } }).payload.branches[0]?.name).toBe(
      'B1-renamed'
    )
  })

  it('watermark above relay head is 400', async () => {
    const db = trackDb(new Database(':memory:'))
    const base = await startServer(db)
    const { a, channelId } = await pairDevices(base, 'v3-head-a', 'v3-head-b')

    const ahead = await putBaseline(base, a, JSON.stringify(makeEnvelope(channelId, 5, emptyPayloadV3())))
    expect(ahead.status).toBe(400)
    expect(ahead.json).toEqual({ error: 'watermark-above-head' })

    const empty = await getBaseline(base, a)
    expect(empty.status).toBe(404)
  })

  it('wrong channel envelope is 403 channel-mismatch; GET never serves another channel', async () => {
    const db = trackDb(new Database(':memory:'))
    const base = await startServer(db)
    const chA = await pairDevices(base, 'v3-xa-a', 'v3-xa-b')
    const chB = await pairDevices(base, 'v3-xb-a', 'v3-xb-b')
    expect(chA.channelId).not.toBe(chB.channelId)

    const published = await putBaseline(base, chA.a, JSON.stringify(makeEnvelope(chA.channelId, 0, branchPayloadV3())))
    expect(published.status).toBe(200)

    const cross = await putBaseline(base, chA.a, JSON.stringify(makeEnvelope(chB.channelId, 0, branchPayloadV3())))
    expect(cross.status).toBe(403)
    expect(cross.json).toEqual({ error: 'channel-mismatch' })

    const other = await getBaseline(base, chB.a)
    expect(other.status).toBe(404)
    expect(other.json).toEqual({ error: 'baseline-not-found' })
  })

  it('auth: missing Bearer is 401, bad device secret is 403, unpaired is 403 pairing-required', async () => {
    const db = trackDb(new Database(':memory:'))
    const base = await startServer(db)
    const { a, channelId } = await pairDevices(base, 'v3-auth-a', 'v3-auth-b')
    const lone = await register(base, 'v3-auth-lone')

    const envelope = JSON.stringify(makeEnvelope(channelId, 0, emptyPayloadV3()))
    const noBearerPut = await putBaseline(base, a, envelope, {
      'Content-Type': 'application/json',
      'x-sync-device-code': a.code,
      'x-sync-device-secret': a.secret
    })
    expect(noBearerPut.status).toBe(401)
    expect(noBearerPut.json).toEqual({ error: 'unauthorized' })

    const noBearerGet = await getBaseline(base, a, {
      'x-sync-device-code': a.code,
      'x-sync-device-secret': a.secret
    })
    expect(noBearerGet.status).toBe(401)

    const badSecretPut = await putBaseline(base, a, envelope, authed(a.code, 'f'.repeat(64)))
    expect(badSecretPut.status).toBe(403)

    const lonePut = await putBaseline(base, lone, JSON.stringify(makeEnvelope('unpaired-channel', 0, emptyPayloadV3())))
    expect(lonePut.status).toBe(403)
    expect(lonePut.json).toEqual({ error: 'pairing-required' })

    const loneGet = await getBaseline(base, lone)
    expect(loneGet.status).toBe(403)
    expect(loneGet.json).toEqual({ error: 'pairing-required' })
  })

  it('invalid envelope shapes and digest mismatches are 400 with {error} bodies', async () => {
    const db = trackDb(new Database(':memory:'))
    const base = await startServer(db)
    const { a, channelId } = await pairDevices(base, 'v3-bad-a', 'v3-bad-b')
    const good = makeEnvelope(channelId, 0, branchPayloadV3())
    const tamperedPayload = branchPayloadV3()
    ;(tamperedPayload.branches as Array<Record<string, unknown>>)[0].name = 'Tampered'
    const transientBlock = branchPayloadV3()
    ;(transientBlock.messageBlocks as Array<Record<string, unknown>>)[0].status = 'streaming'
    const mixedVersion = { ...good, payload: emptyPayloadV1() }
    const unknownPayloadKey = {
      ...good,
      payload: { ...good.payload, extraPayloadKey: 1 }
    }
    const unknownManifestKey = makeEnvelope(channelId, 0, branchPayloadV3())
    ;(unknownManifestKey.payload.manifest as Record<string, unknown>).extraManifestKey = 1

    const cases: Array<{ name: string; raw: string }> = [
      { name: 'unknown outer key', raw: JSON.stringify({ ...good, extra: 1 }) },
      { name: 'unknown wire version', raw: JSON.stringify({ ...good, wireVersion: 'sync-baseline-wire-v9' }) },
      { name: 'v1 payload under v3 wire', raw: JSON.stringify(mixedVersion) },
      { name: 'unknown payload key', raw: JSON.stringify(unknownPayloadKey) },
      { name: 'unknown manifest key', raw: JSON.stringify(unknownManifestKey) },
      { name: 'tampered digest', raw: JSON.stringify({ ...good, digest: '0'.repeat(64) }) },
      { name: 'tampered payload keeps digest', raw: JSON.stringify({ ...good, payload: tamperedPayload }) },
      { name: 'transient block status', raw: JSON.stringify(makeRawEnvelope(channelId, 0, transientBlock)) },
      {
        name: 'duplicate outer key',
        raw: `{"wireVersion":${JSON.stringify(good.wireVersion)},"wireVersion":${JSON.stringify(good.wireVersion)},"channelId":${JSON.stringify(good.channelId)},"watermark":0,"digestScheme":${JSON.stringify(good.digestScheme)},"digest":${JSON.stringify(good.digest)},"payload":${JSON.stringify(good.payload)}}`
      },
      { name: 'not JSON', raw: '{not json' }
    ]
    for (const c of cases) {
      const res = await putBaseline(base, a, c.raw)
      expect(res.status, c.name).toBe(400)
      const body = res.json as { error?: unknown }
      expect(typeof body?.error, c.name).toBe('string')
    }
    const empty = await getBaseline(base, a)
    expect(empty.status).toBe(404)
  })

  it('branch closure violations are 400 and never disturb current', async () => {
    const db = trackDb(new Database(':memory:'))
    const base = await startServer(db)
    const { a, channelId } = await pairDevices(base, 'v3-close-a', 'v3-close-b')

    const first = await putBaseline(base, a, JSON.stringify(makeEnvelope(channelId, 0, emptyPayloadV3())))
    expect(first.status).toBe(200)

    const cloneBranchPayload = (): V3Parts => {
      const p = branchPayloadV3()
      return {
        topics: [...(p.topics as Record<string, unknown>[])],
        messages: [...(p.messages as Record<string, unknown>[])],
        messageBlocks: [...(p.messageBlocks as Record<string, unknown>[])],
        branches: [...(p.branches as Record<string, unknown>[])],
        tombstones: [],
        orderFrames: [...(p.orderFrames as Record<string, unknown>[])],
        replacementRegisters: [...(p.replacementRegisters as Record<string, unknown>[])]
      }
    }
    const frameIndex = (parts: V3Parts, kind: string, parentId: string): number =>
      parts.orderFrames.findIndex((f) => f.kind === kind && f.parentId === parentId)

    const cases: Array<{
      name: string
      mutate: (parts: V3Parts) => void
      tweakPayload?: (payload: Record<string, unknown>) => void
    }> = [
      {
        name: 'unknown branch parent',
        mutate: (parts) => {
          parts.branches = [makeBranch('v3b1', 'v3t1', 'v3nope', 'v3m1', 'B1', 30, 'v3op30')]
        }
      },
      {
        name: 'branch anchor not owned by parent route',
        mutate: (parts) => {
          // Nested branch under v3b1 anchored at a main-owned message.
          parts.branches.push(makeBranch('v3b2', 'v3t1', 'v3b1', 'v3m1', 'B2', 60, 'v3op60'))
          parts.orderFrames.push(makeFrame('branchSuffix', 'v3b2', [], 100, 'v3op100'))
        }
      },
      {
        name: 'branch self cycle',
        mutate: (parts) => {
          // Anchor owned by the branch itself so the cycle check is reached.
          parts.branches = [makeBranch('v3b1', 'v3t1', 'v3b1', 'v3mb1', 'B1', 30, 'v3op30')]
        }
      },
      {
        name: 'branch ancestry cycle',
        mutate: (parts) => {
          // b1 (parent b2, anchor owned by b2) and b2 (parent b1, anchor
          // owned by b1) are individually anchor-valid; only the ancestry
          // walk cycles. The pre-existing branchSuffix/v3b1 [v3mb1] frame is
          // already exact for this setup, so only the b2 suffix is added.
          parts.messages.push(makeMessage('v3mb2', 'v3t1', 'v3b2', 61, 'v3op61', 62, 'v3op62'))
          parts.messageBlocks.push(makeBlock('v3kb2', 'v3mb2', 63, 'v3op63', 64, 'v3op64'))
          parts.orderFrames.push(makeFrame('messageBlock', 'v3mb2', ['v3kb2'], 100, 'v3op100'))
          parts.branches = [
            makeBranch('v3b1', 'v3t1', 'v3b2', 'v3mb2', 'B1', 30, 'v3op30'),
            makeBranch('v3b2', 'v3t1', 'v3b1', 'v3mb1', 'B2', 60, 'v3op60')
          ]
          parts.orderFrames.push(makeFrame('branchSuffix', 'v3b2', ['v3mb2'], 100, 'v3op100'))
        }
      },
      {
        name: 'message unknown branch',
        mutate: (parts) => {
          parts.messages.push(makeMessage('v3mx', 'v3t1', 'v3nope', 70, 'v3op70', 71, 'v3op71'))
          parts.messageBlocks.push(makeBlock('v3kx', 'v3mx', 72, 'v3op72', 73, 'v3op73'))
          parts.orderFrames.push(makeFrame('messageBlock', 'v3mx', ['v3kx'], 100, 'v3op100'))
        }
      },
      {
        name: 'topicMessage frame includes branch message',
        mutate: (parts) => {
          const idx = frameIndex(parts, 'topicMessage', 'v3t1')
          parts.orderFrames[idx] = makeFrame('topicMessage', 'v3t1', ['v3m0', 'v3m1', 'v3mb1'], 100, 'v3op100')
        }
      },
      {
        name: 'missing branchSuffix frame',
        mutate: (parts) => {
          const idx = frameIndex(parts, 'branchSuffix', 'v3b1')
          parts.orderFrames.splice(idx, 1)
        }
      },
      {
        name: 'live branch plus topicBranch tombstone overlap',
        mutate: (parts) => {
          parts.tombstones = [
            {
              entityType: 'topicBranch',
              entityId: 'v3b1',
              deletionClock: clock(99, 'v3op99'),
              survivingEntityClock: null
            }
          ]
        }
      },
      {
        name: 'manifest liveCounts mismatch',
        mutate: () => {},
        tweakPayload: (payload) => {
          ;((payload.manifest as Record<string, unknown>).liveCounts as Record<string, unknown>).branch = 999
        }
      }
    ]
    for (const c of cases) {
      const parts = cloneBranchPayload()
      c.mutate(parts)
      const payload = assembleV3(parts)
      c.tweakPayload?.(payload)
      // Digest over the candidate isolates the structural rejection: the
      // relay must 400 on validation, never accept on digest alone.
      // Raw JCS digest bypasses client validation so the malformed wire
      // body reaches the real relay (client throw would never prove 400).
      const envelope = makeRawEnvelope(channelId, 0, payload)
      const res = await putBaseline(base, a, JSON.stringify(envelope))
      expect(res.status, c.name).toBe(400)
      expect(typeof (res.json as { error?: unknown })?.error, c.name).toBe('string')
    }

    const fetched = await getBaseline(base, a)
    expect(fetched.status).toBe(200)
    expect(fetched.json).toEqual(first.json)
  })

  it('publishes never disturb the operation log: N+1 replay stays intact, no v1 downgrade', async () => {
    const db = trackDb(new Database(':memory:'))
    const base = await startServer(db)
    const { a, channelId } = await pairDevices(base, 'v3-ret-a', 'v3-ret-b')

    expect((await pushOps(base, a, 'v3-ret-a', [buildOp(1, 'v3-ret-a', 'ret')])).status).toBe(200)
    expect((await pushOps(base, a, 'v3-ret-a', [buildOp(2, 'v3-ret-a', 'ret')])).status).toBe(200)

    const first = await putBaseline(base, a, JSON.stringify(makeEnvelope(channelId, 1, emptySuffixPayloadV3())))
    expect(first.status).toBe(200)

    const page = await pullOps(base, a, 'v3-ret-a', 1)
    expect(page.status).toBe(200)
    expect(page.ops.map((o) => o.seq)).toEqual([2])
    expect(page.cursor).toBe(2)

    expect((await pushOps(base, a, 'v3-ret-a', [buildOp(3, 'v3-ret-a', 'ret')])).status).toBe(200)
    const replaced = await putBaseline(base, a, JSON.stringify(makeEnvelope(channelId, 2, branchPayloadV3())))
    expect(replaced.status).toBe(200)

    const after = await pullOps(base, a, 'v3-ret-a', 2)
    expect(after.status).toBe(200)
    expect(after.ops.map((o) => o.seq)).toEqual([3])

    const full = await pullOps(base, a, 'v3-ret-a', 0)
    expect(full.ops.map((o) => o.seq)).toEqual([1, 2, 3])

    // No downgrade: a v1 envelope at the same watermark is a divergent
    // conflict, and at a lower watermark is stale; current stays v3.
    const sameNv1 = await putBaseline(base, a, JSON.stringify(makeEnvelopeV1(channelId, 2, emptyPayloadV1())))
    expect(sameNv1.status).toBe(409)
    expect(sameNv1.json).toEqual({ error: 'baseline-conflict' })
    const lowerV1 = await putBaseline(base, a, JSON.stringify(makeEnvelopeV1(channelId, 0, emptyPayloadV1())))
    expect(lowerV1.status).toBe(409)
    expect(lowerV1.json).toEqual({ error: 'baseline-conflict' })
    const fetched = await getBaseline(base, a)
    expect(fetched.status).toBe(200)
    expect(fetched.json).toEqual(replaced.json)
    expect((fetched.json as { wireVersion: string }).wireVersion).toBe(WIRE_VERSION_V3)
  })

  it('concurrent divergent publishes serialize to a single winner; identical concurrents both 200', async () => {
    const db = trackDb(new Database(':memory:'))
    const base = await startServer(db)
    const { a, channelId } = await pairDevices(base, 'v3-conc-a', 'v3-conc-b')

    const rawA = JSON.stringify(makeEnvelope(channelId, 0, emptyPayloadV3()))
    const rawB = JSON.stringify(makeEnvelope(channelId, 0, branchPayloadV3()))
    const [r1, r2] = await Promise.all([putBaseline(base, a, rawA), putBaseline(base, a, rawB)])
    const statuses = [r1.status, r2.status].sort()
    expect(statuses).toEqual([200, 409])

    const fetched = await getBaseline(base, a)
    expect(fetched.status).toBe(200)
    const winnerText = r1.status === 200 ? r1.text : r2.text
    expect(JSON.stringify(fetched.json)).toBe(winnerText)

    const [s1, s2] = await Promise.all([putBaseline(base, a, winnerText), putBaseline(base, a, winnerText)])
    expect(s1.status).toBe(200)
    expect(s2.status).toBe(200)
  })

  it('file-backed DB: published v3 baseline survives relay restart on the same file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-baseline-v3-'))
    tmpDirs.push(dir)
    const dbPath = join(dir, 'relay.db')

    const db1 = trackDb(new Database(dbPath))
    db1.pragma('journal_mode = WAL')
    const base1 = await startServer(db1)
    const { a, channelId } = await pairDevices(base1, 'v3-rest-a', 'v3-rest-b')
    const envelope = makeEnvelope(channelId, 0, branchPayloadV3())
    const put = await putBaseline(base1, a, JSON.stringify(envelope))
    expect(put.status).toBe(200)

    for (const s of servers.splice(0, servers.length)) {
      await new Promise<void>((resolve) => {
        try {
          s.close(() => resolve())
        } catch {
          resolve()
        }
      })
    }
    dbs = dbs.filter((d) => d !== db1)
    db1.close()

    const db2 = trackDb(new Database(dbPath))
    const base2 = await startServer(db2)
    const fetched = await getBaseline(base2, a)
    expect(fetched.status).toBe(200)
    expect(fetched.json).toEqual(envelope)
    const meta = db2.prepare('SELECT value FROM relay_schema_meta WHERE key = ?').get('schema_version') as
      | { value: string }
      | undefined
    expect(meta?.value).toBe(RELAY_SCHEMA_VERSION)
  })
})
