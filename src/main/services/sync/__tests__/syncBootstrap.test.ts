/**
 * Receiver-first baseline bootstrap orchestration (SYNC-CC-023/SYNC-DATA-047).
 * cursor==0 + channel-bound triggers GET before push/pull; 404 falls back;
 * 200 merges in one transaction + cursor=N + preserves outbox/applied, then
 * pulls N+1; cursor>0 skips; channel/digest/DB failures roll back to 0;
 * post-bootstrap pull failure retains N; restart resumes N+1; concurrent
 * sync() stays exclusive.
 */
import { createHash } from 'node:crypto'

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
  WIRE_VERSION
} from '@shared/sync'
import { eq } from 'drizzle-orm'

import { chatDbService } from '../../chatDb'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
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

function singleTopicPayload(topicId = 'bt1'): Record<string, unknown> {
  const clock = { timestamp: 7, operationId: 'btop7' }
  return {
    payloadSchema: PAYLOAD_SCHEMA,
    inventoryVersion: INVENTORY_VERSION,
    orderFrameVersion: ORDER_FRAME_VERSION,
    scope: SCOPE,
    topics: [
      {
        id: topicId,
        name: 'Bootstrap Topic',
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

function makeEnvelope(channelId: string, watermark: number, payload: Record<string, unknown>): Record<string, unknown> {
  const digest = computeSyncDigest(payload as never, hashHex)
  return { wireVersion: WIRE_VERSION, channelId, watermark, digestScheme: DIGEST_SCHEME, digest, payload }
}

function readCursor(): number {
  const row = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
  return row ? Number(row.value) : 0
}

function bindChannel(channelId: string): void {
  db.insert(schema.syncState)
    .values({ key: 'sync:channelKey', value: channelId })
    .onConflictDoUpdate({ target: schema.syncState.key, set: { value: channelId } })
    .run()
}

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
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

describe('receiver bootstrap orchestration', () => {
  it('cursor0 + 404 falls back to ordinary push/pull with no cursor change', async () => {
    bindChannel('ch-404')
    syncService.enqueueOperation({
      id: 'fallback-op-1',
      entityType: 'topic',
      op: 'upsert',
      entityId: 'fallback-t',
      timestamp: 1,
      deviceId: 'd1',
      payload: { id: 'fallback-t', name: 'Fallback' }
    } as never)
    const fetchMock = vi.spyOn(syncClient, 'fetchBaseline').mockResolvedValue({ found: false })
    const pushMock = vi.spyOn(syncClient, 'push').mockResolvedValue({ cursor: 0, acceptedIds: ['fallback-op-1'] })
    const pullMock = vi.spyOn(syncClient, 'pull').mockResolvedValue({ operations: [], cursor: 0 } as never)
    await syncService.sync()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(pushMock).toHaveBeenCalled()
    expect(pullMock).toHaveBeenCalled()
    expect(readCursor()).toBe(0)
    expect(sqlite.prepare("SELECT id FROM topics WHERE id='bt1'").get()).toBeFalsy()
  })

  it('cursor0 + 200 merges, commits N, preserves applied, pushes after fetch then pulls N+1', async () => {
    bindChannel('ch-200')
    db.insert(schema.syncApplied).values({ operationId: 'applied-keep', appliedAt: new Date().toISOString() }).run()
    const envelope = makeEnvelope('ch-200', 5, singleTopicPayload('bt200'))
    const order: string[] = []
    const fetchMock = vi.spyOn(syncClient, 'fetchBaseline').mockImplementation(async () => {
      order.push('fetch')
      return { found: true, envelope: envelope as never, rawText: JSON.stringify(envelope) }
    })
    vi.spyOn(syncClient, 'push').mockImplementation(async () => {
      order.push('push')
      const outbox = db.select().from(schema.syncOutbox).all()
      expect(outbox.map((r) => r.id)).toContain('prepair-op-1')
      return { cursor: 5, acceptedIds: ['prepair-op-1'] }
    })
    syncService.enqueueOperation({
      id: 'prepair-op-1',
      entityType: 'topic',
      op: 'upsert',
      entityId: 'local-prepair',
      timestamp: 1,
      deviceId: 'd1',
      payload: { id: 'local-prepair', name: 'Local' }
    } as never)
    vi.spyOn(syncClient, 'pull').mockImplementation(async (_e, _t, cursor) => {
      order.push(`pull:${cursor}`)
      expect(cursor).toBe(5)
      return { operations: [], cursor: 5 } as never
    })
    await syncService.sync()
    expect(order[0]).toBe('fetch')
    expect(order).toContain('push')
    expect(order).toContain('pull:5')
    expect(readCursor()).toBe(5)
    expect(sqlite.prepare("SELECT id FROM topics WHERE id='bt200'").get()).toBeTruthy()
    expect(db.select().from(schema.syncOutbox).all()).toHaveLength(0)
    expect(
      db
        .select()
        .from(schema.syncApplied)
        .all()
        .map((r) => r.operationId)
    ).toContain('applied-keep')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('cursor>0 never GETs baseline', async () => {
    bindChannel('ch-skip')
    db.insert(schema.syncState)
      .values({ key: 'cursor', value: '9' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: '9' } })
      .run()
    const fetchMock = vi.spyOn(syncClient, 'fetchBaseline').mockResolvedValue({ found: false })
    vi.spyOn(syncClient, 'push').mockResolvedValue({ cursor: 9, acceptedIds: [] })
    vi.spyOn(syncClient, 'pull').mockResolvedValue({ operations: [], cursor: 9 } as never)
    await syncService.sync()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(readCursor()).toBe(9)
  })

  it('channel mismatch fails closed with cursor 0 and no writes', async () => {
    bindChannel('ch-local')
    const envelope = makeEnvelope('ch-other', 4, singleTopicPayload('bt-mismatch'))
    vi.spyOn(syncClient, 'fetchBaseline').mockResolvedValue({
      found: true,
      envelope: envelope as never,
      rawText: JSON.stringify(envelope)
    })
    const pushMock = vi.spyOn(syncClient, 'push')
    await expect(syncService.sync()).rejects.toThrow(/channel mismatch/)
    expect(readCursor()).toBe(0)
    expect(sqlite.prepare("SELECT id FROM topics WHERE id='bt-mismatch'").get()).toBeFalsy()
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('digest mismatch fails closed with cursor 0 and no push', async () => {
    bindChannel('ch-digest')
    const envelope = makeEnvelope('ch-digest', 4, singleTopicPayload('bt-digest'))
    envelope['digest'] = 'f'.repeat(64)
    vi.spyOn(syncClient, 'fetchBaseline').mockResolvedValue({
      found: true,
      envelope: envelope as never,
      rawText: JSON.stringify(envelope)
    })
    const pushMock = vi.spyOn(syncClient, 'push')
    await expect(syncService.sync()).rejects.toThrow(/digest mismatch|bootstrap failed/)
    expect(readCursor()).toBe(0)
    expect(sqlite.prepare("SELECT id FROM topics WHERE id='bt-digest'").get()).toBeFalsy()
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('post-bootstrap pull failure retains N for next recovery and resumes N+1', async () => {
    bindChannel('ch-retain')
    const envelope = makeEnvelope('ch-retain', 6, singleTopicPayload('bt-retain'))
    vi.spyOn(syncClient, 'fetchBaseline').mockResolvedValue({
      found: true,
      envelope: envelope as never,
      rawText: JSON.stringify(envelope)
    })
    vi.spyOn(syncClient, 'push').mockResolvedValue({ cursor: 6, acceptedIds: [] })
    vi.spyOn(syncClient, 'pull').mockRejectedValueOnce(new Error('pull failed 503: request failed'))
    await expect(syncService.sync()).rejects.toThrow(/pull failed/)
    expect(readCursor()).toBe(6)
    expect(sqlite.prepare("SELECT id FROM topics WHERE id='bt-retain'").get()).toBeTruthy()
    const fetchMock2 = vi.spyOn(syncClient, 'fetchBaseline')
    fetchMock2.mockClear()
    vi.spyOn(syncClient, 'pull').mockResolvedValueOnce({ operations: [], cursor: 6 } as never)
    await syncService.sync()
    expect(fetchMock2).not.toHaveBeenCalled()
    expect(readCursor()).toBe(6)
  })

  it('200 preserves local pre-pair rows and reuses LWW merge with outbox referencing baseline parent', async () => {
    bindChannel('ch-lww')
    const oldClock = { ts: 5, op: 'alocal5' }
    sqlite
      .prepare('INSERT INTO topics (id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?)')
      .run('btLWW', 'Local Old', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null, null)
    db.insert(schema.syncEntityClock)
      .values({ entityType: 'topic', entityId: 'btLWW', timestamp: oldClock.ts, operationId: oldClock.op })
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
        .values({ entityType: 'topic', entityId: 'btLWW', field: f, timestamp: oldClock.ts, operationId: oldClock.op })
        .run()
    }
    db.insert(schema.syncParentOrderFrame)
      .values({
        kind: 'topicMessage',
        parentId: 'btLWW',
        frameVersion: 'parent-order-frame-v1',
        orderedChildIdsJson: '[]',
        timestamp: oldClock.ts,
        operationId: oldClock.op
      })
      .run()
    sqlite
      .prepare('INSERT INTO topics (id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?)')
      .run('local-keep', 'Keep Me', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null, null)
    db.insert(schema.syncEntityClock)
      .values({ entityType: 'topic', entityId: 'local-keep', timestamp: oldClock.ts, operationId: oldClock.op })
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
        .values({
          entityType: 'topic',
          entityId: 'local-keep',
          field: f,
          timestamp: oldClock.ts,
          operationId: oldClock.op
        })
        .run()
    }
    db.insert(schema.syncParentOrderFrame)
      .values({
        kind: 'topicMessage',
        parentId: 'local-keep',
        frameVersion: 'parent-order-frame-v1',
        orderedChildIdsJson: '[]',
        timestamp: oldClock.ts,
        operationId: oldClock.op
      })
      .run()
    const envelope = makeEnvelope('ch-lww', 5, singleTopicPayload('btLWW'))
    const order: string[] = []
    vi.spyOn(syncClient, 'fetchBaseline').mockImplementation(async () => {
      order.push('fetch')
      return { found: true, envelope: envelope as never, rawText: JSON.stringify(envelope) }
    })
    syncService.enqueueOperation({
      id: 'outbox-ref-1',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm-ref',
      timestamp: 1,
      deviceId: 'd1',
      payload: { id: 'm-ref', topicId: 'btLWW', role: 'user', content: 'refers baseline parent' }
    } as never)
    vi.spyOn(syncClient, 'push').mockImplementation(async () => {
      order.push('push')
      expect(sqlite.prepare("SELECT name FROM topics WHERE id='btLWW'").get()).toBeTruthy()
      expect(sqlite.prepare("SELECT name FROM topics WHERE id='local-keep'").get()).toBeTruthy()
      return { cursor: 5, acceptedIds: ['outbox-ref-1'] }
    })
    vi.spyOn(syncClient, 'pull').mockImplementation(async (_e, _t, cursor) => {
      order.push(`pull:${cursor}`)
      expect(cursor).toBe(5)
      return { operations: [], cursor: 5 } as never
    })
    await syncService.sync()
    expect(order[0]).toBe('fetch')
    const merged = sqlite.prepare("SELECT name FROM topics WHERE id='btLWW'").get() as { name: string }
    expect(merged.name).toBe('Bootstrap Topic')
    const kept = sqlite.prepare("SELECT name FROM topics WHERE id='local-keep'").get() as { name: string }
    expect(kept.name).toBe('Keep Me')
    expect(readCursor()).toBe(5)
  })

  it('N=0 bootstrap stays cursor 0, repeats GET idempotently then pulls seq1', async () => {
    bindChannel('ch-zero')
    const envelope = makeEnvelope('ch-zero', 0, singleTopicPayload('btZero'))
    const raw = JSON.stringify(envelope)
    const fetchMock = vi.spyOn(syncClient, 'fetchBaseline').mockResolvedValue({
      found: true,
      envelope: envelope as never,
      rawText: raw
    })
    vi.spyOn(syncClient, 'push').mockResolvedValue({ cursor: 0, acceptedIds: [] })
    vi.spyOn(syncClient, 'pull').mockResolvedValue({ operations: [], cursor: 0 } as never)
    await syncService.sync()
    expect(readCursor()).toBe(0)
    expect(sqlite.prepare("SELECT id FROM topics WHERE id='btZero'").get()).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const countAfterFirst = (
      sqlite.prepare("SELECT COUNT(*) as c FROM topics WHERE id='btZero'").get() as { c: number }
    ).c
    expect(countAfterFirst).toBe(1)
    vi.spyOn(syncClient, 'pull').mockImplementationOnce(async (_e, _t, cursor) => {
      expect(cursor).toBe(0)
      return {
        operations: [
          {
            seq: 1,
            id: 'op-seq1',
            entityType: 'topic',
            op: 'upsert',
            entityId: 't-seq1',
            timestamp: Date.now(),
            deviceId: 'remote',
            payload: { id: 't-seq1', name: 'Seq1' }
          }
        ],
        cursor: 1
      } as never
    })
    await syncService.sync()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(readCursor()).toBe(1)
    expect(sqlite.prepare("SELECT id FROM topics WHERE id='btZero'").get()).toBeTruthy()
    expect(sqlite.prepare("SELECT id FROM topics WHERE id='t-seq1'").get()).toBeTruthy()
    expect((sqlite.prepare("SELECT COUNT(*) as c FROM topics WHERE id='btZero'").get() as { c: number }).c).toBe(1)
  })

  it('concurrent sync() stays exclusive', async () => {
    bindChannel('ch-conc')
    vi.spyOn(syncClient, 'fetchBaseline').mockImplementation(
      async () => new Promise((resolve) => setTimeout(() => resolve({ found: false }), 50))
    )
    vi.spyOn(syncClient, 'push').mockResolvedValue({ cursor: 0, acceptedIds: [] })
    vi.spyOn(syncClient, 'pull').mockResolvedValue({ operations: [], cursor: 0 } as never)
    const first = syncService.sync()
    await expect(syncService.sync()).rejects.toThrow(/already in progress/)
    await first
  })
})
