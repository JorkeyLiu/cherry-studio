/**
 * Edit-mode delete / cut undo: message restore + inheritance-boundary restore.
 *
 * The product undo path restores through `insertMessageGroups`, never through
 * `appendMessage`. These tests exercise that real chain:
 *
 * - `deleteMessagesWithDependents` reports the branch anchors and cross-topic
 *   reference endpoints it actually moved (pre-delete value + the value it
 *   wrote), inside the same transaction.
 * - Undo re-inserts the deleted rows AND reverts exactly those boundaries in
 *   the same Main transaction (`boundaryRestores`), so a branch/reference is
 *   restored by one mechanism with identical guarantees.
 * - Redo re-applies the delete and therefore re-applies its boundary effect.
 * - A boundary the user removed since is never recreated, and a boundary that
 *   moved further since is never overwritten (compare-and-set).
 */
import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import type { DeleteMessagesWithDependentsResponse, InsertMessageGroup } from '@shared/chatDb'
import { isSuccess } from '@shared/chatDb'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')
vi.mock('@main/config', () => ({ DATA_PATH: '/mock/data' }))
const configStore = new Map<string, unknown>()
vi.mock('@main/services/ConfigManager', () => ({
  configManager: {
    get: (k: string, def?: unknown) => (configStore.has(k) ? configStore.get(k) : def),
    set: (k: string, v: unknown) => configStore.set(k, v),
    has: (k: string) => configStore.has(k)
  },
  ConfigKeys: {}
}))
vi.mock('../../SpanCacheService', () => ({
  spanCacheService: { cleanTopic: vi.fn().mockResolvedValue(undefined) }
}))

import { seedRegisteredAttachedSyncService } from '../../sync/__tests__/helpers/syncTestRegistration'
import { chatDbService } from '..'
import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { runMigrations } from '../migration'
import * as schema from '../schema'

type DeleteResponse = DeleteMessagesWithDependentsResponse

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-boundary-undo-'))
}
function rmrf(dir: string): void {
  realFs.rmSync(dir, { recursive: true, force: true })
}
function openDb(): { sqlite: Database.Database; db: BetterSQLite3Database<typeof schema>; dir: string } {
  const dir = makeTempDir()
  const sqlite = new Database(realPath.join(dir, 'chat.db'))
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  runMigrations(db as never, sqlite)
  return { sqlite, db, dir }
}
function okValue<T>(result: { ok: boolean; value?: T; error?: unknown }): T {
  if (!isSuccess(result as never))
    throw new Error(`Expected success, got: ${JSON.stringify((result as { error?: unknown }).error)}`)
  return (result as { value: T }).value
}
function msgJson(id: string, topicId: string, overrides?: Record<string, unknown>): Record<string, unknown> {
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
function seedMain(agg: ChatDbAggregateService, topicId: string, ids: string[]): void {
  expect(agg.ensureTopic(topicId, 'assistant-1', `topic-${topicId}`).ok).toBe(true)
  for (const id of ids) {
    expect(agg.appendMessage(topicId, msgJson(id, topicId) as never, [blockJson(`b-${id}`, id) as never]).ok).toBe(true)
  }
}
function seedSuffix(agg: ChatDbAggregateService, topicId: string, branchId: string, ids: string[]): void {
  for (const id of ids) {
    expect(
      agg.appendMessage(
        topicId,
        msgJson(id, topicId) as never,
        [blockJson(`b-${id}`, id) as never],
        undefined,
        undefined,
        { branchId }
      ).ok
    ).toBe(true)
  }
}
function routeIds(agg: ChatDbAggregateService, topicId: string, branchId: string | null): string[] {
  return (okValue(agg.fetchMessages(topicId, branchId)).messages as Array<{ id: string }>).map((m) => m.id)
}
function persistedAnchor(sqlite: Database.Database, branchId: string): string {
  return (sqlite.prepare('SELECT anchor_message_id AS a FROM topic_branches WHERE id=?').get(branchId) as { a: string })
    .a
}
function persistedReferenceAnchor(sqlite: Database.Database, targetTopicId: string): string {
  return (
    sqlite
      .prepare('SELECT anchor_message_id AS a FROM topic_references WHERE target_topic_id=?')
      .get(targetTopicId) as {
      a: string
    }
  ).a
}
function hasBranchRow(sqlite: Database.Database, branchId: string): boolean {
  return sqlite.prepare('SELECT id FROM topic_branches WHERE id=?').get(branchId) !== undefined
}
function deleteResponse(
  agg: ChatDbAggregateService,
  topicId: string,
  roots: string[],
  route: string | null
): DeleteResponse {
  return okValue(agg.deleteMessagesWithDependents(topicId, roots, route))
}
/** The product undo restore payload: authority groups + boundary restores. */
function undoGroups(response: DeleteResponse): InsertMessageGroup[] {
  return response.restoreGroups.map((group) => ({
    entries: group.entries.map((entry) => ({
      message: entry.message,
      blocks: entry.blocks
    })),
    intent:
      group.anchorMessageId != null
        ? ({ kind: 'before-message', messageId: group.anchorMessageId } as const)
        : ({ kind: 'topic-tail' } as const)
  }))
}

describe('edit-mode undo restores messages and the inheritance boundaries the delete moved', () => {
  let sqlite: Database.Database
  let db: BetterSQLite3Database<typeof schema>
  let agg: ChatDbAggregateService
  let dir: string
  beforeEach(() => {
    configStore.clear()
    const opened = openDb()
    sqlite = opened.sqlite
    db = opened.db
    dir = opened.dir
    ;(chatDbService as unknown as { sqlite: unknown }).sqlite = sqlite
    ;(chatDbService as unknown as { db: unknown }).db = db
    seedRegisteredAttachedSyncService(configStore as never, db)
    agg = new ChatDbAggregateService(db, sqlite)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    try {
      sqlite.close()
    } catch {}
    rmrf(dir)
    ;(chatDbService as never as { sqlite: unknown }).sqlite = null
    ;(chatDbService as never as { db: unknown }).db = null
  })

  it('delete → undo restores the branch anchor, the message, its position and its owner; redo re-advances it', () => {
    seedMain(agg, 't1', ['m0', 'm1', 'm2'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm1', 'B1')).branch as { id: string }).id
    seedSuffix(agg, 't1', b1, ['c0'])

    const before = routeIds(agg, 't1', b1)
    const del = deleteResponse(agg, 't1', ['m1'], null)
    expect(del.deletedMessageIds).toEqual(['m1'])
    expect(persistedAnchor(sqlite, b1)).toBe('m0')
    expect(del.boundarySnapshots).toEqual([
      { kind: 'branch', id: b1, anchorMessageId: 'm1', expectedAnchorMessageId: 'm0' }
    ])
    expect(routeIds(agg, 't1', b1)).toEqual(['m0', 'c0'])

    // Undo: messages + boundary in ONE Main transaction.
    const undoAck = okValue(agg.insertMessageGroups('t1', undoGroups(del), null, del.boundarySnapshots))
    expect(undoAck.boundaryRestores).toEqual([{ kind: 'branch', id: b1, anchorMessageId: 'm1', restored: true }])
    expect(undoAck.insertedMessageIds).toEqual(['m1'])
    expect(persistedAnchor(sqlite, b1)).toBe('m1')
    expect(routeIds(agg, 't1', b1)).toEqual(before)
    // Original position on the main route and original owner are unchanged.
    expect(routeIds(agg, 't1', null)).toEqual(['m0', 'm1', 'm2'])
    const owner = sqlite.prepare('SELECT branch_id AS b FROM messages WHERE id=?').get('m1') as { b: string | null }
    expect(owner.b).toBeNull()

    // Redo: the same delete re-applies its boundary effect.
    const redo = deleteResponse(agg, 't1', ['m1'], null)
    expect(persistedAnchor(sqlite, b1)).toBe('m0')
    expect(redo.boundarySnapshots).toEqual([
      { kind: 'branch', id: b1, anchorMessageId: 'm1', expectedAnchorMessageId: 'm0' }
    ])
    expect(routeIds(agg, 't1', b1)).toEqual(['m0', 'c0'])

    // Redo → undo again restores the exact pre-delete state.
    okValue(agg.insertMessageGroups('t1', undoGroups(redo), null, redo.boundarySnapshots))
    expect(persistedAnchor(sqlite, b1)).toBe('m1')
    expect(routeIds(agg, 't1', b1)).toEqual(before)
  })

  it('undo of a cut source delete restores the cross-topic reference endpoint in the same transaction', () => {
    seedMain(agg, 'src', ['s0', 's1', 's2'])
    okValue(agg.createReferencedTopic('src', null, 'ref', 's2'))
    expect(agg.appendMessage('ref', msgJson('r0', 'ref') as never, [blockJson('b-r0', 'r0') as never]).ok).toBe(true)
    const before = routeIds(agg, 'ref', null)
    const beforeAnchor = persistedReferenceAnchor(sqlite, 'ref')

    const cut = deleteResponse(agg, 'src', ['s2'], null)
    expect(cut.boundarySnapshots).toEqual([
      { kind: 'reference', id: 'ref', anchorMessageId: 's2', expectedAnchorMessageId: 's1' }
    ])
    expect(persistedReferenceAnchor(sqlite, 'ref')).toBe('s1')
    expect(routeIds(agg, 'ref', null)).toEqual(['s0', 's1', 'r0'])

    const undoAck = okValue(agg.insertMessageGroups('src', undoGroups(cut), null, cut.boundarySnapshots))
    expect(undoAck.boundaryRestores).toEqual([{ kind: 'reference', id: 'ref', anchorMessageId: 's2', restored: true }])
    expect(persistedReferenceAnchor(sqlite, 'ref')).toBe(beforeAnchor)
    expect(routeIds(agg, 'ref', null)).toEqual(before)
    // The restored endpoint still resolves as an available reference prefix.
    const win = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: 'ref', limit: 50 }))
    expect(win.reference?.status).toBe('available')
    expect(win.reference?.boundaryMessageId).toBe('s2')

    // Redo re-shortens the prefix through the same delete mechanism.
    const redo = deleteResponse(agg, 'src', ['s2'], null)
    expect(persistedReferenceAnchor(sqlite, 'ref')).toBe('s1')
    expect(routeIds(agg, 'ref', null)).toEqual(['s0', 's1', 'r0'])
    expect(redo.boundarySnapshots).toEqual([
      { kind: 'reference', id: 'ref', anchorMessageId: 's2', expectedAnchorMessageId: 's1' }
    ])
  })

  it('batch delete on one route restores every moved branch boundary at once', () => {
    seedMain(agg, 't1', ['m0', 'm1', 'm2'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm1', 'B1')).branch as { id: string }).id
    seedSuffix(agg, 't1', b1, ['b1-0'])
    const b2 = (okValue(agg.createBranch('t1', null, 'm2', 'B2')).branch as { id: string }).id
    seedSuffix(agg, 't1', b2, ['b2-0'])
    const beforeB1 = routeIds(agg, 't1', b1)
    const beforeB2 = routeIds(agg, 't1', b2)

    const del = deleteResponse(agg, 't1', ['m1', 'm2'], null)
    expect(new Set(del.deletedMessageIds)).toEqual(new Set(['m1', 'm2']))
    expect(persistedAnchor(sqlite, b1)).toBe('m0')
    expect(persistedAnchor(sqlite, b2)).toBe('m0')
    expect(del.boundarySnapshots).toEqual([
      { kind: 'branch', id: b1, anchorMessageId: 'm1', expectedAnchorMessageId: 'm0' },
      { kind: 'branch', id: b2, anchorMessageId: 'm2', expectedAnchorMessageId: 'm0' }
    ])

    okValue(agg.insertMessageGroups('t1', undoGroups(del), null, del.boundarySnapshots))
    expect(persistedAnchor(sqlite, b1)).toBe('m1')
    expect(persistedAnchor(sqlite, b2)).toBe('m2')
    expect(routeIds(agg, 't1', b1)).toEqual(beforeB1)
    expect(routeIds(agg, 't1', b2)).toEqual(beforeB2)
  })

  it('a mid-level anchor delete moves only the descendant boundary and undo restores it', () => {
    seedMain(agg, 't1', ['m0', 'm1'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm1', 'B1')).branch as { id: string }).id
    seedSuffix(agg, 't1', b1, ['b1-0'])
    const b2 = (okValue(agg.createBranch('t1', b1, 'b1-0', 'B2')).branch as { id: string }).id
    seedSuffix(agg, 't1', b2, ['b2-0'])
    const beforeB2 = routeIds(agg, 't1', b2)

    // Owner deletes its own anchor through its own route.
    const del = deleteResponse(agg, 't1', ['b1-0'], b1)
    expect(del.boundarySnapshots).toEqual([
      { kind: 'branch', id: b2, anchorMessageId: 'b1-0', expectedAnchorMessageId: 'm1' }
    ])
    expect(persistedAnchor(sqlite, b2)).toBe('m1')
    expect(routeIds(agg, 't1', b2)).toEqual(['m0', 'm1', 'b2-0'])

    okValue(agg.insertMessageGroups('t1', undoGroups(del), b1, del.boundarySnapshots))
    expect(persistedAnchor(sqlite, b2)).toBe('b1-0')
    expect(routeIds(agg, 't1', b2)).toEqual(beforeB2)
  })

  it('deleting the whole prefix then undoing keeps the branch accessible and re-composes its inheritance', () => {
    seedMain(agg, 't1', ['m0'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm0', 'B1')).branch as { id: string }).id
    seedSuffix(agg, 't1', b1, ['c0'])

    const del = deleteResponse(agg, 't1', ['m0'], null)
    // No survivor precedes the anchor: nothing to move, nothing to restore.
    expect(del.boundarySnapshots).toEqual([])
    expect(routeIds(agg, 't1', b1)).toEqual(['c0'])

    const undoAck = okValue(agg.insertMessageGroups('t1', undoGroups(del), null, del.boundarySnapshots))
    expect(undoAck.boundaryRestores).toEqual([])
    expect(routeIds(agg, 't1', b1)).toEqual(['m0', 'c0'])
    expect(persistedAnchor(sqlite, b1)).toBe('m0')
  })

  it('undo never recreates a branch object the user deleted since the delete', () => {
    seedMain(agg, 't1', ['m0', 'm1'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm1', 'B1')).branch as { id: string }).id
    seedSuffix(agg, 't1', b1, ['c0'])
    const del = deleteResponse(agg, 't1', ['m1'], null)
    okValue(agg.deleteBranch('t1', b1))
    expect(hasBranchRow(sqlite, b1)).toBe(false)

    const undoAck = okValue(agg.insertMessageGroups('t1', undoGroups(del), null, del.boundarySnapshots))
    expect(undoAck.boundaryRestores).toEqual([
      { kind: 'branch', id: b1, anchorMessageId: 'm1', restored: false, skipReason: 'missing' }
    ])
    // The message comes back; the deleted branch object does not.
    expect(routeIds(agg, 't1', null)).toEqual(['m0', 'm1'])
    expect(hasBranchRow(sqlite, b1)).toBe(false)
  })

  it('undo never overwrites a boundary another operation moved further back', () => {
    seedMain(agg, 't1', ['m0', 'm1', 'm2'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm2', 'B1')).branch as { id: string }).id
    seedSuffix(agg, 't1', b1, ['c0'])
    const del = deleteResponse(agg, 't1', ['m2'], null)
    expect(persistedAnchor(sqlite, b1)).toBe('m1')

    // Unrelated later delete of the new boundary moves it further back.
    const later = deleteResponse(agg, 't1', ['m1'], null)
    expect(later.boundarySnapshots).toEqual([
      { kind: 'branch', id: b1, anchorMessageId: 'm1', expectedAnchorMessageId: 'm0' }
    ])
    expect(persistedAnchor(sqlite, b1)).toBe('m0')

    // The stale snapshot must not resurrect the older anchor.
    const undoAck = okValue(agg.insertMessageGroups('t1', undoGroups(del), null, del.boundarySnapshots))
    expect(undoAck.boundaryRestores).toEqual([
      { kind: 'branch', id: b1, anchorMessageId: 'm2', restored: false, skipReason: 'changed' }
    ])
    expect(persistedAnchor(sqlite, b1)).toBe('m0')
    expect(routeIds(agg, 't1', b1)).toEqual(['m0', 'c0'])
  })

  it('a boundary restore cannot target a message the command does not re-insert', () => {
    seedMain(agg, 't1', ['m0', 'm1', 'm2'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm2', 'B1')).branch as { id: string }).id
    seedSuffix(agg, 't1', b1, ['c0'])
    const del = deleteResponse(agg, 't1', ['m2'], null)

    // Ordinary insertion of unrelated rows plus a forged restore of m2.
    const forged = okValue(
      agg.insertMessageGroups(
        't1',
        [
          {
            entries: [{ message: msgJson('x0', 't1') as never, blocks: [blockJson('b-x0', 'x0') as never] }],
            intent: { kind: 'topic-tail' }
          }
        ],
        null,
        [{ kind: 'branch', id: b1, anchorMessageId: 'm2', expectedAnchorMessageId: 'm1' }]
      )
    )
    expect(forged.boundaryRestores).toEqual([
      { kind: 'branch', id: b1, anchorMessageId: 'm2', restored: false, skipReason: 'changed' }
    ])
    expect(persistedAnchor(sqlite, b1)).toBe('m1')
    expect(del.deletedMessageIds).toEqual(['m2'])
  })

  it('undo restores a nested reference chain whose endpoint rows belong to an ancestor topic', () => {
    // A owns the rows; B references A; C references B through a row A owns.
    // Deleting that row in A moves the A-branch anchor and BOTH reference
    // endpoints, so A's undo has to restore boundaries of relations whose
    // source route is B — the case that used to reject the whole transaction.
    seedMain(agg, 'A', ['a0', 'a1', 'a2'])
    const branchA = (okValue(agg.createBranch('A', null, 'a2', 'BA')).branch as { id: string }).id
    seedSuffix(agg, 'A', branchA, ['ba-0'])
    okValue(agg.createReferencedTopic('A', null, 'B', 'a2'))
    okValue(agg.createReferencedTopic('B', null, 'C', 'a2'))
    expect(agg.appendMessage('C', msgJson('c0', 'C') as never, [blockJson('b-c0', 'c0') as never]).ok).toBe(true)

    const beforeB = routeIds(agg, 'B', null)
    const beforeC = routeIds(agg, 'C', null)
    expect(beforeB).toEqual(['a0', 'a1', 'a2'])
    expect(beforeC).toEqual(['a0', 'a1', 'a2', 'c0'])

    const del = deleteResponse(agg, 'A', ['a2'], null)
    expect(del.deletedMessageIds).toEqual(['a2'])
    // Multi-level: same-topic branch plus both nested reference endpoints.
    expect(del.boundarySnapshots).toEqual([
      { kind: 'branch', id: branchA, anchorMessageId: 'a2', expectedAnchorMessageId: 'a1' },
      { kind: 'reference', id: 'B', anchorMessageId: 'a2', expectedAnchorMessageId: 'a1' },
      { kind: 'reference', id: 'C', anchorMessageId: 'a2', expectedAnchorMessageId: 'a1' }
    ])
    expect(persistedAnchor(sqlite, branchA)).toBe('a1')
    expect(persistedReferenceAnchor(sqlite, 'B')).toBe('a1')
    expect(persistedReferenceAnchor(sqlite, 'C')).toBe('a1')
    expect(routeIds(agg, 'C', null)).toEqual(['a0', 'a1', 'c0'])

    // Undo in ONE transaction: no rejection for the C endpoint whose source
    // route is B (an ancestor of A's row is on B's route).
    const undoAck = okValue(agg.insertMessageGroups('A', undoGroups(del), null, del.boundarySnapshots))
    expect(undoAck.insertedMessageIds).toEqual(['a2'])
    expect(undoAck.boundaryRestores).toEqual([
      { kind: 'branch', id: branchA, anchorMessageId: 'a2', restored: true },
      { kind: 'reference', id: 'B', anchorMessageId: 'a2', restored: true },
      { kind: 'reference', id: 'C', anchorMessageId: 'a2', restored: true }
    ])
    expect(persistedAnchor(sqlite, branchA)).toBe('a2')
    expect(persistedReferenceAnchor(sqlite, 'B')).toBe('a2')
    expect(persistedReferenceAnchor(sqlite, 'C')).toBe('a2')
    expect(routeIds(agg, 'A', branchA)).toEqual(['a0', 'a1', 'a2', 'ba-0'])
    expect(routeIds(agg, 'B', null)).toEqual(beforeB)
    expect(routeIds(agg, 'C', null)).toEqual(beforeC)

    // Redo re-applies the same multi-level advance, and undo restores it again.
    const redo = deleteResponse(agg, 'A', ['a2'], null)
    expect(redo.boundarySnapshots).toEqual(del.boundarySnapshots)
    expect(persistedReferenceAnchor(sqlite, 'C')).toBe('a1')
    expect(routeIds(agg, 'C', null)).toEqual(['a0', 'a1', 'c0'])
    okValue(agg.insertMessageGroups('A', undoGroups(redo), null, redo.boundarySnapshots))
    expect(persistedReferenceAnchor(sqlite, 'C')).toBe('a2')
    expect(routeIds(agg, 'C', null)).toEqual(beforeC)
  })

  it('a restore addressed onto a route the relation does not compose is skipped, never written', () => {
    // Same nested shape, but the undo inserts the row onto a route outside the
    // reference source routes: sovereignty forbids repairing those endpoints.
    seedMain(agg, 'A', ['a0', 'a1', 'a2'])
    const branchA = (okValue(agg.createBranch('A', null, 'a2', 'BA')).branch as { id: string }).id
    seedSuffix(agg, 'A', branchA, ['ba-0'])
    okValue(agg.createReferencedTopic('A', null, 'B', 'a2'))
    okValue(agg.createReferencedTopic('B', null, 'C', 'a2'))

    const del = deleteResponse(agg, 'A', ['a2'], null)
    expect(persistedReferenceAnchor(sqlite, 'C')).toBe('a1')

    const wrongRoute = okValue(agg.insertMessageGroups('A', undoGroups(del), branchA, del.boundarySnapshots))
    expect(wrongRoute.boundaryRestores).toEqual([
      { kind: 'branch', id: branchA, anchorMessageId: 'a2', restored: false, skipReason: 'changed' },
      { kind: 'reference', id: 'B', anchorMessageId: 'a2', restored: false, skipReason: 'changed' },
      { kind: 'reference', id: 'C', anchorMessageId: 'a2', restored: false, skipReason: 'changed' }
    ])
    expect(persistedAnchor(sqlite, branchA)).toBe('a1')
    expect(persistedReferenceAnchor(sqlite, 'B')).toBe('a1')
    expect(persistedReferenceAnchor(sqlite, 'C')).toBe('a1')
  })
})
