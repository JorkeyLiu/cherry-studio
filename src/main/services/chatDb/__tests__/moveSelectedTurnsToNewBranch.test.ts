/**
 * moveSelectedTurnsToNewBranch — purpose-specific ownership move.
 *
 * A-B-C-D (turns) with B,C selected -> parent A-D, child A-B-C referencing A,
 * same stable IDs, blocks/attachments intact. Rejects: noncontiguous, missing,
 * first-selection, branch-anchor, non-owned, segment-cut. Zero partial writes.
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

  it('rejects noncontiguous, missing, first-selection, and branch-anchor selections with zero writes', () => {
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
    // Selection containing an existing branch anchor rejects.
    const anchorBranch = (okValue(agg.createBranch('t1', null, 'aB', 'Anchor')).branch as { id: string }).id
    void anchorBranch
    expect(agg.moveSelectedTurnsToNewBranch('t1', null, ['uB', 'uC'], 'Bad', ['uB', 'aB', 'uC', 'aC']).ok).toBe(false)
    expect(okValue(agg.listBranches('t1')).branches.length).toBe(branchesBefore + 1)
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

  function snapshotDbState(): {
    branchCount: number
    owners: Record<string, string | null>
    mainOrders: number[]
    blockCount: number
    fileRefCount: number
  } {
    const branchCount = okValue(agg.listBranches('t1')).branches.length
    const owners: Record<string, string | null> = {}
    for (const id of ['uA', 'aA', 'uB', 'aB', 'uC', 'aC', 'uD', 'aD']) {
      owners[id] = branchOf(sqlite, id)
    }
    const mainOrders = (
      sqlite
        .prepare('SELECT sort_order AS o FROM messages WHERE topic_id=? AND branch_id IS NULL ORDER BY sort_order ASC')
        .all('t1') as { o: number }[]
    ).map((r) => r.o)
    const blockCount = (sqlite.prepare('SELECT COUNT(*) AS n FROM message_blocks').get() as { n: number }).n
    let fileRefCount = 0
    try {
      fileRefCount = (sqlite.prepare('SELECT COUNT(*) AS n FROM file_references').get() as { n: number }).n
    } catch {
      fileRefCount = 0
    }
    return { branchCount, owners, mainOrders, blockCount, fileRefCount }
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

  it('HARD rejects any selection holding an existing branch anchor (sibling + nested) with zero writes', () => {
    seedABCD(agg, 't1')
    // Sibling anchor: L1 fork at aB on main.
    const b1 = (okValue(agg.createBranch('t1', null, 'aB', 'Sibling')).branch as { id: string }).id
    void b1
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
    void b2
    // ANY catalog anchor inside the selection rejects, independent of UI:
    // aB is the sibling anchor, aE is the nested anchor.
    const beforeSibling = snapshotDbState()
    const siblingRes = agg.moveSelectedTurnsToNewBranch('t1', null, ['uB', 'uC'], 'Bad', ['uB', 'aB', 'uC', 'aC'])
    expect(siblingRes.ok).toBe(false)
    if (siblingRes.ok === false) {
      expect(siblingRes.error.code).toBe('VALIDATION_ERROR')
    }
    expect(snapshotDbState()).toEqual(beforeSibling)
    // Nested-anchor selection through the B1 route (uE turn holds anchor aE).
    const beforeNested = snapshotDbState()
    const nestedRes = agg.moveSelectedTurnsToNewBranch('t1', b1, ['uE'], 'Bad', ['uE', 'aE'])
    expect(nestedRes.ok).toBe(false)
    if (nestedRes.ok === false) {
      expect(nestedRes.error.code).toBe('VALIDATION_ERROR')
    }
    expect(snapshotDbState()).toEqual(beforeNested)
    expect(branchOf(sqlite, 'uB')).toBeNull()
    expect(branchOf(sqlite, 'uE')).toBe(b1)
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
