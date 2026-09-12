/**
 * Resend attempt intent — review-gap closure (SYNC-DATA-055 intent only).
 *
 * 1) Covered-message `updateBlocks`: stale attempt fails closed before the
 *    write transaction (row unchanged), matching or legacy no-id writes stay
 *    local-only with zero sync outbox, zero order_frame, zero stable_replace;
 *    `appendMessage` overwrite of an existing covered id is likewise never
 *    captured (stale fails closed, matching/legacy commit locally with zero
 *    sync intent).
 * 2) `deleteMessages` / `deleteMessagesWithSegments` clear the intent; reuse
 *    of the same message id via ordinary creation/writes resumes normal sync
 *    capture.
 * 3) Helper pre-014 behavior is covered at the closest public boundary
 *    (helper directly): proven pre-014 (table absent + migration_state lacks
 *    the key) reads null / clears no-op; recorded-014-but-table-missing fails
 *    closed.
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
import { clearResendAttemptsForTopicInTx, clearResendAttemptsInTx, getResendAttemptInTx } from '../syncResendAttempt'
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

type IntentRow = { message_id: string; attempt_id: string }

function getIntent(messageId: string): IntentRow | undefined {
  return sqlite.prepare(`SELECT * FROM sync_resend_attempt WHERE message_id=?`).get(messageId) as IntentRow | undefined
}

function outboxFor(entityId: string): Array<{ op: string }> {
  return sqlite.prepare(`SELECT op FROM sync_outbox WHERE entity_id=?`).all(entityId) as Array<{ op: string }>
}

function countOp(op: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) as n FROM sync_outbox WHERE op=?`).get(op) as { n: number }).n
}

function drainOutbox(): void {
  db.delete(schema.syncOutbox).run()
}

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
  configStore.set('sync:token', '')
  sqlite = openInMemory()
  db = drizzle(sqlite, { schema })
  runMigrations(db as never, sqlite)
  ;(chatDbService as never as { sqlite: unknown }).sqlite = sqlite
  ;(chatDbService as never as { db: unknown }).db = db
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

function setupCovered(suffix: string): { topicId: string; userId: string; assistantId: string; attemptId: string } {
  const topicId = `t-gap-${suffix}`
  const userId = `m-gap-user-${suffix}`
  const assistantId = `m-gap-assistant-${suffix}`
  seedUser(topicId, userId)
  seedAssistant(topicId, assistantId, userId, `b-gap-old-${suffix}`)
  drainOutbox()
  const resetMsg = { id: assistantId, topicId, role: 'assistant', status: 'pending', askId: userId } as never
  expect(
    agg.resetMessagesForResend(topicId, [{ message: resetMsg, blocks: [] } as never], [`b-gap-old-${suffix}`]).ok
  ).toBe(true)
  const attemptId = getIntent(assistantId)!.attempt_id
  drainOutbox()
  return { topicId, userId, assistantId, attemptId }
}

function seedStableBlockForCovered(assistantId: string, blockId: string): void {
  // Legacy (no attempt) write for a covered parent commits locally but stays sync-suppressed.
  expect(
    agg.bulkAddBlocks([
      { id: blockId, messageId: assistantId, type: 'main_text', content: 'covered base', status: 'success' } as never
    ]).ok
  ).toBe(true)
  drainOutbox()
}

describe('covered updateBlocks stays local-only, stale fails before write', () => {
  it('stale attempt fails closed before any write: row unchanged, zero outbox/frame/stable_replace', () => {
    const { assistantId } = setupCovered('ub-stale')
    const blockId = 'b-gap-ub-stale-1'
    seedStableBlockForCovered(assistantId, blockId)
    const before = sqlite.prepare(`SELECT content, status FROM message_blocks WHERE id=?`).get(blockId)
    const bad = agg.updateBlocks(
      [{ id: blockId, messageId: assistantId, type: 'main_text', content: 'stale edit', status: 'success' } as never],
      undefined,
      { resendAttemptId: 'stale-attempt-id' }
    )
    expect(bad.ok).toBe(false)
    expect(sqlite.prepare(`SELECT content, status FROM message_blocks WHERE id=?`).get(blockId)).toEqual(before)
    expect(outboxFor(blockId)).toEqual([])
    expect(outboxFor(assistantId)).toEqual([])
    expect(countOp('order_frame')).toBe(0)
    expect(countOp('message_stable_replace')).toBe(0)
  })

  it('matching attempt commits locally with zero outbox/frame/stable_replace', () => {
    const { assistantId, attemptId } = setupCovered('ub-match')
    const blockId = 'b-gap-ub-match-1'
    seedStableBlockForCovered(assistantId, blockId)
    const res = agg.updateBlocks(
      [
        { id: blockId, messageId: assistantId, type: 'main_text', content: 'matching edit', status: 'success' } as never
      ],
      undefined,
      { resendAttemptId: attemptId }
    )
    expect(res.ok).toBe(true)
    expect(
      (sqlite.prepare(`SELECT content FROM message_blocks WHERE id=?`).get(blockId) as { content: string }).content
    ).toBe('matching edit')
    expect(outboxFor(blockId)).toEqual([])
    expect(outboxFor(assistantId)).toEqual([])
    expect(countOp('order_frame')).toBe(0)
    expect(countOp('message_stable_replace')).toBe(0)
  })

  it('legacy no-id write commits locally with zero outbox/frame/stable_replace', () => {
    const { assistantId } = setupCovered('ub-legacy')
    const blockId = 'b-gap-ub-legacy-1'
    seedStableBlockForCovered(assistantId, blockId)
    const res = agg.updateBlocks([
      { id: blockId, messageId: assistantId, type: 'main_text', content: 'legacy edit', status: 'success' } as never
    ])
    expect(res.ok).toBe(true)
    expect(
      (sqlite.prepare(`SELECT content FROM message_blocks WHERE id=?`).get(blockId) as { content: string }).content
    ).toBe('legacy edit')
    expect(outboxFor(blockId)).toEqual([])
    expect(outboxFor(assistantId)).toEqual([])
    expect(countOp('order_frame')).toBe(0)
    expect(countOp('message_stable_replace')).toBe(0)
  })
})

describe('appendMessage overwrite of an existing covered id is never captured', () => {
  it('stale attempt fails closed with the covered row unchanged', () => {
    const { topicId, assistantId } = setupCovered('ap-stale')
    const before = sqlite.prepare(`SELECT status, content FROM messages WHERE id=?`).get(assistantId)
    const bad = agg.appendMessage(
      topicId,
      { id: assistantId, topicId, role: 'assistant', content: 'stale overwrite', status: 'success' } as never,
      [],
      undefined,
      undefined,
      { resendAttemptId: 'stale-attempt-id' }
    )
    expect(bad.ok).toBe(false)
    expect(sqlite.prepare(`SELECT status, content FROM messages WHERE id=?`).get(assistantId)).toEqual(before)
    expect(outboxFor(assistantId)).toEqual([])
    expect(countOp('order_frame')).toBe(0)
    expect(countOp('message_stable_replace')).toBe(0)
  })

  it('matching attempt overwrite commits locally with zero sync intent', () => {
    const { topicId, userId, assistantId, attemptId } = setupCovered('ap-match')
    const res = agg.appendMessage(
      topicId,
      { id: assistantId, topicId, role: 'assistant', content: 're-answer', status: 'success', askId: userId } as never,
      [
        {
          id: 'b-gap-ap-match-1',
          messageId: assistantId,
          type: 'main_text',
          content: 're-answer',
          status: 'success'
        } as never
      ],
      undefined,
      undefined,
      { resendAttemptId: attemptId }
    )
    expect(res.ok).toBe(true)
    expect(
      (sqlite.prepare(`SELECT content FROM messages WHERE id=?`).get(assistantId) as { content: string }).content
    ).toBe('re-answer')
    expect(outboxFor(assistantId)).toEqual([])
    expect(outboxFor('b-gap-ap-match-1')).toEqual([])
    expect(countOp('order_frame')).toBe(0)
    expect(countOp('message_stable_replace')).toBe(0)
  })

  it('legacy overwrite commits locally with zero sync intent (control: fresh stable id still captures)', () => {
    const { topicId, userId, assistantId } = setupCovered('ap-legacy')
    const res = agg.appendMessage(
      topicId,
      {
        id: assistantId,
        topicId,
        role: 'assistant',
        content: 'legacy re-answer',
        status: 'success',
        askId: userId
      } as never,
      [
        {
          id: 'b-gap-ap-legacy-1',
          messageId: assistantId,
          type: 'main_text',
          content: 'legacy re-answer',
          status: 'success'
        } as never
      ]
    )
    expect(res.ok).toBe(true)
    expect(outboxFor(assistantId)).toEqual([])
    expect(outboxFor('b-gap-ap-legacy-1')).toEqual([])
    expect(countOp('order_frame')).toBe(0)
    expect(countOp('message_stable_replace')).toBe(0)
    // Control: the same stable shape for an uncovered id captures normally.
    const plainId = 'm-gap-ap-legacy-control'
    expect(
      agg.appendMessage(
        topicId,
        { id: plainId, topicId, role: 'user', content: 'plain', status: 'success' } as never,
        []
      ).ok
    ).toBe(true)
    expect(outboxFor(plainId).length).toBeGreaterThan(0)
  })
})

describe('deleteMessages / deleteMessagesWithSegments clear intent and reuse resumes capture', () => {
  // Minimal stable combo per existing API: the covered message starts as a
  // transient assistant stub (never inventory-included, so no membership
  // clock is minted). After the delete clears the intent, reusing the same
  // id as an ordinary stable creation mints membership fresh and captures.
  // (A stable-seeded covered message retains its tombstone membership clock
  // per 009, so same-id recreation there fails closed with a membership
  // conflict — expected governance, not resend suppression.)
  function setupCoveredTransient(suffix: string): { topicId: string; userId: string; assistantId: string } {
    const topicId = `t-gap-${suffix}`
    const userId = `m-gap-user-${suffix}`
    const assistantId = `m-gap-assistant-${suffix}`
    seedUser(topicId, userId)
    expect(
      agg.appendMessage(
        topicId,
        {
          id: assistantId,
          topicId,
          role: 'assistant',
          content: 'streaming…',
          status: 'pending',
          askId: userId
        } as never,
        []
      ).ok
    ).toBe(true)
    drainOutbox()
    const resetMsg = { id: assistantId, topicId, role: 'assistant', status: 'pending', askId: userId } as never
    expect(agg.resetMessagesForResend(topicId, [{ message: resetMsg, blocks: [] } as never], []).ok).toBe(true)
    expect(getIntent(assistantId)).toBeDefined()
    drainOutbox()
    return { topicId, userId, assistantId }
  }

  it('deleteMessages clears the intent; reused id ordinary create/write captures again', () => {
    const { topicId, userId, assistantId } = setupCoveredTransient('del-batch')
    expect(agg.deleteMessages(topicId, [assistantId]).ok).toBe(true)
    expect(getIntent(assistantId)).toBeUndefined()
    drainOutbox()
    // Ordinary reuse of the same id (no attempt carrier) captures as a fresh stable creation.
    expect(
      agg.appendMessage(
        topicId,
        {
          id: assistantId,
          topicId,
          role: 'assistant',
          content: 'recreated',
          status: 'success',
          askId: userId
        } as never,
        [
          {
            id: 'b-gap-del-batch-1',
            messageId: assistantId,
            type: 'main_text',
            content: 'recreated',
            status: 'success'
          } as never
        ]
      ).ok
    ).toBe(true)
    expect(outboxFor(assistantId).length).toBeGreaterThan(0)
    const afterCreate = outboxFor(assistantId).length
    // Ordinary follow-up write on the reused id keeps capturing.
    expect(agg.updateMessage(topicId, assistantId, { content: 'recreated edited' } as never).ok).toBe(true)
    expect(outboxFor(assistantId).length).toBeGreaterThan(afterCreate)
    expect(countOp('message_stable_replace')).toBe(0)
  })

  it('deleteMessagesWithSegments clears the intent; reused id ordinary create/write captures again', () => {
    const { topicId, userId, assistantId } = setupCoveredTransient('del-seg')
    expect(agg.deleteMessagesWithSegments(topicId, [assistantId]).ok).toBe(true)
    expect(getIntent(assistantId)).toBeUndefined()
    drainOutbox()
    expect(
      agg.appendMessage(
        topicId,
        {
          id: assistantId,
          topicId,
          role: 'assistant',
          content: 'recreated seg',
          status: 'success',
          askId: userId
        } as never,
        [
          {
            id: 'b-gap-del-seg-1',
            messageId: assistantId,
            type: 'main_text',
            content: 'recreated seg',
            status: 'success'
          } as never
        ]
      ).ok
    ).toBe(true)
    expect(outboxFor(assistantId).length).toBeGreaterThan(0)
    const afterCreate = outboxFor(assistantId).length
    expect(agg.updateMessage(topicId, assistantId, { content: 'recreated seg edited' } as never).ok).toBe(true)
    expect(outboxFor(assistantId).length).toBeGreaterThan(afterCreate)
    expect(countOp('message_stable_replace')).toBe(0)
  })
})

describe('helper pre-014 boundary: proven-absent vs recorded-but-missing', () => {
  it('proven pre-014 (table absent, migration_state lacks key): read null, clears no-op', () => {
    sqlite.exec('DROP TABLE IF EXISTS sync_resend_attempt')
    sqlite.prepare(`DELETE FROM migration_state WHERE key='014_sync_resend_attempt'`).run()
    expect(getResendAttemptInTx(db as never, 'm-any')).toBeNull()
    expect(() => clearResendAttemptsInTx(db as never, ['m-any'])).not.toThrow()
    expect(() => clearResendAttemptsForTopicInTx(db as never, 't-any')).not.toThrow()
  })

  it('014 recorded but table missing: read/clears fail closed', () => {
    sqlite.exec('DROP TABLE IF EXISTS sync_resend_attempt')
    const keyRow = sqlite.prepare(`SELECT key FROM migration_state WHERE key='014_sync_resend_attempt'`).get()
    expect(keyRow).toBeDefined()
    expect(() => getResendAttemptInTx(db as never, 'm-any')).toThrow(/no such table/i)
    expect(() => clearResendAttemptsInTx(db as never, ['m-any'])).toThrow(/no such table/i)
    expect(() => clearResendAttemptsForTopicInTx(db as never, 't-any')).toThrow(/no such table/i)
  })
})
