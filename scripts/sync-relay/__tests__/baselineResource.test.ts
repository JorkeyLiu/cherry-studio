/**
 * Relay per-channel current-effective baseline resource (SYNC-CC-022).
 *
 * Focused unit/integration coverage for `PUT /sync/baseline` (publish /
 * idempotent replace) and `GET /sync/baseline` (fetch current) over the
 * file-backed and in-memory SQLite relay path (`createRelayServer`):
 * empty first publish, GET, restart persistence, cc-1 forward migration,
 * idempotent same-N exact, same-N divergent 409, lower 409, higher replace,
 * watermark-above-head 400, wrong-channel 403, nonmember 403, bad
 * envelope/digest 400, concurrent serialized single winner, and operations
 * N+1 retention unaffected. No E2E, no client/Main/IPC/UI.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import {
  COMPLETENESS_COMPLETE,
  computeSyncDigest,
  DIGEST_SCHEME,
  INVENTORY_VERSION,
  ORDER_FRAME_VERSION,
  PAYLOAD_SCHEMA,
  SCOPE,
  WIRE_VERSION
} from '../../../packages/shared/sync/baselineWire'
import { createRelayServer, ensureRelaySchema, RELAY_SCHEMA_VERSION } from '../server'

const TOKEN = 'baseline-resource-token'

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
  let res = await fetch(`${base}/sync/pair/request`, {
    method: 'POST',
    headers: authed(a.code, a.secret),
    body: JSON.stringify({ targetCode: b.code })
  })
  expect(res.status).toBe(200)
  const reqBody = (await res.json()) as { requestId: string }
  res = await fetch(`${base}/sync/pair/accept`, {
    method: 'POST',
    headers: authed(b.code, b.secret),
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
    id: `bl-${tag}-op-${n}`,
    entityType: 'topic',
    op: 'upsert',
    entityId: `bl-${tag}-topic-${n}`,
    timestamp: 1700000000000 + n,
    deviceId,
    payload: { id: `bl-${tag}-topic-${n}`, name: `Baseline Topic ${n}` }
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

// --- Minimal valid wire payloads (fixtures only; all rules stay in baselineWire) ---

function hashHex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

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

function singleTopicPayload(): Record<string, unknown> {
  const clock = { timestamp: 7, operationId: 'blop7' }
  return {
    payloadSchema: PAYLOAD_SCHEMA,
    inventoryVersion: INVENTORY_VERSION,
    orderFrameVersion: ORDER_FRAME_VERSION,
    scope: SCOPE,
    topics: [
      {
        id: 'blt1',
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
        parentId: 'blt1',
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

function makeEnvelope(channelId: string, watermark: number, payload: Record<string, unknown>) {
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

/**
 * PUT with the body fragmented into two TCP writes at an explicit byte
 * offset. A short delay between writes makes separate `data` events on the
 * relay near-certain on loopback, so a multibyte UTF-8 sequence split across
 * the boundary exercises exact decode (no per-chunk U+FFFD corruption).
 */
async function putBaselineChunked(
  base: string,
  caller: { code: string; secret: string },
  raw: string,
  splitAt: number
): Promise<{ status: number; text: string }> {
  const buf = Buffer.from(raw, 'utf8')
  const url = new URL(`${base}/sync/baseline`)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        method: 'PUT',
        headers: { ...authed(caller.code, caller.secret), 'Content-Length': buf.length }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c as Buffer))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
      }
    )
    req.on('error', reject)
    req.write(buf.subarray(0, splitAt))
    setTimeout(() => {
      req.write(buf.subarray(splitAt))
      req.end()
    }, 25)
  })
}

/** Byte offset immediately before a UTF-8 continuation byte (i.e. inside a multibyte sequence). */
function splitInsideMultibyte(buf: Buffer): number {
  for (let i = 1; i < buf.length; i++) {
    if (buf[i] >= 0x80 && buf[i] < 0xc0) return i
  }
  throw new Error('no multibyte split point in body')
}

describe('relay baseline resource', () => {
  it('empty channel: GET 404 baseline-not-found, first PUT N=0 succeeds, GET returns it', async () => {
    const db = trackDb(new Database(':memory:'))
    const base = await startServer(db)
    const { a, channelId } = await pairDevices(base, 'bl-empty-a', 'bl-empty-b')

    const empty = await getBaseline(base, a)
    expect(empty.status).toBe(404)
    expect(empty.json).toEqual({ error: 'baseline-not-found' })

    const envelope = makeEnvelope(channelId, 0, emptyPayload())
    const put = await putBaseline(base, a, JSON.stringify(envelope))
    expect(put.status).toBe(200)
    expect(put.json).toEqual(envelope)

    const fetched = await getBaseline(base, a)
    expect(fetched.status).toBe(200)
    expect(fetched.json).toEqual(envelope)
  })

  it('idempotent same-N exact publish returns 200 with identical body', async () => {
    const db = trackDb(new Database(':memory:'))
    const base = await startServer(db)
    const { a, channelId } = await pairDevices(base, 'bl-idem-a', 'bl-idem-b')

    const raw = JSON.stringify(makeEnvelope(channelId, 0, emptyPayload()))
    const first = await putBaseline(base, a, raw)
    expect(first.status).toBe(200)
    const second = await putBaseline(base, a, raw)
    expect(second.status).toBe(200)
    expect(second.text).toBe(first.text)
  })

  it('same-N canonical-equivalent envelope (reordered keys, whitespace) is idempotent 200', async () => {
    const db = trackDb(new Database(':memory:'))
    const base = await startServer(db)
    const { a, channelId } = await pairDevices(base, 'bl-canon-a', 'bl-canon-b')

    const envelope = makeEnvelope(channelId, 0, singleTopicPayload())
    const first = await putBaseline(base, a, JSON.stringify(envelope))
    expect(first.status).toBe(200)

    // Same canonical payload/digest, different raw text: reversed outer key
    // order plus pretty whitespace. Identity is canonical, not textual.
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
    const { a, channelId } = await pairDevices(base, 'bl-div-a', 'bl-div-b')

    const first = await putBaseline(base, a, JSON.stringify(makeEnvelope(channelId, 0, emptyPayload())))
    expect(first.status).toBe(200)
    const conflict = await putBaseline(base, a, JSON.stringify(makeEnvelope(channelId, 0, singleTopicPayload())))
    expect(conflict.status).toBe(409)
    expect(conflict.json).toEqual({ error: 'baseline-conflict' })

    const fetched = await getBaseline(base, a)
    expect(fetched.status).toBe(200)
    expect(fetched.json).toEqual(first.json)

    // The divergent candidate stays rejected while the original stays idempotent.
    const retry = await putBaseline(base, a, JSON.stringify(makeEnvelope(channelId, 0, emptyPayload())))
    expect(retry.status).toBe(200)
    expect(retry.text).toBe(first.text)
    const again = await putBaseline(base, a, JSON.stringify(makeEnvelope(channelId, 0, singleTopicPayload())))
    expect(again.status).toBe(409)
    expect(again.json).toEqual({ error: 'baseline-conflict' })
  })

  it('lower watermark is 409; higher watermark replaces when coverage holds', async () => {
    const db = trackDb(new Database(':memory:'))
    const base = await startServer(db)
    const { a, b, channelId } = await pairDevices(base, 'bl-mono-a', 'bl-mono-b')

    const pushed = await pushOps(base, a, 'bl-mono-a', [buildOp(1, 'bl-mono-a', 'mono')])
    expect(pushed.status).toBe(200)
    expect(pushed.cursor).toBe(1)

    const atOne = await putBaseline(base, a, JSON.stringify(makeEnvelope(channelId, 1, emptyPayload())))
    expect(atOne.status).toBe(200)

    const lower = await putBaseline(base, b, JSON.stringify(makeEnvelope(channelId, 0, emptyPayload())))
    expect(lower.status).toBe(409)
    expect(lower.json).toEqual({ error: 'baseline-conflict' })

    const pushed2 = await pushOps(base, b, 'bl-mono-b', [buildOp(2, 'bl-mono-b', 'mono')])
    expect(pushed2.status).toBe(200)
    const higher = await putBaseline(base, b, JSON.stringify(makeEnvelope(channelId, 2, singleTopicPayload())))
    expect(higher.status).toBe(200)

    const fetched = await getBaseline(base, a)
    expect(fetched.status).toBe(200)
    expect((fetched.json as { watermark: number }).watermark).toBe(2)
  })

  it('watermark above relay head is 400', async () => {
    const db = trackDb(new Database(':memory:'))
    const base = await startServer(db)
    const { a, channelId } = await pairDevices(base, 'bl-head-a', 'bl-head-b')

    const ahead = await putBaseline(base, a, JSON.stringify(makeEnvelope(channelId, 5, emptyPayload())))
    expect(ahead.status).toBe(400)
    expect(ahead.json).toEqual({ error: 'watermark-above-head' })

    const empty = await getBaseline(base, a)
    expect(empty.status).toBe(404)
  })

  it('wrong channel envelope is 403 channel-mismatch; GET never serves another channel', async () => {
    const db = trackDb(new Database(':memory:'))
    const base = await startServer(db)
    const chA = await pairDevices(base, 'bl-xa-a', 'bl-xa-b')
    const chB = await pairDevices(base, 'bl-xb-a', 'bl-xb-b')
    expect(chA.channelId).not.toBe(chB.channelId)

    const published = await putBaseline(base, chA.a, JSON.stringify(makeEnvelope(chA.channelId, 0, emptyPayload())))
    expect(published.status).toBe(200)

    // Caller from channel A presenting channel B's id is refused.
    const cross = await putBaseline(base, chA.a, JSON.stringify(makeEnvelope(chB.channelId, 0, emptyPayload())))
    expect(cross.status).toBe(403)
    expect(cross.json).toEqual({ error: 'channel-mismatch' })

    // Channel B (empty) never observes channel A's baseline.
    const other = await getBaseline(base, chB.a)
    expect(other.status).toBe(404)
    expect(other.json).toEqual({ error: 'baseline-not-found' })
  })

  it('auth: missing Bearer is 401, bad device secret is 403, unpaired is 403 pairing-required', async () => {
    const db = trackDb(new Database(':memory:'))
    const base = await startServer(db)
    const { a, channelId } = await pairDevices(base, 'bl-auth-a', 'bl-auth-b')
    const lone = await register(base, 'bl-auth-lone')

    const envelope = JSON.stringify(makeEnvelope(channelId, 0, emptyPayload()))
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

    const lonePut = await putBaseline(base, lone, JSON.stringify(makeEnvelope('unpaired-channel', 0, emptyPayload())))
    expect(lonePut.status).toBe(403)
    expect(lonePut.json).toEqual({ error: 'pairing-required' })

    const loneGet = await getBaseline(base, lone)
    expect(loneGet.status).toBe(403)
    expect(loneGet.json).toEqual({ error: 'pairing-required' })
  })

  it('invalid envelope shapes and digest mismatches are 400 with {error} bodies', async () => {
    const db = trackDb(new Database(':memory:'))
    const base = await startServer(db)
    const { a, channelId } = await pairDevices(base, 'bl-bad-a', 'bl-bad-b')
    const good = makeEnvelope(channelId, 0, emptyPayload())

    const cases: Array<{ name: string; raw: string }> = [
      { name: 'unknown outer key', raw: JSON.stringify({ ...good, extra: 1 }) },
      { name: 'wrong wire version', raw: JSON.stringify({ ...good, wireVersion: 'sync-baseline-wire-v0' }) },
      {
        name: 'tampered digest',
        raw: JSON.stringify({
          ...good,
          digest: '0'.repeat(64)
        })
      },
      {
        name: 'tampered payload keeps digest',
        raw: JSON.stringify({ ...good, payload: singleTopicPayload() })
      },
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

  it('multibyte UTF-8 split across body chunks decodes exactly (digest holds)', async () => {
    const db = trackDb(new Database(':memory:'))
    const base = await startServer(db)
    const { a, channelId } = await pairDevices(base, 'bl-frag-a', 'bl-frag-b')

    const payload = singleTopicPayload()
    ;(payload.topics as Array<{ name: string | null }>)[0].name = '基线话题一'
    const envelope = makeEnvelope(channelId, 0, payload)
    const raw = JSON.stringify(envelope)
    expect(raw).toContain('基线')
    const splitAt = splitInsideMultibyte(Buffer.from(raw, 'utf8'))

    const res = await putBaselineChunked(base, a, raw, splitAt)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.text)).toEqual(envelope)

    const fetched = await getBaseline(base, a)
    expect(fetched.status).toBe(200)
    expect(fetched.json).toEqual(envelope)
  })

  it('concurrent divergent publishes serialize to a single winner; identical concurrents both 200', async () => {
    const db = trackDb(new Database(':memory:'))
    const base = await startServer(db)
    const { a, channelId } = await pairDevices(base, 'bl-conc-a', 'bl-conc-b')

    const rawA = JSON.stringify(makeEnvelope(channelId, 0, emptyPayload()))
    const rawB = JSON.stringify(makeEnvelope(channelId, 0, singleTopicPayload()))
    const [r1, r2] = await Promise.all([putBaseline(base, a, rawA), putBaseline(base, a, rawB)])
    const statuses = [r1.status, r2.status].sort()
    expect(statuses).toEqual([200, 409])

    const fetched = await getBaseline(base, a)
    expect(fetched.status).toBe(200)
    const winnerText = r1.status === 200 ? r1.text : r2.text
    expect(JSON.stringify(fetched.json)).toBe(winnerText)

    // Identical concurrents are both idempotent success.
    const [s1, s2] = await Promise.all([putBaseline(base, a, winnerText), putBaseline(base, a, winnerText)])
    expect(s1.status).toBe(200)
    expect(s2.status).toBe(200)
  })

  it('publishes never disturb the operation log: N+1 replay stays intact across replaces', async () => {
    const db = trackDb(new Database(':memory:'))
    const base = await startServer(db)
    const { a, channelId } = await pairDevices(base, 'bl-ret-a', 'bl-ret-b')

    expect((await pushOps(base, a, 'bl-ret-a', [buildOp(1, 'bl-ret-a', 'ret')])).status).toBe(200)
    expect((await pushOps(base, a, 'bl-ret-a', [buildOp(2, 'bl-ret-a', 'ret')])).status).toBe(200)

    const first = await putBaseline(base, a, JSON.stringify(makeEnvelope(channelId, 1, emptyPayload())))
    expect(first.status).toBe(200)

    const page = await pullOps(base, a, 'bl-ret-a', 1)
    expect(page.status).toBe(200)
    expect(page.ops.map((o) => o.seq)).toEqual([2])
    expect(page.cursor).toBe(2)

    expect((await pushOps(base, a, 'bl-ret-a', [buildOp(3, 'bl-ret-a', 'ret')])).status).toBe(200)
    const replaced = await putBaseline(base, a, JSON.stringify(makeEnvelope(channelId, 2, emptyPayload())))
    expect(replaced.status).toBe(200)

    const after = await pullOps(base, a, 'bl-ret-a', 2)
    expect(after.status).toBe(200)
    expect(after.ops.map((o) => o.seq)).toEqual([3])

    const full = await pullOps(base, a, 'bl-ret-a', 0)
    expect(full.ops.map((o) => o.seq)).toEqual([1, 2, 3])
  })

  it('file-backed DB: published baseline survives relay restart on the same file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-baseline-'))
    tmpDirs.push(dir)
    const dbPath = join(dir, 'relay.db')

    const db1 = trackDb(new Database(dbPath))
    db1.pragma('journal_mode = WAL')
    const base1 = await startServer(db1)
    const { a, channelId } = await pairDevices(base1, 'bl-rest-a', 'bl-rest-b')
    const envelope = makeEnvelope(channelId, 0, emptyPayload())
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
    // Same credential still authenticates; same channel still serves the baseline.
    const fetched = await getBaseline(base2, a)
    expect(fetched.status).toBe(200)
    expect(fetched.json).toEqual(envelope)
    const meta = db2.prepare('SELECT value FROM relay_schema_meta WHERE key = ?').get('schema_version') as
      | { value: string }
      | undefined
    expect(meta?.value).toBe(RELAY_SCHEMA_VERSION)
  })

  it('cc-1 file DB migrates forward additively: devices/operations preserved, baseline table added', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-baseline-'))
    tmpDirs.push(dir)
    const dbPath = join(dir, 'relay.db')
    const legacy = trackDb(new Database(dbPath))
    // Minimal cc-1 shape (pre-baseline): current tables without
    // sync_channel_baselines plus the cc-1 marker.
    legacy.exec(`
      CREATE TABLE sync_devices (device_code TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, client_device_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE sync_channels (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, dissolved INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE sync_memberships (device_code TEXT PRIMARY KEY, channel_id TEXT NOT NULL, joined_at TEXT NOT NULL);
      CREATE TABLE sync_pair_requests (id TEXT PRIMARY KEY, requester_code TEXT NOT NULL, target_code TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE sync_channel_operations (channel_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, entity_type TEXT NOT NULL, op TEXT NOT NULL, entity_id TEXT NOT NULL, timestamp INTEGER NOT NULL, device_id TEXT NOT NULL, payload_json TEXT, created_at TEXT, PRIMARY KEY (channel_id, seq));
      CREATE TABLE relay_schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO relay_schema_meta (key, value) VALUES ('schema_version', 'cc-1');
      INSERT INTO sync_devices (device_code, secret_hash, client_device_id, created_at) VALUES ('AAAAAAAA', 'hash', 'dev-a', '2026-09-11T00:00:00.000Z');
      INSERT INTO sync_channels (id, created_at, dissolved) VALUES ('chan-1', '2026-09-11T00:00:00.000Z', 0);
      INSERT INTO sync_memberships (device_code, channel_id, joined_at) VALUES ('AAAAAAAA', 'chan-1', '2026-09-11T00:00:00.000Z');
      INSERT INTO sync_channel_operations (channel_id, seq, id, entity_type, op, entity_id, timestamp, device_id, payload_json, created_at) VALUES ('chan-1', 1, 'op-1', 'topic', 'upsert', 't-1', 1, 'dev-a', NULL, '2026-09-11T00:00:00.000Z');
    `)
    ensureRelaySchema(legacy)

    const meta = legacy.prepare('SELECT value FROM relay_schema_meta WHERE key = ?').get('schema_version') as {
      value: string
    }
    expect(meta.value).toBe('cc-2')
    const device = legacy.prepare('SELECT device_code FROM sync_devices WHERE device_code = ?').get('AAAAAAAA') as
      | { device_code: string }
      | undefined
    expect(device?.device_code).toBe('AAAAAAAA')
    const op = legacy
      .prepare('SELECT id FROM sync_channel_operations WHERE channel_id = ? AND seq = 1')
      .get('chan-1') as { id: string } | undefined
    expect(op?.id).toBe('op-1')
    const baselineTable = legacy
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'sync_channel_baselines'")
      .get() as { name: string } | undefined
    expect(baselineTable?.name).toBe('sync_channel_baselines')
    // Second ensure is a no-op for existing rows.
    ensureRelaySchema(legacy)
    const still = legacy.prepare('SELECT id FROM sync_channel_operations WHERE id = ?').get('op-1') as
      | { id: string }
      | undefined
    expect(still?.id).toBe('op-1')
  })

  it('unknown schema markers fail closed with zero side effects (file-backed)', async () => {
    for (const marker of ['cc-3', '', 'garbage-v9']) {
      const dir = mkdtempSync(join(tmpdir(), 'relay-baseline-'))
      tmpDirs.push(dir)
      const dbPath = join(dir, 'relay.db')
      const db = trackDb(new Database(dbPath))
      db.exec(`
        CREATE TABLE sync_devices (device_code TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, client_device_id TEXT, created_at TEXT NOT NULL);
        CREATE TABLE sync_channels (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, dissolved INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE sync_memberships (device_code TEXT PRIMARY KEY, channel_id TEXT NOT NULL, joined_at TEXT NOT NULL);
        CREATE TABLE sync_pair_requests (id TEXT PRIMARY KEY, requester_code TEXT NOT NULL, target_code TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE sync_channel_operations (channel_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, entity_type TEXT NOT NULL, op TEXT NOT NULL, entity_id TEXT NOT NULL, timestamp INTEGER NOT NULL, device_id TEXT NOT NULL, payload_json TEXT, created_at TEXT, PRIMARY KEY (channel_id, seq));
        CREATE TABLE relay_schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `)
      db.prepare('INSERT INTO relay_schema_meta (key, value) VALUES (?, ?)').run('schema_version', marker)
      db.prepare(
        'INSERT INTO sync_devices (device_code, secret_hash, client_device_id, created_at) VALUES (?, ?, ?, ?)'
      ).run('SENTINEL1', 'hash', 'dev-s', '2026-09-11T00:00:00.000Z')
      db.prepare('INSERT INTO sync_channels (id, created_at, dissolved) VALUES (?, ?, 0)').run(
        'sentinel-chan',
        '2026-09-11T00:00:00.000Z'
      )
      db.prepare('INSERT INTO sync_memberships (device_code, channel_id, joined_at) VALUES (?, ?, ?)').run(
        'SENTINEL1',
        'sentinel-chan',
        '2026-09-11T00:00:00.000Z'
      )
      db.prepare(
        "INSERT INTO sync_pair_requests (id, requester_code, target_code, status, created_at) VALUES (?, ?, ?, 'pending', ?)"
      ).run('sentinel-req', 'SENTINEL1', 'SENTINEL2', '2026-09-11T00:00:00.000Z')

      expect(() => ensureRelaySchema(db), `marker ${JSON.stringify(marker)}`).toThrow(
        /unsupported relay schema version/
      )

      // Marker and every sentinel row preserved; nothing created or dropped.
      const meta = db.prepare('SELECT value FROM relay_schema_meta WHERE key = ?').get('schema_version') as {
        value: string
      }
      expect(meta.value).toBe(marker)
      const device = db.prepare('SELECT device_code FROM sync_devices WHERE device_code = ?').get('SENTINEL1') as
        | { device_code: string }
        | undefined
      expect(device?.device_code).toBe('SENTINEL1')
      const membership = db.prepare('SELECT channel_id FROM sync_memberships WHERE device_code = ?').get('SENTINEL1') as
        | { channel_id: string }
        | undefined
      expect(membership?.channel_id).toBe('sentinel-chan')
      const pending = db.prepare('SELECT id FROM sync_pair_requests WHERE id = ?').get('sentinel-req') as
        | { id: string }
        | undefined
      expect(pending?.id).toBe('sentinel-req')
      const baselineTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_channel_baselines'")
        .get() as { name: string } | undefined
      expect(baselineTable).toBeUndefined()

      dbs = dbs.filter((d) => d !== db)
      db.close()
    }
  })
})
