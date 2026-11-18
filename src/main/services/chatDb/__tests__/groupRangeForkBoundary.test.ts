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
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-fork-range-'))
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
  return `fr${++counter}-${Date.now()}`
}
function okValue<T>(r: { ok: boolean; value?: T; error?: unknown }): T {
  if (!isSuccess(r as never)) throw new Error(`Expected success: ${JSON.stringify(r.error)}`)
  return (r as { value: T }).value
}
function errorCode(r: { ok: boolean; error?: unknown }): string | undefined {
  return (r.error as { code?: string } | undefined)?.code
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

/**
 * Owner equality is the complete group-range authority. A range whose every
 * row is owned by the addressed route stays allowed even when a child fork
 * the route never took sits inside its span — fork dividers and renderer
 * window markers never gate the command. Only a range that starts in, or
 * reaches into, another owner's rows rejects, atomically, with zero writes.
 */
describe('group-level range guard — owner equality only', () => {
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
  /**
   * Main route: u1,a1 / u2,a2 / u3,a3 — three complete turns. `suffix` keeps
   * ids unique when one test seeds two topics.
   */
  function seedRoot(topicId: string, suffix = ''): void {
    append(topicId, messageJson(`u1${suffix}`, topicId))
    append(topicId, messageJson(`a1${suffix}`, topicId, { role: 'assistant', askId: `u1${suffix}` }))
    append(topicId, messageJson(`u2${suffix}`, topicId))
    append(topicId, messageJson(`a2${suffix}`, topicId, { role: 'assistant', askId: `u2${suffix}` }))
    append(topicId, messageJson(`u3${suffix}`, topicId))
    append(topicId, messageJson(`a3${suffix}`, topicId, { role: 'assistant', askId: `u3${suffix}` }))
  }
  function fork(topicId: string, parent: string | null, anchor: string): string {
    return (okValue(agg.createBranch(topicId, parent, anchor, `B-${anchor}`)).branch as { id: string }).id
  }
  /** Raw persisted rows carrying the fold marker, sorted for stable comparison. */
  function markedRows(topicId: string): string[] {
    return (
      sqlite
        .prepare(`SELECT id FROM messages WHERE topic_id = ? AND json_extract(extra, '$.folded') = 1 ORDER BY id`)
        .all(topicId) as { id: string }[]
    ).map((r) => r.id)
  }
  /** Whole-topic row snapshot: proves a rejection wrote nothing. */
  function messagePreimage(topicId: string): string {
    return JSON.stringify(sqlite.prepare('SELECT id, extra FROM messages WHERE topic_id = ? ORDER BY id').all(topicId))
  }
  function segmentRow(segmentId: string): { extra: string | null; header_message_id: string | null } | undefined {
    return sqlite.prepare('SELECT extra, header_message_id FROM topic_segments WHERE id = ?').get(segmentId) as
      | { extra: string | null; header_message_id: string | null }
      | undefined
  }

  it('root: a multi-turn fold spanning an existing fork is allowed when every row shares the owner', () => {
    const topicId = `t-${uid()}`
    seedRoot(topicId)
    // Fork after u2: the child is never taken, so every main row is still
    // owned by the main route — the fork divider must not gate the fold.
    fork(topicId, null, 'u2')

    const folded = okValue(agg.setTurnFolds(topicId, ['u1', 'u3'], true))
    expect(folded.turns.flatMap((t) => t.messageIds).sort()).toEqual(['a1', 'a3', 'u1', 'u3'])
    expect(markedRows(topicId)).toEqual(['a1', 'a3', 'u1', 'u3'])

    // Unfold restores the same rows.
    expect(okValue(agg.setTurnFolds(topicId, ['u1', 'u3'], false)).folded).toBe(false)
    expect(markedRows(topicId)).toEqual([])
  })

  it('root: a turn straddling the fork anchor and a same-side multi-turn span are both allowed', () => {
    const topicId = `t-${uid()}`
    seedRoot(topicId)
    // Fork after u2 puts the anchor inside turn u2 — still same owner.
    fork(topicId, null, 'u2')
    expect(okValue(agg.setTurnFolds(topicId, ['u2'], true)).turns[0].messageIds).toEqual(['u2', 'a2'])

    // Separate topic: fork after a1 (the last row of turn u1), then fold the
    // turn before the fork together with the turn after it.
    const lastRowTopic = `t-${uid()}`
    seedRoot(lastRowTopic, '-x')
    fork(lastRowTopic, null, 'a1-x')
    const both = okValue(agg.setTurnFolds(lastRowTopic, ['u1-x', 'u2-x'], true))
    expect(both.turns.flatMap((t) => t.messageIds).sort()).toEqual(['a1-x', 'a2-x', 'u1-x', 'u2-x'])
  })

  it('root: group create and membership replacement across a fork stay allowed for one owner', () => {
    const topicId = `t-${uid()}`
    seedRoot(topicId)
    fork(topicId, null, 'u2')
    const repos = createRepositories(db)

    // Existing group on the left side of the fork.
    const segmentId = `seg-${uid()}`
    okValue(agg.upsertSegment(segmentId, topicId, 'Left', ['u1', 'a1'], undefined))
    expect(segmentRow(segmentId)?.header_message_id).toBe('u1')

    // Create across the fork: same owner, so the group is written in full and
    // its head is the first member at creation.
    const newSegmentId = `seg-${uid()}`
    const created = okValue(agg.upsertSegment(newSegmentId, topicId, 'Across', ['u1', 'u3'], undefined))
    expect(created.messageIds).toEqual(['u1', 'u3'])
    expect(created.headerMessageId).toBe('u1')

    // Membership replacement across the fork: same owner, so it lands and the
    // head follows the first surviving member deterministically.
    const replaced = okValue(agg.replaceSegmentMembership(segmentId, ['u1', 'a1', 'u3']))
    expect(replaced?.messageIds).toEqual(['u1', 'a1', 'u3'])
    expect(repos.segments.getMessageIds(segmentId)).toEqual(['u1', 'a1', 'u3'])
  })

  it('branch: a child fork inside the own suffix does not block a same-owner fold or range', () => {
    const topicId = `t-${uid()}`
    // Main route: u1,a1,u2,a2 with a fork after u2.
    append(topicId, messageJson('u1', topicId))
    append(topicId, messageJson('a1', topicId, { role: 'assistant', askId: 'u1' }))
    append(topicId, messageJson('u2', topicId))
    append(topicId, messageJson('a2', topicId, { role: 'assistant', askId: 'u2' }))
    const b = fork(topicId, null, 'u2')
    // B owns bu1,ba1,bu2,ba2 (its fork boundary is the first own row, bu1).
    append(topicId, messageJson('bu1', topicId), b)
    append(topicId, messageJson('ba1', topicId, { role: 'assistant', askId: 'bu1' }), b)
    append(topicId, messageJson('bu2', topicId), b)
    append(topicId, messageJson('ba2', topicId, { role: 'assistant', askId: 'bu2' }), b)
    // C forks off B after ba1: on route B, ba1 is a fork point inside the own
    // suffix (not the route's own inherited boundary).
    fork(topicId, b, 'ba1')

    // Same-owner spans across the child fork stay allowed.
    const folded = okValue(agg.setTurnFolds(topicId, ['bu1', 'bu2'], true, b))
    expect(folded.turns.flatMap((t) => t.messageIds).sort()).toEqual(['ba1', 'ba2', 'bu1', 'bu2'])
    expect(markedRows(topicId)).toEqual(['ba1', 'ba2', 'bu1', 'bu2'])

    // The main route's own untouched-child fork likewise never gates it.
    const mainFolded = okValue(agg.setTurnFolds(topicId, ['u1', 'u2'], true))
    expect(mainFolded.turns.flatMap((t) => t.messageIds).sort()).toEqual(['a1', 'a2', 'u1', 'u2'])

    // A group spanning the child fork on B is written in full.
    const crossingSegmentId = `seg-${uid()}`
    const created = okValue(agg.upsertSegment(crossingSegmentId, topicId, 'Across', ['bu1', 'bu2'], undefined, b))
    expect(created.messageIds).toEqual(['bu1', 'bu2'])
    expect(created.headerMessageId).toBe('bu1')
    expect(created.ownerBranchId).toBe(b)
  })

  it('branch: membership replacement across the own-suffix child fork lands on the group', () => {
    const topicId = `t-${uid()}`
    append(topicId, messageJson('u1', topicId))
    append(topicId, messageJson('a1', topicId, { role: 'assistant', askId: 'u1' }))
    const b = fork(topicId, null, 'u1')
    append(topicId, messageJson('bu1', topicId), b)
    append(topicId, messageJson('ba1', topicId, { role: 'assistant', askId: 'bu1' }), b)
    append(topicId, messageJson('bu2', topicId), b)
    append(topicId, messageJson('ba2', topicId, { role: 'assistant', askId: 'bu2' }), b)
    fork(topicId, b, 'ba1')
    const repos = createRepositories(db)

    const segmentId = `seg-${uid()}`
    okValue(agg.upsertSegment(segmentId, topicId, 'After', ['bu2', 'ba2'], undefined, b))

    const replaced = okValue(agg.replaceSegmentMembership(segmentId, ['bu1', 'bu2'], b))
    expect(replaced?.messageIds).toEqual(['bu1', 'bu2'])
    expect(repos.segments.getMessageIds(segmentId)).toEqual(['bu1', 'bu2'])
  })

  it('cross-ownership: an inherited row rejects a branch fold atomically with zero writes', () => {
    const topicId = `t-${uid()}`
    seedRoot(topicId)
    const b = fork(topicId, null, 'u2')
    append(topicId, messageJson('bu1', topicId), b)
    append(topicId, messageJson('ba1', topicId, { role: 'assistant', askId: 'bu1' }), b)
    const before = messagePreimage(topicId)

    // Turn u1 is on route B's effective sequence but owned by the main route:
    // mixing it with B's own turn rejects instead of writing either side.
    const crossing = agg.setTurnFolds(topicId, ['u1', 'bu1'], true, b)
    expect(crossing.ok).toBe(false)
    expect(errorCode(crossing)).toBe('VALIDATION_ERROR')
    expect(messagePreimage(topicId)).toBe(before)
    expect(markedRows(topicId)).toEqual([])

    // Each side alone is still allowed: the inherited turn folds from its
    // owner route, the own turn from B.
    expect(okValue(agg.setTurnFolds(topicId, ['u1'], true)).turns[0].messageIds).toEqual(['u1', 'a1'])
    expect(okValue(agg.setTurnFolds(topicId, ['bu1'], true, b)).turns[0].messageIds).toEqual(['bu1', 'ba1'])
  })

  it('cross-ownership: group writes reaching into another owner reject with zero writes', () => {
    const topicId = `t-${uid()}`
    seedRoot(topicId)
    const b = fork(topicId, null, 'u2')
    append(topicId, messageJson('bu1', topicId), b)
    append(topicId, messageJson('ba1', topicId, { role: 'assistant', askId: 'bu1' }), b)
    const repos = createRepositories(db)

    // Create mixing B-owned and main-owned rows on route B rejects, and no
    // segment row appears.
    const crossingSegmentId = `seg-${uid()}`
    const created = agg.upsertSegment(crossingSegmentId, topicId, 'Across', ['bu1', 'u1'], undefined, b)
    expect(created.ok).toBe(false)
    expect(errorCode(created)).toBe('VALIDATION_ERROR')
    expect(segmentRow(crossingSegmentId)).toBeUndefined()

    // A B-owned group cannot be re-membered onto a main-owned row.
    const segmentId = `seg-${uid()}`
    okValue(agg.upsertSegment(segmentId, topicId, 'Mine', ['bu1', 'ba1'], undefined, b))
    const membershipBefore = repos.segments.getMessageIds(segmentId)
    const extraBefore = segmentRow(segmentId)?.extra

    const replaced = agg.replaceSegmentMembership(segmentId, ['bu1', 'u1'], b)
    expect(replaced.ok).toBe(false)
    expect(errorCode(replaced)).toBe('VALIDATION_ERROR')
    expect(repos.segments.getMessageIds(segmentId)).toEqual(membershipBefore)
    expect(segmentRow(segmentId)?.extra).toBe(extraBefore)

    // From the main route, a B-owned row is not even on the addressed route.
    const mainSide = agg.setTurnFolds(topicId, ['bu1'], true)
    expect(mainSide.ok).toBe(false)
    expect(errorCode(mainSide)).toBe('VALIDATION_ERROR')
  })

  it('group metadata follows the head owner: a non-owner route reads but cannot rename, delete or re-member', () => {
    const topicId = `t-${uid()}`
    seedRoot(topicId)
    const b = fork(topicId, null, 'u2')
    append(topicId, messageJson('bu1', topicId), b)
    append(topicId, messageJson('ba1', topicId, { role: 'assistant', askId: 'bu1' }), b)

    // Main-owned group: head u1 belongs to the main route.
    const segmentId = `seg-${uid()}`
    okValue(agg.upsertSegment(segmentId, topicId, 'Main group', ['u1', 'a1'], undefined))

    // Route B may list and navigate it, but every mutation rejects.
    const listed = okValue(agg.listSegments(topicId, b)).find((s) => s.id === segmentId)
    expect(listed?.route?.headerInRoute).toBe(true)
    expect(listed?.route?.headerOwnedByRoute).toBe(false)
    expect(agg.updateSegmentMetadata(segmentId, 'Renamed', undefined, undefined, b).ok).toBe(false)
    expect(agg.deleteSegment(segmentId, b).ok).toBe(false)
    expect(agg.replaceSegmentMembership(segmentId, ['u2', 'a2'], b).ok).toBe(false)

    // The owning route renames, deletes and re-members the same group.
    expect(okValue(agg.updateSegmentMetadata(segmentId, 'Renamed', undefined)).name).toBe('Renamed')
    expect(okValue(agg.replaceSegmentMembership(segmentId, ['u2', 'a2']))?.messageIds).toEqual(['u2', 'a2'])
    expect(agg.deleteSegment(segmentId).ok).toBe(true)
  })

  it('context keeps working across a fork: only the same side changes participation', () => {
    const topicId = `t-${uid()}`
    seedRoot(topicId)
    fork(topicId, null, 'u2')

    const initial = okValue(agg.fetchContextClosure({ topicId, anchorGroupKey: 'u1' }))
    expect(initial.closure.totalTurnCount).toBe(3)
    expect(initial.closure.foldedMessageIds).toEqual([])

    // Folding the side before the fork is a plain context change.
    okValue(agg.setTurnFolds(topicId, ['u1'], true))
    const folded = okValue(agg.fetchContextClosure({ topicId, anchorGroupKey: 'u1' }))
    expect([...folded.closure.foldedMessageIds].sort()).toEqual(['a1', 'u1'])
    expect(folded.closure.totalTurnCount).toBe(2)
    // The anchor still resolves and the window slice is untouched.
    expect(folded.closure.anchorGroupKey).toBe('u1')
    expect(folded.messages.map((m: any) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3'])

    okValue(agg.setTurnFolds(topicId, ['u1'], false))
    const restored = okValue(agg.fetchContextClosure({ topicId, anchorGroupKey: 'u1' }))
    expect(restored.closure.totalTurnCount).toBe(3)
    expect(restored.closure.foldedMessageIds).toEqual([])
  })

  it('a head fork does not split the route: no message sits between rows', () => {
    const topicId = `t-${uid()}`
    append(topicId, messageJson('u1', topicId))
    const b = fork(topicId, null, 'u1')
    // Deleting the anchor with no surviving predecessor moves the child's
    // boundary to the parent route's history head (kind 'head').
    okValue(agg.deleteMessage(topicId, 'u1'))
    append(topicId, messageJson('u2', topicId))
    append(topicId, messageJson('a2', topicId, { role: 'assistant', askId: 'u2' }))
    const catalog = okValue(agg.listBranches(topicId)).branches as unknown as Array<{
      id: string
      inheritedBoundary?: { kind: string }
    }>
    expect(catalog.find((c) => c.id === b)?.inheritedBoundary?.kind).toBe('head')

    // No fork point lies between the remaining rows, so the ranges are allowed.
    expect(okValue(agg.setTurnFolds(topicId, ['u2'], true)).turns[0].messageIds).toEqual(['u2', 'a2'])
    const segmentId = `seg-${uid()}`
    okValue(agg.upsertSegment(segmentId, topicId, 'Whole', ['u2', 'a2'], undefined))
    expect(createRepositories(db).segments.getMessageIds(segmentId)).toEqual(['u2', 'a2'])
  })
})
