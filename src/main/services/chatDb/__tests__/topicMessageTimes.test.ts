/**
 * Main-authoritative topic message-time reads (`chatdb:fetch-topic-message-times`).
 *
 * The ordering key of "by update time" is the REAL INSTANT of the latest
 * message `createdAt` in every route of one topic. These tests run over a real
 * SQLite database (real migrations, real repositories) and prove the query
 * never falls back to the authority sort tail, `message.updatedAt`, or any
 * topic timestamp, that unopened branches count, that deleted branches do not,
 * and that a reference target only sees its bounded prefix.
 */
import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

vi.mock('@main/config', () => ({ DATA_PATH: '/mock/data' }))

const { mockCleanTopic } = vi.hoisted(() => ({
  mockCleanTopic: vi.fn()
}))
vi.mock('../../SpanCacheService', () => ({
  spanCacheService: { cleanTopic: mockCleanTopic }
}))

import { isSuccess, validateChatDbResult } from '@shared/chatDb'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { runMigrations } from '../migration'
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-topic-message-times-'))
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
  return `n${++counter}-${Date.now()}`
}

function okValue<T>(result: { ok: boolean; value?: T; error?: unknown }): T {
  if (!isSuccess(result as any)) throw new Error(`Expected success, got: ${JSON.stringify((result as any).error)}`)
  return (result as any).value as T
}

function makeMessageJson(topicId: string, overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `m-${uid()}`,
    topicId,
    role: 'user',
    content: 'Hello',
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

function makeBlockJson(messageId: string, overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `b-${uid()}`,
    messageId,
    type: 'main_text',
    content: 'Block content',
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

describe('fetchTopicMessageTimes — authoritative latest message instant', () => {
  let tmpDir: string
  let sqlite: Database.Database
  let db: BetterSQLite3Database<typeof schema>
  let agg: ChatDbAggregateService

  beforeEach(() => {
    tmpDir = makeTempDir()
    sqlite = openTestDb(realPath.join(tmpDir, 'test.db'))
    db = wrapDrizzle(sqlite)
    runMigrations(db, sqlite)
    agg = new ChatDbAggregateService(db)
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

  function append(
    topicId: string,
    createdAt: string,
    extra: Record<string, unknown> = {},
    branchId?: string | null
  ): string {
    const message = makeMessageJson(topicId, { createdAt, ...extra })
    const block = makeBlockJson(message.id as string)
    const options = branchId === undefined ? undefined : { branchId: branchId ?? null }
    const result = options
      ? agg.appendMessage(topicId, message as any, [block as any], undefined, undefined, options)
      : agg.appendMessage(topicId, message as any, [block as any])
    expect(result.ok).toBe(true)
    return message.id as string
  }

  function setTopicTimestamps(topicId: string, createdAt: string | null, updatedAt: string | null): void {
    sqlite.prepare('UPDATE topics SET created_at = ?, updated_at = ? WHERE id = ?').run(createdAt, updatedAt, topicId)
  }

  function timesById(topicIds: string[]): Map<string, string | null> {
    const result = agg.fetchTopicMessageTimes({ topicIds })
    expect(result.ok).toBe(true)
    const value = okValue(result)
    expect(() => validateChatDbResult('chatdb:fetch-topic-message-times', { ok: true, value })).not.toThrow()
    return new Map(value.topics.map((entry) => [entry.topicId, entry.latestMessageAt]))
  }

  it('uses the real message instant order, never topic.updatedAt / message.updatedAt / the sort tail', () => {
    const oldMessages = `t-${uid()}`
    const newMessages = `t-${uid()}`
    agg.ensureTopic(oldMessages)
    agg.ensureTopic(newMessages)

    // "oldMessages" looks newest by topic metadata and by message.updatedAt.
    setTopicTimestamps(oldMessages, '2026-12-01T00:00:00.000Z', '2026-12-02T00:00:00.000Z')
    append(oldMessages, '2026-01-01T00:00:00.000Z', { updatedAt: '2026-12-31T00:00:00.000Z' })
    append(oldMessages, '2026-01-02T00:00:00.000Z', { updatedAt: '2026-12-31T00:00:00.000Z' })
    // "newMessages" looks oldest by topic metadata but has the newest message.
    setTopicTimestamps(newMessages, '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z')
    append(newMessages, '2026-09-01T00:00:00.000Z')

    const times = timesById([oldMessages, newMessages])
    expect(times.get(oldMessages)).toBe('2026-01-02T00:00:00.000Z')
    expect(times.get(newMessages)).toBe('2026-09-01T00:00:00.000Z')
  })

  it('takes the newest message anywhere in the topic, not the authority sort tail', () => {
    const topicId = `t-${uid()}`
    agg.ensureTopic(topicId)
    append(topicId, '2026-03-01T00:00:00.000Z')
    // Newest message is inserted in the middle, not appended at the tail.
    const middleId = append(topicId, '2026-09-01T00:00:00.000Z')
    const tailId = append(topicId, '2026-04-01T00:00:00.000Z')
    sqlite.prepare('UPDATE messages SET sort_order = 5 WHERE id = ?').run(tailId)
    sqlite.prepare('UPDATE messages SET sort_order = 1 WHERE id = ?').run(middleId)

    expect(timesById([topicId]).get(topicId)).toBe('2026-09-01T00:00:00.000Z')
  })

  it('counts an unopened branch and stops counting its rows after the branch is deleted', () => {
    const topicId = `t-${uid()}`
    agg.ensureTopic(topicId)
    const anchorId = append(topicId, '2026-01-01T00:00:00.000Z')
    const branch = okValue(agg.createBranch(topicId, null, anchorId))
    const branchId = (branch.branch as { id: string }).id
    append(topicId, '2026-10-01T00:00:00.000Z', {}, branchId)

    expect(timesById([topicId]).get(topicId)).toBe('2026-10-01T00:00:00.000Z')

    // Deleting the branch physically drops its owned rows (FK cascade).
    expect(agg.deleteBranch(topicId, branchId).ok).toBe(true)
    expect(timesById([topicId]).get(topicId)).toBe('2026-01-01T00:00:00.000Z')
  })

  it('falls back to null (never to a topic timestamp) when a topic has no usable message instant', () => {
    const empty = `t-${uid()}`
    agg.ensureTopic(empty)
    setTopicTimestamps(empty, '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z')

    expect(timesById([empty]).get(empty)).toBeNull()
  })

  it('ignores invalid and empty created_at values without contaminating the max', () => {
    const topicId = `t-${uid()}`
    agg.ensureTopic(topicId)
    append(topicId, '2026-05-01T00:00:00.000Z')
    // Imported / historical values that are not real instants.
    append(topicId, 'garbage')
    append(topicId, '')
    append(topicId, 'null')
    append(topicId, '2026-5-1') // non-ISO, unusable

    expect(timesById([topicId]).get(topicId)).toBe('2026-05-01T00:00:00.000Z')
  })

  it('compares true instants for offsets, seconds precision and sub-second fractions', () => {
    const ahead = `t-${uid()}`
    const behind = `t-${uid()}`
    agg.ensureTopic(ahead)
    agg.ensureTopic(behind)
    // 2026-05-01T10:00:00+08:00 == 2026-05-01T02:00:00Z
    append(ahead, '2026-05-01T10:00:00+08:00')
    // 2026-05-01T01:59:59Z is one second earlier; fractional part must not win.
    append(behind, '2026-05-01T01:59:59.999Z')

    const times = timesById([ahead, behind])
    const aheadMs = Date.parse(times.get(ahead) as string)
    const behindMs = Date.parse(times.get(behind) as string)
    expect(aheadMs).toBe(Date.parse('2026-05-01T02:00:00.000Z'))
    expect(behindMs).toBe(Date.parse('2026-05-01T01:59:59.999Z'))
    expect(aheadMs).toBeGreaterThan(behindMs)
  })

  it('answers every topic independently with no cross-topic mixing and reports counts', () => {
    const first = `t-${uid()}`
    const second = `t-${uid()}`
    const missing = `t-${uid()}`
    agg.ensureTopic(first)
    agg.ensureTopic(second)
    append(first, '2026-02-01T00:00:00.000Z')
    append(second, '2026-06-01T00:00:00.000Z')
    append(second, '2026-03-01T00:00:00.000Z')

    const result = agg.fetchTopicMessageTimes({ topicIds: [first, second, missing, first] })
    expect(result.ok).toBe(true)
    const value = okValue(result)
    expect(value.topics).toEqual([
      { topicId: first, latestMessageAt: '2026-02-01T00:00:00.000Z' },
      { topicId: second, latestMessageAt: '2026-06-01T00:00:00.000Z' }
    ])
    // A topic that no longer exists is omitted, and the counts say so.
    expect(value.messageTimes).toEqual({
      completeness: 'topic-activity',
      requestedTopicCount: 3,
      returnedTopicCount: 2
    })
  })

  it('shortens the key when the newest message is deleted (a real regression, not a cached value)', () => {
    const topicId = `t-${uid()}`
    agg.ensureTopic(topicId)
    append(topicId, '2026-02-01T00:00:00.000Z')
    const newestId = append(topicId, '2026-07-01T00:00:00.000Z')
    expect(timesById([topicId]).get(topicId)).toBe('2026-07-01T00:00:00.000Z')

    expect(agg.deleteMessage(topicId, newestId).ok).toBe(true)
    expect(timesById([topicId]).get(topicId)).toBe('2026-02-01T00:00:00.000Z')
  })

  it('bounds a reference target to its visible prefix instead of the whole source topic', () => {
    const sourceId = `t-${uid()}`
    const targetId = `t-${uid()}`
    agg.ensureTopic(sourceId, 'assistant-source')
    const first = append(sourceId, '2026-01-01T00:00:00.000Z')
    const anchor = append(sourceId, '2026-02-01T00:00:00.000Z')
    // A newer message AFTER the captured endpoint must never reach the target.
    append(sourceId, '2026-09-01T00:00:00.000Z')

    const created = agg.createReferencedTopic(sourceId, null, targetId, anchor, 'assistant-source', 'Target')
    expect(created.ok).toBe(true)
    // The target has no own rows: everything it sees is its live prefix.
    const ownRows = sqlite.prepare('SELECT COUNT(*) AS n FROM messages WHERE topic_id = ?').get(targetId) as {
      n: number
    }
    expect(ownRows.n).toBe(0)

    const times = timesById([sourceId, targetId])
    expect(times.get(sourceId)).toBe('2026-09-01T00:00:00.000Z')
    // The prefix through the anchor is visible: the anchor instant is the max.
    expect(times.get(targetId)).toBe('2026-02-01T00:00:00.000Z')
    expect(first).toBeTruthy()
  })

  it('orders an imported topic by its real messages, not by the import write clock', () => {
    const sourceId = `t-${uid()}`
    agg.ensureTopic(sourceId, 'assistant-source')
    append(sourceId, '2026-01-01T00:00:00.000Z')
    append(sourceId, '2026-08-01T00:00:00.000Z')

    const exported = okValue(agg.exportTopicData({ topicId: sourceId }))
    const imported = okValue(agg.importTopicData({ payload: exported.payload as any, assistantId: 'assistant-target' }))
    const importedId = (imported.topic as { id: string }).id

    // The imported record carries its own write clock (the import instant),
    // which must never become the ordering key.
    const row = sqlite.prepare('SELECT created_at, updated_at FROM topics WHERE id = ?').get(importedId) as {
      created_at: string | null
      updated_at: string | null
    }
    expect(row.created_at).not.toBeNull()
    expect(row.updated_at).not.toBeNull()
    // The record write clock is the import instant, far later than its data.
    expect(Date.parse(row.updated_at as string)).toBeGreaterThan(Date.parse('2026-08-01T00:00:00.000Z'))

    // The ordering key is the real latest message instant: the imported topic
    // sorts correctly without the user opening it or writing a first message.
    const times = timesById([importedId])
    expect(times.get(importedId)).toBe('2026-08-01T00:00:00.000Z')
    expect(times.get(importedId)).not.toBe(row.updated_at)
  })

  it('publishes the exact reference target set and demotes the target when its prefix maximum is deleted', () => {
    const sourceId = `t-${uid()}`
    const targetId = `t-${uid()}`
    agg.ensureTopic(sourceId, 'assistant-source')
    const first = append(sourceId, '2026-01-01T00:00:00.000Z')
    const anchor = append(sourceId, '2026-06-01T00:00:00.000Z')
    append(sourceId, '2026-09-01T00:00:00.000Z')
    expect(agg.createReferencedTopic(sourceId, null, targetId, anchor, 'assistant-source', 'Target').ok).toBe(true)

    // The existing Main→renderer invalidation fan-out resolves exactly this
    // target for the mutated source (payload basis of the push event).
    const targets = okValue(agg.listReferenceTargets(sourceId))
    expect(targets.targetTopicIds).toEqual([targetId])
    expect(timesById([targetId]).get(targetId)).toBe('2026-06-01T00:00:00.000Z')

    // Deleting the captured endpoint advances the visible prefix boundary: the
    // target's real key regresses to the previous visible message, so the
    // renderer's next read of this pushed target demotes it.
    expect(agg.deleteMessage(sourceId, anchor).ok).toBe(true)
    expect(okValue(agg.listReferenceTargets(sourceId)).targetTopicIds).toEqual([targetId])
    expect(timesById([targetId]).get(targetId)).toBe('2026-01-01T00:00:00.000Z')
    expect(first).toBeTruthy()
  })

  it('keeps the reference target key unchanged when the source appends after the captured anchor', () => {
    const sourceId = `t-${uid()}`
    const targetId = `t-${uid()}`
    agg.ensureTopic(sourceId, 'assistant-source')
    const anchor = append(sourceId, '2026-02-01T00:00:00.000Z')
    expect(agg.createReferencedTopic(sourceId, null, targetId, anchor, 'assistant-source', 'Target').ok).toBe(true)
    expect(timesById([targetId]).get(targetId)).toBe('2026-02-01T00:00:00.000Z')

    // A source append AFTER the anchor changes the source's own key,
    // contributes nothing to the target's visible prefix, and therefore
    // publishes the target for a re-read that returns the SAME key (no move).
    const appended = append(sourceId, '2026-10-01T00:00:00.000Z')
    expect(okValue(agg.listReferenceTargets(sourceId)).targetTopicIds).toEqual([targetId])
    expect(timesById([sourceId]).get(sourceId)).toBe('2026-10-01T00:00:00.000Z')
    expect(timesById([targetId]).get(targetId)).toBe('2026-02-01T00:00:00.000Z')

    // Only a source change INSIDE the prefix moves the target's key.
    expect(agg.deleteMessage(sourceId, anchor).ok).toBe(true)
    expect(timesById([targetId]).get(targetId)).toBeNull()
    expect(appended).toBeTruthy()
  })
})
