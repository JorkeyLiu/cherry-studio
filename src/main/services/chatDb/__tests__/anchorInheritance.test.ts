/**
 * Branch / cross-topic-reference inheritance boundary.
 *
 * - A child route inherits its parent's effective history up to the original
 *   fork point. When the anchored message is deleted, the boundary moves to the
 *   nearest surviving message before it (single, consecutive, and batch
 *   deletes), so the child keeps the history it actually inherited.
 * - When no predecessor survives, the inherited history is empty while the
 *   branch and its own messages stay readable and writable. History after the
 *   original fork point is never inherited (no fabricating a parent tail).
 * - The same boundary rule serves reference clones: a deleted source endpoint
 *   shortens the live prefix instead of dropping it.
 * - Deleting a branch object keeps the existing subtree cascade; deleting a
 *   message or emptying a parent route never deletes a branch or a reference
 *   clone, and a gone source route/topic never cascades into the clone.
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

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-anchor-boundary-'))
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

describe('branch/reference inheritance boundary', () => {
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

  it('single anchor delete moves the boundary to the nearest surviving predecessor', () => {
    seedMain(agg, 't1', ['m0', 'm1', 'm2'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm1', 'B1')).branch as { id: string }).id
    seedSuffix(agg, 't1', b1, ['c0'])

    expect(agg.deleteMessage('t1', 'm1', null).ok).toBe(true)

    expect(persistedAnchor(sqlite, b1)).toBe('m0')
    expect(routeIds(agg, 't1', b1)).toEqual(['m0', 'c0'])
    // The branch itself is never deleted by a message delete.
    expect((okValue(agg.listBranches('t1')).branches as Array<{ id: string }>).map((b) => b.id)).toContain(b1)
  })

  it('batch delete including the anchor skips every deleted id', () => {
    seedMain(agg, 't1', ['m0', 'm1', 'm2', 'm3'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm2', 'B1')).branch as { id: string }).id
    seedSuffix(agg, 't1', b1, ['c0'])

    expect(agg.deleteMessages('t1', ['m1', 'm2'], null).ok).toBe(true)

    expect(persistedAnchor(sqlite, b1)).toBe('m0')
    expect(routeIds(agg, 't1', b1)).toEqual(['m0', 'c0'])
  })

  it('successive deletes keep walking back; an emptied prefix leaves the own suffix readable and writable', () => {
    seedMain(agg, 't1', ['m0', 'm1', 'm2'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm2', 'B1')).branch as { id: string }).id
    seedSuffix(agg, 't1', b1, ['c0'])

    expect(agg.deleteMessage('t1', 'm2', null).ok).toBe(true)
    expect(persistedAnchor(sqlite, b1)).toBe('m1')
    expect(agg.deleteMessage('t1', 'm1', null).ok).toBe(true)
    expect(persistedAnchor(sqlite, b1)).toBe('m0')
    expect(agg.deleteMessage('t1', 'm0', null).ok).toBe(true)

    // No surviving predecessor: inherited history is empty, own rows remain.
    expect(routeIds(agg, 't1', b1)).toEqual(['c0'])
    expect(routeIds(agg, 't1', null)).toEqual([])

    // Own suffix stays writable through the branch route.
    seedSuffix(agg, 't1', b1, ['c1'])
    expect(routeIds(agg, 't1', b1)).toEqual(['c0', 'c1'])
    expect(agg.updateMessage('t1', 'c0', { content: 'edited' } as never, { branchId: b1 }).ok).toBe(true)
    expect(agg.deleteMessage('t1', 'c1', b1).ok).toBe(true)
    expect(routeIds(agg, 't1', b1)).toEqual(['c0'])
  })

  it('multi-level branches keep composing after an intermediate anchor is deleted', () => {
    seedMain(agg, 't1', ['m0', 'm1', 'm2'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm1', 'B1')).branch as { id: string }).id
    seedSuffix(agg, 't1', b1, ['b1-0', 'b1-1'])
    const b2 = (okValue(agg.createBranch('t1', b1, 'b1-1', 'B2')).branch as { id: string }).id
    seedSuffix(agg, 't1', b2, ['b2-0'])
    const b3 = (okValue(agg.createBranch('t1', b2, 'b2-0', 'B3')).branch as { id: string }).id
    seedSuffix(agg, 't1', b3, ['b3-0'])
    expect(routeIds(agg, 't1', b3)).toEqual(['m0', 'm1', 'b1-0', 'b1-1', 'b2-0', 'b3-0'])

    // Owner deletes the intermediate anchor through its own route.
    expect(agg.deleteMessage('t1', 'b1-1', b1).ok).toBe(true)
    expect(persistedAnchor(sqlite, b2)).toBe('b1-0')
    expect(routeIds(agg, 't1', b2)).toEqual(['m0', 'm1', 'b1-0', 'b2-0'])
    expect(routeIds(agg, 't1', b3)).toEqual(['m0', 'm1', 'b1-0', 'b2-0', 'b3-0'])

    // Deleting the first-level anchor shortens every descendant the same way.
    expect(agg.deleteMessage('t1', 'm1', null).ok).toBe(true)
    expect(routeIds(agg, 't1', b1)).toEqual(['m0', 'b1-0'])
    expect(routeIds(agg, 't1', b2)).toEqual(['m0', 'b1-0', 'b2-0'])
    expect(routeIds(agg, 't1', b3)).toEqual(['m0', 'b1-0', 'b2-0', 'b3-0'])
  })

  it('deleting a branch object keeps the implemented subtree cascade (siblings survive)', () => {
    seedMain(agg, 't1', ['m0', 'm1'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm0', 'B1')).branch as { id: string }).id
    seedSuffix(agg, 't1', b1, ['s1'])
    const b2 = (okValue(agg.createBranch('t1', b1, 's1', 'B2')).branch as { id: string }).id
    seedSuffix(agg, 't1', b2, ['s2'])
    const sibling = (okValue(agg.createBranch('t1', null, 'm0', 'S')).branch as { id: string }).id
    seedSuffix(agg, 't1', sibling, ['s3'])

    const deleted = okValue(agg.deleteBranch('t1', b1))

    expect(deleted.deletedBranchIds).toEqual(expect.arrayContaining([b1, b2]))
    expect(deleted.deletedMessageIds).toEqual(expect.arrayContaining(['s1', 's2']))
    const rows = sqlite.prepare('SELECT id FROM messages ORDER BY id').all() as Array<{ id: string }>
    expect(rows.map((r) => r.id)).toEqual(['m0', 'm1', 's3'])
    // Sibling subtree and the main route are untouched.
    expect(routeIds(agg, 't1', sibling)).toEqual(['m0', 's3'])
    expect(routeIds(agg, 't1', null)).toEqual(['m0', 'm1'])
  })

  it('reference clones follow the same boundary rule and never cascade from a source branch delete', () => {
    seedMain(agg, 'src', ['s0', 's1', 's2'])
    okValue(agg.createReferencedTopic('src', null, 'ref', 's2'))
    expect(agg.appendMessage('ref', msgJson('r0', 'ref') as never, [blockJson('b-r0', 'r0') as never]).ok).toBe(true)
    expect(routeIds(agg, 'ref', null)).toEqual(['s0', 's1', 's2', 'r0'])

    // Deleting the captured endpoint shortens the live prefix instead of it
    // disappearing: the same nearest-surviving-predecessor rule applies.
    expect(agg.deleteMessage('src', 's2', null).ok).toBe(true)
    expect(persistedReferenceAnchor(sqlite, 'ref')).toBe('s1')
    expect(routeIds(agg, 'ref', null)).toEqual(['s0', 's1', 'r0'])
    const win = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: 'ref', limit: 50 }))
    expect(win.reference?.status).toBe('available')
    expect(win.reference?.boundaryMessageId).toBe('s1')

    // A captured source branch that is deleted as an object is a missing
    // reference, never a cascade: the clone topic and its suffix survive.
    const branch = (okValue(agg.createBranch('src', null, 's0', 'SRC-B')).branch as { id: string }).id
    seedSuffix(agg, 'src', branch, ['sb-0'])
    okValue(agg.createReferencedTopic('src', branch, 'ref2', 'sb-0'))
    expect(routeIds(agg, 'ref2', null)).toEqual(['s0', 'sb-0'])
    okValue(agg.deleteBranch('src', branch))
    expect(routeIds(agg, 'ref2', null)).toEqual([])
    const ref2Win = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: 'ref2', limit: 50 }))
    expect(ref2Win.reference?.status).toBe('missing')
    expect(sqlite.prepare('SELECT id FROM topics WHERE id=?').get('ref2')).toBeTruthy()
    // The clone stays writable with its own suffix.
    expect(agg.appendMessage('ref2', msgJson('r2', 'ref2') as never, [blockJson('b-r2', 'r2') as never]).ok).toBe(true)
    expect(routeIds(agg, 'ref2', null)).toEqual(['r2'])
  })

  it('staged-cut source delete containing the anchor never revives the boundary from the pasted copy', () => {
    seedMain(agg, 't1', ['m0', 'm1', 'm2'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm2', 'B1')).branch as { id: string }).id
    seedSuffix(agg, 't1', b1, ['c0'])

    // The cut/paste pipeline deletes the cut source through this semantic
    // delete with the cut roots addressed on the source route.
    const cut = okValue(agg.deleteMessagesWithDependents('t1', ['m2'], null))
    expect(cut.deletedMessageIds).toContain('m2')
    expect(persistedAnchor(sqlite, b1)).toBe('m1')
    expect(routeIds(agg, 't1', b1)).toEqual(['m0', 'm1', 'c0'])

    // Paste inserts fresh IDs: the copy must not become the boundary again.
    expect(
      agg.appendMessage('t1', msgJson('m2-copy', 't1') as never, [blockJson('b-m2-copy', 'm2-copy') as never]).ok
    ).toBe(true)
    expect(persistedAnchor(sqlite, b1)).toBe('m1')
    expect(routeIds(agg, 't1', b1)).toEqual(['m0', 'm1', 'c0'])

    // Same-stable-ID reinsertion (the product Undo path uses
    // insertMessageGroups, not this call) leaves the advanced boundary put, so
    // no post-fork history is inherited and the branch stays usable for its own
    // suffix.
    expect(agg.appendMessage('t1', msgJson('m2', 't1') as never, [blockJson('b-m2', 'm2') as never]).ok).toBe(true)
    expect(routeIds(agg, 't1', b1)).toEqual(['m0', 'm1', 'c0'])
    seedSuffix(agg, 't1', b1, ['c1'])
    expect(routeIds(agg, 't1', b1)).toEqual(['m0', 'm1', 'c0', 'c1'])
  })
  it('keeps a legacy dangling anchor readable and writable without inventing a predecessor', () => {
    seedMain(agg, 't1', ['m0', 'm1', 'm2'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm2', 'B1')).branch as { id: string }).id
    seedSuffix(agg, 't1', b1, ['c0'])
    // Rows written before the boundary rule existed: the anchored row is gone
    // and no ordering information survives, so nothing may be guessed.
    sqlite.prepare('DELETE FROM messages WHERE id = ?').run('m2')

    expect(routeIds(agg, 't1', b1)).toEqual(['c0'])
    // Still writable through the branch route.
    seedSuffix(agg, 't1', b1, ['c1'])
    expect(routeIds(agg, 't1', b1)).toEqual(['c0', 'c1'])
  })

  it('persists the advanced boundary across a database reopen', () => {
    seedMain(agg, 't1', ['m0', 'm1', 'm2'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm2', 'B1')).branch as { id: string }).id
    seedSuffix(agg, 't1', b1, ['c0'])
    expect(agg.deleteMessage('t1', 'm2', null).ok).toBe(true)
    expect(persistedAnchor(sqlite, b1)).toBe('m1')

    // Reopen the same database file (restart-equivalent) and re-read.
    sqlite.close()
    const reopened = new Database(realPath.join(dir, 'chat.db'))
    reopened.pragma('foreign_keys = ON')
    const reopenedDb = drizzle(reopened, { schema })
    const reopenedAgg = new ChatDbAggregateService(reopenedDb, reopened)
    ;(chatDbService as unknown as { sqlite: unknown }).sqlite = reopened
    ;(chatDbService as unknown as { db: unknown }).db = reopenedDb
    expect(routeIds(reopenedAgg, 't1', b1)).toEqual(['m0', 'm1', 'c0'])
    const row = reopened.prepare('SELECT anchor_message_id AS a FROM topic_branches WHERE id=?').get(b1) as {
      a: string
    }
    expect(row.a).toBe('m1')
    reopened.close()
    // afterEach closes `sqlite`; keep that path safe after the manual close.
    sqlite = new Database(realPath.join(dir, 'chat.db'))
  })
})
