/**
 * Receiver-first `message_stable_replace` apply slice (SYNC-DATA-050–054 /
 * SYNC-CC-025, no issuer / no attempt intent / no baseline v2).
 *
 * Covers: shared-validator-before-branching with an explicit new branch;
 * one BEGIN IMMEDIATE transaction atomically settling message/block entity +
 * field clocks, memberships, retirement tombstones + row removal, the winning
 * register, both winning frames, dense sortOrders, and sync_applied; full
 * rollback on mismatch/incomplete; losing/higher/equal-divergence/exact
 * replay; old-generation late-upsert suppression; later-membership suffix
 * survival; message/topic tombstone precedence; unknown-parent orphan;
 * crafted enqueue acceptance with no local aggregate emission; transient /
 * excluded fail-closed; crafted dual-profile relay convergence with
 * post-retry idempotency.
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

import { validateSyncOperationStrict } from '@shared/sync'

import { createRelayServer, ensureRelaySchema } from '../../../../../scripts/sync-relay/server'
import { chatDbService } from '../../chatDb'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { SyncOrphanError, SyncService, syncService } from '../SyncService'
import { seedRegisteredAttachedSyncService } from './helpers/syncTestRegistration'

function openChatDb(): { sqlite: Database.Database; db: BetterSQLite3Database<typeof schema> } {
  const sqlite = new Database(':memory:')
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  runMigrations(db as never, sqlite)
  return { sqlite, db }
}

function bindSingleton(sqlite: Database.Database, db: BetterSQLite3Database<typeof schema>): void {
  ;(chatDbService as unknown as { sqlite: unknown }).sqlite = sqlite
  ;(chatDbService as unknown as { db: unknown }).db = db
}

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
  configStore.set('sync:token', '')
  const opened = openChatDb()
  sqlite = opened.sqlite
  db = opened.db
  bindSingleton(sqlite, db)
  syncService.clearAllForTests()
  seedRegisteredAttachedSyncService(configStore, db)
})

afterEach(() => {
  vi.restoreAllMocks()
  try {
    sqlite.close()
  } catch {}
  ;(chatDbService as never as { sqlite: unknown }).sqlite = null
  ;(chatDbService as never as { db: unknown }).db = null
})

// ---------------------------------------------------------------------------
// Seeds / readers
// ---------------------------------------------------------------------------

function seedTopic(id: string): void {
  sqlite
    .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
    .run(id, `topic-${id}`, '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z')
}

function seedMessage(id: string, topicId: string, content: string, status = 'success', sortOrder = 0): void {
  sqlite
    .prepare(
      `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    )
    .run(
      id,
      topicId,
      'assistant',
      content,
      status,
      'a-1',
      'm',
      'mid',
      'as-1',
      '2026-09-12T00:00:00.000Z',
      '2026-09-12T00:00:00.000Z',
      sortOrder
    )
}

function seedBlock(
  id: string,
  messageId: string,
  content: string,
  type = 'text',
  status = 'success',
  sortOrder = 0
): void {
  sqlite
    .prepare(
      `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    )
    .run(id, messageId, type, content, status, '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z', sortOrder)
}

function seedMembership(
  childType: 'message' | 'message_block',
  childId: string,
  parentId: string,
  ts: number,
  opId: string
): void {
  sqlite
    .prepare(
      `INSERT INTO sync_membership_clock (child_entity_type, child_entity_id, parent_id, timestamp, operation_id) VALUES (?, ?, ?, ?, ?)`
    )
    .run(childType, childId, parentId, ts, opId)
}

function getMessage(id: string): Record<string, unknown> | undefined {
  return sqlite.prepare(`SELECT * FROM messages WHERE id=?`).get(id) as Record<string, unknown> | undefined
}

function getBlock(id: string): Record<string, unknown> | undefined {
  return sqlite.prepare(`SELECT * FROM message_blocks WHERE id=?`).get(id) as Record<string, unknown> | undefined
}

function blockOrder(messageId: string): string[] {
  return (
    sqlite
      .prepare(`SELECT id FROM message_blocks WHERE message_id=? ORDER BY sort_order ASC, id ASC`)
      .all(messageId) as Array<{ id: string }>
  ).map((r) => r.id)
}

function messageOrder(topicId: string): string[] {
  return (
    sqlite.prepare(`SELECT id FROM messages WHERE topic_id=? ORDER BY sort_order ASC, id ASC`).all(topicId) as Array<{
      id: string
    }>
  ).map((r) => r.id)
}

function getRegister(messageId: string): Record<string, unknown> | undefined {
  return sqlite.prepare(`SELECT * FROM sync_stable_replace_register WHERE message_id=?`).get(messageId) as
    | Record<string, unknown>
    | undefined
}

function getTombstoneValue(entityType: string, entityId: string): string | undefined {
  const prefix =
    entityType === 'topic'
      ? 'tombstone:topic:'
      : entityType === 'message'
        ? 'tombstone:message:'
        : 'tombstone:message_block:'
  const row = sqlite.prepare(`SELECT value FROM sync_state WHERE key=?`).get(`${prefix}${entityId}`) as
    | { value: string }
    | undefined
  return row?.value
}

function getFrame(kind: string, parentId: string): { ordered: string[]; ts: number; op: string } | null {
  const r = sqlite
    .prepare(
      `SELECT ordered_child_ids_json AS json, timestamp AS ts, operation_id AS op FROM sync_parent_order_frame WHERE kind=? AND parent_id=?`
    )
    .get(kind, parentId) as { json: string; ts: number; op: string } | undefined
  if (!r) return null
  return { ordered: JSON.parse(r.json) as string[], ts: r.ts, op: r.op }
}

function appliedHas(opId: string): boolean {
  return sqlite.prepare(`SELECT 1 FROM sync_applied WHERE operation_id=?`).get(opId) !== undefined
}

// ---------------------------------------------------------------------------
// Op builder (mirrors the locked eight-key contract)
// ---------------------------------------------------------------------------

function clock(ts: number, opId: string): Record<string, unknown> {
  return { timestamp: ts, operationId: opId }
}

const MESSAGE_FIELDS = [
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
const BLOCK_FIELDS = ['type', 'content', 'status', 'createdAt', 'updatedAt']

function fieldClocks(keys: string[], ts: number, opId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) out[k] = clock(ts, opId)
  return out
}

interface ReplaceBlockSpec {
  id: string
  content: string
  memTs: number
  memOp: string
}

function makeReplaceOp(args: {
  id: string
  ts: number
  device?: string
  messageId?: string
  topicId?: string
  content?: string
  status?: string
  blocks?: ReplaceBlockSpec[]
  activeOrder?: string[]
  topicOrder?: string[]
  memTs?: number
  memOp?: string
}): Record<string, unknown> {
  const id = args.id
  const ts = args.ts
  const messageId = args.messageId ?? 'm-1'
  const topicId = args.topicId ?? 't-1'
  const blocks = args.blocks ?? [{ id: 'b-1', content: 'new-b1', memTs: ts, memOp: id }]
  const activeOrder = args.activeOrder ?? blocks.map((b) => b.id)
  const topicOrder = args.topicOrder ?? ['m-0', messageId]
  return {
    id,
    entityType: 'message',
    op: 'message_stable_replace',
    entityId: messageId,
    timestamp: ts,
    deviceId: args.device ?? 'device-craft',
    payload: {
      replaceVersion: 'message-stable-replace-v1',
      messageId,
      replacementClock: clock(ts, id),
      message: {
        id: messageId,
        topicId,
        role: 'assistant',
        content: args.content ?? 'new-content',
        status: args.status ?? 'success',
        askId: 'a-1',
        model: 'm',
        modelId: 'mid',
        assistantId: 'as-1',
        createdAt: '2026-09-12T00:00:00.000Z',
        updatedAt: '2026-09-12T00:00:01.000Z',
        entityClock: clock(ts, id),
        fieldClocks: fieldClocks(MESSAGE_FIELDS, ts, id),
        parentMembershipClock: clock(args.memTs ?? 500, args.memOp ?? 'create-m1')
      },
      messageBlocks: [...blocks]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((b) => ({
          id: b.id,
          messageId,
          type: 'text',
          content: b.content,
          status: 'success',
          createdAt: '2026-09-12T00:00:00.000Z',
          updatedAt: '2026-09-12T00:00:01.000Z',
          entityClock: clock(ts, id),
          fieldClocks: fieldClocks(BLOCK_FIELDS, ts, id),
          parentMembershipClock: clock(b.memTs, b.memOp)
        })),
      activeBlockIds: [...activeOrder],
      topicFrame: {
        frameVersion: 'parent-order-frame-v1',
        kind: 'topicMessage',
        parentId: topicId,
        orderedChildIds: [...topicOrder],
        frameClock: clock(ts, id)
      },
      messageFrame: {
        frameVersion: 'parent-order-frame-v1',
        kind: 'messageBlock',
        parentId: messageId,
        orderedChildIds: [...activeOrder],
        frameClock: clock(ts, id)
      }
    }
  }
}

/** Baseline local state: topic t-1 with sibling m-0 and target m-1 + old block b-old. */
function seedBaseline(): void {
  seedTopic('t-1')
  seedMessage('m-0', 't-1', 'sibling', 'success', 0)
  seedMembership('message', 'm-0', 't-1', 400, 'create-m0')
  seedMessage('m-1', 't-1', 'old-content', 'success', 1)
  seedMembership('message', 'm-1', 't-1', 500, 'create-m1')
  seedBlock('b-old', 'm-1', 'old-block', 'text', 'success', 0)
  seedMembership('message_block', 'b-old', 'm-1', 600, 'create-bold')
}

describe('message_stable_replace apply', () => {
  it('applies success atomically: state, register, retirement, frames, dense order, applied', () => {
    seedBaseline()
    const op = makeReplaceOp({
      id: 'rep-1',
      ts: 1000,
      blocks: [
        { id: 'b-1', content: 'new-b1', memTs: 1000, memOp: 'rep-1' },
        { id: 'b-2', content: 'new-b2', memTs: 1000, memOp: 'rep-1' }
      ],
      activeOrder: ['b-2', 'b-1']
    })
    expect(validateSyncOperationStrict(op)).toBeNull()
    const won = syncService.applyIncomingOperation(op as never)
    expect(won).toBe(true)
    // Message full-state + clocks
    expect((getMessage('m-1') as { content: string }).content).toBe('new-content')
    const entityClock = db
      .select()
      .from(schema.syncEntityClock)
      .all()
      .find((r) => r.entityType === 'message' && r.entityId === 'm-1')
    expect(entityClock?.timestamp).toBe(1000)
    expect(entityClock?.operationId).toBe('rep-1')
    expect(
      db
        .select()
        .from(schema.syncFieldClock)
        .all()
        .filter((r) => r.entityType === 'message' && r.entityId === 'm-1')
    ).toHaveLength(9)
    // Membership retained for message, minted for new blocks
    const mem = syncService.getMembershipClock('message', 'm-1')
    expect(mem).toEqual({ parentId: 't-1', timestamp: 500, operationId: 'create-m1' })
    expect(syncService.getMembershipClock('message_block', 'b-1')).toEqual({
      parentId: 'm-1',
      timestamp: 1000,
      operationId: 'rep-1'
    })
    // New blocks created; old block retired (row removed + barrier at rc)
    expect((getBlock('b-1') as { content: string }).content).toBe('new-b1')
    expect((getBlock('b-2') as { content: string }).content).toBe('new-b2')
    expect(getBlock('b-old')).toBeUndefined()
    expect(getTombstoneValue('message_block', 'b-old')).toBe('1000:rep-1')
    // Register row
    const reg = getRegister('m-1')
    expect(reg?.timestamp).toBe(1000)
    expect(reg?.operation_id).toBe('rep-1')
    expect(JSON.parse(reg?.active_block_ids_json as string)).toEqual(['b-2', 'b-1'])
    expect(typeof reg?.payload_hash).toBe('string')
    // Frames persisted as winners + dense orders
    expect(getFrame('topicMessage', 't-1')).toEqual({ ordered: ['m-0', 'm-1'], ts: 1000, op: 'rep-1' })
    expect(getFrame('messageBlock', 'm-1')).toEqual({ ordered: ['b-2', 'b-1'], ts: 1000, op: 'rep-1' })
    expect(messageOrder('t-1')).toEqual(['m-0', 'm-1'])
    expect(blockOrder('m-1')).toEqual(['b-2', 'b-1'])
    expect(appliedHas('rep-1')).toBe(true)
  })

  it('rolls back fully on incomplete frame (live sibling omitted)', () => {
    seedBaseline()
    seedMessage('m-extra', 't-1', 'extra', 'success', 2)
    seedMembership('message', 'm-extra', 't-1', 700, 'create-mextra')
    const op = makeReplaceOp({ id: 'rep-bad', ts: 1000, topicOrder: ['m-0', 'm-1'] })
    expect(() => syncService.applyIncomingOperation(op as never)).toThrow(/incomplete/)
    // Nothing materialized
    expect((getMessage('m-1') as { content: string }).content).toBe('old-content')
    expect(getBlock('b-old')).toBeDefined()
    expect(getRegister('m-1')).toBeUndefined()
    expect(getTombstoneValue('message_block', 'b-old')).toBeUndefined()
    expect(getFrame('topicMessage', 't-1')).toBeNull()
    expect(getFrame('messageBlock', 'm-1')).toBeNull()
    expect(appliedHas('rep-bad')).toBe(false)
  })

  it('losing replacement is consumed; higher wins; exact replay idempotent; equal-clock divergence fails closed', () => {
    seedBaseline()
    const high = makeReplaceOp({ id: 'rep-high', ts: 2000, content: 'high-content' })
    expect(syncService.applyIncomingOperation(high as never)).toBe(true)
    const low = makeReplaceOp({ id: 'rep-low', ts: 1000, content: 'low-content' })
    expect(syncService.applyIncomingOperation(low as never)).toBe(false)
    expect((getMessage('m-1') as { content: string }).content).toBe('high-content')
    expect(appliedHas('rep-low')).toBe(true)
    expect((getRegister('m-1') as { timestamp: number }).timestamp).toBe(2000)
    // Exact replay of the winner is idempotent
    const replay = makeReplaceOp({ id: 'rep-high', ts: 2000, content: 'high-content' })
    expect(syncService.applyIncomingOperation(replay as never)).toBe(false)
    expect((getMessage('m-1') as { content: string }).content).toBe('high-content')
    // Equal-clock semantic divergence fails closed with no cursor-level persist
    const divergent = makeReplaceOp({ id: 'rep-high', ts: 2000, content: 'other-content' })
    expect(() => syncService.applyIncomingOperation(divergent as never)).toThrow(/divergence/)
    expect((getMessage('m-1') as { content: string }).content).toBe('high-content')
    expect(appliedHas('rep-high')).toBe(true)
  })

  it('later higher replacement wins and retires the previous active set', () => {
    seedBaseline()
    const first = makeReplaceOp({
      id: 'rep-a',
      ts: 1000,
      blocks: [{ id: 'b-1', content: 'v1', memTs: 1000, memOp: 'rep-a' }]
    })
    expect(syncService.applyIncomingOperation(first as never)).toBe(true)
    expect(getBlock('b-old')).toBeUndefined()
    const second = makeReplaceOp({
      id: 'rep-b',
      ts: 2000,
      content: 'v2',
      blocks: [{ id: 'b-9', content: 'v2b', memTs: 2000, memOp: 'rep-b' }]
    })
    expect(syncService.applyIncomingOperation(second as never)).toBe(true)
    expect((getMessage('m-1') as { content: string }).content).toBe('v2')
    // b-1 retired via previous-register derivation even though no local row references it beyond the register
    expect(getBlock('b-1')).toBeUndefined()
    expect(getTombstoneValue('message_block', 'b-1')).toBe('2000:rep-b')
    expect((getBlock('b-9') as { content: string }).content).toBe('v2b')
    expect(getFrame('messageBlock', 'm-1')).toEqual({ ordered: ['b-9'], ts: 2000, op: 'rep-b' })
    expect(blockOrder('m-1')).toEqual(['b-9'])
  })

  it('old-generation late block upsert stays suppressed after replacement', () => {
    seedBaseline()
    const op = makeReplaceOp({ id: 'rep-1', ts: 1000 })
    expect(syncService.applyIncomingOperation(op as never)).toBe(true)
    // Late stale upsert for the retired block (clock <= replacementClock) loses to the barrier.
    const stale = {
      id: 'stale-upsert-1',
      entityType: 'message_block',
      op: 'upsert',
      entityId: 'b-old',
      timestamp: 900,
      deviceId: 'other',
      payload: { id: 'b-old', messageId: 'm-1', type: 'text', content: 'resurrected', status: 'success' }
    }
    expect(syncService.applyIncomingOperation(stale as never)).toBe(false)
    expect(getBlock('b-old')).toBeUndefined()
    expect(getTombstoneValue('message_block', 'b-old')).toBe('1000:rep-1')
  })

  it('later-membership block survives via deterministic suffix', () => {
    seedTopic('t-1')
    seedMessage('m-0', 't-1', 'sibling', 'success', 0)
    seedMembership('message', 'm-0', 't-1', 400, 'create-m0')
    seedMessage('m-1', 't-1', 'old-content', 'success', 1)
    seedMembership('message', 'm-1', 't-1', 500, 'create-m1')
    // A newer local block (membership 1500 > incoming replacementClock 1000) is omitted from active.
    seedBlock('b-late', 'm-1', 'late-block', 'text', 'success', 5)
    seedMembership('message_block', 'b-late', 'm-1', 1500, 'late-op')
    const op = makeReplaceOp({ id: 'rep-1', ts: 1000 })
    expect(syncService.applyIncomingOperation(op as never)).toBe(true)
    // Survivor: row kept, no tombstone, appended after the active set deterministically.
    expect((getBlock('b-late') as { content: string }).content).toBe('late-block')
    expect(getTombstoneValue('message_block', 'b-late')).toBeUndefined()
    expect(getFrame('messageBlock', 'm-1')).toEqual({ ordered: ['b-1', 'b-late'], ts: 1000, op: 'rep-1' })
    expect(blockOrder('m-1')).toEqual(['b-1', 'b-late'])
  })

  it('post-replacement ordinary create survives and exact replay stays idempotent', () => {
    seedBaseline()
    const op = makeReplaceOp({ id: 'rep-1', ts: 1000 })
    expect(syncService.applyIncomingOperation(op as never)).toBe(true)
    const fresh = {
      id: 'fresh-upsert-1',
      entityType: 'message_block',
      op: 'upsert',
      entityId: 'b-fresh',
      timestamp: 1500,
      deviceId: 'other',
      payload: { id: 'b-fresh', messageId: 'm-1', type: 'text', content: 'fresh', status: 'success' }
    }
    expect(syncService.applyIncomingOperation(fresh as never)).toBe(true)
    expect((getBlock('b-fresh') as { content: string }).content).toBe('fresh')
    const replay = makeReplaceOp({ id: 'rep-1', ts: 1000 })
    expect(syncService.applyIncomingOperation(replay as never)).toBe(false)
    expect(getBlock('b-fresh')).toBeDefined()
    expect((getMessage('m-1') as { content: string }).content).toBe('new-content')
  })

  it('message tombstone: lower replacement consumed, higher wins (legacy-null strong barrier)', () => {
    seedBaseline()
    // Legacy-null barrier at T=3000 suppresses everything at or below.
    sqlite.prepare(`INSERT INTO sync_state (key, value) VALUES (?, ?)`).run('tombstone:message:m-1', '3000:null')
    const low = makeReplaceOp({ id: 'rep-low', ts: 2000 })
    expect(syncService.applyIncomingOperation(low as never)).toBe(false)
    expect((getMessage('m-1') as { content: string }).content).toBe('old-content')
    expect(getRegister('m-1')).toBeUndefined()
    expect(appliedHas('rep-low')).toBe(true)
    const high = makeReplaceOp({ id: 'rep-high', ts: 4000 })
    expect(syncService.applyIncomingOperation(high as never)).toBe(true)
    expect((getMessage('m-1') as { content: string }).content).toBe('new-content')
  })

  it('unknown topic without covering tombstone is orphan; covering tombstone consumes', () => {
    const orphan = makeReplaceOp({ id: 'rep-orphan', ts: 1000, topicId: 't-missing' })
    expect(() => syncService.applyIncomingOperation(orphan as never)).toThrow(SyncOrphanError)
    expect(getRegister('m-1')).toBeUndefined()
    expect(appliedHas('rep-orphan')).toBe(false)
    // Covering topic tombstone: consumed with no materialization.
    sqlite
      .prepare(`INSERT INTO sync_state (key, value) VALUES (?, ?)`)
      .run('tombstone:topic:t-missing', '2000:del-topic-1')
    const covered = makeReplaceOp({ id: 'rep-covered', ts: 1000, topicId: 't-missing' })
    expect(syncService.applyIncomingOperation(covered as never)).toBe(false)
    expect(getMessage('m-1')).toBeUndefined()
    expect(appliedHas('rep-covered')).toBe(true)
  })

  it('transient and excluded bundled members fail closed before any materialization', () => {
    seedBaseline()
    const transient = makeReplaceOp({ id: 'rep-trans', ts: 1000, status: 'streaming' })
    expect(validateSyncOperationStrict(transient)).not.toBeNull()
    expect(() => syncService.applyIncomingOperation(transient as never)).toThrow()
    expect((getMessage('m-1') as { content: string }).content).toBe('old-content')
    expect(getRegister('m-1')).toBeUndefined()
    expect(appliedHas('rep-trans')).toBe(false)
    const excluded = makeReplaceOp({ id: 'rep-excl', ts: 1000 })
    const xp = excluded.payload as Record<string, unknown>
    ;(xp.messageBlocks as Record<string, unknown>[])[0].type = 'tool'
    expect(validateSyncOperationStrict(excluded)).not.toBeNull()
    expect(() => syncService.applyIncomingOperation(excluded as never)).toThrow()
    expect(getRegister('m-1')).toBeUndefined()
  })

  it('losing bundled frames never overwrite newer winning frames', () => {
    seedBaseline()
    // Newer winning frames established first via ordinary order_frame ops.
    const topicFrameOp = {
      id: 'frame-newer-topic',
      entityType: 'topic',
      op: 'order_frame',
      entityId: 't-1',
      timestamp: 5000,
      deviceId: 'other',
      payload: {
        frameVersion: 'parent-order-frame-v1',
        kind: 'topicMessage',
        parentId: 't-1',
        orderedChildIds: ['m-0', 'm-1'],
        frameClock: { timestamp: 5000, operationId: 'frame-newer-topic' }
      }
    }
    expect(syncService.applyIncomingOperation(topicFrameOp as never)).toBe(true)
    const op = makeReplaceOp({ id: 'rep-1', ts: 1000 })
    expect(syncService.applyIncomingOperation(op as never)).toBe(true)
    // Bundled topicFrame (1000) loses to the newer winner (5000); bundled
    // messageFrame (1000) wins trivially (no prior winner) and materializes.
    expect(getFrame('topicMessage', 't-1')).toEqual({ ordered: ['m-0', 'm-1'], ts: 5000, op: 'frame-newer-topic' })
    expect(getFrame('messageBlock', 'm-1')).toEqual({ ordered: ['b-1'], ts: 1000, op: 'rep-1' })
    // Register still records the winning replacement.
    expect((getRegister('m-1') as { timestamp: number }).timestamp).toBe(1000)
  })

  it('enqueue strictly accepts a crafted op; ordinary aggregates emit none', () => {
    seedBaseline()
    const op = makeReplaceOp({ id: 'rep-enq', ts: 1000 })
    expect(validateSyncOperationStrict(op)).toBeNull()
    syncService.enqueueOperation(op as never)
    const rows = db.select().from(schema.syncOutbox).all()
    expect(rows.some((r) => r.op === 'message_stable_replace' && r.id === 'rep-enq')).toBe(true)
    // Ordinary local aggregates emit no stable_replace: upserts + deletes only.
    syncService.recordUpsert('message', 'm-1', { id: 'm-1', topicId: 't-1', content: 'edit' } as never, 1100)
    syncService.recordDelete('message_block', 'b-old', 1100)
    const after = db.select().from(schema.syncOutbox).all()
    expect(after.filter((r) => r.op === 'message_stable_replace')).toHaveLength(1)
  })

  it('reparent via replacement fails closed with full rollback', () => {
    seedTopic('t-1')
    seedTopic('t-2')
    seedMessage('m-1', 't-2', 'elsewhere', 'success', 0)
    seedMembership('message', 'm-1', 't-2', 500, 'create-m1')
    const op = makeReplaceOp({ id: 'rep-reparent', ts: 1000, topicId: 't-1' })
    expect(() => syncService.applyIncomingOperation(op as never)).toThrow(/reparent/)
    expect((getMessage('m-1') as { topic_id: string }).topic_id).toBe('t-2')
    expect(getRegister('m-1')).toBeUndefined()
    expect(appliedHas('rep-reparent')).toBe(false)
  })
})

describe('message_stable_replace dual-profile relay convergence', () => {
  const relayDbs: Database.Database[] = []
  const relayServers: Array<{ close: (cb?: () => void) => void }> = []

  afterEach(async () => {
    for (const s of relayServers.splice(0, relayServers.length)) {
      await new Promise<void>((resolve) => {
        try {
          s.close(() => resolve())
        } catch {
          resolve()
        }
      })
    }
    for (const d of relayDbs.splice(0, relayDbs.length)) {
      try {
        d.close()
      } catch {}
    }
  })

  it('crafted op converges on both profiles via the real relay with retry idempotency', async () => {
    const rdb = new Database(':memory:')
    relayDbs.push(rdb)
    ensureRelaySchema(rdb)
    const server = createRelayServer(rdb, { token: 'stable-dual-token' })
    relayServers.push(server as unknown as { close: (cb?: () => void) => void })
    await new Promise<void>((resolve) => {
      ;(server as unknown as { listen: (p: number, h: string, cb: () => void) => void }).listen(0, '127.0.0.1', () =>
        resolve()
      )
    })
    const base = `http://127.0.0.1:${(server as unknown as { address: () => { port: number } }).address().port}`
    const auth = { Authorization: 'Bearer stable-dual-token', 'Content-Type': 'application/json' } as Record<
      string,
      string
    >
    const regA = (await (
      await fetch(`${base}/sync/register`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ deviceId: 'device-stable-a' })
      })
    ).json()) as { deviceCode: string; deviceSecret: string }
    const regB = (await (
      await fetch(`${base}/sync/register`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ deviceId: 'device-stable-b' })
      })
    ).json()) as { deviceCode: string; deviceSecret: string }
    const authed = (code: string, secret: string): Record<string, string> => ({
      Authorization: 'Bearer stable-dual-token',
      'Content-Type': 'application/json',
      'x-sync-device-code': code,
      'x-sync-device-secret': secret
    })
    let res = await fetch(`${base}/sync/pair/request`, {
      method: 'POST',
      headers: authed(regA.deviceCode, regA.deviceSecret),
      body: JSON.stringify({ targetCode: regB.deviceCode })
    })
    expect(res.status).toBe(200)
    const reqBody = (await res.json()) as { requestId: string }
    res = await fetch(`${base}/sync/pair/accept`, {
      method: 'POST',
      headers: authed(regB.deviceCode, regB.deviceSecret),
      body: JSON.stringify({ requestId: reqBody.requestId })
    })
    expect(res.status).toBe(200)

    // Both profiles start from the same old stable state.
    const openedA = openChatDb()
    const openedB = openChatDb()
    for (const opened of [openedA, openedB]) {
      bindSingleton(opened.sqlite, opened.db)
      const s = opened.sqlite
      s.prepare(
        `INSERT INTO topics (id, name, created_at, updated_at) VALUES ('t-1', 'topic-t-1', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z')`
      ).run()
      s.prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES ('m-1', 't-1', 'assistant', 'old-content', 'success', 'a-1', 'm', 'mid', 'as-1', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z', 0, NULL)`
      ).run()
      s.prepare(
        `INSERT INTO sync_membership_clock (child_entity_type, child_entity_id, parent_id, timestamp, operation_id) VALUES ('message', 'm-1', 't-1', 500, 'create-m1')`
      ).run()
      s.prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES ('b-old', 'm-1', 'text', 'old-block', 'success', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z', 0, NULL)`
      ).run()
      s.prepare(
        `INSERT INTO sync_membership_clock (child_entity_type, child_entity_id, parent_id, timestamp, operation_id) VALUES ('message_block', 'b-old', 'm-1', 600, 'create-bold')`
      ).run()
    }

    // Profile A crafts the replacement (strictly accepted, outbox-only) and pushes it.
    bindSingleton(openedA.sqlite, openedA.db)
    const svcA = new SyncService()
    const crafted = makeReplaceOp({
      id: 'rep-dual-1',
      ts: 1000,
      device: 'device-stable-a',
      blocks: [{ id: 'b-1', content: 'new-b1', memTs: 1000, memOp: 'rep-dual-1' }],
      topicOrder: ['m-1']
    })
    svcA.enqueueOperation(crafted as never)
    const outboxA = openedA.db.select().from(schema.syncOutbox).all()
    expect(outboxA).toHaveLength(1)
    const opsA = outboxA.map((r) => ({
      id: r.id,
      entityType: r.entityType,
      op: r.op,
      entityId: r.entityId,
      timestamp: r.timestamp,
      deviceId: r.deviceId,
      ...(r.payloadJson ? { payload: JSON.parse(r.payloadJson) } : {})
    }))
    res = await fetch(`${base}/sync/push`, {
      method: 'POST',
      headers: authed(regA.deviceCode, regA.deviceSecret),
      body: JSON.stringify({ deviceId: 'device-stable-a', operations: opsA })
    })
    expect(res.status).toBe(200)

    // Profile B pulls and applies; retry of the same page stays idempotent.
    bindSingleton(openedB.sqlite, openedB.db)
    const svcB = new SyncService()
    for (let attempt = 0; attempt < 2; attempt++) {
      const pullRes = await fetch(`${base}/sync/pull?cursor=0&deviceId=device-stable-b`, {
        headers: authed(regB.deviceCode, regB.deviceSecret)
      })
      expect(pullRes.status).toBe(200)
      const body = (await pullRes.json()) as { operations: Array<Record<string, unknown>>; cursor: number }
      expect(body.operations).toHaveLength(1)
      for (const op of body.operations) {
        svcB.applyIncomingOperation(op as never)
      }
    }
    const contentB = (
      openedB.sqlite.prepare(`SELECT content FROM messages WHERE id='m-1'`).get() as { content: string }
    ).content
    expect(contentB).toBe('new-content')
    expect(
      openedB.sqlite.prepare(`SELECT id FROM message_blocks WHERE message_id='m-1' ORDER BY sort_order`).all()
    ).toEqual([{ id: 'b-1' }])
    expect(
      openedB.sqlite.prepare(`SELECT * FROM sync_stable_replace_register WHERE message_id='m-1'`).get()
    ).toBeDefined()

    // Profile A applies its own crafted echo and converges to the same logical state.
    bindSingleton(openedA.sqlite, openedA.db)
    svcA.applyIncomingOperation(crafted as never)
    const contentA = (
      openedA.sqlite.prepare(`SELECT content FROM messages WHERE id='m-1'`).get() as { content: string }
    ).content
    expect(contentA).toBe('new-content')
    const regArow = openedA.sqlite
      .prepare(`SELECT payload_hash FROM sync_stable_replace_register WHERE message_id='m-1'`)
      .get() as { payload_hash: string }
    const regBrow = openedB.sqlite
      .prepare(`SELECT payload_hash FROM sync_stable_replace_register WHERE message_id='m-1'`)
      .get() as { payload_hash: string }
    expect(regArow.payload_hash).toBe(regBrow.payload_hash)
    openedA.sqlite.close()
    openedB.sqlite.close()
  })
})
