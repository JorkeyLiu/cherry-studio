/**
 * Candidate Files directory installation primitive — same-filesystem
 * directory rename/swap (Phase 2 L2 promotion, LOCK-PROMO-4/6/9).
 *
 * Installs the sealed candidate `Files/` directory at the live `Files/`
 * path using atomic directory renames ONLY — never per-file overwrite of
 * the live Files dir:
 *
 *   1. resolve + validate the owned candidate Files dir and its catalog.
 *   2. pre-flight: verify the CANDIDATE Files dir against ITS OWN catalog
 *      (row↔filename↔size↔SHA-256 parity, LOCK-PROMO-9) — the candidate
 *      generation is the payload being installed; the retained Files
 *      snapshot is the rollback authority but is never read here.
 *   3. atomic rename live Files → swap-staging (`Files.promote-staging`),
 *      when a live dir exists (the live path becomes ABSENT atomically).
 *   4. atomic rename candidate Files → live Files (the live path becomes
 *      ONE complete directory atomically — no partial live directories).
 *   5. fsync the parent directory.
 *   6. verify the installed live Files against the candidate catalog
 *      (row↔filename↔size↔SHA-256 parity, LOCK-PROMO-9).
 *   7. remove the swap-staging dir (the previous live generation — fully
 *      retained by the retained Files snapshot, so removal is safe).
 *   8. fsync again; return the install receipt + derived aggregate receipt.
 *
 * Empty/missing live Files is first-class: step 3 is a no-op when the live
 * dir is genuinely absent (ENOENT), and an empty candidate catalog installs
 * a `kind: 'empty'` generation. A BROKEN SYMLINK at the live path is PRESENT
 * tamper — it is swapped to swap-staging (evidence retained), never treated
 * as absent (audit F2).
 *
 * Failure taxonomy (LOCK-4425 analog):
 * - pre-install (the candidate → live rename did NOT happen): the live
 *   path is either the old dir or absent; artifacts retained for retry.
 * - post-install (the candidate → live rename ALREADY happened): every
 *   artifact retained, no rollback/cleanup here — deterministic recovery
 *   owns further decisions.
 *
 * This unit NEVER closes/reopens the live DB, never writes the promotion
 * journal, and never relaunches. Main-only module.
 */

import fs from 'node:fs'
import path from 'node:path'

import { loggerService } from '@logger'
import { DATA_PATH } from '@main/config'

import { readAndValidateCatalog } from '../attachmentPlane'
import { getCandidateRoot, getOwnedCandidateDirName } from '../candidateDb'
import { verifyFilesDirAgainstCatalog } from './catalogParity'
import { resolveLiveFilesDir } from './filesSnapshot'
import type { PromotionJournalFilesReceipt } from './journal'
import { FILES_PROMOTE_STAGING_DIRNAME } from './journal'
import { fsyncDirectory, safeErrorCode } from './readonlyDbValidation'

const logger = loggerService.withContext('chatDbImportFilesInstall')

/** Candidate Files directory name inside the owned candidate dir. */
export const CANDIDATE_FILES_DIRNAME = 'Files'

/** Candidate catalog handoff filename inside the owned candidate dir. */
export const CANDIDATE_CATALOG_FILENAME = 'files-catalog.json'

/** Bounded files-install failure codes. */
export type FilesInstallFailureCode =
  | 'CANDIDATE_ID_INVALID'
  | 'CANDIDATE_FILES_MISSING'
  | 'CANDIDATE_CATALOG_INVALID'
  | 'SWAP_STAGING_CLEANUP_FAILED'
  | 'LIVE_SWAP_RENAME_FAILED'
  | 'CANDIDATE_SWAP_RENAME_FAILED'
  | 'CANDIDATE_SWAP_CROSS_DEVICE'
  | 'PARENT_DIR_SYNC_FAILED'
  | 'INSTALLED_PARITY_FAILED'
  | 'SWAP_STAGING_REMOVE_FAILED'
  | 'POST_SYNC_FAILED'

/** Failure classification relative to the candidate→live rename. */
export type FilesInstallFailurePhase = 'pre-install' | 'post-install'

/** Result of {@link installCandidateFiles}. Never throws. */
export type FilesInstallResult =
  | {
      readonly ok: true
      /** Aggregate receipt of the installed (candidate) Files generation. */
      readonly receipt: PromotionJournalFilesReceipt
      readonly kind: 'empty' | 'populated'
      /** Absolute path of the installed live Files dir. */
      readonly liveFilesDir: string
    }
  | {
      readonly ok: false
      readonly phase: FilesInstallFailurePhase
      readonly code: FilesInstallFailureCode
      readonly safeCode: string | null
    }

export interface InstallCandidateFilesOptions {
  /** Exact owned candidate ID — the owned directory leaf (LOCK-4415). */
  candidateId: string
  /** Data root containing the live Files dir. Defaults to DATA_PATH. */
  dataRoot?: string
  /** Test-only hook before the live→swap rename (live intact). */
  onBeforeLiveSwap?: () => void
  /** Test-only hook after live→swap, before candidate→live rename. */
  onAfterLiveSwap?: () => void
  /** Test-only hook after the candidate→live rename, before verification. */
  onAfterCandidateSwap?: () => void
}

/** Resolve the candidate Files dir from a validated candidate ID. */
export function resolveCandidateFilesDir(candidateId: string, dataRoot: string = DATA_PATH): string {
  const leaf = getOwnedCandidateDirName(candidateId)
  const candidateRoot = path.resolve(getCandidateRoot(dataRoot))
  const candidateDir = path.resolve(path.join(candidateRoot, leaf))
  return path.join(candidateDir, CANDIDATE_FILES_DIRNAME)
}

/** Resolve the candidate catalog handoff path from a validated candidate ID. */
export function resolveCandidateCatalogPath(candidateId: string, dataRoot: string = DATA_PATH): string {
  const leaf = getOwnedCandidateDirName(candidateId)
  const candidateRoot = path.resolve(getCandidateRoot(dataRoot))
  const candidateDir = path.resolve(path.join(candidateRoot, leaf))
  return path.join(candidateDir, CANDIDATE_CATALOG_FILENAME)
}

function preFailure(code: FilesInstallFailureCode, safeCode: string | null): FilesInstallResult {
  logger.warn(`Candidate Files install failed pre-install (${code}): ${safeCode ?? 'no sub-code'}`)
  return Object.freeze({ ok: false as const, phase: 'pre-install' as const, code, safeCode })
}

function postFailure(code: FilesInstallFailureCode, safeCode: string | null): FilesInstallResult {
  logger.warn(`Candidate Files install failed post-install (${code}) — artifacts retained (LOCK-4425 analog)`)
  return Object.freeze({ ok: false as const, phase: 'post-install' as const, code, safeCode })
}

/**
 * lstat-based presence (audit F2): an entry is PRESENT when lstat succeeds —
 * a broken symlink is present tamper, never 'missing'. Returns false only
 * for a genuine ENOENT (or a stat error treated as absent). Never throws.
 */
function lstatPresent(p: string): boolean {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * Install the sealed candidate Files dir at the live path by atomic
 * same-filesystem directory rename/swap (LOCK-PROMO-4). Fully synchronous —
 * no interleaving inside the primitive.
 */
export function installCandidateFiles(options: InstallCandidateFilesOptions): FilesInstallResult {
  const dataRoot = options.dataRoot ?? DATA_PATH
  const liveFilesDir = resolveLiveFilesDir(dataRoot)
  const swapStagingDir = path.resolve(path.join(dataRoot, FILES_PROMOTE_STAGING_DIRNAME))

  // --- Owned candidate resolution + containment (LOCK-4415) ---------------
  let candidateFilesDir: string
  let candidateCatalogPath: string
  try {
    candidateFilesDir = resolveCandidateFilesDir(options.candidateId, dataRoot)
    candidateCatalogPath = resolveCandidateCatalogPath(options.candidateId, dataRoot)
  } catch {
    return preFailure('CANDIDATE_ID_INVALID', 'ID_ALLOWLIST_REJECTED')
  }
  if (candidateFilesDir === liveFilesDir || candidateFilesDir.startsWith(liveFilesDir + path.sep)) {
    return preFailure('CANDIDATE_ID_INVALID', 'PATH_ESCAPED_OWNED_ROOT')
  }

  // --- Candidate catalog must be valid (row↔file parity source) -----------
  const catalog = readAndValidateCatalog(candidateCatalogPath)
  if (catalog === null) {
    return preFailure('CANDIDATE_CATALOG_INVALID', 'CATALOG_UNREADABLE')
  }
  const catalogEntries = catalog.rows.map((row) => ({ name: row.name, size: row.size, sha256: row.sha256 }))

  // --- Candidate Files dir existence --------------------------------------
  try {
    // lstat (audit F2): a symlinked candidate root (broken or working) is
    // NOT the owned directory — never followed into a directory elsewhere.
    // A genuine ENOENT is classified 'MISSING'; any other present state that
    // is not a real directory is 'NOT_A_DIRECTORY' (tamper).
    const candidateStat = fs.lstatSync(candidateFilesDir)
    if (!candidateStat.isDirectory()) {
      return preFailure('CANDIDATE_FILES_MISSING', 'NOT_A_DIRECTORY')
    }
  } catch (error) {
    const code = safeErrorCode(error)
    return preFailure('CANDIDATE_FILES_MISSING', code === 'ENOENT' ? 'MISSING' : code)
  }

  // --- Pre-flight: the candidate Files dir must match its own catalog -----
  const preFlight = verifyFilesDirAgainstCatalog(candidateFilesDir, catalogEntries)
  if (!preFlight.ok) {
    return preFailure(
      'CANDIDATE_FILES_MISSING',
      preFlight.code === 'CATALOG_INVALID' ? 'CATALOG_INVALID' : `CANDIDATE_PARITY_${preFlight.code}`
    )
  }

  // --- Atomic swap ---------------------------------------------------------
  // Clean any stale swap-staging from an earlier interrupted attempt (ours
  // to discard — it is the old live generation, fully retained by the
  // retained Files snapshot).
  try {
    fs.rmSync(swapStagingDir, { recursive: true, force: true })
  } catch (error) {
    return preFailure('SWAP_STAGING_CLEANUP_FAILED', safeErrorCode(error))
  }

  options.onBeforeLiveSwap?.()

  // Step A: atomic removal of the live dir (when present).
  // lstat-based presence (audit F2): a broken symlink at the live path is
  // PRESENT tamper — it is swapped to swap-staging (evidence retained), never
  // silently treated as absent and overwritten by the candidate rename.
  try {
    if (lstatPresent(liveFilesDir)) {
      fs.renameSync(liveFilesDir, swapStagingDir)
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    return preFailure('LIVE_SWAP_RENAME_FAILED', safeErrorCode(error) ?? code ?? 'RENAME_FAILED')
  }

  options.onAfterLiveSwap?.()

  // ======= Step B: candidate → live rename. A failure here means the
  // ======= candidate → live rename did NOT happen (pre-install taxonomy):
  // ======= the live path is absent (swapped away) and the old generation
  // ======= is fully retained at the swap-staging path for deterministic
  // ======= recovery. Only AFTER this rename succeeds are failures
  // ======= post-install (the live path already holds the candidate).
  try {
    fs.renameSync(candidateFilesDir, liveFilesDir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'EXDEV') {
      // LOCK-4426 analog: cross-device is a structured failure — NEVER a
      // copy fallback. The live path is currently absent (swapped away);
      // the swap-staging still holds the old generation.
      return preFailure('CANDIDATE_SWAP_CROSS_DEVICE', 'EXDEV')
    }
    return preFailure('CANDIDATE_SWAP_RENAME_FAILED', safeErrorCode(error))
  }

  options.onAfterCandidateSwap?.()

  try {
    fsyncDirectory(dataRoot)
  } catch (error) {
    return postFailure('PARENT_DIR_SYNC_FAILED', safeErrorCode(error))
  }

  // --- Verify the installed live Files against the candidate catalog -----
  const installed = verifyFilesDirAgainstCatalog(liveFilesDir, catalogEntries)
  if (!installed.ok) {
    return postFailure('INSTALLED_PARITY_FAILED', installed.code)
  }

  // --- Remove the swap-staging (old live generation; retained by snapshot)
  try {
    fs.rmSync(swapStagingDir, { recursive: true, force: true })
    fsyncDirectory(dataRoot)
  } catch (error) {
    return postFailure('SWAP_STAGING_REMOVE_FAILED', safeErrorCode(error))
  }

  logger.info(`Candidate Files installed at the live path (rename swap durable, parity verified)`)
  return Object.freeze({
    ok: true as const,
    receipt: installed.receipt,
    kind: installed.count === 0 ? ('empty' as const) : ('populated' as const),
    liveFilesDir
  })
}
