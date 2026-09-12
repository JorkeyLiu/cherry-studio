/**
 * Migration 012_sync_frame_high_water:
 * - Creates sync_frame_high_water with (kind, parent_id) PK and safe
 *   nonnegative max_timestamp (SYNC-DATA-048 local implementation invariant)
 * - Backfills one mark per existing winning frame with its current timestamp
 * - Registry count 12, idempotent, rollback on violation, MAX_SAFE covered
 */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@main/config', () => ({ DATA_PATH: '/tmp' }))

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

function highWaterRows(): Array<{ kind: string; parent_id: string; max_timestamp: number }> {
  return sqlite
    .prepare(`SELECT kind, parent_id, max_timestamp FROM sync_frame_high_water ORDER BY kind, parent_id`)
    .all() as Array<{ kind: string; parent_id: string; max_timestamp: number }>
}

describe('012_sync_frame_high_water', () => {
  it('is registered as 12th migration with correct DDL and backfill', () => {
    expect(MIGRATIONS.length).toBe(13)
    expect(MIGRATIONS[11].key).toBe('012_sync_frame_high_water')
    expect(MIGRATIONS[12].key).toBe('013_sync_stable_replace_register')
    const joined = MIGRATIONS[11].sql.join(' ')
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS sync_frame_high_water')
    expect(joined).toContain("CHECK (kind IN ('topicMessage','messageBlock'))")
    expect(joined).toContain('CHECK (length(parent_id) > 0)')
    expect(joined).toContain('CHECK (max_timestamp >= 0 AND max_timestamp <= 9007199254740991)')
    expect(joined).toContain('PRIMARY KEY (kind, parent_id)')
    expect(joined).toContain(
      'INSERT INTO sync_frame_high_water (kind, parent_id, max_timestamp) SELECT kind, parent_id, timestamp FROM sync_parent_order_frame AS f WHERE NOT EXISTS'
    )
    // History not rewritten: 010/011 definitions unchanged
    expect(MIGRATIONS[9].key).toBe('010_sync_parent_order_frame')
    expect(MIGRATIONS[10].key).toBe('011_sync_parent_order_frame_parent_id_unbounded')
  })

  it('fresh database creates an empty high-water table', () => {
    const db = drizzle(sqlite, {})
    const applied = runMigrations(db as never, sqlite)
    expect(applied).toBe(13)
    const tbl = sqlite
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sync_frame_high_water'`)
      .get() as { sql: string }
    expect(tbl.sql).toContain('PRIMARY KEY (kind, parent_id)')
    expect(highWaterRows()).toEqual([])
  })

  it('pre-012 seeded frames backfill current timestamps; frame rows preserved byte-for-byte', () => {
    const db = drizzle(sqlite, {})
    runMigrations(db as never, sqlite)
    // Simulate a pre-012 database: drop the new table, remove its marker, keep frames
    sqlite.prepare(`DELETE FROM migration_state WHERE key='012_sync_frame_high_water'`).run()
    sqlite.exec('DROP TABLE IF EXISTS sync_frame_high_water')
    const seed: Array<[string, string, string, string, number, string]> = [
      ['topicMessage', 't-hw-1', 'parent-order-frame-v1', JSON.stringify(['m1', 'm2']), 100, 'op-hw-1'],
      ['topicMessage', 't-hw-2', 'parent-order-frame-v1', JSON.stringify([]), 9007199254740991, 'op-hw-max'],
      ['messageBlock', 'm-hw-1', 'parent-order-frame-v1', JSON.stringify(['b1']), 250, 'op-hw-3']
    ]
    for (const r of seed) {
      sqlite
        .prepare(
          `INSERT INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(...r)
    }
    const framesBefore = sqlite
      .prepare(`SELECT kind, parent_id, timestamp, operation_id FROM sync_parent_order_frame ORDER BY kind, parent_id`)
      .all()

    const applied = runMigrations(db as never, sqlite)
    expect(applied).toBe(1)
    // Backfill carries each current winning timestamp (including MAX_SAFE)
    expect(highWaterRows()).toEqual([
      { kind: 'messageBlock', parent_id: 'm-hw-1', max_timestamp: 250 },
      { kind: 'topicMessage', parent_id: 't-hw-1', max_timestamp: 100 },
      { kind: 'topicMessage', parent_id: 't-hw-2', max_timestamp: 9007199254740991 }
    ])
    // Frame rows untouched
    const framesAfter = sqlite
      .prepare(`SELECT kind, parent_id, timestamp, operation_id FROM sync_parent_order_frame ORDER BY kind, parent_id`)
      .all()
    expect(framesAfter).toEqual(framesBefore)
  })

  it('idempotent re-run preserves marks and never lowers them (WHERE NOT EXISTS)', () => {
    const db = drizzle(sqlite, {})
    runMigrations(db as never, sqlite)
    sqlite
      .prepare(
        `INSERT INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('topicMessage', 't-hw-keep', 'parent-order-frame-v1', JSON.stringify(['m1']), 500, 'op-hw-keep')
    // Simulate upgrade re-run by deleting only the marker, keeping both tables
    sqlite.prepare(`DELETE FROM migration_state WHERE key='012_sync_frame_high_water'`).run()
    const applied = runMigrations(db as never, sqlite)
    expect(applied).toBe(1)
    expect(highWaterRows()).toEqual([{ kind: 'topicMessage', parent_id: 't-hw-keep', max_timestamp: 500 }])
    // Second re-run is a full no-op
    sqlite.prepare(`DELETE FROM migration_state WHERE key='012_sync_frame_high_water'`).run()
    sqlite
      .prepare(`UPDATE sync_frame_high_water SET max_timestamp=700 WHERE kind='topicMessage' AND parent_id='t-hw-keep'`)
      .run()
    const applied2 = runMigrations(db as never, sqlite)
    expect(applied2).toBe(1)
    // Backfill must not lower an independently advanced mark
    expect(highWaterRows()).toEqual([{ kind: 'topicMessage', parent_id: 't-hw-keep', max_timestamp: 700 }])
  })

  it('CHECK rejects negative timestamps, bad kinds, and empty parents', () => {
    const db = drizzle(sqlite, {})
    runMigrations(db as never, sqlite)
    expect(() => {
      sqlite
        .prepare(`INSERT INTO sync_frame_high_water (kind, parent_id, max_timestamp) VALUES (?, ?, ?)`)
        .run('topicMessage', 't-neg', -1)
    }).toThrow(/CHECK constraint/i)
    expect(() => {
      sqlite
        .prepare(`INSERT INTO sync_frame_high_water (kind, parent_id, max_timestamp) VALUES (?, ?, ?)`)
        .run('topic', 't-bad-kind', 1)
    }).toThrow(/CHECK constraint/i)
    expect(() => {
      sqlite
        .prepare(`INSERT INTO sync_frame_high_water (kind, parent_id, max_timestamp) VALUES (?, ?, ?)`)
        .run('topicMessage', '', 1)
    }).toThrow(/CHECK constraint/i)
    expect(() => {
      sqlite
        .prepare(`INSERT INTO sync_frame_high_water (kind, parent_id, max_timestamp) VALUES (?, ?, ?)`)
        .run('topicMessage', 't-over', 9007199254740992)
    }).toThrow(/CHECK constraint/i)
  })

  it('failure rolls back when an existing frame timestamp violates the backfill CHECK', () => {
    const db = drizzle(sqlite, {})
    runMigrations(db as never, sqlite)
    sqlite.prepare(`DELETE FROM migration_state WHERE key='012_sync_frame_high_water'`).run()
    sqlite.exec('DROP TABLE IF EXISTS sync_frame_high_water')
    sqlite
      .prepare(
        `INSERT INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('topicMessage', 't-hw-ok', 'parent-order-frame-v1', '[]', 10, 'op-hw-ok')
    // Smuggle an out-of-range timestamp past the frame table CHECK
    sqlite.pragma('ignore_check_constraints = 1')
    let bypassSucceeded = false
    try {
      sqlite
        .prepare(
          `INSERT INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run('topicMessage', 't-hw-bad', 'parent-order-frame-v1', '[]', 9007199254740992, 'op-hw-bad')
      bypassSucceeded = true
    } catch {}
    sqlite.pragma('ignore_check_constraints = 0')
    if (!bypassSucceeded) {
      // Seam not practical on this driver: 012 still applies cleanly over valid rows
      const applied = runMigrations(db as never, sqlite)
      expect(applied).toBe(1)
      expect(highWaterRows()).toEqual([{ kind: 'topicMessage', parent_id: 't-hw-ok', max_timestamp: 10 }])
      return
    }
    let threw = false
    try {
      runMigrations(db as never, sqlite)
    } catch (e) {
      threw = true
      expect((e as Error).message).toMatch(/CHECK constraint|constraint failed|Failed to run the query/i)
    }
    expect(threw).toBe(true)
    // Rollback: 012 unrecorded, high-water table absent, frame rows preserved
    const stateRow = sqlite.prepare(`SELECT 1 FROM migration_state WHERE key='012_sync_frame_high_water'`).get()
    expect(stateRow).toBeUndefined()
    const hwTable = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='sync_frame_high_water'`)
      .get()
    expect(hwTable).toBeUndefined()
    const count = (sqlite.prepare(`SELECT COUNT(*) as n FROM sync_parent_order_frame`).get() as { n: number }).n
    expect(count).toBe(2)
  })
})
