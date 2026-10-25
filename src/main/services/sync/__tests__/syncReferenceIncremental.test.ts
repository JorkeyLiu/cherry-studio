/**
 * Incremental two-device convergence for cross-topic history references.
 *
 * Real Main authority + real SyncService orchestration over a mocked relay
 * transport: creation propagates target + relation, the receiver resolves the
 * live prefix, source edits propagate, a source deletion degrades the receiver
 * to the existing fail-closed "missing" state and recovers when the dependency
 * arrives again, and a target deletion cascades the relation with a delete-wins
 * tombstone that suppresses stale relation replay.
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

describe('history reference incremental sync', () => {
  let sqliteA: Database.Database
  let sqliteB: Database.Database
  let dbA: BetterSQLite3Database<typeof schema>
  let dbB: BetterSQLite3Database<typeof schema>
  let aggA: ChatDbAggregateService
  let aggB: ChatDbAggregateService
  let relayOps: Array<{ seq: number; op: any }> = []
  let relaySeq = 0

  function setPeer(peer: 'A' | 'B'): void {
    activeStore = peer === 'A' ? storeA : storeB
    ;(chatDbService as any).sqlite = peer === 'A' ? sqliteA : sqliteB
    ;(chatDbService as any).db = peer === 'A' ? dbA : dbB
  }

  async function syncPeer(peer: 'A' | 'B'): Promise<void> {
    setPeer(peer)
    await syncService.sync()
  }

  function windowOf(agg: ChatDbAggregateService, topicId: string) {
    const res = agg.fetchMessagesWindow({ kind: 'latest', topicId, limit: 20 })
    if (!(res as any).ok) throw new Error(`window failed: ${JSON.stringify(res)}`)
    return (res as any).value
  }

  beforeEach(() => {
    storeA.clear()
    storeB.clear()
    activeStore = storeA
    relayOps = []
    relaySeq = 0
    sqliteA = openMem()
    dbA = drizzle(sqliteA, { schema })
    runMigrations(dbA as any, sqliteA)
    sqliteB = openMem()
    dbB = drizzle(sqliteB, { schema })
    runMigrations(dbB as any, sqliteB)
    aggA = new ChatDbAggregateService(dbA as any, sqliteA as any)
    aggB = new ChatDbAggregateService(dbB as any, sqliteB as any)

    const endpoint = 'http://127.0.0.1:3031'
    for (const store of [storeA, storeB]) {
      store.set('sync:endpoint', endpoint)
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
      db.insert(schema.syncState).values({ key: 'sync:channelKey', value: 'chan-ref-inc' }).run()
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
      return { cursor: relaySeq, acceptedIds: accepted, channelId: 'chan-ref-inc' } as any
    })
    vi.spyOn(syncClient, 'pull').mockImplementation(async (_endpoint, cursor: number) => {
      const ops = relayOps.filter((r) => r.seq > cursor).map((r) => ({ ...r.op, seq: r.seq }))
      return { operations: ops, cursor: relaySeq, channelId: 'chan-ref-inc' } as any
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

  it('converges creation, source edits, missing-source fail-closed state, recovery, and target cascade', async () => {
    const src = 't-inc-src'
    const dst = 't-inc-dst'
    aggA.appendMessage(src, msgJson('m-inc-0', src) as never, [blockJson('b-inc-0', 'm-inc-0') as never])
    aggA.appendMessage(src, msgJson('m-inc-1', src) as never, [blockJson('b-inc-1', 'm-inc-1') as never])
    const created = aggA.createReferencedTopic(src, null, dst, 'm-inc-1')
    expect(created.ok).toBe(true)
    aggA.appendMessage(dst, msgJson('m-inc-d0', dst) as never, [blockJson('b-inc-d0', 'm-inc-d0') as never])

    await syncPeer('A')
    await syncPeer('B')

    // Receiver: target topic + relation + own suffix all arrived.
    const relB = sqliteB
      .prepare(
        'SELECT source_topic_id, source_branch_id, anchor_message_id FROM topic_references WHERE target_topic_id = ?'
      )
      .get(dst) as { source_topic_id: string; source_branch_id: string | null; anchor_message_id: string } | undefined
    expect(relB).toEqual({ source_topic_id: src, source_branch_id: null, anchor_message_id: 'm-inc-1' })

    const bWindow = windowOf(aggB, dst)
    expect(bWindow.reference.status).toBe('available')
    expect(bWindow.reference.boundaryMessageId).toBe('m-inc-1')
    // Effective route = live foreign prefix (2 source messages) + own suffix.
    expect(bWindow.messages.map((m: { id: string }) => m.id)).toEqual(['m-inc-0', 'm-inc-1', 'm-inc-d0'])
    // No prefix rows were copied onto the target.
    expect((sqliteB.prepare('SELECT COUNT(*) AS c FROM messages WHERE topic_id = ?').get(dst) as { c: number }).c).toBe(
      1
    )

    // Source edit propagates through the relation (no copy to keep in sync).
    setPeer('A')
    const edited = aggA.updateMessage(src, 'm-inc-0', { content: 'edited-prefix' } as never)
    expect((edited as any).ok).toBe(true)
    await syncPeer('A')
    await syncPeer('B')
    const bAfterEdit = windowOf(aggB, dst)
    expect(bAfterEdit.messages.find((m: { id: string }) => m.id === 'm-inc-0').content).toBe('edited-prefix')

    // Source deletion: relation survives (source has no FK) and the prefix is
    // omitted with the existing fail-closed 'missing' status; target + own
    // suffix survive.
    setPeer('A')
    const delSrc = aggA.hardDeleteTopic(src)
    expect((delSrc as any).ok).toBe(true)
    await syncPeer('A')
    await syncPeer('B')
    const bMissing = windowOf(aggB, dst)
    expect(bMissing.reference.status).toBe('missing')
    expect(bMissing.reference.boundaryMessageId).toBeNull()
    expect(bMissing.messages.map((m: { id: string }) => m.id)).toEqual(['m-inc-d0'])

    // Dependency recovery: replaying the source rows makes the relation live
    // again with no relation rewrite.
    const srcTopicOp = relayOps
      .map((r) => r.op)
      .find((op) => op.entityType === 'topic' && op.entityId === src && op.op === 'upsert')
    const srcMsgOp = relayOps.map((r) => r.op).find((op) => op.entityType === 'message' && op.entityId === 'm-inc-1')
    expect(srcTopicOp).toBeTruthy()
    expect(srcMsgOp).toBeTruthy()
    setPeer('B')
    // Re-apply as a higher-clock replay (dependency arrival after the delete).
    const base = Math.max(...relayOps.map((r) => (r.op.timestamp as number) ?? 0)) + 10
    expect(syncService.applyIncomingOperation({ ...srcTopicOp, id: randomUUID(), timestamp: base, op: 'upsert' })).toBe(
      true
    )
    expect(
      syncService.applyIncomingOperation({ ...srcMsgOp, id: randomUUID(), timestamp: base + 1, op: 'upsert' })
    ).toBe(true)
    const bRecovered = windowOf(aggB, dst)
    expect(bRecovered.reference.status).toBe('available')
    expect(bRecovered.messages.map((m: { id: string }) => m.id)).toEqual(['m-inc-1', 'm-inc-d0'])

    // Target deletion cascades the relation with a delete-wins tombstone.
    setPeer('A')
    const staleRelationOp = relayOps
      .map((r) => r.op)
      .find((op) => op.entityType === 'topic_reference' && op.entityId === dst && op.op === 'upsert')
    const delDst = aggA.hardDeleteTopic(dst)
    expect((delDst as any).ok).toBe(true)
    await syncPeer('A')
    await syncPeer('B')
    expect(
      sqliteB.prepare('SELECT target_topic_id FROM topic_references WHERE target_topic_id = ?').get(dst)
    ).toBeUndefined()
    const tombB = sqliteB.prepare('SELECT key FROM sync_state WHERE key = ?').get(`tombstone:topic_reference:${dst}`) as
      | { key: string }
      | undefined
    expect(tombB).toBeDefined()
    // Stale relation replay cannot resurrect a deleted target relation.
    const applied = syncService.applyIncomingOperation({
      ...staleRelationOp,
      id: randomUUID(),
      timestamp: base + 1000
    })
    expect(applied).toBe(false)
    expect(
      sqliteB.prepare('SELECT target_topic_id FROM topic_references WHERE target_topic_id = ?').get(dst)
    ).toBeUndefined()
  })
})
