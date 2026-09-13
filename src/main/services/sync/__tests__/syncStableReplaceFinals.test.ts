/**
 * Reset/resend target final issuance for exactly `success`/`error`/`paused`.
 *
 * Production gate lives in `SyncService.tryIssueStableReplaceInTx` only:
 * target message must be exactly success/error/paused (sent/legacy/transient
 * stay local-only, intent retained, 0 op); every active block may carry any
 * stable non-transient status already wire-eligible in any mix but must pass
 * the existing type/overflow gate (transient/unsupported stay local-only).
 * Wire/schema/relay/validators/LWW/retirement/frames untouched; no terminal
 * state fabricated; reset intermediate suppression + attempt guards preserved.
 *
 * Covers: each final issues a strict payload with mixed stable-supported
 * blocks; sent/legacy target + transient/unsupported block stay local-only;
 * abort-like SUCCESS + PAUSED/SUCCESS blocks issues; error->success and
 * paused->success LWW wins with stale lower consumed; equal-clock divergent
 * rollback; sibling/rollback/intent/register guards; real-relay dual-profile
 * convergence for error + paused with no echo/storm.
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

function resetForResend(topicId: string, assistantId: string, userId: string, oldBlock: string): { attemptId: string } {
  const resetMsg = { id: assistantId, topicId, role: 'assistant', status: 'pending', askId: userId } as never
  const res = agg.resetMessagesForResend(topicId, [{ message: resetMsg, blocks: [] } as never], [oldBlock])
  expect(res.ok).toBe(true)
  const value = (res as { ok: true; value: unknown }).value as {
    attempts: Array<{ messageId: string; attemptId: string }>
  }
  expect(value.attempts).toHaveLength(1)
  db.delete(schema.syncOutbox).run()
  return { attemptId: value.attempts[0].attemptId }
}

function assertStrictPayload(op: Record<string, unknown>, messageId: string, expectedStatuses: string[]): void {
  expect(validateSyncOperationStrict(op)).toBeNull()
  expect(op.op).toBe('message_stable_replace')
  expect(op.entityType).toBe('message')
  expect(op.entityId).toBe(messageId)
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
  const rc = payload.replacementClock as { timestamp: number; operationId: string }
  expect(op.id).toBe(rc.operationId)
  expect(op.timestamp).toBe(rc.timestamp)
  const topicFrame = payload.topicFrame as Record<string, unknown>
  const messageFrame = payload.messageFrame as Record<string, unknown>
  expect(topicFrame.frameClock).toEqual(rc)
  expect(messageFrame.frameClock).toEqual(rc)
  expect(messageFrame.orderedChildIds).toEqual(payload.activeBlockIds)
  const blocks = payload.messageBlocks as Array<Record<string, unknown>>
  expect(blocks.map((b) => b.status).sort()).toEqual([...expectedStatuses].sort())
  // Canonical id-sorted wire array.
  const ids = blocks.map((b) => b.id as string)
  expect([...ids].sort()).toEqual(ids.slice().sort())
}

describe('reset/resend finals — success/error/paused each issue with mixed blocks', () => {
  it('success target with mixed success/error/paused blocks issues strict payload', () => {
    seedUser('t-f-s', 'u-f-s')
    seedAssistant('t-f-s', 'm-f-s', 'u-f-s', 'b-f-s-old')
    const { attemptId } = resetForResend('t-f-s', 'm-f-s', 'u-f-s', 'b-f-s-old')
    expect(
      agg.bulkAddBlocks(
        [
          { id: 'b-f-s1', messageId: 'm-f-s', type: 'main_text', content: 'a', status: 'success' },
          { id: 'b-f-s2', messageId: 'm-f-s', type: 'main_text', content: 'b', status: 'error' },
          { id: 'b-f-s3', messageId: 'm-f-s', type: 'main_text', content: 'c', status: 'paused' }
        ] as never,
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-f-s', 'm-f-s', { status: 'success', content: 'final' } as never, {
        resendAttemptId: attemptId
      }).ok
    ).toBe(true)
    const rows = stableReplaceRows()
    expect(rows).toHaveLength(1)
    assertStrictPayload(readOp(rows[0]), 'm-f-s', ['success', 'error', 'paused'])
    expect(getIntentRow('m-f-s')).toBeUndefined()
  })

  it('error target with mixed blocks issues strict payload', () => {
    seedUser('t-f-e', 'u-f-e')
    seedAssistant('t-f-e', 'm-f-e', 'u-f-e', 'b-f-e-old')
    const { attemptId } = resetForResend('t-f-e', 'm-f-e', 'u-f-e', 'b-f-e-old')
    expect(
      agg.bulkAddBlocks(
        [
          { id: 'b-f-e1', messageId: 'm-f-e', type: 'main_text', content: 'a', status: 'error' },
          { id: 'b-f-e2', messageId: 'm-f-e', type: 'main_text', content: 'b', status: 'success' }
        ] as never,
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-f-e', 'm-f-e', { status: 'error', content: 'failed' } as never, {
        resendAttemptId: attemptId
      }).ok
    ).toBe(true)
    const rows = stableReplaceRows()
    expect(rows).toHaveLength(1)
    const op = readOp(rows[0])
    assertStrictPayload(op, 'm-f-e', ['error', 'success'])
    expect((op.payload as Record<string, unknown> & { message: { status: string } }).message.status).toBe('error')
    expect(getIntentRow('m-f-e')).toBeUndefined()
  })

  it('paused target via updateMessageAndBlocks with mixed blocks issues strict payload', () => {
    seedUser('t-f-p', 'u-f-p')
    seedAssistant('t-f-p', 'm-f-p', 'u-f-p', 'b-f-p-old')
    const { attemptId } = resetForResend('t-f-p', 'm-f-p', 'u-f-p', 'b-f-p-old')
    expect(
      agg.updateMessageAndBlocks(
        't-f-p',
        { id: 'm-f-p', status: 'paused', content: 'paused final' } as never,
        [
          { id: 'b-f-p1', messageId: 'm-f-p', type: 'main_text', content: 'a', status: 'paused' },
          { id: 'b-f-p2', messageId: 'm-f-p', type: 'main_text', content: 'b', status: 'success' }
        ] as never,
        [],
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    const rows = stableReplaceRows()
    expect(rows).toHaveLength(1)
    const op = readOp(rows[0])
    assertStrictPayload(op, 'm-f-p', ['paused', 'success'])
    expect((op.payload as Record<string, unknown> & { message: { status: string } }).message.status).toBe('paused')
    expect(getIntentRow('m-f-p')).toBeUndefined()
  })
})

describe('reset/resend finals — local-only gates', () => {
  it('sent and legacy targets stay local-only with intent retained', () => {
    for (const status of ['sent', 'legacy-foo']) {
      seedUser(`t-g-${status}`, `u-g-${status}`)
      seedAssistant(`t-g-${status}`, `m-g-${status}`, `u-g-${status}`, `b-g-old-${status}`)
      const { attemptId } = resetForResend(`t-g-${status}`, `m-g-${status}`, `u-g-${status}`, `b-g-old-${status}`)
      expect(
        agg.bulkAddBlocks(
          [
            { id: `b-g-${status}`, messageId: `m-g-${status}`, type: 'main_text', content: 'x', status: 'success' }
          ] as never,
          { resendAttemptId: attemptId }
        ).ok
      ).toBe(true)
      expect(
        agg.updateMessage(`t-g-${status}`, `m-g-${status}`, { status, content: 'no-issue' } as never, {
          resendAttemptId: attemptId
        }).ok
      ).toBe(true)
      expect(stableReplaceRows()).toHaveLength(0)
      expect(getIntentRow(`m-g-${status}`)).toBeDefined()
      db.delete(schema.syncOutbox).run()
    }
  })

  it('transient block stays local-only with intent retained', () => {
    seedUser('t-g-t', 'u-g-t')
    seedAssistant('t-g-t', 'm-g-t', 'u-g-t', 'b-g-t-old')
    const { attemptId } = resetForResend('t-g-t', 'm-g-t', 'u-g-t', 'b-g-t-old')
    expect(
      agg.bulkAddBlocks(
        [{ id: 'b-g-stream', messageId: 'm-g-t', type: 'main_text', content: 'part', status: 'streaming' }] as never,
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-g-t', 'm-g-t', { status: 'error', content: 'no-issue' } as never, {
        resendAttemptId: attemptId
      }).ok
    ).toBe(true)
    expect(stableReplaceRows()).toHaveLength(0)
    expect(getIntentRow('m-g-t')).toBeDefined()
  })

  it('unsupported block stays local-only with intent retained', () => {
    seedUser('t-g-u', 'u-g-u')
    seedAssistant('t-g-u', 'm-g-u', 'u-g-u', 'b-g-u-old')
    const { attemptId } = resetForResend('t-g-u', 'm-g-u', 'u-g-u', 'b-g-u-old')
    expect(
      agg.bulkAddBlocks(
        [{ id: 'b-g-tool', messageId: 'm-g-u', type: 'tool', content: 'x', status: 'paused' }] as never,
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-g-u', 'm-g-u', { status: 'paused', content: 'no-issue' } as never, {
        resendAttemptId: attemptId
      }).ok
    ).toBe(true)
    expect(stableReplaceRows()).toHaveLength(0)
    expect(getIntentRow('m-g-u')).toBeDefined()
  })

  it('abort-like SUCCESS message with PAUSED/SUCCESS blocks now issues', () => {
    seedUser('t-g-a', 'u-g-a')
    seedAssistant('t-g-a', 'm-g-a', 'u-g-a', 'b-g-a-old')
    const { attemptId } = resetForResend('t-g-a', 'm-g-a', 'u-g-a', 'b-g-a-old')
    expect(
      agg.bulkAddBlocks(
        [
          { id: 'b-g-a1', messageId: 'm-g-a', type: 'main_text', content: 'kept', status: 'success' },
          { id: 'b-g-a2', messageId: 'm-g-a', type: 'main_text', content: 'aborted', status: 'paused' }
        ] as never,
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-g-a', 'm-g-a', { status: 'success', content: 'abort-like final' } as never, {
        resendAttemptId: attemptId
      }).ok
    ).toBe(true)
    const rows = stableReplaceRows()
    expect(rows).toHaveLength(1)
    assertStrictPayload(readOp(rows[0]), 'm-g-a', ['success', 'paused'])
    expect(getIntentRow('m-g-a')).toBeUndefined()
  })
})

describe('reset/resend finals — LWW across finals', () => {
  it('error then later success: higher clock wins; stale lower error consumed with no visible change', () => {
    seedUser('t-l-1', 'u-l-1')
    seedAssistant('t-l-1', 'm-l-1', 'u-l-1', 'b-l-old')
    const first = resetForResend('t-l-1', 'm-l-1', 'u-l-1', 'b-l-old')
    expect(
      agg.bulkAddBlocks(
        [{ id: 'b-l-e1', messageId: 'm-l-1', type: 'main_text', content: 'err body', status: 'error' }] as never,
        { resendAttemptId: first.attemptId }
      ).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-l-1', 'm-l-1', { status: 'error', content: 'err final' } as never, {
        resendAttemptId: first.attemptId
      }).ok
    ).toBe(true)
    const errorRows = stableReplaceRows()
    expect(errorRows).toHaveLength(1)
    const errorOp = readOp(errorRows[0])
    expect(validateSyncOperationStrict(errorOp)).toBeNull()

    // Later resend round finalizes success with a strictly higher clock.
    const resetMsg = { id: 'm-l-1', topicId: 't-l-1', role: 'assistant', status: 'pending', askId: 'u-l-1' } as never
    const res2 = agg.resetMessagesForResend('t-l-1', [{ message: resetMsg, blocks: [] } as never], [])
    expect(res2.ok).toBe(true)
    const secondAttempt = ((res2 as { ok: true; value: unknown }).value as { attempts: Array<{ attemptId: string }> })
      .attempts[0].attemptId
    db.delete(schema.syncOutbox).run()
    expect(
      agg.bulkAddBlocks(
        [{ id: 'b-l-s1', messageId: 'm-l-1', type: 'main_text', content: 'good body', status: 'success' }] as never,
        { resendAttemptId: secondAttempt }
      ).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-l-1', 'm-l-1', { status: 'success', content: 'good final' } as never, {
        resendAttemptId: secondAttempt
      }).ok
    ).toBe(true)
    const successRows = stableReplaceRows()
    expect(successRows).toHaveLength(1)
    const successOp = readOp(successRows[0])
    expect(validateSyncOperationStrict(successOp)).toBeNull()
    expect(successOp.timestamp as number).toBeGreaterThan(errorOp.timestamp as number)

    // Stale lower error replay is consumed with no visible change.
    const before = sqlite.prepare(`SELECT content, status FROM messages WHERE id='m-l-1'`).get() as {
      content: string
      status: string
    }
    expect(before).toEqual({ content: 'good final', status: 'success' })
    expect(syncService.applyIncomingOperation(errorOp as never)).toBe(false)
    expect(sqlite.prepare(`SELECT content, status FROM messages WHERE id='m-l-1'`).get()).toEqual(before)
  })

  it('paused then success wins by higher clock', () => {
    seedUser('t-l-2', 'u-l-2')
    seedAssistant('t-l-2', 'm-l-2', 'u-l-2', 'b-l-old-2')
    const first = resetForResend('t-l-2', 'm-l-2', 'u-l-2', 'b-l-old-2')
    expect(
      agg.bulkAddBlocks(
        [{ id: 'b-l-p1', messageId: 'm-l-2', type: 'main_text', content: 'paused body', status: 'paused' }] as never,
        { resendAttemptId: first.attemptId }
      ).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-l-2', 'm-l-2', { status: 'paused', content: 'paused final' } as never, {
        resendAttemptId: first.attemptId
      }).ok
    ).toBe(true)
    const pausedRows = stableReplaceRows()
    expect(pausedRows).toHaveLength(1)
    const pausedOp = readOp(pausedRows[0])

    const resetMsg = { id: 'm-l-2', topicId: 't-l-2', role: 'assistant', status: 'pending', askId: 'u-l-2' } as never
    const res2 = agg.resetMessagesForResend('t-l-2', [{ message: resetMsg, blocks: [] } as never], [])
    expect(res2.ok).toBe(true)
    const secondAttempt = ((res2 as { ok: true; value: unknown }).value as { attempts: Array<{ attemptId: string }> })
      .attempts[0].attemptId
    db.delete(schema.syncOutbox).run()
    expect(
      agg.bulkAddBlocks(
        [{ id: 'b-l-p2', messageId: 'm-l-2', type: 'main_text', content: 'good body', status: 'success' }] as never,
        { resendAttemptId: secondAttempt }
      ).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-l-2', 'm-l-2', { status: 'success', content: 'good final' } as never, {
        resendAttemptId: secondAttempt
      }).ok
    ).toBe(true)
    const successRows = stableReplaceRows()
    expect(successRows).toHaveLength(1)
    const successOp = readOp(successRows[0])
    expect(successOp.timestamp as number).toBeGreaterThan(pausedOp.timestamp as number)
    expect((sqlite.prepare(`SELECT content FROM messages WHERE id='m-l-2'`).get() as { content: string }).content).toBe(
      'good final'
    )
  })

  it('equal-clock divergent replay still rolls back with state preserved', () => {
    seedUser('t-l-3', 'u-l-3')
    seedAssistant('t-l-3', 'm-l-3', 'u-l-3', 'b-l-old-3')
    const { attemptId } = resetForResend('t-l-3', 'm-l-3', 'u-l-3', 'b-l-old-3')
    expect(
      agg.bulkAddBlocks(
        [{ id: 'b-l3-n1', messageId: 'm-l-3', type: 'main_text', content: 'v1', status: 'error' }] as never,
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-l-3', 'm-l-3', { status: 'error', content: 'final v1' } as never, {
        resendAttemptId: attemptId
      }).ok
    ).toBe(true)
    const rows = stableReplaceRows()
    expect(rows).toHaveLength(1)
    const op = readOp(rows[0])
    const before = (sqlite.prepare(`SELECT content FROM messages WHERE id='m-l-3'`).get() as { content: string })
      .content
    const divergent = JSON.parse(JSON.stringify(op)) as Record<string, unknown>
    ;((divergent.payload as Record<string, unknown>).message as Record<string, unknown>).content = 'forged content'
    expect(() => syncService.applyIncomingOperation(divergent as never)).toThrow()
    expect((sqlite.prepare(`SELECT content FROM messages WHERE id='m-l-3'`).get() as { content: string }).content).toBe(
      before
    )
    expect(stableReplaceRows()).toHaveLength(1)
  })
})

describe('reset/resend finals — guards unchanged', () => {
  it('sibling resend-intent still forces local-only for an error final', () => {
    seedUser('t-s-1', 'u-s-1')
    seedAssistant('t-s-1', 'm-s-1', 'u-s-1', 'b-s-old-1')
    // Sibling without membership: direct pre-sync row.
    sqlite
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, ask_id, sort_order, created_at, updated_at) VALUES ('m-s-sib','t-s-1','assistant','sib','success','u-s-1',5,'2026-09-12T00:00:00.000Z','2026-09-12T00:00:00.000Z')`
      )
      .run()
    // Sibling carries its own active reset intent -> not ordinary.
    const sibReset = { id: 'm-s-sib', topicId: 't-s-1', role: 'assistant', status: 'pending', askId: 'u-s-1' } as never
    expect(agg.resetMessagesForResend('t-s-1', [{ message: sibReset, blocks: [] } as never], []).ok).toBe(true)
    db.delete(schema.syncOutbox).run()
    // Target reset AFTER sibling reset so both intents coexist.
    const resetMsg = { id: 'm-s-1', topicId: 't-s-1', role: 'assistant', status: 'pending', askId: 'u-s-1' } as never
    const res = agg.resetMessagesForResend('t-s-1', [{ message: resetMsg, blocks: [] } as never], ['b-s-old-1'])
    expect(res.ok).toBe(true)
    const attemptId = ((res as { ok: true; value: unknown }).value as { attempts: Array<{ attemptId: string }> })
      .attempts[0].attemptId
    db.delete(schema.syncOutbox).run()
    expect(
      agg.bulkAddBlocks(
        [{ id: 'b-s-n1', messageId: 'm-s-1', type: 'main_text', content: 'x', status: 'error' }] as never,
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    expect(
      agg.updateMessage('t-s-1', 'm-s-1', { status: 'error', content: 'no-issue sibling guard' } as never, {
        resendAttemptId: attemptId
      }).ok
    ).toBe(true)
    expect(stableReplaceRows()).toHaveLength(0)
    expect(getIntentRow('m-s-1')).toBeDefined()
  })

  it('frame-clock exhaustion still rolls back an error final with intent retained', () => {
    seedUser('t-s-2', 'u-s-2')
    seedAssistant('t-s-2', 'm-s-2', 'u-s-2', 'b-s-old-2')
    const { attemptId } = resetForResend('t-s-2', 'm-s-2', 'u-s-2', 'b-s-old-2')
    expect(
      agg.bulkAddBlocks(
        [{ id: 'b-s-good', messageId: 'm-s-2', type: 'main_text', content: 'good', status: 'error' }] as never,
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    syncService.persistParentFrameInTx(db as never, {
      kind: 'topicMessage',
      parentId: 't-s-2',
      frameVersion: 'parent-order-frame-v1',
      orderedChildIds: ['u-s-2', 'm-s-2'],
      timestamp: 9007199254740991,
      operationId: 'ffff0000-0000-4000-8000-000000000000'
    })
    db.delete(schema.syncOutbox).run()
    const bad = agg.updateMessage('t-s-2', 'm-s-2', { status: 'error', content: 'final' } as never, {
      resendAttemptId: attemptId
    })
    expect(bad.ok).toBe(false)
    expect(stableReplaceRows()).toHaveLength(0)
    expect(getIntentRow('m-s-2')).toBeDefined()
    expect((sqlite.prepare(`SELECT status FROM messages WHERE id='m-s-2'`).get() as { status: string }).status).toBe(
      'pending'
    )
  })
})

describe('reset/resend finals — real-relay dual-profile convergence', () => {
  async function relayConverge(finalStatus: 'error' | 'paused'): Promise<void> {
    const tag = finalStatus === 'error' ? 'e' : 'p'
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
        `t-r-${tag}`,
        { id: `u-r-${tag}`, topicId: `t-r-${tag}`, role: 'user', content: 'q', status: 'success' } as never,
        []
      ).ok
    ).toBe(true)
    expect(
      aggB.appendMessage(
        `t-r-${tag}`,
        {
          id: `m-r-${tag}`,
          topicId: `t-r-${tag}`,
          role: 'assistant',
          content: 'old answer',
          status: 'success',
          askId: `u-r-${tag}`
        } as never,
        [
          {
            id: `b-r-old-${tag}`,
            messageId: `m-r-${tag}`,
            type: 'main_text',
            content: 'old answer',
            status: 'success'
          } as never
        ]
      ).ok
    ).toBe(true)
    bindCurrent()
    seedUser(`t-r-${tag}`, `u-r-${tag}`)
    seedAssistant(`t-r-${tag}`, `m-r-${tag}`, `u-r-${tag}`, `b-r-old-${tag}`)
    const { attemptId } = resetForResend(`t-r-${tag}`, `m-r-${tag}`, `u-r-${tag}`, `b-r-old-${tag}`)
    expect(
      agg.bulkAddBlocks(
        [
          {
            id: `b-r-new-${tag}`,
            messageId: `m-r-${tag}`,
            type: 'main_text',
            content: `${finalStatus} answer`,
            status: finalStatus,
            createdAt: '2026-09-12T00:00:10.000Z',
            updatedAt: '2026-09-12T00:00:11.000Z'
          } as never
        ],
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    expect(
      agg.updateMessage(
        `t-r-${tag}`,
        `m-r-${tag}`,
        { status: finalStatus, content: `${finalStatus} answer` } as never,
        {
          resendAttemptId: attemptId
        }
      ).ok
    ).toBe(true)
    const issued = stableReplaceRows()
    expect(issued).toHaveLength(1)
    const op = readOp(issued[0])
    expect(validateSyncOperationStrict(op)).toBeNull()
    const opDeviceId = op.deviceId as string

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
      const regB = await register(`device-B-resend-${tag}`)
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
      const pullRes = await fetch(
        `${base}/sync/pull?cursor=0&deviceId=${encodeURIComponent(`device-B-resend-${tag}`)}`,
        {
          headers: authB
        }
      )
      expect(pullRes.status).toBe(200)
      const pullBody = (await pullRes.json()) as { operations?: Array<Record<string, unknown>> }
      const pulled = (pullBody.operations ?? []).find((o) => o.id === op.id)
      expect(pulled).toBeDefined()
      const { seq: _seq, ...pulledWithoutSeq } = pulled as Record<string, unknown> & { seq?: unknown }
      expect(typeof _seq).toBe('number')
      expect(pulledWithoutSeq).toEqual(op)

      ;(chatDbService as never as { sqlite: unknown }).sqlite = sqliteB
      ;(chatDbService as never as { db: unknown }).db = dbB
      expect(syncService.applyIncomingOperation(pulledWithoutSeq as never)).toBe(true)
      expect(
        sqliteB.prepare(`SELECT content, status FROM messages WHERE id='m-r-${tag}'`).get() as {
          content: string
          status: string
        }
      ).toEqual({ content: `${finalStatus} answer`, status: finalStatus })
      expect(
        sqliteB.prepare(`SELECT content, status FROM message_blocks WHERE id='b-r-new-${tag}'`).get() as {
          content: string
          status: string
        }
      ).toEqual({ content: `${finalStatus} answer`, status: finalStatus })
      expect(sqliteB.prepare(`SELECT * FROM message_blocks WHERE id='b-r-old-${tag}'`).get()).toBeUndefined()
      // No echo: applying never mints a new stable_replace on the receiver.
      expect(sqliteB.prepare(`SELECT * FROM sync_outbox WHERE op='message_stable_replace'`).all()).toHaveLength(0)
      // No storm: a second pull for the same cursor carries no duplicate storm.
      const pull2 = await fetch(
        `${base}/sync/pull?cursor=${encodeURIComponent(String((_seq as number) + 1))}&deviceId=${encodeURIComponent(`device-B-resend-${tag}`)}`,
        { headers: authB }
      )
      expect(pull2.status).toBe(200)
      const pull2Body = (await pull2.json()) as { operations?: Array<unknown> }
      expect(pull2Body.operations ?? []).toHaveLength(0)
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
  }

  it('error final converges through the real relay with no echo/storm', async () => {
    await relayConverge('error')
  })

  it('paused final converges through the real relay with no echo/storm', async () => {
    await relayConverge('paused')
  })
})
