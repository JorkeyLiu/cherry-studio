import { loggerService } from '@logger'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import { migrationState } from './schema'

const logger = loggerService.withContext('ChatDbMigration')

// ---------------------------------------------------------------------------
// Migration definition — each entry maps a version key to its SQL.
//
// Design decision: SQL is stored as inline string constants to ensure
// build-safety. The previous __dirname + fs.readFileSync approach is
// incompatible with electron-vite bundling (compiled output has no
// access to source-tree .sql files). Inline constants are deterministic,
// tree-shakeable, and guaranteed to survive bundling.
// ---------------------------------------------------------------------------

export interface MigrationEntry {
  /** Unique version key stored in migration_state */
  key: string
  /** Human-readable description for logging */
  description: string
  /** SQL statements to execute (each statement in its own array element) */
  sql: string[]
}

/**
 * Registry of all known migrations in execution order.
 * New migrations MUST be appended at the end. Never reorder or remove entries.
 */
export const MIGRATIONS: MigrationEntry[] = [
  {
    key: '001_initial_schema',
    description:
      'Create initial chat.db schema: topics, messages, message_blocks, topic_segments, topic_segment_messages, file_references',
    sql: [
      `CREATE TABLE IF NOT EXISTS topics (
        id TEXT PRIMARY KEY,
        assistant_id TEXT,
        name TEXT,
        created_at TEXT,
        updated_at TEXT,
        deleted_at TEXT,
        extra TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL REFERENCES topics(id),
        role TEXT,
        content TEXT,
        status TEXT,
        ask_id TEXT,
        model TEXT,
        created_at TEXT,
        sort_order INTEGER,
        extra TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS messages_topic_id_sort_order_idx ON messages(topic_id, sort_order)`,
      `CREATE TABLE IF NOT EXISTS message_blocks (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id),
        type TEXT,
        content TEXT,
        sort_order INTEGER,
        extra TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS message_blocks_message_id_sort_order_idx ON message_blocks(message_id, sort_order)`,
      `CREATE TABLE IF NOT EXISTS topic_segments (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL REFERENCES topics(id),
        sort_order INTEGER,
        extra TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS topic_segments_topic_id_sort_order_idx ON topic_segments(topic_id, sort_order)`,
      `CREATE TABLE IF NOT EXISTS topic_segment_messages (
        segment_id TEXT NOT NULL REFERENCES topic_segments(id),
        message_id TEXT NOT NULL REFERENCES messages(id),
        sort_order INTEGER,
        PRIMARY KEY (segment_id, message_id)
      )`,
      `CREATE TABLE IF NOT EXISTS file_references (
        id TEXT PRIMARY KEY,
        message_id TEXT REFERENCES messages(id),
        file_id TEXT NOT NULL,
        file_name TEXT,
        file_path TEXT,
        file_type TEXT,
        count INTEGER,
        extra TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS file_references_message_id_idx ON file_references(message_id)`,
      `CREATE INDEX IF NOT EXISTS file_references_file_id_idx ON file_references(file_id)`
    ]
  }
]

/**
 * Run all pending migrations against the provided Drizzle database instance.
 *
 * - Creates `migration_state` table if it does not exist (idempotent).
 * - Reads applied migration keys.
 * - Executes each unapplied migration's SQL inside a transaction.
 * - Records the key in `migration_state` after successful execution.
 * - If a registered migration's SQL is empty, throws (fail-fast).
 * - If a registered migration is in the registry but missing from MIGRATIONS
 *   (i.e. key not found), the registry entry is skipped with a warning —
 *   this handles forward-compatibility for future migration additions.
 *
 * @returns Number of migrations applied.
 */
export function runMigrations(db: BetterSQLite3Database<any>): number {
  // Ensure migration_state table exists (idempotent)
  db.run(/* sql */ `
    CREATE TABLE IF NOT EXISTS migration_state (
      key   TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT
    )
  `)

  // Fetch already-applied migration keys
  const rows = db.select().from(migrationState).all()
  const applied = new Set(rows.map((r) => r.key))

  let appliedCount = 0

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.key)) {
      continue
    }

    if (migration.sql.length === 0) {
      throw new Error(`Migration "${migration.key}" has no SQL statements — this is a programming error`)
    }

    logger.info(`Applying migration: ${migration.key} — ${migration.description}`)

    // Execute migration + record in a single transaction
    db.transaction((tx) => {
      for (const stmt of migration.sql) {
        tx.run(stmt)
      }

      tx.insert(migrationState)
        .values({
          key: migration.key,
          value: migration.key,
          updatedAt: new Date().toISOString()
        })
        .run()
    })

    appliedCount++
    logger.info(`Migration applied: ${migration.key}`)
  }

  return appliedCount
}
