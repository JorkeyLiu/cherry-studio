/**
 * Parent order frame (010) — local SQLite mutation transactions only.
 * Covers: migration DDL already tested in migration010.test.ts, here we test
 * - local supported creation produces exact topic/message frames and dedicated clocks > all membership clocks; empty frames
 * - additions/deletions update final order atomically; deleted message frame removed; edits do not advance
 * - exact persist idempotence and lower/conflicting frame cannot overwrite
 * - missing/malformed membership or timestamp exhaustion rolls back
 * - unsupported structural paths invalidate prior frames atomically and do not enqueue invented ops
 * - stable unsupported/transient blocks are excluded while diagnostics remain
 *
 * Local prerequisite only; not remote/wire/candidate integration.
 */
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
    set: (k: string, v: unknown) => configStore.set(k, v),
    has: (k: string) => configStore.has(k)
  },
  ConfigKeys: {}
}))

import { chatDbService } from '../../chatDb'
import { ChatDbAggregateService } from '../../chatDb/ChatDbAggregateService'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { syncService } from '../SyncService'
import { seedRegisteredAttachedSyncService } from './helpers/syncTestRegistration'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>
let agg: ChatDbAggregateService

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

function outboxCount(): number {
  return db.select().from(schema.syncOutbox).all().length
}
function frameExists(kind: string, parentId: string): boolean {
  const r = sqlite
    .prepare(`SELECT kind FROM sync_parent_order_frame WHERE kind=? AND parent_id=?`)
    .get(kind, parentId) as { kind: string } | undefined
  return !!r
}
function getFrame(
  kind: string,
  parentId: string
): { orderedChildIds: string[]; timestamp: number; operationId: string; frameVersion: string } | null {
  const r = sqlite
    .prepare(
      `SELECT ordered_child_ids_json as json, timestamp, operation_id as operationId, frame_version as frameVersion FROM sync_parent_order_frame WHERE kind=? AND parent_id=?`
    )
    .get(kind, parentId) as { json: string; timestamp: number; operationId: string; frameVersion: string } | undefined
  if (!r) return null
  return {
    orderedChildIds: JSON.parse(r.json) as string[],
    timestamp: r.timestamp,
    operationId: r.operationId,
    frameVersion: r.frameVersion
  }
}

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
  configStore.set('sync:token', '')
  sqlite = openInMemory()
  db = drizzle(sqlite, { schema })
  runMigrations(db as never, sqlite)
  ;(chatDbService as never as { sqlite: unknown }).sqlite = sqlite
  ;(chatDbService as never as { db: unknown }).db = db
  syncService.clearAllForTests()
  seedRegisteredAttachedSyncService(configStore, db)
  agg = new ChatDbAggregateService(db, sqlite)
})

afterEach(() => {
  vi.restoreAllMocks()
  try {
    sqlite.close()
  } catch {}
  ;(chatDbService as never as { sqlite: unknown }).sqlite = null
  ;(chatDbService as never as { db: unknown }).db = null
})

describe('sync parent order frame — local supported creation', () => {
  it('new stable message creates exact topicMessage frame and empty or stable messageBlock frame with dedicated clocks > membership', () => {
    const T0 = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(T0)
    const topicId = 't-frame-1'
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(topicId, 'T1', '2026-01-01', '2026-01-01')
    const msgId = 'm-frame-1'
    const msgJson = {
      id: msgId,
      topicId,
      role: 'user',
      content: 'hi',
      status: 'success',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01'
    } as never
    const res = agg.appendMessage(topicId, msgJson, [])
    expect(res.ok).toBe(true)
    const frameTopic = getFrame('topicMessage', topicId)
    expect(frameTopic).not.toBeNull()
    expect(frameTopic!.orderedChildIds).toEqual([msgId])
    expect(frameTopic!.frameVersion).toBe('parent-order-frame-v1')
    // Clock must be > membership clock of included child
    const mem = sqlite
      .prepare(`SELECT timestamp FROM sync_membership_clock WHERE child_entity_type='message' AND child_entity_id=?`)
      .get(msgId) as { timestamp: number }
    expect(mem).toBeDefined()
    expect(frameTopic!.timestamp).toBeGreaterThan(mem.timestamp)
    // MessageBlock frame for new message should be empty [] with its own winning clock
    const frameBlock = getFrame('messageBlock', msgId)
    expect(frameBlock).not.toBeNull()
    expect(frameBlock!.orderedChildIds).toEqual([])
    expect(frameBlock!.timestamp).toBeGreaterThanOrEqual(0)

    vi.spyOn(Date, 'now').mockReturnValue(T0 + 1000)
    const msgId2 = 'm-frame-2'
    const blockId = 'b-frame-1'
    const msgJson2 = {
      id: msgId2,
      topicId,
      role: 'assistant',
      content: 'hello',
      status: 'success',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01'
    } as never
    const blockJson = {
      id: blockId,
      messageId: msgId2,
      type: 'main_text',
      content: 'blk',
      status: 'success',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      sortOrder: 0
    } as never
    const res2 = agg.appendMessage(topicId, msgJson2, [blockJson])
    expect(res2.ok).toBe(true)
    const frameTopic2 = getFrame('topicMessage', topicId)
    expect(frameTopic2!.orderedChildIds).toEqual([msgId, msgId2])
    expect(frameTopic2!.timestamp).toBeGreaterThan(frameTopic!.timestamp)
    // Check that second frame timestamp is > both membership clocks
    const mem1 = (
      sqlite.prepare(`SELECT timestamp FROM sync_membership_clock WHERE child_entity_id=?`).get(msgId) as {
        timestamp: number
      }
    ).timestamp
    const mem2 = (
      sqlite.prepare(`SELECT timestamp FROM sync_membership_clock WHERE child_entity_id=?`).get(msgId2) as {
        timestamp: number
      }
    ).timestamp
    expect(frameTopic2!.timestamp).toBeGreaterThan(Math.max(mem1, mem2))

    const frameBlock2 = getFrame('messageBlock', msgId2)
    expect(frameBlock2!.orderedChildIds).toEqual([blockId])
    const memB = (
      sqlite.prepare(`SELECT timestamp FROM sync_membership_clock WHERE child_entity_id=?`).get(blockId) as {
        timestamp: number
      }
    ).timestamp
    expect(frameBlock2!.timestamp).toBeGreaterThan(memB)
    vi.restoreAllMocks()
  })

  it('zero-block/zero-child empty frames', () => {
    const T0 = 1_800_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(T0)
    const topicId = 't-empty'
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(topicId, 'Empty', '2026-01-01', '2026-01-01')
    const msgId = 'm-empty'
    const res = agg.appendMessage(
      topicId,
      { id: msgId, topicId, role: 'user', content: 'hi', status: 'success' } as never,
      []
    )
    expect(res.ok).toBe(true)
    const f1 = getFrame('topicMessage', topicId)
    expect(f1!.orderedChildIds).toEqual([msgId])
    const f2 = getFrame('messageBlock', msgId)
    expect(f2!.orderedChildIds).toEqual([])

    // Create a topic with no messages: manually ensure empty frame via append then delete?
    // Instead test that after deleting the only message, topic frame becomes empty []
    const del = agg.deleteMessage(topicId, msgId)
    expect(del.ok).toBe(true)
    const fAfterDel = getFrame('topicMessage', topicId)
    expect(fAfterDel).not.toBeNull()
    expect(fAfterDel!.orderedChildIds).toEqual([])
    // Deleted message's block frame should be removed
    expect(frameExists('messageBlock', msgId)).toBe(false)
    vi.restoreAllMocks()
  })
})

describe('sync parent order frame — additions/deletions and edit non-advance', () => {
  it('additions update final order atomically; edits do not advance frame', () => {
    const T0 = 1_900_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(T0)
    const topicId = 't-add-edit'
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(topicId, 'T', '2026-01-01', '2026-01-01')
    const m1 = 'm-add-1'
    agg.appendMessage(topicId, { id: m1, topicId, role: 'user', content: 'a', status: 'success' } as never, [])
    const fBefore = getFrame('topicMessage', topicId)!
    const tsBefore = fBefore.timestamp
    // Ordinary content edit with no membership change must not advance frame
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 5000)
    const upd = agg.updateMessage(topicId, m1, { content: 'edited' } as never)
    expect(upd.ok).toBe(true)
    const fAfterEdit = getFrame('topicMessage', topicId)!
    expect(fAfterEdit.timestamp).toBe(tsBefore)
    expect(fAfterEdit.orderedChildIds).toEqual([m1])

    // Add second message: should advance
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 10000)
    const m2 = 'm-add-2'
    agg.appendMessage(topicId, { id: m2, topicId, role: 'user', content: 'b', status: 'success' } as never, [])
    const fAfterAdd = getFrame('topicMessage', topicId)!
    expect(fAfterAdd.orderedChildIds).toEqual([m1, m2])
    expect(fAfterAdd.timestamp).toBeGreaterThan(tsBefore)

    // Add stable block to existing message via bulkAddBlocks: should update messageBlock frame
    const b1 = 'b-add-1'
    const bulkRes = agg.bulkAddBlocks([
      {
        id: b1,
        messageId: m1,
        type: 'main_text',
        content: 'blk1',
        status: 'success',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        sortOrder: 0
      } as never
    ])
    expect(bulkRes.ok).toBe(true)
    const fBlockAfter = getFrame('messageBlock', m1)!
    expect(fBlockAfter.orderedChildIds).toEqual([b1])

    // Edit block content (no membership change) must not advance block frame
    const tsBlockBefore = fBlockAfter.timestamp
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 15000)
    const updBlk = agg.updateSingleBlock(b1, { content: 'blk edited' } as never)
    expect(updBlk.ok).toBe(true)
    const fBlockAfterEdit = getFrame('messageBlock', m1)!
    expect(fBlockAfterEdit.timestamp).toBe(tsBlockBefore)
    vi.restoreAllMocks()
  })

  it('deletions update final order; deleted message frame removed', () => {
    const T0 = 2_000_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(T0)
    const topicId = 't-del-frame'
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(topicId, 'T', '2026-01-01', '2026-01-01')
    const m1 = 'm-del-1'
    const m2 = 'm-del-2'
    agg.appendMessage(topicId, { id: m1, topicId, role: 'user', content: 'a', status: 'success' } as never, [])
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 1000)
    agg.appendMessage(topicId, { id: m2, topicId, role: 'user', content: 'b', status: 'success' } as never, [])
    const fBefore = getFrame('topicMessage', topicId)!
    expect(fBefore.orderedChildIds).toEqual([m1, m2])
    // Create block frame for m1
    const b1 = 'b-del-1'
    agg.bulkAddBlocks([
      {
        id: b1,
        messageId: m1,
        type: 'main_text',
        content: 'blk',
        status: 'success',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        sortOrder: 0
      } as never
    ])
    expect(frameExists('messageBlock', m1)).toBe(true)

    // Delete m2
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 2000)
    const del = agg.deleteMessage(topicId, m2)
    expect(del.ok).toBe(true)
    const fAfter = getFrame('topicMessage', topicId)!
    expect(fAfter.orderedChildIds).toEqual([m1])
    expect(fAfter.timestamp).toBeGreaterThan(fBefore.timestamp)
    expect(frameExists('messageBlock', m2)).toBe(false)
    // m1's block frame should still exist
    expect(frameExists('messageBlock', m1)).toBe(true)

    // Delete remaining block: messageBlock frame should become empty [] not deleted
    const delBlk = agg.deleteBlocks([b1])
    expect(delBlk.ok).toBe(true)
    const fBlockAfterDel = getFrame('messageBlock', m1)!
    expect(fBlockAfterDel.orderedChildIds).toEqual([])
    vi.restoreAllMocks()
  })
})

describe('sync parent order frame — idempotence and lower clock cannot overwrite', () => {
  it('exact persist is idempotent; lower/conflicting frame cannot overwrite', () => {
    const topicId = 't-idem-frame'
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(topicId, 'T', '2026-01-01', '2026-01-01')
    // Create initial frame via append
    const m1 = 'm-idem-1'
    vi.spyOn(Date, 'now').mockReturnValue(2_100_000_000_000)
    agg.appendMessage(topicId, { id: m1, topicId, role: 'user', content: 'hi', status: 'success' } as never, [])
    const f1 = getFrame('topicMessage', topicId)!
    // Exact repeat via direct persist should be idempotent
    // Use service's persist directly inside a transaction
    db.transaction((t) => {
      const res = syncService.persistParentFrameInTx(t as never, {
        kind: 'topicMessage',
        parentId: topicId,
        frameVersion: 'parent-order-frame-v1',
        orderedChildIds: [...f1.orderedChildIds],
        timestamp: f1.timestamp,
        operationId: f1.operationId
      })
      expect(res.reason).toBe('idempotent')
      expect(res.applied).toBe(false)
    })
    const fAfterIdem = getFrame('topicMessage', topicId)!
    expect(fAfterIdem).toEqual(f1)

    // Lower clock cannot overwrite — now throws SyncFrameError (fail-closed)
    expect(() =>
      db.transaction((t) => {
        syncService.persistParentFrameInTx(t as never, {
          kind: 'topicMessage',
          parentId: topicId,
          frameVersion: 'parent-order-frame-v1',
          orderedChildIds: [...f1.orderedChildIds],
          timestamp: f1.timestamp - 1,
          operationId: '00000000-0000-0000-0000-000000000000'
        })
      })
    ).toThrow(/conflicting frame clock/)
    expect(getFrame('topicMessage', topicId)).toEqual(f1)

    // Equal timestamp but lower operationId (lexicographically) cannot overwrite — throws
    expect(() =>
      db.transaction((t) => {
        const lowerOp = f1.operationId.slice(0, -1) + '0'
        const cmp = lowerOp.localeCompare(f1.operationId)
        const opToUse = cmp < 0 ? lowerOp : '00000000-0000-0000-0000-000000000000'
        syncService.persistParentFrameInTx(t as never, {
          kind: 'topicMessage',
          parentId: topicId,
          frameVersion: 'parent-order-frame-v1',
          orderedChildIds: [...f1.orderedChildIds],
          timestamp: f1.timestamp,
          operationId: opToUse
        })
      })
    ).toThrow(/conflicting frame clock/)
    expect(getFrame('topicMessage', topicId)).toEqual(f1)

    // Higher clock can overwrite
    db.transaction((t) => {
      const res = syncService.persistParentFrameInTx(t as never, {
        kind: 'topicMessage',
        parentId: topicId,
        frameVersion: 'parent-order-frame-v1',
        orderedChildIds: [...f1.orderedChildIds],
        timestamp: f1.timestamp + 100,
        operationId: 'ffffffff-ffff-ffff-ffff-ffffffffffff'
      })
      expect(res.applied).toBe(true)
    })
    const fAfterHigher = getFrame('topicMessage', topicId)!
    expect(fAfterHigher.timestamp).toBe(f1.timestamp + 100)
    vi.restoreAllMocks()
  })
})

describe('sync parent order frame — missing/malformed/exhaustion rollback', () => {
  it('missing membership for included child rolls back entity/outbox/membership/frame', () => {
    const topicId = 't-missing-mem'
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(topicId, 'T', '2026-01-01', '2026-01-01')
    // Insert legacy message directly without membership (no sync capture)
    sqlite
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('m-legacy-missing', topicId, 'user', 'legacy', 'success', '2026-01-01', '2026-01-01', 0)
    // Now try to append a new stable message via aggregate - this should attempt to refresh topic frame
    // which will include the legacy child without membership and must fail closed/rollback
    const beforeOutbox = outboxCount()
    const beforeFrame = getFrame('topicMessage', topicId)
    expect(beforeFrame).toBeNull()
    vi.spyOn(Date, 'now').mockReturnValue(2_200_000_000_000)
    const res = agg.appendMessage(
      topicId,
      { id: 'm-new-missing', topicId, role: 'user', content: 'new', status: 'success' } as never,
      []
    )
    // The append should have failed and rolled back
    expect(res.ok).toBe(false)
    // No new message should have been persisted
    const exists = sqlite.prepare(`SELECT id FROM messages WHERE id='m-new-missing'`).get() as
      | { id: string }
      | undefined
    expect(exists).toBeUndefined()
    // No outbox, no membership, no frame
    expect(outboxCount()).toBe(beforeOutbox)
    expect(getFrame('topicMessage', topicId)).toBeNull()
    // Legacy message still exists, but no frame
    const legacyExists = sqlite.prepare(`SELECT id FROM messages WHERE id='m-legacy-missing'`).get()
    expect(legacyExists).toBeTruthy()
    vi.restoreAllMocks()
  })

  it('timestamp exhaustion (MAX_SAFE_INTEGER) rolls back', () => {
    const topicId = 't-exhaust'
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(topicId, 'T', '2026-01-01', '2026-01-01')
    const m1 = 'm-exhaust-1'
    vi.spyOn(Date, 'now').mockReturnValue(9007199254740990)
    const res1 = agg.appendMessage(
      topicId,
      { id: m1, topicId, role: 'user', content: 'hi', status: 'success' } as never,
      []
    )
    expect(res1.ok).toBe(true)
    // Manually set membership timestamp to MAX_SAFE_INTEGER to force exhaustion
    sqlite.prepare(`UPDATE sync_membership_clock SET timestamp=? WHERE child_entity_id=?`).run(9007199254740991, m1)
    // Now try to add another message - the new frame would need max+1 which is overflow
    vi.spyOn(Date, 'now').mockReturnValue(9007199254740991)
    const res2 = agg.appendMessage(
      topicId,
      { id: 'm-exhaust-2', topicId, role: 'user', content: 'hi2', status: 'success' } as never,
      []
    )
    expect(res2.ok).toBe(false)
    // Second message should not exist, and frame should remain as before (not updated)
    const exists2 = sqlite.prepare(`SELECT id FROM messages WHERE id='m-exhaust-2'`).get()
    expect(exists2).toBeUndefined()
    const frame = getFrame('topicMessage', topicId)!
    // Frame should still be the first one, not updated to include second
    expect(frame.orderedChildIds).toEqual([m1])
    vi.restoreAllMocks()
  })
})

describe('sync parent order frame — unsupported structural paths invalidate', () => {
  it('reorderMessages issues order_frame when membership complete; branch/clone/etc still invalidate without frame ops', () => {
    const topicId = 't-unsupported'
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(topicId, 'T', '2026-01-01', '2026-01-01')
    const m1 = 'm-unsup-1'
    const m2 = 'm-unsup-2'
    vi.spyOn(Date, 'now').mockReturnValue(2_300_000_000_000)
    agg.appendMessage(topicId, { id: m1, topicId, role: 'user', content: 'a', status: 'success' } as never, [])
    vi.spyOn(Date, 'now').mockReturnValue(2_300_000_000_001)
    agg.appendMessage(topicId, { id: m2, topicId, role: 'user', content: 'b', status: 'success' } as never, [])
    const frameBefore = getFrame('topicMessage', topicId)!
    expect(frameBefore.orderedChildIds).toEqual([m1, m2])
    const outboxBefore = outboxCount()

    // reorderMessages with complete membership mints a new winning frame +
    // exactly one order_frame op reusing that clock (SYNC-DATA-048)
    const reorder = agg.reorderMessages(topicId, [m2, m1])
    expect(reorder.ok).toBe(true)
    const frameAfterReorder = getFrame('topicMessage', topicId)!
    expect(frameAfterReorder.orderedChildIds).toEqual([m2, m1])
    expect(frameAfterReorder.timestamp).toBeGreaterThan(frameBefore.timestamp)
    expect(outboxCount()).toBe(outboxBefore + 1)
    const reorderCandidates = db
      .select()
      .from(schema.syncOutbox)
      .all()
      .filter((r) => r.op === 'order_frame' && r.entityId === topicId)
    const reorderOp = reorderCandidates[reorderCandidates.length - 1]
    expect(reorderOp).toBeDefined()
    expect(reorderOp.timestamp).toBe(frameAfterReorder.timestamp)
    expect(reorderOp.id).toBe(frameAfterReorder.operationId)
    const reorderPayload = JSON.parse(reorderOp.payloadJson as string) as {
      frameVersion: string
      kind: string
      parentId: string
      orderedChildIds: string[]
      frameClock: { timestamp: number; operationId: string }
    }
    expect(reorderPayload).toEqual({
      frameVersion: 'parent-order-frame-v1',
      kind: 'topicMessage',
      parentId: topicId,
      orderedChildIds: [m2, m1],
      frameClock: { timestamp: frameAfterReorder.timestamp, operationId: frameAfterReorder.operationId }
    })

    // Append m3 on top of the reordered frame
    vi.spyOn(Date, 'now').mockReturnValue(2_300_000_000_010)
    // Need to fix legacy missing membership issue: delete existing messages without membership? Actually m1,m2 have membership, but after reorder we lost frame. Append new should recreate with correct max logic using existing memberships.
    // However m1,m2 are still there with correct order [m2,m1] after reorder. The next append's refresh will include all three and need membership for all.
    // Let's append m3
    const m3 = 'm-unsup-3'
    // Need to ensure we handle the fact that previous reorder left order as [m2,m1]. The next append will be after that.
    // But our append will attempt to refresh topic frame including m1,m2,m3. Since m1,m2 have membership, it should succeed.
    const res3 = agg.appendMessage(
      topicId,
      { id: m3, topicId, role: 'user', content: 'c', status: 'success' } as never,
      []
    )
    // If it failed due to missing membership for m1/m2? No, they have membership.
    expect(res3.ok).toBe(true)
    const frameAfterAppend = getFrame('topicMessage', topicId)!
    expect(frameAfterAppend.orderedChildIds).toEqual([m2, m1, m3])

    // Test branchMessagesToTopic invalidates target frame
    const target = 't-branch-target'
    // First create a frame on target by appending a message
    vi.spyOn(Date, 'now').mockReturnValue(2_300_000_000_020)
    agg.appendMessage(
      target,
      { id: 'm-branch-target-1', topicId: target, role: 'user', content: 'x', status: 'success' } as never,
      []
    )
    const targetFrameBefore = getFrame('topicMessage', target)
    expect(targetFrameBefore).not.toBeNull()
    const outboxBeforeBranch = outboxCount()
    const branch = agg.branchMessagesToTopic(topicId, target, m1)
    expect(branch.ok).toBe(true)
    expect(frameExists('topicMessage', target)).toBe(false)
    expect(outboxCount()).toBe(outboxBeforeBranch) // branch added none (no frame op enqueued, no entity op)

    // Test cloneMessagesToTopic
    const cloneTarget = 't-clone-target'
    vi.spyOn(Date, 'now').mockReturnValue(2_300_000_000_030)
    agg.appendMessage(
      cloneTarget,
      { id: 'm-clone-1', topicId: cloneTarget, role: 'user', content: 'y', status: 'success' } as never,
      []
    )
    const cloneFrameBefore = getFrame('topicMessage', cloneTarget)
    expect(cloneFrameBefore).not.toBeNull()
    const cloneRes = agg.cloneMessagesToTopic(cloneTarget, [
      {
        message: { id: 'm-clone-2', topicId: cloneTarget, role: 'user', content: 'z', status: 'success' } as never,
        blocks: []
      }
    ])
    expect(cloneRes.ok).toBe(true)
    expect(frameExists('topicMessage', cloneTarget)).toBe(false)

    // Test insertMessagesAfterAnchor
    const insertTopic = 't-insert-anchor'
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(insertTopic, 'I', '2026-01-01', '2026-01-01')
    vi.spyOn(Date, 'now').mockReturnValue(2_300_000_000_040)
    agg.appendMessage(
      insertTopic,
      { id: 'm-ins-1', topicId: insertTopic, role: 'user', content: 'a', status: 'success' } as never,
      []
    )
    const insFrameBefore = getFrame('topicMessage', insertTopic)
    expect(insFrameBefore).not.toBeNull()
    const insRes = agg.insertMessagesAfterAnchor(insertTopic, 'm-ins-1', [
      {
        message: { id: 'm-ins-2', topicId: insertTopic, role: 'user', content: 'b', status: 'success' } as never,
        blocks: []
      }
    ])
    expect(insRes.ok).toBe(true)
    // insertMessagesAfterAnchor now participates in incremental sync: stable
    // true-new inclusion refreshes the topic frame (no longer invalidate-only).
    expect(frameExists('topicMessage', insertTopic)).toBe(true)
    expect(getFrame('topicMessage', insertTopic)!.orderedChildIds).toEqual(['m-ins-1', 'm-ins-2'])

    // Test pasteMessagesToTopic
    const pasteTopic = 't-paste'
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(pasteTopic, 'P', '2026-01-01', '2026-01-01')
    vi.spyOn(Date, 'now').mockReturnValue(2_300_000_000_050)
    agg.appendMessage(
      pasteTopic,
      { id: 'm-paste-1', topicId: pasteTopic, role: 'user', content: 'a', status: 'success' } as never,
      []
    )
    const pasteFrameBefore = getFrame('topicMessage', pasteTopic)
    expect(pasteFrameBefore).not.toBeNull()
    const pasteRes = agg.pasteMessagesToTopic(pasteTopic, [
      {
        message: { id: 'm-paste-2', topicId: pasteTopic, role: 'user', content: 'b', status: 'success' } as never,
        blocks: []
      }
    ])
    expect(pasteRes.ok).toBe(true)
    expect(frameExists('topicMessage', pasteTopic)).toBe(false)

    // Test selectAnswerMessage
    const selTopic = 't-select'
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(selTopic, 'S', '2026-01-01', '2026-01-01')
    vi.spyOn(Date, 'now').mockReturnValue(2_300_000_000_060)
    agg.appendMessage(
      selTopic,
      { id: 'm-sel-1', topicId: selTopic, role: 'user', content: 'q', status: 'success' } as never,
      []
    )
    vi.spyOn(Date, 'now').mockReturnValue(2_300_000_000_061)
    agg.appendMessage(
      selTopic,
      {
        id: 'm-sel-2',
        topicId: selTopic,
        role: 'assistant',
        content: 'a1',
        status: 'success',
        askId: 'm-sel-1'
      } as never,
      []
    )
    vi.spyOn(Date, 'now').mockReturnValue(2_300_000_000_062)
    agg.appendMessage(
      selTopic,
      {
        id: 'm-sel-3',
        topicId: selTopic,
        role: 'assistant',
        content: 'a2',
        status: 'success',
        askId: 'm-sel-1'
      } as never,
      []
    )
    const selFrameBefore = getFrame('topicMessage', selTopic)
    expect(selFrameBefore).not.toBeNull()
    const selRes = agg.selectAnswerMessage(selTopic, 'm-sel-2', ['m-sel-2', 'm-sel-3'])
    expect(selRes.ok).toBe(true)
    expect(frameExists('topicMessage', selTopic)).toBe(false)

    // Test resetMessagesForResend and deleteMessagesWithSegments
    const resetTopic = 't-reset'
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(resetTopic, 'R', '2026-01-01', '2026-01-01')
    vi.spyOn(Date, 'now').mockReturnValue(2_300_000_000_070)
    agg.appendMessage(
      resetTopic,
      { id: 'm-reset-1', topicId: resetTopic, role: 'user', content: 'a', status: 'success' } as never,
      []
    )
    const resetFrameBefore = getFrame('topicMessage', resetTopic)
    expect(resetFrameBefore).not.toBeNull()
    const resetRes = agg.resetMessagesForResend(
      resetTopic,
      [
        {
          message: { id: 'm-reset-1', topicId: resetTopic, role: 'user', content: 'a', status: 'success' } as never,
          blocks: []
        }
      ],
      []
    )
    expect(resetRes.ok).toBe(true)
    expect(frameExists('topicMessage', resetTopic)).toBe(false)

    const delSegTopic = 't-del-seg'
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(delSegTopic, 'D', '2026-01-01', '2026-01-01')
    vi.spyOn(Date, 'now').mockReturnValue(2_300_000_000_080)
    agg.appendMessage(
      delSegTopic,
      { id: 'm-del-seg-1', topicId: delSegTopic, role: 'user', content: 'a', status: 'success' } as never,
      []
    )
    const delSegFrameBefore = getFrame('topicMessage', delSegTopic)
    expect(delSegFrameBefore).not.toBeNull()
    const delSegOutboxBefore = outboxCount()
    const delSegRes = agg.deleteMessagesWithSegments(delSegTopic, ['m-del-seg-1'])
    expect(delSegRes.ok).toBe(true)
    // deleteMessagesWithSegments now closes incremental sync: complete
    // membership refreshes the surviving topic to empty [] with one frame op.
    const delSegFrameAfter = getFrame('topicMessage', delSegTopic)
    expect(delSegFrameAfter).not.toBeNull()
    expect(delSegFrameAfter!.orderedChildIds).toEqual([])
    expect(delSegFrameAfter!.timestamp).toBeGreaterThan(delSegFrameBefore!.timestamp)
    expect(outboxCount()).toBe(delSegOutboxBefore + 2) // 1 message delete + 1 order_frame
    expect(frameExists('messageBlock', 'm-del-seg-1')).toBe(false)

    vi.restoreAllMocks()
  })
})

describe('sync parent order frame — stable unsupported/transient exclusion', () => {
  it('stable unsupported/transient blocks are excluded from frame IDs while diagnostics untouched', () => {
    const topicId = 't-exclude'
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(topicId, 'T', '2026-01-01', '2026-01-01')
    const msgId = 'm-exclude'
    vi.spyOn(Date, 'now').mockReturnValue(2_400_000_000_000)
    // Create message with a stable supported block and an unsupported block and a transient block
    const stableBlock = {
      id: 'b-stable',
      messageId: msgId,
      type: 'main_text',
      content: 'stable',
      status: 'success',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      sortOrder: 0
    } as never
    const unsupportedBlock = {
      id: 'b-unsupported',
      messageId: msgId,
      type: 'tool',
      content: 'tool',
      status: 'success',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      sortOrder: 1
    } as never
    const transientBlock = {
      id: 'b-transient',
      messageId: msgId,
      type: 'main_text',
      content: 'trans',
      status: 'streaming',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      sortOrder: 2
    } as never
    const res = agg.appendMessage(
      topicId,
      { id: msgId, topicId, role: 'user', content: 'hi', status: 'success' } as never,
      [stableBlock, unsupportedBlock, transientBlock]
    )
    expect(res.ok).toBe(true)
    // Exclusion (messageBlock extension): a parent holding any
    // transient/unsupported row never mints a frame — frames carry no
    // exclusion authority. Truthful invalidate with 0 op; candidate partial.
    expect(getFrame('messageBlock', msgId)).toBeNull()
    // Ensure unsupported and transient blocks exist in DB but are excluded
    const allBlocks = sqlite
      .prepare(`SELECT id FROM message_blocks WHERE message_id=? ORDER BY sort_order, id`)
      .all(msgId) as { id: string }[]
    expect(allBlocks.map((b) => b.id)).toEqual(['b-stable', 'b-unsupported', 'b-transient'])
    // Diagnostics: ensure that the append still recorded unsupported outcome (capture-error) but frame is correct
    // The unsupported block should have been recorded via capture-error mechanism, but we just check frame correctness
    vi.restoreAllMocks()
  })

  it('topicMessage frame excludes transient messages', () => {
    const topicId = 't-exclude-msg'
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(topicId, 'T', '2026-01-01', '2026-01-01')
    // Directly insert a transient message bypassing sync capture (to simulate existing transient)
    sqlite
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('m-transient', topicId, 'assistant', 'trans', 'streaming', '2026-01-01', '2026-01-01', 0)
    vi.spyOn(Date, 'now').mockReturnValue(2_500_000_000_000)
    const stableMsg = 'm-stable-exclude'
    const res = agg.appendMessage(
      topicId,
      { id: stableMsg, topicId, role: 'user', content: 'hi', status: 'success' } as never,
      []
    )
    expect(res.ok).toBe(true)
    const frame = getFrame('topicMessage', topicId)!
    // Only stable message should be in frame, transient excluded
    expect(frame.orderedChildIds).toEqual([stableMsg])
    vi.restoreAllMocks()
  })
})

describe('sync parent order frame — soft-delete/restore and hard-delete lifecycle', () => {
  it('softDeleteTopic and restoreTopic preserve frame unchanged', () => {
    const topicId = 't-soft-preserve'
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(topicId, 'T', '2026-01-01', '2026-01-01')
    vi.spyOn(Date, 'now').mockReturnValue(2_600_000_000_000)
    agg.appendMessage(topicId, { id: 'm-soft-1', topicId, role: 'user', content: 'a', status: 'success' } as never, [])
    const before = getFrame('topicMessage', topicId)!
    const beforeIds = [...before.orderedChildIds]
    const beforeTs = before.timestamp
    const soft = agg.softDeleteTopic(topicId)
    expect(soft.ok).toBe(true)
    const afterSoft = getFrame('topicMessage', topicId)!
    expect(afterSoft.orderedChildIds).toEqual(beforeIds)
    expect(afterSoft.timestamp).toBe(beforeTs)
    const restore = agg.restoreTopic(topicId)
    expect(restore.ok).toBe(true)
    const afterRestore = getFrame('topicMessage', topicId)!
    expect(afterRestore.orderedChildIds).toEqual(beforeIds)
    expect(afterRestore.timestamp).toBe(beforeTs)
    vi.restoreAllMocks()
  })

  it('append/delete on soft-deleted topic maintains frame', () => {
    const topicId = 't-soft-append'
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(topicId, 'T', '2026-01-01', '2026-01-01')
    vi.spyOn(Date, 'now').mockReturnValue(2_610_000_000_000)
    agg.appendMessage(
      topicId,
      { id: 'm-soft-a-1', topicId, role: 'user', content: 'a', status: 'success' } as never,
      []
    )
    const f1 = getFrame('topicMessage', topicId)!
    agg.softDeleteTopic(topicId)
    const fSoft = getFrame('topicMessage', topicId)!
    expect(fSoft.orderedChildIds).toEqual(f1.orderedChildIds)
    vi.spyOn(Date, 'now').mockReturnValue(2_610_000_000_010)
    const resAppend = agg.appendMessage(
      topicId,
      { id: 'm-soft-a-2', topicId, role: 'user', content: 'b', status: 'success' } as never,
      []
    )
    expect(resAppend.ok).toBe(true)
    const fAfterAppend = getFrame('topicMessage', topicId)!
    expect(fAfterAppend.orderedChildIds).toEqual(['m-soft-a-1', 'm-soft-a-2'])
    expect(fAfterAppend.timestamp).toBeGreaterThan(fSoft.timestamp)
    const del = agg.deleteMessage(topicId, 'm-soft-a-1')
    expect(del.ok).toBe(true)
    const fAfterDel = getFrame('topicMessage', topicId)!
    expect(fAfterDel.orderedChildIds).toEqual(['m-soft-a-2'])
    vi.restoreAllMocks()
  })

  it('hard delete and purge/empty/reset cascades clear topic+descendant frames', () => {
    const topicId = 't-hard-cascade'
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at, assistant_id) VALUES (?, ?, ?, ?, ?)`)
      .run(topicId, 'T', '2026-01-01', '2026-01-01', 'assistant-1')
    vi.spyOn(Date, 'now').mockReturnValue(2_620_000_000_000)
    agg.appendMessage(topicId, { id: 'm-hard-1', topicId, role: 'user', content: 'a', status: 'success' } as never, [
      {
        id: 'b-hard-1',
        messageId: 'm-hard-1',
        type: 'main_text',
        content: 'blk',
        status: 'success',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        sortOrder: 0
      } as never
    ])
    expect(frameExists('topicMessage', topicId)).toBe(true)
    expect(frameExists('messageBlock', 'm-hard-1')).toBe(true)
    const hard = agg.hardDeleteTopic(topicId)
    expect(hard.ok).toBe(true)
    expect(frameExists('topicMessage', topicId)).toBe(false)
    expect(frameExists('messageBlock', 'm-hard-1')).toBe(false)

    // purgeExpiredTopics
    const tPurge = 't-purge-1'
    sqlite
      .prepare(
        `INSERT INTO topics (id, name, created_at, updated_at, deleted_at, assistant_id) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(tPurge, 'P', '2026-01-01', '2026-01-01', '2020-01-01T00:00:00.000Z', 'assistant-1')
    sqlite
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('m-purge-1', tPurge, 'user', 'hi', 'success', '2026-01-01', '2026-01-01', 0)
    sqlite
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('b-purge-1', 'm-purge-1', 'main_text', 'blk', 'success', '2026-01-01', '2026-01-01', 0)
    // Manually insert frames to simulate pre-existing frames
    sqlite
      .prepare(
        `INSERT INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        'topicMessage',
        tPurge,
        'parent-order-frame-v1',
        JSON.stringify(['m-purge-1']),
        1,
        '00000000-0000-0000-0000-000000000001'
      )
    sqlite
      .prepare(
        `INSERT INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        'messageBlock',
        'm-purge-1',
        'parent-order-frame-v1',
        JSON.stringify(['b-purge-1']),
        1,
        '00000000-0000-0000-0000-000000000002'
      )
    const purge = agg.purgeExpiredTopics('2025-01-01T00:00:00.000Z')
    expect(purge.ok).toBe(true)
    expect(frameExists('topicMessage', tPurge)).toBe(false)
    expect(frameExists('messageBlock', 'm-purge-1')).toBe(false)

    // emptyTrashTopics
    const tEmpty = 't-empty-trash'
    sqlite
      .prepare(
        `INSERT INTO topics (id, name, created_at, updated_at, deleted_at, assistant_id) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(tEmpty, 'E', '2026-01-01', '2026-01-01', '2026-01-01T00:00:00.000Z', 'assistant-1')
    sqlite
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('m-empty-1', tEmpty, 'user', 'hi', 'success', '2026-01-01', '2026-01-01', 0)
    sqlite
      .prepare(
        `INSERT INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        'topicMessage',
        tEmpty,
        'parent-order-frame-v1',
        JSON.stringify(['m-empty-1']),
        2,
        '00000000-0000-0000-0000-000000000003'
      )
    sqlite
      .prepare(
        `INSERT INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        'messageBlock',
        'm-empty-1',
        'parent-order-frame-v1',
        JSON.stringify([]),
        2,
        '00000000-0000-0000-0000-000000000004'
      )
    const empty = agg.emptyTrashTopics('assistant-1')
    expect(empty.ok).toBe(true)
    expect(frameExists('topicMessage', tEmpty)).toBe(false)
    expect(frameExists('messageBlock', 'm-empty-1')).toBe(false)

    // resetAssistantTopics
    const tReset1 = 't-reset-1'
    const tReset2 = 't-reset-2'
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at, assistant_id) VALUES (?, ?, ?, ?, ?)`)
      .run(tReset1, 'R1', '2026-01-01', '2026-01-01', 'assistant-reset')
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at, assistant_id) VALUES (?, ?, ?, ?, ?)`)
      .run(tReset2, 'R2', '2026-01-01', '2026-01-01', 'assistant-reset')
    sqlite
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('m-reset-1', tReset1, 'user', 'hi', 'success', '2026-01-01', '2026-01-01', 0)
    sqlite
      .prepare(
        `INSERT INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        'topicMessage',
        tReset1,
        'parent-order-frame-v1',
        JSON.stringify(['m-reset-1']),
        3,
        '00000000-0000-0000-0000-000000000005'
      )
    sqlite
      .prepare(
        `INSERT INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        'messageBlock',
        'm-reset-1',
        'parent-order-frame-v1',
        JSON.stringify([]),
        3,
        '00000000-0000-0000-0000-000000000006'
      )
    const reset = agg.resetAssistantTopics('assistant-reset', 't-reset-replacement')
    expect(reset.ok).toBe(true)
    expect(frameExists('topicMessage', tReset1)).toBe(false)
    expect(frameExists('messageBlock', 'm-reset-1')).toBe(false)
    // replacement topic should remain frameless (no empty frame minted)
    expect(frameExists('topicMessage', 't-reset-replacement')).toBe(false)
    vi.restoreAllMocks()
  })

  it('new topic creation via ensureTopic persists empty topicMessage frame', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_630_000_000_000)
    const topicId = 't-new-empty-frame'
    expect(frameExists('topicMessage', topicId)).toBe(false)
    const res = agg.ensureTopic(topicId, 'assistant-1', 'New Topic')
    expect(res.ok).toBe(true)
    const frame = getFrame('topicMessage', topicId)
    expect(frame).not.toBeNull()
    expect(frame!.orderedChildIds).toEqual([])
    expect(frame!.frameVersion).toBe('parent-order-frame-v1')
    // Existing topic observation must not backfill — second ensure does not create/overwrite
    const tsBefore = frame!.timestamp
    const res2 = agg.ensureTopic(topicId, 'assistant-1', 'New Topic')
    expect(res2.ok).toBe(true)
    const frame2 = getFrame('topicMessage', topicId)!
    expect(frame2.timestamp).toBe(tsBefore)
    vi.restoreAllMocks()
  })
})

describe('sync parent order frame — inclusion transitions and ordinary edits', () => {
  it('stable→transient invalidates locally (transient exclusion is not a cross-device op) and transient→stable gates on membership', () => {
    const topicId = 't-transition-msg'
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(topicId, 'T', '2026-01-01', '2026-01-01')
    vi.spyOn(Date, 'now').mockReturnValue(2_700_000_000_000)
    agg.appendMessage(topicId, { id: 'm-tr-1', topicId, role: 'user', content: 'a', status: 'success' } as never, [
      {
        id: 'b-tr-1',
        messageId: 'm-tr-1',
        type: 'main_text',
        content: 'blk',
        status: 'success',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        sortOrder: 0
      } as never
    ])
    vi.spyOn(Date, 'now').mockReturnValue(2_700_000_000_010)
    agg.appendMessage(topicId, { id: 'm-tr-2', topicId, role: 'user', content: 'b', status: 'success' } as never, [])
    const fBefore = getFrame('topicMessage', topicId)!
    expect(fBefore.orderedChildIds).toEqual(['m-tr-1', 'm-tr-2'])
    expect(frameExists('messageBlock', 'm-tr-1')).toBe(true)
    // Stable→transient: m-tr-2 becomes streaming (SYNC-DATA-048 errata —
    // transient status never rides the wire, so the frame has no
    // member-exclusion authority: same-tx local invalidation, 0 frame op).
    const outboxBeforeTransient = outboxCount()
    const upd = agg.updateMessage(topicId, 'm-tr-2', { status: 'streaming' } as never)
    expect(upd.ok).toBe(true)
    expect(frameExists('topicMessage', topicId)).toBe(false)
    expect(outboxCount()).toBe(outboxBeforeTransient) // no frame op, no entity op
    // messageBlock frame for excluded parent should be invalidated
    expect(frameExists('messageBlock', 'm-tr-2')).toBe(false)
    // Ordinary stable→stable content edit on the remaining member does not
    // recreate the frame (frameless stays frameless without a minting path)
    const edit = agg.updateMessage(topicId, 'm-tr-1', { content: 'edited' } as never)
    expect(edit.ok).toBe(true)
    expect(frameExists('topicMessage', topicId)).toBe(false)
    // Transient→stable promotion: m-tr-2 retains its original membership (created stable), so refresh should succeed
    const promote = agg.updateMessage(topicId, 'm-tr-2', { status: 'success' } as never)
    expect(promote.ok).toBe(true)
    expect(frameExists('topicMessage', topicId)).toBe(true)
    const fAfterPromote = getFrame('topicMessage', topicId)!
    expect(fAfterPromote.orderedChildIds).toEqual(['m-tr-1', 'm-tr-2'])
    vi.restoreAllMocks()
  })

  it('block inclusion transition supported↔unsupported uses helper; ordinary included→included does not advance', () => {
    const topicId = 't-block-transition'
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(topicId, 'T', '2026-01-01', '2026-01-01')
    vi.spyOn(Date, 'now').mockReturnValue(2_710_000_000_000)
    agg.appendMessage(topicId, { id: 'm-bt-1', topicId, role: 'user', content: 'a', status: 'success' } as never, [
      {
        id: 'b-bt-1',
        messageId: 'm-bt-1',
        type: 'main_text',
        content: 'blk1',
        status: 'success',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        sortOrder: 0
      } as never
    ])
    const fBefore = getFrame('messageBlock', 'm-bt-1')!
    expect(fBefore.orderedChildIds).toEqual(['b-bt-1'])
    const tsBefore = fBefore.timestamp
    // Ordinary included→included content edit does not advance
    const edit = agg.updateSingleBlock('b-bt-1', { content: 'blk1 edited' } as never)
    expect(edit.ok).toBe(true)
    const fAfterEdit = getFrame('messageBlock', 'm-bt-1')!
    expect(fAfterEdit.timestamp).toBe(tsBefore)
    // Supported→unsupported exclusion: invalidate with 0 op (no empty mint;
    // transient/unsupported never rides the wire, frames carry no exclusion
    // authority).
    const toUnsupported = agg.updateSingleBlock('b-bt-1', { type: 'tool' } as never)
    expect(toUnsupported.ok).toBe(true)
    expect(getFrame('messageBlock', 'm-bt-1')).toBeNull()
    // Unsupported→supported: add membership? But promotion of existing block without membership stays unversioned; helper will invalidate if missing
    // First, make it supported again but this block now is unsupported→supported transition; it has retained membership from before (original), so helper should refresh to include it
    const toSupported = agg.updateSingleBlock('b-bt-1', { type: 'main_text' } as never)
    expect(toSupported.ok).toBe(true)
    const fAfterSupported = getFrame('messageBlock', 'm-bt-1')!
    // Since block retained original membership clock, it should be included again
    expect(fAfterSupported.orderedChildIds).toEqual(['b-bt-1'])
    vi.restoreAllMocks()
  })
})

describe('sync parent order frame — fail-closed internals and compound parents', () => {
  it('malformed overflow/extra JSON throws SyncFrameError and rolls back', () => {
    const topicId = 't-malformed'
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(topicId, 'T', '2026-01-01', '2026-01-01')
    vi.spyOn(Date, 'now').mockReturnValue(2_800_000_000_000)
    agg.appendMessage(topicId, { id: 'm-mal-1', topicId, role: 'user', content: 'a', status: 'success' } as never, [
      {
        id: 'b-mal-1',
        messageId: 'm-mal-1',
        type: 'main_text',
        content: 'blk',
        status: 'success',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        sortOrder: 0
      } as never
    ])
    // Corrupt extra JSON for the block
    sqlite.prepare(`UPDATE message_blocks SET extra='not-json' WHERE id='b-mal-1'`).run()
    const outboxBefore = outboxCount()
    // Next operation that triggers frame refresh should fail closed due to malformed extra
    // Use bulkAddBlocks that will attempt to refresh parent frame and parse extra
    const res = agg.bulkAddBlocks([
      {
        id: 'b-mal-2',
        messageId: 'm-mal-1',
        type: 'main_text',
        content: 'blk2',
        status: 'success',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        sortOrder: 1
      } as never
    ])
    expect(res.ok).toBe(false)
    // Ensure second block not created and outbox not advanced due to rollback
    const exists = sqlite.prepare(`SELECT id FROM message_blocks WHERE id='b-mal-2'`).get()
    expect(exists).toBeUndefined()
    expect(outboxCount()).toBe(outboxBefore)
    vi.restoreAllMocks()
  })

  it('compound paths invalidate all affected messageBlock parents', () => {
    const topicId = 't-compound'
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(topicId, 'T', '2026-01-01', '2026-01-01')
    vi.spyOn(Date, 'now').mockReturnValue(2_900_000_000_000)
    agg.appendMessage(topicId, { id: 'm-comp-1', topicId, role: 'user', content: 'a', status: 'success' } as never, [
      {
        id: 'b-comp-1',
        messageId: 'm-comp-1',
        type: 'main_text',
        content: 'blk',
        status: 'success',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        sortOrder: 0
      } as never
    ])
    vi.spyOn(Date, 'now').mockReturnValue(2_900_000_000_010)
    agg.appendMessage(topicId, { id: 'm-comp-2', topicId, role: 'user', content: 'b', status: 'success' } as never, [
      {
        id: 'b-comp-2',
        messageId: 'm-comp-2',
        type: 'main_text',
        content: 'blk',
        status: 'success',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        sortOrder: 0
      } as never
    ])
    expect(frameExists('messageBlock', 'm-comp-1')).toBe(true)
    expect(frameExists('messageBlock', 'm-comp-2')).toBe(true)
    // pasteMessagesToTopic with blocks for both messages should invalidate both messageBlock parents plus topicMessage
    const pasteRes = agg.pasteMessagesToTopic(topicId, [
      {
        message: { id: 'm-comp-1', topicId, role: 'user', content: 'a edited', status: 'success' } as never,
        blocks: [
          {
            id: 'b-comp-1',
            messageId: 'm-comp-1',
            type: 'main_text',
            content: 'blk edited',
            status: 'success',
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
            sortOrder: 0
          } as never
        ]
      },
      {
        message: { id: 'm-comp-2', topicId, role: 'user', content: 'b edited', status: 'success' } as never,
        blocks: [
          {
            id: 'b-comp-2',
            messageId: 'm-comp-2',
            type: 'main_text',
            content: 'blk edited',
            status: 'success',
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
            sortOrder: 0
          } as never
        ]
      }
    ])
    expect(pasteRes.ok).toBe(true)
    expect(frameExists('topicMessage', topicId)).toBe(false)
    expect(frameExists('messageBlock', 'm-comp-1')).toBe(false)
    expect(frameExists('messageBlock', 'm-comp-2')).toBe(false)
    // Source-only untouched parent should not be invalidated — create another topic with message
    const srcTopic = 't-src-untouched'
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(srcTopic, 'S', '2026-01-01', '2026-01-01')
    vi.spyOn(Date, 'now').mockReturnValue(2_900_000_000_020)
    agg.appendMessage(
      srcTopic,
      { id: 'm-src-1', topicId: srcTopic, role: 'user', content: 'src', status: 'success' } as never,
      [
        {
          id: 'b-src-1',
          messageId: 'm-src-1',
          type: 'main_text',
          content: 'blk',
          status: 'success',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
          sortOrder: 0
        } as never
      ]
    )
    expect(frameExists('messageBlock', 'm-src-1')).toBe(true)
    // Clone from src to target should not affect src parent
    const cloneRes = agg.cloneMessagesToTopic(topicId, [
      {
        message: { id: 'm-clone-comp', topicId, role: 'user', content: 'clone', status: 'success' } as never,
        blocks: []
      }
    ])
    expect(cloneRes.ok).toBe(true)
    expect(frameExists('messageBlock', 'm-src-1')).toBe(true)
    vi.restoreAllMocks()
  })
})

describe('sync parent order frame — task-specific inclusion gating', () => {
  it('appendMessage existing stable content edit leaves topic frame exact tuple/content unchanged; block creation changes only messageBlock', () => {
    const topicId = 't-task-append-1'
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(topicId, 'T', '2026-01-01', '2026-01-01')
    vi.spyOn(Date, 'now').mockReturnValue(3_000_000_000_000)
    const m1 = 'm-task-append-1'
    const res1 = agg.appendMessage(
      topicId,
      {
        id: m1,
        topicId,
        role: 'user',
        content: 'orig',
        status: 'success',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01'
      } as never,
      []
    )
    expect(res1.ok).toBe(true)
    const topicFrameBefore = getFrame('topicMessage', topicId)!
    const blockFrameBefore = getFrame('messageBlock', m1)!
    const topicTsBefore = topicFrameBefore.timestamp
    const topicIdsBefore = [...topicFrameBefore.orderedChildIds]
    const blockTsBefore = blockFrameBefore.timestamp
    const blockIdsBefore = [...blockFrameBefore.orderedChildIds]

    // Existing stable content edit (no new blocks) must not advance topic frame
    vi.spyOn(Date, 'now').mockReturnValue(3_000_000_000_010)
    const resEdit = agg.appendMessage(
      topicId,
      {
        id: m1,
        topicId,
        role: 'user',
        content: 'edited',
        status: 'success',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-02'
      } as never,
      []
    )
    expect(resEdit.ok).toBe(true)
    const topicFrameAfterEdit = getFrame('topicMessage', topicId)!
    const blockFrameAfterEdit = getFrame('messageBlock', m1)!
    expect(topicFrameAfterEdit.timestamp).toBe(topicTsBefore)
    expect(topicFrameAfterEdit.orderedChildIds).toEqual(topicIdsBefore)
    expect(JSON.stringify(topicFrameAfterEdit.orderedChildIds)).toBe(JSON.stringify(topicIdsBefore))
    expect(blockFrameAfterEdit.timestamp).toBe(blockTsBefore)
    expect(blockFrameAfterEdit.orderedChildIds).toEqual(blockIdsBefore)

    // Block creation in existing stable message changes only messageBlock frame, not topic frame
    vi.spyOn(Date, 'now').mockReturnValue(3_000_000_000_020)
    const bNew = 'b-task-append-new'
    const resBlock = agg.appendMessage(
      topicId,
      {
        id: m1,
        topicId,
        role: 'user',
        content: 'edited2',
        status: 'success',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-03'
      } as never,
      [
        {
          id: bNew,
          messageId: m1,
          type: 'main_text',
          content: 'blk new',
          status: 'success',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
          sortOrder: 0
        } as never
      ]
    )
    expect(resBlock.ok).toBe(true)
    const topicFrameAfterBlock = getFrame('topicMessage', topicId)!
    const blockFrameAfterBlock = getFrame('messageBlock', m1)!
    // Topic frame must remain exact (no advance)
    expect(topicFrameAfterBlock.timestamp).toBe(topicTsBefore)
    expect(topicFrameAfterBlock.orderedChildIds).toEqual(topicIdsBefore)
    // MessageBlock frame must advance and include new block
    expect(blockFrameAfterBlock.timestamp).toBeGreaterThan(blockTsBefore)
    expect(blockFrameAfterBlock.orderedChildIds).toEqual([bNew])
    vi.restoreAllMocks()
  })

  it('deleting transient/unsupported block via updateMessageAndBlocks does not advance frame; deleting included does', () => {
    const topicId = 't-task-del-1'
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(topicId, 'T', '2026-01-01', '2026-01-01')
    const m1 = 'm-task-del-1'
    vi.spyOn(Date, 'now').mockReturnValue(3_100_000_000_000)
    const bIncluded = 'b-task-del-included'
    const bTransient = 'b-task-del-transient'
    const bUnsupported = 'b-task-del-unsupported'
    agg.appendMessage(topicId, { id: m1, topicId, role: 'user', content: 'hi', status: 'success' } as never, [
      {
        id: bIncluded,
        messageId: m1,
        type: 'main_text',
        content: 'inc',
        status: 'success',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        sortOrder: 0
      } as never,
      {
        id: bTransient,
        messageId: m1,
        type: 'main_text',
        content: 'trans',
        status: 'streaming',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        sortOrder: 1
      } as never,
      {
        id: bUnsupported,
        messageId: m1,
        type: 'tool',
        content: 'tool',
        status: 'success',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        sortOrder: 2
      } as never
    ])
    // Exclusion extension: append with any transient/unsupported row
    // invalidates (no filtered mint); candidate stays partial.
    expect(getFrame('messageBlock', m1)).toBeNull()

    // Delete transient block -> stays invalidated (never mints)
    const resDelTrans = agg.updateMessageAndBlocks(topicId, { id: m1 } as never, [], [bTransient])
    expect(resDelTrans.ok).toBe(true)
    expect(getFrame('messageBlock', m1)).toBeNull()

    // Delete unsupported block -> stays invalidated (never mints)
    const resDelUnsup = agg.updateMessageAndBlocks(topicId, { id: m1 } as never, [], [bUnsupported])
    expect(resDelUnsup.ok).toBe(true)
    expect(getFrame('messageBlock', m1)).toBeNull()

    // Delete included block -> after removing the last excluded rows the
    // parent holds only the included deletion; remaining excluded rows still
    // block minting until they are gone. Here transient+unsupported were
    // already deleted, so deleting the last included block mints empty [].
    vi.spyOn(Date, 'now').mockReturnValue(3_100_000_000_010)
    const resDelInc = agg.updateMessageAndBlocks(topicId, { id: m1 } as never, [], [bIncluded])
    expect(resDelInc.ok).toBe(true)
    const frameAfterInc = getFrame('messageBlock', m1)!
    expect(frameAfterInc.orderedChildIds).toEqual([])
    vi.restoreAllMocks()
  })

  it('malformed pre-delete overflow rolls back', () => {
    const topicId = 't-task-mal-del'
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(topicId, 'T', '2026-01-01', '2026-01-01')
    const m1 = 'm-task-mal-del'
    const b1 = 'b-task-mal-del-1'
    const b2 = 'b-task-mal-del-2'
    vi.spyOn(Date, 'now').mockReturnValue(3_200_000_000_000)
    agg.appendMessage(topicId, { id: m1, topicId, role: 'user', content: 'hi', status: 'success' } as never, [
      {
        id: b1,
        messageId: m1,
        type: 'main_text',
        content: 'blk1',
        status: 'success',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        sortOrder: 0
      } as never,
      {
        id: b2,
        messageId: m1,
        type: 'main_text',
        content: 'blk2',
        status: 'success',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        sortOrder: 1
      } as never
    ])
    const frameBefore = getFrame('messageBlock', m1)!
    const tsBefore = frameBefore.timestamp
    const outboxBefore = outboxCount()
    // Corrupt extra JSON for b1
    sqlite.prepare(`UPDATE message_blocks SET extra='not-json' WHERE id=?`).run(b1)
    const res = agg.updateMessageAndBlocks(topicId, { id: m1 } as never, [], [b1])
    expect(res.ok).toBe(false)
    const stillExists = sqlite.prepare(`SELECT id FROM message_blocks WHERE id=?`).get(b1) as { id: string } | undefined
    expect(stillExists).toBeDefined()
    const b2Exists = sqlite.prepare(`SELECT id FROM message_blocks WHERE id=?`).get(b2) as { id: string } | undefined
    expect(b2Exists).toBeDefined()
    const frameAfter = getFrame('messageBlock', m1)!
    expect(frameAfter.timestamp).toBe(tsBefore)
    expect(frameAfter.orderedChildIds).toEqual(frameBefore.orderedChildIds)
    expect(outboxCount()).toBe(outboxBefore)
    vi.restoreAllMocks()
  })
})
