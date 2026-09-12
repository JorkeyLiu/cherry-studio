/**
 * Migration 013_sync_stable_replace_register:
 * - Creates sync_stable_replace_register with message_id PK, safe clock
 *   bounds, strict JSON active_block_ids_json, and payload_hash
 *   (SYNC-DATA-051 receiver-first slice)
 * - No backfill: messages without an accepted replacement have no row
 * - Registry count 13, idempotent, strict CHECKs, reopen durable
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

describe('013_sync_stable_replace_register', () => {
  it('is registered as 13th migration with correct DDL and no backfill', () => {
    expect(MIGRATIONS.length).toBe(13)
    expect(MIGRATIONS[12].key).toBe('013_sync_stable_replace_register')
    const joined = MIGRATIONS[12].sql.join(' ')
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS sync_stable_replace_register')
    expect(joined).toContain('message_id TEXT PRIMARY KEY')
    expect(joined).toContain('CHECK (timestamp >= 0 AND timestamp <= 9007199254740991)')
    expect(joined).toContain("operation_id NOT LIKE '%:%'")
    expect(joined).toContain('CHECK (json_valid(active_block_ids_json))')
    expect(joined).toContain('payload_hash TEXT NOT NULL')
    // History not rewritten: 012 definition unchanged
    expect(MIGRATIONS[11].key).toBe('012_sync_frame_high_water')
  })

  it('fresh database creates an empty register table', () => {
    const db = drizzle(sqlite, {})
    const applied = runMigrations(db as never, sqlite)
    expect(applied).toBe(13)
    const tbl = sqlite
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sync_stable_replace_register'`)
      .get() as { sql: string }
    expect(tbl.sql).toContain('PRIMARY KEY')
    const rows = sqlite.prepare(`SELECT * FROM sync_stable_replace_register`).all()
    expect(rows).toEqual([])
  })

  it('upgrade from pre-013 keeps existing rows and adds the empty register', () => {
    const db = drizzle(sqlite, {})
    runMigrations(db as never, sqlite)
    sqlite.prepare(`DELETE FROM migration_state WHERE key='013_sync_stable_replace_register'`).run()
    sqlite.exec('DROP TABLE IF EXISTS sync_stable_replace_register')
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run('t-keep', 'keep', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z')
    const applied = runMigrations(db as never, sqlite)
    expect(applied).toBe(1)
    const topic = sqlite.prepare(`SELECT id FROM topics WHERE id='t-keep'`).get()
    expect(topic).toBeDefined()
    expect(sqlite.prepare(`SELECT * FROM sync_stable_replace_register`).all()).toEqual([])
  })

  it('reopen sees the register table durably and re-run is a no-op', () => {
    const db = drizzle(sqlite, {})
    runMigrations(db as never, sqlite)
    sqlite
      .prepare(
        `INSERT INTO sync_stable_replace_register (message_id, timestamp, operation_id, active_block_ids_json, payload_hash) VALUES (?, ?, ?, ?, ?)`
      )
      .run('m-1', 1000, 'rep-op-1', JSON.stringify(['b-1']), 'deadbeef')
    const applied = runMigrations(db as never, sqlite)
    expect(applied).toBe(0)
    const row = sqlite.prepare(`SELECT * FROM sync_stable_replace_register WHERE message_id='m-1'`).get() as {
      timestamp: number
    }
    expect(row.timestamp).toBe(1000)
  })

  it('CHECK rejects empty ids, negative/unsafe timestamps, colon/bad operationIds, and invalid JSON', () => {
    const db = drizzle(sqlite, {})
    runMigrations(db as never, sqlite)
    const insert = (mid: string, ts: number, opId: string, active: string, hash: string): void => {
      sqlite
        .prepare(
          `INSERT INTO sync_stable_replace_register (message_id, timestamp, operation_id, active_block_ids_json, payload_hash) VALUES (?, ?, ?, ?, ?)`
        )
        .run(mid, ts, opId, active, hash)
    }
    expect(() => insert('', 1, 'op-1', '[]', 'h')).toThrow(/CHECK constraint/i)
    expect(() => insert('m-neg', -1, 'op-1', '[]', 'h')).toThrow(/CHECK constraint/i)
    expect(() => insert('m-over', 9007199254740992, 'op-1', '[]', 'h')).toThrow(/CHECK constraint/i)
    expect(() => insert('m-colon', 1, 'a:b', '[]', 'h')).toThrow(/CHECK constraint/i)
    expect(() => insert('m-empty-op', 1, '', '[]', 'h')).toThrow(/CHECK constraint/i)
    expect(() => insert('m-long-op', 1, 'x'.repeat(257), '[]', 'h')).toThrow(/CHECK constraint/i)
    expect(() => insert('m-bad-json', 1, 'op-1', 'not-json', 'h')).toThrow(/CHECK constraint/i)
    expect(() => insert('m-empty-hash', 1, 'op-1', '[]', '')).toThrow(/CHECK constraint/i)
    expect(sqlite.prepare(`SELECT * FROM sync_stable_replace_register`).all()).toEqual([])
  })
})
