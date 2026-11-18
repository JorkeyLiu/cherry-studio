import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

vi.mock('@main/config', () => ({ DATA_PATH: '/mock/data' }))
const { mockCleanTopic } = vi.hoisted(() => ({ mockCleanTopic: vi.fn() }))
vi.mock('../../SpanCacheService', () => ({ spanCacheService: { cleanTopic: mockCleanTopic } }))

import { isSuccess } from '@shared/chatDb'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { runMigrations } from '../migration'
import { createRepositories } from '../repository/factory'
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-legacy-fold-'))
}
function rmrf(dir: string): void {
  realFs.rmSync(dir, { recursive: true, force: true })
}
function openTestDb(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  return db
}
function wrapDrizzle(sqlite: Database.Database): BetterSQLite3Database<typeof schema> {
  return drizzle(sqlite, { schema })
}
let counter = 0
function uid(): string {
  return `lf${++counter}-${Date.now()}`
}
function okValue<T>(r: { ok: boolean; value?: T; error?: unknown }): T {
  if (!isSuccess(r as any)) throw new Error(`Expected success: ${JSON.stringify((r as any).error)}`)
  return (r as any).value as T
}
function makeMsg(
  topicId: string,
  id: string,
  role: 'user' | 'assistant' | 'system',
  askId?: string | null
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id,
    topicId,
    role,
    content: `${role}-${id}`,
    status: 'success',
    createdAt: new Date().toISOString()
  }
  if (askId !== undefined) base.askId = askId
  return base
}
function makeBlock(messageId: string): Record<string, unknown> {
  return {
    id: `b-${uid()}`,
    messageId,
    type: 'main_text',
    content: `block-${messageId}`,
    status: 'success',
    createdAt: new Date().toISOString()
  }
}

describe('retired group-level collapse (topic_segments.extra.folded)', () => {
  let tmpDir: string
  let sqlite: Database.Database
  let db: BetterSQLite3Database<typeof schema>
  let agg: ChatDbAggregateService

  beforeEach(() => {
    tmpDir = makeTempDir()
    sqlite = openTestDb(realPath.join(tmpDir, 'test.db'))
    db = wrapDrizzle(sqlite)
    runMigrations(db, sqlite)
    agg = new ChatDbAggregateService(db, sqlite)
    mockCleanTopic.mockReset().mockResolvedValue(undefined)
  })
  afterEach(() => {
    try {
      sqlite.close()
    } catch {
      // ignore
    }
    rmrf(tmpDir)
  })

  /** Write the legacy marker straight into the row, exactly as an old build did. */
  function stampLegacySegmentFold(segmentId: string, extra: Record<string, unknown> = { color: '#abcdef' }): void {
    sqlite
      .prepare(`UPDATE topic_segments SET extra = ? WHERE id = ?`)
      .run(JSON.stringify({ ...extra, folded: true }), segmentId)
  }

  function seedTwoTurns(topicId: string): void {
    for (const m of [
      makeMsg(topicId, 'u1', 'user'),
      makeMsg(topicId, 'a1', 'assistant', 'u1'),
      makeMsg(topicId, 'u2', 'user'),
      makeMsg(topicId, 'a2', 'assistant', 'u2')
    ]) {
      agg.appendMessage(topicId, m as any, [makeBlock(m.id as string) as any])
    }
  }

  it('ignores the legacy group marker: members participate and the group still lists', () => {
    const topicId = `t-${uid()}`
    seedTwoTurns(topicId)
    const segmentId = `seg-${uid()}`
    okValue(agg.upsertSegment(segmentId, topicId, 'Group', ['u2', 'a2'], undefined))
    stampLegacySegmentFold(segmentId)

    const closure = okValue(agg.fetchContextClosure({ topicId, anchorGroupKey: 'u1' }))
    // No message-level fold exists, so nothing is excluded.
    expect(closure.closure.foldedMessageIds).toEqual([])
    expect(closure.messages.map((m: any) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(closure.closure.totalTurnCount).toBe(2)
    expect(closure.closure.selectedTurnCount).toBe(2)

    // The group is still an ordinary group: same members, no collapse state on
    // the read wire at all.
    const segments = okValue(agg.listSegments(topicId))
    expect(segments).toHaveLength(1)
    expect(segments[0].id).toBe(segmentId)
    expect(segments[0].messageIds).toEqual(['u2', 'a2'])
    expect(segments[0]).not.toHaveProperty('folded')
  })

  it('message-level fold still excludes while the legacy group marker changes nothing', () => {
    const topicId = `t-${uid()}`
    seedTwoTurns(topicId)
    const segmentId = `seg-${uid()}`
    okValue(agg.upsertSegment(segmentId, topicId, 'Group', ['u2', 'a2'], undefined))
    stampLegacySegmentFold(segmentId)

    for (const id of ['u2', 'a2']) {
      // Wire patch: an unknown top-level key is the overflow channel.
      okValue(agg.updateMessage(topicId, id, { folded: true } as any))
    }

    const closure = okValue(agg.fetchContextClosure({ topicId, anchorGroupKey: 'u1' }))
    // The message-level marker is the one that excludes: the folded turn leaves
    // the participating counts while the legacy group marker contributes
    // nothing (the raw window slice itself is preserved for the client).
    expect([...closure.closure.foldedMessageIds].sort()).toEqual(['a2', 'u2'])
    expect(closure.closure.totalTurnCount).toBe(1)
    expect(closure.closure.selectedTurnCount).toBe(1)
    expect(closure.messages.map((m: any) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  it('segment writes strip a stale legacy marker and never persist a new one', () => {
    const topicId = `t-${uid()}`
    seedTwoTurns(topicId)
    const segmentId = `seg-${uid()}`
    okValue(agg.upsertSegment(segmentId, topicId, 'Group', ['u1', 'a1'], undefined, undefined, true))
    const repos = createRepositories(db)
    expect(repos.segments.getById(segmentId).data?.overflow).not.toHaveProperty('folded')

    stampLegacySegmentFold(segmentId)

    // A metadata write strips the retired key while preserving the rest.
    okValue(agg.updateSegmentMetadata(segmentId, 'Renamed', '#123456'))
    const afterMetadata = repos.segments.getById(segmentId).data!
    expect(afterMetadata.overflow).not.toHaveProperty('folded')
    expect(afterMetadata.overflow.color).toBe('#123456')
    expect(afterMetadata.name).toBe('Renamed')

    stampLegacySegmentFold(segmentId)
    okValue(agg.upsertSegment(segmentId, topicId, 'Group again', ['u1', 'a1'], undefined, undefined, false))
    const afterUpsert = repos.segments.getById(segmentId).data!
    expect(afterUpsert.overflow).not.toHaveProperty('folded')
    // Membership is untouched by the retirement.
    expect(repos.segments.getMessageIds(segmentId)).toEqual(['u1', 'a1'])
  })
})
