/**
 * Device pairing + trust types and input validation (LOCK-001/004 scope).
 * JSON-only, no Node/Electron imports. Single source of truth for pairing
 * field shapes used by Main, relay, and tests.
 */

export type SyncPairingRequestStatus = 'pending' | 'accepted' | 'rejected' | 'expired'

export interface SyncTrustedDevice {
  deviceId: string
  deviceName?: string
  trustedAt: string
  source: string
}

export interface SyncPairingRequest {
  id: string
  deviceId: string
  deviceName?: string
  code: string
  createdAt: string
  expiresAt: string
  status: SyncPairingRequestStatus
}

export interface SyncPairingInvite {
  code: string
  inviterDeviceId: string
  createdAt: string
  expiresAt: string
  used: boolean
}

export interface SyncPairingStatus {
  trusted: boolean
  pending: boolean
}

export const SYNC_PAIRING_CODE_LENGTH = 8
export const SYNC_PAIRING_INVITE_TTL_MS = 15 * 60 * 1000
export const SYNC_PAIRING_REQUEST_TTL_MS = 15 * 60 * 1000
export const SYNC_DEVICE_NAME_MAX_LENGTH = 64

const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/

export function isValidSyncDeviceId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim().length > 0
}

export function validateSyncDeviceName(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') return 'device name must be string'
  if (value.length > SYNC_DEVICE_NAME_MAX_LENGTH) return 'device name too long'
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'device name contains control characters'
  return null
}

export function validatePairingCode(value: unknown): string | null {
  if (typeof value !== 'string') return 'pairing code must be string'
  const trimmed = value.trim().toUpperCase()
  if (!CODE_PATTERN.test(trimmed)) return 'pairing code must be 8 unambiguous alphanumeric characters'
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
 * Per-device relay credential (F-001 binding): a 32-byte random secret
 * issued by the relay at trust-establishment time (founder bootstrap or
 * pairing-request) and presented on every subsequent device-authenticated
 * call. The relay stores only the SHA-256 hash; the plaintext travels only
 * in the issuance response and the `X-Sync-Device-Auth` header, and is never
 * logged. A shared relay token alone never proves device identity.
 */
export const SYNC_DEVICE_ID_HEADER = 'x-sync-device-id'
export const SYNC_DEVICE_AUTH_HEADER = 'x-sync-device-auth'

const DEVICE_AUTH_PATTERN = /^[0-9a-fA-F]{64}$/

export function isValidSyncDeviceAuth(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_AUTH_PATTERN.test(value)
}

export function validateSyncDeviceAuth(value: unknown): string | null {
  if (!isValidSyncDeviceAuth(value)) return 'device auth invalid'
  return null
}
