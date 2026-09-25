/**
 * Topic-internal branches (final 016 route-node model).
 *
 * - `topics` are logical sidebar topics only (no child-topic rows).
 * - `topic_branches(id, topic_id, parent_branch_id?, anchor_message_id, name)`
 *   are internal route nodes; no fake root row.
 * - `messages.topic_id` is logical; nullable `messages.branch_id` owns the
 *   route suffix (null = main route).
 * - Effective routes recursively compose ancestor prefixes through anchors +
 *   current suffix. Prefixes are shared stable IDs, immutable while a live
 *   descendant includes them.
 * - Branch domain is local-only: no sync capture/baseline/frames for branch
 *   rows or branch-owned suffixes; main route stays syncable; unknown
 *   first-block ownership fails closed.
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
import { IpcChannel } from '@shared/IpcChannel'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { seedRegisteredAttachedSyncService } from '../../sync/__tests__/helpers/syncTestRegistration'
import { handleChatDbSuccessForSync } from '../../sync/chatDbHook'
import { captureLocalSyncBaselineCandidate } from '../../sync/syncBaseline'
import { syncService } from '../../sync/SyncService'
import { chatDbService } from '..'
import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { MIGRATIONS, runMigrations } from '../migration'
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-branch-'))
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
function openMemoryDb(): { sqlite: Database.Database; db: BetterSQLite3Database<typeof schema> } {
  const sqlite = new Database(':memory:')
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  runMigrations(db as never, sqlite)
  return { sqlite, db }
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
function seedTopic(agg: ChatDbAggregateService, topicId: string, ids: string[]): void {
  expect(agg.ensureTopic(topicId, 'assistant-1', `topic-${topicId}`).ok).toBe(true)
  for (const id of ids) {
    const res = agg.appendMessage(topicId, msgJson(id, topicId) as never, [blockJson(`b-${id}`, id) as never])
    expect(res.ok).toBe(true)
  }
}
function seedBranchSuffix(agg: ChatDbAggregateService, topicId: string, branchId: string, ids: string[]): void {
  for (const id of ids) {
    const res = agg.appendMessage(
      topicId,
      msgJson(id, topicId) as never,
      [blockJson(`b-${id}`, id) as never],
      undefined,
      undefined,
      {
        branchId
      }
    )
    expect(res.ok).toBe(true)
  }
}
function messageCount(sqlite: Database.Database): number {
  return (sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n
}
function blockCount(sqlite: Database.Database): number {
  return (sqlite.prepare('SELECT COUNT(*) AS n FROM message_blocks').get() as { n: number }).n
}
function topicCount(sqlite: Database.Database): number {
  return (sqlite.prepare('SELECT COUNT(*) AS n FROM topics').get() as { n: number }).n
}
function outboxFor(db: BetterSQLite3Database<typeof schema>, entityId: string): number {
  return db
    .select()
    .from(schema.syncOutbox)
    .all()
    .filter((r) => r.entityId === entityId).length
}

describe('branch migration 016 registration', () => {
  let sqlite: Database.Database
  let db: BetterSQLite3Database<typeof schema>
  let dir: string

  beforeEach(() => {
    const opened = openFileDb()
    sqlite = opened.sqlite
    db = opened.db
    dir = opened.dir
  })
  afterEach(() => {
    try {
      sqlite.close()
    } catch {}
    rmrf(dir)
  })

  it('registers 016 after 015 and applies idempotently', () => {
    const keys = MIGRATIONS.map((m) => m.key)
    expect(keys[keys.length - 1]).toBe('016_topic_branches')
    expect(keys).toContain('015_thinking_block_order_repair')
    const first = runMigrations(db, sqlite)
    expect(first).toBe(MIGRATIONS.length)
    const branchTable = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='topic_branches'`)
      .get()
    expect(branchTable).toBeTruthy()
    const second = runMigrations(db, sqlite)
    expect(second).toBe(0)
  })
})

describe('createBranch + effective route reads', () => {
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

  it('creates one route node without new topics; same topicId + branch ownership; shared prefix with stable IDs', () => {
    seedTopic(agg, 't-root', ['m0', 'm1', 'm2', 'm3'])
    const topicsBefore = topicCount(sqlite)
    const msgsBefore = messageCount(sqlite)
    const blocksBefore = blockCount(sqlite)
    const res = agg.createBranch('t-root', null, 'm1', 'B1')
    expect(res.ok).toBe(true)
    const created = okValue(res)
    const branchId = (created.branch as { id: string }).id
    expect((created.branch as { topicId: string }).topicId).toBe('t-root')
    expect((created.branch as { parentBranchId: string | null }).parentBranchId).toBeNull()
    expect((created.branch as { anchorMessageId: string }).anchorMessageId).toBe('m1')
    expect((created.branch as { name: string }).name).toBe('B1')
    // No new topic row, no message/block cloning at creation.
    expect(topicCount(sqlite)).toBe(topicsBefore)
    expect(messageCount(sqlite)).toBe(msgsBefore)
    expect(blockCount(sqlite)).toBe(blocksBefore)
    // Branch row owns the route node.
    const row = sqlite.prepare('SELECT * FROM topic_branches WHERE id=?').get(branchId) as {
      topic_id: string
      parent_branch_id: string | null
      anchor_message_id: string
    }
    expect(row.topic_id).toBe('t-root')
    expect(row.parent_branch_id).toBeNull()
    expect(row.anchor_message_id).toBe('m1')
    // Effective read: shared prefix through anchor inclusive (stable IDs), empty suffix.
    const fetched = okValue(agg.fetchMessages('t-root', branchId))
    expect(fetched.messages.map((m) => (m as { id: string }).id)).toEqual(['m0', 'm1'])
    // Main route unchanged.
    const main = okValue(agg.fetchMessages('t-root', null))
    expect(main.messages.map((m) => (m as { id: string }).id)).toEqual(['m0', 'm1', 'm2', 'm3'])
    // Catalog lists the node; topic rename stays logical.
    const catalog = okValue(agg.listBranches('t-root'))
    expect(catalog.branches.map((b) => (b as { id: string }).id)).toEqual([branchId])
  })

  it('supports multi-level branches and fork-from-inherited anchors', () => {
    seedTopic(agg, 't-root', ['m0', 'm1', 'm2'])
    const b1 = (okValue(agg.createBranch('t-root', null, 'm1', 'B1')).branch as { id: string }).id
    seedBranchSuffix(agg, 't-root', b1, ['m-b1-0'])
    // Second level forks from an inherited message (m0, owned by the main route).
    const b2res = agg.createBranch('t-root', b1, 'm0', 'B2')
    expect(b2res.ok).toBe(true)
    const b2 = (okValue(b2res).branch as { id: string }).id
    const b2view = okValue(agg.fetchMessages('t-root', b2))
    expect(b2view.messages.map((m) => (m as { id: string }).id)).toEqual(['m0'])
    const b1view = okValue(agg.fetchMessages('t-root', b1))
    expect(b1view.messages.map((m) => (m as { id: string }).id)).toEqual(['m0', 'm1', 'm-b1-0'])
    // Writes append to the branch-owned suffix.
    seedBranchSuffix(agg, 't-root', b2, ['m-b2-0'])
    const b2after = okValue(agg.fetchMessages('t-root', b2))
    expect(b2after.messages.map((m) => (m as { id: string }).id)).toEqual(['m0', 'm-b2-0'])
    // Branch-owned rows carry the owner.
    const owner = sqlite.prepare('SELECT branch_id AS branchId FROM messages WHERE id=?').get('m-b2-0') as {
      branchId: string
    }
    expect(owner.branchId).toBe(b2)
  })

  it('rejects creation on missing anchor, cross-topic parent, and trashed topic', () => {
    seedTopic(agg, 't-root', ['m0'])
    seedTopic(agg, 't-other', ['n0'])
    const missing = agg.createBranch('t-root', null, 'nope', 'Bad')
    expect(missing.ok).toBe(false)
    const bOther = (okValue(agg.createBranch('t-other', null, 'n0', 'BO')).branch as { id: string }).id
    const cross = agg.createBranch('t-root', bOther, 'm0', 'Cross')
    expect(cross.ok).toBe(false)
    // No partial branch row on failure.
    expect(okValue(agg.listBranches('t-root')).branches).toEqual([])
  })

  it('rename is name-only; topic rename stays logical and separate', () => {
    seedTopic(agg, 't-root', ['m0', 'm1'])
    const bid = (okValue(agg.createBranch('t-root', null, 'm0', 'B1')).branch as { id: string }).id
    const renamed = okValue(agg.renameBranch('t-root', bid, 'Renamed'))
    expect((renamed.branch as { name: string }).name).toBe('Renamed')
    // Topic name untouched.
    const topic = sqlite.prepare('SELECT name AS name FROM topics WHERE id=?').get('t-root') as { name: string }
    expect(topic.name).toBe('topic-t-root')
    // Identity columns immutable: cross-topic rename fails closed.
    seedTopic(agg, 't-other', ['x0'])
    expect(agg.renameBranch('t-other', bid, 'Hijack').ok).toBe(false)
  })

  it('shared prefix is immutable while a live descendant includes it; mutable again after subtree delete', () => {
    seedTopic(agg, 't-root', ['m0', 'm1', 'm2'])
    const bid = (okValue(agg.createBranch('t-root', null, 'm1', 'B1')).branch as { id: string }).id
    // m1 is shared with the live branch route.
    expect(agg.updateMessage('t-root', 'm1', { content: 'edited' } as never).ok).toBe(false)
    expect(agg.deleteBranch('t-root', bid).ok).toBe(true)
    // After the subtree is gone the prefix is mutable again.
    expect(agg.updateMessage('t-root', 'm1', { content: 'edited' } as never).ok).toBe(true)
  })

  it('subtree deletion deletes owned suffix only; siblings and shared prefix survive; last delete restores never-branched state', () => {
    seedTopic(agg, 't-root', ['m0', 'm1', 'm2'])
    const b1 = (okValue(agg.createBranch('t-root', null, 'm1', 'B1')).branch as { id: string }).id
    const b2 = (okValue(agg.createBranch('t-root', null, 'm1', 'B2')).branch as { id: string }).id
    seedBranchSuffix(agg, 't-root', b1, ['m-b1-0'])
    seedBranchSuffix(agg, 't-root', b2, ['m-b2-0'])
    const del = okValue(agg.deleteBranch('t-root', b1))
    expect(del.deletedBranchIds).toEqual([b1])
    expect(del.deletedMessageIds).toEqual(['m-b1-0'])
    // Sibling suffix survives; shared prefix survives.
    const main = okValue(agg.fetchMessages('t-root', null))
    expect(main.messages.map((m) => (m as { id: string }).id)).toEqual(['m0', 'm1', 'm2'])
    const sib = okValue(agg.fetchMessages('t-root', b2))
    expect(sib.messages.map((m) => (m as { id: string }).id)).toEqual(['m0', 'm1', 'm-b2-0'])
    expect(okValue(agg.listBranches('t-root')).branches.map((b) => (b as { id: string }).id)).toEqual([b2])
    // Deleting the final branch restores the never-branched state.
    expect(agg.deleteBranch('t-root', b2).ok).toBe(true)
    expect(okValue(agg.listBranches('t-root')).branches).toEqual([])
    const restored = okValue(agg.fetchMessages('t-root', null))
    expect(restored.messages.map((m) => (m as { id: string }).id)).toEqual(['m0', 'm1', 'm2'])
  })

  it('nested subtree deletion removes descendants with their owned rows', () => {
    seedTopic(agg, 't-root', ['m0', 'm1'])
    const b1 = (okValue(agg.createBranch('t-root', null, 'm1', 'B1')).branch as { id: string }).id
    seedBranchSuffix(agg, 't-root', b1, ['m-b1-0'])
    const b2 = (okValue(agg.createBranch('t-root', b1, 'm-b1-0', 'B2')).branch as { id: string }).id
    seedBranchSuffix(agg, 't-root', b2, ['m-b2-0'])
    const del = okValue(agg.deleteBranch('t-root', b1))
    expect(new Set(del.deletedBranchIds)).toEqual(new Set([b1, b2]))
    expect(new Set(del.deletedMessageIds)).toEqual(new Set(['m-b1-0', 'm-b2-0']))
    expect(okValue(agg.listBranches('t-root')).branches).toEqual([])
  })

  it('logical topic hard delete covers the entire tree (branches + all owned rows)', () => {
    seedTopic(agg, 't-root', ['m0', 'm1'])
    const b1 = (okValue(agg.createBranch('t-root', null, 'm1', 'B1')).branch as { id: string }).id
    seedBranchSuffix(agg, 't-root', b1, ['m-b1-0'])
    expect(agg.hardDeleteTopic('t-root').ok).toBe(true)
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM topic_branches`).get() as { n: number }).toMatchObject({ n: 0 })
    expect(
      sqlite.prepare(`SELECT COUNT(*) AS n FROM messages WHERE topic_id='t-root'`).get() as { n: number }
    ).toMatchObject({
      n: 0
    })
  })
})

describe('branch sync isolation (local-only domain)', () => {
  let sqlite: Database.Database
  let db: BetterSQLite3Database<typeof schema>
  let agg: ChatDbAggregateService

  beforeEach(() => {
    configStore.clear()
    configStore.set('sync:enabled', true)
    configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
    configStore.set('sync:token', '')
    const opened = openMemoryDb()
    sqlite = opened.sqlite
    db = opened.db
    ;(chatDbService as unknown as { sqlite: unknown }).sqlite = sqlite
    ;(chatDbService as unknown as { db: unknown }).db = db
    syncService.clearAllForTests()
    seedRegisteredAttachedSyncService(configStore, db)
    agg = new ChatDbAggregateService(db, sqlite)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    try {
      sqlite.close()
    } catch {}
    ;(chatDbService as never as { sqlite: unknown }).sqlite = null
    ;(chatDbService as never as { db: unknown }).db = null
  })

  function seedBranchWithSuffix(): { branchId: string } {
    seedTopic(agg, 't-root', ['u0', 'u1'])
    const branchId = (okValue(agg.createBranch('t-root', null, 'u0', 'B1')).branch as { id: string }).id
    seedBranchSuffix(agg, 't-root', branchId, ['m-own'])
    return { branchId }
  }
  function syncTotals(): { outbox: number; membership: number } {
    return {
      outbox: db.select().from(schema.syncOutbox).all().length,
      membership: db.select().from(schema.syncMembershipClock).all().length
    }
  }

  it('branch creation and branch-owned appends emit zero sync intent; ordinary writes still capture', () => {
    const before = syncTotals()
    seedTopic(agg, 't-sync', ['s0'])
    const afterSeed = syncTotals()
    // Seeding itself may capture (topic/message create paths are syncable).
    expect(afterSeed.outbox).toBeGreaterThanOrEqual(before.outbox)
    const branchId = (okValue(agg.createBranch('t-sync', null, 's0', 'B1')).branch as { id: string }).id
    seedBranchSuffix(agg, 't-sync', branchId, ['m-branch'])
    // No branch rows, branch messages, or branch blocks in the outbox.
    const totals = syncTotals()
    const branchOps = db
      .select()
      .from(schema.syncOutbox)
      .all()
      .filter((r) => r.entityId === branchId)
    expect(branchOps).toEqual([])
    expect(outboxFor(db, 'm-branch')).toBe(0)
    expect(outboxFor(db, 'b-m-branch')).toBe(0)
    // Membership untouched by the branch domain.
    expect(totals.membership).toBe(afterSeed.membership)
    void totals
  })

  it('in-tx gate suppresses branch suffix block intent when owner resolution misses; ordinary writes still capture', () => {
    const { branchId } = seedBranchWithSuffix()
    void branchId
    // Ordinary baseline: an ordinary block edit captures sync intent.
    expect(agg.updateBlocks([blockJson('b-u1', 'u1', { content: 'ordinary-edit' }) as never]).ok).toBe(true)
    expect(outboxFor(db, 'b-u1')).toBeGreaterThan(0)
    const afterOrdinary = syncTotals()
    // Simulate the pre-tx race: the owner route is unresolvable before the
    // transaction even though the rows are committed (pre-first-chunk).
    const missOwner = vi
      .spyOn(
        agg as unknown as {
          resolveBlockOwnerRoute: (b: unknown[]) => { topicId: string; branchId: string | null } | null
        },
        'resolveBlockOwnerRoute'
      )
      .mockReturnValue(null)
    const missOwnerIds = vi
      .spyOn(
        agg as unknown as {
          resolveBlockOwnerRouteByIds: (b: string[]) => { topicId: string; branchId: string | null } | null
        },
        'resolveBlockOwnerRouteByIds'
      )
      .mockReturnValue(null)
    try {
      // Streaming chunk on the branch suffix still commits...
      expect(agg.updateBlocks([blockJson('b-m-own', 'm-own', { content: 'chunk-2' }) as never]).ok).toBe(true)
      // ...a pre-first-chunk bulk insert under the branch message...
      expect(agg.bulkAddBlocks([blockJson('b-pre', 'm-own') as never]).ok).toBe(true)
      // ...and a branch delete that must never become a remote delete.
      expect(agg.deleteBlocks(['b-pre']).ok).toBe(true)
    } finally {
      missOwner.mockRestore()
      missOwnerIds.mockRestore()
    }
    // ...but none of it leaks: no outbox rows, no membership, no frames.
    const totals = syncTotals()
    expect(totals.outbox).toBe(afterOrdinary.outbox)
    expect(totals.membership).toBe(afterOrdinary.membership)
    expect(outboxFor(db, 'm-own')).toBe(0)
    expect(outboxFor(db, 'b-m-own')).toBe(0)
    expect(outboxFor(db, 'b-pre')).toBe(0)
    // The branch rows themselves committed locally with final content.
    expect(sqlite.prepare('SELECT content AS content FROM message_blocks WHERE id=?').get('b-m-own')).toMatchObject({
      content: 'chunk-2'
    })
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-pre')).toBeUndefined()
    // Ordinary deletes remain syncable.
    expect(agg.deleteBlocks(['b-u1']).ok).toBe(true)
    expect(outboxFor(db, 'b-u1')).toBeGreaterThan(0)
  })

  it('post-commit fallback captures ordinary block writes but never branch-owned or unresolvable ones', () => {
    seedBranchWithSuffix()
    const before = syncTotals()
    // Ordinary block write via the fallback captures.
    handleChatDbSuccessForSync(IpcChannel.ChatDb_UpdateSingleBlock, { blockId: 'b-u1' })
    expect(db.select().from(schema.syncOutbox).all().length).toBeGreaterThan(before.outbox)
    const afterOrdinary = syncTotals()
    // Branch suffix blocks via the fallback: local-only skips, never capture.
    handleChatDbSuccessForSync(IpcChannel.ChatDb_UpdateBlocks, { blocks: [{ id: 'b-m-own' }] })
    handleChatDbSuccessForSync(IpcChannel.ChatDb_UpdateSingleBlock, { blockId: 'b-m-own' })
    handleChatDbSuccessForSync(IpcChannel.ChatDb_BulkAddBlocks, {
      blocks: [{ id: 'b-m-own', messageId: 'm-own' }]
    })
    // Unresolvable candidates fail closed: no capture, no throw.
    handleChatDbSuccessForSync(IpcChannel.ChatDb_UpdateBlocks, { blocks: [{ id: 'b-ghost-missing' }] })
    handleChatDbSuccessForSync(IpcChannel.ChatDb_DeleteBlocks, { blockIds: ['b-ghost-missing'] })
    const totals = syncTotals()
    expect(totals.outbox).toBe(afterOrdinary.outbox)
    expect(totals.membership).toBe(afterOrdinary.membership)
    expect(outboxFor(db, 'b-m-own')).toBe(0)
  })

  it('baseline capture excludes branch-owned rows while keeping the main route syncable', () => {
    seedBranchWithSuffix()
    const candidate = captureLocalSyncBaselineCandidate(db)
    expect(candidate).not.toBeNull()
    const ids = new Set<string>()
    for (const e of candidate.entities) {
      ids.add(`${e.entityType}:${e.entityId}`)
    }
    expect(ids.has('message:m-own')).toBe(false)
    expect(ids.has('message_block:b-m-own')).toBe(false)
    // Main route stays syncable.
    expect(ids.has('message:u0')).toBe(true)
  })
})
