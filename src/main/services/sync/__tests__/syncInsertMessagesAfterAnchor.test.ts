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

import { ERR_CONFLICT } from '@shared/chatDb'

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

function blockOrder(sqlite: Database.Database, messageId: string): string[] {
  return (
    sqlite
      .prepare(`SELECT id FROM message_blocks WHERE message_id=? ORDER BY sort_order ASC, id ASC`)
      .all(messageId) as Array<{ id: string }>
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

function membershipCount(sqlite: Database.Database, childType: string, childId: string): number {
  return (
    sqlite
      .prepare(`SELECT COUNT(*) AS n FROM sync_membership_clock WHERE child_entity_type=? AND child_entity_id=?`)
      .get(childType, childId) as { n: number }
  ).n
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

describe('insertMessagesAfterAnchor incremental sync', () => {
  it('complete stable batch insert mints entity ops + memberships + one topic frame + one per block parent with id/time mirror', () => {
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_000_000)
    expect(agg.ensureTopic('t-ins', 'assistant-1', 'T').ok).toBe(true)
    agg.appendMessage('t-ins', msgJson('m-anchor', 't-ins') as never, [])
    const topicFramesBefore = outboxRows(db).filter(
      (r) => r.op === 'order_frame' && r.entityType === 'topic' && r.entityId === 't-ins'
    ).length
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_000_100)
    const res = agg.insertMessagesAfterAnchor('t-ins', 'm-anchor', [
      { message: msgJson('m-1', 't-ins', { role: 'user' }) as never, blocks: [stableBlock('b-1', 'm-1') as never] },
      {
        message: msgJson('m-2', 't-ins', { role: 'assistant', askId: 'm-1' }) as never,
        blocks: [stableBlock('b-2', 'm-2') as never]
      }
    ])
    expect(res.ok).toBe(true)
    expect(messageOrder(sqlite, 't-ins')).toEqual(['m-anchor', 'm-1', 'm-2'])
    // Entity ops: full-state true creates, no sortOrder field.
    const ops = outboxRows(db)
    const m1Up = ops.filter((r) => r.op === 'upsert' && r.entityType === 'message' && r.entityId === 'm-1')
    expect(m1Up.length).toBe(1)
    const m1Payload = JSON.parse(m1Up[0].payloadJson as string) as Record<string, unknown>
    expect(m1Payload).toMatchObject({ id: 'm-1', topicId: 't-ins' })
    expect(m1Payload).not.toHaveProperty('sortOrder')
    const m2Up = ops.filter((r) => r.op === 'upsert' && r.entityType === 'message' && r.entityId === 'm-2')
    expect(m2Up.length).toBe(1)
    expect((JSON.parse(m2Up[0].payloadJson as string) as Record<string, unknown>).askId).toBe('m-1')
    const b1Up = ops.filter((r) => r.op === 'upsert' && r.entityType === 'message_block' && r.entityId === 'b-1')
    expect(b1Up.length).toBe(1)
    expect(JSON.parse(b1Up[0].payloadJson as string)).not.toHaveProperty('sortOrder')
    // Memberships only for true creates with exact parent.
    expect(membershipOf(sqlite, 'message', 'm-1')?.parentId).toBe('t-ins')
    expect(membershipOf(sqlite, 'message', 'm-2')?.parentId).toBe('t-ins')
    expect(membershipOf(sqlite, 'message_block', 'b-1')?.parentId).toBe('m-1')
    expect(membershipOf(sqlite, 'message_block', 'b-2')?.parentId).toBe('m-2')
    // Exactly one new topic frame + one per relevant block parent.
    const topicFrames = ops.filter((r) => r.op === 'order_frame' && r.entityType === 'topic' && r.entityId === 't-ins')
    expect(topicFrames.length).toBe(topicFramesBefore + 1)
    const storedTopic = topicFrameOf(sqlite, 't-ins')!
    expect(storedTopic.orderedChildIds).toEqual(['m-anchor', 'm-1', 'm-2'])
    const lastTopic = topicFrames[topicFrames.length - 1]
    expect(lastTopic.id).toBe(storedTopic.operationId)
    expect(lastTopic.timestamp).toBe(storedTopic.timestamp)
    const bf1 = ops.filter((r) => r.op === 'order_frame' && r.entityType === 'message' && r.entityId === 'm-1')
    const bf2 = ops.filter((r) => r.op === 'order_frame' && r.entityType === 'message' && r.entityId === 'm-2')
    expect(bf1.length).toBe(1)
    expect(bf2.length).toBe(1)
    expect(blockFrameOf(sqlite, 'm-1')!.orderedChildIds).toEqual(['b-1'])
    expect(blockFrameOf(sqlite, 'm-2')!.orderedChildIds).toEqual(['b-2'])
    expect(bf1[0].id).toBe(blockFrameOf(sqlite, 'm-1')!.operationId)
    expect(bf1[0].timestamp).toBe(blockFrameOf(sqlite, 'm-1')!.timestamp)
    // Dense order materialized locally.
    const sorts = sqlite
      .prepare(`SELECT sort_order AS s FROM messages WHERE topic_id='t-ins' ORDER BY sort_order`)
      .all() as Array<{ s: number }>
    expect(sorts.map((r) => r.s)).toEqual([0, 1, 2])
  })

  it('mixed transient/unsupported emits 0 ops for excluded parts with try-invalidate partial while stable parts converge', () => {
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_001_000)
    expect(agg.ensureTopic('t-mix', 'assistant-1', 'T').ok).toBe(true)
    agg.appendMessage('t-mix', msgJson('m-a0', 't-mix') as never, [stableBlock('b-a0', 'm-a0') as never])
    const outboxBefore = outboxRows(db).length
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_001_100)
    const res = agg.insertMessagesAfterAnchor('t-mix', 'm-a0', [
      { message: msgJson('m-ok', 't-mix', { role: 'user' }) as never, blocks: [stableBlock('b-ok', 'm-ok') as never] },
      {
        message: msgJson('m-tr', 't-mix', { role: 'assistant', status: 'streaming', askId: 'm-ok' }) as never,
        blocks: [stableBlock('b-tr', 'm-tr') as never]
      },
      {
        message: msgJson('m-uns', 't-mix', { role: 'user' }) as never,
        blocks: [{ ...stableBlock('b-uns', 'm-uns'), type: 'file' } as never]
      }
    ])
    expect(res.ok).toBe(true)
    const ops = outboxRows(db)
    // Stable parts emit; excluded parts emit nothing.
    expect(ops.filter((r) => r.entityId === 'm-ok' && r.op === 'upsert').length).toBe(1)
    expect(ops.filter((r) => r.entityId === 'b-ok' && r.op === 'upsert').length).toBe(1)
    expect(ops.filter((r) => r.entityId === 'm-tr').length).toBe(0)
    expect(ops.filter((r) => r.entityId === 'b-tr').length).toBe(0)
    expect(ops.filter((r) => r.entityId === 'b-uns').length).toBe(0)
    expect(membershipOf(sqlite, 'message', 'm-tr')).toBeUndefined()
    expect(membershipOf(sqlite, 'message_block', 'b-uns')).toBeUndefined()
    // Local rows still persisted (user mutation successful).
    expect(messageOrder(sqlite, 't-mix')).toContain('m-tr')
    expect(messageOrder(sqlite, 't-mix')).toContain('m-uns')
    // Excluded parents invalidate with 0 frame op: unsupported parent + transient parent have no frame.
    expect(blockFrameOf(sqlite, 'm-uns')).toBeNull()
    expect(blockFrameOf(sqlite, 'm-tr')).toBeNull()
    // Stable parent still refreshes exactly once.
    expect(ops.filter((r) => r.op === 'order_frame' && r.entityId === 'm-ok').length).toBe(1)
    expect(blockFrameOf(sqlite, 'm-ok')!.orderedChildIds).toEqual(['b-ok'])
    expect(outboxRows(db).length).toBeGreaterThan(outboxBefore)
  })

  it('existing-row patch preserves membership/position with patch-only op and no unnecessary frame advance', () => {
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_002_000)
    expect(agg.ensureTopic('t-patch', 'assistant-1', 'T').ok).toBe(true)
    agg.appendMessage('t-patch', msgJson('m-p0', 't-patch', { content: 'orig0' }) as never, [])
    agg.appendMessage('t-patch', msgJson('m-p1', 't-patch', { content: 'orig1' }) as never, [])
    const memBefore = membershipOf(sqlite, 'message', 'm-p1')!
    expect(memBefore.parentId).toBe('t-patch')
    const topicFrameBefore = topicFrameOf(sqlite, 't-patch')!
    const topicOpsBefore = outboxRows(db).filter(
      (r) => r.op === 'order_frame' && r.entityType === 'topic' && r.entityId === 't-patch'
    ).length
    const blockOpsBefore = outboxRows(db).filter((r) => r.op === 'order_frame' && r.entityType === 'message').length
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_002_100)
    const res = agg.insertMessagesAfterAnchor('t-patch', 'm-p0', [
      { message: msgJson('m-p1', 't-patch', { content: 'edited1' }) as never, blocks: [] }
    ])
    expect(res.ok).toBe(true)
    // Position preserved (existing IDs never move).
    expect(messageOrder(sqlite, 't-patch')).toEqual(['m-p0', 'm-p1'])
    const row = sqlite.prepare(`SELECT content FROM messages WHERE id='m-p1'`).get() as { content: string }
    expect(row.content).toBe('edited1')
    // Membership tuple preserved exactly.
    expect(membershipOf(sqlite, 'message', 'm-p1')).toEqual(memBefore)
    // Patch-only op: changed content only, never role/status/sortOrder.
    const ups = outboxRows(db).filter((r) => r.op === 'upsert' && r.entityType === 'message' && r.entityId === 'm-p1')
    expect(ups.length).toBe(2) // creation full + this patch
    const patch = JSON.parse(ups[ups.length - 1].payloadJson as string) as Record<string, unknown>
    expect(patch).toMatchObject({ id: 'm-p1', topicId: 't-patch', content: 'edited1' })
    expect(patch).not.toHaveProperty('role')
    expect(patch).not.toHaveProperty('status')
    expect(patch).not.toHaveProperty('sortOrder')
    // No frame advance for pure stable→stable patch.
    expect(topicFrameOf(sqlite, 't-patch')).toEqual(topicFrameBefore)
    expect(
      outboxRows(db).filter((r) => r.op === 'order_frame' && r.entityType === 'topic' && r.entityId === 't-patch')
        .length
    ).toBe(topicOpsBefore)
    expect(outboxRows(db).filter((r) => r.op === 'order_frame' && r.entityType === 'message').length).toBe(
      blockOpsBefore
    )
  })

  it('malformed extra and high-water exhaustion roll back all rows/file refs/outbox/membership/frames/high-water', () => {
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_003_000)
    expect(agg.ensureTopic('t-bad', 'assistant-1', 'T').ok).toBe(true)
    agg.appendMessage('t-bad', msgJson('m-b0', 't-bad') as never, [stableBlock('b-b0', 'm-b0') as never])
    // Malformed path: corrupt sibling block extra under an affected parent.
    agg.appendMessage('t-bad', msgJson('m-b1', 't-bad') as never, [stableBlock('b-b1', 'm-b1') as never])
    sqlite.prepare(`UPDATE message_blocks SET extra='not-json' WHERE id='b-b1'`).run()
    const outboxBefore = outboxRows(db).length
    const frameBefore = topicFrameOf(sqlite, 't-bad')
    const hwBefore = sqlite
      .prepare(`SELECT max_timestamp AS ts FROM sync_frame_high_water WHERE kind='topicMessage' AND parent_id='t-bad'`)
      .get() as { ts: number } | undefined
    const resBad = agg.insertMessagesAfterAnchor('t-bad', 'm-b0', [
      {
        message: msgJson('m-b1', 't-bad', { content: 'edit' }) as never,
        blocks: [stableBlock('b-b2', 'm-b1') as never]
      }
    ])
    expect(resBad.ok).toBe(false)
    expect(sqlite.prepare(`SELECT id FROM message_blocks WHERE id='b-b2'`).get()).toBeUndefined()
    expect(outboxRows(db).length).toBe(outboxBefore)
    expect(topicFrameOf(sqlite, 't-bad')).toEqual(frameBefore)
    expect(membershipOf(sqlite, 'message_block', 'b-b2')).toBeUndefined()
    const hwAfter = sqlite
      .prepare(`SELECT max_timestamp AS ts FROM sync_frame_high_water WHERE kind='topicMessage' AND parent_id='t-bad'`)
      .get() as { ts: number } | undefined
    expect(hwAfter).toEqual(hwBefore)
    // High-water exhaustion path on a clean topic.
    sqlite.prepare(`UPDATE message_blocks SET extra=NULL WHERE id='b-b1'`).run()
    expect(agg.ensureTopic('t-max', 'assistant-1', 'M').ok).toBe(true)
    agg.appendMessage('t-max', msgJson('m-max0', 't-max') as never, [])
    const outboxMaxBefore = outboxRows(db).length
    sqlite
      .prepare(`INSERT OR REPLACE INTO sync_frame_high_water (kind, parent_id, max_timestamp) VALUES (?,?,?)`)
      .run('topicMessage', 't-max', 9007199254740991)
    const resMax = agg.insertMessagesAfterAnchor('t-max', 'm-max0', [
      { message: msgJson('m-max1', 't-max') as never, blocks: [] }
    ])
    expect(resMax.ok).toBe(false)
    expect(sqlite.prepare(`SELECT id FROM messages WHERE id='m-max1'`).get()).toBeUndefined()
    expect(outboxRows(db).length).toBe(outboxMaxBefore)
    expect(membershipOf(sqlite, 'message', 'm-max1')).toBeUndefined()
  })

  it('dual-profile real relay push/pull converges rows, askId, dense order and winning frames with file refs local-only and no baseline', async () => {
    const rdb = new Database(':memory:')
    ensureRelaySchema(rdb)
    const server = createRelayServer(rdb, { token: 'ins-dual' })
    await new Promise<void>((resolve) => {
      ;(server as unknown as { listen: (p: number, h: string, cb: () => void) => void }).listen(0, '127.0.0.1', () =>
        resolve()
      )
    })
    try {
      const base = `http://127.0.0.1:${(server as unknown as { address: () => { port: number } }).address().port}`
      const auth = { Authorization: 'Bearer ins-dual', 'Content-Type': 'application/json' } as Record<string, string>
      const regA = (await (
        await fetch(`${base}/sync/register`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ deviceId: 'device-ins-a' })
        })
      ).json()) as { deviceCode: string; deviceSecret: string }
      const regB = (await (
        await fetch(`${base}/sync/register`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ deviceId: 'device-ins-b' })
        })
      ).json()) as { deviceCode: string; deviceSecret: string }
      const authed = (c: string, s: string): Record<string, string> => ({
        Authorization: 'Bearer ins-dual',
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
        configStore.set('deviceId', 'device-ins-a')
        const aggA = new ChatDbAggregateService(openedA.db, openedA.sqlite)
        vi.spyOn(Date, 'now').mockReturnValue(8_100_000_000_000)
        expect(aggA.ensureTopic('t-dual', 'assistant-1', 'Dual').ok).toBe(true)
        aggA.appendMessage('t-dual', msgJson('m-d0', 't-dual', { role: 'user' }) as never, [])
        vi.spyOn(Date, 'now').mockReturnValue(8_100_000_000_100)
        const ins = aggA.insertMessagesAfterAnchor('t-dual', 'm-d0', [
          {
            message: msgJson('m-d1', 't-dual', { role: 'user' }) as never,
            blocks: [stableBlock('b-d1', 'm-d1') as never]
          },
          {
            message: msgJson('m-d2', 't-dual', { role: 'assistant', askId: 'm-d1' }) as never,
            blocks: [stableBlock('b-d2', 'm-d2') as never]
          }
        ])
        expect(ins.ok).toBe(true)
        // Local-only file reference that must never ride the wire.
        vi.spyOn(Date, 'now').mockReturnValue(8_100_000_000_200)
        aggA.bulkAddBlocks([
          {
            id: 'b-file-local',
            messageId: 'm-d1',
            type: 'file',
            content: null,
            status: 'success',
            createdAt: '2026-01-01T00:00:00.000Z',
            file: { id: 'file-local', name: 'a.pdf', path: '/tmp/a.pdf', type: 'application/pdf' }
          } as never
        ])
        expect(
          openedA.sqlite.prepare(`SELECT id FROM file_references WHERE block_id='b-file-local'`).get()
        ).toBeTruthy()
        const expectedOrder = ['m-d0', 'm-d1', 'm-d2']
        expect(messageOrder(openedA.sqlite, 't-dual')).toEqual(expectedOrder)
        const frameA = topicFrameOf(openedA.sqlite, 't-dual')!
        expect(frameA.orderedChildIds).toEqual(expectedOrder)

        bindSingleton(openedA.sqlite, openedA.db)
        const outboxA = openedA.db.select().from(schema.syncOutbox).all()
        expect(outboxA.some((r) => r.op === 'order_frame')).toBe(true)
        expect(outboxA.some((r) => `${r.entityType}:${r.op}`.includes('segment'))).toBe(false)
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
            body: JSON.stringify({ deviceId: 'device-ins-a', operations: chunk })
          })
          expect(pushRes.status).toBe(200)
        }

        bindSingleton(openedB.sqlite, openedB.db)
        const svcB = new SyncService()
        let cursor = 0
        for (;;) {
          const pullRes = await fetch(`${base}/sync/pull?cursor=${cursor}&deviceId=device-ins-b`, {
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
        expect(messageOrder(openedB.sqlite, 't-dual')).toEqual(expectedOrder)
        const askRow = openedB.sqlite.prepare(`SELECT ask_id AS askId FROM messages WHERE id='m-d2'`).get() as {
          askId: string | null
        }
        expect(askRow.askId).toBe('m-d1')
        const frameB = topicFrameOf(openedB.sqlite, 't-dual')!
        expect(frameB.orderedChildIds).toEqual(expectedOrder)
        expect(frameB.timestamp).toBe(frameA.timestamp)
        expect(frameB.operationId).toBe(frameA.operationId)
        expect(blockFrameOf(openedB.sqlite, 'm-d1')!.orderedChildIds).toEqual(['b-d1'])
        expect(blockFrameOf(openedB.sqlite, 'm-d2')!.orderedChildIds).toEqual(['b-d2'])
        // Dense order on B, file refs absent remotely.
        const sortsB = openedB.sqlite
          .prepare(`SELECT sort_order AS s FROM messages WHERE topic_id='t-dual' ORDER BY sort_order`)
          .all() as Array<{ s: number }>
        expect(sortsB.map((r) => r.s)).toEqual([0, 1, 2])
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

describe('insertMessagesAfterAnchor audit edge cases', () => {
  it('duplicate message ID in one batch resolves to final content with a single full upsert, single membership and unique frames', () => {
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_010_000)
    expect(agg.ensureTopic('t-dup', 'assistant-1', 'T').ok).toBe(true)
    agg.appendMessage('t-dup', msgJson('m-anchor', 't-dup') as never, [])
    const topicOpsBefore = outboxRows(db).filter(
      (r) => r.op === 'order_frame' && r.entityType === 'topic' && r.entityId === 't-dup'
    ).length
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_010_100)
    const res = agg.insertMessagesAfterAnchor('t-dup', 'm-anchor', [
      {
        message: msgJson('m-dup', 't-dup', { content: 'first' }) as never,
        blocks: [stableBlock('b-dup-1', 'm-dup') as never]
      },
      {
        message: msgJson('m-dup', 't-dup', { content: 'final' }) as never,
        blocks: [stableBlock('b-dup-2', 'm-dup') as never]
      }
    ])
    expect(res.ok).toBe(true)
    // Final entry wins for chat state; position is the single anchor-tail slot.
    expect(messageOrder(sqlite, 't-dup')).toEqual(['m-anchor', 'm-dup'])
    const row = sqlite.prepare(`SELECT content FROM messages WHERE id='m-dup'`).get() as { content: string }
    expect(row.content).toBe('final')
    expect(blockOrder(sqlite, 'm-dup')).toEqual(['b-dup-1', 'b-dup-2'])
    // Exactly one full message upsert for the true create (not divergent duplicates).
    const mUps = outboxRows(db).filter((r) => r.op === 'upsert' && r.entityType === 'message' && r.entityId === 'm-dup')
    expect(mUps.length).toBe(1)
    const mPayload = JSON.parse(mUps[0].payloadJson as string) as Record<string, unknown>
    expect(mPayload).toMatchObject({ id: 'm-dup', topicId: 't-dup', content: 'final', role: 'user' })
    expect(mPayload).not.toHaveProperty('sortOrder')
    // Exactly one membership tuple for the created message and for each created block.
    expect(membershipCount(sqlite, 'message', 'm-dup')).toBe(1)
    expect(membershipOf(sqlite, 'message', 'm-dup')?.parentId).toBe('t-dup')
    expect(membershipCount(sqlite, 'message_block', 'b-dup-1')).toBe(1)
    expect(membershipCount(sqlite, 'message_block', 'b-dup-2')).toBe(1)
    // Exactly one new topic frame op and one block frame op for the new parent.
    const topicOps = outboxRows(db).filter(
      (r) => r.op === 'order_frame' && r.entityType === 'topic' && r.entityId === 't-dup'
    )
    expect(topicOps.length).toBe(topicOpsBefore + 1)
    expect(topicFrameOf(sqlite, 't-dup')!.orderedChildIds).toEqual(['m-anchor', 'm-dup'])
    const blkOps = outboxRows(db).filter(
      (r) => r.op === 'order_frame' && r.entityType === 'message' && r.entityId === 'm-dup'
    )
    expect(blkOps.length).toBe(1)
    expect(blockFrameOf(sqlite, 'm-dup')!.orderedChildIds).toEqual(['b-dup-1', 'b-dup-2'])
    expect(blkOps[0].id).toBe(blockFrameOf(sqlite, 'm-dup')!.operationId)
  })

  it('message ID owned by another topic fails with conflict semantics and leaves all sync state unchanged', () => {
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_011_000)
    expect(agg.ensureTopic('t-a', 'assistant-1', 'A').ok).toBe(true)
    agg.appendMessage('t-a', msgJson('m-a0', 't-a') as never, [])
    expect(agg.ensureTopic('t-b', 'assistant-1', 'B').ok).toBe(true)
    agg.appendMessage('t-b', msgJson('m-fb', 't-b', { content: 'foreign' }) as never, [])
    const orderABefore = messageOrder(sqlite, 't-a')
    const orderBBefore = messageOrder(sqlite, 't-b')
    const outboxBefore = outboxRows(db).length
    const frameBefore = frameSnapshot(sqlite)
    const hwBefore = highWaterSnapshot(sqlite)
    const memBefore = membershipOf(sqlite, 'message', 'm-fb')
    expect(memBefore?.parentId).toBe('t-b')
    const fileRefsBefore = sqlite.prepare(`SELECT COUNT(*) AS n FROM file_references`).get() as { n: number }
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_011_100)
    const res = agg.insertMessagesAfterAnchor('t-a', 'm-a0', [
      { message: msgJson('m-fb', 't-a', { content: 'hijack' }) as never, blocks: [] }
    ])
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe(ERR_CONFLICT)
    }
    // Full rollback: rows, file refs, outbox, memberships, frames, high-water.
    expect(messageOrder(sqlite, 't-a')).toEqual(orderABefore)
    expect(messageOrder(sqlite, 't-b')).toEqual(orderBBefore)
    const kept = sqlite.prepare(`SELECT content, topic_id AS topicId FROM messages WHERE id='m-fb'`).get() as {
      content: string
      topicId: string
    }
    expect(kept).toMatchObject({ content: 'foreign', topicId: 't-b' })
    expect(outboxRows(db).length).toBe(outboxBefore)
    expect(frameSnapshot(sqlite)).toEqual(frameBefore)
    expect(highWaterSnapshot(sqlite)).toEqual(hwBefore)
    expect(membershipOf(sqlite, 'message', 'm-fb')).toEqual(memBefore)
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM file_references`).get()).toEqual(fileRefsBefore)
  })

  it('transient untracked message promoted to stable emits a patch with no membership and invalidates the topic frame with zero frame op', () => {
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_012_000)
    expect(agg.ensureTopic('t-pro', 'assistant-1', 'T').ok).toBe(true)
    agg.appendMessage('t-pro', msgJson('m-p0', 't-pro') as never, [])
    // Transient assistant stub: legitimate skip — no op, no membership.
    agg.appendMessage(
      't-pro',
      msgJson('m-pro', 't-pro', { role: 'assistant', status: 'streaming', askId: 'm-p0' }) as never,
      []
    )
    expect(outboxRows(db).filter((r) => r.entityId === 'm-pro').length).toBe(0)
    expect(membershipOf(sqlite, 'message', 'm-pro')).toBeUndefined()
    const topicFrameBefore = topicFrameOf(sqlite, 't-pro')
    expect(topicFrameBefore).not.toBeNull()
    const topicOpsBefore = outboxRows(db).filter(
      (r) => r.op === 'order_frame' && r.entityType === 'topic' && r.entityId === 't-pro'
    ).length
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_012_100)
    const res = agg.insertMessagesAfterAnchor('t-pro', 'm-p0', [
      {
        message: msgJson('m-pro', 't-pro', { role: 'assistant', status: 'success', askId: 'm-p0' }) as never,
        blocks: []
      }
    ])
    expect(res.ok).toBe(true)
    // Existing ID preserves position; status promoted.
    expect(messageOrder(sqlite, 't-pro')).toEqual(['m-p0', 'm-pro'])
    const row = sqlite.prepare(`SELECT status FROM messages WHERE id='m-pro'`).get() as { status: string }
    expect(row.status).toBe('success')
    // Patch-only entity op for the promotion (changed status only, never role/content).
    const ups = outboxRows(db).filter((r) => r.op === 'upsert' && r.entityType === 'message' && r.entityId === 'm-pro')
    expect(ups.length).toBe(1)
    const patch = JSON.parse(ups[0].payloadJson as string) as Record<string, unknown>
    expect(patch).toMatchObject({ id: 'm-pro', topicId: 't-pro', status: 'success' })
    expect(patch).not.toHaveProperty('role')
    expect(patch).not.toHaveProperty('content')
    expect(patch).not.toHaveProperty('sortOrder')
    // No guessed/backfilled membership for the promoted pre-existing row.
    expect(membershipOf(sqlite, 'message', 'm-pro')).toBeUndefined()
    // Topic frame try-refresh sees the unversioned member: invalidate with zero frame op.
    expect(topicFrameOf(sqlite, 't-pro')).toBeNull()
    expect(
      outboxRows(db).filter((r) => r.op === 'order_frame' && r.entityType === 'topic' && r.entityId === 't-pro').length
    ).toBe(topicOpsBefore)
    // Local candidate stays truthful partial with unversioned membership.
    const cand = captureLocalSyncBaselineCandidate(db as never) as {
      completeness: { state: string; reasons: string[] }
      manifest: { unversionedMembershipCount: number }
    }
    expect(cand.completeness.state).not.toBe('complete')
    expect(cand.completeness.reasons).toContain('unversioned-membership')
    expect(cand.manifest.unversionedMembershipCount).toBeGreaterThan(0)
  })

  it('block ID supplied under a different message parent fails closed with full rollback', () => {
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_013_000)
    expect(agg.ensureTopic('t-r', 'assistant-1', 'T').ok).toBe(true)
    agg.appendMessage('t-r', msgJson('m-r0', 't-r') as never, [stableBlock('b-r0', 'm-r0') as never])
    agg.appendMessage('t-r', msgJson('m-r1', 't-r') as never, [])
    const orderBefore = messageOrder(sqlite, 't-r')
    const outboxBefore = outboxRows(db).length
    const frameBefore = frameSnapshot(sqlite)
    const hwBefore = highWaterSnapshot(sqlite)
    const blockParentBefore = sqlite
      .prepare(`SELECT message_id AS messageId FROM message_blocks WHERE id='b-r0'`)
      .get() as {
      messageId: string
    }
    expect(blockParentBefore.messageId).toBe('m-r0')
    const memBlockBefore = membershipOf(sqlite, 'message_block', 'b-r0')
    expect(memBlockBefore?.parentId).toBe('m-r0')
    const fileRefsBefore = sqlite.prepare(`SELECT COUNT(*) AS n FROM file_references`).get() as { n: number }
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_013_100)
    // b-r0 belongs to m-r0 but is supplied under the new message m-rnew:
    // BlocksRepository.upsertMany rejects the messageId change, so the whole
    // transaction must roll back with no partial writes.
    const res = agg.insertMessagesAfterAnchor('t-r', 'm-r1', [
      {
        message: msgJson('m-rnew', 't-r', { content: 'new' }) as never,
        blocks: [{ ...stableBlock('b-r0', 'm-rnew'), content: 'moved' } as never]
      }
    ])
    expect(res.ok).toBe(false)
    // Full rollback across rows/file refs/outbox/membership/frames/high-water.
    expect(messageOrder(sqlite, 't-r')).toEqual(orderBefore)
    expect(sqlite.prepare(`SELECT id FROM messages WHERE id='m-rnew'`).get()).toBeUndefined()
    expect(sqlite.prepare(`SELECT message_id AS messageId FROM message_blocks WHERE id='b-r0'`).get()).toEqual(
      blockParentBefore
    )
    const contentBack = sqlite.prepare(`SELECT content FROM message_blocks WHERE id='b-r0'`).get() as {
      content: string | null
    }
    expect(contentBack.content).toBe('content-b-r0')
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM file_references`).get()).toEqual(fileRefsBefore)
    expect(outboxRows(db).length).toBe(outboxBefore)
    expect(membershipOf(sqlite, 'message', 'm-rnew')).toBeUndefined()
    expect(membershipOf(sqlite, 'message_block', 'b-r0')).toEqual(memBlockBefore)
    expect(frameSnapshot(sqlite)).toEqual(frameBefore)
    expect(highWaterSnapshot(sqlite)).toEqual(hwBefore)
  })
})
