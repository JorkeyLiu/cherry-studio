/**
 * Narrow reliability-audit blocker: explicit malformed config device identity
 * (null/empty/whitespace/non-string) must fail closed, while a truly absent
 * config key repairs from durable DB or generates only when both are absent.
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
    set: (k: string, v: unknown) => configStore.set(k, v),
    has: (k: string) => configStore.has(k)
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

function seedDurable(value: string): void {
  db.insert(schema.syncState)
    .values({ key: 'deviceId', value })
    .onConflictDoUpdate({ target: schema.syncState.key, set: { value } })
    .run()
}

function clearDurable(): void {
  sqlite.exec("DELETE FROM sync_state WHERE key = 'deviceId'")
}

beforeEach(() => {
  configStore.clear()
  sqlite = openInMemory()
  db = drizzle(sqlite, { schema })
  runMigrations(db as never, sqlite)
  ;(chatDbService as never as { sqlite: unknown }).sqlite = sqlite
  ;(chatDbService as never as { db: unknown }).db = db
  syncService.clearAllForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
  try {
    sqlite.close()
  } catch {}
  ;(chatDbService as never as { sqlite: unknown }).sqlite = null
  ;(chatDbService as never as { db: unknown }).db = null
})

describe('explicit malformed config identity fails closed', () => {
  it('explicit null with durable present throws without repairing', () => {
    seedDurable('durable-keep')
    configStore.set('deviceId', null)
    expect(() => syncService.getDeviceId()).toThrow(/device identity/i)
    expect(configStore.get('deviceId')).toBeNull()
  })

  it('explicit null with no durable throws without generating', () => {
    clearDurable()
    configStore.set('deviceId', null)
    expect(() => syncService.getDeviceId()).toThrow(/device identity/i)
  })

  it('explicit empty string with durable present throws', () => {
    seedDurable('durable-keep')
    configStore.set('deviceId', '')
    expect(() => syncService.getDeviceId()).toThrow(/device identity/i)
  })

  it('explicit empty string with no durable throws', () => {
    clearDurable()
    configStore.set('deviceId', '')
    expect(() => syncService.getDeviceId()).toThrow(/device identity/i)
  })

  it('explicit whitespace with durable present throws', () => {
    seedDurable('durable-keep')
    configStore.set('deviceId', '   ')
    expect(() => syncService.getDeviceId()).toThrow(/device identity/i)
  })

  it('explicit whitespace with no durable throws', () => {
    clearDurable()
    configStore.set('deviceId', '   ')
    expect(() => syncService.getDeviceId()).toThrow(/device identity/i)
  })

  it('explicit non-string with no durable throws', () => {
    clearDurable()
    configStore.set('deviceId', 123 as unknown as string)
    expect(() => syncService.getDeviceId()).toThrow(/device identity/i)
  })
})

describe('truly absent config repairs or generates', () => {
  it('absent config repairs from durable DB', () => {
    seedDurable('durable-identity-keep')
    configStore.delete('deviceId')
    expect(syncService.getDeviceId()).toBe('durable-identity-keep')
    expect(configStore.get('deviceId')).toBe('durable-identity-keep')
  })

  it('absent config and absent durable generates and persists', () => {
    clearDurable()
    configStore.delete('deviceId')
    const id = syncService.getDeviceId()
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
    expect(configStore.get('deviceId')).toBe(id)
    const row = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'deviceId')).get()
    expect(row?.value).toBe(id)
  })
})
