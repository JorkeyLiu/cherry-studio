/**
 * Promotion journal store — crash-safe fixed-path persistence
 * (Phase 4.4.1, LOCK-4411..LOCK-4417; Phase 4.4.2, LOCK-4423..LOCK-4425;
 * Phase 4.4.3, LOCK-4435..LOCK-4438).
 *
 * This module is the ONLY writer/reader/cleaner of the on-disk promotion
 * journal. It owns exactly one fixed path under a provided controlled Data
 * root: `<dataRoot>/chat-import-promotion.journal.json` (the fixed
 * {@link PROMOTION_JOURNAL_FILENAME} from the pure codec). Callers can never
 * supply a journal path — the API accepts only the controlled Data root
 * (identical to the candidateDb `dataRoot` injection pattern) and every
 * artifact location is derived from fixed owned filenames.
 *
 * Storage-only bound (LOCK-4412): this unit provides durable storage. It
 * does NOT create snapshots, install candidates, verify anything, or decide
 * when a write is allowed beyond the gates below — the caller must have
 * proven the phase-entry precondition (retained snapshot, durable install,
 * successful verification) before invoking the corresponding write.
 *
 * Phase gates (LOCK-4417 initial write; LOCK-4423/LOCK-4424 transitions):
 * - `snapshot-ready` is the ONLY phase writable without a prior journal,
 *   via {@link writeSnapshotReadyPromotionJournal} (unchanged 4.4.1 API).
 * - `candidate-installed` is writable ONLY via
 *   {@link advancePromotionJournalToCandidateInstalled}, which requires the
 *   current durable journal to be valid, in phase `snapshot-ready`, with the
 *   identical version/sessionId/candidateId. The caller must have completed
 *   the durable candidate install first (LOCK-4423) — the store cannot
 *   perform or check the install itself.
 * - `replacement-verified` is writable ONLY via
 *   {@link advancePromotionJournalToReplacementVerified}, which requires the
 *   current durable journal to be valid, in phase `candidate-installed`,
 *   with the identical identity. The caller must have completed successful
 *   post-install verification first (LOCK-4424).
 * Any absent/invalid/mismatching prior journal rejects the transition
 * BEFORE any staging or publish mutation, and the current durable journal
 * is never deleted or cleared on failure (LOCK-4425).
 *
 * Durable replacement ordering (LOCK-4413 — the journal is the durable
 * truth source; no mtime inference anywhere):
 *   1. open sibling staging file (same directory ⇒ same filesystem, so the
 *      publish rename is atomic)
 *   2. write the canonical encoded bytes through the FileHandle
 *   3. fsync the staging file (FileHandle.sync)
 *   4. close the staging FileHandle
 *   5. atomic rename staging → fixed journal path
 *   6. fsync the parent directory so the rename itself is durable
 *      (supported and required on darwin; see the win32 note below)
 *
 * Failure containment (LOCK-4411): a failure in any step affects only this
 * write's staging artifact. The staging file is removed best-effort on every
 * ordinary failure before the publish rename; a previously published journal
 * is never touched by a failed write.
 *
 * Read semantics (LOCK-4414): strict three-state result —
 *   - `absent`  : ONLY ENOENT at the fixed path
 *   - `invalid` : bytes were read but the strict v1 codec rejected them
 *   - `valid`   : bytes decoded to a v1 journal
 * Any other I/O failure (EACCES, EISDIR, EIO, …) throws a structured
 * {@link PromotionJournalStoreError} with code `READ_IO_FAILED` — an I/O
 * failure is NEVER reported as `absent` (and never as `invalid` either,
 * because unreadable is not the same evidence as readable-but-rejected).
 *
 * Cleanup semantics (Phase 4.4.3, LOCK-4435..LOCK-4438):
 * - The cleanup APIs (`cleanupPromotionJournalAfterReplacementVerified`,
 *   `cleanupPromotionJournalAfterSnapshotReady`,
 *   `cleanupPromotionJournalAfterCandidateInstalled` for the v1 protocol,
 *   and `cleanupPromotionJournalAtV2Phase` for the v2 protocol) share one
 *   idempotent fixed-path primitive: remove the promotion journal and any
 *   stale staging file, then fsync the parent directory for durability.
 * - Guard-read validates the current journal: absent journals are idempotent
 *   success (already clean); valid journals must match the caller's expected
 *   schema version, phase, and identity (sessionId/candidateId) before
 *   unlink. The version bound is symmetric (LOCK-CLOSE-1): a v1 cleanup
 *   never removes a v2 journal and a v2 cleanup never removes a v1 journal —
 *   both reject with `CLEANUP_PHASE_MISMATCH`.
 * - The rollback snapshot (`ROLLBACK_SNAPSHOT_FILENAME`) is NEVER touched.
 * - ENOENT during the unlink step is idempotent only when the guard read
 *   observed the journal as absent (immediate return) or the file was
 *   concurrently removed after the guard read confirmed its presence. In
 *   both cases the cleanup goal is achieved and parent dir sync follows.
 * - A successful or absent return means the journal is absent from disk
 *   with parent directory sync completed (where deletion occurred).
 *
 * Directory-sync platform note (decision under Phase 4.4.1 decision
 * rights): on win32 directory handles cannot be fsynced, so step 6 is
 * skipped there (macOS-first; darwin always executes it). On POSIX,
 * `EINVAL`/`ENOTSUP`/`EPERM` from the directory open/fsync are categorized
 * as `PARENT_DIR_SYNC_UNSUPPORTED` (filesystem cannot durably sync
 * directories — e.g. some network mounts); every other failure is
 * `PARENT_DIR_SYNC_FAILED`. Both are thrown: the journal bytes are already
 * published at that point, but durability of the rename is unproven, so the
 * caller must not treat the write as durably committed.
 *
 * Main-only module. Not exposed over IPC/preload/renderer.
 */

import type { FileHandle } from 'node:fs/promises'
import fs from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import { DATA_PATH } from '@main/config'

import type {
  PromotionJournalDecodeErrorCode,
  PromotionJournalDoc,
  PromotionJournalPhase,
  PromotionJournalPhaseV2,
  PromotionJournalV1,
  PromotionJournalV2,
  PromotionJournalVersion
} from './journal'
import {
  artifactReceiptsEqual,
  catalogReceiptsEqual,
  dbReceiptsEqual,
  decodePromotionJournal,
  encodePromotionJournal,
  filesReceiptsEqual,
  isV2SuccessorPhase,
  PROMOTION_JOURNAL_FILENAME,
  PROMOTION_JOURNAL_VERSION_V1,
  PROMOTION_JOURNAL_VERSION_V2
} from './journal'

const logger = loggerService.withContext('chatDbImportPromotionJournalStore')

// ---------------------------------------------------------------------------
// Constants — fixed owned filenames (never caller-supplied)
// ---------------------------------------------------------------------------

/**
 * Fixed sibling staging filename for the crash-safe replacement write.
 * Derives from the fixed journal filename so the publish step is always a
 * same-directory (same-filesystem) atomic rename.
 */
export const PROMOTION_JOURNAL_STAGING_FILENAME = `${PROMOTION_JOURNAL_FILENAME}.staging`

/** The single phase writable without a prior journal (LOCK-4417). */
const INITIAL_WRITABLE_PHASE = 'snapshot-ready' as const

// ---------------------------------------------------------------------------
// Structured errors
// ---------------------------------------------------------------------------

/** Machine-readable store failure codes (bounded; never carry content). */
export type PromotionJournalStoreErrorCode =
  | 'DATA_ROOT_REJECTED'
  | 'PHASE_NOT_WRITABLE'
  | 'JOURNAL_ENCODE_REJECTED'
  | 'STAGING_WRITE_FAILED'
  | 'STAGING_SYNC_FAILED'
  | 'STAGING_CLOSE_FAILED'
  | 'PUBLISH_RENAME_FAILED'
  | 'PARENT_DIR_SYNC_FAILED'
  | 'PARENT_DIR_SYNC_UNSUPPORTED'
  | 'READ_IO_FAILED'
  // Phase 4.4.2 transition guard rejections (all pre-mutation):
  | 'TRANSITION_JOURNAL_ABSENT'
  | 'TRANSITION_JOURNAL_INVALID'
  | 'TRANSITION_PHASE_MISMATCH'
  | 'TRANSITION_IDENTITY_MISMATCH'
  // Phase 4.4.3 cleanup rejections and failures:
  | 'CLEANUP_JOURNAL_ABSENT'
  | 'CLEANUP_JOURNAL_INVALID'
  | 'CLEANUP_PHASE_MISMATCH'
  | 'CLEANUP_IDENTITY_MISMATCH'
  | 'CLEANUP_UNLINK_FAILED'
  | 'CLEANUP_PARENT_DIR_SYNC_FAILED'
  | 'CLEANUP_PARENT_DIR_SYNC_UNSUPPORTED'
  | 'CLEANUP_STAGING_UNLINK_FAILED'

/**
 * Structured store error. `code` is the bounded machine-readable category;
 * `cause` preserves the underlying failure for logging/diagnosis.
 */
export class PromotionJournalStoreError extends Error {
  readonly code: PromotionJournalStoreErrorCode
  readonly cause?: unknown

  constructor(code: PromotionJournalStoreErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'PromotionJournalStoreError'
    this.code = code
    this.cause = cause
  }
}

function storeError(
  code: PromotionJournalStoreErrorCode,
  message: string,
  cause?: unknown
): PromotionJournalStoreError {
  return new PromotionJournalStoreError(code, message, cause)
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code ?? undefined
}

// ---------------------------------------------------------------------------
// Read result — strict three-state (LOCK-4414)
// ---------------------------------------------------------------------------

/**
 * Strict three-state read result. Shape-compatible with the recovery
 * matrix's PromotionJournalObservation; `invalid` additionally carries the
 * bounded codec rejection code for diagnostics. A `valid` result carries
 * either a v1 (chat.db-only) or v2 (three-artifact) journal document.
 */
export type PromotionJournalStoreReadResult =
  | { readonly status: 'absent' }
  | { readonly status: 'invalid'; readonly code: PromotionJournalDecodeErrorCode }
  | { readonly status: 'valid'; readonly journal: PromotionJournalDoc }

// ---------------------------------------------------------------------------
// Fixed owned path resolution
// ---------------------------------------------------------------------------

/**
 * Reject anything that is not a plausible controlled Data root. The store
 * never accepts a journal path — only the Data root — and every location is
 * `<dataRoot>/<fixed filename>`.
 */
function assertControlledDataRoot(dataRoot: string): void {
  if (typeof dataRoot !== 'string' || dataRoot.length === 0 || dataRoot.includes('\0')) {
    throw storeError('DATA_ROOT_REJECTED', 'Promotion journal store requires a non-empty controlled data root.')
  }
}

/** Resolve the single fixed owned journal path under a controlled Data root. */
export function getPromotionJournalPath(dataRoot: string = DATA_PATH): string {
  assertControlledDataRoot(dataRoot)
  return path.join(dataRoot, PROMOTION_JOURNAL_FILENAME)
}

/** Resolve the fixed sibling staging path (same directory as the journal). */
export function getPromotionJournalStagingPath(dataRoot: string = DATA_PATH): string {
  assertControlledDataRoot(dataRoot)
  return path.join(dataRoot, PROMOTION_JOURNAL_STAGING_FILENAME)
}

// ---------------------------------------------------------------------------
// Read — strict three-state; I/O failure is a distinct structured error
// ---------------------------------------------------------------------------

/**
 * Read the journal at the fixed owned path.
 *
 * - ENOENT (and only ENOENT) ⇒ `absent` (LOCK-4414).
 * - Readable bytes rejected by the strict codec ⇒ `invalid` (+ codec code).
 * - Readable bytes accepted ⇒ `valid`.
 * - Any other I/O failure ⇒ throws {@link PromotionJournalStoreError}
 *   with code `READ_IO_FAILED` — never mapped to `absent`.
 */
export async function readPromotionJournal(dataRoot: string = DATA_PATH): Promise<PromotionJournalStoreReadResult> {
  const journalPath = getPromotionJournalPath(dataRoot)

  let raw: string
  try {
    raw = await fs.readFile(journalPath, 'utf8')
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      return { status: 'absent' }
    }
    throw storeError('READ_IO_FAILED', 'Failed to read the promotion journal (I/O failure, not absent).', error)
  }

  const decoded = decodePromotionJournal(raw)
  if (!decoded.ok) {
    return { status: 'invalid', code: decoded.code }
  }
  return { status: 'valid', journal: decoded.journal }
}

// ---------------------------------------------------------------------------
// Write — private durable writer + phase-gated public APIs
// ---------------------------------------------------------------------------

/**
 * Private durable writer — the six-step crash-safe replacement body shared
 * by every public write API. NOT exported: an unrestricted generic journal
 * writer must never be public (phase gating is the public surface).
 *
 * Ordering: sibling staging open → write → file fsync → close → atomic
 * same-directory rename → parent directory fsync (darwin/POSIX; skipped on
 * win32).
 *
 * Failure behavior (LOCK-4411/LOCK-4425): on any ordinary failure before
 * the publish rename completes, this write's staging artifact is removed
 * best-effort and a structured {@link PromotionJournalStoreError} is thrown.
 * A previously published journal is never modified, deleted, or cleared by
 * a failed write.
 */
async function writePromotionJournalDurably(journal: PromotionJournalDoc, dataRoot: string): Promise<void> {
  const journalPath = getPromotionJournalPath(dataRoot)
  const stagingPath = getPromotionJournalStagingPath(dataRoot)

  let encoded: string
  try {
    encoded = encodePromotionJournal(journal)
  } catch (error) {
    throw storeError('JOURNAL_ENCODE_REJECTED', 'Promotion journal failed strict encode validation.', error)
  }

  let handle: FileHandle | null = null
  let stagingOnDisk = false
  try {
    // 1. Open the sibling staging file (same directory ⇒ atomic rename later).
    try {
      handle = await fs.open(stagingPath, 'w', 0o600)
    } catch (error) {
      throw storeError('STAGING_WRITE_FAILED', 'Failed to open the promotion journal staging file.', error)
    }
    stagingOnDisk = true

    // 2. Write the canonical bytes through the FileHandle.
    try {
      await handle.writeFile(encoded, 'utf8')
    } catch (error) {
      throw storeError('STAGING_WRITE_FAILED', 'Failed to write the promotion journal staging bytes.', error)
    }

    // 3. fsync the staging file content before publish.
    try {
      await handle.sync()
    } catch (error) {
      throw storeError('STAGING_SYNC_FAILED', 'Failed to fsync the promotion journal staging file.', error)
    }

    // 4. Close the staging handle before rename.
    try {
      await handle.close()
      handle = null
    } catch (error) {
      handle = null
      throw storeError('STAGING_CLOSE_FAILED', 'Failed to close the promotion journal staging file.', error)
    }

    // 5. Atomic same-directory publish rename.
    try {
      await fs.rename(stagingPath, journalPath)
      stagingOnDisk = false
    } catch (error) {
      throw storeError('PUBLISH_RENAME_FAILED', 'Failed to atomically publish the promotion journal.', error)
    }
  } catch (error) {
    // LOCK-4411: contain the failure to this write's staging artifact.
    if (handle !== null) {
      try {
        await handle.close()
      } catch {
        // best-effort close; the primary error wins
      }
    }
    if (stagingOnDisk) {
      try {
        await fs.unlink(stagingPath)
      } catch (cleanupError) {
        if (errnoCode(cleanupError) !== 'ENOENT') {
          logger.warn('Failed to clean promotion journal staging file after write failure', {
            code: errnoCode(cleanupError)
          })
        }
      }
    }
    throw error
  }

  // 6. Make the rename itself durable by fsyncing the parent directory.
  await syncParentDirectory(dataRoot)
}

/**
 * Durably persist a `snapshot-ready` v1 journal at the fixed owned path.
 * This is the ONLY v1 write that does not require a prior journal.
 *
 * Phase gate (LOCK-4417): any phase other than `snapshot-ready` is rejected
 * with `PHASE_NOT_WRITABLE` before any filesystem effect. Later phases must
 * go through the explicit transition APIs below. The caller must already
 * hold a retained, verified rollback snapshot (LOCK-4412) — this unit is
 * storage only and cannot check that precondition.
 */
export async function writeSnapshotReadyPromotionJournal(
  journal: PromotionJournalDoc,
  dataRoot: string = DATA_PATH
): Promise<void> {
  assertControlledDataRoot(dataRoot)

  if (journal.version !== 1 || journal.phase !== INITIAL_WRITABLE_PHASE) {
    throw storeError(
      'PHASE_NOT_WRITABLE',
      `Promotion journal store refuses phase "${String(journal.phase)}": ` +
        `only "${INITIAL_WRITABLE_PHASE}" may be persisted without a prior journal (LOCK-4417); ` +
        'later phases require the explicit transition APIs.'
    )
  }

  await writePromotionJournalDurably(journal, dataRoot)
}

// ---------------------------------------------------------------------------
// v2 initial write + guarded phase transitions (LOCK-PROMO-2/3/6)
// ---------------------------------------------------------------------------

/**
 * Durably persist a `candidates-ready` v2 journal — the initial v2 write.
 *
 * Phase gate (LOCK-PROMO-2): any phase other than `candidates-ready` is
 * rejected with `PHASE_NOT_WRITABLE` before any filesystem effect. The
 * caller must already hold the three validated candidate artifacts (sealed
 * chat.db, candidate Files dir, files-catalog.json) and must supply the
 * candidate-generation aggregate receipts.
 */
export async function writeCandidatesReadyPromotionJournal(
  journal: PromotionJournalV2,
  dataRoot: string = DATA_PATH
): Promise<void> {
  assertControlledDataRoot(dataRoot)

  if (journal.version !== PROMOTION_JOURNAL_VERSION_V2 || journal.phase !== 'candidates-ready') {
    throw storeError(
      'PHASE_NOT_WRITABLE',
      `Promotion journal store refuses phase "${String(journal.phase)}": ` +
        'only "candidates-ready" may be persisted as the initial v2 write.'
    )
  }

  await writePromotionJournalDurably(journal, dataRoot)
}

/**
 * v2 guarded advance: `prior` → `next` where `next` is the strict successor
 * of `prior` in the v2 phase order (no skips, regressions, or repeats).
 *
 * Guard (all checks happen BEFORE any staging/publish mutation; the current
 * durable journal is never modified by a rejection):
 * - the current durable journal must be a VALID v2 document;
 * - its phase must be exactly `expectedPriorPhase` and `next` must be its
 *   strict successor (`isV2SuccessorPhase`);
 * - version/sessionId/candidateId must be identical;
 * - the candidate receipts must be strictly equal (immutable once written);
 * - the old receipts must be monotonic: each artifact field may only go
 *   null → value or stay equal (they are filled exactly once at
 *   `snapshots-ready`, never reverted).
 *
 * The caller must have completed the durable operation the phase names
 * (LOCK-PROMO-6 ordering) BEFORE invoking the corresponding advance — the
 * store is storage only and cannot perform or check the operation itself.
 */
export async function advancePromotionJournalV2(
  journal: PromotionJournalV2,
  expectedPriorPhase: PromotionJournalPhaseV2,
  dataRoot: string = DATA_PATH
): Promise<void> {
  assertControlledDataRoot(dataRoot)

  if (journal.version !== PROMOTION_JOURNAL_VERSION_V2) {
    throw storeError('PHASE_NOT_WRITABLE', 'advancePromotionJournalV2 requires a v2 journal document.')
  }
  if (!isV2SuccessorPhase(expectedPriorPhase, journal.phase)) {
    throw storeError(
      'PHASE_NOT_WRITABLE',
      `advancePromotionJournalV2 refuses phase "${journal.phase}": ` +
        `"${expectedPriorPhase}" is not its strict predecessor in the v2 phase order.`
    )
  }

  const current = await readPromotionJournal(dataRoot)

  if (current.status === 'absent') {
    throw storeError(
      'TRANSITION_JOURNAL_ABSENT',
      `Cannot advance the promotion journal to "${journal.phase}": no durable journal exists at the fixed path.`
    )
  }
  if (current.status === 'invalid') {
    throw storeError(
      'TRANSITION_JOURNAL_INVALID',
      `Cannot advance the promotion journal to "${journal.phase}": ` +
        `the current durable journal failed strict decoding (${current.code}).`
    )
  }
  const prior = current.journal
  if (prior.version !== PROMOTION_JOURNAL_VERSION_V2) {
    throw storeError(
      'TRANSITION_PHASE_MISMATCH',
      `Cannot advance the promotion journal to "${journal.phase}": ` +
        'the current durable journal is v1 (chat.db-only protocol) — ' +
        'a v2 three-artifact promotion may never continue a v1 journal.'
    )
  }
  if (prior.phase !== expectedPriorPhase) {
    throw storeError(
      'TRANSITION_PHASE_MISMATCH',
      `Cannot advance the promotion journal to "${journal.phase}": ` +
        `current phase is "${prior.phase}" but exactly "${expectedPriorPhase}" is required ` +
        '(no skips, regressions, or repeats).'
    )
  }
  if (prior.sessionId !== journal.sessionId || prior.candidateId !== journal.candidateId) {
    throw storeError(
      'TRANSITION_IDENTITY_MISMATCH',
      `Cannot advance the promotion journal to "${journal.phase}": ` +
        'sessionId/candidateId must be identical to the current durable journal ' +
        '(cross-session or cross-candidate replacement is forbidden).'
    )
  }
  if (!artifactReceiptsEqual(prior.receipts.candidate, journal.receipts.candidate)) {
    throw storeError(
      'TRANSITION_IDENTITY_MISMATCH',
      `Cannot advance the promotion journal to "${journal.phase}": ` +
        'candidate aggregate receipts must be immutable across transitions.'
    )
  }
  if (!oldReceiptsMonotonic(prior.receipts.old, journal.receipts.old)) {
    throw storeError(
      'TRANSITION_IDENTITY_MISMATCH',
      `Cannot advance the promotion journal to "${journal.phase}": ` +
        'old-generation aggregate receipts may only be filled in once (monotonic).'
    )
  }

  await writePromotionJournalDurably(journal, dataRoot)
}

/** True when `next.old` only fills in previously-null fields of `prior.old`. */
function oldReceiptsMonotonic(
  prior: PromotionJournalV2['receipts']['old'],
  next: PromotionJournalV2['receipts']['old']
): boolean {
  return (
    oldReceiptFieldMonotonic(prior.db, next.db, dbReceiptsEqual) &&
    oldReceiptFieldMonotonic(prior.files, next.files, filesReceiptsEqual) &&
    oldReceiptFieldMonotonic(prior.catalog, next.catalog, catalogReceiptsEqual)
  )
}

/**
 * Canonical per-field monotonicity: `null → any` (fill-in once) or equal is
 * monotonic; `value → null` (regression) and `value → different value` are
 * not. Comparison is key-order independent (LOCK-CLOSE-2).
 */
function oldReceiptFieldMonotonic<T>(
  prior: T | null,
  next: T | null,
  equal: (a: T | null, b: T | null) => boolean
): boolean {
  if (prior === null) return true
  if (next === null) return false
  return equal(prior, next)
}

// ---------------------------------------------------------------------------
// Guarded phase transitions (Phase 4.4.2, LOCK-4423..LOCK-4425)
// ---------------------------------------------------------------------------

/**
 * Guard shared by both transition APIs: read the current durable journal
 * and require it to be `valid`, in exactly `expectedPriorPhase`, with the
 * identical version/sessionId/candidateId as the requested `next` document.
 *
 * Every rejection here happens BEFORE any staging or publish mutation:
 * - absent journal            → TRANSITION_JOURNAL_ABSENT
 * - codec-invalid journal     → TRANSITION_JOURNAL_INVALID
 * - read I/O failure          → READ_IO_FAILED (propagated; never absent)
 * - wrong prior phase (skip,
 *   regression, or repeat)    → TRANSITION_PHASE_MISMATCH
 * - different sessionId /
 *   candidateId / version     → TRANSITION_IDENTITY_MISMATCH
 *
 * The current durable journal is never modified by a rejection
 * (LOCK-4425): rejecting is observation-only.
 */
async function assertTransitionPrecondition(
  next: PromotionJournalV1,
  expectedPriorPhase: PromotionJournalPhase,
  dataRoot: string
): Promise<void> {
  const current = await readPromotionJournal(dataRoot)

  if (current.status === 'absent') {
    throw storeError(
      'TRANSITION_JOURNAL_ABSENT',
      `Cannot advance the promotion journal to "${next.phase}": no durable journal exists at the fixed path.`
    )
  }
  if (current.status === 'invalid') {
    throw storeError(
      'TRANSITION_JOURNAL_INVALID',
      `Cannot advance the promotion journal to "${next.phase}": ` +
        `the current durable journal failed strict decoding (${current.code}).`
    )
  }

  const prior = current.journal
  if (prior.phase !== expectedPriorPhase) {
    throw storeError(
      'TRANSITION_PHASE_MISMATCH',
      `Cannot advance the promotion journal to "${next.phase}": ` +
        `current phase is "${prior.phase}" but exactly "${expectedPriorPhase}" is required ` +
        '(no skips, regressions, or repeats).'
    )
  }
  if (prior.version !== next.version || prior.sessionId !== next.sessionId || prior.candidateId !== next.candidateId) {
    throw storeError(
      'TRANSITION_IDENTITY_MISMATCH',
      `Cannot advance the promotion journal to "${next.phase}": ` +
        'version/sessionId/candidateId must be identical to the current durable journal ' +
        '(cross-session or cross-candidate replacement is forbidden).'
    )
  }
}

/**
 * Advance the durable journal `snapshot-ready` → `candidate-installed`.
 *
 * LOCK-4423: this write must follow the durable candidate install. The
 * expected prior phase (`snapshot-ready`) is explicit in this API's guard,
 * but the store cannot itself perform or verify the install — the caller
 * owns that precondition.
 *
 * The requested document must carry phase `candidate-installed` (anything
 * else is `PHASE_NOT_WRITABLE`) and the identical identity as the current
 * durable `snapshot-ready` journal. A rejected transition performs no
 * staging or publish mutation, and the current durable journal is preserved
 * on every failure (LOCK-4425).
 */
export async function advancePromotionJournalToCandidateInstalled(
  journal: PromotionJournalV1,
  dataRoot: string = DATA_PATH
): Promise<void> {
  assertControlledDataRoot(dataRoot)

  if (journal.phase !== 'candidate-installed') {
    throw storeError(
      'PHASE_NOT_WRITABLE',
      `advancePromotionJournalToCandidateInstalled refuses phase "${String(journal.phase)}": ` +
        'this API persists exactly "candidate-installed" (LOCK-4423).'
    )
  }

  await assertTransitionPrecondition(journal, 'snapshot-ready', dataRoot)
  await writePromotionJournalDurably(journal, dataRoot)
}

/**
 * Advance the durable journal `candidate-installed` → `replacement-verified`.
 *
 * LOCK-4424: this write must follow successful post-install verification;
 * it is a distinct explicit transition API. The store cannot itself perform
 * or check the verification — the caller owns that precondition.
 *
 * The requested document must carry phase `replacement-verified` (anything
 * else is `PHASE_NOT_WRITABLE`) and the identical identity as the current
 * durable `candidate-installed` journal. A rejected transition performs no
 * staging or publish mutation, and the current durable journal is preserved
 * on every failure (LOCK-4425).
 */
export async function advancePromotionJournalToReplacementVerified(
  journal: PromotionJournalV1,
  dataRoot: string = DATA_PATH
): Promise<void> {
  assertControlledDataRoot(dataRoot)

  if (journal.phase !== 'replacement-verified') {
    throw storeError(
      'PHASE_NOT_WRITABLE',
      `advancePromotionJournalToReplacementVerified refuses phase "${String(journal.phase)}": ` +
        'this API persists exactly "replacement-verified" (LOCK-4424).'
    )
  }

  await assertTransitionPrecondition(journal, 'candidate-installed', dataRoot)
  await writePromotionJournalDurably(journal, dataRoot)
}

// ---------------------------------------------------------------------------
// Cleanup — Phase 4.4.3 idempotent fixed-path removal (LOCK-4435..LOCK-4438)
// ---------------------------------------------------------------------------

/**
 * Identity bound for cleanup authorization. The caller supplies the
 * sessionId and candidateId the cleanup is finalizing; the store verifies
 * these match the durable journal before any unlink.
 */
export interface PromotionJournalCleanupIdentity {
  readonly sessionId: string
  readonly candidateId: string
}

/**
 * Result of {@link cleanupPromotionJournal}. Never throws for operational
 * failures — bounded machine-readable result. A successful or absent return
 * means the journal is absent from disk with parent directory sync completed
 * where deletion occurred (LOCK-4438).
 */
export type PromotionJournalCleanupResult =
  | {
      /** Journal was present and durably removed (unlink + parent dir sync). */
      readonly deleted: true
    }
  | {
      /** Journal was already absent; no unlink or sync needed. Idempotent. */
      readonly deleted: false
      readonly reason: 'already-absent'
    }

/**
 * Private cleanup body — the single implementation shared by all cleanup
 * APIs. Not exported: an unrestricted generic cleanup must never be public
 * (phase gating is the public surface).
 *
 * Operation:
 *   1. Guard-read the current durable journal.
 *   2. Absent → return idempotent success (already-absent, no sync needed).
 *   3. Invalid → reject CLEANUP_JOURNAL_INVALID (no unlink).
 *   4. Wrong schema version → reject CLEANUP_PHASE_MISMATCH (no unlink).
 *      Each cleanup API owns exactly one journal protocol: a v1 cleanup
 *      must NEVER remove a v2 journal (they share the `replacement-verified`
 *      phase — LOCK-CLOSE-1), and the v2 cleanup never removes a v1 journal.
 *   5. Valid but wrong phase → reject CLEANUP_PHASE_MISMATCH (no unlink).
 *   6. Valid but wrong identity → reject CLEANUP_IDENTITY_MISMATCH (no
 *      unlink).
 *   7. Valid and matches → unlink the fixed journal (ENOENT race is
 *      idempotent after confirmed presence).
 *   8. Best-effort unlink stale staging file (never a failure).
 *   9. Fsync parent directory for durability (LOCK-4438).
 *
 * LOCK-4436: only the fixed promotion journal and stale staging are
 * candidates for deletion. The rollback snapshot, candidate files, and live
 * chat.db are NEVER touched.
 *
 * LOCK-4435: caller must have the authoritative live fact (the replacement
 * is verified and installed) — this API only checks the journal identity
 * and phase; the caller owns the broader precondition.
 */
async function cleanupPromotionJournalBody(
  expectedPhase: PromotionJournalPhase,
  expectedIdentity: PromotionJournalCleanupIdentity,
  dataRoot: string,
  requiredVersion: PromotionJournalVersion
): Promise<PromotionJournalCleanupResult> {
  const journalPath = getPromotionJournalPath(dataRoot)
  const stagingPath = getPromotionJournalStagingPath(dataRoot)

  // 1. Guard-read the current durable journal.
  const current = await readPromotionJournal(dataRoot)

  // 2. Absent → idempotent success (LOCK-4436).
  if (current.status === 'absent') {
    return { deleted: false, reason: 'already-absent' }
  }

  // 3. Invalid → reject (no unlink, no mutation).
  if (current.status === 'invalid') {
    throw storeError(
      'CLEANUP_JOURNAL_INVALID',
      `Cannot clean up the promotion journal: the current durable journal failed strict decoding (${current.code}).`
    )
  }

  // 4. Schema-version mismatch → reject (LOCK-CLOSE-1 symmetric isolation).
  if (current.journal.version !== requiredVersion) {
    throw storeError(
      'CLEANUP_PHASE_MISMATCH',
      `Cannot clean up the promotion journal: the current durable journal is v${current.journal.version} ` +
        `but this cleanup API owns the v${requiredVersion} journal protocol ` +
        '(a v1 cleanup never removes a v2 journal and vice versa).'
    )
  }

  // 5. Phase mismatch → reject.
  if (current.journal.phase !== expectedPhase) {
    throw storeError(
      'CLEANUP_PHASE_MISMATCH',
      `Cannot clean up the promotion journal: current phase is "${current.journal.phase}" ` +
        `but exactly "${expectedPhase}" is required for cleanup.`
    )
  }

  // 6. Identity mismatch → reject.
  if (
    current.journal.sessionId !== expectedIdentity.sessionId ||
    current.journal.candidateId !== expectedIdentity.candidateId
  ) {
    throw storeError(
      'CLEANUP_IDENTITY_MISMATCH',
      'Cannot clean up the promotion journal: sessionId/candidateId do not match the expected identity.'
    )
  }

  // 7. Unlink the fixed journal (guard confirmed presence).
  try {
    await fs.unlink(journalPath)
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      // Concurrent removal after guard read confirmed presence — idempotent
      // for the cleanup goal (LOCK-4436). Proceed to dir sync.
    } else {
      throw storeError('CLEANUP_UNLINK_FAILED', 'Failed to unlink the promotion journal during cleanup.', error)
    }
  }

  // 8. Best-effort unlink of stale staging file (never a failure).
  try {
    await fs.unlink(stagingPath)
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') {
      logger.warn('Failed to clean promotion journal staging file during cleanup', {
        code: errnoCode(error)
      })
    }
  }

  // 9. Fsync parent directory for durability (LOCK-4438).
  await syncParentDirectoryForCleanup(dataRoot)

  return { deleted: true }
}

/**
 * Cleanup after replacement-verified — the primary Phase 4.4.3 cleanup
 * entry point. The caller (future recovery executor) must have the
 * authoritative live fact: the replacement is installed and verified. This
 * API only verifies the journal matches the expected phase and identity
 * before unlink.
 *
 * LOCK-4435: caller precondition — the replacement must be verified.
 * LOCK-4436: only the fixed journal and stale staging are deleted; snapshot
 * retained.
 * LOCK-4438: a successful return means the journal is absent with parent
 * directory sync completed; relaunch may proceed only then.
 */
export async function cleanupPromotionJournalAfterReplacementVerified(
  expectedIdentity: PromotionJournalCleanupIdentity,
  dataRoot: string = DATA_PATH
): Promise<PromotionJournalCleanupResult> {
  assertControlledDataRoot(dataRoot)
  return cleanupPromotionJournalBody('replacement-verified', expectedIdentity, dataRoot, PROMOTION_JOURNAL_VERSION_V1)
}

/**
 * Cleanup after snapshot-ready — used during rollback-authorized recovery
 * when the snapshot-ready journal must be cleaned before restoring the
 * rollback snapshot. The caller must have the authoritative live fact: the
 * rollback is authorized and the snapshot is retained.
 *
 * LOCK-4435: caller precondition — rollback must be authorized.
 * LOCK-4436: only the fixed journal and stale staging are deleted; snapshot
 * retained.
 * LOCK-4438: a successful return means the journal is absent with parent
 * directory sync completed.
 */
export async function cleanupPromotionJournalAfterSnapshotReady(
  expectedIdentity: PromotionJournalCleanupIdentity,
  dataRoot: string = DATA_PATH
): Promise<PromotionJournalCleanupResult> {
  assertControlledDataRoot(dataRoot)
  return cleanupPromotionJournalBody('snapshot-ready', expectedIdentity, dataRoot, PROMOTION_JOURNAL_VERSION_V1)
}

/**
 * Cleanup after candidate-installed — used during keep-old-live recovery
 * when the snapshot-ready journal must be cleaned while the live DB is
 * still intact and no destructive install occurred. The caller must have
 * the authoritative live fact: the live DB is the correct current state.
 *
 * LOCK-4435: caller precondition — the live DB is the authoritative state.
 * LOCK-4436: only the fixed journal and stale staging are deleted; snapshot
 * retained.
 * LOCK-4438: a successful return means the journal is absent with parent
 * directory sync completed.
 */
export async function cleanupPromotionJournalAfterCandidateInstalled(
  expectedIdentity: PromotionJournalCleanupIdentity,
  dataRoot: string = DATA_PATH
): Promise<PromotionJournalCleanupResult> {
  assertControlledDataRoot(dataRoot)
  return cleanupPromotionJournalBody('candidate-installed', expectedIdentity, dataRoot, PROMOTION_JOURNAL_VERSION_V1)
}

/**
 * v2 cleanup — remove the fixed journal when it is a valid v2 document at
 * exactly `expectedPhase` with the matching identity (LOCK-PROMO-6:
 * rollback completion cleans up whatever v2 phase the journal was at).
 *
 * The shared cleanup body enforces the schema-version bound symmetrically:
 * a v2 cleanup only ever removes a v2 journal (a v1 journal is rejected
 * with CLEANUP_PHASE_MISMATCH — LOCK-CLOSE-1).
 *
 * LOCK-4436: only the fixed promotion journal and stale staging are
 * candidates for deletion. Snapshots, candidate files, and live artifacts
 * are NEVER touched.
 */
export async function cleanupPromotionJournalAtV2Phase(
  expectedPhase: PromotionJournalPhaseV2,
  expectedIdentity: PromotionJournalCleanupIdentity,
  dataRoot: string = DATA_PATH
): Promise<PromotionJournalCleanupResult> {
  assertControlledDataRoot(dataRoot)
  return cleanupPromotionJournalBody(expectedPhase, expectedIdentity, dataRoot, PROMOTION_JOURNAL_VERSION_V2)
}

/**
 * fsync the journal's parent directory so the cleanup unlink survives a
 * crash/power loss (required and supported on darwin). Skipped on win32
 * where directory handles cannot be fsynced. On POSIX, EINVAL/ENOTSUP/EPERM
 * map to `PARENT_DIR_SYNC_UNSUPPORTED`; everything else maps to
 * `PARENT_DIR_SYNC_FAILED`.
 *
 * This is a separate function from the write-path `syncParentDirectory`
 * because the cleanup context has different error semantics: the unlink
 * already happened and the caller needs to know durability is unproven.
 */
async function syncParentDirectoryForCleanup(dir: string): Promise<void> {
  if (process.platform === 'win32') {
    return
  }

  let dirHandle: FileHandle | null = null
  try {
    dirHandle = await fs.open(dir, 'r')
    await dirHandle.sync()
  } catch (error) {
    const code = errnoCode(error)
    if (code === 'EINVAL' || code === 'ENOTSUP' || code === 'EPERM') {
      throw storeError(
        'CLEANUP_PARENT_DIR_SYNC_UNSUPPORTED',
        'This filesystem does not support directory fsync; the promotion journal cleanup is not proven durable.',
        error
      )
    }
    throw storeError(
      'CLEANUP_PARENT_DIR_SYNC_FAILED',
      'Failed to fsync the promotion journal parent directory during cleanup; the deletion is not proven durable.',
      error
    )
  } finally {
    if (dirHandle !== null) {
      try {
        await dirHandle.close()
      } catch {
        // best-effort close
      }
    }
  }
}

/**
 * fsync the journal's parent directory so the publish rename survives a
 * crash/power loss (required and supported on darwin). Skipped on win32
 * where directory handles cannot be fsynced. On POSIX, EINVAL/ENOTSUP/EPERM
 * map to `PARENT_DIR_SYNC_UNSUPPORTED`; everything else maps to
 * `PARENT_DIR_SYNC_FAILED`. See the module header for the categorization
 * decision.
 */
async function syncParentDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') {
    // Directory fsync is not available on win32; the file itself was
    // fsynced. macOS-first: darwin always takes the sync path below.
    return
  }

  let dirHandle: FileHandle | null = null
  try {
    dirHandle = await fs.open(dir, 'r')
    await dirHandle.sync()
  } catch (error) {
    const code = errnoCode(error)
    if (code === 'EINVAL' || code === 'ENOTSUP' || code === 'EPERM') {
      throw storeError(
        'PARENT_DIR_SYNC_UNSUPPORTED',
        'This filesystem does not support directory fsync; the promotion journal publish is not proven durable.',
        error
      )
    }
    throw storeError(
      'PARENT_DIR_SYNC_FAILED',
      'Failed to fsync the promotion journal parent directory; the publish is not proven durable.',
      error
    )
  } finally {
    if (dirHandle !== null) {
      try {
        await dirHandle.close()
      } catch {
        // best-effort close
      }
    }
  }
}
