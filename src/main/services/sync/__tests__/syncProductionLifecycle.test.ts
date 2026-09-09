/**
 * Production protocol/lifecycle unit (Main lane, focused Node suite):
 * - Channel-identity observation (accept/unpair/getPairState) emits a
 *   channel-change signal so automation restarts the channel-bound SSE
 *   subscriber immediately (not only via the 30s reconcile timer). SSE hints
 *   stay notification-only; strict push/pull remains the data authority.
 * - Pairing-reset failure in getServiceStatus fails closed (throw + durable
 *   lastError, marker unwritten for retry) instead of masquerading as an
 *   ordinary unregistered/disconnected state.
 * - Unified secret-persistence oracle: the device secret never enters the
 *   error carrier (no error-object field, no message text, no logs).
 */
import { randomBytes, randomUUID } from 'node:crypto'

import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
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

import { chatDbService } from '../../chatDb'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { syncClient } from '../SyncClient'
import { syncService } from '../SyncService'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>

const DEVICE_CODE = 'ABCD2345'

function freshSecret(): string {
  return randomBytes(32).toString('hex')
}

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

function seedRegistration(secret: string): void {
  configStore.set('sync:deviceCode', DEVICE_CODE)
  configStore.set('sync:deviceAuth', secret)
}

function readMarker(): string | null {
  const row = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'sync:pairingGeneration')).get()
  return (row?.value as string | null) ?? null
}

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', 'http://127.0.0.1:3999')
  configStore.set('sync:token', 'test-token')
  sqlite = openInMemory()
  db = drizzle(sqlite, { schema })
  runMigrations(db as never, sqlite)
  ;(chatDbService as never as { sqlite: unknown }).sqlite = sqlite
  ;(chatDbService as never as { db: unknown }).db = db
  syncService.clearAllForTests()
  syncService.resetShutdownForTests()
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
  try {
    syncService.resetShutdownForTests()
  } catch {}
  try {
    sqlite.close()
  } catch {}
  ;(chatDbService as never as { sqlite: unknown }).sqlite = null
  ;(chatDbService as never as { db: unknown }).db = null
})

describe('channel-change signal drives subscriber restart', () => {
  it('getPairState observing a new channel emits exactly once', async () => {
    seedRegistration(freshSecret())
    let fires = 0
    const unsub = syncService.onChannelChange(() => {
      fires += 1
    })
    try {
      vi.spyOn(syncClient, 'getPairState').mockResolvedValue({
        deviceCode: DEVICE_CODE,
        paired: true,
        channelId: 'ch-1',
        outgoing: null,
        incoming: []
      })
      const state = await syncService.getPairState()
      expect(state.state).toBe('paired')
      expect(syncService.getChannelKey()).toBe('ch-1')
      expect(fires).toBe(1)
      // Same channel observed again: no repeat emission, no restart churn.
      await syncService.getPairState()
      expect(fires).toBe(1)
    } finally {
      unsub()
    }
  })

  it('accept/unpair observations emit so automation can resubscribe immediately', async () => {
    seedRegistration(freshSecret())
    const seen: number[] = []
    const unsub = syncService.onChannelChange(() => {
      seen.push(Date.now())
    })
    try {
      vi.spyOn(syncClient, 'acceptPairing').mockResolvedValue({ channelId: 'ch-2' })
      const accepted = await syncService.acceptPairing(randomUUID())
      expect(accepted.channelId).toBe('ch-2')
      expect(syncService.getChannelKey()).toBe('ch-2')
      expect(seen.length).toBe(1)
      vi.spyOn(syncClient, 'unpair').mockResolvedValue(undefined)
      await syncService.unpair()
      expect(syncService.getChannelKey()).toBeNull()
      expect(seen.length).toBe(2)
    } finally {
      unsub()
    }
  })

  it('syncAuto restarts its subscriber when the channel changes (not only on reconcile)', async () => {
    const secret = freshSecret()
    seedRegistration(secret)
    vi.spyOn(syncClient, 'getPairState').mockResolvedValue({
      deviceCode: DEVICE_CODE,
      paired: true,
      channelId: 'ch-auto-1',
      outgoing: null,
      incoming: []
    })
    const { SyncAutoService } = await import('../syncAuto')
    let starts = 0
    const svc = new SyncAutoService({
      getConfig: () => ({ endpoint: 'http://127.0.0.1:3999', token: 'test-token', enabled: true }),
      isAttached: () => true,
      getCredentials: () => ({ deviceCode: DEVICE_CODE, deviceSecret: secret }),
      runSync: async () => ({ ok: true }),
      createSubscriber: () =>
        ({
          start: () => {
            starts += 1
          },
          stop: () => {},
          isActive: () => false
        }) as never
    })
    svc.start()
    try {
      expect(starts).toBe(1)
      // A channel observation through the production path restarts the
      // channel-bound subscriber immediately.
      await syncService.getPairState()
      expect(syncService.getChannelKey()).toBe('ch-auto-1')
      expect(starts).toBe(2)
    } finally {
      svc.stopSync()
      syncService.resetShutdownForTests()
    }
  })
})

describe('pairing-reset failure is fail-closed and observable', () => {
  it('getServiceStatus throws, records lastError, and leaves the marker for retry', async () => {
    configStore.delete('sync:deviceCode')
    configStore.delete('sync:deviceAuth')
    const { configManager } = await import('@main/services/ConfigManager')
    const origSet = configManager.set
    let failOnce = true
    vi.spyOn(configManager, 'set').mockImplementation(((k: string, v: unknown) => {
      if (failOnce && (k === 'sync:deviceAuth' || k === 'sync:deviceCode')) {
        failOnce = false
        throw new Error('injected reset persist failure')
      }
      return (origSet as (kk: string, vv: unknown) => void)(k, v)
    }) as never)
    let thrown: unknown = null
    try {
      syncService.getServiceStatus()
    } catch (e) {
      thrown = e
    }
    expect(thrown).not.toBeNull()
    expect(String((thrown as Error)?.message)).toMatch(/reset failed|pairing reset/i)
    // Marker unwritten: the reset retries on the next entry.
    expect(readMarker()).not.toBe('cc-1')
    // The failure stays observable through the existing lastError surface.
    const status = syncService.getStatus()
    expect(status.lastError).toMatch(/service status unavailable/i)
    // Retry with restored persistence succeeds explicitly.
    vi.restoreAllMocks()
    const retry = syncService.getServiceStatus()
    expect(retry.state).toBe('unregistered')
    expect(readMarker()).toBe('cc-1')
  })
})

describe('unified secret-persistence oracle', () => {
  it('credential persistence failure carries no secret anywhere', async () => {
    configStore.delete('sync:deviceCode')
    configStore.delete('sync:deviceAuth')
    const issued = freshSecret()
    vi.spyOn(syncClient, 'register').mockResolvedValue({ deviceCode: 'WXYZ5678', deviceSecret: issued })
    const { configManager } = await import('@main/services/ConfigManager')
    const origSet = configManager.set
    vi.spyOn(configManager, 'set').mockImplementation(((k: string, v: unknown) => {
      if (k === 'sync:deviceAuth' && v !== '') throw new Error('injected secret persist failure')
      return (origSet as (kk: string, vv: unknown) => void)(k, v)
    }) as never)
    const err = await syncService.connect().then(
      () => null,
      (e: unknown) => e as Error & Record<string, unknown>
    )
    expect(err).not.toBeNull()
    // No error-object field carries the secret (any key, any casing).
    for (const key of Object.keys(err as object)) {
      expect(key.toLowerCase()).not.toContain('secret')
      expect(key.toLowerCase()).not.toContain('auth')
    }
    expect((err as unknown as { deviceSecret?: unknown })?.deviceSecret).toBeUndefined()
    expect((err as unknown as { deviceAuth?: unknown })?.deviceAuth).toBeUndefined()
    expect(String((err as Error)?.message)).not.toContain(issued)
    expect(String((err as Error)?.cause ?? '')).not.toContain(issued)
  })
})
