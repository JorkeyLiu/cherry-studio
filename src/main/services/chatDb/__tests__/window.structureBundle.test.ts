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

import { isSuccess } from '@shared/chatDb'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { runMigrations } from '../migration'
import { MessagesRepository } from '../repository/MessagesRepository'
import { TopicSegmentsRepository } from '../repository/TopicSegmentsRepository'
import * as schema from '../schema'

/**
 * Bundled `fetchMessagesWindow` structure vs HAND-COMPUTED oracles.
 *
 * Every expected value below is a literal derived from the seeded topology
 * plus documented legacy semantics (branch inheritance through the fork
 * anchor only, reference prefix layers, delete cascades + header repair,
 * sortOrder/id route ordering) — never from `listSegments`, which since this
 * task shares the same `listSegmentsInTx`/`buildWindowStructureInTx` helper
 * as the bundle and would make that parity circular (self-parity, not an
 * independent expectation).
 *
 * The second oracle is the window itself: `fetchMessagesWindow` messages are
 * produced by the untouched bounded window path. Whenever the window covers
 * the full route (no hasMore either side), each qualification's
 * `routeMemberMessageIds` must equal the catalog members filtered to the
 * window id set in window order. The catalog is complete topic authority
 * (full `messageIds`, provably beyond any clipped window slice); the route
 * block is the lightweight qualification (no catalog duplication).
 *
 * Not applicable (honest boundary, verified by implementation search):
 * message-level trashed/blocked states do not exist — deletes hard-remove
 * rows (`deleteMany` cascades membership), and trash is a topic-level
 * lifecycle whose reference effect is covered here as the missing-prefix
 * (status 'missing') case. Multi-owner segments cannot exist either:
 * `upsertSegment` rejects members not owned by the addressed route
 * (`assertGroupRangeOwnedInTx`), so cross-owner ordering is proven through
 * the window oracle (route-effective order across owners), with each
 * qualification holding its single owner's members in route order.
 */
function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-win-struct-'))
}
function rmrf(dir: string): void {
  realFs.rmSync(dir, { recursive: true, force: true })
}
function okValue<T>(r: { ok: boolean; value?: T; error?: unknown }): T {
  if (!isSuccess(r as any)) throw new Error(`Expected success: ${JSON.stringify((r as any).error)}`)
  return (r as any).value as T
}
function msgJson(id: string, topicId: string): Record<string, unknown> {
  return {
    id,
    topicId,
    role: 'user',
    content: `c-${id}`,
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}
function blockJson(id: string, messageId: string): Record<string, unknown> {
  return {
    id,
    messageId,
    type: 'main_text',
    content: `blk-${id}`,
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z'
  }
}

interface ExpectedQual {
  segmentId: string
  headerInRoute: boolean
  headerOwnedByRoute: boolean
  routeMemberMessageIds: string[]
}
interface ExpectedCatalog {
  id: string
  messageIds: string[]
  headerMessageId: string | null
}
interface BundleExpectation {
  /** Full-route window ids (legacy oracle); null when the window is clipped. */
  windowIds: string[] | null
  routeTopicId: string
  routeBranchId: string | null
  catalog: ExpectedCatalog[]
  quals: ExpectedQual[]
}

function checkBundle(actual: any, expected: BundleExpectation): void {
  expect(actual.structure).toBeDefined()
  const s = actual.structure
  expect(s.route.topicId).toBe(expected.routeTopicId)
  expect(s.route.branchId).toBe(expected.routeBranchId)
  // Neutral catalog: complete authority, no route blocks.
  expect(s.catalog.map((c: any) => c.id).sort()).toEqual(expected.catalog.map((c) => c.id).sort())
  for (const want of expected.catalog) {
    const got = s.catalog.find((c: any) => c.id === want.id)
    expect(got, `catalog ${want.id}`).toBeDefined()
    expect(got.messageIds).toEqual(want.messageIds)
    expect(got.headerMessageId).toBe(want.headerMessageId)
    expect('route' in got).toBe(false)
  }
  // Qualification covers every catalog group exactly once (catalog order).
  expect(s.route.qualifications.map((q: any) => q.segmentId)).toEqual(expected.catalog.map((c) => c.id))
  for (const want of expected.quals) {
    const got = s.route.qualifications.find((q: any) => q.segmentId === want.segmentId)
    expect(got, `qual ${want.segmentId}`).toBeDefined()
    expect(got.headerInRoute).toBe(want.headerInRoute)
    expect(got.headerOwnedByRoute).toBe(want.headerOwnedByRoute)
    expect(got.routeMemberMessageIds).toEqual(want.routeMemberMessageIds)
  }
  if (expected.windowIds !== null) {
    // Independent window-path oracle: full-route window, same snapshot.
    expect(actual.messages.map((m: any) => m.id)).toEqual(expected.windowIds)
    expect(actual.window.hasMoreBefore).toBe(false)
    expect(actual.window.hasMoreAfter).toBe(false)
    const windowOrder = actual.messages.map((m: any) => m.id)
    for (const want of expected.catalog) {
      const inWindow = want.messageIds.filter((id) => windowOrder.includes(id))
      const inWindowOrder = windowOrder.filter((id: string) => want.messageIds.includes(id))
      expect(inWindow.sort()).toEqual(inWindowOrder.slice().sort())
      const got = s.route.qualifications.find((q: any) => q.segmentId === want.id)
      expect(got.routeMemberMessageIds).toEqual(inWindowOrder)
    }
  }
}

function fullScanSpies() {
  return {
    listByTopic: vi.spyOn(MessagesRepository.prototype, 'listByTopic'),
    listThrough: vi.spyOn(MessagesRepository.prototype, 'listThrough'),
    listAll: vi.spyOn(MessagesRepository.prototype, 'listAllByTopic'),
    segList: vi.spyOn(TopicSegmentsRepository.prototype, 'listByTopic'),
    segMembers: vi.spyOn(TopicSegmentsRepository.prototype, 'getMessageIds')
  }
}
function restoreSpies(spies: Record<string, { mockRestore: () => void }>): void {
  for (const s of Object.values(spies)) s.mockRestore()
}

describe('fetchMessagesWindow bundled structure (hand-computed oracles)', () => {
  let tmpDir: string
  let sqlite: Database.Database
  let db: BetterSQLite3Database<typeof schema>
  let agg: ChatDbAggregateService

  beforeEach(() => {
    tmpDir = makeTempDir()
    sqlite = new Database(realPath.join(tmpDir, 'test.db'))
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    db = drizzle(sqlite, { schema })
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

  function seedMain(topic: string, ids: string[], branchId?: string): void {
    expect(agg.ensureTopic(topic, 'a1', `topic-${topic}`).ok).toBe(true)
    for (const id of ids) {
      const r = agg.appendMessage(
        topic,
        msgJson(id, topic) as never,
        [blockJson(`b-${id}`, id) as never],
        undefined,
        undefined,
        branchId ? ({ branchId } as never) : undefined
      )
      expect(r.ok, `append ${id}`).toBe(true)
    }
  }
  function upsert(segmentId: string, topic: string, messageIds: string[], branchId: string | null): void {
    okValue(agg.upsertSegment({ segmentId, topicId: topic, name: `g-${segmentId}`, messageIds, branchId }))
  }

  it('main route: neutral catalog plus full qualification, same snapshot as the lightweight window', () => {
    seedMain('t1', ['m1', 'm2', 'm3'])
    upsert('sA', 't1', ['m1', 'm2'], null)
    upsert('sB', 't1', ['m3'], null)

    const light = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: 't1', limit: 10 }))
    const spies = fullScanSpies()
    const bundled = okValue(
      agg.fetchMessagesWindow({ kind: 'latest', topicId: 't1', limit: 10, includeStructure: true })
    )
    expect(spies.listByTopic).not.toHaveBeenCalled()
    expect(spies.listThrough).not.toHaveBeenCalled()
    expect(spies.listAll).not.toHaveBeenCalled()
    expect(spies.segList).toHaveBeenCalled()
    restoreSpies(spies)

    // Same-tx snapshot: window identical to the lightweight read.
    expect(bundled.messages.map((m: any) => m.id)).toEqual(light.messages.map((m: any) => m.id))
    expect(bundled.window).toEqual(light.window)
    checkBundle(bundled, {
      windowIds: ['m1', 'm2', 'm3'],
      routeTopicId: 't1',
      routeBranchId: null,
      catalog: [
        { id: 'sA', messageIds: ['m1', 'm2'], headerMessageId: 'm1' },
        { id: 'sB', messageIds: ['m3'], headerMessageId: 'm3' }
      ],
      quals: [
        { segmentId: 'sA', headerInRoute: true, headerOwnedByRoute: true, routeMemberMessageIds: ['m1', 'm2'] },
        { segmentId: 'sB', headerInRoute: true, headerOwnedByRoute: true, routeMemberMessageIds: ['m3'] }
      ]
    })
  })

  it('branch cross-owner slice: inherited header is read-only, each route sees only its owned members', () => {
    seedMain('t2', ['m1', 'm2'])
    upsert('s1', 't2', ['m1', 'm2'], null)
    const branchId = okValue(agg.createBranch('t2', null, 'm1', 'b1')).branch.id
    seedMain('t2', ['mb1'], branchId)
    upsert('sB', 't2', ['mb1'], branchId)

    // Branch route: prefix only through the fork anchor; main suffix excluded.
    const spies = fullScanSpies()
    const onBranch = okValue(
      agg.fetchMessagesWindow({ kind: 'latest', topicId: 't2', branchId, limit: 10, includeStructure: true })
    )
    expect(spies.listByTopic).not.toHaveBeenCalled()
    expect(spies.listThrough).not.toHaveBeenCalled()
    expect(spies.listAll).not.toHaveBeenCalled()
    restoreSpies(spies)
    checkBundle(onBranch, {
      windowIds: ['m1', 'mb1'],
      routeTopicId: 't2',
      routeBranchId: branchId,
      catalog: [
        { id: 's1', messageIds: ['m1', 'm2'], headerMessageId: 'm1' },
        { id: 'sB', messageIds: ['mb1'], headerMessageId: 'mb1' }
      ],
      quals: [
        // Inherited header through the anchor: in the route but read-only.
        { segmentId: 's1', headerInRoute: true, headerOwnedByRoute: false, routeMemberMessageIds: ['m1'] },
        { segmentId: 'sB', headerInRoute: true, headerOwnedByRoute: true, routeMemberMessageIds: ['mb1'] }
      ]
    })

    // Main route: branch suffix excluded; branch-owned header not in route.
    const onMain = okValue(
      agg.fetchMessagesWindow({ kind: 'latest', topicId: 't2', limit: 10, includeStructure: true })
    )
    checkBundle(onMain, {
      windowIds: ['m1', 'm2'],
      routeTopicId: 't2',
      routeBranchId: null,
      catalog: [
        { id: 's1', messageIds: ['m1', 'm2'], headerMessageId: 'm1' },
        { id: 'sB', messageIds: ['mb1'], headerMessageId: 'mb1' }
      ],
      quals: [
        { segmentId: 's1', headerInRoute: true, headerOwnedByRoute: true, routeMemberMessageIds: ['m1', 'm2'] },
        { segmentId: 'sB', headerInRoute: false, headerOwnedByRoute: false, routeMemberMessageIds: [] }
      ]
    })
  })
  it('qualification turnCount matches legacy turn grouping on main and branch routes, absent when all unmapped', () => {
    const appendRole = (topic: string, id: string, role: string, askId?: string, branchId?: string): void => {
      const message: Record<string, unknown> = {
        id,
        topicId: topic,
        role,
        content: `c-${id}`,
        status: 'success',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
      if (askId) message.askId = askId
      const r = agg.appendMessage(
        topic,
        message as never,
        [blockJson(`b-${id}`, id) as never],
        undefined,
        undefined,
        branchId ? ({ branchId } as never) : undefined
      )
      expect(r.ok, `append ${id}`).toBe(true)
    }
    // u1 + answer a1 share one turn, u2 is one turn, askId-less a2 is
    // unmapped, system s1 is one turn, dangling-askId a3 is one turn.
    expect(agg.ensureTopic('t8', 'a1', 'topic-t8').ok).toBe(true)
    appendRole('t8', 'u1', 'user')
    appendRole('t8', 'a1', 'assistant', 'u1')
    appendRole('t8', 'u2', 'user')
    appendRole('t8', 'a2', 'assistant')
    appendRole('t8', 's1', 'system')
    appendRole('t8', 'a3', 'assistant', 'ghost')
    upsert('sTurn', 't8', ['u1', 'a1', 'u2', 'a2', 's1', 'a3'], null)
    upsert('sUnmapped', 't8', ['a2'], null)

    const spies = fullScanSpies()
    const onMain = okValue(
      agg.fetchMessagesWindow({ kind: 'latest', topicId: 't8', limit: 10, includeStructure: true })
    )
    // Bounded reads only: the count comes from the qualified member rows,
    // never a whole-route MessageData materialization.
    expect(spies.listByTopic).not.toHaveBeenCalled()
    expect(spies.listThrough).not.toHaveBeenCalled()
    expect(spies.listAll).not.toHaveBeenCalled()
    restoreSpies(spies)

    const qualOf = (bundle: any, sid: string): any =>
      bundle.structure.route.qualifications.find((q: any) => q.segmentId === sid)
    // Legacy grouping over the reachable members: {u1,a1} {u2} {s1}
    // {ghost} = 4 turns; a2 contributes no key.
    expect(qualOf(onMain, 'sTurn').routeMemberMessageIds).toEqual(['u1', 'a1', 'u2', 'a2', 's1', 'a3'])
    expect(qualOf(onMain, 'sTurn').turnCount).toBe(4)
    // All-unmapped members yield absent — never zero, never a member count.
    expect(qualOf(onMain, 'sUnmapped').routeMemberMessageIds).toEqual(['a2'])
    expect('turnCount' in qualOf(onMain, 'sUnmapped')).toBe(false)

    // Branch route: the main-only suffix drops out, so the turn total follows
    // the reachable intersection (u1 alone = 1 turn).
    const branchId = okValue(agg.createBranch('t8', null, 'u1', 'b1')).branch.id
    appendRole('t8', 'ub1', 'user', undefined, branchId)
    appendRole('t8', 'ab1', 'assistant', 'ub1', branchId)
    upsert('sB', 't8', ['ub1', 'ab1'], branchId)
    const onBranch = okValue(
      agg.fetchMessagesWindow({ kind: 'latest', topicId: 't8', branchId, limit: 10, includeStructure: true })
    )
    expect(qualOf(onBranch, 'sTurn').routeMemberMessageIds).toEqual(['u1'])
    expect(qualOf(onBranch, 'sTurn').turnCount).toBe(1)
    expect(qualOf(onBranch, 'sB').routeMemberMessageIds).toEqual(['ub1', 'ab1'])
    expect(qualOf(onBranch, 'sB').turnCount).toBe(1)
  })

  it('route order follows message order, not catalog order (sortOrder tie breaks by id)', () => {
    seedMain('t3', ['tie-c', 'tie-a', 'tie-b'])
    sqlite.prepare('UPDATE messages SET sort_order = 7 WHERE topic_id = ?').run('t3')
    upsert('sT', 't3', ['tie-c', 'tie-a', 'tie-b'], null)

    const bundled = okValue(
      agg.fetchMessagesWindow({ kind: 'latest', topicId: 't3', limit: 10, includeStructure: true })
    )
    // Catalog keeps membership authority order; qualification is route order.
    checkBundle(bundled, {
      windowIds: ['tie-a', 'tie-b', 'tie-c'],
      routeTopicId: 't3',
      routeBranchId: null,
      catalog: [{ id: 'sT', messageIds: ['tie-c', 'tie-a', 'tie-b'], headerMessageId: 'tie-c' }],
      quals: [
        {
          // The head (tie-c) is itself a main-route member, so it stays in
          // the route — only its position differs from catalog order.
          segmentId: 'sT',
          headerInRoute: true,
          headerOwnedByRoute: true,
          routeMemberMessageIds: ['tie-a', 'tie-b', 'tie-c']
        }
      ]
    })
  })

  it('deleted member leaves the catalog via cascade and repairs the header to the first survivor', () => {
    seedMain('t4', ['m1', 'm2', 'm3'])
    upsert('sA', 't4', ['m1', 'm2'], null)
    upsert('sC', 't4', ['m2', 'm3'], null)
    okValue(agg.deleteMessages('t4', ['m2']))

    const bundled = okValue(
      agg.fetchMessagesWindow({ kind: 'latest', topicId: 't4', limit: 10, includeStructure: true })
    )
    checkBundle(bundled, {
      windowIds: ['m1', 'm3'],
      routeTopicId: 't4',
      routeBranchId: null,
      catalog: [
        { id: 'sA', messageIds: ['m1'], headerMessageId: 'm1' },
        { id: 'sC', messageIds: ['m3'], headerMessageId: 'm3' }
      ],
      quals: [
        { segmentId: 'sA', headerInRoute: true, headerOwnedByRoute: true, routeMemberMessageIds: ['m1'] },
        { segmentId: 'sC', headerInRoute: true, headerOwnedByRoute: true, routeMemberMessageIds: ['m3'] }
      ]
    })
  })

  it('deleted fork anchor: branch read falls back to the predecessor, inherited header stays read-only', () => {
    seedMain('t5', ['m0', 'm1'])
    upsert('s1', 't5', ['m0', 'm1'], null)
    const branchId = okValue(agg.createBranch('t5', null, 'm1', 'b1')).branch.id
    seedMain('t5', ['w'], branchId)
    okValue(agg.deleteMessages('t5', ['m1']))

    const bundled = okValue(
      agg.fetchMessagesWindow({ kind: 'latest', topicId: 't5', branchId, limit: 10, includeStructure: true })
    )
    checkBundle(bundled, {
      windowIds: ['m0', 'w'],
      routeTopicId: 't5',
      routeBranchId: branchId,
      catalog: [{ id: 's1', messageIds: ['m0'], headerMessageId: 'm0' }],
      quals: [{ segmentId: 's1', headerInRoute: true, headerOwnedByRoute: false, routeMemberMessageIds: ['m0'] }]
    })
  })

  it('reference prefix route: qualification covers owned members; missing prefix keeps it faithful', () => {
    expect(agg.ensureTopic('tSrc', 'a1', 'topic-tSrc').ok).toBe(true)
    seedMain('tSrc', ['sa', 'sb'])
    okValue(agg.createReferencedTopic('tSrc', null, 'tTgt', 'sb', 'a1'))
    seedMain('tTgt', ['tm'])
    upsert('sT', 'tTgt', ['tm'], null)

    const spies = fullScanSpies()
    const live = okValue(
      agg.fetchMessagesWindow({ kind: 'latest', topicId: 'tTgt', limit: 10, includeStructure: true })
    )
    expect(spies.listByTopic).not.toHaveBeenCalled()
    expect(spies.listThrough).not.toHaveBeenCalled()
    expect(spies.listAll).not.toHaveBeenCalled()
    restoreSpies(spies)
    expect(live.reference?.status).toBe('available')
    checkBundle(live, {
      windowIds: ['sa', 'sb', 'tm'],
      routeTopicId: 'tTgt',
      routeBranchId: null,
      catalog: [{ id: 'sT', messageIds: ['tm'], headerMessageId: 'tm' }],
      quals: [{ segmentId: 'sT', headerInRoute: true, headerOwnedByRoute: true, routeMemberMessageIds: ['tm'] }]
    })

    // Trashed source: prefix omitted (status missing), target suffix and its
    // qualification survive unchanged.
    okValue(agg.softDeleteTopic('tSrc'))
    const missing = okValue(
      agg.fetchMessagesWindow({ kind: 'latest', topicId: 'tTgt', limit: 10, includeStructure: true })
    )
    expect(missing.reference?.status).toBe('missing')
    checkBundle(missing, {
      windowIds: ['tm'],
      routeTopicId: 'tTgt',
      routeBranchId: null,
      catalog: [{ id: 'sT', messageIds: ['tm'], headerMessageId: 'tm' }],
      quals: [{ segmentId: 'sT', headerInRoute: true, headerOwnedByRoute: true, routeMemberMessageIds: ['tm'] }]
    })
  })

  it('clipped window still carries the complete catalog from the same snapshot', () => {
    seedMain('t6', ['m1', 'm2', 'm3'])
    upsert('sA', 't6', ['m1', 'm2'], null)
    upsert('sB', 't6', ['m3'], null)

    const light = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: 't6', limit: 1 }))
    const bundled = okValue(
      agg.fetchMessagesWindow({ kind: 'latest', topicId: 't6', limit: 1, includeStructure: true })
    )
    // Same snapshot: identical window, but the catalog is NOT the window slice.
    expect(bundled.messages.map((m: any) => m.id)).toEqual(light.messages.map((m: any) => m.id))
    expect(bundled.messages.map((m: any) => m.id)).toEqual(['m3'])
    expect(bundled.window).toEqual(light.window)
    checkBundle(bundled, {
      windowIds: null,
      routeTopicId: 't6',
      routeBranchId: null,
      catalog: [
        { id: 'sA', messageIds: ['m1', 'm2'], headerMessageId: 'm1' },
        { id: 'sB', messageIds: ['m3'], headerMessageId: 'm3' }
      ],
      quals: [
        { segmentId: 'sA', headerInRoute: true, headerOwnedByRoute: true, routeMemberMessageIds: ['m1', 'm2'] },
        { segmentId: 'sB', headerInRoute: true, headerOwnedByRoute: true, routeMemberMessageIds: ['m3'] }
      ]
    })
  })

  it.each([
    ['omitted flag on latest', { kind: 'latest', topicId: 't7', limit: 10 } as const],
    ['explicit false on latest', { kind: 'latest', topicId: 't7', limit: 10, includeStructure: false } as const],
    ['omitted flag on around', { kind: 'around', topicId: 't7', anchorMessageId: 'm2', before: 1, after: 1 } as const]
  ])('lightweight window stays five keys without structure: %s', (_name, req) => {
    seedMain('t7', ['m1', 'm2', 'm3'])
    upsert('sA', 't7', ['m1', 'm2'], null)

    const spies = fullScanSpies()
    const light = okValue(agg.fetchMessagesWindow(req as never)) as unknown as Record<string, unknown>
    expect(spies.listByTopic).not.toHaveBeenCalled()
    expect(spies.listThrough).not.toHaveBeenCalled()
    expect(spies.listAll).not.toHaveBeenCalled()
    expect(spies.segList).not.toHaveBeenCalled()
    expect(spies.segMembers).not.toHaveBeenCalled()
    restoreSpies(spies)

    expect('structure' in light).toBe(false)
    expect(Object.keys(light).sort()).toEqual(['blocks', 'messages', 'mutableMessageIds', 'reference', 'window'])
  })

  it('empty catalog is known-empty: structure present, zero qualifications, no message scan', () => {
    expect(agg.ensureTopic('tEmpty', 'a1', 'empty').ok).toBe(true)
    const spies = fullScanSpies()
    const empty = okValue(
      agg.fetchMessagesWindow({ kind: 'latest', topicId: 'tEmpty', limit: 5, includeStructure: true })
    )
    expect(spies.listByTopic).not.toHaveBeenCalled()
    expect(spies.listThrough).not.toHaveBeenCalled()
    expect(spies.listAll).not.toHaveBeenCalled()
    restoreSpies(spies)
    expect(empty.structure).toEqual({ catalog: [], route: { topicId: 'tEmpty', branchId: null, qualifications: [] } })
  })
})
