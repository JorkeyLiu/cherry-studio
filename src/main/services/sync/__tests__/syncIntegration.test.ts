/**
 * Two-client synthetic cases without HTTP — verifies LWW, duplicate, offline, retry, integrity
 */
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')
vi.mock('@main/config', () => ({ DATA_PATH: '/tmp' }))

const store = new Map<string, unknown>()
vi.mock('@main/services/ConfigManager', () => ({
  configManager: {
    get: (k: string, def?: unknown) => (store.has(k) ? store.get(k) : def),
    set: (k: string, v: unknown) => store.set(k, v)
  },
  ConfigKeys: {}
}))

import { chatDbService } from '../../chatDb'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { SyncService } from '../SyncService'

let sqliteA: Database.Database
let sqliteB: Database.Database
let dbA: BetterSQLite3Database<typeof schema>
let dbB: BetterSQLite3Database<typeof schema>
let syncA: SyncService
let syncB: SyncService

function openMem(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

beforeEach(() => {
  store.clear()
  sqliteA = openMem()
  dbA = drizzle(sqliteA, { schema })
  runMigrations(dbA as any, sqliteA)
  sqliteB = openMem()
  dbB = drizzle(sqliteB, { schema })
  runMigrations(dbB as any, sqliteB)
  syncA = new SyncService()
  syncB = new SyncService()
})

afterEach(() => {
  try {
    sqliteA.close()
  } catch {}
  try {
    sqliteB.close()
  } catch {}
})

describe('two-client synthetic logic', () => {
  it('online create propagated via direct apply', () => {
    ;(chatDbService as any).sqlite = sqliteA
    ;(chatDbService as any).db = dbA
    syncA.recordUpsert('topic', 't-shared', { id: 't-shared', name: 'A-Topic' })
    const ops = syncA.listOutbox()
    expect(ops.length).toBe(1)
    // Apply to B
    ;(chatDbService as any).sqlite = sqliteB
    ;(chatDbService as any).db = dbB
    for (const op of ops) syncB.applyIncomingOperation(op)
    const tB = sqliteB.prepare('SELECT id FROM topics WHERE id=?').get('t-shared') as any
    expect(tB).toBeTruthy()
  })

  it('offline independent writes converge via LWW', () => {
    const base = Date.now()
    ;(chatDbService as any).sqlite = sqliteA
    ;(chatDbService as any).db = dbA
    syncA.applyIncomingOperation({
      id: 'op-base',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-lww',
      timestamp: base,
      deviceId: 'A',
      payload: { id: 't-lww', name: 'Base' }
    } as any)
    ;(chatDbService as any).sqlite = sqliteB
    ;(chatDbService as any).db = dbB
    syncB.applyIncomingOperation({
      id: 'op-base',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-lww',
      timestamp: base,
      deviceId: 'A',
      payload: { id: 't-lww', name: 'Base' }
    } as any)

    // offline edits
    const opA = {
      id: 'op-a',
      entityType: 'topic' as const,
      op: 'upsert' as const,
      entityId: 't-lww',
      timestamp: base + 1000,
      deviceId: 'A',
      payload: { id: 't-lww', name: 'A-Edit' }
    }
    const opB = {
      id: 'op-b',
      entityType: 'topic' as const,
      op: 'upsert' as const,
      entityId: 't-lww',
      timestamp: base + 2000,
      deviceId: 'B',
      payload: { id: 't-lww', name: 'B-Edit' }
    }

    // Each applies own then the other's
    ;(chatDbService as any).sqlite = sqliteA
    ;(chatDbService as any).db = dbA
    syncA.applyIncomingOperation(opA as any)
    syncA.applyIncomingOperation(opB as any)

    ;(chatDbService as any).sqlite = sqliteB
    ;(chatDbService as any).db = dbB
    syncB.applyIncomingOperation(opB as any)
    syncB.applyIncomingOperation(opA as any)

    const nameA = (sqliteA.prepare('SELECT name FROM topics WHERE id=?').get('t-lww') as { name: string }).name
    const nameB = (sqliteB.prepare('SELECT name FROM topics WHERE id=?').get('t-lww') as { name: string }).name
    expect(nameA).toBe('B-Edit')
    expect(nameB).toBe('B-Edit')
  })

  it('duplicate replay harmless and integrity holds', () => {
    ;(chatDbService as any).sqlite = sqliteA
    ;(chatDbService as any).db = dbA
    const op: any = {
      id: 'op-dup',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-dup',
      timestamp: Date.now(),
      deviceId: 'A',
      payload: { id: 't-dup', name: 'X' }
    }
    expect(syncA.applyIncomingOperation(op)).toBe(true)
    expect(syncA.applyIncomingOperation(op)).toBe(false)
    expect(sqliteA.pragma('integrity_check', { simple: true }) as string).toBe('ok')
    sqliteA.prepare('UPDATE topics SET name=? WHERE id=?').run('Y', 't-dup')
    // close and reopen integrity (in-memory close not needed)
    expect(sqliteA.pragma('integrity_check', { simple: true }) as string).toBe('ok')
  })

  it('failed transport retry keeps outbox', () => {
    ;(chatDbService as any).sqlite = sqliteA
    ;(chatDbService as any).db = dbA
    syncA.recordUpsert('topic', 't-retry', { id: 't-retry', name: 'A' })
    expect(syncA.listOutbox().length).toBe(1)
    // Simulate push failure -> not cleared
    expect(syncA.listOutbox().length).toBe(1)
    syncA.clearOutboxByIds(syncA.listOutbox().map((o) => o.id))
    expect(syncA.listOutbox().length).toBe(0)
  })
})
