/**
 * Shared readonly chat-DB validation gate + durability helpers
 * (Phase 4.4.1/4.4.2, LOCK-4412/LOCK-4424, LOCK-SP-5).
 *
 * Private promotion-internal module extracted from `snapshot.ts` so the
 * rollback-snapshot validator (Phase 4.4.1) and the replacement verifier
 * (Phase 4.4.2) run the EXACT same gate sequence over a candidate file:
 *
 *   readonly + fileMustExist open → PRAGMA integrity_check → PRAGMA
 *   foreign_key_check → exact migration-state compatibility against the
 *   registered MIGRATIONS → derived search-projection gate (LOCK-SP-5:
 *   required objects, count parity, messageId parity, fixed MATCH smoke) →
 *   minimum application-layer sample reads through the production
 *   repository/aggregate read path.
 *
 * Failures resolve to a bounded gate name plus a safe machine sub-code —
 * never raw messages, paths, or stack traces. Callers map the gate to
 * their own bounded failure-code unions (SNAPSHOT_* / REPLACEMENT_*).
 *
 * Main-only module. Not exposed over IPC/preload/renderer.
 */

import fs from 'node:fs'

import { ChatDbAggregateService } from '@main/services/chatDb/ChatDbAggregateService'
import {
  FTS_SMOKE_TOKEN,
  MESSAGE_BLOCKS_FTS_TABLE,
  MESSAGE_BLOCKS_NORMALIZED_DELETE_TRIGGER,
  MESSAGE_BLOCKS_NORMALIZED_INSERT_TRIGGER,
  MESSAGE_BLOCKS_NORMALIZED_MESSAGE_ID_INDEX,
  MESSAGE_BLOCKS_NORMALIZED_TABLE,
  MESSAGE_BLOCKS_NORMALIZED_UPDATE_TRIGGER,
  MIGRATIONS
} from '@main/services/chatDb/migration'
import { createRepositories } from '@main/services/chatDb/repository/factory'
import * as schema from '@main/services/chatDb/schema'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import { NAVIGATION_PROJECTION_STATE_KEY } from '../navigationProjection'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The six readonly validation gates, in execution order. */
export type ReadonlyChatDbValidationGate =
  | 'open'
  | 'integrity'
  | 'foreign-keys'
  | 'migration'
  | 'search-projection'
  | 'sample-reads'

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
 *
 * One exact operational exception (LOCK-RV1/RV2): the versioned one-shot
 * navigation projection key (`NAVIGATION_PROJECTION_STATE_KEY`) is written
 * into the candidate `migration_state` before seal and must remain in the
 * promoted live DB until the renderer durable apply+ack, so the readonly
 * gate permits EXACTLY that key (never a prefix/pattern) to survive the
 * MIGRATIONS set comparison. The value is never inspected here — payload
 * validation belongs to the later durable apply path (LOCK-PROD-6). Every
 * other unexpected key still rejects the file as ahead of schema.
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
    // LOCK-RV1: tolerate the single exact pending navigation projection
    // operational key. Exact-match only — no prefix/pattern allowlist.
    applied.delete(NAVIGATION_PROJECTION_STATE_KEY)
  }
  if (applied.size > 0) {
    return { gate: 'migration', safeCode: 'MIGRATION_KEY_UNKNOWN' }
  }
  return null
}

/**
 * LOCK-SP-5: lightweight derived search-projection gate shared by the
 * replacement/snapshot promotion paths. Bounded cost (six fixed statements)
 * and NOT the full candidate content recompute — that stays
 * CandidateVerifier-only (LOCK-SP-2/3). Checks, in order:
 *
 *   1. required objects: the derived normalized table, its message_id
 *      index, the FTS5 table, and the three sync triggers must all exist in
 *      sqlite_master with the exact expected type (names from the migration
 *      constants — single source of truth, LOCK-FTS-2);
 *   2. count parity: canonical predicate (`type='main_text'` + non-null
 *      content) vs `message_blocks_normalized` vs `message_blocks_fts`;
 *   3. messageId parity: one indexed LEFT JOIN counting normalized rows
 *      whose block_id has no canonical block or whose message_id differs;
 *   4. fixed synthetic MATCH smoke (LOCK-SP-4): `MATCH ?` must execute.
 *
 * Safe sub-codes are fixed constants (optionally with the missing object
 * name appended) — never content, paths, or SQL. Rejects
 * migration_state-applied-with-missing-objects.
 */
function checkSearchProjection(sqlite: Database.Database): ReadonlyChatDbValidationFailure | null {
  const required: ReadonlyArray<{ name: string; type: 'table' | 'index' | 'trigger' }> = [
    { name: MESSAGE_BLOCKS_NORMALIZED_TABLE, type: 'table' },
    { name: MESSAGE_BLOCKS_NORMALIZED_MESSAGE_ID_INDEX, type: 'index' },
    { name: MESSAGE_BLOCKS_FTS_TABLE, type: 'table' },
    { name: MESSAGE_BLOCKS_NORMALIZED_INSERT_TRIGGER, type: 'trigger' },
    { name: MESSAGE_BLOCKS_NORMALIZED_UPDATE_TRIGGER, type: 'trigger' },
    { name: MESSAGE_BLOCKS_NORMALIZED_DELETE_TRIGGER, type: 'trigger' }
  ]
  const placeholders = required.map(() => '?').join(',')
  const master = new Map(
    (
      sqlite
        .prepare(`SELECT name, type FROM sqlite_master WHERE name IN (${placeholders})`)
        .all(...required.map((o) => o.name)) as Array<{ name: string; type: string }>
    ).map((r) => [r.name, r.type])
  )
  for (const obj of required) {
    if (master.get(obj.name) !== obj.type) {
      // Fixed code + fixed object name only (LOCK-SP-3/LOCK-PRIV).
      return { gate: 'search-projection', safeCode: `OBJECT_MISSING_${obj.name.toUpperCase()}` }
    }
  }

  const countOf = (sql: string): number => {
    const row = sqlite.prepare(sql).get() as { n: unknown }
    return typeof row.n === 'number' ? row.n : -1
  }
  const canonicalCount = countOf(
    `SELECT COUNT(*) AS n FROM message_blocks WHERE type = 'main_text' AND content IS NOT NULL`
  )
  const normalizedCount = countOf(`SELECT COUNT(*) AS n FROM message_blocks_normalized`)
  const ftsCount = countOf(`SELECT COUNT(*) AS n FROM message_blocks_fts`)
  if (canonicalCount !== normalizedCount || canonicalCount !== ftsCount) {
    return { gate: 'search-projection', safeCode: 'COUNT_MISMATCH' }
  }

  // messageId parity via ONE indexed equi-join (bounded, non-quadratic).
  const badMessageIds = countOf(
    `SELECT COUNT(*) AS n FROM message_blocks_normalized n
     LEFT JOIN message_blocks mb ON mb.id = n.block_id
     WHERE mb.id IS NULL OR n.message_id != mb.message_id`
  )
  if (badMessageIds > 0) {
    return { gate: 'search-projection', safeCode: 'MESSAGE_ID_MISMATCH' }
  }

  // Fixed synthetic MATCH smoke (LOCK-SP-4) — proves MATCH executes; the
  // token is not required to match source content.
  try {
    const rows = sqlite
      .prepare(`SELECT block_id FROM ${MESSAGE_BLOCKS_FTS_TABLE} WHERE ${MESSAGE_BLOCKS_FTS_TABLE} MATCH ?`)
      .all(FTS_SMOKE_TOKEN)
    if (!Array.isArray(rows)) {
      return { gate: 'search-projection', safeCode: 'MATCH_EXECUTION_FAILED' }
    }
  } catch {
    return { gate: 'search-projection', safeCode: 'MATCH_EXECUTION_FAILED' }
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

    try {
      // LOCK-SP-5: derived search-projection gate (lightweight, bounded).
      const searchProjectionFailure = checkSearchProjection(sqlite)
      if (searchProjectionFailure !== null) return searchProjectionFailure
    } catch (error) {
      return { gate: 'search-projection', safeCode: safeErrorCode(error) }
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
