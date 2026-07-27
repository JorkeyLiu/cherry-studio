/**
 * Startup recovery gate — integration seam for the app-ready lifecycle
 * (Phase 4.4.3, LOCK-4431..LOCK-4439).
 *
 * Called once from src/main/index.ts BEFORE chatDbService.init(). Probes
 * the promotion artifacts on disk, decides the recovery action via the
 * pure decision matrix, and executes the action deterministically.
 *
 * LOCK-4431: recovery gate runs BEFORE normal live init. Disk
 * journal/artifacts decide the action for both in-process continuation
 * and restart after crash.
 *
 * Startup ordering contract:
 *   1. BackupManager.handleStartupRestore() completes
 *   2. THIS GATE runs (promotion recovery)
 *   3. chatDbService.init() runs
 *   4. Ordinary orphan cleanup / window startup
 *
 * Absent-journal fast path: no journal means no destructive promotion ever
 * began — proceed without validating retained snapshot and without relaunch.
 * This is the common case and should be fast.
 *
 * Repair-required: hard-blocks normal init. The existing repair flow
 * (chatDbService.init failure path) handles this.
 *
 * Main-only module. Not exposed over IPC/preload/renderer.
 */

import { loggerService } from '@logger'
import { DATA_PATH } from '@main/config'

import { probePromotionArtifacts, probeResultToRecoveryInput } from './artifactProbe'
import { decidePromotionRecovery, type PromotionJournalObservation, type PromotionRecoveryDecision } from './recovery'
import {
  createRecoveryExecutor,
  type RecoveryExecutionPrimitives,
  type RecoveryExecutorResult
} from './recoveryExecutor'

const logger = loggerService.withContext('chatDbImportPromotionGate')

// ---------------------------------------------------------------------------
// Gate result
// ---------------------------------------------------------------------------

/**
 * Result of the startup recovery gate. Never throws — startup must
 * continue regardless of recovery outcomes (LOCK-L3), EXCEPT for
 * repair-required which hard-blocks init.
 */
export interface StartupRecoveryGateResult {
  /** The recovery decision from the pure matrix. */
  readonly decision: PromotionRecoveryDecision
  /** The executor result if one was run. Null for absent-journal fast path. */
  readonly executorResult: RecoveryExecutorResult | null
  /** Whether the gate determined repair is required (hard-blocks init). */
  readonly repairRequired: boolean
  /** Whether a relaunch is pending (process will exit). */
  readonly relaunchPending: boolean
}

// ---------------------------------------------------------------------------
// Gate function
// ---------------------------------------------------------------------------

/**
 * Run the startup recovery gate. Called once from src/main/index.ts after
 * BackupManager.handleStartupRestore() and BEFORE chatDbService.init().
 *
 * Absent-journal fast path (common case): if no journal exists, return
 * immediately with keep-old-live decision and no executor run. This path
 * does NOT validate the retained snapshot and does NOT relaunch.
 *
 * Valid journal: probe all artifacts, decide the action, execute it.
 *
 * @param liveDbIsInitialised  Whether the live DB has been initialized
 *   (for the gate's own probing — should be false at this point).
 * @param options              Optional overrides for testing.
 */
export async function runStartupRecoveryGate(
  liveDbIsInitialised: boolean = false,
  options?: {
    dataRoot?: string
    sampleCount?: number
    /** Test injection: skip the executor for dry-run tests. */
    skipExecution?: boolean
    /** Test injection: override probe/decide/primitives. */
    primitives?: RecoveryExecutionPrimitives
  }
): Promise<StartupRecoveryGateResult> {
  const dataRoot = options?.dataRoot ?? DATA_PATH

  // ======================================================================
  // 1. Quick journal observation (async read for the fast path)
  // ======================================================================
  let journalObservation: PromotionJournalObservation
  try {
    const { readPromotionJournal } = await import('./journalStore')
    const journalResult = await readPromotionJournal(dataRoot)
    if (journalResult.status === 'absent') {
      // ABSENT-JOURNAL FAST PATH (common case):
      // No journal = no destructive promotion ever began.
      // Do NOT validate retained snapshot, do NOT relaunch, proceed normally.
      logger.info('Promotion recovery gate: absent journal — no recovery needed (fast path)')
      return {
        decision: { action: 'keep-old-live', reason: 'NO_JOURNAL' },
        executorResult: null,
        repairRequired: false,
        relaunchPending: false
      }
    }
    if (journalResult.status === 'invalid') {
      journalObservation = { status: 'invalid' }
    } else {
      journalObservation = journalResult
    }
  } catch (error) {
    // I/O failure reading the journal: treat as invalid (LOCK-4414).
    journalObservation = { status: 'invalid' }
    logger.warn('Failed to read promotion journal during gate (I/O failure)', error as Error)
  }

  // ======================================================================
  // 2. Probe all promotion artifacts (synchronous, comprehensive)
  // ======================================================================
  let candidateId: string | null = null
  if (journalObservation.status === 'valid') {
    candidateId = journalObservation.journal.candidateId
  }

  const probes = probePromotionArtifacts(candidateId, dataRoot, options?.sampleCount ?? 3)

  // ======================================================================
  // 3. Decide via pure matrix
  // ======================================================================
  const input = probeResultToRecoveryInput(probes)
  const decision = decidePromotionRecovery(input)

  logger.info(`Promotion recovery gate decision: action=${decision.action}, reason=${decision.reason}`)

  // ======================================================================
  // 4. Repair-required: hard-block init, write durable marker, return
  // ======================================================================
  if (decision.action === 'repair-required') {
    logger.warn(
      `Promotion recovery gate: repair required (${decision.reason}) — ` +
        'normal init will be blocked until repair is completed'
    )

    // LOCK-4437: durably write the repair marker before reporting success.
    // The marker survives crashes and hard-blocks subsequent init calls.
    try {
      const { chatDbService } = await import('@main/services/chatDb')
      chatDbService.markRepairRequiredBeforeInit()
    } catch (error) {
      // Marker write failure: the repair decision is still correct, but
      // the durable evidence may not survive a crash. Log and continue —
      // the gate still returns repairRequired: true so init is blocked
      // this session.
      logger.error(
        'Promotion recovery gate: failed to write durable repair marker (init still blocked this session)',
        error as Error
      )
    }

    return {
      decision,
      executorResult: null,
      repairRequired: true,
      relaunchPending: false
    }
  }

  // ======================================================================
  // 5. Skip execution in test mode
  // ======================================================================
  if (options?.skipExecution) {
    return {
      decision,
      executorResult: null,
      repairRequired: false,
      relaunchPending: false
    }
  }

  // ======================================================================
  // 6. Execute recovery via the executor
  // ======================================================================
  const executor = createRecoveryExecutor({
    dataRoot,
    liveDb: {
      isInitialised: () => liveDbIsInitialised
    },
    primitives: options?.primitives
  })

  const executorResult = await executor.run()

  // ======================================================================
  // 7. Determine if relaunch is pending
  // ======================================================================
  const relaunchPending =
    executorResult.ok &&
    (executorResult.action.action === 'accept-verified-replacement' ||
      executorResult.action.action === 'restore-rollback-snapshot')

  return {
    decision,
    executorResult,
    repairRequired: false,
    relaunchPending
  }
}
