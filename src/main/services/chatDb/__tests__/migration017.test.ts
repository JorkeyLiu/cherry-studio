/**
 * Migration 017_cleanup_route_message_overlay (idempotent ghost cleanup):
 * - Drops the unshipped `message_route_overlays` ghost table + related old
 *   indexes IF EXISTS (withdrawn 017_route_message_overlay model).
 * - Clears the stale `017_route_message_overlay` migration_state row.
 * - Fresh databases are a no-op; old dev databases recover the
 *   branch_id-ownership + topic_branches-ancestry model.
 * - The 017 number is burned; the next future migration must be 018.
 * - Registry count 17, last key cleanup. No down migration, never reads or
 *   migrates real profiles (memory/file temp DBs only).
 */
import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')
vi.mock('@main/config', () => ({ DATA_PATH: '/tmp' }))
vi.mock('../../SpanCacheService', () => ({
  spanCacheService: { cleanTopic: vi.fn().mockResolvedValue(undefined) }
}))

import { MIGRATIONS, runMigrations } from '../migration'
import * as schema from '../schema'

let sqlite: Database.Database
let tempDirs: string[] = []

function openDb(): Database.Database {
  const dir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-m017-'))
  tempDirs.push(dir)
  const s = new Database(realPath.join(dir, 'chat.db'))
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
  for (const dir of tempDirs) {
    try {
      realFs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
  tempDirs = []
})

describe('017_cleanup_route_message_overlay', () => {
  it('is registered as 17th migration with cleanup DDL and burns the 017 number', () => {
    expect(MIGRATIONS.length).toBe(17)
    expect(MIGRATIONS[15].key).toBe('016_topic_branches')
    expect(MIGRATIONS[16].key).toBe('017_cleanup_route_message_overlay')
    const joined = MIGRATIONS[16].sql.join(' ')
    expect(joined).toContain('DROP TABLE IF EXISTS message_route_overlays')
    expect(joined).toContain(`DELETE FROM migration_state WHERE key='017_route_message_overlay'`)
    // Cleanup only; never defines the overlay model.
    expect(joined).not.toContain('CREATE TABLE')
    expect(joined).not.toContain('message_patch_json')
    // History not rewritten.
    expect(MIGRATIONS[14].key).toBe('015_thinking_block_order_repair')
  })

  it('fresh database applies 17 migrations; rerun is idempotent; sqlite_master has no overlay', () => {
    const db = drizzle(sqlite, { schema })
    expect(runMigrations(db as never, sqlite)).toBe(17)
    const ghost = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='message_route_overlays'`)
      .get()
    expect(ghost).toBeFalsy()
    const ghostIndexes = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%route_overlay%'`)
      .all() as Array<{ name: string }>
    expect(ghostIndexes).toEqual([])
    const ghostState = sqlite.prepare(`SELECT key FROM migration_state WHERE key='017_route_message_overlay'`).get()
    expect(ghostState).toBeFalsy()
    const cleanupState = sqlite
      .prepare(`SELECT key FROM migration_state WHERE key='017_cleanup_route_message_overlay'`)
      .get()
    expect(cleanupState).toBeTruthy()
    // Branch model intact after cleanup.
    const branchTable = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='topic_branches'`)
      .get()
    expect(branchTable).toBeTruthy()
    expect(runMigrations(db as never, sqlite)).toBe(0)
  })

  it('old dev database with ghost table/index + stale 017 state is cleaned; new cleanup state recorded', () => {
    const db = drizzle(sqlite, { schema })
    runMigrations(db as never, sqlite)
    // Simulate an old dev database that executed the withdrawn overlay model:
    // ghost table + representative index + stale migration_state row, then
    // clear the cleanup record so the cleanup migration re-runs.
    sqlite.prepare(`DELETE FROM migration_state WHERE key='017_cleanup_route_message_overlay'`).run()
    sqlite
      .prepare(
        `CREATE TABLE message_route_overlays (id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, route_key TEXT NOT NULL, message_id TEXT NOT NULL)`
      )
      .run()
    sqlite
      .prepare(
        `CREATE INDEX message_route_overlays_topic_route_message_idx ON message_route_overlays(topic_id, route_key, message_id)`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO migration_state (key, value, updated_at) VALUES ('017_route_message_overlay', '017_route_message_overlay', '2026-01-01T00:00:00.000Z')`
      )
      .run()
    const applied = runMigrations(db as never, sqlite)
    expect(applied).toBe(1)
    const ghost = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='message_route_overlays'`)
      .get()
    expect(ghost).toBeFalsy()
    const ghostIndexes = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%route_overlay%'`)
      .all() as Array<{ name: string }>
    expect(ghostIndexes).toEqual([])
    const stale = sqlite.prepare(`SELECT key FROM migration_state WHERE key='017_route_message_overlay'`).get()
    expect(stale).toBeFalsy()
    const cleanupState = sqlite
      .prepare(`SELECT key FROM migration_state WHERE key='017_cleanup_route_message_overlay'`)
      .get()
    expect(cleanupState).toBeTruthy()
    expect(runMigrations(db as never, sqlite)).toBe(0)
  })
})
