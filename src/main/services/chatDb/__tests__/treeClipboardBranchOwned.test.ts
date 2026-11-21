/**
 * Branch-owned clipboard capture (`capture: 'branch-owned'`).
 *
 * Business contract of copying ONE branch row's tree: that branch's own rows are
 * the root trunk, every descendant branch contributes only the rows it owns, and
 * no inherited parent prefix is ever read. The source branch's own branch node
 * is not part of the payload (a paste does not re-create it), while descendant
 * nodes keep their names, parents and anchors.
 *
 * The assertions are about REAL authority rows (SQLite): which rows a capture
 * contains, which rows a paste writes into the target, and that every fail-closed
 * case leaves zero rows and zero branches behind. The selection-anchored capture
 * shape stays untouched and is covered by `treeClipboard.test.ts`.
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

import type { ClipboardTreeIdMapRow, FetchClipboardTreeBranchOwnedRequest } from '@shared/chatDb'
import { isSuccess } from '@shared/chatDb'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { runMigrations } from '../migration'
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-branch-owned-clipboard-'))
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
/** Append one complete turn (user + assistant with askId) to one route owner. */
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
function seedTopic(agg: ChatDbAggregateService, topicId: string, turns: string[]): void {
  expect(agg.ensureTopic(topicId, 'assistant-1', `topic-${topicId}`).ok).toBe(true)
  for (const turn of turns) appendTurn(agg, topicId, turn)
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
function askIdOf(sqlite: Database.Database, id: string): string | null {
  const row = sqlite.prepare('SELECT ask_id AS askId FROM messages WHERE id=?').get(id) as
    | { askId: string | null }
    | undefined
  return row === undefined ? null : (row.askId ?? null)
}
function ownerOf(sqlite: Database.Database, id: string): string | null {
  const row = sqlite.prepare('SELECT branch_id AS branchId FROM messages WHERE id=?').get(id) as
    | { branchId: string | null }
    | undefined
  return row === undefined ? null : (row.branchId ?? null)
}
function mapId(idMap: ClipboardTreeIdMapRow[], kind: ClipboardTreeIdMapRow['kind'], sourceId: string): string {
  const row = idMap.find((entry) => entry.kind === kind && entry.sourceId === sourceId)
  if (!row) throw new Error(`No ${kind} mapping for ${sourceId}`)
  return row.targetId
}
/** Explicit branch-owned capture request (the discriminated shape under test). */
function branchOwned(topicId: string, branchId: string): FetchClipboardTreeBranchOwnedRequest {
  return { topicId, branchId, capture: 'branch-owned' }
}

const TOPIC_TAIL = { kind: 'topic-tail' } as const

describe('branch-owned clipboard capture', () => {
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
   * Source fixture: main route A..D, branch F1 (anchored at aA) owning its own
   * turn E plus nested F2 (anchored at uE) owning G, and an unrelated sibling
   * F3 (anchored at aC) owning H which a branch-owned capture of F1 must never
   * pull in.
   */
  function seedBranchSource(): { f1: string; f2: string; f3: string } {
    seedTopic(agg, 't1', ['A', 'B', 'C', 'D'])
    const f1 = okValue(agg.createBranch('t1', null, 'aA', 'Fork-1')).branch.id
    appendTurn(agg, 't1', 'E', f1)
    const f2 = okValue(agg.createBranch('t1', f1, 'uE', 'Fork-2')).branch.id
    appendTurn(agg, 't1', 'G', f2)
    const f3 = okValue(agg.createBranch('t1', null, 'aC', 'Fork-3')).branch.id
    appendTurn(agg, 't1', 'H', f3)
    return { f1, f2, f3 }
  }

  it("reads the branch's own rows as the trunk plus every descendant branch's own rows", () => {
    const { f1, f2, f3 } = seedBranchSource()
    const response = okValue(agg.fetchClipboardTree(branchOwned('t1', f1)))

    // One trunk group: the branch's complete own turn, in authority order.
    expect(response.tree.roots).toHaveLength(1)
    expect(response.tree.roots[0].messageIds).toEqual(['uE', 'aE'])
    expect(response.tree.roots[0].groupId).toBe('uE')
    // Every trunk row is owned by this branch: nothing is copy-only.
    expect(response.clipboard.ownedRootMessageIds).toEqual(['uE', 'aE'])
    expect(response.clipboard.inheritedRootMessageIds).toEqual([])
    expect(response.clipboard.branchId).toBe(f1)
    expect(response.clipboard.requestedCount).toBe(1)
    expect(response.clipboard.returnedCount).toBe(1)

    // Descendant branch: own rows only, with its name/parent/anchor preserved.
    expect(response.tree.branches.map((branch) => branch.sourceBranchId)).toEqual([f2])
    expect(response.tree.branches[0]).toMatchObject({
      parentSourceBranchId: f1,
      anchorMessageId: 'uE',
      name: 'Fork-2',
      depth: 1
    })
    // The branch's own node is NOT part of the payload (a paste must not
    // re-create it), and neither the inherited prefix nor the sibling appears.
    expect(response.tree.branches.map((branch) => branch.sourceBranchId)).not.toContain(f1)
    expect(response.tree.branches.map((branch) => branch.sourceBranchId)).not.toContain(f3)

    const capturedIds = (response.tree.messages as unknown as { id: string }[]).map((wire) => wire.id)
    expect(capturedIds.sort()).toEqual(['aE', 'aG', 'uE', 'uG'])
    expect(response.clipboard.returnedMessageCount).toBe(4)
    expect(response.clipboard.returnedBranchCount).toBe(1)
    // Blocks travel with their own rows only.
    expect(
      (response.tree.blocks as unknown as { messageId: string }[]).every((b) => capturedIds.includes(b.messageId))
    ).toBe(true)
    // Capture is read-only: the source keeps every row and branch.
    expect(messageIdsOf(sqlite, 't1', f1)).toEqual(['uE', 'aE'])
    expect(messageIdsOf(sqlite, 't1', null)).toEqual(['uA', 'aA', 'uB', 'aB', 'uC', 'aC', 'uD', 'aD'])
    expect(countIn('topic_branches', sqlite, 't1')).toBe(3)
  })

  it('captures fully-contained segments of the branch tree only', () => {
    const { f1 } = seedBranchSource()
    okValue(
      agg.upsertSegment({
        segmentId: 'seg-1',
        topicId: 't1',
        branchId: f1,
        name: 'Branch segment',
        messageIds: ['uE', 'aE']
      })
    )
    // A segment straddling the inherited prefix is not fully contained.
    okValue(
      agg.upsertSegment({
        segmentId: 'seg-2',
        topicId: 't1',
        branchId: null,
        name: 'Prefix segment',
        messageIds: ['uA', 'aA', 'uB', 'aB']
      })
    )

    const response = okValue(agg.fetchClipboardTree(branchOwned('t1', f1)))

    expect(response.tree.segments.map((segment) => segment.sourceSegmentId)).toEqual(['seg-1'])
    expect(response.tree.segments[0].memberIds).toEqual(['uE', 'aE'])
    expect(response.clipboard.returnedSegmentCount).toBe(1)
  })

  it('pastes as a clean owned trunk: no prefix rows and no re-created source branch node', () => {
    const { f1, f2 } = seedBranchSource()
    seedTopic(agg, 't2', [])
    const tree = okValue(agg.fetchClipboardTree(branchOwned('t1', f1))).tree
    const pasted = okValue(
      agg.pasteClipboardTree({
        mode: 'copy',
        payload: tree,
        target: { topicId: 't2', branchId: null, intent: TOPIC_TAIL }
      })
    )

    const newUserE = mapId(pasted.idMap, 'message', 'uE')
    const newAssistantE = mapId(pasted.idMap, 'message', 'aE')
    const newF2 = mapId(pasted.idMap, 'branch', f2)
    // Trunk rows land on the target active route, in authority order.
    expect(messageIdsOf(sqlite, 't2', null)).toEqual([newUserE, newAssistantE])
    expect(askIdOf(sqlite, newAssistantE)).toBe(newUserE)
    // Exactly one generated branch: the source branch's OWN node is not
    // re-created, and the descendant keeps its name/anchor/parent.
    expect(pasted.insertedBranchIds).toEqual([newF2])
    const branches = okValue(agg.listBranches('t2')).branches
    expect(branches).toHaveLength(1)
    expect(branches[0]).toMatchObject({
      id: newF2,
      parentBranchId: null,
      anchorMessageId: newUserE,
      name: 'Fork-2'
    })
    // No prefix bleed: only the four owned rows exist in the target.
    const targetContents = (
      sqlite.prepare('SELECT content FROM messages WHERE topic_id=?').all('t2') as { content: string | null }[]
    ).map((row) => row.content)
    expect(targetContents.sort()).toEqual(['content-aE', 'content-aG', 'content-uE', 'content-uG'])
    // Source untouched.
    expect(messageIdsOf(sqlite, 't1', f1)).toEqual(['uE', 'aE'])
    expect(messageIdsOf(sqlite, 't1', null)).toHaveLength(8)
  })

  it('pastes a nested descendant under the target branch route', () => {
    const { f1, f2 } = seedBranchSource()
    seedTopic(agg, 't2', ['Z'])
    const targetBranch = okValue(agg.createBranch('t2', null, 'aZ', 'Target')).branch.id
    const tree = okValue(agg.fetchClipboardTree(branchOwned('t1', f1))).tree

    const pasted = okValue(
      agg.pasteClipboardTree({
        mode: 'copy',
        payload: tree,
        target: { topicId: 't2', branchId: targetBranch, intent: TOPIC_TAIL }
      })
    )

    const newF2 = mapId(pasted.idMap, 'branch', f2)
    const newUserE = mapId(pasted.idMap, 'message', 'uE')
    // The generated descendant hangs off the explicit target route, not off a
    // re-created source branch node.
    const branch = okValue(agg.listBranches('t2')).branches.find((candidate) => candidate.id === newF2)
    expect(branch).toMatchObject({ parentBranchId: targetBranch, anchorMessageId: newUserE, name: 'Fork-2' })
    expect(ownerOf(sqlite, newUserE)).toBe(targetBranch)
  })

  it('treats an owned answer to an inherited question as its own trunk group and pastes it orphaned', () => {
    seedTopic(agg, 't1', ['A', 'B'])
    const f1 = okValue(agg.createBranch('t1', null, 'aA', 'Fork')).branch.id
    // This branch owns a second answer to the main-route question uA: the ask is
    // inherited (its user row is NOT owned by the branch).
    expect(
      agg.appendMessage(
        't1',
        msgJson('aFork', 't1', { role: 'assistant', askId: 'uA' }) as never,
        [blockJson('b-aFork', 'aFork') as never],
        undefined,
        undefined,
        { branchId: f1 }
      ).ok
    ).toBe(true)

    const response = okValue(agg.fetchClipboardTree(branchOwned('t1', f1)))

    expect(response.tree.roots).toHaveLength(1)
    // Stable own key for a group whose ask is outside the capture.
    expect(response.tree.roots[0].groupId).toBe('aFork')
    expect(response.tree.roots[0].messageIds).toEqual(['aFork'])
    expect(response.clipboard.ownedRootMessageIds).toEqual(['aFork'])

    seedTopic(agg, 't2', [])
    const pasted = okValue(
      agg.pasteClipboardTree({
        mode: 'copy',
        payload: response.tree,
        target: { topicId: 't2', branchId: null, intent: TOPIC_TAIL }
      })
    )
    // The inherited ask is not part of the capture: the copy is an orphan group
    // instead of a dangling cross-topic reference, and no parent row is invented.
    const newId = mapId(pasted.idMap, 'message', 'aFork')
    expect(askIdOf(sqlite, newId)).toBeNull()
    expect(messageIdsOf(sqlite, 't2', null)).toEqual([newId])
  })

  it('fails closed when the branch owns no rows', () => {
    seedTopic(agg, 't1', ['A'])
    const empty = okValue(agg.createBranch('t1', null, 'uA', 'Empty fork')).branch.id
    const messagesBefore = countRows(sqlite, 'messages')
    const branchesBefore = countRows(sqlite, 'topic_branches')

    const result = agg.fetchClipboardTree(branchOwned('t1', empty))

    expect(result.ok).toBe(false)
    expect(countRows(sqlite, 'messages')).toBe(messagesBefore)
    expect(countRows(sqlite, 'topic_branches')).toBe(branchesBefore)
  })

  it('fails closed when a descendant anchors at a row outside the captured rows', () => {
    const { f1, f2 } = seedBranchSource()
    // Repaired/dangling reference: F2 now anchors at a row owned by the main
    // route (readable through F1 as inherited, but never owned by it).
    sqlite.prepare('UPDATE topic_branches SET anchor_message_id=? WHERE id=?').run('aA', f2)
    const messagesBefore = countRows(sqlite, 'messages')
    const branchesBefore = countRows(sqlite, 'topic_branches')

    const result = agg.fetchClipboardTree(branchOwned('t1', f1))

    expect(result.ok).toBe(false)
    expect(countRows(sqlite, 'messages')).toBe(messagesBefore)
    expect(countRows(sqlite, 'topic_branches')).toBe(branchesBefore)
  })

  it('fails closed for an unknown branch route', () => {
    seedBranchSource()
    const result = agg.fetchClipboardTree(branchOwned('t1', 'no-such-branch'))
    expect(result.ok).toBe(false)
  })

  it("keeps the selection-anchored capture's inherited-prefix behaviour untouched", () => {
    const { f1 } = seedBranchSource()
    // Same branch, addressed through the ordinary selected-group shape: the
    // A turn is inherited there and stays copy-only.
    const response = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: f1, groupIds: ['uA'] }))
    expect(response.tree.roots[0].messageIds).toEqual(['uA', 'aA'])
    expect(response.clipboard.ownedRootMessageIds).toEqual([])
    expect(response.clipboard.inheritedRootMessageIds).toEqual(['uA', 'aA'])
    expect(response.clipboard.requestedCount).toBe(1)
  })
})
