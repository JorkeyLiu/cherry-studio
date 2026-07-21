/**
 * Import-only IPC handler registration.
 *
 * Registers IPC handlers for the 5 ChatImport channels:
 * - ipcMain.handle: ChatImport_Ready, ChatImport_Discover, ChatImport_ReadPage
 *   (renderer→main request/response via ipcRenderer.invoke)
 * - ipcMain.on: ChatImport_Complete, ChatImport_Error
 *   (renderer→main fire-and-forget via ipcRenderer.send)
 *
 * Main→renderer sends use webContents.send on the same channel names:
 * - ChatImport_Discover, ChatImport_ReadPage, ChatImport_Cancel
 *
 * Design follows src/main/services/chatDb/ipc.ts:
 * - Re-registration safety (stale-disposer ownership)
 * - Identity validation via event.senderFrame
 * - Structured error handling
 * - Returns disposer that removes only this registration's listeners
 *
 * R-9: event.senderFrame validation in every Main handler.
 */

import { loggerService } from '@logger'
import type {
  ChatImportEnvelope,
  DiscoveryResult,
  ImportErrorPayload,
  ReadPageRequest,
  ReadPageResponse,
  SourceStats
} from '@shared/chatImport/types'
import { IpcChannel } from '@shared/IpcChannel'
import { ipcMain } from 'electron'

import { getActiveReader } from './isolatedSession'

const logger = loggerService.withContext('chatDbImport')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Consumer callbacks passed by the orchestrator (index.ts). */
export interface ChatImportIpcCallbacks {
  onReady?: (sessionId: string) => void
  onDiscover?: (sessionId: string, result: DiscoveryResult) => void
  onReadPage?: (sessionId: string, response: ReadPageResponse) => void
  onComplete?: (sessionId: string, stats: SourceStats) => void
  onError?: (sessionId: string, error: ImportErrorPayload) => void
}

// ---------------------------------------------------------------------------
// Module-level registration state — same pattern as chatDb/ipc.ts
// ---------------------------------------------------------------------------

let activeRegistrationId = 0
let activeDisposer: (() => void) | null = null

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register all ChatImport IPC handlers.
 *
 * Returns a disposer function that removes only this registration's handlers.
 * Re-registration safety: disposing a prior registration before installing new.
 *
 * @param callbacks Consumer callbacks invoked when the renderer sends data.
 */
export function registerChatImportIpc(callbacks?: ChatImportIpcCallbacks): () => void {
  // Dispose any prior registration
  if (activeDisposer) {
    logger.info('Disposing prior ChatImport IPC registration before re-registering')
    activeDisposer()
    activeDisposer = null
  }

  const registrationId = ++activeRegistrationId
  const handlers: Array<{ channel: string; handler: (...args: any[]) => any; type: 'handle' | 'on' }> = []

  /**
   * Helper: validate sender identity (R-9).
   * Returns true if the sender matches the active reader's main frame.
   */
  function validateSender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
    const reader = getActiveReader()
    if (!reader) return false
    return event.senderFrame === reader.window.webContents.mainFrame
  }

  // -------------------------------------------------------------------------
  // 1. ChatImport_Ready — renderer → main: ready handshake
  // -------------------------------------------------------------------------
  {
    const channel = IpcChannel.ChatImport_Ready
    const handler = async (
      event: Electron.IpcMainInvokeEvent,
      sessionId: string
    ): Promise<{ ok: boolean; error?: string }> => {
      if (!validateSender(event)) {
        logger.warn(`[${channel}] Rejected: sender identity mismatch`)
        return { ok: false, error: 'Sender identity mismatch' }
      }
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return { ok: false, error: 'Invalid sessionId' }
      }
      logger.info(`Import renderer ready for session ${sessionId}`)
      callbacks?.onReady?.(sessionId)
      return { ok: true }
    }
    ipcMain.handle(channel, handler)
    handlers.push({ channel, handler, type: 'handle' })
  }

  // -------------------------------------------------------------------------
  // 2. ChatImport_Discover — renderer → main: discovery result
  //    (also used main → renderer via webContents.send to trigger discovery)
  // -------------------------------------------------------------------------
  {
    const channel = IpcChannel.ChatImport_Discover
    const handler = async (
      event: Electron.IpcMainInvokeEvent,
      envelope: unknown
    ): Promise<{ ok: boolean; error?: string }> => {
      if (!validateSender(event)) {
        logger.warn(`[${channel}] Rejected: sender identity mismatch`)
        return { ok: false, error: 'Sender identity mismatch' }
      }
      const err = validateEnvelope(envelope, 'discovery')
      if (err) {
        logger.warn(`[${channel}] Invalid envelope: ${err}`)
        return { ok: false, error: err }
      }
      const typed = envelope as ChatImportEnvelope<DiscoveryResult>

      // Validate DiscoveryResult shape
      const resultErr = validateDiscoveryResult(typed.data)
      if (resultErr) {
        logger.warn(`[${channel}] Invalid discovery result: ${resultErr}`)
        return { ok: false, error: resultErr }
      }

      // Defense-in-depth: validate nativeVersion < 120
      if (typed.data.nativeVersion >= 120) {
        const msg = `Source database version (${typed.data.nativeVersion}) is from a future Cherry Studio version. Maximum supported native version is 119.`
        logger.warn(`[${channel}] ${msg}`)
        return { ok: false, error: `FUTURE_VERSION_REJECTED: ${msg}` }
      }

      logger.info(
        `Discovery result for session ${typed.sessionId}: native=${typed.data.nativeVersion}, logical=${typed.data.logicalVersion}, tables=${typed.data.tableNames.join(',')}`
      )
      callbacks?.onDiscover?.(typed.sessionId, typed.data)
      return { ok: true }
    }
    ipcMain.handle(channel, handler)
    handlers.push({ channel, handler, type: 'handle' })
  }

  // -------------------------------------------------------------------------
  // 3. ChatImport_ReadPage — renderer → main: page of data
  //    (also used main → renderer via webContents.send to request pages)
  // -------------------------------------------------------------------------
  {
    const channel = IpcChannel.ChatImport_ReadPage
    const handler = async (
      event: Electron.IpcMainInvokeEvent,
      envelope: unknown
    ): Promise<{ ok: boolean; error?: string }> => {
      if (!validateSender(event)) {
        logger.warn(`[${channel}] Rejected: sender identity mismatch`)
        return { ok: false, error: 'Sender identity mismatch' }
      }
      const err = validateEnvelope(envelope, 'reading')
      if (err) {
        logger.warn(`[${channel}] Invalid envelope: ${err}`)
        return { ok: false, error: err }
      }
      const typed = envelope as ChatImportEnvelope<ReadPageResponse>

      // Validate ReadPageResponse shape
      const respErr = validateReadPageResponse(typed.data)
      if (respErr) {
        logger.warn(`[${channel}] Invalid read page response: ${respErr}`)
        return { ok: false, error: respErr }
      }

      logger.info(
        `Read page for session ${typed.sessionId}: table=${typed.data.tableName}, items=${typed.data.items.length}, hasMore=${typed.data.hasMore}`
      )
      callbacks?.onReadPage?.(typed.sessionId, typed.data)
      return { ok: true }
    }
    ipcMain.handle(channel, handler)
    handlers.push({ channel, handler, type: 'handle' })
  }

  // -------------------------------------------------------------------------
  // 4. ChatImport_Complete — renderer → main: all data sent (fire-and-forget)
  // -------------------------------------------------------------------------
  {
    const channel = IpcChannel.ChatImport_Complete
    const handler = (event: Electron.IpcMainEvent, envelope: unknown): void => {
      if (!validateSender(event)) {
        logger.warn(`[${channel}] Rejected: sender identity mismatch`)
        return
      }
      const err = validateEnvelope(envelope, 'complete')
      if (err) {
        logger.warn(`[${channel}] Invalid envelope: ${err}`)
        return
      }
      const typed = envelope as ChatImportEnvelope<SourceStats>
      logger.info(`Import complete for session ${typed.sessionId}: ${JSON.stringify(typed.data)}`)
      callbacks?.onComplete?.(typed.sessionId, typed.data)
    }
    ipcMain.on(channel, handler)
    handlers.push({ channel, handler, type: 'on' })
  }

  // -------------------------------------------------------------------------
  // 5. ChatImport_Error — renderer → main: error report (fire-and-forget)
  // -------------------------------------------------------------------------
  {
    const channel = IpcChannel.ChatImport_Error
    const handler = (event: Electron.IpcMainEvent, envelope: unknown): void => {
      if (!validateSender(event)) {
        logger.warn(`[${channel}] Rejected: sender identity mismatch`)
        return
      }
      const err = validateEnvelope(envelope, 'error')
      if (err) {
        logger.warn(`[${channel}] Invalid envelope: ${err}`)
        return
      }
      const typed = envelope as ChatImportEnvelope<ImportErrorPayload>
      logger.error(`Import error for session ${typed.sessionId}: [${typed.data.code}] ${typed.data.message}`)
      callbacks?.onError?.(typed.sessionId, typed.data)
    }
    ipcMain.on(channel, handler)
    handlers.push({ channel, handler, type: 'on' })
  }

  logger.info(`Registered ${handlers.length} ChatImport IPC handlers (registration #${registrationId})`)

  // Build disposer with ownership check (same pattern as chatDb/ipc.ts)
  const disposer = () => {
    if (activeRegistrationId !== registrationId) {
      logger.warn(
        `Stale ChatImport disposer (registration #${registrationId}) ignored; active is #${activeRegistrationId}`
      )
      return
    }
    for (const { channel, type } of handlers) {
      if (type === 'handle') {
        ipcMain.removeHandler(channel)
      } else {
        ipcMain.removeAllListeners(channel)
      }
    }
    logger.info(`Removed ${handlers.length} ChatImport IPC handlers (registration #${registrationId})`)
    if (activeRegistrationId === registrationId) {
      activeDisposer = null
    }
  }

  activeDisposer = disposer
  return disposer
}

// ---------------------------------------------------------------------------
// Helpers — send messages TO the renderer via webContents.send
// ---------------------------------------------------------------------------

/**
 * Send a discover request to the import renderer.
 */
export function sendDiscover(sessionId: string): void {
  const reader = getActiveReader()
  if (!reader || reader.sessionId !== sessionId) {
    logger.warn(`Cannot send discover: no active reader for session ${sessionId}`)
    return
  }
  reader.window.webContents.send(IpcChannel.ChatImport_Discover, { sessionId })
}

/**
 * Send a read-page request to the import renderer.
 */
export function sendReadPage(sessionId: string, request: ReadPageRequest): void {
  const reader = getActiveReader()
  if (!reader || reader.sessionId !== sessionId) {
    logger.warn(`Cannot send read-page: no active reader for session ${sessionId}`)
    return
  }
  reader.window.webContents.send(IpcChannel.ChatImport_ReadPage, { sessionId, ...request })
}

/**
 * Send a cancel signal to the import renderer.
 */
export function sendCancel(sessionId: string): void {
  const reader = getActiveReader()
  if (!reader || reader.sessionId !== sessionId) {
    logger.warn(`Cannot send cancel: no active reader for session ${sessionId}`)
    return
  }
  reader.window.webContents.send(IpcChannel.ChatImport_Cancel, { sessionId })
}

// ---------------------------------------------------------------------------
// Internal validation
// ---------------------------------------------------------------------------

/**
 * Validate envelope structure. Returns error message or null if valid.
 */
function validateEnvelope(value: unknown, expectedPhase: string): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'Envelope must be a plain object'
  }
  const env = value as Record<string, unknown>
  if (typeof env.sessionId !== 'string' || env.sessionId.length === 0) {
    return 'Envelope "sessionId" must be a non-empty string'
  }
  if (env.phase !== expectedPhase) {
    return `Envelope "phase" must be "${expectedPhase}", got "${String(env.phase)}"`
  }
  if (env.version !== 1) {
    return `Envelope "version" must be 1, got ${JSON.stringify(env.version)}`
  }
  if (env.data === undefined || env.data === null) {
    return 'Envelope "data" must not be null/undefined'
  }
  return null
}

/**
 * Validate DiscoveryResult shape. Returns error message or null if valid.
 */
function validateDiscoveryResult(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) {
    return 'DiscoveryResult must be an object'
  }
  const d = data as Record<string, unknown>
  if (typeof d.databaseName !== 'string') {
    return 'DiscoveryResult "databaseName" must be a string'
  }
  if (typeof d.nativeVersion !== 'number') {
    return 'DiscoveryResult "nativeVersion" must be a number'
  }
  if (typeof d.logicalVersion !== 'number') {
    return 'DiscoveryResult "logicalVersion" must be a number'
  }
  if (!Array.isArray(d.tableNames)) {
    return 'DiscoveryResult "tableNames" must be an array'
  }
  return null
}

/**
 * Validate ReadPageResponse shape. Returns error message or null if valid.
 */
function validateReadPageResponse(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) {
    return 'ReadPageResponse must be an object'
  }
  const d = data as Record<string, unknown>
  if (typeof d.tableName !== 'string') {
    return 'ReadPageResponse "tableName" must be a string'
  }
  if (!Array.isArray(d.items)) {
    return 'ReadPageResponse "items" must be an array'
  }
  if (typeof d.hasMore !== 'boolean') {
    return 'ReadPageResponse "hasMore" must be a boolean'
  }
  return null
}
