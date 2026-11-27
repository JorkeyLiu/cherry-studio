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
import { BlocksRepository } from '../repository/BlocksRepository'
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
      foldedMessageIds: [],
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
      foldedMessageIds: [],
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

  // --------------------------------------------------------------------------
  // Explicit conversation-navigation projection (same whole-route read)
  // --------------------------------------------------------------------------

  /** Seed alternating user/assistant turns (one main_text block each). */
  function seedTurns(
    topicId: string,
    turns: number,
    options?: { branchId?: string | null; userExtraBlock?: boolean }
  ): { userIds: string[]; assistantIds: string[]; userBlocks: string[]; assistantBlocks: string[] } {
    const userIds: string[] = []
    const assistantIds: string[] = []
    const userBlocks: string[] = []
    const assistantBlocks: string[] = []
    for (let i = 0; i < turns; i++) {
      const user = makeMessageJson(topicId, { role: 'user', content: `question-${i}` })
      const uid_ = user.id as string
      const userBlock = makeBlockJson(uid_, 'main_text', { content: `question-${i}` })
      const blocks: Record<string, unknown>[] = [userBlock]
      userBlocks.push(userBlock.id as string)
      if (options?.userExtraBlock) {
        const att = makeBlockJson(uid_, 'file', {
          file: { id: `f-${uid_}`, name: `name-${i}.png`, path: `/tmp/name-${i}.png`, type: 'image', ext: 'png' }
        })
        blocks.push(att)
        userBlocks.push(att.id as string)
      }
      okValue(
        agg.appendMessage(topicId, user as any, blocks as any, undefined, undefined, { branchId: options?.branchId })
      )
      userIds.push(uid_)
      const assistant = makeMessageJson(topicId, { role: 'assistant', content: `answer-${i}` })
      const aid = assistant.id as string
      const assistantBlock = makeBlockJson(aid, 'main_text', { content: `answer-${i}` })
      assistantBlocks.push(assistantBlock.id as string)
      okValue(
        agg.appendMessage(topicId, assistant as any, [assistantBlock as any], undefined, undefined, {
          branchId: options?.branchId
        })
      )
      assistantIds.push(aid)
    }
    return { userIds, assistantIds, userBlocks, assistantBlocks }
  }

  it('conversation-navigation: every-role skeleton, user folds/blocks, narrowed block fields', () => {
    const topicId = `t-${uid()}`
    agg.ensureTopic(topicId)
    const { userIds, assistantIds, userBlocks, assistantBlocks } = seedTurns(topicId, 2, { userExtraBlock: true })
    // Fold the second turn's own row: Main writes the marker only on the rows
    // that belong to the selected turn, so the assistant row stays unmarked.
    okValue(agg.setTurnFolds(topicId, [userIds[1]], true))

    const value = okValue(agg.fetchWholeTopicSnapshot({ topicId, projection: 'conversation-navigation' }))

    // Route completeness is untouched: every effective-route message, all roles,
    // authority order. Assistant rows are skeletons.
    expect(value.messages.map((m: any) => m.id)).toEqual([userIds[0], assistantIds[0], userIds[1], assistantIds[1]])
    expect(value.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(value.messages[1]).toEqual({ id: assistantIds[0], role: 'assistant' })
    expect(value.messages[3]).toEqual({ id: assistantIds[1], role: 'assistant' })

    // User rows carry ordered block ids; `folded: true` only on the folded row.
    expect(value.messages[0]).toEqual({
      id: userIds[0],
      role: 'user',
      blocks: [userBlocks[0], userBlocks[1]]
    })
    expect(value.messages[2]).toEqual({
      id: userIds[1],
      role: 'user',
      blocks: [userBlocks[2], userBlocks[3]],
      folded: true
    })
    expect(value.messages[0]).not.toHaveProperty('folded')
    expect(value.messages[1]).not.toHaveProperty('blocks')

    // Only user blocks are serialized; assistant blocks never leave Main.
    const assistantBlockSet = new Set(assistantBlocks)
    expect(value.blocks.map((b: any) => b.id)).toEqual(userBlocks)
    for (const block of value.blocks) expect(assistantBlockSet.has(block.id as string)).toBe(false)
    for (const messageId of assistantIds) {
      expect(value.blocks.some((b: any) => b.messageId === messageId)).toBe(false)
    }

    // MAIN_TEXT content survives; FILE rows keep only { type, ext } metadata.
    const textBlocks = value.blocks.filter((b: any) => b.type === 'main_text')
    expect(textBlocks.map((b: any) => b.content)).toEqual(['question-0', 'question-1'])
    const fileBlocks = value.blocks.filter((b: any) => b.type === 'file')
    expect(fileBlocks).toHaveLength(2)
    for (const block of fileBlocks) {
      expect(Object.keys(block).sort()).toEqual(['content', 'file', 'id', 'messageId', 'type'])
      expect(Object.keys((block as any).file).sort()).toEqual(['ext', 'type'])
      expect((block as any).file).toEqual({ type: 'image', ext: 'png' })
    }

    // Same envelope metadata plus the narrow-payload declaration.
    expect(value.snapshot).toEqual({
      completeness: 'whole-topic',
      topicId,
      firstMessageId: userIds[0],
      lastMessageId: assistantIds[1],
      returnedCount: 4,
      // Folded membership is the persisted per-row marker set (the turn's own rows).
      foldedMessageIds: [userIds[1]],
      projection: 'conversation-navigation'
    })
    // The unfolded assistant row of the partly folded turn carries no marker.
    expect(value.messages[3]).not.toHaveProperty('folded')
    expect(() => validateChatDbResult('chatdb:fetch-whole-topic-snapshot', { ok: true, value })).not.toThrow()
  })

  it('conversation-navigation: assistant block content never appears where a full read would return it', () => {
    const topicId = `t-${uid()}`
    agg.ensureTopic(topicId)
    const { assistantIds } = seedTurns(topicId, 1)
    const full = okValue(agg.fetchWholeTopicSnapshot({ topicId }))
    const nav = okValue(agg.fetchWholeTopicSnapshot({ topicId, projection: 'conversation-navigation' }))
    // The full read is unchanged: complete rows, assistant blocks included, and
    // no projection marker.
    expect((full.snapshot as any).projection).toBeUndefined()
    expect(full.blocks.some((b: any) => b.messageId === assistantIds[0])).toBe(true)
    expect(full.messages.every((m: any) => typeof m.blocks !== 'undefined')).toBe(true)
    expect(nav.blocks.some((b: any) => b.messageId === assistantIds[0])).toBe(false)
  })

  it('conversation-navigation: reads only user message ids for blocks (full read still reads all)', () => {
    const topicId = `t-${uid()}`
    agg.ensureTopic(topicId)
    const { userIds, assistantIds } = seedTurns(topicId, 3)
    const spy = vi.spyOn(BlocksRepository.prototype, 'listByMessages')
    try {
      okValue(agg.fetchWholeTopicSnapshot({ topicId, projection: 'conversation-navigation' }))
      expect(spy).toHaveBeenCalledTimes(1)
      const navIds = spy.mock.calls[0][0]
      expect(navIds).toEqual(userIds)
      expect(navIds.some((id) => assistantIds.includes(id))).toBe(false)

      spy.mockClear()
      okValue(agg.fetchWholeTopicSnapshot({ topicId }))
      expect(spy).toHaveBeenCalledTimes(1)
      // The full snapshot keeps its complete-route read: every message id, in
      // route order.
      expect(spy.mock.calls[0][0]).toEqual(userIds.flatMap((id, i) => [id, assistantIds[i]]))
    } finally {
      spy.mockRestore()
    }
  })

  it('conversation-navigation: long user route (>256 ids) is chunked under the bind limit', () => {
    const topicId = `t-${uid()}`
    agg.ensureTopic(topicId)
    const userCount = 300
    const { userIds, userBlocks } = seedTurns(topicId, userCount)
    expect(userIds).toHaveLength(userCount)

    // Statement-level proof: the narrowed read is split into bounded chunks.
    const prepared: string[] = []
    const originalPrepare = sqlite.prepare.bind(sqlite)
    const prepareSpy = vi.spyOn(sqlite, 'prepare').mockImplementation(((source: string) => {
      prepared.push(source)
      return originalPrepare(source)
    }) as never)
    let value: any
    try {
      value = okValue(agg.fetchWholeTopicSnapshot({ topicId, projection: 'conversation-navigation' }))
    } finally {
      prepareSpy.mockRestore()
    }
    const blockStatements = prepared.filter((s) => s.includes('from "message_blocks"'))
    expect(blockStatements).toHaveLength(2)
    for (const statement of blockStatements) {
      const bindCount = (statement.match(/\?/g) ?? []).length
      expect(bindCount).toBeLessThanOrEqual(200)
    }
    expect(blockStatements.reduce((sum, s) => sum + (s.match(/\?/g) ?? []).length, 0)).toBe(userCount)

    // Completeness: every user row and every block id still arrives.
    expect(value.messages.filter((m: any) => m.role === 'user').map((m: any) => m.id)).toEqual(userIds)
    expect(value.blocks.map((b: any) => b.id)).toEqual(userBlocks)
    expect(value.snapshot.returnedCount).toBe(userCount * 2)
    expect(() => validateChatDbResult('chatdb:fetch-whole-topic-snapshot', { ok: true, value })).not.toThrow()
  })

  it('conversation-navigation: branch ancestor prefix plus owned suffix stays whole-route complete', () => {
    const topicId = `t-${uid()}`
    agg.ensureTopic(topicId)
    const main = seedTurns(topicId, 1)
    // Anchor the branch at the assistant message so its ancestor prefix carries
    // both roles of the source route (prefix completeness includes all roles).
    const branchId = (okValue(agg.createBranch(topicId, null, main.assistantIds[0], 'B1')).branch as { id: string }).id
    const suffix = seedTurns(topicId, 1, { branchId })

    const nav = okValue(agg.fetchWholeTopicSnapshot({ topicId, branchId, projection: 'conversation-navigation' }))
    expect(nav.messages.map((m: any) => m.id)).toEqual([
      main.userIds[0],
      main.assistantIds[0],
      suffix.userIds[0],
      suffix.assistantIds[0]
    ])
    // The main route keeps its own completeness.
    const mainNav = okValue(agg.fetchWholeTopicSnapshot({ topicId, projection: 'conversation-navigation' }))
    expect(mainNav.messages.map((m: any) => m.id)).toEqual([main.userIds[0], main.assistantIds[0]])
    expect(() => validateChatDbResult('chatdb:fetch-whole-topic-snapshot', { ok: true, value: nav })).not.toThrow()
  })

  it('conversation-navigation: referenced-topic foreign prefix plus target suffix stays whole-route complete', () => {
    const source = `t-${uid()}`
    const target = `t-${uid()}`
    const sourceTurns = seedTurns(source, 1)
    // Truncate the reference at the assistant anchor so the foreign prefix keeps
    // both roles before the target's own writable suffix.
    okValue(agg.createReferencedTopic(source, null, target, sourceTurns.assistantIds[0]))
    const owned = seedTurns(target, 1)

    const nav = okValue(agg.fetchWholeTopicSnapshot({ topicId: target, projection: 'conversation-navigation' }))
    expect(nav.messages.map((m: any) => m.id)).toEqual([
      sourceTurns.userIds[0],
      sourceTurns.assistantIds[0],
      owned.userIds[0],
      owned.assistantIds[0]
    ])
    expect(nav.blocks.map((b: any) => b.id)).toEqual([...sourceTurns.userBlocks, ...owned.userBlocks])
    expect(nav.snapshot.topicId).toBe(target)
    expect(nav.snapshot.returnedCount).toBe(4)
    expect(() => validateChatDbResult('chatdb:fetch-whole-topic-snapshot', { ok: true, value: nav })).not.toThrow()
  })

  it('conversation-navigation: empty topic read keeps the whole-topic envelope', () => {
    const topicId = `t-${uid()}`
    agg.ensureTopic(topicId)
    const value = okValue(agg.fetchWholeTopicSnapshot({ topicId, projection: 'conversation-navigation' }))
    expect(value.messages).toEqual([])
    expect(value.blocks).toEqual([])
    expect(value.snapshot).toEqual({
      completeness: 'whole-topic',
      topicId,
      firstMessageId: null,
      lastMessageId: null,
      returnedCount: 0,
      foldedMessageIds: [],
      projection: 'conversation-navigation'
    })
    expect(() => validateChatDbResult('chatdb:fetch-whole-topic-snapshot', { ok: true, value })).not.toThrow()
  })

  it('conversation-navigation: fails NOT_FOUND for a missing topic', () => {
    const result = agg.fetchWholeTopicSnapshot({ topicId: 'missing-topic', projection: 'conversation-navigation' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('NOT_FOUND')
      expect(result.error.retryable).toBe(false)
    }
  })
})
