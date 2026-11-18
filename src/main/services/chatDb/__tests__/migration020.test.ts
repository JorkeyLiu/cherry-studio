/**
 * Migration 020_topic_segment_header_identity (stable group head identity):
 * - Adds nullable `topic_segments.header_message_id` (no table rebuild) and
 *   backfills it deterministically from authority membership order
 *   (`sort_order ASC, message_id ASC` first member).
 * - A group with no members keeps a NULL head; membership rows, segment
 *   overflow keys and messages are untouched.
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

import { isSuccess } from '@shared/chatDb'

import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { MIGRATIONS, runMigrations } from '../migration'
import { createRepositories } from '../repository/factory'
import * as schema from '../schema'

const MIGRATION_KEY = '020_topic_segment_header_identity'

let sqlite: Database.Database
let tempDirs: string[] = []

function openDb(): Database.Database {
  const dir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-m020-'))
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

function okValue<T>(r: { ok: boolean; value?: T; error?: unknown }): T {
  if (!isSuccess(r as never)) throw new Error(`Expected success: ${JSON.stringify(r.error)}`)
  return (r as { value: T }).value
}

function messageJson(id: string, topicId: string, overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    topicId,
    role: 'user',
    content: `content-${id}`,
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

function blockJson(id: string, messageId: string): Record<string, unknown> {
  return {
    id,
    messageId,
    type: 'main_text',
    content: `block-${id}`,
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

describe('020_topic_segment_header_identity', () => {
  it('is registered last and only adds and backfills the head column', () => {
    expect(MIGRATIONS.length).toBe(20)
    expect(MIGRATIONS[19].key).toBe(MIGRATION_KEY)
    const joined = MIGRATIONS[19].sql.join(' ')
    expect(joined).toContain('ADD COLUMN header_message_id')
    expect(joined).toContain('ORDER BY')
    // Membership rows, segment overflow and messages are never rewritten.
    expect(joined).not.toContain('UPDATE messages')
    expect(joined).not.toContain('DELETE FROM topic_segment_messages')
    expect(joined).not.toContain('UPDATE topic_segments SET extra')
  })

  it('fresh DB: column exists, shipped backfill follows authority order, empty group keeps NULL head', () => {
    const db = drizzle(sqlite, { schema })
    expect(runMigrations(db as never, sqlite)).toBe(20)

    const columns = sqlite.prepare(`PRAGMA table_info(topic_segments)`).all() as Array<{ name: string }>
    expect(columns.map((c) => c.name)).toContain('header_message_id')

    const agg = new ChatDbAggregateService(db as never, sqlite)
    const topicId = 't-m020'
    for (const id of ['u1', 'a1', 'u3']) {
      okValue(
        agg.appendMessage(
          topicId,
          messageJson(id, topicId, id.startsWith('a') ? { role: 'assistant', askId: 'u1' } : {}) as never,
          [blockJson(`b-${id}`, id) as never]
        )
      )
    }
    const repos = createRepositories(db as never)

    // Group written through the API heads at its first member at creation.
    const segOrdered = 'seg-m020-ordered'
    okValue(agg.upsertSegment(segOrdered, topicId, 'Ordered', ['u1', 'a1', 'u3'], undefined))
    expect(repos.segments.getHeaderMessageId(segOrdered)).toBe('u1')

    // Scramble authority order underneath and clear the head, simulating a
    // pre-020 row that was never backfilled. The shipped backfill must follow
    // (sort_order, message_id) — not creation order or any rendered window.
    sqlite
      .prepare(`UPDATE topic_segment_messages SET sort_order = 5 WHERE segment_id = ? AND message_id = ?`)
      .run(segOrdered, 'u1')
    sqlite.prepare(`UPDATE topic_segments SET header_message_id = NULL WHERE id = ?`).run(segOrdered)

    // An empty group (segment row without membership) keeps a NULL head.
    sqlite
      .prepare(
        `INSERT INTO topic_segments (id, topic_id, name, created_at, updated_at, sort_order, extra) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('seg-m020-empty', topicId, 'Empty', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1, null)

    // Execute the migration's own backfill statements (everything after the
    // ADD COLUMN, which a real upgrade runs exactly once): ADD COLUMN is not
    // re-runnable by design, same as the earlier branch_id migration.
    const backfill = MIGRATIONS[19].sql.slice(1)
    expect(backfill.length).toBeGreaterThan(0)
    for (const stmt of backfill) sqlite.exec(stmt)
    // Remaining order is a1(1), u3(2), u1(5): the head backfills to a1, and
    // the empty group keeps a NULL head.
    expect(repos.segments.getHeaderMessageId(segOrdered)).toBe('a1')
    expect(repos.segments.getHeaderMessageId('seg-m020-empty')).toBeNull()
    // Membership survived the backfill untouched apart from the scramble.
    expect(repos.segments.getMessageIds(segOrdered).sort()).toEqual(['a1', 'u1', 'u3'])
    // Runner-level idempotency: nothing is pending and heads stay stable.
    expect(runMigrations(drizzle(sqlite, { schema }) as never, sqlite)).toBe(0)
    expect(repos.segments.getHeaderMessageId(segOrdered)).toBe('a1')
  })
})
