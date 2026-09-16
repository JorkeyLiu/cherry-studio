import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

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
import { MessagesRepository } from '../repository/MessagesRepository'
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-win-bounded-'))
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
  return `wb${++counter}-${Date.now()}`
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

describe('ChatDbAggregateService — bounded SQL window reads (latest/around)', () => {
  let tmpDir: string
  let sqlite: Database.Database
  let db: BetterSQLite3Database<typeof schema>
  let agg: ChatDbAggregateService
  let listByTopicSpy: MockInstance

  beforeEach(() => {
    tmpDir = makeTempDir()
    sqlite = openTestDb(realPath.join(tmpDir, 'test.db'))
    db = wrapDrizzle(sqlite)
    runMigrations(db, sqlite)
    agg = new ChatDbAggregateService(db, sqlite)
    mockCleanTopic.mockReset().mockResolvedValue(undefined)
    listByTopicSpy = vi.spyOn(MessagesRepository.prototype, 'listByTopic')
  })
  afterEach(() => {
    listByTopicSpy.mockRestore()
    try {
      sqlite.close()
    } catch {}
    rmrf(tmpDir)
  })

  /**
   * Topology (groups in order):
   * G0: user u1 | G1: assistant a1,a2,a3 (askA) | G2: user u2 |
   * G3: assistant b1,b2 (askB) | G4: user u3
   */
  function seedGroupedTopic(topicId: string): Record<string, string> {
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

  it('latest: tail groups via bounded scan, never listByTopic', () => {
    const topicId = `t-${uid()}`
    const ids = seedGroupedTopic(topicId)
    listByTopicSpy.mockClear()

    const res = agg.fetchMessagesWindow({ kind: 'latest', topicId, limit: 2 })
    expect(listByTopicSpy).not.toHaveBeenCalled()
    const v = okValue(res)
    expect(v.messages.map((m: any) => m.id)).toEqual([ids.b1, ids.b2, ids.u3])
    expect(v.window.kind).toBe('latest')
    expect(v.window.completeness).toBe('window')
    expect(v.window.requested.limit).toBe(2)
    expect(v.window.returnedCount).toBe(3)
    expect(v.window.firstMessageId).toBe(ids.b1)
    expect(v.window.lastMessageId).toBe(ids.u3)
    expect(v.window.hasMoreBefore).toBe(true)
    expect(v.window.hasMoreAfter).toBe(false)
    expect(v.window.anchorMessageId).toBeNull()
  })

  it('around: anchor group plus neighbors via bounded scan, never listByTopic', () => {
    const topicId = `t-${uid()}`
    const ids = seedGroupedTopic(topicId)
    listByTopicSpy.mockClear()

    const res = agg.fetchMessagesWindow({
      kind: 'around',
      topicId,
      anchorMessageId: ids.b1,
      before: 1,
      after: 1
    })
    expect(listByTopicSpy).not.toHaveBeenCalled()
    const v = okValue(res)
    // G2 + G3 (whole anchor group b1,b2) + G4
    expect(v.messages.map((m: any) => m.id)).toEqual([ids.u2, ids.b1, ids.b2, ids.u3])
    expect(v.window.kind).toBe('around')
    expect(v.window.anchorMessageId).toBe(ids.b1)
    expect(v.window.requested.before).toBe(1)
    expect(v.window.requested.after).toBe(1)
    expect(v.window.hasMoreBefore).toBe(true)
    expect(v.window.hasMoreAfter).toBe(false)
    expect(v.window.returnedCount).toBe(4)

    // Same-group anchor returns the identical window (group never split).
    listByTopicSpy.mockClear()
    const resSame = agg.fetchMessagesWindow({
      kind: 'around',
      topicId,
      anchorMessageId: ids.b2,
      before: 1,
      after: 1
    })
    expect(listByTopicSpy).not.toHaveBeenCalled()
    const vSame = okValue(resSame)
    expect(vSame.messages.map((m: any) => m.id)).toEqual(v.messages.map((m: any) => m.id))
  })

  it('latest: pathological large group never split via bounded chunks', () => {
    const topicId = `t-${uid()}`
    const head = `head-${uid()}`
    const tail = `tail-${uid()}`
    const askBig = `askBig-${uid()}`
    const runIds: string[] = []
    agg.appendMessage(topicId, makeMsg(topicId, head, 'user') as any, [makeBlock(head) as any])
    for (let i = 0; i < 400; i++) {
      const id = `big-${uid()}-${i}`
      runIds.push(id)
      agg.appendMessage(topicId, makeMsg(topicId, id, 'assistant', askBig) as any, [makeBlock(id) as any])
    }
    agg.appendMessage(topicId, makeMsg(topicId, tail, 'user') as any, [makeBlock(tail) as any])
    listByTopicSpy.mockClear()

    // limit 1 group from the tail: G(400-run is not tail; tail singleton is) => just [tail]
    const resTail = agg.fetchMessagesWindow({ kind: 'latest', topicId, limit: 1 })
    expect(listByTopicSpy).not.toHaveBeenCalled()
    const vTail = okValue(resTail)
    expect(vTail.messages.map((m: any) => m.id)).toEqual([tail])
    expect(vTail.window.hasMoreBefore).toBe(true)

    // limit 2 groups: whole 400-run + tail, never a partial run
    listByTopicSpy.mockClear()
    const res = agg.fetchMessagesWindow({ kind: 'latest', topicId, limit: 2 })
    expect(listByTopicSpy).not.toHaveBeenCalled()
    const v = okValue(res)
    expect(v.messages.map((m: any) => m.id)).toEqual([...runIds, tail])
    expect(v.window.returnedCount).toBe(401)
    expect(v.window.firstMessageId).toBe(runIds[0])
    expect(v.window.lastMessageId).toBe(tail)
    expect(v.window.hasMoreBefore).toBe(true)
  })

  it('around: anchor inside pathological run returns whole run plus neighbors', () => {
    const topicId = `t-${uid()}`
    const head = `head-${uid()}`
    const tail = `tail-${uid()}`
    const askBig = `askBig-${uid()}`
    const runIds: string[] = []
    agg.appendMessage(topicId, makeMsg(topicId, head, 'user') as any, [makeBlock(head) as any])
    for (let i = 0; i < 300; i++) {
      const id = `bigrun-${uid()}-${i}`
      runIds.push(id)
      agg.appendMessage(topicId, makeMsg(topicId, id, 'assistant', askBig) as any, [makeBlock(id) as any])
    }
    agg.appendMessage(topicId, makeMsg(topicId, tail, 'user') as any, [makeBlock(tail) as any])
    listByTopicSpy.mockClear()

    const res = agg.fetchMessagesWindow({
      kind: 'around',
      topicId,
      anchorMessageId: runIds[150],
      before: 1,
      after: 1
    })
    expect(listByTopicSpy).not.toHaveBeenCalled()
    const v = okValue(res)
    expect(v.messages.map((m: any) => m.id)).toEqual([head, ...runIds, tail])
    expect(v.window.hasMoreBefore).toBe(false)
    expect(v.window.hasMoreAfter).toBe(false)
  })

  it('equal sortOrder ties resolve deterministically by id on bounded paths', () => {
    const topicId = `t-${uid()}`
    agg.appendMessage(topicId, makeMsg(topicId, 'tie-c', 'user') as any, [makeBlock('tie-c') as any])
    agg.appendMessage(topicId, makeMsg(topicId, 'tie-a', 'user') as any, [makeBlock('tie-a') as any])
    agg.appendMessage(topicId, makeMsg(topicId, 'tie-b', 'user') as any, [makeBlock('tie-b') as any])
    // Force a three-way sort_order tie at the storage layer (legacy/corrupt order).
    sqlite.prepare('UPDATE messages SET sort_order = 7 WHERE topic_id = ?').run(topicId)
    listByTopicSpy.mockClear()

    const res = agg.fetchMessagesWindow({ kind: 'latest', topicId, limit: 10 })
    expect(listByTopicSpy).not.toHaveBeenCalled()
    const v = okValue(res)
    expect(v.messages.map((m: any) => m.id)).toEqual(['tie-a', 'tie-b', 'tie-c'])
    expect(v.window.hasMoreBefore).toBe(false)

    listByTopicSpy.mockClear()
    const around = agg.fetchMessagesWindow({
      kind: 'around',
      topicId,
      anchorMessageId: 'tie-b',
      before: 1,
      after: 1
    })
    expect(listByTopicSpy).not.toHaveBeenCalled()
    const va = okValue(around)
    expect(va.messages.map((m: any) => m.id)).toEqual(['tie-a', 'tie-b', 'tie-c'])
    expect(va.window.hasMoreBefore).toBe(false)
    expect(va.window.hasMoreAfter).toBe(false)
  })

  it('missing topic, missing anchor, and cross-topic anchor stay NOT_FOUND without listByTopic', () => {
    const t1 = `t-${uid()}`
    const t2 = `t-${uid()}`
    const m1 = makeMsg(t1, `m1-${uid()}`, 'user')
    const m2 = makeMsg(t2, `m2-${uid()}`, 'user')
    agg.appendMessage(t1, m1 as any, [makeBlock(m1.id as string) as any])
    agg.appendMessage(t2, m2 as any, [makeBlock(m2.id as string) as any])
    listByTopicSpy.mockClear()

    const missingTopic = agg.fetchMessagesWindow({ kind: 'latest', topicId: `nope-${uid()}`, limit: 5 })
    expect(listByTopicSpy).not.toHaveBeenCalled()
    expect(missingTopic.ok).toBe(false)
    if (!missingTopic.ok) expect(missingTopic.error.code).toBe(ERR_NOT_FOUND)

    listByTopicSpy.mockClear()
    const missingAnchor = agg.fetchMessagesWindow({
      kind: 'around',
      topicId: t1,
      anchorMessageId: `ghost-${uid()}`,
      before: 1,
      after: 1
    })
    expect(listByTopicSpy).not.toHaveBeenCalled()
    expect(missingAnchor.ok).toBe(false)
    if (!missingAnchor.ok) expect(missingAnchor.error.code).toBe(ERR_NOT_FOUND)

    listByTopicSpy.mockClear()
    const crossTopic = agg.fetchMessagesWindow({
      kind: 'around',
      topicId: t1,
      anchorMessageId: m2.id as string,
      before: 1,
      after: 1
    })
    expect(listByTopicSpy).not.toHaveBeenCalled()
    expect(crossTopic.ok).toBe(false)
    if (!crossTopic.ok) expect(crossTopic.error.code).toBe(ERR_NOT_FOUND)
  })

  it('empty topic returns empty window success without listByTopic', () => {
    const topicId = `t-${uid()}`
    agg.ensureTopic(topicId)
    listByTopicSpy.mockClear()
    const res = agg.fetchMessagesWindow({ kind: 'latest', topicId, limit: 10 })
    expect(listByTopicSpy).not.toHaveBeenCalled()
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

  it('window blocks are complete per returned message only', () => {
    const topicId = `t-${uid()}`
    const m1 = makeMsg(topicId, `m1-${uid()}`, 'user')
    const m2 = makeMsg(topicId, `m2-${uid()}`, 'user')
    const b1 = { ...makeBlock(m1.id as string, '-1'), id: `b1-${uid()}` }
    const b2 = { ...makeBlock(m1.id as string, '-2'), id: `b2-${uid()}` }
    const b3 = { ...makeBlock(m2.id as string, '-3'), id: `b3-${uid()}` }
    ;(b1 as any).messageId = m1.id
    ;(b2 as any).messageId = m1.id
    ;(b3 as any).messageId = m2.id
    agg.appendMessage(topicId, m1 as any, [b1 as any, b2 as any])
    agg.appendMessage(topicId, m2 as any, [b3 as any])
    listByTopicSpy.mockClear()

    const res = agg.fetchMessagesWindow({ kind: 'latest', topicId, limit: 1 })
    expect(listByTopicSpy).not.toHaveBeenCalled()
    const v = okValue(res)
    expect(v.messages).toHaveLength(1)
    expect((v.messages[0] as any).id).toBe(m2.id)
    expect(v.blocks).toHaveLength(1)
    expect((v.blocks[0] as any).id).toBe(b3.id)

    listByTopicSpy.mockClear()
    const res2 = agg.fetchMessagesWindow({
      kind: 'around',
      topicId,
      anchorMessageId: m1.id as string,
      before: 1,
      after: 1
    })
    expect(listByTopicSpy).not.toHaveBeenCalled()
    const v2 = okValue(res2)
    expect(v2.blocks.map((b: any) => b.id).sort()).toEqual([b1.id, b2.id, b3.id].sort())
    expect(v2.messages.find((m: any) => m.id === m1.id)?.blocks).toEqual([b1.id, b2.id])
    const blockIds = new Set(v2.blocks.map((b: any) => b.id))
    for (const msg of v2.messages as any[]) {
      for (const bid of msg.blocks) expect(blockIds.has(bid)).toBe(true)
    }
  })

  it('large topic tail read stays bounded: chunk limits capped, whole scan never materializes', () => {
    const topicId = `t-${uid()}`
    const ids: string[] = []
    for (let i = 0; i < 1200; i++) {
      const m = makeMsg(topicId, `bulk-${uid()}-${i}`, 'user')
      ids.push(m.id as string)
      agg.appendMessage(topicId, m as any, [makeBlock(m.id as string) as any])
    }
    const listBeforeSpy = vi.spyOn(MessagesRepository.prototype, 'listBefore')
    const listAfterSpy = vi.spyOn(MessagesRepository.prototype, 'listAfter')
    const predSpy = vi.spyOn(MessagesRepository.prototype, 'findPredecessor')
    const succSpy = vi.spyOn(MessagesRepository.prototype, 'findSuccessor')
    try {
      listByTopicSpy.mockClear()
      const res = agg.fetchMessagesWindow({ kind: 'latest', topicId, limit: 2 })
      expect(listByTopicSpy).not.toHaveBeenCalled()
      const v = okValue(res)
      expect(v.messages.map((m: any) => m.id)).toEqual([ids[1198], ids[1199]])
      expect(v.window.hasMoreBefore).toBe(true)
      expect(v.window.hasMoreAfter).toBe(false)
      // Every chunk scan is capped at the 256-row window chunk.
      for (const call of listBeforeSpy.mock.calls) {
        expect(call[3]).toBeLessThanOrEqual(256)
      }
      // One tail chunk suffices for 2 singleton groups: no predecessor probe needed.
      expect(predSpy).not.toHaveBeenCalled()
      expect(listAfterSpy).not.toHaveBeenCalled()
      expect(succSpy).not.toHaveBeenCalled()

      listByTopicSpy.mockClear()
      listBeforeSpy.mockClear()
      const around = agg.fetchMessagesWindow({
        kind: 'around',
        topicId,
        anchorMessageId: ids[600],
        before: 2,
        after: 2
      })
      expect(listByTopicSpy).not.toHaveBeenCalled()
      const va = okValue(around)
      expect(va.messages.map((m: any) => m.id)).toEqual([ids[598], ids[599], ids[600], ids[601], ids[602]])
      expect(va.window.hasMoreBefore).toBe(true)
      expect(va.window.hasMoreAfter).toBe(true)
      for (const call of [...listBeforeSpy.mock.calls, ...listAfterSpy.mock.calls]) {
        expect(call[3]).toBeLessThanOrEqual(256)
      }
    } finally {
      listBeforeSpy.mockRestore()
      listAfterSpy.mockRestore()
      predSpy.mockRestore()
      succSpy.mockRestore()
    }
  })

  it('around clamps at topic edges with group hasMore flags', () => {
    const topicId = `t-${uid()}`
    const ids = seedGroupedTopic(topicId)
    listByTopicSpy.mockClear()

    const first = agg.fetchMessagesWindow({
      kind: 'around',
      topicId,
      anchorMessageId: ids.u1,
      before: 5,
      after: 1
    })
    expect(listByTopicSpy).not.toHaveBeenCalled()
    const vf = okValue(first)
    expect(vf.messages.map((m: any) => m.id)).toEqual([ids.u1, ids.a1, ids.a2, ids.a3])
    expect(vf.window.hasMoreBefore).toBe(false)
    expect(vf.window.hasMoreAfter).toBe(true)

    listByTopicSpy.mockClear()
    const last = agg.fetchMessagesWindow({
      kind: 'around',
      topicId,
      anchorMessageId: ids.u3,
      before: 1,
      after: 5
    })
    expect(listByTopicSpy).not.toHaveBeenCalled()
    const vl = okValue(last)
    expect(vl.messages.map((m: any) => m.id)).toEqual([ids.b1, ids.b2, ids.u3])
    expect(vl.window.hasMoreBefore).toBe(true)
    expect(vl.window.hasMoreAfter).toBe(false)
  })

  it('same askId non-consecutive forms separate groups on bounded paths', () => {
    const topicId = `t-${uid()}`
    const askX = `askX-${uid()}`
    const a1 = `a1-${uid()}`
    const u1 = `u1-${uid()}`
    const a2 = `a2-${uid()}`
    const a3 = `a3-${uid()}`
    agg.appendMessage(topicId, makeMsg(topicId, a1, 'assistant', askX) as any, [makeBlock(a1) as any])
    agg.appendMessage(topicId, makeMsg(topicId, u1, 'user') as any, [makeBlock(u1) as any])
    agg.appendMessage(topicId, makeMsg(topicId, a2, 'assistant', askX) as any, [makeBlock(a2) as any])
    agg.appendMessage(topicId, makeMsg(topicId, a3, 'assistant', askX) as any, [makeBlock(a3) as any])
    listByTopicSpy.mockClear()

    const res = agg.fetchMessagesWindow({ kind: 'latest', topicId, limit: 2 })
    expect(listByTopicSpy).not.toHaveBeenCalled()
    const v = okValue(res)
    expect(v.messages.map((m: any) => m.id)).toEqual([u1, a2, a3])
    expect(v.window.hasMoreBefore).toBe(true)

    listByTopicSpy.mockClear()
    const around = agg.fetchMessagesWindow({
      kind: 'around',
      topicId,
      anchorMessageId: a2,
      before: 1,
      after: 1
    })
    expect(listByTopicSpy).not.toHaveBeenCalled()
    const va = okValue(around)
    expect(va.messages.map((m: any) => m.id)).toEqual([u1, a2, a3])
    expect(va.window.hasMoreBefore).toBe(true)
    expect(va.window.hasMoreAfter).toBe(false)
  })

  it('assistant without askId stays singleton on bounded latest path', () => {
    const topicId = `t-${uid()}`
    const aNoAsk1 = `aNo1-${uid()}`
    const aNoAsk2 = `aNo2-${uid()}`
    const u1 = `u1-${uid()}`
    agg.appendMessage(topicId, makeMsg(topicId, aNoAsk1, 'assistant', '') as any, [makeBlock(aNoAsk1) as any])
    agg.appendMessage(topicId, makeMsg(topicId, aNoAsk2, 'assistant', '') as any, [makeBlock(aNoAsk2) as any])
    agg.appendMessage(topicId, makeMsg(topicId, u1, 'user') as any, [makeBlock(u1) as any])
    listByTopicSpy.mockClear()

    const res = agg.fetchMessagesWindow({ kind: 'latest', topicId, limit: 2 })
    expect(listByTopicSpy).not.toHaveBeenCalled()
    const v = okValue(res)
    expect(v.messages.map((m: any) => m.id)).toEqual([aNoAsk2, u1])
  })
})
