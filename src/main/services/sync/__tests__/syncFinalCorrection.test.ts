/**
 * Narrow correction regressions: visible config-read failure handling,
 * truthful preflight boundary, and missing fallback-block no-op.
 * No schema, no scope expansion, no final-validation claim.
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

import { IpcChannel } from '@shared/IpcChannel'

import { chatDbService } from '../../chatDb'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { handleChatDbSuccessForSync } from '../chatDbHook'
import { syncService } from '../SyncService'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

function lastErrorValue(): string | null {
  try {
    const row = sqlite.prepare(`SELECT value FROM sync_state WHERE key='lastError'`).get() as
      | { value: string }
      | undefined
    return row?.value ?? null
  } catch {
    return null
  }
}

function lastCaptureErrorValue(): string | null {
  try {
    const row = sqlite.prepare(`SELECT value FROM sync_state WHERE key='lastCaptureError'`).get() as
      | { value: string }
      | undefined
    return row?.value ?? null
  } catch {
    return null
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
})

afterEach(() => {
  vi.restoreAllMocks()
  try {
    sqlite.close()
  } catch {}
  ;(chatDbService as never as { sqlite: unknown }).sqlite = null
  ;(chatDbService as never as { db: unknown }).db = null
})

describe('config refresh failure is visible and invalidates stale cycles', () => {
  it('logs + persists a bounded durable error and invalidates without silent success', async () => {
    const { SyncAutoService: Cls } = await import('../syncAuto')
    const invalidateSpy = vi.spyOn(syncService, 'invalidateForConfigChange')
    const captureSpy = vi.spyOn(syncService, 'recordCaptureFailure')
    const fakeSubscriber = { start: vi.fn(), stop: vi.fn() }
    const svc = new Cls({
      getConfig: (): { endpoint: string; token?: string; enabled: boolean } => {
        throw new Error('config-refresh-boom')
      },
      runSync: () => Promise.resolve(null),
      createSubscriber: () => fakeSubscriber as never
    })
    // Must not throw when the DB is available; failure stays visible durably.
    expect(() => svc.start()).not.toThrow()
    expect(invalidateSpy).toHaveBeenCalled()
    expect(captureSpy).toHaveBeenCalled()
    const durable = `${lastCaptureErrorValue() ?? ''} ${lastErrorValue() ?? ''}`
    expect(durable.toLowerCase()).toMatch(/refresh|config-refresh-boom/)
    expect(durable.length).toBeLessThanOrEqual(2100)
    svc.stopSync()
  })
})

describe('sync preflight config failure reports durably and preserves the original error', () => {
  it('getConfig throw records lastError and rethrows the original', async () => {
    const spy = vi.spyOn(syncService, 'getConfig').mockImplementation(() => {
      throw new Error('config-preflight-boom')
    })
    await expect(syncService.sync()).rejects.toThrow(/config-preflight-boom/)
    expect((lastErrorValue() ?? '').toLowerCase()).toMatch(/preflight|config-preflight-boom/)
    const cursor = sqlite.prepare(`SELECT value FROM sync_state WHERE key='cursor'`).get() as
      | { value: string }
      | undefined
    expect(cursor).toBeUndefined()
    spy.mockRestore()
  })
})

describe('missing fallback block is a non-error no-op', () => {
  it('UpdateBlocks/UpdateSingleBlock/BulkAddBlocks skip before parent closure with no capture error', () => {
    const captureSpy = vi.spyOn(syncService, 'recordCaptureFailure')
    syncService.clearAllForTests()
    captureSpy.mockClear()
    handleChatDbSuccessForSync(IpcChannel.ChatDb_UpdateBlocks, { blocks: [{ id: 'b-absent-1' }] })
    handleChatDbSuccessForSync(IpcChannel.ChatDb_UpdateSingleBlock, { blockId: 'b-absent-2' })
    handleChatDbSuccessForSync(IpcChannel.ChatDb_BulkAddBlocks, { blocks: [{ id: 'b-absent-3' }] })
    expect(syncService.listOutbox()).toHaveLength(0)
    expect(captureSpy).not.toHaveBeenCalled()
    expect(lastCaptureErrorValue()).toBeNull()
    expect(lastErrorValue()).toBeNull()
  })
})
