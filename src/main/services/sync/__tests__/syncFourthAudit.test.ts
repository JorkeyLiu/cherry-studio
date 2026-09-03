/**
 * Fourth-audit blocker regressions: topic-tombstone child containment,
 * push no-progress fail-closed, contiguous pull framing.
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
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { syncService } from '../SyncService'

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
  configStore.set('sync:token', '')
  sqlite = openInMemory()
  db = drizzle(sqlite, { schema })
  runMigrations(db as any, sqlite)
  ;(chatDbService as any).sqlite = sqlite
  ;(chatDbService as any).db = db
  syncService.clearAllForTests()
})

afterEach(() => {
  try {
    sqlite.close()
  } catch {}
  ;(chatDbService as any).sqlite = null
  ;(chatDbService as any).db = null
})

describe('fourth audit 1: topic-tombstone suppression materializes exact message tombstone', () => {
  it('stale unmaterialized message suppressed, then stale block suppressed via specific tombstone', () => {
    const base = Date.now() - 100000
    syncService.applyIncomingOperation({
      id: 'op-4a-t',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-ghost-topic',
      timestamp: base,
      deviceId: 'd1',
      payload: { id: 't-ghost-topic', name: 'T' }
    } as any)
    syncService.applyIncomingOperation({
      id: 'op-4a-tdel',
      entityType: 'topic',
      op: 'delete',
      entityId: 't-ghost-topic',
      timestamp: base + 1000,
      deviceId: 'd1'
    } as any)
    expect(sqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-ghost-topic')).toBeUndefined()
    // Stale message never materialized locally: suppressed by topic tombstone, no throw
    let threwMsg = false
    try {
      syncService.applyIncomingOperation({
        id: 'op-4a-stale-msg',
        entityType: 'message',
        op: 'upsert',
        entityId: 'm-ghost',
        timestamp: base + 500,
        deviceId: 'd2',
        payload: { id: 'm-ghost', topicId: 't-ghost-topic', role: 'user', content: 'late' }
      } as any)
    } catch {
      threwMsg = true
    }
    expect(threwMsg).toBe(false)
    expect(sqlite.prepare('SELECT id FROM messages WHERE id=?').get('m-ghost')).toBeUndefined()
    expect(sqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-ghost-topic')).toBeUndefined()
    // Exact message tombstone must exist (no global scan): inherits topic delete timestamp+opId
    const tomb = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'tombstone:message:m-ghost')).get()
    expect(tomb?.value).toBe(`${String(base + 1000)}:op-4a-tdel`)
    // Later stale block for that message: suppressed via specific message tombstone, no orphan
    let threwBlock = false
    try {
      syncService.applyIncomingOperation({
        id: 'op-4a-stale-block',
        entityType: 'message_block',
        op: 'upsert',
        entityId: 'b-ghost',
        timestamp: base + 500,
        deviceId: 'd2',
        payload: { id: 'b-ghost', messageId: 'm-ghost', type: 'text', content: 'late' }
      } as any)
    } catch {
      threwBlock = true
    }
    expect(threwBlock).toBe(false)
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-ghost')).toBeUndefined()
    expect(sqlite.prepare('SELECT id FROM messages WHERE id=?').get('m-ghost')).toBeUndefined()
  })

  it('topic deletion -> stale message -> stale block via pull advances cursor with no error', async () => {
    db.insert(schema.syncState)
      .values({ key: 'cursor', value: '0' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: '0' } })
      .run()
    const { syncClient } = await import('../SyncClient')
    const pushMock = vi
      .spyOn(syncClient, 'push')
      .mockImplementation(async () => ({ acceptedIds: [], cursor: 0 }) as any)
    const base = Date.now() - 100000
    const pullMock = vi
      .spyOn(syncClient, 'pull')
      .mockImplementation(async (_ep: string, _tok: string | undefined, cursor: number) => {
        if (cursor === 0) {
          return {
            operations: [
              {
                seq: 1,
                id: 'op-4a-pull-t',
                entityType: 'topic',
                op: 'upsert',
                entityId: 't-pull-ghost',
                timestamp: base,
                deviceId: 'remote',
                payload: { id: 't-pull-ghost', name: 'T' }
              },
              {
                seq: 2,
                id: 'op-4a-pull-tdel',
                entityType: 'topic',
                op: 'delete',
                entityId: 't-pull-ghost',
                timestamp: base + 1000,
                deviceId: 'remote'
              },
              {
                seq: 3,
                id: 'op-4a-pull-msg',
                entityType: 'message',
                op: 'upsert',
                entityId: 'm-pull-ghost',
                timestamp: base + 500,
                deviceId: 'remote',
                payload: { id: 'm-pull-ghost', topicId: 't-pull-ghost', role: 'user', content: 'late' }
              },
              {
                seq: 4,
                id: 'op-4a-pull-block',
                entityType: 'message_block',
                op: 'upsert',
                entityId: 'b-pull-ghost',
                timestamp: base + 500,
                deviceId: 'remote',
                payload: { id: 'b-pull-ghost', messageId: 'm-pull-ghost', type: 'text', content: 'late' }
              }
            ],
            cursor: 4
          } as any
        }
        return { operations: [], cursor } as any
      })
    await syncService.sync()
    expect(sqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-pull-ghost')).toBeUndefined()
    expect(sqlite.prepare('SELECT id FROM messages WHERE id=?').get('m-pull-ghost')).toBeUndefined()
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-pull-ghost')).toBeUndefined()
    const cur = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
    expect(cur?.value).toBe('4')
    const errRow = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastError')).get()
    expect(errRow).toBeUndefined()
    const okAt = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastSyncAt')).get()
    expect(okAt?.value).toBeTruthy()
    pullMock.mockRestore()
    pushMock.mockRestore()
  })
})

describe('fourth audit 2: push progress validation fails closed', () => {
  it('non-empty push with empty ack rejects durably with outbox retained', async () => {
    db.insert(schema.syncState)
      .values({ key: 'cursor', value: '0' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: '0' } })
      .run()
    syncService.recordUpsert('topic', 't-noprog', { id: 't-noprog', name: 'N' }, Date.now())
    expect(syncService.listOutbox().length).toBe(1)
    const { syncClient } = await import('../SyncClient')
    let pullCalls = 0
    const pushMock = vi
      .spyOn(syncClient, 'push')
      .mockImplementation(async () => ({ acceptedIds: [], cursor: 0 }) as any)
    const pullMock = vi
      .spyOn(syncClient, 'pull')
      .mockImplementation(async (_e: string, _t: string | undefined, c: number) => {
        pullCalls++
        return { operations: [], cursor: c } as any
      })
    await expect(syncService.sync()).rejects.toThrow(/no progress/)
    // Finite: outbox retained (no loss), pull never reached, no success timestamp
    expect(syncService.listOutbox().length).toBe(1)
    expect(pullCalls).toBe(0)
    const errRow = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastError')).get()
    expect(errRow?.value).toMatch(/no progress/)
    const okAt = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastSyncAt')).get()
    expect(okAt).toBeUndefined()
    const cur = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
    expect(cur?.value ?? '0').toBe('0')
    pushMock.mockRestore()
    pullMock.mockRestore()
  })

  it('partial ack clears acknowledged ops and retries remainder to success', async () => {
    db.insert(schema.syncState)
      .values({ key: 'cursor', value: '0' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: '0' } })
      .run()
    const op1 = syncService.recordUpsert('topic', 't-part-1', { id: 't-part-1', name: 'P1' }, Date.now())
    const op2 = syncService.recordUpsert('topic', 't-part-2', { id: 't-part-2', name: 'P2' }, Date.now() + 1)
    expect(syncService.listOutbox().length).toBe(2)
    const { syncClient } = await import('../SyncClient')
    let pushCalls = 0
    const pushMock = vi
      .spyOn(syncClient, 'push')
      .mockImplementation(async (_ep: string, _t: string | undefined, req: any) => {
        pushCalls++
        const ids = (req.operations as Array<{ id: string }>).map((o) => o.id)
        if (pushCalls === 1) {
          // Partial: ack only the first id
          return { acceptedIds: [ids[0]], cursor: 0 } as any
        }
        return { acceptedIds: ids, cursor: 0 } as any
      })
    const pullMock = vi
      .spyOn(syncClient, 'pull')
      .mockImplementation(
        async (_e: string, _t: string | undefined, c: number) => ({ operations: [], cursor: c }) as any
      )
    await syncService.sync()
    expect(pushCalls).toBe(2)
    expect(syncService.listOutbox().length).toBe(0)
    expect(op1).toBeTruthy()
    expect(op2).toBeTruthy()
    const errRow = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastError')).get()
    expect(errRow).toBeUndefined()
    pushMock.mockRestore()
    pullMock.mockRestore()
  })
})

describe('fourth audit 3: contiguous pull framing rejects gaps', () => {
  it('SyncClient rejects non-contiguous seq and cursor mismatch', async () => {
    const { syncClient } = await import('../SyncClient')
    const origFetch = globalThis.fetch
    async function pullWith(body: any, cursor = 0): Promise<unknown> {
      ;(globalThis as any).fetch = async () => ({ ok: true, json: async () => body }) as any
      try {
        return await syncClient.pull('http://127.0.0.1:9', undefined, cursor, 'd1')
      } finally {
        ;(globalThis as any).fetch = origFetch
      }
    }
    const goodOp = (seq: unknown, id = 'op-gap', entityId = 't-gap') => ({
      seq,
      id: `${id}-${String(seq)}`,
      entityType: 'topic',
      op: 'upsert',
      entityId,
      timestamp: 1,
      deviceId: 'remote',
      payload: { id: entityId, name: 'T' }
    })
    // Gap: cursor 0, seqs 1 then 3 (missing 2)
    await expect(
      pullWith({ operations: [goodOp(1, 'g1', 't-g1'), goodOp(3, 'g3', 't-g3')], cursor: 3 }, 0)
    ).rejects.toThrow(/non-contiguous/)
    // Offset start: cursor 0 but first seq 2
    await expect(pullWith({ operations: [goodOp(2, 'o2', 't-o2')], cursor: 2 }, 0)).rejects.toThrow(/non-contiguous/)
    // Cursor must equal last seq
    await expect(pullWith({ operations: [goodOp(1, 'c1', 't-c1')], cursor: 99 }, 0)).rejects.toThrow(
      /cursor.*last seq|last seq/
    )
    // Contiguous valid frame passes
    const ok = (await pullWith(
      { operations: [goodOp(1, 'ok1', 't-ok1'), goodOp(2, 'ok2', 't-ok2')], cursor: 2 },
      0
    )) as any
    expect(ok.operations.length).toBe(2)
    expect(ok.cursor).toBe(2)
  })

  it('SyncService rejects gapped pull before application with truthful durable error', async () => {
    db.insert(schema.syncState)
      .values({ key: 'cursor', value: '0' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: '0' } })
      .run()
    const { syncClient } = await import('../SyncClient')
    const pushMock = vi
      .spyOn(syncClient, 'push')
      .mockImplementation(async () => ({ acceptedIds: [], cursor: 0 }) as any)
    // Bypass client validation via stubbed pull: seq 1 then 3 (gap skips 2)
    const pullMock = vi
      .spyOn(syncClient, 'pull')
      .mockImplementation(async (_ep: string, _tok: string | undefined, cursor: number) => {
        if (cursor === 0) {
          return {
            operations: [
              {
                seq: 1,
                id: 'op-gap-svc-1',
                entityType: 'topic',
                op: 'upsert',
                entityId: 't-gap-svc-1',
                timestamp: Date.now(),
                deviceId: 'remote',
                payload: { id: 't-gap-svc-1', name: 'G1' }
              },
              {
                seq: 3,
                id: 'op-gap-svc-3',
                entityType: 'topic',
                op: 'upsert',
                entityId: 't-gap-svc-3',
                timestamp: Date.now(),
                deviceId: 'remote',
                payload: { id: 't-gap-svc-3', name: 'G3' }
              }
            ],
            cursor: 3
          } as any
        }
        return { operations: [], cursor } as any
      })
    await expect(syncService.sync()).rejects.toThrow(/non-contiguous/)
    // Nothing applied past the gap: neither op materialized, cursor unmoved, no success
    expect(sqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-gap-svc-1')).toBeUndefined()
    expect(sqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-gap-svc-3')).toBeUndefined()
    const cur = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
    expect(cur?.value ?? '0').toBe('0')
    const errRow = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastError')).get()
    expect(errRow?.value).toMatch(/non-contiguous/)
    const okAt = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastSyncAt')).get()
    expect(okAt).toBeUndefined()
    pullMock.mockRestore()
    pushMock.mockRestore()
  })
})
