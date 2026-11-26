/**
 * Migration 021_topic_segment_single_membership (single-membership structural
 * guarantee): a unique index on topic_segment_messages(message_id) so a
 * message can be filed under at most one group. The preflight fails closed on
 * any pre-existing multi-filed message and performs no repair. Memory/temp
 * DBs only; no real profile is touched.
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
import {
  MIGRATIONS,
  MigrationSegmentMembershipError,
  runMigrations,
  TOPIC_SEGMENT_MESSAGES_MESSAGE_ID_UNIQ_INDEX
} from '../migration'
import { createRepositories } from '../repository/factory'
import * as schema from '../schema'

const MIGRATION_KEY = '021_topic_segment_single_membership'

let sqlite: Database.Database
let tempDirs: string[] = []

function openDb(): Database.Database {
  const dir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-m021-'))
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

function indexNames(): string[] {
  return (sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>).map(
    (r) => r.name
  )
}

function appliedKeys(): string[] {
  return (sqlite.prepare(`SELECT key FROM migration_state`).all() as Array<{ key: string }>).map((r) => r.key)
}

describe('021_topic_segment_single_membership', () => {
  it('is registered last and only adds the unique index (no repair, no rewrite)', () => {
    expect(MIGRATIONS.length).toBe(21)
    expect(MIGRATIONS[20].key).toBe(MIGRATION_KEY)
    const joined = MIGRATIONS[20].sql.join(' ')
    expect(joined).toContain(TOPIC_SEGMENT_MESSAGES_MESSAGE_ID_UNIQ_INDEX)
    expect(joined).toContain('CREATE UNIQUE INDEX')
    // No repair: no membership/segment/message row is ever rewritten or removed.
    expect(joined).not.toContain('DELETE FROM topic_segment_messages')
    expect(joined).not.toContain('UPDATE topic_segment_messages')
    expect(joined).not.toContain('DROP TABLE')
    expect(joined).not.toContain('UPDATE topic_segments')
    expect(joined).not.toContain('UPDATE messages')
  })

  it('fresh DB: unique index exists beside the legacy lookup index; raw double-filing fails at SQL level', () => {
    const db = drizzle(sqlite, { schema })
    expect(runMigrations(db as never, sqlite)).toBe(21)

    const names = indexNames()
    expect(names).toContain(TOPIC_SEGMENT_MESSAGES_MESSAGE_ID_UNIQ_INDEX)
    expect(names).toContain('topic_segment_messages_message_id_idx')

    const agg = new ChatDbAggregateService(db as never, sqlite)
    const topicId = 't-m021'
    for (const id of ['u1', 'a1']) {
      okValue(
        agg.appendMessage(
          topicId,
          messageJson(id, topicId, id === 'a1' ? { role: 'assistant', askId: 'u1' } : {}) as never,
          []
        )
      )
    }
    okValue(agg.upsertSegment({ segmentId: 'seg-a', topicId, name: 'A', messageIds: ['u1'], branchId: null }))
    okValue(agg.upsertSegment({ segmentId: 'seg-b', topicId, name: 'B', messageIds: ['a1'], branchId: null }))

    // Raw double-filing bypasses every writer guard and must still fail:
    // the unique index is the backstop.
    expect(() =>
      sqlite
        .prepare(`INSERT INTO topic_segment_messages (segment_id, message_id, sort_order) VALUES (?, ?, ?)`)
        .run('seg-b', 'u1', 1)
    ).toThrow(/UNIQUE/i)
    const repos = createRepositories(db as never)
    expect(repos.segments.getMessageIds('seg-a')).toEqual(['u1'])
    expect(repos.segments.getMessageIds('seg-b')).toEqual(['a1'])
  })

  it('overlap DB: preflight fails closed — unrecorded, untouched, never repaired', () => {
    const db = drizzle(sqlite, { schema })
    expect(runMigrations(db as never, sqlite)).toBe(21)

    const agg = new ChatDbAggregateService(db as never, sqlite)
    const topicId = 't-m021-overlap'
    for (const id of ['u1', 'a1', 'u2']) {
      okValue(
        agg.appendMessage(
          topicId,
          messageJson(id, topicId, id === 'a1' ? { role: 'assistant', askId: 'u1' } : {}) as never,
          []
        )
      )
    }
    okValue(agg.upsertSegment({ segmentId: 'seg-a', topicId, name: 'A', messageIds: ['u1', 'a1'], branchId: null }))
    okValue(agg.upsertSegment({ segmentId: 'seg-b', topicId, name: 'B', messageIds: ['u2'], branchId: null }))

    // Simulate a legacy pre-021 database: remove the unique enforcement and
    // file one message under two groups through raw SQL (every guarded writer
    // would reject this, which is exactly the legacy state under test).
    sqlite.exec(`DROP INDEX IF EXISTS ${TOPIC_SEGMENT_MESSAGES_MESSAGE_ID_UNIQ_INDEX}`)
    sqlite
      .prepare(`INSERT INTO topic_segment_messages (segment_id, message_id, sort_order) VALUES (?, ?, ?)`)
      .run('seg-b', 'u1', 1)
    sqlite.prepare(`DELETE FROM migration_state WHERE key = ?`).run(MIGRATION_KEY)
    const membershipBefore = sqlite.prepare(`SELECT COUNT(*) AS n FROM topic_segment_messages`).get() as { n: number }

    let thrown: unknown = null
    try {
      runMigrations(drizzle(sqlite, { schema }) as never, sqlite)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(MigrationSegmentMembershipError)
    // Fail closed: 021 stays unrecorded, rows are byte-identical (no repair).
    expect(appliedKeys()).not.toContain(MIGRATION_KEY)
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM topic_segment_messages`).get()).toEqual(membershipBefore)
    expect(indexNames()).not.toContain(TOPIC_SEGMENT_MESSAGES_MESSAGE_ID_UNIQ_INDEX)
    // The overlap is still exactly what it was — surfaced, not merged away.
    const holders = (
      sqlite
        .prepare(`SELECT segment_id FROM topic_segment_messages WHERE message_id = ? ORDER BY segment_id`)
        .all('u1') as Array<{
        segment_id: string
      }>
    ).map((r) => r.segment_id)
    expect(holders).toEqual(['seg-a', 'seg-b'])
  })

  it('clean DB re-run is a no-op', () => {
    const db = drizzle(sqlite, { schema })
    expect(runMigrations(db as never, sqlite)).toBe(21)
    expect(runMigrations(drizzle(sqlite, { schema }) as never, sqlite)).toBe(0)
  })
})
