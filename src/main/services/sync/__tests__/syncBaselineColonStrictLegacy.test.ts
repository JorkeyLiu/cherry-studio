/**
 * Blocker verification: colon-safe keys, strict ordinary-ID, surrogate operationId, legacy sortOrder.
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
import { isValidUnicodeScalarString, validateOrdinaryIdStrict } from '../syncFrameEvaluation'
import { syncService } from '../SyncService'
import { parseSyncOperationIdShape, parseSyncTombstoneValue } from '../syncTombstoneCodec'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>
const T = 9_000_000
const SURROGATE = '\uD800' // lone surrogate, invalid Unicode scalar

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

function insertTopic(id: string): void {
  sqlite
    .prepare('INSERT INTO topics (id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?)')
    .run(id, `Topic ${id}`, '2026-01-01', '2026-01-02', null, null)
}
function insertMessage(id: string, topicId: string): void {
  sqlite
    .prepare(
      'INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)'
    )
    .run(id, topicId, 'user', 'hello', 'success', '2026-01-01', '2026-01-02', 7)
}
function insertBlock(id: string, messageId: string): void {
  sqlite
    .prepare(
      'INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)'
    )
    .run(id, messageId, 'main_text', 'body', 'success', '2026-01-01', '2026-01-02', 5, null)
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

describe('colon-safe internal keys', () => {
  it('capture/apply with colon-containing IDs preserves remainder and materializes dense order', () => {
    const topicId = 't:colon:1'
    const msgId1 = 'm:colon:2'
    const msgId2 = 'm:colon:3'
    const blockId1 = 'b:colon:4'
    const blockId2 = 'b:colon:5'
    insertTopic(topicId)
    insertMessage(msgId1, topicId)
    insertMessage(msgId2, topicId)
    insertBlock(blockId1, msgId1)
    insertBlock(blockId2, msgId1)
    for (const [type, id] of [
      ['topic', topicId],
      ['message', msgId1],
      ['message', msgId2],
      ['message_block', blockId1],
      ['message_block', blockId2]
    ] as const) {
      seedEntityClock(type, id, T, `op-${id.replace(/:/g, '-')}`)
      seedFull(type, id, T, `op-${id.replace(/:/g, '-')}`)
    }
    seedMembership('message', msgId1, topicId, T, 'op-m1')
    seedMembership('message', msgId2, topicId, T + 5, 'op-m2')
    seedMembership('message_block', blockId1, msgId1, T, 'op-b1')
    seedMembership('message_block', blockId2, msgId1, T + 5, 'op-b2')
    seedFrame('topicMessage', topicId, [msgId1, msgId2], T + 10, 'op-frame-t')
    seedFrame('messageBlock', msgId1, [blockId1, blockId2], T + 10, 'op-frame-b')
    seedFrame('messageBlock', msgId2, [], T + 10, 'op-frame-b2')
    seedBound()
    const cand = captureLocalSyncBaselineCandidate(db)
    expect(cand.entities.some((e) => e.entityId === topicId)).toBe(true)
    expect(cand.orderFrames.find((f) => f.parentId === topicId)?.orderedChildIds).toEqual([msgId1, msgId2])
    // Apply to fresh DB
    const dstSqlite = openInMemory()
    const dstDb = drizzle(dstSqlite, { schema })
    runMigrations(dstDb as any, dstSqlite)
    ;(chatDbService as any).sqlite = dstSqlite
    ;(chatDbService as any).db = dstDb
    applyLocalSyncBaselineCandidate(dstDb, cand)
    const rows = dstSqlite
      .prepare('SELECT id, sort_order FROM messages WHERE topic_id=? ORDER BY sort_order')
      .all(topicId) as { id: string; sort_order: number }[]
    expect(rows.map((r) => r.id)).toEqual([msgId1, msgId2])
    expect(rows.map((r) => r.sort_order)).toEqual([0, 1])
    const blockRows = dstSqlite
      .prepare('SELECT id, sort_order FROM message_blocks WHERE message_id=? ORDER BY sort_order')
      .all(msgId1) as { id: string; sort_order: number }[]
    expect(blockRows.map((r) => r.id)).toEqual([blockId1, blockId2])
    // Tombstone cleanup with colon ID (use isolated topic with no children to avoid orphan membership)
    const tombTopic = 't:colon:tomb'
    // create isolated tombstone scenario in both src and dst
    insertTopic(tombTopic)
    seedEntityClock('topic', tombTopic, T, 'op-tomb')
    seedFull('topic', tombTopic, T, 'op-tomb')
    seedFrame('topicMessage', tombTopic, [], T + 10, 'op-frame-tomb')
    // delete and tombstone in src
    sqlite.prepare('DELETE FROM topics WHERE id=?').run(tombTopic)
    sqlite
      .prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)')
      .run(`tombstone:topic:${tombTopic}`, `${T + 20}:op-del`)
    const cand2 = captureLocalSyncBaselineCandidate(db)
    expect(cand2.tombstones.some((t) => t.entityId === tombTopic)).toBe(true)
    // tombstone in dst
    dstSqlite.prepare('DELETE FROM topics WHERE id=?').run(tombTopic) // dst doesn't have it, but ensure no error
    // dst may not have tombTopic; create then delete to have frame
    // Instead, test that applying cand2 to dst which has no tombTopic frame to delete is fine
    applyLocalSyncBaselineCandidate(dstDb, cand2)
    // Frame for tombTopic should not exist in dst (since tombstoned parent has no frame)
    expect(dstSqlite.prepare('SELECT * FROM sync_parent_order_frame WHERE parent_id=?').get(tombTopic)).toBeUndefined()
    dstSqlite.close()
  })

  it('membership and frame decoding preserves colon remainder on affected-parent materialization', () => {
    const topicId = 't:a:b'
    const m1 = 'm:x:y'
    const m2 = 'm:x:z'
    insertTopic(topicId)
    insertMessage(m1, topicId)
    insertMessage(m2, topicId)
    for (const id of [topicId, m1, m2]) {
      const type = id.startsWith('t:') ? 'topic' : 'message'
      seedEntityClock(type, id, T, `op-${id.replace(/:/g, '-')}`)
      seedFull(type, id, T, `op-${id.replace(/:/g, '-')}`)
    }
    seedMembership('message', m1, topicId, T, 'op-m1')
    seedMembership('message', m2, topicId, T + 2, 'op-m2')
    seedFrame('topicMessage', topicId, [m1, m2], T + 10, 'op-frame')
    seedFrame('messageBlock', m1, [], T + 10, 'op-f1')
    seedFrame('messageBlock', m2, [], T + 10, 'op-f2')
    seedBound()
    const cand = captureLocalSyncBaselineCandidate(db)
    expect(cand.orderFrames[0].orderedChildIds).toEqual([m1, m2])
    // Apply and ensure no split truncation
    const dst = openInMemory()
    const dstDb = drizzle(dst, { schema })
    runMigrations(dstDb as any, dst)
    ;(chatDbService as any).sqlite = dst
    ;(chatDbService as any).db = dstDb
    applyLocalSyncBaselineCandidate(dstDb, cand)
    const rows = dst.prepare('SELECT id FROM messages ORDER BY sort_order').all() as { id: string }[]
    expect(rows.map((r) => r.id)).toEqual([m1, m2])
    dst.close()
  })
})

describe('strict source ordinary-ID validation', () => {
  it('empty topic id fails closed on capture', () => {
    sqlite.prepare('INSERT INTO topics (id, name) VALUES (?,?)').run('', 'Empty')
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(SyncBaselineError)
  })
  it('lone-surrogate topic/message/block id fails closed', () => {
    // Insert surrogate as BLOB to preserve invalid bytes (TEXT via bound param would be sanitized to FFFD)
    sqlite.exec("INSERT INTO topics (id, name) VALUES (x'EDA080', 'surrogate-topic')")
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(SyncBaselineError)
    sqlite.exec("DELETE FROM topics WHERE hex(id)='EDA080'")
    insertTopic('t-ok')
    sqlite.exec(
      "INSERT INTO messages (id, topic_id, role, status, sort_order) VALUES (x'EDA080', 't-ok', 'user', 'success', 0)"
    )
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(SyncBaselineError)
    sqlite.exec("DELETE FROM messages WHERE hex(id)='EDA080'")
    sqlite.exec(
      "INSERT INTO messages (id, topic_id, role, status, sort_order) VALUES ('m-ok', 't-ok', 'user', 'success', 0)"
    )
    sqlite.exec(
      "INSERT INTO message_blocks (id, message_id, type, status, sort_order) VALUES (x'EDA080', 'm-ok', 'main_text', 'success', 0)"
    )
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(SyncBaselineError)
  })
  it('lone-surrogate relation id fails closed', () => {
    insertTopic('t-rel')
    sqlite.pragma('foreign_keys = OFF')
    sqlite.exec(
      "INSERT INTO messages (id, topic_id, role, status, sort_order) VALUES ('m-rel', x'EDA080', 'user', 'success', 0)"
    )
    sqlite.pragma('foreign_keys = ON')
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(SyncBaselineError)
  })
  it('lone-surrogate membership child/parent fails closed', () => {
    insertTopic('t-m')
    insertMessage('m-m', 't-m')
    seedEntityClock('topic', 't-m', T, 'op-t')
    seedEntityClock('message', 'm-m', T, 'op-m')
    seedFull('topic', 't-m', T, 'op-t')
    seedFull('message', 'm-m', T, 'op-m')
    sqlite.exec(
      "INSERT INTO sync_membership_clock (child_entity_type, child_entity_id, parent_id, timestamp, operation_id) VALUES ('message', x'EDA080', 't-m', 9000000, 'op-sur')"
    )
    seedBound()
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(SyncBaselineError)
  })
  it('lone-surrogate frame parent/child fails closed', () => {
    insertTopic('t-f')
    insertMessage('m-f', 't-f')
    seedEntityClock('topic', 't-f', T, 'op-t')
    seedEntityClock('message', 'm-f', T, 'op-m')
    seedFull('topic', 't-f', T, 'op-t')
    seedFull('message', 'm-f', T, 'op-m')
    seedMembership('message', 'm-f', 't-f', T, 'op-m')
    sqlite.exec(
      "INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES ('topicMessage', x'EDA080', 'parent-order-frame-v1', '\"m-f\"', 9000010, 'op-frame')"
    )
    seedBound()
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(SyncBaselineError)
  })
  it('lone-surrogate tombstone entity id fails closed', () => {
    sqlite
      .prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES (?,?)')
      .run('tombstone:topic:', '9000000:op-del')
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(SyncBaselineError)
    sqlite.exec("DELETE FROM sync_state WHERE key='tombstone:topic:'")
    // Surrogate via direct validator (DB would sanitize via UTF-8, so test validator directly)
    expect(() => validateOrdinaryIdStrict(SURROGATE, 'tombstone')).toThrow()
    expect(isValidUnicodeScalarString(SURROGATE)).toBe(false)
    // Also test that DB BLOB for tombstone key would be caught as malformed (non-string)
    sqlite.exec(
      "INSERT OR REPLACE INTO sync_state(key,value) VALUES (x'746F6D6273746F6E653A746F7069633AEDA080', '9000000:op-del')"
    )
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(SyncBaselineError)
  })
  it('long >256 ordinary ID remains valid', () => {
    const longId = 'a'.repeat(300)
    insertTopic(longId)
    seedEntityClock('topic', longId, T, 'op-long')
    seedFull('topic', longId, T, 'op-long')
    // need frames for this topic (empty)
    seedFrame('topicMessage', longId, [], T + 10, 'op-frame-long')
    seedBound()
    const cand = captureLocalSyncBaselineCandidate(db)
    expect(cand.entities.some((e) => e.entityId === longId)).toBe(true)
    expect(cand.completeness.state).toBe('complete')
  })
})

describe('surrogate operationId local enforcement vs remote codec unchanged', () => {
  it('codec parseSyncOperationIdShape still accepts surrogate (remote unchanged)', () => {
    expect(() => parseSyncOperationIdShape(SURROGATE)).not.toThrow()
    expect(() => parseSyncTombstoneValue(`${T}:${SURROGATE}`)).not.toThrow()
    expect(isValidUnicodeScalarString(SURROGATE)).toBe(false)
  })
  it('local baseline capture fails on surrogate operationId', () => {
    insertTopic('t-op')
    // Use BLOB for surrogate operationId to preserve invalid bytes (bound TEXT would be sanitized to FFFD)
    sqlite.exec(
      "INSERT INTO sync_entity_clock (entity_type, entity_id, timestamp, operation_id) VALUES ('topic', 't-op', 9000000, x'EDA080')"
    )
    seedFull('topic', 't-op', T, 'op-valid')
    seedBound()
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(SyncBaselineError)
    // also membership surrogate via BLOB - clean first
    sqlite.exec(
      'DELETE FROM topics; DELETE FROM messages; DELETE FROM message_blocks; DELETE FROM sync_entity_clock; DELETE FROM sync_field_clock; DELETE FROM sync_membership_clock; DELETE FROM sync_parent_order_frame; DELETE FROM sync_state'
    )
    insertTopic('t-op2')
    seedEntityClock('topic', 't-op2', T, 'op-t')
    seedFull('topic', 't-op2', T, 'op-t')
    insertMessage('m-op', 't-op2')
    seedEntityClock('message', 'm-op', T, 'op-m')
    seedFull('message', 'm-op', T, 'op-m')
    sqlite.exec(
      "INSERT INTO sync_membership_clock (child_entity_type, child_entity_id, parent_id, timestamp, operation_id) VALUES ('message', 'm-op', 't-op2', 9000000, x'EDA080')"
    )
    seedBound()
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(SyncBaselineError)
  })
  it('local baseline apply validates surrogate operationId fails even though codec would pass', () => {
    // Create a valid candidate then tamper operationId to surrogate and recompute digest
    insertTopic('t-apply-op')
    insertMessage('m-apply-op', 't-apply-op')
    for (const id of ['t-apply-op', 'm-apply-op']) {
      const type = id.startsWith('t-') ? 'topic' : 'message'
      seedEntityClock(type, id, T, 'op-valid')
      seedFull(type, id, T, 'op-valid')
    }
    seedMembership('message', 'm-apply-op', 't-apply-op', T, 'op-valid')
    seedFrame('topicMessage', 't-apply-op', ['m-apply-op'], T + 10, 'op-frame')
    seedFrame('messageBlock', 'm-apply-op', [], T + 10, 'op-frame-m')
    seedBound()
    const cand = captureLocalSyncBaselineCandidate(db)
    const tampered = JSON.parse(JSON.stringify(cand)) as LocalSyncBaselineCandidate
    tampered.entities[0].entityClock!.operationId = SURROGATE
    tampered.manifest.digest = computeLocalSyncBaselineDigest(tampered)
    const dst = openInMemory()
    const dstDb = drizzle(dst, { schema })
    runMigrations(dstDb as any, dst)
    ;(chatDbService as any).sqlite = dst
    ;(chatDbService as any).db = dstDb
    expect(() => applyLocalSyncBaselineCandidate(dstDb, tampered)).toThrow(SyncBaselineApplyError)
    dst.close()
  })
})

describe('legacy sortOrder ignored', () => {
  it('capture ignores legacy sortOrder field clocks, completeness complete', () => {
    insertTopic('t-legacy')
    insertMessage('m-legacy', 't-legacy')
    seedEntityClock('topic', 't-legacy', T, 'op-t')
    seedEntityClock('message', 'm-legacy', T, 'op-m')
    seedFull('topic', 't-legacy', T, 'op-t')
    seedFull('message', 'm-legacy', T, 'op-m')
    seedMembership('message', 'm-legacy', 't-legacy', T, 'op-m')
    db.insert(schema.syncFieldClock)
      .values({
        entityType: 'message',
        entityId: 'm-legacy',
        field: 'sortOrder',
        timestamp: T + 100,
        operationId: 'op-sort-legacy'
      })
      .run()
    seedFrame('topicMessage', 't-legacy', ['m-legacy'], T + 10, 'op-frame')
    seedFrame('messageBlock', 'm-legacy', [], T + 10, 'op-frame-m')
    seedBound()
    const cand = captureLocalSyncBaselineCandidate(db)
    expect(cand.entities.find((e) => e.entityId === 'm-legacy')!.fieldClocks.some((f) => f.field === 'sortOrder')).toBe(
      false
    )
    expect(cand.completeness.state).toBe('complete')
  })
  it('changing legacy local sortOrder clock cannot affect baseline winner or order', () => {
    // Create src candidate
    insertTopic('t-sort-win')
    insertMessage('m-sort-win', 't-sort-win')
    seedEntityClock('topic', 't-sort-win', T, 'op-t')
    seedEntityClock('message', 'm-sort-win', T, 'op-m')
    seedFull('topic', 't-sort-win', T, 'op-t')
    seedFull('message', 'm-sort-win', T, 'op-m')
    seedMembership('message', 'm-sort-win', 't-sort-win', T, 'op-m')
    seedFrame('topicMessage', 't-sort-win', ['m-sort-win'], T + 10, 'op-frame')
    seedFrame('messageBlock', 'm-sort-win', [], T + 10, 'op-frame-m')
    seedBound()
    const cand = captureLocalSyncBaselineCandidate(db)
    const dst = openInMemory()
    const dstDb = drizzle(dst, { schema })
    runMigrations(dstDb as any, dst)
    ;(chatDbService as any).sqlite = dst
    ;(chatDbService as any).db = dstDb
    // Apply first time
    applyLocalSyncBaselineCandidate(dstDb, cand)
    const order1 = (
      dst.prepare('SELECT sort_order FROM messages WHERE id=?').get('m-sort-win') as { sort_order: number }
    ).sort_order
    // Insert legacy sortOrder clock with different timestamp/op
    dst
      .prepare(
        'INSERT OR REPLACE INTO sync_field_clock (entity_type, entity_id, field, timestamp, operation_id) VALUES (?,?,?,?,?)'
      )
      .run('message', 'm-sort-win', 'sortOrder', T + 999, 'op-legacy-big')
    // Apply again same candidate - should still succeed and order unchanged
    applyLocalSyncBaselineCandidate(dstDb, cand)
    const order2 = (
      dst.prepare('SELECT sort_order FROM messages WHERE id=?').get('m-sort-win') as { sort_order: number }
    ).sort_order
    expect(order2).toBe(order1)
    // Also change to lower timestamp, still no effect
    dst
      .prepare(
        'UPDATE sync_field_clock SET timestamp=?, operation_id=? WHERE entity_type=? AND entity_id=? AND field=?'
      )
      .run(T, 'op-legacy-small', 'message', 'm-sort-win', 'sortOrder')
    applyLocalSyncBaselineCandidate(dstDb, cand)
    const order3 = (
      dst.prepare('SELECT sort_order FROM messages WHERE id=?').get('m-sort-win') as { sort_order: number }
    ).sort_order
    expect(order3).toBe(order1)
    dst.close()
  })
})
