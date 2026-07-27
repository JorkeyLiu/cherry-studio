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

import type { PromotionJournalPhase, PromotionJournalV1 } from './journal'
import type { PromotionCrashPoint } from './protocol'

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
  | { readonly status: 'valid'; readonly journal: PromotionJournalV1 }

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
 * Decide the single recovery action for one observed input (LOCK-4406).
 *
 * Matrix (journal → branch):
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
 *
 * Notes:
 * - `keep-old-live` means "keep whatever the live path currently holds and
 *   proceed with normal startup"; with no journal there is no in-flight
 *   promotion so the current live IS the authoritative DB (this also covers
 *   the post-cleanup, pre-relaunch crash point where the verified
 *   replacement already became the live DB).
 * - snapshot-ready + candidate missing is the install-ambiguous window
 *   (install may have run before `candidate-installed` was journaled); the
 *   live content cannot be trusted either way, so only a verified snapshot
 *   allows deterministic restore.
 * - An unverified snapshot is NEVER restored (it could be a torn copy).
 */
export function decidePromotionRecovery(input: PromotionRecoveryInput): PromotionRecoveryDecision {
  const { journal, live, snapshot, candidate } = input

  if (journal.status === 'absent') {
    return { action: 'keep-old-live', reason: 'NO_JOURNAL' }
  }
  if (journal.status === 'invalid') {
    return { action: 'repair-required', reason: 'JOURNAL_INVALID' }
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
