/**
 * ChatImportWriter tests — real better-sqlite3, no mocks.
 *
 * Covers the Phase 4.2 import-only, order-preserving write seam:
 * - Repeated (globally ID-paginated) pages preserve caller-supplied sortOrder
 *   exactly, for both sparse and dense source orders (LOCK-4212B).
 * - A single outer-page transaction rolls back every table's rows when any
 *   statement on that page fails (LOCK-4212C).
 * - Empty segments are insertable and retained (LOCK-4212E).
 * - Duplicate primary keys, unique (blockId, fileId), and FK violations are
 *   rejected and propagated.
 * - Standard repository createMany normalization behavior is unchanged
 *   (LOCK-4212A).
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
import { asc, eq } from 'drizzle-orm'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import type { FileReferenceData, MessageBlockData, MessageData, TopicData, TopicSegmentData } from '../domain/types'
import { runMigrations } from '../migration'
import { createImportWriter } from '../repository/ImportWriter'
import { MessagesRepository } from '../repository/MessagesRepository'
import { TopicSegmentsRepository } from '../repository/TopicSegmentsRepository'
import { TopicsRepository } from '../repository/TopicsRepository'
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-import-'))
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

function makeTopic(overrides?: Partial<TopicData>): TopicData {
  return {
    id: 't-1',
    assistantId: 'asst-1',
    name: 'Imported Topic',
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    deletedAt: null,
    overflow: {},
    ...overrides
  }
}
function makeMessage(overrides?: Partial<MessageData>): MessageData {
  return {
    id: 'm-1',
    topicId: 't-1',
    role: 'user',
    content: 'Hello',
    status: 'success',
    askId: null,
    model: null,
    modelId: null,
    assistantId: 'asst-1',
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    sortOrder: 0,
    overflow: {},
    ...overrides
  }
}
function makeBlock(overrides?: Partial<MessageBlockData>): MessageBlockData {
  return {
    id: 'b-1',
    messageId: 'm-1',
    type: 'main_text',
    content: 'Block content',
    status: 'success',
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: null,
    sortOrder: 0,
    overflow: {},
    ...overrides
  }
}
function makeSegment(overrides?: Partial<TopicSegmentData>): TopicSegmentData {
  return {
    id: 's-1',
    topicId: 't-1',
    name: 'Segment',
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: null,
    sortOrder: 0,
    overflow: {},
    ...overrides
  }
}
function makeFileRef(overrides?: Partial<FileReferenceData>): FileReferenceData {
  return {
    id: 'fr-1',
    blockId: 'b-1',
    fileId: 'file-1',
    fileName: 'doc.pdf',
    filePath: '/files/doc.pdf',
    fileType: 'file',
    count: 1,
    overflow: { size: 1024 },
    ...overrides
  }
}

/** Read raw sort_order values for a topic's messages ordered by sort_order. */
function rawMessageOrders(
  db: BetterSQLite3Database<typeof schema>,
  topicId: string
): Array<{ id: string; sortOrder: number }> {
  return db
    .select({ id: schema.messages.id, sortOrder: schema.messages.sortOrder })
    .from(schema.messages)
    .where(eq(schema.messages.topicId, topicId))
    .orderBy(asc(schema.messages.sortOrder), asc(schema.messages.id))
    .all()
}

describe('ChatImportWriter', () => {
  let tempDir: string
  let sqlite: Database.Database
  let db: BetterSQLite3Database<typeof schema>

  beforeEach(() => {
    tempDir = makeTempDir()
    sqlite = openTestDb(realPath.join(tempDir, 'test.db'))
    db = wrapDrizzle(sqlite)
    runMigrations(db, sqlite)
  })

  afterEach(() => {
    sqlite.close()
    rmrf(tempDir)
  })

  // -------------------------------------------------------------------------
  // Order preservation across repeated pages (LOCK-4212B)
  // -------------------------------------------------------------------------

  it('preserves sparse caller-supplied sortOrder across two batches for the same parent', () => {
    const writer = createImportWriter(db)
    writer.insertTopics([makeTopic()])

    // Page 1 and Page 2 (globally ID-paginated) both target the same topic.
    writer.insertMessages([makeMessage({ id: 'm-a', sortOrder: 10 }), makeMessage({ id: 'm-c', sortOrder: 30 })])
    writer.insertMessages([makeMessage({ id: 'm-b', sortOrder: 20 })])

    const orders = rawMessageOrders(db, 't-1')
    // Sparse values (10, 20, 30) preserved verbatim; ordered = source order a,b,c.
    expect(orders).toEqual([
      { id: 'm-a', sortOrder: 10 },
      { id: 'm-b', sortOrder: 20 },
      { id: 'm-c', sortOrder: 30 }
    ])
  })

  it('preserves dense source order when siblings are split across pages', () => {
    const writer = createImportWriter(db)
    writer.insertTopics([makeTopic()])

    // Source order a(0), b(1), c(2). ID pagination splits them: page1 = a,c; page2 = b.
    writer.insertMessages([makeMessage({ id: 'm-a', sortOrder: 0 }), makeMessage({ id: 'm-c', sortOrder: 2 })])
    writer.insertMessages([makeMessage({ id: 'm-b', sortOrder: 1 })])

    const orders = rawMessageOrders(db, 't-1')
    expect(orders).toEqual([
      { id: 'm-a', sortOrder: 0 },
      { id: 'm-b', sortOrder: 1 },
      { id: 'm-c', sortOrder: 2 }
    ])
    // Runtime read path yields correct source order.
    const listed = new MessagesRepository(db).listByTopic('t-1').map((m) => m.id)
    expect(listed).toEqual(['m-a', 'm-b', 'm-c'])
  })

  it('preserves block sortOrder across pages without normalization', () => {
    const writer = createImportWriter(db)
    writer.insertTopics([makeTopic()])
    writer.insertMessages([makeMessage()])
    writer.insertBlocks([makeBlock({ id: 'blk-a', sortOrder: 5 }), makeBlock({ id: 'blk-c', sortOrder: 15 })])
    writer.insertBlocks([makeBlock({ id: 'blk-b', sortOrder: 10 })])

    const rows = db
      .select({ id: schema.messageBlocks.id, sortOrder: schema.messageBlocks.sortOrder })
      .from(schema.messageBlocks)
      .where(eq(schema.messageBlocks.messageId, 'm-1'))
      .orderBy(asc(schema.messageBlocks.sortOrder))
      .all()
    expect(rows).toEqual([
      { id: 'blk-a', sortOrder: 5 },
      { id: 'blk-b', sortOrder: 10 },
      { id: 'blk-c', sortOrder: 15 }
    ])
  })

  // -------------------------------------------------------------------------
  // Membership with exact array indexes (LOCK-4212E)
  // -------------------------------------------------------------------------

  it('inserts membership using complete messageIds with exact array indexes', () => {
    const writer = createImportWriter(db)
    writer.insertTopics([makeTopic()])
    writer.insertMessages([
      makeMessage({ id: 'm-a', sortOrder: 0 }),
      makeMessage({ id: 'm-b', sortOrder: 1 }),
      makeMessage({ id: 'm-c', sortOrder: 2 })
    ])
    writer.insertSegments([makeSegment({ id: 's-1' })])
    // Supply the complete, source-ordered messageIds (non-sorted-by-id on purpose).
    writer.insertSegmentMembership('s-1', ['m-c', 'm-a', 'm-b'])

    const rows = db
      .select({ messageId: schema.topicSegmentMessages.messageId, sortOrder: schema.topicSegmentMessages.sortOrder })
      .from(schema.topicSegmentMessages)
      .where(eq(schema.topicSegmentMessages.segmentId, 's-1'))
      .orderBy(asc(schema.topicSegmentMessages.sortOrder))
      .all()
    expect(rows).toEqual([
      { messageId: 'm-c', sortOrder: 0 },
      { messageId: 'm-a', sortOrder: 1 },
      { messageId: 'm-b', sortOrder: 2 }
    ])
    // Runtime read path returns membership in the exact supplied order.
    expect(new TopicSegmentsRepository(db).getMessageIds('s-1')).toEqual(['m-c', 'm-a', 'm-b'])
  })

  it('inserts and retains empty segments', () => {
    const writer = createImportWriter(db)
    writer.insertTopics([makeTopic()])
    writer.insertSegments([
      makeSegment({ id: 's-empty', sortOrder: 0 }),
      makeSegment({ id: 's-empty-2', sortOrder: 1 })
    ])

    const segRepo = new TopicSegmentsRepository(db)
    const listed = segRepo.listByTopic('t-1').map((s) => s.id)
    expect(listed).toEqual(['s-empty', 's-empty-2'])
    expect(segRepo.getMessageIds('s-empty')).toEqual([])
    expect(segRepo.getMessageIds('s-empty-2')).toEqual([])
  })

  it('preserves segment sortOrder across pages', () => {
    const writer = createImportWriter(db)
    writer.insertTopics([makeTopic()])
    writer.insertSegments([makeSegment({ id: 's-a', sortOrder: 0 }), makeSegment({ id: 's-c', sortOrder: 2 })])
    writer.insertSegments([makeSegment({ id: 's-b', sortOrder: 1 })])

    const rows = db
      .select({ id: schema.topicSegments.id, sortOrder: schema.topicSegments.sortOrder })
      .from(schema.topicSegments)
      .where(eq(schema.topicSegments.topicId, 't-1'))
      .orderBy(asc(schema.topicSegments.sortOrder))
      .all()
    expect(rows).toEqual([
      { id: 's-a', sortOrder: 0 },
      { id: 's-b', sortOrder: 1 },
      { id: 's-c', sortOrder: 2 }
    ])
  })

  it('inserts file references and preserves overflow metadata', () => {
    const writer = createImportWriter(db)
    writer.insertTopics([makeTopic()])
    writer.insertMessages([makeMessage()])
    writer.insertBlocks([makeBlock()])
    const count = writer.insertFileReferences([makeFileRef({ id: 'fr-1', fileId: 'file-1' })])
    expect(count).toBe(1)

    const row = db.select().from(schema.fileReferences).where(eq(schema.fileReferences.id, 'fr-1')).get()
    expect(row).toBeDefined()
    expect((row as any).blockId).toBe('b-1')
    expect((row as any).fileId).toBe('file-1')
    expect(JSON.parse((row as any).extra)).toEqual({ size: 1024 })
  })

  // -------------------------------------------------------------------------
  // Outer-page transaction rollback across multiple tables (LOCK-4212C)
  // -------------------------------------------------------------------------

  it('rolls back every table row on the page when any statement fails', () => {
    // Seed a valid topic in its own committed transaction.
    createImportWriter(db).insertTopics([makeTopic()])

    // One outer page transaction touching topics(no)/messages/blocks/segments/fileRefs.
    expect(() =>
      db.transaction((tx) => {
        const writer = createImportWriter(tx)
        writer.insertMessages([makeMessage({ id: 'm-page', sortOrder: 0 })])
        writer.insertBlocks([makeBlock({ id: 'b-page', messageId: 'm-page' })])
        writer.insertSegments([makeSegment({ id: 's-page' })])
        writer.insertFileReferences([makeFileRef({ id: 'fr-page', blockId: 'b-page' })])
        // Failing statement: message referencing a non-existent topic (FK violation).
        writer.insertMessages([makeMessage({ id: 'm-bad', topicId: 'no-such-topic' })])
      })
    ).toThrow()

    // Every row written on the failed page must be gone; the pre-seeded topic remains.
    expect(new TopicsRepository(db).exists('t-1')).toBe(true)
    expect(db.select().from(schema.messages).where(eq(schema.messages.id, 'm-page')).get()).toBeUndefined()
    expect(db.select().from(schema.messageBlocks).where(eq(schema.messageBlocks.id, 'b-page')).get()).toBeUndefined()
    expect(db.select().from(schema.topicSegments).where(eq(schema.topicSegments.id, 's-page')).get()).toBeUndefined()
    expect(db.select().from(schema.fileReferences).where(eq(schema.fileReferences.id, 'fr-page')).get()).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // Constraint rejection (LOCK-4212D)
  // -------------------------------------------------------------------------

  it('rejects duplicate message primary keys', () => {
    const writer = createImportWriter(db)
    writer.insertTopics([makeTopic()])
    expect(() =>
      writer.insertMessages([makeMessage({ id: 'dup', sortOrder: 0 }), makeMessage({ id: 'dup', sortOrder: 1 })])
    ).toThrow()
  })

  it('rejects messages with a missing parent topic (FK)', () => {
    const writer = createImportWriter(db)
    expect(() => writer.insertMessages([makeMessage({ id: 'm-x', topicId: 'ghost' })])).toThrow()
  })

  it('rejects duplicate (blockId, fileId) file references', () => {
    const writer = createImportWriter(db)
    writer.insertTopics([makeTopic()])
    writer.insertMessages([makeMessage()])
    writer.insertBlocks([makeBlock()])
    expect(() =>
      writer.insertFileReferences([
        makeFileRef({ id: 'fr-1', blockId: 'b-1', fileId: 'file-dup' }),
        makeFileRef({ id: 'fr-2', blockId: 'b-1', fileId: 'file-dup' })
      ])
    ).toThrow()
  })

  it('rejects duplicate segment membership pairs (composite PK)', () => {
    const writer = createImportWriter(db)
    writer.insertTopics([makeTopic()])
    writer.insertMessages([makeMessage({ id: 'm-a', sortOrder: 0 })])
    writer.insertSegments([makeSegment({ id: 's-1' })])
    expect(() => writer.insertSegmentMembership('s-1', ['m-a', 'm-a'])).toThrow()
  })

  // -------------------------------------------------------------------------
  // Standard repository behavior remains unchanged (LOCK-4212A)
  // -------------------------------------------------------------------------

  it('does not alter MessagesRepository.createMany dense normalization', () => {
    const topicsRepo = new TopicsRepository(db)
    topicsRepo.create(makeTopic({ id: 't-std' }))
    const messagesRepo = new MessagesRepository(db)
    // Supply sparse orders; runtime createMany normalizes to dense 0..n-1.
    messagesRepo.createMany([
      makeMessage({ id: 'm-a', topicId: 't-std', sortOrder: 10 }),
      makeMessage({ id: 'm-b', topicId: 't-std', sortOrder: 20 }),
      makeMessage({ id: 'm-c', topicId: 't-std', sortOrder: 30 })
    ])
    const orders = rawMessageOrders(db, 't-std')
    expect(orders).toEqual([
      { id: 'm-a', sortOrder: 0 },
      { id: 'm-b', sortOrder: 1 },
      { id: 'm-c', sortOrder: 2 }
    ])
  })
})
