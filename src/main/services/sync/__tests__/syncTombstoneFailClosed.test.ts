/**
 * Tombstone fail-closed regressions: no tombstone persistence/read failure
 * may be interpreted as absence or permit applied/clock advance.
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
import { syncService } from '../SyncService'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

const T = 9_000_000

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
  vi.restoreAllMocks()
  try {
    sqlite.close()
  } catch {}
  ;(chatDbService as any).sqlite = null
  ;(chatDbService as any).db = null
})

function appliedRow(id: string): unknown {
  return db.select().from(schema.syncApplied).where(eq(schema.syncApplied.operationId, id)).get()
}

function clockRow(entityType: string, entityId: string): unknown {
  return db
    .select()
    .from(schema.syncEntityClock)
    .where(eq(schema.syncEntityClock.entityType, entityType))
    .all()
    .find((r) => r.entityId === entityId)
}

describe('fail closed 1: local delete tombstone write failure rolls back outbox', () => {
  it('enqueueOperation delete throws with no outbox row and no clock advance', () => {
    const svc = syncService as any
    const orig = svc.setTombstoneInDb.bind(syncService)
    const stub = vi.spyOn(svc, 'setTombstoneInDb').mockImplementation(() => {
      throw new Error('injected tombstone write failure')
    })
    try {
      expect(() =>
        syncService.enqueueOperation({
          id: 'op-local-del-fail',
          entityType: 'topic',
          op: 'delete',
          entityId: 't-local-fail',
          timestamp: T,
          deviceId: 'd1'
        } as any)
      ).toThrow(/injected tombstone write failure/)
    } finally {
      stub.mockRestore()
      void orig
    }
    expect(syncService.listOutbox().filter((o) => o.id === 'op-local-del-fail').length).toBe(0)
    expect(clockRow('topic', 't-local-fail')).toBeUndefined()
    expect(appliedRow('op-local-del-fail')).toBeUndefined()
  })
})

describe('fail closed 2: incoming delete tombstone failure leaves operation unapplied', () => {
  it('topic hard delete with failing tombstone throws, rolls back row delete, no clock/applied', () => {
    syncService.applyIncomingOperation({
      id: 'op-fc2-t',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-fc2',
      timestamp: T - 1000,
      deviceId: 'd1',
      payload: { id: 't-fc2', name: 'T' }
    } as any)
    const svc = syncService as any
    const stub = vi.spyOn(svc, 'setTombstoneInDb').mockImplementation(() => {
      throw new Error('injected incoming tombstone failure')
    })
    try {
      expect(() =>
        syncService.applyIncomingOperation({
          id: 'op-fc2-tdel',
          entityType: 'topic',
          op: 'delete',
          entityId: 't-fc2',
          timestamp: T,
          deviceId: 'd1'
        } as any)
      ).toThrow(/injected incoming tombstone failure/)
    } finally {
      stub.mockRestore()
    }
    // Transaction rolled back: topic row survives, delete not marked applied, clock not advanced
    expect(sqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-fc2')).toBeTruthy()
    expect(appliedRow('op-fc2-tdel')).toBeUndefined()
    const clock = clockRow('topic', 't-fc2') as any
    expect(clock?.timestamp).toBe(T - 1000)
    // Idempotence preserved on retry with healthy persistence
    const res = syncService.applyIncomingOperation({
      id: 'op-fc2-tdel',
      entityType: 'topic',
      op: 'delete',
      entityId: 't-fc2',
      timestamp: T,
      deviceId: 'd1'
    } as any)
    expect(res).toBe(true)
    expect(sqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-fc2')).toBeUndefined()
    expect(appliedRow('op-fc2-tdel')).toBeTruthy()
  })
})

describe('fail closed 3: tombstone read failure rejects apply rather than treats absence', () => {
  it('message upsert with failing tombstone read throws (not applied as absent or suppressed)', () => {
    syncService.applyIncomingOperation({
      id: 'op-fc3-t',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-fc3',
      timestamp: T - 1000,
      deviceId: 'd1',
      payload: { id: 't-fc3', name: 'T' }
    } as any)
    const svc = syncService as any
    const stub = vi.spyOn(svc, 'getTombstone').mockImplementation(() => {
      throw new Error('injected tombstone read failure')
    })
    try {
      expect(() =>
        syncService.applyIncomingOperation({
          id: 'op-fc3-m',
          entityType: 'message',
          op: 'upsert',
          entityId: 'm-fc3',
          timestamp: T,
          deviceId: 'd2',
          payload: { id: 'm-fc3', topicId: 't-fc3', role: 'user', content: 'hi' }
        } as any)
      ).toThrow(/injected tombstone read failure/)
    } finally {
      stub.mockRestore()
    }
    expect(appliedRow('op-fc3-m')).toBeUndefined()
    expect(clockRow('message', 'm-fc3')).toBeUndefined()
    expect(sqlite.prepare('SELECT id FROM messages WHERE id=?').get('m-fc3')).toBeUndefined()
  })

  it('block upsert with failing tombstone read throws and sync() preserves cursor + durable error', async () => {
    db.insert(schema.syncState)
      .values({ key: 'cursor', value: '0' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: '0' } })
      .run()
    const svc = syncService as any
    const readStub = vi.spyOn(svc, 'getTombstone').mockImplementation(() => {
      throw new Error('injected pull tombstone read failure')
    })
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
                id: 'op-fc3-pull-m',
                entityType: 'message',
                op: 'upsert',
                entityId: 'm-fc3-pull',
                timestamp: T,
                deviceId: 'remote',
                payload: { id: 'm-fc3-pull', topicId: 't-fc3-pull', role: 'user', content: 'hi' }
              }
            ],
            cursor: 1
          } as any
        }
        return { operations: [], cursor } as any
      })
    try {
      await expect(syncService.sync()).rejects.toThrow(/injected pull tombstone read failure/)
    } finally {
      pullMock.mockRestore()
      pushMock.mockRestore()
      readStub.mockRestore()
    }
    expect(appliedRow('op-fc3-pull-m')).toBeUndefined()
    const cur = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
    expect(cur?.value ?? '0').toBe('0')
    const errRow = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastError')).get()
    expect(errRow?.value).toMatch(/injected pull tombstone read failure/)
    const okAt = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastSyncAt')).get()
    expect(okAt).toBeUndefined()
  })
})

describe('fail closed 5: malformed persisted tombstones throw, never treated as absent', () => {
  const MALFORMED = ['garbage', '123junk', '123:', 'abc:op-1', ':op-1', '12.5:op-1', '-5:op-1', '123:op:extra', '']
  it.each(MALFORMED)('message upsert against malformed topic tombstone %j throws with no apply', (bad) => {
    syncService.applyIncomingOperation({
      id: `op-fc5-t-${Math.random().toString(36).slice(2)}`,
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-fc5',
      timestamp: T - 1000,
      deviceId: 'd1',
      payload: { id: 't-fc5', name: 'T' }
    } as any)
    db.insert(schema.syncState)
      .values({ key: 'tombstone:topic:t-fc5', value: bad })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: bad } })
      .run()
    const opId = `op-fc5-m-${String(bad).slice(0, 8).replace(/:/g, '-')}-${Math.random().toString(36).slice(2)}`
    const msgId = `m-fc5-${Math.random().toString(36).slice(2)}`
    expect(() =>
      syncService.applyIncomingOperation({
        id: opId,
        entityType: 'message',
        op: 'upsert',
        entityId: msgId,
        timestamp: T,
        deviceId: 'd2',
        payload: { id: msgId, topicId: 't-fc5', role: 'user', content: 'hi' }
      } as any)
    ).toThrow(/malformed tombstone/)
    expect(appliedRow(opId)).toBeUndefined()
    expect(sqlite.prepare("SELECT value FROM sync_state WHERE key='tombstone:topic:t-fc5'").get()).toMatchObject({
      value: bad
    })
  })

  it('block upsert against malformed message tombstone throws with no apply', () => {
    for (const bad of ['garbage', '123junk', '123:']) {
      const mid = `m-fc5-b-${Math.random().toString(36).slice(2)}`
      db.insert(schema.syncState)
        .values({ key: `tombstone:message:${mid}`, value: bad })
        .onConflictDoUpdate({ target: schema.syncState.key, set: { value: bad } })
        .run()
      const opId = `op-fc5-b-${Math.random().toString(36).slice(2)}`
      const blockId = `b-fc5-${Math.random().toString(36).slice(2)}`
      expect(() =>
        syncService.applyIncomingOperation({
          id: opId,
          entityType: 'message_block',
          op: 'upsert',
          entityId: blockId,
          timestamp: T,
          deviceId: 'd2',
          payload: { id: blockId, messageId: mid, type: 'text', content: 'hi' }
        } as any)
      ).toThrow(/malformed tombstone/)
      expect(appliedRow(opId)).toBeUndefined()
    }
  })

  it('setTombstone does not overwrite malformed row: enqueue + incoming delete throw, row preserved', () => {
    db.insert(schema.syncState)
      .values({ key: 'tombstone:topic:t-fc5-w', value: 'garbage' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: 'garbage' } })
      .run()
    expect(() =>
      syncService.enqueueOperation({
        id: 'op-fc5-enq',
        entityType: 'topic',
        op: 'delete',
        entityId: 't-fc5-w',
        timestamp: T,
        deviceId: 'd1'
      } as any)
    ).toThrow(/malformed tombstone/)
    expect(syncService.listOutbox().filter((o) => o.id === 'op-fc5-enq').length).toBe(0)
    expect(clockRow('topic', 't-fc5-w')).toBeUndefined()
    const row = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'tombstone:topic:t-fc5-w')).get()
    expect(row?.value).toBe('garbage')
    // Incoming delete path likewise fails closed without marking applied
    syncService.applyIncomingOperation({
      id: 'op-fc5-w-t',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-fc5-w2',
      timestamp: T - 1000,
      deviceId: 'd1',
      payload: { id: 't-fc5-w2', name: 'T' }
    } as any)
    db.insert(schema.syncState)
      .values({ key: 'tombstone:topic:t-fc5-w2', value: '123junk' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: '123junk' } })
      .run()
    expect(() =>
      syncService.applyIncomingOperation({
        id: 'op-fc5-w2-del',
        entityType: 'topic',
        op: 'delete',
        entityId: 't-fc5-w2',
        timestamp: T,
        deviceId: 'd1'
      } as any)
    ).toThrow(/malformed tombstone/)
    expect(appliedRow('op-fc5-w2-del')).toBeUndefined()
    expect(sqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-fc5-w2')).toBeTruthy()
  })

  it('sync() with malformed persisted tombstone fails closed: cursor held, durable error, no success', async () => {
    db.insert(schema.syncState)
      .values({ key: 'cursor', value: '0' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: '0' } })
      .run()
    db.insert(schema.syncState)
      .values({ key: 'tombstone:topic:t-fc5-sync', value: '123junk' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: '123junk' } })
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
                id: 'op-fc5-sync-m',
                entityType: 'message',
                op: 'upsert',
                entityId: 'm-fc5-sync',
                timestamp: T,
                deviceId: 'remote',
                payload: { id: 'm-fc5-sync', topicId: 't-fc5-sync', role: 'user', content: 'hi' }
              }
            ],
            cursor: 1
          } as any
        }
        return { operations: [], cursor } as any
      })
    try {
      await expect(syncService.sync()).rejects.toThrow(/malformed tombstone/)
    } finally {
      pullMock.mockRestore()
      pushMock.mockRestore()
    }
    expect(appliedRow('op-fc5-sync-m')).toBeUndefined()
    const cur = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
    expect(cur?.value ?? '0').toBe('0')
    const errRow = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastError')).get()
    expect(errRow?.value).toMatch(/malformed tombstone/)
    expect(db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastSyncAt')).get()).toBeUndefined()
  })

  it('canonical legacy timestamp-only and timestamp:operationId forms remain accepted', () => {
    // Legacy form: stale child suppressed; newer child also suppressed via
    // delete-wins when the exact parent is still absent (no resurrection).
    db.insert(schema.syncState)
      .values({ key: 'tombstone:topic:t-leg', value: String(T) })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: String(T) } })
      .run()
    const staleLegId = `op-leg-stale-${Math.random().toString(36).slice(2)}`
    const staleLegMsg = `m-leg-stale-${Math.random().toString(36).slice(2)}`
    syncService.applyIncomingOperation({
      id: staleLegId,
      entityType: 'message',
      op: 'upsert',
      entityId: staleLegMsg,
      timestamp: T - 10,
      deviceId: 'd2',
      payload: { id: staleLegMsg, topicId: 't-leg', role: 'user', content: 'stale' }
    } as any)
    expect(appliedRow(staleLegId)).toBeTruthy()
    const freshLegId = `op-leg-fresh-${Math.random().toString(36).slice(2)}`
    const freshLegMsg = `m-leg-fresh-${Math.random().toString(36).slice(2)}`
    syncService.applyIncomingOperation({
      id: freshLegId,
      entityType: 'message',
      op: 'upsert',
      entityId: freshLegMsg,
      timestamp: T + 10,
      deviceId: 'd2',
      payload: { id: freshLegMsg, topicId: 't-leg', role: 'user', content: 'fresh' }
    } as any)
    // Delete-wins: newer child with absent parent is consumed, not resurrected.
    expect(sqlite.prepare('SELECT id FROM messages WHERE id=?').get(freshLegMsg)).toBeUndefined()
    expect(sqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-leg')).toBeUndefined()
    expect(appliedRow(freshLegId)).toBeTruthy()
    // Canonical new form: LWW via timestamp then operationId (parent present).
    // Explicitly recreate a live parent chain first so block LWW is isolated
    // from topic delete-wins.
    syncService.applyIncomingOperation({
      id: `op-leg-t-new-${Math.random().toString(36).slice(2)}`,
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-new-parent',
      timestamp: T + 10,
      deviceId: 'd2',
      payload: { id: 't-new-parent', name: 'P' }
    } as any)
    syncService.applyIncomingOperation({
      id: `op-leg-m-new-${Math.random().toString(36).slice(2)}`,
      entityType: 'message',
      op: 'upsert',
      entityId: 'm-new',
      timestamp: T + 10,
      deviceId: 'd2',
      payload: { id: 'm-new', topicId: 't-new-parent', role: 'user', content: 'parent' }
    } as any)
    db.insert(schema.syncState)
      .values({ key: 'tombstone:message:m-new', value: `${T}:op-aaa` })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: `${T}:op-aaa` } })
      .run()
    const loseBlock = `b-lose-${Math.random().toString(36).slice(2)}`
    syncService.applyIncomingOperation({
      id: 'op-aaa',
      entityType: 'message_block',
      op: 'upsert',
      entityId: loseBlock,
      timestamp: T,
      deviceId: 'd2',
      payload: { id: loseBlock, messageId: 'm-new', type: 'text', content: 'x' }
    } as any)
    // Equal timestamp + equal operation ID loses to the tombstone: suppressed, no row
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get(loseBlock)).toBeUndefined()
    const winBlock = `b-win-${Math.random().toString(36).slice(2)}`
    syncService.applyIncomingOperation({
      id: 'op-bbb',
      entityType: 'message_block',
      op: 'upsert',
      entityId: winBlock,
      timestamp: T,
      deviceId: 'd2',
      payload: { id: winBlock, messageId: 'm-new', type: 'text', content: 'y' }
    } as any)
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get(winBlock)).toBeTruthy()
  })
})

describe('final audit: present NULL tombstone row fails closed on write (never overwritten)', () => {
  it('local delete with present NULL tombstone throws with no overwrite/outbox/clock advance', () => {
    sqlite.prepare('INSERT INTO sync_state(key, value) VALUES(?, ?)').run('tombstone:topic:t-null-local', null)
    expect(() =>
      syncService.enqueueOperation({
        id: 'op-null-local',
        entityType: 'topic',
        op: 'delete',
        entityId: 't-null-local',
        timestamp: T,
        deviceId: 'd1'
      } as any)
    ).toThrow(/malformed tombstone/)
    expect(syncService.listOutbox().filter((o) => o.id === 'op-null-local').length).toBe(0)
    expect(clockRow('topic', 't-null-local')).toBeUndefined()
    expect(appliedRow('op-null-local')).toBeUndefined()
    const row = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'tombstone:topic:t-null-local')).get()
    expect(row?.value).toBeNull()
  })

  it('incoming delete with present NULL tombstone throws, rolls back row delete, no clock/applied advance', () => {
    syncService.applyIncomingOperation({
      id: 'op-null-in-t',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-null-in',
      timestamp: T - 1000,
      deviceId: 'd1',
      payload: { id: 't-null-in', name: 'T' }
    } as any)
    sqlite.prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)').run('tombstone:topic:t-null-in', null)
    expect(() =>
      syncService.applyIncomingOperation({
        id: 'op-null-in-del',
        entityType: 'topic',
        op: 'delete',
        entityId: 't-null-in',
        timestamp: T,
        deviceId: 'd1'
      } as any)
    ).toThrow(/malformed tombstone/)
    expect(sqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-null-in')).toBeTruthy()
    expect(appliedRow('op-null-in-del')).toBeUndefined()
    const clock = clockRow('topic', 't-null-in') as any
    expect(clock?.timestamp).toBe(T - 1000)
    const tomb = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'tombstone:topic:t-null-in')).get()
    expect(tomb?.value).toBeNull()
  })
})

describe('final audit: overlong operation ID rejected before tombstone persistence (no future poison row)', () => {
  const OVERLONG = 'o'.repeat(257)
  const BOUNDARY = 'o'.repeat(256)

  it('shared wire validator agrees on canonical operation-ID contract', () => {
    expect(
      validateSyncOperationStrict({
        id: OVERLONG,
        entityType: 'topic',
        op: 'delete',
        entityId: 't-x',
        timestamp: T,
        deviceId: 'd1'
      } as any)
    ).toMatch(/invalid id/)
    expect(
      validateSyncOperationStrict({
        id: 'op:with-colon',
        entityType: 'topic',
        op: 'delete',
        entityId: 't-x',
        timestamp: T,
        deviceId: 'd1'
      } as any)
    ).toMatch(/invalid id/)
    expect(
      validateSyncOperationStrict({
        id: BOUNDARY,
        entityType: 'topic',
        op: 'delete',
        entityId: 't-x',
        timestamp: T,
        deviceId: 'd1'
      } as any)
    ).toBeNull()
  })

  it('local delete with overlong operation ID throws before tombstone persistence', () => {
    expect(() =>
      syncService.enqueueOperation({
        id: OVERLONG,
        entityType: 'topic',
        op: 'delete',
        entityId: 't-overlong-local',
        timestamp: T,
        deviceId: 'd1'
      } as any)
    ).toThrow(/invalid id/)
    expect(syncService.listOutbox().filter((o) => o.entityId === 't-overlong-local').length).toBe(0)
    expect(clockRow('topic', 't-overlong-local')).toBeUndefined()
    expect(
      db.select().from(schema.syncState).where(eq(schema.syncState.key, 'tombstone:topic:t-overlong-local')).get()
    ).toBeUndefined()
  })

  it('incoming delete with overlong operation ID throws before tombstone persistence', () => {
    syncService.applyIncomingOperation({
      id: 'op-overlong-in-t',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-overlong-in',
      timestamp: T - 1000,
      deviceId: 'd1',
      payload: { id: 't-overlong-in', name: 'T' }
    } as any)
    expect(() =>
      syncService.applyIncomingOperation({
        id: OVERLONG,
        entityType: 'topic',
        op: 'delete',
        entityId: 't-overlong-in',
        timestamp: T,
        deviceId: 'd1'
      } as any)
    ).toThrow(/invalid id/)
    expect(sqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-overlong-in')).toBeTruthy()
    expect(appliedRow(OVERLONG)).toBeUndefined()
    const clock = clockRow('topic', 't-overlong-in') as any
    expect(clock?.timestamp).toBe(T - 1000)
    expect(
      db.select().from(schema.syncState).where(eq(schema.syncState.key, 'tombstone:topic:t-overlong-in')).get()
    ).toBeUndefined()
  })

  it('boundary 256-character operation ID is accepted on local and incoming delete', () => {
    syncService.enqueueOperation({
      id: BOUNDARY,
      entityType: 'topic',
      op: 'delete',
      entityId: 't-bound-local',
      timestamp: T,
      deviceId: 'd1'
    } as any)
    expect(syncService.listOutbox().filter((o) => o.id === BOUNDARY).length).toBe(1)
    const localTomb = db
      .select()
      .from(schema.syncState)
      .where(eq(schema.syncState.key, 'tombstone:topic:t-bound-local'))
      .get()
    expect(localTomb?.value).toBe(`${String(T)}:${BOUNDARY}`)

    syncService.applyIncomingOperation({
      id: 'op-bound-in-t',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-bound-in',
      timestamp: T - 1000,
      deviceId: 'd1',
      payload: { id: 't-bound-in', name: 'T' }
    } as any)
    const incomingBoundary = `b${'i'.repeat(255)}`
    expect(incomingBoundary.length).toBe(256)
    const res = syncService.applyIncomingOperation({
      id: incomingBoundary,
      entityType: 'topic',
      op: 'delete',
      entityId: 't-bound-in',
      timestamp: T,
      deviceId: 'd1'
    } as any)
    expect(res).toBe(true)
    expect(sqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-bound-in')).toBeUndefined()
    expect(appliedRow(incomingBoundary)).toBeTruthy()
  })
})

describe('fail closed 4: suppressed-message materialization failure does not mark applied', () => {
  it('stale message under deleted topic throws when child tombstone cannot persist', () => {
    const base = T - 100000
    syncService.applyIncomingOperation({
      id: 'op-fc4-t',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-fc4',
      timestamp: base,
      deviceId: 'd1',
      payload: { id: 't-fc4', name: 'T' }
    } as any)
    syncService.applyIncomingOperation({
      id: 'op-fc4-tdel',
      entityType: 'topic',
      op: 'delete',
      entityId: 't-fc4',
      timestamp: base + 1000,
      deviceId: 'd1'
    } as any)
    const svc = syncService as any
    const stub = vi.spyOn(svc, 'setTombstoneInDb').mockImplementation(() => {
      throw new Error('injected materialization failure')
    })
    try {
      expect(() =>
        syncService.applyIncomingOperation({
          id: 'op-fc4-stale',
          entityType: 'message',
          op: 'upsert',
          entityId: 'm-fc4-ghost',
          timestamp: base + 500,
          deviceId: 'd2',
          payload: { id: 'm-fc4-ghost', topicId: 't-fc4', role: 'user', content: 'late' }
        } as any)
      ).toThrow(/injected materialization failure/)
    } finally {
      stub.mockRestore()
    }
    expect(appliedRow('op-fc4-stale')).toBeUndefined()
    expect(clockRow('message', 'm-fc4-ghost')).toBeUndefined()
    expect(sqlite.prepare('SELECT id FROM messages WHERE id=?').get('m-fc4-ghost')).toBeUndefined()
  })
})
