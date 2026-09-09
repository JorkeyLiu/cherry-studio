/**
 * Service connection + registration + channel pairing (SYNC-CC-*, Main lane):
 * - Explicit Connect registers once (stable code + durable secret) and
 *   re-attaches without rotation; unknown credentials fail closed.
 * - Disconnect stops attachment/auto-reconnect but preserves registration,
 *   membership observation, and local outbox intent.
 * - Pairing state mapping (unpaired/outgoing/incoming/paired); paired
 *   requesters cannot initiate (refused before any relay call).
 * - Unpair requires attachment; accept reconciles the observed channel and
 *   resets the cursor on channel change, never across matching channels.
 */
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
import { syncService } from '../SyncService'

const TEST_CODE = 'ABCD2345'
const TEST_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
const OTHER_SECRET = 'b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

function seedRegistered(): void {
  configStore.set('sync:deviceCode', TEST_CODE)
  configStore.set('sync:deviceAuth', TEST_SECRET)
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
})

afterEach(() => {
  vi.restoreAllMocks()
  try {
    sqlite.close()
  } catch {}
  ;(chatDbService as never as { sqlite: unknown }).sqlite = null
  ;(chatDbService as never as { db: unknown }).db = null
})

describe('explicit Connect and registration', () => {
  it('first Connect registers and persists code + secret, resetting the cursor', async () => {
    const { syncClient } = await import('../SyncClient')
    vi.spyOn(syncClient, 'register').mockResolvedValue({ deviceCode: 'WXYZ5678', deviceSecret: OTHER_SECRET })
    const status = await syncService.connect()
    expect(status.state).toBe('connected')
    expect(status.deviceCode).toBe('WXYZ5678')
    expect(configStore.get('sync:deviceCode')).toBe('WXYZ5678')
    expect(configStore.get('sync:deviceAuth')).toBe(OTHER_SECRET)
    expect(configStore.get('sync:explicitDisconnect')).toBe(false)
    expect(syncService.getChannelKey()).toBeNull()
  })

  it('registered Connect re-attaches without re-registering', async () => {
    seedRegistered()
    const { syncClient } = await import('../SyncClient')
    const registerSpy = vi.spyOn(syncClient, 'register')
    const stateSpy = vi
      .spyOn(syncClient, 'getPairState')
      .mockResolvedValue({ deviceCode: TEST_CODE, paired: false, channelId: null, outgoing: null, incoming: [] })
    const status = await syncService.connect()
    expect(registerSpy).not.toHaveBeenCalled()
    expect(stateSpy).toHaveBeenCalledOnce()
    expect(status.state).toBe('connected')
    expect(status.deviceCode).toBe(TEST_CODE)
  })

  it('unknown credential on re-attach fails closed with service disconnected', async () => {
    seedRegistered()
    const { syncClient } = await import('../SyncClient')
    vi.spyOn(syncClient, 'getPairState').mockRejectedValue(
      new Error('sync request failed 403: {"error":"unknown-credential"}')
    )
    await expect(syncService.connect()).rejects.toThrow(/unknown-credential/)
    // No silent re-registration happened.
    expect(configStore.get('sync:deviceCode')).toBe(TEST_CODE)
    expect(configStore.get('sync:deviceAuth')).toBe(TEST_SECRET)
    expect(syncService.getServiceStatus().state).toBe('disconnected')
  })

  it('service status reports unregistered before Connect', () => {
    const status = syncService.getServiceStatus()
    expect(status.state).toBe('unregistered')
    expect(status.deviceCode).toBeNull()
  })
})

describe('Disconnect preserves registration and outbox intent', () => {
  it('disconnect stops attachment but keeps registration and pending outbox', async () => {
    seedRegistered()
    // Seed one outbox row (business intent) via the tx-bound capture path shape.
    const deviceId = syncService.getDeviceId()
    db.insert(schema.syncOutbox)
      .values({
        id: 'outbox-keep-1',
        entityType: 'topic',
        op: 'upsert',
        entityId: 't-keep',
        timestamp: 1000,
        deviceId,
        payloadJson: JSON.stringify({ id: 't-keep', name: 'keep' }),
        createdAt: new Date().toISOString()
      })
      .run()
    const status = await syncService.disconnect()
    expect(status.state).toBe('disconnected')
    expect(status.explicitDisconnect).toBe(true)
    expect(configStore.get('sync:deviceCode')).toBe(TEST_CODE)
    expect(configStore.get('sync:deviceAuth')).toBe(TEST_SECRET)
    expect(syncService.isAutoSyncAllowed()).toBe(false)
    expect(db.select().from(schema.syncOutbox).all()).toHaveLength(1)
    // Manual sync while disconnected fails closed before transport.
    const { syncClient } = await import('../SyncClient')
    const pushSpy = vi.spyOn(syncClient, 'push')
    await expect(syncService.sync()).rejects.toThrow(/explicit disconnect/i)
    expect(pushSpy).not.toHaveBeenCalled()
    // Re-connect re-attaches with the same credential (no repair needed).
    const stateSpy = vi
      .spyOn(syncClient, 'getPairState')
      .mockResolvedValue({ deviceCode: TEST_CODE, paired: true, channelId: 'ch-1', outgoing: null, incoming: [] })
    const registerSpy = vi.spyOn(syncClient, 'register')
    const reconnected = await syncService.connect()
    expect(registerSpy).not.toHaveBeenCalled()
    expect(stateSpy).toHaveBeenCalled()
    expect(reconnected.state).toBe('connected')
    expect(db.select().from(schema.syncOutbox).all()).toHaveLength(1)
  })

  it('unregistered sync never touches transport', async () => {
    const { syncClient } = await import('../SyncClient')
    const pushSpy = vi.spyOn(syncClient, 'push')
    const pullSpy = vi.spyOn(syncClient, 'pull')
    await expect(syncService.sync()).rejects.toThrow(/registration required/i)
    expect(pushSpy).not.toHaveBeenCalled()
    expect(pullSpy).not.toHaveBeenCalled()
  })
})

describe('pairing state and lifecycle guards', () => {
  it('maps relay state to unpaired/outgoing/incoming/paired', async () => {
    seedRegistered()
    const { syncClient } = await import('../SyncClient')
    const spy = vi.spyOn(syncClient, 'getPairState')
    spy.mockResolvedValueOnce({ deviceCode: TEST_CODE, paired: false, channelId: null, outgoing: null, incoming: [] })
    expect((await syncService.getPairState()).state).toBe('unpaired')
    spy.mockResolvedValueOnce({
      deviceCode: TEST_CODE,
      paired: false,
      channelId: null,
      outgoing: { id: 'r1', targetCode: 'WXYZ5678', createdAt: new Date().toISOString() },
      incoming: []
    })
    expect((await syncService.getPairState()).state).toBe('outgoing')
    spy.mockResolvedValueOnce({
      deviceCode: TEST_CODE,
      paired: false,
      channelId: null,
      outgoing: null,
      incoming: [{ id: 'r2', requesterCode: 'WXYZ5678', createdAt: new Date().toISOString() }]
    })
    expect((await syncService.getPairState()).state).toBe('incoming')
    spy.mockResolvedValueOnce({ deviceCode: TEST_CODE, paired: true, channelId: 'ch-9', outgoing: null, incoming: [] })
    const paired = await syncService.getPairState()
    expect(paired.state).toBe('paired')
    expect(syncService.getChannelKey()).toBe('ch-9')
  })

  it('paired requester cannot initiate: refused before any relay call', async () => {
    seedRegistered()
    const { syncClient } = await import('../SyncClient')
    vi.spyOn(syncClient, 'getPairState').mockResolvedValue({
      deviceCode: TEST_CODE,
      paired: true,
      channelId: 'ch-9',
      outgoing: null,
      incoming: []
    })
    const requestSpy = vi.spyOn(syncClient, 'requestPairing')
    await expect(syncService.requestPairing('WXYZ5678')).rejects.toThrow(/already paired/i)
    expect(requestSpy).not.toHaveBeenCalled()
  })

  it('malformed target code fails closed before transport', async () => {
    seedRegistered()
    const { syncClient } = await import('../SyncClient')
    const requestSpy = vi.spyOn(syncClient, 'requestPairing')
    await expect(syncService.requestPairing('SHORT')).rejects.toThrow(/device code/i)
    expect(requestSpy).not.toHaveBeenCalled()
  })

  it('unpair while disconnected is refused before transport', async () => {
    seedRegistered()
    await syncService.disconnect()
    const { syncClient } = await import('../SyncClient')
    const unpairSpy = vi.spyOn(syncClient, 'unpair')
    await expect(syncService.unpair()).rejects.toThrow(/explicit disconnect|disconnected/i)
    expect(unpairSpy).not.toHaveBeenCalled()
  })

  it('accept reconciles a new channel with cursor reset; same channel keeps cursor', async () => {
    seedRegistered()
    const { syncClient } = await import('../SyncClient')
    db.insert(schema.syncState).values({ key: 'cursor', value: '7' }).run()
    db.insert(schema.syncState).values({ key: 'sync:channelKey', value: 'ch-old' }).run()
    vi.spyOn(syncClient, 'acceptPairing').mockResolvedValue({ channelId: 'ch-new' })
    const res = await syncService.acceptPairing('req-1')
    expect(res.channelId).toBe('ch-new')
    expect(syncService.getChannelKey()).toBe('ch-new')
    const cursorRow = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
    expect(cursorRow?.value).toBe('0')
    // Same-channel accept keeps the cursor.
    db.insert(schema.syncState)
      .values({ key: 'cursor', value: '4' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: '4' } })
      .run()
    vi.spyOn(syncClient, 'acceptPairing').mockResolvedValue({ channelId: 'ch-new' })
    await syncService.acceptPairing('req-2')
    const kept = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
    expect(kept?.value).toBe('4')
  })

  it('unpair preserves service registration and clears only channel observation', async () => {
    seedRegistered()
    const { syncClient } = await import('../SyncClient')
    vi.spyOn(syncClient, 'unpair').mockResolvedValue(undefined as never)
    db.insert(schema.syncState).values({ key: 'sync:channelKey', value: 'ch-1' }).run()
    await syncService.unpair()
    expect(configStore.get('sync:deviceCode')).toBe(TEST_CODE)
    expect(configStore.get('sync:deviceAuth')).toBe(TEST_SECRET)
    expect(syncService.getChannelKey()).toBeNull()
    expect(syncService.getServiceStatus().state).toBe('connected')
  })
})

describe('one-time legacy reset without migration', () => {
  it('a secret without a code (legacy) is discarded; chats and outbox survive', async () => {
    configStore.set('sync:deviceAuth', TEST_SECRET)
    const deviceId = syncService.getDeviceId()
    db.insert(schema.syncOutbox)
      .values({
        id: 'outbox-legacy-1',
        entityType: 'topic',
        op: 'upsert',
        entityId: 't-legacy',
        timestamp: 1000,
        deviceId,
        payloadJson: JSON.stringify({ id: 't-legacy', name: 'legacy' }),
        createdAt: new Date().toISOString()
      })
      .run()
    db.insert(schema.syncState).values({ key: 'cursor', value: '9' }).run()
    const status = syncService.getServiceStatus()
    expect(status.state).toBe('unregistered')
    expect(configStore.get('sync:deviceAuth')).toBe('')
    expect(db.select().from(schema.syncOutbox).all()).toHaveLength(1)
    expect(
      db
        .select()
        .from(schema.syncState)
        .all()
        .some((r) => r.key === 'cursor')
    ).toBe(false)
  })
})
