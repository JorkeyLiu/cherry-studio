/**
 * Audit-blocker regression tests for the sync MVP correction pass.
 * Focused seams only; no real network (relay tests stay loopback/owned).
 */
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')
vi.mock('@main/config', () => ({ DATA_PATH: '/tmp' }))

const configStore = new Map<string, unknown>()
vi.mock('@main/services/ConfigManager', () => ({
  configManager: {
    get: (k: string, def?: unknown) => (configStore.has(k) ? configStore.get(k) : def),
    set: (k: string, v: unknown) => configStore.set(k, v)
  },
  ConfigKeys: {}
}))

import { validateSyncOperationStrict } from '@shared/sync'
import { eq } from 'drizzle-orm'

import { chatDbService } from '../../chatDb'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { handleChatDbSuccessForSync } from '../chatDbHook'
import { syncService } from '../SyncService'
import { seedRegisteredAttachedSyncService } from './helpers/syncTestRegistration'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
  sqlite = openInMemory()
  db = drizzle(sqlite, { schema })
  runMigrations(db as any, sqlite)
  ;(chatDbService as any).sqlite = sqlite
  ;(chatDbService as any).db = db
  syncService.clearAllForTests()
  seedRegisteredAttachedSyncService(configStore, db)
})

afterEach(() => {
  try {
    sqlite.close()
  } catch {}
  ;(chatDbService as any).sqlite = null
  ;(chatDbService as any).db = null
})

describe('blocker 1: dependency ordering / orphan recovery', () => {
  it('push ordering returns message before block for equal timestamps', () => {
    const ts = 5_000_000
    // Enqueue child first to prove ordering is not insertion order
    syncService.enqueueOperation({
      id: 'op-b-first',
      entityType: 'message_block',
      op: 'upsert',
      entityId: 'b-ord',
      timestamp: ts,
      deviceId: 'd1',
      payload: { id: 'b-ord', messageId: 'm-ord', type: 'text', content: 'hi' }
    } as any)
    syncService.enqueueOperation({
      id: 'op-m-second',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm-ord',
      timestamp: ts,
      deviceId: 'd1',
      payload: { id: 'm-ord', topicId: 't-ord', role: 'user', content: 'hi' }
    } as any)
    const out = syncService.listOutbox()
    expect(out.map((o) => o.entityId)).toEqual(['m-ord', 'b-ord'])
  })

  it('child-precedes-parent recovers within one sync via deferred retry', async () => {
    configStore.set('sync:token', '')
    configStore.set('sync:deviceCode', 'ABCD2345')
    configStore.set('sync:deviceAuth', 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90')
    db.insert(schema.syncState)
      .values({ key: 'cursor', value: '0' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: '0' } })
      .run()
    const { syncClient } = await import('../SyncClient')
    const pushMock = vi
      .spyOn(syncClient, 'push')
      .mockImplementation(async () => ({ acceptedIds: [], cursor: 0 }) as any)
    const now = Date.now()
    const pullMock = vi
      .spyOn(syncClient, 'pull')
      .mockImplementation(async (_ep: string, _tok: string | undefined, cursor: number) => {
        if (cursor === 0) {
          return {
            operations: [
              {
                seq: 1,
                id: 'op-child-first',
                entityType: 'message_block',
                op: 'upsert',
                entityId: 'b-defer',
                timestamp: now,
                deviceId: 'remote',
                payload: { id: 'b-defer', messageId: 'm-defer', type: 'text', content: 'child' }
              },
              {
                seq: 2,
                id: 'op-parent-second',
                entityType: 'message',
                op: 'upsert',
                entityId: 'm-defer',
                timestamp: now - 1000,
                deviceId: 'remote',
                payload: { id: 'm-defer', topicId: 't-defer', role: 'user', content: 'parent' }
              }
            ],
            cursor: 2
          } as any
        }
        return { operations: [], cursor } as any
      })
    await syncService.sync()
    // Both applied and cursor advanced contiguously (no skip, no stall)
    expect(sqlite.prepare('SELECT id FROM messages WHERE id=?').get('m-defer')).toBeTruthy()
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-defer')).toBeTruthy()
    const cur = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
    expect(cur?.value).toBe('2')
    pullMock.mockRestore()
    pushMock.mockRestore()
  })
})

describe('blocker 2: capture reflects actual changed entities', () => {
  it('unknown delete targets do not enqueue destructive operations', async () => {
    const { IpcChannel } = await import('@shared/IpcChannel')
    expect(syncService.listOutbox().length).toBe(0)
    handleChatDbSuccessForSync(IpcChannel.ChatDb_DeleteMessage, { topicId: 't-x', messageId: 'm-unknown' })
    handleChatDbSuccessForSync(IpcChannel.ChatDb_DeleteBlocks, { blockIds: ['b-unknown'] })
    handleChatDbSuccessForSync(IpcChannel.ChatDb_DeleteMessages, { topicId: 't-x', messageIds: ['m-unknown-2'] })
    expect(syncService.listOutbox().length).toBe(0)
  })

  it('known message delete enqueues exactly one delete', async () => {
    const { IpcChannel } = await import('@shared/IpcChannel')
    syncService.applyIncomingOperation({
      id: 'op-known-msg',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm-known',
      timestamp: Date.now() - 1000,
      deviceId: 'd1',
      payload: { id: 'm-known', topicId: 't-known', role: 'user', content: 'hi' }
    } as any)
    const before = syncService.listOutbox().length
    // Simulate the aggregate having deleted the row before the hook runs
    // (real IPC order): post-state row gone + tracked clock -> emit.
    sqlite.prepare('DELETE FROM messages WHERE id=?').run('m-known')
    handleChatDbSuccessForSync(IpcChannel.ChatDb_DeleteMessage, { topicId: 't-known', messageId: 'm-known' })
    const after = syncService.listOutbox()
    expect(after.length).toBe(before + 1)
    expect(after[after.length - 1]).toMatchObject({ entityType: 'message', op: 'delete', entityId: 'm-known' })
  })

  it('hard-delete no-op (empty deletedTopicIds) emits nothing', async () => {
    const { IpcChannel } = await import('@shared/IpcChannel')
    const before = syncService.listOutbox().length
    handleChatDbSuccessForSync(
      IpcChannel.ChatDb_HardDeleteTopic,
      { topicId: 't-noop' },
      { ok: true, value: { affectedFileIds: [], remainingReferenceCounts: {}, deletedTopicIds: [] } }
    )
    expect(syncService.listOutbox().length).toBe(before)
  })

  it('restore no-op (null value) emits nothing', async () => {
    const { IpcChannel } = await import('@shared/IpcChannel')
    const before = syncService.listOutbox().length
    handleChatDbSuccessForSync(IpcChannel.ChatDb_RestoreTopic, { topicId: 't-restore-noop' }, { ok: true, value: null })
    expect(syncService.listOutbox().length).toBe(before)
  })
})

describe('blocker 3: incoming ordering state preserved', () => {
  it('existing-row message sortOrder converges via LWW', () => {
    const base = Date.now() - 5000
    syncService.applyIncomingOperation({
      id: 'op-m-order-1',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm-order',
      timestamp: base,
      deviceId: 'd1',
      payload: { id: 'm-order', topicId: 't-order', role: 'user', content: 'a', sortOrder: 0 }
    } as any)
    syncService.applyIncomingOperation({
      id: 'op-m-order-2',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm-order',
      timestamp: base + 1000,
      deviceId: 'd2',
      payload: { id: 'm-order', topicId: 't-order', role: 'user', content: 'a', sortOrder: 7 }
    } as any)
    const row = sqlite.prepare('SELECT sort_order as s FROM messages WHERE id=?').get('m-order') as { s: number }
    expect(row.s).toBe(7)
  })

  it('existing-row block sortOrder converges via LWW', () => {
    const base = Date.now() - 5000
    syncService.applyIncomingOperation({
      id: 'op-p-order',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm-p',
      timestamp: base,
      deviceId: 'd1',
      payload: { id: 'm-p', topicId: 't-p', role: 'user', content: 'p' }
    } as any)
    syncService.applyIncomingOperation({
      id: 'op-b-order-1',
      entityType: 'message_block',
      op: 'upsert',
      entityId: 'b-order',
      timestamp: base + 10,
      deviceId: 'd1',
      payload: { id: 'b-order', messageId: 'm-p', type: 'text', content: 'x', sortOrder: 0 }
    } as any)
    syncService.applyIncomingOperation({
      id: 'op-b-order-2',
      entityType: 'message_block',
      op: 'upsert',
      entityId: 'b-order',
      timestamp: base + 20,
      deviceId: 'd1',
      payload: { id: 'b-order', messageId: 'm-p', type: 'text', content: 'x', sortOrder: 3 }
    } as any)
    const row = sqlite.prepare('SELECT sort_order as s FROM message_blocks WHERE id=?').get('b-order') as {
      s: number
    }
    expect(row.s).toBe(3)
  })
})

describe('blocker 4: immutable parent identity', () => {
  it('message reparent attempt is skipped, topicId preserved', () => {
    const base = Date.now() - 5000
    syncService.applyIncomingOperation({
      id: 'op-reparent-base',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm-reparent',
      timestamp: base,
      deviceId: 'd1',
      payload: { id: 'm-reparent', topicId: 't-home', role: 'user', content: 'hi' }
    } as any)
    const res = syncService.applyIncomingOperation({
      id: 'op-reparent-evil',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm-reparent',
      timestamp: base + 1000,
      deviceId: 'd2',
      payload: { id: 'm-reparent', topicId: 't-other', role: 'user', content: 'hi' }
    } as any)
    // Per-field merge: the reparent is rejected so no field mutates — the
    // honest applied flag is false while the immutable parent is preserved.
    expect(res).toBe(false)
    const row = sqlite.prepare('SELECT topic_id as t FROM messages WHERE id=?').get('m-reparent') as { t: string }
    expect(row.t).toBe('t-home')
  })

  it('block reparent attempt is skipped, messageId preserved', () => {
    const base = Date.now() - 5000
    syncService.applyIncomingOperation({
      id: 'op-bp-base',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm-home',
      timestamp: base,
      deviceId: 'd1',
      payload: { id: 'm-home', topicId: 't-home', role: 'user', content: 'hi' }
    } as any)
    syncService.applyIncomingOperation({
      id: 'op-bp-base2',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm-away',
      timestamp: base,
      deviceId: 'd1',
      payload: { id: 'm-away', topicId: 't-home', role: 'user', content: 'hi' }
    } as any)
    syncService.applyIncomingOperation({
      id: 'op-bp-block',
      entityType: 'message_block',
      op: 'upsert',
      entityId: 'b-reparent',
      timestamp: base + 10,
      deviceId: 'd1',
      payload: { id: 'b-reparent', messageId: 'm-home', type: 'text', content: 'x' }
    } as any)
    syncService.applyIncomingOperation({
      id: 'op-bp-evil',
      entityType: 'message_block',
      op: 'upsert',
      entityId: 'b-reparent',
      timestamp: base + 20,
      deviceId: 'd2',
      payload: { id: 'b-reparent', messageId: 'm-away', type: 'text', content: 'x' }
    } as any)
    const row = sqlite.prepare('SELECT message_id as m FROM message_blocks WHERE id=?').get('b-reparent') as {
      m: string
    }
    expect(row.m).toBe('m-home')
  })
})

describe('blocker 5: entity-specific strict validation', () => {
  it('strict validator requires message topicId and block messageId', () => {
    expect(
      validateSyncOperationStrict({
        id: 'x',
        entityType: 'message',
        op: 'upsert',
        entityId: 'm1',
        timestamp: 1,
        deviceId: 'd1',
        payload: { id: 'm1', role: 'user' }
      } as any)
    ).toMatch(/topicId/)
    expect(
      validateSyncOperationStrict({
        id: 'x',
        entityType: 'message_block',
        op: 'upsert',
        entityId: 'b1',
        timestamp: 1,
        deviceId: 'd1',
        payload: { id: 'b1', type: 'text' }
      } as any)
    ).toMatch(/messageId/)
    expect(
      validateSyncOperationStrict({
        id: 'x',
        entityType: 'message',
        op: 'upsert',
        entityId: 'm1',
        timestamp: 1,
        deviceId: 'd1',
        payload: { id: 'm1', topicId: 't1', sortOrder: 'bad' }
      } as any)
    ).toMatch(/sortOrder/)
  })

  it('enqueue rejects malformed before persistence', () => {
    const before = syncService.listOutbox().length
    expect(() =>
      syncService.enqueueOperation({
        id: 'op-malformed-enq',
        entityType: 'message',
        op: 'upsert',
        entityId: 'm-mal',
        timestamp: Date.now(),
        deviceId: 'd1',
        payload: { id: 'm-mal', role: 'user' }
      } as any)
    ).toThrow(/topicId/)
    expect(syncService.listOutbox().length).toBe(before)
  })

  it('apply rejects malformed before persistence with durable failure semantics', () => {
    expect(() =>
      syncService.applyIncomingOperation({
        id: 'op-malformed-apply',
        entityType: 'message_block',
        op: 'upsert',
        entityId: 'b-mal',
        timestamp: Date.now(),
        deviceId: 'remote',
        payload: { id: 'b-mal', type: 'text' }
      } as any)
    ).toThrow(/messageId/)
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-mal')).toBeUndefined()
  })

  it('pull client rejects malformed operations without persistence', async () => {
    const { syncClient } = await import('../SyncClient')
    const origFetch = globalThis.fetch
    ;(globalThis as any).fetch = async () =>
      ({
        ok: true,
        json: async () => ({
          operations: [
            {
              seq: 1,
              id: 'op-pull-bad',
              entityType: 'message',
              op: 'upsert',
              entityId: 'm-pull-bad',
              timestamp: Date.now(),
              deviceId: 'remote',
              payload: { id: 'm-pull-bad', role: 'user' }
            }
          ],
          cursor: 1
        })
      }) as any
    try {
      await expect(
        syncClient.pull(
          'http://127.0.0.1:9',
          undefined,
          0,
          'd1',
          undefined,
          'ABCD2345',
          'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
        )
      ).rejects.toThrow(/topicId/)
    } finally {
      ;(globalThis as any).fetch = origFetch
    }
  })
})

describe('blocker 6: hard-deleted parent not resurrected by late child', () => {
  it('late (older) message does not recreate hard-deleted topic', () => {
    const base = 9_000_000
    syncService.applyIncomingOperation({
      id: 'op-tomb-topic',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-tomb',
      timestamp: base,
      deviceId: 'd1',
      payload: { id: 't-tomb', name: 'T' }
    } as any)
    syncService.applyIncomingOperation({
      id: 'op-tomb-del',
      entityType: 'topic',
      op: 'delete',
      entityId: 't-tomb',
      timestamp: base + 1000,
      deviceId: 'd1'
    } as any)
    expect(sqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-tomb')).toBeUndefined()
    // Late child with older timestamp must not resurrect the placeholder topic
    syncService.applyIncomingOperation({
      id: 'op-tomb-late-child',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm-late',
      timestamp: base + 500,
      deviceId: 'd2',
      payload: { id: 'm-late', topicId: 't-tomb', role: 'user', content: 'late' }
    } as any)
    expect(sqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-tomb')).toBeUndefined()
    expect(sqlite.prepare('SELECT id FROM messages WHERE id=?').get('m-late')).toBeUndefined()
  })
})

describe('blocker 7+8: narrow scope and durable capture failure', () => {
  it('compound mutation channels are explicitly skipped', async () => {
    const { IpcChannel } = await import('@shared/IpcChannel')
    const before = syncService.listOutbox().length
    handleChatDbSuccessForSync(IpcChannel.ChatDb_BranchMessagesToTopic, {
      sourceTopicId: 'a',
      targetTopicId: 'b',
      anchorMessageId: 'm'
    })
    handleChatDbSuccessForSync(IpcChannel.ChatDb_PasteMessagesToTopic, { topicId: 'a', entries: [] })
    expect(syncService.listOutbox().length).toBe(before)
  })

  it('capture failure is durable via sync_state and never breaks the caller', () => {
    syncService.recordCaptureFailure('test-channel', new Error('boom-capture'))
    const errRow = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastError')).get()
    expect(errRow?.value).toMatch(/boom-capture/)
    const capRow = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastCaptureError')).get()
    expect(capRow?.value).toMatch(/test-channel/)
  })

  it('second-audit B1: foreign/no-op targets emit nothing', async () => {
    const { IpcChannel } = await import('@shared/IpcChannel')
    const base = Date.now() - 10000
    // Seed two topics and one message owned by t-own
    syncService.applyIncomingOperation({
      id: 'op-b1-t-own',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-own',
      timestamp: base,
      deviceId: 'd1',
      payload: { id: 't-own', name: 'Own' }
    } as any)
    syncService.applyIncomingOperation({
      id: 'op-b1-t-other',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-other',
      timestamp: base,
      deviceId: 'd1',
      payload: { id: 't-other', name: 'Other' }
    } as any)
    syncService.applyIncomingOperation({
      id: 'op-b1-m1',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm-foreign-check',
      timestamp: base + 10,
      deviceId: 'd1',
      payload: { id: 'm-foreign-check', topicId: 't-own', role: 'user', content: 'hi' }
    } as any)
    syncService.clearAllForTests()
    // Re-track via outbox so deletes are gated by tracked-ness, then clear
    // outbox but keep clock: re-apply to rebuild clock rows
    syncService.applyIncomingOperation({
      id: 'op-b1-t-own2',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-own',
      timestamp: base,
      deviceId: 'd1',
      payload: { id: 't-own', name: 'Own' }
    } as any)
    syncService.applyIncomingOperation({
      id: 'op-b1-m1b',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm-foreign-check',
      timestamp: base + 10,
      deviceId: 'd1',
      payload: { id: 'm-foreign-check', topicId: 't-own', role: 'user', content: 'hi' }
    } as any)
    const before = syncService.listOutbox().length
    // Foreign-topic delete is a local no-op (row survives) -> no remote delete
    handleChatDbSuccessForSync(IpcChannel.ChatDb_DeleteMessage, { topicId: 't-other', messageId: 'm-foreign-check' })
    expect(syncService.listOutbox().length).toBe(before)
    expect(sqlite.prepare('SELECT id FROM messages WHERE id=?').get('m-foreign-check')).toBeTruthy()
    // Foreign-topic update -> no emit
    handleChatDbSuccessForSync(IpcChannel.ChatDb_UpdateMessage, {
      topicId: 't-other',
      messageId: 'm-foreign-check',
      updates: { content: 'evil' }
    })
    expect(syncService.listOutbox().length).toBe(before)
    // Empty topic-metadata patch -> no emit
    handleChatDbSuccessForSync(IpcChannel.ChatDb_UpdateTopicMetadata, { topicId: 't-own' })
    expect(syncService.listOutbox().length).toBe(before)
    // Existing-topic ensure (tracked) -> no emit
    handleChatDbSuccessForSync(IpcChannel.ChatDb_EnsureTopic, { topicId: 't-own', assistantId: 'a1', name: 'Own' })
    expect(syncService.listOutbox().length).toBe(before)
  })

  it('second-audit B2: later-page parent resolves early-page orphan', async () => {
    configStore.set('sync:token', '')
    configStore.set('sync:deviceCode', 'ABCD2345')
    configStore.set('sync:deviceAuth', 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90')
    db.insert(schema.syncState)
      .values({ key: 'cursor', value: '0' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: '0' } })
      .run()
    const { syncClient } = await import('../SyncClient')
    const { SYNC_MAX_OPERATIONS_PER_PULL } = await import('@shared/sync')
    const pushMock = vi
      .spyOn(syncClient, 'push')
      .mockImplementation(async () => ({ acceptedIds: [], cursor: 0 }) as any)
    const now = Date.now()
    const limit = SYNC_MAX_OPERATIONS_PER_PULL
    const pullMock = vi
      .spyOn(syncClient, 'pull')
      .mockImplementation(async (_ep: string, _tok: string | undefined, cursor: number) => {
        if (cursor === 0) {
          const ops: any[] = [
            {
              seq: 1,
              id: 'op-late-b',
              entityType: 'message_block',
              op: 'upsert',
              entityId: 'b-late-page',
              timestamp: now,
              deviceId: 'remote',
              payload: { id: 'b-late-page', messageId: 'm-late-page', type: 'text', content: 'child' }
            }
          ]
          for (let s = 2; s <= limit; s++) {
            ops.push({
              seq: s,
              id: `op-fill-${s}`,
              entityType: 'topic',
              op: 'upsert',
              entityId: `t-fill-${s}`,
              timestamp: now,
              deviceId: 'remote',
              payload: { id: `t-fill-${s}`, name: `F${s}` }
            })
          }
          return { operations: ops, cursor: limit } as any
        }
        if (cursor === limit) {
          return {
            operations: [
              {
                seq: limit + 1,
                id: 'op-late-parent',
                entityType: 'message',
                op: 'upsert',
                entityId: 'm-late-page',
                timestamp: now - 1000,
                deviceId: 'remote',
                payload: { id: 'm-late-page', topicId: 't-late-page', role: 'user', content: 'parent' }
              }
            ],
            cursor: limit + 1
          } as any
        }
        return { operations: [], cursor } as any
      })
    await syncService.sync()
    expect(sqlite.prepare('SELECT id FROM messages WHERE id=?').get('m-late-page')).toBeTruthy()
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-late-page')).toBeTruthy()
    const cur = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
    expect(cur?.value).toBe(String(limit + 1))
    const errRow = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastError')).get()
    expect(errRow).toBeUndefined()
    const okAt = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastSyncAt')).get()
    expect(okAt?.value).toBeTruthy()
    pullMock.mockRestore()
    pushMock.mockRestore()
  })

  it('second-audit B2b: unresolved orphan is a durable blocked error, not success', async () => {
    configStore.set('sync:token', '')
    configStore.set('sync:deviceCode', 'ABCD2345')
    configStore.set('sync:deviceAuth', 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90')
    db.insert(schema.syncState)
      .values({ key: 'cursor', value: '0' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: '0' } })
      .run()
    const { syncClient } = await import('../SyncClient')
    const pushMock = vi
      .spyOn(syncClient, 'push')
      .mockImplementation(async () => ({ acceptedIds: [], cursor: 0 }) as any)
    const pullMock = vi
      .spyOn(syncClient, 'pull')
      .mockImplementation(async (_ep: string, _tok: string | undefined, cursor: number) => {
        if (cursor === 0) {
          return {
            operations: [
              {
                seq: 1,
                id: 'op-never-parented',
                entityType: 'message_block',
                op: 'upsert',
                entityId: 'b-never',
                timestamp: Date.now(),
                deviceId: 'remote',
                payload: { id: 'b-never', messageId: 'm-never', type: 'text', content: 'x' }
              }
            ],
            cursor: 1
          } as any
        }
        return { operations: [], cursor } as any
      })
    await expect(syncService.sync()).rejects.toThrow(/orphan|blocked/i)
    const cur = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
    expect(cur?.value ?? '0').toBe('0')
    const errRow = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastError')).get()
    expect(errRow?.value).toMatch(/orphan|blocked/i)
    const okAt = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastSyncAt')).get()
    expect(okAt).toBeUndefined()
    pullMock.mockRestore()
    pushMock.mockRestore()
  })

  it('second-audit B3: message-delete tombstone suppresses late block', () => {
    const base = Date.now() - 20000
    syncService.applyIncomingOperation({
      id: 'op-b3-m',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm-tomb-b3',
      timestamp: base,
      deviceId: 'd1',
      payload: { id: 'm-tomb-b3', topicId: 't-tomb-b3', role: 'user', content: 'p' }
    } as any)
    syncService.applyIncomingOperation({
      id: 'op-b3-mdel',
      entityType: 'message',
      op: 'delete',
      entityId: 'm-tomb-b3',
      timestamp: base + 1000,
      deviceId: 'd1'
    } as any)
    // Late older block must be suppressed, not throw orphan, not resurrect
    let threw = false
    try {
      syncService.applyIncomingOperation({
        id: 'op-b3-late-b',
        entityType: 'message_block',
        op: 'upsert',
        entityId: 'b-late-b3',
        timestamp: base + 500,
        deviceId: 'd2',
        payload: { id: 'b-late-b3', messageId: 'm-tomb-b3', type: 'text', content: 'late' }
      } as any)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-late-b3')).toBeUndefined()
    expect(sqlite.prepare('SELECT id FROM messages WHERE id=?').get('m-tomb-b3')).toBeUndefined()
  })

  it('second-audit B3b: topic-delete cascade suppresses late block without stall', () => {
    const base = Date.now() - 20000
    syncService.applyIncomingOperation({
      id: 'op-b3c-t',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-cascade',
      timestamp: base,
      deviceId: 'd1',
      payload: { id: 't-cascade', name: 'T' }
    } as any)
    syncService.applyIncomingOperation({
      id: 'op-b3c-m',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm-cascade',
      timestamp: base + 10,
      deviceId: 'd1',
      payload: { id: 'm-cascade', topicId: 't-cascade', role: 'user', content: 'p' }
    } as any)
    syncService.applyIncomingOperation({
      id: 'op-b3c-tdel',
      entityType: 'topic',
      op: 'delete',
      entityId: 't-cascade',
      timestamp: base + 1000,
      deviceId: 'd1'
    } as any)
    expect(sqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-cascade')).toBeUndefined()
    let threw = false
    try {
      syncService.applyIncomingOperation({
        id: 'op-b3c-late-b',
        entityType: 'message_block',
        op: 'upsert',
        entityId: 'b-cascade-late',
        timestamp: base + 500,
        deviceId: 'd2',
        payload: { id: 'b-cascade-late', messageId: 'm-cascade', type: 'text', content: 'late' }
      } as any)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-cascade-late')).toBeUndefined()
    expect(sqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-cascade')).toBeUndefined()
  })

  it('second-audit B4: push priority precedes timestamps (child earlier than parent)', () => {
    syncService.enqueueOperation({
      id: 'op-b4-child-early',
      entityType: 'message_block',
      op: 'upsert',
      entityId: 'b-b4',
      timestamp: 1000,
      deviceId: 'd1',
      payload: { id: 'b-b4', messageId: 'm-b4', type: 'text', content: 'c' }
    } as any)
    syncService.enqueueOperation({
      id: 'op-b4-parent-late',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm-b4',
      timestamp: 2000,
      deviceId: 'd1',
      payload: { id: 'm-b4', topicId: 't-b4', role: 'user', content: 'p' }
    } as any)
    syncService.enqueueOperation({
      id: 'op-b4-topic-latest',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-b4',
      timestamp: 3000,
      deviceId: 'd1',
      payload: { id: 't-b4', name: 'T' }
    } as any)
    const out = syncService.listOutbox()
    expect(out.map((o) => o.entityId)).toEqual(['t-b4', 'm-b4', 'b-b4'])
  })

  it('second-audit B5: strict validator covers field types and identity', () => {
    expect(
      validateSyncOperationStrict({
        id: 'x',
        entityType: 'topic',
        op: 'upsert',
        entityId: 't1',
        timestamp: 1,
        deviceId: 'd1',
        payload: { id: 't1', name: 123 }
      } as any)
    ).toMatch(/topic name/)
    expect(
      validateSyncOperationStrict({
        id: 'x',
        entityType: 'message',
        op: 'upsert',
        entityId: 'm1',
        timestamp: 1,
        deviceId: 'd1',
        payload: { id: 'm1', topicId: 't1', role: 123 }
      } as any)
    ).toMatch(/message role/)
    expect(
      validateSyncOperationStrict({
        id: 'x',
        entityType: 'message_block',
        op: 'upsert',
        entityId: 'b1',
        timestamp: 1,
        deviceId: 'd1',
        payload: { id: 'b1', messageId: 'm1', status: 123 }
      } as any)
    ).toMatch(/block status/)
    expect(
      validateSyncOperationStrict({
        id: 'x',
        entityType: 'message',
        op: 'upsert',
        entityId: 'm1',
        timestamp: 1,
        deviceId: 'd1',
        payload: { id: 'm-other', topicId: 't1' }
      } as any)
    ).toMatch(/agree/)
    expect(
      validateSyncOperationStrict({
        id: 'x',
        entityType: 'message',
        op: 'upsert',
        entityId: 'm1',
        timestamp: 1,
        deviceId: 'd1',
        payload: { id: 'm1', topicId: 't1', sortOrder: 1.5 }
      } as any)
    ).toMatch(/sortOrder/)
  })

  it('second-audit B5b: relay ingress rejects malformed typed payloads', async () => {
    const { createRelayServer, ensureRelaySchema } = await import('../../../../../scripts/sync-relay/server')
    const relayDb = new Database(':memory:')
    ensureRelaySchema(relayDb as any)
    const server = createRelayServer(relayDb as any, {})
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }
    const base = `http://127.0.0.1:${addr.port}`
    try {
      // New model setup: register two devices + pair forming a channel.
      const uuidA = 'uuid-b5b-a'
      const regA = (await (
        await fetch(`${base}/sync/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: uuidA })
        })
      ).json()) as { deviceCode: string; deviceSecret: string }
      const regB = (await (
        await fetch(`${base}/sync/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: 'uuid-b5b-b' })
        })
      ).json()) as { deviceCode: string; deviceSecret: string }
      const pairReq = (await (
        await fetch(`${base}/sync/pair/request`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-sync-device-code': regB.deviceCode,
            'x-sync-device-secret': regB.deviceSecret
          },
          body: JSON.stringify({ targetCode: regA.deviceCode })
        })
      ).json()) as { requestId: string }
      const acceptRes = await fetch(`${base}/sync/pair/accept`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-sync-device-code': regA.deviceCode,
          'x-sync-device-secret': regA.deviceSecret
        },
        body: JSON.stringify({ requestId: pairReq.requestId })
      })
      expect(acceptRes.status).toBe(200)
      const authHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-sync-device-code': regA.deviceCode,
        'x-sync-device-secret': regA.deviceSecret
      }
      const badTopic = {
        id: 'op-relay-bad-topic',
        entityType: 'topic',
        op: 'upsert',
        entityId: 't-relay-bad',
        timestamp: Date.now(),
        deviceId: uuidA,
        payload: { id: 't-relay-bad', name: 123 }
      }
      const res1 = await fetch(`${base}/sync/push`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ deviceId: uuidA, operations: [badTopic] })
      })
      expect(res1.status).toBe(400)
      const badMismatch = {
        id: 'op-relay-mismatch',
        entityType: 'message',
        op: 'upsert',
        entityId: 'm-relay',
        timestamp: Date.now(),
        deviceId: uuidA,
        payload: { id: 'm-other', topicId: 't1' }
      }
      const res2 = await fetch(`${base}/sync/push`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ deviceId: uuidA, operations: [badMismatch] })
      })
      expect(res2.status).toBe(400)
      const rows = relayDb.prepare('SELECT COUNT(*) as c FROM sync_channel_operations').get() as { c: number }
      expect(rows.c).toBe(0)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      relayDb.close()
    }
  })

  it('second-audit B6: pull framing rejects missing/fractional seq and cursor mismatch', async () => {
    const { syncClient } = await import('../SyncClient')
    const origFetch = globalThis.fetch
    async function pullWith(body: any, cursor = 0): Promise<unknown> {
      ;(globalThis as any).fetch = async () => ({ ok: true, json: async () => body }) as any
      try {
        return await syncClient.pull(
          'http://127.0.0.1:9',
          undefined,
          cursor,
          'd1',
          undefined,
          'ABCD2345',
          'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
        )
      } finally {
        ;(globalThis as any).fetch = origFetch
      }
    }
    const goodOp = (seq: unknown, extra = {}) => ({
      seq,
      id: 'op-frame',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-frame',
      timestamp: 1,
      deviceId: 'remote',
      payload: { id: 't-frame', name: 'T' },
      ...extra
    })
    await expect(pullWith({ operations: [{ ...goodOp(undefined) }], cursor: 0 })).rejects.toThrow(/seq/)
    await expect(pullWith({ operations: [goodOp(1.5)], cursor: 1 })).rejects.toThrow(/seq/)
    await expect(pullWith({ operations: [goodOp(1)], cursor: 999 })).rejects.toThrow(/cursor/)
    await expect(pullWith({ operations: [], cursor: 5 }, 0)).rejects.toThrow(/cursor/)
    await expect(pullWith({ operations: [goodOp(1.5)], cursor: 1 })).rejects.toThrow(/seq/)
  })

  it('malformed apply produces truthful durable sync failure (no success report)', async () => {
    configStore.set('sync:token', '')
    configStore.set('sync:deviceCode', 'ABCD2345')
    configStore.set('sync:deviceAuth', 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90')
    db.insert(schema.syncState)
      .values({ key: 'cursor', value: '0' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: '0' } })
      .run()
    const { syncClient } = await import('../SyncClient')
    const pushMock = vi
      .spyOn(syncClient, 'push')
      .mockImplementation(async () => ({ acceptedIds: [], cursor: 0 }) as any)
    // Bypass client validation by stubbing pull to return a malformed op that
    // only service-level strict validation catches (direct apply path).
    const pullMock = vi
      .spyOn(syncClient, 'pull')
      .mockImplementation(async (_ep: string, _tok: string | undefined, cursor: number) => {
        if (cursor === 0) {
          return {
            operations: [
              {
                seq: 1,
                id: 'op-apply-bad',
                entityType: 'message',
                op: 'upsert',
                entityId: 'm-apply-bad',
                timestamp: Date.now(),
                deviceId: 'remote',
                payload: { id: 'm-apply-bad', role: 'user' }
              }
            ],
            cursor: 1
          } as any
        }
        return { operations: [], cursor } as any
      })
    // The service apply throws; sync() must record lastError and must not
    // report success (no lastSyncAt, cursor unmoved). sync() rejects with the
    // durable apply error so IPC/renderer observe failure, not success.
    await expect(syncService.sync()).rejects.toThrow(/topicId/)
    const status = syncService.getStatus()
    void status
    const errRow = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastError')).get()
    expect(errRow?.value).toBeTruthy()
    const cur = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
    expect(cur?.value ?? '0').toBe('0')
    pullMock.mockRestore()
    pushMock.mockRestore()
  })
})
