/**
 * CandidateVerifier tests — real better-sqlite3, no mocks (Phase 4.3.2).
 *
 * Round trip: a candidate built by the Phase 4.2 ChatImportDataPlane with
 * its finalized manifest is verified after sealing (connection closed).
 *
 * Covers:
 * - Pristine candidate passes all 13 dimensions (LOCK-4304).
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
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import { registerChatDbNormalize, runMigrations } from '../../../chatDb/migration'
import * as schema from '../../../chatDb/schema'
import { createImportDataPlane } from '../../importDataPlane'
import type { CandidateVerifierOptions } from '../candidateVerifier'
import { createCandidateVerifier } from '../candidateVerifier'
import type { SourceVerificationManifest } from '../sourceManifest'
import type { CandidateVerificationReport, VerificationDimension } from '../verificationContracts'
import { VERIFICATION_DIMENSIONS } from '../verificationContracts'

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

  it('passes all 13 dimensions for a pristine sealed candidate', async () => {
    const report = await verify(dbPath, manifest)

    expect(report.status).toBe('pass')
    expect(report.fatal).toBeNull()
    expect(report.dimensions.map((d) => d.dimension)).toEqual([...VERIFICATION_DIMENSIONS])
    expect(report.dimensions).toHaveLength(13)
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
  // Corruption matrix — each injected corruption fails its intended dimension
  // -------------------------------------------------------------------------

  it('fails id_sets + table_counts on a missing row', async () => {
    corrupt(dbPath, (db) => db.prepare(`DELETE FROM messages WHERE id = 'm-4'`).run())
    const report = await verify(dbPath, manifest)

    expect(report.status).toBe('fail')
    const ids = dim(report, 'id_sets')
    expect(ids.status).toBe('fail')
    expect(ids.diagnostics.some((d) => d.code === 'MISSING_ENTITY' && d.entityId === 'm-4')).toBe(true)
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
    corrupt(dbPath, (db) => db.prepare(`UPDATE messages SET role = 'assistant' WHERE id = 'm-2'`).run())
    const report = await verify(dbPath, manifest)

    const digests = dim(report, 'field_digests')
    expect(digests.status).toBe('fail')
    expect(digests.diagnostics.some((d) => d.entityId === 'm-2' && d.code === 'FIELD_DIGEST_MISMATCH')).toBe(true)
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
      const row = db.prepare(`SELECT extra FROM messages WHERE id = 'm-1'`).get() as { extra: string }
      const extra = JSON.parse(row.extra)
      extra.model = { ...extra.model, id: 'tampered-model' }
      db.prepare(`UPDATE messages SET extra = ? WHERE id = 'm-1'`).run(JSON.stringify(extra))
    })
    const report = await verify(dbPath, manifest)

    const structured = dim(report, 'structured_json')
    expect(structured.status).toBe('fail')
    expect(
      structured.diagnostics.some(
        (d) => d.entityId === 'm-1' && d.fieldPath === 'overflow.model' && d.code === 'STRUCTURED_JSON_MISMATCH'
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
      db.prepare(`UPDATE messages SET sort_order = 1 WHERE id = 'm-1'`).run()
      db.prepare(`UPDATE messages SET sort_order = 0 WHERE id = 'm-2'`).run()
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
    corrupt(dbPath, (db) => db.prepare(`UPDATE message_blocks SET message_id = 'm-2' WHERE id = 'b-1'`).run())
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
      db.prepare(
        `UPDATE topic_segment_messages SET sort_order = 2 WHERE segment_id = 's-1' AND message_id = 'm-2'`
      ).run()
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
    corrupt(dbPath, (db) => db.prepare(`UPDATE messages SET topic_id = 'ghost' WHERE id = 'm-3'`).run())
    const report = await verify(dbPath, manifest)

    const fk = dim(report, 'fk_references')
    expect(fk.status).toBe('fail')
    expect(fk.diagnostics.some((d) => d.entityId === 'm-3' && d.code === 'FK_REFERENCE_BROKEN')).toBe(true)
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
    corrupt(dbPath, (db) => db.prepare(`UPDATE messages SET extra = '{invalid-json' WHERE id = 'm-1'`).run())
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
    expect(report.dimensions).toHaveLength(13)
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
    expect(report.dimensions).toHaveLength(13)
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
    expect(report.dimensions).toHaveLength(13)
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
