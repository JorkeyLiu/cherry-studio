/**
 * v2 recovery executor — three-artifact recovery/finalization pipeline
 * (Phase 2 L2 promotion, LOCK-PROMO-6/7/10).
 *
 * Handles a durable v2 journal (three-artifact protocol). v1 journals keep
 * flowing through the original chat.db-only executor (LOCK-PROMO-10 — never
 * reinterpret v1 as a partial Files generation).
 *
 * Five v2 actions:
 * - keep-old-live            — candidates-ready/snapshots-ready with the old
 *                              generation intact: cleanup the v2 journal and
 *                              proceed. No relaunch.
 * - complete-catalog-apply   — forward completion (LOCK-PROMO-6: prefer the
 *                              new generation when all installed artifacts
 *                              verify): apply/verify the candidate catalog,
 *                              advance catalog-pending → catalog-applied →
 *                              replacement-verified, cleanup, relaunch.
 * - accept-verified-replacement — all three verify: cleanup
 *                              replacement-verified, relaunch.
 * - restore-rollback-snapshot — restore ALL THREE old artifacts (db + Files
 *                              + catalog), verify against the old receipts,
 *                              cleanup the journal at whatever v2 phase it
 *                              was at, relaunch.
 * - repair-required          — hard-block init; retain all artifacts.
 *
 * Deferred convergence:
 * - deferredToWindow — the catalog-dependent actions REQUIRE the renderer
 *   boundary (window mode). When the boundary is unavailable the executor
 *   returns a bounded defer signal so the startup gate can boot the
 *   recovery-only surface.
 * - deferredToStartup (F1, protocol-audit correction) — a lease-busy restore
 *   in the TERMINAL-HANDOFF finalization context. Terminal promotion
 *   ownership still holds the promotion lease, so the destructive restore
 *   cannot run HERE. This is neither restore success nor a generic failure:
 *   the all-new generation may already be fully verified and installed
 *   (journal at replacement-verified), and a transient catalog query failure
 *   is the likely reason the matrix chose restore. The journal is left
 *   intact (no cleanup), nothing is rolled back, and no restart is
 *   requested — startup recovery (fresh process, free lease) reverifies and
 *   accepts/cleans deterministically.
 *
 * Candidate handoff cleanup (LOCK-CLEAN-1..5): every path that durably
 * cleans the v2 journal (keep-old-live and finishAndRestart for
 * complete/accept/restore) then removes the exact owned candidate directory
 * (the `files-catalog.json` handoff + empty shell) through the candidateDb
 * helper. Ordering is strict — candidate evidence is NEVER deleted while the
 * journal still exists (LOCK-CLEAN-1/5); a removal failure after the journal
 * cleanup is an artifact-cleanup residual, not a data rollback, and the
 * converged result stays truthful (`candidateCleaned: false`, age-based
 * orphan cleanup remains the fallback) (LOCK-CLEAN-4).
 *
 * Main-only module. Not exposed over IPC/preload/renderer.
 */

import path from 'node:path'

import { loggerService } from '@logger'
import { DATA_PATH } from '@main/config'
import {
  acquirePromotionLease,
  getSharedMaintenanceCoordinator,
  isMaintenanceBusyError,
  type MaintenanceCoordinator
} from '@main/services/chatDb/maintenanceCoordination'
import type { FilesCatalogSnapshotRow, FilesCatalogSnapshotV1 } from '@shared/chatImport/types'

import { readAndValidateCatalog } from '../attachmentPlane'
import { removeConvergedCandidate } from '../candidateDb'
import { probeLiveDb, probeLiveFiles, probePromotionArtifactsV2, resolveLiveDbPath } from './artifactProbe'
import { computeCatalogReceipt, computeDbReceipt, liveDbReceiptMatchesCandidate } from './artifactReceipts'
import { verifyFilesDirAgainstCatalog } from './catalogParity'
import { mintClosedLiveProof } from './install'
import type {
  PromotionArtifactReceipts,
  PromotionJournalCatalogReceipt,
  PromotionJournalFilesReceipt,
  PromotionJournalPhaseV2,
  PromotionJournalV2
} from './journal'
import { PROMOTION_JOURNAL_VERSION_V2 } from './journal'
import {
  advancePromotionJournalV2,
  cleanupPromotionJournalAtV2Phase,
  type PromotionJournalCleanupIdentity,
  readPromotionJournal
} from './journalStore'
import type { PROMOTION_RECOVERY_ACTIONS_V2, PromotionRecoveryDecisionV2, PromotionRecoveryInputV2 } from './recovery'
import { decidePromotionRecoveryV2 } from './recovery'
import { rollbackAllThree } from './rollbackV2'

const logger = loggerService.withContext('chatDbImportRecoveryV2')

// ---------------------------------------------------------------------------
// Catalog boundary (production wraps catalogApplyIpc; tests inject doubles)
// ---------------------------------------------------------------------------

/** Full catalog boundary needed by the v2 recovery executor. */
export interface RecoveryV2CatalogBoundary {
  applyCandidate(
    rows: readonly FilesCatalogSnapshotRow[],
    expected: { readonly count: number; readonly sha256: string }
  ): Promise<
    | { readonly ok: true; readonly facts: { count: number; sha256: string } }
    | { readonly ok: false; readonly code: string }
  >
  restoreSnapshot(
    snapshot: FilesCatalogSnapshotV1
  ): Promise<
    | { readonly ok: true; readonly facts: { count: number; sha256: string } }
    | { readonly ok: false; readonly code: string }
  >
  queryFacts(): Promise<
    | { readonly ok: true; readonly facts: { count: number; sha256: string } }
    | { readonly ok: false; readonly code: string }
  >
}

/** Narrow live DB surface for the v2 recovery executor. */
export interface RecoveryV2LiveDb {
  isInitialised(): boolean
  closeForPromotion?(authorization: unknown): boolean
}

/** Restart surface for the v2 recovery executor. */
export interface RecoveryV2Restart {
  /** 'relaunch' (packaged) or 'in-process-reload' (non-packaged). */
  mode: 'relaunch' | 'in-process-reload'
  relaunch(): { relaunched: boolean }
  /** Required for in-process-reload mode; ignored in relaunch mode. */
  reloadRenderer?(ownerId: string): { ok: boolean; reloaded: boolean }
}

/** Options for {@link runRecoveryV2}. */
export interface RecoveryV2Options {
  dataRoot?: string
  catalogBoundary: RecoveryV2CatalogBoundary | null
  liveDb: RecoveryV2LiveDb
  coordinator?: MaintenanceCoordinator
  sampleCount?: number
  /** Restart strategy (packaged → relaunch; dev/E2E → in-process reload). */
  restart?: RecoveryV2Restart
  /** Injectable primitives (tests). */
  primitives?: {
    probeV2?: typeof probePromotionArtifactsV2
    decide?: typeof decidePromotionRecoveryV2
    readJournal?: typeof readPromotionJournal
    advance?: typeof advancePromotionJournalV2
    cleanupAtPhase?: typeof cleanupPromotionJournalAtV2Phase
    rollbackAll?: typeof rollbackAllThree
    markRepairRequiredBeforeInit?: () => void
    /**
     * All-new generation verification seam (LOCK-REC-2/4). Defaults to the
     * real receipt-exact verification over disk + the catalog boundary.
     */
    verifyInstalledGeneration?: typeof verifyInstalledGeneration
    /**
     * Pre-apply generation verification seam (LOCK-REC-2). Defaults to the
     * real probe + candidate-catalog receipt check.
     */
    verifyPreApplyGeneration?: typeof verifyPreApplyGeneration
    /**
     * Candidate catalog handoff read seam (LOCK-REC-2). Defaults to the real
     * disk read of `files-catalog.json`.
     */
    readHandoff?: typeof readCandidateCatalogHandoff
    /**
     * Exact live-DB candidate-receipt identity seam (LOCK-AMB-3). Defaults to
     * the real disk computation — streaming SHA-256 + byte size of the live
     * chat.db compared against the journal candidate db receipt; missing
     * receipt, unreadable DB, or mismatch fails closed (never true).
     */
    computeLiveDbReceiptMatch?: () => Promise<boolean>
    /**
     * Exact converged-candidate removal seam (LOCK-CLEAN-1..5). Defaults to
     * the real candidateDb helper. Called ONLY after the v2 journal cleanup
     * succeeded — a removal attempt while the journal still exists would
     * destroy recovery evidence (LOCK-CLEAN-1). Returns true when no
     * candidate evidence remains (removed or already absent — idempotent);
     * throws on failure.
     */
    removeConvergedCandidate?: typeof removeConvergedCandidate
  }
}

/** Bounded v2 recovery failure codes. */
export type RecoveryV2FailureCode =
  | 'JOURNAL_READ_FAILED'
  | 'JOURNAL_NOT_V2'
  | 'PROBE_FAILED'
  | 'DECIDE_FAILED'
  | 'BOUNDARY_UNAVAILABLE'
  | 'CATALOG_FACTS_FAILED'
  | 'CATALOG_APPLY_FAILED'
  | 'JOURNAL_ADVANCE_FAILED'
  | 'VERIFY_FAILED'
  | 'RESTORE_FAILED'
  | 'CLEANUP_FAILED'
  | 'RELAUNCH_FAILED'
  | 'REPAIR_MARK_FAILED'
  | 'UNEXPECTED'

/** Result of {@link runRecoveryV2}. Never throws. */
export type RecoveryV2Result =
  | {
      readonly ok: true
      readonly action: (typeof PROMOTION_RECOVERY_ACTIONS_V2)[number]
      readonly journalCleaned: boolean
      /**
       * LOCK-CLEAN-2/4: true when the exact owned candidate evidence was
       * removed (or was already absent) after the journal cleanup. False when
       * the journal was not cleaned (no removal was ever attempted) or when
       * the removal itself failed — an artifact-cleanup residual, never a
       * data rollback and never a failed convergence (age-based orphan
       * cleanup remains the fallback).
       */
      readonly candidateCleaned: boolean
      /** True when a restart/reload was requested. */
      readonly restartRequested: boolean
      /** True when the executor deferred to window mode (boundary needed). */
      readonly deferredToWindow: boolean
      /**
       * F1 (protocol-audit correction): true ONLY on the explicit
       * deferred-to-startup variant below. Absent/false on every ordinary
       * converged result — do not read it as a success signal.
       */
      readonly deferredToStartup?: false
    }
  | {
      /**
       * F1 (protocol-audit correction): explicit deferred-to-startup
       * convergence contract. The restore decision was made but the
       * destructive rollback CANNOT run in this process because terminal
       * promotion ownership still holds the promotion lease (lease-busy).
       * Semantics — never restore success, never generic failure:
       * - `journalCleaned` is false: the journal is left intact so startup
       *   recovery converges deterministically (accept or rollback).
       * - Nothing was rolled back, no candidate evidence was removed
       *   (`candidateCleaned` false), and no restart was requested.
       * - Consumers MUST NOT emit promoted (not accepted+cleaned) and MUST
       *   NOT claim the old data was restored (no rollback ran).
       */
      readonly ok: true
      readonly action: 'restore-rollback-snapshot'
      readonly journalCleaned: false
      readonly candidateCleaned: false
      readonly restartRequested: false
      readonly deferredToWindow: false
      readonly deferredToStartup: true
      /** Bounded reason for the defer — always LEASE_BUSY today. */
      readonly deferReason: 'LEASE_BUSY'
    }
  | { readonly ok: false; readonly code: RecoveryV2FailureCode; readonly safeCode: string | null }

function fail(code: RecoveryV2FailureCode, safeCode: string | null): RecoveryV2Result {
  logger.warn(`v2 recovery failed (${code}): ${safeCode ?? 'no sub-code'}`)
  return Object.freeze({ ok: false as const, code, safeCode })
}

/** Read the current candidate catalog rows (row↔file parity source). */
function readCandidateCatalogRows(candidateId: string, dataRoot: string): FilesCatalogSnapshotRow[] | null {
  try {
    const catalog = readAndValidateCatalog(
      path.join(dataRoot, 'chat-import-candidates', candidateId, 'files-catalog.json')
    )
    if (catalog === null) return null
    return catalog.rows.map((row) => ({
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
  } catch {
    return null
  }
}

/**
 * Read the candidate catalog handoff AND its aggregate receipt. The receipt
 * is re-derived from the rows (canonical `id\0name\0size\0count` records) so
 * the executor can prove the on-disk handoff is EXACTLY the journaled
 * candidate generation before applying it (LOCK-REC-2).
 */
export function readCandidateCatalogHandoff(
  candidateId: string,
  dataRoot: string
): { readonly rows: FilesCatalogSnapshotRow[]; readonly receipt: PromotionJournalCatalogReceipt } | null {
  const rows = readCandidateCatalogRows(candidateId, dataRoot)
  if (rows === null) return null
  return { rows, receipt: computeCatalogReceipt(rows) }
}

/** Facts-match check against a journal receipt. */
function factsMatch(facts: { count: number; sha256: string }, receipt: PromotionArtifactReceipts['catalog']): boolean {
  if (receipt === null) {
    return facts.count === 0
  }
  return facts.count === receipt.count && facts.sha256 === receipt.sha256
}

/**
 * Live Files parity-receipt match against a journal files receipt. A `null`
 * journal receipt means the generation had NO Files (empty) — only a
 * zero-count parity receipt matches.
 */
function filesReceiptMatches(
  actual: PromotionJournalFilesReceipt,
  expected: PromotionJournalFilesReceipt | null
): boolean {
  if (expected === null) {
    return actual.count === 0
  }
  return (
    actual.count === expected.count && actual.totalBytes === expected.totalBytes && actual.sha256 === expected.sha256
  )
}

/**
 * Run the v2 recovery to convergence (all-new or all-old), with optional
 * restart/reload. Never rejects — every failure maps to a bounded result.
 */
export async function runRecoveryV2(options: RecoveryV2Options): Promise<RecoveryV2Result> {
  try {
    return await runRecoveryV2Inner(options)
  } catch (error) {
    // LOCK-REC-7: the executor never throws — an unexpected failure must
    // surface as a bounded failure so the startup gate can decide (the
    // journal and all artifacts remain untouched for a deterministic retry).
    return fail('UNEXPECTED', 'IO')
  }
}

/** The never-rejecting body of {@link runRecoveryV2}. */
async function runRecoveryV2Inner(options: RecoveryV2Options): Promise<RecoveryV2Result> {
  const dataRoot = options.dataRoot ?? DATA_PATH
  const coordinator = options.coordinator ?? getSharedMaintenanceCoordinator()
  const sampleCount = options.sampleCount ?? 3
  const primitives = options.primitives ?? {}

  // --- 1. Journal read -----------------------------------------------------
  let journal: PromotionJournalV2
  try {
    const result = await (primitives.readJournal ?? readPromotionJournal)(dataRoot)
    if (result.status !== 'valid' || result.journal.version !== PROMOTION_JOURNAL_VERSION_V2) {
      // A valid-but-v1 journal is its own bounded evidence (LOCK-PROMO-10).
      const safeCode = result.status === 'invalid' ? 'INVALID' : result.status === 'absent' ? 'ABSENT' : 'V1'
      return fail('JOURNAL_NOT_V2', safeCode)
    }
    journal = result.journal
  } catch (error) {
    return fail('JOURNAL_READ_FAILED', 'IO')
  }

  const identity: PromotionJournalCleanupIdentity = {
    sessionId: journal.sessionId,
    candidateId: journal.candidateId
  }
  const candidateReceipts = journal.receipts.candidate
  const oldReceipts = journal.receipts.old

  // --- 2. Disk probe -------------------------------------------------------
  // LOCK-REC-1: the FULL probe result — including the probe-derived
  // `candidateCatalog` handoff status — is fed unchanged to the pure matrix.
  let probeInput: PromotionRecoveryInputV2
  try {
    const disk = (primitives.probeV2 ?? probePromotionArtifactsV2)(journal.candidateId, dataRoot)
    probeInput = {
      journal: disk.journal,
      live: disk.live,
      dbSnapshot: disk.dbSnapshot,
      candidate: disk.candidate,
      files: disk.files,
      filesSnapshot: disk.filesSnapshot,
      filesStaging: disk.filesStaging,
      catalogSnapshot: disk.catalogSnapshot,
      catalogApplied: disk.catalogApplied,
      candidateCatalog: disk.candidateCatalog
    }
  } catch (error) {
    return fail('PROBE_FAILED', 'IO')
  }

  // --- 3. Catalog facts (requires the boundary) ----------------------------
  const boundary = options.catalogBoundary
  let catalogApplied: 'verified' | 'unverified' | 'unknown' = 'unknown'
  if (boundary !== null) {
    try {
      const facts = await boundary.queryFacts()
      if (facts.ok) {
        catalogApplied = factsMatch(facts.facts, candidateReceipts.catalog) ? 'verified' : 'unverified'
      }
    } catch {
      catalogApplied = 'unknown'
    }
  }
  probeInput = { ...probeInput, catalogApplied }

  // --- 3b. Live-DB candidate-receipt identity (LOCK-AMB-3) -----------------
  // The coarse `live === 'present-verified'` status cannot tell the old and
  // new generations apart (both pass SQLite integrity/FK/samples): a
  // rollback-midway crash restores the OLD db while the NEW Files/catalog
  // stay live. The ONLY generation identity is the exact size + SHA-256
  // comparison of the live chat.db against the journal candidate db receipt.
  // Missing candidate receipt, unreadable live DB, or any divergence fails
  // closed (false) — it must never enable forward completion / accept-new
  // (LOCK-AMB-4). The seam lets tests inject both boolean values.
  const computeLiveDbReceiptMatch =
    primitives.computeLiveDbReceiptMatch ??
    (async () => {
      try {
        const liveDbReceipt = await computeDbReceipt(resolveLiveDbPath(dataRoot))
        return liveDbReceiptMatchesCandidate(liveDbReceipt, candidateReceipts.db)
      } catch {
        return false
      }
    })
  let liveDbReceiptMatchesCandidateValue = false
  try {
    liveDbReceiptMatchesCandidateValue = await computeLiveDbReceiptMatch()
  } catch {
    liveDbReceiptMatchesCandidateValue = false
  }
  probeInput = { ...probeInput, liveDbReceiptMatchesCandidate: liveDbReceiptMatchesCandidateValue }

  // --- 4. Decide -----------------------------------------------------------
  const decide = primitives.decide ?? decidePromotionRecoveryV2
  let decision: PromotionRecoveryDecisionV2
  try {
    decision = decide(probeInput)
  } catch (error) {
    return fail('DECIDE_FAILED', 'IO')
  }
  logger.info(
    `v2 recovery decision: action=${decision.action}, reason=${decision.reason}, ` +
      `journal=${probeInput.journal.status}, catalogApplied=${catalogApplied}, ` +
      `liveDbReceiptMatchesCandidate=${liveDbReceiptMatchesCandidateValue}`
  )

  // --- 5. Execute by action ------------------------------------------------
  switch (decision.action) {
    case 'keep-old-live': {
      // LOCK-REC-5: keep-old-live is only legitimate at the pre-destructive
      // phases (candidates-ready / snapshots-ready with the old generation
      // intact). The journal cleanup is version-safe (v2 phase cleanup only).
      // Any ambiguous phase stays journaled (fail closed — no cleanup, no
      // success signal) rather than deleting recovery evidence.
      let journalCleaned = false
      let candidateCleaned = false
      if (probeInput.journal.status === 'valid') {
        const phase = journal.phase
        if (phase !== 'candidates-ready' && phase !== 'snapshots-ready') {
          return fail('CLEANUP_FAILED', 'KEEP_OLD_UNEXPECTED_PHASE')
        }
        // snapshots-ready: keep-old-live requires the candidate chat.db to be
        // intact — a consumed candidate is the ambiguous install window that
        // the matrix must have mapped to restore/repair. Fail closed.
        if (phase === 'snapshots-ready' && probeInput.candidate !== 'present') {
          return fail('CLEANUP_FAILED', 'KEEP_OLD_CANDIDATE_CONSUMED')
        }
        try {
          const cleanup = primitives.cleanupAtPhase ?? cleanupPromotionJournalAtV2Phase
          await cleanup(phase, identity, dataRoot)
          journalCleaned = true
        } catch (error) {
          return fail('CLEANUP_FAILED', 'IO')
        }
        // LOCK-CLEAN-1/2: the journal is durably cleaned — only now may the
        // candidate evidence be removed (safe keep-old with the old
        // generation verified intact). A removal failure is an artifact
        // residual (LOCK-CLEAN-4), never a rollback.
        candidateCleaned = await removeConvergedCandidateEvidence(identity, dataRoot, primitives)
      }
      return {
        ok: true,
        action: decision.action,
        journalCleaned,
        candidateCleaned,
        restartRequested: false,
        deferredToWindow: false
      }
    }

    case 'repair-required': {
      const markRepair =
        primitives.markRepairRequiredBeforeInit ??
        (() => {
          require('@main/services/chatDb').chatDbService.markRepairRequiredBeforeInit()
        })
      try {
        markRepair()
      } catch (error) {
        return fail('REPAIR_MARK_FAILED', 'IO')
      }
      return {
        ok: true,
        action: decision.action,
        journalCleaned: false,
        candidateCleaned: false,
        restartRequested: false,
        deferredToWindow: false
      }
    }

    case 'complete-catalog-apply': {
      if (boundary === null) {
        return {
          ok: true,
          action: decision.action,
          journalCleaned: false,
          candidateCleaned: false,
          restartRequested: false,
          deferredToWindow: true
        }
      }
      // LOCK-REC-2 ordering:
      //   pre-apply verification → (advance files-installed → catalog-pending)
      //   → apply (skip when the live catalog already matches) → re-query +
      //   verify ALL-new receipts → advance catalog-applied → advance
      //   replacement-verified → cleanup → restart.
      // The journal only advances AFTER the side effect it names completed,
      // and never overstates a completed side effect (LOCK-REC-6).

      // a. Verify live DB + Files + candidate catalog BEFORE any catalog
      //    mutation. This re-proves the decision's forward evidence at
      //    execution time — a tampered artifact here fails closed before the
      //    destructive apply.
      const verifyPreApply = primitives.verifyPreApplyGeneration ?? verifyPreApplyGeneration
      if (!(await verifyPreApply(dataRoot, journal.candidateId, candidateReceipts, sampleCount))) {
        return fail('VERIFY_FAILED', 'PRE_APPLY_GENERATION')
      }

      // b. Advance files-installed → catalog-pending when needed (the apply
      //    is now genuinely about to run).
      if (journal.phase === 'files-installed') {
        const doc: PromotionJournalV2 = { ...journal, phase: 'catalog-pending' }
        try {
          await (primitives.advance ?? advancePromotionJournalV2)(doc, 'files-installed', dataRoot)
        } catch (error) {
          return fail('JOURNAL_ADVANCE_FAILED', 'CATALOG_PENDING')
        }
      }

      // c. Candidate catalog rows + expected receipt.
      const handoff = (primitives.readHandoff ?? readCandidateCatalogHandoff)(journal.candidateId, dataRoot)
      if (handoff === null) {
        return fail('CATALOG_APPLY_FAILED', 'CANDIDATE_CATALOG_UNAVAILABLE')
      }
      const expectedCatalog = candidateReceipts.catalog
      if (expectedCatalog === null) {
        return fail('CATALOG_APPLY_FAILED', 'NO_CANDIDATE_CATALOG_RECEIPT')
      }

      // d. Apply the candidate catalog in ONE transaction, only when the live
      //    catalog does not already match the candidate receipt (LOCK-REC-2:
      //    already-matching skip — idempotent across re-entry).
      if (catalogApplied !== 'verified') {
        try {
          const applied = await boundary.applyCandidate(handoff.rows, expectedCatalog)
          if (!applied.ok) {
            return fail('CATALOG_APPLY_FAILED', applied.code)
          }
        } catch (error) {
          return fail('CATALOG_APPLY_FAILED', 'BOUNDARY_THREW')
        }
      }

      // e. Re-query + verify ALL-new receipts (db + Files + catalog) BEFORE
      //    advancing to catalog-applied (LOCK-REC-2: a re-query mismatch must
      //    never be journaled as applied).
      const verifyInstalled = primitives.verifyInstalledGeneration ?? verifyInstalledGeneration
      if (!(await verifyInstalled(dataRoot, journal.candidateId, candidateReceipts, boundary, sampleCount))) {
        return fail('VERIFY_FAILED', 'INSTALLED_GENERATION')
      }

      // f. Advance catalog-pending → catalog-applied (durable).
      const appliedDoc: PromotionJournalV2 = { ...journal, phase: 'catalog-applied' }
      try {
        await (primitives.advance ?? advancePromotionJournalV2)(appliedDoc, 'catalog-pending', dataRoot)
      } catch (error) {
        return fail('JOURNAL_ADVANCE_FAILED', 'CATALOG_APPLIED')
      }

      // g. Advance catalog-applied → replacement-verified (durable).
      const verifiedDoc: PromotionJournalV2 = { ...journal, phase: 'replacement-verified' }
      try {
        await (primitives.advance ?? advancePromotionJournalV2)(verifiedDoc, 'catalog-applied', dataRoot)
      } catch (error) {
        return fail('JOURNAL_ADVANCE_FAILED', 'REPLACEMENT_VERIFIED')
      }

      // h. Cleanup the journal + restart — only after every verification.
      return await finishAndRestart(decision.action, identity, dataRoot, primitives, options)
    }

    case 'accept-verified-replacement': {
      if (boundary === null) {
        return {
          ok: true,
          action: decision.action,
          journalCleaned: false,
          candidateCleaned: false,
          restartRequested: false,
          deferredToWindow: true
        }
      }
      // LOCK-REC-4: never trust the journal phase alone — independently
      // reverify DB + Files + catalog against the candidate receipts before
      // any journal cleanup or restart.
      const verifyInstalled = primitives.verifyInstalledGeneration ?? verifyInstalledGeneration
      if (!(await verifyInstalled(dataRoot, journal.candidateId, candidateReceipts, boundary, sampleCount))) {
        return fail('VERIFY_FAILED', 'INSTALLED_GENERATION')
      }
      return await finishAndRestart(decision.action, identity, dataRoot, primitives, options)
    }

    case 'restore-rollback-snapshot': {
      if (boundary === null) {
        return {
          ok: true,
          action: decision.action,
          journalCleaned: false,
          candidateCleaned: false,
          restartRequested: false,
          deferredToWindow: true
        }
      }
      // LOCK-REC-3: restore DB + Files + catalog as one recovery operation,
      // then cleanup the journal ONLY after convergence. Any failure leaves
      // the journal for a deterministic retry and returns no success signal.
      // The whole destructive window is guarded: lease acquisition, live-DB
      // close, proof minting, and the all-three rollback each map to a
      // bounded failure — the executor never rejects (LOCK-REC-7).
      let lease: ReturnType<typeof acquirePromotionLease> | null = null
      try {
        lease = acquirePromotionLease('recovery-v2', coordinator)
        if (options.liveDb.isInitialised() && options.liveDb.closeForPromotion) {
          const closed = options.liveDb.closeForPromotion(lease)
          if (!closed) {
            logger.warn('Failed to close the live DB for v2 rollback (proceeding — live may already be closed)')
          }
        }
        const minted = mintClosedLiveProof({
          authorization: lease,
          witness: { isLiveClosed: () => !options.liveDb.isInitialised() },
          coordinator
        })
        if (!minted.ok) {
          return fail('RESTORE_FAILED', minted.reason === 'live-not-closed' ? 'LIVE_NOT_CLOSED' : 'PROOF_MINT_FAILED')
        }
        const rollback = primitives.rollbackAll ?? rollbackAllThree
        const rollbackResult = await rollback({
          proof: minted.proof,
          dataRoot,
          catalogBoundary: boundary,
          expectedOld: oldReceipts,
          sampleCount
        })
        if (!rollbackResult.ok) {
          return fail('RESTORE_FAILED', rollbackResult.code)
        }
      } catch (error) {
        // F1 (protocol-audit correction): a lease-busy acquire in the
        // TERMINAL-HANDOFF finalization context means terminal promotion
        // ownership still holds the promotion lease — the destructive
        // rollback CANNOT run here. This is NOT restore success and NOT a
        // generic failure: the all-new generation may already be fully
        // verified and installed (journal at replacement-verified) and a
        // transient catalog query failure is the likely reason the matrix
        // chose restore. Defer to startup convergence — journal retained,
        // no rollback, no restart. Startup recovery (fresh process, free
        // lease) reverifies and accepts/cleans deterministically.
        if (isMaintenanceBusyError(error)) {
          logger.warn(
            'v2 recovery restore deferred to startup: promotion lease held by terminal ownership ' +
              '(lease-busy) — journal retained, no rollback, no restart'
          )
          return Object.freeze({
            ok: true as const,
            action: 'restore-rollback-snapshot' as const,
            journalCleaned: false as const,
            candidateCleaned: false as const,
            restartRequested: false as const,
            deferredToWindow: false as const,
            deferredToStartup: true as const,
            deferReason: 'LEASE_BUSY' as const
          })
        }
        return fail('RESTORE_FAILED', 'IO')
      } finally {
        if (lease !== null && !lease.isReleased()) {
          lease.release()
        }
      }
      // Cleanup the journal at whatever v2 phase it was at + restart — only
      // after the all-old convergence verified (LOCK-REC-3).
      return await finishAndRestart(decision.action, identity, dataRoot, primitives, options)
    }
  }
}

/**
 * Verify the installed (new) generation — db + Files + catalog — against the
 * CANDIDATE receipts exactly (LOCK-REC-2 post-apply re-query, LOCK-REC-4
 * independent reverification). Every artifact must match its journaled
 * candidate receipt; a `null` receipt field means the generation had no such
 * artifact (empty), so the live state must be empty/matching-count-zero.
 */
export async function verifyInstalledGeneration(
  dataRoot: string,
  candidateId: string,
  candidateReceipts: PromotionArtifactReceipts,
  boundary: RecoveryV2CatalogBoundary,
  sampleCount: number
): Promise<boolean> {
  // db: readonly validation through the shared probe + exact file receipt
  // (SHA-256 + byte size) vs the journaled candidate db receipt. A null
  // candidate db receipt is contradictory for a promotion (the candidate
  // generation always carries a sealed chat.db) — fail closed.
  const dbStatus = probeLiveDb(dataRoot, sampleCount).status
  if (dbStatus !== 'present-verified') return false
  if (candidateReceipts.db === null) return false
  try {
    const liveDbReceipt = await computeDbReceipt(path.join(dataRoot, 'chat.db'))
    if (!liveDbReceiptMatchesCandidate(liveDbReceipt, candidateReceipts.db)) return false
  } catch {
    return false
  }
  // files: parity vs the candidate catalog rows; the derived parity receipt
  // must equal the journaled candidate files receipt exactly.
  const filesDir = path.join(dataRoot, 'Files')
  const catalog = readAndValidateCatalog(
    path.join(dataRoot, 'chat-import-candidates', candidateId, 'files-catalog.json')
  )
  if (catalog === null) return false
  const parity = verifyFilesDirAgainstCatalog(
    filesDir,
    catalog.rows.map((row) => ({ name: row.name, size: row.size, sha256: row.sha256 }))
  )
  if (!parity.ok) return false
  if (!filesReceiptMatches(parity.receipt, candidateReceipts.files)) return false
  // catalog: facts match the candidate receipt.
  try {
    const facts = await boundary.queryFacts()
    if (!facts.ok) return false
    return factsMatch(facts.facts, candidateReceipts.catalog)
  } catch {
    return false
  }
}

/**
 * Verify the installed generation BEFORE a catalog mutation (LOCK-REC-2):
 * live DB present-verified, live Files parity present-verified, and the
 * retained candidate catalog handoff readable with an aggregate receipt that
 * exactly matches the journaled candidate catalog receipt. Because the Files
 * parity is checked against the SAME on-disk handoff whose receipt equals the
 * journal receipt, the chain transitively proves the installed Files match
 * the journaled candidate files receipt.
 */
export async function verifyPreApplyGeneration(
  dataRoot: string,
  candidateId: string,
  candidateReceipts: PromotionArtifactReceipts,
  sampleCount: number
): Promise<boolean> {
  if (probeLiveDb(dataRoot, sampleCount).status !== 'present-verified') return false
  if (probeLiveFiles(candidateId, dataRoot) !== 'present-verified') return false
  const handoff = readCandidateCatalogHandoff(candidateId, dataRoot)
  if (handoff === null) return false
  if (candidateReceipts.catalog === null) return false
  return (
    handoff.receipt.count === candidateReceipts.catalog.count &&
    handoff.receipt.sha256 === candidateReceipts.catalog.sha256
  )
}

/** Cleanup the v2 journal + remove the candidate evidence + request a restart/reload. */
async function finishAndRestart(
  action: (typeof PROMOTION_RECOVERY_ACTIONS_V2)[number],
  identity: PromotionJournalCleanupIdentity,
  dataRoot: string,
  primitives: NonNullable<RecoveryV2Options['primitives']>,
  options: RecoveryV2Options
): Promise<RecoveryV2Result> {
  // The journal phase is advanced before finish for forward actions; the
  // restore path leaves it at the crashed phase — cleanup reads disk.
  let journalPhase: PromotionJournalPhaseV2
  try {
    const result = await (primitives.readJournal ?? readPromotionJournal)(dataRoot)
    if (result.status !== 'valid' || result.journal.version !== PROMOTION_JOURNAL_VERSION_V2) {
      return fail('JOURNAL_READ_FAILED', 'NOT_V2_AFTER_ACTION')
    }
    journalPhase = result.journal.phase
  } catch (error) {
    return fail('JOURNAL_READ_FAILED', 'IO')
  }
  try {
    const cleanup = primitives.cleanupAtPhase ?? cleanupPromotionJournalAtV2Phase
    await cleanup(journalPhase, identity, dataRoot)
  } catch (error) {
    return fail('CLEANUP_FAILED', 'IO')
  }
  // LOCK-CLEAN-1: the journal is durably cleaned — ONLY now may the exact
  // candidate evidence be removed (no recovery path can need the handoff).
  const candidateCleaned = await removeConvergedCandidateEvidence(identity, dataRoot, primitives)
  return requestRestart(action, options, candidateCleaned)
}

/**
 * LOCK-CLEAN-1/2/4: remove the exact candidate evidence AFTER the v2 journal
 * was durably cleaned. A removal failure is an artifact-cleanup residual —
 * NEVER a data rollback and never a failed convergence: the journal is
 * already gone and the live generation is verified, so age-based orphan
 * cleanup remains the fallback (LOCK-CLEAN-4). Never rejects.
 */
async function removeConvergedCandidateEvidence(
  identity: PromotionJournalCleanupIdentity,
  dataRoot: string,
  primitives: NonNullable<RecoveryV2Options['primitives']>
): Promise<boolean> {
  try {
    const remove = primitives.removeConvergedCandidate ?? removeConvergedCandidate
    return await remove(identity.candidateId, dataRoot)
  } catch (error) {
    logger.warn(
      'v2 recovery converged but candidate evidence removal failed (residual — age-based cleanup remains the fallback)'
    )
    return false
  }
}

/** Request the restart/reload per restart mode. */
function requestRestart(
  action: (typeof PROMOTION_RECOVERY_ACTIONS_V2)[number],
  options: RecoveryV2Options,
  candidateCleaned: boolean
): RecoveryV2Result {
  const restart = options.restart ?? {
    mode: 'in-process-reload' as const,
    relaunch: () => ({ relaunched: false }),
    reloadRenderer: () => ({ ok: false, reloaded: false })
  }
  if (restart.mode === 'relaunch') {
    try {
      const result = restart.relaunch()
      return {
        ok: true,
        action,
        journalCleaned: true,
        candidateCleaned,
        restartRequested: result.relaunched,
        deferredToWindow: false
      }
    } catch {
      return fail('RELAUNCH_FAILED', 'IO')
    }
  }
  try {
    if (!restart.reloadRenderer) {
      return fail('RELAUNCH_FAILED', 'RELOAD_UNAVAILABLE')
    }
    const result = restart.reloadRenderer('recovery-v2')
    return {
      ok: true,
      action,
      journalCleaned: true,
      candidateCleaned,
      restartRequested: result.reloaded,
      deferredToWindow: false
    }
  } catch {
    return fail('RELAUNCH_FAILED', 'IO')
  }
}
