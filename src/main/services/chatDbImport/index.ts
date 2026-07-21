/**
 * ChatImport pipeline — public API.
 *
 * Orchestrates the Phase 4.1 source-reader pipeline:
 *   ZIP path → secure extract → isolated Electron session + hidden sandboxed
 *   import renderer → import-only narrow IPC → paged logical-data read
 *   ready to be consumed by Phase 4.2 (bulk import, NOT this round).
 *
 * State machine: intake → discovering → reading → ready-for-bulk
 * Cancellation supported at every state except after ready-for-bulk.
 *
 * A-9: Platform gate — if process.platform !== 'darwin', throw.
 * All imports route through loggerService with context 'chatDbImport'.
 */

import path from 'node:path'

import { loggerService } from '@logger'
import type { DiscoveryResult, ReadPageResponse, SourceStats } from '@shared/chatImport/types'

import { ChatImportSessionError, ChatImportUnsupportedPlatformError } from './errors'
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

export type ImportState = 'intake' | 'discovering' | 'reading' | 'ready-for-bulk' | 'cancelled' | 'error'

export interface ImportSession {
  /** Unique session identifier (UUIDv4). */
  readonly id: string
  /** Current pipeline state. */
  readonly state: ImportState
  /** Cancel the import. No-op if already in terminal state. */
  cancel(): Promise<void>
  /** Dispose all resources (temp dir, session, window). */
  dispose(): Promise<void>
}

export interface StartImportOptions {
  /** Callback invoked when all data has been read and is ready for Phase 4.2. */
  onReadyForBulk?: (sessionId: string, stats: SourceStatsSummary) => void
}

export interface SourceStatsSummary {
  topicCount: number
  messageCount: number
  blockCount: number
  segmentCount: number
  fileRefCount: number
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
  /** Accumulated source stats from read pages. */
  public sourceStats: SourceStatsSummary = {
    topicCount: 0,
    messageCount: 0,
    blockCount: 0,
    segmentCount: 0,
    fileRefCount: 0
  }
  /** Discovery result received from renderer. */
  public discoveryResult: DiscoveryResult | null = null

  constructor(id: string) {
    this.id = id
  }

  setState(state: ImportState): void {
    this.state = state
    logger.info(`Session ${this.id} → ${state}`)
  }

  setTempDir(dir: string): void {
    this.tempDir = dir
  }

  async cancel(): Promise<void> {
    if (this.state === 'cancelled' || this.state === 'error' || this.state === 'ready-for-bulk') {
      logger.info(`Cancel ignored for session ${this.id} in state ${this.state}`)
      return
    }

    this.setState('cancelled')
    sendCancel(this.id)
    await this.dispose()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true

    logger.info(`Disposing session ${this.id}`)

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
 * @param options  Optional callbacks (e.g. onReadyForBulk).
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

      onDiscover: (sid, result: DiscoveryResult) => {
        logger.info(
          `Discovery result for session ${sid}: native=${result.nativeVersion}, tables=${result.tableNames.join(',')}`
        )
        if (activeSession?.id !== sid) return

        // Store discovery result
        activeSession.discoveryResult = result

        // Transition to reading and send first page request for the first entity
        activeSession.setState('reading')
        activeSession.entityIndex = 0
        sendReadPage(sid, {
          tableName: IMPORT_ENTITIES[0],
          cursor: null,
          pageSize: DEFAULT_PAGE_SIZE
        })
      },

      onReadPage: (sid, response: ReadPageResponse) => {
        if (activeSession?.id !== sid) return

        // Accumulate stats based on which table was read
        const count = response.items.length
        switch (response.tableName) {
          case 'topics':
            activeSession.sourceStats.topicCount += count
            break
          case 'message_blocks':
            activeSession.sourceStats.blockCount += count
            break
          case 'topic_segments':
            activeSession.sourceStats.segmentCount += count
            break
          case 'files':
            activeSession.sourceStats.fileRefCount += count
            break
          default:
            // messages or other tables
            activeSession.sourceStats.messageCount += count
            break
        }

        if (response.hasMore) {
          // Request next page of same table
          sendReadPage(sid, {
            tableName: response.tableName,
            cursor: response.cursor,
            pageSize: DEFAULT_PAGE_SIZE
          })
        } else {
          // Move to next entity
          activeSession.entityIndex++
          if (activeSession.entityIndex < IMPORT_ENTITIES.length) {
            sendReadPage(sid, {
              tableName: IMPORT_ENTITIES[activeSession.entityIndex],
              cursor: null,
              pageSize: DEFAULT_PAGE_SIZE
            })
          } else {
            // All entities exhausted — Main self-completes.
            // Main is the authoritative owner of cursor progression; renderer
            // is a passive command-executor with zero awareness of entity
            // boundaries, so Main MUST self-complete.
            activeSession.setState('ready-for-bulk')
            options?.onReadyForBulk?.(sid, {
              topicCount: activeSession.sourceStats.topicCount,
              messageCount: activeSession.sourceStats.messageCount,
              blockCount: activeSession.sourceStats.blockCount,
              segmentCount: activeSession.sourceStats.segmentCount,
              fileRefCount: activeSession.sourceStats.fileRefCount
            })
          }
        }
      },

      onComplete: (sid, stats: SourceStats) => {
        if (activeSession?.id !== sid) return

        logger.info(`All data read for session ${sid}: ${JSON.stringify(stats)}`)
        activeSession.setState('ready-for-bulk')
        options?.onReadyForBulk?.(sid, {
          topicCount: stats.topicCount,
          messageCount: stats.messageCount,
          blockCount: stats.blockCount,
          segmentCount: stats.segmentCount,
          fileRefCount: stats.fileRefCount
        })
      },

      onError: (sid, error) => {
        logger.error(`Import error for session ${sid}: [${error.code}] ${error.message}`)
        if (activeSession?.id === sid) {
          activeSession.setState('error')
        }
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
          activeSession.setState('error')
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
 * Dispose the active import session (sync, for will-quit).
 */
export function disposeActiveImport(): void {
  if (!activeSession) return

  // Sync window destruction
  disposeSessionSync()

  // Sync temp dir cleanup
  const session = activeSession
  activeSession = null

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
 * Register import IPC handlers. Called once at app-ready.
 */
export { registerChatImportIpc }

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function generateSessionId(): string {
  return 'import-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}
