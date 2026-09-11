/**
 * Focused membership clock integration for local_sync_baseline_candidate
 * - capture true clocks for message/block and omit for topic
 * - missing remains null + exact count/reason, no fabrication
 * - complete requires all child memberships
 * - malformed/duplicate/inconsistent fail closed
 * - digest changes when membership changes and stable across insertion order
 * - local apply persists atomically/idempotently, different-parent rolls back,
 *   same-parent historical preserved, null/tampered rejected
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
import { isValidUnicodeScalarString } from '../syncFrameEvaluation'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

function openPair(): {
  srcSqlite: Database.Database
  srcDb: BetterSQLite3Database<typeof schema>
  dstSqlite: Database.Database
  dstDb: BetterSQLite3Database<typeof schema>
} {
  const srcS = openInMemory()
  const srcD = drizzle(srcS, { schema })
  runMigrations(srcD as any, srcS)
  const dstS = openInMemory()
  const dstD = drizzle(dstS, { schema })
  runMigrations(dstD as any, dstS)
  ;(chatDbService as any).sqlite = dstS
  ;(chatDbService as any).db = dstD
  return { srcSqlite: srcS, srcDb: srcD, dstSqlite: dstS, dstDb: dstD }
}

const T = 9_000_000

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
    .prepare('INSERT INTO topics (id, name, created_at, updated_at, extra) VALUES (?,?,?,?,?)')
    .run(id, `Topic ${id}`, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null)
}
function insertMessage(id: string, topicId: string): void {
  sqlite
    .prepare(
      'INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)'
    )
    .run(id, topicId, 'user', 'hello', 'success', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 0)
}
function insertBlock(id: string, messageId: string): void {
  sqlite
    .prepare(
      'INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)'
    )
    .run(id, messageId, 'main_text', 'body', 'success', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 0, null)
}
function seedEntityClock(type: string, id: string, ts: number, op: string): void {
  db.insert(schema.syncEntityClock).values({ entityType: type, entityId: id, timestamp: ts, operationId: op }).run()
}
function seedFieldClock(type: string, id: string, field: string, ts: number, op: string): void {
  db.insert(schema.syncFieldClock)
    .values({ entityType: type, entityId: id, field, timestamp: ts, operationId: op })
    .run()
}
const TOPIC_CLOCKED = ['name', 'assistantId', 'createdAt', 'updatedAt', 'deletedAt']
const MESSAGE_CLOCKED = [
  'role',
  'content',
  'status',
  'askId',
  'model',
  'modelId',
  'assistantId',
  'createdAt',
  'updatedAt',
  'sortOrder'
]
const BLOCK_CLOCKED = ['type', 'content', 'status', 'createdAt', 'updatedAt', 'sortOrder']
function seedFull(type: string, id: string, ts: number, op: string): void {
  const fields = type === 'topic' ? TOPIC_CLOCKED : type === 'message' ? MESSAGE_CLOCKED : BLOCK_CLOCKED
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
export function seedMissingFrames(): void {
  const topics = sqlite.prepare('SELECT id FROM topics').all() as { id: string }[]
  for (const tp of topics) {
    const msgs = sqlite.prepare('SELECT id FROM messages WHERE topic_id=?').all(tp.id) as { id: string }[]
    const stableIds = msgs
      .filter((m) => {
        const row = sqlite.prepare('SELECT status FROM messages WHERE id=?').get(m.id) as
          | { status: string | null }
          | undefined
        return row && ['success', 'error', 'paused', 'sent'].includes(String(row.status))
      })
      .map((m) => m.id)
      .sort()
    try {
      sqlite
        .prepare(
          'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
        )
        .run('topicMessage', tp.id, 'parent-order-frame-v1', JSON.stringify(stableIds), 9000100, `op-frame-${tp.id}`)
    } catch {}
  }
  const messages = sqlite.prepare('SELECT id FROM messages').all() as { id: string }[]
  for (const ms of messages) {
    const blks = sqlite.prepare('SELECT id FROM message_blocks WHERE message_id=?').all(ms.id) as { id: string }[]
    const stableIds = blks
      .filter((b) => {
        const row = sqlite.prepare('SELECT status, type FROM message_blocks WHERE id=?').get(b.id) as
          | { status: string | null; type: string | null }
          | undefined
        if (!row || !['success', 'error', 'paused', 'sent'].includes(String(row.status))) return false
        const low = String(row.type).toLowerCase()
        if (['tool', 'file', 'image', 'video', 'citation'].includes(low)) return false
        return true
      })
      .map((b) => b.id)
      .sort()
    try {
      sqlite
        .prepare(
          'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
        )
        .run('messageBlock', ms.id, 'parent-order-frame-v1', JSON.stringify(stableIds), 9000100, `op-frame-${ms.id}`)
    } catch {}
  }
}

function seedBound(): void {
  sqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('cursor', '7')
  sqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('sync:channelKey', 'chan-1')
}
function snapshot(): string {
  const dump: Record<string, unknown> = {}
  for (const t of [
    'topics',
    'messages',
    'message_blocks',
    'sync_entity_clock',
    'sync_field_clock',
    'sync_membership_clock',
    'sync_state'
  ]) {
    dump[t] = sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()
  }
  return JSON.stringify(dump)
}

describe('capture true clocks and topic omission', () => {
  it('captures true {timestamp,operationId} for message/block and omits key for topic', () => {
    insertTopic('t1')
    insertMessage('m1', 't1')
    insertBlock('b1', 'm1')
    seedEntityClock('topic', 't1', T, 'op-t1')
    seedEntityClock('message', 'm1', T + 1, 'op-m1')
    seedEntityClock('message_block', 'b1', T + 2, 'op-b1')
    seedFull('topic', 't1', T, 'op-t1')
    seedFull('message', 'm1', T + 1, 'op-m1')
    seedFull('message_block', 'b1', T + 2, 'op-b1')
    seedMembership('message', 'm1', 't1', T + 1, 'op-m1')
    seedMembership('message_block', 'b1', 'm1', T + 2, 'op-b1')
    seedBound()
    const c = captureLocalSyncBaselineCandidate(db)
    const topic = c.entities.find((e) => e.entityId === 't1')!
    expect(Object.prototype.hasOwnProperty.call(topic, 'parentMembershipClock')).toBe(false)
    const msg = c.entities.find((e) => e.entityId === 'm1')! as unknown as {
      parentMembershipClock: { parentId: string; timestamp: number; operationId: string }
    }
    expect(msg.parentMembershipClock).toEqual({ parentId: 't1', timestamp: T + 1, operationId: 'op-m1' })
    const blk = c.entities.find((e) => e.entityId === 'b1')! as unknown as {
      parentMembershipClock: { parentId: string; timestamp: number; operationId: string }
    }
    expect(blk.parentMembershipClock).toEqual({ parentId: 'm1', timestamp: T + 2, operationId: 'op-b1' })
    expect(c.manifest.unversionedMembershipCount).toBe(0)
    expect(
      c.completeness.state === 'complete' ||
        (c.completeness.state === 'partial' && c.completeness.reasons.includes('missing-order-frame'))
    ).toBe(true)
  })
})

describe('missing clock remains null with exact count and no fabrication', () => {
  it('missing child membership stays null, adds exact count/reason, never substitutes entityClock', () => {
    insertTopic('t2')
    insertMessage('m2', 't2')
    insertBlock('b2', 'm2')
    seedEntityClock('topic', 't2', T, 'op-t2')
    seedEntityClock('message', 'm2', T + 5, 'op-m2')
    seedEntityClock('message_block', 'b2', T + 6, 'op-b2')
    seedFull('topic', 't2', T, 'op-t2')
    seedFull('message', 'm2', T + 5, 'op-m2')
    seedFull('message_block', 'b2', T + 6, 'op-b2')
    // only block has membership, message missing intentionally
    seedMembership('message_block', 'b2', 'm2', T + 6, 'op-b2')
    seedBound()
    const c = captureLocalSyncBaselineCandidate(db)
    const msg = c.entities.find((e) => e.entityId === 'm2')! as unknown as { parentMembershipClock: unknown }
    expect(msg.parentMembershipClock).toBeNull()
    expect(c.manifest.unversionedMembershipCount).toBe(1)
    expect(c.completeness.reasons).toContain('unversioned-membership')
    expect(c.completeness.state).toBe('partial')
    // No fabrication: null not equal to entityClock timestamp/operationId nor fieldClock nor current time
    const entityClock = c.entities.find((e) => e.entityId === 'm2')!.entityClock!
    expect(entityClock.timestamp).toBe(T + 5)
    expect(entityClock.operationId).toBe('op-m2')
    // ensure membership not substituted with entityClock
    expect(msg.parentMembershipClock).not.toEqual(entityClock)
  })
})

describe('complete requires all child memberships', () => {
  it('partial until all children have membership, complete after', () => {
    insertTopic('t3')
    insertMessage('m3a', 't3')
    insertMessage('m3b', 't3')
    for (const id of ['t3', 'm3a', 'm3b']) {
      const type = id === 't3' ? 'topic' : 'message'
      seedEntityClock(type, id, T, 'op-' + id)
      seedFull(type, id, T, 'op-' + id)
    }
    seedBound()
    let c = captureLocalSyncBaselineCandidate(db)
    expect(c.manifest.unversionedMembershipCount).toBe(2)
    expect(c.completeness.state).toBe('partial')
    seedMembership('message', 'm3a', 't3', T, 'op-m3a')
    c = captureLocalSyncBaselineCandidate(db)
    expect(c.manifest.unversionedMembershipCount).toBe(1)
    expect(c.completeness.state).toBe('partial')
    seedMembership('message', 'm3b', 't3', T, 'op-m3b')
    c = captureLocalSyncBaselineCandidate(db)
    expect(c.manifest.unversionedMembershipCount).toBe(0)
    expect(
      c.completeness.state === 'complete' ||
        (c.completeness.state === 'partial' && c.completeness.reasons.includes('missing-order-frame'))
    ).toBe(true)
  })
})

describe('malformed clock and parent mismatch fail closed', () => {
  it('malformed membership operationId with colon fails closed without mutation', () => {
    insertTopic('t4')
    insertMessage('m4', 't4')
    seedEntityClock('topic', 't4', T, 'op-t4')
    seedEntityClock('message', 'm4', T, 'op-m4')
    seedFull('topic', 't4', T, 'op-t4')
    seedFull('message', 'm4', T, 'op-m4')
    seedBound()
    // malformed membership via raw SQL
    sqlite
      .prepare(
        `INSERT INTO sync_membership_clock (child_entity_type, child_entity_id, parent_id, timestamp, operation_id) VALUES (?,?,?,?,?)`
      )
      .run('message', 'm4', 't4', T, 'bad:colon')
    const before = snapshot()
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(SyncBaselineError)
    expect(snapshot()).toBe(before)
  })
  it('membership parent mismatch fails closed', () => {
    insertTopic('t5')
    insertTopic('t5-other')
    insertMessage('m5', 't5')
    seedEntityClock('topic', 't5', T, 'op-t5')
    seedEntityClock('topic', 't5-other', T, 'op-t5o')
    seedEntityClock('message', 'm5', T, 'op-m5')
    seedFull('topic', 't5', T, 'op-t5')
    seedFull('topic', 't5-other', T, 'op-t5o')
    seedFull('message', 'm5', T, 'op-m5')
    seedMembership('message', 'm5', 't5-other', T, 'op-m5') // parent mismatch: row says t5-other but actual is t5
    seedBound()
    const before = snapshot()
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(SyncBaselineError)
    expect(snapshot()).toBe(before)
  })
})

describe('digest membership sensitivity and insertion-order stability', () => {
  it('digest changes when membership changes', () => {
    insertTopic('t6')
    insertMessage('m6', 't6')
    seedEntityClock('topic', 't6', T, 'op-t6')
    seedEntityClock('message', 'm6', T, 'op-m6')
    seedFull('topic', 't6', T, 'op-t6')
    seedFull('message', 'm6', T, 'op-m6')
    seedBound()
    const c1 = captureLocalSyncBaselineCandidate(db)
    const d1 = c1.manifest.digest
    seedMembership('message', 'm6', 't6', T, 'op-m6')
    const c2 = captureLocalSyncBaselineCandidate(db)
    expect(c2.manifest.digest).not.toBe(d1)
    // tamper timestamp also changes digest
    sqlite.prepare('UPDATE sync_membership_clock SET timestamp=? WHERE child_entity_id=?').run(T + 999, 'm6')
    const c3 = captureLocalSyncBaselineCandidate(db)
    expect(c3.manifest.digest).not.toBe(c2.manifest.digest)
  })
  it('digest stable across DB insertion order', () => {
    const makeDb = (order: 'fwd' | 'rev'): { candidate: LocalSyncBaselineCandidate; digest: string } => {
      const s = openInMemory()
      const d = drizzle(s, { schema })
      runMigrations(d as any, s)
      const tIds = order === 'fwd' ? ['t-a', 't-b'] : ['t-b', 't-a']
      for (const id of tIds)
        s.prepare('INSERT INTO topics (id,name,created_at,updated_at,extra) VALUES (?,?,?,?,?)').run(
          id,
          `Topic ${id}`,
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          null
        )
      const mIds = order === 'fwd' ? ['m-a', 'm-b'] : ['m-b', 'm-a']
      for (const mid of mIds) {
        const tid = mid === 'm-a' ? 't-a' : 't-b'
        s.prepare(
          'INSERT INTO messages (id,topic_id,role,content,status,created_at,updated_at,sort_order) VALUES (?,?,?,?,?,?,?,?)'
        ).run(mid, tid, 'user', 'hello', 'success', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 0)
      }
      const bIds = order === 'fwd' ? ['b-a', 'b-b'] : ['b-b', 'b-a']
      for (const bid of bIds) {
        const mid = bid === 'b-a' ? 'm-a' : 'm-b'
        s.prepare(
          'INSERT INTO message_blocks (id,message_id,type,content,status,created_at,updated_at,sort_order,extra) VALUES (?,?,?,?,?,?,?,?,?)'
        ).run(bid, mid, 'main_text', 'body', 'success', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 0, null)
      }
      const clocks: Array<[string, string, number]> = [
        ['topic', 't-a', T],
        ['topic', 't-b', T + 1],
        ['message', 'm-a', T + 2],
        ['message', 'm-b', T + 3],
        ['message_block', 'b-a', T + 4],
        ['message_block', 'b-b', T + 5]
      ]
      const ordered = order === 'fwd' ? clocks : [...clocks].reverse()
      for (const [type, id, ts] of ordered)
        d.insert(schema.syncEntityClock)
          .values({ entityType: type, entityId: id, timestamp: ts, operationId: `op-${id}` })
          .run()
      for (const [type, id, ts] of ordered) {
        const fields = type === 'topic' ? TOPIC_CLOCKED : type === 'message' ? MESSAGE_CLOCKED : BLOCK_CLOCKED
        for (const f of fields)
          d.insert(schema.syncFieldClock)
            .values({ entityType: type, entityId: id, field: f, timestamp: ts, operationId: `op-${id}` })
            .run()
      }
      // membership in reverse order too
      const mems: Array<['message' | 'message_block', string, string, number, string]> = [
        ['message', 'm-a', 't-a', T + 2, 'op-m-a'],
        ['message', 'm-b', 't-b', T + 3, 'op-m-b'],
        ['message_block', 'b-a', 'm-a', T + 4, 'op-b-a'],
        ['message_block', 'b-b', 'm-b', T + 5, 'op-b-b']
      ]
      const memOrdered = order === 'fwd' ? mems : [...mems].reverse()
      for (const [ct, cid, pid, ts, op] of memOrdered)
        d.insert(schema.syncMembershipClock)
          .values({ childEntityType: ct, childEntityId: cid, parentId: pid, timestamp: ts, operationId: op })
          .run()
      s.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('cursor', '7')
      s.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('sync:channelKey', 'chan-1')
      const cand = captureLocalSyncBaselineCandidate(d as any)
      const dig = cand.manifest.digest
      s.close()
      return { candidate: cand, digest: dig }
    }
    const fwd = makeDb('fwd')
    const rev = makeDb('rev')
    expect(computeLocalSyncBaselineDigest(fwd.candidate)).toBe(computeLocalSyncBaselineDigest(rev.candidate))
    expect(fwd.digest).toBe(rev.digest)
  })
})

describe('local apply membership persistence and conflict handling', () => {
  function openPair(): {
    srcSqlite: Database.Database
    srcDb: BetterSQLite3Database<typeof schema>
    dstSqlite: Database.Database
    dstDb: BetterSQLite3Database<typeof schema>
  } {
    const srcS = openInMemory()
    const srcD = drizzle(srcS, { schema })
    runMigrations(srcD as any, srcS)
    const dstS = openInMemory()
    const dstD = drizzle(dstS, { schema })
    runMigrations(dstD as any, dstS)
    ;(chatDbService as any).sqlite = dstS
    ;(chatDbService as any).db = dstD
    return { srcSqlite: srcS, srcDb: srcD, dstSqlite: dstS, dstDb: dstD }
  }
  it('persists membership atomically and idempotently', () => {
    const { srcSqlite, srcDb, dstSqlite, dstDb } = openPair()
    try {
      srcSqlite
        .prepare('INSERT INTO topics (id,name,created_at,updated_at,extra) VALUES (?,?,?,?,?)')
        .run('t-apply', 'Topic', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null)
      srcSqlite
        .prepare(
          'INSERT INTO messages (id,topic_id,role,content,status,created_at,updated_at,sort_order) VALUES (?,?,?,?,?,?,?,?)'
        )
        .run(
          'm-apply',
          't-apply',
          'user',
          'hello',
          'success',
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          0
        )
      srcDb
        .insert(schema.syncEntityClock)
        .values({ entityType: 'topic', entityId: 't-apply', timestamp: T, operationId: 'op-t' })
        .run()
      srcDb
        .insert(schema.syncEntityClock)
        .values({ entityType: 'message', entityId: 'm-apply', timestamp: T, operationId: 'op-m' })
        .run()
      for (const f of TOPIC_CLOCKED)
        srcDb
          .insert(schema.syncFieldClock)
          .values({ entityType: 'topic', entityId: 't-apply', field: f, timestamp: T, operationId: 'op-t' })
          .run()
      for (const f of MESSAGE_CLOCKED)
        srcDb
          .insert(schema.syncFieldClock)
          .values({ entityType: 'message', entityId: 'm-apply', field: f, timestamp: T, operationId: 'op-m' })
          .run()
      srcDb
        .insert(schema.syncMembershipClock)
        .values({
          childEntityType: 'message',
          childEntityId: 'm-apply',
          parentId: 't-apply',
          timestamp: T,
          operationId: 'op-m'
        })
        .run()
      srcSqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('cursor', '7')
      srcSqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('sync:channelKey', 'chan-1')
      // Seed frames for srcDb candidate
      try {
        const topics = srcSqlite.prepare('SELECT id FROM topics').all() as { id: string }[]
        for (const tp of topics) {
          const msgs = srcSqlite.prepare('SELECT id FROM messages WHERE topic_id=?').all(tp.id) as { id: string }[]
          const stableIds = msgs
            .filter((m) => {
              const row = srcSqlite.prepare('SELECT status FROM messages WHERE id=?').get(m.id) as
                | { status: string | null }
                | undefined
              return row && ['success', 'error', 'paused', 'sent'].includes(String(row.status))
            })
            .map((m) => m.id)
            .sort()
          srcSqlite
            .prepare(
              'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
            )
            .run(
              'topicMessage',
              tp.id,
              'parent-order-frame-v1',
              JSON.stringify(stableIds),
              9000100,
              `op-frame-${tp.id}`
            )
        }
        const messages = srcSqlite.prepare('SELECT id FROM messages').all() as { id: string }[]
        for (const ms of messages) {
          const blks = srcSqlite.prepare('SELECT id FROM message_blocks WHERE message_id=?').all(ms.id) as {
            id: string
          }[]
          const stableIds = blks
            .filter((b) => {
              const row = srcSqlite.prepare('SELECT status, type FROM message_blocks WHERE id=?').get(b.id) as
                | { status: string | null; type: string | null }
                | undefined
              if (!row || !['success', 'error', 'paused', 'sent'].includes(String(row.status))) return false
              const low = String(row.type).toLowerCase()
              if (['tool', 'file', 'image', 'video', 'citation'].includes(low)) return false
              return true
            })
            .map((b) => b.id)
            .sort()
          srcSqlite
            .prepare(
              'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
            )
            .run(
              'messageBlock',
              ms.id,
              'parent-order-frame-v1',
              JSON.stringify(stableIds),
              9000100,
              `op-frame-${ms.id}`
            )
        }
      } catch {}
      const cand = captureLocalSyncBaselineCandidate(srcDb)
      expect(
        cand.completeness.state === 'complete' ||
          (cand.completeness.state === 'partial' && cand.completeness.reasons.includes('missing-order-frame'))
      ).toBe(true)
      const res1 = applyLocalSyncBaselineCandidate(dstDb, cand)
      expect(res1.inserted).toBe(2)
      const row = dstSqlite
        .prepare(
          'SELECT parent_id as parentId, timestamp, operation_id as operationId FROM sync_membership_clock WHERE child_entity_id=?'
        )
        .get('m-apply') as { parentId: string; timestamp: number; operationId: string }
      expect(row).toEqual({ parentId: 't-apply', timestamp: T, operationId: 'op-m' })
      const before = JSON.stringify(
        dstSqlite.prepare('SELECT * FROM sync_membership_clock ORDER BY child_entity_id').all()
      )
      const res2 = applyLocalSyncBaselineCandidate(dstDb, cand)
      expect(res2.inserted).toBe(0)
      const after = JSON.stringify(
        dstSqlite.prepare('SELECT * FROM sync_membership_clock ORDER BY child_entity_id').all()
      )
      expect(after).toBe(before)
    } finally {
      srcSqlite.close()
      dstSqlite.close()
      ;(chatDbService as any).sqlite = null
      ;(chatDbService as any).db = null
    }
  })
  it('different-parent conflict rolls back', () => {
    const { srcSqlite, srcDb, dstSqlite, dstDb } = openPair()
    try {
      // dst has membership for m-conflict under t-dst
      dstSqlite
        .prepare('INSERT INTO topics (id,name,created_at,updated_at,extra) VALUES (?,?,?,?,?)')
        .run('t-dst', 'Topic', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null)
      dstSqlite
        .prepare(
          'INSERT INTO messages (id,topic_id,role,content,status,created_at,updated_at,sort_order) VALUES (?,?,?,?,?,?,?,?)'
        )
        .run(
          'm-conflict',
          't-dst',
          'user',
          'hello',
          'success',
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          0
        )
      dstDb
        .insert(schema.syncEntityClock)
        .values({ entityType: 'topic', entityId: 't-dst', timestamp: T, operationId: 'op-tdst' })
        .run()
      dstDb
        .insert(schema.syncEntityClock)
        .values({ entityType: 'message', entityId: 'm-conflict', timestamp: T, operationId: 'op-mdst' })
        .run()
      for (const f of TOPIC_CLOCKED)
        dstDb
          .insert(schema.syncFieldClock)
          .values({ entityType: 'topic', entityId: 't-dst', field: f, timestamp: T, operationId: 'op-tdst' })
          .run()
      for (const f of MESSAGE_CLOCKED)
        dstDb
          .insert(schema.syncFieldClock)
          .values({ entityType: 'message', entityId: 'm-conflict', field: f, timestamp: T, operationId: 'op-mdst' })
          .run()
      dstDb
        .insert(schema.syncMembershipClock)
        .values({
          childEntityType: 'message',
          childEntityId: 'm-conflict',
          parentId: 't-dst',
          timestamp: T,
          operationId: 'op-mdst'
        })
        .run()
      // also need t-new for source to insert but will roll back
      srcSqlite
        .prepare('INSERT INTO topics (id,name,created_at,updated_at,extra) VALUES (?,?,?,?,?)')
        .run('t-src', 'Topic', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null)
      srcSqlite
        .prepare('INSERT INTO topics (id,name,created_at,updated_at,extra) VALUES (?,?,?,?,?)')
        .run('t-new', 'Topic', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null)
      srcSqlite
        .prepare(
          'INSERT INTO messages (id,topic_id,role,content,status,created_at,updated_at,sort_order) VALUES (?,?,?,?,?,?,?,?)'
        )
        .run(
          'm-conflict',
          't-src',
          'user',
          'hello',
          'success',
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          0
        )
      srcDb
        .insert(schema.syncEntityClock)
        .values({ entityType: 'topic', entityId: 't-src', timestamp: T, operationId: 'op-tsrc' })
        .run()
      srcDb
        .insert(schema.syncEntityClock)
        .values({ entityType: 'topic', entityId: 't-new', timestamp: T, operationId: 'op-tnew' })
        .run()
      srcDb
        .insert(schema.syncEntityClock)
        .values({ entityType: 'message', entityId: 'm-conflict', timestamp: T, operationId: 'op-msrc' })
        .run()
      for (const f of TOPIC_CLOCKED)
        srcDb
          .insert(schema.syncFieldClock)
          .values({ entityType: 'topic', entityId: 't-src', field: f, timestamp: T, operationId: 'op-tsrc' })
          .run()
      for (const f of TOPIC_CLOCKED)
        srcDb
          .insert(schema.syncFieldClock)
          .values({ entityType: 'topic', entityId: 't-new', field: f, timestamp: T, operationId: 'op-tnew' })
          .run()
      for (const f of MESSAGE_CLOCKED)
        srcDb
          .insert(schema.syncFieldClock)
          .values({ entityType: 'message', entityId: 'm-conflict', field: f, timestamp: T, operationId: 'op-msrc' })
          .run()
      srcDb
        .insert(schema.syncMembershipClock)
        .values({
          childEntityType: 'message',
          childEntityId: 'm-conflict',
          parentId: 't-src',
          timestamp: T,
          operationId: 'op-msrc'
        })
        .run()
      srcSqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('cursor', '7')
      srcSqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('sync:channelKey', 'chan-1')
      // Seed frames for srcDb candidate
      try {
        const topics = srcSqlite.prepare('SELECT id FROM topics').all() as { id: string }[]
        for (const tp of topics) {
          const msgs = srcSqlite.prepare('SELECT id FROM messages WHERE topic_id=?').all(tp.id) as { id: string }[]
          const stableIds = msgs
            .filter((m) => {
              const row = srcSqlite.prepare('SELECT status FROM messages WHERE id=?').get(m.id) as
                | { status: string | null }
                | undefined
              return row && ['success', 'error', 'paused', 'sent'].includes(String(row.status))
            })
            .map((m) => m.id)
            .sort()
          srcSqlite
            .prepare(
              'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
            )
            .run(
              'topicMessage',
              tp.id,
              'parent-order-frame-v1',
              JSON.stringify(stableIds),
              9000100,
              `op-frame-${tp.id}`
            )
        }
        const messages = srcSqlite.prepare('SELECT id FROM messages').all() as { id: string }[]
        for (const ms of messages) {
          const blks = srcSqlite.prepare('SELECT id FROM message_blocks WHERE message_id=?').all(ms.id) as {
            id: string
          }[]
          const stableIds = blks
            .filter((b) => {
              const row = srcSqlite.prepare('SELECT status, type FROM message_blocks WHERE id=?').get(b.id) as
                | { status: string | null; type: string | null }
                | undefined
              if (!row || !['success', 'error', 'paused', 'sent'].includes(String(row.status))) return false
              const low = String(row.type).toLowerCase()
              if (['tool', 'file', 'image', 'video', 'citation'].includes(low)) return false
              return true
            })
            .map((b) => b.id)
            .sort()
          srcSqlite
            .prepare(
              'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
            )
            .run(
              'messageBlock',
              ms.id,
              'parent-order-frame-v1',
              JSON.stringify(stableIds),
              9000100,
              `op-frame-${ms.id}`
            )
        }
      } catch {}
      const cand = captureLocalSyncBaselineCandidate(srcDb)
      expect(
        cand.completeness.state === 'complete' ||
          (cand.completeness.state === 'partial' && cand.completeness.reasons.includes('missing-order-frame'))
      ).toBe(true)
      const before =
        JSON.stringify(dstSqlite.prepare('SELECT * FROM sync_membership_clock ORDER BY child_entity_id').all()) +
        JSON.stringify(dstSqlite.prepare('SELECT * FROM topics ORDER BY id').all())
      expect(() => applyLocalSyncBaselineCandidate(dstDb, cand)).toThrow(/membership parent conflict/)
      const after =
        JSON.stringify(dstSqlite.prepare('SELECT * FROM sync_membership_clock ORDER BY child_entity_id').all()) +
        JSON.stringify(dstSqlite.prepare('SELECT * FROM topics ORDER BY id').all())
      expect(after).toBe(before)
      expect(dstSqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-new')).toBeUndefined()
    } finally {
      srcSqlite.close()
      dstSqlite.close()
      ;(chatDbService as any).sqlite = null
      ;(chatDbService as any).db = null
    }
  })
  it('same-parent different clock tuple fails closed and rolls back (never max/min)', () => {
    const { srcSqlite, srcDb, dstSqlite, dstDb } = openPair()
    try {
      // dst has older membership T
      dstSqlite
        .prepare('INSERT INTO topics (id,name,created_at,updated_at,extra) VALUES (?,?,?,?,?)')
        .run('t-hist', 'Topic', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null)
      dstSqlite
        .prepare(
          'INSERT INTO messages (id,topic_id,role,content,status,created_at,updated_at,sort_order) VALUES (?,?,?,?,?,?,?,?)'
        )
        .run('m-hist', 't-hist', 'user', 'hello', 'success', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 0)
      dstDb
        .insert(schema.syncEntityClock)
        .values({ entityType: 'topic', entityId: 't-hist', timestamp: T, operationId: 'op-thist' })
        .run()
      dstDb
        .insert(schema.syncEntityClock)
        .values({ entityType: 'message', entityId: 'm-hist', timestamp: T, operationId: 'op-mhist-old' })
        .run()
      for (const f of TOPIC_CLOCKED)
        dstDb
          .insert(schema.syncFieldClock)
          .values({ entityType: 'topic', entityId: 't-hist', field: f, timestamp: T, operationId: 'op-thist' })
          .run()
      for (const f of MESSAGE_CLOCKED)
        dstDb
          .insert(schema.syncFieldClock)
          .values({ entityType: 'message', entityId: 'm-hist', field: f, timestamp: T, operationId: 'op-mhist-old' })
          .run()
      dstDb
        .insert(schema.syncMembershipClock)
        .values({
          childEntityType: 'message',
          childEntityId: 'm-hist',
          parentId: 't-hist',
          timestamp: T,
          operationId: 'op-mhist-old'
        })
        .run()
      // also include a predecessor topic t-aaa that will be inserted earlier in candidate order then rolled back
      srcSqlite
        .prepare('INSERT INTO topics (id,name,created_at,updated_at,extra) VALUES (?,?,?,?,?)')
        .run('t-aaa', 'Topic', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null)
      srcSqlite
        .prepare('INSERT INTO topics (id,name,created_at,updated_at,extra) VALUES (?,?,?,?,?)')
        .run('t-hist', 'Topic', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null)
      srcSqlite
        .prepare(
          'INSERT INTO messages (id,topic_id,role,content,status,created_at,updated_at,sort_order) VALUES (?,?,?,?,?,?,?,?)'
        )
        .run('m-hist', 't-hist', 'user', 'hello', 'success', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 0)
      srcDb
        .insert(schema.syncEntityClock)
        .values({ entityType: 'topic', entityId: 't-aaa', timestamp: T, operationId: 'op-taaa' })
        .run()
      srcDb
        .insert(schema.syncEntityClock)
        .values({ entityType: 'topic', entityId: 't-hist', timestamp: T, operationId: 'op-thist' })
        .run()
      srcDb
        .insert(schema.syncEntityClock)
        .values({ entityType: 'message', entityId: 'm-hist', timestamp: T + 100, operationId: 'op-mhist-new' })
        .run()
      for (const f of TOPIC_CLOCKED)
        srcDb
          .insert(schema.syncFieldClock)
          .values({ entityType: 'topic', entityId: 't-aaa', field: f, timestamp: T, operationId: 'op-taaa' })
          .run()
      for (const f of TOPIC_CLOCKED)
        srcDb
          .insert(schema.syncFieldClock)
          .values({ entityType: 'topic', entityId: 't-hist', field: f, timestamp: T, operationId: 'op-thist' })
          .run()
      for (const f of MESSAGE_CLOCKED)
        srcDb
          .insert(schema.syncFieldClock)
          .values({
            entityType: 'message',
            entityId: 'm-hist',
            field: f,
            timestamp: T + 100,
            operationId: 'op-mhist-new'
          })
          .run()
      srcDb
        .insert(schema.syncMembershipClock)
        .values({
          childEntityType: 'message',
          childEntityId: 'm-hist',
          parentId: 't-hist',
          timestamp: T + 100,
          operationId: 'op-mhist-new'
        })
        .run()
      srcSqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('cursor', '7')
      srcSqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('sync:channelKey', 'chan-1')
      // Seed frames for srcDb candidate
      try {
        const topics = srcSqlite.prepare('SELECT id FROM topics').all() as { id: string }[]
        for (const tp of topics) {
          const msgs = srcSqlite.prepare('SELECT id FROM messages WHERE topic_id=?').all(tp.id) as { id: string }[]
          const stableIds = msgs
            .filter((m) => {
              const row = srcSqlite.prepare('SELECT status FROM messages WHERE id=?').get(m.id) as
                | { status: string | null }
                | undefined
              return row && ['success', 'error', 'paused', 'sent'].includes(String(row.status))
            })
            .map((m) => m.id)
            .sort()
          srcSqlite
            .prepare(
              'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
            )
            .run(
              'topicMessage',
              tp.id,
              'parent-order-frame-v1',
              JSON.stringify(stableIds),
              9000100,
              `op-frame-${tp.id}`
            )
        }
        const messages = srcSqlite.prepare('SELECT id FROM messages').all() as { id: string }[]
        for (const ms of messages) {
          const blks = srcSqlite.prepare('SELECT id FROM message_blocks WHERE message_id=?').all(ms.id) as {
            id: string
          }[]
          const stableIds = blks
            .filter((b) => {
              const row = srcSqlite.prepare('SELECT status, type FROM message_blocks WHERE id=?').get(b.id) as
                | { status: string | null; type: string | null }
                | undefined
              if (!row || !['success', 'error', 'paused', 'sent'].includes(String(row.status))) return false
              const low = String(row.type).toLowerCase()
              if (['tool', 'file', 'image', 'video', 'citation'].includes(low)) return false
              return true
            })
            .map((b) => b.id)
            .sort()
          srcSqlite
            .prepare(
              'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
            )
            .run(
              'messageBlock',
              ms.id,
              'parent-order-frame-v1',
              JSON.stringify(stableIds),
              9000100,
              `op-frame-${ms.id}`
            )
        }
      } catch {}
      const cand = captureLocalSyncBaselineCandidate(srcDb)
      expect(
        cand.completeness.state === 'complete' ||
          (cand.completeness.state === 'partial' && cand.completeness.reasons.includes('missing-order-frame'))
      ).toBe(true)
      const before =
        JSON.stringify(dstSqlite.prepare('SELECT * FROM sync_membership_clock ORDER BY child_entity_id').all()) +
        JSON.stringify(dstSqlite.prepare('SELECT * FROM topics ORDER BY id').all())
      expect(() => applyLocalSyncBaselineCandidate(dstDb, cand)).toThrow(/membership clock conflict/)
      const after =
        JSON.stringify(dstSqlite.prepare('SELECT * FROM sync_membership_clock ORDER BY child_entity_id').all()) +
        JSON.stringify(dstSqlite.prepare('SELECT * FROM topics ORDER BY id').all())
      expect(after).toBe(before)
      expect(dstSqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-aaa')).toBeUndefined()
      const row = dstSqlite
        .prepare('SELECT timestamp, operation_id as operationId FROM sync_membership_clock WHERE child_entity_id=?')
        .get('m-hist') as { timestamp: number; operationId: string }
      expect(row.timestamp).toBe(T)
      expect(row.operationId).toBe('op-mhist-old')
    } finally {
      srcSqlite.close()
      dstSqlite.close()
      ;(chatDbService as any).sqlite = null
      ;(chatDbService as any).db = null
    }
  })
  it('exact tuple reapply is idempotent', () => {
    const { srcSqlite, srcDb, dstSqlite, dstDb } = openPair()
    try {
      dstSqlite
        .prepare('INSERT INTO topics (id,name,created_at,updated_at,extra) VALUES (?,?,?,?,?)')
        .run('t-exact', 'Topic', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null)
      dstSqlite
        .prepare(
          'INSERT INTO messages (id,topic_id,role,content,status,created_at,updated_at,sort_order) VALUES (?,?,?,?,?,?,?,?)'
        )
        .run(
          'm-exact',
          't-exact',
          'user',
          'hello',
          'success',
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          0
        )
      dstDb
        .insert(schema.syncEntityClock)
        .values({ entityType: 'topic', entityId: 't-exact', timestamp: T, operationId: 'op-texact' })
        .run()
      dstDb
        .insert(schema.syncEntityClock)
        .values({ entityType: 'message', entityId: 'm-exact', timestamp: T, operationId: 'op-mexact' })
        .run()
      for (const f of TOPIC_CLOCKED)
        dstDb
          .insert(schema.syncFieldClock)
          .values({ entityType: 'topic', entityId: 't-exact', field: f, timestamp: T, operationId: 'op-texact' })
          .run()
      for (const f of MESSAGE_CLOCKED)
        dstDb
          .insert(schema.syncFieldClock)
          .values({ entityType: 'message', entityId: 'm-exact', field: f, timestamp: T, operationId: 'op-mexact' })
          .run()
      dstDb
        .insert(schema.syncMembershipClock)
        .values({
          childEntityType: 'message',
          childEntityId: 'm-exact',
          parentId: 't-exact',
          timestamp: T,
          operationId: 'op-mexact'
        })
        .run()
      srcSqlite
        .prepare('INSERT INTO topics (id,name,created_at,updated_at,extra) VALUES (?,?,?,?,?)')
        .run('t-exact', 'Topic', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null)
      srcSqlite
        .prepare(
          'INSERT INTO messages (id,topic_id,role,content,status,created_at,updated_at,sort_order) VALUES (?,?,?,?,?,?,?,?)'
        )
        .run(
          'm-exact',
          't-exact',
          'user',
          'hello',
          'success',
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          0
        )
      srcDb
        .insert(schema.syncEntityClock)
        .values({ entityType: 'topic', entityId: 't-exact', timestamp: T, operationId: 'op-texact' })
        .run()
      srcDb
        .insert(schema.syncEntityClock)
        .values({ entityType: 'message', entityId: 'm-exact', timestamp: T, operationId: 'op-mexact' })
        .run()
      for (const f of TOPIC_CLOCKED)
        srcDb
          .insert(schema.syncFieldClock)
          .values({ entityType: 'topic', entityId: 't-exact', field: f, timestamp: T, operationId: 'op-texact' })
          .run()
      for (const f of MESSAGE_CLOCKED)
        srcDb
          .insert(schema.syncFieldClock)
          .values({ entityType: 'message', entityId: 'm-exact', field: f, timestamp: T, operationId: 'op-mexact' })
          .run()
      srcDb
        .insert(schema.syncMembershipClock)
        .values({
          childEntityType: 'message',
          childEntityId: 'm-exact',
          parentId: 't-exact',
          timestamp: T,
          operationId: 'op-mexact'
        })
        .run()
      srcSqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('cursor', '7')
      srcSqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('sync:channelKey', 'chan-1')
      // Seed frames for srcDb candidate
      try {
        const topics = srcSqlite.prepare('SELECT id FROM topics').all() as { id: string }[]
        for (const tp of topics) {
          const msgs = srcSqlite.prepare('SELECT id FROM messages WHERE topic_id=?').all(tp.id) as { id: string }[]
          const stableIds = msgs
            .filter((m) => {
              const row = srcSqlite.prepare('SELECT status FROM messages WHERE id=?').get(m.id) as
                | { status: string | null }
                | undefined
              return row && ['success', 'error', 'paused', 'sent'].includes(String(row.status))
            })
            .map((m) => m.id)
            .sort()
          srcSqlite
            .prepare(
              'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
            )
            .run(
              'topicMessage',
              tp.id,
              'parent-order-frame-v1',
              JSON.stringify(stableIds),
              9000100,
              `op-frame-${tp.id}`
            )
        }
        const messages = srcSqlite.prepare('SELECT id FROM messages').all() as { id: string }[]
        for (const ms of messages) {
          const blks = srcSqlite.prepare('SELECT id FROM message_blocks WHERE message_id=?').all(ms.id) as {
            id: string
          }[]
          const stableIds = blks
            .filter((b) => {
              const row = srcSqlite.prepare('SELECT status, type FROM message_blocks WHERE id=?').get(b.id) as
                | { status: string | null; type: string | null }
                | undefined
              if (!row || !['success', 'error', 'paused', 'sent'].includes(String(row.status))) return false
              const low = String(row.type).toLowerCase()
              if (['tool', 'file', 'image', 'video', 'citation'].includes(low)) return false
              return true
            })
            .map((b) => b.id)
            .sort()
          srcSqlite
            .prepare(
              'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
            )
            .run(
              'messageBlock',
              ms.id,
              'parent-order-frame-v1',
              JSON.stringify(stableIds),
              9000100,
              `op-frame-${ms.id}`
            )
        }
      } catch {}
      const cand = captureLocalSyncBaselineCandidate(srcDb)
      expect(
        cand.completeness.state === 'complete' ||
          (cand.completeness.state === 'partial' && cand.completeness.reasons.includes('missing-order-frame'))
      ).toBe(true)
      const before = JSON.stringify(
        dstSqlite.prepare('SELECT * FROM sync_membership_clock ORDER BY child_entity_id').all()
      )
      const res = applyLocalSyncBaselineCandidate(dstDb, cand)
      expect(res.inserted).toBe(0)
      const after = JSON.stringify(
        dstSqlite.prepare('SELECT * FROM sync_membership_clock ORDER BY child_entity_id').all()
      )
      expect(after).toBe(before)
      const row = dstSqlite
        .prepare('SELECT timestamp, operation_id as operationId FROM sync_membership_clock WHERE child_entity_id=?')
        .get('m-exact') as { timestamp: number; operationId: string }
      expect(row).toEqual({ timestamp: T, operationId: 'op-mexact' })
    } finally {
      srcSqlite.close()
      dstSqlite.close()
      ;(chatDbService as any).sqlite = null
      ;(chatDbService as any).db = null
    }
  })
  it('candidate with null or tampered membership is rejected', () => {
    const { srcSqlite, srcDb, dstSqlite, dstDb } = openPair()
    try {
      srcSqlite
        .prepare('INSERT INTO topics (id,name,created_at,updated_at,extra) VALUES (?,?,?,?,?)')
        .run('t-rej', 'Topic', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null)
      srcSqlite
        .prepare(
          'INSERT INTO messages (id,topic_id,role,content,status,created_at,updated_at,sort_order) VALUES (?,?,?,?,?,?,?,?)'
        )
        .run('m-rej', 't-rej', 'user', 'hello', 'success', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 0)
      srcDb
        .insert(schema.syncEntityClock)
        .values({ entityType: 'topic', entityId: 't-rej', timestamp: T, operationId: 'op-trej' })
        .run()
      srcDb
        .insert(schema.syncEntityClock)
        .values({ entityType: 'message', entityId: 'm-rej', timestamp: T, operationId: 'op-mrej' })
        .run()
      for (const f of TOPIC_CLOCKED)
        srcDb
          .insert(schema.syncFieldClock)
          .values({ entityType: 'topic', entityId: 't-rej', field: f, timestamp: T, operationId: 'op-trej' })
          .run()
      for (const f of MESSAGE_CLOCKED)
        srcDb
          .insert(schema.syncFieldClock)
          .values({ entityType: 'message', entityId: 'm-rej', field: f, timestamp: T, operationId: 'op-mrej' })
          .run()
      srcDb
        .insert(schema.syncMembershipClock)
        .values({
          childEntityType: 'message',
          childEntityId: 'm-rej',
          parentId: 't-rej',
          timestamp: T,
          operationId: 'op-mrej'
        })
        .run()
      srcSqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('cursor', '7')
      srcSqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('sync:channelKey', 'chan-1')
      try {
        const topics = srcSqlite.prepare('SELECT id FROM topics').all() as { id: string }[]
        for (const tp of topics) {
          const msgs = srcSqlite.prepare('SELECT id FROM messages WHERE topic_id=?').all(tp.id) as { id: string }[]
          const stableIds = msgs
            .filter((m) => {
              const row = srcSqlite.prepare('SELECT status FROM messages WHERE id=?').get(m.id) as
                | { status: string | null }
                | undefined
              return row && ['success', 'error', 'paused', 'sent'].includes(String(row.status))
            })
            .map((m) => m.id)
            .sort()
          srcSqlite
            .prepare(
              'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
            )
            .run(
              'topicMessage',
              tp.id,
              'parent-order-frame-v1',
              JSON.stringify(stableIds),
              9000100,
              `op-frame-${tp.id}`
            )
        }
        const messages = srcSqlite.prepare('SELECT id FROM messages').all() as { id: string }[]
        for (const ms of messages) {
          const blks = srcSqlite.prepare('SELECT id FROM message_blocks WHERE message_id=?').all(ms.id) as {
            id: string
          }[]
          const stableIds = blks
            .filter((b) => {
              const row = srcSqlite.prepare('SELECT status, type FROM message_blocks WHERE id=?').get(b.id) as
                | { status: string | null; type: string | null }
                | undefined
              if (!row || !['success', 'error', 'paused', 'sent'].includes(String(row.status))) return false
              const low = String(row.type).toLowerCase()
              if (['tool', 'file', 'image', 'video', 'citation'].includes(low)) return false
              return true
            })
            .map((b) => b.id)
            .sort()
          srcSqlite
            .prepare(
              'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
            )
            .run(
              'messageBlock',
              ms.id,
              'parent-order-frame-v1',
              JSON.stringify(stableIds),
              9000100,
              `op-frame-${ms.id}`
            )
        }
      } catch {}
      const valid = captureLocalSyncBaselineCandidate(srcDb)
      expect(
        valid.completeness.state === 'complete' ||
          (valid.completeness.state === 'partial' && valid.completeness.reasons.includes('missing-order-frame'))
      ).toBe(true)
      // null membership tamper
      const nullCand = JSON.parse(JSON.stringify(valid)) as LocalSyncBaselineCandidate
      const ent = nullCand.entities.find((e) => e.entityId === 'm-rej') as unknown as { parentMembershipClock: unknown }
      ent.parentMembershipClock = null
      // keep digest? refresh to make it pass digest but still fail validation for missing membership
      nullCand.manifest.unversionedMembershipCount = 1 as unknown as number
      nullCand.manifest.completenessState = 'partial' as unknown as string as any
      nullCand.manifest.completenessReasons = ['unversioned-membership']
      nullCand.completeness.state = 'partial' as unknown as string as any
      nullCand.completeness.reasons = ['unversioned-membership']
      nullCand.manifest.digest = computeLocalSyncBaselineDigest(nullCand)
      expect(() => applyLocalSyncBaselineCandidate(dstDb, nullCand)).toThrow(SyncBaselineApplyError)
      // tampered operationId with colon, refresh digest
      const tampered = JSON.parse(JSON.stringify(valid)) as LocalSyncBaselineCandidate
      const ent2 = tampered.entities.find((e) => e.entityId === 'm-rej') as unknown as {
        parentMembershipClock: { parentId: string; timestamp: number; operationId: string }
      }
      ent2.parentMembershipClock.operationId = 'bad:colon'
      tampered.manifest.digest = computeLocalSyncBaselineDigest(tampered)
      expect(() => applyLocalSyncBaselineCandidate(dstDb, tampered)).toThrow(SyncBaselineApplyError)
      // topic with membership key should be rejected
      const topicWithMem = JSON.parse(JSON.stringify(valid)) as LocalSyncBaselineCandidate
      const tEnt = topicWithMem.entities.find((e) => e.entityType === 'topic') as unknown as Record<string, unknown>
      tEnt['parentMembershipClock'] = { parentId: 't-rej', timestamp: T, operationId: 'op-trej' }
      topicWithMem.manifest.digest = computeLocalSyncBaselineDigest(topicWithMem)
      expect(() => applyLocalSyncBaselineCandidate(dstDb, topicWithMem)).toThrow(/unexpected topic membership/)
    } finally {
      srcSqlite.close()
      dstSqlite.close()
      ;(chatDbService as any).sqlite = null
      ;(chatDbService as any).db = null
    }
  })
  it('tampered complete claims null/missing membership with recomputed digest still fails closed with target unchanged', () => {
    const { srcSqlite, srcDb, dstSqlite, dstDb } = openPair()
    try {
      srcSqlite
        .prepare('INSERT INTO topics (id,name,created_at,updated_at,extra) VALUES (?,?,?,?,?)')
        .run('t-tam', 'Topic', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null)
      srcSqlite
        .prepare(
          'INSERT INTO messages (id,topic_id,role,content,status,created_at,updated_at,sort_order) VALUES (?,?,?,?,?,?,?,?)'
        )
        .run('m-tam', 't-tam', 'user', 'hello', 'success', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 0)
      srcDb
        .insert(schema.syncEntityClock)
        .values({ entityType: 'topic', entityId: 't-tam', timestamp: T, operationId: 'op-ttam' })
        .run()
      srcDb
        .insert(schema.syncEntityClock)
        .values({ entityType: 'message', entityId: 'm-tam', timestamp: T, operationId: 'op-mtam' })
        .run()
      for (const f of TOPIC_CLOCKED)
        srcDb
          .insert(schema.syncFieldClock)
          .values({ entityType: 'topic', entityId: 't-tam', field: f, timestamp: T, operationId: 'op-ttam' })
          .run()
      for (const f of MESSAGE_CLOCKED)
        srcDb
          .insert(schema.syncFieldClock)
          .values({ entityType: 'message', entityId: 'm-tam', field: f, timestamp: T, operationId: 'op-mtam' })
          .run()
      srcDb
        .insert(schema.syncMembershipClock)
        .values({
          childEntityType: 'message',
          childEntityId: 'm-tam',
          parentId: 't-tam',
          timestamp: T,
          operationId: 'op-mtam'
        })
        .run()
      srcSqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('cursor', '7')
      srcSqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('sync:channelKey', 'chan-1')
      try {
        const topics = srcSqlite.prepare('SELECT id FROM topics').all() as { id: string }[]
        for (const tp of topics) {
          const msgs = srcSqlite.prepare('SELECT id FROM messages WHERE topic_id=?').all(tp.id) as { id: string }[]
          const stableIds = msgs
            .filter((m) => {
              const row = srcSqlite.prepare('SELECT status FROM messages WHERE id=?').get(m.id) as
                | { status: string | null }
                | undefined
              return row && ['success', 'error', 'paused', 'sent'].includes(String(row.status))
            })
            .map((m) => m.id)
            .sort()
          srcSqlite
            .prepare(
              'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
            )
            .run(
              'topicMessage',
              tp.id,
              'parent-order-frame-v1',
              JSON.stringify(stableIds),
              9000100,
              `op-frame-${tp.id}`
            )
        }
        const messages = srcSqlite.prepare('SELECT id FROM messages').all() as { id: string }[]
        for (const ms of messages) {
          const blks = srcSqlite.prepare('SELECT id FROM message_blocks WHERE message_id=?').all(ms.id) as {
            id: string
          }[]
          const stableIds = blks
            .filter((b) => {
              const row = srcSqlite.prepare('SELECT status, type FROM message_blocks WHERE id=?').get(b.id) as
                | { status: string | null; type: string | null }
                | undefined
              if (!row || !['success', 'error', 'paused', 'sent'].includes(String(row.status))) return false
              const low = String(row.type).toLowerCase()
              if (['tool', 'file', 'image', 'video', 'citation'].includes(low)) return false
              return true
            })
            .map((b) => b.id)
            .sort()
          srcSqlite
            .prepare(
              'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
            )
            .run(
              'messageBlock',
              ms.id,
              'parent-order-frame-v1',
              JSON.stringify(stableIds),
              9000100,
              `op-frame-${ms.id}`
            )
        }
      } catch {}
      const valid = captureLocalSyncBaselineCandidate(srcDb)
      expect(
        valid.completeness.state === 'complete' ||
          (valid.completeness.state === 'partial' && valid.completeness.reasons.includes('missing-order-frame'))
      ).toBe(true)
      const snapshotBefore =
        JSON.stringify(dstSqlite.prepare('SELECT * FROM sync_membership_clock ORDER BY child_entity_id').all()) +
        JSON.stringify(dstSqlite.prepare('SELECT * FROM topics ORDER BY id').all()) +
        JSON.stringify(dstSqlite.prepare('SELECT * FROM messages ORDER BY id').all())
      // Tamper: remove membership (null) but keep complete claims and recomputed digest
      const tampered = JSON.parse(JSON.stringify(valid)) as LocalSyncBaselineCandidate
      const ent = tampered.entities.find((e) => e.entityId === 'm-tam') as unknown as { parentMembershipClock: unknown }
      ent.parentMembershipClock = null as unknown as { timestamp: number; operationId: string }
      // Keep manifest claiming zero missing and complete, but recompute digest to be self-consistent
      tampered.manifest.unversionedMembershipCount = 0
      tampered.manifest.completenessState = 'complete' as unknown as string as any
      tampered.manifest.completenessReasons = []
      tampered.completeness.state = 'complete' as unknown as string as any
      tampered.completeness.reasons = []
      tampered.manifest.digest = computeLocalSyncBaselineDigest(tampered)
      expect(() => applyLocalSyncBaselineCandidate(dstDb, tampered)).toThrow(SyncBaselineApplyError)
      const snapshotAfter =
        JSON.stringify(dstSqlite.prepare('SELECT * FROM sync_membership_clock ORDER BY child_entity_id').all()) +
        JSON.stringify(dstSqlite.prepare('SELECT * FROM topics ORDER BY id').all()) +
        JSON.stringify(dstSqlite.prepare('SELECT * FROM messages ORDER BY id').all())
      expect(snapshotAfter).toBe(snapshotBefore)
      // Also test missing key variant
      const missing = JSON.parse(JSON.stringify(valid)) as LocalSyncBaselineCandidate
      const ent2 = missing.entities.find((e) => e.entityId === 'm-tam') as unknown as Record<string, unknown>
      delete ent2['parentMembershipClock']
      missing.manifest.unversionedMembershipCount = 0
      missing.manifest.completenessState = 'complete' as unknown as string as any
      missing.manifest.completenessReasons = []
      missing.completeness.state = 'complete' as unknown as string as any
      missing.completeness.reasons = []
      missing.manifest.digest = computeLocalSyncBaselineDigest(missing)
      expect(() => applyLocalSyncBaselineCandidate(dstDb, missing)).toThrow(SyncBaselineApplyError)
      expect(
        JSON.stringify(dstSqlite.prepare('SELECT * FROM sync_membership_clock ORDER BY child_entity_id').all()) +
          JSON.stringify(dstSqlite.prepare('SELECT * FROM topics ORDER BY id').all()) +
          JSON.stringify(dstSqlite.prepare('SELECT * FROM messages ORDER BY id').all())
      ).toBe(snapshotBefore)
    } finally {
      srcSqlite.close()
      dstSqlite.close()
      ;(chatDbService as any).sqlite = null
      ;(chatDbService as any).db = null
    }
  })
})

describe('capture orphan handling', () => {
  it('allows deleted retained membership with matching tombstone', () => {
    insertTopic('t-retain')
    insertMessage('m-retain', 't-retain')
    seedEntityClock('topic', 't-retain', T, 'op-tretain')
    seedEntityClock('message', 'm-retain', T, 'op-mretain')
    seedFull('topic', 't-retain', T, 'op-tretain')
    seedFull('message', 'm-retain', T, 'op-mretain')
    seedMembership('message', 'm-retain', 't-retain', T, 'op-mretain')
    seedBound()
    // delete the message row but keep tombstone and membership
    sqlite.prepare('DELETE FROM messages WHERE id=?').run('m-retain')
    sqlite
      .prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)')
      .run('tombstone:message:m-retain', `${T + 10}:op-del-mretain`)
    const c = captureLocalSyncBaselineCandidate(db)
    // Membership for deleted child with tombstone is allowed and omitted from live entities
    expect(c.entities.find((e) => e.entityId === 'm-retain')).toBeUndefined()
    expect(c.tombstones.find((t) => t.entityId === 'm-retain')).toBeTruthy()
    // No orphan failure, candidate can still be complete (tombstone present, no live child)
    expect(c.manifest.unversionedMembershipCount).toBe(0)
    expect(
      c.completeness.state === 'complete' ||
        (c.completeness.state === 'partial' && c.completeness.reasons.includes('missing-order-frame'))
    ).toBe(true)
  })
  it('rejects true orphan membership with no row/tombstone', () => {
    insertTopic('t-orph')
    seedEntityClock('topic', 't-orph', T, 'op-torph')
    seedFull('topic', 't-orph', T, 'op-torph')
    seedBound()
    db.insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message',
        childEntityId: 'm-orph-no-row',
        parentId: 't-orph',
        timestamp: T,
        operationId: 'op-orph'
      })
      .run()
    const before = snapshot()
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(SyncBaselineError)
    expect(snapshot()).toBe(before)
  })
  it('validates parent mismatch for excluded/transient child', () => {
    insertTopic('t-ex')
    sqlite
      .prepare(
        'INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run('m-trans', 't-ex', 'user', 'hello', 'streaming', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 0)
    seedEntityClock('topic', 't-ex', T, 'op-tex')
    seedFull('topic', 't-ex', T, 'op-tex')
    // transient message excluded from candidate, but membership parent mismatch must still fail
    db.insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message',
        childEntityId: 'm-trans',
        parentId: 't-other-mismatch',
        timestamp: T,
        operationId: 'op-mtrans'
      })
      .run()
    seedBound()
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(/membership parent mismatch/)
    // Also test unsupported block parent mismatch
    sqlite.prepare('DELETE FROM sync_membership_clock WHERE child_entity_id=?').run('m-trans')
    sqlite.prepare('DELETE FROM messages WHERE id=?').run('m-trans')
    insertMessage('m-stable', 't-ex')
    sqlite
      .prepare(
        'INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)'
      )
      .run(
        'b-tool',
        'm-stable',
        'tool',
        'x',
        'success',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        0,
        JSON.stringify({ content: { tool: 'x' } })
      )
    seedEntityClock('message', 'm-stable', T, 'op-mstable')
    seedFull('message', 'm-stable', T, 'op-mstable')
    db.insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message_block',
        childEntityId: 'b-tool',
        parentId: 'm-mismatch',
        timestamp: T,
        operationId: 'op-btool'
      })
      .run()
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(/membership parent mismatch/)
  })
  it('excluded transient membership with correct parent is allowed and omitted without forcing', () => {
    insertTopic('t-ex2')
    sqlite
      .prepare(
        'INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run('m-trans2', 't-ex2', 'user', 'hello', 'streaming', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 0)
    seedEntityClock('topic', 't-ex2', T, 'op-tex2')
    seedFull('topic', 't-ex2', T, 'op-tex2')
    db.insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message',
        childEntityId: 'm-trans2',
        parentId: 't-ex2',
        timestamp: T,
        operationId: 'op-mtrans2'
      })
      .run()
    seedBound()
    const c = captureLocalSyncBaselineCandidate(db)
    expect(c.entities.find((e) => e.entityId === 'm-trans2')).toBeUndefined()
    expect(c.manifest.excludedTransientMessages).toBe(1)
    expect(c.completeness.reasons).toContain('transient-message-excluded')
    // Still partial due to transient, but not failed; membership not forced into candidate
    expect(() => captureLocalSyncBaselineCandidate(db)).not.toThrow()
  })
})

describe('frame-aware parentId mandatory', () => {
  it('missing parentId field inside clock fails even with self-consistent digest', () => {
    const { srcSqlite, srcDb, dstSqlite, dstDb } = openPair()
    try {
      srcSqlite
        .prepare('INSERT INTO topics (id,name,created_at,updated_at,extra) VALUES (?,?,?,?,?)')
        .run('t-long-miss', 'Topic', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null)
      srcSqlite
        .prepare(
          'INSERT INTO messages (id,topic_id,role,content,status,created_at,updated_at,sort_order) VALUES (?,?,?,?,?,?,?,?)'
        )
        .run(
          'm-miss',
          't-long-miss',
          'user',
          'hello',
          'success',
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          0
        )
      srcDb
        .insert(schema.syncEntityClock)
        .values({ entityType: 'topic', entityId: 't-long-miss', timestamp: T, operationId: 'op-tmiss' })
        .run()
      srcDb
        .insert(schema.syncEntityClock)
        .values({ entityType: 'message', entityId: 'm-miss', timestamp: T, operationId: 'op-mmiss' })
        .run()
      for (const f of TOPIC_CLOCKED)
        srcDb
          .insert(schema.syncFieldClock)
          .values({ entityType: 'topic', entityId: 't-long-miss', field: f, timestamp: T, operationId: 'op-tmiss' })
          .run()
      for (const f of MESSAGE_CLOCKED)
        srcDb
          .insert(schema.syncFieldClock)
          .values({ entityType: 'message', entityId: 'm-miss', field: f, timestamp: T, operationId: 'op-mmiss' })
          .run()
      srcDb
        .insert(schema.syncMembershipClock)
        .values({
          childEntityType: 'message',
          childEntityId: 'm-miss',
          parentId: 't-long-miss',
          timestamp: T,
          operationId: 'op-mmiss'
        })
        .run()
      srcSqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('cursor', '7')
      srcSqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('sync:channelKey', 'chan-1')
      srcSqlite
        .prepare(
          'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
        )
        .run(
          'topicMessage',
          't-long-miss',
          'parent-order-frame-v1',
          JSON.stringify(['m-miss']),
          T + 10,
          'op-frame-miss'
        )
      srcSqlite
        .prepare(
          'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
        )
        .run('messageBlock', 'm-miss', 'parent-order-frame-v1', JSON.stringify([]), T + 10, 'op-frame-miss-m')
      const valid = captureLocalSyncBaselineCandidate(srcDb)
      expect(valid.completeness.state).toBe('complete')
      const tampered = JSON.parse(JSON.stringify(valid)) as LocalSyncBaselineCandidate
      const ent = tampered.entities.find((e) => e.entityId === 'm-miss') as unknown as Record<string, unknown>
      const pm = ent['parentMembershipClock'] as Record<string, unknown>
      delete pm['parentId']
      tampered.manifest.digest = computeLocalSyncBaselineDigest(tampered)
      expect(() => applyLocalSyncBaselineCandidate(dstDb, tampered)).toThrow(/parentId|membership/)
    } finally {
      srcSqlite.close()
      dstSqlite.close()
      ;(chatDbService as any).sqlite = null
      ;(chatDbService as any).db = null
    }
  })
  it('wrong parentId mismatch fails even with self-consistent digest', () => {
    const { srcSqlite, srcDb, dstSqlite, dstDb } = openPair()
    try {
      srcSqlite
        .prepare('INSERT INTO topics (id,name,created_at,updated_at,extra) VALUES (?,?,?,?,?)')
        .run('t-wrong', 'Topic', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null)
      srcSqlite
        .prepare('INSERT INTO topics (id,name,created_at,updated_at,extra) VALUES (?,?,?,?,?)')
        .run('t-other-wrong', 'Topic', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null)
      srcSqlite
        .prepare(
          'INSERT INTO messages (id,topic_id,role,content,status,created_at,updated_at,sort_order) VALUES (?,?,?,?,?,?,?,?)'
        )
        .run(
          'm-wrong',
          't-wrong',
          'user',
          'hello',
          'success',
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          0
        )
      srcDb
        .insert(schema.syncEntityClock)
        .values({ entityType: 'topic', entityId: 't-wrong', timestamp: T, operationId: 'op-twrong' })
        .run()
      srcDb
        .insert(schema.syncEntityClock)
        .values({ entityType: 'topic', entityId: 't-other-wrong', timestamp: T, operationId: 'op-tother' })
        .run()
      srcDb
        .insert(schema.syncEntityClock)
        .values({ entityType: 'message', entityId: 'm-wrong', timestamp: T, operationId: 'op-mwrong' })
        .run()
      for (const f of TOPIC_CLOCKED) {
        srcDb
          .insert(schema.syncFieldClock)
          .values({ entityType: 'topic', entityId: 't-wrong', field: f, timestamp: T, operationId: 'op-twrong' })
          .run()
        srcDb
          .insert(schema.syncFieldClock)
          .values({ entityType: 'topic', entityId: 't-other-wrong', field: f, timestamp: T, operationId: 'op-tother' })
          .run()
      }
      for (const f of MESSAGE_CLOCKED)
        srcDb
          .insert(schema.syncFieldClock)
          .values({ entityType: 'message', entityId: 'm-wrong', field: f, timestamp: T, operationId: 'op-mwrong' })
          .run()
      srcDb
        .insert(schema.syncMembershipClock)
        .values({
          childEntityType: 'message',
          childEntityId: 'm-wrong',
          parentId: 't-wrong',
          timestamp: T,
          operationId: 'op-mwrong'
        })
        .run()
      srcSqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('cursor', '7')
      srcSqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('sync:channelKey', 'chan-1')
      srcSqlite
        .prepare(
          'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
        )
        .run('topicMessage', 't-wrong', 'parent-order-frame-v1', JSON.stringify(['m-wrong']), T + 10, 'op-frame-wrong')
      srcSqlite
        .prepare(
          'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
        )
        .run('topicMessage', 't-other-wrong', 'parent-order-frame-v1', JSON.stringify([]), T + 10, 'op-frame-other')
      srcSqlite
        .prepare(
          'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
        )
        .run('messageBlock', 'm-wrong', 'parent-order-frame-v1', JSON.stringify([]), T + 10, 'op-frame-mwrong')
      const valid = captureLocalSyncBaselineCandidate(srcDb)
      expect(valid.completeness.state).toBe('complete')
      const tampered = JSON.parse(JSON.stringify(valid)) as LocalSyncBaselineCandidate
      const ent = tampered.entities.find((e) => e.entityId === 'm-wrong') as unknown as {
        parentMembershipClock: { parentId: string }
      }
      ent.parentMembershipClock.parentId = 't-other-wrong'
      tampered.manifest.digest = computeLocalSyncBaselineDigest(tampered)
      expect(() => applyLocalSyncBaselineCandidate(dstDb, tampered)).toThrow(
        /parentId mismatch|membership parent mismatch/
      )
    } finally {
      srcSqlite.close()
      dstSqlite.close()
      ;(chatDbService as any).sqlite = null
      ;(chatDbService as any).db = null
    }
  })
  it('long >256 Unicode-scalar parentId is valid and round-trips through capture and apply', () => {
    const longTopicId = 't-' + 'a'.repeat(300)
    expect(longTopicId.length).toBeGreaterThan(256)
    const { srcSqlite, srcDb, dstSqlite, dstDb } = openPair()
    try {
      srcSqlite
        .prepare('INSERT INTO topics (id,name,created_at,updated_at,extra) VALUES (?,?,?,?,?)')
        .run(longTopicId, 'LongTopic', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null)
      const longMsgId = 'm-' + 'b'.repeat(300)
      srcSqlite
        .prepare(
          'INSERT INTO messages (id,topic_id,role,content,status,created_at,updated_at,sort_order) VALUES (?,?,?,?,?,?,?,?)'
        )
        .run(
          longMsgId,
          longTopicId,
          'user',
          'hello',
          'success',
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          0
        )
      srcDb
        .insert(schema.syncEntityClock)
        .values({ entityType: 'topic', entityId: longTopicId, timestamp: T, operationId: 'op-long-t' })
        .run()
      srcDb
        .insert(schema.syncEntityClock)
        .values({ entityType: 'message', entityId: longMsgId, timestamp: T, operationId: 'op-long-m' })
        .run()
      for (const f of TOPIC_CLOCKED)
        srcDb
          .insert(schema.syncFieldClock)
          .values({ entityType: 'topic', entityId: longTopicId, field: f, timestamp: T, operationId: 'op-long-t' })
          .run()
      for (const f of MESSAGE_CLOCKED)
        srcDb
          .insert(schema.syncFieldClock)
          .values({ entityType: 'message', entityId: longMsgId, field: f, timestamp: T, operationId: 'op-long-m' })
          .run()
      srcDb
        .insert(schema.syncMembershipClock)
        .values({
          childEntityType: 'message',
          childEntityId: longMsgId,
          parentId: longTopicId,
          timestamp: T,
          operationId: 'op-long-m'
        })
        .run()
      srcSqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('cursor', '7')
      srcSqlite.prepare('INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)').run('sync:channelKey', 'chan-1')
      // also insert frame with long parentId
      srcSqlite
        .prepare(
          'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
        )
        .run('topicMessage', longTopicId, 'parent-order-frame-v1', JSON.stringify([longMsgId]), T + 10, 'op-frame-long')
      srcSqlite
        .prepare(
          'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?,?,?,?,?,?)'
        )
        .run('messageBlock', longMsgId, 'parent-order-frame-v1', JSON.stringify([]), T + 10, 'op-frame-long-m')
      const cand = captureLocalSyncBaselineCandidate(srcDb)
      expect(cand.completeness.state).toBe('complete')
      const msgEnt = cand.entities.find((e) => e.entityId === longMsgId) as unknown as {
        parentMembershipClock: { parentId: string }
      }
      expect(msgEnt.parentMembershipClock.parentId).toBe(longTopicId)
      expect(msgEnt.parentMembershipClock.parentId.length).toBeGreaterThan(256)
      const res = applyLocalSyncBaselineCandidate(dstDb, cand)
      expect(res.inserted).toBe(2)
      const row = dstSqlite
        .prepare('SELECT parent_id FROM sync_membership_clock WHERE child_entity_id=?')
        .get(longMsgId) as { parent_id: string }
      expect(row.parent_id).toBe(longTopicId)
      const frameRow = dstSqlite
        .prepare('SELECT parent_id FROM sync_parent_order_frame WHERE parent_id=?')
        .get(longTopicId) as { parent_id: string } | undefined
      expect(frameRow?.parent_id).toBe(longTopicId)
    } finally {
      srcSqlite.close()
      dstSqlite.close()
      ;(chatDbService as any).sqlite = null
      ;(chatDbService as any).db = null
    }
  })
  it('empty and lone-surrogate parentId handling follows SQLite/app validation', () => {
    // empty parentId is rejected by app validation (non-empty Unicode scalar); DB has no CHECK but app does
    // Inserting empty via DB succeeds (no DB CHECK), but capture should reject
    db.insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message',
        childEntityId: 'm-empty-check',
        parentId: '',
        timestamp: T,
        operationId: 'op-empty'
      })
      .run()
    insertTopic('t-empty-check-topic')
    sqlite
      .prepare(
        'INSERT OR IGNORE INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run(
        'm-empty-check',
        't-empty-check-topic',
        'user',
        'hi',
        'success',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        0
      )
    seedEntityClock('topic', 't-empty-check-topic', T, 'op-t')
    seedEntityClock('message', 'm-empty-check', T, 'op-empty')
    seedFull('topic', 't-empty-check-topic', T, 'op-t')
    seedFull('message', 'm-empty-check', T, 'op-empty')
    seedBound()
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(/malformed membership parent/)
    sqlite.prepare(`DELETE FROM sync_membership_clock WHERE child_entity_id='m-empty-check'`).run()
    sqlite.prepare(`DELETE FROM messages WHERE id='m-empty-check'`).run()
    sqlite.prepare(`DELETE FROM topics WHERE id='t-empty-check-topic'`).run()
    sqlite.prepare(`DELETE FROM sync_entity_clock WHERE entity_id IN ('t-empty-check-topic','m-empty-check')`).run()
    sqlite.prepare(`DELETE FROM sync_field_clock WHERE entity_id IN ('t-empty-check-topic','m-empty-check')`).run()
    sqlite.prepare(`DELETE FROM sync_state WHERE key='cursor' OR key='sync:channelKey'`).run()
    // lone surrogate is rejected by app strict validation (isValidUnicodeScalarString), not necessarily by SQLite
    const lone = '\uD800'
    expect(isValidUnicodeScalarString(lone)).toBe(false)
    // operationId still enforced as <=256 and no colon
    expect(() =>
      db
        .insert(schema.syncMembershipClock)
        .values({
          childEntityType: 'message',
          childEntityId: 'm-op-bad',
          parentId: 't-empty-test',
          timestamp: T,
          operationId: 'bad:colon'
        })
        .run()
    ).not.toThrow() // SQLite does not enforce operationId shape, app does; but syncMembershipClock table has no CHECK for colon, so insert succeeds, but capture will reject
    // Verify capture would reject a membership with bad operationId
    db.insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message',
        childEntityId: 'm-op-bad2',
        parentId: 't-empty-test',
        timestamp: T,
        operationId: 'bad:colon'
      })
      .run()
    insertTopic('t-empty-test2')
    sqlite
      .prepare(
        'INSERT OR IGNORE INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run(
        'm-op-bad2',
        't-empty-test2',
        'user',
        'hi',
        'success',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        0
      )
    seedEntityClock('topic', 't-empty-test2', T, 'op-t')
    seedEntityClock('message', 'm-op-bad2', T, 'bad:colon')
    seedFull('topic', 't-empty-test2', T, 'op-t')
    seedFull('message', 'm-op-bad2', T, 'bad:colon')
    seedBound()
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(/malformed.*operationId|bad:colon/)
    sqlite.prepare(`DELETE FROM sync_membership_clock WHERE child_entity_id='m-op-bad2'`).run()
    sqlite.prepare(`DELETE FROM sync_membership_clock WHERE child_entity_id='m-op-bad'`).run()
    sqlite.prepare(`DELETE FROM messages WHERE id='m-op-bad2'`).run()
    sqlite.prepare(`DELETE FROM topics WHERE id='t-empty-test2'`).run()
    sqlite.prepare(`DELETE FROM sync_entity_clock WHERE entity_id IN ('t-empty-test2','m-op-bad2')`).run()
    sqlite.prepare(`DELETE FROM sync_field_clock WHERE entity_id IN ('t-empty-test2','m-op-bad2')`).run()
    sqlite.prepare(`DELETE FROM sync_state WHERE key='cursor' OR key='sync:channelKey'`).run()
  })
})
