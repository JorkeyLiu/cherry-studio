/**
 * deleteMessagesWithSegments incremental sync close (SYNC-DATA-048 dual-pair).
 *
 * Same wire contract, no new protocol type/endpoint/migration/schema/UI/IPC.
 * Covers: complete membership deletion + delete ops + exactly one topicMessage
 * frame; unknown/non-owned IDs emit no delete op; missing membership preserves
 * user mutation with invalidated frame and zero frame op (+ truthful partial
 * candidate); malformed/exhaustion rolls back rows/segments/outbox/frames;
 * dual-profile relay push/pull convergence for deletion/order/tombstone with
 * no baseline (segments stay local-only).
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

function topicFrameOf(
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

function topicFrameOps(db: BetterSQLite3Database<typeof schema>, parentId: string) {
  return db
    .select()
    .from(schema.syncOutbox)
    .all()
    .filter((r) => r.op === 'order_frame' && r.entityId === parentId)
}

function deleteOps(db: BetterSQLite3Database<typeof schema>, entityId: string) {
  return db
    .select()
    .from(schema.syncOutbox)
    .all()
    .filter((r) => r.op === 'delete' && r.entityType === 'message' && r.entityId === entityId)
}

function messageOrder(sqlite: Database.Database, topicId: string): string[] {
  return (
    sqlite.prepare(`SELECT id FROM messages WHERE topic_id=? ORDER BY sort_order ASC, id ASC`).all(topicId) as Array<{
      id: string
    }>
  ).map((r) => r.id)
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

describe('deleteMessagesWithSegments: complete membership closes incremental sync', () => {
  it('deletes owned messages + segments, enqueues delete ops, refreshes one winning frame with one op', () => {
    vi.spyOn(Date, 'now').mockReturnValue(7_000_000_000_000)
    expect(agg.ensureTopic('t-seg-close', 'assistant-1', 'T').ok).toBe(true)
    for (const mid of ['m-s1', 'm-s2', 'm-s3']) {
      agg.appendMessage(
        't-seg-close',
        { id: mid, topicId: 't-seg-close', role: 'user', content: mid, status: 'success' } as never,
        []
      )
    }
    vi.spyOn(Date, 'now').mockReturnValue(7_000_000_000_001)
    expect(agg.upsertSegment('seg-1', 't-seg-close', 'Seg', ['m-s1', 'm-s2', 'm-s3'], null).ok).toBe(true)
    const frameBefore = topicFrameOf(sqlite, 't-seg-close')!
    expect(frameBefore.orderedChildIds).toEqual(['m-s1', 'm-s2', 'm-s3'])
    const frameOpsBefore = topicFrameOps(db, 't-seg-close').length
    const outboxBefore = db.select().from(schema.syncOutbox).all().length

    vi.spyOn(Date, 'now').mockReturnValue(7_000_000_000_010)
    const res = agg.deleteMessagesWithSegments('t-seg-close', ['m-s1', 'm-s2'])
    expect(res.ok).toBe(true)
    expect(messageOrder(sqlite, 't-seg-close')).toEqual(['m-s3'])
    // Segment membership cleaned locally; no segment wire op exists.
    const segMembers = sqlite
      .prepare(`SELECT message_id AS id FROM topic_segment_messages WHERE segment_id='seg-1'`)
      .all() as Array<{ id: string }>
    expect(segMembers.map((r) => r.id).sort()).toEqual(['m-s3'])
    expect(
      db
        .select()
        .from(schema.syncOutbox)
        .all()
        .some((r) => r.entityType === 'segment')
    ).toBe(false)

    // Exactly one updated winning frame + exactly one matching order_frame op.
    const frameAfter = topicFrameOf(sqlite, 't-seg-close')!
    expect(frameAfter.orderedChildIds).toEqual(['m-s3'])
    expect(frameAfter.timestamp).toBeGreaterThan(frameBefore.timestamp)
    expect(topicFrameOps(db, 't-seg-close').length).toBe(frameOpsBefore + 1)
    const frameOp = topicFrameOps(db, 't-seg-close').at(-1)!
    expect(frameOp.id).toBe(frameAfter.operationId)
    expect(frameOp.timestamp).toBe(frameAfter.timestamp)
    expect(JSON.parse(frameOp.payloadJson as string)).toEqual({
      frameVersion: 'parent-order-frame-v1',
      kind: 'topicMessage',
      parentId: 't-seg-close',
      orderedChildIds: ['m-s3'],
      frameClock: { timestamp: frameAfter.timestamp, operationId: frameAfter.operationId }
    })
    // Delete ops for each owned/known message; deleted block frames removed.
    expect(deleteOps(db, 'm-s1').length).toBe(1)
    expect(deleteOps(db, 'm-s2').length).toBe(1)
    expect(db.select().from(schema.syncOutbox).all().length).toBe(outboxBefore + 3)
    expect(
      sqlite.prepare(`SELECT kind FROM sync_parent_order_frame WHERE kind='messageBlock' AND parent_id='m-s1'`).get()
    ).toBeUndefined()
    expect(
      sqlite.prepare(`SELECT kind FROM sync_parent_order_frame WHERE kind='messageBlock' AND parent_id='m-s2'`).get()
    ).toBeUndefined()
    // Tombstones for both deletes in the same tx.
    expect(sqlite.prepare(`SELECT value FROM sync_state WHERE key='tombstone:message:m-s1'`).get()).toBeTruthy()
    expect(sqlite.prepare(`SELECT value FROM sync_state WHERE key='tombstone:message:m-s2'`).get()).toBeTruthy()
  })

  it('unknown/non-owned IDs emit no delete op and leave frame untouched when nothing owned', () => {
    vi.spyOn(Date, 'now').mockReturnValue(7_100_000_000_000)
    expect(agg.ensureTopic('t-seg-unknown', 'assistant-1', 'T').ok).toBe(true)
    agg.appendMessage(
      't-seg-unknown',
      { id: 'm-k1', topicId: 't-seg-unknown', role: 'user', content: 'a', status: 'success' } as never,
      []
    )
    expect(agg.ensureTopic('t-other', 'assistant-1', 'O').ok).toBe(true)
    agg.appendMessage(
      't-other',
      { id: 'm-foreign', topicId: 't-other', role: 'user', content: 'x', status: 'success' } as never,
      []
    )
    const frameBefore = topicFrameOf(sqlite, 't-seg-unknown')!
    const outboxBefore = db.select().from(schema.syncOutbox).all().length
    const frameOpsBefore = topicFrameOps(db, 't-seg-unknown').length

    const res = agg.deleteMessagesWithSegments('t-seg-unknown', ['m-missing', 'm-foreign'])
    expect(res.ok).toBe(true)
    expect(messageOrder(sqlite, 't-seg-unknown')).toEqual(['m-k1'])
    expect(topicFrameOf(sqlite, 't-seg-unknown')).toEqual(frameBefore)
    expect(db.select().from(schema.syncOutbox).all().length).toBe(outboxBefore)
    expect(topicFrameOps(db, 't-seg-unknown').length).toBe(frameOpsBefore)
    expect(deleteOps(db, 'm-missing').length).toBe(0)
    expect(deleteOps(db, 'm-foreign').length).toBe(0)
  })
})

describe('deleteMessagesWithSegments: missing membership truthfully invalidates', () => {
  it('user deletion succeeds, frame invalidated, zero frame op, candidate partial', () => {
    vi.spyOn(Date, 'now').mockReturnValue(7_200_000_000_000)
    expect(agg.ensureTopic('t-seg-missing', 'assistant-1', 'T').ok).toBe(true)
    agg.appendMessage(
      't-seg-missing',
      { id: 'm-v1', topicId: 't-seg-missing', role: 'user', content: 'a', status: 'success' } as never,
      []
    )
    vi.spyOn(Date, 'now').mockReturnValue(7_200_000_000_001)
    agg.appendMessage(
      't-seg-missing',
      { id: 'm-v2', topicId: 't-seg-missing', role: 'user', content: 'b', status: 'success' } as never,
      []
    )
    // Legacy surviving child without membership (no backfill/guess).
    sqlite
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
      )
      .run('m-legacy', 't-seg-missing', 'user', 'legacy', 'success', '2026-01-01', '2026-01-01', 2)
    expect(agg.upsertSegment('seg-miss', 't-seg-missing', 'Seg', ['m-v1', 'm-v2', 'm-legacy'], null).ok).toBe(true)
    const frameOpsBefore = topicFrameOps(db, 't-seg-missing').length
    const outboxBefore = db.select().from(schema.syncOutbox).all().length

    const res = agg.deleteMessagesWithSegments('t-seg-missing', ['m-v1'])
    expect(res.ok).toBe(true)
    expect(messageOrder(sqlite, 't-seg-missing')).toEqual(['m-v2', 'm-legacy'])
    // Delete op still enqueued for the owned/known deleted message.
    expect(deleteOps(db, 'm-v1').length).toBe(1)
    // Frame truthfully invalidated with zero new frame op; user mutation preserved.
    expect(topicFrameOf(sqlite, 't-seg-missing')).toBeNull()
    expect(topicFrameOps(db, 't-seg-missing').length).toBe(frameOpsBefore)
    expect(db.select().from(schema.syncOutbox).all().length).toBe(outboxBefore + 1)
    // Candidate stays truthful partial, never synthesized.
    const candidate = captureLocalSyncBaselineCandidate(db as never)
    expect(candidate.completeness?.state).not.toBe('complete')
    expect(JSON.stringify(candidate.completeness?.reasons ?? [])).toMatch(/missing-order-frame|unversioned-membership/)
  })
})

describe('deleteMessagesWithSegments: malformed/exhaustion rolls back atomically', () => {
  it('malformed persisted frame rolls back rows, segments, outbox, tombstones, frames together', () => {
    vi.spyOn(Date, 'now').mockReturnValue(7_300_000_000_000)
    expect(agg.ensureTopic('t-seg-mal', 'assistant-1', 'T').ok).toBe(true)
    agg.appendMessage(
      't-seg-mal',
      { id: 'm-a1', topicId: 't-seg-mal', role: 'user', content: 'a', status: 'success' } as never,
      []
    )
    vi.spyOn(Date, 'now').mockReturnValue(7_300_000_000_001)
    agg.appendMessage(
      't-seg-mal',
      { id: 'm-a2', topicId: 't-seg-mal', role: 'user', content: 'b', status: 'success' } as never,
      []
    )
    expect(agg.upsertSegment('seg-mal', 't-seg-mal', 'Seg', ['m-a1', 'm-a2'], null).ok).toBe(true)
    // Corrupt the winning frame payload so the refresh read fails closed.
    // '{}' passes the SQLite json_valid CHECK but fails strict frame validation.
    sqlite
      .prepare(
        `UPDATE sync_parent_order_frame SET ordered_child_ids_json='{}' WHERE kind='topicMessage' AND parent_id=?`
      )
      .run('t-seg-mal')
    const outboxBefore = db.select().from(schema.syncOutbox).all().length
    const orderBefore = messageOrder(sqlite, 't-seg-mal')

    const res = agg.deleteMessagesWithSegments('t-seg-mal', ['m-a1'])
    expect(res.ok).toBe(false)
    expect(messageOrder(sqlite, 't-seg-mal')).toEqual(orderBefore)
    expect(
      (
        sqlite
          .prepare(`SELECT message_id AS id FROM topic_segment_messages WHERE segment_id='seg-mal'`)
          .all() as Array<{
          id: string
        }>
      )
        .map((r) => r.id)
        .sort()
    ).toEqual(['m-a1', 'm-a2'])
    expect(db.select().from(schema.syncOutbox).all().length).toBe(outboxBefore)
    expect(sqlite.prepare(`SELECT value FROM sync_state WHERE key='tombstone:message:m-a1'`).get()).toBeUndefined()
  })

  it('frame clock exhaustion rolls back with zero residue', () => {
    vi.spyOn(Date, 'now').mockReturnValue(7_400_000_000_000)
    expect(agg.ensureTopic('t-seg-exh', 'assistant-1', 'T').ok).toBe(true)
    agg.appendMessage(
      't-seg-exh',
      { id: 'm-e1', topicId: 't-seg-exh', role: 'user', content: 'a', status: 'success' } as never,
      []
    )
    vi.spyOn(Date, 'now').mockReturnValue(7_400_000_000_001)
    agg.appendMessage(
      't-seg-exh',
      { id: 'm-e2', topicId: 't-seg-exh', role: 'user', content: 'b', status: 'success' } as never,
      []
    )
    expect(agg.upsertSegment('seg-exh', 't-seg-exh', 'Seg', ['m-e1', 'm-e2'], null).ok).toBe(true)
    const MAX_SAFE = 9007199254740991
    sqlite
      .prepare(`UPDATE sync_membership_clock SET timestamp=? WHERE child_entity_id IN ('m-e1','m-e2')`)
      .run(MAX_SAFE)
    sqlite
      .prepare(`UPDATE sync_parent_order_frame SET timestamp=? WHERE kind='topicMessage' AND parent_id=?`)
      .run(MAX_SAFE, 't-seg-exh')
    const outboxBefore = db.select().from(schema.syncOutbox).all().length
    const orderBefore = messageOrder(sqlite, 't-seg-exh')

    const res = agg.deleteMessagesWithSegments('t-seg-exh', ['m-e1'])
    expect(res.ok).toBe(false)
    expect(messageOrder(sqlite, 't-seg-exh')).toEqual(orderBefore)
    expect(db.select().from(schema.syncOutbox).all().length).toBe(outboxBefore)
    expect(sqlite.prepare(`SELECT value FROM sync_state WHERE key='tombstone:message:m-e1'`).get()).toBeUndefined()
    expect((topicFrameOf(sqlite, 't-seg-exh') as { timestamp: number }).timestamp).toBe(MAX_SAFE)
  })
})

describe('deleteMessagesWithSegments: dual-profile relay convergence without baseline', () => {
  it('deletion/order/tombstone converge on B with no baseline; segments stay local-only', async () => {
    const relayDbs: Database.Database[] = []
    const relayServers: Array<{ close: (cb?: () => void) => void }> = []
    try {
      const rdb = new Database(':memory:')
      relayDbs.push(rdb)
      ensureRelaySchema(rdb)
      const server = createRelayServer(rdb, { token: 'seg-close-token' })
      relayServers.push(server as unknown as { close: (cb?: () => void) => void })
      await new Promise<void>((resolve) => {
        ;(server as unknown as { listen: (p: number, h: string, cb: () => void) => void }).listen(0, '127.0.0.1', () =>
          resolve()
        )
      })
      const base = `http://127.0.0.1:${(server as unknown as { address: () => { port: number } }).address().port}`
      const auth = { Authorization: 'Bearer seg-close-token', 'Content-Type': 'application/json' } as Record<
        string,
        string
      >
      const regA = (await (
        await fetch(`${base}/sync/register`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ deviceId: 'device-seg-a' })
        })
      ).json()) as { deviceCode: string; deviceSecret: string }
      const regB = (await (
        await fetch(`${base}/sync/register`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ deviceId: 'device-seg-b' })
        })
      ).json()) as { deviceCode: string; deviceSecret: string }
      const authed = (code: string, secret: string): Record<string, string> => ({
        Authorization: 'Bearer seg-close-token',
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
        bindSingleton(openedA.sqlite, openedA.db)
        configStore.set('sync:enabled', true)
        configStore.set('deviceId', 'device-seg-a')
        const aggA = new ChatDbAggregateService(openedA.db, openedA.sqlite)
        vi.spyOn(Date, 'now').mockReturnValue(7_500_000_000_000)
        expect(aggA.ensureTopic('t-dual-seg', 'assistant-1', 'Dual').ok).toBe(true)
        for (const mid of ['m-d1', 'm-d2', 'm-d3']) {
          aggA.appendMessage(
            't-dual-seg',
            { id: mid, topicId: 't-dual-seg', role: 'user', content: mid, status: 'success' } as never,
            []
          )
        }
        expect(aggA.upsertSegment('seg-dual', 't-dual-seg', 'Seg', ['m-d1', 'm-d2', 'm-d3'], null).ok).toBe(true)
        vi.spyOn(Date, 'now').mockReturnValue(7_500_000_000_010)
        expect(aggA.deleteMessagesWithSegments('t-dual-seg', ['m-d1']).ok).toBe(true)
        const expectedOrder = ['m-d2', 'm-d3']
        expect(
          (
            openedA.sqlite
              .prepare(`SELECT id FROM messages WHERE topic_id='t-dual-seg' ORDER BY sort_order, id`)
              .all() as Array<{
              id: string
            }>
          ).map((r) => r.id)
        ).toEqual(expectedOrder)
        const frameA = topicFrameOf(openedA.sqlite, 't-dual-seg')!
        expect(frameA.orderedChildIds).toEqual(expectedOrder)

        bindSingleton(openedA.sqlite, openedA.db)
        const outboxA = openedA.db.select().from(schema.syncOutbox).all()
        expect(outboxA.some((r) => r.op === 'order_frame')).toBe(true)
        expect(outboxA.some((r) => r.op === 'delete' && r.entityId === 'm-d1')).toBe(true)
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
            body: JSON.stringify({ deviceId: 'device-seg-a', operations: chunk })
          })
          expect(pushRes.status).toBe(200)
        }

        bindSingleton(openedB.sqlite, openedB.db)
        const svcB = new SyncService()
        let cursor = 0
        for (;;) {
          const pullRes = await fetch(`${base}/sync/pull?cursor=${cursor}&deviceId=device-seg-b`, {
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
          for (const op of deferred) {
            svcB.applyIncomingOperation(op as never)
          }
          cursor = body.cursor
          if (body.operations.length < 200) break
        }
        const baselineRes = await fetch(`${base}/sync/baseline`, {
          headers: authed(regB.deviceCode, regB.deviceSecret)
        })
        expect(baselineRes.status).toBe(404)

        expect(
          (
            openedB.sqlite
              .prepare(`SELECT id FROM messages WHERE topic_id='t-dual-seg' ORDER BY sort_order, id`)
              .all() as Array<{
              id: string
            }>
          ).map((r) => r.id)
        ).toEqual(expectedOrder)
        const frameB = topicFrameOf(openedB.sqlite, 't-dual-seg')!
        expect(frameB.orderedChildIds).toEqual(expectedOrder)
        expect(frameB.timestamp).toBe(frameA.timestamp)
        expect(frameB.operationId).toBe(frameA.operationId)
        expect(
          openedB.sqlite.prepare(`SELECT value FROM sync_state WHERE key='tombstone:message:m-d1'`).get()
        ).toBeTruthy()
        // Segments never ride the wire: B stays segment-free for this topic.
        expect(
          openedB.sqlite.prepare(`SELECT id FROM topic_segments WHERE topic_id='t-dual-seg'`).all() as Array<{
            id: string
          }>
        ).toEqual([])
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
