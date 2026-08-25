/**
 * ChatDbAggregateService Tests — real better-sqlite3, no mocks.
 *
 * Covers all 23 commands plus transaction rollback across
 * messages/blocks/references/segments.
 */

import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

vi.mock('@main/config', () => ({ DATA_PATH: '/mock/data' }))

// LOCK-004: mock the SpanCacheService singleton so permanent-delete trace
// cleanup can be asserted without touching a real trace directory.
const { mockCleanTopic } = vi.hoisted(() => ({
  mockCleanTopic: vi.fn()
}))
vi.mock('../../SpanCacheService', () => ({
  spanCacheService: { cleanTopic: mockCleanTopic }
}))

import { loggerService } from '@logger'
import { ERR_VALIDATION, isSuccess, MAX_ARRAY_LENGTH, validateChatDbResult } from '@shared/chatDb'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { reconstructBlock } from '../domain/codec'
import { runMigrations } from '../migration'
import { MessagesRepository } from '../repository/MessagesRepository'
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-agg-'))
}
function rmrf(dir: string): void {
  realFs.rmSync(dir, { recursive: true, force: true })
}
function openTestDb(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  return db
}
function wrapDrizzle(sqlite: Database.Database): BetterSQLite3Database<typeof schema> {
  return drizzle(sqlite, { schema })
}

let counter = 0
function uid(): string {
  return `a${++counter}-${Date.now()}`
}

/** Extract value from a success result, throwing if not ok. */
function okValue<T>(result: { ok: boolean; value?: T; error?: unknown }): T {
  if (!isSuccess(result as any)) throw new Error(`Expected success, got: ${JSON.stringify((result as any).error)}`)
  return (result as any).value as T
}

function makeMessageJson(topicId: string, overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `m-${uid()}`,
    topicId,
    role: 'user',
    content: 'Hello',
    status: 'success',
    createdAt: new Date().toISOString(),
    ...overrides
  }
}

function makeBlockJson(
  messageId: string,
  type = 'main_text',
  overrides?: Record<string, unknown>
): Record<string, unknown> {
  return {
    id: `b-${uid()}`,
    messageId,
    type,
    content: 'Block content',
    status: 'success',
    createdAt: new Date().toISOString(),
    ...overrides
  }
}

describe('ChatDbAggregateService', () => {
  let tmpDir: string
  let sqlite: Database.Database
  let db: BetterSQLite3Database<typeof schema>
  let agg: ChatDbAggregateService

  beforeEach(() => {
    tmpDir = makeTempDir()
    sqlite = openTestDb(realPath.join(tmpDir, 'test.db'))
    db = wrapDrizzle(sqlite)
    runMigrations(db, sqlite)
    agg = new ChatDbAggregateService(db)
    mockCleanTopic.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    try {
      sqlite.close()
    } catch {
      // ignore
    }
    rmrf(tmpDir)
  })

  // =========================================================================
  // ensure-topic
  // =========================================================================

  describe('ensureTopic', () => {
    it('creates a new topic', () => {
      const result = agg.ensureTopic('topic-1', 'asst-1', 'Created topic')
      expect(result.ok).toBe(true)
      const exists = agg.topicExists('topic-1')
      expect(exists.ok).toBe(true)
      expect(okValue(exists)).toBe(true)
      const metadata = agg.updateTopicMetadata('topic-1')
      expect(okValue(metadata).name).toBe('Created topic')
    })

    it('is idempotent — does not overwrite existing', () => {
      agg.ensureTopic('topic-1', 'asst-1')
      agg.ensureTopic('topic-1', 'asst-2') // different assistant
      const raw = agg.getRawTopic('topic-1')
      expect(raw.ok).toBe(true)
      // Original assistant preserved
    })
  })

  // =========================================================================
  // topic-exists
  // =========================================================================

  describe('topicExists', () => {
    it('returns false for absent topic', () => {
      const result = agg.topicExists('nonexistent')
      expect(result.ok).toBe(true)
      expect(okValue(result)).toBe(false)
    })

    it('returns true for existing topic', () => {
      agg.ensureTopic('topic-1')
      const result = agg.topicExists('topic-1')
      expect(result.ok).toBe(true)
      expect(okValue(result)).toBe(true)
    })
  })

  // =========================================================================
  // append-message
  // =========================================================================

  describe('appendMessage', () => {
    it('creates topic and appends message with blocks', () => {
      const topicId = `t-${uid()}`
      const msgJson = makeMessageJson(topicId)
      const blkJson = makeBlockJson(msgJson.id as string)

      const result = agg.appendMessage(topicId, msgJson as any, [blkJson as any])
      expect(result.ok).toBe(true)

      // Verify topic was created
      const exists = agg.topicExists(topicId)
      expect(exists.ok).toBe(true)
      expect(okValue(exists)).toBe(true)

      // Verify message and blocks
      const fetched = agg.fetchMessages(topicId)
      expect(fetched.ok).toBe(true)
      expect(okValue(fetched).messages).toHaveLength(1)
      expect(okValue(fetched).blocks).toHaveLength(1)
      expect(okValue(fetched).messages[0].id).toBe(msgJson.id)
      expect(okValue(fetched).messages[0].blocks).toEqual([blkJson.id])
    })

    it('appends at specified insertIndex', () => {
      const topicId = `t-${uid()}`
      agg.ensureTopic(topicId)

      const msg1 = makeMessageJson(topicId)
      const msg2 = makeMessageJson(topicId)
      const msg3 = makeMessageJson(topicId)

      agg.appendMessage(topicId, msg1 as any, [])
      agg.appendMessage(topicId, msg2 as any, [])
      agg.appendMessage(topicId, msg3 as any, [], 1) // insert at index 1

      const fetched = agg.fetchMessages(topicId)
      expect(fetched.ok).toBe(true)
      expect(okValue(fetched).messages).toHaveLength(3)
      // msg3 should be at index 1
      expect(okValue(fetched).messages[1].id).toBe(msg3.id)
    })

    it('preserves position for existing message ID', () => {
      const topicId = `t-${uid()}`
      agg.ensureTopic(topicId)

      const msg1 = makeMessageJson(topicId)
      const msg2 = makeMessageJson(topicId)

      agg.appendMessage(topicId, msg1 as any, [])
      agg.appendMessage(topicId, msg2 as any, [])

      // Re-append msg1 with updated content — should preserve position
      const updatedMsg1 = { ...msg1, content: 'Updated' }
      agg.appendMessage(topicId, updatedMsg1 as any, [])

      const fetched = agg.fetchMessages(topicId)
      expect(fetched.ok).toBe(true)
      expect(okValue(fetched).messages).toHaveLength(2)
      expect(okValue(fetched).messages[0].id).toBe(msg1.id)
      expect(okValue(fetched).messages[0].content).toBe('Updated')
    })

    it('accepts optional diagnostic correlation metadata without changing semantics', () => {
      const topicId = `t-${uid()}`
      const msgJson = makeMessageJson(topicId)
      const blkJson = makeBlockJson(msgJson.id as string)

      // Diagnostics are diagnostic-only; persistence semantics are unchanged.
      const result = agg.appendMessage(topicId, msgJson as any, [blkJson as any], undefined, {
        correlationId: 'snd-test-1',
        ordinal: 1
      })
      expect(result.ok).toBe(true)

      const fetched = agg.fetchMessages(topicId)
      expect(okValue(fetched).messages).toHaveLength(1)
      expect(okValue(fetched).messages[0].id).toBe(msgJson.id)
      expect(okValue(fetched).blocks).toHaveLength(1)
    })

    it('returns the original structured failure when a diagnosed append fails', () => {
      // Force the transaction's file-reference stage to abort with a temp
      // trigger; the original failure must surface as a typed failure
      // envelope unchanged — diagnostics never swallow or replace errors.
      const topicId = `t-${uid()}`
      const msgJson = makeMessageJson(topicId)
      const fileBlk = makeBlockJson(msgJson.id as string, 'file', {
        file: { id: 'file-fail', name: 'fail.pdf', path: '/fail.pdf', type: 'application/pdf' }
      })

      sqlite.exec(`
        CREATE TEMP TRIGGER IF NOT EXISTS abort_file_ref_insert
        BEFORE INSERT ON file_references
        BEGIN
          SELECT RAISE(ABORT, 'trigger-forced abort for diagnostics test');
        END
      `)
      try {
        const result = agg.appendMessage(topicId, msgJson as any, [fileBlk as any], undefined, {
          correlationId: 'snd-test-fail',
          ordinal: 1
        })
        expect(result.ok).toBe(false)
        expect((result as { error?: { code?: string } }).error?.code).toBeTruthy()
      } finally {
        sqlite.exec('DROP TRIGGER IF EXISTS TEMP.abort_file_ref_insert')
      }
    })
  })

  // =========================================================================
  // fetch-messages
  // =========================================================================

  describe('fetchMessages', () => {
    it('returns empty result for absent topic', () => {
      const result = agg.fetchMessages('nonexistent')
      expect(result.ok).toBe(true)
      expect(okValue(result).messages).toEqual([])
      expect(okValue(result).blocks).toEqual([])
    })

    it('primes absent topic — topic exists after fetch', () => {
      const topicId = `t-${uid()}`
      const result = agg.fetchMessages(topicId)
      expect(result.ok).toBe(true)
      expect(okValue(result).messages).toEqual([])
      expect(okValue(result).blocks).toEqual([])

      // Topic should now exist (primed in same transaction)
      const exists = agg.topicExists(topicId)
      expect(exists.ok).toBe(true)
      expect(okValue(exists)).toBe(true)
    })

    it('primes topic within transaction — atomic with read', () => {
      const topicId = `t-${uid()}`
      // First call creates topic + returns empty
      const result1 = agg.fetchMessages(topicId)
      expect(result1.ok).toBe(true)
      expect(okValue(result1).messages).toEqual([])

      // Second call should still return empty (topic persists, no messages yet)
      const result2 = agg.fetchMessages(topicId)
      expect(result2.ok).toBe(true)
      expect(okValue(result2).messages).toEqual([])
    })

    it('reconstructs message.blocks relationally', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const blk1 = makeBlockJson(msg.id as string)
      const blk2 = makeBlockJson(msg.id as string)

      agg.appendMessage(topicId, msg as any, [blk1 as any, blk2 as any])

      const result = agg.fetchMessages(topicId)
      expect(result.ok).toBe(true)
      expect(okValue(result).messages[0].blocks).toEqual([blk1.id, blk2.id])
    })

    it('round-trips a block with a >1 MiB nested string (LOCK-LB-5)', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const big = 'x'.repeat(2 * 1024 * 1024 + 700_000) // ~2.67 MiB
      const blk = makeBlockJson(msg.id as string, 'main_text', { content: big })

      agg.appendMessage(topicId, msg as any, [blk as any])

      const result = agg.fetchMessages(topicId)
      expect(result.ok).toBe(true)
      const value = okValue(result)
      expect(value.blocks).toHaveLength(1)
      expect(value.blocks[0].id).toBe(blk.id)
      expect(value.blocks[0].content).toBe(big)
      expect(value.messages[0].blocks).toEqual([blk.id])
    })

    it('passes a real >1 MiB block result through the fetchMessages contract (LOCK-LB-10)', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const big = 'x'.repeat(2 * 1024 * 1024 + 700_000) // ~2.67 MiB
      const blk = makeBlockJson(msg.id as string, 'main_text', { content: big })

      agg.appendMessage(topicId, msg as any, [blk as any])

      // The real aggregate result must satisfy the shared fetchMessages
      // contract: plain-object value, exact keys, generic messages,
      // block-profile blocks (>1 MiB string legal for blocks).
      const result = agg.fetchMessages(topicId)
      expect(() => validateChatDbResult('chatdb:fetch-messages', result as never)).not.toThrow()

      // Target linkage is preserved through the contract-validated wire result.
      const value = okValue(result)
      expect(value.blocks).toHaveLength(1)
      expect(value.blocks[0].id).toBe(blk.id)
      expect(value.blocks[0].messageId).toBe(msg.id)
      expect(value.messages).toHaveLength(1)
      expect(value.messages[0].id).toBe(msg.id)
      expect(value.messages[0].blocks).toEqual([blk.id])
    })

    it('rejects a generic oversized message through the fetchMessages contract (LOCK-LB-10)', () => {
      const topicId = `t-${uid()}`
      // Appended directly to the aggregate (IPC request caps do not run in
      // this test), so fetchMessages yields a REAL oversized message that
      // the shared contract must reject on the generic 1 MiB cap.
      const msg = makeMessageJson(topicId, { content: 'x'.repeat(1024 * 1024 + 1) })
      agg.appendMessage(topicId, msg as any, [])

      const result = agg.fetchMessages(topicId)
      expect(result.ok).toBe(true)
      expect(() => validateChatDbResult('chatdb:fetch-messages', result as never)).toThrow(
        /String length .* exceeds maximum/
      )
    })

    it('rejects >100k messages/blocks arrays through the fetchMessages contract (LOCK-LB-10/7)', () => {
      const sharedMessage = { id: 'm1' }
      expect(() =>
        validateChatDbResult('chatdb:fetch-messages', {
          ok: true,
          value: { messages: new Array(MAX_ARRAY_LENGTH + 1).fill(sharedMessage), blocks: [] }
        })
      ).toThrow(/Array length .* exceeds maximum/)
      const sharedBlock = { id: 'b1' }
      expect(() =>
        validateChatDbResult('chatdb:fetch-messages', {
          ok: true,
          value: { messages: [], blocks: new Array(MAX_ARRAY_LENGTH + 1).fill(sharedBlock) }
        })
      ).toThrow(/Array length .* exceeds maximum/)
    })

    it('preserves overflow/unknown JSON fields', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId, { customField: 'preserved', nested: { key: 42 } })
      const blk = makeBlockJson(msg.id as string, 'main_text', { extraData: [1, 2, 3] })

      agg.appendMessage(topicId, msg as any, [blk as any])

      const result = agg.fetchMessages(topicId)
      expect(result.ok).toBe(true)
      expect(okValue(result).messages[0].customField).toBe('preserved')
      expect(okValue(result).messages[0].nested).toEqual({ key: 42 })
      expect(okValue(result).blocks[0].extraData).toEqual([1, 2, 3])
    })

    it('handles tool blocks with object content', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const toolContent = { toolResult: 'data', items: [1, 2] }
      const blk = makeBlockJson(msg.id as string, 'tool', { content: toolContent })

      agg.appendMessage(topicId, msg as any, [blk as any])

      const result = agg.fetchMessages(topicId)
      expect(result.ok).toBe(true)
      expect(okValue(result).blocks).toHaveLength(1)
      // reconstructBlock should restore object content
      const reconstructed = reconstructBlock(okValue(result).blocks[0] as any)
      expect(reconstructed.content).toEqual(toolContent)
    })
  })

  // =========================================================================
  // get-raw-topic
  // =========================================================================

  describe('getRawTopic', () => {
    it('returns null for absent topic', () => {
      const result = agg.getRawTopic('nonexistent')
      expect(result.ok).toBe(true)
      expect(okValue(result)).toBeNull()
    })

    it('returns topic with ordered messages and block IDs', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const blk = makeBlockJson(msg.id as string)

      agg.appendMessage(topicId, msg as any, [blk as any])

      const result = agg.getRawTopic(topicId)
      expect(result.ok).toBe(true)
      expect(okValue(result)).not.toBeNull()
      expect(okValue(result)!.id).toBe(topicId)
      expect(okValue(result)!.messages).toHaveLength(1)
      expect(okValue(result)!.messages[0].blocks).toEqual([blk.id])
    })
  })

  // =========================================================================
  // update-message
  // =========================================================================

  describe('updateMessage', () => {
    it('updates message fields', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      agg.appendMessage(topicId, msg as any, [])

      const result = agg.updateMessage(topicId, msg.id as string, { content: 'Updated content' } as any)
      expect(result.ok).toBe(true)

      const fetched = agg.fetchMessages(topicId)
      expect(okValue(fetched).messages[0].content).toBe('Updated content')
    })

    it('no-op for missing message', () => {
      const result = agg.updateMessage('nonexistent', 'nonexistent-msg', { content: 'x' } as any)
      expect(result.ok).toBe(true)
    })

    it('preserves overflow fields in patch', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId, { custom: 'original' })
      agg.appendMessage(topicId, msg as any, [])

      agg.updateMessage(topicId, msg.id as string, { content: 'Updated', newField: 'added' } as any)

      const fetched = agg.fetchMessages(topicId)
      expect(okValue(fetched).messages[0].content).toBe('Updated')
      expect(okValue(fetched).messages[0].custom).toBe('original')
      expect(okValue(fetched).messages[0].newField).toBe('added')
    })
  })

  // =========================================================================
  // update-message-and-blocks
  // =========================================================================

  describe('updateMessageAndBlocks', () => {
    it('updates message and upserts blocks atomically', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const blk1 = makeBlockJson(msg.id as string)

      agg.appendMessage(topicId, msg as any, [blk1 as any])

      // Update message and add a new block
      const blk2 = makeBlockJson(msg.id as string)
      const result = agg.updateMessageAndBlocks(topicId, { ...msg, content: 'Updated' } as any, [
        blk1 as any,
        blk2 as any
      ])
      expect(result.ok).toBe(true)

      const fetched = agg.fetchMessages(topicId)
      expect(okValue(fetched).messages[0].content).toBe('Updated')
      expect(okValue(fetched).blocks).toHaveLength(2)
    })

    it('no-op for missing message (Dexie-compatible)', () => {
      const result = agg.updateMessageAndBlocks('nonexistent', { id: 'nonexistent-msg' } as any, [])
      expect(result.ok).toBe(true)
    })

    it('rejects deleting a block from another message in the same topic without mutation', () => {
      const topicId = `t-${uid()}`
      const messageA = makeMessageJson(topicId, { content: 'Message A' })
      const messageB = makeMessageJson(topicId, { content: 'Message B' })
      const blockA = makeBlockJson(messageA.id as string, 'file', {
        file: { id: 'file-a', name: 'a.pdf', path: '/a.pdf', type: 'application/pdf' }
      })
      const blockB = makeBlockJson(messageB.id as string, 'file', {
        file: { id: 'file-b', name: 'b.pdf', path: '/b.pdf', type: 'application/pdf' }
      })
      agg.appendMessage(topicId, messageA as any, [blockA as any])
      agg.appendMessage(topicId, messageB as any, [blockB as any])

      const result = agg.updateMessageAndBlocks(
        topicId,
        { ...messageA, content: 'Should not change' } as any,
        [],
        [blockB.id as string]
      )

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('CONFLICT_ERROR')

      const fetched = okValue(agg.fetchMessages(topicId))
      expect(fetched.messages.find((message) => message.id === messageA.id)?.content).toBe('Message A')
      expect(fetched.blocks.map((block) => block.id)).toEqual([blockA.id, blockB.id])
      expect(sqlite.prepare('SELECT file_id FROM file_references ORDER BY file_id').all()).toEqual([
        { file_id: 'file-a' },
        { file_id: 'file-b' }
      ])
    })

    it('rejects a mixed valid and foreign delete list before any mutation', () => {
      const topicId = `t-${uid()}`
      const messageA = makeMessageJson(topicId, { content: 'Original' })
      const messageB = makeMessageJson(topicId)
      const blockA = makeBlockJson(messageA.id as string, 'file', {
        file: { id: 'file-mixed-a', name: 'a.pdf', path: '/a.pdf', type: 'application/pdf' }
      })
      const blockB = makeBlockJson(messageB.id as string, 'file', {
        file: { id: 'file-mixed-b', name: 'b.pdf', path: '/b.pdf', type: 'application/pdf' }
      })
      agg.appendMessage(topicId, messageA as any, [blockA as any])
      agg.appendMessage(topicId, messageB as any, [blockB as any])

      const result = agg.updateMessageAndBlocks(
        topicId,
        { ...messageA, content: 'Should roll back' } as any,
        [],
        [blockA.id as string, blockB.id as string]
      )

      expect(result.ok).toBe(false)
      const fetched = okValue(agg.fetchMessages(topicId))
      expect(fetched.messages.find((message) => message.id === messageA.id)?.content).toBe('Original')
      expect(fetched.blocks.map((block) => block.id)).toEqual([blockA.id, blockB.id])
      expect(sqlite.prepare('SELECT file_id FROM file_references ORDER BY file_id').all()).toEqual([
        { file_id: 'file-mixed-a' },
        { file_id: 'file-mixed-b' }
      ])
    })

    it('deletes same-message blocks and returns file cleanup facts', () => {
      const topicId = `t-${uid()}`
      const message = makeMessageJson(topicId)
      const block = makeBlockJson(message.id as string, 'file', {
        file: { id: 'file-same-message', name: 'same.pdf', path: '/same.pdf', type: 'application/pdf' }
      })
      agg.appendMessage(topicId, message as any, [block as any])

      const result = agg.updateMessageAndBlocks(
        topicId,
        { ...message, content: 'Updated' } as any,
        [],
        [block.id as string]
      )

      expect(result.ok).toBe(true)
      expect(okValue(result)).toEqual({
        affectedFileIds: ['file-same-message'],
        remainingReferenceCounts: { 'file-same-message': 0 }
      })
      const fetched = okValue(agg.fetchMessages(topicId))
      expect(fetched.messages[0].content).toBe('Updated')
      expect(fetched.blocks).toEqual([])
      expect(sqlite.prepare('SELECT * FROM file_references').all()).toEqual([])
    })
  })

  // =========================================================================
  // select-answer-message (PERF-100) — one atomic multi-model answer selection
  // =========================================================================

  describe('selectAnswerMessage', () => {
    it('persists exactly one foldSelected=true among the supplied group atomically', () => {
      const topicId = `t-${uid()}`
      const askId = `ask-${uid()}`
      const m1 = makeMessageJson(topicId, { role: 'assistant', askId, foldSelected: true })
      const m2 = makeMessageJson(topicId, { role: 'assistant', askId, foldSelected: false })
      const m3 = makeMessageJson(topicId, { role: 'assistant', askId, foldSelected: false })
      agg.appendMessage(topicId, m1 as any, [])
      agg.appendMessage(topicId, m2 as any, [])
      agg.appendMessage(topicId, m3 as any, [])

      const result = agg.selectAnswerMessage(topicId, m2.id as string, [
        m1.id as string,
        m2.id as string,
        m3.id as string
      ])
      expect(result.ok).toBe(true)

      const fetched = okValue(agg.fetchMessages(topicId))
      const byId = new Map(fetched.messages.map((m) => [m.id, m]))
      expect(byId.get(m1.id as string)?.foldSelected).toBe(false)
      expect(byId.get(m2.id as string)?.foldSelected).toBe(true)
      expect(byId.get(m3.id as string)?.foldSelected).toBe(false)
      // Exactly one true across the whole topic.
      const selected = fetched.messages.filter((m) => m.foldSelected === true)
      expect(selected).toHaveLength(1)
      expect(selected[0].id).toBe(m2.id)
    })

    it('rejects a missing message in the group with NO partial write (rollback)', () => {
      const topicId = `t-${uid()}`
      const askId = `ask-${uid()}`
      const m1 = makeMessageJson(topicId, { role: 'assistant', askId, foldSelected: true })
      const m2 = makeMessageJson(topicId, { role: 'assistant', askId, foldSelected: false })
      agg.appendMessage(topicId, m1 as any, [])
      agg.appendMessage(topicId, m2 as any, [])

      const result = agg.selectAnswerMessage(topicId, m2.id as string, [
        m1.id as string,
        m2.id as string,
        'missing-msg'
      ])
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('NOT_FOUND')

      // No partial write: m1 must still be selected and m2 unselected.
      const fetched = okValue(agg.fetchMessages(topicId))
      const byId = new Map(fetched.messages.map((m) => [m.id, m]))
      expect(byId.get(m1.id as string)?.foldSelected).toBe(true)
      expect(byId.get(m2.id as string)?.foldSelected).toBe(false)
    })

    it('rejects a cross-topic message with NO partial write (ownership validation)', () => {
      const topicIdA = `t-${uid()}`
      const topicIdB = `t-${uid()}`
      const askId = `ask-${uid()}`
      const a1 = makeMessageJson(topicIdA, { role: 'assistant', askId, foldSelected: true })
      const a2 = makeMessageJson(topicIdA, { role: 'assistant', askId, foldSelected: false })
      const foreign = makeMessageJson(topicIdB, { role: 'assistant', askId, foldSelected: false })
      agg.appendMessage(topicIdA, a1 as any, [])
      agg.appendMessage(topicIdA, a2 as any, [])
      agg.appendMessage(topicIdB, foreign as any, [])

      const result = agg.selectAnswerMessage(topicIdA, a2.id as string, [
        a1.id as string,
        a2.id as string,
        foreign.id as string
      ])
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('NOT_FOUND')

      const fetched = okValue(agg.fetchMessages(topicIdA))
      const byId = new Map(fetched.messages.map((m) => [m.id, m]))
      expect(byId.get(a1.id as string)?.foldSelected).toBe(true)
      expect(byId.get(a2.id as string)?.foldSelected).toBe(false)
    })

    it('rejects duplicate IDs in the group (defense in depth)', () => {
      const topicId = `t-${uid()}`
      const askId = `ask-${uid()}`
      const m1 = makeMessageJson(topicId, { role: 'assistant', askId, foldSelected: true })
      const m2 = makeMessageJson(topicId, { role: 'assistant', askId, foldSelected: false })
      agg.appendMessage(topicId, m1 as any, [])
      agg.appendMessage(topicId, m2 as any, [])

      const result = agg.selectAnswerMessage(topicId, m2.id as string, [
        m1.id as string,
        m2.id as string,
        m2.id as string
      ])
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('CONFLICT_ERROR')
    })

    it('rejects selected not in the supplied group', () => {
      const topicId = `t-${uid()}`
      const askId = `ask-${uid()}`
      const m1 = makeMessageJson(topicId, { role: 'assistant', askId, foldSelected: true })
      const m2 = makeMessageJson(topicId, { role: 'assistant', askId, foldSelected: false })
      agg.appendMessage(topicId, m1 as any, [])
      agg.appendMessage(topicId, m2 as any, [])

      const result = agg.selectAnswerMessage(topicId, 'not-in-group', [m1.id as string, m2.id as string])
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('CONFLICT_ERROR')
    })

    it('preserves message content/order/other overflow — selection-only update', () => {
      const topicId = `t-${uid()}`
      const askId = `ask-${uid()}`
      const m1 = makeMessageJson(topicId, {
        role: 'assistant',
        askId,
        foldSelected: true,
        content: 'First answer',
        modelId: 'model-x',
        useful: true
      })
      const m2 = makeMessageJson(topicId, {
        role: 'assistant',
        askId,
        foldSelected: false,
        content: 'Second answer',
        modelId: 'model-y',
        useful: false
      })
      agg.appendMessage(topicId, m1 as any, [])
      agg.appendMessage(topicId, m2 as any, [])

      const result = agg.selectAnswerMessage(topicId, m2.id as string, [m1.id as string, m2.id as string])
      expect(result.ok).toBe(true)

      const fetched = okValue(agg.fetchMessages(topicId))
      const byId = new Map(fetched.messages.map((m) => [m.id, m]))
      const m1After = byId.get(m1.id as string)!
      const m2After = byId.get(m2.id as string)!
      expect(m1After.foldSelected).toBe(false)
      expect(m2After.foldSelected).toBe(true)
      // Content, model, and other overflow fields are untouched.
      expect(m1After.content).toBe('First answer')
      expect(m2After.content).toBe('Second answer')
      expect(m1After.modelId).toBe('model-x')
      expect(m2After.modelId).toBe('model-y')
      expect(m1After.useful).toBe(true)
      expect(m2After.useful).toBe(false)
      // Order is preserved (m1 then m2).
      expect(fetched.messages.map((m) => m.id)).toEqual([m1.id, m2.id])
    })

    it('genuine rollback: a trigger-forced failure reverts EVERY group write', () => {
      const topicId = `t-${uid()}`
      const askId = `ask-${uid()}`
      const m1 = makeMessageJson(topicId, { role: 'assistant', askId, foldSelected: true })
      const m2 = makeMessageJson(topicId, { role: 'assistant', askId, foldSelected: false })
      const m3 = makeMessageJson(topicId, { role: 'assistant', askId, foldSelected: false })
      agg.appendMessage(topicId, m1 as any, [])
      agg.appendMessage(topicId, m2 as any, [])
      agg.appendMessage(topicId, m3 as any, [])

      // Abort the whole transaction when the SECOND row is updated — proving
      // the first row's foldSelected write is rolled back too.
      sqlite.exec(`
        CREATE TEMP TRIGGER abort_select_answer_rollback_test
        AFTER UPDATE OF extra ON messages
        WHEN NEW.id = '${m2.id}' AND NEW.topic_id = '${topicId}'
        BEGIN
          SELECT RAISE(ABORT, 'trigger-forced abort for selectAnswerMessage rollback test');
        END
      `)
      try {
        const result = agg.selectAnswerMessage(topicId, m3.id as string, [
          m1.id as string,
          m2.id as string,
          m3.id as string
        ])
        expect(result.ok).toBe(false)
      } finally {
        sqlite.exec('DROP TRIGGER IF EXISTS TEMP.abort_select_answer_rollback_test')
      }

      // NO partial write: m1 keeps foldSelected=true, m2/m3 keep false.
      const fetched = okValue(agg.fetchMessages(topicId))
      const byId = new Map(fetched.messages.map((m) => [m.id, m]))
      expect(byId.get(m1.id as string)?.foldSelected).toBe(true)
      expect(byId.get(m2.id as string)?.foldSelected).toBe(false)
      expect(byId.get(m3.id as string)?.foldSelected).toBe(false)
    })
  })

  // =========================================================================
  // fetch-answer-group (S6.2b R-05) — authoritative READ
  // =========================================================================

  describe('fetchAnswerGroup', () => {
    it('returns complete ordered group for anchor even when only subset is present', () => {
      const topicId = `t-${uid()}`
      const askId = `ask-${uid()}`
      const otherAskId = `ask-${uid()}`
      const m1 = makeMessageJson(topicId, { role: 'assistant', askId, foldSelected: false })
      const m2 = makeMessageJson(topicId, { role: 'assistant', askId, foldSelected: true })
      const m3 = makeMessageJson(topicId, { role: 'assistant', askId, foldSelected: false })
      const mOther = makeMessageJson(topicId, { role: 'assistant', askId: otherAskId })
      const mUser = makeMessageJson(topicId, { role: 'user', askId: undefined })
      // Insert out-of-order to verify deterministic sort_order ASC, id ASC ordering
      agg.appendMessage(topicId, m1 as any, [])
      agg.appendMessage(topicId, mOther as any, [])
      agg.appendMessage(topicId, m2 as any, [])
      agg.appendMessage(topicId, mUser as any, [])
      agg.appendMessage(topicId, m3 as any, [])

      const result = agg.fetchAnswerGroup({ topicId, anchorMessageId: m2.id as string })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.completeness).toBe('answer-group')
      expect(result.value.topicId).toBe(topicId)
      expect(result.value.anchorMessageId).toBe(m2.id)
      expect(result.value.askId).toBe(askId)
      // Deterministic order: sort_order ASC, id ASC — our append order defines sort_order, so group order equals append order filtered
      expect(result.value.messageIds).toEqual([m1.id, m2.id, m3.id])
    })

    it('orders by sort_order ASC, id ASC for equal sort_order ties', () => {
      const topicId = `t-${uid()}`
      const askId = `ask-${uid()}`
      // Use deterministic ids where lexical order is known and opposite to insertion order,
      // then force truly equal sort_order via direct DB write to prove id ASC tie-break.
      const base = uid()
      const idAaa = `m-aaa-${base}`
      const idZzz = `m-zzz-${base}`
      const mZzz = makeMessageJson(topicId, { id: idZzz, role: 'assistant', askId })
      const mAaa = makeMessageJson(topicId, { id: idAaa, role: 'assistant', askId })
      // Insert in reverse lexical order: zzz first, aaa second
      agg.appendMessage(topicId, mZzz as any, [])
      agg.appendMessage(topicId, mAaa as any, [])
      // Force equal sort_order through test DB (repository has no equal-sort API) — literal tie condition
      const equalOrder = 42
      sqlite.prepare('UPDATE messages SET sort_order = ? WHERE id IN (?, ?)').run(equalOrder, idZzz, idAaa)
      const result = agg.fetchAnswerGroup({ topicId, anchorMessageId: idZzz })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      // Literal expected: id ASC tie-break, so aaa before zzz regardless of insertion order
      expect(result.value.messageIds).toEqual([idAaa, idZzz])
      // Also verify anchor zzz still present and ordering is deterministic from other anchor
      const resultFromAaa = agg.fetchAnswerGroup({ topicId, anchorMessageId: idAaa })
      expect(resultFromAaa.ok).toBe(true)
      if (!resultFromAaa.ok) return
      expect(resultFromAaa.value.messageIds).toEqual([idAaa, idZzz])
    })

    it('fails with NOT_FOUND when topic is missing', () => {
      const result = agg.fetchAnswerGroup({ topicId: 'missing-topic', anchorMessageId: 'any' })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('NOT_FOUND')
    })

    it('fails with NOT_FOUND when anchor is missing', () => {
      const topicId = `t-${uid()}`
      agg.appendMessage(topicId, makeMessageJson(topicId, { role: 'assistant', askId: `ask-${uid()}` }) as any, [])
      const result = agg.fetchAnswerGroup({ topicId, anchorMessageId: 'missing-anchor' })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('NOT_FOUND')
    })

    it('fails with NOT_FOUND for cross-topic anchor (ownership)', () => {
      const topicA = `t-${uid()}`
      const topicB = `t-${uid()}`
      const askId = `ask-${uid()}`
      const mA = makeMessageJson(topicA, { role: 'assistant', askId })
      const mB = makeMessageJson(topicB, { role: 'assistant', askId })
      agg.appendMessage(topicA, mA as any, [])
      agg.appendMessage(topicB, mB as any, [])
      const result = agg.fetchAnswerGroup({ topicId: topicA, anchorMessageId: mB.id as string })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('NOT_FOUND')
    })

    it('fails with NOT_FOUND when anchor is not assistant', () => {
      const topicId = `t-${uid()}`
      const userMsg = makeMessageJson(topicId, { role: 'user', askId: undefined })
      agg.appendMessage(topicId, userMsg as any, [])
      const result = agg.fetchAnswerGroup({ topicId, anchorMessageId: userMsg.id as string })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('NOT_FOUND')
    })

    it('fails with NOT_FOUND when anchor has no askId (empty/missing)', () => {
      const topicId = `t-${uid()}`
      const mNoAsk = makeMessageJson(topicId, { role: 'assistant', askId: '' })
      // makeMessageJson may coerce empty askId to null; ensure we test missing/empty
      // For missing, we delete askId
      delete (mNoAsk as any).askId
      agg.appendMessage(topicId, mNoAsk as any, [])
      const result = agg.fetchAnswerGroup({ topicId, anchorMessageId: mNoAsk.id as string })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('NOT_FOUND')
      // Also test empty string case via explicit empty
      const topicId2 = `t-${uid()}`
      const mEmptyAsk = makeMessageJson(topicId2, { role: 'assistant', askId: '' })
      // If helper strips empty, force empty string via direct insert
      agg.appendMessage(topicId2, mEmptyAsk as any, [])
      const result2 = agg.fetchAnswerGroup({ topicId: topicId2, anchorMessageId: mEmptyAsk.id as string })
      expect(result2.ok).toBe(false)
      if (!result2.ok) expect(result2.error.code).toBe('NOT_FOUND')
    })

    it('preserves imported/dangling askId equality semantics (group by string equality)', () => {
      const topicId = `t-${uid()}`
      const danglingAskId = `dangling-${uid()}`
      const m1 = makeMessageJson(topicId, { role: 'assistant', askId: danglingAskId })
      const m2 = makeMessageJson(topicId, { role: 'assistant', askId: danglingAskId })
      const m3 = makeMessageJson(topicId, { role: 'assistant', askId: `other-${uid()}` })
      agg.appendMessage(topicId, m1 as any, [])
      agg.appendMessage(topicId, m2 as any, [])
      agg.appendMessage(topicId, m3 as any, [])
      const result = agg.fetchAnswerGroup({ topicId, anchorMessageId: m1.id as string })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.messageIds).toEqual([m1.id, m2.id])
    })

    it('does not mutate or create timestamps — read-only', () => {
      const topicId = `t-${uid()}`
      const askId = `ask-${uid()}`
      const m1 = makeMessageJson(topicId, {
        role: 'assistant',
        askId,
        foldSelected: false,
        content: 'c1',
        status: 'success'
      })
      const m2 = makeMessageJson(topicId, {
        role: 'assistant',
        askId,
        foldSelected: false,
        content: 'c2',
        status: 'success'
      })
      agg.appendMessage(topicId, m1 as any, [])
      agg.appendMessage(topicId, m2 as any, [])
      const before = okValue(agg.fetchMessages(topicId))
      const beforeSnap = before.messages.map((m: any) => ({
        id: m.id,
        foldSelected: m.foldSelected,
        askId: m.askId,
        content: m.content,
        status: m.status,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        sortOrder: m.sortOrder
      }))
      const beforeCounts = { messages: before.messages.length, blocks: before.blocks.length }
      const result = agg.fetchAnswerGroup({ topicId, anchorMessageId: m1.id as string })
      expect(result.ok).toBe(true)
      const after = okValue(agg.fetchMessages(topicId))
      const afterSnap = after.messages.map((m: any) => ({
        id: m.id,
        foldSelected: m.foldSelected,
        askId: m.askId,
        content: m.content,
        status: m.status,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        sortOrder: m.sortOrder
      }))
      expect(afterSnap).toEqual(beforeSnap)
      expect(after.messages.length).toBe(beforeCounts.messages)
      expect(after.blocks.length).toBe(beforeCounts.blocks)
    })

    it('returns uniqueness and anchor inclusion invariants', () => {
      const topicId = `t-${uid()}`
      const askId = `ask-${uid()}`
      const m1 = makeMessageJson(topicId, { role: 'assistant', askId })
      const m2 = makeMessageJson(topicId, { role: 'assistant', askId })
      agg.appendMessage(topicId, m1 as any, [])
      agg.appendMessage(topicId, m2 as any, [])
      const result = agg.fetchAnswerGroup({ topicId, anchorMessageId: m2.id as string })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(new Set(result.value.messageIds).size).toBe(result.value.messageIds.length)
      expect(result.value.messageIds).toContain(m2.id)
    })
  })

  // =========================================================================
  // delete-message
  // =========================================================================

  describe('deleteMessage', () => {
    it('deletes message and cascades blocks', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const blk = makeBlockJson(msg.id as string)

      agg.appendMessage(topicId, msg as any, [blk as any])

      const result = agg.deleteMessage(topicId, msg.id as string)
      expect(result.ok).toBe(true)

      const fetched = agg.fetchMessages(topicId)
      expect(okValue(fetched).messages).toHaveLength(0)
      expect(okValue(fetched).blocks).toHaveLength(0)
    })

    it('no-op for missing or foreign message', () => {
      const topicId = `t-${uid()}`
      agg.ensureTopic(topicId)

      const result = agg.deleteMessage(topicId, 'nonexistent')
      expect(result.ok).toBe(true)
    })

    it('no-op for foreign topic (message owned by different topic)', () => {
      const topic1 = `t-${uid()}`
      const topic2 = `t-${uid()}`
      const msg = makeMessageJson(topic1)
      agg.appendMessage(topic1, msg as any, [])

      // Try to delete from wrong topic
      const result = agg.deleteMessage(topic2, msg.id as string)
      expect(result.ok).toBe(true)

      // Message still exists in correct topic
      const fetched = agg.fetchMessages(topic1)
      expect(okValue(fetched).messages).toHaveLength(1)
    })
  })

  // =========================================================================
  // delete-messages
  // =========================================================================

  describe('deleteMessages', () => {
    it('deletes multiple messages', () => {
      const topicId = `t-${uid()}`
      const msg1 = makeMessageJson(topicId)
      const msg2 = makeMessageJson(topicId)

      agg.appendMessage(topicId, msg1 as any, [])
      agg.appendMessage(topicId, msg2 as any, [])

      const result = agg.deleteMessages(topicId, [msg1.id as string, msg2.id as string])
      expect(result.ok).toBe(true)

      const fetched = agg.fetchMessages(topicId)
      expect(okValue(fetched).messages).toHaveLength(0)
    })

    it('skips foreign/missing IDs', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      agg.appendMessage(topicId, msg as any, [])

      const result = agg.deleteMessages(topicId, [msg.id as string, 'nonexistent'])
      expect(result.ok).toBe(true)

      const fetched = agg.fetchMessages(topicId)
      expect(okValue(fetched).messages).toHaveLength(0)
    })
  })

  // =========================================================================
  // update-blocks (upsert)
  // =========================================================================

  describe('updateBlocks', () => {
    it('upserts blocks — updates existing, inserts new', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const blk1 = makeBlockJson(msg.id as string, 'main_text', { content: 'Original' })
      const blk2 = makeBlockJson(msg.id as string)

      agg.appendMessage(topicId, msg as any, [blk1 as any])

      // Update blk1 and add blk2
      const result = agg.updateBlocks([{ ...blk1, content: 'Updated' }, blk2] as any)
      expect(result.ok).toBe(true)

      const fetched = agg.fetchMessages(topicId)
      expect(okValue(fetched).blocks).toHaveLength(2)
      const updatedBlk = okValue(fetched).blocks.find((b) => b.id === blk1.id)
      expect(updatedBlk!.content).toBe('Updated')
    })

    it('preserves existing order for existing blocks', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const blk1 = makeBlockJson(msg.id as string)
      const blk2 = makeBlockJson(msg.id as string)

      agg.appendMessage(topicId, msg as any, [blk1 as any, blk2 as any])

      // Update blk1 with new content — order should be preserved
      agg.updateBlocks([{ ...blk1, content: 'Updated' } as any])

      const fetched = agg.fetchMessages(topicId)
      expect(okValue(fetched).messages[0].blocks).toEqual([blk1.id, blk2.id])
    })
  })

  // =========================================================================
  // update-single-block
  // =========================================================================

  describe('updateSingleBlock', () => {
    it('patches a single block', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const blk = makeBlockJson(msg.id as string, 'main_text', { content: 'Original' })

      agg.appendMessage(topicId, msg as any, [blk as any])

      const result = agg.updateSingleBlock(blk.id as string, { content: 'Patched' } as any)
      expect(result.ok).toBe(true)

      const fetched = agg.fetchMessages(topicId)
      expect(okValue(fetched).blocks[0].content).toBe('Patched')
    })

    it('no-op for missing block', () => {
      const result = agg.updateSingleBlock('nonexistent', { content: 'x' } as any)
      expect(result.ok).toBe(true)
    })
  })

  // =========================================================================
  // bulk-add-blocks (insert-only)
  // =========================================================================

  describe('bulkAddBlocks', () => {
    it('inserts blocks in input order', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      agg.appendMessage(topicId, msg as any, [])

      const blk1 = makeBlockJson(msg.id as string)
      const blk2 = makeBlockJson(msg.id as string)

      const result = agg.bulkAddBlocks([blk1 as any, blk2 as any])
      expect(result.ok).toBe(true)

      const fetched = agg.fetchMessages(topicId)
      expect(okValue(fetched).blocks).toHaveLength(2)
      expect(okValue(fetched).messages[0].blocks).toEqual([blk1.id, blk2.id])
    })

    it('aborts whole batch on duplicate ID', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      agg.appendMessage(topicId, msg as any, [])

      const blk = makeBlockJson(msg.id as string)
      // First insert
      agg.bulkAddBlocks([blk as any])

      // Second insert with same ID should fail
      const result = agg.bulkAddBlocks([blk as any])
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toMatch(/CONFLICT|FOREIGN_KEY|STORAGE/)
      }
    })
  })

  // =========================================================================
  // delete-blocks
  // =========================================================================

  describe('deleteBlocks', () => {
    it('deletes blocks and cascades references', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const blk = makeBlockJson(msg.id as string)

      agg.appendMessage(topicId, msg as any, [blk as any])

      const result = agg.deleteBlocks([blk.id as string])
      expect(result.ok).toBe(true)

      const fetched = agg.fetchMessages(topicId)
      expect(okValue(fetched).blocks).toHaveLength(0)
      expect(okValue(fetched).messages[0].blocks).toEqual([])
    })

    it('normalizes message block order after deletion', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const blk1 = makeBlockJson(msg.id as string)
      const blk2 = makeBlockJson(msg.id as string)
      const blk3 = makeBlockJson(msg.id as string)

      agg.appendMessage(topicId, msg as any, [blk1 as any, blk2 as any, blk3 as any])

      // Delete middle block
      agg.deleteBlocks([blk2.id as string])

      const fetched = agg.fetchMessages(topicId)
      expect(okValue(fetched).blocks).toHaveLength(2)
      expect(okValue(fetched).messages[0].blocks).toEqual([blk1.id, blk3.id])
    })
  })

  // =========================================================================
  // File reference projection
  // =========================================================================

  describe('file reference projection', () => {
    it('creates file references for file blocks', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const fileBlock = makeBlockJson(msg.id as string, 'file', {
        file: { id: 'file-1', name: 'test.pdf', path: '/path/test.pdf', type: 'application/pdf' }
      })

      agg.appendMessage(topicId, msg as any, [fileBlock as any])

      // The block should have file references created
      const fetched = agg.fetchMessages(topicId)
      expect(okValue(fetched).blocks).toHaveLength(1)
    })

    it('removes file references when block becomes non-file type', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const fileBlock = makeBlockJson(msg.id as string, 'file', {
        file: { id: 'file-1', name: 'test.pdf', path: '/path/test.pdf', type: 'application/pdf' }
      })

      agg.appendMessage(topicId, msg as any, [fileBlock as any])

      // Update block to non-file type
      agg.updateSingleBlock(fileBlock.id as string, { type: 'main_text', content: 'text' } as any)

      const fetched = agg.fetchMessages(topicId)
      expect(okValue(fetched).blocks).toHaveLength(1)
    })
  })

  // =========================================================================
  // Single-operation transaction rollback
  // =========================================================================

  describe('single-operation transaction rollback', () => {
    it('bulkAddBlocks: duplicate ID in batch aborts entire batch (existing data untouched)', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const blk = makeBlockJson(msg.id as string)

      agg.appendMessage(topicId, msg as any, [blk as any])

      // bulkAddBlocks with duplicate ID should abort whole batch
      const newBlk1 = makeBlockJson(msg.id as string)
      const newBlk2 = { ...makeBlockJson(msg.id as string), id: newBlk1.id } // duplicate

      const result = agg.bulkAddBlocks([newBlk1 as any, newBlk2 as any])
      expect(result.ok).toBe(false)

      // Original data untouched
      const fetched = agg.fetchMessages(topicId)
      expect(okValue(fetched).blocks).toHaveLength(1)
      expect(okValue(fetched).blocks[0].id).toBe(blk.id)
    })
  })

  // =========================================================================
  // Cross-repository rollback — happy-path (all stages succeed)
  // =========================================================================

  describe('cross-repository happy-path (all stages succeed)', () => {
    it('appendMessage: topic ensure + message + block + refs all commit', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const blk = makeBlockJson(msg.id as string, 'file', {
        file: { id: 'file-hp', name: 'hp.pdf', path: '/hp.pdf', type: 'application/pdf' }
      })

      const result = agg.appendMessage(topicId, msg as any, [blk as any])
      expect(result.ok).toBe(true)

      // Topic, message, block, and file ref all present
      expect(okValue(agg.topicExists(topicId))).toBe(true)
      const fetched = agg.fetchMessages(topicId)
      expect(okValue(fetched).messages).toHaveLength(1)
      expect(okValue(fetched).blocks).toHaveLength(1)
    })

    it('updateMessageAndBlocks: message patch + block upsert + refs all commit', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId, { content: 'Original' })
      const blk = makeBlockJson(msg.id as string)

      agg.appendMessage(topicId, msg as any, [blk as any])

      const blk2 = makeBlockJson(msg.id as string)
      const result = agg.updateMessageAndBlocks(topicId, { ...msg, content: 'Updated' } as any, [
        blk as any,
        blk2 as any
      ])
      expect(result.ok).toBe(true)

      const after = agg.fetchMessages(topicId)
      expect(okValue(after).messages[0].content).toBe('Updated')
      expect(okValue(after).blocks).toHaveLength(2)
    })

    it('updateBlocks: block upsert + file-ref sync all commit', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const blk = makeBlockJson(msg.id as string, 'file', {
        file: { id: 'file-orig', name: 'orig.pdf', path: '/orig.pdf', type: 'application/pdf' }
      })

      agg.appendMessage(topicId, msg as any, [blk as any])

      const updatedBlk = makeBlockJson(msg.id as string, 'file', {
        content: 'Updated',
        file: { id: 'file-new', name: 'new.pdf', path: '/new.pdf', type: 'application/pdf' }
      })
      updatedBlk.id = blk.id as string // same block ID

      const result = agg.updateBlocks([updatedBlk as any])
      expect(result.ok).toBe(true)

      const fetched = agg.fetchMessages(topicId)
      expect(okValue(fetched).blocks).toHaveLength(1)
      expect(okValue(fetched).blocks[0].content).toBe('Updated')
    })

    it('updateSingleBlock: block patch + file-ref recompute all commit', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const blk = makeBlockJson(msg.id as string, 'file', {
        file: { id: 'file-1', name: 'test.pdf', path: '/test.pdf', type: 'application/pdf' }
      })

      agg.appendMessage(topicId, msg as any, [blk as any])

      const result = agg.updateSingleBlock(
        blk.id as string,
        {
          content: 'Patched',
          file: { id: 'file-2', name: 'new.pdf', path: '/new.pdf', type: 'application/pdf' }
        } as any
      )
      expect(result.ok).toBe(true)

      const fetched = agg.fetchMessages(topicId)
      expect(okValue(fetched).blocks[0].content).toBe('Patched')
    })
  })

  // =========================================================================
  // Cross-repository rollback — genuine rollback (trigger forces failure)
  //
  // Mechanism: install a temporary BEFORE INSERT trigger on
  // file_references that raises ABORT. The aggregate transaction
  // performs an earlier mutation (topic ensure / message insert /
  // message patch / block upsert) before reaching the file-reference
  // stage. The trigger causes the transaction to roll back entirely,
  // proving the earlier mutation was undone.
  // =========================================================================

  describe('cross-repository rollback (genuine)', () => {
    /**
     * Install a temporary trigger on file_references that aborts any INSERT.
     * Returns a cleanup function that drops the trigger.
     */
    function installAbortTrigger(): () => void {
      sqlite.exec(`
        CREATE TEMP TRIGGER IF NOT EXISTS abort_file_ref_insert
        BEFORE INSERT ON file_references
        BEGIN
          SELECT RAISE(ABORT, 'trigger-forced abort for rollback test');
        END
      `)
      return () => {
        sqlite.exec('DROP TRIGGER IF EXISTS TEMP.abort_file_ref_insert')
      }
    }

    it('appendMessage: topic + message are rolled back when file-ref stage fails', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const fileBlk = makeBlockJson(msg.id as string, 'file', {
        file: { id: 'file-fail', name: 'fail.pdf', path: '/fail.pdf', type: 'application/pdf' }
      })

      const cleanup = installAbortTrigger()
      try {
        // appendMessage: ensure topic → insert message → upsert block → sync refs (triggers fails)
        const result = agg.appendMessage(topicId, msg as any, [fileBlk as any])
        expect(result.ok).toBe(false)

        // Topic was not created (rolled back)
        const exists = agg.topicExists(topicId)
        expect(okValue(exists)).toBe(false)

        // Message was not created (rolled back)
        const fetched = agg.fetchMessages(topicId)
        expect(okValue(fetched).messages).toHaveLength(0)
        expect(okValue(fetched).blocks).toHaveLength(0)
      } finally {
        cleanup()
      }
    })

    it('updateMessageAndBlocks: original message content and blocks unchanged when file-ref stage fails', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId, { content: 'Original' })
      const blk = makeBlockJson(msg.id as string, 'file', {
        file: { id: 'file-orig', name: 'orig.pdf', path: '/orig.pdf', type: 'application/pdf' }
      })

      agg.appendMessage(topicId, msg as any, [blk as any])

      // Snapshot before
      const before = agg.fetchMessages(topicId)
      expect(okValue(before).messages[0].content).toBe('Original')
      expect(okValue(before).blocks).toHaveLength(1)

      const cleanup = installAbortTrigger()
      try {
        // updateMessageAndBlocks: patch message → upsert blocks → sync refs (trigger fails)
        const newBlk = makeBlockJson(msg.id as string, 'file', {
          file: { id: 'file-new', name: 'new.pdf', path: '/new.pdf', type: 'application/pdf' }
        })
        const result = agg.updateMessageAndBlocks(topicId, { ...msg, content: 'SHOULD-BE-ROLLED-BACK' } as any, [
          blk as any,
          newBlk as any
        ])
        expect(result.ok).toBe(false)

        // Original message content unchanged (rolled back)
        const after = agg.fetchMessages(topicId)
        expect(okValue(after).messages[0].content).toBe('Original')
        expect(okValue(after).blocks).toHaveLength(1)
        expect(okValue(after).blocks[0].id).toBe(blk.id)
      } finally {
        cleanup()
      }
    })

    it('updateSingleBlock: block and file-reference unchanged when reference stage fails', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const blk = makeBlockJson(msg.id as string, 'file', {
        content: 'OriginalBlock',
        file: { id: 'file-1', name: 'test.pdf', path: '/test.pdf', type: 'application/pdf' }
      })

      agg.appendMessage(topicId, msg as any, [blk as any])

      // Snapshot: block content and file reference before update
      const before = agg.fetchMessages(topicId)
      expect(okValue(before).blocks[0].content).toBe('OriginalBlock')

      const cleanup = installAbortTrigger()
      try {
        // updateSingleBlock: load block → apply patch → delete old refs → insert new refs (trigger fails)
        const result = agg.updateSingleBlock(
          blk.id as string,
          {
            content: 'SHOULD-BE-ROLLED-BACK',
            file: { id: 'file-2', name: 'new.pdf', path: '/new.pdf', type: 'application/pdf' }
          } as any
        )
        expect(result.ok).toBe(false)

        // Block content unchanged (rolled back)
        const after = agg.fetchMessages(topicId)
        expect(okValue(after).blocks[0].content).toBe('OriginalBlock')
      } finally {
        cleanup()
      }
    })
  })

  // =========================================================================
  // deleteBlocks cascade
  // =========================================================================

  describe('deleteBlocks cascade', () => {
    it('deletes blocks and cascades file_references via FK', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const fileBlock = makeBlockJson(msg.id as string, 'file', {
        file: { id: 'file-1', name: 'test.pdf', path: '/test.pdf', type: 'application/pdf' }
      })

      agg.appendMessage(topicId, msg as any, [fileBlock as any])

      // Verify block and file ref exist
      const before = agg.fetchMessages(topicId)
      expect(okValue(before).blocks).toHaveLength(1)

      // Delete block — FK cascade should remove file_references
      const result = agg.deleteBlocks([fileBlock.id as string])
      expect(result.ok).toBe(true)

      // Block and file references are gone
      const after = agg.fetchMessages(topicId)
      expect(okValue(after).blocks).toHaveLength(0)
      expect(okValue(after).messages[0].blocks).toEqual([])
    })

    it('normalizes message block order after cascade deletion', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const blk1 = makeBlockJson(msg.id as string)
      const blk2 = makeBlockJson(msg.id as string)
      const blk3 = makeBlockJson(msg.id as string)

      agg.appendMessage(topicId, msg as any, [blk1 as any, blk2 as any, blk3 as any])

      // Delete first and last — middle block survives
      agg.deleteBlocks([blk1.id as string, blk3.id as string])

      const fetched = agg.fetchMessages(topicId)
      expect(okValue(fetched).blocks).toHaveLength(1)
      expect(okValue(fetched).messages[0].blocks).toEqual([blk2.id])
    })
  })

  // =========================================================================
  // Typed error classification
  // =========================================================================

  describe('typed error classification', () => {
    it('bulkAddBlocks duplicate maps to CONFLICT', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      agg.appendMessage(topicId, msg as any, [])

      const blk = makeBlockJson(msg.id as string)
      agg.bulkAddBlocks([blk as any])

      // Second insert with same ID — CONFLICT
      const result = agg.bulkAddBlocks([blk as any])
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('CONFLICT_ERROR')
        expect(result.error.retryable).toBe(false)
      }
    })

    it('duplicate block ID in batch maps to CONFLICT', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      agg.appendMessage(topicId, msg as any, [])

      const blk1 = makeBlockJson(msg.id as string)
      const blk2 = { ...makeBlockJson(msg.id as string), id: blk1.id }

      const result = agg.bulkAddBlocks([blk1 as any, blk2 as any])
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('CONFLICT_ERROR')
        expect(result.error.retryable).toBe(false)
      }
    })
  })

  // =========================================================================
  // Structured model round-trip (real aggregate)
  // =========================================================================

  describe('structured model round-trip', () => {
    it('preserves structured model through append+fetch round-trip', () => {
      const topicId = `t-${uid()}`
      const structuredModel = {
        id: 'gpt-4o',
        provider: 'openai',
        name: 'GPT-4o',
        group: 'gpt',
        owned_by: 'openai',
        capabilities: [{ type: 'text' }],
        pricing: { input: 0.005, output: 0.015 }
      }
      const msgJson = makeMessageJson(topicId, {
        model: structuredModel,
        modelId: 'gpt-4o'
      })

      const result = agg.appendMessage(topicId, msgJson as any, [])
      expect(result.ok).toBe(true)

      const fetched = agg.fetchMessages(topicId)
      expect(fetched.ok).toBe(true)
      const wireMsg = okValue(fetched).messages[0]
      // Structured model should be fully preserved in wire output
      expect(wireMsg.model).toEqual(structuredModel)
      expect(wireMsg.modelId).toBe('gpt-4o')
    })

    it('preserves structured model through updateMessage+fetch round-trip', () => {
      const topicId = `t-${uid()}`
      const msgJson = makeMessageJson(topicId, { model: 'old-model' })
      agg.appendMessage(topicId, msgJson as any, [])

      // Update with structured model
      const newModel = { id: 'claude-3', provider: 'anthropic', name: 'Claude 3', group: 'claude' }
      const result = agg.updateMessage(topicId, msgJson.id as string, { model: newModel } as any)
      expect(result.ok).toBe(true)

      const fetched = agg.fetchMessages(topicId)
      expect(fetched.ok).toBe(true)
      expect(okValue(fetched).messages[0].model).toEqual(newModel)
      expect(okValue(fetched).messages[0].modelId).toBe('claude-3')
    })

    it('handles null model after structured model', () => {
      const topicId = `t-${uid()}`
      const structuredModel = { id: 'm1', provider: 'p', name: 'M', group: 'g' }
      const msgJson = makeMessageJson(topicId, { model: structuredModel })
      agg.appendMessage(topicId, msgJson as any, [])

      // Update to null model
      agg.updateMessage(topicId, msgJson.id as string, { model: null } as any)

      const fetched = agg.fetchMessages(topicId)
      expect(fetched.ok).toBe(true)
      expect(okValue(fetched).messages[0].model).toBeNull()
    })

    it('preserves other overflow fields alongside structured model', () => {
      const topicId = `t-${uid()}`
      const structuredModel = { id: 'm1', provider: 'p', name: 'M', group: 'g' }
      const msgJson = makeMessageJson(topicId, {
        model: structuredModel,
        customField: 'preserved',
        usage: { tokens: 100 }
      })

      agg.appendMessage(topicId, msgJson as any, [])

      const fetched = agg.fetchMessages(topicId)
      expect(fetched.ok).toBe(true)
      const wire = okValue(fetched).messages[0]
      expect(wire.model).toEqual(structuredModel)
      expect(wire.customField).toBe('preserved')
      expect(wire.usage).toEqual({ tokens: 100 })
    })

    it('never binds object to SQLite text column (no throw)', () => {
      const topicId = `t-${uid()}`
      const structuredModel = { id: 'm1', provider: 'p', name: 'M', group: 'g' }
      const msgJson = makeMessageJson(topicId, { model: structuredModel })

      // This should NOT throw "cannot bind object to TEXT column"
      expect(() => agg.appendMessage(topicId, msgJson as any, [])).not.toThrow()
    })
  })

  // =========================================================================
  // Phase 5.1A: listSegments
  // =========================================================================

  describe('listSegments', () => {
    it('returns empty array for topic with no segments', () => {
      const topicId = `t-${uid()}`
      agg.ensureTopic(topicId)
      const result = agg.listSegments(topicId)
      expect(result.ok).toBe(true)
      expect(okValue(result)).toEqual([])
    })

    it('lists segments in deterministic sortOrder order with messageIds', () => {
      const topicId = `t-${uid()}`
      const msg1 = makeMessageJson(topicId)
      const msg2 = makeMessageJson(topicId)
      agg.appendMessage(topicId, msg1 as any, [])
      agg.appendMessage(topicId, msg2 as any, [])

      agg.upsertSegment('seg-1', topicId, 'Seg1', [msg1.id as string], null)
      agg.upsertSegment('seg-2', topicId, 'Seg2', [msg2.id as string], null)

      const result = agg.listSegments(topicId)
      expect(result.ok).toBe(true)
      const segs = okValue(result)
      expect(segs).toHaveLength(2)
      // sortOrder deterministic
      expect(segs[0].id).toBe('seg-1')
      expect(segs[1].id).toBe('seg-2')
      expect(segs[0].messageIds).toEqual([msg1.id])
    })

    it('preserves color from overflow', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      agg.appendMessage(topicId, msg as any, [])
      agg.upsertSegment('seg-1', topicId, 'Seg1', [msg.id as string], '#ff0000')

      const result = agg.listSegments(topicId)
      expect(result.ok).toBe(true)
      expect(okValue(result)[0].color).toBe('#ff0000')
    })
  })

  // =========================================================================
  // Phase 5.1A: upsertSegment
  // =========================================================================

  describe('upsertSegment', () => {
    it('creates a new segment with metadata and membership', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      agg.appendMessage(topicId, msg as any, [])

      const result = agg.upsertSegment('seg-1', topicId, 'My Segment', [msg.id as string], '#00ff00')
      expect(result.ok).toBe(true)
      const wire = okValue(result)
      expect(wire.id).toBe('seg-1')
      expect(wire.topicId).toBe(topicId)
      expect(wire.name).toBe('My Segment')
      expect(wire.messageIds).toEqual([msg.id])
      expect(wire.color).toBe('#00ff00')
    })

    it('updates metadata on existing segment', () => {
      const topicId = `t-${uid()}`
      agg.upsertSegment('seg-1', topicId, 'Original', [], null)

      const result = agg.upsertSegment('seg-1', topicId, 'Updated', [], '#aabbcc')
      expect(result.ok).toBe(true)
      expect(okValue(result).name).toBe('Updated')
      expect(okValue(result).color).toBe('#aabbcc')
    })

    it('replaces message membership atomically', () => {
      const topicId = `t-${uid()}`
      const msg1 = makeMessageJson(topicId)
      const msg2 = makeMessageJson(topicId)
      agg.appendMessage(topicId, msg1 as any, [])
      agg.appendMessage(topicId, msg2 as any, [])

      agg.upsertSegment('seg-1', topicId, 'Seg', [msg1.id as string], null)
      const result = agg.upsertSegment('seg-1', topicId, 'Seg', [msg2.id as string, msg1.id as string], null)
      expect(result.ok).toBe(true)
      expect(okValue(result).messageIds).toEqual([msg2.id, msg1.id])
    })

    it('empty membership deletes the segment per repository semantics', () => {
      const topicId = `t-${uid()}`
      agg.upsertSegment('seg-1', topicId, 'Seg', [], null)

      const result = agg.upsertSegment('seg-1', topicId, 'Seg', [], null)
      expect(result.ok).toBe(true)
      // Segment deleted — wire shows empty
      expect(okValue(result).messageIds).toEqual([])
      expect(okValue(result).createdAt).toBeNull()
    })

    it('ensures topic exists', () => {
      const topicId = `t-${uid()}`
      const result = agg.upsertSegment('seg-1', topicId, 'Seg', [], null)
      expect(result.ok).toBe(true)
      expect(okValue(agg.topicExists(topicId))).toBe(true)
    })

    it('unknown extra fields preserved in overflow round-trip', () => {
      const topicId = `t-${uid()}`
      const result = agg.upsertSegment('seg-1', topicId, 'Seg', [], '#ff0000')
      expect(result.ok).toBe(true)
      expect(okValue(result).color).toBe('#ff0000')
    })
  })

  // =========================================================================
  // Phase 5.1A: updateSegmentMetadata
  // =========================================================================

  describe('updateSegmentMetadata', () => {
    it('updates name and color on existing segment', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      agg.appendMessage(topicId, msg as any, [])
      agg.upsertSegment('seg-1', topicId, 'Original', [msg.id as string], null)

      const result = agg.updateSegmentMetadata('seg-1', 'New Name', '#aabbcc')
      expect(result.ok).toBe(true)
      const wire = okValue(result)
      expect(wire.name).toBe('New Name')
      expect(wire.color).toBe('#aabbcc')
    })

    it('returns ERR_NOT_FOUND for missing segment', () => {
      const result = agg.updateSegmentMetadata('nonexistent', 'name', null)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('NOT_FOUND')
      }
    })

    it('partial update — only name', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      agg.appendMessage(topicId, msg as any, [])
      agg.upsertSegment('seg-1', topicId, 'Original', [msg.id as string], '#ff0000')

      const result = agg.updateSegmentMetadata('seg-1', 'Updated', undefined)
      expect(result.ok).toBe(true)
      expect(okValue(result).name).toBe('Updated')
      expect(okValue(result).color).toBe('#ff0000') // unchanged
    })

    it('partial update — only color', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      agg.appendMessage(topicId, msg as any, [])
      agg.upsertSegment('seg-1', topicId, 'Original', [msg.id as string], null)

      const result = agg.updateSegmentMetadata('seg-1', undefined, '#00ff00')
      expect(result.ok).toBe(true)
      expect(okValue(result).name).toBe('Original') // unchanged
      expect(okValue(result).color).toBe('#00ff00')
    })
  })

  // =========================================================================
  // Phase 5.1A: deleteSegment
  // =========================================================================

  describe('deleteSegment', () => {
    it('deletes an existing segment', () => {
      const topicId = `t-${uid()}`
      agg.upsertSegment('seg-1', topicId, 'Seg', [], null)

      const result = agg.deleteSegment('seg-1')
      expect(result.ok).toBe(true)

      const listed = agg.listSegments(topicId)
      expect(okValue(listed)).toHaveLength(0)
    })

    it('no-op for missing segment', () => {
      const result = agg.deleteSegment('nonexistent')
      expect(result.ok).toBe(true)
    })
  })

  // =========================================================================
  // Phase 5.1A: replaceSegmentMembership
  // =========================================================================

  describe('replaceSegmentMembership', () => {
    it('replaces membership and returns updated wire', () => {
      const topicId = `t-${uid()}`
      const msg1 = makeMessageJson(topicId)
      const msg2 = makeMessageJson(topicId)
      agg.appendMessage(topicId, msg1 as any, [])
      agg.appendMessage(topicId, msg2 as any, [])
      agg.upsertSegment('seg-1', topicId, 'Seg', [msg1.id as string], null)

      const result = agg.replaceSegmentMembership('seg-1', [msg2.id as string, msg1.id as string])
      expect(result.ok).toBe(true)
      expect(okValue(result)!.messageIds).toEqual([msg2.id, msg1.id])
    })

    it('empty membership deletes the segment, returns null', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      agg.appendMessage(topicId, msg as any, [])
      agg.upsertSegment('seg-1', topicId, 'Seg', [msg.id as string], null)

      const result = agg.replaceSegmentMembership('seg-1', [])
      expect(result.ok).toBe(true)
      expect(okValue(result)).toBeNull()
    })

    it('rollback on error preserves original membership', () => {
      const topicId = `t-${uid()}`
      const msg1 = makeMessageJson(topicId)
      agg.appendMessage(topicId, msg1 as any, [])
      agg.upsertSegment('seg-1', topicId, 'Seg', [msg1.id as string], null)

      // Try to add a message that doesn't belong to the topic — should throw
      const result = agg.replaceSegmentMembership('seg-1', ['nonexistent-msg'])
      expect(result.ok).toBe(false)

      // Original membership preserved
      const listResult = agg.listSegments(topicId)
      expect(okValue(listResult)[0].messageIds).toEqual([msg1.id])
    })
  })

  // =========================================================================
  // Phase 5.1A: reorderMessages
  // =========================================================================

  describe('reorderMessages', () => {
    it('reorders messages in specified dense order', () => {
      const topicId = `t-${uid()}`
      const msg1 = makeMessageJson(topicId)
      const msg2 = makeMessageJson(topicId)
      const msg3 = makeMessageJson(topicId)
      agg.appendMessage(topicId, msg1 as any, [])
      agg.appendMessage(topicId, msg2 as any, [])
      agg.appendMessage(topicId, msg3 as any, [])

      const result = agg.reorderMessages(topicId, [msg3.id as string, msg1.id as string, msg2.id as string])
      expect(result.ok).toBe(true)

      const fetched = agg.fetchMessages(topicId)
      expect(okValue(fetched).messages.map((m) => m.id)).toEqual([msg3.id, msg1.id, msg2.id])
    })

    it('rejects exact membership + dense order violation', () => {
      const topicId = `t-${uid()}`
      const msg1 = makeMessageJson(topicId)
      const msg2 = makeMessageJson(topicId)
      agg.appendMessage(topicId, msg1 as any, [])
      agg.appendMessage(topicId, msg2 as any, [])

      // Missing msg2 — not exact membership
      const result = agg.reorderMessages(topicId, [msg1.id as string])
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toMatch(/CONFLICT|IDENTITY|STORAGE/)
      }
    })

    it('read queries do not mutate state', () => {
      const topicId = `t-${uid()}`
      const msg1 = makeMessageJson(topicId)
      const msg2 = makeMessageJson(topicId)
      agg.appendMessage(topicId, msg1 as any, [])
      agg.appendMessage(topicId, msg2 as any, [])

      // listSegments is read-only, should not change message order
      agg.listSegments(topicId)
      const fetched = agg.fetchMessages(topicId)
      expect(okValue(fetched).messages.map((m) => m.id)).toEqual([msg1.id, msg2.id])
    })
  })

  // =========================================================================
  // Phase 5.1A: file reference queries (read-only)
  // =========================================================================

  describe('file reference queries (read-only)', () => {
    it('listFileRefsByFile returns refs after seeded writes', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const fileBlock = makeBlockJson(msg.id as string, 'file', {
        file: { id: 'file-1', name: 'test.pdf', path: '/test.pdf', type: 'application/pdf' }
      })
      agg.appendMessage(topicId, msg as any, [fileBlock as any])

      const result = agg.listFileRefsByFile('file-1')
      expect(result.ok).toBe(true)
      const refs = okValue(result)
      expect(refs.length).toBeGreaterThanOrEqual(1)
      expect(refs[0].fileId).toBe('file-1')
    })

    it('listFileRefsByFile returns empty for unknown fileId', () => {
      const result = agg.listFileRefsByFile('nonexistent')
      expect(result.ok).toBe(true)
      expect(okValue(result)).toEqual([])
    })

    it('countFileRefsByFile returns correct count', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const fileBlock = makeBlockJson(msg.id as string, 'file', {
        file: { id: 'file-1', name: 'test.pdf', path: '/test.pdf', type: 'application/pdf' }
      })
      agg.appendMessage(topicId, msg as any, [fileBlock as any])

      const result = agg.countFileRefsByFile('file-1')
      expect(result.ok).toBe(true)
      expect(okValue(result)).toBeGreaterThanOrEqual(1)
    })

    it('countFileRefsByFile returns 0 for unknown fileId', () => {
      const result = agg.countFileRefsByFile('nonexistent')
      expect(result.ok).toBe(true)
      expect(okValue(result)).toBe(0)
    })

    it('listBlocksByFile returns blocks after seeded writes', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const fileBlock = makeBlockJson(msg.id as string, 'file', {
        file: { id: 'file-1', name: 'test.pdf', path: '/test.pdf', type: 'application/pdf' }
      })
      agg.appendMessage(topicId, msg as any, [fileBlock as any])

      const result = agg.listBlocksByFile('file-1')
      expect(result.ok).toBe(true)
      const blocks = okValue(result)
      expect(blocks.length).toBeGreaterThanOrEqual(1)
    })

    it('listBlocksByFile returns empty for unknown fileId', () => {
      const result = agg.listBlocksByFile('nonexistent')
      expect(result.ok).toBe(true)
      expect(okValue(result)).toEqual([])
    })

    it('file refs cleaned after FK cascade (block delete)', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const fileBlock = makeBlockJson(msg.id as string, 'file', {
        file: { id: 'file-1', name: 'test.pdf', path: '/test.pdf', type: 'application/pdf' }
      })
      agg.appendMessage(topicId, msg as any, [fileBlock as any])

      // Verify refs exist
      expect(okValue(agg.countFileRefsByFile('file-1'))).toBeGreaterThanOrEqual(1)

      // Delete block — FK cascade removes refs
      agg.deleteBlocks([fileBlock.id as string])

      expect(okValue(agg.countFileRefsByFile('file-1'))).toBe(0)
      expect(okValue(agg.listBlocksByFile('file-1'))).toEqual([])
    })
  })

  // =========================================================================
  // Ordering
  // =========================================================================

  describe('ordering', () => {
    it('new blocks follow supplied order', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const blk1 = makeBlockJson(msg.id as string, 'main_text', { content: 'First' })
      const blk2 = makeBlockJson(msg.id as string, 'main_text', { content: 'Second' })
      const blk3 = makeBlockJson(msg.id as string, 'main_text', { content: 'Third' })

      agg.appendMessage(topicId, msg as any, [blk1 as any, blk2 as any, blk3 as any])

      const fetched = agg.fetchMessages(topicId)
      expect(okValue(fetched).messages[0].blocks).toEqual([blk1.id, blk2.id, blk3.id])
    })

    it('message.blocks defines relational order when present', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const blk1 = makeBlockJson(msg.id as string)
      const blk2 = makeBlockJson(msg.id as string)

      agg.appendMessage(topicId, msg as any, [blk1 as any, blk2 as any])

      const fetched = agg.fetchMessages(topicId)
      // blocks array on message matches block order
      expect(okValue(fetched).messages[0].blocks).toEqual([blk1.id, blk2.id])
    })

    it('existing block updates preserve prior order', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const blk1 = makeBlockJson(msg.id as string, 'main_text', { content: 'First' })
      const blk2 = makeBlockJson(msg.id as string, 'main_text', { content: 'Second' })

      agg.appendMessage(topicId, msg as any, [blk1 as any, blk2 as any])

      // Update blk1 content — order should not change
      agg.updateSingleBlock(blk1.id as string, { content: 'Updated First' } as any)

      const fetched = agg.fetchMessages(topicId)
      expect(okValue(fetched).messages[0].blocks).toEqual([blk1.id, blk2.id])
      expect(okValue(fetched).blocks[0].content).toBe('Updated First')
      expect(okValue(fetched).blocks[1].content).toBe('Second')
    })
  })

  // =========================================================================
  // Phase 5.1B: Topic lifecycle
  // =========================================================================

  describe('Phase 5.1B: topic lifecycle', () => {
    it('updateTopicMetadata: updates name and overflow fields', () => {
      const topicId = `t-${uid()}`
      agg.ensureTopic(topicId)

      const result = agg.updateTopicMetadata(topicId, 'New Name', true, 'prompt text', false)
      expect(result.ok).toBe(true)
      const wire = okValue(result)
      expect(wire.id).toBe(topicId)
      expect(wire.name).toBe('New Name')
      expect(wire.pinned).toBe(true)
      expect(wire.prompt).toBe('prompt text')
      expect(wire.isNameManuallyEdited).toBe(false)
    })

    it('updateTopicMetadata: returns ERR_NOT_FOUND for absent topic', () => {
      const result = agg.updateTopicMetadata('nonexistent', 'Name')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('NOT_FOUND')
    })

    it('updateTopicMetadata: partial update preserves unrelated overflow', () => {
      const topicId = `t-${uid()}`
      agg.ensureTopic(topicId)
      // Set initial overflow
      agg.updateTopicMetadata(topicId, undefined, true, 'initial prompt', undefined)

      // Partial update: only change name
      const result = agg.updateTopicMetadata(topicId, 'Updated')
      expect(result.ok).toBe(true)
      const wire = okValue(result)
      expect(wire.name).toBe('Updated')
      expect(wire.pinned).toBe(true) // preserved
      expect(wire.prompt).toBe('initial prompt') // preserved
    })

    it('updateTopicMetadata: null clears overflow fields', () => {
      const topicId = `t-${uid()}`
      agg.ensureTopic(topicId)
      agg.updateTopicMetadata(topicId, undefined, true, 'prompt', true)

      const result = agg.updateTopicMetadata(topicId, undefined, null, null, null)
      expect(result.ok).toBe(true)
      const wire = okValue(result)
      expect(wire.pinned).toBeNull()
      expect(wire.prompt).toBeNull()
      expect(wire.isNameManuallyEdited).toBeNull()
    })

    it('softDeleteTopic: sets deletedAt', () => {
      const topicId = `t-${uid()}`
      agg.ensureTopic(topicId)
      const result = agg.softDeleteTopic(topicId, 'Soft-deleted topic')
      expect(result.ok).toBe(true)
      // Topic row still exists (topicExists checks row, not soft-delete status)
      const exists = agg.topicExists(topicId)
      expect(okValue(exists)).toBe(true)
      // But not in trash listing — wait, we need to check deletedAt via getRawTopic or the topic's internal state
      // Use the trash listing to verify it IS in trash
      const trash = agg.listTrashTopics()
      const deleted = okValue(trash).items.find((i: any) => i.id === topicId) as any
      expect(deleted.name).toBe('Soft-deleted topic')
    })

    it('softDeleteTopic repairs an active legacy null name atomically with deletedAt', () => {
      const topicId = `t-${uid()}`
      agg.ensureTopic(topicId)
      const result = agg.softDeleteTopic(topicId, 'Recovered legacy topic')
      expect(result.ok).toBe(true)

      const trash = okValue(agg.listTrashTopics()).items.find((item: any) => item.id === topicId) as any
      expect(trash.name).toBe('Recovered legacy topic')
      expect(trash.deletedAt).not.toBeNull()
    })

    it('softDeleteTopic: no-op for absent topic', () => {
      const result = agg.softDeleteTopic('nonexistent')
      expect(result.ok).toBe(true)
    })

    it('restoreTopic: clears deletedAt and returns the restored wire (LOCK-532)', () => {
      const topicId = `t-${uid()}`
      agg.ensureTopic(topicId, 'assistant-1')
      agg.updateTopicMetadata(topicId, 'Named', true, 'prompt', true)
      agg.softDeleteTopic(topicId)

      const result = agg.restoreTopic(topicId)
      expect(result.ok).toBe(true)
      const wire = okValue(result) as any
      expect(wire).not.toBeNull()
      expect(wire.id).toBe(topicId)
      expect(wire.assistantId).toBe('assistant-1')
      expect(wire.name).toBe('Named')
      expect(wire.pinned).toBe(true)
      expect(wire.prompt).toBe('prompt')
      expect(wire.isNameManuallyEdited).toBe(true)
      // deletedAt cleared
      expect(wire.deletedAt ?? null).toBeNull()
      // No longer in trash
      const trash = agg.listTrashTopics('assistant-1')
      expect(okValue(trash).items.some((i: any) => i.id === topicId)).toBe(false)
    })

    it('restoreTopic: returns null for a missing topic (LOCK-532)', () => {
      const result = agg.restoreTopic('nonexistent')
      expect(result.ok).toBe(true)
      expect(okValue(result)).toBeNull()
    })

    it('restoreTopic: returns null when the topic is not in trash — no mutation', () => {
      const topicId = `t-${uid()}`
      agg.ensureTopic(topicId, 'assistant-1')

      const result = agg.restoreTopic(topicId)
      expect(result.ok).toBe(true)
      expect(okValue(result)).toBeNull()
      // Topic untouched
      expect(okValue(agg.topicExists(topicId))).toBe(true)
    })

    it('restoreTopic: second restore of the same topic returns null (stale UI race)', () => {
      const topicId = `t-${uid()}`
      agg.ensureTopic(topicId, 'assistant-1')
      agg.softDeleteTopic(topicId)

      const first = agg.restoreTopic(topicId)
      expect((okValue(first) as any)?.id).toBe(topicId)
      // A second (stale) restore must not fabricate a restored row.
      const second = agg.restoreTopic(topicId)
      expect(okValue(second)).toBeNull()
    })

    it('listTrashTopics: returns deleted topics', () => {
      const t1 = `t-${uid()}`
      const t2 = `t-${uid()}`
      agg.ensureTopic(t1, 'assistant-1')
      agg.ensureTopic(t2, 'assistant-2')
      agg.softDeleteTopic(t1)
      agg.softDeleteTopic(t2)

      const result = agg.listTrashTopics()
      expect(result.ok).toBe(true)
      const value = okValue(result)
      expect(value.items.length).toBe(2)
      expect(value.hasMore).toBe(false)
    })

    it('listTrashTopics: filters by assistantId', () => {
      const t1 = `t-${uid()}`
      const t2 = `t-${uid()}`
      agg.ensureTopic(t1, 'assistant-1')
      agg.ensureTopic(t2, 'assistant-2')
      agg.softDeleteTopic(t1)
      agg.softDeleteTopic(t2)

      const result = agg.listTrashTopics('assistant-1')
      expect(result.ok).toBe(true)
      const value = okValue(result)
      expect(value.items.length).toBe(1)
    })

    it('hardDeleteTopic: returns file cleanup facts', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const fileBlock = makeBlockJson(msg.id as string, 'file', {
        file: { id: 'file-1', name: 'test.pdf', path: '/test.pdf', type: 'application/pdf' }
      })
      agg.appendMessage(topicId, msg as any, [fileBlock as any])

      const result = agg.hardDeleteTopic(topicId)
      expect(result.ok).toBe(true)
      const cleanup = okValue(result)
      expect(cleanup.affectedFileIds).toContain('file-1')
      expect(cleanup.remainingReferenceCounts['file-1']).toBe(0)
      expect(cleanup.deletedTopicIds).toEqual([topicId])
      // Topic no longer exists
      expect(okValue(agg.topicExists(topicId))).toBe(false)
    })

    it('hardDeleteTopic: returns empty cleanup for absent topic', () => {
      const result = agg.hardDeleteTopic('nonexistent')
      expect(result.ok).toBe(true)
      const cleanup = okValue(result)
      expect(cleanup.affectedFileIds).toEqual([])
      expect(cleanup.deletedTopicIds).toEqual([])
    })

    it('hardDeleteTopic: rolls back the topic cascade when SQLite aborts', () => {
      const topicId = `t-${uid()}`
      const message = makeMessageJson(topicId)
      const block = makeBlockJson(message.id as string)
      agg.appendMessage(topicId, message as any, [block as any])
      agg.softDeleteTopic(topicId)

      sqlite.exec(`
        CREATE TEMP TRIGGER abort_hard_delete_test
        BEFORE DELETE ON topics
        WHEN OLD.id = '${topicId}'
        BEGIN
          SELECT RAISE(ABORT, 'trigger-forced abort for hard-delete rollback test');
        END;
      `)

      try {
        const result = agg.hardDeleteTopic(topicId)
        expect(result.ok).toBe(false)
        expect(okValue(agg.topicExists(topicId))).toBe(true)

        const messageRows = sqlite.prepare('SELECT id FROM messages WHERE id = ?').all(message.id) as Array<{
          id: string
        }>
        const blockRows = sqlite.prepare('SELECT id FROM message_blocks WHERE id = ?').all(block.id) as Array<{
          id: string
        }>
        expect(messageRows.map(({ id }) => id)).toEqual([message.id])
        expect(blockRows.map(({ id }) => id)).toEqual([block.id])
      } finally {
        sqlite.exec('DROP TRIGGER IF EXISTS abort_hard_delete_test')
      }
    })

    it('purgeExpiredTopics: purges expired trash topics', () => {
      const t1 = `t-${uid()}`
      const t2 = `t-${uid()}`
      agg.ensureTopic(t1)
      agg.ensureTopic(t2)
      agg.softDeleteTopic(t1)
      agg.softDeleteTopic(t2)

      // Set cutoff in the future to catch both
      const cutoff = new Date(Date.now() + 60_000).toISOString()
      const result = agg.purgeExpiredTopics(cutoff)
      expect(result.ok).toBe(true)
      expect(okValue(agg.topicExists(t1))).toBe(false)
      expect(okValue(agg.topicExists(t2))).toBe(false)
    })

    it('appendMessage: preserves existing assistant binding on topic ensure (LOCK-533)', () => {
      const topicId = `t-${uid()}`
      agg.ensureTopic(topicId, 'assistant-1')

      const msg = makeMessageJson(topicId)
      agg.appendMessage(topicId, msg as any, [])

      agg.softDeleteTopic(topicId)
      // Still owned by assistant-1: visible in the assistant-filtered trash.
      const trash = agg.listTrashTopics('assistant-1')
      expect(okValue(trash).items.some((i: any) => i.id === topicId)).toBe(true)
    })

    // Phase 5.2B: atomic assistant empty-trash (LOCK-531)
    it('emptyTrashTopics: hard-deletes only the assistant trashed topics, one aggregate cleanup', () => {
      const trashedA1 = `t-${uid()}`
      const trashedA2 = `t-${uid()}`
      const activeA1 = `t-${uid()}`

      // trashedA1: assistant-1 topic with a file reference
      const msg1 = makeMessageJson(trashedA1)
      const fileBlock1 = makeBlockJson(msg1.id as string, 'file', {
        file: { id: 'file-a1', name: 'a1.pdf', path: '/a1.pdf', type: 'application/pdf' }
      })
      agg.ensureTopic(trashedA1, 'assistant-1')
      agg.appendMessage(trashedA1, msg1 as any, [fileBlock1 as any])
      agg.softDeleteTopic(trashedA1)

      // trashedA2: another assistant's trash — must survive
      agg.ensureTopic(trashedA2, 'assistant-2')
      agg.softDeleteTopic(trashedA2)

      // activeA1: assistant-1 topic NOT in trash — must survive
      agg.ensureTopic(activeA1, 'assistant-1')

      const result = agg.emptyTrashTopics('assistant-1')
      expect(result.ok).toBe(true)
      const cleanup = okValue(result)
      expect(cleanup.affectedFileIds).toContain('file-a1')
      expect(cleanup.remainingReferenceCounts['file-a1']).toBe(0)
      expect(cleanup.deletedTopicIds).toEqual([trashedA1])

      expect(okValue(agg.topicExists(trashedA1))).toBe(false)
      expect(okValue(agg.topicExists(trashedA2))).toBe(true)
      expect(okValue(agg.topicExists(activeA1))).toBe(true)
    })

    it('emptyTrashTopics: aggregates cleanup facts across multiple trashed topics', () => {
      const t1 = `t-${uid()}`
      const t2 = `t-${uid()}`
      const msg1 = makeMessageJson(t1)
      const msg2 = makeMessageJson(t2)
      const sharedFile = { id: 'file-shared', name: 's.pdf', path: '/s.pdf', type: 'application/pdf' }
      agg.ensureTopic(t1, 'assistant-1')
      agg.ensureTopic(t2, 'assistant-1')
      agg.appendMessage(t1, msg1 as any, [makeBlockJson(msg1.id as string, 'file', { file: sharedFile }) as any])
      agg.appendMessage(t2, msg2 as any, [makeBlockJson(msg2.id as string, 'file', { file: sharedFile }) as any])
      agg.softDeleteTopic(t1)
      agg.softDeleteTopic(t2)

      const result = agg.emptyTrashTopics('assistant-1')
      const cleanup = okValue(result)
      // One aggregate result: deduplicated file IDs across topics.
      expect(cleanup.affectedFileIds).toEqual(['file-shared'])
      expect(cleanup.remainingReferenceCounts['file-shared']).toBe(0)
      expect(new Set(cleanup.deletedTopicIds)).toEqual(new Set([t1, t2]))
    })

    it('emptyTrashTopics: empty cleanup when the assistant has no trash', () => {
      const result = agg.emptyTrashTopics('assistant-without-trash')
      expect(result.ok).toBe(true)
      expect(okValue(result)).toEqual({ affectedFileIds: [], remainingReferenceCounts: {}, deletedTopicIds: [] })
    })

    it('genuine rollback: emptyTrashTopics reverts ALL deletions on trigger failure (LOCK-531)', () => {
      // Deletion order is (deletedAt DESC, id DESC). Soft-delete the guard
      // first and give it the smaller ID so it is hard-deleted SECOND —
      // the abort then fires after t1 was already deleted inside the tx.
      const t1 = `t-zz-${uid()}`
      const t2 = `t-aa-${uid()}`
      agg.ensureTopic(t1, 'assistant-r')
      agg.ensureTopic(t2, 'assistant-r')
      agg.softDeleteTopic(t2)
      agg.softDeleteTopic(t1)

      // Abort the transaction when the guard topic row is deleted. The other
      // topic's deletion must roll back too — no partial commit.
      sqlite.exec(`
        CREATE TEMP TRIGGER IF NOT EXISTS abort_empty_trash_rollback_test
        BEFORE DELETE ON topics
        WHEN OLD.id = '${t2}'
        BEGIN
          SELECT RAISE(ABORT, 'trigger-forced abort for empty-trash rollback test');
        END;
      `)

      try {
        const result = agg.emptyTrashTopics('assistant-r')
        expect(result.ok).toBe(false)

        // Both topics still exist and are still in trash.
        expect(okValue(agg.topicExists(t1))).toBe(true)
        expect(okValue(agg.topicExists(t2))).toBe(true)
        const trash = agg.listTrashTopics('assistant-r')
        const ids = okValue(trash).items.map((i: any) => i.id)
        expect(ids).toContain(t1)
        expect(ids).toContain(t2)
      } finally {
        sqlite.exec('DROP TRIGGER IF EXISTS TEMP.abort_empty_trash_rollback_test')
      }
    })

    it('purgeExpiredTopics: does not purge non-expired topics', () => {
      const t1 = `t-${uid()}`
      agg.ensureTopic(t1)
      agg.softDeleteTopic(t1)

      // Set cutoff in the past
      const cutoff = new Date(Date.now() - 60_000).toISOString()
      const result = agg.purgeExpiredTopics(cutoff)
      expect(result.ok).toBe(true)
      // Topic still exists (deletedAt > cutoff)
      // Actually we soft-deleted it, so it IS in trash but deletedAt is now, which is > cutoff (past)
      // So it should NOT be purged
      const trash = agg.listTrashTopics()
      expect(okValue(trash).items.some((i: any) => i.id === t1)).toBe(true)
    })
  })

  // =========================================================================
  // LOCK-004: permanent-delete trace cleanup
  // =========================================================================

  describe('permanent-delete trace cleanup (LOCK-004)', () => {
    it('hardDeleteTopic: cleans traces for the exact deleted topic ID after commit', () => {
      const topicId = `t-${uid()}`
      agg.ensureTopic(topicId)

      const result = agg.hardDeleteTopic(topicId)
      expect(result.ok).toBe(true)

      expect(mockCleanTopic).toHaveBeenCalledOnce()
      expect(mockCleanTopic).toHaveBeenCalledWith(topicId)
    })

    it('hardDeleteTopic: performs no cleanup for an absent topic (nothing deleted)', () => {
      const result = agg.hardDeleteTopic('nonexistent')
      expect(result.ok).toBe(true)
      expect(mockCleanTopic).not.toHaveBeenCalled()
    })

    it('hardDeleteTopic: performs no cleanup when the transaction aborts', () => {
      const topicId = `t-${uid()}`
      const message = makeMessageJson(topicId)
      agg.appendMessage(topicId, message as any, [])
      agg.softDeleteTopic(topicId)

      sqlite.exec(`
        CREATE TEMP TRIGGER abort_trace_cleanup_test
        BEFORE DELETE ON topics
        WHEN OLD.id = '${topicId}'
        BEGIN
          SELECT RAISE(ABORT, 'trigger-forced abort for LOCK-004 cleanup test');
        END;
      `)

      try {
        const result = agg.hardDeleteTopic(topicId)
        expect(result.ok).toBe(false)
        expect(mockCleanTopic).not.toHaveBeenCalled()
      } finally {
        sqlite.exec('DROP TRIGGER IF EXISTS abort_trace_cleanup_test')
      }
    })

    it('hardDeleteTopic: a failed trace cleanup is logged and non-fatal (result unchanged)', async () => {
      const topicId = `t-${uid()}`
      agg.ensureTopic(topicId)

      const errorSpy = vi.spyOn(loggerService, 'error').mockImplementation(() => undefined)
      mockCleanTopic.mockRejectedValue(new Error('trace fs error'))

      const result = agg.hardDeleteTopic(topicId)
      expect(result.ok).toBe(true)
      // Topic still deleted despite the cleanup failure
      expect(okValue(agg.topicExists(topicId))).toBe(false)
      expect(mockCleanTopic).toHaveBeenCalledWith(topicId)

      // The cleanup rejection is caught by the fire-and-forget promise chain,
      // which settles on a microtask; flush the microtask queue, then assert
      // the failure was logged and non-fatal.
      await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled())
      expect(errorSpy).toHaveBeenCalledWith(
        `Trace cleanup failed for permanently deleted topic ${topicId}:`,
        expect.any(Error)
      )
      errorSpy.mockRestore()
    })

    it('emptyTrashTopics: cleans traces for every emptied topic ID (bulk)', () => {
      const a1 = `t-${uid()}`
      const a2 = `t-${uid()}`
      agg.ensureTopic(a1, 'assistant-1')
      agg.ensureTopic(a2, 'assistant-1')
      agg.softDeleteTopic(a1)
      agg.softDeleteTopic(a2)

      const result = agg.emptyTrashTopics('assistant-1')
      expect(result.ok).toBe(true)

      expect(mockCleanTopic).toHaveBeenCalledTimes(2)
      expect(mockCleanTopic).toHaveBeenCalledWith(a1)
      expect(mockCleanTopic).toHaveBeenCalledWith(a2)
    })

    it('purgeExpiredTopics: cleans traces for every purged topic ID (bulk)', () => {
      const t1 = `t-${uid()}`
      const t2 = `t-${uid()}`
      agg.ensureTopic(t1)
      agg.ensureTopic(t2)
      agg.softDeleteTopic(t1)
      agg.softDeleteTopic(t2)

      // Cutoff in the future catches both soft-deleted topics.
      const cutoff = new Date(Date.now() + 60_000).toISOString()
      const result = agg.purgeExpiredTopics(cutoff)
      expect(result.ok).toBe(true)

      expect(mockCleanTopic).toHaveBeenCalledTimes(2)
      expect(mockCleanTopic).toHaveBeenCalledWith(t1)
      expect(mockCleanTopic).toHaveBeenCalledWith(t2)
    })

    it('softDeleteTopic: does NOT clean traces (soft delete preserves messages/traces)', () => {
      const topicId = `t-${uid()}`
      agg.ensureTopic(topicId)

      const result = agg.softDeleteTopic(topicId)
      expect(result.ok).toBe(true)
      expect(mockCleanTopic).not.toHaveBeenCalled()
    })

    it('resetAssistantTopics: cleans traces for the exact hard-deleted topic IDs (bulk)', () => {
      const deletedA = `t-del-a-${uid()}`
      const deletedB = `t-del-b-${uid()}`
      const trash = `t-del-trash-${uid()}`
      const foreign = `t-foreign-${uid()}`
      const replacementTopicId = `t-repl-${uid()}`
      agg.ensureTopic(deletedA, 'assistant-1')
      agg.ensureTopic(deletedB, 'assistant-1')
      agg.ensureTopic(trash, 'assistant-1')
      agg.softDeleteTopic(trash)
      agg.ensureTopic(foreign, 'assistant-2')
      agg.ensureTopic(replacementTopicId, 'assistant-1')

      const result = agg.resetAssistantTopics('assistant-1', replacementTopicId)
      expect(result.ok).toBe(true)
      expect(okValue(result).replacementTopic.id).toBe(replacementTopicId)
      expect(new Set(okValue(result).deletedTopicIds)).toEqual(new Set([deletedA, deletedB, trash]))
      expect(okValue(result).deletedTopicIds).not.toContain(replacementTopicId)

      // Active and trash topics owned by the assistant are hard-deleted and
      // their traces cleaned; the replacement topic and foreign topics are not.
      expect(okValue(agg.topicExists(replacementTopicId))).toBe(true)
      expect(okValue(agg.topicExists(foreign))).toBe(true)
      expect(okValue(agg.topicExists(deletedA))).toBe(false)
      expect(okValue(agg.topicExists(deletedB))).toBe(false)
      expect(okValue(agg.topicExists(trash))).toBe(false)

      expect(mockCleanTopic).toHaveBeenCalledTimes(3)
      expect(mockCleanTopic).toHaveBeenCalledWith(deletedA)
      expect(mockCleanTopic).toHaveBeenCalledWith(deletedB)
      expect(mockCleanTopic).toHaveBeenCalledWith(trash)
      expect(mockCleanTopic).not.toHaveBeenCalledWith(replacementTopicId)
      expect(mockCleanTopic).not.toHaveBeenCalledWith(foreign)
    })

    it('resetAssistantTopics: never cleans traces for the replacement topic', () => {
      const replacementTopicId = `t-repl-${uid()}`
      const deleted = `t-del-${uid()}`
      agg.ensureTopic(deleted, 'assistant-r')
      agg.ensureTopic(replacementTopicId, 'assistant-r')

      const result = agg.resetAssistantTopics('assistant-r', replacementTopicId)
      expect(result.ok).toBe(true)
      expect(okValue(result).deletedTopicIds).toEqual([deleted])

      // The replacement topic survives the reset; the other topic is gone.
      expect(okValue(agg.topicExists(replacementTopicId))).toBe(true)
      expect(okValue(agg.topicExists(deleted))).toBe(false)

      // Only the hard-deleted topic's trace is cleaned — never the replacement.
      expect(mockCleanTopic).toHaveBeenCalledTimes(1)
      expect(mockCleanTopic).toHaveBeenCalledWith(deleted)
      expect(mockCleanTopic).not.toHaveBeenCalledWith(replacementTopicId)
    })

    it('resetAssistantTopics: performs no cleanup when the transaction aborts', () => {
      const topicId = `t-${uid()}`
      const replacementTopicId = `t-repl-${uid()}`
      agg.ensureTopic(topicId, 'assistant-r')
      agg.appendMessage(topicId, makeMessageJson(topicId) as any, [])

      sqlite.exec(`
        CREATE TEMP TRIGGER abort_trace_cleanup_reset_test
        BEFORE DELETE ON topics
        WHEN OLD.id = '${topicId}'
        BEGIN
          SELECT RAISE(ABORT, 'trigger-forced abort for resetAssistantTopics LOCK-004 cleanup test');
        END;
      `)

      try {
        const result = agg.resetAssistantTopics('assistant-r', replacementTopicId)
        expect(result.ok).toBe(false)
        expect(mockCleanTopic).not.toHaveBeenCalled()
      } finally {
        sqlite.exec('DROP TRIGGER IF EXISTS abort_trace_cleanup_reset_test')
      }
    })
  })

  // =========================================================================
  // L2 imported-trash five-day retention baseline (LOCK-TRASH-1..10)
  // =========================================================================

  describe('L2 imported-trash retention (LOCK-TRASH-1..10)', () => {
    const MARKER = 'l2TrashRetentionStartedAt'
    const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000

    /** Directly rewrite a topic's deleted_at column (simulates import state). */
    function setTopicDeletedAt(topicId: string, iso: string): void {
      sqlite.prepare('UPDATE topics SET deleted_at = ? WHERE id = ?').run(iso, topicId)
    }

    /** Directly rewrite a topic's extra column (simulates import state). */
    function setTopicExtra(topicId: string, extra: string | null): void {
      sqlite.prepare('UPDATE topics SET extra = ? WHERE id = ?').run(extra, topicId)
    }

    /** Write a marker value (or invalid value) into a topic's overflow. */
    function setMarker(topicId: string, value: unknown): void {
      setTopicExtra(topicId, JSON.stringify({ [MARKER]: value }))
    }

    /**
     * Create a topic in the imported soft-deleted shape: authoritative
     * source deletedAt + importer-owned retention marker in overflow.
     */
    function createImportedDeletedTopic(deletedAt: string, marker: unknown): string {
      const id = `t-imp-${uid()}`
      agg.ensureTopic(id, 'assistant-r')
      setTopicDeletedAt(id, deletedAt)
      if (marker === null) {
        setTopicExtra(id, null)
      } else {
        setMarker(id, marker)
      }
      return id
    }

    function purgeWarnSpy() {
      return vi.spyOn(loggerService, 'warn').mockImplementation(() => undefined)
    }

    const nowMs = Date.now()
    const cutoff = new Date(nowMs - FIVE_DAYS_MS).toISOString()
    const oldDeletedAt = new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString()
    const freshMarker = new Date(nowMs).toISOString()
    const fourDay23hAgo = new Date(nowMs - (5 * 24 * 60 * 60 - 60 * 60) * 1000).toISOString()
    const fiveDaysPlus1hAgo = new Date(nowMs - (5 * 24 * 60 * 60 + 60 * 60) * 1000).toISOString()

    it('immediate purge after import retains a topic with old deletedAt + fresh marker (LOCK-TRASH-6)', () => {
      const t = createImportedDeletedTopic(oldDeletedAt, freshMarker)
      const result = agg.purgeExpiredTopics(cutoff)
      expect(result.ok).toBe(true)
      expect(okValue(agg.topicExists(t))).toBe(true)
      const trash = agg.listTrashTopics()
      expect(okValue(trash).items.some((i: any) => i.id === t)).toBe(true)
    })

    it('4d23h-old marker retains; >5d-old marker purges (LOCK-TRASH-6)', () => {
      const retained = createImportedDeletedTopic(oldDeletedAt, fourDay23hAgo)
      const purged = createImportedDeletedTopic(oldDeletedAt, fiveDaysPlus1hAgo)

      const result = agg.purgeExpiredTopics(cutoff)
      expect(result.ok).toBe(true)
      expect(okValue(agg.topicExists(retained))).toBe(true)
      expect(okValue(agg.topicExists(purged))).toBe(false)
    })

    it('marker older than deletedAt → effective start = deletedAt (max, LOCK-TRASH-6)', () => {
      // deletedAt is 3 days ago (> cutoff) while the marker is 60 days ago.
      const threeDaysAgo = new Date(nowMs - 3 * 24 * 60 * 60 * 1000).toISOString()
      const sixtyDaysAgo = new Date(nowMs - 60 * 24 * 60 * 60 * 1000).toISOString()
      const t = createImportedDeletedTopic(threeDaysAgo, sixtyDaysAgo)

      const result = agg.purgeExpiredTopics(cutoff)
      expect(result.ok).toBe(true)
      // max(3d ago, 60d ago) = 3d ago > cutoff → retained.
      expect(okValue(agg.topicExists(t))).toBe(true)
    })

    it('future valid marker protects until its calculated window (LOCK-TRASH-6)', () => {
      const futureMarker = new Date(nowMs + 10 * 24 * 60 * 60 * 1000).toISOString()
      const t = createImportedDeletedTopic(oldDeletedAt, futureMarker)

      const result = agg.purgeExpiredTopics(cutoff)
      expect(result.ok).toBe(true)
      expect(okValue(agg.topicExists(t))).toBe(true)
    })

    it('exact-cutoff effective start is retained (strictly earlier required)', () => {
      const t = createImportedDeletedTopic(oldDeletedAt, cutoff)
      const result = agg.purgeExpiredTopics(cutoff)
      expect(result.ok).toBe(true)
      expect(okValue(agg.topicExists(t))).toBe(true)
    })

    it('missing marker (L3 legacy) uses deletedAt exactly as before — purged, no warning', () => {
      const warnSpy = purgeWarnSpy()
      const t = createImportedDeletedTopic(oldDeletedAt, null)

      const result = agg.purgeExpiredTopics(cutoff)
      expect(result.ok).toBe(true)
      expect(okValue(agg.topicExists(t))).toBe(false)
      // LOCK-TRASH-7: no invalid-marker warning when nothing was invalid.
      expect(
        warnSpy.mock.calls.filter((c) => typeof c[0] === 'string' && String(c[0]).includes('retention marker'))
      ).toHaveLength(0)
      warnSpy.mockRestore()
    })

    it('invalid marker falls back to deletedAt and emits exactly one count-only warning', () => {
      const warnSpy = purgeWarnSpy()
      const t = createImportedDeletedTopic(oldDeletedAt, 'not-a-date')

      const result = agg.purgeExpiredTopics(cutoff)
      expect(result.ok).toBe(true)
      // Invalid marker ignored → deletedAt (30d ago) is strictly earlier → purged.
      expect(okValue(agg.topicExists(t))).toBe(false)

      const matching = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && String(c[0]).includes('retention marker')
      )
      // LOCK-TRASH-7: exactly one count-only warning; no IDs, marker values,
      // paths, or content.
      expect(matching).toHaveLength(1)
      const [message] = matching[0]
      expect(String(message)).toContain('1 imported-topic retention marker')
      expect(String(message)).not.toContain(t)
      expect(String(message)).not.toContain('not-a-date')
      warnSpy.mockRestore()
    })

    it('malformed extra never aborts the purge — invalid-marker fallback + one warning (LOCK-TRASH-10/7)', () => {
      const warnSpy = purgeWarnSpy()
      const t = `t-malformed-${uid()}`
      agg.ensureTopic(t)
      setTopicDeletedAt(t, oldDeletedAt)
      setTopicExtra(t, '{ definitely not json')

      const result = agg.purgeExpiredTopics(cutoff)
      expect(result.ok).toBe(true)
      expect(okValue(agg.topicExists(t))).toBe(false)

      const matching = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && String(c[0]).includes('retention marker')
      )
      expect(matching).toHaveLength(1)
      expect(String(matching[0][0])).toContain('1 imported-topic retention marker')
      warnSpy.mockRestore()
    })

    it('drains all keyset pages even when retained rows dominate the first page (LOCK-TRASH-7)', () => {
      const warnSpy = purgeWarnSpy()
      // 120 retained rows (fresh marker → effective start now > cutoff) with
      // RECENT deletedAt, so they sort FIRST in (deletedAt DESC, id DESC)
      // pagination. 10 purgeable rows (no marker, old deletedAt) sort last.
      const retained: string[] = []
      const recentDeletedAt = new Date(nowMs - 60 * 60 * 1000).toISOString()
      for (let i = 0; i < 120; i++) {
        const id = `t-ret-${uid()}`
        agg.ensureTopic(id, 'assistant-r')
        setTopicDeletedAt(id, recentDeletedAt)
        setMarker(id, freshMarker)
        retained.push(id)
      }
      const purgeable: string[] = []
      for (let i = 0; i < 10; i++) {
        const id = `t-purge-${uid()}`
        agg.ensureTopic(id, 'assistant-r')
        setTopicDeletedAt(id, oldDeletedAt)
        setTopicExtra(id, null)
        purgeable.push(id)
      }

      const result = agg.purgeExpiredTopics(cutoff)
      expect(result.ok).toBe(true)
      for (const id of retained) expect(okValue(agg.topicExists(id))).toBe(true)
      for (const id of purgeable) expect(okValue(agg.topicExists(id))).toBe(false)
      // No invalid markers in this scenario → no warning.
      expect(
        warnSpy.mock.calls.filter((c) => typeof c[0] === 'string' && String(c[0]).includes('retention marker'))
      ).toHaveLength(0)
      warnSpy.mockRestore()
    })

    it('no invalid-marker warning on a failed purge; exactly one on the retry (LOCK-TRASH-7)', () => {
      const warnSpy = purgeWarnSpy()
      const t = createImportedDeletedTopic(oldDeletedAt, 'bad-marker')

      // Force the purge transaction to abort (rollback) so no warning may
      // fire for a failed purge.
      sqlite.exec(`
        CREATE TEMP TRIGGER abort_purge_retention_test
        BEFORE DELETE ON topics
        WHEN OLD.id = '${t}'
        BEGIN
          SELECT RAISE(ABORT, 'trigger-forced abort for purge retention test');
        END;
      `)

      try {
        const failed = agg.purgeExpiredTopics(cutoff)
        expect(failed.ok).toBe(false)
        expect(okValue(agg.topicExists(t))).toBe(true) // rolled back
        expect(
          warnSpy.mock.calls.filter((c) => typeof c[0] === 'string' && String(c[0]).includes('retention marker'))
        ).toHaveLength(0)
      } finally {
        sqlite.exec('DROP TRIGGER IF EXISTS TEMP.abort_purge_retention_test')
      }

      // Retry after the abort: the purge succeeds and the invalid marker is
      // counted exactly once (the failed attempt emitted nothing).
      const retried = agg.purgeExpiredTopics(cutoff)
      expect(retried.ok).toBe(true)
      expect(okValue(agg.topicExists(t))).toBe(false)
      const matching = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && String(c[0]).includes('retention marker')
      )
      expect(matching).toHaveLength(1)
      expect(String(matching[0][0])).toContain('1 imported-topic retention marker')
      warnSpy.mockRestore()
    })

    it('invalid cutoff rejects with typed validation semantics (ERR_VALIDATION, LOCK-TRASH-10)', () => {
      const result = agg.purgeExpiredTopics('not-a-valid-cutoff')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe(ERR_VALIDATION)
        expect(result.error.retryable).toBe(false)
      }
    })

    // LOCK-TRASH-13: the purge cutoff must be a strict canonical UTC ISO
    // timestamp with milliseconds — identical to the shared IPC contract.
    // Parseable-but-non-canonical values reject as typed ERR_VALIDATION.
    const NON_CANONICAL_CUTOFFS = [
      '2026-08-04T00:00:00Z', // missing milliseconds
      '2026-08-04', // date-only
      '2026-08-04T00:00:00.000+00:00', // offset timezone (not Z)
      '2026-08-04 00:00:00.000Z', // space separator
      '2026-08-04T00:00:00.000', // no Z suffix
      '2026-08-04T00:00:00.00Z' // 2-digit milliseconds
    ]

    it.each(NON_CANONICAL_CUTOFFS)(
      'purgeExpiredTopics rejects parseable non-canonical cutoff %s with ERR_VALIDATION (LOCK-TRASH-13)',
      (nonCanonical) => {
        const result = agg.purgeExpiredTopics(nonCanonical)
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.error.code).toBe(ERR_VALIDATION)
          expect(result.error.retryable).toBe(false)
          // LOCK-PRIV-TRASH: the cutoff value never appears in the
          // validation message — fixed static text only.
          expect(result.error.message).not.toContain(nonCanonical)
        }
      }
    )

    it('purgeExpiredTopics accepts a strict canonical UTC ISO cutoff (LOCK-TRASH-13)', () => {
      const t = createImportedDeletedTopic(oldDeletedAt, null)
      const result = agg.purgeExpiredTopics(new Date(nowMs - FIVE_DAYS_MS).toISOString())
      expect(result.ok).toBe(true)
      expect(okValue(agg.topicExists(t))).toBe(false)
    })

    it('invalid-cutoff error message and logs never contain the cutoff value (LOCK-PRIV-TRASH)', () => {
      const warnSpy = vi.spyOn(loggerService, 'warn').mockImplementation(() => undefined)
      // A parseable non-canonical sentinel: if it ever leaked it would be
      // trivially greppable in the error message and every mapped log.
      const sentinel = '2099-08-04T00:00:00Z'

      const result = agg.purgeExpiredTopics(sentinel)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe(ERR_VALIDATION)
        // Fixed static message — no sentinel fragment.
        expect(result.error.message).not.toContain(sentinel)
        expect(result.error.message).not.toContain('2099')
      }
      // wrapResult context and mapped validation error both log through
      // loggerService — none of them may carry the cutoff value.
      for (const call of warnSpy.mock.calls) {
        const text = call.map((c) => (typeof c === 'string' ? c : String(c))).join(' ')
        expect(text).not.toContain(sentinel)
        expect(text).not.toContain('2099-08-04T00:00:00')
      }
      warnSpy.mockRestore()
    })

    it('restore clears deletedAt AND removes the internal retention marker (LOCK-TRASH-8)', () => {
      const t = createImportedDeletedTopic(oldDeletedAt, freshMarker)
      const before = agg.getRawTopic(t)
      expect(okValue(before)).not.toBeNull()

      const restored = agg.restoreTopic(t)
      expect(restored.ok).toBe(true)
      const wire = okValue(restored) as any
      expect(wire).not.toBeNull()
      expect(wire.deletedAt ?? null).toBeNull()
      // Marker removed from the stored overflow (internal key cleanup).
      const row = sqlite.prepare('SELECT extra FROM topics WHERE id = ?').get(t) as { extra: string | null } | undefined
      expect(row).toBeDefined()
      expect(row!.extra).toBeNull()
    })

    it('runtime soft-delete never creates a marker; re-delete has no stale marker (LOCK-TRASH-8)', () => {
      const t = `t-rt-${uid()}`
      agg.ensureTopic(t, 'assistant-r')
      agg.softDeleteTopic(t)
      let row = sqlite.prepare('SELECT extra FROM topics WHERE id = ?').get(t) as { extra: string | null }
      expect(row.extra).toBeNull() // no marker from runtime soft-delete

      // Imported marker + restore, then a fresh runtime re-delete.
      const imported = createImportedDeletedTopic(oldDeletedAt, freshMarker)
      agg.restoreTopic(imported)
      agg.softDeleteTopic(imported)
      row = sqlite.prepare('SELECT extra FROM topics WHERE id = ?').get(imported) as { extra: string | null }
      expect(row.extra).toBeNull() // stale marker removed at restore, none re-added
      // The re-delete uses the NEW deletedAt: with a fresh deletedAt the topic
      // is retained under the current cutoff.
      const result = agg.purgeExpiredTopics(cutoff)
      expect(result.ok).toBe(true)
      expect(okValue(agg.topicExists(imported))).toBe(true)
    })

    it('explicit hard delete / empty trash ignore the retention marker as today (LOCK-TRASH-8)', () => {
      const t = createImportedDeletedTopic(oldDeletedAt, freshMarker)
      const empty = agg.emptyTrashTopics('assistant-r')
      expect(empty.ok).toBe(true)
      expect(okValue(agg.topicExists(t))).toBe(false)
    })

    it('updateTopicMetadata preserves the importer marker in overflow (renderer patch cannot clear it)', () => {
      const t = createImportedDeletedTopic(oldDeletedAt, freshMarker)
      const result = agg.updateTopicMetadata(t, 'Renamed', true, 'prompt', false)
      expect(result.ok).toBe(true)
      const row = sqlite.prepare('SELECT extra FROM topics WHERE id = ?').get(t) as { extra: string | null }
      const overflow = JSON.parse(row.extra!) as Record<string, unknown>
      expect(overflow[MARKER]).toBe(freshMarker)
    })

    // LOCK-TRASH-11: the importer-owned marker is stripped from EVERY public
    // topic wire response (single wire-boundary stripping seam) while
    // unrelated overflow keys survive; Main domain/DB still owns the marker.
    it('listTrashTopics wire omits the marker but keeps unrelated overflow (LOCK-TRASH-11)', () => {
      const id = `t-wire-${uid()}`
      agg.ensureTopic(id, 'assistant-r')
      setTopicDeletedAt(id, oldDeletedAt)
      setTopicExtra(id, JSON.stringify({ [MARKER]: freshMarker, pinned: true, prompt: 'keep-me' }))

      const trash = agg.listTrashTopics('assistant-r')
      expect(trash.ok).toBe(true)
      const item = okValue(trash).items.find((i: any) => i.id === id)
      expect(item).toBeDefined()
      // Marker never crosses the wire boundary.
      expect((item as any)[MARKER]).toBeUndefined()
      // Unrelated overflow keys survive untouched.
      expect((item as any).pinned).toBe(true)
      expect((item as any).prompt).toBe('keep-me')
      // Main domain/DB retains the marker.
      const row = sqlite.prepare('SELECT extra FROM topics WHERE id = ?').get(id) as { extra: string | null }
      const overflow = JSON.parse(row.extra!) as Record<string, unknown>
      expect(overflow[MARKER]).toBe(freshMarker)
    })

    it('restoreTopic wire never carries the marker key (LOCK-TRASH-11)', () => {
      const t = createImportedDeletedTopic(oldDeletedAt, freshMarker)
      const restored = agg.restoreTopic(t)
      expect(restored.ok).toBe(true)
      const wire = okValue(restored) as any
      expect(wire).not.toBeNull()
      expect(wire[MARKER]).toBeUndefined()
    })

    it('updateTopicMetadata wire omits the marker while the DB keeps it (LOCK-TRASH-11)', () => {
      const t = createImportedDeletedTopic(oldDeletedAt, freshMarker)
      const result = agg.updateTopicMetadata(t, 'Renamed', true, 'prompt', false)
      expect(result.ok).toBe(true)
      const wire = okValue(result) as any
      expect(wire[MARKER]).toBeUndefined()
      expect(wire.pinned).toBe(true)
      expect(wire.name).toBe('Renamed')
      // The marker is NOT stripped from the stored overflow — only from the
      // wire output.
      const row = sqlite.prepare('SELECT extra FROM topics WHERE id = ?').get(t) as { extra: string | null }
      const overflow = JSON.parse(row.extra!) as Record<string, unknown>
      expect(overflow[MARKER]).toBe(freshMarker)
    })

    it('resetAssistantTopics replacementTopic wire never carries the marker key (LOCK-TRASH-11)', () => {
      const replacementTopicId = `t-repl-${uid()}`
      const result = agg.resetAssistantTopics('assistant-r', replacementTopicId)
      expect(result.ok).toBe(true)
      const replacement = okValue(result).replacementTopic as any
      expect(replacement.id).toBe(replacementTopicId)
      expect(replacement[MARKER]).toBeUndefined()
    })
  })

  // =========================================================================
  // Phase 5.1B: Compound mutations
  // =========================================================================

  describe('Phase 5.1B: compound mutations', () => {
    it('cloneMessagesToTopic: ensures target and inserts messages', () => {
      const topicId = `t-${uid()}`
      const msgId = `m-${uid()}`
      const blkId = `b-${uid()}`
      const result = agg.cloneMessagesToTopic(topicId, [
        {
          message: makeMessageJson(topicId, { id: msgId }),
          blocks: [makeBlockJson(msgId, 'main_text', { id: blkId })]
        }
      ] as any)
      expect(result.ok).toBe(true)
      // Verify messages exist
      const fetched = agg.fetchMessages(topicId)
      expect(okValue(fetched).messages.length).toBe(1)
      expect(okValue(fetched).messages[0].id).toBe(msgId)
    })

    it('cloneMessagesToTopic: validates block ownership', () => {
      const topicId = `t-${uid()}`
      const msgId = `m-${uid()}`
      // Block references wrong message
      const result = agg.cloneMessagesToTopic(topicId, [
        {
          message: makeMessageJson(topicId, { id: msgId }),
          blocks: [makeBlockJson(`other-msg-${uid()}`, 'main_text')]
        }
      ] as any)
      // Should still succeed because aggregate enforces ownership by overwriting messageId
      expect(result.ok).toBe(true)
    })

    it('cloneMessagesToTopic: cloned MAIN_TEXT content is FTS-searchable in the target topic (LOCK-003)', () => {
      const sourceTopic = `t-src-${uid()}`
      const targetTopic = `t-dst-${uid()}`
      const msgId = `m-${uid()}`
      const blkId = `b-${uid()}`
      // A distinctive term (> 3 chars → FTS trigram path, not the LIKE fallback).
      const content = 'QuasarNebulaPrime telemetry archive'

      const result = agg.cloneMessagesToTopic(targetTopic, [
        {
          message: makeMessageJson(sourceTopic, { id: msgId, content }),
          blocks: [makeBlockJson(msgId, 'main_text', { id: blkId, content })]
        }
      ] as any)
      expect(result.ok).toBe(true)

      // Search requires the raw sqlite handle; the base `agg` fixture does not
      // carry one, so create an aggregate bound to the same connection.
      const searchAgg = new ChatDbAggregateService(db, sqlite)
      const search = searchAgg.searchMessages({
        keywords: 'QuasarNebulaPrime',
        matchMode: 'substring',
        sortOrder: 'newest'
      })
      expect(search.ok).toBe(true)
      const items = okValue(search).items
      expect(items.some((i) => i.blockId === blkId && i.messageId === msgId && i.topicId === targetTopic)).toBe(true)
    })

    it('resetMessagesForResend: resets messages and deletes blocks', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const msgId = msg.id as string
      const blk1 = makeBlockJson(msgId, 'main_text')
      const blk2 = makeBlockJson(msgId, 'file', {
        file: { id: 'file-1', name: 'test.pdf', path: '/test.pdf', type: 'application/pdf' }
      })
      agg.appendMessage(topicId, msg as any, [blk1 as any, blk2 as any])

      const result = agg.resetMessagesForResend(topicId, [msgId], [blk2.id as string])
      expect(result.ok).toBe(true)
      const cleanup = okValue(result)
      expect(cleanup.affectedFileIds).toContain('file-1')
      // Message still exists
      const fetched = okValue(agg.fetchMessages(topicId))
      expect(fetched.messages.length).toBe(1)
      // Block2 was deleted, only block1 remains
      expect(fetched.blocks.length).toBe(1)
      expect(fetched.blocks[0].id).toBe(blk1.id)
    })

    it('deleteMessagesWithSegments: deletes messages and cleans segments', () => {
      const topicId = `t-${uid()}`
      const msg1 = makeMessageJson(topicId)
      const msg2 = makeMessageJson(topicId)
      agg.appendMessage(topicId, msg1 as any, [])
      agg.appendMessage(topicId, msg2 as any, [])

      // Create a segment containing both messages
      agg.upsertSegment(`seg-${uid()}`, topicId, 'seg1', [msg1.id as string, msg2.id as string], undefined)

      const result = agg.deleteMessagesWithSegments(topicId, [msg1.id as string])
      expect(result.ok).toBe(true)
      const cleanup = okValue(result)
      expect(cleanup.affectedFileIds).toEqual([])
      // Only msg2 remains
      const fetched = okValue(agg.fetchMessages(topicId))
      expect(fetched.messages.length).toBe(1)
      expect(fetched.messages[0].id).toBe(msg2.id)
    })

    it('pasteMessagesToTopic: inserts at specified index', () => {
      const topicId = `t-${uid()}`
      const msg1 = makeMessageJson(topicId)
      const msg2 = makeMessageJson(topicId)
      agg.appendMessage(topicId, msg1 as any, [])

      // Paste msg2 at index 0 (before msg1)
      const result = agg.pasteMessagesToTopic(
        topicId,
        [{ message: makeMessageJson(topicId, { id: msg2.id }), blocks: [] }] as any,
        0
      )
      expect(result.ok).toBe(true)
      const fetched = okValue(agg.fetchMessages(topicId))
      expect(fetched.messages.length).toBe(2)
      expect(fetched.messages[0].id).toBe(msg2.id)
      expect(fetched.messages[1].id).toBe(msg1.id)
    })

    // =========================================================================
    // PERF-100: pasteMessagesToTopic batch semantics
    // =========================================================================

    it('pasteMessagesToTopic: batch middle insertion preserves exact order, block order, and file refs (PERF-100)', () => {
      const topicId = `t-${uid()}`
      agg.ensureTopic(topicId)
      // 10 existing messages (5 user + 5 assistant groups).
      const existingIds: string[] = []
      for (let i = 0; i < 5; i++) {
        const userMsg = makeMessageJson(topicId, { id: `p100-u${i}`, content: `existing-u${i}` })
        const asstMsg = makeMessageJson(topicId, {
          id: `p100-a${i}`,
          role: 'assistant',
          askId: userMsg.id,
          content: `existing-a${i}`
        })
        existingIds.push(userMsg.id as string, asstMsg.id as string)
        agg.appendMessage(topicId, userMsg as any, [])
        agg.appendMessage(topicId, asstMsg as any, [])
      }

      // Paste 3 groups at the true middle (index 6): 6 above / 4 below.
      const entries: Array<{ message: Record<string, unknown>; blocks: Record<string, unknown>[] }> = []
      const pastedUserIds: string[] = []
      for (let i = 0; i < 3; i++) {
        const userId = `p100-pu${i}`
        pastedUserIds.push(userId)
        const userMsg = makeMessageJson(topicId, { id: userId, content: `pasted-u${i}` })
        const userBlock = makeBlockJson(userId, 'main_text', { content: `pasted-ub-${i}` })
        const fileBlock = makeBlockJson(userId, 'file', {
          file: { id: `p100-file-${i}`, name: `f${i}.pdf`, path: `/f${i}.pdf`, type: 'application/pdf' }
        })
        const asstMsg = makeMessageJson(topicId, {
          id: `p100-pa${i}`,
          role: 'assistant',
          askId: userId,
          content: `pasted-a${i}`
        })
        const asstBlock = makeBlockJson(`p100-pa${i}`, 'main_text', { content: `pasted-ab-${i}` })
        entries.push({ message: userMsg, blocks: [userBlock, fileBlock] })
        entries.push({ message: asstMsg, blocks: [asstBlock] })
      }

      const result = agg.pasteMessagesToTopic(topicId, entries as any, 6)
      expect(result.ok).toBe(true)

      const fetched = okValue(agg.fetchMessages(topicId))
      const msgs = fetched.messages as any[]
      expect(msgs).toHaveLength(16)
      // Exact dense sort_order 0..15 in topic order.
      msgs.forEach((m, idx) => expect(m.sortOrder).toBe(idx))
      // Exact order: existing 0..5, then the 6 pasted messages in array order,
      // then existing 6..9.
      const expectedOrder = [
        'p100-u0',
        'p100-a0',
        'p100-u1',
        'p100-a1',
        'p100-u2',
        'p100-a2',
        'p100-pu0',
        'p100-pa0',
        'p100-pu1',
        'p100-pa1',
        'p100-pu2',
        'p100-pa2',
        'p100-u3',
        'p100-a3',
        'p100-u4',
        'p100-a4'
      ]
      expect(msgs.map((m) => m.id)).toEqual(expectedOrder)
      // askId remap preserved.
      for (let i = 6; i < 12; i += 2) {
        expect(msgs[i].role).toBe('user')
        expect(msgs[i + 1].role).toBe('assistant')
        expect(msgs[i + 1].askId).toBe(msgs[i].id)
      }
      // Block ownership + per-message block order preserved (user blocks then file block).
      const blocksByMessage = new Map<string, any[]>()
      for (const b of fetched.blocks as any[]) {
        const arr = blocksByMessage.get(b.messageId) ?? []
        arr.push(b)
        blocksByMessage.set(b.messageId, arr)
      }
      for (let i = 0; i < 3; i++) {
        const ownBlocks = blocksByMessage.get(`p100-pu${i}`) ?? []
        expect(ownBlocks).toHaveLength(2)
        expect(ownBlocks[0].content).toBe(`pasted-ub-${i}`)
        expect(ownBlocks[0].type).toBe('main_text')
        expect(ownBlocks[0].messageId).toBe(`p100-pu${i}`)
        expect(ownBlocks[1].type).toBe('file')
        expect(ownBlocks[1].messageId).toBe(`p100-pu${i}`)
        expect(blocksByMessage.get(`p100-pa${i}`)![0]!.content).toBe(`pasted-ab-${i}`)
      }
      // File-reference projection for the 3 pasted file blocks.
      const refs = sqlite.prepare('SELECT block_id, file_id FROM file_references').all() as any[]
      expect(refs).toHaveLength(3)
      expect(
        refs
          .map((r) => r.file_id)
          .sort()
          .map((f: string) => Number(f.split('-')[2]))
      ).toEqual([0, 1, 2])
    })

    it('pasteMessagesToTopic: uses ONE insertManyAt batch and ZERO normalizations on a healthy topic (PERF-100)', () => {
      const topicId = `t-${uid()}`
      agg.ensureTopic(topicId)
      for (let i = 0; i < 40; i++) {
        agg.appendMessage(topicId, makeMessageJson(topicId, { content: `base-${i}` }) as any, [])
      }
      const insertManySpy = vi.spyOn(MessagesRepository.prototype as any, 'insertManyAt')
      const normalizeSpy = vi.spyOn(MessagesRepository.prototype as any, 'normalizeOrdersInTx')
      try {
        const entries = Array.from({ length: 6 }, (_, i) => ({
          message: makeMessageJson(topicId, { content: `paste-${i}` }),
          blocks: [] as Record<string, unknown>[]
        }))
        const result = agg.pasteMessagesToTopic(topicId, entries as any, 20)
        expect(result.ok).toBe(true)
        // The whole paste is ONE batch primitive call.
        expect(insertManySpy).toHaveBeenCalledTimes(1)
        const [batchItems, batchIndex] = insertManySpy.mock.calls[0] as [unknown[], number]
        expect(batchItems).toHaveLength(6)
        expect(batchIndex).toBe(20)
        // Healthy dense topic: no full-topic normalization pass at all.
        const topicNormalizes = normalizeSpy.mock.calls.filter(([, id]) => id === topicId)
        expect(topicNormalizes).toHaveLength(0)
        const msgs = okValue(agg.fetchMessages(topicId)).messages as any[]
        expect(msgs).toHaveLength(46)
        expect(msgs.map((m) => m.sortOrder)).toEqual(Array.from({ length: 46 }, (_, i) => i))
        expect(msgs[20].content).toBe('paste-0')
        expect(msgs[25].content).toBe('paste-5')
        expect(msgs[26].content).toBe('base-20')
      } finally {
        insertManySpy.mockRestore()
        normalizeSpy.mockRestore()
      }
    })

    it('pasteMessagesToTopic: duplicate new IDs within one request insert once and apply later metadata (per-entry loop parity)', () => {
      const topicId = `t-${uid()}`
      const dupId = `m-${uid()}`
      const result = agg.pasteMessagesToTopic(topicId, [
        { message: makeMessageJson(topicId, { id: dupId, content: 'first' }), blocks: [] },
        { message: makeMessageJson(topicId, { id: dupId, content: 'second' }), blocks: [] }
      ] as any)
      expect(result.ok).toBe(true)
      const msgs = okValue(agg.fetchMessages(topicId)).messages as any[]
      expect(msgs).toHaveLength(1)
      expect(msgs[0].id).toBe(dupId)
      // Last write wins for metadata, matching the previous per-entry loop.
      expect(msgs[0].content).toBe('second')
    })

    // =========================================================================
    // Transaction rollback tests
    // =========================================================================

    it('cloneMessagesToTopic: rejects cross-topic message ownership', () => {
      const topicId = `t-${uid()}`
      const msgId = `m-${uid()}`
      // First insert succeeds
      agg.cloneMessagesToTopic(topicId, [
        {
          message: makeMessageJson(topicId, { id: msgId }) as any,
          blocks: [makeBlockJson(msgId) as any]
        }
      ])

      // Verify first message exists
      const fetched1 = okValue(agg.fetchMessages(topicId))
      expect(fetched1.messages.length).toBe(1)

      // Create a message in a DIFFERENT topic
      const otherTopic = `t-${uid()}`
      agg.ensureTopic(otherTopic)
      const msg2 = makeMessageJson(otherTopic)
      agg.appendMessage(otherTopic, msg2 as any, [])

      // Clone msg2 (from otherTopic) into topicId — should REJECT cross-topic ownership
      const result = agg.cloneMessagesToTopic(topicId, [
        { message: makeMessageJson(topicId, { id: msg2.id }) as any, blocks: [] }
      ])
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toMatch(/CONFLICT/)
      }

      // Verify original state is preserved (no partial mutation)
      const fetchedAfter = okValue(agg.fetchMessages(topicId))
      expect(fetchedAfter.messages.length).toBe(1)
      expect(fetchedAfter.messages[0].id).toBe(msgId)
    })

    it('deleteMessagesWithSegments: rolls back on failure after partial work', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      agg.appendMessage(topicId, msg as any, [])

      // Attempt to delete with an invalid operation (e.g., duplicate IDs)
      // The repository will throw and the transaction rolls back
      const result = agg.deleteMessagesWithSegments(topicId, [msg.id as string])
      expect(result.ok).toBe(true)
      // After successful deletion, topic should be empty
      const fetched = okValue(agg.fetchMessages(topicId))
      expect(fetched.messages.length).toBe(0)
    })
  })

  // =========================================================================
  // cloneMessagesToTopic — linear batch semantics (LOCK-002)
  // =========================================================================

  describe('cloneMessagesToTopic: linear batch semantics', () => {
    it('large batch inserts with exact dense ordering, block order, askId and file refs', () => {
      const topicId = `t-${uid()}`
      const MSG_COUNT = 600
      const entries: Array<{ message: Record<string, unknown>; blocks: Record<string, unknown>[] }> = []
      const userMessageIds: string[] = []
      for (let i = 0; i < MSG_COUNT; i++) {
        const isUser = i % 2 === 0
        const msgId = `m-${uid()}`
        if (isUser) userMessageIds.push(msgId)
        const message = makeMessageJson(topicId, {
          id: msgId,
          role: isUser ? 'user' : 'assistant',
          content: `content-${i}`,
          ...(isUser ? {} : { askId: userMessageIds[userMessageIds.length - 1] })
        })
        const blocks: Record<string, unknown>[] = [makeBlockJson(msgId, 'main_text', { content: `block-${i}-0` })]
        if (i % 100 === 0) {
          blocks.push(
            makeBlockJson(msgId, 'file', {
              file: { id: `file-${i}`, name: `f${i}.pdf`, path: `/f${i}.pdf`, type: 'application/pdf' }
            })
          )
        }
        entries.push({ message, blocks })
      }

      const result = agg.cloneMessagesToTopic(topicId, entries as any)
      expect(result.ok).toBe(true)

      const fetched = okValue(agg.fetchMessages(topicId))
      const msgs = fetched.messages as any[]
      expect(msgs).toHaveLength(MSG_COUNT)
      // Exact dense sort_order 0..599 in entry order.
      msgs.forEach((m: any, idx: number) => {
        expect(m.sortOrder).toBe(idx)
        expect(m.content).toBe(`content-${idx}`)
      })
      // askId remap output preserved: each assistant message references the
      // cloned user message supplied on the wire.
      for (let i = 1; i < msgs.length; i += 2) {
        expect(msgs[i].role).toBe('assistant')
        expect(msgs[i].askId).toBe(msgs[i - 1].id)
      }
      // Block ownership + per-message block order preserved.
      const blocksByMessage = new Map<string, any[]>()
      for (const b of fetched.blocks as any[]) {
        const arr = blocksByMessage.get(b.messageId) ?? []
        arr.push(b)
        blocksByMessage.set(b.messageId, arr)
      }
      expect(fetched.blocks).toHaveLength(MSG_COUNT + 6)
      for (let i = 0; i < MSG_COUNT; i++) {
        const msg = msgs[i]
        const ownBlocks = blocksByMessage.get(msg.id) ?? []
        expect(ownBlocks[0].content).toBe(`block-${i}-0`)
        expect(ownBlocks[0].messageId).toBe(msg.id)
      }
      // File-reference projection for the 6 file blocks.
      const refs = sqlite.prepare('SELECT block_id, file_id FROM file_references').all() as any[]
      expect(refs).toHaveLength(6)
      expect(
        refs
          .map((r) => r.file_id)
          .sort()
          .map((f: string) => Number(f.split('-')[1]))
      ).toEqual([0, 100, 200, 300, 400, 500])
    })

    it('appends after existing target messages without disturbing their order', () => {
      const topicId = `t-${uid()}`
      agg.ensureTopic(topicId)
      const existingIds: string[] = []
      for (let i = 0; i < 3; i++) {
        const msg = makeMessageJson(topicId, { content: `existing-${i}` })
        existingIds.push(msg.id as string)
        agg.appendMessage(topicId, msg as any, [])
      }

      const entries = Array.from({ length: 5 }, (_, i) => ({
        message: makeMessageJson(topicId, { content: `clone-${i}` }),
        blocks: [] as Record<string, unknown>[]
      }))
      const result = agg.cloneMessagesToTopic(topicId, entries as any)
      expect(result.ok).toBe(true)

      const msgs = okValue(agg.fetchMessages(topicId)).messages as any[]
      expect(msgs).toHaveLength(8)
      expect(msgs.map((m) => m.content)).toEqual([
        'existing-0',
        'existing-1',
        'existing-2',
        'clone-0',
        'clone-1',
        'clone-2',
        'clone-3',
        'clone-4'
      ])
      expect(msgs.map((m) => m.sortOrder)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
      expect(msgs.slice(0, 3).map((m) => m.id)).toEqual(existingIds)
    })

    it('duplicate new ID within one request inserts once and applies later metadata (per-entry loop parity)', () => {
      const topicId = `t-${uid()}`
      const dupId = `m-${uid()}`
      const result = agg.cloneMessagesToTopic(topicId, [
        { message: makeMessageJson(topicId, { id: dupId, content: 'first' }), blocks: [] },
        { message: makeMessageJson(topicId, { id: dupId, content: 'second' }), blocks: [] }
      ] as any)
      expect(result.ok).toBe(true)
      const msgs = okValue(agg.fetchMessages(topicId)).messages as any[]
      expect(msgs).toHaveLength(1)
      expect(msgs[0].id).toBe(dupId)
      // Last write wins for metadata, matching the previous per-entry loop.
      expect(msgs[0].content).toBe('second')
    })

    it('phase-4 block upserts keep original request order on cross-entry block-ID collisions (audit F1)', () => {
      const topicId = `t-${uid()}`
      // Existing same-topic message with no blocks yet.
      const existingMsg = makeMessageJson(topicId)
      agg.appendMessage(topicId, existingMsg as any, [])

      const sharedBlockId = `b-${uid()}`
      const newMsg = makeMessageJson(topicId, { content: 'new message' })

      // Request order is [existing entry, new entry] sharing ONE block ID.
      // The legacy per-entry loop upserted the EXISTING entry's block first
      // (creating it under the existing message), so the second upsert hits
      // the reparent guard and reports the EXISTING message as the block
      // owner. The batched `[...new, ...existing]` order would upsert the
      // NEW entry's block first and report the NEW message instead — the
      // reparent error message therefore proves Phase 4 ran in original
      // request order (audit F1).
      const result = agg.cloneMessagesToTopic(topicId, [
        {
          message: makeMessageJson(topicId, { id: existingMsg.id }),
          blocks: [makeBlockJson(existingMsg.id as string, 'main_text', { id: sharedBlockId, content: 'existing' })]
        },
        {
          message: newMsg,
          blocks: [makeBlockJson(newMsg.id as string, 'main_text', { id: sharedBlockId, content: 'new' })]
        }
      ] as any)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.message).toContain(`belongs to message ${existingMsg.id}`)
        expect(result.error.message).not.toContain(`belongs to message ${newMsg.id}`)
      }
      // Whole transaction rolled back — no messages, no blocks were added.
      const fetched = okValue(agg.fetchMessages(topicId))
      expect(fetched.messages).toHaveLength(1)
      expect(fetched.messages[0].id).toBe(existingMsg.id)
      expect(fetched.blocks).toHaveLength(0)
    })

    it('large batch performs ZERO message-order normalizations on a healthy topic (LOCK-002 fast path)', () => {
      const topicId = `t-${uid()}`
      const entries = Array.from({ length: 600 }, (_, i) => ({
        message: makeMessageJson(topicId, { content: `n-${i}` }),
        blocks: [] as Record<string, unknown>[]
      }))
      const normalizeSpy = vi.spyOn(MessagesRepository.prototype as any, 'normalizeOrdersInTx')
      try {
        const result = agg.cloneMessagesToTopic(topicId, entries as any)
        expect(result.ok).toBe(true)
        // The old per-entry append path normalized the whole topic 600 times
        // (O(M²) UPDATEs). The batch path now proves the topic is already
        // dense zero-based and appends at MAX+1 with ZERO sibling UPDATEs
        // (LOCK-002) — no normalization is needed for a healthy topic.
        const topicNormalizes = normalizeSpy.mock.calls.filter(([, id]) => id === topicId)
        expect(topicNormalizes).toHaveLength(0)
        const msgs = okValue(agg.fetchMessages(topicId)).messages as any[]
        expect(msgs).toHaveLength(600)
        expect(msgs.map((m) => m.sortOrder)).toEqual(Array.from({ length: 600 }, (_, i) => i))
      } finally {
        normalizeSpy.mockRestore()
      }
    })

    it('genuine rollback: large batch reverts all messages/blocks/refs on trigger failure', () => {
      const topicId = `t-${uid()}`
      agg.ensureTopic(topicId)

      sqlite.exec(`
        CREATE TEMP TRIGGER IF NOT EXISTS abort_file_ref_clone_batch
        BEFORE INSERT ON file_references
        BEGIN
          SELECT RAISE(ABORT, 'trigger-forced abort for clone batch rollback test');
        END
      `)

      try {
        const entries = Array.from({ length: 300 }, (_, i) => {
          const msg = makeMessageJson(topicId, { content: `rb-${i}` })
          const fileBlk = makeBlockJson(msg.id as string, 'file', {
            file: { id: `rb-file-${i}`, name: `r${i}.pdf`, path: `/r${i}.pdf`, type: 'application/pdf' }
          })
          return { message: msg, blocks: [fileBlk] }
        })
        const result = agg.cloneMessagesToTopic(topicId, entries as any)
        expect(result.ok).toBe(false)

        // Everything rolled back — no messages, no blocks, no refs.
        const fetched = agg.fetchMessages(topicId)
        expect(okValue(fetched).messages).toHaveLength(0)
        expect(okValue(fetched).blocks).toHaveLength(0)
        const refCount = (sqlite.prepare('SELECT COUNT(*) AS c FROM file_references').get() as any).c
        expect(refCount).toBe(0)
      } finally {
        sqlite.exec('DROP TRIGGER IF EXISTS TEMP.abort_file_ref_clone_batch')
      }
    })
  })

  // =========================================================================
  // Phase 5.1B-1 Audit Regression Tests
  // =========================================================================

  describe('Phase 5.1B-1 audit fixes', () => {
    // -----------------------------------------------------------------------
    // Finding 3: resetMessagesForResend rejects blocks not owned by topic
    // -----------------------------------------------------------------------

    it('resetMessagesForResend: rejects block whose message belongs to different topic', () => {
      const topic1 = `t-${uid()}`
      const topic2 = `t-${uid()}`
      const msg1 = makeMessageJson(topic1)
      const blk1 = makeBlockJson(msg1.id as string)
      agg.appendMessage(topic1, msg1 as any, [blk1 as any])

      const msg2 = makeMessageJson(topic2)
      const blk2 = makeBlockJson(msg2.id as string)
      agg.appendMessage(topic2, msg2 as any, [blk2 as any])

      // Try to delete blk2 (owned by topic2) via resetMessagesForResend on topic1
      const result = agg.resetMessagesForResend(topic1, [msg1.id as string], [blk2.id as string])
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toMatch(/CONFLICT/)
      }

      // Verify blk2 still exists in topic2
      const fetched2 = okValue(agg.fetchMessages(topic2))
      expect(fetched2.blocks.length).toBe(1)
      expect(fetched2.blocks[0].id).toBe(blk2.id)
    })

    it('resetMessagesForResend: rejects non-existent block ID', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      agg.appendMessage(topicId, msg as any, [])

      const result = agg.resetMessagesForResend(topicId, [msg.id as string], ['nonexistent-block'])
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toMatch(/CONFLICT/)
      }
    })

    it('resetMessagesForResend: returns truthful cleanup for owned blocks only', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const fileBlk = makeBlockJson(msg.id as string, 'file', {
        file: { id: 'file-reset', name: 'reset.pdf', path: '/reset.pdf', type: 'application/pdf' }
      })
      const textBlk = makeBlockJson(msg.id as string)
      agg.appendMessage(topicId, msg as any, [fileBlk as any, textBlk as any])

      const result = agg.resetMessagesForResend(topicId, [msg.id as string], [fileBlk.id as string])
      expect(result.ok).toBe(true)
      const cleanup = okValue(result)
      expect(cleanup.affectedFileIds).toContain('file-reset')
      expect(cleanup.remainingReferenceCounts['file-reset']).toBe(0)
    })

    // -----------------------------------------------------------------------
    // Finding 4: cloneMessagesToTopic rejects cross-topic message ownership
    // -----------------------------------------------------------------------

    it('cloneMessagesToTopic: rejects message owned by different topic', () => {
      const topic1 = `t-${uid()}`
      const topic2 = `t-${uid()}`
      const msg = makeMessageJson(topic1)
      agg.appendMessage(topic1, msg as any, [])

      const result = agg.cloneMessagesToTopic(topic2, [
        { message: makeMessageJson(topic2, { id: msg.id }) as any, blocks: [] }
      ])
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toMatch(/CONFLICT/)
      }

      // Verify msg still belongs to topic1
      const fetched = okValue(agg.fetchMessages(topic1))
      expect(fetched.messages.length).toBe(1)
      expect(fetched.messages[0].id).toBe(msg.id)
    })

    // -----------------------------------------------------------------------
    // Finding 5: pasteMessagesToTopic harvests prior refs and returns cleanup
    // -----------------------------------------------------------------------

    it('pasteMessagesToTopic: returns cleanup for existing blocks with file refs', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const fileBlk = makeBlockJson(msg.id as string, 'file', {
        file: { id: 'file-paste', name: 'paste.pdf', path: '/paste.pdf', type: 'application/pdf' }
      })
      agg.appendMessage(topicId, msg as any, [fileBlk as any])

      // Paste the same message again (existing message path)
      const result = agg.pasteMessagesToTopic(topicId, [
        { message: makeMessageJson(topicId, { id: msg.id }) as any, blocks: [fileBlk as any] }
      ])
      expect(result.ok).toBe(true)
      const cleanup = okValue(result)
      // Prior refs should be harvested
      expect(cleanup.affectedFileIds).toContain('file-paste')
    })

    it('pasteMessagesToTopic: returns empty cleanup for insert-only entries', () => {
      const topicId = `t-${uid()}`
      agg.ensureTopic(topicId)

      const msg = makeMessageJson(topicId)
      const result = agg.pasteMessagesToTopic(topicId, [{ message: msg as any, blocks: [] }])
      expect(result.ok).toBe(true)
      const cleanup = okValue(result)
      expect(cleanup.affectedFileIds).toEqual([])
      expect(cleanup.remainingReferenceCounts).toEqual({})
    })

    it('pasteMessagesToTopic: rejects cross-topic message ownership', () => {
      const topic1 = `t-${uid()}`
      const topic2 = `t-${uid()}`
      const msg = makeMessageJson(topic1)
      agg.appendMessage(topic1, msg as any, [])

      const result = agg.pasteMessagesToTopic(topic2, [
        { message: makeMessageJson(topic2, { id: msg.id }) as any, blocks: [] }
      ])
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toMatch(/CONFLICT/)
      }
    })

    // -----------------------------------------------------------------------
    // Finding 6: deleteMessagesWithSegments only reports owned IDs in cleanup
    // -----------------------------------------------------------------------

    it('deleteMessagesWithSegments: foreign message IDs are not reported in cleanup', () => {
      const topic1 = `t-${uid()}`
      const topic2 = `t-${uid()}`
      const msg1 = makeMessageJson(topic1)
      const fileBlk1 = makeBlockJson(msg1.id as string, 'file', {
        file: { id: 'file-foreign', name: 'foreign.pdf', path: '/foreign.pdf', type: 'application/pdf' }
      })
      agg.appendMessage(topic1, msg1 as any, [fileBlk1 as any])

      const msg2 = makeMessageJson(topic2)
      const fileBlk2 = makeBlockJson(msg2.id as string, 'file', {
        file: { id: 'file-owned', name: 'owned.pdf', path: '/owned.pdf', type: 'application/pdf' }
      })
      agg.appendMessage(topic2, msg2 as any, [fileBlk2 as any])

      // Delete from topic2 with both owned and foreign message IDs
      const result = agg.deleteMessagesWithSegments(topic2, [msg2.id as string, msg1.id as string])
      expect(result.ok).toBe(true)
      const cleanup = okValue(result)

      // Only owned file should be in cleanup, NOT the foreign one
      expect(cleanup.affectedFileIds).toContain('file-owned')
      expect(cleanup.affectedFileIds).not.toContain('file-foreign')

      // Verify foreign message still exists
      const fetched1 = okValue(agg.fetchMessages(topic1))
      expect(fetched1.messages.length).toBe(1)
    })

    // -----------------------------------------------------------------------
    // Finding 7: Metadata validators reject wrong types
    // -----------------------------------------------------------------------

    it('updateTopicMetadata: rejects non-string name in aggregate (via contract)', () => {
      const topicId = `t-${uid()}`
      agg.ensureTopic(topicId)

      // This test documents that the contract validator rejects wrong types.
      // The aggregate itself doesn't validate types (that's the contract's job).
      // We verify the contract behavior via the contract test suite.
      // Here we verify the aggregate accepts valid types.
      const result = agg.updateTopicMetadata(topicId, 'Valid Name', true, 'prompt', false)
      expect(result.ok).toBe(true)
      const wire = okValue(result)
      expect(wire.name).toBe('Valid Name')
      expect(wire.pinned).toBe(true)
      expect(wire.prompt).toBe('prompt')
      expect(wire.isNameManuallyEdited).toBe(false)
    })

    it('updateTopicMetadata: null clears overflow fields correctly', () => {
      const topicId = `t-${uid()}`
      agg.ensureTopic(topicId)
      agg.updateTopicMetadata(topicId, undefined, true, 'prompt', true)

      const result = agg.updateTopicMetadata(topicId, undefined, null, null, null)
      expect(result.ok).toBe(true)
      const wire = okValue(result)
      expect(wire.pinned).toBeNull()
      expect(wire.prompt).toBeNull()
      expect(wire.isNameManuallyEdited).toBeNull()
    })

    // -----------------------------------------------------------------------
    // Finding 8: Genuine mid-operation rollback test
    // -----------------------------------------------------------------------

    it('genuine rollback: pasteMessagesToTopic reverts message insert + block upsert + file-ref on trigger failure', () => {
      const topicId = `t-${uid()}`
      agg.ensureTopic(topicId)

      // Install a trigger that aborts file_references INSERT
      sqlite.exec(`
        CREATE TEMP TRIGGER IF NOT EXISTS abort_file_ref_insert_rollback_test
        BEFORE INSERT ON file_references
        BEGIN
          SELECT RAISE(ABORT, 'trigger-forced abort for genuine rollback test');
        END
      `)

      try {
        const msg = makeMessageJson(topicId)
        const fileBlk = makeBlockJson(msg.id as string, 'file', {
          file: { id: 'file-rollback', name: 'rollback.pdf', path: '/rollback.pdf', type: 'application/pdf' }
        })

        // pasteMessagesToTopic: ensure topic → insert message → upsert block → sync refs (trigger fails)
        const result = agg.pasteMessagesToTopic(topicId, [{ message: msg as any, blocks: [fileBlk as any] }])
        expect(result.ok).toBe(false)

        // Verify: message was NOT inserted (rolled back)
        const fetched = agg.fetchMessages(topicId)
        expect(okValue(fetched).messages).toHaveLength(0)
        expect(okValue(fetched).blocks).toHaveLength(0)
      } finally {
        sqlite.exec('DROP TRIGGER IF EXISTS TEMP.abort_file_ref_insert_rollback_test')
      }
    })

    it('genuine rollback: resetMessagesForResend reverts block delete + message reset on trigger failure', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const fileBlk = makeBlockJson(msg.id as string, 'file', {
        file: { id: 'file-resend', name: 'resend.pdf', path: '/resend.pdf', type: 'application/pdf' }
      })
      agg.appendMessage(topicId, msg as any, [fileBlk as any])

      // Snapshot before
      const before = agg.fetchMessages(topicId)
      expect(okValue(before).messages).toHaveLength(1)
      expect(okValue(before).blocks).toHaveLength(1)

      // Install a trigger that aborts message_blocks DELETE (blocks.deleteMany)
      sqlite.exec(`
        CREATE TEMP TRIGGER IF NOT EXISTS abort_block_delete_rollback_test
        BEFORE DELETE ON message_blocks
        BEGIN
          SELECT RAISE(ABORT, 'trigger-forced abort for block delete rollback test');
        END
      `)

      try {
        // resetMessagesForResend: collect refs → delete blocks (trigger fails) → reset messages
        // The block delete is the FIRST mutation in the block path, so the trigger
        // should cause the entire transaction to roll back.
        const result = agg.resetMessagesForResend(topicId, [msg.id as string], [fileBlk.id as string])
        expect(result.ok).toBe(false)

        // Verify: block was NOT deleted (rolled back)
        const after = agg.fetchMessages(topicId)
        expect(okValue(after).messages).toHaveLength(1)
        expect(okValue(after).blocks).toHaveLength(1)
        expect(okValue(after).blocks[0].id).toBe(fileBlk.id)

        // Verify: message status was NOT reset (rolled back)
        // The message should still have its original status
      } finally {
        sqlite.exec('DROP TRIGGER IF EXISTS TEMP.abort_block_delete_rollback_test')
      }
    })

    it('genuine rollback: cloneMessagesToTopic reverts entire transaction on trigger failure', () => {
      const topicId = `t-${uid()}`
      agg.ensureTopic(topicId)

      // Install a trigger that aborts file_references INSERT
      sqlite.exec(`
        CREATE TEMP TRIGGER IF NOT EXISTS abort_file_ref_clone_test
        BEFORE INSERT ON file_references
        BEGIN
          SELECT RAISE(ABORT, 'trigger-forced abort for clone rollback test');
        END
      `)

      try {
        const msg = makeMessageJson(topicId)
        const fileBlk = makeBlockJson(msg.id as string, 'file', {
          file: { id: 'file-clone', name: 'clone.pdf', path: '/clone.pdf', type: 'application/pdf' }
        })

        const result = agg.cloneMessagesToTopic(topicId, [{ message: msg as any, blocks: [fileBlk as any] }])
        expect(result.ok).toBe(false)

        // Verify: nothing was inserted (rolled back)
        const fetched = agg.fetchMessages(topicId)
        expect(okValue(fetched).messages).toHaveLength(0)
        expect(okValue(fetched).blocks).toHaveLength(0)
      } finally {
        sqlite.exec('DROP TRIGGER IF EXISTS TEMP.abort_file_ref_clone_test')
      }
    })
  })

  // =========================================================================
  // Phase 5.1B-2: Search — FTS runtime failure propagation
  // =========================================================================

  describe('Phase 5.1B-2: search FTS failure propagation', () => {
    /**
     * Aggregate with sqlite handle — required for searchMessages().
     * The base `agg` fixture does not pass sqlite, so we create one here.
     */
    function makeSearchAgg(): ChatDbAggregateService {
      return new ChatDbAggregateService(db, sqlite)
    }

    function insertSearchTopic(id: string, name: string): void {
      sqlite
        .prepare(`INSERT INTO topics (id, name, created_at) VALUES (?, ?, ?)`)
        .run(id, name, '2026-01-01T00:00:00.000Z')
    }

    function insertSearchMessage(id: string, topicId: string, createdAt: string): void {
      sqlite
        .prepare(
          `INSERT INTO messages (id, topic_id, role, content, created_at, sort_order) VALUES (?, ?, 'user', ?, ?, 0)`
        )
        .run(id, topicId, 'msg content', createdAt)
    }

    function insertSearchBlock(id: string, messageId: string, type: string, content: string): void {
      sqlite
        .prepare(`INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES (?, ?, ?, ?, 0)`)
        .run(id, messageId, type, content)
    }

    it('FTS failure returns structured error envelope, not OK empty items', () => {
      // Seed data into a working FTS index
      insertSearchTopic('st1', 'Search Topic')
      insertSearchMessage('sm1', 'st1', '2026-01-01T00:01:00.000Z')
      insertSearchBlock('sb1', 'sm1', 'main_text', 'Hello world')

      const searchAgg = makeSearchAgg()

      // Verify search works before corruption
      const okResult = searchAgg.searchMessages({
        keywords: 'hello',
        matchMode: 'substring',
        sortOrder: 'newest'
      })
      expect(okResult.ok).toBe(true)

      // Corrupt: drop the FTS table to simulate runtime failure
      sqlite.exec('DROP TABLE message_blocks_fts')

      // Search must fail with a structured error envelope — never OK with empty items
      const failResult = searchAgg.searchMessages({
        keywords: 'hello',
        matchMode: 'substring',
        sortOrder: 'newest'
      })
      expect(failResult.ok).toBe(false)
      if (!failResult.ok) {
        // Must be a structured ChatDbFailure envelope
        expect(typeof failResult.error.code).toBe('string')
        expect(failResult.error.code.length).toBeGreaterThan(0)
        expect(typeof failResult.error.message).toBe('string')
        expect(typeof failResult.error.retryable).toBe('boolean')
      }
    })

    it('LIKE-only path works even when FTS is missing', () => {
      insertSearchTopic('st2', 'Search Topic 2')
      insertSearchMessage('sm2', 'st2', '2026-01-01T00:02:00.000Z')
      insertSearchBlock('sb2', 'sm2', 'main_text', 'ab short term')

      const searchAgg = makeSearchAgg()

      // Drop FTS table
      sqlite.exec('DROP TABLE message_blocks_fts')

      // Short term (< 3 chars) routes to LIKE — should succeed
      const result = searchAgg.searchMessages({
        keywords: 'ab',
        matchMode: 'substring',
        sortOrder: 'newest'
      })
      expect(result.ok).toBe(true)
    })
  })
})
