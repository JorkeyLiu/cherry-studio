/**
 * Third-audit blocker regressions (F1-F4).
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

import { eq } from 'drizzle-orm'

import { chatDbService } from '../../chatDb'
import { ChatDbAggregateService } from '../../chatDb/ChatDbAggregateService'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { handleChatDbSuccessForSync } from '../chatDbHook'
import { SyncOrphanError, syncService } from '../SyncService'
import { seedRegisteredAttachedSyncService } from './helpers/syncTestRegistration'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
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
  configStore.set('sync:token', '')
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

describe('F1: foreign append ownership guard', () => {
  it('foreign message append fails with zero entity/outbox mutation/capture', async () => {
    const { IpcChannel } = await import('@shared/IpcChannel')
    const agg = new ChatDbAggregateService(db, sqlite)
    // Seed owning topic + message + block
    expect(agg.ensureTopic('t-own', 'a1', 'Own').ok).toBe(true)
    expect(agg.ensureTopic('t-other', 'a1', 'Other').ok).toBe(true)
    const first = agg.appendMessage('t-own', msgJson('m-f1', 't-own') as any, [blockJson('b-f1', 'm-f1') as any])
    expect(first.ok).toBe(true)
    // Capture the legitimate append so outbox starts empty for the foreign attempt
    syncService.clearAllForTests()
    const outboxBefore = syncService.listOutbox().length
    expect(outboxBefore).toBe(0)

    // Foreign append: existing message owned by t-own, request topic t-other, with blocks
    const foreign = agg.appendMessage('t-other', msgJson('m-f1', 't-other', { content: 'evil' }) as any, [
      blockJson('b-f1-evil', 'm-f1', { content: 'evil-block' }) as any
    ])
    expect(foreign.ok).toBe(false)

    // Zero entity mutation: owner preserved, original block untouched, evil block absent
    const msgRow = sqlite.prepare('SELECT topic_id as t, content as c FROM messages WHERE id=?').get('m-f1') as any
    expect(msgRow.t).toBe('t-own')
    expect(msgRow.c).toBe('hi')
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-f1')).toBeTruthy()
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-f1-evil')).toBeUndefined()

    // Zero sync capture: hook on the foreign request emits nothing
    handleChatDbSuccessForSync(IpcChannel.ChatDb_AppendMessage, {
      topicId: 't-other',
      message: msgJson('m-f1', 't-other'),
      blocks: [blockJson('b-f1-evil', 'm-f1')]
    })
    expect(syncService.listOutbox().length).toBe(0)
  })
})

describe('F2: manual sync failure is truthful', () => {
  it('unresolved orphan rejects while status remains inspectable', async () => {
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
                id: 'op-f2-orphan',
                entityType: 'message_block',
                op: 'upsert',
                entityId: 'b-f2',
                timestamp: Date.now(),
                deviceId: 'remote',
                payload: { id: 'b-f2', messageId: 'm-f2-missing', type: 'text', content: 'x' }
              }
            ],
            cursor: 1
          } as any
        }
        return { operations: [], cursor } as any
      })
    await expect(syncService.sync()).rejects.toThrow(/orphan|blocked/i)
    const status = syncService.getStatus()
    expect(status.lastError).toBeTruthy()
    expect(status.lastSyncAt).toBeNull()
    const cur = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
    expect(cur?.value ?? '0').toBe('0')
    pullMock.mockRestore()
    pushMock.mockRestore()
  })
})

describe('F3: no global topic-tombstone suppression', () => {
  it('unrelated topic tombstone does not suppress; later parent resolves block', () => {
    const base = Date.now() - 50000
    // Unrelated topic + hard delete -> unrelated topic tombstone
    syncService.applyIncomingOperation({
      id: 'op-f3-t-unrelated',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-unrelated',
      timestamp: base,
      deviceId: 'd1',
      payload: { id: 't-unrelated', name: 'U' }
    } as any)
    syncService.applyIncomingOperation({
      id: 'op-f3-t-unrelated-del',
      entityType: 'topic',
      op: 'delete',
      entityId: 't-unrelated',
      timestamp: base + 1000,
      deviceId: 'd1'
    } as any)
    // Block for a never-seen parent, older than the unrelated tombstone:
    // must NOT be suppressed -> retryable orphan.
    expect(() =>
      syncService.applyIncomingOperation({
        id: 'op-f3-block-orphan',
        entityType: 'message_block',
        op: 'upsert',
        entityId: 'b-f3',
        timestamp: base + 500,
        deviceId: 'd2',
        payload: { id: 'b-f3', messageId: 'm-f3', type: 'text', content: 'x' }
      } as any)
    ).toThrow(SyncOrphanError)
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-f3')).toBeUndefined()
    // Later parent arrives (newer than tombstone) -> creates placeholder topic + message
    syncService.applyIncomingOperation({
      id: 'op-f3-parent',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm-f3',
      timestamp: base + 2000,
      deviceId: 'd2',
      payload: { id: 'm-f3', topicId: 't-f3', role: 'user', content: 'parent' }
    } as any)
    expect(sqlite.prepare('SELECT id FROM messages WHERE id=?').get('m-f3')).toBeTruthy()
    // Retry block with newer timestamp -> retained/applied
    expect(
      syncService.applyIncomingOperation({
        id: 'op-f3-block-retry',
        entityType: 'message_block',
        op: 'upsert',
        entityId: 'b-f3',
        timestamp: base + 3000,
        deviceId: 'd2',
        payload: { id: 'b-f3', messageId: 'm-f3', type: 'text', content: 'x' }
      } as any)
    ).toBe(true)
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-f3')).toBeTruthy()
  })

  it('topic-cascade positive still suppresses via explicit message tombstone', () => {
    const base = Date.now() - 60000
    syncService.applyIncomingOperation({
      id: 'op-f3c-t',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-f3c',
      timestamp: base,
      deviceId: 'd1',
      payload: { id: 't-f3c', name: 'T' }
    } as any)
    syncService.applyIncomingOperation({
      id: 'op-f3c-m',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm-f3c',
      timestamp: base + 10,
      deviceId: 'd1',
      payload: { id: 'm-f3c', topicId: 't-f3c', role: 'user', content: 'p' }
    } as any)
    syncService.applyIncomingOperation({
      id: 'op-f3c-tdel',
      entityType: 'topic',
      op: 'delete',
      entityId: 't-f3c',
      timestamp: base + 1000,
      deviceId: 'd1'
    } as any)
    let threw = false
    try {
      syncService.applyIncomingOperation({
        id: 'op-f3c-late-b',
        entityType: 'message_block',
        op: 'upsert',
        entityId: 'b-f3c-late',
        timestamp: base + 500,
        deviceId: 'd2',
        payload: { id: 'b-f3c-late', messageId: 'm-f3c', type: 'text', content: 'late' }
      } as any)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-f3c-late')).toBeUndefined()
  })
})

describe('F4: push acks constrained to current chunk', () => {
  it('malicious ack for later outbox op is rejected and remains queued', async () => {
    configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
    configStore.set('sync:enabled', true)
    db.insert(schema.syncState)
      .values({ key: 'cursor', value: '0' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: '0' } })
      .run()
    // Enqueue >1 push chunk so a later-chunk ID exists outside chunk 1
    const { SYNC_MAX_OPERATIONS_PER_PUSH } = await import('@shared/sync')
    const limit = SYNC_MAX_OPERATIONS_PER_PUSH
    const total = limit + 1
    const ids: string[] = []
    for (let i = 0; i < total; i++) {
      const op = syncService.recordUpsert('topic', `t-f4-${i}`, { id: `t-f4-${i}`, name: `T${i}` }, Date.now() + i)
      ids.push(op!.id)
    }
    const laterId = ids[ids.length - 1]
    const { syncClient } = await import('../SyncClient')
    const pushMock = vi
      .spyOn(syncClient, 'push')
      .mockImplementation(async (_ep: string, _t: string | undefined, req: any) => {
        // Faulty relay: ack the exact chunk plus a later-chunk operation ID
        const chunkIds = (req.operations as Array<{ id: string }>).map((o) => o.id)
        return { acceptedIds: [...chunkIds, laterId], cursor: 0 } as any
      })
    const pullMock = vi
      .spyOn(syncClient, 'pull')
      .mockImplementation(
        async (_e: string, _t: string | undefined, c: number) => ({ operations: [], cursor: c }) as any
      )
    await expect(syncService.sync()).rejects.toThrow(/unexpected/)
    // First chunk cleared, but the later outbox op must remain queued
    const remaining = syncService.listOutbox().map((o) => o.id)
    expect(remaining).toContain(laterId)
    const errRow = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastError')).get()
    expect(errRow?.value).toMatch(/unexpected/)
    pushMock.mockRestore()
    pullMock.mockRestore()
  })

  it('push client rejects non-integer cursor and non-string acceptedIds', async () => {
    const { syncClient } = await import('../SyncClient')
    const origFetch = globalThis.fetch
    async function pushWith(body: any): Promise<unknown> {
      ;(globalThis as any).fetch = async () => ({ ok: true, json: async () => body }) as any
      try {
        return await syncClient.push(
          'http://127.0.0.1:9',
          undefined,
          { deviceId: 'd1', operations: [] } as any,
          undefined,
          'ABCD2345',
          'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
        )
      } finally {
        ;(globalThis as any).fetch = origFetch
      }
    }
    await expect(pushWith({ acceptedIds: [], cursor: 1.5 })).rejects.toThrow(/cursor/)
    await expect(pushWith({ acceptedIds: [], cursor: -1 })).rejects.toThrow(/cursor/)
    await expect(pushWith({ acceptedIds: [123], cursor: 0 })).rejects.toThrow(/acceptedIds/)
    await expect(pushWith({ acceptedIds: [''], cursor: 0 })).rejects.toThrow(/acceptedIds/)
  })
})
