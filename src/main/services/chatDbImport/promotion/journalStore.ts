/**
 * Promotion journal store — crash-safe fixed-path persistence
 * (Phase 4.4.1, LOCK-4411..LOCK-4417).
 *
 * This module is the ONLY writer/reader of the on-disk promotion journal.
 * It owns exactly one fixed path under a provided controlled Data root:
 * `<dataRoot>/chat-import-promotion.journal.json` (the fixed
 * {@link PROMOTION_JOURNAL_FILENAME} from the pure codec). Callers can never
 * supply a journal path — the API accepts only the controlled Data root
 * (identical to the candidateDb `dataRoot` injection pattern) and every
 * artifact location is derived from fixed owned filenames.
 *
 * Storage-only bound (LOCK-4412): this unit provides durable storage. It
 * does NOT create snapshots, verify anything, or decide when a write is
 * allowed beyond the phase gate below — the caller must have proven the
 * retained rollback snapshot before invoking the write.
 *
 * Phase gate (LOCK-4417): the maximum phase this unit will ever persist is
 * `snapshot-ready`. Writes of `candidate-installed` / `replacement-verified`
 * are rejected before any filesystem effect.
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

import type { PromotionJournalDecodeErrorCode, PromotionJournalV1 } from './journal'
import { decodePromotionJournal, encodePromotionJournal, PROMOTION_JOURNAL_FILENAME } from './journal'

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

/** The single phase this store is allowed to persist (LOCK-4417). */
const MAX_WRITABLE_PHASE = 'snapshot-ready' as const

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
 * bounded codec rejection code for diagnostics.
 */
export type PromotionJournalStoreReadResult =
  | { readonly status: 'absent' }
  | { readonly status: 'invalid'; readonly code: PromotionJournalDecodeErrorCode }
  | { readonly status: 'valid'; readonly journal: PromotionJournalV1 }

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
// Write — snapshot-ready only, durable replacement ordering
// ---------------------------------------------------------------------------

/**
 * Durably persist a `snapshot-ready` v1 journal at the fixed owned path.
 *
 * Ordering: sibling staging write via FileHandle → file fsync → close →
 * atomic rename → parent directory fsync (darwin/POSIX; skipped on win32).
 *
 * Phase gate (LOCK-4417): any phase other than `snapshot-ready` is rejected
 * with `PHASE_NOT_WRITABLE` before any filesystem effect. The caller must
 * already hold a retained, verified rollback snapshot (LOCK-4412) — this
 * unit is storage only and cannot check that precondition.
 *
 * Failure behavior (LOCK-4411): on any ordinary failure before the publish
 * rename completes, this write's staging artifact is removed best-effort and
 * a structured {@link PromotionJournalStoreError} is thrown. A previously
 * published journal is never modified by a failed write.
 */
export async function writeSnapshotReadyPromotionJournal(
  journal: PromotionJournalV1,
  dataRoot: string = DATA_PATH
): Promise<void> {
  const journalPath = getPromotionJournalPath(dataRoot)
  const stagingPath = getPromotionJournalStagingPath(dataRoot)

  if (journal.phase !== MAX_WRITABLE_PHASE) {
    throw storeError(
      'PHASE_NOT_WRITABLE',
      `Promotion journal store refuses phase "${String(journal.phase)}": ` +
        `only "${MAX_WRITABLE_PHASE}" may be persisted by this unit (LOCK-4417).`
    )
  }

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
