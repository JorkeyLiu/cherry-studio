/**
 * attachmentMarkers tests (LOCK-UI-1..6) — real better-sqlite3, no mocks.
 *
 * Covers the pre-seal candidate-DB mutation that persists the import-only
 * per-block unavailable marker into every imported file/image block
 * referencing a reference-degraded file:
 * - LOCK-UI-4: shared degraded file across blocks marks ALL corresponding
 *   blocks; healthy blocks untouched; transactional rollback on a mid-run
 *   write failure rejects the whole mutation.
 * - LOCK-UI-3: display metadata, file_reference rows, block columns, and
 *   every other overflow key are preserved byte-for-byte.
 * - LOCK-UI-6: deterministic + idempotent (re-run is a no-op).
 * - LOCK-UI-2/5: degraded-but-unreferenced ids and healthy ids mark nothing;
 *   error messages never carry raw values/content/ids.
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
import { drizzle } from 'drizzle-orm/better-sqlite3'

import { L2_ATTACHMENT_UNAVAILABLE_MARKER } from '../../chatDb/attachmentAvailability'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { AttachmentMarkerError, markUnavailableAttachmentBlocks } from '../attachmentMarkers'
import { createImportDataPlane } from '../importDataPlane'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-markers-'))
}
function rmrf(dir: string): void {
  realFs.rmSync(dir, { recursive: true, force: true })
}
function page(tableName: string, items: JsonObject[], hasMore = false): ReadPageResponse {
  return { tableName, items, cursor: hasMore ? 'next' : null, hasMore }
}
function srcMessage(id: string, topicId: string, blocks: string[]): JsonObject {
  return {
    id,
    topicId,
    role: 'user',
    status: 'success',
    assistantId: 'asst-1',
    createdAt: '2020-01-01T00:00:00.000Z',
    blocks
  } as JsonObject
}
function srcTopic(id: string, messages: JsonObject[]): JsonObject {
  return { id, messages } as JsonObject
}

/** A source file/image block whose `file` overflow bag carries FileMetadata. */
function srcFileBlock(id: string, messageId: string, fileId: string, fileName: string, fileType: string): JsonObject {
  return {
    id,
    messageId,
    type: fileType === 'image' ? 'image' : 'file',
    content: null,
    status: 'success',
    createdAt: '2020-01-01T00:00:01.000Z',
    file: { id: fileId, name: fileName, path: `/abs/${fileName}`, type: fileType }
  } as JsonObject
}

/**
 * Build a candidate with three blocks via the REAL data plane (so
 * file_references derive exactly like production): b-1 + b-2 reference the
 * SAME degraded file, b-3 references a healthy file.
 */
function buildCandidate(dir: string): Database.Database {
  const dbPath = realPath.join(dir, 'chat.db')
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  runMigrations(db, sqlite)

  const plane = createImportDataPlane(db)
  plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', ['b-1', 'b-2', 'b-3'])])]))
  plane.processPage(
    page('message_blocks', [
      srcFileBlock('b-1', 'm-1', 'file-degraded-1', 'photo.png', 'image'),
      srcFileBlock('b-2', 'm-1', 'file-degraded-1', 'photo.png', 'image'),
      srcFileBlock('b-3', 'm-1', 'file-healthy', 'doc.pdf', 'file')
    ])
  )
  plane.finalize()
  return sqlite
}

/** Number of referenced degraded ids in the F-1 wide fixture (500/500/1). */
const WIDE_DEGRADED_COUNT = 1001

/**
 * F-1 wide fixture: 1001 file blocks (`b-deg-0000` … `b-deg-1000`), each
 * referencing a DISTINCT degraded file id (`file-degraded-0000` …
 * `file-degraded-1000`), built via the REAL data plane. Five selected ids
 * (0/250/500/750/1000) also get a SECOND block (`b-extra-…`) so the "same
 * degraded id marks ALL its blocks" path is exercised across batches. When
 * `corruptBlockId` is given, that block's `extra` is replaced with malformed
 * JSON to inject a late-batch failure (F-1 full-rollback proof).
 */
function buildWideCandidate(dir: string, corruptBlockId?: string): Database.Database {
  const dbPath = realPath.join(dir, 'chat.db')
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  runMigrations(db, sqlite)

  const selected = new Set([0, 250, 500, 750, 1000])
  const blockIds = Array.from({ length: WIDE_DEGRADED_COUNT }, (_, i) => `b-deg-${String(i).padStart(4, '0')}`)
  const extraBlockIds = [...selected].map((i) => `b-extra-${String(i).padStart(4, '0')}`)
  const allBlockIds = [...blockIds, ...extraBlockIds]

  const plane = createImportDataPlane(db)
  plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', allBlockIds)])]))
  const fileBlocks = blockIds.map((bid, i) =>
    srcFileBlock(bid, 'm-1', `file-degraded-${String(i).padStart(4, '0')}`, `f-${i}.png`, 'image')
  )
  const extraBlocks = [...selected].map((i) =>
    srcFileBlock(
      `b-extra-${String(i).padStart(4, '0')}`,
      'm-1',
      `file-degraded-${String(i).padStart(4, '0')}`,
      `f-${i}.png`,
      'image'
    )
  )
  plane.processPage(page('message_blocks', [...fileBlocks, ...extraBlocks]))
  plane.finalize()

  if (corruptBlockId !== undefined) {
    sqlite.prepare(`UPDATE message_blocks SET extra = 'not-json{{{' WHERE id = ?`).run(corruptBlockId)
  }
  return sqlite
}

/**
 * F-1 input set: all 1001 referenced degraded ids plus three UNREFERENCED
 * ids and three DUPLICATES of referenced ids. The aggregate degraded count
 * must be UNIQUE safe ids (1004), with duplicates de-duplicated
 * deterministically; the unreferenced ids mark nothing.
 */
function wideDegradedInput(): string[] {
  const ids = Array.from({ length: WIDE_DEGRADED_COUNT }, (_, i) => `file-degraded-${String(i).padStart(4, '0')}`)
  return [
    ...ids,
    'file-unreferenced-a',
    'file-unreferenced-b',
    'file-unreferenced-c',
    // Duplicates — must be counted once (deterministic first-seen de-dup).
    'file-degraded-0000',
    'file-degraded-0500',
    'file-degraded-1000'
  ]
}

/** Read the raw `extra` JSON of a block, or null when absent. */
function blockOverflow(sqlite: Database.Database, blockId: string): Record<string, unknown> {
  const row = sqlite.prepare('SELECT extra FROM message_blocks WHERE id = ?').get(blockId) as
    | { extra: string | null }
    | undefined
  if (row === undefined || row.extra === null || row.extra === '' || row.extra === '{}') return {}
  return JSON.parse(row.extra) as Record<string, unknown>
}

describe('markUnavailableAttachmentBlocks (LOCK-UI-1..6)', () => {
  let tempDir: string
  let sqlite: Database.Database

  beforeEach(() => {
    tempDir = makeTempDir()
    sqlite = buildCandidate(tempDir)
  })

  afterEach(() => {
    sqlite.close()
    rmrf(tempDir)
    expect(realFs.existsSync(tempDir)).toBe(false)
  })

  it('marks every block referencing a shared degraded file, preserving display metadata (LOCK-UI-3/4)', () => {
    const result = markUnavailableAttachmentBlocks(sqlite, ['file-degraded-1'])

    expect(result).toEqual({ markedBlockCount: 2, degradedFileIdCount: 1 })

    const overflowB1 = blockOverflow(sqlite, 'b-1')
    const overflowB2 = blockOverflow(sqlite, 'b-2')
    // Marker present on BOTH blocks referencing the shared degraded file.
    expect(overflowB1[L2_ATTACHMENT_UNAVAILABLE_MARKER]).toBe(true)
    expect(overflowB2[L2_ATTACHMENT_UNAVAILABLE_MARKER]).toBe(true)
    // LOCK-UI-3: the original `file` display metadata is preserved verbatim.
    expect(overflowB1.file).toEqual({
      id: 'file-degraded-1',
      name: 'photo.png',
      path: '/abs/photo.png',
      type: 'image'
    })
  })

  it('leaves healthy blocks, their columns, and file_reference rows untouched (LOCK-UI-2/3)', () => {
    markUnavailableAttachmentBlocks(sqlite, ['file-degraded-1'])

    // Healthy block: no marker, original overflow intact.
    const overflowB3 = blockOverflow(sqlite, 'b-3')
    expect(overflowB3[L2_ATTACHMENT_UNAVAILABLE_MARKER]).toBeUndefined()
    expect(overflowB3.file).toEqual({ id: 'file-healthy', name: 'doc.pdf', path: '/abs/doc.pdf', type: 'file' })

    // Block columns are byte-identical.
    const beforeColumns = sqlite.prepare('SELECT * FROM message_blocks ORDER BY id').all()
    markUnavailableAttachmentBlocks(sqlite, ['file-degraded-1'])
    const afterColumns = sqlite.prepare('SELECT * FROM message_blocks ORDER BY id').all()
    expect(afterColumns).toEqual(beforeColumns)

    // file_references rows (id, block_id, file_id, file_name, file_path,
    // file_type, count, extra) are preserved exactly.
    const refs = sqlite
      .prepare(
        'SELECT id, block_id, file_id, file_name, file_path, file_type, count, extra FROM file_references ORDER BY id'
      )
      .all()
    expect(refs).toHaveLength(3)
    expect(refs.filter((r: any) => r.file_id === 'file-degraded-1')).toHaveLength(2)
    expect(refs.filter((r: any) => r.file_id === 'file-healthy')).toHaveLength(1)
    for (const ref of refs as Array<Record<string, unknown>>) {
      expect(ref.extra).toBeNull()
    }
  })

  it('is deterministic and idempotent — a re-run marks nothing and changes nothing (LOCK-UI-6)', () => {
    const first = markUnavailableAttachmentBlocks(sqlite, ['file-degraded-1'])
    expect(first.markedBlockCount).toBe(2)

    const before = sqlite.prepare('SELECT extra FROM message_blocks ORDER BY id').all()
    const second = markUnavailableAttachmentBlocks(sqlite, ['file-degraded-1'])
    expect(second.markedBlockCount).toBe(0)
    const after = sqlite.prepare('SELECT extra FROM message_blocks ORDER BY id').all()
    expect(after).toEqual(before)
  })

  it('marks nothing for an empty degraded set or ids with no file_reference row (LOCK-UI-2/5)', () => {
    expect(markUnavailableAttachmentBlocks(sqlite, [])).toEqual({ markedBlockCount: 0, degradedFileIdCount: 0 })

    // Degraded id that no committed block references → no blocks marked. The
    // non-string id is filtered out as unsafe and is NOT counted — the
    // aggregate reports only the ids actually processed (LOCK-UI-5).
    const result = markUnavailableAttachmentBlocks(sqlite, ['file-unreferenced', 42 as unknown as string])
    expect(result).toEqual({ markedBlockCount: 0, degradedFileIdCount: 1 })
    expect(blockOverflow(sqlite, 'b-1')[L2_ATTACHMENT_UNAVAILABLE_MARKER]).toBeUndefined()
  })

  it('rolls back the whole transaction when a later block cannot be marked (LOCK-UI-4 fail closed)', () => {
    // Sabotage one block referencing a SECOND degraded id with malformed
    // extra. The first block (b-1) references the first degraded id — after
    // the throw, b-1 must be UNCHANGED (transactional rollback).
    sqlite.prepare(`UPDATE message_blocks SET extra = 'not-json{{{' WHERE id = 'b-3'`).run()
    // b-3 references file-healthy — make it ALSO reference the degraded id
    // so it is inside the marked set.
    sqlite.prepare(`UPDATE file_references SET file_id = 'file-degraded-2' WHERE block_id = 'b-3'`).run()

    let thrown: unknown = null
    try {
      markUnavailableAttachmentBlocks(sqlite, ['file-degraded-1', 'file-degraded-2'])
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AttachmentMarkerError)
    // LOCK-UI-3: the failure message never carries the malformed raw value
    // (which embeds user content) — and the raw 'not-json{{{' never appears.
    expect(String((thrown as Error).message)).not.toContain('not-json')
    // LOCK-UI-4: nothing persisted — b-1 was NOT marked despite being
    // processed before the malformed row (rollback is all-or-nothing).
    expect(blockOverflow(sqlite, 'b-1')[L2_ATTACHMENT_UNAVAILABLE_MARKER]).toBeUndefined()
  })
})

describe('markUnavailableAttachmentBlocks — >500-id batch regression (F-1)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
  })

  afterEach(() => {
    rmrf(tempDir)
    expect(realFs.existsSync(tempDir)).toBe(false)
  })

  it('marks 1006 blocks from 1004 unique ids across 500/500/1 batches, idempotently (F-1)', () => {
    const wide = buildWideCandidate(tempDir)
    try {
      // 1001 referenced ids + 3 unreferenced ids + 3 duplicates + one unsafe
      // non-string. The aggregate degraded count is UNIQUE safe ids = 1004
      // (duplicates de-duplicated; the non-string is filtered, never counted).
      const input = [...wideDegradedInput(), 42 as unknown as string]
      const result = markUnavailableAttachmentBlocks(wide, input)

      // Marked blocks: 1001 single blocks + 5 second blocks for the selected
      // ids = 1006. The 1001 referenced ids cross the batch boundary exactly
      // as 500/500/1; the 3 unreferenced ids ride in the trailing batch.
      expect(result).toEqual({ markedBlockCount: 1006, degradedFileIdCount: 1004 })

      // Batch-boundary spot checks: first id (batch 1), the 500th id (batch
      // 1 → 2 edge), the 501st id (batch 2), and the 1001st id (single-id
      // third batch) are all marked.
      expect(blockOverflow(wide, 'b-deg-0000')[L2_ATTACHMENT_UNAVAILABLE_MARKER]).toBe(true)
      expect(blockOverflow(wide, 'b-deg-0499')[L2_ATTACHMENT_UNAVAILABLE_MARKER]).toBe(true)
      expect(blockOverflow(wide, 'b-deg-0500')[L2_ATTACHMENT_UNAVAILABLE_MARKER]).toBe(true)
      expect(blockOverflow(wide, 'b-deg-1000')[L2_ATTACHMENT_UNAVAILABLE_MARKER]).toBe(true)

      // LOCK-UI-4 at scale: the same degraded id (b-deg-0500 + b-extra-0500)
      // marks ALL of its blocks.
      expect(blockOverflow(wide, 'b-extra-0500')[L2_ATTACHMENT_UNAVAILABLE_MARKER]).toBe(true)

      // Every block in the wide candidate now carries the marker.
      const marked = wide
        .prepare(`SELECT COUNT(*) AS c FROM message_blocks WHERE extra LIKE '%${L2_ATTACHMENT_UNAVAILABLE_MARKER}%'`)
        .get() as { c: number }
      expect(marked.c).toBe(1006)

      // LOCK-UI-6 idempotence across the SAME >500-id input: re-run marks
      // nothing and still reports the unique processed-id count.
      const second = markUnavailableAttachmentBlocks(wide, input)
      expect(second).toEqual({ markedBlockCount: 0, degradedFileIdCount: 1004 })
    } finally {
      wide.close()
    }
  })

  it('rolls back EVERY batch when the single-id third batch fails (F-1)', () => {
    // b-deg-1000 is the only block of the single-id third batch and its
    // `extra` is malformed — batches 1 and 2 already wrote markers, but the
    // throw must roll the WHOLE transaction back (LOCK-UI-4 across batches).
    const wide = buildWideCandidate(tempDir, 'b-deg-1000')
    try {
      const ids = Array.from({ length: WIDE_DEGRADED_COUNT }, (_, i) => `file-degraded-${String(i).padStart(4, '0')}`)

      let thrown: unknown = null
      try {
        markUnavailableAttachmentBlocks(wide, ids)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(AttachmentMarkerError)
      // LOCK-UI-3: the failure message never carries the raw malformed value.
      expect(String((thrown as Error).message)).not.toContain('not-json')

      // LOCK-UI-4 across batch boundaries: nothing written by batch 1 or
      // batch 2 survived the third-batch throw.
      expect(blockOverflow(wide, 'b-deg-0000')[L2_ATTACHMENT_UNAVAILABLE_MARKER]).toBeUndefined()
      expect(blockOverflow(wide, 'b-deg-0499')[L2_ATTACHMENT_UNAVAILABLE_MARKER]).toBeUndefined()
      expect(blockOverflow(wide, 'b-deg-0500')[L2_ATTACHMENT_UNAVAILABLE_MARKER]).toBeUndefined()
      expect(blockOverflow(wide, 'b-extra-0500')[L2_ATTACHMENT_UNAVAILABLE_MARKER]).toBeUndefined()

      // Whole-candidate proof: NO block carries the marker key — the only
      // non-empty `extra` in the candidate is the pre-existing corrupted
      // block (which holds malformed JSON, not the marker).
      const marked = wide
        .prepare(`SELECT COUNT(*) AS c FROM message_blocks WHERE extra LIKE '%${L2_ATTACHMENT_UNAVAILABLE_MARKER}%'`)
        .get() as { c: number }
      expect(marked.c).toBe(0)
    } finally {
      wide.close()
    }
  })
})
