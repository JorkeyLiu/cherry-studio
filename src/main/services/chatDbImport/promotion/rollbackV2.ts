/**
 * v2 all-three rollback — restore the old generation deterministically
 * (Phase 2 L2 promotion, LOCK-PROMO-3/6).
 *
 * Restores ALL THREE live artifacts to the old generation retained before
 * any mutation:
 *
 *   1. db      — the retained chat.db snapshot restored to the live path
 *                (existing {@link rollbackInstall}, proof-guarded).
 *   2. files   — the retained Files snapshot restored to the live Files
 *                path (existing {@link restoreFilesRollbackSnapshot},
 *                snapshot NEVER consumed).
 *   3. catalog — the retained catalog snapshot restored through the
 *                renderer boundary with a SINGLE Dexie transaction
 *                replace-all.
 *
 * Each artifact is verified against the old-generation aggregate receipts
 * from the journal (`expectedOld`): a `null` receipt field means the old
 * generation had NO artifact, so the restored state must have none.
 *
 * The retained rollback snapshots are NEVER consumed or deleted
 * (LOCK-4434 analog). Any failure retains the journal, the retained
 * snapshots, and all facts for a deterministic retry.
 *
 * Main-only module. Not exposed over IPC/preload/renderer.
 */

import fs from 'node:fs'

import { loggerService } from '@logger'
import { DATA_PATH } from '@main/config'
import type { FilesCatalogSnapshotV1 } from '@shared/chatImport/types'

import { resolveLiveDbPath } from './artifactProbe'
import { computeDbReceipt } from './artifactReceipts'
import { readAndValidateCatalogSnapshot } from './catalogSnapshot'
import { computeLiveFilesReceipt, resolveLiveFilesDir, restoreFilesRollbackSnapshot } from './filesSnapshot'
import type { ClosedLiveProof } from './install'
import type { PromotionArtifactReceipts, PromotionJournalDbReceipt } from './journal'
import { rollbackInstall } from './rollback'

const logger = loggerService.withContext('chatDbImportRollbackV2')

/** Bounded all-three rollback failure codes. */
export type RollbackV2FailureCode =
  | 'DB_ROLLBACK_FAILED'
  | 'DB_RECEIPT_MISMATCH'
  | 'FILES_ROLLBACK_FAILED'
  | 'FILES_RECEIPT_MISMATCH'
  | 'CATALOG_SNAPSHOT_UNAVAILABLE'
  | 'CATALOG_RESTORE_FAILED'
  | 'CATALOG_FACTS_MISMATCH'

/** Result of {@link rollbackAllThree}. Never throws. */
export type RollbackV2Result =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: RollbackV2FailureCode; readonly safeCode: string | null }

/** Catalog restore boundary (renderer single-tx replace-all). */
export interface CatalogRestoreBoundary {
  restoreSnapshot(
    snapshot: FilesCatalogSnapshotV1
  ): Promise<
    | { readonly ok: true; readonly facts: { count: number; sha256: string } }
    | { readonly ok: false; readonly code: string }
  >
}

export interface RollbackV2Options {
  /** Verified single-use closed-live precondition token (LOCK-4427). */
  proof: ClosedLiveProof
  /** Controlled Data root. Defaults to DATA_PATH. */
  dataRoot?: string
  /** Catalog restore boundary (renderer single-tx replace-all). */
  catalogBoundary: CatalogRestoreBoundary
  /** Old-generation aggregate receipts from the journal. */
  expectedOld: PromotionArtifactReceipts
  /** Topics/segments sampled for rollback validation (default 3). */
  sampleCount?: number
}

function fail(code: RollbackV2FailureCode, safeCode: string | null): RollbackV2Result {
  logger.warn(`All-three rollback failed (${code}): ${safeCode ?? 'no sub-code'}`)
  return Object.freeze({ ok: false as const, code, safeCode })
}

/** Verify the restored live Files dir against the old receipt. */
function verifyFilesRestored(
  dataRoot: string,
  expectedFiles: PromotionArtifactReceipts['files']
): RollbackV2Result | null {
  if (expectedFiles !== null) {
    const liveFilesReceipt = computeLiveFilesReceipt(dataRoot)
    if (liveFilesReceipt === null) {
      return fail('FILES_RECEIPT_MISMATCH', 'LIVE_UNREADABLE')
    }
    if (
      liveFilesReceipt.count !== expectedFiles.count ||
      liveFilesReceipt.totalBytes !== expectedFiles.totalBytes ||
      liveFilesReceipt.sha256 !== expectedFiles.sha256
    ) {
      return fail('FILES_RECEIPT_MISMATCH', 'RECEIPT_DIVERGED')
    }
  } else {
    // The old generation had no Files dir — the restored live Files must
    // be missing or empty.
    try {
      const liveDir = resolveLiveFilesDir(dataRoot)
      if (fs.existsSync(liveDir)) {
        const names = fs.readdirSync(liveDir)
        if (names.length > 0) {
          return fail('FILES_RECEIPT_MISMATCH', 'EXPECTED_EMPTY_OLD_GENERATION')
        }
      }
    } catch {
      return fail('FILES_RECEIPT_MISMATCH', 'LIVE_UNREADABLE')
    }
  }
  return null
}

/**
 * Verify the restored live DB against the old db receipt (SHA-256 + byte
 * size). A `null` old db receipt is contradictory when the retained db
 * snapshot exists (restore is only ever chosen with a verified snapshot) —
 * fail closed rather than certify an unjournaled db.
 */
async function verifyDbRestored(
  dataRoot: string,
  expectedDb: PromotionJournalDbReceipt | null
): Promise<RollbackV2Result | null> {
  if (expectedDb === null) {
    return fail('DB_RECEIPT_MISMATCH', 'EXPECTED_NULL_OLD_GENERATION')
  }
  try {
    const liveDbReceipt = await computeDbReceipt(resolveLiveDbPath(dataRoot))
    if (liveDbReceipt.sha256 !== expectedDb.sha256 || liveDbReceipt.size !== expectedDb.size) {
      return fail('DB_RECEIPT_MISMATCH', 'RECEIPT_DIVERGED')
    }
  } catch {
    return fail('DB_RECEIPT_MISMATCH', 'LIVE_UNREADABLE')
  }
  return null
}

/** Verify the restored catalog facts against the old receipt. */
function verifyCatalogFacts(
  facts: { count: number; sha256: string },
  expectedCatalog: PromotionArtifactReceipts['catalog']
): RollbackV2Result | null {
  if (expectedCatalog !== null) {
    if (facts.count !== expectedCatalog.count || facts.sha256 !== expectedCatalog.sha256) {
      return fail('CATALOG_FACTS_MISMATCH', 'RECEIPT_DIVERGED')
    }
  } else if (facts.count !== 0) {
    return fail('CATALOG_FACTS_MISMATCH', 'EXPECTED_EMPTY_OLD_GENERATION')
  }
  return null
}

/**
 * Restore the full old generation: db → files → catalog, verifying each
 * against the journal old-generation receipts. Async (the catalog restore
 * crosses the renderer boundary).
 *
 * The retained catalog snapshot is read+validated FIRST so a permanently
 * unavailable snapshot fails BEFORE any live mutation (fail-fast — the live
 * db/files are never touched when the catalog cannot possibly converge).
 * Every later failure retains the journal, the retained snapshots, and all
 * facts for a deterministic retry (LOCK-REC-3).
 */
export async function rollbackAllThree(options: RollbackV2Options): Promise<RollbackV2Result> {
  const dataRoot = options.dataRoot ?? DATA_PATH
  const expectedOld = options.expectedOld

  // --- 0. Retained catalog snapshot pre-validated BEFORE any mutation ------
  // A missing/invalid catalog snapshot means all-old convergence is
  // impossible — fail before touching the live DB or Files.
  const catalogSnapshot = readAndValidateCatalogSnapshot(dataRoot)
  if (catalogSnapshot === null) {
    return fail('CATALOG_SNAPSHOT_UNAVAILABLE', 'SNAPSHOT_INVALID')
  }

  // --- 1. DB restore (proof-guarded; live must be closed) -----------------
  const dbResult = rollbackInstall({
    proof: options.proof,
    dataRoot,
    sampleCount: options.sampleCount
  })
  if (!dbResult.ok) {
    return fail('DB_ROLLBACK_FAILED', dbResult.code)
  }
  const dbCheck = await verifyDbRestored(dataRoot, expectedOld.db)
  if (dbCheck !== null) {
    return dbCheck
  }

  // --- 2. Files restore (snapshot never consumed) -------------------------
  const filesResult = restoreFilesRollbackSnapshot(dataRoot)
  if (!filesResult.ok) {
    return fail('FILES_ROLLBACK_FAILED', filesResult.code)
  }
  const filesCheck = verifyFilesRestored(dataRoot, expectedOld.files)
  if (filesCheck !== null) {
    return filesCheck
  }

  // --- 3. Catalog restore through the boundary ----------------------------
  let restoredFacts: { count: number; sha256: string }
  try {
    const result = await options.catalogBoundary.restoreSnapshot(catalogSnapshot)
    if (!result.ok) {
      return fail('CATALOG_RESTORE_FAILED', result.code)
    }
    restoredFacts = result.facts
  } catch (error) {
    return fail('CATALOG_RESTORE_FAILED', 'BOUNDARY_THREW')
  }

  // --- 4. Catalog facts verification ---------------------------------------
  const catalogCheck = verifyCatalogFacts(restoredFacts, expectedOld.catalog)
  if (catalogCheck !== null) {
    return catalogCheck
  }

  logger.info('All-three rollback verified (db + Files + catalog restored to the old generation)')
  return { ok: true }
}
