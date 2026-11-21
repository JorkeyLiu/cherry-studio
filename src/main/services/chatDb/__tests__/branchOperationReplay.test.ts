/**
 * replayBranchOperation — operation-scoped reversible branch authority.
 *
 * Every branch lifecycle operation (create / rename / move / delete) returns
 * its own authority snapshot; replaying it back to Main in one direction must
 * restore exactly that operation's before/after state with the SAME identities,
 * ordering, ownership, ancestry, segments and boundaries. All guards are
 * evaluated inside the single write transaction, so a changed reality fails
 * closed with zero writes.
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

const configStore = new Map<string, unknown>()
vi.mock('@main/services/ConfigManager', () => ({
  configManager: {
    get: (k: string, def?: unknown) => (configStore.has(k) ? configStore.get(k) : def),
    set: (k: string, v: unknown) => configStore.set(k, v),
    has: (k: string) => configStore.has(k)
  },
  ConfigKeys: {}
}))

import { isSuccess, validateChatDbResult } from '@shared/chatDb'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { runMigrations } from '../migration'
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-replay-'))
}
function rmrf(dir: string): void {
  realFs.rmSync(dir, { recursive: true, force: true })
}
function openFileDb(): { sqlite: Database.Database; db: BetterSQLite3Database<typeof schema>; dir: string } {
  const dir = makeTempDir()
  const sqlite = new Database(realPath.join(dir, 'chat.db'))
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('synchronous = NORMAL')
  sqlite.pragma('busy_timeout = 5000')
  const db = drizzle(sqlite, { schema })
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
function blockJson(id: string, messageId: string, overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    messageId,
    type: 'main_text',
    content: `block-${id}`,
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}
function appendTurn(agg: ChatDbAggregateService, topicId: string, turn: string, branchId: string | null = null): void {
  const userId = `u${turn}`
  const assistantId = `a${turn}`
  const options = branchId === null ? undefined : { branchId }
  expect(
    agg.appendMessage(
      topicId,
      msgJson(userId, topicId) as never,
      [blockJson(`b-${userId}`, userId) as never],
      undefined,
      undefined,
      options
    ).ok
  ).toBe(true)
  expect(
    agg.appendMessage(
      topicId,
      msgJson(assistantId, topicId, { role: 'assistant', askId: userId }) as never,
      [blockJson(`b-${assistantId}`, assistantId) as never],
      undefined,
      undefined,
      options
    ).ok
  ).toBe(true)
}
function seedABCD(agg: ChatDbAggregateService, topicId: string): void {
  expect(agg.ensureTopic(topicId, 'assistant-1', `topic-${topicId}`).ok).toBe(true)
  for (const turn of ['A', 'B', 'C', 'D']) appendTurn(agg, topicId, turn)
}
function effIds(agg: ChatDbAggregateService, topicId: string, branch: string | null): string[] {
  return okValue(agg.fetchMessages(topicId, branch)).messages.map((m) => (m as { id: string }).id)
}
function ownerOf(sqlite: Database.Database, id: string): string | null {
  const row = sqlite.prepare('SELECT branch_id AS branchId FROM messages WHERE id=?').get(id) as {
    branchId: string | null
  }
  return row.branchId ?? null
}
function branchRow(
  sqlite: Database.Database,
  id: string
): { parentBranchId: string | null; anchorMessageId: string; name: string | null } | undefined {
  return sqlite
    .prepare(
      'SELECT parent_branch_id AS parentBranchId, anchor_message_id AS anchorMessageId, name FROM topic_branches WHERE id=?'
    )
    .get(id) as { parentBranchId: string | null; anchorMessageId: string; name: string | null } | undefined
}
function countRows(sqlite: Database.Database, table: string): number {
  const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  return row.n
}
function denseOrders(sqlite: Database.Database, topicId: string, branchId: string | null): number[] {
  const rows =
    branchId === null
      ? (sqlite
          .prepare(
            'SELECT sort_order AS o FROM messages WHERE topic_id=? AND branch_id IS NULL ORDER BY sort_order ASC'
          )
          .all(topicId) as { o: number }[])
      : (sqlite
          .prepare('SELECT sort_order AS o FROM messages WHERE topic_id=? AND branch_id=? ORDER BY sort_order ASC')
          .all(topicId, branchId) as { o: number }[])
  return rows.map((r) => r.o)
}

function segmentMembers(sqlite: Database.Database, segmentId: string): string[] {
  return (
    sqlite
      .prepare('SELECT message_id AS id FROM topic_segment_messages WHERE segment_id=? ORDER BY sort_order ASC')
      .all(segmentId) as { id: string }[]
  ).map((row) => row.id)
}

describe('replayBranchOperation', () => {
  let sqlite: Database.Database
  let db: BetterSQLite3Database<typeof schema>
  let agg: ChatDbAggregateService
  let dir: string

  beforeEach(() => {
    const opened = openFileDb()
    sqlite = opened.sqlite
    db = opened.db
    dir = opened.dir
    runMigrations(db, sqlite)
    agg = new ChatDbAggregateService(db, sqlite)
  })
  afterEach(() => {
    try {
      sqlite.close()
    } catch {}
    rmrf(dir)
  })

  it('replays a creation both ways with the same branch identity', () => {
    seedABCD(agg, 't1')
    const created = okValue(agg.createBranch('t1', null, 'aB', 'Fork')).branch
    const statedIds = okValue(agg.listBranches('t1')).branches.map((b) => b.id)
    expect(statedIds).toContain(created.id)
    const snapshot = {
      kind: 'create' as const,
      branch: {
        id: created.id,
        parentBranchId: created.parentBranchId,
        anchorMessageId: created.anchorMessageId,
        name: created.name,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        overflow: {}
      }
    }

    const undone = okValue(agg.replayBranchOperation('t1', 'undo', snapshot))
    expect(undone.branchIds).toEqual([created.id])
    expect(okValue(agg.listBranches('t1')).branches.map((b) => b.id)).not.toContain(created.id)

    const redone = okValue(agg.replayBranchOperation('t1', 'redo', snapshot))
    expect(redone.branchIds).toEqual([created.id])
    const restored = branchRow(sqlite, created.id)
    expect(restored).toEqual({
      parentBranchId: created.parentBranchId,
      anchorMessageId: created.anchorMessageId,
      name: 'Fork'
    })

    // Undo is repeatable from the replayed after-state (no drift).
    okValue(agg.replayBranchOperation('t1', 'undo', snapshot))
    expect(branchRow(sqlite, created.id)).toBeUndefined()
    okValue(agg.replayBranchOperation('t1', 'redo', snapshot))
    expect(branchRow(sqlite, created.id)).toBeDefined()
  })

  it('refuses to undo a creation whose branch now owns user work (zero writes)', () => {
    seedABCD(agg, 't1')
    const created = okValue(agg.createBranch('t1', null, 'aB', 'Fork')).branch
    appendTurn(agg, 't1', 'E', created.id)
    const snapshot = {
      kind: 'create' as const,
      branch: {
        id: created.id,
        parentBranchId: created.parentBranchId,
        anchorMessageId: created.anchorMessageId,
        name: created.name,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        overflow: {}
      }
    }
    const before = countRows(sqlite, 'messages')
    const res = agg.replayBranchOperation('t1', 'undo', snapshot)
    expect(res.ok).toBe(false)
    expect(countRows(sqlite, 'messages')).toBe(before)
    expect(branchRow(sqlite, created.id)).toBeDefined()
    expect(ownerOf(sqlite, 'uE')).toBe(created.id)
  })

  it('replays a rename both ways and rejects a stale compare-and-set', () => {
    seedABCD(agg, 't1')
    const created = okValue(agg.createBranch('t1', null, 'aB', 'Before')).branch
    okValue(agg.renameBranch('t1', created.id, 'After'))
    const snapshot = { kind: 'rename' as const, branchId: created.id, beforeName: 'Before', afterName: 'After' }

    okValue(agg.replayBranchOperation('t1', 'undo', snapshot))
    expect(branchRow(sqlite, created.id)?.name).toBe('Before')
    okValue(agg.replayBranchOperation('t1', 'redo', snapshot))
    expect(branchRow(sqlite, created.id)?.name).toBe('After')

    // A newer rename makes the recorded transition unreplayable.
    okValue(agg.renameBranch('t1', created.id, 'Later'))
    const stale = agg.replayBranchOperation('t1', 'undo', snapshot)
    expect(stale.ok).toBe(false)
    expect(branchRow(sqlite, created.id)?.name).toBe('Later')
  })

  it('undoes and redoes a move with an anchor-following descendant subtree', () => {
    seedABCD(agg, 't1')
    // Child anchored INSIDE the turn that will move (aC).
    const follower = okValue(agg.createBranch('t1', null, 'aC', 'Follower')).branch
    appendTurn(agg, 't1', 'E', follower.id)
    // Grandchild under the follower: its own parent must survive the replay.
    const grandchild = okValue(agg.createBranch('t1', follower.id, 'aE', 'Grandchild')).branch

    const moved = okValue(agg.moveSelectedTurnsToNewBranch('t1', null, ['uC'], 'Moved', ['uC', 'aC']))
    const snapshot = moved.historySnapshot
    expect(snapshot.kind).toBe('move')
    expect(snapshot.movedMessageIds).toEqual(['uC', 'aC'])
    expect(snapshot.reparented).toEqual([{ branchId: follower.id, parentBefore: null, parentAfter: moved.branch.id }])
    expect(snapshot.sourceOrderBefore).toEqual(['uA', 'aA', 'uB', 'aB', 'uC', 'aC', 'uD', 'aD'])
    expect(branchRow(sqlite, follower.id)?.parentBranchId).toBe(moved.branch.id)
    expect(branchRow(sqlite, grandchild.id)?.parentBranchId).toBe(follower.id)
    // The descendant's effective route still resolves through its moved anchor.
    expect(effIds(agg, 't1', follower.id)).toEqual(['uA', 'aA', 'uB', 'aB', 'uC', 'aC', 'uE', 'aE'])

    okValue(agg.replayBranchOperation('t1', 'undo', snapshot))
    // Source route owns its rows again, in the recorded order and dense.
    expect(effIds(agg, 't1', null)).toEqual(['uA', 'aA', 'uB', 'aB', 'uC', 'aC', 'uD', 'aD'])
    for (const id of ['uC', 'aC', 'uD', 'aD']) expect(ownerOf(sqlite, id)).toBeNull()
    expect(denseOrders(sqlite, 't1', null)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    // The created branch is gone, the follower is a level-1 branch again.
    expect(branchRow(sqlite, moved.branch.id)).toBeUndefined()
    expect(branchRow(sqlite, follower.id)?.parentBranchId).toBeNull()
    expect(branchRow(sqlite, grandchild.id)?.parentBranchId).toBe(follower.id)
    expect(effIds(agg, 't1', follower.id)).toEqual(['uA', 'aA', 'uB', 'aB', 'uC', 'aC', 'uE', 'aE'])

    okValue(agg.replayBranchOperation('t1', 'redo', snapshot))
    expect(effIds(agg, 't1', null)).toEqual(['uA', 'aA', 'uB', 'aB', 'uD', 'aD'])
    for (const id of ['uC', 'aC']) expect(ownerOf(sqlite, id)).toBe(moved.branch.id)
    expect(denseOrders(sqlite, 't1', moved.branch.id)).toEqual([0, 1])
    expect(branchRow(sqlite, follower.id)?.parentBranchId).toBe(moved.branch.id)
    expect(branchRow(sqlite, grandchild.id)?.parentBranchId).toBe(follower.id)
    expect(effIds(agg, 't1', follower.id)).toEqual(['uA', 'aA', 'uB', 'aB', 'uC', 'aC', 'uE', 'aE'])

    // Undo again after the redo restores the same source state.
    okValue(agg.replayBranchOperation('t1', 'undo', snapshot))
    expect(effIds(agg, 't1', null)).toEqual(['uA', 'aA', 'uB', 'aB', 'uC', 'aC', 'uD', 'aD'])
    expect(branchRow(sqlite, moved.branch.id)).toBeUndefined()
  })

  it('refuses to undo a move after the moved branch gained unrelated work (zero writes)', () => {
    seedABCD(agg, 't1')
    const moved = okValue(agg.moveSelectedTurnsToNewBranch('t1', null, ['uC'], 'Moved', ['uC', 'aC']))
    appendTurn(agg, 't1', 'E', moved.branch.id)
    const snapshot = moved.historySnapshot
    const before = countRows(sqlite, 'messages')
    const res = agg.replayBranchOperation('t1', 'undo', snapshot)
    expect(res.ok).toBe(false)
    expect(countRows(sqlite, 'messages')).toBe(before)
    expect(ownerOf(sqlite, 'uE')).toBe(moved.branch.id)
    expect(ownerOf(sqlite, 'uC')).toBe(moved.branch.id)
    expect(branchRow(sqlite, moved.branch.id)).toBeDefined()
  })

  it('undoes and redoes a subtree delete with segments, blocks, and boundaries', () => {
    seedABCD(agg, 't1')
    const deleted = okValue(agg.createBranch('t1', null, 'aB', 'Doomed')).branch
    appendTurn(agg, 't1', 'E', deleted.id)
    // A segment inside the doomed route: the delete empties (and removes) it,
    // so the undo must re-create it with its recorded membership and head.
    const segment = okValue(
      agg.upsertSegment({
        segmentId: 'seg-1',
        topicId: 't1',
        name: 'Group',
        messageIds: ['uE', 'aE'],
        color: null,
        branchId: deleted.id
      })
    )
    expect(segment.id).toBe('seg-1')

    const result = okValue(agg.deleteBranch('t1', deleted.id))
    // The renderer only ever sees this payload through the IPC layer, which
    // validates the exact wire field set: a snapshot row carrying extra inline
    // keys (the repository mapper spreads decoded `extra` inline too) would be
    // rejected there and never reach history.
    expect(() => validateChatDbResult('chatdb:delete-branch', { ok: true, value: result })).not.toThrow()
    const snapshot = result.historySnapshot
    expect(snapshot.kind).toBe('delete')
    expect(snapshot.rootBranchId).toBe(deleted.id)
    expect(snapshot.branches.map((row) => row.id)).toEqual([deleted.id])
    expect(snapshot.messages.map((row) => row.id).sort()).toEqual(['aE', 'uE'])
    expect(snapshot.blocks.map((row) => row.id).sort()).toEqual(['b-aE', 'b-uE'])
    expect(snapshot.segments.map((row) => row.id)).toEqual(['seg-1'])
    const messageRowsBefore = snapshot.messages.map((row) => ({ ...row }))
    const blockRowsBefore = snapshot.blocks.map((row) => ({ ...row }))
    expect(branchRow(sqlite, deleted.id)).toBeUndefined()
    expect(effIds(agg, 't1', null)).toEqual(['uA', 'aA', 'uB', 'aB', 'uC', 'aC', 'uD', 'aD'])

    const undone = okValue(agg.replayBranchOperation('t1', 'undo', snapshot))
    expect(undone.branchIds).toEqual([deleted.id])
    expect(undone.messageIds.sort()).toEqual(['aE', 'uE'])
    expect(branchRow(sqlite, deleted.id)).toEqual({
      parentBranchId: null,
      anchorMessageId: 'aB',
      name: 'Doomed'
    })
    // Rows come back verbatim (same IDs, owner, dense order, content).
    for (const row of messageRowsBefore) {
      const live = sqlite
        .prepare(
          'SELECT id, topic_id AS topicId, branch_id AS branchId, content, sort_order AS sortOrder FROM messages WHERE id=?'
        )
        .get(row.id) as { id: string; topicId: string; branchId: string | null; content: string; sortOrder: number }
      expect(live).toEqual({
        id: row.id,
        topicId: row.topicId,
        branchId: row.branchId,
        content: row.content,
        sortOrder: row.sortOrder
      })
    }
    for (const row of blockRowsBefore) {
      const live = sqlite
        .prepare('SELECT id, message_id AS messageId, content FROM message_blocks WHERE id=?')
        .get(row.id) as { id: string; messageId: string; content: string } | undefined
      expect(live).toEqual({ id: row.id, messageId: row.messageId, content: row.content })
    }
    // Segment membership/head restored, not just the surviving rows.
    const memberIds = (
      sqlite
        .prepare('SELECT message_id AS id FROM topic_segment_messages WHERE segment_id=? ORDER BY sort_order ASC')
        .all('seg-1') as { id: string }[]
    ).map((r) => r.id)
    expect(memberIds).toEqual(['uE', 'aE'])
    // The restored branch resolves through its unchanged anchor (aB on main)
    // and carries exactly its own messages again.
    expect(effIds(agg, 't1', deleted.id)).toEqual(['uA', 'aA', 'uB', 'aB', 'uE', 'aE'])

    const redone = okValue(agg.replayBranchOperation('t1', 'redo', snapshot))
    expect(redone.branchIds).toEqual([deleted.id])
    expect(branchRow(sqlite, deleted.id)).toBeUndefined()
    expect(sqlite.prepare('SELECT id FROM messages WHERE id=?').get('uE')).toBeUndefined()
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-uE')).toBeUndefined()

    // Undo after redo restores the identical subtree again.
    okValue(agg.replayBranchOperation('t1', 'undo', snapshot))
    expect(branchRow(sqlite, deleted.id)).toBeDefined()
    expect(ownerOf(sqlite, 'uE')).toBe(deleted.id)
  })

  it('refuses to redo a subtree delete whose rows changed since (zero writes)', () => {
    seedABCD(agg, 't1')
    const doomed = okValue(agg.createBranch('t1', null, 'aB', 'Doomed')).branch
    appendTurn(agg, 't1', 'E', doomed.id)
    const result = okValue(agg.deleteBranch('t1', doomed.id))
    const snapshot = result.historySnapshot
    okValue(agg.replayBranchOperation('t1', 'undo', snapshot))
    // Unrelated concurrent work appears in the restored subtree.
    appendTurn(agg, 't1', 'F', doomed.id)

    const res = agg.replayBranchOperation('t1', 'redo', snapshot)
    expect(res.ok).toBe(false)
    expect(branchRow(sqlite, doomed.id)).toBeDefined()
    expect(ownerOf(sqlite, 'uE')).toBe(doomed.id)
    expect(ownerOf(sqlite, 'uF')).toBe(doomed.id)
  })

  it('refuses to restore a touched segment the user has since re-membered, then restores it once the state matches again', () => {
    seedABCD(agg, 't1')
    // A group that spans two routes (a state earlier moves or other paths can
    // leave behind): uC is a member while owned by the branch being deleted.
    const moved = okValue(agg.moveSelectedTurnsToNewBranch('t1', null, ['uC'], 'Moved', ['uC', 'aC']))
    okValue(
      agg.upsertSegment({
        segmentId: 'seg-mix',
        topicId: 't1',
        name: 'Group',
        messageIds: ['uB', 'uD'],
        color: null,
        branchId: null
      })
    )
    sqlite
      .prepare('INSERT INTO topic_segment_messages (segment_id, message_id, sort_order) VALUES (?, ?, ?)')
      .run('seg-mix', 'uC', 2)
    const deleted = okValue(agg.deleteBranch('t1', moved.branch.id))
    const snapshot = deleted.historySnapshot
    expect(snapshot.segments.map((row) => row.memberIds)).toEqual([['uB', 'uD', 'uC']])
    // Main captured the state the delete actually left behind, not a guess.
    expect(snapshot.segmentsAfter.map((row) => ({ id: row.id, exists: row.exists, memberIds: row.memberIds }))).toEqual(
      [{ id: 'seg-mix', exists: true, memberIds: ['uB', 'uD'] }]
    )

    // The user edits the group afterwards: uD leaves it.
    okValue(
      agg.upsertSegment({
        segmentId: 'seg-mix',
        topicId: 't1',
        name: 'Group',
        messageIds: ['uB'],
        color: null,
        branchId: null
      })
    )
    const countsBefore = {
      branches: countRows(sqlite, 'topic_branches'),
      messages: countRows(sqlite, 'messages'),
      blocks: countRows(sqlite, 'message_blocks')
    }
    const stale = agg.replayBranchOperation('t1', 'undo', snapshot)
    expect(stale.ok).toBe(false)
    // Zero writes: the newer group membership wins and the subtree stays gone.
    expect(countRows(sqlite, 'topic_branches')).toBe(countsBefore.branches)
    expect(countRows(sqlite, 'messages')).toBe(countsBefore.messages)
    expect(countRows(sqlite, 'message_blocks')).toBe(countsBefore.blocks)
    expect(segmentMembers(sqlite, 'seg-mix')).toEqual(['uB'])
    expect(branchRow(sqlite, moved.branch.id)).toBeUndefined()

    // Retryable: once the recorded post-delete state holds again the same
    // snapshot replays cleanly.
    okValue(
      agg.upsertSegment({
        segmentId: 'seg-mix',
        topicId: 't1',
        name: 'Group',
        messageIds: ['uB', 'uD'],
        color: null,
        branchId: null
      })
    )
    okValue(agg.replayBranchOperation('t1', 'undo', snapshot))
    expect(segmentMembers(sqlite, 'seg-mix')).toEqual(['uB', 'uD', 'uC'])
    expect(branchRow(sqlite, moved.branch.id)).toBeDefined()
    expect(ownerOf(sqlite, 'uC')).toBe(moved.branch.id)
  })

  it('still undoes a subtree delete when only an untouched segment changed meanwhile', () => {
    seedABCD(agg, 't1')
    okValue(
      agg.upsertSegment({
        segmentId: 'seg-keep',
        topicId: 't1',
        name: 'Keep',
        messageIds: ['uA'],
        color: null,
        branchId: null
      })
    )
    const moved = okValue(agg.moveSelectedTurnsToNewBranch('t1', null, ['uC'], 'Moved', ['uC', 'aC']))
    okValue(
      agg.upsertSegment({
        segmentId: 'seg-mix',
        topicId: 't1',
        name: 'Group',
        messageIds: ['uB', 'uD'],
        color: null,
        branchId: null
      })
    )
    sqlite
      .prepare('INSERT INTO topic_segment_messages (segment_id, message_id, sort_order) VALUES (?, ?, ?)')
      .run('seg-mix', 'uC', 2)
    const deleted = okValue(agg.deleteBranch('t1', moved.branch.id))
    // Unrelated concurrent edit: a segment this delete never touched.
    okValue(
      agg.upsertSegment({
        segmentId: 'seg-keep',
        topicId: 't1',
        name: 'Renamed',
        messageIds: ['uA'],
        color: null,
        branchId: null
      })
    )

    okValue(agg.replayBranchOperation('t1', 'undo', deleted.historySnapshot))

    expect(segmentMembers(sqlite, 'seg-mix')).toEqual(['uB', 'uD', 'uC'])
    expect(branchRow(sqlite, moved.branch.id)).toBeDefined()
    // The newer rename of the untouched segment is not overwritten.
    expect(sqlite.prepare('SELECT name FROM topic_segments WHERE id=?').get('seg-keep')).toEqual({
      name: 'Renamed'
    })
  })

  it('round-trips file references and their metadata through a subtree delete', () => {
    seedABCD(agg, 't1')
    const doomed = okValue(agg.createBranch('t1', null, 'aB', 'Doomed')).branch
    expect(
      agg.appendMessage(
        't1',
        msgJson('uF', 't1') as never,
        [
          blockJson('b-uF', 'uF', {
            type: 'file',
            file: { id: 'file-1', name: 'doc.pdf', path: '/tmp/doc.pdf', type: 'application/pdf' }
          }) as never
        ],
        undefined,
        undefined,
        { branchId: doomed.id }
      ).ok
    ).toBe(true)

    const deleted = okValue(agg.deleteBranch('t1', doomed.id))
    const snapshot = deleted.historySnapshot
    expect(snapshot.fileReferences).toHaveLength(1)
    const recorded = snapshot.fileReferences[0]
    expect(recorded).toMatchObject({
      id: 'fr-b-uF-file-1',
      blockId: 'b-uF',
      fileId: 'file-1',
      fileName: 'doc.pdf',
      filePath: '/tmp/doc.pdf',
      fileType: 'application/pdf',
      count: 1
    })
    expect(sqlite.prepare('SELECT id FROM file_references WHERE block_id=?').get('b-uF')).toBeUndefined()

    okValue(agg.replayBranchOperation('t1', 'undo', snapshot))
    const restored = sqlite
      .prepare(
        'SELECT id, block_id AS blockId, file_id AS fileId, file_name AS fileName, file_path AS filePath, file_type AS fileType, count FROM file_references WHERE id=?'
      )
      .get(recorded.id)
    expect(restored).toEqual({
      id: recorded.id,
      blockId: recorded.blockId,
      fileId: recorded.fileId,
      fileName: recorded.fileName,
      filePath: recorded.filePath,
      fileType: recorded.fileType,
      count: recorded.count
    })

    okValue(agg.replayBranchOperation('t1', 'redo', snapshot))
    expect(sqlite.prepare('SELECT id FROM file_references WHERE id=?').get(recorded.id)).toBeUndefined()
  })

  it('rejects a delete snapshot whose block belongs to a message this delete did not remove (zero writes)', () => {
    seedABCD(agg, 't1')
    const doomed = okValue(agg.createBranch('t1', null, 'aB', 'Doomed')).branch
    appendTurn(agg, 't1', 'E', doomed.id)
    const snapshot = okValue(agg.deleteBranch('t1', doomed.id)).historySnapshot
    // uA survives on the main route: a block aimed at it is not part of this
    // operation and must never be inserted.
    const malformed = {
      ...snapshot,
      blocks: snapshot.blocks.map((row) => (row.messageId === 'uE' ? { ...row, messageId: 'uA' } : row))
    }
    const countsBefore = {
      branches: countRows(sqlite, 'topic_branches'),
      messages: countRows(sqlite, 'messages'),
      blocks: countRows(sqlite, 'message_blocks')
    }

    const res = agg.replayBranchOperation('t1', 'undo', malformed)

    expect(res.ok).toBe(false)
    expect(countRows(sqlite, 'topic_branches')).toBe(countsBefore.branches)
    expect(countRows(sqlite, 'messages')).toBe(countsBefore.messages)
    expect(countRows(sqlite, 'message_blocks')).toBe(countsBefore.blocks)
    expect(branchRow(sqlite, doomed.id)).toBeUndefined()
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE message_id=?').all('uA')).toEqual([{ id: 'b-uA' }])
  })

  it('rejects a delete snapshot whose file reference points at another topic block (zero writes)', () => {
    seedABCD(agg, 't1')
    const doomed = okValue(agg.createBranch('t1', null, 'aB', 'Doomed')).branch
    expect(
      agg.appendMessage(
        't1',
        msgJson('uF', 't1') as never,
        [
          blockJson('b-uF', 'uF', {
            type: 'file',
            file: { id: 'file-1', name: 'doc.pdf', path: '/tmp/doc.pdf', type: 'application/pdf' }
          }) as never
        ],
        undefined,
        undefined,
        { branchId: doomed.id }
      ).ok
    ).toBe(true)
    // A foreign topic holding its own file block: the snapshot must not be able
    // to attach a reference there.
    expect(
      agg.appendMessage('t2', msgJson('x1', 't2') as never, [
        blockJson('b-x1', 'x1', {
          type: 'file',
          file: { id: 'file-x', name: 'other.pdf', path: '/tmp/other.pdf', type: 'application/pdf' }
        }) as never
      ]).ok
    ).toBe(true)
    const snapshot = okValue(agg.deleteBranch('t1', doomed.id)).historySnapshot
    const malformed = {
      ...snapshot,
      fileReferences: snapshot.fileReferences.map((row) => ({ ...row, blockId: 'b-x1' }))
    }
    const refsBefore = sqlite.prepare('SELECT id, block_id AS blockId FROM file_references ORDER BY id').all()
    const blocksBefore = countRows(sqlite, 'message_blocks')

    const res = agg.replayBranchOperation('t1', 'undo', malformed)

    expect(res.ok).toBe(false)
    expect(sqlite.prepare('SELECT id, block_id AS blockId FROM file_references ORDER BY id').all()).toEqual(refsBefore)
    expect(branchRow(sqlite, doomed.id)).toBeUndefined()
    expect(countRows(sqlite, 'message_blocks')).toBe(blocksBefore)
  })

  it('rejects a delete snapshot whose message is owned by a surviving branch (zero writes)', () => {
    seedABCD(agg, 't1')
    const keeper = okValue(agg.createBranch('t1', null, 'aA', 'Keeper')).branch
    const doomed = okValue(agg.createBranch('t1', null, 'aB', 'Doomed')).branch
    appendTurn(agg, 't1', 'E', doomed.id)
    const snapshot = okValue(agg.deleteBranch('t1', doomed.id)).historySnapshot
    const malformed = {
      ...snapshot,
      messages: snapshot.messages.map((row) => ({ ...row, branchId: keeper.id }))
    }

    const res = agg.replayBranchOperation('t1', 'undo', malformed)

    expect(res.ok).toBe(false)
    expect(branchRow(sqlite, doomed.id)).toBeUndefined()
    expect(sqlite.prepare('SELECT id FROM messages WHERE id=?').get('uE')).toBeUndefined()
    expect(okValue(agg.listBranches('t1')).branches.map((branch) => branch.id)).toEqual([keeper.id])
  })

  it('rejects an unsupported kind and a missing topic without touching the database', () => {
    seedABCD(agg, 't1')
    const before = countRows(sqlite, 'topic_branches')
    expect(agg.replayBranchOperation('t1', 'undo', { kind: 'nope' } as never).ok).toBe(false)
    expect(countRows(sqlite, 'topic_branches')).toBe(before)
    expect(agg.replayBranchOperation('missing-topic', 'undo', { kind: 'nope' } as never).ok).toBe(false)
  })
})
