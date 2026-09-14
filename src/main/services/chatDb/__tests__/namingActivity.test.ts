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
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-naming-activity-'))
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
    createdAt: new Date('2026-09-01T00:00:00.000Z').toISOString(),
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
    createdAt: new Date('2026-09-01T00:00:00.000Z').toISOString(),
    ...overrides
  }
}

describe('bounded naming/activity authority reads', () => {
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

  it('naming/activity fail NOT_FOUND for missing topic and create nothing', () => {
    const naming = agg.fetchTopicNamingContext({ topicId: 'missing-topic' })
    expect(naming.ok).toBe(false)
    if (!naming.ok) {
      expect(naming.error.code).toBe('NOT_FOUND')
      expect(naming.error.retryable).toBe(false)
    }
    const activity = agg.fetchTopicActivity({ topicId: 'missing-topic' })
    expect(activity.ok).toBe(false)
    if (!activity.ok) expect(activity.error.code).toBe('NOT_FOUND')
    expect(okValue(agg.topicExists('missing-topic'))).toBe(false)
  })

  it('empty topic returns count 0 with null bounds and empty arrays', () => {
    const topicId = `t-${uid()}`
    agg.ensureTopic(topicId)
    const naming = agg.fetchTopicNamingContext({ topicId })
    expect(naming.ok).toBe(true)
    const nvalue = okValue(naming)
    expect(nvalue.messageCount).toBe(0)
    expect(nvalue.firstMessage).toBeNull()
    expect(nvalue.latestMessages).toEqual([])
    expect(nvalue.blocks).toEqual([])
    expect(nvalue.naming).toEqual({
      completeness: 'naming-context',
      topicId,
      firstMessageId: null,
      lastMessageId: null,
      returnedLatestCount: 0
    })
    expect(() => validateChatDbResult('chatdb:fetch-topic-naming-context', { ok: true, value: nvalue })).not.toThrow()

    const activity = agg.fetchTopicActivity({ topicId })
    expect(activity.ok).toBe(true)
    const avalue = okValue(activity)
    expect(avalue).toEqual({
      messageCount: 0,
      latestMessageId: null,
      latestMessageCreatedAt: null,
      activity: { completeness: 'topic-activity', topicId }
    })
    expect(() => validateChatDbResult('chatdb:fetch-topic-activity', { ok: true, value: avalue })).not.toThrow()
  })

  it('naming returns authority metadata, exact count, first + latest5 ASC with deduped blocks', () => {
    const topicId = `t-${uid()}`
    agg.ensureTopic(topicId)
    expect(agg.updateTopicMetadata(topicId, 'My Topic', null, null, true).ok).toBe(true)
    const messageIds: string[] = []
    const blockByMessage = new Map<string, string>()
    for (let i = 0; i < 8; i++) {
      const msg = makeMessageJson(topicId, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString()
      })
      const mid = msg.id as string
      messageIds.push(mid)
      const block = makeBlockJson(mid, { content: `content-${i}` })
      blockByMessage.set(mid, block.id as string)
      expect(agg.appendMessage(topicId, msg as any, [block as any]).ok).toBe(true)
    }
    const result = agg.fetchTopicNamingContext({ topicId })
    expect(result.ok).toBe(true)
    const value = okValue(result)
    expect(value.topic).toEqual({ id: topicId, name: 'My Topic', isNameManuallyEdited: true })
    expect(value.messageCount).toBe(8)
    expect((value.firstMessage as any).id).toBe(messageIds[0])
    // Latest 5 in authority ASC order (window-size independent of displayCount)
    expect(value.latestMessages.map((m: any) => m.id)).toEqual(messageIds.slice(3))
    expect(value.naming).toEqual({
      completeness: 'naming-context',
      topicId,
      firstMessageId: messageIds[0],
      lastMessageId: messageIds[7],
      returnedLatestCount: 5
    })
    // Blocks only for ≤6 returned IDs (first + latest5 = 6 distinct here)
    expect(value.blocks.map((b: any) => b.id).sort()).toEqual(
      [messageIds[0], ...messageIds.slice(3)].map((mid) => blockByMessage.get(mid)).sort()
    )
    // Per-message block relations reconstructed
    for (const wireMsg of [value.firstMessage, ...value.latestMessages] as any[]) {
      expect(wireMsg.blocks).toEqual([blockByMessage.get(wireMsg.id)])
    }
    expect(() => validateChatDbResult('chatdb:fetch-topic-naming-context', { ok: true, value })).not.toThrow()
  })

  it('naming dedupes blocks when first overlaps latest (single-message topic)', () => {
    const topicId = `t-${uid()}`
    agg.ensureTopic(topicId)
    const msg = makeMessageJson(topicId)
    const mid = msg.id as string
    const b1 = makeBlockJson(mid, { content: 'a' })
    const b2 = makeBlockJson(mid, { content: 'b' })
    expect(agg.appendMessage(topicId, msg as any, [b1 as any, b2 as any]).ok).toBe(true)
    const result = agg.fetchTopicNamingContext({ topicId })
    const value = okValue(result)
    expect(value.messageCount).toBe(1)
    expect((value.firstMessage as any).id).toBe(mid)
    expect(value.latestMessages.map((m: any) => m.id)).toEqual([mid])
    expect(value.naming.firstMessageId).toBe(mid)
    expect(value.naming.lastMessageId).toBe(mid)
    expect(value.naming.returnedLatestCount).toBe(1)
    expect(value.blocks.map((b: any) => b.id).sort()).toEqual([b1.id as string, b2.id as string].sort())
    expect(() => validateChatDbResult('chatdb:fetch-topic-naming-context', { ok: true, value })).not.toThrow()
  })

  it('activity returns exact count with authority latest id/timestamp', () => {
    const topicId = `t-${uid()}`
    agg.ensureTopic(topicId)
    const stamps = ['2026-09-01T00:00:01.000Z', '2026-09-01T00:00:02.000Z', '2026-09-01T00:00:03.000Z']
    let lastId = ''
    for (const stamp of stamps) {
      const msg = makeMessageJson(topicId, { createdAt: stamp })
      lastId = msg.id as string
      expect(agg.appendMessage(topicId, msg as any, []).ok).toBe(true)
    }
    const result = agg.fetchTopicActivity({ topicId })
    const value = okValue(result)
    expect(value.messageCount).toBe(3)
    expect(value.latestMessageId).toBe(lastId)
    expect(value.latestMessageCreatedAt).toBe('2026-09-01T00:00:03.000Z')
    expect(value.activity).toEqual({ completeness: 'topic-activity', topicId })
    expect(() => validateChatDbResult('chatdb:fetch-topic-activity', { ok: true, value })).not.toThrow()
  })
})
