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

import { ERR_NOT_FOUND, isSuccess } from '@shared/chatDb'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { runMigrations } from '../migration'
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-win-'))
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
function okValue<T>(r: { ok: boolean; value?: T; error?: unknown }): T {
  if (!isSuccess(r as any)) throw new Error(`Expected success: ${JSON.stringify((r as any).error)}`)
  return (r as any).value as T
}
function makeMsg(topicId: string, id?: string): Record<string, unknown> {
  return {
    id: id ?? `m-${uid()}`,
    topicId,
    role: 'user',
    content: 'hello',
    status: 'success',
    createdAt: new Date().toISOString()
  }
}
function makeBlock(messageId: string): Record<string, unknown> {
  return {
    id: `b-${uid()}`,
    messageId,
    type: 'main_text',
    content: 'block',
    status: 'success',
    createdAt: new Date().toISOString()
  }
}

describe('ChatDbAggregateService — windowed reads S6.1', () => {
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
  })

  it('latest: returns tail N with hasMoreBefore, completeness window', () => {
    const topicId = `t-${uid()}`
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const m = makeMsg(topicId)
      ids.push(m.id as string)
      const b = makeBlock(messageId(m))
      agg.appendMessage(topicId, m as any, [b as any])
    }
    const result = agg.fetchMessagesWindow({ kind: 'latest', topicId, limit: 2 })
    expect(result.ok).toBe(true)
    const v = okValue(result)
    expect(v.messages).toHaveLength(2)
    expect(v.messages[0].id).toBe(ids[3])
    expect(v.messages[1].id).toBe(ids[4])
    expect(v.blocks).toHaveLength(2)
    expect(v.window.kind).toBe('latest')
    expect(v.window.completeness).toBe('window')
    expect(v.window.firstMessageId).toBe(ids[3])
    expect(v.window.lastMessageId).toBe(ids[4])
    expect(v.window.returnedCount).toBe(2)
    expect(v.window.hasMoreBefore).toBe(true)
    expect(v.window.hasMoreAfter).toBe(false)
    // ordering is deterministic sort_order ASC, id ASC — our inserts preserve order
    expect(v.messages.map((m: any) => m.id)).toEqual([ids[3], ids[4]])
  })

  it('latest: empty topic returns empty window success (distinct from missing)', () => {
    const topicId = `t-${uid()}`
    agg.ensureTopic(topicId)
    const res = agg.fetchMessagesWindow({ kind: 'latest', topicId, limit: 10 })
    expect(res.ok).toBe(true)
    const v = okValue(res)
    expect(v.messages).toEqual([])
    expect(v.blocks).toEqual([])
    expect(v.window.returnedCount).toBe(0)
    expect(v.window.firstMessageId).toBeNull()
    expect(v.window.lastMessageId).toBeNull()
    expect(v.window.hasMoreBefore).toBe(false)
    expect(v.window.hasMoreAfter).toBe(false)
  })

  it('latest: missing topic returns NOT_FOUND', () => {
    const res = agg.fetchMessagesWindow({ kind: 'latest', topicId: 'nope', limit: 10 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe(ERR_NOT_FOUND)
  })

  it('latest: hasMoreBefore false when limit covers all', () => {
    const topicId = `t-${uid()}`
    for (let i = 0; i < 3; i++) agg.appendMessage(topicId, makeMsg(topicId) as any, [makeBlock(`m-${i}`) as any])
    // create 3 messages properly
    const topic2 = `t-${uid()}`
    const ids2: string[] = []
    for (let i = 0; i < 3; i++) {
      const m = makeMsg(topic2)
      ids2.push(m.id as string)
      agg.appendMessage(topic2, m as any, [makeBlock(messageId(m)) as any])
    }
    const res = agg.fetchMessagesWindow({ kind: 'latest', topicId: topic2, limit: 10 })
    const v = okValue(res)
    expect(v.window.hasMoreBefore).toBe(false)
    expect(v.messages).toHaveLength(3)
  })

  it('around: returns anchor ± counts with correct hasMore flags', () => {
    const topicId = `t-${uid()}`
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const m = makeMsg(topicId)
      ids.push(m.id as string)
      agg.appendMessage(topicId, m as any, [makeBlock(messageId(m)) as any])
    }
    const anchor = ids[2]
    const res = agg.fetchMessagesWindow({ kind: 'around', topicId, anchorMessageId: anchor, before: 1, after: 1 })
    expect(res.ok).toBe(true)
    const v = okValue(res)
    expect(v.messages.map((m: any) => m.id)).toEqual([ids[1], ids[2], ids[3]])
    expect(v.window.kind).toBe('around')
    expect(v.window.anchorMessageId).toBe(anchor)
    expect(v.window.requested.before).toBe(1)
    expect(v.window.requested.after).toBe(1)
    expect(v.window.hasMoreBefore).toBe(true)
    expect(v.window.hasMoreAfter).toBe(true)
    expect(v.window.firstMessageId).toBe(ids[1])
    expect(v.window.lastMessageId).toBe(ids[3])
  })

  it('around: clamped at boundaries hasMore false at edge', () => {
    const topicId = `t-${uid()}`
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const m = makeMsg(topicId)
      ids.push(m.id as string)
      agg.appendMessage(topicId, m as any, [makeBlock(messageId(m)) as any])
    }
    // anchor at start, before larger than available
    const res = agg.fetchMessagesWindow({ kind: 'around', topicId, anchorMessageId: ids[0], before: 5, after: 1 })
    const v = okValue(res)
    expect(v.messages.map((m: any) => m.id)).toEqual([ids[0], ids[1]])
    expect(v.window.hasMoreBefore).toBe(false)
    expect(v.window.hasMoreAfter).toBe(true)
    // anchor at end
    const res2 = agg.fetchMessagesWindow({ kind: 'around', topicId, anchorMessageId: ids[2], before: 1, after: 5 })
    const v2 = okValue(res2)
    expect(v2.messages.map((m: any) => m.id)).toEqual([ids[1], ids[2]])
    expect(v2.window.hasMoreBefore).toBe(true)
    expect(v2.window.hasMoreAfter).toBe(false)
  })

  it('around: missing anchor distinct from empty result', () => {
    const topicId = `t-${uid()}`
    const m = makeMsg(topicId)
    agg.appendMessage(topicId, m as any, [makeBlock(messageId(m)) as any])
    const res = agg.fetchMessagesWindow({ kind: 'around', topicId, anchorMessageId: 'missing', before: 1, after: 1 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe(ERR_NOT_FOUND)
  })

  it('around: anchor in different topic returns NOT_FOUND', () => {
    const t1 = `t-${uid()}`
    const t2 = `t-${uid()}`
    const m1 = makeMsg(t1)
    agg.appendMessage(t1, m1 as any, [makeBlock(messageId(m1)) as any])
    const m2 = makeMsg(t2)
    agg.appendMessage(t2, m2 as any, [makeBlock(messageId(m2)) as any])
    const res = agg.fetchMessagesWindow({
      kind: 'around',
      topicId: t1,
      anchorMessageId: m2.id as string,
      before: 1,
      after: 1
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe(ERR_NOT_FOUND)
  })

  it('window blocks are complete per message', () => {
    const topicId = `t-${uid()}`
    const m1 = makeMsg(topicId, 'm1')
    const m2 = makeMsg(topicId, 'm2')
    const b1 = {
      id: 'b1',
      messageId: 'm1',
      type: 'main_text',
      content: 'c1',
      status: 'success',
      createdAt: new Date().toISOString()
    }
    const b2 = {
      id: 'b2',
      messageId: 'm1',
      type: 'main_text',
      content: 'c2',
      status: 'success',
      createdAt: new Date().toISOString()
    }
    const b3 = {
      id: 'b3',
      messageId: 'm2',
      type: 'main_text',
      content: 'c3',
      status: 'success',
      createdAt: new Date().toISOString()
    }
    agg.appendMessage(topicId, m1 as any, [b1 as any, b2 as any])
    agg.appendMessage(topicId, m2 as any, [b3 as any])
    const res = agg.fetchMessagesWindow({ kind: 'latest', topicId, limit: 1 })
    const v = okValue(res)
    expect(v.messages).toHaveLength(1)
    expect(v.messages[0].id).toBe('m2')
    expect(v.blocks).toHaveLength(1)
    expect((v.blocks[0] as any).id).toBe('b3')
    // around anchor m1 includes both its blocks
    const res2 = agg.fetchMessagesWindow({ kind: 'around', topicId, anchorMessageId: 'm1', before: 1, after: 1 })
    const v2 = okValue(res2)
    // should include m1 and m2, blocks b1,b2,b3
    expect(v2.blocks.map((b: any) => b.id).sort()).toEqual(['b1', 'b2', 'b3'])
    expect(v2.messages.find((m: any) => m.id === 'm1')?.blocks).toEqual(['b1', 'b2'])
  })

  it('deterministic ordering sort_order ASC, id ASC', () => {
    const topicId = `t-${uid()}`
    // create messages with explicit ids that tie-break; sort_order is dense appended order
    const mA = makeMsg(topicId, 'aaa')
    const mB = makeMsg(topicId, 'bbb')
    const mC = makeMsg(topicId, 'ccc')
    agg.appendMessage(topicId, mC as any, [makeBlock('ccc') as any])
    agg.appendMessage(topicId, mA as any, [makeBlock('aaa') as any])
    agg.appendMessage(topicId, mB as any, [makeBlock('bbb') as any])
    // fetch via window latest 3 — should be sorted by sort_order (insertion order ccc, aaa, bbb), not id order
    const res = agg.fetchMessagesWindow({ kind: 'latest', topicId, limit: 10 })
    const v = okValue(res)
    expect(v.messages.map((m: any) => m.id)).toEqual(['ccc', 'aaa', 'bbb'])
  })
})

function messageId(m: Record<string, unknown>): string {
  return m.id as string
}
