/**
 * Promotion crash recovery — exhaustive deterministic decision matrix
 * (Phase 4.4.0, LOCK-4406).
 *
 * `decidePromotionRecovery` is a pure total function: for EVERY combination
 * of journal observation and controlled artifact statuses it returns exactly
 * one action with an explicit reason code. It never guesses by file age and
 * never chooses empty-DB creation. Phase 4.4.0 provides the decision only —
 * no filesystem probing, journal reading, or recovery execution (LOCK-4405);
 * the Phase 4.4.1+ executor supplies observed inputs and applies actions.
 *
 * Decision principles (locked):
 * - No journal ⇒ no destructive promotion ever began ⇒ keep the current
 *   live DB exactly as-is. Orphan candidates remain owned by the existing
 *   age-based cleanup (unchanged in 4.4.0).
 * - An unreadable/invalid journal ⇒ a destructive promotion may have begun
 *   but its progress is unknowable ⇒ explicit repair-required.
 * - `candidate-installed` can never prove the replacement is valid: unless
 *   `replacement-verified` was journaled, recovery relies on a VERIFIED
 *   rollback snapshot, else repair-required.
 * - `replacement-verified` is accepted only when the controlled inputs show
 *   the live DB present AND verified; any contradiction ⇒ repair-required.
 * - Every remaining ambiguity resolves to conservative repair-required.
 *
 * Main-only module. Not exposed over IPC/preload/renderer.
 */

import type { PromotionJournalDoc, PromotionJournalPhase, PromotionJournalPhaseV2 } from './journal'
import { PROMOTION_JOURNAL_VERSION_V1, PROMOTION_JOURNAL_VERSION_V2 } from './journal'
import type { PromotionCrashPoint, PromotionCrashPointV2 } from './protocol'

// ---------------------------------------------------------------------------
// Controlled inputs
// ---------------------------------------------------------------------------

/**
 * Journal observation. `invalid` covers unreadable bytes and any
 * decodePromotionJournal rejection (LOCK-4404 strict codec).
 */
export type PromotionJournalObservation =
  | { readonly status: 'absent' }
  | { readonly status: 'invalid' }
  | { readonly status: 'valid'; readonly journal: PromotionJournalDoc }

/**
 * Controlled live chat.db artifact status as observed by the executor:
 * - 'missing'            — no file at the live path
 * - 'present-unverified' — file exists; verification not run or failed
 * - 'present-verified'   — file exists and passed the controlled
 *                          verification gates (integrity + FK + samples)
 */
export type LiveDbArtifactStatus = 'missing' | 'present-unverified' | 'present-verified'

/** Controlled rollback snapshot artifact status (fixed owned name, LOCK-4403). */
export type SnapshotArtifactStatus = 'missing' | 'present-unverified' | 'present-verified'

/** Controlled candidate artifact status (journal-referenced candidate only). */
export type CandidateArtifactStatus = 'missing' | 'present'

export interface PromotionRecoveryInput {
  readonly journal: PromotionJournalObservation
  readonly live: LiveDbArtifactStatus
  readonly snapshot: SnapshotArtifactStatus
  readonly candidate: CandidateArtifactStatus
}

// ---------------------------------------------------------------------------
// Decision output
// ---------------------------------------------------------------------------

/** The four allowed recovery actions (LOCK-4406). */
export const PROMOTION_RECOVERY_ACTIONS = [
  'keep-old-live',
  'accept-verified-replacement',
  'restore-rollback-snapshot',
  'repair-required'
] as const

export type PromotionRecoveryAction = (typeof PROMOTION_RECOVERY_ACTIONS)[number]

/** Machine-readable reason codes — one per matrix branch. */
export type PromotionRecoveryReasonCode =
  | 'NO_JOURNAL'
  | 'V2_JOURNAL_WITH_V1_INPUT'
  | 'JOURNAL_INVALID'
  | 'SNAPSHOT_READY_INSTALL_NOT_STARTED'
  | 'SNAPSHOT_READY_LIVE_MISSING_SNAPSHOT_VERIFIED'
  | 'SNAPSHOT_READY_LIVE_MISSING_SNAPSHOT_UNAVAILABLE'
  | 'SNAPSHOT_READY_AMBIGUOUS_INSTALL_SNAPSHOT_VERIFIED'
  | 'SNAPSHOT_READY_AMBIGUOUS_INSTALL_SNAPSHOT_UNAVAILABLE'
  | 'CANDIDATE_INSTALLED_UNVERIFIED_SNAPSHOT_VERIFIED'
  | 'CANDIDATE_INSTALLED_UNVERIFIED_SNAPSHOT_UNAVAILABLE'
  | 'REPLACEMENT_VERIFIED_LIVE_VERIFIED'
  | 'REPLACEMENT_VERIFIED_LIVE_NOT_VERIFIED'

export interface PromotionRecoveryDecision {
  readonly action: PromotionRecoveryAction
  readonly reason: PromotionRecoveryReasonCode
}

// ---------------------------------------------------------------------------
// Decision function — pure, total, single-result
// ---------------------------------------------------------------------------

/**
 * Decide the single recovery action for one observed v1 input (LOCK-4406).
 *
 * Dispatches on the journal version: v1 journals follow the original
 * chat.db-only matrix (LOCK-PROMO-10 — a v1 journal is NEVER reinterpreted
 * as a partially installed Files generation); a v2 journal is handled by
 * {@link decidePromotionRecoveryV2} with the richer three-artifact inputs.
 *
 * Matrix (v1 journal → branch):
 *
 * | journal                | condition                                    | action                        |
 * |------------------------|----------------------------------------------|-------------------------------|
 * | absent                 | always                                       | keep-old-live                 |
 * | invalid                | always                                       | repair-required               |
 * | snapshot-ready         | candidate present ∧ live present             | keep-old-live                 |
 * | snapshot-ready         | candidate present ∧ live missing ∧ snap ✔    | restore-rollback-snapshot     |
 * | snapshot-ready         | candidate present ∧ live missing ∧ snap ✘    | repair-required               |
 * | snapshot-ready         | candidate missing ∧ snap ✔                   | restore-rollback-snapshot     |
 * | snapshot-ready         | candidate missing ∧ snap ✘                   | repair-required               |
 * | candidate-installed    | snap ✔                                       | restore-rollback-snapshot     |
 * | candidate-installed    | snap ✘                                       | repair-required               |
 * | replacement-verified   | live present-verified                        | accept-verified-replacement   |
 * | replacement-verified   | otherwise                                    | repair-required               |
 *
 * (snap ✔ = snapshot present-verified; snap ✘ = missing or unverified.
 *  "live present" = present-unverified or present-verified.)
 */
export function decidePromotionRecovery(input: PromotionRecoveryInput): PromotionRecoveryDecision {
  const { journal, live, snapshot, candidate } = input

  if (journal.status === 'absent') {
    return { action: 'keep-old-live', reason: 'NO_JOURNAL' }
  }
  if (journal.status === 'invalid') {
    return { action: 'repair-required', reason: 'JOURNAL_INVALID' }
  }
  if (journal.journal.version === PROMOTION_JOURNAL_VERSION_V2) {
    // The v1-shaped input cannot represent the three-artifact reality. This
    // surface is only reachable via the v1 probe mapping; the v2 executor
    // path always uses decidePromotionRecoveryV2. Failing closed here is the
    // only sound total behavior.
    return { action: 'repair-required', reason: 'V2_JOURNAL_WITH_V1_INPUT' }
  }

  const phase: PromotionJournalPhase = journal.journal.phase
  const snapshotVerified = snapshot === 'present-verified'
  const livePresent = live !== 'missing'

  switch (phase) {
    case 'snapshot-ready': {
      if (candidate === 'present') {
        if (livePresent) {
          // Install never ran (the candidate still exists) and the original
          // live file is in place: nothing destructive completed.
          return { action: 'keep-old-live', reason: 'SNAPSHOT_READY_INSTALL_NOT_STARTED' }
        }
        return snapshotVerified
          ? { action: 'restore-rollback-snapshot', reason: 'SNAPSHOT_READY_LIVE_MISSING_SNAPSHOT_VERIFIED' }
          : { action: 'repair-required', reason: 'SNAPSHOT_READY_LIVE_MISSING_SNAPSHOT_UNAVAILABLE' }
      }
      // Candidate missing: the install may have run without reaching the
      // candidate-installed journal write — live content is untrustworthy.
      return snapshotVerified
        ? { action: 'restore-rollback-snapshot', reason: 'SNAPSHOT_READY_AMBIGUOUS_INSTALL_SNAPSHOT_VERIFIED' }
        : { action: 'repair-required', reason: 'SNAPSHOT_READY_AMBIGUOUS_INSTALL_SNAPSHOT_UNAVAILABLE' }
    }
    case 'candidate-installed': {
      // Installed but never verified: the replacement cannot be trusted.
      return snapshotVerified
        ? { action: 'restore-rollback-snapshot', reason: 'CANDIDATE_INSTALLED_UNVERIFIED_SNAPSHOT_VERIFIED' }
        : { action: 'repair-required', reason: 'CANDIDATE_INSTALLED_UNVERIFIED_SNAPSHOT_UNAVAILABLE' }
    }
    case 'replacement-verified': {
      return live === 'present-verified'
        ? { action: 'accept-verified-replacement', reason: 'REPLACEMENT_VERIFIED_LIVE_VERIFIED' }
        : { action: 'repair-required', reason: 'REPLACEMENT_VERIFIED_LIVE_NOT_VERIFIED' }
    }
  }
}

// ---------------------------------------------------------------------------
// Crash-point mapping (LOCK-4406 coverage anchor)
// ---------------------------------------------------------------------------

/**
 * One documented crash point mapped to a canonical recovery observation and
 * its unique expected decision. Crash points with multiple persisted
 * sub-windows appear as multiple rows; tests assert every one of the 12
 * listed crash points is covered and that each row's expectation matches
 * {@link decidePromotionRecovery} exactly.
 */
export interface PromotionCrashPointExpectation {
  readonly crashPoint: PromotionCrashPoint
  /** Journal observation persisted at this crash point. */
  readonly journal: 'absent' | PromotionJournalPhase
  readonly live: LiveDbArtifactStatus
  readonly snapshot: SnapshotArtifactStatus
  readonly candidate: CandidateArtifactStatus
  readonly expectedAction: PromotionRecoveryAction
  readonly expectedReason: PromotionRecoveryReasonCode
}

/**
 * Canonical crash-point → decision matrix for the 12 documented crash
 * points. The journal column follows the PROMOTION_OPERATION_ORDER anchors:
 * the journal only advances AFTER the corresponding operation completed.
 */
export const PROMOTION_CRASH_POINT_MATRIX: readonly PromotionCrashPointExpectation[] = Object.freeze([
  // 1. Before the snapshot: nothing persisted, nothing destructive.
  {
    crashPoint: 'before-snapshot',
    journal: 'absent',
    live: 'present-unverified',
    snapshot: 'missing',
    candidate: 'present',
    expectedAction: 'keep-old-live',
    expectedReason: 'NO_JOURNAL'
  },
  // 2. Snapshot published + journaled, live not yet closed.
  {
    crashPoint: 'after-snapshot-before-live-close',
    journal: 'snapshot-ready',
    live: 'present-unverified',
    snapshot: 'present-verified',
    candidate: 'present',
    expectedAction: 'keep-old-live',
    expectedReason: 'SNAPSHOT_READY_INSTALL_NOT_STARTED'
  },
  // 3. Live closed (file still in place), install not begun.
  {
    crashPoint: 'after-live-close-before-install',
    journal: 'snapshot-ready',
    live: 'present-unverified',
    snapshot: 'present-verified',
    candidate: 'present',
    expectedAction: 'keep-old-live',
    expectedReason: 'SNAPSHOT_READY_INSTALL_NOT_STARTED'
  },
  // 4a. Install ran but crashed before journaling candidate-installed
  //     (ambiguous sub-window: candidate gone, live untrustworthy).
  {
    crashPoint: 'after-install-before-reopen',
    journal: 'snapshot-ready',
    live: 'present-unverified',
    snapshot: 'present-verified',
    candidate: 'missing',
    expectedAction: 'restore-rollback-snapshot',
    expectedReason: 'SNAPSHOT_READY_AMBIGUOUS_INSTALL_SNAPSHOT_VERIFIED'
  },
  // 4b. Install + journal completed, crash before reopen.
  {
    crashPoint: 'after-install-before-reopen',
    journal: 'candidate-installed',
    live: 'present-unverified',
    snapshot: 'present-verified',
    candidate: 'missing',
    expectedAction: 'restore-rollback-snapshot',
    expectedReason: 'CANDIDATE_INSTALLED_UNVERIFIED_SNAPSHOT_VERIFIED'
  },
  // 5. Reopened, crash before integrity check: replacement unverified.
  {
    crashPoint: 'after-reopen-before-integrity',
    journal: 'candidate-installed',
    live: 'present-unverified',
    snapshot: 'present-verified',
    candidate: 'missing',
    expectedAction: 'restore-rollback-snapshot',
    expectedReason: 'CANDIDATE_INSTALLED_UNVERIFIED_SNAPSHOT_VERIFIED'
  },
  // 6. PRAGMA integrity_check failed: replacement rejected.
  {
    crashPoint: 'integrity-check-failed',
    journal: 'candidate-installed',
    live: 'present-unverified',
    snapshot: 'present-verified',
    candidate: 'missing',
    expectedAction: 'restore-rollback-snapshot',
    expectedReason: 'CANDIDATE_INSTALLED_UNVERIFIED_SNAPSHOT_VERIFIED'
  },
  // 7. PRAGMA foreign_key_check failed: replacement rejected.
  {
    crashPoint: 'foreign-key-check-failed',
    journal: 'candidate-installed',
    live: 'present-unverified',
    snapshot: 'present-verified',
    candidate: 'missing',
    expectedAction: 'restore-rollback-snapshot',
    expectedReason: 'CANDIDATE_INSTALLED_UNVERIFIED_SNAPSHOT_VERIFIED'
  },
  // 8. Application-level sample reads failed: replacement rejected.
  {
    crashPoint: 'sample-read-failed',
    journal: 'candidate-installed',
    live: 'present-unverified',
    snapshot: 'present-verified',
    candidate: 'missing',
    expectedAction: 'restore-rollback-snapshot',
    expectedReason: 'CANDIDATE_INSTALLED_UNVERIFIED_SNAPSHOT_VERIFIED'
  },
  // 9. Rollback installation itself was interrupted (live may be torn or
  //    missing); the retained verified snapshot allows a deterministic retry.
  {
    crashPoint: 'rollback-installation-interrupted',
    journal: 'candidate-installed',
    live: 'missing',
    snapshot: 'present-verified',
    candidate: 'missing',
    expectedAction: 'restore-rollback-snapshot',
    expectedReason: 'CANDIDATE_INSTALLED_UNVERIFIED_SNAPSHOT_VERIFIED'
  },
  // 10. Replacement fully verified + journaled, crash before journal cleanup.
  {
    crashPoint: 'after-replacement-verified-before-journal-cleanup',
    journal: 'replacement-verified',
    live: 'present-verified',
    snapshot: 'present-verified',
    candidate: 'missing',
    expectedAction: 'accept-verified-replacement',
    expectedReason: 'REPLACEMENT_VERIFIED_LIVE_VERIFIED'
  },
  // 11. Journal cleaned, crash before relaunch: the verified replacement is
  //     already the live DB; no journal means no in-flight promotion.
  {
    crashPoint: 'before-relaunch',
    journal: 'absent',
    live: 'present-verified',
    snapshot: 'present-verified',
    candidate: 'missing',
    expectedAction: 'keep-old-live',
    expectedReason: 'NO_JOURNAL'
  },
  // 12a. will-quit during promotion, before anything was journaled: the
  //      protocol preserved the candidate and no destructive step ran.
  {
    crashPoint: 'will-quit-during-promotion',
    journal: 'absent',
    live: 'present-unverified',
    snapshot: 'missing',
    candidate: 'present',
    expectedAction: 'keep-old-live',
    expectedReason: 'NO_JOURNAL'
  },
  // 12b. will-quit during promotion at snapshot-ready: original live intact.
  {
    crashPoint: 'will-quit-during-promotion',
    journal: 'snapshot-ready',
    live: 'present-unverified',
    snapshot: 'present-verified',
    candidate: 'present',
    expectedAction: 'keep-old-live',
    expectedReason: 'SNAPSHOT_READY_INSTALL_NOT_STARTED'
  },
  // 12c. will-quit during promotion after install, before verification.
  {
    crashPoint: 'will-quit-during-promotion',
    journal: 'candidate-installed',
    live: 'present-unverified',
    snapshot: 'present-verified',
    candidate: 'missing',
    expectedAction: 'restore-rollback-snapshot',
    expectedReason: 'CANDIDATE_INSTALLED_UNVERIFIED_SNAPSHOT_VERIFIED'
  },
  // 12d. will-quit during promotion after replacement verification.
  {
    crashPoint: 'will-quit-during-promotion',
    journal: 'replacement-verified',
    live: 'present-verified',
    snapshot: 'present-verified',
    candidate: 'missing',
    expectedAction: 'accept-verified-replacement',
    expectedReason: 'REPLACEMENT_VERIFIED_LIVE_VERIFIED'
  }
])

// ---------------------------------------------------------------------------
// v2 three-artifact recovery — decision matrix (LOCK-PROMO-6/10)
// ---------------------------------------------------------------------------

/** Controlled live Files directory artifact status. */
export type FilesArtifactStatus = 'missing' | 'present-unverified' | 'present-verified'

/** Controlled live Dexie catalog applied status (renderer boundary facts). */
export type CatalogAppliedStatus = 'unknown' | 'verified' | 'unverified'

/**
 * Full v2 recovery input — the three-artifact observation space. The gate
 * fills disk-probeable fields pre-window; `catalogApplied` is 'unknown'
 * until the renderer boundary is available (window mode).
 */
export interface PromotionRecoveryInputV2 {
  readonly journal: PromotionJournalObservation
  readonly live: LiveDbArtifactStatus
  readonly dbSnapshot: SnapshotArtifactStatus
  readonly candidate: CandidateArtifactStatus
  /** Live Files directory (installed generation) parity status. */
  readonly files: FilesArtifactStatus
  /** Retained Files snapshot verification status. */
  readonly filesSnapshot: FilesArtifactStatus
  /** `Files.promote-staging` presence — mid-install old-generation evidence. */
  readonly filesStaging: 'missing' | 'present'
  /** Retained catalog snapshot verification status. */
  readonly catalogSnapshot: SnapshotArtifactStatus
  /** Live Dexie catalog vs candidate-receipt verification (renderer facts). */
  readonly catalogApplied: CatalogAppliedStatus
  /**
   * Candidate catalog handoff (files-catalog.json) presence/validity.
   *
   * The candidate chat.db and candidate Files dir are CONSUMED by the db /
   * Files installs, so at `files-installed`/`catalog-pending` the retained
   * candidate catalog handoff is the forward-completion evidence
   * (LOCK-JRNL-3: "candidate catalog are verified"). Optional for backward
   * compatibility with callers that construct the input before this field
   * existed: `undefined` is treated as NOT verified (fail-safe — it never
   * enables forward completion).
   */
  readonly candidateCatalog?: 'missing' | 'present'
  /**
   * Exact candidate-receipt identity of the live chat.db (LOCK-AMB-3/4).
   *
   * True ONLY after a successful exact size + SHA-256 comparison of the live
   * chat.db against the journal's NON-NULL candidate db receipt. Missing
   * receipt, unreadable DB, or mismatch is false (fail closed). The coarse
   * `present-verified` status cannot tell the old and new generations apart
   * (both pass SQLite integrity), so forward completion at
   * `files-installed`/`catalog-pending` and accept-new at
   * `catalog-applied`/`replacement-verified` are gated on this identity: a
   * rollback-midway crash (OLD db restored, NEW Files/catalog still live)
   * must never be misclassified as the new generation (LOCK-AMB-1).
   *
   * Optional for backward compatibility with callers that construct the
   * input before this field existed: `undefined` is treated as NOT matching
   * (fail-safe — it never enables forward completion or accept-new).
   */
  readonly liveDbReceiptMatchesCandidate?: boolean
}

/** The five v2 recovery actions. */
export const PROMOTION_RECOVERY_ACTIONS_V2 = [
  'keep-old-live',
  'complete-catalog-apply',
  'accept-verified-replacement',
  'restore-rollback-snapshot',
  'repair-required'
] as const

export type PromotionRecoveryActionV2 = (typeof PROMOTION_RECOVERY_ACTIONS_V2)[number]

/** Machine-readable v2 reason codes — one per matrix branch. */
export type PromotionRecoveryReasonCodeV2 =
  | 'NO_JOURNAL'
  | 'JOURNAL_INVALID'
  | 'V2_JOURNAL_WITH_V1_INPUT'
  | 'CANDIDATES_READY_NO_MUTATION'
  | 'SNAPSHOTS_READY_LIVE_INTACT'
  | 'SNAPSHOTS_READY_LIVE_MISSING_SNAPSHOT_VERIFIED'
  | 'SNAPSHOTS_READY_LIVE_MISSING_SNAPSHOT_UNAVAILABLE'
  | 'SNAPSHOTS_READY_AMBIGUOUS_INSTALL_SNAPSHOT_VERIFIED'
  | 'SNAPSHOTS_READY_AMBIGUOUS_INSTALL_SNAPSHOT_UNAVAILABLE'
  | 'DB_INSTALLED_RESTORE_SNAPSHOT_VERIFIED'
  | 'DB_INSTALLED_RESTORE_SNAPSHOT_UNAVAILABLE'
  | 'FILES_INSTALLED_FORWARD_VERIFIABLE'
  | 'FILES_INSTALLED_RESTORE_SNAPSHOT_VERIFIED'
  | 'FILES_INSTALLED_RESTORE_SNAPSHOT_UNAVAILABLE'
  | 'CATALOG_PENDING_FORWARD_VERIFIABLE'
  | 'CATALOG_PENDING_RESTORE_SNAPSHOT_VERIFIED'
  | 'CATALOG_PENDING_RESTORE_SNAPSHOT_UNAVAILABLE'
  | 'CATALOG_APPLIED_ACCEPT_ALL_VERIFIED'
  | 'CATALOG_APPLIED_RESTORE_SNAPSHOT_VERIFIED'
  | 'CATALOG_APPLIED_RESTORE_SNAPSHOT_UNAVAILABLE'
  | 'REPLACEMENT_VERIFIED_ACCEPT_ALL_VERIFIED'
  | 'REPLACEMENT_VERIFIED_RESTORE_SNAPSHOT_VERIFIED'
  | 'REPLACEMENT_VERIFIED_RESTORE_SNAPSHOT_UNAVAILABLE'

/** v2 decision — action + reason from the v2 union sets. */
export interface PromotionRecoveryDecisionV2 {
  readonly action: PromotionRecoveryActionV2
  readonly reason: PromotionRecoveryReasonCodeV2
}

/**
 * Decide the single v2 recovery action for one observed three-artifact
 * input (LOCK-PROMO-6). Pure, total, deterministic.
 *
 * Principles:
 * - candidates-ready: NO live mutation ever began — the old generation is
 *   untouched, so keep-old-live (the journal is stale/abandoned). The old
 *   receipts are still all-null at this phase, so a restore cannot be
 *   verified against them; keep the current live state exactly as-is.
 * - snapshots-ready: the destructive window was armed but not entered. A
 *   live present generation keeps-old ONLY when the candidate chat.db is
 *   still present (install not started). A missing candidate at this phase
 *   means the install rename consumed it without reaching `db-installed` —
 *   the live DB is the unverified candidate (a MIXED generation), which is
 *   never accepted as intact: converge all-old or repair. A missing live DB
 *   restores when ALL THREE retained snapshots verify.
 * - db-installed: only the DB was replaced; Files/catalog are still old —
 *   forward completion is IMPOSSIBLE, so restore all old.
 * - files-installed / catalog-pending: db+files installed; forward is
 *   preferred ONLY when the installed db and Files verify AND the live DB is
 *   EXACTLY the candidate (size + SHA-256 vs the journal candidate db
 *   receipt — LOCK-AMB-3) AND the candidate catalog handoff is verified AND
 *   no mid-install swap-staging evidence remains (LOCK-JRNL-3/4), else
 *   restore.
 * - catalog-applied / replacement-verified: accept ONLY when all three
 *   (db EXACTLY the candidate, files verified, catalogApplied verified)
 *   hold; else restore when the snapshots verify, else repair.
 * - An unverified snapshot is NEVER restored.
 */
export function decidePromotionRecoveryV2(input: PromotionRecoveryInputV2): PromotionRecoveryDecisionV2 {
  const {
    journal,
    live,
    dbSnapshot,
    candidate,
    files,
    filesSnapshot,
    filesStaging,
    catalogSnapshot,
    catalogApplied,
    candidateCatalog
  } = input

  if (journal.status === 'absent') {
    return { action: 'keep-old-live', reason: 'NO_JOURNAL' }
  }
  if (journal.status === 'invalid') {
    return { action: 'repair-required', reason: 'JOURNAL_INVALID' }
  }
  if (journal.journal.version === PROMOTION_JOURNAL_VERSION_V1) {
    return { action: 'repair-required', reason: 'V2_JOURNAL_WITH_V1_INPUT' }
  }

  const phase: PromotionJournalPhaseV2 = journal.journal.phase
  const dbSnapshotVerified = dbSnapshot === 'present-verified'
  const filesSnapshotVerified = filesSnapshot === 'present-verified'
  const catalogSnapshotVerified = catalogSnapshot === 'present-verified'
  const snapshotsVerified = dbSnapshotVerified && filesSnapshotVerified && catalogSnapshotVerified
  const liveVerified = live === 'present-verified'
  const filesVerified = files === 'present-verified'
  // LOCK-AMB-3/4: the installed generation is "verifiable" ONLY when the live
  // DB is EXACTLY the candidate (size + SHA-256 vs the journal candidate db
  // receipt). The coarse present-verified status cannot tell the old and new
  // generations apart (both pass SQLite integrity), so it must never be the
  // sole DB evidence: a rollback-midway crash leaves the OLD db restored with
  // NEW Files/catalog, which must never be forwarded (files-installed /
  // catalog-pending) or accepted (catalog-applied / replacement-verified).
  // `undefined` (pre-field callers) and `false` are both NOT matching.
  const installedVerifiable = liveVerified && filesVerified && input.liveDbReceiptMatchesCandidate === true
  // Candidate-generation evidence for forward completion. The candidate DB
  // is consumed by the db install, so from `files-installed` onwards the
  // retained candidate CATALOG handoff is the real forward evidence
  // (`candidateCatalog`, probed from files-catalog.json). `candidate` (the
  // candidate DB file) is accepted as an equivalent signal for inputs built
  // before the handoff probe existed. `candidateCatalog` absent/undefined is
  // NOT verified — fail-safe, it never enables forward completion.
  const candidateEvidence = candidate === 'present' || candidateCatalog === 'present'
  // The Files swap-staging dir holds the old live generation mid-install; an
  // unexpected staging artifact blocks forward completion (LOCK-JRNL-4) —
  // the proven all-old convergence (restore) is chosen instead.
  const forwardVerifiable = installedVerifiable && filesStaging === 'missing' && candidateEvidence

  switch (phase) {
    case 'candidates-ready': {
      // No live mutation ever began — the journal is stale/abandoned.
      return { action: 'keep-old-live', reason: 'CANDIDATES_READY_NO_MUTATION' }
    }
    case 'snapshots-ready': {
      if (live === 'missing') {
        // The live DB vanished after the destructive window was armed; the
        // all-old restore needs ALL THREE retained snapshots verified.
        return snapshotsVerified
          ? { action: 'restore-rollback-snapshot', reason: 'SNAPSHOTS_READY_LIVE_MISSING_SNAPSHOT_VERIFIED' }
          : { action: 'repair-required', reason: 'SNAPSHOTS_READY_LIVE_MISSING_SNAPSHOT_UNAVAILABLE' }
      }
      if (candidate === 'missing') {
        // The candidate chat.db was consumed by the install rename but
        // `db-installed` was never journaled — the live DB is the unverified
        // candidate (mixed with old Files/catalog). Never accepted as intact.
        return snapshotsVerified
          ? { action: 'restore-rollback-snapshot', reason: 'SNAPSHOTS_READY_AMBIGUOUS_INSTALL_SNAPSHOT_VERIFIED' }
          : { action: 'repair-required', reason: 'SNAPSHOTS_READY_AMBIGUOUS_INSTALL_SNAPSHOT_UNAVAILABLE' }
      }
      // Old generation fully intact; the destructive window was never entered.
      return { action: 'keep-old-live', reason: 'SNAPSHOTS_READY_LIVE_INTACT' }
    }
    case 'db-installed': {
      // Files + catalog still old — forward completion is impossible.
      return snapshotsVerified
        ? { action: 'restore-rollback-snapshot', reason: 'DB_INSTALLED_RESTORE_SNAPSHOT_VERIFIED' }
        : { action: 'repair-required', reason: 'DB_INSTALLED_RESTORE_SNAPSHOT_UNAVAILABLE' }
    }
    case 'files-installed': {
      if (forwardVerifiable) {
        return { action: 'complete-catalog-apply', reason: 'FILES_INSTALLED_FORWARD_VERIFIABLE' }
      }
      return snapshotsVerified
        ? { action: 'restore-rollback-snapshot', reason: 'FILES_INSTALLED_RESTORE_SNAPSHOT_VERIFIED' }
        : { action: 'repair-required', reason: 'FILES_INSTALLED_RESTORE_SNAPSHOT_UNAVAILABLE' }
    }
    case 'catalog-pending': {
      if (forwardVerifiable) {
        return { action: 'complete-catalog-apply', reason: 'CATALOG_PENDING_FORWARD_VERIFIABLE' }
      }
      return snapshotsVerified
        ? { action: 'restore-rollback-snapshot', reason: 'CATALOG_PENDING_RESTORE_SNAPSHOT_VERIFIED' }
        : { action: 'repair-required', reason: 'CATALOG_PENDING_RESTORE_SNAPSHOT_UNAVAILABLE' }
    }
    case 'catalog-applied': {
      if (catalogApplied === 'verified' && installedVerifiable) {
        return { action: 'accept-verified-replacement', reason: 'CATALOG_APPLIED_ACCEPT_ALL_VERIFIED' }
      }
      return snapshotsVerified
        ? { action: 'restore-rollback-snapshot', reason: 'CATALOG_APPLIED_RESTORE_SNAPSHOT_VERIFIED' }
        : { action: 'repair-required', reason: 'CATALOG_APPLIED_RESTORE_SNAPSHOT_UNAVAILABLE' }
    }
    case 'replacement-verified': {
      if (catalogApplied === 'verified' && installedVerifiable) {
        return { action: 'accept-verified-replacement', reason: 'REPLACEMENT_VERIFIED_ACCEPT_ALL_VERIFIED' }
      }
      return snapshotsVerified
        ? { action: 'restore-rollback-snapshot', reason: 'REPLACEMENT_VERIFIED_RESTORE_SNAPSHOT_VERIFIED' }
        : { action: 'repair-required', reason: 'REPLACEMENT_VERIFIED_RESTORE_SNAPSHOT_UNAVAILABLE' }
    }
  }
}

// ---------------------------------------------------------------------------
// v2 crash-point mapping (LOCK-PROMO-6 coverage anchor)
// ---------------------------------------------------------------------------

/** One documented v2 crash point mapped to canonical observations. */
export interface PromotionCrashPointExpectationV2 {
  readonly crashPoint: PromotionCrashPointV2
  /** Journal phase persisted at this crash point. */
  readonly journal: 'absent' | PromotionJournalPhaseV2
  readonly live: LiveDbArtifactStatus
  readonly dbSnapshot: SnapshotArtifactStatus
  readonly candidate: CandidateArtifactStatus
  readonly files: FilesArtifactStatus
  readonly filesSnapshot: FilesArtifactStatus
  readonly filesStaging: 'missing' | 'present'
  readonly catalogSnapshot: SnapshotArtifactStatus
  readonly catalogApplied: CatalogAppliedStatus
  /** Candidate catalog handoff (files-catalog.json) presence/validity. */
  readonly candidateCatalog: 'missing' | 'present'
  /**
   * Exact candidate-receipt identity of the live chat.db (LOCK-AMB-3). A
   * rollback-midway crash restores the OLD db (still SQLite-valid → probe
   * `present-verified`) while new Files/catalog stay live — only the exact
   * receipt comparison tells that state from the true new generation.
   */
  readonly liveDbReceiptMatchesCandidate: boolean
  readonly expectedAction: PromotionRecoveryActionV2
  readonly expectedReason: PromotionRecoveryReasonCodeV2
}

/**
 * Canonical v2 crash-point → decision matrix for the documented v2 crash
 * points. The journal column follows PROMOTION_OPERATION_ORDER_V2 anchors:
 * the journal only advances AFTER the corresponding operation completed.
 */
export const PROMOTION_CRASH_POINT_MATRIX_V2: readonly PromotionCrashPointExpectationV2[] = Object.freeze([
  // 1. Before candidates-ready: nothing persisted, nothing mutated.
  {
    crashPoint: 'before-candidates-ready',
    journal: 'absent',
    live: 'present-unverified',
    dbSnapshot: 'missing',
    candidate: 'present',
    files: 'present-verified',
    filesSnapshot: 'missing',
    filesStaging: 'missing',
    catalogSnapshot: 'missing',
    catalogApplied: 'unknown',
    candidateCatalog: 'missing',
    liveDbReceiptMatchesCandidate: false,
    expectedAction: 'keep-old-live',
    expectedReason: 'NO_JOURNAL'
  },
  // 2. Candidates journaled, snapshot work never started.
  {
    crashPoint: 'after-candidates-ready-before-snapshots',
    journal: 'candidates-ready',
    live: 'present-unverified',
    dbSnapshot: 'missing',
    candidate: 'present',
    files: 'present-verified',
    filesSnapshot: 'missing',
    filesStaging: 'missing',
    catalogSnapshot: 'missing',
    catalogApplied: 'unknown',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: false,
    expectedAction: 'keep-old-live',
    expectedReason: 'CANDIDATES_READY_NO_MUTATION'
  },
  // 3. DB snapshot retained, Files snapshot not yet.
  {
    crashPoint: 'after-db-snapshot-before-files-snapshot',
    journal: 'candidates-ready',
    live: 'present-unverified',
    dbSnapshot: 'present-verified',
    candidate: 'present',
    files: 'present-verified',
    filesSnapshot: 'missing',
    filesStaging: 'missing',
    catalogSnapshot: 'missing',
    catalogApplied: 'unknown',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: false,
    expectedAction: 'keep-old-live',
    expectedReason: 'CANDIDATES_READY_NO_MUTATION'
  },
  // 4. DB + Files snapshots retained, catalog snapshot not yet.
  {
    crashPoint: 'after-files-snapshot-before-catalog-snapshot',
    journal: 'candidates-ready',
    live: 'present-unverified',
    dbSnapshot: 'present-verified',
    candidate: 'present',
    files: 'present-verified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'missing',
    catalogApplied: 'unknown',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: false,
    expectedAction: 'keep-old-live',
    expectedReason: 'CANDIDATES_READY_NO_MUTATION'
  },
  // 5. All three snapshots retained, journal still candidates-ready.
  {
    crashPoint: 'after-catalog-snapshot-before-snapshots-ready',
    journal: 'candidates-ready',
    live: 'present-unverified',
    dbSnapshot: 'present-verified',
    candidate: 'present',
    files: 'present-verified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'unknown',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: false,
    expectedAction: 'keep-old-live',
    expectedReason: 'CANDIDATES_READY_NO_MUTATION'
  },
  // 6. Snapshots-ready journaled; destructive window armed, live intact.
  {
    crashPoint: 'after-snapshots-ready-before-live-close',
    journal: 'snapshots-ready',
    live: 'present-unverified',
    dbSnapshot: 'present-verified',
    candidate: 'present',
    files: 'present-verified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'unknown',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: false,
    expectedAction: 'keep-old-live',
    expectedReason: 'SNAPSHOTS_READY_LIVE_INTACT'
  },
  // 6b. Snapshots-ready but the live DB is missing (pre-existing or torn).
  {
    crashPoint: 'after-snapshots-ready-before-live-close',
    journal: 'snapshots-ready',
    live: 'missing',
    dbSnapshot: 'present-verified',
    candidate: 'present',
    files: 'present-verified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'unknown',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: false,
    expectedAction: 'restore-rollback-snapshot',
    expectedReason: 'SNAPSHOTS_READY_LIVE_MISSING_SNAPSHOT_VERIFIED'
  },
  // 7. Live closed, DB not yet installed. Live files/catalog still old.
  {
    crashPoint: 'after-live-close-before-db-install',
    journal: 'snapshots-ready',
    live: 'present-unverified',
    dbSnapshot: 'present-verified',
    candidate: 'present',
    files: 'present-verified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'unknown',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: false,
    expectedAction: 'keep-old-live',
    expectedReason: 'SNAPSHOTS_READY_LIVE_INTACT'
  },
  // 8. DB installed (candidate consumed), not yet journaled. The live DB is
  //    the unverified candidate mixed with old Files/catalog — never accepted
  //    as intact: converge all-old via the verified snapshots.
  {
    crashPoint: 'after-db-install-before-db-installed',
    journal: 'snapshots-ready',
    live: 'present-unverified',
    dbSnapshot: 'present-verified',
    candidate: 'missing',
    files: 'present-verified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'unknown',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: false,
    expectedAction: 'restore-rollback-snapshot',
    expectedReason: 'SNAPSHOTS_READY_AMBIGUOUS_INSTALL_SNAPSHOT_VERIFIED'
  },
  // 9. db-installed journaled; files/catalog still old. Forward impossible.
  {
    crashPoint: 'after-db-installed-before-files-install',
    journal: 'db-installed',
    live: 'present-unverified',
    dbSnapshot: 'present-verified',
    candidate: 'missing',
    files: 'present-verified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'unknown',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: false,
    expectedAction: 'restore-rollback-snapshot',
    expectedReason: 'DB_INSTALLED_RESTORE_SNAPSHOT_VERIFIED'
  },
  // 10. Files swapped (candidate → live), not yet journaled. Old live Files
  //     moved to staging (mid-install evidence).
  {
    crashPoint: 'after-files-install-before-files-installed',
    journal: 'db-installed',
    live: 'present-unverified',
    dbSnapshot: 'present-verified',
    candidate: 'missing',
    files: 'present-verified',
    filesSnapshot: 'present-verified',
    filesStaging: 'present',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'unknown',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: false,
    expectedAction: 'restore-rollback-snapshot',
    expectedReason: 'DB_INSTALLED_RESTORE_SNAPSHOT_VERIFIED'
  },
  // 10b. Files installed + journaled; db+files verify → forward.
  {
    crashPoint: 'after-files-installed-before-catalog-pending',
    journal: 'files-installed',
    live: 'present-verified',
    dbSnapshot: 'present-verified',
    candidate: 'missing',
    files: 'present-verified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'unknown',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: true,
    expectedAction: 'complete-catalog-apply',
    expectedReason: 'FILES_INSTALLED_FORWARD_VERIFIABLE'
  },
  // 10c. Files installed but the installed files fail parity → restore.
  {
    crashPoint: 'after-files-installed-before-catalog-pending',
    journal: 'files-installed',
    live: 'present-unverified',
    dbSnapshot: 'present-verified',
    candidate: 'missing',
    files: 'present-unverified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'unknown',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: false,
    expectedAction: 'restore-rollback-snapshot',
    expectedReason: 'FILES_INSTALLED_RESTORE_SNAPSHOT_VERIFIED'
  },
  // 11. catalog-pending journaled; db+files verify → complete forward.
  {
    crashPoint: 'after-catalog-pending-before-catalog-apply',
    journal: 'catalog-pending',
    live: 'present-verified',
    dbSnapshot: 'present-verified',
    candidate: 'missing',
    files: 'present-verified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'unknown',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: true,
    expectedAction: 'complete-catalog-apply',
    expectedReason: 'CATALOG_PENDING_FORWARD_VERIFIABLE'
  },
  // 12. Catalog transaction committed, not yet journaled.
  {
    crashPoint: 'after-catalog-apply-before-catalog-applied',
    journal: 'catalog-pending',
    live: 'present-verified',
    dbSnapshot: 'present-verified',
    candidate: 'missing',
    files: 'present-verified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'verified',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: true,
    expectedAction: 'complete-catalog-apply',
    expectedReason: 'CATALOG_PENDING_FORWARD_VERIFIABLE'
  },
  // 13. catalog-applied journaled; all three verify → accept.
  {
    crashPoint: 'after-catalog-applied-before-reopen',
    journal: 'catalog-applied',
    live: 'present-verified',
    dbSnapshot: 'present-verified',
    candidate: 'missing',
    files: 'present-verified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'verified',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: true,
    expectedAction: 'accept-verified-replacement',
    expectedReason: 'CATALOG_APPLIED_ACCEPT_ALL_VERIFIED'
  },
  // 14. Reopened, not yet verified.
  {
    crashPoint: 'after-reopen-before-verify',
    journal: 'catalog-applied',
    live: 'present-unverified',
    dbSnapshot: 'present-verified',
    candidate: 'missing',
    files: 'present-verified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'verified',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: false,
    expectedAction: 'restore-rollback-snapshot',
    expectedReason: 'CATALOG_APPLIED_RESTORE_SNAPSHOT_VERIFIED'
  },
  // 15-17. Verification failures (db/files/catalog) — restore when possible.
  {
    crashPoint: 'verify-db-failed',
    journal: 'catalog-applied',
    live: 'present-unverified',
    dbSnapshot: 'present-verified',
    candidate: 'missing',
    files: 'present-verified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'verified',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: false,
    expectedAction: 'restore-rollback-snapshot',
    expectedReason: 'CATALOG_APPLIED_RESTORE_SNAPSHOT_VERIFIED'
  },
  {
    crashPoint: 'verify-files-failed',
    journal: 'catalog-applied',
    live: 'present-verified',
    dbSnapshot: 'present-verified',
    candidate: 'missing',
    files: 'present-unverified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'verified',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: true,
    expectedAction: 'restore-rollback-snapshot',
    expectedReason: 'CATALOG_APPLIED_RESTORE_SNAPSHOT_VERIFIED'
  },
  {
    crashPoint: 'verify-catalog-failed',
    journal: 'catalog-applied',
    live: 'present-verified',
    dbSnapshot: 'present-verified',
    candidate: 'missing',
    files: 'present-verified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'unverified',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: true,
    expectedAction: 'restore-rollback-snapshot',
    expectedReason: 'CATALOG_APPLIED_RESTORE_SNAPSHOT_VERIFIED'
  },
  // 18. replacement-verified journaled; all three verify → accept.
  {
    crashPoint: 'after-replacement-verified-before-journal-cleanup',
    journal: 'replacement-verified',
    live: 'present-verified',
    dbSnapshot: 'present-verified',
    candidate: 'missing',
    files: 'present-verified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'verified',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: true,
    expectedAction: 'accept-verified-replacement',
    expectedReason: 'REPLACEMENT_VERIFIED_ACCEPT_ALL_VERIFIED'
  },
  // 19. Journal cleaned, crash before relaunch: verified replacement live.
  {
    crashPoint: 'before-relaunch',
    journal: 'absent',
    live: 'present-verified',
    dbSnapshot: 'present-verified',
    candidate: 'missing',
    files: 'present-verified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'verified',
    candidateCatalog: 'missing',
    liveDbReceiptMatchesCandidate: false,
    expectedAction: 'keep-old-live',
    expectedReason: 'NO_JOURNAL'
  },
  // 20a. will-quit during v2 promotion before candidates-ready journal.
  {
    crashPoint: 'will-quit-during-promotion',
    journal: 'absent',
    live: 'present-unverified',
    dbSnapshot: 'missing',
    candidate: 'present',
    files: 'present-verified',
    filesSnapshot: 'missing',
    filesStaging: 'missing',
    catalogSnapshot: 'missing',
    catalogApplied: 'unknown',
    candidateCatalog: 'missing',
    liveDbReceiptMatchesCandidate: false,
    expectedAction: 'keep-old-live',
    expectedReason: 'NO_JOURNAL'
  },
  // 20b. will-quit at candidates-ready (no mutation).
  {
    crashPoint: 'will-quit-during-promotion',
    journal: 'candidates-ready',
    live: 'present-unverified',
    dbSnapshot: 'missing',
    candidate: 'present',
    files: 'present-verified',
    filesSnapshot: 'missing',
    filesStaging: 'missing',
    catalogSnapshot: 'missing',
    catalogApplied: 'unknown',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: false,
    expectedAction: 'keep-old-live',
    expectedReason: 'CANDIDATES_READY_NO_MUTATION'
  },
  // 20c. will-quit at db-installed (files/catalog old → restore).
  {
    crashPoint: 'will-quit-during-promotion',
    journal: 'db-installed',
    live: 'present-unverified',
    dbSnapshot: 'present-verified',
    candidate: 'missing',
    files: 'present-verified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'unknown',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: false,
    expectedAction: 'restore-rollback-snapshot',
    expectedReason: 'DB_INSTALLED_RESTORE_SNAPSHOT_VERIFIED'
  },
  // 20d. will-quit at catalog-pending (db+files verify → forward).
  {
    crashPoint: 'will-quit-during-promotion',
    journal: 'catalog-pending',
    live: 'present-verified',
    dbSnapshot: 'present-verified',
    candidate: 'missing',
    files: 'present-verified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'unknown',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: true,
    expectedAction: 'complete-catalog-apply',
    expectedReason: 'CATALOG_PENDING_FORWARD_VERIFIABLE'
  },
  // 20e. will-quit at replacement-verified (all verify → accept).
  {
    crashPoint: 'will-quit-during-promotion',
    journal: 'replacement-verified',
    live: 'present-verified',
    dbSnapshot: 'present-verified',
    candidate: 'missing',
    files: 'present-verified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'verified',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: true,
    expectedAction: 'accept-verified-replacement',
    expectedReason: 'REPLACEMENT_VERIFIED_ACCEPT_ALL_VERIFIED'
  },
  // 21a. RECOVERY-TIME rollback-midway: the retained OLD db was restored but
  //      the crash hit before the OLD Files/catalog restore. Live DB = OLD
  //      (still SQLite-valid → probe present-verified, but NOT the candidate
  //      receipt), live Files = NEW, live catalog = NEW. Journaled at each of
  //      the four affected late phases — LOCK-AMB-3/4: the exact receipt
  //      identity must block forward/accept (the coarse present-verified
  //      status cannot tell generations apart). Converges all-old.
  {
    crashPoint: 'after-rollback-db-restore-before-files-restore',
    journal: 'files-installed',
    live: 'present-verified',
    dbSnapshot: 'present-verified',
    candidate: 'missing',
    files: 'present-verified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'verified',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: false,
    expectedAction: 'restore-rollback-snapshot',
    expectedReason: 'FILES_INSTALLED_RESTORE_SNAPSHOT_VERIFIED'
  },
  {
    crashPoint: 'after-rollback-db-restore-before-files-restore',
    journal: 'catalog-pending',
    live: 'present-verified',
    dbSnapshot: 'present-verified',
    candidate: 'missing',
    files: 'present-verified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'verified',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: false,
    expectedAction: 'restore-rollback-snapshot',
    expectedReason: 'CATALOG_PENDING_RESTORE_SNAPSHOT_VERIFIED'
  },
  {
    crashPoint: 'after-rollback-db-restore-before-files-restore',
    journal: 'catalog-applied',
    live: 'present-verified',
    dbSnapshot: 'present-verified',
    candidate: 'missing',
    files: 'present-verified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'verified',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: false,
    expectedAction: 'restore-rollback-snapshot',
    expectedReason: 'CATALOG_APPLIED_RESTORE_SNAPSHOT_VERIFIED'
  },
  {
    crashPoint: 'after-rollback-db-restore-before-files-restore',
    journal: 'replacement-verified',
    live: 'present-verified',
    dbSnapshot: 'present-verified',
    candidate: 'missing',
    files: 'present-verified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'verified',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: false,
    expectedAction: 'restore-rollback-snapshot',
    expectedReason: 'REPLACEMENT_VERIFIED_RESTORE_SNAPSHOT_VERIFIED'
  },
  // 21b. RECOVERY-TIME rollback-midway: OLD db AND OLD Files restored, crash
  //      before the OLD catalog restore. Live DB = OLD (probe
  //      present-verified, NOT the candidate receipt), live Files = OLD
  //      (fails candidate parity → present-unverified), live catalog = NEW.
  //      Journaled at each of the four affected late phases. Converges
  //      all-old (the restored old Files already gate the matrix).
  {
    crashPoint: 'after-rollback-files-restore-before-catalog-restore',
    journal: 'files-installed',
    live: 'present-verified',
    dbSnapshot: 'present-verified',
    candidate: 'missing',
    files: 'present-unverified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'verified',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: false,
    expectedAction: 'restore-rollback-snapshot',
    expectedReason: 'FILES_INSTALLED_RESTORE_SNAPSHOT_VERIFIED'
  },
  {
    crashPoint: 'after-rollback-files-restore-before-catalog-restore',
    journal: 'catalog-pending',
    live: 'present-verified',
    dbSnapshot: 'present-verified',
    candidate: 'missing',
    files: 'present-unverified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'verified',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: false,
    expectedAction: 'restore-rollback-snapshot',
    expectedReason: 'CATALOG_PENDING_RESTORE_SNAPSHOT_VERIFIED'
  },
  {
    crashPoint: 'after-rollback-files-restore-before-catalog-restore',
    journal: 'catalog-applied',
    live: 'present-verified',
    dbSnapshot: 'present-verified',
    candidate: 'missing',
    files: 'present-unverified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'verified',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: false,
    expectedAction: 'restore-rollback-snapshot',
    expectedReason: 'CATALOG_APPLIED_RESTORE_SNAPSHOT_VERIFIED'
  },
  {
    crashPoint: 'after-rollback-files-restore-before-catalog-restore',
    journal: 'replacement-verified',
    live: 'present-verified',
    dbSnapshot: 'present-verified',
    candidate: 'missing',
    files: 'present-unverified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'verified',
    candidateCatalog: 'present',
    liveDbReceiptMatchesCandidate: false,
    expectedAction: 'restore-rollback-snapshot',
    expectedReason: 'REPLACEMENT_VERIFIED_RESTORE_SNAPSHOT_VERIFIED'
  }
])
