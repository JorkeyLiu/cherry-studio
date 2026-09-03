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
  /**
   * Optional preflight hook executed INSIDE the migration transaction, BEFORE
   * any of `sql` runs (and therefore before any DDL). It receives the raw
   * better-sqlite3 handle, which shares the open transaction. A throw rolls
   * the whole migration back and leaves the migration unrecorded (fail
   * closed). Used by migration 004 to verify FTS/normalized rowid parity
   * before touching the derived projection (LOCK-001/003).
   */
  preflight?: (rawSqlite: Database.Database) => void
}

// ===========================================================================
// Derived search projection — single source of truth (LOCK-FTS-2)
// ===========================================================================
//
// Migration 004 (`004_fts_rowid_identity`) is the CURRENT schema for the
// derived projection. Its DDL/backfill/trigger statements are assembled from
// the named constants below. The candidate-only deferred rebuild helper
// (chatDbImport/ftsProjection.ts) executes DERIVED_PROJECTION_DROP_SQL /
// DERIVED_PROJECTION_REBUILD_SQL from the SAME constants — no duplicated
// strings, no reliance on the migration array index. A migration-004-applied
// schema must remain byte/semantic equivalent to the candidate rebuild
// (LOCK-FTS-6, migration-004 generation).
//
// Migration 003 was frozen byte-identically into the MIGRATION_003_* legacy
// constants below: 003 created the ORIGINAL schema (block_id TEXT PRIMARY
// KEY, FTS rows addressed by UNINDEXED block_id). 004 rebuilds that schema —
// normalized rows gain a stable integer rowid (INTEGER PRIMARY KEY
// AUTOINCREMENT) that is reused as the FTS5 rowid, so INSERT/UPDATE/DELETE
// address exactly one FTS document via indexed rowid instead of a full
// virtual-table scan of UNINDEXED block_id (LOCK-003).
//
// Object names are exported for object-inventory tests.
// ===========================================================================

/** Normalized content projection table created by migration 004 (current schema). */
export const MESSAGE_BLOCKS_NORMALIZED_TABLE = 'message_blocks_normalized'

/** FTS5 trigram virtual table over normalized content created by migration 004 (current schema). */
export const MESSAGE_BLOCKS_FTS_TABLE = 'message_blocks_fts'

/** Index on message_blocks_normalized(message_id) created by migration 004 (current schema). */
export const MESSAGE_BLOCKS_NORMALIZED_MESSAGE_ID_INDEX = 'message_blocks_normalized_message_id_idx'

/** INSERT sync trigger created by migration 004 (current schema). */
export const MESSAGE_BLOCKS_NORMALIZED_INSERT_TRIGGER = 'message_blocks_normalized_insert'

/** UPDATE sync trigger created by migration 004 (current schema). */
export const MESSAGE_BLOCKS_NORMALIZED_UPDATE_TRIGGER = 'message_blocks_normalized_update'

/** DELETE sync trigger created by migration 004 (current schema). */
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

// ---------------------------------------------------------------------------
// FROZEN migration 003 statements (historical schema — never edit)
//
// Byte-identical copies of the original migration 003 DDL/backfill/trigger
// strings. Migration 003 MUST keep creating this original schema for
// existing databases that stopped at 003; migration 004 then upgrades it.
// These constants are referenced ONLY by the 003 entry — the current schema
// constants below belong to migration 004 / the candidate rebuild.
// ---------------------------------------------------------------------------

/** Migration 003 CREATE TABLE (block_id TEXT PRIMARY KEY — original schema). */
export const MIGRATION_003_CREATE_MESSAGE_BLOCKS_NORMALIZED_SQL = `CREATE TABLE IF NOT EXISTS message_blocks_normalized (
        block_id TEXT PRIMARY KEY REFERENCES message_blocks(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        normalized_content TEXT NOT NULL
      )`

/** Migration 003 CREATE INDEX. */
export const MIGRATION_003_CREATE_MESSAGE_BLOCKS_NORMALIZED_MESSAGE_ID_INDEX_SQL = `CREATE INDEX IF NOT EXISTS message_blocks_normalized_message_id_idx ON message_blocks_normalized(message_id)`

/** Migration 003 CREATE VIRTUAL TABLE (block_id UNINDEXED — original schema). */
export const MIGRATION_003_CREATE_MESSAGE_BLOCKS_FTS_SQL = `CREATE VIRTUAL TABLE IF NOT EXISTS message_blocks_fts USING fts5(
        block_id UNINDEXED,
        normalized_content,
        tokenize='trigram'
      )`

/** Migration 003 backfill of message_blocks_normalized from canonical rows. */
export const MIGRATION_003_BACKFILL_MESSAGE_BLOCKS_NORMALIZED_SQL = `INSERT INTO message_blocks_normalized (block_id, message_id, normalized_content)
       SELECT
         mb.id,
         mb.message_id,
         chatdb_normalize(mb.content)
       FROM message_blocks mb
       WHERE mb.type = 'main_text' AND mb.content IS NOT NULL`

/** Migration 003 backfill of message_blocks_fts (auto rowids, block_id scan deletes). */
export const MIGRATION_003_BACKFILL_MESSAGE_BLOCKS_FTS_SQL = `INSERT INTO message_blocks_fts (block_id, normalized_content)
       SELECT
         mb.id,
         chatdb_normalize(mb.content)
       FROM message_blocks mb
       WHERE mb.type = 'main_text' AND mb.content IS NOT NULL`

/** Migration 003 INSERT sync trigger (block_id-based FTS deletes). */
export const MIGRATION_003_CREATE_MESSAGE_BLOCKS_NORMALIZED_INSERT_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS message_blocks_normalized_insert
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

/** Migration 003 UPDATE sync trigger (block_id-based FTS deletes). */
export const MIGRATION_003_CREATE_MESSAGE_BLOCKS_NORMALIZED_UPDATE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS message_blocks_normalized_update
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

/** Migration 003 DELETE sync trigger (block_id-based FTS deletes). */
export const MIGRATION_003_CREATE_MESSAGE_BLOCKS_NORMALIZED_DELETE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS message_blocks_normalized_delete
       AFTER DELETE ON message_blocks
       BEGIN
         DELETE FROM message_blocks_normalized WHERE block_id = OLD.id;
         DELETE FROM message_blocks_fts WHERE block_id = OLD.id;
       END`

// ---------------------------------------------------------------------------
// Migration 004 (current) schema constants — LOCK-FTS-2 single source
//
// rowid identity design (LOCK-003/004): `message_blocks_normalized` gains a
// stable integer PRIMARY KEY (`rowid INTEGER PRIMARY KEY AUTOINCREMENT`) that
// is ALWAYS reused as the `message_blocks_fts` rowid. Triggers therefore
// delete exactly the prior FTS document with `WHERE rowid = (SELECT rowid
// FROM message_blocks_normalized WHERE block_id = ...)` — an indexed lookup
// on the unique block_id plus a direct FTS5 rowid delete — never a scan of
// the UNINDEXED block_id column. FTS content/search semantics are unchanged.
// ---------------------------------------------------------------------------

/**
 * CREATE TABLE for the normalized projection (LOCK-FTS-2 single source;
 * migration 004 schema — rowid INTEGER PRIMARY KEY AUTOINCREMENT reused as
 * the FTS rowid, block_id UNIQUE for indexed trigger lookups).
 */
export const CREATE_MESSAGE_BLOCKS_NORMALIZED_SQL = `CREATE TABLE IF NOT EXISTS message_blocks_normalized (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        block_id TEXT NOT NULL UNIQUE REFERENCES message_blocks(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        normalized_content TEXT NOT NULL
      )`

/**
 * CREATE INDEX on message_id for joins (LOCK-FTS-2 single source).
 */
export const CREATE_MESSAGE_BLOCKS_NORMALIZED_MESSAGE_ID_INDEX_SQL = `CREATE INDEX IF NOT EXISTS message_blocks_normalized_message_id_idx ON message_blocks_normalized(message_id)`

/**
 * CREATE VIRTUAL TABLE for the FTS5 trigram index (LOCK-FTS-2 single source).
 * `block_id UNINDEXED` is retained: it is carried as a projection column for
 * search results, never scanned — FTS rows are addressed by rowid.
 */
export const CREATE_MESSAGE_BLOCKS_FTS_SQL = `CREATE VIRTUAL TABLE IF NOT EXISTS message_blocks_fts USING fts5(
        block_id UNINDEXED,
        normalized_content,
        tokenize='trigram'
      )`

/**
 * Backfill of message_blocks_normalized from canonical MAIN_TEXT rows with
 * non-null content (LOCK-FTS-2 single source). Rowids are auto-assigned.
 */
export const BACKFILL_MESSAGE_BLOCKS_NORMALIZED_SQL = `INSERT INTO message_blocks_normalized (block_id, message_id, normalized_content)
       SELECT
         mb.id,
         mb.message_id,
         chatdb_normalize(mb.content)
       FROM message_blocks mb
       WHERE mb.type = 'main_text' AND mb.content IS NOT NULL`

/**
 * Backfill of message_blocks_fts with EXPLICIT rowids taken from the
 * normalized table (LOCK-FTS-2 single source; LOCK-003 rowid identity).
 * Reading rowid from message_blocks_normalized guarantees FTS rowid ===
 * normalized rowid regardless of insertion order — no scan-order reliance.
 */
export const BACKFILL_MESSAGE_BLOCKS_FTS_SQL = `INSERT INTO message_blocks_fts (rowid, block_id, normalized_content)
       SELECT
         rowid,
         block_id,
         normalized_content
       FROM message_blocks_normalized`

/**
 * INSERT sync trigger (LOCK-FTS-6: post-rebuild behavior must match a
 * trigger-maintained DB). FTS delete uses the indexed rowid lookup.
 */
export const CREATE_MESSAGE_BLOCKS_NORMALIZED_INSERT_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS message_blocks_normalized_insert
       AFTER INSERT ON message_blocks
       BEGIN
         DELETE FROM message_blocks_fts WHERE rowid = (
           SELECT rowid FROM message_blocks_normalized WHERE block_id = NEW.id
         );
         DELETE FROM message_blocks_normalized WHERE block_id = NEW.id;
         INSERT INTO message_blocks_normalized (block_id, message_id, normalized_content)
         SELECT NEW.id, NEW.message_id, chatdb_normalize(NEW.content)
         WHERE NEW.type = 'main_text' AND NEW.content IS NOT NULL;
         INSERT INTO message_blocks_fts (rowid, block_id, normalized_content)
         SELECT last_insert_rowid(), NEW.id, chatdb_normalize(NEW.content)
         WHERE NEW.type = 'main_text' AND NEW.content IS NOT NULL;
       END`

/**
 * UPDATE sync trigger for content/type/message_id (LOCK-FTS-6). The prior
 * FTS document is removed by rowid via the indexed block_id lookup, then
 * both projection rows are re-inserted with the same fresh rowid.
 */
export const CREATE_MESSAGE_BLOCKS_NORMALIZED_UPDATE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS message_blocks_normalized_update
       AFTER UPDATE OF content, type, message_id ON message_blocks
       BEGIN
         DELETE FROM message_blocks_fts WHERE rowid = (
           SELECT rowid FROM message_blocks_normalized WHERE block_id = OLD.id
         );
         DELETE FROM message_blocks_normalized WHERE block_id = OLD.id;
         INSERT INTO message_blocks_normalized (block_id, message_id, normalized_content)
         SELECT NEW.id, NEW.message_id, chatdb_normalize(NEW.content)
         WHERE NEW.type = 'main_text' AND NEW.content IS NOT NULL;
         INSERT INTO message_blocks_fts (rowid, block_id, normalized_content)
         SELECT last_insert_rowid(), NEW.id, chatdb_normalize(NEW.content)
         WHERE NEW.type = 'main_text' AND NEW.content IS NOT NULL;
       END`

/**
 * DELETE sync trigger (LOCK-FTS-6). BEFORE DELETE: fires BEFORE the FK
 * CASCADE on message_blocks_normalized can remove the row, so the rowid
 * lookup still resolves. Removes exactly the prior block's FTS document via
 * indexed rowid lookup — no UNINDEXED block_id scan — then the normalized
 * row (cascade becomes a no-op). An AFTER DELETE trigger cannot work here:
 * the cascade deletes the normalized row first, leaving the rowid subquery
 * with NULL (LOCK-003 verified).
 */
export const CREATE_MESSAGE_BLOCKS_NORMALIZED_DELETE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS message_blocks_normalized_delete
       BEFORE DELETE ON message_blocks
       BEGIN
         DELETE FROM message_blocks_fts WHERE rowid = (
           SELECT rowid FROM message_blocks_normalized WHERE block_id = OLD.id
         );
         DELETE FROM message_blocks_normalized WHERE block_id = OLD.id;
       END`

/**
 * Derived-object drops in the mandatory safe order (LOCK-FTS-3/4): triggers
 * first (they reference the tables), then the FTS virtual table, then the
 * normalized table (its message_id index auto-drops with the table).
 * Candidate-only — migrations never drop the derived objects.
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
 * → recreate the three sync triggers. Executed atomically and exactly once
 * by the candidate-local helper (chatDbImport/ftsProjection.ts) AFTER the
 * data plane finalizes and BEFORE any seal path. This is the single source
 * of truth for the rebuild — identical bytes to a trigger-maintained
 * (migration-004-applied) schema (LOCK-FTS-6, migration-004 generation).
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

// ===========================================================================
// Migration 004 preflight — FTS/normalized rowid parity (LOCK-001/002/003)
// ===========================================================================
//
// Migration 004 (current schema) no longer rebuilds the FTS trigram index for
// existing 003 databases: it verifies that the frozen 003 projections are
// mutually consistent FIRST, then rebuilds only `message_blocks_normalized`
// (preserving explicit rowids) and installs the rowid-addressable triggers,
// leaving `message_blocks_fts` physically intact (LOCK-002).
//
// The preflight establishes the exact bijection the current triggers rely on
// (LOCK-001 — never silently depend on rowid parity):
//
//   1. FTS outer scan — `message_blocks_fts` scanned ONCE, each row probing
//      `message_blocks_normalized` by rowid (indexed INTEGER PRIMARY KEY):
//        - `fts_without_normalized`: FTS documents whose rowid has no
//          normalized partner (orphan/missing normalized row, or FTS rowid
//          drift).
//        - `block_id_mismatch`: documents whose rowid exists in normalized
//          but whose block_id differs (rowid-addressable drift).
//      The FTS table sits on the LEFT of a LEFT JOIN, so the access plan is
//      deterministic at every scale: one FTS virtual-table scan with indexed
//      rowid probes into normalized — never an optimizer-chosen per-row FTS
//      re-scan (the anti-join shape is planner-dependent and must not be
//      relied on).
//   2. Row-count equality — `SELECT COUNT(*)` from both tables. Combined
//      with check 1 this closes the normalized→FTS direction: with
//      `fts_without_normalized = 0`, every FTS row has a distinct normalized
//      partner (FTS rowids are unique, so the mapping is injective →
//      F ≤ N); `N == F` therefore forces the mapping to be surjective too —
//      every normalized row HAS an FTS document at the same rowid. Both
//      COUNT(*) reads are index/docid iterations (no content reads).
//
// When all three conditions hold the two tables are in bijective
// (rowid, block_id) identity: every rowid is present in both tables, block_id
// agrees at every rowid, and row counts are equal — exactly the count/
// identity assumptions the rowid-addressed INSERT/UPDATE/DELETE triggers make
// (one FTS document per normalized row, addressed by the indexed rowid lookup
// instead of a scan of the UNINDEXED block_id).
//
// Complexity: the FTS `_content` projection is read exactly once (block_id is
// UNINDEXED in the frozen 003 schema, so a full virtual-table scan is
// unavoidable) plus O(rows) indexed rowid probes into normalized and two
// count iterations — O(rows · log rows) total, with NO rows materialized
// into JS (all checks run as aggregate SQL inside SQLite).
// ===========================================================================

/**
 * FTS outer parity query: counts FTS documents with no normalized rowid
 * partner, rowid-matched rows whose block_id differs, and rowid-matched rows
 * whose normalized content differs. One FTS scan plus indexed rowid probes
 * into `message_blocks_normalized`. The FTS table is the LEFT side of the
 * LEFT JOIN, so the plan is a stable single FTS scan at every scale — never
 * an optimizer-chosen per-row FTS re-scan. The content comparison reads
 * `f.normalized_content` (an FTS5 content shadow-table read) on the rows the
 * scan already visits — MARGINAL cost, no second scan (LOCK-001: no new FTS
 * full scan; the expected 120k-row preflight stays well under 10s).
 */
export const MIGRATION_004_PARITY_FTS_OUTER_SQL = `SELECT
  COALESCE(SUM(CASE WHEN n.rowid IS NULL THEN 1 ELSE 0 END), 0) AS fts_without_normalized,
  COALESCE(SUM(CASE WHEN n.rowid IS NOT NULL AND f.block_id IS NOT n.block_id THEN 1 ELSE 0 END), 0) AS block_id_mismatch,
  COALESCE(SUM(CASE WHEN n.rowid IS NOT NULL AND f.normalized_content IS NOT n.normalized_content THEN 1 ELSE 0 END), 0) AS content_mismatch
FROM message_blocks_fts f
LEFT JOIN message_blocks_normalized n ON n.rowid = f.rowid`

/** Normalized row count (index iteration — no content reads). */
export const MIGRATION_004_PARITY_NORMALIZED_COUNT_SQL = `SELECT COUNT(*) AS n FROM message_blocks_normalized`

/** FTS document count (docid iteration — no content reads). */
export const MIGRATION_004_PARITY_FTS_COUNT_SQL = `SELECT COUNT(*) AS n FROM message_blocks_fts`

/**
 * Canonical MAIN_TEXT count: `message_blocks` rows the projection triggers are
 * defined to mirror (`type = 'main_text' AND content IS NOT NULL`). A plain
 * b-tree table scan (no FTS interaction) — catches jointly stale projections
 * where BOTH derived tables agree with each other but disagree with the
 * canonical source (e.g. rows inserted while the sync triggers were absent).
 */
export const MIGRATION_004_PARITY_CANONICAL_COUNT_SQL = `SELECT COUNT(*) AS n FROM message_blocks WHERE type = 'main_text' AND content IS NOT NULL`

/**
 * FTS MATCH smoke (LOCK-SP-4 pattern): executes `MATCH ?` with the fixed
 * synthetic {@link FTS_SMOKE_TOKEN} to prove the FTS5 virtual table is
 * functionally queryable. A bounded trigram index lookup (`SCAN message_blocks_fts
 * VIRTUAL TABLE INDEX 0:M2`), never a full scan. A broken/unqueryable index
 * (e.g. the FTS object replaced by a non-FTS table, or a corrupt pre-state)
 * throws here while the structural/count checks above still pass — the smoke
 * is what fails the preflight closed.
 */
export const MIGRATION_004_FTS_SMOKE_SQL = `SELECT block_id FROM message_blocks_fts WHERE message_blocks_fts MATCH ? LIMIT 1`

/**
 * Result of the migration 004 FTS rowid parity preflight. All fields are
 * counts only — never block IDs, content, or paths (LOCK-PRIV).
 */
export interface FtsRowidParityResult {
  /** FTS documents whose rowid has no `message_blocks_normalized` partner. */
  ftsRowsWithoutNormalized: number
  /** Rowid-matched rows whose block_id differs between the two tables. */
  blockIdMismatches: number
  /** Rowid-matched rows whose normalized content differs between the two tables. */
  normalizedContentMismatches: number
  /** `message_blocks_normalized` row count. */
  normalizedRowCount: number
  /** `message_blocks_fts` document count. */
  ftsRowCount: number
  /**
   * Canonical MAIN_TEXT (`type = 'main_text' AND content IS NOT NULL`) row
   * count. Both derived projections must equal it; a mismatch means the two
   * projections are jointly stale relative to the canonical source.
   */
  canonicalMainTextRowCount: number
}

/**
 * Typed failure raised by migration 004's parity preflight (LOCK-003). The
 * message is a fixed, count-only classification of the drift — never block
 * IDs, content, SQL, or paths. Throwing inside the migration transaction
 * rolls the whole migration back atomically (004 stays unrecorded).
 *
 * When the failure source is a raw SQLite error (missing/unreadable/malformed
 * pre-state), the original error is preserved on `cause` for diagnostics but
 * is NEVER rendered into the outward message — the outward surface stays
 * count-only and identifier-free (LOCK-PRIV).
 */
export class MigrationFtsParityError extends Error {
  constructor(detail: string, cause?: unknown) {
    super(
      `Migration 004 FTS rowid parity preflight failed: ${detail}. ` +
        'The migration was rolled back; no projection changes were made.'
    )
    this.name = 'MigrationFtsParityError'
    if (cause !== undefined) {
      this.cause = cause
    }
  }
}

/**
 * Verify bidirectional (rowid, block_id, normalized_content) identity between
 * the frozen 003 projections on a pre-004 database, plus canonical-source
 * count parity and an FTS MATCH smoke. Pure read — never modifies state.
 *
 * Fails closed with a typed {@link MigrationFtsParityError} when any query
 * cannot execute (missing/unreadable/malformed pre-state, including a broken
 * FTS index the MATCH smoke cannot run), so a raw SQLite error (which can
 * carry object names) never escapes — the raw error is preserved as `cause`.
 *
 * @param rawSqlite  Raw better-sqlite3 handle of the pre-004 database.
 */
export function verifyFtsRowidParity(rawSqlite: Database.Database): FtsRowidParityResult {
  let ftsOuter: { fts_without_normalized: number; block_id_mismatch: number; content_mismatch: number }
  let normalizedCount: { n: number }
  let ftsCount: { n: number }
  let canonicalCount: { n: number }
  try {
    ftsOuter = rawSqlite.prepare(MIGRATION_004_PARITY_FTS_OUTER_SQL).get() as {
      fts_without_normalized: number
      block_id_mismatch: number
      content_mismatch: number
    }
    normalizedCount = rawSqlite.prepare(MIGRATION_004_PARITY_NORMALIZED_COUNT_SQL).get() as { n: number }
    ftsCount = rawSqlite.prepare(MIGRATION_004_PARITY_FTS_COUNT_SQL).get() as { n: number }
    canonicalCount = rawSqlite.prepare(MIGRATION_004_PARITY_CANONICAL_COUNT_SQL).get() as { n: number }
    // LOCK-SP-4-style FTS MATCH smoke: a MATCH execution that does not throw
    // proves the FTS5 virtual table is functionally queryable. Bounded trigram
    // lookup; a broken/unqueryable FTS throws here and fails the preflight.
    rawSqlite.prepare(MIGRATION_004_FTS_SMOKE_SQL).get(FTS_SMOKE_TOKEN)
  } catch (cause) {
    throw new MigrationFtsParityError('the projection tables are missing or unreadable (malformed pre-state)', cause)
  }
  return {
    ftsRowsWithoutNormalized: ftsOuter.fts_without_normalized,
    blockIdMismatches: ftsOuter.block_id_mismatch,
    normalizedContentMismatches: ftsOuter.content_mismatch,
    normalizedRowCount: normalizedCount.n,
    ftsRowCount: ftsCount.n,
    canonicalMainTextRowCount: canonicalCount.n
  }
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
  // 003 — FTS5 normalized search projection (Phase 5.1B-2) — FROZEN
  // =========================================================================
  //
  // Adds a normalized content projection for FTS5 trigram search.
  //
  // Tables:
  // - message_blocks_normalized: stores normalized (markdown-stripped, CRLF→LF)
  //   content for each MAIN_TEXT block. Contains block_id, message_id, and
  //   normalized_content columns (block_id TEXT PRIMARY KEY).
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
  // FROZEN (LOCK-FTS-2/-6 historical): this entry is assembled from the
  // MIGRATION_003_* legacy constants and is byte-identical to the released
  // migration. NEVER edit it. Migration 004 upgrades the schema it creates
  // (stable FTS rowid identity); the CURRENT schema constants
  // (CREATE_MESSAGE_BLOCKS_*_SQL etc.) belong to migration 004 and the
  // candidate rebuild helper (chatDbImport/ftsProjection.ts).
  // =========================================================================

  {
    key: '003_fts5_normalized_search',
    description: 'FTS5 normalized search projection: block_normalized table, trigram FTS, and synchronization triggers',
    sql: [
      MIGRATION_003_CREATE_MESSAGE_BLOCKS_NORMALIZED_SQL,
      MIGRATION_003_CREATE_MESSAGE_BLOCKS_NORMALIZED_MESSAGE_ID_INDEX_SQL,
      MIGRATION_003_CREATE_MESSAGE_BLOCKS_FTS_SQL,
      MIGRATION_003_BACKFILL_MESSAGE_BLOCKS_NORMALIZED_SQL,
      MIGRATION_003_BACKFILL_MESSAGE_BLOCKS_FTS_SQL,
      MIGRATION_003_CREATE_MESSAGE_BLOCKS_NORMALIZED_INSERT_TRIGGER_SQL,
      MIGRATION_003_CREATE_MESSAGE_BLOCKS_NORMALIZED_UPDATE_TRIGGER_SQL,
      MIGRATION_003_CREATE_MESSAGE_BLOCKS_NORMALIZED_DELETE_TRIGGER_SQL
    ]
  },

  // =========================================================================
  // 004 — FTS rowid identity (LOCK-001/002/003/004)
  // =========================================================================
  //
  // Problem: migration 003's FTS sync triggers remove a block's FTS document
  // with `DELETE FROM message_blocks_fts WHERE block_id = NEW.id`. block_id
  // is UNINDEXED in the FTS5 virtual table, so every streaming
  // block-content update scans the ENTIRE virtual table (measured ~1.6–2.4s
  // at 2.15GB/120k rows, growing past 4s after churn — ~95–99% of the
  // update cost; see the phase benchmarks).
  //
  // Fix (collision-free, no hashes): give every normalized row a stable
  // integer PRIMARY KEY (`rowid INTEGER PRIMARY KEY AUTOINCREMENT`) and reuse
  // that rowid as the `message_blocks_fts` rowid. Triggers then remove the
  // exact prior FTS document via
  //   DELETE FROM message_blocks_fts WHERE rowid = (
  //     SELECT rowid FROM message_blocks_normalized WHERE block_id = OLD.id
  //   )
  // — an indexed lookup on the UNIQUE block_id plus a direct FTS5 rowid
  // delete (O(log n)); no full virtual-table scan. FTS content, the
  // `block_id` projection column, search semantics, and the shared exact
  // regex matcher (LOCK-5125) are unchanged.
  //
  // Existing-003 databases — verified no-rebuild (LOCK-002):
  //   For every pre-004 DB, the preflight FIRST verifies bidirectional
  //   (rowid, block_id) identity between `message_blocks_normalized` and
  //   `message_blocks_fts` (verifyFtsRowidParity — LOCK-001). The frozen 003
  //   DDL/triggers make this parity a structural invariant (identical
  //   backfill scans + identical per-trigger DELETE+INSERT sequences with
  //   empirically identical rowid allocators), but the migration never
  //   silently depends on it: drift or a malformed pre-state fails closed
  //   with a typed MigrationFtsParityError and a full transaction rollback
  //   (LOCK-003). On verified parity the FTS virtual table is left physically
  //   intact — no DROP/CREATE, no trigram backfill; only
  //   `message_blocks_normalized` is rebuilt into the stable AUTOINCREMENT
  //   rowid mapping (explicit rowids preserved, sqlite_sequence auto-seeded
  //   to MAX by SQLite's documented explicit-rowid behavior) and the current
  //   triggers are installed.
  //
  // Migration steps (all inside one transaction; rollback-safe):
  //   [preflight] Verify FTS/normalized (rowid, block_id) identity — fail
  //               closed (typed error + rollback) on any drift/malformed state.
  //   1. Drop the three sync triggers (they reference the tables being
  //      rebuilt and are replaced with rowid-identity versions).
  //   2. Rebuild message_blocks_normalized only: RENAME the old (003) table
  //      aside, CREATE the new rowid-identity table from the current
  //      constant, INSERT SELECT with EXPLICIT rowid (rowids preserved —
  //      AUTOINCREMENT's sqlite_sequence is seeded to MAX by SQLite's
  //      documented explicit-rowid behavior), DROP the old table, recreate
  //      the message_id index.
  //   3. Recreate the three sync triggers from the current constants.
  //   message_blocks_fts is NOT touched: verified parity guarantees its
  //   (rowid, block_id) content already matches the rebuilt normalized table.
  //
  // Fresh databases and import candidates (LOCK-004): the fresh 001→002→003
  // path lands in the same verified state (003 backfills both tables in
  // lockstep, so parity holds and 004 takes the no-rebuild path); the
  // candidate-only deferred rebuild (chatDbImport/ftsProjection.ts) keeps
  // building the CURRENT normalized+FTS schema from scratch via
  // DERIVED_PROJECTION_REBUILD_SQL — never made a no-op.
  //
  // Idempotence: recorded in migration_state exactly once; every statement
  // is IF EXISTS/IF NOT EXISTS safe; a mid-migration failure (including the
  // parity preflight) rolls back the whole transaction, leaving the pre-004
  // schema intact and 004 unrecorded (re-run resumes from the untouched
  // state).
  // =========================================================================

  {
    key: '004_fts_rowid_identity',
    description:
      'Stable FTS rowid identity: parity-verified no-rebuild — normalized projection rebuilt with INTEGER PRIMARY KEY rowid reused as the FTS rowid, FTS index kept physically intact; triggers delete by indexed rowid instead of scanning UNINDEXED block_id',
    preflight: (rawSqlite) => {
      const parity = verifyFtsRowidParity(rawSqlite)
      const drift: string[] = []
      if (parity.ftsRowsWithoutNormalized > 0) {
        drift.push(`${parity.ftsRowsWithoutNormalized} FTS document(s) with no normalized rowid`)
      }
      if (parity.normalizedRowCount !== parity.ftsRowCount) {
        drift.push(
          `${parity.normalizedRowCount} normalized row(s) vs ${parity.ftsRowCount} FTS document(s) — row counts differ`
        )
      }
      if (parity.canonicalMainTextRowCount !== parity.normalizedRowCount) {
        drift.push(
          `${parity.canonicalMainTextRowCount} canonical MAIN_TEXT row(s) vs ${parity.normalizedRowCount} normalized row(s) — jointly stale projections`
        )
      }
      if (parity.blockIdMismatches > 0) {
        drift.push(`${parity.blockIdMismatches} rowid-matched row(s) with a different block_id`)
      }
      if (parity.normalizedContentMismatches > 0) {
        drift.push(`${parity.normalizedContentMismatches} rowid-matched row(s) with different normalized content`)
      }
      if (drift.length > 0) {
        throw new MigrationFtsParityError(drift.join('; '))
      }
    },
    sql: [
      `DROP TRIGGER IF EXISTS ${MESSAGE_BLOCKS_NORMALIZED_INSERT_TRIGGER}`,
      `DROP TRIGGER IF EXISTS ${MESSAGE_BLOCKS_NORMALIZED_UPDATE_TRIGGER}`,
      `DROP TRIGGER IF EXISTS ${MESSAGE_BLOCKS_NORMALIZED_DELETE_TRIGGER}`,
      `ALTER TABLE message_blocks_normalized RENAME TO message_blocks_normalized_mig_old`,
      CREATE_MESSAGE_BLOCKS_NORMALIZED_SQL,
      `INSERT INTO message_blocks_normalized (rowid, block_id, message_id, normalized_content)
       SELECT rowid, block_id, message_id, normalized_content
       FROM message_blocks_normalized_mig_old`,
      `DROP TABLE message_blocks_normalized_mig_old`,
      CREATE_MESSAGE_BLOCKS_NORMALIZED_MESSAGE_ID_INDEX_SQL,
      CREATE_MESSAGE_BLOCKS_NORMALIZED_INSERT_TRIGGER_SQL,
      CREATE_MESSAGE_BLOCKS_NORMALIZED_UPDATE_TRIGGER_SQL,
      CREATE_MESSAGE_BLOCKS_NORMALIZED_DELETE_TRIGGER_SQL
    ]
  },
  {
    key: '005_sync_metadata',
    description: 'Additive sync metadata: outbox, applied ids, cursor/device state and entity clocks',
    sql: [
      `CREATE TABLE IF NOT EXISTS sync_outbox (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        op TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        device_id TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS sync_outbox_entity_id_idx ON sync_outbox(entity_id)`,
      `CREATE INDEX IF NOT EXISTS sync_outbox_timestamp_idx ON sync_outbox(timestamp)`,
      `CREATE TABLE IF NOT EXISTS sync_applied (
        operation_id TEXT PRIMARY KEY,
        applied_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        value TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS sync_entity_clock (
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        operation_id TEXT NOT NULL,
        PRIMARY KEY (entity_type, entity_id)
      )`
    ]
  },
  {
    key: '006_sync_field_merge',
    description:
      'Additive sync field merge: per-field clocks for independent scalar merges and bounded same-field conflict log',
    sql: [
      `CREATE TABLE IF NOT EXISTS sync_field_clock (
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        field TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        operation_id TEXT NOT NULL,
        PRIMARY KEY (entity_type, entity_id, field)
      )`,
      `CREATE TABLE IF NOT EXISTS sync_conflict_log (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        field TEXT NOT NULL,
        loser_value_json TEXT,
        loser_timestamp INTEGER NOT NULL,
        loser_operation_id TEXT NOT NULL,
        winner_timestamp INTEGER NOT NULL,
        winner_operation_id TEXT NOT NULL,
        created_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS sync_conflict_log_entity_idx ON sync_conflict_log(entity_type, entity_id)`
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
        // LOCK-001/003: preflight runs INSIDE the transaction, before any
        // SQL/DDL. A throw here (e.g. FTS rowid parity drift) rolls back the
        // whole migration and leaves the migration unrecorded — fail closed.
        migration.preflight?.(rawSqlite)

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
