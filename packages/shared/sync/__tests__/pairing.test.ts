import { describe, expect, it } from 'vitest'

import {
  isValidSyncDeviceId,
  normalizePairingCode,
  validatePairingCode,
  validatePairingRequestId,
  validateSyncDeviceName
} from '../pairing'

describe('pairing validation', () => {
  it('accepts valid device ids and rejects malformed', () => {
    expect(isValidSyncDeviceId('device-1')).toBe(true)
    expect(isValidSyncDeviceId('')).toBe(false)
    expect(isValidSyncDeviceId('   ')).toBe(false)
    expect(isValidSyncDeviceId(null)).toBe(false)
    expect(isValidSyncDeviceId('x'.repeat(257))).toBe(false)
  })

  it('validates pairing codes strictly', () => {
    expect(validatePairingCode('ABCDEFGH')).toBeNull()
    expect(validatePairingCode('abcdefgh')).toBeNull()
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
})
