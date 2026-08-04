/**
 * L2 deterministic message identity + residual canonicalization tests
 * (LOCK-MID-1/2/3, LOCK-ASK-1/2, LOCK-SEG-1, LOCK-BLOCK-1X, LOCK-REF-1,
 * LOCK-ORPH-1, LOCK-STAT-1). Real better-sqlite3, no mocks.
 *
 * These are the focused tests for the deterministic all-occurrence message
 * identity data plane and the exact approved residual skip boundaries.
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
import { eq } from 'drizzle-orm'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { runMigrations } from '../../chatDb/migration'
import { createImportWriter } from '../../chatDb/repository/ImportWriter'
import * as schema from '../../chatDb/schema'
import { wireToMessage } from '../../chatDb/wireAdapters'
import { computeMessageTargetId } from '../identity/messageIdentity'
import { ChatImportDataPlaneError, createImportDataPlane } from '../importDataPlane'
import { canonicalDigest } from '../verification/canonicalJson'

// ---------------------------------------------------------------------------
// Harness (mirrors importDataPlane.test.ts)
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-mid-'))
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
function page(tableName: string, items: JsonObject[]): ReadPageResponse {
  return { tableName, items, cursor: null, hasMore: false }
}
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
function srcTopic(id: string, messages: JsonObject[]): JsonObject {
  return { id, messages } as JsonObject
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
function srcSegment(id: string, topicId: string, messageIds: string[]): JsonObject {
  return {
    id,
    topicId,
    name: `Segment ${id}`,
    messageIds,
    createdAt: '2020-01-02T00:00:00.000Z',
    updatedAt: '2020-01-02T00:00:00.000Z'
  } as JsonObject
}
function targetId(outerTopicId: string, legacyMessageId: string): string {
  return computeMessageTargetId(outerTopicId, legacyMessageId)
}

describe('ChatImportDataPlane L2 identity + residual locks', () => {
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
  // LOCK-MID all-occurrence identity
  // -------------------------------------------------------------------------

  it('maps every occurrence of a reused legacy id to its own deterministic target (LOCK-MID-1)', () => {
    const plane = createImportDataPlane(db)
    // Cross-topic reuse of 'm-shared' — 3 occurrences in 3 topics, plus one
    // unique message. Mirrors the artifact's 97 reuse groups / 270
    // duplicate occurrences: every occurrence maps, none retains the legacy
    // id, and no two occurrences share a target (zero derived collisions).
    plane.processPage(
      page('topics', [
        srcTopic('t-1', [srcMessage('m-shared', 't-1', []), srcMessage('m-only', 't-1', [])]),
        srcTopic('t-2', [srcMessage('m-shared', 't-2', [])]),
        srcTopic('t-3', [srcMessage('m-shared', 't-3', [])])
      ])
    )

    const rows = db.select().from(schema.messages).all() as any[]
    expect(rows).toHaveLength(4)
    const ids = new Set(rows.map((row) => row.id))
    expect(ids).toEqual(
      new Set([
        targetId('t-1', 'm-shared'),
        targetId('t-2', 'm-shared'),
        targetId('t-3', 'm-shared'),
        targetId('t-1', 'm-only')
      ])
    )
    // No legacy id appears in the candidate (all-occurrence, no first-occurrence
    // retention) and no two occurrences collide.
    expect(rows.some((row) => row.id === 'm-shared')).toBe(false)
    expect(ids.size).toBe(4)
    expect(plane.getCandidateImportStats().messageCount).toBe(4)
  })

  it('rejects a same-tuple duplicate on a later committed page (LOCK-MID-3, transactional)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', [])])]))

    let caught: ChatImportDataPlaneError | null = null
    try {
      // Same (t-1, m-1) tuple on a later page → DUPLICATE_RELATION.
      plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', [])])]))
    } catch (e) {
      caught = e as ChatImportDataPlaneError
    }
    expect(caught).toBeInstanceOf(ChatImportDataPlaneError)
    expect(caught!.code).toBe('DUPLICATE_RELATION')
    // Nothing from the rejected page committed; index not poisoned: the same
    // legacy id in a DIFFERENT topic still imports.
    expect(db.select().from(schema.messages).all()).toHaveLength(1)
    plane.processPage(page('topics', [srcTopic('t-2', [srcMessage('m-1', 't-2', [])])]))
    expect(db.select().from(schema.messages).all()).toHaveLength(2)
  })

  it('maps a legacy id that looks like a target prefix without special-casing', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('l2m1:not-a-real-target', 't-1', [])])]))
    const row = db.select().from(schema.messages).where(eq(schema.messages.topicId, 't-1')).get() as any
    expect(row.id).toBe(targetId('t-1', 'l2m1:not-a-real-target'))
  })

  // -------------------------------------------------------------------------
  // LOCK-ASK-1/2 askId
  // -------------------------------------------------------------------------

  it('rewrites a same-topic askId to the occurrence target ID (LOCK-ASK-1)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(
      page('topics', [
        srcTopic('t-1', [
          srcMessage('m-user', 't-1', []),
          srcMessage('m-asst-1', 't-1', [], { askId: 'm-user' }),
          srcMessage('m-asst-2', 't-1', [], { askId: 'm-user' })
        ])
      ])
    )

    const rows = db.select().from(schema.messages).all() as any[]
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(byId.get(targetId('t-1', 'm-asst-1'))!.askId).toBe(targetId('t-1', 'm-user'))
    expect(byId.get(targetId('t-1', 'm-asst-2'))!.askId).toBe(targetId('t-1', 'm-user'))
    expect(plane.getNormalizationStats().danglingAskIdPreservedCount).toBe(0)

    // The manifest digest carries the REWRITTEN askId (LOCK-ASK-1/4301).
    plane.finalize()
    const manifest = plane.getSourceVerificationManifest()
    const expected = wireToMessage(srcMessage('m-asst-2', 't-1', [], { askId: 'm-user' }))
    expected.id = targetId('t-1', 'm-asst-2')
    expected.topicId = 't-1'
    expected.sortOrder = 2
    expected.askId = targetId('t-1', 'm-user')
    expect(manifest.messages.entries[expected.id].digest).toBe(canonicalDigest({ ...expected }))
  })

  it('preserves a dangling askId verbatim and counts it Main-only (LOCK-ASK-1/2)', () => {
    const plane = createImportDataPlane(db)
    // Two assistant messages share the SAME dangling askId value — grouping
    // coherence must survive (never nulled or re-bound).
    plane.processPage(
      page('topics', [
        srcTopic('t-1', [
          srcMessage('m-a', 't-1', [], { askId: 'zz-dangling' }),
          srcMessage('m-b', 't-1', [], { askId: 'zz-dangling' })
        ])
      ])
    )
    plane.processPage(page('topics', [srcTopic('t-2', [srcMessage('m-c', 't-2', [], { askId: 'zz-other-dangling' })])]))

    const rows = db.select().from(schema.messages).all() as any[]
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(byId.get(targetId('t-1', 'm-a'))!.askId).toBe('zz-dangling')
    expect(byId.get(targetId('t-1', 'm-b'))!.askId).toBe('zz-dangling')
    expect(byId.get(targetId('t-2', 'm-c'))!.askId).toBe('zz-other-dangling')
    // Per-message committed count only.
    expect(plane.getNormalizationStats().danglingAskIdPreservedCount).toBe(3)

    // Finalize succeeds: no preserved value equals any target ID.
    expect(() => plane.finalize()).not.toThrow()
  })

  it('does not cross-topic bind an askId whose target exists only in another topic (LOCK-ASK-1)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(
      page('topics', [
        srcTopic('t-1', [srcMessage('m-a', 't-1', [], { askId: 'm-user' })]),
        srcTopic('t-2', [srcMessage('m-user', 't-2', [])])
      ])
    )
    const row = db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, targetId('t-1', 'm-a')))
      .get() as any
    // (t-1, 'm-user') is NOT an occurrence — preserved verbatim, never bound
    // to t-2's occurrence.
    expect(row.askId).toBe('m-user')
    expect(plane.getNormalizationStats().danglingAskIdPreservedCount).toBe(1)
    expect(() => plane.finalize()).not.toThrow()
  })

  it('rejects empty and non-string askId (never silently accepted, LOCK-ASK-1)', () => {
    const plane = createImportDataPlane(db)
    expect(() =>
      plane.processPage(
        page('topics', [srcTopic('t-1', [{ ...srcMessage('m-1', 't-1', []), askId: '' } as JsonObject])])
      )
    ).toThrowError(/field 'askId' must not be an empty string/)
    expect(() =>
      plane.processPage(
        page('topics', [srcTopic('t-1', [{ ...srcMessage('m-1', 't-1', []), askId: 42 } as unknown as JsonObject])])
      )
    ).toThrowError(/field 'askId' must be a string or null/)
    expect(db.select().from(schema.messages).all()).toEqual([])
    expect(plane.getNormalizationStats().danglingAskIdPreservedCount).toBe(0)
  })

  it('rejects a preserved dangling askId equal to a target message ID at finalize (LOCK-ASK-1 post-map)', () => {
    const plane = createImportDataPlane(db)
    // m-y's askId equals m-x's TARGET ID, but (t-1, thatValue) is not a
    // source occurrence, so it is preserved as dangling. After ALL target
    // IDs are known the preserved value equals a target → strict reject.
    plane.processPage(
      page('topics', [
        srcTopic('t-1', [srcMessage('m-x', 't-1', []), srcMessage('m-y', 't-1', [], { askId: targetId('t-1', 'm-x') })])
      ])
    )
    expect(() => plane.finalize()).toThrowError(/TARGET_COLLISION/)
    // A collision-free second message set finalizes normally (control).
    const plane2 = createImportDataPlane(db)
    plane2.processPage(page('topics', [srcTopic('t-ctrl', [srcMessage('m-x', 't-ctrl', [])])]))
    expect(() => plane2.finalize()).not.toThrow()
  })

  it('does not leak the dangling-preserved count from a rejected page (LOCK-STAT-1)', () => {
    const plane = createImportDataPlane(db)
    const bad = { ...srcMessage('m-bad', 't-1', [], { askId: 'x-dangling' }) } as Record<string, unknown>
    delete bad.role
    expect(() =>
      plane.processPage(
        page('topics', [
          srcTopic('t-ok', [srcMessage('m-ok', 't-ok', [], { askId: 'x-dangling' })]),
          srcTopic('t-1', [bad as JsonObject])
        ])
      )
    ).toThrowError(ChatImportDataPlaneError)
    expect(plane.getNormalizationStats().danglingAskIdPreservedCount).toBe(0)
  })

  // -------------------------------------------------------------------------
  // LOCK-SEG-1 segment skip
  // -------------------------------------------------------------------------

  it('skips an absent-topic segment whose members are all unresolvable and counts rows+memberships (LOCK-SEG-1)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', [])])]))
    plane.processPage(page('message_blocks', [])) // contiguous order (LOCK-ORDER-1)
    plane.processPage(
      page('topic_segments', [
        srcSegment('s-ghost', 't-ghost', ['m-dead-a', 'm-dead-b']),
        srcSegment('s-ok', 't-1', ['m-1'])
      ])
    )

    // Skip counts: exactly the one skipped row and its 2 memberships.
    const stats = plane.getNormalizationStats()
    expect(stats.skippedSegmentRowCount).toBe(1)
    expect(stats.skippedSegmentMembershipCount).toBe(2)

    // Only the valid segment persisted, with the membership as target ID.
    const segs = db.select().from(schema.topicSegments).all() as any[]
    expect(segs).toHaveLength(1)
    expect(segs[0].id).toBe('s-ok')
    const membership = db.select().from(schema.topicSegmentMessages).all() as any[]
    expect(membership).toHaveLength(1)
    expect(membership[0].messageId).toBe(targetId('t-1', 'm-1'))

    // Source stats count BOTH rows; candidate + manifest are reachable-only.
    expect(plane.getSourceReadStats().segmentRecordCount).toBe(2)
    plane.finalize()
    const manifest = plane.getSourceVerificationManifest()
    expect(manifest.segments.count).toBe(1)
    expect(manifest.segments.entries['s-ghost']).toBeUndefined()
    expect(manifest.memberships.rowCount).toBe(1)
    expect(plane.getCandidateImportStats().segmentCount).toBe(1)
    expect(plane.getCandidateImportStats().segmentMembershipCount).toBe(1)
  })

  it('rejects an absent-topic segment with any globally resolvable member (LOCK-SEG-1)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', [])])]))
    plane.processPage(page('message_blocks', [])) // contiguous order (LOCK-ORDER-1)
    expect(() => plane.processPage(page('topic_segments', [srcSegment('s-1', 't-ghost', ['m-1'])]))).toThrowError(
      /does not match any imported topic/
    )
    expect(db.select().from(schema.topicSegments).all()).toEqual([])
    expect(plane.getNormalizationStats().skippedSegmentRowCount).toBe(0)
  })

  it('does not leak segment skip counts from a rejected segment page (LOCK-STAT-1)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', [])])]))
    plane.processPage(page('message_blocks', [])) // contiguous order (LOCK-ORDER-1)
    plane.processPage(page('topic_segments', [srcSegment('s-skip', 't-ghost', ['m-dead'])]))
    expect(plane.getNormalizationStats().skippedSegmentRowCount).toBe(1)

    // Page mixes a valid skip candidate with a strict rejection → the whole
    // page rejects and leaks NO new skip counts.
    expect(() =>
      plane.processPage(
        page('topic_segments', [
          srcSegment('s-skip-2', 't-ghost-2', ['m-dead-2']),
          srcSegment('s-bad', 't-1', ['m-missing'])
        ])
      )
    ).toThrowError(/OWNERSHIP_MISMATCH/)
    expect(plane.getNormalizationStats().skippedSegmentRowCount).toBe(1)
    expect(plane.getNormalizationStats().skippedSegmentMembershipCount).toBe(1)
  })

  // -------------------------------------------------------------------------
  // LOCK-BLOCK-1X existing-owner unembedded skip
  // -------------------------------------------------------------------------

  it('skips an unembedded block claiming exactly one occurrence and counts it (LOCK-BLOCK-1X)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', [])])]))
    plane.processPage(
      page('message_blocks', [
        srcBlock('b-ghost', 'm-1', { type: 'file', file: { id: 'f-x', name: 'x.png' } }),
        srcBlock('b-orphan', 'm-dead') // classic unreachable orphan control
      ])
    )

    const stats = plane.getNormalizationStats()
    expect(stats.skippedExistingOwnerUnembeddedBlockCount).toBe(1)
    expect(stats.unreachableBlockSkipCount).toBe(1)
    // No target rows, no file references, no seen markers.
    expect(db.select().from(schema.messageBlocks).all()).toEqual([])
    expect(db.select().from(schema.fileReferences).all()).toEqual([])

    plane.finalize()
    const manifest = plane.getSourceVerificationManifest()
    expect(manifest.blocks.count).toBe(0)
    expect(manifest.blocks.entries['b-ghost']).toBeUndefined()
    expect(manifest.fileReferences.count).toBe(0)
    expect(plane.getCandidateImportStats().blockCount).toBe(0)
  })

  it('rejects an ambiguous unembedded claim — legacy id in multiple topics (LOCK-BLOCK-1X)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(
      page('topics', [
        srcTopic('t-1', [srcMessage('m-shared', 't-1', [])]),
        srcTopic('t-2', [srcMessage('m-shared', 't-2', [])])
      ])
    )
    // b-ghost claims m-shared which exists in TWO topics → ambiguous → strict
    // OWNERSHIP_MISMATCH, never skipped.
    expect(() => plane.processPage(page('message_blocks', [srcBlock('b-ghost', 'm-shared')]))).toThrowError(
      /OWNERSHIP_MISMATCH/
    )
    expect(plane.getNormalizationStats().skippedExistingOwnerUnembeddedBlockCount).toBe(0)
    expect(db.select().from(schema.messageBlocks).all()).toEqual([])
  })

  it('does not leak existing-owner skip counts from a rejected block page (LOCK-STAT-1)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', ['b-1'])])]))
    // Pre-seed b-1 under the owner TARGET id so the page passes validation
    // but hits a PRIMARY KEY violation inside the tx; the page also carries
    // an existing-owner skip candidate whose count must roll back.
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
      plane.processPage(page('message_blocks', [srcBlock('b-1', 'm-1'), srcBlock('b-ghost', 'm-1')]))
    ).toThrow()
    expect(plane.getNormalizationStats().skippedExistingOwnerUnembeddedBlockCount).toBe(0)
  })

  // -------------------------------------------------------------------------
  // LOCK-REF-1 mapped persistence
  // -------------------------------------------------------------------------

  it('persists block.messageId and segment memberships as target IDs; file refs keep source blockId (LOCK-REF-1)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(
      page('topics', [
        srcTopic('t-1', [srcMessage('m-1', 't-1', ['b-file']), srcMessage('m-2', 't-1', [])]),
        srcTopic('t-2', [srcMessage('m-1', 't-2', [])]) // reused legacy id control
      ])
    )
    plane.processPage(
      page('message_blocks', [srcBlock('b-file', 'm-1', { type: 'file', file: { id: 'f-1', name: 'a.pdf' } })])
    )
    plane.processPage(page('topic_segments', [srcSegment('s-1', 't-1', ['m-1', 'm-2'])]))

    // Block row: messageId is the owner's target (t-1, m-1) — never the
    // legacy claim, never t-2's occurrence target.
    const block = db.select().from(schema.messageBlocks).where(eq(schema.messageBlocks.id, 'b-file')).get() as any
    expect(block.messageId).toBe(targetId('t-1', 'm-1'))
    // File reference: blockId remains the source block id.
    const ref = db.select().from(schema.fileReferences).get() as any
    expect(ref.blockId).toBe('b-file')
    expect(ref.fileId).toBe('f-1')
    // Membership: target IDs by (segment.topicId, legacyMessageId).
    const membership = db
      .select()
      .from(schema.topicSegmentMessages)
      .where(eq(schema.topicSegmentMessages.segmentId, 's-1'))
      .orderBy(schema.topicSegmentMessages.sortOrder)
      .all() as any[]
    expect(membership.map((row) => row.messageId)).toEqual([targetId('t-1', 'm-1'), targetId('t-1', 'm-2')])
  })

  // -------------------------------------------------------------------------
  // Exact artifact closure shape (synthetic mirror)
  //
  // Mirrors the real artifact's residual facts in ONE plane session: zero
  // same-topic duplicate tuples, zero derived collisions, a handful of
  // unique/singleton dangling askIds, absent-topic segments whose members
  // are all absent, and one unembedded block claiming an existing unique
  // message — all handled by the approved boundaries with exact counts.
  // -------------------------------------------------------------------------

  it('handles the artifact-closure residual shape with exact committed counts', () => {
    const plane = createImportDataPlane(db)
    const messages: JsonObject[] = []
    const blocks: JsonObject[] = []
    let blockIndex = 0
    // 3 topics × 5 messages; every 5th message reuses a legacy id across
    // topics (cross-topic reuse → distinct occurrences, zero collisions).
    for (let t = 0; t < 3; t++) {
      const topicMessages: JsonObject[] = []
      for (let m = 0; m < 5; m++) {
        const legacyId = m === 4 ? 'shared-ask-user' : `m-${t}-${m}`
        topicMessages.push(srcMessage(legacyId, `t-${t}`, m === 1 ? [`b-${blockIndex++}`] : []))
      }
      messages.push(srcTopic(`t-${t}`, topicMessages))
    }
    // One embedded block per topic (referenced) + one unembedded block
    // claiming an existing UNIQUE message (LOCK-BLOCK-1X) + two unreachable
    // orphans claiming no message (LOCK-BLOCK-1).
    blocks.push(srcBlock('b-0', 'm-0-1'), srcBlock('b-1', 'm-1-1'), srcBlock('b-2', 'm-2-1'))
    blocks.push(srcBlock('b-unembedded', 'm-1-1'))
    blocks.push(srcBlock('b-orphan-a', 'm-dead-a'), srcBlock('b-orphan-b', 'm-dead-b'))

    plane.processPage(page('topics', messages))
    plane.processPage(page('message_blocks', blocks))
    // Absent-topic segments whose 4 members are ALL absent (LOCK-SEG-1 skip).
    plane.processPage(
      page('topic_segments', [
        srcSegment('s-ghost-1', 't-ghost-a', ['m-dead-a', 'm-dead-b']),
        srcSegment('s-ghost-2', 't-ghost-b', ['m-dead-c', 'm-dead-d'])
      ])
    )
    plane.finalize()

    // 15 occurrences mapped, all targets distinct, no legacy ids retained.
    const rows = db.select().from(schema.messages).all() as any[]
    expect(rows).toHaveLength(15)
    expect(new Set(rows.map((row) => row.id)).size).toBe(15)
    expect(rows.some((row) => row.id === 'shared-ask-user')).toBe(false)

    const stats = plane.getNormalizationStats()
    expect(stats).toEqual({
      topicIdNormalizationCount: 0,
      unreachableBlockSkipCount: 2,
      skippedExistingOwnerUnembeddedBlockCount: 1,
      danglingAskIdPreservedCount: 0,
      skippedSegmentRowCount: 2,
      skippedSegmentMembershipCount: 4
    })
    expect(plane.getCandidateImportStats().messageCount).toBe(15)
    expect(plane.getCandidateImportStats().blockCount).toBe(3)

    const manifest = plane.getSourceVerificationManifest()
    expect(manifest.blocks.count).toBe(3)
    expect(manifest.blocks.entries['b-unembedded']).toBeUndefined()
    expect(manifest.segments.count).toBe(0)
  })

  // -------------------------------------------------------------------------
  // LOCK-STAT-1 snapshots + no aliasing
  // -------------------------------------------------------------------------

  it('exposes every new statistic via getNormalizationStats without aliasing (LOCK-STAT-1)', () => {
    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', [], { askId: 'dangling-1' })])]))
    plane.processPage(page('message_blocks', [srcBlock('b-orphan', 'm-dead')]))
    plane.processPage(page('topic_segments', [srcSegment('s-1', 't-ghost', ['m-dead'])]))

    const snap = plane.getNormalizationStats()
    expect(snap).toEqual({
      topicIdNormalizationCount: 0,
      unreachableBlockSkipCount: 1,
      skippedExistingOwnerUnembeddedBlockCount: 0,
      danglingAskIdPreservedCount: 1,
      skippedSegmentRowCount: 1,
      skippedSegmentMembershipCount: 1
    })

    // No aliasing: mutating the snapshot never touches the plane.
    ;(snap as { danglingAskIdPreservedCount: number }).danglingAskIdPreservedCount = 999
    ;(snap as { skippedSegmentRowCount: number }).skippedSegmentRowCount = 999
    expect(plane.getNormalizationStats().danglingAskIdPreservedCount).toBe(1)
    expect(plane.getNormalizationStats().skippedSegmentRowCount).toBe(1)
  })
})
