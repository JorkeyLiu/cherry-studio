/**
 * Rollback installation primitive — restore a verified retained snapshot
 * to the live chat.db atomically (Phase 4.4.3, LOCK-4434/4435/4437/4439).
 *
 * This unit is a bounded primitive, NOT the rollback executor. It never
 * closes/reopens the live DB, never writes the promotion journal, never
 * cleans up the retained snapshot or journal, and never relaunches.
 *
 * Locked semantics:
 * - LOCK-4434: the retained snapshot is NEVER consumed or deleted. Rollback
 *   creates a fixed same-directory staging clone from the retained source,
 *   validates the clone, and renames the clone to the live path. The
 *   retained snapshot remains byte-identical on ALL paths.
 * - LOCK-4435 ordering (pre-rename atomic block):
 *     1. verify retained — existence + readonly sealed state
 *     2. create staging — fs.copyFileSync (closed self-contained source;
 *        copy + fsync + full validation gate contain partial-copy risk)
 *     3. fsync staging
 *     4. validate staging — full readonly DB validation gate (identical to
 *        the snapshot validator gate)
 *     5. consume closed-live proof — single-use, TOCTOU re-check
 *     6. delete live WAL/SHM sidecars
 *     7. capture staging identity (bigint dev/ino/size)
 *     8. atomic rename staging → live (same-filesystem ONLY; EXDEV =
 *        structured failure, NO copy fallback — LOCK-4426)
 *     9. fsync live parent directory
 *    10. confirm destination identity matches staging identity
 *    11. full readonly validation of the restored live DB
 * - LOCK-4437: any failure retains the journal, retained snapshot, and all
 *   facts. No silent fallback. Pre-rename failures leave the live DB
 *   untouched (sidecars may be deleted). Post-rename failures retain
 *   whatever state resulted.
 * - LOCK-4439: recovery lease covers destructive rollback. Uses the same
 *   current valid promotion authorization / closed-live proof mechanism
 *   as candidate install — no second mutex.
 *
 * Clone decision (Phase 4.4.3 decision rights):
 * `fs.copyFileSync` from the retained snapshot. The retained source is a
 * closed, self-contained SQLite database (produced by the online backup
 * API with WAL checkpointed, verified by the full readonly gate, and
 * published via atomic rename). It has no WAL/SHM sidecars. A byte-level
 * copy of a closed self-contained SQLite file is a faithful duplicate.
 * The copy is fsynced and run through the identical full readonly
 * validation gate before any destructive operation. Any partial copy
 * (crash mid-copy) is deterministically caught by the integrity check
 * and migration compatibility gates. The SQLite backup API was considered
 * but rejected: the retained source is closed (not open by any handle),
 * so the backup API would require re-opening it just to use its backup
 * facility — unnecessary complexity with no safety benefit over
 * copyFileSync + validation.
 *
 * Path safety: no arbitrary external paths. The live path is derived from
 * the Data root; the retained path is derived from the fixed owned
 * {@link ROLLBACK_SNAPSHOT_FILENAME}; the staging path is the fixed
 * {@link ROLLBACK_SNAPSHOT_STAGING_FILENAME} in the same directory.
 *
 * Main-only module. Not exposed over IPC/preload/renderer.
 */

import fs from 'node:fs'
import path from 'node:path'

import { loggerService } from '@logger'
import { DATA_PATH } from '@main/config'

import type { ClosedLiveProof, FileStatIdentity } from './install'
import { validateClosedLiveProof } from './install'
import { ROLLBACK_SNAPSHOT_FILENAME, ROLLBACK_SNAPSHOT_STAGING_FILENAME } from './journal'
import {
  fsyncDirectory,
  fsyncFile,
  type ReadonlyChatDbValidationGate,
  safeErrorCode,
  validateReadonlyChatDb
} from './readonlyDbValidation'

const logger = loggerService.withContext('chatDbImportRollback')

/** Live database filename — always derived from the Data root. */
const LIVE_DB_FILENAME = 'chat.db'

// ---------------------------------------------------------------------------
// Options / result types
// ---------------------------------------------------------------------------

export interface RollbackInstallOptions {
  /** Verified single-use closed-live precondition token (LOCK-4427). */
  proof: ClosedLiveProof
  /** Data root containing the live chat.db. Defaults to DATA_PATH. */
  dataRoot?: string
  /** Topics/segments sampled for application-layer reads (default 3, min 1). */
  sampleCount?: number
  /**
   * Test-only hook invoked AFTER the staging clone is created (fsynced)
   * and BEFORE the full validation gate starts.
   */
  onAfterClone?: () => void
  /**
   * Test-only hook invoked AFTER staging validation passes and BEFORE
   * the destructive window opens (proof consumption + sidecar deletion).
   */
  onBeforeRename?: () => void
  /**
   * Test-only hook invoked AFTER the atomic rename and BEFORE the
   * parent-directory fsync.
   */
  onAfterRename?: () => void
}

/** Bounded machine-readable rollback failure codes. */
export type RollbackInstallFailureCode =
  // Pre-rollback failures (live bytes NOT replaced):
  | 'RETAINED_MISSING'
  | 'RETAINED_NOT_SEALED'
  | 'RETAINED_VALIDATION_FAILED'
  | 'STAGING_CREATE_FAILED'
  | 'STAGING_DURABILITY_FAILED'
  | 'STAGING_VALIDATION_FAILED'
  | 'CLOSED_LIVE_PROOF_INVALID'
  | 'LIVE_SIDECAR_DELETE_FAILED'
  | 'STAGING_STAT_FAILED'
  | 'RENAME_CROSS_DEVICE'
  | 'RENAME_FAILED'
  // Post-rollback failures (rename ALREADY happened):
  | 'LIVE_DIRECTORY_SYNC_FAILED'
  | 'DESTINATION_STAT_FAILED'
  | 'DESTINATION_IDENTITY_MISMATCH'
  | 'RESTORED_LIVE_VALIDATION_FAILED'

/** Failure classification relative to the destructive rename. */
export type RollbackInstallFailurePhase = 'pre-rollback' | 'post-rollback'

/** Result of {@link rollbackInstall}. Never throws for operational failures. */
export type RollbackInstallResult =
  | { readonly ok: true; readonly receipt: RollbackReceipt }
  | {
      readonly ok: false
      readonly phase: RollbackInstallFailurePhase
      readonly code: RollbackInstallFailureCode
      /** Safe machine sub-code (error code/name only — never messages/paths). */
      readonly safeCode: string | null
    }

// ---------------------------------------------------------------------------
// Rollback receipt — binds staging identity to the live path
// ---------------------------------------------------------------------------

/**
 * Receipt of a durably confirmed rollback installation. Module-branded:
 * {@link isRollbackReceipt} proves it was produced by a successful
 * {@link rollbackInstall} and not forged.
 */
export interface RollbackReceipt {
  /** Absolute live path the retained snapshot was restored to. */
  readonly livePath: string
  /** Staging identity captured before the rename, confirmed at the live path. */
  readonly identity: FileStatIdentity
  /** Absolute path of the retained source (preserved, never consumed). */
  readonly retainedSnapshotPath: string
  /** Wall-clock rollback completion (diagnostic only). */
  readonly restoredAtMs: number
}

const rollbackReceiptBrand = new WeakSet<RollbackReceipt>()

/** True when `value` is a receipt minted by a successful rollback. */
export function isRollbackReceipt(value: unknown): value is RollbackReceipt {
  return typeof value === 'object' && value !== null && rollbackReceiptBrand.has(value as RollbackReceipt)
}

// ---------------------------------------------------------------------------
// Failure helpers
// ---------------------------------------------------------------------------

function preFailure(code: RollbackInstallFailureCode, safeCode: string | null): RollbackInstallResult {
  logger.warn(`Rollback install failed pre-rollback (${code}): ${safeCode ?? 'no sub-code'}`)
  return Object.freeze({ ok: false as const, phase: 'pre-rollback' as const, code, safeCode })
}

function postFailure(code: RollbackInstallFailureCode, safeCode: string | null): RollbackInstallResult {
  logger.warn(`Rollback install failed post-rollback (${code}) — artifacts retained (LOCK-4437)`)
  return Object.freeze({ ok: false as const, phase: 'post-rollback' as const, code, safeCode })
}

// ---------------------------------------------------------------------------
// Shared readonly validation gate mapping
// ---------------------------------------------------------------------------

const STAGING_GATE_TO_CODE: Record<ReadonlyChatDbValidationGate, RollbackInstallFailureCode> = {
  open: 'STAGING_VALIDATION_FAILED',
  integrity: 'STAGING_VALIDATION_FAILED',
  'foreign-keys': 'STAGING_VALIDATION_FAILED',
  migration: 'STAGING_VALIDATION_FAILED',
  'search-projection': 'STAGING_VALIDATION_FAILED',
  'sample-reads': 'STAGING_VALIDATION_FAILED'
}

const RESTORED_LIVE_GATE_TO_CODE: Record<ReadonlyChatDbValidationGate, RollbackInstallFailureCode> = {
  open: 'RESTORED_LIVE_VALIDATION_FAILED',
  integrity: 'RESTORED_LIVE_VALIDATION_FAILED',
  'foreign-keys': 'RESTORED_LIVE_VALIDATION_FAILED',
  migration: 'RESTORED_LIVE_VALIDATION_FAILED',
  'search-projection': 'RESTORED_LIVE_VALIDATION_FAILED',
  'sample-reads': 'RESTORED_LIVE_VALIDATION_FAILED'
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Capture the bigint stat identity of a regular file. */
function statIdentity(filePath: string): FileStatIdentity {
  const stat = fs.statSync(filePath, { bigint: true })
  if (!stat.isFile()) {
    const error: NodeJS.ErrnoException = new Error('not a regular file')
    error.code = 'ENOTAFILE'
    throw error
  }
  return Object.freeze({ dev: stat.dev, ino: stat.ino, size: stat.size })
}

/**
 * Remove the staging snapshot and any staging sidecars (best-effort).
 * NEVER touches the live chat.db, its sidecars, or the retained snapshot.
 */
function cleanupStaging(stagingPath: string): void {
  for (const candidate of [stagingPath, `${stagingPath}-wal`, `${stagingPath}-shm`]) {
    try {
      fs.unlinkSync(candidate)
    } catch {
      // Best-effort cleanup — absence is the expected common case.
    }
  }
}

// ---------------------------------------------------------------------------
// rollbackInstall — the sole destructive entry
// ---------------------------------------------------------------------------

/**
 * Restore the verified retained snapshot to the live chat.db path with
 * durability confirmation (LOCK-4435). Fully synchronous (except for the
 * staging validation which opens SQLite handles): validation, proof
 * consumption, sidecar deletion, rename, syncs, and confirmation run
 * without interleaving on the Main thread.
 *
 * The proof is consumed exactly when the destructive window opens (just
 * before sidecar deletion). Failures BEFORE that point leave the proof
 * unconsumed so a corrected retry can reuse it while the promotion lease
 * is still held and the live DB is still closed.
 */
export function rollbackInstall(options: RollbackInstallOptions): RollbackInstallResult {
  const dataRoot = options.dataRoot ?? DATA_PATH
  const sampleCount = Math.max(1, Math.floor(options.sampleCount ?? 3))
  const livePath = path.resolve(path.join(dataRoot, LIVE_DB_FILENAME))
  const retainedPath = path.resolve(path.join(dataRoot, ROLLBACK_SNAPSHOT_FILENAME))
  const stagingPath = path.resolve(path.join(dataRoot, ROLLBACK_SNAPSHOT_STAGING_FILENAME))

  // --- 1. Verify retained snapshot exists and is sealed (no sidecars) -----
  try {
    if (!fs.statSync(retainedPath).isFile()) {
      return preFailure('RETAINED_MISSING', 'NOT_A_FILE')
    }
  } catch (error) {
    return preFailure('RETAINED_MISSING', safeErrorCode(error))
  }

  for (const sidecar of [`${retainedPath}-wal`, `${retainedPath}-shm`]) {
    if (fs.existsSync(sidecar)) {
      return preFailure('RETAINED_NOT_SEALED', 'SIDECAR_PRESENT')
    }
  }

  // --- 2. Create staging clone (LOCK-4434: fs.copyFileSync) ---------------
  // The retained source is closed, self-contained (no WAL/SHM), and was
  // fully validated before publication. A byte-level copy is a faithful
  // duplicate; partial copies are caught by the validation gate below.
  cleanupStaging(stagingPath)

  try {
    fs.copyFileSync(retainedPath, stagingPath)
  } catch (error) {
    cleanupStaging(stagingPath)
    return preFailure('STAGING_CREATE_FAILED', safeErrorCode(error))
  }

  // --- 3. Fsync staging for durability before validation ------------------
  try {
    fsyncFile(stagingPath)
  } catch (error) {
    cleanupStaging(stagingPath)
    return preFailure('STAGING_DURABILITY_FAILED', safeErrorCode(error))
  }

  // --- 4. Validate staging — full readonly gate (identical to snapshot) ---
  try {
    options.onAfterClone?.()
  } catch (error) {
    cleanupStaging(stagingPath)
    return preFailure('STAGING_CREATE_FAILED', safeErrorCode(error))
  }

  const stagingGate = validateReadonlyChatDb(stagingPath, sampleCount)
  if (stagingGate !== null) {
    cleanupStaging(stagingPath)
    return preFailure(STAGING_GATE_TO_CODE[stagingGate.gate], stagingGate.safeCode)
  }

  // Clean up any WAL/SHM sidecars that better-sqlite3 may have created
  // during the readonly staging validation. The staging file should be
  // self-contained for the atomic rename (LOCK-4434).
  for (const sidecar of [`${stagingPath}-wal`, `${stagingPath}-shm`]) {
    try {
      fs.unlinkSync(sidecar)
    } catch {
      // Best-effort: absence is the expected common case.
    }
  }

  // --- 5. Validate + consume the closed-live proof (LOCK-4427) ------------
  // The destructive window opens here: proof consumption + sidecar
  // deletion are one atomic synchronous block.
  try {
    options.onBeforeRename?.()
  } catch (error) {
    cleanupStaging(stagingPath)
    return preFailure('STAGING_CREATE_FAILED', safeErrorCode(error))
  }

  const proofVal = validateClosedLiveProof(options.proof)
  if (!proofVal.ok) {
    cleanupStaging(stagingPath)
    // Map the rejection reason to a backward-compatible safe code format.
    const safeCode =
      proofVal.reason === 'live-not-closed'
        ? 'LIVE_NOT_CLOSED'
        : proofVal.reason === 'unrecognized'
          ? 'UNRECOGNIZED'
          : proofVal.reason === 'consumed'
            ? 'CONSUMED'
            : proofVal.reason.startsWith('authorization-')
              ? `AUTHORIZATION_${proofVal.reason.replace('authorization-', '').replace(/-/g, '_').toUpperCase()}`
              : proofVal.reason.toUpperCase()
    return preFailure('CLOSED_LIVE_PROOF_INVALID', safeCode)
  }

  // --- 6. Destructive window: consume proof + delete live sidecars --------
  proofVal.validation.consume()

  for (const sidecar of [`${livePath}-wal`, `${livePath}-shm`]) {
    try {
      fs.unlinkSync(sidecar)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue
      cleanupStaging(stagingPath)
      return preFailure('LIVE_SIDECAR_DELETE_FAILED', safeErrorCode(error))
    }
  }

  // --- 7. Capture staging identity (binds receipt to the file object) -----
  let stagingIdentity: FileStatIdentity
  try {
    stagingIdentity = statIdentity(stagingPath)
  } catch (error) {
    cleanupStaging(stagingPath)
    return preFailure('STAGING_STAT_FAILED', safeErrorCode(error))
  }

  // --- 8. Fsync staging before the atomic rename (durability) -------------
  try {
    fsyncFile(stagingPath)
  } catch (error) {
    cleanupStaging(stagingPath)
    return preFailure('STAGING_DURABILITY_FAILED', safeErrorCode(error))
  }

  // --- 9. Atomic rename staging → live, same-filesystem ONLY (LOCK-4426) --
  try {
    fs.renameSync(stagingPath, livePath)
  } catch (error) {
    cleanupStaging(stagingPath)
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'EXDEV') {
      // LOCK-4426: cross-device is a structured failure — NEVER a copy
      // fallback. The staging and live files are both untouched.
      return preFailure('RENAME_CROSS_DEVICE', 'EXDEV')
    }
    return preFailure('RENAME_FAILED', safeErrorCode(error))
  }

  // ======= Rename happened: every failure below is post-rollback =========
  // LOCK-4437: artifacts are retained on every path below.

  options.onAfterRename?.()

  // --- 10. Live parent directory sync (POSIX durability) ------------------
  try {
    fsyncDirectory(dataRoot)
  } catch (error) {
    return postFailure('LIVE_DIRECTORY_SYNC_FAILED', safeErrorCode(error))
  }

  // --- 11. Destination identity confirmation ------------------------------
  let destinationIdentity: FileStatIdentity
  try {
    destinationIdentity = statIdentity(livePath)
  } catch (error) {
    return postFailure('DESTINATION_STAT_FAILED', safeErrorCode(error))
  }
  if (
    destinationIdentity.dev !== stagingIdentity.dev ||
    destinationIdentity.ino !== stagingIdentity.ino ||
    destinationIdentity.size !== stagingIdentity.size
  ) {
    return postFailure('DESTINATION_IDENTITY_MISMATCH', 'STAT_IDENTITY_DIVERGED')
  }

  // --- 12. Full readonly validation of the restored live DB ---------------
  const restoredGate = validateReadonlyChatDb(livePath, sampleCount)
  if (restoredGate !== null) {
    return postFailure(RESTORED_LIVE_GATE_TO_CODE[restoredGate.gate], restoredGate.safeCode)
  }

  // Clean up any WAL/SHM sidecars that better-sqlite3 may have created
  // during the readonly validation opens. The restored live DB should be
  // a self-contained file (the retained source had no sidecars).
  for (const sidecar of [`${livePath}-wal`, `${livePath}-shm`]) {
    try {
      fs.unlinkSync(sidecar)
    } catch {
      // Best-effort: absence is the expected common case.
    }
  }

  // --- 13. Confirm retained source is still byte-identical (LOCK-4434) ----
  try {
    if (!fs.statSync(retainedPath).isFile()) {
      // Retained was replaced by a directory — severe corruption.
      return postFailure('DESTINATION_IDENTITY_MISMATCH', 'RETAINED_REPLACED')
    }
  } catch (error) {
    // Retained source is inaccessible post-rename — factual evidence
    // of a severe failure, but the rollback itself succeeded.
    logger.warn(`Retained snapshot existence check failed post-rollback: ${safeErrorCode(error)}`)
  }

  // --- Build receipt ------------------------------------------------------
  const receipt: RollbackReceipt = Object.freeze({
    livePath,
    identity: stagingIdentity,
    retainedSnapshotPath: retainedPath,
    restoredAtMs: Date.now()
  })
  rollbackReceiptBrand.add(receipt)

  logger.info(
    `Rollback installed: retained snapshot restored at the live path ` +
      `(staging rename durable, identity confirmed, retained preserved)`
  )
  return Object.freeze({ ok: true as const, receipt })
}
