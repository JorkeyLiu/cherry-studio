import { loggerService } from '@logger'
import { IpcChannel } from '@shared/IpcChannel'
import type { SaveDataRequest } from '@shared/saveData'
import { isSaveDataAck } from '@shared/saveData'
import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'

const logger = loggerService.withContext('SaveDataHandshake')

/** Bounded wait for the renderer `persistor.flush()` ack (2–5s per contract). */
export const SAVE_DATA_HANDSHAKE_TIMEOUT_MS = 3000

/** Settle outcome of one save-data request. */
export type SaveDataSettleStatus =
  | 'acked-ok'
  | 'acked-failed'
  | 'timeout'
  | 'no-window'
  | 'send-failed'
  | 'window-gone'
  | 'disposed'

export interface SaveDataSettleResult {
  status: SaveDataSettleStatus
  requestId: string
}

interface PendingEntry {
  target: Electron.WebContents
  mainFrame: Electron.WebFrameMain | null
  resolve: (result: SaveDataSettleResult) => void
  timer: NodeJS.Timeout
}

function mintRequestId(seq: number): string {
  return `savedata-${Date.now().toString(36)}-${seq.toString(36)}`
}

/**
 * Main-side save-data handshake (main window only).
 *
 * - `requestSave(window)` sends `App_SaveData` with a fresh `requestId`
 *   and resolves when the matching renderer ack arrives, the timeout
 *   fires, or the window is destroyed / its renderer is gone.
 * - Acks are accepted only from the target sender + main frame with a
 *   matching pending `requestId`; late/stale/foreign acks are ignored.
 * - Failures and timeouts are recorded via logger but still settle so
 *   close/quit is never blocked indefinitely.
 * - `dispose()` removes the invoke handler and settles all pending as
 *   `disposed` (test multi-instance safety; no duplicate `ipcMain.handle`).
 */
export class SaveDataHandshake {
  private pending = new Map<string, PendingEntry>()
  private seq = 0
  private registered = false

  public register(): void {
    if (this.registered) return
    ipcMain.handle(IpcChannel.App_SaveDataAck, (event, ack: unknown) => this.settleFromAck(event, ack))
    this.registered = true
  }

  public dispose(): void {
    if (this.registered) {
      try {
        ipcMain.removeHandler(IpcChannel.App_SaveDataAck)
      } catch (error) {
        logger.warn('Failed to remove save-data ack handler:', error as Error)
      }
      this.registered = false
    }
    for (const [requestId, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.resolve({ status: 'disposed', requestId })
    }
    this.pending.clear()
  }

  /** True while a save-data request is in flight for `window`. */
  public hasPending(window: BrowserWindow): boolean {
    if (window.isDestroyed()) return false
    const contents = window.webContents
    for (const entry of this.pending.values()) {
      if (entry.target === contents) return true
    }
    return false
  }

  public requestSave(
    window: BrowserWindow | null,
    timeoutMs: number = SAVE_DATA_HANDSHAKE_TIMEOUT_MS
  ): Promise<SaveDataSettleResult> {
    if (!window || window.isDestroyed()) {
      return Promise.resolve({ status: 'no-window', requestId: '' })
    }
    const requestId = mintRequestId(this.seq++)
    const contents = window.webContents
    return new Promise<SaveDataSettleResult>((resolve) => {
      const settle = (status: SaveDataSettleStatus): void => {
        const entry = this.pending.get(requestId)
        if (!entry) return
        clearTimeout(entry.timer)
        this.pending.delete(requestId)
        if (status === 'acked-failed' || status === 'timeout' || status === 'window-gone') {
          logger.warn(`Save-data handshake settled without clean flush (status=${status})`, {
            requestId,
            status
          })
        } else {
          logger.info(`Save-data handshake settled (status=${status})`, { requestId, status })
        }
        resolve({ status, requestId })
      }

      const timer = setTimeout(() => settle('timeout'), timeoutMs)
      // `unref` so a pending handshake can never keep the process alive.
      if (typeof timer.unref === 'function') {
        timer.unref()
      }
      this.pending.set(requestId, {
        target: contents,
        mainFrame: contents.mainFrame ?? null,
        resolve: (result) => settle(result.status),
        timer
      })

      const settleGone = (): void => settle('window-gone')
      window.once('closed', settleGone)
      contents.once('destroyed', settleGone)
      contents.once('render-process-gone', settleGone)

      try {
        contents.send(IpcChannel.App_SaveData, { requestId } satisfies SaveDataRequest)
      } catch (error) {
        logger.error('Failed to send save-data request:', error as Error)
        window.removeListener('closed', settleGone)
        settle('send-failed')
      }
    })
  }

  private settleFromAck(event: Electron.IpcMainInvokeEvent, ack: unknown): void {
    if (!isSaveDataAck(ack)) {
      logger.warn('Ignoring malformed save-data ack')
      return
    }
    const entry = this.pending.get(ack.requestId)
    if (!entry) {
      // Late ack for an already-settled request — must not settle anything new.
      return
    }
    if (event.sender !== entry.target) {
      logger.warn('Ignoring save-data ack from unexpected sender')
      return
    }
    if (entry.mainFrame && event.senderFrame && event.senderFrame !== entry.mainFrame) {
      logger.warn('Ignoring save-data ack from unexpected frame')
      return
    }
    entry.resolve({ status: ack.ok ? 'acked-ok' : 'acked-failed', requestId: ack.requestId })
  }
}

/** Process-wide singleton for production wiring. */
export const saveDataHandshake = new SaveDataHandshake()
