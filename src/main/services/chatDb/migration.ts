import { loggerService } from '@logger'
import { normalizeSearchText } from '@shared/searchTextNormalization'
import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import { migrationState } from './schema'

const logger = loggerService.withContext('ChatDbMigration')

// ---------------------------------------------------------------------------
// Shared scalar function registration — LOCK-5126
//
// Every writable connection that may mutate `message_blocks` must have
// `chatdb_normalize()` registered before any trigger can fire. This
// helper is the single source of truth for registration. It is safe to
// call multiple times on the same handle (re-registration overwrites).
//
// Exported for use by callers that open standalone writable connections
// (e.g. test helpers, backup/restore) without duplicating the
// normalization lambda.
// ---------------------------------------------------------------------------

/**
 * Register the `chatdb_normalize()` scalar function on a raw better-sqlite3
 * connection. Required before migration 003 and by any writable connection
 * whose triggers may call the function. Idempotent — safe to call multiple
 * times on the same handle.
 *
 * @param rawSqlite  Raw better-sqlite3 Database handle.
 */
export function registerChatDbNormalize(rawSqlite: Database.Database): void {
  if (typeof rawSqlite.function === 'function') {
    rawSqlite.function('chatdb_normalize', (content: string | null) => {
      if (content === null || content === undefined) return ''
      return normalizeSearchText(String(content))
    })
  }
}

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

// ===========================================================================
// Derived search projection — single source of truth (LOCK-FTS-2)
// ===========================================================================
//
// The migration 003 entry below is assembled from these named constants. The
// candidate-only deferred rebuild helper (chatDbImport/ftsProjection.ts)
// executes DERIVED_PROJECTION_DROP_SQL / DERIVED_PROJECTION_REBUILD_SQL from
// the SAME constants — no duplicated strings, no reliance on the migration
// array index. Migration 003 applied schema must remain byte/semantic
// equivalent (LOCK-FTS-6).
//
// Object names are exported for object-inventory tests.
// ===========================================================================

/** Normalized content projection table created by migration 003. */
export const MESSAGE_BLOCKS_NORMALIZED_TABLE = 'message_blocks_normalized'

/** FTS5 trigram virtual table over normalized content created by migration 003. */
export const MESSAGE_BLOCKS_FTS_TABLE = 'message_blocks_fts'

/** Index on message_blocks_normalized(message_id) created by migration 003. */
export const MESSAGE_BLOCKS_NORMALIZED_MESSAGE_ID_INDEX = 'message_blocks_normalized_message_id_idx'

/** INSERT sync trigger created by migration 003. */
export const MESSAGE_BLOCKS_NORMALIZED_INSERT_TRIGGER = 'message_blocks_normalized_insert'

/** UPDATE sync trigger created by migration 003. */
export const MESSAGE_BLOCKS_NORMALIZED_UPDATE_TRIGGER = 'message_blocks_normalized_update'

/** DELETE sync trigger created by migration 003. */
export const MESSAGE_BLOCKS_NORMALIZED_DELETE_TRIGGER = 'message_blocks_normalized_delete'

/**
 * Fixed synthetic FTS MATCH smoke token (LOCK-SP-4). The candidate verifier
 * and the readonly promotion gate both execute `MATCH ?` with this fixed
 * token to prove the FTS5 virtual table is functionally queryable. It is a
 * single lowercase alphanumeric word (trigram-tokenizer safe) that is NOT
 * expected to match source content — a MATCH execution that does not throw
 * proves the operator runs; completeness is proven by the structural/count/
 * parity checks. Single source of truth so the verifier and the readonly
 * gate cannot drift.
 */
export const FTS_SMOKE_TOKEN = 'chatdbsmoketoken'

/**
 * CREATE TABLE for the normalized projection (LOCK-FTS-2 single source).
 * BYTE-IDENTICAL to the original migration 003 statement (LOCK-FTS-6).
 */
export const CREATE_MESSAGE_BLOCKS_NORMALIZED_SQL = `CREATE TABLE IF NOT EXISTS message_blocks_normalized (
        block_id TEXT PRIMARY KEY REFERENCES message_blocks(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        normalized_content TEXT NOT NULL
      )`

/**
 * CREATE INDEX on message_id for joins (LOCK-FTS-2 single source).
 * BYTE-IDENTICAL to the original migration 003 statement (LOCK-FTS-6).
 */
export const CREATE_MESSAGE_BLOCKS_NORMALIZED_MESSAGE_ID_INDEX_SQL = `CREATE INDEX IF NOT EXISTS message_blocks_normalized_message_id_idx ON message_blocks_normalized(message_id)`

/**
 * CREATE VIRTUAL TABLE for the FTS5 trigram index (LOCK-FTS-2 single source).
 * BYTE-IDENTICAL to the original migration 003 statement (LOCK-FTS-6).
 */
export const CREATE_MESSAGE_BLOCKS_FTS_SQL = `CREATE VIRTUAL TABLE IF NOT EXISTS message_blocks_fts USING fts5(
        block_id UNINDEXED,
        normalized_content,
        tokenize='trigram'
      )`

/**
 * Backfill of message_blocks_normalized from canonical MAIN_TEXT rows with
 * non-null content (LOCK-FTS-2 single source). BYTE-IDENTICAL to the
 * original migration 003 statement (LOCK-FTS-6).
 */
export const BACKFILL_MESSAGE_BLOCKS_NORMALIZED_SQL = `INSERT INTO message_blocks_normalized (block_id, message_id, normalized_content)
       SELECT
         mb.id,
         mb.message_id,
         chatdb_normalize(mb.content)
       FROM message_blocks mb
       WHERE mb.type = 'main_text' AND mb.content IS NOT NULL`

/**
 * Backfill of message_blocks_fts from canonical MAIN_TEXT rows with non-null
 * content (LOCK-FTS-2 single source). BYTE-IDENTICAL to the original
 * migration 003 statement (LOCK-FTS-6).
 */
export const BACKFILL_MESSAGE_BLOCKS_FTS_SQL = `INSERT INTO message_blocks_fts (block_id, normalized_content)
       SELECT
         mb.id,
         chatdb_normalize(mb.content)
       FROM message_blocks mb
       WHERE mb.type = 'main_text' AND mb.content IS NOT NULL`

/**
 * INSERT sync trigger (LOCK-FTS-6: post-rebuild behavior must match a
 * trigger-maintained DB). BYTE-IDENTICAL to the original migration 003
 * statement (LOCK-FTS-2 single source).
 */
export const CREATE_MESSAGE_BLOCKS_NORMALIZED_INSERT_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS message_blocks_normalized_insert
       AFTER INSERT ON message_blocks
       BEGIN
         DELETE FROM message_blocks_normalized WHERE block_id = NEW.id;
         DELETE FROM message_blocks_fts WHERE block_id = NEW.id;
         INSERT INTO message_blocks_normalized (block_id, message_id, normalized_content)
         SELECT NEW.id, NEW.message_id, chatdb_normalize(NEW.content)
         WHERE NEW.type = 'main_text' AND NEW.content IS NOT NULL;
         INSERT INTO message_blocks_fts (block_id, normalized_content)
         SELECT NEW.id, chatdb_normalize(NEW.content)
         WHERE NEW.type = 'main_text' AND NEW.content IS NOT NULL;
       END`

/**
 * UPDATE sync trigger for content/type/message_id (LOCK-FTS-6). BYTE-IDENTICAL
 * to the original migration 003 statement (LOCK-FTS-2 single source).
 */
export const CREATE_MESSAGE_BLOCKS_NORMALIZED_UPDATE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS message_blocks_normalized_update
       AFTER UPDATE OF content, type, message_id ON message_blocks
       BEGIN
         DELETE FROM message_blocks_normalized WHERE block_id = NEW.id;
         DELETE FROM message_blocks_fts WHERE block_id = NEW.id;
         INSERT INTO message_blocks_normalized (block_id, message_id, normalized_content)
         SELECT NEW.id, NEW.message_id, chatdb_normalize(NEW.content)
         WHERE NEW.type = 'main_text' AND NEW.content IS NOT NULL;
         INSERT INTO message_blocks_fts (block_id, normalized_content)
         SELECT NEW.id, chatdb_normalize(NEW.content)
         WHERE NEW.type = 'main_text' AND NEW.content IS NOT NULL;
       END`

/**
 * DELETE sync trigger (LOCK-FTS-6). BYTE-IDENTICAL to the original migration
 * 003 statement (LOCK-FTS-2 single source).
 */
export const CREATE_MESSAGE_BLOCKS_NORMALIZED_DELETE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS message_blocks_normalized_delete
       AFTER DELETE ON message_blocks
       BEGIN
         DELETE FROM message_blocks_normalized WHERE block_id = OLD.id;
         DELETE FROM message_blocks_fts WHERE block_id = OLD.id;
       END`

/**
 * Derived-object drops in the mandatory safe order (LOCK-FTS-3/4): triggers
 * first (they reference the tables), then the FTS virtual table, then the
 * normalized table (its message_id index auto-drops with the table).
 * Candidate-only — migration 003 never drops.
 */
export const DERIVED_PROJECTION_DROP_SQL: readonly string[] = [
  `DROP TRIGGER IF EXISTS ${MESSAGE_BLOCKS_NORMALIZED_INSERT_TRIGGER}`,
  `DROP TRIGGER IF EXISTS ${MESSAGE_BLOCKS_NORMALIZED_UPDATE_TRIGGER}`,
  `DROP TRIGGER IF EXISTS ${MESSAGE_BLOCKS_NORMALIZED_DELETE_TRIGGER}`,
  `DROP TABLE IF EXISTS ${MESSAGE_BLOCKS_FTS_TABLE}`,
  `DROP TABLE IF EXISTS ${MESSAGE_BLOCKS_NORMALIZED_TABLE}`
]

/**
 * Complete candidate rebuild sequence (LOCK-FTS-4): drop-if-exists in safe
 * order → recreate normalized table/index/FTS → backfill normalized and FTS
 * from canonical MAIN_TEXT/content-not-null rows → recreate the three sync
 * triggers. Executed atomically and exactly once by the candidate-local
 * helper (chatDbImport/ftsProjection.ts) AFTER the data plane finalizes and
 * BEFORE any seal path. This is the single source of truth for the rebuild —
 * identical bytes to a trigger-maintained (migration-003-applied) schema.
 */
export const DERIVED_PROJECTION_REBUILD_SQL: readonly string[] = [
  ...DERIVED_PROJECTION_DROP_SQL,
  CREATE_MESSAGE_BLOCKS_NORMALIZED_SQL,
  CREATE_MESSAGE_BLOCKS_NORMALIZED_MESSAGE_ID_INDEX_SQL,
  CREATE_MESSAGE_BLOCKS_FTS_SQL,
  BACKFILL_MESSAGE_BLOCKS_NORMALIZED_SQL,
  BACKFILL_MESSAGE_BLOCKS_FTS_SQL,
  CREATE_MESSAGE_BLOCKS_NORMALIZED_INSERT_TRIGGER_SQL,
  CREATE_MESSAGE_BLOCKS_NORMALIZED_UPDATE_TRIGGER_SQL,
  CREATE_MESSAGE_BLOCKS_NORMALIZED_DELETE_TRIGGER_SQL
]

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
  },

  // =========================================================================
  // 002 — Corrective schema migration (append-only, never edit 001)
  // =========================================================================
  //
  // Changes:
  // - messages: add assistant_id, model_id, updated_at; sort_order NOT NULL DEFAULT 0; CASCADE on topic_id FK
  // - message_blocks: add status, created_at, updated_at; sort_order NOT NULL DEFAULT 0; CASCADE on message_id FK
  // - topic_segments: add name, created_at, updated_at; sort_order NOT NULL DEFAULT 0; CASCADE on topic_id FK
  // - topic_segment_messages: sort_order NOT NULL DEFAULT 0; CASCADE on both FKs; add indexes
  // - file_references: replace message_id with block_id (NOT NULL), CASCADE, UNIQUE(block_id, file_id)
  // - indexes: topics trash, messages assistant_id, segment order, message cleanup, file block/file
  //
  // Migration policy for file_references block_id derivation:
  //   Existing001 file_references link to messages, not blocks. We derive
  //   block_id by joining message_blocks on message_id and matching the
  //   file block's extra JSON file.id to the file_reference's file_id.
  //   Rows where no matching block can be found are dropped (orphaned
  //   references). This is safe because001 has not been released in
  //   production; any existing data is test/development data.
  //
  // Technique: safe SQLite table-rebuild (CREATE new → INSERT SELECT →
  // DROP old → RENAME new). PRAGMA defer_foreign_keys defers FK checks
  // until COMMIT so DROP TABLE succeeds mid-migration.
  // =========================================================================
  {
    key: '002_corrective_schema',
    description: 'Corrective schema: explicit columns, CASCADE FKs, block_id file references, indexes',
    sql: [
      // NOTE: FK enforcement is temporarily disabled at the raw sqlite level
      // by runMigrations() before executing this migration. This is necessary
      // because Drizzle uses SAVEPOINT internally, making PRAGMA defer_foreign_keys
      // ineffective.

      // ---- messages rebuild ----
      `CREATE TABLE "messages_new" (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        role TEXT,
        content TEXT,
        status TEXT,
        ask_id TEXT,
        model TEXT,
        model_id TEXT,
        assistant_id TEXT,
        created_at TEXT,
        updated_at TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        extra TEXT
      )`,
      `INSERT INTO "messages_new"
        (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra)
       SELECT
        id, topic_id, role, content, status, ask_id, model,
        json_extract(extra, '$.modelId'),
        json_extract(extra, '$.assistantId'),
        created_at,
        COALESCE(json_extract(extra, '$.updatedAt'), created_at),
        COALESCE(sort_order, 0),
        extra
       FROM "messages"`,
      'DROP TABLE "messages"',
      'ALTER TABLE "messages_new" RENAME TO "messages"',

      // ---- message_blocks rebuild ----
      `CREATE TABLE "message_blocks_new" (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        type TEXT,
        content TEXT,
        status TEXT,
        created_at TEXT,
        updated_at TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        extra TEXT
      )`,
      `INSERT INTO "message_blocks_new"
        (id, message_id, type, content, status, created_at, updated_at, sort_order, extra)
       SELECT
        id, message_id, type, content,
        json_extract(extra, '$.status'),
        json_extract(extra, '$.createdAt'),
        json_extract(extra, '$.updatedAt'),
        COALESCE(sort_order, 0),
        extra
       FROM "message_blocks"`,
      'DROP TABLE "message_blocks"',
      'ALTER TABLE "message_blocks_new" RENAME TO "message_blocks"',

      // ---- topic_segments rebuild ----
      `CREATE TABLE "topic_segments_new" (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        name TEXT,
        created_at TEXT,
        updated_at TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        extra TEXT
      )`,
      `INSERT INTO "topic_segments_new"
        (id, topic_id, name, created_at, updated_at, sort_order, extra)
       SELECT
        id, topic_id,
        json_extract(extra, '$.name'),
        json_extract(extra, '$.createdAt'),
        json_extract(extra, '$.updatedAt'),
        COALESCE(sort_order, 0),
        extra
       FROM "topic_segments"`,
      'DROP TABLE "topic_segments"',
      'ALTER TABLE "topic_segments_new" RENAME TO "topic_segments"',

      // ---- topic_segment_messages rebuild ----
      `CREATE TABLE "topic_segment_messages_new" (
        segment_id TEXT NOT NULL REFERENCES topic_segments(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (segment_id, message_id)
      )`,
      `INSERT INTO "topic_segment_messages_new" (segment_id, message_id, sort_order)
       SELECT segment_id, message_id, COALESCE(sort_order, 0)
       FROM "topic_segment_messages"`,
      'DROP TABLE "topic_segment_messages"',
      'ALTER TABLE "topic_segment_messages_new" RENAME TO "topic_segment_messages"',

      // ---- file_references rebuild (message_id → block_id) ----
      //
      // Two-phase deterministic resolution:
      //   Phase 1 — Resolve each001 reference to exactly one eligible
      //     file block using ROW_NUMBER() PARTITION BY fr.id
      //     ORDER BY mb.sort_order ASC, mb.id ASC. This guarantees
      //     a single, deterministic block per reference even when
      //     multiple file blocks in the same message match the file_id.
      //   Phase 2 — Collapse duplicate references by the resulting
      //     (block_id, file_id) using lowest reference id (deterministic
      //     winner). The winner's complete metadata is preserved.
      //
      // Orphan rows (no matching block) are dropped by the INNER JOIN.
      // The result is at most one row per (block_id, file_id) pair.
      `CREATE TABLE "file_references_new" (
        id TEXT PRIMARY KEY,
        block_id TEXT NOT NULL REFERENCES message_blocks(id) ON DELETE CASCADE,
        file_id TEXT NOT NULL,
        file_name TEXT,
        file_path TEXT,
        file_type TEXT,
        count INTEGER,
        extra TEXT
      )`,
      `INSERT INTO "file_references_new"
        (id, block_id, file_id, file_name, file_path, file_type, count, extra)
       WITH resolved_refs AS (
         SELECT
           fr.id AS ref_id,
           mb.block_id,
           fr.file_id,
           fr.file_name,
           fr.file_path,
           fr.file_type,
           fr.count,
           fr.extra,
           ROW_NUMBER() OVER (
             PARTITION BY fr.id
             ORDER BY mb.sort_order ASC, mb.block_id ASC
           ) AS block_rn
         FROM "file_references" fr
         INNER JOIN (
           SELECT
             message_id,
             json_extract(extra, '$.file.id') AS derived_file_id,
             id AS block_id,
             sort_order
           FROM "message_blocks"
           WHERE type = 'file'
         ) mb
           ON mb.message_id = fr.message_id
           AND mb.derived_file_id = fr.file_id
       ),
       deduplicated AS (
         SELECT
           ref_id,
           block_id,
           file_id,
           file_name,
           file_path,
           file_type,
           count,
           extra,
           ROW_NUMBER() OVER (
             PARTITION BY block_id, file_id
             ORDER BY ref_id ASC
           ) AS rn
         FROM resolved_refs
         WHERE block_rn = 1
       )
       SELECT ref_id, block_id, file_id, file_name, file_path, file_type, count, extra
       FROM deduplicated
       WHERE rn = 1`,
      'DROP TABLE "file_references"',
      'ALTER TABLE "file_references_new" RENAME TO "file_references"',

      // ---- indexes ----
      // topics: trash filtering
      'CREATE INDEX IF NOT EXISTS topics_deleted_at_idx ON topics(deleted_at)',

      // messages: topic sort order (recreated after table rebuild)
      'CREATE INDEX IF NOT EXISTS messages_topic_id_sort_order_idx ON messages(topic_id, sort_order)',
      // messages: assistant queries
      'CREATE INDEX IF NOT EXISTS messages_assistant_id_idx ON messages(assistant_id)',

      // message_blocks: message sort order (recreated after table rebuild)
      'CREATE INDEX IF NOT EXISTS message_blocks_message_id_sort_order_idx ON message_blocks(message_id, sort_order)',

      // topic_segments: topic sort order (recreated after table rebuild)
      'CREATE INDEX IF NOT EXISTS topic_segments_topic_id_sort_order_idx ON topic_segments(topic_id, sort_order)',

      // topic_segment_messages: segment order + message cleanup
      'CREATE INDEX IF NOT EXISTS topic_segment_messages_segment_id_sort_order_idx ON topic_segment_messages(segment_id, sort_order)',
      'CREATE INDEX IF NOT EXISTS topic_segment_messages_message_id_idx ON topic_segment_messages(message_id)',

      // file_references: block and file lookups, uniqueness via named index
      'CREATE INDEX IF NOT EXISTS file_references_block_id_idx ON file_references(block_id)',
      'CREATE INDEX IF NOT EXISTS file_references_file_id_idx ON file_references(file_id)',
      'CREATE UNIQUE INDEX IF NOT EXISTS file_references_block_id_file_id_uniq ON file_references(block_id, file_id)'
    ]
  },

  // =========================================================================
  // 003 — FTS5 normalized search projection (Phase 5.1B-2)
  // =========================================================================
  //
  // Adds an append-only normalized content projection for FTS5 trigram search.
  //
  // Tables:
  // - message_blocks_normalized: stores normalized (markdown-stripped, CRLF→LF)
  //   content for each MAIN_TEXT block. Contains block_id, message_id, and
  //   normalized_content columns.
  // - message_blocks_fts: FTS5 trigram virtual table over normalized_content.
  //
  // Triggers:
  // - message_blocks_normalized_insert: fires on INSERT into message_blocks.
  //   For MAIN_TEXT blocks, calls chatdb_normalize() to populate normalized_content.
  // - message_blocks_normalized_update: fires on UPDATE of content/type in message_blocks.
  //   For MAIN_TEXT blocks, calls chatdb_normalize() to refresh normalized_content.
  //   For non-MAIN_TEXT or type transitions, deletes the projection row.
  // - message_blocks_normalized_delete: fires on DELETE from message_blocks.
  //   Removes the projection row.
  //
  // The chatdb_normalize() scalar function must be registered on the raw
  // better-sqlite3 connection before this migration runs. It reproduces
  // normalizeText(stripMarkdownFormatting(content)).
  //
  // LOCK-5125: FTS is a candidate accelerator, not semantic authority.
  // Every result must pass the shared exact regex matcher.
  //
  // LOCK-FTS-2: the derived-object DDL/backfill below is defined ONCE as
  // named exported constants (DERIVED_PROJECTION_*) and shared verbatim by
  // this migration and the candidate deferred-rebuild helper
  // (chatDbImport/ftsProjection.ts). Never duplicate these strings elsewhere
  // and never index MIGRATIONS to reach them — migration 003 applied schema
  // must remain byte/semantic equivalent (LOCK-FTS-6).
  // =========================================================================

  {
    key: '003_fts5_normalized_search',
    description: 'FTS5 normalized search projection: block_normalized table, trigram FTS, and synchronization triggers',
    sql: [
      CREATE_MESSAGE_BLOCKS_NORMALIZED_SQL,
      CREATE_MESSAGE_BLOCKS_NORMALIZED_MESSAGE_ID_INDEX_SQL,
      CREATE_MESSAGE_BLOCKS_FTS_SQL,
      BACKFILL_MESSAGE_BLOCKS_NORMALIZED_SQL,
      BACKFILL_MESSAGE_BLOCKS_FTS_SQL,
      CREATE_MESSAGE_BLOCKS_NORMALIZED_INSERT_TRIGGER_SQL,
      CREATE_MESSAGE_BLOCKS_NORMALIZED_UPDATE_TRIGGER_SQL,
      CREATE_MESSAGE_BLOCKS_NORMALIZED_DELETE_TRIGGER_SQL
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
 * @param db         Drizzle database instance (for schema-aware queries).
 * @param rawSqlite  Raw better-sqlite3 Database handle. Required for direct
 *                   PRAGMA control (foreign_keys). Fail-fast if unavailable.
 * @returns Number of migrations applied.
 */
export function runMigrations(db: BetterSQLite3Database<any>, rawSqlite: Database.Database): number {
  if (!rawSqlite) {
    throw new Error(
      'runMigrations requires a raw better-sqlite3 Database handle for FK control. ' +
        'Pass the sqlite instance as the second argument.'
    )
  }
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

  // Register chatdb_normalize scalar function for FTS5 triggers.
  // Uses the shared helper (LOCK-5126) — single source of truth.
  registerChatDbNormalize(rawSqlite)

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.key)) {
      continue
    }

    if (migration.sql.length === 0) {
      throw new Error(`Migration "${migration.key}" has no SQL statements — this is a programming error`)
    }

    logger.info(`Applying migration: ${migration.key} — ${migration.description}`)

    // Table-rebuild migrations require FK enforcement to be disabled.
    // Drizzle uses SAVEPOINT internally for db.transaction(), making
    // PRAGMA defer_foreign_keys ineffective inside the transaction.
    // We disable FK enforcement at the raw better-sqlite3 handle level
    // for the duration of the migration and restore it afterwards.
    const hadFkOn = rawSqlite.pragma('foreign_keys', { simple: true }) === 1

    if (hadFkOn) {
      rawSqlite.pragma('foreign_keys = OFF')
    }

    try {
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
    } finally {
      // Re-enable FK enforcement after migration, regardless of success/failure
      if (hadFkOn) {
        rawSqlite.pragma('foreign_keys = ON')
      }
    }

    appliedCount++
    logger.info(`Migration applied: ${migration.key}`)
  }

  return appliedCount
}
