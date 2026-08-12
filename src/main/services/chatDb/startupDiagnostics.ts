/**
 * Bounded, privacy-safe startup SQLite metadata/timings (LOCK-001..003).
 *
 * Emitted once per process after ChatDb init succeeds (and as a bounded
 * failure diagnostic when init fails). Purpose: distinguish a personal-profile
 * cold DB/WAL/migration issue from append-path work WITHOUT scanning or
 * mutating the database:
 *
 * - Stage timings around `new Database`, pragma setup, and migrations use the
 *   monotonic clock and fixed stage names.
 * - One compact metadata log carries bucketed DB/WAL/SHM file sizes/presence
 *   (stat metadata from the existing DB path only) and read-only fixed
 *   PRAGMA values sampled from the EXISTING live handle. No new connection,
 *   no row scans, no path or content is ever logged.
 * - Every read is failure-safe: a failing stat or PRAGMA becomes a safe
 *   boolean/unknown (null), never a throw from diagnostics.
 */

import * as fs from 'node:fs'

import type Database from 'better-sqlite3'

import { logMainDiagnostic } from '../diagnostics'

/** Once-per-process budget for every startup diagnostic stage (LOCK-003). */
export const STARTUP_DIAGNOSTIC_LIMIT = 1

/** Fixed, read-only PRAGMA names sampled from the live handle at startup. */
export const STARTUP_PRAGMAS = [
  'page_count',
  'page_size',
  'cache_size',
  'mmap_size',
  'wal_autocheckpoint',
  'synchronous',
  'foreign_keys',
  'busy_timeout',
  'freelist_count',
  'auto_vacuum',
  'schema_version',
  'user_version'
] as const

export type StartupPragmaName = (typeof STARTUP_PRAGMAS)[number]

/** Minimal stat shape consumed by the metadata collector (injectable seam). */
export interface StartupFileStat {
  size: number
}

/** Injectable stat provider so tests never touch a real filesystem/DB. */
export type FileStatsProvider = (filePath: string) => StartupFileStat | undefined

interface FileMetadata {
  dbSizeBucket: string | null
  walPresent: boolean
  walSizeBucket: string | null
  shmPresent: boolean
  shmSizeBucket: string | null
}

export interface StartupMetadata extends FileMetadata {
  sqlite: Record<StartupPragmaName, number | string | null>
}

const SIZE_BUCKETS: Array<{ max: number; label: string }> = [
  { max: 0, label: '0B' },
  { max: 1024, label: '<1KB' },
  { max: 1024 * 1024, label: '1KB-1MB' },
  { max: 10 * 1024 * 1024, label: '1-10MB' },
  { max: 100 * 1024 * 1024, label: '10-100MB' },
  { max: 1024 * 1024 * 1024, label: '100MB-1GB' },
  { max: Number.POSITIVE_INFINITY, label: '>1GB' }
]

/**
 * Bucket a byte size into a fixed, non-sensitive category (LOCK-002: exact
 * personal-profile file sizes are not logged).
 */
export function bucketFileSize(bytes: number): string {
  for (const bucket of SIZE_BUCKETS) {
    if (bytes <= bucket.max) {
      return bucket.label
    }
  }
  return '>1GB'
}

/**
 * Safe file stat: any failure (missing file, mocked/unavailable stat) is a
 * safe `undefined`, never a throw from diagnostics.
 */
export function safeStat(filePath: string): StartupFileStat | undefined {
  try {
    const st = fs.statSync(filePath)
    return { size: st.size }
  } catch {
    return undefined
  }
}

function collectFileMetadata(dbPath: string, fileStats: FileStatsProvider): FileMetadata {
  // Every stat is individually failure-safe: a throwing or unavailable stat
  // becomes a safe absence/unknown, never a throw from diagnostics (LOCK-002).
  const dbStat = safeFileStat(dbPath, fileStats)
  const walStat = safeFileStat(`${dbPath}-wal`, fileStats)
  const shmStat = safeFileStat(`${dbPath}-shm`, fileStats)
  return {
    dbSizeBucket: dbStat ? bucketFileSize(dbStat.size) : null,
    walPresent: walStat !== undefined,
    walSizeBucket: walStat ? bucketFileSize(walStat.size) : null,
    shmPresent: shmStat !== undefined,
    shmSizeBucket: shmStat ? bucketFileSize(shmStat.size) : null
  }
}

function safeFileStat(filePath: string, fileStats: FileStatsProvider): StartupFileStat | undefined {
  try {
    return fileStats(filePath)
  } catch {
    return undefined
  }
}

/**
 * Safe read-only PRAGMA sample. Any throwing read (or a non-primitive
 * result) becomes a safe `null` ("unknown"), never a throw.
 */
function safePragma(sqlite: Pick<Database.Database, 'pragma'>, name: StartupPragmaName): number | string | null {
  try {
    const value = sqlite.pragma(name, { simple: true })
    return typeof value === 'number' || typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

/**
 * Collect sanitized startup metadata from the existing live handle and the
 * existing DB path only (file stat metadata). Never opens a new connection,
 * scans rows, or reads file content.
 */
export function collectStartupMetadata(
  sqlite: Pick<Database.Database, 'pragma'>,
  dbPath: string,
  fileStats: FileStatsProvider = safeStat
): StartupMetadata {
  const files = collectFileMetadata(dbPath, fileStats)
  const pragmaValues = {} as Record<StartupPragmaName, number | string | null>
  for (const name of STARTUP_PRAGMAS) {
    pragmaValues[name] = safePragma(sqlite, name)
  }
  return { ...files, sqlite: pragmaValues }
}

/**
 * Emit once-per-process startup diagnostics after ChatDb init succeeds:
 * one stage timing log per measured phase plus one compact metadata log.
 * Never logs the DB path or any file/content; never throws.
 */
export function emitStartupDiagnostics(
  sqlite: Pick<Database.Database, 'pragma'>,
  dbPath: string,
  stageTimings: Record<string, number>,
  totalDurationMs: number
): void {
  for (const [stage, durationMs] of Object.entries(stageTimings)) {
    logMainDiagnostic(stage, durationMs, STARTUP_DIAGNOSTIC_LIMIT, { ok: true })
  }
  const metadata = collectStartupMetadata(sqlite, dbPath)
  logMainDiagnostic('chatdb.startup.metadata', totalDurationMs, STARTUP_DIAGNOSTIC_LIMIT, {
    success: true,
    ...metadata
  })
}

/**
 * Emit a once-per-process failure diagnostic when ChatDb init fails. Only
 * safe file presence/size buckets and measured stage timings are logged;
 * never throws and never replaces the original init error (LOCK-001).
 */
export function emitStartupFailureDiagnostics(
  dbPath: string,
  stageTimings: Record<string, number>,
  totalDurationMs: number
): void {
  const files = collectFileMetadata(dbPath, safeStat)
  logMainDiagnostic('chatdb.init.failed', totalDurationMs, STARTUP_DIAGNOSTIC_LIMIT, {
    success: false,
    ...files,
    stages: stageTimings
  })
}
