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
 * State machine: intake → discovering → reading → candidate-ready
 * Cancellation supported at every non-terminal state, INCLUDING
 * candidate-ready (until a future promotion phase) — cancel discards the
 * candidate and all source resources (LOCK-O5).
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
  createTempWorkspace,
  disposeAsync as disposeTempDirAsync,
  recoverOrphanedTempWorkspaces
} from './tempWorkspace'
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

export type ImportState = 'intake' | 'discovering' | 'reading' | 'candidate-ready' | 'cancelled' | 'error'

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
   * Test injection (LOCK-O8): candidate resource factory. Production default
   * is `new CandidateDbResource({ sessionId })`.
   */
  candidateFactory?: (sessionId: string) => CandidateResourceLike
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

  constructor(id: string) {
    this.id = id
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
    if (this.state === 'cancelled' || this.state === 'error') {
      logger.info(`Cancel ignored for session ${this.id} in state ${this.state}`)
      return
    }

    // LOCK-O5: cancel is allowed before AND after candidate-ready (until a
    // future promotion phase). It discards the candidate and all source
    // resources. If a page write is in flight, the post-await state re-check
    // in the orchestrator prevents any next page or ready callback.
    this.setState('cancelled')
    sendCancel(this.id)
    await this.dispose()
  }

  /**
   * Enter the error lifecycle (LOCK-O6): mark error (unless already
   * cancelled), discard the candidate, dispose all isolated resources, and
   * reset the singleton. Never rejects.
   */
  async fail(context: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`Session ${this.id} failed during ${context}: ${message}`)
    if (this.state !== 'cancelled' && this.state !== 'error') {
      this.setState('error')
    }
    await this.dispose()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true

    logger.info(`Disposing session ${this.id}`)

    // Discard candidate (closes DB handle first, then removes the owned
    // directory). Sealed candidates are discarded too: dispose is only
    // reached via cancel/error/manual teardown (LOCK-O5/O6).
    if (this.candidate) {
      try {
        await this.candidate.discard()
      } catch (error) {
        logger.warn(`Error discarding candidate for ${this.id}:`, error as Error)
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

  /** Synchronous candidate discard for the will-quit path. */
  discardCandidateSync(): void {
    if (this.candidate) {
      try {
        this.candidate.discardSync()
      } catch (error) {
        logger.warn(`Error discarding candidate (sync) for ${this.id}:`, error as Error)
      }
      this.candidate = null
    }
    this.dataPlane = null
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
 * (Phase 4.3 consumer). Returns null unless the session is candidate-ready.
 * The filesystem path stays Main-internal — never send it over IPC.
 */
export function getSealedCandidate(): SealedCandidateHandle | null {
  if (!activeSession || activeSession.state !== 'candidate-ready' || !activeSession.candidate) {
    return null
  }
  return {
    sessionId: activeSession.id,
    candidateId: activeSession.candidateId,
    dbPath: activeSession.candidate.getDbPath()
  }
}

/**
 * Dispose the active import session (sync, for will-quit).
 */
export function disposeActiveImport(): void {
  if (!activeSession) return

  // Sync window destruction
  disposeSessionSync()

  // Sync candidate discard (closes handle + removes owned directory)
  const session = activeSession
  activeSession = null
  session.discardCandidateSync()

  // Dispose IPC
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
  try {
    await options?.onCandidateReady?.(result)
  } catch (error) {
    // LOCK-O6: callback failure enters error, discards the candidate, and
    // resets the singleton. No unhandled rejection: rethrow is contained at
    // the IPC boundary as a structured failure ack.
    await session.fail('candidate-ready callback', error)
    throw toError(error)
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
