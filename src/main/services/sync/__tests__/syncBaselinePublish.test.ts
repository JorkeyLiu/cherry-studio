/**
 * Publisher barrier publish (SYNC-DATA-025/026/027/032, SYNC-CC-019/020/021/022).
 * Single client-declared PUT serialization/error handling; strict barrier
 * order (quiescence → outbox drain → empty pull → same-snapshot proof →
 * single PUT → release); success; fail-closed branches never PUT;
 * 200/409/400/shutdown/stale-config release; same-snapshot
 * watermark/outbox/binding/digest invariants; real local-mutation
 * quiescence (aggregate TX rollback + hook-fallback refusal + remote apply
 * unblocked + post-release recovery).
 */
import { createHash } from 'node:crypto'

import { IpcChannel } from '@shared/IpcChannel'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')
vi.mock('@main/config', () => ({ DATA_PATH: '/tmp' }))

const configStore = new Map<string, unknown>()
vi.mock('@main/services/ConfigManager', () => ({
  configManager: {
    get: (k: string, def?: unknown) => (configStore.has(k) ? configStore.get(k) : def),
    set: (k: string, v: unknown) => configStore.set(k, v)
  },
  ConfigKeys: {}
}))

import {
  COMPLETENESS_COMPLETE,
  computeSyncDigest,
  DIGEST_SCHEME,
  INVENTORY_VERSION,
  ORDER_FRAME_VERSION,
  PAYLOAD_SCHEMA,
  SCOPE,
  validateEnvelope,
  verifyEnvelopeDigest,
  WIRE_VERSION
} from '@shared/sync'
import { eq } from 'drizzle-orm'

import { chatDbService } from '../../chatDb'
import { ChatDbAggregateService } from '../../chatDb/ChatDbAggregateService'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { handleChatDbSuccessForSync } from '../chatDbHook'
import { syncClient } from '../SyncClient'
import { syncService } from '../SyncService'
import { seedRegisteredAttachedSyncService } from './helpers/syncTestRegistration'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>

function hashHex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

const CHANNEL = 'ch-pub'
const CURSOR_N = 5
const CODE = 'ABCD2345'
const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
const ENDPOINT = 'http://127.0.0.1:9999'

function bindChannel(channelId: string): void {
  db.insert(schema.syncState)
    .values({ key: 'sync:channelKey', value: channelId })
    .onConflictDoUpdate({ target: schema.syncState.key, set: { value: channelId } })
    .run()
}

function setCursor(n: number): void {
  db.insert(schema.syncState)
    .values({ key: 'cursor', value: String(n) })
    .onConflictDoUpdate({ target: schema.syncState.key, set: { value: String(n) } })
    .run()
}

function readCursor(): number {
  const row = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
  return row ? Number(row.value) : 0
}

function readLastError(): string | null {
  const row = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastError')).get()
  return (row?.value as string | null) ?? null
}

/** Seed one fully clocked topic with an empty winning frame: complete-candidate input. */
function seedPublishableTopic(topicId = 'pub-topic-1', ts = 7, op = 'bpub7'): void {
  sqlite
    .prepare('INSERT INTO topics (id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?)')
    .run(
      topicId,
      `Topic ${topicId}`,
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      null,
      JSON.stringify({ pinned: true, prompt: 'keep', isNameManuallyEdited: false })
    )
  db.insert(schema.syncEntityClock)
    .values({ entityType: 'topic', entityId: topicId, timestamp: ts, operationId: op })
    .run()
  for (const f of [
    'name',
    'assistantId',
    'createdAt',
    'updatedAt',
    'deletedAt',
    'pinned',
    'prompt',
    'isNameManuallyEdited'
  ]) {
    db.insert(schema.syncFieldClock)
      .values({ entityType: 'topic', entityId: topicId, field: f, timestamp: ts, operationId: op })
      .run()
  }
  db.insert(schema.syncParentOrderFrame)
    .values({
      kind: 'topicMessage',
      parentId: topicId,
      frameVersion: 'parent-order-frame-v1',
      orderedChildIdsJson: '[]',
      timestamp: ts,
      operationId: op
    })
    .run()
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

function makeEnvelope(channelId: string, watermark: number, payload: Record<string, unknown>): Record<string, unknown> {
  const digest = computeSyncDigest(payload as never, hashHex)
  return { wireVersion: WIRE_VERSION, channelId, watermark, digestScheme: DIGEST_SCHEME, digest, payload }
}

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', ENDPOINT)
  configStore.set('sync:token', '')
  sqlite = openInMemory()
  db = drizzle(sqlite, { schema })
  runMigrations(db as never, sqlite)
  ;(chatDbService as unknown as { sqlite: unknown }).sqlite = sqlite
  ;(chatDbService as unknown as { db: unknown }).db = db
  syncService.clearAllForTests()
  syncService.resetShutdownForTests()
  seedRegisteredAttachedSyncService(configStore, db)
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
  try {
    sqlite.close()
  } catch {}
  ;(chatDbService as unknown as { sqlite: unknown }).sqlite = null
  ;(chatDbService as unknown as { db: unknown }).db = null
})

describe('SyncClient.publishBaseline', () => {
  it('serializes exactly one client-declared PUT with device headers and no fence/prepare calls', async () => {
    const envelope = makeEnvelope(CHANNEL, CURSOR_N, emptyPayload())
    const raw = JSON.stringify(envelope)
    const calls: Array<{ url: string; method: string }> = []
    let seenHeaders: Record<string, string> = {}
    let seenBody = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
        calls.push({ url, method: init.method ?? 'GET' })
        seenHeaders = init.headers ?? {}
        seenBody = init.body ?? ''
        return { ok: true, status: 200, text: async () => raw } as never
      })
    )
    const res = await syncClient.publishBaseline(ENDPOINT, 'tok', envelope as never, CODE, SECRET)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ url: `${ENDPOINT}/sync/baseline`, method: 'PUT' })
    expect(seenHeaders['x-sync-device-code']).toBe(CODE)
    expect(seenHeaders['Authorization']).toBe('Bearer tok')
    expect(seenHeaders['Content-Type']).toBe('application/json')
    const bodyKeys = Object.keys(JSON.parse(seenBody))
    expect(bodyKeys).toEqual(['wireVersion', 'channelId', 'watermark', 'digestScheme', 'digest', 'payload'])
    expect(res.envelope.watermark).toBe(CURSOR_N)
    expect(res.rawText).toBe(raw)
    vi.unstubAllGlobals()
  })

  it('409 conflict surfaces truthfully via relay mapping', async () => {
    const envelope = makeEnvelope(CHANNEL, 3, emptyPayload())
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 409, text: async () => '{"error":"baseline-conflict"}' }) as never)
    )
    await expect(syncClient.publishBaseline(ENDPOINT, undefined, envelope as never, CODE, SECRET)).rejects.toThrow(
      /baseline publish failed 409.*baseline-conflict/
    )
    vi.unstubAllGlobals()
  })

  it('400 digest mismatch surfaces truthfully; malformed 200 body fails closed', async () => {
    const envelope = makeEnvelope(CHANNEL, 3, emptyPayload())
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 400, text: async () => '{"error":"digest-mismatch"}' }) as never)
    )
    await expect(syncClient.publishBaseline(ENDPOINT, undefined, envelope as never, CODE, SECRET)).rejects.toThrow(
      /baseline publish failed 400.*digest-mismatch/
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, text: async () => '<html>ok</html>' }) as never)
    )
    await expect(syncClient.publishBaseline(ENDPOINT, undefined, envelope as never, CODE, SECRET)).rejects.toThrow(
      /baseline publish response malformed/
    )
    vi.unstubAllGlobals()
  })

  it('invalid envelope never reaches transport', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }) as never)
    vi.stubGlobal('fetch', fetchMock)
    const bad = { wireVersion: WIRE_VERSION, channelId: CHANNEL } as never
    await expect(syncClient.publishBaseline(ENDPOINT, undefined, bad, CODE, SECRET)).rejects.toThrow(
      /baseline publish envelope invalid/
    )
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('external abort propagates AbortError', async () => {
    const envelope = makeEnvelope(CHANNEL, 0, emptyPayload())
    const controller = new AbortController()
    controller.abort()
    await expect(
      syncClient.publishBaseline(ENDPOINT, undefined, envelope as never, CODE, SECRET, controller.signal)
    ).rejects.toThrow()
    vi.unstubAllGlobals()
  })
})

describe('publishBaseline barrier', () => {
  function seedBoundCursor(): void {
    bindChannel(CHANNEL)
    setCursor(CURSOR_N)
    seedPublishableTopic()
  }

  function mockEmptyPull(order: string[]): void {
    vi.spyOn(syncClient, 'pull').mockImplementation(async (_e, _t, cursor) => {
      order.push(`pull:${cursor}`)
      expect(cursor).toBe(CURSOR_N)
      return { operations: [], cursor: CURSOR_N } as never
    })
  }

  it('success: strict order pull -> single PUT, same-snapshot N/binding/digest invariants, cursor/outbox/chat truthful', async () => {
    seedBoundCursor()
    const order: string[] = []
    mockEmptyPull(order)
    let sentEnvelope: Record<string, unknown> | null = null
    const publishMock = vi.spyOn(syncClient, 'publishBaseline').mockImplementation(async (_e, _t, envelope) => {
      order.push('put')
      sentEnvelope = envelope as unknown as Record<string, unknown>
      const raw = JSON.stringify(envelope)
      const { parseEnvelopeJson } = await import('@shared/sync')
      const parsed = parseEnvelopeJson(raw)
      return { envelope: parsed, rawText: raw }
    })
    const res = await syncService.publishBaseline()
    expect(order).toEqual([`pull:${CURSOR_N}`, 'put'])
    expect(publishMock).toHaveBeenCalledTimes(1)
    expect(res).toEqual({
      watermark: CURSOR_N,
      digest: (sentEnvelope as unknown as { digest: string }).digest,
      channelId: CHANNEL
    })
    // Same-snapshot invariants on the locked wire envelope.
    expect(sentEnvelope).not.toBeNull()
    const env = sentEnvelope as unknown as {
      wireVersion: string
      channelId: string
      watermark: number
      digestScheme: string
      digest: string
      payload: never
    }
    expect(Object.keys(env)).toEqual(['wireVersion', 'channelId', 'watermark', 'digestScheme', 'digest', 'payload'])
    expect(env.wireVersion).toBe(WIRE_VERSION)
    expect(env.channelId).toBe(CHANNEL)
    expect(env.watermark).toBe(CURSOR_N)
    expect(env.digestScheme).toBe(DIGEST_SCHEME)
    validateEnvelope(sentEnvelope)
    expect(verifyEnvelopeDigest(sentEnvelope as never, hashHex)).toBe(true)
    // Cursor/outbox/chat truthful: unchanged cursor, empty outbox, row intact.
    expect(readCursor()).toBe(CURSOR_N)
    expect(db.select().from(schema.syncOutbox).all()).toHaveLength(0)
    expect(sqlite.prepare("SELECT id FROM topics WHERE id='pub-topic-1'").get()).toBeTruthy()
    expect(readLastError()).toBeNull()
    expect(syncService.isPublishBarrierHeld()).toBe(false)
    expect(syncService.isSyncing()).toBe(false)
  })

  it('outbox non-empty fails closed with no PUT', async () => {
    seedBoundCursor()
    syncService.enqueueOperation({
      id: 'pub-block-op-1',
      entityType: 'topic',
      op: 'upsert',
      entityId: 'pub-topic-1',
      timestamp: 1,
      deviceId: 'd1',
      payload: { id: 'pub-topic-1', name: 'Local' }
    } as never)
    const publishMock = vi.spyOn(syncClient, 'publishBaseline')
    const pullMock = vi.spyOn(syncClient, 'pull')
    await expect(syncService.publishBaseline()).rejects.toThrow(/publish blocked: outbox not drained/)
    expect(publishMock).not.toHaveBeenCalled()
    expect(pullMock).not.toHaveBeenCalled()
    expect(readCursor()).toBe(CURSOR_N)
    expect(db.select().from(schema.syncOutbox).all()).toHaveLength(1)
    expect(syncService.isPublishBarrierHeld()).toBe(false)
  })

  it('non-empty pull fails closed with no PUT and pending preserved', async () => {
    seedBoundCursor()
    vi.spyOn(syncClient, 'pull').mockResolvedValue({
      operations: [
        {
          seq: CURSOR_N + 1,
          id: 'remote-op-1',
          entityType: 'topic',
          op: 'upsert',
          entityId: 'remote-t',
          timestamp: Date.now(),
          deviceId: 'remote',
          payload: { id: 'remote-t', name: 'Remote' }
        }
      ],
      cursor: CURSOR_N + 1
    } as never)
    const publishMock = vi.spyOn(syncClient, 'publishBaseline')
    await expect(syncService.publishBaseline()).rejects.toThrow(/publish blocked: pull not empty/)
    expect(publishMock).not.toHaveBeenCalled()
    expect(readCursor()).toBe(CURSOR_N)
    expect(sqlite.prepare("SELECT id FROM topics WHERE id='remote-t'").get()).toBeFalsy()
    expect(syncService.isPublishBarrierHeld()).toBe(false)
  })

  it('unbound channel fails closed with no PUT', async () => {
    setCursor(CURSOR_N)
    seedPublishableTopic()
    const publishMock = vi.spyOn(syncClient, 'publishBaseline')
    await expect(syncService.publishBaseline()).rejects.toThrow(/publish blocked: no bound channel/)
    expect(publishMock).not.toHaveBeenCalled()
    expect(syncService.isPublishBarrierHeld()).toBe(false)
  })

  it('partial candidate (unversioned membership) fails closed with no PUT', async () => {
    seedBoundCursor()
    sqlite
      .prepare(
        'INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run(
        'pub-unversioned-m',
        'pub-topic-1',
        'user',
        'hello',
        'success',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        0
      )
    mockEmptyPull([])
    const publishMock = vi.spyOn(syncClient, 'publishBaseline')
    await expect(syncService.publishBaseline()).rejects.toThrow(/publish blocked: candidate not complete/)
    expect(publishMock).not.toHaveBeenCalled()
    expect(readCursor()).toBe(CURSOR_N)
    expect(syncService.isPublishBarrierHeld()).toBe(false)
  })

  it('cursor moved under the barrier fails closed with no PUT', async () => {
    seedBoundCursor()
    vi.spyOn(syncClient, 'pull').mockImplementation(async () => {
      // Simulate a concurrent durable cursor advance between preflight and snapshot.
      setCursor(CURSOR_N + 1)
      return { operations: [], cursor: CURSOR_N } as never
    })
    const publishMock = vi.spyOn(syncClient, 'publishBaseline')
    await expect(syncService.publishBaseline()).rejects.toThrow(/publish blocked: durable cursor changed/)
    expect(publishMock).not.toHaveBeenCalled()
    expect(syncService.isPublishBarrierHeld()).toBe(false)
  })

  it('409 conflict releases the barrier with truthful error and no silent overwrite', async () => {
    seedBoundCursor()
    mockEmptyPull([])
    vi.spyOn(syncClient, 'publishBaseline').mockRejectedValue(
      new Error('baseline publish failed 409: {"error":"baseline-conflict"}')
    )
    await expect(syncService.publishBaseline()).rejects.toThrow(/baseline publish failed 409.*baseline-conflict/)
    expect(syncService.isPublishBarrierHeld()).toBe(false)
    expect(syncService.isSyncing()).toBe(false)
    expect(readCursor()).toBe(CURSOR_N)
    expect(db.select().from(schema.syncOutbox).all()).toHaveLength(0)
    expect(sqlite.prepare("SELECT id FROM topics WHERE id='pub-topic-1'").get()).toBeTruthy()
    expect(readLastError()).toMatch(/409/)
  })

  it('400 digest rejection releases the barrier with truthful error', async () => {
    seedBoundCursor()
    mockEmptyPull([])
    vi.spyOn(syncClient, 'publishBaseline').mockRejectedValue(
      new Error('baseline publish failed 400: {"error":"digest-mismatch"}')
    )
    await expect(syncService.publishBaseline()).rejects.toThrow(/baseline publish failed 400.*digest-mismatch/)
    expect(syncService.isPublishBarrierHeld()).toBe(false)
    expect(readCursor()).toBe(CURSOR_N)
    expect(readLastError()).toMatch(/400/)
  })

  it('shutdown aborts with no PUT and releases the barrier', async () => {
    seedBoundCursor()
    syncService.beginShutdown()
    const publishMock = vi.spyOn(syncClient, 'publishBaseline')
    await expect(syncService.publishBaseline()).rejects.toThrow(/shutdown/)
    expect(publishMock).not.toHaveBeenCalled()
    expect(syncService.isPublishBarrierHeld()).toBe(false)
    expect(syncService.isSyncing()).toBe(false)
  })

  it('stale config mid-flight aborts with no post-transition PUT', async () => {
    seedBoundCursor()
    const publishMock = vi.spyOn(syncClient, 'publishBaseline')
    vi.spyOn(syncClient, 'pull').mockImplementation(async () => {
      syncService.setConfig({ endpoint: 'http://127.0.0.1:9998' })
      return { operations: [], cursor: CURSOR_N } as never
    })
    await expect(syncService.publishBaseline()).rejects.toThrow(/configuration changed/)
    expect(publishMock).not.toHaveBeenCalled()
    expect(syncService.isPublishBarrierHeld()).toBe(false)
  })

  it('concurrent publish stays exclusive and the barrier releases for retry', async () => {
    seedBoundCursor()
    let releasePull!: () => void
    const gate = new Promise<void>((resolve) => {
      releasePull = resolve
    })
    vi.spyOn(syncClient, 'pull').mockImplementation(async () => {
      await gate
      return { operations: [], cursor: CURSOR_N } as never
    })
    vi.spyOn(syncClient, 'publishBaseline').mockImplementation(async (_e, _t, envelope) => {
      const raw = JSON.stringify(envelope)
      const { parseEnvelopeJson } = await import('@shared/sync')
      const parsed = parseEnvelopeJson(raw)
      return { envelope: parsed, rawText: raw }
    })
    const first = syncService.publishBaseline()
    await expect(syncService.publishBaseline()).rejects.toThrow(/already in progress/)
    releasePull()
    const res = await first
    expect(res.watermark).toBe(CURSOR_N)
    expect(syncService.isPublishBarrierHeld()).toBe(false)
  })
})

describe('publish barrier quiescence', () => {
  function seedBoundCursor(): void {
    bindChannel(CHANNEL)
    setCursor(CURSOR_N)
    seedPublishableTopic()
  }

  function readLastCaptureError(): string | null {
    const row = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastCaptureError')).get()
    return (row?.value as string | null) ?? null
  }

  async function waitFor(cond: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 400 && !cond(); i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    if (!cond()) throw new Error(`timeout waiting for ${label}`)
  }

  function makeMessageJson(topicId: string, id: string): Record<string, unknown> {
    return {
      id,
      topicId,
      role: 'user',
      content: 'quiescence probe',
      status: 'success',
      createdAt: new Date().toISOString()
    }
  }

  it('aggregate TX mutation mid-flight fails before commit (no row, no outbox); hook fallback refuses capture; remote apply unblocked; recovery after release', async () => {
    seedBoundCursor()
    let pullCalls = 0
    let putCalls = 0
    let releasePull!: () => void
    const pullGate = new Promise<void>((resolve) => {
      releasePull = resolve
    })
    let releasePut!: () => void
    const putGate = new Promise<void>((resolve) => {
      releasePut = resolve
    })
    vi.spyOn(syncClient, 'pull').mockImplementation(async () => {
      pullCalls += 1
      await pullGate
      return { operations: [], cursor: CURSOR_N } as never
    })
    vi.spyOn(syncClient, 'publishBaseline').mockImplementation(async (_e, _t, envelope) => {
      putCalls += 1
      await putGate
      const raw = JSON.stringify(envelope)
      const { parseEnvelopeJson } = await import('@shared/sync')
      const parsed = parseEnvelopeJson(raw)
      return { envelope: parsed, rawText: raw }
    })
    const pending = syncService.publishBaseline()
    void pending.catch(() => {})
    await waitFor(() => pullCalls > 0, 'pull to start')
    await waitFor(() => syncService.isPublishBarrierHeld(), 'barrier hold')
    const agg = new ChatDbAggregateService(db, sqlite)

    // Real local mutation through the aggregate TX path: must fail before commit.
    const blockedAppend = agg.appendMessage('q-topic-1', makeMessageJson('q-topic-1', 'q-msg-1') as never, [])
    expect(blockedAppend.ok).toBe(false)
    expect(sqlite.prepare("SELECT id FROM topics WHERE id='q-topic-1'").get()).toBeFalsy()
    expect(sqlite.prepare("SELECT id FROM messages WHERE id='q-msg-1'").get()).toBeFalsy()
    expect(db.select().from(schema.syncOutbox).all()).toHaveLength(0)

    // Release the pull gate → snapshot captured, PUT in flight. The
    // snapshot→PUT window stays closed too.
    releasePull()
    await waitFor(() => putCalls > 0, 'PUT to start')
    expect(syncService.isPublishBarrierHeld()).toBe(true)
    const blockedEnsure = agg.ensureTopic('q-topic-2')
    expect(blockedEnsure.ok).toBe(false)
    expect(sqlite.prepare("SELECT id FROM topics WHERE id='q-topic-2'").get()).toBeFalsy()
    expect(db.select().from(schema.syncOutbox).all()).toHaveLength(0)

    // Hook fallback path (post-commit by design): a bypass-committed row must
    // not gain outbox intent under the barrier; the miss is recorded durably.
    sqlite
      .prepare('INSERT INTO topics (id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?)')
      .run(
        'q-bypass-1',
        'Bypass',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        null,
        JSON.stringify({ pinned: false, prompt: null, isNameManuallyEdited: false })
      )
    handleChatDbSuccessForSync(IpcChannel.ChatDb_UpdateTopicMetadata, { topicId: 'q-bypass-1', name: 'Bypass v2' })
    expect(db.select().from(schema.syncOutbox).all()).toHaveLength(0)
    expect(readLastCaptureError()).toMatch(/publish barrier/)

    // Remote pull/apply internal writes never enter the aggregate gate.
    const applied = syncService.applyIncomingOperation({
      id: 'q-remote-1',
      entityType: 'topic',
      op: 'upsert',
      entityId: 'q-remote-t',
      timestamp: Date.now(),
      deviceId: 'remote',
      payload: { id: 'q-remote-t', name: 'Remote' }
    } as never)
    expect(applied).toBe(true)
    expect(sqlite.prepare("SELECT id FROM topics WHERE id='q-remote-t'").get()).toBeTruthy()

    // Release the PUT gate → publish succeeds; barrier releases; mutations recover.
    releasePut()
    const res = await pending
    expect(res.watermark).toBe(CURSOR_N)
    expect(syncService.isPublishBarrierHeld()).toBe(false)
    const recovered = agg.ensureTopic('q-topic-3')
    expect(recovered.ok).toBe(true)
    expect(sqlite.prepare("SELECT id FROM topics WHERE id='q-topic-3'").get()).toBeTruthy()
    const recoveredAppend = agg.appendMessage('q-topic-3', makeMessageJson('q-topic-3', 'q-msg-3') as never, [])
    expect(recoveredAppend.ok).toBe(true)
    expect(sqlite.prepare("SELECT id FROM messages WHERE id='q-msg-3'").get()).toBeTruthy()
  })

  it('unsupported aggregate mutation (reorder) also fails under the barrier with no frame loss', async () => {
    seedBoundCursor()
    let releasePull!: () => void
    const pullGate = new Promise<void>((resolve) => {
      releasePull = resolve
    })
    vi.spyOn(syncClient, 'pull').mockImplementation(async () => {
      await pullGate
      return { operations: [], cursor: CURSOR_N } as never
    })
    vi.spyOn(syncClient, 'publishBaseline').mockImplementation(async (_e, _t, envelope) => {
      const raw = JSON.stringify(envelope)
      const { parseEnvelopeJson } = await import('@shared/sync')
      const parsed = parseEnvelopeJson(raw)
      return { envelope: parsed, rawText: raw }
    })
    const pending = syncService.publishBaseline()
    void pending.catch(() => {})
    await waitFor(() => syncService.isPublishBarrierHeld(), 'barrier hold')
    const agg = new ChatDbAggregateService(db, sqlite)
    const blocked = agg.reorderMessages('pub-topic-1', [])
    expect(blocked.ok).toBe(false)
    // Winning frame for the live parent survives untouched.
    const frame = db
      .select()
      .from(schema.syncParentOrderFrame)
      .all()
      .find((r) => r.kind === 'topicMessage' && r.parentId === 'pub-topic-1')
    expect(frame).toBeTruthy()
    releasePull()
    const res = await pending
    expect(res.watermark).toBe(CURSOR_N)
    expect(syncService.isPublishBarrierHeld()).toBe(false)
  })
})
