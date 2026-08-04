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
  ChatImportProjectionPayload,
  DiscoveryResult,
  ImportErrorPayload,
  ReadPageRequest,
  ReadPageResponse,
  SourceReadStats
} from '@shared/chatImport/types'
import { validateSourceReadStats } from '@shared/chatImport/validation'
import { IpcChannel } from '@shared/IpcChannel'
import { ipcMain } from 'electron'

import { boundImportTableLabel, summarizeDataPlaneFailure, summarizeRendererError } from './importDataPlane'
import { getActiveReader } from './isolatedSession'

const logger = loggerService.withContext('chatDbImport')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Consumer callbacks passed by the orchestrator (index.ts).
 *
 * Phase 4.2 transport contract: every callback may return a Promise. The IPC
 * handlers await the callback before returning the ack envelope, so a slow
 * consumer (e.g. a downstream page writer) exerts backpressure on the
 * renderer, which awaits the invoke result before doing anything else.
 * Callback rejections are caught at the IPC boundary and converted into a
 * structured `{ ok: false, error }` ack — never an unhandled rejection.
 */
export interface ChatImportIpcCallbacks {
  onReady?: (sessionId: string) => void | Promise<void>
  onDiscover?: (sessionId: string, result: DiscoveryResult) => void | Promise<void>
  onReadPage?: (sessionId: string, response: ReadPageResponse) => void | Promise<void>
  onComplete?: (sessionId: string, stats: SourceReadStats) => void | Promise<void>
  onError?: (sessionId: string, error: ImportErrorPayload) => void | Promise<void>
  /**
   * LOCK-PROD-2/6: source Local Storage `persist:cherry-studio` payload.
   * Fire-and-forget (renderer → main). The raw string is never echoed back
   * over IPC — Main parses/validates and persists the minimal projection.
   */
  onProjection?: (sessionId: string, payload: ChatImportProjectionPayload) => void | Promise<void>
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
      try {
        await callbacks?.onReady?.(sessionId)
      } catch (error) {
        return callbackFailure(channel, sessionId, error)
      }
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
        `Discovery result for session ${typed.sessionId}: native=${typed.data.nativeVersion}, logical=${typed.data.logicalVersion}, tables=${typed.data.tableNames.length}`
      )
      try {
        await callbacks?.onDiscover?.(typed.sessionId, typed.data)
      } catch (error) {
        return callbackFailure(channel, typed.sessionId, error)
      }
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
        `Read page for session ${typed.sessionId}: table=${boundImportTableLabel(typed.data.tableName)}, ` +
          `items=${typed.data.items.length}, hasMore=${typed.data.hasMore}`
      )
      // Backpressure (LOCK-T2/T4): await the consumer before acking, so the
      // renderer cannot observe success until downstream processing finished.
      try {
        await callbacks?.onReadPage?.(typed.sessionId, typed.data)
      } catch (error) {
        return callbackFailure(channel, typed.sessionId, error)
      }
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
      const typed = envelope as ChatImportEnvelope<unknown>

      // Strict SourceReadStats validation (LOCK-T1/T6): exact key set,
      // safe non-negative integer counts. Reject anything else.
      let stats: SourceReadStats
      try {
        stats = validateSourceReadStats(typed.data, 'complete.data')
      } catch {
        // LOCK-PRIV-6: the ValidationError message can embed renderer-supplied
        // property names (e.g. `Unknown property '${key}'`) — never log it.
        logger.warn(`[${channel}] Invalid source read stats`)
        return
      }

      logger.info(`Import complete for session ${typed.sessionId}: ${JSON.stringify(stats)}`)
      // Fire-and-forget channel: contain async callback rejections locally
      // so they can never surface as unhandled rejections (LOCK-T3).
      void invokeContained(channel, typed.sessionId, () => callbacks?.onComplete?.(typed.sessionId, stats))
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
      // LOCK-PRIV-6: the renderer-reported `message` (and any untrusted
      // `code`) is never interpolated — only the allowlisted code family
      // plus static text crosses the log boundary.
      logger.error(`Import error for session ${typed.sessionId}: ${summarizeRendererError(typed.data)}`)
      void invokeContained(channel, typed.sessionId, () => callbacks?.onError?.(typed.sessionId, typed.data))
    }
    ipcMain.on(channel, handler)
    handlers.push({ channel, handler, type: 'on' })
  }

  // -------------------------------------------------------------------------
  // 6. ChatImport_Projection — renderer → main: source Local Storage payload
  //    (LOCK-PROD-2/6). Fire-and-forget; Main parses/validates and persists
  //    the minimal navigation projection with the candidate.
  // -------------------------------------------------------------------------
  {
    const channel = IpcChannel.ChatImport_Projection
    const handler = (event: Electron.IpcMainEvent, envelope: unknown): void => {
      if (!validateSender(event)) {
        logger.warn(`[${channel}] Rejected: sender identity mismatch`)
        return
      }
      const err = validateEnvelope(envelope, 'discovery')
      if (err) {
        logger.warn(`[${channel}] Invalid envelope: ${err}`)
        return
      }
      const typed = envelope as ChatImportEnvelope<ChatImportProjectionPayload>
      if (typed.data === null || typeof typed.data !== 'object') {
        logger.warn(`[${channel}] Invalid projection payload shape`)
        return
      }
      const persist = (typed.data as { persist?: unknown }).persist
      if (persist !== null && typeof persist !== 'string') {
        logger.warn(`[${channel}] Invalid projection persist value type`)
        return
      }
      logger.info(`Local Storage projection reported for session ${typed.sessionId}`)
      void invokeContained(channel, typed.sessionId, () =>
        callbacks?.onProjection?.(typed.sessionId, { persist: persist ?? null })
      )
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
// Internal callback containment (LOCK-T3)
// ---------------------------------------------------------------------------

/**
 * LOCK-PRIV-2/4/5: bound the failure summary that crosses the IPC boundary
 * or reaches the callback-failure log. When the error tree contains a
 * data-plane rejection (direct, wrapped in Error.cause, or inside
 * AggregateError.errors), ONLY its machine code + bounded table name is
 * exposed — never entityId, source/target IDs, error.detail, paths, content,
 * SQL, stack, wrapper messages, or the raw error.message. Error trees with
 * no data-plane rejection keep their existing message (transport contract).
 */
function sanitizeFailureMessage(error: unknown): string {
  return summarizeDataPlaneFailure(error)
}

/**
 * Convert a rejected consumer callback into a structured failure ack.
 * Sanitised: only the Error message (no stack) crosses the IPC boundary;
 * data-plane rejections anywhere in the error tree are summarized to
 * bounded code/table context (LOCK-PRIV-2/4/5).
 */
function callbackFailure(channel: string, sessionId: string, error: unknown): { ok: false; error: string } {
  const message = sanitizeFailureMessage(error)
  logger.error(`[${channel}] Consumer callback failed for session ${sessionId}: ${message}`)
  return { ok: false, error: `CALLBACK_FAILED: ${message}` }
}

/**
 * Invoke a possibly-async callback on a fire-and-forget channel, containing
 * both synchronous throws and promise rejections. Never rethrows. Data-plane
 * rejections anywhere in the error tree are summarized to bounded code/table
 * context (LOCK-PRIV-2/4/5).
 */
async function invokeContained(channel: string, sessionId: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (error) {
    const message = sanitizeFailureMessage(error)
    logger.error(`[${channel}] Consumer callback failed for session ${sessionId}: ${message}`)
  }
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
