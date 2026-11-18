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
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-turn-fold-'))
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
let counter = 0
function uid(): string {
  return `tf${++counter}-${Date.now()}`
}
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

describe('setTurnFolds — turn-level atomic fold', () => {
  let tmpDir: string
  let sqlite: Database.Database
  let db: BetterSQLite3Database<typeof schema>
  let agg: ChatDbAggregateService

  beforeEach(() => {
    tmpDir = makeTempDir()
    sqlite = openTestDb(realPath.join(tmpDir, 'test.db'))
    db = drizzle(sqlite, { schema })
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

  function seed(topicId: string, messages: Record<string, unknown>[]): void {
    for (const m of messages) {
      okValue(agg.appendMessage(topicId, m as never, [blockJson(`b-${m.id as string}`, m.id as string) as never]))
    }
  }
  function seedTwoturns(topicId: string): void {
    seed(topicId, [
      messageJson('u1', topicId),
      messageJson('a1', topicId, { role: 'assistant', askId: 'u1' }),
      messageJson('u2', topicId),
      messageJson('a2', topicId, { role: 'assistant', askId: 'u2' })
    ])
  }
  /** Raw persisted overflow object of one message row. */
  function rawExtra(messageId: string): Record<string, unknown> {
    const row = sqlite.prepare('SELECT extra FROM messages WHERE id = ?').get(messageId) as
      | { extra: string | null }
      | undefined
    if (!row?.extra) return {}
    return JSON.parse(row.extra) as Record<string, unknown>
  }
  /** Raw persisted rows carrying the fold marker, sorted for stable comparison. */
  function markedRows(topicId: string): string[] {
    return (
      sqlite
        .prepare(`SELECT id FROM messages WHERE topic_id = ? AND json_extract(extra, '$.folded') = 1 ORDER BY id`)
        .all(topicId) as { id: string }[]
    ).map((r) => r.id)
  }
  function closure(topicId: string, anchorGroupKey: string, branchId?: string) {
    return okValue(agg.fetchContextClosure({ topicId, anchorGroupKey, branchId }))
  }

  it('writes every member of the selected turn, resolving stable group ids outside the loaded window', () => {
    const topicId = `t-${uid()}`
    seedTwoturns(topicId)

    // Loaded window at u2: u1/a1 are outside it, yet the stable group id u1
    // still resolves to the complete turn.
    expect(closure(topicId, 'u2').messages.map((m: any) => m.id)).toEqual(['u2', 'a2'])

    const res = okValue(agg.setTurnFolds(topicId, ['u1'], true))
    expect(res.topicId).toBe(topicId)
    expect(res.folded).toBe(true)
    expect(res.turns).toHaveLength(1)
    expect(res.turns[0].groupId).toBe('u1')
    expect(res.turns[0].messageIds).toEqual(['u1', 'a1'])
    expect(res.turns[0].folded).toBe(true)
    expect(res.affectedMessageIds).toEqual(['u1', 'a1'])

    expect(markedRows(topicId)).toEqual(['a1', 'u1'])
    expect(rawExtra('u1').folded).toBe(true)
    expect(rawExtra('a1').folded).toBe(true)
    // The untouched turn keeps no marker at all.
    expect(rawExtra('u2')).not.toHaveProperty('folded')
    expect(rawExtra('a2')).not.toHaveProperty('folded')

    // Authority-wide participation: the window at u2 still reports the folded
    // rows of the window-outside turn, so the request filter agrees with rows.
    const after = closure(topicId, 'u2')
    expect([...after.closure.foldedMessageIds].sort()).toEqual(['a1', 'u1'])
    expect(after.messages.map((m: any) => m.id)).toEqual(['u2', 'a2'])

    // Fold only removes participation; the raw window slice is preserved.
    const anchored = closure(topicId, 'u1')
    expect(anchored.messages.map((m: any) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(anchored.closure.totalTurnCount).toBe(1)
    expect(anchored.closure.selectedTurnCount).toBe(1)
  })

  it('multi-turn selection writes each selected turn once, in effective route order', () => {
    const topicId = `t-${uid()}`
    seed(topicId, [
      messageJson('u1', topicId),
      messageJson('a1', topicId, { role: 'assistant', askId: 'u1' }),
      messageJson('a1b', topicId, { role: 'assistant', askId: 'u1' }),
      messageJson('u2', topicId),
      messageJson('a2', topicId, { role: 'assistant', askId: 'u2' })
    ])

    // Renderer order is irrelevant: the response is canonical.
    const res = okValue(agg.setTurnFolds(topicId, ['u2', 'u1'], true))
    expect(res.turns.map((t) => t.groupId)).toEqual(['u1', 'u2'])
    expect(res.turns[0].messageIds).toEqual(['u1', 'a1', 'a1b'])
    expect(res.turns[1].messageIds).toEqual(['u2', 'a2'])
    expect(res.affectedMessageIds).toEqual(['u1', 'a1', 'a1b', 'u2', 'a2'])
    expect(markedRows(topicId)).toEqual(['a1', 'a1b', 'a2', 'u1', 'u2'])
  })

  it('false removes the marker instead of persisting folded:false, and stays idempotent', () => {
    const topicId = `t-${uid()}`
    seedTwoturns(topicId)
    okValue(agg.setTurnFolds(topicId, ['u1'], true))
    expect(markedRows(topicId)).toEqual(['a1', 'u1'])

    const unfolded = okValue(agg.setTurnFolds(topicId, ['u1'], false))
    expect(unfolded.folded).toBe(false)
    expect(unfolded.turns[0].folded).toBe(false)
    expect(markedRows(topicId)).toEqual([])
    // The key is gone, not false.
    expect(rawExtra('u1')).not.toHaveProperty('folded')
    expect(rawExtra('a1')).not.toHaveProperty('folded')

    okValue(agg.setTurnFolds(topicId, ['u1'], false))
    expect(rawExtra('u1')).not.toHaveProperty('folded')
    const after = closure(topicId, 'u1')
    expect(after.closure.foldedMessageIds).toEqual([])
    expect(after.closure.totalTurnCount).toBe(2)
    expect(after.closure.selectedTurnCount).toBe(2)
  })

  it('reads a partially marked turn as one folded turn and repairs it on unfold', () => {
    const topicId = `t-${uid()}`
    seedTwoturns(topicId)
    // Partial legacy state: only the answer row carries the marker.
    sqlite.prepare('UPDATE messages SET extra = ? WHERE id = ?').run(JSON.stringify({ folded: true }), 'a1')

    const partial = closure(topicId, 'u1')
    expect([...partial.closure.foldedMessageIds].sort()).toEqual(['a1', 'u1'])
    expect(partial.closure.totalTurnCount).toBe(1)
    expect(partial.closure.selectedTurnCount).toBe(1)

    // Unfold repairs the partial state for the whole turn: no row keeps a
    // marker, so there is no row-level disagreement to display.
    okValue(agg.setTurnFolds(topicId, ['u1'], false))
    expect(markedRows(topicId)).toEqual([])
    expect(closure(topicId, 'u1').closure.foldedMessageIds).toEqual([])
  })

  it('rejects the whole selection (zero writes) on an unknown, duplicate, empty or foreign group id', () => {
    const topicId = `t-${uid()}`
    const otherTopicId = `t-${uid()}`
    seedTwoturns(topicId)
    seed(otherTopicId, [messageJson('x1', otherTopicId)])

    const unknown = agg.setTurnFolds(topicId, ['u1', 'nope'], true)
    expect(unknown.ok).toBe(false)
    expect((unknown as any).error.code).toBe('VALIDATION_ERROR')
    expect(markedRows(topicId)).toEqual([])
    expect(rawExtra('u1')).not.toHaveProperty('folded')
    expect(rawExtra('a1')).not.toHaveProperty('folded')

    // A group id of another topic is not on this route.
    expect(agg.setTurnFolds(topicId, ['x1'], true).ok).toBe(false)
    expect(markedRows(topicId)).toEqual([])
    expect(markedRows(otherTopicId)).toEqual([])

    expect(agg.setTurnFolds(topicId, [], true).ok).toBe(false)
    expect(agg.setTurnFolds(topicId, ['u1', 'u1'], true).ok).toBe(false)
    expect(agg.setTurnFolds(topicId, ['u1'], 'yes' as unknown as boolean).ok).toBe(false)
    expect(agg.setTurnFolds(topicId, ['u1'], true, 'missing-branch').ok).toBe(false)
    expect(markedRows(topicId)).toEqual([])
  })

  it('blocks ranges that cross the branch fork boundary and allows own-suffix ranges', () => {
    const topicId = `t-${uid()}`
    seedTwoturns(topicId)
    const branchId = (okValue(agg.createBranch(topicId, null, 'u2', 'B1')).branch as { id: string }).id
    // Branch route: inherited prefix u1,a1,u2 (fork boundary after u2).
    const inherited = agg.setTurnFolds(topicId, ['u1'], true, branchId)
    expect(inherited.ok).toBe(false)
    expect((inherited as any).error.code).toBe('VALIDATION_ERROR')
    expect(markedRows(topicId)).toEqual([])

    okValue(
      agg.appendMessage(
        topicId,
        messageJson('bu1', topicId) as never,
        [blockJson('b-bu1', 'bu1') as never],
        undefined,
        undefined,
        { branchId }
      )
    )
    okValue(
      agg.appendMessage(
        topicId,
        messageJson('ba1', topicId, { role: 'assistant', askId: 'bu1' }) as never,
        [blockJson('b-ba1', 'ba1') as never],
        undefined,
        undefined,
        { branchId }
      )
    )

    // Hole selection: both endpoints are route members, but the span starts in
    // the inherited prefix, so the group-level range rejects.
    const hole = agg.setTurnFolds(topicId, ['u2', 'bu1'], true, branchId)
    expect(hole.ok).toBe(false)
    expect(markedRows(topicId)).toEqual([])

    // Own-suffix turn folds normally.
    const own = okValue(agg.setTurnFolds(topicId, ['bu1'], true, branchId))
    expect(own.turns[0].messageIds).toEqual(['bu1', 'ba1'])
    expect(markedRows(topicId)).toEqual(['ba1', 'bu1'])

    // Single-message basics keep working on the inherited prefix through its
    // owner (the range rule applies to group-level range commands only).
    expect(agg.updateMessage(topicId, 'u1', { content: 'edited' } as never).ok).toBe(true)
  })

  it('allows folding one turn of a group and keeps the group ordinary and complete', () => {
    const topicId = `t-${uid()}`
    seedTwoturns(topicId)
    const segmentId = `seg-${uid()}`
    okValue(agg.upsertSegment(segmentId, topicId, 'Group', ['u1', 'a1', 'u2', 'a2'], undefined))

    // Partial-within-group fold is allowed: the group is not a context unit.
    okValue(agg.setTurnFolds(topicId, ['u2'], true))
    const segments = okValue(agg.listSegments(topicId))
    expect(segments).toHaveLength(1)
    expect(segments[0].messageIds).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(segments[0]).not.toHaveProperty('folded')
    // The retired group-level marker is never written by a turn fold.
    const segmentRow = sqlite.prepare('SELECT extra FROM topic_segments WHERE id = ?').get(segmentId) as {
      extra: string | null
    }
    const segmentExtra = segmentRow.extra ? (JSON.parse(segmentRow.extra) as Record<string, unknown>) : {}
    expect(segmentExtra).not.toHaveProperty('folded')

    const after = closure(topicId, 'u1')
    expect([...after.closure.foldedMessageIds].sort()).toEqual(['a2', 'u2'])
    // Members of the folded turn stay visible in the raw slice; only
    // participation changed.
    expect(after.messages.map((m: any) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  it('allows creating a message group across folded messages with complete membership', () => {
    const topicId = `t-${uid()}`
    seedTwoturns(topicId)
    okValue(agg.setTurnFolds(topicId, ['u2'], true))

    // Creating a group over hidden/folded messages is a presentation concept,
    // so it is allowed and membership is written in full.
    const segmentId = `seg-${uid()}`
    const created = okValue(agg.upsertSegment(segmentId, topicId, 'Across fold', ['u1', 'a1', 'u2', 'a2'], '#123456'))
    expect(created.messageIds).toEqual(['u1', 'a1', 'u2', 'a2'])
    const repos = createRepositories(db)
    expect(repos.segments.getMessageIds(segmentId)).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(repos.segments.getById(segmentId).data?.overflow).not.toHaveProperty('folded')
    // Fold state of the members is untouched by the group write.
    expect(markedRows(topicId)).toEqual(['a2', 'u2'])
  })

  it('a newly appended variant of a folded turn is born folded', () => {
    const topicId = `t-${uid()}`
    seedTwoturns(topicId)
    okValue(agg.setTurnFolds(topicId, ['u1'], true))

    okValue(
      agg.appendMessage(topicId, messageJson('a1c', topicId, { role: 'assistant', askId: 'u1' }) as never, [
        blockJson('b-a1c', 'a1c') as never
      ])
    )
    expect(rawExtra('a1c').folded).toBe(true)
    expect([...closure(topicId, 'u1').closure.foldedMessageIds].sort()).toEqual(['a1', 'a1c', 'u1'])

    // A row that starts its own turn inherits nothing.
    okValue(agg.appendMessage(topicId, messageJson('u3', topicId) as never, [blockJson('b-u3', 'u3') as never]))
    expect(rawExtra('u3')).not.toHaveProperty('folded')
    expect(closure(topicId, 'u1').closure.totalTurnCount).toBe(2)
  })

  it('emits no sync capture for a local-only presentation change', () => {
    const topicId = `t-${uid()}`
    seedTwoturns(topicId)
    const outboxBefore = (sqlite.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get() as { n: number }).n
    okValue(agg.setTurnFolds(topicId, ['u1'], true))
    okValue(agg.setTurnFolds(topicId, ['u1'], false))
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get() as { n: number }).n).toBe(outboxBefore)
  })
})
