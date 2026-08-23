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
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-win-group-'))
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
  return `wg${++counter}-${Date.now()}`
}
function okValue<T>(r: { ok: boolean; value?: T; error?: unknown }): T {
  if (!isSuccess(r as any)) throw new Error(`Expected success: ${JSON.stringify((r as any).error)}`)
  return (r as any).value as T
}
function makeMsg(topicId: string, id: string, role: string, askId?: string | null): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id,
    topicId,
    role,
    content: `content-${id}`,
    status: 'success',
    createdAt: new Date().toISOString()
  }
  if (askId !== undefined && askId !== null) base.askId = askId
  return base
}
function makeBlock(messageId: string, suffix = ''): Record<string, unknown> {
  return {
    id: `b-${messageId}${suffix}`,
    messageId,
    type: 'main_text',
    content: `block-${messageId}`,
    status: 'success',
    createdAt: new Date().toISOString()
  }
}

describe('ChatDbAggregateService — windowed reads group semantics (R-02/R-03/R-04 bounded fix)', () => {
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

  /**
   * Topology for these tests (groups in order):
   * G0: user u1               (singleton)
   * G1: assistant a1,a2,a3 (askA) size3
   * G2: user u2               singleton
   * G3: assistant b1,b2 (askB) size2
   * G4: user u3               singleton
   * total groups 5, total messages 8
   */
  function seedGroupedTopic(topicId: string): {
    u1: string
    a1: string
    a2: string
    a3: string
    u2: string
    b1: string
    b2: string
    u3: string
  } {
    const ids = {
      u1: `u1-${uid()}`,
      a1: `a1-${uid()}`,
      a2: `a2-${uid()}`,
      a3: `a3-${uid()}`,
      u2: `u2-${uid()}`,
      b1: `b1-${uid()}`,
      b2: `b2-${uid()}`,
      u3: `u3-${uid()}`
    }
    const askA = `askA-${uid()}`
    const askB = `askB-${uid()}`
    // insertion order defines sort_order
    agg.appendMessage(topicId, makeMsg(topicId, ids.u1, 'user') as any, [makeBlock(ids.u1) as any])
    agg.appendMessage(topicId, makeMsg(topicId, ids.a1, 'assistant', askA) as any, [makeBlock(ids.a1) as any])
    agg.appendMessage(topicId, makeMsg(topicId, ids.a2, 'assistant', askA) as any, [makeBlock(ids.a2) as any])
    agg.appendMessage(topicId, makeMsg(topicId, ids.a3, 'assistant', askA) as any, [makeBlock(ids.a3) as any])
    agg.appendMessage(topicId, makeMsg(topicId, ids.u2, 'user') as any, [makeBlock(ids.u2) as any])
    agg.appendMessage(topicId, makeMsg(topicId, ids.b1, 'assistant', askB) as any, [makeBlock(ids.b1) as any])
    agg.appendMessage(topicId, makeMsg(topicId, ids.b2, 'assistant', askB) as any, [makeBlock(ids.b2) as any])
    agg.appendMessage(topicId, makeMsg(topicId, ids.u3, 'user') as any, [makeBlock(ids.u3) as any])
    return ids
  }

  it('latest counts complete groups not raw messages', () => {
    const topicId = `t-${uid()}`
    const ids = seedGroupedTopic(topicId)

    // limit 2 groups => last 2 groups G3(2) + G4(1) = 3 messages b1,b2,u3
    const res2 = agg.fetchMessagesWindow({ kind: 'latest', topicId, limit: 2 })
    const v2 = okValue(res2)
    expect(v2.messages.map((m: any) => m.id)).toEqual([ids.b1, ids.b2, ids.u3])
    expect(v2.window.hasMoreBefore).toBe(true)
    expect(v2.window.hasMoreAfter).toBe(false)
    expect(v2.window.returnedCount).toBe(3)
    expect(v2.window.firstMessageId).toBe(ids.b1)
    expect(v2.window.lastMessageId).toBe(ids.u3)

    // limit 1 group => last group G4 alone = 1 message u3
    const res1 = agg.fetchMessagesWindow({ kind: 'latest', topicId, limit: 1 })
    const v1 = okValue(res1)
    expect(v1.messages.map((m: any) => m.id)).toEqual([ids.u3])
    expect(v1.window.hasMoreBefore).toBe(true)
    expect(v1.window.hasMoreAfter).toBe(false)

    // limit covering all groups => whole topic, hasMoreBefore false
    const res5 = agg.fetchMessagesWindow({ kind: 'latest', topicId, limit: 5 })
    const v5 = okValue(res5)
    expect(v5.messages.map((m: any) => m.id)).toEqual([ids.u1, ids.a1, ids.a2, ids.a3, ids.u2, ids.b1, ids.b2, ids.u3])
    expect(v5.window.hasMoreBefore).toBe(false)

    // limit larger than groups still returns all
    const res10 = agg.fetchMessagesWindow({ kind: 'latest', topicId, limit: 10 })
    const v10 = okValue(res10)
    expect(v10.messages.map((m: any) => m.id)).toEqual(v5.messages.map((m: any) => m.id))
    expect(v10.window.hasMoreBefore).toBe(false)
  })

  it('around includes anchor group plus N complete groups and never splits groups', () => {
    const topicId = `t-${uid()}`
    const ids = seedGroupedTopic(topicId)

    // anchor b1 inside G3 (size2). around before 1 after 1 should be G2+G3+G4 => u2,b1,b2,u3
    const res = agg.fetchMessagesWindow({
      kind: 'around',
      topicId,
      anchorMessageId: ids.b1,
      before: 1,
      after: 1
    })
    const v = okValue(res)
    expect(v.messages.map((m: any) => m.id)).toEqual([ids.u2, ids.b1, ids.b2, ids.u3])
    expect(v.window.hasMoreBefore).toBe(true) // G0,G1 remain before
    expect(v.window.hasMoreAfter).toBe(false) // G4 is tail, after 1 reached end

    // anchor b2 (same group) should return identical window — entire anchor group included
    const resSame = agg.fetchMessagesWindow({
      kind: 'around',
      topicId,
      anchorMessageId: ids.b2,
      before: 1,
      after: 1
    })
    const vSame = okValue(resSame)
    expect(vSame.messages.map((m: any) => m.id)).toEqual(v.messages.map((m: any) => m.id))
  })

  it('around with before 0 around multi-message anchor returns whole group', () => {
    const topicId = `t-${uid()}`
    const ids = seedGroupedTopic(topicId)
    // anchor a2 in G1 size3. The smallest contract-legal around that still probes group completeness:
    // before 1 after 1 from G1 should return G0 + G1 + G2, never split G1
    const res2 = agg.fetchMessagesWindow({
      kind: 'around',
      topicId,
      anchorMessageId: ids.a2,
      before: 1,
      after: 1
    })
    const v2 = okValue(res2)
    // G0(us1) + G1(3) + G2(u2) => 5 messages
    expect(v2.messages.map((m: any) => m.id)).toEqual([ids.u1, ids.a1, ids.a2, ids.a3, ids.u2])
    expect(v2.window.hasMoreBefore).toBe(false)
    expect(v2.window.hasMoreAfter).toBe(true)

    // Also verify atomic group: a direct check that before=1 never returns partial G1
    // If anchor is u2 (G2 singleton) before 1 should include entire G1 (size3) not just 1 message of it
    const resU2 = agg.fetchMessagesWindow({
      kind: 'around',
      topicId,
      anchorMessageId: ids.u2,
      before: 1,
      after: 1
    })
    const vU2 = okValue(resU2)
    // before 1 group = G1 (3 msgs), anchor G2 (1), after 1 = G3 (2) => 6 msgs
    expect(vU2.messages.map((m: any) => m.id)).toEqual([ids.a1, ids.a2, ids.a3, ids.u2, ids.b1, ids.b2])
    expect(vU2.messages).toHaveLength(6)
  })

  it('around anchor in first group before large clamps correctly with group hasMore', () => {
    const topicId = `t-${uid()}`
    const ids = seedGroupedTopic(topicId)
    const res = agg.fetchMessagesWindow({
      kind: 'around',
      topicId,
      anchorMessageId: ids.u1,
      before: 5,
      after: 1
    })
    const v = okValue(res)
    // G0 + G1 => u1,a1,a2,a3 (2 groups)
    expect(v.messages.map((m: any) => m.id)).toEqual([ids.u1, ids.a1, ids.a2, ids.a3])
    expect(v.window.hasMoreBefore).toBe(false)
    expect(v.window.hasMoreAfter).toBe(true)

    const resEnd = agg.fetchMessagesWindow({
      kind: 'around',
      topicId,
      anchorMessageId: ids.u3,
      before: 1,
      after: 5
    })
    const vEnd = okValue(resEnd)
    // G3+G4 => b1,b2,u3
    expect(vEnd.messages.map((m: any) => m.id)).toEqual([ids.b1, ids.b2, ids.u3])
    expect(vEnd.window.hasMoreBefore).toBe(true)
    expect(vEnd.window.hasMoreAfter).toBe(false)
  })

  it('latest preserves empty, not-found and deterministic ordering', () => {
    const topicId = `t-${uid()}`
    agg.ensureTopic(topicId)
    const empty = agg.fetchMessagesWindow({ kind: 'latest', topicId, limit: 10 })
    expect(empty.ok).toBe(true)
    const ev = okValue(empty)
    expect(ev.messages).toEqual([])
    expect(ev.blocks).toEqual([])
    expect(ev.window.returnedCount).toBe(0)
    expect(ev.window.firstMessageId).toBeNull()
    expect(ev.window.lastMessageId).toBeNull()
    expect(ev.window.hasMoreBefore).toBe(false)
    expect(ev.window.hasMoreAfter).toBe(false)

    const missing = agg.fetchMessagesWindow({ kind: 'latest', topicId: 'nope-' + uid(), limit: 10 })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe(ERR_NOT_FOUND)

    const aroundMissing = agg.fetchMessagesWindow({
      kind: 'around',
      topicId,
      anchorMessageId: 'missing-' + uid(),
      before: 1,
      after: 1
    })
    expect(aroundMissing.ok).toBe(false)
    if (!aroundMissing.ok) expect(aroundMissing.error.code).toBe(ERR_NOT_FOUND)
  })

  it('group boundary splits: same askId non-consecutive forms separate groups', () => {
    const topicId = `t-${uid()}`
    const askX = `askX-${uid()}`
    const a1 = `a1-${uid()}`
    const u1 = `u1-${uid()}`
    const a2 = `a2-${uid()}`
    const a3 = `a3-${uid()}`
    // a1 (askX), u1, a2 (askX), a3 (askX consecutive)
    // Expected groups: [a1] , [u1], [a2,a3]  => 3 groups (not 2 merged askX)
    agg.appendMessage(topicId, makeMsg(topicId, a1, 'assistant', askX) as any, [makeBlock(a1) as any])
    agg.appendMessage(topicId, makeMsg(topicId, u1, 'user') as any, [makeBlock(u1) as any])
    agg.appendMessage(topicId, makeMsg(topicId, a2, 'assistant', askX) as any, [makeBlock(a2) as any])
    agg.appendMessage(topicId, makeMsg(topicId, a3, 'assistant', askX) as any, [makeBlock(a3) as any])

    // latest 2 groups => [u1] + [a2,a3] => 3 messages
    const res = agg.fetchMessagesWindow({ kind: 'latest', topicId, limit: 2 })
    const v = okValue(res)
    expect(v.messages.map((m: any) => m.id)).toEqual([u1, a2, a3])
    expect(v.window.hasMoreBefore).toBe(true)

    // around a2 with before 1 after 0 => should include [a2,a3] + previous group [u1] ??? actually before1 from group [a2,a3] => [u1] + [a2,a3] => u1,a2,a3
    const resAround = agg.fetchMessagesWindow({
      kind: 'around',
      topicId,
      anchorMessageId: a2,
      before: 1,
      after: 1
    })
    const vAround = okValue(resAround)
    // groups: G0[a1], G1[u1], G2[a2,a3]; anchor G2, before1 => G1, after1 beyond => clamp
    expect(vAround.messages.map((m: any) => m.id)).toEqual([u1, a2, a3])
    expect(vAround.window.hasMoreBefore).toBe(true)
    expect(vAround.window.hasMoreAfter).toBe(false)
  })

  it('assistant without askId remains singleton', () => {
    const topicId = `t-${uid()}`
    const aNoAsk1 = `aNo1-${uid()}`
    const aNoAsk2 = `aNo2-${uid()}`
    const u1 = `u1-${uid()}`
    agg.appendMessage(topicId, makeMsg(topicId, aNoAsk1, 'assistant', '') as any, [makeBlock(aNoAsk1) as any])
    agg.appendMessage(topicId, makeMsg(topicId, aNoAsk2, 'assistant', '') as any, [makeBlock(aNoAsk2) as any])
    agg.appendMessage(topicId, makeMsg(topicId, u1, 'user') as any, [makeBlock(u1) as any])
    // Each assistant no-askId is singleton => groups 3
    const res = agg.fetchMessagesWindow({ kind: 'latest', topicId, limit: 2 })
    const v = okValue(res)
    expect(v.messages.map((m: any) => m.id)).toEqual([aNoAsk2, u1])
    expect(v.messages).toHaveLength(2)
  })

  it('blocks are complete per group window and ordering stays sort_order ASC', () => {
    const topicId = `t-${uid()}`
    const ids = seedGroupedTopic(topicId)
    const res = agg.fetchMessagesWindow({ kind: 'around', topicId, anchorMessageId: ids.u2, before: 1, after: 1 })
    const v = okValue(res)
    // should have 6 messages including a1,a2,a3 (each with block) etc
    const expectedIds = [ids.a1, ids.a2, ids.a3, ids.u2, ids.b1, ids.b2]
    expect(v.messages.map((m: any) => m.id)).toEqual(expectedIds)
    // blocks length == messages length (1 per)
    expect(v.blocks).toHaveLength(expectedIds.length)
    // ordering already asserted via expectedIds order
    // verify message.blocks relation reconstructed
    const bMap = new Map(v.blocks.map((b: any) => [b.id, b]))
    for (const msg of v.messages as any[]) {
      expect(Array.isArray(msg.blocks)).toBe(true)
      for (const bid of msg.blocks) {
        expect(bMap.has(bid)).toBe(true)
      }
    }
  })
})
