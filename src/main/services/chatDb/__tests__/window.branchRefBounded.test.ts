/**
 * Branch/reference window boundedness: effective route as ordered owner
 * segments, window reads via bounded per-owner seeks.
 *
 * Every case asserts literal expected windows (hand-written oracle, never
 * new-vs-new) plus boundedness: `listByTopic` / `listThrough` /
 * `listAllByTopic` are never called by a branch/reference `fetchWindow`
 * (caller-local whole reads may still use them), and the total rows
 * hydrated through bounded chunk methods stays far below an unrelated huge
 * owner. No timing thresholds.
 */
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
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-win-seg-'))
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
  return `ws${++counter}-${Date.now()}`
}
function okValue<T>(r: { ok: boolean; value?: T; error?: unknown }): T {
  if (!isSuccess(r as any)) throw new Error(`Expected success: ${JSON.stringify((r as any).error)}`)
  return (r as any).value as T
}

/** Fast huge owner seeding via raw SQL (dense per-owner sort_order, no blocks). */
function seedHugeOwner(
  sqlite: Database.Database,
  topicId: string,
  branchId: string | null,
  prefix: string,
  n: number
): string[] {
  const ids: string[] = []
  const stmt = sqlite.prepare(
    `INSERT INTO messages (id, topic_id, branch_id, role, content, status, ask_id, created_at, updated_at, sort_order) VALUES (?, ?, ?, 'user', ?, 'success', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)`
  )
  const tx = sqlite.transaction(() => {
    for (let i = 0; i < n; i++) {
      const id = `${prefix}-${i}`
      ids.push(id)
      stmt.run(id, topicId, branchId, `content-${id}`, i)
    }
  })
  tx()
  return ids
}

function appendUser(agg: ChatDbAggregateService, topicId: string, id: string, branchId?: string): void {
  const res = agg.appendMessage(
    topicId,
    { id, topicId, role: 'user', content: `c-${id}`, status: 'success', createdAt: '2026-01-01T00:00:00.000Z' } as any,
    [
      {
        id: `b-${id}`,
        messageId: id,
        type: 'main_text',
        content: `blk-${id}`,
        status: 'success',
        createdAt: '2026-01-01T00:00:00.000Z'
      } as any
    ],
    undefined,
    undefined,
    branchId ? ({ branchId } as any) : undefined
  )
  expect(res.ok, `append ${id}`).toBe(true)
}

function appendAssistant(
  agg: ChatDbAggregateService,
  topicId: string,
  id: string,
  askId: string,
  branchId?: string
): void {
  const res = agg.appendMessage(
    topicId,
    {
      id,
      topicId,
      role: 'assistant',
      askId,
      content: `c-${id}`,
      status: 'success',
      createdAt: '2026-01-01T00:00:00.000Z'
    } as any,
    [
      {
        id: `b-${id}`,
        messageId: id,
        type: 'main_text',
        content: `blk-${id}`,
        status: 'success',
        createdAt: '2026-01-01T00:00:00.000Z'
      } as any
    ],
    undefined,
    undefined,
    branchId ? ({ branchId } as any) : undefined
  )
  expect(res.ok, `append ${id}`).toBe(true)
}

describe('ChatDbAggregateService — branch/reference segment-bounded windows', () => {
  let tmpDir: string
  let sqlite: Database.Database
  let db: BetterSQLite3Database<typeof schema>
  let agg: ChatDbAggregateService
  let listByTopicSpy: MockInstance
  let listThroughSpy: MockInstance
  let listAllSpy: MockInstance
  let hydratedRows = 0
  const chunkSpies: MockInstance[] = []

  function trackChunkRows(rows: unknown): void {
    if (Array.isArray(rows)) hydratedRows += rows.length
  }

  beforeEach(() => {
    tmpDir = makeTempDir()
    sqlite = openTestDb(realPath.join(tmpDir, 'test.db'))
    db = wrapDrizzle(sqlite)
    runMigrations(db, sqlite)
    agg = new ChatDbAggregateService(db, sqlite)
    mockCleanTopic.mockReset().mockResolvedValue(undefined)
    hydratedRows = 0
    chunkSpies.length = 0
    listByTopicSpy = vi.spyOn(MessagesRepository.prototype, 'listByTopic')
    listThroughSpy = vi.spyOn(MessagesRepository.prototype, 'listThrough')
    listAllSpy = vi.spyOn(MessagesRepository.prototype, 'listAllByTopic')
    // Count rows hydrated through bounded chunk reads (proves huge unrelated
    // owners are never materialized wholesale). Originals are captured
    // before spying so the wrappers never recurse into themselves.
    const originals = {
      listBefore: MessagesRepository.prototype.listBefore,
      listAfter: MessagesRepository.prototype.listAfter,
      getLatestByTopic: MessagesRepository.prototype.getLatestByTopic,
      listFirst: MessagesRepository.prototype.listFirst
    } as const
    for (const key of ['listBefore', 'listAfter', 'getLatestByTopic', 'listFirst'] as const) {
      const orig = originals[key] as (...a: any[]) => any
      const spy = vi.spyOn(MessagesRepository.prototype, key as any) as unknown as MockInstance
      spy.mockImplementation(function (this: unknown, ...args: any[]) {
        const out = orig.apply(this, args)
        trackChunkRows(out)
        return out
      } as any)
      chunkSpies.push(spy)
    }
  })
  afterEach(() => {
    listByTopicSpy.mockRestore()
    listThroughSpy.mockRestore()
    listAllSpy.mockRestore()
    for (const s of chunkSpies) s.mockRestore()
    try {
      sqlite.close()
    } catch {}
    rmrf(tmpDir)
  })

  function resetSpies(): void {
    listByTopicSpy.mockClear()
    listThroughSpy.mockClear()
    listAllSpy.mockClear()
    hydratedRows = 0
  }

  function expectBounded(): void {
    expect(listByTopicSpy).not.toHaveBeenCalled()
    expect(listThroughSpy).not.toHaveBeenCalled()
    expect(listAllSpy).not.toHaveBeenCalled()
  }

  it('branch latest: huge main prefix stays unmaterialized, tail suffix window exact', () => {
    const topic = `t-${uid()}`
    expect(agg.ensureTopic(topic, 'a1', `topic-${topic}`).ok).toBe(true)
    const huge = seedHugeOwner(sqlite, topic, null, `h-${uid()}`, 1500)
    const s1 = `s1-${uid()}`
    const s2 = `s2-${uid()}`
    appendUser(agg, topic, s1)
    appendUser(agg, topic, s2)
    const branchId = okValue(agg.createBranch(topic, null, s1, 'b1')).branch.id
    const w1 = `w1-${uid()}`
    const w2 = `w2-${uid()}`
    appendUser(agg, topic, w1, branchId)
    appendUser(agg, topic, w2, branchId)
    resetSpies()

    const res = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: topic, branchId, limit: 1 }))
    expectBounded()
    // Latest 1 group on the branch route: tail singleton [w2]; everything
    // before (1500 huge + s1..w1) is hasMore.
    expect(res.messages.map((m: any) => m.id)).toEqual([w2])
    expect(res.window.hasMoreBefore).toBe(true)
    expect(res.window.hasMoreAfter).toBe(false)
    expect(hydratedRows).toBeLessThan(900)
    expect(huge.length).toBe(1500)
  })

  it('branch around: cross-boundary same-askId group returns whole across main->branch', () => {
    const topic = `t-${uid()}`
    expect(agg.ensureTopic(topic, 'a1', `topic-${topic}`).ok).toBe(true)
    const askX = `askX-${uid()}`
    const u0 = `u0-${uid()}`
    const a1 = `a1-${uid()}`
    const a2 = `a2-${uid()}`
    appendUser(agg, topic, u0)
    appendAssistant(agg, topic, a1, askX)
    const branchId = okValue(agg.createBranch(topic, null, a1, 'b1')).branch.id
    // Same askId continues on the branch suffix: one semantic group spans
    // the fork (main a1 + branch a2,a3, consecutive on the branch route).
    const a3 = `a3-${uid()}`
    appendAssistant(agg, topic, a2, askX, branchId)
    appendAssistant(agg, topic, a3, askX, branchId)
    const tail = `tail-${uid()}`
    appendUser(agg, topic, tail, branchId)
    resetSpies()

    const res = okValue(
      agg.fetchMessagesWindow({ kind: 'around', topicId: topic, branchId, anchorMessageId: a3, before: 1, after: 1 })
    )
    expectBounded()
    // Anchor group [a1,a2,a3] spans main->branch and must return whole, plus
    // 1 group each side: [u0] before, [tail] after.
    expect(res.messages.map((m: any) => m.id)).toEqual([u0, a1, a2, a3, tail])
    expect(res.window.hasMoreBefore).toBe(false)
    expect(res.window.hasMoreAfter).toBe(false)
    // Mutable: every window row is owned by the addressed branch route except
    // the inherited main prefix.
    expect(new Set(res.mutableMessageIds)).toEqual(new Set([a2, a3, tail]))
  })

  it('reference latest: huge source history stays unmaterialized', () => {
    const source = `src-${uid()}`
    const target = `tgt-${uid()}`
    expect(agg.ensureTopic(source, 'a1', `topic-${source}`).ok).toBe(true)
    const huge = seedHugeOwner(sqlite, source, null, `sh-${uid()}`, 1500)
    const anchor = huge[100]
    okValue(agg.createReferencedTopic(source, null, target, anchor, 'a1'))
    const t1 = `t1-${uid()}`
    const t2 = `t2-${uid()}`
    appendUser(agg, target, t1)
    appendUser(agg, target, t2)
    resetSpies()

    const res = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: target, limit: 1 }))
    expectBounded()
    expect(res.messages.map((m: any) => m.id)).toEqual([t2])
    expect(res.window.hasMoreBefore).toBe(true)
    expect(res.reference?.status).toBe('available')
    expect(res.reference?.boundaryMessageId).toBe(anchor)
    expect(hydratedRows).toBeLessThan(900)
  })

  it('reference chain layers stay faithful without full reads', () => {
    const s1 = `s1-${uid()}`
    const s2 = `s2-${uid()}`
    const s3 = `s3-${uid()}`
    expect(agg.ensureTopic(s1, 'a1', `t-${s1}`).ok).toBe(true)
    const a = `a-${uid()}`
    const b = `b-${uid()}`
    appendUser(agg, s1, a)
    appendUser(agg, s1, b)
    okValue(agg.createReferencedTopic(s1, null, s2, b, 'a1'))
    const c = `c-${uid()}`
    appendUser(agg, s2, c)
    okValue(agg.createReferencedTopic(s2, null, s3, c, 'a1'))
    const d = `d-${uid()}`
    appendUser(agg, s3, d)
    resetSpies()

    const res = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: s3, limit: 10 }))
    expectBounded()
    // Effective route: [a,b](s1) + [c](s2 own) + [d](s3 own).
    expect(res.messages.map((m: any) => m.id)).toEqual([a, b, c, d])
    expect(res.reference?.status).toBe('available')
    const layers = (res.reference as any)?.layers as Array<{ boundaryMessageId: string }>
    expect(layers?.length).toBe(2)
    expect(layers[0].boundaryMessageId).toBe(c)
    expect(layers[1].boundaryMessageId).toBe(b)
  })

  it('huge single askId group across branch boundary returns whole via bounded chunks', () => {
    const topic = `t-${uid()}`
    expect(agg.ensureTopic(topic, 'a1', `topic-${topic}`).ok).toBe(true)
    const askBig = `askBig-${uid()}`
    const head = `head-${uid()}`
    appendUser(agg, topic, head)
    const first = `first-${uid()}`
    appendAssistant(agg, topic, first, askBig)
    const branchId = okValue(agg.createBranch(topic, null, first, 'b1')).branch.id
    // 600 same-askId rows on the branch suffix: one pathological group.
    const runIds: string[] = []
    const stmt = sqlite.prepare(
      `INSERT INTO messages (id, topic_id, branch_id, role, content, status, ask_id, created_at, updated_at, sort_order) VALUES (?, ?, ?, 'assistant', ?, 'success', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)`
    )
    const tx = sqlite.transaction(() => {
      for (let i = 0; i < 600; i++) {
        const id = `run-${uid()}-${i}`
        runIds.push(id)
        stmt.run(id, topic, branchId, `c-${id}`, askBig, i + 1)
      }
    })
    tx()
    const tail = `tail-${uid()}`
    appendUser(agg, topic, tail, branchId)
    resetSpies()

    const res = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: topic, branchId, limit: 1 }))
    expectBounded()
    // Latest 1 group is tail singleton.
    expect(res.messages.map((m: any) => m.id)).toEqual([tail])
    expect(res.window.hasMoreBefore).toBe(true)
    resetSpies()
    const res2 = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: topic, branchId, limit: 2 }))
    expectBounded()
    // Latest 2 groups: whole 601-run (first + 600) plus tail, never partial.
    expect(res2.messages.map((m: any) => m.id)).toEqual([first, ...runIds, tail])
    expect(res2.window.hasMoreBefore).toBe(true)
    expect(hydratedRows).toBeLessThan(1400)
  })

  it('anchor outside the addressed route fails NOT_FOUND without fallback', () => {
    const topic = `t-${uid()}`
    expect(agg.ensureTopic(topic, 'a1', `topic-${topic}`).ok).toBe(true)
    const m0 = `m0-${uid()}`
    const m1 = `m1-${uid()}`
    const m2 = `m2-${uid()}`
    appendUser(agg, topic, m0)
    appendUser(agg, topic, m1)
    appendUser(agg, topic, m2)
    const branchId = okValue(agg.createBranch(topic, null, m1, 'b1')).branch.id
    const owned = `owned-${uid()}`
    appendUser(agg, topic, owned, branchId)
    resetSpies()
    // Branch-owned suffix id on main: NOT_FOUND.
    const onMain = agg.fetchMessagesWindow({
      kind: 'around',
      topicId: topic,
      anchorMessageId: owned,
      before: 1,
      after: 1
    })
    expect(onMain.ok).toBe(false)
    if (!onMain.ok) expect(onMain.error.code).toBe(ERR_NOT_FOUND)
    // Main-exclusive post-fork id on the branch: NOT_FOUND.
    const onBranch = agg.fetchMessagesWindow({
      kind: 'around',
      topicId: topic,
      branchId,
      anchorMessageId: m2,
      before: 1,
      after: 1
    })
    expect(onBranch.ok).toBe(false)
    if (!onBranch.ok) expect(onBranch.error.code).toBe(ERR_NOT_FOUND)
    expectBounded()
  })

  it('deleted fork anchor advances: child window still resolves through predecessor', () => {
    const topic = `t-${uid()}`
    expect(agg.ensureTopic(topic, 'a1', `topic-${topic}`).ok).toBe(true)
    const m0 = `m0-${uid()}`
    const m1 = `m1-${uid()}`
    appendUser(agg, topic, m0)
    appendUser(agg, topic, m1)
    const branchId = okValue(agg.createBranch(topic, null, m1, 'b1')).branch.id
    const w = `w-${uid()}`
    appendUser(agg, topic, w, branchId)
    okValue(agg.deleteMessages(topic, [m1]))
    resetSpies()
    const res = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: topic, branchId, limit: 10 }))
    expectBounded()
    // Inherited prefix falls back to m0; owned suffix survives.
    expect(res.messages.map((m: any) => m.id)).toEqual([m0, w])
  })

  it('equal sortOrder ties compare by id inside one segment only', () => {
    const topic = `t-${uid()}`
    expect(agg.ensureTopic(topic, 'a1', `topic-${topic}`).ok).toBe(true)
    appendUser(agg, topic, 'tie-c')
    appendUser(agg, topic, 'tie-a')
    appendUser(agg, topic, 'tie-b')
    sqlite.prepare('UPDATE messages SET sort_order = 7 WHERE topic_id = ?').run(topic)
    const branchId = okValue(agg.createBranch(topic, null, 'tie-a', 'b1')).branch.id
    const w = `w-${uid()}`
    appendUser(agg, topic, w, branchId)
    resetSpies()
    const res = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: topic, branchId, limit: 10 }))
    expectBounded()
    // Deterministic id order within the tied main segment: the branch is
    // anchored at tie-a, so it inherits only through tie-a plus its suffix.
    expect(res.messages.map((m: any) => m.id)).toEqual(['tie-a', w])
  })

  it('empty branch suffix latest returns inherited prefix tail bounded', () => {
    const topic = `t-${uid()}`
    expect(agg.ensureTopic(topic, 'a1', `topic-${topic}`).ok).toBe(true)
    const m0 = `m0-${uid()}`
    const m1 = `m1-${uid()}`
    appendUser(agg, topic, m0)
    appendUser(agg, topic, m1)
    const branchId = okValue(agg.createBranch(topic, null, m1, 'b1')).branch.id
    resetSpies()
    const res = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: topic, branchId, limit: 1 }))
    expectBounded()
    expect(res.messages.map((m: any) => m.id)).toEqual([m1])
    expect(res.window.hasMoreBefore).toBe(true)
  })

  it('mixed reference+branch route spans three segments with exact hasMore', () => {
    const source = `src-${uid()}`
    const target = `tgt-${uid()}`
    expect(agg.ensureTopic(source, 'a1', `t-${source}`).ok).toBe(true)
    const sa = `sa-${uid()}`
    const sb = `sb-${uid()}`
    appendUser(agg, source, sa)
    appendUser(agg, source, sb)
    okValue(agg.createReferencedTopic(source, null, target, sb, 'a1'))
    const tm = `tm-${uid()}`
    appendUser(agg, target, tm)
    const branchId = okValue(agg.createBranch(target, null, tm, 'b1')).branch.id
    const w1 = `w1-${uid()}`
    const w2 = `w2-${uid()}`
    appendUser(agg, target, w1, branchId)
    appendUser(agg, target, w2, branchId)
    resetSpies()
    // Effective: [sa,sb](source) + [tm](target main) + [w1,w2](branch).
    const around = okValue(
      agg.fetchMessagesWindow({ kind: 'around', topicId: target, branchId, anchorMessageId: tm, before: 1, after: 1 })
    )
    expectBounded()
    expect(around.messages.map((m: any) => m.id)).toEqual([sb, tm, w1])
    expect(around.window.hasMoreBefore).toBe(true)
    expect(around.window.hasMoreAfter).toBe(true)
    // Mutable: only the branch-owned row is mutable through the branch
    // route (sb is a foreign prefix, tm is target-main-owned).
    expect(new Set(around.mutableMessageIds)).toEqual(new Set([w1]))
    resetSpies()
    const latest = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: target, branchId, limit: 1 }))
    expectBounded()
    expect(latest.messages.map((m: any) => m.id)).toEqual([w2])
    expect(latest.window.hasMoreBefore).toBe(true)
  })
})
