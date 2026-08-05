/**
 * v2 all-three rollback direct tests (LOCK-REC-3).
 *
 * Real FS + real better-sqlite3 (same house style as rollback.test.ts) so
 * the restored DB is a genuine migrated chat.db, the restored Files dir is a
 * genuine snapshot restore, and the retained catalog snapshot is a genuine
 * durable snapshot file.
 *
 * Coverage:
 * - Success: db + Files + catalog all restored to the OLD generation and
 *   verified against the journal old receipts EXACTLY (db SHA-256/size,
 *   Files count/totalBytes/SHA-256, catalog count/SHA-256); retained
 *   snapshots preserved (never consumed).
 * - Fail-fast: an unavailable catalog snapshot fails BEFORE any live
 *   mutation (db and Files untouched).
 * - Failures at each artifact: DB_ROLLBACK_FAILED, DB_RECEIPT_MISMATCH,
 *   FILES_ROLLBACK_FAILED, FILES_RECEIPT_MISMATCH, CATALOG_RESTORE_FAILED,
 *   CATALOG_FACTS_MISMATCH, boundary throw.
 * - Retry after failure: the second attempt (fresh proof) converges.
 * - Retained snapshots preserved on every failure path.
 * - Privacy: bounded failure codes only.
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

import {
  acquirePromotionLease,
  createMaintenanceCoordinator,
  type MaintenanceCoordinator,
  type PromotionLeaseHandle
} from '@main/services/chatDb/maintenanceCoordination'
import { runMigrations } from '@main/services/chatDb/migration'
import * as schema from '@main/services/chatDb/schema'
import type { FilesCatalogSnapshotRow } from '@shared/chatImport/types'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import { computeDbReceipt } from '../artifactReceipts'
import { buildCatalogSnapshotWire, writeCatalogSnapshotDurable } from '../catalogSnapshot'
import { prepareFilesRollbackSnapshot } from '../filesSnapshot'
import type { ClosedLiveProof } from '../install'
import { mintClosedLiveProof } from '../install'
import type { PromotionArtifactReceipts } from '../journal'
import { FILES_ROLLBACK_SNAPSHOT_DIRNAME, ROLLBACK_SNAPSHOT_FILENAME } from '../journal'
import type { RollbackV2Result } from '../rollbackV2'
import { rollbackAllThree } from '../rollbackV2'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const CANDIDATE_ID = 'candidate-session-1'
const OLD_PAYLOAD_NAME = 'old-a.txt'
const OLD_PAYLOAD_CONTENT = 'old-a-content'
const NEW_PAYLOAD_NAME = 'new-a.txt'
const NEW_PAYLOAD_CONTENT = 'new-a-content'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-rollbackv2-'))
}

/** Create + migrate + seed a chat.db, then close (candidate/broken state). */
function makeSealedDb(dbPath: string, topicCount: number): void {
  realFs.mkdirSync(realPath.dirname(dbPath), { recursive: true })
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  runMigrations(db, sqlite)
  for (let i = 0; i < topicCount; i++) {
    sqlite
      .prepare(
        `INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra)
         VALUES (?, 'a-1', ?, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL, '{}')`
      )
      .run(`t-${i}`, `Topic ${i}`)
  }
  sqlite.pragma('wal_checkpoint(TRUNCATE)')
  sqlite.close()
}

/** Old-generation db snapshot with full message data. */
function makeSealedDbWithData(dbPath: string, topicCount: number): void {
  realFs.mkdirSync(realPath.dirname(dbPath), { recursive: true })
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  runMigrations(db, sqlite)
  sqlite.exec(`
    INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra) VALUES
      ('t-1', 'a-1', 'Topic 1', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL, '{}'),
      ('t-2', 'a-1', 'Topic 2', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL, '{}');
    INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES
      ('m-1', 't-1', 'user', 'hello', 'success', NULL, NULL, NULL, 'a-1', '2020-01-01T00:00:01.000Z', '2020-01-01T00:00:01.000Z', 0, '{}'),
      ('m-2', 't-1', 'assistant', 'world', 'success', NULL, NULL, NULL, 'a-1', '2020-01-01T00:00:02.000Z', '2020-01-01T00:00:02.000Z', 1, '{}');
    INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES
      ('b-1', 'm-1', 'main_text', 'hi', 'success', '2020-01-01T00:00:01.000Z', '2020-01-01T00:00:01.000Z', 0, '{}');
    INSERT INTO topic_segments (id, topic_id, name, created_at, updated_at, sort_order, extra) VALUES
      ('s-1', 't-1', 'Segment 1', '2020-01-02T00:00:00.000Z', '2020-01-02T00:00:00.000Z', 0, '{}');
    INSERT INTO topic_segment_messages (segment_id, message_id, sort_order) VALUES
      ('s-1', 'm-1', 0);
  `)
  for (let i = 3; i <= topicCount; i++) {
    sqlite
      .prepare(
        `INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra)
         VALUES (?, 'a-1', ?, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL, '{}')`
      )
      .run(`t-${i}`, `Topic ${i}`)
  }
  sqlite.pragma('wal_checkpoint(TRUNCATE)')
  sqlite.close()
}

function countTopics(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  const row = db.prepare('SELECT count(*) AS c FROM topics').get() as { c: number }
  db.close()
  return row.c
}

function sha(hex: string): string {
  return hex.repeat(64)
}

/** One old-generation catalog row (valid FilesCatalogSnapshotRow shape). */
function oldCatalogRow(dataRoot: string): FilesCatalogSnapshotRow {
  const size = Buffer.byteLength(OLD_PAYLOAD_CONTENT, 'utf8')
  return {
    id: 'old-a',
    name: OLD_PAYLOAD_NAME,
    origin_name: OLD_PAYLOAD_NAME,
    path: realPath.join(dataRoot, 'Files', OLD_PAYLOAD_NAME),
    size,
    ext: '.txt',
    type: null,
    created_at: '2020-01-01T00:00:00.000Z',
    count: 1
  }
}

describe('rollbackAllThree (real FS)', () => {
  let dataRoot: string
  let livePath: string
  let retainedDbPath: string
  let retainedFilesDir: string
  let coordinator: MaintenanceCoordinator
  let authorization: PromotionLeaseHandle
  let liveClosed: boolean
  /** In-memory live catalog state for the boundary double. */
  let liveCatalogFacts: { count: number; sha256: string }
  let oldReceipts: PromotionArtifactReceipts
  let retainedDbBytesBefore: Buffer

  beforeEach(async () => {
    dataRoot = makeTempDir()
    livePath = realPath.join(dataRoot, 'chat.db')
    retainedDbPath = realPath.join(dataRoot, ROLLBACK_SNAPSHOT_FILENAME)
    retainedFilesDir = realPath.join(dataRoot, FILES_ROLLBACK_SNAPSHOT_DIRNAME)

    // Old generation live Files → retained snapshot.
    realFs.mkdirSync(realPath.join(dataRoot, 'Files'), { recursive: true })
    realFs.writeFileSync(realPath.join(dataRoot, 'Files', OLD_PAYLOAD_NAME), OLD_PAYLOAD_CONTENT, 'utf8')
    const filesSnapshot = prepareFilesRollbackSnapshot({ dataRoot })
    expect(filesSnapshot.ok).toBe(true)
    if (!filesSnapshot.ok) throw new Error('unreachable')

    // Old catalog snapshot (retained).
    const oldCatalog = buildCatalogSnapshotWire([oldCatalogRow(dataRoot)])
    const catalogWrite = writeCatalogSnapshotDurable(oldCatalog, dataRoot)
    expect(catalogWrite.ok).toBe(true)

    // Old db snapshot (retained).
    makeSealedDbWithData(retainedDbPath, 3)

    // Old-generation aggregate receipts (exactly what the journal would hold).
    oldReceipts = {
      db: await computeDbReceipt(retainedDbPath),
      files: filesSnapshot.receipt,
      catalog: { count: oldCatalog.integrity.count, sha256: oldCatalog.integrity.sha256 }
    }

    // Swap the live Files to the CANDIDATE generation (the broken state).
    realFs.rmSync(realPath.join(dataRoot, 'Files'), { recursive: true, force: true })
    realFs.mkdirSync(realPath.join(dataRoot, 'Files'), { recursive: true })
    realFs.writeFileSync(realPath.join(dataRoot, 'Files', NEW_PAYLOAD_NAME), NEW_PAYLOAD_CONTENT, 'utf8')

    // Live db = candidate/broken state (2 topics).
    makeSealedDb(livePath, 2)

    liveCatalogFacts = { count: 0, sha256: sha('0') }

    coordinator = createMaintenanceCoordinator()
    authorization = acquirePromotionLease(CANDIDATE_ID, coordinator)
    liveClosed = true

    retainedDbBytesBefore = realFs.readFileSync(retainedDbPath)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    try {
      realFs.rmSync(dataRoot, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  })

  function mintProof(): ClosedLiveProof {
    const minted = mintClosedLiveProof({
      authorization,
      witness: { isLiveClosed: () => liveClosed },
      coordinator
    })
    expect(minted.ok).toBe(true)
    if (!minted.ok) throw new Error('unreachable')
    return minted.proof
  }

  function run(expectedOld: PromotionArtifactReceipts = oldReceipts): Promise<RollbackV2Result> {
    return rollbackAllThree({
      proof: mintProof(),
      dataRoot,
      catalogBoundary: {
        restoreSnapshot: vi.fn(async (snapshot) => {
          liveCatalogFacts = { count: snapshot.integrity.count, sha256: snapshot.integrity.sha256 }
          return { ok: true as const, facts: liveCatalogFacts }
        })
      },
      expectedOld,
      sampleCount: 3
    })
  }

  function expectLiveDbOld(): void {
    expect(countTopics(livePath)).toBe(3)
  }

  function expectLiveFilesOld(): void {
    expect(realFs.existsSync(realPath.join(dataRoot, 'Files', OLD_PAYLOAD_NAME))).toBe(true)
    expect(realFs.existsSync(realPath.join(dataRoot, 'Files', NEW_PAYLOAD_NAME))).toBe(false)
  }

  function expectLiveFilesCandidate(): void {
    expect(realFs.existsSync(realPath.join(dataRoot, 'Files', NEW_PAYLOAD_NAME))).toBe(true)
    expect(realFs.existsSync(realPath.join(dataRoot, 'Files', OLD_PAYLOAD_NAME))).toBe(false)
  }

  function expectRetainedPreserved(): void {
    // db snapshot byte-identical.
    expect(realFs.readFileSync(retainedDbPath).equals(retainedDbBytesBefore)).toBe(true)
    // Files snapshot still present with a valid manifest.
    expect(realFs.existsSync(realPath.join(retainedFilesDir, 'manifest.json'))).toBe(true)
    // Catalog snapshot still present and readable.
    expect(realFs.existsSync(realPath.join(dataRoot, 'files-catalog.snapshot.json'))).toBe(true)
  }

  it('restores db + Files + catalog to the old generation and verifies all-old receipts exactly', async () => {
    const result = await run()
    expect(result.ok).toBe(true)

    expectLiveDbOld()
    expectLiveFilesOld()
    // The boundary received the retained catalog snapshot and its facts now
    // equal the old catalog receipt.
    expect(liveCatalogFacts).toEqual(oldReceipts.catalog)
    expectRetainedPreserved()
  })

  it('restores the absence of the Files generation when the old receipt is null', async () => {
    // Simulate an old generation with NO Files: receipt null and an empty
    // retained Files snapshot.
    realFs.rmSync(retainedFilesDir, { recursive: true, force: true })
    realFs.mkdirSync(retainedFilesDir, { recursive: true })
    realFs.writeFileSync(
      realPath.join(retainedFilesDir, 'manifest.json'),
      JSON.stringify({
        version: 1,
        capturedAt: '2020-01-01T00:00:00.000Z',
        kind: 'empty',
        entries: [],
        integrity: {
          count: 0,
          totalBytes: 0,
          sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
        }
      }),
      'utf8'
    )
    const emptyOld: PromotionArtifactReceipts = { ...oldReceipts, files: null }
    const result = await run(emptyOld)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The old generation had NO Files dir — the live Files path must be
    // ABSENT after rollback (audit F5 exact absence), not present-empty.
    expect(realFs.existsSync(realPath.join(dataRoot, 'Files'))).toBe(false)
    expectLiveDbOld()
  })

  it('fails fast with CATALOG_SNAPSHOT_UNAVAILABLE BEFORE any live mutation', async () => {
    realFs.rmSync(realPath.join(dataRoot, 'files-catalog.snapshot.json'))
    const result = await run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('CATALOG_SNAPSHOT_UNAVAILABLE')
    // No mutation happened: db and Files still candidate.
    expect(countTopics(livePath)).toBe(2)
    expectLiveFilesCandidate()
    // The OTHER retained snapshots are untouched (the catalog snapshot was
    // deliberately removed to provoke the failure).
    expect(realFs.readFileSync(retainedDbPath).equals(retainedDbBytesBefore)).toBe(true)
    expect(realFs.existsSync(realPath.join(retainedFilesDir, 'manifest.json'))).toBe(true)
  })

  it('fails with DB_ROLLBACK_FAILED when the retained db snapshot is missing', async () => {
    realFs.rmSync(retainedDbPath)
    const result = await run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('DB_ROLLBACK_FAILED')
    expect(countTopics(livePath)).toBe(2)
  })

  it('fails with DB_RECEIPT_MISMATCH when the restored db diverges from the old db receipt', async () => {
    const tampered: PromotionArtifactReceipts = { ...oldReceipts, db: { sha256: sha('9'), size: 1 } }
    const result = await run(tampered)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('DB_RECEIPT_MISMATCH')
    expect(result.safeCode).toBe('RECEIPT_DIVERGED')
    // The db was restored, but no success signal and no convergence claim.
    expectLiveDbOld()
    expectRetainedPreserved()
  })

  it('fails with FILES_ROLLBACK_FAILED when the retained Files snapshot is invalid', async () => {
    realFs.rmSync(realPath.join(retainedFilesDir, 'manifest.json'))
    const result = await run()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('FILES_ROLLBACK_FAILED')
    // db was already restored; Files stayed candidate; journal retained.
    expectLiveDbOld()
    expectLiveFilesCandidate()
    // The db and catalog snapshots remain untouched (the Files manifest was
    // deliberately removed to provoke the failure).
    expect(realFs.readFileSync(retainedDbPath).equals(retainedDbBytesBefore)).toBe(true)
    expect(realFs.existsSync(realPath.join(dataRoot, 'files-catalog.snapshot.json'))).toBe(true)
  })

  it('fails with FILES_RECEIPT_MISMATCH when the restored Files diverge from the old files receipt', async () => {
    const tampered: PromotionArtifactReceipts = {
      ...oldReceipts,
      files: { count: 99, totalBytes: 99, sha256: sha('8') }
    }
    const result = await run(tampered)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('FILES_RECEIPT_MISMATCH')
    expectLiveFilesOld()
    expectRetainedPreserved()
  })

  it('fails with CATALOG_RESTORE_FAILED when the boundary rejects the restore', async () => {
    const result = await rollbackAllThree({
      proof: mintProof(),
      dataRoot,
      catalogBoundary: {
        restoreSnapshot: vi.fn(async () => ({ ok: false as const, code: 'RENDERER_FAILED' }))
      },
      expectedOld: oldReceipts,
      sampleCount: 3
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('CATALOG_RESTORE_FAILED')
    expect(result.safeCode).toBe('RENDERER_FAILED')
    expectRetainedPreserved()
  })

  it('fails with CATALOG_RESTORE_FAILED BOUNDARY_THREW when the boundary throws', async () => {
    const result = await rollbackAllThree({
      proof: mintProof(),
      dataRoot,
      catalogBoundary: {
        restoreSnapshot: vi.fn(async () => {
          throw new Error('boundary exploded')
        })
      },
      expectedOld: oldReceipts,
      sampleCount: 3
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('CATALOG_RESTORE_FAILED')
    expect(result.safeCode).toBe('BOUNDARY_THREW')
    expectRetainedPreserved()
  })

  it('fails with CATALOG_FACTS_MISMATCH when the boundary returns divergent facts', async () => {
    const result = await rollbackAllThree({
      proof: mintProof(),
      dataRoot,
      catalogBoundary: {
        restoreSnapshot: vi.fn(async () => ({ ok: true as const, facts: { count: 99, sha256: sha('7') } }))
      },
      expectedOld: oldReceipts,
      sampleCount: 3
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('CATALOG_FACTS_MISMATCH')
    expect(result.safeCode).toBe('RECEIPT_DIVERGED')
    expectRetainedPreserved()
  })

  it('retries deterministically after a boundary failure (fresh proof, converges)', async () => {
    // First attempt: the boundary rejects.
    const first = await rollbackAllThree({
      proof: mintProof(),
      dataRoot,
      catalogBoundary: {
        restoreSnapshot: vi.fn(async () => ({ ok: false as const, code: 'RENDERER_FAILED' }))
      },
      expectedOld: oldReceipts,
      sampleCount: 3
    })
    expect(first.ok).toBe(false)
    expectRetainedPreserved()

    // Second attempt: fresh proof, boundary succeeds — idempotent restore.
    const second = await run()
    expect(second.ok).toBe(true)
    expectLiveDbOld()
    expectLiveFilesOld()
    expectRetainedPreserved()
  })

  it('preserves every retained snapshot on failure paths', async () => {
    const failures: Array<Promise<RollbackV2Result>> = [
      run({ ...oldReceipts, db: { sha256: sha('6'), size: 7 } }),
      rollbackAllThree({
        proof: mintProof(),
        dataRoot,
        catalogBoundary: { restoreSnapshot: vi.fn(async () => ({ ok: false as const, code: 'TIMEOUT' })) },
        expectedOld: oldReceipts,
        sampleCount: 3
      })
    ]
    for (const resultPromise of failures) {
      const result = await resultPromise
      expect(result.ok).toBe(false)
      expectRetainedPreserved()
    }
  })

  it('returns privacy-bounded failure codes only', async () => {
    realFs.rmSync(realPath.join(dataRoot, 'files-catalog.snapshot.json'))
    const result = await run()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const raw = JSON.stringify(result)
      expect(raw).not.toContain(dataRoot)
      expect(raw).not.toContain('chat.db')
      expect(raw).not.toContain('import')
      expect(result.code).toMatch(/^[A-Z_]+$/)
      expect(result.safeCode).toMatch(/^[A-Z0-9_]+$/)
    }
  })
})
