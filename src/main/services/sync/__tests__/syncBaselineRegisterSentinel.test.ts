/**
 * Baseline-register sentinel follow-up (SYNC-DATA-056 `payload_hash` source
 * confusion fix): the wire `replacementRegisters` carry only the three locked
 * keys, so a baseline bootstrap writes the source-prefixed sentinel (never a
 * bundled-winner hash) and the first same-clock / same-active valid
 * `message_stable_replace` op upgrades it to the real winner hash.
 *
 * Covers: sentinel encoding unmistakable from 64hex winner hashes; bootstrap
 * marker → same clock/same active valid op upgrades to the real hash with a
 * second replay idempotent; marker → same clock/different active fails closed
 * with rollback; post-upgrade same clock/same active/different bundle fails
 * closed; baseline equal-clock never overwrites an existing real winner.
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

import {
  BASELINE_REGISTER_SENTINEL_PREFIX,
  encodeBaselineRegisterSentinel,
  isBaselineRegisterSentinel,
  validateSyncOperationStrict
} from '@shared/sync'

import { chatDbService } from '../../chatDb'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { mergeValidatedBaselineInTx } from '../syncBaselineApply'
import { syncService } from '../SyncService'
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
// Seeds / readers (mirrors syncStableReplace.test.ts baseline shape)
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

function getRegister(messageId: string): Record<string, unknown> | undefined {
  return sqlite.prepare(`SELECT * FROM sync_stable_replace_register WHERE message_id=?`).get(messageId) as
    | Record<string, unknown>
    | undefined
}

function appliedHas(opId: string): boolean {
  return sqlite.prepare(`SELECT 1 FROM sync_applied WHERE operation_id=?`).get(opId) !== undefined
}

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
  blocks?: ReplaceBlockSpec[]
  activeOrder?: string[]
  topicOrder?: string[]
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
        status: 'success',
        askId: 'a-1',
        model: 'm',
        modelId: 'mid',
        assistantId: 'as-1',
        createdAt: '2026-09-12T00:00:00.000Z',
        updatedAt: '2026-09-12T00:00:01.000Z',
        entityClock: clock(ts, id),
        fieldClocks: fieldClocks(MESSAGE_FIELDS, ts, id),
        parentMembershipClock: clock(500, 'create-m1')
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

function mergeMarkerRegister(messageId: string, ts: number, op: string, active: string[]): void {
  db.transaction((tx) => {
    mergeValidatedBaselineInTx(tx as never, {
      entities: [],
      tombstones: [],
      orderFrames: [],
      replacementRegisters: [{ messageId, timestamp: ts, operationId: op, activeBlockIds: [...active] }]
    })
  })
}

const TS = 1000
const OP = 'rep-1'
const ACTIVE = ['b-2', 'b-1']

function makeBundledOp(content: string): Record<string, unknown> {
  return makeReplaceOp({
    id: OP,
    ts: TS,
    content,
    blocks: [
      { id: 'b-1', content: 'new-b1', memTs: TS, memOp: OP },
      { id: 'b-2', content: 'new-b2', memTs: TS, memOp: OP }
    ],
    activeOrder: [...ACTIVE]
  })
}

describe('baseline-register sentinel', () => {
  it('sentinel encoding carries the source prefix and never looks like a 64hex winner hash', () => {
    const a = encodeBaselineRegisterSentinel('m-1', TS, OP, [...ACTIVE])
    const b = encodeBaselineRegisterSentinel('m-1', TS, OP, [...ACTIVE])
    expect(a).toBe(b)
    expect(a.startsWith(BASELINE_REGISTER_SENTINEL_PREFIX)).toBe(true)
    expect(isBaselineRegisterSentinel(a)).toBe(true)
    expect(/^[0-9a-f]{64}$/.test(a)).toBe(false)
    // Deterministic coverage of the three locked keys: any key change moves the marker.
    expect(encodeBaselineRegisterSentinel('m-2', TS, OP, [...ACTIVE])).not.toBe(a)
    expect(encodeBaselineRegisterSentinel('m-1', TS + 1, OP, [...ACTIVE])).not.toBe(a)
    expect(encodeBaselineRegisterSentinel('m-1', TS, 'rep-2', [...ACTIVE])).not.toBe(a)
    expect(encodeBaselineRegisterSentinel('m-1', TS, OP, ['b-1', 'b-2'])).not.toBe(a)
    // Real winner hashes and legacy test hashes are not sentinels.
    expect(isBaselineRegisterSentinel('a'.repeat(64))).toBe(false)
    expect(isBaselineRegisterSentinel('hash-m-1-rep-1')).toBe(false)
    expect(isBaselineRegisterSentinel(null)).toBe(false)
  })

  it('bootstrap marker upgrades to the real winner hash on the same clock/same active valid op, then replays idempotent', () => {
    seedBaseline()
    mergeMarkerRegister('m-1', TS, OP, [...ACTIVE])
    const marker = getRegister('m-1')
    expect(marker).toBeDefined()
    expect(isBaselineRegisterSentinel(marker?.payload_hash)).toBe(true)
    expect(JSON.parse(marker?.active_block_ids_json as string)).toEqual(ACTIVE)

    const op = makeBundledOp('content-A')
    expect(validateSyncOperationStrict(op)).toBeNull()
    expect(syncService.applyIncomingOperation(op as never)).toBe(true)

    const upgraded = getRegister('m-1')
    expect(upgraded?.timestamp).toBe(TS)
    expect(upgraded?.operation_id).toBe(OP)
    expect(JSON.parse(upgraded?.active_block_ids_json as string)).toEqual(ACTIVE)
    expect(typeof upgraded?.payload_hash).toBe('string')
    expect(isBaselineRegisterSentinel(upgraded?.payload_hash)).toBe(false)
    expect(/^[0-9a-f]{64}$/.test(upgraded?.payload_hash as string)).toBe(true)
    expect((sqlite.prepare(`SELECT content FROM messages WHERE id='m-1'`).get() as { content: string }).content).toBe(
      'content-A'
    )
    expect(appliedHas(OP)).toBe(true)

    // Same op replays idempotent: no throw, no state change.
    expect(syncService.applyIncomingOperation(op as never)).toBe(false)
    const replayed = getRegister('m-1')
    expect(replayed?.payload_hash).toBe(upgraded?.payload_hash)
    expect((sqlite.prepare(`SELECT content FROM messages WHERE id='m-1'`).get() as { content: string }).content).toBe(
      'content-A'
    )
  })

  it('marker with same clock but different active order fails closed with full rollback', () => {
    seedBaseline()
    mergeMarkerRegister('m-1', TS, OP, [...ACTIVE])
    const before = getRegister('m-1')

    const divergent = makeReplaceOp({
      id: OP,
      ts: TS,
      content: 'content-divergent',
      blocks: [{ id: 'b-1', content: 'new-b1', memTs: TS, memOp: OP }],
      activeOrder: ['b-1']
    })
    expect(validateSyncOperationStrict(divergent)).toBeNull()
    expect(() => syncService.applyIncomingOperation(divergent as never)).toThrow(/divergence/)

    // Whole-transaction rollback: register, entity, retirement barrier, applied all untouched.
    const after = getRegister('m-1')
    expect(after?.payload_hash).toBe(before?.payload_hash)
    expect(isBaselineRegisterSentinel(after?.payload_hash)).toBe(true)
    expect(JSON.parse(after?.active_block_ids_json as string)).toEqual(ACTIVE)
    expect((sqlite.prepare(`SELECT content FROM messages WHERE id='m-1'`).get() as { content: string }).content).toBe(
      'old-content'
    )
    expect(sqlite.prepare(`SELECT id FROM message_blocks WHERE id='b-old'`).get()).toBeDefined()
    expect(appliedHas(OP)).toBe(false)
  })

  it('after the upgrade, same clock/same active with a different bundle fails closed', () => {
    seedBaseline()
    mergeMarkerRegister('m-1', TS, OP, [...ACTIVE])
    const opA = makeBundledOp('content-A')
    expect(syncService.applyIncomingOperation(opA as never)).toBe(true)
    const winnerA = getRegister('m-1')?.payload_hash
    expect(isBaselineRegisterSentinel(winnerA)).toBe(false)

    const opB = makeBundledOp('content-B')
    expect(validateSyncOperationStrict(opB)).toBeNull()
    expect(() => syncService.applyIncomingOperation(opB as never)).toThrow(/divergence/)

    // No partial winner switch: the first bundle stays authoritative.
    expect(getRegister('m-1')?.payload_hash).toBe(winnerA)
    expect((sqlite.prepare(`SELECT content FROM messages WHERE id='m-1'`).get() as { content: string }).content).toBe(
      'content-A'
    )
  })

  it('baseline equal-clock never overwrites an existing real winner with the sentinel', () => {
    seedBaseline()
    const op = makeBundledOp('content-A')
    expect(syncService.applyIncomingOperation(op as never)).toBe(true)
    const winner = getRegister('m-1')
    expect(isBaselineRegisterSentinel(winner?.payload_hash)).toBe(false)

    // Same clock + same active baseline registers arrive later: idempotent, stored winner kept.
    expect(() =>
      db.transaction((tx) => {
        mergeValidatedBaselineInTx(tx as never, {
          entities: [],
          tombstones: [],
          orderFrames: [],
          replacementRegisters: [{ messageId: 'm-1', timestamp: TS, operationId: OP, activeBlockIds: [...ACTIVE] }]
        })
      })
    ).not.toThrow()
    const kept = getRegister('m-1')
    expect(kept?.payload_hash).toBe(winner?.payload_hash)
    expect(isBaselineRegisterSentinel(kept?.payload_hash)).toBe(false)
    expect(JSON.parse(kept?.active_block_ids_json as string)).toEqual(ACTIVE)
  })
})
