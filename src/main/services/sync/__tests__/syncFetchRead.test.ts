/**
 * fetchMessages pure-read regression (LOCK-PERSONAL-001/006).
 * A missing-topic fetch must return empty success without creating any
 * topic row and without emitting sync intent, so no hidden local topic can
 * remain permanently unsynced.
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

import { chatDbService } from '../../chatDb'
import { ChatDbAggregateService } from '../../chatDb/ChatDbAggregateService'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { syncService } from '../SyncService'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
  configStore.set('sync:token', '')
  sqlite = new Database(':memory:')
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
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
  vi.restoreAllMocks()
})

describe('fetchMessages pure read', () => {
  it('missing topic returns empty without creating a row or outbox intent', () => {
    const agg = new ChatDbAggregateService(db, sqlite)
    const res = agg.fetchMessages('t-missing-pure-read')
    expect(res.ok).toBe(true)
    if (res.ok !== true) return
    expect(res.value.messages).toEqual([])
    expect(res.value.blocks).toEqual([])
    expect(sqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-missing-pure-read')).toBeUndefined()
    expect(syncService.listOutbox().length).toBe(0)
    // Later explicit ensureTopic still sees a true creation.
    syncService.clearAllForTests()
    const ensured = agg.ensureTopic('t-missing-pure-read', 'a1', 'T')
    expect(ensured.ok).toBe(true)
    expect(sqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-missing-pure-read')).toBeTruthy()
  })

  it('existing topic fetch returns rows without emitting sync intent', () => {
    const agg = new ChatDbAggregateService(db, sqlite)
    expect(agg.ensureTopic('t-exists', 'a1', 'T').ok).toBe(true)
    syncService.clearAllForTests()
    const res = agg.fetchMessages('t-exists')
    expect(res.ok).toBe(true)
    expect(syncService.listOutbox().length).toBe(0)
  })
})
