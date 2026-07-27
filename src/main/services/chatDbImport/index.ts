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
 * A-9: Platform gate — if process.platform !== 'darwin', throw.
 * All imports route through loggerService with context 'chatDbImport'.
 */

import path from 'node:path'

import { loggerService } from '@logger'
import type {
  CandidateImportStats,
  CandidateReadyResult,
  DiscoveryResult,
  ReadPageResponse,
  SourceReadStats
} from '@shared/chatImport/types'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import { CandidateDbResource } from './candidateDb'
import { ChatImportSessionError, ChatImportUnsupportedPlatformError } from './errors'
import { createImportDataPlane } from './importDataPlane'
import { registerChatImportIpc, sendCancel, sendDiscover, sendReadPage } from './importIpc'
import { createIsolatedReader, dispose as disposeSession, disposeSync as disposeSessionSync } from './isolatedSession'
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
import { extractZip } from './zipIntake'

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
  getDatabase(): unknown
  getDbPath(): string
  seal(): void
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
  /** Sanitized 13-dimension verification report. */
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
   * Production default is `createImportDataPlane(candidate.getDatabase())`.
   */
  dataPlaneFactory?: (db: unknown) => ImportDataPlaneLike
  /**
   * Test injection (LOCK-O8): clock used for CandidateImportStats.elapsedMs.
   * Production default is Date.now.
   */
  now?: () => number
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

class InternalImportSession implements ImportSession {
  public id: string
  public state: ImportState = 'intake'
  private tempDir: string | null = null
  private disposed = false

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

  /** Candidate DB resource — owned by this session (LOCK-O1). */
  public candidate: CandidateResourceLike | null = null
  /** Data plane bound to the candidate DB — owned by this session. */
  public dataPlane: ImportDataPlaneLike | null = null
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
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`Session ${this.id} failed during ${context}: ${message}`)
    if (this.state === 'promoting') {
      // LOCK-4401: `promoting` may only leave to a terminal result state.
      // A failure during the promotion window settles `promotion-failed`
      // (consuming the token) — never `error`. dispose() below preserves
      // the promotion-owned candidate.
      this.promotionToken = null
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
    options?.dataPlaneFactory ?? ((db: unknown) => createImportDataPlane(db as BetterSQLite3Database<any>))
  const now = options?.now ?? Date.now

  // Generate session ID
  const sessionId = generateSessionId()
  const session = new InternalImportSession(sessionId)
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
        `IndexedDB at ${extractResult.indexedDbDir}`
    )

    // Phase 2: Create isolated session + load import renderer
    session.setState('discovering')

    const preloadPath = path.join(__dirname, '../preload/chat-import-preload.js')
    const htmlPath = path.join(__dirname, '../renderer/chatImport.html')

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
        logger.info(
          `Discovery result for session ${sid}: native=${result.nativeVersion}, tables=${result.tableNames.join(',')}`
        )
        if (activeSession?.id !== sid || session.state !== 'discovering') return

        // Store discovery result
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
          session.dataPlane = dataPlaneFactory(candidate.getDatabase())
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

        // Transition to reading and send first page request for the first entity
        session.setState('reading')
        session.entityIndex = 0
        sendReadPage(sid, {
          tableName: IMPORT_ENTITIES[0],
          cursor: null,
          pageSize: DEFAULT_PAGE_SIZE
        })
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
            logger.warn(`Unexpected table '${response.tableName}' in session ${sid}`)
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
            await completeCandidate(session, options, now)
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
        logger.error(`Import error for session ${sid}: [${error.code}] ${error.message}`)
        if (activeSession?.id !== sid) return
        // LOCK-O6: renderer-reported failure enters the error lifecycle —
        // candidate discarded, isolated resources disposed, singleton reset.
        await session.fail(`renderer error [${error.code}]`, new Error(error.message))
      }
    })

    // Create isolated reader — workspaceRoot is the temp dir (PARENT of IndexedDB/).
    // Chromium stores IDB at <sessionRoot>/IndexedDB/.
    await createIsolatedReader({
      sessionId,
      workspaceRoot: extractResult.destDir,
      htmlPath,
      preloadPath,
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
        logger.error(`Isolated reader error for session ${sid}: [${error.code}] ${error.message}`)
        if (activeSession?.id === sid) {
          // Contained: fail() never rejects (LOCK-O6 — no unhandled rejection).
          void session.fail(`isolated reader error [${error.code}]`, new Error(error.message))
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
  if (ipcDisposer) {
    ipcDisposer()
    ipcDisposer = null
  }

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
  now: () => number
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

  // 2. LOCK-O7: orchestrator and data-plane source stats must agree exactly.
  const mismatch = describeStatsMismatch(session.sourceStats, finalized.sourceReadStats)
  if (mismatch) {
    const error = new Error(`Source read stats mismatch between orchestrator and data plane: ${mismatch}`)
    await session.fail('stats comparison', error)
    throw error
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
