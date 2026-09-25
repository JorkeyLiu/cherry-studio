/**
 * Migration 016_topic_branches (final internal route-node model):
 * - `topic_branches(id PK, topic_id CASCADE, parent_branch_id self-CASCADE,
 *   anchor_message_id, name, timestamps, extra)` + topic/parent/anchor indexes
 * - `messages.branch_id` nullable (NULL = main route, non-NULL = owned by
 *   that branch, CASCADE on branch delete) + branch indexes
 * - Drops the disposable wrong-model child-topic lineage table if present
 *   (unshipped, never released — data need not be preserved)
 * - No backfill: existing topics/messages become main-route (branch_id NULL)
 * - Registry count 16, idempotent, upgrade preserves rows, FK cascades drop
 *   branch rows with their topics
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
  const dir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-m016-'))
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

describe('016_topic_branches', () => {
  it('is registered as 16th migration after 015 with route-node DDL', () => {
    expect(MIGRATIONS.length).toBe(16)
    expect(MIGRATIONS[15].key).toBe('016_topic_branches')
    const joined = MIGRATIONS[15].sql.join(' ')
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS topic_branches')
    expect(joined).toContain('parent_branch_id')
    expect(joined).toContain('anchor_message_id')
    expect(joined).toContain('topic_branches_topic_id_idx')
    expect(joined).toContain('topic_branches_parent_branch_id_idx')
    expect(joined).toContain('topic_branches_anchor_message_id_idx')
    expect(joined).toContain('branch_id')
    expect(joined).toContain('messages_branch_id_idx')
    // No fake root row, no child-topic parent_topic_id column.
    expect(joined).not.toContain('parent_topic_id')
    // History not rewritten.
    expect(MIGRATIONS[14].key).toBe('015_thinking_block_order_repair')
    expect(MIGRATIONS[13].key).toBe('014_sync_resend_attempt')
  })

  it('fresh database applies 16 migrations; rerun is idempotent', () => {
    const db = drizzle(sqlite, { schema })
    expect(runMigrations(db as never, sqlite)).toBe(16)
    const table = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='topic_branches'`).get()
    expect(table).toBeTruthy()
    const cols = sqlite.prepare(`PRAGMA table_info(topic_branches)`).all() as Array<{ name: string }>
    const names = cols.map((c) => c.name)
    expect(names).toEqual(expect.arrayContaining(['id', 'topic_id', 'parent_branch_id', 'anchor_message_id', 'name']))
    const msgCols = sqlite.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>
    expect(msgCols.map((c) => c.name)).toContain('branch_id')
    // FTS companion stays intact.
    const fts = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='message_blocks_fts'`).get()
    expect(fts).toBeTruthy()
    expect(runMigrations(db as never, sqlite)).toBe(0)
  })

  it('upgrade from pre-016 preserves rows and adds empty branch tables/columns', () => {
    const db = drizzle(sqlite, { schema })
    runMigrations(db as never, sqlite)
    // Reconstruct the pre-016 state: drop the 016 branch artifacts (table,
    // indexes, messages.branch_id column) and clear its migration_state row.
    sqlite.prepare(`DELETE FROM migration_state WHERE key='016_topic_branches'`).run()
    sqlite.prepare(`DROP TABLE IF EXISTS topic_branches`).run()
    sqlite.prepare(`DROP INDEX IF EXISTS messages_topic_id_branch_id_sort_order_idx`).run()
    sqlite.prepare(`DROP INDEX IF EXISTS messages_branch_id_idx`).run()
    sqlite.prepare(`ALTER TABLE messages DROP COLUMN branch_id`).run()
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run('t-pre016', 't', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    const applied = runMigrations(db as never, sqlite)
    expect(applied).toBe(1)
    const topic = sqlite.prepare(`SELECT id FROM topics WHERE id='t-pre016'`).get()
    expect(topic).toBeTruthy()
    const count = sqlite.prepare(`SELECT COUNT(*) AS n FROM topic_branches`).get() as { n: number }
    expect(count.n).toBe(0)
    const msgCols = sqlite.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>
    expect(msgCols.map((c) => c.name)).toContain('branch_id')
  })

  it('topic deletion cascades its branch rows; anchor message is not FK-bound', () => {
    const db = drizzle(sqlite, { schema })
    runMigrations(db as never, sqlite)
    const now = '2026-01-01T00:00:00.000Z'
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run('t-1', 't', now, now)
    // The anchor message ID is stored opaquely (no FK to messages): a branch
    // may fork from an inherited message owned by any ancestor route, and Main
    // validates anchor membership in the effective route at creation time.
    sqlite
      .prepare(
        `INSERT INTO topic_branches (id, topic_id, parent_branch_id, anchor_message_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('b-1', 't-1', null, 'm-anchor', 'B1', now, now)
    sqlite.prepare(`DELETE FROM topics WHERE id='t-1'`).run()
    const remaining = sqlite.prepare(`SELECT COUNT(*) AS n FROM topic_branches`).get() as { n: number }
    expect(remaining.n).toBe(0)
  })

  it('branch deletion cascades owned messages via branch_id FK backstop', () => {
    const db = drizzle(sqlite, { schema })
    runMigrations(db as never, sqlite)
    const now = '2026-01-01T00:00:00.000Z'
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run('t-1', 't', now, now)
    sqlite
      .prepare(
        `INSERT INTO topic_branches (id, topic_id, parent_branch_id, anchor_message_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('b-1', 't-1', null, 'm0', 'B1', now, now)
    sqlite
      .prepare(
        `INSERT INTO messages (id, topic_id, branch_id, role, content, status, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('m-owned', 't-1', 'b-1', 'user', 'hi', 'success', now, now, 1)
    sqlite.prepare(`DELETE FROM topic_branches WHERE id='b-1'`).run()
    const remaining = sqlite.prepare(`SELECT COUNT(*) AS n FROM messages WHERE id='m-owned'`).get() as { n: number }
    expect(remaining.n).toBe(0)
  })
})
