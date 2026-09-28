import { loggerService } from '@logger'
import type { SaveDataAck } from '@shared/saveData'
import { isSaveDataRequest } from '@shared/saveData'

const logger = loggerService.withContext('SaveData')

export interface SaveDataHandlerDeps {
  /** Flushes redux-persist (the real `handleSaveData`). */
  flush: () => Promise<void>
  /** Sends the ack back to Main (preload typed surface). */
  ack: (ack: SaveDataAck) => Promise<unknown>
}

/**
 * Creates the renderer save-data request handler (main window only).
 *
 * - Handshake requests (`SaveDataRequest` envelope) are deduped by
 *   `requestId` and ALWAYS acked: `ok:true/code:flushed` on success,
 *   `ok:false/code:flush-failed` when the flush throws — so Main never
 *   waits past its timeout for a dead renderer.
 * - Legacy fire-and-forget signals (`undefined`, from close-to-tray hide
 *   and power-shutdown hints that carry no `requestId`) flush best-effort
 *   with no ack — their behavior never changes and is never blocked.
 * - Any other malformed payload is dropped (no ack is possible without a
 *   valid `requestId`).
 */
export function createSaveDataHandler(deps: SaveDataHandlerDeps): (request: unknown) => Promise<void> {
  const seen = new Set<string>()
  return async (request: unknown): Promise<void> => {
    if (request === undefined) {
      // Legacy fire-and-forget flush hint (tray-hide / power-shutdown):
      // best-effort flush, no ack, never blocked.
      try {
        await deps.flush()
      } catch (error) {
        logger.error('Failed to flush redux persistor on legacy save-data signal:', error as Error)
      }
      return
    }
    if (!isSaveDataRequest(request)) {
      logger.warn('Ignoring malformed save-data request')
      return
    }
    const { requestId } = request
    if (seen.has(requestId)) {
      return
    }
    seen.add(requestId)
    let ok = true
    let code: SaveDataAck['code'] = 'flushed'
    try {
      await deps.flush()
    } catch (error) {
      ok = false
      code = 'flush-failed'
      logger.error('Failed to flush redux persistor on save-data request:', error as Error)
    }
    try {
      await deps.ack({ requestId, ok, code })
    } catch (error) {
      logger.error('Failed to ack save-data request:', error as Error)
    }
  }
}
