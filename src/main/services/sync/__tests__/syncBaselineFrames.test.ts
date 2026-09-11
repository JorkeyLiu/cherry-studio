/**
 * Frame-aware local baseline candidate/apply tests (SYNC-DATA-033..038).
 * Covers: exact frames including soft-deleted and empty, missing/incomplete,
 * filtering + suffix + UTF-8, digest/ordering, no sortOrder, apply LWW, etc.
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
    set: (k: string, v: unknown) => configStore.set(k, v)
  },
  ConfigKeys: {}
}))

import { chatDbService } from '../../chatDb'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import {
  captureLocalSyncBaselineCandidate,
  computeLocalSyncBaselineDigest,
  type LocalSyncBaselineCandidate,
  SyncBaselineError
} from '../syncBaseline'
import { applyLocalSyncBaselineCandidate, SyncBaselineApplyError } from '../syncBaselineApply'
import { syncService } from '../SyncService'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>
const T = 9_000_000

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('foreign_keys = ON')
  return s
}

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
  configStore.set('sync:token', '')
  sqlite = openInMemory()
  db = drizzle(sqlite, { schema })
  runMigrations(db as any, sqlite)
  ;(chatDbService as any).sqlite = sqlite
  ;(chatDbService as any).db = db
  syncService.clearAllForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
  try {
    sqlite.close()
  } catch {}
  ;(chatDbService as any).sqlite = null
  ;(chatDbService as any).db = null
})

function insertTopic(id: string, deletedAt: string | null = null): void {
  sqlite
    .prepare('INSERT INTO topics (id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?)')
    .run(id, `Topic ${id}`, '2026-01-01', '2026-01-02', deletedAt, null)
}
function insertMessage(id: string, topicId: string, status = 'success'): void {
  sqlite
    .prepare(
      'INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)'
    )
    .run(id, topicId, 'user', 'hello', status, '2026-01-01', '2026-01-02', 0)
}
function insertBlock(id: string, messageId: string, status = 'success', type = 'main_text'): void {
  sqlite
    .prepare(
      'INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)'
    )
    .run(id, messageId, type, 'body', status, '2026-01-01', '2026-01-02', 0, null)
}
function seedEntityClock(type: string, id: string, ts: number, op: string): void {
  db.insert(schema.syncEntityClock).values({ entityType: type, entityId: id, timestamp: ts, operationId: op }).run()
}
function seedFieldClock(type: string, id: string, field: string, ts: number, op: string): void {
  db.insert(schema.syncFieldClock)
    .values({ entityType: type, entityId: id, field, timestamp: ts, operationId: op })
    .run()
}
const TOPIC_FIELDS = ['name', 'assistantId', 'createdAt', 'updatedAt', 'deletedAt']
const MSG_FIELDS = ['role', 'content', 'status', 'askId', 'model', 'modelId', 'assistantId', 'createdAt', 'updatedAt']
const BLOCK_FIELDS = ['type', 'content', 'status', 'createdAt', 'updatedAt']
function seedFull(type: string, id: string, ts: number, op: string): void {
  const fields = type === 'topic' ? TOPIC_FIELDS : type === 'message' ? MSG_FIELDS : BLOCK_FIELDS
  for (const f of fields) seedFieldClock(type, id, f, ts, op)
}
function seedMembership(
  childType: 'message' | 'message_block',
  childId: string,
  parentId: string,
  ts: number,
  op: string
): void {
  db.insert(schema.syncMembershipClock)
    .values({ childEntityType: childType, childEntityId: childId, parentId, timestamp: ts, operationId: op })
    .run()
}
function seedFrame(
  kind: 'topicMessage' | 'messageBlock',
  parentId: string,
  ordered: string[],
  ts: number,
  op: string
): void {
  sqlite
    .prepare(
      'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
    )
    .run(kind, parentId, 'parent-order-frame-v1', JSON.stringify(ordered), ts, op)
}
function seedBound(): void {
  sqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('cursor', '7')
  sqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('sync:channelKey', 'chan-1')
}

describe('capture exact frames', () => {
  it('captures exact topicMessage and messageBlock frames including soft-deleted topic and empty parents', () => {
    insertTopic('t-soft', '2026-02-01T00:00:00.000Z')
    insertTopic('t-empty')
    insertMessage('m1', 't-soft')
    insertMessage('m2', 't-empty')
    insertBlock('b1', 'm1')
    // m2 has no blocks -> empty frame
    for (const [type, id] of [
      ['topic', 't-soft'],
      ['topic', 't-empty'],
      ['message', 'm1'],
      ['message', 'm2'],
      ['message_block', 'b1']
    ] as const) {
      seedEntityClock(type, id, T, `op-${id}`)
      seedFull(type, id, T, `op-${id}`)
    }
    seedMembership('message', 'm1', 't-soft', T, 'op-m1')
    seedMembership('message', 'm2', 't-empty', T, 'op-m2')
    seedMembership('message_block', 'b1', 'm1', T, 'op-b1')
    seedFrame('topicMessage', 't-soft', ['m1'], T + 10, 'op-frame-tsoft')
    seedFrame('topicMessage', 't-empty', ['m2'], T + 10, 'op-frame-tempty')
    seedFrame('messageBlock', 'm1', ['b1'], T + 10, 'op-frame-m1')
    seedFrame('messageBlock', 'm2', [], T + 10, 'op-frame-m2')
    seedBound()
    const c = captureLocalSyncBaselineCandidate(db)
    expect(c.orderFrames.find((f) => f.parentId === 't-soft')?.orderedChildIds).toEqual(['m1'])
    expect(c.orderFrames.find((f) => f.parentId === 'm2')?.orderedChildIds).toEqual([])
    expect(c.completeness.state).toBe('complete')
  })

  it('missing frames => counts/reasons/partial; no backfill', () => {
    insertTopic('t-miss')
    insertMessage('m-miss', 't-miss')
    for (const [type, id] of [
      ['topic', 't-miss'],
      ['message', 'm-miss']
    ] as const) {
      seedEntityClock(type, id, T, `op-${id}`)
      seedFull(type, id, T, `op-${id}`)
    }
    seedMembership('message', 'm-miss', 't-miss', T, 'op-m-miss')
    // No frames inserted
    seedBound()
    const c = captureLocalSyncBaselineCandidate(db)
    expect(c.manifest.missingOrderFrameCount).toBe(2) // t-miss and m-miss
    expect(c.manifest.frameCounts.topicMessage).toBe(0)
    expect(c.completeness.state).toBe('partial')
    expect(c.completeness.reasons).toContain('missing-order-frame')
  })
})

describe('filtering + suffix', () => {
  it('filters dead/unknown/different-parent and appends suffix deterministically by membership then UTF-8', () => {
    insertTopic('t-a')
    insertTopic('t-b')
    insertMessage('m-a1', 't-a')
    insertMessage('m-a2', 't-a')
    insertMessage('m-a3', 't-a')
    insertMessage('m-b1', 't-b')
    for (const id of ['t-a', 't-b', 'm-a1', 'm-a2', 'm-a3', 'm-b1']) {
      const type = id.startsWith('t-') ? 'topic' : 'message'
      seedEntityClock(type, id, T, `op-${id}`)
      seedFull(type, id, T, `op-${id}`)
    }
    // membership clocks: m-a1 T, m-a2 T+5, m-a3 T+10, m-b1 T (different parent)
    seedMembership('message', 'm-a1', 't-a', T, 'op-m-a1')
    seedMembership('message', 'm-a2', 't-a', T + 5, 'op-m-a2')
    seedMembership('message', 'm-a3', 't-a', T + 10, 'op-m-a3')
    seedMembership('message', 'm-b1', 't-b', T, 'op-m-b1')
    // Frame for t-a contains m-a1, unknown m-unknown, and m-a2 (which is <= frameClock? frameClock T+6)
    // FrameClock T+6 should cover m-a1 (T) and m-a2 (T+5) but not m-a3 (T+10) which is suffix
    // Unknown should be filtered; different-parent is tested as fail-closed separately
    seedFrame('topicMessage', 't-a', ['m-a1', 'm-unknown', 'm-a2'], T + 6, 'op-frame-a')
    seedFrame('topicMessage', 't-b', ['m-b1'], T + 6, 'op-frame-b')
    // Need messageBlock frames for m-a1,m-a2,m-a3,m-b1 (empty)
    for (const mid of ['m-a1', 'm-a2', 'm-a3', 'm-b1']) seedFrame('messageBlock', mid, [], T + 6, `op-frame-${mid}`)
    seedBound()
    // Raw frame has duplicate, unknown, different-parent, but capture should filter
    // For t-a, filtered should be ['m-a1','m-a2'] (duplicate second m-a1 filtered, unknown and m-b1 filtered), and suffix should be ['m-a3'] (since T+10 > T+6)
    // But m-a3 is suffix, so effective should be ['m-a1','m-a2','m-a3']
    const c = captureLocalSyncBaselineCandidate(db)
    const fA = c.orderFrames.find((f) => f.parentId === 't-a')!
    // Unknown should be filtered, suffix m-a3 should be appended deterministically
    expect(fA.orderedChildIds).toEqual(['m-a1', 'm-a2', 'm-a3'])
    expect(c.completeness.state).toBe('complete')
  })

  it('malformed duplicate/orphan/parent mismatch fail closed', () => {
    insertTopic('t-dup')
    insertMessage('m-dup1', 't-dup')
    seedEntityClock('topic', 't-dup', T, 'op-tdup')
    seedEntityClock('message', 'm-dup1', T, 'op-mdup1')
    seedFull('topic', 't-dup', T, 'op-tdup')
    seedFull('message', 'm-dup1', T, 'op-mdup1')
    seedMembership('message', 'm-dup1', 't-dup', T, 'op-mdup1')
    seedFrame('topicMessage', 't-dup', ['m-dup1', 'm-dup1'], T + 10, 'op-frame-dup')
    seedFrame('messageBlock', 'm-dup1', [], T + 10, 'op-frame-dup-m')
    seedBound()
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(SyncBaselineError)

    // Orphan frame parent
    sqlite.prepare('DELETE FROM sync_parent_order_frame WHERE parent_id=?').run('t-dup')
    sqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('topicMessage', 't-orphan-missing', 'parent-order-frame-v1', JSON.stringify([]), T + 10, 'op-orphan')
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(SyncBaselineError)

    // Parent mismatch: frame for t-dup contains m-b1 which belongs to t-b
    sqlite.prepare('DELETE FROM sync_parent_order_frame WHERE parent_id=?').run('t-orphan-missing')
    insertTopic('t-b2')
    insertMessage('m-b2', 't-b2')
    seedEntityClock('topic', 't-b2', T, 'op-tb2')
    seedEntityClock('message', 'm-b2', T, 'op-mb2')
    seedFull('topic', 't-b2', T, 'op-tb2')
    seedFull('message', 'm-b2', T, 'op-mb2')
    seedMembership('message', 'm-b2', 't-b2', T, 'op-mb2')
    seedFrame('topicMessage', 't-b2', ['m-b2'], T + 10, 'op-frame-tb2')
    seedFrame('messageBlock', 'm-b2', [], T + 10, 'op-frame-mb2')
    // Now create frame for t-dup that incorrectly contains m-b2
    sqlite.prepare('DELETE FROM sync_parent_order_frame WHERE parent_id=?').run('t-dup')
    seedFrame('topicMessage', 't-dup', ['m-b2'], T + 10, 'op-frame-mismatch')
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(SyncBaselineError)
  })

  it('incomplete when <= cutoff child missing, suffix appended deterministically', () => {
    insertTopic('t-inc')
    insertMessage('m-early', 't-inc')
    insertMessage('m-late', 't-inc')
    for (const id of ['t-inc', 'm-early', 'm-late']) {
      const type = id.startsWith('t-') ? 'topic' : 'message'
      seedEntityClock(type, id, T, `op-${id}`)
      seedFull(type, id, T, `op-${id}`)
    }
    seedMembership('message', 'm-early', 't-inc', T, 'op-m-early')
    seedMembership('message', 'm-late', 't-inc', T + 20, 'op-m-late')
    // Frame with clock T+10 includes only m-late, missing m-early which is <= frameClock
    seedFrame('topicMessage', 't-inc', ['m-late'], T + 10, 'op-frame-inc')
    seedFrame('messageBlock', 'm-early', [], T + 10, 'op-frame-early')
    seedFrame('messageBlock', 'm-late', [], T + 10, 'op-frame-late')
    seedBound()
    const c = captureLocalSyncBaselineCandidate(db)
    expect(c.manifest.incompleteOrderFrameCount).toBe(1)
    expect(c.completeness.reasons).toContain('incomplete-order-frame')
    expect(c.completeness.state).toBe('partial')
    // The frame's effective should be filtered + suffix? But since m-early is <=, it's incomplete, not suffix
  })

  it('retained tombstoned parent frames omitted truthfully', () => {
    insertTopic('t-tomb')
    seedEntityClock('topic', 't-tomb', T, 'op-tomb')
    seedFull('topic', 't-tomb', T, 'op-tomb')
    seedFrame('topicMessage', 't-tomb', [], T + 10, 'op-frame-tomb')
    seedBound()
    // Hard delete topic (creates tombstone, removes frame)
    sqlite.prepare('DELETE FROM topics WHERE id=?').run('t-tomb')
    sqlite
      .prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)')
      .run('tombstone:topic:t-tomb', `${T + 20}:op-del-tomb`)
    // Retain frame for tombstoned parent (simulate old retained)
    sqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('topicMessage', 't-tomb', 'parent-order-frame-v1', JSON.stringify([]), T + 10, 'op-frame-tomb')
    const c = captureLocalSyncBaselineCandidate(db)
    // Frame for tombstoned parent should be omitted, not counted as missing
    expect(c.orderFrames.find((f) => f.parentId === 't-tomb')).toBeUndefined()
    expect(c.manifest.missingOrderFrameCount).toBe(0)
  })
})

describe('digest and ordering', () => {
  it('digest includes frames and frame ordering is deterministic (UTF-8)', () => {
    insertTopic('t-a')
    insertTopic('t-b')
    insertMessage('m-a', 't-a')
    insertMessage('m-b', 't-b')
    for (const id of ['t-a', 't-b', 'm-a', 'm-b']) {
      const type = id.startsWith('t-') ? 'topic' : 'message'
      seedEntityClock(type, id, T, `op-${id}`)
      seedFull(type, id, T, `op-${id}`)
    }
    seedMembership('message', 'm-a', 't-a', T, 'op-m-a')
    seedMembership('message', 'm-b', 't-b', T, 'op-m-b')
    seedFrame('topicMessage', 't-b', ['m-b'], T + 10, 'op-frame-b')
    seedFrame('topicMessage', 't-a', ['m-a'], T + 10, 'op-frame-a')
    seedFrame('messageBlock', 'm-a', [], T + 10, 'op-frame-ma')
    seedFrame('messageBlock', 'm-b', [], T + 10, 'op-frame-mb')
    seedBound()
    const c1 = captureLocalSyncBaselineCandidate(db)
    const digest1 = c1.manifest.digest
    // Reorder insertion order shouldn't affect digest (frames sorted)
    // Capture again should be same
    const c2 = captureLocalSyncBaselineCandidate(db)
    expect(c2.manifest.digest).toBe(digest1)
    expect(c1.orderFrames.map((f) => f.parentId)).toEqual(['t-a', 't-b', 'm-a', 'm-b']) // kind rank then parentId: topicMessage first, then messageBlock
    // Change frame order should change digest
    const c3 = JSON.parse(JSON.stringify(c1)) as LocalSyncBaselineCandidate
    c3.orderFrames[0].orderedChildIds = ['different']
    const digest3 = computeLocalSyncBaselineDigest(c3)
    expect(digest3).not.toBe(digest1)
  })

  it('candidate payload contains no sortOrder despite legacy clocks', () => {
    insertTopic('t-sort')
    insertMessage('m-sort', 't-sort')
    seedEntityClock('topic', 't-sort', T, 'op-tsort')
    seedEntityClock('message', 'm-sort', T, 'op-msort')
    seedFull('topic', 't-sort', T, 'op-tsort')
    seedFull('message', 'm-sort', T, 'op-msort')
    seedMembership('message', 'm-sort', 't-sort', T, 'op-msort')
    // Legacy sortOrder field clock
    db.insert(schema.syncFieldClock)
      .values({ entityType: 'message', entityId: 'm-sort', field: 'sortOrder', timestamp: T, operationId: 'op-msort' })
      .run()
    seedFrame('topicMessage', 't-sort', ['m-sort'], T + 10, 'op-frame-sort')
    seedFrame('messageBlock', 'm-sort', [], T + 10, 'op-frame-msort')
    seedBound()
    const c = captureLocalSyncBaselineCandidate(db)
    const m = c.entities.find((e) => e.entityId === 'm-sort')!
    expect(Object.keys(m.payload)).not.toContain('sortOrder')
    expect(m.fieldClocks.map((f) => f.field)).not.toContain('sortOrder')
    expect(c.completeness.state).toBe('complete')
  })
})

describe('apply frame LWW and materialization', () => {
  it('frame LWW winner, idempotent, equal-clock conflict, lower loses but entity triggers fixed-point, suffix, empty, dense', async () => {
    // This is a combined test for apply behaviors; we use two DBs as in apply tests
    const srcSqlite = openInMemory()
    const srcDb = drizzle(srcSqlite, { schema })
    runMigrations(srcDb as any, srcSqlite)
    const dstSqlite = openInMemory()
    const dstDb = drizzle(dstSqlite, { schema })
    runMigrations(dstDb as any, dstSqlite)
    ;(chatDbService as any).sqlite = dstSqlite
    ;(chatDbService as any).db = dstDb

    // Src: t1 with m1,m2
    srcSqlite.prepare('INSERT INTO topics (id, name) VALUES (?,?)').run('t1', 'T1')
    srcSqlite
      .prepare('INSERT INTO messages (id, topic_id, role, status, sort_order) VALUES (?,?,?,?,?)')
      .run('m1', 't1', 'user', 'success', 5)
    srcSqlite
      .prepare('INSERT INTO messages (id, topic_id, role, status, sort_order) VALUES (?,?,?,?,?)')
      .run('m2', 't1', 'user', 'success', 2)
    for (const id of ['t1', 'm1', 'm2']) {
      const type = id.startsWith('t') ? 'topic' : 'message'
      srcDb
        .insert(schema.syncEntityClock)
        .values({ entityType: type, entityId: id, timestamp: T, operationId: `op-${id}` })
        .run()
      const fields = type === 'topic' ? TOPIC_FIELDS : MSG_FIELDS
      for (const f of fields)
        srcDb
          .insert(schema.syncFieldClock)
          .values({ entityType: type, entityId: id, field: f, timestamp: T, operationId: `op-${id}` })
          .run()
    }
    srcDb
      .insert(schema.syncMembershipClock)
      .values({ childEntityType: 'message', childEntityId: 'm1', parentId: 't1', timestamp: T, operationId: 'op-m1' })
      .run()
    srcDb
      .insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message',
        childEntityId: 'm2',
        parentId: 't1',
        timestamp: T + 5,
        operationId: 'op-m2'
      })
      .run()
    // Frame for t1 with order [m1,m2] clock T+10
    srcSqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('topicMessage', 't1', 'parent-order-frame-v1', JSON.stringify(['m1', 'm2']), T + 10, 'op-frame-t1')
    srcSqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('messageBlock', 'm1', 'parent-order-frame-v1', JSON.stringify([]), T + 10, 'op-frame-m1')
    srcSqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('messageBlock', 'm2', 'parent-order-frame-v1', JSON.stringify([]), T + 10, 'op-frame-m2')
    srcSqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('cursor', '7')
    srcSqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('sync:channelKey', 'chan-1')
    const cand = captureLocalSyncBaselineCandidate(srcDb)
    expect(cand.completeness.state).toBe('complete')
    // Apply to dst (empty)
    const res1 = applyLocalSyncBaselineCandidate(dstDb, cand)
    expect(res1.inserted).toBe(3)
    // Check dense sortOrder
    const rows = dstSqlite
      .prepare('SELECT id, sort_order FROM messages WHERE topic_id=? ORDER BY sort_order, id')
      .all('t1') as { id: string; sort_order: number }[]
    expect(rows.map((r) => r.id)).toEqual(['m1', 'm2'])
    expect(rows.map((r) => r.sort_order)).toEqual([0, 1])

    // Idempotent second apply
    const res2 = applyLocalSyncBaselineCandidate(dstDb, cand)
    expect(res2.inserted).toBe(0)

    // Equal clock divergent should fail
    const cand2 = JSON.parse(JSON.stringify(cand)) as LocalSyncBaselineCandidate
    cand2.orderFrames.find((f) => f.parentId === 't1')!.orderedChildIds = ['m2', 'm1']
    cand2.manifest.digest = computeLocalSyncBaselineDigest(cand2)
    expect(() => applyLocalSyncBaselineCandidate(dstDb, cand2)).toThrow(SyncBaselineApplyError)

    // Lower incoming loses but entity change triggers fixed-point: add new message m3 with later clock
    const src2Sqlite = openInMemory()
    const src2Db = drizzle(src2Sqlite, { schema })
    runMigrations(src2Db as any, src2Sqlite)
    src2Sqlite.prepare('INSERT INTO topics (id, name) VALUES (?,?)').run('t1', 'T1')
    src2Sqlite
      .prepare('INSERT INTO messages (id, topic_id, role, status, sort_order) VALUES (?,?,?,?,?)')
      .run('m1', 't1', 'user', 'success', 0)
    src2Sqlite
      .prepare('INSERT INTO messages (id, topic_id, role, status, sort_order) VALUES (?,?,?,?,?)')
      .run('m2', 't1', 'user', 'success', 0)
    src2Sqlite
      .prepare('INSERT INTO messages (id, topic_id, role, status, sort_order) VALUES (?,?,?,?,?)')
      .run('m3', 't1', 'user', 'success', 0)
    for (const id of ['t1', 'm1', 'm2', 'm3']) {
      const type = id.startsWith('t') ? 'topic' : 'message'
      const op = id === 'm3' ? 'op2-m3' : `op-${id}`
      src2Db
        .insert(schema.syncEntityClock)
        .values({ entityType: type, entityId: id, timestamp: T, operationId: op })
        .run()
      const fields = type === 'topic' ? TOPIC_FIELDS : MSG_FIELDS
      for (const f of fields)
        src2Db
          .insert(schema.syncFieldClock)
          .values({ entityType: type, entityId: id, field: f, timestamp: T, operationId: op })
          .run()
    }
    src2Db
      .insert(schema.syncMembershipClock)
      .values({ childEntityType: 'message', childEntityId: 'm1', parentId: 't1', timestamp: T, operationId: 'op-m1' })
      .run()
    src2Db
      .insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message',
        childEntityId: 'm2',
        parentId: 't1',
        timestamp: T + 5,
        operationId: 'op-m2'
      })
      .run()
    src2Db
      .insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message',
        childEntityId: 'm3',
        parentId: 't1',
        timestamp: T + 20,
        operationId: 'op2-m3'
      })
      .run()
    // Lower frame (T+9) should lose to existing T+10, but m3 has clock T+20 > T+10, so suffix should append
    src2Sqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('topicMessage', 't1', 'parent-order-frame-v1', JSON.stringify(['m1', 'm2']), T + 9, 'op-lower')
    src2Sqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('messageBlock', 'm1', 'parent-order-frame-v1', JSON.stringify([]), T + 9, 'op-lower-m1')
    src2Sqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('messageBlock', 'm2', 'parent-order-frame-v1', JSON.stringify([]), T + 9, 'op-lower-m2')
    src2Sqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('messageBlock', 'm3', 'parent-order-frame-v1', JSON.stringify([]), T + 9, 'op-lower-m3')
    src2Sqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('cursor', '7')
    src2Sqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('sync:channelKey', 'chan-1')
    const candLower = captureLocalSyncBaselineCandidate(src2Db)
    // candLower's frame for t1 is lower (T+9) but its effective after suffix should include m3 as suffix? However candidate's capture will have evaluated frame with suffix, so its orderedChildIds should be ['m1','m2','m3']? Let's see: frameClock T+9, live children m1(T), m2(T+5), m3(T+20) => m1,m2 are <=, must be in list, they are, m3 is > so suffix, so effective is ['m1','m2','m3']
    expect(candLower.orderFrames.find((f) => f.parentId === 't1')?.orderedChildIds).toEqual(['m1', 'm2', 'm3'])
    // Apply lower candidate to dst which has higher winning frame (T+10) - lower should lose, but m3 entity insertion should trigger fixed-point with higher frame + suffix
    applyLocalSyncBaselineCandidate(dstDb, candLower)
    // After apply, dst should have m3 and dense order should be m1,m2,m3
    const rows2 = dstSqlite
      .prepare('SELECT id, sort_order FROM messages WHERE topic_id=? ORDER BY sort_order')
      .all('t1') as { id: string; sort_order: number }[]
    expect(rows2.map((r) => r.id)).toEqual(['m1', 'm2', 'm3'])
  })
})

describe('arrival order independence', () => {
  it('baseline/entity-frame combinations independent of arrival order', () => {
    const srcA = openInMemory()
    const dbA = drizzle(srcA, { schema })
    runMigrations(dbA as any, srcA)
    const srcB = openInMemory()
    const dbB = drizzle(srcB, { schema })
    runMigrations(dbB as any, srcB)
    // Both have same topic/messages but different frame clocks
    for (const [s, d] of [
      [srcA, dbA],
      [srcB, dbB]
    ] as const) {
      s.prepare('INSERT INTO topics (id, name) VALUES (?,?)').run('t-arr', 'T')
      s.prepare('INSERT INTO messages (id, topic_id, role, status, sort_order) VALUES (?,?,?,?,?)').run(
        'm1',
        't-arr',
        'user',
        'success',
        0
      )
      s.prepare('INSERT INTO messages (id, topic_id, role, status, sort_order) VALUES (?,?,?,?,?)').run(
        'm2',
        't-arr',
        'user',
        'success',
        0
      )
      for (const id of ['t-arr', 'm1', 'm2']) {
        const type = id.startsWith('t') ? 'topic' : 'message'
        d.insert(schema.syncEntityClock)
          .values({ entityType: type, entityId: id, timestamp: T, operationId: `op-${id}` })
          .run()
        const fields = type === 'topic' ? TOPIC_FIELDS : MSG_FIELDS
        for (const f of fields)
          d.insert(schema.syncFieldClock)
            .values({ entityType: type, entityId: id, field: f, timestamp: T, operationId: `op-${id}` })
            .run()
      }
      d.insert(schema.syncMembershipClock)
        .values({
          childEntityType: 'message',
          childEntityId: 'm1',
          parentId: 't-arr',
          timestamp: T,
          operationId: 'op-m1'
        })
        .run()
      d.insert(schema.syncMembershipClock)
        .values({
          childEntityType: 'message',
          childEntityId: 'm2',
          parentId: 't-arr',
          timestamp: T + 5,
          operationId: 'op-m2'
        })
        .run()
    }
    // A has frame [m1,m2] clock T+10
    srcA
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('topicMessage', 't-arr', 'parent-order-frame-v1', JSON.stringify(['m1', 'm2']), T + 10, 'op-frame-a')
    srcA
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('messageBlock', 'm1', 'parent-order-frame-v1', JSON.stringify([]), T + 10, 'op-frame-m1a')
    srcA
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('messageBlock', 'm2', 'parent-order-frame-v1', JSON.stringify([]), T + 10, 'op-frame-m2a')
    // B has frame [m2,m1] clock T+9 (lower, should lose) but entity clocks same
    srcB
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('topicMessage', 't-arr', 'parent-order-frame-v1', JSON.stringify(['m2', 'm1']), T + 9, 'op-frame-b')
    srcB
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('messageBlock', 'm1', 'parent-order-frame-v1', JSON.stringify([]), T + 9, 'op-frame-m1b')
    srcB
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('messageBlock', 'm2', 'parent-order-frame-v1', JSON.stringify([]), T + 9, 'op-frame-m2b')
    srcA.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('cursor', '7')
    srcA.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('sync:channelKey', 'chan-1')
    srcB.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('cursor', '7')
    srcB.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('sync:channelKey', 'chan-1')
    const candA = captureLocalSyncBaselineCandidate(dbA)
    const candB = captureLocalSyncBaselineCandidate(dbB)
    // Apply A then B vs B then A should yield same dense order
    const dst1 = openInMemory()
    const db1 = drizzle(dst1, { schema })
    runMigrations(db1 as any, dst1)
    ;(chatDbService as any).sqlite = dst1
    ;(chatDbService as any).db = db1
    applyLocalSyncBaselineCandidate(db1, candA)
    applyLocalSyncBaselineCandidate(db1, candB)
    const rows1 = dst1
      .prepare('SELECT id, sort_order FROM messages WHERE topic_id=? ORDER BY sort_order')
      .all('t-arr') as { id: string; sort_order: number }[]

    const dst2 = openInMemory()
    const db2 = drizzle(dst2, { schema })
    runMigrations(db2 as any, dst2)
    ;(chatDbService as any).sqlite = dst2
    ;(chatDbService as any).db = db2
    applyLocalSyncBaselineCandidate(db2, candB)
    applyLocalSyncBaselineCandidate(db2, candA)
    const rows2 = dst2
      .prepare('SELECT id, sort_order FROM messages WHERE topic_id=? ORDER BY sort_order')
      .all('t-arr') as { id: string; sort_order: number }[]

    expect(rows1.map((r) => r.id)).toEqual(rows2.map((r) => r.id))
    expect(rows1.map((r) => r.sort_order)).toEqual([0, 1])
  })
})

describe('tampered and rollback', () => {
  it('tampered counts/full-set/suffix with recomputed digest rejected', () => {
    insertTopic('t-tamp')
    insertMessage('m-tamp', 't-tamp')
    seedEntityClock('topic', 't-tamp', T, 'op-ttamp')
    seedEntityClock('message', 'm-tamp', T, 'op-mtamp')
    seedFull('topic', 't-tamp', T, 'op-ttamp')
    seedFull('message', 'm-tamp', T, 'op-mtamp')
    seedMembership('message', 'm-tamp', 't-tamp', T, 'op-mtamp')
    seedFrame('topicMessage', 't-tamp', ['m-tamp'], T + 10, 'op-frame-tamp')
    seedFrame('messageBlock', 'm-tamp', [], T + 10, 'op-frame-mtamp')
    seedBound()
    const c = captureLocalSyncBaselineCandidate(db)
    expect(c.completeness.state).toBe('complete')
    // Tamper frameCounts
    const tampered = JSON.parse(JSON.stringify(c)) as LocalSyncBaselineCandidate
    tampered.manifest.frameCounts.topicMessage = 999
    tampered.manifest.digest = computeLocalSyncBaselineDigest(tampered)
    const dst = openInMemory()
    const db2 = drizzle(dst, { schema })
    runMigrations(db2 as any, dst)
    ;(chatDbService as any).sqlite = dst
    ;(chatDbService as any).db = db2
    expect(() => applyLocalSyncBaselineCandidate(db2, tampered)).toThrow(SyncBaselineApplyError)

    // Tamper full-set: remove a frame
    const tampered2 = JSON.parse(JSON.stringify(c)) as LocalSyncBaselineCandidate
    tampered2.orderFrames = tampered2.orderFrames.filter((f) => f.parentId !== 't-tamp')
    tampered2.manifest.digest = computeLocalSyncBaselineDigest(tampered2)
    // Need to also adjust frameCounts to match tampered2's frames, but our tampered2 still has old frameCounts, so we adjust to recomputed but still missing frame should fail due to missing frame check (not just counts)
    // For this test, we set frameCounts correctly but still missing frame, should fail due to missing frame validation
    tampered2.manifest.frameCounts.topicMessage = tampered2.orderFrames.filter((f) => f.kind === 'topicMessage').length
    tampered2.manifest.digest = computeLocalSyncBaselineDigest(tampered2)
    expect(() => applyLocalSyncBaselineCandidate(db2, tampered2)).toThrow(SyncBaselineApplyError)
  })

  it('preflight tamper rejected without transaction (digest recomputed but structurally invalid)', () => {
    const srcSqlite2 = openInMemory()
    const srcDb2 = drizzle(srcSqlite2, { schema })
    runMigrations(srcDb2 as any, srcSqlite2)
    srcSqlite2.prepare('INSERT INTO topics (id, name) VALUES (?,?)').run('t-rollback', 'T')
    srcSqlite2
      .prepare('INSERT INTO messages (id, topic_id, role, status, sort_order) VALUES (?,?,?,?,?)')
      .run('m-rollback', 't-rollback', 'user', 'success', 0)
    srcDb2
      .insert(schema.syncEntityClock)
      .values({ entityType: 'topic', entityId: 't-rollback', timestamp: T, operationId: 'op-t-rb' })
      .run()
    srcDb2
      .insert(schema.syncEntityClock)
      .values({ entityType: 'message', entityId: 'm-rollback', timestamp: T, operationId: 'op-m-rb' })
      .run()
    for (const f of TOPIC_FIELDS)
      srcDb2
        .insert(schema.syncFieldClock)
        .values({ entityType: 'topic', entityId: 't-rollback', field: f, timestamp: T, operationId: 'op-t-rb' })
        .run()
    for (const f of MSG_FIELDS)
      srcDb2
        .insert(schema.syncFieldClock)
        .values({ entityType: 'message', entityId: 'm-rollback', field: f, timestamp: T, operationId: 'op-m-rb' })
        .run()
    srcDb2
      .insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message',
        childEntityId: 'm-rollback',
        parentId: 't-rollback',
        timestamp: T,
        operationId: 'op-m-rb'
      })
      .run()
    srcSqlite2
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('topicMessage', 't-rollback', 'parent-order-frame-v1', JSON.stringify(['m-rollback']), T + 10, 'op-frame-rb')
    srcSqlite2
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('messageBlock', 'm-rollback', 'parent-order-frame-v1', JSON.stringify([]), T + 10, 'op-frame-rb-m')
    srcSqlite2.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('cursor', '7')
    srcSqlite2.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('sync:channelKey', 'chan-1')
    const cand = captureLocalSyncBaselineCandidate(srcDb2)
    const bad = JSON.parse(JSON.stringify(cand)) as LocalSyncBaselineCandidate
    bad.orderFrames.find((f) => f.parentId === 't-rollback')!.orderedChildIds = ['different']
    bad.manifest.digest = computeLocalSyncBaselineDigest(bad)
    expect(() => applyLocalSyncBaselineCandidate(db, bad)).toThrow(SyncBaselineApplyError)
  })

  it('true transaction rollback: candidate passes pure validation but fails mid-transaction after writing earlier parent, full snapshot unchanged', () => {
    // Source candidate with two deterministic parents t-aaa < t-zzz
    const srcSqlite2 = openInMemory()
    const srcDb2 = drizzle(srcSqlite2, { schema })
    runMigrations(srcDb2 as any, srcSqlite2)
    // t-aaa with m-aaa
    srcSqlite2.prepare('INSERT INTO topics (id, name) VALUES (?,?)').run('t-aaa', 'AAA')
    srcSqlite2
      .prepare('INSERT INTO messages (id, topic_id, role, status, sort_order) VALUES (?,?,?,?,?)')
      .run('m-aaa', 't-aaa', 'user', 'success', 5)
    // t-zzz with m-zzz
    srcSqlite2.prepare('INSERT INTO topics (id, name) VALUES (?,?)').run('t-zzz', 'ZZZ')
    srcSqlite2
      .prepare('INSERT INTO messages (id, topic_id, role, status, sort_order) VALUES (?,?,?,?,?)')
      .run('m-zzz', 't-zzz', 'user', 'success', 5)
    for (const tid of ['t-aaa', 't-zzz']) {
      srcDb2
        .insert(schema.syncEntityClock)
        .values({ entityType: 'topic', entityId: tid, timestamp: T, operationId: 'op-' + tid })
        .run()
      for (const f of TOPIC_FIELDS)
        srcDb2
          .insert(schema.syncFieldClock)
          .values({ entityType: 'topic', entityId: tid, field: f, timestamp: T, operationId: 'op-' + tid })
          .run()
    }
    for (const mid of ['m-aaa', 'm-zzz']) {
      const tid = mid === 'm-aaa' ? 't-aaa' : 't-zzz'
      srcDb2
        .insert(schema.syncEntityClock)
        .values({ entityType: 'message', entityId: mid, timestamp: T, operationId: 'op-' + mid })
        .run()
      for (const f of MSG_FIELDS)
        srcDb2
          .insert(schema.syncFieldClock)
          .values({ entityType: 'message', entityId: mid, field: f, timestamp: T, operationId: 'op-' + mid })
          .run()
      srcDb2
        .insert(schema.syncMembershipClock)
        .values({
          childEntityType: 'message',
          childEntityId: mid,
          parentId: tid,
          timestamp: T,
          operationId: 'op-' + mid
        })
        .run()
    }
    srcSqlite2
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('topicMessage', 't-aaa', 'parent-order-frame-v1', JSON.stringify(['m-aaa']), T + 10, 'op-frame-aaa')
    srcSqlite2
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('topicMessage', 't-zzz', 'parent-order-frame-v1', JSON.stringify(['m-zzz']), T + 10, 'op-frame-zzz')
    srcSqlite2
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('messageBlock', 'm-aaa', 'parent-order-frame-v1', JSON.stringify([]), T + 10, 'op-frame-maaa')
    srcSqlite2
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('messageBlock', 'm-zzz', 'parent-order-frame-v1', JSON.stringify([]), T + 10, 'op-frame-mzzz')
    srcSqlite2.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('cursor', '7')
    srcSqlite2.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('sync:channelKey', 'chan-1')
    const candidate = captureLocalSyncBaselineCandidate(srcDb2)
    expect(candidate.completeness.state).toBe('complete')
    // Prepare target with existing t-zzz plus local-only child m-local (<= frameClock) that will make t-zzz incomplete during fixed-point
    // Insert t-zzz and m-local with its clocks/frame, plus outbox/applied/cursor/channel/conflict state to prove preservation
    sqlite.prepare('INSERT INTO topics (id, name) VALUES (?,?)').run('t-zzz', 'ZZZ-local')
    sqlite
      .prepare('INSERT INTO messages (id, topic_id, role, status, sort_order) VALUES (?,?,?,?,?)')
      .run('m-local', 't-zzz', 'user', 'success', 99)
    db.insert(schema.syncEntityClock)
      .values({ entityType: 'topic', entityId: 't-zzz', timestamp: T, operationId: 'op-t-zzz' })
      .run()
    db.insert(schema.syncEntityClock)
      .values({ entityType: 'message', entityId: 'm-local', timestamp: T, operationId: 'op-m-local' })
      .run()
    for (const f of TOPIC_FIELDS)
      db.insert(schema.syncFieldClock)
        .values({ entityType: 'topic', entityId: 't-zzz', field: f, timestamp: T, operationId: 'op-t-zzz' })
        .run()
    for (const f of MSG_FIELDS)
      db.insert(schema.syncFieldClock)
        .values({ entityType: 'message', entityId: 'm-local', field: f, timestamp: T, operationId: 'op-m-local' })
        .run()
    db.insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message',
        childEntityId: 'm-local',
        parentId: 't-zzz',
        timestamp: T,
        operationId: 'op-m-local'
      })
      .run()
    // Existing frame for t-zzz includes only m-local, older clock so incoming will win but then be incomplete
    sqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('topicMessage', 't-zzz', 'parent-order-frame-v1', JSON.stringify(['m-local']), T + 5, 'op-frame-local')
    sqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('messageBlock', 'm-local', 'parent-order-frame-v1', JSON.stringify([]), T + 5, 'op-frame-mlocal')
    // Additional target state to verify unchanged
    sqlite.prepare('INSERT INTO topics (id, name) VALUES (?,?)').run('t-existing', 'Existing')
    sqlite
      .prepare('INSERT INTO sync_outbox (id, entity_type, op, entity_id, timestamp, device_id) VALUES (?,?,?,?,?,?)')
      .run('op-outbox', 'topic', 'upsert', 't-existing', T, 'dev-1')
    sqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('cursor', '5')
    sqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('sync:channelKey', 'chan-old')
    sqlite.prepare('INSERT INTO sync_applied (operation_id, applied_at) VALUES (?,?)').run('op-applied', '2026-01-01')
    sqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('sync:conflict:test', 'conflict-val')
    // Snapshot full target
    const snap = () =>
      JSON.stringify({
        topics: sqlite.prepare('SELECT * FROM topics ORDER BY id').all(),
        messages: sqlite.prepare('SELECT * FROM messages ORDER BY id').all(),
        blocks: sqlite.prepare('SELECT * FROM message_blocks ORDER BY id').all(),
        membership: sqlite.prepare('SELECT * FROM sync_membership_clock ORDER BY child_entity_id').all(),
        frames: sqlite.prepare('SELECT * FROM sync_parent_order_frame ORDER BY kind, parent_id').all(),
        sortOrders: sqlite
          .prepare('SELECT id, sort_order FROM messages ORDER BY id')
          .all()
          .concat(sqlite.prepare('SELECT id, sort_order FROM message_blocks ORDER BY id').all() as any),
        entityClocks: sqlite.prepare('SELECT * FROM sync_entity_clock ORDER BY entity_type, entity_id').all(),
        fieldClocks: sqlite.prepare('SELECT * FROM sync_field_clock ORDER BY entity_type, entity_id, field').all(),
        tombstones: sqlite.prepare("SELECT * FROM sync_state WHERE key LIKE 'tombstone:%' ORDER BY key").all(),
        outbox: sqlite.prepare('SELECT * FROM sync_outbox ORDER BY id').all(),
        applied: sqlite.prepare('SELECT * FROM sync_applied ORDER BY operation_id').all(),
        state: sqlite.prepare('SELECT * FROM sync_state ORDER BY key').all()
      })
    const before = snap()
    // Apply should pass pure validation but fail mid-transaction (incomplete local-only child <= frameClock)
    expect(() => applyLocalSyncBaselineCandidate(db, candidate)).toThrow(SyncBaselineApplyError)
    const after = snap()
    expect(after).toBe(before)
    // Also ensure t-aaa not inserted (rolled back) and sortOrder for m-local unchanged
    expect(sqlite.prepare('SELECT * FROM topics WHERE id=?').get('t-aaa')).toBeUndefined()
    expect(sqlite.prepare('SELECT sort_order FROM messages WHERE id=?').get('m-local')).toEqual({ sort_order: 99 })
  })

  it('old frame-less candidate/version rejected and pre-010 DB captures partial', () => {
    // Old candidate with old inventory
    insertTopic('t-old')
    insertMessage('m-old', 't-old')
    seedEntityClock('topic', 't-old', T, 'op-told')
    seedEntityClock('message', 'm-old', T, 'op-mold')
    seedFull('topic', 't-old', T, 'op-told')
    seedFull('message', 'm-old', T, 'op-mold')
    seedMembership('message', 'm-old', 't-old', T, 'op-mold')
    seedFrame('topicMessage', 't-old', ['m-old'], T + 10, 'op-frame-old')
    seedFrame('messageBlock', 'm-old', [], T + 10, 'op-frame-old-m')
    seedBound()
    const c = captureLocalSyncBaselineCandidate(db)
    // Tamper to old inventory
    const old = JSON.parse(JSON.stringify(c)) as LocalSyncBaselineCandidate
    old.inventoryVersion = 'topic-message-stable-block-v1' as never
    old.manifest.inventoryVersion = 'topic-message-stable-block-v1' as never
    old.manifest.digest = computeLocalSyncBaselineDigest(old)
    const dst2 = openInMemory()
    const db2 = drizzle(dst2, { schema })
    runMigrations(db2 as any, dst2)
    ;(chatDbService as any).sqlite = dst2
    ;(chatDbService as any).db = db2
    expect(() => applyLocalSyncBaselineCandidate(db2, old)).toThrow(SyncBaselineApplyError)

    // Pre-010 DB: simulate by deleting frames table (or just not having frames)
    const pre010Sqlite = openInMemory()
    const pre010Db = drizzle(pre010Sqlite, { schema })
    runMigrations(pre010Db as any, pre010Sqlite)
    // Manually drop frames to simulate pre-010 (no frames)
    pre010Sqlite.prepare('DELETE FROM sync_parent_order_frame').run()
    pre010Sqlite.prepare('INSERT INTO topics (id, name) VALUES (?,?)').run('t-pre', 'Pre')
    pre010Sqlite
      .prepare('INSERT INTO messages (id, topic_id, role, status, sort_order) VALUES (?,?,?,?,?)')
      .run('m-pre', 't-pre', 'user', 'success', 0)
    pre010Db
      .insert(schema.syncEntityClock)
      .values({ entityType: 'topic', entityId: 't-pre', timestamp: T, operationId: 'op-tpre' })
      .run()
    pre010Db
      .insert(schema.syncEntityClock)
      .values({ entityType: 'message', entityId: 'm-pre', timestamp: T, operationId: 'op-mpre' })
      .run()
    for (const f of TOPIC_FIELDS)
      pre010Db
        .insert(schema.syncFieldClock)
        .values({ entityType: 'topic', entityId: 't-pre', field: f, timestamp: T, operationId: 'op-tpre' })
        .run()
    for (const f of MSG_FIELDS)
      pre010Db
        .insert(schema.syncFieldClock)
        .values({ entityType: 'message', entityId: 'm-pre', field: f, timestamp: T, operationId: 'op-mpre' })
        .run()
    pre010Db
      .insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message',
        childEntityId: 'm-pre',
        parentId: 't-pre',
        timestamp: T,
        operationId: 'op-mpre'
      })
      .run()
    pre010Sqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('cursor', '7')
    pre010Sqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('sync:channelKey', 'chan-1')
    const pre010Cand = captureLocalSyncBaselineCandidate(pre010Db)
    expect(pre010Cand.manifest.missingOrderFrameCount).toBeGreaterThan(0)
    expect(pre010Cand.completeness.state).toBe('partial')
  })
})

describe('additional adjudicated semantics', () => {
  it('wrong-kind frame parent fails closed and malformed persisted target frame fails closed', () => {
    insertTopic('t-wk')
    insertMessage('m-wk', 't-wk')
    for (const id of ['t-wk', 'm-wk']) {
      const type = id.startsWith('t-') ? 'topic' : 'message'
      seedEntityClock(type, id, T, `op-${id}`)
      seedFull(type, id, T, `op-${id}`)
    }
    seedMembership('message', 'm-wk', 't-wk', T, 'op-m-wk')
    // Wrong-kind: topicMessage frame whose parentId is a message
    seedFrame('topicMessage', 'm-wk', [], T + 10, 'op-wrong-topicMessage')
    seedFrame('messageBlock', 'm-wk', [], T + 10, 'op-wrong-block')
    seedBound()
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(SyncBaselineError)
    // Cleanup wrong-kind, make correct
    sqlite.prepare('DELETE FROM sync_parent_order_frame WHERE parent_id=?').run('m-wk')
    seedFrame('topicMessage', 't-wk', ['m-wk'], T + 10, 'op-correct')
    seedFrame('messageBlock', 'm-wk', [], T + 10, 'op-correct-m')
    const cand = captureLocalSyncBaselineCandidate(db)
    expect(cand.completeness.state).toBe('complete')
    // Now apply to target with malformed persisted frame
    const dstSqlite = openInMemory()
    const dstDb = drizzle(dstSqlite, { schema })
    runMigrations(dstDb as any, dstSqlite)
    ;(chatDbService as any).sqlite = dstSqlite
    ;(chatDbService as any).db = dstDb
    dstSqlite.prepare('INSERT INTO topics (id, name) VALUES (?,?)').run('t-wk', 'T')
    dstSqlite
      .prepare('INSERT INTO messages (id, topic_id, role, status, sort_order) VALUES (?,?,?,?,?)')
      .run('m-wk', 't-wk', 'user', 'success', 0)
    // Insert malformed persisted frame (duplicate child, bad JSON)
    dstSqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('topicMessage', 't-wk', 'parent-order-frame-v1', JSON.stringify(['m-wk', 'm-wk']), T + 5, 'op-old')
    // Seed clocks so parent is live
    dstDb
      .insert(schema.syncEntityClock)
      .values({ entityType: 'topic', entityId: 't-wk', timestamp: T, operationId: 'op-t-wk' })
      .run()
    dstDb
      .insert(schema.syncEntityClock)
      .values({ entityType: 'message', entityId: 'm-wk', timestamp: T, operationId: 'op-m-wk' })
      .run()
    for (const f of TOPIC_FIELDS)
      dstDb
        .insert(schema.syncFieldClock)
        .values({ entityType: 'topic', entityId: 't-wk', field: f, timestamp: T, operationId: 'op-t-wk' })
        .run()
    for (const f of MSG_FIELDS)
      dstDb
        .insert(schema.syncFieldClock)
        .values({ entityType: 'message', entityId: 'm-wk', field: f, timestamp: T, operationId: 'op-m-wk' })
        .run()
    dstDb
      .insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message',
        childEntityId: 'm-wk',
        parentId: 't-wk',
        timestamp: T,
        operationId: 'op-m-wk'
      })
      .run()
    expect(() => applyLocalSyncBaselineCandidate(dstDb, cand)).toThrow(SyncBaselineApplyError)
  })

  it('unversioned live child makes capture partial and apply blocks/rolls back', () => {
    // Source with unversioned child
    insertTopic('t-unv')
    insertMessage('m-unv1', 't-unv')
    insertMessage('m-unv2', 't-unv')
    for (const id of ['t-unv', 'm-unv1', 'm-unv2']) {
      const type = id.startsWith('t-') ? 'topic' : 'message'
      seedEntityClock(type, id, T, `op-${id}`)
      seedFull(type, id, T, `op-${id}`)
    }
    seedMembership('message', 'm-unv1', 't-unv', T, 'op-m-unv1')
    // m-unv2 missing membership -> unversioned
    seedFrame('topicMessage', 't-unv', ['m-unv1'], T + 10, 'op-frame-unv')
    seedFrame('messageBlock', 'm-unv1', [], T + 10, 'op-frame-unv1')
    seedFrame('messageBlock', 'm-unv2', [], T + 10, 'op-frame-unv2')
    seedBound()
    const cand = captureLocalSyncBaselineCandidate(db)
    expect(cand.manifest.unversionedMembershipCount).toBe(1)
    expect(cand.manifest.incompleteOrderFrameCount).toBe(1)
    expect(cand.completeness.state).toBe('partial')
    expect(cand.completeness.reasons).toContain('unversioned-membership')
    expect(cand.completeness.reasons).toContain('incomplete-order-frame')
    // Apply to target that has legacy unversioned child (no membership) should block
    const dstSqlite = openInMemory()
    const dstDb = drizzle(dstSqlite, { schema })
    runMigrations(dstDb as any, dstSqlite)
    ;(chatDbService as any).sqlite = dstSqlite
    ;(chatDbService as any).db = dstDb
    dstSqlite.prepare('INSERT INTO topics (id, name) VALUES (?,?)').run('t-unv', 'T')
    dstSqlite
      .prepare('INSERT INTO messages (id, topic_id, role, status, sort_order) VALUES (?,?,?,?,?)')
      .run('m-legacy', 't-unv', 'user', 'success', 0)
    dstDb
      .insert(schema.syncEntityClock)
      .values({ entityType: 'topic', entityId: 't-unv', timestamp: T, operationId: 'op-t-unv' })
      .run()
    dstDb
      .insert(schema.syncEntityClock)
      .values({ entityType: 'message', entityId: 'm-legacy', timestamp: T, operationId: 'op-m-legacy' })
      .run()
    for (const f of TOPIC_FIELDS)
      dstDb
        .insert(schema.syncFieldClock)
        .values({ entityType: 'topic', entityId: 't-unv', field: f, timestamp: T, operationId: 'op-t-unv' })
        .run()
    for (const f of MSG_FIELDS)
      dstDb
        .insert(schema.syncFieldClock)
        .values({ entityType: 'message', entityId: 'm-legacy', field: f, timestamp: T, operationId: 'op-m-legacy' })
        .run()
    // No membership for m-legacy -> legacy unversioned
    dstSqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('topicMessage', 't-unv', 'parent-order-frame-v1', JSON.stringify(['m-legacy']), T + 5, 'op-old-legacy')
    dstSqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('messageBlock', 'm-legacy', 'parent-order-frame-v1', JSON.stringify([]), T + 5, 'op-old-legacy-m')
    // Now create a complete candidate from another source (with proper membership)
    const srcSqlite = openInMemory()
    const srcDb = drizzle(srcSqlite, { schema })
    runMigrations(srcDb as any, srcSqlite)
    srcSqlite.prepare('INSERT INTO topics (id, name) VALUES (?,?)').run('t-unv', 'T')
    srcSqlite
      .prepare('INSERT INTO messages (id, topic_id, role, status, sort_order) VALUES (?,?,?,?,?)')
      .run('m-new', 't-unv', 'user', 'success', 0)
    srcDb
      .insert(schema.syncEntityClock)
      .values({ entityType: 'topic', entityId: 't-unv', timestamp: T, operationId: 'op-t-unv' })
      .run()
    srcDb
      .insert(schema.syncEntityClock)
      .values({ entityType: 'message', entityId: 'm-new', timestamp: T, operationId: 'op-m-new' })
      .run()
    for (const f of TOPIC_FIELDS)
      srcDb
        .insert(schema.syncFieldClock)
        .values({ entityType: 'topic', entityId: 't-unv', field: f, timestamp: T, operationId: 'op-t-unv' })
        .run()
    for (const f of MSG_FIELDS)
      srcDb
        .insert(schema.syncFieldClock)
        .values({ entityType: 'message', entityId: 'm-new', field: f, timestamp: T, operationId: 'op-m-new' })
        .run()
    srcDb
      .insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message',
        childEntityId: 'm-new',
        parentId: 't-unv',
        timestamp: T,
        operationId: 'op-m-new'
      })
      .run()
    srcSqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('topicMessage', 't-unv', 'parent-order-frame-v1', JSON.stringify(['m-new']), T + 10, 'op-frame-new')
    srcSqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('messageBlock', 'm-new', 'parent-order-frame-v1', JSON.stringify([]), T + 10, 'op-frame-new-m')
    srcSqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('cursor', '7')
    srcSqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('sync:channelKey', 'chan-1')
    const cand2 = captureLocalSyncBaselineCandidate(srcDb)
    expect(cand2.completeness.state).toBe('complete')
    const beforeRows = dstSqlite
      .prepare('SELECT id, sort_order FROM messages WHERE topic_id=? ORDER BY sort_order')
      .all('t-unv')
    expect(() => applyLocalSyncBaselineCandidate(dstDb, cand2)).toThrow(SyncBaselineApplyError)
    const afterRows = dstSqlite
      .prepare('SELECT id, sort_order FROM messages WHERE topic_id=? ORDER BY sort_order')
      .all('t-unv')
    expect(afterRows).toEqual(beforeRows)
  })

  it('local-only versioned child preserved via suffix and dense, and missing <= cutoff fails', () => {
    // Target has local-only child m-local with membership > frameClock, candidate has m1
    const srcSqlite = openInMemory()
    const srcDb = drizzle(srcSqlite, { schema })
    runMigrations(srcDb as any, srcSqlite)
    srcSqlite.prepare('INSERT INTO topics (id, name) VALUES (?,?)').run('t-local', 'T')
    srcSqlite
      .prepare('INSERT INTO messages (id, topic_id, role, status, sort_order) VALUES (?,?,?,?,?)')
      .run('m1', 't-local', 'user', 'success', 0)
    srcDb
      .insert(schema.syncEntityClock)
      .values({ entityType: 'topic', entityId: 't-local', timestamp: T, operationId: 'op-t' })
      .run()
    srcDb
      .insert(schema.syncEntityClock)
      .values({ entityType: 'message', entityId: 'm1', timestamp: T, operationId: 'op-m1' })
      .run()
    for (const f of TOPIC_FIELDS)
      srcDb
        .insert(schema.syncFieldClock)
        .values({ entityType: 'topic', entityId: 't-local', field: f, timestamp: T, operationId: 'op-t' })
        .run()
    for (const f of MSG_FIELDS)
      srcDb
        .insert(schema.syncFieldClock)
        .values({ entityType: 'message', entityId: 'm1', field: f, timestamp: T, operationId: 'op-m1' })
        .run()
    srcDb
      .insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message',
        childEntityId: 'm1',
        parentId: 't-local',
        timestamp: T,
        operationId: 'op-m1'
      })
      .run()
    srcSqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('topicMessage', 't-local', 'parent-order-frame-v1', JSON.stringify(['m1']), T + 10, 'op-frame-src')
    srcSqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('messageBlock', 'm1', 'parent-order-frame-v1', JSON.stringify([]), T + 10, 'op-frame-m1')
    srcSqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('cursor', '7')
    srcSqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('sync:channelKey', 'chan-1')
    const cand = captureLocalSyncBaselineCandidate(srcDb)
    const dstSqlite = openInMemory()
    const dstDb = drizzle(dstSqlite, { schema })
    runMigrations(dstDb as any, dstSqlite)
    ;(chatDbService as any).sqlite = dstSqlite
    ;(chatDbService as any).db = dstDb
    dstSqlite.prepare('INSERT INTO topics (id, name) VALUES (?,?)').run('t-local', 'T')
    dstSqlite
      .prepare('INSERT INTO messages (id, topic_id, role, status, sort_order) VALUES (?,?,?,?,?)')
      .run('m1', 't-local', 'user', 'success', 5)
    dstSqlite
      .prepare('INSERT INTO messages (id, topic_id, role, status, sort_order) VALUES (?,?,?,?,?)')
      .run('m-local', 't-local', 'user', 'success', 2)
    // m-local has membership > frameClock (T+20)
    dstDb
      .insert(schema.syncEntityClock)
      .values({ entityType: 'topic', entityId: 't-local', timestamp: T, operationId: 'op-t' })
      .run()
    dstDb
      .insert(schema.syncEntityClock)
      .values({ entityType: 'message', entityId: 'm1', timestamp: T, operationId: 'op-m1' })
      .run()
    dstDb
      .insert(schema.syncEntityClock)
      .values({ entityType: 'message', entityId: 'm-local', timestamp: T, operationId: 'op-m-local' })
      .run()
    for (const f of TOPIC_FIELDS)
      dstDb
        .insert(schema.syncFieldClock)
        .values({ entityType: 'topic', entityId: 't-local', field: f, timestamp: T, operationId: 'op-t' })
        .run()
    for (const f of MSG_FIELDS) {
      dstDb
        .insert(schema.syncFieldClock)
        .values({ entityType: 'message', entityId: 'm1', field: f, timestamp: T, operationId: 'op-m1' })
        .run()
      dstDb
        .insert(schema.syncFieldClock)
        .values({ entityType: 'message', entityId: 'm-local', field: f, timestamp: T, operationId: 'op-m-local' })
        .run()
    }
    dstDb
      .insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message',
        childEntityId: 'm1',
        parentId: 't-local',
        timestamp: T,
        operationId: 'op-m1'
      })
      .run()
    dstDb
      .insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message',
        childEntityId: 'm-local',
        parentId: 't-local',
        timestamp: T + 20,
        operationId: 'op-m-local'
      })
      .run()
    dstSqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('topicMessage', 't-local', 'parent-order-frame-v1', JSON.stringify(['m1']), T + 10, 'op-frame-dst')
    dstSqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('messageBlock', 'm1', 'parent-order-frame-v1', JSON.stringify([]), T + 10, 'op-frame-m1-dst')
    dstSqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('messageBlock', 'm-local', 'parent-order-frame-v1', JSON.stringify([]), T + 10, 'op-frame-local')
    applyLocalSyncBaselineCandidate(dstDb, cand)
    const rows = dstSqlite
      .prepare('SELECT id, sort_order FROM messages WHERE topic_id=? ORDER BY sort_order')
      .all('t-local') as { id: string; sort_order: number }[]
    expect(rows.map((r) => r.id)).toEqual(['m1', 'm-local'])
    expect(rows.map((r) => r.sort_order)).toEqual([0, 1])
    // Now test missing <= cutoff fails: add m-early with T (<= frameClock) not in winner
    const src2Sqlite = openInMemory()
    const src2Db = drizzle(src2Sqlite, { schema })
    runMigrations(src2Db as any, src2Sqlite)
    src2Sqlite.prepare('INSERT INTO topics (id, name) VALUES (?,?)').run('t-local2', 'T')
    src2Sqlite
      .prepare('INSERT INTO messages (id, topic_id, role, status, sort_order) VALUES (?,?,?,?,?)')
      .run('m-a', 't-local2', 'user', 'success', 0)
    src2Db
      .insert(schema.syncEntityClock)
      .values({ entityType: 'topic', entityId: 't-local2', timestamp: T, operationId: 'op-t2' })
      .run()
    src2Db
      .insert(schema.syncEntityClock)
      .values({ entityType: 'message', entityId: 'm-a', timestamp: T, operationId: 'op-ma' })
      .run()
    for (const f of TOPIC_FIELDS)
      src2Db
        .insert(schema.syncFieldClock)
        .values({ entityType: 'topic', entityId: 't-local2', field: f, timestamp: T, operationId: 'op-t2' })
        .run()
    for (const f of MSG_FIELDS)
      src2Db
        .insert(schema.syncFieldClock)
        .values({ entityType: 'message', entityId: 'm-a', field: f, timestamp: T, operationId: 'op-ma' })
        .run()
    src2Db
      .insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message',
        childEntityId: 'm-a',
        parentId: 't-local2',
        timestamp: T,
        operationId: 'op-ma'
      })
      .run()
    src2Sqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('topicMessage', 't-local2', 'parent-order-frame-v1', JSON.stringify(['m-a']), T + 10, 'op-frame-t2')
    src2Sqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('messageBlock', 'm-a', 'parent-order-frame-v1', JSON.stringify([]), T + 10, 'op-frame-ma')
    src2Sqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('cursor', '7')
    src2Sqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('sync:channelKey', 'chan-1')
    const cand2 = captureLocalSyncBaselineCandidate(src2Db)
    const dst2Sqlite = openInMemory()
    const dst2Db = drizzle(dst2Sqlite, { schema })
    runMigrations(dst2Db as any, dst2Sqlite)
    ;(chatDbService as any).sqlite = dst2Sqlite
    ;(chatDbService as any).db = dst2Db
    dst2Sqlite.prepare('INSERT INTO topics (id, name) VALUES (?,?)').run('t-local2', 'T')
    dst2Sqlite
      .prepare('INSERT INTO messages (id, topic_id, role, status, sort_order) VALUES (?,?,?,?,?)')
      .run('m-a', 't-local2', 'user', 'success', 0)
    dst2Sqlite
      .prepare('INSERT INTO messages (id, topic_id, role, status, sort_order) VALUES (?,?,?,?,?)')
      .run('m-early', 't-local2', 'user', 'success', 0)
    dst2Db
      .insert(schema.syncEntityClock)
      .values({ entityType: 'topic', entityId: 't-local2', timestamp: T, operationId: 'op-t2' })
      .run()
    dst2Db
      .insert(schema.syncEntityClock)
      .values({ entityType: 'message', entityId: 'm-a', timestamp: T, operationId: 'op-ma' })
      .run()
    dst2Db
      .insert(schema.syncEntityClock)
      .values({ entityType: 'message', entityId: 'm-early', timestamp: T, operationId: 'op-m-early' })
      .run()
    for (const f of TOPIC_FIELDS)
      dst2Db
        .insert(schema.syncFieldClock)
        .values({ entityType: 'topic', entityId: 't-local2', field: f, timestamp: T, operationId: 'op-t2' })
        .run()
    for (const f of MSG_FIELDS) {
      dst2Db
        .insert(schema.syncFieldClock)
        .values({ entityType: 'message', entityId: 'm-a', field: f, timestamp: T, operationId: 'op-ma' })
        .run()
      dst2Db
        .insert(schema.syncFieldClock)
        .values({ entityType: 'message', entityId: 'm-early', field: f, timestamp: T, operationId: 'op-m-early' })
        .run()
    }
    dst2Db
      .insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message',
        childEntityId: 'm-a',
        parentId: 't-local2',
        timestamp: T,
        operationId: 'op-ma'
      })
      .run()
    dst2Db
      .insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message',
        childEntityId: 'm-early',
        parentId: 't-local2',
        timestamp: T,
        operationId: 'op-m-early'
      })
      .run()
    dst2Sqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('topicMessage', 't-local2', 'parent-order-frame-v1', JSON.stringify(['m-a']), T + 10, 'op-frame-dst2')
    dst2Sqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('messageBlock', 'm-a', 'parent-order-frame-v1', JSON.stringify([]), T + 10, 'op-frame-ma-dst2')
    dst2Sqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('messageBlock', 'm-early', 'parent-order-frame-v1', JSON.stringify([]), T + 10, 'op-frame-early')
    expect(() => applyLocalSyncBaselineCandidate(dst2Db, cand2)).toThrow(SyncBaselineApplyError)
  })

  it('UTF-8 operationId frame winner and legacy null tombstone barrier', () => {
    // UTF-8 lex: operationId with multi-byte vs ascii
    const opUtf8 = 'op-\u00E9' // é in UTF-8 is 0xC3 0xA9, greater than ascii 'op-~'?
    const opAscii = 'op-a'
    // Frame winner: higher operationId lex wins when timestamp equal
    insertTopic('t-utf8')
    insertMessage('m-utf8-a', 't-utf8')
    insertMessage('m-utf8-b', 't-utf8')
    for (const id of ['t-utf8', 'm-utf8-a', 'm-utf8-b']) {
      const type = id.startsWith('t-') ? 'topic' : 'message'
      seedEntityClock(type, id, T, `op-${id}`)
      seedFull(type, id, T, `op-${id}`)
    }
    seedMembership('message', 'm-utf8-a', 't-utf8', T, opAscii)
    seedMembership('message', 'm-utf8-b', 't-utf8', T, opUtf8)
    seedFrame('topicMessage', 't-utf8', ['m-utf8-a', 'm-utf8-b'], T + 10, opAscii)
    seedFrame('messageBlock', 'm-utf8-a', [], T + 10, opAscii)
    seedFrame('messageBlock', 'm-utf8-b', [], T + 10, opAscii)
    seedBound()
    const cand = captureLocalSyncBaselineCandidate(db)
    // Apply with local frame having higher operationId should win
    const dstSqlite = openInMemory()
    const dstDb = drizzle(dstSqlite, { schema })
    runMigrations(dstDb as any, dstSqlite)
    ;(chatDbService as any).sqlite = dstSqlite
    ;(chatDbService as any).db = dstDb
    dstSqlite.prepare('INSERT INTO topics (id, name) VALUES (?,?)').run('t-utf8', 'T')
    dstSqlite
      .prepare('INSERT INTO messages (id, topic_id, role, status, sort_order) VALUES (?,?,?,?,?)')
      .run('m-utf8-a', 't-utf8', 'user', 'success', 0)
    dstSqlite
      .prepare('INSERT INTO messages (id, topic_id, role, status, sort_order) VALUES (?,?,?,?,?)')
      .run('m-utf8-b', 't-utf8', 'user', 'success', 0)
    for (const id of ['t-utf8', 'm-utf8-a', 'm-utf8-b']) {
      const type = id.startsWith('t-') ? 'topic' : 'message'
      dstDb
        .insert(schema.syncEntityClock)
        .values({ entityType: type, entityId: id, timestamp: T, operationId: `op-${id}` })
        .run()
      const fields = type === 'topic' ? TOPIC_FIELDS : MSG_FIELDS
      for (const f of fields)
        dstDb
          .insert(schema.syncFieldClock)
          .values({ entityType: type, entityId: id, field: f, timestamp: T, operationId: `op-${id}` })
          .run()
    }
    dstDb
      .insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message',
        childEntityId: 'm-utf8-a',
        parentId: 't-utf8',
        timestamp: T,
        operationId: opAscii
      })
      .run()
    dstDb
      .insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message',
        childEntityId: 'm-utf8-b',
        parentId: 't-utf8',
        timestamp: T,
        operationId: opUtf8
      })
      .run()
    // Local frame with higher operationId (opUtf8) should beat incoming opAscii at same timestamp
    dstSqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('topicMessage', 't-utf8', 'parent-order-frame-v1', JSON.stringify(['m-utf8-b', 'm-utf8-a']), T + 10, opUtf8)
    dstSqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('messageBlock', 'm-utf8-a', 'parent-order-frame-v1', JSON.stringify([]), T + 10, opUtf8)
    dstSqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('messageBlock', 'm-utf8-b', 'parent-order-frame-v1', JSON.stringify([]), T + 10, opUtf8)
    applyLocalSyncBaselineCandidate(dstDb, cand)
    // Local higher frame should win, so order should remain local [m-utf8-b, m-utf8-a]
    const rows = dstSqlite
      .prepare('SELECT id, sort_order FROM messages WHERE topic_id=? ORDER BY sort_order')
      .all('t-utf8') as { id: string; sort_order: number }[]
    expect(rows.map((r) => r.id)).toEqual(['m-utf8-b', 'm-utf8-a'])

    // Legacy null tombstone barrier: null at equal T suppresses live
    const src2Sqlite = openInMemory()
    const src2Db = drizzle(src2Sqlite, { schema })
    runMigrations(src2Db as any, src2Sqlite)
    src2Sqlite.prepare('INSERT INTO topics (id, name) VALUES (?,?)').run('t-null', 'T')
    src2Db
      .insert(schema.syncEntityClock)
      .values({ entityType: 'topic', entityId: 't-null', timestamp: T, operationId: 'op-t-null' })
      .run()
    for (const f of TOPIC_FIELDS)
      src2Db
        .insert(schema.syncFieldClock)
        .values({ entityType: 'topic', entityId: 't-null', field: f, timestamp: T, operationId: 'op-t-null' })
        .run()
    src2Sqlite
      .prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)')
      .run('tombstone:topic:t-null', `${T}:`) // malformed? Actually null tombstone is "T" without colon
    src2Sqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('tombstone:topic:t-null', `${T}`)
    src2Sqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('topicMessage', 't-null', 'parent-order-frame-v1', JSON.stringify([]), T + 10, 'op-frame-null')
    src2Sqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('cursor', '7')
    src2Sqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('sync:channelKey', 'chan-1')
    // This candidate has tombstone with null op at T; capture should be partial? Actually topic is tombstoned, no live topic, so candidate will be empty but with tombstone
    // Apply to dst with live topic at same T should be suppressed by null tombstone
    const dst2Sqlite = openInMemory()
    const dst2Db = drizzle(dst2Sqlite, { schema })
    runMigrations(dst2Db as any, dst2Sqlite)
    ;(chatDbService as any).sqlite = dst2Sqlite
    ;(chatDbService as any).db = dst2Db
    dst2Sqlite.prepare('INSERT INTO topics (id, name) VALUES (?,?)').run('t-null', 'T')
    dst2Db
      .insert(schema.syncEntityClock)
      .values({ entityType: 'topic', entityId: 't-null', timestamp: T, operationId: 'op-live-null' })
      .run()
    for (const f of TOPIC_FIELDS)
      dst2Db
        .insert(schema.syncFieldClock)
        .values({ entityType: 'topic', entityId: 't-null', field: f, timestamp: T, operationId: 'op-live-null' })
        .run()
    dst2Sqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('topicMessage', 't-null', 'parent-order-frame-v1', JSON.stringify([]), T + 10, 'op-frame-live')
    const candNull = captureLocalSyncBaselineCandidate(src2Db)
    // candNull has tombstone at T with null, dst has live at T with op-live-null, null should suppress equal-T live
    applyLocalSyncBaselineCandidate(dst2Db, candNull)
    expect(dst2Sqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-null')).toBeUndefined()
  })

  it('equal-clock stale-raw vs normalized-effective idempotence and divergence conflict', () => {
    // Stale raw contains dead id, but effective same => idempotent
    insertTopic('t-stale')
    insertMessage('m-live', 't-stale')
    seedEntityClock('topic', 't-stale', T, 'op-t-stale')
    seedEntityClock('message', 'm-live', T, 'op-m-live')
    seedFull('topic', 't-stale', T, 'op-t-stale')
    seedFull('message', 'm-live', T, 'op-m-live')
    seedMembership('message', 'm-live', 't-stale', T, 'op-m-live')
    // Raw frame contains dead id m-dead (which is tombstoned) plus m-live, but dead will be filtered, effective is [m-live]
    seedFrame('topicMessage', 't-stale', ['m-dead', 'm-live'], T + 10, 'op-frame-stale')
    seedFrame('messageBlock', 'm-live', [], T + 10, 'op-frame-live')
    // Need tombstone for m-dead to make it dead (but not live)
    sqlite
      .prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)')
      .run('tombstone:message:m-dead', `${T + 5}:op-dead`)
    sqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('messageBlock', 'm-dead', 'parent-order-frame-v1', JSON.stringify([]), T + 5, 'op-dead-frame')
    seedBound()
    const cand = captureLocalSyncBaselineCandidate(db)
    const frame = cand.orderFrames.find((f) => f.parentId === 't-stale')!
    expect(frame.orderedChildIds).toEqual(['m-live']) // normalized: dead filtered
    // Now create dst with same live but raw frame still contains dead id, same clock => effective equal, should be idempotent
    const dstSqlite = openInMemory()
    const dstDb = drizzle(dstSqlite, { schema })
    runMigrations(dstDb as any, dstSqlite)
    ;(chatDbService as any).sqlite = dstSqlite
    ;(chatDbService as any).db = dstDb
    dstSqlite.prepare('INSERT INTO topics (id, name) VALUES (?,?)').run('t-stale', 'T')
    dstSqlite
      .prepare('INSERT INTO messages (id, topic_id, role, status, sort_order) VALUES (?,?,?,?,?)')
      .run('m-live', 't-stale', 'user', 'success', 0)
    dstDb
      .insert(schema.syncEntityClock)
      .values({ entityType: 'topic', entityId: 't-stale', timestamp: T, operationId: 'op-t-stale' })
      .run()
    dstDb
      .insert(schema.syncEntityClock)
      .values({ entityType: 'message', entityId: 'm-live', timestamp: T, operationId: 'op-m-live' })
      .run()
    for (const f of TOPIC_FIELDS)
      dstDb
        .insert(schema.syncFieldClock)
        .values({ entityType: 'topic', entityId: 't-stale', field: f, timestamp: T, operationId: 'op-t-stale' })
        .run()
    for (const f of MSG_FIELDS)
      dstDb
        .insert(schema.syncFieldClock)
        .values({ entityType: 'message', entityId: 'm-live', field: f, timestamp: T, operationId: 'op-m-live' })
        .run()
    dstDb
      .insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message',
        childEntityId: 'm-live',
        parentId: 't-stale',
        timestamp: T,
        operationId: 'op-m-live'
      })
      .run()
    dstSqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run(
        'topicMessage',
        't-stale',
        'parent-order-frame-v1',
        JSON.stringify(['m-dead', 'm-live']),
        T + 10,
        'op-frame-stale'
      )
    dstSqlite
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('messageBlock', 'm-live', 'parent-order-frame-v1', JSON.stringify([]), T + 10, 'op-frame-live')
    // Add tombstone for dead so it is considered dead in dst as well
    dstSqlite
      .prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)')
      .run('tombstone:message:m-dead', `${T + 5}:op-dead`)
    expect(() => applyLocalSyncBaselineCandidate(dstDb, cand)).not.toThrow()
    // Now divergence: equal clock but effective different (swap order)
    const cand2 = JSON.parse(JSON.stringify(cand)) as typeof cand
    cand2.orderFrames.find((f) => f.parentId === 't-stale')!.orderedChildIds = ['different']
    cand2.manifest.digest = computeLocalSyncBaselineDigest(cand2)
    expect(() => applyLocalSyncBaselineCandidate(dstDb, cand2)).toThrow(SyncBaselineApplyError)
  })
})

describe('strict ID/clock validation and long ordinary ID', () => {
  it('rejects lone-surrogate entity/parent/operation IDs and over-256 operationId, accepts long ordinary ID >256', () => {
    const longId = 'a'.repeat(300)
    insertTopic('t-long')
    insertMessage('m-long', 't-long')
    insertBlock(longId, 'm-long')
    seedEntityClock('topic', 't-long', T, 'op-t-long')
    seedEntityClock('message', 'm-long', T, 'op-m-long')
    seedEntityClock('message_block', longId, T, 'op-b-long')
    seedFull('topic', 't-long', T, 'op-t-long')
    seedFull('message', 'm-long', T, 'op-m-long')
    seedFull('message_block', longId, T, 'op-b-long')
    seedMembership('message', 'm-long', 't-long', T, 'op-m-long')
    seedMembership('message_block', longId, 'm-long', T, 'op-b-long')
    seedFrame('topicMessage', 't-long', ['m-long'], T + 10, 'op-frame-long')
    seedFrame('messageBlock', 'm-long', [longId], T + 10, 'op-frame-mlong')
    seedBound()
    const cLong = captureLocalSyncBaselineCandidate(db)
    expect(cLong.completeness.state).toBe('complete')
    const dstLong = openInMemory()
    const dbLong = drizzle(dstLong, { schema })
    runMigrations(dbLong as any, dstLong)
    ;(chatDbService as any).sqlite = dstLong
    ;(chatDbService as any).db = dbLong
    expect(() => applyLocalSyncBaselineCandidate(dbLong, cLong)).not.toThrow()
    const tamperedSurrogate = JSON.parse(JSON.stringify(cLong)) as LocalSyncBaselineCandidate
    tamperedSurrogate.entities[0].entityId = '\uD800'
    tamperedSurrogate.entities[0].payload.id = '\uD800'
    tamperedSurrogate.manifest.digest = computeLocalSyncBaselineDigest(tamperedSurrogate)
    expect(() => applyLocalSyncBaselineCandidate(dbLong, tamperedSurrogate)).toThrow(SyncBaselineApplyError)
    const tamperedParent = JSON.parse(JSON.stringify(cLong)) as LocalSyncBaselineCandidate
    const msgEnt = tamperedParent.entities.find((e) => e.entityType === 'message')!
    ;(msgEnt.payload as any).topicId = '\uD800'
    if (msgEnt.parentMembershipClock) (msgEnt.parentMembershipClock as any).parentId = '\uD800'
    tamperedParent.orderFrames.find((f) => f.kind === 'topicMessage')!.parentId = '\uD800'
    tamperedParent.manifest.digest = computeLocalSyncBaselineDigest(tamperedParent)
    expect(() => applyLocalSyncBaselineCandidate(dbLong, tamperedParent)).toThrow(SyncBaselineApplyError)
    const tamperedOp = JSON.parse(JSON.stringify(cLong)) as LocalSyncBaselineCandidate
    tamperedOp.entities[0].entityClock!.operationId = '\uD800'
    tamperedOp.manifest.digest = computeLocalSyncBaselineDigest(tamperedOp)
    expect(() => applyLocalSyncBaselineCandidate(dbLong, tamperedOp)).toThrow(SyncBaselineApplyError)
    const longOp = 'b'.repeat(257)
    const tamperedLongOp = JSON.parse(JSON.stringify(cLong)) as LocalSyncBaselineCandidate
    tamperedLongOp.entities[0].entityClock!.operationId = longOp
    tamperedLongOp.manifest.digest = computeLocalSyncBaselineDigest(tamperedLongOp)
    expect(() => applyLocalSyncBaselineCandidate(dbLong, tamperedLongOp)).toThrow(SyncBaselineApplyError)
    const longChildId = 'c'.repeat(300)
    const src2 = openInMemory()
    const db2 = drizzle(src2, { schema })
    runMigrations(db2 as any, src2)
    src2.prepare('INSERT INTO topics (id, name) VALUES (?,?)').run('t-long2', 'T')
    src2
      .prepare('INSERT INTO messages (id, topic_id, role, status, sort_order) VALUES (?,?,?,?,?)')
      .run('m-long2', 't-long2', 'user', 'success', 0)
    src2
      .prepare(
        'INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)'
      )
      .run(longChildId, 'm-long2', 'main_text', 'body', 'success', '2026-01-01', '2026-01-02', 0, null)
    db2
      .insert(schema.syncEntityClock)
      .values({ entityType: 'topic', entityId: 't-long2', timestamp: T, operationId: 'op-t-long2' })
      .run()
    db2
      .insert(schema.syncEntityClock)
      .values({ entityType: 'message', entityId: 'm-long2', timestamp: T, operationId: 'op-m-long2' })
      .run()
    db2
      .insert(schema.syncEntityClock)
      .values({ entityType: 'message_block', entityId: longChildId, timestamp: T, operationId: 'op-long-child' })
      .run()
    for (const f of TOPIC_FIELDS)
      db2
        .insert(schema.syncFieldClock)
        .values({ entityType: 'topic', entityId: 't-long2', field: f, timestamp: T, operationId: 'op-t-long2' })
        .run()
    for (const f of MSG_FIELDS)
      db2
        .insert(schema.syncFieldClock)
        .values({ entityType: 'message', entityId: 'm-long2', field: f, timestamp: T, operationId: 'op-m-long2' })
        .run()
    for (const f of BLOCK_FIELDS)
      db2
        .insert(schema.syncFieldClock)
        .values({
          entityType: 'message_block',
          entityId: longChildId,
          field: f,
          timestamp: T,
          operationId: 'op-long-child'
        })
        .run()
    db2
      .insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message',
        childEntityId: 'm-long2',
        parentId: 't-long2',
        timestamp: T,
        operationId: 'op-m-long2'
      })
      .run()
    db2
      .insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message_block',
        childEntityId: longChildId,
        parentId: 'm-long2',
        timestamp: T,
        operationId: 'op-long-child'
      })
      .run()
    src2
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run('topicMessage', 't-long2', 'parent-order-frame-v1', JSON.stringify(['m-long2']), T + 10, 'op-frame-long2')
    src2
      .prepare(
        'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
      )
      .run(
        'messageBlock',
        'm-long2',
        'parent-order-frame-v1',
        JSON.stringify([longChildId]),
        T + 10,
        'op-frame-longchild'
      )
    src2.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('cursor', '7')
    src2.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('sync:channelKey', 'chan-1')
    const cLongChild = captureLocalSyncBaselineCandidate(db2)
    expect(cLongChild.completeness.state).toBe('complete')
    expect(() => applyLocalSyncBaselineCandidate(dbLong, cLongChild)).not.toThrow()
  })
})

describe('manifest/completeness internal consistency with recomputed digest', () => {
  it('tampered manifest counters/reasons with recomputed digest are rejected', () => {
    insertTopic('t-manifest')
    insertMessage('m-manifest', 't-manifest')
    seedEntityClock('topic', 't-manifest', T, 'op-t-manifest')
    seedEntityClock('message', 'm-manifest', T, 'op-m-manifest')
    seedFull('topic', 't-manifest', T, 'op-t-manifest')
    seedFull('message', 'm-manifest', T, 'op-m-manifest')
    seedMembership('message', 'm-manifest', 't-manifest', T, 'op-m-manifest')
    seedFrame('topicMessage', 't-manifest', ['m-manifest'], T + 10, 'op-frame-manifest')
    seedFrame('messageBlock', 'm-manifest', [], T + 10, 'op-frame-mmanifest')
    seedBound()
    const c = captureLocalSyncBaselineCandidate(db)
    expect(c.completeness.state).toBe('complete')
    const dst = openInMemory()
    const db2 = drizzle(dst, { schema })
    runMigrations(db2 as any, dst)
    ;(chatDbService as any).sqlite = dst
    ;(chatDbService as any).db = db2
    const tampered = JSON.parse(JSON.stringify(c)) as LocalSyncBaselineCandidate
    tampered.manifest.excludedTransientMessages = 1
    tampered.manifest.digest = computeLocalSyncBaselineDigest(tampered)
    expect(() => applyLocalSyncBaselineCandidate(db2, tampered)).toThrow(SyncBaselineApplyError)
    const tampered2 = JSON.parse(JSON.stringify(c)) as LocalSyncBaselineCandidate
    tampered2.completeness.reasons = ['transient-message-excluded']
    tampered2.manifest.completenessReasons = ['transient-message-excluded']
    tampered2.manifest.digest = computeLocalSyncBaselineDigest(tampered2)
    expect(() => applyLocalSyncBaselineCandidate(db2, tampered2)).toThrow(SyncBaselineApplyError)
    const tampered3 = JSON.parse(JSON.stringify(c)) as LocalSyncBaselineCandidate
    tampered3.manifest.aggregateIncompleteParents = 1
    tampered3.manifest.completenessReasons = ['aggregate-incomplete-child-excluded']
    tampered3.completeness.reasons = ['aggregate-incomplete-child-excluded']
    tampered3.manifest.digest = computeLocalSyncBaselineDigest(tampered3)
    expect(() => applyLocalSyncBaselineCandidate(db2, tampered3)).toThrow(SyncBaselineApplyError)
    expect(() => applyLocalSyncBaselineCandidate(db2, c)).not.toThrow()
  })
})
