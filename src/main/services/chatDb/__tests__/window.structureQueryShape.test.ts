/**
 * Set-based structure reads.
 *
 * The bundled window structure resolves its whole catalog from ONE membership
 * query plus bind-chunked row-projection queries — never one message row
 * lookup per member and never one membership query per group. Two kinds of
 * evidence, both on the real repositories against a real migrated SQLite
 * database:
 *
 * 1. Query shape, derived from the actual relation (group count / member
 *    count / bind chunks), never from a hard-coded whole-window total: one
 *    membership statement regardless of group count, projection statements
 *    only at bind-chunk boundaries, and zero message point lookups.
 * 2. Output equivalence against hand-written expectations for the cases a
 *    naive "filter the bulk read by topic" shortcut would silently break:
 *    a route upper bound read through the same projection, and a legacy
 *    cross-topic member carried as a group's persisted head (its foreign owner
 *    must survive).
 */
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
import type { ChatDbRepositories } from '../repository/factory'
import { createRepositories } from '../repository/factory'
import { MESSAGE_STRUCTURE_ID_CHUNK } from '../repository/MessagesRepository'
import { MessagesRepository } from '../repository/MessagesRepository'
import { TopicSegmentsRepository } from '../repository/TopicSegmentsRepository'
import * as schema from '../schema'

type RouteSegment = { topicId: string; branchId: string | null; upperMessageId: string | null }

interface PreparedStatementShape {
  /** Every SQL statement prepared while running the measured call. */
  all: string[]
  /** Statements reading `topic_segment_messages` (group membership reads). */
  membership: string[]
  /** Statements reading `messages` with an explicit `id IN (...)` bind list. */
  idSetReads: string[]
  /** Statements reading one `messages` row by `id = ?`. */
  pointLookups: string[]
}

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-win-struct-shape-'))
}
function rmrf(dir: string): void {
  realFs.rmSync(dir, { recursive: true, force: true })
}
function okValue<T>(r: { ok: boolean; value?: T; error?: unknown }): T {
  if (!isSuccess(r as any)) throw new Error(`Expected success: ${JSON.stringify((r as any).error)}`)
  return (r as any).value as T
}
function msgJson(id: string, topicId: string, role = 'user'): Record<string, unknown> {
  return {
    id,
    topicId,
    role,
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

describe('window structure set-based reads (real repositories, real transaction)', () => {
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

  function ensureTopic(topic: string): void {
    expect(agg.ensureTopic(topic, 'a1', `topic-${topic}`).ok).toBe(true)
  }
  function append(topic: string, id: string, role = 'user'): void {
    const r = agg.appendMessage(topic, msgJson(id, topic, role) as never, [blockJson(`b-${id}`, id) as never])
    expect(r.ok, `append ${id}`).toBe(true)
  }
  function upsert(segmentId: string, topic: string, messageIds: string[], branchId: string | null): void {
    okValue(agg.upsertSegment({ segmentId, topicId: topic, name: `g-${segmentId}`, messageIds, branchId }))
  }
  /** Insert message rows straight into the table: bulk fixtures skip the write path. */
  function insertRows(topic: string, ids: string[]): void {
    const stmt = sqlite.prepare(
      'INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)'
    )
    ids.forEach((id, index) => {
      stmt.run(id, topic, 'user', `c-${id}`, 'success', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', index)
    })
  }

  /**
   * Statement inventory for one measured call, captured at the SQLite client
   * (every repository read goes through it). Passthrough: the real statements
   * still execute, so this observes the exact query shape the build issues.
   */
  function statementShape(run: () => void): PreparedStatementShape {
    const all: string[] = []
    const proto = Database.prototype as unknown as {
      prepare: (this: Database.Database, sql: string, ...rest: unknown[]) => unknown
    }
    const original = proto.prepare
    proto.prepare = function (this: Database.Database, sql: string, ...rest: unknown[]): unknown {
      all.push(sql)
      return original.apply(this, [sql, ...rest])
    }
    try {
      run()
    } finally {
      proto.prepare = original
    }
    const messagesStatements = all.filter((sql) => sql.includes('from "messages"'))
    return {
      all,
      membership: all.filter((sql) => sql.includes('from "topic_segment_messages"')),
      idSetReads: messagesStatements.filter((sql) => sql.includes('"messages"."id" in (')),
      pointLookups: messagesStatements.filter((sql) => sql.includes('"messages"."id" = '))
    }
  }

  /** The structure builder itself: caller-supplied canonical route segments. */
  function buildStructure(topicId: string, route: string | null, routeSegments: RouteSegment[]): any {
    const builder = (
      agg as unknown as {
        buildWindowStructureInTx: (
          repos: ChatDbRepositories,
          topicId: string,
          route: string | null,
          routeSegments: RouteSegment[]
        ) => any
      }
    ).buildWindowStructureInTx.bind(agg)
    return builder(createRepositories(db), topicId, route, routeSegments)
  }
  function mainRoute(topicId: string): RouteSegment[] {
    return [{ topicId, branchId: null, upperMessageId: null }]
  }
  /** Projection statements the build legitimately needs for this relation. */
  function expectedProjectionStatements(topicId: string, routeSegments: RouteSegment[]): number {
    const repos = createRepositories(db)
    const segments = repos.segments.listByTopic(topicId)
    const members = repos.segments.listMembersByTopic(topicId)
    const ids = new Set<string>()
    for (const segment of segments) {
      for (const id of members.get(segment.id) ?? []) ids.add(id)
    }
    for (const seg of routeSegments) if (seg.upperMessageId !== null) ids.add(seg.upperMessageId)
    return ids.size === 0 ? 0 : Math.ceil(ids.size / MESSAGE_STRUCTURE_ID_CHUNK)
  }

  it('one membership statement plus chunked projection statements, zero message point lookups', () => {
    ensureTopic('q1')
    for (let g = 0; g < 6; g++) {
      append('q1', `a${g}`)
      append('q1', `b${g}`)
    }
    for (let g = 0; g < 6; g++) upsert(`s${g}`, 'q1', [`a${g}`, `b${g}`], null)

    const routeSegments = mainRoute('q1')
    const chunks = expectedProjectionStatements('q1', routeSegments)
    const shape = statementShape(() => buildStructure('q1', null, routeSegments))

    // 6 groups -> still exactly one membership read for the whole catalog.
    expect(shape.membership).toHaveLength(1)
    expect(shape.idSetReads).toHaveLength(chunks)
    expect(shape.pointLookups).toHaveLength(0)
    // Whole build: catalog + membership + projection chunks, nothing else.
    expect(shape.all).toHaveLength(2 + chunks)

    // Values: complete catalog in authoritative membership order.
    const structure = buildStructure('q1', null, routeSegments)
    expect(structure.catalog.map((c: any) => c.id)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5'])
    for (let g = 0; g < 6; g++) {
      const wire = structure.catalog.find((c: any) => c.id === `s${g}`)
      expect(wire.messageIds).toEqual([`a${g}`, `b${g}`])
      expect(wire.headerMessageId).toBe(`a${g}`)
      expect(wire.ownerTopicId).toBe('q1')
      expect(wire.ownerBranchId).toBe(null)
      expect('route' in wire).toBe(false)
      const qual = structure.route.qualifications.find((q: any) => q.segmentId === `s${g}`)
      expect(qual.routeMemberMessageIds).toEqual([`a${g}`, `b${g}`])
      expect(qual.headerInRoute).toBe(true)
      expect(qual.headerOwnedByRoute).toBe(true)
      // both members are users: two turn keys, no cross-key merge
      expect(qual.turnCount).toBe(2)
    }
    expect(structure.route).toMatchObject({ topicId: 'q1', branchId: null })
    expect(structure.route.qualifications.map((q: any) => q.segmentId)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5'])
  })

  it('statement count follows the relation, not the group or member count below one bind chunk', () => {
    // 2 groups / 4 members
    ensureTopic('q2a')
    for (let i = 0; i < 2; i++) {
      append('q2a', `a${i}`)
      append('q2a', `b${i}`)
    }
    for (let i = 0; i < 2; i++) upsert(`sa${i}`, 'q2a', [`a${i}`, `b${i}`], null)

    // 8 groups / 8 members — 4x the groups, 2x the members
    ensureTopic('q2b')
    for (let i = 0; i < 8; i++) append('q2b', `m${i}`)
    for (let i = 0; i < 8; i++) upsert(`sb${i}`, 'q2b', [`m${i}`], null)

    const small = statementShape(() => buildStructure('q2a', null, mainRoute('q2a')))
    const grouped = statementShape(() => buildStructure('q2b', null, mainRoute('q2b')))

    expect(small.membership).toHaveLength(1)
    expect(grouped.membership).toHaveLength(1)
    expect(small.pointLookups).toHaveLength(0)
    expect(grouped.pointLookups).toHaveLength(0)
    // Both fit in one bind chunk: identical statement inventory.
    expect(small.idSetReads).toHaveLength(1)
    expect(grouped.idSetReads).toHaveLength(1)
    expect(grouped.all).toHaveLength(small.all.length)
  })

  it('members beyond one bind chunk add projection statements only; values unchanged', () => {
    ensureTopic('q3')
    const ids = Array.from({ length: MESSAGE_STRUCTURE_ID_CHUNK + 44 }, (_, i) => `m${String(i).padStart(3, '0')}`)
    insertRows('q3', ids)
    upsert('sBig', 'q3', ids, null)

    const routeSegments = mainRoute('q3')
    const chunks = expectedProjectionStatements('q3', routeSegments)
    expect(chunks).toBe(2)

    const shape = statementShape(() => buildStructure('q3', null, routeSegments))
    expect(shape.membership).toHaveLength(1)
    expect(shape.idSetReads).toHaveLength(chunks)
    expect(shape.pointLookups).toHaveLength(0)
    expect(shape.all).toHaveLength(2 + chunks)

    const structure = buildStructure('q3', null, routeSegments)
    const wire = structure.catalog.find((c: any) => c.id === 'sBig')
    expect(wire.messageIds).toEqual(ids)
    expect(wire.headerMessageId).toBe(ids[0])
    expect(wire.messageCount).toBe(ids.length)
    const qual = structure.route.qualifications.find((q: any) => q.segmentId === 'sBig')
    expect(qual.routeMemberMessageIds).toEqual(ids)
    expect(qual.turnCount).toBe(ids.length)
  })

  it('route upper bound comes from the same projection read, clipping the group in route order', () => {
    ensureTopic('q4')
    append('q4', 'm1')
    append('q4', 'm2')
    append('q4', 'm3')
    upsert('s1', 'q4', ['m1', 'm2', 'm3'], null)
    const branchId = okValue(agg.createBranch('q4', null, 'm2', 'b1')).branch.id

    // Canonical route for the branch: main prefix through the anchor, then the
    // branch owner segment — exactly what resolveRouteSegmentsInTx yields.
    const routeSegments: RouteSegment[] = [
      { topicId: 'q4', branchId: null, upperMessageId: 'm2' },
      { topicId: 'q4', branchId, upperMessageId: null }
    ]
    const chunks = expectedProjectionStatements('q4', routeSegments)
    const shape = statementShape(() => buildStructure('q4', branchId, routeSegments))

    // The upper bound row is part of the projection bind list: no point lookup.
    expect(shape.membership).toHaveLength(1)
    expect(shape.idSetReads).toHaveLength(chunks)
    expect(shape.pointLookups).toHaveLength(0)

    const structure = buildStructure('q4', branchId, routeSegments)
    const wire = structure.catalog.find((c: any) => c.id === 's1')
    // The catalog stays complete topic authority: m3 is still a member.
    expect(wire.messageIds).toEqual(['m1', 'm2', 'm3'])
    expect(wire.headerMessageId).toBe('m1')
    const qual = structure.route.qualifications.find((q: any) => q.segmentId === 's1')
    // Route qualification clips at the anchor tuple (m3 is past the upper bound).
    expect(qual.routeMemberMessageIds).toEqual(['m1', 'm2'])
    expect(qual.headerInRoute).toBe(true)
    // The head is main-owned; this route is the branch.
    expect(qual.headerOwnedByRoute).toBe(false)
    expect(qual.turnCount).toBe(2)
  })

  it('legacy cross-topic member carried as the persisted head keeps its foreign owner', () => {
    ensureTopic('qRef')
    append('qRef', 'rm')
    ensureTopic('qSrc')
    append('qSrc', 'sm')
    upsert('sF', 'qRef', ['rm'], null)
    // Legacy/import state the aggregate write path would reject: a member row
    // owned by another topic, persisted as this group's head.
    sqlite
      .prepare('INSERT INTO topic_segment_messages (segment_id, message_id, sort_order) VALUES (?,?,?)')
      .run('sF', 'sm', 1)
    sqlite.prepare('UPDATE topic_segments SET header_message_id = ? WHERE id = ?').run('sm', 'sF')

    const bundled: any = okValue(
      agg.fetchMessagesWindow({ kind: 'latest', topicId: 'qRef', limit: 10, includeStructure: true })
    )
    const wire = bundled.structure.catalog.find((c: any) => c.id === 'sF')
    // Membership is complete topic authority (both rows), and the head row's
    // own topic survives the id-keyed projection: a topic filtered bulk read
    // would have dropped it and downgraded the head to "no resolvable head".
    expect(wire.messageIds).toEqual(['rm', 'sm'])
    expect(wire.headerMessageId).toBe('sm')
    expect(wire.ownerTopicId).toBe('qSrc')
    expect(wire.ownerBranchId).toBe(null)
    const qual = bundled.structure.route.qualifications.find((q: any) => q.segmentId === 'sF')
    // Foreign owners are not on this route: only the addressed owner's member.
    expect(qual.routeMemberMessageIds).toEqual(['rm'])
    expect(qual.headerInRoute).toBe(false)
    expect(qual.headerOwnedByRoute).toBe(false)
    expect(qual.turnCount).toBe(1)
  })

  it('bundled structure adds no message point lookups and no per-group membership query over the lightweight window', () => {
    ensureTopic('q6')
    for (const id of ['m1', 'm2', 'm3', 'm4']) append('q6', id)
    upsert('sA', 'q6', ['m1', 'm2'], null)
    upsert('sB', 'q6', ['m3'], null)
    upsert('sC', 'q6', ['m4'], null)

    const getByIdSpy = vi.spyOn(MessagesRepository.prototype, 'getById')
    const membersSpy = vi.spyOn(TopicSegmentsRepository.prototype, 'getMessageIds')
    const bulkMembersSpy = vi.spyOn(TopicSegmentsRepository.prototype, 'listMembersByTopic')
    try {
      okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: 'q6', limit: 10 }))
      const lightLookups = getByIdSpy.mock.calls.length
      const lightMembers = membersSpy.mock.calls.length
      const lightBulkMembers = bulkMembersSpy.mock.calls.length

      okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: 'q6', limit: 10, includeStructure: true }))
      const structuredLookups = getByIdSpy.mock.calls.length - lightLookups
      const structuredMembers = membersSpy.mock.calls.length - lightMembers
      const structuredBulkMembers = bulkMembersSpy.mock.calls.length - lightBulkMembers

      // The lightweight window reads no catalog/membership and no rows here.
      expect(lightBulkMembers).toBe(0)
      // Structure adds zero message point lookups and zero per-group reads.
      expect(structuredLookups).toBe(0)
      expect(structuredMembers).toBe(0)
      // One membership read for the whole catalog (three groups).
      expect(structuredBulkMembers).toBe(1)
    } finally {
      getByIdSpy.mockRestore()
      membersSpy.mockRestore()
      bulkMembersSpy.mockRestore()
    }

    const bundled: any = okValue(
      agg.fetchMessagesWindow({ kind: 'latest', topicId: 'q6', limit: 10, includeStructure: true })
    )
    expect(bundled.structure.catalog.map((c: any) => c.id)).toEqual(['sA', 'sB', 'sC'])
    expect(bundled.structure.route.qualifications).toEqual([
      {
        segmentId: 'sA',
        headerInRoute: true,
        headerOwnedByRoute: true,
        routeMemberMessageIds: ['m1', 'm2'],
        turnCount: 2
      },
      { segmentId: 'sB', headerInRoute: true, headerOwnedByRoute: true, routeMemberMessageIds: ['m3'], turnCount: 1 },
      { segmentId: 'sC', headerInRoute: true, headerOwnedByRoute: true, routeMemberMessageIds: ['m4'], turnCount: 1 }
    ])
  })
})
