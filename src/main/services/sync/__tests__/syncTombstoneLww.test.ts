/**
 * Tombstone LWW tie-break regressions: tombstones carry (timestamp, operationId)
 * and share one common comparator with entity-clock LWW.
 * Equal timestamp: lower op ID loses (suppressed), higher op ID wins (resurrects).
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

const T = 8_000_000
const DEL_MID = 'op-mid-del'
const LOWER = 'op-aaa-lower'
const HIGHER = 'op-zzz-higher'

describe('message delete/upsert equal timestamp tie-break (entity-clock LWW)', () => {
  it('lower op ID loses: deleted message stays deleted', () => {
    syncService.applyIncomingOperation({
      id: 'op-m1-t',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-m1',
      timestamp: T - 1000,
      deviceId: 'd1',
      payload: { id: 't-m1', name: 'T' }
    } as any)
    syncService.applyIncomingOperation({
      id: 'op-m1-m',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm-m1',
      timestamp: T - 500,
      deviceId: 'd1',
      payload: { id: 'm-m1', topicId: 't-m1', role: 'user', content: 'hi' }
    } as any)
    syncService.applyIncomingOperation({
      id: DEL_MID,
      entityType: 'message',
      op: 'delete',
      entityId: 'm-m1',
      timestamp: T,
      deviceId: 'd1'
    } as any)
    expect(sqlite.prepare('SELECT id FROM messages WHERE id=?').get('m-m1')).toBeUndefined()
    const res = syncService.applyIncomingOperation({
      id: LOWER,
      entityType: 'message',
      op: 'upsert',
      entityId: 'm-m1',
      timestamp: T,
      deviceId: 'd2',
      payload: { id: 'm-m1', topicId: 't-m1', role: 'user', content: 'resurrect-low' }
    } as any)
    expect(res).toBe(false)
    expect(sqlite.prepare('SELECT id FROM messages WHERE id=?').get('m-m1')).toBeUndefined()
  })

  it('higher op ID wins: deleted message resurrects and is materialized', () => {
    syncService.applyIncomingOperation({
      id: 'op-m2-t',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-m2',
      timestamp: T - 1000,
      deviceId: 'd1',
      payload: { id: 't-m2', name: 'T' }
    } as any)
    syncService.applyIncomingOperation({
      id: 'op-m2-m',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm-m2',
      timestamp: T - 500,
      deviceId: 'd1',
      payload: { id: 'm-m2', topicId: 't-m2', role: 'user', content: 'hi' }
    } as any)
    syncService.applyIncomingOperation({
      id: DEL_MID,
      entityType: 'message',
      op: 'delete',
      entityId: 'm-m2',
      timestamp: T,
      deviceId: 'd1'
    } as any)
    const res = syncService.applyIncomingOperation({
      id: HIGHER,
      entityType: 'message',
      op: 'upsert',
      entityId: 'm-m2',
      timestamp: T,
      deviceId: 'd2',
      payload: { id: 'm-m2', topicId: 't-m2', role: 'user', content: 'resurrect-high' }
    } as any)
    expect(res).toBe(true)
    const row = sqlite.prepare('SELECT content as c FROM messages WHERE id=?').get('m-m2') as any
    expect(row?.c).toBe('resurrect-high')
  })
})

describe('topic delete/message upsert equal timestamp tie-break (tombstone LWW)', () => {
  it('lower op ID suppressed: no message, no topic resurrection, exact tombstone inherits delete identity', () => {
    syncService.applyIncomingOperation({
      id: 'op-t1-base',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-t1',
      timestamp: T - 1000,
      deviceId: 'd1',
      payload: { id: 't-t1', name: 'T' }
    } as any)
    syncService.applyIncomingOperation({
      id: DEL_MID,
      entityType: 'topic',
      op: 'delete',
      entityId: 't-t1',
      timestamp: T,
      deviceId: 'd1'
    } as any)
    let threw = false
    try {
      syncService.applyIncomingOperation({
        id: LOWER,
        entityType: 'message',
        op: 'upsert',
        entityId: 'm-t1',
        timestamp: T,
        deviceId: 'd2',
        payload: { id: 'm-t1', topicId: 't-t1', role: 'user', content: 'late-low' }
      } as any)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(sqlite.prepare('SELECT id FROM messages WHERE id=?').get('m-t1')).toBeUndefined()
    expect(sqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-t1')).toBeUndefined()
    const tomb = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'tombstone:message:m-t1')).get()
    expect(tomb?.value).toBe(`${String(T)}:${DEL_MID}`)
  })

  it('higher op ID still suppressed (delete-wins): no resurrection via child update', () => {
    syncService.applyIncomingOperation({
      id: 'op-t2-base',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-t2',
      timestamp: T - 1000,
      deviceId: 'd1',
      payload: { id: 't-t2', name: 'T' }
    } as any)
    syncService.applyIncomingOperation({
      id: DEL_MID,
      entityType: 'topic',
      op: 'delete',
      entityId: 't-t2',
      timestamp: T,
      deviceId: 'd1'
    } as any)
    // Delete-wins (LOCK-PERSONAL-007): even an equal-timestamp higher-ID
    // child update must not implicitly resurrect the hard-deleted parent.
    // Explicit recreation must arrive as a parent topic creation operation.
    let threw = false
    try {
      syncService.applyIncomingOperation({
        id: HIGHER,
        entityType: 'message',
        op: 'upsert',
        entityId: 'm-t2',
        timestamp: T,
        deviceId: 'd2',
        payload: { id: 'm-t2', topicId: 't-t2', role: 'user', content: 'late-high' }
      } as any)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(sqlite.prepare('SELECT id FROM messages WHERE id=?').get('m-t2')).toBeUndefined()
    expect(sqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-t2')).toBeUndefined()
  })
})

describe('message tombstone/block upsert equal timestamp tie-break', () => {
  function seedTopicMessage(topicId: string, messageId: string): void {
    syncService.applyIncomingOperation({
      id: `op-seed-t-${topicId}`,
      entityType: 'topic',
      op: 'upsert',
      entityId: topicId,
      timestamp: T - 1000,
      deviceId: 'd1',
      payload: { id: topicId, name: 'T' }
    } as any)
    syncService.applyIncomingOperation({
      id: `op-seed-m-${messageId}`,
      entityType: 'message',
      op: 'upsert',
      entityId: messageId,
      timestamp: T - 500,
      deviceId: 'd1',
      payload: { id: messageId, topicId, role: 'user', content: 'p' }
    } as any)
  }

  it('lower op ID suppressed: no block, no orphan throw', () => {
    seedTopicMessage('t-b1', 'm-b1')
    syncService.applyIncomingOperation({
      id: DEL_MID,
      entityType: 'message',
      op: 'delete',
      entityId: 'm-b1',
      timestamp: T,
      deviceId: 'd1'
    } as any)
    let threw = false
    try {
      syncService.applyIncomingOperation({
        id: LOWER,
        entityType: 'message_block',
        op: 'upsert',
        entityId: 'b-b1-low',
        timestamp: T,
        deviceId: 'd2',
        payload: { id: 'b-b1-low', messageId: 'm-b1', type: 'text', content: 'late' }
      } as any)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-b1-low')).toBeUndefined()
  })

  it('higher op ID wins: parent resurrected then block materialized', () => {
    seedTopicMessage('t-b2', 'm-b2')
    syncService.applyIncomingOperation({
      id: DEL_MID,
      entityType: 'message',
      op: 'delete',
      entityId: 'm-b2',
      timestamp: T,
      deviceId: 'd1'
    } as any)
    // Resurrect the parent with a higher equal-timestamp ID so the winning
    // block has a present parent (otherwise it would defer as an orphan).
    syncService.applyIncomingOperation({
      id: 'op-zzz-parent',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm-b2',
      timestamp: T,
      deviceId: 'd2',
      payload: { id: 'm-b2', topicId: 't-b2', role: 'user', content: 'resurrected' }
    } as any)
    expect(sqlite.prepare('SELECT id FROM messages WHERE id=?').get('m-b2')).toBeTruthy()
    const res = syncService.applyIncomingOperation({
      id: 'op-zzzz-block',
      entityType: 'message_block',
      op: 'upsert',
      entityId: 'b-b2-high',
      timestamp: T,
      deviceId: 'd2',
      payload: { id: 'b-b2-high', messageId: 'm-b2', type: 'text', content: 'win' }
    } as any)
    expect(res).toBe(true)
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-b2-high')).toBeTruthy()
  })
})

describe('legacy timestamp-only tombstone backward compatibility', () => {
  it('legacy tombstone suppresses equal-timestamp upsert conservatively', () => {
    db.insert(schema.syncState)
      .values({ key: 'tombstone:topic:t-leg', value: String(T) })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: String(T) } })
      .run()
    let threw = false
    try {
      syncService.applyIncomingOperation({
        id: HIGHER,
        entityType: 'message',
        op: 'upsert',
        entityId: 'm-leg',
        timestamp: T,
        deviceId: 'd2',
        payload: { id: 'm-leg', topicId: 't-leg', role: 'user', content: 'late' }
      } as any)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(sqlite.prepare('SELECT id FROM messages WHERE id=?').get('m-leg')).toBeUndefined()
    // Inherited exact tombstone stays legacy-encoded (no invented op ID)
    const tomb = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'tombstone:message:m-leg')).get()
    expect(tomb?.value).toBe(String(T))
  })
})

describe('malformed losing op rejected before LWW applied-mark', () => {
  it('malformed older op throws and is not marked applied', () => {
    syncService.applyIncomingOperation({
      id: 'op-valid-m',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm-val',
      timestamp: T + 1000,
      deviceId: 'd1',
      payload: { id: 'm-val', topicId: 't-val', role: 'user', content: 'ok' }
    } as any)
    // Same entity, older timestamp (would lose LWW) but malformed: missing topicId
    expect(() =>
      syncService.applyIncomingOperation({
        id: 'op-malformed-old',
        entityType: 'message',
        op: 'upsert',
        entityId: 'm-val',
        timestamp: T,
        deviceId: 'd2',
        payload: { id: 'm-val', role: 'user', content: 'bad' }
      } as any)
    ).toThrow()
    const applied = db
      .select()
      .from(schema.syncApplied)
      .where(eq(schema.syncApplied.operationId, 'op-malformed-old'))
      .get()
    expect(applied).toBeUndefined()
  })

  it('known-operation idempotence fast path still returns false without revalidation', () => {
    const res1 = syncService.applyIncomingOperation({
      id: 'op-idem-1',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-idem',
      timestamp: T,
      deviceId: 'd1',
      payload: { id: 't-idem', name: 'T' }
    } as any)
    expect(res1).toBe(true)
    const res2 = syncService.applyIncomingOperation({
      id: 'op-idem-1',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-idem',
      timestamp: T,
      deviceId: 'd1',
      payload: { id: 't-idem', name: 'T' }
    } as any)
    expect(res2).toBe(false)
  })

  it('higher block without resurrected parent is suppressed (delete-wins, not orphan)', () => {
    seedLikeTopicMessage()
    function seedLikeTopicMessage(): void {
      syncService.applyIncomingOperation({
        id: 'op-seed-t-orph',
        entityType: 'topic',
        op: 'upsert',
        entityId: 't-orph',
        timestamp: T - 1000,
        deviceId: 'd1',
        payload: { id: 't-orph', name: 'T' }
      } as any)
      syncService.applyIncomingOperation({
        id: 'op-seed-m-orph',
        entityType: 'message',
        op: 'upsert',
        entityId: 'm-orph',
        timestamp: T - 500,
        deviceId: 'd1',
        payload: { id: 'm-orph', topicId: 't-orph', role: 'user', content: 'p' }
      } as any)
    }
    syncService.applyIncomingOperation({
      id: DEL_MID,
      entityType: 'message',
      op: 'delete',
      entityId: 'm-orph',
      timestamp: T,
      deviceId: 'd1'
    } as any)
    // Delete-wins: exact parent tombstone + absent parent row consumes the
    // late descendant (even higher-ID equal-timestamp) instead of stalling
    // as a retryable orphan.
    let threw = false
    try {
      syncService.applyIncomingOperation({
        id: 'op-zzzz-orph-block',
        entityType: 'message_block',
        op: 'upsert',
        entityId: 'b-orph-high',
        timestamp: T,
        deviceId: 'd2',
        payload: { id: 'b-orph-high', messageId: 'm-orph', type: 'text', content: 'win' }
      } as any)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-orph-high')).toBeUndefined()
    const applied = db
      .select()
      .from(schema.syncApplied)
      .where(eq(schema.syncApplied.operationId, 'op-zzzz-orph-block'))
      .get()
    expect(applied).toBeTruthy()
  })
})
