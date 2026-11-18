/**
 * Migration 019_retire_segment_fold (idempotent marker retirement):
 * - Removes only `topic_segments.extra.folded`.
 * - Every other segment extra key (color/foldSelected/useful/unknown) and
 *   every membership row survives.
 * - `messages.extra` is never rewritten, so message-level fold markers stay.
 * - NULL / non-JSON extra never breaks the migration.
 * - Re-running is a no-op. Memory/temp DBs only; no real profile is touched.
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

const MIGRATION_KEY = '019_retire_segment_fold'

let sqlite: Database.Database
let tempDirs: string[] = []

function openDb(): Database.Database {
  const dir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-m019-'))
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
  } catch {
    // ignore
  }
  for (const dir of tempDirs) {
    try {
      realFs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
  tempDirs = []
})

/** Re-apply only this migration by clearing its recorded key. */
function rerunThisMigration(): number {
  sqlite.prepare(`DELETE FROM migration_state WHERE key = ?`).run(MIGRATION_KEY)
  return runMigrations(drizzle(sqlite, { schema }) as never, sqlite)
}

describe('019_retire_segment_fold', () => {
  it('is registered second-to-last and touches only the segment extra key', () => {
    expect(MIGRATIONS.length).toBe(20)
    expect(MIGRATIONS[18].key).toBe(MIGRATION_KEY)
    const joined = MIGRATIONS[18].sql.join(' ')
    expect(joined).toContain('UPDATE topic_segments')
    expect(joined).toContain(`json_remove(extra, '$.folded')`)
    // Never rewrites message state: message-level fold must survive.
    expect(joined).not.toContain('UPDATE messages')
    expect(joined).not.toContain('DELETE FROM topic_segment_messages')
  })

  it('clears the legacy marker, keeps sibling extra keys and message folds, and is idempotent', () => {
    const db = drizzle(sqlite, { schema })
    expect(runMigrations(db as never, sqlite)).toBe(20)

    sqlite.prepare(`INSERT INTO topics (id, assistant_id, name) VALUES ('t1', 'a1', 'Topic')`).run()
    sqlite
      .prepare(
        `INSERT INTO topic_segments (id, topic_id, name, created_at, updated_at, sort_order, extra) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'seg-a',
        't1',
        'With fold',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        0,
        JSON.stringify({
          folded: true,
          color: '#112233',
          foldSelected: true,
          useful: false,
          unknownKey: { deep: [1, 2] }
        })
      )
    sqlite
      .prepare(
        `INSERT INTO topic_segments (id, topic_id, name, created_at, updated_at, sort_order, extra) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'seg-b',
        't1',
        'Color only',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        1,
        JSON.stringify({ color: '#445566' })
      )
    sqlite
      .prepare(
        `INSERT INTO topic_segments (id, topic_id, name, created_at, updated_at, sort_order, extra) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('seg-c', 't1', 'No extra', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 2, null)
    sqlite
      .prepare(
        `INSERT INTO topic_segments (id, topic_id, name, created_at, updated_at, sort_order, extra) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('seg-d', 't1', 'Broken extra', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 3, 'not json at all')
    // Parent first: membership rows are FK-bound to both segment and message.
    sqlite
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, created_at, sort_order, extra) VALUES ('m1', 't1', 'user', 'hi', 'success', '2026-01-01T00:00:00.000Z', 0, ?)`
      )
      .run(JSON.stringify({ folded: true, keepMe: 1 }))
    sqlite
      .prepare(`INSERT INTO topic_segment_messages (segment_id, message_id, sort_order) VALUES ('seg-a', 'm1', 0)`)
      .run()

    expect(rerunThisMigration()).toBe(1)

    const segments = sqlite.prepare(`SELECT id, extra FROM topic_segments ORDER BY id`).all() as Array<{
      id: string
      extra: string | null
    }>
    const byId = new Map(segments.map((row) => [row.id, row.extra]))
    expect(JSON.parse(byId.get('seg-a')!)).toEqual({
      color: '#112233',
      foldSelected: true,
      useful: false,
      unknownKey: { deep: [1, 2] }
    })
    // Untouched rows keep their extra verbatim.
    expect(byId.get('seg-b')).toBe(JSON.stringify({ color: '#445566' }))
    expect(byId.get('seg-c')).toBeNull()
    expect(byId.get('seg-d')).toBe('not json at all')

    // Membership and message-level fold are out of scope.
    const members = sqlite.prepare(`SELECT message_id FROM topic_segment_messages`).all() as Array<{
      message_id: string
    }>
    expect(members.map((m) => m.message_id)).toEqual(['m1'])
    const message = sqlite.prepare(`SELECT extra FROM messages WHERE id = 'm1'`).get() as { extra: string }
    expect(JSON.parse(message.extra)).toEqual({ folded: true, keepMe: 1 })

    // Idempotent: a second application changes nothing and leaves no marker.
    expect(rerunThisMigration()).toBe(1)
    const after = sqlite.prepare(`SELECT id, extra FROM topic_segments ORDER BY id`).all() as Array<{
      id: string
      extra: string | null
    }>
    expect(after.map((row) => row.extra)).toEqual(segments.map((row) => row.extra))
    const markerLeft = sqlite
      .prepare(
        `SELECT id FROM topic_segments WHERE extra IS NOT NULL AND json_valid(extra) AND json_type(extra, '$.folded') IS NOT NULL`
      )
      .all()
    expect(markerLeft).toEqual([])
  })

  it('is top-level scoped: a nested `folded` key is data, not a legacy marker', () => {
    const db = drizzle(sqlite, { schema })
    expect(runMigrations(db as never, sqlite)).toBe(20)
    sqlite.prepare(`INSERT INTO topics (id, assistant_id, name) VALUES ('t1', 'a1', 'Topic')`).run()
    sqlite
      .prepare(
        `INSERT INTO topic_segments (id, topic_id, name, created_at, updated_at, sort_order, extra) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'seg-nested',
        't1',
        'Nested fold',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        0,
        JSON.stringify({ folded: true, nested: { folded: true, color: 1 }, list: [{ folded: 2 }] })
      )

    expect(rerunThisMigration()).toBe(1)

    const row = sqlite.prepare(`SELECT extra FROM topic_segments WHERE id = 'seg-nested'`).get() as {
      extra: string
    }
    // Only `$.folded` is removed; a `folded` key inside a nested object or array
    // element is ordinary unknown data and survives verbatim.
    expect(JSON.parse(row.extra)).toEqual({ nested: { folded: true, color: 1 }, list: [{ folded: 2 }] })

    // Re-running stays a no-op on that row (the nested keys never match).
    expect(rerunThisMigration()).toBe(1)
    const again = sqlite.prepare(`SELECT extra FROM topic_segments WHERE id = 'seg-nested'`).get() as {
      extra: string
    }
    expect(again.extra).toBe(row.extra)
  })

  it('a fresh database records the migration with nothing to clean', () => {
    const db = drizzle(sqlite, { schema })
    expect(runMigrations(db as never, sqlite)).toBe(20)
    const state = sqlite.prepare(`SELECT key FROM migration_state WHERE key = ?`).get(MIGRATION_KEY)
    expect(state).toBeTruthy()
    expect(runMigrations(db as never, sqlite)).toBe(0)
  })
})
