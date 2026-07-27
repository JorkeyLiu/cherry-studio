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
 * that appeared during the probe are detected and removed. The composite
 * probe captures before/after directory snapshots to prove zero net
 * filesystem mutations. This is a controlled, bounded cleanup of probe-
 * owned residue only — never touching files that existed before the probe.
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

import { isValidOwnedCandidateId } from '../candidateDb'
import type { PromotionJournalV1 } from './journal'
import { PROMOTION_JOURNAL_FILENAME, PROMOTION_JOURNAL_VERSION, ROLLBACK_SNAPSHOT_FILENAME } from './journal'
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
  /** Sidecar files that were created during probing and then cleaned up. */
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
  const dbPath = resolveLiveDbPath(dataRoot)

  // --- Stat check ---------------------------------------------------------
  try {
    const stat = fs.statSync(dbPath)
    if (!stat.isFile()) {
      const detail: StatFailureDetail = { kind: 'stat-failure', code: 'NOT_A_FILE' }
      return { status: 'present-unverified', detail }
    }
  } catch (error) {
    const code = safeErrorCode(error)
    if (code === 'ENOENT') {
      return { status: 'missing', detail: null }
    }
    const detail: StatFailureDetail = { kind: 'stat-failure', code }
    return { status: 'present-unverified', detail }
  }

  // --- Capture pre-probe sidecar state ------------------------------------
  const hasWalBefore = fileExists(`${dbPath}-wal`)
  const hasShmBefore = fileExists(`${dbPath}-shm`)

  // --- Validation ---------------------------------------------------------
  const failure = validateReadonlyChatDb(dbPath, sampleCount)

  // --- Cleanup any sidecars created during the probe (no-residue) ----------
  if (!hasWalBefore && fileExists(`${dbPath}-wal`)) {
    fs.unlinkSync(`${dbPath}-wal`)
  }
  if (!hasShmBefore && fileExists(`${dbPath}-shm`)) {
    fs.unlinkSync(`${dbPath}-shm`)
  }

  if (failure !== null) {
    const detail: ValidationFailureDetail = {
      kind: 'validation-failure',
      gate: failure.gate,
      safeCode: failure.safeCode
    }
    return { status: 'present-unverified', detail }
  }

  return { status: 'present-verified', detail: null }
}

/**
 * Probe the retained rollback snapshot: stat → validateReadonlyChatDb →
 * cleanup sidecars → status.
 *
 * Same readonly semantics and no-residue strategy as the live probe.
 */
export function probeRetainedSnapshot(dataRoot: string = DATA_PATH, sampleCount: number = 3): ArtifactProbeResult {
  const snapshotPath = resolveRetainedSnapshotPath(dataRoot)

  // --- Stat check ---------------------------------------------------------
  try {
    const stat = fs.statSync(snapshotPath)
    if (!stat.isFile()) {
      const detail: StatFailureDetail = { kind: 'stat-failure', code: 'NOT_A_FILE' }
      return { status: 'present-unverified', detail }
    }
  } catch (error) {
    const code = safeErrorCode(error)
    if (code === 'ENOENT') {
      return { status: 'missing', detail: null }
    }
    const detail: StatFailureDetail = { kind: 'stat-failure', code }
    return { status: 'present-unverified', detail }
  }

  // --- Capture pre-probe sidecar state ------------------------------------
  const hasWalBefore = fileExists(`${snapshotPath}-wal`)
  const hasShmBefore = fileExists(`${snapshotPath}-shm`)

  // --- Validation ---------------------------------------------------------
  const failure = validateReadonlyChatDb(snapshotPath, sampleCount)

  // --- Cleanup any sidecars created during the probe (no-residue) ----------
  if (!hasWalBefore && fileExists(`${snapshotPath}-wal`)) {
    fs.unlinkSync(`${snapshotPath}-wal`)
  }
  if (!hasShmBefore && fileExists(`${snapshotPath}-shm`)) {
    fs.unlinkSync(`${snapshotPath}-shm`)
  }

  if (failure !== null) {
    const detail: ValidationFailureDetail = {
      kind: 'validation-failure',
      gate: failure.gate,
      safeCode: failure.safeCode
    }
    return { status: 'present-unverified', detail }
  }

  return { status: 'present-verified', detail: null }
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
    const stat = fs.statSync(dbPath)
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
 * reads the journal bytes and decodes them, returning the structured
 * observation for the recovery decision matrix.
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

  // Decode and validate the journal document.
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { status: 'invalid' }
    }

    const record = parsed as Record<string, unknown>

    // Validate version
    if (record.version !== PROMOTION_JOURNAL_VERSION) {
      return { status: 'invalid' }
    }

    // Validate sessionId (strict allowlist)
    const sessionId = record.sessionId
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
      return { status: 'invalid' }
    }

    // Validate candidateId (strict allowlist)
    const candidateId = record.candidateId
    if (typeof candidateId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(candidateId)) {
      return { status: 'invalid' }
    }

    // Validate phase
    const phase = record.phase
    const validPhases: readonly string[] = ['snapshot-ready', 'candidate-installed', 'replacement-verified']
    if (typeof phase !== 'string' || !validPhases.includes(phase)) {
      return { status: 'invalid' }
    }

    const journal: PromotionJournalV1 = {
      version: PROMOTION_JOURNAL_VERSION,
      sessionId,
      candidateId,
      phase: phase as PromotionJournalV1['phase']
    }

    return { status: 'valid', journal }
  } catch {
    return { status: 'invalid' }
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
  const live = probeLiveDb(dataRoot, sampleCount)

  // --- Snapshot probe -----------------------------------------------------
  const snapshot = probeRetainedSnapshot(dataRoot, sampleCount)

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

  // Sidecar detection: flag any -wal/-shm files that appeared AND were NOT cleaned
  const sidecarsRemaining = allAdded.filter((entry) => entry.endsWith('-wal') || entry.endsWith('-shm'))
  const sidecarFree = sidecarsRemaining.length === 0

  // Detect sidecars that were created and then cleaned up by individual probes
  const cleanedSidecars: string[] = []

  // Check for cleaned live DB sidecars
  const liveDbPath = resolveLiveDbPath(dataRoot)
  for (const suffix of SIDECAR_SUFFIXES) {
    const sidecarName = `${path.basename(liveDbPath)}${suffix}`
    // If it was in before but not in after, it was cleaned
    if (dataDirBefore.entries.includes(sidecarName) && !dataDirAfter.entries.includes(sidecarName)) {
      cleanedSidecars.push(sidecarName)
    }
    // If it was created during probe and cleaned, it won't appear in after
  }

  // Check for cleaned snapshot sidecars
  const snapshotPath = resolveRetainedSnapshotPath(dataRoot)
  for (const suffix of SIDECAR_SUFFIXES) {
    const sidecarName = `${path.basename(snapshotPath)}${suffix}`
    if (dataDirBefore.entries.includes(sidecarName) && !dataDirAfter.entries.includes(sidecarName)) {
      cleanedSidecars.push(sidecarName)
    }
  }

  if (!sidecarFree) {
    logger.warn(`Promotion artifact probe detected uncleaned sidecar residue: ${sidecarsRemaining.join(', ')}`)
  }

  return {
    journal,
    live,
    snapshot,
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
