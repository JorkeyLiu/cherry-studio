/**
 * Migration 010_sync_parent_order_frame: persistent per-parent winning-frame state.
 * - Additive table keyed by (kind, parent_id) for topicMessage/messageBlock only
 * - frame_version parent-order-frame-v1 stored explicitly
 * - ordered_child_ids_json strict JSON array of strings
 * - timestamp + operationId with checks
 * - No backfill for pre-existing rows
 * - Registry count propagation
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

describe('010_sync_parent_order_frame', () => {
  it('is registered with correct additive DDL and registry count', () => {
    expect(MIGRATIONS.length).toBe(10)
    expect(MIGRATIONS[9].key).toBe('010_sync_parent_order_frame')
    const joined = MIGRATIONS[9].sql.join(' ')
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS sync_parent_order_frame')
    expect(joined).toContain("CHECK (kind IN ('topicMessage','messageBlock'))")
    expect(joined).toContain("frame_version TEXT NOT NULL CHECK (frame_version = 'parent-order-frame-v1')")
    expect(joined).toContain('PRIMARY KEY (kind, parent_id)')
    expect(joined).toContain('json_valid(ordered_child_ids_json)')
    expect(joined).toContain('timestamp INTEGER NOT NULL')
    expect(joined).toContain('operation_id TEXT NOT NULL')
  })

  it('creates table with constraints and does not backfill existing parents', () => {
    const db = drizzle(sqlite, {})
    // Apply through 009 to get pre-010 DB with business data
    runMigrations(db as never, sqlite)
    // Roll back 010
    sqlite.exec('DROP TABLE IF EXISTS sync_parent_order_frame')
    sqlite.prepare(`DELETE FROM migration_state WHERE key='010_sync_parent_order_frame'`).run()
    // Seed business rows that existed BEFORE 010 (no frame should be fabricated)
    sqlite
      .prepare(`INSERT INTO topics (id, assistant_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run('t-legacy-010', 'a1', 'Legacy010', '2026-01-01', '2026-01-01')
    sqlite
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('m-legacy-010', 't-legacy-010', 'user', 'hi', 'success', '2026-01-01', '2026-01-01', 0)
    sqlite
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('b-legacy-010', 'm-legacy-010', 'main_text', 'hello', 'success', '2026-01-01', '2026-01-01', 0)
    // Now apply 010 and assert no frames fabricated
    const applied = runMigrations(db as never, sqlite)
    expect(applied).toBe(1)
    const count = (sqlite.prepare(`SELECT COUNT(*) as n FROM sync_parent_order_frame`).get() as { n: number }).n
    expect(count).toBe(0)
    const tbl = sqlite
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sync_parent_order_frame'`)
      .get() as { sql: string } | undefined
    expect(tbl?.sql).toContain("CHECK (kind IN ('topicMessage','messageBlock'))")
    expect(tbl?.sql).toContain("frame_version = 'parent-order-frame-v1'")
  })

  it('rejects invalid kind via CHECK', () => {
    const db = drizzle(sqlite, {})
    runMigrations(db as never, sqlite)
    expect(() => {
      sqlite
        .prepare(
          `INSERT INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run('invalidKind', 'p1', 'parent-order-frame-v1', '[]', 1, 'op-1')
    }).toThrow(/CHECK constraint/i)
  })

  it('rejects invalid frame_version via CHECK', () => {
    const db = drizzle(sqlite, {})
    runMigrations(db as never, sqlite)
    expect(() => {
      sqlite
        .prepare(
          `INSERT INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run('topicMessage', 'p1', 'wrong-version', '[]', 1, 'op-1')
    }).toThrow(/CHECK constraint/i)
  })

  it('rejects malformed ordered_child_ids_json via json_valid CHECK', () => {
    const db = drizzle(sqlite, {})
    runMigrations(db as never, sqlite)
    expect(() => {
      sqlite
        .prepare(
          `INSERT INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run('topicMessage', 'p1', 'parent-order-frame-v1', 'not-json', 1, 'op-1')
    }).toThrow(/CHECK constraint/i)
  })

  it('re-running migration does not fabricate frames for existing parents', () => {
    const db = drizzle(sqlite, {})
    runMigrations(db as never, sqlite)
    sqlite
      .prepare(
        `INSERT INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('topicMessage', 't-keep-010', 'parent-order-frame-v1', '[]', 123, 'op-keep-010')
    const before = (sqlite.prepare(`SELECT COUNT(*) as n FROM sync_parent_order_frame`).get() as { n: number }).n
    expect(before).toBe(1)
    sqlite.prepare(`DELETE FROM migration_state WHERE key='010_sync_parent_order_frame'`).run()
    const applied = runMigrations(db as never, sqlite)
    expect(applied).toBe(1)
    const after = (sqlite.prepare(`SELECT COUNT(*) as n FROM sync_parent_order_frame`).get() as { n: number }).n
    expect(after).toBe(1)
    const row = sqlite
      .prepare(
        `SELECT kind, parent_id as parentId, frame_version as frameVersion FROM sync_parent_order_frame WHERE kind='topicMessage' AND parent_id='t-keep-010'`
      )
      .get() as { kind: string; parentId: string; frameVersion: string }
    expect(row.frameVersion).toBe('parent-order-frame-v1')
  })

  it('idempotent re-run with existing 010 table and data preserves exactly', () => {
    const db = drizzle(sqlite, {})
    runMigrations(db as never, sqlite)
    // Insert a frame with children
    sqlite
      .prepare(
        `INSERT INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('messageBlock', 'm-keep-010', 'parent-order-frame-v1', JSON.stringify(['b1', 'b2']), 456, 'op-keep-b')
    const countBefore = (sqlite.prepare(`SELECT COUNT(*) as n FROM sync_parent_order_frame`).get() as { n: number }).n
    // Simulate upgrade re-run by deleting only marker, keeping table
    sqlite.prepare(`DELETE FROM migration_state WHERE key='010_sync_parent_order_frame'`).run()
    const applied = runMigrations(db as never, sqlite)
    expect(applied).toBe(1)
    const countAfter = (sqlite.prepare(`SELECT COUNT(*) as n FROM sync_parent_order_frame`).get() as { n: number }).n
    expect(countAfter).toBe(countBefore)
    const row = sqlite
      .prepare(
        `SELECT ordered_child_ids_json as json FROM sync_parent_order_frame WHERE kind='messageBlock' AND parent_id='m-keep-010'`
      )
      .get() as { json: string }
    expect(JSON.parse(row.json)).toEqual(['b1', 'b2'])
  })
})
