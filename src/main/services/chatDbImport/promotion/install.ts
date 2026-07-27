/**
 * Candidate installation primitive — atomic rename of the sealed owned
 * candidate DB to the live path (Phase 4.4.2, LOCK-4423/4425/4426/4427).
 *
 * This unit is a bounded primitive, NOT the promotion executor. It never
 * closes/reopens the live DB, never writes the promotion journal (the
 * caller may journal `candidate-installed` only after an `ok: true`
 * result, LOCK-4423), never restores the rollback snapshot, and never
 * relaunches (LOCK-4428).
 *
 * Operation (all synchronous — no interleaving inside the primitive):
 *
 *   validate candidate ownership/existence/sealed state
 *   → validate + consume the closed-live proof (LOCK-4427)
 *   → delete live WAL/SHM sidecars
 *   → capture source stat identity (bigint dev/ino/size)
 *   → fsync source → atomic rename source → live (same filesystem ONLY)
 *   → fsync live parent directory → destination stat identity confirmation
 *   → return an InstallReceipt binding the source identity to the live path
 *
 * Locked semantics:
 * - LOCK-4423: success is returned only after the rename, the parent
 *   directory fsync, AND the destination identity confirmation.
 * - LOCK-4425: once the rename happened, every failure is classified
 *   `post-install` and ALL artifacts are retained — no rollback, no
 *   snapshot/journal cleanup, no destination deletion.
 * - LOCK-4426: rename only, same-filesystem. EXDEV maps to the bounded
 *   `RENAME_CROSS_DEVICE` failure; there is NO copy fallback.
 * - LOCK-4427: live sidecars are deleted only after a verified closed-live
 *   proof. The proof is a Main-local, module-branded, single-use token
 *   that only {@link mintClosedLiveProof} can create, and minting requires
 *   the CURRENTLY HELD promotion lease (validated through the
 *   maintenanceCoordination seam) plus a live-closed witness. The future
 *   authorized close (executor) mints it immediately after a successful
 *   `ChatDbService.closeForPromotion`.
 *
 * Path safety: no arbitrary external paths. The live path is derived from
 * the Data root; the source path is derived from the strict owned
 * candidate ID (the exact owned directory leaf, LOCK-4415) under the
 * owned candidate root, with containment re-checked defence-in-depth.
 *
 * Main-only module. Not exposed over IPC/preload/renderer.
 */

import fs from 'node:fs'
import path from 'node:path'

import { loggerService } from '@logger'
import { DATA_PATH } from '@main/config'
import {
  getSharedMaintenanceCoordinator,
  type MaintenanceCoordinator,
  type PromotionAuthorizationRefusalReason,
  type PromotionLeaseHandle,
  validatePromotionAuthorization
} from '@main/services/chatDb/maintenanceCoordination'

import { CANDIDATE_DB_FILENAME, getCandidateRoot, getOwnedCandidateDirName } from '../candidateDb'
import { fsyncDirectory, fsyncFile, safeErrorCode } from './readonlyDbValidation'

const logger = loggerService.withContext('chatDbImportPromotionInstall')

/** Live database filename — always derived from the Data root. */
const LIVE_DB_FILENAME = 'chat.db'

// ---------------------------------------------------------------------------
// Closed-live proof (LOCK-4427)
// ---------------------------------------------------------------------------

/**
 * Live-closed witness the minter checks at mint time and the installer
 * re-checks immediately before sidecar deletion. The future authorized
 * close passes `() => !chatDbService.isInitialised()` right after a
 * successful `closeForPromotion` (during the promotion window no repair
 * marker can appear, so `isInitialised() === false` is a faithful
 * closed-handles witness there).
 */
export interface ClosedLiveWitness {
  /** True while the live DB service holds no open handles. */
  isLiveClosed(): boolean
}

/**
 * Opaque single-use closed-live precondition token (LOCK-4427). Only
 * {@link mintClosedLiveProof} can create a valid one — a structurally
 * identical object forged elsewhere is never registered in the
 * module-private brand and is refused by {@link installCandidate}.
 */
export interface ClosedLiveProof {
  /** Bounded owner label of the authorizing promotion lease (no paths). */
  readonly ownerId: string
}

interface ClosedLiveProofRecord {
  readonly authorization: PromotionLeaseHandle
  readonly coordinator: MaintenanceCoordinator
  readonly witness: ClosedLiveWitness
  consumed: boolean
}

/** Module-private brand: proof object → its minting evidence. */
const closedLiveProofRecords = new WeakMap<ClosedLiveProof, ClosedLiveProofRecord>()

/** Result of {@link mintClosedLiveProof}. Bounded refusals, never throws. */
export type MintClosedLiveProofResult =
  | { readonly ok: true; readonly proof: ClosedLiveProof }
  | {
      readonly ok: false
      readonly reason: 'authorization-invalid'
      readonly authorizationReason: PromotionAuthorizationRefusalReason
    }
  | { readonly ok: false; readonly reason: 'live-not-closed' }

export interface MintClosedLiveProofOptions {
  /** The continuously held promotion lease authorization (LOCK-4422). */
  authorization: PromotionLeaseHandle
  /** Live-closed witness — checked at mint AND re-checked at install. */
  witness: ClosedLiveWitness
  /** Coordinator the authorization must currently hold (default: shared). */
  coordinator?: MaintenanceCoordinator
}

/**
 * Mint the single-use closed-live precondition token (LOCK-4427).
 *
 * Requires the CURRENTLY HELD promotion lease (validated through the
 * unforgeable maintenanceCoordination grant registry) and a witness that
 * reports the live DB closed RIGHT NOW. Intended caller: the future
 * promotion executor, immediately after a successful authorized
 * `closeForPromotion`. The token cannot be forged, cannot be minted
 * before an authorized close reports closed handles, and is consumed by
 * the first destructive use in {@link installCandidate}.
 */
export function mintClosedLiveProof(options: MintClosedLiveProofOptions): MintClosedLiveProofResult {
  const coordinator = options.coordinator ?? getSharedMaintenanceCoordinator()

  const verdict = validatePromotionAuthorization(options.authorization, coordinator)
  if (!verdict.authorized) {
    logger.warn(`Closed-live proof mint refused: promotion authorization invalid (${verdict.reason})`)
    return { ok: false, reason: 'authorization-invalid', authorizationReason: verdict.reason }
  }

  if (options.witness.isLiveClosed() !== true) {
    logger.warn('Closed-live proof mint refused: live DB witness reports open handles')
    return { ok: false, reason: 'live-not-closed' }
  }

  const proof: ClosedLiveProof = Object.freeze({ ownerId: verdict.ownerId })
  closedLiveProofRecords.set(proof, {
    authorization: options.authorization,
    coordinator,
    witness: options.witness,
    consumed: false
  })
  logger.info('Closed-live proof minted (single-use, bound to the held promotion lease)')
  return { ok: true, proof }
}

// ---------------------------------------------------------------------------
// Install receipt — binds source identity to the live path
// ---------------------------------------------------------------------------

/**
 * Stable stat identity of one file object. Captured with bigint stats so
 * 64-bit APFS inode numbers compare exactly on the supported darwin
 * contract. `dev`/`ino` identify the file object across the rename;
 * `size` is the sealed byte length at install time.
 */
export interface FileStatIdentity {
  readonly dev: bigint
  readonly ino: bigint
  readonly size: bigint
}

/**
 * Receipt of a durably confirmed candidate installation (LOCK-4423).
 * Module-branded: {@link isInstallReceipt} proves it was produced by a
 * successful {@link installCandidate} and not forged.
 */
export interface InstallReceipt {
  /** Exact owned candidate ID (directory leaf) that was installed. */
  readonly candidateId: string
  /** Absolute live path the candidate now occupies. */
  readonly livePath: string
  /** Source identity captured before the rename, confirmed at the live path. */
  readonly identity: FileStatIdentity
  /** Wall-clock install completion (diagnostic only). */
  readonly installedAtMs: number
}

const installReceiptBrand = new WeakSet<InstallReceipt>()

/** True when `value` is a receipt minted by a successful install. */
export function isInstallReceipt(value: unknown): value is InstallReceipt {
  return typeof value === 'object' && value !== null && installReceiptBrand.has(value as InstallReceipt)
}

// ---------------------------------------------------------------------------
// Failure taxonomy — pre-install vs post-install (LOCK-4425)
// ---------------------------------------------------------------------------

/**
 * Bounded install failure codes.
 *
 * Pre-install (the live chat.db file was NOT replaced; at worst the live
 * sidecars of the already-closed live DB were removed):
 *   CANDIDATE_ID_INVALID | CANDIDATE_MISSING | CANDIDATE_NOT_SEALED |
 *   CLOSED_LIVE_PROOF_INVALID | LIVE_SIDECAR_DELETE_FAILED |
 *   SOURCE_STAT_FAILED | SOURCE_DURABILITY_FAILED |
 *   RENAME_CROSS_DEVICE | RENAME_FAILED
 *
 * Post-install (the rename ALREADY happened — artifacts retained, no
 * rollback/cleanup, LOCK-4425):
 *   LIVE_DIRECTORY_SYNC_FAILED | DESTINATION_STAT_FAILED |
 *   DESTINATION_IDENTITY_MISMATCH
 */
export type CandidateInstallFailureCode =
  | 'CANDIDATE_ID_INVALID'
  | 'CANDIDATE_MISSING'
  | 'CANDIDATE_NOT_SEALED'
  | 'CLOSED_LIVE_PROOF_INVALID'
  | 'LIVE_SIDECAR_DELETE_FAILED'
  | 'SOURCE_STAT_FAILED'
  | 'SOURCE_DURABILITY_FAILED'
  | 'RENAME_CROSS_DEVICE'
  | 'RENAME_FAILED'
  | 'LIVE_DIRECTORY_SYNC_FAILED'
  | 'DESTINATION_STAT_FAILED'
  | 'DESTINATION_IDENTITY_MISMATCH'

/** Failure classification relative to the destructive rename (LOCK-4425). */
export type CandidateInstallFailurePhase = 'pre-install' | 'post-install'

/** Result of {@link installCandidate}. Never throws for operational failures. */
export type CandidateInstallResult =
  | { readonly ok: true; readonly receipt: InstallReceipt }
  | {
      readonly ok: false
      readonly phase: CandidateInstallFailurePhase
      readonly code: CandidateInstallFailureCode
      /** Safe machine sub-code (error code/name only — never messages/paths). */
      readonly safeCode: string | null
    }

export interface InstallCandidateOptions {
  /** Exact owned candidate ID — the owned directory leaf (LOCK-4415). */
  candidateId: string
  /** Verified single-use closed-live precondition token (LOCK-4427). */
  proof: ClosedLiveProof
  /** Data root containing the live chat.db. Defaults to DATA_PATH. */
  dataRoot?: string
  /** Test-only hook after source fsync, before the atomic rename. */
  onBeforeRename?: () => void
  /** Test-only hook after the rename, before the parent-directory fsync. */
  onAfterRename?: () => void
}

function preFailure(code: CandidateInstallFailureCode, safeCode: string | null): CandidateInstallResult {
  logger.warn(`Candidate install failed pre-install (${code}): ${safeCode ?? 'no sub-code'}`)
  return Object.freeze({ ok: false as const, phase: 'pre-install' as const, code, safeCode })
}

function postFailure(code: CandidateInstallFailureCode, safeCode: string | null): CandidateInstallResult {
  logger.warn(`Candidate install failed post-install (${code}) — artifacts retained, no rollback (LOCK-4425)`)
  return Object.freeze({ ok: false as const, phase: 'post-install' as const, code, safeCode })
}

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

// ---------------------------------------------------------------------------
// installCandidate — the sole destructive entry
// ---------------------------------------------------------------------------

/**
 * Install the sealed owned candidate DB at the live path with durability
 * confirmation (LOCK-4423). Fully synchronous: validation, proof
 * consumption, sidecar deletion, rename, syncs, and confirmation run
 * without interleaving on the Main thread.
 *
 * The proof is consumed exactly when the destructive window opens (just
 * before sidecar deletion). Failures BEFORE that point leave the proof
 * unconsumed so a corrected retry can reuse it while the promotion lease
 * is still held and the live DB is still closed.
 */
export function installCandidate(options: InstallCandidateOptions): CandidateInstallResult {
  const dataRoot = options.dataRoot ?? DATA_PATH
  const livePath = path.resolve(path.join(dataRoot, LIVE_DB_FILENAME))

  // --- Owned candidate path resolution + containment (LOCK-4415) ---------
  let sourcePath: string
  try {
    const leaf = getOwnedCandidateDirName(options.candidateId)
    const candidateRoot = path.resolve(getCandidateRoot(dataRoot))
    sourcePath = path.resolve(path.join(candidateRoot, leaf, CANDIDATE_DB_FILENAME))
    // Defence-in-depth: the source must stay strictly inside the owned root
    // and can never be the live DB itself.
    if (sourcePath !== path.join(candidateRoot, leaf, CANDIDATE_DB_FILENAME)) {
      return preFailure('CANDIDATE_ID_INVALID', 'PATH_ESCAPED_OWNED_ROOT')
    }
    if (!sourcePath.startsWith(candidateRoot + path.sep)) {
      return preFailure('CANDIDATE_ID_INVALID', 'PATH_ESCAPED_OWNED_ROOT')
    }
    if (sourcePath === livePath) {
      return preFailure('CANDIDATE_ID_INVALID', 'SOURCE_IS_LIVE_PATH')
    }
  } catch {
    return preFailure('CANDIDATE_ID_INVALID', 'ID_ALLOWLIST_REJECTED')
  }

  // --- Closed-live proof validation (LOCK-4427) — BEFORE anything else
  //     destructive; re-validated as one atomic synchronous block with the
  //     consumption + sidecar deletion below. -----------------------------
  const record = closedLiveProofRecords.get(options.proof)
  if (record === undefined) {
    return preFailure('CLOSED_LIVE_PROOF_INVALID', 'UNRECOGNIZED')
  }
  if (record.consumed) {
    return preFailure('CLOSED_LIVE_PROOF_INVALID', 'CONSUMED')
  }
  const verdict = validatePromotionAuthorization(record.authorization, record.coordinator)
  if (!verdict.authorized) {
    return preFailure('CLOSED_LIVE_PROOF_INVALID', `AUTHORIZATION_${verdict.reason.replace(/-/g, '_').toUpperCase()}`)
  }
  // Bind the proof to THIS candidate: the promotion lease is acquired with
  // ownerId === candidateId (preparation contract), so a proof minted for a
  // different promotion can never install this candidate.
  if (options.proof.ownerId !== options.candidateId || verdict.ownerId !== options.candidateId) {
    return preFailure('CLOSED_LIVE_PROOF_INVALID', 'OWNER_MISMATCH')
  }
  // TOCTOU re-check: the witness must STILL report closed handles.
  if (record.witness.isLiveClosed() !== true) {
    return preFailure('CLOSED_LIVE_PROOF_INVALID', 'LIVE_NOT_CLOSED')
  }

  // --- Candidate existence -------------------------------------------------
  try {
    if (!fs.statSync(sourcePath).isFile()) {
      return preFailure('CANDIDATE_MISSING', 'NOT_A_FILE')
    }
  } catch (error) {
    return preFailure('CANDIDATE_MISSING', safeErrorCode(error))
  }

  // --- Sealed state, where provable at this layer --------------------------
  // A sealed candidate was closed by better-sqlite3, which checkpoints and
  // removes its WAL/SHM sidecars. A present sidecar proves the candidate is
  // NOT sealed (or a writer crashed mid-flight) — refuse.
  for (const sidecar of [`${sourcePath}-wal`, `${sourcePath}-shm`]) {
    if (fs.existsSync(sidecar)) {
      return preFailure('CANDIDATE_NOT_SEALED', 'SIDECAR_PRESENT')
    }
  }

  // --- Destructive window opens: consume the proof (single-use), then
  //     remove live sidecars (LOCK-4427). ---------------------------------
  record.consumed = true

  for (const sidecar of [`${livePath}-wal`, `${livePath}-shm`]) {
    try {
      fs.unlinkSync(sidecar)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue
      return preFailure('LIVE_SIDECAR_DELETE_FAILED', safeErrorCode(error))
    }
  }

  // --- Source identity capture (binds the receipt to the file object) -----
  let sourceIdentity: FileStatIdentity
  try {
    sourceIdentity = statIdentity(sourcePath)
  } catch (error) {
    return preFailure('SOURCE_STAT_FAILED', safeErrorCode(error))
  }

  // --- Source durability before the rename (LOCK-4423) --------------------
  try {
    fsyncFile(sourcePath)
  } catch (error) {
    return preFailure('SOURCE_DURABILITY_FAILED', safeErrorCode(error))
  }

  // --- Atomic rename, same-filesystem ONLY (LOCK-4426) --------------------
  try {
    options.onBeforeRename?.()
    fs.renameSync(sourcePath, livePath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'EXDEV') {
      // LOCK-4426: cross-device is a structured failure — NEVER a copy
      // fallback. The live DB file and the candidate are both untouched.
      return preFailure('RENAME_CROSS_DEVICE', 'EXDEV')
    }
    return preFailure('RENAME_FAILED', safeErrorCode(error))
  }

  // ======= Rename happened: every failure below is post-install ===========
  // LOCK-4425: artifacts are retained on every path below — no rollback, no
  // snapshot/journal cleanup, no destination deletion.

  options.onAfterRename?.()

  // --- Live parent directory sync (POSIX durability, LOCK-4423) -----------
  try {
    fsyncDirectory(dataRoot)
  } catch (error) {
    return postFailure('LIVE_DIRECTORY_SYNC_FAILED', safeErrorCode(error))
  }

  // --- Destination identity confirmation (LOCK-4423 fact confirmation) ----
  let destinationIdentity: FileStatIdentity
  try {
    destinationIdentity = statIdentity(livePath)
  } catch (error) {
    return postFailure('DESTINATION_STAT_FAILED', safeErrorCode(error))
  }
  if (
    destinationIdentity.dev !== sourceIdentity.dev ||
    destinationIdentity.ino !== sourceIdentity.ino ||
    destinationIdentity.size !== sourceIdentity.size
  ) {
    return postFailure('DESTINATION_IDENTITY_MISMATCH', 'STAT_IDENTITY_DIVERGED')
  }

  const receipt: InstallReceipt = Object.freeze({
    candidateId: options.candidateId,
    livePath,
    identity: sourceIdentity,
    installedAtMs: Date.now()
  })
  installReceiptBrand.add(receipt)

  logger.info(`Candidate ${options.candidateId} installed at the live path (rename durable, identity confirmed)`)
  return Object.freeze({ ok: true as const, receipt })
}
