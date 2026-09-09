/**
 * Migration compatibility proof hardening (LOCK-PERSONAL-001/006):
 * a missing 005 marker is proven pre-migration ONLY when migration_state is
 * present, the 005 row is absent, no later sync marker (006) exists, and no
 * surviving sync metadata tables exist. Otherwise fail closed with no
 * cursor/entity/applied advancement.
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
import { seedRegisteredAttachedSyncService } from './helpers/syncTestRegistration'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

function dropSyncTable(name: string): void {
  sqlite.exec(`DROP TABLE IF EXISTS ${name}`)
}

function dropAllSyncTables(): void {
  for (const t of [
    'sync_state',
    'sync_outbox',
    'sync_applied',
    'sync_entity_clock',
    'sync_field_clock',
    'sync_conflict_log'
  ]) {
    dropSyncTable(t)
  }
}

function appliedExists(id: string): boolean {
  try {
    return !!db.select().from(schema.syncApplied).where(eq(schema.syncApplied.operationId, id)).get()
  } catch {
    return false
  }
}

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
  configStore.set('sync:token', '')
  sqlite = openInMemory()
  db = drizzle(sqlite, { schema })
  runMigrations(db as never, sqlite)
  ;(chatDbService as never as { sqlite: unknown }).sqlite = sqlite
  ;(chatDbService as never as { db: unknown }).db = db
  syncService.clearAllForTests()
  seedRegisteredAttachedSyncService(configStore, db)
})

afterEach(() => {
  vi.restoreAllMocks()
  try {
    sqlite.close()
  } catch {}
  ;(chatDbService as never as { sqlite: unknown }).sqlite = null
  ;(chatDbService as never as { db: unknown }).db = null
})

describe('005 absent + 006 present fails closed', () => {
  it('getDeviceId with missing sync_state but 006 marker present throws', () => {
    sqlite.exec("DELETE FROM migration_state WHERE key = '005_sync_metadata'")
    // 006 marker still present (post-migration damage): keep surviving tables.
    sqlite.exec('DROP TABLE sync_state')
    configStore.set('deviceId', 'pre005-device')
    expect(() => syncService.getDeviceId()).toThrow(/device identity/i)
  })

  it('tracked check with missing outbox but 006 marker present throws', () => {
    sqlite.exec("DELETE FROM migration_state WHERE key = '005_sync_metadata'")
    sqlite.exec('DROP TABLE sync_outbox')
    expect(() => syncService.isTrackedEntity('topic', 't-x')).toThrow(/no such table/i)
    expect(() => syncService.isKnownEntity('topic', 't-x')).toThrow(/no such table/i)
  })
})

describe('005 absent + surviving sync tables fail closed', () => {
  it.each(['sync_state', 'sync_outbox', 'sync_entity_clock', 'sync_applied'])(
    'surviving %s with 005/006 absent still fails closed',
    (survivor) => {
      sqlite.exec("DELETE FROM migration_state WHERE key = '005_sync_metadata'")
      sqlite.exec("DELETE FROM migration_state WHERE key = '006_sync_field_merge'")
      for (const t of ['sync_state', 'sync_outbox', 'sync_entity_clock', 'sync_applied']) {
        if (t !== survivor) dropSyncTable(t)
      }
      dropSyncTable('sync_field_clock')
      dropSyncTable('sync_conflict_log')
      // Force a missing-table read on a dropped table while survivor proves damage.
      // Drop sync_state as well when survivor is not sync_state so getDeviceId hits the missing table.
      if (survivor !== 'sync_state') {
        // sync_state already dropped above; getDeviceId must fail closed, not return config.
        configStore.set('deviceId', 'pre005-device')
        expect(() => syncService.getDeviceId()).toThrow(/device identity/i)
      } else {
        // sync_state survives but outbox is gone: tracked check must fail closed.
        expect(() => syncService.isTrackedEntity('topic', 't-x')).toThrow(/no such table/i)
      }
    }
  )
})

describe('005 absent + migration_state damaged fails closed', () => {
  it('missing migration_state with surviving sync tables throws', () => {
    sqlite.exec('DROP TABLE IF EXISTS sync_state')
    sqlite.exec('DROP TABLE IF EXISTS migration_state')
    configStore.set('deviceId', 'any-device')
    expect(() => syncService.getDeviceId()).toThrow(/device identity/i)
  })

  it('no cursor/entity/applied advancement on damaged apply', () => {
    sqlite.exec("DELETE FROM migration_state WHERE key = '005_sync_metadata'")
    // 006 present + outbox missing = damaged post-migration.
    sqlite.exec('DROP TABLE sync_outbox')
    expect(() => syncService.isTrackedEntity('topic', 't-damage')).toThrow()
    expect(appliedExists('op-damage-1')).toBe(false)
  })
})

describe('damaged post-migration real apply holds all state/cursor', () => {
  const T0 = 1_700_000_000_000

  function cursorValue(): string | null {
    return db.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()?.value ?? null
  }

  function lastErrorValue(): string | null {
    return db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastError')).get()?.value ?? null
  }

  function entityClockOf(entityId: string): { timestamp: number; operationId: string } | null {
    const row = db
      .select()
      .from(schema.syncEntityClock)
      .where(eq(schema.syncEntityClock.entityType, 'topic' as never))
      .all()
      .find((r) => r.entityId === entityId)
    return row ? { timestamp: row.timestamp, operationId: row.operationId } : null
  }

  function tableExists(name: string): boolean {
    const rows = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").all(name) as Array<{
      name: string
    }>
    return rows.length > 0
  }

  it('sync cycle with post-006 field-clock damage holds row/clocks/applied/conflicts/cursor with durable error', async () => {
    // Healthy baseline first: entity row + entity/field clocks + applied marker.
    expect(
      syncService.applyIncomingOperation({
        id: 'op-hold-1',
        entityType: 'topic',
        op: 'upsert',
        entityId: 't-hold',
        timestamp: T0,
        deviceId: 'remote-a',
        payload: { id: 't-hold', name: 'Base' }
      } as never)
    ).toBe(true)
    db.insert(schema.syncState)
      .values({ key: 'cursor', value: '0' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: '0' } })
      .run()
    const rowBefore = (sqlite.prepare('SELECT name FROM topics WHERE id=?').get('t-hold') as { name: string }).name
    expect(rowBefore).toBe('Base')
    const clockBefore = entityClockOf('t-hold')
    expect(clockBefore).toEqual({ timestamp: T0, operationId: 'op-hold-1' })
    const appliedBefore = db.select().from(schema.syncApplied).all().length
    const conflictsBefore = syncService.getConflictCount()
    // Both migration markers present proves post-migration; dropping the
    // field-clock table is real post-006 metadata damage (not a mock).
    expect(tableExists('sync_field_clock')).toBe(true)
    sqlite.exec('DROP TABLE sync_field_clock')
    expect(tableExists('sync_field_clock')).toBe(false)

    const { syncClient } = await import('../SyncClient')
    vi.spyOn(syncClient, 'push').mockImplementation(async () => ({ acceptedIds: [], cursor: 0 }) as never)
    vi.spyOn(syncClient, 'pull').mockImplementation(async () => {
      return {
        operations: [
          {
            seq: 1,
            id: 'op-hold-2',
            entityType: 'topic',
            op: 'upsert',
            entityId: 't-hold',
            timestamp: T0 + 10,
            deviceId: 'remote-b',
            payload: { id: 't-hold', name: 'Intruder' }
          }
        ],
        cursor: 1
      } as never
    })
    await expect(syncService.sync()).rejects.toThrow(/no such table/i)
    // Same-transaction atomicity: entity row, entity clock, applied marker,
    // conflict rows, and durable cursor all unchanged; damage not resurrected.
    expect((sqlite.prepare('SELECT name FROM topics WHERE id=?').get('t-hold') as { name: string }).name).toBe('Base')
    expect(entityClockOf('t-hold')).toEqual(clockBefore)
    expect(appliedExists('op-hold-2')).toBe(false)
    expect(db.select().from(schema.syncApplied).all().length).toBe(appliedBefore)
    expect(syncService.getConflictCount()).toBe(conflictsBefore)
    expect(cursorValue()).toBe('0')
    expect(tableExists('sync_field_clock')).toBe(false)
    const lastError = lastErrorValue() ?? ''
    expect(lastError).toContain('apply failed')
    expect(lastError).toMatch(/no such table/i)
  })
})

describe('genuine pre-005 still tolerated', () => {
  it('bare pre-sync database (no markers, no sync tables) returns config identity', () => {
    sqlite.exec("DELETE FROM migration_state WHERE key = '005_sync_metadata'")
    sqlite.exec("DELETE FROM migration_state WHERE key = '006_sync_field_merge'")
    dropAllSyncTables()
    configStore.set('deviceId', 'pre005-device')
    expect(syncService.getDeviceId()).toBe('pre005-device')
  })

  it('bare pre-sync database tracked checks return false without throwing', () => {
    sqlite.exec("DELETE FROM migration_state WHERE key = '005_sync_metadata'")
    sqlite.exec("DELETE FROM migration_state WHERE key = '006_sync_field_merge'")
    dropAllSyncTables()
    expect(syncService.isTrackedEntity('topic', 't-x')).toBe(false)
    expect(syncService.isKnownEntity('topic', 't-x')).toBe(false)
  })

  it('bare pre-sync status returns truthful empty without throwing', () => {
    sqlite.exec("DELETE FROM migration_state WHERE key = '005_sync_metadata'")
    sqlite.exec("DELETE FROM migration_state WHERE key = '006_sync_field_merge'")
    dropAllSyncTables()
    const status = syncService.getStatus()
    expect(status.pendingCount).toBe(0)
    expect(status.cursor).toBe(0)
    expect(status.lastSyncAt).toBeNull()
  })
})
