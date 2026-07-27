/**
 * ChatImportDataPlane tests — real better-sqlite3, no mocks (Phase 4.2).
 *
 * Covers the candidate data plane:
 * - Canonical topic flattening: no `messages` in topics.extra, leaked UI
 *   metadata ignored, deletedAt preserved (LOCK-D2).
 * - Exact message/block/membership order survives pages (LOCK-D3/D5/D6).
 * - structured model / tool content / file metadata / unknown JSON round-trip.
 * - Malformed/missing/duplicate/cross-owner inputs reject with page rollback
 *   and untouched stats (LOCK-D4/D5/D6/D8/D9).
 * - Empty segments retained; files pages create no target rows (LOCK-D6/D7).
 * - finalize() rejects referenced-but-missing block IDs (LOCK-D10).
 * - Stats snapshots reflect only committed pages/rows, without aliasing.
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

import type { JsonObject } from '@shared/chatDb'
import type { ReadPageResponse } from '@shared/chatImport/types'
import Database from 'better-sqlite3'
import { asc, eq } from 'drizzle-orm'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { runMigrations } from '../../chatDb/migration'
import { createImportWriter } from '../../chatDb/repository/ImportWriter'
import * as schema from '../../chatDb/schema'
import { ChatImportDataPlaneError, createImportDataPlane } from '../importDataPlane'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-dataplane-'))
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

function page(tableName: string, items: JsonObject[], hasMore = false): ReadPageResponse {
  return { tableName, items, cursor: hasMore ? 'next' : null, hasMore }
}

// ---------------------------------------------------------------------------
// Source fixtures (Dexie logical shapes)
// ---------------------------------------------------------------------------

function srcMessage(id: string, topicId: string, blocks: string[], extra?: Partial<JsonObject>): JsonObject {
  return {
    id,
    topicId,
    role: 'user',
    status: 'success',
    assistantId: 'asst-1',
    createdAt: '2020-01-01T00:00:00.000Z',
    blocks,
    ...extra
  } as JsonObject
}

function srcTopic(id: string, messages: JsonObject[], extra?: Partial<JsonObject>): JsonObject {
  return { id, messages, ...extra } as JsonObject
}

function srcBlock(id: string, messageId: string, extra?: Partial<JsonObject>): JsonObject {
  return {
    id,
    messageId,
    type: 'main_text',
    content: `content of ${id}`,
    status: 'success',
    createdAt: '2020-01-01T00:00:01.000Z',
    ...extra
  } as JsonObject
}

function srcSegment(id: string, topicId: string, messageIds: string[], extra?: Partial<JsonObject>): JsonObject {
  return {
    id,
    topicId,
    name: `Segment ${id}`,
    messageIds,
    createdAt: '2020-01-02T00:00:00.000Z',
    updatedAt: '2020-01-02T00:00:00.000Z',
    ...extra
  } as JsonObject
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChatImportDataPlane', () => {
  let tempDir: string
  let sqlite: Database.Database
  let db: BetterSQLite3Database<typeof schema>

  beforeEach(() => {
    tempDir = makeTempDir()
    sqlite = openTestDb(realPath.join(tempDir, 'candidate.db'))
    db = drizzle(sqlite, { schema })
    runMigrations(db, sqlite)
  })

  afterEach(() => {
    sqlite.close()
    rmrf(tempDir)
  })

  // -------------------------------------------------------------------------
  // Canonical topic projection (LOCK-D2)
  // -------------------------------------------------------------------------

  it('flattens raw topics without messages in topics.extra and ignores leaked UI metadata', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(
      page('topics', [
        srcTopic('t-1', [srcMessage('m-1', 't-1', [])], {
          // Leaked UI topic metadata that must be ignored (LOCK-D2)
          name: 'Leaked name',
          assistantId: 'leaked-asst',
          createdAt: '2019-01-01T00:00:00.000Z',
          updatedAt: '2019-01-01T00:00:00.000Z',
          pinned: true,
          prompt: 'leak',
          deletedAt: '2021-06-01T00:00:00.000Z'
        })
      ])
    )

    const row = db.select().from(schema.topics).where(eq(schema.topics.id, 't-1')).get() as any
    expect(row).toBeDefined()
    expect(row.name).toBeNull()
    expect(row.assistantId).toBeNull()
    expect(row.createdAt).toBeNull()
    expect(row.updatedAt).toBeNull()
    expect(row.deletedAt).toBe('2021-06-01T00:00:00.000Z')
    // No messages and no leaked metadata in extra
    expect(row.extra).toBeNull()

    // Message extracted as its own row
    const msg = db.select().from(schema.messages).where(eq(schema.messages.id, 'm-1')).get() as any
    expect(msg).toBeDefined()
    expect(msg.topicId).toBe('t-1')
  })

  // -------------------------------------------------------------------------
  // Order preservation across pages (LOCK-D3/D5/D6)
  // -------------------------------------------------------------------------

  it('preserves exact message/block/membership order across pages', () => {
    const plane = createImportDataPlane(db)

    // Message array order: m-c, m-a, m-b (deliberately non-ID order).
    // Block arrays: m-c → [b-9, b-1]; m-a → [b-5].
    plane.processPage(
      page(
        'topics',
        [srcTopic('t-1', [srcMessage('m-c', 't-1', ['b-9', 'b-1']), srcMessage('m-a', 't-1', ['b-5'])])],
        true
      )
    )
    plane.processPage(page('topics', [srcTopic('t-2', [srcMessage('m-b', 't-2', [])])]))

    // message_blocks arrive globally keyset-paginated by id: b-1, b-5 | b-9.
    plane.processPage(page('message_blocks', [srcBlock('b-1', 'm-c'), srcBlock('b-5', 'm-a')], true))
    plane.processPage(page('message_blocks', [srcBlock('b-9', 'm-c')]))

    // Segment membership order: m-a before m-c (non-ID order).
    plane.processPage(page('topic_segments', [srcSegment('s-1', 't-1', ['m-a', 'm-c'])]))

    // Message sortOrder = embedded array index.
    const msgs = db
      .select({ id: schema.messages.id, sortOrder: schema.messages.sortOrder })
      .from(schema.messages)
      .where(eq(schema.messages.topicId, 't-1'))
      .orderBy(asc(schema.messages.sortOrder))
      .all()
    expect(msgs).toEqual([
      { id: 'm-c', sortOrder: 0 },
      { id: 'm-a', sortOrder: 1 }
    ])

    // Block sortOrder = index in the parent message.blocks array, not page/id order.
    const blocks = db
      .select({ id: schema.messageBlocks.id, sortOrder: schema.messageBlocks.sortOrder })
      .from(schema.messageBlocks)
      .where(eq(schema.messageBlocks.messageId, 'm-c'))
      .orderBy(asc(schema.messageBlocks.sortOrder))
      .all()
    expect(blocks).toEqual([
      { id: 'b-9', sortOrder: 0 },
      { id: 'b-1', sortOrder: 1 }
    ])

    // Membership sortOrder = messageIds array index.
    const membership = db
      .select({
        messageId: schema.topicSegmentMessages.messageId,
        sortOrder: schema.topicSegmentMessages.sortOrder
      })
      .from(schema.topicSegmentMessages)
      .where(eq(schema.topicSegmentMessages.segmentId, 's-1'))
      .orderBy(asc(schema.topicSegmentMessages.sortOrder))
      .all()
    expect(membership).toEqual([
      { messageId: 'm-a', sortOrder: 0 },
      { messageId: 'm-c', sortOrder: 1 }
    ])

    // Segment sortOrder is neutral 0 (LOCK-D6).
    const seg = db.select().from(schema.topicSegments).where(eq(schema.topicSegments.id, 's-1')).get() as any
    expect(seg.sortOrder).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Round-trip preservation (LOCK-D3/D5/D6)
  // -------------------------------------------------------------------------

  it('round-trips structured model, tool content, file metadata, and unknown JSON', () => {
    const plane = createImportDataPlane(db)
    const structuredModel = { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', group: 'GPT-4o' }

    plane.processPage(
      page('topics', [
        srcTopic('t-1', [
          srcMessage('m-1', 't-1', ['b-file', 'b-tool'], {
            model: structuredModel,
            unknownMessageKey: { nested: [1, 2, 3] },
            mentions: ['@x']
          })
        ])
      ])
    )
    plane.processPage(
      page('message_blocks', [
        srcBlock('b-file', 'm-1', {
          type: 'file',
          content: null,
          file: { id: 'file-1', name: 'doc.pdf', path: '/files/doc.pdf', type: 'file', size: 2048 },
          unknownBlockKey: 'keep-me'
        }),
        srcBlock('b-tool', 'm-1', {
          type: 'tool',
          content: { toolName: 'search', result: { hits: 2 } },
          toolId: 'tool-77'
        })
      ])
    )

    // Message: structured model preserved in extra; modelId promoted; unknown keys kept.
    const msg = db.select().from(schema.messages).where(eq(schema.messages.id, 'm-1')).get() as any
    expect(msg.model).toBeNull()
    expect(msg.modelId).toBe('gpt-4o')
    const msgExtra = JSON.parse(msg.extra)
    expect(msgExtra.model).toEqual(structuredModel)
    expect(msgExtra.unknownMessageKey).toEqual({ nested: [1, 2, 3] })
    expect(msgExtra.mentions).toEqual(['@x'])
    expect(msgExtra.blocks).toEqual(['b-file', 'b-tool'])

    // Tool block: object content moved to extra.content; column content null.
    const tool = db.select().from(schema.messageBlocks).where(eq(schema.messageBlocks.id, 'b-tool')).get() as any
    expect(tool.content).toBeNull()
    const toolExtra = JSON.parse(tool.extra)
    expect(toolExtra.content).toEqual({ toolName: 'search', result: { hits: 2 } })
    expect(toolExtra.toolId).toBe('tool-77')

    // File block: unknown key + file metadata preserved; file reference projected.
    const fileBlock = db.select().from(schema.messageBlocks).where(eq(schema.messageBlocks.id, 'b-file')).get() as any
    const fileExtra = JSON.parse(fileBlock.extra)
    expect(fileExtra.unknownBlockKey).toBe('keep-me')
    expect(fileExtra.file).toEqual({ id: 'file-1', name: 'doc.pdf', path: '/files/doc.pdf', type: 'file', size: 2048 })

    const ref = db.select().from(schema.fileReferences).where(eq(schema.fileReferences.blockId, 'b-file')).get() as any
    expect(ref).toBeDefined()
    expect(ref.fileId).toBe('file-1')
    expect(ref.fileName).toBe('doc.pdf')
    expect(ref.filePath).toBe('/files/doc.pdf')
    expect(ref.fileType).toBe('file')

    // Segment: color/unknown fields in overflow; messageIds NOT in overflow.
    plane.processPage(
      page('topic_segments', [srcSegment('s-1', 't-1', ['m-1'], { color: '#ff0000', unknownSegKey: 42 })])
    )
    const seg = db.select().from(schema.topicSegments).where(eq(schema.topicSegments.id, 's-1')).get() as any
    const segExtra = JSON.parse(seg.extra)
    expect(segExtra.color).toBe('#ff0000')
    expect(segExtra.unknownSegKey).toBe(42)
    expect(segExtra.messageIds).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // Rejections (LOCK-D3/D4/D5/D6) with page rollback (LOCK-D8) and stats (LOCK-D9)
  // -------------------------------------------------------------------------

  it('rejects a malformed embedded message and leaves the page uncommitted', () => {
    const plane = createImportDataPlane(db)
    const badMessage = { ...srcMessage('m-bad', 't-1', []) } as Record<string, unknown>
    delete badMessage.role

    expect(() =>
      plane.processPage(
        page('topics', [
          srcTopic('t-ok', [srcMessage('m-ok', 't-ok', [])]),
          srcTopic('t-1', [badMessage as JsonObject])
        ])
      )
    ).toThrowError(ChatImportDataPlaneError)

    // Nothing from the failed page committed — even the valid leading topic.
    expect(db.select().from(schema.topics).all()).toEqual([])
    expect(db.select().from(schema.messages).all()).toEqual([])
    expect(plane.getCandidateImportStats().pageCount).toBe(0)
    expect(plane.getSourceReadStats().topicRecordCount).toBe(0)
  })

  it('rejects message.topicId mismatch with the outer topic', () => {
    const plane = createImportDataPlane(db)
    expect(() => plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-other', [])])]))).toThrowError(
      /OWNERSHIP_MISMATCH/
    )
  })

  it('rejects duplicate block claims across messages (LOCK-D4)', () => {
    const plane = createImportDataPlane(db)
    expect(() =>
      plane.processPage(
        page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', ['b-x']), srcMessage('m-2', 't-1', ['b-x'])])])
      )
    ).toThrowError(/DUPLICATE_RELATION/)
  })

  it('rejects non-unique block IDs within one message (LOCK-D4)', () => {
    const plane = createImportDataPlane(db)
    expect(() =>
      plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', ['b-x', 'b-x'])])]))
    ).toThrowError(/duplicate id 'b-x'/)
  })

  it('rejects block rows with an unknown or mismatched owner (LOCK-D5)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', ['b-1'])])]))

    // Not referenced by any imported message.
    expect(() => plane.processPage(page('message_blocks', [srcBlock('b-ghost', 'm-1')]))).toThrowError(
      /OWNERSHIP_MISMATCH/
    )
    // Ownership mismatch with the block index.
    expect(() => plane.processPage(page('message_blocks', [srcBlock('b-1', 'm-wrong')]))).toThrowError(
      /OWNERSHIP_MISMATCH/
    )
    // Duplicate block row after the first commit.
    plane.processPage(page('message_blocks', [srcBlock('b-1', 'm-1')]))
    expect(() => plane.processPage(page('message_blocks', [srcBlock('b-1', 'm-1')]))).toThrowError(/DUPLICATE_RELATION/)
  })

  it('rejects segments with unknown topic or cross-topic membership (LOCK-D6)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(
      page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', [])]), srcTopic('t-2', [srcMessage('m-2', 't-2', [])])])
    )

    expect(() => plane.processPage(page('topic_segments', [srcSegment('s-1', 't-ghost', [])]))).toThrowError(
      /does not match any imported topic/
    )
    expect(() => plane.processPage(page('topic_segments', [srcSegment('s-1', 't-1', ['m-ghost'])]))).toThrowError(
      /does not match any imported message/
    )
    expect(() => plane.processPage(page('topic_segments', [srcSegment('s-1', 't-1', ['m-2'])]))).toThrowError(
      /belongs to topic 't-2'/
    )
    expect(() => plane.processPage(page('topic_segments', [srcSegment('s-1', 't-1', ['m-1', 'm-1'])]))).toThrowError(
      /duplicate id 'm-1'/
    )
    // No segment rows or memberships committed by the failed pages.
    expect(db.select().from(schema.topicSegments).all()).toEqual([])
    expect(db.select().from(schema.topicSegmentMessages).all()).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Cross-page duplicate relations (Phase 4.2 regression)
  //
  // The streaming Set/Map indexes (topicIds / messageTopicById / segmentIds)
  // must reject an id already committed on an EARLIER page, not only within a
  // single page. On rejection the whole later page is discarded: no second-
  // page rows land, committed stats/index stay at the first page, and a fresh
  // valid id can still be imported afterward (index not polluted).
  // -------------------------------------------------------------------------

  it('rejects a topic id duplicated on a later committed page and leaves first-page state intact', () => {
    const plane = createImportDataPlane(db)
    // First committed page: t-1 + m-1.
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', [])])]))

    // Second page re-imports t-1 and also carries a fresh valid topic t-2.
    let caught: ChatImportDataPlaneError | null = null
    try {
      plane.processPage(page('topics', [srcTopic('t-1', []), srcTopic('t-2', [srcMessage('m-2', 't-2', [])])]))
    } catch (e) {
      caught = e as ChatImportDataPlaneError
    }

    expect(caught).toBeInstanceOf(ChatImportDataPlaneError)
    expect(caught!.code).toBe('DUPLICATE_RELATION')
    expect(caught!.tableName).toBe('topics')
    expect(caught!.entityId).toBe('t-1')

    // Nothing from the second page committed — not even the valid leading t-2.
    const topics = db.select().from(schema.topics).all() as any[]
    expect(topics).toHaveLength(1)
    expect(topics[0].id).toBe('t-1')
    const msgs = db.select().from(schema.messages).all() as any[]
    expect(msgs).toHaveLength(1)
    expect(msgs[0].id).toBe('m-1')

    // Committed stats remain exactly at the first page.
    const candidate = plane.getCandidateImportStats()
    expect(candidate.topicCount).toBe(1)
    expect(candidate.messageCount).toBe(1)
    expect(candidate.pageCount).toBe(1)
    expect(plane.getSourceReadStats().topicRecordCount).toBe(1)

    // Index not polluted: a fresh valid topic can still be imported.
    plane.processPage(page('topics', [srcTopic('t-2', [srcMessage('m-2', 't-2', [])])]))
    expect(db.select().from(schema.topics).all()).toHaveLength(2)
    expect(db.select().from(schema.messages).all()).toHaveLength(2)
  })

  it('rejects a message id duplicated on a later committed page', () => {
    const plane = createImportDataPlane(db)
    // First committed page: t-1 + m-1.
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', [])])]))

    // Second page introduces a new topic t-2 carrying a fresh m-2 plus the
    // already-committed message id m-1.
    let caught: ChatImportDataPlaneError | null = null
    try {
      plane.processPage(page('topics', [srcTopic('t-2', [srcMessage('m-2', 't-2', []), srcMessage('m-1', 't-2', [])])]))
    } catch (e) {
      caught = e as ChatImportDataPlaneError
    }

    expect(caught).toBeInstanceOf(ChatImportDataPlaneError)
    expect(caught!.code).toBe('DUPLICATE_RELATION')
    expect(caught!.tableName).toBe('topics')
    expect(caught!.entityId).toBe('m-1')

    // The entire second page is discarded, including the valid t-2 / m-2.
    const topics = db.select().from(schema.topics).all() as any[]
    expect(topics).toHaveLength(1)
    expect(topics[0].id).toBe('t-1')
    const msgs = db.select().from(schema.messages).all() as any[]
    expect(msgs).toHaveLength(1)
    expect(msgs[0].id).toBe('m-1')

    const candidate = plane.getCandidateImportStats()
    expect(candidate.topicCount).toBe(1)
    expect(candidate.messageCount).toBe(1)
    expect(candidate.pageCount).toBe(1)

    // Index not polluted: m-2 (and t-2) can still be imported afterward.
    plane.processPage(page('topics', [srcTopic('t-2', [srcMessage('m-2', 't-2', [])])]))
    expect(db.select().from(schema.messages).all()).toHaveLength(2)
  })

  it('rejects a segment id duplicated on a later committed page', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', [])])]))
    // First segment page: s-1 (with m-1 membership).
    plane.processPage(page('topic_segments', [srcSegment('s-1', 't-1', ['m-1'])]))

    // Second segment page re-imports s-1 and also carries a fresh valid s-2.
    let caught: ChatImportDataPlaneError | null = null
    try {
      plane.processPage(page('topic_segments', [srcSegment('s-1', 't-1', []), srcSegment('s-2', 't-1', [])]))
    } catch (e) {
      caught = e as ChatImportDataPlaneError
    }

    expect(caught).toBeInstanceOf(ChatImportDataPlaneError)
    expect(caught!.code).toBe('DUPLICATE_RELATION')
    expect(caught!.tableName).toBe('topic_segments')
    expect(caught!.entityId).toBe('s-1')

    // Only the first segment page committed; s-2 of the failed page is absent.
    const segs = db.select().from(schema.topicSegments).all() as any[]
    expect(segs).toHaveLength(1)
    expect(segs[0].id).toBe('s-1')
    expect(db.select().from(schema.topicSegmentMessages).all()).toHaveLength(1)

    const candidate = plane.getCandidateImportStats()
    expect(candidate.segmentCount).toBe(1)
    expect(candidate.segmentMembershipCount).toBe(1)
    expect(candidate.pageCount).toBe(2)

    // Index not polluted: s-2 can still be imported on a fresh page.
    plane.processPage(page('topic_segments', [srcSegment('s-2', 't-1', [])]))
    expect(db.select().from(schema.topicSegments).all()).toHaveLength(2)
  })

  it('rolls back the whole page when a database constraint fails mid-transaction (LOCK-D8)', () => {
    // Pre-seed a topic directly (bypassing the plane's indexes) so the page
    // passes validation but hits a PRIMARY KEY violation inside the tx.
    createImportWriter(db).insertTopics([
      { id: 't-dup', assistantId: null, name: null, createdAt: null, updatedAt: null, deletedAt: null, overflow: {} }
    ])

    const plane = createImportDataPlane(db)
    expect(() =>
      plane.processPage(page('topics', [srcTopic('t-new', [srcMessage('m-new', 't-new', [])]), srcTopic('t-dup', [])]))
    ).toThrow()

    // The valid leading rows of the failed page must be rolled back.
    expect(db.select().from(schema.topics).where(eq(schema.topics.id, 't-new')).get()).toBeUndefined()
    expect(db.select().from(schema.messages).where(eq(schema.messages.id, 'm-new')).get()).toBeUndefined()
    // Stats untouched (LOCK-D9); indexes not polluted: t-new importable again.
    expect(plane.getCandidateImportStats().pageCount).toBe(0)
    expect(plane.getSourceReadStats().topicRecordCount).toBe(0)
    plane.processPage(page('topics', [srcTopic('t-new', [srcMessage('m-new', 't-new', [])])]))
    expect(db.select().from(schema.topics).where(eq(schema.topics.id, 't-new')).get()).toBeDefined()
  })

  it('enforces the global entity arrival order (LOCK-D1)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [])]))
    plane.processPage(page('message_blocks', []))
    expect(() => plane.processPage(page('topics', [srcTopic('t-2', [])]))).toThrowError(/ENTITY_ORDER_VIOLATION/)
    expect(() => plane.processPage(page('settings', []))).toThrowError(/UNKNOWN_TABLE/)
  })

  // -------------------------------------------------------------------------
  // Empty segments retained (LOCK-D6)
  // -------------------------------------------------------------------------

  it('retains empty segments', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [])]))
    plane.processPage(page('topic_segments', [srcSegment('s-empty', 't-1', [])]))

    const seg = db.select().from(schema.topicSegments).where(eq(schema.topicSegments.id, 's-empty')).get()
    expect(seg).toBeDefined()
    expect(db.select().from(schema.topicSegmentMessages).all()).toEqual([])
    expect(plane.getCandidateImportStats().segmentCount).toBe(1)
    expect(plane.getCandidateImportStats().segmentMembershipCount).toBe(0)
  })

  // -------------------------------------------------------------------------
  // files pages (LOCK-D7)
  // -------------------------------------------------------------------------

  it('treats files pages as count-diagnostic only: no target rows', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [])]))
    plane.processPage(
      page('files', [
        { id: 'file-1', name: 'a.pdf', path: '/x/a.pdf', size: 10 },
        { id: 'file-2', name: 'b.png', path: '/x/b.png', size: 20 }
      ])
    )

    expect(db.select().from(schema.fileReferences).all()).toEqual([])
    const source = plane.getSourceReadStats()
    expect(source.sourceFileRecordCount).toBe(2)
    const candidate = plane.getCandidateImportStats()
    expect(candidate.fileReferenceCount).toBe(0)
    expect(candidate.pageCount).toBe(2)

    // Invalid file rows still reject.
    expect(() => plane.processPage(page('files', [{ name: 'no-id' }]))).toThrowError(/INVALID_ROW/)
  })

  // -------------------------------------------------------------------------
  // finalize (LOCK-D10)
  // -------------------------------------------------------------------------

  it('rejects finalize when a referenced block was never observed', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', ['b-1', 'b-missing'])])]))
    plane.processPage(page('message_blocks', [srcBlock('b-1', 'm-1')]))

    expect(() => plane.finalize()).toThrowError(/MISSING_BLOCKS.*b-missing/)

    // After the missing block arrives, finalize succeeds and locks the plane.
    plane.processPage(page('message_blocks', [srcBlock('b-missing', 'm-1')]))
    const result = plane.finalize()
    expect(result.candidateImportStats.blockCount).toBe(2)
    expect(() => plane.processPage(page('files', []))).toThrowError(/FINALIZED/)
  })

  // -------------------------------------------------------------------------
  // Stats (LOCK-D9/D10)
  // -------------------------------------------------------------------------

  it('counts only committed pages/rows and returns non-aliased snapshots', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(
      page('topics', [
        srcTopic('t-1', [srcMessage('m-1', 't-1', ['b-1']), srcMessage('m-2', 't-1', [])]),
        srcTopic('t-2', [])
      ])
    )
    plane.processPage(
      page('message_blocks', [
        srcBlock('b-1', 'm-1', {
          type: 'image',
          file: { id: 'file-img', name: 'i.png', path: '/i.png', type: 'image' }
        })
      ])
    )
    plane.processPage(page('topic_segments', [srcSegment('s-1', 't-1', ['m-1', 'm-2'])]))
    plane.processPage(page('files', [{ id: 'file-img' }]))

    // A failed page must not change any stats.
    expect(() => plane.processPage(page('files', [{ notAnId: true }]))).toThrow()

    const source = plane.getSourceReadStats()
    expect(source).toEqual({
      topicRecordCount: 2,
      blockRecordCount: 1,
      segmentRecordCount: 1,
      sourceFileRecordCount: 1
    })

    const candidate = plane.getCandidateImportStats()
    expect(candidate).toEqual({
      topicCount: 2,
      messageCount: 2,
      blockCount: 1,
      segmentCount: 1,
      segmentMembershipCount: 2,
      fileReferenceCount: 1,
      pageCount: 4,
      elapsedMs: 0
    })

    // Snapshots must not alias internal state.
    candidate.topicCount = 999
    source.topicRecordCount = 999
    expect(plane.getCandidateImportStats().topicCount).toBe(2)
    expect(plane.getSourceReadStats().topicRecordCount).toBe(2)

    const finalized = plane.finalize()
    finalized.candidateImportStats.pageCount = 999
    expect(plane.getCandidateImportStats().pageCount).toBe(4)
  })

  it('rejects missing message.blocks arrays and non-JSON-safe embedded messages', () => {
    const plane = createImportDataPlane(db)

    const noBlocks = { ...srcMessage('m-1', 't-1', []) } as Record<string, unknown>
    delete noBlocks.blocks
    expect(() => plane.processPage(page('topics', [srcTopic('t-1', [noBlocks as JsonObject])]))).toThrowError(
      /field 'blocks' must be an array/
    )

    const unsafe = srcMessage('m-1', 't-1', [], { when: new Date() as unknown as string })
    expect(() => plane.processPage(page('topics', [srcTopic('t-1', [unsafe])]))).toThrowError(/not JSON-safe/)
  })
})
