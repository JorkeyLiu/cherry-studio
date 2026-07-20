/**
 * Repository Tests — real better-sqlite3, no mocks.
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

import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { OVERFLOW_CLEAR, OVERFLOW_REMOVE } from '../domain/codec'
import { reconstructBlock } from '../domain/codec'
import {
  decodeNumericOrderCursor,
  decodeTopicTimestampCursor,
  encodeNumericOrderCursor,
  encodeTopicTimestampCursor
} from '../domain/cursor'
import type { FileReferenceData, MessageBlockData, MessageData, TopicData, TopicSegmentData } from '../domain/types'
import { runMigrations } from '../migration'
import { BlocksRepository } from '../repository/BlocksRepository'
import { FileReferencesRepository } from '../repository/FileReferencesRepository'
import { MessagesRepository } from '../repository/MessagesRepository'
import { TopicSegmentsRepository } from '../repository/TopicSegmentsRepository'
import { TopicsRepository } from '../repository/TopicsRepository'
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-repos-'))
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
  return `${++counter}-${Date.now()}`
}

function makeTopic(overrides?: Partial<TopicData>): TopicData {
  return {
    id: `t-${uid()}`,
    assistantId: 'asst-1',
    name: 'Test Topic',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
    overflow: { type: 'chat', pinned: false },
    ...overrides
  }
}
function makeMessage(overrides?: Partial<MessageData>): MessageData {
  return {
    id: `m-${uid()}`,
    topicId: 'topic-1',
    role: 'user',
    content: 'Hello',
    status: 'success',
    askId: null,
    model: 'gpt-4',
    modelId: 'gpt-4o',
    assistantId: 'asst-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sortOrder: 0,
    overflow: { usage: { tokens: 100 } },
    ...overrides
  }
}
function makeBlock(overrides?: Partial<MessageBlockData>): MessageBlockData {
  return {
    id: `b-${uid()}`,
    messageId: 'msg-1',
    type: 'main_text',
    content: 'Block content',
    status: 'success',
    createdAt: new Date().toISOString(),
    updatedAt: null,
    sortOrder: 0,
    overflow: {},
    ...overrides
  }
}
function makeSegment(overrides?: Partial<TopicSegmentData>): TopicSegmentData {
  return {
    id: `s-${uid()}`,
    topicId: 'topic-1',
    name: 'Segment 1',
    createdAt: new Date().toISOString(),
    updatedAt: null,
    sortOrder: 0,
    overflow: { color: '#FF0000' },
    ...overrides
  }
}
function makeFileRef(overrides?: Partial<FileReferenceData>): FileReferenceData {
  return {
    id: `fr-${uid()}`,
    blockId: 'block-1',
    fileId: 'file-1',
    fileName: 'doc.pdf',
    filePath: '/files/doc.pdf',
    fileType: 'file',
    count: 1,
    overflow: { size: 1024, tokens: 500 },
    ...overrides
  }
}

describe('Repository Tests', () => {
  let tempDir: string
  let sqlite: Database.Database
  let db: BetterSQLite3Database<typeof schema>
  let topicsRepo: TopicsRepository
  let messagesRepo: MessagesRepository
  let blocksRepo: BlocksRepository
  let segmentsRepo: TopicSegmentsRepository
  let fileRefsRepo: FileReferencesRepository

  beforeEach(() => {
    counter = 0
    tempDir = makeTempDir()
    sqlite = openTestDb(realPath.join(tempDir, 'test.db'))
    db = wrapDrizzle(sqlite)
    runMigrations(db, sqlite)
    topicsRepo = new TopicsRepository(db)
    messagesRepo = new MessagesRepository(db)
    blocksRepo = new BlocksRepository(db)
    segmentsRepo = new TopicSegmentsRepository(db)
    fileRefsRepo = new FileReferencesRepository(db)
    topicsRepo.create(makeTopic({ id: 'topic-1', name: 'Topic 1' }))
  })

  afterEach(() => {
    sqlite.close()
    rmrf(tempDir)
  })

  // ===========================================================================
  // TopicsRepository
  // ===========================================================================
  describe('TopicsRepository', () => {
    it('create and getById', () => {
      topicsRepo.create(makeTopic({ id: 'tp-1', name: 'Create Test' }))
      const r = topicsRepo.getById('tp-1')
      expect(r.found).toBe(true)
      if (r.found) {
        expect(r.data.name).toBe('Create Test')
        expect(r.data.overflow.type).toBe('chat')
      }
    })

    it('not-found returns false', () => {
      expect(topicsRepo.getById('nonexistent').found).toBe(false)
    })

    it('exists', () => {
      expect(topicsRepo.exists('topic-1')).toBe(true)
      expect(topicsRepo.exists('nonexistent')).toBe(false)
    })

    it('count with filters', () => {
      topicsRepo.create(makeTopic({ id: 'tp-2', assistantId: 'asst-2' }))
      expect(topicsRepo.count()).toBe(2)
      expect(topicsRepo.count({ assistantId: 'asst-1' })).toBe(1)
    })

    it('softDelete and restore clears deletedAt to NULL', () => {
      topicsRepo.softDelete('topic-1')
      const r = topicsRepo.getById('topic-1')
      expect(r.found).toBe(true)
      if (r.found) expect(r.data.deletedAt).not.toBeNull()

      topicsRepo.restore('topic-1')
      const r2 = topicsRepo.getById('topic-1')
      if (r2.found) expect(r2.data.deletedAt).toBeNull()
    })

    it('hardDelete', () => {
      topicsRepo.hardDelete('topic-1')
      expect(topicsRepo.exists('topic-1')).toBe(false)
    })

    it('updatePatch preserves unknown overflow keys', () => {
      topicsRepo.updatePatch('topic-1', { name: 'Updated', overflow: { newKey: 'value' } })
      const r = topicsRepo.getById('topic-1')
      if (r.found) {
        expect(r.data.name).toBe('Updated')
        expect(r.data.overflow.newKey).toBe('value')
        expect(r.data.overflow.type).toBe('chat') // preserved
      }
    })

    it('ensure creates or returns existing', () => {
      const r1 = topicsRepo.ensure('tp-ens')
      expect(r1.id).toBe('tp-ens')
      const r2 = topicsRepo.ensure('tp-ens')
      expect(r2.id).toBe('tp-ens')
    })

    it('upsert inserts then updates', () => {
      const c = topicsRepo.upsert(makeTopic({ id: 'tp-up', name: 'Original' }))
      expect(c.name).toBe('Original')
      const u = topicsRepo.upsert(makeTopic({ id: 'tp-up', name: 'Updated' }))
      expect(u.name).toBe('Updated')
    })

    it('createMany atomic', () => {
      const items = [makeTopic({ id: 'tp-m1' }), makeTopic({ id: 'tp-m2' })]
      const r = topicsRepo.createMany(items)
      expect(r).toHaveLength(2)
    })

    it('upsertMany atomic', () => {
      topicsRepo.create(makeTopic({ id: 'tp-um', name: 'Original' }))
      const r = topicsRepo.upsertMany([makeTopic({ id: 'tp-um', name: 'Updated' }), makeTopic({ id: 'tp-um2' })])
      expect(r).toHaveLength(2)
      const r2 = topicsRepo.getById('tp-um')
      expect(r2.found && r2.data.name).toBe('Updated')
    })

    it('deleteMany', () => {
      topicsRepo.create(makeTopic({ id: 'tp-d1' }))
      topicsRepo.create(makeTopic({ id: 'tp-d2' }))
      expect(topicsRepo.deleteMany(['tp-d1', 'tp-d2']).affected).toBe(2)
    })

    it('empty createMany returns empty', () => {
      expect(topicsRepo.createMany([])).toEqual([])
    })

    it('OVERFLOW_CLEAR removes all overflow', () => {
      topicsRepo.updatePatch('topic-1', { overflow: OVERFLOW_CLEAR })
      const r = topicsRepo.getById('topic-1')
      if (r.found) expect(r.data.overflow).toEqual({})
    })
  })

  // ===========================================================================
  // MessagesRepository
  // ===========================================================================
  describe('MessagesRepository', () => {
    it('create and getById', () => {
      messagesRepo.create(makeMessage({ id: 'msg-c1', topicId: 'topic-1' }))
      const r = messagesRepo.getById('msg-c1')
      expect(r.found).toBe(true)
      if (r.found) {
        expect(r.data.topicId).toBe('topic-1')
        expect(r.data.overflow.usage).toEqual({ tokens: 100 })
      }
    })

    it('validates topic ownership on create', () => {
      expect(() => messagesRepo.create(makeMessage({ id: 'msg-bad', topicId: 'nonexistent' }))).toThrow(
        'Topic nonexistent does not exist'
      )
    })

    it('getInTopic validates ownership', () => {
      messagesRepo.create(makeMessage({ id: 'msg-it', topicId: 'topic-1' }))
      expect(messagesRepo.getInTopic('msg-it', 'topic-1').found).toBe(true)
      expect(messagesRepo.getInTopic('msg-it', 'wrong').found).toBe(false)
    })

    it('findByIds preserves order', () => {
      messagesRepo.create(makeMessage({ id: 'msg-fa', topicId: 'topic-1', sortOrder: 0 }))
      messagesRepo.create(makeMessage({ id: 'msg-fb', topicId: 'topic-1', sortOrder: 1 }))
      const r = messagesRepo.findByIds(['msg-fb', 'msg-fa'])
      expect(r.map((m) => m.id)).toEqual(['msg-fb', 'msg-fa'])
    })

    it('listByTopic ordered by sortOrder', () => {
      messagesRepo.create(makeMessage({ id: 'msg-l1', topicId: 'topic-1', sortOrder: 0 }))
      messagesRepo.create(makeMessage({ id: 'msg-l2', topicId: 'topic-1', sortOrder: 1 }))
      const list = messagesRepo.listByTopic('topic-1')
      expect(list.map((m) => m.id)).toEqual(['msg-l1', 'msg-l2'])
    })

    it('append assigns max+1', () => {
      messagesRepo.create(makeMessage({ id: 'msg-a1', topicId: 'topic-1', sortOrder: 0 }))
      const appended = messagesRepo.append(makeMessage({ id: 'msg-a2', topicId: 'topic-1' }))
      expect(appended.sortOrder).toBe(1)
    })

    it('insertAt shifts existing', () => {
      messagesRepo.create(makeMessage({ id: 'msg-i1', topicId: 'topic-1', sortOrder: 0 }))
      messagesRepo.create(makeMessage({ id: 'msg-i2', topicId: 'topic-1', sortOrder: 1 }))
      messagesRepo.insertAt(makeMessage({ id: 'msg-in', topicId: 'topic-1' }), 1)
      const list = messagesRepo.listByTopic('topic-1')
      expect(list.map((m) => m.id)).toEqual(['msg-i1', 'msg-in', 'msg-i2'])
    })

    it('update with ownership validation', () => {
      messagesRepo.create(makeMessage({ id: 'msg-up', topicId: 'topic-1' }))
      expect(messagesRepo.update('topic-1', 'msg-up', { content: 'Updated' }).affected).toBe(1)
      const r2 = messagesRepo.getById('msg-up')
      expect(r2.found && r2.data.content).toBe('Updated')
    })

    it('replaceOrder validates completeness and reorders', () => {
      messagesRepo.create(makeMessage({ id: 'msg-r1', topicId: 'topic-1', sortOrder: 0 }))
      messagesRepo.create(makeMessage({ id: 'msg-r2', topicId: 'topic-1', sortOrder: 1 }))
      messagesRepo.create(makeMessage({ id: 'msg-r3', topicId: 'topic-1', sortOrder: 2 }))
      messagesRepo.replaceOrder('topic-1', ['msg-r3', 'msg-r1', 'msg-r2'])
      const list = messagesRepo.listByTopic('topic-1')
      expect(list.map((m) => m.id)).toEqual(['msg-r3', 'msg-r1', 'msg-r2'])
      expect(list.map((m) => m.sortOrder)).toEqual([0, 1, 2])
    })

    it('replaceOrder rejects duplicates', () => {
      messagesRepo.create(makeMessage({ id: 'msg-dup', topicId: 'topic-1' }))
      expect(() => messagesRepo.replaceOrder('topic-1', ['msg-dup', 'msg-dup'])).toThrow('Duplicate')
    })

    it('replaceOrder rejects foreign IDs', () => {
      messagesRepo.create(makeMessage({ id: 'msg-f1', topicId: 'topic-1' }))
      expect(() => messagesRepo.replaceOrder('topic-1', ['msg-f1', 'foreign'])).toThrow('does not belong')
    })

    it('replaceOrder rejects incomplete list', () => {
      messagesRepo.create(makeMessage({ id: 'msg-inc1', topicId: 'topic-1' }))
      messagesRepo.create(makeMessage({ id: 'msg-inc2', topicId: 'topic-1' }))
      expect(() => messagesRepo.replaceOrder('topic-1', ['msg-inc1'])).toThrow('Incomplete')
    })

    it('clearTopic deletes all messages', () => {
      messagesRepo.create(makeMessage({ id: 'msg-cl1', topicId: 'topic-1' }))
      messagesRepo.create(makeMessage({ id: 'msg-cl2', topicId: 'topic-1' }))
      expect(messagesRepo.clearTopic('topic-1').affected).toBe(2)
      expect(messagesRepo.countByTopic('topic-1')).toBe(0)
    })

    it('deleteMany', () => {
      messagesRepo.create(makeMessage({ id: 'msg-dm1', topicId: 'topic-1' }))
      messagesRepo.create(makeMessage({ id: 'msg-dm2', topicId: 'topic-1' }))
      expect(messagesRepo.deleteMany(['msg-dm1', 'msg-dm2']).affected).toBe(2)
    })

    it('empty createMany returns empty', () => {
      expect(messagesRepo.createMany([])).toEqual([])
    })
  })

  // ===========================================================================
  // BlocksRepository
  // ===========================================================================
  describe('BlocksRepository', () => {
    beforeEach(() => {
      messagesRepo.create(makeMessage({ id: 'msg-1', topicId: 'topic-1' }))
    })

    it('create and getById', () => {
      blocksRepo.create(makeBlock({ id: 'blk-1', messageId: 'msg-1' }))
      const r = blocksRepo.getById('blk-1')
      expect(r.found).toBe(true)
      if (r.found) expect(r.data.messageId).toBe('msg-1')
    })

    it('validates message ownership on create', () => {
      expect(() => blocksRepo.create(makeBlock({ id: 'blk-bad', messageId: 'nonexistent' }))).toThrow(
        'Message nonexistent does not exist'
      )
    })

    it('listByMessage', () => {
      blocksRepo.create(makeBlock({ id: 'blk-l1', messageId: 'msg-1', sortOrder: 0 }))
      blocksRepo.create(makeBlock({ id: 'blk-l2', messageId: 'msg-1', sortOrder: 1 }))
      expect(blocksRepo.listByMessage('msg-1')).toHaveLength(2)
    })

    it('listByMessages grouped', () => {
      messagesRepo.create(makeMessage({ id: 'msg-2', topicId: 'topic-1' }))
      blocksRepo.create(makeBlock({ id: 'blk-g1', messageId: 'msg-1' }))
      blocksRepo.create(makeBlock({ id: 'blk-g2', messageId: 'msg-2' }))
      const grouped = blocksRepo.listByMessages(['msg-1', 'msg-2'])
      expect(grouped.get('msg-1')).toHaveLength(1)
      expect(grouped.get('msg-2')).toHaveLength(1)
    })

    it('countByMessage', () => {
      blocksRepo.create(makeBlock({ id: 'blk-c1', messageId: 'msg-1' }))
      blocksRepo.create(makeBlock({ id: 'blk-c2', messageId: 'msg-1' }))
      expect(blocksRepo.countByMessage('msg-1')).toBe(2)
    })

    it('update with ownership validation', () => {
      blocksRepo.create(makeBlock({ id: 'blk-up', messageId: 'msg-1' }))
      expect(blocksRepo.update('msg-1', 'blk-up', { content: 'Updated' }).affected).toBe(1)
      const r2 = blocksRepo.getById('blk-up')
      expect(r2.found && r2.data.content).toBe('Updated')
    })

    it('delete cascades to file references', () => {
      blocksRepo.create(makeBlock({ id: 'blk-del', messageId: 'msg-1', type: 'file' }))
      fileRefsRepo.create(makeFileRef({ id: 'ref-del', blockId: 'blk-del' }))
      blocksRepo.delete('blk-del')
      expect(fileRefsRepo.getById('ref-del').found).toBe(false)
    })

    it('replaceMessageOrder reorders blocks', () => {
      blocksRepo.create(makeBlock({ id: 'blk-r1', messageId: 'msg-1', sortOrder: 0 }))
      blocksRepo.create(makeBlock({ id: 'blk-r2', messageId: 'msg-1', sortOrder: 1 }))
      blocksRepo.create(makeBlock({ id: 'blk-r3', messageId: 'msg-1', sortOrder: 2 }))
      blocksRepo.replaceMessageOrder('msg-1', ['blk-r3', 'blk-r1', 'blk-r2'])
      const list = blocksRepo.listByMessage('msg-1')
      expect(list.map((b) => b.id)).toEqual(['blk-r3', 'blk-r1', 'blk-r2'])
      expect(list.map((b) => b.sortOrder)).toEqual([0, 1, 2])
    })

    it('findByFileId via file_references join', () => {
      blocksRepo.create(makeBlock({ id: 'blk-f', messageId: 'msg-1', type: 'file' }))
      fileRefsRepo.create(makeFileRef({ id: 'ref-f', blockId: 'blk-f', fileId: 'file-abc' }))
      const found = blocksRepo.findByFileId('file-abc')
      expect(found).toHaveLength(1)
      expect(found[0].id).toBe('blk-f')
    })

    it('empty createMany returns empty', () => {
      expect(blocksRepo.createMany([])).toEqual([])
    })
  })

  // ===========================================================================
  // TopicSegmentsRepository
  // ===========================================================================
  describe('TopicSegmentsRepository', () => {
    it('create and getById with overflow', () => {
      segmentsRepo.create(makeSegment({ id: 'seg-1', topicId: 'topic-1' }))
      const r = segmentsRepo.getById('seg-1')
      expect(r.found).toBe(true)
      if (r.found) {
        expect(r.data.topicId).toBe('topic-1')
        expect(r.data.overflow.color).toBe('#FF0000')
      }
    })

    it('validates topic ownership', () => {
      expect(() => segmentsRepo.create(makeSegment({ id: 'seg-bad', topicId: 'nonexistent' }))).toThrow(
        'Topic nonexistent does not exist'
      )
    })

    it('listByTopic', () => {
      segmentsRepo.create(makeSegment({ id: 'seg-l1', topicId: 'topic-1', sortOrder: 0 }))
      segmentsRepo.create(makeSegment({ id: 'seg-l2', topicId: 'topic-1', sortOrder: 1 }))
      expect(segmentsRepo.listByTopic('topic-1')).toHaveLength(2)
    })

    it('addMessages validates topic membership', () => {
      messagesRepo.create(makeMessage({ id: 'msg-seg1', topicId: 'topic-1' }))
      topicsRepo.create(makeTopic({ id: 'topic-2' }))
      messagesRepo.create(makeMessage({ id: 'msg-seg2', topicId: 'topic-2' }))
      segmentsRepo.create(makeSegment({ id: 'seg-v', topicId: 'topic-1' }))
      expect(() => segmentsRepo.addMessages('seg-v', ['msg-seg1', 'msg-seg2'])).toThrow('does not belong to topic')
    })

    it('addMessages and getMessageIds', () => {
      messagesRepo.create(makeMessage({ id: 'msg-am1', topicId: 'topic-1' }))
      messagesRepo.create(makeMessage({ id: 'msg-am2', topicId: 'topic-1' }))
      segmentsRepo.create(makeSegment({ id: 'seg-am', topicId: 'topic-1' }))
      segmentsRepo.addMessages('seg-am', ['msg-am1', 'msg-am2'])
      expect(segmentsRepo.getMessageIds('seg-am')).toEqual(['msg-am1', 'msg-am2'])
    })

    it('removeMessage deletes empty segment', () => {
      messagesRepo.create(makeMessage({ id: 'msg-rm1', topicId: 'topic-1' }))
      segmentsRepo.create(makeSegment({ id: 'seg-rm', topicId: 'topic-1' }))
      segmentsRepo.addMessages('seg-rm', ['msg-rm1'])
      segmentsRepo.removeMessage('seg-rm', 'msg-rm1')
      expect(segmentsRepo.getById('seg-rm').found).toBe(false)
    })

    it('replaceMessageIds rejects duplicates', () => {
      messagesRepo.create(makeMessage({ id: 'msg-rd', topicId: 'topic-1' }))
      segmentsRepo.create(makeSegment({ id: 'seg-rd', topicId: 'topic-1' }))
      expect(() => segmentsRepo.replaceMessageIds('seg-rd', ['msg-rd', 'msg-rd'])).toThrow('Duplicate')
    })

    it('replaceMessageIds reorders', () => {
      messagesRepo.create(makeMessage({ id: 'msg-rep1', topicId: 'topic-1' }))
      messagesRepo.create(makeMessage({ id: 'msg-rep2', topicId: 'topic-1' }))
      segmentsRepo.create(makeSegment({ id: 'seg-rep', topicId: 'topic-1' }))
      segmentsRepo.addMessages('seg-rep', ['msg-rep1', 'msg-rep2'])
      segmentsRepo.replaceMessageIds('seg-rep', ['msg-rep2', 'msg-rep1'])
      expect(segmentsRepo.getMessageIds('seg-rep')).toEqual(['msg-rep2', 'msg-rep1'])
    })

    it('delete cascades to memberships', () => {
      messagesRepo.create(makeMessage({ id: 'msg-dc', topicId: 'topic-1' }))
      segmentsRepo.create(makeSegment({ id: 'seg-dc', topicId: 'topic-1' }))
      segmentsRepo.addMessages('seg-dc', ['msg-dc'])
      segmentsRepo.delete('seg-dc')
      expect(segmentsRepo.getMessageIds('seg-dc')).toHaveLength(0)
    })

    it('empty createMany returns empty', () => {
      expect(segmentsRepo.createMany([])).toEqual([])
    })
  })

  // ===========================================================================
  // FileReferencesRepository
  // ===========================================================================
  describe('FileReferencesRepository', () => {
    beforeEach(() => {
      messagesRepo.create(makeMessage({ id: 'msg-file', topicId: 'topic-1' }))
      blocksRepo.create(makeBlock({ id: 'block-file', messageId: 'msg-file', type: 'file' }))
    })

    it('create and getById preserves overflow', () => {
      fileRefsRepo.create(makeFileRef({ id: 'ref-1', blockId: 'block-file', fileId: 'file-1' }))
      const r = fileRefsRepo.getById('ref-1')
      expect(r.found).toBe(true)
      if (r.found) {
        expect(r.data.overflow.size).toBe(1024)
        expect(r.data.overflow.tokens).toBe(500)
      }
    })

    it('validates block ownership', () => {
      expect(() => fileRefsRepo.create(makeFileRef({ id: 'ref-bad', blockId: 'nonexistent' }))).toThrow(
        'Block nonexistent does not exist'
      )
    })

    it('listByBlock', () => {
      fileRefsRepo.create(makeFileRef({ id: 'ref-lb', blockId: 'block-file' }))
      expect(fileRefsRepo.listByBlock('block-file')).toHaveLength(1)
    })

    it('listByFile', () => {
      fileRefsRepo.create(makeFileRef({ id: 'ref-lf', blockId: 'block-file', fileId: 'file-shared' }))
      expect(fileRefsRepo.listByFile('file-shared')).toHaveLength(1)
    })

    it('listByMessage via block join', () => {
      fileRefsRepo.create(makeFileRef({ id: 'ref-lm', blockId: 'block-file' }))
      expect(fileRefsRepo.listByMessage('msg-file')).toHaveLength(1)
    })

    it('countByFile', () => {
      fileRefsRepo.create(makeFileRef({ id: 'ref-cf', blockId: 'block-file', fileId: 'file-count' }))
      expect(fileRefsRepo.countByFile('file-count')).toBe(1)
    })

    it('delete and deleteByBlock', () => {
      fileRefsRepo.create(makeFileRef({ id: 'ref-d1', blockId: 'block-file' }))
      expect(fileRefsRepo.delete('ref-d1').affected).toBe(1)
    })

    it('empty createMany returns empty', () => {
      expect(fileRefsRepo.createMany([])).toEqual([])
    })
  })

  // ===========================================================================
  // Cascade operations
  // ===========================================================================
  describe('Cascade operations', () => {
    it('topic delete cascades to messages', () => {
      messagesRepo.create(makeMessage({ id: 'msg-casc', topicId: 'topic-1' }))
      topicsRepo.hardDelete('topic-1')
      expect(messagesRepo.getById('msg-casc').found).toBe(false)
    })

    it('message delete cascades to blocks', () => {
      messagesRepo.create(makeMessage({ id: 'msg-casc', topicId: 'topic-1' }))
      blocksRepo.create(makeBlock({ id: 'blk-casc', messageId: 'msg-casc' }))
      messagesRepo.delete('msg-casc')
      expect(blocksRepo.getById('blk-casc').found).toBe(false)
    })

    it('block delete cascades to file references', () => {
      messagesRepo.create(makeMessage({ id: 'msg-casc', topicId: 'topic-1' }))
      blocksRepo.create(makeBlock({ id: 'blk-casc', messageId: 'msg-casc' }))
      fileRefsRepo.create(makeFileRef({ id: 'ref-casc', blockId: 'blk-casc' }))
      blocksRepo.delete('blk-casc')
      expect(fileRefsRepo.getById('ref-casc').found).toBe(false)
    })

    it('message delete cascades to segment memberships', () => {
      messagesRepo.create(makeMessage({ id: 'msg-sc', topicId: 'topic-1' }))
      segmentsRepo.create(makeSegment({ id: 'seg-sc', topicId: 'topic-1' }))
      segmentsRepo.addMessages('seg-sc', ['msg-sc'])
      messagesRepo.delete('msg-sc')
      expect(segmentsRepo.getMessageIds('seg-sc')).toHaveLength(0)
    })
  })

  // ===========================================================================
  // Overflow preservation
  // ===========================================================================
  describe('Overflow preservation', () => {
    it('preserves unknown keys through update', () => {
      topicsRepo.create(makeTopic({ id: 'tp-ov', overflow: { known: 'value', future: { nested: true } } }))
      topicsRepo.updatePatch('tp-ov', { name: 'Updated' })
      const r = topicsRepo.getById('tp-ov')
      if (r.found) {
        expect(r.data.overflow.known).toBe('value')
        expect(r.data.overflow.future).toEqual({ nested: true })
        expect(r.data.name).toBe('Updated')
      }
    })

    it('OVERFLOW_CLEAR removes all overflow', () => {
      topicsRepo.create(makeTopic({ id: 'tp-clr', overflow: { toClear: true, other: 'value' } }))
      topicsRepo.updatePatch('tp-clr', { overflow: OVERFLOW_CLEAR })
      const r = topicsRepo.getById('tp-clr')
      if (r.found) expect(r.data.overflow).toEqual({})
    })
  })

  // ===========================================================================
  // Pagination — multi-page ASC/DESC keyset traversal with ties
  // ===========================================================================
  describe('Pagination — keyset traversal', () => {
    it('ASC multi-page topic traversal with ties on createdAt', () => {
      const t1 = '2020-01-01T00:00:00.000Z'
      const t2 = '2020-01-02T00:00:00.000Z'
      const t3 = '2020-01-03T00:00:00.000Z'
      topicsRepo.create(makeTopic({ id: 'pg-a1', createdAt: t1, name: 'A1' }))
      topicsRepo.create(makeTopic({ id: 'pg-a2', createdAt: t1, name: 'A2' })) // tie on createdAt
      topicsRepo.create(makeTopic({ id: 'pg-b1', createdAt: t2, name: 'B1' }))
      topicsRepo.create(makeTopic({ id: 'pg-c1', createdAt: t3, name: 'C1' }))

      // ASC: earliest first. topic-1 has current time, test topics are 2020
      const page1 = topicsRepo.listPage({ limit: 2, direction: 'asc' })
      expect(page1.items).toHaveLength(2)
      expect(page1.hasMore).toBe(true)
      // 2020 dates come first (earliest)
      expect(page1.items[0].createdAt).toBe(t1)
      expect(page1.items[1].createdAt).toBe(t1)
      // Tie-break by id: pg-a1 < pg-a2
      expect(page1.items[0].id < page1.items[1].id).toBe(true)

      const page2 = topicsRepo.listPage({ cursor: page1.nextCursor, limit: 2, direction: 'asc' })
      expect(page2.items).toHaveLength(2)
      expect(page2.items[0].createdAt).toBe(t2)
      expect(page2.items[1].createdAt).toBe(t3)
    })

    it('DESC multi-page topic traversal', () => {
      topicsRepo.create(makeTopic({ id: 'dsc-1', createdAt: '2099-01-01T00:00:00.000Z' }))
      topicsRepo.create(makeTopic({ id: 'dsc-2', createdAt: '2099-01-02T00:00:00.000Z' }))
      topicsRepo.create(makeTopic({ id: 'dsc-3', createdAt: '2099-01-03T00:00:00.000Z' }))

      const page1 = topicsRepo.listPage({ limit: 2, direction: 'desc' })
      expect(page1.items).toHaveLength(2)
      expect(page1.hasMore).toBe(true)
      expect(page1.items[0].createdAt).toBe('2099-01-03T00:00:00.000Z')
      expect(page1.items[1].createdAt).toBe('2099-01-02T00:00:00.000Z')

      const page2 = topicsRepo.listPage({ cursor: page1.nextCursor, limit: 2, direction: 'desc' })
      expect(page2.items).toHaveLength(2)
      expect(page2.items[0].createdAt).toBe('2099-01-01T00:00:00.000Z')
      // topic-1 from beforeEach has a recent createdAt, comes next
    })

    it('trash page cursor-based DESC with assistant filter', () => {
      topicsRepo.create(
        makeTopic({
          id: 'tr-1',
          assistantId: 'asst-x',
          deletedAt: '2097-01-03T00:00:00.000Z',
          createdAt: '2097-01-01T00:00:00.000Z'
        })
      )
      topicsRepo.create(
        makeTopic({
          id: 'tr-2',
          assistantId: 'asst-y',
          deletedAt: '2097-01-03T00:00:00.000Z',
          createdAt: '2097-01-02T00:00:00.000Z'
        })
      )
      topicsRepo.create(
        makeTopic({
          id: 'tr-3',
          assistantId: 'asst-x',
          deletedAt: '2097-01-03T00:00:00.000Z',
          createdAt: '2097-01-03T00:00:00.000Z'
        })
      )

      // DESC with filter
      const page = topicsRepo.listTrashPage({ limit: 10, direction: 'desc' }, { assistantId: 'asst-x' })
      expect(page.items).toHaveLength(2)
      // DESC: tr-3 (t3) before tr-1 (t1)
      expect(page.items[0].id).toBe('tr-3')
      expect(page.items[1].id).toBe('tr-1')
    })

    it('trash page multi-page traversal', () => {
      for (let i = 0; i < 5; i++) {
        topicsRepo.create(
          makeTopic({
            id: `tp-${i}`,
            deletedAt: '2097-01-10T00:00:00.000Z',
            createdAt: `2097-01-0${i + 1}T00:00:00.000Z`
          })
        )
      }
      const page1 = topicsRepo.listTrashPage({ limit: 2, direction: 'desc' })
      expect(page1.items).toHaveLength(2)
      expect(page1.hasMore).toBe(true)
      const page2 = topicsRepo.listTrashPage({ cursor: page1.nextCursor, limit: 2, direction: 'desc' })
      expect(page2.items).toHaveLength(2)
      expect(page2.hasMore).toBe(true)
      const page3 = topicsRepo.listTrashPage({ cursor: page2.nextCursor, limit: 2, direction: 'desc' })
      expect(page3.items).toHaveLength(1)
      expect(page3.hasMore).toBe(false)
    })

    it('DESC multi-page message traversal with ties on sortOrder', () => {
      messagesRepo.create(makeMessage({ id: 'mp-0', topicId: 'topic-1', sortOrder: 0 }))
      messagesRepo.create(makeMessage({ id: 'mp-1', topicId: 'topic-1', sortOrder: 1 }))
      messagesRepo.create(makeMessage({ id: 'mp-2', topicId: 'topic-1', sortOrder: 2 }))

      const page1 = messagesRepo.listByTopicPage('topic-1', { limit: 2, direction: 'desc' })
      expect(page1.items).toHaveLength(2)
      expect(page1.hasMore).toBe(true)
      expect(page1.items[0].sortOrder).toBe(2)
      expect(page1.items[1].sortOrder).toBe(1)

      const page2 = messagesRepo.listByTopicPage('topic-1', { cursor: page1.nextCursor, limit: 2, direction: 'desc' })
      expect(page2.items).toHaveLength(1)
      expect(page2.hasMore).toBe(false)
      expect(page2.items[0].sortOrder).toBe(0)
    })

    it('DESC multi-page segment traversal', () => {
      segmentsRepo.create(makeSegment({ id: 'sp-0', topicId: 'topic-1', sortOrder: 0 }))
      segmentsRepo.create(makeSegment({ id: 'sp-1', topicId: 'topic-1', sortOrder: 1 }))
      segmentsRepo.create(makeSegment({ id: 'sp-2', topicId: 'topic-1', sortOrder: 2 }))

      const page1 = segmentsRepo.listByTopicPage('topic-1', { limit: 2, direction: 'desc' })
      expect(page1.items).toHaveLength(2)
      expect(page1.hasMore).toBe(true)
      expect(page1.items[0].sortOrder).toBe(2)

      const page2 = segmentsRepo.listByTopicPage('topic-1', { cursor: page1.nextCursor, limit: 2, direction: 'desc' })
      expect(page2.items).toHaveLength(1)
      expect(page2.hasMore).toBe(false)
    })

    it('malformed cursor throws in repository pagination', () => {
      expect(() => topicsRepo.listPage({ cursor: '!!!invalid!!!', limit: 10, direction: 'asc' })).toThrow()
      expect(() =>
        messagesRepo.listByTopicPage('topic-1', { cursor: 'bm90LWpzb24', limit: 10, direction: 'asc' })
      ).toThrow()
    })

    it('limit validation via repositories', () => {
      // Valid limits
      const r1 = topicsRepo.listPage({ limit: 1, direction: 'asc' })
      expect(r1.items.length).toBeLessThanOrEqual(1)
      // Clamped
      const r2 = topicsRepo.listPage({ limit: 999, direction: 'asc' })
      expect(r2.items.length).toBeLessThanOrEqual(100)
      // Invalid
      expect(() => topicsRepo.listPage({ limit: 0, direction: 'asc' })).toThrow()
      expect(() => topicsRepo.listPage({ limit: -1, direction: 'asc' })).toThrow()
    })
  })

  // ===========================================================================
  // Dense zero-based ordering
  // ===========================================================================
  describe('Dense zero-based ordering', () => {
    it('normalize sparse/negative/duplicate/large order via append+normalize', () => {
      // Manually insert messages with bad sort_order values
      sqlite
        .prepare(`INSERT INTO messages (id, topic_id, role, sort_order) VALUES (?, ?, ?, ?)`)
        .run('bad-1', 'topic-1', 'user', -5)
      sqlite
        .prepare(`INSERT INTO messages (id, topic_id, role, sort_order) VALUES (?, ?, ?, ?)`)
        .run('bad-2', 'topic-1', 'user', 100000)
      sqlite
        .prepare(`INSERT INTO messages (id, topic_id, role, sort_order) VALUES (?, ?, ?, ?)`)
        .run('bad-3', 'topic-1', 'user', -5) // duplicate

      // Append triggers normalization
      messagesRepo.append(makeMessage({ id: 'bad-4', topicId: 'topic-1' }))
      const list = messagesRepo.listByTopic('topic-1')
      expect(list.map((m) => m.sortOrder)).toEqual([0, 1, 2, 3])
    })

    it('insertAt beginning (index=0)', () => {
      messagesRepo.create(makeMessage({ id: 'ib-1', topicId: 'topic-1', sortOrder: 0 }))
      messagesRepo.create(makeMessage({ id: 'ib-2', topicId: 'topic-1', sortOrder: 1 }))
      messagesRepo.insertAt(makeMessage({ id: 'ib-new', topicId: 'topic-1' }), 0)
      const list = messagesRepo.listByTopic('topic-1')
      expect(list.map((m) => m.id)[0]).toBe('ib-new')
      expect(list.map((m) => m.sortOrder)).toEqual([0, 1, 2])
    })

    it('insertAt middle', () => {
      messagesRepo.create(makeMessage({ id: 'im-1', topicId: 'topic-1', sortOrder: 0 }))
      messagesRepo.create(makeMessage({ id: 'im-2', topicId: 'topic-1', sortOrder: 1 }))
      messagesRepo.insertAt(makeMessage({ id: 'im-new', topicId: 'topic-1' }), 1)
      const list = messagesRepo.listByTopic('topic-1')
      expect(list.map((m) => m.id)).toEqual(['im-1', 'im-new', 'im-2'])
      expect(list.map((m) => m.sortOrder)).toEqual([0, 1, 2])
    })

    it('insertAt end (index = count)', () => {
      messagesRepo.create(makeMessage({ id: 'ie-1', topicId: 'topic-1', sortOrder: 0 }))
      messagesRepo.create(makeMessage({ id: 'ie-2', topicId: 'topic-1', sortOrder: 1 }))
      messagesRepo.insertAt(makeMessage({ id: 'ie-new', topicId: 'topic-1' }), 2)
      const list = messagesRepo.listByTopic('topic-1')
      expect(list.map((m) => m.id)[2]).toBe('ie-new')
      expect(list.map((m) => m.sortOrder)).toEqual([0, 1, 2])
    })

    it('insertAt beyond length clamps to end', () => {
      messagesRepo.create(makeMessage({ id: 'ic-1', topicId: 'topic-1', sortOrder: 0 }))
      messagesRepo.insertAt(makeMessage({ id: 'ic-new', topicId: 'topic-1' }), 999)
      const list = messagesRepo.listByTopic('topic-1')
      expect(list.map((m) => m.id)).toEqual(['ic-1', 'ic-new'])
      expect(list.map((m) => m.sortOrder)).toEqual([0, 1])
    })

    it('insertAt rejects non-finite/non-integer/negative index', () => {
      messagesRepo.create(makeMessage({ id: 'ir-1', topicId: 'topic-1' }))
      expect(() => messagesRepo.insertAt(makeMessage({ id: 'ir-bad', topicId: 'topic-1' }), -1)).toThrow('Must be >= 0')
      expect(() => messagesRepo.insertAt(makeMessage({ id: 'ir-bad', topicId: 'topic-1' }), 1.5)).toThrow(
        'Must be an integer'
      )
      expect(() => messagesRepo.insertAt(makeMessage({ id: 'ir-bad', topicId: 'topic-1' }), Infinity)).toThrow(
        'Must be a finite number'
      )
    })

    it('delete normalizes sibling orders', () => {
      messagesRepo.create(makeMessage({ id: 'dn-1', topicId: 'topic-1', sortOrder: 0 }))
      messagesRepo.create(makeMessage({ id: 'dn-2', topicId: 'topic-1', sortOrder: 1 }))
      messagesRepo.create(makeMessage({ id: 'dn-3', topicId: 'topic-1', sortOrder: 2 }))
      messagesRepo.delete('dn-2')
      const list = messagesRepo.listByTopic('topic-1')
      expect(list.map((m) => m.sortOrder)).toEqual([0, 1])
      expect(list.map((m) => m.id)).toEqual(['dn-1', 'dn-3'])
    })

    it('deleteMany normalizes sibling orders', () => {
      messagesRepo.create(makeMessage({ id: 'dmn-1', topicId: 'topic-1', sortOrder: 0 }))
      messagesRepo.create(makeMessage({ id: 'dmn-2', topicId: 'topic-1', sortOrder: 1 }))
      messagesRepo.create(makeMessage({ id: 'dmn-3', topicId: 'topic-1', sortOrder: 2 }))
      messagesRepo.create(makeMessage({ id: 'dmn-4', topicId: 'topic-1', sortOrder: 3 }))
      messagesRepo.deleteMany(['dmn-1', 'dmn-3'])
      const list = messagesRepo.listByTopic('topic-1')
      expect(list.map((m) => m.sortOrder)).toEqual([0, 1])
      expect(list.map((m) => m.id)).toEqual(['dmn-2', 'dmn-4'])
    })

    it('existing-row upsertAt moves to requested position', () => {
      messagesRepo.create(makeMessage({ id: 'ua-1', topicId: 'topic-1', sortOrder: 0 }))
      messagesRepo.create(makeMessage({ id: 'ua-2', topicId: 'topic-1', sortOrder: 1 }))
      messagesRepo.create(makeMessage({ id: 'ua-3', topicId: 'topic-1', sortOrder: 2 }))

      // Move ua-3 to position 0
      messagesRepo.upsertAt(makeMessage({ id: 'ua-3', topicId: 'topic-1', content: 'moved' }), 0)
      const list = messagesRepo.listByTopic('topic-1')
      expect(list.map((m) => m.id)).toEqual(['ua-3', 'ua-1', 'ua-2'])
      expect(list.map((m) => m.sortOrder)).toEqual([0, 1, 2])
      // Content should be updated
      expect(list.find((m) => m.id === 'ua-3')?.content).toBe('moved')
    })

    it('upsertAt rejects cross-topic reparenting', () => {
      topicsRepo.create(makeTopic({ id: 'topic-2' }))
      messagesRepo.create(makeMessage({ id: 'rp-1', topicId: 'topic-1' }))
      expect(() => messagesRepo.upsertAt(makeMessage({ id: 'rp-1', topicId: 'topic-2' }), 0)).toThrow('cannot reparent')
    })

    it('block insertAt clamps and normalizes', () => {
      messagesRepo.create(makeMessage({ id: 'blk-msg', topicId: 'topic-1' }))
      blocksRepo.create(makeBlock({ id: 'bi-1', messageId: 'blk-msg', sortOrder: 0 }))
      blocksRepo.create(makeBlock({ id: 'bi-2', messageId: 'blk-msg', sortOrder: 1 }))
      blocksRepo.insertAt(makeBlock({ id: 'bi-new', messageId: 'blk-msg' }), 999)
      const list = blocksRepo.listByMessage('blk-msg')
      expect(list.map((b) => b.sortOrder)).toEqual([0, 1, 2])
    })

    it('block delete normalizes sibling orders', () => {
      messagesRepo.create(makeMessage({ id: 'bdn-msg', topicId: 'topic-1' }))
      blocksRepo.create(makeBlock({ id: 'bdn-1', messageId: 'bdn-msg', sortOrder: 0 }))
      blocksRepo.create(makeBlock({ id: 'bdn-2', messageId: 'bdn-msg', sortOrder: 1 }))
      blocksRepo.create(makeBlock({ id: 'bdn-3', messageId: 'bdn-msg', sortOrder: 2 }))
      blocksRepo.delete('bdn-1')
      const list = blocksRepo.listByMessage('bdn-msg')
      expect(list.map((b) => b.sortOrder)).toEqual([0, 1])
    })
  })

  // ===========================================================================
  // Replace-order with direct assignment
  // ===========================================================================
  describe('Replace-order direct assignment', () => {
    it('replaceOrder works without fixed-offset hack', () => {
      messagesRepo.create(makeMessage({ id: 'ro-1', topicId: 'topic-1', sortOrder: 0 }))
      messagesRepo.create(makeMessage({ id: 'ro-2', topicId: 'topic-1', sortOrder: 1 }))
      messagesRepo.create(makeMessage({ id: 'ro-3', topicId: 'topic-1', sortOrder: 2 }))
      messagesRepo.replaceOrder('topic-1', ['ro-3', 'ro-1', 'ro-2'])
      const list = messagesRepo.listByTopic('topic-1')
      expect(list.map((m) => m.id)).toEqual(['ro-3', 'ro-1', 'ro-2'])
      expect(list.map((m) => m.sortOrder)).toEqual([0, 1, 2])
    })

    it('replaceOrder works with pre-existing large/negative values', () => {
      sqlite
        .prepare(`INSERT INTO messages (id, topic_id, role, sort_order) VALUES (?, ?, ?, ?)`)
        .run('rpl-1', 'topic-1', 'user', -100000)
      sqlite
        .prepare(`INSERT INTO messages (id, topic_id, role, sort_order) VALUES (?, ?, ?, ?)`)
        .run('rpl-2', 'topic-1', 'user', 999999)
      messagesRepo.replaceOrder('topic-1', ['rpl-2', 'rpl-1'])
      const list = messagesRepo.listByTopic('topic-1')
      expect(list.map((m) => m.sortOrder)).toEqual([0, 1])
      expect(list.map((m) => m.id)).toEqual(['rpl-2', 'rpl-1'])
    })

    it('replaceOrder validates and rejects incomplete list', () => {
      messagesRepo.create(makeMessage({ id: 'rpi-1', topicId: 'topic-1' }))
      messagesRepo.create(makeMessage({ id: 'rpi-2', topicId: 'topic-1' }))
      expect(() => messagesRepo.replaceOrder('topic-1', ['rpi-1'])).toThrow('Incomplete')
    })
  })

  // ===========================================================================
  // Empty-segment cleanup
  // ===========================================================================
  describe('Empty-segment cleanup', () => {
    it('message delete cleans up empty segments', () => {
      messagesRepo.create(makeMessage({ id: 'es-1', topicId: 'topic-1' }))
      segmentsRepo.create(makeSegment({ id: 'es-seg', topicId: 'topic-1' }))
      segmentsRepo.addMessages('es-seg', ['es-1'])
      expect(segmentsRepo.getById('es-seg').found).toBe(true)

      messagesRepo.delete('es-1')
      // Segment should be auto-deleted since it's now empty
      expect(segmentsRepo.getById('es-seg').found).toBe(false)
    })

    it('message deleteMany cleans up empty segments', () => {
      messagesRepo.create(makeMessage({ id: 'esm-1', topicId: 'topic-1' }))
      messagesRepo.create(makeMessage({ id: 'esm-2', topicId: 'topic-1' }))
      segmentsRepo.create(makeSegment({ id: 'esm-seg', topicId: 'topic-1' }))
      segmentsRepo.addMessages('esm-seg', ['esm-1', 'esm-2'])

      messagesRepo.deleteMany(['esm-1', 'esm-2'])
      expect(segmentsRepo.getById('esm-seg').found).toBe(false)
    })

    it('clearTopic removes all segments', () => {
      messagesRepo.create(makeMessage({ id: 'ct-1', topicId: 'topic-1' }))
      messagesRepo.create(makeMessage({ id: 'ct-2', topicId: 'topic-1' }))
      segmentsRepo.create(makeSegment({ id: 'ct-seg', topicId: 'topic-1' }))
      segmentsRepo.addMessages('ct-seg', ['ct-1', 'ct-2'])

      messagesRepo.clearTopic('topic-1')
      expect(segmentsRepo.getById('ct-seg').found).toBe(false)
    })

    it('non-empty segment survives message deletion', () => {
      messagesRepo.create(makeMessage({ id: 'ne-1', topicId: 'topic-1' }))
      messagesRepo.create(makeMessage({ id: 'ne-2', topicId: 'topic-1' }))
      segmentsRepo.create(makeSegment({ id: 'ne-seg', topicId: 'topic-1' }))
      segmentsRepo.addMessages('ne-seg', ['ne-1', 'ne-2'])

      messagesRepo.delete('ne-1')
      // Segment should survive because ne-2 is still a member
      expect(segmentsRepo.getById('ne-seg').found).toBe(true)
      expect(segmentsRepo.getMessageIds('ne-seg')).toEqual(['ne-2'])
    })

    it('membership density after middle removal', () => {
      messagesRepo.create(makeMessage({ id: 'md-1', topicId: 'topic-1' }))
      messagesRepo.create(makeMessage({ id: 'md-2', topicId: 'topic-1' }))
      messagesRepo.create(makeMessage({ id: 'md-3', topicId: 'topic-1' }))
      segmentsRepo.create(makeSegment({ id: 'md-seg', topicId: 'topic-1' }))
      segmentsRepo.addMessages('md-seg', ['md-1', 'md-2', 'md-3'])
      // Remove middle message from segment
      segmentsRepo.removeMessages('md-seg', ['md-2'])
      // Surviving memberships must be dense 0,1
      expect(segmentsRepo.getMessageIds('md-seg')).toEqual(['md-1', 'md-3'])
    })

    it('membership density after message cascade', () => {
      messagesRepo.create(makeMessage({ id: 'mc-1', topicId: 'topic-1' }))
      messagesRepo.create(makeMessage({ id: 'mc-2', topicId: 'topic-1' }))
      messagesRepo.create(makeMessage({ id: 'mc-3', topicId: 'topic-1' }))
      segmentsRepo.create(makeSegment({ id: 'mc-seg', topicId: 'topic-1' }))
      segmentsRepo.addMessages('mc-seg', ['mc-1', 'mc-2', 'mc-3'])
      // Delete middle message via MessagesRepository (triggers cascade)
      messagesRepo.delete('mc-2')
      expect(segmentsRepo.getById('mc-seg').found).toBe(true)
      expect(segmentsRepo.getMessageIds('mc-seg')).toEqual(['mc-1', 'mc-3'])
    })
  })

  // ===========================================================================
  // File-reference upsert with incoming ID mismatch
  // ===========================================================================
  describe('File-reference upsert ID semantics', () => {
    beforeEach(() => {
      messagesRepo.create(makeMessage({ id: 'msg-fr', topicId: 'topic-1' }))
      blocksRepo.create(makeBlock({ id: 'blk-fr', messageId: 'msg-fr', type: 'file' }))
    })

    it('upsert preserves stored ID when (blockId, fileId) exists', () => {
      fileRefsRepo.create(makeFileRef({ id: 'stored-id', blockId: 'blk-fr', fileId: 'file-1', fileName: 'old.pdf' }))

      // Upsert with different incoming ID — stored ID should win
      const result = fileRefsRepo.upsert(
        makeFileRef({ id: 'incoming-id', blockId: 'blk-fr', fileId: 'file-1', fileName: 'new.pdf' })
      )
      expect(result.id).toBe('stored-id')
      expect(result.fileName).toBe('new.pdf')

      // Only one row should exist
      const all = fileRefsRepo.listByBlock('blk-fr')
      expect(all).toHaveLength(1)
      expect(all[0].id).toBe('stored-id')
    })

    it('upsertMany preserves stored IDs for existing pairs', () => {
      fileRefsRepo.create(makeFileRef({ id: 'stored-1', blockId: 'blk-fr', fileId: 'file-a' }))

      const results = fileRefsRepo.upsertMany([
        makeFileRef({ id: 'incoming-1', blockId: 'blk-fr', fileId: 'file-a', fileName: 'updated.pdf' }),
        makeFileRef({ id: 'new-id', blockId: 'blk-fr', fileId: 'file-b' })
      ])
      expect(results[0].id).toBe('stored-1') // preserved
      expect(results[0].fileName).toBe('updated.pdf')
      expect(results[1].id).toBe('new-id') // new insert
    })
  })

  // ===========================================================================
  // Identity / reparent patch rejection
  // ===========================================================================
  describe('Identity patch rejection', () => {
    it('topic updatePatch rejects id change', () => {
      topicsRepo.create(makeTopic({ id: 'id-t1' }))
      expect(() => topicsRepo.updatePatch('id-t1', { id: 'id-t2' } as any)).toThrow('Cannot change identity field "id"')
    })

    it('message update rejects id change', () => {
      messagesRepo.create(makeMessage({ id: 'id-m1', topicId: 'topic-1' }))
      expect(() => messagesRepo.update('topic-1', 'id-m1', { id: 'id-m2' } as any)).toThrow(
        'Cannot change identity field "id"'
      )
    })

    it('message update rejects topicId change', () => {
      messagesRepo.create(makeMessage({ id: 'id-mt', topicId: 'topic-1' }))
      expect(() => messagesRepo.update('topic-1', 'id-mt', { topicId: 'topic-2' } as any)).toThrow(
        'Cannot change identity field "topicId"'
      )
    })

    it('block update rejects id change', () => {
      messagesRepo.create(makeMessage({ id: 'id-bmsg', topicId: 'topic-1' }))
      blocksRepo.create(makeBlock({ id: 'id-b1', messageId: 'id-bmsg' }))
      expect(() => blocksRepo.update('id-bmsg', 'id-b1', { id: 'id-b2' } as any)).toThrow(
        'Cannot change identity field "id"'
      )
    })

    it('block update rejects messageId change', () => {
      messagesRepo.create(makeMessage({ id: 'id-bm1', topicId: 'topic-1' }))
      blocksRepo.create(makeBlock({ id: 'id-blk', messageId: 'id-bm1' }))
      expect(() => blocksRepo.update('id-bm1', 'id-blk', { messageId: 'other' } as any)).toThrow(
        'Cannot change identity field "messageId"'
      )
    })

    it('segment updateMetadata rejects id change', () => {
      segmentsRepo.create(makeSegment({ id: 'id-s1', topicId: 'topic-1' }))
      expect(() => segmentsRepo.updateMetadata('id-s1', { id: 'id-s2' } as any)).toThrow(
        'Cannot change identity field "id"'
      )
    })

    it('segment updateMetadata rejects topicId change', () => {
      segmentsRepo.create(makeSegment({ id: 'id-st', topicId: 'topic-1' }))
      expect(() => segmentsRepo.updateMetadata('id-st', { topicId: 'topic-2' } as any)).toThrow(
        'Cannot change identity field "topicId"'
      )
    })

    it('file-reference update rejects id/blockId/fileId changes', () => {
      messagesRepo.create(makeMessage({ id: 'id-fmsg', topicId: 'topic-1' }))
      blocksRepo.create(makeBlock({ id: 'id-fblk', messageId: 'id-fmsg' }))
      fileRefsRepo.create(makeFileRef({ id: 'id-fr1', blockId: 'id-fblk', fileId: 'file-1' }))
      expect(() => fileRefsRepo.update('id-fr1', { id: 'id-fr2' } as any)).toThrow('Cannot change identity field "id"')
      expect(() => fileRefsRepo.update('id-fr1', { blockId: 'other' } as any)).toThrow(
        'Cannot change identity field "blockId"'
      )
      expect(() => fileRefsRepo.update('id-fr1', { fileId: 'other' } as any)).toThrow(
        'Cannot change identity field "fileId"'
      )
    })

    it('allow same-value identity fields (no-op)', () => {
      topicsRepo.create(makeTopic({ id: 'id-same' }))
      // Setting id to same value should not throw
      expect(() => topicsRepo.updatePatch('id-same', { id: 'id-same' } as any)).not.toThrow()
    })
  })

  // ===========================================================================
  // Overflow merge/remove/clear and reconstructBlock
  // ===========================================================================
  describe('Overflow and reconstructBlock', () => {
    it('OVERFLOW_CLEAR exported from domain barrel', () => {
      expect(typeof OVERFLOW_CLEAR).toBe('symbol')
    })

    it('reconstructBlock restores tool object content from overflow', () => {
      const block: MessageBlockData = {
        id: 'b-tool',
        messageId: 'm1',
        type: 'tool',
        content: null,
        status: 'success',
        createdAt: '2026-01-01',
        updatedAt: null,
        sortOrder: 0,
        overflow: {
          toolId: 'tool-1',
          content: { results: [{ title: 'R1', url: 'https://example.com' }] }
        }
      }
      const plain = reconstructBlock(block)
      expect(plain.content).toEqual({ results: [{ title: 'R1', url: 'https://example.com' }] })
      expect(plain.status).toBe('success')
      expect((plain as any).toolId).toBe('tool-1')
    })

    it('reconstructBlock keeps string content for non-tool blocks', () => {
      const block: MessageBlockData = {
        id: 'b-text',
        messageId: 'm1',
        type: 'main_text',
        content: 'Hello',
        status: 'success',
        createdAt: '2026-01-01',
        updatedAt: null,
        sortOrder: 0,
        overflow: {}
      }
      const plain = reconstructBlock(block)
      expect(plain.content).toBe('Hello')
    })

    it('repository-level OVERFLOW_CLEAR removes all overflow', () => {
      topicsRepo.create(makeTopic({ id: 'ov-clear', overflow: { a: 1, b: 2 } }))
      topicsRepo.updatePatch('ov-clear', { overflow: OVERFLOW_CLEAR })
      const r = topicsRepo.getById('ov-clear')
      if (r.found) expect(r.data.overflow).toEqual({})
    })

    it('repository-level OVERFLOW_REMOVE removes individual keys', () => {
      topicsRepo.create(makeTopic({ id: 'ov-rm', overflow: { a: 1, b: 2, c: 3 } }))
      topicsRepo.updatePatch('ov-rm', { overflow: { b: OVERFLOW_REMOVE } })
      const r = topicsRepo.getById('ov-rm')
      if (r.found) {
        expect(r.data.overflow.a).toBe(1)
        expect(r.data.overflow.b).toBeUndefined()
        expect(r.data.overflow.c).toBe(3)
      }
    })
  })

  // ===========================================================================
  // Phase 2: Typed cursor cross-use rejection
  // ===========================================================================
  describe('Typed cursor cross-use rejection', () => {
    it('numeric-order cursor rejects topic-timestamp decode', () => {
      const cursor = encodeNumericOrderCursor(5, 'msg-1')
      expect(() => decodeTopicTimestampCursor(cursor)).toThrow(/kind mismatch/)
    })

    it('topic-timestamp cursor rejects numeric-order decode', () => {
      const cursor = encodeTopicTimestampCursor('2026-01-01T00:00:00.000Z', 'tp-1')
      expect(() => decodeNumericOrderCursor(cursor)).toThrow(/kind mismatch/)
    })

    it('numeric-order cursor round-trips correctly', () => {
      const encoded = encodeNumericOrderCursor(42, 'msg-abc')
      const decoded = decodeNumericOrderCursor(encoded)
      expect(decoded.sortOrder).toBe(42)
      expect(decoded.id).toBe('msg-abc')
    })

    it('topic-timestamp cursor round-trips correctly', () => {
      const encoded = encodeTopicTimestampCursor('2026-06-01T12:00:00.000Z', 'tp-abc')
      const decoded = decodeTopicTimestampCursor(encoded)
      expect(decoded.sortOrder).toBe('2026-06-01T12:00:00.000Z')
      expect(decoded.id).toBe('tp-abc')
    })

    it('topic-timestamp cursor handles empty sentinel for null createdAt', () => {
      const encoded = encodeTopicTimestampCursor('', 'tp-null')
      const decoded = decodeTopicTimestampCursor(encoded)
      expect(decoded.sortOrder).toBe('')
      expect(decoded.id).toBe('tp-null')
    })

    it('numeric cursor rejects non-integer sortOrder', () => {
      expect(() => encodeNumericOrderCursor(3.5, 'msg-1')).toThrow(/finite integer/)
    })

    it('malformed typed cursor throws in repository pagination', () => {
      // Wrong-kind cursor injected into topic pagination
      const wrongCursor = encodeNumericOrderCursor(0, 'x')
      expect(() => topicsRepo.listPage({ cursor: wrongCursor, limit: 10, direction: 'asc' })).toThrow(/kind mismatch/)
    })
  })

  // ===========================================================================
  // Phase 2: Active/trash disjointness
  // ===========================================================================
  describe('Active/trash disjointness', () => {
    it('active list excludes deleted topics', () => {
      topicsRepo.create(
        makeTopic({ id: 'ad-1', name: 'Active', deletedAt: null, createdAt: '2026-01-01T00:00:00.000Z' })
      )
      topicsRepo.create(
        makeTopic({
          id: 'ad-2',
          name: 'Deleted',
          deletedAt: '2026-06-01T00:00:00.000Z',
          createdAt: '2026-01-02T00:00:00.000Z'
        })
      )

      const active = topicsRepo.listPage({ limit: 100, direction: 'asc' })
      const activeIds = active.items.map((t) => t.id)
      expect(activeIds).toContain('ad-1')
      expect(activeIds).not.toContain('ad-2')

      const trash = topicsRepo.listTrashPage({ limit: 100, direction: 'desc' })
      const trashIds = trash.items.map((t) => t.id)
      expect(trashIds).toContain('ad-2')
      expect(trashIds).not.toContain('ad-1')
    })

    it('active and trash are fully disjoint', () => {
      for (let i = 0; i < 5; i++) {
        topicsRepo.create(
          makeTopic({
            id: `dis-a-${i}`,
            deletedAt: null,
            createdAt: `2026-01-0${i + 1}T00:00:00.000Z`
          })
        )
        topicsRepo.create(
          makeTopic({
            id: `dis-d-${i}`,
            deletedAt: '2026-06-01T00:00:00.000Z',
            createdAt: `2026-02-0${i + 1}T00:00:00.000Z`
          })
        )
      }
      const active = topicsRepo.listPage({ limit: 100, direction: 'asc' })
      const trash = topicsRepo.listTrashPage({ limit: 100, direction: 'desc' })
      const activeSet = new Set(active.items.map((t) => t.id))
      const trashSet = new Set(trash.items.map((t) => t.id))
      for (const id of activeSet) expect(trashSet.has(id)).toBe(false)
      for (const id of trashSet) expect(activeSet.has(id)).toBe(false)
    })
  })

  // ===========================================================================
  // Phase 2: Canonical/null legacy topic behavior
  // ===========================================================================
  describe('Canonical topic createdAt', () => {
    it('create canonicalizes null createdAt to valid ISO', () => {
      const r = topicsRepo.create(makeTopic({ id: 'cn-1', createdAt: null }))
      expect(r.createdAt).not.toBeNull()
      expect(r.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('listPage handles legacy null createdAt via COALESCE', () => {
      // Insert with raw SQL to simulate legacy null createdAt
      sqlite.prepare(`INSERT INTO topics (id, name, created_at) VALUES (?, ?, ?)`).run('leg-1', 'Legacy', null)
      const page = topicsRepo.listPage({ limit: 100, direction: 'asc' })
      const ids = page.items.map((t) => t.id)
      expect(ids).toContain('leg-1')
    })

    it('trashPage handles legacy null createdAt via COALESCE', () => {
      sqlite
        .prepare(`INSERT INTO topics (id, name, created_at, deleted_at) VALUES (?, ?, ?, ?)`)
        .run('leg-t', 'Legacy Trash', null, '2026-06-01T00:00:00.000Z')
      const page = topicsRepo.listTrashPage({ limit: 100, direction: 'desc' })
      const ids = page.items.map((t) => t.id)
      expect(ids).toContain('leg-t')
    })
  })

  // ===========================================================================
  // Phase 2: SortOrder rejection in ordinary patches
  // ===========================================================================
  describe('SortOrder rejection in ordinary patches', () => {
    it('message update rejects sortOrder change', () => {
      messagesRepo.create(makeMessage({ id: 'sr-1', topicId: 'topic-1' }))
      expect(() => messagesRepo.update('topic-1', 'sr-1', { sortOrder: 99 } as any)).toThrow(
        'Cannot change sortOrder via update'
      )
    })

    it('block update rejects sortOrder change', () => {
      messagesRepo.create(makeMessage({ id: 'sr-msg', topicId: 'topic-1' }))
      blocksRepo.create(makeBlock({ id: 'sr-blk', messageId: 'sr-msg' }))
      expect(() => blocksRepo.update('sr-msg', 'sr-blk', { sortOrder: 99 } as any)).toThrow(
        'Cannot change sortOrder via update'
      )
    })

    it('segment updateMetadata rejects sortOrder change', () => {
      segmentsRepo.create(makeSegment({ id: 'sr-seg', topicId: 'topic-1' }))
      expect(() => segmentsRepo.updateMetadata('sr-seg', { sortOrder: 99 } as any)).toThrow(
        'Cannot change sortOrder via update'
      )
    })

    it('non-sortOrder patches still work', () => {
      messagesRepo.create(makeMessage({ id: 'sr-ok', topicId: 'topic-1' }))
      expect(messagesRepo.update('topic-1', 'sr-ok', { content: 'Updated' }).affected).toBe(1)
    })
  })

  // ===========================================================================
  // Phase 2: Ownership across upserts
  // ===========================================================================
  describe('Ownership across upserts', () => {
    it('message upsertMany rejects topicId change on existing row', () => {
      topicsRepo.create(makeTopic({ id: 'own-t2' }))
      messagesRepo.create(makeMessage({ id: 'own-m1', topicId: 'topic-1' }))
      expect(() => messagesRepo.upsertMany([makeMessage({ id: 'own-m1', topicId: 'own-t2' })])).toThrow(
        'cannot reparent'
      )
    })

    it('block upsertMany rejects messageId change on existing row', () => {
      messagesRepo.create(makeMessage({ id: 'own-msg1', topicId: 'topic-1' }))
      messagesRepo.create(makeMessage({ id: 'own-msg2', topicId: 'topic-1' }))
      blocksRepo.create(makeBlock({ id: 'own-blk1', messageId: 'own-msg1' }))
      expect(() => blocksRepo.upsertMany([makeBlock({ id: 'own-blk1', messageId: 'own-msg2' })])).toThrow(
        'cannot reparent'
      )
    })

    it('segment upsertMany rejects topicId change on existing row', () => {
      topicsRepo.create(makeTopic({ id: 'own-t3' }))
      segmentsRepo.create(makeSegment({ id: 'own-seg1', topicId: 'topic-1' }))
      expect(() => segmentsRepo.upsertMany([makeSegment({ id: 'own-seg1', topicId: 'own-t3' })])).toThrow(
        'cannot reparent'
      )
    })

    it('upsertMany allows same-topic updates', () => {
      messagesRepo.create(makeMessage({ id: 'own-same', topicId: 'topic-1', content: 'original' }))
      const r = messagesRepo.upsertMany([makeMessage({ id: 'own-same', topicId: 'topic-1', content: 'updated' })])
      expect(r[0].content).toBe('updated')
    })
  })

  // ===========================================================================
  // Phase 2: Density tests for every mutation family
  // ===========================================================================
  describe('Dense ordering — all mutation families', () => {
    function getOrders(repo: MessagesRepository, topicId: string): number[] {
      return repo.listByTopic(topicId).map((m) => m.sortOrder)
    }

    it('create produces dense orders even with bad initial data', () => {
      sqlite
        .prepare(`INSERT INTO messages (id, topic_id, role, sort_order) VALUES (?, ?, ?, ?)`)
        .run('d-bad1', 'topic-1', 'user', -10)
      sqlite
        .prepare(`INSERT INTO messages (id, topic_id, role, sort_order) VALUES (?, ?, ?, ?)`)
        .run('d-bad2', 'topic-1', 'user', 500)
      messagesRepo.create(makeMessage({ id: 'd-new', topicId: 'topic-1' }))
      const orders = getOrders(messagesRepo, 'topic-1')
      expect(orders).toEqual([0, 1, 2])
    })

    it('createMany produces dense orders', () => {
      messagesRepo.createMany([
        makeMessage({ id: 'cm-1', topicId: 'topic-1', sortOrder: 10 }),
        makeMessage({ id: 'cm-2', topicId: 'topic-1', sortOrder: -5 }),
        makeMessage({ id: 'cm-3', topicId: 'topic-1', sortOrder: 100 })
      ])
      expect(getOrders(messagesRepo, 'topic-1')).toEqual([0, 1, 2])
    })

    it('upsertMany produces dense orders', () => {
      messagesRepo.create(makeMessage({ id: 'um-1', topicId: 'topic-1', sortOrder: 0 }))
      messagesRepo.create(makeMessage({ id: 'um-2', topicId: 'topic-1', sortOrder: 5 }))
      messagesRepo.upsertMany([
        makeMessage({ id: 'um-1', topicId: 'topic-1', sortOrder: 0 }),
        makeMessage({ id: 'um-2', topicId: 'topic-1', sortOrder: 5 }),
        makeMessage({ id: 'um-3', topicId: 'topic-1', sortOrder: 2 })
      ])
      expect(getOrders(messagesRepo, 'topic-1')).toEqual([0, 1, 2])
    })

    it('append produces dense orders', () => {
      sqlite
        .prepare(`INSERT INTO messages (id, topic_id, role, sort_order) VALUES (?, ?, ?, ?)`)
        .run('ap-bad', 'topic-1', 'user', 999)
      messagesRepo.append(makeMessage({ id: 'ap-new', topicId: 'topic-1' }))
      expect(getOrders(messagesRepo, 'topic-1')).toEqual([0, 1])
    })

    it('delete normalizes sibling orders', () => {
      messagesRepo.create(makeMessage({ id: 'del-1', topicId: 'topic-1', sortOrder: 0 }))
      messagesRepo.create(makeMessage({ id: 'del-2', topicId: 'topic-1', sortOrder: 1 }))
      messagesRepo.create(makeMessage({ id: 'del-3', topicId: 'topic-1', sortOrder: 2 }))
      messagesRepo.delete('del-2')
      expect(getOrders(messagesRepo, 'topic-1')).toEqual([0, 1])
    })

    it('deleteMany normalizes sibling orders', () => {
      for (let i = 0; i < 5; i++) {
        messagesRepo.create(makeMessage({ id: `dm-${i}`, topicId: 'topic-1', sortOrder: i }))
      }
      messagesRepo.deleteMany(['dm-1', 'dm-3'])
      expect(getOrders(messagesRepo, 'topic-1')).toEqual([0, 1, 2])
    })

    it('block createMany produces dense orders', () => {
      messagesRepo.create(makeMessage({ id: 'bcm-msg', topicId: 'topic-1' }))
      blocksRepo.createMany([
        makeBlock({ id: 'bcm-1', messageId: 'bcm-msg', sortOrder: 50 }),
        makeBlock({ id: 'bcm-2', messageId: 'bcm-msg', sortOrder: -1 })
      ])
      const blockOrders = blocksRepo.listByMessage('bcm-msg').map((b) => b.sortOrder)
      expect(blockOrders).toEqual([0, 1])
    })

    it('segment createMany produces dense orders', () => {
      segmentsRepo.createMany([
        makeSegment({ id: 'scm-1', topicId: 'topic-1', sortOrder: 100 }),
        makeSegment({ id: 'scm-2', topicId: 'topic-1', sortOrder: -50 })
      ])
      const segOrders = segmentsRepo.listByTopic('topic-1').map((s) => s.sortOrder)
      expect(segOrders).toEqual([0, 1])
    })
  })

  // ===========================================================================
  // Phase 2: upsertAt forward/backward moves on clean and corrupt orders
  // ===========================================================================
  describe('upsertAt forward/backward moves', () => {
    it('backward move: move last to first', () => {
      messagesRepo.create(makeMessage({ id: 'uf-1', topicId: 'topic-1', sortOrder: 0 }))
      messagesRepo.create(makeMessage({ id: 'uf-2', topicId: 'topic-1', sortOrder: 1 }))
      messagesRepo.create(makeMessage({ id: 'uf-3', topicId: 'topic-1', sortOrder: 2 }))
      messagesRepo.upsertAt(makeMessage({ id: 'uf-3', topicId: 'topic-1' }), 0)
      const list = messagesRepo.listByTopic('topic-1')
      expect(list.map((m) => m.id)).toEqual(['uf-3', 'uf-1', 'uf-2'])
      expect(list.map((m) => m.sortOrder)).toEqual([0, 1, 2])
    })

    it('forward move: move first to last', () => {
      messagesRepo.create(makeMessage({ id: 'uf-1', topicId: 'topic-1', sortOrder: 0 }))
      messagesRepo.create(makeMessage({ id: 'uf-2', topicId: 'topic-1', sortOrder: 1 }))
      messagesRepo.create(makeMessage({ id: 'uf-3', topicId: 'topic-1', sortOrder: 2 }))
      messagesRepo.upsertAt(makeMessage({ id: 'uf-1', topicId: 'topic-1' }), 2)
      const list = messagesRepo.listByTopic('topic-1')
      expect(list.map((m) => m.id)).toEqual(['uf-2', 'uf-3', 'uf-1'])
      expect(list.map((m) => m.sortOrder)).toEqual([0, 1, 2])
    })

    it('move on corrupt orders (negative/duplicate/large)', () => {
      sqlite
        .prepare(`INSERT INTO messages (id, topic_id, role, sort_order) VALUES (?, ?, ?, ?)`)
        .run('uc-1', 'topic-1', 'user', -100)
      sqlite
        .prepare(`INSERT INTO messages (id, topic_id, role, sort_order) VALUES (?, ?, ?, ?)`)
        .run('uc-2', 'topic-1', 'user', -100)
      sqlite
        .prepare(`INSERT INTO messages (id, topic_id, role, sort_order) VALUES (?, ?, ?, ?)`)
        .run('uc-3', 'topic-1', 'user', 99999)
      messagesRepo.upsertAt(makeMessage({ id: 'uc-3', topicId: 'topic-1' }), 0)
      const list = messagesRepo.listByTopic('topic-1')
      expect(list.map((m) => m.sortOrder)).toEqual([0, 1, 2])
      expect(list[0].id).toBe('uc-3')
    })

    it('upsertAt new item at index 0', () => {
      messagesRepo.create(makeMessage({ id: 'un-1', topicId: 'topic-1', sortOrder: 0 }))
      messagesRepo.upsertAt(makeMessage({ id: 'un-new', topicId: 'topic-1' }), 0)
      const list = messagesRepo.listByTopic('topic-1')
      expect(list.map((m) => m.id)).toEqual(['un-new', 'un-1'])
    })
  })

  // ===========================================================================
  // Phase 2: Rollback tests using native SQLite aborting triggers
  // ===========================================================================
  describe('Rollback tests — native SQLite abort triggers', () => {
    it('createMany rollback preserves original state', () => {
      messagesRepo.create(makeMessage({ id: 'rb-1', topicId: 'topic-1', sortOrder: 0 }))
      messagesRepo.create(makeMessage({ id: 'rb-2', topicId: 'topic-1', sortOrder: 1 }))

      // Trigger allows rb-new-1 insert to succeed, then aborts on rb-new-2.
      // This proves the first insert completed before the second aborted,
      // and transaction rollback undoes both.
      sqlite.exec(`
        CREATE TEMPORARY TRIGGER IF NOT EXISTS abort_after_insert
        AFTER INSERT ON messages
        WHEN NEW.id = 'rb-new-2'
        BEGIN
          SELECT RAISE(ABORT, 'intentional abort');
        END
      `)

      expect(() =>
        messagesRepo.createMany([
          makeMessage({ id: 'rb-new-1', topicId: 'topic-1' }),
          makeMessage({ id: 'rb-new-2', topicId: 'topic-1' })
        ])
      ).toThrow()

      // Original data must be unchanged — rb-new-1 insert was rolled back
      expect(messagesRepo.countByTopic('topic-1')).toBe(2)
      const list = messagesRepo.listByTopic('topic-1')
      expect(list.map((m) => m.id)).toEqual(['rb-1', 'rb-2'])
      expect(list.map((m) => m.sortOrder)).toEqual([0, 1])

      sqlite.exec('DROP TRIGGER IF EXISTS abort_after_insert')
    })

    it('upsertMany rollback preserves original state', () => {
      messagesRepo.create(makeMessage({ id: 'ru-1', topicId: 'topic-1', sortOrder: 0, content: 'original' }))
      messagesRepo.create(makeMessage({ id: 'ru-2', topicId: 'topic-1', sortOrder: 1, content: 'keep' }))

      sqlite.exec(`
        CREATE TEMPORARY TRIGGER IF NOT EXISTS abort_upsert
        AFTER UPDATE ON messages
        WHEN NEW.content = 'corrupt'
        BEGIN
          SELECT RAISE(ABORT, 'intentional abort');
        END
      `)

      // First item succeeds (normal update), second item triggers abort
      expect(() =>
        messagesRepo.upsertMany([
          makeMessage({ id: 'ru-1', topicId: 'topic-1', content: 'changed' }),
          makeMessage({ id: 'ru-2', topicId: 'topic-1', content: 'corrupt' })
        ])
      ).toThrow()

      // Both must be rolled back to original state
      const r1 = messagesRepo.getById('ru-1')
      expect(r1.found && r1.data.content).toBe('original')
      const r2 = messagesRepo.getById('ru-2')
      expect(r2.found && r2.data.content).toBe('keep')

      sqlite.exec('DROP TRIGGER IF EXISTS abort_upsert')
    })

    it('replaceOrder rollback preserves original order', () => {
      messagesRepo.create(makeMessage({ id: 'rr-1', topicId: 'topic-1', sortOrder: 0 }))
      messagesRepo.create(makeMessage({ id: 'rr-2', topicId: 'topic-1', sortOrder: 1 }))
      messagesRepo.create(makeMessage({ id: 'rr-3', topicId: 'topic-1', sortOrder: 2 }))

      // assignDenseOrders processes IDs in array order: rr-3→0, rr-1→1, rr-2→2.
      // Trigger fires on rr-1 update, so rr-3's reorder (2→0) completes first.
      // This proves at least one order update succeeded before the abort.
      sqlite.exec(`
        CREATE TEMPORARY TRIGGER IF NOT EXISTS abort_reorder
        AFTER UPDATE ON messages
        WHEN NEW.id = 'rr-1' AND OLD.sort_order != NEW.sort_order
        BEGIN
          SELECT RAISE(ABORT, 'intentional abort on reorder');
        END
      `)

      expect(() => messagesRepo.replaceOrder('topic-1', ['rr-3', 'rr-1', 'rr-2'])).toThrow()

      // Original order must be preserved (transaction rolled back)
      const list = messagesRepo.listByTopic('topic-1')
      expect(list.map((m) => m.id)).toEqual(['rr-1', 'rr-2', 'rr-3'])
      expect(list.map((m) => m.sortOrder)).toEqual([0, 1, 2])

      sqlite.exec('DROP TRIGGER IF EXISTS abort_reorder')
    })

    it('file-reference batch upsert rollback preserves state', () => {
      messagesRepo.create(makeMessage({ id: 'frb-msg', topicId: 'topic-1' }))
      blocksRepo.create(makeBlock({ id: 'frb-blk', messageId: 'frb-msg', type: 'file' }))
      fileRefsRepo.create(
        makeFileRef({ id: 'frb-1', blockId: 'frb-blk', fileId: 'file-orig', fileName: 'original.pdf' })
      )
      fileRefsRepo.create(makeFileRef({ id: 'frb-2', blockId: 'frb-blk', fileId: 'file-keep', fileName: 'keep.pdf' }))

      sqlite.exec(`
        CREATE TEMPORARY TRIGGER IF NOT EXISTS abort_fileref
        AFTER UPDATE ON file_references
        WHEN NEW.file_name = 'corrupt.pdf'
        BEGIN
          SELECT RAISE(ABORT, 'intentional abort');
        END
      `)

      // First item succeeds (update), second item triggers abort
      expect(() =>
        fileRefsRepo.upsertMany([
          makeFileRef({ id: 'frb-1', blockId: 'frb-blk', fileId: 'file-orig', fileName: 'changed.pdf' }),
          makeFileRef({ id: 'frb-2', blockId: 'frb-blk', fileId: 'file-keep', fileName: 'corrupt.pdf' })
        ])
      ).toThrow()

      // Both must be rolled back
      const r1 = fileRefsRepo.getById('frb-1')
      expect(r1.found && r1.data.fileName).toBe('original.pdf')
      const r2 = fileRefsRepo.getById('frb-2')
      expect(r2.found && r2.data.fileName).toBe('keep.pdf')

      sqlite.exec('DROP TRIGGER IF EXISTS abort_fileref')
    })

    it('membership replacement rollback preserves state', () => {
      messagesRepo.create(makeMessage({ id: 'sm-1', topicId: 'topic-1' }))
      messagesRepo.create(makeMessage({ id: 'sm-2', topicId: 'topic-1' }))
      segmentsRepo.create(makeSegment({ id: 'sm-seg', topicId: 'topic-1' }))
      segmentsRepo.create(makeSegment({ id: 'sm-seg2', topicId: 'topic-1' }))
      segmentsRepo.addMessages('sm-seg', ['sm-1', 'sm-2'])
      segmentsRepo.addMessages('sm-seg2', ['sm-1'])

      // replaceMessageIds processes: (1) DELETE all old memberships, (2) INSERT new ones.
      // Trigger aborts on the second INSERT (sm-1), so the DELETE and first INSERT
      // (sm-2) both succeed before the abort — proving multiple mutations completed
      // before rollback undid them all.
      sqlite.exec(`
        CREATE TEMPORARY TRIGGER IF NOT EXISTS abort_membership
        AFTER INSERT ON topic_segment_messages
        WHEN NEW.message_id = 'sm-1'
        BEGIN
          SELECT RAISE(ABORT, 'intentional abort');
        END
      `)

      // replaceMessageIds('sm-seg', ['sm-2', 'sm-1']):
      //  - DELETE all sm-seg memberships → succeeds
      //  - INSERT sm-2 (sort_order=0) → succeeds
      //  - INSERT sm-1 (sort_order=1) → triggers abort
      expect(() => segmentsRepo.replaceMessageIds('sm-seg', ['sm-2', 'sm-1'])).toThrow()

      // All original state must be preserved (transaction rolled back)
      expect(segmentsRepo.getMessageIds('sm-seg')).toEqual(['sm-1', 'sm-2'])
      expect(segmentsRepo.getById('sm-seg').found).toBe(true)
      // Other segment untouched
      expect(segmentsRepo.getMessageIds('sm-seg2')).toEqual(['sm-1'])

      sqlite.exec('DROP TRIGGER IF EXISTS abort_membership')
    })
  })

  // ===========================================================================
  // Phase 2: replaceMessageIds([]) deletes empty segment
  // ===========================================================================
  describe('replaceMessageIds empty segment cleanup', () => {
    it('replaceMessageIds([]) deletes the segment', () => {
      messagesRepo.create(makeMessage({ id: 'ec-1', topicId: 'topic-1' }))
      segmentsRepo.create(makeSegment({ id: 'ec-seg', topicId: 'topic-1' }))
      segmentsRepo.addMessages('ec-seg', ['ec-1'])
      expect(segmentsRepo.getById('ec-seg').found).toBe(true)

      segmentsRepo.replaceMessageIds('ec-seg', [])
      expect(segmentsRepo.getById('ec-seg').found).toBe(false)
    })

    it('replaceMessageIds(non-empty) keeps the segment', () => {
      messagesRepo.create(makeMessage({ id: 'ec-2', topicId: 'topic-1' }))
      messagesRepo.create(makeMessage({ id: 'ec-3', topicId: 'topic-1' }))
      segmentsRepo.create(makeSegment({ id: 'ec-seg2', topicId: 'topic-1' }))
      segmentsRepo.addMessages('ec-seg2', ['ec-2'])

      segmentsRepo.replaceMessageIds('ec-seg2', ['ec-3'])
      expect(segmentsRepo.getById('ec-seg2').found).toBe(true)
      expect(segmentsRepo.getMessageIds('ec-seg2')).toEqual(['ec-3'])
    })
  })

  // ===========================================================================
  // Phase 2: Segment sibling density after deletion
  // ===========================================================================
  describe('Segment sibling density after deletion', () => {
    it('segment delete normalizes sibling sort_order', () => {
      segmentsRepo.create(makeSegment({ id: 'ssd-1', topicId: 'topic-1', sortOrder: 0 }))
      segmentsRepo.create(makeSegment({ id: 'ssd-2', topicId: 'topic-1', sortOrder: 1 }))
      segmentsRepo.create(makeSegment({ id: 'ssd-3', topicId: 'topic-1', sortOrder: 2 }))
      segmentsRepo.delete('ssd-2')
      const segs = segmentsRepo.listByTopic('topic-1')
      expect(segs.map((s) => s.id)).toEqual(['ssd-1', 'ssd-3'])
      expect(segs.map((s) => s.sortOrder)).toEqual([0, 1])
    })

    it('segment deleteMany normalizes sibling sort_order', () => {
      segmentsRepo.create(makeSegment({ id: 'sdm-1', topicId: 'topic-1', sortOrder: 0 }))
      segmentsRepo.create(makeSegment({ id: 'sdm-2', topicId: 'topic-1', sortOrder: 1 }))
      segmentsRepo.create(makeSegment({ id: 'sdm-3', topicId: 'topic-1', sortOrder: 2 }))
      segmentsRepo.create(makeSegment({ id: 'sdm-4', topicId: 'topic-1', sortOrder: 3 }))
      segmentsRepo.deleteMany(['sdm-1', 'sdm-3'])
      const segs = segmentsRepo.listByTopic('topic-1')
      expect(segs.map((s) => s.sortOrder)).toEqual([0, 1])
      expect(segs.map((s) => s.id)).toEqual(['sdm-2', 'sdm-4'])
    })

    it('empty segment removal via removeMessages normalizes siblings', () => {
      messagesRepo.create(makeMessage({ id: 'esr-1', topicId: 'topic-1' }))
      segmentsRepo.create(makeSegment({ id: 'esr-s1', topicId: 'topic-1', sortOrder: 0 }))
      segmentsRepo.create(makeSegment({ id: 'esr-s2', topicId: 'topic-1', sortOrder: 1 }))
      segmentsRepo.addMessages('esr-s1', ['esr-1'])
      segmentsRepo.removeMessages('esr-s1', ['esr-1'])
      expect(segmentsRepo.getById('esr-s1').found).toBe(false)
      const segs = segmentsRepo.listByTopic('topic-1')
      expect(segs.map((s) => s.id)).toEqual(['esr-s2'])
      expect(segs.map((s) => s.sortOrder)).toEqual([0])
    })

    it('empty segment removal via replaceMessageIds([]) normalizes siblings', () => {
      messagesRepo.create(makeMessage({ id: 'rpi-1', topicId: 'topic-1' }))
      segmentsRepo.create(makeSegment({ id: 'rpi-s1', topicId: 'topic-1', sortOrder: 0 }))
      segmentsRepo.create(makeSegment({ id: 'rpi-s2', topicId: 'topic-1', sortOrder: 1 }))
      segmentsRepo.addMessages('rpi-s1', ['rpi-1'])
      segmentsRepo.replaceMessageIds('rpi-s1', [])
      expect(segmentsRepo.getById('rpi-s1').found).toBe(false)
      const segs = segmentsRepo.listByTopic('topic-1')
      expect(segs.map((s) => s.id)).toEqual(['rpi-s2'])
      expect(segs.map((s) => s.sortOrder)).toEqual([0])
    })

    it('empty segment removal via message delete normalizes siblings', () => {
      messagesRepo.create(makeMessage({ id: 'esd-1', topicId: 'topic-1' }))
      messagesRepo.create(makeMessage({ id: 'esd-keep', topicId: 'topic-1' }))
      segmentsRepo.create(makeSegment({ id: 'esd-s1', topicId: 'topic-1', sortOrder: 0 }))
      segmentsRepo.create(makeSegment({ id: 'esd-s2', topicId: 'topic-1', sortOrder: 1 }))
      segmentsRepo.addMessages('esd-s1', ['esd-1'])
      segmentsRepo.addMessages('esd-s2', ['esd-keep'])
      messagesRepo.delete('esd-1')
      expect(segmentsRepo.getById('esd-s1').found).toBe(false)
      const segs = segmentsRepo.listByTopic('topic-1')
      expect(segs.map((s) => s.id)).toEqual(['esd-s2'])
      expect(segs.map((s) => s.sortOrder)).toEqual([0])
    })

    it('empty segment removal via message deleteMany normalizes siblings', () => {
      messagesRepo.create(makeMessage({ id: 'esdm-1', topicId: 'topic-1' }))
      messagesRepo.create(makeMessage({ id: 'esdm-2', topicId: 'topic-1' }))
      messagesRepo.create(makeMessage({ id: 'esdm-keep', topicId: 'topic-1' }))
      segmentsRepo.create(makeSegment({ id: 'esdm-s1', topicId: 'topic-1', sortOrder: 0 }))
      segmentsRepo.create(makeSegment({ id: 'esdm-s2', topicId: 'topic-1', sortOrder: 1 }))
      segmentsRepo.addMessages('esdm-s1', ['esdm-1', 'esdm-2'])
      segmentsRepo.addMessages('esdm-s2', ['esdm-keep'])
      messagesRepo.deleteMany(['esdm-1', 'esdm-2'])
      expect(segmentsRepo.getById('esdm-s1').found).toBe(false)
      const segs = segmentsRepo.listByTopic('topic-1')
      expect(segs.map((s) => s.id)).toEqual(['esdm-s2'])
      expect(segs.map((s) => s.sortOrder)).toEqual([0])
    })

    it('deleteByTopic is deterministic (all segments for topic removed)', () => {
      segmentsRepo.create(makeSegment({ id: 'dbt-1', topicId: 'topic-1' }))
      segmentsRepo.create(makeSegment({ id: 'dbt-2', topicId: 'topic-1' }))
      expect(segmentsRepo.deleteByTopic('topic-1').affected).toBe(2)
      expect(segmentsRepo.listByTopic('topic-1')).toHaveLength(0)
    })
  })

  // ===========================================================================
  // Phase 2: Same-topic segment upsert
  // ===========================================================================
  describe('Same-topic segment upsert', () => {
    it('single upsert allows same-topic update', () => {
      segmentsRepo.create(makeSegment({ id: 'stu-1', topicId: 'topic-1', name: 'Original' }))
      const r = segmentsRepo.upsert(makeSegment({ id: 'stu-1', topicId: 'topic-1', name: 'Updated' }))
      expect(r.name).toBe('Updated')
      expect(r.topicId).toBe('topic-1')
    })

    it('single upsert rejects cross-topic reparenting', () => {
      topicsRepo.create(makeTopic({ id: 'topic-x' }))
      segmentsRepo.create(makeSegment({ id: 'stu-2', topicId: 'topic-1' }))
      expect(() => segmentsRepo.upsert(makeSegment({ id: 'stu-2', topicId: 'topic-x' }))).toThrow('cannot reparent')
    })

    it('batch upsertMany allows same-topic updates', () => {
      segmentsRepo.create(makeSegment({ id: 'bstu-1', topicId: 'topic-1', name: 'orig' }))
      const r = segmentsRepo.upsertMany([makeSegment({ id: 'bstu-1', topicId: 'topic-1', name: 'updated' })])
      expect(r[0].name).toBe('updated')
    })

    it('batch upsertMany rejects cross-topic reparenting', () => {
      topicsRepo.create(makeTopic({ id: 'topic-y' }))
      segmentsRepo.create(makeSegment({ id: 'bstu-2', topicId: 'topic-1' }))
      expect(() => segmentsRepo.upsertMany([makeSegment({ id: 'bstu-2', topicId: 'topic-y' })])).toThrow(
        'cannot reparent'
      )
    })
  })

  // ===========================================================================
  // Phase 2: Topic createdAt canonicalization in batch operations
  // ===========================================================================
  describe('Topic createdAt canonicalization in batch', () => {
    it('createMany canonicalizes null createdAt', () => {
      const r = topicsRepo.createMany([
        makeTopic({ id: 'cc-m1', createdAt: null }),
        makeTopic({ id: 'cc-m2', createdAt: null })
      ])
      expect(r[0].createdAt).not.toBeNull()
      expect(r[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(r[1].createdAt).not.toBeNull()
      expect(r[1].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('upsertMany canonicalizes null createdAt for new rows', () => {
      const r = topicsRepo.upsertMany([
        makeTopic({ id: 'uc-m1', createdAt: null }),
        makeTopic({ id: 'uc-m2', createdAt: null })
      ])
      expect(r[0].createdAt).not.toBeNull()
      expect(r[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(r[1].createdAt).not.toBeNull()
      expect(r[1].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('upsertMany preserves existing createdAt on update', () => {
      topicsRepo.create(makeTopic({ id: 'uc-pres', createdAt: '2020-01-01T00:00:00.000Z' }))
      const r = topicsRepo.upsertMany([makeTopic({ id: 'uc-pres', createdAt: null, name: 'Updated' })])
      expect(r[0].createdAt).toBe('2020-01-01T00:00:00.000Z')
      expect(r[0].name).toBe('Updated')
    })
  })
})
