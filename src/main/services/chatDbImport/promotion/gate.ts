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

import { probePromotionArtifacts, probePromotionArtifactsV2, probeResultToRecoveryInput } from './artifactProbe'
import type { PromotionJournalPhaseV2 } from './journal'
import { PROMOTION_JOURNAL_VERSION_V2 } from './journal'
import type { PromotionJournalCleanupIdentity } from './journalStore'
import { cleanupPromotionJournalAtV2Phase } from './journalStore'
import {
  decidePromotionRecovery,
  decidePromotionRecoveryV2,
  type PromotionJournalObservation,
  type PromotionRecoveryActionV2,
  type PromotionRecoveryDecision,
  type PromotionRecoveryDecisionV2,
  type PromotionRecoveryReasonCodeV2
} from './recovery'
import {
  createRecoveryExecutor,
  type RecoveryExecutionPrimitives,
  type RecoveryExecutorResult
} from './recoveryExecutor'
import type { RestartMode } from './restart'

const logger = loggerService.withContext('chatDbImportPromotionGate')

// ---------------------------------------------------------------------------
// Gate result
// ---------------------------------------------------------------------------

/**
 * Gate decision — either the v1 chat.db-only decision or the v2
 * three-artifact decision (dispatched on the journal version).
 */
export type StartupGateDecision =
  | PromotionRecoveryDecision
  | {
      readonly action: PromotionRecoveryActionV2
      readonly reason: PromotionRecoveryReasonCodeV2
    }

/**
 * Result of the startup recovery gate. Never throws — startup must
 * continue regardless of recovery outcomes (LOCK-L3), EXCEPT for
 * repair-required which hard-blocks init.
 */
export interface StartupRecoveryGateResult {
  /** The recovery decision from the pure matrix (v1 or v2 dispatch). */
  readonly decision: StartupGateDecision
  /** The executor result if one was run. Null for absent-journal fast path. */
  readonly executorResult: RecoveryExecutorResult | null
  /** Whether the gate determined repair is required (hard-blocks init). */
  readonly repairRequired: boolean
  /** Whether a relaunch is pending (process will exit). */
  readonly relaunchPending: boolean
  /**
   * LOCK-PROD-7: true when the recovery requested an in-process main
   * renderer reload (non-packaged). At startup the window does not exist
   * yet, so the reload is a bounded no-op and startup proceeds normally —
   * the freshly created renderer applies the pending projection.
   */
  readonly inProcessReloadRequested: boolean
  /**
   * LOCK-PROMO-7: true when the v2 journal is at a phase whose recovery
   * needs the renderer catalog boundary (catalog-pending or later, or a
   * v2 restore). The app must boot into the recovery-only surface; normal
   * application UI stays blocked until the handoff converges.
   */
  readonly catalogRecoveryRequired: boolean
  /** The pending catalog recovery action for the recovery-only surface. */
  readonly catalogRecoveryAction: 'complete-catalog-apply' | 'restore-snapshot' | 'accept-verified-replacement' | null
  /** The v2 journal phase that blocked ordinary startup. */
  readonly catalogRecoveryPhase: string | null
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
    /**
     * LOCK-PROD-7 restart strategy override forwarded to the recovery
     * executor. Defaults to packaged → relaunch, non-packaged → in-process
     * renderer reload (resolved from `app.isPackaged`).
     */
    restartMode?: RestartMode
  }
): Promise<StartupRecoveryGateResult> {
  const dataRoot = options?.dataRoot ?? DATA_PATH

  // ======================================================================
  // 1. Quick journal observation (async read for the fast path)
  // ======================================================================
  let journalObservation: PromotionJournalObservation
  let journalVersion: number | null = null
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
        relaunchPending: false,
        inProcessReloadRequested: false,
        catalogRecoveryRequired: false,
        catalogRecoveryAction: null,
        catalogRecoveryPhase: null
      }
    }
    if (journalResult.status === 'invalid') {
      journalObservation = { status: 'invalid' }
    } else {
      journalObservation = journalResult
      journalVersion = journalResult.journal.version
    }
  } catch (error) {
    // I/O failure reading the journal: treat as invalid (LOCK-4414).
    journalObservation = { status: 'invalid' }
    logger.warn('Failed to read promotion journal during gate (I/O failure)', error as Error)
  }

  // ======================================================================
  // 2. v2 three-artifact dispatch (LOCK-PROMO-6/7)
  // ======================================================================
  if (journalVersion === PROMOTION_JOURNAL_VERSION_V2 && journalObservation.status === 'valid') {
    const v2CandidateId = journalObservation.journal.candidateId
    const v2Probe = probePromotionArtifactsV2(v2CandidateId, dataRoot)
    const v2Input = {
      journal: v2Probe.journal,
      live: v2Probe.live,
      dbSnapshot: v2Probe.dbSnapshot,
      candidate: v2Probe.candidate,
      files: v2Probe.files,
      filesSnapshot: v2Probe.filesSnapshot,
      filesStaging: v2Probe.filesStaging,
      catalogSnapshot: v2Probe.catalogSnapshot,
      catalogApplied: v2Probe.catalogApplied as 'unknown'
    }
    const v2Decision: PromotionRecoveryDecisionV2 = decidePromotionRecoveryV2(v2Input)
    const v2Phase = journalObservation.journal.phase

    logger.info(`Promotion recovery gate v2 decision: action=${v2Decision.action}, reason=${v2Decision.reason}`)

    if (v2Decision.action === 'repair-required') {
      logger.warn(
        `Promotion recovery gate: v2 repair required (${v2Decision.reason}) — ` +
          'normal init will be blocked until repair is completed'
      )
      try {
        const { chatDbService } = await import('@main/services/chatDb')
        chatDbService.markRepairRequiredBeforeInit()
      } catch (error) {
        logger.error(
          'Promotion recovery gate: failed to write durable repair marker (init still blocked this session)',
          error as Error
        )
      }
      return {
        decision: { action: 'repair-required', reason: v2Decision.reason },
        executorResult: null,
        repairRequired: true,
        relaunchPending: false,
        inProcessReloadRequested: false,
        catalogRecoveryRequired: false,
        catalogRecoveryAction: null,
        catalogRecoveryPhase: v2Phase
      }
    }

    if (v2Decision.action === 'keep-old-live') {
      // No live mutation (candidates-ready / snapshots-ready with the old
      // generation intact): cleanup the v2 journal at its current phase and
      // proceed — no renderer boundary needed.
      const identity: PromotionJournalCleanupIdentity = {
        sessionId: journalObservation.journal.sessionId,
        candidateId: journalObservation.journal.candidateId
      }
      try {
        await cleanupPromotionJournalAtV2Phase(v2Phase as PromotionJournalPhaseV2, identity, dataRoot)
        logger.info(`Promotion recovery gate: v2 keep-old-live cleaned the ${String(v2Phase)} journal`)
      } catch (error) {
        logger.warn('Promotion recovery gate: v2 keep-old-live journal cleanup failed (non-fatal)', error as Error)
      }
      return {
        decision: { action: 'keep-old-live', reason: v2Decision.reason },
        executorResult: null,
        repairRequired: false,
        relaunchPending: false,
        inProcessReloadRequested: false,
        catalogRecoveryRequired: false,
        catalogRecoveryAction: null,
        catalogRecoveryPhase: null
      }
    }

    // restore / complete-catalog-apply / accept — all need the renderer
    // catalog boundary (LOCK-PROMO-7): defer to the recovery-only window.
    logger.warn(
      `Promotion recovery gate: v2 action ${v2Decision.action} requires the renderer catalog boundary ` +
        `(phase ${String(v2Phase)}) — booting the recovery-only surface; ordinary UI blocked`
    )
    // LOCK-BRIDGE-4: report the TRUE v2 decision action — the gate deferred
    // the action to the recovery window rather than executing it, so the
    // decision must not claim keep-old-live. The dedicated
    // `catalogRecoveryAction` handoff is retained unchanged.
    return {
      decision: { action: v2Decision.action, reason: v2Decision.reason },
      executorResult: null,
      repairRequired: false,
      relaunchPending: false,
      inProcessReloadRequested: false,
      catalogRecoveryRequired: true,
      catalogRecoveryAction: v2Decision.action === 'restore-rollback-snapshot' ? 'restore-snapshot' : v2Decision.action,
      catalogRecoveryPhase: v2Phase
    }
  }

  // ======================================================================
  // 3. v1 chat.db-only path (unchanged) — probe all promotion artifacts
  // ======================================================================
  let candidateId: string | null = null
  if (journalObservation.status === 'valid') {
    candidateId = journalObservation.journal.candidateId
  }

  const probes = probePromotionArtifacts(candidateId, dataRoot, options?.sampleCount ?? 3)

  // ======================================================================
  // 4. Decide via pure matrix
  // ======================================================================
  const input = probeResultToRecoveryInput(probes)
  const decision = decidePromotionRecovery(input)

  logger.info(`Promotion recovery gate decision: action=${decision.action}, reason=${decision.reason}`)

  // ======================================================================
  // 5. Repair-required: hard-block init, write durable marker, return
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
      relaunchPending: false,
      inProcessReloadRequested: false,
      catalogRecoveryRequired: false,
      catalogRecoveryAction: null,
      catalogRecoveryPhase: null
    }
  }

  // ======================================================================
  // 6. Skip execution in test mode
  // ======================================================================
  if (options?.skipExecution) {
    return {
      decision,
      executorResult: null,
      repairRequired: false,
      relaunchPending: false,
      inProcessReloadRequested: false,
      catalogRecoveryRequired: false,
      catalogRecoveryAction: null,
      catalogRecoveryPhase: null
    }
  }

  // ======================================================================
  // 7. Execute recovery via the executor
  // ======================================================================
  const executor = createRecoveryExecutor({
    dataRoot,
    liveDb: {
      isInitialised: () => liveDbIsInitialised
    },
    primitives: options?.primitives,
    // LOCK-PROD-7: explicit stable injection wins; otherwise the executor
    // resolves from `app.isPackaged` (packaged → relaunch, non-packaged →
    // in-process renderer reload).
    restartMode: options?.restartMode
  })

  const executorResult = await executor.run()

  // ======================================================================
  // 8. Determine if relaunch / in-process reload is pending
  // ======================================================================
  // LOCK-PROD-7: a packaged relaunch terminates the process
  // (relaunchPending). A non-packaged in-process reload keeps the process
  // alive (inProcessReloadRequested) — at startup the window is created
  // fresh afterwards, so no reload action is needed here.
  let inProcessReloadRequested = false
  let relaunchPending = false
  if (
    executorResult.ok &&
    (executorResult.action.action === 'accept-verified-replacement' ||
      executorResult.action.action === 'restore-rollback-snapshot')
  ) {
    inProcessReloadRequested = executorResult.inProcessReload === true
    relaunchPending = !inProcessReloadRequested
  }

  return {
    decision,
    executorResult,
    repairRequired: false,
    relaunchPending,
    inProcessReloadRequested,
    catalogRecoveryRequired: false,
    catalogRecoveryAction: null,
    catalogRecoveryPhase: null
  }
}
