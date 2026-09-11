/**
 * Incremental topicMessage parent-order-frame wire unit (SYNC-DATA-048).
 *
 * Locked wire: existing SyncOperation endpoint/envelope reused, new precise
 * `op:'order_frame'` with entityType 'topic', entityId === payload.parentId,
 * strictly closed payload reusing `parent-order-frame-v1`:
 * `{frameVersion:'parent-order-frame-v1',kind:'topicMessage',parentId,
 * orderedChildIds:string[],frameClock:{timestamp,operationId}}`, envelope
 * `id === frameClock.operationId` and `timestamp === frameClock.timestamp`,
 * deviceId stays envelope-only. Unknown fields/version/kind/duplicate
 * child/mirror mismatch all fail closed. No new endpoint/relay schema/
 * baseline wireVersion; old clients fail closed on the new op (accepted
 * forward contract).
 *
 * Scope: ordinary topicMessage paths with atomic membership/frame semantics
 * (empty topic establish, appendMessage, deleteMessage, deleteMessages,
 * reorderMessages with complete membership). Compound/unsupported paths keep
 * existing invalidate/partial with zero frame ops.
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
import { ChatDbAggregateService } from '../../chatDb/ChatDbAggregateService'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { captureLocalSyncBaselineCandidate } from '../syncBaseline'
import { SyncOrphanError } from '../SyncService'
import { SyncService, syncService } from '../SyncService'
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

function frameOf(
  sqlite: Database.Database,
  parentId: string
): { orderedChildIds: string[]; timestamp: number; operationId: string } | null {
  const r = sqlite
    .prepare(
      `SELECT ordered_child_ids_json AS json, timestamp, operation_id AS operationId FROM sync_parent_order_frame WHERE kind='topicMessage' AND parent_id=?`
    )
    .get(parentId) as { json: string; timestamp: number; operationId: string } | undefined
  if (!r) return null
  return { orderedChildIds: JSON.parse(r.json) as string[], timestamp: r.timestamp, operationId: r.operationId }
}

function frameOps(db: BetterSQLite3Database<typeof schema>, parentId?: string) {
  const rows = db.select().from(schema.syncOutbox).all()
  return rows.filter((r) => r.op === 'order_frame' && (parentId === undefined || r.entityId === parentId))
}

function messageOrder(sqlite: Database.Database, topicId: string): string[] {
  const rows = sqlite
    .prepare(`SELECT id FROM messages WHERE topic_id=? ORDER BY sort_order ASC, id ASC`)
    .all(topicId) as Array<{ id: string }>
  return rows.map((r) => r.id)
}

function makeOrderFrameOp(args: {
  id: string
  parentId: string
  timestamp: number
  deviceId: string
  orderedChildIds: string[]
}): Record<string, unknown> {
  return {
    id: args.id,
    entityType: 'topic',
    op: 'order_frame',
    entityId: args.parentId,
    timestamp: args.timestamp,
    deviceId: args.deviceId,
    payload: {
      frameVersion: 'parent-order-frame-v1',
      kind: 'topicMessage',
      parentId: args.parentId,
      orderedChildIds: [...args.orderedChildIds],
      frameClock: { timestamp: args.timestamp, operationId: args.id }
    }
  }
}

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>
let agg: ChatDbAggregateService

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

describe('shared validator: order_frame closed wire', () => {
  const base = { id: 'op-1', entityType: 'topic', op: 'order_frame', entityId: 't-1', timestamp: 100, deviceId: 'd-1' }

  it('accepts the exact locked shape', () => {
    const err = validateSyncOperationStrict({
      ...base,
      payload: (
        makeOrderFrameOp({
          id: 'op-1',
          parentId: 't-1',
          timestamp: 100,
          deviceId: 'd-1',
          orderedChildIds: ['m-1']
        }) as { payload: unknown }
      ).payload
    })
    expect(err).toBeNull()
  })

  it('rejects every key illegal closure condition fail-closed', () => {
    const good = (
      makeOrderFrameOp({ id: 'op-1', parentId: 't-1', timestamp: 100, deviceId: 'd-1', orderedChildIds: ['m-1'] }) as {
        payload: Record<string, unknown>
      }
    ).payload
    // unknown extra field
    expect(validateSyncOperationStrict({ ...base, payload: { ...good, extra: 1 } })).not.toBeNull()
    // unknown version
    expect(
      validateSyncOperationStrict({ ...base, payload: { ...good, frameVersion: 'parent-order-frame-v2' } })
    ).not.toBeNull()
    // unknown kind
    expect(validateSyncOperationStrict({ ...base, payload: { ...good, kind: 'messageBlock' } })).not.toBeNull()
    // duplicate child
    expect(
      validateSyncOperationStrict({
        ...base,
        payload: { ...good, orderedChildIds: ['m-1', 'm-1'] }
      })
    ).not.toBeNull()
    // parentId/entityId mismatch
    expect(validateSyncOperationStrict({ ...base, payload: { ...good, parentId: 't-2' } })).not.toBeNull()
    // id/clock mirror mismatch
    expect(
      validateSyncOperationStrict({
        ...base,
        id: 'op-other',
        payload: { ...good, frameClock: { timestamp: 100, operationId: 'op-1' } }
      })
    ).not.toBeNull()
    expect(
      validateSyncOperationStrict({
        ...base,
        timestamp: 101,
        payload: { ...good, frameClock: { timestamp: 100, operationId: 'op-1' } }
      })
    ).not.toBeNull()
    // entityType must be topic
    expect(validateSyncOperationStrict({ ...base, entityType: 'message', payload: good })).not.toBeNull()
    // deviceId must not enter payload
    expect(validateSyncOperationStrict({ ...base, payload: { ...good, deviceId: 'd-1' } })).not.toBeNull()
    // frameClock shape must be exact
    expect(
      validateSyncOperationStrict({
        ...base,
        payload: { ...good, frameClock: { timestamp: 100, operationId: 'op-1', extra: 1 } }
      })
    ).not.toBeNull()
    // missing payload fails
    expect(validateSyncOperationStrict({ ...base, payload: undefined })).not.toBeNull()
  })

  it('delete with a frame payload stays rejected; upsert never enters the frame allowlist', () => {
    expect(
      validateSyncOperationStrict({
        id: 'op-d',
        entityType: 'topic',
        op: 'delete',
        entityId: 't-1',
        timestamp: 100,
        deviceId: 'd-1',
        payload: {
          frameVersion: 'parent-order-frame-v1',
          kind: 'topicMessage',
          parentId: 't-1',
          orderedChildIds: [],
          frameClock: { timestamp: 100, operationId: 'op-d' }
        }
      })
    ).not.toBeNull()
    expect(
      validateSyncOperationStrict({
        id: 'op-u',
        entityType: 'topic',
        op: 'upsert',
        entityId: 't-1',
        timestamp: 100,
        deviceId: 'd-1',
        payload: { id: 't-1', frameVersion: 'parent-order-frame-v1' }
      })
    ).not.toBeNull()
  })

  it('old clients fail closed on the new op (unknown op string rejected)', () => {
    expect(
      validateSyncOperationStrict({
        id: 'op-x',
        entityType: 'topic',
        op: 'order_frame_v2',
        entityId: 't-1',
        timestamp: 100,
        deviceId: 'd-1',
        payload: {}
      })
    ).not.toBeNull()
  })
})

describe('aggregate issuance: atomic single-frame ops with mirrored clock', () => {
  it('ensureTopic mints an empty frame plus exactly one order_frame reusing its clock', () => {
    vi.spyOn(Date, 'now').mockReturnValue(3_000_000_000_000)
    const res = agg.ensureTopic('t-empty-issue', 'assistant-1', 'Empty')
    expect(res.ok).toBe(true)
    const frame = frameOf(sqlite, 't-empty-issue')!
    expect(frame).not.toBeNull()
    expect(frame.orderedChildIds).toEqual([])
    const ops = frameOps(db, 't-empty-issue')
    expect(ops.length).toBe(1)
    expect(ops[0].id).toBe(frame.operationId)
    expect(ops[0].timestamp).toBe(frame.timestamp)
    const payload = JSON.parse(ops[0].payloadJson as string) as Record<string, unknown>
    expect(payload).toEqual({
      frameVersion: 'parent-order-frame-v1',
      kind: 'topicMessage',
      parentId: 't-empty-issue',
      orderedChildIds: [],
      frameClock: { timestamp: frame.timestamp, operationId: frame.operationId }
    })
  })

  it('append/delete/deleteMessages each mint exactly one frame op; same-tx failure rolls back all four (chat/order/membership/frame/outbox)', () => {
    vi.spyOn(Date, 'now').mockReturnValue(3_100_000_000_000)
    agg.ensureTopic('t-issue', 'assistant-1', 'T')
    const outboxAfterTopic = db.select().from(schema.syncOutbox).all().length
    agg.appendMessage(
      't-issue',
      { id: 'm-a', topicId: 't-issue', role: 'user', content: 'a', status: 'success' } as never,
      []
    )
    let frame = frameOf(sqlite, 't-issue')!
    expect(frame.orderedChildIds).toEqual(['m-a'])
    const ops = frameOps(db, 't-issue')
    expect(ops.length).toBe(2) // empty establish + append
    const appendOp = ops[ops.length - 1]
    expect(appendOp.id).toBe(frame.operationId)
    expect(appendOp.timestamp).toBe(frame.timestamp)
    expect(db.select().from(schema.syncOutbox).all().length).toBe(outboxAfterTopic + 2) // 1 message upsert + 1 frame
    // membership persisted for the new child in the same tx
    const mem = sqlite
      .prepare(`SELECT parent_id AS parentId FROM sync_membership_clock WHERE child_entity_id='m-a'`)
      .get() as { parentId: string }
    expect(mem.parentId).toBe('t-issue')

    vi.spyOn(Date, 'now').mockReturnValue(3_100_000_000_010)
    agg.appendMessage(
      't-issue',
      { id: 'm-b', topicId: 't-issue', role: 'user', content: 'b', status: 'success' } as never,
      []
    )
    frame = frameOf(sqlite, 't-issue')!
    expect(frame.orderedChildIds).toEqual(['m-a', 'm-b'])
    expect(frameOps(db, 't-issue').length).toBe(3)

    const del = agg.deleteMessage('t-issue', 'm-a')
    expect(del.ok).toBe(true)
    frame = frameOf(sqlite, 't-issue')!
    expect(frame.orderedChildIds).toEqual(['m-b'])
    expect(frameOps(db, 't-issue').length).toBe(4)
    const delFrameOp = frameOps(db, 't-issue')[3]
    expect(delFrameOp.id).toBe(frame.operationId)

    const delMany = agg.deleteMessages('t-issue', ['m-b'])
    expect(delMany.ok).toBe(true)
    frame = frameOf(sqlite, 't-issue')!
    expect(frame.orderedChildIds).toEqual([])
    expect(frameOps(db, 't-issue').length).toBe(5)

    // Same-tx rollback: legacy child without membership makes the next append fail
    // with zero chat/order/membership/frame/outbox residue.
    sqlite
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
      )
      .run('m-legacy', 't-issue', 'user', 'legacy', 'success', '2026-01-01', '2026-01-01', 99)
    const beforeOutbox = db.select().from(schema.syncOutbox).all().length
    const beforeFrame = frameOf(sqlite, 't-issue')!
    const bad = agg.appendMessage(
      't-issue',
      { id: 'm-new', topicId: 't-issue', role: 'user', content: 'n', status: 'success' } as never,
      []
    )
    expect(bad.ok).toBe(false)
    expect(sqlite.prepare(`SELECT id FROM messages WHERE id='m-new'`).get()).toBeUndefined()
    expect(db.select().from(schema.syncOutbox).all().length).toBe(beforeOutbox)
    expect(frameOf(sqlite, 't-issue')).toEqual(beforeFrame)
    expect(
      sqlite.prepare(`SELECT child_entity_id FROM sync_membership_clock WHERE child_entity_id='m-new'`).get()
    ).toBeUndefined()
  })

  it('reorder with complete membership mints one frame op; with missing membership invalidates without op and keeps user order', () => {
    vi.spyOn(Date, 'now').mockReturnValue(3_200_000_000_000)
    agg.ensureTopic('t-reorder', 'assistant-1', 'T')
    agg.appendMessage(
      't-reorder',
      { id: 'm-1', topicId: 't-reorder', role: 'user', content: 'a', status: 'success' } as never,
      []
    )
    vi.spyOn(Date, 'now').mockReturnValue(3_200_000_000_001)
    agg.appendMessage(
      't-reorder',
      { id: 'm-2', topicId: 't-reorder', role: 'user', content: 'b', status: 'success' } as never,
      []
    )
    const before = frameOps(db, 't-reorder').length
    const ok = agg.reorderMessages('t-reorder', ['m-2', 'm-1'])
    expect(ok.ok).toBe(true)
    const frame = frameOf(sqlite, 't-reorder')!
    expect(frame.orderedChildIds).toEqual(['m-2', 'm-1'])
    expect(frameOps(db, 't-reorder').length).toBe(before + 1)
    expect(messageOrder(sqlite, 't-reorder')).toEqual(['m-2', 'm-1'])

    // Missing membership: legacy row invalidates truthfully, user order still applied, no frame op.
    sqlite.prepare(`DELETE FROM sync_parent_order_frame WHERE kind='topicMessage' AND parent_id='t-reorder'`).run()
    sqlite
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
      )
      .run('m-legacy-2', 't-reorder', 'user', 'legacy', 'success', '2026-01-01', '2026-01-01', 2)
    const beforeMissing = frameOps(db, 't-reorder').length
    const ok2 = agg.reorderMessages('t-reorder', ['m-legacy-2', 'm-2', 'm-1'])
    expect(ok2.ok).toBe(true)
    expect(frameOf(sqlite, 't-reorder')).toBeNull()
    expect(frameOps(db, 't-reorder').length).toBe(beforeMissing)
    expect(messageOrder(sqlite, 't-reorder')).toEqual(['m-legacy-2', 'm-2', 'm-1'])
  })

  it('unsupported paths keep zero frame ops and existing partial/invalidate semantics', () => {
    vi.spyOn(Date, 'now').mockReturnValue(3_300_000_000_000)
    agg.ensureTopic('t-compound', 'assistant-1', 'T')
    agg.appendMessage(
      't-compound',
      { id: 'm-c1', topicId: 't-compound', role: 'user', content: 'a', status: 'success' } as never,
      []
    )
    const before = frameOps(db).length
    const frameBefore = frameOf(sqlite, 't-compound')!
    expect(frameBefore).not.toBeNull()
    const ins = agg.insertMessagesAfterAnchor('t-compound', 'm-c1', [
      {
        message: { id: 'm-c2', topicId: 't-compound', role: 'user', content: 'b', status: 'success' } as never,
        blocks: []
      }
    ])
    expect(ins.ok).toBe(true)
    expect(frameOf(sqlite, 't-compound')).toBeNull()
    expect(frameOps(db).length).toBe(before)
  })
})

describe('remote apply: LWW winner, gating, dense order, no poison', () => {
  function freshApplyDb(): { sqlite: Database.Database; db: BetterSQLite3Database<typeof schema>; svc: SyncService } {
    const opened = openChatDb()
    bindSingleton(opened.sqlite, opened.db)
    return { sqlite: opened.sqlite, db: opened.db, svc: new SyncService() }
  }

  function seedTopicWithMembers(
    ctx: { sqlite: Database.Database; db: BetterSQLite3Database<typeof schema>; svc: SyncService },
    topicId: string,
    members: Array<{ id: string; ts: number; opId: string }>
  ): void {
    ctx.sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?,?,?,?)`)
      .run(topicId, 'T', '2026-01-01', '2026-01-01')
    members.forEach((m, i) => {
      ctx.sqlite
        .prepare(
          `INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
        )
        .run(m.id, topicId, 'user', `c-${m.id}`, 'success', '2026-01-01', '2026-01-01', i)
      ctx.sqlite
        .prepare(
          `INSERT INTO sync_membership_clock (child_entity_type, child_entity_id, parent_id, timestamp, operation_id) VALUES (?,?,?,?,?)`
        )
        .run('message', m.id, topicId, m.ts, m.opId)
    })
  }

  it('newer wins and materializes dense order; older is a consumed no-op', () => {
    const ctx = freshApplyDb()
    seedTopicWithMembers(ctx, 't-apply', [
      { id: 'm-1', ts: 10, opId: 'aaaaaaaa-0000-0000-0000-000000000001' },
      { id: 'm-2', ts: 20, opId: 'aaaaaaaa-0000-0000-0000-000000000002' }
    ])
    try {
      const newer = makeOrderFrameOp({
        id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
        parentId: 't-apply',
        timestamp: 100,
        deviceId: 'd-x',
        orderedChildIds: ['m-2', 'm-1']
      })
      expect(ctx.svc.applyIncomingOperation(newer as never)).toBe(true)
      expect(messageOrder(ctx.sqlite, 't-apply')).toEqual(['m-2', 'm-1'])
      expect(frameOf(ctx.sqlite, 't-apply')!.orderedChildIds).toEqual(['m-2', 'm-1'])
      const older = makeOrderFrameOp({
        id: '00000000-0000-0000-0000-000000000000',
        parentId: 't-apply',
        timestamp: 50,
        deviceId: 'd-x',
        orderedChildIds: ['m-1', 'm-2']
      })
      expect(ctx.svc.applyIncomingOperation(older as never)).toBe(false)
      expect(messageOrder(ctx.sqlite, 't-apply')).toEqual(['m-2', 'm-1'])
    } finally {
      try {
        ctx.sqlite.close()
      } catch {}
    }
  })

  it('equal clock same semantics is idempotent; equal clock divergence fails closed with rollback', () => {
    const ctx = freshApplyDb()
    seedTopicWithMembers(ctx, 't-eq', [
      { id: 'm-1', ts: 10, opId: 'aaaaaaaa-0000-0000-0000-000000000001' },
      { id: 'm-2', ts: 20, opId: 'aaaaaaaa-0000-0000-0000-000000000002' }
    ])
    try {
      const first = makeOrderFrameOp({
        id: 'bbbbbbbb-0000-0000-0000-000000000001',
        parentId: 't-eq',
        timestamp: 100,
        deviceId: 'd-x',
        orderedChildIds: ['m-1', 'm-2']
      })
      expect(ctx.svc.applyIncomingOperation(first as never)).toBe(true)
      const sameAgain = makeOrderFrameOp({
        id: 'bbbbbbbb-0000-0000-0000-000000000001',
        parentId: 't-eq',
        timestamp: 100,
        deviceId: 'd-x',
        orderedChildIds: ['m-1', 'm-2']
      })
      expect(ctx.svc.applyIncomingOperation(sameAgain as never)).toBe(false)
      expect(messageOrder(ctx.sqlite, 't-eq')).toEqual(['m-1', 'm-2'])
      const divergent = makeOrderFrameOp({
        id: 'bbbbbbbb-0000-0000-0000-000000000001',
        parentId: 't-eq',
        timestamp: 100,
        deviceId: 'd-x',
        orderedChildIds: ['m-2', 'm-1']
      })
      expect(() => ctx.svc.applyIncomingOperation(divergent as never)).toThrow()
      // rollback: applied not recorded, order unchanged
      expect(messageOrder(ctx.sqlite, 't-eq')).toEqual(['m-1', 'm-2'])
      expect(frameOf(ctx.sqlite, 't-eq')!.orderedChildIds).toEqual(['m-1', 'm-2'])
    } finally {
      try {
        ctx.sqlite.close()
      } catch {}
    }
  })

  it('deleted/unknown/wrong-parent never materialize; unknown parent/member is retryable orphan (no poison-ack)', () => {
    const ctx = freshApplyDb()
    seedTopicWithMembers(ctx, 't-gone', [{ id: 'm-1', ts: 10, opId: 'aaaaaaaa-0000-0000-0000-000000000001' }])
    try {
      // deleted parent: tombstone + row removed -> consumed no-op
      ctx.sqlite.prepare(`DELETE FROM messages WHERE id='m-1'`).run()
      ctx.sqlite.prepare(`DELETE FROM topics WHERE id='t-gone'`).run()
      ctx.sqlite
        .prepare(`INSERT INTO sync_state (key, value) VALUES (?,?)`)
        .run('tombstone:topic:t-gone', '200:dddddddd-0000-0000-0000-000000000001')
      const forDeleted = makeOrderFrameOp({
        id: 'eeeeeeee-0000-0000-0000-000000000001',
        parentId: 't-gone',
        timestamp: 300,
        deviceId: 'd-x',
        orderedChildIds: []
      })
      expect(ctx.svc.applyIncomingOperation(forDeleted as never)).toBe(false)
      expect(frameOf(ctx.sqlite, 't-gone')).toBeNull()

      // unknown parent with no tombstone -> orphan (cursor must not advance via poison-ack)
      const forUnknown = makeOrderFrameOp({
        id: 'eeeeeeee-0000-0000-0000-000000000002',
        parentId: 't-missing',
        timestamp: 300,
        deviceId: 'd-x',
        orderedChildIds: []
      })
      expect(() => ctx.svc.applyIncomingOperation(forUnknown as never)).toThrow(SyncOrphanError)
      expect(
        ctx.sqlite
          .prepare(`SELECT operation_id FROM sync_applied WHERE operation_id='eeeeeeee-0000-0000-0000-000000000002'`)
          .get()
      ).toBeUndefined()

      // wrong-parent member -> fail closed, nothing materialized
      seedTopicWithMembers(ctx, 't-other', [{ id: 'm-z', ts: 10, opId: 'aaaaaaaa-0000-0000-0000-000000000009' }])
      ctx.sqlite
        .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?,?,?,?)`)
        .run('t-wrong', 'W', '2026-01-01', '2026-01-01')
      ctx.sqlite
        .prepare(
          `INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
        )
        .run('m-local', 't-wrong', 'user', 'c', 'success', '2026-01-01', '2026-01-01', 0)
      ctx.sqlite
        .prepare(
          `INSERT INTO sync_membership_clock (child_entity_type, child_entity_id, parent_id, timestamp, operation_id) VALUES (?,?,?,?,?)`
        )
        .run('message', 'm-local', 't-wrong', 10, 'aaaaaaaa-0000-0000-0000-000000000010')
      const wrongParent = makeOrderFrameOp({
        id: 'eeeeeeee-0000-0000-0000-000000000003',
        parentId: 't-wrong',
        timestamp: 300,
        deviceId: 'd-x',
        orderedChildIds: ['m-z']
      })
      expect(() => ctx.svc.applyIncomingOperation(wrongParent as never)).toThrow()
      expect(frameOf(ctx.sqlite, 't-wrong')).toBeNull()
    } finally {
      try {
        ctx.sqlite.close()
      } catch {}
    }
  })

  it('membership suffix appends >frameClock members deterministically; incomplete (<=frameClock missing) fails closed', () => {
    const ctx = freshApplyDb()
    seedTopicWithMembers(ctx, 't-suffix', [
      { id: 'm-1', ts: 10, opId: 'aaaaaaaa-0000-0000-0000-000000000001' },
      { id: 'm-2', ts: 200, opId: 'aaaaaaaa-0000-0000-0000-000000000002' }
    ])
    try {
      // m-2 membership (200) > frameClock (100): suffix append keeps both, winner list first
      const frame = makeOrderFrameOp({
        id: 'cccccccc-0000-0000-0000-000000000001',
        parentId: 't-suffix',
        timestamp: 100,
        deviceId: 'd-x',
        orderedChildIds: ['m-1']
      })
      expect(ctx.svc.applyIncomingOperation(frame as never)).toBe(true)
      expect(messageOrder(ctx.sqlite, 't-suffix')).toEqual(['m-1', 'm-2'])
      expect(frameOf(ctx.sqlite, 't-suffix')!.orderedChildIds).toEqual(['m-1', 'm-2'])

      // incomplete: m-1 membership (10) <= frameClock (500) but omitted ->
      // fail-closed coverage gate (frames carry no member-exclusion authority
      // over receiver-alive children; rollback, nothing recorded)
      const incomplete = makeOrderFrameOp({
        id: 'dddddddd-0000-0000-0000-000000000001',
        parentId: 't-suffix',
        timestamp: 500,
        deviceId: 'd-x',
        orderedChildIds: []
      })
      expect(() => ctx.svc.applyIncomingOperation(incomplete as never)).toThrow()
      expect(messageOrder(ctx.sqlite, 't-suffix')).toEqual(['m-1', 'm-2'])
      expect(
        ctx.sqlite
          .prepare(`SELECT operation_id FROM sync_applied WHERE operation_id='dddddddd-0000-0000-0000-000000000001'`)
          .get()
      ).toBeUndefined()
      expect(frameOf(ctx.sqlite, 't-suffix')!.orderedChildIds).toEqual(['m-1', 'm-2'])
    } finally {
      try {
        ctx.sqlite.close()
      } catch {}
    }
  })

  it('out-of-order arrival buffers as orphan and converges without poison-ack', () => {
    const ctx = freshApplyDb()
    ctx.sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?,?,?,?)`)
      .run('t-ooo', 'T', '2026-01-01', '2026-01-01')
    ctx.sqlite
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
      )
      .run('m-1', 't-ooo', 'user', 'c1', 'success', '2026-01-01', '2026-01-01', 0)
    ctx.sqlite
      .prepare(
        `INSERT INTO sync_membership_clock (child_entity_type, child_entity_id, parent_id, timestamp, operation_id) VALUES (?,?,?,?,?)`
      )
      .run('message', 'm-1', 't-ooo', 10, 'aaaaaaaa-0000-0000-0000-000000000001')
    try {
      // frame lists m-2 before its upsert arrived -> orphan, nothing applied
      const early = makeOrderFrameOp({
        id: 'ffffffff-0000-0000-0000-000000000001',
        parentId: 't-ooo',
        timestamp: 100,
        deviceId: 'd-x',
        orderedChildIds: ['m-1', 'm-2']
      })
      expect(() => ctx.svc.applyIncomingOperation(early as never)).toThrow(SyncOrphanError)
      expect(frameOf(ctx.sqlite, 't-ooo')).toBeNull()
      // member arrives via ordinary upsert path
      ctx.svc.applyIncomingOperation({
        id: 'aaaaaaaa-0000-0000-0000-000000000002',
        entityType: 'message',
        op: 'upsert',
        entityId: 'm-2',
        timestamp: 20,
        deviceId: 'd-x',
        payload: { id: 'm-2', topicId: 't-ooo', role: 'user', content: 'c2', status: 'success' }
      } as never)
      // retry of the buffered frame now converges
      expect(ctx.svc.applyIncomingOperation(early as never)).toBe(true)
      expect(messageOrder(ctx.sqlite, 't-ooo')).toEqual(['m-1', 'm-2'])
    } finally {
      try {
        ctx.sqlite.close()
      } catch {}
    }
  })
})

describe('relay persistence: real push/pull round-trip with 400/409/idempotent', () => {
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

  async function startRelay(): Promise<string> {
    const rdb = new Database(':memory:')
    relayDbs.push(rdb)
    ensureRelaySchema(rdb)
    const server = createRelayServer(rdb, { token: 'order-frame-token' })
    relayServers.push(server as unknown as { close: (cb?: () => void) => void })
    await new Promise<void>((resolve) => {
      ;(server as unknown as { listen: (p: number, h: string, cb: () => void) => void }).listen(0, '127.0.0.1', () =>
        resolve()
      )
    })
    const addr = (server as unknown as { address: () => { port: number } }).address()
    return `http://127.0.0.1:${addr.port}`
  }

  async function register(base: string, deviceId: string): Promise<{ code: string; secret: string }> {
    const res = await fetch(`${base}/sync/register`, {
      method: 'POST',
      headers: { Authorization: 'Bearer order-frame-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId })
    })
    expect(res.status).toBe(200)
    return (await res.json()) as { code: string; secret: string }
  }

  function authed(code: string, secret: string): Record<string, string> {
    return {
      Authorization: 'Bearer order-frame-token',
      'Content-Type': 'application/json',
      'x-sync-device-code': code,
      'x-sync-device-secret': secret
    }
  }

  it('stores and replays order_frame verbatim; illegal 400; id replay idempotent; divergent id 409', async () => {
    const base = await startRelay()
    const regA = await register(base, 'device-relay-a')
    const a = {
      code: (regA as unknown as { deviceCode: string }).deviceCode ?? (regA as unknown as { code: string }).code,
      secret:
        (regA as unknown as { deviceSecret: string }).deviceSecret ?? (regA as unknown as { secret: string }).secret
    }
    const regB = await register(base, 'device-relay-b')
    const b = {
      code: (regB as unknown as { deviceCode: string }).deviceCode ?? (regB as unknown as { code: string }).code,
      secret:
        (regB as unknown as { deviceSecret: string }).deviceSecret ?? (regB as unknown as { secret: string }).secret
    }
    // pair A -> B
    let res = await fetch(`${base}/sync/pair/request`, {
      method: 'POST',
      headers: authed(a.code, a.secret),
      body: JSON.stringify({ targetCode: b.code })
    })
    expect(res.status).toBe(200)
    const reqBody = (await res.json()) as { requestId: string }
    res = await fetch(`${base}/sync/pair/accept`, {
      method: 'POST',
      headers: authed(b.code, b.secret),
      body: JSON.stringify({ requestId: reqBody.requestId })
    })
    expect(res.status).toBe(200)

    const frame = makeOrderFrameOp({
      id: '11111111-0000-0000-0000-000000000001',
      parentId: 't-relay',
      timestamp: 100,
      deviceId: 'device-relay-a',
      orderedChildIds: ['m-1']
    })
    res = await fetch(`${base}/sync/push`, {
      method: 'POST',
      headers: authed(a.code, a.secret),
      body: JSON.stringify({ deviceId: 'device-relay-a', operations: [frame] })
    })
    expect(res.status).toBe(200)
    const pushBody = (await res.json()) as { acceptedIds: string[]; cursor: number }
    expect(pushBody.acceptedIds).toEqual(['11111111-0000-0000-0000-000000000001'])

    // pull replays verbatim
    res = await fetch(`${base}/sync/pull?cursor=0&deviceId=device-relay-b`, { headers: authed(b.code, b.secret) })
    expect(res.status).toBe(200)
    const pullBody = (await res.json()) as { operations: Array<Record<string, unknown>>; cursor: number }
    expect(pullBody.operations.length).toBe(1)
    expect(pullBody.operations[0]).toMatchObject({
      id: '11111111-0000-0000-0000-000000000001',
      entityType: 'topic',
      op: 'order_frame',
      entityId: 't-relay'
    })
    expect((pullBody.operations[0] as { payload: unknown }).payload).toEqual((frame as { payload: unknown }).payload)

    // illegal order_frame -> 400, nothing stored
    const illegal = makeOrderFrameOp({
      id: '11111111-0000-0000-0000-000000000002',
      parentId: 't-relay',
      timestamp: 101,
      deviceId: 'device-relay-a',
      orderedChildIds: ['m-1', 'm-1']
    })
    res = await fetch(`${base}/sync/push`, {
      method: 'POST',
      headers: authed(a.code, a.secret),
      body: JSON.stringify({ deviceId: 'device-relay-a', operations: [illegal] })
    })
    expect(res.status).toBe(400)

    // identical replay -> idempotent accept without cursor growth
    res = await fetch(`${base}/sync/push`, {
      method: 'POST',
      headers: authed(a.code, a.secret),
      body: JSON.stringify({ deviceId: 'device-relay-a', operations: [frame] })
    })
    expect(res.status).toBe(200)
    const replay = (await res.json()) as { acceptedIds: string[]; cursor: number }
    expect(replay.acceptedIds).toEqual(['11111111-0000-0000-0000-000000000001'])
    expect(replay.cursor).toBe(pushBody.cursor)

    // divergent id collision -> 409
    const divergent = makeOrderFrameOp({
      id: '11111111-0000-0000-0000-000000000001',
      parentId: 't-relay',
      timestamp: 100,
      deviceId: 'device-relay-a',
      orderedChildIds: []
    })
    res = await fetch(`${base}/sync/push`, {
      method: 'POST',
      headers: authed(a.code, a.secret),
      body: JSON.stringify({ deviceId: 'device-relay-a', operations: [divergent] })
    })
    expect(res.status).toBe(409)
  })
})

describe('dual-profile real-relay integration without baseline', () => {
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

  it('A append/reorder/delete converge on B via incremental pull with identical order and winning frame', async () => {
    const rdb = new Database(':memory:')
    relayDbs.push(rdb)
    ensureRelaySchema(rdb)
    const server = createRelayServer(rdb, { token: 'dual-token' })
    relayServers.push(server as unknown as { close: (cb?: () => void) => void })
    await new Promise<void>((resolve) => {
      ;(server as unknown as { listen: (p: number, h: string, cb: () => void) => void }).listen(0, '127.0.0.1', () =>
        resolve()
      )
    })
    const base = `http://127.0.0.1:${(server as unknown as { address: () => { port: number } }).address().port}`
    const auth = { Authorization: 'Bearer dual-token', 'Content-Type': 'application/json' } as Record<string, string>
    const regA = (await (
      await fetch(`${base}/sync/register`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ deviceId: 'device-dual-a' })
      })
    ).json()) as { deviceCode: string; deviceSecret: string }
    const regB = (await (
      await fetch(`${base}/sync/register`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ deviceId: 'device-dual-b' })
      })
    ).json()) as { deviceCode: string; deviceSecret: string }
    const authed = (code: string, secret: string): Record<string, string> => ({
      Authorization: 'Bearer dual-token',
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

    // Profile A writes via its own aggregate + outbox.
    const openedA = openChatDb()
    const openedB = openChatDb()
    const deviceIdA = 'device-dual-a'
    bindSingleton(openedA.sqlite, openedA.db)
    configStore.set('sync:enabled', true)
    configStore.set('deviceId', deviceIdA)
    const svcA = new SyncService()
    void svcA
    const aggA = new ChatDbAggregateService(openedA.db, openedA.sqlite)
    vi.spyOn(Date, 'now').mockReturnValue(4_000_000_000_000)
    expect(aggA.ensureTopic('t-dual', 'assistant-1', 'Dual').ok).toBe(true)
    aggA.appendMessage(
      't-dual',
      { id: 'm-1', topicId: 't-dual', role: 'user', content: 'a', status: 'success' } as never,
      []
    )
    vi.spyOn(Date, 'now').mockReturnValue(4_000_000_000_001)
    aggA.appendMessage(
      't-dual',
      { id: 'm-2', topicId: 't-dual', role: 'user', content: 'b', status: 'success' } as never,
      []
    )
    vi.spyOn(Date, 'now').mockReturnValue(4_000_000_000_002)
    aggA.appendMessage(
      't-dual',
      { id: 'm-3', topicId: 't-dual', role: 'user', content: 'c', status: 'success' } as never,
      []
    )
    expect(aggA.reorderMessages('t-dual', ['m-3', 'm-1', 'm-2']).ok).toBe(true)
    expect(aggA.deleteMessage('t-dual', 'm-1').ok).toBe(true)
    const expectedOrder = ['m-3', 'm-2']
    expect(
      (
        openedA.sqlite
          .prepare(`SELECT id FROM messages WHERE topic_id='t-dual' ORDER BY sort_order, id`)
          .all() as Array<{ id: string }>
      ).map((r) => r.id)
    ).toEqual(expectedOrder)
    const frameA = frameOf(openedA.sqlite, 't-dual')!
    expect(frameA.orderedChildIds).toEqual(expectedOrder)

    // Push A's outbox (topic/message upserts + order_frames) through the real relay.
    bindSingleton(openedA.sqlite, openedA.db)
    const outboxA = openedA.db.select().from(schema.syncOutbox).all()
    expect(outboxA.some((r) => r.op === 'order_frame')).toBe(true)
    const opsA = outboxA.map((r) => ({
      id: r.id,
      entityType: r.entityType,
      op: r.op,
      entityId: r.entityId,
      timestamp: r.timestamp,
      deviceId: r.deviceId,
      ...(r.payloadJson ? { payload: JSON.parse(r.payloadJson) } : {})
    }))
    // Push in drain order (parents before children, frames last) in bounded chunks.
    for (let i = 0; i < opsA.length; i += 50) {
      const chunk = opsA.slice(i, i + 50)
      const pushRes = await fetch(`${base}/sync/push`, {
        method: 'POST',
        headers: authed(regA.deviceCode, regA.deviceSecret),
        body: JSON.stringify({ deviceId: deviceIdA, operations: chunk })
      })
      expect(pushRes.status).toBe(200)
    }

    // Profile B pulls incrementally from 0 (no baseline involved) and applies in seq order.
    bindSingleton(openedB.sqlite, openedB.db)
    const svcB = new SyncService()
    let cursor = 0
    for (;;) {
      const pullRes = await fetch(`${base}/sync/pull?cursor=${cursor}&deviceId=device-dual-b`, {
        headers: authed(regB.deviceCode, regB.deviceSecret)
      })
      expect(pullRes.status).toBe(200)
      const body = (await pullRes.json()) as {
        operations: Array<Record<string, unknown> & { seq: number }>
        cursor: number
      }
      if (body.operations.length === 0) break
      // Apply strictly in seq order; retry a buffered orphan once its parent arrives later in the stream.
      const deferred: Array<Record<string, unknown>> = []
      for (const op of body.operations) {
        try {
          svcB.applyIncomingOperation(op as never)
        } catch (e) {
          if (e instanceof SyncOrphanError) {
            deferred.push(op)
            continue
          }
          throw e
        }
      }
      for (const op of deferred) {
        svcB.applyIncomingOperation(op as never)
      }
      cursor = body.cursor
      if (body.operations.length < 200) break
    }
    // No baseline was ever published on this channel.
    const baselineRes = await fetch(`${base}/sync/baseline`, { headers: authed(regB.deviceCode, regB.deviceSecret) })
    expect(baselineRes.status).toBe(404)

    expect(
      (
        openedB.sqlite
          .prepare(`SELECT id FROM messages WHERE topic_id='t-dual' ORDER BY sort_order, id`)
          .all() as Array<{ id: string }>
      ).map((r) => r.id)
    ).toEqual(expectedOrder)
    const frameB = frameOf(openedB.sqlite, 't-dual')!
    expect(frameB.orderedChildIds).toEqual(expectedOrder)
    expect(frameB.timestamp).toBe(frameA.timestamp)
    expect(frameB.operationId).toBe(frameA.operationId)

    try {
      openedA.sqlite.close()
    } catch {}
    try {
      openedB.sqlite.close()
    } catch {}
    bindSingleton(sqlite, db)
  })
})

describe('transient errata: exclusion invalidates locally with 0 op; promotion inclusion emits one frame op', () => {
  function setupTwoStable(topicId: string): void {
    vi.spyOn(Date, 'now').mockReturnValue(5_000_000_000_000)
    agg.ensureTopic(topicId, 'assistant-1', 'T')
    agg.appendMessage(
      topicId,
      { id: `${topicId}-m1`, topicId, role: 'user', content: 'a', status: 'success' } as never,
      []
    )
    vi.spyOn(Date, 'now').mockReturnValue(5_000_000_000_001)
    agg.appendMessage(
      topicId,
      { id: `${topicId}-m2`, topicId, role: 'user', content: 'b', status: 'success' } as never,
      []
    )
  }

  it('updateMessage stable->transient invalidates locally with 0 order_frame and truthful partial candidate', () => {
    setupTwoStable('t-f1-excl')
    const m1 = 't-f1-excl-m1'
    const m2 = 't-f1-excl-m2'
    expect(frameOf(sqlite, 't-f1-excl')!.orderedChildIds).toEqual([m1, m2])
    expect(
      sqlite.prepare(`SELECT kind FROM sync_parent_order_frame WHERE kind='messageBlock' AND parent_id=?`).get(m1)
    ).toBeTruthy()
    const before = frameOps(db, 't-f1-excl').length
    const beforeOutbox = db.select().from(schema.syncOutbox).all().length

    // Transient status never rides the wire, so the frame has no
    // member-exclusion authority: same-tx local invalidation, 0 frame op,
    // user edit succeeds.
    const upd = agg.updateMessage('t-f1-excl', m1, { status: 'streaming' } as never)
    expect(upd.ok).toBe(true)
    expect(frameOf(sqlite, 't-f1-excl')).toBeNull()
    expect(frameOps(db, 't-f1-excl').length).toBe(before)
    // No entity op for the transient status itself; zero new outbox rows.
    expect(db.select().from(schema.syncOutbox).all().length).toBe(beforeOutbox)
    // Excluded parent's messageBlock frame is invalidated.
    expect(
      sqlite.prepare(`SELECT kind FROM sync_parent_order_frame WHERE kind='messageBlock' AND parent_id=?`).get(m1)
    ).toBeUndefined()
    expect((sqlite.prepare(`SELECT status FROM messages WHERE id=?`).get(m1) as { status: string }).status).toBe(
      'streaming'
    )
    // Candidate is truthful partial (missing-order-frame), never synthesized.
    const candidate = captureLocalSyncBaselineCandidate(db as never)
    expect(candidate.completeness?.state).not.toBe('complete')
    expect(JSON.stringify(candidate.completeness?.reasons ?? [])).toContain('missing-order-frame')
  })

  it('updateMessage transient->stable emits one inclusion frame op plus the entity upsert', () => {
    setupTwoStable('t-f1-incl')
    const m1 = 't-f1-incl-m1'
    const m2 = 't-f1-incl-m2'
    expect(agg.updateMessage('t-f1-incl', m1, { status: 'streaming' } as never).ok).toBe(true)
    expect(frameOf(sqlite, 't-f1-incl')).toBeNull()
    const before = frameOps(db, 't-f1-incl').length

    const promote = agg.updateMessage('t-f1-incl', m1, { status: 'success' } as never)
    expect(promote.ok).toBe(true)
    const frame = frameOf(sqlite, 't-f1-incl')!
    expect(frame.orderedChildIds).toEqual([m1, m2])
    const ops = frameOps(db, 't-f1-incl')
    expect(ops.length).toBe(before + 1)
    expect(ops[ops.length - 1].id).toBe(frame.operationId)
    // The stable promotion also travels as an entity upsert.
    const msgOps = db
      .select()
      .from(schema.syncOutbox)
      .all()
      .filter((r) => r.entityType === 'message' && r.entityId === m1 && r.op === 'upsert')
    expect(msgOps.length).toBeGreaterThanOrEqual(2)
  })

  it('appendMessage overwrite stable->transient invalidates locally with 0 order_frame', () => {
    setupTwoStable('t-f1-append')
    const m1 = 't-f1-append-m1'
    const before = frameOps(db, 't-f1-append').length

    const overwrite = agg.appendMessage(
      't-f1-append',
      { id: m1, topicId: 't-f1-append', role: 'user', content: 'a', status: 'streaming' } as never,
      []
    )
    expect(overwrite.ok).toBe(true)
    expect(frameOf(sqlite, 't-f1-append')).toBeNull()
    expect(frameOps(db, 't-f1-append').length).toBe(before)
    expect((sqlite.prepare(`SELECT status FROM messages WHERE id=?`).get(m1) as { status: string }).status).toBe(
      'streaming'
    )
  })

  it('updateMessageAndBlocks stable->transient invalidates with 0 op; transient->stable emits one inclusion frame op', () => {
    setupTwoStable('t-f1-amb')
    const m1 = 't-f1-amb-m1'
    const m2 = 't-f1-amb-m2'
    const before = frameOps(db, 't-f1-amb').length

    const excl = agg.updateMessageAndBlocks('t-f1-amb', { id: m1, status: 'streaming' } as never, [], [])
    expect(excl.ok).toBe(true)
    expect(frameOf(sqlite, 't-f1-amb')).toBeNull()
    expect(frameOps(db, 't-f1-amb').length).toBe(before)

    const incl = agg.updateMessageAndBlocks('t-f1-amb', { id: m1, status: 'success' } as never, [], [])
    expect(incl.ok).toBe(true)
    const frame = frameOf(sqlite, 't-f1-amb')!
    expect(frame.orderedChildIds).toEqual([m1, m2])
    const ops = frameOps(db, 't-f1-amb')
    expect(ops.length).toBe(before + 1)
    expect(ops[ops.length - 1].id).toBe(frame.operationId)
  })

  it('no inclusion change means 0 frame ops: stable->stable content edit and transient->transient', () => {
    setupTwoStable('t-f1-noop')
    const m1 = 't-f1-noop-m1'
    // Brand-new transient message: no inclusion change, no frame touch.
    vi.spyOn(Date, 'now').mockReturnValue(5_000_000_000_010)
    expect(
      agg.appendMessage(
        't-f1-noop',
        { id: 't-f1-noop-mt', topicId: 't-f1-noop', role: 'assistant', content: 't', status: 'streaming' } as never,
        []
      ).ok
    ).toBe(true)
    const frameBefore = frameOf(sqlite, 't-f1-noop')!
    const opsBefore = frameOps(db, 't-f1-noop').length

    const edit = agg.updateMessage('t-f1-noop', m1, { content: 'edited' } as never)
    expect(edit.ok).toBe(true)
    expect(frameOf(sqlite, 't-f1-noop')).toEqual(frameBefore)
    expect(frameOps(db, 't-f1-noop').length).toBe(opsBefore)

    const transientEdit = agg.updateMessage('t-f1-noop', 't-f1-noop-mt', { content: 't2' } as never)
    expect(transientEdit.ok).toBe(true)
    expect(frameOf(sqlite, 't-f1-noop')).toEqual(frameBefore)
    expect(frameOps(db, 't-f1-noop').length).toBe(opsBefore)
  })

  it('missing membership on transition keeps truthful invalidate, 0 op, user edit succeeds', () => {
    setupTwoStable('t-f1-missing')
    const m1 = 't-f1-missing-m1'
    sqlite
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
      )
      .run('t-f1-missing-legacy', 't-f1-missing', 'user', 'legacy', 'success', '2026-01-01', '2026-01-01', 99)
    sqlite.prepare(`DELETE FROM sync_parent_order_frame WHERE kind='topicMessage' AND parent_id='t-f1-missing'`).run()
    const before = frameOps(db, 't-f1-missing').length

    const upd = agg.updateMessage('t-f1-missing', m1, { status: 'streaming' } as never)
    expect(upd.ok).toBe(true)
    expect((sqlite.prepare(`SELECT status FROM messages WHERE id=?`).get(m1) as { status: string }).status).toBe(
      'streaming'
    )
    expect(frameOf(sqlite, 't-f1-missing')).toBeNull()
    expect(frameOps(db, 't-f1-missing').length).toBe(before)
  })

  it('frameClock exhaustion on a minting path rolls back the user edit with zero residue', () => {
    setupTwoStable('t-f1-exhaust')
    const m1 = 't-f1-exhaust-m1'
    const m2 = 't-f1-exhaust-m2'
    const MAX_SAFE = 9007199254740991
    sqlite.prepare(`UPDATE sync_membership_clock SET timestamp=? WHERE child_entity_id IN (?,?)`).run(MAX_SAFE, m1, m2)
    sqlite
      .prepare(`UPDATE sync_parent_order_frame SET timestamp=? WHERE kind='topicMessage' AND parent_id=?`)
      .run(MAX_SAFE, 't-f1-exhaust')
    const beforeOutbox = db.select().from(schema.syncOutbox).all().length
    const beforeOps = frameOps(db, 't-f1-exhaust').length
    const orderBefore = messageOrder(sqlite, 't-f1-exhaust')

    const reorder = agg.reorderMessages('t-f1-exhaust', [m2, m1])
    expect(reorder.ok).toBe(false)
    expect(messageOrder(sqlite, 't-f1-exhaust')).toEqual(orderBefore)
    expect(db.select().from(schema.syncOutbox).all().length).toBe(beforeOutbox)
    expect(frameOps(db, 't-f1-exhaust').length).toBe(beforeOps)
    expect((frameOf(sqlite, 't-f1-exhaust') as { timestamp: number }).timestamp).toBe(MAX_SAFE)
  })

  it('dual-profile real-relay without baseline: pure exclusion never enters relay; promotion inclusion converges', async () => {
    const relayDbs: Database.Database[] = []
    const relayServers: Array<{ close: (cb?: () => void) => void }> = []
    try {
      const rdb = new Database(':memory:')
      relayDbs.push(rdb)
      ensureRelaySchema(rdb)
      const server = createRelayServer(rdb, { token: 'f1-token' })
      relayServers.push(server as unknown as { close: (cb?: () => void) => void })
      await new Promise<void>((resolve) => {
        ;(server as unknown as { listen: (p: number, h: string, cb: () => void) => void }).listen(0, '127.0.0.1', () =>
          resolve()
        )
      })
      const base = `http://127.0.0.1:${(server as unknown as { address: () => { port: number } }).address().port}`
      const auth = { Authorization: 'Bearer f1-token', 'Content-Type': 'application/json' } as Record<string, string>
      const regA = (await (
        await fetch(`${base}/sync/register`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ deviceId: 'device-f1-a' })
        })
      ).json()) as { deviceCode: string; deviceSecret: string }
      const regB = (await (
        await fetch(`${base}/sync/register`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ deviceId: 'device-f1-b' })
        })
      ).json()) as { deviceCode: string; deviceSecret: string }
      const authed = (code: string, secret: string): Record<string, string> => ({
        Authorization: 'Bearer f1-token',
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

      const openedA = openChatDb()
      const openedB = openChatDb()
      try {
        // A writes two stable messages; B converges first (baseline-free steady state).
        bindSingleton(openedA.sqlite, openedA.db)
        configStore.set('sync:enabled', true)
        configStore.set('deviceId', 'device-f1-a')
        const aggA = new ChatDbAggregateService(openedA.db, openedA.sqlite)
        vi.spyOn(Date, 'now').mockReturnValue(6_000_000_000_000)
        expect(aggA.ensureTopic('t-f1', 'assistant-1', 'F1').ok).toBe(true)
        aggA.appendMessage(
          't-f1',
          { id: 'm-1', topicId: 't-f1', role: 'user', content: 'a', status: 'success' } as never,
          []
        )
        vi.spyOn(Date, 'now').mockReturnValue(6_000_000_000_001)
        aggA.appendMessage(
          't-f1',
          { id: 'm-2', topicId: 't-f1', role: 'user', content: 'b', status: 'success' } as never,
          []
        )

        // Causal outbox insertion order: each frame is minted in the same
        // transaction after its member captures, so replaying in insertion
        // order keeps every frame complete at apply time (later members have
        // not arrived yet and are therefore not live). Re-sorting (e.g. all
        // frames last) can replay a stale intermediate frame after a newer
        // same-millisecond member arrived, which the strict coverage gate
        // correctly rejects — drain-order policy stays out of scope here.
        const toWireOps = (adb: BetterSQLite3Database<typeof schema>) =>
          adb
            .select()
            .from(schema.syncOutbox)
            .all()
            .map((r) => ({
              id: r.id,
              entityType: r.entityType,
              op: r.op,
              entityId: r.entityId,
              timestamp: r.timestamp,
              deviceId: r.deviceId,
              ...(r.payloadJson ? { payload: JSON.parse(r.payloadJson) } : {})
            }))
        const pushAll = async (ops: ReturnType<typeof toWireOps>): Promise<void> => {
          for (let i = 0; i < ops.length; i += 50) {
            const chunk = ops.slice(i, i + 50)
            const pushRes = await fetch(`${base}/sync/push`, {
              method: 'POST',
              headers: authed(regA.deviceCode, regA.deviceSecret),
              body: JSON.stringify({ deviceId: 'device-f1-a', operations: chunk })
            })
            expect(pushRes.status).toBe(200)
          }
        }
        bindSingleton(openedA.sqlite, openedA.db)
        await pushAll(toWireOps(openedA.db))
        openedA.db.delete(schema.syncOutbox).run()

        bindSingleton(openedB.sqlite, openedB.db)
        const svcB = new SyncService()
        let cursor = 0
        const pullApply = async (): Promise<{ orphaned: string[] }> => {
          const orphaned: string[] = []
          for (;;) {
            const pullRes = await fetch(`${base}/sync/pull?cursor=${cursor}&deviceId=device-f1-b`, {
              headers: authed(regB.deviceCode, regB.deviceSecret)
            })
            expect(pullRes.status).toBe(200)
            const body = (await pullRes.json()) as {
              operations: Array<Record<string, unknown> & { seq: number }>
              cursor: number
            }
            if (body.operations.length === 0) break
            const deferred: Array<Record<string, unknown>> = []
            for (const op of body.operations) {
              try {
                svcB.applyIncomingOperation(op as never)
              } catch (e) {
                if (e instanceof SyncOrphanError) {
                  orphaned.push(String((op as Record<string, unknown>).id))
                  deferred.push(op)
                  continue
                }
                throw e
              }
            }
            for (const op of deferred) {
              try {
                svcB.applyIncomingOperation(op as never)
              } catch (e) {
                if (e instanceof SyncOrphanError) continue
                throw e
              }
            }
            cursor = body.cursor
            if (body.operations.length < 200) break
          }
          return { orphaned }
        }
        await pullApply()
        expect(messageOrder(openedB.sqlite, 't-f1')).toEqual(['m-1', 'm-2'])

        // A: m-1 stable->transient. Transient status never rides the wire:
        // local invalidation only, zero new outbox rows — the pure exclusion
        // never enters the relay, so B sees an empty page (no orphan, no pin).
        bindSingleton(openedA.sqlite, openedA.db)
        expect(aggA.updateMessage('t-f1', 'm-1', { status: 'streaming' } as never).ok).toBe(true)
        expect(frameOf(openedA.sqlite, 't-f1')).toBeNull()
        bindSingleton(openedA.sqlite, openedA.db)
        expect(toWireOps(openedA.db).length).toBe(0)

        bindSingleton(openedB.sqlite, openedB.db)
        const first = await pullApply()
        expect(first.orphaned.length).toBe(0)
        expect(messageOrder(openedB.sqlite, 't-f1')).toEqual(['m-1', 'm-2'])
        expect(frameOf(openedB.sqlite, 't-f1')!.orderedChildIds).toEqual(['m-1', 'm-2'])

        // A: m-1 transient->stable (inclusion frame + entity upsert, entity op
        // first so the receiver can verify coverage). B converges fully.
        bindSingleton(openedA.sqlite, openedA.db)
        expect(aggA.updateMessage('t-f1', 'm-1', { status: 'success' } as never).ok).toBe(true)
        const frameA = frameOf(openedA.sqlite, 't-f1')!
        expect(frameA.orderedChildIds).toEqual(['m-1', 'm-2'])
        bindSingleton(openedA.sqlite, openedA.db)
        const inclOps = toWireOps(openedA.db)
        expect(inclOps.some((o) => o.op === 'order_frame')).toBe(true)
        // The promotion travels as both a stable entity upsert (coverage) and
        // exactly one matching order_frame op.
        expect(inclOps.some((o) => o.entityType === 'message' && o.entityId === 'm-1' && o.op === 'upsert')).toBe(true)
        await pushAll(inclOps)
        openedA.db.delete(schema.syncOutbox).run()

        bindSingleton(openedB.sqlite, openedB.db)
        const second = await pullApply()
        expect(second.orphaned.length).toBe(0)
        expect(messageOrder(openedB.sqlite, 't-f1')).toEqual(['m-1', 'm-2'])
        const frameB = frameOf(openedB.sqlite, 't-f1')!
        expect(frameB.orderedChildIds).toEqual(['m-1', 'm-2'])
        expect(frameB.timestamp).toBe(frameA.timestamp)
        // High-water (012): the promotion re-mint strictly exceeds the
        // pre-invalidation winner timestamp, so B accepts it as the winner
        // with full row identity (timestamp + operationId).
        expect(frameB.operationId).toBe(frameA.operationId)
        expect(
          openedB.sqlite.prepare(`SELECT operation_id FROM sync_applied WHERE operation_id=?`).get(frameA.operationId)
        ).toBeTruthy()
        const baselineRes = await fetch(`${base}/sync/baseline`, {
          headers: authed(regB.deviceCode, regB.deviceSecret)
        })
        expect(baselineRes.status).toBe(404)
      } finally {
        try {
          openedA.sqlite.close()
        } catch {}
        try {
          openedB.sqlite.close()
        } catch {}
        bindSingleton(sqlite, db)
      }
    } finally {
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
    }
  })
})
