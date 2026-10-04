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
})
