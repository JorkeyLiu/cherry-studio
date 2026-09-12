/**
 * Local resend attempt intent slice (SYNC-DATA-055, intent only — no issuer,
 * no `message_stable_replace` emission, no wire/relay/baseline v2/UI/IPC).
 *
 * Covers: reset persists a local-only intent per message in the same SQLite
 * transaction (attempt identity + topic/message/askId + reset timestamp +
 * removed old stable block IDs; no content/credentials/paths); a new reset
 * deterministically supersedes the prior intent for the same message;
 * intent survives migration re-run; stale supplied attempts fail closed
 * before any write commits (covered row unchanged); matching/legacy writes
 * succeed locally; unfinished attempts emit no sync outbox operation and
 * fabricate no error/final stable state; ordinary non-resend paths still
 * capture; message/topic deletion clears the intent.
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
import { getResendAttemptInTx } from '../syncResendAttempt'
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

type IntentRow = {
  message_id: string
  attempt_id: string
  topic_id: string
  ask_id: string | null
  reset_timestamp: number
  removed_block_ids_json: string
}

function getIntent(messageId: string): IntentRow | undefined {
  return sqlite.prepare(`SELECT * FROM sync_resend_attempt WHERE message_id=?`).get(messageId) as IntentRow | undefined
}

function outboxFor(entityId: string): Array<{ op: string }> {
  return sqlite.prepare(`SELECT op FROM sync_outbox WHERE entity_id=?`).all(entityId) as Array<{ op: string }>
}

function stableReplaceOps(): number {
  return (
    sqlite.prepare(`SELECT COUNT(*) as n FROM sync_outbox WHERE op='message_stable_replace'`).get() as { n: number }
  ).n
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

describe('sync resend attempt intent — lifecycle and persistence', () => {
  it('reset persists a local-only intent in the same transaction (identity + askId + reset ts + removed ids, no content)', () => {
    const T0 = 1_750_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(T0)
    const topicId = 't-resend-1'
    const userId = 'm-user-1'
    const assistantId = 'm-assistant-1'
    const oldBlock = 'b-old-1'
    seedUser(topicId, userId)
    seedAssistant(topicId, assistantId, userId, oldBlock)
    drainOutbox()

    const resetMsg = {
      id: assistantId,
      topicId,
      role: 'assistant',
      content: 'old answer',
      status: 'pending',
      askId: userId
    } as never
    const res = agg.resetMessagesForResend(topicId, [{ message: resetMsg, blocks: [] } as never], [oldBlock])
    expect(res.ok).toBe(true)

    const intent = getIntent(assistantId)
    expect(intent).toBeDefined()
    expect(intent!.message_id).toBe(assistantId)
    expect(intent!.attempt_id.length).toBeGreaterThan(0)
    expect(intent!.attempt_id).not.toContain(':')
    expect(intent!.topic_id).toBe(topicId)
    expect(intent!.ask_id).toBe(userId)
    expect(intent!.reset_timestamp).toBe(T0)
    expect(JSON.parse(intent!.removed_block_ids_json)).toEqual([oldBlock])
    // No content/credentials/paths anywhere in the row
    const flat = `${intent!.message_id}|${intent!.attempt_id}|${intent!.topic_id}|${intent!.ask_id}|${intent!.removed_block_ids_json}`
    expect(flat).not.toContain('old answer')
    expect(flat).not.toContain('/')
    // Reset itself emits no outbox (unsupported structural path, local-only)
    expect(outboxFor(assistantId)).toEqual([])
    expect(stableReplaceOps()).toBe(0)
    // Old block is gone, message row survives as pending
    expect(sqlite.prepare(`SELECT id FROM message_blocks WHERE id=?`).get(oldBlock)).toBeUndefined()
    const msg = sqlite.prepare(`SELECT status FROM messages WHERE id=?`).get(assistantId) as { status: string }
    expect(msg.status).toBe('pending')
  })

  it('a new reset deterministically supersedes the prior intent for the same message', () => {
    const topicId = 't-resend-2'
    const userId = 'm-user-2'
    const assistantId = 'm-assistant-2'
    seedUser(topicId, userId)
    seedAssistant(topicId, assistantId, userId, 'b-old-2')
    const resetMsg = { id: assistantId, topicId, role: 'assistant', status: 'pending', askId: userId } as never

    expect(agg.resetMessagesForResend(topicId, [{ message: resetMsg, blocks: [] } as never], ['b-old-2']).ok).toBe(true)
    const first = getIntent(assistantId)!
    expect(first).toBeDefined()

    // Second attempt adds a fresh block then resets again with nothing to delete
    expect(
      agg.bulkAddBlocks([
        { id: 'b-new-2', messageId: assistantId, type: 'main_text', content: 'partial', status: 'streaming' } as never
      ]).ok
    ).toBe(true)
    expect(agg.resetMessagesForResend(topicId, [{ message: resetMsg, blocks: [] } as never], ['b-new-2']).ok).toBe(true)
    const second = getIntent(assistantId)!
    expect(second.attempt_id).not.toBe(first.attempt_id)
    expect(JSON.parse(second.removed_block_ids_json)).toEqual(['b-new-2'])
    const rows = sqlite
      .prepare(`SELECT COUNT(*) as n FROM sync_resend_attempt WHERE message_id=?`)
      .get(assistantId) as {
      n: number
    }
    expect(rows.n).toBe(1)
    expect(stableReplaceOps()).toBe(0)
  })

  it('string-form reset falls back to the surviving row askId', () => {
    const topicId = 't-resend-2b'
    const userId = 'm-user-2b'
    const assistantId = 'm-assistant-2b'
    seedUser(topicId, userId)
    seedAssistant(topicId, assistantId, userId, 'b-old-2b')
    expect(agg.resetMessagesForResend(topicId, [assistantId], ['b-old-2b']).ok).toBe(true)
    expect(getIntent(assistantId)?.ask_id).toBe(userId)
  })

  it('intent survives migration re-run (restart durability, no backfill wipe)', () => {
    const topicId = 't-resend-3'
    const userId = 'm-user-3'
    const assistantId = 'm-assistant-3'
    seedUser(topicId, userId)
    seedAssistant(topicId, assistantId, userId, 'b-old-3')
    const resetMsg = { id: assistantId, topicId, role: 'assistant', status: 'pending', askId: userId } as never
    expect(agg.resetMessagesForResend(topicId, [{ message: resetMsg, blocks: [] } as never], ['b-old-3']).ok).toBe(true)
    const before = getIntent(assistantId)!
    expect(runMigrations(db as never, sqlite)).toBe(0)
    const after = getIntent(assistantId)!
    expect(after).toEqual(before)
    // No backfill: untouched messages have no row
    expect(getIntent(userId)).toBeUndefined()
  })
})

describe('sync resend attempt intent — stale fail-closed and local-only streaming', () => {
  function setupCovered(): { topicId: string; userId: string; assistantId: string; attemptId: string } {
    const topicId = 't-resend-4'
    const userId = 'm-user-4'
    const assistantId = 'm-assistant-4'
    seedUser(topicId, userId)
    seedAssistant(topicId, assistantId, userId, 'b-old-4')
    drainOutbox()
    const resetMsg = { id: assistantId, topicId, role: 'assistant', status: 'pending', askId: userId } as never
    expect(agg.resetMessagesForResend(topicId, [{ message: resetMsg, blocks: [] } as never], ['b-old-4']).ok).toBe(true)
    const attemptId = getIntent(assistantId)!.attempt_id
    drainOutbox()
    return { topicId, userId, assistantId, attemptId }
  }

  it('stale supplied attempt fails closed with the covered row unchanged', () => {
    const { topicId, assistantId } = setupCovered()
    const before = sqlite.prepare(`SELECT status, content FROM messages WHERE id=?`).get(assistantId)
    const bad = agg.updateMessage(topicId, assistantId, { status: 'streaming', content: 'stale' } as never, {
      resendAttemptId: 'stale-attempt-id'
    })
    expect(bad.ok).toBe(false)
    expect(sqlite.prepare(`SELECT status, content FROM messages WHERE id=?`).get(assistantId)).toEqual(before)
    expect(outboxFor(assistantId)).toEqual([])
    expect(stableReplaceOps()).toBe(0)
  })

  it('stale block write fails closed before commit', () => {
    const { assistantId } = setupCovered()
    expect(
      agg.bulkAddBlocks([
        { id: 'b-stale-1', messageId: assistantId, type: 'main_text', content: 'x', status: 'success' } as never
      ]).ok
    ).toBe(true)
    const bad = agg.updateSingleBlock('b-stale-1', { content: 'stale-edit' } as never, undefined, {
      resendAttemptId: 'stale-attempt-id'
    })
    expect(bad.ok).toBe(false)
    const row = sqlite.prepare(`SELECT content FROM message_blocks WHERE id=?`).get('b-stale-1') as { content: string }
    expect(row.content).toBe('x')
  })

  it('matching attempt writes succeed locally with no outbox and no fabricated terminal state', () => {
    const { topicId, assistantId, attemptId } = setupCovered()
    // Streaming intermediate (transient) with the matching attempt
    expect(
      agg.updateMessage(topicId, assistantId, { status: 'streaming', content: 'partial…' } as never, {
        resendAttemptId: attemptId
      }).ok
    ).toBe(true)
    // Final stable checkpoint in this slice: commits locally, emits nothing
    expect(
      agg.updateMessageAndBlocks(
        topicId,
        { id: assistantId, status: 'success', content: 'done' } as never,
        [{ id: 'b-final-1', messageId: assistantId, type: 'main_text', content: 'done', status: 'success' } as never],
        [],
        { resendAttemptId: attemptId }
      ).ok
    ).toBe(true)
    const msg = sqlite.prepare(`SELECT status, content FROM messages WHERE id=?`).get(assistantId) as {
      status: string
      content: string
    }
    expect(msg).toEqual({ status: 'success', content: 'done' })
    expect(outboxFor(assistantId)).toEqual([])
    expect(outboxFor('b-final-1')).toEqual([])
    expect(stableReplaceOps()).toBe(0)
  })

  it('legacy writes without an attempt still commit locally but never sync while covered', () => {
    const { topicId, assistantId } = setupCovered()
    expect(agg.updateMessage(topicId, assistantId, { status: 'success', content: 'legacy final' } as never).ok).toBe(
      true
    )
    expect(
      (
        sqlite.prepare(`SELECT status FROM messages WHERE id=?`).get(assistantId) as {
          status: string
        }
      ).status
    ).toBe('success')
    expect(outboxFor(assistantId)).toEqual([])
    expect(stableReplaceOps()).toBe(0)
  })

  it('ordinary non-resend messages still capture normally alongside a covered message', () => {
    const { topicId } = setupCovered()
    const plainId = 'm-plain-1'
    expect(
      agg.appendMessage(
        topicId,
        { id: plainId, topicId, role: 'user', content: 'plain', status: 'success' } as never,
        []
      ).ok
    ).toBe(true)
    expect(outboxFor(plainId).length).toBeGreaterThan(0)
    expect(
      agg.updateMessage(topicId, plainId, { content: 'plain edited' } as never, { resendAttemptId: 'bogus' }).ok
    ).toBe(true)
    // bogus attempt on an uncovered message is ignored (no intent to mismatch)
    expect(outboxFor(plainId).length).toBeGreaterThan(0)
  })

  it('helper read exposes the stored intent for the future issuer', () => {
    const { assistantId, attemptId } = setupCovered()
    const stored = getResendAttemptInTx(db as never, assistantId)
    expect(stored?.attemptId).toBe(attemptId)
    expect(getResendAttemptInTx(db as never, 'm-missing')).toBeNull()
  })
})

describe('sync resend attempt intent — deletion clears the lifecycle', () => {
  it('deleteMessage clears the intent so a reused id syncs normally again', () => {
    const topicId = 't-resend-5'
    const userId = 'm-user-5'
    const assistantId = 'm-assistant-5'
    seedUser(topicId, userId)
    seedAssistant(topicId, assistantId, userId, 'b-old-5')
    const resetMsg = { id: assistantId, topicId, role: 'assistant', status: 'pending', askId: userId } as never
    expect(agg.resetMessagesForResend(topicId, [{ message: resetMsg, blocks: [] } as never], ['b-old-5']).ok).toBe(true)
    expect(getIntent(assistantId)).toBeDefined()
    expect(agg.deleteMessage(topicId, assistantId).ok).toBe(true)
    expect(getIntent(assistantId)).toBeUndefined()
  })

  it('hardDeleteTopic clears intents for the wiped topic only', () => {
    const topicA = 't-resend-6a'
    const topicB = 't-resend-6b'
    seedUser(topicA, 'm-user-6a')
    seedAssistant(topicA, 'm-a-6a', 'm-user-6a', 'b-old-6a')
    seedUser(topicB, 'm-user-6b')
    seedAssistant(topicB, 'm-a-6b', 'm-user-6b', 'b-old-6b')
    expect(
      agg.resetMessagesForResend(
        topicA,
        [{ message: { id: 'm-a-6a', topicId: topicA, role: 'assistant', status: 'pending' }, blocks: [] } as never],
        ['b-old-6a']
      ).ok
    ).toBe(true)
    expect(
      agg.resetMessagesForResend(
        topicB,
        [{ message: { id: 'm-a-6b', topicId: topicB, role: 'assistant', status: 'pending' }, blocks: [] } as never],
        ['b-old-6b']
      ).ok
    ).toBe(true)
    expect(agg.hardDeleteTopic(topicA).ok).toBe(true)
    expect(getIntent('m-a-6a')).toBeUndefined()
    expect(getIntent('m-a-6b')).toBeDefined()
  })
})
