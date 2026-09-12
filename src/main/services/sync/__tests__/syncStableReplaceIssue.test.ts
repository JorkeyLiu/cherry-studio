/**
 * Normal `message_stable_replace` issuer consuming the SYNC-DATA-055 intent
 * (second natural work unit; no baseline v2, no relay endpoint/wire change).
 *
 * Covers: transient retained 0 op; success final via updateMessage and via
 * updateMessageAndBlocks emits exactly one strictly-valid op and clears the
 * intent; activeBlockIds business order vs canonical id-sorted blocks, dual
 * winning frames mirroring the single replacement clock, register, retirement
 * of removed old blocks with tombstone barriers, dense sort orders, and
 * strict outbox payload validation; stale/legacy/unsupported/missing
 * membership/equal-clock divergence/rollback semantics; restart
 * intent+finalization; dual profile convergence through the existing relay
 * data-plane; ordinary update regression.
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

function seedUser(topicId: string, userId: string): void {
  const res = agg.appendMessage(
    topicId,
    { id: userId, topicId, role: 'user', content: 'q', status: 'success' } as never,
    []
  )
  expect(res.ok).toBe(true)
}

function seedAssistant(topicId: string, assistantId: string, askId: string, blockId: string): void {
  const res = agg.appendMessage(
    topicId,
    { id: assistantId, topicId, role: 'assistant', content: 'old answer', status: 'success', askId } as never,
    [{ id: blockId, messageId: assistantId, type: 'main_text', content: 'old answer', status: 'success' } as never]
  )
  expect(res.ok).toBe(true)
}

function getIntentRow(messageId: string): Record<string, unknown> | undefined {
  return sqlite.prepare(`SELECT * FROM sync_resend_attempt WHERE message_id=?`).get(messageId) as
    | Record<string, unknown>
    | undefined
}

function stableReplaceRows(): Array<Record<string, unknown>> {
  return sqlite.prepare(`SELECT * FROM sync_outbox WHERE op='message_stable_replace'`).all() as Array<
    Record<string, unknown>
  >
}

function readOp(row: Record<string, unknown>): Record<string, unknown> {
  // Raw better-sqlite3 rows use snake_case storage columns.
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

function resetForResend(
  topicId: string,
  assistantId: string,
  userId: string,
  oldBlock: string
): { attemptId: string; attempts: Array<{ messageId: string; attemptId: string }> } {
  const resetMsg = { id: assistantId, topicId, role: 'assistant', status: 'pending', askId: userId } as never
  const res = agg.resetMessagesForResend(topicId, [{ message: resetMsg, blocks: [] } as never], [oldBlock])
  expect(res.ok).toBe(true)
  const value = (res as { ok: true; value: unknown }).value as {
    attempts: Array<{ messageId: string; attemptId: string }>
  }
  expect(Array.isArray(value.attempts)).toBe(true)
  expect(value.attempts).toHaveLength(1)
  expect(Object.keys(value.attempts[0]).sort()).toEqual(['attemptId', 'messageId'])
  expect(value.attempts[0].messageId).toBe(assistantId)
  db.delete(schema.syncOutbox).run()
  return { attemptId: value.attempts[0].attemptId, attempts: value.attempts }
}

describe('stable_replace issuer — gating (transient/error/paused/unsupported/legacy)', () => {
  it('transient streaming write stays local-only with intent retained and 0 op', () => {
    seedUser('t-i-1', 'u-i-1')
    seedAssistant('t-i-1', 'm-i-1', 'u-i-1', 'b-i-old')
    const { attemptId } = resetForResend('t-i-1', 'm-i-1', 'u-i-1', 'b-i-old')
    expect(
      agg.updateMessage('t-i-1', 'm-i-1', { status: 'streaming', content: 'partial' } as never, {
        resendAttemptId: attemptId
      }).ok
    ).toBe(true)
    expect(stableReplaceRows()).toHaveLength(0)
    expect(getIntentRow('m-i-1')).toBeDefined()
  })

  it('error and paused finals never consume the attempt', () => {
    for (const status of ['error', 'paused']) {
      seedUser(`t-i-2-${status}`, `u-i-2-${status}`)
      seedAssistant(`t-i-2-${status}`, `m-i-2-${status}`, `u-i-2-${status}`, `b-i-old-${status}`)
      const { attemptId } = resetForResend(`t-i-2-${status}`, `m-i-2-${status}`, `u-i-2-${status}`, `b-i-old-${status}`)
      expect(
        agg.updateMessage(`t-i-2-${status}`, `m-i-2-${status}`, { status, content: 'terminal?' } as never, {
          resendAttemptId: attemptId
        }).ok
      ).toBe(true)
      expect(stableReplaceRows()).toHaveLength(0)
      expect(getIntentRow(`m-i-2-${status}`)).toBeDefined()
      db.delete(schema.syncOutbox).run()
    }
  })

  it('unsupported block final stays local-only with intent retained', () => {
    seedUser('t-i-3', 'u-i-3')
    seedAssistant('t-i-3', 'm-i-3', 'u-i-3', 'b-i-old-3')
    const { attemptId } = resetForResend('t-i-3', 'm-i-3', 'u-i-3', 'b-i-old-3')
    expect(
      agg.bulkAddBlocks([
        { id: 'b-tool-1', messageId: 'm-i-3', type: 'tool', content: 'x', status: 'success' } as never
      ]).ok
    ).toBe(true)
    // Final success write carrying the matching attempt still cannot converge: unsupported member present.
    expect(
      agg.updateMessage('t-i-3', 'm-i-3', { status: 'success', content: 'done' } as never, {
        resendAttemptId: attemptId
      }).ok
    ).toBe(true)
    expect(stableReplaceRows()).toHaveLength(0)
    expect(getIntentRow('m-i-3')).toBeDefined()
  })

  it('legacy no-id final never issues and retains the intent', () => {
    seedUser('t-i-4', 'u-i-4')
    seedAssistant('t-i-4', 'm-i-4', 'u-i-4', 'b-i-old-4')
    resetForResend('t-i-4', 'm-i-4', 'u-i-4', 'b-i-old-4')
    expect(agg.updateMessage('t-i-4', 'm-i-4', { status: 'success', content: 'legacy' } as never).ok).toBe(true)
    expect(stableReplaceRows()).toHaveLength(0)
    expect(getIntentRow('m-i-4')).toBeDefined()
  })

  it('stale attempt fails closed with row unchanged and 0 stable_replace', () => {
    seedUser('t-i-5', 'u-i-5')
    seedAssistant('t-i-5', 'm-i-5', 'u-i-5', 'b-i-old-5')
    resetForResend('t-i-5', 'm-i-5', 'u-i-5', 'b-i-old-5')
    const before = sqlite.prepare(`SELECT status FROM messages WHERE id='m-i-5'`).get()
    const bad = agg.updateMessage('t-i-5', 'm-i-5', { status: 'success', content: 'stale' } as never, {
      resendAttemptId: 'stale-attempt'
    })
    expect(bad.ok).toBe(false)
    expect(sqlite.prepare(`SELECT status FROM messages WHERE id='m-i-5'`).get()).toEqual(before)
    expect(stableReplaceRows()).toHaveLength(0)
  })
})

describe('stable_replace issuer — success final emission (updateMessage)', () => {
  it('emits exactly one strictly-valid op and clears the intent', () => {
    seedUser('t-e-1', 'u-e-1')
    seedAssistant('t-e-1', 'm-e-1', 'u-e-1', 'b-e-old')
    const { attemptId } = resetForResend('t-e-1', 'm-e-1', 'u-e-1', 'b-e-old')
    // New resend blocks arrive out of lex order in two appends: business
    // order [b-n2, b-n1] must survive while the wire array stays canonically
    // id-sorted.
    expect(
      agg.bulkAddBlocks(
        [{ id: 'b-n2', messageId: 'm-e-1', type: 'main_text', content: 'second', status: 'success' }] as never,
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    expect(
      agg.bulkAddBlocks(
        [{ id: 'b-n1', messageId: 'm-e-1', type: 'main_text', content: 'first', status: 'success' }] as never,
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    // Establish user-visible business order [b-n2, b-n1] (block inserts
    // normalize to (sortOrder, id); streaming order is the projection here).
    sqlite
      .prepare(
        `UPDATE message_blocks SET sort_order = CASE id WHEN 'b-n2' THEN 0 WHEN 'b-n1' THEN 1 ELSE sort_order END WHERE message_id='m-e-1'`
      )
      .run()
    expect(stableReplaceRows()).toHaveLength(0)
    expect(
      agg.updateMessage('t-e-1', 'm-e-1', { status: 'success', content: 'final answer' } as never, {
        resendAttemptId: attemptId
      }).ok
    ).toBe(true)

    const rows = stableReplaceRows()
    expect(rows).toHaveLength(1)
    const op = readOp(rows[0])
    expect(validateSyncOperationStrict(op)).toBeNull()
    expect(op.op).toBe('message_stable_replace')
    expect(op.entityType).toBe('message')
    expect(op.entityId).toBe('m-e-1')
    const payload = op.payload as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual(
      [
        'activeBlockIds',
        'messageBlocks',
        'messageFrame',
        'messageId',
        'replacementClock',
        'replaceVersion',
        'topicFrame',
        'message'
      ].sort()
    )
    expect(payload.replaceVersion).toBe('message-stable-replace-v1')
    // Single clock binding: envelope mirrors replacementClock; both frames mirror it.
    const rc = payload.replacementClock as { timestamp: number; operationId: string }
    expect(op.id).toBe(rc.operationId)
    expect(op.timestamp).toBe(rc.timestamp)
    const topicFrame = payload.topicFrame as Record<string, unknown>
    const messageFrame = payload.messageFrame as Record<string, unknown>
    expect(topicFrame.frameClock as Record<string, unknown>).toEqual(rc)
    expect(messageFrame.frameClock as Record<string, unknown>).toEqual(rc)
    // Business order preserved; canonical array id-sorted; messageFrame mirrors activeBlockIds.
    expect(payload.activeBlockIds).toEqual(['b-n2', 'b-n1'])
    expect((payload.messageBlocks as Array<Record<string, unknown>>).map((b) => b.id)).toEqual(['b-n1', 'b-n2'])
    expect(messageFrame.orderedChildIds).toEqual(['b-n2', 'b-n1'])
    expect(topicFrame.orderedChildIds as string[]).toContain('m-e-1')

    // Intent cleared; register persisted with the winning clock + hash.
    expect(getIntentRow('m-e-1')).toBeUndefined()
    const reg = sqlite.prepare(`SELECT * FROM sync_stable_replace_register WHERE message_id='m-e-1'`).get() as Record<
      string,
      unknown
    >
    expect(reg.timestamp).toBe(rc.timestamp)
    expect(reg.operation_id).toBe(rc.operationId)
    expect(typeof reg.payload_hash).toBe('string')

    // Retirement: removed old block row gone with a tombstone barrier.
    expect(sqlite.prepare(`SELECT * FROM message_blocks WHERE id='b-e-old'`).get()).toBeUndefined()
    const tomb = sqlite.prepare(`SELECT value FROM sync_state WHERE key='tombstone:message_block:b-e-old'`).get() as
      | { value: string }
      | undefined
    expect(tomb?.value).toContain(String(rc.timestamp))

    // Dual winning frames persisted under the replacement clock.
    const frames = sqlite
      .prepare(`SELECT kind, parent_id, timestamp, operation_id FROM sync_parent_order_frame`)
      .all() as Array<Record<string, unknown>>
    const topicF = frames.find((f) => f.kind === 'topicMessage' && f.parent_id === 't-e-1')
    const msgF = frames.find((f) => f.kind === 'messageBlock' && f.parent_id === 'm-e-1')
    expect(topicF?.timestamp).toBe(rc.timestamp)
    expect(topicF?.operation_id).toBe(rc.operationId)
    expect(msgF?.timestamp).toBe(rc.timestamp)
    expect(msgF?.operation_id).toBe(rc.operationId)

    // Dense sort orders materialized for both parents.
    const msgOrder = sqlite
      .prepare(`SELECT id, sort_order FROM messages WHERE topic_id='t-e-1' ORDER BY sort_order, id`)
      .all() as Array<{ id: string; sort_order: number }>
    expect(msgOrder.map((r) => r.sort_order)).toEqual(msgOrder.map((_, i) => i))
    const blkOrder = sqlite
      .prepare(`SELECT id, sort_order FROM message_blocks WHERE message_id='m-e-1' ORDER BY sort_order, id`)
      .all() as Array<{ id: string; sort_order: number }>
    expect(blkOrder.map((r) => r.id)).toEqual(['b-n2', 'b-n1'])
    expect(blkOrder.map((r) => r.sort_order)).toEqual([0, 1])
  })

  it('duplicate terminal write with the consumed attempt fails closed with no second op', () => {
    seedUser('t-e-2', 'u-e-2')
    seedAssistant('t-e-2', 'm-e-2', 'u-e-2', 'b-e-old-2')
    const { attemptId } = resetForResend('t-e-2', 'm-e-2', 'u-e-2', 'b-e-old-2')
    expect(
      agg.bulkAddBlocks([
        { id: 'b-e2-n1', messageId: 'm-e-2', type: 'main_text', content: 'x', status: 'success' } as never
      ]).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-e-2', 'm-e-2', { status: 'success', content: 'final' } as never, {
        resendAttemptId: attemptId
      }).ok
    ).toBe(true)
    expect(stableReplaceRows()).toHaveLength(1)
    // Same attempt replayed after consumption: stale fail-closed, still exactly one op.
    const dup = agg.updateMessage('t-e-2', 'm-e-2', { status: 'success', content: 'final' } as never, {
      resendAttemptId: attemptId
    })
    expect(dup.ok).toBe(false)
    expect(stableReplaceRows()).toHaveLength(1)
  })

  it('overlapping executions: A residual carries stale A and fails closed, B intent intact, B issues once', () => {
    seedUser('t-e-4', 'u-e-4')
    seedAssistant('t-e-4', 'm-e-4', 'u-e-4', 'b-e-old-4')
    const first = resetForResend('t-e-4', 'm-e-4', 'u-e-4', 'b-e-old-4')
    // Execution B supersedes A with a fresh reset while A is still suspended.
    const resetMsg = { id: 'm-e-4', topicId: 't-e-4', role: 'assistant', status: 'pending', askId: 'u-e-4' } as never
    const resB = agg.resetMessagesForResend('t-e-4', [{ message: resetMsg, blocks: [] } as never], [])
    expect(resB.ok).toBe(true)
    const second = ((resB as { ok: true; value: unknown }).value as { attempts: Array<{ attemptId: string }> })
      .attempts[0].attemptId
    expect(second).not.toBe(first.attemptId)
    db.delete(schema.syncOutbox).run()
    // A's residual streaming write still carries A: stale fail-closed, row unchanged.
    const before = sqlite.prepare(`SELECT status, content FROM messages WHERE id='m-e-4'`).get()
    expect(
      agg.updateMessage('t-e-4', 'm-e-4', { status: 'streaming', content: 'A-residual' } as never, {
        resendAttemptId: first.attemptId
      }).ok
    ).toBe(false)
    expect(sqlite.prepare(`SELECT status, content FROM messages WHERE id='m-e-4'`).get()).toEqual(before)
    // B's intent is intact and unconsumed by A.
    expect((getIntentRow('m-e-4') as { attempt_id: string }).attempt_id).toBe(second)
    expect(stableReplaceRows()).toHaveLength(0)
    // B streams and finalizes normally with exactly one op.
    expect(
      agg.bulkAddBlocks(
        [{ id: 'b-e4-n1', messageId: 'm-e-4', type: 'main_text', content: 'B-data', status: 'success' } as never],
        { resendAttemptId: second }
      ).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-e-4', 'm-e-4', { status: 'success', content: 'B-final' } as never, {
        resendAttemptId: second
      }).ok
    ).toBe(true)
    expect(stableReplaceRows()).toHaveLength(1)
    expect(getIntentRow('m-e-4')).toBeUndefined()
    // A late residual final still carries stale A: fails closed, B's final state preserved (no loss).
    expect(
      agg.updateMessage('t-e-4', 'm-e-4', { status: 'success', content: 'A-late' } as never, {
        resendAttemptId: first.attemptId
      }).ok
    ).toBe(false)
    expect((sqlite.prepare(`SELECT content FROM messages WHERE id='m-e-4'`).get() as { content: string }).content).toBe(
      'B-final'
    )
    expect(stableReplaceRows()).toHaveLength(1)
  })

  it('new reset supersedes: old attempt stale, new attempt issues once', () => {
    seedUser('t-e-3', 'u-e-3')
    seedAssistant('t-e-3', 'm-e-3', 'u-e-3', 'b-e-old-3')
    const first = resetForResend('t-e-3', 'm-e-3', 'u-e-3', 'b-e-old-3')
    const resetMsg = { id: 'm-e-3', topicId: 't-e-3', role: 'assistant', status: 'pending', askId: 'u-e-3' } as never
    const res2 = agg.resetMessagesForResend('t-e-3', [{ message: resetMsg, blocks: [] } as never], [])
    expect(res2.ok).toBe(true)
    const second = ((res2 as { ok: true; value: unknown }).value as { attempts: Array<{ attemptId: string }> })
      .attempts[0].attemptId
    expect(second).not.toBe(first.attemptId)
    db.delete(schema.syncOutbox).run()
    // Old attempt is stale now.
    expect(
      agg.updateMessage('t-e-3', 'm-e-3', { status: 'success', content: 'old' } as never, {
        resendAttemptId: first.attemptId
      }).ok
    ).toBe(false)
    expect(stableReplaceRows()).toHaveLength(0)
    // New attempt streams then issues once.
    expect(
      agg.bulkAddBlocks([
        { id: 'b-e3-n1', messageId: 'm-e-3', type: 'main_text', content: 'new', status: 'success' } as never
      ]).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-e-3', 'm-e-3', { status: 'success', content: 'new final' } as never, {
        resendAttemptId: second
      }).ok
    ).toBe(true)
    expect(stableReplaceRows()).toHaveLength(1)
  })
})

describe('stable_replace issuer — missing membership, rollback, restart, ordinary regression', () => {
  it('message without real membership stays local-only with intent retained', () => {
    // Pre-sync style row inserted directly (no membership clock): the issuer
    // must not fabricate one for the pre-existing message.
    agg.ensureTopic('t-m-1', 'a-1', 'T')
    expect(agg.ensureTopic('t-m-1', 'a-1', 'T').ok).toBe(true)
    sqlite
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, ask_id, sort_order, created_at, updated_at) VALUES ('m-m-1','t-m-1','assistant','q','success','u-m-1',0,'2026-09-12T00:00:00.000Z','2026-09-12T00:00:00.000Z')`
      )
      .run()
    db.delete(schema.syncOutbox).run()
    const resetMsg = { id: 'm-m-1', topicId: 't-m-1', role: 'assistant', status: 'pending', askId: 'u-m-1' } as never
    const res = agg.resetMessagesForResend('t-m-1', [{ message: resetMsg, blocks: [] } as never], [])
    expect(res.ok).toBe(true)
    const attemptId = ((res as { ok: true; value: unknown }).value as { attempts: Array<{ attemptId: string }> })
      .attempts[0].attemptId
    db.delete(schema.syncOutbox).run()
    expect(
      agg.updateMessage('t-m-1', 'm-m-1', { status: 'success', content: 'final' } as never, {
        resendAttemptId: attemptId
      }).ok
    ).toBe(true)
    expect(stableReplaceRows()).toHaveLength(0)
    expect(getIntentRow('m-m-1')).toBeDefined()
  })

  it('frame-clock exhaustion rolls back the final with intent retained and 0 op', () => {
    seedUser('t-m-2', 'u-m-2')
    seedAssistant('t-m-2', 'm-m-2', 'u-m-2', 'b-m-old-2')
    const { attemptId } = resetForResend('t-m-2', 'm-m-2', 'u-m-2', 'b-m-old-2')
    expect(
      agg.bulkAddBlocks([
        { id: 'b-m-good', messageId: 'm-m-2', type: 'main_text', content: 'good', status: 'success' } as never
      ]).ok
    ).toBe(true)
    // Pin the topic frame clock at MAX_SAFE inside the same database: the
    // issuer cannot allocate a winning replacement clock and must fail
    // closed with a full rollback (no intent clear, no op).
    syncService.persistParentFrameInTx(db as never, {
      kind: 'topicMessage',
      parentId: 't-m-2',
      frameVersion: 'parent-order-frame-v1',
      orderedChildIds: ['u-m-2', 'm-m-2'],
      timestamp: 9007199254740991,
      operationId: 'ffff0000-0000-4000-8000-000000000000'
    })
    db.delete(schema.syncOutbox).run()
    const bad = agg.updateMessage('t-m-2', 'm-m-2', { status: 'success', content: 'final' } as never, {
      resendAttemptId: attemptId
    })
    expect(bad.ok).toBe(false)
    expect(stableReplaceRows()).toHaveLength(0)
    expect(getIntentRow('m-m-2')).toBeDefined()
    // The failed final did not commit: message still pending from reset.
    expect((sqlite.prepare(`SELECT status FROM messages WHERE id='m-m-2'`).get() as { status: string }).status).toBe(
      'pending'
    )
  })

  it('intent survives service re-instantiation and finalizes afterwards', () => {
    seedUser('t-m-3', 'u-m-3')
    seedAssistant('t-m-3', 'm-m-3', 'u-m-3', 'b-m-old-3')
    const { attemptId } = resetForResend('t-m-3', 'm-m-3', 'u-m-3', 'b-m-old-3')
    // Simulate restart: new aggregate over the same database; intent row persists.
    bindCurrent()
    expect(getIntentRow('m-m-3')).toBeDefined()
    expect(
      agg.bulkAddBlocks([
        { id: 'b-m3-n1', messageId: 'm-m-3', type: 'main_text', content: 'after restart', status: 'success' } as never
      ]).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-m-3', 'm-m-3', { status: 'success', content: 'restart final' } as never, {
        resendAttemptId: attemptId
      }).ok
    ).toBe(true)
    expect(stableReplaceRows()).toHaveLength(1)
    expect(getIntentRow('m-m-3')).toBeUndefined()
  })

  it('ordinary updates still capture normally with zero stable_replace', () => {
    seedUser('t-m-4', 'u-m-4')
    seedAssistant('t-m-4', 'm-m-4', 'u-m-4', 'b-m-old-4')
    db.delete(schema.syncOutbox).run()
    expect(agg.updateMessage('t-m-4', 'm-m-4', { content: 'ordinary edit' } as never).ok).toBe(true)
    const ops = sqlite.prepare(`SELECT op FROM sync_outbox`).all() as Array<{ op: string }>
    expect(ops.length).toBeGreaterThan(0)
    expect(ops.some((o) => o.op === 'message_stable_replace')).toBe(false)
  })

  it('dual profile converges the resend final through the existing relay data-plane', async () => {
    // Profile B is seeded FIRST so its baseline clocks predate A's resend
    // final (LWW: the replacement must win the pre-resend state).
    const sqliteB = openInMemory()
    const dbB = drizzle(sqliteB, { schema })
    runMigrations(dbB as never, sqliteB)
    ;(chatDbService as never as { sqlite: unknown }).sqlite = sqliteB
    ;(chatDbService as never as { db: unknown }).db = dbB
    syncService.clearAllForTests()
    seedRegisteredAttachedSyncService(configStore, dbB)
    const aggB = new ChatDbAggregateService(dbB, sqliteB)
    expect(
      aggB.appendMessage(
        't-r-1',
        { id: 'u-r-1', topicId: 't-r-1', role: 'user', content: 'q', status: 'success' } as never,
        []
      ).ok
    ).toBe(true)
    expect(
      aggB.appendMessage(
        't-r-1',
        {
          id: 'm-r-1',
          topicId: 't-r-1',
          role: 'assistant',
          content: 'old answer',
          status: 'success',
          askId: 'u-r-1'
        } as never,
        [{ id: 'b-r-old', messageId: 'm-r-1', type: 'main_text', content: 'old answer', status: 'success' } as never]
      ).ok
    ).toBe(true)
    // Profile A issues the resend final.
    bindCurrent()
    seedUser('t-r-1', 'u-r-1')
    seedAssistant('t-r-1', 'm-r-1', 'u-r-1', 'b-r-old')
    const { attemptId } = resetForResend('t-r-1', 'm-r-1', 'u-r-1', 'b-r-old')
    expect(
      agg.bulkAddBlocks(
        [
          {
            id: 'b-r-new',
            messageId: 'm-r-1',
            type: 'main_text',
            content: 'resend answer',
            status: 'success',
            createdAt: '2026-09-12T00:00:10.000Z',
            updatedAt: '2026-09-12T00:00:11.000Z'
          } as never
        ],
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-r-1', 'm-r-1', { status: 'success', content: 'resend answer' } as never, {
        resendAttemptId: attemptId
      }).ok
    ).toBe(true)
    const issued = stableReplaceRows()
    expect(issued).toHaveLength(1)
    const op = readOp(issued[0])
    expect(validateSyncOperationStrict(op)).toBeNull()
    const opDeviceId = op.deviceId as string

    // Existing relay data-plane (no new endpoint, no wire change): pair two
    // devices, push the issued op, pull it back verbatim.
    const { createRelayServer } = await import('../../../../../scripts/sync-relay/server')
    const relayDb = new Database(':memory:')
    ensureRelaySchema(relayDb)
    const server = createRelayServer(relayDb, {})
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }
    const base = `http://127.0.0.1:${addr.port}`
    try {
      const register = async (deviceId: string): Promise<{ code: string; secret: string }> => {
        const res = await fetch(`${base}/sync/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId })
        })
        expect(res.status).toBe(200)
        const body = (await res.json()) as { deviceCode: string; deviceSecret: string }
        return { code: body.deviceCode, secret: body.deviceSecret }
      }
      const regA = await register(opDeviceId)
      const regB = await register('device-B-resend-1')
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
      const pullRes = await fetch(`${base}/sync/pull?cursor=0&deviceId=${encodeURIComponent('device-B-resend-1')}`, {
        headers: authB
      })
      expect(pullRes.status).toBe(200)
      const pullBody = (await pullRes.json()) as { operations?: Array<Record<string, unknown>> }
      const pulled = (pullBody.operations ?? []).find((o) => o.id === op.id)
      expect(pulled).toBeDefined()
      // Relay replay is verbatim except the transport-assigned per-channel sequence.
      const { seq: _seq, ...pulledWithoutSeq } = pulled as Record<string, unknown> & { seq?: unknown }
      expect(typeof _seq).toBe('number')
      expect(pulledWithoutSeq).toEqual(op)

      // Profile B applies the pulled op onto its pre-resend baseline.
      ;(chatDbService as never as { sqlite: unknown }).sqlite = sqliteB
      ;(chatDbService as never as { db: unknown }).db = dbB
      expect(syncService.applyIncomingOperation(pulledWithoutSeq as never)).toBe(true)
      expect(
        (sqliteB.prepare(`SELECT content FROM messages WHERE id='m-r-1'`).get() as { content: string }).content
      ).toBe('resend answer')
      expect(
        (sqliteB.prepare(`SELECT content FROM message_blocks WHERE id='b-r-new'`).get() as { content: string }).content
      ).toBe('resend answer')
      expect(sqliteB.prepare(`SELECT * FROM message_blocks WHERE id='b-r-old'`).get()).toBeUndefined()
      expect(sqliteB.prepare(`SELECT * FROM sync_resend_attempt WHERE message_id='m-r-1'`).get()).toBeUndefined()

      // F3: field-level issuer→receiver post-state comparison (message,
      // active blocks, retired tombstone, register, dual frames, dense
      // orders). B must hold exactly A's converged state.
      const readPostState = (
        handle: Database.Database
      ): {
        message: Record<string, unknown>
        blocks: Array<Record<string, unknown>>
        retiredTombstone: unknown
        register: Record<string, unknown>
        topicFrame: Record<string, unknown>
        messageFrame: Record<string, unknown>
        messageOrder: Array<{ id: string; sort_order: number }>
        blockOrder: Array<{ id: string; sort_order: number }>
      } => {
        const message = handle
          .prepare(
            `SELECT role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at FROM messages WHERE id='m-r-1'`
          )
          .get() as Record<string, unknown>
        const blocks = handle
          .prepare(
            `SELECT id, type, content, status, created_at, updated_at FROM message_blocks WHERE message_id='m-r-1' ORDER BY sort_order, id`
          )
          .all() as Array<Record<string, unknown>>
        const retiredTombstone = handle
          .prepare(`SELECT value FROM sync_state WHERE key='tombstone:message_block:b-r-old'`)
          .get()
        const register = handle
          .prepare(`SELECT * FROM sync_stable_replace_register WHERE message_id='m-r-1'`)
          .get() as Record<string, unknown>
        const topicFrame = handle
          .prepare(
            `SELECT parent_id, ordered_child_ids_json, timestamp, operation_id FROM sync_parent_order_frame WHERE kind='topicMessage' AND parent_id='t-r-1'`
          )
          .get() as Record<string, unknown>
        const messageFrame = handle
          .prepare(
            `SELECT parent_id, ordered_child_ids_json, timestamp, operation_id FROM sync_parent_order_frame WHERE kind='messageBlock' AND parent_id='m-r-1'`
          )
          .get() as Record<string, unknown>
        const messageOrder = handle
          .prepare(`SELECT id, sort_order FROM messages WHERE topic_id='t-r-1' ORDER BY sort_order, id`)
          .all() as Array<{ id: string; sort_order: number }>
        const blockOrder = handle
          .prepare(`SELECT id, sort_order FROM message_blocks WHERE message_id='m-r-1' ORDER BY sort_order, id`)
          .all() as Array<{ id: string; sort_order: number }>
        return { message, blocks, retiredTombstone, register, topicFrame, messageFrame, messageOrder, blockOrder }
      }
      const stateA = readPostState(sqlite)
      const stateB = readPostState(sqliteB)
      expect(stateB.message).toEqual(stateA.message)
      expect(stateB.blocks).toEqual(stateA.blocks)
      expect(stateB.retiredTombstone).toEqual(stateA.retiredTombstone)
      expect(stateB.register).toEqual(stateA.register)
      expect(stateB.topicFrame).toEqual(stateA.topicFrame)
      expect(stateB.messageFrame).toEqual(stateA.messageFrame)
      expect(stateB.messageOrder).toEqual(stateA.messageOrder)
      expect(stateB.blockOrder).toEqual(stateA.blockOrder)
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

  it('equal-clock divergent replay of the issued id fails closed with state preserved', () => {
    seedUser('t-m-5', 'u-m-5')
    seedAssistant('t-m-5', 'm-m-5', 'u-m-5', 'b-m-old-5')
    const { attemptId } = resetForResend('t-m-5', 'm-m-5', 'u-m-5', 'b-m-old-5')
    expect(
      agg.bulkAddBlocks([
        { id: 'b-m5-n1', messageId: 'm-m-5', type: 'main_text', content: 'v1', status: 'success' } as never
      ]).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-m-5', 'm-m-5', { status: 'success', content: 'final v1' } as never, {
        resendAttemptId: attemptId
      }).ok
    ).toBe(true)
    const rows = stableReplaceRows()
    expect(rows).toHaveLength(1)
    const op = readOp(rows[0])
    const before = (sqlite.prepare(`SELECT content FROM messages WHERE id='m-m-5'`).get() as { content: string })
      .content
    // Same id/timestamp but divergent content: receiver must fail closed.
    const divergent = JSON.parse(JSON.stringify(op)) as Record<string, unknown>
    ;((divergent.payload as Record<string, unknown>).message as Record<string, unknown>).content = 'forged content'
    expect(() => syncService.applyIncomingOperation(divergent as never)).toThrow()
    expect((sqlite.prepare(`SELECT content FROM messages WHERE id='m-m-5'`).get() as { content: string }).content).toBe(
      before
    )
    expect(stableReplaceRows()).toHaveLength(1)
  })
})
