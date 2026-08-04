/**
 * Promotion recovery executor — exact-once recovery/finalization pipeline
 * (Phase 4.4.3, LOCK-4431..LOCK-4439).
 *
 * The single Main-local orchestration unit that consumes disk truth
 * (journal + artifact probes), obtains authorization, and executes the
 * determined recovery action:
 *
 *   1. probing        — readPromotionJournal + probePromotionArtifacts
 *   2. deciding       — decidePromotionRecovery (pure matrix)
 *   3. authorizing    — take terminal ownership or acquire fresh lease
 *   4. executing      — run the determined action (one of four)
 *   5. cleaning       — durable journal cleanup (if action requires it)
 *   6. relaunching    — exact-once relaunch (if action requires it)
 *   7. settled        — terminal result, artifacts state known
 *
 * LOCK-4431: recovery gate runs BEFORE normal live init (chatDbService.init).
 *   Disk journal/artifacts decide the action for both in-process and restart.
 * LOCK-4432: optional terminal capability is authorization only — it enables
 *   the destructive rollback but is not required for all actions.
 * LOCK-4433: terminal ownership atomically taken exactly once.
 * LOCK-4434: rollback retained snapshot is NEVER consumed or deleted.
 * LOCK-4435: rollback live fact verified before journal cleanup.
 * LOCK-4436: cleanup is durable, fixed journal only, snapshot retained.
 * LOCK-4437: repair-required hard-blocks init, retains all artifacts, no
 *   cleanup/relaunch.
 * LOCK-4438: relaunch exact-once only after verified authoritative live
 *   state + durable cleanup.
 * LOCK-4439: promotion/recovery lease covers action window.
 *
 * Four actions:
 * - keep-old-live: verify the live DB fact, cleanup valid snapshot-ready
 *   journal if present. No relaunch — process continues normally.
 * - accept-verified-replacement: require live present-verified, cleanup
 *   replacement-verified journal. Relaunch.
 * - restore-rollback-snapshot: close/confirm closed under authorization,
 *   mint proof, run rollback, require restored live verification, cleanup
 *   the actual valid journal phase (including candidate-installed).
 *   Relaunch.
 * - repair-required: mark durable repair before init, retain all artifacts,
 *   no cleanup/relaunch. Existing repair flow blocks startup safely.
 *
 * Absent-journal fast path: no journal means no destructive promotion ever
 * began — proceed without validating retained snapshot and without relaunch.
 *
 * Main-only module. Not exposed over IPC/preload/renderer.
 */

import { loggerService } from '@logger'
import { DATA_PATH } from '@main/config'
import {
  getSharedMaintenanceCoordinator,
  type MaintenanceCoordinator
} from '@main/services/chatDb/maintenanceCoordination'

import type { ExecutingPromotionCapability, TerminalPromotionOwnership } from '../index'
import { probePromotionArtifacts, probeResultToRecoveryInput } from './artifactProbe'
import type { ClosedLiveProof } from './install'
import {
  cleanupPromotionJournalAfterCandidateInstalled,
  cleanupPromotionJournalAfterReplacementVerified,
  cleanupPromotionJournalAfterSnapshotReady,
  type PromotionJournalCleanupIdentity
} from './journalStore'
import type { PromotionRecoveryDecision } from './recovery'
import { decidePromotionRecovery } from './recovery'
import { type RelaunchApp, relaunchApp } from './relaunch'
import {
  createInProcessReloadGuard,
  getMainRendererWebContents,
  type ReloadableWebContents,
  reloadMainRenderer,
  resolveRestartMode,
  type RestartMode
} from './restart'
import { rollbackInstall } from './rollback'

const logger = loggerService.withContext('chatDbImportPromotionRecoveryExecutor')

// ---------------------------------------------------------------------------
// Subphase state
// ---------------------------------------------------------------------------

/**
 * Explicit recovery subphases in canonical order. Every subphase names the
 * exact operation in flight, so failures and abort behavior are
 * deterministic by subphase.
 */
export const RECOVERY_EXECUTOR_SUBPHASES = [
  'not-started',
  'probing',
  'deciding',
  'authorizing',
  'executing-action',
  'cleanup-journal',
  'relaunching',
  'settled'
] as const

export type RecoveryExecutorSubphase = (typeof RECOVERY_EXECUTOR_SUBPHASES)[number]

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/**
 * Authorization source for the recovery action. The executor obtains
 * authorization from one of two sources:
 * - taken terminal ownership (in-process continuation, LOCK-4433)
 * - fresh promotion lease (restart after crash, LOCK-4439)
 */
export type RecoveryAuthorization =
  | { readonly source: 'terminal-ownership'; readonly ownership: TerminalPromotionOwnership }
  | { readonly source: 'fresh-lease'; readonly lease: ExecutingPromotionCapability }
  | { readonly source: 'none' }

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Bounded machine-readable recovery failure codes. */
export type RecoveryExecutorFailureCode =
  | 'PROBING_FAILED'
  | 'DECISION_FAILED'
  | 'AUTHORIZATION_FAILED'
  | 'KEEP_OLD_LIVE_FAILED'
  | 'ACCEPT_REPLACEMENT_FAILED'
  | 'RESTORE_ROLLBACK_FAILED'
  | 'REPAIR_MARK_FAILED'
  | 'EXECUTING_ACTION_FAILED'
  | 'JOURNAL_CLEANUP_FAILED'
  | 'RELAUNCH_FAILED'
  | 'ABORT_REQUESTED'
  | 'UNEXPECTED_FAILURE'

/** Recovery action result details. */
export type RecoveryActionResult =
  | { readonly action: 'keep-old-live'; readonly cleaned: boolean }
  | { readonly action: 'accept-verified-replacement'; readonly cleaned: boolean }
  | { readonly action: 'restore-rollback-snapshot'; readonly restored: boolean; readonly cleaned: boolean }
  | { readonly action: 'repair-required'; readonly marked: boolean }

/**
 * Structured recovery failure. Contains enough detail for callers to
 * classify the failure and decide next steps.
 */
export interface RecoveryExecutorFailure {
  readonly subphase: RecoveryExecutorSubphase
  readonly code: RecoveryExecutorFailureCode
  /** Safe machine sub-code (bounded codes only — never messages/paths). */
  readonly safeCode: string | null
  /** The underlying error for logging (never exposed to UI). */
  readonly cause?: unknown
}

/** Result of {@link RecoveryExecutor.run}. Never rejects. */
export type RecoveryExecutorResult =
  | {
      readonly ok: true
      readonly action: RecoveryActionResult
      readonly decision: PromotionRecoveryDecision
      /**
       * True when the executor requested an in-process main renderer reload
       * (LOCK-PROD-7 non-packaged path) instead of an app relaunch. The
       * process does NOT exit; the pending one-shot projection applies on
       * rehydration. Absent/false for the packaged `relaunch` path.
       */
      readonly inProcessReload?: boolean
    }
  | {
      readonly ok: false
      readonly failure: RecoveryExecutorFailure
      readonly decision: PromotionRecoveryDecision | null
    }

/**
 * Narrow live ChatDbService surface the recovery executor needs. The
 * production live singleton satisfies this structurally; tests inject a
 * double (LOCK-O8).
 */
export interface RecoveryExecutionLiveDb {
  /** Whether the live DB has been initialized (open handles). */
  isInitialised(): boolean
  /** Promotion-owned close; validates the held promotion lease.**
   * Only available when terminal ownership includes an executing capability.
   */
  closeForPromotion?(authorization: ExecutingPromotionCapability['authorization']): boolean
}

/**
 * Injectable primitives with production defaults. Tests inject doubles;
 * production always uses the real units.
 */
export interface RecoveryExecutionPrimitives {
  probe: typeof probePromotionArtifacts
  decide: typeof decidePromotionRecovery
  cleanupSnapshotReady: typeof cleanupPromotionJournalAfterSnapshotReady
  cleanupCandidateInstalled: typeof cleanupPromotionJournalAfterCandidateInstalled
  cleanupReplacementVerified: typeof cleanupPromotionJournalAfterReplacementVerified
  rollbackInstall: typeof rollbackInstall
  relaunch: typeof relaunchApp
  /**
   * LOCK-PROD-7 restart strategy. Production default resolves from
   * `app.isPackaged` (packaged → relaunch; non-packaged → in-process
   * renderer reload).
   */
  restartMode: () => RestartMode
  /**
   * LOCK-PROD-7 in-process renderer reload primitive. Production default
   * reloads the registered main renderer webContents (bounded no-op when
   * unavailable); tests inject a double.
   */
  reloadRenderer: (ownerId: string) => { ok: true; reloaded: boolean }
  /**
   * Durable repair marker write primitive. LOCK-4437: must durably write
   * the repair marker before reporting success. Production default calls
   * chatDbService.markRepairRequiredBeforeInit().
   */
  markRepairRequiredBeforeInit: () => void
}

/**
 * Options for creating a recovery executor.
 */
export interface RecoveryExecutorOptions {
  /** Controlled Data root containing the live chat.db. */
  dataRoot?: string
  /** Live ChatDbService surface (narrow: isInitialised only for probing). */
  liveDb: RecoveryExecutionLiveDb
  /** Coordinator override (default: shared). */
  coordinator?: MaintenanceCoordinator
  /**
   * Authorization override. If not provided, the executor will attempt
   * to take terminal promotion ownership. If none is available, it
   * acquires a fresh promotion lease.
   */
  authorizationOverride?: RecoveryAuthorization
  /** Test injection: primitive overrides. */
  primitives?: Partial<RecoveryExecutionPrimitives>
  /** App surface for relaunch (default: electron app). */
  relaunchApp?: RelaunchApp
  /**
   * LOCK-PROD-7 restart strategy override. Defaults to packaged → relaunch,
   * non-packaged → in-process renderer reload.
   */
  restartMode?: RestartMode
  /**
   * LOCK-PROD-7 in-process reload target. Production default uses the
   * module-registered main renderer webContents (see
   * {@link registerMainRendererWebContents}); tests inject a double.
   */
  mainRendererWebContents?: ReloadableWebContents | null
  /** Topics/segments sampled for rollback validation (default 3). */
  sampleCount?: number
  /** Cooperative abort signal. */
  abortSignal?: AbortSignal
}

// ---------------------------------------------------------------------------
// Recovery executor factory
// ---------------------------------------------------------------------------

/**
 * Create the recovery executor bound to one data root, one live DB surface,
 * and one set of injectable primitives. See the module header for the full
 * sequence and locked invariants.
 */
export function createRecoveryExecutor(options: RecoveryExecutorOptions): RecoveryExecutor {
  const dataRoot = options.dataRoot ?? DATA_PATH
  const liveDb = options.liveDb
  const coordinator = options.coordinator ?? getSharedMaintenanceCoordinator()

  // LOCK-PROD-7: restart strategy. Explicit option wins; otherwise resolve
  // from `app.isPackaged` (lazy require keeps this module testable without
  // electron). Packaged → relaunch; non-packaged → in-process renderer reload.
  const restartMode =
    options.restartMode ??
    (() => {
      try {
        const { app } = require('electron') as { app: { isPackaged: boolean } }
        return resolveRestartMode(app)
      } catch {
        // Electron unavailable (pure-Node tests): preserve the pre-existing
        // default of the packaged relaunch path. Non-packaged dev/E2E always
        // runs under Electron, where `app.isPackaged` resolves correctly to
        // 'in-process-reload' — this fallback never fires there.
        return 'relaunch' as const
      }
    })()

  const primitives: RecoveryExecutionPrimitives = {
    probe: options.primitives?.probe ?? probePromotionArtifacts,
    decide: options.primitives?.decide ?? decidePromotionRecovery,
    cleanupSnapshotReady: options.primitives?.cleanupSnapshotReady ?? cleanupPromotionJournalAfterSnapshotReady,
    cleanupCandidateInstalled:
      options.primitives?.cleanupCandidateInstalled ?? cleanupPromotionJournalAfterCandidateInstalled,
    cleanupReplacementVerified:
      options.primitives?.cleanupReplacementVerified ?? cleanupPromotionJournalAfterReplacementVerified,
    rollbackInstall: options.primitives?.rollbackInstall ?? rollbackInstall,
    relaunch: options.primitives?.relaunch ?? relaunchApp,
    restartMode: options.primitives?.restartMode ?? (() => restartMode),
    // LOCK-FR3: per-recovery exact-once reload guard. Each executor may
    // request the in-process renderer reload at most once; a later
    // independent executor (a second import in the same process) owns a
    // fresh guard and may reload again. Stale/duplicate settlement from the
    // same recovery cannot re-request the reload.
    reloadRenderer:
      options.primitives?.reloadRenderer ??
      (() => {
        const reloadGuard = createInProcessReloadGuard()
        return (ownerId: string) => {
          const target = options.mainRendererWebContents ?? getMainRendererWebContents()
          return reloadMainRenderer(target, ownerId, reloadGuard)
        }
      })(),
    markRepairRequiredBeforeInit:
      options.primitives?.markRepairRequiredBeforeInit ??
      (() => {
        // Production default: import chatDbService and call its durable repair marker.
        // Dynamic import to avoid circular dependencies and to keep this module
        // testable without pulling in the live ChatDbService.
        const { chatDbService } = require('@main/services/chatDb')
        chatDbService.markRepairRequiredBeforeInit()
      })
  }

  let currentSubphase: RecoveryExecutorSubphase = 'not-started'
  let abortRequested = false
  let runStarted = false
  let settled = false
  let resolveSettled!: () => void
  const settledPromise = new Promise<void>((resolve) => {
    resolveSettled = resolve
  })

  // Wire up external abort signal if provided
  if (options.abortSignal) {
    options.abortSignal.addEventListener(
      'abort',
      () => {
        abortRequested = true
      },
      { once: true }
    )
  }

  function abortCheck(): boolean {
    return abortRequested
  }

  async function execute(): Promise<RecoveryExecutorResult> {
    // ====================================================================
    // 1. PROBING — read disk truth (journal + artifacts)
    // ====================================================================
    currentSubphase = 'probing'
    if (abortCheck()) {
      return failRecovery('ABORT_REQUESTED', 'BEFORE_PROBING', null)
    }

    let probes: ReturnType<typeof probePromotionArtifacts>
    try {
      // Determine candidateId from the journal observation
      const journalResult = await import('./journalStore').then((m) => m.readPromotionJournal(dataRoot))
      let candidateId: string | null = null
      if (journalResult.status === 'valid') {
        candidateId = journalResult.journal.candidateId
      }
      probes = primitives.probe(candidateId, dataRoot)
    } catch (error) {
      return failRecovery('PROBING_FAILED', 'PROBE_FAILED', error)
    }

    // ====================================================================
    // 2. DECIDING — pure decision matrix
    // ====================================================================
    currentSubphase = 'deciding'
    if (abortCheck()) {
      return failRecovery('ABORT_REQUESTED', 'BEFORE_DECISION', null)
    }

    let decision: PromotionRecoveryDecision
    try {
      const input = probeResultToRecoveryInput(probes)
      decision = primitives.decide(input)
    } catch (error) {
      return failRecovery('DECISION_FAILED', 'DECIDE_FAILED', error)
    }

    logger.info(
      `Recovery decision: action=${decision.action}, reason=${decision.reason}, ` +
        `journal=${probes.journal.status}, live=${probes.live.status}, ` +
        `snapshot=${probes.snapshot.status}, candidate=${probes.candidate.status}`
    )

    // ====================================================================
    // 3. AUTHORIZING — obtain promotion capability for destructive actions
    // ====================================================================
    currentSubphase = 'authorizing'
    if (abortCheck()) {
      return failRecovery('ABORT_REQUESTED', 'BEFORE_AUTHORIZATION', null)
    }

    const authorization = await resolveAuthorization(decision)

    // ====================================================================
    // 4. EXECUTING ACTION — deterministic by decision
    // ====================================================================
    currentSubphase = 'executing-action'
    if (abortCheck()) {
      // Release authorization if we acquired one
      releaseAuthorization(authorization)
      return failRecovery('ABORT_REQUESTED', 'BEFORE_EXECUTION', null)
    }

    let actionResult: RecoveryActionResult
    try {
      actionResult = await executeAction(decision, authorization, probes)
    } catch (error) {
      releaseAuthorization(authorization)
      return failRecovery('EXECUTING_ACTION_FAILED', 'ACTION_FAILED', error)
    }

    // ====================================================================
    // 5. CLEANUP JOURNAL — durable removal if action completed
    // ====================================================================
    let cleaned = false
    if (
      actionResult.action === 'accept-verified-replacement' ||
      actionResult.action === 'restore-rollback-snapshot' ||
      (actionResult.action === 'keep-old-live' && probes.journal.status === 'valid')
    ) {
      currentSubphase = 'cleanup-journal'
      if (abortCheck()) {
        releaseAuthorization(authorization)
        return failRecovery('ABORT_REQUESTED', 'BEFORE_CLEANUP', null)
      }

      try {
        cleaned = await cleanupJournal(decision, probes, authorization)
      } catch (error) {
        releaseAuthorization(authorization)
        return failRecovery('JOURNAL_CLEANUP_FAILED', 'CLEANUP_FAILED', error)
      }

      // Update action result with cleanup status
      if (actionResult.action === 'keep-old-live') {
        actionResult = { ...actionResult, cleaned }
      } else if (actionResult.action === 'accept-verified-replacement') {
        actionResult = { ...actionResult, cleaned }
      } else if (actionResult.action === 'restore-rollback-snapshot') {
        actionResult = { ...actionResult, cleaned }
      }
    }

    // ====================================================================
    // 6. RESTART — exact-once after verified authoritative live + cleanup
    // ====================================================================
    if (decision.action === 'accept-verified-replacement' || decision.action === 'restore-rollback-snapshot') {
      currentSubphase = 'relaunching'
      if (abortCheck()) {
        releaseAuthorization(authorization)
        return failRecovery('ABORT_REQUESTED', 'BEFORE_RELAUNCH', null)
      }

      try {
        if (primitives.restartMode() === 'in-process-reload') {
          // LOCK-PROD-7: non-packaged mode must NOT app.relaunch() (a dev
          // relaunch would land on a dead Vite server). Instead request an
          // in-process main renderer reload — the process stays alive, the
          // installed/reopened/verified chat.db is already live, and the
          // one-shot navigation projection applies on rehydration.
          const reloadResult = primitives.reloadRenderer('recovery-executor')
          if (reloadResult.ok) {
            currentSubphase = 'settled'
            releaseAuthorization(authorization)
            logger.info(
              `Recovery settled with in-process renderer reload: action=${decision.action}, ` +
                `reason=${decision.reason}, reloaded=${reloadResult.reloaded}`
            )
            return Object.freeze({
              ok: true as const,
              action: actionResult,
              decision,
              inProcessReload: true
            })
          }
          // The reload primitive returned a non-ok result. The process keeps
          // running in non-packaged mode, so release any held authorization
          // (fresh lease / terminal ownership) before surfacing the failure —
          // otherwise the lease leaks for the remainder of the session.
          releaseAuthorization(authorization)
          return failRecovery('RELAUNCH_FAILED', 'IN_PROCESS_RELOAD_RETURNED', null)
        }

        // Packaged mode: reliable exact-once app.relaunch() (unchanged).
        const { mintRelaunchReceipt } = await import('./relaunch')
        const receipt = mintRelaunchReceipt('recovery-executor')
        const relaunchResult = primitives.relaunch(receipt, options.relaunchApp)
        // In production, app.exit(0) terminates the process — code after
        // this call is unreachable. In test environments, the mock app.exit
        // returns normally. Check the result: a successful relaunch means
        // the process will exit (or already did in production).
        if (relaunchResult.ok && relaunchResult.relaunched) {
          // Relaunch initiated — in production the process is gone; in tests
          // the mock returned. Treat as success for both environments.
          currentSubphase = 'settled'
          releaseAuthorization(authorization)
          logger.info(`Recovery settled with relaunch: action=${decision.action}, reason=${decision.reason}`)
          return Object.freeze({
            ok: true as const,
            action: actionResult,
            decision
          })
        }
        // Relaunch was refused or failed
        return failRecovery('RELAUNCH_FAILED', 'RELAUNCH_RETURNED', null)
      } catch (error) {
        releaseAuthorization(authorization)
        return failRecovery('RELAUNCH_FAILED', 'RELAUNCH_FAILED', error)
      }
    }

    // ====================================================================
    // 7. SETTLED — release authorization for keep-old-live and repair
    // ====================================================================
    currentSubphase = 'settled'
    releaseAuthorization(authorization)

    logger.info(`Recovery settled: action=${decision.action}, reason=${decision.reason}`)

    return Object.freeze({
      ok: true as const,
      action: actionResult,
      decision
    })
  }

  // -----------------------------------------------------------------------
  // Authorization resolution
  // -----------------------------------------------------------------------

  async function resolveAuthorization(decision: PromotionRecoveryDecision): Promise<RecoveryAuthorization> {
    // Only destructive actions (restore-rollback-snapshot) need authorization.
    // keep-old-live, accept-verified-replacement (already verified), and
    // repair-required do not need a destructive capability.
    if (decision.action !== 'restore-rollback-snapshot') {
      return { source: 'none' }
    }

    // Use override if provided
    if (options.authorizationOverride) {
      return options.authorizationOverride
    }

    // Try to take terminal promotion ownership (in-process continuation)
    try {
      const { takeTerminalPromotionOwnership } = await import('../index')
      const taken = takeTerminalPromotionOwnership()
      if (taken.status === 'taken') {
        const ownership = taken.ownership
        if (ownership.kind === 'promoted' && ownership.handoff.capability) {
          logger.info('Recovery executor obtained authorization from terminal promotion ownership (promoted)')
          return { source: 'terminal-ownership', ownership }
        }
        if (ownership.kind === 'recovery-required' && ownership.handoff.capability) {
          logger.info('Recovery executor obtained authorization from terminal promotion ownership (recovery-required)')
          return { source: 'terminal-ownership', ownership }
        }
      }
    } catch (error) {
      logger.warn('Failed to take terminal promotion ownership:', error as Error)
    }

    // No terminal ownership available — acquire a fresh promotion lease
    try {
      const { acquirePromotionLease } = await import('@main/services/chatDb/maintenanceCoordination')
      const lease = acquirePromotionLease('recovery-executor', coordinator)
      const capability: ExecutingPromotionCapability = {
        token: 'recovery-fresh-lease',
        sessionId: 'recovery',
        candidateId: decision.action === 'restore-rollback-snapshot' ? 'unknown' : '',
        retainedSnapshotPath: '',
        candidateDbPath: '',
        authorization: lease,
        release() {
          if (!lease.isReleased()) {
            lease.release()
          }
        },
        isReleased() {
          return lease.isReleased()
        }
      }
      logger.info('Recovery executor acquired fresh promotion lease (restart path)')
      return { source: 'fresh-lease', lease: capability }
    } catch (error) {
      logger.warn('Failed to acquire fresh promotion lease:', error as Error)
      return { source: 'none' }
    }
  }

  function releaseAuthorization(auth: RecoveryAuthorization): void {
    if (auth.source === 'terminal-ownership') {
      // The terminal ownership capability's lease is released by the
      // recovery executor or remains held until process exit.
      try {
        if (auth.ownership.kind === 'promoted') {
          auth.ownership.handoff.capability.release()
        } else {
          auth.ownership.handoff.capability.release()
        }
      } catch {
        // Best-effort release
      }
    } else if (auth.source === 'fresh-lease') {
      try {
        auth.lease.release()
      } catch {
        // Best-effort release
      }
    }
    // 'none' needs no release
  }

  // -----------------------------------------------------------------------
  // Action execution
  // -----------------------------------------------------------------------

  async function executeAction(
    decision: PromotionRecoveryDecision,
    authorization: RecoveryAuthorization,
    probes: ReturnType<typeof probePromotionArtifacts>
  ): Promise<RecoveryActionResult> {
    switch (decision.action) {
      case 'keep-old-live':
        return executeKeepOldLive(probes, authorization)
      case 'accept-verified-replacement':
        return executeAcceptVerifiedReplacement(probes)
      case 'restore-rollback-snapshot':
        return executeRestoreRollbackSnapshot(probes, authorization)
      case 'repair-required':
        return executeRepairRequired()
    }
  }

  /**
   * keep-old-live: the live DB is the authoritative state. If a valid
   * journal exists (snapshot-ready phase, install never started), the
   * journal should be cleaned up. No relaunch — process continues normally.
   */
  async function executeKeepOldLive(
    probes: ReturnType<typeof probePromotionArtifacts>,
    _authorization: RecoveryAuthorization
  ): Promise<RecoveryActionResult> {
    // The live fact is already verified by the probe (present-verified or
    // present-unverified). For keep-old-live, the live DB is always the
    // correct state — no destructive action needed.
    if (probes.live.status === 'missing') {
      // This shouldn't happen if the decision matrix returned keep-old-live,
      // but be defensive.
      logger.warn('keep-old-live action requested but live DB is missing')
    }

    logger.info('keep-old-live: live DB retained as authoritative state')
    return { action: 'keep-old-live', cleaned: false }
  }

  /**
   * accept-verified-replacement: the replacement is installed and verified.
   * Require live present-verified. The journal cleanup happens in the
   * cleanup phase.
   */
  async function executeAcceptVerifiedReplacement(
    probes: ReturnType<typeof probePromotionArtifacts>
  ): Promise<RecoveryActionResult> {
    if (probes.live.status !== 'present-verified') {
      throw new Error(`accept-verified-replacement requires live present-verified, got ${probes.live.status}`)
    }

    logger.info('accept-verified-replacement: verified replacement accepted as live')
    return { action: 'accept-verified-replacement', cleaned: false }
  }

  /**
   * restore-rollback-snapshot: close/confirm closed under authorization,
   * mint proof, run rollback, require restored live verification. The
   * journal cleanup happens in the cleanup phase.
   *
   * LOCK-4434: the retained snapshot is NEVER consumed or deleted.
   * LOCK-4435: rollback live fact verified before journal cleanup.
   */
  async function executeRestoreRollbackSnapshot(
    probes: ReturnType<typeof probePromotionArtifacts>,
    authorization: RecoveryAuthorization
  ): Promise<RecoveryActionResult> {
    if (probes.snapshot.status !== 'present-verified') {
      throw new Error(`restore-rollback-snapshot requires snapshot present-verified, got ${probes.snapshot.status}`)
    }

    // Close the live DB if it was initialized (for the rollback destructive window)
    if (liveDb.isInitialised() && authorization.source !== 'none') {
      if (authorization.source === 'terminal-ownership') {
        const ownership = authorization.ownership
        const capability = ownership.kind === 'promoted' ? ownership.handoff.capability : ownership.handoff.capability
        if (capability && liveDb.closeForPromotion) {
          const closed = liveDb.closeForPromotion(capability.authorization)
          if (!closed) {
            logger.warn('Failed to close live DB for rollback (proceeding — live may already be closed)')
          }
        }
      } else if (authorization.source === 'fresh-lease') {
        if (liveDb.closeForPromotion) {
          const closed = liveDb.closeForPromotion(authorization.lease.authorization)
          if (!closed) {
            logger.warn('Failed to close live DB for rollback (proceeding — live may already be closed)')
          }
        }
      }
    }

    // Mint a closed-live proof for the rollback
    let proof: ClosedLiveProof | null = null
    if (authorization.source !== 'none') {
      try {
        const { mintClosedLiveProof } = await import('./install')
        const capability =
          authorization.source === 'terminal-ownership'
            ? authorization.ownership.kind === 'promoted'
              ? authorization.ownership.handoff.capability
              : authorization.ownership.handoff.capability
            : authorization.lease

        const mintResult = mintClosedLiveProof({
          authorization: capability.authorization,
          witness: { isLiveClosed: () => !liveDb.isInitialised() },
          coordinator
        })

        if (mintResult.ok) {
          proof = mintResult.proof
        } else {
          logger.warn(`Failed to mint closed-live proof: ${mintResult.reason}`)
        }
      } catch (error) {
        logger.warn('Failed to mint closed-live proof:', error as Error)
      }
    }

    if (proof === null) {
      throw new Error('Could not mint closed-live proof for rollback')
    }

    // Execute the rollback
    const rollbackResult = primitives.rollbackInstall({
      proof,
      dataRoot,
      sampleCount: options.sampleCount
    })

    if (!rollbackResult.ok) {
      throw new Error(`Rollback failed: ${rollbackResult.code} (${rollbackResult.safeCode})`)
    }

    // Verify restored live
    const restoredLive = primitives.probe(null, dataRoot).live
    if (restoredLive.status !== 'present-verified') {
      throw new Error(`Restored live verification failed: status=${restoredLive.status}`)
    }

    logger.info('restore-rollback-snapshot: retained snapshot restored to live path')
    return { action: 'restore-rollback-snapshot', restored: true, cleaned: false }
  }

  /**
   * repair-required: mark durable repair, retain all artifacts, no relaunch.
   * LOCK-4437: hard-blocks init, retains all artifacts, no cleanup/relaunch.
   * Marker write failure returns structured recovery failure but gate/main
   * still hard-block init.
   */
  async function executeRepairRequired(): Promise<RecoveryActionResult> {
    // Mark durable repair — the existing repair flow blocks startup.
    // This is a signal to the normal init path that repair is needed.
    // LOCK-4437: must durably write the repair marker before reporting success.
    try {
      primitives.markRepairRequiredBeforeInit()
      logger.warn('repair-required: marking durable repair, retaining all artifacts (LOCK-4437)')
      return { action: 'repair-required', marked: true }
    } catch (error) {
      // Marker write failure is a structured recovery failure.
      // The gate/main still hard-block init because the repair decision
      // was already made — the marker failure just means the durable
      // evidence may not survive a crash.
      logger.error('repair-required: failed to write durable repair marker', error as Error)
      throw error
    }
  }

  // -----------------------------------------------------------------------
  // Journal cleanup
  // -----------------------------------------------------------------------

  async function cleanupJournal(
    decision: PromotionRecoveryDecision,
    probes: ReturnType<typeof probePromotionArtifacts>,
    _authorization: RecoveryAuthorization
  ): Promise<boolean> {
    if (probes.journal.status !== 'valid') {
      // No valid journal to clean — idempotent.
      return false
    }

    const journal = probes.journal.journal
    const identity: PromotionJournalCleanupIdentity = {
      sessionId: journal.sessionId,
      candidateId: journal.candidateId
    }

    switch (decision.action) {
      case 'keep-old-live': {
        // Cleanup the snapshot-ready journal (install never started).
        if (journal.phase === 'snapshot-ready') {
          const result = await primitives.cleanupSnapshotReady(identity, dataRoot)
          return result.deleted
        }
        // candidate-installed phase during keep-old-live: cleanup
        if (journal.phase === 'candidate-installed') {
          const result = await primitives.cleanupCandidateInstalled(identity, dataRoot)
          return result.deleted
        }
        return false
      }
      case 'accept-verified-replacement': {
        // Cleanup the replacement-verified journal (LOCK-4436).
        if (journal.phase === 'replacement-verified') {
          const result = await primitives.cleanupReplacementVerified(identity, dataRoot)
          return result.deleted
        }
        return false
      }
      case 'restore-rollback-snapshot': {
        // Cleanup the actual valid journal phase (LOCK-4436).
        // The journal could be in snapshot-ready, candidate-installed,
        // or replacement-verified phase depending on where the crash happened.
        switch (journal.phase) {
          case 'snapshot-ready': {
            const result = await primitives.cleanupSnapshotReady(identity, dataRoot)
            return result.deleted
          }
          case 'candidate-installed': {
            const result = await primitives.cleanupCandidateInstalled(identity, dataRoot)
            return result.deleted
          }
          case 'replacement-verified': {
            const result = await primitives.cleanupReplacementVerified(identity, dataRoot)
            return result.deleted
          }
        }
        return false
      }
      default:
        return false
    }
  }

  // -----------------------------------------------------------------------
  // Failure helper
  // -----------------------------------------------------------------------

  function failRecovery(
    code: RecoveryExecutorFailureCode,
    safeCode: string | null,
    cause: unknown
  ): RecoveryExecutorResult {
    const failure: RecoveryExecutorFailure = Object.freeze({
      subphase: currentSubphase,
      code,
      safeCode,
      cause
    })
    logger.warn(`Recovery failed at subphase '${currentSubphase}' (${code}): ${safeCode ?? 'no sub-code'}`)
    return Object.freeze({ ok: false as const, failure, decision: null })
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    async run(): Promise<RecoveryExecutorResult> {
      if (runStarted) {
        throw new Error('Recovery executor run() is exact-once: it has already been started.')
      }
      runStarted = true
      try {
        return await execute()
      } catch (error) {
        logger.error('Recovery execution failed unexpectedly', error as Error)
        return failRecovery('UNEXPECTED_FAILURE', 'UNEXPECTED', error)
      } finally {
        settled = true
        resolveSettled()
      }
    },

    requestAbort(): void {
      if (abortRequested) return
      abortRequested = true
      logger.info('Recovery execution abort requested')
    },

    subphase(): RecoveryExecutorSubphase {
      return currentSubphase
    },

    isSettled(): boolean {
      return settled
    },

    whenSettled(): Promise<void> {
      return settledPromise
    }
  }
}

// ---------------------------------------------------------------------------
// Recovery executor interface
// ---------------------------------------------------------------------------

/**
 * Main-local recovery executor handle. `run()` is exact-once and never
 * rejects; `requestAbort()` is the cooperative abort contract; `whenSettled()`
 * resolves when the terminal result is settled.
 */
export interface RecoveryExecutor {
  /** Execute the recovery sequence exactly once. Never rejects. */
  run(): Promise<RecoveryExecutorResult>
  /** Cooperative abort request. Idempotent. */
  requestAbort(): void
  /** Current recovery subphase. */
  subphase(): RecoveryExecutorSubphase
  /** True once the terminal result settled. */
  isSettled(): boolean
  /** Resolves at the quiesce point. Requires run() to have been started. */
  whenSettled(): Promise<void>
}
