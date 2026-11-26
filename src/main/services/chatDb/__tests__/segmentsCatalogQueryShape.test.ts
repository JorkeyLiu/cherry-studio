/**
 * Ordinary catalog (`listSegments` without a route) set-based reads.
 *
 * The unqualified catalog is route-independent, so it reads its whole topic
 * with ONE membership query plus one id-keyed projection query per bind chunk —
 * never one membership query plus one header point lookup per group. Three
 * kinds of evidence, all on the real repositories against a real migrated
 * SQLite database:
 *
 * 1. Query shape derived from the actual relation (the bind-chunk count), never
 *    from a hard-coded statement total.
 * 2. Full-wire equivalence: every field of every wire is compared against an
 *    expectation assembled from raw SQL plus the group's authoritative
 *    membership, not from the code path under test.
 * 3. The legacy/import states a topic-filtered or per-group read would silently
 *    break: a persisted head outside the group (fallback), a persisted head
 *    owned by another topic (foreign owner), a member without a message row
 *    (no resolvable head), and membership order tie-breaking.
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
import { createRepositories } from '../repository/factory'
import { MessagesRepository } from '../repository/MessagesRepository'
import { MESSAGE_STRUCTURE_ID_CHUNK } from '../repository/MessagesRepository'
import { TopicSegmentsRepository } from '../repository/TopicSegmentsRepository'
import * as schema from '../schema'

interface HeaderExpectation {
  headerMessageId: string | null
  ownerTopicId: string
  ownerBranchId: string | null
}

interface PreparedStatementShape {
  /** Every SQL statement prepared while running the measured call. */
  all: string[]
  /** Statements reading the segment catalog (`topic_segments`). */
  catalog: string[]
  /** Statements reading `topic_segment_messages` (group membership reads). */
  membership: string[]
  /** Statements reading `messages` with an explicit `id IN (...)` bind list. */
  idSetReads: string[]
  /** Statements reading one `messages` row by `id = ?`. */
  pointLookups: string[]
}

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-segment-catalog-shape-'))
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

describe('ordinary segment catalog set-based reads (real repositories, real transaction)', () => {
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
  /** Insert message rows straight into the table: bulk fixtures skip the write path. */
  function insertRows(topic: string, ids: string[]): void {
    const stmt = sqlite.prepare(
      'INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)'
    )
    ids.forEach((id, index) => {
      stmt.run(id, topic, 'user', `c-${id}`, 'success', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', index)
    })
  }
  function upsert(segmentId: string, topic: string, messageIds: string[], color?: string): void {
    okValue(agg.upsertSegment({ segmentId, topicId: topic, name: `g-${segmentId}`, messageIds, branchId: null, color }))
  }
  /** Legacy/import rows the aggregate write path would reject, written directly. */
  function setHeader(segmentId: string, messageId: string | null): void {
    sqlite.prepare('UPDATE topic_segments SET header_message_id = ? WHERE id = ?').run(messageId, segmentId)
  }
  function insertMembership(segmentId: string, messageId: string, sortOrder: number): void {
    sqlite
      .prepare('INSERT INTO topic_segment_messages (segment_id, message_id, sort_order) VALUES (?,?,?)')
      .run(segmentId, messageId, sortOrder)
  }
  function setMembershipOrder(segmentId: string, sortOrder: number): void {
    sqlite.prepare('UPDATE topic_segment_messages SET sort_order = ? WHERE segment_id = ?').run(sortOrder, segmentId)
  }

  /**
   * Statement inventory for one measured call, captured at the SQLite client
   * (every repository read goes through it). Passthrough: the real statements
   * still execute, so this observes the exact query shape the read issues.
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
      catalog: all.filter((sql) => sql.includes('from "topic_segments"')),
      membership: all.filter((sql) => sql.includes('from "topic_segment_messages"')),
      idSetReads: messagesStatements.filter((sql) => sql.includes('"messages"."id" in (')),
      pointLookups: messagesStatements.filter((sql) => sql.includes('"messages"."id" = '))
    }
  }

  /**
   * Full-wire expectation assembled OUTSIDE the code path under test: catalog
   * columns from raw SQL, membership/order and header identity from the
   * authoritative fixture, and the wire's derived first/last/count computed
   * from that membership.
   */
  function wireFromAuthority(
    segmentId: string,
    messageIds: string[],
    header: HeaderExpectation
  ): Record<string, unknown> {
    const row = sqlite
      .prepare('SELECT id, topic_id, name, created_at, updated_at, sort_order, extra FROM topic_segments WHERE id = ?')
      .get(segmentId) as {
      id: string
      topic_id: string
      name: string | null
      created_at: string | null
      updated_at: string | null
      sort_order: number
      extra: string | null
    }
    const overflow = row.extra ? (JSON.parse(row.extra) as Record<string, unknown>) : {}
    const wire: Record<string, unknown> = {
      id: row.id,
      topicId: row.topic_id,
      name: row.name,
      messageIds: [...messageIds],
      headerMessageId: header.headerMessageId,
      ownerTopicId: header.ownerTopicId,
      ownerBranchId: header.ownerBranchId,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sortOrder: row.sort_order,
      firstMessageId: messageIds.length > 0 ? messageIds[0] : null,
      lastMessageId: messageIds.length > 0 ? messageIds[messageIds.length - 1] : null,
      messageCount: messageIds.length
    }
    if (typeof overflow.color === 'string') wire.color = overflow.color
    return wire
  }
  function ownHeader(topic: string, messageIds: string[]): HeaderExpectation {
    return { headerMessageId: messageIds[0] ?? null, ownerTopicId: topic, ownerBranchId: null }
  }

  /** Projection statements the read legitimately needs for this topic relation. */
  function expectedProjectionChunks(topicId: string): number {
    const repos = createRepositories(db)
    const segments = repos.segments.listByTopic(topicId)
    const members = repos.segments.listMembersByTopic(topicId)
    const ids = new Set<string>()
    for (const segment of segments) {
      for (const id of members.get(segment.id) ?? []) ids.add(id)
    }
    return ids.size === 0 ? 0 : Math.ceil(ids.size / MESSAGE_STRUCTURE_ID_CHUNK)
  }

  it('reads one membership statement plus chunked projection statements and no per-group lookup', () => {
    ensureTopic('c1')
    for (let g = 0; g < 6; g++) {
      append('c1', `a${g}`)
      append('c1', `b${g}`)
    }
    for (let g = 0; g < 6; g++) upsert(`s${g}`, 'c1', [`a${g}`, `b${g}`], g === 3 ? '#ff0000' : undefined)

    const chunks = expectedProjectionChunks('c1')
    expect(chunks).toBe(1)

    const perGroupMembershipSpy = vi.spyOn(TopicSegmentsRepository.prototype, 'getMessageIds')
    const messagePointSpy = vi.spyOn(MessagesRepository.prototype, 'getById')
    const bulkMembershipSpy = vi.spyOn(TopicSegmentsRepository.prototype, 'listMembersByTopic')
    let shape: PreparedStatementShape
    try {
      shape = statementShape(() => {
        okValue(agg.listSegments('c1'))
      })
      // Six groups: still ONE membership read and ZERO per-group reads/point
      // lookups, however many groups the topic has.
      expect(perGroupMembershipSpy).toHaveBeenCalledTimes(0)
      expect(messagePointSpy).toHaveBeenCalledTimes(0)
      expect(bulkMembershipSpy).toHaveBeenCalledTimes(1)
    } finally {
      perGroupMembershipSpy.mockRestore()
      messagePointSpy.mockRestore()
      bulkMembershipSpy.mockRestore()
    }

    expect(shape.membership).toHaveLength(1)
    expect(shape.catalog).toHaveLength(1)
    expect(shape.idSetReads).toHaveLength(chunks)
    expect(shape.pointLookups).toHaveLength(0)
    // Whole read: catalog + membership + projection chunks, nothing else.
    expect(shape.all).toHaveLength(2 + chunks)

    // Full value equivalence, field by field, against an external expectation.
    const wires = okValue(agg.listSegments('c1'))
    expect(wires.map((w) => w.id)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5'])
    expect(wires).toEqual([
      wireFromAuthority('s0', ['a0', 'b0'], ownHeader('c1', ['a0', 'b0'])),
      wireFromAuthority('s1', ['a1', 'b1'], ownHeader('c1', ['a1', 'b1'])),
      wireFromAuthority('s2', ['a2', 'b2'], ownHeader('c1', ['a2', 'b2'])),
      wireFromAuthority('s3', ['a3', 'b3'], ownHeader('c1', ['a3', 'b3'])),
      wireFromAuthority('s4', ['a4', 'b4'], ownHeader('c1', ['a4', 'b4'])),
      wireFromAuthority('s5', ['a5', 'b5'], ownHeader('c1', ['a5', 'b5']))
    ])
    // Optional presentation field: emitted for the colored group, fully absent
    // (never `undefined`) elsewhere.
    expect(wires[3]).toHaveProperty('color', '#ff0000')
    expect('color' in (wires[0] as unknown as Record<string, unknown>)).toBe(false)
  })

  it('legacy persisted head outside the group falls back to the first (sortOrder, id) member', () => {
    ensureTopic('c2')
    insertRows('c2', ['m1', 'm2', 'm3', 'm4', 'mOut'])
    // Membership order m2 -> m1 is authoritative; the persisted head is a real
    // message of this topic that is simply not a member of this group. A
    // message belongs to at most one group, so the tie-break case files its
    // own rows instead of re-filing m1/m2.
    upsert('sOutside', 'c2', ['m2', 'm1'])
    setHeader('sOutside', 'mOut')
    // Both membership rows on one sortOrder: the tie breaks by id.
    upsert('sTie', 'c2', ['m4', 'm3'])
    setMembershipOrder('sTie', 7)
    setHeader('sTie', 'mOut')

    const wires = okValue(agg.listSegments('c2'))
    expect(wires).toEqual([
      wireFromAuthority('sOutside', ['m2', 'm1'], {
        headerMessageId: 'm2',
        ownerTopicId: 'c2',
        ownerBranchId: null
      }),
      wireFromAuthority('sTie', ['m3', 'm4'], {
        headerMessageId: 'm3',
        ownerTopicId: 'c2',
        ownerBranchId: null
      })
    ])
    // The out-of-group head row exists, so this is the fallback rule and not the
    // missing-row rule: the wire names the surviving member, not null.
    expect(wires[0].headerMessageId).toBe('m2')
    expect(wires[1].headerMessageId).toBe('m3')
  })

  it('foreign-topic member carried as the persisted head keeps its foreign owner', () => {
    ensureTopic('cRef')
    append('cRef', 'rm')
    ensureTopic('cSrc')
    append('cSrc', 'sm')
    upsert('sF', 'cRef', ['rm'])
    insertMembership('sF', 'sm', 1)
    setHeader('sF', 'sm')

    const wires = okValue(agg.listSegments('cRef'))
    expect(wires).toEqual([
      wireFromAuthority('sF', ['rm', 'sm'], {
        headerMessageId: 'sm',
        ownerTopicId: 'cSrc',
        ownerBranchId: null
      })
    ])
  })

  it('member without a message row keeps its membership and reports no resolvable head', () => {
    ensureTopic('cMiss')
    append('cMiss', 'm1')
    upsert('sMiss', 'cMiss', ['m1'])
    sqlite.pragma('foreign_keys = OFF')
    insertMembership('sMiss', 'ghost', 1)
    setHeader('sMiss', 'ghost')
    sqlite.pragma('foreign_keys = ON')

    const wires = okValue(agg.listSegments('cMiss'))
    expect(wires).toEqual([
      wireFromAuthority('sMiss', ['m1', 'ghost'], {
        headerMessageId: null,
        ownerTopicId: 'cMiss',
        ownerBranchId: null
      })
    ])
    expect(wires[0].messageCount).toBe(2)
    expect(wires[0].lastMessageId).toBe('ghost')
  })

  it('members beyond one bind chunk add projection statements only; values unchanged', () => {
    ensureTopic('c3')
    const ids = Array.from({ length: MESSAGE_STRUCTURE_ID_CHUNK + 44 }, (_, i) => `m${String(i).padStart(3, '0')}`)
    insertRows('c3', ids)
    upsert('sBig', 'c3', ids)

    const chunks = expectedProjectionChunks('c3')
    expect(chunks).toBe(2)

    const shape = statementShape(() => {
      okValue(agg.listSegments('c3'))
    })
    expect(shape.membership).toHaveLength(1)
    expect(shape.catalog).toHaveLength(1)
    expect(shape.idSetReads).toHaveLength(chunks)
    expect(shape.pointLookups).toHaveLength(0)
    expect(shape.all).toHaveLength(2 + chunks)

    const wires = okValue(agg.listSegments('c3'))
    expect(wires).toEqual([wireFromAuthority('sBig', ids, ownHeader('c3', ids))])
  })

  it('empty catalog and unknown topic read no membership and no message row at all', () => {
    ensureTopic('cEmpty')
    const bulkMembershipSpy = vi.spyOn(TopicSegmentsRepository.prototype, 'listMembersByTopic')
    const perGroupMembershipSpy = vi.spyOn(TopicSegmentsRepository.prototype, 'getMessageIds')
    const messageSetSpy = vi.spyOn(MessagesRepository.prototype, 'findStructureRowsByIds')
    try {
      const emptyShape = statementShape(() => {
        expect(okValue(agg.listSegments('cEmpty'))).toEqual([])
      })
      const unknownShape = statementShape(() => {
        expect(okValue(agg.listSegments('cUnknown'))).toEqual([])
      })
      expect(emptyShape.all).toHaveLength(1)
      expect(emptyShape.catalog).toHaveLength(1)
      expect(emptyShape.membership).toHaveLength(0)
      expect(emptyShape.idSetReads).toHaveLength(0)
      expect(emptyShape.pointLookups).toHaveLength(0)
      expect(unknownShape.all).toHaveLength(1)
      expect(unknownShape.catalog).toHaveLength(1)
      expect(unknownShape.membership).toHaveLength(0)
      expect(unknownShape.idSetReads).toHaveLength(0)
      expect(unknownShape.pointLookups).toHaveLength(0)
      // No topic-existence read either: an unknown topic is an empty catalog.
      expect(bulkMembershipSpy).toHaveBeenCalledTimes(0)
      expect(perGroupMembershipSpy).toHaveBeenCalledTimes(0)
      expect(messageSetSpy).toHaveBeenCalledTimes(0)
    } finally {
      bulkMembershipSpy.mockRestore()
      perGroupMembershipSpy.mockRestore()
      messageSetSpy.mockRestore()
    }
  })

  it('an explicit null route is the qualified catalog; undefined stays unqualified', () => {
    ensureTopic('cQ')
    append('cQ', 'q1')
    upsert('sQ', 'cQ', ['q1'])

    const unqualified = okValue(agg.listSegments('cQ'))
    expect(unqualified).toEqual([wireFromAuthority('sQ', ['q1'], ownHeader('cQ', ['q1']))])
    expect('route' in (unqualified[0] as unknown as Record<string, unknown>)).toBe(false)

    const qualified = okValue(agg.listSegments('cQ', null))
    expect(qualified).toHaveLength(1)
    const { route, ...neutral } = qualified[0] as unknown as Record<string, unknown> & {
      route?: Record<string, unknown>
    }
    // The unqualified read and the neutral part of the qualified read agree.
    expect(neutral).toEqual(unqualified[0])
    expect(route).toMatchObject({
      topicId: 'cQ',
      branchId: null,
      headerInRoute: true,
      headerOwnedByRoute: true,
      routeMemberMessageIds: ['q1']
    })
  })
})
