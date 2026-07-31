/**
 * L3 Archive Metadata Contract (LOCK-6001, LOCK-6004)
 *
 * Defines the typed metadata schema for Cherry Chat same-application
 * backup/restore archives (L3). New archives use a versioned metadata
 * discriminator with explicit product/purpose fields. Existing v6 direct
 * archives remain restorable as a bounded backward-compatible format.
 *
 * LOCK-6001: L3 means Cherry Chat same-application backup/restore and
 * must remain semantically separate from L2 Cherry Studio ZIP import.
 * LOCK-6004: New archives use a versioned metadata discriminator for
 * product/purpose; existing direct v6 archives remain restorable.
 */

import { app } from 'electron'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Current L3 archive format version. Bump when schema changes. */
export const L3_ARCHIVE_VERSION = 7

/** Product identifier for Cherry Chat same-application archives. */
export const L3_PRODUCT = 'Cherry Chat' as const

/** Purpose identifier for L3 backup archives. */
export const L3_PURPOSE = 'l3-backup' as const

/** Minimum metadata version supported for L3 restore (inclusive). */
export const L3_MIN_SUPPORTED_VERSION = 6

/** Maximum metadata version supported for L3 restore (inclusive). */
export const L3_MAX_SUPPORTED_VERSION = L3_ARCHIVE_VERSION

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * L3 direct archive metadata — emitted by new backups (version 7+).
 * Superset of the legacy v6 schema; v6 archives have no `product` or `purpose`.
 */
export interface L3ArchiveMetadata {
  /** Format version number (6 for legacy, 7+ for L3). */
  version: number
  /** Unix epoch timestamp of backup creation. */
  timestamp: number
  /** Application name for display purposes. */
  appName: string
  /** Application version at time of backup. */
  appVersion: string
  /** Platform (process.platform) at time of backup. */
  platform: string
  /** CPU architecture (process.arch) at time of backup. */
  arch: string
  /**
   * Product discriminator (LOCK-6004). Present in version 7+ archives.
   * Must be 'Cherry Chat' for L3 same-application restore.
   */
  product?: string
  /**
   * Purpose discriminator (LOCK-6004). Present in version 7+ archives.
   * Must be 'l3-backup' for L3 same-application restore.
   */
  purpose?: string
}

/**
 * Result of L3 metadata validation.
 * Null means valid; non-null means rejected with a bounded reason.
 */
export interface L3MetadataValidation {
  readonly reason: string
  readonly version?: number
  readonly product?: string
  readonly purpose?: string
}

// ---------------------------------------------------------------------------
// Metadata creation
// ---------------------------------------------------------------------------

/**
 * Create L3 archive metadata for a new backup.
 * Called by BackupManager during archive creation.
 */
export function createL3ArchiveMetadata(): L3ArchiveMetadata {
  return {
    version: L3_ARCHIVE_VERSION,
    timestamp: Date.now(),
    appName: 'Cherry Studio',
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    product: L3_PRODUCT,
    purpose: L3_PURPOSE
  }
}

// ---------------------------------------------------------------------------
// Metadata validation
// ---------------------------------------------------------------------------

/**
 * Validate L3 archive metadata for restore compatibility.
 *
 * LOCK-6005: A direct L3 restore must validate metadata before staging
 * or destructive replacement. Rejects unsupported future versions, wrong
 * purpose/product, and malformed metadata.
 *
 * LOCK-6004: Existing v6 direct archives are accepted as bounded
 * backward-compatible format (no product/purpose fields required).
 *
 * @param metadata - Parsed metadata.json content from the archive.
 * @returns null if valid; L3MetadataValidation with reason if rejected.
 */
export function validateL3ArchiveMetadata(metadata: unknown): L3MetadataValidation | null {
  if (!metadata || typeof metadata !== 'object') {
    return { reason: 'METADATA_NOT_OBJECT' }
  }

  const m = metadata as Record<string, unknown>

  // Version must be a finite integer
  if (typeof m.version !== 'number' || !Number.isFinite(m.version) || !Number.isInteger(m.version)) {
    return { reason: 'VERSION_NOT_NUMBER' }
  }

  const version = m.version

  // Version out of supported range
  if (version < L3_MIN_SUPPORTED_VERSION || version > L3_MAX_SUPPORTED_VERSION) {
    return { reason: 'VERSION_UNSUPPORTED', version }
  }

  // appName must be 'Cherry Studio'
  if (typeof m.appName !== 'string' || m.appName !== 'Cherry Studio') {
    return { reason: 'WRONG_APP_NAME', product: m.appName as string }
  }

  // timestamp must be a finite number (Unix epoch)
  if (typeof m.timestamp !== 'number' || !Number.isFinite(m.timestamp)) {
    return { reason: 'TIMESTAMP_INVALID' }
  }

  // appVersion must be a non-empty string
  if (typeof m.appVersion !== 'string' || m.appVersion.length === 0) {
    return { reason: 'APP_VERSION_INVALID' }
  }

  // platform must be a non-empty string (process.platform)
  if (typeof m.platform !== 'string' || m.platform.length === 0) {
    return { reason: 'PLATFORM_INVALID' }
  }

  // arch must be a non-empty string (process.arch)
  if (typeof m.arch !== 'string' || m.arch.length === 0) {
    return { reason: 'ARCH_INVALID' }
  }

  // Version 7+ requires product and purpose discriminators
  if (version >= 7) {
    if (typeof m.product !== 'string' || m.product !== L3_PRODUCT) {
      return { reason: 'WRONG_PRODUCT', product: m.product as string }
    }
    if (typeof m.purpose !== 'string' || m.purpose !== L3_PURPOSE) {
      return { reason: 'WRONG_PURPOSE', purpose: m.purpose as string }
    }
  }

  return null
}
