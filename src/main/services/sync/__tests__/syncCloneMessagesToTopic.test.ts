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

function outboxFor(db: BetterSQLite3Database<typeof schema>, entityType: string, entityId: string) {
  return outboxRows(db).find((r) => r.op === 'upsert' && r.entityType === entityType && r.entityId === entityId)
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

describe('cloneMessagesToTopic ordinary success sync', () => {
  it('fresh-ID success messages/blocks each mint own upsert+membership with self-clock equality, dual frames, and a complete candidate', () => {
    vi.spyOn(Date, 'now').mockReturnValue(9_000_000_000_000)
    const target = 't-clone-ord'
    const res = agg.cloneMessagesToTopic(target, [
      { message: msgJson('m-c1', target) as never, blocks: [stableBlock('b-c1a', 'm-c1') as never] },
      {
        message: msgJson('m-c2', target) as never,
        blocks: [stableBlock('b-c2a', 'm-c2') as never, stableBlock('b-c2b', 'm-c2') as never]
      }
    ])
    expect(res.ok).toBe(true)
    // Business clone behavior preserved: null return, dense order, block ownership.
    expect(messageOrder(sqlite, target)).toEqual(['m-c1', 'm-c2'])
    expect(blockOrder(sqlite, 'm-c1')).toEqual(['b-c1a'])
    expect(blockOrder(sqlite, 'm-c2')).toEqual(['b-c2a', 'b-c2b'])

    // 1) Each cloned message/block owns exactly one upsert + membership equal to its own op clock.
    for (const mid of ['m-c1', 'm-c2']) {
      const up = outboxFor(db, 'message', mid)
      expect(up).toBeTruthy()
      expect(JSON.parse(up!.payloadJson as string)).not.toHaveProperty('sortOrder')
      const mem = membershipOf(sqlite, 'message', mid)!
      expect(mem.parentId).toBe(target)
      expect(mem.operationId).toBe(up!.id)
      expect(mem.timestamp).toBe(up!.timestamp)
    }
    for (const bid of ['b-c1a', 'b-c2a', 'b-c2b']) {
      const up = outboxFor(db, 'message_block', bid)
      expect(up).toBeTruthy()
      expect(JSON.parse(up!.payloadJson as string)).not.toHaveProperty('sortOrder')
      const parent = (
        sqlite.prepare(`SELECT message_id AS messageId FROM message_blocks WHERE id=?`).get(bid) as {
          messageId: string
        }
      ).messageId
      const mem = membershipOf(sqlite, 'message_block', bid)!
      expect(mem.parentId).toBe(parent)
      expect(mem.operationId).toBe(up!.id)
      expect(mem.timestamp).toBe(up!.timestamp)
    }

    // 2) Two-level frames: topic frame lists both messages; each message frame lists its blocks.
    const topicFrames = outboxRows(db).filter(
      (r) => r.op === 'order_frame' && r.entityType === 'topic' && r.entityId === target
    )
    expect(topicFrames.length).toBe(1)
    const storedTopic = topicFrameOf(sqlite, target)!
    expect(storedTopic.orderedChildIds).toEqual(['m-c1', 'm-c2'])
    expect(topicFrames[0].id).toBe(storedTopic.operationId)
    expect(topicFrames[0].timestamp).toBe(storedTopic.timestamp)
    for (const mid of ['m-c1', 'm-c2']) {
      const bf = outboxRows(db).filter(
        (r) => r.op === 'order_frame' && r.entityType === 'message' && r.entityId === mid
      )
      expect(bf.length).toBe(1)
      expect(bf[0].id).toBe(blockFrameOf(sqlite, mid)!.operationId)
      expect(bf[0].timestamp).toBe(blockFrameOf(sqlite, mid)!.timestamp)
    }
    expect(blockFrameOf(sqlite, 'm-c1')!.orderedChildIds).toEqual(['b-c1a'])
    expect(blockFrameOf(sqlite, 'm-c2')!.orderedChildIds).toEqual(['b-c2a', 'b-c2b'])

    // Candidate no longer reports clone rows as missing/unversioned/incomplete frame/membership.
    // (Isolated harness has no watermark binding, so `unbound` with only the
    // watermark reason is the truthful terminal here — the orthogonal
    // watermark cause, not clone rows.)
    const cand = captureLocalSyncBaselineCandidate(db as never) as {
      completeness: { state: string; reasons: string[] }
      manifest: {
        unversionedMembershipCount: number
        missingOrderFrameCount: number
        incompleteOrderFrameCount: number
      }
    }
    expect(cand.manifest.unversionedMembershipCount).toBe(0)
    expect(cand.manifest.missingOrderFrameCount).toBe(0)
    expect(cand.manifest.incompleteOrderFrameCount).toBe(0)
    expect(cand.completeness.reasons).not.toContain('unversioned-membership')
    expect(cand.completeness.reasons).not.toContain('missing-order-frame')
    expect(cand.completeness.reasons).not.toContain('incomplete-order-frame')
  })

  it('multi-message multi-block order matches the legacy clone result with dense sort_order', () => {
    vi.spyOn(Date, 'now').mockReturnValue(9_000_000_001_000)
    const target = 't-clone-multi'
    const entries = [
      { message: msgJson('m-m1', target) as never, blocks: [stableBlock('b-m1a', 'm-m1') as never] },
      { message: msgJson('m-m2', target) as never, blocks: [] },
      {
        message: msgJson('m-m3', target) as never,
        blocks: [stableBlock('b-m3a', 'm-m3') as never, stableBlock('b-m3b', 'm-m3') as never]
      }
    ]
    const res = agg.cloneMessagesToTopic(target, entries)
    expect(res.ok).toBe(true)
    // Legacy clone result: append order preserved, empty-message parent kept.
    expect(messageOrder(sqlite, target)).toEqual(['m-m1', 'm-m2', 'm-m3'])
    expect(blockOrder(sqlite, 'm-m1')).toEqual(['b-m1a'])
    expect(blockOrder(sqlite, 'm-m2')).toEqual([])
    expect(blockOrder(sqlite, 'm-m3')).toEqual(['b-m3a', 'b-m3b'])
    const sorts = sqlite
      .prepare(`SELECT sort_order AS s FROM messages WHERE topic_id=? ORDER BY sort_order`)
      .all(target) as Array<{ s: number }>
    expect(sorts.map((r) => r.s)).toEqual([0, 1, 2])
    // Frames follow the same order, including the empty block frame.
    expect(topicFrameOf(sqlite, target)!.orderedChildIds).toEqual(['m-m1', 'm-m2', 'm-m3'])
    expect(blockFrameOf(sqlite, 'm-m2')!.orderedChildIds).toEqual([])
  })

  it('cross-topic ownership and high-water exhaustion roll back rows, ensured topic, outbox, membership, frames and high-water', () => {
    vi.spyOn(Date, 'now').mockReturnValue(9_000_000_002_000)
    expect(agg.ensureTopic('t-clone-ok', 'assistant-1', 'O').ok).toBe(true)
    agg.cloneMessagesToTopic('t-clone-ok', [{ message: msgJson('m-ok1', 't-clone-ok') as never, blocks: [] }])
    expect(agg.ensureTopic('t-clone-other', 'assistant-1', 'X').ok).toBe(true)
    agg.cloneMessagesToTopic('t-clone-other', [{ message: msgJson('m-foreign', 't-clone-other') as never, blocks: [] }])

    const outboxBefore = outboxRows(db).length
    const frameBefore = frameSnapshot(sqlite)
    const hwBefore = highWaterSnapshot(sqlite)
    vi.spyOn(Date, 'now').mockReturnValue(9_000_000_002_100)
    // Cross-topic: m-foreign belongs to t-clone-other, cannot clone into t-clone-ok.
    const resCross = agg.cloneMessagesToTopic('t-clone-ok', [
      { message: msgJson('m-foreign', 't-clone-ok') as never, blocks: [] }
    ])
    expect(resCross.ok).toBe(false)
    expect(messageOrder(sqlite, 't-clone-ok')).toEqual(['m-ok1'])
    expect(outboxRows(db).length).toBe(outboxBefore)
    expect(frameSnapshot(sqlite)).toEqual(frameBefore)
    expect(highWaterSnapshot(sqlite)).toEqual(hwBefore)
    expect(membershipOf(sqlite, 'message', 'm-foreign')).toBeTruthy() // pre-existing row keeps its old clock

    // High-water exhaustion on a missing target rolls back the ensured topic too.
    expect(sqlite.prepare(`SELECT id FROM topics WHERE id='t-clone-hw'`).get()).toBeUndefined()
    sqlite
      .prepare(`INSERT OR REPLACE INTO sync_frame_high_water (kind, parent_id, max_timestamp) VALUES (?,?,?)`)
      .run('topicMessage', 't-clone-hw', 9007199254740991)
    const outboxHwBefore = outboxRows(db).length
    const frameHwBefore = frameSnapshot(sqlite)
    const hwHwBefore = highWaterSnapshot(sqlite)
    vi.spyOn(Date, 'now').mockReturnValue(9_000_000_002_200)
    const resHw = agg.cloneMessagesToTopic('t-clone-hw', [
      { message: msgJson('m-hw1', 't-clone-hw') as never, blocks: [] }
    ])
    expect(resHw.ok).toBe(false)
    expect(sqlite.prepare(`SELECT id FROM topics WHERE id='t-clone-hw'`).get()).toBeUndefined()
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM messages WHERE topic_id='t-clone-hw'`).get()).toEqual({ n: 0 })
    expect(outboxRows(db).length).toBe(outboxHwBefore)
    expect(frameSnapshot(sqlite)).toEqual(frameHwBefore)
    expect(highWaterSnapshot(sqlite)).toEqual(hwHwBefore)
  })

  it('unsupported / non-success / transient clones stay local-only with truthful partial and no illegal wire', () => {
    vi.spyOn(Date, 'now').mockReturnValue(9_000_000_003_000)
    const target = 't-clone-mix'
    const res = agg.cloneMessagesToTopic(target, [
      { message: msgJson('m-ok', target) as never, blocks: [stableBlock('b-ok', 'm-ok') as never] },
      {
        message: msgJson('m-tr', target, { role: 'assistant', status: 'streaming', askId: 'm-ok' }) as never,
        blocks: [stableBlock('b-tr', 'm-tr') as never]
      },
      {
        message: msgJson('m-err', target, { status: 'error' }) as never,
        blocks: [stableBlock('b-err', 'm-err', { status: 'error' }) as never]
      },
      {
        message: msgJson('m-f', target) as never,
        blocks: [
          {
            ...stableBlock('b-f', 'm-f'),
            type: 'file',
            file: { id: 'file-mix', name: 'm.pdf', path: '/tmp/m.pdf', type: 'application/pdf' }
          } as never
        ]
      }
    ])
    expect(res.ok).toBe(true)
    // All rows persist locally (business clone behavior), file refs local-only.
    expect(messageOrder(sqlite, target).length).toBe(4)
    expect(sqlite.prepare(`SELECT id FROM file_references WHERE block_id='b-f'`).get()).toBeTruthy()
    // Transient / non-success / unsupported emit zero wire ops and zero membership.
    for (const id of ['m-tr', 'b-tr', 'm-err', 'b-err', 'b-f']) {
      const type = id.startsWith('m-') ? 'message' : 'message_block'
      expect(outboxRows(db).filter((r) => r.entityId === id).length).toBe(0)
      expect(membershipOf(sqlite, type, id)).toBeUndefined()
    }
    // Ordinary success pair still rides the wire with true status (never fabricated to success).
    const okUp = outboxFor(db, 'message', 'm-ok')!
    expect((JSON.parse(okUp.payloadJson as string) as Record<string, unknown>).status).toBe('success')
    expect(outboxFor(db, 'message_block', 'b-ok')).toBeTruthy()
    // Frames exclude the non-ordinary parents; excluded parents invalidate with 0 op.
    expect(blockFrameOf(sqlite, 'm-tr')).toBeNull()
    expect(blockFrameOf(sqlite, 'm-err')).toBeNull()
    expect(blockFrameOf(sqlite, 'm-f')).toBeNull()
    expect(
      outboxRows(db).filter((r) => r.op === 'order_frame' && r.entityType === 'message' && r.entityId === 'm-tr').length
    ).toBe(0)
    // Truthful partial with a durable unsupported outcome; no illegal wire state.
    const cand = captureLocalSyncBaselineCandidate(db as never) as {
      completeness: { state: string; reasons: string[] }
    }
    expect(cand.completeness.state).not.toBe('complete')
    const cap = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastCaptureError')).get()
    expect(cap?.value).toContain('unsupported block')
    for (const row of outboxRows(db)) {
      if (row.op !== 'upsert') continue
      const payload = JSON.parse(row.payloadJson as string) as Record<string, unknown>
      if (row.entityType === 'message_block') {
        expect(String(payload.status)).not.toBe('streaming')
        expect(String(payload.type)).not.toBe('file')
      }
    }
  })

  it('capture-disabled clone preserves local writes with legacy invalidation and zero sync ops/membership', () => {
    vi.spyOn(Date, 'now').mockReturnValue(9_000_000_004_000)
    expect(agg.ensureTopic('t-clone-cap', 'assistant-1', 'C').ok).toBe(true)
    agg.appendMessage('t-clone-cap', msgJson('m-cap0', 't-clone-cap') as never, [
      stableBlock('b-cap0', 'm-cap0', { messageId: 'm-cap0' }) as never
    ])
    expect(topicFrameOf(sqlite, 't-clone-cap')).not.toBeNull()
    const outboxBefore = outboxRows(db).length
    configStore.set('sync:enabled', false)
    vi.spyOn(Date, 'now').mockReturnValue(9_000_000_004_100)
    const res = agg.cloneMessagesToTopic('t-clone-cap', [
      { message: msgJson('m-cap1', 't-clone-cap') as never, blocks: [stableBlock('b-cap1', 'm-cap1') as never] }
    ])
    expect(res.ok).toBe(true)
    expect(messageOrder(sqlite, 't-clone-cap')).toEqual(['m-cap0', 'm-cap1'])
    expect(outboxRows(db).length).toBe(outboxBefore)
    expect(membershipOf(sqlite, 'message', 'm-cap1')).toBeUndefined()
    expect(membershipOf(sqlite, 'message_block', 'b-cap1')).toBeUndefined()
    expect(topicFrameOf(sqlite, 't-clone-cap')).toBeNull()
    expect(blockFrameOf(sqlite, 'm-cap1')).toBeNull()
    configStore.set('sync:enabled', true)
  })

  it('dual-profile real relay converges the cloned target with no baseline and remote file refs local-only', async () => {
    const rdb = new Database(':memory:')
    ensureRelaySchema(rdb)
    const server = createRelayServer(rdb, { token: 'clone-dual' })
    await new Promise<void>((resolve) => {
      ;(server as unknown as { listen: (p: number, h: string, cb: () => void) => void }).listen(0, '127.0.0.1', () =>
        resolve()
      )
    })
    try {
      const base = `http://127.0.0.1:${(server as unknown as { address: () => { port: number } }).address().port}`
      const auth = { Authorization: 'Bearer clone-dual', 'Content-Type': 'application/json' } as Record<string, string>
      const regA = (await (
        await fetch(`${base}/sync/register`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ deviceId: 'device-clone-a' })
        })
      ).json()) as { deviceCode: string; deviceSecret: string }
      const regB = (await (
        await fetch(`${base}/sync/register`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ deviceId: 'device-clone-b' })
        })
      ).json()) as { deviceCode: string; deviceSecret: string }
      const authed = (c: string, s: string): Record<string, string> => ({
        Authorization: 'Bearer clone-dual',
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
        configStore.set('deviceId', 'device-clone-a')
        const aggA = new ChatDbAggregateService(openedA.db, openedA.sqlite)
        vi.spyOn(Date, 'now').mockReturnValue(9_100_000_000_000)
        const cloneRes = aggA.cloneMessagesToTopic('t-clone-dual', [
          { message: msgJson('m-du1', 't-clone-dual', { role: 'user' }) as never, blocks: [] },
          {
            message: msgJson('m-du2', 't-clone-dual', { role: 'assistant', askId: 'm-du1' }) as never,
            blocks: [stableBlock('b-du2', 'm-du2', { messageId: 'm-du2' }) as never]
          }
        ])
        expect(cloneRes.ok).toBe(true)
        const clonedIds = messageOrder(openedA.sqlite, 't-clone-dual')
        expect(clonedIds).toEqual(['m-du1', 'm-du2'])
        const frameA = topicFrameOf(openedA.sqlite, 't-clone-dual')!
        expect(frameA.orderedChildIds).toEqual(clonedIds)

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
        for (let i = 0; i < opsA.length; i += 50) {
          const chunk = opsA.slice(i, i + 50)
          const pushRes = await fetch(`${base}/sync/push`, {
            method: 'POST',
            headers: authed(regA.deviceCode, regA.deviceSecret),
            body: JSON.stringify({ deviceId: 'device-clone-a', operations: chunk })
          })
          expect(pushRes.status).toBe(200)
        }

        bindSingleton(openedB.sqlite, openedB.db)
        const svcB = new SyncService()
        let cursor = 0
        for (;;) {
          const pullRes = await fetch(`${base}/sync/pull?cursor=${cursor}&deviceId=device-clone-b`, {
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
        expect(messageOrder(openedB.sqlite, 't-clone-dual')).toEqual(clonedIds)
        const frameB = topicFrameOf(openedB.sqlite, 't-clone-dual')!
        expect(frameB.orderedChildIds).toEqual(clonedIds)
        expect(frameB.timestamp).toBe(frameA.timestamp)
        expect(frameB.operationId).toBe(frameA.operationId)
        const askRow = openedB.sqlite.prepare(`SELECT ask_id AS askId FROM messages WHERE id='m-du2'`).get() as {
          askId: string | null
        }
        expect(askRow.askId).toBe('m-du1')
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
