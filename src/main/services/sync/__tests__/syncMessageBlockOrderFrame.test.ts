/**
 * Incremental messageBlock parent-order-frame wire unit (SYNC-DATA-048 extension).
 * Same op/payload/envelope contract as topicMessage, second legal pair only:
 * entityType 'message' + kind 'messageBlock', entityId === parentId, strict
 * five-key parent-order-frame-v1 payload, envelope id/time mirror frameClock,
 * deviceId envelope-only. Cross pairs fail closed. No new endpoint/relay
 * schema/baseline wireVersion; old clients fail closed (accepted contract).
 * Issuance covers ordinary stable-parent/stable-supported block inclusion
 * paths; exclusion/unsupported/compound/pure edits stay 0 op + partial.
 * No block reorder API is introduced (explicitly no manual-reorder claim).
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

function blockFrameOf(
  sqlite: Database.Database,
  parentId: string
): { orderedChildIds: string[]; timestamp: number; operationId: string } | null {
  const r = sqlite
    .prepare(
      `SELECT ordered_child_ids_json AS json, timestamp, operation_id AS operationId FROM sync_parent_order_frame WHERE kind='messageBlock' AND parent_id=?`
    )
    .get(parentId) as { json: string; timestamp: number; operationId: string } | undefined
  if (!r) return null
  return { orderedChildIds: JSON.parse(r.json) as string[], timestamp: r.timestamp, operationId: r.operationId }
}

function blockFrameOps(db: BetterSQLite3Database<typeof schema>, parentId?: string) {
  const rows = db.select().from(schema.syncOutbox).all()
  return rows.filter(
    (r) => r.op === 'order_frame' && r.entityType === 'message' && (parentId === undefined || r.entityId === parentId)
  )
}

function blockOrder(sqlite: Database.Database, messageId: string): string[] {
  const rows = sqlite
    .prepare(`SELECT id FROM message_blocks WHERE message_id=? ORDER BY sort_order ASC, id ASC`)
    .all(messageId) as Array<{ id: string }>
  return rows.map((r) => r.id)
}

function makeBlockFrameOp(args: {
  id: string
  parentId: string
  timestamp: number
  deviceId: string
  orderedChildIds: string[]
}): Record<string, unknown> {
  return {
    id: args.id,
    entityType: 'message',
    op: 'order_frame',
    entityId: args.parentId,
    timestamp: args.timestamp,
    deviceId: args.deviceId,
    payload: {
      frameVersion: 'parent-order-frame-v1',
      kind: 'messageBlock',
      parentId: args.parentId,
      orderedChildIds: [...args.orderedChildIds],
      frameClock: { timestamp: args.timestamp, operationId: args.id }
    }
  }
}

function stableBlock(id: string, messageId: string, content = `c-${id}`): Record<string, unknown> {
  return { id, messageId, type: 'text', content, status: 'success', createdAt: '2026-01-01', updatedAt: '2026-01-01' }
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

describe('shared validator: messageBlock second legal pair', () => {
  it('accepts both legal pairs, rejects cross/unknown/closed violations', () => {
    const goodBlock = (
      makeBlockFrameOp({
        id: 'op-b1',
        parentId: 'm-1',
        timestamp: 100,
        deviceId: 'd-1',
        orderedChildIds: ['b-1']
      }) as { payload: unknown }
    ).payload
    expect(
      validateSyncOperationStrict({
        id: 'op-b1',
        entityType: 'message',
        op: 'order_frame',
        entityId: 'm-1',
        timestamp: 100,
        deviceId: 'd-1',
        payload: goodBlock
      })
    ).toBeNull()
    // cross: topic entity + messageBlock kind
    expect(
      validateSyncOperationStrict({
        id: 'op-b1',
        entityType: 'topic',
        op: 'order_frame',
        entityId: 'm-1',
        timestamp: 100,
        deviceId: 'd-1',
        payload: goodBlock
      })
    ).not.toBeNull()
    // cross: message entity + topicMessage kind
    const topicPayload = {
      frameVersion: 'parent-order-frame-v1',
      kind: 'topicMessage',
      parentId: 'm-1',
      orderedChildIds: [],
      frameClock: { timestamp: 100, operationId: 'op-b1' }
    }
    expect(
      validateSyncOperationStrict({
        id: 'op-b1',
        entityType: 'message',
        op: 'order_frame',
        entityId: 'm-1',
        timestamp: 100,
        deviceId: 'd-1',
        payload: topicPayload
      })
    ).not.toBeNull()
    // unknown kind / extra key / duplicate / mirror mismatch / block entityType
    const base = {
      id: 'op-b1',
      entityType: 'message',
      op: 'order_frame',
      entityId: 'm-1',
      timestamp: 100,
      deviceId: 'd-1'
    }
    const g = goodBlock as Record<string, unknown>
    expect(validateSyncOperationStrict({ ...base, payload: { ...g, kind: 'unknown' } })).not.toBeNull()
    expect(validateSyncOperationStrict({ ...base, payload: { ...g, extra: 1 } })).not.toBeNull()
    expect(validateSyncOperationStrict({ ...base, payload: { ...g, orderedChildIds: ['b-1', 'b-1'] } })).not.toBeNull()
    expect(validateSyncOperationStrict({ ...base, payload: { ...g, parentId: 'm-2' } })).not.toBeNull()
    expect(
      validateSyncOperationStrict({
        ...base,
        id: 'op-other',
        payload: { ...g, frameClock: { timestamp: 100, operationId: 'op-b1' } }
      })
    ).not.toBeNull()
    expect(validateSyncOperationStrict({ ...base, entityType: 'message_block', payload: g })).not.toBeNull()
    expect(validateSyncOperationStrict({ ...base, payload: { ...g, deviceId: 'd-1' } })).not.toBeNull()
    expect(validateSyncOperationStrict({ ...base, payload: undefined })).not.toBeNull()
  })
})

describe('aggregate ordinary issuance: exact op/clock/atomicity', () => {
  it('appendMessage stable block create mints exactly one messageBlock frame reusing winning clock', () => {
    vi.spyOn(Date, 'now').mockReturnValue(6_000_000_000_000)
    agg.ensureTopic('t-b1', 'assistant-1', 'T')
    agg.appendMessage(
      't-b1',
      { id: 'm-b1', topicId: 't-b1', role: 'user', content: 'hi', status: 'success' } as never,
      [stableBlock('b-1', 'm-b1') as never, stableBlock('b-2', 'm-b1') as never]
    )
    const frame = blockFrameOf(sqlite, 'm-b1')!
    expect(frame).not.toBeNull()
    expect(frame.orderedChildIds).toEqual(['b-1', 'b-2'])
    const ops = blockFrameOps(db, 'm-b1')
    expect(ops.length).toBe(1)
    expect(ops[0].id).toBe(frame.operationId)
    expect(ops[0].timestamp).toBe(frame.timestamp)
    const payload = JSON.parse(ops[0].payloadJson as string) as Record<string, unknown>
    expect(payload).toEqual({
      frameVersion: 'parent-order-frame-v1',
      kind: 'messageBlock',
      parentId: 'm-b1',
      orderedChildIds: ['b-1', 'b-2'],
      frameClock: { timestamp: frame.timestamp, operationId: frame.operationId }
    })
    // entity op precedes frame in push priority (block priority 2 < frame 3)
    const outbox = db.select().from(schema.syncOutbox).all()
    const blockIdx = outbox.findIndex((r) => r.entityType === 'message_block' && r.entityId === 'b-1')
    const frameIdx = outbox.findIndex((r) => r.op === 'order_frame' && r.entityId === 'm-b1')
    expect(blockIdx).toBeGreaterThanOrEqual(0)
    expect(frameIdx).toBeGreaterThan(blockIdx)
  })

  it('bulkAddBlocks/updateBlocks/deleteBlocks ordinary paths mint one frame each; pure content edit mints none', () => {
    vi.spyOn(Date, 'now').mockReturnValue(6_000_000_000_100)
    agg.ensureTopic('t-b2', 'assistant-1', 'T')
    agg.appendMessage(
      't-b2',
      { id: 'm-b2', topicId: 't-b2', role: 'user', content: 'hi', status: 'success' } as never,
      [stableBlock('b-10', 'm-b2') as never]
    )
    const before = blockFrameOps(db, 'm-b2').length
    agg.bulkAddBlocks([stableBlock('b-11', 'm-b2') as never])
    expect(blockFrameOf(sqlite, 'm-b2')!.orderedChildIds).toEqual(blockOrder(sqlite, 'm-b2'))
    expect(blockFrameOps(db, 'm-b2').length).toBe(before + 1)

    agg.updateBlocks([{ ...stableBlock('b-11', 'm-b2'), content: 'edited' } as never])
    expect(blockFrameOps(db, 'm-b2').length).toBe(before + 1) // pure included->included: 0 op

    agg.updateBlocks([stableBlock('b-12', 'm-b2') as never])
    expect(blockFrameOf(sqlite, 'm-b2')!.orderedChildIds).toEqual(blockOrder(sqlite, 'm-b2'))
    expect(blockFrameOps(db, 'm-b2').length).toBe(before + 2)

    agg.deleteBlocks(['b-10'])
    expect(blockFrameOf(sqlite, 'm-b2')!.orderedChildIds).toEqual(blockOrder(sqlite, 'm-b2'))
    expect(blockFrameOps(db, 'm-b2').length).toBe(before + 3)
  })

  it('exclusion/unsupported/compound paths mint 0 frame op and invalidate; missing membership try-invalidates with user success', () => {
    vi.spyOn(Date, 'now').mockReturnValue(6_000_000_000_200)
    agg.ensureTopic('t-b3', 'assistant-1', 'T')
    agg.appendMessage(
      't-b3',
      { id: 'm-b3', topicId: 't-b3', role: 'assistant', content: 'hi', status: 'success' } as never,
      [stableBlock('b-20', 'm-b3') as never]
    )
    const before = blockFrameOps(db, 'm-b3').length
    // stable->transient exclusion via updateSingleBlock: 0 op + invalidate
    agg.updateSingleBlock('b-20', { status: 'streaming' } as never)
    expect(blockFrameOf(sqlite, 'm-b3')).toBeNull()
    expect(blockFrameOps(db, 'm-b3').length).toBe(before)
    // unsupported promotion path stays 0 op (transient streaming block, no membership): invalidate path
    const cand = captureLocalSyncBaselineCandidate(db as never)
    expect(cand.completeness).not.toBe('complete')
    // compound path keeps 0 op
    const beforeCompound = blockFrameOps(db).length
    const ins = agg.insertMessagesAfterAnchor('t-b3', 'm-b3', [
      { message: { id: 'm-b3x', topicId: 't-b3', role: 'user', content: 'x', status: 'success' } as never, blocks: [] }
    ])
    expect(ins.ok).toBe(true)
    expect(blockFrameOps(db).length).toBe(beforeCompound)

    // missing membership try path: legacy unversioned sibling -> user mutation succeeds with 0 op + invalidate
    vi.spyOn(Date, 'now').mockReturnValue(6_000_000_000_300)
    agg.ensureTopic('t-b4', 'assistant-1', 'T')
    agg.appendMessage(
      't-b4',
      { id: 'm-b4', topicId: 't-b4', role: 'user', content: 'hi', status: 'success' } as never,
      [stableBlock('b-30', 'm-b4') as never]
    )
    sqlite
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
      )
      .run('b-legacy', 'm-b4', 'text', 'legacy', 'success', '2026-01-01', '2026-01-01', 99)
    const beforeMissing = blockFrameOps(db, 'm-b4').length
    const res = agg.bulkAddBlocks([stableBlock('b-31', 'm-b4') as never])
    expect(res.ok).toBe(true)
    expect(sqlite.prepare(`SELECT id FROM message_blocks WHERE id='b-31'`).get()).toBeTruthy()
    expect(blockFrameOf(sqlite, 'm-b4')).toBeNull()
    expect(blockFrameOps(db, 'm-b4').length).toBe(beforeMissing)
  })

  it('malformed extra still rolls back the enclosing mutation', () => {
    vi.spyOn(Date, 'now').mockReturnValue(6_000_000_000_400)
    agg.ensureTopic('t-b5', 'assistant-1', 'T')
    agg.appendMessage(
      't-b5',
      { id: 'm-b5', topicId: 't-b5', role: 'user', content: 'hi', status: 'success' } as never,
      [stableBlock('b-40', 'm-b5') as never]
    )
    sqlite.prepare(`UPDATE message_blocks SET extra='not-json' WHERE id='b-40'`).run()
    const before = blockFrameOps(db, 'm-b5').length
    const res = agg.bulkAddBlocks([stableBlock('b-41', 'm-b5') as never])
    expect(res.ok).toBe(false)
    expect(sqlite.prepare(`SELECT id FROM message_blocks WHERE id='b-41'`).get()).toBeUndefined()
    expect(blockFrameOps(db, 'm-b5').length).toBe(before)
  })
})

describe('remote apply: kind branch with same LWW/highwater semantics', () => {
  function freshApplyDb(): { sqlite: Database.Database; db: BetterSQLite3Database<typeof schema>; svc: SyncService } {
    const opened = openChatDb()
    bindSingleton(opened.sqlite, opened.db)
    return { sqlite: opened.sqlite, db: opened.db, svc: new SyncService() }
  }
  function seedMessageWithBlocks(
    ctx: { sqlite: Database.Database },
    messageId: string,
    blocks: Array<{ id: string; ts: number; opId: string }>
  ): void {
    ctx.sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?,?,?,?)`)
      .run('t-apply', 'T', '2026-01-01', '2026-01-01')
    ctx.sqlite
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(messageId, 't-apply', 'assistant', 'c', 'success', '2026-01-01', '2026-01-01', 0)
    blocks.forEach((b, i) => {
      ctx.sqlite
        .prepare(
          `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
        )
        .run(b.id, messageId, 'text', `c-${b.id}`, 'success', '2026-01-01', '2026-01-01', i)
      ctx.sqlite
        .prepare(
          `INSERT INTO sync_membership_clock (child_entity_type, child_entity_id, parent_id, timestamp, operation_id) VALUES (?,?,?,?,?)`
        )
        .run('message_block', b.id, messageId, b.ts, b.opId)
    })
  }

  it('newer wins + dense materialization; older loses; equal idempotent; equal divergent fails', () => {
    const ctx = freshApplyDb()
    seedMessageWithBlocks(ctx, 'm-a', [
      { id: 'b-1', ts: 10, opId: 'op-1' },
      { id: 'b-2', ts: 11, opId: 'op-2' }
    ])
    const newer = makeBlockFrameOp({
      id: 'f-new',
      parentId: 'm-a',
      timestamp: 20,
      deviceId: 'd-x',
      orderedChildIds: ['b-2', 'b-1']
    })
    expect(ctx.svc.applyIncomingOperation(newer as never)).toBe(true)
    expect(blockOrder(ctx.sqlite, 'm-a')).toEqual(['b-2', 'b-1'])
    const older = makeBlockFrameOp({
      id: 'f-old',
      parentId: 'm-a',
      timestamp: 5,
      deviceId: 'd-x',
      orderedChildIds: ['b-1', 'b-2']
    })
    expect(ctx.svc.applyIncomingOperation(older as never)).toBe(false)
    expect(blockOrder(ctx.sqlite, 'm-a')).toEqual(['b-2', 'b-1'])
    // equal-clock idempotent (same effective)
    const sameEffective = makeBlockFrameOp({
      id: 'f-new',
      parentId: 'm-a',
      timestamp: 20,
      deviceId: 'd-x',
      orderedChildIds: ['b-2', 'b-1']
    })
    // duplicate id with same content is consumed as no-op via applied path (returns false)
    expect(ctx.svc.applyIncomingOperation({ ...sameEffective, id: 'f-new' } as never)).toBe(false)
    // equal-clock divergence fails closed
    const divergent = {
      ...makeBlockFrameOp({
        id: 'f-new',
        parentId: 'm-a',
        timestamp: 20,
        deviceId: 'd-x',
        orderedChildIds: ['b-1', 'b-2']
      }),
      id: 'f-new'
    }
    expect(() => ctx.svc.applyIncomingOperation(divergent as never)).toThrow()
    ctx.sqlite.close()
    bindSingleton(sqlite, db)
  })

  it('deleted/unknown/wrong-parent/suffix/incomplete/orphan gating', () => {
    const ctx = freshApplyDb()
    seedMessageWithBlocks(ctx, 'm-g', [{ id: 'b-1', ts: 10, opId: 'op-1' }])
    // unknown parent -> orphan
    const unknownParent = makeBlockFrameOp({
      id: 'f-u',
      parentId: 'm-missing',
      timestamp: 30,
      deviceId: 'd-x',
      orderedChildIds: []
    })
    expect(() => ctx.svc.applyIncomingOperation(unknownParent as never)).toThrowError(SyncOrphanError)
    // unknown listed child -> orphan
    const unknownChild = makeBlockFrameOp({
      id: 'f-uc',
      parentId: 'm-g',
      timestamp: 30,
      deviceId: 'd-x',
      orderedChildIds: ['b-1', 'b-ghost']
    })
    expect(() => ctx.svc.applyIncomingOperation(unknownChild as never)).toThrowError(SyncOrphanError)
    // wrong parent -> fail closed (not orphan)
    ctx.sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?,?,?,?)`)
      .run('t-2', 'T2', '2026-01-01', '2026-01-01')
    ctx.sqlite
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
      )
      .run('m-other', 't-2', 'user', 'x', 'success', '2026-01-01', '2026-01-01', 0)
    ctx.sqlite
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
      )
      .run('b-other', 'm-other', 'text', 'x', 'success', '2026-01-01', '2026-01-01', 0)
    ctx.sqlite
      .prepare(
        `INSERT INTO sync_membership_clock (child_entity_type, child_entity_id, parent_id, timestamp, operation_id) VALUES (?,?,?,?,?)`
      )
      .run('message_block', 'b-other', 'm-other', 12, 'op-12')
    const wrongParent = makeBlockFrameOp({
      id: 'f-w',
      parentId: 'm-g',
      timestamp: 30,
      deviceId: 'd-x',
      orderedChildIds: ['b-1', 'b-other']
    })
    expect(() => ctx.svc.applyIncomingOperation(wrongParent as never)).not.toThrowError(SyncOrphanError)
    expect(() => ctx.svc.applyIncomingOperation(wrongParent as never)).toThrow()
    // incomplete (receiver alive b-2 omitted) -> fail closed
    ctx.sqlite
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
      )
      .run('b-2', 'm-g', 'text', 'c2', 'success', '2026-01-01', '2026-01-01', 1)
    ctx.sqlite
      .prepare(
        `INSERT INTO sync_membership_clock (child_entity_type, child_entity_id, parent_id, timestamp, operation_id) VALUES (?,?,?,?,?)`
      )
      .run('message_block', 'b-2', 'm-g', 13, 'op-13')
    const incomplete = makeBlockFrameOp({
      id: 'f-inc',
      parentId: 'm-g',
      timestamp: 40,
      deviceId: 'd-x',
      orderedChildIds: ['b-1']
    })
    expect(() => ctx.svc.applyIncomingOperation(incomplete as never)).toThrow(/incomplete/)
    // suffix: concurrent child with membership > frameClock is appended deterministically
    const suffixFrame = makeBlockFrameOp({
      id: 'f-suf',
      parentId: 'm-g',
      timestamp: 12,
      deviceId: 'd-x',
      orderedChildIds: ['b-1']
    })
    expect(ctx.svc.applyIncomingOperation(suffixFrame as never)).toBe(true)
    expect(blockOrder(ctx.sqlite, 'm-g')).toEqual(['b-1', 'b-2'])
    // tombstoned parent consumes without materializing
    const ctx2 = freshApplyDb()
    ctx2.sqlite.prepare(`INSERT INTO sync_state (key, value) VALUES (?,?)`).run('tombstone:message:m-del', '35:f-del')
    const deletedParent = makeBlockFrameOp({
      id: 'f-del',
      parentId: 'm-del',
      timestamp: 36,
      deviceId: 'd-x',
      orderedChildIds: []
    })
    expect(ctx2.svc.applyIncomingOperation(deletedParent as never)).toBe(false)
    ctx.sqlite.close()
    ctx2.sqlite.close()
    bindSingleton(sqlite, db)
  })
})

describe('relay transport for messageBlock frames', () => {
  it('stores verbatim; illegal 400; idempotent replay; divergent 409', async () => {
    const rdb = new Database(':memory:')
    ensureRelaySchema(rdb)
    const server = createRelayServer(rdb, { token: 'blk-token' })
    await new Promise<void>((resolve) => {
      ;(server as unknown as { listen: (p: number, h: string, cb: () => void) => void }).listen(0, '127.0.0.1', () =>
        resolve()
      )
    })
    const base = `http://127.0.0.1:${(server as unknown as { address: () => { port: number } }).address().port}`
    const auth = { Authorization: 'Bearer blk-token', 'Content-Type': 'application/json' } as Record<string, string>
    const regA = (await (
      await fetch(`${base}/sync/register`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ deviceId: 'dev-a' })
      })
    ).json()) as { deviceCode: string; deviceSecret: string }
    const regB = (await (
      await fetch(`${base}/sync/register`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ deviceId: 'dev-b' })
      })
    ).json()) as { deviceCode: string; deviceSecret: string }
    const authed = (c: string, s: string): Record<string, string> => ({
      Authorization: 'Bearer blk-token',
      'Content-Type': 'application/json',
      'x-sync-device-code': c,
      'x-sync-device-secret': s
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

    const frame = makeBlockFrameOp({
      id: '22222222-0000-0000-0000-000000000001',
      parentId: 'm-r',
      timestamp: 100,
      deviceId: 'dev-a',
      orderedChildIds: ['b-1']
    })
    res = await fetch(`${base}/sync/push`, {
      method: 'POST',
      headers: authed(regA.deviceCode, regA.deviceSecret),
      body: JSON.stringify({ deviceId: 'dev-a', operations: [frame] })
    })
    expect(res.status).toBe(200)
    const pushBody = (await res.json()) as { acceptedIds: string[]; cursor: number }
    expect(pushBody.acceptedIds).toEqual(['22222222-0000-0000-0000-000000000001'])
    res = await fetch(`${base}/sync/pull?cursor=0&deviceId=dev-b`, {
      headers: authed(regB.deviceCode, regB.deviceSecret)
    })
    expect(res.status).toBe(200)
    const pullBody = (await res.json()) as { operations: Array<Record<string, unknown>>; cursor: number }
    expect(pullBody.operations.length).toBe(1)
    expect((pullBody.operations[0] as { payload: unknown }).payload).toEqual((frame as { payload: unknown }).payload)
    const illegal = makeBlockFrameOp({
      id: '22222222-0000-0000-0000-000000000002',
      parentId: 'm-r',
      timestamp: 101,
      deviceId: 'dev-a',
      orderedChildIds: ['b-1', 'b-1']
    })
    res = await fetch(`${base}/sync/push`, {
      method: 'POST',
      headers: authed(regA.deviceCode, regA.deviceSecret),
      body: JSON.stringify({ deviceId: 'dev-a', operations: [illegal] })
    })
    expect(res.status).toBe(400)
    res = await fetch(`${base}/sync/push`, {
      method: 'POST',
      headers: authed(regA.deviceCode, regA.deviceSecret),
      body: JSON.stringify({ deviceId: 'dev-a', operations: [frame] })
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { cursor: number }).cursor).toBe(pushBody.cursor)
    const divergent = makeBlockFrameOp({
      id: '22222222-0000-0000-0000-000000000001',
      parentId: 'm-r',
      timestamp: 100,
      deviceId: 'dev-a',
      orderedChildIds: []
    })
    res = await fetch(`${base}/sync/push`, {
      method: 'POST',
      headers: authed(regA.deviceCode, regA.deviceSecret),
      body: JSON.stringify({ deviceId: 'dev-a', operations: [divergent] })
    })
    expect(res.status).toBe(409)
    await new Promise<void>((resolve) => {
      try {
        ;(server as unknown as { close: (cb: () => void) => void }).close(() => resolve())
      } catch {
        resolve()
      }
    })
    rdb.close()
  })
})

describe('dual-profile real-relay block convergence without baseline (no manual reorder)', () => {
  it('stable create/promotion/delete converge incrementally with winning-frame order', async () => {
    const rdb = new Database(':memory:')
    ensureRelaySchema(rdb)
    const server = createRelayServer(rdb, { token: 'blk-dual' })
    await new Promise<void>((resolve) => {
      ;(server as unknown as { listen: (p: number, h: string, cb: () => void) => void }).listen(0, '127.0.0.1', () =>
        resolve()
      )
    })
    const base = `http://127.0.0.1:${(server as unknown as { address: () => { port: number } }).address().port}`
    const auth = { Authorization: 'Bearer blk-dual', 'Content-Type': 'application/json' } as Record<string, string>
    const regA = (await (
      await fetch(`${base}/sync/register`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ deviceId: 'device-blk-a' })
      })
    ).json()) as { deviceCode: string; deviceSecret: string }
    const regB = (await (
      await fetch(`${base}/sync/register`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ deviceId: 'device-blk-b' })
      })
    ).json()) as { deviceCode: string; deviceSecret: string }
    const authed = (c: string, s: string): Record<string, string> => ({
      Authorization: 'Bearer blk-dual',
      'Content-Type': 'application/json',
      'x-sync-device-code': c,
      'x-sync-device-secret': s
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
    bindSingleton(openedA.sqlite, openedA.db)
    configStore.set('deviceId', 'device-blk-a')
    const aggA = new ChatDbAggregateService(openedA.db, openedA.sqlite)
    vi.spyOn(Date, 'now').mockReturnValue(7_000_000_000_000)
    expect(aggA.ensureTopic('t-dd', 'assistant-1', 'Dual').ok).toBe(true)
    aggA.appendMessage(
      't-dd',
      { id: 'm-dd', topicId: 't-dd', role: 'user', content: 'hi', status: 'success' } as never,
      [stableBlock('bb-1', 'm-dd') as never]
    )
    vi.spyOn(Date, 'now').mockReturnValue(7_000_000_000_001)
    aggA.bulkAddBlocks([stableBlock('bb-2', 'm-dd') as never])
    vi.spyOn(Date, 'now').mockReturnValue(7_000_000_000_002)
    aggA.deleteBlocks(['bb-1'])
    const expected = ['bb-2']
    expect(blockOrder(openedA.sqlite, 'm-dd')).toEqual(expected)
    const frameA = blockFrameOf(openedA.sqlite, 'm-dd')!
    expect(frameA.orderedChildIds).toEqual(expected)

    bindSingleton(openedA.sqlite, openedA.db)
    const outboxA = openedA.db.select().from(schema.syncOutbox).all()
    expect(outboxA.some((r) => r.op === 'order_frame' && r.entityType === 'message')).toBe(true)
    const opsA = outboxA.map((r) => ({
      id: r.id,
      entityType: r.entityType,
      op: r.op,
      entityId: r.entityId,
      timestamp: r.timestamp,
      deviceId: r.deviceId,
      ...(r.payloadJson ? { payload: JSON.parse(r.payloadJson) } : {})
    }))
    for (let i = 0; i < opsA.length; i += 50) {
      const chunk = opsA.slice(i, i + 50)
      const pushRes = await fetch(`${base}/sync/push`, {
        method: 'POST',
        headers: authed(regA.deviceCode, regA.deviceSecret),
        body: JSON.stringify({ deviceId: 'device-blk-a', operations: chunk })
      })
      expect(pushRes.status).toBe(200)
    }
    bindSingleton(openedB.sqlite, openedB.db)
    const svcB = new SyncService()
    let cursor = 0
    for (;;) {
      const pullRes = await fetch(`${base}/sync/pull?cursor=${cursor}&deviceId=device-blk-b`, {
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
            deferred.push(op)
            continue
          }
          throw e
        }
      }
      for (const op of deferred) svcB.applyIncomingOperation(op as never)
      cursor = body.cursor
      if (body.operations.length < 200) break
    }
    const baselineRes = await fetch(`${base}/sync/baseline`, { headers: authed(regB.deviceCode, regB.deviceSecret) })
    expect(baselineRes.status).toBe(404)
    expect(blockOrder(openedB.sqlite, 'm-dd')).toEqual(expected)
    const frameB = blockFrameOf(openedB.sqlite, 'm-dd')!
    expect(frameB.orderedChildIds).toEqual(expected)
    expect(frameB.timestamp).toBe(frameA.timestamp)
    expect(frameB.operationId).toBe(frameA.operationId)
    // No block reorder API exists: convergence order equals the winning frame, never a manual reorder claim.
    try {
      openedA.sqlite.close()
    } catch {}
    try {
      openedB.sqlite.close()
    } catch {}
    bindSingleton(sqlite, db)
    await new Promise<void>((resolve) => {
      try {
        ;(server as unknown as { close: (cb: () => void) => void }).close(() => resolve())
      } catch {
        resolve()
      }
    })
    rdb.close()
  })
})

describe('audit F1/F2: single per-parent frame decision', () => {
  function highWater(parentId: string): number | null {
    const r = sqlite
      .prepare(`SELECT max_timestamp AS ts FROM sync_frame_high_water WHERE kind='messageBlock' AND parent_id=?`)
      .get(parentId) as { ts: number } | undefined
    return r ? r.ts : null
  }

  function membershipOf(blockId: string): { timestamp: number; operationId: string } | null {
    const r = sqlite
      .prepare(
        `SELECT timestamp, operation_id AS operationId FROM sync_membership_clock WHERE child_entity_type='message_block' AND child_entity_id=?`
      )
      .get(blockId) as { timestamp: number; operationId: string } | undefined
    return r ?? null
  }

  it('F2: pre-existing untracked block promotion stays entity-only — 0 frame op, frame null, truthful partial', () => {
    vi.spyOn(Date, 'now').mockReturnValue(6_100_000_000_000)
    agg.ensureTopic('t-f2', 'assistant-1', 'T')
    agg.appendMessage(
      't-f2',
      { id: 't-f2-m1', topicId: 't-f2', role: 'user', content: 'a', status: 'success' } as never,
      []
    )
    agg.appendMessage(
      't-f2',
      { id: 't-f2-m2', topicId: 't-f2', role: 'user', content: 'b', status: 'success' } as never,
      []
    )
    expect(agg.updateMessage('t-f2', 't-f2-m1', { status: 'streaming' } as never).ok).toBe(true)
    sqlite
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
      )
      .run('t-f2-b9', 't-f2-m1', 'text', 'legacy', 'success', '2026-01-01', '2026-01-01', 0)
    expect(membershipOf('t-f2-b9')).toBeNull()
    const before = blockFrameOps(db, 't-f2-m1').length
    vi.spyOn(Date, 'now').mockReturnValue(6_100_000_000_001)
    // Governance (009/SYNC-DATA-035): promotion rescan is entity-only, never
    // membership backfill. The pre-existing block stays unversioned, so the
    // single per-parent try-refresh must invalidate with 0 op while the user
    // mutation still succeeds.
    const promote = agg.updateMessage('t-f2', 't-f2-m1', { status: 'success' } as never)
    expect(promote.ok).toBe(true)
    expect(membershipOf('t-f2-b9')).toBeNull()
    expect(blockFrameOps(db, 't-f2-m1').length).toBe(before)
    expect(blockFrameOf(sqlite, 't-f2-m1')).toBeNull()
    const outbox = db.select().from(schema.syncOutbox).all()
    const entOp = outbox.find((r) => r.entityType === 'message_block' && r.entityId === 't-f2-b9')
    expect(entOp).toBeTruthy()
    const cand = captureLocalSyncBaselineCandidate(db as never) as {
      completeness: { state: string; reasons: string[] }
      manifest: {
        unversionedMembershipCount: number
        missingOrderFrameCount: number
        incompleteOrderFrameCount: number
      }
    }
    // Truthful partial: unversioned membership plus missing frame for the
    // promotion parent; never synthesized complete.
    expect(cand.completeness.state).not.toBe('complete')
    expect(cand.manifest.unversionedMembershipCount).toBeGreaterThan(0)
    expect(cand.manifest.missingOrderFrameCount).toBeGreaterThan(0)
    expect(cand.completeness.reasons).toContain('unversioned-membership')
    expect(cand.completeness.reasons).toContain('missing-order-frame')
  })

  it('F2-reachable: promotion with all block membership trustworthy mints exactly one complete frame', () => {
    vi.spyOn(Date, 'now').mockReturnValue(6_100_000_000_050)
    agg.ensureTopic('t-f2r', 'assistant-1', 'T')
    agg.appendMessage(
      't-f2r',
      { id: 't-f2r-m1', topicId: 't-f2r', role: 'user', content: 'a', status: 'success' } as never,
      [stableBlock('t-f2r-b1', 't-f2r-m1') as never]
    )
    expect(membershipOf('t-f2r-b1')).not.toBeNull()
    expect(blockFrameOf(sqlite, 't-f2r-m1')).not.toBeNull()
    // Stable→transient exclusion invalidates locally with 0 op.
    expect(agg.updateMessage('t-f2r', 't-f2r-m1', { status: 'streaming' } as never).ok).toBe(true)
    expect(blockFrameOf(sqlite, 't-f2r-m1')).toBeNull()
    const before = blockFrameOps(db, 't-f2r-m1').length
    vi.spyOn(Date, 'now').mockReturnValue(6_100_000_000_051)
    // Transient→stable promotion: every included block already carries
    // trustworthy creation membership, so the single per-parent try-refresh
    // mints exactly one complete frame reusing the winning clock.
    const promote = agg.updateMessage('t-f2r', 't-f2r-m1', { status: 'success' } as never)
    expect(promote.ok).toBe(true)
    const ops = blockFrameOps(db, 't-f2r-m1')
    expect(ops.length).toBe(before + 1)
    const frame = blockFrameOf(sqlite, 't-f2r-m1')!
    expect(frame).not.toBeNull()
    expect(frame.orderedChildIds).toEqual(['t-f2r-b1'])
    expect(ops[ops.length - 1].id).toBe(frame.operationId)
    expect(ops[ops.length - 1].timestamp).toBe(frame.timestamp)
    const payload = JSON.parse(ops[ops.length - 1].payloadJson as string) as Record<string, unknown>
    expect(payload).toEqual({
      frameVersion: 'parent-order-frame-v1',
      kind: 'messageBlock',
      parentId: 't-f2r-m1',
      orderedChildIds: ['t-f2r-b1'],
      frameClock: { timestamp: frame.timestamp, operationId: frame.operationId }
    })
    expect(membershipOf('t-f2r-b1')!.timestamp).toBeLessThan(frame.timestamp)
  })

  it('F1: updateMessageAndBlocks stable true-create + inclusion mints exactly one final frame', () => {
    vi.spyOn(Date, 'now').mockReturnValue(6_100_000_000_100)
    agg.ensureTopic('t-f1', 'assistant-1', 'T')
    // Stable parent with two trustworthy versioned blocks (creation membership present).
    agg.appendMessage(
      't-f1',
      { id: 't-f1-m1', topicId: 't-f1', role: 'assistant', content: 's', status: 'success' } as never,
      [stableBlock('t-f1-b0', 't-f1-m1') as never, stableBlock('t-f1-bd', 't-f1-m1') as never]
    )
    const before = blockFrameOps(db, 't-f1-m1').length
    expect(before).toBe(1)
    vi.spyOn(Date, 'now').mockReturnValue(6_100_000_000_101)
    // Combined stable tx: true-create stable block + inclusion transition via
    // delete of a previously included block. Single unified frame must carry
    // the final complete order (no promotion, no untracked backfill).
    const res = agg.updateMessageAndBlocks(
      't-f1',
      { id: 't-f1-m1', content: 's2' } as never,
      [stableBlock('t-f1-b1', 't-f1-m1') as never],
      ['t-f1-bd']
    )
    expect(res.ok).toBe(true)
    const ops = blockFrameOps(db, 't-f1-m1')
    expect(ops.length).toBe(before + 1)
    const frame = blockFrameOf(sqlite, 't-f1-m1')!
    expect(frame.orderedChildIds).toEqual(blockOrder(sqlite, 't-f1-m1'))
    expect(frame.orderedChildIds).toEqual(expect.arrayContaining(['t-f1-b0', 't-f1-b1']))
    expect(frame.orderedChildIds).not.toContain('t-f1-bd')
    expect(ops[ops.length - 1].id).toBe(frame.operationId)
    expect(ops[ops.length - 1].timestamp).toBe(frame.timestamp)
    const payload = JSON.parse(ops[ops.length - 1].payloadJson as string) as {
      orderedChildIds: string[]
      frameClock: { timestamp: number; operationId: string }
    }
    expect(payload.orderedChildIds).toEqual(frame.orderedChildIds)
    expect(payload.frameClock).toEqual({ timestamp: frame.timestamp, operationId: frame.operationId })
  })

  it('rollback leaves no dual frame op and no high-water residue', () => {
    vi.spyOn(Date, 'now').mockReturnValue(6_100_000_000_200)
    agg.ensureTopic('t-rb', 'assistant-1', 'T')
    agg.appendMessage(
      't-rb',
      { id: 't-rb-m1', topicId: 't-rb', role: 'assistant', content: 's', status: 'streaming' } as never,
      [stableBlock('t-rb-b0', 't-rb-m1') as never]
    )
    vi.spyOn(Date, 'now').mockReturnValue(6_100_000_000_201)
    sqlite.prepare(`UPDATE message_blocks SET extra='not-json' WHERE id='t-rb-b0'`).run()
    const outboxBefore = db.select().from(schema.syncOutbox).all().length
    const opsBefore = blockFrameOps(db, 't-rb-m1').length
    const hwBefore = highWater('t-rb-m1')
    const res = agg.updateMessageAndBlocks(
      't-rb',
      { id: 't-rb-m1', status: 'success' } as never,
      [stableBlock('t-rb-b1', 't-rb-m1') as never],
      []
    )
    expect(res.ok).toBe(false)
    expect(sqlite.prepare(`SELECT id FROM message_blocks WHERE id='t-rb-b1'`).get()).toBeUndefined()
    expect(blockFrameOps(db, 't-rb-m1').length).toBe(opsBefore)
    expect(db.select().from(schema.syncOutbox).all().length).toBe(outboxBefore)
    expect(highWater('t-rb-m1')).toBe(hwBefore)
  })

  it('exclusion priority: stable->transient parent tail never mints', () => {
    vi.spyOn(Date, 'now').mockReturnValue(6_100_000_000_300)
    agg.ensureTopic('t-ex', 'assistant-1', 'T')
    agg.appendMessage(
      't-ex',
      { id: 't-ex-m1', topicId: 't-ex', role: 'user', content: 'hi', status: 'success' } as never,
      [stableBlock('t-ex-b0', 't-ex-m1') as never]
    )
    expect(blockFrameOf(sqlite, 't-ex-m1')).not.toBeNull()
    const before = blockFrameOps(db, 't-ex-m1').length
    const res = agg.updateMessageAndBlocks(
      't-ex',
      { id: 't-ex-m1', status: 'streaming' } as never,
      [stableBlock('t-ex-b1', 't-ex-m1') as never],
      []
    )
    expect(res.ok).toBe(true)
    expect(blockFrameOf(sqlite, 't-ex-m1')).toBeNull()
    expect(blockFrameOps(db, 't-ex-m1').length).toBe(before)
    expect((sqlite.prepare(`SELECT status FROM messages WHERE id=?`).get('t-ex-m1') as { status: string }).status).toBe(
      'streaming'
    )
    expect(sqlite.prepare(`SELECT id FROM message_blocks WHERE id='t-ex-b1'`).get()).toBeTruthy()
  })

  it('ordinary batch methods mint at most one frame op per parent', () => {
    vi.spyOn(Date, 'now').mockReturnValue(6_100_000_000_400)
    agg.ensureTopic('t-ba', 'assistant-1', 'T')
    agg.appendMessage(
      't-ba',
      { id: 't-ba-m1', topicId: 't-ba', role: 'user', content: 'a', status: 'success' } as never,
      [stableBlock('t-ba-b0', 't-ba-m1') as never]
    )
    agg.appendMessage(
      't-ba',
      { id: 't-ba-m2', topicId: 't-ba', role: 'user', content: 'b', status: 'success' } as never,
      [stableBlock('t-ba-c0', 't-ba-m2') as never]
    )
    const bulkBefore = blockFrameOps(db, 't-ba-m1').length
    expect(
      agg.bulkAddBlocks([stableBlock('t-ba-b1', 't-ba-m1') as never, stableBlock('t-ba-b2', 't-ba-m1') as never]).ok
    ).toBe(true)
    expect(blockFrameOps(db, 't-ba-m1').length).toBe(bulkBefore + 1)
    expect(blockFrameOf(sqlite, 't-ba-m1')!.orderedChildIds).toEqual(blockOrder(sqlite, 't-ba-m1'))
    const updBefore = blockFrameOps(db, 't-ba-m1').length
    expect(
      agg.updateBlocks([
        stableBlock('t-ba-b3', 't-ba-m1') as never,
        { ...stableBlock('t-ba-b1', 't-ba-m1'), content: 'edited' } as never
      ]).ok
    ).toBe(true)
    expect(blockFrameOps(db, 't-ba-m1').length - updBefore).toBeLessThanOrEqual(1)
    expect(blockFrameOf(sqlite, 't-ba-m1')!.orderedChildIds).toEqual(blockOrder(sqlite, 't-ba-m1'))
    const p1Before = blockFrameOps(db, 't-ba-m1').length
    const p2Before = blockFrameOps(db, 't-ba-m2').length
    expect(
      agg.updateBlocks([stableBlock('t-ba-b4', 't-ba-m1') as never, stableBlock('t-ba-c1', 't-ba-m2') as never]).ok
    ).toBe(true)
    expect(blockFrameOps(db, 't-ba-m1').length - p1Before).toBeLessThanOrEqual(1)
    expect(blockFrameOps(db, 't-ba-m2').length - p2Before).toBeLessThanOrEqual(1)
    const delBefore = blockFrameOps(db, 't-ba-m1').length
    expect(agg.deleteBlocks(['t-ba-b0', 't-ba-b2']).ok).toBe(true)
    expect(blockFrameOps(db, 't-ba-m1').length - delBefore).toBeLessThanOrEqual(1)
    expect(blockFrameOf(sqlite, 't-ba-m1')!.orderedChildIds).toEqual(blockOrder(sqlite, 't-ba-m1'))
  })
})
