/**
 * Segment head identity + route qualification (Main authority):
 * - The head is fixed at creation to the first member and never re-derived
 *   from a rendered window: reorders that keep the head leave it in place,
 *   while a head that leaves the group repairs to the first surviving member
 *   in authority membership order (including the message-delete path, which
 *   never dissolves the group — an empty group simply has a NULL head).
 * - An unqualified catalog carries no `route` block (full authority members,
 *   safe to cache); a qualified call returns per-group route metadata without
 *   touching the catalog.
 * Temp DBs only; no real profile is touched.
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
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-seg-head-'))
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
let counter = 0
function uid(): string {
  return `sh${++counter}-${Date.now()}`
}
function okValue<T>(r: { ok: boolean; value?: T; error?: unknown }): T {
  if (!isSuccess(r as never)) throw new Error(`Expected success: ${JSON.stringify(r.error)}`)
  return (r as { value: T }).value
}
function messageJson(id: string, topicId: string, overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    topicId,
    role: 'user',
    content: `content-${id}`,
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}
function blockJson(id: string, messageId: string): Record<string, unknown> {
  return {
    id,
    messageId,
    type: 'main_text',
    content: `block-${id}`,
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

describe('segment head identity and route qualification', () => {
  let tmpDir: string
  let sqlite: Database.Database
  let db: BetterSQLite3Database<typeof schema>
  let agg: ChatDbAggregateService

  beforeEach(() => {
    tmpDir = makeTempDir()
    sqlite = openTestDb(realPath.join(tmpDir, 'test.db'))
    db = drizzle(sqlite, { schema })
    runMigrations(db, sqlite)
    agg = new ChatDbAggregateService(db, sqlite)
    mockCleanTopic.mockReset().mockResolvedValue(undefined)
  })
  afterEach(() => {
    try {
      sqlite.close()
    } catch {
      // ignore
    }
    rmrf(tmpDir)
  })

  function append(topicId: string, m: Record<string, unknown>, branchId?: string): void {
    okValue(
      agg.appendMessage(
        topicId,
        m as never,
        [blockJson(`b-${m.id as string}`, m.id as string) as never],
        undefined,
        undefined,
        branchId === undefined ? undefined : { branchId }
      )
    )
  }
  function seedRoot(topicId: string): void {
    append(topicId, messageJson('u1', topicId))
    append(topicId, messageJson('a1', topicId, { role: 'assistant', askId: 'u1' }))
    append(topicId, messageJson('u2', topicId))
    append(topicId, messageJson('a2', topicId, { role: 'assistant', askId: 'u2' }))
  }
  function rawHead(segmentId: string): string | null {
    return (
      (
        sqlite.prepare('SELECT header_message_id FROM topic_segments WHERE id = ?').get(segmentId) as
          | {
              header_message_id: string | null
            }
          | undefined
      )?.header_message_id ?? null
    )
  }

  it('head is the first member at creation and survives reorders that keep it', () => {
    const topicId = `t-${uid()}`
    seedRoot(topicId)
    const repos = createRepositories(db)
    const segmentId = `seg-${uid()}`

    const created = okValue(
      agg.upsertSegment({ segmentId, topicId, name: 'Group', messageIds: ['u1', 'a1'], branchId: null })
    )
    expect(created.headerMessageId).toBe('u1')
    expect(created.ownerTopicId).toBe(topicId)
    expect(created.ownerBranchId).toBeNull()
    expect(rawHead(segmentId)).toBe('u1')

    // Reorder so the head is no longer first: the identity does not move.
    okValue(agg.replaceSegmentMembership({ segmentId, messageIds: ['a1', 'u1'], branchId: null }))
    expect(repos.segments.getMessageIds(segmentId)).toEqual(['a1', 'u1'])
    expect(rawHead(segmentId)).toBe('u1')
    expect(okValue(agg.listSegments(topicId)).find((s) => s.id === segmentId)?.headerMessageId).toBe('u1')
  })

  it('a head that leaves the group repairs to the first surviving member', () => {
    const topicId = `t-${uid()}`
    seedRoot(topicId)
    const repos = createRepositories(db)
    const segmentId = `seg-${uid()}`
    okValue(agg.upsertSegment({ segmentId, topicId, name: 'Group', messageIds: ['u1', 'a1', 'u2'], branchId: null }))

    okValue(agg.replaceSegmentMembership({ segmentId, messageIds: ['a1', 'u2'], branchId: null }))
    expect(rawHead(segmentId)).toBe('a1')

    okValue(agg.replaceSegmentMembership({ segmentId, messageIds: ['u2'], branchId: null }))
    expect(rawHead(segmentId)).toBe('u2')
    expect(repos.segments.getMessageIds(segmentId)).toEqual(['u2'])
  })

  it('deleting the head message repairs the head when members survive, and dissolves the emptied group', () => {
    const topicId = `t-${uid()}`
    append(topicId, messageJson('m1', topicId))
    append(topicId, messageJson('m2', topicId))
    append(topicId, messageJson('m3', topicId))
    const repos = createRepositories(db)
    const segmentId = `seg-${uid()}`
    okValue(agg.upsertSegment({ segmentId, topicId, name: 'Group', messageIds: ['m1', 'm2', 'm3'], branchId: null }))
    expect(rawHead(segmentId)).toBe('m1')

    // Batch delete repairs the persisted head to the first surviving member.
    okValue(agg.deleteMessages(topicId, ['m1']))
    expect(repos.segments.getById(segmentId).found).toBe(true)
    expect(repos.segments.getMessageIds(segmentId)).toEqual(['m2', 'm3'])
    expect(rawHead(segmentId)).toBe('m2')
    expect(okValue(agg.listSegments(topicId)).find((s) => s.id === segmentId)?.headerMessageId).toBe('m2')

    // Deleting the last members empties the group, and the existing rule
    // dissolves an emptied group (MessagesRepository.cleanupEmptySegmentsInTx)
    // instead of keeping a headless row.
    okValue(agg.deleteMessages(topicId, ['m2', 'm3']))
    expect(repos.segments.getById(segmentId).found).toBe(false)
    expect(okValue(agg.listSegments(topicId)).some((s) => s.id === segmentId)).toBe(false)
  })

  it('empty membership has no head: create writes no row, replace dissolves the group', () => {
    const topicId = `t-${uid()}`
    seedRoot(topicId)
    const repos = createRepositories(db)

    const ghostId = `seg-${uid()}`
    const ghost = okValue(
      agg.upsertSegment({ segmentId: ghostId, topicId, name: 'Ghost', messageIds: [], branchId: null })
    )
    expect(ghost.headerMessageId).toBeNull()
    expect(ghost.messageIds).toEqual([])
    expect(repos.segments.getById(ghostId).found).toBe(false)

    const segmentId = `seg-${uid()}`
    okValue(agg.upsertSegment({ segmentId, topicId, name: 'Group', messageIds: ['u1', 'a1'], branchId: null }))
    agg.replaceSegmentMembership({ segmentId, messageIds: [], branchId: null })
    expect(repos.segments.getById(segmentId).found).toBe(false)
    expect(okValue(agg.listSegments(topicId)).some((s) => s.id === segmentId)).toBe(false)
  })

  it('unqualified catalog carries no route block; qualified calls return exact route metadata', () => {
    const topicId = `t-${uid()}`
    seedRoot(topicId)
    const b = (okValue(agg.createBranch(topicId, null, 'u2', 'B-u2')).branch as { id: string }).id
    append(topicId, messageJson('bu1', topicId), b)
    append(topicId, messageJson('ba1', topicId, { role: 'assistant', askId: 'bu1' }), b)

    const mainSeg = `seg-${uid()}`
    okValue(
      agg.upsertSegment({ segmentId: mainSeg, topicId, name: 'Main group', messageIds: ['u1', 'a1'], branchId: null })
    )
    const branchSeg = `seg-${uid()}`
    okValue(
      agg.upsertSegment({
        segmentId: branchSeg,
        topicId,
        name: 'Branch group',
        messageIds: ['bu1', 'ba1'],
        branchId: b
      })
    )

    // Unqualified: full authority membership, no route block to confuse with authority.
    const catalog = okValue(agg.listSegments(topicId))
    expect(catalog.find((s) => s.id === mainSeg)?.messageIds).toEqual(['u1', 'a1'])
    for (const wire of catalog) {
      expect('route' in wire).toBe(false)
    }

    // Qualified on the branch: the inherited main group is in-route but owned
    // by the main route; the branch group is owned by the addressed route.
    const onBranch = okValue(agg.listSegments(topicId, b))
    const mainQualified = onBranch.find((s) => s.id === mainSeg)
    expect(Object.keys(mainQualified?.route ?? {}).sort()).toEqual(
      ['branchId', 'headerInRoute', 'headerOwnedByRoute', 'routeMemberMessageIds', 'topicId'].sort()
    )
    expect(mainQualified?.route).toMatchObject({
      topicId,
      branchId: b,
      headerInRoute: true,
      headerOwnedByRoute: false,
      routeMemberMessageIds: ['u1', 'a1']
    })
    expect(onBranch.find((s) => s.id === branchSeg)?.route).toMatchObject({
      topicId,
      branchId: b,
      headerInRoute: true,
      headerOwnedByRoute: true,
      routeMemberMessageIds: ['bu1', 'ba1']
    })

    // Qualified on the main route: branch-owned rows are out of route.
    const onMain = okValue(agg.listSegments(topicId, null))
    expect(onMain.find((s) => s.id === branchSeg)?.route).toMatchObject({
      topicId,
      branchId: null,
      headerInRoute: false,
      headerOwnedByRoute: false,
      routeMemberMessageIds: []
    })
    expect(onMain.find((s) => s.id === mainSeg)?.route).toMatchObject({
      headerInRoute: true,
      headerOwnedByRoute: true
    })
  })

  it('route qualification emits members in route-effective order, not catalog order', () => {
    const topicId = `t-${uid()}`
    seedRoot(topicId)
    const segmentId = `seg-${uid()}`
    // Catalog membership deliberately out of chronological order.
    okValue(agg.upsertSegment({ segmentId, topicId, name: 'Group', messageIds: ['a2', 'u1', 'a1'], branchId: null }))
    const wire = okValue(agg.listSegments(topicId, null)).find((s) => s.id === segmentId)
    // Route-effective order even though the catalog lists a2 first, so the
    // window co-commit projection and the hook projection agree exactly.
    expect(wire?.route?.routeMemberMessageIds).toEqual(['u1', 'a1', 'a2'])
    // The catalog authority itself is untouched (still catalog order).
    expect(wire?.messageIds).toEqual(['a2', 'u1', 'a1'])
  })
})
