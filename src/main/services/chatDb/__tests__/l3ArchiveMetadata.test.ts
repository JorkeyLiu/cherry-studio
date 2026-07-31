/**
 * L3 Archive Metadata Contract Tests
 *
 * Tests metadata creation, validation, version evolution, rejection
 * of unsupported/malformed/foreign archives, and bounded backward
 * compatibility with v6 direct archives.
 *
 * LOCK-6001: L3 means Cherry Chat same-application backup/restore.
 * LOCK-6004: New archives use versioned discriminator; v6 remains compatible.
 * LOCK-6005: Validate metadata before staging or destructive replacement.
 */

import { describe, expect, it, vi } from 'vitest'

// Mock electron app for createL3ArchiveMetadata
vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '1.0.0-test')
  }
}))

import {
  createL3ArchiveMetadata,
  L3_ARCHIVE_VERSION,
  L3_MAX_SUPPORTED_VERSION,
  L3_MIN_SUPPORTED_VERSION,
  L3_PRODUCT,
  L3_PURPOSE,
  validateL3ArchiveMetadata
} from '../l3ArchiveMetadata'

describe('L3 Archive Metadata Contract', () => {
  // =========================================================================
  // 1. createL3ArchiveMetadata
  // =========================================================================

  describe('createL3ArchiveMetadata', () => {
    it('should emit version 7 metadata with product and purpose', () => {
      const metadata = createL3ArchiveMetadata()

      expect(metadata.version).toBe(L3_ARCHIVE_VERSION)
      expect(metadata.version).toBe(7)
      expect(metadata.product).toBe(L3_PRODUCT)
      expect(metadata.purpose).toBe(L3_PURPOSE)
      expect(metadata.appName).toBe('Cherry Studio')
      expect(metadata.appVersion).toBe('1.0.0-test')
      expect(metadata.timestamp).toBeGreaterThan(0)
      expect(typeof metadata.platform).toBe('string')
      expect(typeof metadata.arch).toBe('string')
    })

    it('should produce deterministic structure across calls', () => {
      const m1 = createL3ArchiveMetadata()
      const m2 = createL3ArchiveMetadata()

      // Same structure (timestamps will differ)
      expect(Object.keys(m1).sort()).toEqual(Object.keys(m2).sort())
      expect(m1.version).toBe(m2.version)
      expect(m1.product).toBe(m2.product)
      expect(m1.purpose).toBe(m2.purpose)
      expect(m1.appName).toBe(m2.appName)
    })
  })

  // =========================================================================
  // 2. validateL3ArchiveMetadata — valid archives
  // =========================================================================

  describe('validateL3ArchiveMetadata — valid archives', () => {
    it('should accept a current L3 v7 archive', () => {
      const metadata = createL3ArchiveMetadata()
      expect(validateL3ArchiveMetadata(metadata)).toBeNull()
    })

    it('should accept a v6 archive (bounded backward compatibility)', () => {
      const v6 = {
        version: 6,
        timestamp: Date.now(),
        appName: 'Cherry Studio',
        appVersion: '1.0.0',
        platform: 'darwin',
        arch: 'arm64'
        // No product or purpose — v6 doesn't have them
      }
      expect(validateL3ArchiveMetadata(v6)).toBeNull()
    })

    it('should accept a v7 archive with explicit product/purpose', () => {
      const v7 = {
        version: 7,
        timestamp: Date.now(),
        appName: 'Cherry Studio',
        appVersion: '1.0.0',
        platform: 'darwin',
        arch: 'arm64',
        product: 'Cherry Chat',
        purpose: 'l3-backup'
      }
      expect(validateL3ArchiveMetadata(v7)).toBeNull()
    })

    it('should accept a v7 archive with extra fields', () => {
      const v7extra = {
        version: 7,
        timestamp: Date.now(),
        appName: 'Cherry Studio',
        appVersion: '1.0.0',
        platform: 'darwin',
        arch: 'arm64',
        product: 'Cherry Chat',
        purpose: 'l3-backup',
        extraField: 'ignored'
      }
      expect(validateL3ArchiveMetadata(v7extra)).toBeNull()
    })
  })

  // =========================================================================
  // 3. validateL3ArchiveMetadata — rejection cases
  // =========================================================================

  describe('validateL3ArchiveMetadata — rejection', () => {
    it('should reject null/undefined metadata', () => {
      expect(validateL3ArchiveMetadata(null)).toEqual({ reason: 'METADATA_NOT_OBJECT' })
      expect(validateL3ArchiveMetadata(undefined)).toEqual({ reason: 'METADATA_NOT_OBJECT' })
    })

    it('should reject non-object metadata', () => {
      expect(validateL3ArchiveMetadata('string')).toEqual({ reason: 'METADATA_NOT_OBJECT' })
      expect(validateL3ArchiveMetadata(42)).toEqual({ reason: 'METADATA_NOT_OBJECT' })
      expect(validateL3ArchiveMetadata(true)).toEqual({ reason: 'METADATA_NOT_OBJECT' })
    })

    it('should reject metadata with non-numeric version', () => {
      expect(validateL3ArchiveMetadata({ version: '6', appName: 'Cherry Studio' })).toEqual({
        reason: 'VERSION_NOT_NUMBER'
      })
      expect(validateL3ArchiveMetadata({ version: NaN, appName: 'Cherry Studio' })).toEqual({
        reason: 'VERSION_NOT_NUMBER'
      })
      expect(validateL3ArchiveMetadata({ version: Infinity, appName: 'Cherry Studio' })).toEqual({
        reason: 'VERSION_NOT_NUMBER'
      })
      // LOCK-6004: Fractional versions are also rejected as VERSION_NOT_NUMBER
      expect(validateL3ArchiveMetadata({ version: 6.5, appName: 'Cherry Studio' })).toEqual({
        reason: 'VERSION_NOT_NUMBER'
      })
    })

    it('should reject version below minimum (v5 and below)', () => {
      expect(
        validateL3ArchiveMetadata({
          version: 5,
          appName: 'Cherry Studio',
          timestamp: 0,
          appVersion: '',
          platform: '',
          arch: ''
        })
      ).toEqual({ reason: 'VERSION_UNSUPPORTED', version: 5 })
      expect(
        validateL3ArchiveMetadata({
          version: 0,
          appName: 'Cherry Studio',
          timestamp: 0,
          appVersion: '',
          platform: '',
          arch: ''
        })
      ).toEqual({ reason: 'VERSION_UNSUPPORTED', version: 0 })
      expect(
        validateL3ArchiveMetadata({
          version: -1,
          appName: 'Cherry Studio',
          timestamp: 0,
          appVersion: '',
          platform: '',
          arch: ''
        })
      ).toEqual({ reason: 'VERSION_UNSUPPORTED', version: -1 })
    })

    it('should reject version above maximum (future versions)', () => {
      expect(
        validateL3ArchiveMetadata({
          version: 8,
          appName: 'Cherry Studio',
          timestamp: 0,
          appVersion: '',
          platform: '',
          arch: ''
        })
      ).toEqual({ reason: 'VERSION_UNSUPPORTED', version: 8 })
      expect(
        validateL3ArchiveMetadata({
          version: 100,
          appName: 'Cherry Studio',
          timestamp: 0,
          appVersion: '',
          platform: '',
          arch: ''
        })
      ).toEqual({ reason: 'VERSION_UNSUPPORTED', version: 100 })
    })

    it('should reject wrong appName (foreign archive)', () => {
      expect(
        validateL3ArchiveMetadata({
          version: 7,
          appName: 'Not Cherry Studio',
          product: 'Cherry Chat',
          purpose: 'l3-backup',
          timestamp: 0,
          appVersion: '',
          platform: '',
          arch: ''
        })
      ).toEqual({ reason: 'WRONG_APP_NAME', product: 'Not Cherry Studio' })
    })

    it('should reject v7 with missing product', () => {
      expect(
        validateL3ArchiveMetadata({
          version: 7,
          appName: 'Cherry Studio',
          purpose: 'l3-backup',
          timestamp: 0,
          appVersion: '1.0.0',
          platform: 'darwin',
          arch: 'arm64'
        })
      ).toEqual({ reason: 'WRONG_PRODUCT', product: undefined })
    })

    it('should reject v7 with wrong product', () => {
      expect(
        validateL3ArchiveMetadata({
          version: 7,
          appName: 'Cherry Studio',
          product: 'Different Product',
          purpose: 'l3-backup',
          timestamp: 0,
          appVersion: '1.0.0',
          platform: 'darwin',
          arch: 'arm64'
        })
      ).toEqual({ reason: 'WRONG_PRODUCT', product: 'Different Product' })
    })

    it('should reject v7 with missing purpose', () => {
      expect(
        validateL3ArchiveMetadata({
          version: 7,
          appName: 'Cherry Studio',
          product: 'Cherry Chat',
          timestamp: 0,
          appVersion: '1.0.0',
          platform: 'darwin',
          arch: 'arm64'
        })
      ).toEqual({ reason: 'WRONG_PURPOSE', purpose: undefined })
    })

    it('should reject v7 with wrong purpose', () => {
      expect(
        validateL3ArchiveMetadata({
          version: 7,
          appName: 'Cherry Studio',
          product: 'Cherry Chat',
          purpose: 'l2-import',
          timestamp: 0,
          appVersion: '1.0.0',
          platform: 'darwin',
          arch: 'arm64'
        })
      ).toEqual({ reason: 'WRONG_PURPOSE', purpose: 'l2-import' })
    })

    it('should reject empty object', () => {
      expect(validateL3ArchiveMetadata({})).toEqual({ reason: 'VERSION_NOT_NUMBER' })
    })

    // -----------------------------------------------------------------------
    // timestamp / appVersion / platform / arch field validation
    // -----------------------------------------------------------------------

    it('should reject metadata with missing timestamp', () => {
      expect(
        validateL3ArchiveMetadata({
          version: 7,
          appName: 'Cherry Studio',
          appVersion: '1.0.0',
          platform: 'darwin',
          arch: 'arm64',
          product: 'Cherry Chat',
          purpose: 'l3-backup'
          // no timestamp
        })
      ).toEqual({ reason: 'TIMESTAMP_INVALID' })
    })

    it('should reject metadata with non-number timestamp', () => {
      expect(
        validateL3ArchiveMetadata({
          version: 7,
          appName: 'Cherry Studio',
          timestamp: 'not-a-number',
          appVersion: '1.0.0',
          platform: 'darwin',
          arch: 'arm64',
          product: 'Cherry Chat',
          purpose: 'l3-backup'
        })
      ).toEqual({ reason: 'TIMESTAMP_INVALID' })
    })

    it('should reject metadata with NaN/Infinity timestamp', () => {
      expect(
        validateL3ArchiveMetadata({
          version: 7,
          appName: 'Cherry Studio',
          timestamp: NaN,
          appVersion: '1.0.0',
          platform: 'darwin',
          arch: 'arm64',
          product: 'Cherry Chat',
          purpose: 'l3-backup'
        })
      ).toEqual({ reason: 'TIMESTAMP_INVALID' })
      expect(
        validateL3ArchiveMetadata({
          version: 7,
          appName: 'Cherry Studio',
          timestamp: Infinity,
          appVersion: '1.0.0',
          platform: 'darwin',
          arch: 'arm64',
          product: 'Cherry Chat',
          purpose: 'l3-backup'
        })
      ).toEqual({ reason: 'TIMESTAMP_INVALID' })
    })

    it('should reject metadata with missing appVersion', () => {
      expect(
        validateL3ArchiveMetadata({
          version: 7,
          appName: 'Cherry Studio',
          timestamp: Date.now(),
          platform: 'darwin',
          arch: 'arm64',
          product: 'Cherry Chat',
          purpose: 'l3-backup'
          // no appVersion
        })
      ).toEqual({ reason: 'APP_VERSION_INVALID' })
    })

    it('should reject metadata with empty string appVersion', () => {
      expect(
        validateL3ArchiveMetadata({
          version: 7,
          appName: 'Cherry Studio',
          timestamp: Date.now(),
          appVersion: '',
          platform: 'darwin',
          arch: 'arm64',
          product: 'Cherry Chat',
          purpose: 'l3-backup'
        })
      ).toEqual({ reason: 'APP_VERSION_INVALID' })
    })

    it('should reject metadata with non-string appVersion', () => {
      expect(
        validateL3ArchiveMetadata({
          version: 7,
          appName: 'Cherry Studio',
          timestamp: Date.now(),
          appVersion: 123,
          platform: 'darwin',
          arch: 'arm64',
          product: 'Cherry Chat',
          purpose: 'l3-backup'
        })
      ).toEqual({ reason: 'APP_VERSION_INVALID' })
    })

    it('should reject metadata with missing platform', () => {
      expect(
        validateL3ArchiveMetadata({
          version: 7,
          appName: 'Cherry Studio',
          timestamp: Date.now(),
          appVersion: '1.0.0',
          arch: 'arm64',
          product: 'Cherry Chat',
          purpose: 'l3-backup'
          // no platform
        })
      ).toEqual({ reason: 'PLATFORM_INVALID' })
    })

    it('should reject metadata with empty string platform', () => {
      expect(
        validateL3ArchiveMetadata({
          version: 7,
          appName: 'Cherry Studio',
          timestamp: Date.now(),
          appVersion: '1.0.0',
          platform: '',
          arch: 'arm64',
          product: 'Cherry Chat',
          purpose: 'l3-backup'
        })
      ).toEqual({ reason: 'PLATFORM_INVALID' })
    })

    it('should reject metadata with missing arch', () => {
      expect(
        validateL3ArchiveMetadata({
          version: 7,
          appName: 'Cherry Studio',
          timestamp: Date.now(),
          appVersion: '1.0.0',
          platform: 'darwin',
          product: 'Cherry Chat',
          purpose: 'l3-backup'
          // no arch
        })
      ).toEqual({ reason: 'ARCH_INVALID' })
    })

    it('should reject metadata with empty string arch', () => {
      expect(
        validateL3ArchiveMetadata({
          version: 7,
          appName: 'Cherry Studio',
          timestamp: Date.now(),
          appVersion: '1.0.0',
          platform: 'darwin',
          arch: '',
          product: 'Cherry Chat',
          purpose: 'l3-backup'
        })
      ).toEqual({ reason: 'ARCH_INVALID' })
    })
  })

  // =========================================================================
  // 4. Version evolution — bounded forward compatibility
  // =========================================================================

  describe('version evolution', () => {
    it('constants reflect current supported range', () => {
      expect(L3_MIN_SUPPORTED_VERSION).toBe(6)
      expect(L3_MAX_SUPPORTED_VERSION).toBe(L3_ARCHIVE_VERSION)
      expect(L3_ARCHIVE_VERSION).toBe(7)
    })

    it('v6 archives (legacy) are accepted without product/purpose', () => {
      const legacy = {
        version: 6,
        timestamp: 1234567890,
        appName: 'Cherry Studio',
        appVersion: '0.5.0',
        platform: 'darwin',
        arch: 'arm64'
      }
      expect(validateL3ArchiveMetadata(legacy)).toBeNull()
    })

    it('v7+ archives must have product and purpose', () => {
      const v7noProduct = {
        version: 7,
        timestamp: 1234567890,
        appName: 'Cherry Studio',
        appVersion: '1.0.0',
        platform: 'darwin',
        arch: 'arm64'
        // Missing product and purpose
      }
      expect(validateL3ArchiveMetadata(v7noProduct)?.reason).toBe('WRONG_PRODUCT')
    })
  })

  // =========================================================================
  // 5. Edge cases — concurrent/partial metadata
  // =========================================================================

  describe('edge cases', () => {
    it('should reject metadata with version as float', () => {
      // LOCK-6004: Only existing direct integer v6 is bounded-compatible.
      // Fractional versions must be rejected as VERSION_NOT_NUMBER.
      expect(validateL3ArchiveMetadata({ version: 7.5, appName: 'Cherry Studio' })).toEqual({
        reason: 'VERSION_NOT_NUMBER'
      })
    })

    it('should reject fractional v6 (e.g., 6.5) as VERSION_NOT_NUMBER', () => {
      // LOCK-6004: Fractional v6 is NOT bounded-compatible — only integer v6.
      expect(
        validateL3ArchiveMetadata({
          version: 6.5,
          appName: 'Cherry Studio',
          timestamp: 0,
          appVersion: '1.0.0',
          platform: 'darwin',
          arch: 'arm64'
        })
      ).toEqual({ reason: 'VERSION_NOT_NUMBER' })
    })

    it('should reject 6.1 and 6.9 as VERSION_NOT_NUMBER', () => {
      expect(validateL3ArchiveMetadata({ version: 6.1, appName: 'Cherry Studio' })).toEqual({
        reason: 'VERSION_NOT_NUMBER'
      })
      expect(validateL3ArchiveMetadata({ version: 6.9, appName: 'Cherry Studio' })).toEqual({
        reason: 'VERSION_NOT_NUMBER'
      })
    })

    it('should accept integer v6 (6) and v7 (7) as valid', () => {
      // v6: no product/purpose needed
      expect(
        validateL3ArchiveMetadata({
          version: 6,
          appName: 'Cherry Studio',
          timestamp: 0,
          appVersion: '0.5.0',
          platform: 'darwin',
          arch: 'arm64'
        })
      ).toBeNull()
      // v7: requires product/purpose
      expect(
        validateL3ArchiveMetadata({
          version: 7,
          appName: 'Cherry Studio',
          timestamp: 0,
          appVersion: '1.0.0',
          platform: 'darwin',
          arch: 'arm64',
          product: 'Cherry Chat',
          purpose: 'l3-backup'
        })
      ).toBeNull()
    })

    it('should reject metadata where version is a valid number but appName is missing', () => {
      expect(validateL3ArchiveMetadata({ version: 7 })).toEqual({
        reason: 'WRONG_APP_NAME',
        product: undefined
      })
    })

    it('should handle metadata with all fields as empty strings', () => {
      expect(
        validateL3ArchiveMetadata({
          version: 7,
          appName: '',
          product: '',
          purpose: '',
          timestamp: 0,
          appVersion: '',
          platform: '',
          arch: ''
        })
      ).toEqual({ reason: 'WRONG_APP_NAME', product: '' })
    })
  })
})
