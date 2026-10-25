/**
 * Remote-sync history-reference invalidation (F1): an OPEN reference target
 * must be told to re-read when the SOURCE changes through sync — source
 * rename/metadata, source message edit, source delete — and when the relation
 * itself arrives/changes/is removed from a peer.
 *
 * Proves the SAME `ChatDb_HistoryReferenceInvalidated` contract the local IPC
 * fan-out uses is emitted from the applied remote operation path (post-commit,
 * LWW winners only), with the source's transitive targets. Unrelated topics
 * emit nothing.
 */
import { randomUUID } from 'node:crypto'

import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')
vi.mock('@main/config', () => ({ DATA_PATH: '/tmp' }))

const storeA = new Map<string, unknown>()
const storeB = new Map<string, unknown>()
let activeStore: Map<string, unknown> = storeA
vi.mock('@main/services/ConfigManager', () => ({
  configManager: {
    get: (k: string, def?: unknown) => (activeStore.has(k) ? activeStore.get(k) : def),
    set: (k: string, v: unknown) => activeStore.set(k, v),
    has: (k: string) => activeStore.has(k)
  },
  ConfigKeys: {}
}))

const { mockReferenceInvalidation, mockChatProjectionInvalidation } = vi.hoisted(() => ({
  mockReferenceInvalidation: vi.fn(),
  mockChatProjectionInvalidation: vi.fn()
}))

vi.mock('../../chatDb/chatProjectionBroadcast', () => ({
  broadcastChatProjectionInvalidation: mockChatProjectionInvalidation,
  broadcastHistoryReferenceInvalidation: mockReferenceInvalidation
}))

import { chatDbService } from '../../chatDb'
import { ChatDbAggregateService } from '../../chatDb/ChatDbAggregateService'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { syncClient } from '../SyncClient'
import { syncService } from '../SyncService'
import { seedRegisteredAttachedSyncService } from './helpers/syncTestRegistration'

function openMem(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}
function msgJson(id: string, topicId: string, content?: string): Record<string, unknown> {
  return {
    id,
    topicId,
    role: 'user',
    content: content ?? `content-${id}`,
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}
function blockJson(id: string, messageId: string): Record<string, unknown> {
  return {
    id,
    messageId,
    type: 'main_text',
    content: `content-${id}`,
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

describe('remote history-reference invalidation', () => {
  let sqliteA: Database.Database
  let sqliteB: Database.Database
  let dbA: BetterSQLite3Database<typeof schema>
  let dbB: BetterSQLite3Database<typeof schema>
  let aggA: ChatDbAggregateService
  let relayOps: Array<{ seq: number; op: any }> = []
  let relaySeq = 0

  const src = 't-inv-src'
  const dst = 't-inv-dst'

  function setPeer(peer: 'A' | 'B'): void {
    activeStore = peer === 'A' ? storeA : storeB
    ;(chatDbService as any).sqlite = peer === 'A' ? sqliteA : sqliteB
    ;(chatDbService as any).db = peer === 'A' ? dbA : dbB
  }

  async function syncPeer(peer: 'A' | 'B'): Promise<void> {
    setPeer(peer)
    await syncService.sync()
  }

  beforeEach(() => {
    storeA.clear()
    storeB.clear()
    activeStore = storeA
    relayOps = []
    relaySeq = 0
    mockReferenceInvalidation.mockClear()
    mockChatProjectionInvalidation.mockClear()
    sqliteA = openMem()
    dbA = drizzle(sqliteA, { schema })
    runMigrations(dbA as any, sqliteA)
    sqliteB = openMem()
    dbB = drizzle(sqliteB, { schema })
    runMigrations(dbB as any, sqliteB)
    aggA = new ChatDbAggregateService(dbA as any, sqliteA as any)

    for (const store of [storeA, storeB]) {
      store.set('sync:endpoint', 'http://127.0.0.1:3032')
      store.set('sync:enabled', true)
    }
    for (const [store, db, peer] of [
      [storeA, dbA, 'A'],
      [storeB, dbB, 'B']
    ] as const) {
      setPeer(peer)
      syncService.clearAllForTests()
      seedRegisteredAttachedSyncService(store, db)
      db.insert(schema.syncState).values({ key: 'deviceId', value: randomUUID() }).run()
      db.insert(schema.syncState).values({ key: 'sync:channelKey', value: 'chan-inv' }).run()
      db.insert(schema.syncState).values({ key: 'cursor', value: '0' }).run()
    }
    setPeer('A')

    vi.spyOn(syncClient, 'push').mockImplementation(async (_endpoint, req: any) => {
      const accepted: string[] = []
      for (const op of req.operations) {
        if (relayOps.some((r) => (r.op.id as string) === op.id)) continue
        relaySeq += 1
        relayOps.push({ seq: relaySeq, op: { ...op, seq: relaySeq } })
        accepted.push(op.id)
      }
      return { cursor: relaySeq, acceptedIds: accepted, channelId: 'chan-inv' } as any
    })
    vi.spyOn(syncClient, 'pull').mockImplementation(async (_endpoint, cursor: number) => {
      const ops = relayOps.filter((r) => r.seq > cursor).map((r) => ({ ...r.op, seq: r.seq }))
      return { operations: ops, cursor: relaySeq, channelId: 'chan-inv' } as any
    })
    vi.spyOn(syncClient, 'fetchBaseline').mockImplementation(async () => ({ found: false }) as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    for (const s of [sqliteA, sqliteB]) {
      try {
        s.close()
      } catch {}
    }
    ;(chatDbService as never as { sqlite: unknown }).sqlite = null
    ;(chatDbService as never as { db: unknown }).db = null
  })

  it('invalidates the open target for remote source edits/delete and relation arrival/removal', async () => {
    aggA.appendMessage(src, msgJson('m-inv-0', src) as never, [blockJson('b-inv-0', 'm-inv-0') as never])
    const created = aggA.createReferencedTopic(src, null, dst, 'm-inv-0')
    expect(created.ok).toBe(true)

    await syncPeer('A')
    await syncPeer('B')

    // Receiver really holds the relation (precondition, not the assertion).
    expect(
      sqliteB.prepare('SELECT source_topic_id FROM topic_references WHERE target_topic_id = ?').get(dst)
    ).toBeTruthy()

    setPeer('B')
    // Strictly above every committed clock on the receiver (wall clocks were
    // used by the converging rounds), so each apply below is a real LWW win.
    const base = Date.now() + 1_000
    const appliedCount = (): number => mockReferenceInvalidation.mock.calls.length
    const expectInvalidated = (): void => {
      const calls = mockReferenceInvalidation.mock.calls
      const hit = calls[calls.length - 1]
      expect(hit?.[0]).toBe(src)
      expect(hit?.[1]).toEqual([dst])
    }

    // 1. Remote relation arrival/change (target-owned) → target re-reads.
    mockReferenceInvalidation.mockClear()
    expect(
      syncService.applyIncomingOperation({
        id: randomUUID(),
        entityType: 'topic_reference',
        op: 'upsert',
        entityId: dst,
        timestamp: base,
        deviceId: 'peer',
        payload: {
          targetTopicId: dst,
          sourceTopicId: src,
          sourceBranchId: null,
          anchorMessageId: 'm-inv-0'
        }
      } as never)
    ).toBe(true)
    expectInvalidated()

    // 2. Remote source message edit → every open target of that source re-reads.
    mockReferenceInvalidation.mockClear()
    expect(
      syncService.applyIncomingOperation({
        id: randomUUID(),
        entityType: 'message',
        op: 'upsert',
        entityId: 'm-inv-0',
        timestamp: base + 10,
        deviceId: 'peer',
        payload: { id: 'm-inv-0', topicId: src, content: 'edited-remote-prefix' }
      } as never)
    ).toBe(true)
    expectInvalidated()

    // 3. Remote source topic rename → target re-reads (divider title follows).
    mockReferenceInvalidation.mockClear()
    expect(
      syncService.applyIncomingOperation({
        id: randomUUID(),
        entityType: 'topic',
        op: 'upsert',
        entityId: src,
        timestamp: base + 20,
        deviceId: 'peer',
        payload: { id: src, name: 'Remote Renamed Source' }
      } as never)
    ).toBe(true)
    expectInvalidated()

    // 4. Remote source delete → target re-reads (relation degrades to missing).
    mockReferenceInvalidation.mockClear()
    expect(
      syncService.applyIncomingOperation({
        id: randomUUID(),
        entityType: 'topic',
        op: 'delete',
        entityId: src,
        timestamp: base + 30,
        deviceId: 'peer'
      } as never)
    ).toBe(true)
    expectInvalidated()
    // The relation row survives the source delete (dangling reference semantics).
    expect(
      sqliteB.prepare('SELECT source_topic_id FROM topic_references WHERE target_topic_id = ?').get(dst)
    ).toBeTruthy()

    // 5. Remote relation removal → the target itself re-reads with the real
    //    source label (captured before the row is deleted).
    mockReferenceInvalidation.mockClear()
    expect(
      syncService.applyIncomingOperation({
        id: randomUUID(),
        entityType: 'topic_reference',
        op: 'delete',
        entityId: dst,
        timestamp: base + 40,
        deviceId: 'peer'
      } as never)
    ).toBe(true)
    expectInvalidated()

    // 6. An unrelated topic with no reference targets emits nothing.
    const before = appliedCount()
    expect(
      syncService.applyIncomingOperation({
        id: randomUUID(),
        entityType: 'topic',
        op: 'upsert',
        entityId: 't-inv-unrelated',
        timestamp: base + 50,
        deviceId: 'peer',
        payload: { id: 't-inv-unrelated', name: 'Unrelated' }
      } as never)
    ).toBe(true)
    expect(appliedCount()).toBe(before)
  })

  it('invalidates reference targets after a baseline merge (relations arrive in bulk)', async () => {
    setPeer('B')
    mockReferenceInvalidation.mockClear()
    // Baseline merge path: a live target topic + its coherent relation merge in
    // one transaction, then the post-commit fan-out runs.
    const mergeReferenceInput = {
      entities: [
        {
          entityType: 'topic' as const,
          entityId: dst,
          payload: {
            id: dst,
            name: 'Baseline Target',
            assistantId: 'assistant-1',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            deletedAt: null,
            pinned: false,
            prompt: null,
            isNameManuallyEdited: false
          },
          entityClock: { timestamp: 100, operationId: 'op-topic' },
          fieldClocks: []
        },
        {
          entityType: 'topic_reference' as const,
          entityId: dst,
          payload: { targetTopicId: dst, sourceTopicId: src, sourceBranchId: null, anchorMessageId: 'm-b-0' },
          entityClock: { timestamp: 101, operationId: 'op-ref' },
          fieldClocks: []
        }
      ],
      tombstones: [],
      orderFrames: []
    }
    const { mergeValidatedBaselineInTx } = await import('../syncBaselineApply')
    const res = dbB.transaction((tx) => mergeValidatedBaselineInTx(tx as never, mergeReferenceInput))
    expect(res.inserted).toBeGreaterThan(0)

    // Post-commit reference fan-out uses the committed inventory.
    const baselineFanOut = (
      syncService as unknown as { broadcastReferenceInvalidationForBaseline: () => void }
    ).broadcastReferenceInvalidationForBaseline.bind(syncService)
    baselineFanOut()
    expect(mockReferenceInvalidation).toHaveBeenCalledWith(src, [dst])
  })
})
