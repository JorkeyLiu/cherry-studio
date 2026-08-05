/**
 * Read-only promotion artifact probes (Phase 4.4.3, LOCK-4431/LOCK-4432).
 *
 * Produces deterministic live/snapshot/candidate statuses for
 * `decidePromotionRecovery()` BEFORE normal ChatDbService init, using only
 * fixed owned paths and proving the probe leaves no filesystem mutation.
 *
 * Path derivation (LOCK-4434):
 * - Live chat.db:    `<dataRoot>/chat.db`
 * - Retained snapshot: `<dataRoot>/chat.db.pre-import-backup`
 * - Candidate:       `<dataRoot>/chat-import-candidates/<candidateId>/chat.db`
 *   (candidateId is validated against the strict allowlist before resolving)
 *
 * Status mapping:
 * - Live/Snapshot: 'missing' | 'present-unverified' | 'present-verified'
 * - Candidate:    'missing' | 'present'
 *
 * Sidecar-free invariant (controlled no-residue strategy):
 * Better-sqlite3 with readonly=true still creates WAL/SHM sidecars on
 * some platforms/configurations. The probe implements a no-residue
 * strategy: after the readonly validation handle closes, any sidecar files
 * that appeared during the probe are detected and removed — every removal
 * is guarded (LOCK-CLOSE-4), so a cleanup failure is captured and logged
 * and never escapes the probe (never-throws contract). The composite probe
 * captures before/after directory snapshots to prove zero net filesystem
 * mutations: any residue a failed cleanup leaves behind flips the
 * `sidecarFree` gate closed. This is a controlled, bounded cleanup of
 * probe-owned residue only — never touching files that existed before the
 * probe.
 *
 * Structured error details: stat I/O failures and validation failures are
 * distinguished and yielded as structured probe result details, never
 * thrown to callers.
 *
 * Main-only module. Not exposed over IPC/preload/renderer.
 */

import fs from 'node:fs'
import path from 'node:path'

import { loggerService } from '@logger'
import { DATA_PATH } from '@main/config'

import { readAndValidateCatalog } from '../attachmentPlane'
import { isValidOwnedCandidateId } from '../candidateDb'
import { verifyFilesDirAgainstCatalog } from './catalogParity'
import { probeRetainedCatalogSnapshot } from './catalogSnapshot'
import { probeRetainedFilesSnapshot, resolveLiveFilesDir } from './filesSnapshot'
import { decodePromotionJournal, PROMOTION_JOURNAL_FILENAME, ROLLBACK_SNAPSHOT_FILENAME } from './journal'
import { FILES_PROMOTE_STAGING_DIRNAME } from './journal'
import { type ReadonlyChatDbValidationFailure, safeErrorCode, validateReadonlyChatDb } from './readonlyDbValidation'
import type { PromotionJournalObservation, PromotionRecoveryInput } from './recovery'

const logger = loggerService.withContext('chatDbImportArtifactProbe')

// ---------------------------------------------------------------------------
// Constants — fixed owned filenames (derived from journal.ts/candidateDb.ts)
// ---------------------------------------------------------------------------

/** Live database filename — always at the Data root. */
const LIVE_DB_FILENAME = 'chat.db'

/** Candidate root directory name (matches candidateDb.ts). */
const CANDIDATE_ROOT_DIRNAME = 'chat-import-candidates'

/** Candidate database filename inside the session directory. */
const CANDIDATE_DB_FILENAME = 'chat.db'

/** Sidecar file suffixes created by better-sqlite3 WAL mode. */
const SIDECAR_SUFFIXES = ['-wal', '-shm'] as const

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Stat operation failure details (distinguished from validation failure). */
export interface StatFailureDetail {
  readonly kind: 'stat-failure'
  readonly code: string
}

/** Validation failure details from validateReadonlyChatDb. */
export interface ValidationFailureDetail {
  readonly kind: 'validation-failure'
  readonly gate: ReadonlyChatDbValidationFailure['gate']
  readonly safeCode: string | null
}

/** Combined detail union for probe results. */
export type ProbeFailureDetail = StatFailureDetail | ValidationFailureDetail

/** Artifact probe result for a single artifact (live or snapshot). */
export interface ArtifactProbeResult {
  readonly status: 'missing' | 'present-unverified' | 'present-verified'
  /** Non-null only when status is 'present-unverified'. */
  readonly detail: ProbeFailureDetail | null
}

/** Candidate probe result (presence-only, no validation). */
export interface CandidateProbeResult {
  readonly status: 'missing' | 'present'
}

/** Directory snapshot for mutation detection (before/after probe). */
export interface DirectorySnapshot {
  readonly entries: string[]
  readonly totalBytes: number
}

/** Complete probe result for all promotion artifacts. */
export interface PromotionArtifactProbesResult {
  readonly journal: PromotionJournalObservation
  readonly live: ArtifactProbeResult
  readonly snapshot: ArtifactProbeResult
  readonly candidate: CandidateProbeResult
  /** True if the probe detected no filesystem mutations after cleanup. */
  readonly sidecarFree: boolean
  /** Mutation evidence: entries added/removed after the probe. */
  readonly mutationEvidence: {
    readonly added: readonly string[]
    readonly removed: readonly string[]
  }
  /**
   * Basenames of WAL/SHM sidecars that the probe created during its readonly
   * validation and successfully removed (probe-owned cleanup, reported by
   * the individual probes — LOCK-CLOSE-5). Never private paths. The
   * before/after directory diff cannot observe created-and-cleaned files,
   * so this is the probe's own evidence of its cleanup actions.
   */
  readonly cleanedSidecars: readonly string[]
}

// ---------------------------------------------------------------------------
// Path derivation helpers (LOCK-4434)
// ---------------------------------------------------------------------------

/** Resolve the live chat.db path from a controlled data root. */
export function resolveLiveDbPath(dataRoot: string = DATA_PATH): string {
  return path.resolve(path.join(dataRoot, LIVE_DB_FILENAME))
}

/** Resolve the retained rollback snapshot path from a controlled data root. */
export function resolveRetainedSnapshotPath(dataRoot: string = DATA_PATH): string {
  return path.resolve(path.join(dataRoot, ROLLBACK_SNAPSHOT_FILENAME))
}

/** Resolve the candidate db path from a validated candidate ID and data root. */
export function resolveCandidateDbPath(candidateId: string, dataRoot: string = DATA_PATH): string {
  const candidateRoot = path.resolve(path.join(dataRoot, CANDIDATE_ROOT_DIRNAME))
  const candidateDir = path.resolve(path.join(candidateRoot, candidateId))
  return path.resolve(path.join(candidateDir, CANDIDATE_DB_FILENAME))
}

// ---------------------------------------------------------------------------
// Directory snapshot helpers (mutation detection)
// ---------------------------------------------------------------------------

/** Capture a snapshot of directory entries and total file size. */
export function snapshotDirectory(dirPath: string): DirectorySnapshot {
  let entries: string[] = []
  try {
    entries = fs.readdirSync(dirPath)
  } catch {
    // Directory may not exist — empty snapshot is valid.
  }

  let totalBytes = 0
  for (const entry of entries) {
    try {
      const stat = fs.statSync(path.join(dirPath, entry))
      if (stat.isFile()) {
        totalBytes += stat.size
      }
    } catch {
      // Entry may disappear between readdir and stat — ignore.
    }
  }

  return { entries: entries.sort(), totalBytes }
}

/** Compare two snapshots and return added/removed entry names. */
export function diffDirectorySnapshots(
  before: DirectorySnapshot,
  after: DirectorySnapshot
): { readonly added: string[]; readonly removed: string[] } {
  const beforeSet = new Set(before.entries)
  const afterSet = new Set(after.entries)

  const added: string[] = []
  const removed: string[] = []

  for (const entry of afterSet) {
    if (!beforeSet.has(entry)) {
      added.push(entry)
    }
  }
  for (const entry of beforeSet) {
    if (!afterSet.has(entry)) {
      removed.push(entry)
    }
  }

  return { added: added.sort(), removed: removed.sort() }
}

// ---------------------------------------------------------------------------
// Sidecar detection and cleanup (controlled no-residue strategy)
// ---------------------------------------------------------------------------

/**
 * Synchronous file existence check.
 */
function fileExists(filePath: string): boolean {
  try {
    fs.statSync(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Remove probe-created WAL/SHM sidecars for one DB path (controlled
 * no-residue strategy — LOCK-CLOSE-4/F5).
 *
 * Only sidecars that did NOT exist before the probe are candidates: files
 * that pre-existed the probe are never touched. Every unlink is guarded —
 * a cleanup failure is captured, logged, and never escapes the probe (the
 * probe contract is never-throws). A failed cleanup leaves the sidecar on
 * disk, which the composite probe's directory-diff `sidecarFree` gate
 * detects and fails closed on.
 *
 * Returns the basenames of the sidecars this call successfully removed
 * (private-path-free diagnostic evidence).
 */
function cleanupCreatedSidecars(dbPath: string, hasWalBefore: boolean, hasShmBefore: boolean): string[] {
  const cleaned: string[] = []
  for (const suffix of SIDECAR_SUFFIXES) {
    const sidecarPath = `${dbPath}${suffix}`
    const existedBefore = suffix === '-wal' ? hasWalBefore : hasShmBefore
    if (!existedBefore && fileExists(sidecarPath)) {
      try {
        fs.unlinkSync(sidecarPath)
        cleaned.push(`${path.basename(dbPath)}${suffix}`)
      } catch (error) {
        logger.warn('Failed to clean probe-created sidecar during readonly probe (residue fails closed)', {
          code: safeErrorCode(error),
          file: `${path.basename(dbPath)}${suffix}`
        })
      }
    }
  }
  return cleaned
}

/** Internal probe result with the sidecar-cleanup evidence report. */
interface ProbeWithCleanupReport {
  readonly result: ArtifactProbeResult
  /** Basenames of sidecars created during probing and successfully removed. */
  readonly cleanedSidecars: string[]
}

// ---------------------------------------------------------------------------
// Individual artifact probes
// ---------------------------------------------------------------------------

/**
 * Probe the live chat.db: stat → validateReadonlyChatDb → cleanup sidecars → status.
 *
 * Opens the database strictly readonly with `fileMustExist: true`. The
 * validation handle closes on every outcome. Any WAL/SHM sidecars created
 * by better-sqlite3 during the probe are cleaned up (no-residue strategy).
 * Returns structured detail for stat I/O and validation failures.
 */
export function probeLiveDb(dataRoot: string = DATA_PATH, sampleCount: number = 3): ArtifactProbeResult {
  return probeLiveDbWithCleanupReport(dataRoot, sampleCount).result
}

/** {@link probeLiveDb} plus the basenames of sidecars it actually removed. */
function probeLiveDbWithCleanupReport(dataRoot: string, sampleCount: number): ProbeWithCleanupReport {
  const dbPath = resolveLiveDbPath(dataRoot)

  // --- Stat check ---------------------------------------------------------
  // lstat (audit F4): a symlinked DB root (broken or working) is tamper —
  // NOT_A_FILE, never followed into a valid-looking DB elsewhere.
  try {
    const stat = fs.lstatSync(dbPath)
    if (!stat.isFile()) {
      const detail: StatFailureDetail = { kind: 'stat-failure', code: 'NOT_A_FILE' }
      return { result: { status: 'present-unverified', detail }, cleanedSidecars: [] }
    }
  } catch (error) {
    const code = safeErrorCode(error)
    if (code === 'ENOENT') {
      return { result: { status: 'missing', detail: null }, cleanedSidecars: [] }
    }
    const detail: StatFailureDetail = { kind: 'stat-failure', code }
    return { result: { status: 'present-unverified', detail }, cleanedSidecars: [] }
  }

  // --- Capture pre-probe sidecar state ------------------------------------
  const hasWalBefore = fileExists(`${dbPath}-wal`)
  const hasShmBefore = fileExists(`${dbPath}-shm`)

  // --- Validation ---------------------------------------------------------
  const failure = validateReadonlyChatDb(dbPath, sampleCount)

  // --- Cleanup any sidecars created during the probe (no-residue) ----------
  const cleanedSidecars = cleanupCreatedSidecars(dbPath, hasWalBefore, hasShmBefore)

  if (failure !== null) {
    const detail: ValidationFailureDetail = {
      kind: 'validation-failure',
      gate: failure.gate,
      safeCode: failure.safeCode
    }
    return { result: { status: 'present-unverified', detail }, cleanedSidecars }
  }

  return { result: { status: 'present-verified', detail: null }, cleanedSidecars }
}

/**
 * Probe the retained rollback snapshot: stat → validateReadonlyChatDb →
 * cleanup sidecars → status.
 *
 * Same readonly semantics and no-residue strategy as the live probe.
 */
export function probeRetainedSnapshot(dataRoot: string = DATA_PATH, sampleCount: number = 3): ArtifactProbeResult {
  return probeRetainedSnapshotWithCleanupReport(dataRoot, sampleCount).result
}

/** {@link probeRetainedSnapshot} plus the basenames of sidecars it actually removed. */
function probeRetainedSnapshotWithCleanupReport(dataRoot: string, sampleCount: number): ProbeWithCleanupReport {
  const snapshotPath = resolveRetainedSnapshotPath(dataRoot)

  // --- Stat check ---------------------------------------------------------
  // lstat (audit F4): a symlinked retained root (broken or working) is tamper
  // — NOT_A_FILE, never followed.
  try {
    const stat = fs.lstatSync(snapshotPath)
    if (!stat.isFile()) {
      const detail: StatFailureDetail = { kind: 'stat-failure', code: 'NOT_A_FILE' }
      return { result: { status: 'present-unverified', detail }, cleanedSidecars: [] }
    }
  } catch (error) {
    const code = safeErrorCode(error)
    if (code === 'ENOENT') {
      return { result: { status: 'missing', detail: null }, cleanedSidecars: [] }
    }
    const detail: StatFailureDetail = { kind: 'stat-failure', code }
    return { result: { status: 'present-unverified', detail }, cleanedSidecars: [] }
  }

  // --- Capture pre-probe sidecar state ------------------------------------
  const hasWalBefore = fileExists(`${snapshotPath}-wal`)
  const hasShmBefore = fileExists(`${snapshotPath}-shm`)

  // --- Validation ---------------------------------------------------------
  const failure = validateReadonlyChatDb(snapshotPath, sampleCount)

  // --- Cleanup any sidecars created during the probe (no-residue) ----------
  const cleanedSidecars = cleanupCreatedSidecars(snapshotPath, hasWalBefore, hasShmBefore)

  if (failure !== null) {
    const detail: ValidationFailureDetail = {
      kind: 'validation-failure',
      gate: failure.gate,
      safeCode: failure.safeCode
    }
    return { result: { status: 'present-unverified', detail }, cleanedSidecars }
  }

  return { result: { status: 'present-verified', detail: null }, cleanedSidecars }
}

/**
 * Probe the candidate artifact: validate candidateId → stat → presence.
 *
 * Candidate probing is presence-only — no DB validation is performed at
 * this layer. The candidate DB is validated during the full verification
 * gate in the replacement verifier.
 *
 * The candidateId is validated against the strict allowlist BEFORE
 * resolving any path (LOCK-4434). An unsafe candidateId is a hard
 * error, not a 'missing' status.
 */
export function probeCandidate(
  candidateId: string,
  dataRoot: string = DATA_PATH
): CandidateProbeResult | { readonly kind: 'error'; readonly code: string } {
  // --- CandidateId validation (LOCK-4434) ---------------------------------
  if (!isValidOwnedCandidateId(candidateId)) {
    return { kind: 'error', code: 'INVALID_CANDIDATE_ID' }
  }

  // --- Stat check ---------------------------------------------------------
  const dbPath = resolveCandidateDbPath(candidateId, dataRoot)
  try {
    // lstat (audit F4): a symlinked candidate DB (broken or working) is tamper
    // — CANDIDATE_NOT_A_FILE, never followed.
    const stat = fs.lstatSync(dbPath)
    if (!stat.isFile()) {
      return { kind: 'error', code: 'CANDIDATE_NOT_A_FILE' }
    }
  } catch (error) {
    const code = safeErrorCode(error)
    if (code === 'ENOENT') {
      return { status: 'missing' }
    }
    return { kind: 'error', code }
  }

  return { status: 'present' }
}

// ---------------------------------------------------------------------------
// Journal observation (delegated to journalStore.readPromotionJournal)
// ---------------------------------------------------------------------------

/**
 * Observe the promotion journal status at the fixed path. This function
 * reads the journal bytes and decodes them through the strict shared codec
 * (v1 chat.db-only AND v2 three-artifact documents), returning the
 * structured observation for the recovery decision matrix.
 *
 * Returns 'invalid' for any I/O failure or decode rejection. Returns
 * 'absent' only for ENOENT. The journal file must already exist for this
 * to return 'valid' — this function does NOT create or modify the journal.
 */
export function observePromotionJournal(dataRoot: string = DATA_PATH): PromotionJournalObservation {
  const journalPath = path.resolve(path.join(dataRoot, PROMOTION_JOURNAL_FILENAME))

  let raw: string
  try {
    raw = fs.readFileSync(journalPath, 'utf-8')
  } catch (error) {
    const code = safeErrorCode(error)
    if (code === 'ENOENT') {
      return { status: 'absent' }
    }
    return { status: 'invalid' }
  }

  const decoded = decodePromotionJournal(raw)
  if (!decoded.ok) {
    return { status: 'invalid' }
  }
  return { status: 'valid', journal: decoded.journal }
}

// ---------------------------------------------------------------------------
// v2 three-artifact probes (LOCK-PROMO-6/9)
// ---------------------------------------------------------------------------

/** Probe the live Files directory parity against the candidate catalog. */
export function probeLiveFiles(
  candidateId: string | null,
  dataRoot: string = DATA_PATH
): 'missing' | 'present-unverified' | 'present-verified' {
  const liveFilesDir = resolveLiveFilesDir(dataRoot)
  // lstat-based presence (audit F2/F4): a BROKEN symlink at the live Files
  // root is PRESENT tamper (present-unverified), never 'missing'; a working
  // symlink is never followed (lstat, not stat).
  let rootStat: fs.Stats
  try {
    rootStat = fs.lstatSync(liveFilesDir)
  } catch (error) {
    if (safeErrorCode(error) === 'ENOENT') {
      return 'missing'
    }
    return 'present-unverified'
  }
  if (!rootStat.isDirectory()) {
    return 'present-unverified'
  }
  if (candidateId === null || !isValidOwnedCandidateId(candidateId)) {
    return 'present-unverified'
  }
  try {
    const catalogPath = path.resolve(path.join(dataRoot, CANDIDATE_ROOT_DIRNAME, candidateId, 'files-catalog.json'))
    const catalog = readAndValidateCatalog(catalogPath)
    if (catalog === null) {
      return 'present-unverified'
    }
    const rows = catalog.rows.map((row) => ({ name: row.name, size: row.size, sha256: row.sha256 }))
    const parity = verifyFilesDirAgainstCatalog(liveFilesDir, rows)
    return parity.ok ? 'present-verified' : 'present-unverified'
  } catch {
    return 'present-unverified'
  }
}

/** Probe the retained Files snapshot (delegates to filesSnapshot). */
export function probeRetainedFilesSnapshotStatus(
  dataRoot: string = DATA_PATH
): 'missing' | 'present-unverified' | 'present-verified' {
  return probeRetainedFilesSnapshot(dataRoot).status
}

/** Probe the retained catalog snapshot (delegates to catalogSnapshot). */
export function probeRetainedCatalogSnapshotStatus(
  dataRoot: string = DATA_PATH
): 'missing' | 'present-unverified' | 'present-verified' {
  return probeRetainedCatalogSnapshot(dataRoot).status
}

/** Probe the `Files.promote-staging` mid-install dir presence. */
export function probeFilesStaging(dataRoot: string = DATA_PATH): 'missing' | 'present' {
  const stagingDir = path.resolve(path.join(dataRoot, FILES_PROMOTE_STAGING_DIRNAME))
  // lstat-based presence (audit F2): a broken symlink at the staging path is
  // PRESENT tamper, never 'missing'.
  try {
    fs.lstatSync(stagingDir)
    return 'present'
  } catch {
    return 'missing'
  }
}

/** Probe the candidate catalog handoff validity (present + readable). */
export function probeCandidateCatalog(candidateId: string, dataRoot: string = DATA_PATH): 'missing' | 'present' {
  if (!isValidOwnedCandidateId(candidateId)) {
    return 'missing'
  }
  try {
    const catalogPath = path.resolve(path.join(dataRoot, CANDIDATE_ROOT_DIRNAME, candidateId, 'files-catalog.json'))
    return readAndValidateCatalog(catalogPath) === null ? 'missing' : 'present'
  } catch {
    return 'missing'
  }
}

/**
 * Full v2 probe → recovery input. `catalogApplied` is always 'unknown'
 * here: the live Dexie facts can only be observed through the renderer
 * boundary (window mode), which fills it before deciding.
 *
 * `candidate` is the candidate chat.db presence (consumed by the db
 * install); `candidateCatalog` is the retained candidate catalog handoff
 * (files-catalog.json) presence/validity — the forward-completion evidence
 * at `files-installed`/`catalog-pending` (LOCK-JRNL-3).
 */
export function probePromotionArtifactsV2(
  candidateId: string | null,
  dataRoot: string = DATA_PATH
): {
  readonly journal: PromotionJournalObservation
  readonly live: 'missing' | 'present-unverified' | 'present-verified'
  readonly dbSnapshot: 'missing' | 'present-unverified' | 'present-verified'
  readonly candidate: 'missing' | 'present'
  readonly files: 'missing' | 'present-unverified' | 'present-verified'
  readonly filesSnapshot: 'missing' | 'present-unverified' | 'present-verified'
  readonly filesStaging: 'missing' | 'present'
  readonly catalogSnapshot: 'missing' | 'present-unverified' | 'present-verified'
  readonly catalogApplied: 'unknown'
  readonly candidateCatalog: 'missing' | 'present'
} {
  const journal = observePromotionJournal(dataRoot)
  let resolvedCandidateId = candidateId
  if (resolvedCandidateId === null && journal.status === 'valid') {
    resolvedCandidateId = journal.journal.candidateId
  }
  let candidate: 'missing' | 'present' = 'missing'
  if (resolvedCandidateId !== null) {
    const candidateResult = probeCandidate(resolvedCandidateId, dataRoot)
    if ('kind' in candidateResult) {
      candidate = 'missing'
    } else {
      candidate = candidateResult.status
    }
  }
  return {
    journal,
    live: probeLiveDb(dataRoot).status,
    dbSnapshot: probeRetainedSnapshot(dataRoot).status,
    candidate,
    files: probeLiveFiles(resolvedCandidateId, dataRoot),
    filesSnapshot: probeRetainedFilesSnapshotStatus(dataRoot),
    filesStaging: probeFilesStaging(dataRoot),
    catalogSnapshot: probeRetainedCatalogSnapshotStatus(dataRoot),
    catalogApplied: 'unknown',
    candidateCatalog: resolvedCandidateId !== null ? probeCandidateCatalog(resolvedCandidateId, dataRoot) : 'missing'
  }
}

// ---------------------------------------------------------------------------
// Composite probe — all artifacts + journal
// ---------------------------------------------------------------------------

/**
 * Run all promotion artifact probes and return the complete result.
 *
 * The probe sequence:
 * 1. Capture directory snapshots for mutation detection
 * 2. Observe the journal
 * 3. Probe live, snapshot, and candidate artifacts (each with no-residue
 *    sidecar cleanup)
 * 4. Capture post-probe directory snapshots
 * 5. Compute mutation evidence and sidecar-free assertion
 *
 * Never throws. All failures are captured in the structured result.
 */
export function probePromotionArtifacts(
  candidateId: string | null,
  dataRoot: string = DATA_PATH,
  sampleCount: number = 3
): PromotionArtifactProbesResult {
  // --- Pre-probe directory snapshots --------------------------------------
  const dataDirBefore = snapshotDirectory(dataRoot)
  const candidateDirPath = candidateId ? path.resolve(path.join(dataRoot, CANDIDATE_ROOT_DIRNAME)) : null
  const candidateDirBefore = candidateDirPath ? snapshotDirectory(candidateDirPath) : null

  // --- Journal observation ------------------------------------------------
  const journal = observePromotionJournal(dataRoot)

  // --- Live probe ---------------------------------------------------------
  const live = probeLiveDbWithCleanupReport(dataRoot, sampleCount)

  // --- Snapshot probe -----------------------------------------------------
  const snapshot = probeRetainedSnapshotWithCleanupReport(dataRoot, sampleCount)

  // --- Candidate probe ----------------------------------------------------
  let candidate: CandidateProbeResult
  if (candidateId === null || journal.status === 'absent' || journal.status === 'invalid') {
    // No valid journal or no candidate ID: report as missing.
    // An invalid journal is a hard block (LOCK-4437) — the candidate status
    // is irrelevant for the decision matrix but we report it accurately.
    candidate = { status: 'missing' }
  } else {
    // Valid journal — resolve the candidate ID.
    const candidateResult = probeCandidate(journal.journal.candidateId, dataRoot)
    if ('kind' in candidateResult && candidateResult.kind === 'error') {
      // Unsafe candidate ID from the journal: treat as missing.
      // The decision matrix handles this via the repair-required path.
      logger.warn(
        `Candidate probe error for journal candidateId '${journal.journal.candidateId}': ${candidateResult.code}`
      )
      candidate = { status: 'missing' }
    } else {
      candidate = candidateResult as CandidateProbeResult
    }
  }

  // --- Post-probe directory snapshots + mutation detection ----------------
  const dataDirAfter = snapshotDirectory(dataRoot)
  const candidateDirAfter = candidateDirPath ? snapshotDirectory(candidateDirPath) : null

  const dataDiff = diffDirectorySnapshots(dataDirBefore, dataDirAfter)
  const candidateDiff =
    candidateDirBefore && candidateDirAfter
      ? diffDirectorySnapshots(candidateDirBefore, candidateDirAfter)
      : { added: [], removed: [] }

  // Merge diffs
  const allAdded = [...new Set([...dataDiff.added, ...candidateDiff.added])].sort()
  const allRemoved = [...new Set([...dataDiff.removed, ...candidateDiff.removed])].sort()

  // Sidecar detection: flag any -wal/-shm files that appeared AND were not
  // cleaned — the fail-closed no-residue gate.
  const sidecarsRemaining = allAdded.filter((entry) => entry.endsWith('-wal') || entry.endsWith('-shm'))
  const sidecarFree = sidecarsRemaining.length === 0

  // Sidecars created during probing and successfully removed are reported by
  // the individual probes themselves (LOCK-CLOSE-5): the before/after
  // directory diff cannot observe created-and-cleaned files (they appear in
  // neither snapshot), so the report is the truthful source of evidence.
  // Only basenames are exposed — never private paths.
  const cleanedSidecars = [...live.cleanedSidecars, ...snapshot.cleanedSidecars].sort()

  if (!sidecarFree) {
    logger.warn(`Promotion artifact probe detected uncleaned sidecar residue: ${sidecarsRemaining.join(', ')}`)
  }

  return {
    journal,
    live: live.result,
    snapshot: snapshot.result,
    candidate,
    sidecarFree,
    mutationEvidence: { added: allAdded, removed: allRemoved },
    cleanedSidecars
  }
}

// ---------------------------------------------------------------------------
// Mapping to RecoveryInput (convenience)
// ---------------------------------------------------------------------------

/**
 * Map probe results to a PromotionRecoveryInput suitable for
 * decidePromotionRecovery(). The journal observation is passed through
 * directly; artifact statuses are mapped from probe results.
 */
export function probeResultToRecoveryInput(probes: PromotionArtifactProbesResult): PromotionRecoveryInput {
  return {
    journal: probes.journal,
    live: probes.live.status,
    snapshot: probes.snapshot.status,
    candidate: probes.candidate.status
  }
}
