/**
 * ChatImport pipeline — public API.
 *
 * Orchestrates the source-reader pipeline (Phase 4.1) integrated with the
 * candidate construction plane (Phase 4.2):
 *   ZIP path → secure extract → isolated Electron session + hidden sandboxed
 *   import renderer → import-only narrow IPC → paged logical-data read →
 *   per-page transactional candidate writes → sealed candidate ready for
 *   Phase 4.3 (verification/promotion, NOT this round).
 *
 * State machine: intake → discovering → reading → candidate-ready →
 * verifying → verified-candidate | verification-failed (LOCK-4305).
 * Cancellation supported at every non-terminal state, INCLUDING
 * candidate-ready / verifying / verified-candidate (until the future
 * Phase 4.4 promotion) — cancel discards the candidate and all source
 * resources (LOCK-O5).
 *
 * Candidate lifecycle (LOCK-O1/O3/O6):
 * - The candidate initializes after successful discovery and BEFORE the
 *   first ReadPage request. The live chatDbService is never used.
 * - Every source page is awaited through dataPlane.processPage (one atomic
 *   candidate transaction per page) before the next page is requested.
 * - Last-page completion finalizes the data plane exactly once, compares
 *   source stats, sets elapsedMs, seals the candidate, transitions to
 *   candidate-ready, and emits one Main-only CandidateReadyResult.
 * - Any failure enters error, discards the candidate, disposes all isolated
 *   source resources, and resets the singleton.
 *
 * Verification lifecycle (Phase 4.3.3, LOCK-4301…4305):
 * - After the exact-once candidate-ready callback resolves, exactly one
 *   CandidateVerifier is started against the sealed candidate using the
 *   finalized manifest from the SAME data plane (LOCK-4301/4302).
 * - The session owns the AbortController, verifier instance, in-flight
 *   verification promise, and report (LOCK-4303).
 * - Verification completes exactly once (LOCK-4304): pass retains the
 *   sealed candidate in `verified-candidate`; a failing report transitions
 *   to `verification-failed`, delivers the sanitized report exactly once,
 *   then closes the verifier BEFORE discarding candidate/source resources.
 * - Cancel/failure/async dispose order: signal abort → await verifier
 *   completion/close → discard candidate → dispose source reader/workspace.
 *   The candidate is never removed while the verifier holds it.
 * - Phase 4.3 performs NO promotion, live-DB replacement, snapshot,
 *   relaunch, or shared/preload/renderer exposure (LOCK-4305).
 *
 * Promotion protocol foundations (Phase 4.4.0, LOCK-4401/4405):
 * - verified-candidate → promoting → promoted | promotion-failed.
 * - claimPromotion() is the ONLY promotion entry: it is bounded to
 *   getVerifiedCandidate() and atomically transitions to `promoting`,
 *   issuing an exact-once, non-reusable token. completePromotion() settles
 *   the terminal result exactly once against that token.
 * - Cancel is allowed only BEFORE `promoting`; once promoting, cancel is
 *   rejected without any state change or cleanup. Ordinary disposal
 *   (async dispose + sync will-quit) preserves the promoting candidate and
 *   persisted recovery assets — cleanup belongs to the promotion executor
 *   and deterministic startup recovery (see ./promotion/*).
 * - Phase 4.4.0 performs NO live/candidate/snapshot filesystem operations,
 *   no ChatDbService close/init, no rename/replace/restore, no relaunch,
 *   and no promotion IPC (LOCK-4405).
 *
 * Promotion preparation (Phase 4.4.1, LOCK-4411..4417):
 * - startPromotionPreparation() is the unique claim→prepare entry: it
 *   consumes the exact-once claim, runs the durable preparation gate
 *   (lease → rollback snapshot create/validate/publish → snapshot-ready
 *   journal), and stores the prepared handle on the session aligned with
 *   the claim token. Failure settles `promotion-failed` via the token
 *   protocol. fail/dispose/will-quit release the stored handle exactly
 *   once. The live DB stays open and authoritative (LOCK-4411); close/
 *   install/verify belong to Phase 4.4.2.
 *
 * Attachment plane (LOCK-FIX-2/7/9): after the data plane finalizes and
 * BEFORE the candidate chat.db is sealed, the attachment plane reconciles
 * the source `files` catalog rows + the committed file references against
 * the central-directory Data/Files inventory, streams catalog-matched
 * payloads into the candidate Files directory (`Files/<id><ext>`) with
 * bounded streaming + SHA-256 (two-pass ZIP access), and writes the durable
 * `files-catalog.json` handoff. All artifacts live inside the owned
 * candidate directory, so cancellation before promotion precisely cleans
 * them (candidate discard). Fatal classes reject the import atomically
 * (LOCK-FIX-3); per-payload degradations are aggregated count-only and
 * never reject (LOCK-FIX-4/5).
 *
 * A-9: Platform gate — if process.platform !== 'darwin', throw.
 * All imports route through loggerService with context 'chatDbImport'.
 */

import path from 'node:path'

import { loggerService } from '@logger'
import type { MaintenanceCoordinator } from '@main/services/chatDb/maintenanceCoordination'
import { generateL2TrashRetentionBaseline } from '@main/services/chatDb/trashRetention'
import type {
  CandidateImportStats,
  CandidateReadyResult,
  ChatImportProjectionPayload,
  DiscoveryResult,
  ImportNavigationProjection,
  ReadPageResponse,
  SourceReadStats
} from '@shared/chatImport/types'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import { type AttachmentMarkerResult, markUnavailableAttachmentBlocks } from './attachmentMarkers'
import type { AttachmentPlaneLike, AttachmentPlaneOptions, AttachmentPlaneStats } from './attachmentPlane'
import { createAttachmentPlane, FILES_CATALOG_FILENAME } from './attachmentPlane'
import { CandidateDbResource } from './candidateDb'
import { ChatImportSessionError, ChatImportUnsupportedPlatformError } from './errors'
import {
  boundImportTableLabel,
  boundRendererErrorCode,
  createImportDataPlane,
  type DataPlaneNormalizationStats,
  type SourceFileRow,
  summarizeDataPlaneFailure,
  summarizeRendererError
} from './importDataPlane'
import { registerChatImportIpc, sendCancel, sendDiscover, sendReadPage } from './importIpc'
import {
  createIsolatedReader,
  dispose as disposeSession,
  disposeSync as disposeSessionSync,
  type LoadMode
} from './isolatedSession'
import {
  buildNavigationProjection,
  encodeProjectionState,
  NAVIGATION_PROJECTION_STATE_KEY
} from './navigationProjection'
import type {
  CatalogBoundary,
  PromotionExecutionFailure,
  PromotionExecutionHandoff,
  PromotionExecutionLiveDb,
  PromotionExecutionPrimitives,
  PromotionExecutionResult,
  PromotionExecutor,
  PromotionExecutorOptions
} from './promotion/execution'
import { createPromotionExecutor } from './promotion/execution'
import type {
  CatalogSnapshotBoundary,
  ExecutingPromotionCapability,
  PreparedPromotionHandle,
  PromotionPreparationFailure,
  PromotionPreparationResult
} from './promotion/preparation'
import { preparePromotion } from './promotion/preparation'
import {
  canEnterPromoting,
  decideCandidateDisposal,
  decidePromotionCancel,
  decideWillQuit,
  isPromotionResultState,
  type PromotionResultState
} from './promotion/protocol'
import {
  createTempWorkspace,
  disposeAsync as disposeTempDirAsync,
  recoverOrphanedTempWorkspaces
} from './tempWorkspace'
import type { CandidateVerifierOptions } from './verification/candidateVerifier'
import { createCandidateVerifier } from './verification/candidateVerifier'
import type { SourceVerificationManifest } from './verification/sourceManifest'
import type { CandidateVerificationReport } from './verification/verificationContracts'
import { extractZip, type FilesInventory } from './zipIntake'

const logger = loggerService.withContext('chatDbImport')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default page size for paged reads. Exported, configurable. */
export const DEFAULT_PAGE_SIZE = 500

/** Default per-page timeout in milliseconds (R-10). */
export const DEFAULT_PAGE_TIMEOUT_MS = 120_000

/**
 * Entity table names in the order they are read during import.
 * Verified against src/renderer/src/databases/index.ts schema (v11).
 */
const IMPORT_ENTITIES = ['topics', 'message_blocks', 'topic_segments', 'files'] as const

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ImportState =
  | 'intake'
  | 'discovering'
  | 'reading'
  | 'candidate-ready'
  | 'verifying'
  | 'verified-candidate'
  | 'verification-failed'
  | 'cancelled'
  | 'error'
  // Phase 4.4.0 promotion protocol states (LOCK-4401). `promoting` means
  // candidate ownership is frozen for the promotion executor — no file has
  // been installed. `promoted` / `promotion-failed` are terminal.
  | 'promoting'
  | 'promoted'
  | 'promotion-failed'

/** States in which the sealed candidate exists on disk and is owned alive. */
const SEALED_CANDIDATE_STATES: ReadonlySet<ImportState> = new Set([
  'candidate-ready',
  'verifying',
  'verified-candidate'
])

export interface ImportSession {
  /** Unique session identifier. */
  readonly id: string
  /** Current pipeline state. */
  readonly state: ImportState
  /** Cancel the import. No-op if already in terminal state. */
  cancel(): Promise<void>
  /** Dispose all resources (temp dir, session, window, candidate). */
  dispose(): Promise<void>
}

/**
 * Narrow candidate-resource surface owned by a session. CandidateDbResource
 * satisfies this structurally; tests may inject a lightweight double
 * (LOCK-O8). Production always uses CandidateDbResource.
 */
export interface CandidateResourceLike {
  initialize(): Promise<void>
  /**
   * LOCK-FTS-3: defer the derived search projection on the
   * candidate (drop triggers → FTS table → normalized table atomically) so
   * bulk page writes pay NO per-row trigger/FTS maintenance. Called by the
   * orchestrator immediately after initialize(), before any page write.
   * Fail closed: throws on any error — the session then enters the error
   * lifecycle and discards the candidate.
   */
  deferFtsProjection(): void
  /**
   * LOCK-FTS-4/5: rebuild the deferred projection on the candidate
   * atomically and exactly once (drop-if-exists → recreate normalized
   * table/index/FTS → backfill → recreate the three sync triggers). Called
   * by the orchestrator AFTER the data plane finalizes and BEFORE the
   * navigation projection/stats/seal. Fail closed: throws on any error —
   * the session then enters the error lifecycle and discards the candidate;
   * a candidate without its rebuilt projection is never sealed.
   */
  rebuildFtsProjection(): void
  getDatabase(): unknown
  getDbPath(): string
  /**
   * Raw better-sqlite3 handle for candidate-local writes (LOCK-PROD-6:
   * navigation projection migration_state row). Production CandidateDbResource
   * always provides it; injection doubles must too.
   */
  getSqlite(): unknown
  seal(): void
  /**
   * Re-establish the sealed invariant after the readonly verifier left
   * empty WAL/SHM residue (LOCK-RS3/RS4). Must fail closed: on any failure
   * the caller enters the error/discard lifecycle and NEVER claims
   * `verified-candidate`.
   */
  reseal(): void
  discard(): Promise<void>
  discardSync(): void
}

/**
 * Narrow data-plane surface owned by a session. ChatImportDataPlane
 * satisfies this structurally; tests may inject a double (LOCK-O8).
 */
export interface ImportDataPlaneLike {
  processPage(response: ReadPageResponse): void | Promise<void>
  finalize(): { sourceReadStats: SourceReadStats; candidateImportStats: CandidateImportStats }
  /**
   * Main-only normalization accounting after a successful finalize()
   * (LOCK-OWN-1/2, LOCK-BLOCK-1/1X, LOCK-ASK-2, LOCK-SEG-1, LOCK-STAT-1).
   * All six count-only categories. The orchestrator emits exactly one
   * aggregate count-only warning from this (LOCK-LOG-1) — never per
   * message/block, never with IDs/content.
   */
  getNormalizationStats(): DataPlaneNormalizationStats
  /**
   * IndexedDB-authoritative topic facts (id + deletedAt) for the L2
   * navigation projection join (LOCK-PROD-3). Available only after a
   * successful finalize(). Main-only — never expose over IPC.
   */
  getImportedTopicFacts(): Array<{ id: string; deletedAt: string | null }>
  /**
   * LOCK-FIX-2/4/6: validated source `files` rows captured on committed
   * pages (Main-only — never expose over IPC). Only callable after a
   * successful finalize(); the attachment plane consumes them for the
   * candidate catalog handoff.
   */
  getSourceFileRows(): SourceFileRow[]
  /**
   * LOCK-FIX-6: fileId → reference multiplicity over the committed
   * candidate `file_references` projection (Main-only — never expose over
   * IPC). Only callable after a successful finalize(); the attachment plane
   * uses it to classify referenced-vs-orphan files and rebuild counts under
   * existing FileManager semantics.
   */
  getImportedFileReferenceCounts(): Array<[string, number]>
  /**
   * Finalized source verification manifest (LOCK-4301). Only callable after
   * a successful finalize(); the orchestrator uses it to start the verifier.
   */
  getSourceVerificationManifest(): SourceVerificationManifest
}

/**
 * Narrow verifier surface owned by a session (LOCK-4303). CandidateVerifier
 * satisfies this structurally; tests may inject a double (LOCK-O8).
 * Production always uses createCandidateVerifier.
 */
export interface CandidateVerifierLike {
  /** Exact-once run resolving to a sanitized report (never rejects for verification outcomes). */
  run(): Promise<CandidateVerificationReport>
  /** Idempotent close; cooperative cancellation when a run is in flight. */
  close(): void
}

/**
 * Main-only verification completion payload (LOCK-4304). Carries the
 * sanitized report plus the CandidateReadyResult identity/stats — NEVER
 * dbPath, manifests, or SQL.
 */
export interface VerificationCompletedResult {
  /** Import session identifier. */
  sessionId: string
  /** Opaque candidate identifier (not a path). */
  candidateId: string
  /** Candidate construction accounting (from the CandidateReadyResult). */
  stats: CandidateImportStats
  /** Sanitized 14-dimension verification report. */
  report: CandidateVerificationReport
}

export interface StartImportOptions {
  /**
   * Main-only callback invoked exactly once when the candidate has been
   * finalized and sealed (LOCK-O3). The result carries NO filesystem paths —
   * Main-internal consumers needing the sealed candidate location must use
   * {@link getSealedCandidate}.
   */
  onCandidateReady?: (result: CandidateReadyResult) => void | Promise<void>
  /**
   * Main-only callback invoked exactly once when verification completes
   * with a pass or fail report (LOCK-4304). Never invoked for cancelled/
   * aborted runs. Callback errors are contained: they cannot leak
   * resources, change verification state, or duplicate completion.
   * The payload carries NO filesystem paths — Main-internal consumers
   * needing the verified candidate location must use
   * {@link getVerifiedCandidate}.
   */
  onVerificationComplete?: (result: VerificationCompletedResult) => void | Promise<void>
  /**
   * Test injection (LOCK-O8): candidate resource factory. Production default
   * is `new CandidateDbResource({ sessionId })`.
   */
  candidateFactory?: (sessionId: string) => CandidateResourceLike
  /**
   * Test injection (LOCK-O8): verifier factory. Production default is
   * `createCandidateVerifier(options)` (LOCK-4302 — the existing verifier,
   * semantically unchanged).
   */
  verifierFactory?: (options: CandidateVerifierOptions) => CandidateVerifierLike
  /**
   * Test injection (LOCK-O8): data-plane factory bound to the candidate DB.
   * Production default is
   * `createImportDataPlane(candidate.getDatabase(), { l2TrashRetentionBaseline })`.
   * The second argument carries the session's exactly-once L2 trash
   * retention baseline (LOCK-TRASH-2) so the plane can inject the marker
   * into every imported soft-deleted topic.
   */
  dataPlaneFactory?: (db: unknown, options?: { l2TrashRetentionBaseline?: string }) => ImportDataPlaneLike
  /**
   * LOCK-PROD-6: persist the validated navigation projection into the
   * candidate `migration_state` (travels atomically with `chat.db`).
   * Production default writes via the raw candidate sqlite handle; tests
   * inject a double (LOCK-O8). Must throw on any failure — the import then
   * enters the error lifecycle (a candidate without its projection must
   * never seal).
   */
  projectionWriter?: (sqlite: unknown, projection: ImportNavigationProjection) => void
  /**
   * Test injection (LOCK-O8): clock used for CandidateImportStats.elapsedMs.
   * Production default is Date.now.
   */
  now?: () => number
  /**
   * LOCK-FIX-2/7/9: attachment-plane factory bound to the sealed candidate.
   * Production default is `createAttachmentPlane(options)` — it reopens the
   * source ZIP (two-pass, LOCK-FIX-7) to stream Data/Files payloads into
   * the candidate Files directory with bounded streaming + SHA-256, and
   * writes the durable `files-catalog.json` handoff. All artifacts live
   * inside the owned candidate directory, so candidate discard removes them
   * exactly (LOCK-FIX-9). Test injection (LOCK-O8) substitutes a double.
   */
  attachmentFactory?: (options: AttachmentPlaneOptions) => AttachmentPlaneLike
  /**
   * LOCK-UI-2/3/4/5/6: import-only per-block unavailable-attachment marker
   * writer. Production default is `markUnavailableAttachmentBlocks(sqlite,
   * degradedFileIds)` — it transactionally marks every imported file/image
   * block referencing a reference-degraded file BEFORE the candidate seals,
   * preserving display metadata + file_reference rows. Test injection
   * (LOCK-O8) substitutes a double. Must throw on any failure — the import
   * then enters the error lifecycle (a marker that cannot be persisted
   * rejects candidate finalization, never a silent partial seal).
   */
  attachmentMarkerWriter?: (sqlite: unknown, degradedFileIds: readonly string[]) => AttachmentMarkerResult
}

/**
 * Main-only handle to the sealed candidate of the active session. Exposes
 * the filesystem path for Phase 4.3 consumers. NEVER cross IPC with this.
 */
export interface SealedCandidateHandle {
  sessionId: string
  candidateId: string
  /** Main-internal absolute path to the sealed candidate chat.db. */
  dbPath: string
}

/**
 * Main-only handle to the verified candidate of the active session
 * (future Phase 4.4 promotion consumer). Exposes the filesystem path and
 * the retained verification report. NEVER cross IPC with this.
 */
export interface VerifiedCandidateHandle {
  sessionId: string
  candidateId: string
  /** Main-internal absolute path to the verified sealed candidate chat.db. */
  dbPath: string
  /** Sanitized verification report retained from the passing run. */
  report: CandidateVerificationReport
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let activeSession: InternalImportSession | null = null
let ipcDisposer: (() => void) | null = null

/**
 * Main-local terminal promotion ownership record (hardened 4.4.2 audit
 * correction, LOCK-4422/4425/4428). Set exactly when an execution settles
 * `promoted` (successful replacement-verified handoff) or post-install
 * recovery-required — the two terminal outcomes whose capability/lease must
 * stay owned so ordinary maintenance (public init/close/backup/restore)
 * remains blocked. This module-level record is THE logical owner even when
 * the startPromotionExecution caller drops the returned handoff; the
 * session never aliases the capability after transfer.
 *
 * Release contract: the retained lease is released ONLY by the Phase 4.4.3
 * recovery/finalization executor (through the stored handoff's capability,
 * exact-once), by the import control layer after a successful NON-PACKAGED
 * in-process reload (LOCK-FR2 — the process stays alive, so maintenance
 * ownership returns to idle for a second independent import), or implicitly
 * by process exit — never by stale session fail/dispose/will-quit cleanup.
 * This is deliberate: holding the in-memory lease until recovery (or the
 * non-packaged success cleanup) settles is the isolation guarantee, not a
 * leak.
 */
let terminalPromotionOwnership: TerminalPromotionOwnership | null = null

class InternalImportSession implements ImportSession {
  public id: string
  public state: ImportState = 'intake'
  private tempDir: string | null = null
  private disposed = false
  private ownedIpcDisposer: (() => void) | null = null

  /** Current entity index in the IMPORT_ENTITIES sequence. */
  public entityIndex = 0
  /** Accumulated source-read stats from paged reads (record counts only). */
  public sourceStats: SourceReadStats = {
    topicRecordCount: 0,
    blockRecordCount: 0,
    segmentRecordCount: 0,
    sourceFileRecordCount: 0
  }
  /** Discovery result received from renderer. */
  public discoveryResult: DiscoveryResult | null = null

  /**
   * Raw source Local Storage `persist:cherry-studio` payload reported by
   * the import renderer (LOCK-PROD-2). Main parses/validates it at
   * completion and persists the minimal navigation projection with the
   * candidate. Never echoed back over IPC.
   */
  public rawPersistedState: string | null = null

  /** Candidate DB resource — owned by this session (LOCK-O1). */
  public candidate: CandidateResourceLike | null = null
  /** Data plane bound to the candidate DB — owned by this session. */
  public dataPlane: ImportDataPlaneLike | null = null
  /**
   * LOCK-FIX-2/7/9: attachment plane bound to the candidate Files dir +
   * catalog handoff path. Owned by this session; constructed after the
   * candidate initializes. All attachment artifacts live inside the owned
   * candidate directory, so candidate discard removes them exactly.
   */
  public attachmentPlane: AttachmentPlaneLike | null = null
  /** Count-only attachment stats retained after the plane finalizes. */
  public attachmentStats: AttachmentPlaneStats | null = null
  /**
   * LOCK-FIX-8: source ZIP path retained Main-internally for the two-pass
   * payload extraction (LOCK-FIX-7). Never logged, never over IPC.
   */
  public zipPath: string | null = null
  /**
   * LOCK-FIX-2/7: central-directory Data/Files inventory from the intake
   * pass — handed to the attachment plane for the bounded extraction.
   */
  public filesInventory: FilesInventory | null = null
  /**
   * LOCK-TRASH-2: exactly one immutable L2 trash retention baseline captured
   * per import session from the injectable Main clock. Every page/topic of
   * the session shares the identical canonical UTC ISO string. A retry or
   * new L2 replace-all import is a new session and gets a new baseline.
   */
  public l2TrashRetentionBaseline: string | null = null
  /** Clock reading at candidate initialization (for elapsedMs). */
  public candidateStartedAt = 0
  /** Exact-once guard for finalize + candidate-ready emission (LOCK-O3/O4). */
  public readyEmitted = false

  // Verification ownership (LOCK-4303): the session is the unique owner of
  // the AbortController, verifier instance, in-flight promise, and report.
  /** Abort controller for the verification run. */
  public abortController: AbortController | null = null
  /** Verifier instance — exactly one per session (LOCK-4304). */
  public verifier: CandidateVerifierLike | null = null
  /** In-flight verification promise. Never rejects (settle contains all outcomes). */
  public verificationPromise: Promise<void> | null = null
  /** Retained verification report (pass AND fail — preserved for callbacks/4.4). */
  public verificationReport: CandidateVerificationReport | null = null
  /** Exact-once verification start guard (LOCK-4304). */
  public verificationStarted = false
  /** Exact-once verification completion guard (LOCK-4304). */
  public verificationCompleted = false
  /** CandidateReadyResult retained for the verification callback identity/stats. */
  public readyResult: CandidateReadyResult | null = null

  // Promotion ownership (Phase 4.4.0, LOCK-4401): exact-once claim token.
  /** Opaque non-reusable promotion token; non-null only while `promoting`. */
  public promotionToken: string | null = null
  /** Exact-once promotion claim guard: set once, never reset (LOCK-4401). */
  public promotionClaimed = false
  /** Prepared promotion handle (Phase 4.4.1). Non-null after preparation. */
  public preparedHandle: PreparedPromotionHandle | null = null
  /**
   * Executing promotion capability (Phase 4.4.2, LOCK-4421/4422). Non-null
   * only after the exact-once prepared→executing transfer; owns the SAME
   * promotion lease held since preparation. Released exactly once by the
   * fail/dispose/will-quit paths.
   */
  public executingCapability: ExecutingPromotionCapability | null = null
  /**
   * Destructive promotion executor (Phase 4.4.2). Non-null only while a
   * startPromotionExecution run is in flight. While it is unsettled the
   * executor owns finalization: release paths request abort and ownership
   * is released only after the executor quiesces (LOCK-4422/4425).
   */
  public promotionExecutor: PromotionExecutor | null = null
  /** Exact-once execution start guard: set once, never reset. */
  public promotionExecutionStarted = false

  constructor(id: string) {
    this.id = id
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** Opaque candidate identifier (Main-assigned; not a path). */
  get candidateId(): string {
    return `candidate-${this.id}`
  }

  setState(state: ImportState): void {
    this.state = state
    logger.info(`Session ${this.id} → ${state}`)
  }

  setTempDir(dir: string): void {
    this.tempDir = dir
  }

  setIpcDisposer(disposer: () => void): void {
    this.ownedIpcDisposer = disposer
  }

  private releaseIpcDisposer(): void {
    const disposer = this.ownedIpcDisposer
    if (!disposer) return
    this.ownedIpcDisposer = null
    if (ipcDisposer === disposer) {
      disposer()
      ipcDisposer = null
    }
  }

  async cancel(): Promise<void> {
    // LOCK-4401 boundary: cancel is decided by the pure promotion protocol.
    // - 'ignore-terminal'  → terminal state (incl. promoted/promotion-failed)
    // - 'reject-promoting' → promoting entered; cancel refused with NO state
    //   change and NO cleanup (the promotion executor owns the candidate)
    // - 'allow'            → the pre-promotion cancel semantics below
    const decision = decidePromotionCancel(this.state)
    if (decision === 'ignore-terminal') {
      logger.info(`Cancel ignored for session ${this.id} in state ${this.state}`)
      return
    }
    if (decision === 'reject-promoting') {
      logger.warn(`Cancel rejected for session ${this.id}: promotion in progress (LOCK-4401)`)
      return
    }

    // LOCK-O5/LOCK-4305: cancel is allowed before AND after candidate-ready,
    // INCLUDING verifying and verified-candidate (until the promotion claim).
    // It discards the candidate and all source resources. dispose() aborts
    // and closes the verifier BEFORE the candidate is discarded (LOCK-4303).
    // If a page write is in flight, the post-await state re-check in the
    // orchestrator prevents any next page or ready callback.
    this.setState('cancelled')
    sendCancel(this.id)
    await this.dispose()
  }

  /**
   * Enter the error lifecycle (LOCK-O6): mark error (unless already in a
   * terminal state), discard the candidate, dispose all isolated resources,
   * and reset the singleton. Never rejects.
   *
   * Terminal-state guard (accepted 4.3.3 audit correction): `cancelled`,
   * `error`, AND `verification-failed` are terminal. A fail() raced during
   * the verification-failed callback await must preserve
   * `verification-failed` — the sanitized failing report remains the
   * authoritative outcome (LOCK-4304); cleanup is idempotent via dispose().
   */
  async fail(context: string, error: unknown): Promise<void> {
    // LOCK-PRIV-2/4/5: when the error tree contains a data-plane rejection
    // (direct, wrapped in Error.cause, or inside AggregateError.errors), the
    // failure log carries ONLY the bounded code/table summary — its detail
    // carries source IDs (entityId, source/target IDs, paths) and must never
    // reach the session-failure log, and neither may a wrapper's raw
    // message. Error trees with no data-plane rejection keep the existing
    // stable generic-error message.
    const message = summarizeDataPlaneFailure(error)
    logger.error(`Session ${this.id} failed during ${context}: ${message}`)
    if (this.state === 'promoting') {
      // LOCK-4401: `promoting` may only leave to a terminal result state.
      // A failure during the promotion window settles `promotion-failed`
      // (consuming the token) — never `error`. dispose() below preserves
      // the promotion-owned candidate.
      this.promotionToken = null
      // Phase 4.4.1/4.4.2: release promotion ownership (prepared handle
      // dispose is stale-safe after consume; the executing capability owns
      // the lease release exactly once) on promotion failure.
      this.releasePromotionOwnership()
      this.setState('promotion-failed')
    } else if (
      this.state !== 'cancelled' &&
      this.state !== 'error' &&
      this.state !== 'verification-failed' &&
      !isPromotionResultState(this.state)
    ) {
      this.setState('error')
    }
    await this.dispose()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.releaseIpcDisposer()

    logger.info(`Disposing session ${this.id}`)

    // LOCK-4303 async order: signal abort → await verifier completion/close
    // → discard candidate → dispose source reader/workspace. The candidate
    // is NEVER removed while the verifier still holds it.
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
    if (this.verifier) {
      try {
        this.verifier.close()
      } catch (error) {
        logger.warn(`Error closing verifier for ${this.id}:`, error as Error)
      }
    }
    const inFlight = this.verificationPromise
    if (inFlight) {
      // Never rejects: settleVerification contains every outcome.
      await inFlight
      this.verificationPromise = null
    }
    this.verifier = null

    // Phase 4.4.2 (LOCK-4425): executor-owned finalization. Request abort
    // and await quiesce BEFORE any ownership release or resource teardown —
    // no async race may release the lease or discard promotion resources
    // while the executor is inside the destructive window. The executor
    // reference is deliberately NOT cleared here (accepted 4.4.2 audit
    // correction): terminal ownership settlement (release vs transfer to
    // the terminal handoff owner) belongs EXCLUSIVELY to the
    // startPromotionExecution continuation, which clears the reference.
    // Its microtask may run after this whenSettled() continuation — a
    // release here could pull a success/recovery-required lease out from
    // under the terminal handoff.
    const executor = this.promotionExecutor
    if (executor) {
      executor.requestAbort()
      await executor.whenSettled()
    }

    // Phase 4.4.1/4.4.2: release promotion ownership (prepared handle +
    // executing capability → maintenance lease). Must run before candidate
    // discard to ensure the lease is released before any further lifecycle
    // transitions. While the executor reference is still set this defers
    // to the execution continuation (see releasePromotionOwnership).
    this.releasePromotionOwnership()

    // Discard candidate (closes DB handle first, then removes the owned
    // directory). Sealed candidates are discarded too: dispose is only
    // reached via cancel/error/verification-failed/manual teardown
    // (LOCK-O5/O6, LOCK-4304). EXCEPT: once the promotion claim was made
    // (promoting/promoted/promotion-failed), the candidate belongs to the
    // promotion executor — ordinary disposal must preserve it on disk
    // (LOCK-4401; pure decision in ./promotion/protocol).
    if (this.candidate) {
      if (decideCandidateDisposal(this.state) === 'preserve') {
        logger.info(`Preserving promotion-owned candidate for session ${this.id} (state ${this.state})`)
      } else {
        try {
          await this.candidate.discard()
        } catch (error) {
          logger.warn(`Error discarding candidate for ${this.id}:`, error as Error)
        }
      }
      this.candidate = null
    }
    this.dataPlane = null

    // Dispose isolated session (window + electron session)
    try {
      await disposeSession()
    } catch (error) {
      logger.warn(`Error disposing isolated session for ${this.id}:`, error as Error)
    }

    // Dispose temp workspace
    if (this.tempDir) {
      try {
        await disposeTempDirAsync(this.tempDir)
      } catch (error) {
        logger.warn(`Error disposing temp workspace ${this.tempDir}:`, error as Error)
      }
      this.tempDir = null
    }

    if (activeSession?.id === this.id) {
      activeSession = null
    }
  }

  /**
   * Synchronous verifier close for the will-quit path (LOCK-4303): aborts
   * the run and requests handle closure immediately. Must run BEFORE the
   * candidate is discarded synchronously.
   */
  closeVerifierSync(): void {
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
    if (this.verifier) {
      try {
        this.verifier.close()
      } catch (error) {
        logger.warn(`Error closing verifier (sync) for ${this.id}:`, error as Error)
      }
      this.verifier = null
    }
  }

  /**
   * Synchronous candidate discard for the will-quit path. Preserves a
   * promotion-owned candidate (LOCK-4401): after the claim, only the
   * promotion executor / startup recovery may remove promotion artifacts.
   */
  discardCandidateSync(): void {
    if (this.candidate) {
      if (decideCandidateDisposal(this.state) === 'preserve') {
        logger.info(`Preserving promotion-owned candidate (sync) for session ${this.id} (state ${this.state})`)
      } else {
        try {
          this.candidate.discardSync()
        } catch (error) {
          logger.warn(`Error discarding candidate (sync) for ${this.id}:`, error as Error)
        }
      }
      this.candidate = null
    }
    this.dataPlane = null
  }

  /**
   * Dispose the prepared promotion handle exactly once (stale-safe after
   * consume — it never releases a transferred lease). Idempotent;
   * deduplicated helper for every release path (accepted 4.4.2 audit
   * cleanup).
   */
  private disposePreparedHandle(): void {
    if (!this.preparedHandle) return
    try {
      this.preparedHandle.dispose()
    } catch (error) {
      logger.warn(`Error disposing prepared promotion handle for ${this.id}:`, error as Error)
    }
    this.preparedHandle = null
  }

  /**
   * Explicit ownership transfer OUT of this session (accepted 4.4.2 audit
   * correction — hardened LOCK-4422/4425/4428): moves the executing
   * capability to the terminal handoff owner and clears the session field,
   * so stale session fail/dispose/will-quit cleanup can never release a
   * lease the terminal handoff still owns. Returns null when the session
   * no longer owns a capability.
   */
  takeExecutingCapability(): ExecutingPromotionCapability | null {
    const capability = this.executingCapability
    this.executingCapability = null
    return capability
  }

  /**
   * Release promotion ownership exactly once (Phase 4.4.1/4.4.2,
   * LOCK-4421/4422): dispose the prepared handle (stale-safe after
   * consume — it never releases a transferred lease) and release the
   * executing capability (the single lease-release duty after transfer).
   * Synchronous and idempotent; safe on the fail/dispose/will-quit paths.
   *
   * Executor deferral (hardened 4.4.2 audit correction): once an executor
   * was started, terminal ownership settlement — release for pre-install
   * failures vs transfer to the terminal handoff owner for success /
   * post-install recovery-required — belongs EXCLUSIVELY to the
   * startPromotionExecution continuation, which clears `promotionExecutor`
   * once settlement is decided. While that reference is set (unsettled OR
   * settled-but-not-yet-settled-by-the-continuation) this method never
   * releases the capability: releasing in the settled-pending window would
   * let a stale fail/dispose free a lease that a promoted or
   * recovery-required handoff must keep owning (LOCK-4425/4428).
   */
  releasePromotionOwnership(): void {
    const executor = this.promotionExecutor
    if (executor) {
      // Cooperative abort while the executor is inside the destructive
      // window (checked at every subphase boundary). NEVER release the
      // lease here — a released lease would let a competing maintenance
      // operation act inside the destructive window or on an unverified
      // replacement.
      if (!executor.isSettled()) {
        executor.requestAbort()
      }
      this.disposePreparedHandle()
      logger.info(
        `Promotion ownership release deferred for session ${this.id}: ` +
          'terminal settlement owned by the execution continuation (lease retained)'
      )
      return
    }
    this.disposePreparedHandle()
    if (this.executingCapability) {
      try {
        this.executingCapability.release()
      } catch (error) {
        logger.warn(`Error releasing executing promotion capability for ${this.id}:`, error as Error)
      }
      this.executingCapability = null
    }
  }

  /**
   * Idempotent sync-disposed transition (accepted 4.3.3 audit correction).
   *
   * Called by disposeActiveImport() AFTER the ordered sync cleanup
   * (verifier close → candidate discardSync → reader/session destruction,
   * LOCK-4303). From here the session accurately reports disposed and
   * dispose() can never re-enter the async resource cleanup: sync-owned
   * resources are already released, a still-settling verification promise
   * is stale by the completion guard, and the temp workspace is left to
   * startup recovery (LOCK-L3) — will-quit must not await async disposal.
   */
  markDisposedSync(): void {
    if (this.disposed) return
    this.disposed = true
    this.verificationPromise = null
    this.tempDir = null
    if (activeSession?.id === this.id) {
      activeSession = null
    }
    logger.info(`Session ${this.id} marked disposed (sync)`)
  }

  releaseIpcDisposerSync(): void {
    this.releaseIpcDisposer()
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start a new import from a Cherry Studio ZIP backup.
 *
 * A-9: Platform gate — throws ChatImportUnsupportedPlatformError on non-darwin.
 *
 * @param zipPath  Absolute path to the Cherry Studio ZIP backup.
 * @param options  Optional Main-only callback + test injection (LOCK-O8).
 * @returns The import session.
 */
export async function startImport(zipPath: string, options?: StartImportOptions): Promise<ImportSession> {
  // A-9: Platform gate
  if (process.platform !== 'darwin') {
    throw new ChatImportUnsupportedPlatformError(process.platform)
  }

  // Singleton enforcement
  if (activeSession) {
    throw new ChatImportSessionError(
      'An import is already in progress. Cancel or complete it before starting a new one.'
    )
  }

  // Production defaults (LOCK-O8): CandidateDbResource + createImportDataPlane.
  const candidateFactory = options?.candidateFactory ?? ((sessionId: string) => new CandidateDbResource({ sessionId }))
  const dataPlaneFactory =
    options?.dataPlaneFactory ??
    ((db: unknown, planeOptions?: { l2TrashRetentionBaseline?: string }) =>
      createImportDataPlane(db as BetterSQLite3Database<any>, planeOptions))
  const now = options?.now ?? Date.now

  // LOCK-PROD-6: production projection writer persists the validated
  // navigation projection into the candidate `migration_state` table. The
  // row travels atomically with `chat.db` through the promotion install.
  const writeProjection =
    options?.projectionWriter ??
    ((sqlite: unknown, projection: ImportNavigationProjection): void => {
      const raw = sqlite as { prepare(sql: string): { run(...params: unknown[]): { changes: number } } }
      const stmt = raw.prepare(`INSERT OR REPLACE INTO migration_state (key, value, updated_at) VALUES (?, ?, ?)`)
      const result = stmt.run(
        NAVIGATION_PROJECTION_STATE_KEY,
        encodeProjectionState(projection),
        new Date().toISOString()
      )
      if (result === undefined || typeof result.changes !== 'number' || result.changes !== 1) {
        throw new Error('Navigation projection write did not affect exactly one migration_state row.')
      }
    })

  // LOCK-UI-2/3/4/5/6: production attachment-marker writer persists the
  // import-only unavailable marker into every imported file/image block
  // referencing a reference-degraded file — BEFORE the candidate seals.
  // It is transactional (fail closed → rejects candidate finalization) and
  // aggregate-only (never logs/returns file/block IDs).
  const writeAttachmentMarkers =
    options?.attachmentMarkerWriter ??
    ((sqlite: unknown, degradedFileIds: readonly string[]) => markUnavailableAttachmentBlocks(sqlite, degradedFileIds))

  // Generate session ID
  const sessionId = generateSessionId()
  const session = new InternalImportSession(sessionId)

  // LOCK-TRASH-2/12: capture exactly one immutable retention baseline per
  // import session from the injectable Main clock. Separate from elapsed
  // timing (candidateStartedAt); a retry/new replace-all import is a new
  // session and therefore gets a fresh baseline. Canonical by construction
  // (LOCK-TRASH-5: generateL2TrashRetentionBaseline always satisfies the
  // strict canonical UTC ISO check).
  //
  // LOCK-TRASH-12: the baseline is captured BEFORE the session is published
  // to the active singleton. A defective injected clock — one that throws,
  // or returns NaN/Infinity/out-of-range so `new Date(...).toISOString()`
  // throws RangeError — fails here, before any session is ever visible, so
  // it can never strand `activeSession`. startImport rejects and an
  // immediate retry proceeds with a fresh session. Production one-baseline
  // semantics are unchanged (still exactly one capture per session at
  // session start).
  session.l2TrashRetentionBaseline = generateL2TrashRetentionBaseline(now)
  activeSession = session

  logger.info(`Starting import session ${sessionId} from ZIP: [redacted]`)

  try {
    // Phase 1: Intake — create temp workspace + extract ZIP
    session.setState('intake')
    const tempDir = await createTempWorkspace()
    session.setTempDir(tempDir)

    const extractResult = await extractZip(zipPath, tempDir)
    logger.info(
      `Extraction complete: ${extractResult.entryCount} entries, ` +
        `${extractResult.totalUncompressedBytes} bytes uncompressed, ` +
        `${extractResult.selectedEntryCount} selected entries, ` +
        `IndexedDB at ${extractResult.indexedDbDir}`
    )
    // LOCK-FIX-2/7/8: retain the source ZIP path and the central-directory
    // Data/Files inventory for the two-pass payload extraction. Both stay
    // Main-internal — never logged, never over IPC.
    session.zipPath = zipPath
    session.filesInventory = extractResult.filesInventory

    // LOCK-PROD-8: the origin is classified from the ZIP CENTRAL DIRECTORY
    // during selective extraction (before anything is materialized). The
    // classified origin must be the single accepted origin — a failed
    // classification rejects the ZIP before any live DB or IPC mutation.
    const origin = extractResult.origin
    const loadMode: LoadMode = origin.kind === 'dev' ? 'dev' : 'file'
    logger.info(`Origin classified: ${origin.kind} (loadMode: ${loadMode})`)

    // Phase 2: Create isolated session + load import renderer
    session.setState('discovering')

    const preloadPath = path.join(__dirname, '../preload/chat-import-preload.js')
    // Production electron-vite output preserves the renderer input's nested
    // path (out/renderer/src/windows/chatImport/chatImport.html), so the
    // HTML must be resolved relative to out/main, not out/renderer root
    // (LOCK-611). The preload is preserved at out/preload/chat-import-preload.js.
    const htmlPath = path.join(__dirname, '../renderer/src/windows/chatImport/chatImport.html')

    // Register IPC handlers with orchestration callbacks.
    // These callbacks drive the state machine in response to renderer IPC.
    if (ipcDisposer) {
      ipcDisposer()
      ipcDisposer = null
    }
    ipcDisposer = registerChatImportIpc({
      onReady: (_sid) => {
        logger.info(`Renderer ready for session ${sessionId}`)
        // Use the authoritative sessionId from the closure, not the renderer's
        // handshake value (renderer sends 'pending' before it knows the real ID).
        sendDiscover(sessionId)
      },

      onDiscover: async (sid, result: DiscoveryResult) => {
        // LOCK-PRIV-6: table names are renderer-controlled — log only the
        // aggregate count, never the individual entries.
        logger.info(
          `Discovery result for session ${sid}: native=${result.nativeVersion}, tables=${result.tableNames.length}`
        )
        if (activeSession?.id !== sid || session.state !== 'discovering') return // Store discovery result
        session.discoveryResult = result

        // LOCK-O1: initialize the independent candidate AFTER successful
        // discovery and BEFORE the first ReadPage request. The live
        // chatDbService is never touched.
        let candidate: CandidateResourceLike
        try {
          candidate = candidateFactory(sid)
          // Attach before awaiting init so cancel/dispose can discard it.
          session.candidate = candidate
          await candidate.initialize()
          // LOCK-FTS-3: defer the derived search projection
          // (drop triggers → FTS → normalized atomically) BEFORE any page
          // write so L2 bulk import does not pay per-row trigger/FTS
          // maintenance. Fail closed: an error enters the error lifecycle.
          candidate.deferFtsProjection()
          session.dataPlane = dataPlaneFactory(candidate.getDatabase(), {
            l2TrashRetentionBaseline: session.l2TrashRetentionBaseline ?? undefined
          })
          session.candidateStartedAt = now()
        } catch (error) {
          await session.fail('candidate initialization', error)
          throw toError(error)
        }

        // Re-check after await: cancel/dispose may have raced the async init.
        if (activeSession?.id !== sid || session.state !== 'discovering') {
          logger.info(`Session ${sid} no longer active after candidate init; discarding candidate`)
          try {
            await candidate.discard()
          } catch (error) {
            logger.warn(`Error discarding raced candidate for ${sid}:`, error as Error)
          }
          return
        }

        // LOCK-FIX-2/7/9: construct the attachment plane bound to the
        // candidate directory (chat.db sits at <candidateDir>/chat.db, so
        // dirname(dbPath) IS the owned candidate dir). All attachment
        // artifacts (Files/ + files-catalog.json) live inside it, so
        // candidate discard removes them exactly. Construction is pure
        // (no filesystem side effects until finalize).
        const attachmentFactory = options?.attachmentFactory ?? createAttachmentPlane
        const candidateDir = path.dirname(candidate.getDbPath())
        session.attachmentPlane = attachmentFactory({
          sessionId: sid,
          zipPath: session.zipPath as string,
          filesInventory: session.filesInventory as FilesInventory,
          candidateFilesDir: path.join(candidateDir, 'Files'),
          catalogPath: path.join(candidateDir, FILES_CATALOG_FILENAME),
          now
        })

        // Transition to reading and send first page request for the first entity
        session.setState('reading')
        session.entityIndex = 0
        sendReadPage(sid, {
          tableName: IMPORT_ENTITIES[0],
          cursor: null,
          pageSize: DEFAULT_PAGE_SIZE
        })
      },

      onProjection: (sid, payload: ChatImportProjectionPayload) => {
        // LOCK-PROD-2/6: retain the raw source Local Storage payload on the
        // session. Fire-and-forget — the projection is built and persisted
        // at candidate completion. Stale/duplicate payloads are no-ops.
        if (activeSession?.id !== sid || session.state === 'error' || session.state === 'cancelled') return
        session.rawPersistedState = payload.persist
        logger.info(
          `Local Storage projection retained for session ${sid} (persist bytes: ${payload.persist?.length ?? 0})`
        )
      },

      onReadPage: async (sid, response: ReadPageResponse) => {
        if (activeSession?.id !== sid || session.state !== 'reading') return

        // Accumulate source-read record counts based on which table was read
        const count = response.items.length
        switch (response.tableName) {
          case 'topics':
            session.sourceStats.topicRecordCount += count
            break
          case 'message_blocks':
            session.sourceStats.blockRecordCount += count
            break
          case 'topic_segments':
            session.sourceStats.segmentRecordCount += count
            break
          case 'files':
            session.sourceStats.sourceFileRecordCount += count
            break
          default:
            // Not a paged source entity — the data plane below rejects it
            // (UNKNOWN_TABLE) and the session enters the error lifecycle.
            // LOCK-PRIV-6: never interpolate the renderer-supplied table name.
            logger.warn(`Unexpected table '${boundImportTableLabel(response.tableName)}' in session ${sid}`)
            break
        }

        // LOCK-O2: transactional page write with backpressure. The existing
        // awaited transport hook now hosts dataPlane.processPage — the next
        // page is requested only after this page committed. On rejection the
        // session enters the error lifecycle (candidate discarded, singleton
        // reset — LOCK-O6) and the rethrow makes the IPC boundary ack
        // { ok: false } — no next page.
        const plane = session.dataPlane
        if (!plane) {
          const error = new Error(`No data plane for session ${sid} (page arrived before candidate init)`)
          await session.fail('page processing', error)
          throw error
        }
        try {
          await plane.processPage(response)
        } catch (error) {
          await session.fail('page write', error)
          throw toError(error)
        }

        // Re-check after await: cancel/dispose may have happened meanwhile
        // (LOCK-O5) — no next page, no completion.
        if (activeSession?.id !== sid || session.state !== 'reading') return

        if (response.hasMore) {
          // Request next page of same table
          sendReadPage(sid, {
            tableName: response.tableName,
            cursor: response.cursor,
            pageSize: DEFAULT_PAGE_SIZE
          })
        } else {
          // Move to next entity
          session.entityIndex++
          if (session.entityIndex < IMPORT_ENTITIES.length) {
            sendReadPage(sid, {
              tableName: IMPORT_ENTITIES[session.entityIndex],
              cursor: null,
              pageSize: DEFAULT_PAGE_SIZE
            })
          } else {
            // All entities exhausted — Main self-completes (authoritative,
            // LOCK-O4). Finalize + seal + candidate-ready exactly once.
            await completeCandidate(session, options, now, writeProjection, writeAttachmentMarkers)
          }
        }
      },

      onComplete: (sid, stats: SourceReadStats) => {
        // LOCK-O4: Main page progression is authoritative and self-completes
        // above. The renderer-sent `complete` payload is informational only —
        // it can NEVER trigger a second finalization or duplicate ready
        // callback. Duplicate/late completes are safely ignored.
        if (activeSession?.id !== sid) return
        logger.info(`Renderer reported complete for session ${sid} (informational): ${JSON.stringify(stats)}`)
      },

      onError: async (sid, error) => {
        // LOCK-PRIV-6: renderer-reported code/message are never interpolated —
        // only the allowlisted code family plus static text is logged, and the
        // error lifecycle receives a static bounded reason.
        logger.error(`Import error for session ${sid}: ${summarizeRendererError(error)}`)
        if (activeSession?.id !== sid) return
        // LOCK-O6: renderer-reported failure enters the error lifecycle —
        // candidate discarded, isolated resources disposed, singleton reset.
        await session.fail(
          `renderer error [${boundRendererErrorCode(error.code)}]`,
          new Error('renderer-reported failure')
        )
      }
    })
    session.setIpcDisposer(ipcDisposer)

    // Create isolated reader — workspaceRoot is the temp dir (PARENT of IndexedDB/).
    // Chromium stores IDB at <sessionRoot>/IndexedDB/.
    await createIsolatedReader({
      sessionId,
      workspaceRoot: extractResult.destDir,
      htmlPath,
      preloadPath,
      loadMode,
      onReady: (sid) => {
        logger.info(`Isolated reader window loaded for session ${sid}`)
      },
      onDiscover: (_sid) => {
        /* unused — handled by IPC callbacks above */
      },
      onReadPage: (_sid, _tableName, _cursor, _pageSize) => {
        /* unused */
      },
      onComplete: (_sid) => {
        /* unused */
      },
      onError: (sid, error) => {
        // LOCK-PRIV-6: bounded code family + static text only — the message
        // (even a Main-constructed one) never crosses the log boundary here.
        logger.error(`Isolated reader error for session ${sid}: ${summarizeRendererError(error)}`)
        if (activeSession?.id === sid) {
          // Contained: fail() never rejects (LOCK-O6 — no unhandled rejection).
          void session.fail(
            `isolated reader error [${boundRendererErrorCode(error.code)}]`,
            new Error('renderer-reported failure')
          )
        }
      },
      onCancel: (_sid) => {
        /* unused — cancel is driven by session.cancel() */
      }
    })

    return session
  } catch (error) {
    logger.error(`Import failed for session ${sessionId}:`, error as Error)
    session.setState('error')

    // Release the active IPC disposer if one was registered before the
    // failure (e.g. createIsolatedReader or loadURL threw after IPC
    // registration). Without this, the ChatImport IPC handlers would
    // remain registered on the next startImport call — the re-registration
    // guard in registerChatImportIpc would dispose the stale handlers, but
    // only if registerChatImportIpc is called again; a plain cancel or
    // disposeActiveImport would not clean them up.
    await session.dispose()
    throw error
  }
}

/**
 * Cancel an active import by session ID.
 */
export async function cancelImport(sessionId: string): Promise<void> {
  if (!activeSession || activeSession.id !== sessionId) {
    logger.warn(`No active import session found with id ${sessionId}`)
    return
  }
  await activeSession.cancel()
}

/**
 * Get the currently active import session, or null.
 */
export function getActiveImport(): ImportSession | null {
  return activeSession
}

/**
 * Main-only accessor for the sealed candidate of the active session
 * (Phase 4.3 consumer). Returns null unless the session holds a live sealed
 * candidate (candidate-ready, verifying, or verified-candidate).
 * The filesystem path stays Main-internal — never send it over IPC.
 */
export function getSealedCandidate(): SealedCandidateHandle | null {
  if (!activeSession || !SEALED_CANDIDATE_STATES.has(activeSession.state) || !activeSession.candidate) {
    return null
  }
  return {
    sessionId: activeSession.id,
    candidateId: activeSession.candidateId,
    dbPath: activeSession.candidate.getDbPath()
  }
}

/**
 * Main-only accessor for the verified candidate + retained report of the
 * active session (future Phase 4.4 promotion consumer). Returns null unless
 * the session is in `verified-candidate`. The filesystem path stays
 * Main-internal — never send it over IPC.
 */
export function getVerifiedCandidate(): VerifiedCandidateHandle | null {
  if (
    !activeSession ||
    activeSession.state !== 'verified-candidate' ||
    !activeSession.candidate ||
    !activeSession.verificationReport
  ) {
    return null
  }
  return {
    sessionId: activeSession.id,
    candidateId: activeSession.candidateId,
    dbPath: activeSession.candidate.getDbPath(),
    report: activeSession.verificationReport
  }
}

/**
 * Main-only exact-once promotion claim handle (Phase 4.4.0, LOCK-4401).
 * Extends the verified-candidate handle with the opaque non-reusable token
 * required by {@link completePromotion}. NEVER cross IPC with this.
 */
export interface PromotionClaimHandle extends VerifiedCandidateHandle {
  /** Opaque exact-once promotion token (not a path, Main-internal). */
  token: string
}

/**
 * Atomically claim the verified candidate for promotion (LOCK-4401).
 *
 * This is the ONLY promotion entry. It is bounded to
 * {@link getVerifiedCandidate}: the claim succeeds exactly when that
 * accessor yields a handle, transitions `verified-candidate → promoting`
 * synchronously (no interleaving window), and issues a non-reusable token.
 * Every later call returns null — the state has left `verified-candidate`
 * and the per-session claim guard never resets.
 *
 * Phase 4.4.0: claiming performs NO filesystem/DB side effects (LOCK-4405);
 * it only freezes candidate ownership for the future promotion executor.
 */
export function claimPromotion(): PromotionClaimHandle | null {
  const handle = getVerifiedCandidate()
  if (!handle || !activeSession || activeSession.id !== handle.sessionId) {
    return null
  }
  const session = activeSession
  // Exact-once (LOCK-4401): the pure entry guard plus the never-reset
  // claim flag. Both hold on the same synchronous frame — no await between
  // the read and the transition.
  if (!canEnterPromoting(session.state) || session.promotionClaimed) {
    return null
  }
  session.promotionClaimed = true
  session.promotionToken = generatePromotionToken()
  session.setState('promoting')
  return { ...handle, token: session.promotionToken }
}

/**
 * Settle the promotion result exactly once (LOCK-4401).
 *
 * Only the active session in `promoting` with the exact issued token may
 * settle, and only to a terminal result state. The token is consumed —
 * a second call (any token) returns false. Pure state transition: no
 * filesystem/DB side effects in Phase 4.4.0 (LOCK-4405).
 */
export function completePromotion(token: string, outcome: PromotionResultState): boolean {
  if (!isPromotionResultState(outcome)) {
    return false
  }
  const session = activeSession
  if (!session || session.state !== 'promoting') {
    return false
  }
  if (session.promotionToken === null || session.promotionToken !== token) {
    return false
  }
  session.promotionToken = null
  session.setState(outcome)
  return true
}

/**
 * Dispose the active import session (sync, for will-quit).
 *
 * LOCK-4303 sync order: request verifier close synchronously (closing the
 * current better-sqlite3 handle) → candidate discardSync → reader/session
 * disposal → IPC cleanup. The candidate is never removed while the
 * verifier holds it.
 *
 * Promotion boundary (LOCK-4401): when the session is promotion-owned
 * (promoting/promoted/promotion-failed), the pure will-quit decision
 * preserves the candidate and persisted recovery assets — only
 * non-promotion resources (verifier/reader/IPC) are torn down. Startup
 * recovery then decides deterministically (LOCK-4406).
 */
export function disposeActiveImport(): void {
  if (!activeSession) return

  const session = activeSession
  activeSession = null

  const willQuitDecision = decideWillQuit(session.state)
  if (willQuitDecision === 'preserve-promotion-artifacts') {
    logger.info(`will-quit during promotion for session ${session.id}: preserving promotion artifacts (LOCK-4401)`)
  }

  // 0. Release promotion ownership (prepared handle + executing capability
  //    → maintenance lease). Must be synchronous and idempotent. The foreign
  //    lease holder is NOT touched (owner-safe release only). Terminal
  //    ownership already transferred to a promoted / recovery-required
  //    handoff is NOT released here (the handoff retains the lease until
  //    Phase 4.4.3 or process exit); an unsettled executor defers release
  //    to the execution continuation.
  session.releasePromotionOwnership()

  // 1. Verifier close (abort + immediate handle closure).
  session.closeVerifierSync()

  // 2. Sync candidate discard (closes handle + removes owned directory).
  // discardCandidateSync() itself preserves a promotion-owned candidate.
  session.discardCandidateSync()

  // 3. Sync window/session destruction.
  disposeSessionSync()

  // 4. The session now accurately reports disposed and never re-enters
  // async resource cleanup (accepted 4.3.3 audit correction).
  session.markDisposedSync()

  // 5. Dispose IPC.
  session.releaseIpcDisposerSync()

  logger.info(`Disposed active import session ${session.id} (sync)`)
}

/**
 * Recover orphaned temp workspaces. Called on app-ready.
 */
export { recoverOrphanedTempWorkspaces }

/**
 * Recover orphaned import artifacts (temp workspaces + candidate dirs).
 * Called once on app-ready; never throws (LOCK-L3).
 */
export { recoverOrphanedImportArtifacts } from './startupRecovery'

/**
 * Register import IPC handlers. Called once at app-ready.
 */
export { registerChatImportIpc }

/**
 * Promotion preparation API (Phase 4.4.1, LOCK-4411..4417).
 */
export type {
  CatalogSnapshotBoundary,
  ExecutingPromotionCapability,
  PreparedPromotionConsumeResult,
  PreparedPromotionHandle,
  PromotionPreparationFailure,
  PromotionPreparationFailureCode,
  PromotionPreparationPhase,
  PromotionPreparationResult
} from './promotion/preparation'

/**
 * Promotion relaunch API (Phase 4.4.3, LOCK-4438).
 */
export type { RelaunchApp, RelaunchReceipt, RelaunchResult } from './promotion/relaunch'
export { isRelaunchReceipt, mintRelaunchReceipt, relaunchApp, resetRelaunchGuardForTests } from './promotion/relaunch'

/**
 * Promotion recovery executor API (Phase 4.4.3, LOCK-4431..4439).
 */
export type {
  RecoveryActionResult,
  RecoveryAuthorization,
  RecoveryExecutionLiveDb,
  RecoveryExecutionPrimitives,
  RecoveryExecutor,
  RecoveryExecutorFailure,
  RecoveryExecutorFailureCode,
  RecoveryExecutorOptions,
  RecoveryExecutorResult,
  RecoveryExecutorSubphase
} from './promotion/recoveryExecutor'
export { createRecoveryExecutor, RECOVERY_EXECUTOR_SUBPHASES } from './promotion/recoveryExecutor'

/**
 * Startup recovery gate API (Phase 4.4.3, LOCK-4431..4439).
 */
export type { StartupRecoveryGateResult } from './promotion/gate'
export { runStartupRecoveryGate } from './promotion/gate'

/**
 * Main-local inputs for {@link startPromotionPreparation}. The live-DB
 * specifics stay caller-supplied (Main-internal): nothing here ever crosses
 * IPC, and this module never constructs/looks up the live chatDbService
 * itself (LOCK-O1 isolation sentinel stays intact).
 */
export interface StartPromotionPreparationOptions {
  /** Directory containing the live chat.db (the Data root). */
  dbDir: string
  /** Returns the OPEN live better-sqlite3 handle (borrowed, never closed). */
  getLiveSqlite: () => unknown
  /** Optional coordinator override (default: shared coordinator). */
  coordinator?: MaintenanceCoordinator
  /**
   * LOCK-PROMO-3: catalog snapshot boundary used to capture the LIVE Dexie
   * files catalog before any mutation. Production wraps the registered
   * main renderer catalog boundary; tests inject a double.
   */
  catalogBoundary?: CatalogSnapshotBoundary
  /**
   * Test injection (LOCK-O8): preparation function. Production default is
   * the promotion preparation gate (`preparePromotion`).
   */
  prepare?: (
    claim: PromotionClaimHandle,
    dbDir: string,
    getLiveSqlite: () => unknown,
    options?: {
      coordinator?: MaintenanceCoordinator
      catalogBoundary?: CatalogSnapshotBoundary
      /**
       * LOCK-ORCH-1/LOCK-PREP-4: cooperative cancellation probe wired from
       * the session. When it returns true at a preparation await boundary
       * (raced cancel/fail/dispose/will-quit), the gate settles a bounded
       * CANCELLED failure — the lease is released and any already-written
       * journal stays at the safe `candidates-ready` phase.
       */
      shouldAbort?: () => boolean
    }
  ) => Promise<PromotionPreparationResult>
}

/**
 * Main-local outcome of {@link startPromotionPreparation}. Never crosses
 * IPC. `not-claimable` covers both "no verified candidate" and every
 * duplicate call (the exact-once claim guard never resets), so duplicate
 * calls can never re-snapshot. `stale-claim` means preparation succeeded
 * but the session left `promoting` during the await (raced failure /
 * will-quit); the prepared handle was disposed (lease released) and the
 * durable artifacts are left to startup recovery.
 */
export type PromotionPreparationStartOutcome =
  | { readonly status: 'prepared'; readonly handle: PreparedPromotionHandle }
  | { readonly status: 'not-claimable' }
  | { readonly status: 'stale-claim' }
  | { readonly status: 'preparation-failed'; readonly failure: PromotionPreparationFailure }

/**
 * The unique import-service promotion preparation entry (Phase 4.4.1,
 * LOCK-4411..4417): claim → prepare, exactly once.
 *
 * - Claims the verified candidate through {@link claimPromotion} (the ONLY
 *   promotion entry, LOCK-4401). When the claim is refused — no verified
 *   candidate, or any duplicate call — no preparation side effect runs.
 * - Runs the exact-once preparation gate (lease → snapshot create/validate/
 *   publish → snapshot-ready journal, LOCK-4412/4416/4417) against the
 *   claim, aligned with the issued token.
 * - Success stores the prepared handle on the session
 *   (`session.preparedHandle`); the session stays `promoting` and the
 *   fail/dispose/will-quit paths release the handle (lease) exactly once.
 * - Failure settles `promotion-failed` through the existing exact-once
 *   token protocol ({@link completePromotion}); the preparation gate has
 *   already released the lease.
 *
 * Phase boundary: NO close/install/verify/relaunch here (Phase 4.4.2); the
 * live DB stays open and authoritative on every outcome (LOCK-4411).
 */
export async function startPromotionPreparation(
  options: StartPromotionPreparationOptions
): Promise<PromotionPreparationStartOutcome> {
  const prepare = options.prepare ?? preparePromotion

  // Exact-once entry: bounded to claimPromotion. Duplicate calls (and calls
  // outside verified-candidate) are refused here, BEFORE any side effect.
  const claim = claimPromotion()
  if (!claim) {
    return { status: 'not-claimable' }
  }
  const session = activeSession
  if (!session || session.id !== claim.sessionId) {
    // Defensive: the claim transitions on the same synchronous frame, so
    // this cannot happen; refuse without side effects if it ever does.
    return { status: 'not-claimable' }
  }

  // LOCK-ORCH-1/LOCK-PREP-4: the session is the single cancellation source.
  // The probe fires at every preparation await boundary once the session was
  // cancelled/disposed/superseded — the gate then settles a bounded CANCELLED
  // failure (lease released, journal left at the safe candidates-ready phase)
  // instead of continuing to create snapshots for a session that no longer
  // owns the claim.
  const shouldAbort = (): boolean =>
    session.state === 'cancelled' || session.isDisposed || activeSession?.id !== session.id

  const result = await prepare(
    claim,
    options.dbDir,
    options.getLiveSqlite,
    options.coordinator !== undefined || options.catalogBoundary !== undefined
      ? { coordinator: options.coordinator, catalogBoundary: options.catalogBoundary, shouldAbort }
      : { shouldAbort }
  )

  if (!result.ok) {
    // Exact-once terminal settle via the existing token/state protocol.
    // The preparation gate already released the maintenance lease
    // (LOCK-4416); a raced settle (fail()/will-quit) makes this a no-op.
    completePromotion(claim.token, 'promotion-failed')
    return { status: 'preparation-failed', failure: result.failure }
  }

  // Re-check after the await: a raced failure or will-quit may have settled
  // the token / left `promoting`. The stale handle must not be stored — the
  // owner already ran its release path — so dispose it here (idempotent,
  // owner-safe lease release).
  if (activeSession?.id !== session.id || session.state !== 'promoting' || session.promotionToken !== claim.token) {
    try {
      result.handle.dispose()
    } catch (error) {
      logger.warn(`Error disposing stale prepared promotion handle for ${session.id}:`, error as Error)
    }
    return { status: 'stale-claim' }
  }

  // Exact-once handle ownership: the session retains the prepared handle
  // for Phase 4.4.2 and for the fail/dispose/will-quit release paths.
  session.preparedHandle = result.handle
  return { status: 'prepared', handle: result.handle }
}

/**
 * Main-local outcome of {@link transferPromotionExecution}. Never crosses
 * IPC. `not-transferable` covers every session-currency refusal: no active
 * session, session not `promoting`, no prepared handle, token misalignment,
 * or a disposed (stale) handle. `already-consumed` is the exact-once
 * refusal for duplicate transfer attempts.
 */
export type PromotionExecutionTransferOutcome =
  | { readonly status: 'transferred'; readonly capability: ExecutingPromotionCapability }
  | { readonly status: 'already-consumed' }
  | { readonly status: 'not-transferable' }

/**
 * Exact-once prepared→executing capability transfer (Phase 4.4.2,
 * LOCK-4421/LOCK-4422).
 *
 * Only the CURRENT active session's unconsumed prepared handle — aligned
 * with the live promotion token while the session is `promoting` — may
 * yield the destructive executing capability, exactly once. Stale handles
 * (disposed, superseded session, settled token) and duplicate calls are
 * refused with no side effect.
 *
 * The returned capability retains the SAME promotion lease held since
 * preparation (no release/reacquire, no second mutex) and is stored on the
 * session as the INTERIM owner: while no execution has settled, the
 * fail/dispose/will-quit paths release it exactly once. Once an execution
 * settles, terminal ownership is decided by the startPromotionExecution
 * continuation — a settled success or post-install recovery-required
 * outcome TRANSFERS the capability to the terminal handoff owner (see
 * {@link TerminalPromotionOwnership}); pre-install failures release it.
 * The capability object is never duplicated: exactly one owner at a time
 * (session → executor window → terminal handoff | released).
 *
 * Phase boundary: this transfers authority only — NO candidate install,
 * journal advancement, replacement verification, or relaunch here.
 */
export function transferPromotionExecution(): PromotionExecutionTransferOutcome {
  const session = activeSession
  // Session currency (LOCK-4421): only the current active session in
  // `promoting` with a live token may transfer.
  if (!session || session.state !== 'promoting' || session.promotionToken === null) {
    return { status: 'not-transferable' }
  }
  const handle = session.preparedHandle
  if (!handle || handle.token !== session.promotionToken) {
    return { status: 'not-transferable' }
  }

  const result = handle.consume()
  if (!result.ok) {
    return result.reason === 'already-consumed' ? { status: 'already-consumed' } : { status: 'not-transferable' }
  }

  // Exact-once capability ownership: the session retains the executing
  // capability; releasePromotionOwnership() releases the lease exactly once.
  session.executingCapability = result.capability
  logger.info(`Promotion execution capability transferred for session ${session.id} (LOCK-4421)`)
  return { status: 'transferred', capability: result.capability }
}

/**
 * Destructive promotion execution API (Phase 4.4.2, LOCK-4421..4428).
 */
export type {
  CatalogBoundary,
  PromotionExecutionClassification,
  PromotionExecutionFailure,
  PromotionExecutionFailureCode,
  PromotionExecutionHandoff,
  PromotionExecutionLiveDb,
  PromotionExecutionLiveDisposition,
  PromotionExecutionPrimitives,
  PromotionExecutionResult,
  PromotionExecutionSubphase,
  PromotionExecutor,
  PromotionExecutorOptions
} from './promotion/execution'
export { createPromotionExecutor } from './promotion/execution'

/**
 * Main-local inputs for {@link startPromotionExecution}. The live-DB
 * surface stays caller-supplied (Main-internal): this module never
 * constructs/looks up the live chatDbService itself (LOCK-O1 isolation
 * sentinel stays intact) and nothing here ever crosses IPC.
 */
export interface StartPromotionExecutionOptions {
  /** Controlled Data root containing the live chat.db. */
  dataRoot: string
  /** Live ChatDbService surface (promotion-owned lifecycle only). */
  liveDb: PromotionExecutionLiveDb
  /** Optional coordinator override (default: shared coordinator). */
  coordinator?: MaintenanceCoordinator
  /**
   * LOCK-PROMO-5: catalog boundary for the single Dexie transaction
   * replace-all and the post-install catalog facts query. Production wraps
   * the registered main renderer catalog boundary.
   */
  catalogBoundary?: CatalogBoundary
  /**
   * Test injection (LOCK-O8): executor factory. Production default is
   * {@link createPromotionExecutor}.
   */
  executorFactory?: (options: PromotionExecutorOptions) => PromotionExecutor
  /** Test injection (LOCK-O8): primitive overrides passed to the executor. */
  primitives?: Partial<PromotionExecutionPrimitives>
}

/**
 * Main-local post-install recovery-required handoff (hardened 4.4.2 audit
 * correction, LOCK-4425). Produced exactly when the executor settled a
 * post-install failure: the atomic rename already happened, every artifact
 * is retained, and deterministic startup recovery (Phase 4.4.3) owns every
 * further decision. The handoff DELIBERATELY still owns the executing
 * capability (the same continuously held lease): releasing it would let
 * ordinary maintenance (public init/close/backup/restore) open or mutate
 * the unverified installed replacement before Phase 4.4.3 or process exit.
 * NEVER cross IPC with this.
 */
export interface PromotionRecoveryRequiredHandoff {
  readonly sessionId: string
  readonly candidateId: string
  /** Exact-once claim token this execution settled against. */
  readonly token: string
  /** The structured post-install failure (recoveryRequired === true). */
  readonly failure: PromotionExecutionFailure
  /** The still-owned executing capability (same lease, LOCK-4422). */
  readonly capability: ExecutingPromotionCapability
}

/**
 * The single logical owner of a terminally retained promotion capability
 * (hardened 4.4.2 audit correction). Exactly one of:
 * - `promoted`          — successful replacement-verified handoff
 *                         (LOCK-4428 boundary).
 * - `recovery-required` — post-install failure handoff (LOCK-4425
 *                         strengthened invariant: maintenance isolation is
 *                         retained until Phase 4.4.3 or process exit).
 */
export type TerminalPromotionOwnership =
  | { readonly kind: 'promoted'; readonly handoff: PromotionExecutionHandoff }
  | { readonly kind: 'recovery-required'; readonly handoff: PromotionRecoveryRequiredHandoff }

/**
 * Main-local peek at the terminal promotion ownership record (never crosses
 * IPC). Null until an execution settles promoted or post-install
 * recovery-required. The Phase 4.4.3 recovery executor and the import
 * control layer's cleanupSessionOwnership() are the consumers
 * (LOCK-FR2/6018); nothing else may release it.
 */
export function getTerminalPromotionOwnership(): TerminalPromotionOwnership | null {
  return terminalPromotionOwnership
}

/**
 * Test-only: drop the terminal ownership record so each test starts clean.
 * Deliberately does NOT release the retained lease (release stays
 * exact-once through the stored handoff's capability — the production
 * contract is Phase 4.4.3, the import control layer's non-packaged
 * success cleanup, or process exit). Never call from production.
 */
export function resetTerminalPromotionOwnershipForTests(): void {
  terminalPromotionOwnership = null
}

/**
 * Result of {@link takeTerminalPromotionOwnership}. Never crosses IPC.
 *
 * `taken` — the terminal ownership record was atomically returned and
 *   cleared. The caller now owns the retained capability/lease and is
 *   responsible for its lifecycle until process exit or explicit release.
 * `not-available` — no terminal ownership record exists (double take,
 *   stale session, or no promotion has settled).
 * `not-consumable` — a terminal ownership record exists but is guarded:
 *   the caller attempted to overwrite an unconsumed record. This is a
 *   production-safety guard (LOCK-4433): a new terminal assignment must
 *   not silently replace an owned handoff. The caller must release or
 *   explicitly discard the existing handoff before a new one can be taken.
 */
export type TakeTerminalOwnershipOutcome =
  | { readonly status: 'taken'; readonly ownership: TerminalPromotionOwnership }
  | { readonly status: 'not-available' }
  | { readonly status: 'not-consumable' }

/**
 * Atomically take the terminal promotion ownership record (LOCK-4433).
 *
 * Returns the current record and clears module state in one synchronous
 * operation. The caller becomes the sole owner of the retained
 * capability/lease — the lease remains owned until the caller explicitly
 * releases it or the process exits. Taking does NOT release; the taken
 * capability stays owned by the caller.
 *
 * Exact-once semantics:
 * - First caller after a terminal settlement gets the record (`taken`).
 * - Subsequent callers get `not-available` (double-take protection).
 * - The peek function {@link getTerminalPromotionOwnership} is
 *   unaffected — it remains diagnostic and never consumes.
 *
 * Production-safety guard (LOCK-4433):
 * - If a terminal ownership record already exists and has NOT been taken,
 *   a new assignment via {@link setTerminalPromotionOwnership} is refused
 *   with a structured error. This prevents a second promotion settlement
 *   from silently replacing an owned handoff.
 *
 * Consumers: the Phase 4.4.3 recovery executor (to take over the retained
 * capability) and the import control layer via cleanupSessionOwnership()
 * on non-exiting or non-packaged paths (LOCK-FR2/6018).
 */
export function takeTerminalPromotionOwnership(): TakeTerminalOwnershipOutcome {
  const current = terminalPromotionOwnership
  if (current === null) {
    return { status: 'not-available' }
  }
  // Atomic take-and-clear: the caller now owns the record.
  terminalPromotionOwnership = null
  logger.info(`Terminal promotion ownership taken (kind: ${current.kind})`)
  return { status: 'taken', ownership: current }
}

/**
 * Result of {@link takeTerminalPromotionOwnershipIfMatches}. Never crosses IPC.
 *
 * `taken` — the terminal ownership record matched the expected identity token
 *   and was atomically returned and cleared. The caller now owns the retained
 *   capability/lease.
 * `not-available` — no terminal ownership record exists (already consumed,
 *   no promotion has settled).
 * `mismatch` — a terminal ownership record exists but its identity does not
 *   match the expected token. The record is NOT consumed (LOCK-6015): this
 *   prevents a stale continuation from consuming a newer session's ownership.
 */
export type TakeIfMatchesTerminalOwnershipOutcome =
  | { readonly status: 'taken'; readonly ownership: TerminalPromotionOwnership }
  | { readonly status: 'not-available' }
  | { readonly status: 'mismatch' }

/**
 * Atomically take the terminal promotion ownership record ONLY if it matches
 * the given identity token (LOCK-6015/6018). Used by stale recovery settlement
 * to ensure a stale continuation never consumes a newer session's ownership.
 *
 * Identity is compared by the handoff's `token` field — the exact-once claim
 * token from the originating execution. This is the narrowest identity check:
 * the token is unique per execution and never reused across sessions.
 *
 * Exact-once semantics (same as {@link takeTerminalPromotionOwnership}):
 * - Match + take: the record is cleared; caller owns the capability.
 * - No record: returns `not-available` (already consumed by recovery or
 *   no promotion has settled).
 * - Mismatch: returns `mismatch`; the record is untouched. The caller must
 *   NOT release or mutate the record — it belongs to a different session.
 *
 * @param expectedToken - The originating handoff's token to match against.
 */
export function takeTerminalPromotionOwnershipIfMatches(expectedToken: string): TakeIfMatchesTerminalOwnershipOutcome {
  const current = terminalPromotionOwnership
  if (current === null) {
    return { status: 'not-available' }
  }
  // Identity check: the handoff's token must match the expected origin.
  if (current.handoff.token !== expectedToken) {
    logger.warn(
      `Terminal promotion ownership identity mismatch: expected token ${expectedToken}, ` +
        `found ${current.handoff.token} (kind: ${current.kind}) — refusing take (LOCK-6015)`
    )
    return { status: 'mismatch' }
  }
  // Atomic take-and-clear: the caller now owns the record.
  terminalPromotionOwnership = null
  logger.info(`Terminal promotion ownership taken (kind: ${current.kind}, identity-matched)`)
  return { status: 'taken', ownership: current }
}

/**
 * Internal: set the terminal promotion ownership record. Refuses to
 * overwrite an unconsumed record (production-safety guard, LOCK-4433).
 *
 * Called by {@link startPromotionExecution} when an execution settles
 * `promoted` or post-install `recovery-required`. A second terminal
 * settlement while the first is still owned (not taken) is a production
 * invariant violation — the caller must handle this as a structured error.
 *
 * @throws Error when an unconsumed record already exists.
 * @internal Never called from outside this module.
 */
function setTerminalPromotionOwnership(ownership: TerminalPromotionOwnership): void {
  if (terminalPromotionOwnership !== null) {
    // Production-safety guard: refuse to overwrite an unconsumed record.
    // The existing handoff is still owned — a new assignment would silently
    // release or replace the retained capability, opening a maintenance
    // isolation window (LOCK-4433).
    throw new Error(
      `Cannot set terminal promotion ownership: a ${terminalPromotionOwnership.kind} record already exists and has not been taken. ` +
        'Call takeTerminalPromotionOwnership() first to consume the existing record before a new settlement.'
    )
  }
  terminalPromotionOwnership = Object.freeze(ownership)
  logger.info(`Terminal promotion ownership set (kind: ${ownership.kind})`)
}

/**
 * Main-local outcome of {@link startPromotionExecution}. Never crosses IPC.
 * - `promoted`         — durable replacement-verified reached; the session
 *                        settled `promoted`; capability ownership was
 *                        TRANSFERRED to the handoff (LOCK-4428 boundary) —
 *                        stale session cleanup can never release it.
 * - `promotion-failed` — the executor settled a structured failure; the
 *                        session settled `promotion-failed` (a raced owner
 *                        settle keeps that terminal state). Pre-install:
 *                        ownership released after quiesce. Post-install:
 *                        `recoveryHandoff` retains the capability/lease so
 *                        ordinary maintenance stays blocked until Phase
 *                        4.4.3 or process exit (LOCK-4425).
 * - `stale-settle`     — the executor succeeded but the session had already
 *                        settled/superseded during the await (raced failure /
 *                        will-quit). Durable artifacts are left to startup
 *                        recovery; ownership was released after quiesce.
 * - `already-started`  — exact-once refusal for repeated/concurrent starts.
 * - `not-executable`   — no active promoting session with a prepared handle.
 */
export type PromotionExecutionStartOutcome =
  | { readonly status: 'promoted'; readonly handoff: PromotionExecutionHandoff }
  | {
      readonly status: 'promotion-failed'
      readonly failure: PromotionExecutionFailure
      /** Non-null exactly for post-install recovery-required failures. */
      readonly recoveryHandoff: PromotionRecoveryRequiredHandoff | null
    }
  | { readonly status: 'stale-settle'; readonly result: PromotionExecutionResult }
  | { readonly status: 'already-started' }
  | { readonly status: 'not-executable' }

/**
 * The unique Main-local destructive promotion execution entry (Phase
 * 4.4.2, LOCK-4421..4428): consume the prepared handle exactly once and
 * run the non-reorderable sequence
 *
 *   authorized close → closed-live proof → sidecars + atomic install →
 *   durable candidate-installed → authorized reopen → identity-bound
 *   verification → durable replacement-verified → Phase 4.4.3 handoff.
 *
 * Exact-once (LOCK-4421): entry is bounded to the session-currency checks
 * of {@link transferPromotionExecution} plus a never-reset per-session
 * start guard, both on the same synchronous frame — concurrent or repeated
 * starts can never duplicate destructive work.
 *
 * Settlement: `promoted` is settled ONLY after the durable
 * replacement-verified journal advancement; every executor failure settles
 * `promotion-failed` via the exact-once token protocol. Ownership release
 * always happens AFTER the executor quiesced; on success the handoff
 * deliberately keeps owning the capability (same lease) so no competition
 * window opens before Phase 4.4.3 (LOCK-4422/4428).
 */
export async function startPromotionExecution(
  options: StartPromotionExecutionOptions
): Promise<PromotionExecutionStartOutcome> {
  const session = activeSession
  if (!session) {
    return { status: 'not-executable' }
  }
  // Exact-once repeated-start refusal first: once this session started an
  // execution (even after it settled), a later start can never re-run.
  if (session.promotionExecutionStarted) {
    return { status: 'already-started' }
  }
  if (session.state !== 'promoting' || session.promotionToken === null) {
    return { status: 'not-executable' }
  }

  // Exact-once consume (LOCK-4421): the transfer validates session currency
  // (active session, promoting, live token, aligned unconsumed handle) and
  // consumes the prepared handle on this same synchronous frame. The start
  // guard is set before any await so concurrent starts are refused.
  const transfer = transferPromotionExecution()
  if (transfer.status !== 'transferred') {
    return transfer.status === 'already-consumed' ? { status: 'already-started' } : { status: 'not-executable' }
  }
  session.promotionExecutionStarted = true
  const capability = transfer.capability
  const token = capability.token

  const executorFactory = options.executorFactory ?? createPromotionExecutor
  if (!options.catalogBoundary) {
    logger.error(
      `Promotion execution for session ${session.id} cannot start: catalog boundary unavailable (LOCK-PROMO-5)`
    )
    completePromotion(token, 'promotion-failed')
    session.releasePromotionOwnership()
    return {
      status: 'promotion-failed',
      failure: Object.freeze({
        subphase: 'not-started',
        classification: 'pre-install',
        recoveryRequired: false,
        code: 'CATALOG_BOUNDARY_UNAVAILABLE',
        safeCode: null,
        liveDisposition: 'open'
      }),
      recoveryHandoff: null
    }
  }
  const executor = executorFactory({
    capability,
    dataRoot: options.dataRoot,
    liveDb: options.liveDb,
    coordinator: options.coordinator,
    catalogBoundary: options.catalogBoundary,
    primitives: options.primitives
  })
  session.promotionExecutor = executor

  // run() never rejects (the executor contains every operational failure).
  // NOTE (hardened 4.4.2 audit correction): while `session.promotionExecutor`
  // was set, every stale fail/dispose/will-quit release path deferred to
  // THIS continuation — it is the single terminal ownership settlement
  // authority (release vs transfer). Clearing the reference below hands
  // subsequent (post-settlement) release calls their normal semantics.
  const result = await executor.run()
  session.promotionExecutor = null

  if (result.ok) {
    // Settle `promoted` ONLY after durable replacement-verified (LOCK-4424).
    if (!completePromotion(token, 'promoted')) {
      // Raced owner settle (failure / will-quit) during the await: the
      // racing owner deferred its release (abort contract); release here
      // is the exact-once deferred release after quiesce. The durable
      // replacement-verified artifacts are left to startup recovery.
      logger.warn(`Promotion execution for session ${session.id} settled after the session was superseded (stale)`)
      session.releasePromotionOwnership()
      return { status: 'stale-settle', result }
    }
    // LOCK-4428: STOP at the replacement-verified handoff. Capability
    // ownership is TRANSFERRED (not aliased) out of the session to the
    // terminal handoff owner: stale session fail/dispose can never release
    // it. Released by the Phase 4.4.3 recovery executor, by the import
    // control layer's non-packaged success cleanup (LOCK-FR2), or by
    // process exit. No cleanup, no relaunch.
    session.takeExecutingCapability()
    setTerminalPromotionOwnership({ kind: 'promoted' as const, handoff: result.handoff })
    logger.info(
      `Promotion execution promoted session ${session.id} ` +
        '(durable replacement-verified handoff; capability ownership transferred to the handoff)'
    )
    return { status: 'promoted', handoff: result.handoff }
  }

  // Executor failure: settle `promotion-failed` exactly once via the token
  // protocol (a raced owner settle already decided the same terminal
  // state). The executor has quiesced — terminal ownership is decided here.
  completePromotion(token, 'promotion-failed')

  if (result.failure.recoveryRequired) {
    // Post-install recovery-required (LOCK-4425 strengthened invariant):
    // the rename already happened and the installed replacement is
    // UNVERIFIED. Transfer the capability to the recovery-required handoff
    // so the same lease keeps blocking public init/close/backup/restore
    // until Phase 4.4.3 or process exit — releasing it here would permit
    // an in-process public init of the unverified installed DB.
    const capability = session.takeExecutingCapability()
    if (capability) {
      const recoveryHandoff: PromotionRecoveryRequiredHandoff = Object.freeze({
        sessionId: capability.sessionId,
        candidateId: capability.candidateId,
        token,
        failure: result.failure,
        capability
      })
      setTerminalPromotionOwnership({ kind: 'recovery-required' as const, handoff: recoveryHandoff })
      logger.warn(
        `Promotion execution for session ${session.id} failed post-install (recovery-required): ` +
          'capability retained by the recovery handoff — ordinary maintenance stays blocked until Phase 4.4.3'
      )
      return { status: 'promotion-failed', failure: result.failure, recoveryHandoff }
    }
    // Defensive: the deferral contract makes a missing capability
    // unreachable (no release path runs while the executor reference is
    // set). If it ever happens, isolation cannot be constructed — report
    // the failure without a handoff; artifacts stay durable for recovery.
    logger.error(
      `Promotion execution for session ${session.id} failed post-install but the session no longer ` +
        'owns the executing capability; recovery-required handoff unavailable'
    )
    return { status: 'promotion-failed', failure: result.failure, recoveryHandoff: null }
  }

  // Pre-install failure: the live bytes were never replaced and the
  // executor restored availability where possible. Release ownership
  // exactly once after quiesce (existing behavior).
  session.releasePromotionOwnership()
  return { status: 'promotion-failed', failure: result.failure, recoveryHandoff: null }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Completion path (LOCK-O3/O7): finalize the data plane exactly once,
 * verify orchestrator/data-plane source stats agree, set elapsedMs, seal
 * the candidate, transition to candidate-ready, and emit exactly one
 * Main-only CandidateReadyResult. Any failure enters the error lifecycle
 * (LOCK-O6) and rethrows so the IPC boundary acks { ok: false }.
 */
async function completeCandidate(
  session: InternalImportSession,
  options: StartImportOptions | undefined,
  now: () => number,
  writeProjection: (sqlite: unknown, projection: ImportNavigationProjection) => void,
  writeAttachmentMarkers: (sqlite: unknown, degradedFileIds: readonly string[]) => AttachmentMarkerResult
): Promise<void> {
  // Exact-once guard (LOCK-O3/O4): completion runs only from `reading` and
  // only if no ready result has been emitted.
  if (session.readyEmitted || session.state !== 'reading') return

  const candidate = session.candidate
  const plane = session.dataPlane
  if (!candidate || !plane) {
    const error = new Error(`Completion reached without candidate/data plane for session ${session.id}`)
    await session.fail('completion', error)
    throw error
  }

  // 1. Finalize exactly once (rejects dangling block references).
  let finalized: { sourceReadStats: SourceReadStats; candidateImportStats: CandidateImportStats }
  try {
    finalized = plane.finalize()
  } catch (error) {
    await session.fail('data plane finalize', error)
    throw toError(error)
  }

  // 1a. LOCK-FTS-4/5: rebuild the deferred FTS/normalized projection
  // atomically and exactly once AFTER finalize and BEFORE the navigation
  // projection/stats/seal. Failure rolls back and aborts/discards the
  // candidate — a candidate without its rebuilt projection never seals
  // (LOCK-FTS-4: never seal unrebuilt).
  try {
    candidate.rebuildFtsProjection()
  } catch (error) {
    await session.fail('fts projection rebuild', error)
    throw toError(error)
  }

  // 1b. LOCK-PROD-6: build + persist the navigation projection BEFORE the
  // candidate is sealed so the versioned one-shot payload travels atomically
  // with chat.db through the promotion install. A rejected/malformed source
  // projection fails the import (LOCK-PROD-5) — never a silent partial seal.
  {
    let topicFacts: Array<{ id: string; deletedAt: string | null }>
    try {
      topicFacts = plane.getImportedTopicFacts()
    } catch (error) {
      await session.fail('navigation projection facts', error)
      throw toError(error)
    }
    let droppedLsTopics = 0
    let malformedAssistants = 0
    const outcome = buildNavigationProjection(session.rawPersistedState, topicFacts, (category, count) => {
      if (category === 'ls-topic-missing-in-idb') droppedLsTopics = count
      else malformedAssistants = count
    })
    if (outcome.status === 'rejected') {
      // LOCK-PRIV-6/9: the projection rejection message is built from
      // RENDERER-ORIGIN persisted state and embeds assistant/topic IDs —
      // never interpolate it into the failure Error (which reaches the
      // session-failure log and the IPC callback-failure log). Only the
      // fixed rejection code is retained with static text.
      const error = new Error(`Navigation projection rejected (${outcome.code})`)
      await session.fail('navigation projection', error)
      throw error
    }
    // Count-only, path-redacted diagnostics (LOCK-PROD-12): never IDs/names.
    if (droppedLsTopics > 0) {
      logger.warn(
        `Session ${session.id}: ${droppedLsTopics} Local Storage topic(s) absent from IndexedDB ` +
          'were ignored (LOCK-PROD-3).'
      )
    }
    if (malformedAssistants > 0) {
      logger.warn(
        `Session ${session.id}: ${malformedAssistants} malformed Local Storage assistant record(s) ` +
          'were skipped (LOCK-PROD-5).'
      )
    }
    try {
      writeProjection(candidate.getSqlite(), outcome.projection)
    } catch (error) {
      await session.fail('navigation projection persist', error)
      throw toError(error)
    }
    logger.info(
      `Session ${session.id}: navigation projection persisted ` +
        `(assistants: ${outcome.projection.assistants.length}, topics: ${outcome.projection.topics.length}, ` +
        `recovered: ${outcome.projection.recoveredTopicIds.length})`
    )
  }

  // 2. LOCK-O7: orchestrator and data-plane source stats must agree exactly.
  const mismatch = describeStatsMismatch(session.sourceStats, finalized.sourceReadStats)
  if (mismatch) {
    const error = new Error(`Source read stats mismatch between orchestrator and data plane: ${mismatch}`)
    await session.fail('stats comparison', error)
    throw error
  }

  // 2a. LOCK-FIX-2/7/9: finalize the attachment plane (reconcile catalog/
  // refs/payloads, stream Data/Files payloads into the candidate Files dir
  // with bounded streaming + SHA-256, write + verify the durable
  // files-catalog.json handoff). Runs BEFORE the candidate chat.db is
  // sealed so a failure enters the error lifecycle with the candidate still
  // discardable — a candidate-ready result always implies a complete sealed
  // candidate + attachments. Any fatal class (LOCK-FIX-3) rejects the
  // import atomically; per-payload degradations (LOCK-FIX-4/5) are
  // aggregated count-only by the plane and never reject.
  const attachment = session.attachmentPlane
  if (attachment) {
    try {
      session.attachmentStats = await attachment.finalize({
        sourceFileRows: plane.getSourceFileRows(),
        referenceCounts: plane.getImportedFileReferenceCounts(),
        shouldAbort: () => session.state === 'cancelled' || session.isDisposed
      })
    } catch (error) {
      await session.fail('attachment plane finalize', error)
      throw toError(error)
    }
  }

  // LOCK-CORR-1: cancellation/disposal must be rechecked AFTER the awaited
  // attachment finalize and BEFORE the candidate is sealed / transitions to
  // candidate-ready. `shouldAbort` above can only probe at the plane's
  // cooperative check points; cancel/dispose racing the finalize's final
  // checks would otherwise let this continuation seal a DISCARDED candidate
  // (recreating owned paths) and spuriously transition cancelled →
  // candidate-ready. A cancelled/disposed/superseded session returns here —
  // the cancel/error lifecycle (already in flight) discards the candidate.
  // (Cast: TS narrowed `state` to 'reading' from the entry guard, but
  // setState() mutated it and cancel may have raced the awaited finalize.)
  if ((session.state as ImportState) === 'cancelled' || session.isDisposed || activeSession?.id !== session.id) {
    logger.info(`Session ${session.id} was cancelled/disposed during attachment finalize; candidate not sealed`)
    return
  }

  // 2b. LOCK-UI-2/3/4/5/6: persist the import-only per-block unavailable
  // marker into EVERY imported file/image block referencing a
  // reference-degraded file — BEFORE the candidate seals. Runs only when
  // the attachment plane reported degraded ids (never for healthy imports).
  // The mutation is transactional: a failure rejects candidate finalization
  // (error/discard lifecycle) — never a silent partial seal. The log line is
  // aggregate count-only (LOCK-UI-5): never file/block IDs, paths, names,
  // or content.
  if (attachment) {
    try {
      const degradedFileIds = attachment.getDegradedFileIds()
      if (degradedFileIds.length > 0) {
        const markerResult = writeAttachmentMarkers(candidate.getSqlite(), degradedFileIds)
        logger.info(
          `Session ${session.id}: attachment availability marker applied — ` +
            `${markerResult.markedBlockCount} block(s) marked unavailable ` +
            `for ${markerResult.degradedFileIdCount} degraded file id(s) (aggregate)`
        )
      }
    } catch (error) {
      await session.fail('attachment unavailable marker', error)
      throw toError(error)
    }
  }

  // 3. elapsedMs: wall-clock candidate construction time (LOCK-O7/O8 clock).
  const stats: CandidateImportStats = {
    ...finalized.candidateImportStats,
    elapsedMs: Math.max(0, now() - session.candidateStartedAt)
  }

  // 4. Seal the candidate (files remain on disk for Phase 4.3).
  try {
    candidate.seal()
  } catch (error) {
    await session.fail('candidate seal', error)
    throw toError(error)
  }

  // 5. Transition + exactly-one Main-only ready emission (LOCK-O3). The
  // result carries NO filesystem paths — see getSealedCandidate().
  session.setState('candidate-ready')
  session.readyEmitted = true
  const result: CandidateReadyResult = {
    sessionId: session.id,
    candidateId: session.candidateId,
    stats
  }
  session.readyResult = result
  try {
    await options?.onCandidateReady?.(result)
  } catch (error) {
    // LOCK-O6: callback failure enters error, discards the candidate, and
    // resets the singleton. No unhandled rejection: rethrow is contained at
    // the IPC boundary as a structured failure ack. Verification never
    // starts after a failed ready callback (LOCK-4304).
    await session.fail('candidate-ready callback', error)
    throw toError(error)
  }

  // Re-check after await: cancel/dispose may have raced the ready callback
  // (LOCK-O5) — verification must not start on a discarded candidate.
  // (Cast: TS narrowed `state` to 'reading' from the entry guard, but
  // setState() mutated it and cancel may have raced the awaited callback.)
  if (activeSession?.id !== session.id || (session.state as ImportState) !== 'candidate-ready') {
    logger.info(`Session ${session.id} left candidate-ready during the ready callback; verification not started`)
    return
  }

  // 5b. LOCK-OWN-2 / LOCK-BLOCK-2 / LOCK-ASK-2 / LOCK-SEG-1 / LOCK-LOG-1:
  // exactly ONE aggregate count-only warning iff ANY normalization category
  // is nonzero. Static category names + integer counts ONLY for:
  // - topicIdNormalization            (LOCK-OWN-1 canonicalized embedded topicId)
  // - unreachableBlockSkip            (LOCK-BLOCK-1 absent-owner orphan rows)
  // - existingOwnerUnembeddedBlockSkip (LOCK-BLOCK-1X resurrection guard)
  // - danglingAskIdPreserved          (LOCK-ASK-2 verbatim-preserved askId)
  // - skippedSegmentRow / skippedSegmentMembership (LOCK-SEG-1 absent-topic)
  // Never per-message, never with IDs/content/source values.
  //
  // Timing contract: this is the latest natural success point INSIDE
  // completeCandidate — every candidate-completion gate that can fail/retry
  // has already succeeded (finalize, source-stat compare, seal, the
  // candidate-ready transition, and the ready callback). A source-stat
  // mismatch, a seal failure, or a failed ready callback therefore NEVER
  // emits this warning; a successful candidate completion emits it exactly
  // once (the completion path is exact-once via the readyEmitted guard, the
  // finalized plane is stable, and a rejected/rolled-back page never
  // advanced any count). Rejected/rolled-back pages and failed/retried
  // sessions never leak counts; one successful retry emits once.
  // Verification/promotion are a separate phase: this warning documents
  // candidate-projection normalization evidence, not full import success.
  // The payload is session/run context + aggregate counts ONLY: no topic
  // IDs, message IDs, block IDs, names, content, paths, or source values.
  const normalization = plane.getNormalizationStats()
  const residualCategories: ReadonlyArray<readonly [string, number]> = [
    ['topicIdNormalization', normalization.topicIdNormalizationCount],
    ['unreachableBlockSkip', normalization.unreachableBlockSkipCount],
    ['existingOwnerUnembeddedBlockSkip', normalization.skippedExistingOwnerUnembeddedBlockCount],
    ['danglingAskIdPreserved', normalization.danglingAskIdPreservedCount],
    ['skippedSegmentRow', normalization.skippedSegmentRowCount],
    ['skippedSegmentMembership', normalization.skippedSegmentMembershipCount]
  ]
  if (residualCategories.some(([, count]) => count > 0)) {
    const residualSummary = residualCategories.map(([name, count]) => `${name}=${count}`).join(', ')
    logger.warn(
      `Session ${session.id}: data-plane normalization residuals (${residualSummary}); ` +
        'all other ownership/identity validations remain strict'
    )
  }

  // 6. Phase 4.3.3: start exactly one verification run (LOCK-4304).
  await startVerification(session, options)
}

/**
 * Start exactly one verification run against the sealed candidate
 * (LOCK-4301/4303/4304). Uses the finalized manifest from the SAME data
 * plane that built the candidate. Transitions to `verifying` and stores
 * the AbortController, verifier, and in-flight promise on the session.
 * The run itself is fire-and-tracked: it is never awaited here, and
 * settleVerification contains every outcome so the tracked promise can
 * never reject (no unhandled rejection).
 */
async function startVerification(
  session: InternalImportSession,
  options: StartImportOptions | undefined
): Promise<void> {
  // Exact-once start guard (LOCK-4304).
  if (session.verificationStarted) {
    logger.warn(`Duplicate verification start attempt for session ${session.id} ignored`)
    return
  }
  session.verificationStarted = true

  const candidate = session.candidate
  const plane = session.dataPlane
  if (!candidate || !plane) {
    const error = new Error(`Verification start reached without candidate/data plane for session ${session.id}`)
    await session.fail('verification start', error)
    throw error
  }

  const verifierFactory = options?.verifierFactory ?? createCandidateVerifier
  const controller = new AbortController()
  let verifier: CandidateVerifierLike
  try {
    // LOCK-4301: finalized manifest from the SAME data plane — never a
    // second framing or a target-only weakening.
    const manifest = plane.getSourceVerificationManifest()
    verifier = verifierFactory({
      dbPath: candidate.getDbPath(),
      manifest,
      signal: controller.signal
    })
  } catch (error) {
    await session.fail('verification start', error)
    throw toError(error)
  }

  // LOCK-4303: the session is the unique owner of controller + verifier +
  // in-flight promise. State transition is deterministic before run start.
  session.abortController = controller
  session.verifier = verifier
  session.setState('verifying')
  session.verificationPromise = runVerification(session, verifier, options)
}

/**
 * Await the verifier run and settle exactly once. Never rejects: run()
 * only throws for lifecycle misuse, which is contained into the error
 * lifecycle by settleVerification.
 */
async function runVerification(
  session: InternalImportSession,
  verifier: CandidateVerifierLike,
  options: StartImportOptions | undefined
): Promise<void> {
  let report: CandidateVerificationReport | null = null
  let runError: unknown = null
  try {
    report = await verifier.run()
  } catch (error) {
    runError = error
  }
  await settleVerification(session, report, runError, options)
}

/**
 * Exact-once verification completion (LOCK-4304).
 *
 * - Stale/raced completions (cancel, quit, failure, manual dispose already
 *   own cleanup) close the verifier and return without callbacks or state
 *   transitions.
 * - pass   → `verified-candidate`: sealed candidate + report retained for
 *   Phase 4.4; the session stays active.
 * - fail   → `verification-failed`: sanitized report delivered exactly once,
 *   then verifier close → candidate discard → source reader/workspace
 *   disposal → singleton reset. The report stays retained on the session.
 * - Callback errors are contained (LOCK-4304): logged, never rethrown,
 *   never leak resources or duplicate completion.
 */
async function settleVerification(
  session: InternalImportSession,
  report: CandidateVerificationReport | null,
  runError: unknown,
  options: StartImportOptions | undefined
): Promise<void> {
  // Exact-once completion guard (LOCK-4304).
  if (session.verificationCompleted) {
    logger.warn(`Duplicate verification completion attempt for session ${session.id} ignored`)
    return
  }
  session.verificationCompleted = true

  // The in-flight promise is settled from here on. Clearing it now keeps
  // dispose() from awaiting a promise whose continuation may itself invoke
  // cancel/dispose (callback re-entrancy safety).
  session.verificationPromise = null

  // The verifier's run() already closed the readonly handle in its finally;
  // close() is idempotent and guarantees closure for injected doubles too.
  if (session.verifier) {
    try {
      session.verifier.close()
    } catch (error) {
      logger.warn(`Error closing verifier after completion for ${session.id}:`, error as Error)
    }
  }

  if (report !== null) {
    session.verificationReport = report
  }

  // Stale/raced completion: cancel, quit, failure, or manual dispose won the
  // race and owns resource cleanup — never deliver callbacks or transition
  // states from a stale completion.
  if (activeSession?.id !== session.id || session.state !== 'verifying' || session.isDisposed) {
    logger.info(`Verification completion for session ${session.id} is stale (state ${session.state}); ignoring`)
    return
  }

  if (runError !== null || report === null) {
    // run() rejected (lifecycle misuse — unexpected). Contained into the
    // error lifecycle; fail() never rejects.
    await session.fail('verification run', runError ?? new Error('verifier resolved without a report'))
    return
  }

  if (report.status === 'aborted') {
    // Defensive: an abort/close raced ahead of its owner's state change.
    // No callback for an aborted run; cleanup via the error lifecycle.
    await session.fail('verification aborted', new Error('verifier aborted without owner state transition'))
    return
  }

  const ready = session.readyResult
  if (ready === null) {
    const error = new Error(`Verification completed without a retained CandidateReadyResult for ${session.id}`)
    await session.fail('verification completion', error)
    return
  }

  // Sanitized Main-only payload (LOCK-4304): report + ready identity/stats.
  // NEVER dbPath, manifest, or SQL.
  const payload: VerificationCompletedResult = {
    sessionId: ready.sessionId,
    candidateId: ready.candidateId,
    stats: ready.stats,
    report
  }

  if (report.status === 'pass') {
    // LOCK-RS2/RS3/RS4: the readonly verifier open leaves empty WAL/SHM
    // residue, which breaks the sealed invariant the promotion install
    // guard requires (LOCK-RS1: SIDECAR_PRESENT rejection — unchanged).
    // Reseal explicitly BEFORE claiming `verified-candidate`: writable
    // open + wal_checkpoint(TRUNCATE) + close + sidecar-absence proof.
    // Fail closed: a reseal failure enters the existing error/discard
    // lifecycle (session.fail) and the session NEVER reaches
    // `verified-candidate` — no promotion claim from an unsealed candidate.
    const candidate = session.candidate
    if (!candidate) {
      const error = new Error(`Verification passed without a retained candidate for ${session.id}`)
      await session.fail('candidate reseal', error)
      return
    }
    try {
      candidate.reseal()
    } catch (error) {
      await session.fail('candidate reseal', error)
      return
    }
    // LOCK-4305: pass retains the sealed candidate + report; NO promotion,
    // live-DB replacement, snapshot, or relaunch in Phase 4.3.
    session.setState('verified-candidate')
    await invokeVerificationCallback(session, options, payload)
    return
  }

  // report.status === 'fail' — deliver the report exactly once, then clean
  // up: verifier already closed → discard candidate → dispose source
  // reader/workspace → reset singleton. The report stays retained on the
  // session for the callback's consumers (LOCK-4304).
  session.setState('verification-failed')
  await invokeVerificationCallback(session, options, payload)
  await session.dispose()
}

/** Contained Main-only verification callback invocation (LOCK-4304). */
async function invokeVerificationCallback(
  session: InternalImportSession,
  options: StartImportOptions | undefined,
  payload: VerificationCompletedResult
): Promise<void> {
  try {
    await options?.onVerificationComplete?.(payload)
  } catch (error) {
    // Contained: callback errors cannot leak resources, change verification
    // state, or cause duplicate verification (LOCK-4304).
    logger.warn(`onVerificationComplete callback failed for session ${session.id}:`, toError(error))
  }
}

/**
 * Exact field-by-field SourceReadStats comparison (LOCK-O7).
 * Returns a human-readable mismatch description, or null when equal.
 */
function describeStatsMismatch(orchestrator: SourceReadStats, dataPlane: SourceReadStats): string | null {
  const fields: Array<keyof SourceReadStats> = [
    'topicRecordCount',
    'blockRecordCount',
    'segmentRecordCount',
    'sourceFileRecordCount'
  ]
  const diffs: string[] = []
  for (const field of fields) {
    if (orchestrator[field] !== dataPlane[field]) {
      diffs.push(`${field}: orchestrator=${orchestrator[field]}, dataPlane=${dataPlane[field]}`)
    }
  }
  return diffs.length > 0 ? diffs.join('; ') : null
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function generateSessionId(): string {
  return 'import-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

/** Opaque non-reusable promotion claim token (Main-internal, not a path). */
function generatePromotionToken(): string {
  return 'promotion-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}
