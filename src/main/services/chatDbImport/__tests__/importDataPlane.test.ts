/**
 * ChatImportDataPlane tests — real better-sqlite3, no mocks (Phase 4.2).
 *
 * Covers the candidate data plane:
 * - Canonical topic flattening: no `messages` in topics.extra, leaked UI
 *   metadata ignored, deletedAt preserved (LOCK-D2).
 * - Exact message/block/membership order survives pages (LOCK-D3/D5/D6).
 * - Outer-topic ownership canonicalization (LOCK-OWN-1/2): a present valid
 *   non-empty embedded `message.topicId` differing from the outer topic is
 *   projected under the authoritative outer topic and counted once per
 *   committed page; matching values count 0; rolled-back/rejected pages
 *   never leak a count delta. Missing/empty/wrong-type topicId still reject
 *   and duplicate/cross-owner gates stay strict.
 * - Unreachable orphan block canonicalization (LOCK-BLOCK-1/2): a source
 *   `message_blocks` row whose block id is referenced by no imported message
 *   AND whose claimed messageId exists in no imported message is skipped at
 *   the projection boundary — never staged/written/verified — and counted
 *   once per committed page. Rows claiming an existing message stay strict
 *   OWNERSHIP_MISMATCH; duplicate source block rows (imported and skipped,
 *   within/across pages) reject; source counts stay full while candidate/
 *   manifest counts are reachable-only.
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
import { MAX_ARRAY_LENGTH } from '@shared/chatDb'
import type { ReadPageResponse } from '@shared/chatImport/types'
import Database from 'better-sqlite3'
import { asc, eq } from 'drizzle-orm'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { runMigrations } from '../../chatDb/migration'
import { createImportWriter } from '../../chatDb/repository/ImportWriter'
import * as schema from '../../chatDb/schema'
import { projectFileReferences, wireToBlock, wireToMessage } from '../../chatDb/wireAdapters'
import { computeMessageTargetId } from '../identity/messageIdentity'
import type { ImportDataPlaneErrorCode } from '../importDataPlane'
import {
  boundDataPlaneErrorCode,
  boundImportTableLabel,
  boundRendererErrorCode,
  ChatImportDataPlaneError,
  createImportDataPlane,
  findDataPlaneRejection,
  summarizeDataPlaneFailure,
  summarizeDataPlaneRejection,
  summarizeRendererError
} from '../importDataPlane'
import { canonicalDigest } from '../verification/canonicalJson'

/** Deterministic L2 target ID for the source tuple (LOCK-MID-1/2). */
function targetId(outerTopicId: string, legacyMessageId: string): string {
  return computeMessageTargetId(outerTopicId, legacyMessageId)
}

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

    // Message extracted as its own row under its deterministic target ID
    // (LOCK-MID-1: no occurrence retains its legacy ID).
    const msg = db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, targetId('t-1', 'm-1')))
      .get() as any
    expect(msg).toBeDefined()
    expect(msg.topicId).toBe('t-1')
  })

  // -------------------------------------------------------------------------
  // L2 imported-trash retention baseline (LOCK-TRASH-1..10)
  // -------------------------------------------------------------------------

  describe('L2 imported-trash retention marker (LOCK-TRASH-1/2/3/4/5)', () => {
    const MARKER = 'l2TrashRetentionStartedAt'
    const BASELINE = '2026-08-04T00:00:00.000Z'

    function extraOf(topicId: string): string | null {
      const row = db.select().from(schema.topics).where(eq(schema.topics.id, topicId)).get() as any
      return row?.extra ?? null
    }

    it('injects the identical baseline into every soft-deleted topic across pages (LOCK-TRASH-1/2/3)', () => {
      const plane = createImportDataPlane(db, { l2TrashRetentionBaseline: BASELINE })
      plane.processPage(
        page(
          'topics',
          [
            srcTopic('t-del-1', [], { deletedAt: '2020-01-01T00:00:00.000Z' }),
            srcTopic('t-del-2', [], { deletedAt: '2021-02-02T00:00:00.000Z' })
          ],
          true
        )
      )
      plane.processPage(page('topics', [srcTopic('t-del-3', [], { deletedAt: '2022-03-03T00:00:00.000Z' })]))

      for (const id of ['t-del-1', 't-del-2', 't-del-3']) {
        const overflow = JSON.parse(extraOf(id)!) as Record<string, unknown>
        expect(overflow[MARKER]).toBe(BASELINE) // identical string, all pages
      }
    })

    it('active topics receive no marker (LOCK-TRASH-1)', () => {
      const plane = createImportDataPlane(db, { l2TrashRetentionBaseline: BASELINE })
      plane.processPage(
        page('topics', [
          srcTopic('t-active', [], { deletedAt: null }),
          srcTopic('t-del', [], { deletedAt: '2020-01-01T00:00:00.000Z' })
        ])
      )
      expect(extraOf('t-active')).toBeNull()
      const overflow = JSON.parse(extraOf('t-del')!) as Record<string, unknown>
      expect(overflow[MARKER]).toBe(BASELINE)
    })

    it('source reserved-key cannot set/override the marker (LOCK-TRASH-4)', () => {
      const plane = createImportDataPlane(db, { l2TrashRetentionBaseline: BASELINE })
      // A hostile/leaked top-level `l2TrashRetentionStartedAt` field is
      // leaked UI metadata — the canonical projection reads only
      // id/messages/deletedAt, so it is ignored and the importer marker wins.
      plane.processPage(
        page('topics', [
          srcTopic('t-hostile', [], {
            deletedAt: '2020-01-01T00:00:00.000Z',
            [MARKER]: '2099-01-01T00:00:00.000Z'
          })
        ])
      )
      const overflow = JSON.parse(extraOf('t-hostile')!) as Record<string, unknown>
      expect(overflow[MARKER]).toBe(BASELINE)
      // Active topic with a leaked marker key → no marker at all.
      plane.processPage(page('topics', [srcTopic('t-hostile-active', [], { [MARKER]: '2099-01-01T00:00:00.000Z' })]))
      expect(extraOf('t-hostile-active')).toBeNull()
    })

    it('exact marker lands in the writer extra column (LOCK-TRASH-3: writer consumes the marker-bearing object)', () => {
      const plane = createImportDataPlane(db, { l2TrashRetentionBaseline: BASELINE })
      plane.processPage(page('topics', [srcTopic('t-writer', [], { deletedAt: '2020-01-01T00:00:00.000Z' })]))
      const extra = extraOf('t-writer')
      expect(extra).toBe(JSON.stringify({ [MARKER]: BASELINE }))
    })

    it('no baseline (legacy mode) writes no marker for soft-deleted topics', () => {
      const plane = createImportDataPlane(db)
      plane.processPage(page('topics', [srcTopic('t-legacy', [], { deletedAt: '2020-01-01T00:00:00.000Z' })]))
      expect(extraOf('t-legacy')).toBeNull()
    })

    it('rejects a non-canonical baseline at construction (LOCK-TRASH-5)', () => {
      expect(() => createImportDataPlane(db, { l2TrashRetentionBaseline: '2026-08-04T00:00:00Z' })).toThrow(
        /strict canonical UTC ISO/
      )
      expect(() => createImportDataPlane(db, { l2TrashRetentionBaseline: 'garbage' })).toThrow(
        /strict canonical UTC ISO/
      )
      expect(() => createImportDataPlane(db, { l2TrashRetentionBaseline: '' })).toThrow(/strict canonical UTC ISO/)
    })
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

    // Message sortOrder = embedded array index; ids are deterministic
    // targets (LOCK-MID-1).
    const msgs = db
      .select({ id: schema.messages.id, sortOrder: schema.messages.sortOrder })
      .from(schema.messages)
      .where(eq(schema.messages.topicId, 't-1'))
      .orderBy(asc(schema.messages.sortOrder))
      .all()
    expect(msgs).toEqual([
      { id: targetId('t-1', 'm-c'), sortOrder: 0 },
      { id: targetId('t-1', 'm-a'), sortOrder: 1 }
    ])

    // Block sortOrder = index in the parent message.blocks array, not
    // page/id order; block.messageId is the owner's target (LOCK-REF-1).
    const blocks = db
      .select({ id: schema.messageBlocks.id, sortOrder: schema.messageBlocks.sortOrder })
      .from(schema.messageBlocks)
      .where(eq(schema.messageBlocks.messageId, targetId('t-1', 'm-c')))
      .orderBy(asc(schema.messageBlocks.sortOrder))
      .all()
    expect(blocks).toEqual([
      { id: 'b-9', sortOrder: 0 },
      { id: 'b-1', sortOrder: 1 }
    ])

    // Membership sortOrder = messageIds array index; memberships persist as
    // target IDs (LOCK-REF-1).
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
      { messageId: targetId('t-1', 'm-a'), sortOrder: 0 },
      { messageId: targetId('t-1', 'm-c'), sortOrder: 1 }
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
    const msg = db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, targetId('t-1', 'm-1')))
      .get() as any
    expect(msg).toBeDefined()
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

  // -------------------------------------------------------------------------
  // Outer-topic ownership canonicalization (LOCK-OWN-1/2)
  //
  // A PRESENT valid non-empty embedded `message.topicId` that differs from
  // the authoritative outer `topic.id` is canonicalized to the outer topic
  // on the projected MessageData and counted. Matching values count 0;
  // missing/empty/wrong-type still reject; duplicate/cross-owner gates
  // stay strict; the count is transactional (rejected pages leak nothing).
  // -------------------------------------------------------------------------

  it('canonicalizes a valid stale message.topicId to the outer topic and counts it once', () => {
    const plane = createImportDataPlane(db)

    // m-1 claims topic 't-stale' but lives inside outer topic 't-1'.
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-stale', ['b-1'])])]))
    plane.processPage(page('message_blocks', [srcBlock('b-1', 'm-1')]))

    // The candidate row is stored under the authoritative OUTER topic and
    // the deterministic target ID (LOCK-MID-1).
    const msg = db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, targetId('t-1', 'm-1')))
      .get() as any
    expect(msg).toBeDefined()
    expect(msg.topicId).toBe('t-1')

    // The count is exactly 1 for the single canonicalized message.
    expect(plane.getNormalizationStats().topicIdNormalizationCount).toBe(1)
    // The raw source object is never mutated.
    const src = db.select().from(schema.topics).where(eq(schema.topics.id, 't-1')).get() as any
    expect(src).toBeDefined()
    expect(src.extra).toBeNull()
  })

  it('counts 0 for matching topicId values and starts at 0 before any commit', () => {
    const plane = createImportDataPlane(db)
    expect(plane.getNormalizationStats().topicIdNormalizationCount).toBe(0)

    plane.processPage(
      page('topics', [
        srcTopic('t-1', [srcMessage('m-1', 't-1', []), srcMessage('m-2', 't-1', [])]),
        srcTopic('t-2', [srcMessage('m-3', 't-2', [])])
      ])
    )

    // Matching values never advance the counter.
    expect(plane.getNormalizationStats().topicIdNormalizationCount).toBe(0)

    // Snapshots are non-aliased copies (LOCK-D9 pattern).
    const snapshot = plane.getNormalizationStats()
    ;(snapshot as { topicIdNormalizationCount: number }).topicIdNormalizationCount = 999
    expect(plane.getNormalizationStats().topicIdNormalizationCount).toBe(0)
  })

  it('does not leak a count delta from a rejected or rolled-back page', () => {
    const plane = createImportDataPlane(db)

    // Validation rejection: the mismatched m-bad page is rejected and must
    // not advance the aggregate — even though the valid m-ok message inside
    // the same page would have been canonicalized.
    const badMessage = { ...srcMessage('m-bad', 't-stale', []) } as Record<string, unknown>
    delete badMessage.role
    expect(() =>
      plane.processPage(
        page('topics', [
          srcTopic('t-ok', [srcMessage('m-ok', 't-stale', [])]),
          srcTopic('t-1', [badMessage as JsonObject])
        ])
      )
    ).toThrowError(ChatImportDataPlaneError)
    expect(plane.getNormalizationStats().topicIdNormalizationCount).toBe(0)

    // DB constraint failure mid-transaction: a pre-seeded duplicate topic
    // forces the page to roll back after validation succeeded.
    createImportWriter(db).insertTopics([
      { id: 't-dup', assistantId: null, name: null, createdAt: null, updatedAt: null, deletedAt: null, overflow: {} }
    ])
    expect(() =>
      plane.processPage(
        page('topics', [srcTopic('t-new', [srcMessage('m-new', 't-stale', [])]), srcTopic('t-dup', [])])
      )
    ).toThrow()
    expect(plane.getNormalizationStats().topicIdNormalizationCount).toBe(0)

    // After a successful page the count reflects exactly the committed row.
    plane.processPage(page('topics', [srcTopic('t-new', [srcMessage('m-new', 't-stale', [])])]))
    expect(plane.getNormalizationStats().topicIdNormalizationCount).toBe(1)
  })

  it('rejects missing/empty/number/null/object message.topicId (strict, LOCK-OWN-1)', () => {
    const plane = createImportDataPlane(db)

    // Missing field.
    const noTopic = { ...srcMessage('m-1', 't-1', []) } as Record<string, unknown>
    delete noTopic.topicId
    expect(() => plane.processPage(page('topics', [srcTopic('t-1', [noTopic as JsonObject])]))).toThrowError(
      /field 'topicId' must be a non-empty string/
    )

    // Empty string.
    expect(() => plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', '', [])])]))).toThrowError(
      /field 'topicId' must be a non-empty string/
    )

    // Number.
    const numeric = { ...srcMessage('m-1', 't-1', []), topicId: 42 } as unknown as JsonObject
    expect(() => plane.processPage(page('topics', [srcTopic('t-1', [numeric])]))).toThrowError(
      /field 'topicId' must be a non-empty string/
    )

    // null.
    const nullTopic = { ...srcMessage('m-1', 't-1', []), topicId: null } as unknown as JsonObject
    expect(() => plane.processPage(page('topics', [srcTopic('t-1', [nullTopic])]))).toThrowError(
      /field 'topicId' must be a non-empty string/
    )

    // object.
    const objectTopic = { ...srcMessage('m-1', 't-1', []), topicId: { id: 'x' } } as unknown as JsonObject
    expect(() => plane.processPage(page('topics', [srcTopic('t-1', [objectTopic])]))).toThrowError(
      /field 'topicId' must be a non-empty string/
    )

    // Nothing committed, count stays 0.
    expect(db.select().from(schema.messages).all()).toEqual([])
    expect(plane.getNormalizationStats().topicIdNormalizationCount).toBe(0)
  })

  it('does not let canonicalization bypass duplicate or cross-owner gates (LOCK-OWN-1)', () => {
    const plane = createImportDataPlane(db)

    // Duplicate message ID within one page — both claim a stale topic but
    // canonicalize to the same outer topic; the same-tuple duplicate gate
    // must still reject (LOCK-MID-3).
    expect(() =>
      plane.processPage(
        page('topics', [srcTopic('t-1', [srcMessage('m-dup', 't-stale-a', []), srcMessage('m-dup', 't-stale-b', [])])])
      )
    ).toThrowError(/DUPLICATE_RELATION/)

    // Same-tuple duplicate across committed pages: the same legacy id re-used
    // INSIDE the same outer topic is a duplicate occurrence (LOCK-MID-3).
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-stale', [])])]))
    expect(() =>
      plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-stale-2', [])])]))
    ).toThrowError(/DUPLICATE_RELATION/)

    // Cross-topic legacy-id reuse is a LEGITIMATE distinct occurrence: the
    // same legacy id in a different outer topic maps to a different target
    // (LOCK-MID-1) and imports cleanly.
    plane.processPage(page('topics', [srcTopic('t-2', [srcMessage('m-1', 't-stale-3', [])])]))
    const crossTopic = db.select().from(schema.messages).where(eq(schema.messages.topicId, 't-2')).get() as any
    expect(crossTopic).toBeDefined()
    expect(crossTopic.id).toBe(targetId('t-2', 'm-1'))
    expect(crossTopic.id).not.toBe(targetId('t-1', 'm-1'))

    // Duplicate block claims across messages on a FRESH topic (both
    // canonicalized to t-3 — the block-claim gate must still reject).
    expect(() =>
      plane.processPage(
        page('topics', [
          srcTopic('t-3', [srcMessage('m-2', 't-stale', ['b-x']), srcMessage('m-3', 't-stale', ['b-x'])])
        ])
      )
    ).toThrowError(/DUPLICATE_RELATION/)

    // Commit a fresh topic + message (canonicalized) so the block-owner and
    // segment gates below have real targets.
    plane.processPage(page('topics', [srcTopic('t-4', [srcMessage('m-4', 't-stale', ['b-1'])])]))

    // Block row ownership mismatch stays strict after canonicalization.
    expect(() => plane.processPage(page('message_blocks', [srcBlock('b-1', 'm-wrong')]))).toThrowError(
      /OWNERSHIP_MISMATCH/
    )
    // Commit the referenced block so the segment gate is reachable under the
    // contiguous order contract (LOCK-ORDER-1).
    plane.processPage(page('message_blocks', [srcBlock('b-1', 'm-4')]))

    // Segment membership ownership stays strict: m-4 belongs to t-4, so a
    // segment claiming imported topic t-1 with that message must reject.
    expect(() => plane.processPage(page('topic_segments', [srcSegment('s-1', 't-1', ['m-4'])]))).toThrowError(
      /belongs to topic 't-4'/
    )

    // Count reflects only committed canonicalizations: t-1 m-1, t-2 m-1,
    // t-4 m-4 (three stale claims normalized to their outer topics).
    expect(plane.getNormalizationStats().topicIdNormalizationCount).toBe(3)
  })

  it('records canonical topicId in the source manifest evidence and digest (LOCK-OWN-1/4301)', () => {
    const plane = createImportDataPlane(db)
    const msg1 = srcMessage('m-1', 't-stale', ['b-1'], { unknownMessageKey: { keep: 1 } })
    const msg2 = srcMessage('m-2', 't-2', []) // matching value → no normalization

    plane.processPage(page('topics', [srcTopic('t-1', [msg1])]))
    plane.processPage(page('topics', [srcTopic('t-2', [msg2])]))
    plane.processPage(page('message_blocks', [srcBlock('b-1', 'm-1')]))
    plane.finalize()

    const manifest = plane.getSourceVerificationManifest()

    // Evidence keys and topicId are the canonical TARGET projection —
    // never the legacy id or the stale claim (LOCK-MID-1/OWN-1).
    expect(manifest.messages.entries[targetId('t-1', 'm-1')].topicId).toBe('t-1')
    expect(manifest.messages.entries[targetId('t-2', 'm-2')].topicId).toBe('t-2')

    // The digest is framed from the canonical projection (target id, outer
    // topicId, array-index sortOrder).
    const expected = wireToMessage(msg1)
    expected.id = targetId('t-1', 'm-1')
    expected.topicId = 't-1'
    expected.sortOrder = 0
    expect(manifest.messages.entries[expected.id].digest).toBe(canonicalDigest({ ...expected }))
    expect(manifest.messages.entries[expected.id].overflowDigest).toBe(canonicalDigest(expected.overflow))

    // Aggregate count is stable after finalize and cannot change further.
    expect(plane.getNormalizationStats().topicIdNormalizationCount).toBe(1)
    expect(plane.finalize().candidateImportStats.messageCount).toBe(2)
    expect(plane.getNormalizationStats().topicIdNormalizationCount).toBe(1)
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

    // An unembedded row claiming an EXISTING unique message is now skipped
    // (LOCK-BLOCK-1X: block id in no message.blocks[], claim resolves to
    // exactly one occurrence) — never resurrected, counted Main-only.
    plane.processPage(page('message_blocks', [srcBlock('b-ghost', 'm-1')]))
    expect(plane.getNormalizationStats().skippedExistingOwnerUnembeddedBlockCount).toBe(1)
    expect(plane.getNormalizationStats().unreachableBlockSkipCount).toBe(0)
    expect(db.select().from(schema.messageBlocks).all()).toEqual([])

    // Ownership mismatch with the block index stays strict.
    expect(() => plane.processPage(page('message_blocks', [srcBlock('b-1', 'm-wrong')]))).toThrowError(
      /OWNERSHIP_MISMATCH/
    )
    // Duplicate block row after the first commit.
    plane.processPage(page('message_blocks', [srcBlock('b-1', 'm-1')]))
    expect(() => plane.processPage(page('message_blocks', [srcBlock('b-1', 'm-1')]))).toThrowError(/DUPLICATE_RELATION/)
  })

  it('rejects segments with unknown topic or cross-topic membership (LOCK-D6/SEG-1)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(
      page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', [])]), srcTopic('t-2', [srcMessage('m-2', 't-2', [])])])
    )
    plane.processPage(page('message_blocks', [])) // contiguous order (LOCK-ORDER-1)

    // Absent topic with NO members → skipped (LOCK-SEG-1 vacuous case):
    // topic absent AND every (zero) member unresolvable. No rows produced.
    plane.processPage(page('topic_segments', [srcSegment('s-skip-empty', 't-ghost', [])]))
    expect(plane.getNormalizationStats().skippedSegmentRowCount).toBe(1)
    expect(plane.getNormalizationStats().skippedSegmentMembershipCount).toBe(0)
    expect(db.select().from(schema.topicSegments).all()).toEqual([])

    // Absent topic with ANY globally resolvable member → strict reject.
    expect(() => plane.processPage(page('topic_segments', [srcSegment('s-bad', 't-ghost', ['m-1'])]))).toThrowError(
      /does not match any imported topic/
    )

    // Topic exists but a member is missing → strict reject.
    expect(() => plane.processPage(page('topic_segments', [srcSegment('s-1', 't-1', ['m-ghost'])]))).toThrowError(
      /does not match any imported message/
    )
    // Cross-topic membership → strict reject.
    expect(() => plane.processPage(page('topic_segments', [srcSegment('s-1', 't-1', ['m-2'])]))).toThrowError(
      /belongs to topic 't-2'/
    )
    // Duplicate member ids → strict reject.
    expect(() => plane.processPage(page('topic_segments', [srcSegment('s-1', 't-1', ['m-1', 'm-1'])]))).toThrowError(
      /duplicate id 'm-1'/
    )
    // No segment rows or memberships committed by the failed pages.
    expect(db.select().from(schema.topicSegments).all()).toEqual([])
    expect(db.select().from(schema.topicSegmentMessages).all()).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Unreachable orphan block canonicalization (LOCK-BLOCK-1/2)
  //
  // A source `message_blocks` row is skipped at the source projection
  // boundary iff (a) its block id appears in NO imported message.blocks[]
  // registry AND (b) its claimed `messageId` exists in NO imported message.
  // Skipped rows produce no target rows, file references, manifest evidence,
  // writer inserts, or seen markers; the skip count is Main-only,
  // transactional, and aggregated once. A row claiming an EXISTING message
  // stays a strict OWNERSHIP_MISMATCH; duplicate source block rows (imported
  // and skipped, within/across pages) reject; invalid id/messageId rejects
  // before classification; failed pages neither count nor poison the
  // source-seen registry; raw rows are never mutated.
  // -------------------------------------------------------------------------

  it('skips unreachable orphan block rows and keeps source/candidate/registry counts exact (LOCK-BLOCK-1/2)', () => {
    const plane = createImportDataPlane(db)

    // 20 messages × 6 blocks = 120 referenced blocks; 5 orphan rows with
    // block ids and messageIds absent from every imported message → 125
    // source rows / 120 imported / 5 skipped (diagnostic-equivalent shape).
    const messages: JsonObject[] = []
    const blockRows: JsonObject[] = []
    let blockIndex = 0
    for (let m = 0; m < 20; m++) {
      const messageBlocks: string[] = []
      for (let b = 0; b < 6; b++) {
        const blockId = `b-${blockIndex}`
        messageBlocks.push(blockId)
        blockRows.push(
          srcBlock(blockId, `m-${m}`, b === 0 && m === 0 ? { type: 'file', file: { id: 'file-0', name: 'a.pdf' } } : {})
        )
        blockIndex++
      }
      messages.push(srcMessage(`m-${m}`, 't-1', messageBlocks))
    }
    for (let o = 0; o < 5; o++) {
      // Orphan rows carry file payloads that MUST be ignored (LOCK-BLOCK-1).
      blockRows.push(
        srcBlock(`b-orphan-${o}`, `m-orphan-${o}`, {
          type: 'file',
          file: { id: `f-orphan-${o}`, name: `orphan-${o}.png` }
        })
      )
    }

    plane.processPage(page('topics', [srcTopic('t-1', messages)]))
    plane.processPage(page('message_blocks', blockRows))
    const finalized = plane.finalize()

    // Source accounting remains the full paged row count (125); candidate
    // accounting counts only the 120 imported rows (LOCK-BLOCK-1).
    expect(finalized.sourceReadStats.blockRecordCount).toBe(125)
    expect(finalized.candidateImportStats.blockCount).toBe(120)
    expect(plane.getSourceReadStats().blockRecordCount).toBe(125)
    expect(plane.getCandidateImportStats().blockCount).toBe(120)

    // Main-only normalization aggregate counts exactly the 5 skipped rows.
    const normalization = plane.getNormalizationStats()
    expect(normalization.unreachableBlockSkipCount).toBe(5)
    expect(normalization.topicIdNormalizationCount).toBe(0)

    // Candidate DB holds exactly the 120 reachable blocks, none orphaned.
    const rows = db.select().from(schema.messageBlocks).all() as any[]
    expect(rows).toHaveLength(120)
    for (const row of rows) {
      expect(row.id.startsWith('b-orphan-')).toBe(false)
    }

    // Only the imported file block produced a file reference — orphan file
    // payloads are never projected (LOCK-BLOCK-1).
    const refs = db.select().from(schema.fileReferences).all() as any[]
    expect(refs).toHaveLength(1)
    expect(refs[0].blockId).toBe('b-0')

    // Source verification manifest is reachable-only: 120 block entries,
    // no orphan ids.
    const manifest = plane.getSourceVerificationManifest()
    expect(manifest.blocks.count).toBe(120)
    for (let o = 0; o < 5; o++) {
      expect(manifest.blocks.entries[`b-orphan-${o}`]).toBeUndefined()
    }
    expect(Object.keys(manifest.blocks.entries)).toHaveLength(120)
    expect(manifest.fileReferences.count).toBe(1)
  })

  it('skips an unreferenced block row claiming an existing unique message (LOCK-BLOCK-1X)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', [])])]))

    // b-ghost is not referenced, but its messageId m-1 IS imported as a
    // unique occurrence → LOCK-BLOCK-1X skip (prevents reconstruction
    // resurrection): never staged, never written, counted Main-only.
    plane.processPage(page('message_blocks', [srcBlock('b-ghost', 'm-1')]))
    expect(plane.getNormalizationStats().skippedExistingOwnerUnembeddedBlockCount).toBe(1)
    expect(plane.getNormalizationStats().unreachableBlockSkipCount).toBe(0)
    expect(db.select().from(schema.messageBlocks).all()).toEqual([])
    expect(plane.getCandidateImportStats().blockCount).toBe(0)
  })

  it('rejects duplicate skipped orphan rows within a page and across pages (LOCK-BLOCK-1)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', ['b-1'])])]))

    // Same-page duplicate orphan rows reject.
    expect(() =>
      plane.processPage(
        page('message_blocks', [srcBlock('b-orphan-a', 'm-dead-a'), srcBlock('b-orphan-a', 'm-dead-b')])
      )
    ).toThrowError(/DUPLICATE_RELATION/)

    // A committed orphan then duplicates across pages.
    plane.processPage(page('message_blocks', [srcBlock('b-orphan-b', 'm-dead-b')]))
    expect(() => plane.processPage(page('message_blocks', [srcBlock('b-orphan-b', 'm-dead-c')]))).toThrowError(
      /DUPLICATE_RELATION/
    )

    // Committed rows stay untouched and the count reflects only the valid skip.
    const committedIds = (db.select().from(schema.messageBlocks).all() as any[]).map((row) => row.id)
    expect(committedIds).not.toContain('b-orphan-a')
    expect(committedIds).not.toContain('b-orphan-b')
    expect(plane.getNormalizationStats().unreachableBlockSkipCount).toBe(1)
  })

  it('classifies a duplicate of a committed skipped orphan claiming an existing message as DUPLICATE_RELATION (LOCK-BLOCK-1 precedence)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', [])])]))

    // b-x is skipped as an unreachable orphan on a committed page: block id
    // referenced by no imported message AND messageId m-dead in no message.
    plane.processPage(page('message_blocks', [srcBlock('b-x', 'm-dead')]))
    expect(plane.getNormalizationStats().unreachableBlockSkipCount).toBe(1)

    // Duplicate b-x row now claims the EXISTING imported message m-1. The
    // duplicate gate runs before orphan/owner classification, so this is
    // DUPLICATE_RELATION — never the OWNERSHIP_MISMATCH the orphan boundary
    // would otherwise produce.
    expect(() => plane.processPage(page('message_blocks', [srcBlock('b-x', 'm-1')]))).toThrowError(/DUPLICATE_RELATION/)

    // Same-page variant: a skipped orphan followed on the SAME page by a
    // duplicate claiming the existing message also rejects as DUPLICATE_RELATION.
    expect(() =>
      plane.processPage(page('message_blocks', [srcBlock('b-y', 'm-dead-2'), srcBlock('b-y', 'm-1')]))
    ).toThrowError(/DUPLICATE_RELATION/)

    // Both failed pages rolled back: only the valid first skip is counted.
    expect(plane.getNormalizationStats().unreachableBlockSkipCount).toBe(1)
    expect(db.select().from(schema.messageBlocks).all()).toEqual([])
  })

  it('classifies a duplicate of a committed referenced block with a wrong owner as DUPLICATE_RELATION (LOCK-BLOCK-1 precedence)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', ['b-x', 'b-y'])])]))

    // b-x is committed as m-1's block.
    plane.processPage(page('message_blocks', [srcBlock('b-x', 'm-1')]))
    expect(plane.getCandidateImportStats().blockCount).toBe(1)

    // Duplicate b-x row now claims a DIFFERENT owner m-wrong. The duplicate
    // gate runs before owner-index classification, so this is
    // DUPLICATE_RELATION — never the OWNERSHIP_MISMATCH the mismatched owner
    // would otherwise produce.
    expect(() => plane.processPage(page('message_blocks', [srcBlock('b-x', 'm-wrong')]))).toThrowError(
      /DUPLICATE_RELATION/
    )

    // Same-page variant: an imported row followed on the SAME page by a
    // duplicate with a wrong owner also rejects as DUPLICATE_RELATION.
    expect(() =>
      plane.processPage(page('message_blocks', [srcBlock('b-y', 'm-1'), srcBlock('b-y', 'm-wrong')]))
    ).toThrowError(/DUPLICATE_RELATION/)

    // Both failed pages rolled back: only the committed b-x remains.
    const committed = db.select().from(schema.messageBlocks).all() as any[]
    expect(committed).toHaveLength(1)
    expect(committed[0].id).toBe('b-x')
    expect(plane.getCandidateImportStats().blockCount).toBe(1)
  })

  it('rejects invalid id/messageId before any orphan classification (LOCK-BLOCK-1)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', [])])]))

    // Missing id — INVALID_ROW before any skip logic.
    const noId = { ...srcBlock('b-x', 'm-dead') } as Record<string, unknown>
    delete noId.id
    expect(() => plane.processPage(page('message_blocks', [noId as JsonObject]))).toThrowError(/field 'id'/)

    // Empty/non-string messageId — INVALID_ROW before classification.
    expect(() => plane.processPage(page('message_blocks', [srcBlock('b-orphan', '')]))).toThrowError(
      /field 'messageId' must be a non-empty string/
    )
    const numericMessageId = { ...srcBlock('b-orphan', 'm-dead'), messageId: 42 } as unknown as JsonObject
    expect(() => plane.processPage(page('message_blocks', [numericMessageId]))).toThrowError(
      /field 'messageId' must be a non-empty string/
    )

    // LOCK-LB-3: skipped rows need NOT satisfy the persist-only required
    // fields type/status/createdAt — only block-profile JSON safety/resource
    // limits and valid id/messageId. A missing `type` on an unreachable
    // orphan is skipped and counted, never rejected.
    const noType = { ...srcBlock('b-orphan', 'm-dead') } as Record<string, unknown>
    delete noType.type
    plane.processPage(page('message_blocks', [noType as JsonObject]))

    expect(plane.getNormalizationStats().unreachableBlockSkipCount).toBe(1)
    expect(db.select().from(schema.messageBlocks).all()).toEqual([])
  })

  it('does not count or poison the source-seen registry when a page rolls back (LOCK-BLOCK-1)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', ['b-1'])])]))

    // Pre-seed a block row directly so the message_blocks page passes
    // validation but hits a PRIMARY KEY violation inside the tx. The page
    // also carries an orphan row — the rollback must drop BOTH the skip
    // count delta and the orphan's source-seen registration. The seeded
    // block's messageId is the owner's TARGET id (LOCK-REF-1).
    createImportWriter(db).insertBlocks([
      {
        id: 'b-1',
        messageId: targetId('t-1', 'm-1'),
        type: 'main_text',
        content: 'seeded',
        status: 'success',
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: null,
        sortOrder: 0,
        overflow: {}
      }
    ])
    expect(() =>
      plane.processPage(page('message_blocks', [srcBlock('b-1', 'm-1'), srcBlock('b-orphan-x', 'm-dead-x')]))
    ).toThrow()

    // No count leaked, and the orphan is NOT poisoned: a fresh retry of the
    // orphan row on a clean page succeeds and is counted once.
    expect(plane.getNormalizationStats().unreachableBlockSkipCount).toBe(0)
    expect(plane.getCandidateImportStats().blockCount).toBe(0)
    plane.processPage(page('message_blocks', [srcBlock('b-orphan-x', 'm-dead-x')]))
    expect(plane.getNormalizationStats().unreachableBlockSkipCount).toBe(1)
  })

  it('leaves raw source block rows unmutated through the orphan path (LOCK-BLOCK-1)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', ['b-1'])])]))

    const orphanRow = srcBlock('b-orphan-keep', 'm-dead-keep', {
      type: 'file',
      content: null,
      file: { id: 'f-keep', name: 'keep.pdf', path: '/x/keep.pdf', type: 'file', size: 5 }
    })
    const before = JSON.parse(JSON.stringify(orphanRow))
    plane.processPage(page('message_blocks', [srcBlock('b-1', 'm-1'), orphanRow]))

    // The raw JsonObject is untouched (LOCK-OWN-1 pattern; skip never mutates).
    expect(orphanRow).toEqual(before)
    expect(plane.getNormalizationStats().unreachableBlockSkipCount).toBe(1)
    // And the orphan's file payload produced no reference row.
    expect(db.select().from(schema.fileReferences).all()).toEqual([])
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
    expect(msgs[0].id).toBe(targetId('t-1', 'm-1'))

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

  it('accepts a legacy message id reused across topics as distinct occurrences (LOCK-MID-1)', () => {
    const plane = createImportDataPlane(db)
    // First committed page: t-1 + m-1.
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', [])])]))

    // A SECOND topic re-uses the SAME legacy id m-1. Under the old global
    // identity this was a duplicate; under LOCK-MID-1 it is a legitimate
    // distinct occurrence mapping to a DIFFERENT target.
    plane.processPage(page('topics', [srcTopic('t-2', [srcMessage('m-1', 't-2', []), srcMessage('m-2', 't-2', [])])]))

    // Both occurrences import under their own deterministic targets.
    const msgs = db.select().from(schema.messages).all() as any[]
    expect(msgs).toHaveLength(3)
    const ids = new Set(msgs.map((m) => m.id))
    expect(ids).toContain(targetId('t-1', 'm-1'))
    expect(ids).toContain(targetId('t-2', 'm-1'))
    expect(ids).toContain(targetId('t-2', 'm-2'))
    // No two occurrences share a target (all-occurrence, zero derived
    // collisions).
    expect(ids.size).toBe(3)

    const candidate = plane.getCandidateImportStats()
    expect(candidate.topicCount).toBe(2)
    expect(candidate.messageCount).toBe(3)
    expect(candidate.pageCount).toBe(2)
  })

  it('rejects a segment id duplicated on a later committed page', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', [])])]))
    plane.processPage(page('message_blocks', [])) // contiguous order (LOCK-ORDER-1)
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
    expect(candidate.pageCount).toBe(3)

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
  // Contiguous table order (LOCK-ORDER-1)
  //
  // Pages may repeat the current table (pagination) or advance exactly one
  // table in IMPORT_ENTITY_ORDER. Forward jumps over required entities and
  // backward moves reject with ENTITY_ORDER_VIOLATION before any write;
  // rejected pages never advance the cursor or the stats.
  // -------------------------------------------------------------------------

  it('rejects a forward jump over a required entity (LOCK-ORDER-1)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [])]))

    // topics → topic_segments skips the required message_blocks table.
    expect(() => plane.processPage(page('topic_segments', [srcSegment('s-1', 't-1', [])]))).toThrowError(
      /ENTITY_ORDER_VIOLATION/
    )
    // topics → files skips BOTH message_blocks and topic_segments.
    expect(() => plane.processPage(page('files', [{ id: 'f-1' }]))).toThrowError(/ENTITY_ORDER_VIOLATION/)

    // Nothing from the rejected pages committed; the cursor is unchanged and
    // a contiguous next page still imports.
    expect(plane.getCandidateImportStats().pageCount).toBe(1)
    expect(db.select().from(schema.topicSegments).all()).toEqual([])
    plane.processPage(page('message_blocks', []))
    plane.processPage(page('topic_segments', [srcSegment('s-1', 't-1', [])]))
    expect(plane.getCandidateImportStats().pageCount).toBe(3)
  })

  it('rejects a backward move to an earlier table (LOCK-ORDER-1)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [])]))
    plane.processPage(page('message_blocks', []))
    expect(() => plane.processPage(page('topics', [srcTopic('t-2', [])]))).toThrowError(/ENTITY_ORDER_VIOLATION/)
    expect(plane.getCandidateImportStats().pageCount).toBe(2)
  })

  it('accepts same-table repeats (pagination) and immediate-next advances (LOCK-ORDER-1)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [])]))
    plane.processPage(page('topics', [srcTopic('t-2', [])])) // repeat current table
    plane.processPage(page('message_blocks', [])) // advance exactly one
    plane.processPage(page('message_blocks', [])) // repeat current table
    plane.processPage(page('topic_segments', [])) // advance exactly one
    plane.processPage(page('files', [{ id: 'f-1' }])) // advance exactly one

    expect(plane.getCandidateImportStats().pageCount).toBe(6)
    expect(plane.getSourceReadStats()).toEqual({
      topicRecordCount: 2,
      blockRecordCount: 0,
      segmentRecordCount: 0,
      sourceFileRecordCount: 1
    })
  })

  it('requires the first page to be topics (LOCK-ORDER-1)', () => {
    const plane = createImportDataPlane(db)
    expect(() => plane.processPage(page('message_blocks', []))).toThrowError(/ENTITY_ORDER_VIOLATION/)
    expect(() => plane.processPage(page('topic_segments', []))).toThrowError(/ENTITY_ORDER_VIOLATION/)
    expect(() => plane.processPage(page('files', []))).toThrowError(/ENTITY_ORDER_VIOLATION/)
    expect(plane.getCandidateImportStats().pageCount).toBe(0)

    // A topics-first stream imports normally.
    plane.processPage(page('topics', [srcTopic('t-1', [])]))
    plane.processPage(page('message_blocks', []))
    expect(plane.getCandidateImportStats().pageCount).toBe(2)
  })

  // -------------------------------------------------------------------------
  // Data-plane rejection summary privacy (LOCK-PRIV-2)
  //
  // summarizeDataPlaneRejection must expose ONLY bounded machine code +
  // table context — never entityId, source/target IDs, error.detail, paths,
  // content, SQL, stack, or the raw error.message.
  // -------------------------------------------------------------------------

  it('summarizes an INVALID_ROW rejection with bounded table context (LOCK-PRIV-2)', () => {
    const plane = createImportDataPlane(db)
    let caught: ChatImportDataPlaneError | null = null
    try {
      plane.processPage(page('topics', [{ id: 'secret-topic-0x1', messages: [{ id: 'secret-msg-0x2' }] }]))
    } catch (e) {
      caught = e as ChatImportDataPlaneError
    }
    expect(caught).toBeInstanceOf(ChatImportDataPlaneError)
    expect(caught!.code).toBe('INVALID_ROW')
    // The raw internal detail DOES carry source values...
    expect(caught!.message).toContain('secret-topic-0x1')
    // ...but the bounded summary never does (LOCK-PRIV-2).
    const summary = summarizeDataPlaneRejection(caught!)
    expect(summary).toBe('DATA_PLANE_REJECTION(INVALID_ROW, table=topics)')
    for (const leaked of ['secret-topic-0x1', 'secret-msg-0x2', 'topics[0]']) {
      expect(summary).not.toContain(leaked)
    }
  })

  it('summarizes a finalize rejection without leaking referenced block IDs (LOCK-PRIV-2)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', ['b-1', 'b-secret-missing'])])]))
    plane.processPage(page('message_blocks', [srcBlock('b-1', 'm-1')]))

    let caught: ChatImportDataPlaneError | null = null
    try {
      plane.finalize()
    } catch (e) {
      caught = e as ChatImportDataPlaneError
    }
    expect(caught).toBeInstanceOf(ChatImportDataPlaneError)
    expect(caught!.code).toBe('MISSING_BLOCKS')
    // The raw detail names the missing source block ID...
    expect(caught!.message).toContain('b-secret-missing')
    // ...but the bounded summary exposes only code + table.
    const summary = summarizeDataPlaneRejection(caught!)
    expect(summary).toContain('DATA_PLANE_REJECTION(MISSING_BLOCKS')
    expect(summary).not.toContain('b-secret-missing')
    expect(summary).not.toContain('b-1')
    expect(summary).not.toContain('m-1')
    expect(summary).not.toContain('t-1')
  })

  // -------------------------------------------------------------------------
  // Summary table allowlist (LOCK-PRIV-3)
  //
  // The summary table may only be one of the fixed production table names;
  // every other value — untrusted renderer-supplied strings and null —
  // renders as the static 'unknown' label. No untrusted string is ever
  // interpolated.
  // -------------------------------------------------------------------------

  it('renders an untrusted table name as static unknown, never interpolated (LOCK-PRIV-3)', () => {
    const malicious = "settings'; DROP TABLE messages; -- ${process.env.SECRET}"
    const rejection = new ChatImportDataPlaneError('UNKNOWN_TABLE', 'no-op detail', {
      tableName: malicious
    })
    const summary = summarizeDataPlaneRejection(rejection)
    expect(summary).toBe('DATA_PLANE_REJECTION(UNKNOWN_TABLE, table=unknown)')
    expect(summary).not.toContain('settings')
    expect(summary).not.toContain('DROP TABLE')
    expect(summary).not.toContain('SECRET')
  })

  it('renders a non-production but benign table name as unknown (LOCK-PRIV-3)', () => {
    const rejection = new ChatImportDataPlaneError('ENTITY_ORDER_VIOLATION', 'no-op detail', {
      tableName: 'settings'
    })
    expect(summarizeDataPlaneRejection(rejection)).toBe('DATA_PLANE_REJECTION(ENTITY_ORDER_VIOLATION, table=unknown)')
  })

  it('renders a null table context as unknown (LOCK-PRIV-3)', () => {
    const rejection = new ChatImportDataPlaneError('FINALIZED', 'no-op detail')
    const summary = summarizeDataPlaneRejection(rejection)
    expect(summary).toBe('DATA_PLANE_REJECTION(FINALIZED, table=unknown)')
    expect(summary).not.toContain('no-op detail')
  })

  it('renders every production table name verbatim (LOCK-PRIV-3)', () => {
    for (const table of ['topics', 'message_blocks', 'topic_segments', 'files'] as const) {
      const rejection = new ChatImportDataPlaneError('INVALID_ROW', 'no-op detail', { tableName: table })
      expect(summarizeDataPlaneRejection(rejection)).toBe(`DATA_PLANE_REJECTION(INVALID_ROW, table=${table})`)
    }
  })

  // -------------------------------------------------------------------------
  // Error-tree search (LOCK-PRIV-4)
  //
  // findDataPlaneRejection detects a ChatImportDataPlaneError through
  // Error.cause chains and AggregateError.errors, cycle-safe and bounded by
  // depth and node count. Unknown values are never stringified during
  // traversal.
  // -------------------------------------------------------------------------

  it('finds a direct data-plane rejection (LOCK-PRIV-4)', () => {
    const rejection = new ChatImportDataPlaneError('INVALID_ROW', 'raw secret detail', { tableName: 'topics' })
    expect(findDataPlaneRejection(rejection)).toBe(rejection)
    expect(findDataPlaneRejection(new Error('plain'))).toBeNull()
    expect(findDataPlaneRejection('plain string value')).toBeNull()
    expect(findDataPlaneRejection(42)).toBeNull()
    expect(findDataPlaneRejection(null)).toBeNull()
    expect(findDataPlaneRejection(undefined)).toBeNull()
  })

  it('finds a data-plane rejection wrapped in a cause chain (LOCK-PRIV-4)', () => {
    const rejection = new ChatImportDataPlaneError('OWNERSHIP_MISMATCH', 'raw secret block id', {
      tableName: 'message_blocks'
    })
    const wrapper = new Error('wrapper message that must never leak')
    wrapper.cause = new Error('intermediate wrapper')
    ;(wrapper.cause as Error).cause = rejection
    expect(findDataPlaneRejection(wrapper)).toBe(rejection)
  })

  it('finds a data-plane rejection inside AggregateError.errors (LOCK-PRIV-4)', () => {
    const rejection = new ChatImportDataPlaneError('MISSING_BLOCKS', 'raw secret block id', {
      tableName: 'message_blocks'
    })
    const aggregate = new AggregateError([new Error('first'), rejection, new Error('third')], 'aggregate message')
    expect(findDataPlaneRejection(aggregate)).toBe(rejection)
  })

  it('traverses cycles without hanging and still finds a reachable rejection (LOCK-PRIV-4)', () => {
    const cycle: any = new Error('self cycle')
    cycle.cause = cycle
    expect(findDataPlaneRejection(cycle)).toBeNull()

    const rejection = new ChatImportDataPlaneError('INVALID_ROW', 'raw secret detail', { tableName: 'topics' })
    const nodeA: any = new Error('a')
    const nodeB: any = new Error('b')
    nodeA.cause = nodeB
    nodeB.cause = nodeA
    nodeB.errors = [rejection]
    expect(findDataPlaneRejection(nodeA)).toBe(rejection)
  })

  it('gives up past the depth bound (LOCK-PRIV-4)', () => {
    const rejection = new ChatImportDataPlaneError('INVALID_ROW', 'raw secret detail', { tableName: 'topics' })
    // 7 cause hops: within the depth bound → found.
    let within: Error = rejection
    for (let i = 0; i < 7; i += 1) {
      const wrapper = new Error(`wrapper-${i}`)
      wrapper.cause = within
      within = wrapper
    }
    expect(findDataPlaneRejection(within)).toBe(rejection)
    // 10 cause hops: beyond the depth bound → not found.
    let beyond: Error = rejection
    for (let i = 0; i < 10; i += 1) {
      const wrapper = new Error(`wrapper-${i}`)
      wrapper.cause = beyond
      beyond = wrapper
    }
    expect(findDataPlaneRejection(beyond)).toBeNull()
  })

  it('gives up past the visited-node bound on a wide tree (LOCK-PRIV-4)', () => {
    const rejection = new ChatImportDataPlaneError('INVALID_ROW', 'raw secret detail', { tableName: 'topics' })
    // Rejection first in the fan-out → found immediately.
    const firstAggregate = new AggregateError([rejection, ...Array.from({ length: 39 }, (_, i) => new Error(`e-${i}`))])
    expect(findDataPlaneRejection(firstAggregate)).toBe(rejection)
    // Rejection last in a 40-entry fan-out: the 32-node budget is exhausted
    // before it is dequeued → not found.
    const wideAggregate = new AggregateError([...Array.from({ length: 39 }, (_, i) => new Error(`e-${i}`)), rejection])
    expect(findDataPlaneRejection(wideAggregate)).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Boundary summary decision (LOCK-PRIV-5)
  //
  // If the error tree contains a data-plane rejection, ONLY the bounded
  // summary is used — never wrapper or raw messages. Trees without one keep
  // the stable generic-error behavior.
  // -------------------------------------------------------------------------

  it('summarizes a wrapper error as the bounded summary, never the wrapper message (LOCK-PRIV-5)', () => {
    const secret = 'secret-topic-0xWrapped'
    const rejection = new ChatImportDataPlaneError('OWNERSHIP_MISMATCH', `detail with ${secret}`, {
      tableName: 'message_blocks'
    })
    const wrapper = new Error(`wrapper message containing ${secret}`)
    wrapper.cause = rejection
    const summary = summarizeDataPlaneFailure(wrapper)
    expect(summary).toBe('DATA_PLANE_REJECTION(OWNERSHIP_MISMATCH, table=message_blocks)')
    expect(summary).not.toContain(secret)
    expect(summary).not.toContain('wrapper message')
  })

  it('summarizes an AggregateError as the bounded summary, never raw entries (LOCK-PRIV-5)', () => {
    const secret = 'secret-block-0xAgg'
    const rejection = new ChatImportDataPlaneError('MISSING_BLOCKS', `detail with ${secret}`, {
      tableName: 'message_blocks'
    })
    const aggregate = new AggregateError([new Error(`raw entry with ${secret}`), rejection])
    const summary = summarizeDataPlaneFailure(aggregate)
    expect(summary).toBe('DATA_PLANE_REJECTION(MISSING_BLOCKS, table=message_blocks)')
    expect(summary).not.toContain(secret)
    expect(summary).not.toContain('raw entry')
  })

  it('preserves the stable generic message for a plain error tree (LOCK-PRIV-5)', () => {
    const plain = new Error('generic failure message')
    expect(summarizeDataPlaneFailure(plain)).toBe('generic failure message')
    // A wrapper tree with no data-plane rejection keeps the top-level message.
    const wrapped = new Error('outer generic message')
    wrapped.cause = new Error('inner generic message')
    expect(summarizeDataPlaneFailure(wrapped)).toBe('outer generic message')
    // Non-error values keep the pre-existing String() fallback.
    expect(summarizeDataPlaneFailure('boom')).toBe('boom')
  })

  // -------------------------------------------------------------------------
  // Sanitizer totality under hostile values (LOCK-PRIV-7/8)
  //
  // The sanitizer is total: for ANY JS value — revoked proxies, hostile
  // getters, throwing iterators/Proxies, Error subclasses with throwing
  // accessors, sparse/huge AggregateError arrays — it returns a bounded
  // fixed string and never throws. Every proxy-sensitive operation is
  // guarded; unsafe inspection degrades to a static generic fallback.
  // -------------------------------------------------------------------------

  /** A revoked proxy: instanceof/get/iterable inspection all throw. */
  function revokedProxy(): object {
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    return proxy
  }

  /** Error whose own `message` accessor throws (hostile accessor). */
  function throwingMessageError(message: string): Error {
    const error = new Error(message)
    Object.defineProperty(error, 'message', {
      get() {
        throw new Error('hostile message getter')
      }
    })
    return error
  }

  it('never throws on a revoked proxy root and degrades to the static label (LOCK-PRIV-7)', () => {
    const proxy = revokedProxy()
    expect(() => findDataPlaneRejection(proxy)).not.toThrow()
    expect(findDataPlaneRejection(proxy)).toBeNull()
    expect(() => summarizeDataPlaneFailure(proxy)).not.toThrow()
    expect(summarizeDataPlaneFailure(proxy)).toBe('unknown import failure')
  })

  it('never throws on hostile getters for cause/errors and continues the search (LOCK-PRIV-7)', () => {
    const hostileCause: any = new Error('outer')
    Object.defineProperty(hostileCause, 'cause', {
      get() {
        throw new Error('hostile cause getter')
      }
    })
    expect(() => findDataPlaneRejection(hostileCause)).not.toThrow()
    expect(findDataPlaneRejection(hostileCause)).toBeNull()

    const hostileErrors: any = new Error('outer')
    Object.defineProperty(hostileErrors, 'errors', {
      get() {
        throw new Error('hostile errors getter')
      }
    })
    expect(() => findDataPlaneRejection(hostileErrors)).not.toThrow()
    expect(findDataPlaneRejection(hostileErrors)).toBeNull()

    // A throwing errors getter on a node that also has a REACHABLE rejection
    // via cause still finds the rejection (the unsafe branch degrades, the
    // safe branch continues).
    const rejection = new ChatImportDataPlaneError('INVALID_ROW', 'raw secret', { tableName: 'topics' })
    const mixed: any = new Error('mixed')
    mixed.cause = rejection
    Object.defineProperty(mixed, 'errors', {
      get() {
        throw new Error('hostile errors getter')
      }
    })
    expect(findDataPlaneRejection(mixed)).toBe(rejection)
    expect(summarizeDataPlaneFailure(mixed)).toBe('DATA_PLANE_REJECTION(INVALID_ROW, table=topics)')
  })

  it('never throws on a hostile array proxy (throwing index/length reads) (LOCK-PRIV-7)', () => {
    const hostileIndex = new Proxy(
      [new Error('first'), new ChatImportDataPlaneError('FINALIZED', 'x', { tableName: 'files' })],
      {
        get(target, prop) {
          if (prop === '0') throw new Error('hostile index read')
          return Reflect.get(target, prop)
        }
      }
    )
    const nodeIndex: any = new Error('wraps hostile index array')
    nodeIndex.errors = hostileIndex
    // The hostile index 0 degrades; the rejection at index 1 is still found.
    expect(() => findDataPlaneRejection(nodeIndex)).not.toThrow()
    const found = findDataPlaneRejection(nodeIndex)
    expect(found).not.toBeNull()
    expect(summarizeDataPlaneFailure(nodeIndex)).toBe('DATA_PLANE_REJECTION(FINALIZED, table=files)')

    const hostileLength = new Proxy([new ChatImportDataPlaneError('INVALID_ROW', 'x', { tableName: 'topics' })], {
      get(target, prop) {
        if (prop === 'length') throw new Error('hostile length read')
        return Reflect.get(target, prop)
      }
    })
    const nodeLength: any = new Error('wraps hostile length array')
    nodeLength.errors = hostileLength
    // The length read throws → zero entries enumerated, never a throw.
    expect(() => findDataPlaneRejection(nodeLength)).not.toThrow()
    expect(findDataPlaneRejection(nodeLength)).toBeNull()
  })

  it('never throws on an Error with a throwing message accessor (LOCK-PRIV-7)', () => {
    const hostile = throwingMessageError('this message must never be read')
    expect(() => findDataPlaneRejection(hostile)).not.toThrow()
    expect(() => summarizeDataPlaneFailure(hostile)).not.toThrow()
    expect(summarizeDataPlaneFailure(hostile)).toBe('unknown import failure')
  })

  it('never throws on a value with a throwing Symbol.toPrimitive (LOCK-PRIV-7)', () => {
    const hostile: any = {
      [Symbol.toPrimitive]() {
        throw new Error('hostile toPrimitive')
      }
    }
    expect(() => summarizeDataPlaneFailure(hostile)).not.toThrow()
    expect(summarizeDataPlaneFailure(hostile)).toBe('unknown import failure')
  })

  it('bounds the generic fallback text to a fixed maximum length (LOCK-PRIV-7)', () => {
    const huge = new Error(`x`.repeat(10_000))
    const summary = summarizeDataPlaneFailure(huge)
    expect(summary.length).toBeLessThanOrEqual(512)
    expect(summary.startsWith('x'.repeat(511))).toBe(true)
  })

  it('summarizes a rejection whose code accessor throws as static UNKNOWN (LOCK-PRIV-7)', () => {
    const rejection = new ChatImportDataPlaneError('INVALID_ROW', 'raw secret', { tableName: 'topics' })
    Object.defineProperty(rejection, 'code', {
      get() {
        throw new Error('hostile code getter')
      }
    })
    expect(() => summarizeDataPlaneRejection(rejection)).not.toThrow()
    expect(summarizeDataPlaneRejection(rejection)).toBe('DATA_PLANE_REJECTION(UNKNOWN, table=topics)')
  })

  it('never throws when a revoked proxy sits in the errors position (LOCK-PRIV-7/8)', () => {
    // A revoked proxy in `errors` throws from Array.isArray (its
    // [[ProxyTarget]] is unreachable); the guarded length read must degrade
    // to zero entries instead of throwing the sanitizer.
    const revoked = revokedProxy()
    const node: any = new Error('wraps revoked errors proxy')
    node.errors = revoked
    expect(() => findDataPlaneRejection(node)).not.toThrow()
    expect(findDataPlaneRejection(node)).toBeNull()
    expect(() => summarizeDataPlaneFailure(node)).not.toThrow()
    expect(summarizeDataPlaneFailure(node)).toBe('wraps revoked errors proxy')

    // A revoked proxy wrapping a real array (revoked before inspection) also
    // degrades to zero entries and never throws.
    const revokedArray = Proxy.revocable([new ChatImportDataPlaneError('FINALIZED', 'x', { tableName: 'files' })], {})
    revokedArray.revoke()
    const nodeArray: any = new Error('wraps revoked array proxy')
    nodeArray.errors = revokedArray.proxy
    expect(() => findDataPlaneRejection(nodeArray)).not.toThrow()
    expect(findDataPlaneRejection(nodeArray)).toBeNull()
    expect(summarizeDataPlaneFailure(nodeArray)).toBe('wraps revoked array proxy')
  })

  it('binds data-plane rejection codes to the fixed production family or static UNKNOWN (LOCK-PRIV-10)', () => {
    // Every production code round-trips verbatim.
    const productionCodes: ImportDataPlaneErrorCode[] = [
      'UNKNOWN_TABLE',
      'ENTITY_ORDER_VIOLATION',
      'INVALID_ROW',
      'DUPLICATE_RELATION',
      'OWNERSHIP_MISMATCH',
      'MISSING_BLOCKS',
      'TARGET_COLLISION',
      'FINALIZED',
      'NOT_FINALIZED'
    ]
    for (const code of productionCodes) {
      expect(boundDataPlaneErrorCode(code)).toBe(code)
    }
    // Any other value — untrusted string, oversized string, non-string — is
    // the static UNKNOWN label, never interpolated.
    const malicious = 'DROP TABLE messages; -- ${process.env.SECRET}'
    const oversized = 'X'.repeat(1_000_000)
    for (const hostile of [malicious, oversized, 'E_LATE', '', 'INVALID_ROW; ', 42, null, undefined, {}]) {
      expect(boundDataPlaneErrorCode(hostile)).toBe('UNKNOWN')
    }
  })

  it('renders a malicious/oversized code getter or string as static UNKNOWN (LOCK-PRIV-10)', () => {
    const malicious = 'DROP TABLE messages; -- ${process.env.SECRET}'
    const rejection = new ChatImportDataPlaneError('INVALID_ROW', 'no-op detail', { tableName: 'topics' })
    Object.defineProperty(rejection, 'code', {
      get() {
        return malicious
      }
    })
    expect(() => summarizeDataPlaneRejection(rejection)).not.toThrow()
    expect(summarizeDataPlaneRejection(rejection)).toBe('DATA_PLANE_REJECTION(UNKNOWN, table=topics)')

    const oversized = new ChatImportDataPlaneError('INVALID_ROW', 'no-op detail', { tableName: 'topics' })
    Object.defineProperty(oversized, 'code', { value: 'X'.repeat(1_000_000) })
    const summary = summarizeDataPlaneRejection(oversized)
    expect(summary).toBe('DATA_PLANE_REJECTION(UNKNOWN, table=topics)')
    expect(summary).not.toContain('X'.repeat(10))
    expect(summary).not.toContain('DROP TABLE')
    expect(summary).not.toContain('SECRET')
  })

  it('preserves every production data-plane rejection code verbatim (LOCK-PRIV-10)', () => {
    const codes: Array<[ImportDataPlaneErrorCode, string]> = [
      ['UNKNOWN_TABLE', 'topics'],
      ['ENTITY_ORDER_VIOLATION', 'topics'],
      ['INVALID_ROW', 'message_blocks'],
      ['DUPLICATE_RELATION', 'message_blocks'],
      ['OWNERSHIP_MISMATCH', 'topic_segments'],
      ['MISSING_BLOCKS', 'files'],
      ['TARGET_COLLISION', 'topics'],
      ['FINALIZED', 'topics'],
      ['NOT_FINALIZED', 'topics']
    ]
    for (const [code, table] of codes) {
      const rejection = new ChatImportDataPlaneError(code, 'no-op detail', { tableName: table })
      expect(summarizeDataPlaneRejection(rejection)).toBe(`DATA_PLANE_REJECTION(${code}, table=${table})`)
    }
  })

  it('does not throw on a non-data-plane AggregateError-like value with hostile entries (LOCK-PRIV-7)', () => {
    const entries: any[] = []
    entries.length = 1_000_000_000 // sparse/huge (LOCK-PRIV-8)
    entries[2] = revokedProxy()
    entries[4] = throwingMessageError('hostile')
    const node: any = new Error('wraps hostile entries')
    node.errors = entries
    expect(() => findDataPlaneRejection(node)).not.toThrow()
    expect(findDataPlaneRejection(node)).toBeNull()
    expect(() => summarizeDataPlaneFailure(node)).not.toThrow()
  })

  it('enumerates at most the remaining budget on a huge sparse errors array (LOCK-PRIV-8)', () => {
    // Counting proxy: every numeric-index get access is tallied. The search
    // must never index beyond the remaining node budget.
    let indexAccesses = 0
    const countingArray = new Proxy(new Array(1_000_000_000), {
      get(target, prop) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) indexAccesses += 1
        return Reflect.get(target, prop)
      }
    })
    const node: any = new Error('wraps huge sparse array')
    node.errors = countingArray
    expect(findDataPlaneRejection(node)).toBeNull()
    expect(indexAccesses).toBeLessThanOrEqual(32)
    expect(summarizeDataPlaneFailure(node)).toBe('wraps huge sparse array')
  })

  it('still finds a rejection placed within the budget of a huge array (LOCK-PRIV-8)', () => {
    const rejection = new ChatImportDataPlaneError('MISSING_BLOCKS', 'raw secret', { tableName: 'message_blocks' })
    const entries: any[] = []
    entries.length = 1_000_000_000
    entries[1] = new Error('noise')
    entries[2] = rejection
    const node: any = new Error('wraps huge array with early rejection')
    node.errors = entries
    expect(findDataPlaneRejection(node)).toBe(rejection)
    expect(summarizeDataPlaneFailure(node)).toBe('DATA_PLANE_REJECTION(MISSING_BLOCKS, table=message_blocks)')
  })

  it('property/fuzz-style sweep: sanitizer never throws and stays bounded', () => {
    const sentinel = 'SENTINEL-0xPRIV7'
    const rejection = new ChatImportDataPlaneError('OWNERSHIP_MISMATCH', `detail with ${sentinel}`, {
      tableName: 'message_blocks'
    })
    const hostileCause: any = new Error('wrapper generic')
    Object.defineProperty(hostileCause, 'cause', {
      get() {
        throw new Error(`hostile ${sentinel}`)
      }
    })
    const sparse: any = new Error('sparse')
    sparse.errors = []
    sparse.errors.length = 1_000_000_000
    const hostileArray = new Proxy([rejection], {
      get(target, prop) {
        if (prop === '0') throw new Error(`hostile ${sentinel}`)
        return Reflect.get(target, prop)
      }
    })
    const hostileMessage = throwingMessageError(`hostile ${sentinel}`)

    const hostileValues: unknown[] = [
      revokedProxy(),
      hostileCause,
      sparse,
      hostileArray,
      hostileMessage,
      { errors: { 0: rejection } }, // non-array errors (ignored, never enumerated)
      new AggregateError([new Error('raw generic entry'), rejection]),
      { [Symbol.toPrimitive]: () => sentinel },
      null,
      undefined,
      42,
      true
    ]

    for (const value of hostileValues) {
      expect(() => findDataPlaneRejection(value)).not.toThrow()
      expect(() => summarizeDataPlaneFailure(value)).not.toThrow()
      const summary = summarizeDataPlaneFailure(value)
      expect(summary.length).toBeLessThanOrEqual(512)
    }
  })

  it('never leaks rejection detail or wrapper messages when a rejection is found (LOCK-PRIV-5/7)', () => {
    const sentinel = 'SENTINEL-0xPrivLeak'
    const rejection = new ChatImportDataPlaneError('OWNERSHIP_MISMATCH', `detail with ${sentinel}`, {
      tableName: 'message_blocks'
    })
    const wrapper = new Error(`wrapper with ${sentinel}`)
    wrapper.cause = rejection
    const aggregate = new AggregateError([new Error(`raw entry with ${sentinel}`), rejection])
    for (const value of [wrapper, aggregate, rejection]) {
      const summary = summarizeDataPlaneFailure(value)
      expect(summary).toContain('DATA_PLANE_REJECTION(OWNERSHIP_MISMATCH, table=message_blocks)')
      expect(summary).not.toContain(sentinel)
    }
  })

  // -------------------------------------------------------------------------
  // Renderer-controlled value bounding (LOCK-PRIV-6)
  // -------------------------------------------------------------------------

  it('binds renderer-supplied table names to the allowlist or static unknown (LOCK-PRIV-6)', () => {
    expect(boundImportTableLabel('topics')).toBe('topics')
    expect(boundImportTableLabel('message_blocks')).toBe('message_blocks')
    expect(boundImportTableLabel('topic_segments')).toBe('topic_segments')
    expect(boundImportTableLabel('files')).toBe('files')
    const malicious = "settings'; DROP TABLE messages; -- ${process.env.SECRET}"
    expect(boundImportTableLabel(malicious)).toBe('unknown')
    expect(boundImportTableLabel('settings')).toBe('unknown')
    expect(boundImportTableLabel('')).toBe('unknown')
    expect(boundImportTableLabel(null)).toBe('unknown')
    expect(boundImportTableLabel(undefined)).toBe('unknown')
    expect(boundImportTableLabel(42)).toBe('unknown')
    expect(boundImportTableLabel({})).toBe('unknown')
  })

  it('binds renderer-supplied error codes to the fixed family or static UNKNOWN (LOCK-PRIV-6)', () => {
    for (const code of [
      'WRONG_ORIGIN',
      'DISCOVERY_REJECTED',
      'DISCOVERY_FAILED',
      'READPAGE_REJECTED',
      'READ_FAILED',
      'RENDERER_GONE'
    ]) {
      expect(boundRendererErrorCode(code)).toBe(code)
    }
    expect(boundRendererErrorCode('DROP TABLE messages; -- ${process.env.SECRET}')).toBe('UNKNOWN')
    expect(boundRendererErrorCode('E_LATE')).toBe('UNKNOWN')
    expect(boundRendererErrorCode('')).toBe('UNKNOWN')
    expect(boundRendererErrorCode(null)).toBe('UNKNOWN')
    expect(boundRendererErrorCode(undefined)).toBe('UNKNOWN')
    expect(boundRendererErrorCode(42)).toBe('UNKNOWN')
  })

  it('summarizes a renderer-reported error as code family only — message never leaks (LOCK-PRIV-6)', () => {
    const sentinel = 'SENTINEL-0xRenderMsg'
    expect(summarizeRendererError({ code: 'READ_FAILED', message: `secret ${sentinel}` })).toBe(
      'RENDERER_ERROR(READ_FAILED)'
    )
    expect(summarizeRendererError({ code: `HACK ${sentinel}`, message: `secret ${sentinel}` })).toBe(
      'RENDERER_ERROR(UNKNOWN)'
    )
    expect(summarizeRendererError({ code: undefined, message: `secret ${sentinel}` })).toBe('RENDERER_ERROR(UNKNOWN)')
    const summary = summarizeRendererError({ code: 'DISCOVERY_FAILED', message: `secret ${sentinel}` })
    expect(summary).not.toContain(sentinel)
  })

  // -------------------------------------------------------------------------
  // Empty segments retained (LOCK-D6)
  // -------------------------------------------------------------------------

  it('retains empty segments', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [])]))
    plane.processPage(page('message_blocks', [])) // contiguous order (LOCK-ORDER-1)
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
    plane.processPage(page('message_blocks', [])) // contiguous order (LOCK-ORDER-1)
    plane.processPage(page('topic_segments', [])) // contiguous order (LOCK-ORDER-1)
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
    expect(candidate.pageCount).toBe(4)

    // Invalid file rows still reject.
    expect(() => plane.processPage(page('files', [{ name: 'no-id' }]))).toThrowError(/INVALID_ROW/)
  })

  it('captures complete source files rows for the attachment plane (LOCK-FIX-2/4/6)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [])]))
    plane.processPage(page('message_blocks', []))
    plane.processPage(page('topic_segments', []))
    plane.processPage(
      page('files', [
        {
          id: 'file-1',
          name: 'file-1.png',
          origin_name: 'photo.png',
          path: '/source/Data/Files/file-1.png',
          size: 10,
          ext: '.png',
          type: 'image',
          created_at: '2020-01-01T00:00:00.000Z',
          count: 3
        },
        // Lenient capture: invalid size/count degrade to null (physical
        // authority at reconcile, LOCK-FIX-6); a previously-accepted row is
        // never newly rejected.
        { id: 'file-2', size: -5, count: 1.5, ext: 42 }
      ])
    )
    plane.finalize()

    const rows = plane.getSourceFileRows()
    expect(rows).toEqual([
      {
        id: 'file-1',
        name: 'file-1.png',
        origin_name: 'photo.png',
        path: '/source/Data/Files/file-1.png',
        size: 10,
        ext: '.png',
        type: 'image',
        created_at: '2020-01-01T00:00:00.000Z',
        count: 3
      },
      {
        id: 'file-2',
        name: null,
        origin_name: null,
        path: null,
        size: null,
        ext: null,
        type: null,
        created_at: null,
        count: null
      }
    ])
    // Snapshots must not alias internal state (the row fields are readonly
    // in the contract; a hostile mutation must not leak into the plane).
    ;(rows[0] as { size: number }).size = 999
    expect(plane.getSourceFileRows()[0].size).toBe(10)

    // Not available before finalize (fresh independent DB + plane).
    const db2 = openTestDb(realPath.join(tempDir, 'candidate2.db'))
    runMigrations(drizzle(db2), db2)
    const plane2 = createImportDataPlane(drizzle(db2))
    plane2.processPage(page('topics', [srcTopic('t-1', [])]))
    plane2.processPage(page('message_blocks', []))
    plane2.processPage(page('topic_segments', []))
    plane2.processPage(page('files', []))
    expect(() => plane2.getSourceFileRows()).toThrowError(/NOT_FINALIZED/)
    expect(() => plane2.getImportedFileReferenceCounts()).toThrowError(/NOT_FINALIZED/)
    plane2.finalize()
    db2.close()
  })

  it('tracks committed file-reference multiplicity for the attachment plane (LOCK-FIX-5/6)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(
      page('topics', [
        srcTopic('t-1', [srcMessage('m-1', 't-1', ['b-1', 'b-2', 'b-3']), srcMessage('m-2', 't-1', ['b-4'])])
      ])
    )
    // Three blocks reference the same file; one references another file.
    plane.processPage(
      page('message_blocks', [
        srcBlock('b-1', 'm-1', {
          type: 'file',
          file: { id: 'f-shared', name: 's.png', path: '/s.png', type: 'image' }
        }),
        srcBlock('b-2', 'm-1', {
          type: 'file',
          file: { id: 'f-shared', name: 's.png', path: '/s.png', type: 'image' }
        }),
        srcBlock('b-3', 'm-1', {
          type: 'image',
          file: { id: 'f-shared', name: 's.png', path: '/s.png', type: 'image' }
        }),
        srcBlock('b-4', 'm-2', {
          type: 'file',
          file: { id: 'f-other', name: 'o.bin', path: '/o.bin', type: 'other' }
        })
      ])
    )
    plane.processPage(page('topic_segments', []))
    plane.processPage(page('files', []))
    plane.finalize()

    const counts = plane.getImportedFileReferenceCounts()
    expect(Object.fromEntries(counts)).toEqual({ 'f-shared': 3, 'f-other': 1 })
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

  // -------------------------------------------------------------------------
  // cloneForWire-normalized realistic shape acceptance (LOCK-N5/N6)
  // -------------------------------------------------------------------------

  it('accepts a cloneForWire-normalized realistic topic/message/block shape and finalizes with manifest (LOCK-N5/N6/C4)', () => {
    // This simulates the exact shape that arrives at the data plane after
    // cloneForWire strips explicit undefined properties from Dexie rows.
    // The shape must be accepted without error — proving the data plane
    // handles the post-normalization payload correctly.
    const plane = createImportDataPlane(db)

    // LOCK-C4: Realistic topic with embedded message — optional fields that
    // cloneForWire strips (assistantId, modelId, model, type, useful, askId,
    // mentions, enabledMCPs, usage, metrics, multiModelMessageStyle,
    // foldSelected) are OMITTED, not supplied as empty strings. This proves
    // the data plane accepts the post-normalization payload where absent
    // optional fields remain absent.
    const normalizedTopic: JsonObject = {
      id: 't-norm-1',
      messages: [
        {
          id: 'm-norm-1',
          role: 'user',
          status: 'success',
          content: 'Normalized realistic message (cloneForWire-stripped undefined fields)',
          createdAt: '2026-08-01T00:00:00.000Z',
          topicId: 't-norm-1',
          blocks: ['b-norm-1', 'b-norm-2']
          // All undefined fields (assistantId, modelId, model, type, useful,
          // askId, mentions, enabledMCPs, usage, metrics, multiModelMessageStyle,
          // foldSelected) are ABSENT — stripped by cloneForWire.
        }
      ],
      deletedAt: null
    }

    // Realistic blocks (undefined error field already stripped by cloneForWire).
    const normalizedBlock1: JsonObject = {
      id: 'b-norm-1',
      messageId: 'm-norm-1',
      type: 'main_text',
      content: 'Normalized block content (cloneForWire-stripped undefined error)',
      status: 'success',
      createdAt: '2026-08-01T00:00:00.000Z'
      // error field ABSENT — stripped by cloneForWire.
    }

    const normalizedBlock2: JsonObject = {
      id: 'b-norm-2',
      messageId: 'm-norm-1',
      type: 'tool',
      content: { toolName: 'web_search', result: { hits: 3 } },
      status: 'success',
      createdAt: '2026-08-01T00:00:00.000Z'
    }

    // Process the normalized pages — must not throw.
    plane.processPage(page('topics', [normalizedTopic]))
    plane.processPage(page('message_blocks', [normalizedBlock1, normalizedBlock2]))

    // Verify the data was accepted and committed.
    const topicRow = db.select().from(schema.topics).where(eq(schema.topics.id, 't-norm-1')).get() as any
    expect(topicRow).toBeDefined()

    const msgRow = db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, targetId('t-norm-1', 'm-norm-1')))
      .get() as any
    expect(msgRow).toBeDefined()
    expect(msgRow.topicId).toBe('t-norm-1')

    const block1Row = db.select().from(schema.messageBlocks).where(eq(schema.messageBlocks.id, 'b-norm-1')).get() as any
    expect(block1Row).toBeDefined()
    expect(block1Row.messageId).toBe(targetId('t-norm-1', 'm-norm-1'))

    const block2Row = db.select().from(schema.messageBlocks).where(eq(schema.messageBlocks.id, 'b-norm-2')).get() as any
    expect(block2Row).toBeDefined()
    expect(block2Row.messageId).toBe(targetId('t-norm-1', 'm-norm-1'))

    // Stats must reflect the accepted records.
    const stats = plane.getCandidateImportStats()
    expect(stats.topicCount).toBe(1)
    expect(stats.messageCount).toBe(1)
    expect(stats.blockCount).toBe(2)

    // LOCK-C4: Finalize and assert source verification manifest/statistics
    // proving accepted committed data. The manifest captures the complete
    // target-equivalent evidence from committed pages.
    const finalized = plane.finalize()
    expect(finalized.candidateImportStats.topicCount).toBe(1)
    expect(finalized.candidateImportStats.messageCount).toBe(1)
    expect(finalized.candidateImportStats.blockCount).toBe(2)
    expect(finalized.candidateImportStats.pageCount).toBe(2)

    const manifest = plane.getSourceVerificationManifest()
    expect(manifest.topics.count).toBe(1)
    expect(manifest.messages.count).toBe(1)
    expect(manifest.blocks.count).toBe(2)
    expect(manifest.committedPageCount).toBe(2)
    expect(Object.keys(manifest.topics.entries)).toEqual(['t-norm-1'])
    expect(Object.keys(manifest.messages.entries)).toEqual([targetId('t-norm-1', 'm-norm-1')])
    expect(Object.keys(manifest.blocks.entries).sort()).toEqual(['b-norm-1', 'b-norm-2'])

    // Message block membership verified in manifest (target IDs, LOCK-REF-1).
    expect(manifest.blocks.entries['b-norm-1'].messageId).toBe(targetId('t-norm-1', 'm-norm-1'))
    expect(manifest.blocks.entries['b-norm-2'].messageId).toBe(targetId('t-norm-1', 'm-norm-1'))

    // Plane is finalized — further processing is rejected.
    expect(() => plane.processPage(page('files', []))).toThrowError(/FINALIZED/)
  })

  // -------------------------------------------------------------------------
  // Source verification manifest (Phase 4.3.1, LOCK-4301/4302)
  // -------------------------------------------------------------------------

  it('rejects manifest access before a successful finalize (LOCK-4301)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [])]))

    let caught: ChatImportDataPlaneError | null = null
    try {
      plane.getSourceVerificationManifest()
    } catch (e) {
      caught = e as ChatImportDataPlaneError
    }
    expect(caught).toBeInstanceOf(ChatImportDataPlaneError)
    expect(caught!.code).toBe('NOT_FINALIZED')
  })

  it('captures complete target-equivalent evidence from committed pages (LOCK-4301/4302)', () => {
    const plane = createImportDataPlane(db)
    const structuredModel = { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', group: 'GPT-4o' }
    const msg1 = srcMessage('m-1', 't-1', ['b-file', 'b-tool'], {
      model: structuredModel,
      unknownMessageKey: { nested: [1, 2, 3] }
    })
    const msg2 = srcMessage('m-2', 't-1', [])
    const fileBlock = srcBlock('b-file', 'm-1', {
      type: 'file',
      content: null,
      file: { id: 'file-1', name: 'doc.pdf', path: '/files/doc.pdf', type: 'file', size: 2048 }
    })
    const toolBlock = srcBlock('b-tool', 'm-1', {
      type: 'tool',
      content: { toolName: 'search', result: { hits: 2 } }
    })

    plane.processPage(page('topics', [srcTopic('t-1', [msg1, msg2], { deletedAt: '2021-06-01T00:00:00.000Z' })]))
    plane.processPage(page('message_blocks', [fileBlock, toolBlock]))
    plane.processPage(page('topic_segments', [srcSegment('s-1', 't-1', ['m-2', 'm-1'], { color: '#ff0000' })]))
    plane.processPage(page('files', [{ id: 'file-1' }, { id: 'file-orphan' }]))
    plane.finalize()

    const manifest = plane.getSourceVerificationManifest()
    const t1m1 = targetId('t-1', 'm-1')
    const t1m2 = targetId('t-1', 'm-2')

    // Counts + complete ID coverage across every dimension (message IDs are
    // deterministic targets — LOCK-MID-1).
    expect(manifest.topics.count).toBe(1)
    expect(manifest.messages.count).toBe(2)
    expect(manifest.blocks.count).toBe(2)
    expect(manifest.fileReferences.count).toBe(1)
    expect(manifest.segments.count).toBe(1)
    expect(manifest.memberships.rowCount).toBe(2)
    expect(manifest.committedPageCount).toBe(4)
    expect(Object.keys(manifest.messages.entries).sort()).toEqual([t1m1, t1m2].sort())
    expect(Object.keys(manifest.blocks.entries).sort()).toEqual(['b-file', 'b-tool'])

    // Topic digest: target-equivalent projection — canonical columns null,
    // deletedAt preserved, empty overflow. Never the raw Dexie topic.
    expect(manifest.topics.entries['t-1'].digest).toBe(
      canonicalDigest({
        id: 't-1',
        assistantId: null,
        name: null,
        createdAt: null,
        updatedAt: null,
        deletedAt: '2021-06-01T00:00:00.000Z',
        overflow: {}
      })
    )

    // Message digests match the exact wire projection (structured model in
    // overflow, target id, sortOrder from the embedded array index).
    const expectedMsg1 = wireToMessage(msg1)
    expectedMsg1.id = t1m1
    expectedMsg1.sortOrder = 0
    expect(manifest.messages.entries[t1m1]).toEqual({
      topicId: 't-1',
      sortOrder: 0,
      digest: canonicalDigest({ ...expectedMsg1 }),
      overflowDigest: canonicalDigest(expectedMsg1.overflow),
      structuredModelDigest: canonicalDigest(structuredModel)
    })
    const expectedMsg2 = wireToMessage(msg2)
    expectedMsg2.id = t1m2
    expectedMsg2.sortOrder = 1
    expect(manifest.messages.entries[t1m2]).toEqual({
      topicId: 't-1',
      sortOrder: 1,
      digest: canonicalDigest({ ...expectedMsg2 }),
      overflowDigest: canonicalDigest(expectedMsg2.overflow),
      structuredModelDigest: null
    })

    // Block digests match the wire projection (tool object content moved to
    // overflow) with parent-index sortOrder; ownership evidence is the
    // owner's TARGET id (LOCK-REF-1).
    const expectedFileBlock = wireToBlock(fileBlock)
    expectedFileBlock.sortOrder = 0
    expectedFileBlock.messageId = t1m1
    expect(manifest.blocks.entries['b-file']).toEqual({
      messageId: t1m1,
      sortOrder: 0,
      digest: canonicalDigest({ ...expectedFileBlock }),
      overflowDigest: canonicalDigest(expectedFileBlock.overflow),
      structuredContentDigest: null
    })
    const expectedToolBlock = wireToBlock(toolBlock)
    expectedToolBlock.sortOrder = 1
    expectedToolBlock.messageId = t1m1
    expect(manifest.blocks.entries['b-tool']).toEqual({
      messageId: t1m1,
      sortOrder: 1,
      digest: canonicalDigest({ ...expectedToolBlock }),
      overflowDigest: canonicalDigest(expectedToolBlock.overflow),
      structuredContentDigest: canonicalDigest({ toolName: 'search', result: { hits: 2 } })
    })

    // Derived file reference evidence (projection-derived, not source files);
    // blockId remains the source block id (LOCK-REF-1).
    const expectedRef = projectFileReferences(expectedFileBlock)[0]
    expect(manifest.fileReferences.entries[expectedRef.id]).toEqual({
      blockId: 'b-file',
      digest: canonicalDigest({ ...expectedRef }),
      overflowDigest: canonicalDigest({})
    })

    // Segment digest (overflow keeps color, excludes messageIds) + membership
    // order exactly as the source array (m-2 before m-1), persisted as
    // target IDs (LOCK-REF-1).
    expect(manifest.segments.entries['s-1']).toEqual({
      topicId: 't-1',
      digest: canonicalDigest({
        id: 's-1',
        topicId: 't-1',
        name: 'Segment s-1',
        createdAt: '2020-01-02T00:00:00.000Z',
        updatedAt: '2020-01-02T00:00:00.000Z',
        sortOrder: 0,
        overflow: { color: '#ff0000' }
      }),
      overflowDigest: canonicalDigest({ color: '#ff0000' })
    })
    expect(manifest.memberships.bySegment['s-1']).toEqual([t1m2, t1m1])

    // Source files stay count-diagnostic only (LOCK-D7): no evidence rows.
    expect(manifest.sourceFiles.recordCount).toBe(2)
    expect(Object.keys(manifest.fileReferences.entries)).toEqual([expectedRef.id])
  })

  it('keeps manifest evidence free of failed pages (LOCK-4301)', () => {
    // Pre-seed a topic to force a PRIMARY KEY violation inside the page tx.
    createImportWriter(db).insertTopics([
      { id: 't-dup', assistantId: null, name: null, createdAt: null, updatedAt: null, deletedAt: null, overflow: {} }
    ])

    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', [])])]))

    // Validation failure: rejected before any staging is committed.
    expect(() => plane.processPage(page('topics', [srcTopic('t-bad', [{ id: 'm-x' } as JsonObject])]))).toThrow()
    // DB constraint failure: staged delta must be dropped with the rollback.
    expect(() =>
      plane.processPage(page('topics', [srcTopic('t-new', [srcMessage('m-new', 't-new', [])]), srcTopic('t-dup', [])]))
    ).toThrow()

    plane.finalize()
    const manifest = plane.getSourceVerificationManifest()
    expect(manifest.topics.count).toBe(1)
    expect(Object.keys(manifest.topics.entries)).toEqual(['t-1'])
    expect(manifest.messages.count).toBe(1)
    expect(Object.keys(manifest.messages.entries)).toEqual([targetId('t-1', 'm-1')])
    expect(manifest.committedPageCount).toBe(1)
  })

  it('returns the same deep-frozen manifest snapshot on every access (LOCK-4301)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', [])])]))
    plane.finalize()

    const first = plane.getSourceVerificationManifest()
    expect(plane.getSourceVerificationManifest()).toBe(first)

    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.topics)).toBe(true)
    expect(Object.isFrozen(first.topics.entries)).toBe(true)
    expect(Object.isFrozen(first.topics.entries['t-1'])).toBe(true)
    expect(Object.isFrozen(first.messages.entries[targetId('t-1', 'm-1')])).toBe(true)
    expect(() => {
      ;(first.topics.entries['t-1'] as { digest: string }).digest = 'tampered'
    }).toThrowError(TypeError)

    // A second finalize() keeps Phase 4.2 semantics and the same evidence.
    const stats = plane.finalize()
    expect(stats.candidateImportStats.topicCount).toBe(1)
    expect(plane.getSourceVerificationManifest()).toBe(first)
  })
})

// ===========================================================================
// LOCK-LB-1/3/4/6 + LOCK-BLOCK-STRICT: bounded large-message-block
// compatibility on the import data plane
//
// message_blocks rows may legally carry nested strings above the generic
// 1 MiB cap. They are bounded by the named block-specific profile (per-string
// 8 MiB, per-row 16 MiB, page aggregate 64 MiB) which runs BEFORE identity
// extraction, the source-seen duplicate gate, and residual classification.
// Skipped rows need not satisfy type/status/createdAt but must satisfy
// profile safety + id/messageId. The page cumulative budget includes EVERY
// incoming row, including later-skipped ones; a rejected page leaks nothing.
// All strict boundaries (duplicate, owner mismatch, ambiguous) stay strict.
// ===========================================================================

describe('ChatImportDataPlane LOCK-LB bounded large blocks', () => {
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

  const BIG_CONTENT = 'x'.repeat(2 * 1024 * 1024 + 700_000) // ~2.67 MiB (artifact mirror)

  it('skips a large unreachable orphan row under the block profile (LOCK-LB-1/3)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', [])])]))

    // 2.67 MiB orphan: id in no message.blocks[] AND messageId in no
    // imported message → skipped and counted, never rejected by the generic
    // 1 MiB cap (LOCK-LB-1/3).
    plane.processPage(page('message_blocks', [srcBlock('b-large-orphan', 'm-dead-large', { content: BIG_CONTENT })]))

    expect(plane.getNormalizationStats().unreachableBlockSkipCount).toBe(1)
    expect(db.select().from(schema.messageBlocks).all()).toEqual([])
    expect(plane.getCandidateImportStats().blockCount).toBe(0)

    plane.finalize()
    const manifest = plane.getSourceVerificationManifest()
    expect(manifest.blocks.count).toBe(0)
    expect(manifest.blocks.entries['b-large-orphan']).toBeUndefined()
  })

  it('skips a large orphan row even when type/status/createdAt are absent (LOCK-LB-3)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', [])])]))

    const sparse = { ...srcBlock('b-large-orphan', 'm-dead-large', { content: BIG_CONTENT }) } as Record<
      string,
      unknown
    >
    delete sparse.type
    delete sparse.status
    delete sparse.createdAt
    plane.processPage(page('message_blocks', [sparse as JsonObject]))

    expect(plane.getNormalizationStats().unreachableBlockSkipCount).toBe(1)
    expect(db.select().from(schema.messageBlocks).all()).toEqual([])
  })

  it('persists a reachable large block with digest round-trip and exact counts (LOCK-LB-6)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', ['b-big'])])]))
    plane.processPage(page('message_blocks', [srcBlock('b-big', 'm-1', { content: BIG_CONTENT })]))

    const block = db.select().from(schema.messageBlocks).where(eq(schema.messageBlocks.id, 'b-big')).get() as any
    expect(block).toBeDefined()
    expect(block.content).toBe(BIG_CONTENT)
    expect(block.messageId).toBe(targetId('t-1', 'm-1')) // LOCK-REF-1
    expect(plane.getCandidateImportStats().blockCount).toBe(1)
    expect(plane.getSourceReadStats().blockRecordCount).toBe(1)

    // The manifest digest round-trips the LARGE content (LOCK-4302/LOCK-LB-6).
    plane.finalize()
    const manifest = plane.getSourceVerificationManifest()
    const expected = wireToBlock(srcBlock('b-big', 'm-1', { content: BIG_CONTENT }))
    expected.sortOrder = 0
    expected.messageId = targetId('t-1', 'm-1')
    expect(manifest.blocks.entries['b-big']).toEqual({
      messageId: targetId('t-1', 'm-1'),
      sortOrder: 0,
      digest: canonicalDigest({ ...expected }),
      overflowDigest: canonicalDigest(expected.overflow),
      structuredContentDigest: null
    })
  })

  it('rejects a block row with a string above 8 MiB as INVALID_ROW (LOCK-LB-1)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', ['b-x'])])]))
    const tooBig = 'x'.repeat(8 * 1024 * 1024 + 1)
    expect(() => plane.processPage(page('message_blocks', [srcBlock('b-x', 'm-1', { content: tooBig })]))).toThrowError(
      /not block-profile JSON-safe/
    )
    expect(plane.getCandidateImportStats().blockCount).toBe(0)
    expect(db.select().from(schema.messageBlocks).all()).toEqual([])
  })

  it('rejects a block row above 16 MiB cumulative as INVALID_ROW (LOCK-LB-1)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', ['b-x'])])]))
    const eight = 'x'.repeat(8 * 1024 * 1024)
    const row = { ...srcBlock('b-x', 'm-1', { content: eight }), content2: eight } as JsonObject
    expect(() => plane.processPage(page('message_blocks', [row]))).toThrowError(/not block-profile JSON-safe/)
    expect(db.select().from(schema.messageBlocks).all()).toEqual([])
  })

  it('bounds a message_blocks page aggregate at 64 MiB including later-skipped rows (LOCK-LB-4)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', [])])]))

    // 11 orphan rows × ~6 MiB ≈ 66 MiB. Every row is under the per-string and
    // per-row caps, but the PAGE aggregate fires during block-profile
    // validation — BEFORE any row is classified as a skip (LOCK-LB-4 counts
    // every incoming row, including rows that would later be skipped).
    const orphanRows = Array.from({ length: 11 }, (_, i) =>
      srcBlock(`b-orphan-${i}`, `m-dead-${i}`, { content: 'x'.repeat(6 * 1024 * 1024) })
    )
    expect(() => plane.processPage(page('message_blocks', orphanRows))).toThrowError(/not block-profile JSON-safe/)

    // Rejected page leaks no skip counts and no candidate rows.
    expect(plane.getNormalizationStats().unreachableBlockSkipCount).toBe(0)
    expect(db.select().from(schema.messageBlocks).all()).toEqual([])

    // Positive control: 10 orphan rows × ~6 MiB ≈ 60 MiB fits the page
    // budget and all are skipped and counted.
    const okRows = Array.from({ length: 10 }, (_, i) =>
      srcBlock(`b-ok-${i}`, `m-dead-ok-${i}`, { content: 'x'.repeat(6 * 1024 * 1024) })
    )
    plane.processPage(page('message_blocks', okRows))
    expect(plane.getNormalizationStats().unreachableBlockSkipCount).toBe(10)
    expect(db.select().from(schema.messageBlocks).all()).toEqual([])
  })

  it('keeps duplicate precedence on large duplicate rows (LOCK-BLOCK-STRICT)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', ['b-x'])])]))
    plane.processPage(page('message_blocks', [srcBlock('b-x', 'm-1', { content: BIG_CONTENT })]))

    // A duplicate large row claiming a different owner still rejects as
    // DUPLICATE_RELATION — never OWNERSHIP_MISMATCH (LOCK-BLOCK-1 precedence
    // is unchanged under the block profile).
    expect(() =>
      plane.processPage(page('message_blocks', [srcBlock('b-x', 'm-wrong', { content: BIG_CONTENT })]))
    ).toThrowError(/DUPLICATE_RELATION/)
    expect(plane.getCandidateImportStats().blockCount).toBe(1)
  })

  it('keeps owner mismatch strict on large rows (LOCK-BLOCK-STRICT)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', ['b-x'])])]))

    // Large row with the WRONG owner claim → strict OWNERSHIP_MISMATCH.
    expect(() =>
      plane.processPage(page('message_blocks', [srcBlock('b-x', 'm-wrong', { content: BIG_CONTENT })]))
    ).toThrowError(/OWNERSHIP_MISMATCH/)
    expect(db.select().from(schema.messageBlocks).all()).toEqual([])
  })

  it('keeps ambiguous unembedded claims strict on large rows (LOCK-BLOCK-STRICT)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(
      page('topics', [
        srcTopic('t-1', [srcMessage('m-shared', 't-1', [])]),
        srcTopic('t-2', [srcMessage('m-shared', 't-2', [])])
      ])
    )
    // Unembedded large row claiming a legacy id in MULTIPLE topics → strict.
    expect(() =>
      plane.processPage(page('message_blocks', [srcBlock('b-ghost', 'm-shared', { content: BIG_CONTENT })]))
    ).toThrowError(/OWNERSHIP_MISMATCH/)
    expect(plane.getNormalizationStats().skippedExistingOwnerUnembeddedBlockCount).toBe(0)
  })

  it('leaks no page aggregate or skip counts from a rolled-back block page (LOCK-LB-4)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', ['b-1'])])]))

    // Pre-seed b-1 so the page passes block-profile validation but hits a
    // PRIMARY KEY violation inside the tx; the page also carries a large
    // orphan whose skip count must roll back with the page.
    createImportWriter(db).insertBlocks([
      {
        id: 'b-1',
        messageId: targetId('t-1', 'm-1'),
        type: 'main_text',
        content: 'seeded',
        status: 'success',
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: null,
        sortOrder: 0,
        overflow: {}
      }
    ])
    expect(() =>
      plane.processPage(
        page('message_blocks', [
          srcBlock('b-1', 'm-1', { content: BIG_CONTENT }),
          srcBlock('b-large-orphan', 'm-dead-large', { content: BIG_CONTENT })
        ])
      )
    ).toThrow()

    // No skip count leaked, and the page-local aggregate accountant is gone:
    // a fresh page with the same large orphan succeeds.
    expect(plane.getNormalizationStats().unreachableBlockSkipCount).toBe(0)
    expect(plane.getCandidateImportStats().blockCount).toBe(0)
    plane.processPage(page('message_blocks', [srcBlock('b-large-orphan', 'm-dead-large', { content: BIG_CONTENT })]))
    expect(plane.getNormalizationStats().unreachableBlockSkipCount).toBe(1)
  })

  it('still requires valid id/messageId on skipped large rows (LOCK-LB-3)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', [])])]))

    // Missing messageId → INVALID_ROW before classification.
    const noMessageId = { ...srcBlock('b-orphan', 'm-dead', { content: BIG_CONTENT }) } as Record<string, unknown>
    delete noMessageId.messageId
    expect(() => plane.processPage(page('message_blocks', [noMessageId as JsonObject]))).toThrowError(
      /field 'messageId'/
    )
    // Non-string messageId → INVALID_ROW.
    expect(() =>
      plane.processPage(page('message_blocks', [srcBlock('b-orphan2', 42 as never, { content: BIG_CONTENT })]))
    ).toThrowError(/field 'messageId'/)
    // A large orphan that is NOT profile-safe (undefined value) → INVALID_ROW.
    expect(() =>
      plane.processPage(
        page('message_blocks', [
          { ...srcBlock('b-orphan3', 'm-dead', { content: BIG_CONTENT }), bad: undefined } as unknown as JsonObject
        ])
      )
    ).toThrowError(/not block-profile JSON-safe/)

    expect(plane.getNormalizationStats().unreachableBlockSkipCount).toBe(0)
    expect(db.select().from(schema.messageBlocks).all()).toEqual([])
  })

  it('rejects a message_blocks page above MAX_ARRAY_LENGTH before projection (LOCK-LB-9)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', ['b-ok'])])]))

    // Dense bounded construction: the cardinality gate fires BEFORE projector
    // iteration, so every slot can share ONE minimal row object that is never
    // walked (and never charged against the page aggregate).
    const sharedRow = srcBlock('b-x', 'm-1')
    const oversized = new Array(MAX_ARRAY_LENGTH + 1).fill(sharedRow)
    expect(() => plane.processPage(page('message_blocks', oversized as JsonObject[]))).toThrowError(
      /exceeding the maximum/
    )

    // The rejected page produces no stats, no index markers, no manifest
    // evidence, and no writes.
    expect(plane.getNormalizationStats().unreachableBlockSkipCount).toBe(0)
    expect(plane.getCandidateImportStats().blockCount).toBe(0)
    expect(plane.getCandidateImportStats().pageCount).toBe(1) // topics page only
    expect(db.select().from(schema.messageBlocks).all()).toEqual([])

    // A subsequent normal block page commits cleanly — nothing was poisoned.
    plane.processPage(page('message_blocks', [srcBlock('b-ok', 'm-1')]))
    expect(plane.getCandidateImportStats().blockCount).toBe(1)

    plane.finalize()
    const manifest = plane.getSourceVerificationManifest()
    expect(manifest.blocks.count).toBe(1)
    expect(manifest.blocks.entries['b-ok']).toBeDefined()
    expect(manifest.blocks.entries['b-x']).toBeUndefined()
  })
})
