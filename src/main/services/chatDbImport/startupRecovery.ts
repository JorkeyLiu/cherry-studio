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
 * Phase 4.4.1+ executor. Phase 4.4.0 does NOT read journals, probe files,
 * or execute recovery here, and the existing orphan cleanup behavior is
 * unchanged. When the executor is wired, a journal-referenced candidate
 * MUST be excluded from the age-based candidate cleanup — a promoting
 * candidate is never an ordinary import leftover (LOCK-4401).
 */

import { loggerService } from '@logger'

import { recoverOrphanedCandidates } from './candidateDb'
import { recoverOrphanedTempWorkspaces } from './tempWorkspace'

// Pure promotion recovery decision contract (no side effects, LOCK-4405).
export {
  decidePromotionRecovery,
  PROMOTION_CRASH_POINT_MATRIX,
  type PromotionRecoveryDecision,
  type PromotionRecoveryInput
} from './promotion/recovery'

const logger = loggerService.withContext('chatDbImport')

/**
 * Recover orphaned import artifacts from prior crashes:
 * 1. Import temp workspaces (R-2) — preserved original startup order.
 * 2. Candidate databases (Phase 4.2) — owned candidate dirs only.
 *
 * Never throws; failures are logged as non-fatal warnings.
 */
export async function recoverOrphanedImportArtifacts(): Promise<void> {
  try {
    await recoverOrphanedTempWorkspaces()
  } catch (error) {
    logger.warn('Failed to recover orphaned import workspaces (non-fatal):', error as Error)
  }

  try {
    await recoverOrphanedCandidates()
  } catch (error) {
    logger.warn('Failed to recover orphaned candidate databases (non-fatal):', error as Error)
  }
}
