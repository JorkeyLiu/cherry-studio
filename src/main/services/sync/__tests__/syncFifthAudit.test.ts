/**
 * Fifth-audit blocker regressions (LOCK-PERSONAL-001/004/006).
 * - Fail-closed capture context: enabled infra errors propagate (never false).
 * - Stable-child parent closure never emits a transient assistant parent.
 * - Config-generation boundary cancels stale in-flight sync() cycles.
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

import { configManager } from '@main/services/ConfigManager'
import { eq } from 'drizzle-orm'

import { chatDbService } from '../../chatDb'
import { ChatDbAggregateService } from '../../chatDb/ChatDbAggregateService'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { handleChatDbSuccessForSync } from '../chatDbHook'
import { syncService, SyncStaleConfigError } from '../SyncService'
import { seedRegisteredAttachedSyncService } from './helpers/syncTestRegistration'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

function membershipOf(
  childType: string,
  childId: string
): { parentId: string; timestamp: number; operationId: string } | null {
  const r = sqlite
    .prepare(
      `SELECT parent_id as parentId, timestamp, operation_id as operationId FROM sync_membership_clock WHERE child_entity_type=? AND child_entity_id=?`
    )
    .get(childType, childId) as { parentId: string; timestamp: number; operationId: string } | undefined
  return r ?? null
}

function blockFrameOf(messageId: string): { orderedChildIds: string[]; timestamp: number; operationId: string } | null {
  const r = sqlite
    .prepare(
      `SELECT ordered_child_ids_json AS json, timestamp, operation_id AS operationId FROM sync_parent_order_frame WHERE kind='messageBlock' AND parent_id=?`
    )
    .get(messageId) as { json: string; timestamp: number; operationId: string } | undefined
  if (!r) return null
  return { orderedChildIds: JSON.parse(r.json) as string[], timestamp: r.timestamp, operationId: r.operationId }
}

function frameOpsFor(entityId: string) {
  return syncService.listOutbox().filter((r) => (r as { op?: string }).op === 'order_frame' && r.entityId === entityId)
}

function msgJson(id: string, topicId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    topicId,
    role: 'user',
    content: 'hi',
    status: 'success',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra
  } as Record<string, unknown>
}

function blockJson(id: string, messageId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    messageId,
    type: 'text',
    content: 'body',
    status: 'success',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra
  } as Record<string, unknown>
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
  vi.restoreAllMocks()
})

describe('blocker 1: enabled capture-context failures fail closed (never false)', () => {
  it('isCaptureEnabled throws on config infrastructure failure; confirmed-disabled stays the only false', () => {
    expect(syncService.isCaptureEnabled()).toBe(true)
    const spy = vi.spyOn(configManager, 'get').mockImplementation(() => {
      throw new Error('config-store-boom')
    })
    try {
      expect(() => syncService.isCaptureEnabled()).toThrow(/config-store-boom/)
    } finally {
      spy.mockRestore()
    }
    configStore.set('sync:enabled', false)
    expect(syncService.isCaptureEnabled()).toBe(false)
  })

  it('isTracked/isKnown Tx checks propagate infra errors but tolerate genuinely absent tables', () => {
    const throwingTx = {
      select: () => {
        throw new Error('infra-boom')
      }
    } as never
    expect(() => syncService.isTrackedEntityInTx(throwingTx, 'topic', 't-x')).toThrow(/infra-boom/)
    expect(() => syncService.isKnownEntityInTx(throwingTx, 'message', 'm-x')).toThrow(/infra-boom/)
    // Pre-migration database without sync tables: truthful miss, not a failure.
    const bare = openInMemory()
    try {
      const bareDb = drizzle(bare, { schema })
      expect(syncService.isTrackedEntityInTx(bareDb as never, 'topic', 't-x')).toBe(false)
      expect(syncService.isKnownEntityInTx(bareDb as never, 'topic', 't-x')).toBe(false)
    } finally {
      bare.close()
    }
  })

  it('aggregate tracked-read failure rolls back the mutation with a durable capture error', () => {
    const agg = new ChatDbAggregateService(db, sqlite)
    expect(agg.ensureTopic('t-read-fail', 'a1', 'T').ok).toBe(true)
    const spy = vi.spyOn(syncService, 'isTrackedEntityInTx').mockImplementation(() => {
      throw new Error('clock-read-boom')
    })
    try {
      const res = agg.appendMessage('t-read-fail', msgJson('m-read-fail', 't-read-fail') as any, [])
      expect(res.ok).toBe(false)
      expect(sqlite.prepare('SELECT id FROM messages WHERE id=?').get('m-read-fail')).toBeUndefined()
      const cap = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastCaptureError')).get()
      expect(cap?.value).toMatch(/clock-read-boom/)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('blocker 2: parent closure never emits a transient assistant parent (LOCK-PERSONAL-004)', () => {
  it('aggregate stable-block write under a transient parent commits locally with no outbox and no capture failure (capture deferral)', () => {
    const agg = new ChatDbAggregateService(db, sqlite)
    expect(agg.ensureTopic('t-pc', 'a1', 'T').ok).toBe(true)
    // Transient assistant stub commits locally but captures nothing.
    const stub = agg.appendMessage(
      't-pc',
      msgJson('m-pc', 't-pc', { role: 'assistant', status: 'streaming', content: 'partial' }) as any,
      []
    )
    expect(stub.ok).toBe(true)
    const outboxAfterStub = syncService.listOutbox()
    expect(outboxAfterStub.some((o) => o.entityId === 'm-pc')).toBe(false)
    // A stable block for the still-transient parent must not emit the parent:
    // authoritative local mutation commits, no sync op/frame, no durable error.
    const res = agg.updateMessageAndBlocks('t-pc', { id: 'm-pc' } as any, [
      blockJson('b-pc', 'm-pc', { status: 'success' }) as any
    ])
    expect(res.ok).toBe(true)
    const ops = syncService.listOutbox()
    expect(ops.some((o) => o.entityId === 'm-pc')).toBe(false)
    expect(ops.some((o) => o.entityId === 'b-pc')).toBe(false)
    expect(membershipOf('message_block', 'b-pc')).toBeNull()
    expect(blockFrameOf('m-pc')).toBeNull()
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-pc')).toBeDefined()
    const cap = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastCaptureError')).get()
    expect(cap?.value ?? null).toBeNull()
    // Missing message via updateMessageAndBlocks is Dexie-compatible no-op
    // (existing semantics: ok true, no block write, no sync intent) — not a
    // closure throw. Assert absence explicitly rather than claiming a throw.
    const bad = agg.updateMessageAndBlocks('t-pc', { id: 'm-missing-parent' } as any, [
      blockJson('b-bad', 'm-missing-parent', { status: 'success' }) as any
    ])
    expect(bad.ok).toBe(true)
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-bad')).toBeUndefined()
    expect(syncService.listOutbox().some((o) => o.entityId === 'b-bad')).toBe(false)
    expect(syncService.listOutbox().some((o) => o.entityId === 'm-missing-parent')).toBe(false)
    expect(blockFrameOf('m-missing-parent')).toBeNull()
  })

  it('standalone updateMessage parent promotion captures the deferred identical block with membership and winning frame', () => {
    const agg = new ChatDbAggregateService(db, sqlite)
    expect(agg.ensureTopic('t-standalone', 'a1', 'T').ok).toBe(true)
    expect(
      agg.appendMessage(
        't-standalone',
        msgJson('m-standalone', 't-standalone', { role: 'assistant', status: 'pending', content: 'partial' }) as any,
        []
      ).ok
    ).toBe(true)
    // Deferred stable block persists locally with no sync intent.
    const deferred = agg.updateBlocks([blockJson('b-standalone', 'm-standalone', { status: 'success' }) as any])
    expect(deferred.ok).toBe(true)
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-standalone')).toBeDefined()
    expect(syncService.listOutbox().some((o) => o.entityId === 'b-standalone')).toBe(false)
    expect(membershipOf('message_block', 'b-standalone')).toBeNull()
    expect(
      db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastCaptureError')).get()?.value ?? null
    ).toBeNull()
    // Standalone parent promotion (no requested blocks): same-tx full closure.
    const promote = agg.updateMessage('t-standalone', 'm-standalone', { status: 'success', content: 'final' } as any)
    expect(promote.ok).toBe(true)
    expect(syncService.listOutbox().some((o) => o.entityId === 'm-standalone')).toBe(true)
    expect(syncService.listOutbox().some((o) => o.entityId === 'b-standalone')).toBe(true)
    const blockMembership = membershipOf('message_block', 'b-standalone')
    expect(blockMembership?.parentId).toBe('m-standalone')
    const frame = blockFrameOf('m-standalone')
    expect(frame?.orderedChildIds).toEqual(['b-standalone'])
    expect(frameOpsFor('m-standalone').length).toBe(1)
    // Idempotence: repeating the stable checkpoint emits no duplicate block
    // entity/frame capture and never rewrites membership (at most a message
    // patch for the repeat write itself; block/frame counts stay fixed).
    const blockOpsBefore = syncService
      .listOutbox()
      .filter((o) => o.entityId === 'b-standalone' && (o as { op?: string }).op !== 'order_frame').length
    const frameOpsBefore = frameOpsFor('m-standalone').length
    const memBefore = membershipOf('message_block', 'b-standalone')
    const repeat = agg.updateMessage('t-standalone', 'm-standalone', { content: 'final' } as any)
    expect(repeat.ok).toBe(true)
    expect(
      syncService
        .listOutbox()
        .filter((o) => o.entityId === 'b-standalone' && (o as { op?: string }).op !== 'order_frame').length
    ).toBe(blockOpsBefore)
    expect(frameOpsFor('m-standalone').length).toBe(frameOpsBefore)
    expect(membershipOf('message_block', 'b-standalone')).toEqual(memBefore)
    expect(blockFrameOf('m-standalone')?.orderedChildIds).toEqual(['b-standalone'])
  })

  it('atomic updateMessageAndBlocks parent promotion with identical block content captures membership and winning frame', () => {
    const agg = new ChatDbAggregateService(db, sqlite)
    expect(agg.ensureTopic('t-atomic', 'a1', 'T').ok).toBe(true)
    expect(
      agg.appendMessage(
        't-atomic',
        msgJson('m-atomic', 't-atomic', { role: 'assistant', status: 'pending', content: 'partial' }) as any,
        []
      ).ok
    ).toBe(true)
    const deferred = agg.updateBlocks([blockJson('b-atomic', 'm-atomic', { status: 'success' }) as any])
    expect(deferred.ok).toBe(true)
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-atomic')).toBeDefined()
    expect(syncService.listOutbox().some((o) => o.entityId === 'b-atomic')).toBe(false)
    expect(membershipOf('message_block', 'b-atomic')).toBeNull()
    // Atomic parent promotion with IDENTICAL block content (null diff): the
    // deferred row must still emit its full closure + membership + frame in
    // the same tx (single block upsert, no duplicate, no transient wire).
    // Reuse the same block object for promote+repeat so timestamps are truly
    // identical (blockJson generates fresh timestamps per call).
    const atomicBlock = blockJson('b-atomic', 'm-atomic', { status: 'success' }) as any
    const promote = agg.updateMessageAndBlocks(
      't-atomic',
      { id: 'm-atomic', status: 'success', content: 'final' } as any,
      [atomicBlock]
    )
    expect(promote.ok).toBe(true)
    expect(syncService.listOutbox().some((o) => o.entityId === 'm-atomic')).toBe(true)
    const blockOps = syncService
      .listOutbox()
      .filter((o) => o.entityId === 'b-atomic' && (o as { op?: string }).op !== 'order_frame')
    expect(blockOps.length).toBe(1)
    expect(membershipOf('message_block', 'b-atomic')?.parentId).toBe('m-atomic')
    expect(blockFrameOf('m-atomic')?.orderedChildIds).toEqual(['b-atomic'])
    expect(frameOpsFor('m-atomic').length).toBe(1)
    // Idempotence: repeating the identical atomic checkpoint adds no duplicate
    // block entity/frame capture and never rewrites membership.
    const blockOpsBefore = syncService
      .listOutbox()
      .filter((o) => o.entityId === 'b-atomic' && (o as { op?: string }).op !== 'order_frame').length
    const atomicFrameBefore = frameOpsFor('m-atomic').length
    const atomicMemBefore = membershipOf('message_block', 'b-atomic')
    const repeat = agg.updateMessageAndBlocks('t-atomic', { id: 'm-atomic', content: 'final' } as any, [atomicBlock])
    expect(repeat.ok).toBe(true)
    expect(
      syncService.listOutbox().filter((o) => o.entityId === 'b-atomic' && (o as { op?: string }).op !== 'order_frame')
        .length
    ).toBe(blockOpsBefore)
    expect(frameOpsFor('m-atomic').length).toBe(atomicFrameBefore)
    expect(membershipOf('message_block', 'b-atomic')).toEqual(atomicMemBefore)
  })

  it('genuine missing-parent block write stays fail-closed with rollback and no sync intent', () => {
    const agg = new ChatDbAggregateService(db, sqlite)
    expect(agg.ensureTopic('t-missing', 'a1', 'T').ok).toBe(true)
    // updateBlocks against a genuinely missing parent cannot commit the child:
    // FK rollback, absent row, no outbox, no membership, no frame.
    const bad = agg.updateBlocks([blockJson('b-missing', 'm-does-not-exist', { status: 'success' }) as any])
    expect(bad.ok).toBe(false)
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-missing')).toBeUndefined()
    expect(syncService.listOutbox().some((o) => o.entityId === 'b-missing')).toBe(false)
    expect(membershipOf('message_block', 'b-missing')).toBeNull()
    expect(blockFrameOf('m-does-not-exist')).toBeNull()
  })

  it('post-commit hook defers a stable block under a transient parent without emitting it and without a capture failure', async () => {
    const { IpcChannel } = await import('@shared/IpcChannel')
    const agg = new ChatDbAggregateService(db, sqlite)
    // Build rows with capture disabled so no intent exists for either entity.
    configStore.set('sync:enabled', false)
    expect(agg.ensureTopic('t-hk', 'a1', 'T').ok).toBe(true)
    expect(
      agg.appendMessage(
        't-hk',
        msgJson('m-hk', 't-hk', { role: 'assistant', status: 'streaming', content: 'partial' }) as any,
        [blockJson('b-hk', 'm-hk', { status: 'success' }) as any]
      ).ok
    ).toBe(true)
    configStore.set('sync:enabled', true)
    // Track only the topic so message closure must attempt a parent capture.
    syncService.recordUpsert('topic', 't-hk', { id: 't-hk', name: 'T' }, Date.now() - 10)
    const before = syncService.listOutbox().length
    handleChatDbSuccessForSync(IpcChannel.ChatDb_UpdateSingleBlock, { blockId: 'b-hk' })
    const ops = syncService.listOutbox()
    expect(ops.length).toBe(before)
    expect(ops.some((o) => o.entityType === 'message' && o.entityId === 'm-hk')).toBe(false)
    const cap = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastCaptureError')).get()
    expect(cap?.value ?? null).toBeNull()
  })
})

describe('blocker 3: config generation cancels stale in-flight sync (LOCK-PERSONAL-001)', () => {
  it('setConfig bumps the generation only on disable/endpoint transitions; legacy token is rejected', () => {
    const g0 = syncService.getConfigGeneration()
    syncService.setConfig({})
    expect(syncService.getConfigGeneration()).toBe(g0)
    syncService.setConfig({ endpoint: 'http://127.0.0.1:9998' })
    expect(syncService.getConfigGeneration()).toBe(g0 + 1)
    syncService.setConfig({ endpoint: 'http://127.0.0.1:9998' })
    expect(syncService.getConfigGeneration()).toBe(g0 + 1)
    syncService.setConfig({ enabled: false })
    expect(syncService.getConfigGeneration()).toBe(g0 + 2)
    // Legacy shared token is rejected without a generation bump (no stale invalidation).
    expect(() => syncService.setConfig({ token: 'rotated' } as never)).toThrow(/no longer supported/)
    expect(syncService.getConfigGeneration()).toBe(g0 + 2)
  })

  it('mid-flight endpoint rotation aborts before stale outbox clears or cursor/status writes', async () => {
    const { syncClient } = await import('../SyncClient')
    syncService.recordUpsert('topic', 't-stale', { id: 't-stale', name: 'S' }, Date.now())
    const outboxBefore = syncService.listOutbox().length
    expect(outboxBefore).toBeGreaterThan(0)
    const pushMock = vi.spyOn(syncClient, 'push').mockImplementation(async (_ep, req) => {
      // Simulate a disable/endpoint transition racing the in-flight push.
      syncService.setConfig({ endpoint: 'http://127.0.0.1:9998' })
      return { cursor: 0, acceptedIds: (req.operations as Array<{ id: string }>).map((o) => o.id) } as never
    })
    const pullMock = vi.spyOn(syncClient, 'pull').mockResolvedValue({ operations: [], cursor: 0 } as never)
    try {
      await expect(syncService.sync()).rejects.toBeInstanceOf(SyncStaleConfigError)
      // No post-transition effects: outbox retained, cursor unmoved, no stale status.
      expect(syncService.listOutbox().length).toBe(outboxBefore)
      const cur = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
      expect(cur?.value ?? '0').toBe('0')
      expect(pullMock).not.toHaveBeenCalled()
      expect(syncService.getStatus().lastSyncAt).toBeNull()
    } finally {
      pushMock.mockRestore()
      pullMock.mockRestore()
    }
  })

  it('automatic drain stops (no retry) when the cycle is invalidated by a config change', async () => {
    const { SyncAutoService } = await import('../syncAuto')
    let calls = 0
    const svc = new SyncAutoService({
      getConfig: () => ({ endpoint: 'http://127.0.0.1:9', enabled: true }),
      isAttached: () => true,
      getCredentials: () => ({
        deviceCode: 'ABCD2345',
        deviceSecret: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
      }),
      runSync: async () => {
        calls += 1
        throw new SyncStaleConfigError()
      },
      createSubscriber: () => ({ start: () => {}, stop: () => {}, isActive: () => false }) as never
    })
    svc.start()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(calls).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(calls).toBe(1)
    svc.stopSync()
  })
})
