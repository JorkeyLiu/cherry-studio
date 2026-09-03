/**
 * Candidate-only deferred FTS/normalized search projection — focused real
 * better-sqlite3 tests (LOCK-FTS-1..7).
 *
 * Coverage:
 * - Object inventory: migrations create the normalized table + index +
 *   FTS table + 3 sync triggers (LOCK-FTS-2/6).
 * - Migration assembly identity: migration 003 is frozen (MIGRATION_003_*
 *   constants); migration 004 and DERIVED_PROJECTION_REBUILD_SQL are
 *   assembled from the exported shared constants — no duplicated strings,
 *   no array index reliance (LOCK-FTS-2).
 * - Migration equivalence: a migration-004-applied DB and a
 *   deferred+rebuilt DB produce byte-identical derived-object schemas and
 *   identical behavioral results after identical post-rebuild writes
 *   (LOCK-FTS-6).
 * - Drop order + deferral inventory (LOCK-FTS-3): defer() removes triggers
 *   → FTS → normalized (+ its index) atomically; message_blocks intact;
 *   migration_state 004 remains recorded.
 * - Canonical writes while deferred (LOCK-FTS-3): page-style inserts
 *   succeed with ZERO derived rows written.
 * - Rebuild + trigger restoration (LOCK-FTS-4/6): counts match the
 *   canonical MAIN_TEXT/content-not-null source; insert/update/delete
 *   triggers maintain the projection exactly like a trigger-maintained DB.
 * - Atomic rollback (LOCK-FTS-4): a forced backfill failure rolls back the
 *   entire rebuild (derived objects stay absent, message_blocks intact)
 *   and the helper enters the terminal failed state.
 * - Count/search parity (LOCK-FTS-6/7): rebuilt projection counts equal the
 *   canonical source; SearchRepository results on a rebuilt DB equal a
 *   trigger-maintained DB for the same data.
 * - Exactly-once / state misuse (LOCK-FTS-5): defer twice, rebuild before
 *   defer, rebuild twice, defer after rebuild, and any call after a failure
 *   all throw; independent helpers (sessions) hold independent state.
 */

import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

vi.mock('@main/config', () => ({ DATA_PATH: '/mock/data' }))

import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import {
  BACKFILL_MESSAGE_BLOCKS_FTS_SQL,
  BACKFILL_MESSAGE_BLOCKS_NORMALIZED_SQL,
  CREATE_MESSAGE_BLOCKS_FTS_SQL,
  CREATE_MESSAGE_BLOCKS_NORMALIZED_DELETE_TRIGGER_SQL,
  CREATE_MESSAGE_BLOCKS_NORMALIZED_INSERT_TRIGGER_SQL,
  CREATE_MESSAGE_BLOCKS_NORMALIZED_MESSAGE_ID_INDEX_SQL,
  CREATE_MESSAGE_BLOCKS_NORMALIZED_SQL,
  CREATE_MESSAGE_BLOCKS_NORMALIZED_UPDATE_TRIGGER_SQL,
  DERIVED_PROJECTION_REBUILD_SQL,
  MESSAGE_BLOCKS_FTS_TABLE,
  MESSAGE_BLOCKS_NORMALIZED_DELETE_TRIGGER,
  MESSAGE_BLOCKS_NORMALIZED_INSERT_TRIGGER,
  MESSAGE_BLOCKS_NORMALIZED_MESSAGE_ID_INDEX,
  MESSAGE_BLOCKS_NORMALIZED_TABLE,
  MESSAGE_BLOCKS_NORMALIZED_UPDATE_TRIGGER,
  MIGRATION_003_BACKFILL_MESSAGE_BLOCKS_FTS_SQL,
  MIGRATION_003_BACKFILL_MESSAGE_BLOCKS_NORMALIZED_SQL,
  MIGRATION_003_CREATE_MESSAGE_BLOCKS_FTS_SQL,
  MIGRATION_003_CREATE_MESSAGE_BLOCKS_NORMALIZED_DELETE_TRIGGER_SQL,
  MIGRATION_003_CREATE_MESSAGE_BLOCKS_NORMALIZED_INSERT_TRIGGER_SQL,
  MIGRATION_003_CREATE_MESSAGE_BLOCKS_NORMALIZED_MESSAGE_ID_INDEX_SQL,
  MIGRATION_003_CREATE_MESSAGE_BLOCKS_NORMALIZED_SQL,
  MIGRATION_003_CREATE_MESSAGE_BLOCKS_NORMALIZED_UPDATE_TRIGGER_SQL,
  MIGRATIONS,
  registerChatDbNormalize,
  runMigrations
} from '../../chatDb/migration'
import { SearchRepository } from '../../chatDb/repository/SearchRepository'
import * as schema from '../../chatDb/schema'
import { CandidateFtsProjection, CandidateFtsProjectionError } from '../ftsProjection'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-fts-projection-'))
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
  registerChatDbNormalize(db)
  return db
}

function wrapDrizzle(sqlite: Database.Database): BetterSQLite3Database<typeof schema> {
  return drizzle(sqlite, { schema })
}

function applyAllMigrations(sqlite: Database.Database): number {
  return runMigrations(wrapDrizzle(sqlite), sqlite)
}

function tableNames(sqlite: Database.Database): string[] {
  return (
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name)
}

function derivedMasterRows(sqlite: Database.Database): Array<{ name: string; type: string; sql: string | null }> {
  return sqlite
    .prepare('SELECT name, type, sql FROM sqlite_master WHERE name IN (?, ?, ?, ?, ?, ?) ORDER BY name')
    .all(
      MESSAGE_BLOCKS_NORMALIZED_TABLE,
      MESSAGE_BLOCKS_NORMALIZED_MESSAGE_ID_INDEX,
      MESSAGE_BLOCKS_FTS_TABLE,
      MESSAGE_BLOCKS_NORMALIZED_INSERT_TRIGGER,
      MESSAGE_BLOCKS_NORMALIZED_UPDATE_TRIGGER,
      MESSAGE_BLOCKS_NORMALIZED_DELETE_TRIGGER
    ) as Array<{ name: string; type: string; sql: string | null }>
}

/** Fixed derived-object inventory expected after migration 003 (or rebuild). */
function expectDerivedPresent(sqlite: Database.Database): void {
  const rows = derivedMasterRows(sqlite)
  const byName = new Map(rows.map((r) => [r.name, r]))
  expect(byName.get(MESSAGE_BLOCKS_NORMALIZED_TABLE)?.type).toBe('table')
  expect(byName.get(MESSAGE_BLOCKS_FTS_TABLE)?.type).toBe('table')
  expect(byName.get(MESSAGE_BLOCKS_NORMALIZED_MESSAGE_ID_INDEX)?.type).toBe('index')
  expect(byName.get(MESSAGE_BLOCKS_NORMALIZED_INSERT_TRIGGER)?.type).toBe('trigger')
  expect(byName.get(MESSAGE_BLOCKS_NORMALIZED_UPDATE_TRIGGER)?.type).toBe('trigger')
  expect(byName.get(MESSAGE_BLOCKS_NORMALIZED_DELETE_TRIGGER)?.type).toBe('trigger')
}

/** Fixed derived-object inventory expected after defer(): all absent. */
function expectDerivedAbsent(sqlite: Database.Database): void {
  expect(derivedMasterRows(sqlite)).toEqual([])
}

function seedCanonicalData(sqlite: Database.Database): void {
  sqlite.exec(`INSERT INTO topics (id, name, created_at) VALUES ('t1', 'Test', '2026-01-01T00:00:00.000Z')`)
  sqlite.exec(
    `INSERT INTO messages (id, topic_id, role, content, created_at, sort_order) VALUES ('m1', 't1', 'user', 'Hello', '2026-01-01T00:01:00.000Z', 0)`
  )
  sqlite.exec(
    `INSERT INTO messages (id, topic_id, role, content, created_at, sort_order) VALUES ('m2', 't1', 'user', 'World', '2026-01-01T00:02:00.000Z', 1)`
  )
  sqlite.exec(
    `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b1', 'm1', 'main_text', 'Hello world content', 0)`
  )
  sqlite.exec(
    `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b2', 'm1', 'main_text', NULL, 1)`
  )
  sqlite.exec(
    `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b3', 'm2', 'main_text', 'Second message body', 0)`
  )
  sqlite.exec(
    `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b4', 'm2', 'file', null, 1)`
  )
}

/** Canonical MAIN_TEXT/content-not-null source count for seedCanonicalData. */
const SEED_EXPECTED_NORMALIZED_COUNT = 2 // b1 + b3

/** Shared post-rebuild writes: identical on trigger-maintained and rebuilt DBs. */
function applyPostRebuildWrites(sqlite: Database.Database): void {
  // Insert a new MAIN_TEXT block → projection row + FTS row.
  sqlite.exec(
    `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b5', 'm2', 'main_text', 'After rebuild insert', 2)`
  )
  // Update content → normalized_content refresh.
  sqlite.exec(`UPDATE message_blocks SET content = 'Updated body text' WHERE id = 'b3'`)
  // Type transition to non-MAIN_TEXT → projection row deleted.
  sqlite.exec(`UPDATE message_blocks SET type = 'file' WHERE id = 'b1'`)
  // Delete a block → projection row removed.
  sqlite.exec(`DELETE FROM message_blocks WHERE id = 'b2'`)
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('CandidateFtsProjection — deferred search projection maintenance', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
  })

  afterEach(() => {
    rmrf(tempDir)
  })

  // -------------------------------------------------------------------------
  // LOCK-FTS-2: single source of truth + migration equivalence
  // -------------------------------------------------------------------------

  it('migration 004 creates the full derived-object inventory (LOCK-FTS-2/6)', () => {
    const sqlite = openTestDb(realPath.join(tempDir, 'chat.db'))
    const applied = applyAllMigrations(sqlite)
    expect(applied).toBe(6)

    expectDerivedPresent(sqlite)
    expect(tableNames(sqlite)).toContain(MESSAGE_BLOCKS_NORMALIZED_TABLE)
    expect(tableNames(sqlite)).toContain(MESSAGE_BLOCKS_FTS_TABLE)

    sqlite.close()
  })

  it('migration 003 is frozen; migration 004 + rebuild are assembled from the shared constants (LOCK-FTS-2)', () => {
    const m003 = MIGRATIONS.find((m) => m.key === '003_fts5_normalized_search')
    expect(m003).toBeDefined()
    // Frozen migration 003 stays byte-identical to its released statements.
    expect(m003!.sql).toEqual([
      MIGRATION_003_CREATE_MESSAGE_BLOCKS_NORMALIZED_SQL,
      MIGRATION_003_CREATE_MESSAGE_BLOCKS_NORMALIZED_MESSAGE_ID_INDEX_SQL,
      MIGRATION_003_CREATE_MESSAGE_BLOCKS_FTS_SQL,
      MIGRATION_003_BACKFILL_MESSAGE_BLOCKS_NORMALIZED_SQL,
      MIGRATION_003_BACKFILL_MESSAGE_BLOCKS_FTS_SQL,
      MIGRATION_003_CREATE_MESSAGE_BLOCKS_NORMALIZED_INSERT_TRIGGER_SQL,
      MIGRATION_003_CREATE_MESSAGE_BLOCKS_NORMALIZED_UPDATE_TRIGGER_SQL,
      MIGRATION_003_CREATE_MESSAGE_BLOCKS_NORMALIZED_DELETE_TRIGGER_SQL
    ])

    const m004 = MIGRATIONS.find((m) => m.key === '004_fts_rowid_identity')
    expect(m004).toBeDefined()
    // Migration 004 uses the rowid-identity create/backfill/trigger constants
    // for the NORMALIZED table only (LOCK-002): the existing-003 path never
    // drops/recreates/backfills the FTS virtual table — parity-verified
    // preflight keeps it physically intact, then only normalized is rebuilt
    // and the current triggers are installed.
    expect(m004!.sql).toEqual([
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
    ])
    // LOCK-002: the 004 SQL body never REBUILDS the FTS table — no DROP, no
    // CREATE VIRTUAL TABLE, and no FTS BACKFILL constant (the rowid-addressable
    // triggers still legitimately reference message_blocks_fts in their bodies,
    // including their per-row INSERT).
    const m004SqlJoined = m004!.sql.join(' ')
    expect(m004SqlJoined).not.toContain('DROP TABLE IF EXISTS message_blocks_fts')
    expect(m004SqlJoined).not.toContain('CREATE VIRTUAL TABLE')
    expect(m004!.sql).not.toContain(CREATE_MESSAGE_BLOCKS_FTS_SQL)
    expect(m004!.sql).not.toContain(BACKFILL_MESSAGE_BLOCKS_FTS_SQL)
    // LOCK-001/003: 004 carries a parity preflight wired into runMigrations.
    expect(typeof m004!.preflight).toBe('function')

    // LOCK-004: the import-candidate rebuild path STILL creates/backfills the
    // current normalized+FTS schema from scratch where the projection was
    // deliberately deferred — never a no-op.
    expect(DERIVED_PROJECTION_REBUILD_SQL).toContain(CREATE_MESSAGE_BLOCKS_NORMALIZED_SQL)
    expect(DERIVED_PROJECTION_REBUILD_SQL).toContain(CREATE_MESSAGE_BLOCKS_FTS_SQL)
    expect(DERIVED_PROJECTION_REBUILD_SQL).toContain(BACKFILL_MESSAGE_BLOCKS_NORMALIZED_SQL)
    expect(DERIVED_PROJECTION_REBUILD_SQL).toContain(BACKFILL_MESSAGE_BLOCKS_FTS_SQL)

    // Rebuild = drops + the same rowid-identity create/backfill/trigger
    // constants in order (single source of truth, migration-004 generation).
    expect(DERIVED_PROJECTION_REBUILD_SQL.slice(5)).toEqual([
      CREATE_MESSAGE_BLOCKS_NORMALIZED_SQL,
      CREATE_MESSAGE_BLOCKS_NORMALIZED_MESSAGE_ID_INDEX_SQL,
      CREATE_MESSAGE_BLOCKS_FTS_SQL,
      BACKFILL_MESSAGE_BLOCKS_NORMALIZED_SQL,
      BACKFILL_MESSAGE_BLOCKS_FTS_SQL,
      CREATE_MESSAGE_BLOCKS_NORMALIZED_INSERT_TRIGGER_SQL,
      CREATE_MESSAGE_BLOCKS_NORMALIZED_UPDATE_TRIGGER_SQL,
      CREATE_MESSAGE_BLOCKS_NORMALIZED_DELETE_TRIGGER_SQL
    ])
  })

  it('a deferred+rebuilt DB is schema- and behavior-equivalent to a migration-004-applied DB (LOCK-FTS-6)', () => {
    // DB-A: trigger-maintained (migrations 001-004).
    const sqliteA = openTestDb(realPath.join(tempDir, 'a.db'))
    applyAllMigrations(sqliteA)
    seedCanonicalData(sqliteA)

    // DB-B: deferred during writes, rebuilt before seal (candidate flow).
    const sqliteB = openTestDb(realPath.join(tempDir, 'b.db'))
    applyAllMigrations(sqliteB)
    const helperB = new CandidateFtsProjection()
    helperB.defer(sqliteB)
    expectDerivedAbsent(sqliteB)
    seedCanonicalData(sqliteB)
    helperB.rebuild()

    // Byte-identical derived-object schemas (LOCK-FTS-6: rebuild reproduces
    // the exact migration-004 applied schema).
    const masterA = derivedMasterRows(sqliteA)
    const masterB = derivedMasterRows(sqliteB)
    expect(masterA).toEqual(masterB)

    // Identical derived content BEFORE post-writes.
    for (const table of [MESSAGE_BLOCKS_NORMALIZED_TABLE, MESSAGE_BLOCKS_FTS_TABLE]) {
      expect((sqliteA.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(
        SEED_EXPECTED_NORMALIZED_COUNT
      )
      expect((sqliteB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(
        SEED_EXPECTED_NORMALIZED_COUNT
      )
    }

    // Identical post-rebuild trigger maintenance (LOCK-FTS-6).
    applyPostRebuildWrites(sqliteA)
    applyPostRebuildWrites(sqliteB)
    for (const table of [MESSAGE_BLOCKS_NORMALIZED_TABLE, MESSAGE_BLOCKS_FTS_TABLE]) {
      expect((sqliteA.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(2) // b3 (updated) + b5 (inserted); b1/b2 removed
      expect((sqliteB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(2)
    }
    const normA = sqliteA
      .prepare('SELECT block_id, normalized_content FROM message_blocks_normalized ORDER BY block_id')
      .all()
    const normB = sqliteB
      .prepare('SELECT block_id, normalized_content FROM message_blocks_normalized ORDER BY block_id')
      .all()
    expect(normB).toEqual(normA)

    sqliteA.close()
    sqliteB.close()
  })

  // -------------------------------------------------------------------------
  // LOCK-FTS-3: deferral — drop order, inventory, canonical writes
  // -------------------------------------------------------------------------

  it('defer() drops triggers → FTS → normalized atomically; message_blocks intact; migration_state kept (LOCK-FTS-3)', () => {
    const sqlite = openTestDb(realPath.join(tempDir, 'chat.db'))
    applyAllMigrations(sqlite)
    seedCanonicalData(sqlite) // seed through triggers first

    const helper = new CandidateFtsProjection()
    expect(helper.getState()).toBe('idle')
    helper.defer(sqlite)
    expect(helper.getState()).toBe('deferred')

    // All derived objects absent — including the message_id index which
    // auto-drops with the normalized table (LOCK-FTS-3 drop order).
    expectDerivedAbsent(sqlite)

    // Canonical tables untouched.
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM message_blocks').get() as { n: number }).n).toBe(4)
    // migration_state 004 remains recorded: explicit rebuild is mandatory.
    expect(
      (
        sqlite.prepare("SELECT COUNT(*) AS n FROM migration_state WHERE key = '004_fts_rowid_identity'").get() as {
          n: number
        }
      ).n
    ).toBe(1)

    sqlite.close()
  })

  it('canonical writes while deferred succeed with ZERO derived rows (LOCK-FTS-3)', () => {
    const sqlite = openTestDb(realPath.join(tempDir, 'chat.db'))
    applyAllMigrations(sqlite)
    const helper = new CandidateFtsProjection()
    helper.defer(sqlite)

    seedCanonicalData(sqlite) // page-style inserts while deferred

    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM message_blocks').get() as { n: number }).n).toBe(4)
    // No triggers, no tables → no projection rows could have been written.
    expect(derivedMasterRows(sqlite)).toEqual([])

    sqlite.close()
  })

  // -------------------------------------------------------------------------
  // LOCK-FTS-4: rebuild — counts, trigger restoration, atomic rollback
  // -------------------------------------------------------------------------

  it('rebuild() restores counts from canonical MAIN_TEXT/content-not-null rows (LOCK-FTS-4/7)', () => {
    const sqlite = openTestDb(realPath.join(tempDir, 'chat.db'))
    applyAllMigrations(sqlite)
    const helper = new CandidateFtsProjection()
    helper.defer(sqlite)
    seedCanonicalData(sqlite)
    helper.rebuild()
    expect(helper.getState()).toBe('rebuilt')

    expectDerivedPresent(sqlite)
    // Count parity: normalized + FTS equal the canonical source rows
    // (2 of 4 blocks are main_text with non-null content).
    const canonical = (
      sqlite
        .prepare("SELECT COUNT(*) AS n FROM message_blocks WHERE type = 'main_text' AND content IS NOT NULL")
        .get() as { n: number }
    ).n
    expect(canonical).toBe(SEED_EXPECTED_NORMALIZED_COUNT)
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM message_blocks_normalized').get() as { n: number }).n).toBe(
      canonical
    )
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM message_blocks_fts').get() as { n: number }).n).toBe(canonical)

    // Normalized content correctness (markdown/CRLF normalization applied).
    const b1 = sqlite
      .prepare('SELECT normalized_content FROM message_blocks_normalized WHERE block_id = ?')
      .get('b1') as {
      normalized_content: string
    }
    expect(b1.normalized_content).toBe('hello world content')

    sqlite.close()
  })

  it('post-rebuild INSERT/UPDATE/DELETE triggers restore trigger-maintained semantics (LOCK-FTS-6)', () => {
    const sqlite = openTestDb(realPath.join(tempDir, 'chat.db'))
    applyAllMigrations(sqlite)
    const helper = new CandidateFtsProjection()
    helper.defer(sqlite)
    seedCanonicalData(sqlite)
    helper.rebuild()

    // INSERT main_text → projection row + FTS row.
    sqlite.exec(
      `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b5', 'm2', 'main_text', 'New content', 3)`
    )
    const inserted = sqlite
      .prepare('SELECT normalized_content FROM message_blocks_normalized WHERE block_id = ?')
      .get('b5') as {
      normalized_content: string
    }
    expect(inserted.normalized_content).toBe('new content')
    expect(sqlite.prepare('SELECT * FROM message_blocks_fts WHERE block_id = ?').get('b5')).toBeDefined()

    // INSERT non-main_text → no projection row.
    sqlite.exec(
      `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b6', 'm1', 'file', null, 4)`
    )
    expect(sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b6')).toBeUndefined()

    // UPDATE content → normalized_content refresh.
    sqlite.exec(`UPDATE message_blocks SET content = 'Changed text' WHERE id = 'b5'`)
    const updated = sqlite
      .prepare('SELECT normalized_content FROM message_blocks_normalized WHERE block_id = ?')
      .get('b5') as {
      normalized_content: string
    }
    expect(updated.normalized_content).toBe('changed text')

    // UPDATE type to non-main_text → projection row deleted.
    sqlite.exec(`UPDATE message_blocks SET type = 'file' WHERE id = 'b5'`)
    expect(sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b5')).toBeUndefined()

    // DELETE → projection row removed.
    sqlite.exec(`DELETE FROM message_blocks WHERE id = 'b3'`)
    expect(sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b3')).toBeUndefined()

    sqlite.close()
  })

  it('a failed rebuild rolls back atomically and fails closed (LOCK-FTS-4)', () => {
    const sqlite = openTestDb(realPath.join(tempDir, 'chat.db'))
    applyAllMigrations(sqlite)
    const helper = new CandidateFtsProjection()
    helper.defer(sqlite)
    seedCanonicalData(sqlite)
    expectDerivedAbsent(sqlite)

    // Force the backfill to fail mid-transaction: chatdb_normalize throws.
    // NOTE: the override must keep the SAME arity as the registered scalar
    // (1 param); a zero-arity re-registration is silently ignored by
    // better-sqlite3 and would NOT fail the backfill.
    sqlite.function('chatdb_normalize', (content: string | null) => {
      throw new Error(`normalize boom: ${typeof content}`)
    })

    let thrown: unknown
    try {
      helper.rebuild()
    } catch (error) {
      thrown = error
    }
    // The helper fails closed with a FIXED phase context (LOCK-PRIV): the
    // message never carries content/IDs/SQL details.
    expect(thrown).toBeInstanceOf(CandidateFtsProjectionError)
    expect((thrown as Error).message).toBe('Candidate FTS projection rebuild failed (candidate must be discarded)')
    expect((thrown as Error).message).not.toContain('normalize boom')
    expect(helper.getState()).toBe('failed')

    // Atomic rollback: the DDL drops/creates are rolled back with the failed
    // backfill — the candidate is still fully deferred (never partially
    // rebuilt), and canonical message_blocks are untouched.
    expectDerivedAbsent(sqlite)
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM message_blocks').get() as { n: number }).n).toBe(4)

    // Fail closed: no further transition from the terminal failed state.
    expect(() => helper.rebuild()).toThrow(/failed/)
    expect(() => helper.defer(sqlite)).toThrow(/failed/)

    sqlite.close()
  })

  // -------------------------------------------------------------------------
  // LOCK-FTS-7: search projection parity
  // -------------------------------------------------------------------------

  it('search results on a rebuilt DB match a trigger-maintained DB (LOCK-FTS-6/7)', () => {
    const sqliteA = openTestDb(realPath.join(tempDir, 'a.db'))
    applyAllMigrations(sqliteA)
    seedCanonicalData(sqliteA)

    const sqliteB = openTestDb(realPath.join(tempDir, 'b.db'))
    applyAllMigrations(sqliteB)
    const helperB = new CandidateFtsProjection()
    helperB.defer(sqliteB)
    seedCanonicalData(sqliteB)
    helperB.rebuild()

    const repoA = new SearchRepository(sqliteA)
    const repoB = new SearchRepository(sqliteB)
    const queries = [
      { keywords: 'hello', matchMode: 'substring' as const },
      { keywords: 'world content', matchMode: 'substring' as const },
      { keywords: 'second message', matchMode: 'substring' as const },
      { keywords: 'second', matchMode: 'whole-word' as const }
    ]
    for (const q of queries) {
      const resultA = repoA.search({ keywords: q.keywords, matchMode: q.matchMode, sortOrder: 'newest', pageSize: 100 })
      const resultB = repoB.search({ keywords: q.keywords, matchMode: q.matchMode, sortOrder: 'newest', pageSize: 100 })
      expect(resultB.items.map((i) => i.blockId)).toEqual(resultA.items.map((i) => i.blockId))
      expect(resultB.hasMore).toBe(resultA.hasMore)
    }

    sqliteA.close()
    sqliteB.close()
  })

  // -------------------------------------------------------------------------
  // LOCK-FTS-5: exactly-once / state misuse / independent sessions
  // -------------------------------------------------------------------------

  it('cannot rebuild before deferral, defer twice, or rebuild twice (LOCK-FTS-5)', () => {
    const sqlite = openTestDb(realPath.join(tempDir, 'chat.db'))
    applyAllMigrations(sqlite)

    const helper = new CandidateFtsProjection()
    // Rebuild before deferral is forbidden.
    expect(() => helper.rebuild()).toThrow(/deferred/)

    helper.defer(sqlite)
    // Defer twice is forbidden.
    expect(() => helper.defer(sqlite)).toThrow(/already deferred/)

    helper.rebuild()
    // Rebuild twice is forbidden.
    expect(() => helper.rebuild()).toThrow(/deferred/)
    // Defer after rebuild is forbidden.
    expect(() => helper.defer(sqlite)).toThrow(/already rebuilt/)

    sqlite.close()
  })

  it('independent helpers hold independent state per session (LOCK-FTS-5)', () => {
    const sqliteA = openTestDb(realPath.join(tempDir, 'a.db'))
    const sqliteB = openTestDb(realPath.join(tempDir, 'b.db'))
    applyAllMigrations(sqliteA)
    applyAllMigrations(sqliteB)

    const helperA = new CandidateFtsProjection()
    const helperB = new CandidateFtsProjection()

    // A defers but does not rebuild; B is untouched.
    helperA.defer(sqliteA)
    expect(helperA.getState()).toBe('deferred')
    expect(helperB.getState()).toBe('idle')

    // B can defer+rebuild independently while A stays deferred.
    helperB.defer(sqliteB)
    helperB.rebuild()
    expect(helperB.getState()).toBe('rebuilt')
    expect(helperA.getState()).toBe('deferred')
    expectDerivedAbsent(sqliteA)
    expectDerivedPresent(sqliteB)

    sqliteA.close()
    sqliteB.close()
  })
})
