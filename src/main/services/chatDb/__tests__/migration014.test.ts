/**
 * Migration 014_sync_resend_attempt:
 * - Creates sync_resend_attempt with message_id PK, colon-free attempt_id
 *   1..256, topic/ask identity, safe reset_timestamp, and strict JSON
 *   removed_block_ids_json plus a topic_id index (SYNC-DATA-055 intent slice)
 * - No backfill: messages never reset have no row
 * - Registry count 14, idempotent, strict CHECKs, restart durable
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

import { MIGRATIONS, runMigrations } from '../migration'

let sqlite: Database.Database
let tempDirs: string[] = []

function openDb(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

beforeEach(() => {
  sqlite = openDb()
  tempDirs = []
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
})

describe('014_sync_resend_attempt', () => {
  it('is registered as 14th migration with correct DDL and no backfill', () => {
    expect(MIGRATIONS.length).toBe(14)
    expect(MIGRATIONS[13].key).toBe('014_sync_resend_attempt')
    const joined = MIGRATIONS[13].sql.join(' ')
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS sync_resend_attempt')
    expect(joined).toContain('message_id TEXT PRIMARY KEY')
    expect(joined).toContain('attempt_id TEXT NOT NULL')
    expect(joined).toContain("attempt_id NOT LIKE '%:%'")
    expect(joined).toContain('topic_id TEXT NOT NULL')
    expect(joined).toContain('ask_id TEXT')
    expect(joined).toContain('CHECK (reset_timestamp >= 0 AND reset_timestamp <= 9007199254740991)')
    expect(joined).toContain('CHECK (json_valid(removed_block_ids_json))')
    expect(joined).toContain('CREATE INDEX IF NOT EXISTS sync_resend_attempt_topic_id_idx')
    // History not rewritten: 013 definition unchanged
    expect(MIGRATIONS[12].key).toBe('013_sync_stable_replace_register')
  })

  it('fresh database creates an empty intent table (14 migrations)', () => {
    const db = drizzle(sqlite, {})
    const applied = runMigrations(db as never, sqlite)
    expect(applied).toBe(14)
    const tbl = sqlite
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sync_resend_attempt'`)
      .get() as { sql: string }
    expect(tbl.sql).toContain('PRIMARY KEY')
    // Identity-only columns: no content, credential, or path storage
    const cols = (sqlite.prepare(`PRAGMA table_info(sync_resend_attempt)`).all() as Array<{ name: string }>).map(
      (c) => c.name
    )
    expect(cols).toEqual([
      'message_id',
      'attempt_id',
      'topic_id',
      'ask_id',
      'reset_timestamp',
      'removed_block_ids_json'
    ])
    const rows = sqlite.prepare(`SELECT * FROM sync_resend_attempt`).all()
    expect(rows).toEqual([])
  })

  it('upgrade from pre-014 keeps existing rows and adds the empty intent table', () => {
    const db = drizzle(sqlite, {})
    runMigrations(db as never, sqlite)
    sqlite.prepare(`DELETE FROM migration_state WHERE key='014_sync_resend_attempt'`).run()
    sqlite.exec('DROP TABLE IF EXISTS sync_resend_attempt')
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run('t-keep', 'keep', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z')
    const applied = runMigrations(db as never, sqlite)
    expect(applied).toBe(1)
    const topic = sqlite.prepare(`SELECT id FROM topics WHERE id='t-keep'`).get()
    expect(topic).toBeDefined()
    expect(sqlite.prepare(`SELECT * FROM sync_resend_attempt`).all()).toEqual([])
  })

  it('intent row survives close/reopen (restart durability) and re-run is a no-op', () => {
    const dir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-mig014-'))
    tempDirs.push(dir)
    const dbPath = realPath.join(dir, 'chat.db')
    const first = new Database(dbPath)
    first.pragma('journal_mode = WAL')
    first.pragma('foreign_keys = ON')
    runMigrations(drizzle(first, {}) as never, first)
    first
      .prepare(
        `INSERT INTO sync_resend_attempt (message_id, attempt_id, topic_id, ask_id, reset_timestamp, removed_block_ids_json) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('m-1', 'attempt-1', 't-1', 'a-1', 1000, JSON.stringify(['b-old']))
    first.close()

    const second = new Database(dbPath)
    second.pragma('journal_mode = WAL')
    second.pragma('foreign_keys = ON')
    const applied = runMigrations(drizzle(second, {}) as never, second)
    expect(applied).toBe(0)
    const row = second.prepare(`SELECT * FROM sync_resend_attempt WHERE message_id='m-1'`).get() as {
      attempt_id: string
      removed_block_ids_json: string
    }
    expect(row.attempt_id).toBe('attempt-1')
    expect(JSON.parse(row.removed_block_ids_json)).toEqual(['b-old'])
    second.close()
  })

  it('CHECK rejects empty ids, colon/bad attemptIds, bad timestamps, and invalid JSON', () => {
    const db = drizzle(sqlite, {})
    runMigrations(db as never, sqlite)
    const insert = (
      mid: string,
      attempt: string,
      topic: string,
      ask: string | null,
      ts: number,
      removed: string
    ): void => {
      sqlite
        .prepare(
          `INSERT INTO sync_resend_attempt (message_id, attempt_id, topic_id, ask_id, reset_timestamp, removed_block_ids_json) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(mid, attempt, topic, ask, ts, removed)
    }
    expect(() => insert('', 'a-1', 't-1', null, 1, '[]')).toThrow(/CHECK constraint/i)
    expect(() => insert('m-colon', 'a:b', 't-1', null, 1, '[]')).toThrow(/CHECK constraint/i)
    expect(() => insert('m-empty-attempt', '', 't-1', null, 1, '[]')).toThrow(/CHECK constraint/i)
    expect(() => insert('m-long-attempt', 'x'.repeat(257), 't-1', null, 1, '[]')).toThrow(/CHECK constraint/i)
    expect(() => insert('m-empty-topic', 'a-1', '', null, 1, '[]')).toThrow(/CHECK constraint/i)
    expect(() => insert('m-empty-ask', 'a-1', 't-1', '', 1, '[]')).toThrow(/CHECK constraint/i)
    expect(() => insert('m-neg', 'a-1', 't-1', null, -1, '[]')).toThrow(/CHECK constraint/i)
    expect(() => insert('m-over', 'a-1', 't-1', null, 9007199254740992, '[]')).toThrow(/CHECK constraint/i)
    expect(() => insert('m-bad-json', 'a-1', 't-1', null, 1, 'not-json')).toThrow(/CHECK constraint/i)
    expect(sqlite.prepare(`SELECT * FROM sync_resend_attempt`).all()).toEqual([])
  })
})
