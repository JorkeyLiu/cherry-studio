import { describe, expect, it } from 'vitest'

import {
  isValidSyncDeviceAuth,
  isValidSyncDeviceId,
  normalizePairingCode,
  SYNC_DEVICE_CODE_HEADER,
  SYNC_DEVICE_SECRET_HEADER,
  validatePairingCode,
  validatePairingRequestId,
  validateSyncDeviceAuth,
  validateSyncDeviceName
} from '../pairing'

describe('device-code and credential validation (SYNC-CC-007)', () => {
  it('accepts valid device ids and rejects malformed', () => {
    expect(isValidSyncDeviceId('device-1')).toBe(true)
    expect(isValidSyncDeviceId('')).toBe(false)
    expect(isValidSyncDeviceId('   ')).toBe(false)
    expect(isValidSyncDeviceId(null)).toBe(false)
    expect(isValidSyncDeviceId('x'.repeat(257))).toBe(false)
  })

  it('validates public device codes strictly (transcribable, unambiguous)', () => {
    expect(validatePairingCode('ABCDEFGH')).toBeNull()
    expect(validatePairingCode('abcdefgh')).toBeNull()
    expect(validatePairingCode('  abcd2345  ')).toBeNull()
    // Ambiguous characters (0/O, 1/I/L) are excluded from the alphabet.
    expect(validatePairingCode('ABCD01EF')).not.toBeNull()
    expect(validatePairingCode('ABC-DEFG')).not.toBeNull()
    expect(validatePairingCode('SHORT')).not.toBeNull()
    expect(validatePairingCode('')).not.toBeNull()
    expect(validatePairingCode(null)).not.toBeNull()
    expect(normalizePairingCode('abcdefgh')).toBe('ABCDEFGH')
  })

  it('validates device names and request ids', () => {
    expect(validateSyncDeviceName(undefined)).toBeNull()
    expect(validateSyncDeviceName('laptop')).toBeNull()
    expect(validateSyncDeviceName('x'.repeat(65))).not.toBeNull()
    expect(validatePairingRequestId('req-1')).toBeNull()
    expect(validatePairingRequestId('')).not.toBeNull()
  })

  it('validates the durable secret credential strictly (never transcribed)', () => {
    const secret = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
    expect(isValidSyncDeviceAuth(secret)).toBe(true)
    expect(isValidSyncDeviceAuth(secret.toUpperCase())).toBe(true)
    expect(validateSyncDeviceAuth(secret)).toBeNull()
    expect(isValidSyncDeviceAuth('short')).toBe(false)
    expect(isValidSyncDeviceAuth('')).toBe(false)
    expect(isValidSyncDeviceAuth(null)).toBe(false)
    expect(validateSyncDeviceAuth('ABCDEFGH')).not.toBeNull()
    // A device code is not a credential and vice versa.
    expect(isValidSyncDeviceAuth('ABCDEFGH')).toBe(false)
    expect(validatePairingCode(secret)).not.toBeNull()
  })

  it('uses distinct code/secret header names', () => {
    expect(SYNC_DEVICE_CODE_HEADER).not.toBe(SYNC_DEVICE_SECRET_HEADER)
    expect(SYNC_DEVICE_CODE_HEADER).toContain('code')
    expect(SYNC_DEVICE_SECRET_HEADER).toContain('secret')
  })
})
