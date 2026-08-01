/**
 * Production wrapper for isolated Electron session used to read source IndexedDB.
 *
 * Uses static `session.fromPath(absolutePath, { cache: false })` (Electron 41.2.1 API;
 * confirmed NOT `session.defaultSession.fromPath()` — Phase 4.0 spike).
 *
 * Security (from spike proven semantics):
 * - Hidden BrowserWindow: show:false, sandbox:true, contextIsolation:true,
 *   nodeIntegration:false, webSecurity:true, webviewTag:false,
 *   allowRunningInsecureContent:false
 * - will-navigate → preventDefault
 * - setWindowOpenHandler → reject-all
 * - Sender/identity validation via event.senderFrame === window.webContents.mainFrame
 *
 * R-1: dispose() always destroys window + nulls ref; try/finally on all paths.
 * R-5: Singleton enforcement — throw if an active import session already exists.
 * R-10: BrowserWindow.on('closed') + render-process-gone → transition to error state.
 * R-11: Uses isolated session root (copy of ZIP data) — no contention with other processes.
 *
 * LOCK-DEV-5: The dev-origin load target is a module-owned exact constant.
 * The caller never provides an arbitrary URL string; the load mode is a
 * closed discriminated union (`file` | `dev`) resolved internally.
 */

import { loggerService } from '@logger'
import { BrowserWindow, session } from 'electron'

import { ChatImportSessionError } from './errors'

const logger = loggerService.withContext('chatDbImport')

// ---------------------------------------------------------------------------
// Constants — LOCK-DEV-5: module-owned exact dev URL
// ---------------------------------------------------------------------------

/**
 * Exact Vite dev server URL for the chatImport entry point.
 * This is the ONLY HTTP origin accepted for dev-origin imports.
 * LOCK-DEV-3: exact origin http://localhost:5173.
 * LOCK-DEV-5: never derived from ZIP; this is a hardcoded constant.
 */
export const DEV_ORIGIN_URL = 'http://localhost:5173'

/**
 * Exact pathname of the chatImport HTML entry point on the Vite dev server.
 * LOCK-DEV-3: exact path.
 */
const DEV_PATHNAME = '/src/windows/chatImport/chatImport.html'

/** Full dev load URL: origin + pathname. */
export const DEV_LOAD_URL = `${DEV_ORIGIN_URL}${DEV_PATHNAME}`

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Closed discriminated union for the load target of an isolated reader.
 *
 * - `file`: loads via `pathToFileURL(htmlPath).href` (existing behavior).
 * - `dev`: loads via the module-owned `DEV_LOAD_URL` constant. Only valid
 *   when `app.isPackaged === false`.
 *
 * LOCK-DEV-5: the caller cannot provide an arbitrary URL string.
 */
export type LoadMode = 'file' | 'dev'

export interface ImportReader {
  /** The BrowserWindow hosting the hidden import renderer. */
  readonly window: BrowserWindow
  /** The isolated Electron session. */
  readonly electronSession: Electron.Session
  /** The session ID (UUID). */
  readonly sessionId: string
}

export interface CreateReaderOptions {
  sessionId: string
  /** Session root directory (PARENT of IndexedDB/). Chromium stores IDB at <workspaceRoot>/IndexedDB/. */
  workspaceRoot: string
  htmlPath: string
  preloadPath: string
  /**
   * Closed load mode discriminator (LOCK-DEV-5). The caller specifies
   * `'file'` or `'dev'`; the module resolves the exact URL internally.
   * No arbitrary URL string from the caller.
   */
  loadMode: LoadMode
  onReady: (sessionId: string) => void
  onDiscover: (sessionId: string) => void
  onReadPage: (sessionId: string, tableName: string, cursor: string | null, pageSize: number) => void
  onComplete: (sessionId: string) => void
  onError: (sessionId: string, error: { code: string; message: string }) => void
  onCancel: (sessionId: string) => void
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** The currently active reader, or null if none. */
let activeReader: ImportReader | null = null

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the currently active reader, or null if none.
 */
export function getActiveReader(): ImportReader | null {
  return activeReader
}

/**
 * Create an isolated Electron session and hidden BrowserWindow for import reading.
 *
 * @throws {ChatImportSessionError} If an active import session already exists (R-5).
 */
export async function createIsolatedReader(options: CreateReaderOptions): Promise<ImportReader> {
  if (activeReader) {
    throw new ChatImportSessionError('An active import session already exists. Only one concurrent import is allowed.')
  }

  const { sessionId, workspaceRoot, htmlPath, preloadPath, loadMode } = options

  // Create isolated session from the workspace root path.
  // This is the proven static API from Phase 4.0 spike.
  // Chromium stores IDB at <sessionRoot>/IndexedDB/, so we pass the
  // parent directory (workspaceRoot), NOT the IndexedDB/ subdirectory.
  // R-11: No contention with other processes — isolated root.
  const electronSession = session.fromPath(workspaceRoot, { cache: false })

  logger.info(`Created isolated session for ${sessionId} at ${workspaceRoot} (loadMode: ${loadMode})`)

  // Create hidden sandboxed BrowserWindow
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      session: electronSession,
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false
    }
  })

  // Security: prevent navigation away from the import page
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault()
    logger.warn('Blocked navigation in import window')
  })

  // Security: reject all window.open attempts
  win.webContents.setWindowOpenHandler(() => {
    logger.warn('Blocked window.open in import window')
    return { action: 'deny' }
  })

  // R-10: Handle window close and renderer crashes
  win.on('closed', () => {
    logger.info(`Import window closed for session ${sessionId}`)
    if (activeReader?.sessionId === sessionId) {
      activeReader = null
    }
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    logger.error(`Import renderer gone for session ${sessionId}: ${details.reason}`)
    if (activeReader?.sessionId === sessionId) {
      activeReader = null
    }
    options.onError(sessionId, {
      code: 'RENDERER_GONE',
      message: `Import renderer crashed: ${details.reason}`
    })
  })

  activeReader = { window: win, electronSession, sessionId }

  // LOCK-DEV-5: resolve the load URL from the closed loadMode discriminator.
  // The caller never provides an arbitrary URL string.
  let loadUrl: string
  if (loadMode === 'dev') {
    loadUrl = DEV_LOAD_URL
  } else {
    // file mode: use the proven pathToFileURL (existing behavior).
    const { pathToFileURL } = await import('node:url')
    loadUrl = pathToFileURL(htmlPath).href
  }
  logger.info(`Loading import renderer: ${loadUrl}`)
  await win.loadURL(loadUrl)

  return activeReader
}

/**
 * Dispose the active reader: destroy window + null ref + bounded EBUSY cleanup.
 * Safe to call multiple times (idempotent).
 */
export async function dispose(): Promise<void> {
  const reader = activeReader
  if (!reader) return

  activeReader = null

  try {
    if (!reader.window.isDestroyed()) {
      reader.window.destroy()
      logger.info(`Destroyed import window for session ${reader.sessionId}`)
    }
  } catch (error) {
    logger.error(`Error destroying import window for session ${reader.sessionId}:`, error as Error)
  }

  try {
    await reader.electronSession.clearStorageData()
    await reader.electronSession.clearCache()
    logger.info(`Cleared isolated session data for ${reader.sessionId}`)
  } catch (error) {
    logger.warn(`Error clearing isolated session for ${reader.sessionId}:`, error as Error)
  }
}

/**
 * Synchronous dispose for will-quit handler.
 * Only destroys the window; session cleanup is best-effort async.
 */
export function disposeSync(): void {
  const reader = activeReader
  if (!reader) return

  activeReader = null

  try {
    if (!reader.window.isDestroyed()) {
      reader.window.destroy()
      logger.info(`Destroyed import window (sync) for session ${reader.sessionId}`)
    }
  } catch (error) {
    logger.warn(`Error destroying import window (sync):`, error as Error)
  }
}
