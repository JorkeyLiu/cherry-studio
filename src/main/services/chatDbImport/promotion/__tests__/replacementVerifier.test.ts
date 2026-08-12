/**
 * verifyReplacement tests — real FS + real better-sqlite3
 * (Phase 4.4.2, LOCK-4424).
 *
 * Covers:
 * - Success: identity proven before AND after the full DB gate sequence.
 * - Receipt gates: forged (unbranded) receipts and live-path mismatches.
 * - Identity gates: missing live file, swapped file object (new inode).
 * - DB gates over the live path: open, integrity, FK, exact migration
 *   compatibility, application sample reads — all injected in place so
 *   the file object identity (dev/ino) is preserved and only the DB gate
 *   fires.
 * - TOCTOU close: identity re-check after validation catches a swap that
 *   happens between the DB gates and the final stat.
 * - Verifier is a pure verdict: it never mutates the live file.
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
import { drizzle } from 'drizzle-orm/better-sqlite3'

import {
  acquirePromotionLease,
  createMaintenanceCoordinator,
  type MaintenanceCoordinator,
  type PromotionLeaseHandle
} from '../../../chatDb/maintenanceCoordination'
import { runMigrations } from '../../../chatDb/migration'
import { MESSAGE_BLOCKS_FTS_TABLE, MESSAGE_BLOCKS_NORMALIZED_TABLE } from '../../../chatDb/migration'
import * as schema from '../../../chatDb/schema'
import { CANDIDATE_DB_FILENAME, CANDIDATE_ROOT_DIRNAME } from '../../candidateDb'
import { NAVIGATION_PROJECTION_STATE_KEY } from '../../navigationProjection'
import type { InstallReceipt } from '../install'
import { installCandidate, mintClosedLiveProof } from '../install'
import type { ReplacementVerificationResult } from '../replacementVerifier'
import { verifyReplacement } from '../replacementVerifier'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const CANDIDATE_ID = 'candidate-session-1'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-replacement-verify-'))
}

/** Create + migrate + seed a sealed chat.db (WAL mode, closed handle). */
function makeSealedDb(dbPath: string): void {
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
      ('m-1', 't-1', 'user', 'hello', 'success', NULL, NULL, NULL, 'a-1', '2020-01-01T00:00:01.000Z', '2020-01-01T00:00:01.000Z', 0, '{}');
    INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES
      ('b-1', 'm-1', 'main_text', 'hi', 'success', '2020-01-01T00:00:01.000Z', '2020-01-01T00:00:01.000Z', 0, '{}');
    INSERT INTO topic_segments (id, topic_id, name, created_at, updated_at, sort_order, extra) VALUES
      ('s-1', 't-1', 'Segment 1', '2020-01-02T00:00:00.000Z', '2020-01-02T00:00:00.000Z', 0, '{}');
    INSERT INTO topic_segment_messages (segment_id, message_id, sort_order) VALUES ('s-1', 'm-1', 0);
  `)
  sqlite.close()
}

/** Mutate the LIVE db in place (FKs off) — preserves the file object (ino). */
function mutateLive(livePath: string, fn: (db: Database.Database) => void): void {
  const db = new Database(livePath)
  db.pragma('foreign_keys = OFF')
  fn(db)
  db.close()
}

/** Insert the pending navigation projection row into the LIVE db in place. */
function insertProjectionRow(livePath: string, value: string): void {
  mutateLive(livePath, (db) => {
    db.prepare(`INSERT INTO migration_state (key, value, updated_at) VALUES (?, ?, ?)`).run(
      NAVIGATION_PROJECTION_STATE_KEY,
      value,
      '2020-01-01T00:00:00.000Z'
    )
  })
}

/** Minimal valid v1 projection JSON (matches the production encoder shape). */
const VALID_PROJECTION_JSON = JSON.stringify({
  version: 1,
  sourcePersistVersion: null,
  assistants: [],
  topics: [],
  recoveredTopicIds: []
})

/**
 * Overwrite the root b-tree page of one named index with a structurally
 * VALID but EMPTY leaf-index page (same technique as the snapshot tests):
 * integrity_check deterministically reports missing index rows. In-place
 * write — the file object identity (dev/ino) is preserved.
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
  page[0] = 0x0a
  page.writeUInt16BE(0, 1)
  page.writeUInt16BE(0, 3)
  page.writeUInt16BE(pageSize & 0xffff, 5)
  const fd = realFs.openSync(dbPath, 'r+')
  realFs.writeSync(fd, page, 0, pageSize, (row!.rootpage - 1) * pageSize)
  realFs.closeSync(fd)
}

/** Replace the live file with a byte-identical copy → NEW file object (ino). */
function swapLiveFileObject(livePath: string): void {
  const clonePath = `${livePath}.clone`
  realFs.copyFileSync(livePath, clonePath)
  realFs.rmSync(livePath)
  realFs.renameSync(clonePath, livePath)
}

describe('verifyReplacement', () => {
  let dataRoot: string
  let livePath: string
  let coordinator: MaintenanceCoordinator
  let authorization: PromotionLeaseHandle
  let receipt: InstallReceipt

  beforeEach(() => {
    dataRoot = makeTempDir()
    livePath = realPath.join(dataRoot, 'chat.db')

    // Old live DB (closed) + sealed owned candidate, then a REAL install so
    // every test verifies against a genuine branded receipt.
    makeSealedDb(livePath)
    const sourcePath = realPath.join(dataRoot, CANDIDATE_ROOT_DIRNAME, CANDIDATE_ID, CANDIDATE_DB_FILENAME)
    makeSealedDb(sourcePath)

    coordinator = createMaintenanceCoordinator()
    authorization = acquirePromotionLease(CANDIDATE_ID, coordinator)
    const minted = mintClosedLiveProof({
      authorization,
      witness: { isLiveClosed: () => true },
      coordinator
    })
    expect(minted.ok).toBe(true)
    if (!minted.ok) throw new Error('unreachable')
    const installed = installCandidate({ candidateId: CANDIDATE_ID, proof: minted.proof, dataRoot })
    expect(installed.ok).toBe(true)
    if (!installed.ok) throw new Error('unreachable')
    receipt = installed.receipt
  })

  afterEach(() => {
    vi.restoreAllMocks()
    realFs.rmSync(dataRoot, { recursive: true, force: true })
  })

  function run(extra?: Partial<Parameters<typeof verifyReplacement>[0]>): ReplacementVerificationResult {
    return verifyReplacement({ receipt, dataRoot, ...extra })
  }

  function expectFailure(result: ReplacementVerificationResult, code: string, safeCode?: string): void {
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe(code)
    if (safeCode !== undefined) expect(result.safeCode).toBe(safeCode)
  }

  // -------------------------------------------------------------------------
  // Success
  // -------------------------------------------------------------------------

  it('verifies the installed replacement: identity proven before and after all DB gates', () => {
    const before = realFs.statSync(livePath, { bigint: true })

    const result = run()

    expect(result.ok).toBe(true)
    // Pure verdict: the live file object is untouched by verification.
    const after = realFs.statSync(livePath, { bigint: true })
    expect(after.ino).toBe(before.ino)
    expect(after.size).toBe(before.size)
  })

  it('still verifies after a legitimate reopen-style in-place WAL cycle (identity is dev/ino, not size)', () => {
    // Simulate the authorized reopen: open, write nothing structural, close
    // (checkpoint). The file object identity is unchanged.
    mutateLive(livePath, () => {
      // no-op write cycle
    })
    expect(run().ok).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Receipt gates
  // -------------------------------------------------------------------------

  it('refuses a forged (unbranded) receipt', () => {
    const forged = {
      candidateId: CANDIDATE_ID,
      livePath,
      identity: receipt.identity,
      installedAtMs: receipt.installedAtMs
    } as InstallReceipt
    expectFailure(verifyReplacement({ receipt: forged, dataRoot }), 'RECEIPT_INVALID', 'UNRECOGNIZED')
  })

  it('refuses a receipt bound to a different live path', () => {
    const otherRoot = makeTempDir()
    try {
      expectFailure(verifyReplacement({ receipt, dataRoot: otherRoot }), 'RECEIPT_INVALID', 'LIVE_PATH_MISMATCH')
    } finally {
      realFs.rmSync(otherRoot, { recursive: true, force: true })
    }
  })

  // -------------------------------------------------------------------------
  // Identity gates (before DB gates)
  // -------------------------------------------------------------------------

  it('fails with LIVE_STAT_FAILED when the live file is missing', () => {
    realFs.rmSync(livePath)
    expectFailure(run(), 'LIVE_STAT_FAILED', 'ENOENT')
  })

  it('fails with LIVE_IDENTITY_MISMATCH when the live file is a different file object', () => {
    swapLiveFileObject(livePath)
    expectFailure(run(), 'LIVE_IDENTITY_MISMATCH', 'STAT_IDENTITY_DIVERGED')
  })

  // -------------------------------------------------------------------------
  // DB gates (in-place damage — identity preserved so only the gate fires)
  // -------------------------------------------------------------------------

  it('fails with REPLACEMENT_OPEN_FAILED when the live file cannot be opened', () => {
    realFs.chmodSync(livePath, 0o000)
    try {
      expectFailure(run(), 'REPLACEMENT_OPEN_FAILED')
    } finally {
      realFs.chmodSync(livePath, 0o644)
    }
  })

  it('fails with REPLACEMENT_INTEGRITY_FAILED for structural damage', () => {
    corruptIndexToEmptyPage(livePath, 'messages_topic_id_sort_order_idx')
    expectFailure(run(), 'REPLACEMENT_INTEGRITY_FAILED')
  })

  it('fails with REPLACEMENT_FOREIGN_KEYS_FAILED for an FK violation', () => {
    mutateLive(livePath, (db) => {
      db.prepare(`INSERT INTO messages (id, topic_id, sort_order) VALUES ('m-orphan', 't-missing', 0)`).run()
    })
    expectFailure(run(), 'REPLACEMENT_FOREIGN_KEYS_FAILED')
  })

  it('fails with REPLACEMENT_MIGRATION_INCOMPATIBLE when a migration key is missing', () => {
    mutateLive(livePath, (db) => {
      db.prepare(`DELETE FROM migration_state WHERE key = '002_corrective_schema'`).run()
    })
    expectFailure(run(), 'REPLACEMENT_MIGRATION_INCOMPATIBLE', 'MIGRATION_KEY_MISSING')
  })

  it('fails with REPLACEMENT_MIGRATION_INCOMPATIBLE for an ahead-of-schema migration key', () => {
    mutateLive(livePath, (db) => {
      db.prepare(
        `INSERT INTO migration_state (key, value, updated_at) VALUES ('999_future', '999_future', '2020-01-01T00:00:00.000Z')`
      ).run()
    })
    expectFailure(run(), 'REPLACEMENT_MIGRATION_INCOMPATIBLE', 'MIGRATION_KEY_UNKNOWN')
  })

  // -------------------------------------------------------------------------
  // Pending navigation projection row (LOCK-RV1/RV2) — the exact one-shot
  // operational key is allowed to survive migration compatibility until the
  // renderer durable apply+ack; every other unknown key still rejects.
  // -------------------------------------------------------------------------

  it('verifies the installed replacement with the pending navigation projection row present', () => {
    insertProjectionRow(livePath, VALID_PROJECTION_JSON)
    expect(run().ok).toBe(true)
  })

  it('keeps the migration gate payload-agnostic: any value under the exact projection key stays compatible (payload validation belongs to the later durable apply path)', () => {
    insertProjectionRow(livePath, 'not-json-at-all')
    expect(run().ok).toBe(true)
  })

  it('fails with REPLACEMENT_MIGRATION_INCOMPATIBLE when an unknown key coexists with the projection key', () => {
    mutateLive(livePath, (db) => {
      db.prepare(
        `INSERT INTO migration_state (key, value, updated_at) VALUES ('999_future', '999_future', '2020-01-01T00:00:00.000Z')`
      ).run()
    })
    insertProjectionRow(livePath, VALID_PROJECTION_JSON)
    expectFailure(run(), 'REPLACEMENT_MIGRATION_INCOMPATIBLE', 'MIGRATION_KEY_UNKNOWN')
  })

  it('fails with REPLACEMENT_SAMPLE_READ_FAILED when application-layer reads break', () => {
    mutateLive(livePath, (db) => {
      db.exec('DROP TABLE topic_segment_messages')
    })
    expectFailure(run(), 'REPLACEMENT_SAMPLE_READ_FAILED')
  })

  // -------------------------------------------------------------------------
  // Derived search projection gate (LOCK-SP-5/7) — migration_state stays
  // recorded, so the migration gate passes and ONLY the lightweight
  // `search-projection` gate fires.
  // -------------------------------------------------------------------------

  it('rejects migration_state-003-with-missing-objects: REPLACEMENT_SEARCH_PROJECTION_FAILED when the FTS table is dropped', () => {
    mutateLive(livePath, (db) => {
      db.exec(`DROP TABLE ${MESSAGE_BLOCKS_FTS_TABLE}`)
    })
    expectFailure(run(), 'REPLACEMENT_SEARCH_PROJECTION_FAILED', 'OBJECT_MISSING_MESSAGE_BLOCKS_FTS')
  })

  it('rejects migration_state-003-with-missing-objects: REPLACEMENT_SEARCH_PROJECTION_FAILED when the normalized table is dropped', () => {
    mutateLive(livePath, (db) => {
      db.exec(`DROP TABLE ${MESSAGE_BLOCKS_NORMALIZED_TABLE}`)
    })
    expectFailure(run(), 'REPLACEMENT_SEARCH_PROJECTION_FAILED', 'OBJECT_MISSING_MESSAGE_BLOCKS_NORMALIZED')
  })

  it('rejects a partial/empty FTS via count parity (REPLACEMENT_SEARCH_PROJECTION_FAILED, COUNT_MISMATCH)', () => {
    mutateLive(livePath, (db) => {
      db.exec(`DELETE FROM ${MESSAGE_BLOCKS_FTS_TABLE} WHERE block_id = 'b-1'`)
    })
    expectFailure(run(), 'REPLACEMENT_SEARCH_PROJECTION_FAILED', 'COUNT_MISMATCH')
  })

  it('rejects a wrong normalized message_id via messageId parity (MESSAGE_ID_MISMATCH)', () => {
    mutateLive(livePath, (db) => {
      db.prepare(`UPDATE ${MESSAGE_BLOCKS_NORMALIZED_TABLE} SET message_id = 'm-ghost' WHERE block_id = 'b-1'`).run()
    })
    expectFailure(run(), 'REPLACEMENT_SEARCH_PROJECTION_FAILED', 'MESSAGE_ID_MISMATCH')
  })

  it('still verifies the pristine replacement through the new gate (search-projection passes)', () => {
    // The pristine live DB is trigger-maintained by the current migrations
    // (migration-004 generation): the derived objects + counts + messageId
    // parity + MATCH smoke all pass.
    expect(run().ok).toBe(true)
  })

  // -------------------------------------------------------------------------
  // TOCTOU close — identity re-check after validation
  // -------------------------------------------------------------------------

  it('fails with POST_VALIDATION_IDENTITY_MISMATCH when the file is swapped after the DB gates', () => {
    const result = run({
      onAfterDbValidation: () => swapLiveFileObject(livePath)
    })
    expectFailure(result, 'POST_VALIDATION_IDENTITY_MISMATCH', 'STAT_IDENTITY_DIVERGED')
  })

  it('fails with POST_VALIDATION_STAT_FAILED when the file disappears after the DB gates', () => {
    const result = run({
      onAfterDbValidation: () => realFs.rmSync(livePath)
    })
    expectFailure(result, 'POST_VALIDATION_STAT_FAILED', 'ENOENT')
  })
})
