/**
 * Baseline wire payload projection tests: pure local candidate -> locked
 * `sync-baseline-wire-v1` payload. No transport, no relay, no IPC/UI.
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

import { canonicalizePayload, compareUtf8ByteLex, validatePayload } from '@shared/sync'

import { chatDbService } from '../../chatDb'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { captureLocalSyncBaselineCandidate, type LocalSyncBaselineCandidate } from '../syncBaseline'
import {
  computeWirePayloadDigest,
  projectLocalBaselineToWirePayload,
  SyncBaselineWireProjectionError,
  verifyWirePayloadDigest
} from '../syncBaselineWireProjection'
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

function insertTopic(id: string, extra: Record<string, unknown> | null = null): void {
  sqlite
    .prepare('INSERT INTO topics (id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?)')
    .run(
      id,
      `Topic ${id}`,
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      null,
      extra ? JSON.stringify(extra) : null
    )
}

function insertMessage(id: string, topicId: string, status: string | null = 'success'): void {
  sqlite
    .prepare(
      'INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)'
    )
    .run(id, topicId, 'user', `content-${id}`, status, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 0)
}

function insertBlock(id: string, messageId: string): void {
  sqlite
    .prepare(
      'INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)'
    )
    .run(
      id,
      messageId,
      'main_text',
      `body-${id}`,
      'success',
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      0,
      null
    )
}

function seedEntityClock(type: string, id: string, ts = T, op?: string): void {
  db.insert(schema.syncEntityClock)
    .values({ entityType: type, entityId: id, timestamp: ts, operationId: op ?? `op-${id}` })
    .run()
}

const TOPIC_REQ = ['name', 'assistantId', 'createdAt', 'updatedAt', 'deletedAt']
const TOPIC_OPT = ['pinned', 'prompt', 'isNameManuallyEdited']
const MSG_FIELDS = ['role', 'content', 'status', 'askId', 'model', 'modelId', 'assistantId', 'createdAt', 'updatedAt']
const BLOCK_FIELDS = ['type', 'content', 'status', 'createdAt', 'updatedAt']

function seedField(type: string, id: string, field: string, ts = T, op?: string): void {
  db.insert(schema.syncFieldClock)
    .values({ entityType: type, entityId: id, field, timestamp: ts, operationId: op ?? `op-${id}` })
    .run()
}

function seedFullTopic(id: string, ts = T, op?: string): void {
  const o = op ?? `op-${id}`
  for (const f of [...TOPIC_REQ, ...TOPIC_OPT]) seedField('topic', id, f, ts, o)
}

function seedFullMessage(id: string, ts = T, op?: string): void {
  const o = op ?? `op-${id}`
  for (const f of MSG_FIELDS) seedField('message', id, f, ts, o)
}

function seedFullBlock(id: string, ts = T, op?: string): void {
  const o = op ?? `op-${id}`
  for (const f of BLOCK_FIELDS) seedField('message_block', id, f, ts, o)
}

function seedMembership(
  childType: 'message' | 'message_block',
  childId: string,
  parentId: string,
  ts = T,
  op?: string
): void {
  db.insert(schema.syncMembershipClock)
    .values({
      childEntityType: childType,
      childEntityId: childId,
      parentId,
      timestamp: ts,
      operationId: op ?? `op-${childId}`
    })
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
      'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(kind, parentId, 'parent-order-frame-v1', JSON.stringify(ordered), ts, op)
}

function seedBound(cursor = '7', channel = 'chan-1'): void {
  sqlite.prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)').run('cursor', cursor)
  sqlite.prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)').run('sync:channelKey', channel)
}

const FULL_TOPIC_EXTRA = { pinned: true, prompt: 'keep', isNameManuallyEdited: false }

/** Seed one wire-complete topic->message->block chain. */
function seedWireCompleteChain(tid: string, mid: string, bid: string): void {
  insertTopic(tid, { ...FULL_TOPIC_EXTRA })
  insertMessage(mid, tid)
  insertBlock(bid, mid)
  seedEntityClock('topic', tid)
  seedEntityClock('message', mid)
  seedEntityClock('message_block', bid)
  seedFullTopic(tid)
  seedFullMessage(mid)
  seedFullBlock(bid)
  seedMembership('message', mid, tid)
  seedMembership('message_block', bid, mid)
  seedFrame('topicMessage', tid, [mid], T + 10, `op-frame-${tid}`)
  seedFrame('messageBlock', mid, [bid], T + 10, `op-frame-${mid}`)
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}

describe('wire projection exact shape and stripping', () => {
  it('projects complete candidate to locked payload with no envelope or diagnostics', () => {
    seedWireCompleteChain('t-p1', 'm-p1', 'b-p1')
    seedBound()
    const candidate = captureLocalSyncBaselineCandidate(db)
    expect(candidate.completeness.state).toBe('complete')
    const payload = projectLocalBaselineToWirePayload(candidate)
    expect(() => validatePayload(payload)).not.toThrow()
    expect(Object.keys(payload).sort()).toEqual(
      [
        'inventoryVersion',
        'manifest',
        'messageBlocks',
        'messages',
        'orderFrameVersion',
        'orderFrames',
        'payloadSchema',
        'scope',
        'tombstones',
        'topics'
      ].sort()
    )
    expect((payload as unknown as Record<string, unknown>).wireVersion).toBeUndefined()
    expect((payload as unknown as Record<string, unknown>).digest).toBeUndefined()
    expect((payload as unknown as Record<string, unknown>).kind).toBeUndefined()
    const json = JSON.stringify(payload)
    for (const banned of [
      'pendingOutboxCount',
      'observationBinding',
      'observedLocalChannelKey',
      'observedLocalCursor',
      'unversioned',
      'excluded',
      'orphan',
      'aggregate',
      'reasons',
      'completenessReasons',
      'local_sync_baseline_candidate',
      'local-sync-baseline-v1',
      'sortOrder'
    ]) {
      expect(json).not.toContain(banned)
    }
    expect(payload.payloadSchema).toBe('chat-core-baseline-v1')
    expect(payload.inventoryVersion).toBe('topic-message-stable-block-order-v1')
    expect(payload.orderFrameVersion).toBe('parent-order-frame-v1')
    expect(payload.scope).toBe('chat-core-baseline-v1:topic-message-stable-block-order-v1')
    expect(payload.manifest).toMatchObject({
      liveCounts: { topic: 1, message: 1, messageBlock: 1 },
      tombstoneCounts: { topic: 0, message: 0, messageBlock: 0 },
      frameCounts: { topicMessage: 1, messageBlock: 1 },
      completeness: 'complete'
    })
    expect(payload.topics).toHaveLength(1)
    expect(payload.messages[0].parentMembershipClock).toEqual({ timestamp: T, operationId: 'op-m-p1' })
    expect(payload.messageBlocks[0].parentMembershipClock).toEqual({ timestamp: T, operationId: 'op-b-p1' })
    expect(Object.keys(payload.topics[0].fieldClocks).sort()).toEqual(
      ['assistantId', 'createdAt', 'deletedAt', 'isNameManuallyEdited', 'name', 'pinned', 'prompt', 'updatedAt'].sort()
    )
    expect(payload.orderFrames).toHaveLength(2)
  })

  it('maps tombstones with message_block -> messageBlock and legacy null barrier', () => {
    seedWireCompleteChain('t-t', 'm-t', 'b-t')
    sqlite
      .prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)')
      .run('tombstone:message_block:b-gone', `${T}:op-del-b`)
    sqlite
      .prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)')
      .run('tombstone:topic:t-gone', `${T - 1}`)
    seedBound()
    const candidate = captureLocalSyncBaselineCandidate(db)
    expect(candidate.completeness.state).toBe('complete')
    const payload = projectLocalBaselineToWirePayload(candidate)
    expect(() => validatePayload(payload)).not.toThrow()
    const blockTomb = payload.tombstones.find((t) => t.entityId === 'b-gone')
    expect(blockTomb?.entityType).toBe('messageBlock')
    expect(blockTomb?.deletionClock).toEqual({ timestamp: T, operationId: 'op-del-b' })
    const legacyTomb = payload.tombstones.find((t) => t.entityId === 't-gone')
    expect(legacyTomb?.deletionClock).toEqual({ timestamp: T - 1, operationId: null })
    expect(payload.manifest.tombstoneCounts).toMatchObject({ topic: 1, message: 0, messageBlock: 1 })
  })
})

describe('wire projection determinism and ordering', () => {
  it('is deterministic across captures and insertion order', () => {
    seedWireCompleteChain('t-d', 'm-d', 'b-d')
    seedBound()
    const first = captureLocalSyncBaselineCandidate(db)
    const second = captureLocalSyncBaselineCandidate(db)
    const p1 = projectLocalBaselineToWirePayload(first)
    const p2 = projectLocalBaselineToWirePayload(second)
    expect(JSON.stringify(p1)).toBe(JSON.stringify(p2))
    expect(computeWirePayloadDigest(p1)).toBe(computeWirePayloadDigest(p2))
    const shuffled = clone(first)
    shuffled.entities = [...shuffled.entities].reverse()
    shuffled.tombstones = [...shuffled.tombstones].reverse()
    shuffled.orderFrames = [...shuffled.orderFrames].reverse()
    const p3 = projectLocalBaselineToWirePayload(shuffled)
    expect(p3).toEqual(p1)
  })

  it('sorts entities UTF-8 byte-lex regardless of insertion order', () => {
    insertTopic('t-b', { ...FULL_TOPIC_EXTRA })
    insertTopic('t-a', { ...FULL_TOPIC_EXTRA })
    for (const tid of ['t-b', 't-a']) {
      seedEntityClock('topic', tid)
      seedFullTopic(tid)
      seedFrame('topicMessage', tid, [], T + 10, `op-frame-${tid}`)
    }
    seedBound()
    const candidate = captureLocalSyncBaselineCandidate(db)
    expect(candidate.completeness.state).toBe('complete')
    const payload = projectLocalBaselineToWirePayload(candidate)
    expect(payload.topics.map((t) => t.id)).toEqual(['t-a', 't-b'])
    expect(payload.orderFrames.filter((f) => f.kind === 'topicMessage').map((f) => f.parentId)).toEqual(['t-a', 't-b'])
  })

  it('uses UTF-8 byte lex (not UTF-16) for id ordering', () => {
    const idE000 = '￀'
    const id10000 = '𐀀'
    expect(id10000 < idE000).toBe(true)
    expect(compareUtf8ByteLex(idE000, id10000)).toBeLessThan(0)
    insertTopic(id10000, { ...FULL_TOPIC_EXTRA })
    insertTopic(idE000, { ...FULL_TOPIC_EXTRA })
    for (const tid of [id10000, idE000]) {
      seedEntityClock('topic', tid)
      seedFullTopic(tid)
      seedFrame('topicMessage', tid, [], T + 10, 'op-frame-x')
    }
    seedBound()
    const candidate = captureLocalSyncBaselineCandidate(db)
    expect(candidate.completeness.state).toBe('complete')
    const payload = projectLocalBaselineToWirePayload(candidate)
    expect(payload.topics.map((t) => t.id)).toEqual([idE000, id10000])
  })
})

describe('wire projection frame-aware content', () => {
  it('preserves normalized effective order including empty frames', () => {
    insertTopic('t-f', { ...FULL_TOPIC_EXTRA })
    insertMessage('m-1', 't-f')
    insertMessage('m-2', 't-f')
    insertMessage('m-3', 't-f')
    insertBlock('b-1', 'm-1')
    seedEntityClock('topic', 't-f')
    seedFullTopic('t-f')
    for (const mid of ['m-1', 'm-2', 'm-3']) {
      seedEntityClock('message', mid)
      seedFullMessage(mid)
      seedMembership('message', mid, 't-f', T, `op-${mid}`)
    }
    seedEntityClock('message_block', 'b-1')
    seedFullBlock('b-1')
    seedMembership('message_block', 'b-1', 'm-1')
    seedFrame('topicMessage', 't-f', ['m-2', 'm-1', 'm-3'], T + 10, 'op-frame-tf')
    seedFrame('messageBlock', 'm-1', ['b-1'], T + 10, 'op-frame-m1')
    seedFrame('messageBlock', 'm-2', [], T + 10, 'op-frame-m2')
    seedFrame('messageBlock', 'm-3', [], T + 10, 'op-frame-m3')
    seedBound()
    const candidate = captureLocalSyncBaselineCandidate(db)
    expect(candidate.completeness.state).toBe('complete')
    const payload = projectLocalBaselineToWirePayload(candidate)
    expect(() => validatePayload(payload)).not.toThrow()
    const topicFrame = payload.orderFrames.find((f) => f.kind === 'topicMessage' && f.parentId === 't-f')
    expect(topicFrame?.orderedChildIds).toEqual(['m-2', 'm-1', 'm-3'])
    const emptyFrame = payload.orderFrames.find((f) => f.kind === 'messageBlock' && f.parentId === 'm-2')
    expect(emptyFrame?.orderedChildIds).toEqual([])
    expect(payload.manifest.frameCounts).toEqual({ topicMessage: 1, messageBlock: 3 })
  })
})

describe('wire projection digest self-verification', () => {
  it('computes payload-only jcs-sha256-v1 digest and verifies', () => {
    seedWireCompleteChain('t-g', 'm-g', 'b-g')
    seedBound()
    const candidate = captureLocalSyncBaselineCandidate(db)
    const payload = projectLocalBaselineToWirePayload(candidate)
    const digest = computeWirePayloadDigest(payload)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(verifyWirePayloadDigest(payload, digest)).toBe(true)
    expect(verifyWirePayloadDigest(payload, 'f'.repeat(64))).toBe(false)
    const tampered = clone(payload)
    tampered.topics[0].name = 'changed'
    expect(verifyWirePayloadDigest(tampered, digest)).toBe(false)
    const canonical = canonicalizePayload(payload)
    const expected = createHash('sha256').update(canonical, 'utf8').digest('hex')
    expect(digest).toBe(expected)
  })

  it('rejects tampered manifest counts via strict validation', () => {
    seedWireCompleteChain('t-m', 'm-m', 'b-m')
    seedBound()
    const candidate = captureLocalSyncBaselineCandidate(db)
    const payload = projectLocalBaselineToWirePayload(candidate)
    const bad = clone(payload)
    bad.manifest.liveCounts.topic = 999
    expect(() => validatePayload(bad)).toThrow()
    expect(() => computeWirePayloadDigest(bad)).toThrow(SyncBaselineWireProjectionError)
  })
})

describe('wire projection rejection of illegal/incomplete candidates', () => {
  it('rejects partial candidate with transient exclusion', () => {
    insertTopic('t-e', { ...FULL_TOPIC_EXTRA })
    insertMessage('m-ok', 't-e', 'success')
    insertMessage('m-transient', 't-e', 'streaming')
    seedEntityClock('topic', 't-e')
    seedFullTopic('t-e')
    seedEntityClock('message', 'm-ok')
    seedFullMessage('m-ok')
    seedMembership('message', 'm-ok', 't-e')
    seedFrame('topicMessage', 't-e', ['m-ok'], T + 10, 'op-frame-te')
    seedFrame('messageBlock', 'm-ok', [], T + 10, 'op-frame-mok')
    seedBound()
    const candidate = captureLocalSyncBaselineCandidate(db)
    expect(candidate.completeness.state).toBe('partial')
    expect(() => projectLocalBaselineToWirePayload(candidate)).toThrow(SyncBaselineWireProjectionError)
  })

  it('rejects unbound candidate without watermark', () => {
    seedWireCompleteChain('t-u', 'm-u', 'b-u')
    const candidate = captureLocalSyncBaselineCandidate(db)
    expect(candidate.completeness.state).toBe('unbound')
    expect(() => projectLocalBaselineToWirePayload(candidate)).toThrow(SyncBaselineWireProjectionError)
  })

  it('rejects candidate with missing membership clock', () => {
    insertTopic('t-n', { ...FULL_TOPIC_EXTRA })
    insertMessage('m-n', 't-n')
    insertBlock('b-n', 'm-n')
    seedEntityClock('topic', 't-n')
    seedEntityClock('message', 'm-n')
    seedEntityClock('message_block', 'b-n')
    seedFullTopic('t-n')
    seedFullMessage('m-n')
    seedFullBlock('b-n')
    seedFrame('topicMessage', 't-n', ['m-n'], T + 10, 'op-frame-tn')
    seedFrame('messageBlock', 'm-n', ['b-n'], T + 10, 'op-frame-mn')
    seedBound()
    const candidate = captureLocalSyncBaselineCandidate(db)
    expect(candidate.completeness.state).toBe('partial')
    expect(candidate.completeness.reasons).toContain('unversioned-membership')
    expect(() => projectLocalBaselineToWirePayload(candidate)).toThrow(SyncBaselineWireProjectionError)
  })

  it('rejects candidate with missing field clock', () => {
    insertTopic('t-fc', { ...FULL_TOPIC_EXTRA })
    insertMessage('m-fc', 't-fc')
    insertBlock('b-fc', 'm-fc')
    seedEntityClock('topic', 't-fc')
    seedEntityClock('message', 'm-fc')
    seedEntityClock('message_block', 'b-fc')
    seedFullTopic('t-fc')
    seedField('message', 'm-fc', 'content')
    seedFullBlock('b-fc')
    seedMembership('message', 'm-fc', 't-fc')
    seedMembership('message_block', 'b-fc', 'm-fc')
    seedFrame('topicMessage', 't-fc', ['m-fc'], T + 10, 'op-frame-tfc')
    seedFrame('messageBlock', 'm-fc', ['b-fc'], T + 10, 'op-frame-mfc')
    seedBound()
    const candidate = captureLocalSyncBaselineCandidate(db)
    expect(candidate.completeness.state).toBe('partial')
    expect(() => projectLocalBaselineToWirePayload(candidate)).toThrow(SyncBaselineWireProjectionError)
  })

  it('rejects wrong kind/version and membership parent mismatch', () => {
    seedWireCompleteChain('t-v', 'm-v', 'b-v')
    seedBound()
    const candidate = captureLocalSyncBaselineCandidate(db)
    const wrongKind = clone(candidate)
    wrongKind.kind = 'wrong_kind'
    expect(() => projectLocalBaselineToWirePayload(wrongKind)).toThrow(SyncBaselineWireProjectionError)
    const wrongSchema = clone(candidate)
    wrongSchema.schemaVersion = 'wrong-v1'
    expect(() => projectLocalBaselineToWirePayload(wrongSchema)).toThrow(SyncBaselineWireProjectionError)
    const mismatch = clone(candidate)
    const msg = mismatch.entities.find((e) => e.entityType === 'message')
    msg!.parentMembershipClock = { parentId: 't-other', timestamp: T, operationId: 'op-m-v' }
    expect(() => projectLocalBaselineToWirePayload(mismatch)).toThrow(SyncBaselineWireProjectionError)
  })

  it('rejects tampered complete flag with missing clocks (type-boundary provable failure)', () => {
    seedWireCompleteChain('t-tp', 'm-tp', 'b-tp')
    seedBound()
    const candidate = captureLocalSyncBaselineCandidate(db)
    const tampered = clone(candidate)
    const msg = tampered.entities.find((e) => e.entityType === 'message')
    msg!.parentMembershipClock = null
    tampered.completeness.state = 'complete' as unknown as LocalSyncBaselineCandidate['completeness']['state']
    tampered.completeness.reasons = []
    expect(() => projectLocalBaselineToWirePayload(tampered)).toThrow(SyncBaselineWireProjectionError)
  })
})
