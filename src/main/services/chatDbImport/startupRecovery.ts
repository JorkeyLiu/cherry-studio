/**
 * Startup recovery seam for the app-ready lifecycle.
 *
 * Called once from src/main/index.ts at the same safe app-ready stage as the
 * original import temp-workspace recovery (LOCK-L1). Candidate recovery only
 * removes owned, aged `candidate-*` directories per candidateDb policy.
 *
 * Each recovery step is contained in its own try/catch so a failure is logged
 * through loggerService and never prevents normal app startup (LOCK-L3).
 *
 * Promotion recovery contract (Phase 4.4.0, LOCK-4405/4406): this seam
 * re-exports the pure promotion recovery decision surface for the future
 * Phase 4.4.1+ executor. Recovery EXECUTION (snapshot restore, rollback,
 * live-DB probing) is NOT performed here.
 *
 * Journal-aware candidate protection (Phase 4.4.1, LOCK-4401/4413/4414):
 * the caller may pass a `PromotionJournalObservation` (produced by the
 * separately-implemented journalStore — this module never reads journal
 * bytes itself):
 * - `absent` (or no observation given) — existing age-based cleanup runs
 *   unchanged.
 * - `valid`  — the journal-referenced candidate ID is excluded from the
 *   age-based cleanup. The journal is the truth source; mtime never decides
 *   the fate of a promoting candidate (LOCK-4413).
 * - `invalid` — promotion progress is unknowable, so candidate cleanup is
 *   BLOCKED entirely and surfaced explicitly in the typed result
 *   (LOCK-4414: invalid != absent, never silently deleted/continued).
 *   Startup itself still proceeds (LOCK-L3); acting on the blocked state
 *   (repair flow, user surfacing) is later-phase product scope.
 *
 * Phase 4.4.3 promotion recovery gate (LOCK-4431..LOCK-4439):
 * re-exports the startup recovery gate API for integration into the
 * app-ready lifecycle. The gate runs BEFORE chatDbService.init() and
 * executes the determined recovery action deterministically.
 */

import { loggerService } from '@logger'

import { isValidOwnedCandidateId, recoverOrphanedCandidates } from './candidateDb'
import type { PromotionJournalObservation } from './promotion/recovery'
import { recoverOrphanedTempWorkspaces } from './tempWorkspace'

// Pure promotion recovery decision contract (no side effects, LOCK-4405).
export type { PromotionJournalObservation } from './promotion/recovery'
export {
  decidePromotionRecovery,
  PROMOTION_CRASH_POINT_MATRIX,
  type PromotionRecoveryDecision,
  type PromotionRecoveryInput
} from './promotion/recovery'

// Phase 4.4.3 startup recovery gate (LOCK-4431..LOCK-4439).
export { runStartupRecoveryGate, type StartupRecoveryGateResult } from './promotion/gate'

const logger = loggerService.withContext('chatDbImport')

/** Outcome of the candidate-cleanup step of startup recovery. */
export type CandidateCleanupOutcome =
  /** Age-based cleanup ran (protection applied when a valid journal named a candidate). */
  | 'completed'
  /** Cleanup ran but failed non-fatally (logged; startup continues). */
  | 'failed'
  /**
   * Cleanup was NOT run because the journal observation was `invalid`
   * (LOCK-4414). Nothing under the candidate root was deleted.
   */
  | 'blocked-invalid-journal'
  /**
   * Cleanup was NOT run because a `valid` observation carried a candidate ID
   * outside the strict allowlist. Defence-in-depth (LOCK-4415): an ID that
   * cannot map to an owned leaf name protects nothing, and cleanup must not
   * proceed on contradictory protection input.
   */
  | 'blocked-unsafe-candidate-id'

/**
 * Typed result of startup recovery. Startup never throws on recovery
 * failures (LOCK-L3); callers that need to react to a blocked candidate
 * cleanup (invalid journal ⇒ repair-required flow in a later phase) read it
 * from here instead of exceptions.
 */
export interface StartupRecoveryResult {
  readonly tempWorkspaceCleanup: 'completed' | 'failed'
  readonly candidateCleanup: CandidateCleanupOutcome
  /** Candidate ID protected from age-based cleanup, when one was. */
  readonly protectedCandidateId: string | null
}

/**
 * Recover orphaned import artifacts from prior crashes:
 * 1. Import temp workspaces (R-2) — preserved original startup order.
 * 2. Candidate databases (Phase 4.2) — owned candidate dirs only, subject to
 *    the journal observation rules documented on this module.
 *
 * Never throws; failures are logged as non-fatal warnings and reflected in
 * the returned {@link StartupRecoveryResult}.
 *
 * @param journal Journal observation supplied by the caller (journalStore
 *   seam). Omitted/`absent` preserves the pre-4.4.1 behavior exactly.
 */
export async function recoverOrphanedImportArtifacts(
  journal: PromotionJournalObservation = { status: 'absent' }
): Promise<StartupRecoveryResult> {
  let tempWorkspaceCleanup: StartupRecoveryResult['tempWorkspaceCleanup'] = 'completed'
  try {
    await recoverOrphanedTempWorkspaces()
  } catch (error) {
    tempWorkspaceCleanup = 'failed'
    logger.warn('Failed to recover orphaned import workspaces (non-fatal):', error as Error)
  }

  if (journal.status === 'invalid') {
    // LOCK-4414: invalid is NOT absent. Promotion may have begun and its
    // progress is unknowable — deleting any candidate here could destroy the
    // only recovery source. Block candidate cleanup and surface explicitly.
    logger.warn(
      'Promotion journal is present but invalid: blocking candidate cleanup until repair (no candidate directories were deleted).'
    )
    return { tempWorkspaceCleanup, candidateCleanup: 'blocked-invalid-journal', protectedCandidateId: null }
  }

  let protectedCandidateId: string | null = null
  if (journal.status === 'valid') {
    if (!isValidOwnedCandidateId(journal.journal.candidateId)) {
      // The journal candidate ID must be the exact owned directory leaf name
      // (`candidate-<sessionId>`, as emitted by the import session). An ID
      // outside the strict allowlist OR without the owned prefix cannot map
      // to an owned leaf, so it protects nothing — refuse to clean rather
      // than run cleanup on contradictory protection input (LOCK-4415).
      logger.warn(
        'Valid journal observation carried a candidate ID that cannot map to an owned candidate directory: blocking candidate cleanup (no candidate directories were deleted).'
      )
      return { tempWorkspaceCleanup, candidateCleanup: 'blocked-unsafe-candidate-id', protectedCandidateId: null }
    }
    protectedCandidateId = journal.journal.candidateId
  }

  let candidateCleanup: CandidateCleanupOutcome = 'completed'
  try {
    if (protectedCandidateId !== null) {
      await recoverOrphanedCandidates(undefined, { protectedCandidateIds: [protectedCandidateId] })
    } else {
      await recoverOrphanedCandidates()
    }
  } catch (error) {
    candidateCleanup = 'failed'
    logger.warn('Failed to recover orphaned candidate databases (non-fatal):', error as Error)
  }

  return { tempWorkspaceCleanup, candidateCleanup, protectedCandidateId }
}
