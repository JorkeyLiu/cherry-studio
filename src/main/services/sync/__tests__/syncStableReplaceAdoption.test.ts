/**
 * Reset adoption: success-final `message_stable_replace` adopts a missing
 * pre-existing target message membership (third work unit, reset-first).
 *
 * - Reset intermediate stays 0-op/0-frame-op/0-membership-mint (covered by
 *   existing intent/frame suites; asserted here via post-reset frameless +
 *   missing membership).
 * - Success-final with an exactly-matching intent, ordinary stable supported
 *   post-state, and complete sibling memberships mints the target membership
 *   at `replacementClock = max(existing clocks except the missing target)+1`
 *   in the same final transaction; wire `parentMembershipClock` equals the
 *   replacement clock and both frames mirror it.
 */
import { validateSyncOperationStrict } from '@shared/sync'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ensureRelaySchema } from '../../../../../scripts/sync-relay/server'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')
vi.mock('@main/config', () => ({ DATA_PATH: '/tmp' }))

const configStore = new Map<string, unknown>()
vi.mock('@main/services/ConfigManager', () => ({
  configManager: {
    get: (k: string, v?: unknown) => (configStore.has(k) ? configStore.get(k) : v),
    set: (k: string, v: unknown) => configStore.set(k, v),
    has: (k: string) => configStore.has(k)
  },
  ConfigKeys: {}
}))

import { chatDbService } from '../../chatDb'
import { ChatDbAggregateService } from '../../chatDb/ChatDbAggregateService'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { getFrameHighWater } from '../syncFrameHighWater'
import { syncService } from '../SyncService'
import { seedRegisteredAttachedSyncService } from './helpers/syncTestRegistration'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>
let agg: ChatDbAggregateService

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

function bindCurrent(): void {
  ;(chatDbService as never as { sqlite: unknown }).sqlite = sqlite
  ;(chatDbService as never as { db: unknown }).db = db
  agg = new ChatDbAggregateService(db, sqlite)
}

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
  configStore.set('sync:token', '')
  sqlite = openInMemory()
  db = drizzle(sqlite, { schema })
  runMigrations(db as never, sqlite)
  bindCurrent()
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

function stableReplaceRows(): Array<Record<string, unknown>> {
  return sqlite.prepare(`SELECT * FROM sync_outbox WHERE op='message_stable_replace'`).all() as Array<
    Record<string, unknown>
  >
}

function readOp(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    entityType: row.entity_type,
    op: row.op,
    entityId: row.entity_id,
    timestamp: row.timestamp,
    deviceId: row.device_id,
    payload: JSON.parse(row.payload_json as string)
  }
}

function getIntentRow(messageId: string): Record<string, unknown> | undefined {
  return sqlite.prepare(`SELECT * FROM sync_resend_attempt WHERE message_id=?`).get(messageId) as
    | Record<string, unknown>
    | undefined
}

function seedVersionedUser(topicId: string, userId: string): void {
  const res = agg.appendMessage(
    topicId,
    { id: userId, topicId, role: 'user', content: 'q', status: 'success' } as never,
    []
  )
  expect(res.ok).toBe(true)
}

function seedVersionedAssistant(topicId: string, assistantId: string, askId: string, blockId: string): void {
  const res = agg.appendMessage(
    topicId,
    { id: assistantId, topicId, role: 'assistant', content: 'old answer', status: 'success', askId } as never,
    [{ id: blockId, messageId: assistantId, type: 'main_text', content: 'old answer', status: 'success' } as never]
  )
  expect(res.ok).toBe(true)
}

function insertUnversionedMessage(topicId: string, messageId: string, askId: string): void {
  sqlite
    .prepare(
      `INSERT INTO messages (id, topic_id, role, content, status, ask_id, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,0,'2026-09-12T00:00:00.000Z','2026-09-12T00:00:00.000Z')`
    )
    .run(messageId, topicId, 'assistant', 'old unversioned', 'success', askId)
}

describe('reset adoption — success final mints the missing target membership', () => {
  it('old message without membership plus versioned siblings issues one op with mint == op clock', () => {
    seedVersionedUser('t-a-1', 'u-a-1')
    seedVersionedAssistant('t-a-1', 'm-sib-1', 'u-a-1', 'b-sib-1')
    insertUnversionedMessage('t-a-1', 'm-a-1', 'u-a-1')
    db.delete(schema.syncOutbox).run()
    expect(syncService.getMembershipClock('message', 'm-a-1')).toBeNull()
    const sibMemBefore = syncService.getMembershipClock('message', 'm-sib-1')
    expect(sibMemBefore).not.toBeNull()
    const hwTopicBefore = getFrameHighWater(db as never, 'topicMessage', 't-a-1')
    const hwMsgBefore = getFrameHighWater(db as never, 'messageBlock', 'm-a-1')

    const resetMsg = { id: 'm-a-1', topicId: 't-a-1', role: 'assistant', status: 'pending', askId: 'u-a-1' } as never
    const res = agg.resetMessagesForResend('t-a-1', [{ message: resetMsg, blocks: [] } as never], [])
    expect(res.ok).toBe(true)
    const attemptId = ((res as { ok: true; value: unknown }).value as { attempts: Array<{ attemptId: string }> })
      .attempts[0].attemptId
    db.delete(schema.syncOutbox).run()
    // Reset intermediate stays 0-op/0-membership-mint/frameless for the target path.
    expect(stableReplaceRows()).toHaveLength(0)
    expect(syncService.getMembershipClock('message', 'm-a-1')).toBeNull()
    expect(syncService.getParentFrame('topicMessage', 't-a-1')).toBeNull()
    expect(syncService.getParentFrame('messageBlock', 'm-a-1')).toBeNull()

    expect(
      agg.bulkAddBlocks(
        [{ id: 'b-a-n1', messageId: 'm-a-1', type: 'main_text', content: 'new answer', status: 'success' } as never],
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-a-1', 'm-a-1', { status: 'success', content: 'new answer' } as never, {
        resendAttemptId: attemptId
      }).ok
    ).toBe(true)

    const rows = stableReplaceRows()
    expect(rows).toHaveLength(1)
    const op = readOp(rows[0])
    expect(validateSyncOperationStrict(op)).toBeNull()
    expect(op.op).toBe('message_stable_replace')
    const payload = op.payload as Record<string, unknown>
    const rc = payload.replacementClock as { timestamp: number; operationId: string }
    expect(op.id).toBe(rc.operationId)
    expect(op.timestamp).toBe(rc.timestamp)
    // replacementClock strictly above every existing relevant clock.
    expect(rc.timestamp).toBeGreaterThan(sibMemBefore!.timestamp)
    expect(rc.timestamp).toBeGreaterThan(hwTopicBefore)
    expect(rc.timestamp).toBeGreaterThan(hwMsgBefore)
    expect(rc.timestamp).toBeGreaterThan(Date.now() - 60_000)
    // Target membership minted at the op clock; wire payload mirrors it.
    const minted = syncService.getMembershipClock('message', 'm-a-1')
    expect(minted?.parentId).toBe('t-a-1')
    expect(minted?.timestamp).toBe(rc.timestamp)
    expect(minted?.operationId).toBe(rc.operationId)
    expect((payload.message as Record<string, unknown>).parentMembershipClock).toEqual(rc)
    // Both frames mirror the single replacement clock.
    expect((payload.topicFrame as Record<string, unknown>).frameClock).toEqual(rc)
    expect((payload.messageFrame as Record<string, unknown>).frameClock).toEqual(rc)
    expect((payload.topicFrame as Record<string, unknown>).orderedChildIds as string[]).toContain('m-a-1')
    // Register/dual frames/intent/dense order correct.
    expect(getIntentRow('m-a-1')).toBeUndefined()
    const reg = sqlite.prepare(`SELECT * FROM sync_stable_replace_register WHERE message_id='m-a-1'`).get() as Record<
      string,
      unknown
    >
    expect(reg.timestamp).toBe(rc.timestamp)
    expect(reg.operation_id).toBe(rc.operationId)
    const topicF = syncService.getParentFrame('topicMessage', 't-a-1')
    const msgF = syncService.getParentFrame('messageBlock', 'm-a-1')
    expect(topicF?.timestamp).toBe(rc.timestamp)
    expect(msgF?.timestamp).toBe(rc.timestamp)
    const blkOrder = sqlite
      .prepare(`SELECT id, sort_order FROM message_blocks WHERE message_id='m-a-1' ORDER BY sort_order, id`)
      .all() as Array<{ id: string; sort_order: number }>
    expect(blkOrder.map((r) => r.sort_order)).toEqual([0])
    const msgOrder = sqlite
      .prepare(`SELECT id, sort_order FROM messages WHERE topic_id='t-a-1' ORDER BY sort_order, id`)
      .all() as Array<{ id: string; sort_order: number }>
    expect(msgOrder.map((r) => r.sort_order)).toEqual(msgOrder.map((_, i) => i))
  })

  it('dual profile relay receiver converges with missing row or missing membership', async () => {
    seedVersionedUser('t-a-2', 'u-a-2')
    seedVersionedAssistant('t-a-2', 'm-sib-2', 'u-a-2', 'b-sib-2')
    insertUnversionedMessage('t-a-2', 'm-a-2', 'u-a-2')
    db.delete(schema.syncOutbox).run()
    const resetMsg = { id: 'm-a-2', topicId: 't-a-2', role: 'assistant', status: 'pending', askId: 'u-a-2' } as never
    const res = agg.resetMessagesForResend('t-a-2', [{ message: resetMsg, blocks: [] } as never], [])
    expect(res.ok).toBe(true)
    const attemptId = ((res as { ok: true; value: unknown }).value as { attempts: Array<{ attemptId: string }> })
      .attempts[0].attemptId
    db.delete(schema.syncOutbox).run()
    expect(
      agg.bulkAddBlocks(
        [{ id: 'b-a2-n1', messageId: 'm-a-2', type: 'main_text', content: 'adopted', status: 'success' } as never],
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-a-2', 'm-a-2', { status: 'success', content: 'adopted' } as never, {
        resendAttemptId: attemptId
      }).ok
    ).toBe(true)
    const issued = stableReplaceRows()
    expect(issued).toHaveLength(1)
    const op = readOp(issued[0])
    expect(validateSyncOperationStrict(op)).toBeNull()
    const opDeviceId = op.deviceId as string

    const { createRelayServer } = await import('../../../../../scripts/sync-relay/server')
    // Two receivers: B-missing has no target row; B-unversioned has the row but no membership.
    // Each uses an isolated relay channel (one A↔B pair per relay) to avoid cross-pair 409.
    const sqliteBMissing = openInMemory()
    const dbBMissing = drizzle(sqliteBMissing, { schema })
    runMigrations(dbBMissing as never, sqliteBMissing)
    const sqliteBUnversioned = openInMemory()
    const dbBUnversioned = drizzle(sqliteBUnversioned, { schema })
    runMigrations(dbBUnversioned as never, sqliteBUnversioned)
    const relayRoundTrip = async (
      handle: { sqlite: Database.Database; db: BetterSQLite3Database<typeof schema> },
      deviceB: string,
      seedUnversioned: boolean
    ): Promise<void> => {
      const relayDb = new Database(':memory:')
      ensureRelaySchema(relayDb)
      const server = createRelayServer(relayDb, {})
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      const addr = server.address() as { port: number }
      const base = `http://127.0.0.1:${addr.port}`
      try {
        const register = async (deviceId: string): Promise<{ code: string; secret: string }> => {
          const r = await fetch(`${base}/sync/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId })
          })
          expect(r.status).toBe(200)
          const body = (await r.json()) as { deviceCode: string; deviceSecret: string }
          return { code: body.deviceCode, secret: body.deviceSecret }
        }
        const regA = await register(opDeviceId)
        const regB = await register(deviceB)
        const authA = { 'x-sync-device-code': regA.code, 'x-sync-device-secret': regA.secret }
        const authB = { 'x-sync-device-code': regB.code, 'x-sync-device-secret': regB.secret }
        const reqRes = await fetch(`${base}/sync/pair/request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authA },
          body: JSON.stringify({ targetCode: regB.code })
        })
        expect(reqRes.status).toBe(200)
        const { requestId } = (await reqRes.json()) as { requestId: string }
        const accRes = await fetch(`${base}/sync/pair/accept`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authB },
          body: JSON.stringify({ requestId })
        })
        expect(accRes.status).toBe(200)
        const pushRes = await fetch(`${base}/sync/push`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authA },
          body: JSON.stringify({ deviceId: opDeviceId, operations: [op] })
        })
        expect(pushRes.status).toBe(200)

        ;(chatDbService as never as { sqlite: unknown }).sqlite = handle.sqlite
        ;(chatDbService as never as { db: unknown }).db = handle.db
        syncService.clearAllForTests()
        seedRegisteredAttachedSyncService(configStore, handle.db)
        const bAgg = new ChatDbAggregateService(handle.db, handle.sqlite)
        expect(
          bAgg.appendMessage(
            't-a-2',
            { id: 'u-a-2', topicId: 't-a-2', role: 'user', content: 'q', status: 'success' } as never,
            []
          ).ok
        ).toBe(true)
        expect(
          bAgg.appendMessage(
            't-a-2',
            {
              id: 'm-sib-2',
              topicId: 't-a-2',
              role: 'assistant',
              content: 'old answer',
              status: 'success',
              askId: 'u-a-2'
            } as never,
            [
              {
                id: 'b-sib-2',
                messageId: 'm-sib-2',
                type: 'main_text',
                content: 'old answer',
                status: 'success'
              } as never
            ]
          ).ok
        ).toBe(true)
        if (seedUnversioned) {
          handle.sqlite
            .prepare(
              `INSERT INTO messages (id, topic_id, role, content, status, ask_id, sort_order, created_at, updated_at) VALUES ('m-a-2','t-a-2','assistant','stale','success','u-a-2',2,'2026-09-12T00:00:00.000Z','2026-09-12T00:00:00.000Z')`
            )
            .run()
        }
        const pullRes = await fetch(`${base}/sync/pull?cursor=0&deviceId=${encodeURIComponent(deviceB)}`, {
          headers: authB
        })
        expect(pullRes.status).toBe(200)
        const pullBody = (await pullRes.json()) as { operations?: Array<Record<string, unknown>> }
        const pulled = (pullBody.operations ?? []).find((o) => o.id === op.id)
        expect(pulled).toBeDefined()
        const { seq: _seq, ...withoutSeq } = pulled as Record<string, unknown> & { seq?: unknown }
        expect(typeof _seq).toBe('number')
        expect(syncService.applyIncomingOperation(withoutSeq as never)).toBe(true)
        expect(
          (handle.sqlite.prepare(`SELECT content FROM messages WHERE id='m-a-2'`).get() as { content: string }).content
        ).toBe('adopted')
        expect(
          (handle.sqlite.prepare(`SELECT content FROM message_blocks WHERE id='b-a2-n1'`).get() as { content: string })
            .content
        ).toBe('adopted')
        const mem = syncService.getMembershipClock('message', 'm-a-2')
        expect(mem?.parentId).toBe('t-a-2')
        const rc = (op.payload as Record<string, unknown>).replacementClock as {
          timestamp: number
          operationId: string
        }
        expect(mem?.timestamp).toBe(rc.timestamp)
        expect(
          handle.sqlite.prepare(`SELECT * FROM sync_stable_replace_register WHERE message_id='m-a-2'`).get()
        ).toBeDefined()
        expect(syncService.getParentFrame('topicMessage', 't-a-2')).not.toBeNull()
        expect(syncService.getParentFrame('messageBlock', 'm-a-2')).not.toBeNull()
      } finally {
        await new Promise<void>((resolve) => {
          try {
            server.close(() => resolve())
          } catch {
            resolve()
          }
        })
        try {
          relayDb.close()
        } catch {}
      }
    }

    try {
      await relayRoundTrip({ sqlite: sqliteBMissing, db: dbBMissing }, 'device-B-adopt-missing', false)
      await relayRoundTrip({ sqlite: sqliteBUnversioned, db: dbBUnversioned }, 'device-B-adopt-unversioned', true)
    } finally {
      try {
        sqliteBMissing.close()
      } catch {}
      try {
        sqliteBUnversioned.close()
      } catch {}
      bindCurrent()
    }
  })

  it('existing target membership is preserved and monotonic; parent mismatch rolls back', () => {
    seedVersionedUser('t-a-3', 'u-a-3')
    seedVersionedAssistant('t-a-3', 'm-a-3', 'u-a-3', 'b-a3-old')
    db.delete(schema.syncOutbox).run()
    const origMem = syncService.getMembershipClock('message', 'm-a-3')
    expect(origMem?.parentId).toBe('t-a-3')
    const resetMsg = { id: 'm-a-3', topicId: 't-a-3', role: 'assistant', status: 'pending', askId: 'u-a-3' } as never
    const res = agg.resetMessagesForResend('t-a-3', [{ message: resetMsg, blocks: [] } as never], ['b-a3-old'])
    expect(res.ok).toBe(true)
    const attemptId = ((res as { ok: true; value: unknown }).value as { attempts: Array<{ attemptId: string }> })
      .attempts[0].attemptId
    db.delete(schema.syncOutbox).run()
    expect(
      agg.bulkAddBlocks(
        [{ id: 'b-a3-n1', messageId: 'm-a-3', type: 'main_text', content: 'v2', status: 'success' } as never],
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-a-3', 'm-a-3', { status: 'success', content: 'v2 final' } as never, {
        resendAttemptId: attemptId
      }).ok
    ).toBe(true)
    const rows = stableReplaceRows()
    expect(rows).toHaveLength(1)
    const op = readOp(rows[0])
    const payload = op.payload as Record<string, unknown>
    const rc = payload.replacementClock as { timestamp: number; operationId: string }
    // Existing membership is not rewritten to the replacement clock.
    expect((payload.message as Record<string, unknown>).parentMembershipClock).toEqual({
      timestamp: origMem!.timestamp,
      operationId: origMem!.operationId
    })
    const afterMem = syncService.getMembershipClock('message', 'm-a-3')
    expect(afterMem).toEqual(origMem)
    expect(rc.timestamp).toBeGreaterThan(origMem!.timestamp)

    // Parent mismatch: corrupt the retained membership parent, then a new
    // reset+final must roll back with the intent retained and zero op.
    seedVersionedUser('t-a-4', 'u-a-4')
    seedVersionedAssistant('t-a-4', 'm-a-4', 'u-a-4', 'b-a4-old')
    db.delete(schema.syncOutbox).run()
    sqlite.prepare(`UPDATE sync_membership_clock SET parent_id='t-foreign' WHERE child_entity_id='m-a-4'`).run()
    const resetMsg4 = { id: 'm-a-4', topicId: 't-a-4', role: 'assistant', status: 'pending', askId: 'u-a-4' } as never
    const res4 = agg.resetMessagesForResend('t-a-4', [{ message: resetMsg4, blocks: [] } as never], ['b-a4-old'])
    expect(res4.ok).toBe(true)
    const attempt4 = ((res4 as { ok: true; value: unknown }).value as { attempts: Array<{ attemptId: string }> })
      .attempts[0].attemptId
    db.delete(schema.syncOutbox).run()
    expect(
      agg.bulkAddBlocks(
        [{ id: 'b-a4-n1', messageId: 'm-a-4', type: 'main_text', content: 'x', status: 'success' } as never],
        { resendAttemptId: attempt4 }
      ).ok
    ).toBe(true)
    const bad = agg.updateMessage('t-a-4', 'm-a-4', { status: 'success', content: 'final' } as never, {
      resendAttemptId: attempt4
    })
    expect(bad.ok).toBe(false)
    expect(stableReplaceRows()).toHaveLength(0)
    expect(getIntentRow('m-a-4')).toBeDefined()
    expect((sqlite.prepare(`SELECT status FROM messages WHERE id='m-a-4'`).get() as { status: string }).status).toBe(
      'pending'
    )
  })

  it('another stable sibling without membership keeps the final local-only with zero partial writes', () => {
    seedVersionedUser('t-a-5', 'u-a-5')
    seedVersionedAssistant('t-a-5', 'm-a-5', 'u-a-5', 'b-a5-old')
    insertUnversionedMessage('t-a-5', 'm-sib-missing', 'u-a-5')
    db.delete(schema.syncOutbox).run()
    const resetMsg = { id: 'm-a-5', topicId: 't-a-5', role: 'assistant', status: 'pending', askId: 'u-a-5' } as never
    const res = agg.resetMessagesForResend('t-a-5', [{ message: resetMsg, blocks: [] } as never], ['b-a5-old'])
    expect(res.ok).toBe(true)
    const attemptId = ((res as { ok: true; value: unknown }).value as { attempts: Array<{ attemptId: string }> })
      .attempts[0].attemptId
    db.delete(schema.syncOutbox).run()
    expect(
      agg.bulkAddBlocks(
        [{ id: 'b-a5-n1', messageId: 'm-a-5', type: 'main_text', content: 'new', status: 'success' } as never],
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-a-5', 'm-a-5', { status: 'success', content: 'final' } as never, {
        resendAttemptId: attemptId
      }).ok
    ).toBe(true)
    expect(stableReplaceRows()).toHaveLength(0)
    expect(getIntentRow('m-a-5')).toBeDefined()
    // Zero partial writes: no register, no new frames, no outbox, sibling still missing.
    expect(sqlite.prepare(`SELECT * FROM sync_stable_replace_register WHERE message_id='m-a-5'`).get()).toBeUndefined()
    expect(sqlite.prepare(`SELECT * FROM sync_outbox`).all()).toHaveLength(0)
    expect(syncService.getMembershipClock('message', 'm-sib-missing')).toBeNull()
    expect(syncService.getParentFrame('topicMessage', 't-a-5')).toBeNull()
  })

  it('adoption negatives stay local-only: non-success, unsupported, stale', () => {
    // Non-success final does not adopt.
    seedVersionedUser('t-a-6', 'u-a-6')
    insertUnversionedMessage('t-a-6', 'm-a-6', 'u-a-6')
    db.delete(schema.syncOutbox).run()
    const reset6 = { id: 'm-a-6', topicId: 't-a-6', role: 'assistant', status: 'pending', askId: 'u-a-6' } as never
    const res6 = agg.resetMessagesForResend('t-a-6', [{ message: reset6, blocks: [] } as never], [])
    expect(res6.ok).toBe(true)
    const attempt6 = ((res6 as { ok: true; value: unknown }).value as { attempts: Array<{ attemptId: string }> })
      .attempts[0].attemptId
    db.delete(schema.syncOutbox).run()
    expect(
      agg.updateMessage('t-a-6', 'm-a-6', { status: 'streaming', content: 'partial' } as never, {
        resendAttemptId: attempt6
      }).ok
    ).toBe(true)
    expect(stableReplaceRows()).toHaveLength(0)
    expect(getIntentRow('m-a-6')).toBeDefined()
    expect(syncService.getMembershipClock('message', 'm-a-6')).toBeNull()

    // Unsupported block does not adopt.
    seedVersionedUser('t-a-7', 'u-a-7')
    insertUnversionedMessage('t-a-7', 'm-a-7', 'u-a-7')
    db.delete(schema.syncOutbox).run()
    const reset7 = { id: 'm-a-7', topicId: 't-a-7', role: 'assistant', status: 'pending', askId: 'u-a-7' } as never
    const res7 = agg.resetMessagesForResend('t-a-7', [{ message: reset7, blocks: [] } as never], [])
    expect(res7.ok).toBe(true)
    const attempt7 = ((res7 as { ok: true; value: unknown }).value as { attempts: Array<{ attemptId: string }> })
      .attempts[0].attemptId
    expect(
      agg.bulkAddBlocks([
        { id: 'b-a7-tool', messageId: 'm-a-7', type: 'tool', content: 'x', status: 'success' } as never
      ]).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-a-7', 'm-a-7', { status: 'success', content: 'done' } as never, {
        resendAttemptId: attempt7
      }).ok
    ).toBe(true)
    expect(stableReplaceRows()).toHaveLength(0)
    expect(getIntentRow('m-a-7')).toBeDefined()
    expect(syncService.getMembershipClock('message', 'm-a-7')).toBeNull()
    db.delete(schema.syncOutbox).run()

    // Stale attempt fails closed with no adoption.
    seedVersionedUser('t-a-8', 'u-a-8')
    insertUnversionedMessage('t-a-8', 'm-a-8', 'u-a-8')
    db.delete(schema.syncOutbox).run()
    const reset8 = { id: 'm-a-8', topicId: 't-a-8', role: 'assistant', status: 'pending', askId: 'u-a-8' } as never
    const res8 = agg.resetMessagesForResend('t-a-8', [{ message: reset8, blocks: [] } as never], [])
    expect(res8.ok).toBe(true)
    db.delete(schema.syncOutbox).run()
    const bad = agg.updateMessage('t-a-8', 'm-a-8', { status: 'success', content: 'stale' } as never, {
      resendAttemptId: 'stale-attempt'
    })
    expect(bad.ok).toBe(false)
    expect(stableReplaceRows()).toHaveLength(0)
    expect(syncService.getMembershipClock('message', 'm-a-8')).toBeNull()
  })

  it('post-mint transaction failure rolls back target membership, outbox, register, frames, and intent clear', () => {
    seedVersionedUser('t-a-9', 'u-a-9')
    seedVersionedAssistant('t-a-9', 'm-sib-9', 'u-a-9', 'b-sib-9')
    insertUnversionedMessage('t-a-9', 'm-a-9', 'u-a-9')
    db.delete(schema.syncOutbox).run()
    const resetMsg = { id: 'm-a-9', topicId: 't-a-9', role: 'assistant', status: 'pending', askId: 'u-a-9' } as never
    const res = agg.resetMessagesForResend('t-a-9', [{ message: resetMsg, blocks: [] } as never], [])
    expect(res.ok).toBe(true)
    const attemptId = ((res as { ok: true; value: unknown }).value as { attempts: Array<{ attemptId: string }> })
      .attempts[0].attemptId
    db.delete(schema.syncOutbox).run()
    expect(
      agg.bulkAddBlocks(
        [{ id: 'b-a9-n1', messageId: 'm-a-9', type: 'main_text', content: 'new', status: 'success' } as never],
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    // Corrupt the intent removed-ids after reset: valid JSON so the CHECK
    // passes, but fail-closed at final parse — after the target mint, forcing
    // a full rollback of the final transaction.
    sqlite.prepare(`UPDATE sync_resend_attempt SET removed_block_ids_json='[123]' WHERE message_id='m-a-9'`).run()
    const bad = agg.updateMessage('t-a-9', 'm-a-9', { status: 'success', content: 'final' } as never, {
      resendAttemptId: attemptId
    })
    expect(bad.ok).toBe(false)
    expect(stableReplaceRows()).toHaveLength(0)
    // Minted target membership rolled back; register/frames absent; intent retained; row still pending.
    expect(syncService.getMembershipClock('message', 'm-a-9')).toBeNull()
    expect(sqlite.prepare(`SELECT * FROM sync_stable_replace_register WHERE message_id='m-a-9'`).get()).toBeUndefined()
    expect(syncService.getParentFrame('topicMessage', 't-a-9')).toBeNull()
    expect(syncService.getParentFrame('messageBlock', 'm-a-9')).toBeNull()
    expect(getIntentRow('m-a-9')).toBeDefined()
    expect((sqlite.prepare(`SELECT status FROM messages WHERE id='m-a-9'`).get() as { status: string }).status).toBe(
      'pending'
    )
    expect(sqlite.prepare(`SELECT * FROM sync_outbox`).all()).toHaveLength(0)
  })
})
