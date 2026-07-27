/**
 * Startup recovery seam for the app-ready lifecycle.
 *
 * Called once from src/main/index.ts at the same safe app-ready stage as the
 * original import temp-workspace recovery (LOCK-L1). Candidate recovery only
 * removes owned, aged `candidate-*` directories per candidateDb policy.
 *
 * Each recovery step is contained in its own try/catch so a failure is logged
 * through loggerService and never prevents normal app startup (LOCK-L3).
 */

import { loggerService } from '@logger'

import { recoverOrphanedCandidates } from './candidateDb'
import { recoverOrphanedTempWorkspaces } from './tempWorkspace'

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
