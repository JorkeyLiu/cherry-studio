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

import { ERR_NOT_FOUND, isSuccess, validateChatDbResult } from '@shared/chatDb'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { runMigrations } from '../migration'
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-ctx-'))
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
function makeBlock(messageId: string, id?: string): Record<string, unknown> {
  return {
    id: id ?? `b-${uid()}`,
    messageId,
    type: 'main_text',
    content: `block-${messageId}`,
    status: 'success',
    createdAt: new Date().toISOString()
  }
}

describe('ChatDbAggregateService — context closure S6.3 R-06', () => {
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

  it('user-key anchor: returns anchor turn through newest with complete turn', () => {
    const topicId = `t-${uid()}`
    // Build turns: u1 + a1(ask u1) + a1_retry(ask u1) | u2 + a2(ask u2) | u3
    const u1 = makeMsg(topicId, 'u1', 'user')
    const a1 = makeMsg(topicId, 'a1', 'assistant', 'u1')
    const a1r = makeMsg(topicId, 'a1r', 'assistant', 'u1')
    const u2 = makeMsg(topicId, 'u2', 'user')
    const a2 = makeMsg(topicId, 'a2', 'assistant', 'u2')
    const u3 = makeMsg(topicId, 'u3', 'user')
    for (const m of [u1, a1, a1r, u2, a2, u3]) {
      agg.appendMessage(topicId, m as any, [makeBlock(m.id as string) as any])
    }
    // anchor = user u1 → should return from u1 through newest (all 6)
    const res = agg.fetchContextClosure({ topicId, anchorGroupKey: 'u1' })
    expect(res.ok).toBe(true)
    const v = okValue(res)
    expect(v.closure.completeness).toBe('context-closure')
    expect(v.closure.topicId).toBe(topicId)
    expect(v.closure.anchorGroupKey).toBe('u1')
    expect(v.closure.returnedCount).toBe(6)
    expect(v.messages.map((m: any) => m.id)).toEqual(['u1', 'a1', 'a1r', 'u2', 'a2', 'u3'])
    // complete turn: first turn includes u1,a1,a1r together, not just u1 alone
    expect(v.messages[0].id).toBe('u1')
    expect(v.messages[1].id).toBe('a1')
    expect(v.messages[2].id).toBe('a1r')
    expect(v.closure.firstMessageId).toBe('u1')
    expect(v.closure.lastMessageId).toBe('u3')
    expect(v.blocks.length).toBe(6)
    // LOCK-001: whole-topic since anchor at first turn
    expect(v.closure.totalTurnCount).toBe(3)
    expect(v.closure.selectedTurnCount).toBe(3)
    expect(v.closure.boundaryMessageId).toBeNull()
    expect(() => validateChatDbResult('chatdb:fetch-context-closure', { ok: true, value: v } as any)).not.toThrow()
  })

  it('assistant askId anchor fallback: orphan assistant askId resolves', () => {
    const topicId = `t-${uid()}`
    // Orphan assistant with askId u-orphan, no user u-orphan present
    const aOrphan = makeMsg(topicId, 'aOrphan', 'assistant', 'u-orphan')
    const u2 = makeMsg(topicId, 'u2', 'user')
    const a2 = makeMsg(topicId, 'a2', 'assistant', 'u2')
    for (const m of [aOrphan, u2, a2]) {
      agg.appendMessage(topicId, m as any, [makeBlock(m.id as string) as any])
    }
    // anchorGroupKey = u-orphan should resolve via assistant askId fallback to first turn (aOrphan)
    const res = agg.fetchContextClosure({ topicId, anchorGroupKey: 'u-orphan' })
    expect(res.ok).toBe(true)
    const v = okValue(res)
    expect(v.messages.map((m: any) => m.id)).toEqual(['aOrphan', 'u2', 'a2'])
    expect(v.closure.firstMessageId).toBe('aOrphan')
    expect(v.closure.totalTurnCount).toBe(2)
    expect(v.closure.selectedTurnCount).toBe(2)
    expect(v.closure.boundaryMessageId).toBeNull()
  })

  it('orphan/system own-id anchor: assistant without askId and system singleton', () => {
    const topicId = `t-${uid()}`
    const aOrphanNoAsk = makeMsg(topicId, 'aNoAsk', 'assistant', null)
    const s1 = makeMsg(topicId, 's1', 'system')
    const u1 = makeMsg(topicId, 'u1', 'user')
    const a1 = makeMsg(topicId, 'a1', 'assistant', 'u1')
    for (const m of [aOrphanNoAsk, s1, u1, a1]) {
      agg.appendMessage(topicId, m as any, [makeBlock(m.id as string) as any])
    }
    // anchor = own id aNoAsk → should return from aNoAsk through newest
    const res1 = agg.fetchContextClosure({ topicId, anchorGroupKey: 'aNoAsk' })
    expect(res1.ok).toBe(true)
    const v1 = okValue(res1)
    expect(v1.messages.map((m: any) => m.id)).toEqual(['aNoAsk', 's1', 'u1', 'a1'])
    expect(v1.closure.totalTurnCount).toBe(3)
    expect(v1.closure.selectedTurnCount).toBe(3)
    expect(v1.closure.boundaryMessageId).toBeNull()

    // anchor = system own id s1 → should return from s1 through newest (s1 is singleton)
    const res2 = agg.fetchContextClosure({ topicId, anchorGroupKey: 's1' })
    expect(res2.ok).toBe(true)
    const v2 = okValue(res2)
    expect(v2.messages.map((m: any) => m.id)).toEqual(['s1', 'u1', 'a1'])
    expect(v2.closure.totalTurnCount).toBe(3)
    expect(v2.closure.selectedTurnCount).toBe(2)
    expect(v2.closure.boundaryMessageId).toBe('s1')
    expect(v2.closure.boundaryMessageId).toBe(v2.closure.firstMessageId)
  })

  it('complete anchor turn: consecutive assistant retries stay together', () => {
    const topicId = `t-${uid()}`
    const u1 = makeMsg(topicId, 'u1', 'user')
    const a1 = makeMsg(topicId, 'a1', 'assistant', 'u1')
    const a1r = makeMsg(topicId, 'a1r', 'assistant', 'u1')
    const u2 = makeMsg(topicId, 'u2', 'user')
    for (const m of [u1, a1, a1r, u2]) {
      agg.appendMessage(topicId, m as any, [makeBlock(m.id as string) as any])
    }
    // anchor u1 should include complete first turn (u1+a1+a1r) then through newest (u2)
    const res = agg.fetchContextClosure({ topicId, anchorGroupKey: 'u1' })
    const v = okValue(res)
    expect(v.messages.map((m: any) => m.id)).toEqual(['u1', 'a1', 'a1r', 'u2'])
    expect(v.closure.returnedCount).toBe(4)
    expect(v.closure.totalTurnCount).toBe(2)
    expect(v.closure.selectedTurnCount).toBe(2)
    expect(v.closure.boundaryMessageId).toBeNull()
  })

  it('anchor-to-newest ordering is sort_order ASC, id ASC and distinguishes from viewport grouping', () => {
    const topicId = `t-${uid()}`
    // Create messages with deterministic order: u1, a1(ask u1), u2
    // Viewport groups would split assistant retries but context turns group them; ordering must be authority order
    const u1 = makeMsg(topicId, 'u1', 'user')
    const a1 = makeMsg(topicId, 'a1', 'assistant', 'u1')
    const u2 = makeMsg(topicId, 'u2', 'user')
    const a2 = makeMsg(topicId, 'a2', 'assistant', 'u2')
    for (const m of [u1, a1, u2, a2]) {
      agg.appendMessage(topicId, m as any, [makeBlock(m.id as string) as any])
    }
    const res = agg.fetchContextClosure({ topicId, anchorGroupKey: 'u2' })
    const v = okValue(res)
    // From u2 through newest should be [u2, a2]
    expect(v.messages.map((m: any) => m.id)).toEqual(['u2', 'a2'])
    // ordering is deterministic: already verified via listByTopic sort_order
    expect(v.messages[0].id).toBe('u2')
    expect(v.messages[1].id).toBe('a2')
    expect(v.closure.totalTurnCount).toBe(2)
    expect(v.closure.selectedTurnCount).toBe(1)
    expect(v.closure.boundaryMessageId).toBe('u2')
  })

  it('no viewport truncation beyond 100 rows/groups — closure is independent of viewport limits', () => {
    const topicId = `t-${uid()}`
    // Create 150 turns (each user+assistant) = 300 messages, anchor at first user
    const firstId = 'u000'
    for (let i = 0; i < 150; i++) {
      const uidStr = `u${String(i).padStart(3, '0')}`
      const aidStr = `a${String(i).padStart(3, '0')}`
      const u = makeMsg(topicId, uidStr, 'user')
      const a = makeMsg(topicId, aidStr, 'assistant', uidStr)
      agg.appendMessage(topicId, u as any, [makeBlock(uidStr) as any])
      agg.appendMessage(topicId, a as any, [makeBlock(aidStr) as any])
    }
    const res = agg.fetchContextClosure({ topicId, anchorGroupKey: firstId })
    expect(res.ok).toBe(true)
    const v = okValue(res)
    // Should return all 300, not capped at 100
    expect(v.closure.returnedCount).toBe(300)
    expect(v.messages).toHaveLength(300)
    expect(v.blocks).toHaveLength(300)
    expect(v.messages[0].id).toBe(firstId)
    expect(v.messages[v.messages.length - 1].id).toBe('a149')
    expect(v.closure.completeness).toBe('context-closure')
    expect(v.closure.totalTurnCount).toBe(150)
    expect(v.closure.selectedTurnCount).toBe(150)
    expect(v.closure.boundaryMessageId).toBeNull()
  })

  it('missing topic returns NOT_FOUND', () => {
    const res = agg.fetchContextClosure({ topicId: 'nope', anchorGroupKey: 'any' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe(ERR_NOT_FOUND)
  })

  it('unresolved anchor returns NOT_FOUND', () => {
    const topicId = `t-${uid()}`
    const u1 = makeMsg(topicId, 'u1', 'user')
    agg.appendMessage(topicId, u1 as any, [makeBlock('u1') as any])
    const res = agg.fetchContextClosure({ topicId, anchorGroupKey: 'nonexistent' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe(ERR_NOT_FOUND)
  })

  it('anchorGroupKey that is both user id and later non-consecutive assistant askId prefers user turn (authority order)', () => {
    const topicId = `t-${uid()}`
    // Turn0: u1 + a1(ask u1) ; Turn1: u2 ; Turn2: a2(ask u1) non-consecutive duplicate key
    const u1 = makeMsg(topicId, 'u1', 'user')
    const a1 = makeMsg(topicId, 'a1', 'assistant', 'u1')
    const u2 = makeMsg(topicId, 'u2', 'user')
    const a2 = makeMsg(topicId, 'a2', 'assistant', 'u1')
    for (const m of [u1, a1, u2, a2]) {
      agg.appendMessage(topicId, m as any, [makeBlock(m.id as string) as any])
    }
    // anchorGroupKey u1 should resolve to user turn (turn0), not later orphan assistant turn2
    const res = agg.fetchContextClosure({ topicId, anchorGroupKey: 'u1' })
    const v = okValue(res)
    // From u1 turn start → newest = all 4
    expect(v.messages.map((m: any) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(v.closure.totalTurnCount).toBe(3)
    expect(v.closure.selectedTurnCount).toBe(3)
    expect(v.closure.boundaryMessageId).toBeNull()
    // anchor own-id a2 should resolve to turn2
    const res2 = agg.fetchContextClosure({ topicId, anchorGroupKey: 'a2' })
    const v2 = okValue(res2)
    expect(v2.messages.map((m: any) => m.id)).toEqual(['a2'])
    expect(v2.closure.totalTurnCount).toBe(3)
    expect(v2.closure.selectedTurnCount).toBe(1)
    expect(v2.closure.boundaryMessageId).toBe('a2')
  })

  it('block completeness: each returned message has its blocks and ordering', () => {
    const topicId = `t-${uid()}`
    const u1 = makeMsg(topicId, 'u1', 'user')
    const a1 = makeMsg(topicId, 'a1', 'assistant', 'u1')
    const bU1 = makeBlock('u1', 'bU1')
    const bA1_1 = makeBlock('a1', 'bA1_1')
    const bA1_2 = makeBlock('a1', 'bA1_2')
    agg.appendMessage(topicId, u1 as any, [bU1 as any])
    agg.appendMessage(topicId, a1 as any, [bA1_1 as any, bA1_2 as any])
    const res = agg.fetchContextClosure({ topicId, anchorGroupKey: 'u1' })
    const v = okValue(res)
    expect(v.blocks.map((b: any) => b.id).sort()).toEqual(['bA1_1', 'bA1_2', 'bU1'].sort())
    // message.blocks reconstructed
    const u1Wire = v.messages.find((m: any) => m.id === 'u1') as any
    const a1Wire = v.messages.find((m: any) => m.id === 'a1') as any
    expect(u1Wire.blocks).toEqual(['bU1'])
    expect(a1Wire.blocks).toEqual(['bA1_1', 'bA1_2'])
    expect(v.closure.totalTurnCount).toBe(1)
    expect(v.closure.selectedTurnCount).toBe(1)
    expect(v.closure.boundaryMessageId).toBeNull()
  })

  it('closure metadata consistency: completeness exactly context-closure, no hasMore, no 1..100 bound', () => {
    const topicId = `t-${uid()}`
    const u1 = makeMsg(topicId, 'u1', 'user')
    agg.appendMessage(topicId, u1 as any, [makeBlock('u1') as any])
    const res = agg.fetchContextClosure({ topicId, anchorGroupKey: 'u1' })
    const v = okValue(res)
    expect(v.closure.completeness).toBe('context-closure')
    expect((v.closure as any).hasMore).toBeUndefined()
    expect((v.closure as any).hasMoreBefore).toBeUndefined()
    expect((v as any).hasMore).toBeUndefined()
    expect(v.closure.totalTurnCount).toBe(1)
    expect(v.closure.selectedTurnCount).toBe(1)
    expect(v.closure.boundaryMessageId).toBeNull()
    // Validate via contract
    expect(() => validateChatDbResult('chatdb:fetch-context-closure', { ok: true, value: v } as any)).not.toThrow()
  })

  it('deterministic authority order: slice cover via listByTopic', () => {
    const topicId = `t-${uid()}`
    void makeMsg(topicId, 'aaa', 'user')
    void makeMsg(topicId, 'bbb', 'user')
    void makeMsg(topicId, 'ccc', 'user')
    // Insert in order ccc, aaa, bbb → sort_order should preserve insertion order, not id order
    agg.appendMessage(topicId, makeMsg(topicId, 'ccc', 'user') as any, [makeBlock('ccc') as any])
    agg.appendMessage(topicId, makeMsg(topicId, 'aaa', 'user') as any, [makeBlock('aaa') as any])
    agg.appendMessage(topicId, makeMsg(topicId, 'bbb', 'user') as any, [makeBlock('bbb') as any])
    // But anchor is aaa (second inserted), should return from aaa through newest (aaa, bbb) in insertion order, not sorted by id
    const res = agg.fetchContextClosure({ topicId, anchorGroupKey: 'aaa' })
    const v = okValue(res)
    expect(v.messages.map((m: any) => m.id)).toEqual(['aaa', 'bbb'])
    expect(v.closure.totalTurnCount).toBe(3)
    expect(v.closure.selectedTurnCount).toBe(2)
    expect(v.closure.boundaryMessageId).toBe('aaa')
  })

  it('nullable/unknown role between user and matching assistant is ignored for turn grouping (renderer-aligned)', () => {
    const topicId = `t-${uid()}`
    const u1 = makeMsg(topicId, 'u1', 'user')
    // Persisted row with nullable/unknown role between user and matching assistant
    // Simulates legacy/import row with null role or tool generic that can occur in SQLite
    const unknownNull: Record<string, unknown> = {
      id: 'x-null',
      topicId,
      role: null,
      content: 'unknown-null',
      status: 'success',
      createdAt: new Date().toISOString()
    }
    const unknownTool: Record<string, unknown> = {
      id: 'x-tool',
      topicId,
      role: 'tool',
      content: 'tool-content',
      status: 'success',
      createdAt: new Date().toISOString()
    }
    const a1 = makeMsg(topicId, 'a1', 'assistant', 'u1')
    // Authority order: u1, x-null, x-tool, a1
    for (const m of [u1, unknownNull, unknownTool, a1]) {
      agg.appendMessage(topicId, m as any, [makeBlock(m.id as string) as any])
    }
    // Canonical renderer buildContextTurns ignores null/'tool' for turn construction,
    // so a1 with askId u1 remains consecutive to u1 and joins the same turn.
    // Closure from anchor u1 must be anchor through newest inclusive of the
    // unknown rows (they remain in the slice), with deterministic authority order.
    const res = agg.fetchContextClosure({ topicId, anchorGroupKey: 'u1' })
    expect(res.ok).toBe(true)
    const v = okValue(res)
    expect(v.closure.completeness).toBe('context-closure')
    expect(v.closure.returnedCount).toBe(4)
    expect(v.messages.map((m: any) => m.id)).toEqual(['u1', 'x-null', 'x-tool', 'a1'])
    expect(v.closure.firstMessageId).toBe('u1')
    expect(v.closure.lastMessageId).toBe('a1')
    // totalTurnCount counts only recognized turns, unknown rows are ignored for turn count but present in slice
    expect(v.closure.totalTurnCount).toBe(1)
    expect(v.closure.selectedTurnCount).toBe(1)
    expect(v.closure.boundaryMessageId).toBeNull()
    // Anchor for the unknown row itself must be NOT_FOUND (no turn was created for it)
    const resUnknownNull = agg.fetchContextClosure({ topicId, anchorGroupKey: 'x-null' })
    expect(resUnknownNull.ok).toBe(false)
    if (!resUnknownNull.ok) expect(resUnknownNull.error.code).toBe(ERR_NOT_FOUND)
    const resUnknownTool = agg.fetchContextClosure({ topicId, anchorGroupKey: 'x-tool' })
    expect(resUnknownTool.ok).toBe(false)
    if (!resUnknownTool.ok) expect(resUnknownTool.error.code).toBe(ERR_NOT_FOUND)
    // Validate via contract — must still be valid success envelope for the u1 closure
    expect(() => validateChatDbResult('chatdb:fetch-context-closure', { ok: true, value: v } as any)).not.toThrow()
  })

  it('authoritative counts derive from same complete turn set and resolved anchor — whole vs partial', () => {
    const topicId = `t-${uid()}`
    // 10 turns: 20 messages alternating
    for (let i = 0; i < 10; i++) {
      const u = makeMsg(topicId, `u${i}`, 'user')
      const a = makeMsg(topicId, `a${i}`, 'assistant', `u${i}`)
      agg.appendMessage(topicId, u as any, [makeBlock(`u${i}`) as any])
      agg.appendMessage(topicId, a as any, [makeBlock(`a${i}`) as any])
    }
    // whole-topic: anchor at first turn
    const whole = okValue(agg.fetchContextClosure({ topicId, anchorGroupKey: 'u0' }))
    expect(whole.closure.totalTurnCount).toBe(10)
    expect(whole.closure.selectedTurnCount).toBe(10)
    expect(whole.closure.boundaryMessageId).toBeNull()
    // partial: anchor at turn 4 (u4)
    const partial = okValue(agg.fetchContextClosure({ topicId, anchorGroupKey: 'u4' }))
    expect(partial.closure.totalTurnCount).toBe(10)
    expect(partial.closure.selectedTurnCount).toBe(6)
    expect(partial.closure.boundaryMessageId).toBe('u4')
    expect(partial.closure.boundaryMessageId).toBe(partial.closure.firstMessageId)
    // validate both
    expect(() => validateChatDbResult('chatdb:fetch-context-closure', { ok: true, value: whole } as any)).not.toThrow()
    expect(() =>
      validateChatDbResult('chatdb:fetch-context-closure', { ok: true, value: partial } as any)
    ).not.toThrow()
  })
})
