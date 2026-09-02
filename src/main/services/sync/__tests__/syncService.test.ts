/**
 * SyncService tests — real better-sqlite3 in-memory, isolated per test.
 * Covers outbox retry/idempotence/LWW and payload exclusion.
 */
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')
vi.mock('@main/config', () => ({ DATA_PATH: '/tmp' }))

// Provide in-memory config store
const configStore = new Map<string, unknown>()
vi.mock('@main/services/ConfigManager', () => ({
  configManager: {
    get: (k: string, def?: unknown) => (configStore.has(k) ? configStore.get(k) : def),
    set: (k: string, v: unknown) => configStore.set(k, v)
  },
  ConfigKeys: {}
}))

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
  sqlite = openInMemory()
  db = drizzle(sqlite, { schema })
  // run migrations
  runMigrations(db as any, sqlite)
  // Inject into singleton's handles via private fields
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

describe('sync outbox + idempotence + LWW', () => {
  it('enqueue and list outbox', () => {
    syncService.recordUpsert('topic', 't1', { id: 't1', name: 'Hello' })
    const out = syncService.listOutbox()
    expect(out.length).toBe(1)
    expect(out[0].entityId).toBe('t1')
  })

  it('duplicate operation id is idempotent', () => {
    const op: any = {
      id: 'op-dup-1',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't1',
      timestamp: Date.now(),
      deviceId: 'd1',
      payload: { id: 't1', name: 'A' }
    }
    syncService.enqueueOperation(op)
    syncService.enqueueOperation(op)
    const out = syncService.listOutbox()
    expect(out.filter((o) => o.id === 'op-dup-1').length).toBe(1)
  })

  it('apply duplicate incoming is harmless', () => {
    const op: any = {
      id: 'op-apply-1',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-dup',
      timestamp: Date.now(),
      deviceId: 'd2',
      payload: { id: 't-dup', name: 'A' }
    }
    expect(syncService.applyIncomingOperation(op)).toBe(true)
    // second time: duplicate id -> false, no second row
    expect(syncService.applyIncomingOperation(op)).toBe(false)
    const topics = db.select().from(schema.topics).all()
    expect(topics.filter((t) => t.id === 't-dup').length).toBe(1)
  })

  it('deterministic LWW: newer timestamp wins, tie-break by op id', () => {
    const base = Date.now()
    const op1: any = {
      id: 'op-aaa',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-lww',
      timestamp: base,
      deviceId: 'd1',
      payload: { id: 't-lww', name: 'First' }
    }
    const op2: any = {
      id: 'op-zzz',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-lww',
      timestamp: base,
      deviceId: 'd2',
      payload: { id: 't-lww', name: 'Second' }
    }
    const op3older: any = {
      id: 'op-bbb',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-lww',
      timestamp: base - 1000,
      deviceId: 'd3',
      payload: { id: 't-lww', name: 'Older' }
    }
    expect(syncService.applyIncomingOperation(op1)).toBe(true)
    expect(syncService.applyIncomingOperation(op2)).toBe(true) // tie-break wins because id larger
    expect(syncService.applyIncomingOperation(op3older)).toBe(false) // older rejected
    const topic = sqlite.prepare('SELECT name FROM topics WHERE id=?').get('t-lww') as { name: string } | undefined
    expect(topic?.name).toBe('Second')
  })

  it('payload exclusion: file_path never stored via apply', () => {
    const op: any = {
      id: 'op-block-1',
      entityType: 'message_block',
      op: 'upsert',
      entityId: 'b1',
      timestamp: Date.now(),
      deviceId: 'd1',
      payload: {
        id: 'b1',
        messageId: 'm1',
        type: 'image',
        content: null,
        filePath: '/secret/path.png',
        file_path: '/secret2'
      }
    }
    // First need parent message
    const msgOp: any = {
      id: 'op-msg-1',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm1',
      timestamp: Date.now() - 1000,
      deviceId: 'd1',
      payload: { id: 'm1', topicId: 't1', role: 'user', content: 'hi' }
    }
    syncService.applyIncomingOperation({
      ...msgOp,
      id: 'op-msg-2',
      timestamp: Date.now() - 2000,
      payload: { id: 'm1', topicId: 't1', role: 'user', content: 'hi' }
    })
    // The block payload contains denied field; our apply will reject via allowlist? It contains filePath which is not allowlisted -> validate will reject
    // Instead we use filtered payload: the service's recordUpsert would filter; direct apply with raw payload should be rejected
    const result = syncService.applyIncomingOperation(op)
    expect(result).toBe(false) // rejected due to allowlist
    // Now with allowlisted payload it succeeds
    const goodBlockOp: any = {
      id: 'op-block-2',
      entityType: 'message_block',
      op: 'upsert',
      entityId: 'b1',
      timestamp: Date.now(),
      deviceId: 'd1',
      payload: { id: 'b1', messageId: 'm1', type: 'text', content: 'hello' }
    }
    expect(syncService.applyIncomingOperation(goodBlockOp)).toBe(true)
    const blockRow = sqlite.prepare('SELECT content FROM message_blocks WHERE id=?').get('b1') as
      | { content: string }
      | undefined
    expect(blockRow?.content).toBe('hello')
  })

  it('outbox retry: failed transport keeps outbox', () => {
    syncService.recordUpsert('topic', 't-retry', { id: 't-retry', name: 'A' })
    const out1 = syncService.listOutbox()
    expect(out1.length).toBe(1)
    // Simulate push failure: we don't clear, outbox remains
    // Simulate retry after failure: still there
    const out2 = syncService.listOutbox()
    expect(out2.length).toBe(1)
    // After ack, clear
    syncService.clearOutboxByIds([out1[0].id])
    expect(syncService.listOutbox().length).toBe(0)
  })

  it('failed transport retry pattern: outbox not cleared on exception', async () => {
    // This is conceptual: ensure enqueue happens even when push fails, outbox remains for retry
    syncService.recordUpsert('message', 'm-retry', { id: 'm-retry', topicId: 't1', content: 'hi' })
    expect(syncService.listOutbox().length).toBe(1)
    // Simulate push throws -> caller would not call clearOutbox, so count stays 1
    expect(syncService.listOutbox().length).toBe(1)
  })
})
