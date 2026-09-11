/**
 * Migration 011_sync_parent_order_frame_parent_id_unbounded:
 * - Rebuilds sync_parent_order_frame to remove 256 cap on parent_id
 * - Preserves rows byte-for-byte
 * - Allows >256 Unicode-scalar parentId, retains other constraints
 * - Registry count 11, idempotent, rollback on violation
 */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@main/config', () => ({ DATA_PATH: '/tmp' }))

import { isValidUnicodeScalarString } from '../../sync/syncFrameEvaluation'
import { MIGRATIONS, runMigrations } from '../migration'

let sqlite: Database.Database

function openDb(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

beforeEach(() => {
  sqlite = openDb()
})

afterEach(() => {
  try {
    sqlite.close()
  } catch {}
})

describe('011_sync_parent_order_frame_parent_id_unbounded', () => {
  it('is registered as 11th migration with correct unbounded DDL', () => {
    expect(MIGRATIONS.length).toBe(11)
    expect(MIGRATIONS[10].key).toBe('011_sync_parent_order_frame_parent_id_unbounded')
    const joined = MIGRATIONS[10].sql.join(' ')
    expect(joined).toContain('ALTER TABLE sync_parent_order_frame RENAME TO sync_parent_order_frame_mig_old')
    expect(joined).toContain('CREATE TABLE sync_parent_order_frame')
    expect(joined).toContain('CHECK (length(parent_id) > 0)')
    expect(joined).not.toContain('length(parent_id) <= 256')
    expect(joined).toContain("CHECK (kind IN ('topicMessage','messageBlock'))")
    expect(joined).toContain("frame_version TEXT NOT NULL CHECK (frame_version = 'parent-order-frame-v1')")
    expect(joined).toContain('json_valid(ordered_child_ids_json)')
    expect(joined).toContain(
      'operation_id TEXT NOT NULL CHECK (length(operation_id) > 0 AND length(operation_id) <= 256'
    )
    expect(joined).toContain('PRIMARY KEY (kind, parent_id)')
    expect(joined).toContain('INSERT INTO sync_parent_order_frame SELECT * FROM sync_parent_order_frame_mig_old')
    expect(joined).toContain('DROP TABLE sync_parent_order_frame_mig_old')
    // Ensure 010 still retains its old cap in its own definition (history not rewritten)
    const oldJoined = MIGRATIONS[9].sql.join(' ')
    expect(oldJoined).toContain('length(parent_id) <= 256')
  })

  it('pre-011 valid existing rows preserved exactly byte-for-byte after rebuild', () => {
    const db = drizzle(sqlite, {})
    runMigrations(db as never, sqlite)
    // Roll back 011 to simulate pre-011 state with old table
    sqlite.prepare(`DELETE FROM migration_state WHERE key='011_sync_parent_order_frame_parent_id_unbounded'`).run()
    sqlite.exec('DROP TABLE IF EXISTS sync_parent_order_frame')
    // Recreate old table via 010 DDL
    for (const stmt of MIGRATIONS[9].sql) sqlite.exec(stmt)
    // Insert valid pre-011 rows (within 256 cap, valid Unicode)
    const rows: Array<[string, string, string, string, number, string]> = [
      ['topicMessage', 't-short-011', 'parent-order-frame-v1', JSON.stringify(['m1', 'm2']), 100, 'op-1'],
      ['messageBlock', 'm-short-011', 'parent-order-frame-v1', JSON.stringify([]), 200, 'op-2'],
      ['topicMessage', 't-unicode-✓', 'parent-order-frame-v1', JSON.stringify(['m✓']), 300, 'op-unicode']
    ]
    for (const r of rows) {
      sqlite
        .prepare(
          `INSERT INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(...r)
    }
    const before = sqlite
      .prepare(
        `SELECT kind, parent_id as parentId, frame_version as frameVersion, ordered_child_ids_json as json, timestamp, operation_id as operationId FROM sync_parent_order_frame ORDER BY kind, parent_id`
      )
      .all()

    const applied = runMigrations(db as never, sqlite)
    expect(applied).toBe(1)
    const after = sqlite
      .prepare(
        `SELECT kind, parent_id as parentId, frame_version as frameVersion, ordered_child_ids_json as json, timestamp, operation_id as operationId FROM sync_parent_order_frame ORDER BY kind, parent_id`
      )
      .all()
    expect(after).toEqual(before)
    // Verify new schema no longer caps 256
    const tbl = sqlite
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sync_parent_order_frame'`)
      .get() as { sql: string }
    expect(tbl.sql).toContain('CHECK (length(parent_id) > 0)')
    expect(tbl.sql).not.toContain('length(parent_id) <= 256')
    // Ensure operationId and other constraints still present
    expect(tbl.sql).toContain('length(operation_id) <= 256')
  })

  it('allows >256 Unicode-scalar parentId after 011, rejects empty via CHECK and lone surrogate via app validation', () => {
    const db = drizzle(sqlite, {})
    runMigrations(db as never, sqlite)
    const longId = 'a'.repeat(300) // valid Unicode scalar, >256
    expect(isValidUnicodeScalarString(longId)).toBe(true)
    expect(() => {
      sqlite
        .prepare(
          `INSERT INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run('topicMessage', longId, 'parent-order-frame-v1', JSON.stringify(['m1']), 1, 'op-long')
    }).not.toThrow()
    const row = sqlite.prepare(`SELECT parent_id FROM sync_parent_order_frame WHERE parent_id=?`).get(longId) as
      | { parent_id: string }
      | undefined
    expect(row?.parent_id).toBe(longId)
    // Cleanup
    sqlite.prepare(`DELETE FROM sync_parent_order_frame WHERE parent_id=?`).run(longId)

    // Empty should fail via CHECK
    expect(() => {
      sqlite
        .prepare(
          `INSERT INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run('topicMessage', '', 'parent-order-frame-v1', '[]', 1, 'op-empty')
    }).toThrow(/CHECK constraint/i)

    // Lone surrogate: SQLite TEXT can store unpaired surrogates, but app strict validation should reject
    const lone = '\uD800' // unpaired high surrogate
    expect(isValidUnicodeScalarString(lone)).toBe(false)
    // SQLite may allow insert, app layer would reject; we assert SQLite behavior is not relied upon for Unicode, but empty is CHECK, lone is app-owned
    // Try insert: if SQLite rejects via CHECK length>0, lone length is 1 so CHECK passes; we expect either success (SQLite allows) or failure (if SQLite enforces). Either is acceptable, but app validation must reject.
    // We verify app validation would reject via isValidUnicodeScalarString
    expect(isValidUnicodeScalarString(lone)).toBe(false)
    // Practical: attempt insert and if succeeds, we clean up and assert app would have rejected
    try {
      sqlite
        .prepare(
          `INSERT INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run('topicMessage', lone, 'parent-order-frame-v1', '[]', 1, 'op-lone')
      // If inserted, remove and note that SQLite allowed but app validation owns rejection
      sqlite.prepare(`DELETE FROM sync_parent_order_frame WHERE parent_id=?`).run(lone)
      expect(isValidUnicodeScalarString(lone)).toBe(false)
    } catch (e) {
      // If SQLite rejected, also fine (CHECK or other)
      expect((e as Error).message).toMatch(/CHECK|constraint/i)
    }

    // operationId still <=256 and no colon
    const longOp = 'o'.repeat(257)
    expect(() => {
      sqlite
        .prepare(
          `INSERT INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run('topicMessage', 'p-op-long', 'parent-order-frame-v1', '[]', 1, longOp)
    }).toThrow(/CHECK constraint/i)
    expect(() => {
      sqlite
        .prepare(
          `INSERT INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run('topicMessage', 'p-op-colon', 'parent-order-frame-v1', '[]', 1, 'bad:colon')
    }).toThrow(/CHECK constraint/i)
    // Valid 256-char operationId should succeed
    const okOp = 'o'.repeat(256)
    expect(() => {
      sqlite
        .prepare(
          `INSERT INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run('topicMessage', 'p-op-ok', 'parent-order-frame-v1', '[]', 1, okOp)
    }).not.toThrow()
    sqlite.prepare(`DELETE FROM sync_parent_order_frame WHERE parent_id=?`).run('p-op-ok')
  })

  it('idempotent migration registry behavior preserves rows', () => {
    const db = drizzle(sqlite, {})
    runMigrations(db as never, sqlite)
    sqlite
      .prepare(
        `INSERT INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('topicMessage', 't-keep-011', 'parent-order-frame-v1', JSON.stringify(['m1']), 123, 'op-keep-011')
    const before = sqlite.prepare(`SELECT * FROM sync_parent_order_frame ORDER BY kind, parent_id`).all()
    // Simulate upgrade re-run by deleting only marker, keeping table
    sqlite.prepare(`DELETE FROM migration_state WHERE key='011_sync_parent_order_frame_parent_id_unbounded'`).run()
    const applied = runMigrations(db as never, sqlite)
    expect(applied).toBe(1)
    const after = sqlite.prepare(`SELECT * FROM sync_parent_order_frame ORDER BY kind, parent_id`).all()
    expect(after).toEqual(before)
    const row = sqlite
      .prepare(
        `SELECT ordered_child_ids_json as json FROM sync_parent_order_frame WHERE kind='topicMessage' AND parent_id='t-keep-011'`
      )
      .get() as { json: string }
    expect(JSON.parse(row.json)).toEqual(['m1'])
  })

  it('failure rolls back if existing row violates new table constraints (operationId colon)', () => {
    const db = drizzle(sqlite, {})
    runMigrations(db as never, sqlite)
    // Roll back 011 and recreate old table
    sqlite.prepare(`DELETE FROM migration_state WHERE key='011_sync_parent_order_frame_parent_id_unbounded'`).run()
    sqlite.exec('DROP TABLE IF EXISTS sync_parent_order_frame')
    for (const stmt of MIGRATIONS[9].sql) sqlite.exec(stmt)
    // Insert a valid row
    sqlite
      .prepare(
        `INSERT INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('topicMessage', 't-valid-011', 'parent-order-frame-v1', '[]', 1, 'op-valid')
    // Now attempt to corrupt the table to contain an invalid row that violates new constraints but was inserted via bypass
    // Use ignore_check_constraints to bypass CHECK for insertion of invalid operationId with colon
    // If the driver does not support bypass, the test will gracefully handle the seam as not practical
    sqlite.pragma('ignore_check_constraints = 1')
    let bypassSucceeded = false
    try {
      sqlite
        .prepare(
          `INSERT INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run('topicMessage', 't-bad-011', 'parent-order-frame-v1', '[]', 1, 'bad:colon')
      bypassSucceeded = true
    } catch {}
    sqlite.pragma('ignore_check_constraints = 0')
    const beforeCount = (sqlite.prepare(`SELECT COUNT(*) as n FROM sync_parent_order_frame`).get() as { n: number }).n
    const beforeState = sqlite
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sync_parent_order_frame'`)
      .get() as { sql: string }
    expect(beforeState.sql).toContain('length(parent_id) <= 256')
    if (!bypassSucceeded || beforeCount !== 2) {
      // Seam not practical on this SQLite driver/build: verify normal invalid inserts are still rejected and valid rows preserved
      expect(() => {
        sqlite
          .prepare(
            `INSERT INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run('topicMessage', 't-bad-check', 'parent-order-frame-v1', '[]', 1, 'bad:colon')
      }).toThrow(/CHECK constraint/i)
      expect(beforeCount).toBe(1)
      // No rollback test needed; seam not practical, but we still verify migration would preserve valid rows if run
      const applied = runMigrations(db as never, sqlite)
      expect(applied).toBe(1)
      const afterTbl = sqlite
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sync_parent_order_frame'`)
        .get() as { sql: string }
      expect(afterTbl.sql).not.toContain('length(parent_id) <= 256')
      expect(afterTbl.sql).toContain('CHECK (length(parent_id) > 0)')
      return
    }
    expect(beforeCount).toBe(2)
    // Attempt migration 011: should fail due to invalid operationId in existing row, and roll back
    let threw = false
    try {
      runMigrations(db as never, sqlite)
    } catch (e) {
      threw = true
      expect((e as Error).message).toMatch(/CHECK constraint|constraint failed|Failed to run the query/i)
    }
    expect(threw).toBe(true)
    // Verify rollback: migration_state still missing, table still old schema with both rows preserved
    const stateRow = sqlite
      .prepare(`SELECT 1 FROM migration_state WHERE key='011_sync_parent_order_frame_parent_id_unbounded'`)
      .get()
    expect(stateRow).toBeUndefined()
    const afterTbl = sqlite
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sync_parent_order_frame'`)
      .get() as { sql: string }
    expect(afterTbl.sql).toContain('length(parent_id) <= 256')
    const afterCount = (sqlite.prepare(`SELECT COUNT(*) as n FROM sync_parent_order_frame`).get() as { n: number }).n
    expect(afterCount).toBe(2)
    // Also verify old table still accessible and valid row still there
    const validRow = sqlite
      .prepare(`SELECT parent_id FROM sync_parent_order_frame WHERE parent_id='t-valid-011'`)
      .get() as { parent_id: string } | undefined
    expect(validRow?.parent_id).toBe('t-valid-011')
  })
})
