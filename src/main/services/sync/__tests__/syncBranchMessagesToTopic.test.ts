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

import { eq } from 'drizzle-orm'

import { createRelayServer, ensureRelaySchema } from '../../../../../scripts/sync-relay/server'
import { chatDbService } from '../../chatDb'
import { ChatDbAggregateService } from '../../chatDb/ChatDbAggregateService'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { captureLocalSyncBaselineCandidate } from '../syncBaseline'
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

function stableBlock(id: string, messageId: string, overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    messageId,
    type: 'main_text',
    content: `content-${id}`,
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

function msgJson(id: string, topicId: string, overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    topicId,
    role: 'user',
    content: `content-${id}`,
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

function topicFrameOf(sqlite: Database.Database, parentId: string) {
  const r = sqlite
    .prepare(
      `SELECT ordered_child_ids_json AS json, timestamp, operation_id AS operationId FROM sync_parent_order_frame WHERE kind='topicMessage' AND parent_id=?`
    )
    .get(parentId) as { json: string; timestamp: number; operationId: string } | undefined
  if (!r) return null
  return { orderedChildIds: JSON.parse(r.json) as string[], timestamp: r.timestamp, operationId: r.operationId }
}

function blockFrameOf(sqlite: Database.Database, parentId: string) {
  const r = sqlite
    .prepare(
      `SELECT ordered_child_ids_json AS json, timestamp, operation_id AS operationId FROM sync_parent_order_frame WHERE kind='messageBlock' AND parent_id=?`
    )
    .get(parentId) as { json: string; timestamp: number; operationId: string } | undefined
  if (!r) return null
  return { orderedChildIds: JSON.parse(r.json) as string[], timestamp: r.timestamp, operationId: r.operationId }
}

function messageOrder(sqlite: Database.Database, topicId: string): string[] {
  return (
    sqlite.prepare(`SELECT id FROM messages WHERE topic_id=? ORDER BY sort_order ASC, id ASC`).all(topicId) as Array<{
      id: string
    }>
  ).map((r) => r.id)
}

function membershipOf(
  sqlite: Database.Database,
  childType: string,
  childId: string
): { parentId: string; timestamp: number; operationId: string } | undefined {
  return sqlite
    .prepare(
      `SELECT parent_id AS parentId, timestamp, operation_id AS operationId FROM sync_membership_clock WHERE child_entity_type=? AND child_entity_id=?`
    )
    .get(childType, childId) as { parentId: string; timestamp: number; operationId: string } | undefined
}

function outboxRows(db: BetterSQLite3Database<typeof schema>) {
  return db.select().from(schema.syncOutbox).all()
}

function highWaterSnapshot(sqlite: Database.Database): Array<{ kind: string; parentId: string; ts: number }> {
  return sqlite
    .prepare(
      `SELECT kind, parent_id AS parentId, max_timestamp AS ts FROM sync_frame_high_water ORDER BY kind, parent_id`
    )
    .all() as Array<{ kind: string; parentId: string; ts: number }>
}

function frameSnapshot(
  sqlite: Database.Database
): Array<{ kind: string; parentId: string; json: string; ts: number; op: string }> {
  return sqlite
    .prepare(
      `SELECT kind, parent_id AS parentId, ordered_child_ids_json AS json, timestamp AS ts, operation_id AS op FROM sync_parent_order_frame ORDER BY kind, parent_id`
    )
    .all() as Array<{ kind: string; parentId: string; json: string; ts: number; op: string }>
}

function seedSource(
  agg: ChatDbAggregateService,
  topicId: string,
  ids: string[],
  opts?: { roleOf?: (id: string) => string; askIdOf?: (id: string) => string | undefined }
): void {
  for (const id of ids) {
    const role = opts?.roleOf?.(id) ?? 'user'
    const askId = opts?.askIdOf?.(id)
    agg.appendMessage(
      topicId,
      msgJson(id, topicId, role === 'user' ? { role } : { role, askId: askId ?? null }) as never,
      [stableBlock(`b-${id}`, id, { messageId: id }) as never]
    )
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

describe('branchMessagesToTopic incremental sync', () => {
  it('stable mid-anchor branch clones prefix with fresh IDs, source untouched, memberships, mirrors and dense order', () => {
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_000_000)
    expect(agg.ensureTopic('t-bsrc', 'assistant-1', 'S').ok).toBe(true)
    seedSource(agg, 't-bsrc', ['m-s0', 'm-s1', 'm-s2', 'm-s3'])
    const sourceOrderBefore = messageOrder(sqlite, 't-bsrc')
    const sourceOutboxBefore = outboxRows(db).filter((r) =>
      ['m-s0', 'm-s1', 'm-s2', 'm-s3', 'b-m-s0', 'b-m-s1', 'b-m-s2', 'b-m-s3'].includes(r.entityId)
    ).length
    const outboxBefore = outboxRows(db).length
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_000_100)
    const res = agg.branchMessagesToTopic('t-bsrc', 't-bdst', 'm-s1', 'assistant-1')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // Prefix length 2, fresh IDs, source untouched.
    expect(res.value.messages.length).toBe(2)
    expect(messageOrder(sqlite, 't-bsrc')).toEqual(sourceOrderBefore)
    const clonedIds = messageOrder(sqlite, 't-bdst')
    expect(clonedIds.length).toBe(2)
    for (const id of clonedIds) {
      expect(['m-s0', 'm-s1', 'm-s2', 'm-s3']).not.toContain(id)
    }
    // Source produced zero new outbox operations.
    const sourceOutboxAfter = outboxRows(db).filter((r) =>
      ['m-s0', 'm-s1', 'm-s2', 'm-s3', 'b-m-s0', 'b-m-s1', 'b-m-s2', 'b-m-s3'].includes(r.entityId)
    ).length
    expect(sourceOutboxAfter).toBe(sourceOutboxBefore)
    // Memberships exact to the branch clock, parented to the target.
    for (const id of clonedIds) {
      expect(membershipOf(sqlite, 'message', id)?.parentId).toBe('t-bdst')
    }
    const clonedBlocks = sqlite
      .prepare(
        `SELECT id, message_id AS messageId FROM message_blocks WHERE message_id IN ('${clonedIds.join("','")}')`
      )
      .all() as Array<{ id: string; messageId: string }>
    expect(clonedBlocks.length).toBe(2)
    for (const b of clonedBlocks) {
      expect(membershipOf(sqlite, 'message_block', b.id)?.parentId).toBe(b.messageId)
      const payload = outboxRows(db).find(
        (r) => r.op === 'upsert' && r.entityType === 'message_block' && r.entityId === b.id
      )
      expect(payload).toBeTruthy()
      expect(JSON.parse(payload!.payloadJson as string)).not.toHaveProperty('sortOrder')
    }
    // Message upserts carry full state without sortOrder.
    for (const id of clonedIds) {
      const up = outboxRows(db).find((r) => r.op === 'upsert' && r.entityType === 'message' && r.entityId === id)
      expect(up).toBeTruthy()
      const payload = JSON.parse(up!.payloadJson as string) as Record<string, unknown>
      expect(payload).toMatchObject({ id, topicId: 't-bdst' })
      expect(payload).not.toHaveProperty('sortOrder')
    }
    // One topic frame + one block frame per new parent, id/time mirrors, dense order.
    const topicFrames = outboxRows(db).filter(
      (r) => r.op === 'order_frame' && r.entityType === 'topic' && r.entityId === 't-bdst'
    )
    expect(topicFrames.length).toBe(1)
    const storedTopic = topicFrameOf(sqlite, 't-bdst')!
    expect(storedTopic.orderedChildIds).toEqual(clonedIds)
    expect(topicFrames[0].id).toBe(storedTopic.operationId)
    expect(topicFrames[0].timestamp).toBe(storedTopic.timestamp)
    for (const id of clonedIds) {
      const bf = outboxRows(db).filter((r) => r.op === 'order_frame' && r.entityType === 'message' && r.entityId === id)
      expect(bf.length).toBe(1)
      expect(bf[0].id).toBe(blockFrameOf(sqlite, id)!.operationId)
      expect(bf[0].timestamp).toBe(blockFrameOf(sqlite, id)!.timestamp)
    }
    const sorts = sqlite
      .prepare(`SELECT sort_order AS s FROM messages WHERE topic_id='t-bdst' ORDER BY sort_order`)
      .all() as Array<{ s: number }>
    expect(sorts.map((r) => r.s)).toEqual([0, 1])
    expect(outboxRows(db).length).toBeGreaterThan(outboxBefore)
  })

  it('first/mid/last anchors clone exact prefixes', () => {
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_001_000)
    expect(agg.ensureTopic('t-bpre', 'assistant-1', 'S').ok).toBe(true)
    seedSource(agg, 't-bpre', ['m-p0', 'm-p1', 'm-p2', 'm-p3'])
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_001_100)
    const first = agg.branchMessagesToTopic('t-bpre', 't-bfirst', 'm-p0', 'assistant-1')
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.value.messages.length).toBe(1)
    expect(messageOrder(sqlite, 't-bfirst').length).toBe(1)
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_001_200)
    const mid = agg.branchMessagesToTopic('t-bpre', 't-bmid', 'm-p2', 'assistant-1')
    expect(mid.ok).toBe(true)
    if (!mid.ok) return
    expect(mid.value.messages.length).toBe(3)
    expect(messageOrder(sqlite, 't-bmid').length).toBe(3)
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_001_300)
    const last = agg.branchMessagesToTopic('t-bpre', 't-blast', 'm-p3', 'assistant-1')
    expect(last.ok).toBe(true)
    if (!last.ok) return
    expect(last.value.messages.length).toBe(4)
    expect(messageOrder(sqlite, 't-blast').length).toBe(4)
    // Source still owns its exact four messages.
    expect(messageOrder(sqlite, 't-bpre')).toEqual(['m-p0', 'm-p1', 'm-p2', 'm-p3'])
  })

  it('askId remaps to the cloned parent when included and nulls when outside the prefix, in wire and outbox', () => {
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_002_000)
    expect(agg.ensureTopic('t-bask', 'assistant-1', 'S').ok).toBe(true)
    agg.appendMessage('t-bask', msgJson('m-u1', 't-bask', { role: 'user' }) as never, [])
    agg.appendMessage('t-bask', msgJson('m-a2', 't-bask', { role: 'assistant', askId: 'm-u1' }) as never, [
      stableBlock('b-a2', 'm-a2', { messageId: 'm-a2' }) as never
    ])
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_002_100)
    const inc = agg.branchMessagesToTopic('t-bask', 't-bask-inc', 'm-a2', 'assistant-1')
    expect(inc.ok).toBe(true)
    if (!inc.ok) return
    const wireInc = inc.value.messages as Array<Record<string, unknown>>
    const wUser = wireInc.find((m) => m.role === 'user')!
    const wAsst = wireInc.find((m) => m.role === 'assistant')!
    expect(wAsst.askId).toBe(wUser.id)
    expect(wAsst.askId).not.toBe('m-u1')
    const clonedIds = messageOrder(sqlite, 't-bask-inc')
    const clonedUser = clonedIds[0]
    const clonedAsst = clonedIds[1]
    expect(
      (sqlite.prepare(`SELECT ask_id AS askId FROM messages WHERE id=?`).get(clonedAsst) as { askId: string }).askId
    ).toBe(clonedUser)
    const asstUp = outboxRows(db).find(
      (r) => r.op === 'upsert' && r.entityType === 'message' && r.entityId === clonedAsst
    )!
    expect((JSON.parse(asstUp.payloadJson as string) as Record<string, unknown>).askId).toBe(clonedUser)

    // Outside-prefix: assistant references a later message outside the cloned prefix.
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_002_200)
    expect(agg.ensureTopic('t-bask2', 'assistant-1', 'S').ok).toBe(true)
    agg.appendMessage('t-bask2', msgJson('m-o1', 't-bask2', { role: 'user' }) as never, [])
    agg.appendMessage('t-bask2', msgJson('m-o2', 't-bask2', { role: 'assistant', askId: 'm-o3' }) as never, [])
    agg.appendMessage('t-bask2', msgJson('m-o3', 't-bask2', { role: 'user' }) as never, [])
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_002_300)
    const out = agg.branchMessagesToTopic('t-bask2', 't-bask2-out', 'm-o2', 'assistant-1')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const wireOut = out.value.messages as Array<Record<string, unknown>>
    const wAsstOut = wireOut.find((m) => m.role === 'assistant')!
    expect(wAsstOut.askId === null || wAsstOut.askId === undefined).toBe(true)
    const clonedOutIds = messageOrder(sqlite, 't-bask2-out')
    expect(clonedOutIds.length).toBe(2)
    const clonedAsstOut = (
      sqlite.prepare(`SELECT id FROM messages WHERE topic_id='t-bask2-out' AND role='assistant'`).get() as {
        id: string
      }
    ).id
    expect(
      (sqlite.prepare(`SELECT ask_id AS askId FROM messages WHERE id=?`).get(clonedAsstOut) as { askId: null }).askId
    ).toBeNull()
    const asstOutUp = outboxRows(db).find(
      (r) => r.op === 'upsert' && r.entityType === 'message' && r.entityId === clonedAsstOut
    )!
    expect((JSON.parse(asstOutUp.payloadJson as string) as Record<string, unknown>).askId).toBeNull()
  })

  it('transient and unsupported clones persist locally with zero wire op/membership, local-only file refs and truthful partial', () => {
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_003_000)
    expect(agg.ensureTopic('t-bmix', 'assistant-1', 'S').ok).toBe(true)
    agg.appendMessage('t-bmix', msgJson('m-mu', 't-bmix', { role: 'user' }) as never, [
      stableBlock('b-mu', 'm-mu', { messageId: 'm-mu' }) as never
    ])
    agg.appendMessage(
      't-bmix',
      msgJson('m-mtr', 't-bmix', { role: 'assistant', status: 'streaming', askId: 'm-mu' }) as never,
      [stableBlock('b-mtr', 'm-mtr', { messageId: 'm-mtr' }) as never]
    )
    agg.appendMessage('t-bmix', msgJson('m-mf', 't-bmix', { role: 'user' }) as never, [
      {
        ...stableBlock('b-mf', 'm-mf', { messageId: 'm-mf' }),
        type: 'file',
        file: { id: 'file-mix', name: 'm.pdf', path: '/tmp/m.pdf', type: 'application/pdf' }
      } as never
    ])
    expect(sqlite.prepare(`SELECT id FROM file_references WHERE block_id='b-mf'`).get()).toBeTruthy()
    const outboxBefore = outboxRows(db).length
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_003_100)
    const res = agg.branchMessagesToTopic('t-bmix', 't-bmix-dst', 'm-mf', 'assistant-1')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.messages.length).toBe(3)
    const clonedIds = messageOrder(sqlite, 't-bmix-dst')
    expect(clonedIds.length).toBe(3)
    const clonedFileBlock = sqlite
      .prepare(`SELECT id FROM message_blocks WHERE type='file' AND message_id IN ('${clonedIds.join("','")}')`)
      .get() as { id: string }
    expect(clonedFileBlock).toBeTruthy()
    // Local-only file ref cloned for the file block.
    expect(sqlite.prepare(`SELECT id FROM file_references WHERE block_id=?`).get(clonedFileBlock.id)).toBeTruthy()
    // Zero wire ops/membership for the transient message pair and the file block.
    const clonedTr = (
      sqlite.prepare(`SELECT id FROM messages WHERE topic_id='t-bmix-dst' AND status='streaming'`).get() as {
        id: string
      }
    ).id
    expect(outboxRows(db).filter((r) => r.entityId === clonedTr).length).toBe(0)
    expect(membershipOf(sqlite, 'message', clonedTr)).toBeUndefined()
    const clonedTrBlock = (
      sqlite.prepare(`SELECT id FROM message_blocks WHERE message_id=?`).get(clonedTr) as { id: string }
    ).id
    expect(outboxRows(db).filter((r) => r.entityId === clonedTrBlock).length).toBe(0)
    expect(membershipOf(sqlite, 'message_block', clonedTrBlock)).toBeUndefined()
    expect(outboxRows(db).filter((r) => r.entityId === clonedFileBlock.id).length).toBe(0)
    expect(membershipOf(sqlite, 'message_block', clonedFileBlock.id)).toBeUndefined()
    // Stable user clones ride the wire.
    const clonedStable = (
      sqlite
        .prepare(`SELECT id FROM messages WHERE topic_id='t-bmix-dst' AND status='success' AND role='user'`)
        .all() as Array<{ id: string }>
    ).map((r) => r.id)
    expect(clonedStable.length).toBe(2)
    for (const id of clonedStable) {
      expect(
        outboxRows(db).filter((r) => r.op === 'upsert' && r.entityType === 'message' && r.entityId === id).length
      ).toBe(1)
    }
    // Topic frame covers only stable-supported children; excluded parents invalidate with 0 op.
    const storedTopic = topicFrameOf(sqlite, 't-bmix-dst')!
    expect(storedTopic.orderedChildIds).toEqual(expect.arrayContaining(clonedStable))
    expect(storedTopic.orderedChildIds).not.toContain(clonedTr)
    expect(blockFrameOf(sqlite, clonedTr)).toBeNull()
    const fileParent = (
      sqlite.prepare(`SELECT message_id AS messageId FROM message_blocks WHERE id=?`).get(clonedFileBlock.id) as {
        messageId: string
      }
    ).messageId
    expect(blockFrameOf(sqlite, fileParent)).toBeNull()
    expect(
      outboxRows(db).filter((r) => r.op === 'order_frame' && r.entityType === 'message' && r.entityId === clonedTr)
        .length
    ).toBe(0)
    expect(
      outboxRows(db).filter((r) => r.op === 'order_frame' && r.entityType === 'message' && r.entityId === fileParent)
        .length
    ).toBe(0)
    expect(outboxRows(db).length).toBeGreaterThan(outboxBefore)
    // Truthful partial with a durable unsupported outcome.
    const cand = captureLocalSyncBaselineCandidate(db as never) as {
      completeness: { state: string; reasons: string[] }
    }
    expect(cand.completeness.state).not.toBe('complete')
    const cap = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastCaptureError')).get()
    expect(cap?.value).toContain('unsupported block')
  })

  it('missing target emits exactly one parent-first topic upsert; existing target emits no topic op', () => {
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_004_000)
    expect(agg.ensureTopic('t-bt', 'assistant-1', 'S').ok).toBe(true)
    seedSource(agg, 't-bt', ['m-t0', 'm-t1'])
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_004_100)
    const res = agg.branchMessagesToTopic('t-bt', 't-bt-missing', 'm-t1', 'assistant-1')
    expect(res.ok).toBe(true)
    const ops = outboxRows(db)
    const topicUps = ops.filter((r) => r.op === 'upsert' && r.entityType === 'topic' && r.entityId === 't-bt-missing')
    expect(topicUps.length).toBe(1)
    const topicPayload = JSON.parse(topicUps[0].payloadJson as string) as Record<string, unknown>
    expect(topicPayload).toMatchObject({ id: 't-bt-missing' })
    expect(topicPayload).not.toHaveProperty('sortOrder')
    const clonedIds = messageOrder(sqlite, 't-bt-missing')
    const msgUps = clonedIds.map(
      (id) => ops.find((r) => r.op === 'upsert' && r.entityType === 'message' && r.entityId === id)!
    )
    expect(msgUps.every(Boolean)).toBe(true)
    const blkId = (
      sqlite.prepare(`SELECT id FROM message_blocks WHERE message_id=?`).get(clonedIds[0]) as { id: string }
    ).id
    const blkUp = ops.find((r) => r.op === 'upsert' && r.entityType === 'message_block' && r.entityId === blkId)!
    const topicFrame = ops.find(
      (r) => r.op === 'order_frame' && r.entityType === 'topic' && r.entityId === 't-bt-missing'
    )!
    const blkFrame = ops.find(
      (r) => r.op === 'order_frame' && r.entityType === 'message' && r.entityId === clonedIds[0]
    )!
    expect(topicUps[0].timestamp).toBeLessThan(msgUps[0].timestamp)
    expect(msgUps[0].timestamp).toBeLessThan(blkUp.timestamp)
    expect(msgUps[1].timestamp).toBeLessThan(topicFrame.timestamp)
    expect(blkUp.timestamp).toBeLessThan(blkFrame.timestamp)
    expect(topicFrame.id).toBe(topicFrameOf(sqlite, 't-bt-missing')!.operationId)

    // Existing target: no new topic upsert.
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_004_200)
    expect(agg.ensureTopic('t-bt-existing', 'assistant-1', 'E').ok).toBe(true)
    agg.appendMessage('t-bt-existing', msgJson('m-e0', 't-bt-existing') as never, [])
    const topicUpsBefore = outboxRows(db).filter(
      (r) => r.op === 'upsert' && r.entityType === 'topic' && r.entityId === 't-bt-existing'
    ).length
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_004_300)
    const res2 = agg.branchMessagesToTopic('t-bt', 't-bt-existing', 'm-t0', 'assistant-1')
    expect(res2.ok).toBe(true)
    expect(
      outboxRows(db).filter((r) => r.op === 'upsert' && r.entityType === 'topic' && r.entityId === 't-bt-existing')
        .length
    ).toBe(topicUpsBefore)
    expect(messageOrder(sqlite, 't-bt-existing')[0]).toBe('m-e0')
    expect(messageOrder(sqlite, 't-bt-existing').length).toBe(2)
  })

  it('malformed extra and high-water exhaustion roll back rows, ensured topic, outbox, membership, frames, high-water and file refs', () => {
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_005_000)
    expect(agg.ensureTopic('t-bbad-src', 'assistant-1', 'S').ok).toBe(true)
    seedSource(agg, 't-bbad-src', ['m-x0', 'm-x1'])
    expect(agg.ensureTopic('t-bbad-dst', 'assistant-1', 'D').ok).toBe(true)
    agg.appendMessage('t-bbad-dst', msgJson('m-d0', 't-bbad-dst') as never, [
      stableBlock('b-d0', 'm-d0', { messageId: 'm-d0' }) as never
    ])
    // Malformed source block extra: the branch prefix read fails closed inside
    // the same transaction, rolling back the whole branch.
    sqlite.prepare(`UPDATE message_blocks SET extra='not-json' WHERE id='b-m-x1'`).run()
    const outboxBefore = outboxRows(db).length
    const frameBefore = frameSnapshot(sqlite)
    const hwBefore = highWaterSnapshot(sqlite)
    const fileRefsBefore = sqlite.prepare(`SELECT COUNT(*) AS n FROM file_references`).get() as { n: number }
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_005_100)
    const resBad = agg.branchMessagesToTopic('t-bbad-src', 't-bbad-dst', 'm-x1', 'assistant-1')
    expect(resBad.ok).toBe(false)
    expect(messageOrder(sqlite, 't-bbad-dst')).toEqual(['m-d0'])
    expect(messageOrder(sqlite, 't-bbad-src')).toEqual(['m-x0', 'm-x1'])
    expect(outboxRows(db).length).toBe(outboxBefore)
    expect(frameSnapshot(sqlite)).toEqual(frameBefore)
    expect(highWaterSnapshot(sqlite)).toEqual(hwBefore)
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM file_references`).get()).toEqual(fileRefsBefore)
    sqlite.prepare(`UPDATE message_blocks SET extra=NULL WHERE id='b-m-x1'`).run()

    // High-water exhaustion on a missing target rolls back the ensured topic too.
    expect(sqlite.prepare(`SELECT id FROM topics WHERE id='t-bhw'`).get()).toBeUndefined()
    sqlite
      .prepare(`INSERT OR REPLACE INTO sync_frame_high_water (kind, parent_id, max_timestamp) VALUES (?,?,?)`)
      .run('topicMessage', 't-bhw', 9007199254740991)
    const outboxHwBefore = outboxRows(db).length
    const frameHwBefore = frameSnapshot(sqlite)
    const hwHwBefore = highWaterSnapshot(sqlite)
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_005_200)
    const resHw = agg.branchMessagesToTopic('t-bbad-src', 't-bhw', 'm-x0', 'assistant-1')
    expect(resHw.ok).toBe(false)
    expect(sqlite.prepare(`SELECT id FROM topics WHERE id='t-bhw'`).get()).toBeUndefined()
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM messages WHERE topic_id='t-bhw'`).get()).toEqual({ n: 0 })
    expect(outboxRows(db).length).toBe(outboxHwBefore)
    expect(frameSnapshot(sqlite)).toEqual(frameHwBefore)
    expect(highWaterSnapshot(sqlite)).toEqual(hwHwBefore)
  })

  it('missing and cross-topic anchors roll back with zero sync residue', () => {
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_006_000)
    expect(agg.ensureTopic('t-banch', 'assistant-1', 'S').ok).toBe(true)
    seedSource(agg, 't-banch', ['m-n0'])
    expect(agg.ensureTopic('t-banch-dst', 'assistant-1', 'D').ok).toBe(true)
    agg.appendMessage('t-banch-dst', msgJson('m-nd0', 't-banch-dst') as never, [])
    const orderBefore = messageOrder(sqlite, 't-banch-dst')
    const outboxBefore = outboxRows(db).length
    const frameBefore = frameSnapshot(sqlite)
    const hwBefore = highWaterSnapshot(sqlite)
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_006_100)
    const resMissing = agg.branchMessagesToTopic('t-banch', 't-banch-dst', 'no-such-anchor', 'assistant-1')
    expect(resMissing.ok).toBe(false)
    expect(messageOrder(sqlite, 't-banch-dst')).toEqual(orderBefore)
    expect(outboxRows(db).length).toBe(outboxBefore)
    expect(frameSnapshot(sqlite)).toEqual(frameBefore)
    expect(highWaterSnapshot(sqlite)).toEqual(hwBefore)

    expect(agg.ensureTopic('t-bother', 'assistant-1', 'O').ok).toBe(true)
    agg.appendMessage('t-bother', msgJson('m-other', 't-bother') as never, [])
    const outboxCrossBefore = outboxRows(db).length
    const frameCrossBefore = frameSnapshot(sqlite)
    const hwCrossBefore = highWaterSnapshot(sqlite)
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_006_200)
    const resCross = agg.branchMessagesToTopic('t-banch', 't-banch-new', 'm-other', 'assistant-1')
    expect(resCross.ok).toBe(false)
    expect(sqlite.prepare(`SELECT id FROM topics WHERE id='t-banch-new'`).get()).toBeUndefined()
    expect(outboxRows(db).length).toBe(outboxCrossBefore)
    expect(frameSnapshot(sqlite)).toEqual(frameCrossBefore)
    expect(highWaterSnapshot(sqlite)).toEqual(hwCrossBefore)
  })

  it('capture-disabled branch preserves local writes with legacy invalidation and zero sync ops/membership', () => {
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_007_000)
    expect(agg.ensureTopic('t-bcap-src', 'assistant-1', 'S').ok).toBe(true)
    seedSource(agg, 't-bcap-src', ['m-c0'])
    expect(agg.ensureTopic('t-bcap-dst', 'assistant-1', 'D').ok).toBe(true)
    agg.appendMessage('t-bcap-dst', msgJson('m-cd0', 't-bcap-dst') as never, [
      stableBlock('b-cd0', 'm-cd0', { messageId: 'm-cd0' }) as never
    ])
    expect(topicFrameOf(sqlite, 't-bcap-dst')).not.toBeNull()
    const outboxBefore = outboxRows(db).length
    configStore.set('sync:enabled', false)
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_007_100)
    const res = agg.branchMessagesToTopic('t-bcap-src', 't-bcap-dst', 'm-c0', 'assistant-1')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(messageOrder(sqlite, 't-bcap-dst')).toEqual(['m-cd0', messageOrder(sqlite, 't-bcap-dst')[1]])
    expect(messageOrder(sqlite, 't-bcap-dst').length).toBe(2)
    expect(outboxRows(db).length).toBe(outboxBefore)
    const clonedId = messageOrder(sqlite, 't-bcap-dst')[1]
    expect(membershipOf(sqlite, 'message', clonedId)).toBeUndefined()
    expect(topicFrameOf(sqlite, 't-bcap-dst')).toBeNull()
    expect(blockFrameOf(sqlite, clonedId)).toBeNull()
    configStore.set('sync:enabled', true)
  })

  it('dual-profile real relay converges the branched target with no baseline and remote file refs local-only', async () => {
    const rdb = new Database(':memory:')
    ensureRelaySchema(rdb)
    const server = createRelayServer(rdb, { token: 'branch-dual' })
    await new Promise<void>((resolve) => {
      ;(server as unknown as { listen: (p: number, h: string, cb: () => void) => void }).listen(0, '127.0.0.1', () =>
        resolve()
      )
    })
    try {
      const base = `http://127.0.0.1:${(server as unknown as { address: () => { port: number } }).address().port}`
      const auth = { Authorization: 'Bearer branch-dual', 'Content-Type': 'application/json' } as Record<string, string>
      const regA = (await (
        await fetch(`${base}/sync/register`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ deviceId: 'device-branch-a' })
        })
      ).json()) as { deviceCode: string; deviceSecret: string }
      const regB = (await (
        await fetch(`${base}/sync/register`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ deviceId: 'device-branch-b' })
        })
      ).json()) as { deviceCode: string; deviceSecret: string }
      const authed = (c: string, s: string): Record<string, string> => ({
        Authorization: 'Bearer branch-dual',
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
      try {
        bindSingleton(openedA.sqlite, openedA.db)
        configStore.set('sync:enabled', true)
        configStore.set('deviceId', 'device-branch-a')
        const aggA = new ChatDbAggregateService(openedA.db, openedA.sqlite)
        vi.spyOn(Date, 'now').mockReturnValue(8_100_000_000_000)
        expect(aggA.ensureTopic('t-bdsrc', 'assistant-1', 'S').ok).toBe(true)
        aggA.appendMessage('t-bdsrc', msgJson('m-du', 't-bdsrc', { role: 'user' }) as never, [
          stableBlock('b-du', 'm-du', { messageId: 'm-du' }) as never
        ])
        aggA.appendMessage('t-bdsrc', msgJson('m-da', 't-bdsrc', { role: 'assistant', askId: 'm-du' }) as never, [
          stableBlock('b-da', 'm-da', { messageId: 'm-da' }) as never
        ])
        aggA.appendMessage('t-bdsrc', msgJson('m-dtail', 't-bdsrc', { role: 'user' }) as never, [
          {
            ...stableBlock('b-dtail', 'm-dtail', { messageId: 'm-dtail' }),
            type: 'file',
            file: { id: 'file-dual', name: 'd.pdf', path: '/tmp/d.pdf', type: 'application/pdf' }
          } as never
        ])
        vi.spyOn(Date, 'now').mockReturnValue(8_100_000_000_100)
        const tailOpsBefore = openedA.db
          .select()
          .from(schema.syncOutbox)
          .all()
          .filter((r) => r.entityId === 'm-dtail' || r.entityId === 'b-dtail').length
        const br = aggA.branchMessagesToTopic('t-bdsrc', 't-bddst', 'm-da', 'assistant-1')
        expect(br.ok).toBe(true)
        const clonedIds = messageOrder(openedA.sqlite, 't-bddst')
        expect(clonedIds.length).toBe(2)
        const clonedUserA = (
          openedA.sqlite.prepare(`SELECT id FROM messages WHERE topic_id='t-bddst' AND role='user'`).get() as {
            id: string
          }
        ).id
        const clonedAsstA = (
          openedA.sqlite.prepare(`SELECT id FROM messages WHERE topic_id='t-bddst' AND role='assistant'`).get() as {
            id: string
          }
        ).id
        expect(
          (
            openedA.sqlite.prepare(`SELECT ask_id AS askId FROM messages WHERE id=?`).get(clonedAsstA) as {
              askId: string
            }
          ).askId
        ).toBe(clonedUserA)
        // The tail file block stayed local-only on A but the branch file refs exist locally.
        expect(openedA.sqlite.prepare(`SELECT id FROM file_references`).all().length).toBeGreaterThan(0)
        const frameA = topicFrameOf(openedA.sqlite, 't-bddst')!
        expect(frameA.orderedChildIds).toEqual(clonedIds)

        bindSingleton(openedA.sqlite, openedA.db)
        const outboxA = openedA.db.select().from(schema.syncOutbox).all()
        expect(outboxA.some((r) => r.op === 'order_frame')).toBe(true)
        // No branch op references the source tail message/block.
        expect(outboxA.filter((r) => r.entityId === 'm-dtail' || r.entityId === 'b-dtail').length).toBe(tailOpsBefore)
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
            body: JSON.stringify({ deviceId: 'device-branch-a', operations: chunk })
          })
          expect(pushRes.status).toBe(200)
        }

        bindSingleton(openedB.sqlite, openedB.db)
        const svcB = new SyncService()
        let cursor = 0
        for (;;) {
          const pullRes = await fetch(`${base}/sync/pull?cursor=${cursor}&deviceId=device-branch-b`, {
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
        const baselineRes = await fetch(`${base}/sync/baseline`, {
          headers: authed(regB.deviceCode, regB.deviceSecret)
        })
        expect(baselineRes.status).toBe(404)
        expect(messageOrder(openedB.sqlite, 't-bddst')).toEqual(clonedIds)
        const askRow = openedB.sqlite.prepare(`SELECT ask_id AS askId FROM messages WHERE id=?`).get(clonedAsstA) as {
          askId: string | null
        }
        expect(askRow.askId).toBe(clonedUserA)
        const frameB = topicFrameOf(openedB.sqlite, 't-bddst')!
        expect(frameB.orderedChildIds).toEqual(clonedIds)
        expect(frameB.timestamp).toBe(frameA.timestamp)
        expect(frameB.operationId).toBe(frameA.operationId)
        const sortsB = openedB.sqlite
          .prepare(`SELECT sort_order AS s FROM messages WHERE topic_id='t-bddst' ORDER BY sort_order`)
          .all() as Array<{ s: number }>
        expect(sortsB.map((r) => r.s)).toEqual([0, 1])
        // Remote holds no file references: attachments stay local-only.
        expect(openedB.sqlite.prepare(`SELECT id FROM file_references`).all()).toEqual([])
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
      await new Promise<void>((resolve) => {
        try {
          ;(server as unknown as { close: (cb: () => void) => void }).close(() => resolve())
        } catch {
          resolve()
        }
      })
      try {
        rdb.close()
      } catch {}
    }
  })
})
