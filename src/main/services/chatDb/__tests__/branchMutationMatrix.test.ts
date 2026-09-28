/**
 * True-branch owner-only mutation guards + stable identity + window
 * capability (BRANCH-1…BRANCH-12, no descendant protection).
 *
 * - messages.branch_id is permanent ownership only; topic_branches defines ancestry.
 * - Current-route-owned rows are always mutable through their owner route,
 *   even when referenced by live descendants (butterfly effect, BRANCH-4/5).
 * - Ancestor references are read-only through descendant routes (no COW).
 * - Sibling suffixes never affect each other; post-anchor main rows stay mutable.
 * - Rejections (non-owner) leave the DB unchanged (no partial writes).
 * - Window `mutableMessageIds` is Main-authoritative per response: the precise
 *   owned subset of the returned window (BRANCH-9).
 */
import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

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

const MODEL = { id: 'model-a', provider: 'p', name: 'A', group: 'g' }

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-matrix-'))
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
function seedMain(agg: ChatDbAggregateService, topicId: string, ids: string[]): void {
  expect(agg.ensureTopic(topicId, 'assistant-1', `topic-${topicId}`).ok).toBe(true)
  for (const id of ids) {
    expect(agg.appendMessage(topicId, msgJson(id, topicId) as never, [blockJson(`b-${id}`, id) as never]).ok).toBe(true)
  }
}
function seedSuffix(
  agg: ChatDbAggregateService,
  topicId: string,
  branchId: string,
  ids: string[],
  role: string = 'user'
): void {
  for (const id of ids) {
    expect(
      agg.appendMessage(
        topicId,
        msgJson(id, topicId, { role }) as never,
        [blockJson(`b-${id}`, id) as never],
        undefined,
        undefined,
        { branchId }
      ).ok
    ).toBe(true)
  }
}
function contentOf(sqlite: Database.Database, id: string): string | null {
  const row = sqlite.prepare('SELECT content AS c FROM messages WHERE id=?').get(id) as { c: string } | undefined
  return row?.c ?? null
}

describe('branch mutation guard matrix', () => {
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

  it('main owned messages accept all mutation kinds through the null route', () => {
    seedMain(agg, 't1', ['m0', 'm1'])
    expect(agg.updateMessage('t1', 'm1', { content: 'edited' } as never, { branchId: null }).ok).toBe(true)
    expect(contentOf(sqlite, 'm1')).toBe('edited')
    expect(
      agg.updateMessageAndBlocks(
        't1',
        { id: 'm1', content: 'edited2' } as never,
        [blockJson('b-m1', 'm1', { content: 'nb' }) as never],
        [],
        { branchId: null }
      ).ok
    ).toBe(true)
    expect(agg.updateSingleBlock('b-m1', { content: 'sb' } as never).ok).toBe(true)
    expect(agg.deleteMessage('t1', 'm0', null).ok).toBe(true)
    expect(contentOf(sqlite, 'm0')).toBeNull()
  })

  it('child owned suffix is mutable through its own route and immutable through parent/main', () => {
    seedMain(agg, 't1', ['m0', 'm1'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm1', 'B1')).branch as { id: string }).id
    seedSuffix(agg, 't1', b1, ['c0'])
    expect(agg.updateMessage('t1', 'c0', { content: 'e' } as never, { branchId: b1 }).ok).toBe(true)
    expect(agg.updateMessage('t1', 'c0', { content: 'x' } as never, { branchId: null }).ok).toBe(false)
    expect(agg.updateMessage('t1', 'c0', { content: 'x' } as never, { branchId: b1 }).ok).toBe(true)
    expect(agg.deleteMessage('t1', 'c0', null).ok).toBe(false)
    expect(agg.deleteMessage('t1', 'c0', b1).ok).toBe(true)
  })

  it('inherited rows reject through descendant routes; owner rows stay mutable when referenced (BRANCH-4)', () => {
    seedMain(agg, 't1', ['m0', 'm1', 'm2'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm1', 'B1')).branch as { id: string }).id
    // Inherited via the child route rejects (read-only ancestor reference).
    expect(agg.updateMessage('t1', 'm0', { content: 'x' } as never, { branchId: b1 }).ok).toBe(false)
    expect(agg.deleteMessage('t1', 'm1', b1).ok).toBe(false)
    // Owner route keeps full control even when referenced by a live descendant (butterfly effect).
    expect(agg.updateMessage('t1', 'm1', { content: 'owner-edit' } as never, { branchId: null }).ok).toBe(true)
    expect(
      agg.updateMessageAndBlocks('t1', { id: 'm0', content: 'owner-edit0' } as never, [], [], { branchId: null }).ok
    ).toBe(true)
    expect(contentOf(sqlite, 'm0')).toBe('owner-edit0')
    expect(contentOf(sqlite, 'm1')).toBe('owner-edit')
  })

  it('grandchild references do not lock the owner prefix; sibling suffixes stay independent (BRANCH-4/5)', () => {
    seedMain(agg, 't1', ['m0', 'm1', 'm2'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm1', 'B1')).branch as { id: string }).id
    seedSuffix(agg, 't1', b1, ['b1-0'])
    const b2 = (okValue(agg.createBranch('t1', b1, 'b1-0', 'B2')).branch as { id: string }).id
    // b1-0 is referenced by grandchild b2 but stays mutable through its owner b1 (butterfly effect).
    expect(agg.updateMessage('t1', 'b1-0', { content: 'owner-edit' } as never, { branchId: b1 }).ok).toBe(true)
    expect(contentOf(sqlite, 'b1-0')).toBe('owner-edit')
    // Descendant route cannot mutate the ancestor reference.
    expect(agg.updateMessage('t1', 'b1-0', { content: 'x' } as never, { branchId: b2 }).ok).toBe(false)
    // Sibling branch on the same anchor does not affect b1-0's sibling; create sibling and verify independence.
    const b3 = (okValue(agg.createBranch('t1', null, 'm1', 'B3')).branch as { id: string }).id
    seedSuffix(agg, 't1', b3, ['b3-0'])
    expect(agg.updateMessage('t1', 'b3-0', { content: 'e' } as never, { branchId: b3 }).ok).toBe(true)
    expect(agg.updateMessage('t1', 'b3-0', { content: 'x' } as never, { branchId: b1 }).ok).toBe(false)
    expect(b2.length).toBeGreaterThan(0)
  })

  it('post-anchor main rows and sibling routes stay mutable', () => {
    seedMain(agg, 't1', ['m0', 'm1', 'm2'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm1', 'B1')).branch as { id: string }).id
    // m2 is after the anchor: not in any descendant prefix.
    expect(agg.updateMessage('t1', 'm2', { content: 'e' } as never, { branchId: null }).ok).toBe(true)
    seedSuffix(agg, 't1', b1, ['b1-0'])
    expect(agg.updateMessage('t1', 'm2', { content: 'e2' } as never, { branchId: null }).ok).toBe(true)
  })

  it('multi-message non-owner rejection leaves owned rows untouched (no partial writes, BRANCH-12)', () => {
    seedMain(agg, 't1', ['m0', 'm1', 'm2'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm1', 'B1')).branch as { id: string }).id
    seedSuffix(agg, 't1', b1, ['c0'])
    // m2 owned by main (mutable), c0 owned by b1 (non-owner through main): batch must fail closed.
    const res = agg.deleteMessages('t1', ['m2', 'c0'], null)
    expect(res.ok).toBe(false)
    expect(contentOf(sqlite, 'm2')).toBe('content-m2')
    expect(contentOf(sqlite, 'c0')).toBe('content-c0')
  })

  it('cross-topic fail-closed with branch lineage; pure non-branch legacy bulk skip preserved (BRANCH-4)', () => {
    seedMain(agg, 't1', ['m0'])
    seedMain(agg, 't2', ['f0'])
    // Pure non-branch legacy: a foreign main-owned id through the main route
    // of a branch-less topic silently skips (ok, zero writes).
    const skip = agg.deleteMessages('t1', ['f0'], null)
    expect(skip.ok).toBe(true)
    expect(contentOf(sqlite, 'f0')).toBe('content-f0')
    expect(contentOf(sqlite, 'm0')).toBe('content-m0')
    // Same foreign id fail-closes once the addressed topic owns a branch.
    const b1 = (okValue(agg.createBranch('t1', null, 'm0', 'B1')).branch as { id: string }).id
    const viaTopicWithBranches = agg.deleteMessages('t1', ['f0'], null)
    expect(viaTopicWithBranches.ok).toBe(false)
    expect(contentOf(sqlite, 'f0')).toBe('content-f0')
    // Branch-route addressing of a foreign main-owned row fail-closes.
    const viaBranchRoute = agg.deleteMessages('t1', ['f0'], b1)
    expect(viaBranchRoute.ok).toBe(false)
    expect(contentOf(sqlite, 'f0')).toBe('content-f0')
    // Foreign branch-owned row fail-closes even through a branch-less addressed main route.
    seedMain(agg, 't3', ['m3'])
    const fb = (okValue(agg.createBranch('t2', null, 'f0', 'FB')).branch as { id: string }).id
    seedSuffix(agg, 't2', fb, ['fchild'])
    const viaForeignBranchOwned = agg.deleteMessages('t3', ['fchild'], null)
    expect(viaForeignBranchOwned.ok).toBe(false)
    expect(contentOf(sqlite, 'fchild')).toBe('content-fchild')
    expect(contentOf(sqlite, 'm3')).toBe('content-m3')
  })

  it('selectAnswer / resend follow owner-only: owner stays mutable when referenced, child read-only (BRANCH-4/12)', () => {
    const t = 't1'
    expect(agg.ensureTopic(t, 'as-1', 'topic').ok).toBe(true)
    expect(agg.appendMessage(t, msgJson('u1', t) as never, [blockJson('bu1', 'u1') as never]).ok).toBe(true)
    expect(
      agg.appendMessage(t, msgJson('a1', t, { role: 'assistant', askId: 'u1', assistantId: 'as-1' }) as never, [
        blockJson('ba1', 'a1') as never
      ]).ok
    ).toBe(true)
    // Owned baseline succeeds.
    expect(agg.selectAnswerMessage(t, 'a1', null).ok).toBe(true)
    expect(agg.resendUserMessages(t, 'u1', 'as-1', MODEL as never, null).ok).toBe(true)
    const b1 = (okValue(agg.createBranch(t, null, 'u1', 'B1')).branch as { id: string }).id
    // After forking through u1, owner keeps full control (butterfly effect): still succeeds.
    expect(agg.selectAnswerMessage(t, 'a1', null).ok).toBe(true)
    expect(agg.resendUserMessages(t, 'u1', 'as-1', MODEL as never, null).ok).toBe(true)
    // Inherited select rejects (no assistant members in the child effective route).
    expect(agg.selectAnswerMessage(t, 'a1', b1).ok).toBe(false)
    // Inherited resend creates a new branch-owned answer (does not mutate inherited members).
    expect(agg.resendUserMessages(t, 'u1', 'as-1', MODEL as never, b1).ok).toBe(true)
  })

  it('resend from child onto inherited group rejects with zero partial write; fork-at-user-root creates owned suffix (BRANCH-12)', () => {
    const t = 't-resend-neg'
    expect(agg.ensureTopic(t, 'as-1', 'topic').ok).toBe(true)
    expect(agg.appendMessage(t, msgJson('u1', t) as never, [blockJson('bu1', 'u1') as never]).ok).toBe(true)
    expect(
      agg.appendMessage(t, msgJson('a1', t, { role: 'assistant', askId: 'u1', assistantId: 'as-1' }) as never, [
        blockJson('ba1', 'a1') as never
      ]).ok
    ).toBe(true)
    const rowCount = (tid: string): number =>
      (sqlite.prepare('SELECT COUNT(*) AS n FROM messages WHERE topic_id=?').get(tid) as { n: number }).n
    const blockCountFor = (mid: string): number =>
      (sqlite.prepare('SELECT COUNT(*) AS n FROM message_blocks WHERE message_id=?').get(mid) as { n: number }).n
    // Negative: fork THROUGH a1, so the child effective route inherits the
    // group member; resending u1 from the child would reset non-child-owned
    // a1 and must fail closed with zero partial writes.
    const bNeg = (okValue(agg.createBranch(t, null, 'a1', 'BNEG')).branch as { id: string }).id
    const beforeContent = contentOf(sqlite, 'a1')
    const beforeRows = rowCount(t)
    const beforeBlocks = blockCountFor('a1')
    const neg = agg.resendUserMessages(t, 'u1', 'as-1', MODEL as never, bNeg)
    expect(neg.ok).toBe(false)
    expect(contentOf(sqlite, 'a1')).toBe(beforeContent)
    expect(rowCount(t)).toBe(beforeRows)
    expect(blockCountFor('a1')).toBe(beforeBlocks)
    // Positive (retained): fork at the user root leaves the child route empty
    // of answers; resending the root from the child creates a child-owned suffix.
    const t2 = 't-resend-pos'
    expect(agg.ensureTopic(t2, 'as-1', 'topic').ok).toBe(true)
    expect(agg.appendMessage(t2, msgJson('pu1', t2) as never, [blockJson('bpu1', 'pu1') as never]).ok).toBe(true)
    expect(
      agg.appendMessage(t2, msgJson('pa1', t2, { role: 'assistant', askId: 'pu1', assistantId: 'as-1' }) as never, [
        blockJson('bpa1', 'pa1') as never
      ]).ok
    ).toBe(true)
    const bPos = (okValue(agg.createBranch(t2, null, 'pu1', 'BPOS')).branch as { id: string }).id
    expect(agg.resendUserMessages(t2, 'pu1', 'as-1', MODEL as never, bPos).ok).toBe(true)
    const suffixOwners = sqlite
      .prepare('SELECT branch_id AS b FROM messages WHERE topic_id=? AND ask_id=?')
      .all(t2, 'pu1') as Array<{ b: string | null }>
    expect(suffixOwners.some((r) => r.b === bPos)).toBe(true)
    expect(contentOf(sqlite, 'a1')).toBe(beforeContent)
  })

  it('selectUsefulAnswer is group-atomic: unique useful, toggle-clear, owner stays mutable when referenced (BRANCH-12)', () => {
    const t = 't1'
    expect(agg.ensureTopic(t, 'as-1', 'topic').ok).toBe(true)
    expect(agg.appendMessage(t, msgJson('u1', t) as never, [blockJson('bu1', 'u1') as never]).ok).toBe(true)
    for (const a of ['a1', 'a2', 'a3']) {
      expect(
        agg.appendMessage(t, msgJson(a, t, { role: 'assistant', askId: 'u1', assistantId: 'as-1' }) as never, [
          blockJson(`b-${a}`, a) as never
        ]).ok
      ).toBe(true)
    }
    const usefulOf = (id: string): boolean => {
      const row = sqlite.prepare('SELECT extra AS e FROM messages WHERE id=?').get(id) as { e: string | null }
      if (!row?.e) return false
      try {
        return (JSON.parse(row.e) as { useful?: unknown }).useful === true
      } catch {
        return false
      }
    }
    // Success: exactly the target is useful (all members incl. window-outside validated + written).
    const r1 = agg.selectUsefulAnswer(t, 'a2', null)
    expect(r1.ok).toBe(true)
    if (r1.ok) {
      expect(r1.value.usefulMessageId).toBe('a2')
      expect(r1.value.messageIds).toEqual(['a1', 'a2', 'a3'])
    }
    expect(usefulOf('a2')).toBe(true)
    expect(usefulOf('a1')).toBe(false)
    expect(usefulOf('a3')).toBe(false)
    // Toggle: selecting the already-useful member clears the whole group.
    const r2 = agg.selectUsefulAnswer(t, 'a2', null)
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.value.usefulMessageId).toBeNull()
    expect(usefulOf('a1')).toBe(false)
    expect(usefulOf('a2')).toBe(false)
    expect(usefulOf('a3')).toBe(false)
    // Set a1 useful, then fork through the user root: the group is shared.
    expect(agg.selectUsefulAnswer(t, 'a1', null).ok).toBe(true)
    expect(usefulOf('a1')).toBe(true)
    const b1 = (okValue(agg.createBranch(t, null, 'u1', 'B1')).branch as { id: string }).id
    // Owner keeps full control when referenced (BRANCH-4); inherited route rejects (read-only).
    expect(agg.selectUsefulAnswer(t, 'a2', null).ok).toBe(true)
    expect(agg.selectUsefulAnswer(t, 'a1', b1).ok).toBe(false)
    // No partial write on the failed child attempt: the owner write above stands.
    expect(usefulOf('a2')).toBe(true)
    expect(usefulOf('a1')).toBe(false)
    expect(usefulOf('a3')).toBe(false)
  })

  it('nested descendant references do not lock the owner answer group (BRANCH-4)', () => {
    const t = 't1'
    expect(agg.ensureTopic(t, 'as-1', 'topic').ok).toBe(true)
    expect(agg.appendMessage(t, msgJson('u1', t) as never, [blockJson('bu1', 'u1') as never]).ok).toBe(true)
    expect(
      agg.appendMessage(t, msgJson('a1', t, { role: 'assistant', askId: 'u1', assistantId: 'as-1' }) as never, [
        blockJson('ba1', 'a1') as never
      ]).ok
    ).toBe(true)
    const b1 = (okValue(agg.createBranch(t, null, 'u1', 'B1')).branch as { id: string }).id
    // b1-owned answer group (user root u9 + assistant g1) starts owned.
    expect(
      agg.appendMessage(
        t,
        msgJson('u9', t, { role: 'user' }) as never,
        [blockJson('bu9', 'u9') as never],
        undefined,
        undefined,
        { branchId: b1 }
      ).ok
    ).toBe(true)
    expect(
      agg.appendMessage(
        t,
        msgJson('g1', t, { role: 'assistant', askId: 'u9', assistantId: 'as-1' }) as never,
        [blockJson('bg1', 'g1') as never],
        undefined,
        undefined,
        { branchId: b1 }
      ).ok
    ).toBe(true)
    // Baseline: b1-owned group is mutable through b1.
    expect(agg.selectUsefulAnswer(t, 'g1', b1).ok).toBe(true)
    const b3 = (okValue(agg.createBranch(t, b1, 'g1', 'B3')).branch as { id: string }).id
    void b3
    // g1 is referenced by grandchild b3 but stays mutable through its owner b1 (BRANCH-4).
    expect(agg.selectUsefulAnswer(t, 'g1', b1).ok).toBe(true)
    expect(agg.selectAnswerMessage(t, 'g1', b1).ok).toBe(true)
  })

  it('reorder owner-only; append onto inherited groups lands as owned suffix (BRANCH-4/12)', () => {
    const t = 't1'
    expect(agg.ensureTopic(t, 'as-1', 'topic').ok).toBe(true)
    expect(agg.appendMessage(t, msgJson('u1', t) as never, [blockJson('bu1', 'u1') as never]).ok).toBe(true)
    for (const a of ['a1', 'a2']) {
      expect(
        agg.appendMessage(t, msgJson(a, t, { role: 'assistant', askId: 'u1', assistantId: 'as-1' }) as never, [
          blockJson(`b-${a}`, a) as never
        ]).ok
      ).toBe(true)
    }
    // Owner baseline: reorder + join-group append succeed.
    expect(agg.reorderAnswerGroup(t, 'a1', ['a2', 'a1'], null).ok).toBe(true)
    const joinEntry = (
      id: string,
      askId: string
    ): { message: Record<string, unknown>; blocks: Record<string, unknown>[] } => ({
      message: msgJson(id, t, { role: 'assistant', askId, assistantId: 'as-1' }),
      blocks: []
    })
    expect(agg.insertMessagesAfterAnchor(t, 'a1', [joinEntry('a3', 'u1') as never], null).ok).toBe(true)
    // Fork through the last pre-fork group member so the child effective
    // route truly inherits the group (u1/a1/a2 readable, read-only).
    const b1 = (okValue(agg.createBranch(t, null, 'a3', 'B1')).branch as { id: string }).id
    const childRouteIds = (okValue(agg.fetchMessages(t, b1)).messages as Array<{ id: string }>).map((m) => m.id)
    expect(childRouteIds).toEqual(expect.arrayContaining(['u1', 'a1', 'a2']))
    // Referenced owner group stays reorderable/appendable through the owner (BRANCH-4 butterfly).
    expect(agg.reorderAnswerGroup(t, 'a1', ['a1', 'a2', 'a3'], null).ok).toBe(true)
    expect(agg.insertMessagesAfterAnchor(t, 'a1', [joinEntry('a4', 'u1') as never], null).ok).toBe(true)
    // Appending onto the inherited group from the child lands as an owned
    // suffix (anchor u1 is readable in the child effective route; read does
    // not block write). Under the removed join-group descendant/private
    // guard this would reject (existing group members non-owned through the
    // child); BRANCH-4/12 allows it as a genuinely new suffix row.
    expect(agg.insertMessagesAfterAnchor(t, 'u1', [joinEntry('a5', 'u1') as never], b1).ok).toBe(true)
    expect(contentOf(sqlite, 'a4')).not.toBeNull()
    expect(contentOf(sqlite, 'a5')).not.toBeNull()
    const a5branch = sqlite.prepare('SELECT branch_id AS b FROM messages WHERE id=?').get('a5') as {
      b: string | null
    }
    expect(a5branch.b).toBe(b1)
    // Fresh askId (new suffix changing no existing group) stays allowed on both routes.
    expect(agg.insertMessagesAfterAnchor(t, 'a2', [joinEntry('n1', 'u-new') as never], null).ok).toBe(true)
    expect(agg.insertMessagesAfterAnchor(t, 'u1', [joinEntry('n2', 'u-new2') as never], b1).ok).toBe(true)
  })

  it('batch delete/segment atomicity keeps non-owner rejection without descendant locks (BRANCH-12)', () => {
    const t = 't1'
    expect(agg.ensureTopic(t, 'as-1', 'topic').ok).toBe(true)
    expect(agg.appendMessage(t, msgJson('u1', t) as never, [blockJson('bu1', 'u1') as never]).ok).toBe(true)
    expect(
      agg.appendMessage(t, msgJson('a1', t, { role: 'assistant', askId: 'u1', assistantId: 'as-1' }) as never, [
        blockJson('ba1', 'a1') as never
      ]).ok
    ).toBe(true)
    expect(agg.appendMessage(t, msgJson('m2', t) as never, [blockJson('bm2', 'm2') as never]).ok).toBe(true)
    const b1 = (okValue(agg.createBranch(t, null, 'u1', 'B1')).branch as { id: string }).id
    seedSuffix(agg, t, b1, ['c0'])
    // Non-owner batch rejects atomically: main-owned m2 + branch-owned c0 through main.
    const del = agg.deleteMessagesWithDependents(t, ['m2', 'c0'], null)
    expect(del.ok).toBe(false)
    expect(contentOf(sqlite, 'm2')).toBe('content-m2')
    expect(contentOf(sqlite, 'c0')).toBe('content-c0')
    // Owner batch with referenced rows succeeds (butterfly): main can delete its own prefix.
    const delOwner = agg.deleteMessagesWithDependents(t, ['m2'], null)
    expect(delOwner.ok).toBe(true)
    expect(contentOf(sqlite, 'm2')).toBeNull()
    // Segment: owned members segmentable even when referenced; ancestor refs reject through child.
    expect(agg.upsertSegment('seg-owner', t, 'owner', ['u1'], null, null).ok).toBe(true)
    expect(agg.upsertSegment('seg-child-bad', t, 'bad', ['u1'], null, b1).ok).toBe(false)
    expect(agg.upsertSegment('seg-child-good', t, 'good', ['c0'], null, b1).ok).toBe(true)
    expect(agg.replaceSegmentMembership('seg-owner', ['u1', 'a1'], null).ok).toBe(true)
    const segs = agg.listSegments(t)
    expect(segs.ok).toBe(true)
    if (segs.ok) {
      const owner = segs.value.find((s) => s.id === 'seg-owner')
      expect(owner?.messageIds).toEqual(['u1', 'a1'])
      expect(segs.value.some((s) => s.id === 'seg-child-bad')).toBe(false)
      expect(segs.value.some((s) => s.id === 'seg-child-good')).toBe(true)
    }
  })
})

describe('stable identity (no prefix copies)', () => {
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
    agg = new ChatDbAggregateService(db, sqlite)
  })
  afterEach(() => {
    try {
      sqlite.close()
    } catch {}
    rmrf(dir)
  })

  it('anchor-before IDs+content match across routes and row count has no copies', () => {
    seedMain(agg, 't1', ['m0', 'm1', 'm2', 'm3'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm1', 'B1')).branch as { id: string }).id
    seedSuffix(agg, 't1', b1, ['c0', 'c1'])
    const main = okValue(agg.fetchMessages('t1', null)).messages as Array<{ id: string; content: string }>
    const branch = okValue(agg.fetchMessages('t1', b1)).messages as Array<{ id: string; content: string }>
    expect(main.map((m) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3'])
    expect(branch.map((m) => m.id)).toEqual(['m0', 'm1', 'c0', 'c1'])
    for (const id of ['m0', 'm1']) {
      expect(branch.find((m) => m.id === id)?.content).toBe(main.find((m) => m.id === id)?.content)
    }
    const rows = sqlite.prepare('SELECT COUNT(*) AS n FROM messages WHERE topic_id=?').get('t1') as { n: number }
    expect(rows.n).toBe(4 + 2)
  })
})

describe('owner block writes stay mutable when referenced (BRANCH-4, no translation lock)', () => {
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
    agg = new ChatDbAggregateService(db, sqlite)
  })
  afterEach(() => {
    try {
      sqlite.close()
    } catch {}
    rmrf(dir)
  })

  it('referenced owner translation blocks stay writable; descendant references stay read-only', () => {
    seedMain(agg, 't1', ['m0', 'm1'])
    // Simulate translation initiate: add a translation block through the owner route.
    expect(
      agg.updateMessageAndBlocks(
        't1',
        { id: 'm1', content: 'content-m1' } as never,
        [blockJson('b-m1-tr', 'm1', { type: 'translation', content: 'hola' }) as never],
        [],
        { branchId: null }
      ).ok
    ).toBe(true)
    const b1 = (okValue(agg.createBranch('t1', null, 'm1', 'B1')).branch as { id: string }).id
    // Parent m1 is referenced by b1 but stays writable through its owner (BRANCH-4 butterfly).
    expect(agg.updateSingleBlock('b-m1-tr', { content: 'changed' } as never).ok).toBe(true)
    const row = sqlite.prepare('SELECT content AS c FROM message_blocks WHERE id=?').get('b-m1-tr') as { c: string }
    expect(row.c).toBe('changed')
    expect(agg.deleteBranch('t1', b1).ok).toBe(true)
    expect(agg.updateSingleBlock('b-m1-tr', { content: 'changed2' } as never).ok).toBe(true)
    const after = sqlite.prepare('SELECT content AS c FROM message_blocks WHERE id=?').get('b-m1-tr') as {
      c: string
    }
    expect(after.c).toBe('changed2')
  })
})

describe('window mutation capability', () => {
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
    agg = new ChatDbAggregateService(db, sqlite)
  })
  afterEach(() => {
    try {
      sqlite.close()
    } catch {}
    rmrf(dir)
  })

  it('mutableMessageIds is the precise owned subset of the returned window (BRANCH-9)', () => {
    seedMain(agg, 't1', ['m0', 'm1', 'm2'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm1', 'B1')).branch as { id: string }).id
    seedSuffix(agg, 't1', b1, ['c0'])
    // Owner route contains every owned ID in the window even when referenced (no descendant shrink).
    const mainWin = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: 't1', limit: 10 }))
    expect(mainWin.mutableMessageIds).toEqual(['m0', 'm1', 'm2'])
    // Descendant window contains only descendant-owned suffix, never ancestor refs.
    const branchWin = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: 't1', branchId: b1, limit: 10 }))
    expect(branchWin.mutableMessageIds).toEqual(['c0'])
    // Around window trims content but capability still derives from the returned window owned subset.
    const around = okValue(
      agg.fetchMessagesWindow({
        kind: 'around',
        topicId: 't1',
        branchId: b1,
        anchorMessageId: 'm1',
        before: 1,
        after: 1
      })
    )
    expect(around.messages.map((m) => (m as { id: string }).id)).toContain('m1')
    expect(around.mutableMessageIds).toEqual(['c0'])
  })

  it('branch create does not shrink owner capability; delete keeps it (BRANCH-4/9)', () => {
    seedMain(agg, 't1', ['m0', 'm1', 'm2'])
    const before = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: 't1', limit: 10 }))
    expect(new Set(before.mutableMessageIds)).toEqual(new Set(['m0', 'm1', 'm2']))
    const b1 = (okValue(agg.createBranch('t1', null, 'm1', 'B1')).branch as { id: string }).id
    const afterCreate = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: 't1', limit: 10 }))
    expect(new Set(afterCreate.mutableMessageIds)).toEqual(new Set(['m0', 'm1', 'm2']))
    expect(agg.deleteBranch('t1', b1).ok).toBe(true)
    const afterDelete = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: 't1', limit: 10 }))
    expect(new Set(afterDelete.mutableMessageIds)).toEqual(new Set(['m0', 'm1', 'm2']))
  })
})

describe('true-branch butterfly effect and missing anchor (BRANCH-5)', () => {
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

  it('owner content edit is visible in the child effective route under the same stable ID', () => {
    seedMain(agg, 't1', ['m0', 'm1', 'm2'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm1', 'B1')).branch as { id: string }).id
    seedSuffix(agg, 't1', b1, ['c0'])
    expect(agg.updateMessage('t1', 'm1', { content: 'owner-v2' } as never, { branchId: null }).ok).toBe(true)
    const child = okValue(agg.fetchMessages('t1', b1)).messages as Array<{ id: string; content: string }>
    expect(child.find((m) => m.id === 'm1')?.content).toBe('owner-v2')
  })

  it('deleting an ordinary prefix shortens the child route; reordering changes the child effective prefix', () => {
    seedMain(agg, 't1', ['m0', 'm1', 'm2', 'm3'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm1', 'B1')).branch as { id: string }).id
    seedSuffix(agg, 't1', b1, ['c0'])
    expect(agg.deleteMessage('t1', 'm0', null).ok).toBe(true)
    const afterDelete = okValue(agg.fetchMessages('t1', b1)).messages as Array<{ id: string }>
    expect(afterDelete.map((m) => m.id)).toEqual(['m1', 'c0'])
    expect(agg.reorderMessages('t1', ['m2', 'm1', 'm3'], null).ok).toBe(true)
    const afterReorder = okValue(agg.fetchMessages('t1', b1)).messages as Array<{ id: string }>
    // Child effective prefix follows the owner order: anchor m1 with owner-ordered prefix + owned suffix.
    expect(afterReorder.map((m) => m.id)).toEqual(['m2', 'm1', 'c0'])
  })

  it('deleting a branch anchor fail-closes dependent routes but keeps branch metadata (BRANCH-5)', () => {
    seedMain(agg, 't1', ['m0', 'm1', 'm2'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm1', 'B1')).branch as { id: string }).id
    seedSuffix(agg, 't1', b1, ['b1-0'])
    const b2 = (okValue(agg.createBranch('t1', b1, 'b1-0', 'B2')).branch as { id: string }).id
    // Owner deletes the child anchor b1-0 through its owner route.
    expect(agg.deleteMessage('t1', 'b1-0', b1).ok).toBe(true)
    // Dependent grandchild route now resolves fail-closed (missing anchor).
    expect(agg.fetchMessages('t1', b2).ok).toBe(false)
    expect(agg.fetchMessagesWindow({ kind: 'latest', topicId: 't1', branchId: b2, limit: 10 }).ok).toBe(false)
    // Branch metadata is retained (no silent cascade delete).
    const listed = okValue(agg.listBranches('t1')).branches as Array<{ id: string }>
    expect(listed.map((b) => b.id)).toContain(b2)
    // Deleting the owner anchor m1 fail-closes the child route the same way.
    expect(agg.deleteMessage('t1', 'm1', null).ok).toBe(true)
    expect(agg.fetchMessages('t1', b1).ok).toBe(false)
    const listed2 = okValue(agg.listBranches('t1')).branches as Array<{ id: string }>
    expect(listed2.map((b) => b.id)).toContain(b1)
  })

  it('branch-owned suffix referenced by a nested descendant stays mutable through its owner only', () => {
    seedMain(agg, 't1', ['m0', 'm1'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm1', 'B1')).branch as { id: string }).id
    seedSuffix(agg, 't1', b1, ['b1-0', 'b1-1'])
    const b2 = (okValue(agg.createBranch('t1', b1, 'b1-0', 'B2')).branch as { id: string }).id
    expect(agg.updateMessage('t1', 'b1-0', { content: 'owner-edit' } as never, { branchId: b1 }).ok).toBe(true)
    expect(agg.deleteMessage('t1', 'b1-0', b2).ok).toBe(false)
    expect(agg.reorderMessages('t1', ['b1-1', 'b1-0'], b1).ok).toBe(true)
    expect(agg.reorderMessages('t1', ['b1-1', 'b1-0'], b2).ok).toBe(false)
  })

  it('regenerate follows actual-target owner: owner succeeds when referenced, child rejects inherited', () => {
    const t = 't1'
    expect(agg.ensureTopic(t, 'as-1', 'topic').ok).toBe(true)
    expect(agg.appendMessage(t, msgJson('u1', t) as never, [blockJson('bu1', 'u1') as never]).ok).toBe(true)
    expect(
      agg.appendMessage(t, msgJson('a1', t, { role: 'assistant', askId: 'u1', assistantId: 'as-1' }) as never, [
        blockJson('ba1', 'a1') as never
      ]).ok
    ).toBe(true)
    const b1 = (okValue(agg.createBranch(t, null, 'u1', 'B1')).branch as { id: string }).id
    expect(agg.regenerateAssistantMessage(t, 'a1', 'as-1', MODEL as never, null).ok).toBe(true)
    expect(agg.regenerateAssistantMessage(t, 'a1', 'as-1', MODEL as never, b1).ok).toBe(false)
  })
})
