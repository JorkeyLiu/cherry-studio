/**
 * Per-(kind, parent_id) winning-frame timestamp high-water (SYNC-DATA-048
 * local implementation invariant, migration 012).
 *
 * Invalidation deletes the winning frame row but never lowers the mark, so a
 * later re-mint allocates strictly above every previously persisted winner
 * timestamp for the same parent — regardless of operationId byte order.
 * Only max timestamps are stored (no operationId); the mark never rides the
 * wire and never affects candidate completeness/authority.
 *
 * Deterministic proofs: invalidate→remint strictly greater for any ids;
 * crafted smaller-id remote winner still wins by timestamp; baseline
 * bootstrap/merge then invalidate/remint strictly greater; remote incoming
 * winner then local remint greater; tx failure never early-commits the mark;
 * MAX_SAFE allocation fails closed.
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
import { applyLocalSyncBaselineCandidate } from '../syncBaselineApply'
import { advanceFrameHighWater, getFrameHighWater } from '../syncFrameHighWater'
import { SyncFrameError, SyncService, syncService } from '../SyncService'
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

function highWaterOf(sqlite: Database.Database, parentId: string): number | null {
  const r = sqlite
    .prepare(`SELECT max_timestamp AS ts FROM sync_frame_high_water WHERE kind='topicMessage' AND parent_id=?`)
    .get(parentId) as { ts: number } | undefined
  return r ? r.ts : null
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

describe('frame high-water monotonicity across invalidate/remint', () => {
  it('invalidate never lowers the mark: remint timestamp strictly greater for any operationId byte order', () => {
    vi.spyOn(Date, 'now').mockReturnValue(7_000_000_000_000)
    expect(agg.ensureTopic('t-hw', 'assistant-1', 'HW').ok).toBe(true)
    agg.appendMessage(
      't-hw',
      { id: 'm-1', topicId: 't-hw', role: 'user', content: 'a', status: 'success' } as never,
      []
    )
    const fOld = frameOf(sqlite, 't-hw')!
    expect(fOld.orderedChildIds).toEqual(['m-1'])
    expect(highWaterOf(sqlite, 't-hw')).toBe(fOld.timestamp)

    // Invalidate deletes the winning row but keeps the mark.
    expect(agg.updateMessage('t-hw', 'm-1', { status: 'streaming' } as never).ok).toBe(true)
    expect(frameOf(sqlite, 't-hw')).toBeNull()
    expect(highWaterOf(sqlite, 't-hw')).toBe(fOld.timestamp)

    // Re-mint (promotion) allocates strictly above the old winner timestamp,
    // regardless of the fresh random operationId byte order.
    expect(agg.updateMessage('t-hw', 'm-1', { status: 'success' } as never).ok).toBe(true)
    const fNew = frameOf(sqlite, 't-hw')!
    expect(fNew.orderedChildIds).toEqual(['m-1'])
    expect(fNew.timestamp).toBeGreaterThan(fOld.timestamp)
    expect(highWaterOf(sqlite, 't-hw')).toBe(fNew.timestamp)
  })

  it('remote incoming winner advances the mark; older local state cannot pull it back; local remint goes strictly above', () => {
    const opened = openChatDb()
    bindSingleton(opened.sqlite, opened.db)
    const svc = new SyncService()
    try {
      opened.sqlite
        .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?,?,?,?)`)
        .run('t-remote', 'T', '2026-01-01', '2026-01-01')
      opened.sqlite
        .prepare(
          `INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
        )
        .run('m-1', 't-remote', 'user', 'c1', 'success', '2026-01-01', '2026-01-01', 0)
      opened.sqlite
        .prepare(
          `INSERT INTO sync_membership_clock (child_entity_type, child_entity_id, parent_id, timestamp, operation_id) VALUES (?,?,?,?,?)`
        )
        .run('message', 'm-1', 't-remote', 10, 'aaaaaaaa-0000-0000-0000-000000000001')
      // Remote winner with a controlled clock.
      const remoteOp = {
        id: 'bbbbbbbb-0000-0000-0000-000000000001',
        entityType: 'topic',
        op: 'order_frame',
        entityId: 't-remote',
        timestamp: 500,
        deviceId: 'd-remote',
        payload: {
          frameVersion: 'parent-order-frame-v1',
          kind: 'topicMessage',
          parentId: 't-remote',
          orderedChildIds: ['m-1'],
          frameClock: { timestamp: 500, operationId: 'bbbbbbbb-0000-0000-0000-000000000001' }
        }
      }
      expect(validateSyncOperationStrict(remoteOp as never)).toBeNull()
      expect(svc.applyIncomingOperation(remoteOp as never)).toBe(true)
      expect(
        (
          opened.sqlite
            .prepare(`SELECT max_timestamp AS ts FROM sync_frame_high_water WHERE kind='topicMessage' AND parent_id=?`)
            .get('t-remote') as { ts: number }
        ).ts
      ).toBe(500)
      // An older re-persist attempt is a consumed no-op and never lowers the mark.
      expect(svc.applyIncomingOperation({ ...remoteOp } as never)).toBe(false)
      // Local re-mint after invalidate goes strictly above the remote winner.
      opened.sqlite
        .prepare(`DELETE FROM sync_parent_order_frame WHERE kind='topicMessage' AND parent_id=?`)
        .run('t-remote')
      configStore.set('deviceId', 'device-hw-local')
      const aggLocal = new ChatDbAggregateService(opened.db, opened.sqlite)
      vi.spyOn(Date, 'now').mockReturnValue(600)
      aggLocal.appendMessage(
        't-remote',
        { id: 'm-2', topicId: 't-remote', role: 'user', content: 'c2', status: 'success' } as never,
        []
      )
      const fLocal = opened.sqlite
        .prepare(
          `SELECT ordered_child_ids_json AS json, timestamp, operation_id AS operationId FROM sync_parent_order_frame WHERE kind='topicMessage' AND parent_id=?`
        )
        .get('t-remote') as { json: string; timestamp: number; operationId: string }
      expect((JSON.parse(fLocal.json) as string[]).sort()).toEqual(['m-1', 'm-2'])
      expect(fLocal.timestamp).toBeGreaterThan(500)
    } finally {
      try {
        opened.sqlite.close()
      } catch {}
      bindSingleton(sqlite, db)
    }
  })

  it('baseline merge landing advances the mark: bootstrap then invalidate/remint strictly greater', () => {
    const src = openChatDb()
    const dst = openChatDb()
    try {
      bindSingleton(src.sqlite, src.db)
      configStore.set('deviceId', 'device-hw-src')
      const aggSrc = new ChatDbAggregateService(src.db, src.sqlite)
      vi.spyOn(Date, 'now').mockReturnValue(8_000_000_000_000)
      expect(aggSrc.ensureTopic('t-base', 'assistant-1', 'B').ok).toBe(true)
      aggSrc.appendMessage(
        't-base',
        { id: 'm-1', topicId: 't-base', role: 'user', content: 'a', status: 'success' } as never,
        []
      )
      const srcFrame = frameOf(src.sqlite, 't-base')!
      seedRegisteredAttachedSyncService(configStore, src.db)
      src.sqlite.prepare(`INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)`).run('cursor', '0')
      src.sqlite.prepare(`INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)`).run('sync:channelKey', 'chan-hw')
      // Drain the source outbox so the snapshot reads as a published state.
      src.db.delete(schema.syncOutbox).run()
      const candidate = captureLocalSyncBaselineCandidate(src.db as never)
      expect(candidate.completeness?.state).toBe('complete')

      // Bootstrap the receiver through the shared merge core.
      applyLocalSyncBaselineCandidate(dst.db as never, candidate)
      const dstFrame = frameOf(dst.sqlite, 't-base')!
      expect(dstFrame.timestamp).toBe(srcFrame.timestamp)
      expect(highWaterOf(dst.sqlite, 't-base')).toBe(srcFrame.timestamp)

      // Invalidate on the receiver, then re-mint via an ordinary append: the
      // new winner must strictly exceed the bootstrapped timestamp.
      bindSingleton(dst.sqlite, dst.db)
      configStore.set('deviceId', 'device-hw-dst')
      const aggDst = new ChatDbAggregateService(dst.db, dst.sqlite)
      vi.spyOn(Date, 'now').mockReturnValue(8_000_000_000_010)
      expect(aggDst.updateMessage('t-base', 'm-1', { status: 'streaming' } as never).ok).toBe(true)
      expect(frameOf(dst.sqlite, 't-base')).toBeNull()
      expect(highWaterOf(dst.sqlite, 't-base')).toBe(srcFrame.timestamp)
      aggDst.appendMessage(
        't-base',
        { id: 'm-2', topicId: 't-base', role: 'user', content: 'b', status: 'success' } as never,
        []
      )
      const fNew = frameOf(dst.sqlite, 't-base')!
      expect(fNew.orderedChildIds).toEqual(['m-2'])
      expect(fNew.timestamp).toBeGreaterThan(srcFrame.timestamp)
    } finally {
      try {
        src.sqlite.close()
      } catch {}
      try {
        dst.sqlite.close()
      } catch {}
      bindSingleton(sqlite, db)
    }
  })

  it('high-water write is same-tx atomic: a later failure rolls the mark back', () => {
    expect(getFrameHighWater(db as never, 'topicMessage', 't-atomic')).toBe(-1)
    expect(() =>
      db.transaction((tx) => {
        advanceFrameHighWater(tx as never, 'topicMessage', 't-atomic', 100)
        throw new Error('simulated post-advance failure')
      })
    ).toThrow('simulated post-advance failure')
    expect(getFrameHighWater(db as never, 'topicMessage', 't-atomic')).toBe(-1)
    // A failed allocation (MAX_SAFE ceiling) advances nothing.
    db.insert(schema.syncFrameHighWater)
      .values({ kind: 'topicMessage', parentId: 't-atomic-max', maxTimestamp: 9007199254740991 })
      .run()
    expect(() => syncService.allocateWinningFrameClockInTx(db as never, 'topicMessage', 't-atomic-max', [])).toThrow(
      SyncFrameError
    )
    expect(
      (
        sqlite
          .prepare(`SELECT max_timestamp AS ts FROM sync_frame_high_water WHERE parent_id=?`)
          .get('t-atomic-max') as { ts: number }
      ).ts
    ).toBe(9007199254740991)
  })

  it('MAX_SAFE mark fails closed on any mint path with zero residue', () => {
    vi.spyOn(Date, 'now').mockReturnValue(9_000_000_000_000)
    expect(agg.ensureTopic('t-max', 'assistant-1', 'M').ok).toBe(true)
    agg.appendMessage(
      't-max',
      { id: 'm-1', topicId: 't-max', role: 'user', content: 'a', status: 'success' } as never,
      []
    )
    const fBefore = frameOf(sqlite, 't-max')!
    const outboxBefore = db.select().from(schema.syncOutbox).all().length
    sqlite
      .prepare(`INSERT OR REPLACE INTO sync_frame_high_water (kind, parent_id, max_timestamp) VALUES (?,?,?)`)
      .run('topicMessage', 't-max', 9007199254740991)
    const reorder = agg.reorderMessages('t-max', ['m-1'])
    expect(reorder.ok).toBe(false)
    expect(frameOf(sqlite, 't-max')).toEqual(fBefore)
    expect(db.select().from(schema.syncOutbox).all().length).toBe(outboxBefore)
    expect(highWaterOf(sqlite, 't-max')).toBe(9007199254740991)
  })

  it('dual-profile relay: crafted smaller-id new winner still wins remotely by timestamp', async () => {
    const relayDbs: Database.Database[] = []
    const relayServers: Array<{ close: (cb?: () => void) => void }> = []
    try {
      const rdb = new Database(':memory:')
      relayDbs.push(rdb)
      ensureRelaySchema(rdb)
      const server = createRelayServer(rdb, { token: 'hw-token' })
      relayServers.push(server as unknown as { close: (cb?: () => void) => void })
      await new Promise<void>((resolve) => {
        ;(server as unknown as { listen: (p: number, h: string, cb: () => void) => void }).listen(0, '127.0.0.1', () =>
          resolve()
        )
      })
      const base = `http://127.0.0.1:${(server as unknown as { address: () => { port: number } }).address().port}`
      const auth = { Authorization: 'Bearer hw-token', 'Content-Type': 'application/json' } as Record<string, string>
      const regA = (await (
        await fetch(`${base}/sync/register`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ deviceId: 'device-hw-a' })
        })
      ).json()) as { deviceCode: string; deviceSecret: string }
      const regB = (await (
        await fetch(`${base}/sync/register`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ deviceId: 'device-hw-b' })
        })
      ).json()) as { deviceCode: string; deviceSecret: string }
      const authed = (code: string, secret: string): Record<string, string> => ({
        Authorization: 'Bearer hw-token',
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
        configStore.set('deviceId', 'device-hw-a')
        const aggA = new ChatDbAggregateService(openedA.db, openedA.sqlite)
        vi.spyOn(Date, 'now').mockReturnValue(10_000_000_000_000)
        expect(aggA.ensureTopic('t-hw-dual', 'assistant-1', 'HW').ok).toBe(true)
        aggA.appendMessage(
          't-hw-dual',
          { id: 'm-1', topicId: 't-hw-dual', role: 'user', content: 'a', status: 'success' } as never,
          []
        )
        const fOld = frameOf(openedA.sqlite, 't-hw-dual')!
        // Push the old winner so B holds it.
        const outboxA = openedA.db.select().from(schema.syncOutbox).all()
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
          body: JSON.stringify({ deviceId: 'device-hw-a', operations: opsA })
        })
        expect(res.status).toBe(200)
        openedA.db.delete(schema.syncOutbox).run()

        bindSingleton(openedB.sqlite, openedB.db)
        const svcB = new SyncService()
        let cursor = 0
        const pullRes = await fetch(`${base}/sync/pull?cursor=${cursor}&deviceId=device-hw-b`, {
          headers: authed(regB.deviceCode, regB.deviceSecret)
        })
        expect(pullRes.status).toBe(200)
        const pullBody = (await pullRes.json()) as {
          operations: Array<Record<string, unknown>>
          cursor: number
        }
        for (const op of pullBody.operations) svcB.applyIncomingOperation(op as never)
        cursor = pullBody.cursor
        expect(
          (
            openedB.sqlite
              .prepare(`SELECT id FROM messages WHERE topic_id='t-hw-dual' ORDER BY sort_order, id`)
              .all() as Array<{
              id: string
            }>
          ).map((r) => r.id)
        ).toEqual(['m-1'])

        // A invalidates locally, then re-mints strictly above the old winner.
        bindSingleton(openedA.sqlite, openedA.db)
        expect(aggA.updateMessage('t-hw-dual', 'm-1', { status: 'streaming' } as never).ok).toBe(true)
        expect(aggA.updateMessage('t-hw-dual', 'm-1', { status: 'success' } as never).ok).toBe(true)
        const fNew = frameOf(openedA.sqlite, 't-hw-dual')!
        expect(fNew.timestamp).toBeGreaterThan(fOld.timestamp)
        // Craft the wire op with a minimal operationId: timestamp dominance
        // must accept the new order regardless of id byte order.
        const tinyId = '00000000-0000-0000-0000-000000000001'
        expect(tinyId < fOld.operationId).toBe(true)
        const crafted = {
          id: tinyId,
          entityType: 'topic',
          op: 'order_frame',
          entityId: 't-hw-dual',
          timestamp: fNew.timestamp,
          deviceId: 'device-hw-a',
          payload: {
            frameVersion: 'parent-order-frame-v1',
            kind: 'topicMessage',
            parentId: 't-hw-dual',
            orderedChildIds: [...fNew.orderedChildIds],
            frameClock: { timestamp: fNew.timestamp, operationId: tinyId }
          }
        }
        expect(validateSyncOperationStrict(crafted as never)).toBeNull()
        res = await fetch(`${base}/sync/push`, {
          method: 'POST',
          headers: authed(regA.deviceCode, regA.deviceSecret),
          body: JSON.stringify({ deviceId: 'device-hw-a', operations: [crafted] })
        })
        expect(res.status).toBe(200)

        bindSingleton(openedB.sqlite, openedB.db)
        const pullRes2 = await fetch(`${base}/sync/pull?cursor=${cursor}&deviceId=device-hw-b`, {
          headers: authed(regB.deviceCode, regB.deviceSecret)
        })
        expect(pullRes2.status).toBe(200)
        const pullBody2 = (await pullRes2.json()) as {
          operations: Array<Record<string, unknown>>
          cursor: number
        }
        expect(pullBody2.operations.length).toBe(1)
        expect(svcB.applyIncomingOperation(pullBody2.operations[0] as never)).toBe(true)
        const frameB = frameOf(openedB.sqlite, 't-hw-dual')!
        expect(frameB.orderedChildIds).toEqual(['m-1'])
        expect(frameB.timestamp).toBe(fNew.timestamp)
        expect(frameB.operationId).toBe(tinyId)
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
