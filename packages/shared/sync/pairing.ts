/**
 * Device registration + channel pairing types and input validation
 * (SYNC-CC-* target model).
 *
 * JSON-only, no Node/Electron imports. Single source of truth for pairing
 * field shapes used by Main, relay, and tests.
 *
 * - Device code: stable, relay-scoped, human-transcribable PUBLIC identifier.
 *   Routable by transcription, never an authorization credential.
 * - Device secret: durable per-device authorization material issued at
 *   registration. Never displayed, never logged, never transcribed.
 */

export type SyncPairRequestStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'replaced'

export interface SyncPairRequest {
  id: string
  requesterCode: string
  targetCode: string
  status: SyncPairRequestStatus
  createdAt: string
}

export interface SyncOutgoingPairRequest {
  id: string
  targetCode: string
  createdAt: string
}

export interface SyncIncomingPairRequest {
  id: string
  requesterCode: string
  createdAt: string
}

/**
 * Channel pairing state as observed via the relay (SYNC-CC-003/006):
 * Unpaired / Outgoing pending / Incoming pending / Paired. Shown separately
 * from the relay service connection state.
 */
export type SyncPairingState = 'unpaired' | 'outgoing' | 'incoming' | 'paired'

export interface SyncPairState {
  /** This device's public device code (stable, relay-scoped). Safe to display. */
  deviceCode: string
  state: SyncPairingState
  /** This device's outgoing pending request, if any. */
  outgoing: SyncOutgoingPairRequest | null
  /** Pending requests addressed to this device. */
  incoming: SyncIncomingPairRequest[]
}

export const SYNC_DEVICE_CODE_LENGTH = 8
export const SYNC_DEVICE_NAME_MAX_LENGTH = 64

const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/

export function isValidSyncDeviceId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim().length > 0
}

export function validateSyncDeviceName(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') return 'device name must be string'
  if (value.length > SYNC_DEVICE_NAME_MAX_LENGTH) return 'device name too long'
  if (/[\x00-\x1f\x7f]/.test(value)) return 'device name contains control characters'
  return null
}

/**
 * Validate a public device code (also used for pair-target transcription).
 * The code is public by design and carries no authorization power.
 */
export function validatePairingCode(value: unknown): string | null {
  if (typeof value !== 'string') return 'device code must be string'
  const trimmed = value.trim().toUpperCase()
  if (!CODE_PATTERN.test(trimmed)) return 'device code must be 8 unambiguous alphanumeric characters'
  return null
}

export function normalizePairingCode(value: string): string {
  return value.trim().toUpperCase()
}

export function validatePairingRequestId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    return 'request id must be a non-empty string'
  }
  return null
}

/**
 * Per-device relay credential: a 32-byte random secret issued by the relay
 * at registration time and presented on every subsequent device-authenticated
 * call. The relay stores only the SHA-256 hash; the plaintext travels only
 * in the registration response and the `X-Sync-Device-Secret` header, and is
 * never logged, displayed, or transcribed. A device code alone never proves
 * device identity.
 */
export const SYNC_DEVICE_CODE_HEADER = 'x-sync-device-code'
export const SYNC_DEVICE_SECRET_HEADER = 'x-sync-device-secret'

const DEVICE_SECRET_PATTERN = /^[0-9a-fA-F]{64}$/

export function isValidSyncDeviceAuth(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_SECRET_PATTERN.test(value)
}

export function validateSyncDeviceAuth(value: unknown): string | null {
  if (!isValidSyncDeviceAuth(value)) return 'device auth invalid'
  return null
}
