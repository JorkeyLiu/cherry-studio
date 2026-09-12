/**
 * Migration 004 — FTS rowid identity tests (LOCK-003/004)
 *
 * Covers:
 * - Fresh DB applies 001 + 002 + 003 + 004; lands directly in the
 *   rowid-identity schema (normalized rowid INTEGER PRIMARY KEY
 *   AUTOINCREMENT, block_id UNIQUE).
 * - Pre-change DB (001+002+003 applied, ORIGINAL schema) upgrades through
 *   004 with existing data preserved.
 * - FTS rowid === normalized rowid for EVERY block after upgrade (explicit
 *   rowid backfill — no scan-order reliance).
 * - Row-count parity: message_blocks_normalized == message_blocks_fts ==
 *   canonical MAIN_TEXT/content-not-null rows.
 * - Search results identical before vs after the upgrade.
 * - INSERT/UPDATE/DELETE triggers maintain the projection after 004,
 *   including type transitions, message_id reparent, and FK cascade.
 * - sqlite_sequence seeded: new inserts after upgrade take MAX+1 (no rowid
 *   collision) and FTS rowid follows.
 * - Rollback: a forced mid-migration failure rolls back the whole upgrade,
 *   migration_state 004 is NOT recorded, and the pre-004 schema/data are
 *   intact; re-running after the failure source is removed succeeds.
 * - Idempotence: runMigrations after 004 applies zero migrations.
 * - Query-plan regression (LOCK-003): the trigger-shaped FTS delete binds
 *   the rowid (`INDEX 0:=`) with an indexed SEARCH on message_blocks_normalized
 *   — it does NOT full-scan the FTS virtual table like the old
 *   `WHERE block_id = ?` did.
 */

import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

vi.mock('@main/config', () => ({
  DATA_PATH: '/mock/data'
}))

import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import {
  FTS_SMOKE_TOKEN,
  MESSAGE_BLOCKS_FTS_TABLE,
  MIGRATION_003_CREATE_MESSAGE_BLOCKS_NORMALIZED_DELETE_TRIGGER_SQL,
  MIGRATION_003_CREATE_MESSAGE_BLOCKS_NORMALIZED_INSERT_TRIGGER_SQL,
  MIGRATION_003_CREATE_MESSAGE_BLOCKS_NORMALIZED_UPDATE_TRIGGER_SQL,
  MIGRATION_004_FTS_SMOKE_SQL,
  MIGRATION_004_PARITY_CANONICAL_COUNT_SQL,
  MIGRATION_004_PARITY_FTS_COUNT_SQL,
  MIGRATION_004_PARITY_FTS_OUTER_SQL,
  MIGRATION_004_PARITY_NORMALIZED_COUNT_SQL,
  MigrationFtsParityError,
  MIGRATIONS,
  registerChatDbNormalize,
  runMigrations,
  verifyFtsRowidParity
} from '../migration'
import { SearchRepository } from '../repository/SearchRepository'
import * as schema from '../schema'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-migration004-'))
}

function rmrf(dir: string): void {
  realFs.rmSync(dir, { recursive: true, force: true })
}

function openTestDb(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  return db
}

function wrapDrizzle(sqlite: Database.Database): BetterSQLite3Database<typeof schema> {
  return drizzle(sqlite, { schema })
}

function registerNormalizeFunction(sqlite: Database.Database): void {
  registerChatDbNormalize(sqlite)
}

function getColumnInfo(
  sqlite: Database.Database,
  tableName: string
): Array<{ name: string; pk: number; type: string; notnull: number }> {
  return sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string
    pk: number
    type: string
    notnull: number
  }>
}

/**
 * Apply migrations 001 + 002 + 003 manually (recorded in migration_state)
 * to build a PRE-CHANGE database: the original 003 schema with
 * block_id TEXT PRIMARY KEY and UNINDEXED block_id FTS deletes.
 */
function applyMigrationsUpTo003(db: BetterSQLite3Database<typeof schema>, sqlite: Database.Database): void {
  db.run(/* sql */ `
    CREATE TABLE IF NOT EXISTS migration_state (
      key   TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT
    )
  `)
  sqlite.pragma('foreign_keys = OFF')
  db.transaction((tx) => {
    for (const stmt of MIGRATIONS[0].sql) tx.run(stmt)
    tx.insert(schema.migrationState)
      .values({ key: MIGRATIONS[0].key, value: MIGRATIONS[0].key, updatedAt: new Date().toISOString() })
      .run()
    for (const stmt of MIGRATIONS[1].sql) tx.run(stmt)
    tx.insert(schema.migrationState)
      .values({ key: MIGRATIONS[1].key, value: MIGRATIONS[1].key, updatedAt: new Date().toISOString() })
      .run()
    for (const stmt of MIGRATIONS[2].sql) tx.run(stmt)
    tx.insert(schema.migrationState)
      .values({ key: MIGRATIONS[2].key, value: MIGRATIONS[2].key, updatedAt: new Date().toISOString() })
      .run()
  })
  sqlite.pragma('foreign_keys = ON')
}

/**
 * Apply ONLY migration 004 (`004_fts_rowid_identity`) on a pre-change DB
 * built by {@link applyMigrationsUpTo003}.
 *
 * Uses the same transaction/registry semantics as production `runMigrations`
 * (migration_state ensure + applied-set check, normalize registration, FK
 * OFF/ON around a single transaction, preflight INSIDE the transaction before
 * any DDL, record-on-success) but with a fixed natural history boundary:
 * only the 004 registry entry runs — never 005..008. The entry is resolved
 * by key, never by array index.
 *
 * Return semantics (same newly-applied-count shape as `runMigrations`, NOT a
 * total): 1 when 004 is newly applied, 0 when 004 is already recorded
 * (idempotent no-op). A preflight/SQL failure throws with a full rollback
 * and leaves 004 unrecorded.
 */
function applyMigration004Only(db: BetterSQLite3Database<typeof schema>, sqlite: Database.Database): number {
  const migration = MIGRATIONS.find((m) => m.key === '004_fts_rowid_identity')
  if (!migration) {
    throw new Error('Migration 004 entry missing from MIGRATIONS registry')
  }
  db.run(/* sql */ `
    CREATE TABLE IF NOT EXISTS migration_state (
      key   TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT
    )
  `)
  const rows = db.select().from(schema.migrationState).all()
  const applied = new Set(rows.map((r) => r.key))
  if (applied.has(migration.key)) {
    return 0
  }
  if (migration.sql.length === 0) {
    throw new Error(`Migration "${migration.key}" has no SQL statements — this is a programming error`)
  }
  registerNormalizeFunction(sqlite)
  const hadFkOn = sqlite.pragma('foreign_keys', { simple: true }) === 1
  if (hadFkOn) {
    sqlite.pragma('foreign_keys = OFF')
  }
  try {
    db.transaction((tx) => {
      migration.preflight?.(sqlite)
      for (const stmt of migration.sql) {
        tx.run(stmt)
      }
      tx.insert(schema.migrationState)
        .values({ key: migration.key, value: migration.key, updatedAt: new Date().toISOString() })
        .run()
    })
  } finally {
    if (hadFkOn) {
      sqlite.pragma('foreign_keys = ON')
    }
  }
  return 1
}

/** Seed deterministic chat data + FTS churn through the 003 triggers. */
function seedLegacyData(sqlite: Database.Database): void {
  sqlite.exec(`INSERT INTO topics (id, name, created_at) VALUES ('t1', 'Legacy Topic', '2026-01-01T00:00:00.000Z')`)
  sqlite.exec(
    `INSERT INTO messages (id, topic_id, role, content, created_at, sort_order) VALUES ('m1', 't1', 'user', 'Hello', '2026-01-01T00:01:00.000Z', 0)`
  )
  sqlite.exec(
    `INSERT INTO messages (id, topic_id, role, content, created_at, sort_order) VALUES ('m2', 't1', 'assistant', 'World', '2026-01-01T00:02:00.000Z', 1)`
  )
  sqlite.exec(
    `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b1', 'm1', 'main_text', 'Hello world', 0)`
  )
  sqlite.exec(
    `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b2', 'm1', 'file', null, 1)`
  )
  sqlite.exec(
    `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b3', 'm2', 'main_text', 'Second message body', 0)`
  )
  // Streaming-style churn: repeated content updates fire the 003 triggers
  // (DELETE+INSERT with auto rowids on both tables).
  sqlite.exec(`UPDATE message_blocks SET content = 'Updated body v1' WHERE id = 'b3'`)
  sqlite.exec(`UPDATE message_blocks SET content = 'Updated body v2' WHERE id = 'b3'`)
  sqlite.exec(`UPDATE message_blocks SET content = 'Updated body v3' WHERE id = 'b3'`)
}

/** Verify FTS rowid === normalized rowid for every row, both directions. */
function expectRowidParity(sqlite: Database.Database): void {
  const ftsOrphans = (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM message_blocks_fts f
         LEFT JOIN message_blocks_normalized n ON f.rowid = n.rowid
         WHERE n.rowid IS NULL`
      )
      .get() as { n: number }
  ).n
  const normalizedOrphans = (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM message_blocks_normalized n
         LEFT JOIN message_blocks_fts f ON f.rowid = n.rowid
         WHERE f.rowid IS NULL`
      )
      .get() as { n: number }
  ).n
  expect(ftsOrphans).toBe(0)
  expect(normalizedOrphans).toBe(0)
}

/** Row-count parity: normalized == FTS == canonical MAIN_TEXT/content-not-null. */
function expectCountParity(sqlite: Database.Database): void {
  const canonical = (
    sqlite
      .prepare("SELECT COUNT(*) AS n FROM message_blocks WHERE type = 'main_text' AND content IS NOT NULL")
      .get() as { n: number }
  ).n
  const normalized = (sqlite.prepare('SELECT COUNT(*) AS n FROM message_blocks_normalized').get() as { n: number }).n
  const fts = (sqlite.prepare('SELECT COUNT(*) AS n FROM message_blocks_fts').get() as { n: number }).n
  expect(normalized).toBe(canonical)
  expect(fts).toBe(canonical)
}

/**
 * FTS5 integrity-check special command. Throws when the index is corrupt.
 * Used to prove the physical FTS index remains valid across a no-rebuild
 * migration (LOCK-002).
 */
function expectFtsIntegrityOk(sqlite: Database.Database): void {
  expect(() =>
    sqlite
      .prepare(`INSERT INTO ${MESSAGE_BLOCKS_FTS_TABLE}(${MESSAGE_BLOCKS_FTS_TABLE}) VALUES('integrity-check')`)
      .run()
  ).not.toThrow()
}

/**
 * Physical FTS state snapshot: sqlite_master rows (incl. rootpages) for the
 * virtual table and its shadow tables, plus every FTS document's
 * (rowid, block_id, normalized_content). Two identical snapshots around a
 * migration prove the FTS table was NOT rebuilt — its pages, rootpages, and
 * content survive byte-identical (LOCK-002 no-rebuild proof, feasible at
 * test scale).
 */
function captureFtsPhysicalState(sqlite: Database.Database): {
  master: Array<{ type: string; name: string; rootpage: number; sql: string | null }>
  rows: Array<{ rowid: number; block_id: string; normalized_content: string }>
} {
  const master = sqlite
    .prepare(`SELECT type, name, rootpage, sql FROM sqlite_master WHERE name LIKE 'message_blocks_fts%' ORDER BY name`)
    .all() as Array<{ type: string; name: string; rootpage: number; sql: string | null }>
  const rows = sqlite
    .prepare('SELECT rowid, block_id, normalized_content FROM message_blocks_fts ORDER BY rowid')
    .all() as Array<{ rowid: number; block_id: string; normalized_content: string }>
  return { master, rows }
}

/**
 * Create rowid GAPS in both projections under the frozen 003 triggers: delete
 * a mid-table block (rowid 1) then insert a new block (takes a fresh max+1
 * rowid) — rowid 1 stays free in BOTH tables in lockstep.
 */
function createRowidGaps(sqlite: Database.Database): void {
  sqlite.exec(`DELETE FROM message_blocks WHERE id = 'b1'`)
  sqlite.exec(
    `INSERT INTO messages (id, topic_id, role, content, created_at, sort_order) VALUES ('m3', 't1', 'user', 'Gap filler', '2026-01-01T00:03:00.000Z', 2)`
  )
  sqlite.exec(
    `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b4', 'm3', 'main_text', 'Block after gap', 0)`
  )
}

function searchBlockIds(sqlite: Database.Database, keywords: string): string[] {
  const repo = new SearchRepository(sqlite)
  const result = repo.search({ keywords, matchMode: 'substring', sortOrder: 'newest', pageSize: 100 })
  return result.items.map((i) => i.blockId)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Migration 004 — FTS rowid identity', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
  })

  afterEach(() => {
    rmrf(tempDir)
  })

  it('fresh DB applies 001-004 and lands directly in the rowid-identity schema', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    const applied = runMigrations(db, sqlite)
    expect(applied).toBe(14)

    // New normalized schema: INTEGER PRIMARY KEY rowid + UNIQUE block_id.
    const normalizedCols = getColumnInfo(sqlite, 'message_blocks_normalized')
    expect(normalizedCols.map((c) => c.name)).toEqual(['rowid', 'block_id', 'message_id', 'normalized_content'])
    expect(normalizedCols.find((c) => c.name === 'rowid')?.pk).toBe(1)
    expect(normalizedCols.find((c) => c.name === 'block_id')?.notnull).toBe(1)

    // FTS virtual table present and queryable (smoke MATCH).
    sqlite.exec(`INSERT INTO topics (id, name) VALUES ('t1', 'T')`)
    sqlite.exec(`INSERT INTO messages (id, topic_id, role, content, sort_order) VALUES ('m1', 't1', 'user', 'x', 0)`)
    sqlite.exec(
      `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b1', 'm1', 'main_text', 'Fresh schema content', 0)`
    )
    const hits = sqlite
      .prepare(`SELECT block_id FROM message_blocks_fts WHERE normalized_content MATCH ?`)
      .all('"fresh schema"') as Array<{ block_id: string }>
    expect(hits.map((r) => r.block_id)).toContain('b1')

    // Triggers present.
    const triggers = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
      .all() as Array<{
      name: string
    }>
    expect(triggers.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'message_blocks_normalized_insert',
        'message_blocks_normalized_update',
        'message_blocks_normalized_delete'
      ])
    )

    sqlite.close()
  })

  it('upgrades a pre-change 001+002+003 DB preserving content and aligning FTS rowids', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    applyMigrationsUpTo003(db, sqlite)

    // Sanity: pre-change schema is the ORIGINAL one (block_id TEXT PRIMARY KEY).
    const preCols = getColumnInfo(sqlite, 'message_blocks_normalized')
    expect(preCols.map((c) => c.name)).toEqual(['block_id', 'message_id', 'normalized_content'])
    expect(preCols.find((c) => c.name === 'block_id')?.pk).toBe(1)

    seedLegacyData(sqlite)
    const searchBefore = searchBlockIds(sqlite, 'updated body')

    // Snapshot of pre-change content (before any 004 writes).
    const normalizedBefore = sqlite
      .prepare('SELECT block_id, message_id, normalized_content FROM message_blocks_normalized ORDER BY block_id')
      .all()
    const ftsBefore = sqlite
      .prepare('SELECT rowid, block_id FROM message_blocks_fts ORDER BY block_id')
      .all() as Array<{ rowid: number; block_id: string }>

    // Apply ONLY 004 on the 001+002+003 pre-state (fixed history boundary).
    const applied = applyMigration004Only(db, sqlite)
    expect(applied).toBe(1)

    // New schema.
    const postCols = getColumnInfo(sqlite, 'message_blocks_normalized')
    expect(postCols.map((c) => c.name)).toEqual(['rowid', 'block_id', 'message_id', 'normalized_content'])
    expect(postCols.find((c) => c.name === 'rowid')?.pk).toBe(1)

    // Content preserved exactly.
    const normalizedAfter = sqlite
      .prepare('SELECT block_id, message_id, normalized_content FROM message_blocks_normalized ORDER BY block_id')
      .all()
    expect(normalizedAfter).toEqual(normalizedBefore)

    // Every FTS document is present with the same block_id (content parity).
    const ftsAfter = sqlite.prepare('SELECT rowid, block_id FROM message_blocks_fts ORDER BY block_id').all() as Array<{
      rowid: number
      block_id: string
    }>
    const ftsBeforeTyped = ftsBefore as Array<{ rowid: number; block_id: string }>
    expect(ftsAfter.map((r) => r.block_id)).toEqual(ftsBeforeTyped.map((r) => r.block_id))
    expect(ftsAfter.length).toBeGreaterThan(0)

    // LOCK-003: FTS rowid === normalized rowid for EVERY row.
    expectRowidParity(sqlite)
    expectCountParity(sqlite)

    // Search semantics unchanged.
    const searchAfter = searchBlockIds(sqlite, 'updated body')
    expect(searchAfter).toEqual(searchBefore)
    expect(searchAfter).toContain('b3')

    sqlite.close()
  })

  it('sqlite_sequence is seeded so post-upgrade inserts take MAX+1 without rowid collision', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    applyMigrationsUpTo003(db, sqlite)
    seedLegacyData(sqlite)
    expect(applyMigration004Only(db, sqlite)).toBe(1)

    const maxRowid = (
      sqlite.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM message_blocks_normalized').get() as { n: number }
    ).n
    expect(maxRowid).toBeGreaterThan(0)

    // Insert a new main_text block → normalized rowid MAX+1, FTS follows.
    sqlite.exec(
      `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b9', 'm2', 'main_text', 'Post upgrade insert', 1)`
    )
    const normRow = sqlite
      .prepare('SELECT rowid, block_id FROM message_blocks_normalized WHERE block_id = ?')
      .get('b9') as { rowid: number; block_id: string }
    const ftsRow = sqlite.prepare('SELECT rowid, block_id FROM message_blocks_fts WHERE block_id = ?').get('b9') as {
      rowid: number
      block_id: string
    }
    expect(normRow.rowid).toBe(maxRowid + 1)
    expect(ftsRow.rowid).toBe(normRow.rowid)
    expectRowidParity(sqlite)

    sqlite.close()
  })

  it('post-004 triggers maintain the projection for update/type-transition/reparent/delete/cascade', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    applyMigrationsUpTo003(db, sqlite)
    seedLegacyData(sqlite)
    expect(applyMigration004Only(db, sqlite)).toBe(1)

    // UPDATE content → projection refreshed (rowid identity preserved).
    sqlite.exec(`UPDATE message_blocks SET content = 'Fourth version' WHERE id = 'b3'`)
    const updated = sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b3') as {
      normalized_content: string
    }
    expect(updated.normalized_content).toBe('fourth version')
    expectRowidParity(sqlite)

    // UPDATE type to non-main_text → projection row removed.
    sqlite.exec(`UPDATE message_blocks SET type = 'file' WHERE id = 'b3'`)
    expect(sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b3')).toBeUndefined()
    expect(sqlite.prepare('SELECT * FROM message_blocks_fts WHERE block_id = ?').get('b3')).toBeUndefined()
    expectCountParity(sqlite)

    // UPDATE type back to main_text → projection row recreated.
    sqlite.exec(`UPDATE message_blocks SET type = 'main_text', content = 'Back to text' WHERE id = 'b3'`)
    const recreated = sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b3') as {
      normalized_content: string
    }
    expect(recreated.normalized_content).toBe('back to text')
    expectRowidParity(sqlite)

    // UPDATE message_id (reparent) → projection follows.
    sqlite.exec(`INSERT INTO messages (id, topic_id, role, content, sort_order) VALUES ('m3', 't1', 'user', 'y', 2)`)
    sqlite.exec(`UPDATE message_blocks SET message_id = 'm3' WHERE id = 'b3'`)
    const reparented = sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b3') as {
      message_id: string
    }
    expect(reparented.message_id).toBe('m3')
    expectRowidParity(sqlite)

    // DELETE block → projection + FTS row removed.
    sqlite.exec(`DELETE FROM message_blocks WHERE id = 'b3'`)
    expect(sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b3')).toBeUndefined()
    expect(sqlite.prepare('SELECT * FROM message_blocks_fts WHERE block_id = ?').get('b3')).toBeUndefined()

    // FK cascade: message delete cascades to blocks → projections.
    expectCountParity(sqlite)
    sqlite.exec(`DELETE FROM messages WHERE id = 'm1'`)
    expect(sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b1')).toBeUndefined()
    expect(sqlite.prepare('SELECT * FROM message_blocks_fts WHERE block_id = ?').get('b1')).toBeUndefined()
    expectRowidParity(sqlite)
    expectCountParity(sqlite)

    sqlite.close()
  })

  it('query-plan regression: trigger-shaped FTS delete binds rowid + indexed lookup, no virtual-table scan', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    applyMigrationsUpTo003(db, sqlite)
    seedLegacyData(sqlite)
    expect(applyMigration004Only(db, sqlite)).toBe(1)

    // The NEW trigger shape: DELETE by rowid from an indexed block_id lookup.
    const newPlan = sqlite
      .prepare(
        `EXPLAIN QUERY PLAN DELETE FROM message_blocks_fts WHERE rowid = (SELECT rowid FROM message_blocks_normalized WHERE block_id = ?)`
      )
      .all('b1') as Array<{ detail: string }>
    const newDetails = newPlan.map((r) => r.detail).join('\n')
    // FTS5 binds the rowid equality constraint (INDEX 0:=) and resolves the
    // block through the unique block_id index on the normalized table.
    expect(newDetails).toContain('INDEX 0:=')
    expect(newDetails).toContain('SEARCH message_blocks_normalized')

    // The OLD trigger shape scanned the UNINDEXED block_id column.
    const oldPlan = sqlite
      .prepare(`EXPLAIN QUERY PLAN DELETE FROM message_blocks_fts WHERE block_id = ?`)
      .all('b1') as Array<{ detail: string }>
    const oldDetails = oldPlan.map((r) => r.detail).join('\n')
    expect(oldDetails).toContain('SCAN message_blocks_fts')
    expect(oldDetails).not.toContain('INDEX 0:=')

    sqlite.close()
  })

  it('rollback: a forced mid-migration failure leaves the pre-004 schema intact and 004 unrecorded', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    applyMigrationsUpTo003(db, sqlite)
    seedLegacyData(sqlite)

    // Snapshot pre-failure state.
    const preSchema = getColumnInfo(sqlite, 'message_blocks_normalized')
    const preNormalized = sqlite.prepare('SELECT * FROM message_blocks_normalized ORDER BY block_id').all()
    const preFts = sqlite.prepare('SELECT rowid, block_id FROM message_blocks_fts ORDER BY rowid').all()

    // Force 004's in-place rebuild to fail mid-transaction: a view holding
    // the rename target name makes the `RENAME TO message_blocks_normalized_mig_old`
    // step fail, aborting the whole migration (the 3 trigger drops that ran
    // before it must roll back too). A TEMP trigger is unusable here because
    // ALTER TABLE RENAME re-binds triggers to the renamed table.
    sqlite.exec('CREATE VIEW message_blocks_normalized_mig_old AS SELECT 1 AS x')
    try {
      expect(() => applyMigration004Only(db, sqlite)).toThrow()
    } finally {
      sqlite.exec('DROP VIEW IF EXISTS message_blocks_normalized_mig_old')
    }

    // 004 was NOT recorded.
    const state = (
      sqlite.prepare("SELECT COUNT(*) AS n FROM migration_state WHERE key = '004_fts_rowid_identity'").get() as {
        n: number
      }
    ).n
    expect(state).toBe(0)

    // Pre-004 schema and data fully intact (transactional rollback) — the
    // trigger drops rolled back, the normalized table was not renamed.
    expect(getColumnInfo(sqlite, 'message_blocks_normalized')).toEqual(preSchema)
    expect(sqlite.prepare('SELECT * FROM message_blocks_normalized ORDER BY block_id').all()).toEqual(preNormalized)
    expect(sqlite.prepare('SELECT rowid, block_id FROM message_blocks_fts ORDER BY rowid').all()).toEqual(preFts)
    const triggers = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
      .all() as Array<{
      name: string
    }>
    expect(triggers.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'message_blocks_normalized_insert',
        'message_blocks_normalized_update',
        'message_blocks_normalized_delete'
      ])
    )

    // Re-running after the failure source is removed succeeds and upgrades ONLY 004.
    const applied = applyMigration004Only(db, sqlite)
    expect(applied).toBe(1)
    expectRowidParity(sqlite)
    expectCountParity(sqlite)

    sqlite.close()
  })

  it('idempotence: runMigrations after 004 applies zero migrations', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    expect(runMigrations(db, sqlite)).toBe(14)
    expect(runMigrations(db, sqlite)).toBe(0)

    const states = sqlite.prepare('SELECT * FROM migration_state ORDER BY key').all() as Array<{ key: string }>
    expect(states.map((s) => s.key)).toEqual([
      '001_initial_schema',
      '002_corrective_schema',
      '003_fts5_normalized_search',
      '004_fts_rowid_identity',
      '005_sync_metadata',
      '006_sync_field_merge',
      '007_sync_pairing_trust',
      '008_sync_channel_reset',
      '009_sync_membership_clock',
      '010_sync_parent_order_frame',
      '011_sync_parent_order_frame_parent_id_unbounded',
      '012_sync_frame_high_water',
      '013_sync_stable_replace_register',
      '014_sync_resend_attempt'
    ])

    sqlite.close()
  })

  it('preflight: churned/gapped 003 DB verifies clean and 004 keeps the FTS index physically intact (no-rebuild)', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    applyMigrationsUpTo003(db, sqlite)
    seedLegacyData(sqlite)
    createRowidGaps(sqlite) // rowid 1 becomes a permanent gap in BOTH tables

    // The churned/gapped pre-state verifies clean through the production
    // parity preflight (LOCK-001) — bidirectional (rowid, block_id) identity
    // with gaps is a valid, drift-free state. The extended checks (content
    // parity, canonical MAIN_TEXT count, FTS MATCH smoke) all pass too.
    expect(verifyFtsRowidParity(sqlite)).toEqual({
      ftsRowsWithoutNormalized: 0,
      blockIdMismatches: 0,
      normalizedContentMismatches: 0,
      normalizedRowCount: 2,
      ftsRowCount: 2,
      canonicalMainTextRowCount: 2
    })

    // Physical FTS state before the migration: sqlite_master (incl. rootpages)
    // + every document + FTS5 integrity-check.
    const ftsBefore = captureFtsPhysicalState(sqlite)
    expect(ftsBefore.rows.length).toBeGreaterThan(0)
    expectFtsIntegrityOk(sqlite)
    const searchBefore = searchBlockIds(sqlite, 'updated body')

    expect(applyMigration004Only(db, sqlite)).toBe(1)

    // LOCK-002: the FTS virtual table was NOT rebuilt — rootpages and SQL
    // definitions identical, every document byte-identical, index still valid.
    const ftsAfter = captureFtsPhysicalState(sqlite)
    expect(ftsAfter.master).toEqual(ftsBefore.master)
    expect(ftsAfter.rows).toEqual(ftsBefore.rows)
    expectFtsIntegrityOk(sqlite)

    // The rebuilt normalized table is the rowid-identity schema, and the
    // gapped rowids were preserved (explicit-rowid copy; sqlite_sequence
    // seeded to MAX).
    const postCols = getColumnInfo(sqlite, 'message_blocks_normalized')
    expect(postCols.map((c) => c.name)).toEqual(['rowid', 'block_id', 'message_id', 'normalized_content'])
    expect(postCols.find((c) => c.name === 'rowid')?.pk).toBe(1)
    const maxRowid = (
      sqlite.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM message_blocks_normalized').get() as { n: number }
    ).n
    expect(maxRowid).toBeGreaterThan(0)

    // Full parity + search + count semantics preserved.
    expectRowidParity(sqlite)
    expectCountParity(sqlite)
    expect(searchBlockIds(sqlite, 'updated body')).toEqual(searchBefore)
    expect(searchBlockIds(sqlite, 'updated body')).toContain('b3')

    // sqlite_sequence seeded: a new insert takes MAX+1 and FTS rowid follows.
    sqlite.exec(
      `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b9', 'm2', 'main_text', 'Post gap insert', 1)`
    )
    const normRow = sqlite
      .prepare('SELECT rowid, block_id FROM message_blocks_normalized WHERE block_id = ?')
      .get('b9') as { rowid: number; block_id: string }
    const ftsRow = sqlite.prepare('SELECT rowid, block_id FROM message_blocks_fts WHERE block_id = ?').get('b9') as {
      rowid: number
      block_id: string
    }
    expect(normRow.rowid).toBe(maxRowid + 1)
    expect(ftsRow.rowid).toBe(normRow.rowid)
    expectRowidParity(sqlite)

    sqlite.close()
  })

  it('preflight: block_id drift at a matched rowid fails closed (typed error + full rollback)', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    applyMigrationsUpTo003(db, sqlite)
    seedLegacyData(sqlite)

    const ftsBefore = captureFtsPhysicalState(sqlite)
    const normalizedBefore = sqlite.prepare('SELECT * FROM message_blocks_normalized ORDER BY block_id').all()

    // Drift: FTS rowid 1 (block b1) now claims a different block_id. The
    // (rowid, block_id) identity no longer matches the normalized table.
    sqlite.exec(`UPDATE ${MESSAGE_BLOCKS_FTS_TABLE} SET block_id = 'drifted-block' WHERE rowid = 1`)
    expect(verifyFtsRowidParity(sqlite)).toMatchObject({
      ftsRowsWithoutNormalized: 0,
      blockIdMismatches: 1,
      normalizedRowCount: 2,
      ftsRowCount: 2
    })

    let thrown: unknown
    try {
      applyMigration004Only(db, sqlite)
    } catch (error) {
      thrown = error
    }
    // LOCK-003: precise typed migration error — never a raw SQLite error, and
    // never block IDs/content (count-only message).
    expect(thrown).toBeInstanceOf(MigrationFtsParityError)
    expect((thrown as Error).message).toContain('1 rowid-matched row(s) with a different block_id')
    expect((thrown as Error).message).not.toContain('drifted-block')

    // Full rollback: 004 unrecorded, FTS NOT silently repaired (drift
    // remains visible), normalized untouched, 003 triggers still installed.
    const state = (
      sqlite.prepare("SELECT COUNT(*) AS n FROM migration_state WHERE key = '004_fts_rowid_identity'").get() as {
        n: number
      }
    ).n
    expect(state).toBe(0)
    expect(captureFtsPhysicalState(sqlite).rows).toEqual(
      ftsBefore.rows.map((r) => (r.rowid === 1 ? { ...r, block_id: 'drifted-block' } : r))
    )
    expect(sqlite.prepare('SELECT * FROM message_blocks_normalized ORDER BY block_id').all()).toEqual(normalizedBefore)
    const triggers = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
      .all() as Array<{ name: string }>
    expect(triggers.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'message_blocks_normalized_insert',
        'message_blocks_normalized_update',
        'message_blocks_normalized_delete'
      ])
    )

    // Removing the drift source allows the migration to succeed (LOCK-003
    // fail-closed semantics; re-run resumes from the untouched state).
    sqlite.exec(`UPDATE ${MESSAGE_BLOCKS_FTS_TABLE} SET block_id = 'b1' WHERE rowid = 1`)
    expect(applyMigration004Only(db, sqlite)).toBe(1)
    expectRowidParity(sqlite)
    expectCountParity(sqlite)

    sqlite.close()
  })

  it('preflight: missing FTS document fails closed (typed error + full rollback)', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    applyMigrationsUpTo003(db, sqlite)
    seedLegacyData(sqlite)

    const b1Content = (
      sqlite.prepare('SELECT normalized_content FROM message_blocks_normalized WHERE rowid = 1').get() as {
        normalized_content: string
      }
    ).normalized_content

    // MISSING FTS document: delete rowid 1's FTS row.
    sqlite.exec(`DELETE FROM ${MESSAGE_BLOCKS_FTS_TABLE} WHERE rowid = 1`)
    expect(verifyFtsRowidParity(sqlite)).toMatchObject({ normalizedRowCount: 2, ftsRowCount: 1 })
    let thrown: unknown
    try {
      applyMigration004Only(db, sqlite)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(MigrationFtsParityError)
    expect((thrown as Error).message).toContain('2 normalized row(s) vs 1 FTS document(s)')
    expect(
      (
        sqlite.prepare("SELECT COUNT(*) AS n FROM migration_state WHERE key = '004_fts_rowid_identity'").get() as {
          n: number
        }
      ).n
    ).toBe(0)

    // Restore the missing document and re-run succeeds.
    sqlite
      .prepare(`INSERT INTO ${MESSAGE_BLOCKS_FTS_TABLE} (rowid, block_id, normalized_content) VALUES (1, 'b1', ?)`)
      .run(b1Content)
    expect(applyMigration004Only(db, sqlite)).toBe(1)
    expectRowidParity(sqlite)

    sqlite.close()
  })

  it('preflight: extra FTS document fails closed (typed error + full rollback)', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    applyMigrationsUpTo003(db, sqlite)
    seedLegacyData(sqlite)

    // EXTRA FTS document: an orphan rowid with no normalized partner.
    sqlite.exec(
      `INSERT INTO ${MESSAGE_BLOCKS_FTS_TABLE} (rowid, block_id, normalized_content) VALUES (9999, 'ghost', 'ghost')`
    )
    expect(verifyFtsRowidParity(sqlite)).toMatchObject({
      ftsRowsWithoutNormalized: 1,
      normalizedRowCount: 2,
      ftsRowCount: 3
    })
    let thrown: unknown
    try {
      applyMigration004Only(db, sqlite)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(MigrationFtsParityError)
    expect((thrown as Error).message).toContain('1 FTS document(s) with no normalized rowid')
    expect(
      (
        sqlite.prepare("SELECT COUNT(*) AS n FROM migration_state WHERE key = '004_fts_rowid_identity'").get() as {
          n: number
        }
      ).n
    ).toBe(0)

    // Remove the orphan and re-run succeeds.
    sqlite.exec(`DELETE FROM ${MESSAGE_BLOCKS_FTS_TABLE} WHERE rowid = 9999`)
    expect(applyMigration004Only(db, sqlite)).toBe(1)
    expectRowidParity(sqlite)

    sqlite.close()
  })

  it('preflight: duplicate block_id in FTS across rowids fails closed (typed error + full rollback)', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    applyMigrationsUpTo003(db, sqlite)
    seedLegacyData(sqlite)

    // A second FTS document for block b1 at an orphan rowid — the FTS side now
    // has duplicate block_id values (impossible in normalized, which has
    // block_id as PRIMARY KEY).
    sqlite.exec(
      `INSERT INTO ${MESSAGE_BLOCKS_FTS_TABLE} (rowid, block_id, normalized_content) VALUES (9998, 'b1', 'dup')`
    )

    let thrown: unknown
    try {
      runMigrations(db, sqlite)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(MigrationFtsParityError)
    expect(
      (
        sqlite.prepare("SELECT COUNT(*) AS n FROM migration_state WHERE key = '004_fts_rowid_identity'").get() as {
          n: number
        }
      ).n
    ).toBe(0)
    expect(sqlite.prepare('SELECT * FROM message_blocks_fts WHERE rowid = 9998').get()).toBeDefined()

    sqlite.close()
  })

  it('preflight: jointly stale projections (canonical MAIN_TEXT count drift) fail closed', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    applyMigrationsUpTo003(db, sqlite)
    seedLegacyData(sqlite)

    // JOINTLY STALE projections: drop the sync triggers, insert a canonical
    // MAIN_TEXT row with no projection, then reinstall the triggers. Both
    // derived tables now agree with each other (2 == 2) but disagree with the
    // canonical source (3) — a drift the old preflight could not see.
    sqlite.exec(`DROP TRIGGER IF EXISTS message_blocks_normalized_insert`)
    sqlite.exec(`DROP TRIGGER IF EXISTS message_blocks_normalized_update`)
    sqlite.exec(`DROP TRIGGER IF EXISTS message_blocks_normalized_delete`)
    sqlite.exec(
      `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b5', 'm1', 'main_text', 'Jointly stale projection body', 2)`
    )
    sqlite.exec(MIGRATION_003_CREATE_MESSAGE_BLOCKS_NORMALIZED_INSERT_TRIGGER_SQL)
    sqlite.exec(MIGRATION_003_CREATE_MESSAGE_BLOCKS_NORMALIZED_UPDATE_TRIGGER_SQL)
    sqlite.exec(MIGRATION_003_CREATE_MESSAGE_BLOCKS_NORMALIZED_DELETE_TRIGGER_SQL)

    // The structural checks pass — only the canonical count exposes the drift.
    expect(verifyFtsRowidParity(sqlite)).toMatchObject({
      ftsRowsWithoutNormalized: 0,
      blockIdMismatches: 0,
      normalizedContentMismatches: 0,
      normalizedRowCount: 2,
      ftsRowCount: 2,
      canonicalMainTextRowCount: 3
    })

    let thrown: unknown
    try {
      applyMigration004Only(db, sqlite)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(MigrationFtsParityError)
    expect((thrown as Error).message).toContain('3 canonical MAIN_TEXT row(s) vs 2 normalized row(s)')
    expect(
      (
        sqlite.prepare("SELECT COUNT(*) AS n FROM migration_state WHERE key = '004_fts_rowid_identity'").get() as {
          n: number
        }
      ).n
    ).toBe(0)

    // Remove the stale canonical row (reinstalled delete trigger fires, has
    // no projection to remove) and the migration succeeds.
    sqlite.exec(`DELETE FROM message_blocks WHERE id = 'b5'`)
    expect(applyMigration004Only(db, sqlite)).toBe(1)
    expectRowidParity(sqlite)
    expectCountParity(sqlite)

    sqlite.close()
  })

  it('preflight: normalized content drift at a matched rowid fails closed', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    applyMigrationsUpTo003(db, sqlite)
    seedLegacyData(sqlite)

    // Capture the pre-drift normalized content so the restore is exact.
    const b1Content = (
      sqlite.prepare('SELECT normalized_content FROM message_blocks_normalized WHERE rowid = 1').get() as {
        normalized_content: string
      }
    ).normalized_content

    // CONTENT DRIFT: rowid 1 keeps matching block_id 'b1' but its FTS
    // normalized content no longer equals the normalized table's content.
    // rowid/block_id identity and counts all still agree.
    sqlite.exec(
      `UPDATE ${MESSAGE_BLOCKS_FTS_TABLE} SET normalized_content = 'completely different content' WHERE rowid = 1`
    )
    expect(verifyFtsRowidParity(sqlite)).toMatchObject({
      ftsRowsWithoutNormalized: 0,
      blockIdMismatches: 0,
      normalizedContentMismatches: 1,
      normalizedRowCount: 2,
      ftsRowCount: 2,
      canonicalMainTextRowCount: 2
    })

    let thrown: unknown
    try {
      applyMigration004Only(db, sqlite)
    } catch (error) {
      thrown = error
    }
    // Typed, count-only message: no content ever leaks into the outward error.
    expect(thrown).toBeInstanceOf(MigrationFtsParityError)
    expect((thrown as Error).message).toContain('1 rowid-matched row(s) with different normalized content')
    expect((thrown as Error).message).not.toContain('completely different')
    expect(
      (
        sqlite.prepare("SELECT COUNT(*) AS n FROM migration_state WHERE key = '004_fts_rowid_identity'").get() as {
          n: number
        }
      ).n
    ).toBe(0)

    // Restoring the content and re-running succeeds.
    sqlite.prepare(`UPDATE ${MESSAGE_BLOCKS_FTS_TABLE} SET normalized_content = ? WHERE rowid = 1`).run(b1Content)
    expect(applyMigration004Only(db, sqlite)).toBe(1)
    expectRowidParity(sqlite)

    sqlite.close()
  })

  it('preflight: FTS projection not MATCH-queryable (broken index) fails closed with the cause preserved', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    applyMigrationsUpTo003(db, sqlite)
    seedLegacyData(sqlite)

    // BROKEN FTS: replace the FTS5 virtual table with a plain table of the
    // same name carrying the same (rowid, block_id, normalized_content) rows.
    // Every structural/count check passes; only the MATCH smoke (LOCK-SP-4)
    // can see that the object is not a queryable FTS index.
    sqlite.exec(`DROP TABLE ${MESSAGE_BLOCKS_FTS_TABLE}`)
    sqlite.exec(
      `CREATE TABLE ${MESSAGE_BLOCKS_FTS_TABLE} (rowid INTEGER PRIMARY KEY, block_id TEXT, normalized_content TEXT)`
    )
    sqlite.exec(
      `INSERT INTO ${MESSAGE_BLOCKS_FTS_TABLE} (rowid, block_id, normalized_content) VALUES (1, 'b1', 'hello world')`
    )

    let thrown: unknown
    try {
      runMigrations(db, sqlite)
    } catch (error) {
      thrown = error
    }
    // Typed failure, count-only outward message.
    expect(thrown).toBeInstanceOf(MigrationFtsParityError)
    expect((thrown as Error).message).toContain('missing or unreadable')
    // The raw SQLite error is preserved on `cause` (never logged/rendered into
    // the outward message — LOCK-PRIV).
    const cause = (thrown as Error & { cause?: Error }).cause
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message.length).toBeGreaterThan(0)
    expect((thrown as Error).message).not.toContain((cause as Error).message)
    expect(
      (
        sqlite.prepare("SELECT COUNT(*) AS n FROM migration_state WHERE key = '004_fts_rowid_identity'").get() as {
          n: number
        }
      ).n
    ).toBe(0)
    // The replacement object is left untouched (no silent repair).
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM message_blocks_fts').get()).toEqual({ n: 1 })

    sqlite.close()
  })

  it('preflight: malformed pre-state (missing FTS table) fails closed with a typed error', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    applyMigrationsUpTo003(db, sqlite)
    seedLegacyData(sqlite)

    // Malformed pre-state: the derived FTS projection is gone entirely.
    sqlite.exec(`DROP TRIGGER IF EXISTS message_blocks_normalized_insert`)
    sqlite.exec(`DROP TRIGGER IF EXISTS message_blocks_normalized_update`)
    sqlite.exec(`DROP TRIGGER IF EXISTS message_blocks_normalized_delete`)
    sqlite.exec(`DROP TABLE ${MESSAGE_BLOCKS_FTS_TABLE}`)

    let thrown: unknown
    try {
      runMigrations(db, sqlite)
    } catch (error) {
      thrown = error
    }
    // Typed failure — the raw "no such table" SQLite error must NOT escape.
    expect(thrown).toBeInstanceOf(MigrationFtsParityError)
    expect((thrown as Error).message).toContain('missing or unreadable')
    expect(
      (
        sqlite.prepare("SELECT COUNT(*) AS n FROM migration_state WHERE key = '004_fts_rowid_identity'").get() as {
          n: number
        }
      ).n
    ).toBe(0)
    // The normalized projection and canonical data are untouched.
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM message_blocks_normalized').get() as { n: number }).toMatchObject({
      n: 2
    })

    sqlite.close()
  })

  it('preflight query plans are bounded: single scan + indexed rowid probes (no nested-loop FTS block_id scan)', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    applyMigrationsUpTo003(db, sqlite)
    seedLegacyData(sqlite)

    const ftsOuterPlan = (
      sqlite.prepare(`EXPLAIN QUERY PLAN ${MIGRATION_004_PARITY_FTS_OUTER_SQL}`).all() as Array<{ detail: string }>
    )
      .map((r) => r.detail)
      .join('\n')
    // FTS outer: scan the FTS virtual table once (block_id is UNINDEXED, so a
    // full virtual-table scan is unavoidable), then probe normalized by
    // INTEGER PRIMARY KEY rowid — an indexed SEARCH per row, NEVER a
    // nested-loop scan of normalized (which would be O(n²)).
    expect(ftsOuterPlan).toContain('SCAN f VIRTUAL TABLE')
    expect(ftsOuterPlan).toContain('SEARCH n USING INTEGER PRIMARY KEY')
    expect(ftsOuterPlan).not.toContain('SCAN n')

    const normalizedCountPlan = (
      sqlite.prepare(`EXPLAIN QUERY PLAN ${MIGRATION_004_PARITY_NORMALIZED_COUNT_SQL}`).all() as Array<{
        detail: string
      }>
    )
      .map((r) => r.detail)
      .join('\n')
    // Normalized count: a single covering-index scan — no content reads, no
    // FTS interaction.
    expect(normalizedCountPlan).toContain('SCAN message_blocks_normalized')
    expect(normalizedCountPlan).not.toContain('message_blocks_fts')

    const ftsCountPlan = (
      sqlite.prepare(`EXPLAIN QUERY PLAN ${MIGRATION_004_PARITY_FTS_COUNT_SQL}`).all() as Array<{ detail: string }>
    )
      .map((r) => r.detail)
      .join('\n')
    // FTS count: a single virtual-table scan (docid iteration) — bounded,
    // never a per-row nested scan.
    expect(ftsCountPlan).toContain('SCAN message_blocks_fts')
    expect(ftsCountPlan).toContain('VIRTUAL TABLE')
    expect(ftsCountPlan).not.toContain('SEARCH')

    const canonicalCountPlan = (
      sqlite.prepare(`EXPLAIN QUERY PLAN ${MIGRATION_004_PARITY_CANONICAL_COUNT_SQL}`).all() as Array<{
        detail: string
      }>
    )
      .map((r) => r.detail)
      .join('\n')
    // Canonical count: a plain b-tree scan of message_blocks — no FTS
    // interaction at all (the jointly-stale check adds no FTS cost).
    expect(canonicalCountPlan).toContain('SCAN message_blocks')
    expect(canonicalCountPlan).not.toContain('message_blocks_fts')

    const ftsSmokePlan = (
      sqlite.prepare(`EXPLAIN QUERY PLAN ${MIGRATION_004_FTS_SMOKE_SQL}`).all(FTS_SMOKE_TOKEN) as Array<{
        detail: string
      }>
    )
      .map((r) => r.detail)
      .join('\n')
    // FTS smoke: a bounded trigram-index lookup (MATCH operator), NOT a full
    // virtual-table scan and no normalized interaction — the only extra cost
    // beyond the single parity outer scan (LOCK-001).
    expect(ftsSmokePlan).toContain('message_blocks_fts')
    expect(ftsSmokePlan).toContain('VIRTUAL TABLE')
    expect(ftsSmokePlan).not.toContain('message_blocks_normalized')

    sqlite.close()
  })
})
