/**
 * CandidateVerifier tests — real better-sqlite3, no mocks (Phase 4.3.2).
 *
 * Round trip: a candidate built by the Phase 4.2 ChatImportDataPlane with
 * its finalized manifest is verified after sealing (connection closed).
 *
 * Covers:
 * - Pristine candidate passes all 14 dimensions (LOCK-4304).
 * - Corruption matrix: missing/extra ID, count, field/overflow/structured
 *   JSON mutation, message order, owner relation, membership, file ref,
 *   FK violation, integrity/open/query failure, sample-read failure.
 * - Abort determinism at checkpoint boundaries + close() cancellation
 *   (LOCK-4303); handle closure/deletability on every outcome.
 * - Diagnostic cap with truncation metadata; no dbPath/raw content in the
 *   serialized report (LOCK-4304).
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
import { normalizeSearchText } from '@shared/searchTextNormalization'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import {
  MESSAGE_BLOCKS_FTS_TABLE,
  MESSAGE_BLOCKS_NORMALIZED_INSERT_TRIGGER,
  MESSAGE_BLOCKS_NORMALIZED_TABLE,
  registerChatDbNormalize,
  runMigrations
} from '../../../chatDb/migration'
import * as schema from '../../../chatDb/schema'
import { wireToMessage } from '../../../chatDb/wireAdapters'
import { CandidateFtsProjection } from '../../ftsProjection'
import { computeMessageTargetId } from '../../identity/messageIdentity'
import { createImportDataPlane } from '../../importDataPlane'
import type { CandidateVerifierOptions } from '../candidateVerifier'
import { createCandidateVerifier, MAX_SEARCH_PROJECTION_CHUNK_SIZE, normalizeChunkSize } from '../candidateVerifier'
import { canonicalDigest } from '../canonicalJson'
import type { SourceVerificationManifest } from '../sourceManifest'
import type { CandidateVerificationReport, VerificationDimension } from '../verificationContracts'
import { VERIFICATION_DIMENSIONS } from '../verificationContracts'

/** Deterministic L2 target ID for the source tuple (LOCK-MID-1/2). */
function targetId(outerTopicId: string, legacyMessageId: string): string {
  return computeMessageTargetId(outerTopicId, legacyMessageId)
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-verifier-'))
}

function page(tableName: string, items: JsonObject[], hasMore = false): ReadPageResponse {
  return { tableName, items, cursor: hasMore ? 'next' : null, hasMore }
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

function srcSegment(id: string, topicId: string, messageIds: string[]): JsonObject {
  return {
    id,
    topicId,
    name: `Segment ${id}`,
    messageIds,
    createdAt: '2020-01-02T00:00:00.000Z',
    updatedAt: '2020-01-02T00:00:00.000Z',
    color: '#ff0000'
  } as JsonObject
}

const STRUCTURED_MODEL = { id: 'gpt-4o', provider: 'openai', name: 'GPT-4o', group: 'gpt' }
const TOOL_CONTENT = { toolName: 'search', result: { hits: 3, items: ['a', 'b', 'c'] } }
const FILE_META = { id: 'file-1', name: 'doc.pdf', path: '/files/doc.pdf', type: 'file' }

/**
 * Build a sealed candidate + finalized manifest via the Phase 4.2 data
 * plane. The candidate connection is closed before the verifier starts.
 */
function buildSealedCandidate(dir: string): { dbPath: string; manifest: SourceVerificationManifest } {
  const dbPath = realPath.join(dir, 'chat.db')
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  runMigrations(db, sqlite)

  const plane = createImportDataPlane(db)
  plane.processPage(
    page(
      'topics',
      [
        srcTopic(
          't-1',
          [
            srcMessage('m-1', 't-1', ['b-1', 'b-2'], { model: STRUCTURED_MODEL, traceId: null }),
            srcMessage('m-2', 't-1', ['b-3'])
          ],
          { deletedAt: '2021-06-01T00:00:00.000Z' }
        ),
        srcTopic('t-2', [srcMessage('m-3', 't-2', ['b-4', 'b-5'])])
      ],
      true
    )
  )
  plane.processPage(page('topics', [srcTopic('t-3', [srcMessage('m-4', 't-3', [])])]))
  plane.processPage(
    page('message_blocks', [
      srcBlock('b-1', 'm-1'),
      srcBlock('b-2', 'm-1', { type: 'tool', content: TOOL_CONTENT as unknown as JsonObject['x'] }),
      srcBlock('b-3', 'm-2', { type: 'file', file: FILE_META as unknown as JsonObject['x'] }),
      srcBlock('b-4', 'm-3', { citations: [{ url: 'u' }] as unknown as JsonObject['x'] }),
      srcBlock('b-5', 'm-3')
    ])
  )
  plane.processPage(
    page('topic_segments', [srcSegment('s-1', 't-1', ['m-2', 'm-1']), srcSegment('s-2', 't-2', ['m-3'])])
  )
  plane.processPage(page('files', [{ id: 'file-1' } as JsonObject]))
  plane.finalize()

  const manifest = plane.getSourceVerificationManifest()
  sqlite.close() // sealed — verifier reopens readonly
  return { dbPath, manifest }
}

/** Open a writable connection with FKs off, register scalar functions, corrupt, close. */
function corrupt(dbPath: string, fn: (db: Database.Database) => void): void {
  const db = new Database(dbPath)
  db.pragma('foreign_keys = OFF')
  // LOCK-5126: any writable connection that may mutate message_blocks
  // must have chatdb_normalize() registered before triggers can fire.
  registerChatDbNormalize(db)
  fn(db)
  db.close()
}

/**
 * Overwrite the root b-tree page of one named index with a structurally
 * VALID but EMPTY leaf-index page. Deterministic silent index truncation:
 * readers of that index see zero rows (no throw), and PRAGMA
 * integrity_check reliably REPORTS the rows missing from the index instead
 * of raising SQLITE_CORRUPT.
 */
function corruptIndexToEmptyPage(dbPath: string, indexName: string): void {
  const db = new Database(dbPath, { readonly: true })
  const pageSize = db.pragma('page_size', { simple: true }) as number
  const row = db.prepare(`SELECT rootpage FROM sqlite_master WHERE type = 'index' AND name = ?`).get(indexName) as
    | { rootpage: number }
    | undefined
  db.close()
  expect(row).toBeDefined()
  const page = Buffer.alloc(pageSize, 0)
  page[0] = 0x0a // leaf index b-tree page
  page.writeUInt16BE(0, 1) // no freeblocks
  page.writeUInt16BE(0, 3) // zero cells
  page.writeUInt16BE(pageSize & 0xffff, 5) // cell content area starts at page end
  const fd = realFs.openSync(dbPath, 'r+')
  realFs.writeSync(fd, page, 0, pageSize, (row!.rootpage - 1) * pageSize)
  realFs.closeSync(fd)
}

async function verify(
  dbPath: string,
  manifest: SourceVerificationManifest,
  extra?: Partial<CandidateVerifierOptions>
): Promise<CandidateVerificationReport> {
  const verifier = createCandidateVerifier({ dbPath, manifest, ...extra })
  const report = await verifier.run()
  expect(verifier.getState()).toBe('done')
  return report
}

function dim(report: CandidateVerificationReport, id: VerificationDimension) {
  const result = report.dimensions.find((d) => d.dimension === id)
  expect(result).toBeDefined()
  return result!
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CandidateVerifier', () => {
  let tempDir: string
  let dbPath: string
  let manifest: SourceVerificationManifest

  beforeEach(() => {
    tempDir = makeTempDir()
    const sealed = buildSealedCandidate(tempDir)
    dbPath = sealed.dbPath
    manifest = sealed.manifest
  })

  afterEach(() => {
    // Deletability on every outcome: the readonly handle must be closed.
    realFs.rmSync(tempDir, { recursive: true, force: true })
    expect(realFs.existsSync(tempDir)).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it('passes all 14 dimensions for a pristine sealed candidate', async () => {
    const report = await verify(dbPath, manifest)

    expect(report.status).toBe('pass')
    expect(report.fatal).toBeNull()
    expect(report.dimensions.map((d) => d.dimension)).toEqual([...VERIFICATION_DIMENSIONS])
    expect(report.dimensions).toHaveLength(14)
    for (const result of report.dimensions) {
      expect(result.status).toBe('pass')
      expect(result.diagnostics).toEqual([])
      expect(result.truncatedDiagnosticCount).toBe(0)
    }
    // Every entity table was actually compared (3+4+5+1+2 target rows).
    expect(dim(report, 'id_sets').checkedCount).toBe(3 + 4 + 5 + 1 + 2)
    expect(dim(report, 'table_counts').checkedCount).toBe(6)
    expect(dim(report, 'structured_json').checkedCount).toBe(4 + 5)
    expect(dim(report, 'sample_reads').checkedCount).toBeGreaterThan(0)
    // LOCK-SP-2/3/4: the derived search projection was fully scanned on the
    // pristine (trigger-maintained) candidate: 6 objects + 2 count pairs +
    // 3 canonical rows × 2 (message_id + content) + 3 FTS rows + 1 FTS
    // fingerprint compare + 1 MATCH smoke.
    expect(dim(report, 'search_projection').checkedCount).toBe(6 + 2 + 3 * 2 + 3 + 1 + 1)
    // Candidate file untouched and deletable (handle closed).
    expect(realFs.existsSync(dbPath)).toBe(true)
  })

  it('produces a frozen report without exposing the dbPath', async () => {
    const report = await verify(dbPath, manifest)
    expect(Object.isFrozen(report)).toBe(true)
    expect(JSON.stringify(report)).not.toContain(tempDir)
    expect(JSON.stringify(report)).not.toContain('chat.db')
  })

  // -------------------------------------------------------------------------
  // L2 imported-trash retention marker evidence (LOCK-TRASH-3/4/5)
  // -------------------------------------------------------------------------

  it('marker-bearing candidate passes all 14 dimensions with the marker in manifest + record digests', async () => {
    const baseline = '2026-08-04T00:00:00.000Z'
    const markerDbPath = realPath.join(tempDir, 'marker-chat.db')
    const markerSqlite = new Database(markerDbPath)
    markerSqlite.pragma('journal_mode = WAL')
    markerSqlite.pragma('foreign_keys = ON')
    const markerDb = drizzle(markerSqlite, { schema })
    runMigrations(markerDb, markerSqlite)

    const plane = createImportDataPlane(markerDb, { l2TrashRetentionBaseline: baseline })
    plane.processPage(
      page('topics', [
        srcTopic('t-del', [srcMessage('m-1', 't-del', [])], { deletedAt: '2020-01-01T00:00:00.000Z' }),
        srcTopic('t-active', [srcMessage('m-2', 't-active', [])])
      ])
    )
    plane.finalize()
    const markerManifest = plane.getSourceVerificationManifest()
    markerSqlite.close()

    // LOCK-TRASH-3/5: the manifest overflow digest for the soft-deleted
    // topic is the digest of the marker-bearing overflow object; the active
    // topic carries an empty overflow.
    expect(markerManifest.topics.entries['t-del'].overflowDigest).toBe(
      canonicalDigest({ l2TrashRetentionStartedAt: baseline })
    )
    expect(markerManifest.topics.entries['t-active'].overflowDigest).toBe(canonicalDigest({}))

    const report = await verify(markerDbPath, markerManifest)
    expect(report.status).toBe('pass')
    for (const result of report.dimensions) {
      expect(result.status).toBe('pass')
    }
  })

  it('fails the overflow dimension when the importer marker is mutated in the candidate DB', async () => {
    const baseline = '2026-08-04T00:00:00.000Z'
    const markerDbPath = realPath.join(tempDir, 'marker-mutated-chat.db')
    const markerSqlite = new Database(markerDbPath)
    markerSqlite.pragma('journal_mode = WAL')
    markerSqlite.pragma('foreign_keys = ON')
    const markerDb = drizzle(markerSqlite, { schema })
    runMigrations(markerDb, markerSqlite)

    const plane = createImportDataPlane(markerDb, { l2TrashRetentionBaseline: baseline })
    plane.processPage(
      page('topics', [srcTopic('t-del', [srcMessage('m-1', 't-del', [])], { deletedAt: '2020-01-01T00:00:00.000Z' })])
    )
    plane.finalize()
    const markerManifest = plane.getSourceVerificationManifest()
    markerSqlite.close()

    // Tamper with the marker in the target extra column.
    corrupt(markerDbPath, (db) =>
      db
        .prepare(`UPDATE topics SET extra = ? WHERE id = 't-del'`)
        .run(JSON.stringify({ l2TrashRetentionStartedAt: '2099-01-01T00:00:00.000Z' }))
    )

    const report = await verify(markerDbPath, markerManifest)
    expect(report.status).toBe('fail')
    const overflow = dim(report, 'overflow')
    expect(overflow.status).toBe('fail')
    expect(overflow.diagnostics.some((d) => d.entityId === 't-del' && d.code === 'OVERFLOW_DIGEST_MISMATCH')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Corruption matrix — each injected corruption fails its intended dimension
  // -------------------------------------------------------------------------

  it('fails id_sets + table_counts on a missing row', async () => {
    corrupt(dbPath, (db) => db.prepare(`DELETE FROM messages WHERE id = ?`).run(targetId('t-3', 'm-4')))
    const report = await verify(dbPath, manifest)

    expect(report.status).toBe('fail')
    const ids = dim(report, 'id_sets')
    expect(ids.status).toBe('fail')
    expect(ids.diagnostics.some((d) => d.code === 'MISSING_ENTITY' && d.entityId === targetId('t-3', 'm-4'))).toBe(true)
    expect(dim(report, 'table_counts').status).toBe('fail')
  })

  it('fails id_sets + table_counts on an extra row', async () => {
    corrupt(dbPath, (db) => db.prepare(`INSERT INTO topics (id) VALUES ('t-extra')`).run())
    const report = await verify(dbPath, manifest)

    const ids = dim(report, 'id_sets')
    expect(ids.status).toBe('fail')
    expect(ids.diagnostics.some((d) => d.code === 'UNEXPECTED_ENTITY' && d.entityId === 't-extra')).toBe(true)
    expect(dim(report, 'table_counts').status).toBe('fail')
  })

  it('fails field_digests on a column mutation without touching structured/overflow', async () => {
    corrupt(dbPath, (db) =>
      db.prepare(`UPDATE messages SET role = 'assistant' WHERE id = ?`).run(targetId('t-1', 'm-2'))
    )
    const report = await verify(dbPath, manifest)

    const digests = dim(report, 'field_digests')
    expect(digests.status).toBe('fail')
    expect(
      digests.diagnostics.some((d) => d.entityId === targetId('t-1', 'm-2') && d.code === 'FIELD_DIGEST_MISMATCH')
    ).toBe(true)
    expect(dim(report, 'overflow').status).toBe('pass')
    expect(dim(report, 'structured_json').status).toBe('pass')
    expect(dim(report, 'order').status).toBe('pass')
  })

  it('fails overflow independently on an overflow-only mutation', async () => {
    corrupt(dbPath, (db) => db.prepare(`UPDATE topics SET extra = '{"pinned":true}' WHERE id = 't-2'`).run())
    const report = await verify(dbPath, manifest)

    const overflow = dim(report, 'overflow')
    expect(overflow.status).toBe('fail')
    expect(overflow.diagnostics.some((d) => d.entityId === 't-2' && d.code === 'OVERFLOW_DIGEST_MISMATCH')).toBe(true)
    expect(dim(report, 'structured_json').status).toBe('pass')
  })

  it('fails structured_json on a structured model mutation', async () => {
    corrupt(dbPath, (db) => {
      const row = db.prepare(`SELECT extra FROM messages WHERE id = ?`).get(targetId('t-1', 'm-1')) as { extra: string }
      const extra = JSON.parse(row.extra)
      extra.model = { ...extra.model, id: 'tampered-model' }
      db.prepare(`UPDATE messages SET extra = ? WHERE id = ?`).run(JSON.stringify(extra), targetId('t-1', 'm-1'))
    })
    const report = await verify(dbPath, manifest)

    const structured = dim(report, 'structured_json')
    expect(structured.status).toBe('fail')
    expect(
      structured.diagnostics.some(
        (d) =>
          d.entityId === targetId('t-1', 'm-1') &&
          d.fieldPath === 'overflow.model' &&
          d.code === 'STRUCTURED_JSON_MISMATCH'
      )
    ).toBe(true)
  })

  it('fails structured_json on a structured tool-content mutation', async () => {
    corrupt(dbPath, (db) => {
      const row = db.prepare(`SELECT extra FROM message_blocks WHERE id = 'b-2'`).get() as { extra: string }
      const extra = JSON.parse(row.extra)
      extra.content = { ...extra.content, result: { hits: 999 } }
      db.prepare(`UPDATE message_blocks SET extra = ? WHERE id = 'b-2'`).run(JSON.stringify(extra))
    })
    const report = await verify(dbPath, manifest)

    const structured = dim(report, 'structured_json')
    expect(structured.status).toBe('fail')
    expect(
      structured.diagnostics.some(
        (d) => d.entityId === 'b-2' && d.fieldPath === 'overflow.content' && d.code === 'STRUCTURED_JSON_MISMATCH'
      )
    ).toBe(true)
  })

  it('fails order on a message sort_order swap', async () => {
    corrupt(dbPath, (db) => {
      db.prepare(`UPDATE messages SET sort_order = 1 WHERE id = ?`).run(targetId('t-1', 'm-1'))
      db.prepare(`UPDATE messages SET sort_order = 0 WHERE id = ?`).run(targetId('t-1', 'm-2'))
    })
    const report = await verify(dbPath, manifest)

    const order = dim(report, 'order')
    expect(order.status).toBe('fail')
    expect(order.diagnostics.filter((d) => d.code === 'ORDER_MISMATCH')).toHaveLength(2)
    // Sample reads see the reordered application read too.
    expect(dim(report, 'sample_reads').status).toBe('fail')
  })

  it('fails order on a sibling block sort_order swap', async () => {
    // 4.3.3 audit gap: block sort_order corruption must fail the order
    // dimension for message_blocks (parent-index order is LOCK-D5 evidence).
    corrupt(dbPath, (db) => {
      db.prepare(`UPDATE message_blocks SET sort_order = 1 WHERE id = 'b-1'`).run()
      db.prepare(`UPDATE message_blocks SET sort_order = 0 WHERE id = 'b-2'`).run()
    })
    const report = await verify(dbPath, manifest)

    const order = dim(report, 'order')
    expect(order.status).toBe('fail')
    const blockOrderDiags = order.diagnostics.filter(
      (d) => d.entity === 'message_blocks' && d.code === 'ORDER_MISMATCH' && d.fieldPath === 'sortOrder'
    )
    expect(blockOrderDiags.map((d) => d.entityId).sort()).toEqual(['b-1', 'b-2'])
    expect(blockOrderDiags.find((d) => d.entityId === 'b-1')).toMatchObject({ expected: 0, actual: 1 })
    // The application read path sees the reordered sibling blocks too.
    expect(dim(report, 'sample_reads').status).toBe('fail')
    // Ownership/membership evidence is untouched by a pure order swap.
    expect(dim(report, 'relations').status).toBe('pass')
    expect(dim(report, 'segments').status).toBe('pass')
  })

  it('fails relations on an owner reassignment', async () => {
    corrupt(dbPath, (db) =>
      db.prepare(`UPDATE message_blocks SET message_id = ? WHERE id = 'b-1'`).run(targetId('t-1', 'm-2'))
    )
    const report = await verify(dbPath, manifest)

    const relations = dim(report, 'relations')
    expect(relations.status).toBe('fail')
    expect(
      relations.diagnostics.some(
        (d) => d.entityId === 'b-1' && d.fieldPath === 'messageId' && d.code === 'RELATION_MISMATCH'
      )
    ).toBe(true)
    // The referenced message exists, so PRAGMA-level FK stays clean.
    expect(dim(report, 'foreign_key_check').status).toBe('pass')
  })

  it('fails segments on membership order corruption', async () => {
    corrupt(dbPath, (db) => {
      db.prepare(`UPDATE topic_segment_messages SET sort_order = 2 WHERE segment_id = 's-1' AND message_id = ?`).run(
        targetId('t-1', 'm-2')
      )
    })
    const report = await verify(dbPath, manifest)

    const segments = dim(report, 'segments')
    expect(segments.status).toBe('fail')
    expect(segments.diagnostics.some((d) => d.entityId === 's-1' && d.code === 'MEMBERSHIP_MISMATCH')).toBe(true)
  })

  it('fails file_references on a snapshot mutation', async () => {
    corrupt(dbPath, (db) => db.prepare(`UPDATE file_references SET file_id = 'evil' WHERE block_id = 'b-3'`).run())
    const report = await verify(dbPath, manifest)

    const refs = dim(report, 'file_references')
    expect(refs.status).toBe('fail')
    expect(refs.diagnostics.some((d) => d.code === 'FIELD_DIGEST_MISMATCH')).toBe(true)
  })

  it('fails fk_references and foreign_key_check on a dangling FK', async () => {
    corrupt(dbPath, (db) =>
      db.prepare(`UPDATE messages SET topic_id = 'ghost' WHERE id = ?`).run(targetId('t-2', 'm-3'))
    )
    const report = await verify(dbPath, manifest)

    const fk = dim(report, 'fk_references')
    expect(fk.status).toBe('fail')
    expect(fk.diagnostics.some((d) => d.entityId === targetId('t-2', 'm-3') && d.code === 'FK_REFERENCE_BROKEN')).toBe(
      true
    )
    const pragma = dim(report, 'foreign_key_check')
    expect(pragma.status).toBe('fail')
    expect(pragma.diagnostics.some((d) => d.code === 'FOREIGN_KEY_CHECK_VIOLATION')).toBe(true)
    // Relation evidence also disagrees with the manifest ownership.
    expect(dim(report, 'relations').status).toBe('fail')
  })

  it('fails file_references when a snapshot row is missing', async () => {
    corrupt(dbPath, (db) => db.prepare(`DELETE FROM file_references WHERE block_id = 'b-3'`).run())
    const report = await verify(dbPath, manifest)

    const refs = dim(report, 'file_references')
    expect(refs.status).toBe('fail')
    expect(refs.diagnostics.some((d) => d.code === 'MISSING_ENTITY')).toBe(true)
    expect(dim(report, 'id_sets').status).toBe('fail')
    expect(dim(report, 'table_counts').status).toBe('fail')
  })

  it('fails integrity_check deterministically on index corruption while every other dimension passes', async () => {
    // messages_assistant_id_idx is not used by the keyset entity scans, the
    // FK pragma, or the sample read path — silently truncating only that
    // index gives PRAGMA integrity_check deterministic sole evidence (⑪).
    corruptIndexToEmptyPage(dbPath, 'messages_assistant_id_idx')
    const report = await verify(dbPath, manifest)

    expect(report.status).toBe('fail')
    expect(report.fatal).toBeNull()
    const integrity = dim(report, 'integrity_check')
    expect(integrity.status).toBe('fail')
    expect(integrity.diagnostics).toHaveLength(1)
    expect(integrity.diagnostics[0]).toMatchObject({
      entity: 'candidate_db',
      code: 'INTEGRITY_CHECK_FAILED',
      expected: 'ok'
    })
    // Only the finding count is reported — never raw integrity_check text.
    expect(typeof integrity.diagnostics[0].actual).toBe('number')
    // Every other dimension still completed and passed.
    for (const result of report.dimensions) {
      if (result.dimension !== 'integrity_check') expect(result.status).toBe('pass')
    }
  })

  it('sanitizes malformed extra JSON into a fatal without leaking the raw value', async () => {
    corrupt(dbPath, (db) =>
      db.prepare(`UPDATE messages SET extra = '{invalid-json' WHERE id = ?`).run(targetId('t-1', 'm-1'))
    )
    const report = await verify(dbPath, manifest)

    expect(report.status).toBe('fail')
    expect(report.fatal).not.toBeNull()
    expect(report.fatal!.code).toBe('CANDIDATE_QUERY_FAILED')
    // decodeJson's error message embeds the raw extra value — the report
    // must never carry it (LOCK-4304 privacy bound).
    expect(JSON.stringify(report)).not.toContain('invalid-json')
  })

  it('fails sample_reads when read-path index corruption hides rows that all digests still match', async () => {
    // Silent truncation of messages_topic_id_sort_order_idx: the keyset
    // scans walk primary keys, so dimensions ①–⑩ all still pass — only the
    // application read path (listByTopic) goes through the truncated index
    // and returns zero messages. Sample reads (⑬) are the dimension that
    // catches this class of corruption; integrity_check (⑪) corroborates.
    corruptIndexToEmptyPage(dbPath, 'messages_topic_id_sort_order_idx')
    const report = await verify(dbPath, manifest, { sampleCount: 10 })

    expect(report.status).toBe('fail')
    expect(report.fatal).toBeNull()
    expect(dim(report, 'id_sets').status).toBe('pass')
    expect(dim(report, 'field_digests').status).toBe('pass')
    expect(dim(report, 'order').status).toBe('pass')
    expect(dim(report, 'integrity_check').status).toBe('fail')
    const samples = dim(report, 'sample_reads')
    expect(samples.status).toBe('fail')
    expect(
      samples.diagnostics.some(
        (d) => d.entity === 'topics' && d.fieldPath === 'messages' && d.code === 'SAMPLE_READ_MISMATCH'
      )
    ).toBe(true)
    // Evidence is digests only — never SQL, paths, or raw content.
    expect(JSON.stringify(report)).not.toContain('SELECT')
    expect(JSON.stringify(report)).not.toContain(tempDir)
  })

  it('fails sample_reads when a sampled topic cannot be read back', async () => {
    // Remove the topic row but keep its messages: id_sets catches the
    // missing topic AND the application read path returns null.
    corrupt(dbPath, (db) => db.prepare(`DELETE FROM topics WHERE id = 't-1'`).run())
    const report = await verify(dbPath, manifest, { sampleCount: 10 })

    const samples = dim(report, 'sample_reads')
    expect(samples.status).toBe('fail')
    expect(samples.diagnostics.some((d) => d.entityId === 't-1' && d.code === 'SAMPLE_READ_MISMATCH')).toBe(true)
    expect(dim(report, 'id_sets').status).toBe('fail')
  })

  // -------------------------------------------------------------------------
  // Sanitized unexpected failures — report, never throw (LOCK-4304)
  // -------------------------------------------------------------------------

  it('sanitizes an open failure into the report without exposing the path', async () => {
    const missingPath = realPath.join(tempDir, 'does-not-exist.db')
    const verifier = createCandidateVerifier({ dbPath: missingPath, manifest })
    const report = await verifier.run()

    expect(report.status).toBe('fail')
    expect(report.fatal).not.toBeNull()
    expect(report.fatal!.code).toBe('CANDIDATE_OPEN_FAILED')
    expect(report.dimensions).toHaveLength(14)
    for (const result of report.dimensions) expect(result.status).toBe('skipped')
    expect(JSON.stringify(report)).not.toContain(tempDir)
    expect(verifier.getState()).toBe('done')
  })

  it('sanitizes a query failure (dropped table) into the report', async () => {
    corrupt(dbPath, (db) => db.exec('DROP TABLE file_references'))
    const report = await verify(dbPath, manifest)

    expect(report.status).toBe('fail')
    expect(report.fatal).not.toBeNull()
    expect(report.fatal!.code).toBe('CANDIDATE_QUERY_FAILED')
    expect(report.dimensions).toHaveLength(14)
    expect(JSON.stringify(report)).not.toContain('SELECT')
  })

  it('reports corruption of the database file without throwing', async () => {
    // Clobber an entire b-tree page (page 2 onward) past the header page.
    const fd = realFs.openSync(dbPath, 'r+')
    realFs.writeSync(fd, Buffer.alloc(4096, 0xff), 0, 4096, 4096)
    realFs.closeSync(fd)

    const report = await verify(dbPath, manifest)
    expect(report.status).toBe('fail')
    // Either a scan fails (sanitized fatal) or integrity_check reports it.
    const integrity = dim(report, 'integrity_check')
    expect(report.fatal !== null || integrity.status === 'fail').toBe(true)
  })

  // -------------------------------------------------------------------------
  // Abort / lifecycle (LOCK-4303)
  // -------------------------------------------------------------------------

  it('returns an aborted report for a pre-aborted signal without opening', async () => {
    const controller = new AbortController()
    controller.abort()
    let checkpoints = 0
    const report = await verify(dbPath, manifest, {
      signal: controller.signal,
      onCheckpoint: () => {
        checkpoints += 1
      }
    })

    expect(report.status).toBe('aborted')
    expect(report.fatal).toBeNull()
    expect(report.dimensions).toHaveLength(14)
    for (const result of report.dimensions) expect(result.status).toBe('skipped')
    expect(checkpoints).toBe(1)
  })

  it('aborts deterministically at the same checkpoint boundary', async () => {
    const runAbortedAt = async (n: number): Promise<CandidateVerificationReport> => {
      const controller = new AbortController()
      let count = 0
      return await verify(dbPath, manifest, {
        signal: controller.signal,
        onCheckpoint: () => {
          count += 1
          if (count === n) controller.abort()
        }
      })
    }

    const first = await runAbortedAt(3)
    const second = await runAbortedAt(3)
    expect(first.status).toBe('aborted')
    expect(second.status).toBe('aborted')
    expect(first.dimensions.map((d) => d.status)).toEqual(second.dimensions.map((d) => d.status))
    expect(first.dimensions.some((d) => d.status === 'skipped')).toBe(true)
  })

  it('close() during a run cancels cooperatively and ends closed', async () => {
    const verifier = createCandidateVerifier({
      dbPath,
      manifest,
      chunkSize: 1,
      onCheckpoint: () => {
        // Close from "outside" once scanning has started.
      }
    })
    const pending = verifier.run()
    verifier.close()
    const report = await pending

    expect(report.status).toBe('aborted')
    expect(verifier.getState()).toBe('closed')
    // Idempotent close.
    verifier.close()
    expect(verifier.getState()).toBe('closed')
  })

  it('run() is exact-once and rejected after close()', async () => {
    const verifier = createCandidateVerifier({ dbPath, manifest })
    await verifier.run()
    await expect(verifier.run()).rejects.toThrow(/exact-once/)

    const closed = createCandidateVerifier({ dbPath, manifest })
    closed.close()
    await expect(closed.run()).rejects.toThrow(/exact-once/)
  })

  // -------------------------------------------------------------------------
  // Diagnostic cap (LOCK-4304)
  // -------------------------------------------------------------------------

  it('caps diagnostics per dimension and records truncation metadata', async () => {
    corrupt(dbPath, (db) => db.prepare(`UPDATE messages SET content = 'tampered'`).run())
    const report = await verify(dbPath, manifest, { maxDiagnosticsPerDimension: 2 })

    const digests = dim(report, 'field_digests')
    expect(digests.status).toBe('fail')
    expect(digests.diagnostics).toHaveLength(2)
    expect(digests.truncatedDiagnosticCount).toBe(2) // 4 messages mutated
    expect(digests.checkedCount).toBeGreaterThanOrEqual(4)
    // Diagnostics never carry the raw mutated content.
    expect(JSON.stringify(report)).not.toContain('tampered')
  })
})

// ---------------------------------------------------------------------------
// LOCK-OWN-1: outer-topic canonicalization through the FULL
// plane → manifest → sealed candidate → verifier path
// ---------------------------------------------------------------------------

describe('LOCK-OWN-1 outer-topic canonicalization (full plane+manifest+verify)', () => {
  let tempDir: string
  let dbPath: string
  let manifest: SourceVerificationManifest

  // Embedded messages whose `topicId` claims a STALE topic (valid string,
  // different from the authoritative outer topic — LOCK-OWN-1 canonicalizes).
  const STALE_MSG_1 = srcMessage('m-1', 't-stale', ['b-1'], { model: STRUCTURED_MODEL })
  const STALE_MSG_2 = srcMessage('m-2', 't-stale-2', ['b-2'])
  // Matching message (no normalization).
  const MATCHING_MSG_3 = srcMessage('m-3', 't-2', ['b-3'])

  beforeEach(() => {
    tempDir = makeTempDir()
    dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = new Database(dbPath)
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    const db = drizzle(sqlite, { schema })
    runMigrations(db, sqlite)

    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [STALE_MSG_1, STALE_MSG_2]), srcTopic('t-2', [MATCHING_MSG_3])]))
    plane.processPage(
      page('message_blocks', [
        srcBlock('b-1', 'm-1'),
        srcBlock('b-2', 'm-2', { type: 'file', file: FILE_META as unknown as JsonObject['x'] }),
        srcBlock('b-3', 'm-3')
      ])
    )
    plane.processPage(page('topic_segments', [srcSegment('s-1', 't-1', ['m-2', 'm-1'])]))
    plane.finalize()

    manifest = plane.getSourceVerificationManifest()
    sqlite.close() // sealed — the verifier reopens readonly
  })

  afterEach(() => {
    realFs.rmSync(tempDir, { recursive: true, force: true })
    expect(realFs.existsSync(tempDir)).toBe(false)
  })

  it('records canonical outer topicId in manifest evidence and digests, stores it in the candidate, and verifies clean', async () => {
    // --- Source manifest evidence is canonical (LOCK-OWN-1/4301, MID-1) ---
    expect(manifest.messages.entries[targetId('t-1', 'm-1')].topicId).toBe('t-1')
    expect(manifest.messages.entries[targetId('t-1', 'm-2')].topicId).toBe('t-1')
    expect(manifest.messages.entries[targetId('t-2', 'm-3')].topicId).toBe('t-2')

    // The digest is framed from the canonical projection: wire projection
    // with target id, topicId overridden to the outer topic and sortOrder =
    // array index.
    const expectedM1 = wireToMessage(STALE_MSG_1)
    expectedM1.id = targetId('t-1', 'm-1')
    expectedM1.topicId = 't-1'
    expectedM1.sortOrder = 0
    expect(manifest.messages.entries[expectedM1.id].digest).toBe(canonicalDigest({ ...expectedM1 }))
    expect(manifest.messages.entries[expectedM1.id].overflowDigest).toBe(canonicalDigest(expectedM1.overflow))
    const expectedM2 = wireToMessage(STALE_MSG_2)
    expectedM2.id = targetId('t-1', 'm-2')
    expectedM2.topicId = 't-1'
    expectedM2.sortOrder = 1
    expect(manifest.messages.entries[expectedM2.id].digest).toBe(canonicalDigest({ ...expectedM2 }))
    const expectedM3 = wireToMessage(MATCHING_MSG_3)
    expectedM3.id = targetId('t-2', 'm-3')
    expectedM3.sortOrder = 0
    expect(manifest.messages.entries[expectedM3.id].digest).toBe(canonicalDigest({ ...expectedM3 }))

    // --- Candidate write stores the authoritative outer topic + target ids ---
    const readonly = new Database(dbPath, { readonly: true, fileMustExist: true })
    const rows = readonly.prepare('SELECT id, topic_id FROM messages ORDER BY id').all() as Array<{
      id: string
      topic_id: string
    }>
    expect(rows).toEqual(
      [
        { id: targetId('t-1', 'm-1'), topic_id: 't-1' },
        { id: targetId('t-1', 'm-2'), topic_id: 't-1' },
        { id: targetId('t-2', 'm-3'), topic_id: 't-2' }
      ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    )
    readonly.close()

    // --- Verifier passes ALL 14 dimensions from the same canonical staged data ---
    const report = await verify(dbPath, manifest)
    expect(report.status).toBe('pass')
    expect(report.fatal).toBeNull()
    for (const result of report.dimensions) {
      expect(result.status).toBe('pass')
      expect(result.diagnostics).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------
// LOCK-BLOCK-1/2: unreachable orphan block canonicalization through the FULL
// plane → manifest → sealed candidate → verifier path
//
// Source rows 125 (120 referenced + 5 unreachable orphans), imported 120,
// skipped 5. The manifest is reachable-only (skipped rows are never staged),
// the candidate holds exactly the 120 reachable blocks, and all 14 verifier
// dimensions pass on the same reachable-only projection.
// ---------------------------------------------------------------------------

describe('LOCK-BLOCK-1 unreachable orphan block canonicalization (full plane+manifest+verify)', () => {
  let tempDir: string
  let dbPath: string
  let manifest: SourceVerificationManifest

  beforeEach(() => {
    tempDir = makeTempDir()
    dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = new Database(dbPath)
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    const db = drizzle(sqlite, { schema })
    runMigrations(db, sqlite)

    const plane = createImportDataPlane(db)
    // 20 messages × 6 blocks = 120 referenced blocks.
    const messages: JsonObject[] = []
    const blockRows: JsonObject[] = []
    let blockIndex = 0
    for (let m = 0; m < 20; m++) {
      const messageBlocks: string[] = []
      for (let b = 0; b < 6; b++) {
        const blockId = `b-${blockIndex}`
        messageBlocks.push(blockId)
        blockRows.push(srcBlock(blockId, `m-${m}`))
        blockIndex++
      }
      messages.push(srcMessage(`m-${m}`, 't-1', messageBlocks))
    }
    // 5 unreachable orphans: block id AND messageId absent from all imported
    // messages; file payloads must be ignored by the reachable-only projection.
    for (let o = 0; o < 5; o++) {
      blockRows.push(
        srcBlock(`b-orphan-${o}`, `m-orphan-${o}`, {
          type: 'file',
          content: null,
          file: { id: `f-orphan-${o}`, name: `orphan-${o}.png`, path: '/o', type: 'file' }
        })
      )
    }

    plane.processPage(page('topics', [srcTopic('t-1', messages)]))
    plane.processPage(page('message_blocks', blockRows))
    plane.processPage(page('topic_segments', [srcSegment('s-1', 't-1', ['m-0', 'm-19'])]))
    plane.finalize()

    manifest = plane.getSourceVerificationManifest()
    sqlite.close() // sealed — the verifier reopens readonly
  })

  afterEach(() => {
    realFs.rmSync(tempDir, { recursive: true, force: true })
    expect(realFs.existsSync(tempDir)).toBe(false)
  })

  it('keeps the manifest reachable-only, stores exactly 120 blocks in the candidate, and verifies all 14 dimensions', async () => {
    // --- Source manifest evidence is reachable-only (LOCK-BLOCK-1) ---
    expect(manifest.blocks.count).toBe(120)
    expect(manifest.fileReferences.count).toBe(0) // orphan file payloads ignored
    expect(manifest.messages.count).toBe(20)
    expect(Object.keys(manifest.blocks.entries)).toHaveLength(120)
    for (let o = 0; o < 5; o++) {
      expect(manifest.blocks.entries[`b-orphan-${o}`]).toBeUndefined()
    }

    // --- Candidate stores exactly the 120 reachable blocks, none orphaned ---
    const readonly = new Database(dbPath, { readonly: true, fileMustExist: true })
    const blockRows = readonly.prepare('SELECT id, message_id FROM message_blocks ORDER BY id').all() as Array<{
      id: string
      message_id: string
    }>
    expect(blockRows).toHaveLength(120)
    expect(blockRows.every((r) => !r.id.startsWith('b-orphan-'))).toBe(true)
    expect(readonly.prepare('SELECT count(*) AS c FROM file_references').get()).toEqual({ c: 0 })
    readonly.close()

    // --- Verifier passes ALL 14 dimensions from the same reachable-only data ---
    const report = await verify(dbPath, manifest)
    expect(report.status).toBe('pass')
    expect(report.fatal).toBeNull()
    for (const result of report.dimensions) {
      expect(result.status).toBe('pass')
      expect(result.diagnostics).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------
// LOCK-VERIFY-1 + LOCK-REF-1 + LOCK-ASK-1 + LOCK-PRIV-1: all-occurrence
// identity through the FULL plane → manifest → sealed candidate → verifier path
//
// One real better-sqlite3 session exercises the complete canonical-ID
// closure the E2E seeds stay too simple to cover:
// - cross-topic REUSED legacy id ('m-shared' in t-1 and t-2) → distinct
//   targets, every occurrence mapped, no legacy id retained (LOCK-MID-1/2);
// - same-topic askId rewritten to the occurrence target (LOCK-ASK-1);
// - a preserved DANGLING askId carrying a synthetic privacy sentinel
//   (LOCK-ASK-1/2 + LOCK-PRIV-1);
// - target block.messageId / segment memberships with UNCHANGED block
//   primary IDs and file-reference blockIds (LOCK-REF-1);
// - all 14 verifier dimensions pass on the same projection, and the
//   serialized report never leaks the raw mapped/preserved askId sentinels.
// ---------------------------------------------------------------------------

describe('LOCK-VERIFY-1 all-occurrence identity (full plane+manifest+verify)', () => {
  /** Synthetic privacy sentinel — never a real artifact value (LOCK-PRIV-1). */
  const PRIV_SENTINEL = 'zz-priv-sentinel-9f3a-77c1'

  let tempDir: string
  let dbPath: string
  let manifest: SourceVerificationManifest

  beforeEach(() => {
    tempDir = makeTempDir()
    dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = new Database(dbPath)
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    const db = drizzle(sqlite, { schema })
    runMigrations(db, sqlite)

    const plane = createImportDataPlane(db)
    // t-1: same-topic askId mapping (m-user ← m-asst-1/m-asst-2) + the FIRST
    // occurrence of the reused legacy id 'm-shared'.
    plane.processPage(
      page('topics', [
        srcTopic('t-1', [
          srcMessage('m-user', 't-1', ['b-user']),
          srcMessage('m-asst-1', 't-1', [], { role: 'assistant', askId: 'm-user' }),
          srcMessage('m-asst-2', 't-1', [], { role: 'assistant', askId: 'm-user' }),
          srcMessage('m-shared', 't-1', [])
        ]),
        // t-2: the SECOND occurrence of 'm-shared' (distinct target) + a
        // preserved dangling askId carrying the synthetic privacy sentinel.
        srcTopic('t-2', [
          srcMessage('m-shared', 't-2', ['b-shared-t2', 'b-file']),
          srcMessage('m-dangle', 't-2', [], { role: 'assistant', askId: PRIV_SENTINEL })
        ])
      ])
    )
    plane.processPage(
      page('message_blocks', [
        srcBlock('b-user', 'm-user'),
        srcBlock('b-shared-t2', 'm-shared'),
        srcBlock('b-file', 'm-shared', { type: 'file', file: FILE_META as unknown as JsonObject['x'] })
      ])
    )
    // Memberships reference the reused legacy id in BOTH topics — each must
    // resolve to its own same-topic target (LOCK-REF-1).
    plane.processPage(
      page('topic_segments', [
        srcSegment('s-1', 't-1', ['m-user', 'm-shared', 'm-asst-1']),
        srcSegment('s-2', 't-2', ['m-shared', 'm-dangle'])
      ])
    )
    plane.processPage(page('files', [{ id: 'file-1' } as JsonObject]))
    plane.finalize()

    manifest = plane.getSourceVerificationManifest()
    sqlite.close() // sealed — the verifier reopens readonly
  })

  afterEach(() => {
    realFs.rmSync(tempDir, { recursive: true, force: true })
    expect(realFs.existsSync(tempDir)).toBe(false)
  })

  it('maps every occurrence, rewrites askId/refs to targets, keeps block/file ids, and passes all 14 dimensions', async () => {
    // --- Manifest evidence: all 6 occurrences mapped, reused id distinct ---
    expect(manifest.messages.count).toBe(6)
    expect(manifest.messages.entries[targetId('t-1', 'm-shared')].topicId).toBe('t-1')
    expect(manifest.messages.entries[targetId('t-2', 'm-shared')].topicId).toBe('t-2')
    expect(manifest.messages.entries[targetId('t-1', 'm-user')].topicId).toBe('t-1')

    // The same-topic askId is rewritten to the occurrence target inside the
    // manifest digest (LOCK-ASK-1/4301).
    const expectedAsst = wireToMessage(srcMessage('m-asst-2', 't-1', [], { role: 'assistant', askId: 'm-user' }))
    expectedAsst.id = targetId('t-1', 'm-asst-2')
    expectedAsst.topicId = 't-1'
    expectedAsst.sortOrder = 2
    expectedAsst.askId = targetId('t-1', 'm-user')
    expect(manifest.messages.entries[expectedAsst.id].digest).toBe(canonicalDigest({ ...expectedAsst }))

    // Block ownership evidence resolves through the EMBEDDED owner to the
    // target — including the reused legacy id in t-2 (LOCK-REF-1).
    expect(manifest.blocks.entries['b-user'].messageId).toBe(targetId('t-1', 'm-user'))
    expect(manifest.blocks.entries['b-shared-t2'].messageId).toBe(targetId('t-2', 'm-shared'))
    expect(manifest.blocks.entries['b-file'].messageId).toBe(targetId('t-2', 'm-shared'))
    // File-reference evidence keeps the SOURCE block id (LOCK-REF-1). The
    // evidence is keyed by the derived reference id `fr-<blockId>-<fileId>`;
    // the fileId itself lives in the digest and is asserted on the row below.
    expect(manifest.fileReferences.entries['fr-b-file-file-1'].blockId).toBe('b-file')

    // Membership evidence: same-topic resolution per segment (LOCK-REF-1).
    expect(manifest.memberships.bySegment['s-1']).toEqual([
      targetId('t-1', 'm-user'),
      targetId('t-1', 'm-shared'),
      targetId('t-1', 'm-asst-1')
    ])
    expect(manifest.memberships.bySegment['s-2']).toEqual([targetId('t-2', 'm-shared'), targetId('t-2', 'm-dangle')])

    // --- Candidate rows: target ids everywhere, block/file primary ids kept ---
    const readonly = new Database(dbPath, { readonly: true, fileMustExist: true })
    const messages = readonly.prepare('SELECT id, topic_id, ask_id FROM messages ORDER BY id').all() as Array<{
      id: string
      topic_id: string
      ask_id: string | null
    }>
    expect(messages).toHaveLength(6)
    const ids = new Set(messages.map((m) => m.id))
    expect(ids).toEqual(
      new Set([
        targetId('t-1', 'm-user'),
        targetId('t-1', 'm-asst-1'),
        targetId('t-1', 'm-asst-2'),
        targetId('t-1', 'm-shared'),
        targetId('t-2', 'm-shared'),
        targetId('t-2', 'm-dangle')
      ])
    )
    expect(ids.size).toBe(6)
    // No occurrence retains its legacy id (LOCK-MID-1).
    expect(messages.some((m) => m.id === 'm-user' || m.id === 'm-shared')).toBe(false)
    const askIdById = new Map(messages.map((m) => [m.id, m.ask_id]))
    expect(askIdById.get(targetId('t-1', 'm-asst-1'))).toBe(targetId('t-1', 'm-user'))
    expect(askIdById.get(targetId('t-1', 'm-asst-2'))).toBe(targetId('t-1', 'm-user'))
    expect(askIdById.get(targetId('t-2', 'm-dangle'))).toBe(PRIV_SENTINEL) // preserved verbatim (LOCK-ASK-1)

    const blocks = readonly.prepare('SELECT id, message_id FROM message_blocks ORDER BY id').all() as Array<{
      id: string
      message_id: string
    }>
    expect(blocks).toEqual([
      { id: 'b-file', message_id: targetId('t-2', 'm-shared') },
      { id: 'b-shared-t2', message_id: targetId('t-2', 'm-shared') },
      { id: 'b-user', message_id: targetId('t-1', 'm-user') }
    ])
    const refs = readonly.prepare('SELECT block_id, file_id FROM file_references ORDER BY block_id').all()
    expect(refs).toEqual([{ block_id: 'b-file', file_id: 'file-1' }])
    const memberships = readonly
      .prepare('SELECT segment_id, message_id FROM topic_segment_messages ORDER BY segment_id, sort_order')
      .all() as Array<{ segment_id: string; message_id: string }>
    expect(memberships).toEqual([
      { segment_id: 's-1', message_id: targetId('t-1', 'm-user') },
      { segment_id: 's-1', message_id: targetId('t-1', 'm-shared') },
      { segment_id: 's-1', message_id: targetId('t-1', 'm-asst-1') },
      { segment_id: 's-2', message_id: targetId('t-2', 'm-shared') },
      { segment_id: 's-2', message_id: targetId('t-2', 'm-dangle') }
    ])
    readonly.close()

    // --- Verifier passes ALL 14 dimensions on the same projection ---
    const report = await verify(dbPath, manifest)
    expect(report.status).toBe('pass')
    expect(report.fatal).toBeNull()
    for (const result of report.dimensions) {
      expect(result.status).toBe('pass')
      expect(result.diagnostics).toEqual([])
    }
    // LOCK-PRIV-1: even on the pristine pass, the serialized report never
    // carries the raw preserved sentinel NOR the raw mapped legacy value.
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain(PRIV_SENTINEL)
    expect(serialized).not.toContain('m-user')
  })

  it('omits raw mapped/preserved askId sentinels from serialized diagnostics on corruption (LOCK-PRIV-1)', async () => {
    // Force field_digests to fail on the message that HOLDS the preserved
    // sentinel (the only place a raw askId value could ever surface). The
    // diagnostics must report the TARGET id and digests only.
    corrupt(dbPath, (db) =>
      db.prepare(`UPDATE messages SET role = 'user' WHERE id = ?`).run(targetId('t-2', 'm-dangle'))
    )
    const report = await verify(dbPath, manifest)

    expect(report.status).toBe('fail')
    const digests = dim(report, 'field_digests')
    expect(digests.status).toBe('fail')
    expect(digests.diagnostics.some((d) => d.entityId === targetId('t-2', 'm-dangle'))).toBe(true)

    // The serialized diagnostics never leak the raw sentinel values
    // (LOCK-PRIV-1): the preserved dangling value and the mapped raw legacy
    // value must be absent from the entire report.
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain(PRIV_SENTINEL)
    expect(serialized).not.toContain('m-user')
    expect(serialized).not.toContain(tempDir)
  })
})

// ---------------------------------------------------------------------------
// LOCK-LB-6: bounded large message-block compatibility through the FULL
// plane → manifest → sealed candidate → verifier path.
//
// One real better-sqlite3 session proves a reachable block carrying a
// ~2.67 MiB nested string (above the generic 1 MiB cap, inside the named
// block profile) completes the whole pipeline and verifies clean across all
// 14 dimensions, while a large unreachable orphan produces no manifest
// evidence, no candidate row, and never reaches the verifier.
// ---------------------------------------------------------------------------

describe('LOCK-LB-6 large block full plane+manifest+verify', () => {
  const BIG_CONTENT = 'x'.repeat(2 * 1024 * 1024 + 700_000) // ~2.67 MiB (artifact mirror)

  let tempDir: string
  let dbPath: string
  let manifest: SourceVerificationManifest

  beforeEach(() => {
    tempDir = makeTempDir()
    dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = new Database(dbPath)
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    const db = drizzle(sqlite, { schema })
    runMigrations(db, sqlite)

    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', ['b-big'])])]))
    plane.processPage(
      page('message_blocks', [
        srcBlock('b-big', 'm-1', { content: BIG_CONTENT }),
        // Large unreachable orphan: skipped, never staged/verified.
        srcBlock('b-orphan-large', 'm-dead-large', { content: 'y'.repeat(2 * 1024 * 1024) })
      ])
    )
    plane.finalize()

    manifest = plane.getSourceVerificationManifest()
    sqlite.close() // sealed — the verifier reopens readonly
  })

  afterEach(() => {
    realFs.rmSync(tempDir, { recursive: true, force: true })
    expect(realFs.existsSync(tempDir)).toBe(false)
  })

  it('keeps the manifest reachable-only, stores the large block, and verifies all 14 dimensions', async () => {
    // Manifest is reachable-only: the large orphan is absent (LOCK-BLOCK-1).
    expect(manifest.blocks.count).toBe(1)
    expect(manifest.blocks.entries['b-big']).toBeDefined()
    expect(manifest.blocks.entries['b-orphan-large']).toBeUndefined()
    expect(manifest.messages.count).toBe(1)

    // Candidate stores the reachable large block with its exact content.
    const readonly = new Database(dbPath, { readonly: true, fileMustExist: true })
    const row = readonly.prepare('SELECT id, message_id, content FROM message_blocks ORDER BY id').all() as Array<{
      id: string
      message_id: string
      content: string | null
    }>
    expect(row).toHaveLength(1)
    expect(row[0].id).toBe('b-big')
    expect(row[0].content).toBe(BIG_CONTENT)
    readonly.close()

    // The verifier passes ALL 14 dimensions on the large-block candidate.
    const report = await verify(dbPath, manifest)
    expect(report.status).toBe('pass')
    expect(report.fatal).toBeNull()
    for (const result of report.dimensions) {
      expect(result.status).toBe('pass')
      expect(result.diagnostics).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------
// LOCK-SP-7: derived search projection corruption classes through the FULL
// verifier. Every corruption deterministically fails dimension ⑭
// (`search_projection`) with bounded evidence, never a fatal, and the
// serialized report never carries content/paths (LOCK-SP-3/LOCK-PRIV).
//
// The pristine sealed candidate (buildSealedCandidate) is trigger-maintained
// by migration 003, so the derived projection is correct: 3 MAIN_TEXT
// content-not-null blocks (b-1, b-4, b-5) mirrored in both the normalized
// table and the FTS table.
// ---------------------------------------------------------------------------

describe('LOCK-SP-7 search projection corruption (candidate verifier)', () => {
  let tempDir: string
  let dbPath: string
  let manifest: SourceVerificationManifest

  beforeEach(() => {
    tempDir = makeTempDir()
    const sealed = buildSealedCandidate(tempDir)
    dbPath = sealed.dbPath
    manifest = sealed.manifest
  })

  afterEach(() => {
    realFs.rmSync(tempDir, { recursive: true, force: true })
    expect(realFs.existsSync(tempDir)).toBe(false)
  })

  const pristinePredicateCount = 3 // b-1, b-4, b-5 are MAIN_TEXT with content
  const expectedPristineCheckedCount = 6 + 2 + pristinePredicateCount * 2 + pristinePredicateCount + 1 + 1

  it('passes the search_projection dimension on the pristine candidate', async () => {
    const report = await verify(dbPath, manifest)
    expect(report.status).toBe('pass')
    const sp = dim(report, 'search_projection')
    expect(sp.status).toBe('pass')
    expect(sp.checkedCount).toBe(expectedPristineCheckedCount)
  })

  it('fails the dimension with OBJECT_MISSING when the FTS table is dropped', async () => {
    corrupt(dbPath, (db) => db.exec(`DROP TABLE ${MESSAGE_BLOCKS_FTS_TABLE}`))
    const report = await verify(dbPath, manifest)

    expect(report.status).toBe('fail')
    expect(report.fatal).toBeNull()
    const sp = dim(report, 'search_projection')
    expect(sp.status).toBe('fail')
    expect(
      sp.diagnostics.some(
        (d) => d.code === 'SEARCH_PROJECTION_OBJECT_MISSING' && d.expected === MESSAGE_BLOCKS_FTS_TABLE
      )
    ).toBe(true)
    // All 13 pre-existing dimensions still pass — the projection is the only damage.
    for (const result of report.dimensions) {
      if (result.dimension !== 'search_projection') expect(result.status).toBe('pass')
    }
  })

  it('fails the dimension with OBJECT_MISSING when a sync trigger is dropped', async () => {
    corrupt(dbPath, (db) => db.exec(`DROP TRIGGER ${MESSAGE_BLOCKS_NORMALIZED_INSERT_TRIGGER}`))
    const report = await verify(dbPath, manifest)

    const sp = dim(report, 'search_projection')
    expect(sp.status).toBe('fail')
    expect(
      sp.diagnostics.some(
        (d) => d.code === 'SEARCH_PROJECTION_OBJECT_MISSING' && d.expected === MESSAGE_BLOCKS_NORMALIZED_INSERT_TRIGGER
      )
    ).toBe(true)
  })

  it('fails the dimension with OBJECT_MISSING when the normalized table is dropped', async () => {
    corrupt(dbPath, (db) => db.exec(`DROP TABLE ${MESSAGE_BLOCKS_NORMALIZED_TABLE}`))
    const report = await verify(dbPath, manifest)

    const sp = dim(report, 'search_projection')
    expect(sp.status).toBe('fail')
    expect(
      sp.diagnostics.some(
        (d) => d.code === 'SEARCH_PROJECTION_OBJECT_MISSING' && d.expected === MESSAGE_BLOCKS_NORMALIZED_TABLE
      )
    ).toBe(true)
  })

  it('fails the dimension with COUNT_MISMATCH on an empty FTS table', async () => {
    corrupt(dbPath, (db) => db.exec(`DELETE FROM ${MESSAGE_BLOCKS_FTS_TABLE}`))
    const report = await verify(dbPath, manifest)

    const sp = dim(report, 'search_projection')
    expect(sp.status).toBe('fail')
    expect(
      sp.diagnostics.some((d) => d.code === 'SEARCH_PROJECTION_COUNT_MISMATCH' && d.entity === MESSAGE_BLOCKS_FTS_TABLE)
    ).toBe(true)
  })

  it('fails the dimension with COUNT_MISMATCH + FTS_MISMATCH + ROW_MISSING on a partial FTS', async () => {
    corrupt(dbPath, (db) => db.exec(`DELETE FROM ${MESSAGE_BLOCKS_FTS_TABLE} WHERE block_id = 'b-1'`))
    const report = await verify(dbPath, manifest)

    const sp = dim(report, 'search_projection')
    expect(sp.status).toBe('fail')
    expect(
      sp.diagnostics.some((d) => d.code === 'SEARCH_PROJECTION_COUNT_MISMATCH' && d.entity === MESSAGE_BLOCKS_FTS_TABLE)
    ).toBe(true)
    expect(sp.diagnostics.some((d) => d.code === 'SEARCH_PROJECTION_FTS_MISMATCH')).toBe(true)
    // Exact per-row evidence: the b-1 normalized row has no FTS counterpart.
    expect(
      sp.diagnostics.some(
        (d) =>
          d.code === 'SEARCH_PROJECTION_ROW_MISSING' &&
          d.entityId === 'b-1' &&
          d.entity === MESSAGE_BLOCKS_NORMALIZED_TABLE
      )
    ).toBe(true)
  })

  it('fails the dimension with CONTENT_MISMATCH on stale normalized content', async () => {
    corrupt(dbPath, (db) =>
      db
        .prepare(
          `UPDATE ${MESSAGE_BLOCKS_NORMALIZED_TABLE} SET normalized_content = 'stale-text' WHERE block_id = 'b-1'`
        )
        .run()
    )
    const report = await verify(dbPath, manifest)

    const sp = dim(report, 'search_projection')
    expect(sp.status).toBe('fail')
    expect(
      sp.diagnostics.some(
        (d) =>
          d.code === 'SEARCH_PROJECTION_CONTENT_MISMATCH' &&
          d.entityId === 'b-1' &&
          d.fieldPath === 'normalized_content'
      )
    ).toBe(true)
    // Fixed tokens only — the raw stored value never leaks.
    expect(JSON.stringify(report)).not.toContain('stale-text')
  })

  it('fails the dimension with MESSAGE_ID_MISMATCH on a wrong normalized message_id', async () => {
    corrupt(dbPath, (db) =>
      db
        .prepare(`UPDATE ${MESSAGE_BLOCKS_NORMALIZED_TABLE} SET message_id = ? WHERE block_id = 'b-1'`)
        .run(targetId('t-1', 'm-2'))
    )
    const report = await verify(dbPath, manifest)

    const sp = dim(report, 'search_projection')
    expect(sp.status).toBe('fail')
    const diag = sp.diagnostics.find((d) => d.code === 'SEARCH_PROJECTION_MESSAGE_ID_MISMATCH' && d.entityId === 'b-1')
    expect(diag).toBeDefined()
    // Allowed entity-ID evidence only (LOCK-SP-3).
    expect(diag!.expected).toBe(targetId('t-1', 'm-1'))
    expect(diag!.actual).toBe(targetId('t-1', 'm-2'))
  })

  it('fails the dimension with FTS_MISMATCH on wrong FTS content (counts unchanged)', async () => {
    corrupt(dbPath, (db) =>
      db
        .prepare(`UPDATE ${MESSAGE_BLOCKS_FTS_TABLE} SET normalized_content = 'tampered-fts' WHERE block_id = 'b-1'`)
        .run()
    )
    const report = await verify(dbPath, manifest)

    const sp = dim(report, 'search_projection')
    expect(sp.status).toBe('fail')
    expect(sp.diagnostics.some((d) => d.code === 'SEARCH_PROJECTION_FTS_MISMATCH')).toBe(true)
    // No count mismatch (counts stay 3/3/3) — the exact merge still fails
    // on the content inequality: one normalized row missing from FTS and one
    // FTS row without a normalized counterpart, both for b-1.
    expect(sp.diagnostics.some((d) => d.code === 'SEARCH_PROJECTION_COUNT_MISMATCH')).toBe(false)
    expect(
      sp.diagnostics.some(
        (d) =>
          d.code === 'SEARCH_PROJECTION_ROW_MISSING' &&
          d.entityId === 'b-1' &&
          d.entity === MESSAGE_BLOCKS_NORMALIZED_TABLE
      )
    ).toBe(true)
    expect(
      sp.diagnostics.some(
        (d) =>
          d.code === 'SEARCH_PROJECTION_ROW_UNEXPECTED' && d.entityId === 'b-1' && d.entity === MESSAGE_BLOCKS_FTS_TABLE
      )
    ).toBe(true)
    expect(JSON.stringify(report)).not.toContain('tampered-fts')
  })

  it('fails the dimension with COUNT_MISMATCH + ROW_UNEXPECTED on an extra normalized row', async () => {
    corrupt(dbPath, (db) =>
      db
        .prepare(
          `INSERT INTO ${MESSAGE_BLOCKS_NORMALIZED_TABLE} (block_id, message_id, normalized_content) VALUES ('b-extra', ?, ?)`
        )
        .run(targetId('t-1', 'm-1'), 'extra')
    )
    const report = await verify(dbPath, manifest)

    const sp = dim(report, 'search_projection')
    expect(sp.status).toBe('fail')
    expect(sp.diagnostics.some((d) => d.code === 'SEARCH_PROJECTION_COUNT_MISMATCH')).toBe(true)
    expect(sp.diagnostics.some((d) => d.code === 'SEARCH_PROJECTION_ROW_UNEXPECTED' && d.entityId === 'b-extra')).toBe(
      true
    )
  })

  it('fails the dimension with COUNT_MISMATCH + ROW_MISSING on a missing normalized row', async () => {
    corrupt(dbPath, (db) => db.prepare(`DELETE FROM ${MESSAGE_BLOCKS_NORMALIZED_TABLE} WHERE block_id = 'b-5'`).run())
    const report = await verify(dbPath, manifest)

    const sp = dim(report, 'search_projection')
    expect(sp.status).toBe('fail')
    expect(sp.diagnostics.some((d) => d.code === 'SEARCH_PROJECTION_COUNT_MISMATCH')).toBe(true)
    expect(sp.diagnostics.some((d) => d.code === 'SEARCH_PROJECTION_ROW_MISSING' && d.entityId === 'b-5')).toBe(true)
  })

  it('a pristine deferred+rebuilt candidate passes all 14 dimensions (LOCK-SP-7)', async () => {
    // Build a fresh candidate through the real deferred-rebuild flow:
    // defer BEFORE any page write, write through the plane, rebuild, seal.
    const dir = realPath.join(tempDir, 'deferred')
    realFs.mkdirSync(dir, { recursive: true })
    const deferredPath = realPath.join(dir, 'chat.db')
    const sqlite = new Database(deferredPath)
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    const db = drizzle(sqlite, { schema })
    runMigrations(db, sqlite)

    // Import the CandidateFtsProjection helper is statically imported above.
    const helper = new CandidateFtsProjection()
    helper.defer(sqlite)
    expect(
      (
        sqlite
          .prepare('SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?')
          .get(MESSAGE_BLOCKS_NORMALIZED_TABLE) as {
          n: number
        }
      ).n
    ).toBe(0)

    const plane = createImportDataPlane(db)
    plane.processPage(
      page('topics', [
        srcTopic('t-1', [srcMessage('m-1', 't-1', ['b-1', 'b-2']), srcMessage('m-2', 't-1', ['b-3'])]),
        srcTopic('t-2', [srcMessage('m-3', 't-2', ['b-4', 'b-5'])])
      ])
    )
    plane.processPage(
      page('message_blocks', [
        srcBlock('b-1', 'm-1'),
        srcBlock('b-2', 'm-1', { type: 'tool', content: TOOL_CONTENT as unknown as JsonObject['x'] }),
        srcBlock('b-3', 'm-2', { type: 'file', file: FILE_META as unknown as JsonObject['x'] }),
        srcBlock('b-4', 'm-3'),
        srcBlock('b-5', 'm-3')
      ])
    )
    plane.finalize()
    helper.rebuild()
    expect(helper.getState()).toBe('rebuilt')

    const deferredManifest = plane.getSourceVerificationManifest()
    sqlite.close()

    const report = await verify(deferredPath, deferredManifest)
    expect(report.status).toBe('pass')
    expect(report.fatal).toBeNull()
    const sp = dim(report, 'search_projection')
    expect(sp.status).toBe('pass')
    // Rebuilt projection has the same 3-predicate profile as the trigger path.
    expect(sp.checkedCount).toBe(expectedPristineCheckedCount)
  })

  it('the serialized report excludes content and paths on search-projection corruption (LOCK-PRIV)', async () => {
    corrupt(dbPath, (db) =>
      db
        .prepare(
          `UPDATE ${MESSAGE_BLOCKS_NORMALIZED_TABLE} SET normalized_content = 'sensitive-body' WHERE block_id = 'b-4'`
        )
        .run()
    )
    corrupt(dbPath, (db) =>
      db
        .prepare(`UPDATE ${MESSAGE_BLOCKS_FTS_TABLE} SET normalized_content = 'sensitive-fts' WHERE block_id = 'b-4'`)
        .run()
    )
    const report = await verify(dbPath, manifest)

    expect(report.status).toBe('fail')
    const sp = dim(report, 'search_projection')
    expect(sp.status).toBe('fail')
    const serialized = JSON.stringify(report)
    // No raw/normalized content, no paths, no SQL.
    expect(serialized).not.toContain('sensitive-body')
    expect(serialized).not.toContain('sensitive-fts')
    expect(serialized).not.toContain('content of')
    expect(serialized).not.toContain(tempDir)
    expect(serialized).not.toContain('chat.db')
    expect(serialized).not.toContain('SELECT')
  })

  it('normalized content parity is deterministic for markdown/CRLF inputs (LOCK-SP-2)', async () => {
    // The plane normalizes content through the shared pipeline; the verifier
    // recomputes it JS-side. Prove both sides agree on a tricky input.
    const dir = realPath.join(tempDir, 'normalization')
    realFs.mkdirSync(dir, { recursive: true })
    const dbPath2 = realPath.join(dir, 'chat.db')
    const sqlite = new Database(dbPath2)
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    const db = drizzle(sqlite, { schema })
    runMigrations(db, sqlite)

    const plane = createImportDataPlane(db)
    plane.processPage(
      page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', ['b-1']), srcMessage('m-2', 't-1', ['b-2'])])])
    )
    // **Bold**, `inline`, header, link, and CRLF content.
    plane.processPage(
      page('message_blocks', [
        srcBlock('b-1', 'm-1', { content: '**Hello** `world`\r\n# Title\r\n[link](http://x)' }),
        srcBlock('b-2', 'm-2', { content: 'plain text' })
      ])
    )
    plane.finalize()
    const manifest2 = plane.getSourceVerificationManifest()
    sqlite.close()

    const report = await verify(dbPath2, manifest2)
    expect(report.status).toBe('pass')
    expect(dim(report, 'search_projection').status).toBe('pass')

    // The stored normalized content equals the shared JS-side pipeline.
    const readonly = new Database(dbPath2, { readonly: true, fileMustExist: true })
    const row = readonly
      .prepare(`SELECT normalized_content FROM ${MESSAGE_BLOCKS_NORMALIZED_TABLE} WHERE block_id = 'b-1'`)
      .get() as { normalized_content: string }
    readonly.close()
    expect(row.normalized_content).toBe(normalizeSearchText('**Hello** `world`\r\n# Title\r\n[link](http://x)'))
  })

  // -------------------------------------------------------------------------
  // Exact FTS↔normalized multiset parity (LOCK-SP-2/3) — adversarial classes
  // the old XOR fingerprint could not guarantee: NUL/prefix framing
  // collisions, duplicate FTS rows, same-count substitutions, extra rows,
  // chunk-boundary behavior, and privacy of the new evidence.
  // -------------------------------------------------------------------------

  it('detects a NUL/prefix framing collision pair exactly (injective key, counts unchanged)', async () => {
    // Two distinct projection rows whose UNFRAMED concatenations are byte-
    // identical: normalized {('abc','xy')} vs FTS {('a','bcxy')} both
    // serialize to 'abcxy' without length-prefix framing. The injective key
    // (length(block_id), block_id, length(normalized_content),
    // normalized_content) must still fail the parity — and counts are
    // unchanged (1/1/1), so only the exact row merge can detect it.
    const dir = realPath.join(tempDir, 'framing')
    realFs.mkdirSync(dir, { recursive: true })
    const framedPath = realPath.join(dir, 'chat.db')
    const sqlite = new Database(framedPath)
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    const db = drizzle(sqlite, { schema })
    runMigrations(db, sqlite)

    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', ['abc'])])]))
    plane.processPage(page('message_blocks', [srcBlock('abc', 'm-1', { content: 'xy' })]))
    plane.finalize()
    const framedManifest = plane.getSourceVerificationManifest()
    sqlite.close()

    corrupt(framedPath, (db2) =>
      db2
        .prepare(
          `UPDATE ${MESSAGE_BLOCKS_FTS_TABLE} SET block_id = 'a', normalized_content = 'bcxy' WHERE block_id = 'abc'`
        )
        .run()
    )

    const report = await verify(framedPath, framedManifest)
    expect(report.status).toBe('fail')
    const sp = dim(report, 'search_projection')
    expect(sp.status).toBe('fail')
    expect(sp.diagnostics.some((d) => d.code === 'SEARCH_PROJECTION_FTS_MISMATCH')).toBe(true)
    expect(
      sp.diagnostics.some(
        (d) =>
          d.code === 'SEARCH_PROJECTION_ROW_MISSING' &&
          d.entityId === 'abc' &&
          d.entity === MESSAGE_BLOCKS_NORMALIZED_TABLE
      )
    ).toBe(true)
    expect(
      sp.diagnostics.some(
        (d) =>
          d.code === 'SEARCH_PROJECTION_ROW_UNEXPECTED' && d.entityId === 'a' && d.entity === MESSAGE_BLOCKS_FTS_TABLE
      )
    ).toBe(true)
    // Counts are unchanged — only the exact row merge fails.
    expect(sp.diagnostics.some((d) => d.code === 'SEARCH_PROJECTION_COUNT_MISMATCH')).toBe(false)
    // Privacy: the framing payload never leaks (only IDs/codes do).
    expect(JSON.stringify(report)).not.toContain('bcxy')
    expect(JSON.stringify(report)).not.toContain('xy')
  })

  it('preserves NUL and supplementary characters through the exact parity (pristine passes, swap fails)', async () => {
    const NUL_CONTENT = 'a\x00b\u{1F600} \u{FFFD} tail'
    const dir = realPath.join(tempDir, 'nul')
    realFs.mkdirSync(dir, { recursive: true })
    const nulPath = realPath.join(dir, 'chat.db')
    const sqlite = new Database(nulPath)
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    const db = drizzle(sqlite, { schema })
    runMigrations(db, sqlite)

    const plane = createImportDataPlane(db)
    plane.processPage(page('topics', [srcTopic('t-1', [srcMessage('m-1', 't-1', ['b-1', 'b-2'])])]))
    plane.processPage(
      page('message_blocks', [srcBlock('b-1', 'm-1', { content: NUL_CONTENT }), srcBlock('b-2', 'm-1')])
    )
    plane.finalize()
    const nulManifest = plane.getSourceVerificationManifest()
    sqlite.close()

    // Pristine: both projections carry the NUL bytes; the byte-exact merge
    // must agree.
    const pristine = await verify(nulPath, nulManifest)
    expect(pristine.status).toBe('pass')
    expect(dim(pristine, 'search_projection').status).toBe('pass')

    // Swap the two FTS contents (counts unchanged) → the NUL boundary must
    // be part of the equality key, not a framing separator.
    corrupt(nulPath, (db2) => {
      const a = db2
        .prepare(`SELECT normalized_content FROM ${MESSAGE_BLOCKS_NORMALIZED_TABLE} WHERE block_id = 'b-1'`)
        .get() as {
        normalized_content: string
      }
      const b = db2
        .prepare(`SELECT normalized_content FROM ${MESSAGE_BLOCKS_NORMALIZED_TABLE} WHERE block_id = 'b-2'`)
        .get() as {
        normalized_content: string
      }
      db2
        .prepare(`UPDATE ${MESSAGE_BLOCKS_FTS_TABLE} SET normalized_content = ? WHERE block_id = 'b-1'`)
        .run(b.normalized_content)
      db2
        .prepare(`UPDATE ${MESSAGE_BLOCKS_FTS_TABLE} SET normalized_content = ? WHERE block_id = 'b-2'`)
        .run(a.normalized_content)
    })

    const report = await verify(nulPath, nulManifest)
    expect(report.status).toBe('fail')
    const sp = dim(report, 'search_projection')
    expect(sp.status).toBe('fail')
    expect(sp.diagnostics.some((d) => d.code === 'SEARCH_PROJECTION_FTS_MISMATCH')).toBe(true)
    expect(sp.diagnostics.some((d) => d.code === 'SEARCH_PROJECTION_ROW_MISSING')).toBe(true)
    expect(sp.diagnostics.some((d) => d.code === 'SEARCH_PROJECTION_ROW_UNEXPECTED')).toBe(true)
    // NUL-containing content never leaks into the serialized report.
    expect(JSON.stringify(report)).not.toContain('a\u0000b')
    expect(JSON.stringify(report)).not.toContain('tail')
  })

  it('detects a duplicate FTS row (same block_id + normalized_content) exactly', async () => {
    corrupt(dbPath, (db) => {
      const row = db
        .prepare(`SELECT normalized_content FROM ${MESSAGE_BLOCKS_NORMALIZED_TABLE} WHERE block_id = 'b-1'`)
        .get() as { normalized_content: string }
      db.prepare(`INSERT INTO ${MESSAGE_BLOCKS_FTS_TABLE} (block_id, normalized_content) VALUES ('b-1', ?)`).run(
        row.normalized_content
      )
    })
    const report = await verify(dbPath, manifest)

    const sp = dim(report, 'search_projection')
    expect(sp.status).toBe('fail')
    expect(
      sp.diagnostics.some((d) => d.code === 'SEARCH_PROJECTION_COUNT_MISMATCH' && d.entity === MESSAGE_BLOCKS_FTS_TABLE)
    ).toBe(true)
    expect(sp.diagnostics.some((d) => d.code === 'SEARCH_PROJECTION_FTS_MISMATCH')).toBe(true)
    // The extra FTS row has no normalized counterpart at that position.
    expect(
      sp.diagnostics.some(
        (d) =>
          d.code === 'SEARCH_PROJECTION_ROW_UNEXPECTED' && d.entityId === 'b-1' && d.entity === MESSAGE_BLOCKS_FTS_TABLE
      )
    ).toBe(true)
  })

  it('detects a same-count substitution (two FTS contents swapped)', async () => {
    corrupt(dbPath, (db) => {
      const a = db
        .prepare(`SELECT normalized_content FROM ${MESSAGE_BLOCKS_NORMALIZED_TABLE} WHERE block_id = 'b-1'`)
        .get() as {
        normalized_content: string
      }
      const c = db
        .prepare(`SELECT normalized_content FROM ${MESSAGE_BLOCKS_NORMALIZED_TABLE} WHERE block_id = 'b-4'`)
        .get() as {
        normalized_content: string
      }
      db.prepare(`UPDATE ${MESSAGE_BLOCKS_FTS_TABLE} SET normalized_content = ? WHERE block_id = 'b-1'`).run(
        c.normalized_content
      )
      db.prepare(`UPDATE ${MESSAGE_BLOCKS_FTS_TABLE} SET normalized_content = ? WHERE block_id = 'b-4'`).run(
        a.normalized_content
      )
    })
    const report = await verify(dbPath, manifest)

    const sp = dim(report, 'search_projection')
    expect(sp.status).toBe('fail')
    expect(sp.diagnostics.some((d) => d.code === 'SEARCH_PROJECTION_FTS_MISMATCH')).toBe(true)
    // Counts stay 3/3/3 — the swap is only visible to the exact merge.
    expect(sp.diagnostics.some((d) => d.code === 'SEARCH_PROJECTION_COUNT_MISMATCH')).toBe(false)
    expect(sp.diagnostics.some((d) => d.code === 'SEARCH_PROJECTION_ROW_MISSING')).toBe(true)
    expect(sp.diagnostics.some((d) => d.code === 'SEARCH_PROJECTION_ROW_UNEXPECTED')).toBe(true)
  })

  it('detects an extra FTS row with no canonical/normalized counterpart', async () => {
    corrupt(dbPath, (db) =>
      db
        .prepare(`INSERT INTO ${MESSAGE_BLOCKS_FTS_TABLE} (block_id, normalized_content) VALUES ('b-ghost', 'ghost')`)
        .run()
    )
    const report = await verify(dbPath, manifest)

    const sp = dim(report, 'search_projection')
    expect(sp.status).toBe('fail')
    expect(sp.diagnostics.some((d) => d.code === 'SEARCH_PROJECTION_COUNT_MISMATCH')).toBe(true)
    expect(
      sp.diagnostics.some(
        (d) =>
          d.code === 'SEARCH_PROJECTION_ROW_UNEXPECTED' &&
          d.entityId === 'b-ghost' &&
          d.entity === MESSAGE_BLOCKS_FTS_TABLE
      )
    ).toBe(true)
    expect(sp.diagnostics.some((d) => d.code === 'SEARCH_PROJECTION_FTS_MISMATCH')).toBe(true)
  })

  it('passes exactly across chunk boundaries (chunkSize=1 and chunkSize=2)', async () => {
    // 3 projection rows over chunkSize=2 and chunkSize=1 force the
    // canonical/normalized/FTS cursors to cross chunk boundaries; the merge
    // must be boundary-independent and preserve the exact checkedCount.
    const report1 = await verify(dbPath, manifest, { chunkSize: 1 })
    expect(report1.status).toBe('pass')
    expect(dim(report1, 'search_projection').status).toBe('pass')
    expect(dim(report1, 'search_projection').checkedCount).toBe(expectedPristineCheckedCount)

    const report2 = await verify(dbPath, manifest, { chunkSize: 2 })
    expect(report2.status).toBe('pass')
    expect(dim(report2, 'search_projection').status).toBe('pass')
    expect(dim(report2, 'search_projection').checkedCount).toBe(expectedPristineCheckedCount)
  })

  it('detects a chunk-boundary mismatch with chunkSize=1 (every row its own chunk)', async () => {
    corrupt(dbPath, (db) => db.exec(`DELETE FROM ${MESSAGE_BLOCKS_FTS_TABLE} WHERE block_id = 'b-4'`))
    const report = await verify(dbPath, manifest, { chunkSize: 1 })

    const sp = dim(report, 'search_projection')
    expect(sp.status).toBe('fail')
    expect(
      sp.diagnostics.some(
        (d) =>
          d.code === 'SEARCH_PROJECTION_ROW_MISSING' &&
          d.entityId === 'b-4' &&
          d.entity === MESSAGE_BLOCKS_NORMALIZED_TABLE
      )
    ).toBe(true)
  })

  it('honors abort checkpoints inside the search_projection parity merge (LOCK-4303)', async () => {
    // Count the deterministic total checkpoints on a pristine chunkSize=1
    // run; the tail of the run is dimension ⑭'s chunked parity scans
    // (canonical, normalized, normalized-parity, FTS-parity cursors), so
    // aborting a few checkpoints before the end lands mid-merge.
    let total = 0
    await verify(dbPath, manifest, {
      chunkSize: 1,
      onCheckpoint: () => {
        total += 1
      }
    })
    expect(total).toBeGreaterThan(40) // sanity: the parity scans ran

    const controller = new AbortController()
    let count = 0
    const report = await verify(dbPath, manifest, {
      chunkSize: 1,
      signal: controller.signal,
      onCheckpoint: () => {
        count += 1
        if (count === total - 3) controller.abort()
      }
    })

    expect(report.status).toBe('aborted')
    expect(report.fatal).toBeNull()
    const sp = dim(report, 'search_projection')
    expect(sp.status).toBe('skipped')
    // The parity phase was already running when the abort landed: object
    // inventory, count parity and pass-A checks had all been performed.
    expect(sp.checkedCount).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// LOCK-SP-3: the verifier chunk size is ALWAYS a finite bounded integer
// before any cursor/buffer allocation. Direct/future callers passing
// Infinity, NaN, zero, negatives, or arbitrarily large finite values
// (e.g. Number.MAX_SAFE_INTEGER) normalize conservatively to the fixed
// default or the fixed maximum — no unbounded allocation, and the exact
// search_projection parity merge (and its checkedCount) is unchanged.
// ---------------------------------------------------------------------------

describe('LOCK-SP-3 chunk size bounding (candidate verifier)', () => {
  let tempDir: string
  let dbPath: string
  let manifest: SourceVerificationManifest

  beforeEach(() => {
    tempDir = makeTempDir()
    const sealed = buildSealedCandidate(tempDir)
    dbPath = sealed.dbPath
    manifest = sealed.manifest
  })

  afterEach(() => {
    realFs.rmSync(tempDir, { recursive: true, force: true })
    expect(realFs.existsSync(tempDir)).toBe(false)
  })

  const pristinePredicateCount = 3 // b-1, b-4, b-5 are MAIN_TEXT with content
  const expectedPristineCheckedCount = 6 + 2 + pristinePredicateCount * 2 + pristinePredicateCount + 1 + 1

  describe('normalizeChunkSize (pure)', () => {
    it('keeps the production default when chunkSize is omitted', () => {
      expect(normalizeChunkSize(undefined)).toBe(500)
    })

    it('normalizes NaN and ±Infinity to the fixed default', () => {
      expect(normalizeChunkSize(Number.NaN)).toBe(500)
      expect(normalizeChunkSize(Number.POSITIVE_INFINITY)).toBe(500)
      expect(normalizeChunkSize(Number.NEGATIVE_INFINITY)).toBe(500)
    })

    it('normalizes zero and negatives to the fixed default', () => {
      expect(normalizeChunkSize(0)).toBe(500)
      expect(normalizeChunkSize(-1)).toBe(500)
      expect(normalizeChunkSize(-Infinity)).toBe(500)
    })

    it('floors fractional in-bounds values unchanged', () => {
      expect(normalizeChunkSize(1)).toBe(1)
      expect(normalizeChunkSize(2.9)).toBe(2)
      expect(normalizeChunkSize(500)).toBe(500)
      expect(normalizeChunkSize(MAX_SEARCH_PROJECTION_CHUNK_SIZE)).toBe(MAX_SEARCH_PROJECTION_CHUNK_SIZE)
    })

    it('clamps positive fractions below 1 up to the floor minimum of 1', () => {
      expect(normalizeChunkSize(0.5)).toBe(1)
      expect(normalizeChunkSize(0.999999)).toBe(1)
      expect(normalizeChunkSize(Number.MIN_VALUE)).toBe(1)
    })

    it('clamps finite oversized values to the fixed maximum', () => {
      expect(normalizeChunkSize(MAX_SEARCH_PROJECTION_CHUNK_SIZE + 1)).toBe(MAX_SEARCH_PROJECTION_CHUNK_SIZE)
      expect(normalizeChunkSize(100_000)).toBe(MAX_SEARCH_PROJECTION_CHUNK_SIZE)
      expect(normalizeChunkSize(Number.MAX_SAFE_INTEGER)).toBe(MAX_SEARCH_PROJECTION_CHUNK_SIZE)
      expect(normalizeChunkSize(Number.MAX_VALUE)).toBe(MAX_SEARCH_PROJECTION_CHUNK_SIZE)
    })

    it('is always a finite integer in [1, MAX_SEARCH_PROJECTION_CHUNK_SIZE]', () => {
      for (const v of [
        undefined,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        -Infinity,
        -1,
        0,
        0.5,
        Number.MIN_VALUE,
        1,
        2.9,
        500,
        MAX_SEARCH_PROJECTION_CHUNK_SIZE,
        MAX_SEARCH_PROJECTION_CHUNK_SIZE + 1,
        Number.MAX_SAFE_INTEGER,
        Number.MAX_VALUE
      ]) {
        const n = normalizeChunkSize(v)
        expect(Number.isFinite(n)).toBe(true)
        expect(Number.isInteger(n)).toBe(true)
        expect(n).toBeGreaterThanOrEqual(1)
        expect(n).toBeLessThanOrEqual(MAX_SEARCH_PROJECTION_CHUNK_SIZE)
      }
    })
  })

  describe('integration — exact parity preserved for pathological chunk sizes', () => {
    const cases: Array<[string, number]> = [
      ['Infinity', Number.POSITIVE_INFINITY],
      ['NaN', Number.NaN],
      ['Number.MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
      ['zero', 0],
      ['positive fraction (0.5)', 0.5],
      ['smallest positive (Number.MIN_VALUE)', Number.MIN_VALUE],
      ['finite over-bound (MAX+1)', MAX_SEARCH_PROJECTION_CHUNK_SIZE + 1],
      ['finite over-bound (100000)', 100_000]
    ]

    it.each(cases)('passes exactly with chunkSize=%s', async (_label, chunkSize) => {
      const report = await verify(dbPath, manifest, { chunkSize })
      expect(report.status).toBe('pass')
      expect(report.fatal).toBeNull()
      const sp = dim(report, 'search_projection')
      expect(sp.status).toBe('pass')
      expect(sp.diagnostics).toEqual([])
      // The bounded normalization must not alter the exact parity merge:
      // checkedCount identical to the production-default run.
      expect(sp.checkedCount).toBe(expectedPristineCheckedCount)
      const defaultSp = dim(await verify(dbPath, manifest), 'search_projection')
      expect(sp.checkedCount).toBe(defaultSp.checkedCount)
    })
  })
})
