/**
 * Rollback snapshot preparation — durable one-retained snapshot gate
 * (Phase 4.4.1, LOCK-4411/4412/4417).
 *
 * Executes the first three PROMOTION_OPERATION_ORDER steps plus the
 * existence confirmation that must precede any journal write:
 *
 *   1. create-rollback-snapshot  — SQLite online backup of the OPEN live
 *      chat.db into the fixed staging name
 *      {@link ROLLBACK_SNAPSHOT_STAGING_FILENAME} next to the live DB.
 *      The live handle is borrowed, never closed, and live WAL/SHM
 *      sidecars are NEVER copied — the online backup API produces a
 *      self-contained snapshot (LOCK-4403/4411).
 *   2. verify-rollback-snapshot  — FULL validation of the staging file:
 *      readonly + fileMustExist open, PRAGMA integrity_check, PRAGMA
 *      foreign_key_check, exact migration-state compatibility against the
 *      registered MIGRATIONS, and minimum application-layer sample reads
 *      through the existing repository/aggregate read path (LOCK-4412).
 *   3. publish-rollback-snapshot — durable atomic rename staging →
 *      {@link ROLLBACK_SNAPSHOT_FILENAME} (one-retained ordering), with
 *      staging-file fsync before the rename and parent-directory fsync
 *      after it, then an explicit retained-existence confirmation.
 *
 * Failure semantics (LOCK-4411):
 * - Any backup/validation failure leaves the previously retained snapshot
 *   byte-for-byte untouched — only the staging file is cleaned up.
 * - The live DB stays open and authoritative on every outcome.
 * - This unit NEVER writes the promotion journal (LOCK-4417); the caller
 *   may journal `snapshot-ready` only after an `ok: true` result.
 *
 * All operational failures resolve to a structured result with a bounded
 * machine code — no raw messages, paths, or stack traces. Main-only
 * module. Not exposed over IPC/preload/renderer.
 */

import fs from 'node:fs'
import path from 'node:path'

import { loggerService } from '@logger'
import { BetterSqlite3BackupAdapter } from '@main/services/chatDb/backup'
import { ChatDbAggregateService } from '@main/services/chatDb/ChatDbAggregateService'
import { MIGRATIONS } from '@main/services/chatDb/migration'
import { createRepositories } from '@main/services/chatDb/repository/factory'
import * as schema from '@main/services/chatDb/schema'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import { ROLLBACK_SNAPSHOT_FILENAME, ROLLBACK_SNAPSHOT_STAGING_FILENAME } from './journal'

const logger = loggerService.withContext('ChatDbRollbackSnapshot')

// ---------------------------------------------------------------------------
// Options / result types
// ---------------------------------------------------------------------------

export interface PrepareRollbackSnapshotOptions {
  /** Directory containing the live chat.db (the Data root). */
  dbDir: string
  /**
   * Returns the OPEN live better-sqlite3 handle. The handle is only used
   * as the online-backup source; it is never closed, written, or replaced
   * here (LOCK-4411).
   */
  getLiveSqlite: () => Database.Database
  /** Topics/segments sampled for application-layer reads (default 3, min 1). */
  sampleCount?: number
  /**
   * Test-only hook invoked AFTER the staging snapshot is created and
   * BEFORE validation starts (deterministic staging fault injection).
   */
  onAfterBackup?: () => void
  /**
   * Test-only hook invoked AFTER validation + staging fsync and BEFORE
   * the atomic rename (deterministic replacement-interruption injection).
   */
  onBeforePublish?: () => void
}

/** Bounded machine-readable failure codes (never carry content or paths). */
export type RollbackSnapshotFailureCode =
  | 'ONLINE_BACKUP_FAILED'
  | 'SNAPSHOT_OPEN_FAILED'
  | 'SNAPSHOT_INTEGRITY_FAILED'
  | 'SNAPSHOT_FOREIGN_KEYS_FAILED'
  | 'SNAPSHOT_MIGRATION_INCOMPATIBLE'
  | 'SNAPSHOT_SAMPLE_READ_FAILED'
  | 'SNAPSHOT_DURABILITY_FAILED'
  | 'RETAINED_PUBLISH_FAILED'
  | 'RETAINED_DIRECTORY_SYNC_FAILED'
  | 'RETAINED_CONFIRMATION_FAILED'

/** Result of {@link prepareRollbackSnapshot}. Never throws for operational failures. */
export type RollbackSnapshotResult =
  | {
      readonly ok: true
      /** Absolute path of the confirmed retained snapshot. */
      readonly retainedPath: string
      /** Pages copied by the online backup (diagnostic only). */
      readonly pagesCopied: number
    }
  | {
      readonly ok: false
      readonly code: RollbackSnapshotFailureCode
      /** Safe machine sub-code (error code/name only — never messages/paths). */
      readonly safeCode: string | null
      /**
       * True when the previously retained snapshot (if any) is guaranteed
       * untouched. False only for post-rename failures, where the retained
       * name already holds the NEW validated snapshot.
       */
      readonly oldRetainedPreserved: boolean
    }

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract a safe machine code from an unknown error (no messages/paths). */
function safeErrorCode(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && /^[A-Z0-9_]{2,64}$/.test(code)) return code
    if (error instanceof Error && error.name.length > 0) return error.name
  }
  return 'UNKNOWN'
}

/** One staging validation rejection (bounded, safe fields only). */
interface ValidationFailure {
  readonly code: RollbackSnapshotFailureCode
  readonly safeCode: string | null
}

function failure(
  code: RollbackSnapshotFailureCode,
  safeCode: string | null,
  oldRetainedPreserved: boolean
): RollbackSnapshotResult {
  return Object.freeze({ ok: false as const, code, safeCode, oldRetainedPreserved })
}

/**
 * Remove the staging snapshot and any staging sidecars (best-effort).
 * NEVER touches the live chat.db, its sidecars, or the retained snapshot.
 */
function cleanupStaging(stagingPath: string): void {
  for (const candidate of [stagingPath, `${stagingPath}-wal`, `${stagingPath}-shm`]) {
    try {
      fs.unlinkSync(candidate)
    } catch {
      // Best-effort cleanup — absence is the expected common case.
    }
  }
}

/** fsync one file by path (durability of the staging bytes before rename). */
function fsyncFile(filePath: string): void {
  const fd = fs.openSync(filePath, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/** fsync a directory so a completed rename is durable (POSIX). */
function fsyncDirectory(dirPath: string): void {
  const fd = fs.openSync(dirPath, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

// ---------------------------------------------------------------------------
// Staging validation — readonly, full gate (LOCK-4412)
// ---------------------------------------------------------------------------

/**
 * Exact migration compatibility: the applied `migration_state` keys must
 * equal the registered MIGRATIONS keys as a set — a missing key means the
 * snapshot is behind the running schema, an unknown key means it is ahead
 * of it. Any ambiguity is returned as incompatible, never relaxed.
 */
function checkMigrationCompatibility(sqlite: Database.Database): ValidationFailure | null {
  const table = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_state'`)
    .get() as { name: string } | undefined
  if (table === undefined) {
    return { code: 'SNAPSHOT_MIGRATION_INCOMPATIBLE', safeCode: 'MIGRATION_STATE_TABLE_MISSING' }
  }

  const rows = sqlite.prepare('SELECT key FROM migration_state').all() as Array<{ key: unknown }>
  const applied = new Set<string>()
  for (const row of rows) {
    if (typeof row.key !== 'string') {
      return { code: 'SNAPSHOT_MIGRATION_INCOMPATIBLE', safeCode: 'MIGRATION_KEY_NOT_TEXT' }
    }
    applied.add(row.key)
  }

  for (const migration of MIGRATIONS) {
    if (!applied.has(migration.key)) {
      return { code: 'SNAPSHOT_MIGRATION_INCOMPATIBLE', safeCode: 'MIGRATION_KEY_MISSING' }
    }
    applied.delete(migration.key)
  }
  if (applied.size > 0) {
    return { code: 'SNAPSHOT_MIGRATION_INCOMPATIBLE', safeCode: 'MIGRATION_KEY_UNKNOWN' }
  }
  return null
}

/**
 * Minimum application-layer reads over the snapshot through the SAME
 * repository/aggregate read path production uses (candidateVerifier house
 * style): topic count, first topic page, per-topic aggregate raw read,
 * and per-topic segment membership reads. Zero rows is a valid snapshot
 * of an empty (but migrated) live DB.
 */
function runSampleReads(sqlite: Database.Database, sampleCount: number): ValidationFailure | null {
  try {
    const db = drizzle(sqlite, { schema })
    const repositories = createRepositories(db)
    const aggregate = new ChatDbAggregateService(db)

    const topicCount = repositories.topics.count()
    if (!Number.isInteger(topicCount) || topicCount < 0) {
      return { code: 'SNAPSHOT_SAMPLE_READ_FAILED', safeCode: 'TOPIC_COUNT_INVALID' }
    }

    const page = repositories.topics.listPage({ limit: sampleCount, direction: 'asc' })
    for (const topic of page.items) {
      const raw = aggregate.getRawTopic(topic.id)
      if (!raw.ok) {
        return { code: 'SNAPSHOT_SAMPLE_READ_FAILED', safeCode: raw.error.code }
      }
      if (raw.value === null || !Array.isArray(raw.value.messages)) {
        return { code: 'SNAPSHOT_SAMPLE_READ_FAILED', safeCode: 'TOPIC_NOT_READABLE' }
      }
      const segments = repositories.segments.listByTopic(topic.id)
      for (const segment of segments.slice(0, sampleCount)) {
        const messageIds = repositories.segments.getMessageIds(segment.id)
        if (!Array.isArray(messageIds)) {
          return { code: 'SNAPSHOT_SAMPLE_READ_FAILED', safeCode: 'SEGMENT_NOT_READABLE' }
        }
      }
    }
    return null
  } catch (error) {
    return { code: 'SNAPSHOT_SAMPLE_READ_FAILED', safeCode: safeErrorCode(error) }
  }
}

/**
 * Full staging validation gate (LOCK-4412 step 2). Opens the staging file
 * strictly readonly; the handle closes on every outcome. Returns the first
 * failed gate or null when every gate passes.
 */
function validateStagingSnapshot(stagingPath: string, sampleCount: number): ValidationFailure | null {
  let sqlite: Database.Database | null = null
  try {
    try {
      sqlite = new Database(stagingPath, { readonly: true, fileMustExist: true })
    } catch (error) {
      return { code: 'SNAPSHOT_OPEN_FAILED', safeCode: safeErrorCode(error) }
    }

    try {
      const rows = sqlite.pragma('integrity_check') as Array<Record<string, unknown>>
      if (!(rows.length === 1 && rows[0]?.integrity_check === 'ok')) {
        // Raw integrity output may reference internal structures — only
        // the finding count is reported.
        return { code: 'SNAPSHOT_INTEGRITY_FAILED', safeCode: `FINDINGS_${rows.length}` }
      }
    } catch (error) {
      return { code: 'SNAPSHOT_INTEGRITY_FAILED', safeCode: safeErrorCode(error) }
    }

    try {
      const violations = sqlite.pragma('foreign_key_check') as unknown[]
      if (violations.length > 0) {
        return { code: 'SNAPSHOT_FOREIGN_KEYS_FAILED', safeCode: `VIOLATIONS_${violations.length}` }
      }
    } catch (error) {
      return { code: 'SNAPSHOT_FOREIGN_KEYS_FAILED', safeCode: safeErrorCode(error) }
    }

    try {
      const migrationFailure = checkMigrationCompatibility(sqlite)
      if (migrationFailure !== null) return migrationFailure
    } catch (error) {
      return { code: 'SNAPSHOT_MIGRATION_INCOMPATIBLE', safeCode: safeErrorCode(error) }
    }

    return runSampleReads(sqlite, sampleCount)
  } finally {
    try {
      sqlite?.close()
    } catch {
      // Validation handle close failure is not a gate result.
    }
  }
}

// ---------------------------------------------------------------------------
// prepareRollbackSnapshot — snapshot → validate → publish → confirm
// ---------------------------------------------------------------------------

/**
 * Create, fully validate, and durably publish the ONE retained rollback
 * snapshot for the live chat.db (LOCK-4412 required ordering):
 *
 *   online backup → staging  ⇒  full staging validation  ⇒  fsync staging
 *   ⇒  atomic rename staging → retained  ⇒  fsync parent directory
 *   ⇒  confirm retained exists
 *
 * The previously retained snapshot is replaced ONLY by the atomic rename
 * of an already-validated staging file; every earlier failure leaves it
 * untouched and cleans up staging (LOCK-4411). No journal I/O (LOCK-4417).
 */
export async function prepareRollbackSnapshot(
  options: PrepareRollbackSnapshotOptions
): Promise<RollbackSnapshotResult> {
  const sampleCount = Math.max(1, Math.floor(options.sampleCount ?? 3))
  const stagingPath = path.join(options.dbDir, ROLLBACK_SNAPSHOT_STAGING_FILENAME)
  const retainedPath = path.join(options.dbDir, ROLLBACK_SNAPSHOT_FILENAME)

  // Stale staging from an earlier interrupted attempt is ours to discard.
  cleanupStaging(stagingPath)

  // --- Step 1: online backup of the OPEN live DB into fixed staging ------
  let pagesCopied: number
  try {
    const adapter = new BetterSqlite3BackupAdapter(options.getLiveSqlite)
    pagesCopied = await adapter.createSnapshot(stagingPath)
  } catch (error) {
    logger.warn('Rollback snapshot online backup failed — old retained snapshot untouched')
    cleanupStaging(stagingPath)
    return failure('ONLINE_BACKUP_FAILED', safeErrorCode(error), true)
  }

  try {
    options.onAfterBackup?.()

    // --- Step 2: full validation of the staging snapshot ------------------
    const validationFailure = validateStagingSnapshot(stagingPath, sampleCount)
    if (validationFailure !== null) {
      logger.warn(`Rollback snapshot validation failed (${validationFailure.code}) — old retained snapshot untouched`)
      cleanupStaging(stagingPath)
      return failure(validationFailure.code, validationFailure.safeCode, true)
    }

    // --- Step 3: durable publish (one-retained atomic replacement) --------
    try {
      fsyncFile(stagingPath)
    } catch (error) {
      cleanupStaging(stagingPath)
      return failure('SNAPSHOT_DURABILITY_FAILED', safeErrorCode(error), true)
    }

    try {
      options.onBeforePublish?.()
      fs.renameSync(stagingPath, retainedPath)
    } catch (error) {
      logger.warn('Rollback snapshot publish failed — old retained snapshot untouched')
      cleanupStaging(stagingPath)
      return failure('RETAINED_PUBLISH_FAILED', safeErrorCode(error), true)
    }

    try {
      fsyncDirectory(options.dbDir)
    } catch (error) {
      // The rename already happened: the retained name now holds the NEW
      // validated snapshot, but its durability is unconfirmed.
      return failure('RETAINED_DIRECTORY_SYNC_FAILED', safeErrorCode(error), false)
    }

    // --- Existence confirmation (precondition for any journal write) ------
    try {
      if (!fs.statSync(retainedPath).isFile()) {
        return failure('RETAINED_CONFIRMATION_FAILED', 'NOT_A_FILE', false)
      }
    } catch (error) {
      return failure('RETAINED_CONFIRMATION_FAILED', safeErrorCode(error), false)
    }

    logger.info(`Rollback snapshot retained and confirmed (${pagesCopied} pages)`)
    return Object.freeze({ ok: true as const, retainedPath, pagesCopied })
  } catch (error) {
    // Unexpected failure (including test-hook throws outside guarded
    // stages): staging is discarded, old retained stays untouched.
    cleanupStaging(stagingPath)
    return failure('RETAINED_PUBLISH_FAILED', safeErrorCode(error), true)
  }
}
