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
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-whole-snapshot-'))
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
  return `w${++counter}-${Date.now()}`
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
    createdAt: new Date().toISOString(),
    ...overrides
  }
}

function makeBlockJson(
  messageId: string,
  type = 'main_text',
  overrides?: Record<string, unknown>
): Record<string, unknown> {
  return {
    id: `b-${uid()}`,
    messageId,
    type,
    content: 'Block content',
    status: 'success',
    createdAt: new Date().toISOString(),
    ...overrides
  }
}

describe('ChatDbAggregateService.fetchWholeTopicSnapshot', () => {
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

  it('fails NOT_FOUND for missing topic (never ambiguous empty)', () => {
    const result = agg.fetchWholeTopicSnapshot({ topicId: 'missing-topic' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('NOT_FOUND')
      expect(result.error.retryable).toBe(false)
    }
  })

  it('returns empty snapshot metadata for an existing empty topic', () => {
    const topicId = `t-${uid()}`
    agg.ensureTopic(topicId)
    const result = agg.fetchWholeTopicSnapshot({ topicId })
    expect(result.ok).toBe(true)
    const value = okValue(result)
    expect(value.messages).toEqual([])
    expect(value.blocks).toEqual([])
    expect(value.snapshot).toEqual({
      completeness: 'whole-topic',
      topicId,
      firstMessageId: null,
      lastMessageId: null,
      returnedCount: 0
    })
    expect(() => validateChatDbResult('chatdb:fetch-whole-topic-snapshot', { ok: true, value })).not.toThrow()
  })

  it('returns the full ordered topic beyond typical displayCount with reconstructed block order', () => {
    const topicId = `t-${uid()}`
    agg.ensureTopic(topicId)
    const count = 35
    const messageIds: string[] = []
    const expectedBlockOrder: string[] = []
    for (let i = 0; i < count; i++) {
      const msg = makeMessageJson(topicId, { role: i % 2 === 0 ? 'user' : 'assistant' })
      const mid = msg.id as string
      messageIds.push(mid)
      const b1 = makeBlockJson(mid, 'main_text', { content: `content-${i}-a` })
      const b2 = makeBlockJson(mid, 'main_text', { content: `content-${i}-b` })
      expectedBlockOrder.push(b1.id as string, b2.id as string)
      const res = agg.appendMessage(topicId, msg as any, [b1 as any, b2 as any])
      expect(res.ok).toBe(true)
    }
    const result = agg.fetchWholeTopicSnapshot({ topicId })
    expect(result.ok).toBe(true)
    const value = okValue(result)
    expect(value.messages.map((m: any) => m.id)).toEqual(messageIds)
    expect(value.blocks.map((b: any) => b.id)).toEqual(expectedBlockOrder)
    // Per-message block relations reconstructed in order
    for (let i = 0; i < count; i++) {
      const wireMsg = value.messages[i] as any
      expect(wireMsg.blocks).toEqual([expectedBlockOrder[i * 2], expectedBlockOrder[i * 2 + 1]])
    }
    expect(value.snapshot).toEqual({
      completeness: 'whole-topic',
      topicId,
      firstMessageId: messageIds[0],
      lastMessageId: messageIds[messageIds.length - 1],
      returnedCount: count
    })
    expect(() => validateChatDbResult('chatdb:fetch-whole-topic-snapshot', { ok: true, value })).not.toThrow()
  })

  it('does not create a topic row on missing-topic read', () => {
    const topicId = `t-${uid()}`
    const result = agg.fetchWholeTopicSnapshot({ topicId })
    expect(result.ok).toBe(false)
    const exists = agg.topicExists(topicId)
    expect(okValue(exists)).toBe(false)
  })
})
