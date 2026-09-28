/**
 * Branch mutation guard matrix + stable identity + translation lock + window
 * capability (016 model, no overlay).
 *
 * - messages.branch_id is ownership only; topic_branches defines ancestry.
 * - Current-route-owned AND not covered by any live descendant effective
 *   prefix (anchor-inclusive) is mutable; inherited/shared prefixes reject.
 * - Sibling suffixes never lock each other; post-anchor main rows stay mutable.
 * - Rejections leave the DB unchanged (no partial writes).
 * - Window `mutableMessageIds` is Main-authoritative per response.
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

  it('main owned-unshared messages accept all mutation kinds through the null route', () => {
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

  it('inherited rows and parent-owned live-descendant prefixes reject through every route', () => {
    seedMain(agg, 't1', ['m0', 'm1', 'm2'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm1', 'B1')).branch as { id: string }).id
    // Inherited via the child route.
    expect(agg.updateMessage('t1', 'm0', { content: 'x' } as never, { branchId: b1 }).ok).toBe(false)
    expect(agg.deleteMessage('t1', 'm1', b1).ok).toBe(false)
    // Parent-owned but covered by the live descendant prefix via the owner route.
    expect(agg.updateMessage('t1', 'm1', { content: 'x' } as never, { branchId: null }).ok).toBe(false)
    expect(agg.updateMessageAndBlocks('t1', { id: 'm0', content: 'x' } as never, [], [], { branchId: null }).ok).toBe(
      false
    )
    expect(contentOf(sqlite, 'm0')).toBe('content-m0')
    expect(contentOf(sqlite, 'm1')).toBe('content-m1')
  })

  it('grandchild coverage locks the ancestor prefix; sibling suffixes stay independent', () => {
    seedMain(agg, 't1', ['m0', 'm1', 'm2'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm1', 'B1')).branch as { id: string }).id
    seedSuffix(agg, 't1', b1, ['b1-0'])
    const b2 = (okValue(agg.createBranch('t1', b1, 'b1-0', 'B2')).branch as { id: string }).id
    // b1-0 is covered by grandchild b2 (parent route sliced through anchor).
    expect(agg.updateMessage('t1', 'b1-0', { content: 'x' } as never, { branchId: b1 }).ok).toBe(false)
    // Sibling branch on the same anchor does not lock b1-0's sibling; create sibling and verify independence.
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

  it('multi-message rejection leaves owned rows untouched (no partial writes)', () => {
    seedMain(agg, 't1', ['m0', 'm1', 'm2'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm1', 'B1')).branch as { id: string }).id
    void b1
    // m2 owned-unshared (mutable), m0 shared (immutable): batch must fail closed.
    const res = agg.deleteMessages('t1', ['m2', 'm0'], null)
    expect(res.ok).toBe(false)
    expect(contentOf(sqlite, 'm2')).toBe('content-m2')
    expect(contentOf(sqlite, 'm0')).toBe('content-m0')
  })

  it('selectAnswer / resend / regenerate follow the same ownership guard', () => {
    const t = 't1'
    expect(agg.ensureTopic(t, 'as-1', 'topic').ok).toBe(true)
    expect(agg.appendMessage(t, msgJson('u1', t) as never, [blockJson('bu1', 'u1') as never]).ok).toBe(true)
    expect(
      agg.appendMessage(t, msgJson('a1', t, { role: 'assistant', askId: 'u1', assistantId: 'as-1' }) as never, [
        blockJson('ba1', 'a1') as never
      ]).ok
    ).toBe(true)
    // Owned-unshared baseline succeeds.
    expect(agg.selectAnswerMessage(t, 'a1', null).ok).toBe(true)
    expect(agg.resendUserMessages(t, 'u1', 'as-1', MODEL as never, null).ok).toBe(true)
    const b1 = (okValue(agg.createBranch(t, null, 'u1', 'B1')).branch as { id: string }).id
    // After forking through u1, u1/a1 are shared: owner-route resend/select reject.
    expect(agg.selectAnswerMessage(t, 'a1', null).ok).toBe(false)
    expect(agg.resendUserMessages(t, 'u1', 'as-1', MODEL as never, null).ok).toBe(false)
    // Inherited through the child route also rejects.
    expect(agg.selectAnswerMessage(t, 'a1', b1).ok).toBe(false)
  })

  it('selectUsefulAnswer is group-atomic: unique useful, toggle-clear, shared rejects without partial writes', () => {
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
    // Owner route rejects (shared prefix); inherited route rejects too.
    expect(agg.selectUsefulAnswer(t, 'a2', null).ok).toBe(false)
    expect(agg.selectUsefulAnswer(t, 'a1', b1).ok).toBe(false)
    // No partial write: the pre-fork useful assignment stands untouched.
    expect(usefulOf('a1')).toBe(true)
    expect(usefulOf('a2')).toBe(false)
    expect(usefulOf('a3')).toBe(false)
  })

  it('grandchild coverage locks the answer group useful/select through the parent route', () => {
    const t = 't1'
    expect(agg.ensureTopic(t, 'as-1', 'topic').ok).toBe(true)
    expect(agg.appendMessage(t, msgJson('u1', t) as never, [blockJson('bu1', 'u1') as never]).ok).toBe(true)
    expect(
      agg.appendMessage(t, msgJson('a1', t, { role: 'assistant', askId: 'u1', assistantId: 'as-1' }) as never, [
        blockJson('ba1', 'a1') as never
      ]).ok
    ).toBe(true)
    const b1 = (okValue(agg.createBranch(t, null, 'u1', 'B1')).branch as { id: string }).id
    // b1-owned answer group (user root u9 + assistant g1) starts private.
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
    // g1 is now covered by grandchild b3: parent-route (b1) useful/select reject.
    expect(agg.selectUsefulAnswer(t, 'g1', b1).ok).toBe(false)
    expect(agg.selectAnswerMessage(t, 'g1', b1).ok).toBe(false)
  })

  it('reorder/append-join require the full group private; fresh suffixes stay allowed', () => {
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
    // Private baseline: reorder + join-group append succeed.
    expect(agg.reorderAnswerGroup(t, 'a1', ['a2', 'a1'], null).ok).toBe(true)
    const joinEntry = (
      id: string,
      askId: string
    ): { message: Record<string, unknown>; blocks: Record<string, unknown>[] } => ({
      message: msgJson(id, t, { role: 'assistant', askId, assistantId: 'as-1' }),
      blocks: []
    })
    expect(agg.insertMessagesAfterAnchor(t, 'a1', [joinEntry('a3', 'u1') as never], null).ok).toBe(true)
    const b1 = (okValue(agg.createBranch(t, null, 'u1', 'B1')).branch as { id: string }).id
    // Shared group: reorder rejects, join-group append rejects, inherited route rejects.
    expect(agg.reorderAnswerGroup(t, 'a1', ['a1', 'a2', 'a3'], null).ok).toBe(false)
    expect(agg.insertMessagesAfterAnchor(t, 'a1', [joinEntry('a4', 'u1') as never], null).ok).toBe(false)
    expect(agg.insertMessagesAfterAnchor(t, 'a1', [joinEntry('a5', 'u1') as never], b1).ok).toBe(false)
    expect(contentOf(sqlite, 'a4')).toBeNull()
    expect(contentOf(sqlite, 'a5')).toBeNull()
    // Fresh askId (new private suffix changing no existing group) stays allowed on both routes.
    expect(agg.insertMessagesAfterAnchor(t, 'a2', [joinEntry('n1', 'u-new') as never], null).ok).toBe(true)
    expect(agg.insertMessagesAfterAnchor(t, 'u1', [joinEntry('n2', 'u-new2') as never], b1).ok).toBe(true)
  })

  it('batch delete-with-dependents and segment writes reject mixed private/shared atomically', () => {
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
    void b1
    // m2 is owned-unshared (mutable), u1 is shared: the batch rejects with nothing deleted.
    const del = agg.deleteMessagesWithDependents(t, ['m2', 'u1'], null)
    expect(del.ok).toBe(false)
    expect(contentOf(sqlite, 'm2')).toBe('content-m2')
    expect(contentOf(sqlite, 'u1')).toBe('content-u1')
    // Segment membership joining a shared message rejects; pure-private succeeds.
    expect(agg.upsertSegment('seg-shared', t, 'shared', ['m2', 'u1'], null, null).ok).toBe(false)
    expect(agg.upsertSegment('seg-private', t, 'private', ['m2'], null, null).ok).toBe(true)
    expect(agg.replaceSegmentMembership('seg-private', ['m2', 'u1'], null).ok).toBe(false)
    const segs = agg.listSegments(t)
    expect(segs.ok).toBe(true)
    if (segs.ok) {
      const priv = segs.value.find((s) => s.id === 'seg-private')
      expect(priv?.messageIds).toEqual(['m2'])
      expect(segs.value.some((s) => s.id === 'seg-shared')).toBe(false)
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

describe('translation lock (streaming block path)', () => {
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

  it('shared parent translation blocks reject streaming writes until the child is deleted', () => {
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
    // Parent m1 is now shared: streaming update rejects and content is unchanged.
    expect(agg.updateSingleBlock('b-m1-tr', { content: 'changed' } as never).ok).toBe(false)
    const row = sqlite.prepare('SELECT content AS c FROM message_blocks WHERE id=?').get('b-m1-tr') as { c: string }
    expect(row.c).toBe('hola')
    expect(agg.deleteBranch('t1', b1).ok).toBe(true)
    expect(agg.updateSingleBlock('b-m1-tr', { content: 'changed' } as never).ok).toBe(true)
    const after = sqlite.prepare('SELECT content AS c FROM message_blocks WHERE id=?').get('b-m1-tr') as {
      c: string
    }
    expect(after.c).toBe('changed')
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

  it('mutableMessageIds is the precise owned-unshared subset of the returned window', () => {
    seedMain(agg, 't1', ['m0', 'm1', 'm2'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm1', 'B1')).branch as { id: string }).id
    seedSuffix(agg, 't1', b1, ['c0'])
    const mainWin = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: 't1', limit: 10 }))
    expect(mainWin.mutableMessageIds).toEqual(['m2'])
    const branchWin = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: 't1', branchId: b1, limit: 10 }))
    expect(branchWin.mutableMessageIds).toEqual(['c0'])
    // Around window trims content but capability still derives from the full route.
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

  it('branch create shrinks and branch delete restores the parent capability', () => {
    seedMain(agg, 't1', ['m0', 'm1', 'm2'])
    const before = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: 't1', limit: 10 }))
    expect(new Set(before.mutableMessageIds)).toEqual(new Set(['m0', 'm1', 'm2']))
    const b1 = (okValue(agg.createBranch('t1', null, 'm1', 'B1')).branch as { id: string }).id
    const afterCreate = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: 't1', limit: 10 }))
    expect(afterCreate.mutableMessageIds).toEqual(['m2'])
    expect(agg.deleteBranch('t1', b1).ok).toBe(true)
    const afterDelete = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: 't1', limit: 10 }))
    expect(new Set(afterDelete.mutableMessageIds)).toEqual(new Set(['m0', 'm1', 'm2']))
  })
})
