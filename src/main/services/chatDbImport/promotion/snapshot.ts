/**
 * Rollback snapshot preparation — durable one-retained snapshot gate
 * (Phase 4.4.1, LOCK-4411/4412/4417).
 *
 * Executes the first three PROMOTION_OPERATION_ORDER steps plus the
 * existence confirmation that must precede any journal write:
 *
 *   1. create-rollback-snapshot  — SQLite online backup of the OPEN live
 *      chat.db into the fixed staging name
 *      {@link ROLLBACK_SNAPSHOT_STAGING_FILENAME} next to the live DB.
 *      The live handle is borrowed, never closed, and live WAL/SHM
 *      sidecars are NEVER copied — the online backup API produces a
 *      self-contained snapshot (LOCK-4403/4411).
 *   2. verify-rollback-snapshot  — FULL validation of the staging file:
 *      readonly + fileMustExist open, PRAGMA integrity_check, PRAGMA
 *      foreign_key_check, exact migration-state compatibility against the
 *      registered MIGRATIONS, and minimum application-layer sample reads
 *      through the existing repository/aggregate read path (LOCK-4412).
 *   3. publish-rollback-snapshot — durable atomic rename staging →
 *      {@link ROLLBACK_SNAPSHOT_FILENAME} (one-retained ordering), with
 *      staging-file fsync before the rename and parent-directory fsync
 *      after it, then an explicit retained-existence confirmation.
 *
 * Failure semantics (LOCK-4411):
 * - Any backup/validation failure leaves the previously retained snapshot
 *   byte-for-byte untouched — only the staging file is cleaned up.
 * - The live DB stays open and authoritative on every outcome.
 * - This unit NEVER writes the promotion journal (LOCK-4417); the caller
 *   may journal `snapshot-ready` only after an `ok: true` result.
 *
 * All operational failures resolve to a structured result with a bounded
 * machine code — no raw messages, paths, or stack traces. Main-only
 * module. Not exposed over IPC/preload/renderer.
 */

import fs from 'node:fs'
import path from 'node:path'

import { loggerService } from '@logger'
import { BetterSqlite3BackupAdapter } from '@main/services/chatDb/backup'
import type Database from 'better-sqlite3'

import { ROLLBACK_SNAPSHOT_FILENAME, ROLLBACK_SNAPSHOT_STAGING_FILENAME } from './journal'
import {
  fsyncDirectory,
  fsyncFile,
  type ReadonlyChatDbValidationGate,
  safeErrorCode,
  validateReadonlyChatDb
} from './readonlyDbValidation'

const logger = loggerService.withContext('ChatDbRollbackSnapshot')

// ---------------------------------------------------------------------------
// Options / result types
// ---------------------------------------------------------------------------

export interface PrepareRollbackSnapshotOptions {
  /** Directory containing the live chat.db (the Data root). */
  dbDir: string
  /**
   * Returns the OPEN live better-sqlite3 handle. The handle is only used
   * as the online-backup source; it is never closed, written, or replaced
   * here (LOCK-4411).
   */
  getLiveSqlite: () => Database.Database
  /** Topics/segments sampled for application-layer reads (default 3, min 1). */
  sampleCount?: number
  /**
   * Test-only hook invoked AFTER the staging snapshot is created and
   * BEFORE validation starts (deterministic staging fault injection).
   */
  onAfterBackup?: () => void
  /**
   * Test-only hook invoked AFTER validation + staging fsync and BEFORE
   * the atomic rename (deterministic replacement-interruption injection).
   */
  onBeforePublish?: () => void
}

/** Bounded machine-readable failure codes (never carry content or paths). */
export type RollbackSnapshotFailureCode =
  | 'ONLINE_BACKUP_FAILED'
  | 'SNAPSHOT_OPEN_FAILED'
  | 'SNAPSHOT_INTEGRITY_FAILED'
  | 'SNAPSHOT_FOREIGN_KEYS_FAILED'
  | 'SNAPSHOT_MIGRATION_INCOMPATIBLE'
  | 'SNAPSHOT_SAMPLE_READ_FAILED'
  | 'SNAPSHOT_DURABILITY_FAILED'
  | 'RETAINED_PUBLISH_FAILED'
  | 'RETAINED_DIRECTORY_SYNC_FAILED'
  | 'RETAINED_CONFIRMATION_FAILED'

/** Result of {@link prepareRollbackSnapshot}. Never throws for operational failures. */
export type RollbackSnapshotResult =
  | {
      readonly ok: true
      /** Absolute path of the confirmed retained snapshot. */
      readonly retainedPath: string
      /** Pages copied by the online backup (diagnostic only). */
      readonly pagesCopied: number
    }
  | {
      readonly ok: false
      readonly code: RollbackSnapshotFailureCode
      /** Safe machine sub-code (error code/name only — never messages/paths). */
      readonly safeCode: string | null
      /**
       * True when the previously retained snapshot (if any) is guaranteed
       * untouched. False only for post-rename failures, where the retained
       * name already holds the NEW validated snapshot.
       */
      readonly oldRetainedPreserved: boolean
    }

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** One staging validation rejection (bounded, safe fields only). */
interface ValidationFailure {
  readonly code: RollbackSnapshotFailureCode
  readonly safeCode: string | null
}

function failure(
  code: RollbackSnapshotFailureCode,
  safeCode: string | null,
  oldRetainedPreserved: boolean
): RollbackSnapshotResult {
  return Object.freeze({ ok: false as const, code, safeCode, oldRetainedPreserved })
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
// Staging validation — readonly, full gate (LOCK-4412)
// ---------------------------------------------------------------------------

/** Map a shared readonly validation gate to the bounded SNAPSHOT_* code. */
const GATE_TO_SNAPSHOT_CODE: Record<ReadonlyChatDbValidationGate, RollbackSnapshotFailureCode> = {
  open: 'SNAPSHOT_OPEN_FAILED',
  integrity: 'SNAPSHOT_INTEGRITY_FAILED',
  'foreign-keys': 'SNAPSHOT_FOREIGN_KEYS_FAILED',
  migration: 'SNAPSHOT_MIGRATION_INCOMPATIBLE',
  'sample-reads': 'SNAPSHOT_SAMPLE_READ_FAILED'
}

/**
 * Full staging validation gate (LOCK-4412 step 2) — the shared readonly
 * gate sequence (open → integrity → FK → migration → sample reads) from
 * `readonlyDbValidation.ts`, mapped to bounded SNAPSHOT_* codes.
 */
function validateStagingSnapshot(stagingPath: string, sampleCount: number): ValidationFailure | null {
  const shared = validateReadonlyChatDb(stagingPath, sampleCount)
  if (shared === null) return null
  return { code: GATE_TO_SNAPSHOT_CODE[shared.gate], safeCode: shared.safeCode }
}

// ---------------------------------------------------------------------------
// prepareRollbackSnapshot — snapshot → validate → publish → confirm
// ---------------------------------------------------------------------------

/**
 * Create, fully validate, and durably publish the ONE retained rollback
 * snapshot for the live chat.db (LOCK-4412 required ordering):
 *
 *   online backup → staging  ⇒  full staging validation  ⇒  fsync staging
 *   ⇒  atomic rename staging → retained  ⇒  fsync parent directory
 *   ⇒  confirm retained exists
 *
 * The previously retained snapshot is replaced ONLY by the atomic rename
 * of an already-validated staging file; every earlier failure leaves it
 * untouched and cleans up staging (LOCK-4411). No journal I/O (LOCK-4417).
 */
export async function prepareRollbackSnapshot(
  options: PrepareRollbackSnapshotOptions
): Promise<RollbackSnapshotResult> {
  const sampleCount = Math.max(1, Math.floor(options.sampleCount ?? 3))
  const stagingPath = path.join(options.dbDir, ROLLBACK_SNAPSHOT_STAGING_FILENAME)
  const retainedPath = path.join(options.dbDir, ROLLBACK_SNAPSHOT_FILENAME)

  // Stale staging from an earlier interrupted attempt is ours to discard.
  cleanupStaging(stagingPath)

  // --- Step 1: online backup of the OPEN live DB into fixed staging ------
  let pagesCopied: number
  try {
    const adapter = new BetterSqlite3BackupAdapter(options.getLiveSqlite)
    pagesCopied = await adapter.createSnapshot(stagingPath)
  } catch (error) {
    logger.warn('Rollback snapshot online backup failed — old retained snapshot untouched')
    cleanupStaging(stagingPath)
    return failure('ONLINE_BACKUP_FAILED', safeErrorCode(error), true)
  }

  try {
    options.onAfterBackup?.()

    // --- Step 2: full validation of the staging snapshot ------------------
    const validationFailure = validateStagingSnapshot(stagingPath, sampleCount)
    if (validationFailure !== null) {
      logger.warn(`Rollback snapshot validation failed (${validationFailure.code}) — old retained snapshot untouched`)
      cleanupStaging(stagingPath)
      return failure(validationFailure.code, validationFailure.safeCode, true)
    }

    // --- Step 3: durable publish (one-retained atomic replacement) --------
    try {
      fsyncFile(stagingPath)
    } catch (error) {
      cleanupStaging(stagingPath)
      return failure('SNAPSHOT_DURABILITY_FAILED', safeErrorCode(error), true)
    }

    try {
      options.onBeforePublish?.()
      fs.renameSync(stagingPath, retainedPath)
    } catch (error) {
      logger.warn('Rollback snapshot publish failed — old retained snapshot untouched')
      cleanupStaging(stagingPath)
      return failure('RETAINED_PUBLISH_FAILED', safeErrorCode(error), true)
    }

    try {
      fsyncDirectory(options.dbDir)
    } catch (error) {
      // The rename already happened: the retained name now holds the NEW
      // validated snapshot, but its durability is unconfirmed.
      return failure('RETAINED_DIRECTORY_SYNC_FAILED', safeErrorCode(error), false)
    }

    // --- Existence confirmation (precondition for any journal write) ------
    try {
      if (!fs.statSync(retainedPath).isFile()) {
        return failure('RETAINED_CONFIRMATION_FAILED', 'NOT_A_FILE', false)
      }
    } catch (error) {
      return failure('RETAINED_CONFIRMATION_FAILED', safeErrorCode(error), false)
    }

    logger.info(`Rollback snapshot retained and confirmed (${pagesCopied} pages)`)
    return Object.freeze({ ok: true as const, retainedPath, pagesCopied })
  } catch (error) {
    // Unexpected failure (including test-hook throws outside guarded
    // stages): staging is discarded, old retained stays untouched.
    cleanupStaging(stagingPath)
    return failure('RETAINED_PUBLISH_FAILED', safeErrorCode(error), true)
  }
}
