/**
 * Reset-final stable-wide topic-frame completion with ordinary stable
 * sibling supplement.
 *
 * Frame ordered/live inventory covers every stable live non-tombstoned
 * sibling (`isStableMessageStatus`), not success-only: stable non-success
 * siblings with existing same-parent membership are retained unchanged and
 * contribute to the clock floor; every ordinary live stable non-transient
 * sibling (`success`/`error`/`paused`/`sent`/legacy stable) missing topic
 * membership qualifies for supplement when ordinary (no active resend intent,
 * no stable-replace register); intent/register missing stays local-only with
 * zero writes; transient and tombstoned siblings stay excluded;
 * different-parent rolls back; later failure rolls back supplements with
 * intent retained; real-relay convergence; baseline candidate no longer
 * reports `unversioned-membership` for the supplemented topic.
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
import { captureLocalSyncBaselineCandidate } from '../syncBaseline'
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

function siblingUpsertRows(): Array<Record<string, unknown>> {
  return sqlite.prepare(`SELECT * FROM sync_outbox WHERE op='upsert' AND entity_type='message'`).all() as Array<
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

function insertUnversionedMessage(topicId: string, messageId: string, askId: string, status = 'success'): void {
  sqlite
    .prepare(
      `INSERT INTO messages (id, topic_id, role, content, status, ask_id, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,0,'2026-09-12T00:00:00.000Z','2026-09-12T00:00:00.000Z')`
    )
    .run(messageId, topicId, 'assistant', `unversioned ${messageId}`, status, askId)
}

function resetTarget(topicId: string, messageId: string, askId: string, removed: string[] = []): string {
  const resetMsg = { id: messageId, topicId, role: 'assistant', status: 'pending', askId } as never
  const res = agg.resetMessagesForResend(topicId, [{ message: resetMsg, blocks: [] } as never], removed)
  expect(res.ok).toBe(true)
  const attemptId = ((res as { ok: true; value: unknown }).value as { attempts: Array<{ attemptId: string }> })
    .attempts[0].attemptId
  return attemptId
}

describe('reset-final sibling supplement', () => {
  it('supplements missing success sibling with monotonic clocks, frame/register/outbox, dense order', () => {
    seedVersionedUser('t-s-1', 'u-s-1')
    seedVersionedAssistant('t-s-1', 'm-keep-1', 'u-s-1', 'b-keep-1')
    seedVersionedAssistant('t-s-1', 'm-target-1', 'u-s-1', 'b-old-1')
    insertUnversionedMessage('t-s-1', 'm-miss-1', 'u-s-1')
    const keepMemBefore = syncService.getMembershipClock('message', 'm-keep-1')
    expect(keepMemBefore).not.toBeNull()
    expect(syncService.getMembershipClock('message', 'm-miss-1')).toBeNull()
    db.delete(schema.syncOutbox).run()
    const hwTopicBefore = getFrameHighWater(db as never, 'topicMessage', 't-s-1')

    const attemptId = resetTarget('t-s-1', 'm-target-1', 'u-s-1', ['b-old-1'])
    db.delete(schema.syncOutbox).run()
    expect(
      agg.bulkAddBlocks(
        [{ id: 'b-new-1', messageId: 'm-target-1', type: 'main_text', content: 'v2', status: 'success' } as never],
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-s-1', 'm-target-1', { status: 'success', content: 'v2 final' } as never, {
        resendAttemptId: attemptId
      }).ok
    ).toBe(true)

    const supplements = siblingUpsertRows().filter((r) => r.entity_id === 'm-miss-1')
    expect(supplements).toHaveLength(1)
    const sibOp = readOp(supplements[0])
    expect(validateSyncOperationStrict(sibOp)).toBeNull()
    const sibTs = sibOp.timestamp as number
    const sibId = sibOp.id as string
    expect(sibTs).toBeGreaterThan(keepMemBefore!.timestamp)
    expect(sibTs).toBeGreaterThan(hwTopicBefore)
    const sibMem = syncService.getMembershipClock('message', 'm-miss-1')
    expect(sibMem?.parentId).toBe('t-s-1')
    expect(sibMem?.timestamp).toBe(sibTs)
    expect(sibMem?.operationId).toBe(sibId)
    // Existing membership preserved exactly (no rewrite).
    expect(syncService.getMembershipClock('message', 'm-keep-1')).toEqual(keepMemBefore)

    const rows = stableReplaceRows()
    expect(rows).toHaveLength(1)
    const op = readOp(rows[0])
    expect(validateSyncOperationStrict(op)).toBeNull()
    const payload = op.payload as Record<string, unknown>
    const rc = payload.replacementClock as { timestamp: number; operationId: string }
    expect(rc.timestamp).toBeGreaterThan(sibTs)
    expect(op.timestamp).toBe(rc.timestamp)
    expect((payload.topicFrame as Record<string, unknown>).frameClock).toEqual(rc)
    expect((payload.messageFrame as Record<string, unknown>).frameClock).toEqual(rc)
    const ordered = (payload.topicFrame as Record<string, unknown>).orderedChildIds as string[]
    expect(ordered).toContain('m-target-1')
    expect(ordered).toContain('m-miss-1')
    expect(ordered).toContain('m-keep-1')
    // Register/dual frames/intent/dense order.
    expect(getIntentRow('m-target-1')).toBeUndefined()
    const reg = sqlite
      .prepare(`SELECT * FROM sync_stable_replace_register WHERE message_id='m-target-1'`)
      .get() as Record<string, unknown>
    expect(reg.timestamp).toBe(rc.timestamp)
    expect(syncService.getParentFrame('topicMessage', 't-s-1')?.timestamp).toBe(rc.timestamp)
    expect(syncService.getParentFrame('messageBlock', 'm-target-1')?.timestamp).toBe(rc.timestamp)
    const msgOrder = sqlite
      .prepare(`SELECT id, sort_order FROM messages WHERE topic_id='t-s-1' ORDER BY sort_order, id`)
      .all() as Array<{ id: string; sort_order: number }>
    expect(msgOrder.map((r) => r.sort_order)).toEqual(msgOrder.map((_, i) => i))
    const cand1 = captureLocalSyncBaselineCandidate(db as never) as {
      completeness: { reasons: string[] }
      manifest: { unversionedMembershipCount: number }
    }
    expect(cand1.manifest.unversionedMembershipCount).toBe(0)
    expect(cand1.completeness.reasons).not.toContain('unversioned-membership')
  })

  it('missing sibling with active intent stays local-only with zero writes', () => {
    seedVersionedUser('t-s-2', 'u-s-2')
    seedVersionedAssistant('t-s-2', 'm-target-2', 'u-s-2', 'b-old-2')
    // Versioned appends first; unversioned SQL inserts never trigger frame refresh.
    insertUnversionedMessage('t-s-2', 'm-intent-2', 'u-s-2')
    db.delete(schema.syncOutbox).run()
    // Sibling carries its own active resend intent.
    const sibAttempt = resetTarget('t-s-2', 'm-intent-2', 'u-s-2', [])
    expect(getIntentRow('m-intent-2')).toBeDefined()
    void sibAttempt
    db.delete(schema.syncOutbox).run()

    const attemptId = resetTarget('t-s-2', 'm-target-2', 'u-s-2', ['b-old-2'])
    db.delete(schema.syncOutbox).run()
    expect(
      agg.bulkAddBlocks(
        [{ id: 'b-new-2', messageId: 'm-target-2', type: 'main_text', content: 'v2', status: 'success' } as never],
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-s-2', 'm-target-2', { status: 'success', content: 'final' } as never, {
        resendAttemptId: attemptId
      }).ok
    ).toBe(true)
    expect(stableReplaceRows()).toHaveLength(0)
    expect(getIntentRow('m-target-2')).toBeDefined()
    expect(syncService.getMembershipClock('message', 'm-intent-2')).toBeNull()
    expect(sqlite.prepare(`SELECT * FROM sync_outbox`).all()).toHaveLength(0)
    expect(
      sqlite.prepare(`SELECT * FROM sync_stable_replace_register WHERE message_id='m-target-2'`).get()
    ).toBeUndefined()
    expect(syncService.getParentFrame('topicMessage', 't-s-2')).toBeNull()
  })

  it('missing sibling with stable-replace register stays local-only with zero writes', () => {
    seedVersionedUser('t-s-3', 'u-s-3')
    seedVersionedAssistant('t-s-3', 'm-target-3', 'u-s-3', 'b-old-3')
    insertUnversionedMessage('t-s-3', 'm-reg-3', 'u-s-3')
    db.delete(schema.syncOutbox).run()
    sqlite
      .prepare(
        `INSERT INTO sync_stable_replace_register (message_id, timestamp, operation_id, active_block_ids_json, payload_hash) VALUES (?,?,?,?,?)`
      )
      .run('m-reg-3', 100, '11111111-1111-4111-8111-111111111111', '[]', 'h')
    const attemptId = resetTarget('t-s-3', 'm-target-3', 'u-s-3', ['b-old-3'])
    db.delete(schema.syncOutbox).run()
    expect(
      agg.bulkAddBlocks(
        [{ id: 'b-new-3', messageId: 'm-target-3', type: 'main_text', content: 'v2', status: 'success' } as never],
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-s-3', 'm-target-3', { status: 'success', content: 'final' } as never, {
        resendAttemptId: attemptId
      }).ok
    ).toBe(true)
    expect(stableReplaceRows()).toHaveLength(0)
    expect(getIntentRow('m-target-3')).toBeDefined()
    expect(syncService.getMembershipClock('message', 'm-reg-3')).toBeNull()
    expect(sqlite.prepare(`SELECT * FROM sync_outbox`).all()).toHaveLength(0)
  })

  it('missing error sibling is supplemented with monotonic clocks and baseline complete', () => {
    seedVersionedUser('t-s-4', 'u-s-4')
    seedVersionedAssistant('t-s-4', 'm-target-4', 'u-s-4', 'b-old-4')
    insertUnversionedMessage('t-s-4', 'm-err-4', 'u-s-4', 'error')
    db.delete(schema.syncOutbox).run()
    const hwTopicBefore = getFrameHighWater(db as never, 'topicMessage', 't-s-4')
    const attemptId = resetTarget('t-s-4', 'm-target-4', 'u-s-4', ['b-old-4'])
    db.delete(schema.syncOutbox).run()
    expect(
      agg.bulkAddBlocks(
        [{ id: 'b-new-4', messageId: 'm-target-4', type: 'main_text', content: 'v2', status: 'success' } as never],
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-s-4', 'm-target-4', { status: 'success', content: 'final' } as never, {
        resendAttemptId: attemptId
      }).ok
    ).toBe(true)
    // Stable-wide supplement: live `error` missing membership is ordinary
    // stable and now supplemented (not local-only).
    const supplements = siblingUpsertRows().filter((r) => r.entity_id === 'm-err-4')
    expect(supplements).toHaveLength(1)
    const sibOp = readOp(supplements[0])
    expect(validateSyncOperationStrict(sibOp)).toBeNull()
    expect((sibOp.payload as Record<string, unknown>).status).toBe('error')
    const sibTs = sibOp.timestamp as number
    expect(sibTs).toBeGreaterThan(hwTopicBefore)
    const sibMem = syncService.getMembershipClock('message', 'm-err-4')
    expect(sibMem?.parentId).toBe('t-s-4')
    expect(sibMem?.timestamp).toBe(sibTs)
    const rows = stableReplaceRows()
    expect(rows).toHaveLength(1)
    const op = readOp(rows[0])
    expect(validateSyncOperationStrict(op)).toBeNull()
    const payload = op.payload as Record<string, unknown>
    const rc = payload.replacementClock as { timestamp: number; operationId: string }
    expect(rc.timestamp).toBeGreaterThan(sibTs)
    const ordered = (payload.topicFrame as Record<string, unknown>).orderedChildIds as string[]
    expect(ordered).toContain('m-target-4')
    expect(ordered).toContain('m-err-4')
    expect(getIntentRow('m-target-4')).toBeUndefined()
    expect(
      sqlite.prepare(`SELECT * FROM sync_stable_replace_register WHERE message_id='m-target-4'`).get()
    ).toBeDefined()
    expect(syncService.getParentFrame('topicMessage', 't-s-4')?.timestamp).toBe(rc.timestamp)
    // Baseline candidate no longer reports unversioned-membership for the
    // supplemented topic (isolated harness keeps only the orthogonal
    // watermark cause).
    const cand = captureLocalSyncBaselineCandidate(db as never) as {
      completeness: { reasons: string[] }
      manifest: { unversionedMembershipCount: number }
    }
    expect(cand.manifest.unversionedMembershipCount).toBe(0)
    expect(cand.completeness.reasons).not.toContain('unversioned-membership')
  })

  it('error+paused+sent+legacy mixed missing supplement with deterministic clocks/order', () => {
    seedVersionedUser('t-s-4m', 'u-s-4m')
    seedVersionedAssistant('t-s-4m', 'm-keep-4m', 'u-s-4m', 'b-keep-4m')
    seedVersionedAssistant('t-s-4m', 'm-target-4m', 'u-s-4m', 'b-old-4m')
    insertUnversionedMessage('t-s-4m', 'm-err-4m', 'u-s-4m', 'error')
    insertUnversionedMessage('t-s-4m', 'm-paused-4m', 'u-s-4m', 'paused')
    insertUnversionedMessage('t-s-4m', 'm-sent-4m', 'u-s-4m', 'sent')
    insertUnversionedMessage('t-s-4m', 'm-legacy-4m', 'u-s-4m', 'archived')
    // Distinct sort orders for deterministic supplement order: sortOrder ASC
    // then id ASC.
    sqlite.prepare(`UPDATE messages SET sort_order=10 WHERE id='m-err-4m'`).run()
    sqlite.prepare(`UPDATE messages SET sort_order=11 WHERE id='m-paused-4m'`).run()
    sqlite.prepare(`UPDATE messages SET sort_order=12 WHERE id='m-sent-4m'`).run()
    sqlite.prepare(`UPDATE messages SET sort_order=13 WHERE id='m-legacy-4m'`).run()
    const keepMemBefore = syncService.getMembershipClock('message', 'm-keep-4m')
    expect(keepMemBefore).not.toBeNull()
    db.delete(schema.syncOutbox).run()
    const attemptId = resetTarget('t-s-4m', 'm-target-4m', 'u-s-4m', ['b-old-4m'])
    db.delete(schema.syncOutbox).run()
    expect(
      agg.bulkAddBlocks(
        [{ id: 'b-new-4m', messageId: 'm-target-4m', type: 'main_text', content: 'v2', status: 'success' } as never],
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-s-4m', 'm-target-4m', { status: 'success', content: 'final' } as never, {
        resendAttemptId: attemptId
      }).ok
    ).toBe(true)
    const wanted = ['m-err-4m', 'm-paused-4m', 'm-sent-4m', 'm-legacy-4m']
    const sibRows = siblingUpsertRows().filter((r) => wanted.includes(r.entity_id as string))
    expect(sibRows.map((r) => r.entity_id).sort()).toEqual([...wanted].sort())
    const sibOps = sibRows.map((r) => readOp(r))
    for (const sibOp of sibOps) expect(validateSyncOperationStrict(sibOp)).toBeNull()
    const byId = new Map(sibOps.map((o) => [o.entityId as string, o]))
    expect((byId.get('m-err-4m')!.payload as Record<string, unknown>).status).toBe('error')
    expect((byId.get('m-paused-4m')!.payload as Record<string, unknown>).status).toBe('paused')
    expect((byId.get('m-sent-4m')!.payload as Record<string, unknown>).status).toBe('sent')
    expect((byId.get('m-legacy-4m')!.payload as Record<string, unknown>).status).toBe('archived')
    // Deterministic supplement order follows sortOrder then id, with distinct
    // monotonic clocks strictly increasing in that order.
    const orderedSibIds = [...sibOps]
      .sort((a, b) => (a.timestamp as number) - (b.timestamp as number))
      .map((o) => o.entityId as string)
    expect(orderedSibIds).toEqual(['m-err-4m', 'm-paused-4m', 'm-sent-4m', 'm-legacy-4m'])
    const sibTimestamps = sibOps.map((o) => o.timestamp as number)
    expect(new Set(sibTimestamps).size).toBe(sibTimestamps.length)
    const sortedTs = [...sibTimestamps].sort((a, b) => a - b)
    for (let i = 1; i < sortedTs.length; i++) expect(sortedTs[i]).toBeGreaterThan(sortedTs[i - 1])
    for (const id of wanted) {
      const mem = syncService.getMembershipClock('message', id)
      expect(mem?.parentId).toBe('t-s-4m')
      expect(mem?.timestamp).toBe(byId.get(id)!.timestamp)
      expect(mem?.operationId).toBe(byId.get(id)!.id)
    }
    expect(syncService.getMembershipClock('message', 'm-keep-4m')).toEqual(keepMemBefore)
    const rows = stableReplaceRows()
    expect(rows).toHaveLength(1)
    const op = readOp(rows[0])
    expect(validateSyncOperationStrict(op)).toBeNull()
    const payload = op.payload as Record<string, unknown>
    const rc = payload.replacementClock as { timestamp: number; operationId: string }
    for (const ts of sibTimestamps) expect(rc.timestamp).toBeGreaterThan(ts)
    const ordered = (payload.topicFrame as Record<string, unknown>).orderedChildIds as string[]
    for (const id of [...wanted, 'm-target-4m', 'm-keep-4m']) expect(ordered).toContain(id)
    const cand = captureLocalSyncBaselineCandidate(db as never) as {
      completeness: { reasons: string[] }
      manifest: { unversionedMembershipCount: number }
    }
    expect(cand.manifest.unversionedMembershipCount).toBe(0)
    expect(cand.completeness.reasons).not.toContain('unversioned-membership')
  })

  it('missing non-success sibling with intent/register stays local-only with zero writes', () => {
    seedVersionedUser('t-s-4n', 'u-s-4n')
    seedVersionedAssistant('t-s-4n', 'm-target-4n', 'u-s-4n', 'b-old-4n')
    insertUnversionedMessage('t-s-4n', 'm-err-4n', 'u-s-4n', 'error')
    insertUnversionedMessage('t-s-4n', 'm-paused-4n', 'u-s-4n', 'paused')
    db.delete(schema.syncOutbox).run()
    // Paused sibling carries its own active resend intent; error sibling
    // carries a stable-replace register. Both force local-only before any
    // supplement write.
    expect(resetTarget('t-s-4n', 'm-paused-4n', 'u-s-4n', [])).toBeDefined()
    expect(getIntentRow('m-paused-4n')).toBeDefined()
    sqlite
      .prepare(
        `INSERT INTO sync_stable_replace_register (message_id, timestamp, operation_id, active_block_ids_json, payload_hash) VALUES (?,?,?,?,?)`
      )
      .run('m-err-4n', 100, '11111111-1111-4111-8111-111111111111', '[]', 'h')
    const attemptId = resetTarget('t-s-4n', 'm-target-4n', 'u-s-4n', ['b-old-4n'])
    db.delete(schema.syncOutbox).run()
    expect(
      agg.bulkAddBlocks(
        [{ id: 'b-new-4n', messageId: 'm-target-4n', type: 'main_text', content: 'v2', status: 'success' } as never],
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-s-4n', 'm-target-4n', { status: 'success', content: 'final' } as never, {
        resendAttemptId: attemptId
      }).ok
    ).toBe(true)
    expect(stableReplaceRows()).toHaveLength(0)
    expect(getIntentRow('m-target-4n')).toBeDefined()
    expect(syncService.getMembershipClock('message', 'm-err-4n')).toBeNull()
    expect(syncService.getMembershipClock('message', 'm-paused-4n')).toBeNull()
    expect(sqlite.prepare(`SELECT * FROM sync_outbox`).all()).toHaveLength(0)
    expect(
      sqlite.prepare(`SELECT * FROM sync_stable_replace_register WHERE message_id='m-target-4n'`).get()
    ).toBeUndefined()
  })

  it('tombstoned missing siblings stay excluded while the final issues', () => {
    seedVersionedUser('t-s-4b', 'u-s-4b')
    seedVersionedAssistant('t-s-4b', 'm-target-4b', 'u-s-4b', 'b-old-4b')
    insertUnversionedMessage('t-s-4b', 'm-tomb-4b', 'u-s-4b', 'success')
    // Appends already done; SQL inserts above never trigger frame refresh.
    sqlite
      .prepare(`INSERT INTO sync_state (key, value) VALUES (?,?)`)
      .run('tombstone:message:m-tomb-4b', '100:op-tomb-4b')
    db.delete(schema.syncOutbox).run()
    const attemptId = resetTarget('t-s-4b', 'm-target-4b', 'u-s-4b', ['b-old-4b'])
    db.delete(schema.syncOutbox).run()
    expect(
      agg.bulkAddBlocks(
        [{ id: 'b-new-4b', messageId: 'm-target-4b', type: 'main_text', content: 'v2', status: 'success' } as never],
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-s-4b', 'm-target-4b', { status: 'success', content: 'final' } as never, {
        resendAttemptId: attemptId
      }).ok
    ).toBe(true)
    const rows = stableReplaceRows()
    expect(rows).toHaveLength(1)
    const op = readOp(rows[0])
    const payload = op.payload as Record<string, unknown>
    const ordered = (payload.topicFrame as Record<string, unknown>).orderedChildIds as string[]
    expect(ordered).not.toContain('m-tomb-4b')
    expect(ordered).toContain('m-target-4b')
    expect(syncService.getMembershipClock('message', 'm-tomb-4b')).toBeNull()
    expect(siblingUpsertRows().filter((r) => r.entity_id === 'm-tomb-4b')).toHaveLength(0)
  })

  it('versioned error/paused/sent siblings are preserved in frame and clock floor', () => {
    seedVersionedUser('t-s-4c', 'u-s-4c')
    seedVersionedAssistant('t-s-4c', 'm-keep-4c', 'u-s-4c', 'b-keep-4c')
    seedVersionedAssistant('t-s-4c', 'm-target-4c', 'u-s-4c', 'b-old-4c')
    seedVersionedAssistant('t-s-4c', 'm-err-4c', 'u-s-4c', 'b-err-4c')
    seedVersionedAssistant('t-s-4c', 'm-paused-4c', 'u-s-4c', 'b-paused-4c')
    seedVersionedAssistant('t-s-4c', 'm-sent-4c', 'u-s-4c', 'b-sent-4c')
    // Flip to stable non-success checkpoints after versioning so each keeps a
    // valid same-parent membership while reading as error/paused/sent.
    sqlite.prepare(`UPDATE messages SET status='error' WHERE id='m-err-4c'`).run()
    sqlite.prepare(`UPDATE messages SET status='paused' WHERE id='m-paused-4c'`).run()
    sqlite.prepare(`UPDATE messages SET status='sent' WHERE id='m-sent-4c'`).run()
    const errMemBefore = syncService.getMembershipClock('message', 'm-err-4c')
    const pausedMemBefore = syncService.getMembershipClock('message', 'm-paused-4c')
    const sentMemBefore = syncService.getMembershipClock('message', 'm-sent-4c')
    const keepMemBefore = syncService.getMembershipClock('message', 'm-keep-4c')
    expect(errMemBefore?.parentId).toBe('t-s-4c')
    expect(pausedMemBefore?.parentId).toBe('t-s-4c')
    expect(sentMemBefore?.parentId).toBe('t-s-4c')
    db.delete(schema.syncOutbox).run()
    const attemptId = resetTarget('t-s-4c', 'm-target-4c', 'u-s-4c', ['b-old-4c'])
    db.delete(schema.syncOutbox).run()
    expect(
      agg.bulkAddBlocks(
        [{ id: 'b-new-4c', messageId: 'm-target-4c', type: 'main_text', content: 'v2', status: 'success' } as never],
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-s-4c', 'm-target-4c', { status: 'success', content: 'final' } as never, {
        resendAttemptId: attemptId
      }).ok
    ).toBe(true)
    const rows = stableReplaceRows()
    expect(rows).toHaveLength(1)
    const op = readOp(rows[0])
    const payload = op.payload as Record<string, unknown>
    const ordered = (payload.topicFrame as Record<string, unknown>).orderedChildIds as string[]
    expect(ordered).toContain('m-target-4c')
    expect(ordered).toContain('m-keep-4c')
    expect(ordered).toContain('m-err-4c')
    expect(ordered).toContain('m-paused-4c')
    expect(ordered).toContain('m-sent-4c')
    // Retained unchanged: no supplement upsert, membership clocks preserved
    // exactly, replacement clock strictly above the preserved floor.
    expect(siblingUpsertRows().filter((r) => r.entity_id === 'm-err-4c')).toHaveLength(0)
    expect(siblingUpsertRows().filter((r) => r.entity_id === 'm-paused-4c')).toHaveLength(0)
    expect(siblingUpsertRows().filter((r) => r.entity_id === 'm-sent-4c')).toHaveLength(0)
    expect(syncService.getMembershipClock('message', 'm-err-4c')).toEqual(errMemBefore)
    expect(syncService.getMembershipClock('message', 'm-paused-4c')).toEqual(pausedMemBefore)
    expect(syncService.getMembershipClock('message', 'm-sent-4c')).toEqual(sentMemBefore)
    expect(syncService.getMembershipClock('message', 'm-keep-4c')).toEqual(keepMemBefore)
    const rc = payload.replacementClock as { timestamp: number; operationId: string }
    expect(rc.timestamp).toBeGreaterThan(errMemBefore!.timestamp)
    expect(rc.timestamp).toBeGreaterThan(pausedMemBefore!.timestamp)
    expect(rc.timestamp).toBeGreaterThan(sentMemBefore!.timestamp)
    expect(syncService.getParentFrame('topicMessage', 't-s-4c')?.timestamp).toBe(rc.timestamp)
  })

  it('existing sibling different-parent membership rolls back the whole tx', () => {
    seedVersionedUser('t-s-5', 'u-s-5')
    seedVersionedAssistant('t-s-5', 'm-sib-5', 'u-s-5', 'b-sib-5')
    seedVersionedAssistant('t-s-5', 'm-target-5', 'u-s-5', 'b-old-5')
    insertUnversionedMessage('t-s-5', 'm-miss-5', 'u-s-5')
    // All versioned appends precede SQL inserts.
    db.delete(schema.syncOutbox).run()
    sqlite.prepare(`UPDATE sync_membership_clock SET parent_id='t-foreign' WHERE child_entity_id='m-sib-5'`).run()
    const attemptId = resetTarget('t-s-5', 'm-target-5', 'u-s-5', ['b-old-5'])
    db.delete(schema.syncOutbox).run()
    expect(
      agg.bulkAddBlocks(
        [{ id: 'b-new-5', messageId: 'm-target-5', type: 'main_text', content: 'v2', status: 'success' } as never],
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    const bad = agg.updateMessage('t-s-5', 'm-target-5', { status: 'success', content: 'final' } as never, {
      resendAttemptId: attemptId
    })
    expect(bad.ok).toBe(false)
    expect(stableReplaceRows()).toHaveLength(0)
    expect(sqlite.prepare(`SELECT * FROM sync_outbox`).all()).toHaveLength(0)
    expect(syncService.getMembershipClock('message', 'm-miss-5')).toBeNull()
    expect(getIntentRow('m-target-5')).toBeDefined()
    expect(
      (sqlite.prepare(`SELECT status FROM messages WHERE id='m-target-5'`).get() as { status: string }).status
    ).toBe('pending')
  })

  it('post-supplement failure rolls back sibling upserts/memberships and retains intent', () => {
    seedVersionedUser('t-s-6', 'u-s-6')
    seedVersionedAssistant('t-s-6', 'm-keep-6', 'u-s-6', 'b-keep-6')
    seedVersionedAssistant('t-s-6', 'm-target-6', 'u-s-6', 'b-old-6')
    insertUnversionedMessage('t-s-6', 'm-miss-6', 'u-s-6')
    db.delete(schema.syncOutbox).run()
    const attemptId = resetTarget('t-s-6', 'm-target-6', 'u-s-6', ['b-old-6'])
    db.delete(schema.syncOutbox).run()
    expect(
      agg.bulkAddBlocks(
        [{ id: 'b-new-6', messageId: 'm-target-6', type: 'main_text', content: 'v2', status: 'success' } as never],
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    sqlite.prepare(`UPDATE sync_resend_attempt SET removed_block_ids_json='[123]' WHERE message_id='m-target-6'`).run()
    const bad = agg.updateMessage('t-s-6', 'm-target-6', { status: 'success', content: 'final' } as never, {
      resendAttemptId: attemptId
    })
    expect(bad.ok).toBe(false)
    expect(stableReplaceRows()).toHaveLength(0)
    expect(sqlite.prepare(`SELECT * FROM sync_outbox`).all()).toHaveLength(0)
    expect(syncService.getMembershipClock('message', 'm-miss-6')).toBeNull()
    expect(
      sqlite.prepare(`SELECT * FROM sync_stable_replace_register WHERE message_id='m-target-6'`).get()
    ).toBeUndefined()
    expect(syncService.getParentFrame('topicMessage', 't-s-6')).toBeNull()
    expect(getIntentRow('m-target-6')).toBeDefined()
  })

  it('real-relay receiver converges sibling upsert + stable replace with dense order and no local edit', async () => {
    seedVersionedUser('t-s-7', 'u-s-7')
    seedVersionedAssistant('t-s-7', 'm-keep-7', 'u-s-7', 'b-keep-7')
    seedVersionedAssistant('t-s-7', 'm-target-7', 'u-s-7', 'b-old-7')
    insertUnversionedMessage('t-s-7', 'm-miss-7', 'u-s-7')
    db.delete(schema.syncOutbox).run()
    const attemptId = resetTarget('t-s-7', 'm-target-7', 'u-s-7', ['b-old-7'])
    db.delete(schema.syncOutbox).run()
    expect(
      agg.bulkAddBlocks(
        [{ id: 'b-new-7', messageId: 'm-target-7', type: 'main_text', content: 'relayed', status: 'success' } as never],
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-s-7', 'm-target-7', { status: 'success', content: 'relayed' } as never, {
        resendAttemptId: attemptId
      }).ok
    ).toBe(true)
    const outboxOps = sqlite.prepare(`SELECT * FROM sync_outbox ORDER BY timestamp, id`).all() as Array<
      Record<string, unknown>
    >
    const sibRow = outboxOps.find((r) => r.entity_id === 'm-miss-7')
    const repRow = outboxOps.find((r) => r.op === 'message_stable_replace')
    expect(sibRow).toBeDefined()
    expect(repRow).toBeDefined()
    const sibOp = readOp(sibRow!)
    const repOp = readOp(repRow!)
    expect(validateSyncOperationStrict(sibOp)).toBeNull()
    expect(validateSyncOperationStrict(repOp)).toBeNull()
    expect(repOp.timestamp as number).toBeGreaterThan(sibOp.timestamp as number)
    const opDeviceId = repOp.deviceId as string

    const sqliteB = openInMemory()
    const dbB = drizzle(sqliteB, { schema })
    runMigrations(dbB as never, sqliteB)
    const relayDb = new Database(':memory:')
    ensureRelaySchema(relayDb)
    const { createRelayServer } = await import('../../../../../scripts/sync-relay/server')
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
      const regB = await register('device-B-sib-supplement')
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
        body: JSON.stringify({ deviceId: opDeviceId, operations: [sibOp, repOp] })
      })
      expect(pushRes.status).toBe(200)

      ;(chatDbService as never as { sqlite: unknown }).sqlite = sqliteB
      ;(chatDbService as never as { db: unknown }).db = dbB
      syncService.clearAllForTests()
      seedRegisteredAttachedSyncService(configStore, dbB)
      const bAgg = new ChatDbAggregateService(dbB, sqliteB)
      expect(
        bAgg.appendMessage(
          't-s-7',
          { id: 'u-s-7', topicId: 't-s-7', role: 'user', content: 'q', status: 'success' } as never,
          []
        ).ok
      ).toBe(true)
      expect(
        bAgg.appendMessage(
          't-s-7',
          {
            id: 'm-keep-7',
            topicId: 't-s-7',
            role: 'assistant',
            content: 'old answer',
            status: 'success',
            askId: 'u-s-7'
          } as never,
          [
            {
              id: 'b-keep-7',
              messageId: 'm-keep-7',
              type: 'main_text',
              content: 'old answer',
              status: 'success'
            } as never
          ]
        ).ok
      ).toBe(true)
      // B holds the target as unversioned (row without clocks/membership) so
      // A's replacementClock wins without wall-skew LWW loss; B has no miss row.
      sqliteB
        .prepare(
          `INSERT INTO messages (id, topic_id, role, content, status, ask_id, sort_order, created_at, updated_at) VALUES ('m-target-7','t-s-7','assistant','old answer','success','u-s-7',2,'2026-09-12T00:00:00.000Z','2026-09-12T00:00:00.000Z')`
        )
        .run()
      dbB.delete(schema.syncOutbox).run()

      const pullRes = await fetch(
        `${base}/sync/pull?cursor=0&deviceId=${encodeURIComponent('device-B-sib-supplement')}`,
        { headers: authB }
      )
      expect(pullRes.status).toBe(200)
      const pullBody = (await pullRes.json()) as { operations?: Array<Record<string, unknown>> }
      const pulledSib = (pullBody.operations ?? []).find((o) => o.id === sibOp.id)
      const pulledRep = (pullBody.operations ?? []).find((o) => o.id === repOp.id)
      expect(pulledSib).toBeDefined()
      expect(pulledRep).toBeDefined()
      for (const pulled of [pulledSib!, pulledRep!]) {
        const { seq: _seq, ...withoutSeq } = pulled as Record<string, unknown> & { seq?: unknown }
        expect(typeof _seq).toBe('number')
        expect(syncService.applyIncomingOperation(withoutSeq as never)).toBe(true)
      }
      // Receiver converged without a new local edit: supplemented sibling plus
      // replaced target present, dense topic order, register/frames present.
      expect(
        (sqliteB.prepare(`SELECT content FROM messages WHERE id='m-miss-7'`).get() as { content: string }).content
      ).toContain('unversioned')
      expect(
        (sqliteB.prepare(`SELECT content FROM messages WHERE id='m-target-7'`).get() as { content: string }).content
      ).toBe('relayed')
      expect(
        (sqliteB.prepare(`SELECT content FROM message_blocks WHERE id='b-new-7'`).get() as { content: string }).content
      ).toBe('relayed')
      expect(syncService.getMembershipClock('message', 'm-miss-7')?.parentId).toBe('t-s-7')
      expect(syncService.getMembershipClock('message', 'm-target-7')).not.toBeNull()
      expect(
        sqliteB.prepare(`SELECT * FROM sync_stable_replace_register WHERE message_id='m-target-7'`).get()
      ).toBeDefined()
      expect(syncService.getParentFrame('topicMessage', 't-s-7')).not.toBeNull()
      const bOrder = sqliteB
        .prepare(`SELECT id, sort_order FROM messages WHERE topic_id='t-s-7' ORDER BY sort_order, id`)
        .all() as Array<{ id: string; sort_order: number }>
      expect(bOrder.map((r) => r.sort_order)).toEqual(bOrder.map((_, i) => i))
      const bIds = bOrder.map((r) => r.id)
      expect(bIds).toContain('m-miss-7')
      expect(bIds).toContain('m-target-7')
      // No storm: no locally minted stable_replace on B.
      expect(sqliteB.prepare(`SELECT * FROM sync_outbox WHERE op='message_stable_replace'`).all()).toHaveLength(0)
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
      try {
        sqliteB.close()
      } catch {}
      bindCurrent()
    }
  })
})
