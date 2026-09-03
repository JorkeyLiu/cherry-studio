/**
 * Blocker regression tests — cursor skip, local clock/LWW, orphan retry, full update semantics, soft/hard delete
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
import { SyncOrphanError, syncService } from '../SyncService'

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

describe('local clock LWW with outbox', () => {
  it('newer local outbox wins over older incoming', () => {
    const base = 1_000_000
    // Create topic via direct apply (newer)
    syncService.applyIncomingOperation({
      id: 'op-create-local',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-clock',
      timestamp: base + 2000,
      deviceId: 'local',
      payload: {
        id: 't-clock',
        name: 'LocalNewer',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    } as any)
    // Also enqueue a newer local outbox operation (simulates pending local edit)
    syncService.recordUpsert('topic', 't-clock', { id: 't-clock', name: 'LocalNewerPending' }, base + 2500)
    // incoming older should be rejected via shouldApplyIncoming (checks clock which is now 2500)
    const incoming: any = {
      id: 'op-old',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-clock',
      timestamp: base + 1000,
      deviceId: 'remote',
      payload: { id: 't-clock', name: 'RemoteOlder' }
    }
    expect(syncService.shouldApplyIncoming(incoming)).toBe(false)
    expect(syncService.applyIncomingOperation(incoming)).toBe(false)
    const after = sqlite.prepare('SELECT name FROM topics WHERE id=?').get('t-clock') as { name: string }
    expect(after.name).toBe('LocalNewer')
    // Older remote still rejected
    const secondTry: any = {
      id: 'op-old-2',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-clock',
      timestamp: base + 500,
      deviceId: 'remote',
      payload: { id: 't-clock', name: 'RemoteEvenOlder' }
    }
    expect(syncService.applyIncomingOperation(secondTry)).toBe(false)
    const final = sqlite.prepare('SELECT name FROM topics WHERE id=?').get('t-clock') as { name: string }
    expect(final.name).toBe('LocalNewer')
  })

  it('enqueue updates clock atomically', () => {
    const ts1 = Date.now()
    syncService.recordUpsert('topic', 't-atomic', { id: 't-atomic', name: 'A' }, ts1)
    // clock should exist
    const clock = db
      .select()
      .from(schema.syncEntityClock)
      .all()
      .find((r) => r.entityId === 't-atomic')
    expect(clock).toBeTruthy()
    expect(clock!.timestamp).toBe(ts1)
    const ts2 = ts1 + 1000
    syncService.recordUpsert('topic', 't-atomic', { id: 't-atomic', name: 'B' }, ts2)
    const clock2 = db
      .select()
      .from(schema.syncEntityClock)
      .all()
      .find((r) => r.entityId === 't-atomic')
    expect(clock2!.timestamp).toBe(ts2)
    // older incoming should lose
    const incoming: any = {
      id: 'op-older-than-clock',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-atomic',
      timestamp: ts1,
      deviceId: 'remote',
      payload: { id: 't-atomic', name: 'Old' }
    }
    expect(syncService.shouldApplyIncoming(incoming)).toBe(false)
  })
})

describe('orphan block retry not marked applied', () => {
  it('orphan block throws and is retryable', () => {
    const blockOp: any = {
      id: 'op-block-orphan',
      entityType: 'message_block',
      op: 'upsert',
      entityId: 'b-orphan',
      timestamp: Date.now(),
      deviceId: 'remote',
      payload: { id: 'b-orphan', messageId: 'm-missing', type: 'text', content: 'hi' }
    }
    expect(() => syncService.applyIncomingOperation(blockOp)).toThrow(SyncOrphanError)
    // not marked applied
    const found = db
      .select()
      .from(schema.syncApplied)
      .all()
      .find((r) => r.operationId === 'op-block-orphan')
    expect(found).toBeUndefined()
    // clock not updated
    const clock = db
      .select()
      .from(schema.syncEntityClock)
      .all()
      .find((r) => r.entityId === 'b-orphan')
    expect(clock).toBeUndefined()

    // Create parent message
    const msgOp: any = {
      id: 'op-msg-parent',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm-missing',
      timestamp: Date.now() - 1000,
      deviceId: 'remote',
      payload: { id: 'm-missing', topicId: 't-orphan', role: 'user', content: 'parent' }
    }
    expect(syncService.applyIncomingOperation(msgOp)).toBe(true)
    // Now retry block — should succeed
    const blockOp2 = { ...blockOp, id: 'op-block-orphan-2', timestamp: Date.now() }
    expect(syncService.applyIncomingOperation(blockOp2)).toBe(true)
    const blockRow = sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-orphan') as any
    expect(blockRow).toBeTruthy()
  })
})

describe('full update semantics', () => {
  it('update message enqueues full allowlisted snapshot not partial patch', () => {
    // Create topic+message
    syncService.applyIncomingOperation({
      id: 'op-create-topic',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-full',
      timestamp: Date.now() - 2000,
      deviceId: 'd1',
      payload: { id: 't-full', name: 'T' }
    } as any)
    syncService.applyIncomingOperation({
      id: 'op-create-msg',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm-full',
      timestamp: Date.now() - 1000,
      deviceId: 'd1',
      payload: { id: 'm-full', topicId: 't-full', role: 'user', content: 'orig', status: 'sent' }
    } as any)
    // Now local mutation with full fetch — simulate chatDbHook fetching full after update
    // Directly use recordUpsert with full payload (already allowlisted)
    // If we only sent partial {content: 'updated'} as full replacement, apply would wipe other fields
    // Our apply uses full payload; test that partial would still preserve via full fetch path
    const fullAfter = db.select().from(schema.messages).where(eq(schema.messages.id, 'm-full')).get() as any
    expect(fullAfter.content).toBe('orig')
    // Simulate updating content via full entity
    const updatedPayload = {
      id: 'm-full',
      topicId: 't-full',
      role: 'user',
      content: 'updated',
      status: 'sent',
      createdAt: fullAfter.createdAt,
      updatedAt: new Date().toISOString(),
      sortOrder: fullAfter.sortOrder
    }
    syncService.recordUpsert('message', 'm-full', updatedPayload, Date.now())
    const outbox = syncService.listOutbox()
    const last = outbox[outbox.length - 1]
    expect(last.payload?.content).toBe('updated')
    expect(last.payload?.role).toBe('user')
    // Ensure not just partial
    expect(last.payload?.topicId).toBe('t-full')
  })
})

describe('soft vs hard delete distinction', () => {
  it('soft delete is upsert with deletedAt, hard delete is delete', () => {
    // Create topic
    syncService.applyIncomingOperation({
      id: 'op-t-soft-create',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-soft',
      timestamp: Date.now() - 3000,
      deviceId: 'd1',
      payload: { id: 't-soft', name: 'Soft' }
    } as any)
    // Soft delete via upsert with deletedAt
    const softOp: any = {
      id: 'op-soft',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-soft',
      timestamp: Date.now(),
      deviceId: 'd1',
      payload: { id: 't-soft', name: 'Soft', deletedAt: new Date().toISOString() }
    }
    expect(syncService.applyIncomingOperation(softOp)).toBe(true)
    const softRow = sqlite.prepare('SELECT deleted_at as deletedAt FROM topics WHERE id=?').get('t-soft') as any
    expect(softRow.deletedAt).toBeTruthy()
    // Hard delete
    const hardOp: any = {
      id: 'op-hard',
      entityType: 'topic',
      op: 'delete',
      entityId: 't-soft',
      timestamp: Date.now() + 1000,
      deviceId: 'd1'
    }
    expect(syncService.applyIncomingOperation(hardOp)).toBe(true)
    const hardRow = sqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-soft') as any
    expect(hardRow).toBeUndefined()
  })
})

describe('payload allowlist idempotence', () => {
  it('delete without payload succeeds', () => {
    const op: any = {
      id: 'op-del-nopayload',
      entityType: 'topic',
      op: 'delete',
      entityId: 't-del',
      timestamp: Date.now(),
      deviceId: 'd1'
    }
    expect(syncService.applyIncomingOperation(op)).toBe(true)
  })
})

describe('cursor semantics: push must not advance pull cursor', () => {
  it('push cursor does not overwrite pull cursor, pull pages correctly', async () => {
    // Setup config
    configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
    configStore.set('sync:token', '')
    configStore.set('sync:enabled', true)
    // Set initial pull cursor to 5
    db.insert(schema.syncState)
      .values({ key: 'cursor', value: '5' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: '5' } })
      .run()
    // Create an outbox op
    syncService.recordUpsert('topic', 't-cursor', { id: 't-cursor', name: 'C' }, Date.now())
    expect(syncService.listOutbox().length).toBe(1)

    const { syncClient } = await import('../SyncClient')
    const pushSpy = vi.spyOn(syncClient, 'push').mockImplementation(async () => {
      return { acceptedIds: syncService.listOutbox().map((o) => o.id), cursor: 9999 }
    })
    // Mock pull to return 3 ops in first page, cursor 8, then empty
    let pullCalls = 0
    const pullSpy = vi
      .spyOn(syncClient, 'pull')
      .mockImplementation(async (_ep: string, _tok: string | undefined, cursor: number) => {
        pullCalls++
        if (cursor === 5) {
          return {
            operations: [
              {
                seq: 6,
                id: 'op-6',
                entityType: 'topic',
                op: 'upsert',
                entityId: 't-6',
                timestamp: Date.now(),
                deviceId: 'remote',
                payload: { id: 't-6', name: 'N6' }
              },
              {
                seq: 7,
                id: 'op-7',
                entityType: 'topic',
                op: 'upsert',
                entityId: 't-7',
                timestamp: Date.now(),
                deviceId: 'remote',
                payload: { id: 't-7', name: 'N7' }
              }
            ],
            cursor: 7
          } as any
        }
        return { operations: [], cursor } as any
      })

    await syncService.sync()
    // After sync, outbox cleared, pull cursor should be 7 (last returned seq), NOT 9999 from push
    const cursorRow = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
    expect(cursorRow?.value).toBe('7')
    expect(pullCalls).toBe(1)
    // Verify topics created via pull
    const t6 = sqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-6') as any
    expect(t6).toBeTruthy()

    pushSpy.mockRestore()
    pullSpy.mockRestore()
  })

  it('orphan block prevents cursor advancement beyond it', async () => {
    configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
    configStore.set('sync:token', '')
    configStore.set('sync:enabled', true)
    db.insert(schema.syncState)
      .values({ key: 'cursor', value: '0' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: '0' } })
      .run()
    const { syncClient } = await import('../SyncClient')
    const pushMock = vi
      .spyOn(syncClient, 'push')
      .mockImplementation(async () => ({ acceptedIds: [], cursor: 0 }) as any)
    const pull1 = vi
      .spyOn(syncClient, 'pull')
      .mockImplementation(async (_ep: string, _tok: string | undefined, cursor: number) => {
        if (cursor === 0) {
          return {
            operations: [
              {
                seq: 1,
                id: 'op-orphan-b',
                entityType: 'message_block',
                op: 'upsert',
                entityId: 'b-orphan-2',
                timestamp: Date.now(),
                deviceId: 'remote',
                payload: { id: 'b-orphan-2', messageId: 'm-parent-missing', type: 'text', content: 'hi' }
              },
              {
                seq: 2,
                id: 'op-good-t',
                entityType: 'topic',
                op: 'upsert',
                entityId: 't-after-orphan',
                timestamp: Date.now(),
                deviceId: 'remote',
                payload: { id: 't-after-orphan', name: 'After' }
              }
            ],
            cursor: 2
          } as any
        }
        return { operations: [], cursor } as any
      })
    await expect(syncService.sync()).rejects.toThrow(/orphan|blocked/i)
    const cur = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
    // Deferred orphan recovery: the later topic IS applied, but the cursor
    // does not skip the unresolved orphan entry. The durable blocked error
    // rejects (truthful failure) instead of resolving as success.
    expect(cur?.value).toBe('0')
    expect(sqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-after-orphan')).toBeTruthy()
    const errRow = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastError')).get()
    expect(errRow?.value).toMatch(/orphan|blocked/i)
    pull1.mockRestore()
    pushMock.mockRestore()
  })
})
