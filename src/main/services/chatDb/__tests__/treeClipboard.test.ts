/**
 * Tree-preserving clipboard (opt-in "include child branches").
 *
 * Backend business matrix for the three tree capabilities:
 * - `fetchClipboardTree`    — bounded Main authority read of one closure
 * - `pasteClipboardTree`    — ONE transaction: target insert (+ source removal
 *                             for `cut`) with independently generated IDs
 * - `replayClipboardTree`   — ONE transaction undo/redo of that snapshot
 *
 * The assertions are about REAL authority rows (SQLite): which rows exist after
 * a paste, which rows disappeared from the source on a cut, and that a restore
 * puts the exact former rows back at their former positions. Every fail-closed
 * case also proves zero writes.
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

import type {
  ClipboardTreeIdMapRow,
  ClipboardTreePayload,
  ClipboardTreeSnapshot,
  InsertMessageGroupIntent,
  PasteClipboardTreeResponse
} from '@shared/chatDb'
import { isSuccess } from '@shared/chatDb'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { runMigrations } from '../migration'
import { MAX_BRANCH_DEPTH } from '../repository'
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-tree-clipboard-'))
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
function fileJson(id: string, messageId: string, fileId: string): Record<string, unknown> {
  return blockJson(id, messageId, {
    type: 'file',
    content: '',
    file: { id: fileId, name: `${fileId}.txt`, path: `/tmp/${fileId}.txt`, type: 'text' }
  })
}
/** Append one complete turn (user + assistant with askId) to one route owner. */
function appendTurn(
  agg: ChatDbAggregateService,
  topicId: string,
  turn: string,
  branchId: string | null = null,
  extraAssistantBlocks: Record<string, unknown>[] = []
): void {
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
      [blockJson(`b-${assistantId}`, assistantId) as never, ...(extraAssistantBlocks as never[])],
      undefined,
      undefined,
      options
    ).ok
  ).toBe(true)
}
function seedTopic(agg: ChatDbAggregateService, topicId: string, turns: string[]): void {
  expect(agg.ensureTopic(topicId, 'assistant-1', `topic-${topicId}`).ok).toBe(true)
  for (const turn of turns) appendTurn(agg, topicId, turn)
}
function ownerOf(sqlite: Database.Database, id: string): string | null {
  const row = sqlite.prepare('SELECT branch_id AS branchId FROM messages WHERE id=?').get(id) as
    | { branchId: string | null }
    | undefined
  return row === undefined ? null : (row.branchId ?? null)
}
function contentOf(sqlite: Database.Database, id: string): string | null {
  const row = sqlite.prepare('SELECT content FROM messages WHERE id=?').get(id) as
    | { content: string | null }
    | undefined
  return row === undefined ? null : row.content
}
function askIdOf(sqlite: Database.Database, id: string): string | null {
  const row = sqlite.prepare('SELECT ask_id AS askId FROM messages WHERE id=?').get(id) as
    | { askId: string | null }
    | undefined
  return row === undefined ? null : (row.askId ?? null)
}
function messageIdsOf(sqlite: Database.Database, topicId: string, branchId: string | null): string[] {
  const rows =
    branchId === null
      ? (sqlite
          .prepare('SELECT id FROM messages WHERE topic_id=? AND branch_id IS NULL ORDER BY sort_order ASC')
          .all(topicId) as { id: string }[])
      : (sqlite
          .prepare('SELECT id FROM messages WHERE topic_id=? AND branch_id=? ORDER BY sort_order ASC')
          .all(topicId, branchId) as { id: string }[])
  return rows.map((row) => row.id)
}
function countRows(sqlite: Database.Database, table: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}
function countIn(table: string, sqlite: Database.Database, topicId: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE topic_id=?`).get(topicId) as { n: number }).n
}
function segmentMembers(sqlite: Database.Database, segmentId: string): string[] {
  return (
    sqlite
      .prepare('SELECT message_id AS id FROM topic_segment_messages WHERE segment_id=? ORDER BY sort_order ASC')
      .all(segmentId) as { id: string }[]
  ).map((row) => row.id)
}
function mapId(idMap: ClipboardTreeIdMapRow[], kind: ClipboardTreeIdMapRow['kind'], sourceId: string): string {
  const row = idMap.find((entry) => entry.kind === kind && entry.sourceId === sourceId)
  if (!row) throw new Error(`No ${kind} mapping for ${sourceId}`)
  return row.targetId
}

const TOPIC_TAIL = { kind: 'topic-tail' } as const

describe('tree-preserving clipboard', () => {
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

  /**
   * Source fixture: main route A..D, child branch F1 anchored at the assistant
   * row of A owning its own turn E + nested child F2 (anchored at uE), and a
   * sibling branch F3 anchored at a row of C (so selecting group A must never
   * pull F3 in).
   */
  function seedTreeSource(): { f1: string; f2: string; f3: string } {
    seedTopic(agg, 't1', ['A', 'B', 'C', 'D'])
    const f1 = okValue(agg.createBranch('t1', null, 'aA', 'Fork-1')).branch.id
    appendTurn(agg, 't1', 'E', f1)
    const f2 = okValue(agg.createBranch('t1', f1, 'uE', 'Fork-2')).branch.id
    appendTurn(agg, 't1', 'G', f2)
    const f3 = okValue(agg.createBranch('t1', null, 'aC', 'Fork-3')).branch.id
    appendTurn(agg, 't1', 'H', f3)
    return { f1, f2, f3 }
  }

  it('reads the complete closure of one selected group plus its anchored child branches', () => {
    const { f1, f2, f3 } = seedTreeSource()
    const response = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] }))
    expect(response.clipboard.completeness).toBe('clipboard-tree')
    expect(response.clipboard.returnedCount).toBe(1)
    expect(response.clipboard.ownedRootMessageIds).toEqual(['uA', 'aA'])
    expect(response.clipboard.inheritedRootMessageIds).toEqual([])
    // Roots + F1's own turn + F2's own turn: complete authority rows, never a
    // window-derived projection.
    expect(response.clipboard.returnedMessageCount).toBe(6)
    expect(response.tree.branches.map((branch) => branch.sourceBranchId)).toEqual([f1, f2])
    expect(response.tree.branches[0]).toMatchObject({ parentSourceBranchId: null, anchorMessageId: 'aA', depth: 1 })
    expect(response.tree.branches[1]).toMatchObject({ parentSourceBranchId: f1, anchorMessageId: 'uE', depth: 2 })
    expect(response.tree.branches.map((branch) => branch.sourceBranchId)).not.toContain(f3)
    expect(response.clipboard.firstMessageId).toBe('uA')
    expect(response.clipboard.lastMessageId).toBe('aG')
  })

  it('copies a nested tree into another topic with fresh ids, remapped refs and no prefix bleed', () => {
    const { f1, f2 } = seedTreeSource()
    seedTopic(agg, 't2', [])
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    const pasted = okValue(
      agg.pasteClipboardTree({
        mode: 'copy',
        payload: tree,
        target: { topicId: 't2', branchId: null, intent: TOPIC_TAIL }
      })
    )
    expect(pasted.mode).toBe('copy')
    expect(pasted.snapshot.sourceRemoved).toBeNull()
    expect(pasted.insertedRootMessageIds).toHaveLength(2)
    expect(pasted.insertedBranchIds).toHaveLength(2)
    // Source untouched.
    expect(messageIdsOf(sqlite, 't1', null)).toEqual(['uA', 'aA', 'uB', 'aB', 'uC', 'aC', 'uD', 'aD'])
    expect(messageIdsOf(sqlite, 't1', f1)).toEqual(['uE', 'aE'])

    const newUserA = mapId(pasted.idMap, 'message', 'uA')
    const newAssistantA = mapId(pasted.idMap, 'message', 'aA')
    const newF1 = mapId(pasted.idMap, 'branch', f1)
    const newF2 = mapId(pasted.idMap, 'branch', f2)
    const newUE = mapId(pasted.idMap, 'message', 'uE')
    expect(newUserA).not.toBe('uA')
    // Root run lands on the target main route, in authority order.
    expect(messageIdsOf(sqlite, 't2', null)).toEqual([newUserA, newAssistantA])
    expect(contentOf(sqlite, newUserA)).toBe('content-uA')
    expect(contentOf(sqlite, newAssistantA)).toBe('content-aA')
    // askId is remapped to the copied user row (never a dangling cross-topic id).
    expect(askIdOf(sqlite, newAssistantA)).toBe(newUserA)
    // Branch-owned rows follow their generated branch, not the target route.
    expect(ownerOf(sqlite, newUE)).toBe(newF1)
    expect(messageIdsOf(sqlite, 't2', newF1)).toEqual([newUE, mapId(pasted.idMap, 'message', 'aE')])
    const branches = okValue(agg.listBranches('t2')).branches
    expect(branches.map((branch) => branch.id).sort()).toEqual([newF1, newF2].sort())
    expect(branches.find((branch) => branch.id === newF1)).toMatchObject({
      parentBranchId: null,
      anchorMessageId: newAssistantA,
      name: 'Fork-1'
    })
    expect(branches.find((branch) => branch.id === newF2)).toMatchObject({
      parentBranchId: newF1,
      anchorMessageId: newUE,
      name: 'Fork-2'
    })
    // No unrelated prefix/sibling content is materialized.
    const targetContents = (
      sqlite.prepare('SELECT content FROM messages WHERE topic_id=?').all('t2') as {
        content: string | null
      }[]
    ).map((row) => row.content)
    expect(targetContents.sort()).toEqual([
      'content-aA',
      'content-aE',
      'content-aG',
      'content-uA',
      'content-uE',
      'content-uG'
    ])
    // Per-owner orders stay dense.
    expect(messageIdsOf(sqlite, 't2', newF2)).toHaveLength(2)
  })

  it('returns transaction-scoped route projection deltas a renderer commits in place', () => {
    seedTreeSource()
    seedTopic(agg, 't2', ['Z'])
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    const targetTail = messageIdsOf(sqlite, 't2', null).at(-1)

    const copied = okValue(
      agg.pasteClipboardTree({
        mode: 'copy',
        payload: tree,
        target: { topicId: 't2', branchId: null, intent: TOPIC_TAIL }
      })
    )

    // COPY: the only route this transaction wrote into carries the placed run.
    expect(copied.projections).toHaveLength(1)
    const [target] = copied.projections
    expect(target.topicId).toBe('t2')
    expect(target.branchId).toBeNull()
    expect(target.removedMessageIds).toEqual([])
    expect(target.insertedRuns).toHaveLength(1)
    expect(target.insertedRuns[0].messageIds).toEqual(copied.insertedRootMessageIds)
    // Placement is expressed by the stable neighbours, never a numeric index.
    expect(target.insertedRuns[0].beforeMessageId).toBe(targetTail)
    expect(target.insertedRuns[0].nextMessageId).toBeNull()
    // Canonical rows and blocks of exactly that run, ownership resolved by Main.
    expect(target.messages.map((wire) => (wire as { id: string }).id)).toEqual(copied.insertedRootMessageIds)
    expect(target.mutableMessageIds.slice().sort()).toEqual(copied.insertedRootMessageIds.slice().sort())
    const runIds = new Set(copied.insertedRootMessageIds)
    expect(target.blocks.length).toBeGreaterThan(0)
    for (const block of target.blocks) {
      expect(runIds.has((block as { messageId: string }).messageId)).toBe(true)
    }
  })

  it('scopes cut removal projections to the routes that actually owned the rows', () => {
    const { f1, f2 } = seedTreeSource()
    seedTopic(agg, 't2', [])
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree

    const cut = okValue(
      agg.pasteClipboardTree({
        mode: 'cut',
        payload: tree,
        target: { topicId: 't2', branchId: null, intent: TOPIC_TAIL }
      })
    )

    const byOwner = (topicId: string, branchId: string | null) =>
      cut.projections.find((p) => p.topicId === topicId && p.branchId === branchId)
    // Source rows are reported per OWNER route, so a consumer displaying a
    // descendant intersects only the rows authority no longer has.
    expect(byOwner('t1', null)?.removedMessageIds.slice().sort()).toEqual(['aA', 'uA'])
    expect(byOwner('t1', f1)?.removedMessageIds.slice().sort()).toEqual(['aE', 'uE'])
    expect(byOwner('t1', f2)?.removedMessageIds.slice().sort()).toEqual(['aG', 'uG'])
    // A removal delta never claims capability or rows to insert.
    for (const delta of cut.projections.filter((p) => p.topicId === 't1')) {
      expect(delta.insertedRuns).toEqual([])
      expect(delta.mutableMessageIds).toEqual([])
    }
    // The target still gets its own insert delta in the same transaction.
    expect(byOwner('t2', null)?.insertedRuns[0].messageIds).toEqual(cut.insertedRootMessageIds)
  })

  it('copies an inherited root but refuses to cut one', () => {
    const { f1 } = seedTreeSource()
    seedTopic(agg, 't2', [])
    // Through F1 the A turn is inherited (owned by the main route).
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: f1, groupIds: ['uA'] })).tree
    expect(tree.roots[0].messageIds).toEqual(['uA', 'aA'])
    const copied = okValue(
      agg.pasteClipboardTree({
        mode: 'copy',
        payload: tree,
        target: { topicId: 't2', branchId: null, intent: TOPIC_TAIL }
      })
    )
    expect(copied.insertedRootMessageIds).toHaveLength(2)

    const before = countRows(sqlite, 'messages')
    const cut = agg.pasteClipboardTree({
      mode: 'cut',
      payload: tree,
      target: { topicId: 't2', branchId: null, intent: TOPIC_TAIL }
    })
    expect(cut.ok).toBe(false)
    expect(countRows(sqlite, 'messages')).toBe(before)
    expect(contentOf(sqlite, 'uA')).toBe('content-uA')
  })

  it('fails a cut closed when the captured topology changed after the capture', () => {
    const { f1 } = seedTreeSource()
    seedTopic(agg, 't2', [])
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    // Rename an included branch after the capture.
    expect(agg.renameBranch('t1', f1, 'Renamed').ok).toBe(true)
    const before = countRows(sqlite, 'messages')
    const cut = agg.pasteClipboardTree({
      mode: 'cut',
      payload: tree,
      target: { topicId: 't2', branchId: null, intent: TOPIC_TAIL }
    })
    expect(cut.ok).toBe(false)
    expect(countRows(sqlite, 'messages')).toBe(before)
    expect(countIn('messages', sqlite, 't2')).toBe(0)
    expect(countIn('topic_branches', sqlite, 't2')).toBe(0)
  })

  it('fails a cut closed when the captured content changed after the capture', () => {
    seedTreeSource()
    seedTopic(agg, 't2', [])
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    expect(agg.updateMessage('t1', 'aA', { content: 'edited after capture' } as never).ok).toBe(true)
    const before = countRows(sqlite, 'messages')
    const cut = agg.pasteClipboardTree({
      mode: 'cut',
      payload: tree,
      target: { topicId: 't2', branchId: null, intent: TOPIC_TAIL }
    })
    expect(cut.ok).toBe(false)
    expect(countRows(sqlite, 'messages')).toBe(before)
    expect(countIn('messages', sqlite, 't2')).toBe(0)
  })

  it('pastes into an existing branch of another topic and anchors child branches at the mapped root', () => {
    const { f2 } = seedTreeSource()
    seedTopic(agg, 't2', ['X'])
    const targetBranch = okValue(agg.createBranch('t2', null, 'aX', 'Target')).branch.id
    appendTurn(agg, 't2', 'Y', targetBranch)
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    const pasted = okValue(
      agg.pasteClipboardTree({
        mode: 'copy',
        payload: tree,
        target: {
          topicId: 't2',
          branchId: targetBranch,
          intent: { kind: 'after-group-tail', messageId: 'uY' }
        }
      })
    )
    expect(pasted.targetBranchId).toBe(targetBranch)
    const newUserA = mapId(pasted.idMap, 'message', 'uA')
    expect(ownerOf(sqlite, newUserA)).toBe(targetBranch)
    // Only the selected root run lands on the target route, appended after the
    // existing owner tail; child-branch rows keep their own generated branch.
    expect(messageIdsOf(sqlite, 't2', targetBranch)).toEqual([
      'uY',
      'aY',
      newUserA,
      mapId(pasted.idMap, 'message', 'aA')
    ])
    // Direct child branches attach to the mapped root anchor and to the TARGET
    // route — never to the source route id.
    const branches = okValue(agg.listBranches('t2')).branches
    const pastedF1 = branches.find((branch) => branch.anchorMessageId === mapId(pasted.idMap, 'message', 'aA'))
    expect(pastedF1).toBeDefined()
    expect(pastedF1?.parentBranchId).toBe(targetBranch)
    const pastedF2 = branches.find((branch) => branch.id === mapId(pasted.idMap, 'branch', f2))
    expect(pastedF2?.parentBranchId).toBe(pastedF1?.id)
  })

  it('moves a tree within its own topic on cut, and rejects pasting into the removed subtree', () => {
    const { f1 } = seedTreeSource()
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    // Target inside the removed subtree: rejected before any write.
    const before = countRows(sqlite, 'messages')
    const rejected = agg.pasteClipboardTree({
      mode: 'cut',
      payload: tree,
      target: { topicId: 't1', branchId: f1, intent: { kind: 'after-group-tail', messageId: 'uE' } }
    })
    expect(rejected.ok).toBe(false)
    expect(countRows(sqlite, 'messages')).toBe(before)

    const pasted = okValue(
      agg.pasteClipboardTree({
        mode: 'cut',
        payload: tree,
        target: { topicId: 't1', branchId: null, intent: TOPIC_TAIL }
      })
    )
    // Source roots + included branch rows are gone from their old owners.
    expect(messageIdsOf(sqlite, 't1', null)).toEqual([
      'uB',
      'aB',
      'uC',
      'aC',
      'uD',
      'aD',
      ...pasted.insertedRootMessageIds
    ])
    expect(okValue(agg.listBranches('t1')).branches.map((branch) => branch.id)).not.toContain(f1)
    expect(countRows(sqlite, 'messages')).toBe(before)
    expect(pasted.deletedSourceBranchIds).toHaveLength(2)
    expect(pasted.snapshot.sourceRemoved?.messages.map((row) => row.id).sort()).toEqual(
      ['aA', 'aE', 'aG', 'uA', 'uE', 'uG'].sort()
    )
  })

  it('keeps segments, blocks and file references consistent across a tree paste', () => {
    expect(agg.ensureTopic('t1', 'assistant-1', 'topic-t1').ok).toBe(true)
    expect(agg.appendMessage('t1', msgJson('uA', 't1') as never, [blockJson('b-uA', 'uA') as never]).ok).toBe(true)
    // A file block on the selected assistant row, so the copy carries references.
    expect(
      agg.appendMessage('t1', msgJson('aA', 't1', { role: 'assistant', askId: 'uA' }) as never, [
        blockJson('b-aA', 'aA') as never,
        fileJson('b-file-A', 'aA', 'file-1') as never
      ]).ok
    ).toBe(true)
    appendTurn(agg, 't1', 'B')
    appendTurn(agg, 't1', 'G')
    const f1 = okValue(agg.createBranch('t1', null, 'aA', 'Fork')).branch.id
    appendTurn(agg, 't1', 'E', f1)
    okValue(
      agg.upsertSegment({
        segmentId: 'seg-1',
        topicId: 't1',
        branchId: f1,
        name: 'Branch segment',
        messageIds: ['uE', 'aE']
      })
    )
    okValue(
      agg.upsertSegment({
        segmentId: 'seg-2',
        topicId: 't1',
        branchId: null,
        name: 'Root segment',
        messageIds: ['uA', 'aA']
      })
    )
    // Segment over rows that are NOT fully inside the selected closure.
    okValue(
      agg.upsertSegment({
        segmentId: 'seg-3',
        topicId: 't1',
        branchId: null,
        name: 'Unselected segment',
        messageIds: ['uB', 'aB']
      })
    )
    seedTopic(agg, 't2', [])
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    expect(tree.segments.map((segment) => segment.sourceSegmentId).sort()).toEqual(['seg-1', 'seg-2'])
    const pasted = okValue(
      agg.pasteClipboardTree({
        mode: 'copy',
        payload: tree,
        target: { topicId: 't2', branchId: null, intent: TOPIC_TAIL }
      })
    )
    const newSeg1 = mapId(pasted.idMap, 'segment', 'seg-1')
    const newSeg2 = mapId(pasted.idMap, 'segment', 'seg-2')
    expect(segmentMembers(sqlite, newSeg1)).toEqual([
      mapId(pasted.idMap, 'message', 'uE'),
      mapId(pasted.idMap, 'message', 'aE')
    ])
    expect(segmentMembers(sqlite, newSeg2)).toEqual([
      mapId(pasted.idMap, 'message', 'uA'),
      mapId(pasted.idMap, 'message', 'aA')
    ])
    expect(pasted.insertedSegmentIds.sort()).toEqual([newSeg1, newSeg2].sort())
    // Blocks are freshly generated and their file references are materialized.
    const newAssistantA = mapId(pasted.idMap, 'message', 'aA')
    const newBlockA = mapId(pasted.idMap, 'block', 'b-aA')
    const blockRow = sqlite.prepare('SELECT message_id AS messageId FROM message_blocks WHERE id=?').get(newBlockA) as {
      messageId: string
    }
    expect(blockRow.messageId).toBe(newAssistantA)
    expect(contentOf(sqlite, newAssistantA)).toBe('content-aA')
    const pastedFileTurn = mapId(pasted.idMap, 'message', 'aA')
    const refs = sqlite
      .prepare(
        'SELECT fr.file_id AS fileId FROM file_references fr JOIN message_blocks b ON b.id = fr.block_id WHERE b.message_id=?'
      )
      .all(pastedFileTurn) as { fileId: string }[]
    expect(refs.map((row) => row.fileId)).toEqual(['file-1'])
  })

  it('undoes and redoes a cross-topic copy with the same generated ids', () => {
    seedTreeSource()
    seedTopic(agg, 't2', [])
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    const pasted = okValue(
      agg.pasteClipboardTree({
        mode: 'copy',
        payload: tree,
        target: { topicId: 't2', branchId: null, intent: TOPIC_TAIL }
      })
    )
    const insertedIds = [...pasted.insertedMessageIds]
    const insertedBranchIds = [...pasted.insertedBranchIds]
    const insertedSegmentIds = [...pasted.insertedSegmentIds]
    const topic2Before = countIn('messages', sqlite, 't2')

    const undone = okValue(agg.replayClipboardTree({ direction: 'undo', snapshot: pasted.snapshot }))
    expect(undone.removedMessageIds.sort()).toEqual(insertedIds.sort())
    expect(undone.removedBranchIds.sort()).toEqual([...insertedBranchIds].sort())
    expect(countIn('messages', sqlite, 't2')).toBe(0)
    expect(countIn('topic_branches', sqlite, 't2')).toBe(0)
    expect(countIn('topic_segments', sqlite, 't2')).toBe(0)
    // Source is untouched by a copy's undo.
    expect(messageIdsOf(sqlite, 't1', null)).toHaveLength(8)
    void topic2Before

    const redone = okValue(agg.replayClipboardTree({ direction: 'redo', snapshot: pasted.snapshot }))
    expect(redone.restoredMessageIds.sort()).toEqual([...insertedIds].sort())
    expect(redone.restoredBranchIds.sort()).toEqual([...insertedBranchIds].sort())
    expect(messageIdsOf(sqlite, 't2', null)).toEqual(pasted.insertedRootMessageIds)
    // Segment ids are stable across redo.
    for (const segmentId of insertedSegmentIds) {
      expect(segmentMembers(sqlite, segmentId).length).toBeGreaterThan(0)
    }
  })

  it('undoes and redoes a cut, restoring the source rows at their former positions', () => {
    const { f1, f2 } = seedTreeSource()
    seedTopic(agg, 't2', [])
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    const sourceBefore = messageIdsOf(sqlite, 't1', null)
    const branchBefore = messageIdsOf(sqlite, 't1', f1)
    const pasted = okValue(
      agg.pasteClipboardTree({
        mode: 'cut',
        payload: tree,
        target: { topicId: 't2', branchId: null, intent: TOPIC_TAIL }
      })
    )
    expect(messageIdsOf(sqlite, 't1', null)).not.toContain('uA')

    const undone = okValue(agg.replayClipboardTree({ direction: 'undo', snapshot: pasted.snapshot }))
    expect(undone.restoredMessageIds.sort()).toEqual(['aA', 'aE', 'aG', 'uA', 'uE', 'uG'].sort())
    expect(undone.restoredBranchIds.sort()).toEqual([f1, f2].sort())
    // The restored root run returns to its FORMER position, not to the tail.
    expect(messageIdsOf(sqlite, 't1', null)).toEqual(sourceBefore)
    expect(messageIdsOf(sqlite, 't1', f1)).toEqual(branchBefore)
    expect(countIn('messages', sqlite, 't2')).toBe(0)

    const redone = okValue(agg.replayClipboardTree({ direction: 'redo', snapshot: pasted.snapshot }))
    expect(redone.removedMessageIds.sort()).toEqual(['aA', 'aE', 'aG', 'uA', 'uE', 'uG'].sort())
    expect(messageIdsOf(sqlite, 't1', null)).not.toContain('uA')
    expect(okValue(agg.listBranches('t1')).branches.map((branch) => branch.id)).not.toContain(f1)
    expect(messageIdsOf(sqlite, 't2', null)).toEqual(pasted.insertedRootMessageIds)
  })

  it('fails an undo closed (zero writes) when a pasted row was modified after the copy', () => {
    seedTreeSource()
    seedTopic(agg, 't2', ['X'])
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    const pasted = okValue(
      agg.pasteClipboardTree({
        mode: 'copy',
        payload: tree,
        target: { topicId: 't2', branchId: null, intent: { kind: 'after-group-tail', messageId: 'aX' } }
      })
    )
    // A pasted row itself is edited: the recorded content facts no longer hold.
    okValue(agg.updateMessage('t2', pasted.insertedRootMessageIds[0], { content: 'edited' }))
    const before = countRows(sqlite, 'messages')
    expect(agg.replayClipboardTree({ direction: 'undo', snapshot: pasted.snapshot }).ok).toBe(false)
    expect(countRows(sqlite, 'messages')).toBe(before)
    expect(contentOf(sqlite, pasted.insertedRootMessageIds[0])).toBe('edited')
    expect(contentOf(sqlite, 'uX')).toBe('content-uX')
    expect(ownerOf(sqlite, pasted.insertedRootMessageIds[0])).toBeNull()
  })

  it('fails an undo closed (zero writes) when a new branch hangs off a pasted branch', () => {
    const { f2 } = seedTreeSource()
    seedTopic(agg, 't2', [])
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    const pasted = okValue(
      agg.pasteClipboardTree({
        mode: 'copy',
        payload: tree,
        target: { topicId: 't2', branchId: null, intent: TOPIC_TAIL }
      })
    )
    const newF2 = mapId(pasted.idMap, 'branch', f2)
    const newUserG = mapId(pasted.idMap, 'message', 'uG')
    expect(agg.createBranch('t2', newF2, newUserG, 'Late fork').ok).toBe(true)
    const before = countRows(sqlite, 'messages')
    const undone = agg.replayClipboardTree({ direction: 'undo', snapshot: pasted.snapshot })
    expect(undone.ok).toBe(false)
    expect(countRows(sqlite, 'messages')).toBe(before)
    expect(okValue(agg.listBranches('t2')).branches.map((branch) => branch.id)).toContain(newF2)
  })

  it('rejects an unknown explicit target route and an unknown source route', () => {
    seedTreeSource()
    seedTopic(agg, 't2', [])
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    const before = countRows(sqlite, 'messages')
    expect(
      agg.pasteClipboardTree({
        mode: 'copy',
        payload: tree,
        target: { topicId: 't2', branchId: 'does-not-exist', intent: TOPIC_TAIL }
      }).ok
    ).toBe(false)
    expect(agg.fetchClipboardTree({ topicId: 't1', branchId: 'does-not-exist', groupIds: ['uA'] }).ok).toBe(false)
    expect(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['not-a-group'] }).ok).toBe(false)
    expect(countRows(sqlite, 'messages')).toBe(before)
  })

  it('rejects a paste into a trashed target topic with zero writes on both sides', () => {
    seedTreeSource()
    seedTopic(agg, 't2', [])
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    expect(agg.softDeleteTopic('t2').ok).toBe(true)
    const before = countRows(sqlite, 'messages')
    const pasted = agg.pasteClipboardTree({
      mode: 'cut',
      payload: tree,
      target: { topicId: 't2', branchId: null, intent: TOPIC_TAIL }
    })
    expect(pasted.ok).toBe(false)
    expect(countRows(sqlite, 'messages')).toBe(before)
    expect(messageIdsOf(sqlite, 't1', null)).toHaveLength(8)
  })

  it('exposes the paste placement facts the replay relies on', () => {
    seedTreeSource()
    seedTopic(agg, 't2', ['X'])
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    const pasted: PasteClipboardTreeResponse = okValue(
      agg.pasteClipboardTree({
        mode: 'copy',
        payload: tree,
        target: { topicId: 't2', branchId: null, intent: { kind: 'after-group-tail', messageId: 'aX' } }
      })
    )
    expect(pasted.snapshot.kind).toBe('clipboard-tree')
    expect(pasted.snapshot.placement).toMatchObject({
      topicId: 't2',
      branchId: null,
      ownerIndex: 2,
      prevOwnerMessageId: 'aX',
      nextOwnerMessageId: null
    })
    expect(pasted.beforeMessageId).toBe('aX')
    expect(pasted.nextMessageId).toBeNull()
    const snapshot: ClipboardTreeSnapshot = pasted.snapshot
    expect(snapshot.inserted.messages).toHaveLength(6)
    expect(snapshot.inserted.branches).toHaveLength(2)
    expect(snapshot.inserted.segments).toEqual([])
    expect(snapshot.idMap.filter((row) => row.kind === 'message')).toHaveLength(6)
    const payload: ClipboardTreePayload = tree
    expect(payload.source).toEqual({ topicId: 't1', branchId: null })
  })

  // =========================================================================
  // Target-depth capacity
  // =========================================================================

  /**
   * Linear branch chain L1..L(depth) inside one topic: every level owns its own
   * turn and the next level forks from that assistant row, so L(depth) ends with
   * `depth - 1` ancestors. Built through the public branch command, so the
   * fixture itself is a valid tree.
   */
  function seedBranchChain(topicId: string, depth: number, prefix: string): string[] {
    expect(agg.ensureTopic(topicId, 'assistant-1', `topic-${topicId}`).ok).toBe(true)
    appendTurn(agg, topicId, `${prefix}root`)
    const chain: string[] = []
    let parent: string | null = null
    let anchor = `a${prefix}root`
    for (let level = 1; level <= depth; level++) {
      const branchId = okValue(agg.createBranch(topicId, parent, anchor, `${prefix}L${level}`)).branch.id
      chain.push(branchId)
      appendTurn(agg, topicId, `${prefix}L${level}`, branchId)
      parent = branchId
      anchor = `a${prefix}L${level}`
    }
    return chain
  }

  /** Ancestor count of one branch, walked through the authority parent chain. */
  function ancestorCount(branchId: string): number {
    let count = 0
    let current =
      (
        sqlite.prepare('SELECT parent_branch_id AS parent FROM topic_branches WHERE id=?').get(branchId) as
          | { parent: string | null }
          | undefined
      )?.parent ?? null
    while (current !== null && count <= MAX_BRANCH_DEPTH + 1) {
      count += 1
      current =
        (
          sqlite.prepare('SELECT parent_branch_id AS parent FROM topic_branches WHERE id=?').get(current) as
            | { parent: string | null }
            | undefined
        )?.parent ?? null
    }
    return count
  }

  it('rejects a valid captured tree whose generated branches would exceed the target route depth, before any write', () => {
    // Source closure is two levels deep (F1 -> F2): valid on its own route.
    seedTreeSource()
    // The target route sits MAX_BRANCH_DEPTH - 2 ancestors deep, so a two-level
    // pasted forest would place its deepest generated branch at
    // MAX_BRANCH_DEPTH ancestors — beyond what route composition resolves.
    const chain = seedBranchChain('t2', MAX_BRANCH_DEPTH - 1, 'c')
    const deepestRoute = chain[chain.length - 1]
    expect(ancestorCount(deepestRoute)).toBe(MAX_BRANCH_DEPTH - 2)
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    expect(tree.branches.map((branch) => branch.depth)).toEqual([1, 2])
    const messagesBefore = countRows(sqlite, 'messages')
    const branchesBefore = countRows(sqlite, 'topic_branches')
    const sourceBefore = messageIdsOf(sqlite, 't1', null)

    const rejected = agg.pasteClipboardTree({
      mode: 'cut',
      payload: tree,
      target: { topicId: 't2', branchId: deepestRoute, intent: TOPIC_TAIL }
    })
    expect(rejected.ok).toBe(false)
    if (rejected.ok === false) {
      expect(rejected.error.code).toBe('VALIDATION_ERROR')
      expect(rejected.error.message).toContain(`maximum resolvable branch depth (${MAX_BRANCH_DEPTH - 1}`)
    }
    // Zero writes on both sides: nothing pasted, nothing cut.
    expect(countRows(sqlite, 'messages')).toBe(messagesBefore)
    expect(countRows(sqlite, 'topic_branches')).toBe(branchesBefore)
    expect(messageIdsOf(sqlite, 't1', null)).toEqual(sourceBefore)
    expect(countIn('topic_branches', sqlite, 't2')).toBe(MAX_BRANCH_DEPTH - 1)
  })

  it('accepts a one-level captured tree exactly at the resolvable depth limit of the target route', () => {
    // Source with a single child branch (relative depth 1).
    seedTopic(agg, 't3', ['A'])
    const sourceBranch = okValue(agg.createBranch('t3', null, 'aA', 'Single')).branch.id
    appendTurn(agg, 't3', 'E', sourceBranch)
    const chain = seedBranchChain('t2', MAX_BRANCH_DEPTH - 1, 'c')
    const deepestRoute = chain[chain.length - 1]
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't3', branchId: null, groupIds: ['uA'] })).tree
    expect(tree.branches.map((branch) => branch.depth)).toEqual([1])

    const pasted = okValue(
      agg.pasteClipboardTree({
        mode: 'copy',
        payload: tree,
        target: { topicId: 't2', branchId: deepestRoute, intent: TOPIC_TAIL }
      })
    )
    const generated = mapId(pasted.idMap, 'branch', sourceBranch)
    // The limit itself is still resolvable: exactly MAX_BRANCH_DEPTH - 1 ancestors.
    expect(ancestorCount(generated)).toBe(MAX_BRANCH_DEPTH - 1)
    expect(mapId(pasted.idMap, 'message', 'uE')).toBe(messageIdsOf(sqlite, 't2', generated)[0])
  })

  // =========================================================================
  // Same-owner cut/paste identity (paste back into the owner it was cut from)
  // =========================================================================

  it('restores a same-topic cut pasted after its own selection, and redoes it', () => {
    const { f1, f2, f3 } = seedTreeSource()
    const mainBefore = messageIdsOf(sqlite, 't1', null)
    const f1Before = messageIdsOf(sqlite, 't1', f1)
    const f2Before = messageIdsOf(sqlite, 't1', f2)
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    // Moving down inside the same owner: the pasted run lands after the rows
    // that stay behind, and the source rows it replaces leave from the head.
    const pasted = okValue(
      agg.pasteClipboardTree({
        mode: 'cut',
        payload: tree,
        target: { topicId: 't1', branchId: null, intent: TOPIC_TAIL }
      })
    )
    expect(messageIdsOf(sqlite, 't1', null)).toEqual([
      'uB',
      'aB',
      'uC',
      'aC',
      'uD',
      'aD',
      ...pasted.insertedRootMessageIds
    ])

    const undone = okValue(agg.replayClipboardTree({ direction: 'undo', snapshot: pasted.snapshot }))
    expect(undone.removedMessageIds.sort()).toEqual([...pasted.insertedMessageIds].sort())
    expect(undone.restoredMessageIds.sort()).toEqual(['aA', 'aE', 'aG', 'uA', 'uE', 'uG'].sort())
    expect(undone.restoredBranchIds.sort()).toEqual([f1, f2].sort())
    // ONE undo entry restored BOTH the target removal and the source rows, at
    // their former positions in every affected owner.
    expect(messageIdsOf(sqlite, 't1', null)).toEqual(mainBefore)
    expect(messageIdsOf(sqlite, 't1', f1)).toEqual(f1Before)
    expect(messageIdsOf(sqlite, 't1', f2)).toEqual(f2Before)
    // The unrelated branch anchored outside the selected closure stays the
    // whole time; the cut removed exactly f1/f2 and the undo restored them.
    expect(
      okValue(agg.listBranches('t1'))
        .branches.map((branch) => branch.id)
        .sort()
    ).toEqual([f1, f2, f3].sort())

    const redone = okValue(agg.replayClipboardTree({ direction: 'redo', snapshot: pasted.snapshot }))
    expect(redone.removedMessageIds.sort()).toEqual(['aA', 'aE', 'aG', 'uA', 'uE', 'uG'].sort())
    expect(messageIdsOf(sqlite, 't1', null)).toEqual([
      'uB',
      'aB',
      'uC',
      'aC',
      'uD',
      'aD',
      ...pasted.insertedRootMessageIds
    ])
    // Redo re-inserts the same generated branches and cuts f1/f2 again; the
    // unrelated branch was never part of the operation in either direction.
    expect(
      okValue(agg.listBranches('t1'))
        .branches.map((branch) => branch.id)
        .sort()
    ).toEqual([f3, ...pasted.insertedBranchIds].sort())
  })

  it('restores a same-topic cut moved before its own selection, and redoes it', () => {
    seedTopic(agg, 't1', ['A', 'B', 'C', 'D'])
    const before = messageIdsOf(sqlite, 't1', null)
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uC'] })).tree
    const pasted = okValue(
      agg.pasteClipboardTree({
        mode: 'cut',
        payload: tree,
        target: { topicId: 't1', branchId: null, intent: { kind: 'before-message', messageId: 'uB' } }
      })
    )
    // The moved run now sits ABOVE the rows it was cut from.
    expect(messageIdsOf(sqlite, 't1', null)).toEqual([
      'uA',
      'aA',
      ...pasted.insertedRootMessageIds,
      'uB',
      'aB',
      'uD',
      'aD'
    ])
    const moved = messageIdsOf(sqlite, 't1', null)

    const undone = okValue(agg.replayClipboardTree({ direction: 'undo', snapshot: pasted.snapshot }))
    expect(undone.restoredMessageIds.sort()).toEqual(['aC', 'uC'])
    expect(messageIdsOf(sqlite, 't1', null)).toEqual(before)

    okValue(agg.replayClipboardTree({ direction: 'redo', snapshot: pasted.snapshot }))
    expect(messageIdsOf(sqlite, 't1', null)).toEqual(moved)
  })

  it('fails a same-owner cut undo closed when the source owner gained a later row', () => {
    seedTreeSource()
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    const pasted = okValue(
      agg.pasteClipboardTree({
        mode: 'cut',
        payload: tree,
        target: { topicId: 't1', branchId: null, intent: TOPIC_TAIL }
      })
    )
    // Work that landed on the surviving part of the source owner after the cut.
    appendTurn(agg, 't1', 'Z')
    const mainAfterEdit = messageIdsOf(sqlite, 't1', null)
    const messagesBefore = countRows(sqlite, 'messages')
    const undone = agg.replayClipboardTree({ direction: 'undo', snapshot: pasted.snapshot })
    expect(undone.ok).toBe(false)
    expect(countRows(sqlite, 'messages')).toBe(messagesBefore)
    expect(messageIdsOf(sqlite, 't1', null)).toEqual(mainAfterEdit)
  })

  it('restores a same-topic cut pasted into another kept branch, and redoes it', () => {
    const { f3 } = seedTreeSource()
    const mainBefore = messageIdsOf(sqlite, 't1', null)
    const f3Before = messageIdsOf(sqlite, 't1', f3)
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    const pasted = okValue(
      agg.pasteClipboardTree({
        mode: 'cut',
        payload: tree,
        target: { topicId: 't1', branchId: f3, intent: TOPIC_TAIL }
      })
    )
    // The kept branch F3 keeps its own rows; the pasted run lands after them.
    expect(messageIdsOf(sqlite, 't1', f3)).toEqual([...f3Before, ...pasted.insertedRootMessageIds])
    expect(messageIdsOf(sqlite, 't1', null)).toEqual(['uB', 'aB', 'uC', 'aC', 'uD', 'aD'])

    const undone = okValue(agg.replayClipboardTree({ direction: 'undo', snapshot: pasted.snapshot }))
    expect(undone.removedBranchIds.sort()).toEqual([...pasted.insertedBranchIds].sort())
    expect(messageIdsOf(sqlite, 't1', f3)).toEqual(f3Before)
    expect(messageIdsOf(sqlite, 't1', null)).toEqual(mainBefore)

    okValue(agg.replayClipboardTree({ direction: 'redo', snapshot: pasted.snapshot }))
    expect(messageIdsOf(sqlite, 't1', f3)).toEqual([...f3Before, ...pasted.insertedRootMessageIds])
    expect(messageIdsOf(sqlite, 't1', null)).toEqual(['uB', 'aB', 'uC', 'aC', 'uD', 'aD'])
  })

  it('restores the segment state a same-owner cut emptied', () => {
    seedTopic(agg, 't1', ['A', 'B'])
    okValue(
      agg.upsertSegment({
        segmentId: 'seg-cut',
        topicId: 't1',
        branchId: null,
        name: 'Cut segment',
        messageIds: ['uA', 'aA']
      })
    )
    const segmentOrderBefore = (
      sqlite.prepare('SELECT id FROM topic_segments WHERE topic_id=? ORDER BY sort_order ASC').all('t1') as {
        id: string
      }[]
    ).map((row) => row.id)
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    expect(tree.segments.map((segment) => segment.sourceSegmentId)).toEqual(['seg-cut'])
    const pasted = okValue(
      agg.pasteClipboardTree({
        mode: 'cut',
        payload: tree,
        target: { topicId: 't1', branchId: null, intent: TOPIC_TAIL }
      })
    )
    expect(segmentMembers(sqlite, 'seg-cut')).toEqual([])

    okValue(agg.replayClipboardTree({ direction: 'undo', snapshot: pasted.snapshot }))
    expect(segmentMembers(sqlite, 'seg-cut')).toEqual(['uA', 'aA'])
    expect(
      (
        sqlite.prepare('SELECT id FROM topic_segments WHERE topic_id=? ORDER BY sort_order ASC').all('t1') as {
          id: string
        }[]
      ).map((row) => row.id)
    ).toEqual(segmentOrderBefore)
  })

  // =========================================================================
  // Copy into a target route that already holds unrelated rows
  //
  // A copy never removed anything, so an occupied target route is the normal
  // case: the undo has to remove exactly the pasted run and leave every
  // pre-existing row, branch and segment untouched.
  // =========================================================================

  it('undoes a same-topic copy pasted into its own occupied main route, and redoes it with the same ids', () => {
    const { f1, f2, f3 } = seedTreeSource()
    const mainBefore = messageIdsOf(sqlite, 't1', null)
    const f1Before = messageIdsOf(sqlite, 't1', f1)
    const f3Before = messageIdsOf(sqlite, 't1', f3)
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    const pasted = okValue(
      agg.pasteClipboardTree({
        mode: 'copy',
        payload: tree,
        target: { topicId: 't1', branchId: null, intent: TOPIC_TAIL }
      })
    )
    // Copy keeps the source rows AND appends the run to the same owner.
    expect(messageIdsOf(sqlite, 't1', null)).toEqual([...mainBefore, ...pasted.insertedRootMessageIds])

    const undone = okValue(agg.replayClipboardTree({ direction: 'undo', snapshot: pasted.snapshot }))
    expect(undone.removedMessageIds.sort()).toEqual([...pasted.insertedMessageIds].sort())
    expect(undone.removedBranchIds.sort()).toEqual([...pasted.insertedBranchIds].sort())
    expect(undone.restoredMessageIds).toEqual([])
    // Every pre-existing row is back in its place; only the run is gone.
    expect(messageIdsOf(sqlite, 't1', null)).toEqual(mainBefore)
    expect(messageIdsOf(sqlite, 't1', f1)).toEqual(f1Before)
    expect(messageIdsOf(sqlite, 't1', f3)).toEqual(f3Before)
    expect(
      okValue(agg.listBranches('t1'))
        .branches.map((branch) => branch.id)
        .sort()
    ).toEqual([f1, f2, f3].sort())

    okValue(agg.replayClipboardTree({ direction: 'redo', snapshot: pasted.snapshot }))
    expect(messageIdsOf(sqlite, 't1', null)).toEqual([...mainBefore, ...pasted.insertedRootMessageIds])
    // The redo restores the same generated branch topology, anchored on the
    // mapped copies rather than the source rows.
    const redoBranchRows = okValue(agg.listBranches('t1')).branches
    const copiedF1 = mapId(pasted.idMap, 'branch', f1)
    const copiedF2 = mapId(pasted.idMap, 'branch', f2)
    expect(redoBranchRows.find((branch) => branch.id === copiedF1)?.anchorMessageId).toBe(
      mapId(pasted.idMap, 'message', 'aA')
    )
    expect(redoBranchRows.find((branch) => branch.id === copiedF2)?.anchorMessageId).toBe(
      mapId(pasted.idMap, 'message', 'uE')
    )
    expect(messageIdsOf(sqlite, 't1', copiedF2)).toEqual([
      mapId(pasted.idMap, 'message', 'uG'),
      mapId(pasted.idMap, 'message', 'aG')
    ])
  })

  it('undoes a copy pasted into an occupied branch route of the target topic', () => {
    const { f1, f2, f3 } = seedTreeSource()
    const mainBefore = messageIdsOf(sqlite, 't1', null)
    const f3Before = messageIdsOf(sqlite, 't1', f3)
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    const pasted = okValue(
      agg.pasteClipboardTree({
        mode: 'copy',
        payload: tree,
        target: { topicId: 't1', branchId: f3, intent: TOPIC_TAIL }
      })
    )
    expect(messageIdsOf(sqlite, 't1', f3)).toEqual([...f3Before, ...pasted.insertedRootMessageIds])

    okValue(agg.replayClipboardTree({ direction: 'undo', snapshot: pasted.snapshot }))
    expect(messageIdsOf(sqlite, 't1', f3)).toEqual(f3Before)
    expect(messageIdsOf(sqlite, 't1', null)).toEqual(mainBefore)
    // A copy keeps its source branches; only the generated copies are undone.
    expect(
      okValue(agg.listBranches('t1'))
        .branches.map((branch) => branch.id)
        .sort()
    ).toEqual([f1, f2, f3].sort())

    okValue(agg.replayClipboardTree({ direction: 'redo', snapshot: pasted.snapshot }))
    expect(messageIdsOf(sqlite, 't1', f3)).toEqual([...f3Before, ...pasted.insertedRootMessageIds])
    expect(messageIdsOf(sqlite, 't1', null)).toEqual(mainBefore)
  })

  it('undoes a cross-topic copy pasted before an existing row, leaving later rows and groups alone', () => {
    seedTreeSource()
    seedTopic(agg, 't2', ['X', 'Y'])
    okValue(
      agg.upsertSegment({
        segmentId: 'seg-target',
        topicId: 't2',
        branchId: null,
        name: 'Target group',
        messageIds: ['uX', 'aX']
      })
    )
    const targetBefore = messageIdsOf(sqlite, 't2', null)
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    const pasted = okValue(
      agg.pasteClipboardTree({
        mode: 'copy',
        payload: tree,
        target: { topicId: 't2', branchId: null, intent: { kind: 'before-message', messageId: 'uY' } }
      })
    )
    const afterPaste = messageIdsOf(sqlite, 't2', null)
    expect(afterPaste).toEqual(['uX', 'aX', ...pasted.insertedRootMessageIds, 'uY', 'aY'])
    // Unrelated newer work AFTER the insertion point is not part of the scope.
    appendTurn(agg, 't2', 'W')
    const withLaterRow = messageIdsOf(sqlite, 't2', null)
    expect(withLaterRow).toEqual([...afterPaste, 'uW', 'aW'])

    okValue(agg.replayClipboardTree({ direction: 'undo', snapshot: pasted.snapshot }))
    expect(messageIdsOf(sqlite, 't2', null)).toEqual([...targetBefore, 'uW', 'aW'])
    expect(segmentMembers(sqlite, 'seg-target')).toEqual(['uX', 'aX'])
    expect(countIn('topic_branches', sqlite, 't2')).toBe(0)

    okValue(agg.replayClipboardTree({ direction: 'redo', snapshot: pasted.snapshot }))
    expect(messageIdsOf(sqlite, 't2', null)).toEqual([...afterPaste, 'uW', 'aW'])
  })

  it('undoes a cross-topic copy pasted into an occupied branch route', () => {
    seedTreeSource()
    seedTopic(agg, 't2', ['X'])
    const target = okValue(agg.createBranch('t2', null, 'aX', 'Target')).branch.id
    appendTurn(agg, 't2', 'Z', target)
    const targetRowsBefore = messageIdsOf(sqlite, 't2', target)
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    const pasted = okValue(
      agg.pasteClipboardTree({
        mode: 'copy',
        payload: tree,
        target: { topicId: 't2', branchId: target, intent: TOPIC_TAIL }
      })
    )
    expect(messageIdsOf(sqlite, 't2', target)).toEqual([...targetRowsBefore, ...pasted.insertedRootMessageIds])

    okValue(agg.replayClipboardTree({ direction: 'undo', snapshot: pasted.snapshot }))
    expect(messageIdsOf(sqlite, 't2', target)).toEqual(targetRowsBefore)
    expect(okValue(agg.listBranches('t2')).branches.map((branch) => branch.id)).toEqual([target])
  })

  it('rejects a copy undo closed (zero writes) when a branch was anchored on a pasted root', () => {
    seedTreeSource()
    seedTopic(agg, 't2', ['X'])
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    const pasted = okValue(
      agg.pasteClipboardTree({
        mode: 'copy',
        payload: tree,
        target: { topicId: 't2', branchId: null, intent: TOPIC_TAIL }
      })
    )
    const rootCopy = mapId(pasted.idMap, 'message', 'aA')
    okValue(agg.createBranch('t2', null, rootCopy, 'Later fork'))
    const orderBefore = messageIdsOf(sqlite, 't2', null)
    const messagesBefore = countRows(sqlite, 'messages')
    const branchesBefore = countRows(sqlite, 'topic_branches')

    expect(agg.replayClipboardTree({ direction: 'undo', snapshot: pasted.snapshot }).ok).toBe(false)
    expect(countRows(sqlite, 'messages')).toBe(messagesBefore)
    expect(countRows(sqlite, 'topic_branches')).toBe(branchesBefore)
    expect(messageIdsOf(sqlite, 't2', null)).toEqual(orderBefore)
  })

  // =========================================================================
  // Cross-topic reference routes (live foreign prefix, writable own suffix)
  //
  // A reference target's effective route STARTS with the source route's live
  // rows: canonical source ids, but the SOURCE topicId (and the source route's
  // branch ownership). Ownership therefore compares topic AND branch; a
  // branch-only predicate classifies that foreign prefix as mutable. Only the
  // single fork boundary — the reference endpoint, or its resolved group tail —
  // may receive insertions, at the owner head, and the prefix is never copied.
  // =========================================================================

  function topicOf(id: string): string | null {
    const row = sqlite.prepare('SELECT topic_id AS topicId FROM messages WHERE id=?').get(id) as
      | { topicId: string }
      | undefined
    return row === undefined ? null : row.topicId
  }

  for (const scenario of [
    { label: 'main-route prefix', branchOfSource: false },
    { label: 'branch-owned prefix', branchOfSource: true }
  ]) {
    it(`reports a cross-topic reference prefix as inherited metadata (${scenario.label})`, () => {
      seedTopic(agg, 't1', ['A'])
      const sourceBranch = scenario.branchOfSource
        ? okValue(agg.createBranch('t1', null, 'aA', 'Source fork')).branch.id
        : null
      if (sourceBranch !== null) appendTurn(agg, 't1', 'E', sourceBranch)
      const anchor = sourceBranch === null ? 'aA' : 'aE'
      okValue(agg.createReferencedTopic('t1', sourceBranch, 't2', anchor))
      appendTurn(agg, 't2', 'X')
      const foreignGroup = sourceBranch === null ? 'uA' : 'uE'
      const foreignIds = sourceBranch === null ? ['uA', 'aA'] : ['uE', 'aE']

      const foreign = okValue(agg.fetchClipboardTree({ topicId: 't2', branchId: null, groupIds: [foreignGroup] }))
      // Live foreign rows keep their canonical id AND their own topic: they are
      // read-only through t2, never owned roots.
      expect(foreign.clipboard.inheritedRootMessageIds).toEqual(foreignIds)
      expect(foreign.clipboard.ownedRootMessageIds).toEqual([])
      expect(topicOf(foreignIds[0])).toBe('t1')

      const own = okValue(agg.fetchClipboardTree({ topicId: 't2', branchId: null, groupIds: ['uX'] }))
      expect(own.clipboard.ownedRootMessageIds).toEqual(['uX', 'aX'])
      expect(own.clipboard.inheritedRootMessageIds).toEqual([])

      seedTopic(agg, 't3', [])
      const before = {
        messages: countRows(sqlite, 'messages'),
        branches: countRows(sqlite, 'topic_branches'),
        segments: countRows(sqlite, 'topic_segments'),
        source: messageIdsOf(sqlite, 't1', null),
        target: messageIdsOf(sqlite, 't2', null)
      }
      // cut: Main never deletes rows it does not own — rejected before a write.
      const rejected = agg.pasteClipboardTree({
        mode: 'cut',
        payload: foreign.tree,
        target: { topicId: 't3', branchId: null, intent: TOPIC_TAIL }
      })
      if (rejected.ok === false) {
        expect(rejected.error.code).toBe('VALIDATION_ERROR')
        expect(rejected.error.message).toContain('copy-only and cannot be cut')
      } else {
        throw new Error('cut of a foreign reference root must fail closed')
      }
      expect(countRows(sqlite, 'messages')).toBe(before.messages)
      expect(countRows(sqlite, 'topic_branches')).toBe(before.branches)
      expect(countRows(sqlite, 'topic_segments')).toBe(before.segments)
      expect(messageIdsOf(sqlite, 't1', null)).toEqual(before.source)
      expect(messageIdsOf(sqlite, 't2', null)).toEqual(before.target)

      // copy: allowed, and it MATERIALIZES independent rows in the target —
      // fresh ids, the target topicId, no shared prefix and no source mutation.
      const pasted = okValue(
        agg.pasteClipboardTree({
          mode: 'copy',
          payload: foreign.tree,
          target: { topicId: 't3', branchId: null, intent: TOPIC_TAIL }
        })
      )
      expect(pasted.insertedMessageIds).toHaveLength(foreignIds.length)
      for (const id of pasted.insertedMessageIds) {
        expect(foreignIds).not.toContain(id)
        expect(topicOf(id)).toBe('t3')
      }
      expect(countIn('messages', sqlite, 't3')).toBe(foreignIds.length)
      // The source topic and the reference target's own suffix are untouched,
      // and the foreign prefix was never duplicated into the reference target.
      expect(messageIdsOf(sqlite, 't1', null)).toEqual(before.source)
      expect(countIn('messages', sqlite, 't2')).toBe(before.target.length)
    })
  }

  it('accepts the cross-topic reference endpoint (anchor or its group tail) at the owner head', () => {
    seedTopic(agg, 't1', ['A', 'B'])
    okValue(agg.createReferencedTopic('t1', null, 't2', 'aA'))
    appendTurn(agg, 't2', 'X')
    const ownBefore = messageIdsOf(sqlite, 't2', null)
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uB'] })).tree

    // The UI anchor is the group's user row; its group tail (aA) is the endpoint.
    const viaGroupTail = okValue(
      agg.pasteClipboardTree({
        mode: 'copy',
        payload: tree,
        target: { topicId: 't2', branchId: null, intent: { kind: 'after-group-tail', messageId: 'uA' } }
      })
    )
    expect(messageIdsOf(sqlite, 't2', null)).toEqual([...viaGroupTail.insertedRootMessageIds, ...ownBefore])
    expect(viaGroupTail.beforeMessageId).toBeNull()
    expect(viaGroupTail.nextMessageId).toBe(ownBefore[0])

    // The exact endpoint row is the same boundary.
    const viaEndpoint = okValue(
      agg.pasteClipboardTree({
        mode: 'copy',
        payload: tree,
        target: { topicId: 't2', branchId: null, intent: { kind: 'after-group-tail', messageId: 'aA' } }
      })
    )
    expect(messageIdsOf(sqlite, 't2', null)).toEqual([
      ...viaEndpoint.insertedRootMessageIds,
      ...viaGroupTail.insertedRootMessageIds,
      ...ownBefore
    ])

    // The prefix stays live and is never duplicated into the target's own rows.
    expect(countIn('messages', sqlite, 't2')).toBe(
      ownBefore.length + viaGroupTail.insertedMessageIds.length + viaEndpoint.insertedMessageIds.length
    )
    const prefixAgain = okValue(agg.fetchClipboardTree({ topicId: 't2', branchId: null, groupIds: ['uA'] }))
    expect(prefixAgain.clipboard.inheritedRootMessageIds).toEqual(['uA', 'aA'])
    expect(prefixAgain.clipboard.returnedMessageCount).toBe(2)
  })

  it('refuses an older foreign prefix anchor before any write, for both intents', () => {
    seedTopic(agg, 't1', ['A', 'B'])
    // Reference endpoint = aB, so [uA, aA, uB, aB] is the live foreign prefix.
    okValue(agg.createReferencedTopic('t1', null, 't2', 'aB'))
    appendTurn(agg, 't2', 'X')
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    const before = {
      messages: countRows(sqlite, 'messages'),
      branches: countRows(sqlite, 'topic_branches'),
      segments: countRows(sqlite, 'topic_segments'),
      target: messageIdsOf(sqlite, 't2', null)
    }
    const intents: InsertMessageGroupIntent[] = [
      // Older prefix row: its group tail (aA) is not the reference endpoint.
      { kind: 'after-group-tail', messageId: 'uA' },
      // Foreign row with no position in this owner's own row order.
      { kind: 'before-message', messageId: 'uB' }
    ]
    for (const intent of intents) {
      const rejected = agg.pasteClipboardTree({
        mode: 'copy',
        payload: tree,
        target: { topicId: 't2', branchId: null, intent }
      })
      if (rejected.ok === false) {
        expect(rejected.error.code).toBe('VALIDATION_ERROR')
        expect(rejected.error.message).toContain('is not owned by this route and insertion is read-only')
      } else {
        throw new Error(`foreign anchor ${intent.kind} must fail closed`)
      }
      expect(countRows(sqlite, 'messages')).toBe(before.messages)
      expect(countRows(sqlite, 'topic_branches')).toBe(before.branches)
      expect(countRows(sqlite, 'topic_segments')).toBe(before.segments)
      expect(messageIdsOf(sqlite, 't2', null)).toEqual(before.target)
    }
  })

  it('accepts an ordinary owner row of a reference target for both intents', () => {
    seedTopic(agg, 't1', ['A'])
    okValue(agg.createReferencedTopic('t1', null, 't2', 'aA'))
    appendTurn(agg, 't2', 'X')
    appendTurn(agg, 't2', 'Y')
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree

    const beforeMessage = okValue(
      agg.pasteClipboardTree({
        mode: 'copy',
        payload: tree,
        target: { topicId: 't2', branchId: null, intent: { kind: 'before-message', messageId: 'uY' } }
      })
    )
    // The own suffix is the owner: the run lands exactly before uY and the
    // foreign prefix stays in front of everything.
    expect(messageIdsOf(sqlite, 't2', null)).toEqual(['uX', 'aX', ...beforeMessage.insertedRootMessageIds, 'uY', 'aY'])

    const afterGroupTail = okValue(
      agg.pasteClipboardTree({
        mode: 'copy',
        payload: tree,
        target: { topicId: 't2', branchId: null, intent: { kind: 'after-group-tail', messageId: 'aY' } }
      })
    )
    expect(messageIdsOf(sqlite, 't2', null)).toEqual([
      'uX',
      'aX',
      ...beforeMessage.insertedRootMessageIds,
      'uY',
      'aY',
      ...afterGroupTail.insertedRootMessageIds
    ])
    expect(topicOf(afterGroupTail.insertedRootMessageIds[0])).toBe('t2')
  })

  it('cuts an owned group out of a reference target and leaves the foreign prefix live', () => {
    seedTopic(agg, 't1', ['A'])
    okValue(agg.createReferencedTopic('t1', null, 't2', 'aA'))
    appendTurn(agg, 't2', 'X')
    seedTopic(agg, 't3', [])
    const fetched = okValue(agg.fetchClipboardTree({ topicId: 't2', branchId: null, groupIds: ['uX'] }))
    expect(fetched.clipboard.ownedRootMessageIds).toEqual(['uX', 'aX'])
    expect(fetched.clipboard.inheritedRootMessageIds).toEqual([])

    okValue(
      agg.pasteClipboardTree({
        mode: 'cut',
        payload: fetched.tree,
        target: { topicId: 't3', branchId: null, intent: TOPIC_TAIL }
      })
    )
    // Only the reference target's OWN suffix leaves; the shared foreign rows
    // stay in their source topic and remain live through the route.
    expect(messageIdsOf(sqlite, 't2', null)).toEqual([])
    expect(countIn('messages', sqlite, 't1')).toBe(2)
    const prefixAgain = okValue(agg.fetchClipboardTree({ topicId: 't2', branchId: null, groupIds: ['uA'] }))
    expect(prefixAgain.clipboard.inheritedRootMessageIds).toEqual(['uA', 'aA'])
  })

  /**
   * Faithful ordinary-write fixtures.
   *
   * The app's own writes go through the PUBLIC group insert carrying the
   * renderer-shaped `message.blocks` id echo. That echo is not a column, so it
   * lands in `messages.extra.blocks`: a live authority row therefore carries an
   * `overflow.blocks` copy, while a tree paste writes the relational blocks
   * only and never reproduces it. The older `appendMessage`/`msgJson` fixtures
   * omitted the echo and so could not see that asymmetry.
   */
  function overflowOf(id: string): Record<string, unknown> {
    const row = sqlite.prepare('SELECT extra FROM messages WHERE id=?').get(id) as { extra: string | null } | undefined
    if (!row || row.extra === null) return {}
    return JSON.parse(row.extra) as Record<string, unknown>
  }
  function blockOrderOf(messageId: string): string[] {
    return (
      sqlite
        .prepare('SELECT id FROM message_blocks WHERE message_id=? ORDER BY sort_order ASC, id ASC')
        .all(messageId) as { id: string }[]
    ).map((row) => row.id)
  }
  function blockContentsOf(messageId: string): Array<string | null> {
    return (
      sqlite
        .prepare('SELECT content FROM message_blocks WHERE message_id=? ORDER BY sort_order ASC')
        .all(messageId) as { content: string | null }[]
    ).map((row) => row.content ?? null)
  }
  function insertTurnThroughGroupInsert(
    topicId: string,
    turn: string,
    branchId: string | null = null,
    assistantExtraBlocks: Record<string, unknown>[] = []
  ): void {
    const userId = `u${turn}`
    const assistantId = `a${turn}`
    const userBlocks = [blockJson(`b-${userId}`, userId)]
    const assistantBlocks = [blockJson(`b-${assistantId}`, assistantId), ...assistantExtraBlocks]
    okValue(
      agg.insertMessageGroups(
        topicId,
        [
          {
            intent: TOPIC_TAIL,
            entries: [
              {
                message: {
                  ...msgJson(userId, topicId),
                  blocks: userBlocks.map((block) => String(block.id))
                } as never,
                blocks: userBlocks as never[]
              },
              {
                message: {
                  ...msgJson(assistantId, topicId, { role: 'assistant', askId: userId }),
                  blocks: assistantBlocks.map((block) => String(block.id))
                } as never,
                blocks: assistantBlocks as never[]
              }
            ]
          }
        ],
        branchId
      )
    )
  }
  /** main route A/B + child F1 (anchored aA) with turn E + nested F2 (anchored uE) with turn G. */
  function seedTreeSourceThroughGroupInsert(assistantExtraBlocks: Record<string, unknown>[] = []): {
    f1: string
    f2: string
  } {
    expect(agg.ensureTopic('t1', 'assistant-1', 'topic-t1').ok).toBe(true)
    insertTurnThroughGroupInsert('t1', 'A', null, assistantExtraBlocks)
    insertTurnThroughGroupInsert('t1', 'B')
    const f1 = okValue(agg.createBranch('t1', null, 'aA', 'Fork-1')).branch.id
    insertTurnThroughGroupInsert('t1', 'E', f1)
    const f2 = okValue(agg.createBranch('t1', f1, 'uE', 'Fork-2')).branch.id
    insertTurnThroughGroupInsert('t1', 'G', f2)
    return { f1, f2 }
  }

  it('cuts and replays rows written by the ordinary group insert (renderer block-id echo in overflow)', () => {
    const { f1, f2 } = seedTreeSourceThroughGroupInsert()
    seedTopic(agg, 't2', [])
    expect(overflowOf('uA').blocks).toEqual(['b-uA'])

    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    expect(tree.messages.map((wire) => String(wire.id))).toEqual(['uA', 'aA', 'uE', 'aE', 'uG', 'aG'])
    const sourceMainBefore = messageIdsOf(sqlite, 't1', null)
    const sourceF1Before = messageIdsOf(sqlite, 't1', f1)
    const sourceF2Before = messageIdsOf(sqlite, 't1', f2)

    const pasted = okValue(
      agg.pasteClipboardTree({
        mode: 'cut',
        payload: tree,
        target: { topicId: 't2', branchId: null, intent: TOPIC_TAIL }
      })
    )
    // Source: the selected group and its anchored subtree left together.
    expect(messageIdsOf(sqlite, 't1', null)).toEqual(['uB', 'aB'])
    expect(okValue(agg.listBranches('t1')).branches).toEqual([])
    expect(pasted.deletedSourceMessageIds).toHaveLength(6)
    // Target: complete fresh tree; block content and order survive.
    expect(messageIdsOf(sqlite, 't2', null)).toEqual(pasted.insertedRootMessageIds)
    const copiedUserA = mapId(pasted.idMap, 'message', 'uA')
    expect(contentOf(sqlite, copiedUserA)).toBe('content-uA')
    expect(blockOrderOf(copiedUserA)).toEqual([mapId(pasted.idMap, 'block', 'b-uA')])
    expect(blockContentsOf(copiedUserA)).toEqual(['block-b-uA'])
    expect(pasted.insertedBranchIds).toHaveLength(2)

    okValue(agg.replayClipboardTree({ direction: 'undo', snapshot: pasted.snapshot }))
    expect(messageIdsOf(sqlite, 't1', null)).toEqual(sourceMainBefore)
    expect(messageIdsOf(sqlite, 't1', f1)).toEqual(sourceF1Before)
    expect(messageIdsOf(sqlite, 't1', f2)).toEqual(sourceF2Before)
    expect(
      okValue(agg.listBranches('t1'))
        .branches.map((branch) => branch.id)
        .sort()
    ).toEqual([f1, f2].sort())
    expect(countIn('messages', sqlite, 't2')).toBe(0)

    okValue(agg.replayClipboardTree({ direction: 'redo', snapshot: pasted.snapshot }))
    expect(messageIdsOf(sqlite, 't1', null)).toEqual(['uB', 'aB'])
    expect(messageIdsOf(sqlite, 't2', null)).toEqual(pasted.insertedRootMessageIds)
  })

  it('rejects a cut when a captured source message changed, with zero writes on both sides', () => {
    const { f1 } = seedTreeSourceThroughGroupInsert()
    seedTopic(agg, 't2', [])
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    // Edit a captured row INSIDE the anchored subtree through the ordinary
    // edit path on its owner route, not a direct fixture write.
    okValue(agg.updateMessage('t1', 'uE', { content: 'rewritten' } as never, { branchId: f1 }))
    const messagesBefore = countRows(sqlite, 'messages')
    const blocksBefore = countRows(sqlite, 'message_blocks')
    const mainBefore = messageIdsOf(sqlite, 't1', null)
    const f1Before = messageIdsOf(sqlite, 't1', f1)
    const targetBefore = messageIdsOf(sqlite, 't2', null)

    const cut = agg.pasteClipboardTree({
      mode: 'cut',
      payload: tree,
      target: { topicId: 't2', branchId: null, intent: TOPIC_TAIL }
    })
    expect(cut.ok).toBe(false)
    expect(JSON.stringify(cut)).toContain('message uE changed')
    expect(countRows(sqlite, 'messages')).toBe(messagesBefore)
    expect(countRows(sqlite, 'message_blocks')).toBe(blocksBefore)
    expect(messageIdsOf(sqlite, 't1', null)).toEqual(mainBefore)
    expect(messageIdsOf(sqlite, 't1', f1)).toEqual(f1Before)
    expect(messageIdsOf(sqlite, 't2', null)).toEqual(targetBefore)
  })

  it('rejects a cut when a captured block content changed, with zero writes on both sides', () => {
    const { f1 } = seedTreeSourceThroughGroupInsert()
    seedTopic(agg, 't2', [])
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    // Ordinary single-block edit on the block's owner route.
    okValue(
      agg.updateSingleBlock('b-uE', { content: 'drifted block text' } as never, undefined, {
        topicId: 't1',
        branchId: f1
      })
    )
    const messagesBefore = countRows(sqlite, 'messages')
    const blocksBefore = countRows(sqlite, 'message_blocks')
    const mainBefore = messageIdsOf(sqlite, 't1', null)

    const cut = agg.pasteClipboardTree({
      mode: 'cut',
      payload: tree,
      target: { topicId: 't2', branchId: null, intent: TOPIC_TAIL }
    })
    expect(cut.ok).toBe(false)
    expect(JSON.stringify(cut)).toContain('block b-uE changed')
    expect(countRows(sqlite, 'messages')).toBe(messagesBefore)
    expect(countRows(sqlite, 'message_blocks')).toBe(blocksBefore)
    expect(messageIdsOf(sqlite, 't1', null)).toEqual(mainBefore)
    expect(countIn('messages', sqlite, 't2')).toBe(0)
  })

  it('rejects a cut when a captured block ORDER changed, though the derived block-id echo is ignored', () => {
    const { f1 } = seedTreeSourceThroughGroupInsert([blockJson('x-aA', 'aA')])
    seedTopic(agg, 't2', [])
    expect(blockOrderOf('aA')).toEqual(['b-aA', 'x-aA'])
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    // Order-only drift through the ordinary block commands: the relation loses
    // its first block and re-adds the SAME row (same content, same timestamps)
    // at the tail, so only the order changed.
    okValue(agg.deleteBlocks(['b-aA'], { topicId: 't1', branchId: null }))
    okValue(agg.bulkAddBlocks([blockJson('b-aA', 'aA', { sortOrder: 1 }) as never], { topicId: 't1', branchId: null }))
    expect(blockOrderOf('aA')).toEqual(['x-aA', 'b-aA'])
    const messagesBefore = countRows(sqlite, 'messages')
    const mainBefore = messageIdsOf(sqlite, 't1', null)
    const f1Before = messageIdsOf(sqlite, 't1', f1)

    const cut = agg.pasteClipboardTree({
      mode: 'cut',
      payload: tree,
      target: { topicId: 't2', branchId: null, intent: TOPIC_TAIL }
    })
    expect(cut.ok).toBe(false)
    expect(JSON.stringify(cut)).toContain('the blocks of message aA changed')
    expect(countRows(sqlite, 'messages')).toBe(messagesBefore)
    expect(messageIdsOf(sqlite, 't1', null)).toEqual(mainBefore)
    expect(messageIdsOf(sqlite, 't1', f1)).toEqual(f1Before)
    expect(countIn('messages', sqlite, 't2')).toBe(0)
  })
  it('deletes the selected group plus its anchored child subtree, keeping siblings and other topics', () => {
    const { f1, f2, f3 } = seedTreeSource()
    seedTopic(agg, 't2', ['X'])
    const mainBefore = messageIdsOf(sqlite, 't1', null)
    expect(mainBefore).toEqual(['uA', 'aA', 'uB', 'aB', 'uC', 'aC', 'uD', 'aD'])

    const deleted = okValue(agg.deleteClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] }))
    expect(deleted.topicId).toBe('t1')
    expect(deleted.branchId).toBeNull()
    // Selected roots + F1's own turn + nested F2's own turn: every owned row.
    expect(deleted.deletedMessageIds.sort()).toEqual(['aA', 'aE', 'aG', 'uA', 'uE', 'uG'].sort())
    expect(deleted.deletedBranchIds.sort()).toEqual([f1, f2].sort())
    expect(deleted.snapshot.mode).toBe('delete')
    expect(deleted.snapshot.sourceRemoved).not.toBeNull()
    // The doomed span leaves the main route; the sibling branch and the other
    // topic are untouched.
    expect(messageIdsOf(sqlite, 't1', null)).toEqual(['uB', 'aB', 'uC', 'aC', 'uD', 'aD'])
    expect(messageIdsOf(sqlite, 't1', f3)).toEqual(['uH', 'aH'])
    expect(messageIdsOf(sqlite, 't2', null)).toEqual(['uX', 'aX'])
    expect(okValue(agg.listBranches('t1')).branches.map((branch) => branch.id)).toEqual([f3])
  })

  it('refuses to delete an inherited root with zero writes', () => {
    const { f1 } = seedTreeSource()
    // Through F1 the A turn is inherited (owned by the main route).
    const before = countRows(sqlite, 'messages')
    const refused = agg.deleteClipboardTree({ topicId: 't1', branchId: f1, groupIds: ['uA'] })
    expect(refused.ok).toBe(false)
    expect(JSON.stringify(refused)).toContain('copy-only')
    expect(countRows(sqlite, 'messages')).toBe(before)
    expect(messageIdsOf(sqlite, 't1', null)).toEqual(['uA', 'aA', 'uB', 'aB', 'uC', 'aC', 'uD', 'aD'])
    expect(messageIdsOf(sqlite, 't1', f1)).toEqual(['uE', 'aE'])
  })

  it('refuses a delete when an outside branch anchors on a captured row, with zero writes', () => {
    const { f1, f2, f3 } = seedTreeSource()
    // A stray child of the sibling branch, anchored through the shared main
    // prefix at the doomed root: it is outside the deleted forest, so the
    // delete must not orphan it. The public fork API only anchors on rows
    // the parent route owns, so this repaired/legacy anchor shape is
    // inserted directly (no FK on the anchor column by design).
    sqlite
      .prepare(
        'INSERT INTO topic_branches (id, topic_id, parent_branch_id, anchor_message_id, name) VALUES (?, ?, ?, ?, ?)'
      )
      .run('stray-branch', 't1', f3, 'uA', 'Stray')
    const before = countRows(sqlite, 'messages')
    const branchesBefore = countIn('topic_branches', sqlite, 't1')
    const refused = agg.deleteClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })
    expect(refused.ok).toBe(false)
    expect(JSON.stringify(refused)).toContain('outside the deleted subtree')
    expect(countRows(sqlite, 'messages')).toBe(before)
    expect(countIn('topic_branches', sqlite, 't1')).toBe(branchesBefore)
    expect(contentOf(sqlite, 'uA')).toBe('content-uA')
    expect(messageIdsOf(sqlite, 't1', f1)).toEqual(['uE', 'aE'])
    expect(messageIdsOf(sqlite, 't1', f2)).toEqual(['uG', 'aG'])
  })

  it('undoes and redoes a tree delete, restoring stable ids and order', () => {
    const { f1, f2 } = seedTreeSource()
    const sourceBefore = messageIdsOf(sqlite, 't1', null)
    const branchBefore = messageIdsOf(sqlite, 't1', f1)
    const deleted = okValue(agg.deleteClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] }))
    expect(messageIdsOf(sqlite, 't1', null)).not.toContain('uA')

    const undone = okValue(agg.replayClipboardTree({ direction: 'undo', snapshot: deleted.snapshot }))
    expect(undone.restoredMessageIds.sort()).toEqual(['aA', 'aE', 'aG', 'uA', 'uE', 'uG'].sort())
    expect(undone.restoredBranchIds.sort()).toEqual([f1, f2].sort())
    // The restored root run returns to its FORMER position, not to the tail.
    expect(messageIdsOf(sqlite, 't1', null)).toEqual(sourceBefore)
    expect(messageIdsOf(sqlite, 't1', f1)).toEqual(branchBefore)

    const redone = okValue(agg.replayClipboardTree({ direction: 'redo', snapshot: deleted.snapshot }))
    expect(redone.removedMessageIds.sort()).toEqual(['aA', 'aE', 'aG', 'uA', 'uE', 'uG'].sort())
    expect(messageIdsOf(sqlite, 't1', null)).not.toContain('uA')
    expect(okValue(agg.listBranches('t1')).branches.map((branch) => branch.id)).not.toContain(f1)
  })
})
