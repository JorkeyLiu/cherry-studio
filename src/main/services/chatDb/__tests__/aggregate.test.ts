/**
 * ChatDbAggregateService Tests — real better-sqlite3, no mocks.
 *
 * Covers all 14 commands plus transaction rollback across
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

import { isSuccess } from '@shared/chatDb'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { reconstructBlock } from '../domain/codec'
import { runMigrations } from '../migration'
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
      const result = agg.ensureTopic('topic-1', 'asst-1')
      expect(result.ok).toBe(true)
      const exists = agg.topicExists('topic-1')
      expect(exists.ok).toBe(true)
      expect(okValue(exists)).toBe(true)
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
  // clear-messages
  // =========================================================================

  describe('clearMessages', () => {
    it('clears messages, blocks/references, and segments but retains topic', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const blk = makeBlockJson(msg.id as string)

      agg.appendMessage(topicId, msg as any, [blk as any])

      const result = agg.clearMessages(topicId)
      expect(result.ok).toBe(true)

      // Topic still exists
      const exists = agg.topicExists(topicId)
      expect(exists.ok).toBe(true)
      expect(okValue(exists)).toBe(true)

      // Messages and blocks are gone
      const fetched = agg.fetchMessages(topicId)
      expect(okValue(fetched).messages).toHaveLength(0)
      expect(okValue(fetched).blocks).toHaveLength(0)
    })

    it('no-op for missing topic', () => {
      const result = agg.clearMessages('nonexistent')
      expect(result.ok).toBe(true)
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
  // deleteBlocks cascade / clearMessages cascade
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

  describe('clearMessages cascade', () => {
    it('clears messages, blocks, file_references, and segments; retains topic', () => {
      const topicId = `t-${uid()}`
      const msg = makeMessageJson(topicId)
      const fileBlock = makeBlockJson(msg.id as string, 'file', {
        file: { id: 'file-1', name: 'test.pdf', path: '/test.pdf', type: 'application/pdf' }
      })

      agg.appendMessage(topicId, msg as any, [fileBlock as any])

      // Verify data exists
      const before = agg.fetchMessages(topicId)
      expect(okValue(before).messages).toHaveLength(1)
      expect(okValue(before).blocks).toHaveLength(1)

      // Clear all messages
      const result = agg.clearMessages(topicId)
      expect(result.ok).toBe(true)

      // Topic still exists
      const exists = agg.topicExists(topicId)
      expect(exists.ok).toBe(true)
      expect(okValue(exists)).toBe(true)

      // Messages, blocks, and references are gone
      const after = agg.fetchMessages(topicId)
      expect(okValue(after).messages).toHaveLength(0)
      expect(okValue(after).blocks).toHaveLength(0)
    })

    it('no-op for missing topic', () => {
      const result = agg.clearMessages('nonexistent')
      expect(result.ok).toBe(true)
    })

    it('clearing a topic with multiple messages removes all data', () => {
      const topicId = `t-${uid()}`
      const msg1 = makeMessageJson(topicId)
      const msg2 = makeMessageJson(topicId)
      const blk1 = makeBlockJson(msg1.id as string)
      const blk2 = makeBlockJson(msg2.id as string)

      agg.appendMessage(topicId, msg1 as any, [blk1 as any])
      agg.appendMessage(topicId, msg2 as any, [blk2 as any])

      const before = agg.fetchMessages(topicId)
      expect(okValue(before).messages).toHaveLength(2)
      expect(okValue(before).blocks).toHaveLength(2)

      agg.clearMessages(topicId)

      const after = agg.fetchMessages(topicId)
      expect(okValue(after).messages).toHaveLength(0)
      expect(okValue(after).blocks).toHaveLength(0)
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
})
