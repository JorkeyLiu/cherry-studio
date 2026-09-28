/**
 * Save-data handshake wire DTOs (Main ↔ renderer, main window only).
 *
 * Design rules:
 * - JSON-only types. No Electron, Node, or renderer imports.
 * - `App_SaveData` (Main → renderer) now carries a `SaveDataRequest`
 *   envelope so the renderer ack can be correlated by `requestId`.
 * - `App_SaveDataAck` (renderer → Main, invoke) carries a `SaveDataAck`.
 *   The renderer MUST ack both flush success and flush failure; Main
 *   records the outcome but still allows close.
 * - Only the main window holds/flushes redux-persist, so only the main
 *   window participates in this handshake.
 */

/** Ack outcome code for a settled save-data request. */
export type SaveDataAckCode = 'flushed' | 'flush-failed'

/**
 * Main → renderer: request a redux-persist flush before close/quit.
 */
export interface SaveDataRequest {
  /** Unique per-request correlation id (opaque, Main-minted). */
  requestId: string
}

/**
 * Renderer → Main: flush outcome for one `SaveDataRequest`.
 * Sent for BOTH success and failure — Main records failures/timeouts
 * but still allows close.
 */
export interface SaveDataAck {
  /** Correlation id of the `SaveDataRequest` being settled. */
  requestId: string
  /** True when `persistor.flush()` resolved; false when it threw. */
  ok: boolean
  /** Outcome code (`flushed` on success, `flush-failed` on failure). */
  code?: SaveDataAckCode
}

/** Max accepted `requestId` length (bounded contract validation). */
export const SAVE_DATA_REQUEST_ID_MAX_LENGTH = 128

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= SAVE_DATA_REQUEST_ID_MAX_LENGTH
}

/**
 * Bounded contract validation for `SaveDataRequest` wire payloads.
 * Rejects non-objects, missing/empty/overlong ids, and extra keys.
 */
export function isSaveDataRequest(value: unknown): value is SaveDataRequest {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== 'requestId') return false
  return isValidRequestId(value.requestId)
}

/**
 * Bounded contract validation for `SaveDataAck` wire payloads.
 * Rejects non-objects, bad ids, non-boolean `ok`, unknown codes, and
 * extra keys.
 */
export function isSaveDataAck(value: unknown): value is SaveDataAck {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (keys.length < 2 || keys.length > 3) return false
  if (!keys.includes('requestId') || !keys.includes('ok')) return false
  if (!isValidRequestId(value.requestId)) return false
  if (typeof value.ok !== 'boolean') return false
  if (keys.includes('code')) {
    if (value.code !== 'flushed' && value.code !== 'flush-failed') return false
  }
  if (keys.some((k) => k !== 'requestId' && k !== 'ok' && k !== 'code')) return false
  return true
}
