/**
 * Promotion preparation — exact-once durable gate
 * (Phase 4.4.1, LOCK-4411..LOCK-4417; Phase 2 L2 promotion,
 * LOCK-PROMO-2/3/6/12).
 *
 * Acquires the promotion maintenance lease (LOCK-4416), verifies the three
 * candidate artifacts (sealed chat.db, candidate Files dir, candidate
 * files-catalog.json), journals `candidates-ready` with the candidate
 * aggregate receipts, creates + verifies + publishes the retained rollback
 * snapshots for ALL THREE live artifacts (chat.db, Files, Dexie files
 * catalog — LOCK-PROMO-3), journals `snapshots-ready` with the old
 * generation receipts, and returns a Main-local prepared handle.
 *
 * Ordering contract (LOCK-PROMO-2/3):
 *   0. guard-read the promotion journal — ANY existing journal (v1, v2, or
 *      codec-invalid) fails closed BEFORE any artifact work (LOCK-PREP-7):
 *      preparation is a fresh-start gate and never overwrites durable state;
 *      continuation of an existing journal belongs to the recovery executor.
 *   1. acquire promotion lease
 *   2. validate the three candidate artifacts (catalog handoff structure,
 *      candidate Files ↔ catalog row↔filename↔size↔SHA-256 parity,
 *      candidate chat.db receipt) + compute exact candidate receipts
 *   3. journal `candidates-ready`
 *   4. create-rollback-snapshot (db)   — online backup while live is OPEN
 *   5. verify-rollback-snapshot (db)
 *   6. publish-rollback-snapshot (db)
 *   7. create-files-snapshot           — live Files dir copy + manifest
 *   8. verify-files-snapshot
 *   9. publish-files-snapshot
 *  10. capture-catalog-snapshot        — renderer/Dexie read via the
 *                                       catalog boundary
 *  11. verify + publish-catalog-snapshot — durable atomic write
 *  12. journal `snapshots-ready` with old generation receipts
 *  13. return prepared handle
 *
 * Cancellation (LOCK-PREP-4): an injected `shouldAbort` probe is checked at
 * every await boundary. Until `snapshots-ready` is journaled AND the
 * prepared handle returns, cancellation stays allowed: aborting before the
 * candidates-ready write leaves NO journal; aborting after it leaves the
 * safe no-mutation `candidates-ready` journal for startup recovery. The
 * journal is NEVER advanced to `snapshots-ready` before all three snapshots
 * are durable and independently verified (LOCK-PREP-3 — never overstates).
 *
 * Non-destructive (LOCK-4411): the live DB stays initialized/open on every
 * outcome; the live Files dir and live Dexie catalog are never mutated;
 * every failure only affects staging/temp state; previously retained
 * snapshots are preserved when any pre-publish step fails.
 *
 * This module NEVER closes the live DB, never installs the candidate,
 * never restores snapshots, never writes db-installed or later phases, and
 * never relaunches.
 *
 * Main-only module. Not exposed over IPC/preload/renderer.
 */

import path from 'node:path'

import { loggerService } from '@logger'
import {
  acquirePromotionLease,
  type MaintenanceCoordinator,
  type PromotionLeaseHandle
} from '@main/services/chatDb/maintenanceCoordination'
import type { FilesCatalogSnapshotV1 } from '@shared/chatImport/types'
import type Database from 'better-sqlite3'

import { readAndValidateCatalog } from '../attachmentPlane'
import { computeCatalogReceipt, computeDbReceipt, computeFilesReceipt, emptyArtifactReceipts } from './artifactReceipts'
import { type FilesParityFailureCode, verifyFilesDirAgainstCatalog } from './catalogParity'
import { type CatalogSnapshotFailureCode, writeCatalogSnapshotDurable } from './catalogSnapshot'
import { resolveCandidateFilesDir } from './filesInstall'
import { prepareFilesRollbackSnapshot } from './filesSnapshot'
import type { PromotionArtifactReceipts, PromotionJournalFilesReceipt, PromotionJournalV2 } from './journal'
import { advancePromotionJournalV2, readPromotionJournal, writeCandidatesReadyPromotionJournal } from './journalStore'
import { prepareRollbackSnapshot, type RollbackSnapshotFailureCode } from './snapshot'

const logger = loggerService.withContext('chatDbImportPromotionPreparation')

// ---------------------------------------------------------------------------
// Claim handle shape — structural subset from chatDbImport/index.ts
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

/**
 * Catalog boundary the preparation uses to capture the LIVE Dexie files
 * catalog snapshot (LOCK-PROMO-3). Production wraps catalogApplyIpc;
 * tests inject a double.
 */
export interface CatalogSnapshotBoundary {
  captureSnapshot(): Promise<
    { readonly ok: true; readonly snapshot: FilesCatalogSnapshotV1 } | { readonly ok: false; readonly code: string }
  >
}

/**
 * Preparation options. `shouldAbort` is the LOCK-PREP-4 cancellation probe,
 * checked at every await boundary — when it returns true the preparation
 * settles as a bounded CANCELLED failure with the lease released and the
 * journal (if already written) left at the safe `candidates-ready` phase.
 */
export interface PromotionPreparationOptions {
  /** Coordinator override (tests); defaults to the shared coordinator. */
  coordinator?: MaintenanceCoordinator
  /** Catalog snapshot boundary (tests); REQUIRED in production. */
  catalogBoundary?: CatalogSnapshotBoundary
  /** Cooperative cancellation probe (LOCK-PREP-4). */
  shouldAbort?: () => boolean
}

// ---------------------------------------------------------------------------
// Structured failure types
// ---------------------------------------------------------------------------

/** The exact promotion step that failed. */
export type PromotionPreparationPhase =
  | 'acquire-lease'
  | 'candidates-ready-journal'
  | 'create-snapshot'
  | 'validate-snapshot'
  | 'publish-snapshot'
  | 'create-files-snapshot'
  | 'publish-files-snapshot'
  | 'capture-catalog-snapshot'
  | 'publish-catalog-snapshot'
  | 'journal-snapshots-ready'

/** Bounded machine-readable preparation failure codes. */
export type PromotionPreparationFailureCode =
  | 'LEASE_BUSY'
  | 'CANDIDATE_INVALID'
  | 'JOURNAL_WRITE_FAILED'
  | 'JOURNAL_EXISTS'
  | 'SNAPSHOT_FAILED'
  | 'FILES_SNAPSHOT_FAILED'
  | 'CATALOG_SNAPSHOT_FAILED'
  | 'CANCELLED'

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
 * Ownership (Phase 4.4.2, LOCK-4421/LOCK-4422):
 * - The handle owns the promotion maintenance lease until it is either
 *   disposed OR consumed — whichever happens first, exactly once.
 * - {@link consume} transfers lease ownership to the returned executing
 *   capability (the SAME lease — never released and reacquired).
 * - {@link dispose} before consume releases the lease (owner-safe,
 *   idempotent) and permanently refuses any later consume.
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
   * Exact-once destructive-capability transfer (LOCK-4421). The first call
   * on an undisposed handle returns the executing capability owning the
   * SAME promotion lease (LOCK-4422). Every later call — and any call
   * after dispose — is refused with a bounded reason and has no effect.
   */
  consume(): PreparedPromotionConsumeResult

  /** True once {@link consume} succeeded (ownership transferred). */
  isConsumed(): boolean

  /**
   * Release the promotion maintenance lease. Idempotent and stale-safe:
   * before consume it releases only the exact granted lease; after consume
   * it is a no-op — the executing capability owns the release.
   */
  dispose(): void

  /** True once this handle has been disposed. */
  isDisposed(): boolean
}

/**
 * Result of {@link PreparedPromotionHandle.consume}. Refusals are bounded:
 * `already-consumed` (exact-once violated) or `disposed` (stale handle).
 */
export type PreparedPromotionConsumeResult =
  | { readonly ok: true; readonly capability: ExecutingPromotionCapability }
  | { readonly ok: false; readonly reason: 'already-consumed' | 'disposed' }

/**
 * Main-local executing capability produced by exact-once consumption of a
 * {@link PreparedPromotionHandle} (Phase 4.4.2, LOCK-4421/LOCK-4422).
 * NEVER cross IPC with this.
 *
 * Carries every artifact fact Phase 4.4.2 needs without re-reading any
 * state: the retained snapshot paths for all three live artifacts, the
 * journal aggregate receipts (candidate + old generations), and the
 * continuous promotion lease authorization.
 */
export interface ExecutingPromotionCapability {
  /** Exact-once claim token from {@link claimPromotion} (not reusable). */
  readonly token: string
  /** Import session identifier. */
  readonly sessionId: string
  /** Opaque candidate identifier (not a path). */
  readonly candidateId: string
  /** Absolute path to the confirmed retained rollback snapshot (db). */
  readonly retainedSnapshotPath: string
  /** Absolute path to the sealed candidate chat.db. */
  readonly candidateDbPath: string
  /** Absolute path to the retained Files rollback snapshot dir. */
  readonly retainedFilesSnapshotDir: string
  /** Absolute path to the retained catalog rollback snapshot file. */
  readonly catalogSnapshotPath: string
  /** Journal aggregate receipts (candidate + old generations). */
  readonly receipts: {
    readonly candidate: PromotionArtifactReceipts
    readonly old: PromotionArtifactReceipts
  }

  /**
   * The continuously held promotion lease authorization (LOCK-4422).
   * Presented for validation only — release goes through {@link release}.
   */
  readonly authorization: PromotionLeaseHandle

  /**
   * Release the promotion maintenance lease exactly once. Idempotent and
   * owner-safe (a stale release can never disturb a newer holder).
   */
  release(): void

  /** True once this capability released its lease. */
  isReleased(): boolean
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
 * failed. The mapping is total over the bounded {@link RollbackSnapshotFailureCode} union.
 */
function snapshotFailurePhase(code: RollbackSnapshotFailureCode): PromotionPreparationPhase {
  switch (code) {
    case 'ONLINE_BACKUP_FAILED':
      return 'create-snapshot'
    case 'SNAPSHOT_OPEN_FAILED':
    case 'SNAPSHOT_INTEGRITY_FAILED':
    case 'SNAPSHOT_FOREIGN_KEYS_FAILED':
    case 'SNAPSHOT_MIGRATION_INCOMPATIBLE':
    case 'SNAPSHOT_SEARCH_PROJECTION_FAILED':
    case 'SNAPSHOT_SAMPLE_READ_FAILED':
      return 'validate-snapshot'
    case 'SNAPSHOT_DURABILITY_FAILED':
    case 'RETAINED_PUBLISH_FAILED':
    case 'RETAINED_DIRECTORY_SYNC_FAILED':
    case 'RETAINED_CONFIRMATION_FAILED':
      return 'publish-snapshot'
  }
}

/**
 * Map a catalog snapshot failure code to the preparation phase. A
 * `PAYLOAD_INVALID` is a MALFORMED capture output from the boundary (the
 * durable writer rejects it pre-publish, audit F3) — it is a
 * capture-catalog-snapshot failure, never a publish failure.
 */
function catalogSnapshotFailurePhase(code: CatalogSnapshotFailureCode): PromotionPreparationPhase {
  switch (code) {
    case 'PAYLOAD_INVALID':
      return 'capture-catalog-snapshot'
    case 'WRITE_FAILED':
    case 'DURABILITY_FAILED':
    case 'READBACK_INVALID':
    case 'DIRECTORY_SYNC_FAILED':
      return 'publish-catalog-snapshot'
  }
}

/**
 * Map a candidate Files ↔ catalog parity failure code to a bounded
 * candidate-validation safe sub-code (LOCK-PREP-1). Total over the bounded
 * {@link FilesParityFailureCode} union.
 */
function candidateParitySafeCode(code: FilesParityFailureCode): string {
  switch (code) {
    case 'CATALOG_INVALID':
      return 'CANDIDATE_CATALOG_INVALID'
    case 'FILES_DIR_MISSING':
      return 'CANDIDATE_FILES_DIR_MISSING'
    case 'PAYLOAD_MISSING':
      return 'CANDIDATE_PAYLOAD_MISSING'
    case 'PAYLOAD_SIZE_MISMATCH':
      return 'CANDIDATE_PAYLOAD_SIZE_MISMATCH'
    case 'PAYLOAD_HASH_MISMATCH':
      return 'CANDIDATE_PAYLOAD_HASH_MISMATCH'
    case 'PAYLOAD_NOT_A_FILE':
      return 'CANDIDATE_PAYLOAD_NOT_A_FILE'
    case 'EXTRA_PAYLOAD':
      return 'CANDIDATE_EXTRA_PAYLOAD'
    case 'NON_REGULAR_ENTRY':
      return 'CANDIDATE_NON_REGULAR_ENTRY'
  }
}

// ---------------------------------------------------------------------------
// Candidate artifact reads
// ---------------------------------------------------------------------------

/** Read the candidate catalog rows (with per-row SHA-256) from the owned dir. */
function readCandidateCatalog(candidateId: string, dbDir: string): ReturnType<typeof readAndValidateCatalog> {
  try {
    return readAndValidateCatalog(path.join(dbDir, 'chat-import-candidates', candidateId, 'files-catalog.json'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Cancellation probe (LOCK-PREP-4)
// ---------------------------------------------------------------------------

/**
 * Cooperative cancellation check, invoked at every await boundary. When the
 * injected `shouldAbort` probe returns true, returns a bounded CANCELLED
 * failure for the exact phase where the abort was observed — the caller
 * settles it, releasing the lease and (if already written) leaving the safe
 * `candidates-ready` journal for startup recovery.
 */
function checkCancelled(
  shouldAbort: (() => boolean) | undefined,
  fail: (
    phase: PromotionPreparationPhase,
    code: PromotionPreparationFailureCode,
    safeCode: string | null,
    cause?: unknown
  ) => PromotionPreparationFailure,
  phase: PromotionPreparationPhase
): PromotionPreparationFailure | null {
  if (shouldAbort?.()) {
    logger.info(`Promotion preparation cancelled at phase '${phase}' (lease will be released)`)
    return fail(phase, 'CANCELLED', 'USER_CANCELLED')
  }
  return null
}

// ---------------------------------------------------------------------------
// preparePromotion — the sole public entry
// ---------------------------------------------------------------------------

/**
 * Exact-once promotion preparation gate (v2 three-artifact protocol).
 *
 * Ordering (LOCK-PREP-1..8): guard-read the journal (any existing journal
 * fails closed) → acquire the promotion lease → validate the three
 * candidate artifacts + compute exact candidate receipts → journal
 * `candidates-ready` → create/verify/publish the three retained rollback
 * snapshots (live db online backup, live Files copy, live Dexie catalog via
 * the boundary) → journal `snapshots-ready` with the old-generation
 * receipts → return a Main-local one-shot prepared handle. `shouldAbort`
 * is honored at every await boundary (LOCK-PREP-4).
 *
 * @param claim          The exact-once claim from {@link claimPromotion}.
 * @param dbDir          The Data root (directory containing the live chat.db).
 * @param getLiveSqlite  Returns the OPEN live better-sqlite3 handle.
 * @param optionsOrCoordinator Optional options object (coordinator override
 *   + catalog snapshot boundary + cancellation probe); a bare
 *   MaintenanceCoordinator is accepted for backward compatibility.
 * @returns A structured result — prepared handle or failure.
 */
export async function preparePromotion(
  claim: ClaimHandleLike,
  dbDir: string,
  getLiveSqlite: () => unknown,
  optionsOrCoordinator?: PromotionPreparationOptions | MaintenanceCoordinator
): Promise<PromotionPreparationResult> {
  const options =
    optionsOrCoordinator !== null &&
    typeof optionsOrCoordinator === 'object' &&
    ('catalogBoundary' in optionsOrCoordinator ||
      'shouldAbort' in optionsOrCoordinator ||
      'coordinator' in optionsOrCoordinator)
      ? optionsOrCoordinator
      : { coordinator: optionsOrCoordinator as MaintenanceCoordinator | undefined }
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

  // --- Phase 0: guard-read — re-entry with ANY existing journal fails
  //     closed (LOCK-PREP-7). Preparation is a fresh-start gate; it never
  //     overwrites another session's durable state. -------------------------
  try {
    const existing = await readPromotionJournal(dbDir)
    if (existing.status !== 'absent') {
      const safeCode =
        existing.status === 'valid' ? (existing.journal.version === 2 ? 'V2_JOURNAL' : 'V1_JOURNAL') : 'INVALID_JOURNAL'
      return { ok: false, failure: fail('candidates-ready-journal', 'JOURNAL_EXISTS', safeCode) }
    }
  } catch (error) {
    // READ_IO_FAILED etc — the journal state is undeterminable: fail closed.
    return {
      ok: false,
      failure: fail('candidates-ready-journal', 'JOURNAL_WRITE_FAILED', safeErrorCode(error), error)
    }
  }

  // --- Phase 1: Acquire promotion maintenance lease (LOCK-4416) ---
  try {
    leaseHandle = acquirePromotionLease(claim.candidateId, options.coordinator)
  } catch (error) {
    return { ok: false, failure: fail('acquire-lease', 'LEASE_BUSY', safeErrorCode(error), error) }
  }

  let result: PromotionPreparationResult | null = null
  try {
    const cancelled = checkCancelled(options.shouldAbort, fail, 'candidates-ready-journal')
    if (cancelled !== null) {
      result = { ok: false, failure: cancelled }
      return result
    }

    // --- Phase 2: Validate candidate artifacts + compute candidate
    //     receipts (LOCK-PREP-1). ------------------------------------------
    let candidateReceipts: PromotionArtifactReceipts
    try {
      const candidateCatalog = readCandidateCatalog(claim.candidateId, dbDir)
      if (candidateCatalog === null) {
        result = {
          ok: false,
          failure: fail('candidates-ready-journal', 'CANDIDATE_INVALID', 'CATALOG_UNREADABLE', undefined)
        }
        return result
      }
      const candidateFilesDir = resolveCandidateFilesDir(claim.candidateId, dbDir)
      // LOCK-PREP-1: the candidate Files generation must match its own
      // catalog (row↔filename↔size↔SHA-256 parity + no extra payloads). A
      // tampered/missing candidate payload must never reach candidates-ready.
      const parity = verifyFilesDirAgainstCatalog(
        candidateFilesDir,
        candidateCatalog.rows.map((row) => ({ name: row.name, size: row.size, sha256: row.sha256 }))
      )
      if (!parity.ok) {
        result = {
          ok: false,
          failure: fail(
            'candidates-ready-journal',
            'CANDIDATE_INVALID',
            candidateParitySafeCode(parity.code),
            undefined
          )
        }
        return result
      }
      // The candidate files receipt derives from the catalog rows directly
      // (row↔filename↔size↔SHA-256 parity source, LOCK-PREP-1/9).
      const filesReceipt = computeFilesReceiptFromCatalog(candidateCatalog.rows)
      const catalogReceipt = computeCatalogReceipt(candidateCatalog.rows)
      const dbReceipt = await computeDbReceipt(claim.dbPath)

      candidateReceipts = {
        db: dbReceipt,
        files: filesReceipt,
        catalog: catalogReceipt
      }
    } catch (error) {
      // A candidate-artifact read/seal failure is CANDIDATE_INVALID — never
      // the generic catch-all.
      result = {
        ok: false,
        failure: fail('candidates-ready-journal', 'CANDIDATE_INVALID', safeErrorCode(error), error)
      }
      return result
    }

    // --- Phase 3: Journal `candidates-ready` (LOCK-PREP-3) ----------------
    const cancelledBeforeJournal = checkCancelled(options.shouldAbort, fail, 'candidates-ready-journal')
    if (cancelledBeforeJournal !== null) {
      result = { ok: false, failure: cancelledBeforeJournal }
      return result
    }
    const candidatesJournal: PromotionJournalV2 = {
      version: 2,
      sessionId: claim.sessionId,
      candidateId: claim.candidateId,
      phase: 'candidates-ready',
      receipts: { candidate: candidateReceipts, old: emptyArtifactReceipts() }
    }
    try {
      await writeCandidatesReadyPromotionJournal(candidatesJournal, dbDir)
    } catch (error) {
      result = {
        ok: false,
        failure: fail('candidates-ready-journal', 'JOURNAL_WRITE_FAILED', safeErrorCode(error), error)
      }
      return result
    }

    // --- Phase 4-6: db rollback snapshot (create/validate/publish) ---------
    const cancelledBeforeDbSnapshot = checkCancelled(options.shouldAbort, fail, 'create-snapshot')
    if (cancelledBeforeDbSnapshot !== null) {
      result = { ok: false, failure: cancelledBeforeDbSnapshot }
      return result
    }
    const dbSnapshotResult = await prepareRollbackSnapshot({
      dbDir,
      getLiveSqlite: getLiveSqlite as () => Database.Database
    })
    if (!dbSnapshotResult.ok) {
      result = {
        ok: false,
        failure: fail(snapshotFailurePhase(dbSnapshotResult.code), 'SNAPSHOT_FAILED', dbSnapshotResult.code, undefined)
      }
      return result
    }

    // --- Phase 7-9: Files rollback snapshot (create/verify/publish) --------
    const cancelledBeforeFilesSnapshot = checkCancelled(options.shouldAbort, fail, 'create-files-snapshot')
    if (cancelledBeforeFilesSnapshot !== null) {
      result = { ok: false, failure: cancelledBeforeFilesSnapshot }
      return result
    }
    const filesSnapshotResult = prepareFilesRollbackSnapshot({ dataRoot: dbDir })
    if (!filesSnapshotResult.ok) {
      result = {
        ok: false,
        failure: fail(
          filesSnapshotResult.code === 'RETAINED_PUBLISH_FAILED' ||
            filesSnapshotResult.code === 'RETAINED_DIRECTORY_SYNC_FAILED' ||
            filesSnapshotResult.code === 'RETAINED_CONFIRMATION_FAILED'
            ? 'publish-files-snapshot'
            : 'create-files-snapshot',
          'FILES_SNAPSHOT_FAILED',
          filesSnapshotResult.code,
          undefined
        )
      }
      return result
    }

    // --- Phase 10-11: catalog rollback snapshot (capture + durable write) --
    const cancelledBeforeCatalogCapture = checkCancelled(options.shouldAbort, fail, 'capture-catalog-snapshot')
    if (cancelledBeforeCatalogCapture !== null) {
      result = { ok: false, failure: cancelledBeforeCatalogCapture }
      return result
    }
    const boundary = options?.catalogBoundary
    if (!boundary) {
      result = {
        ok: false,
        failure: fail('capture-catalog-snapshot', 'CATALOG_SNAPSHOT_FAILED', 'NO_BOUNDARY', undefined)
      }
      return result
    }
    let captureResult: Awaited<ReturnType<CatalogSnapshotBoundary['captureSnapshot']>>
    try {
      captureResult = await boundary.captureSnapshot()
    } catch (error) {
      result = {
        ok: false,
        failure: fail('capture-catalog-snapshot', 'CATALOG_SNAPSHOT_FAILED', safeErrorCode(error), error)
      }
      return result
    }
    if (!captureResult.ok) {
      result = {
        ok: false,
        failure: fail('capture-catalog-snapshot', 'CATALOG_SNAPSHOT_FAILED', captureResult.code, undefined)
      }
      return result
    }
    const catalogSnapshotWrite = writeCatalogSnapshotDurable(captureResult.snapshot, dbDir)
    if (!catalogSnapshotWrite.ok) {
      result = {
        ok: false,
        failure: fail(
          catalogSnapshotFailurePhase(catalogSnapshotWrite.code),
          'CATALOG_SNAPSHOT_FAILED',
          catalogSnapshotWrite.code,
          undefined
        )
      }
      return result
    }

    // --- Phase 12: old generation receipts + journal `snapshots-ready` -----
    const cancelledBeforeSnapshotsReady = checkCancelled(options.shouldAbort, fail, 'journal-snapshots-ready')
    if (cancelledBeforeSnapshotsReady !== null) {
      result = { ok: false, failure: cancelledBeforeSnapshotsReady }
      return result
    }
    // old db receipt = hash of the retained db snapshot file.
    const oldDbReceipt = await computeDbReceipt(dbSnapshotResult.retainedPath)
    const oldReceipts: PromotionArtifactReceipts = {
      db: oldDbReceipt,
      files: filesSnapshotResult.receipt,
      catalog: {
        count: captureResult.snapshot.integrity.count,
        sha256: captureResult.snapshot.integrity.sha256
      }
    }
    const snapshotsReadyJournal: PromotionJournalV2 = {
      version: 2,
      sessionId: claim.sessionId,
      candidateId: claim.candidateId,
      phase: 'snapshots-ready',
      receipts: { candidate: candidateReceipts, old: oldReceipts }
    }
    try {
      await advancePromotionJournalV2(snapshotsReadyJournal, 'candidates-ready', dbDir)
    } catch (error) {
      result = {
        ok: false,
        failure: fail('journal-snapshots-ready', 'JOURNAL_WRITE_FAILED', safeErrorCode(error), error)
      }
      return result
    }

    // --- Phase 13: Return prepared handle ----------------------------------
    const handle = createPreparedHandle(
      claim.token,
      claim.sessionId,
      claim.candidateId,
      dbSnapshotResult.retainedPath,
      claim.dbPath,
      filesSnapshotResult.retainedDir,
      catalogSnapshotWrite.snapshotPath,
      { candidate: candidateReceipts, old: oldReceipts },
      leaseHandle
    )

    logger.info(
      'Promotion preparation complete (v2): db + Files + catalog snapshots retained, ' +
        'journal at snapshots-ready, lease held'
    )

    result = { ok: true, handle }
    return result
  } catch (error) {
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
// Internal: files receipt from catalog rows (shared derivation)
// ---------------------------------------------------------------------------

/** Derive the candidate files receipt from the candidate catalog rows. */
function computeFilesReceiptFromCatalog(
  rows: readonly { name: string; size: number; sha256: string }[]
): PromotionJournalFilesReceipt {
  return computeFilesReceipt(rows.map((row) => ({ name: row.name, size: row.size, sha256: row.sha256 })))
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
  retainedFilesSnapshotDir: string,
  catalogSnapshotPath: string,
  receipts: { candidate: PromotionArtifactReceipts; old: PromotionArtifactReceipts },
  leaseHandle: PromotionLeaseHandle
): PreparedPromotionHandle {
  let disposed = false
  let consumed = false

  // LOCK-PREP-8 branding/immutability: the receipts block is deep-frozen so
  // neither the handle nor the executing capability can mutate the
  // journaled-generation facts (the durable journal remains the truth, but
  // the in-memory branding is tamper-evident too).
  const frozenReceipts = Object.freeze({
    candidate: Object.freeze({
      db: receipts.candidate.db,
      files: receipts.candidate.files,
      catalog: receipts.candidate.catalog
    }),
    old: Object.freeze({ db: receipts.old.db, files: receipts.old.files, catalog: receipts.old.catalog })
  })

  const handle: PreparedPromotionHandle = {
    token,
    sessionId,
    candidateId,
    retainedSnapshotPath,
    candidateDbPath,

    consume(): PreparedPromotionConsumeResult {
      // Exact-once (LOCK-4421): a disposed or already-consumed handle can
      // never yield the destructive capability.
      if (disposed) {
        return { ok: false, reason: 'disposed' }
      }
      if (consumed) {
        return { ok: false, reason: 'already-consumed' }
      }
      consumed = true

      // Ownership transfer (LOCK-4422): the capability retains the SAME
      // lease handle — no release/reacquire, no second mutex.
      let released = false
      const capability: ExecutingPromotionCapability = Object.freeze({
        token,
        sessionId,
        candidateId,
        retainedSnapshotPath,
        candidateDbPath,
        retainedFilesSnapshotDir,
        catalogSnapshotPath,
        receipts: frozenReceipts,
        authorization: leaseHandle,

        release(): void {
          if (released) return
          released = true
          leaseHandle.release()
          logger.info(`Executing promotion capability released for session ${sessionId} (lease released)`)
        },

        isReleased(): boolean {
          return released
        }
      })

      logger.info(
        `Prepared promotion handle consumed for session ${sessionId} ` +
          '(lease ownership transferred to the executing capability)'
      )
      return { ok: true, capability }
    },

    isConsumed(): boolean {
      return consumed
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      if (consumed) {
        // Stale disposer (LOCK-4421): ownership already transferred — the
        // executing capability owns the release. Never pull the lease out
        // from under it.
        logger.info(
          `Prepared promotion handle disposed after consume for session ${sessionId} ` +
            '(lease retained by the executing capability)'
        )
        return
      }
      leaseHandle.release()
      logger.info(`Prepared promotion handle disposed for session ${sessionId} (lease released)`)
    },

    isDisposed(): boolean {
      return disposed
    }
  }
  // LOCK-PREP-8: the handle itself is frozen — fields can never be
  // reassigned or forged after minting (the closure owns the one-shot state).
  return Object.freeze(handle)
}
