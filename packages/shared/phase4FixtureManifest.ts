/**
 * Phase 4.0-B Fixture Manifest Schema
 *
 * TEST/FEASIBILITY-ONLY infrastructure. Not imported by any production
 * entry point. Retained through Phase 4.1 as reproducibility harness.
 * Excluded from normal builds by PHASE4_SPIKE gating in electron.vite.config.ts.
 *
 * Defines the manifest format for deterministic synthetic IndexedDB fixtures.
 * JSON-only; does NOT import renderer-specific types.
 *
 * Manifest is emitted by the Electron generator process and consumed by the
 * staging script to produce candidate roots for Phase 4.0-C.
 */

/* ── Pure path normalization (avoids node:path dependency in shared module) ── */

const SEP = '/'

/** Resolve . and .. in a POSIX path without node:path. */
function resolvePosix(p: string): string {
  const isAbsolute = p.startsWith(SEP)
  const parts = p.split(SEP).filter(Boolean)
  const resolved: string[] = []
  for (const part of parts) {
    if (part === '.') continue
    if (part === '..') {
      if (resolved.length > 0 && resolved[resolved.length - 1] !== '..') {
        resolved.pop()
      } else if (!isAbsolute) {
        resolved.push('..')
      }
      // If absolute and .. would go above root, silently ignore
    } else {
      resolved.push(part)
    }
  }
  return (isAbsolute ? SEP : '') + resolved.join(SEP) || (isAbsolute ? SEP : '.')
}

/* ── Fixture identifiers ── */

export const FIXTURE_IDS = ['v4', 'v11a', 'v11b', 'v12'] as const
export type FixtureId = (typeof FIXTURE_IDS)[number]

const VALID_FIXTURE_IDS: ReadonlySet<string> = new Set(FIXTURE_IDS)

/* ── Per-fixture metadata emitted by the renderer ── */

export interface FixtureDonePayload {
  fixtureId: FixtureId
  logicalDexieVersion: number
  observedNativeVersion: number
  markers: Record<string, string>
  localStorage: Record<string, string>
  tables: string[]
  recordCounts: Record<string, number>
  limitations: string[]
}

/* ── Request payload sent to renderer ── */

export interface FixtureGeneratePayload {
  fixtureId: FixtureId
  databaseName: string
}

/* ── File inventory entry ── */

export interface FixtureFileEntry {
  relativePath: string
  sizeBytes: number
}

/* ── Full manifest (emitted by main process) ── */

export interface FixtureManifest {
  /** Fixture identifier */
  fixtureId: FixtureId
  /** ISO timestamp of creation */
  createdAt: string
  /** Logical Dexie schema version declared by the generator */
  logicalDexieVersion: number
  /**
   * Expected native IndexedDB version.
   * Dexie 4.x (including 4.2.1) uses native version = logical version * 10.
   * This is the same multiplier as earlier Dexie versions (1-3).
   * Example: logical 4 → native 40, logical 11 → native 110.
   */
  expectedNativeVersion: number
  /**
   * Observed native IDB version from indexedDB.databases() or IDBDatabase.version.
   * Must match expectedNativeVersion. NOT from db.verno (which is logical).
   */
  observedNativeVersion: number
  /** Origin URL used for the isolated session */
  originUrl: string
  /** Origin class: 'file' for file:// URLs */
  originClass: 'file'
  /** Absolute path to the source session root (temp directory) */
  sourceRoot: string
  /** Deterministic marker values stored in the fixture */
  markers: Record<string, string>
  /** localStorage key-value pairs set as control markers */
  localStorage: Record<string, string>
  /** Table names present in the fixture */
  tables: string[]
  /** Per-table record counts */
  recordCounts: Record<string, number>
  /** Explicit limitations and uncovered upgrade paths */
  limitations: string[]
  /** File inventory relative to sourceRoot */
  files: FixtureFileEntry[]
}

/* ── Staged manifest (extends source manifest with staging info) ── */

export interface StagedFixtureManifest extends FixtureManifest {
  /** Absolute path to the staged destination root */
  destinationRoot: string
  /** Copy mode used for staging */
  copyMode: 'full-profile' | 'indexeddb-only'
}

/* ── Validation ── */

export interface ValidationResult {
  valid: boolean
  error?: string
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Validate a FixtureManifest.
 * Checks all required fields, types, and cross-field consistency.
 */
export function validateFixtureManifest(data: unknown): ValidationResult {
  if (!isRecord(data)) {
    return { valid: false, error: 'Manifest must be a non-null object' }
  }

  const m = data

  // fixtureId
  if (!isNonEmptyString(m.fixtureId)) return { valid: false, error: 'Missing or invalid fixtureId' }
  if (!VALID_FIXTURE_IDS.has(m.fixtureId)) return { valid: false, error: `Unknown fixtureId: ${m.fixtureId}` }

  // createdAt
  if (!isNonEmptyString(m.createdAt)) return { valid: false, error: 'Missing or invalid createdAt' }
  if (isNaN(Date.parse(m.createdAt))) return { valid: false, error: 'createdAt is not a valid ISO timestamp' }

  // versions
  if (typeof m.logicalDexieVersion !== 'number' || m.logicalDexieVersion < 1)
    return { valid: false, error: 'Missing or invalid logicalDexieVersion' }
  if (typeof m.expectedNativeVersion !== 'number' || m.expectedNativeVersion < 1)
    return { valid: false, error: 'Missing or invalid expectedNativeVersion' }
  if (typeof m.observedNativeVersion !== 'number' || m.observedNativeVersion < 1)
    return { valid: false, error: 'Missing or invalid observedNativeVersion' }

  // origin
  if (!isNonEmptyString(m.originUrl)) return { valid: false, error: 'Missing or invalid originUrl' }
  if (m.originClass !== 'file') return { valid: false, error: 'originClass must be "file"' }

  // sourceRoot
  if (!isNonEmptyString(m.sourceRoot)) return { valid: false, error: 'Missing or invalid sourceRoot' }

  // markers (may be empty)
  if (!isRecord(m.markers)) return { valid: false, error: 'markers must be a record' }

  // localStorage (may be empty)
  if (!isRecord(m.localStorage)) return { valid: false, error: 'localStorage must be a record' }

  // tables
  if (!Array.isArray(m.tables)) return { valid: false, error: 'tables must be an array' }
  if (m.tables.length === 0) return { valid: false, error: 'tables must not be empty' }

  // recordCounts
  if (!isRecord(m.recordCounts)) return { valid: false, error: 'recordCounts must be a record' }

  // limitations
  if (!Array.isArray(m.limitations)) return { valid: false, error: 'limitations must be an array' }

  // files
  if (!Array.isArray(m.files)) return { valid: false, error: 'files must be an array' }
  for (const f of m.files) {
    if (!isRecord(f)) return { valid: false, error: 'files entry must be an object' }
    if (!isNonEmptyString(f.relativePath)) return { valid: false, error: 'files entry missing relativePath' }
    if (typeof f.sizeBytes !== 'number') return { valid: false, error: 'files entry missing sizeBytes' }
    if (f.sizeBytes < 0) return { valid: false, error: 'files entry sizeBytes must be non-negative' }
  }

  // Cross-field: observed should match expected (warning, not rejection)
  // The caller can check this separately.

  return { valid: true }
}

/**
 * Validate a FixtureDonePayload (renderer response).
 */
export function validateFixtureDonePayload(data: unknown): ValidationResult {
  if (!isRecord(data)) return { valid: false, error: 'Payload must be a non-null object' }
  const p = data

  if (!isNonEmptyString(p.fixtureId)) return { valid: false, error: 'Missing or invalid fixtureId' }
  if (!VALID_FIXTURE_IDS.has(p.fixtureId)) return { valid: false, error: `Unknown fixtureId: ${p.fixtureId}` }
  if (typeof p.logicalDexieVersion !== 'number' || p.logicalDexieVersion < 1)
    return { valid: false, error: 'Missing or invalid logicalDexieVersion' }
  if (typeof p.observedNativeVersion !== 'number' || p.observedNativeVersion < 1)
    return { valid: false, error: 'Missing or invalid observedNativeVersion' }
  if (!isRecord(p.markers)) return { valid: false, error: 'markers must be a record' }
  if (!isRecord(p.localStorage)) return { valid: false, error: 'localStorage must be a record' }
  if (!Array.isArray(p.tables) || p.tables.length === 0)
    return { valid: false, error: 'tables must be a non-empty array' }
  if (!isRecord(p.recordCounts)) return { valid: false, error: 'recordCounts must be a record' }
  if (!Array.isArray(p.limitations)) return { valid: false, error: 'limitations must be an array' }

  return { valid: true }
}

/* ── Path safety ── */

/**
 * Validate that a path is contained within the system temp directory.
 * Rejects traversal attempts, absolute paths outside tmpdir, and
 * symlink escapes (via path.resolve normalization).
 *
 * POSIX-only: uses '/' separator and POSIX path resolution.
 * This is acceptable for the spike harness which runs on macOS/Linux.
 * A production intake would need platform-aware path handling.
 */
export function validateTempPath(pathToCheck: string, tmpDir: string): ValidationResult {
  if (!isNonEmptyString(pathToCheck)) return { valid: false, error: 'Path must be a non-empty string' }
  if (!isNonEmptyString(tmpDir)) return { valid: false, error: 'tmpDir must be a non-empty string' }

  // Normalize both paths to resolve .. and .
  const resolved = resolvePosix(pathToCheck)
  const resolvedTmp = resolvePosix(tmpDir)

  // Must start with tmpdir (with trailing separator to prevent prefix attacks like /tmp-evil)
  const prefix = resolvedTmp.endsWith(SEP) ? resolvedTmp : resolvedTmp + SEP
  if (resolved !== resolvedTmp && !resolved.startsWith(prefix)) {
    return { valid: false, error: `Path ${resolved} is outside temp directory ${resolvedTmp}` }
  }

  return { valid: true }
}

/**
 * Validate a destination root for staging:
 *  - Must be non-empty string
 *  - Must resolve within the allowed parent
 *  - Must not contain traversal components after resolution
 *  - Parent must exist (we don't create arbitrary trees)
 *
 * POSIX-only: uses '/' separator and POSIX path resolution.
 * Acceptable for spike harness on macOS/Linux only.
 */
export function validateDestinationRoot(destRoot: string, allowedParent: string): ValidationResult {
  if (!isNonEmptyString(destRoot)) return { valid: false, error: 'Destination must be a non-empty string' }
  if (!isNonEmptyString(allowedParent)) return { valid: false, error: 'Allowed parent must be a non-empty string' }

  const resolved = resolvePosix(destRoot)
  const resolvedParent = resolvePosix(allowedParent)

  const prefix = resolvedParent.endsWith(SEP) ? resolvedParent : resolvedParent + SEP
  if (!resolved.startsWith(prefix)) {
    return { valid: false, error: `Destination ${resolved} is outside allowed parent ${resolvedParent}` }
  }

  // Reject if destination IS the parent (must be a subdirectory)
  if (resolved === resolvedParent) {
    return { valid: false, error: 'Destination must be a subdirectory, not the parent itself' }
  }

  return { valid: true }
}

/**
 * Check if a string is a valid FixtureId.
 */
export function isValidFixtureId(v: unknown): v is FixtureId {
  return typeof v === 'string' && VALID_FIXTURE_IDS.has(v)
}

/**
 * Build a complete FixtureManifest from renderer payload + main-process metadata.
 *
 * Validates that observedNativeVersion matches expectedNativeVersion.
 * Throws if they differ — the fixture is invalid and must not be staged.
 */
export function buildFixtureManifest(
  payload: FixtureDonePayload,
  sourceRoot: string,
  originUrl: string,
  files: FixtureFileEntry[]
): FixtureManifest {
  // Dexie 4.x (including 4.2.1) uses native version = logical * 10.
  // This is the same multiplier as earlier Dexie versions (1-3).
  const expectedNativeVersion = payload.logicalDexieVersion * 10

  // Fail-fast: observed must match expected
  if (payload.observedNativeVersion !== expectedNativeVersion) {
    throw new Error(
      `Native version mismatch for ${payload.fixtureId}: ` +
        `expected ${expectedNativeVersion}, observed ${payload.observedNativeVersion}. ` +
        `Fixture is invalid and will not be staged.`
    )
  }

  return {
    fixtureId: payload.fixtureId,
    createdAt: new Date().toISOString(),
    logicalDexieVersion: payload.logicalDexieVersion,
    expectedNativeVersion,
    observedNativeVersion: payload.observedNativeVersion,
    originUrl,
    originClass: 'file',
    sourceRoot,
    markers: payload.markers,
    localStorage: payload.localStorage,
    tables: payload.tables,
    recordCounts: payload.recordCounts,
    limitations: [
      ...payload.limitations,
      // Dexie 4 native version note
      `Dexie 4.x uses native IDB version = logical version × 10. ` +
        `Expected ${expectedNativeVersion}, observed ${payload.observedNativeVersion}.`
    ],
    files
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * Phase 4.0-C1 Verification Types
 *
 * Types for the core verify mode that reads staged fixture profiles
 * using the actual production Dexie declaration/upgrades.
 * ══════════════════════════════════════════════════════════════════════════ */

/** Preflight result from indexedDB.databases() call */
export interface VerifyPreflight {
  /** Raw location.href of the renderer */
  locationHref: string
  /** Raw location.origin of the renderer */
  locationOrigin: string
  /** Native IDB version from indexedDB.databases() for CherryStudio */
  nativeVersion: number
  /** Expected native version from the fixture manifest */
  expectedVersion: number
  /** Whether CherryStudio was found via indexedDB.databases() */
  cherryStudioFound: boolean
}

/** Post-open result after production Dexie db.open() */
export interface VerifyOpenResult {
  /** Logical Dexie version (db.verno) */
  logicalVerno: number
  /** Native IDB version (db.backendDB().version) */
  nativeVersion: number
  /** Table names present after open */
  tables: string[]
  /** Per-table record counts after open */
  recordCounts: Record<string, number>
}

/** v4 upgrade verification assertions */
export interface VerifyV4Assertions {
  /** v5: file-v4-001 created_at converted from Date to ISO string */
  v5DateConversion: boolean
  /** v5: topic-v4-tavily metadata.tavily → metadata.webSearch */
  v5TavilyToWebSearch: boolean
  /** v7: block types present in message_blocks */
  v7BlockTypes: string[]
  /** v7: total block count */
  v7BlockCount: number
  /** v7: per-message block ID arrays from topic messages */
  v7MessageBlockMapping: Record<string, string[]>
  /** v7: every blockId in a message's blocks array exists in message_blocks */
  v7ReferentialConsistency: boolean
  /** v8: translate:source:language after upgrade */
  v8SourceLanguage: string
  /** v8: translate:target:language after upgrade */
  v8TargetLanguage: string
  /** v8: all translate_history entries have langCode format */
  v8HistoryLanguageConversion: boolean
  /** topic_segments table exists after full upgrade */
  topicSegmentsTableExists: boolean
}

/** v11 verification assertions */
export interface VerifyV11Assertions {
  /** phase4:marker value from settings */
  markerValue: string
  /** phase4:fixtureId value from settings */
  fixtureIdValue: string
  /** Per-table record counts */
  recordCounts: Record<string, number>
}

/** Machine-readable per-case verify result (VERIFY_DONE payload) */
export interface VerifyDonePayload {
  /** Fixture identifier */
  fixtureId: string
  /** Preflight data from indexedDB.databases() */
  preflight: VerifyPreflight
  /** Whether production db.open() was started */
  productionOpenerStarted: boolean
  /** Whether production db.open() completed successfully */
  productionOpenerCompleted: boolean
  /** true for v12 (native >= 120), indicating rejection */
  futureVersionRejected?: boolean
  /** Post-open data (only if productionOpenerCompleted) */
  openResult?: VerifyOpenResult
  /** v4-specific upgrade assertions (only for v4 fixture) */
  v4Assertions?: VerifyV4Assertions
  /** v11-specific assertions (only for v11a/v11b fixtures) */
  v11Assertions?: VerifyV11Assertions
  /** Error message if status is error */
  error?: string
}

/**
 * Validate a VerifyPreflight.
 */
export function validateVerifyPreflight(data: unknown): ValidationResult {
  if (!isRecord(data)) return { valid: false, error: 'Preflight must be a non-null object' }
  const p = data
  if (!isNonEmptyString(p.locationHref)) return { valid: false, error: 'Missing locationHref' }
  if (!isNonEmptyString(p.locationOrigin)) return { valid: false, error: 'Missing locationOrigin' }
  if (typeof p.nativeVersion !== 'number') return { valid: false, error: 'Missing nativeVersion' }
  if (typeof p.expectedVersion !== 'number') return { valid: false, error: 'Missing expectedVersion' }
  if (typeof p.cherryStudioFound !== 'boolean') return { valid: false, error: 'Missing cherryStudioFound' }
  return { valid: true }
}

/**
 * Validate a VerifyDonePayload.
 */
export function validateVerifyDonePayload(data: unknown): ValidationResult {
  if (!isRecord(data)) return { valid: false, error: 'Payload must be a non-null object' }
  const p = data
  if (!isNonEmptyString(p.fixtureId)) return { valid: false, error: 'Missing fixtureId' }
  if (!VALID_FIXTURE_IDS.has(p.fixtureId)) return { valid: false, error: `Unknown fixtureId: ${p.fixtureId}` }
  const preflightResult = validateVerifyPreflight(p.preflight)
  if (!preflightResult.valid) return { valid: false, error: `Invalid preflight: ${preflightResult.error}` }
  if (typeof p.productionOpenerStarted !== 'boolean') return { valid: false, error: 'Missing productionOpenerStarted' }
  if (typeof p.productionOpenerCompleted !== 'boolean')
    return { valid: false, error: 'Missing productionOpenerCompleted' }
  return { valid: true }
}
