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

  it('effective route: main vs branch vs nested diverge; prefix anchor excludes main-only after-fork turns; branch-owned anchor resolves', () => {
    const topicId = `t-${uid()}`
    // Main 5 turns: u1/a1 .. u5/a5
    for (const n of ['u1', 'u2', 'u3', 'u4', 'u5']) {
      const u = makeMsg(topicId, n, 'user')
      const aId = n.replace('u', 'a')
      const a = makeMsg(topicId, aId, 'assistant', n)
      agg.appendMessage(topicId, u as any, [makeBlock(n) as any])
      agg.appendMessage(topicId, a as any, [makeBlock(aId) as any])
    }
    // Fork B1 at complete turn a3: effective prefix u1..a3 (3 turns)
    const b1 = okValue(agg.createBranch(topicId, null, 'a3', 'B1')).branch.id
    agg.appendMessage(
      topicId,
      makeMsg(topicId, 'b1u', 'user') as any,
      [makeBlock('b1u') as any],
      undefined,
      undefined,
      {
        branchId: b1
      }
    )
    agg.appendMessage(
      topicId,
      makeMsg(topicId, 'b1a', 'assistant', 'b1u') as any,
      [makeBlock('b1a') as any],
      undefined,
      undefined,
      { branchId: b1 }
    )
    // Nested B2 from B1 at branch-owned b1a: prefix is full B1, plus own suffix
    const b2 = okValue(agg.createBranch(topicId, b1, 'b1a', 'B2')).branch.id
    agg.appendMessage(
      topicId,
      makeMsg(topicId, 'b2u', 'user') as any,
      [makeBlock('b2u') as any],
      undefined,
      undefined,
      {
        branchId: b2
      }
    )
    agg.appendMessage(
      topicId,
      makeMsg(topicId, 'b2a', 'assistant', 'b2u') as any,
      [makeBlock('b2a') as any],
      undefined,
      undefined,
      { branchId: b2 }
    )

    const main = okValue(agg.fetchContextClosure({ topicId, anchorGroupKey: 'u1' }))
    expect(main.messages.map((m: any) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4', 'u5', 'a5'])
    expect(main.closure.returnedCount).toBe(10)
    expect(main.closure.totalTurnCount).toBe(5)
    expect(main.closure.selectedTurnCount).toBe(5)
    expect(main.blocks).toHaveLength(10)

    const branch = okValue(agg.fetchContextClosure({ topicId, branchId: b1, anchorGroupKey: 'u1' }))
    expect(branch.messages.map((m: any) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'b1u', 'b1a'])
    expect(branch.closure.returnedCount).toBe(8)
    expect(branch.closure.totalTurnCount).toBe(4)
    expect(branch.closure.selectedTurnCount).toBe(4)
    expect(branch.blocks).toHaveLength(8)
    // Common prefix anchor must NOT include main-only after-fork turns
    expect(branch.messages.map((m: any) => m.id)).not.toContain('u4')
    expect(branch.messages.map((m: any) => m.id)).not.toContain('a5')
    expect(branch.blocks.map((b: any) => b.content)).toContain('block-b1u')
    expect(branch.blocks.map((b: any) => b.content)).not.toContain('block-u4')

    const nested = okValue(agg.fetchContextClosure({ topicId, branchId: b2, anchorGroupKey: 'u1' }))
    expect(nested.messages.map((m: any) => m.id)).toEqual([
      'u1',
      'a1',
      'u2',
      'a2',
      'u3',
      'a3',
      'b1u',
      'b1a',
      'b2u',
      'b2a'
    ])
    expect(nested.closure.returnedCount).toBe(10)
    expect(nested.closure.totalTurnCount).toBe(5)
    expect(nested.closure.selectedTurnCount).toBe(5)
    expect(nested.blocks).toHaveLength(10)
    // Same count as main but different effective sequence/blocks
    expect(nested.messages.map((m: any) => m.id)).not.toEqual(main.messages.map((m: any) => m.id))
    expect(nested.blocks.map((b: any) => b.content)).toContain('block-b2u')
    expect(nested.blocks.map((b: any) => b.content)).not.toContain('block-u4')

    // Branch-owned anchor must resolve on its owner route
    const owned = okValue(agg.fetchContextClosure({ topicId, branchId: b1, anchorGroupKey: 'b1u' }))
    expect(owned.messages.map((m: any) => m.id)).toEqual(['b1u', 'b1a'])
    expect(owned.closure.totalTurnCount).toBe(4)
    expect(owned.closure.selectedTurnCount).toBe(1)
    expect(owned.closure.boundaryMessageId).toBe('b1u')
    const ownedNested = okValue(agg.fetchContextClosure({ topicId, branchId: b2, anchorGroupKey: 'b2u' }))
    expect(ownedNested.messages.map((m: any) => m.id)).toEqual(['b2u', 'b2a'])
    expect(ownedNested.closure.totalTurnCount).toBe(5)
    expect(ownedNested.closure.selectedTurnCount).toBe(1)

    // Main-only after-fork anchor is NOT in the branch effective route
    const afterForkOnBranch = agg.fetchContextClosure({ topicId, branchId: b1, anchorGroupKey: 'u4' })
    expect(afterForkOnBranch.ok).toBe(false)
    if (!afterForkOnBranch.ok) expect(afterForkOnBranch.error.code).toBe(ERR_NOT_FOUND)
  })

  it('invalid/deleted branch stays NOT_FOUND while a deleted fork anchor inherits up to the nearest survivor', () => {
    const topicId = `t-${uid()}`
    for (const n of ['u1', 'u2', 'u3']) {
      const u = makeMsg(topicId, n, 'user')
      const aId = n.replace('u', 'a')
      const a = makeMsg(topicId, aId, 'assistant', n)
      agg.appendMessage(topicId, u as any, [makeBlock(n) as any])
      agg.appendMessage(topicId, a as any, [makeBlock(aId) as any])
    }
    const bDel = okValue(agg.createBranch(topicId, null, 'a2', 'B-del')).branch.id
    const bMissing = okValue(agg.createBranch(topicId, null, 'a2', 'B-missing')).branch.id

    // Invalid branch fails closed, consistent with effective-route resolution
    const invalid = agg.fetchContextClosure({ topicId, branchId: 'branch-nope', anchorGroupKey: 'u1' })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error.code).toBe(ERR_NOT_FOUND)

    // Deleted branch fails closed
    expect(okValue(agg.deleteBranch(topicId, bDel)).deletedBranchIds).toContain(bDel)
    const deleted = agg.fetchContextClosure({ topicId, branchId: bDel, anchorGroupKey: 'u1' })
    expect(deleted.ok).toBe(false)
    if (!deleted.ok) expect(deleted.error.code).toBe(ERR_NOT_FOUND)
    // Main route still resolves after sibling subtree delete
    const mainStill = okValue(agg.fetchContextClosure({ topicId, anchorGroupKey: 'u1' }))
    expect(mainStill.closure.totalTurnCount).toBe(3)

    // Deleted fork anchor: the boundary moves to the nearest surviving
    // predecessor (u2), so the branch resolves with the shortened history it
    // inherited through the original fork point.
    expect(agg.deleteMessage(topicId, 'a2').ok).toBe(true)
    const missingAnchor = agg.fetchContextClosure({ topicId, branchId: bMissing, anchorGroupKey: 'u1' })
    expect(missingAnchor.ok).toBe(true)
    expect((okValue(agg.fetchMessages(topicId, bMissing)).messages as Array<{ id: string }>).map((m) => m.id)).toEqual([
      'u1',
      'a1',
      'u2'
    ])
  })
  // Folded (collapsed) message groups are presentation state persisted in the
  // segment row's extra overflow. Membership stays authority
  // (`topic_segment_messages`): the rows keep their place in the authority
  // window slice and the anchor still resolves on the raw turn set, while the
  // counts describe *participating* turns only (a turn participates when at
  // least one of its rows is not a folded member). That single definition is
  // what the actual request, the token-estimation list and the context count
  // consume, so folding can never move the window start and expanding restores
  // exactly the pre-fold participation.
  describe('folded group participation', () => {
    function seedTurns(topicId: string, turnCount: number): void {
      for (let i = 1; i <= turnCount; i++) {
        const userId = `u${i}`
        const assistantId = `a${i}`
        agg.appendMessage(topicId, makeMsg(topicId, userId, 'user') as any, [makeBlock(userId) as any])
        agg.appendMessage(topicId, makeMsg(topicId, assistantId, 'assistant', userId) as any, [
          makeBlock(assistantId) as any
        ])
      }
    }

    it('keeps the raw authority window and anchor but drops participating counts', () => {
      const topicId = `t-${uid()}`
      seedTurns(topicId, 3)
      const upserted = okValue(agg.upsertSegment('seg-fold', topicId, 'Group', ['u2', 'a2'], null))
      // Expanded by default: no folded property on the wire at all.
      expect(upserted.folded).toBeUndefined()
      expect((upserted as any).messageIds).toEqual(['u2', 'a2'])

      const foldedWire = okValue(agg.updateSegmentMetadata('seg-fold', undefined, undefined, true))
      expect(foldedWire.folded).toBe(true)
      // Folding is presentation only: membership is untouched.
      expect((foldedWire as any).messageIds).toEqual(['u2', 'a2'])
      expect((foldedWire as any).messageCount).toBe(2)

      const v = okValue(agg.fetchContextClosure({ topicId, anchorGroupKey: 'u1' }))
      // The authority slice still carries the folded rows in authority order.
      expect(v.messages.map((m: any) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3'])
      expect(v.blocks).toHaveLength(6)
      expect(v.closure.firstMessageId).toBe('u1')
      expect(v.closure.lastMessageId).toBe('a3')
      expect(v.closure.returnedCount).toBe(6)
      // Participating turns: the u1 turn and the u3 turn (the u2 turn is fully folded).
      expect(v.closure.totalTurnCount).toBe(2)
      expect(v.closure.selectedTurnCount).toBe(2)
      expect(v.closure.boundaryMessageId).toBeNull()
      expect(() => validateChatDbResult('chatdb:fetch-context-closure', { ok: true, value: v } as any)).not.toThrow()
    })

    it('folding above the anchor never moves the window start', () => {
      const topicId = `t-${uid()}`
      seedTurns(topicId, 3)
      okValue(agg.upsertSegment('seg-above', topicId, 'Group', ['u1', 'a1'], null))

      const before = okValue(agg.fetchContextClosure({ topicId, anchorGroupKey: 'u2' }))
      expect(before.closure.firstMessageId).toBe('u2')
      expect(before.closure.totalTurnCount).toBe(3)
      expect(before.closure.selectedTurnCount).toBe(2)
      expect(before.closure.boundaryMessageId).toBe('u2')

      okValue(agg.updateSegmentMetadata('seg-above', undefined, undefined, true))
      const after = okValue(agg.fetchContextClosure({ topicId, anchorGroupKey: 'u2' }))
      // Same persisted anchor, same window origin, same raw slice.
      expect(after.closure.anchorGroupKey).toBe('u2')
      expect(after.closure.firstMessageId).toBe('u2')
      expect(after.messages.map((m: any) => m.id)).toEqual(['u2', 'a2', 'u3', 'a3'])
      expect(after.closure.returnedCount).toBe(4)
      // The folded turn is no longer history this route would send, so the
      // participating window now covers the whole participating topic.
      expect(after.closure.totalTurnCount).toBe(2)
      expect(after.closure.selectedTurnCount).toBe(2)
      expect(after.closure.boundaryMessageId).toBeNull()
      expect(() =>
        validateChatDbResult('chatdb:fetch-context-closure', { ok: true, value: after } as any)
      ).not.toThrow()
    })

    it('expanding restores the pre-fold counts, boundary and participation exactly', () => {
      const topicId = `t-${uid()}`
      seedTurns(topicId, 3)
      okValue(agg.upsertSegment('seg-toggle', topicId, 'Group', ['u2', 'a2'], null))
      const baseline = okValue(agg.fetchContextClosure({ topicId, anchorGroupKey: 'u1' }))
      expect(baseline.closure.totalTurnCount).toBe(3)
      expect(baseline.closure.selectedTurnCount).toBe(3)
      expect(baseline.closure.boundaryMessageId).toBeNull()

      okValue(agg.updateSegmentMetadata('seg-toggle', undefined, undefined, true))
      const folded = okValue(agg.fetchContextClosure({ topicId, anchorGroupKey: 'u1' }))
      expect(folded.closure.totalTurnCount).toBe(2)
      expect(folded.closure.selectedTurnCount).toBe(2)

      okValue(agg.updateSegmentMetadata('seg-toggle', undefined, undefined, false))
      const expanded = okValue(agg.fetchContextClosure({ topicId, anchorGroupKey: 'u1' }))
      // Identity restore: same messages, same blocks, same counts, same boundary.
      expect(expanded.messages.map((m: any) => m.id)).toEqual(baseline.messages.map((m: any) => m.id))
      expect(expanded.blocks.map((b: any) => b.id)).toEqual(baseline.blocks.map((b: any) => b.id))
      expect(expanded.closure.totalTurnCount).toBe(baseline.closure.totalTurnCount)
      expect(expanded.closure.selectedTurnCount).toBe(baseline.closure.selectedTurnCount)
      expect(expanded.closure.boundaryMessageId).toBe(baseline.closure.boundaryMessageId)
      expect(expanded.closure.anchorGroupKey).toBe(baseline.closure.anchorGroupKey)
    })

    it('persists folded state so a fresh service instance reads it back, and null clears it', () => {
      const topicId = `t-${uid()}`
      seedTurns(topicId, 2)
      okValue(agg.upsertSegment('seg-persist', topicId, 'Group', ['u2', 'a2'], '#ff0000'))
      okValue(agg.updateSegmentMetadata('seg-persist', undefined, undefined, true))

      // Fresh aggregate over the same database = process-restart readback of the
      // segment catalog (no in-memory folded cache anywhere).
      const reloaded = new ChatDbAggregateService(db, sqlite)
      const listed = okValue(reloaded.listSegments(topicId))
      expect(listed).toHaveLength(1)
      expect(listed[0].folded).toBe(true)
      // Unrelated overflow keys survive the folded write.
      expect(listed[0].color).toBe('#ff0000')
      // The segment wire validator accepts the persisted folded flag.
      expect(() => validateChatDbResult('chatdb:list-segments', { ok: true, value: listed } as any)).not.toThrow()

      // Clearing (null) removes the persisted flag, i.e. back to expanded.
      const cleared = okValue(reloaded.updateSegmentMetadata('seg-persist', undefined, undefined, null))
      expect(cleared.folded).toBeUndefined()
      expect(okValue(reloaded.listSegments(topicId))[0].folded).toBeUndefined()
      expect(okValue(reloaded.listSegments(topicId))[0].folded).toBeUndefined()
      const restored = okValue(reloaded.fetchContextClosure({ topicId, anchorGroupKey: 'u1' }))
      expect(restored.closure.totalTurnCount).toBe(2)
      expect(restored.closure.selectedTurnCount).toBe(2)
      expect(restored.closure.boundaryMessageId).toBeNull()
    })

    it('branch-owned folded groups do not change the main route windows', () => {
      const topicId = `t-${uid()}`
      seedTurns(topicId, 3)
      const branchId = okValue(agg.createBranch(topicId, null, 'a2', 'B')).branch.id
      agg.appendMessage(
        topicId,
        makeMsg(topicId, 'b1u', 'user') as any,
        [makeBlock('b1u') as any],
        undefined,
        undefined,
        { branchId }
      )
      agg.appendMessage(
        topicId,
        makeMsg(topicId, 'b1a', 'assistant', 'b1u') as any,
        [makeBlock('b1a') as any],
        undefined,
        undefined,
        { branchId }
      )
      // Segment owned by the branch route (its own rows only).
      okValue(agg.upsertSegment('seg-branch', topicId, 'BranchGroup', ['b1u', 'b1a'], null, branchId))

      const mainBefore = okValue(agg.fetchContextClosure({ topicId, anchorGroupKey: 'u1' }))
      const branchBefore = okValue(agg.fetchContextClosure({ topicId, branchId, anchorGroupKey: 'u1' }))
      expect(mainBefore.closure.totalTurnCount).toBe(3)
      // Effective branch route: inherited u1/u2 turns plus the branch-owned turn.
      expect(branchBefore.closure.totalTurnCount).toBe(3)

      // Owner-only mutation: folding removes request context, so it may only
      // happen through the route that owns every member. Through the main
      // route the branch-owned group is read-only and rejects unchanged.
      const rejected = agg.updateSegmentMetadata('seg-branch', undefined, undefined, true)
      expect(rejected.ok).toBe(false)
      expect((rejected as any).error.code).toBe('VALIDATION_ERROR')
      expect((rejected as any).error.message).toContain('read-only from the addressed route')
      const mainAfter = okValue(agg.fetchContextClosure({ topicId, anchorGroupKey: 'u1' }))
      // Main route ownership/order/window untouched: folded members are branch rows.
      expect(mainAfter.closure.totalTurnCount).toBe(3)
      expect(mainAfter.closure.selectedTurnCount).toBe(3)
      expect(mainAfter.messages.map((m: any) => m.id)).toEqual(mainBefore.messages.map((m: any) => m.id))

      // Its own route owns the members, so the fold lands there.
      okValue(agg.updateSegmentMetadata('seg-branch', undefined, undefined, true, branchId))
      const branchAfter = okValue(agg.fetchContextClosure({ topicId, branchId, anchorGroupKey: 'u1' }))
      // The folded branch group stops taking part on its own route only.
      expect(branchAfter.closure.totalTurnCount).toBe(2)
      expect(branchAfter.closure.selectedTurnCount).toBe(2)
      expect(branchAfter.closure.boundaryMessageId).toBeNull()
      expect(branchAfter.messages.map((m: any) => m.id)).toContain('b1u')
      // Branch anchor ownership is unchanged: the branch segment's own members
      // remain resolvable as an anchor (authority rows, not projection).
      const ownedAnchor = okValue(agg.fetchContextClosure({ topicId, branchId, anchorGroupKey: 'b1u' }))
      expect(ownedAnchor.closure.selectedTurnCount).toBe(1)
    })

    it('an inherited main-route group cannot be folded through a branch route', () => {
      const topicId = `t-${uid()}`
      seedTurns(topicId, 3)
      okValue(agg.upsertSegment('seg-main', topicId, 'MainGroup', ['u2', 'a2'], null))
      const branchId = okValue(agg.createBranch(topicId, null, 'a2', 'B')).branch.id
      agg.appendMessage(
        topicId,
        makeMsg(topicId, 'b1u', 'user') as any,
        [makeBlock('b1u') as any],
        undefined,
        undefined,
        { branchId }
      )
      // The effective branch route inherits the main rows, but inheritance is
      // read-only: the owner of u2/a2 is the main route.
      const inherited = agg.updateSegmentMetadata('seg-main', undefined, undefined, true, branchId)
      expect(inherited.ok).toBe(false)
      expect((inherited as any).error.code).toBe('VALIDATION_ERROR')
      expect((inherited as any).error.message).toContain('read-only from the addressed route')
      // Nothing changed anywhere.
      const before = okValue(agg.listSegments(topicId)).find((s) => s.id === 'seg-main')
      expect(before?.folded).toBeUndefined()
      // The owner route may fold it.
      okValue(agg.updateSegmentMetadata('seg-main', undefined, undefined, true))
      const after = okValue(agg.listSegments(topicId)).find((s) => s.id === 'seg-main')
      expect(after?.folded).toBe(true)
    })

    it('partial fold at the anchor keeps the raw window start but names the first participating divider', () => {
      const topicId = `t-${uid()}`
      seedTurns(topicId, 3)
      // The anchor turn's first row (u2) is hidden; a2 of the same turn still
      // participates, so the turn itself still participates.
      okValue(agg.upsertSegment('seg-partial-anchor', topicId, 'Partial', ['u2'], null))
      okValue(agg.updateSegmentMetadata('seg-partial-anchor', undefined, undefined, true))
      const v = okValue(agg.fetchContextClosure({ topicId, anchorGroupKey: 'u2' }))
      okValue(agg.updateSegmentMetadata('seg-partial-anchor', undefined, undefined, true))
      expect(v.closure.anchorGroupKey).toBe('u2')
      // Raw window keeps the persisted anchor row even though it is folded.
      expect(v.closure.firstMessageId).toBe('u2')
      expect(v.messages.map((m: any) => m.id)).toEqual(['u2', 'a2', 'u3', 'a3'])
      // All three turns participate (each keeps one participating row); the
      // window keeps two of them and its divider is the first PARTICIPATING row
      // of the window (a2), never the hidden u2.
      expect(v.closure.totalTurnCount).toBe(3)
      expect(v.closure.selectedTurnCount).toBe(2)
      expect(v.closure.boundaryMessageId).toBe('a2')
      expect(() => validateChatDbResult('chatdb:fetch-context-closure', { ok: true, value: v } as any)).not.toThrow()

      // Cleared, then a partial window whose first row is folded (anchor u3).
      okValue(agg.updateSegmentMetadata('seg-partial-anchor', undefined, undefined, null))
      okValue(agg.upsertSegment('seg-partial-u3', topicId, 'Partial3', ['u3'], null, undefined, true))
      const partial = okValue(agg.fetchContextClosure({ topicId, anchorGroupKey: 'u3' }))
      expect(partial.closure.firstMessageId).toBe('u3')
      expect(partial.closure.totalTurnCount).toBe(3)
      expect(partial.closure.selectedTurnCount).toBe(1)
      expect(partial.closure.boundaryMessageId).toBe('a3')
      expect(() =>
        validateChatDbResult('chatdb:fetch-context-closure', { ok: true, value: partial } as any)
      ).not.toThrow()
    })
  })
})
