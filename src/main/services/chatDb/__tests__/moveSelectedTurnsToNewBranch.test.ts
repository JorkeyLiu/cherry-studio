/**
 * moveSelectedTurnsToNewBranch — purpose-specific ownership move.
 *
 * A-B-C-D (turns) with B,C selected -> parent A-D, child A-B-C referencing A,
 * same stable IDs, blocks/attachments intact. A branch whose anchor message is
 * part of the selection follows the anchor: its ancestry is re-pointed to the
 * new branch with the anchor unchanged, so its effective route stays verbatim.
 * Rejects: noncontiguous, missing, first-selection, non-owned, segment-cut,
 * re-parent depth overflow. Zero partial writes.
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

import { isSuccess } from '@shared/chatDb'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { runMigrations } from '../migration'
import { MAX_BRANCH_DEPTH } from '../repository'
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-move-'))
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
function seedTurn(
  agg: ChatDbAggregateService,
  topicId: string,
  userId: string,
  assistantIds: string[] = [`a-${userId}`]
): void {
  expect(
    agg.appendMessage(topicId, msgJson(userId, topicId) as never, [blockJson(`b-${userId}`, userId) as never]).ok
  ).toBe(true)
  for (const aid of assistantIds) {
    expect(
      agg.appendMessage(topicId, msgJson(aid, topicId, { role: 'assistant', askId: userId }) as never, [
        blockJson(`b-${aid}`, aid) as never
      ]).ok
    ).toBe(true)
  }
}
function seedABCD(agg: ChatDbAggregateService, topicId: string): void {
  expect(agg.ensureTopic(topicId, 'assistant-1', `topic-${topicId}`).ok).toBe(true)
  for (const t of ['A', 'B', 'C', 'D']) {
    seedTurn(agg, topicId, `u${t}`, [`a${t}`])
  }
}
function effIds(agg: ChatDbAggregateService, topicId: string, branch: string | null): string[] {
  return okValue(agg.fetchMessages(topicId, branch)).messages.map((m) => (m as { id: string }).id)
}
function branchOf(sqlite: Database.Database, id: string): string | null {
  const row = sqlite.prepare('SELECT branch_id AS branchId FROM messages WHERE id=?').get(id) as {
    branchId: string | null
  }
  return row.branchId ?? null
}

describe('moveSelectedTurnsToNewBranch', () => {
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

  it('moves B,C turns to a new branch: parent A-D, child A-B-C, same IDs, blocks intact, A readonly', () => {
    seedABCD(agg, 't1')
    const res = agg.moveSelectedTurnsToNewBranch('t1', null, ['uB', 'uC'], 'Moved', ['uB', 'aB', 'uC', 'aC'])
    expect(res.ok).toBe(true)
    const v = okValue(res)
    expect(v.anchorMessageId).toBe('aA')
    expect(v.movedMessageIds).toEqual(['uB', 'aB', 'uC', 'aC'])
    expect((v.branch as { parentBranchId: string | null }).parentBranchId).toBeNull()
    expect((v.branch as { anchorMessageId: string }).anchorMessageId).toBe('aA')
    const branchId = (v.branch as { id: string }).id
    expect(effIds(agg, 't1', null)).toEqual(['uA', 'aA', 'uD', 'aD'])
    expect(effIds(agg, 't1', branchId)).toEqual(['uA', 'aA', 'uB', 'aB', 'uC', 'aC'])
    for (const id of ['uB', 'aB', 'uC', 'aC']) {
      expect(branchOf(sqlite, id)).toBe(branchId)
    }
    for (const id of ['uA', 'aA', 'uD', 'aD']) {
      expect(branchOf(sqlite, id)).toBeNull()
    }
    const bRow = sqlite.prepare('SELECT * FROM message_blocks WHERE id=?').get('b-uB') as { message_id: string }
    expect(bRow.message_id).toBe('uB')
    const askRow = sqlite.prepare('SELECT ask_id AS askId FROM messages WHERE id=?').get('aB') as { askId: string }
    expect(askRow.askId).toBe('uB')
    // A stays readonly through the child route.
    expect(agg.updateMessage('t1', 'uA', { content: 'x' } as never, { branchId }).ok).toBe(false)
    expect(agg.updateMessage('t1', 'uA', { content: 'owner-ok' } as never, { branchId: null }).ok).toBe(true)
    // Ordinary branchId patch is stripped and never reparents.
    expect(agg.updateMessage('t1', 'uD', { branchId } as never, { branchId: null }).ok).toBe(true)
    expect(branchOf(sqlite, 'uD')).toBeNull()
    // Per-owner orders are dense.
    const mainOrders = sqlite
      .prepare('SELECT sort_order AS o FROM messages WHERE topic_id=? AND branch_id IS NULL ORDER BY sort_order ASC')
      .all('t1') as { o: number }[]
    expect(mainOrders.map((r) => r.o)).toEqual([0, 1, 2, 3])
    const childOrders = sqlite
      .prepare('SELECT sort_order AS o FROM messages WHERE branch_id=? ORDER BY sort_order ASC')
      .all(branchId) as { o: number }[]
    expect(childOrders.map((r) => r.o)).toEqual([0, 1, 2, 3])
    // No sync intent minted for the local-only move.
    const outbox = db.select().from(schema.syncOutbox).all()
    expect(outbox.filter((r) => v.movedMessageIds.includes(r.entityId))).toEqual([])
    // Source/new capability exact through windowed reads.
    const parentWindow = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: 't1', limit: 20 }))
    expect(new Set(parentWindow.mutableMessageIds)).toEqual(new Set(['uA', 'aA', 'uD', 'aD']))
    const childWindow = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: 't1', branchId, limit: 20 }))
    expect(new Set(childWindow.mutableMessageIds)).toEqual(new Set(['uB', 'aB', 'uC', 'aC']))
  })

  it('supports nested source moves from an existing branch suffix', () => {
    seedABCD(agg, 't1')
    const b1 = (okValue(agg.createBranch('t1', null, 'aB', 'B1')).branch as { id: string }).id
    // Append two owned suffix turns to the branch; moving the second has a
    // source-owned preceding anchor.
    for (const [uid, aid] of [
      ['uE', 'aE'],
      ['uF', 'aF']
    ] as const) {
      expect(
        agg.appendMessage(
          't1',
          msgJson(uid, 't1') as never,
          [blockJson(`b-${uid}`, uid) as never],
          undefined,
          undefined,
          { branchId: b1 }
        ).ok
      ).toBe(true)
      expect(
        agg.appendMessage(
          't1',
          msgJson(aid, 't1', { role: 'assistant', askId: uid }) as never,
          [blockJson(`b-${aid}`, aid) as never],
          undefined,
          undefined,
          { branchId: b1 }
        ).ok
      ).toBe(true)
    }
    expect(effIds(agg, 't1', b1)).toEqual(['uA', 'aA', 'uB', 'aB', 'uE', 'aE', 'uF', 'aF'])
    const res = agg.moveSelectedTurnsToNewBranch('t1', b1, ['uF'], 'Nested', ['uF', 'aF'])
    expect(res.ok).toBe(true)
    const v = okValue(res)
    const b2 = (v.branch as { id: string }).id
    expect((v.branch as { parentBranchId: string | null }).parentBranchId).toBe(b1)
    expect(effIds(agg, 't1', b1)).toEqual(['uA', 'aA', 'uB', 'aB', 'uE', 'aE'])
    expect(effIds(agg, 't1', b2)).toEqual(['uA', 'aA', 'uB', 'aB', 'uE', 'aE', 'uF', 'aF'])
    expect(branchOf(sqlite, 'uF')).toBe(b2)
  })

  it('rejects noncontiguous, missing, and first-selection selections with zero writes', () => {
    seedABCD(agg, 't1')
    const branchesBefore = okValue(agg.listBranches('t1')).branches.length
    const countBefore = (sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n
    // Noncontiguous turns A,C.
    expect(agg.moveSelectedTurnsToNewBranch('t1', null, ['uA', 'uC'], 'Bad', ['uA', 'aA', 'uC', 'aC']).ok).toBe(false)
    // Missing group.
    expect(agg.moveSelectedTurnsToNewBranch('t1', null, ['uB', 'nope'], 'Bad', ['uB', 'aB']).ok).toBe(false)
    // First turn has no preceding anchor.
    expect(agg.moveSelectedTurnsToNewBranch('t1', null, ['uA'], 'Bad', ['uA', 'aA']).ok).toBe(false)
    // Empty selection.
    expect(agg.moveSelectedTurnsToNewBranch('t1', null, [], 'Bad', []).ok).toBe(false)
    expect(okValue(agg.listBranches('t1')).branches.length).toBe(branchesBefore)
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(countBefore)
    expect(effIds(agg, 't1', null)).toEqual(['uA', 'aA', 'uB', 'aB', 'uC', 'aC', 'uD', 'aD'])
  })

  it('rejects non-owned selections and segment-cut selections with zero writes', () => {
    seedABCD(agg, 't1')
    const b1 = (okValue(agg.createBranch('t1', null, 'aA', 'B1')).branch as { id: string }).id
    // Through the child route, main-owned B is inherited and must reject.
    expect(agg.moveSelectedTurnsToNewBranch('t1', b1, ['uB'], 'Bad', ['uB', 'aB']).ok).toBe(false)
    // Through main, branch-owned rows are not resolvable as source-owned turns.
    // Segment cutting through the selection rejects without inventing split policy.
    const segRes = agg.upsertSegment('seg-1', 't1', 'Seg', ['uB', 'aB', 'uC'], undefined)
    expect(segRes.ok).toBe(true)
    const branchesBefore = okValue(agg.listBranches('t1')).branches.length
    expect(agg.moveSelectedTurnsToNewBranch('t1', null, ['uB'], 'Bad', ['uB', 'aB']).ok).toBe(false)
    expect(okValue(agg.listBranches('t1')).branches.length).toBe(branchesBefore)
    expect(branchOf(sqlite, 'uB')).toBeNull()
    // Wholly-inside segments are preserved untouched.
    const segFull = agg.upsertSegment('seg-2', 't1', 'Seg2', ['uD', 'aD'], undefined)
    expect(segFull.ok).toBe(true)
    const okRes = agg.moveSelectedTurnsToNewBranch('t1', null, ['uD'], 'Ok', ['uD', 'aD'])
    expect(okRes.ok).toBe(true)
    const segMembers = agg.listSegments('t1')
    expect(segMembers.ok).toBe(true)
  })

  it('rejects preflight segment-cut with zero writes (segment spans the selection boundary)', () => {
    seedABCD(agg, 't1')
    // Seed a segment that will cut the selection only after anchor checks pass,
    // proving atomicity: branch row + owner writes roll back together.
    expect(agg.upsertSegment('seg-cut', 't1', 'Cut', ['uC', 'aC', 'uD'], undefined).ok).toBe(true)
    const branchesBefore = okValue(agg.listBranches('t1')).branches.length
    const res = agg.moveSelectedTurnsToNewBranch('t1', null, ['uB', 'uC'], 'Atomic', ['uB', 'aB', 'uC', 'aC'])
    expect(res.ok).toBe(false)
    expect(okValue(agg.listBranches('t1')).branches.length).toBe(branchesBefore)
    for (const id of ['uB', 'aB', 'uC', 'aC']) {
      expect(branchOf(sqlite, id)).toBeNull()
    }
  })

  function snapshotDbState(topicId: string = 't1'): {
    branchCount: number
    branchRows: { id: string; parentBranchId: string | null; anchorMessageId: string }[]
    owners: Record<string, string | null>
    allOwners: Record<string, string | null>
    mainOrders: number[]
    blockCount: number
    fileRefCount: number
  } {
    const branchCount = okValue(agg.listBranches(topicId)).branches.length
    const branchRows = (
      sqlite
        .prepare('SELECT id, parent_branch_id AS p, anchor_message_id AS a FROM topic_branches ORDER BY id ASC')
        .all() as { id: string; p: string | null; a: string }[]
    ).map((r) => ({ id: r.id, parentBranchId: r.p, anchorMessageId: r.a }))
    // `allOwners` below is the complete per-topic owner map; this fixed slice is
    // kept for the t1 fixtures and skips ids the topic does not contain.
    const owners: Record<string, string | null> = {}
    for (const id of ['uA', 'aA', 'uB', 'aB', 'uC', 'aC', 'uD', 'aD']) {
      const row = sqlite.prepare('SELECT branch_id AS b FROM messages WHERE id=?').get(id) as
        | { b: string | null }
        | undefined
      if (row) owners[id] = row.b ?? null
    }
    const allOwners: Record<string, string | null> = {}
    const ownerRows = sqlite
      .prepare('SELECT id, branch_id AS b FROM messages WHERE topic_id=? ORDER BY id ASC')
      .all(topicId) as { id: string; b: string | null }[]
    for (const row of ownerRows) {
      allOwners[row.id] = row.b ?? null
    }
    const mainOrders = (
      sqlite
        .prepare('SELECT sort_order AS o FROM messages WHERE topic_id=? AND branch_id IS NULL ORDER BY sort_order ASC')
        .all(topicId) as { o: number }[]
    ).map((r) => r.o)
    const blockCount = (sqlite.prepare('SELECT COUNT(*) AS n FROM message_blocks').get() as { n: number }).n
    let fileRefCount = 0
    try {
      fileRefCount = (sqlite.prepare('SELECT COUNT(*) AS n FROM file_references').get() as { n: number }).n
    } catch {
      fileRefCount = 0
    }
    return { branchCount, branchRows, owners, allOwners, mainOrders, blockCount, fileRefCount }
  }

  it('rolls back branch INSERT plus owner/order writes when projection construction faults (zero partial writes)', async () => {
    seedABCD(agg, 't1')
    const before = snapshotDbState()
    const { BlocksRepository } = await import('../repository/BlocksRepository')
    const blocksSpy = vi.spyOn(BlocksRepository.prototype, 'listByMessages')
    // First projection read (parent route) passes; the child-route read faults
    // AFTER the branch row + all message owner/sortOrder writes. The root
    // transaction must roll everything back.
    let calls = 0
    blocksSpy.mockImplementation(function (this: unknown, messageIds: string[]) {
      calls++
      if (calls >= 2) throw new Error('injected projection fault after owner writes')
      return BlocksRepository.prototype.listByMessages.call(this as never, messageIds) as never
    })
    try {
      const res = agg.moveSelectedTurnsToNewBranch('t1', null, ['uB', 'uC'], 'Atomic', ['uB', 'aB', 'uC', 'aC'])
      expect(res.ok).toBe(false)
    } finally {
      blocksSpy.mockRestore()
    }
    const after = snapshotDbState()
    expect(after).toEqual(before)
    expect(effIds(agg, 't1', null)).toEqual(['uA', 'aA', 'uB', 'aB', 'uC', 'aC', 'uD', 'aD'])
  })

  it('HARD rejects first-turn selection with VALIDATION_ERROR and zero branch/owner/order/block writes', () => {
    seedABCD(agg, 't1')
    const before = snapshotDbState()
    const res = agg.moveSelectedTurnsToNewBranch('t1', null, ['uA'], 'Bad', ['uA', 'aA'])
    expect(res.ok).toBe(false)
    if (res.ok === false) {
      expect(res.error.code).toBe('VALIDATION_ERROR')
    }
    expect(snapshotDbState()).toEqual(before)
    expect(effIds(agg, 't1', null)).toEqual(['uA', 'aA', 'uB', 'aB', 'uC', 'aC', 'uD', 'aD'])
  })

  it('re-parents any branch anchored inside the selection and preserves its effective route verbatim (sibling + nested)', () => {
    seedABCD(agg, 't1')
    // Sibling anchor: L1 fork at aB on main.
    const b1 = (okValue(agg.createBranch('t1', null, 'aB', 'Sibling')).branch as { id: string }).id
    // Nested anchor: child of B1 anchored at its owned suffix message.
    // Seed one B1-owned suffix turn so the nested anchor is B1-owned.
    expect(
      agg.appendMessage('t1', msgJson('uE', 't1') as never, [blockJson('b-uE', 'uE') as never], undefined, undefined, {
        branchId: b1
      }).ok
    ).toBe(true)
    expect(
      agg.appendMessage(
        't1',
        msgJson('aE', 't1', { role: 'assistant', askId: 'uE' }) as never,
        [blockJson('b-aE', 'aE') as never],
        undefined,
        undefined,
        { branchId: b1 }
      ).ok
    ).toBe(true)
    const b2 = (okValue(agg.createBranch('t1', b1, 'aE', 'Nested')).branch as { id: string }).id
    // Route-preservation proof. Before: E(main) = [uA,aA,uB,aB,uC,aC,uD,aD] and
    // b1: parent=main, anchor=aB → E(b1) = [uA,aA,uB,aB] + own(b1).
    // After: E(main) = [uA,aA,uD,aD]; N: parent=main, anchor=aA →
    // E(N) = [uA,aA,uB,aB,uC,aC]; b1: parent=N, anchor=aB → identical E(b1).
    const routeB1Before = effIds(agg, 't1', b1)
    const routeB2Before = effIds(agg, 't1', b2)
    expect(routeB1Before).toEqual(['uA', 'aA', 'uB', 'aB', 'uE', 'aE'])
    expect(routeB2Before).toEqual(['uA', 'aA', 'uB', 'aB', 'uE', 'aE'])
    const branchesBefore = okValue(agg.listBranches('t1')).branches.length
    const branchRowsBefore = (sqlite.prepare('SELECT COUNT(*) AS n FROM topic_branches').get() as { n: number }).n
    // aB is the sibling anchor and sits inside the moved selection.
    const res = agg.moveSelectedTurnsToNewBranch('t1', null, ['uB', 'uC'], 'Moved', ['uB', 'aB', 'uC', 'aC'])
    expect(res.ok).toBe(true)
    const newBranchId = (okValue(res).branch as { id: string }).id
    // The moved anchor is now owned by the new branch.
    expect(branchOf(sqlite, 'aB')).toBe(newBranchId)
    // b1 follows its anchor: parent re-pointed, anchor untouched.
    const b1Row = sqlite
      .prepare('SELECT parent_branch_id AS p, anchor_message_id AS a FROM topic_branches WHERE id=?')
      .get(b1) as { p: string | null; a: string }
    expect(b1Row.p).toBe(newBranchId)
    expect(b1Row.a).toBe('aB')
    // b2 is untouched: still child of b1 and follows by route composition.
    const b2Row = sqlite
      .prepare('SELECT parent_branch_id AS p, anchor_message_id AS a FROM topic_branches WHERE id=?')
      .get(b2) as { p: string | null; a: string }
    expect(b2Row.p).toBe(b1)
    expect(b2Row.a).toBe('aE')
    // Verbatim effective routes: only the intermediate ownership changed.
    expect(effIds(agg, 't1', b1)).toEqual(routeB1Before)
    expect(effIds(agg, 't1', b2)).toEqual(routeB2Before)
    // Only the new branch row was added; nothing deleted.
    expect(okValue(agg.listBranches('t1')).branches.length).toBe(branchesBefore + 1)
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM topic_branches').get() as { n: number }).n).toBe(
      branchRowsBefore + 1
    )
  })

  it('re-parents a nested child branch whose anchor sits inside a moved branch suffix', () => {
    seedABCD(agg, 'tn')
    const b1 = (okValue(agg.createBranch('tn', null, 'aA', 'B1')).branch as { id: string }).id
    const appendOwned = (branchId: string, uid: string, aid: string): void => {
      expect(
        agg.appendMessage(
          'tn',
          msgJson(uid, 'tn') as never,
          [blockJson(`b-${uid}`, uid) as never],
          undefined,
          undefined,
          {
            branchId
          }
        ).ok
      ).toBe(true)
      expect(
        agg.appendMessage(
          'tn',
          msgJson(aid, 'tn', { role: 'assistant', askId: uid }) as never,
          [blockJson(`b-${aid}`, aid) as never],
          undefined,
          undefined,
          { branchId }
        ).ok
      ).toBe(true)
    }
    appendOwned(b1, 'uE', 'aE')
    appendOwned(b1, 'uF', 'aF')
    // Child anchored at a b1-owned suffix message: E(child) = E(b1) through aF.
    const child = (okValue(agg.createBranch('tn', b1, 'aF', 'Child')).branch as { id: string }).id
    const routeChildBefore = effIds(agg, 'tn', child)
    expect(routeChildBefore).toEqual(['uA', 'aA', 'uE', 'aE', 'uF', 'aF'])
    // The move's preceding anchor (aE) is b1-owned and the anchor of `child`
    // (aF) is inside the moved selection.
    const res = agg.moveSelectedTurnsToNewBranch('tn', b1, ['uF'], 'Nested', ['uF', 'aF'])
    expect(res.ok).toBe(true)
    const newBranchId = (okValue(res).branch as { id: string }).id
    const childRow = sqlite
      .prepare('SELECT parent_branch_id AS p, anchor_message_id AS a FROM topic_branches WHERE id=?')
      .get(child) as { p: string | null; a: string }
    expect(childRow.p).toBe(newBranchId)
    expect(childRow.a).toBe('aF')
    expect(branchOf(sqlite, 'aF')).toBe(newBranchId)
    // E(child) is unchanged: E(b1) = [uA,aA,uE,aE]; E(new) = that + [uF,aF].
    expect(effIds(agg, 'tn', b1)).toEqual(['uA', 'aA', 'uE', 'aE'])
    expect(effIds(agg, 'tn', newBranchId)).toEqual(['uA', 'aA', 'uE', 'aE', 'uF', 'aF'])
    expect(effIds(agg, 'tn', child)).toEqual(routeChildBefore)
  })

  // =========================================================================
  // Re-parent depth boundary
  //
  // The repository resolves at most MAX_BRANCH_DEPTH - 1 ancestors: the
  // `ancestorsOf` loop runs `depth < MAX_BRANCH_DEPTH` times and never pushes
  // the branch itself, so a node with MAX_BRANCH_DEPTH ancestors is silently
  // truncated at its root-most one. The guard must therefore sit on
  // MAX_BRANCH_DEPTH - 1, and these fixtures pin both sides of that boundary.
  // =========================================================================

  /**
   * Linear branch chain L1..L(deepest) under `topicId`, forked from main at
   * `aroot`: L1 owns the move's preceding turn (up/ap) and the target turn
   * (u1/a1); L2 forks from L1 at a1; every L(k+1) forks from Lk at its own
   * assistant row. L(k) has k-1 ancestors, so L(deepest) has `deepest - 1`
   * before a re-parent of L2 and `deepest` after one.
   */
  function buildBranchChain(topicId: string, deepest: number): string[] {
    expect(agg.ensureTopic(topicId, 'assistant-1', `topic-${topicId}`).ok).toBe(true)
    seedTurn(agg, topicId, 'uroot', ['aroot'])
    const appendOwned = (branchId: string, uid: string, aid: string): void => {
      expect(
        agg.appendMessage(
          topicId,
          msgJson(uid, topicId) as never,
          [blockJson(`b-${uid}`, uid) as never],
          undefined,
          undefined,
          {
            branchId
          }
        ).ok
      ).toBe(true)
      expect(
        agg.appendMessage(
          topicId,
          msgJson(aid, topicId, { role: 'assistant', askId: uid }) as never,
          [blockJson(`b-${aid}`, aid) as never],
          undefined,
          undefined,
          { branchId }
        ).ok
      ).toBe(true)
    }
    const chain: string[] = []
    const l1 = (okValue(agg.createBranch(topicId, null, 'aroot', 'L1')).branch as { id: string }).id
    chain.push(l1)
    appendOwned(l1, 'up', 'ap')
    appendOwned(l1, 'u1', 'a1')
    let current = (okValue(agg.createBranch(topicId, l1, 'a1', 'L2')).branch as { id: string }).id
    chain.push(current)
    for (let level = 2; level < deepest; level++) {
      appendOwned(current, `u${level}`, `a${level}`)
      current = (okValue(agg.createBranch(topicId, current, `a${level}`, `L${level + 1}`)).branch as { id: string }).id
      chain.push(current)
    }
    return chain
  }

  it('accepts a re-parent landing exactly at the resolvable depth limit', () => {
    // L(MAX_BRANCH_DEPTH-1) ends with MAX_BRANCH_DEPTH-1 ancestors after the
    // re-parent: exactly what `ancestorsOf` can still return.
    const deepest = MAX_BRANCH_DEPTH - 1
    const chain = buildBranchChain('td', deepest)
    const rootRoute = chain[0]
    const target = chain[1]
    const deepestBranch = chain[deepest - 1]
    // Fully resolvable before the move (deepest - 1 = MAX_BRANCH_DEPTH - 2).
    const routeBefore = effIds(agg, 'td', deepestBranch)
    expect(routeBefore[0]).toBe('uroot')
    const res = agg.moveSelectedTurnsToNewBranch('td', rootRoute, ['u1'], 'Moved', ['u1', 'a1'])
    expect(res.ok).toBe(true)
    const newBranchId = (okValue(res).branch as { id: string }).id
    const targetRow = sqlite
      .prepare('SELECT parent_branch_id AS p, anchor_message_id AS a FROM topic_branches WHERE id=?')
      .get(target) as { p: string | null; a: string }
    expect(targetRow.p).toBe(newBranchId)
    expect(targetRow.a).toBe('a1')
    // Still fully resolvable after the move: the composition reaches the main
    // route and the deepest route is verbatim (nothing truncated root-most).
    const routeAfter = effIds(agg, 'td', deepestBranch)
    expect(routeAfter[0]).toBe('uroot')
    expect(routeAfter).toEqual(routeBefore)
  })

  it('rejects with zero writes when re-parenting would exceed the resolvable depth limit', () => {
    // One ancestor over: L(MAX_BRANCH_DEPTH) would end with MAX_BRANCH_DEPTH
    // ancestors, which `ancestorsOf` cannot resolve.
    const chain = buildBranchChain('td', MAX_BRANCH_DEPTH)
    const rootRoute = chain[0]
    const before = snapshotDbState('td')
    const res = agg.moveSelectedTurnsToNewBranch('td', rootRoute, ['u1'], 'Bad', ['u1', 'a1'])
    expect(res.ok).toBe(false)
    if (res.ok === false) {
      expect(res.error.code).toBe('VALIDATION_ERROR')
      expect(res.error.message).toContain(`maximum resolvable branch depth (${MAX_BRANCH_DEPTH - 1}`)
    }
    expect(snapshotDbState('td')).toEqual(before)
  })

  it('HARD rejects expected-selection mismatch (cropped subset, wrong order, unseen rows) with zero writes', () => {
    seedABCD(agg, 't1')
    const before = snapshotDbState()
    // Cropped subset: renderer saw only uB but Main expands the full uB turn.
    expect(agg.moveSelectedTurnsToNewBranch('t1', null, ['uB'], 'Bad', ['uB']).ok).toBe(false)
    // Wrong order: same IDs but not display order.
    expect(agg.moveSelectedTurnsToNewBranch('t1', null, ['uB', 'uC'], 'Bad', ['uC', 'aC', 'uB', 'aB']).ok).toBe(false)
    // Unseen extra row smuggled into the expectation.
    expect(agg.moveSelectedTurnsToNewBranch('t1', null, ['uB', 'uC'], 'Bad', ['uB', 'aB', 'uC', 'aC', 'uD']).ok).toBe(
      false
    )
    // Missing expected entirely.
    expect(agg.moveSelectedTurnsToNewBranch('t1', null, ['uB', 'uC'], 'Bad').ok).toBe(false)
    expect(snapshotDbState()).toEqual(before)
    expect(effIds(agg, 't1', null)).toEqual(['uA', 'aA', 'uB', 'aB', 'uC', 'aC', 'uD', 'aD'])
  })

  // =========================================================================
  // Context-window anchor inheritance resolved inside the atomic move
  //
  // The destination anchor must be resolved from the PRE-MOVE source route:
  // the index of the renderer-supplied source anchor maps into the destination
  // route's turn list, a missing/out-of-range source anchor falls back to the
  // CURRENT contextCount default position (never a clamp to last), and the
  // fact is returned only when the caller supplied the inheritance input.
  // =========================================================================
  function seedABCDE(agg2: ChatDbAggregateService, topicId: string): void {
    seedABCD(agg2, topicId)
    seedTurn(agg2, topicId, 'uE', ['aE'])
  }
  function seedABCDEF(agg2: ChatDbAggregateService, topicId: string): void {
    seedABCDE(agg2, topicId)
    seedTurn(agg2, topicId, 'uF', ['aF'])
  }

  it('returns NO anchor fact when the caller supplies no inheritance input', () => {
    seedABCD(agg, 't1')
    const v = okValue(agg.moveSelectedTurnsToNewBranch('t1', null, ['uB'], 'Moved', ['uB', 'aB']))
    expect('resolvedContextAnchorGroupKey' in (v as Record<string, unknown>)).toBe(false)
  })

  it('inherits the stable original anchor by index (never the contextCount default)', () => {
    seedABCDE(agg, 't1')
    // Source anchor uB is turn index 1 of the pre-move route (A,B,C,D,E) and
    // stays index 1 in the destination A,B,C,D. contextCount=1 would put the
    // default at index 3 (uD), so only an index map yields uB.
    const v = okValue(
      agg.moveSelectedTurnsToNewBranch('t1', null, ['uC', 'uD'], 'Moved', ['uC', 'aC', 'uD', 'aD'], {
        sourceAnchorGroupKey: 'uB',
        contextCount: 1
      })
    )
    expect(v.resolvedContextAnchorGroupKey).toBe('uB')
    const branchId = (v.branch as { id: string }).id
    expect(effIds(agg, 't1', branchId)).toEqual(['uA', 'aA', 'uB', 'aB', 'uC', 'aC', 'uD', 'aD'])
  })

  it('inherits by index when the source anchor is inside the moved range', () => {
    seedABCDE(agg, 't1')
    // uC (index 2) is part of the moved selection; the destination keeps the
    // turn at the same index, so the anchor maps there without recomputation.
    const v = okValue(
      agg.moveSelectedTurnsToNewBranch('t1', null, ['uC'], 'Moved', ['uC', 'aC'], {
        sourceAnchorGroupKey: 'uC',
        contextCount: 5
      })
    )
    expect(v.resolvedContextAnchorGroupKey).toBe('uC')
  })

  it('falls back to the current-contextCount default when the source anchor is out of the destination range', () => {
    seedABCDE(agg, 't1')
    // Source anchor uE is turn index 4 of the pre-move route (A,B,C,D,E); the
    // destination keeps only A,B,C,D (4 turns), so index 4 is out of range.
    // contextCount=2 puts the default at index 2 (uC) — never a clamp to the
    // last turn (uD). Resolving against the POST-move source route instead
    // would find uE at index 3 and wrongly return uD.
    const v = okValue(
      agg.moveSelectedTurnsToNewBranch('t1', null, ['uD'], 'Moved', ['uD', 'aD'], {
        sourceAnchorGroupKey: 'uE',
        contextCount: 2
      })
    )
    expect(v.resolvedContextAnchorGroupKey).toBe('uC')
  })

  it('falls back to the default when the source route has no anchor', () => {
    seedABCDE(agg, 't1')
    const v = okValue(
      agg.moveSelectedTurnsToNewBranch('t1', null, ['uC'], 'Moved', ['uC', 'aC'], {
        sourceAnchorGroupKey: null,
        contextCount: 2
      })
    )
    // Destination A,B,C (3 turns); contextCount=2 → default index 1 → uB.
    expect(v.resolvedContextAnchorGroupKey).toBe('uB')
  })

  // =========================================================================
  // Source-route anchor delete transfer (context-window governance §9)
  //
  // When the source anchor's turn is part of the moved selection, the anchor
  // deterministically falls to the previous surviving older turn (the new
  // first turn when the deleted turn was the first, and `null` when the source
  // route becomes empty). A surviving anchor produces NO fact at all — the
  // caller must never rebuild or rewrite the source anchor.
  // =========================================================================

  it('multi-turn move with the anchor in the middle of the selection picks the nearest surviving OLDER turn, never a newer one', () => {
    seedABCDEF(agg, 't1')
    // Pre route A..F; anchor uE (index 4); moving the contiguous D,E leaves
    // after = [A,B,C,F]. Nearest surviving older turn is uC (uD moved away).
    // uF survives and is NEWER — index arithmetic (`beforeIdx - 1 = 3`) would
    // wrongly return uF.
    const v = okValue(
      agg.moveSelectedTurnsToNewBranch('t1', null, ['uD', 'uE'], 'Moved', ['uD', 'aD', 'uE', 'aE'], {
        sourceAnchorGroupKey: 'uE',
        contextCount: 1
      })
    )
    expect(v.sourceContextAnchorTransfer).toEqual({ fromGroupKey: 'uE', toGroupKey: 'uC' })
    expect(effIds(agg, 't1', null)).toEqual(['uA', 'aA', 'uB', 'aB', 'uC', 'aC', 'uF', 'aF'])
    // Destination inherits the anchor's PRE-move index (5 turns: A..E).
    const branchId = (v.branch as { id: string }).id
    expect(effIds(agg, 't1', branchId)).toEqual(['uA', 'aA', 'uB', 'aB', 'uC', 'aC', 'uD', 'aD', 'uE', 'aE'])
    expect(v.resolvedContextAnchorGroupKey).toBe('uE')
  })

  it('multi-turn move whose selection runs to the route end transfers to the nearest surviving older turn without throwing', () => {
    seedABCDE(agg, 't1')
    // Pre route A..E, anchor uE (LAST, index 4), selection D,E reaches the end.
    // After = [A,B,C]; nearest surviving older is uC. `beforeIdx - 1 = 3` used to
    // run past the 3-element post list and roll the whole transaction back.
    const v = okValue(
      agg.moveSelectedTurnsToNewBranch('t1', null, ['uD', 'uE'], 'Moved', ['uD', 'aD', 'uE', 'aE'], {
        sourceAnchorGroupKey: 'uE',
        contextCount: 2
      })
    )
    expect(v.sourceContextAnchorTransfer).toEqual({ fromGroupKey: 'uE', toGroupKey: 'uC' })
    expect(effIds(agg, 't1', null)).toEqual(['uA', 'aA', 'uB', 'aB', 'uC', 'aC'])
    // Durable: the move really committed (not a rolled-back transaction).
    const branchId = (v.branch as { id: string }).id
    expect(branchOf(sqlite, 'uD')).toBe(branchId)
    expect(branchOf(sqlite, 'uE')).toBe(branchId)
  })

  it('3-turn route, anchor last, move the last two: transfers to the sole post turn without throwing', () => {
    // Exactly the reported compression case: pre = [A,B,C], anchor uC (last),
    // move the contiguous B,C → after = [A]. No OLDER turn survives (uB moved),
    // so the transfer lands on the post route's first turn (uA). The old
    // `beforeIdx - 1 = 1` indexed past the 1-element post list and rolled the
    // whole transaction back.
    seedTurn(agg, 't1', 'uA', ['aA'])
    seedTurn(agg, 't1', 'uB', ['aB'])
    seedTurn(agg, 't1', 'uC', ['aC'])
    const v = okValue(
      agg.moveSelectedTurnsToNewBranch('t1', null, ['uB', 'uC'], 'Moved', ['uB', 'aB', 'uC', 'aC'], {
        sourceAnchorGroupKey: 'uC',
        contextCount: 1
      })
    )
    expect(v.sourceContextAnchorTransfer).toEqual({ fromGroupKey: 'uC', toGroupKey: 'uA' })
    // The move really committed: the source route keeps only turn A.
    expect(effIds(agg, 't1', null)).toEqual(['uA', 'aA'])
    const branchId = (v.branch as { id: string }).id
    expect(effIds(agg, 't1', branchId)).toEqual(['uA', 'aA', 'uB', 'aB', 'uC', 'aC'])
  })

  it('transfers a source anchor that the selection removed to the previous surviving turn', () => {
    seedABCDE(agg, 't1')
    // Source turns A,B,C,D,E; the anchor uD (index 3) is moved away, so the
    // source route keeps A,B,C and the anchor falls to index 2 (uC).
    const v = okValue(
      agg.moveSelectedTurnsToNewBranch('t1', null, ['uD'], 'Moved', ['uD', 'aD'], {
        sourceAnchorGroupKey: 'uD',
        contextCount: 1
      })
    )
    expect(v.sourceContextAnchorTransfer).toEqual({ fromGroupKey: 'uD', toGroupKey: 'uC' })
    // The destination still inherits by pre-move index (uD stayed at index 3).
    expect(v.resolvedContextAnchorGroupKey).toBe('uD')
    expect(effIds(agg, 't1', null)).toEqual(['uA', 'aA', 'uB', 'aB', 'uC', 'aC', 'uE', 'aE'])
  })

  it('keeps a first-turn source anchor intact (the first turn can never be part of a move)', () => {
    seedABCDE(agg, 't1')
    // A move always keeps a preceding anchor, so the source route's first turn
    // survives: the anchor is unchanged and NO transfer fact is produced. The
    // `newIndex < 0 → new first group` guard stays defensive for that reason.
    const v = okValue(
      agg.moveSelectedTurnsToNewBranch('t1', null, ['uC'], 'Moved', ['uC', 'aC'], {
        sourceAnchorGroupKey: 'uA',
        contextCount: 2
      })
    )
    expect('sourceContextAnchorTransfer' in (v as Record<string, unknown>)).toBe(false)
    expect(agg.moveSelectedTurnsToNewBranch('t1', null, ['uA'], 'X', ['uA', 'aA']).ok).toBe(false)
  })

  it('never produces an empty-source transfer through a legal move (a preceding anchor always survives)', () => {
    // A move requires a preceding anchor in the source route, so the source
    // route always keeps at least one turn and the `null` (empty-route) branch
    // stays defensive. The single-turn case is rejected outright.
    expect(agg.ensureTopic('t-empty-src', 'assistant-1', 'empty-src').ok).toBe(true)
    seedTurn(agg, 't-empty-src', 'uOnly', ['aOnly'])
    expect(agg.moveSelectedTurnsToNewBranch('t-empty-src', null, ['uOnly'], 'X', ['uOnly', 'aOnly']).ok).toBe(false)
  })

  it('produces NO source transfer when the anchor survives the move', () => {
    seedABCDE(agg, 't1')
    const v = okValue(
      agg.moveSelectedTurnsToNewBranch('t1', null, ['uD'], 'Moved', ['uD', 'aD'], {
        sourceAnchorGroupKey: 'uB',
        contextCount: 2
      })
    )
    expect('sourceContextAnchorTransfer' in (v as Record<string, unknown>)).toBe(false)
    expect(v.resolvedContextAnchorGroupKey).toBe('uB')
  })

  it('produces NO source transfer when no active source anchor was supplied', () => {
    seedABCDE(agg, 't1')
    const v = okValue(
      agg.moveSelectedTurnsToNewBranch('t1', null, ['uD'], 'Moved', ['uD', 'aD'], {
        sourceAnchorGroupKey: null,
        contextCount: 2
      })
    )
    expect('sourceContextAnchorTransfer' in (v as Record<string, unknown>)).toBe(false)
  })

  it('produces NO source transfer when the supplied key names no source turn', () => {
    seedABCDE(agg, 't1')
    const v = okValue(
      agg.moveSelectedTurnsToNewBranch('t1', null, ['uD'], 'Moved', ['uD', 'aD'], {
        sourceAnchorGroupKey: 'u-missing',
        contextCount: 2
      })
    )
    expect('sourceContextAnchorTransfer' in (v as Record<string, unknown>)).toBe(false)
  })
})
