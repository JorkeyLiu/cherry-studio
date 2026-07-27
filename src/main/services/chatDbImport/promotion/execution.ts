/**
 * Destructive promotion executor (Phase 4.4.2, LOCK-4421..4428).
 *
 * The single Main-local orchestration unit that consumes an
 * ExecutingPromotionCapability (produced by the exact-once prepared-handle
 * consume, LOCK-4421) and drives the non-reorderable destructive sequence:
 *
 *   1. closing-live                 — authorized ChatDbService.closeForPromotion
 *   2. minting-proof                — closed-live proof minted IMMEDIATELY
 *                                     after the successful close with an
 *                                     honest witness bound to the actual
 *                                     ChatDbService lifecycle (LOCK-4427)
 *   3. installing                   — sidecar handling + atomic rename-only
 *                                     install (LOCK-4426) via installCandidate
 *   4. journal-candidate-installed  — durable journal advancement ONLY after
 *                                     install returned durable success
 *                                     (LOCK-4423)
 *   5. reopening-live               — authorized reopenForPromotion
 *   6. verifying-replacement        — identity-bound full verification of the
 *                                     installed replacement (LOCK-4424)
 *   7. journal-replacement-verified — durable journal advancement ONLY after
 *                                     verification succeeded (LOCK-4424)
 *   8. settled                      — Phase 4.4.3 handoff (LOCK-4428: STOP —
 *                                     no journal/snapshot cleanup, no
 *                                     relaunch, no rollback)
 *
 * Capability/lease invariants (LOCK-4422):
 * - The SAME promotion lease held since preparation authorizes the whole
 *   close→install→reopen→verify→journal window. The executor NEVER releases
 *   or reacquires it and NEVER introduces a second mutex.
 * - The capability authorization is re-validated at every irreversible
 *   boundary (before close, before install, before each journal advance,
 *   before reopen). A stale capability (released lease / superseded holder /
 *   forged handle) can never act.
 * - The executor NEVER releases the lease itself: terminal ownership is
 *   decided by the integration layer AFTER the executor quiesced —
 *   pre-install failures release; a successful handoff and a post-install
 *   recovery-required outcome keep owning the capability (same lease) so
 *   no competition window ever opens before Phase 4.4.3 or process exit.
 *
 * Failure taxonomy (LOCK-4425):
 * - `pre-install`: the live chat.db bytes were NOT replaced. Finalization
 *   restores availability by reopening the live DB with the same
 *   authorization when the executor had closed it (live bytes unchanged —
 *   this is NOT a rollback). recoveryRequired = false.
 * - `post-install`: the atomic rename ALREADY happened. Finalization stops
 *   all forward progress, retains EVERY artifact (installed live bytes,
 *   journal, retained snapshot, candidate remains), ensures the live handle
 *   is closed when safe using the same authorization, and reports
 *   recoveryRequired = true. It NEVER rolls back, restores the snapshot,
 *   cleans the journal, or relaunches (LOCK-4425/4428) — deterministic
 *   startup recovery (Phase 4.4.3) owns those decisions.
 *
 * Abort contract (dispose/will-quit integration): {@link
 * PromotionExecutor.requestAbort} is a cooperative request checked at every
 * subphase boundary BEFORE the next irreversible action. The executor owns
 * finalization: an abort before install finalizes like a pre-install
 * failure (live reopened, bytes unchanged); an abort after install
 * finalizes like a post-install failure (artifacts retained,
 * recovery-required). The lease is never released early.
 *
 * Main-only module. Not exposed over IPC/preload/renderer.
 */

import { loggerService } from '@logger'
import {
  getSharedMaintenanceCoordinator,
  type MaintenanceCoordinator,
  validatePromotionAuthorization
} from '@main/services/chatDb/maintenanceCoordination'

import type { InstallReceipt } from './install'
import { installCandidate, mintClosedLiveProof } from './install'
import type { PromotionJournalV1 } from './journal'
import { PROMOTION_JOURNAL_VERSION } from './journal'
import {
  advancePromotionJournalToCandidateInstalled,
  advancePromotionJournalToReplacementVerified,
  PromotionJournalStoreError
} from './journalStore'
import type { ExecutingPromotionCapability } from './preparation'
import { safeErrorCode } from './readonlyDbValidation'
import { verifyReplacement } from './replacementVerifier'

const logger = loggerService.withContext('chatDbImportPromotionExecution')

// ---------------------------------------------------------------------------
// Subphase state
// ---------------------------------------------------------------------------

/**
 * Explicit execution subphases in canonical order. `not-started` and
 * `settled` bracket the destructive window; every other subphase names the
 * exact operation in flight, so failures and fail/dispose/will-quit
 * behavior are deterministic by subphase.
 */
export const PROMOTION_EXECUTION_SUBPHASES = [
  'not-started',
  'closing-live',
  'minting-proof',
  'installing',
  'journal-candidate-installed',
  'reopening-live',
  'verifying-replacement',
  'journal-replacement-verified',
  'settled'
] as const

export type PromotionExecutionSubphase = (typeof PROMOTION_EXECUTION_SUBPHASES)[number]

// ---------------------------------------------------------------------------
// Result / failure taxonomy
// ---------------------------------------------------------------------------

/** Bounded machine-readable execution failure codes. */
export type PromotionExecutionFailureCode =
  | 'CAPABILITY_STALE'
  | 'ABORT_REQUESTED'
  | 'LIVE_CLOSE_FAILED'
  | 'PROOF_MINT_FAILED'
  | 'INSTALL_FAILED'
  | 'JOURNAL_CANDIDATE_INSTALLED_FAILED'
  | 'LIVE_REOPEN_FAILED'
  | 'REPLACEMENT_VERIFICATION_FAILED'
  | 'JOURNAL_REPLACEMENT_VERIFIED_FAILED'
  | 'UNEXPECTED_FAILURE'

/** Failure classification relative to the destructive rename (LOCK-4425). */
export type PromotionExecutionClassification = 'pre-install' | 'post-install'

/**
 * Live handle disposition after executor-owned finalization:
 * - `open`    — live DB reopened/left open (pre-install failures only; the
 *               live bytes were never replaced)
 * - `closed`  — live DB handles are closed (post-install failures, and
 *               pre-install failures whose authorized reopen was refused)
 * - `unknown` — the ensure-closed attempt itself failed; treat as unsafe
 */
export type PromotionExecutionLiveDisposition = 'open' | 'closed' | 'unknown'

/**
 * Structured execution failure. `recoveryRequired` is true exactly for the
 * post-install classification (LOCK-4425): the journal + retained snapshot
 * + installed bytes are preserved for deterministic startup recovery, and
 * nothing was rolled back.
 */
export interface PromotionExecutionFailure {
  /** The exact subphase that failed. */
  readonly subphase: PromotionExecutionSubphase
  readonly classification: PromotionExecutionClassification
  /** True iff post-install (LOCK-4425 recovery-required). */
  readonly recoveryRequired: boolean
  readonly code: PromotionExecutionFailureCode
  /** Safe machine sub-code (bounded codes only — never messages/paths). */
  readonly safeCode: string | null
  /** Live handle disposition after executor-owned finalization. */
  readonly liveDisposition: PromotionExecutionLiveDisposition
  /** The underlying error for logging (never exposed to UI). */
  readonly cause?: unknown
}

/**
 * Phase 4.4.3 handoff (LOCK-4428). Returned only after the durable
 * `replacement-verified` journal advancement. The handoff DELIBERATELY
 * still owns the executing capability (the same continuously held lease):
 * releasing it here would open a competition window between the settled
 * promotion and Phase 4.4.3 cleanup/relaunch. The integration layer
 * transfers session ownership to this handoff on settle (hardened 4.4.2
 * audit correction) — stale session cleanup can never release it; release
 * belongs to the future Phase 4.4.3 executor or process exit. NEVER cross
 * IPC with this.
 */
export interface PromotionExecutionHandoff {
  readonly sessionId: string
  readonly candidateId: string
  /** Exact-once claim token this execution settled against. */
  readonly token: string
  /** Branded install receipt binding the installed identity (LOCK-4423). */
  readonly receipt: InstallReceipt
  /** Retained rollback snapshot path (retained, never cleaned here). */
  readonly retainedSnapshotPath: string
  /** The still-owned executing capability (same lease, LOCK-4422). */
  readonly capability: ExecutingPromotionCapability
}

/** Result of {@link PromotionExecutor.run}. Never rejects. */
export type PromotionExecutionResult =
  | { readonly ok: true; readonly handoff: PromotionExecutionHandoff }
  | { readonly ok: false; readonly failure: PromotionExecutionFailure }

// ---------------------------------------------------------------------------
// Injection surfaces
// ---------------------------------------------------------------------------

/**
 * Narrow live ChatDbService surface the executor needs. The production
 * live singleton satisfies this structurally; tests inject a double
 * (LOCK-O8). The executor only ever uses the promotion-owned lifecycle
 * entries (LOCK-4422) — never public init()/close().
 */
export interface PromotionExecutionLiveDb {
  /** Promotion-owned close; validates the held promotion lease itself. */
  closeForPromotion(authorization: ExecutingPromotionCapability['authorization']): boolean
  /** Promotion-owned reopen; validates the held promotion lease itself. */
  reopenForPromotion(authorization: ExecutingPromotionCapability['authorization']): Promise<void>
  /** Honest lifecycle witness source (LOCK-4427). */
  isInitialised(): boolean
}

/**
 * Injectable primitives (LOCK-O8) with production defaults. Tests group
 * equivalent gates by injecting bounded failure results; production always
 * uses the real ownership/journal/install/verifier units.
 */
export interface PromotionExecutionPrimitives {
  validateAuthorization: typeof validatePromotionAuthorization
  mintProof: typeof mintClosedLiveProof
  install: typeof installCandidate
  advanceCandidateInstalled: typeof advancePromotionJournalToCandidateInstalled
  advanceReplacementVerified: typeof advancePromotionJournalToReplacementVerified
  verify: typeof verifyReplacement
}

export interface PromotionExecutorOptions {
  /** The exact-once executing capability (LOCK-4421/4422). */
  capability: ExecutingPromotionCapability
  /** Controlled Data root containing the live chat.db. */
  dataRoot: string
  /** Live ChatDbService surface (promotion-owned lifecycle only). */
  liveDb: PromotionExecutionLiveDb
  /** Coordinator the capability authorization must hold (default: shared). */
  coordinator?: MaintenanceCoordinator
  /** Test injection (LOCK-O8); production defaults are the real units. */
  primitives?: Partial<PromotionExecutionPrimitives>
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Main-local promotion executor handle. `run()` is exact-once and never
 * rejects; `requestAbort()` is the cooperative dispose/will-quit contract
 * (checked at every subphase boundary before the next irreversible
 * action); `whenSettled()` resolves when the terminal result is settled
 * and every executor-owned finalization step has completed (quiesce
 * point — ownership may be released only after this).
 */
export interface PromotionExecutor {
  /** Execute the destructive sequence exactly once. Never rejects. */
  run(): Promise<PromotionExecutionResult>
  /** Cooperative abort request (dispose/will-quit). Idempotent. */
  requestAbort(): void
  /** Current execution subphase (deterministic dispose behavior source). */
  subphase(): PromotionExecutionSubphase
  /** True once the terminal result settled (executor quiesced). */
  isSettled(): boolean
  /** Resolves at the quiesce point. Requires run() to have been started. */
  whenSettled(): Promise<void>
}

/** Bounded safe code for journal-store failures. */
function journalSafeCode(error: unknown): string {
  if (error instanceof PromotionJournalStoreError) return error.code
  return safeErrorCode(error)
}

/**
 * Create the destructive promotion executor bound to one capability, one
 * controlled Data root, and one live ChatDbService surface. See the module
 * header for the full sequence and locked invariants.
 */
export function createPromotionExecutor(options: PromotionExecutorOptions): PromotionExecutor {
  const coordinator = options.coordinator ?? getSharedMaintenanceCoordinator()
  const capability = options.capability
  const liveDb = options.liveDb
  const dataRoot = options.dataRoot

  const primitives: PromotionExecutionPrimitives = {
    validateAuthorization: options.primitives?.validateAuthorization ?? validatePromotionAuthorization,
    mintProof: options.primitives?.mintProof ?? mintClosedLiveProof,
    install: options.primitives?.install ?? installCandidate,
    advanceCandidateInstalled:
      options.primitives?.advanceCandidateInstalled ?? advancePromotionJournalToCandidateInstalled,
    advanceReplacementVerified:
      options.primitives?.advanceReplacementVerified ?? advancePromotionJournalToReplacementVerified,
    verify: options.primitives?.verify ?? verifyReplacement
  }

  let currentSubphase: PromotionExecutionSubphase = 'not-started'
  let abortRequested = false
  let runStarted = false
  let settled = false
  let resolveSettled!: () => void
  const settledPromise = new Promise<void>((resolve) => {
    resolveSettled = resolve
  })
  /** True once the atomic install rename happened (LOCK-4425 boundary). */
  let installed = false
  /** True once the authorized live close succeeded. */
  let liveClosed = false

  function journalDocument(phase: PromotionJournalV1['phase']): PromotionJournalV1 {
    return {
      version: PROMOTION_JOURNAL_VERSION,
      sessionId: capability.sessionId,
      candidateId: capability.candidateId,
      phase
    }
  }

  /**
   * Boundary gate (LOCK-4421/4422): the capability authorization must be
   * the CURRENTLY HELD promotion lease on the coordinator. Returns the
   * bounded refusal reason, or null when authorized.
   */
  function staleReason(): string | null {
    const verdict = primitives.validateAuthorization(capability.authorization, coordinator)
    return verdict.authorized ? null : verdict.reason
  }

  /**
   * Executor-owned failure finalization — deterministic by classification:
   * - pre-install: live bytes unchanged; reopen the live DB with the SAME
   *   authorization when this executor had closed it (availability
   *   restoration, NOT a rollback).
   * - post-install: stop forward progress; retain every artifact; ensure
   *   the live handle is closed when safe with the SAME authorization;
   *   recovery-required (LOCK-4425). Never rollback/cleanup/relaunch.
   * The lease is NEVER released here.
   */
  async function settleFailure(
    code: PromotionExecutionFailureCode,
    safeCode: string | null,
    cause?: unknown
  ): Promise<PromotionExecutionResult> {
    const failedSubphase = currentSubphase
    const classification: PromotionExecutionClassification = installed ? 'post-install' : 'pre-install'

    let liveDisposition: PromotionExecutionLiveDisposition
    if (classification === 'pre-install') {
      if (!liveClosed || liveDb.isInitialised()) {
        liveDisposition = 'open'
      } else {
        try {
          await liveDb.reopenForPromotion(capability.authorization)
          liveDisposition = 'open'
        } catch (error) {
          logger.warn(
            `Pre-install finalization could not reopen the live DB (${safeErrorCode(error)}); ` +
              'live bytes are unchanged and handles stay closed'
          )
          liveDisposition = 'closed'
        }
      }
    } else {
      // LOCK-4425: artifacts retained; ensure live closed when safe using
      // the same continuously held authorization.
      try {
        if (liveDb.isInitialised()) {
          liveDisposition = liveDb.closeForPromotion(capability.authorization) ? 'closed' : 'unknown'
        } else {
          liveDisposition = 'closed'
        }
      } catch (error) {
        logger.warn(
          `Post-install finalization could not confirm the live close (${safeErrorCode(error)}); ` +
            'artifacts retained, recovery required'
        )
        liveDisposition = 'unknown'
      }
    }

    const failure: PromotionExecutionFailure = Object.freeze({
      subphase: failedSubphase,
      classification,
      recoveryRequired: classification === 'post-install',
      code,
      safeCode,
      liveDisposition,
      cause
    })
    logger.warn(
      `Promotion execution failed at subphase '${failedSubphase}' (${code}, ${classification}` +
        `${failure.recoveryRequired ? ', recovery-required' : ''}): ${safeCode ?? 'no sub-code'}`
    )
    return Object.freeze({ ok: false as const, failure })
  }

  async function execute(): Promise<PromotionExecutionResult> {
    // --- 1. Authorized live close ---------------------------------------
    currentSubphase = 'closing-live'
    if (abortRequested) return settleFailure('ABORT_REQUESTED', 'BEFORE_CLOSE')
    {
      const reason = staleReason()
      if (reason !== null) return settleFailure('CAPABILITY_STALE', reason)
    }
    try {
      if (!liveDb.closeForPromotion(capability.authorization)) {
        // Close-core failure preserves the live handles for retry — the
        // executor treats it as terminal (live stays open/authoritative).
        return settleFailure('LIVE_CLOSE_FAILED', 'CLOSE_RETURNED_FALSE')
      }
    } catch (error) {
      return settleFailure('LIVE_CLOSE_FAILED', safeErrorCode(error), error)
    }
    liveClosed = true

    // --- 2. Mint the closed-live proof IMMEDIATELY after the successful
    //        close (LOCK-4427) with an honest lifecycle-bound witness. ----
    currentSubphase = 'minting-proof'
    const minted = primitives.mintProof({
      authorization: capability.authorization,
      witness: { isLiveClosed: () => !liveDb.isInitialised() },
      coordinator
    })
    if (!minted.ok) {
      const safe =
        minted.reason === 'authorization-invalid'
          ? `AUTHORIZATION_${minted.authorizationReason.replace(/-/g, '_').toUpperCase()}`
          : 'LIVE_NOT_CLOSED'
      return settleFailure('PROOF_MINT_FAILED', safe)
    }

    // --- 3. Sidecar handling + atomic rename-only install (LOCK-4426) ---
    currentSubphase = 'installing'
    if (abortRequested) return settleFailure('ABORT_REQUESTED', 'BEFORE_INSTALL')
    {
      const reason = staleReason()
      if (reason !== null) return settleFailure('CAPABILITY_STALE', reason)
    }
    const installResult = primitives.install({
      candidateId: capability.candidateId,
      proof: minted.proof,
      dataRoot
    })
    if (!installResult.ok) {
      if (installResult.phase === 'post-install') {
        // The rename already happened (LOCK-4425).
        installed = true
      }
      const safe =
        installResult.safeCode === null ? installResult.code : `${installResult.code}:${installResult.safeCode}`
      return settleFailure('INSTALL_FAILED', safe)
    }
    installed = true
    const receipt = installResult.receipt

    // --- 4. Durable candidate-installed ONLY after durable install
    //        success (LOCK-4423). -----------------------------------------
    currentSubphase = 'journal-candidate-installed'
    if (abortRequested) return settleFailure('ABORT_REQUESTED', 'BEFORE_JOURNAL_CANDIDATE_INSTALLED')
    {
      const reason = staleReason()
      if (reason !== null) return settleFailure('CAPABILITY_STALE', reason)
    }
    try {
      await primitives.advanceCandidateInstalled(journalDocument('candidate-installed'), dataRoot)
    } catch (error) {
      return settleFailure('JOURNAL_CANDIDATE_INSTALLED_FAILED', journalSafeCode(error), error)
    }

    // --- 5. Authorized live reopen (same lease, LOCK-4422) ---------------
    currentSubphase = 'reopening-live'
    if (abortRequested) return settleFailure('ABORT_REQUESTED', 'BEFORE_REOPEN')
    {
      const reason = staleReason()
      if (reason !== null) return settleFailure('CAPABILITY_STALE', reason)
    }
    try {
      await liveDb.reopenForPromotion(capability.authorization)
    } catch (error) {
      return settleFailure('LIVE_REOPEN_FAILED', safeErrorCode(error), error)
    }

    // --- 6. Identity-bound replacement verification (LOCK-4424) ----------
    currentSubphase = 'verifying-replacement'
    if (abortRequested) return settleFailure('ABORT_REQUESTED', 'BEFORE_VERIFY')
    const verdict = primitives.verify({ receipt, dataRoot })
    if (!verdict.ok) {
      const safe = verdict.safeCode === null ? verdict.code : `${verdict.code}:${verdict.safeCode}`
      return settleFailure('REPLACEMENT_VERIFICATION_FAILED', safe)
    }

    // --- 7. Durable replacement-verified ONLY after successful
    //        verification (LOCK-4424). ------------------------------------
    currentSubphase = 'journal-replacement-verified'
    if (abortRequested) return settleFailure('ABORT_REQUESTED', 'BEFORE_JOURNAL_REPLACEMENT_VERIFIED')
    {
      const reason = staleReason()
      if (reason !== null) return settleFailure('CAPABILITY_STALE', reason)
    }
    try {
      await primitives.advanceReplacementVerified(journalDocument('replacement-verified'), dataRoot)
    } catch (error) {
      return settleFailure('JOURNAL_REPLACEMENT_VERIFIED_FAILED', journalSafeCode(error), error)
    }

    // --- 8. Phase 4.4.3 handoff (LOCK-4428: STOP here) --------------------
    // No journal/snapshot cleanup, no relaunch, no rollback. The handoff
    // still owns the capability (same lease) so no competition window opens.
    currentSubphase = 'settled'
    const handoff: PromotionExecutionHandoff = Object.freeze({
      sessionId: capability.sessionId,
      candidateId: capability.candidateId,
      token: capability.token,
      receipt,
      retainedSnapshotPath: capability.retainedSnapshotPath,
      capability
    })
    logger.info(
      `Promotion execution settled at durable replacement-verified for session ${capability.sessionId} ` +
        '(Phase 4.4.3 handoff — no cleanup/relaunch, capability retained)'
    )
    return Object.freeze({ ok: true as const, handoff })
  }

  return {
    async run(): Promise<PromotionExecutionResult> {
      if (runStarted) {
        throw new Error('Promotion executor run() is exact-once: it has already been started.')
      }
      runStarted = true
      try {
        return await execute()
      } catch (error) {
        // Defensive containment: run() never rejects for operational
        // failures. Classification honors the install boundary.
        logger.error('Promotion execution failed unexpectedly', error as Error)
        return await settleFailure('UNEXPECTED_FAILURE', safeErrorCode(error), error)
      } finally {
        settled = true
        resolveSettled()
      }
    },

    requestAbort(): void {
      if (abortRequested) return
      abortRequested = true
      logger.info('Promotion execution abort requested (checked at the next subphase boundary)')
    },

    subphase(): PromotionExecutionSubphase {
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
