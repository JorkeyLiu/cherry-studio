/**
 * Local logical baseline candidate tests: deterministic Main-only capture.
 *
 * Internal/non-wire artifact coverage: determinism, allowlist non-leakage,
 * transient/unsupported exclusion, parent closure, tombstones, field clocks,
 * observed watermark binding, pending-outbox count, and read-only preservation.
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

import { chatDbService } from '../../chatDb'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import {
  canonicalizeSyncJson,
  captureLocalSyncBaselineCandidate,
  type LocalSyncBaselineCandidate,
  SyncBaselineError
} from '../syncBaseline'
import { syncService } from '../SyncService'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
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

function insertTopic(id: string, extra: Record<string, unknown> | null = null, deletedAt: string | null = null): void {
  sqlite
    .prepare('INSERT INTO topics (id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?)')
    .run(
      id,
      `Topic ${id}`,
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      deletedAt,
      extra ? JSON.stringify(extra) : null
    )
}

function insertMessage(
  id: string,
  topicId: string,
  status: string | null = 'success',
  role = 'user',
  content: string | null = 'hello'
): void {
  sqlite
    .prepare(
      'INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)'
    )
    .run(id, topicId, role, content, status, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 0)
}

function insertBlock(
  id: string,
  messageId: string,
  type: string | null = 'main_text',
  status: string | null = 'success',
  content: string | null = 'body',
  extra: Record<string, unknown> | null = null
): void {
  sqlite
    .prepare(
      'INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)'
    )
    .run(
      id,
      messageId,
      type,
      content,
      status,
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      0,
      extra ? JSON.stringify(extra) : null
    )
}

function seedEntityClock(entityType: string, entityId: string, timestamp: number, operationId: string): void {
  db.insert(schema.syncEntityClock).values({ entityType, entityId, timestamp, operationId }).run()
}

function seedFieldClock(
  entityType: string,
  entityId: string,
  field: string,
  timestamp: number,
  operationId: string
): void {
  db.insert(schema.syncFieldClock).values({ entityType, entityId, field, timestamp, operationId }).run()
}

const TOPIC_REQUIRED_CLOCKED_FIELDS = ['name', 'assistantId', 'createdAt', 'updatedAt', 'deletedAt']
const TOPIC_OPTIONAL_CLOCKED_FIELDS = ['pinned', 'prompt', 'isNameManuallyEdited']
const MESSAGE_CLOCKED_FIELDS = [
  'role',
  'content',
  'status',
  'askId',
  'model',
  'modelId',
  'assistantId',
  'createdAt',
  'updatedAt'
]
const BLOCK_CLOCKED_FIELDS = ['type', 'content', 'status', 'createdAt', 'updatedAt']

function seedFullFieldClocks(
  entityType: string,
  entityId: string,
  timestamp: number,
  operationId: string,
  extraTopicFields: string[] = []
): void {
  // Topics: required always; optional only when present in payload.
  const fields =
    entityType === 'topic'
      ? [...TOPIC_REQUIRED_CLOCKED_FIELDS, ...extraTopicFields.filter((f) => TOPIC_OPTIONAL_CLOCKED_FIELDS.includes(f))]
      : entityType === 'message'
        ? MESSAGE_CLOCKED_FIELDS
        : BLOCK_CLOCKED_FIELDS
  for (const field of fields) seedFieldClock(entityType, entityId, field, timestamp, operationId)
}

function seedMembership(
  childType: 'message' | 'message_block',
  childId: string,
  parentId: string,
  timestamp: number,
  operationId: string
): void {
  db.insert(schema.syncMembershipClock)
    .values({ childEntityType: childType, childEntityId: childId, parentId, timestamp, operationId })
    .run()
}

function seedState(key: string, value: string | null): void {
  sqlite.prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)').run(key, value)
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
      'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(kind, parentId, 'parent-order-frame-v1', JSON.stringify(ordered), ts, op)
}

function seedBoundWatermark(cursor = '7', channel = 'chan-1'): void {
  seedState('cursor', cursor)
  seedState('sync:channelKey', channel)
}

function seedOutboxRow(id: string, payload: Record<string, unknown> | null = null): void {
  sqlite
    .prepare(
      'INSERT INTO sync_outbox (id, entity_type, op, entity_id, timestamp, device_id, payload_json, created_at) VALUES (?,?,?,?,?,?,?,?)'
    )
    .run(id, 'message', 'upsert', 'm-x', T, 'd1', payload ? JSON.stringify(payload) : null, '2026-01-01T00:00:00.000Z')
}

function snapshotState(): string {
  const tables = [
    'topics',
    'messages',
    'message_blocks',
    'sync_state',
    'sync_outbox',
    'sync_applied',
    'sync_entity_clock',
    'sync_field_clock',
    'sync_conflict_log',
    'topic_segments',
    'topic_segment_messages',
    'file_references',
    'migration_state'
  ]
  const dump: Record<string, unknown> = {}
  for (const table of tables) {
    try {
      dump[table] = sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
    } catch {
      dump[table] = 'missing'
    }
  }
  return JSON.stringify(dump)
}

/** Independent minimal sorter proving the manifest digest covers content minus itself. */
function independentCanonical(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite')
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((entry) => independentCanonical(entry)).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${independentCanonical(v)}`).join(',')}}`
  }
  throw new Error(`unsupported ${typeof value}`)
}

function unsignedOf(candidate: LocalSyncBaselineCandidate): Record<string, unknown> {
  const manifest = { ...(candidate.manifest as unknown as Record<string, unknown>) }
  delete manifest.digest
  return { ...(candidate as unknown as Record<string, unknown>), manifest }
}

function seedStandardDataset(order: 'fwd' | 'rev'): void {
  const topicIds = order === 'fwd' ? ['t-a', 't-b'] : ['t-b', 't-a']
  for (const id of topicIds) insertTopic(id)
  const messageIds = order === 'fwd' ? ['m-a1', 'm-b1'] : ['m-b1', 'm-a1']
  insertMessage(messageIds[0], messageIds[0].startsWith('m-a') ? 't-a' : 't-b')
  insertMessage(messageIds[1], messageIds[1].startsWith('m-a') ? 't-a' : 't-b')
  const blockIds = order === 'fwd' ? ['b-a1', 'b-b1'] : ['b-b1', 'b-a1']
  insertBlock(blockIds[0], blockIds[0].startsWith('b-a') ? 'm-a1' : 'm-b1')
  insertBlock(blockIds[1], blockIds[1].startsWith('b-a') ? 'm-a1' : 'm-b1')
  // Fixed per-entity version metadata: identical logical state and metadata
  // regardless of insertion order, so reversed inserts must canonicalize equally.
  const clocks: Array<[string, string, number]> = [
    ['topic', 't-a', T],
    ['topic', 't-b', T + 1],
    ['message', 'm-a1', T + 2],
    ['message', 'm-b1', T + 3],
    ['message_block', 'b-a1', T + 4],
    ['message_block', 'b-b1', T + 5]
  ]
  const ordered = order === 'fwd' ? clocks : [...clocks].reverse()
  for (const [type, id, ts] of ordered) seedEntityClock(type, id, ts, `op-${id}`)
  seedFieldClock('message', 'm-a1', 'content', T, 'op-m-a1')
  seedState('tombstone:message:m-gone', `${T}:op-del-gone`)
  seedBoundWatermark()
}

describe('repeat and insertion-order determinism', () => {
  it('repeat capture is byte-equivalent with a stable digest', () => {
    seedStandardDataset('fwd')
    const first = captureLocalSyncBaselineCandidate(db)
    const second = captureLocalSyncBaselineCandidate(db)
    expect(second).toEqual(first)
    expect(canonicalizeSyncJson(first)).toBe(canonicalizeSyncJson(second))
    expect(first.manifest.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(first.kind).toBe('local_sync_baseline_candidate')
    expect(first.schemaVersion).toBe('local-sync-baseline-v1')
    expect(first.inventoryVersion).toBe('topic-message-stable-block-order-v1')
  })

  it('insertion order does not change canonical content or digest', () => {
    seedStandardDataset('fwd')
    const fwd = captureLocalSyncBaselineCandidate(db)
    const fwdCanonical = canonicalizeSyncJson(fwd)
    const fwdDigest = fwd.manifest.digest
    sqlite.close()
    sqlite = openInMemory()
    db = drizzle(sqlite, { schema })
    runMigrations(db as any, sqlite)
    ;(chatDbService as any).sqlite = sqlite
    ;(chatDbService as any).db = db
    seedStandardDataset('rev')
    const rev = captureLocalSyncBaselineCandidate(db)
    expect(canonicalizeSyncJson(rev)).toBe(fwdCanonical)
    expect(rev.manifest.digest).toBe(fwdDigest)
  })

  it('digest changes for an allowlisted value change', () => {
    seedStandardDataset('fwd')
    const before = captureLocalSyncBaselineCandidate(db).manifest.digest
    sqlite.prepare('UPDATE messages SET content=? WHERE id=?').run('changed', 'm-a1')
    const after = captureLocalSyncBaselineCandidate(db).manifest.digest
    expect(after).not.toBe(before)
  })

  it('digest changes for a version (entity clock) change', () => {
    seedStandardDataset('fwd')
    const before = captureLocalSyncBaselineCandidate(db).manifest.digest
    sqlite
      .prepare('UPDATE sync_entity_clock SET timestamp=? WHERE entity_type=? AND entity_id=?')
      .run(T + 100, 'message', 'm-a1')
    const after = captureLocalSyncBaselineCandidate(db).manifest.digest
    expect(after).not.toBe(before)
  })

  it('digest changes for a tombstone change', () => {
    seedStandardDataset('fwd')
    const before = captureLocalSyncBaselineCandidate(db).manifest.digest
    seedState('tombstone:topic:t-b', `${T}:op-del-tb`)
    const after = captureLocalSyncBaselineCandidate(db).manifest.digest
    expect(after).not.toBe(before)
  })

  it('manifest digest covers candidate content except its own value', () => {
    seedStandardDataset('fwd')
    const candidate = captureLocalSyncBaselineCandidate(db)
    const recomputed = createHash('sha256')
      .update(independentCanonical(unsignedOf(candidate)), 'utf8')
      .digest('hex')
    expect(candidate.manifest.digest).toBe(recomputed)
  })
})

describe('allowlist and non-leakage', () => {
  it('emits only allowlisted fields and never leaks overflow, segments, files, or credentials', () => {
    insertTopic('t-leak', {
      pinned: true,
      prompt: 'keep me',
      isNameManuallyEdited: true,
      contextWindowAnchor: { secret: 'anchor-secret' },
      credentials: { token: 'super-secret-token' },
      file_path: '/secret/device/path',
      password: 'pw-secret',
      overflowArbitrary: 'drop-me'
    })
    insertMessage('m-leak', 't-leak')
    sqlite
      .prepare('UPDATE messages SET extra=? WHERE id=?')
      .run(JSON.stringify({ junk: 'drop-me', secret: 's3' }), 'm-leak')
    insertBlock('b-leak', 'm-leak', 'main_text', 'success', 'visible', {
      file_path: '/secret/attach/path',
      credentials: { apiKey: 'k-secret' },
      contextWindowAnchor: { x: 1 }
    })
    sqlite
      .prepare(
        'INSERT INTO file_references (id, block_id, file_id, file_name, file_path, file_type, count) VALUES (?,?,?,?,?,?,?)'
      )
      .run('fr-1', 'b-leak', 'f-1', 'name.bin', '/secret/file.bin', 'bin', 1)
    sqlite
      .prepare('INSERT INTO topic_segments (id, topic_id, name, sort_order) VALUES (?,?,?,?)')
      .run('seg-1', 't-leak', 'seg', 0)
    sqlite
      .prepare('INSERT INTO topic_segment_messages (segment_id, message_id, sort_order) VALUES (?,?,?)')
      .run('seg-1', 'm-leak', 0)
    for (const [type, id] of [
      ['topic', 't-leak'],
      ['message', 'm-leak'],
      ['message_block', 'b-leak']
    ] as const) {
      seedEntityClock(type, id, T, `op-${id}`)
      seedFullFieldClocks(type, id, T, `op-${id}`, ['pinned', 'prompt', 'isNameManuallyEdited'])
    }
    seedMembership('message', 'm-leak', 't-leak', T, 'op-m-leak')
    seedMembership('message_block', 'b-leak', 'm-leak', T, 'op-b-leak')
    seedFrame('topicMessage', 't-leak', ['m-leak'], T + 10, 'op-frame-leak-t')
    seedFrame('messageBlock', 'm-leak', ['b-leak'], T + 10, 'op-frame-leak-m')
    seedBoundWatermark()
    const candidate = captureLocalSyncBaselineCandidate(db)
    const json = JSON.stringify(candidate)
    for (const leak of [
      'anchor-secret',
      'super-secret-token',
      '/secret/',
      'pw-secret',
      'drop-me',
      's3',
      'k-secret',
      'seg-1',
      'fr-1',
      'name.bin'
    ]) {
      expect(json).not.toContain(leak)
    }
    expect(json).not.toContain('deviceId')
    const topic = candidate.entities.find((e) => e.entityId === 't-leak')
    expect(Object.keys(topic?.payload ?? {}).sort()).toEqual(
      [
        'assistantId',
        'createdAt',
        'deletedAt',
        'id',
        'isNameManuallyEdited',
        'name',
        'pinned',
        'prompt',
        'updatedAt'
      ].sort()
    )
    expect(topic?.payload.pinned).toBe(true)
    expect(topic?.payload.prompt).toBe('keep me')
    const message = candidate.entities.find((e) => e.entityId === 'm-leak')
    expect(Object.keys(message?.payload ?? {}).sort()).toEqual(
      [
        'assistantId',
        'askId',
        'content',
        'createdAt',
        'id',
        'model',
        'modelId',
        'role',
        'status',
        'topicId',
        'updatedAt'
      ].sort()
    )
    const block = candidate.entities.find((e) => e.entityId === 'b-leak')
    expect(Object.keys(block?.payload ?? {}).sort()).toEqual(
      ['content', 'createdAt', 'id', 'messageId', 'status', 'type', 'updatedAt'].sort()
    )
    expect(candidate.completeness.state).toBe('complete')
  })
})

describe('transient and unsupported exclusions', () => {
  it('excludes transient and unsupported rows without shells and reports bounded reasons', () => {
    insertTopic('t-e')
    insertMessage('m-stable', 't-e', 'success')
    insertMessage('m-transient', 't-e', 'streaming', 'assistant')
    insertBlock('b-text', 'm-stable', 'main_text', 'success', 'body')
    insertBlock('b-transient', 'm-stable', 'main_text', 'pending', 'draft')
    insertBlock('b-tool', 'm-stable', 'tool', 'success', null, { content: { tool: 'result-secret' } })
    insertBlock('b-image', 'm-stable', 'image', 'success', 'img')
    insertBlock('b-under-transient', 'm-transient', 'main_text', 'success', 'orphan body')
    for (const [type, id] of [
      ['topic', 't-e'],
      ['message', 'm-stable'],
      ['message_block', 'b-text']
    ] as const) {
      seedEntityClock(type, id, T, `op-${id}`)
    }
    seedBoundWatermark()
    const candidate = captureLocalSyncBaselineCandidate(db)
    const ids = candidate.entities.map((e) => e.entityId)
    expect(ids.sort()).toEqual(['b-text', 'm-stable', 't-e'])
    expect(JSON.stringify(candidate)).not.toContain('result-secret')
    expect(candidate.manifest.excludedTransientMessages).toBe(1)
    expect(candidate.manifest.excludedTransientBlocks).toBe(1)
    expect(candidate.manifest.excludedUnsupportedBlocks).toBe(2)
    expect(candidate.manifest.orphanSuppressedChildren).toBe(1)
    expect(candidate.completeness.state).toBe('partial')
    expect(candidate.completeness.reasons).toEqual(
      [
        'aggregate-incomplete-child-excluded',
        'missing-order-frame',
        'orphan-child-suppressed',
        'transient-block-excluded',
        'transient-message-excluded',
        'unsupported-block-excluded',
        'unversioned-field',
        'unversioned-membership'
      ].sort()
    )
    expect(candidate.manifest.aggregateIncompleteParents).toBe(2)
    expect(candidate.manifest.unversionedFieldCount).toBeGreaterThan(0)
    expect(candidate.manifest.unversionedMembershipCount).toBe(2)
  })
})

describe('parent closure', () => {
  it('never emits a child whose emitted parent is absent', () => {
    insertTopic('t-p')
    insertMessage('m-p', 't-p')
    insertBlock('b-p', 'm-p')
    sqlite.exec('PRAGMA foreign_keys=OFF')
    sqlite
      .prepare('INSERT INTO messages (id, topic_id, role, status, sort_order) VALUES (?,?,?, ?,?)')
      .run('m-orphan', 't-missing', 'user', 'success', 0)
    sqlite
      .prepare('INSERT INTO message_blocks (id, message_id, type, status, sort_order) VALUES (?,?,?,?,?)')
      .run('b-orphan', 'm-missing', 'main_text', 'success', 0)
    sqlite.exec('PRAGMA foreign_keys=ON')
    for (const [type, id] of [
      ['topic', 't-p'],
      ['message', 'm-p'],
      ['message_block', 'b-p']
    ] as const) {
      seedEntityClock(type, id, T, `op-${id}`)
    }
    seedBoundWatermark()
    const candidate = captureLocalSyncBaselineCandidate(db)
    const ids = candidate.entities.map((e) => e.entityId)
    expect(ids).not.toContain('m-orphan')
    expect(ids).not.toContain('b-orphan')
    expect(candidate.manifest.orphanSuppressedChildren).toBe(2)
    expect(candidate.completeness.reasons).toContain('orphan-child-suppressed')
  })

  it('orders entities topic, message, block then lexical id', () => {
    insertTopic('t-z')
    insertTopic('t-a')
    insertMessage('m-z', 't-z')
    insertMessage('m-a', 't-a')
    insertBlock('b-z', 'm-z')
    insertBlock('b-a', 'm-a')
    for (const [type, id] of [
      ['topic', 't-a'],
      ['topic', 't-z'],
      ['message', 'm-a'],
      ['message', 'm-z'],
      ['message_block', 'b-a'],
      ['message_block', 'b-z']
    ] as const) {
      seedEntityClock(type, id, T, `op-${id}`)
    }
    seedBoundWatermark()
    const candidate = captureLocalSyncBaselineCandidate(db)
    expect(candidate.entities.map((e) => `${e.entityType}:${e.entityId}`)).toEqual([
      'topic:t-a',
      'topic:t-z',
      'message:m-a',
      'message:m-z',
      'message_block:b-a',
      'message_block:b-z'
    ])
  })
})

describe('tombstones', () => {
  it('includes timestamp+operationId and legacy timestamp-only tombstones alongside live entities', () => {
    insertTopic('t-both')
    insertMessage('m-both', 't-both')
    insertBlock('b-both', 'm-both')
    for (const [type, id] of [
      ['topic', 't-both'],
      ['message', 'm-both'],
      ['message_block', 'b-both']
    ] as const) {
      seedEntityClock(type, id, T, `op-${id}`)
    }
    seedState('tombstone:topic:t-both', `${T}:op-del-t`)
    seedState('tombstone:message:m-gone', `${T - 5}`)
    seedBoundWatermark()
    const candidate = captureLocalSyncBaselineCandidate(db)
    const liveIds = candidate.entities.map((e) => e.entityId)
    expect(liveIds).toContain('t-both')
    const tombTopic = candidate.tombstones.find((t) => t.entityId === 't-both')
    expect(tombTopic).toMatchObject({ entityType: 'topic', timestamp: T, operationId: 'op-del-t' })
    const tombLegacy = candidate.tombstones.find((t) => t.entityId === 'm-gone')
    expect(tombLegacy).toMatchObject({ entityType: 'message', timestamp: T - 5, operationId: null })
  })

  it.each([
    ['empty entity id', 'tombstone:topic:', `${T}:op-1`],
    ['unknown tombstone namespace', 'tombstone:foo:x', `${T}:op-1`],
    ['non-numeric timestamp', 'tombstone:topic:t-x', 'abc'],
    ['leading-zero timestamp', 'tombstone:topic:t-x', '01'],
    ['empty value', 'tombstone:topic:t-x', ''],
    ['empty operation id', 'tombstone:topic:t-x', '12:'],
    ['colon in operation id', 'tombstone:topic:t-x', '12:op:with:colon'],
    ['oversized value', 'tombstone:topic:t-x', `1:${'o'.repeat(300)}`]
  ])('malformed tombstone fails closed: %s', (_label, key, value) => {
    insertTopic('t-ok')
    seedEntityClock('topic', 't-ok', T, 'op-t-ok')
    seedBoundWatermark()
    seedState(key, value)
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(SyncBaselineError)
  })

  it('null tombstone value fails closed', () => {
    insertTopic('t-ok')
    seedEntityClock('topic', 't-ok', T, 'op-t-ok')
    seedBoundWatermark()
    seedState('tombstone:topic:t-null', null)
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(SyncBaselineError)
  })
})

describe('field clocks and unversioned entities', () => {
  it('includes only allowlisted field clocks and marks missing entity clocks partial', () => {
    insertTopic('t-f')
    insertMessage('m-f', 't-f')
    insertBlock('b-f', 'm-f')
    seedEntityClock('topic', 't-f', T, 'op-t-f')
    seedEntityClock('message', 'm-f', T, 'op-m-f')
    seedFieldClock('message', 'm-f', 'content', T, 'op-m-f')
    seedFieldClock('message', 'm-f', 'contextWindowAnchor', T, 'op-evil')
    seedFieldClock('topic', 't-f', 'sortOrder', T, 'op-evil')
    seedBoundWatermark()
    const candidate = captureLocalSyncBaselineCandidate(db)
    const message = candidate.entities.find((e) => e.entityId === 'm-f')
    expect(message?.fieldClocks).toEqual([{ field: 'content', timestamp: T, operationId: 'op-m-f' }])
    const topic = candidate.entities.find((e) => e.entityId === 't-f')
    expect(topic?.fieldClocks).toEqual([])
    const block = candidate.entities.find((e) => e.entityId === 'b-f')
    expect(block?.entityClock).toBeNull()
    expect(candidate.manifest.unversionedEntityCount).toBe(1)
    expect(candidate.manifest.unversionedFieldCount).toBeGreaterThan(0)
    expect(candidate.completeness.state).toBe('partial')
    expect(candidate.completeness.reasons).toContain('unversioned-entity')
    expect(candidate.completeness.reasons).toContain('unversioned-field')
  })

  it('is complete only when every emitted entity and clocked payload field is versioned with bound observation', () => {
    insertTopic('t-c')
    insertMessage('m-c', 't-c')
    insertBlock('b-c', 'm-c')
    for (const [type, id] of [
      ['topic', 't-c'],
      ['message', 'm-c'],
      ['message_block', 'b-c']
    ] as const) {
      seedEntityClock(type, id, T, `op-${id}`)
      seedFullFieldClocks(type, id, T, `op-${id}`)
    }
    seedMembership('message', 'm-c', 't-c', T, 'op-m-c')
    seedMembership('message_block', 'b-c', 'm-c', T, 'op-b-c')
    seedFrame('topicMessage', 't-c', ['m-c'], T + 10, 'op-frame-tc')
    seedFrame('messageBlock', 'm-c', ['b-c'], T + 10, 'op-frame-mc')
    seedBoundWatermark()
    const candidate = captureLocalSyncBaselineCandidate(db)
    expect(candidate.completeness).toEqual({ state: 'complete', reasons: [] })
    expect(candidate.manifest.completenessState).toBe('complete')
    expect(candidate.manifest.unversionedFieldCount).toBe(0)
    expect(candidate.manifest.unversionedMembershipCount).toBe(0)
  })

  it('marks partial when a clocked payload field lacks a field clock', () => {
    insertTopic('t-uf')
    insertMessage('m-uf', 't-uf')
    seedEntityClock('topic', 't-uf', T, 'op-t-uf')
    seedEntityClock('message', 'm-uf', T, 'op-m-uf')
    seedFullFieldClocks('topic', 't-uf', T, 'op-t-uf')
    seedFieldClock('message', 'm-uf', 'content', T, 'op-m-uf')
    seedBoundWatermark()
    const candidate = captureLocalSyncBaselineCandidate(db)
    expect(candidate.completeness.state).toBe('partial')
    expect(candidate.completeness.reasons).toContain('unversioned-field')
    expect(candidate.manifest.unversionedFieldCount).toBeGreaterThan(0)
  })
})

describe('operation ID shape validation', () => {
  it.each([
    ['colon-bearing entity clock operation ID', 'op:with:colon'],
    ['overlength entity clock operation ID', 'o'.repeat(257)]
  ])('malformed entity clock operation ID fails closed without mutation: %s', (_label, operationId) => {
    insertTopic('t-op')
    insertMessage('m-op', 't-op')
    seedEntityClock('topic', 't-op', T, 'op-t-op')
    seedEntityClock('message', 'm-op', T, operationId)
    seedBoundWatermark()
    const before = snapshotState()
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(SyncBaselineError)
    expect(snapshotState()).toBe(before)
  })

  it.each([
    ['colon-bearing field clock operation ID', 'op:with:colon'],
    ['overlength field clock operation ID', 'o'.repeat(257)]
  ])('malformed field clock operation ID fails closed without mutation: %s', (_label, operationId) => {
    insertTopic('t-op')
    insertMessage('m-op', 't-op')
    seedEntityClock('topic', 't-op', T, 'op-t-op')
    seedEntityClock('message', 'm-op', T, 'op-m-op')
    seedFieldClock('message', 'm-op', 'content', T, operationId)
    seedBoundWatermark()
    const before = snapshotState()
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(SyncBaselineError)
    expect(snapshotState()).toBe(before)
  })

  it('accepts a 256-character colon-free operation ID in entity clocks, field clocks, and tombstones', () => {
    const maxId = 'o'.repeat(256)
    insertTopic('t-max')
    insertMessage('m-max', 't-max')
    seedEntityClock('topic', 't-max', T, maxId)
    seedEntityClock('message', 'm-max', T, maxId)
    seedFullFieldClocks('topic', 't-max', T, maxId)
    seedFullFieldClocks('message', 'm-max', T, maxId)
    seedMembership('message', 'm-max', 't-max', T, maxId)
    seedState('tombstone:message:m-max-gone', `${T}:${maxId}`)
    seedFrame('topicMessage', 't-max', ['m-max'], T + 10, maxId)
    seedFrame('messageBlock', 'm-max', [], T + 10, maxId)
    seedBoundWatermark()
    const candidate = captureLocalSyncBaselineCandidate(db)
    expect(candidate.entities.find((e) => e.entityId === 't-max')?.entityClock).toEqual({
      timestamp: T,
      operationId: maxId
    })
    expect(candidate.entities.find((e) => e.entityId === 'm-max')?.fieldClocks).toEqual(
      ['askId', 'assistantId', 'content', 'createdAt', 'model', 'modelId', 'role', 'status', 'updatedAt'].map(
        (field) => ({ field, timestamp: T, operationId: maxId })
      )
    )
    expect(candidate.tombstones.find((t) => t.entityId === 'm-max-gone')).toMatchObject({
      entityType: 'message',
      timestamp: T,
      operationId: maxId
    })
    expect(candidate.completeness.state).toBe('complete')
  })
})

describe('observed watermark binding', () => {
  it('reports bound observation when both channel key and strict cursor are present', () => {
    insertTopic('t-w')
    seedEntityClock('topic', 't-w', T, 'op-t-w')
    seedFullFieldClocks('topic', 't-w', T, 'op-t-w')
    seedFrame('topicMessage', 't-w', [], T + 10, 'op-frame-tw')
    seedBoundWatermark('12', 'chan-abc')
    const candidate = captureLocalSyncBaselineCandidate(db)
    expect(candidate.observedLocalChannelKey).toBe('chan-abc')
    expect(candidate.observedLocalCursor).toBe(12)
    expect(candidate.observationBinding).toBe('bound')
    expect(candidate.completeness.state).toBe('complete')
  })

  it.each([
    ['no channel and no cursor', false, false],
    ['channel only', true, false],
    ['cursor only', false, true]
  ])('reports unbound when observation is incomplete: %s', (_label, withChannel, withCursor) => {
    insertTopic('t-w')
    seedEntityClock('topic', 't-w', T, 'op-t-w')
    if (withChannel) seedState('sync:channelKey', 'chan-1')
    if (withCursor) seedState('cursor', '3')
    const candidate = captureLocalSyncBaselineCandidate(db)
    expect(candidate.observationBinding).toBe('unbound')
    expect(candidate.completeness.state).toBe('unbound')
    expect(candidate.completeness.reasons).toContain('observed-watermark-unbound')
  })

  it.each([
    ['junk cursor', '12junk'],
    ['negative cursor', '-1'],
    ['leading-zero cursor', '01'],
    ['empty cursor', ''],
    ['whitespace cursor', ' 7']
  ])('malformed cursor fails closed: %s', (_label, value) => {
    insertTopic('t-w')
    seedEntityClock('topic', 't-w', T, 'op-t-w')
    seedState('sync:channelKey', 'chan-1')
    seedState('cursor', value)
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(SyncBaselineError)
  })

  it('null cursor value fails closed', () => {
    insertTopic('t-w')
    seedEntityClock('topic', 't-w', T, 'op-t-w')
    seedState('sync:channelKey', 'chan-1')
    seedState('cursor', null)
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(SyncBaselineError)
  })

  it.each([
    ['empty channel key', ''],
    ['oversized channel key', 'c'.repeat(257)]
  ])('malformed channel key fails closed: %s', (_label, value) => {
    insertTopic('t-w')
    seedEntityClock('topic', 't-w', T, 'op-t-w')
    seedState('sync:channelKey', value)
    seedState('cursor', '3')
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(SyncBaselineError)
  })

  it('null channel key value fails closed', () => {
    insertTopic('t-w')
    seedEntityClock('topic', 't-w', T, 'op-t-w')
    seedState('sync:channelKey', null)
    seedState('cursor', '3')
    expect(() => captureLocalSyncBaselineCandidate(db)).toThrow(SyncBaselineError)
  })
})

describe('pending outbox', () => {
  it('counts pending outbox without payload exposure or mutation', () => {
    insertTopic('t-o')
    insertMessage('m-o', 't-o')
    seedEntityClock('topic', 't-o', T, 'op-t-o')
    seedEntityClock('message', 'm-o', T, 'op-m-o')
    seedBoundWatermark()
    seedOutboxRow('op-pending-1', { id: 'm-o', topicId: 't-o', content: 'outbox-secret-content' })
    const before = snapshotState()
    const candidate = captureLocalSyncBaselineCandidate(db)
    expect(candidate.pendingOutboxCount).toBe(1)
    expect(candidate.manifest.pendingOutboxCount).toBe(1)
    expect(JSON.stringify(candidate)).not.toContain('outbox-secret-content')
    expect(candidate.completeness.state).toBe('partial')
    expect(candidate.completeness.reasons).toContain('pending-outbox')
    expect(snapshotState()).toBe(before)
    expect(sqlite.prepare('SELECT id FROM sync_outbox WHERE id=?').get('op-pending-1')).toBeTruthy()
  })
})

describe('read-only preservation', () => {
  it('leaves chat rows, outbox, applied, clocks, tombstones, cursor, and pairing state unchanged', () => {
    insertTopic('t-r', { pinned: true })
    insertTopic('t-soft', null, '2026-02-01T00:00:00.000Z')
    insertMessage('m-r', 't-r', 'success')
    insertMessage('m-t', 't-r', 'streaming', 'assistant')
    insertBlock('b-r', 'm-r', 'main_text', 'success', 'body')
    insertBlock('b-tool', 'm-r', 'tool', 'success', null, { content: { args: 'x' } })
    seedEntityClock('topic', 't-r', T, 'op-t-r')
    seedEntityClock('message', 'm-r', T, 'op-m-r')
    seedEntityClock('message_block', 'b-r', T, 'op-b-r')
    seedFieldClock('message', 'm-r', 'content', T, 'op-m-r')
    seedState('tombstone:message:m-old', `${T}:op-del-old`)
    seedState('tombstone:topic:t-old', `${T - 1}`)
    seedBoundWatermark('9', 'chan-r')
    seedOutboxRow('op-pending-r')
    db.insert(schema.syncApplied).values({ operationId: 'op-applied', appliedAt: '2026-01-01T00:00:00.000Z' }).run()
    db.insert(schema.syncConflictLog)
      .values({
        id: 'conf-1',
        entityType: 'message',
        entityId: 'm-r',
        field: 'content',
        loserValueJson: '"old"',
        loserTimestamp: T - 1,
        loserOperationId: 'op-old',
        winnerTimestamp: T,
        winnerOperationId: 'op-m-r',
        createdAt: '2026-01-01T00:00:00.000Z'
      })
      .run()
    const before = snapshotState()
    const candidate = captureLocalSyncBaselineCandidate(db)
    expect(candidate.entities.length).toBeGreaterThan(0)
    expect(snapshotState()).toBe(before)
  })
})
