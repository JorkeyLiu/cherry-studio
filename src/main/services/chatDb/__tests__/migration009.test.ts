/**
 * Migration 009_sync_membership_clock: dedicated parent-membership clock.
 * - Additive table keyed by (child_entity_type, child_entity_id) for
 *   message/message_block only, storing parentId + timestamp + operationId.
 * - No backfill for pre-existing rows.
 * - Retains clock on delete/tombstone (not dropped).
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

describe('009_sync_membership_clock', () => {
  it('is registered with correct additive DDL', () => {
    expect(MIGRATIONS[8].key).toBe('009_sync_membership_clock')
    const joined = MIGRATIONS[8].sql.join(' ')
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS sync_membership_clock')
    expect(joined).toContain('child_entity_type TEXT NOT NULL')
    expect(joined).toContain("CHECK (child_entity_type IN ('message','message_block'))")
    expect(joined).toContain('PRIMARY KEY (child_entity_type, child_entity_id)')
    expect(joined).toContain('sync_membership_clock_parent_id_idx')
  })

  it('creates table with check and parent index and does not backfill existing rows', () => {
    const db = drizzle(sqlite, {})
    // First apply through 008 to get a pre-009 DB with business data
    runMigrations(db as never, sqlite)
    // Roll back to 008 state: drop 009 table and marker
    sqlite.exec('DROP TABLE IF EXISTS sync_membership_clock')
    sqlite.prepare(`DELETE FROM migration_state WHERE key='009_sync_membership_clock'`).run()
    // Seed business rows that existed BEFORE 009 (no trustworthy membership source)
    sqlite
      .prepare(`INSERT INTO topics (id, assistant_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run('t-legacy', 'a1', 'Legacy', '2026-01-01', '2026-01-01')
    sqlite
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('m-legacy', 't-legacy', 'user', 'hi', 'success', '2026-01-01', '2026-01-01', 0)
    sqlite
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('b-legacy', 'm-legacy', 'main_text', 'hello', 'success', '2026-01-01', '2026-01-01', 0)
    // Now apply 009 and assert no membership rows were fabricated
    const applied = runMigrations(db as never, sqlite)
    expect(applied).toBe(1)
    const count = (sqlite.prepare(`SELECT COUNT(*) as n FROM sync_membership_clock`).get() as { n: number }).n
    expect(count).toBe(0)
    const tables = sqlite
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sync_membership_clock'`)
      .get() as { sql: string } | undefined
    expect(tables?.sql).toContain("CHECK (child_entity_type IN ('message','message_block'))")
    const idx = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='sync_membership_clock_parent_id_idx'`)
      .get() as { name: string } | undefined
    expect(idx?.name).toBe('sync_membership_clock_parent_id_idx')
  })

  it('rejects invalid child type via CHECK', () => {
    const db = drizzle(sqlite, {})
    runMigrations(db as never, sqlite)
    expect(() => {
      sqlite
        .prepare(
          `INSERT INTO sync_membership_clock (child_entity_type, child_entity_id, parent_id, timestamp, operation_id) VALUES (?, ?, ?, ?, ?)`
        )
        .run('topic', 't-1', 'p-1', 1, 'op-1')
    }).toThrow(/CHECK constraint/i)
  })

  it('re-running migration does not fabricate clocks for existing membership rows', () => {
    const db = drizzle(sqlite, {})
    runMigrations(db as never, sqlite)
    sqlite
      .prepare(
        `INSERT INTO sync_membership_clock (child_entity_type, child_entity_id, parent_id, timestamp, operation_id) VALUES (?, ?, ?, ?, ?)`
      )
      .run('message', 'm-keep', 't-keep', 123, 'op-keep')
    const before = (sqlite.prepare(`SELECT COUNT(*) as n FROM sync_membership_clock`).get() as { n: number }).n
    expect(before).toBe(1)
    // Simulate upgrade re-run by deleting only 009 marker
    sqlite.prepare(`DELETE FROM migration_state WHERE key='009_sync_membership_clock'`).run()
    const applied = runMigrations(db as never, sqlite)
    expect(applied).toBe(1)
    const after = (sqlite.prepare(`SELECT COUNT(*) as n FROM sync_membership_clock`).get() as { n: number }).n
    expect(after).toBe(1)
    const row = sqlite
      .prepare(
        `SELECT parent_id as parentId, timestamp, operation_id as operationId FROM sync_membership_clock WHERE child_entity_type='message' AND child_entity_id='m-keep'`
      )
      .get() as { parentId: string; timestamp: number; operationId: string }
    expect(row).toEqual({ parentId: 't-keep', timestamp: 123, operationId: 'op-keep' })
  })
})
