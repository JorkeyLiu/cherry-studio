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
import type { ReadPageResponse } from '@shared/chatImport/types'
import Database from 'better-sqlite3'
import { asc, eq } from 'drizzle-orm'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { runMigrations } from '../../chatDb/migration'
import { createImportWriter } from '../../chatDb/repository/ImportWriter'
import * as schema from '../../chatDb/schema'
import { projectFileReferences, wireToBlock, wireToMessage } from '../../chatDb/wireAdapters'
import { ChatImportDataPlaneError, createImportDataPlane } from '../importDataPlane'
import { canonicalDigest } from '../verification/canonicalJson'

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

    // The candidate row is stored under the authoritative OUTER topic.
    const msg = db.select().from(schema.messages).where(eq(schema.messages.id, 'm-1')).get() as any
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
    // canonicalize to the same outer topic; the duplicate gate must still
    // reject.
    expect(() =>
      plane.processPage(
        page('topics', [srcTopic('t-1', [srcMessage('m-dup', 't-stale-a', []), srcMessage('m-dup', 't-stale-b', [])])])
      )
    ).toThrowError(/DUPLICATE_RELATION/)

    // Duplicate message ID across committed pages.
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-stale', [])])]))
    expect(() =>
      plane.processPage(page('topics', [srcTopic('t-2', [srcMessage('m-1', 't-stale-2', [])])]))
    ).toThrowError(/DUPLICATE_RELATION/)

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

    // Segment membership ownership stays strict: m-4 belongs to t-4, so a
    // segment claiming imported topic t-1 with that message must reject.
    expect(() => plane.processPage(page('topic_segments', [srcSegment('s-1', 't-1', ['m-4'])]))).toThrowError(
      /belongs to topic 't-4'/
    )

    // Count reflects only committed canonicalizations (m-1 and m-4).
    expect(plane.getNormalizationStats().topicIdNormalizationCount).toBe(2)
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

    // Evidence topicId is the canonical OUTER topic — never the stale claim.
    expect(manifest.messages.entries['m-1'].topicId).toBe('t-1')
    expect(manifest.messages.entries['m-2'].topicId).toBe('t-2')

    // The digest is framed from the canonical projection (topicId = outer).
    const expected = wireToMessage(msg1)
    expected.topicId = 't-1'
    expected.sortOrder = 0
    expect(manifest.messages.entries['m-1'].digest).toBe(canonicalDigest({ ...expected }))
    expect(manifest.messages.entries['m-1'].overflowDigest).toBe(canonicalDigest(expected.overflow))

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

  it('rejects an unreferenced block row claiming an existing message (LOCK-BLOCK-1 strict)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', [])])]))

    // b-ghost is not referenced, but its messageId m-1 IS imported — not an
    // orphan: strict OWNERSHIP_MISMATCH, never skipped.
    expect(() => plane.processPage(page('message_blocks', [srcBlock('b-ghost', 'm-1')]))).toThrowError(
      /OWNERSHIP_MISMATCH/
    )
    expect(plane.getNormalizationStats().unreachableBlockSkipCount).toBe(0)
    expect(db.select().from(schema.messageBlocks).all()).toEqual([])
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

    // Missing type/status/createdAt still reject (strict row shape retained).
    const noType = { ...srcBlock('b-orphan', 'm-dead') } as Record<string, unknown>
    delete noType.type
    expect(() => plane.processPage(page('message_blocks', [noType as JsonObject]))).toThrowError(/field 'type'/)

    expect(plane.getNormalizationStats().unreachableBlockSkipCount).toBe(0)
    expect(db.select().from(schema.messageBlocks).all()).toEqual([])
  })

  it('does not count or poison the source-seen registry when a page rolls back (LOCK-BLOCK-1)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', ['b-1'])])]))

    // Pre-seed a block row directly so the message_blocks page passes
    // validation but hits a PRIMARY KEY violation inside the tx. The page
    // also carries an orphan row — the rollback must drop BOTH the skip
    // count delta and the orphan's source-seen registration.
    createImportWriter(db).insertBlocks([
      {
        id: 'b-1',
        messageId: 'm-1',
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

    const msgRow = db.select().from(schema.messages).where(eq(schema.messages.id, 'm-norm-1')).get() as any
    expect(msgRow).toBeDefined()
    expect(msgRow.topicId).toBe('t-norm-1')

    const block1Row = db.select().from(schema.messageBlocks).where(eq(schema.messageBlocks.id, 'b-norm-1')).get() as any
    expect(block1Row).toBeDefined()
    expect(block1Row.messageId).toBe('m-norm-1')

    const block2Row = db.select().from(schema.messageBlocks).where(eq(schema.messageBlocks.id, 'b-norm-2')).get() as any
    expect(block2Row).toBeDefined()
    expect(block2Row.messageId).toBe('m-norm-1')

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
    expect(Object.keys(manifest.messages.entries)).toEqual(['m-norm-1'])
    expect(Object.keys(manifest.blocks.entries).sort()).toEqual(['b-norm-1', 'b-norm-2'])

    // Message block membership verified in manifest.
    expect(manifest.blocks.entries['b-norm-1'].messageId).toBe('m-norm-1')
    expect(manifest.blocks.entries['b-norm-2'].messageId).toBe('m-norm-1')

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

    // Counts + complete ID coverage across every dimension.
    expect(manifest.topics.count).toBe(1)
    expect(manifest.messages.count).toBe(2)
    expect(manifest.blocks.count).toBe(2)
    expect(manifest.fileReferences.count).toBe(1)
    expect(manifest.segments.count).toBe(1)
    expect(manifest.memberships.rowCount).toBe(2)
    expect(manifest.committedPageCount).toBe(4)
    expect(Object.keys(manifest.messages.entries).sort()).toEqual(['m-1', 'm-2'])
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
    // overflow, sortOrder from the embedded array index).
    const expectedMsg1 = wireToMessage(msg1)
    expectedMsg1.sortOrder = 0
    expect(manifest.messages.entries['m-1']).toEqual({
      topicId: 't-1',
      sortOrder: 0,
      digest: canonicalDigest({ ...expectedMsg1 }),
      overflowDigest: canonicalDigest(expectedMsg1.overflow),
      structuredModelDigest: canonicalDigest(structuredModel)
    })
    const expectedMsg2 = wireToMessage(msg2)
    expectedMsg2.sortOrder = 1
    expect(manifest.messages.entries['m-2']).toEqual({
      topicId: 't-1',
      sortOrder: 1,
      digest: canonicalDigest({ ...expectedMsg2 }),
      overflowDigest: canonicalDigest(expectedMsg2.overflow),
      structuredModelDigest: null
    })

    // Block digests match the wire projection (tool object content moved to
    // overflow) with parent-index sortOrder; ownership evidence recorded.
    const expectedFileBlock = wireToBlock(fileBlock)
    expectedFileBlock.sortOrder = 0
    expect(manifest.blocks.entries['b-file']).toEqual({
      messageId: 'm-1',
      sortOrder: 0,
      digest: canonicalDigest({ ...expectedFileBlock }),
      overflowDigest: canonicalDigest(expectedFileBlock.overflow),
      structuredContentDigest: null
    })
    const expectedToolBlock = wireToBlock(toolBlock)
    expectedToolBlock.sortOrder = 1
    expect(manifest.blocks.entries['b-tool']).toEqual({
      messageId: 'm-1',
      sortOrder: 1,
      digest: canonicalDigest({ ...expectedToolBlock }),
      overflowDigest: canonicalDigest(expectedToolBlock.overflow),
      structuredContentDigest: canonicalDigest({ toolName: 'search', result: { hits: 2 } })
    })

    // Derived file reference evidence (projection-derived, not source files).
    const expectedRef = projectFileReferences(expectedFileBlock)[0]
    expect(manifest.fileReferences.entries[expectedRef.id]).toEqual({
      blockId: 'b-file',
      digest: canonicalDigest({ ...expectedRef }),
      overflowDigest: canonicalDigest({})
    })

    // Segment digest (overflow keeps color, excludes messageIds) + membership
    // order exactly as the source array (m-2 before m-1).
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
    expect(manifest.memberships.bySegment['s-1']).toEqual(['m-2', 'm-1'])

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
    expect(Object.keys(manifest.messages.entries)).toEqual(['m-1'])
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
    expect(Object.isFrozen(first.messages.entries['m-1'])).toBe(true)
    expect(() => {
      ;(first.topics.entries['t-1'] as { digest: string }).digest = 'tampered'
    }).toThrowError(TypeError)

    // A second finalize() keeps Phase 4.2 semantics and the same evidence.
    const stats = plane.finalize()
    expect(stats.candidateImportStats.topicCount).toBe(1)
    expect(plane.getSourceVerificationManifest()).toBe(first)
  })
})
