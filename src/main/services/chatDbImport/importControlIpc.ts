/**
 * L2 Cherry Studio ZIP import control IPC — command-oriented bridge from
 * the main renderer to the Phase 4 import service.
 *
 * Provides 4 invoke channels (get-platform-support, start, cancel,
 * get-status) and 1 event channel (status-changed) for the renderer to
 * drive the existing startImport() pipeline and observe state transitions.
 *
 * Design constraints (LOCK-6001..6007):
 * - Semantically and technically distinct from L3 Backup_* channels.
 * - Calls startImport() directly — no bypass, no duplicate pipeline.
 * - macOS-first platform gate: unsupported platforms get a clear
 *   unavailable state.
 * - Status events carry NO filesystem paths, NO SQL, NO manifests.
 * - Does not modify BackupManager, BackupService, or L3 archive files.
 * - Uses existing loggerService with context 'chatDbImportControl'.
 */

import { loggerService } from '@logger'
import { DATA_PATH } from '@main/config'
import { chatDbService } from '@main/services/chatDb'
import type {
  CherryImportAckProjectionResult,
  CherryImportCancelResult,
  CherryImportGetProjectionResult,
  CherryImportPlatformSupport,
  CherryImportStartResult,
  CherryImportStatusEvent,
  CherryImportUIState
} from '@shared/chatImport/types'
import type { CandidateReadyResult } from '@shared/chatImport/types'
import { IpcChannel } from '@shared/IpcChannel'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { ipcMain } from 'electron'

import {
  ChatImportCancelledError,
  ChatImportSessionError,
  ChatImportUnsupportedPlatformError,
  ChatImportZipError
} from './errors'
import type { PromotionExecutionFailure, PromotionPreparationStartOutcome } from './index'
import {
  cancelImport,
  getActiveImport,
  type ImportState,
  startImport,
  startPromotionExecution,
  startPromotionPreparation,
  takeTerminalPromotionOwnership,
  takeTerminalPromotionOwnershipIfMatches,
  type VerificationCompletedResult
} from './index'
import { decodeProjectionState, NAVIGATION_PROJECTION_STATE_KEY } from './navigationProjection'
import { registerMainRendererWebContents } from './promotion/restart'

const logger = loggerService.withContext('chatDbImportControl')

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/**
 * Controller generation counter (LOCK-6015). Incremented every time a new
 * session starts (startStatePoller call). Poller callbacks, emitStatus, and
 * triggerPromotion continuations capture the generation at creation and check
 * it before any state mutation — stale work is a no-op against newer sessions.
 */
let controllerGeneration = 0

/** Active import session ID, if any. */
let activeSessionId: string | null = null

/** Last emitted state, to deduplicate identical events. */
let lastEmittedState: CherryImportUIState | null = null

/** The main renderer webContents reference, set during registration. */
let mainWebContents: WebContents | null = null

/** Interval handle for state polling (fallback for intermediate states). */
let statePoller: ReturnType<typeof setInterval> | null = null

/**
 * Terminal UI states that must ONLY be emitted by the control layer
 * (triggerPromotion), never by the poller (LOCK-6016). The poller emits
 * intermediate states; terminal outcomes are the control layer's authority.
 */
const TERMINAL_CONTROL_STATES: readonly CherryImportUIState[] = ['promoted', 'promotion-failed']

// ---------------------------------------------------------------------------
// State mapping
// ---------------------------------------------------------------------------

/**
 * Map a Phase 4 ImportState to a renderer-safe CherryImportUIState.
 * No-op states are identity-mapped; the Phase 4 state names are already
 * renderer-friendly.
 */
function mapState(state: ImportState): CherryImportUIState {
  return state as CherryImportUIState
}

// ---------------------------------------------------------------------------
// Error sanitization — bounded IPC-safe categories (LOCK-6005)
// ---------------------------------------------------------------------------

/** Bounded error categories that cross IPC. Never raw error.message. */
type IpcErrorCategory =
  | 'invalid-input'
  | 'session-busy'
  | 'platform-unsupported'
  | 'import-failed'
  | 'cancel-failed'
  | 'verification-failed'
  | 'promotion-failed'
  | 'promotion-preparation-failed'
  | 'unknown'

function sanitizeIpcError(error: unknown, fallback: IpcErrorCategory = 'unknown'): string {
  if (error instanceof ChatImportZipError) {
    return `ZIP validation failed (${error.code})`
  }
  if (error instanceof ChatImportSessionError) {
    return 'An import is already in progress'
  }
  if (error instanceof ChatImportUnsupportedPlatformError) {
    return 'Platform not supported'
  }
  if (error instanceof ChatImportCancelledError) {
    return 'Import cancelled'
  }
  switch (fallback) {
    case 'import-failed':
      return 'Import failed'
    case 'cancel-failed':
      return 'Cancel operation failed'
    case 'verification-failed':
      return 'Verification did not pass'
    case 'promotion-failed':
      return 'Promotion failed'
    case 'promotion-preparation-failed':
      return 'Promotion preparation failed'
    default:
      return 'An unexpected error occurred'
  }
}

function sanitizePreparationFailure(outcome: PromotionPreparationStartOutcome): string {
  if (outcome.status === 'preparation-failed') {
    return `Promotion preparation failed (${outcome.failure.phase}: ${outcome.failure.code})`
  }
  if (outcome.status === 'not-claimable') {
    return 'No verified candidate available for promotion'
  }
  if (outcome.status === 'stale-claim') {
    return 'Promotion claim was superseded'
  }
  return 'Promotion could not proceed'
}

function sanitizeExecutionFailure(failure: PromotionExecutionFailure): string {
  return `Promotion failed at ${failure.subphase} (${failure.code})`
}

// ---------------------------------------------------------------------------
// Event emission
// ---------------------------------------------------------------------------

function emitStatus(event: CherryImportStatusEvent, generation?: number): void {
  // LOCK-6015: Stale generation check — if a generation is provided and
  // doesn't match the current controller generation, this is a no-op.
  if (generation !== undefined && generation !== controllerGeneration) {
    return
  }
  if (!mainWebContents || mainWebContents.isDestroyed()) {
    return
  }
  if (event.state === lastEmittedState && !event.error && !event.stats) {
    return // deduplicate identical intermediate states
  }
  lastEmittedState = event.state
  mainWebContents.send(IpcChannel.CherryImport_StatusChanged, event)
}

function emitIdle(sessionId?: string): void {
  emitStatus({
    sessionId: sessionId ?? activeSessionId ?? '',
    state: 'idle'
  })
}

// ---------------------------------------------------------------------------
// State poller
// ---------------------------------------------------------------------------

function startStatePoller(sessionId: string): void {
  stopStatePoller()
  // LOCK-6015: Capture generation — stale pollers see a mismatch and no-op.
  const myGeneration = ++controllerGeneration
  statePoller = setInterval(() => {
    // LOCK-6015: Stale poller guard. If the generation has advanced (new
    // session started), this callback is a no-op. Do NOT stopStatePoller()
    // here — a newer poller owns the interval.
    if (myGeneration !== controllerGeneration) {
      return
    }
    const session = getActiveImport()
    if (!session || session.id !== sessionId) {
      // LOCK-6015: Session gone — if we still own this session's control
      // state, the underlying fail/cancel/dispose path did not notify us
      // through a callback. Emit a terminal error if the last emitted state
      // was not already terminal, then clear ownership so a later import
      // can start.
      if (activeSessionId === sessionId) {
        const terminalStates: readonly CherryImportUIState[] = [
          'error',
          'cancelled',
          'verification-failed',
          'promotion-failed',
          'promoted'
        ]
        if (!lastEmittedState || !terminalStates.includes(lastEmittedState)) {
          emitStatus({ sessionId, state: 'error', error: 'Import failed' }, myGeneration)
        }
        activeSessionId = null
        lastEmittedState = null
      }
      stopStatePoller()
      return
    }
    const mapped = mapState(session.state)
    // LOCK-6016: Poller must NOT emit control-layer terminal states.
    // 'promoted' and 'promotion-failed' are emitted exclusively by
    // triggerPromotion after verifying the exact recovery outcome.
    // The underlying Phase 4 session may set 'promoted' via
    // completePromotion before recovery runs — the poller must suppress it.
    if (TERMINAL_CONTROL_STATES.includes(mapped)) {
      return
    }
    if (mapped !== lastEmittedState) {
      emitStatus({ sessionId, state: mapped }, myGeneration)
    }
  }, 500)
}

function stopStatePoller(): void {
  if (statePoller) {
    clearInterval(statePoller)
    statePoller = null
  }
}

// ---------------------------------------------------------------------------
// Projection handler authorization (LOCK-FA1/FA2/FA3)
// ---------------------------------------------------------------------------

/**
 * LOCK-FA1: Authorization gate for the one-shot navigation projection
 * handlers (GetProjection/AckProjection).
 *
 * Only the currently registered main renderer's MAIN FRAME may read or
 * durably acknowledge the pending projection. Any other sender — an
 * unrelated window sharing the broad preload, a subframe of the main
 * window, or a missing/destroyed/unregistered target — is rejected
 * WITHOUT touching the database (LOCK-FA2).
 *
 * LOCK-FA3: No new capability subsystem — this reuses the single-owner
 * `mainWebContents` registration. The destroyed-target case is handled
 * before `mainWebContents.mainFrame` is dereferenced (a destroyed
 * webContents has no live main frame).
 */
function isAuthorizedProjectionSender(event: IpcMainInvokeEvent): boolean {
  return (
    mainWebContents !== null &&
    !mainWebContents.isDestroyed() &&
    event.sender === mainWebContents &&
    event.senderFrame === mainWebContents.mainFrame
  )
}

// ---------------------------------------------------------------------------
// IPC handler registration
// ---------------------------------------------------------------------------

/**
 * Register L2 import control IPC handlers. Called once at app-ready from
 * registerIpc().
 *
 * @param webContents The main window's webContents for status events.
 */
export function registerCherryImportControlIpc(webContents: WebContents): void {
  mainWebContents = webContents
  // LOCK-PROD-7: register the main renderer webContents so the recovery
  // executor can request an in-process renderer reload (non-packaged
  // restart path) once the installed/verified SQLite is live.
  registerMainRendererWebContents(webContents)

  // --- get-platform-support ---
  ipcMain.handle(IpcChannel.CherryImport_GetPlatformSupport, (): CherryImportPlatformSupport => {
    return {
      supported: process.platform === 'darwin',
      platform: process.platform
    }
  })

  // --- start ---
  ipcMain.handle(IpcChannel.CherryImport_Start, async (_event, zipPath: unknown): Promise<CherryImportStartResult> => {
    if (typeof zipPath !== 'string' || zipPath.length === 0) {
      return { ok: false, error: 'Invalid zip path: expected a non-empty string' }
    }

    if (activeSessionId) {
      return {
        ok: false,
        error: 'An import is already in progress. Cancel or complete it before starting a new one.'
      }
    }

    logger.info(`L2 import start request for session (path redacted)`)

    try {
      const session = await startImport(zipPath, {
        onCandidateReady: (result: CandidateReadyResult) => {
          // LOCK-6015: Guard — ignore stale callback from a superseded session.
          if (activeSessionId !== result.sessionId) {
            logger.info(`L2 stale candidate-ready callback for session ${result.sessionId} ignored`)
            return
          }
          logger.info(`L2 candidate-ready for session ${result.sessionId}`)
          emitStatus({
            sessionId: result.sessionId,
            state: 'candidate-ready',
            stats: result.stats
          })
        },
        onVerificationComplete: (result: VerificationCompletedResult) => {
          // LOCK-6015: Guard — ignore stale callback from a superseded session.
          if (activeSessionId !== result.sessionId) {
            logger.info(`L2 stale verification-complete callback for session ${result.sessionId} ignored`)
            return
          }
          if (result.report.status === 'pass') {
            logger.info(`L2 verification-complete for session ${result.sessionId}: pass`)
            emitStatus({
              sessionId: result.sessionId,
              state: 'verified-candidate'
            })
            // Trigger promotion automatically after verification pass
            // (LOCK-6002: replace-all semantics, no user merge choice)
            void triggerPromotion(result.sessionId)
          } else {
            logger.info(`L2 verification-complete for session ${result.sessionId}: ${result.report.status}`)
            emitStatus({
              sessionId: result.sessionId,
              state: 'verification-failed',
              error: sanitizeIpcError(null, 'verification-failed')
            })
            // Clean up after verification failure — ownership released
            stopStatePoller()
            activeSessionId = null
            lastEmittedState = null
          }
        }
      })

      activeSessionId = session.id
      lastEmittedState = null

      // Emit the initial intake state
      emitStatus({ sessionId: session.id, state: mapState(session.state) })

      // Start polling for intermediate state transitions
      startStatePoller(session.id)

      return { ok: true, sessionId: session.id }
    } catch (error) {
      const message = sanitizeIpcError(error, 'import-failed')
      logger.error(`L2 import start failed: ${message}`)
      activeSessionId = null
      lastEmittedState = null
      stopStatePoller()
      emitIdle()
      return { ok: false, error: message }
    }
  })

  // --- cancel ---
  ipcMain.handle(
    IpcChannel.CherryImport_Cancel,
    async (_event, sessionId: unknown): Promise<CherryImportCancelResult> => {
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return { ok: false, error: 'Invalid sessionId' }
      }

      if (!activeSessionId || activeSessionId !== sessionId) {
        return { ok: false, error: 'No active import session matches the provided sessionId' }
      }

      logger.info(`L2 import cancel request for session ${sessionId}`)

      try {
        await cancelImport(sessionId)

        // LOCK-6002: Determine actual session state after cancel.
        // During promoting, session.cancel() returns without side effects
        // (decidePromotionCancel returns 'reject-promoting'). We must
        // inspect the resulting state to distinguish a real cancelled from
        // a rejected promoting cancel — never treat a resolving cancelImport
        // as success when the session is still promoting.
        const sessionAfterCancel = getActiveImport()
        if (sessionAfterCancel && sessionAfterCancel.id === sessionId) {
          // Session still active — cancel was rejected (promoting state).
          // Ownership and status event must NOT be cleared (LOCK-6002).
          logger.warn(`L2 cancel rejected for session ${sessionId}: promotion in progress, ownership retained`)
          return { ok: false, error: 'Cancel rejected: promotion in progress' }
        }

        // Session is null or state left to cancelled — true cancellation acknowledged.
        activeSessionId = null
        lastEmittedState = null
        stopStatePoller()
        emitStatus({ sessionId, state: 'cancelled' })
        return { ok: true }
      } catch (error) {
        const message = sanitizeIpcError(error, 'cancel-failed')
        logger.error(`L2 import cancel failed: ${message}`)
        return { ok: false, error: message }
      }
    }
  )

  // --- get-status ---
  ipcMain.handle(IpcChannel.CherryImport_GetStatus, (_event, sessionId: unknown): CherryImportStatusEvent | null => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return null
    }

    const session = getActiveImport()
    if (!session || session.id !== sessionId) {
      return null
    }

    // LOCK-6015/6016: Return the control-layer authoritative state, NOT
    // the raw underlying session state. During recovery the underlying
    // session may already be 'promoted' (set by completePromotion in
    // startPromotionExecution) while the control layer has not yet emitted
    // the terminal state — the poller suppresses TERMINAL_CONTROL_STATES
    // for exactly this reason. lastEmittedState tracks the last state
    // emitted by the control layer and is the authoritative UI source.
    return {
      sessionId: session.id,
      state: lastEmittedState ?? mapState(session.state)
    }
  })

  // --- get-projection (LOCK-PROD-6, LOCK-FA1/FA2) ---
  // Renderer reads the one-shot navigation projection from the LIVE DB
  // after Redux rehydration. Idempotent: absent/malformed rows are a
  // no-op result (crash-before-ack simply retries next startup).
  // LOCK-FA1: only the registered main renderer's main frame may read the
  // pending projection; any other sender is rejected with a structured,
  // path-redacted error BEFORE any DB access.
  ipcMain.handle(IpcChannel.CherryImport_GetProjection, (event): CherryImportGetProjectionResult => {
    if (!isAuthorizedProjectionSender(event)) {
      logger.warn('L2 projection read rejected: sender is not the registered main renderer main frame')
      return { ok: false, error: 'Unauthorized: navigation projection read denied' }
    }
    try {
      const sqlite = chatDbService.getSqlite()
      if (!sqlite) {
        return { ok: true, projection: null }
      }
      const raw = sqlite as {
        prepare(sql: string): { get(...params: unknown[]): { key?: string; value?: string | null } | undefined }
      }
      const row = raw.prepare('SELECT value FROM migration_state WHERE key = ?').get(NAVIGATION_PROJECTION_STATE_KEY)
      const projection = decodeProjectionState(row?.value ?? null)
      if (projection === null) {
        return { ok: true, projection: null }
      }
      logger.info(
        `L2 navigation projection pending for apply ` +
          `(assistants: ${projection.assistants.length}, topics: ${projection.topics.length}, ` +
          `recovered: ${projection.recoveredTopicIds.length})`
      )
      return { ok: true, projection }
    } catch (error) {
      logger.warn('L2 navigation projection read failed (no-op):', error as Error)
      return { ok: true, projection: null }
    }
  })

  // --- ack-projection (LOCK-PROD-6, LOCK-FA1/FA2) ---
  // Renderer durably acknowledges the applied projection. The row is
  // removed from the live DB so a crash-before-ack retries on next startup
  // and a completed apply is never re-applied. Failure is surfaced to the
  // renderer (the row stays pending and is retried).
  // LOCK-FA1: only the registered main renderer's main frame may
  // acknowledge. LOCK-FA2: an unauthorized ack MUST NOT execute SQL — the
  // DELETE below is never reached for a rejected sender.
  ipcMain.handle(IpcChannel.CherryImport_AckProjection, (event): CherryImportAckProjectionResult => {
    if (!isAuthorizedProjectionSender(event)) {
      logger.warn('L2 projection ack rejected: sender is not the registered main renderer main frame')
      return { ok: false, error: 'Unauthorized: navigation projection acknowledgment denied' }
    }
    try {
      const sqlite = chatDbService.getSqlite()
      if (!sqlite) {
        return { ok: false, error: 'Chat database is not available' }
      }
      const raw = sqlite as {
        prepare(sql: string): { run(...params: unknown[]): { changes: number } }
      }
      const result = raw.prepare('DELETE FROM migration_state WHERE key = ?').run(NAVIGATION_PROJECTION_STATE_KEY)
      if (result.changes !== 1) {
        logger.warn(`L2 projection ack: no pending row deleted (changes=${result.changes})`)
      }
      logger.info('L2 navigation projection acknowledged (one-shot cleared)')
      return { ok: true }
    } catch (error) {
      logger.warn('L2 navigation projection ack failed (row stays pending):', error as Error)
      return { ok: false, error: 'Projection acknowledgment failed' }
    }
  })

  logger.info('Registered 6 L2 Cherry Import control IPC handlers')
}

// ---------------------------------------------------------------------------
// Promotion trigger (LOCK-6002: replace-all, auto-promote after verify)
// ---------------------------------------------------------------------------

/**
 * Trigger promotion for a verified session. Called automatically after
 * verification passes. Wires the full Phase 4 pipeline:
 *   4.4.1 preparation (claim → snapshot → journal)
 *   4.4.2 execution (close → install → verify → journal)
 *   4.4.3 recovery (journal cleanup → relaunch)
 *
 * Ownership contract: activeSessionId/poller are retained through terminal
 * state — only cleared after the terminal outcome is emitted.
 *
 * LOCK-6003: Every non-exiting terminal outcome must settle/release
 * authorization and dispose import resources (except promotion-owned
 * artifacts) in the correct order.
 *
 * LOCK-6015: The entire continuation is generation-scoped. Stale
 * continuations (from a superseded session) are no-ops for L2 control
 * state but still safely settle their own Phase 4 capabilities.
 *
 * LOCK-6016: Only the verified successful final recovery outcome emits
 * UI 'promoted'. The underlying Phase 4 session state 'promoted' is
 * suppressed by the poller while recovery is pending.
 *
 * LOCK-6017: 'repair-required' and every recovery/relaunch failure are
 * bounded failure UI outcomes, never success.
 *
 * LOCK-6018: Non-exiting failure paths consume/release terminal ownership
 * exactly once via cleanupSessionOwnership().
 */
async function triggerPromotion(sessionId: string): Promise<void> {
  // LOCK-6015: Capture generation — stale continuations are no-ops.
  const myGeneration = controllerGeneration

  /** Check if this continuation still owns the active session. */
  const isCurrent = (): boolean => myGeneration === controllerGeneration && activeSessionId === sessionId

  logger.info(`L2 promotion trigger for session ${sessionId}`)

  // Emit promoting state (always — this is the control layer's first emission)
  emitStatus({ sessionId, state: 'promoting' }, myGeneration)

  try {
    // Phase 4.4.1: Preparation (claim + snapshot + journal)
    const prepOutcome = await startPromotionPreparation({
      dbDir: DATA_PATH,
      getLiveSqlite: () => chatDbService.getSqlite()
    })

    // LOCK-6015: After await, check generation before mutating L2 state.
    if (!isCurrent()) {
      // Stale continuation — Phase 4 preparation settled its own token
      // (promotion-failed via completePromotion for preparation-failed,
      // or stored the prepared handle for a session that was already
      // superseded). No L2 state mutation.
      return
    }

    if (prepOutcome.status !== 'prepared') {
      const errorMsg = sanitizePreparationFailure(prepOutcome)
      logger.warn(`L2 promotion preparation failed for session ${sessionId}: ${errorMsg}`)
      emitStatus({ sessionId, state: 'promotion-failed', error: errorMsg }, myGeneration)
      // LOCK-6003: preparation failure is a non-exiting terminal — settle
      // ownership (startPromotionPreparation already consumed the token via
      // completePromotion('promotion-failed') for preparation-failed status),
      // release authorization via cleanup, and dispose session resources.
      cleanupSessionOwnership()
      return
    }

    // Phase 4.4.2: Execution (close → install → verify → journal)
    const execOutcome = await startPromotionExecution({
      dataRoot: DATA_PATH,
      liveDb: chatDbService
    })

    // LOCK-6015: After await, check generation before mutating L2 state.
    if (!isCurrent()) {
      // Stale — the execution continuation handled its own terminal
      // ownership (release for pre-install, transfer for promoted/
      // recovery-required). For promoted outcomes, the originating
      // handoff's capability is still in terminalPromotionOwnership;
      // settle it so the lease is not leaked (LOCK-6018).
      if (execOutcome.status === 'promoted') {
        settleStaleRecoveryHandoff(
          { ok: true, action: { action: 'keep-old-live', cleaned: false }, decision: null },
          sessionId,
          execOutcome.handoff.token
        )
      } else if (execOutcome.status === 'promotion-failed' && execOutcome.recoveryHandoff) {
        // LOCK-6015/6018: Post-install recovery-required failed while
        // stale — the recovery handoff's capability is still in
        // terminalPromotionOwnership. Settle it by exact token so the
        // lease is not leaked. Do NOT touch session B's ownership.
        settleStaleRecoveryHandoff(
          {
            ok: false,
            failure: { subphase: 'post-install', code: 'POST_INSTALL_FAILURE', safeCode: null },
            decision: null
          },
          sessionId,
          execOutcome.recoveryHandoff.token
        )
      }
      return
    }

    switch (execOutcome.status) {
      case 'promoted': {
        // LOCK-6016: Do NOT emit 'promoted' yet — emit 'finalizing'
        // intermediate state. 'promoted' is emitted only after recovery
        // succeeds. LOCK-6017: recovery failure emits only failure
        // terminal semantics, never success then failure.
        logger.info(`L2 promotion promoted session ${sessionId} — entering finalization`)
        emitStatus({ sessionId, state: 'finalizing' }, myGeneration)

        // Phase 4.4.3: Run recovery executor for journal cleanup + restart.
        // The recovery executor takes terminal ownership, cleans up the
        // replacement-verified journal, and relaunches (packaged) or
        // requests an in-process renderer reload (non-packaged). If
        // recovery fails, startup recovery handles it deterministically.
        try {
          const { createRecoveryExecutor } = await import('./promotion/recoveryExecutor')
          const recoveryExecutor = createRecoveryExecutor({
            dataRoot: DATA_PATH,
            liveDb: chatDbService
          })
          const recoveryResult = await recoveryExecutor.run()

          // LOCK-6015/6018: After recovery await, check generation.
          if (!isCurrent()) {
            // Stale — the originating handoff was created by a promoted
            // execution for session A, but session B now owns the
            // controller. Recovery may or may not have taken terminal
            // ownership (only for restore-rollback-snapshot); in either
            // case we must settle the originating handoff's capability
            // for non-exiting outcomes so the lease is not leaked.
            settleStaleRecoveryHandoff(recoveryResult, sessionId, execOutcome.handoff.token)
            return
          }

          // LOCK-6016/6017: Inspect the EXACT recovery result action.
          // If recovery failed (relaunch refused or error), emit ONLY a
          // bounded failure — recovery failure must never appear as
          // promoted-success. If recovery succeeded with a valid action,
          // NOW emit 'promoted'. If recovery resolved to repair-required,
          // that is a bounded failure (LOCK-6017).
          if (!recoveryResult.ok) {
            const failureCode = recoveryResult.failure.code
            const subphase = recoveryResult.failure.subphase
            const errorMsg = `Recovery failed at ${subphase} (${failureCode})`
            logger.warn(`L2 recovery executor failed for session ${sessionId}: ${errorMsg}`)
            emitStatus({ sessionId, state: 'promotion-failed', error: errorMsg }, myGeneration)
            // LOCK-6018: consume/release terminal ownership on non-exiting
            // failure path before permitting another promotion.
            cleanupSessionOwnership()
          } else if (recoveryResult.action.action === 'repair-required') {
            // LOCK-6017: repair-required is a bounded failure outcome.
            // The durable repair marker was written but the app cannot
            // proceed — startup repair flow blocks init.
            logger.warn(
              `L2 recovery repair-required for session ${sessionId}: ` +
                'retaining all artifacts, startup repair flow blocks init'
            )
            emitStatus(
              {
                sessionId,
                state: 'promotion-failed',
                error: 'Recovery requires manual repair'
              },
              myGeneration
            )
            // LOCK-6018: consume/release terminal ownership on non-exiting
            // failure path.
            cleanupSessionOwnership()
          } else if (
            recoveryResult.action.action === 'accept-verified-replacement' ||
            recoveryResult.action.action === 'restore-rollback-snapshot'
          ) {
            // LOCK-6016: Recovery succeeded with a valid verified outcome.
            // Safe to emit 'promoted'.
            emitStatus({ sessionId, state: 'promoted' }, myGeneration)
            // LOCK-FR1/FR2: Packaged relaunch exits the process — ownership
            // is terminal there (unchanged). Non-packaged in-process reload
            // (LOCK-PROD-7) keeps the process alive: after the durable
            // journal cleanup and the accepted reload request, return import
            // control and maintenance ownership to a clean idle state so a
            // second independent import can succeed in the SAME process.
            // cleanupSessionOwnership() stops the old session poller, clears
            // active session/control ownership, disposes session resources,
            // and consumes/releases terminal promotion ownership exactly
            // once (idempotent — the executor already consumed it on the
            // restore-rollback-snapshot path).
            if (recoveryResult.inProcessReload === true) {
              cleanupSessionOwnership()
            }
          } else {
            // keep-old-live or unexpected action from promoted execution.
            // Shouldn't happen but handle defensively.
            logger.warn(`L2 unexpected recovery action for session ${sessionId}: ${recoveryResult.action.action}`)
            emitStatus(
              {
                sessionId,
                state: 'promotion-failed',
                error: 'Unexpected recovery outcome'
              },
              myGeneration
            )
            cleanupSessionOwnership()
          }
        } catch (error) {
          // LOCK-6015: Check generation before emitting.
          if (!isCurrent()) {
            // Stale — settle the originating handoff's terminal ownership
            // for non-exiting outcomes (LOCK-6018).
            settleStaleRecoveryHandoff(
              { ok: false, failure: { subphase: 'probing', code: 'PROBING_FAILED', safeCode: null }, decision: null },
              sessionId,
              execOutcome.handoff.token
            )
            return
          }
          // Recovery executor factory/import failure — non-fatal for the
          // promotion itself; startup recovery handles durable artifacts.
          const errorMsg = `Recovery executor unavailable: ${sanitizeIpcError(error)}`
          logger.warn(`L2 recovery executor failed for session ${sessionId}: ${errorMsg}`)
          emitStatus({ sessionId, state: 'promotion-failed', error: errorMsg }, myGeneration)
          // LOCK-6018: consume/release terminal ownership.
          cleanupSessionOwnership()
        }
        // Packaged relaunch exits the process — ownership stays terminal.
        // Non-packaged in-process reload already returned ownership to idle
        // via cleanupSessionOwnership() above (LOCK-FR2).
        break
      }

      case 'promotion-failed': {
        const errorMsg = sanitizeExecutionFailure(execOutcome.failure)
        logger.warn(`L2 promotion execution failed for session ${sessionId}: ${errorMsg}`)
        emitStatus({ sessionId, state: 'promotion-failed', error: errorMsg }, myGeneration)
        if (execOutcome.recoveryHandoff) {
          // LOCK-6018: Post-install recovery-required — route through the
          // recovery executor via the existing recoveryHandoff. Do NOT call
          // cleanupSessionOwnership() here: the recovery executor takes
          // terminal ownership via takeTerminalPromotionOwnership() and
          // manages the handoff lifecycle (capability ownership, cleanup,
          // relaunch). Releasing ownership here would break recovery
          // isolation — the executor needs the capability to authorize
          // destructive rollback actions.
          try {
            const { createRecoveryExecutor } = await import('./promotion/recoveryExecutor')
            const recoveryExecutor = createRecoveryExecutor({
              dataRoot: DATA_PATH,
              liveDb: chatDbService
            })
            const recoveryResult = await recoveryExecutor.run()

            // LOCK-6018: After recovery await, check generation. If stale,
            // settle the originating recovery handoff's capability so the
            // lease is not leaked.
            if (!isCurrent()) {
              settleStaleRecoveryHandoff(recoveryResult, sessionId, execOutcome.recoveryHandoff.token)
              return
            }

            if (!recoveryResult.ok) {
              const failureCode = recoveryResult.failure.code
              const subphase = recoveryResult.failure.subphase
              const recoveryErrorMsg = `Recovery failed at ${subphase} (${failureCode})`
              logger.warn(`L2 recovery executor failed for session ${sessionId}: ${recoveryErrorMsg}`)
              emitStatus({ sessionId, state: 'promotion-failed', error: recoveryErrorMsg }, myGeneration)
              cleanupSessionOwnership()
            } else if (recoveryResult.action.action === 'repair-required') {
              logger.warn(
                `L2 recovery repair-required for session ${sessionId}: ` +
                  'retaining all artifacts, startup repair flow blocks init'
              )
              emitStatus(
                {
                  sessionId,
                  state: 'promotion-failed',
                  error: 'Recovery requires manual repair'
                },
                myGeneration
              )
              cleanupSessionOwnership()
            } else if (
              recoveryResult.action.action === 'accept-verified-replacement' ||
              recoveryResult.action.action === 'restore-rollback-snapshot'
            ) {
              emitStatus({ sessionId, state: 'promoted' }, myGeneration)
              // LOCK-FR1/FR2: packaged relaunch exits the process (ownership
              // terminal); non-packaged in-process reload returns control and
              // maintenance ownership to a clean idle state so a second
              // independent import can succeed in the same process.
              if (recoveryResult.inProcessReload === true) {
                cleanupSessionOwnership()
              }
            } else {
              // keep-old-live or unexpected action
              logger.warn(`L2 unexpected recovery action for session ${sessionId}: ${recoveryResult.action.action}`)
              emitStatus(
                {
                  sessionId,
                  state: 'promotion-failed',
                  error: 'Unexpected recovery outcome'
                },
                myGeneration
              )
              cleanupSessionOwnership()
            }
          } catch (error) {
            // LOCK-6018: After recovery await, check generation. If stale,
            // settle the originating recovery handoff's capability.
            if (!isCurrent()) {
              settleStaleRecoveryHandoff(
                {
                  ok: false,
                  failure: { subphase: 'recovery-executor', code: 'RECOVERY_EXECUTOR_UNAVAILABLE', safeCode: null },
                  decision: null
                },
                sessionId,
                execOutcome.recoveryHandoff.token
              )
              return
            }
            const recoveryErrorMsg = `Recovery executor unavailable: ${sanitizeIpcError(error)}`
            logger.warn(`L2 recovery executor failed for session ${sessionId}: ${recoveryErrorMsg}`)
            emitStatus({ sessionId, state: 'promotion-failed', error: recoveryErrorMsg }, myGeneration)
            cleanupSessionOwnership()
          }
        } else {
          // LOCK-6003: pre-install failure — ownership was already released
          // by startPromotionExecution (releasePromotionOwnership after
          // quiesce). Dispose session resources.
          cleanupSessionOwnership()
        }
        break
      }

      case 'stale-settle': {
        logger.warn(`L2 promotion stale-settle for session ${sessionId}`)
        emitStatus(
          {
            sessionId,
            state: 'promotion-failed',
            error: 'Import promotion was superseded'
          },
          myGeneration
        )
        // LOCK-6003: stale-settle — executor succeeded but session was
        // superseded during await. Ownership released after quiesce by
        // startPromotionExecution. Dispose session resources.
        cleanupSessionOwnership()
        break
      }

      case 'already-started': {
        // Duplicate promotion attempt — should not happen (exact-once guard).
        logger.warn(`L2 promotion already-started for session ${sessionId}`)
        emitStatus(
          {
            sessionId,
            state: 'promotion-failed',
            error: 'Promotion was already started'
          },
          myGeneration
        )
        cleanupSessionOwnership()
        break
      }

      case 'not-executable': {
        logger.warn(`L2 promotion not-executable for session ${sessionId}`)
        emitStatus(
          {
            sessionId,
            state: 'promotion-failed',
            error: 'Promotion could not proceed'
          },
          myGeneration
        )
        cleanupSessionOwnership()
        break
      }
    }
  } catch (error) {
    // LOCK-6015: Check generation before emitting.
    if (!isCurrent()) return
    const errorMsg = sanitizeIpcError(error, 'promotion-failed')
    logger.error(`L2 promotion failed for session ${sessionId}: ${errorMsg}`)
    emitStatus({ sessionId, state: 'promotion-failed', error: errorMsg }, myGeneration)
    cleanupSessionOwnership()
  }
}

/**
 * Settle the originating handoff's terminal ownership when recovery becomes
 * stale (LOCK-6015/6018). Uses identity-checked take
 * ({@link takeTerminalPromotionOwnershipIfMatches}) with the originating
 * handoff's token to ensure a stale continuation never consumes a newer
 * session's ownership record.
 *
 * This does NOT mutate the current controller (session B) — it only
 * releases the originating handoff's capability that was created by
 * session A's promoted execution.
 *
 * LOCK-6018: Every stale non-exiting recovery outcome consumes/releases
 * exactly the originating handoff once.
 * LOCK-6015: Identity-checked take prevents stale A from consuming B's
 * terminal ownership record.
 */
function settleStaleRecoveryHandoff(
  recoveryResult: {
    ok: boolean
    action?: { action: string; cleaned?: boolean } | null
    decision?: { action: string; reason: string } | null
    failure?: { subphase: string; code: string; safeCode: string | null } | null
  },
  staleSessionId: string,
  originHandoffToken: string
): void {
  // Determine if the process will exit: accept-verified-replacement or
  // restore-rollback-snapshot recovery actions that succeeded indicate the
  // restart was initiated (packaged exits; non-packaged reloads
  // in-process). In the stale case, we still settle because the
  // originating handoff's capability must not leak.
  const willExit =
    recoveryResult.ok &&
    recoveryResult.action &&
    (recoveryResult.action.action === 'accept-verified-replacement' ||
      recoveryResult.action.action === 'restore-rollback-snapshot')

  // LOCK-6015: Identity-checked take — only consume if the stored record
  // belongs to the originating handoff. If a newer session (B) has set
  // a different terminal ownership record, this returns 'mismatch' and
  // leaves B's record untouched.
  const ownership = takeTerminalPromotionOwnershipIfMatches(originHandoffToken)
  if (ownership.status === 'taken') {
    try {
      ownership.ownership.handoff.capability.release()
      logger.info(
        `Stale recovery settlement: released originating handoff capability ` +
          `for stale session ${staleSessionId} (willExit=${willExit})`
      )
    } catch {
      // Best-effort release — capability may already be released by the
      // recovery executor's releaseAuthorization path.
    }
  }
  // If status is 'not-available', the recovery executor already consumed it
  // (took and released during its authorization phase) — no leak.
  // If status is 'mismatch', the record belongs to a newer session — no-op
  // (LOCK-6015).
}

/**
 * Clean up module-level session ownership after a terminal outcome.
 * Called after promotion-failed, stale-settle, etc., and after promoted
 * success in the NON-PACKAGED in-process reload path (LOCK-FR2). NOT
 * called after packaged promoted success — the process exits and
 * ownership is terminal there.
 *
 * LOCK-6003: For non-exiting terminal outcomes, this also disposes the
 * session's import resources (temp workspace, isolated session, verifier)
 * while preserving promotion-owned artifacts per protocol.
 *
 * LOCK-6018: Consumes any unclaimed terminal promotion ownership on
 * non-exiting failure paths and on non-packaged in-process success, so a
 * subsequent promotion can acquire a fresh lease. Uses the atomic
 * takeTerminalPromotionOwnership() API to avoid double-release.
 */
function cleanupSessionOwnership(): void {
  stopStatePoller()

  // LOCK-6018: Consume any unclaimed terminal ownership. On non-exiting
  // failure paths (recovery failure, repair-required, recovery executor
  // unavailable), the terminal ownership may still be set (the recovery
  // executor either didn't take it or took and released it — in either
  // case, takeTerminalPromotionOwnership returns 'not-available' when
  // already consumed). This is safe to call multiple times: exact-once
  // semantics via the atomic take.
  const ownership = takeTerminalPromotionOwnership()
  if (ownership.status === 'taken') {
    try {
      ownership.ownership.handoff.capability.release()
    } catch {
      // Best-effort release — capability may already be released by the
      // recovery executor's releaseAuthorization path.
    }
  }

  // LOCK-6003: Dispose the session's non-promotion resources (temp workspace,
  // isolated session, verifier) on non-exiting terminal outcomes. The session's
  // dispose() checks decideCandidateDisposal() and preserves promotion-owned
  // candidates (promoting/promoted/promotion-failed states). Safe to call even
  // if already disposed (idempotent guard).
  const session = getActiveImport()
  if (session && typeof session.dispose === 'function') {
    void session.dispose().catch((error) => {
      logger.warn(`Error disposing session during cleanup: ${sanitizeIpcError(error)}`)
    })
  }

  activeSessionId = null
  // NOTE: lastEmittedState is intentionally NOT cleared here. It serves as
  // the authoritative control-layer UI state for getStatus() (LOCK-6015/6016).
  // It is cleared when a new session starts (startHandler) or when the poller
  // detects session-gone (which also clears activeSessionId).
}

/**
 * Cleanup on app quit. Disposes the active session if any and releases
 * any unclaimed terminal ownership.
 */
export function disposeCherryImportControl(): void {
  stopStatePoller()

  // LOCK-PROD-7: clear the registered main renderer webContents so a stale
  // in-process reload can never target a destroyed window.
  registerMainRendererWebContents(null)

  // LOCK-6018: Release any remaining terminal ownership on app quit.
  const ownership = takeTerminalPromotionOwnership()
  if (ownership.status === 'taken') {
    try {
      ownership.ownership.handoff.capability.release()
    } catch {
      // Best-effort — process is exiting.
    }
  }

  activeSessionId = null
  lastEmittedState = null
  mainWebContents = null
}
