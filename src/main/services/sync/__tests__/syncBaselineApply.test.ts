/**
 * Bounded Main-only local baseline apply tests.
 *
 * Two in-memory Main DBs / captured candidates: source capture is applied
 * into a separate target authority. Covers union, field-LWW merge,
 * tie-breaks, tombstone containment, fail-closed validation, preservation,
 * idempotence, and whole-transaction rollback.
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
  type LocalSyncBaselineCandidate
} from '../syncBaseline'
import { applyLocalSyncBaselineCandidate, SyncBaselineApplyError } from '../syncBaselineApply'

const T = 9_000_000

let srcSqlite: Database.Database
let srcDb: BetterSQLite3Database<typeof schema>
let dstSqlite: Database.Database
let dstDb: BetterSQLite3Database<typeof schema>

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

function openPair(): void {
  srcSqlite = openInMemory()
  srcDb = drizzle(srcSqlite, { schema })
  runMigrations(srcDb as any, srcSqlite)
  dstSqlite = openInMemory()
  dstDb = drizzle(dstSqlite, { schema })
  runMigrations(dstDb as any, dstSqlite)
  ;(chatDbService as any).sqlite = dstSqlite
  ;(chatDbService as any).db = dstDb
}

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
  configStore.set('sync:token', '')
  openPair()
})

afterEach(() => {
  vi.restoreAllMocks()
  try {
    srcSqlite.close()
  } catch {}
  try {
    dstSqlite.close()
  } catch {}
  ;(chatDbService as any).sqlite = null
  ;(chatDbService as any).db = null
})

const TOPIC_REQUIRED_CLOCKED = ['name', 'assistantId', 'createdAt', 'updatedAt', 'deletedAt']
const TOPIC_OPTIONAL_CLOCKED = ['pinned', 'prompt', 'isNameManuallyEdited']
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

function insertTopicOn(
  sqlite: Database.Database,
  id: string,
  name = `Topic ${id}`,
  extra: Record<string, unknown> | null = null
): void {
  sqlite
    .prepare('INSERT INTO topics (id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?)')
    .run(id, name, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null, extra ? JSON.stringify(extra) : null)
}

function insertMessageOn(
  sqlite: Database.Database,
  id: string,
  topicId: string,
  content: string | null = 'hello',
  status: string | null = 'success'
): void {
  sqlite
    .prepare(
      'INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)'
    )
    .run(id, topicId, 'user', content, status, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 0)
}

function insertBlockOn(
  sqlite: Database.Database,
  id: string,
  messageId: string,
  content: string | null = 'body'
): void {
  sqlite
    .prepare(
      'INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)'
    )
    .run(
      id,
      messageId,
      'main_text',
      content,
      'success',
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      0,
      null
    )
}

function seedEntityClockOn(
  db: BetterSQLite3Database<typeof schema>,
  type: string,
  id: string,
  ts: number,
  op: string
): void {
  db.insert(schema.syncEntityClock).values({ entityType: type, entityId: id, timestamp: ts, operationId: op }).run()
}

function seedFieldClockOn(
  db: BetterSQLite3Database<typeof schema>,
  type: string,
  id: string,
  field: string,
  ts: number,
  op: string
): void {
  db.insert(schema.syncFieldClock)
    .values({ entityType: type, entityId: id, field, timestamp: ts, operationId: op })
    .run()
}

function seedFullFieldsOn(
  db: BetterSQLite3Database<typeof schema>,
  type: string,
  id: string,
  ts: number,
  op: string,
  extraTopicFields: string[] = []
): void {
  // Topics: required clocked always; optional only when present in payload.
  // Messages/blocks: full required sets always materialized.
  const fields =
    type === 'topic'
      ? [...TOPIC_REQUIRED_CLOCKED, ...extraTopicFields.filter((f) => TOPIC_OPTIONAL_CLOCKED.includes(f))]
      : type === 'message'
        ? MESSAGE_CLOCKED
        : BLOCK_CLOCKED
  for (const f of fields) seedFieldClockOn(db, type, id, f, ts, op)
}

function seedMembershipOn(
  db: BetterSQLite3Database<typeof schema>,
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

function seedBoundOn(sqlite: Database.Database, cursor = '7', channel = 'chan-1'): void {
  sqlite.prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)').run('cursor', cursor)
  sqlite.prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)').run('sync:channelKey', channel)
}

function seedCompleteSource(
  topicId = 't-s',
  messageId = 'm-s',
  blockId = 'b-s',
  ts = T,
  opPrefix = 'op-s'
): LocalSyncBaselineCandidate {
  insertTopicOn(srcSqlite, topicId)
  insertMessageOn(srcSqlite, messageId, topicId)
  insertBlockOn(srcSqlite, blockId, messageId)
  seedEntityClockOn(srcDb, 'topic', topicId, ts, `${opPrefix}-t`)
  seedEntityClockOn(srcDb, 'message', messageId, ts, `${opPrefix}-m`)
  seedEntityClockOn(srcDb, 'message_block', blockId, ts, `${opPrefix}-b`)
  seedFullFieldsOn(srcDb, 'topic', topicId, ts, `${opPrefix}-t`)
  seedFullFieldsOn(srcDb, 'message', messageId, ts, `${opPrefix}-m`)
  seedFullFieldsOn(srcDb, 'message_block', blockId, ts, `${opPrefix}-b`)
  seedMembershipOn(srcDb, 'message', messageId, topicId, ts, `${opPrefix}-m`)
  seedMembershipOn(srcDb, 'message_block', blockId, messageId, ts, `${opPrefix}-b`)
  seedBoundOn(srcSqlite)
  const candidate = captureLocalSyncBaselineCandidate(srcDb)
  expect(candidate.completeness.state).toBe('complete')
  return candidate
}

function cloneCandidate(c: LocalSyncBaselineCandidate): LocalSyncBaselineCandidate {
  return JSON.parse(JSON.stringify(c)) as LocalSyncBaselineCandidate
}

function refreshDigest(c: LocalSyncBaselineCandidate): void {
  c.manifest.digest = computeLocalSyncBaselineDigest(c)
}

function refreshCountsAndDigest(c: LocalSyncBaselineCandidate): void {
  c.manifest.entityCounts = {
    topic: c.entities.filter((e) => e.entityType === 'topic').length,
    message: c.entities.filter((e) => e.entityType === 'message').length,
    message_block: c.entities.filter((e) => e.entityType === 'message_block').length,
    total: c.entities.length
  }
  c.manifest.tombstoneCount = c.tombstones.length
  c.manifest.unversionedMembershipCount = c.entities.filter((e) => {
    if (e.entityType === 'topic') return false
    const pm = (e as unknown as { parentMembershipClock?: unknown }).parentMembershipClock
    return pm === null || pm === undefined
  }).length
  refreshDigest(c)
}

function snapshotTarget(): string {
  const tables = [
    'topics',
    'messages',
    'message_blocks',
    'sync_state',
    'sync_outbox',
    'sync_applied',
    'sync_entity_clock',
    'sync_field_clock',
    'sync_membership_clock',
    'sync_conflict_log'
  ]
  const dump: Record<string, unknown> = {}
  for (const table of tables) {
    dump[table] = dstSqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
  }
  return JSON.stringify(dump)
}

function outboxCount(): number {
  return (dstSqlite.prepare('SELECT COUNT(*) as c FROM sync_outbox').get() as { c: number }).c
}

describe('independent union', () => {
  it('unions independent topic→message→block without placeholders', () => {
    const candidate = seedCompleteSource('t-s', 'm-s', 'b-s')
    const res = applyLocalSyncBaselineCandidate(dstDb, candidate)
    expect(res.inserted).toBe(3)
    expect(res.updated).toBe(0)
    expect(res.deleted).toBe(0)
    expect(dstSqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-s')).toBeTruthy()
    expect(dstSqlite.prepare('SELECT id FROM messages WHERE id=?').get('m-s')).toBeTruthy()
    expect(dstSqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-s')).toBeTruthy()
    // Clocks installed.
    expect(dstSqlite.prepare('SELECT * FROM sync_entity_clock WHERE entity_id=?').get('t-s')).toBeTruthy()
    expect(
      dstSqlite.prepare('SELECT * FROM sync_field_clock WHERE entity_id=? AND field=?').get('m-s', 'content')
    ).toBeTruthy()
    // No outbox created, no applied.
    expect(outboxCount()).toBe(0)
    expect((dstSqlite.prepare('SELECT COUNT(*) as c FROM sync_applied').get() as { c: number }).c).toBe(0)
  })
})

describe('field merge', () => {
  it('merges independent fields when both sides have trustworthy clocks', () => {
    // Source: name newer, pinned older. Target: name older, pinned newer.
    // Present optional overflow: pinned only (prompt/isNameManuallyEdited absent).
    insertTopicOn(srcSqlite, 't-merge', 'SourceName', { pinned: false })
    seedEntityClockOn(srcDb, 'topic', 't-merge', T + 10, 'op-src-t')
    // Seed field clocks: name newer on source, pinned older; required rest at T.
    for (const f of [...TOPIC_REQUIRED_CLOCKED, 'pinned']) {
      const ts = f === 'name' ? T + 10 : T
      const op = f === 'name' ? 'op-src-name' : 'op-old-pin'
      seedFieldClockOn(srcDb, 'topic', 't-merge', f, ts, op)
    }
    // Ensure all clocked payload fields have clocks (fill rest with T).
    seedBoundOn(srcSqlite)
    // Patch source field clocks for remaining fields already seeded above; ensure entityClock covers.
    const candidate = captureLocalSyncBaselineCandidate(srcDb)
    expect(candidate.completeness.state).toBe('complete')

    // Target with opposite versions.
    insertTopicOn(dstSqlite, 't-merge', 'TargetName', { pinned: true })
    seedEntityClockOn(dstDb, 'topic', 't-merge', T + 10, 'op-dst-t')
    for (const f of [...TOPIC_REQUIRED_CLOCKED, 'pinned']) {
      const ts = f === 'pinned' ? T + 20 : T
      const op = f === 'pinned' ? 'op-dst-pin' : 'op-old-name'
      seedFieldClockOn(dstDb, 'topic', 't-merge', f, ts, op)
    }
    // Align source name clock to beat target name clock, and target pinned to beat source pinned.
    // Source name T+10 vs target name T => source wins name.
    // Source pinned T vs target pinned T+20 => target wins pinned (preserve).
    const res = applyLocalSyncBaselineCandidate(dstDb, candidate)
    expect(res.updated).toBe(1)
    const row = dstSqlite.prepare('SELECT name, extra FROM topics WHERE id=?').get('t-merge') as {
      name: string
      extra: string | null
    }
    expect(row.name).toBe('SourceName')
    expect(JSON.parse(row.extra ?? '{}').pinned).toBe(true)
  })

  it('same-field winner and equal-timestamp operationId tie-break', () => {
    insertTopicOn(srcSqlite, 't-tie')
    insertMessageOn(srcSqlite, 'm-tie', 't-tie', 'src-content')
    seedEntityClockOn(srcDb, 'topic', 't-tie', T, 'op-tie-t')
    seedEntityClockOn(srcDb, 'message', 'm-tie', T, 'op-mmm-high')
    seedFullFieldsOn(srcDb, 'topic', 't-tie', T, 'op-tie-t')
    // Message field clocks: content with high opId, rest with low.
    for (const f of MESSAGE_CLOCKED) {
      if (f === 'content') seedFieldClockOn(srcDb, 'message', 'm-tie', f, T, 'op-mmm-high')
      else seedFieldClockOn(srcDb, 'message', 'm-tie', f, T, 'op-mmm-high')
    }
    seedMembershipOn(srcDb, 'message', 'm-tie', 't-tie', T, 'op-mmm-high')
    seedBoundOn(srcSqlite)
    const candidate = captureLocalSyncBaselineCandidate(srcDb)
    expect(candidate.completeness.state).toBe('complete')

    insertTopicOn(dstSqlite, 't-tie')
    insertMessageOn(dstSqlite, 'm-tie', 't-tie', 'dst-content')
    seedEntityClockOn(dstDb, 'topic', 't-tie', T, 'op-tie-t')
    seedEntityClockOn(dstDb, 'message', 'm-tie', T, 'op-aaa-low')
    seedFullFieldsOn(dstDb, 'topic', 't-tie', T, 'op-tie-t')
    for (const f of MESSAGE_CLOCKED) {
      if (f === 'content') seedFieldClockOn(dstDb, 'message', 'm-tie', f, T, 'op-aaa-low')
      else seedFieldClockOn(dstDb, 'message', 'm-tie', f, T, 'op-aaa-low')
    }
    seedMembershipOn(dstDb, 'message', 'm-tie', 't-tie', T, 'op-mmm-high')
    const res = applyLocalSyncBaselineCandidate(dstDb, candidate)
    expect(res.updated).toBe(1)
    const row = dstSqlite.prepare('SELECT content FROM messages WHERE id=?').get('m-tie') as { content: string }
    expect(row.content).toBe('src-content')
  })

  it('missing/weak incoming loses without local regression', () => {
    insertTopicOn(srcSqlite, 't-weak')
    insertMessageOn(srcSqlite, 'm-weak', 't-weak', 'old-content')
    seedEntityClockOn(srcDb, 'topic', 't-weak', T, 'op-weak-t')
    seedEntityClockOn(srcDb, 'message', 'm-weak', T, 'op-weak-low')
    seedFullFieldsOn(srcDb, 'topic', 't-weak', T, 'op-weak-t')
    seedFullFieldsOn(srcDb, 'message', 'm-weak', T, 'op-weak-low')
    seedMembershipOn(srcDb, 'message', 'm-weak', 't-weak', T, 'op-weak-low')
    seedBoundOn(srcSqlite)
    const candidate = captureLocalSyncBaselineCandidate(srcDb)

    insertTopicOn(dstSqlite, 't-weak')
    insertMessageOn(dstSqlite, 'm-weak', 't-weak', 'new-content')
    seedEntityClockOn(dstDb, 'topic', 't-weak', T, 'op-weak-t2')
    seedEntityClockOn(dstDb, 'message', 'm-weak', T + 100, 'op-weak-high')
    seedFullFieldsOn(dstDb, 'topic', 't-weak', T, 'op-weak-t2')
    seedFullFieldsOn(dstDb, 'message', 'm-weak', T + 100, 'op-weak-high')
    seedMembershipOn(dstDb, 'message', 'm-weak', 't-weak', T, 'op-weak-low')
    const before = dstSqlite.prepare('SELECT content FROM messages WHERE id=?').get('m-weak') as { content: string }
    expect(before.content).toBe('new-content')
    const res = applyLocalSyncBaselineCandidate(dstDb, candidate)
    expect(res.updated).toBe(0)
    const after = dstSqlite.prepare('SELECT content FROM messages WHERE id=?').get('m-weak') as { content: string }
    expect(after.content).toBe('new-content')
    expect(res.suppressed).toBeGreaterThanOrEqual(1)
  })
})

describe('unversioned collision', () => {
  it('local unversioned differing collision fails and rolls back', () => {
    const candidate = seedCompleteSource('t-u', 'm-u', 'b-u')
    // Target has same message ID with different content but no clocks.
    insertTopicOn(dstSqlite, 't-u', 'Topic t-u')
    insertMessageOn(dstSqlite, 'm-u', 't-u', 'different-content')
    insertBlockOn(dstSqlite, 'b-u', 'm-u', 'body')
    const before = snapshotTarget()
    expect(() => applyLocalSyncBaselineCandidate(dstDb, candidate)).toThrow(/unversioned_local_collision/)
    expect(snapshotTarget()).toBe(before)
    expect(dstSqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-u')).toBeTruthy()
    // Source topic t-u would have been inserted/merged but rolled back: message still different.
    const row = dstSqlite.prepare('SELECT content FROM messages WHERE id=?').get('m-u') as { content: string }
    expect(row.content).toBe('different-content')
  })
})

describe('absence and tombstones', () => {
  it('absence does not delete local-only entities', () => {
    const candidate = seedCompleteSource('t-s', 'm-s', 'b-s')
    insertTopicOn(dstSqlite, 't-local-only')
    insertMessageOn(dstSqlite, 'm-local-only', 't-local-only', 'keep')
    const res = applyLocalSyncBaselineCandidate(dstDb, candidate)
    expect(res.inserted).toBe(3)
    expect(dstSqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-local-only')).toBeTruthy()
    expect(dstSqlite.prepare('SELECT id FROM messages WHERE id=?').get('m-local-only')).toBeTruthy()
  })

  it('explicit winning tombstone deletes with cascade and persists evidence', () => {
    // Target has full chain.
    insertTopicOn(dstSqlite, 't-del')
    insertMessageOn(dstSqlite, 'm-del', 't-del', 'hi')
    insertBlockOn(dstSqlite, 'b-del', 'm-del', 'body')
    seedEntityClockOn(dstDb, 'topic', 't-del', T, 'op-old-t')
    seedEntityClockOn(dstDb, 'message', 'm-del', T, 'op-old-m')
    seedEntityClockOn(dstDb, 'message_block', 'b-del', T, 'op-old-b')
    seedFullFieldsOn(dstDb, 'topic', 't-del', T, 'op-old-t')
    seedFullFieldsOn(dstDb, 'message', 'm-del', T, 'op-old-m')
    seedFullFieldsOn(dstDb, 'message_block', 'b-del', T, 'op-old-b')

    // Source: same IDs fully versioned plus winning topic tombstone.
    insertTopicOn(srcSqlite, 't-del')
    insertMessageOn(srcSqlite, 'm-del', 't-del', 'hi')
    insertBlockOn(srcSqlite, 'b-del', 'm-del', 'body')
    seedEntityClockOn(srcDb, 'topic', 't-del', T, 'op-src-t')
    seedEntityClockOn(srcDb, 'message', 'm-del', T, 'op-src-m')
    seedEntityClockOn(srcDb, 'message_block', 'b-del', T, 'op-src-b')
    seedFullFieldsOn(srcDb, 'topic', 't-del', T, 'op-src-t')
    seedFullFieldsOn(srcDb, 'message', 'm-del', T, 'op-src-m')
    seedFullFieldsOn(srcDb, 'message_block', 'b-del', T, 'op-src-b')
    seedMembershipOn(srcDb, 'message', 'm-del', 't-del', T, 'op-src-m')
    seedMembershipOn(srcDb, 'message_block', 'b-del', 'm-del', T, 'op-src-b')
    srcSqlite
      .prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)')
      .run('tombstone:topic:t-del', `${T + 100}:op-del-win`)
    seedBoundOn(srcSqlite)
    const candidate = captureLocalSyncBaselineCandidate(srcDb)
    expect(candidate.completeness.state).toBe('complete')
    const res = applyLocalSyncBaselineCandidate(dstDb, candidate)
    expect(res.deleted).toBeGreaterThanOrEqual(1)
    expect(dstSqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-del')).toBeUndefined()
    expect(dstSqlite.prepare('SELECT id FROM messages WHERE id=?').get('m-del')).toBeUndefined()
    // Tombstone evidence persisted.
    const tomb = dstSqlite.prepare('SELECT value FROM sync_state WHERE key=?').get('tombstone:topic:t-del') as {
      value: string
    }
    expect(tomb.value).toBe(`${T + 100}:op-del-win`)
    // Child containment tombstone inherited.
    const childTomb = dstSqlite.prepare('SELECT value FROM sync_state WHERE key=?').get('tombstone:message:m-del') as
      | { value: string }
      | undefined
    expect(childTomb?.value).toBe(`${T + 100}:op-del-win`)
  })

  it('losing tombstone does not delete and never regresses stronger local', () => {
    insertTopicOn(dstSqlite, 't-keep')
    seedEntityClockOn(dstDb, 'topic', 't-keep', T + 200, 'op-zzz-new')
    seedFullFieldsOn(dstDb, 'topic', 't-keep', T + 200, 'op-zzz-new')
    dstSqlite
      .prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)')
      .run('tombstone:topic:t-keep', `${T + 200}:op-zzz-new`)

    insertTopicOn(srcSqlite, 't-keep')
    seedEntityClockOn(srcDb, 'topic', 't-keep', T, 'op-old')
    seedFullFieldsOn(srcDb, 'topic', 't-keep', T, 'op-old')
    srcSqlite
      .prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)')
      .run('tombstone:topic:t-keep', `${T}:op-aaa-old`)
    seedBoundOn(srcSqlite)
    const candidate = captureLocalSyncBaselineCandidate(srcDb)
    const res = applyLocalSyncBaselineCandidate(dstDb, candidate)
    expect(dstSqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-keep')).toBeTruthy()
    const tomb = dstSqlite.prepare('SELECT value FROM sync_state WHERE key=?').get('tombstone:topic:t-keep') as {
      value: string
    }
    expect(tomb.value).toBe(`${T + 200}:op-zzz-new`)
    expect(res.deleted).toBe(0)
  })

  it('stale descendant covered by winning parent tombstone is suppressed, not inserted', () => {
    // Target has tombstoned parent, no rows.
    dstSqlite
      .prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)')
      .run('tombstone:topic:t-pdel', `${T + 100}:op-del-p`)

    // Source has parent live + child live + parent tombstone winning.
    insertTopicOn(srcSqlite, 't-pdel')
    insertMessageOn(srcSqlite, 'm-child', 't-pdel', 'stale')
    seedEntityClockOn(srcDb, 'topic', 't-pdel', T, 'op-p')
    seedEntityClockOn(srcDb, 'message', 'm-child', T, 'op-c-old')
    seedFullFieldsOn(srcDb, 'topic', 't-pdel', T, 'op-p')
    seedFullFieldsOn(srcDb, 'message', 'm-child', T, 'op-c-old')
    seedMembershipOn(srcDb, 'message', 'm-child', 't-pdel', T, 'op-c-old')
    srcSqlite
      .prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)')
      .run('tombstone:topic:t-pdel', `${T + 100}:op-del-p`)
    seedBoundOn(srcSqlite)
    const candidate = captureLocalSyncBaselineCandidate(srcDb)
    const res = applyLocalSyncBaselineCandidate(dstDb, candidate)
    expect(dstSqlite.prepare('SELECT id FROM messages WHERE id=?').get('m-child')).toBeUndefined()
    expect(res.inserted).toBe(0)
  })

  it('live+tombstone in same candidate resolves by versions, not array order', () => {
    // Live newer than tombstone => live wins.
    insertTopicOn(srcSqlite, 't-both')
    seedEntityClockOn(srcDb, 'topic', 't-both', T + 100, 'op-zzz-live')
    seedFullFieldsOn(srcDb, 'topic', 't-both', T + 100, 'op-zzz-live')
    srcSqlite
      .prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)')
      .run('tombstone:topic:t-both', `${T}:op-aaa-del`)
    seedBoundOn(srcSqlite)
    const winLive = captureLocalSyncBaselineCandidate(srcDb)
    const resLive = applyLocalSyncBaselineCandidate(dstDb, winLive)
    expect(dstSqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-both')).toBeTruthy()
    expect(resLive.deleted).toBe(0)

    // Reset target for opposite direction.
    dstSqlite.prepare('DELETE FROM topics WHERE id=?').run('t-both')
    dstSqlite.prepare('DELETE FROM sync_state WHERE key=?').run('tombstone:topic:t-both')
    dstSqlite.prepare('DELETE FROM sync_entity_clock WHERE entity_id=?').run('t-both')
    dstSqlite.prepare('DELETE FROM sync_field_clock WHERE entity_id=?').run('t-both')

    // Live older than tombstone => tombstone wins (no insert).
    const src2 = openInMemory()
    const db2 = drizzle(src2, { schema })
    runMigrations(db2 as any, src2)
    try {
      src2
        .prepare('INSERT INTO topics (id, name, created_at, updated_at, extra) VALUES (?,?,?,?,?)')
        .run('t-both2', 'T', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null)
      db2
        .insert(schema.syncEntityClock)
        .values({ entityType: 'topic', entityId: 't-both2', timestamp: T, operationId: 'op-aaa-live' })
        .run()
      for (const f of TOPIC_REQUIRED_CLOCKED)
        db2
          .insert(schema.syncFieldClock)
          .values({ entityType: 'topic', entityId: 't-both2', field: f, timestamp: T, operationId: 'op-aaa-live' })
          .run()
      src2
        .prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)')
        .run('tombstone:topic:t-both2', `${T + 100}:op-zzz-del`)
      src2.prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)').run('cursor', '7')
      src2.prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)').run('sync:channelKey', 'chan-1')
      const winDel = captureLocalSyncBaselineCandidate(db2)
      const resDel = applyLocalSyncBaselineCandidate(dstDb, winDel)
      expect(dstSqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-both2')).toBeUndefined()
      expect(resDel.deleted).toBe(0)
      const tomb = dstSqlite.prepare('SELECT value FROM sync_state WHERE key=?').get('tombstone:topic:t-both2') as {
        value: string
      }
      expect(tomb.value).toBe(`${T + 100}:op-zzz-del`)
    } finally {
      try {
        src2.close()
      } catch {}
    }
  })
})

describe('immutable reparent', () => {
  it('reparent attempt fails and rolls back', () => {
    const candidate = seedCompleteSource('t-a', 'm-r', 'b-r')
    insertTopicOn(dstSqlite, 't-a', 'Topic t-a')
    insertTopicOn(dstSqlite, 't-other', 'Other')
    insertMessageOn(dstSqlite, 'm-r', 't-other', 'hello')
    seedEntityClockOn(dstDb, 'topic', 't-a', T, 'op-a')
    seedEntityClockOn(dstDb, 'topic', 't-other', T, 'op-other')
    seedEntityClockOn(dstDb, 'message', 'm-r', T, 'op-m')
    seedFullFieldsOn(dstDb, 'topic', 't-a', T, 'op-a')
    seedFullFieldsOn(dstDb, 'topic', 't-other', T, 'op-other')
    seedFullFieldsOn(dstDb, 'message', 'm-r', T, 'op-m')
    const before = snapshotTarget()
    expect(() => applyLocalSyncBaselineCandidate(dstDb, candidate)).toThrow(/immutable|parent mismatch/)
    expect(snapshotTarget()).toBe(before)
  })
})

describe('candidate validation fails closed', () => {
  it('incomplete/partial/unbound/tampered/wrong-version/duplicate/malformed fail without mutation', () => {
    const valid = seedCompleteSource('t-v', 'm-v', 'b-v')
    const before = snapshotTarget()

    // Partial: pending outbox on source.
    srcSqlite
      .prepare(
        'INSERT INTO sync_outbox (id, entity_type, op, entity_id, timestamp, device_id, payload_json, created_at) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run('op-pending', 'message', 'upsert', 'm-v', T, 'd1', null, '2026-01-01T00:00:00.000Z')
    const partial = captureLocalSyncBaselineCandidate(srcDb)
    expect(partial.completeness.state).toBe('partial')
    expect(() => applyLocalSyncBaselineCandidate(dstDb, partial)).toThrow(SyncBaselineApplyError)
    expect(snapshotTarget()).toBe(before)
    srcSqlite.prepare('DELETE FROM sync_outbox WHERE id=?').run('op-pending')

    // Unbound: remove watermark.
    srcSqlite.prepare('DELETE FROM sync_state WHERE key=?').run('cursor')
    const unbound = captureLocalSyncBaselineCandidate(srcDb)
    expect(unbound.completeness.state).toBe('unbound')
    expect(() => applyLocalSyncBaselineCandidate(dstDb, unbound)).toThrow(SyncBaselineApplyError)
    expect(snapshotTarget()).toBe(before)
    seedBoundOn(srcSqlite)

    // Tampered: mutate payload without digest refresh.
    const tampered = cloneCandidate(valid)
    const tEnt = tampered.entities.find((e) => e.entityId === 'm-v')
    tEnt!.payload.content = 'evil'
    expect(() => applyLocalSyncBaselineCandidate(dstDb, tampered)).toThrow(/digest/)
    expect(snapshotTarget()).toBe(before)

    // Wrong version.
    const wrongKind = cloneCandidate(valid)
    wrongKind.kind = 'wrong-kind'
    refreshDigest(wrongKind)
    expect(() => applyLocalSyncBaselineCandidate(dstDb, wrongKind)).toThrow(/kind/)
    expect(snapshotTarget()).toBe(before)

    const wrongSchema = cloneCandidate(valid)
    wrongSchema.schemaVersion = 'wrong-schema'
    refreshDigest(wrongSchema)
    expect(() => applyLocalSyncBaselineCandidate(dstDb, wrongSchema)).toThrow(/schema/)
    expect(snapshotTarget()).toBe(before)

    // Duplicate entity.
    const dup = cloneCandidate(valid)
    dup.entities.push(JSON.parse(JSON.stringify(dup.entities[0])))
    refreshCountsAndDigest(dup)
    expect(() => applyLocalSyncBaselineCandidate(dstDb, dup)).toThrow(/duplicate/)
    expect(snapshotTarget()).toBe(before)

    // Malformed: missing field clock.
    const missingFc = cloneCandidate(valid)
    const mEnt = missingFc.entities.find((e) => e.entityType === 'message')
    mEnt!.fieldClocks = mEnt!.fieldClocks.filter((fc) => fc.field !== 'content')
    refreshDigest(missingFc)
    expect(() => applyLocalSyncBaselineCandidate(dstDb, missingFc)).toThrow(/field clock/)
    expect(snapshotTarget()).toBe(before)

    // Malformed: orphan message (inserted in deterministic candidate order).
    const orphan = cloneCandidate(valid)
    orphan.entities.push({
      entityType: 'message',
      entityId: 'm-orphan-x',
      payload: {
        id: 'm-orphan-x',
        topicId: 't-missing-x',
        role: 'user',
        content: 'x',
        status: 'success',
        askId: null,
        model: null,
        modelId: null,
        assistantId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        sortOrder: 0
      },
      entityClock: { timestamp: T, operationId: 'op-orphan' },
      fieldClocks: MESSAGE_CLOCKED.map((field) => ({ field, timestamp: T, operationId: 'op-orphan' })),
      parentMembershipClock: { timestamp: T, operationId: 'op-orphan' }
    })
    orphan.entities.sort((a, b) => {
      const order: Record<string, number> = { topic: 0, message: 1, message_block: 2 }
      const p = order[a.entityType] - order[b.entityType]
      if (p !== 0) return p
      return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0
    })
    refreshCountsAndDigest(orphan)
    expect(() => applyLocalSyncBaselineCandidate(dstDb, orphan)).toThrow(/orphan/)
    expect(snapshotTarget()).toBe(before)

    // Malformed: unsupported block type.
    const unsup = cloneCandidate(valid)
    const bEnt = unsup.entities.find((e) => e.entityType === 'message_block')
    bEnt!.payload.type = 'tool'
    refreshDigest(unsup)
    expect(() => applyLocalSyncBaselineCandidate(dstDb, unsup)).toThrow(/unsupported/)
    expect(snapshotTarget()).toBe(before)
  })

  it('tampered null/missing membership with recomputed digest still fails closed and leaves target unchanged', () => {
    const valid = seedCompleteSource('t-v2', 'm-v2', 'b-v2')
    const before = snapshotTarget()
    // Null membership but claims complete & zero missing with self-consistent digest
    const nullMembership = cloneCandidate(valid)
    const mEnt2 = nullMembership.entities.find((e) => e.entityType === 'message')!
    ;(mEnt2 as unknown as Record<string, unknown>).parentMembershipClock = null
    // Keep manifest claiming complete/zero but recompute digest to be self-consistent
    nullMembership.manifest.unversionedMembershipCount = 0
    nullMembership.manifest.completenessState = 'complete' as unknown as string as any
    nullMembership.manifest.completenessReasons = []
    nullMembership.completeness.state = 'complete' as unknown as string as any
    nullMembership.completeness.reasons = []
    refreshDigest(nullMembership)
    expect(() => applyLocalSyncBaselineCandidate(dstDb, nullMembership)).toThrow(/membership/)
    expect(snapshotTarget()).toBe(before)

    // Missing key variant
    const missingMembership = cloneCandidate(valid)
    const mEnt3 = missingMembership.entities.find((e) => e.entityType === 'message')! as unknown as Record<
      string,
      unknown
    >
    delete mEnt3['parentMembershipClock']
    missingMembership.manifest.unversionedMembershipCount = 0
    missingMembership.manifest.completenessState = 'complete' as unknown as string as any
    missingMembership.manifest.completenessReasons = []
    missingMembership.completeness.state = 'complete' as unknown as string as any
    missingMembership.completeness.reasons = []
    refreshDigest(missingMembership)
    expect(() => applyLocalSyncBaselineCandidate(dstDb, missingMembership)).toThrow(/membership/)
    expect(snapshotTarget()).toBe(before)

    // Count mismatch: manifest says zero but computed missing is 1
    const countMismatch = cloneCandidate(valid)
    const mEnt4 = countMismatch.entities.find((e) => e.entityType === 'message')!
    ;(mEnt4 as unknown as Record<string, unknown>).parentMembershipClock = null
    countMismatch.manifest.unversionedMembershipCount = 0
    // recompute digest so digest matches tampered manifest, but structural check recomputes missing
    refreshDigest(countMismatch)
    // Even though manifest says 0, validator recomputes and finds mismatch
    expect(() => applyLocalSyncBaselineCandidate(dstDb, countMismatch)).toThrow(/membership/)
    expect(snapshotTarget()).toBe(before)
  })
})

describe('preservation', () => {
  it('preserves outbox, applied, cursor/channel and unrelated sync_state; creates no outbox', () => {
    const candidate = seedCompleteSource('t-p', 'm-p', 'b-p')
    // Target intent/bookkeeping.
    dstSqlite
      .prepare(
        'INSERT INTO sync_outbox (id, entity_type, op, entity_id, timestamp, device_id, payload_json, created_at) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run(
        'op-local-1',
        'message',
        'upsert',
        'm-local',
        T,
        'd-local',
        JSON.stringify({ secret: 'outbox-secret' }),
        '2026-01-01T00:00:00.000Z'
      )
    dstDb
      .insert(schema.syncApplied)
      .values({ operationId: 'op-applied-1', appliedAt: '2026-01-01T00:00:00.000Z' })
      .run()
    dstSqlite.prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)').run('cursor', '42')
    dstSqlite.prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)').run('sync:channelKey', 'chan-keep')
    dstSqlite.prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)').run('lastError', 'keep-me')
    dstDb
      .insert(schema.syncConflictLog)
      .values({
        id: 'conf-keep',
        entityType: 'message',
        entityId: 'm-p',
        field: 'content',
        loserValueJson: '"old"',
        loserTimestamp: T,
        loserOperationId: 'op-old',
        winnerTimestamp: T + 1,
        winnerOperationId: 'op-new',
        createdAt: '2026-01-01T00:00:00.000Z'
      })
      .run()
    const beforeOutbox = dstSqlite.prepare('SELECT * FROM sync_outbox ORDER BY id').all()
    const beforeApplied = dstSqlite.prepare('SELECT * FROM sync_applied ORDER BY operation_id').all()
    const beforeCursor = dstSqlite.prepare('SELECT value FROM sync_state WHERE key=?').get('cursor')
    const beforeChannel = dstSqlite.prepare('SELECT value FROM sync_state WHERE key=?').get('sync:channelKey')
    const beforeLastError = dstSqlite.prepare('SELECT value FROM sync_state WHERE key=?').get('lastError')
    const beforeConflicts = dstSqlite.prepare('SELECT * FROM sync_conflict_log ORDER BY id').all()

    const res = applyLocalSyncBaselineCandidate(dstDb, candidate)
    expect(res.inserted).toBe(3)
    expect(JSON.stringify(dstSqlite.prepare('SELECT * FROM sync_outbox ORDER BY id').all())).toBe(
      JSON.stringify(beforeOutbox)
    )
    expect(JSON.stringify(dstSqlite.prepare('SELECT * FROM sync_applied ORDER BY operation_id').all())).toBe(
      JSON.stringify(beforeApplied)
    )
    expect(JSON.stringify(dstSqlite.prepare('SELECT value FROM sync_state WHERE key=?').get('cursor'))).toBe(
      JSON.stringify(beforeCursor)
    )
    expect(JSON.stringify(dstSqlite.prepare('SELECT value FROM sync_state WHERE key=?').get('sync:channelKey'))).toBe(
      JSON.stringify(beforeChannel)
    )
    expect(JSON.stringify(dstSqlite.prepare('SELECT value FROM sync_state WHERE key=?').get('lastError'))).toBe(
      JSON.stringify(beforeLastError)
    )
    expect(JSON.stringify(dstSqlite.prepare('SELECT * FROM sync_conflict_log ORDER BY id').all())).toBe(
      JSON.stringify(beforeConflicts)
    )
    expect(outboxCount()).toBe(1)
    // Outbox payload preserved byte-identical (contains secret, never leaked into result).
    const outboxRow = dstSqlite.prepare('SELECT payload_json FROM sync_outbox WHERE id=?').get('op-local-1') as {
      payload_json: string
    }
    expect(outboxRow.payload_json).toContain('outbox-secret')
  })
})

describe('idempotence', () => {
  it('second apply yields same rows/metadata with no logical changes', () => {
    const candidate = seedCompleteSource('t-i', 'm-i', 'b-i')
    const first = applyLocalSyncBaselineCandidate(dstDb, candidate)
    expect(first.inserted).toBe(3)
    const afterFirst = snapshotTarget()
    const second = applyLocalSyncBaselineCandidate(dstDb, candidate)
    expect(second.inserted).toBe(0)
    expect(second.updated).toBe(0)
    expect(second.deleted).toBe(0)
    expect(snapshotTarget()).toBe(afterFirst)
  })
})

describe('mid-transaction rollback', () => {
  it('first insert rolls back when a later entity fails (reparent)', () => {
    // Source candidate: new topic t-new (insertable) + message m-conflict that will reparent-fail.
    insertTopicOn(srcSqlite, 't-new')
    insertTopicOn(srcSqlite, 't-src-parent')
    insertMessageOn(srcSqlite, 'm-conflict', 't-src-parent', 'src')
    insertBlockOn(srcSqlite, 'b-new', 'm-conflict', 'body')
    for (const [type, id] of [
      ['topic', 't-new'],
      ['topic', 't-src-parent'],
      ['message', 'm-conflict'],
      ['message_block', 'b-new']
    ] as const) {
      seedEntityClockOn(srcDb, type, id, T, `op-${id}`)
      seedFullFieldsOn(srcDb, type, id, T, `op-${id}`)
    }
    seedMembershipOn(srcDb, 'message', 'm-conflict', 't-src-parent', T, 'op-m-conflict')
    seedMembershipOn(srcDb, 'message_block', 'b-new', 'm-conflict', T, 'op-b-new')
    seedBoundOn(srcSqlite)
    const candidate = captureLocalSyncBaselineCandidate(srcDb)
    expect(candidate.completeness.state).toBe('complete')

    // Target: same message ID under a different parent with trustworthy clocks.
    insertTopicOn(dstSqlite, 't-dst-parent')
    insertMessageOn(dstSqlite, 'm-conflict', 't-dst-parent', 'dst')
    seedEntityClockOn(dstDb, 'topic', 't-dst-parent', T, 'op-dst-parent')
    seedEntityClockOn(dstDb, 'message', 'm-conflict', T, 'op-dst-m')
    seedFullFieldsOn(dstDb, 'topic', 't-dst-parent', T, 'op-dst-parent')
    seedFullFieldsOn(dstDb, 'message', 'm-conflict', T, 'op-dst-m')
    seedMembershipOn(dstDb, 'message', 'm-conflict', 't-dst-parent', T, 'op-dst-m')
    const before = snapshotTarget()
    expect(() => applyLocalSyncBaselineCandidate(dstDb, candidate)).toThrow(
      /immutable|parent mismatch|membership parent conflict/
    )
    expect(snapshotTarget()).toBe(before)
    expect(dstSqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-new')).toBeUndefined()
  })

  it('earlier membership/entity writes roll back when later membership clock conflicts', () => {
    // Source: two topics + two messages, lexical order ensures m-aaa writes before m-zzz.
    insertTopicOn(srcSqlite, 't-aaa')
    insertTopicOn(srcSqlite, 't-zzz')
    insertMessageOn(srcSqlite, 'm-aaa', 't-aaa', 'hello-aaa')
    insertMessageOn(srcSqlite, 'm-zzz', 't-zzz', 'hello-zzz')
    for (const [type, id] of [
      ['topic', 't-aaa'],
      ['topic', 't-zzz'],
      ['message', 'm-aaa'],
      ['message', 'm-zzz']
    ] as const) {
      seedEntityClockOn(srcDb, type, id, T, `op-${id}`)
      seedFullFieldsOn(srcDb, type, id, T, `op-${id}`)
    }
    seedMembershipOn(srcDb, 'message', 'm-aaa', 't-aaa', T, 'op-m-aaa')
    seedMembershipOn(srcDb, 'message', 'm-zzz', 't-zzz', T + 100, 'op-m-zzz-new')
    seedBoundOn(srcSqlite)
    const candidate = captureLocalSyncBaselineCandidate(srcDb)
    expect(candidate.completeness.state).toBe('complete')

    // Target: pre-seed m-zzz with same parent but different clock (exact tuple conflict)
    insertTopicOn(dstSqlite, 't-zzz')
    insertMessageOn(dstSqlite, 'm-zzz', 't-zzz', 'hello-zzz')
    seedEntityClockOn(dstDb, 'topic', 't-zzz', T, 'op-t-zzz')
    seedEntityClockOn(dstDb, 'message', 'm-zzz', T, 'op-m-zzz-old')
    seedFullFieldsOn(dstDb, 'topic', 't-zzz', T, 'op-t-zzz')
    seedFullFieldsOn(dstDb, 'message', 'm-zzz', T, 'op-m-zzz-old')
    seedMembershipOn(dstDb, 'message', 'm-zzz', 't-zzz', T, 'op-m-zzz-old')
    const before = snapshotTarget()
    expect(() => applyLocalSyncBaselineCandidate(dstDb, candidate)).toThrow(/membership clock conflict/)
    expect(snapshotTarget()).toBe(before)
    // Earlier entity m-aaa and its membership must have been rolled back
    expect(dstSqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-aaa')).toBeUndefined()
    expect(dstSqlite.prepare('SELECT id FROM messages WHERE id=?').get('m-aaa')).toBeUndefined()
    expect(
      dstSqlite.prepare('SELECT child_entity_id FROM sync_membership_clock WHERE child_entity_id=?').get('m-aaa')
    ).toBeUndefined()
    // Original membership for m-zzz preserved
    const row = dstSqlite
      .prepare('SELECT operation_id as op FROM sync_membership_clock WHERE child_entity_id=?')
      .get('m-zzz') as { op: string }
    expect(row.op).toBe('op-m-zzz-old')
  })
})

describe('F1 canonical full payload', () => {
  it('rejects removed required fields for topic/message/block without mutation', () => {
    const valid = seedCompleteSource('t-f1', 'm-f1', 'b-f1')
    const before = snapshotTarget()

    const missingTopicName = cloneCandidate(valid)
    const tEnt = missingTopicName.entities.find((e) => e.entityType === 'topic')!
    delete tEnt.payload.name
    tEnt.fieldClocks = tEnt.fieldClocks.filter((fc) => fc.field !== 'name')
    refreshDigest(missingTopicName)
    expect(() => applyLocalSyncBaselineCandidate(dstDb, missingTopicName)).toThrow(/missing required topic field/)
    expect(snapshotTarget()).toBe(before)

    const missingMsgContent = cloneCandidate(valid)
    const mEnt = missingMsgContent.entities.find((e) => e.entityType === 'message')!
    delete mEnt.payload.content
    mEnt.fieldClocks = mEnt.fieldClocks.filter((fc) => fc.field !== 'content')
    refreshDigest(missingMsgContent)
    expect(() => applyLocalSyncBaselineCandidate(dstDb, missingMsgContent)).toThrow(
      /missing required message field|field count mismatch/
    )
    expect(snapshotTarget()).toBe(before)

    const missingBlockType = cloneCandidate(valid)
    const bEnt = missingBlockType.entities.find((e) => e.entityType === 'message_block')!
    delete bEnt.payload.type
    bEnt.fieldClocks = bEnt.fieldClocks.filter((fc) => fc.field !== 'type')
    refreshDigest(missingBlockType)
    expect(() => applyLocalSyncBaselineCandidate(dstDb, missingBlockType)).toThrow(
      /missing required block field|field count mismatch/
    )
    expect(snapshotTarget()).toBe(before)
  })

  it('rejects unexpected fields and invalid null/type shapes', () => {
    const valid = seedCompleteSource('t-f1e', 'm-f1e', 'b-f1e')
    const before = snapshotTarget()

    const unexpected = cloneCandidate(valid)
    const tEnt = unexpected.entities.find((e) => e.entityType === 'topic')!
    tEnt.payload.evil = 'x'
    refreshDigest(unexpected)
    expect(() => applyLocalSyncBaselineCandidate(dstDb, unexpected)).toThrow(/unexpected|allowlisted/)
    expect(snapshotTarget()).toBe(before)

    const badType = cloneCandidate(valid)
    const tBad = badType.entities.find((e) => e.entityType === 'topic')!
    // Make optional pinned present with wrong type.
    tBad.payload.pinned = 'evil-string'
    // Ensure clock exists for pinned to isolate type failure (add clock, refresh).
    if (!tBad.fieldClocks.some((fc) => fc.field === 'pinned')) {
      tBad.fieldClocks.push({ field: 'pinned', timestamp: T, operationId: 'op-s-t' })
      tBad.fieldClocks.sort((a, b) => (a.field < b.field ? -1 : 1))
    }
    refreshDigest(badType)
    expect(() => applyLocalSyncBaselineCandidate(dstDb, badType)).toThrow(/invalid topic pinned|shape rejected/)
    expect(snapshotTarget()).toBe(before)

    const badSort = cloneCandidate(valid)
    const mBad = badSort.entities.find((e) => e.entityType === 'message')!
    mBad.payload.sortOrder = 'evil'
    refreshDigest(badSort)
    expect(() => applyLocalSyncBaselineCandidate(dstDb, badSort)).toThrow(/invalid message sortOrder|shape rejected/)
    expect(snapshotTarget()).toBe(before)

    const nullSort = cloneCandidate(valid)
    const bBad = nullSort.entities.find((e) => e.entityType === 'message_block')!
    bBad.payload.sortOrder = null
    refreshDigest(nullSort)
    expect(() => applyLocalSyncBaselineCandidate(dstDb, nullSort)).toThrow(/invalid block sortOrder|shape rejected/)
    expect(snapshotTarget()).toBe(before)
  })

  it('proves optional topic overflow rule: absent means null/no-overflow, present requires clock', () => {
    // Source with pinned present.
    insertTopicOn(srcSqlite, 't-opt', 'Opt', { pinned: true, prompt: 'p' })
    insertMessageOn(srcSqlite, 'm-opt', 't-opt')
    insertBlockOn(srcSqlite, 'b-opt', 'm-opt')
    seedEntityClockOn(srcDb, 'topic', 't-opt', T, 'op-opt-t')
    seedEntityClockOn(srcDb, 'message', 'm-opt', T, 'op-opt-m')
    seedEntityClockOn(srcDb, 'message_block', 'b-opt', T, 'op-opt-b')
    seedFullFieldsOn(srcDb, 'topic', 't-opt', T, 'op-opt-t', ['pinned', 'prompt'])
    seedFullFieldsOn(srcDb, 'message', 'm-opt', T, 'op-opt-m')
    seedFullFieldsOn(srcDb, 'message_block', 'b-opt', T, 'op-opt-b')
    seedMembershipOn(srcDb, 'message', 'm-opt', 't-opt', T, 'op-opt-m')
    seedMembershipOn(srcDb, 'message_block', 'b-opt', 'm-opt', T, 'op-opt-b')
    seedBoundOn(srcSqlite)
    const withOpt = captureLocalSyncBaselineCandidate(srcDb)
    expect(withOpt.completeness.state).toBe('complete')
    const tPayload = withOpt.entities.find((e) => e.entityId === 't-opt')!.payload
    expect(tPayload.pinned).toBe(true)
    expect(tPayload.prompt).toBe('p')
    expect(Object.prototype.hasOwnProperty.call(tPayload, 'isNameManuallyEdited')).toBe(false)
    // Extra clock for absent optional fails.
    const extraClock = cloneCandidate(withOpt)
    const tExtra = extraClock.entities.find((e) => e.entityId === 't-opt')!
    tExtra.fieldClocks.push({ field: 'isNameManuallyEdited', timestamp: T, operationId: 'op-opt-t' })
    tExtra.fieldClocks.sort((a, b) => (a.field < b.field ? -1 : 1))
    refreshDigest(extraClock)
    const before = snapshotTarget()
    expect(() => applyLocalSyncBaselineCandidate(dstDb, extraClock)).toThrow(/without payload field/)
    expect(snapshotTarget()).toBe(before)
    // Valid applies with overflow mapping preserved.
    const res = applyLocalSyncBaselineCandidate(dstDb, withOpt)
    expect(res.inserted).toBe(3)
    const row = dstSqlite.prepare('SELECT extra FROM topics WHERE id=?').get('t-opt') as { extra: string | null }
    const overflow = JSON.parse(row.extra ?? '{}') as Record<string, unknown>
    expect(overflow.pinned).toBe(true)
    expect(overflow.prompt).toBe('p')
    expect(Object.prototype.hasOwnProperty.call(overflow, 'isNameManuallyEdited')).toBe(false)
  })
})

describe('F2 unversioned tombstone targets', () => {
  it.each([
    ['topic', 't-vt'],
    ['message', 'm-vt'],
    ['message_block', 'b-vt']
  ])('unversioned live %s targeted by tombstone rejects and rolls back prior writes', (kind, victimId) => {
    // Source: insertable t-new plus tombstone for victim (no live victim in source).
    insertTopicOn(srcSqlite, 't-new-f2')
    seedEntityClockOn(srcDb, 'topic', 't-new-f2', T, 'op-new-f2')
    seedFullFieldsOn(srcDb, 'topic', 't-new-f2', T, 'op-new-f2')
    const tombKey =
      kind === 'topic'
        ? `tombstone:topic:${victimId}`
        : kind === 'message'
          ? `tombstone:message:${victimId}`
          : `tombstone:message_block:${victimId}`
    srcSqlite.prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)').run(tombKey, `${T + 100}:op-del-f2`)
    // Source needs at least one live for complete; t-new suffices if no other lives.
    // For message/block victims, source live set must still be parent-closed: use t-new only (topic).
    seedBoundOn(srcSqlite)
    const candidate = captureLocalSyncBaselineCandidate(srcDb)
    expect(candidate.completeness.state).toBe('complete')
    expect(candidate.tombstones.some((t) => t.entityId === victimId)).toBe(true)

    // Target: unversioned live victim plus parent chain as needed.
    if (kind === 'topic') {
      insertTopicOn(dstSqlite, victimId)
    } else if (kind === 'message') {
      insertTopicOn(dstSqlite, 't-parent-f2')
      insertMessageOn(dstSqlite, victimId, 't-parent-f2', 'victim')
    } else {
      insertTopicOn(dstSqlite, 't-parent-f2b')
      insertMessageOn(dstSqlite, 'm-parent-f2b', 't-parent-f2b', 'p')
      insertBlockOn(dstSqlite, victimId, 'm-parent-f2b', 'victim')
    }
    const before = snapshotTarget()
    expect(() => applyLocalSyncBaselineCandidate(dstDb, candidate)).toThrow(/unversioned_local_collision for tombstone/)
    expect(snapshotTarget()).toBe(before)
    expect(dstSqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-new-f2')).toBeUndefined()
  })
})

describe('F3 missing field clock with entity clock', () => {
  it('differing value without local field clock rejects and rolls back', () => {
    insertTopicOn(srcSqlite, 't-f3')
    insertMessageOn(srcSqlite, 'm-f3', 't-f3', 'src-content')
    seedEntityClockOn(srcDb, 'topic', 't-f3', T, 'op-f3-t')
    seedEntityClockOn(srcDb, 'message', 'm-f3', T + 10, 'op-f3-m')
    seedFullFieldsOn(srcDb, 'topic', 't-f3', T, 'op-f3-t')
    seedFullFieldsOn(srcDb, 'message', 'm-f3', T + 10, 'op-f3-m')
    seedMembershipOn(srcDb, 'message', 'm-f3', 't-f3', T + 10, 'op-f3-m')
    seedBoundOn(srcSqlite)
    const candidate = captureLocalSyncBaselineCandidate(srcDb)
    expect(candidate.completeness.state).toBe('complete')

    insertTopicOn(dstSqlite, 't-f3')
    insertMessageOn(dstSqlite, 'm-f3', 't-f3', 'dst-different')
    seedEntityClockOn(dstDb, 'topic', 't-f3', T, 'op-f3-t2')
    seedEntityClockOn(dstDb, 'message', 'm-f3', T + 5, 'op-f3-m2')
    seedFullFieldsOn(dstDb, 'topic', 't-f3', T, 'op-f3-t2')
    seedMembershipOn(dstDb, 'message', 'm-f3', 't-f3', T + 10, 'op-f3-m')
    // Target message has entity clock but missing content field clock (seed all except content).
    for (const f of MESSAGE_CLOCKED) {
      if (f === 'content') continue
      seedFieldClockOn(dstDb, 'message', 'm-f3', f, T + 5, 'op-f3-m2')
    }
    // Also seed an insertable prior entity to prove rollback: candidate inserts t-new? Use separate candidate with extra insert.
    const before = snapshotTarget()
    expect(() => applyLocalSyncBaselineCandidate(dstDb, candidate)).toThrow(
      /unversioned_local_collision for message\/m-f3\/content/
    )
    expect(snapshotTarget()).toBe(before)
    const row = dstSqlite.prepare('SELECT content FROM messages WHERE id=?').get('m-f3') as { content: string }
    expect(row.content).toBe('dst-different')
  })

  it('equal value without local field clock installs clock with no logical update', () => {
    insertTopicOn(srcSqlite, 't-f3e')
    insertMessageOn(srcSqlite, 'm-f3e', 't-f3e', 'same-content')
    seedEntityClockOn(srcDb, 'topic', 't-f3e', T, 'op-f3e-t')
    seedEntityClockOn(srcDb, 'message', 'm-f3e', T + 10, 'op-f3e-m')
    seedFullFieldsOn(srcDb, 'topic', 't-f3e', T, 'op-f3e-t')
    seedFullFieldsOn(srcDb, 'message', 'm-f3e', T + 10, 'op-f3e-m')
    seedMembershipOn(srcDb, 'message', 'm-f3e', 't-f3e', T + 10, 'op-f3e-m')
    seedBoundOn(srcSqlite)
    const candidate = captureLocalSyncBaselineCandidate(srcDb)

    insertTopicOn(dstSqlite, 't-f3e')
    insertMessageOn(dstSqlite, 'm-f3e', 't-f3e', 'same-content')
    seedEntityClockOn(dstDb, 'topic', 't-f3e', T, 'op-f3e-t2')
    seedEntityClockOn(dstDb, 'message', 'm-f3e', T + 5, 'op-f3e-m2')
    seedFullFieldsOn(dstDb, 'topic', 't-f3e', T, 'op-f3e-t2')
    seedMembershipOn(dstDb, 'message', 'm-f3e', 't-f3e', T + 10, 'op-f3e-m')
    for (const f of MESSAGE_CLOCKED) {
      if (f === 'content') continue
      seedFieldClockOn(dstDb, 'message', 'm-f3e', f, T + 5, 'op-f3e-m2')
    }
    expect(
      dstSqlite.prepare('SELECT * FROM sync_field_clock WHERE entity_id=? AND field=?').get('m-f3e', 'content')
    ).toBeUndefined()
    const res = applyLocalSyncBaselineCandidate(dstDb, candidate)
    expect(res.updated).toBe(0)
    expect(res.inserted).toBe(0)
    expect(res.deleted).toBe(0)
    const row = dstSqlite.prepare('SELECT content FROM messages WHERE id=?').get('m-f3e') as { content: string }
    expect(row.content).toBe('same-content')
    const installed = dstSqlite
      .prepare('SELECT timestamp, operation_id FROM sync_field_clock WHERE entity_id=? AND field=?')
      .get('m-f3e', 'content') as { timestamp: number; operation_id: string }
    expect(installed.timestamp).toBe(T + 10)
    expect(installed.operation_id).toBe('op-f3e-m')
  })
})

describe('F4 persisted fields and authoritative delete coverage', () => {
  it('verifies all inserted topic/message/block fields and overflow mappings', () => {
    insertTopicOn(srcSqlite, 't-full', 'Full Name', {
      pinned: true,
      prompt: 'hello-prompt',
      isNameManuallyEdited: true
    })
    srcSqlite
      .prepare('UPDATE topics SET assistant_id=?, created_at=?, updated_at=?, deleted_at=? WHERE id=?')
      .run('asst-1', '2026-03-01T00:00:00.000Z', '2026-03-02T00:00:00.000Z', null, 't-full')
    insertMessageOn(srcSqlite, 'm-full', 't-full', 'msg-body')
    srcSqlite
      .prepare(
        'UPDATE messages SET role=?, status=?, ask_id=?, model=?, model_id=?, assistant_id=?, created_at=?, updated_at=?, sort_order=? WHERE id=?'
      )
      .run(
        'assistant',
        'success',
        'ask-1',
        'mod',
        'mod-1',
        'asst-1',
        '2026-03-01T00:00:00.000Z',
        '2026-03-02T00:00:00.000Z',
        7,
        'm-full'
      )
    insertBlockOn(srcSqlite, 'b-full', 'm-full', 'block-body')
    srcSqlite
      .prepare('UPDATE message_blocks SET type=?, status=?, created_at=?, updated_at=?, sort_order=? WHERE id=?')
      .run('main_text', 'success', '2026-03-01T00:00:00.000Z', '2026-03-02T00:00:00.000Z', 3, 'b-full')
    seedEntityClockOn(srcDb, 'topic', 't-full', T, 'op-full-t')
    seedEntityClockOn(srcDb, 'message', 'm-full', T, 'op-full-m')
    seedEntityClockOn(srcDb, 'message_block', 'b-full', T, 'op-full-b')
    seedFullFieldsOn(srcDb, 'topic', 't-full', T, 'op-full-t', ['pinned', 'prompt', 'isNameManuallyEdited'])
    seedFullFieldsOn(srcDb, 'message', 'm-full', T, 'op-full-m')
    seedFullFieldsOn(srcDb, 'message_block', 'b-full', T, 'op-full-b')
    seedMembershipOn(srcDb, 'message', 'm-full', 't-full', T, 'op-full-m')
    seedMembershipOn(srcDb, 'message_block', 'b-full', 'm-full', T, 'op-full-b')
    seedBoundOn(srcSqlite)
    const candidate = captureLocalSyncBaselineCandidate(srcDb)
    expect(candidate.completeness.state).toBe('complete')
    const res = applyLocalSyncBaselineCandidate(dstDb, candidate)
    expect(res.inserted).toBe(3)
    const tRow = dstSqlite
      .prepare('SELECT id, name, assistant_id, created_at, updated_at, deleted_at, extra FROM topics WHERE id=?')
      .get('t-full') as Record<string, unknown>
    expect(tRow.id).toBe('t-full')
    expect(tRow.name).toBe('Full Name')
    expect(tRow.assistant_id).toBe('asst-1')
    expect(tRow.created_at).toBe('2026-03-01T00:00:00.000Z')
    expect(tRow.updated_at).toBe('2026-03-02T00:00:00.000Z')
    expect(tRow.deleted_at).toBeNull()
    const tExtra = JSON.parse((tRow.extra as string) ?? '{}') as Record<string, unknown>
    expect(tExtra.pinned).toBe(true)
    expect(tExtra.prompt).toBe('hello-prompt')
    expect(tExtra.isNameManuallyEdited).toBe(true)
    const mRow = dstSqlite
      .prepare(
        'SELECT id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra FROM messages WHERE id=?'
      )
      .get('m-full') as Record<string, unknown>
    expect(mRow).toMatchObject({
      id: 'm-full',
      topic_id: 't-full',
      role: 'assistant',
      content: 'msg-body',
      status: 'success',
      ask_id: 'ask-1',
      model: 'mod',
      model_id: 'mod-1',
      assistant_id: 'asst-1',
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-02T00:00:00.000Z',
      sort_order: 7,
      extra: null
    })
    const bRow = dstSqlite
      .prepare(
        'SELECT id, message_id, type, content, status, created_at, updated_at, sort_order, extra FROM message_blocks WHERE id=?'
      )
      .get('b-full') as Record<string, unknown>
    expect(bRow).toMatchObject({
      id: 'b-full',
      message_id: 'm-full',
      type: 'main_text',
      content: 'block-body',
      status: 'success',
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-02T00:00:00.000Z',
      sort_order: 3,
      extra: null
    })
  })

  it('winning topic delete removes topic/messages/blocks/file_refs/segments/memberships', () => {
    // Target authoritative chain with versioned clocks for cascade safety.
    insertTopicOn(dstSqlite, 't-cascade')
    insertMessageOn(dstSqlite, 'm-c1', 't-cascade', 'c1')
    insertMessageOn(dstSqlite, 'm-c2', 't-cascade', 'c2')
    insertBlockOn(dstSqlite, 'b-c1', 'm-c1', 'bc1')
    insertBlockOn(dstSqlite, 'b-c2', 'm-c2', 'bc2')
    dstSqlite
      .prepare('INSERT INTO file_references (id, block_id, file_id, file_name) VALUES (?,?,?,?)')
      .run('fr-c1', 'b-c1', 'f-c1', 'a.bin')
    dstSqlite
      .prepare('INSERT INTO file_references (id, block_id, file_id, file_name) VALUES (?,?,?,?)')
      .run('fr-c2', 'b-c2', 'f-c2', 'b.bin')
    dstSqlite
      .prepare('INSERT INTO topic_segments (id, topic_id, name, sort_order) VALUES (?,?,?,?)')
      .run('seg-c', 't-cascade', 's', 0)
    dstSqlite
      .prepare('INSERT INTO topic_segment_messages (segment_id, message_id, sort_order) VALUES (?,?,?)')
      .run('seg-c', 'm-c1', 0)
    dstSqlite
      .prepare('INSERT INTO topic_segment_messages (segment_id, message_id, sort_order) VALUES (?,?,?)')
      .run('seg-c', 'm-c2', 1)
    for (const [type, id] of [
      ['topic', 't-cascade'],
      ['message', 'm-c1'],
      ['message', 'm-c2'],
      ['message_block', 'b-c1'],
      ['message_block', 'b-c2']
    ] as const) {
      seedEntityClockOn(dstDb, type, id, T, `op-old-${id}`)
      seedFullFieldsOn(dstDb, type, id, T, `op-old-${id}`)
    }
    insertTopicOn(dstSqlite, 't-keep2')
    insertMessageOn(dstSqlite, 'm-keep2', 't-keep2', 'keep')

    // Source: versioned lives + winning topic tombstone.
    insertTopicOn(srcSqlite, 't-cascade')
    insertMessageOn(srcSqlite, 'm-c1', 't-cascade', 'c1')
    insertMessageOn(srcSqlite, 'm-c2', 't-cascade', 'c2')
    insertBlockOn(srcSqlite, 'b-c1', 'm-c1', 'bc1')
    insertBlockOn(srcSqlite, 'b-c2', 'm-c2', 'bc2')
    for (const [type, id] of [
      ['topic', 't-cascade'],
      ['message', 'm-c1'],
      ['message', 'm-c2'],
      ['message_block', 'b-c1'],
      ['message_block', 'b-c2']
    ] as const) {
      seedEntityClockOn(srcDb, type, id, T, `op-src-${id}`)
      seedFullFieldsOn(srcDb, type, id, T, `op-src-${id}`)
    }
    seedMembershipOn(srcDb, 'message', 'm-c1', 't-cascade', T, 'op-src-m-c1')
    seedMembershipOn(srcDb, 'message', 'm-c2', 't-cascade', T, 'op-src-m-c2')
    seedMembershipOn(srcDb, 'message_block', 'b-c1', 'm-c1', T, 'op-src-b-c1')
    seedMembershipOn(srcDb, 'message_block', 'b-c2', 'm-c2', T, 'op-src-b-c2')
    srcSqlite
      .prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)')
      .run('tombstone:topic:t-cascade', `${T + 100}:op-del-cascade`)
    seedBoundOn(srcSqlite)
    const candidate = captureLocalSyncBaselineCandidate(srcDb)
    expect(candidate.completeness.state).toBe('complete')
    const res = applyLocalSyncBaselineCandidate(dstDb, candidate)
    expect(res.deleted).toBeGreaterThanOrEqual(1)
    expect(dstSqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-cascade')).toBeUndefined()
    expect(dstSqlite.prepare('SELECT id FROM messages WHERE topic_id=?').all('t-cascade')).toEqual([])
    expect(dstSqlite.prepare('SELECT id FROM message_blocks WHERE id IN (?,?)').all('b-c1', 'b-c2')).toEqual([])
    expect(dstSqlite.prepare('SELECT id FROM file_references WHERE id IN (?,?)').all('fr-c1', 'fr-c2')).toEqual([])
    expect(dstSqlite.prepare('SELECT id FROM topic_segments WHERE id=?').get('seg-c')).toBeUndefined()
    expect(dstSqlite.prepare('SELECT * FROM topic_segment_messages WHERE segment_id=?').all('seg-c')).toEqual([])
    // Unrelated preserved.
    expect(dstSqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-keep2')).toBeTruthy()
    // Idempotence after delete.
    const afterDelete = JSON.stringify({
      topics: dstSqlite.prepare('SELECT * FROM topics ORDER BY id').all(),
      messages: dstSqlite.prepare('SELECT * FROM messages ORDER BY id').all(),
      blocks: dstSqlite.prepare('SELECT * FROM message_blocks ORDER BY id').all()
    })
    const second = applyLocalSyncBaselineCandidate(dstDb, candidate)
    expect(second.deleted).toBe(0)
    expect(second.inserted).toBe(0)
    expect(second.updated).toBe(0)
    expect(
      JSON.stringify({
        topics: dstSqlite.prepare('SELECT * FROM topics ORDER BY id').all(),
        messages: dstSqlite.prepare('SELECT * FROM messages ORDER BY id').all(),
        blocks: dstSqlite.prepare('SELECT * FROM message_blocks ORDER BY id').all()
      })
    ).toBe(afterDelete)
  })

  it('winning message/block deletes remove blocks/file_refs and clean empty segments', () => {
    insertTopicOn(dstSqlite, 't-mdel')
    insertMessageOn(dstSqlite, 'm-del1', 't-mdel', 'del')
    insertMessageOn(dstSqlite, 'm-keep1', 't-mdel', 'keep')
    insertBlockOn(dstSqlite, 'b-del1', 'm-del1', 'x')
    insertBlockOn(dstSqlite, 'b-keep1', 'm-keep1', 'y')
    dstSqlite
      .prepare('INSERT INTO file_references (id, block_id, file_id) VALUES (?,?,?)')
      .run('fr-del', 'b-del1', 'f-del')
    dstSqlite
      .prepare('INSERT INTO file_references (id, block_id, file_id) VALUES (?,?,?)')
      .run('fr-keep', 'b-keep1', 'f-keep')
    dstSqlite
      .prepare('INSERT INTO topic_segments (id, topic_id, name, sort_order) VALUES (?,?,?,?)')
      .run('seg-m', 't-mdel', 's', 0)
    dstSqlite
      .prepare('INSERT INTO topic_segment_messages (segment_id, message_id, sort_order) VALUES (?,?,?)')
      .run('seg-m', 'm-del1', 0)
    dstSqlite
      .prepare('INSERT INTO topic_segment_messages (segment_id, message_id, sort_order) VALUES (?,?,?)')
      .run('seg-m', 'm-keep1', 1)
    for (const [type, id] of [
      ['topic', 't-mdel'],
      ['message', 'm-del1'],
      ['message', 'm-keep1'],
      ['message_block', 'b-del1'],
      ['message_block', 'b-keep1']
    ] as const) {
      seedEntityClockOn(dstDb, type, id, T, `op-old-${id}`)
      seedFullFieldsOn(dstDb, type, id, T, `op-old-${id}`)
    }

    // Source message delete for m-del1 (winning).
    insertTopicOn(srcSqlite, 't-mdel')
    insertMessageOn(srcSqlite, 'm-del1', 't-mdel', 'del')
    insertMessageOn(srcSqlite, 'm-keep1', 't-mdel', 'keep')
    insertBlockOn(srcSqlite, 'b-del1', 'm-del1', 'x')
    insertBlockOn(srcSqlite, 'b-keep1', 'm-keep1', 'y')
    for (const [type, id] of [
      ['topic', 't-mdel'],
      ['message', 'm-del1'],
      ['message', 'm-keep1'],
      ['message_block', 'b-del1'],
      ['message_block', 'b-keep1']
    ] as const) {
      seedEntityClockOn(srcDb, type, id, T, `op-src-${id}`)
      seedFullFieldsOn(srcDb, type, id, T, `op-src-${id}`)
    }
    seedMembershipOn(srcDb, 'message', 'm-del1', 't-mdel', T, 'op-src-m-del1')
    seedMembershipOn(srcDb, 'message', 'm-keep1', 't-mdel', T, 'op-src-m-keep1')
    seedMembershipOn(srcDb, 'message_block', 'b-del1', 'm-del1', T, 'op-src-b-del1')
    seedMembershipOn(srcDb, 'message_block', 'b-keep1', 'm-keep1', T, 'op-src-b-keep1')
    srcSqlite
      .prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)')
      .run('tombstone:message:m-del1', `${T + 100}:op-del-m`)
    seedBoundOn(srcSqlite)
    const candidate = captureLocalSyncBaselineCandidate(srcDb)
    applyLocalSyncBaselineCandidate(dstDb, candidate)
    expect(dstSqlite.prepare('SELECT id FROM messages WHERE id=?').get('m-del1')).toBeUndefined()
    expect(dstSqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-del1')).toBeUndefined()
    expect(dstSqlite.prepare('SELECT id FROM file_references WHERE id=?').get('fr-del')).toBeUndefined()
    expect(dstSqlite.prepare('SELECT id FROM file_references WHERE id=?').get('fr-keep')).toBeTruthy()
    expect(dstSqlite.prepare('SELECT id FROM messages WHERE id=?').get('m-keep1')).toBeTruthy()
    // Segment survives (still has m-keep1), membership for deleted message gone.
    expect(dstSqlite.prepare('SELECT id FROM topic_segments WHERE id=?').get('seg-m')).toBeTruthy()
    expect(dstSqlite.prepare('SELECT * FROM topic_segment_messages WHERE message_id=?').all('m-del1')).toEqual([])

    // Block delete removes its file ref.
    const src3 = openInMemory()
    const db3 = drizzle(src3, { schema })
    runMigrations(db3 as any, src3)
    try {
      src3
        .prepare('INSERT INTO topics (id, name, created_at, updated_at, extra) VALUES (?,?,?,?,?)')
        .run('t-mdel', 'T', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null)
      src3
        .prepare(
          'INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)'
        )
        .run('m-keep1', 't-mdel', 'user', 'keep', 'success', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 0)
      src3
        .prepare(
          'INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)'
        )
        .run(
          'b-keep1',
          'm-keep1',
          'main_text',
          'y',
          'success',
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          0,
          null
        )
      for (const [type, id] of [
        ['topic', 't-mdel'],
        ['message', 'm-keep1'],
        ['message_block', 'b-keep1']
      ] as const) {
        db3
          .insert(schema.syncEntityClock)
          .values({ entityType: type, entityId: id, timestamp: T, operationId: `op-b-${id}` })
          .run()
        const fields = type === 'topic' ? TOPIC_REQUIRED_CLOCKED : type === 'message' ? MESSAGE_CLOCKED : BLOCK_CLOCKED
        for (const f of fields)
          db3
            .insert(schema.syncFieldClock)
            .values({ entityType: type, entityId: id, field: f, timestamp: T, operationId: `op-b-${id}` })
            .run()
      }
      // Membership for the live children in this second candidate.
      db3
        .insert(schema.syncMembershipClock)
        .values({
          childEntityType: 'message',
          childEntityId: 'm-keep1',
          parentId: 't-mdel',
          timestamp: T,
          operationId: 'op-src-m-keep1'
        })
        .run()
      db3
        .insert(schema.syncMembershipClock)
        .values({
          childEntityType: 'message_block',
          childEntityId: 'b-keep1',
          parentId: 'm-keep1',
          timestamp: T,
          operationId: 'op-src-b-keep1'
        })
        .run()
      src3
        .prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)')
        .run('tombstone:message_block:b-keep1', `${T + 200}:op-del-b`)
      src3.prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)').run('cursor', '7')
      src3.prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)').run('sync:channelKey', 'chan-1')
      const blockDel = captureLocalSyncBaselineCandidate(db3)
      // Target needs versioned block to satisfy F2 (already versioned from setup; bump to T+50).
      dstSqlite
        .prepare('UPDATE sync_entity_clock SET timestamp=?, operation_id=? WHERE entity_type=? AND entity_id=?')
        .run(T + 50, 'op-mid-b', 'message_block', 'b-keep1')
      // b-keep1 already has field clocks from setup (T); entity clock now T+50 still versioned.
      const resB = applyLocalSyncBaselineCandidate(dstDb, blockDel)
      expect(dstSqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-keep1')).toBeUndefined()
      expect(dstSqlite.prepare('SELECT id FROM file_references WHERE id=?').get('fr-keep')).toBeUndefined()
      expect(resB.deleted).toBeGreaterThanOrEqual(1)
    } finally {
      try {
        src3.close()
      } catch {}
    }
  })
})
