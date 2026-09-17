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

import type { FetchClipboardGroupsResponse } from '@shared/chatDb'
import { isSuccess, validateChatDbResult } from '@shared/chatDb'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { runMigrations } from '../migration'
import { BlocksRepository } from '../repository/BlocksRepository'
import { MessagesRepository } from '../repository/MessagesRepository'
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-clipboard-groups-'))
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
  return `c${++counter}-${Date.now()}`
}
function okValue<T>(r: { ok: boolean; value?: T; error?: unknown }): T {
  if (!isSuccess(r as any)) throw new Error(`Expected success: ${JSON.stringify((r as any).error)}`)
  return (r as any).value as T
}
function failCode(r: { ok: boolean; error?: { code?: string } }): string {
  return (r as any).error.code as string
}
function makeMsg(topicId: string, id: string, role: string, askId?: string | null) {
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
function makeBlock(messageId: string, id?: string) {
  return {
    id: id ?? `b-${uid()}`,
    messageId,
    type: 'main_text',
    content: `block-${messageId}`,
    status: 'success',
    createdAt: new Date().toISOString()
  }
}

describe('ChatDbAggregateService — fetch-clipboard-groups (group-scoped copy/cut)', () => {
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
    } catch {}
    rmrf(tmpDir)
    vi.restoreAllMocks()
  })

  function seedClipboardTopic(topicId: string) {
    // Authority order: u1, a1(ask u1), a2(ask u1), u2, s1, orphan-a(ask ghost, no user).
    agg.appendMessage(topicId, makeMsg(topicId, 'u1', 'user') as any, [makeBlock('u1', 'bu1') as any])
    agg.appendMessage(topicId, makeMsg(topicId, 'a1', 'assistant', 'u1') as any, [makeBlock('a1', 'ba1') as any])
    agg.appendMessage(topicId, makeMsg(topicId, 'a2', 'assistant', 'u1') as any, [makeBlock('a2', 'ba2') as any])
    agg.appendMessage(topicId, makeMsg(topicId, 'u2', 'user') as any, [makeBlock('u2', 'bu2') as any])
    agg.appendMessage(topicId, makeMsg(topicId, 's1', 'system') as any, [makeBlock('s1', 'bs1') as any])
    agg.appendMessage(topicId, makeMsg(topicId, 'oa1', 'assistant', 'ghost') as any, [makeBlock('oa1', 'boa1') as any])
    agg.appendMessage(topicId, makeMsg(topicId, 't1', 'tool') as any, [makeBlock('t1', 'bt1') as any])
    agg.appendMessage(topicId, makeMsg(topicId, 'na1', 'assistant') as any, [makeBlock('na1', 'bna1') as any])
  }

  it('resolves a user group with complete members/blocks and validates the envelope', () => {
    const topicId = `t-${uid()}`
    seedClipboardTopic(topicId)
    const res = agg.fetchClipboardGroups({ topicId, groupIds: ['u1'] })
    expect(res.ok).toBe(true)
    const v = okValue(res) as unknown as FetchClipboardGroupsResponse
    expect(v.groups).toHaveLength(1)
    expect(v.groups[0].groupId).toBe('u1')
    expect(v.groups[0].messageIds).toEqual(['u1', 'a1', 'a2'])
    expect(v.groups[0].positionIndex).toBe(0)
    expect((v.messages as Array<Record<string, unknown>>).map((m) => m.id)).toEqual(['u1', 'a1', 'a2'])
    expect((v.blocks as Array<Record<string, unknown>>).map((b) => b.id).sort()).toEqual(['ba1', 'ba2', 'bu1'])
    expect(v.clipboard).toMatchObject({
      completeness: 'clipboard-groups',
      topicId,
      requestedCount: 1,
      returnedCount: 1,
      returnedMessageCount: 3,
      firstMessageId: 'u1',
      lastMessageId: 'a2'
    })
    expect(() => validateChatDbResult('chatdb:fetch-clipboard-groups', res)).not.toThrow()
  })

  it('matches getMessageGroups semantics: system singleton, orphan askId, ignored roles form no group', () => {
    const topicId = `t-${uid()}`
    seedClipboardTopic(topicId)
    const sys = agg.fetchClipboardGroups({ topicId, groupIds: ['s1'] })
    expect(okValue(sys).groups[0].messageIds).toEqual(['s1'])
    const orphan = agg.fetchClipboardGroups({ topicId, groupIds: ['ghost'] })
    expect(okValue(orphan).groups[0].messageIds).toEqual(['oa1'])
    // Tool message id and assistant-without-askId message id form no clipboard group.
    const tool = agg.fetchClipboardGroups({ topicId, groupIds: ['t1'] })
    expect(okValue(tool).groups).toEqual([])
    expect(okValue(tool).messages).toEqual([])
    const noAsk = agg.fetchClipboardGroups({ topicId, groupIds: ['na1'] })
    expect(okValue(noAsk).groups).toEqual([])
  })

  it('orders multiple reverse-selected groups by authority and scales with selection only', () => {
    const topicId = `t-${uid()}`
    seedClipboardTopic(topicId)
    const listSpy = vi.spyOn(MessagesRepository.prototype, 'listByTopic').mockImplementation(() => {
      throw new Error('listByTopic must not be called in clipboard-groups mode')
    })
    try {
      const res = agg.fetchClipboardGroups({ topicId, groupIds: ['s1', 'u1'] })
      expect(res.ok).toBe(true)
      const v = okValue(res) as unknown as FetchClipboardGroupsResponse
      expect(v.groups.map((g) => g.groupId)).toEqual(['u1', 's1'])
      expect(v.groups.map((g) => g.positionIndex)).toEqual([0, 4])
      expect((v.messages as Array<Record<string, unknown>>).map((m) => m.id)).toEqual(['u1', 'a1', 'a2', 's1'])
      // Response carries only selected groups (4 messages), not the 8-row topic.
      expect(v.clipboard.returnedMessageCount).toBe(4)
      expect(v.clipboard.returnedCount).toBe(2)
      expect(listSpy).not.toHaveBeenCalled()
      expect(() => validateChatDbResult('chatdb:fetch-clipboard-groups', res)).not.toThrow()
    } finally {
      listSpy.mockRestore()
    }
  })

  it('normal path uses bounded reads only: no listByTopic, blocks scoped to selected ids', () => {
    const topicId = `t-${uid()}`
    seedClipboardTopic(topicId)
    const listSpy = vi.spyOn(MessagesRepository.prototype, 'listByTopic')
    const blocksSpy = vi.spyOn(BlocksRepository.prototype, 'listByMessages')
    const res = agg.fetchClipboardGroups({ topicId, groupIds: ['u2'] })
    expect(res.ok).toBe(true)
    const v = okValue(res) as unknown as FetchClipboardGroupsResponse
    expect(v.groups[0]).toEqual({ groupId: 'u2', messageIds: ['u2'], positionIndex: 3 })
    expect(listSpy).not.toHaveBeenCalled()
    expect(blocksSpy).toHaveBeenCalledTimes(1)
    expect(blocksSpy.mock.calls[0][0]).toEqual(['u2'])
    listSpy.mockRestore()
    blocksSpy.mockRestore()
  })

  it('filters missing/illegal/cross-topic ids; empty resolution succeeds empty; missing topic is NOT_FOUND', () => {
    const topicId = `t-${uid()}`
    const otherId = `t-${uid()}`
    seedClipboardTopic(topicId)
    seedClipboardTopic(otherId)
    const mixed = agg.fetchClipboardGroups({ topicId, groupIds: ['u1', 'missing-group', 't1', 'u1-cross'] })
    expect(mixed.ok).toBe(true)
    const mv = okValue(mixed) as unknown as FetchClipboardGroupsResponse
    expect(mv.groups.map((g) => g.groupId)).toEqual(['u1'])
    expect(mv.clipboard.requestedCount).toBe(4)
    expect(mv.clipboard.returnedCount).toBe(1)
    // Cross-topic id (u2 lives in both topics but the key exists in target too;
    // use a foreign-only orphan key to prove cross-topic filtering).
    const foreignOnly = `foreign-${uid()}`
    agg.appendMessage(otherId, makeMsg(otherId, 'fu', 'user') as any, [makeBlock('fu') as any])
    void foreignOnly
    const crossRes = agg.fetchClipboardGroups({ topicId, groupIds: ['fu'] })
    expect(crossRes.ok).toBe(true)
    expect(okValue(crossRes).groups).toEqual([])
    const allMissing = agg.fetchClipboardGroups({ topicId, groupIds: ['nope'] })
    expect(allMissing.ok).toBe(true)
    const av = okValue(allMissing) as unknown as FetchClipboardGroupsResponse
    expect(av.groups).toEqual([])
    expect(av.messages).toEqual([])
    expect(av.blocks).toEqual([])
    expect(av.clipboard.firstMessageId).toBeNull()
    expect(av.clipboard.lastMessageId).toBeNull()
    expect(() => validateChatDbResult('chatdb:fetch-clipboard-groups', allMissing)).not.toThrow()
    const missingTopic = agg.fetchClipboardGroups({ topicId: `missing-${uid()}`, groupIds: ['u1'] })
    expect(missingTopic.ok).toBe(false)
    expect(failCode(missingTopic)).toBe('NOT_FOUND')
    const dup = agg.fetchClipboardGroups({ topicId, groupIds: ['u1', 'u1'] })
    expect(dup.ok).toBe(false)
    expect(failCode(dup)).toBe('VALIDATION_ERROR')
    const empty = agg.fetchClipboardGroups({ topicId, groupIds: [] })
    expect(empty.ok).toBe(false)
    expect(failCode(empty)).toBe('VALIDATION_ERROR')
  })

  it('returns messages without blocks as empty block set (no-block group)', () => {
    const topicId = `t-${uid()}`
    agg.appendMessage(topicId, makeMsg(topicId, 'ub', 'user') as any, [])
    const res = agg.fetchClipboardGroups({ topicId, groupIds: ['ub'] })
    expect(res.ok).toBe(true)
    const v = okValue(res) as unknown as FetchClipboardGroupsResponse
    expect(v.groups[0].messageIds).toEqual(['ub'])
    expect(v.blocks).toEqual([])
    expect(v.clipboard.returnedMessageCount).toBe(1)
  })

  it('single message with multiple blocks keeps authority block order/completeness (no full read)', () => {
    const topicId = `t-${uid()}`
    const blocks = [
      {
        id: 'mb1',
        messageId: 'um',
        type: 'main_text',
        content: 'one',
        status: 'success',
        createdAt: new Date().toISOString()
      },
      {
        id: 'mb2',
        messageId: 'um',
        type: 'main_text',
        content: 'two',
        status: 'success',
        createdAt: new Date().toISOString()
      },
      {
        id: 'mb3',
        messageId: 'um',
        type: 'main_text',
        content: 'three',
        status: 'success',
        createdAt: new Date().toISOString()
      }
    ]
    agg.appendMessage(topicId, makeMsg(topicId, 'um', 'user') as any, blocks as any)
    const listSpy = vi.spyOn(MessagesRepository.prototype, 'listByTopic').mockImplementation(() => {
      throw new Error('listByTopic must not be called in clipboard-groups mode')
    })
    try {
      const res = agg.fetchClipboardGroups({ topicId, groupIds: ['um'] })
      expect(res.ok).toBe(true)
      const v = okValue(res) as unknown as FetchClipboardGroupsResponse
      expect(v.groups).toHaveLength(1)
      expect(v.groups[0].messageIds).toEqual(['um'])
      // Authority block order (insertion/authority sort_order), not sorted by id.
      expect((v.blocks as Array<Record<string, unknown>>).map((b) => b.id)).toEqual(['mb1', 'mb2', 'mb3'])
      expect((v.messages as Array<Record<string, unknown>>).map((m) => m.id)).toEqual(['um'])
      expect(v.clipboard.returnedMessageCount).toBe(1)
      expect(listSpy).not.toHaveBeenCalled()
      expect(() => validateChatDbResult('chatdb:fetch-clipboard-groups', res)).not.toThrow()
    } finally {
      listSpy.mockRestore()
    }
  })
})
