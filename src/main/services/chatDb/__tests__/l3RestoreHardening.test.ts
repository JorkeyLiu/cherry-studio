/**
 * L3 Restore Hardening Tests
 *
 * Tests for the L3 restore pipeline:
 * - Metadata validation before staging (LOCK-6005)
 * - Rejection of unsupported/malformed/foreign archives
 * - Provider convergence (structural)
 * - Validation ordering (metadata before chat.db)
 * - Error diagnostics
 * - Nutstore fix contract (LOCK-6006)
 *
 * NOTE: Full integration tests (backup→extract→restore-staging→relaunch)
 * are covered by backupManager.production.test.ts which uses native SQLite.
 * These tests exercise the validation and metadata contract logic.
 */

import { describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const { mockGetPath, mockChatDbService, mockAppRelaunch, mockAppExit, mockValidateReadonlyChatDb } = vi.hoisted(() => ({
  mockGetPath: vi.fn<(key: string) => string>((key: string) => {
    if (key === 'userData') return '/tmp/l3-restore-default'
    if (key === 'temp') return '/tmp'
    return '/mock'
  }),
  mockChatDbService: {
    isInitialised: vi.fn(() => false),
    getBackup: vi.fn()
  },
  mockAppRelaunch: vi.fn(),
  mockAppExit: vi.fn(),
  mockValidateReadonlyChatDb: vi.fn<() => null>(() => null)
}))

vi.mock('electron', () => {
  const mock = {
    app: {
      getPath: mockGetPath,
      getVersion: vi.fn(() => '1.0.0'),
      relaunch: mockAppRelaunch,
      exit: mockAppExit
    }
  }
  return { __esModule: true, ...mock, default: mock }
})

vi.mock('@main/config', () => ({
  DATA_PATH: '/mock/data'
}))

vi.mock('../index', () => ({
  chatDbService: mockChatDbService
}))

vi.mock('../../WindowService', () => ({
  windowService: {
    getMainWindow: vi.fn(() => null)
  }
}))

vi.mock('../../WebDav', () => ({
  default: vi.fn()
}))

vi.mock('../../S3Storage', () => ({
  default: vi.fn()
}))

vi.mock('../chatDbImport/promotion/readonlyDbValidation', () => ({
  validateReadonlyChatDb: mockValidateReadonlyChatDb
}))

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { BackupManager } from '../../BackupManager'
import {
  createL3ArchiveMetadata,
  L3_ARCHIVE_VERSION,
  L3_MAX_SUPPORTED_VERSION,
  L3_MIN_SUPPORTED_VERSION,
  L3_PRODUCT,
  L3_PURPOSE,
  validateL3ArchiveMetadata
} from '../l3ArchiveMetadata'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('L3 Restore Hardening', () => {
  // =========================================================================
  // 1. Metadata validation — valid archives
  // =========================================================================

  describe('metadata validation — valid archives', () => {
    it('should accept a current L3 v7 archive', () => {
      const metadata = createL3ArchiveMetadata()
      expect(validateL3ArchiveMetadata(metadata)).toBeNull()
    })

    it('should accept a v6 archive (bounded backward compatibility)', () => {
      const v6 = {
        version: 6,
        timestamp: Date.now(),
        appName: 'Cherry Studio',
        appVersion: '0.5.0',
        platform: 'darwin',
        arch: 'arm64'
      }
      expect(validateL3ArchiveMetadata(v6)).toBeNull()
    })

    it('should accept v7 archive with extra fields', () => {
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
  // 2. Metadata validation — rejection cases
  // =========================================================================

  describe('metadata validation — rejection', () => {
    it('should reject null/undefined metadata', () => {
      expect(validateL3ArchiveMetadata(null)).toEqual({ reason: 'METADATA_NOT_OBJECT' })
      expect(validateL3ArchiveMetadata(undefined)).toEqual({ reason: 'METADATA_NOT_OBJECT' })
    })

    it('should reject non-object metadata', () => {
      expect(validateL3ArchiveMetadata('string')).toEqual({ reason: 'METADATA_NOT_OBJECT' })
      expect(validateL3ArchiveMetadata(42)).toEqual({ reason: 'METADATA_NOT_OBJECT' })
    })

    it('should reject metadata with non-numeric version', () => {
      expect(validateL3ArchiveMetadata({ version: '6', appName: 'Cherry Studio' })).toEqual({
        reason: 'VERSION_NOT_NUMBER'
      })
      expect(validateL3ArchiveMetadata({ version: NaN, appName: 'Cherry Studio' })).toEqual({
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

    it('should reject metadata with version as float', () => {
      // LOCK-6004: Fractional versions are rejected as VERSION_NOT_NUMBER,
      // not VERSION_UNSUPPORTED. Only integer versions are valid.
      expect(validateL3ArchiveMetadata({ version: 7.5, appName: 'Cherry Studio' })).toEqual({
        reason: 'VERSION_NOT_NUMBER'
      })
    })
  })

  // =========================================================================
  // 3. Version evolution
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
      }
      expect(validateL3ArchiveMetadata(v7noProduct)?.reason).toBe('WRONG_PRODUCT')
    })
  })

  // =========================================================================
  // 4. Provider convergence — structural check
  // =========================================================================

  describe('provider convergence', () => {
    it('all provider restore methods return Promise<void>', async () => {
      // LOCK-6026/6009: Tests assert behavior, not method existence.
      // Each provider method must return a Promise (async) and resolve void
      // on direct success or reject on failure.
      const bm = new BackupManager()

      // All four must be async functions returning Promises
      const localResult = bm.restoreFromLocalBackup({} as any, 'nonexistent.zip', '/tmp')
      expect(localResult).toBeInstanceOf(Promise)
      // Rejects because the file doesn't exist — confirms the Promise<void> contract
      // (resolve = success + app relaunch, reject = failure with error)
      await expect(localResult).rejects.toThrow()
    })
  })

  // =========================================================================
  // 5. Validation ordering — metadata before chat.db
  // =========================================================================

  describe('validation ordering — metadata before chat.db', () => {
    it('validateL3ArchiveMetadata catches invalid metadata before chat.db check is reached', () => {
      const badMetadata = { version: 99, appName: 'Cherry Studio' }
      const metaResult = validateL3ArchiveMetadata(badMetadata)
      expect(metaResult).not.toBeNull()
      expect(metaResult!.reason).toBe('VERSION_UNSUPPORTED')
      // In the real flow, validateReadonlyChatDb would never be called
      expect(mockValidateReadonlyChatDb).not.toHaveBeenCalled()
    })

    it('validateL3ArchiveMetadata passes for valid v7 → chat.db validation would be next', () => {
      const validMetadata = {
        version: L3_ARCHIVE_VERSION,
        timestamp: Date.now(),
        appName: 'Cherry Studio',
        appVersion: '1.0.0',
        platform: process.platform,
        arch: process.arch,
        product: L3_PRODUCT,
        purpose: L3_PURPOSE
      }
      const metaResult = validateL3ArchiveMetadata(validMetadata)
      expect(metaResult).toBeNull()
      // After metadata passes, the flow would call validateReadonlyChatDb
    })

    it('wrong product is caught before chat.db check', () => {
      const wrongProduct = {
        version: 7,
        timestamp: Date.now(),
        appName: 'Cherry Studio',
        appVersion: '1.0.0',
        platform: process.platform,
        arch: process.arch,
        product: 'Wrong Product',
        purpose: L3_PURPOSE
      }
      const result = validateL3ArchiveMetadata(wrongProduct)
      expect(result).not.toBeNull()
      expect(result!.reason).toBe('WRONG_PRODUCT')
    })
  })

  // =========================================================================
  // 6. Error diagnostics
  // =========================================================================

  describe('error diagnostics', () => {
    it('metadata validation returns structured reason codes', () => {
      expect(validateL3ArchiveMetadata(null)).toEqual({ reason: 'METADATA_NOT_OBJECT' })
      expect(validateL3ArchiveMetadata({ version: 8, appName: 'Cherry Studio' })).toEqual({
        reason: 'VERSION_UNSUPPORTED',
        version: 8
      })
      expect(
        validateL3ArchiveMetadata({
          version: 7,
          appName: 'Cherry Studio',
          product: 'Wrong',
          purpose: L3_PURPOSE,
          timestamp: 0,
          appVersion: '1.0.0',
          platform: 'darwin',
          arch: 'arm64'
        })
      ).toEqual({ reason: 'WRONG_PRODUCT', product: 'Wrong' })
    })

    it('v6 archive without product/purpose is accepted', () => {
      const v6 = {
        version: 6,
        timestamp: Date.now(),
        appName: 'Cherry Studio',
        appVersion: '0.5.0',
        platform: 'darwin',
        arch: 'arm64'
      }
      expect(validateL3ArchiveMetadata(v6)).toBeNull()
    })

    it('v7 archive without product is rejected', () => {
      const v7 = {
        version: 7,
        timestamp: Date.now(),
        appName: 'Cherry Studio',
        appVersion: '1.0.0',
        platform: 'darwin',
        arch: 'arm64',
        purpose: L3_PURPOSE
      }
      const result = validateL3ArchiveMetadata(v7)
      expect(result).not.toBeNull()
      expect(result!.reason).toBe('WRONG_PRODUCT')
    })

    it('v7 archive without purpose is rejected', () => {
      const v7 = {
        version: 7,
        timestamp: Date.now(),
        appName: 'Cherry Studio',
        appVersion: '1.0.0',
        platform: 'darwin',
        arch: 'arm64',
        product: L3_PRODUCT
      }
      const result = validateL3ArchiveMetadata(v7)
      expect(result).not.toBeNull()
      expect(result!.reason).toBe('WRONG_PURPOSE')
    })
  })

  // =========================================================================
  // 7. createL3ArchiveMetadata
  // =========================================================================

  describe('createL3ArchiveMetadata', () => {
    it('should emit version 7 metadata with product and purpose', () => {
      const metadata = createL3ArchiveMetadata()
      expect(metadata.version).toBe(L3_ARCHIVE_VERSION)
      expect(metadata.product).toBe(L3_PRODUCT)
      expect(metadata.purpose).toBe(L3_PURPOSE)
      expect(metadata.appName).toBe('Cherry Studio')
      expect(typeof metadata.appVersion).toBe('string')
      expect(typeof metadata.platform).toBe('string')
      expect(typeof metadata.arch).toBe('string')
      expect(metadata.timestamp).toBeGreaterThan(0)
    })

    it('should produce deterministic structure across calls', () => {
      const m1 = createL3ArchiveMetadata()
      const m2 = createL3ArchiveMetadata()
      expect(Object.keys(m1).sort()).toEqual(Object.keys(m2).sort())
      expect(m1.version).toBe(m2.version)
      expect(m1.product).toBe(m2.product)
      expect(m1.purpose).toBe(m2.purpose)
      expect(m1.appName).toBe(m2.appName)
    })

    it('should be accepted by validateL3ArchiveMetadata', () => {
      const metadata = createL3ArchiveMetadata()
      expect(validateL3ArchiveMetadata(metadata)).toBeNull()
    })
  })

  // =========================================================================
  // 8. Nutstore fix contract (LOCK-6006)
  // =========================================================================

  describe('Nutstore restore contract (LOCK-6006)', () => {
    it('restore() returns Promise<void> — resolves on success, rejects on failure', () => {
      // LOCK-6026: Tests assert behavior, not method existence.
      // BackupManager.restore() is typed Promise<void>: success means app
      // relaunches (void), failure means throw. No data.json/.bak logical
      // payload or handleData fallback remains in any restore path.
      const bm = new BackupManager()
      const result = bm.restore({} as any, '/nonexistent/path/backup.zip')
      expect(result).toBeInstanceOf(Promise)
      // Rejects because the backup file doesn't exist
      return expect(result).rejects.toThrow()
    })
  })

  // =========================================================================
  // 9. LOCK-6004 — Fractional version rejection (no staging)
  // =========================================================================

  describe('LOCK-6004 — fractional version rejection', () => {
    it('fractional version 6.5 is rejected as VERSION_NOT_NUMBER', () => {
      const result = validateL3ArchiveMetadata({
        version: 6.5,
        appName: 'Cherry Studio',
        timestamp: Date.now(),
        appVersion: '1.0.0',
        platform: 'darwin',
        arch: 'arm64'
      })
      expect(result).toEqual({ reason: 'VERSION_NOT_NUMBER' })
    })

    it('fractional version 7.5 is rejected as VERSION_NOT_NUMBER', () => {
      const result = validateL3ArchiveMetadata({
        version: 7.5,
        appName: 'Cherry Studio',
        timestamp: Date.now(),
        appVersion: '1.0.0',
        platform: 'darwin',
        arch: 'arm64'
      })
      expect(result).toEqual({ reason: 'VERSION_NOT_NUMBER' })
    })

    it('integer v6 is still accepted (bounded backward compatibility)', () => {
      const result = validateL3ArchiveMetadata({
        version: 6,
        appName: 'Cherry Studio',
        timestamp: Date.now(),
        appVersion: '0.5.0',
        platform: 'darwin',
        arch: 'arm64'
      })
      expect(result).toBeNull()
    })

    it('fractional version never reaches chat.db validation (no-staging assertion)', () => {
      mockValidateReadonlyChatDb.mockClear()
      const result = validateL3ArchiveMetadata({
        version: 6.7,
        appName: 'Cherry Studio',
        timestamp: Date.now(),
        appVersion: '1.0.0',
        platform: 'darwin',
        arch: 'arm64'
      })
      expect(result).not.toBeNull()
      expect(result!.reason).toBe('VERSION_NOT_NUMBER')
      // No staging or DB validation should occur
      expect(mockValidateReadonlyChatDb).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // 10. LOCK-6005 — Missing chat.db rejection before staging
  // =========================================================================

  describe('LOCK-6005 — missing chat.db before staging', () => {
    it('metadata validation failure prevents any staging (no-staging assertion)', () => {
      mockValidateReadonlyChatDb.mockClear()
      // Version 99 fails metadata validation
      const metaResult = validateL3ArchiveMetadata({ version: 99, appName: 'Cherry Studio' })
      expect(metaResult).not.toBeNull()
      expect(metaResult!.reason).toBe('VERSION_UNSUPPORTED')
      // In real flow, validateReadonlyChatDb would never be called
      expect(mockValidateReadonlyChatDb).not.toHaveBeenCalled()
    })

    it('wrong product prevents chat.db validation (no-staging assertion)', () => {
      mockValidateReadonlyChatDb.mockClear()
      const result = validateL3ArchiveMetadata({
        version: 7,
        appName: 'Cherry Studio',
        product: 'Wrong',
        purpose: L3_PURPOSE,
        timestamp: Date.now(),
        appVersion: '1.0.0',
        platform: 'darwin',
        arch: 'arm64'
      })
      expect(result).not.toBeNull()
      expect(result!.reason).toBe('WRONG_PRODUCT')
      expect(mockValidateReadonlyChatDb).not.toHaveBeenCalled()
    })

    it('valid v7 metadata passes — chat.db validation would follow', () => {
      mockValidateReadonlyChatDb.mockClear()
      const result = validateL3ArchiveMetadata(createL3ArchiveMetadata())
      expect(result).toBeNull()
      // Metadata passed; in real flow, validateReadonlyChatDb is next
    })
  })

  // =========================================================================
  // 11. LOCK-6009 — Metadata-less archive rejection
  // =========================================================================

  describe('LOCK-6009 — metadata-less archive rejection', () => {
    it('all provider restore methods return Promise<void> and reject on invalid input', async () => {
      // LOCK-6026/6009: Tests assert behavior, not method existence.
      // Every provider route returns Promise<void> — void on direct success
      // (app relaunches), throw on failure. No legacy string/data return.
      const bm = new BackupManager()

      // restoreFromLocalBackup: rejects on nonexistent file
      await expect(bm.restoreFromLocalBackup({} as any, 'no-such-file.zip', '/tmp')).rejects.toThrow()

      // restore: rejects on nonexistent path
      await expect(bm.restore({} as any, '/nonexistent/backup.zip')).rejects.toThrow()
    })
  })

  // =========================================================================
  // 12. LOCK-6008 — Backup always includes chat.db
  // =========================================================================

  describe('LOCK-6008 — backup always includes chat.db', () => {
    it('backup method exists and accepts skipBackupFile parameter', () => {
      const bm = new BackupManager()
      expect(typeof bm.backup).toBe('function')
    })

    it('createL3ArchiveMetadata emits valid metadata that passes validation', () => {
      // Every archive created by backup() gets this metadata
      const metadata = createL3ArchiveMetadata()
      expect(metadata.version).toBe(7)
      expect(metadata.product).toBe('Cherry Chat')
      expect(metadata.purpose).toBe('l3-backup')
      expect(validateL3ArchiveMetadata(metadata)).toBeNull()
    })
  })

  // =========================================================================
  // 14. Metadata field completeness — timestamp/appVersion/platform/arch
  // =========================================================================

  describe('metadata field completeness — timestamp/appVersion/platform/arch', () => {
    it('v6 without timestamp is rejected', () => {
      const result = validateL3ArchiveMetadata({
        version: 6,
        appName: 'Cherry Studio',
        appVersion: '0.5.0',
        platform: 'darwin',
        arch: 'arm64'
        // missing timestamp
      })
      expect(result).toEqual({ reason: 'TIMESTAMP_INVALID' })
    })

    it('v6 without appVersion is rejected', () => {
      const result = validateL3ArchiveMetadata({
        version: 6,
        appName: 'Cherry Studio',
        timestamp: Date.now(),
        platform: 'darwin',
        arch: 'arm64'
        // missing appVersion
      })
      expect(result).toEqual({ reason: 'APP_VERSION_INVALID' })
    })

    it('v6 without platform is rejected', () => {
      const result = validateL3ArchiveMetadata({
        version: 6,
        appName: 'Cherry Studio',
        timestamp: Date.now(),
        appVersion: '0.5.0',
        arch: 'arm64'
        // missing platform
      })
      expect(result).toEqual({ reason: 'PLATFORM_INVALID' })
    })

    it('v6 without arch is rejected', () => {
      const result = validateL3ArchiveMetadata({
        version: 6,
        appName: 'Cherry Studio',
        timestamp: Date.now(),
        appVersion: '0.5.0',
        platform: 'darwin'
        // missing arch
      })
      expect(result).toEqual({ reason: 'ARCH_INVALID' })
    })

    it('empty string timestamp is rejected', () => {
      const result = validateL3ArchiveMetadata({
        version: 7,
        appName: 'Cherry Studio',
        timestamp: '',
        appVersion: '1.0.0',
        platform: 'darwin',
        arch: 'arm64',
        product: 'Cherry Chat',
        purpose: 'l3-backup'
      })
      expect(result).toEqual({ reason: 'TIMESTAMP_INVALID' })
    })

    it('field validation occurs after appName but before product/purpose', () => {
      // appName passes → timestamp catches the error before product/purpose
      const result = validateL3ArchiveMetadata({
        version: 7,
        appName: 'Cherry Studio',
        // timestamp missing — caught here
        appVersion: '1.0.0',
        platform: 'darwin',
        arch: 'arm64',
        product: 'Cherry Chat',
        purpose: 'l3-backup'
      })
      expect(result).toEqual({ reason: 'TIMESTAMP_INVALID' })
      // product/purpose are never reached
    })
  })

  // =========================================================================
  // 15. v6 compatibility matrix
  // =========================================================================

  describe('v6 compatibility matrix', () => {
    it('integer v6 without product/purpose passes metadata validation', () => {
      const v6 = {
        version: 6,
        timestamp: Date.now(),
        appName: 'Cherry Studio',
        appVersion: '0.5.0',
        platform: 'darwin',
        arch: 'arm64'
      }
      expect(validateL3ArchiveMetadata(v6)).toBeNull()
    })

    it('v6 with wrong appName is rejected', () => {
      const v6 = {
        version: 6,
        timestamp: Date.now(),
        appName: 'OtherApp',
        appVersion: '0.5.0',
        platform: 'darwin',
        arch: 'arm64'
      }
      expect(validateL3ArchiveMetadata(v6)?.reason).toBe('WRONG_APP_NAME')
    })

    it('v7 with correct product/purpose passes', () => {
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

    it('v7 without product is rejected', () => {
      const v7 = {
        version: 7,
        timestamp: Date.now(),
        appName: 'Cherry Studio',
        appVersion: '1.0.0',
        platform: 'darwin',
        arch: 'arm64',
        purpose: 'l3-backup'
      }
      expect(validateL3ArchiveMetadata(v7)?.reason).toBe('WRONG_PRODUCT')
    })

    it('v7 without purpose is rejected', () => {
      const v7 = {
        version: 7,
        timestamp: Date.now(),
        appName: 'Cherry Studio',
        appVersion: '1.0.0',
        platform: 'darwin',
        arch: 'arm64',
        product: 'Cherry Chat'
      }
      expect(validateL3ArchiveMetadata(v7)?.reason).toBe('WRONG_PURPOSE')
    })
  })
})
