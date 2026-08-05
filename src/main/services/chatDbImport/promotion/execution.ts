/**
 * Destructive promotion executor — v2 three-artifact sequence
 * (Phase 4.4.2, LOCK-4421..4428; Phase 2 L2 promotion, LOCK-PROMO-2/4/5/6/9).
 *
 * The single Main-local orchestration unit that consumes an
 * ExecutingPromotionCapability (produced by the exact-once prepared-handle
 * consume, LOCK-4421) and drives the non-reorderable destructive sequence:
 *
 *   0. journal-read                — durable v2 journal MUST be valid,
 *                                     snapshots-ready, and EXACTLY this
 *                                     capability's identity + receipts
 *                                     (LOCK-EXEC-1) BEFORE any live mutation
 *   1. closing-live                 — authorized ChatDbService.closeForPromotion
 *   2. minting-proof                — closed-live proof minted IMMEDIATELY
 *                                     after the successful close (LOCK-4427)
 *   3. installing (db)              — atomic rename install of the candidate
 *                                     chat.db (LOCK-4426)
 *   4. journal-db-installed         — durable v2 advance (LOCK-PROMO-2)
 *   5. installing-files             — same-filesystem directory rename/swap
 *                                     of the candidate Files dir
 *                                     (LOCK-PROMO-4)
 *   6. journal-files-installed      — durable v2 advance
 *   7. journal-catalog-pending      — durable v2 advance; ordinary UI is
 *                                     blocked from here (LOCK-PROMO-7)
 *   8. applying-catalog             — SINGLE Dexie transaction replace-all
 *                                     through the renderer boundary, after
 *                                     the on-disk candidate catalog receipt
 *                                     matches the journal and before the
 *                                     post-apply facts are accepted
 *                                     (LOCK-EXEC-6)
 *   9. journal-catalog-applied      — durable v2 advance
 *  10. reopening-live               — authorized reopenForPromotion
 *  11. verifying-replacement        — exact all-new verification: db
 *                                     verifier + live db receipt + Files
 *                                     parity/aggregate receipt + catalog
 *                                     facts (LOCK-PROMO-9/LOCK-EXEC-5)
 *  12. journal-replacement-verified — durable v2 advance
 *  13. settled                      — Phase 4.4.3 handoff (LOCK-4428: STOP —
 *                                     no journal/snapshot cleanup, no
 *                                     relaunch, no rollback)
 *
 * Capability/lease invariants (LOCK-4422): the SAME promotion lease held
 * since preparation authorizes the whole window; the executor NEVER releases
 * or reacquires it and NEVER introduces a second mutex. The capability
 * authorization is re-validated at every irreversible boundary.
 *
 * Failure taxonomy (LOCK-4425, extended by LOCK-PROMO-6):
 * - `pre-install`: the live chat.db bytes were NOT replaced (and the Files
 *   swap did NOT happen). Finalization reopens the live DB when it had been
 *   closed (availability restoration — NOT a rollback). recoveryRequired =
 *   false.
 * - `post-install`: the DB rename OR the Files swap ALREADY happened.
 *   Finalization stops all forward progress, retains EVERY artifact
 *   (installed live bytes/dir, journal, retained snapshots, candidate),
 *   ensures the live handle is closed when safe, and reports
 *   recoveryRequired = true. It NEVER rolls back, restores snapshots,
 *   cleans the journal, or relaunches — deterministic startup recovery
 *   (Phase 4.4.3 / LOCK-PROMO-6) owns those decisions.
 *
 * Abort contract: {@link PromotionExecutor.requestAbort} is cooperative,
 * checked at every subphase boundary before the next irreversible action.
 *
 * Main-only module. Not exposed over IPC/preload/renderer.
 */

import path from 'node:path'

import { loggerService } from '@logger'
import {
  getSharedMaintenanceCoordinator,
  type MaintenanceCoordinator,
  validatePromotionAuthorization
} from '@main/services/chatDb/maintenanceCoordination'
import type { FilesCatalogSnapshotRow } from '@shared/chatImport/types'

import { readAndValidateCatalog } from '../attachmentPlane'
import { computeCatalogReceipt, computeDbReceipt, liveDbReceiptMatchesCandidate } from './artifactReceipts'
import { verifyFilesDirAgainstCatalog } from './catalogParity'
import { installCandidateFiles } from './filesInstall'
import type { InstallReceipt } from './install'
import { installCandidate, mintClosedLiveProof } from './install'
import type {
  PromotionArtifactReceipts,
  PromotionJournalFilesReceipt,
  PromotionJournalPhaseV2,
  PromotionJournalV2
} from './journal'
import { artifactReceiptsEqual, PROMOTION_JOURNAL_VERSION_V2 } from './journal'
import { advancePromotionJournalV2, PromotionJournalStoreError, readPromotionJournal } from './journalStore'
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
 * exact operation in flight.
 */
export const PROMOTION_EXECUTION_SUBPHASES = [
  'not-started',
  'closing-live',
  'minting-proof',
  'installing',
  'journal-db-installed',
  'installing-files',
  'journal-files-installed',
  'journal-catalog-pending',
  'applying-catalog',
  'journal-catalog-applied',
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
  | 'JOURNAL_DB_INSTALLED_FAILED'
  | 'FILES_INSTALL_FAILED'
  | 'JOURNAL_FILES_INSTALLED_FAILED'
  | 'JOURNAL_CATALOG_PENDING_FAILED'
  | 'CATALOG_APPLY_FAILED'
  | 'JOURNAL_CATALOG_APPLIED_FAILED'
  | 'LIVE_REOPEN_FAILED'
  | 'REPLACEMENT_VERIFICATION_FAILED'
  | 'JOURNAL_REPLACEMENT_VERIFIED_FAILED'
  | 'JOURNAL_READ_FAILED'
  | 'JOURNAL_IDENTITY_MISMATCH'
  | 'CANDIDATE_CATALOG_UNAVAILABLE'
  | 'CATALOG_BOUNDARY_UNAVAILABLE'
  | 'UNEXPECTED_FAILURE'

/** Failure classification relative to the destructive mutations. */
export type PromotionExecutionClassification = 'pre-install' | 'post-install'

/**
 * Live handle disposition after executor-owned finalization:
 * - `open`    — live DB reopened/left open (pre-install failures only)
 * - `closed`  — live DB handles are closed (post-install failures, and
 *               pre-install failures whose authorized reopen was refused)
 * - `unknown` — the ensure-closed attempt itself failed; treat as unsafe
 */
export type PromotionExecutionLiveDisposition = 'open' | 'closed' | 'unknown'

/**
 * Structured execution failure. `recoveryRequired` is true exactly for the
 * post-install classification (LOCK-4425/LOCK-PROMO-6): the journal +
 * retained snapshots + installed bytes/dir are preserved for deterministic
 * startup recovery, and nothing was rolled back.
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
 * still owns the executing capability (the same continuously held lease).
 * NEVER cross IPC with this.
 */
export interface PromotionExecutionHandoff {
  readonly sessionId: string
  readonly candidateId: string
  /** Exact-once claim token this execution settled against. */
  readonly token: string
  /** Branded install receipt binding the installed DB identity (LOCK-4423). */
  readonly receipt: InstallReceipt
  /** Aggregate receipts of the installed generation. */
  readonly receipts: {
    readonly candidate: PromotionArtifactReceipts
    readonly old: PromotionArtifactReceipts
  }
  /** Retained rollback snapshot path (db). Retained, never cleaned here. */
  readonly retainedSnapshotPath: string
  /** Retained Files rollback snapshot dir. */
  readonly retainedFilesSnapshotDir: string
  /** Retained catalog rollback snapshot file. */
  readonly catalogSnapshotPath: string
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
 * (LOCK-O8).
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
 * Catalog boundary the executor uses for the single-transaction catalog
 * apply and the post-install catalog facts query (LOCK-PROMO-5/9).
 * Production wraps catalogApplyIpc; tests inject a double.
 */
export interface CatalogBoundary {
  /**
   * Apply the candidate catalog rows in ONE Dexie transaction replace-all
   * and return the POST-operation facts.
   */
  applyCandidate(
    rows: readonly FilesCatalogSnapshotRow[],
    expected: { readonly count: number; readonly sha256: string }
  ): Promise<
    | { readonly ok: true; readonly facts: { count: number; sha256: string } }
    | { readonly ok: false; readonly code: string }
  >
  /** Query the current live catalog facts (count + digest). */
  queryFacts(): Promise<
    | { readonly ok: true; readonly facts: { count: number; sha256: string } }
    | { readonly ok: false; readonly code: string }
  >
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
  installFiles: typeof installCandidateFiles
  readJournal: typeof readPromotionJournal
  advanceDbInstalled: typeof advancePromotionJournalV2
  advanceFilesInstalled: typeof advancePromotionJournalV2
  advanceCatalogPending: typeof advancePromotionJournalV2
  advanceCatalogApplied: typeof advancePromotionJournalV2
  advanceReplacementVerified: typeof advancePromotionJournalV2
  verify: typeof verifyReplacement
  /** Exact live DB receipt (SHA-256 + byte size) for LOCK-EXEC-5. */
  computeDbReceipt: typeof computeDbReceipt
}

export interface PromotionExecutorOptions {
  /** The exact-once executing capability (LOCK-4421/4422). */
  capability: ExecutingPromotionCapability
  /** Controlled Data root containing the live chat.db. */
  dataRoot: string
  /** Live ChatDbService surface (promotion-owned lifecycle only). */
  liveDb: PromotionExecutionLiveDb
  /** Catalog boundary for the Dexie handoff (LOCK-PROMO-5). */
  catalogBoundary: CatalogBoundary
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
 * rejects; `requestAbort()` is the cooperative dispose/will-quit contract;
 * `whenSettled()` resolves when the terminal result is settled.
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
 * Null-aware candidate files receipt match (LOCK-EXEC-5): a `null` journaled
 * receipt means the candidate generation had NO Files — only a zero-count
 * parity receipt matches; otherwise the derived parity receipt must be exact.
 */
function filesReceiptMatches(
  actual: PromotionJournalFilesReceipt,
  expected: PromotionJournalFilesReceipt | null
): boolean {
  if (expected === null) return actual.count === 0
  return (
    actual.count === expected.count && actual.totalBytes === expected.totalBytes && actual.sha256 === expected.sha256
  )
}

/**
 * Create the destructive promotion executor bound to one capability, one
 * controlled Data root, one live ChatDbService surface, and one catalog
 * boundary. See the module header for the full sequence and locked
 * invariants.
 */
export function createPromotionExecutor(options: PromotionExecutorOptions): PromotionExecutor {
  const coordinator = options.coordinator ?? getSharedMaintenanceCoordinator()
  const capability = options.capability
  const liveDb = options.liveDb
  const dataRoot = options.dataRoot
  const catalogBoundary = options.catalogBoundary

  const primitives: PromotionExecutionPrimitives = {
    validateAuthorization: options.primitives?.validateAuthorization ?? validatePromotionAuthorization,
    mintProof: options.primitives?.mintProof ?? mintClosedLiveProof,
    install: options.primitives?.install ?? installCandidate,
    installFiles: options.primitives?.installFiles ?? installCandidateFiles,
    readJournal: options.primitives?.readJournal ?? readPromotionJournal,
    advanceDbInstalled: options.primitives?.advanceDbInstalled ?? advancePromotionJournalV2,
    advanceFilesInstalled: options.primitives?.advanceFilesInstalled ?? advancePromotionJournalV2,
    advanceCatalogPending: options.primitives?.advanceCatalogPending ?? advancePromotionJournalV2,
    advanceCatalogApplied: options.primitives?.advanceCatalogApplied ?? advancePromotionJournalV2,
    advanceReplacementVerified: options.primitives?.advanceReplacementVerified ?? advancePromotionJournalV2,
    verify: options.primitives?.verify ?? verifyReplacement,
    computeDbReceipt: options.primitives?.computeDbReceipt ?? computeDbReceipt
  }

  let currentSubphase: PromotionExecutionSubphase = 'not-started'
  let abortRequested = false
  let runStarted = false
  let settled = false
  let resolveSettled!: () => void
  const settledPromise = new Promise<void>((resolve) => {
    resolveSettled = resolve
  })
  /** True once the DB install rename happened (LOCK-4425 boundary). */
  let installed = false
  /** True once the authorized live close succeeded. */
  let liveClosed = false

  /** The journal aggregate receipts (candidate + old), read at start. */
  let receipts: { candidate: PromotionArtifactReceipts; old: PromotionArtifactReceipts }

  function journalDocument(phase: PromotionJournalPhaseV2): PromotionJournalV2 {
    return {
      version: PROMOTION_JOURNAL_VERSION_V2,
      sessionId: capability.sessionId,
      candidateId: capability.candidateId,
      phase,
      receipts
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
   *   authorization when this executor had closed it.
   * - post-install: stop forward progress; retain every artifact; ensure
   *   the live handle is closed when safe; recovery-required.
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
      // LOCK-4425/LOCK-PROMO-6: artifacts retained; ensure live closed when
      // safe using the same continuously held authorization.
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
    // --- 0. Read the durable v2 journal (snapshots-ready) and validate the
    //        one-shot capability against it BEFORE any live mutation
    //        (LOCK-EXEC-1: exact identity + receipts must match). -----------
    currentSubphase = 'not-started'
    try {
      const journal = await primitives.readJournal(dataRoot)
      if (journal.status !== 'valid' || journal.journal.version !== PROMOTION_JOURNAL_VERSION_V2) {
        const safe = journal.status === 'invalid' ? 'INVALID' : journal.status === 'absent' ? 'ABSENT' : 'NOT_V2'
        return settleFailure('JOURNAL_READ_FAILED', safe, undefined)
      }
      if (journal.journal.phase !== 'snapshots-ready') {
        return settleFailure('JOURNAL_READ_FAILED', `PHASE_${journal.journal.phase}`, undefined)
      }
      // LOCK-EXEC-1: the durable journal must be EXACTLY this capability's
      // journal — identical session/candidate identity and identical
      // candidate + old aggregate receipts. A stale journal (another
      // session/candidate) or diverged receipts must never let this
      // capability install its candidate while journaling a different
      // generation (or vice versa).
      if (
        journal.journal.sessionId !== capability.sessionId ||
        journal.journal.candidateId !== capability.candidateId
      ) {
        return settleFailure('JOURNAL_IDENTITY_MISMATCH', 'SESSION_OR_CANDIDATE_ID', undefined)
      }
      if (
        !artifactReceiptsEqual(journal.journal.receipts.candidate, capability.receipts.candidate) ||
        !artifactReceiptsEqual(journal.journal.receipts.old, capability.receipts.old)
      ) {
        return settleFailure('JOURNAL_IDENTITY_MISMATCH', 'RECEIPTS_DIVERGED', undefined)
      }
      receipts = journal.journal.receipts
    } catch (error) {
      return settleFailure('JOURNAL_READ_FAILED', journalSafeCode(error), error)
    }

    // --- 1. Authorized live close -----------------------------------------
    currentSubphase = 'closing-live'
    if (abortRequested) return settleFailure('ABORT_REQUESTED', 'BEFORE_CLOSE')
    {
      const reason = staleReason()
      if (reason !== null) return settleFailure('CAPABILITY_STALE', reason)
    }
    try {
      if (!liveDb.closeForPromotion(capability.authorization)) {
        return settleFailure('LIVE_CLOSE_FAILED', 'CLOSE_RETURNED_FALSE')
      }
    } catch (error) {
      return settleFailure('LIVE_CLOSE_FAILED', safeErrorCode(error), error)
    }
    liveClosed = true

    // --- 2. Mint the closed-live proof IMMEDIATELY after the close --------
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

    // --- 3. Sidecar handling + atomic rename-only DB install (LOCK-4426) --
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
        installed = true
      }
      const safe =
        installResult.safeCode === null ? installResult.code : `${installResult.code}:${installResult.safeCode}`
      return settleFailure('INSTALL_FAILED', safe)
    }
    installed = true
    const receipt = installResult.receipt

    // --- 4. Durable db-installed ONLY after durable install success ------
    currentSubphase = 'journal-db-installed'
    if (abortRequested) return settleFailure('ABORT_REQUESTED', 'BEFORE_JOURNAL_DB_INSTALLED')
    {
      const reason = staleReason()
      if (reason !== null) return settleFailure('CAPABILITY_STALE', reason)
    }
    try {
      await primitives.advanceDbInstalled(journalDocument('db-installed'), 'snapshots-ready', dataRoot)
    } catch (error) {
      return settleFailure('JOURNAL_DB_INSTALLED_FAILED', journalSafeCode(error), error)
    }

    // --- 5. Candidate Files install (same-filesystem rename/swap) ---------
    currentSubphase = 'installing-files'
    if (abortRequested) return settleFailure('ABORT_REQUESTED', 'BEFORE_FILES_INSTALL')
    {
      const reason = staleReason()
      if (reason !== null) return settleFailure('CAPABILITY_STALE', reason)
    }
    const filesResult = primitives.installFiles({ candidateId: capability.candidateId, dataRoot })
    if (!filesResult.ok) {
      // A post-install files failure means the swap already happened.
      if (filesResult.phase === 'post-install') {
        // `installed` is already true (db rename happened first).
      }
      const safe = filesResult.safeCode === null ? filesResult.code : `${filesResult.code}:${filesResult.safeCode}`
      return settleFailure('FILES_INSTALL_FAILED', safe)
    }

    // --- 6. Durable files-installed ONLY after the swap succeeded ---------
    currentSubphase = 'journal-files-installed'
    if (abortRequested) return settleFailure('ABORT_REQUESTED', 'BEFORE_JOURNAL_FILES_INSTALLED')
    {
      const reason = staleReason()
      if (reason !== null) return settleFailure('CAPABILITY_STALE', reason)
    }
    try {
      await primitives.advanceFilesInstalled(journalDocument('files-installed'), 'db-installed', dataRoot)
    } catch (error) {
      return settleFailure('JOURNAL_FILES_INSTALLED_FAILED', journalSafeCode(error), error)
    }

    // --- 7. Durable catalog-pending (ordinary UI blocked from here) --------
    currentSubphase = 'journal-catalog-pending'
    if (abortRequested) return settleFailure('ABORT_REQUESTED', 'BEFORE_CATALOG_PENDING')
    {
      const reason = staleReason()
      if (reason !== null) return settleFailure('CAPABILITY_STALE', reason)
    }
    try {
      await primitives.advanceCatalogPending(journalDocument('catalog-pending'), 'files-installed', dataRoot)
    } catch (error) {
      return settleFailure('JOURNAL_CATALOG_PENDING_FAILED', journalSafeCode(error), error)
    }

    // --- 8. Single Dexie transaction catalog apply (LOCK-PROMO-5) ---------
    currentSubphase = 'applying-catalog'
    if (abortRequested) return settleFailure('ABORT_REQUESTED', 'BEFORE_CATALOG_APPLY')
    {
      const reason = staleReason()
      if (reason !== null) return settleFailure('CAPABILITY_STALE', reason)
    }
    // Read the candidate catalog rows for the replace-all payload.
    let catalogRows: FilesCatalogSnapshotRow[]
    try {
      const catalog = readAndValidateCatalog(
        path.join(dataRoot, 'chat-import-candidates', capability.candidateId, 'files-catalog.json')
      )
      if (catalog === null) {
        return settleFailure('CANDIDATE_CATALOG_UNAVAILABLE', 'CATALOG_UNREADABLE')
      }
      catalogRows = catalog.rows.map((row) => ({
        id: row.id,
        name: row.name,
        origin_name: row.origin_name,
        path: row.path,
        size: row.size,
        ext: row.ext,
        type: row.type,
        created_at: row.created_at,
        count: row.count
      }))
    } catch (error) {
      return settleFailure('CANDIDATE_CATALOG_UNAVAILABLE', safeErrorCode(error), error)
    }
    const expectedCatalog = receipts.candidate.catalog
    if (expectedCatalog === null) {
      return settleFailure('CANDIDATE_CATALOG_UNAVAILABLE', 'NO_CANDIDATE_CATALOG_RECEIPT')
    }
    // LOCK-EXEC-6: the on-disk candidate catalog must be EXACTLY the
    // journaled candidate generation before it can be applied — re-derive
    // the aggregate receipt from the rows and refuse a diverged handoff
    // (tamper) BEFORE the destructive replace-all.
    {
      const derivedCatalog = computeCatalogReceipt(catalogRows)
      if (derivedCatalog.count !== expectedCatalog.count || derivedCatalog.sha256 !== expectedCatalog.sha256) {
        return settleFailure('CANDIDATE_CATALOG_UNAVAILABLE', 'CATALOG_RECEIPT_MISMATCH')
      }
    }
    try {
      const applied = await catalogBoundary.applyCandidate(catalogRows, expectedCatalog)
      if (!applied.ok) {
        return settleFailure('CATALOG_APPLY_FAILED', applied.code)
      }
      // LOCK-EXEC-2: verify the post-apply catalog facts BEFORE journaling
      // catalog-applied — a transaction that committed divergent facts must
      // never be journaled as applied (the journal stays catalog-pending).
      if (applied.facts.count !== expectedCatalog.count || applied.facts.sha256 !== expectedCatalog.sha256) {
        return settleFailure('CATALOG_APPLY_FAILED', 'FACTS_MISMATCH')
      }
    } catch (error) {
      return settleFailure('CATALOG_APPLY_FAILED', safeErrorCode(error), error)
    }

    // --- 9. Durable catalog-applied ONLY after the transaction committed ---
    currentSubphase = 'journal-catalog-applied'
    if (abortRequested) return settleFailure('ABORT_REQUESTED', 'BEFORE_CATALOG_APPLIED')
    {
      const reason = staleReason()
      if (reason !== null) return settleFailure('CAPABILITY_STALE', reason)
    }
    try {
      await primitives.advanceCatalogApplied(journalDocument('catalog-applied'), 'catalog-pending', dataRoot)
    } catch (error) {
      return settleFailure('JOURNAL_CATALOG_APPLIED_FAILED', journalSafeCode(error), error)
    }

    // --- 10. Authorized live reopen (same lease, LOCK-4422) ---------------
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

    // --- 11. Identity-bound replacement verification (LOCK-PROMO-9) -------
    currentSubphase = 'verifying-replacement'
    if (abortRequested) return settleFailure('ABORT_REQUESTED', 'BEFORE_VERIFY')
    // LOCK-EXEC-5 exact all-new verification:
    //   db       — identity-bound readonly gates + exact SHA-256/size vs the
    //              journaled candidate db receipt;
    //   Files    — per-row parity vs the candidate catalog + aggregate
    //              receipt equality vs the journaled candidate files receipt;
    //   catalog  — live facts equality vs the journaled candidate catalog
    //              receipt.
    const dbVerdict = primitives.verify({ receipt, dataRoot })
    if (!dbVerdict.ok) {
      const safe = dbVerdict.safeCode === null ? dbVerdict.code : `${dbVerdict.code}:${dbVerdict.safeCode}`
      return settleFailure('REPLACEMENT_VERIFICATION_FAILED', safe)
    }
    if (receipts.candidate.db === null) {
      return settleFailure('REPLACEMENT_VERIFICATION_FAILED', 'NO_CANDIDATE_DB_RECEIPT')
    }
    try {
      const liveDbReceipt = await primitives.computeDbReceipt(path.join(dataRoot, 'chat.db'))
      if (!liveDbReceiptMatchesCandidate(liveDbReceipt, receipts.candidate.db)) {
        return settleFailure('REPLACEMENT_VERIFICATION_FAILED', 'DB_RECEIPT_MISMATCH')
      }
    } catch (error) {
      return settleFailure('REPLACEMENT_VERIFICATION_FAILED', safeErrorCode(error), error)
    }
    // Files parity vs the candidate catalog (row↔filename↔size↔SHA-256) plus
    // the derived aggregate receipt vs the journaled candidate files receipt.
    let filesParityOk = false
    let filesParitySafe: string | null = null
    try {
      const catalog = readAndValidateCatalog(
        path.join(dataRoot, 'chat-import-candidates', capability.candidateId, 'files-catalog.json')
      )
      if (catalog === null) {
        filesParitySafe = 'CATALOG_UNREADABLE'
      } else {
        const rows = catalog.rows.map((row) => ({ name: row.name, size: row.size, sha256: row.sha256 }))
        const parity = verifyFilesDirAgainstCatalog(path.join(dataRoot, 'Files'), rows)
        if (parity.ok) {
          if (filesReceiptMatches(parity.receipt, receipts.candidate.files)) {
            filesParityOk = true
          } else {
            filesParitySafe = 'FILES_RECEIPT_MISMATCH'
          }
        } else {
          filesParitySafe = `FILES_PARITY_${parity.code}`
        }
      }
    } catch {
      filesParitySafe = 'CATALOG_UNREADABLE'
    }
    if (!filesParityOk) {
      return settleFailure('REPLACEMENT_VERIFICATION_FAILED', filesParitySafe ?? 'FILES_PARITY_FAILED')
    }
    // Catalog facts re-queried through the boundary and compared to the
    // candidate catalog receipt (LOCK-PROMO-9 catalog transaction result).
    let catalogFactsVerified = false
    try {
      const facts = await catalogBoundary.queryFacts()
      if (facts.ok && expectedCatalog.count === facts.facts.count && expectedCatalog.sha256 === facts.facts.sha256) {
        catalogFactsVerified = true
      }
    } catch {
      catalogFactsVerified = false
    }
    if (!catalogFactsVerified) {
      return settleFailure('REPLACEMENT_VERIFICATION_FAILED', 'CATALOG_FACTS_MISMATCH')
    }

    // --- 12. Durable replacement-verified ONLY after all gates pass -------
    currentSubphase = 'journal-replacement-verified'
    if (abortRequested) return settleFailure('ABORT_REQUESTED', 'BEFORE_JOURNAL_REPLACEMENT_VERIFIED')
    {
      const reason = staleReason()
      if (reason !== null) return settleFailure('CAPABILITY_STALE', reason)
    }
    try {
      await primitives.advanceReplacementVerified(journalDocument('replacement-verified'), 'catalog-applied', dataRoot)
    } catch (error) {
      return settleFailure('JOURNAL_REPLACEMENT_VERIFIED_FAILED', journalSafeCode(error), error)
    }

    // --- 13. Phase 4.4.3 handoff (LOCK-4428: STOP here) --------------------
    currentSubphase = 'settled'
    const handoff: PromotionExecutionHandoff = Object.freeze({
      sessionId: capability.sessionId,
      candidateId: capability.candidateId,
      token: capability.token,
      receipt,
      receipts,
      retainedSnapshotPath: capability.retainedSnapshotPath,
      retainedFilesSnapshotDir: capability.retainedFilesSnapshotDir,
      catalogSnapshotPath: capability.catalogSnapshotPath,
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
