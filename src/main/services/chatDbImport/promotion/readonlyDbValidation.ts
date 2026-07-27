/**
 * Shared readonly chat-DB validation gate + durability helpers
 * (Phase 4.4.1/4.4.2, LOCK-4412/LOCK-4424).
 *
 * Private promotion-internal module extracted from `snapshot.ts` so the
 * rollback-snapshot validator (Phase 4.4.1) and the replacement verifier
 * (Phase 4.4.2) run the EXACT same gate sequence over a candidate file:
 *
 *   readonly + fileMustExist open → PRAGMA integrity_check → PRAGMA
 *   foreign_key_check → exact migration-state compatibility against the
 *   registered MIGRATIONS → minimum application-layer sample reads through
 *   the production repository/aggregate read path.
 *
 * Failures resolve to a bounded gate name plus a safe machine sub-code —
 * never raw messages, paths, or stack traces. Callers map the gate to
 * their own bounded failure-code unions (SNAPSHOT_* / REPLACEMENT_*).
 *
 * Main-only module. Not exposed over IPC/preload/renderer.
 */

import fs from 'node:fs'

import { ChatDbAggregateService } from '@main/services/chatDb/ChatDbAggregateService'
import { MIGRATIONS } from '@main/services/chatDb/migration'
import { createRepositories } from '@main/services/chatDb/repository/factory'
import * as schema from '@main/services/chatDb/schema'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The five readonly validation gates, in execution order. */
export type ReadonlyChatDbValidationGate = 'open' | 'integrity' | 'foreign-keys' | 'migration' | 'sample-reads'

/** One validation rejection (bounded, safe fields only). */
export interface ReadonlyChatDbValidationFailure {
  readonly gate: ReadonlyChatDbValidationGate
  readonly safeCode: string | null
}

// ---------------------------------------------------------------------------
// Safe error codes + durability helpers (shared by snapshot + install)
// ---------------------------------------------------------------------------

/** Extract a safe machine code from an unknown error (no messages/paths). */
export function safeErrorCode(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && /^[A-Z0-9_]{2,64}$/.test(code)) return code
    if (error instanceof Error && error.name.length > 0) return error.name
  }
  return 'UNKNOWN'
}

/** fsync one file by path (durability of the bytes before a rename). */
export function fsyncFile(filePath: string): void {
  const fd = fs.openSync(filePath, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/** fsync a directory so a completed rename is durable (POSIX). */
export function fsyncDirectory(dirPath: string): void {
  const fd = fs.openSync(dirPath, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

// ---------------------------------------------------------------------------
// Individual gates
// ---------------------------------------------------------------------------

/**
 * Exact migration compatibility: the applied `migration_state` keys must
 * equal the registered MIGRATIONS keys as a set — a missing key means the
 * file is behind the running schema, an unknown key means it is ahead of
 * it. Any ambiguity is returned as incompatible, never relaxed.
 */
function checkMigrationCompatibility(sqlite: Database.Database): ReadonlyChatDbValidationFailure | null {
  const table = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_state'`)
    .get() as { name: string } | undefined
  if (table === undefined) {
    return { gate: 'migration', safeCode: 'MIGRATION_STATE_TABLE_MISSING' }
  }

  const rows = sqlite.prepare('SELECT key FROM migration_state').all() as Array<{ key: unknown }>
  const applied = new Set<string>()
  for (const row of rows) {
    if (typeof row.key !== 'string') {
      return { gate: 'migration', safeCode: 'MIGRATION_KEY_NOT_TEXT' }
    }
    applied.add(row.key)
  }

  for (const migration of MIGRATIONS) {
    if (!applied.has(migration.key)) {
      return { gate: 'migration', safeCode: 'MIGRATION_KEY_MISSING' }
    }
    applied.delete(migration.key)
  }
  if (applied.size > 0) {
    return { gate: 'migration', safeCode: 'MIGRATION_KEY_UNKNOWN' }
  }
  return null
}

/**
 * Minimum application-layer reads through the SAME repository/aggregate
 * read path production uses (candidateVerifier house style): topic count,
 * first topic page, per-topic aggregate raw read, and per-topic segment
 * membership reads. Zero rows is a valid (empty but migrated) database.
 */
function runSampleReads(sqlite: Database.Database, sampleCount: number): ReadonlyChatDbValidationFailure | null {
  try {
    const db = drizzle(sqlite, { schema })
    const repositories = createRepositories(db)
    const aggregate = new ChatDbAggregateService(db)

    const topicCount = repositories.topics.count()
    if (!Number.isInteger(topicCount) || topicCount < 0) {
      return { gate: 'sample-reads', safeCode: 'TOPIC_COUNT_INVALID' }
    }

    const page = repositories.topics.listPage({ limit: sampleCount, direction: 'asc' })
    for (const topic of page.items) {
      const raw = aggregate.getRawTopic(topic.id)
      if (!raw.ok) {
        return { gate: 'sample-reads', safeCode: raw.error.code }
      }
      if (raw.value === null || !Array.isArray(raw.value.messages)) {
        return { gate: 'sample-reads', safeCode: 'TOPIC_NOT_READABLE' }
      }
      const segments = repositories.segments.listByTopic(topic.id)
      for (const segment of segments.slice(0, sampleCount)) {
        const messageIds = repositories.segments.getMessageIds(segment.id)
        if (!Array.isArray(messageIds)) {
          return { gate: 'sample-reads', safeCode: 'SEGMENT_NOT_READABLE' }
        }
      }
    }
    return null
  } catch (error) {
    return { gate: 'sample-reads', safeCode: safeErrorCode(error) }
  }
}

// ---------------------------------------------------------------------------
// Full readonly gate sequence
// ---------------------------------------------------------------------------

/**
 * Full readonly validation gate (LOCK-4412 / LOCK-4424). Opens `dbPath`
 * strictly readonly; the handle closes on every outcome. Returns the first
 * failed gate or null when every gate passes. Never mutates the file.
 */
export function validateReadonlyChatDb(dbPath: string, sampleCount: number): ReadonlyChatDbValidationFailure | null {
  let sqlite: Database.Database | null = null
  try {
    try {
      sqlite = new Database(dbPath, { readonly: true, fileMustExist: true })
    } catch (error) {
      return { gate: 'open', safeCode: safeErrorCode(error) }
    }

    try {
      const rows = sqlite.pragma('integrity_check') as Array<Record<string, unknown>>
      if (!(rows.length === 1 && rows[0]?.integrity_check === 'ok')) {
        // Raw integrity output may reference internal structures — only
        // the finding count is reported.
        return { gate: 'integrity', safeCode: `FINDINGS_${rows.length}` }
      }
    } catch (error) {
      return { gate: 'integrity', safeCode: safeErrorCode(error) }
    }

    try {
      const violations = sqlite.pragma('foreign_key_check') as unknown[]
      if (violations.length > 0) {
        return { gate: 'foreign-keys', safeCode: `VIOLATIONS_${violations.length}` }
      }
    } catch (error) {
      return { gate: 'foreign-keys', safeCode: safeErrorCode(error) }
    }

    try {
      const migrationFailure = checkMigrationCompatibility(sqlite)
      if (migrationFailure !== null) return migrationFailure
    } catch (error) {
      return { gate: 'migration', safeCode: safeErrorCode(error) }
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
