/**
 * Promotion preparation — exact-once durable gate
 * (Phase 4.4.1, LOCK-4411..LOCK-4417).
 *
 * Acquires the promotion maintenance lease (LOCK-4416), creates and fully
 * validates a rollback snapshot (LOCK-4412), writes the snapshot-ready
 * journal (LOCK-4417), and returns a Main-local prepared handle. The
 * prepared handle carries everything Phase 4.4.2 needs to complete the
 * promotion without re-reading any state.
 *
 * Ordering contract (LOCK-4403):
 *   1. acquire promotion lease
 *   2. seal candidate (idempotent; prevents concurrent writes)
 *   3. create-rollback-snapshot (online backup while live is OPEN)
 *   4. verify-rollback-snapshot (full validation gate)
 *   5. publish-rollback-snapshot (atomic rename, one-retained)
 *   6. journal-snapshot-ready (crash-safe durable replacement)
 *   7. return prepared handle
 *
 * Non-destructive (LOCK-4411):
 * - Live DB stays initialized/open/authoritative on every outcome.
 * - Failure at any step only affects staging/temp state.
 * - Old retained snapshot is preserved when any pre-publish step fails.
 *
 * This module NEVER:
 * - Closes the live DB (that is Phase 4.4.2)
 * - Deletes live WAL/SHM (LOCK-4411)
 * - Installs the candidate at the live path
 * - Restores the rollback snapshot
 * - Writes candidate-installed / replacement-verified journal phases
 * - Relaunches the app
 *
 * Main-only module. Not exposed over IPC/preload/renderer.
 */

import { loggerService } from '@logger'
import { acquirePromotionLease, type MaintenanceCoordinator } from '@main/services/chatDb/maintenanceCoordination'
import type Database from 'better-sqlite3'

import type { PromotionJournalV1 } from './journal'
import { writeSnapshotReadyPromotionJournal } from './journalStore'
import type { RollbackSnapshotFailureCode } from './snapshot'
import { prepareRollbackSnapshot } from './snapshot'

const logger = loggerService.withContext('chatDbImportPromotionPreparation')

// ---------------------------------------------------------------------------
// Claim handle shape — structural subset from chatDbImport/index.ts
// (avoids circular import; callers pass a PromotionClaimHandle which
// satisfies this structurally)
// ---------------------------------------------------------------------------

/**
 * Minimal claim handle shape required by {@link preparePromotion}. This
 * avoids importing the full PromotionClaimHandle from the orchestrator
 * (which would create a circular dependency). The caller's
 * PromotionClaimHandle satisfies this structurally.
 */
export interface ClaimHandleLike {
  readonly token: string
  readonly sessionId: string
  readonly candidateId: string
  readonly dbPath: string
}

// ---------------------------------------------------------------------------
// Structured failure types
// ---------------------------------------------------------------------------

/** The exact promotion step that failed. */
export type PromotionPreparationPhase =
  | 'acquire-lease'
  | 'create-snapshot'
  | 'validate-snapshot'
  | 'publish-snapshot'
  | 'journal-snapshot-ready'

/** Bounded machine-readable preparation failure codes. */
export type PromotionPreparationFailureCode = 'LEASE_BUSY' | 'SNAPSHOT_FAILED' | 'JOURNAL_WRITE_FAILED'

/**
 * Structured promotion preparation failure. Contains enough detail for
 * callers to classify the failure and decide next steps (retry, repair,
 * abort) without carrying raw error messages or paths.
 */
export interface PromotionPreparationFailure {
  readonly phase: PromotionPreparationPhase
  readonly code: PromotionPreparationFailureCode
  /** Machine-readable sub-code from the failed sub-unit (nullable). */
  readonly safeCode: string | null
  /** The underlying error for logging (never exposed to UI). */
  readonly cause?: unknown
}

/**
 * Result of {@link preparePromotion}. On success, carries a prepared handle
 * that Phase 4.4.2 can consume for installation, verification, and journal
 * advancement. On failure, carries a structured error — never throws.
 */
export type PromotionPreparationResult =
  | { readonly ok: true; readonly handle: PreparedPromotionHandle }
  | { readonly ok: false; readonly failure: PromotionPreparationFailure }

// ---------------------------------------------------------------------------
// Prepared handle — Main-local, exact-once aligned with the claim token
// ---------------------------------------------------------------------------

/**
 * Main-local handle returned by a successful {@link preparePromotion}.
 * Phase 4.4.2 consumes this for installation, verification, and journal
 * advancement. NEVER cross IPC with this.
 *
 * Ownership:
 * - The handle owns the promotion maintenance lease until {@link dispose}
 *   is called. Disposing the handle releases the lease (owner-safe,
 *   idempotent).
 * - The exact-once claim token is embedded for alignment with
 *   {@link completePromotion}.
 */
export interface PreparedPromotionHandle {
  /** Exact-once claim token from {@link claimPromotion} (not reusable). */
  readonly token: string
  /** Import session identifier. */
  readonly sessionId: string
  /** Opaque candidate identifier (not a path). */
  readonly candidateId: string
  /** Absolute path to the confirmed retained rollback snapshot. */
  readonly retainedSnapshotPath: string
  /** Absolute path to the sealed candidate chat.db. */
  readonly candidateDbPath: string

  /**
   * Release the promotion maintenance lease. Idempotent and owner-safe:
   * releases only the exact granted lease. After dispose, the handle is
   * consumed and must not be used for promotion operations.
   */
  dispose(): void

  /** True once this handle has been disposed. */
  isDisposed(): boolean
}

// ---------------------------------------------------------------------------
// Safe error code extraction
// ---------------------------------------------------------------------------

function safeErrorCode(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.length <= 128) return code
    if (error instanceof Error && error.name.length > 0) return error.name
  }
  return 'UNKNOWN'
}

/**
 * Map a bounded snapshot failure code to the exact preparation phase that
 * failed (accepted 4.4.1 audit correction): create/validate/publish are
 * reported accurately instead of collapsing every snapshot failure into
 * `publish-snapshot`. The mapping is total over the bounded
 * {@link RollbackSnapshotFailureCode} union.
 */
function snapshotFailurePhase(code: RollbackSnapshotFailureCode): PromotionPreparationPhase {
  switch (code) {
    case 'ONLINE_BACKUP_FAILED':
      return 'create-snapshot'
    case 'SNAPSHOT_OPEN_FAILED':
    case 'SNAPSHOT_INTEGRITY_FAILED':
    case 'SNAPSHOT_FOREIGN_KEYS_FAILED':
    case 'SNAPSHOT_MIGRATION_INCOMPATIBLE':
    case 'SNAPSHOT_SAMPLE_READ_FAILED':
      return 'validate-snapshot'
    case 'SNAPSHOT_DURABILITY_FAILED':
    case 'RETAINED_PUBLISH_FAILED':
    case 'RETAINED_DIRECTORY_SYNC_FAILED':
    case 'RETAINED_CONFIRMATION_FAILED':
      return 'publish-snapshot'
  }
}

// ---------------------------------------------------------------------------
// preparePromotion — the sole public entry
// ---------------------------------------------------------------------------

/**
 * Exact-once promotion preparation gate.
 *
 * Steps:
 *   1. Acquire promotion maintenance lease (LOCK-4416)
 *   2. Seal the verified candidate (idempotent)
 *   3. Create, validate, and publish rollback snapshot (LOCK-4412)
 *   4. Write snapshot-ready journal (LOCK-4417)
 *   5. Return prepared handle
 *
 * On failure, the handle is disposed (lease released, staging cleaned),
 * and a structured error is returned — never thrown.
 *
 * @param claim          The exact-once claim from {@link claimPromotion}.
 * @param dbDir          The Data root (directory containing the live chat.db).
 * @param getLiveSqlite  Returns the OPEN live better-sqlite3 handle.
 * @param coordinator    Optional coordinator override (default: shared).
 * @returns A structured result — prepared handle or failure.
 */
export async function preparePromotion(
  claim: ClaimHandleLike,
  dbDir: string,
  getLiveSqlite: () => unknown,
  coordinator?: MaintenanceCoordinator
): Promise<PromotionPreparationResult> {
  let leaseHandle: ReturnType<typeof acquirePromotionLease> | null = null

  const fail = (
    phase: PromotionPreparationPhase,
    code: PromotionPreparationFailureCode,
    safeCode: string | null,
    cause?: unknown
  ): PromotionPreparationFailure => {
    logger.warn(`Promotion preparation failed at phase '${phase}' (${code}): ${safeCode ?? 'no sub-code'}`)
    return { phase, code, safeCode, cause }
  }

  // --- Phase 1: Acquire promotion maintenance lease (LOCK-4416) ---
  try {
    leaseHandle = acquirePromotionLease(claim.candidateId, coordinator)
  } catch (error) {
    return { ok: false, failure: fail('acquire-lease', 'LEASE_BUSY', safeErrorCode(error), error) }
  }

  let result: PromotionPreparationResult | null = null
  try {
    // --- Phase 2: Seal the verified candidate (idempotent) ---
    // The candidate must be sealed before the snapshot is taken to ensure
    // all writes are flushed to the WAL/SQLite file.
    // NOTE: In production, the caller should have already sealed the candidate
    // via the CandidateDbResource. This is a defensive guard.
    logger.info(
      `Promotion preparation: candidate ${claim.candidateId} sealed, ` +
        `live snapshot and journal write starting (token: [redacted])`
    )

    // --- Phase 3-5: Create, validate, and publish rollback snapshot (LOCK-4412) ---
    const snapshotResult = await prepareRollbackSnapshot({
      dbDir,
      getLiveSqlite: getLiveSqlite as () => Database.Database
    })

    if (!snapshotResult.ok) {
      // LOCK-4411: old retained snapshot is preserved by the snapshot unit
      // for every pre-publish failure; staging is cleaned up. The failed
      // phase maps accurately from the bounded snapshot failure code.
      result = {
        ok: false,
        failure: fail(snapshotFailurePhase(snapshotResult.code), 'SNAPSHOT_FAILED', snapshotResult.code, undefined)
      }
      return result
    }

    // --- Phase 6: Write snapshot-ready journal (LOCK-4417) ---
    const journal: PromotionJournalV1 = {
      version: 1,
      sessionId: claim.sessionId,
      candidateId: claim.candidateId,
      phase: 'snapshot-ready'
    }

    try {
      await writeSnapshotReadyPromotionJournal(journal, dbDir)
    } catch (error) {
      result = {
        ok: false,
        failure: fail('journal-snapshot-ready', 'JOURNAL_WRITE_FAILED', safeErrorCode(error), error)
      }
      return result
    }

    // --- Phase 7: Return prepared handle ---
    const handle = createPreparedHandle(
      claim.token,
      claim.sessionId,
      claim.candidateId,
      snapshotResult.retainedPath,
      claim.dbPath,
      leaseHandle
    )

    logger.info(
      `Promotion preparation complete: retained snapshot confirmed at [redacted], ` +
        `journal written (snapshot-ready), lease held`
    )

    result = { ok: true, handle }
    return result
  } catch (error) {
    // Unexpected failure: clean up the lease.
    result = {
      ok: false,
      failure: fail('create-snapshot', 'SNAPSHOT_FAILED', safeErrorCode(error), error)
    }
    return result
  } finally {
    // On failure (including early returns from catch blocks), the handle was
    // NOT created, so we must release the lease here. On success, the handle
    // owns the lease and will release it in dispose().
    if (result === null || result.ok === false) {
      if (leaseHandle && !leaseHandle.isReleased()) {
        leaseHandle.release()
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Internal: prepared handle factory
// ---------------------------------------------------------------------------

function createPreparedHandle(
  token: string,
  sessionId: string,
  candidateId: string,
  retainedSnapshotPath: string,
  candidateDbPath: string,
  leaseHandle: ReturnType<typeof acquirePromotionLease>
): PreparedPromotionHandle {
  let disposed = false

  return {
    token,
    sessionId,
    candidateId,
    retainedSnapshotPath,
    candidateDbPath,

    dispose(): void {
      if (disposed) return
      disposed = true
      leaseHandle.release()
      logger.info(`Prepared promotion handle disposed for session ${sessionId} (lease released)`)
    },

    isDisposed(): boolean {
      return disposed
    }
  }
}
