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

describe('pasteMessagesToTopic incremental sync', () => {
  it('complete stable paste mints entity ops + memberships + one topic frame + one per block parent with id/time mirror', () => {
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_000_000)
    expect(agg.ensureTopic('t-paste', 'assistant-1', 'T').ok).toBe(true)
    agg.appendMessage('t-paste', msgJson('m-anchor', 't-paste') as never, [])
    const topicFramesBefore = outboxRows(db).filter(
      (r) => r.op === 'order_frame' && r.entityType === 'topic' && r.entityId === 't-paste'
    ).length
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_000_100)
    const res = agg.pasteMessagesToTopic('t-paste', [
      { message: msgJson('m-1', 't-paste', { role: 'user' }) as never, blocks: [stableBlock('b-1', 'm-1') as never] },
      {
        message: msgJson('m-2', 't-paste', { role: 'assistant', askId: 'm-1' }) as never,
        blocks: [stableBlock('b-2', 'm-2') as never]
      }
    ])
    expect(res.ok).toBe(true)
    expect(messageOrder(sqlite, 't-paste')).toEqual(['m-anchor', 'm-1', 'm-2'])
    const ops = outboxRows(db)
    const m1Up = ops.filter((r) => r.op === 'upsert' && r.entityType === 'message' && r.entityId === 'm-1')
    expect(m1Up.length).toBe(1)
    const m1Payload = JSON.parse(m1Up[0].payloadJson as string) as Record<string, unknown>
    expect(m1Payload).toMatchObject({ id: 'm-1', topicId: 't-paste' })
    expect(m1Payload).not.toHaveProperty('sortOrder')
    const m2Up = ops.filter((r) => r.op === 'upsert' && r.entityType === 'message' && r.entityId === 'm-2')
    expect(m2Up.length).toBe(1)
    expect((JSON.parse(m2Up[0].payloadJson as string) as Record<string, unknown>).askId).toBe('m-1')
    const b1Up = ops.filter((r) => r.op === 'upsert' && r.entityType === 'message_block' && r.entityId === 'b-1')
    expect(b1Up.length).toBe(1)
    expect(JSON.parse(b1Up[0].payloadJson as string)).not.toHaveProperty('sortOrder')
    expect(membershipOf(sqlite, 'message', 'm-1')?.parentId).toBe('t-paste')
    expect(membershipOf(sqlite, 'message', 'm-2')?.parentId).toBe('t-paste')
    expect(membershipOf(sqlite, 'message_block', 'b-1')?.parentId).toBe('m-1')
    expect(membershipOf(sqlite, 'message_block', 'b-2')?.parentId).toBe('m-2')
    const topicFrames = ops.filter(
      (r) => r.op === 'order_frame' && r.entityType === 'topic' && r.entityId === 't-paste'
    )
    expect(topicFrames.length).toBe(topicFramesBefore + 1)
    const storedTopic = topicFrameOf(sqlite, 't-paste')!
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
    const sorts = sqlite
      .prepare(`SELECT sort_order AS s FROM messages WHERE topic_id='t-paste' ORDER BY sort_order`)
      .all() as Array<{ s: number }>
    expect(sorts.map((r) => r.s)).toEqual([0, 1, 2])
  })

  it('mixed transient/unsupported emits 0 ops for excluded parts with try-invalidate partial while stable parts converge', () => {
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_001_000)
    expect(agg.ensureTopic('t-pmix', 'assistant-1', 'T').ok).toBe(true)
    agg.appendMessage('t-pmix', msgJson('m-a0', 't-pmix') as never, [stableBlock('b-a0', 'm-a0') as never])
    const outboxBefore = outboxRows(db).length
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_001_100)
    const res = agg.pasteMessagesToTopic('t-pmix', [
      { message: msgJson('m-ok', 't-pmix', { role: 'user' }) as never, blocks: [stableBlock('b-ok', 'm-ok') as never] },
      {
        message: msgJson('m-tr', 't-pmix', { role: 'assistant', status: 'streaming', askId: 'm-ok' }) as never,
        blocks: [stableBlock('b-tr', 'm-tr') as never]
      },
      {
        message: msgJson('m-uns', 't-pmix', { role: 'user' }) as never,
        blocks: [{ ...stableBlock('b-uns', 'm-uns'), type: 'file' } as never]
      }
    ])
    expect(res.ok).toBe(true)
    const ops = outboxRows(db)
    expect(ops.filter((r) => r.entityId === 'm-ok' && r.op === 'upsert').length).toBe(1)
    expect(ops.filter((r) => r.entityId === 'b-ok' && r.op === 'upsert').length).toBe(1)
    expect(ops.filter((r) => r.entityId === 'm-tr').length).toBe(0)
    expect(ops.filter((r) => r.entityId === 'b-tr').length).toBe(0)
    expect(ops.filter((r) => r.entityId === 'b-uns').length).toBe(0)
    expect(membershipOf(sqlite, 'message', 'm-tr')).toBeUndefined()
    expect(membershipOf(sqlite, 'message_block', 'b-uns')).toBeUndefined()
    expect(messageOrder(sqlite, 't-pmix')).toContain('m-tr')
    expect(messageOrder(sqlite, 't-pmix')).toContain('m-uns')
    expect(blockFrameOf(sqlite, 'm-uns')).toBeNull()
    expect(blockFrameOf(sqlite, 'm-tr')).toBeNull()
    expect(ops.filter((r) => r.op === 'order_frame' && r.entityId === 'm-ok').length).toBe(1)
    expect(blockFrameOf(sqlite, 'm-ok')!.orderedChildIds).toEqual(['b-ok'])
    expect(outboxRows(db).length).toBeGreaterThan(outboxBefore)
  })

  it('existing-row patch preserves membership/position with patch-only op and no unnecessary frame advance', () => {
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_002_000)
    expect(agg.ensureTopic('t-ppatch', 'assistant-1', 'T').ok).toBe(true)
    agg.appendMessage('t-ppatch', msgJson('m-p0', 't-ppatch', { content: 'orig0' }) as never, [])
    agg.appendMessage('t-ppatch', msgJson('m-p1', 't-ppatch', { content: 'orig1' }) as never, [])
    const memBefore = membershipOf(sqlite, 'message', 'm-p1')!
    expect(memBefore.parentId).toBe('t-ppatch')
    const topicFrameBefore = topicFrameOf(sqlite, 't-ppatch')!
    const topicOpsBefore = outboxRows(db).filter(
      (r) => r.op === 'order_frame' && r.entityType === 'topic' && r.entityId === 't-ppatch'
    ).length
    const blockOpsBefore = outboxRows(db).filter((r) => r.op === 'order_frame' && r.entityType === 'message').length
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_002_100)
    const res = agg.pasteMessagesToTopic('t-ppatch', [
      { message: msgJson('m-p1', 't-ppatch', { content: 'edited1' }) as never, blocks: [] }
    ])
    expect(res.ok).toBe(true)
    expect(messageOrder(sqlite, 't-ppatch')).toEqual(['m-p0', 'm-p1'])
    const row = sqlite.prepare(`SELECT content FROM messages WHERE id='m-p1'`).get() as { content: string }
    expect(row.content).toBe('edited1')
    expect(membershipOf(sqlite, 'message', 'm-p1')).toEqual(memBefore)
    const ups = outboxRows(db).filter((r) => r.op === 'upsert' && r.entityType === 'message' && r.entityId === 'm-p1')
    expect(ups.length).toBe(2)
    const patch = JSON.parse(ups[ups.length - 1].payloadJson as string) as Record<string, unknown>
    expect(patch).toMatchObject({ id: 'm-p1', topicId: 't-ppatch', content: 'edited1' })
    expect(patch).not.toHaveProperty('role')
    expect(patch).not.toHaveProperty('status')
    expect(patch).not.toHaveProperty('sortOrder')
    expect(topicFrameOf(sqlite, 't-ppatch')).toEqual(topicFrameBefore)
    expect(
      outboxRows(db).filter((r) => r.op === 'order_frame' && r.entityType === 'topic' && r.entityId === 't-ppatch')
        .length
    ).toBe(topicOpsBefore)
    expect(outboxRows(db).filter((r) => r.op === 'order_frame' && r.entityType === 'message').length).toBe(
      blockOpsBefore
    )
  })

  it('malformed extra and high-water exhaustion roll back all rows/file refs/outbox/membership/frames/high-water', () => {
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_003_000)
    expect(agg.ensureTopic('t-pbad', 'assistant-1', 'T').ok).toBe(true)
    agg.appendMessage('t-pbad', msgJson('m-b0', 't-pbad') as never, [stableBlock('b-b0', 'm-b0') as never])
    agg.appendMessage('t-pbad', msgJson('m-b1', 't-pbad') as never, [stableBlock('b-b1', 'm-b1') as never])
    sqlite.prepare(`UPDATE message_blocks SET extra='not-json' WHERE id='b-b1'`).run()
    const outboxBefore = outboxRows(db).length
    const frameBefore = topicFrameOf(sqlite, 't-pbad')
    const hwBefore = sqlite
      .prepare(`SELECT max_timestamp AS ts FROM sync_frame_high_water WHERE kind='topicMessage' AND parent_id='t-pbad'`)
      .get() as { ts: number } | undefined
    const resBad = agg.pasteMessagesToTopic('t-pbad', [
      {
        message: msgJson('m-b1', 't-pbad', { content: 'edit' }) as never,
        blocks: [stableBlock('b-b2', 'm-b1') as never]
      }
    ])
    expect(resBad.ok).toBe(false)
    expect(sqlite.prepare(`SELECT id FROM message_blocks WHERE id='b-b2'`).get()).toBeUndefined()
    expect(outboxRows(db).length).toBe(outboxBefore)
    expect(topicFrameOf(sqlite, 't-pbad')).toEqual(frameBefore)
    expect(membershipOf(sqlite, 'message_block', 'b-b2')).toBeUndefined()
    const hwAfter = sqlite
      .prepare(`SELECT max_timestamp AS ts FROM sync_frame_high_water WHERE kind='topicMessage' AND parent_id='t-pbad'`)
      .get() as { ts: number } | undefined
    expect(hwAfter).toEqual(hwBefore)
    sqlite.prepare(`UPDATE message_blocks SET extra=NULL WHERE id='b-b1'`).run()
    expect(agg.ensureTopic('t-pmax', 'assistant-1', 'M').ok).toBe(true)
    agg.appendMessage('t-pmax', msgJson('m-max0', 't-pmax') as never, [])
    const outboxMaxBefore = outboxRows(db).length
    sqlite
      .prepare(`INSERT OR REPLACE INTO sync_frame_high_water (kind, parent_id, max_timestamp) VALUES (?,?,?)`)
      .run('topicMessage', 't-pmax', 9007199254740991)
    const resMax = agg.pasteMessagesToTopic('t-pmax', [{ message: msgJson('m-max1', 't-pmax') as never, blocks: [] }])
    expect(resMax.ok).toBe(false)
    expect(sqlite.prepare(`SELECT id FROM messages WHERE id='m-max1'`).get()).toBeUndefined()
    expect(outboxRows(db).length).toBe(outboxMaxBefore)
    expect(membershipOf(sqlite, 'message', 'm-max1')).toBeUndefined()
  })

  it('dual-profile real relay push/pull converges rows, askId, dense order and winning frames with file refs local-only and no baseline', async () => {
    const rdb = new Database(':memory:')
    ensureRelaySchema(rdb)
    const server = createRelayServer(rdb, { token: 'paste-dual' })
    await new Promise<void>((resolve) => {
      ;(server as unknown as { listen: (p: number, h: string, cb: () => void) => void }).listen(0, '127.0.0.1', () =>
        resolve()
      )
    })
    try {
      const base = `http://127.0.0.1:${(server as unknown as { address: () => { port: number } }).address().port}`
      const auth = { Authorization: 'Bearer paste-dual', 'Content-Type': 'application/json' } as Record<string, string>
      const regA = (await (
        await fetch(`${base}/sync/register`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ deviceId: 'device-paste-a' })
        })
      ).json()) as { deviceCode: string; deviceSecret: string }
      const regB = (await (
        await fetch(`${base}/sync/register`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ deviceId: 'device-paste-b' })
        })
      ).json()) as { deviceCode: string; deviceSecret: string }
      const authed = (c: string, s: string): Record<string, string> => ({
        Authorization: 'Bearer paste-dual',
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
        configStore.set('deviceId', 'device-paste-a')
        const aggA = new ChatDbAggregateService(openedA.db, openedA.sqlite)
        vi.spyOn(Date, 'now').mockReturnValue(8_100_000_000_000)
        expect(aggA.ensureTopic('t-pdual', 'assistant-1', 'Dual').ok).toBe(true)
        aggA.appendMessage('t-pdual', msgJson('m-d0', 't-pdual', { role: 'user' }) as never, [])
        vi.spyOn(Date, 'now').mockReturnValue(8_100_000_000_100)
        const ins = aggA.pasteMessagesToTopic('t-pdual', [
          {
            message: msgJson('m-d1', 't-pdual', { role: 'user' }) as never,
            blocks: [stableBlock('b-d1', 'm-d1') as never]
          },
          {
            message: msgJson('m-d2', 't-pdual', { role: 'assistant', askId: 'm-d1' }) as never,
            blocks: [stableBlock('b-d2', 'm-d2') as never]
          }
        ])
        expect(ins.ok).toBe(true)
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
        expect(messageOrder(openedA.sqlite, 't-pdual')).toEqual(expectedOrder)
        const frameA = topicFrameOf(openedA.sqlite, 't-pdual')!
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
            body: JSON.stringify({ deviceId: 'device-paste-a', operations: chunk })
          })
          expect(pushRes.status).toBe(200)
        }

        bindSingleton(openedB.sqlite, openedB.db)
        const svcB = new SyncService()
        let cursor = 0
        for (;;) {
          const pullRes = await fetch(`${base}/sync/pull?cursor=${cursor}&deviceId=device-paste-b`, {
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
        expect(messageOrder(openedB.sqlite, 't-pdual')).toEqual(expectedOrder)
        const askRow = openedB.sqlite.prepare(`SELECT ask_id AS askId FROM messages WHERE id='m-d2'`).get() as {
          askId: string | null
        }
        expect(askRow.askId).toBe('m-d1')
        const frameB = topicFrameOf(openedB.sqlite, 't-pdual')!
        expect(frameB.orderedChildIds).toEqual(expectedOrder)
        expect(frameB.timestamp).toBe(frameA.timestamp)
        expect(frameB.operationId).toBe(frameA.operationId)
        expect(blockFrameOf(openedB.sqlite, 'm-d1')!.orderedChildIds).toEqual(['b-d1'])
        expect(blockFrameOf(openedB.sqlite, 'm-d2')!.orderedChildIds).toEqual(['b-d2'])
        const sortsB = openedB.sqlite
          .prepare(`SELECT sort_order AS s FROM messages WHERE topic_id='t-pdual' ORDER BY sort_order`)
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

describe('pasteMessagesToTopic audit edge cases', () => {
  it('duplicate message ID in one batch resolves to final content with a single full upsert, single membership and unique frames', () => {
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_010_000)
    expect(agg.ensureTopic('t-pdup', 'assistant-1', 'T').ok).toBe(true)
    agg.appendMessage('t-pdup', msgJson('m-anchor', 't-pdup') as never, [])
    const topicOpsBefore = outboxRows(db).filter(
      (r) => r.op === 'order_frame' && r.entityType === 'topic' && r.entityId === 't-pdup'
    ).length
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_010_100)
    const res = agg.pasteMessagesToTopic('t-pdup', [
      {
        message: msgJson('m-dup', 't-pdup', { content: 'first' }) as never,
        blocks: [stableBlock('b-dup-1', 'm-dup') as never]
      },
      {
        message: msgJson('m-dup', 't-pdup', { content: 'final' }) as never,
        blocks: [stableBlock('b-dup-2', 'm-dup') as never]
      }
    ])
    expect(res.ok).toBe(true)
    expect(messageOrder(sqlite, 't-pdup')).toEqual(['m-anchor', 'm-dup'])
    const row = sqlite.prepare(`SELECT content FROM messages WHERE id='m-dup'`).get() as { content: string }
    expect(row.content).toBe('final')
    expect(blockOrder(sqlite, 'm-dup')).toEqual(['b-dup-1', 'b-dup-2'])
    const mUps = outboxRows(db).filter((r) => r.op === 'upsert' && r.entityType === 'message' && r.entityId === 'm-dup')
    expect(mUps.length).toBe(1)
    const mPayload = JSON.parse(mUps[0].payloadJson as string) as Record<string, unknown>
    expect(mPayload).toMatchObject({ id: 'm-dup', topicId: 't-pdup', content: 'final', role: 'user' })
    expect(mPayload).not.toHaveProperty('sortOrder')
    expect(membershipCount(sqlite, 'message', 'm-dup')).toBe(1)
    expect(membershipOf(sqlite, 'message', 'm-dup')?.parentId).toBe('t-pdup')
    expect(membershipCount(sqlite, 'message_block', 'b-dup-1')).toBe(1)
    expect(membershipCount(sqlite, 'message_block', 'b-dup-2')).toBe(1)
    const topicOps = outboxRows(db).filter(
      (r) => r.op === 'order_frame' && r.entityType === 'topic' && r.entityId === 't-pdup'
    )
    expect(topicOps.length).toBe(topicOpsBefore + 1)
    expect(topicFrameOf(sqlite, 't-pdup')!.orderedChildIds).toEqual(['m-anchor', 'm-dup'])
    const blkOps = outboxRows(db).filter(
      (r) => r.op === 'order_frame' && r.entityType === 'message' && r.entityId === 'm-dup'
    )
    expect(blkOps.length).toBe(1)
    expect(blockFrameOf(sqlite, 'm-dup')!.orderedChildIds).toEqual(['b-dup-1', 'b-dup-2'])
    expect(blkOps[0].id).toBe(blockFrameOf(sqlite, 'm-dup')!.operationId)
  })

  it('message ID owned by another topic fails with conflict semantics and leaves all sync state unchanged', () => {
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_011_000)
    expect(agg.ensureTopic('t-pa', 'assistant-1', 'A').ok).toBe(true)
    agg.appendMessage('t-pa', msgJson('m-a0', 't-pa') as never, [])
    expect(agg.ensureTopic('t-pb', 'assistant-1', 'B').ok).toBe(true)
    agg.appendMessage('t-pb', msgJson('m-fb', 't-pb', { content: 'foreign' }) as never, [])
    const orderABefore = messageOrder(sqlite, 't-pa')
    const orderBBefore = messageOrder(sqlite, 't-pb')
    const outboxBefore = outboxRows(db).length
    const frameBefore = frameSnapshot(sqlite)
    const hwBefore = highWaterSnapshot(sqlite)
    const memBefore = membershipOf(sqlite, 'message', 'm-fb')
    expect(memBefore?.parentId).toBe('t-pb')
    const fileRefsBefore = sqlite.prepare(`SELECT COUNT(*) AS n FROM file_references`).get() as { n: number }
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_011_100)
    const res = agg.pasteMessagesToTopic('t-pa', [
      { message: msgJson('m-fb', 't-pa', { content: 'hijack' }) as never, blocks: [] }
    ])
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe(ERR_CONFLICT)
    }
    expect(messageOrder(sqlite, 't-pa')).toEqual(orderABefore)
    expect(messageOrder(sqlite, 't-pb')).toEqual(orderBBefore)
    const kept = sqlite.prepare(`SELECT content, topic_id AS topicId FROM messages WHERE id='m-fb'`).get() as {
      content: string
      topicId: string
    }
    expect(kept).toMatchObject({ content: 'foreign', topicId: 't-pb' })
    expect(outboxRows(db).length).toBe(outboxBefore)
    expect(frameSnapshot(sqlite)).toEqual(frameBefore)
    expect(highWaterSnapshot(sqlite)).toEqual(hwBefore)
    expect(membershipOf(sqlite, 'message', 'm-fb')).toEqual(memBefore)
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM file_references`).get()).toEqual(fileRefsBefore)
  })

  it('transient untracked message promoted to stable emits a patch with no membership and invalidates the topic frame with zero frame op', () => {
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_012_000)
    expect(agg.ensureTopic('t-ppro', 'assistant-1', 'T').ok).toBe(true)
    agg.appendMessage('t-ppro', msgJson('m-p0', 't-ppro') as never, [])
    agg.appendMessage(
      't-ppro',
      msgJson('m-pro', 't-ppro', { role: 'assistant', status: 'streaming', askId: 'm-p0' }) as never,
      []
    )
    expect(outboxRows(db).filter((r) => r.entityId === 'm-pro').length).toBe(0)
    expect(membershipOf(sqlite, 'message', 'm-pro')).toBeUndefined()
    const topicFrameBefore = topicFrameOf(sqlite, 't-ppro')
    expect(topicFrameBefore).not.toBeNull()
    const topicOpsBefore = outboxRows(db).filter(
      (r) => r.op === 'order_frame' && r.entityType === 'topic' && r.entityId === 't-ppro'
    ).length
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_012_100)
    const res = agg.pasteMessagesToTopic('t-ppro', [
      {
        message: msgJson('m-pro', 't-ppro', { role: 'assistant', status: 'success', askId: 'm-p0' }) as never,
        blocks: []
      }
    ])
    expect(res.ok).toBe(true)
    expect(messageOrder(sqlite, 't-ppro')).toEqual(['m-p0', 'm-pro'])
    const row = sqlite.prepare(`SELECT status FROM messages WHERE id='m-pro'`).get() as { status: string }
    expect(row.status).toBe('success')
    const ups = outboxRows(db).filter((r) => r.op === 'upsert' && r.entityType === 'message' && r.entityId === 'm-pro')
    expect(ups.length).toBe(1)
    const patch = JSON.parse(ups[0].payloadJson as string) as Record<string, unknown>
    expect(patch).toMatchObject({ id: 'm-pro', topicId: 't-ppro', status: 'success' })
    expect(patch).not.toHaveProperty('role')
    expect(patch).not.toHaveProperty('content')
    expect(patch).not.toHaveProperty('sortOrder')
    expect(membershipOf(sqlite, 'message', 'm-pro')).toBeUndefined()
    expect(topicFrameOf(sqlite, 't-ppro')).toBeNull()
    expect(
      outboxRows(db).filter((r) => r.op === 'order_frame' && r.entityType === 'topic' && r.entityId === 't-ppro').length
    ).toBe(topicOpsBefore)
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
    expect(agg.ensureTopic('t-pr', 'assistant-1', 'T').ok).toBe(true)
    agg.appendMessage('t-pr', msgJson('m-r0', 't-pr') as never, [stableBlock('b-r0', 'm-r0') as never])
    agg.appendMessage('t-pr', msgJson('m-r1', 't-pr') as never, [])
    const orderBefore = messageOrder(sqlite, 't-pr')
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
    const res = agg.pasteMessagesToTopic('t-pr', [
      {
        message: msgJson('m-rnew', 't-pr', { content: 'new' }) as never,
        blocks: [{ ...stableBlock('b-r0', 'm-rnew'), content: 'moved' } as never]
      }
    ])
    expect(res.ok).toBe(false)
    expect(messageOrder(sqlite, 't-pr')).toEqual(orderBefore)
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

  it('missing target topic is created locally with the existing topic upsert plus member ops and winning frames', () => {
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_014_000)
    expect(sqlite.prepare(`SELECT id FROM topics WHERE id='t-pmissing'`).get()).toBeUndefined()
    const outboxBefore = outboxRows(db).length
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_014_100)
    const res = agg.pasteMessagesToTopic('t-pmissing', [
      { message: msgJson('m-pm0', 't-pmissing', { role: 'user' }) as never, blocks: [] },
      {
        message: msgJson('m-pm1', 't-pmissing', { role: 'assistant', askId: 'm-pm0' }) as never,
        blocks: [stableBlock('b-pm1', 'm-pm1') as never]
      }
    ])
    expect(res.ok).toBe(true)
    expect(sqlite.prepare(`SELECT id FROM topics WHERE id='t-pmissing'`).get()).toBeTruthy()
    expect(messageOrder(sqlite, 't-pmissing')).toEqual(['m-pm0', 'm-pm1'])
    const ops = outboxRows(db)
    const topicUps = ops.filter((r) => r.op === 'upsert' && r.entityType === 'topic' && r.entityId === 't-pmissing')
    expect(topicUps.length).toBe(1)
    const mUps = ops.filter((r) => r.op === 'upsert' && r.entityType === 'message' && r.entityId === 'm-pm1')
    expect(mUps.length).toBe(1)
    expect((JSON.parse(mUps[0].payloadJson as string) as Record<string, unknown>).askId).toBe('m-pm0')
    expect(membershipOf(sqlite, 'message', 'm-pm0')?.parentId).toBe('t-pmissing')
    expect(membershipOf(sqlite, 'message', 'm-pm1')?.parentId).toBe('t-pmissing')
    expect(membershipOf(sqlite, 'message_block', 'b-pm1')?.parentId).toBe('m-pm1')
    expect(topicFrameOf(sqlite, 't-pmissing')!.orderedChildIds).toEqual(['m-pm0', 'm-pm1'])
    expect(blockFrameOf(sqlite, 'm-pm1')!.orderedChildIds).toEqual(['b-pm1'])
    const topicFrames = ops.filter(
      (r) => r.op === 'order_frame' && r.entityType === 'topic' && r.entityId === 't-pmissing'
    )
    expect(topicFrames.length).toBe(1)
    expect(topicFrames[0].id).toBe(topicFrameOf(sqlite, 't-pmissing')!.operationId)
    // Exactly one topic upsert despite per-message/block closures (no duplicate).
    expect(topicUps.length).toBe(1)
    // topic + 2 messages + 1 block + topic frame + empty block frame (m-pm0) + block frame (m-pm1).
    expect(outboxRows(db).length).toBe(outboxBefore + 7)
    const blkFrames0 = ops.filter((r) => r.op === 'order_frame' && r.entityType === 'message' && r.entityId === 'm-pm0')
    expect(blkFrames0.length).toBe(1)
    expect(blockFrameOf(sqlite, 'm-pm0')!.orderedChildIds).toEqual([])
    // Exact allowlisted topic payload: no sortOrder, no invented keys.
    const topicPayload = JSON.parse(topicUps[0].payloadJson as string) as Record<string, unknown>
    expect(Object.keys(topicPayload).sort()).toEqual([
      'assistantId',
      'createdAt',
      'deletedAt',
      'id',
      'name',
      'updatedAt'
    ])
    expect(topicPayload).toMatchObject({ id: 't-pmissing', name: null, assistantId: null, deletedAt: null })
    expect(topicPayload).not.toHaveProperty('sortOrder')
    // Strict parent-first timestamp order: topic < messages < block < frames.
    const msg0Up = ops.filter((r) => r.op === 'upsert' && r.entityType === 'message' && r.entityId === 'm-pm0')
    expect(msg0Up.length).toBe(1)
    const blkUp = ops.filter((r) => r.op === 'upsert' && r.entityType === 'message_block' && r.entityId === 'b-pm1')
    expect(blkUp.length).toBe(1)
    const blkFrames = ops.filter((r) => r.op === 'order_frame' && r.entityType === 'message' && r.entityId === 'm-pm1')
    expect(blkFrames.length).toBe(1)
    const topicTs = topicUps[0].timestamp
    const msg0Ts = msg0Up[0].timestamp
    const msg1Ts = mUps[0].timestamp
    const blkTs = blkUp[0].timestamp
    const topicFrameTs = topicFrames[0].timestamp
    const blkFrameTs = blkFrames[0].timestamp
    expect(topicTs).toBeLessThan(msg0Ts)
    expect(msg0Ts).toBeLessThan(msg1Ts)
    expect(msg1Ts).toBeLessThan(blkTs)
    // Per-parent clock rule: topic frame exceeds message memberships, non-empty block frame exceeds block memberships.
    // (The empty parent frame reuses the shared allocation rule over its empty included set.)
    expect(msg1Ts).toBeLessThan(topicFrameTs)
    expect(blkTs).toBeLessThan(blkFrameTs)
    // Envelope id/time mirror holds for every frame op including the empty parent frame.
    expect(blkFrames0[0].id).toBe(blockFrameOf(sqlite, 'm-pm0')!.operationId)
    expect(blkFrames0[0].timestamp).toBe(blockFrameOf(sqlite, 'm-pm0')!.timestamp)
    expect(blkFrames[0].id).toBe(blockFrameOf(sqlite, 'm-pm1')!.operationId)
    expect(blkFrames[0].timestamp).toBe(blockFrameOf(sqlite, 'm-pm1')!.timestamp)
  })

  it('missing-topic paste failing after ensure rolls back the newly ensured topic row plus all sync state', () => {
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_015_000)
    expect(sqlite.prepare(`SELECT id FROM topics WHERE id='t-pmfail'`).get()).toBeUndefined()
    sqlite
      .prepare(`INSERT OR REPLACE INTO sync_frame_high_water (kind, parent_id, max_timestamp) VALUES (?,?,?)`)
      .run('topicMessage', 't-pmfail', 9007199254740991)
    const outboxBefore = outboxRows(db).length
    const frameBefore = frameSnapshot(sqlite)
    const hwBefore = highWaterSnapshot(sqlite)
    const fileRefsBefore = sqlite.prepare(`SELECT COUNT(*) AS n FROM file_references`).get() as { n: number }
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_015_100)
    const res = agg.pasteMessagesToTopic('t-pmfail', [
      { message: msgJson('m-pmf0', 't-pmfail', { role: 'user' }) as never, blocks: [] },
      {
        message: msgJson('m-pmf1', 't-pmfail', { role: 'assistant', askId: 'm-pmf0' }) as never,
        blocks: [stableBlock('b-pmf1', 'm-pmf1') as never]
      }
    ])
    expect(res.ok).toBe(false)
    // Newly ensured topic row rolled back with all member rows.
    expect(sqlite.prepare(`SELECT id FROM topics WHERE id='t-pmfail'`).get()).toBeUndefined()
    expect(sqlite.prepare(`SELECT id FROM messages WHERE id='m-pmf0'`).get()).toBeUndefined()
    expect(sqlite.prepare(`SELECT id FROM messages WHERE id='m-pmf1'`).get()).toBeUndefined()
    expect(sqlite.prepare(`SELECT id FROM message_blocks WHERE id='b-pmf1'`).get()).toBeUndefined()
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM file_references`).get()).toEqual(fileRefsBefore)
    expect(outboxRows(db).length).toBe(outboxBefore)
    expect(membershipOf(sqlite, 'message', 'm-pmf0')).toBeUndefined()
    expect(membershipOf(sqlite, 'message', 'm-pmf1')).toBeUndefined()
    expect(membershipOf(sqlite, 'message_block', 'b-pmf1')).toBeUndefined()
    expect(frameSnapshot(sqlite)).toEqual(frameBefore)
    expect(highWaterSnapshot(sqlite)).toEqual(hwBefore)
  })
})

describe('pasteMessagesToTopic audit findings', () => {
  it('transient-only paste persists locally with zero sync intent, preserves the topic frame, and stays truthful partial', () => {
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_020_000)
    expect(agg.ensureTopic('t-ptro', 'assistant-1', 'T').ok).toBe(true)
    agg.appendMessage('t-ptro', msgJson('m-p0', 't-ptro') as never, [])
    const topicFrameBefore = topicFrameOf(sqlite, 't-ptro')!
    expect(topicFrameBefore).not.toBeNull()
    const outboxBefore = outboxRows(db).length
    const topicOpsBefore = outboxRows(db).filter(
      (r) => r.op === 'order_frame' && r.entityType === 'topic' && r.entityId === 't-ptro'
    ).length
    const blockOpsBefore = outboxRows(db).filter((r) => r.op === 'order_frame' && r.entityType === 'message').length
    const frameBefore = frameSnapshot(sqlite)
    const hwBefore = highWaterSnapshot(sqlite)
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_020_100)
    const res = agg.pasteMessagesToTopic('t-ptro', [
      {
        message: msgJson('m-tr', 't-ptro', { role: 'assistant', status: 'streaming', askId: 'm-p0' }) as never,
        blocks: [stableBlock('b-tr', 'm-tr') as never]
      }
    ])
    expect(res.ok).toBe(true)
    // Local row persists (user mutation successful).
    expect(messageOrder(sqlite, 't-ptro')).toContain('m-tr')
    expect(sqlite.prepare(`SELECT id FROM message_blocks WHERE id='b-tr'`).get()).toBeTruthy()
    // Zero sync intent for the excluded item.
    expect(outboxRows(db).filter((r) => r.entityId === 'm-tr').length).toBe(0)
    expect(outboxRows(db).filter((r) => r.entityId === 'b-tr').length).toBe(0)
    expect(membershipOf(sqlite, 'message', 'm-tr')).toBeUndefined()
    expect(membershipOf(sqlite, 'message_block', 'b-tr')).toBeUndefined()
    // Existing topic frame semantically truthful: unchanged, no new frame op.
    expect(topicFrameOf(sqlite, 't-ptro')).toEqual(topicFrameBefore)
    expect(
      outboxRows(db).filter((r) => r.op === 'order_frame' && r.entityType === 'topic' && r.entityId === 't-ptro').length
    ).toBe(topicOpsBefore)
    expect(outboxRows(db).filter((r) => r.op === 'order_frame' && r.entityType === 'message').length).toBe(
      blockOpsBefore
    )
    expect(blockFrameOf(sqlite, 'm-tr')).toBeNull()
    expect(outboxRows(db).length).toBe(outboxBefore)
    expect(frameSnapshot(sqlite)).toEqual(frameBefore)
    expect(highWaterSnapshot(sqlite)).toEqual(hwBefore)
    // Candidate never falsely complete: transient row excluded, never a partial shell.
    const cand = captureLocalSyncBaselineCandidate(db as never) as {
      completeness: { state: string; reasons: string[] }
      entities: Array<{ entityType: string; entityId: string }>
    }
    expect(cand.completeness.state).not.toBe('complete')
    expect(cand.completeness.reasons).toContain('transient-message-excluded')
    expect(cand.entities.filter((e) => e.entityId === 'm-tr').length).toBe(0)
    expect(cand.entities.filter((e) => e.entityId === 'b-tr').length).toBe(0)
  })

  it('unsupported-only paste persists locally with no wire op/membership, invalidates the block parent, and stays truthful partial', () => {
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_021_000)
    expect(agg.ensureTopic('t-puns', 'assistant-1', 'T').ok).toBe(true)
    agg.appendMessage('t-puns', msgJson('m-p0', 't-puns') as never, [])
    const topicOpsBefore = outboxRows(db).filter(
      (r) => r.op === 'order_frame' && r.entityType === 'topic' && r.entityId === 't-puns'
    ).length
    const blockOpsBefore = outboxRows(db).filter((r) => r.op === 'order_frame' && r.entityType === 'message').length
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_021_100)
    const res = agg.pasteMessagesToTopic('t-puns', [
      {
        message: msgJson('m-uns', 't-puns', { role: 'user' }) as never,
        blocks: [
          {
            ...stableBlock('b-uns', 'm-uns'),
            type: 'file',
            file: { id: 'file-uns', name: 'u.pdf', path: '/tmp/u.pdf', type: 'application/pdf' }
          } as never
        ]
      }
    ])
    expect(res.ok).toBe(true)
    // Local row/block persist, including the local-only file reference.
    expect(messageOrder(sqlite, 't-puns')).toContain('m-uns')
    expect(sqlite.prepare(`SELECT id FROM message_blocks WHERE id='b-uns'`).get()).toBeTruthy()
    expect(sqlite.prepare(`SELECT id FROM file_references WHERE block_id='b-uns'`).get()).toBeTruthy()
    // Stable message rides the wire; the unsupported block emits nothing.
    const ops = outboxRows(db)
    expect(ops.filter((r) => r.op === 'upsert' && r.entityType === 'message' && r.entityId === 'm-uns').length).toBe(1)
    expect(membershipOf(sqlite, 'message', 'm-uns')?.parentId).toBe('t-puns')
    expect(ops.filter((r) => r.entityId === 'b-uns').length).toBe(0)
    expect(membershipOf(sqlite, 'message_block', 'b-uns')).toBeUndefined()
    // Topic inclusion converges; the affected block parent stays invalidated with zero block frame op.
    const topicFrames = ops.filter((r) => r.op === 'order_frame' && r.entityType === 'topic' && r.entityId === 't-puns')
    expect(topicFrames.length).toBe(topicOpsBefore + 1)
    expect(topicFrameOf(sqlite, 't-puns')!.orderedChildIds).toEqual(['m-p0', 'm-uns'])
    expect(blockFrameOf(sqlite, 'm-uns')).toBeNull()
    expect(
      ops.filter((r) => r.op === 'order_frame' && r.entityType === 'message' && r.entityId === 'm-uns').length
    ).toBe(0)
    expect(ops.filter((r) => r.op === 'order_frame' && r.entityType === 'message').length).toBe(blockOpsBefore)
    // Candidate never falsely complete, with durable unsupported outcome.
    const cand = captureLocalSyncBaselineCandidate(db as never) as {
      completeness: { state: string; reasons: string[] }
      entities: Array<{ entityType: string; entityId: string }>
    }
    expect(cand.completeness.state).not.toBe('complete')
    expect(cand.completeness.reasons).toContain('unsupported-block-excluded')
    expect(cand.entities.filter((e) => e.entityId === 'b-uns').length).toBe(0)
    const cap = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastCaptureError')).get()
    expect(cap?.value).toContain('unsupported block')
  })

  it('empty entries to a missing topic emits only the topic upsert with no frames and a partial candidate', () => {
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_022_000)
    expect(sqlite.prepare(`SELECT id FROM topics WHERE id='t-pempty'`).get()).toBeUndefined()
    const outboxBefore = outboxRows(db).length
    const hwBefore = highWaterSnapshot(sqlite)
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_022_100)
    const res = agg.pasteMessagesToTopic('t-pempty', [])
    expect(res.ok).toBe(true)
    expect(sqlite.prepare(`SELECT id FROM topics WHERE id='t-pempty'`).get()).toBeTruthy()
    expect(messageOrder(sqlite, 't-pempty')).toEqual([])
    const ops = outboxRows(db)
    expect(ops.length).toBe(outboxBefore + 1)
    const topicUps = ops.filter((r) => r.op === 'upsert' && r.entityType === 'topic' && r.entityId === 't-pempty')
    expect(topicUps.length).toBe(1)
    expect(ops.filter((r) => r.op === 'order_frame').length).toBe(0)
    expect(topicFrameOf(sqlite, 't-pempty')).toBeNull()
    expect(highWaterSnapshot(sqlite)).toEqual(hwBefore)
    // Not a complete empty shell: the missing frame keeps the candidate out of complete.
    const cand = captureLocalSyncBaselineCandidate(db as never) as {
      completeness: { state: string; reasons: string[] }
    }
    expect(cand.completeness.state).not.toBe('complete')
    expect(cand.completeness.reasons).toContain('missing-order-frame')
  })

  it('capture-disabled paste preserves local writes with legacy frame invalidation and zero sync ops/membership', () => {
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_023_000)
    expect(agg.ensureTopic('t-pcap', 'assistant-1', 'T').ok).toBe(true)
    agg.appendMessage('t-pcap', msgJson('m-p0', 't-pcap') as never, [stableBlock('b-p0', 'm-p0') as never])
    expect(topicFrameOf(sqlite, 't-pcap')).not.toBeNull()
    expect(blockFrameOf(sqlite, 'm-p0')).not.toBeNull()
    const outboxBefore = outboxRows(db).length
    configStore.set('sync:enabled', false)
    vi.spyOn(Date, 'now').mockReturnValue(8_000_000_023_100)
    const res = agg.pasteMessagesToTopic('t-pcap', [
      {
        message: msgJson('m-cap', 't-pcap', { role: 'user' }) as never,
        blocks: [stableBlock('b-cap', 'm-cap') as never]
      }
    ])
    expect(res.ok).toBe(true)
    expect(messageOrder(sqlite, 't-pcap')).toContain('m-cap')
    expect(sqlite.prepare(`SELECT id FROM message_blocks WHERE id='b-cap'`).get()).toBeTruthy()
    // Zero sync ops/membership with legacy invalidation.
    expect(outboxRows(db).length).toBe(outboxBefore)
    expect(membershipOf(sqlite, 'message', 'm-cap')).toBeUndefined()
    expect(membershipOf(sqlite, 'message_block', 'b-cap')).toBeUndefined()
    expect(topicFrameOf(sqlite, 't-pcap')).toBeNull()
    expect(blockFrameOf(sqlite, 'm-cap')).toBeNull()
    configStore.set('sync:enabled', true)
  })
})
