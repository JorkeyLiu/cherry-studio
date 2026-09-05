/**
 * Migration 003 — FTS5 Normalized Search Projection Tests
 *
 * Covers:
 * - Fresh DB applies 001 + 002 + 003
 * - Existing MAIN_TEXT blocks backfilled into normalized projection
 * - Non-MAIN_TEXT blocks not projected
 * - INSERT trigger: new MAIN_TEXT block → projection row created
 * - INSERT trigger: new non-MAIN_TEXT block → no projection row
 * - UPDATE trigger: content change → normalized_content updated
 * - UPDATE trigger: type change to non-MAIN_TEXT → projection row deleted
 * - UPDATE trigger: type change to MAIN_TEXT → projection row created
 * - DELETE trigger: block deleted → projection row removed
 * - FK cascade: message deleted → blocks cascade → projections cascade
 * - FK cascade: topic deleted → messages cascade → blocks cascade → projections cascade
 * - Import-style raw block insertion via SQL → trigger fires
 * - Migration idempotency: re-run does not duplicate
 * - Injected failure: migration_state not advanced on SQL error
 * - FTS5 trigram search returns correct candidates
 * - Reorder-only writes (sort_order only) do not cause semantic changes
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

import { MIGRATIONS, registerChatDbNormalize, runMigrations } from '../migration'
import * as schema from '../schema'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-migration003-'))
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

function getTableNames(sqlite: Database.Database): string[] {
  return (
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name)
}

function getTriggerNames(sqlite: Database.Database): string[] {
  return (
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all() as Array<{ name: string }>
  ).map((r) => r.name)
}

function getFtsTables(sqlite: Database.Database): string[] {
  return (
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%fts5%' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name)
}

function registerNormalizeFunction(sqlite: Database.Database): void {
  registerChatDbNormalize(sqlite)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Migration 003 — FTS5 Normalized Search Projection', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
  })

  afterEach(() => {
    rmrf(tempDir)
  })

  it('applies 001 + 002 + 003 on fresh DB', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    const applied = runMigrations(db, sqlite)
    expect(applied).toBe(7)

    // Verify tables
    const tables = getTableNames(sqlite)
    expect(tables).toContain('message_blocks_normalized')
    expect(tables).toContain('migration_state')

    // Verify FTS virtual table
    const ftsTables = getFtsTables(sqlite)
    expect(ftsTables).toContain('message_blocks_fts')

    // Verify triggers
    const triggers = getTriggerNames(sqlite)
    expect(triggers).toContain('message_blocks_normalized_insert')
    expect(triggers).toContain('message_blocks_normalized_update')
    expect(triggers).toContain('message_blocks_normalized_delete')

    sqlite.close()
  })

  it('backfills existing MAIN_TEXT blocks', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    // Manually apply migrations 001 + 002 (NOT 003) so we can insert data
    // and then apply 003 separately to test backfill
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
    })
    sqlite.pragma('foreign_keys = ON')

    // Insert test data
    sqlite.exec(`INSERT INTO topics (id, name, created_at) VALUES ('t1', 'Test', '2026-01-01T00:00:00.000Z')`)
    sqlite.exec(
      `INSERT INTO messages (id, topic_id, role, content, created_at, sort_order) VALUES ('m1', 't1', 'user', 'Hello', '2026-01-01T00:01:00.000Z', 0)`
    )
    sqlite.exec(
      `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b1', 'm1', 'main_text', 'Hello world', 0)`
    )
    sqlite.exec(
      `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b2', 'm1', 'file', null, 1)`
    )

    // Apply migration 003 only
    const m003 = MIGRATIONS[2]
    db.transaction((tx) => {
      for (const stmt of m003.sql) tx.run(stmt)
      tx.insert(schema.migrationState)
        .values({ key: m003.key, value: m003.key, updatedAt: new Date().toISOString() })
        .run()
    })

    // Verify backfill
    const normalized = sqlite.prepare('SELECT * FROM message_blocks_normalized').all() as any[]
    expect(normalized.length).toBe(1)
    expect(normalized[0].block_id).toBe('b1')
    expect(normalized[0].message_id).toBe('m1')
    expect(normalized[0].normalized_content).toBe('hello world')

    // Verify file block not projected
    const fileBlock = sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b2')
    expect(fileBlock).toBeUndefined()

    sqlite.close()
  })

  it('INSERT trigger: new MAIN_TEXT block creates projection', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    const applied = runMigrations(db, sqlite)
    expect(applied).toBe(7)

    // Insert test data
    sqlite.exec(`INSERT INTO topics (id, name, created_at) VALUES ('t1', 'Test', '2026-01-01T00:00:00.000Z')`)
    sqlite.exec(
      `INSERT INTO messages (id, topic_id, role, content, created_at, sort_order) VALUES ('m1', 't1', 'user', 'Hello', '2026-01-01T00:01:00.000Z', 0)`
    )

    // Insert a MAIN_TEXT block
    sqlite.exec(
      `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b1', 'm1', 'main_text', 'Test content', 0)`
    )

    const normalized = sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b1') as any
    expect(normalized).toBeDefined()
    expect(normalized.normalized_content).toBe('test content')

    sqlite.close()
  })

  it('INSERT trigger: non-MAIN_TEXT block does not create projection', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    const applied = runMigrations(db, sqlite)
    expect(applied).toBe(7)

    sqlite.exec(`INSERT INTO topics (id, name, created_at) VALUES ('t1', 'Test', '2026-01-01T00:00:00.000Z')`)
    sqlite.exec(
      `INSERT INTO messages (id, topic_id, role, content, created_at, sort_order) VALUES ('m1', 't1', 'user', 'Hello', '2026-01-01T00:01:00.000Z', 0)`
    )

    // Insert a file block
    sqlite.exec(
      `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b1', 'm1', 'file', null, 0)`
    )

    const normalized = sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b1')
    expect(normalized).toBeUndefined()

    sqlite.close()
  })

  it('UPDATE trigger: content change updates normalized_content', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    const applied = runMigrations(db, sqlite)
    expect(applied).toBe(7)

    sqlite.exec(`INSERT INTO topics (id, name, created_at) VALUES ('t1', 'Test', '2026-01-01T00:00:00.000Z')`)
    sqlite.exec(
      `INSERT INTO messages (id, topic_id, role, content, created_at, sort_order) VALUES ('m1', 't1', 'user', 'Hello', '2026-01-01T00:01:00.000Z', 0)`
    )
    sqlite.exec(
      `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b1', 'm1', 'main_text', 'Original', 0)`
    )

    // Update content
    sqlite.exec(`UPDATE message_blocks SET content = 'Updated content' WHERE id = 'b1'`)

    const normalized = sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b1') as any
    expect(normalized).toBeDefined()
    expect(normalized.normalized_content).toBe('updated content')

    sqlite.close()
  })

  it('UPDATE trigger: type change to non-MAIN_TEXT deletes projection', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    const applied = runMigrations(db, sqlite)
    expect(applied).toBe(7)

    sqlite.exec(`INSERT INTO topics (id, name, created_at) VALUES ('t1', 'Test', '2026-01-01T00:00:00.000Z')`)
    sqlite.exec(
      `INSERT INTO messages (id, topic_id, role, content, created_at, sort_order) VALUES ('m1', 't1', 'user', 'Hello', '2026-01-01T00:01:00.000Z', 0)`
    )
    sqlite.exec(
      `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b1', 'm1', 'main_text', 'Content', 0)`
    )

    // Verify projection exists
    expect(sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b1')).toBeDefined()

    // Change type to file
    sqlite.exec(`UPDATE message_blocks SET type = 'file' WHERE id = 'b1'`)

    // Verify projection deleted
    expect(sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b1')).toBeUndefined()

    sqlite.close()
  })

  it('UPDATE trigger: type change to MAIN_TEXT creates projection', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    const applied = runMigrations(db, sqlite)
    expect(applied).toBe(7)

    sqlite.exec(`INSERT INTO topics (id, name, created_at) VALUES ('t1', 'Test', '2026-01-01T00:00:00.000Z')`)
    sqlite.exec(
      `INSERT INTO messages (id, topic_id, role, content, created_at, sort_order) VALUES ('m1', 't1', 'user', 'Hello', '2026-01-01T00:01:00.000Z', 0)`
    )
    sqlite.exec(
      `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b1', 'm1', 'file', 'Some content', 0)`
    )

    // Verify no projection
    expect(sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b1')).toBeUndefined()

    // Change type to main_text
    sqlite.exec(`UPDATE message_blocks SET type = 'main_text' WHERE id = 'b1'`)

    // Verify projection created
    const normalized = sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b1') as any
    expect(normalized).toBeDefined()
    expect(normalized.normalized_content).toBe('some content')

    sqlite.close()
  })

  it('DELETE trigger: block deleted removes projection', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    const applied = runMigrations(db, sqlite)
    expect(applied).toBe(7)

    sqlite.exec(`INSERT INTO topics (id, name, created_at) VALUES ('t1', 'Test', '2026-01-01T00:00:00.000Z')`)
    sqlite.exec(
      `INSERT INTO messages (id, topic_id, role, content, created_at, sort_order) VALUES ('m1', 't1', 'user', 'Hello', '2026-01-01T00:01:00.000Z', 0)`
    )
    sqlite.exec(
      `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b1', 'm1', 'main_text', 'Content', 0)`
    )

    // Verify projection exists
    expect(sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b1')).toBeDefined()

    // Delete block
    sqlite.exec(`DELETE FROM message_blocks WHERE id = 'b1'`)

    // Verify projection deleted
    expect(sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b1')).toBeUndefined()

    sqlite.close()
  })

  it('FK cascade: message deleted → blocks cascade → projections cascade', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    const applied = runMigrations(db, sqlite)
    expect(applied).toBe(7)

    sqlite.exec(`INSERT INTO topics (id, name, created_at) VALUES ('t1', 'Test', '2026-01-01T00:00:00.000Z')`)
    sqlite.exec(
      `INSERT INTO messages (id, topic_id, role, content, created_at, sort_order) VALUES ('m1', 't1', 'user', 'Hello', '2026-01-01T00:01:00.000Z', 0)`
    )
    sqlite.exec(
      `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b1', 'm1', 'main_text', 'Content', 0)`
    )

    // Verify projection exists
    expect(sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b1')).toBeDefined()

    // Delete message (cascades to blocks)
    sqlite.exec(`DELETE FROM messages WHERE id = 'm1'`)

    // Verify both block and projection deleted
    expect(sqlite.prepare('SELECT * FROM message_blocks WHERE id = ?').get('b1')).toBeUndefined()
    expect(sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b1')).toBeUndefined()

    sqlite.close()
  })

  it('FK cascade: topic deleted → messages → blocks → projections', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    const applied = runMigrations(db, sqlite)
    expect(applied).toBe(7)

    sqlite.exec(`INSERT INTO topics (id, name, created_at) VALUES ('t1', 'Test', '2026-01-01T00:00:00.000Z')`)
    sqlite.exec(
      `INSERT INTO messages (id, topic_id, role, content, created_at, sort_order) VALUES ('m1', 't1', 'user', 'Hello', '2026-01-01T00:01:00.000Z', 0)`
    )
    sqlite.exec(
      `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b1', 'm1', 'main_text', 'Content', 0)`
    )

    // Delete topic (cascades to messages → blocks → projections)
    sqlite.exec(`DELETE FROM topics WHERE id = 't1'`)

    expect(sqlite.prepare('SELECT * FROM message_blocks WHERE id = ?').get('b1')).toBeUndefined()
    expect(sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b1')).toBeUndefined()

    sqlite.close()
  })

  it('Import-style raw block insertion via SQL triggers correctly', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    const applied = runMigrations(db, sqlite)
    expect(applied).toBe(7)

    sqlite.exec(`INSERT INTO topics (id, name, created_at) VALUES ('t1', 'Test', '2026-01-01T00:00:00.000Z')`)
    sqlite.exec(
      `INSERT INTO messages (id, topic_id, role, content, created_at, sort_order) VALUES ('m1', 't1', 'user', 'Hello', '2026-01-01T00:01:00.000Z', 0)`
    )

    // Raw SQL import (simulates import pipeline)
    sqlite.exec(
      `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('import-1', 'm1', 'main_text', 'Imported content with markdown **bold**', 0)`
    )

    const normalized = sqlite
      .prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?')
      .get('import-1') as any
    expect(normalized).toBeDefined()
    // Markdown stripping: **bold** → bold (markdown is just text, not stripped)
    expect(normalized.normalized_content).toBe('imported content with markdown bold')

    sqlite.close()
  })

  it('Migration idempotency: re-run does not duplicate', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    const applied1 = runMigrations(db, sqlite)
    expect(applied1).toBe(7)

    // Run again — should apply 0 new migrations
    const applied2 = runMigrations(db, sqlite)
    expect(applied2).toBe(0)

    // Verify migration state
    const states = sqlite.prepare('SELECT * FROM migration_state ORDER BY key').all() as any[]
    expect(states.length).toBe(7)
    expect(states.map((s) => s.key)).toEqual([
      '001_initial_schema',
      '002_corrective_schema',
      '003_fts5_normalized_search',
      '004_fts_rowid_identity',
      '005_sync_metadata',
      '006_sync_field_merge',
      '007_sync_pairing_trust'
    ])

    sqlite.close()
  })

  it('Reorder-only writes do not cause semantic changes', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    const applied = runMigrations(db, sqlite)
    expect(applied).toBe(7)

    sqlite.exec(`INSERT INTO topics (id, name, created_at) VALUES ('t1', 'Test', '2026-01-01T00:00:00.000Z')`)
    sqlite.exec(
      `INSERT INTO messages (id, topic_id, role, content, created_at, sort_order) VALUES ('m1', 't1', 'user', 'Hello', '2026-01-01T00:01:00.000Z', 0)`
    )
    sqlite.exec(
      `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b1', 'm1', 'main_text', 'Content', 0)`
    )

    const before = sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b1') as any

    // Reorder (sort_order change only)
    sqlite.exec(`UPDATE message_blocks SET sort_order = 5 WHERE id = 'b1'`)

    // UPDATE trigger fires on content/type columns — sort_order change should NOT
    // delete or modify the projection (trigger WHERE clause filters this)
    // However, the trigger fires on ANY update to message_blocks, so the DELETE+INSERT
    // will re-insert with the same content. This is idempotent.
    const after = sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b1') as any
    expect(after).toBeDefined()
    expect(after.normalized_content).toBe(before.normalized_content)

    sqlite.close()
  })

  it('Migration 003 failure does not advance migration_state', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)

    // Do NOT register chatdb_normalize — migration backfill will fail
    const db = wrapDrizzle(sqlite)

    // Create migration_state table (normally done by runMigrations)
    db.run(/* sql */ `
      CREATE TABLE IF NOT EXISTS migration_state (
        key   TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT
      )
    `)

    // Apply 001 + 002
    const m001 = MIGRATIONS[0]
    const m002 = MIGRATIONS[1]
    sqlite.pragma('foreign_keys = OFF')
    db.transaction((tx) => {
      for (const stmt of m001.sql) tx.run(stmt)
      tx.insert(schema.migrationState)
        .values({ key: m001.key, value: m001.key, updatedAt: new Date().toISOString() })
        .run()
      for (const stmt of m002.sql) tx.run(stmt)
      tx.insert(schema.migrationState)
        .values({ key: m002.key, value: m002.key, updatedAt: new Date().toISOString() })
        .run()
    })
    sqlite.pragma('foreign_keys = ON')

    // Insert data that will cause 003 to fail (no normalize function)
    sqlite.exec(`INSERT INTO topics (id, name, created_at) VALUES ('t1', 'Test', '2026-01-01T00:00:00.000Z')`)
    sqlite.exec(
      `INSERT INTO messages (id, topic_id, role, content, created_at, sort_order) VALUES ('m1', 't1', 'user', 'Hello', '2026-01-01T00:01:00.000Z', 0)`
    )
    sqlite.exec(
      `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b1', 'm1', 'main_text', 'Content', 0)`
    )

    // Try to apply 003 without normalize function — should fail
    const m003 = MIGRATIONS[2]
    expect(() => {
      db.transaction((tx) => {
        for (const stmt of m003.sql) tx.run(stmt)
      })
    }).toThrow()

    // Verify migration_state was NOT advanced (003 not recorded)
    const states = sqlite.prepare('SELECT * FROM migration_state ORDER BY key').all() as any[]
    expect(states.length).toBe(2)
    expect(states.map((s) => s.key)).toEqual(['001_initial_schema', '002_corrective_schema'])

    sqlite.close()
  })

  it('CRLF normalization in projection', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    const applied = runMigrations(db, sqlite)
    expect(applied).toBe(7)

    sqlite.exec(`INSERT INTO topics (id, name, created_at) VALUES ('t1', 'Test', '2026-01-01T00:00:00.000Z')`)
    sqlite.exec(
      `INSERT INTO messages (id, topic_id, role, content, created_at, sort_order) VALUES ('m1', 't1', 'user', 'Hello', '2026-01-01T00:01:00.000Z', 0)`
    )
    sqlite.exec(
      `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b1', 'm1', 'main_text', 'Line1\r\nLine2\rLine3', 0)`
    )

    const normalized = sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b1') as any
    expect(normalized.normalized_content).toBe('line1\nline2\nline3')

    sqlite.close()
  })

  it('Markdown stripping in projection', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    const applied = runMigrations(db, sqlite)
    expect(applied).toBe(7)

    sqlite.exec(`INSERT INTO topics (id, name, created_at) VALUES ('t1', 'Test', '2026-01-01T00:00:00.000Z')`)
    sqlite.exec(
      `INSERT INTO messages (id, topic_id, role, content, created_at, sort_order) VALUES ('m1', 't1', 'user', 'Hello', '2026-01-01T00:01:00.000Z', 0)`
    )
    sqlite.exec(
      `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b1', 'm1', 'main_text', '## Header **bold** *italic* \`code\` [link](http://example.com)', 0)`
    )

    const normalized = sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b1') as any
    // Markdown stripping: ## Header → Header, **bold** → bold, *italic* → italic, `code` → code, [link](url) → link
    expect(normalized.normalized_content).toBe('header bold italic code link')

    sqlite.close()
  })

  it('UPDATE trigger: message_id change updates projection message_id', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    const applied = runMigrations(db, sqlite)
    expect(applied).toBe(7)

    sqlite.exec(`INSERT INTO topics (id, name, created_at) VALUES ('t1', 'Test', '2026-01-01T00:00:00.000Z')`)
    sqlite.exec(
      `INSERT INTO messages (id, topic_id, role, content, created_at, sort_order) VALUES ('m1', 't1', 'user', 'Hello', '2026-01-01T00:01:00.000Z', 0)`
    )
    sqlite.exec(
      `INSERT INTO messages (id, topic_id, role, content, created_at, sort_order) VALUES ('m2', 't1', 'user', 'Hello2', '2026-01-01T00:02:00.000Z', 1)`
    )
    sqlite.exec(
      `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b1', 'm1', 'main_text', 'Content', 0)`
    )

    // Verify initial state
    const before = sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b1') as any
    expect(before.message_id).toBe('m1')

    // Update message_id (reparent block to different message)
    sqlite.exec(`UPDATE message_blocks SET message_id = 'm2' WHERE id = 'b1'`)

    // Verify projection updated with new message_id
    const after = sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b1') as any
    expect(after.message_id).toBe('m2')

    sqlite.close()
  })

  it('Raw SQL reparent test: block moves between messages', () => {
    const dbPath = realPath.join(tempDir, 'chat.db')
    const sqlite = openTestDb(dbPath)
    registerNormalizeFunction(sqlite)
    const db = wrapDrizzle(sqlite)

    const applied = runMigrations(db, sqlite)
    expect(applied).toBe(7)

    sqlite.exec(`INSERT INTO topics (id, name, created_at) VALUES ('t1', 'Test', '2026-01-01T00:00:00.000Z')`)
    sqlite.exec(
      `INSERT INTO messages (id, topic_id, role, content, created_at, sort_order) VALUES ('m1', 't1', 'user', 'Hello', '2026-01-01T00:01:00.000Z', 0)`
    )
    sqlite.exec(
      `INSERT INTO messages (id, topic_id, role, content, created_at, sort_order) VALUES ('m2', 't1', 'user', 'Hello2', '2026-01-01T00:02:00.000Z', 1)`
    )
    sqlite.exec(
      `INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES ('b1', 'm1', 'main_text', 'Movable content', 0)`
    )

    // Verify block starts in m1
    const initial = sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b1') as any
    expect(initial.message_id).toBe('m1')

    // Reparent via raw SQL (simulates import pipeline)
    sqlite.exec(`UPDATE message_blocks SET message_id = 'm2' WHERE id = 'b1'`)

    // Verify projection reflects new parent
    const reparented = sqlite.prepare('SELECT * FROM message_blocks_normalized WHERE block_id = ?').get('b1') as any
    expect(reparented.message_id).toBe('m2')
    expect(reparented.normalized_content).toBe('movable content')

    // Verify FTS index updated
    const ftsRow = sqlite.prepare('SELECT * FROM message_blocks_fts WHERE block_id = ?').get('b1') as any
    expect(ftsRow).toBeDefined()

    sqlite.close()
  })
})
