/**
 * Registration credential blocker regressions (SYNC-CC-004/007, Main lane):
 * - The durable secret is persisted fail-closed at Connect; persistence
 *   failure never carries the secret (not on the error object, not in text,
 *   never in logs) — unified secret-persistence oracle.
 * - Malformed stored code/secret fails closed in preflight without transport.
 * - The secret is never logged.
 */
import { createHash, randomBytes } from 'node:crypto'

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

import { loggerService } from '@logger'

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

function freshDeviceAuth(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Current-generation (cc-1) marker seed: new-model registration semantics
 * (malformed/half fail closed, never auto-cleared) apply only once the
 * one-time SYNC-CC-013 upgrade has recorded the generation. First-upgrade
 * (marker absent) state is old-generation and takes the clear path instead.
 */
function seedCurrentGeneration(): void {
  db.insert(schema.syncState)
    .values({ key: 'sync:pairingGeneration', value: 'cc-1' })
    .onConflictDoUpdate({ target: schema.syncState.key, set: { value: 'cc-1' } })
    .run()
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
  // Seed after clearAllForTests (which wipes registration state): every test
  // starts from a coherent cc-1 registration unless it explicitly deletes or
  // corrupts it. This is the unified new-model oracle baseline.
  configStore.set('sync:deviceCode', 'ABCD2345')
  configStore.set('sync:deviceAuth', 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90')
  seedCurrentGeneration()
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
  try {
    sqlite.close()
  } catch {}
  ;(chatDbService as never as { sqlite: unknown }).sqlite = null
  ;(chatDbService as never as { db: unknown }).db = null
})

describe('registration credential blockers', () => {
  it('connect credential persistence failure never carries the secret', async () => {
    configStore.delete('sync:deviceCode')
    configStore.delete('sync:deviceAuth')
    const { syncClient } = await import('../SyncClient')
    const issued = freshDeviceAuth()
    vi.spyOn(syncClient, 'register').mockResolvedValue({ deviceCode: 'WXYZ5678', deviceSecret: issued })
    const origSet = (await import('@main/services/ConfigManager')).configManager.set
    vi.spyOn((await import('@main/services/ConfigManager')).configManager, 'set').mockImplementation(((
      k: string,
      v: unknown
    ) => {
      // Target only the registration secret write (non-empty): the pairing-
      // generation reset clears with '' and must keep working so the failure
      // under test is the atomic code+secret persist, not the pre-step.
      if (k === 'sync:deviceAuth' && v !== '') throw new Error('injected config persist failure')
      return (origSet as (k: string, v: unknown) => void)(k, v)
    }) as never)
    const err = await syncService.connect().then(
      () => null,
      (e: unknown) => e as Error & { deviceSecret?: unknown }
    )
    expect(err).not.toBeNull()
    // Unified secret-persistence oracle: the secret never enters the error
    // carrier (no error-object field, no message text, no logs).
    expect((err as { deviceSecret?: unknown })?.deviceSecret).toBeUndefined()
    expect((err as { deviceAuth?: unknown })?.deviceAuth).toBeUndefined()
    expect(String(err?.message)).not.toContain(issued)
    expect(String(err?.message)).toMatch(/persistence failed/i)
    // Nothing is half-persisted as success: status stays unregistered-ish.
    expect(syncService.getServiceStatus().state).not.toBe('connected')
  })

  it('issued registration secret persists before success is reported', async () => {
    configStore.delete('sync:deviceCode')
    configStore.delete('sync:deviceAuth')
    const { syncClient } = await import('../SyncClient')
    const issued = freshDeviceAuth()
    vi.spyOn(syncClient, 'register').mockResolvedValue({ deviceCode: 'WXYZ5678', deviceSecret: issued })
    const status = await syncService.connect()
    expect(status.state).toBe('connected')
    expect(status.deviceCode).toBe('WXYZ5678')
    expect(syncService.getDeviceAuth()).toBe(issued)
  })

  it('malformed device secret fails closed in preflight without transport', async () => {
    seedCurrentGeneration()
    const { syncClient } = await import('../SyncClient')
    const pushSpy = vi.spyOn(syncClient, 'push')
    const pullSpy = vi.spyOn(syncClient, 'pull')
    configStore.set('sync:deviceAuth', 'not-a-credential')
    await expect(syncService.sync()).rejects.toThrow(/device auth/i)
    expect(pushSpy).not.toHaveBeenCalled()
    expect(pullSpy).not.toHaveBeenCalled()
    // Unified oracle: same fragment fails closed in status/connect with an
    // explicit recovery requirement (never disguised as unregistered).
    expect(() => syncService.getServiceStatus()).toThrow(/device auth.*recovery required/i)
    const { syncClient: sc2 } = await import('../SyncClient')
    vi.spyOn(sc2, 'register')
    await expect(syncService.connect()).rejects.toThrow(/device auth|recovery required/i)
    expect(sc2.register).not.toHaveBeenCalled()
  })

  it('malformed device code fails closed in preflight without transport', async () => {
    seedCurrentGeneration()
    const { syncClient } = await import('../SyncClient')
    const pushSpy = vi.spyOn(syncClient, 'push')
    configStore.set('sync:deviceCode', 'bad!!')
    await expect(syncService.sync()).rejects.toThrow(/device code/i)
    expect(pushSpy).not.toHaveBeenCalled()
    expect(() => syncService.getServiceStatus()).toThrow(/device code.*recovery required/i)
  })

  it('half-persisted registration fails closed and never silently re-registers', async () => {
    seedCurrentGeneration()
    const { syncClient } = await import('../SyncClient')
    const registerSpy = vi.spyOn(syncClient, 'register')
    const pushSpy = vi.spyOn(syncClient, 'push')
    // Code without secret: preflight/status/connect fail closed.
    configStore.set('sync:deviceCode', 'ABCD2345')
    configStore.set('sync:deviceAuth', '')
    await expect(syncService.sync()).rejects.toThrow(/registration incomplete.*recovery required/i)
    expect(pushSpy).not.toHaveBeenCalled()
    expect(() => syncService.getServiceStatus()).toThrow(/registration incomplete.*recovery required/i)
    await expect(syncService.connect()).rejects.toThrow(/registration incomplete.*recovery required/i)
    expect(registerSpy).not.toHaveBeenCalled()
    // Secret without code: same oracle.
    configStore.set('sync:deviceCode', '')
    configStore.set('sync:deviceAuth', freshDeviceAuth())
    await expect(syncService.sync()).rejects.toThrow(/registration incomplete.*recovery required/i)
    expect(() => syncService.getServiceStatus()).toThrow(/registration incomplete.*recovery required/i)
    await expect(syncService.connect()).rejects.toThrow(/registration incomplete.*recovery required/i)
    expect(registerSpy).not.toHaveBeenCalled()
  })

  it('first upgrade (marker absent) safely clears legacy fragments', async () => {
    const { eq } = await import('drizzle-orm')
    // Simulate a pre-cc-1 database: drop the generation marker, leave a
    // legacy secret-without-code fragment plus a stale pre-channel cursor.
    db.delete(schema.syncState).where(eq(schema.syncState.key, 'sync:pairingGeneration')).run()
    db.insert(schema.syncState)
      .values({ key: 'cursor', value: '42' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: '42' } })
      .run()
    configStore.set('sync:deviceCode', '')
    configStore.set('sync:deviceAuth', freshDeviceAuth())
    const status = syncService.getServiceStatus()
    expect(status.state).toBe('unregistered')
    // One-time reset completed: marker recorded, legacy fragment and stale
    // cursor cleared (never reused across channels).
    const marker = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'sync:pairingGeneration')).get()
    expect(marker?.value).toBe('cc-1')
    expect(configStore.get('sync:deviceAuth') ?? '').toBe('')
    expect(syncService.getChannelKey()).toBeNull()
  })

  it('device credential and payloads are never logged', async () => {
    const { syncClient } = await import('../SyncClient')
    const issued = configStore.get('sync:deviceAuth') as string
    const issuedHash = createHash('sha256').update(issued, 'utf8').digest('hex')
    const seen: string[] = []
    vi.spyOn(loggerService, 'withContext').mockImplementation(
      () =>
        ({
          info: (m: string) => seen.push(String(m)),
          warn: (m: string) => seen.push(String(m)),
          error: (m: string) => seen.push(String(m))
        }) as never
    )
    vi.spyOn(syncClient, 'push').mockResolvedValue({ acceptedIds: [], cursor: 0, channelId: 'ch-1' } as never)
    vi.spyOn(syncClient, 'pull').mockResolvedValue({ operations: [], cursor: 0, channelId: 'ch-1' } as never)
    await syncService.sync()
    const dump = seen.join('\n')
    expect(dump).not.toContain(issued)
    expect(dump).not.toContain(issuedHash)
  })
})

describe('SyncClient device-identity headers', () => {
  it('sends bound device headers and rejects malformed secret before transport', async () => {
    const { syncClient } = await import('../SyncClient')
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const origFetch = globalThis.fetch
    ;(globalThis as unknown as { fetch: unknown }).fetch = (async (
      url: string,
      init: { headers: Record<string, string> }
    ) => {
      seen.push({ url: String(url), headers: { ...init?.headers } })
      return { ok: true, json: async () => ({ acceptedIds: [], cursor: 0, channelId: 'ch-1' }) } as never
    }) as never
    try {
      const auth = freshDeviceAuth()
      await syncClient.push(
        'http://127.0.0.1:9',
        undefined,
        { deviceId: 'd1', operations: [] },
        undefined,
        'ABCD2345',
        auth
      )
      expect(seen[0].headers['x-sync-device-code']).toBe('ABCD2345')
      expect(seen[0].headers['x-sync-device-secret']).toBe(auth)
      await expect(
        syncClient.push(
          'http://127.0.0.1:9',
          undefined,
          { deviceId: 'd1', operations: [] },
          undefined,
          'ABCD2345',
          'bad'
        )
      ).rejects.toThrow(/device auth/i)
      expect(seen.length).toBe(1)
    } finally {
      ;(globalThis as unknown as { fetch: unknown }).fetch = origFetch
    }
  })

  it('push/pull require registration before transport', async () => {
    const { syncClient } = await import('../SyncClient')
    await expect(syncClient.push('http://127.0.0.1:9', undefined, { deviceId: 'd1', operations: [] })).rejects.toThrow(
      /registration required/i
    )
    await expect(syncClient.pull('http://127.0.0.1:9', undefined, 0, 'd1')).rejects.toThrow(/registration required/i)
    await expect(syncClient.pull('http://127.0.0.1:9', undefined, 0, '')).rejects.toThrow(/device id/i)
  })

  it('relay error text never carries the secret', async () => {
    const { syncClient } = await import('../SyncClient')
    const issued = freshDeviceAuth()
    const origFetch = globalThis.fetch
    ;(globalThis as unknown as { fetch: unknown }).fetch = (async () =>
      ({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ error: 'pairing-required', deviceSecret: issued })
      }) as never) as never
    try {
      const err = await syncClient
        .push('http://127.0.0.1:9', undefined, { deviceId: 'd1', operations: [] }, undefined, 'ABCD2345', issued)
        .then(
          () => null,
          (e: unknown) => e as Error
        )
      expect(err).not.toBeNull()
      expect(String(err?.message)).not.toContain(issued)
      expect(String(err?.message)).toMatch(/pairing-required/)
    } finally {
      ;(globalThis as unknown as { fetch: unknown }).fetch = origFetch
    }
  })
})

describe('old-generation config-read fail-closed (shared handling)', () => {
  const LEGACY_SECRET = 'b1'.repeat(32)
  const READ_FAIL_RETRYABLE = /read failed.*retryable/i

  async function seedOldLegacyFragment(): Promise<void> {
    const { eq } = await import('drizzle-orm')
    db.delete(schema.syncState).where(eq(schema.syncState.key, 'sync:pairingGeneration')).run()
    db.insert(schema.syncState)
      .values({ key: 'cursor', value: '42' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: '42' } })
      .run()
    db.insert(schema.syncState)
      .values({ key: 'sync:channelKey', value: 'ch-legacy' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: 'ch-legacy' } })
      .run()
    try {
      sqlite.exec(
        'CREATE TABLE IF NOT EXISTS sync_trusted_devices (device_id TEXT PRIMARY KEY, device_name TEXT, trusted_at TEXT, source TEXT)'
      )
      sqlite.prepare(`DELETE FROM sync_trusted_devices`).run()
      sqlite
        .prepare(`INSERT INTO sync_trusted_devices (device_id, trusted_at, source) VALUES (?, ?, ?)`)
        .run('legacy-device', new Date().toISOString(), 'legacy')
    } catch {}
    configStore.set('sync:deviceCode', '')
    configStore.set('sync:deviceAuth', LEGACY_SECRET)
  }

  function readMarker(): string | null {
    try {
      const row = sqlite.prepare(`SELECT value FROM sync_state WHERE key='sync:pairingGeneration'`).get() as
        | { value: string }
        | undefined
      return row?.value ?? null
    } catch {
      return null
    }
  }

  function readCursor(): string | null {
    try {
      const row = sqlite.prepare(`SELECT value FROM sync_state WHERE key='cursor'`).get() as
        | { value: string }
        | undefined
      return row?.value ?? null
    } catch {
      return null
    }
  }

  function readLastError(): string {
    try {
      const row = sqlite.prepare(`SELECT value FROM sync_state WHERE key='lastError'`).get() as
        | { value: string }
        | undefined
      return row?.value ?? ''
    } catch {
      return ''
    }
  }

  function trustRowCount(): number {
    try {
      const row = sqlite.prepare(`SELECT COUNT(*) as c FROM sync_trusted_devices`).get() as { c: number }
      return row.c
    } catch {
      return -1
    }
  }

  it('device code read failure preserves credential/cursor/channel/trust/marker and retries', async () => {
    await seedOldLegacyFragment()
    const mod = await import('@main/services/ConfigManager')
    const spy = vi.spyOn(mod.configManager, 'get').mockImplementation(((k: string, def?: unknown) => {
      if (k === 'sync:deviceCode') throw new Error('injected code read failure')
      return configStore.has(k) ? configStore.get(k) : def
    }) as never)
    try {
      const err = (() => {
        try {
          syncService.getServiceStatus()
          return null
        } catch (e) {
          return e as Error
        }
      })()
      expect(err).not.toBeNull()
      expect(String(err?.message)).toMatch(READ_FAIL_RETRYABLE)
      expect(String(err?.message)).not.toContain(LEGACY_SECRET)
      // Fail closed: nothing cleared, marker unwritten.
      expect(configStore.get('sync:deviceAuth')).toBe(LEGACY_SECRET)
      expect(configStore.get('sync:deviceCode')).toBe('')
      expect(readCursor()).toBe('42')
      expect(syncService.getChannelKey()).toBe('ch-legacy')
      expect(trustRowCount()).toBe(1)
      expect(readMarker()).toBeNull()
      // Safe durable lastError (existing UI surface), no possible secret.
      expect(readLastError()).toMatch(READ_FAIL_RETRYABLE)
      expect(readLastError()).not.toContain(LEGACY_SECRET)
    } finally {
      spy.mockRestore()
    }
    // Next entry retries: legacy fragment clears and the generation records.
    const status = syncService.getServiceStatus()
    expect(status.state).toBe('unregistered')
    expect(readMarker()).toBe('cc-1')
    expect(configStore.get('sync:deviceAuth') ?? '').toBe('')
    expect(readCursor()).toBeNull()
    expect(syncService.getChannelKey()).toBeNull()
  })

  it('device auth read failure shares the same fail-closed handling and retries', async () => {
    await seedOldLegacyFragment()
    const mod = await import('@main/services/ConfigManager')
    const spy = vi.spyOn(mod.configManager, 'get').mockImplementation(((k: string, def?: unknown) => {
      if (k === 'sync:deviceAuth') throw new Error('injected secret read failure')
      return configStore.has(k) ? configStore.get(k) : def
    }) as never)
    try {
      const err = (() => {
        try {
          syncService.getServiceStatus()
          return null
        } catch (e) {
          return e as Error
        }
      })()
      expect(err).not.toBeNull()
      // Same shared fail-closed shape as the code-read failure above.
      expect(String(err?.message)).toMatch(READ_FAIL_RETRYABLE)
      expect(String(err?.message)).not.toContain(LEGACY_SECRET)
      expect(configStore.get('sync:deviceAuth')).toBe(LEGACY_SECRET)
      expect(readCursor()).toBe('42')
      expect(syncService.getChannelKey()).toBe('ch-legacy')
      expect(trustRowCount()).toBe(1)
      expect(readMarker()).toBeNull()
      expect(readLastError()).toMatch(READ_FAIL_RETRYABLE)
      expect(readLastError()).not.toContain(LEGACY_SECRET)
    } finally {
      spy.mockRestore()
    }
    const status = syncService.getServiceStatus()
    expect(status.state).toBe('unregistered')
    expect(readMarker()).toBe('cc-1')
  })
})

describe('centralized relay error sanitizer', () => {
  const DECOY = 'd4'.repeat(32)

  function readLastErrorDurable(): string {
    try {
      const row = sqlite.prepare(`SELECT value FROM sync_state WHERE key='lastError'`).get() as
        | { value: string }
        | undefined
      return row?.value ?? ''
    } catch {
      return ''
    }
  }

  it('strips nested secret keys (case/separator variants) but keeps pairing-required', async () => {
    const { syncClient } = await import('../SyncClient')
    const issued = freshDeviceAuth()
    const origFetch = globalThis.fetch
    const nestedBody = JSON.stringify({
      error: 'pairing-required',
      deviceSecret: DECOY,
      nested: {
        device_auth: DECOY,
        'Device-Secret': DECOY,
        deep: { SECRET: DECOY, authorization: DECOY, Token: DECOY, ok: 'keep' }
      }
    })
    ;(globalThis as unknown as { fetch: unknown }).fetch = (async () =>
      ({ ok: false, status: 403, text: async () => nestedBody }) as never) as never
    try {
      const err = await syncClient
        .push('http://127.0.0.1:9', undefined, { deviceId: 'd1', operations: [] }, undefined, 'ABCD2345', issued)
        .then(
          () => null,
          (e: unknown) => e as Error & { cause?: unknown }
        )
      expect(err).not.toBeNull()
      expect(String(err?.message)).toMatch(/pairing-required/)
      expect(String(err?.message)).not.toContain(DECOY)
      expect(String(err?.message)).not.toContain(issued)
      expect(JSON.stringify(err?.cause ?? null)).not.toContain(DECOY)
      expect(JSON.stringify(err?.cause ?? null)).not.toContain(issued)
    } finally {
      ;(globalThis as unknown as { fetch: unknown }).fetch = origFetch
    }
  })

  it('strips secrets inside arrays and keeps requester-already-paired', async () => {
    const { sanitizeRelayErrorBody } = await import('../relayError')
    const body = JSON.stringify({
      items: [{ deviceSecret: DECOY }, { deviceAuth: DECOY }],
      error: 'requester-already-paired'
    })
    const safe = sanitizeRelayErrorBody(body, 409)
    expect(safe).toMatch(/requester-already-paired/)
    expect(safe).not.toContain(DECOY)
    // End-to-end through the shared client path (cause carries no raw body).
    const { syncClient } = await import('../SyncClient')
    const issued = freshDeviceAuth()
    const origFetch = globalThis.fetch
    ;(globalThis as unknown as { fetch: unknown }).fetch = (async () =>
      ({ ok: false, status: 409, text: async () => body }) as never) as never
    try {
      const err = await syncClient.pull('http://127.0.0.1:9', undefined, 0, 'd1', undefined, 'ABCD2345', issued).then(
        () => null,
        (e: unknown) => e as Error & { cause?: unknown }
      )
      expect(err).not.toBeNull()
      expect(String(err?.message)).toMatch(/requester-already-paired/)
      expect(String(err?.message)).not.toContain(DECOY)
      expect(JSON.stringify(err?.cause ?? null)).not.toContain(DECOY)
    } finally {
      ;(globalThis as unknown as { fetch: unknown }).fetch = origFetch
    }
  })

  it('plain text with a decoy secret never echoes raw; fixed summary plus status survives', async () => {
    const { syncClient } = await import('../SyncClient')
    const issued = freshDeviceAuth()
    const origFetch = globalThis.fetch
    ;(globalThis as unknown as { fetch: unknown }).fetch = (async () =>
      ({ ok: false, status: 500, text: async () => `relay boom ${DECOY} failed badly` }) as never) as never
    try {
      const err = await syncClient
        .push('http://127.0.0.1:9', undefined, { deviceId: 'd1', operations: [] }, undefined, 'ABCD2345', issued)
        .then(
          () => null,
          (e: unknown) => e as Error & { cause?: unknown }
        )
      expect(err).not.toBeNull()
      expect(String(err?.message)).toMatch(/500/)
      expect(String(err?.message)).not.toContain(DECOY)
      expect(String(err?.message)).not.toContain(issued)
      expect(JSON.stringify(err?.cause ?? null)).not.toContain(DECOY)
    } finally {
      ;(globalThis as unknown as { fetch: unknown }).fetch = origFetch
    }
  })

  it('embedded 64hex without word boundaries collapses to fixed summary (nested/array/key/plain)', async () => {
    const { relayHttpError, sanitizeRelayErrorBody } = await import('../relayError')
    const wrapped = `x${DECOY}y`
    const longHex = `${DECOY}${'ab'.repeat(32)}`
    // Plain text: alphanumeric-wrapped credential must not pass the allowlist.
    expect(sanitizeRelayErrorBody(wrapped, 500)).toBe('request failed')
    expect(sanitizeRelayErrorBody(`relay boom ${wrapped} failed`, 500)).toBe('request failed')
    expect(sanitizeRelayErrorBody(longHex, 500)).toBe('request failed')
    // JSON nested value under a non-secret key.
    expect(sanitizeRelayErrorBody(JSON.stringify({ error: 'oops', nested: { note: `leak ${wrapped}` } }), 500)).toBe(
      'request failed'
    )
    // JSON array entry carrying an embedded credential.
    expect(sanitizeRelayErrorBody(JSON.stringify({ items: [`prefix-${DECOY}-suffix`] }), 500)).toBe('request failed')
    expect(sanitizeRelayErrorBody(JSON.stringify([`a${DECOY}b`]), 500)).toBe('request failed')
    // JSON key itself carrying credential material.
    expect(sanitizeRelayErrorBody(JSON.stringify({ [`k-${DECOY}-k`]: 'v' }), 500)).toBe('request failed')
    // Long-hex-run nesting inside JSON values.
    expect(sanitizeRelayErrorBody(JSON.stringify({ detail: longHex }), 500)).toBe('request failed')
    // Direct object input (non-string body) follows the same check.
    expect(sanitizeRelayErrorBody({ detail: wrapped } as unknown, 500)).toBe('request failed')
    // Thrown error/cause never carry the raw material.
    const err = relayHttpError('push', 500, `boom ${wrapped}`)
    expect(String(err.message)).toBe('push failed 500: request failed')
    expect(String(err.message)).not.toContain(DECOY)
    expect(JSON.stringify((err as { cause?: unknown }).cause ?? null)).not.toContain(DECOY)
    expect(JSON.stringify((err as { cause?: unknown }).cause ?? null)).toBe(JSON.stringify({ status: 500 }))
  })

  it('safe relay codes and short hashes survive the locked 64hex threshold', async () => {
    const { sanitizeRelayErrorBody } = await import('../relayError')
    expect(sanitizeRelayErrorBody('pairing-required', 403)).toBe('pairing-required')
    expect(sanitizeRelayErrorBody('requester-already-paired', 409)).toBe('requester-already-paired')
    expect(sanitizeRelayErrorBody(JSON.stringify({ error: 'pairing-required' }), 403)).toContain('pairing-required')
    // 32-hex (MD5-length) and short hex fragments are not credential format.
    const shortHash = 'd4'.repeat(16)
    expect(sanitizeRelayErrorBody(shortHash, 500)).toBe(shortHash)
    expect(sanitizeRelayErrorBody(JSON.stringify({ error: 'oops', hash: shortHash }), 500)).toContain(shortHash)
  })

  it('SSE non-2xx body stays safe in logger and onDisconnect; durable lastError keeps the code only', async () => {
    const { SyncSubscriber } = await import('../syncSubscriber')
    const warnSpy = vi.spyOn(loggerService, 'warn').mockImplementation((() => {}) as never)
    const origFetch = globalThis.fetch
    ;(globalThis as unknown as { fetch: unknown }).fetch = (async () =>
      ({
        ok: false,
        status: 403,
        text: async () => `subscribe boom ${DECOY}`,
        headers: { get: () => '' },
        body: null
      }) as never) as never
    try {
      const sub = new SyncSubscriber()
      const disconnected = new Promise<Error | undefined>((resolve) => {
        sub.start('http://127.0.0.1:9', undefined, {
          onNotify: () => {},
          onDisconnect: (e) => resolve(e)
        })
      })
      const err = await disconnected
      expect(err).toBeTruthy()
      expect(String(err?.message)).toMatch(/403/)
      expect(String(err?.message)).not.toContain(DECOY)
      expect(JSON.stringify((err as { cause?: unknown })?.cause ?? null)).not.toContain(DECOY)
      const logged = warnSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n')
      expect(logged).not.toContain(DECOY)
      sub.stop()
    } finally {
      ;(globalThis as unknown as { fetch: unknown }).fetch = origFetch
      warnSpy.mockRestore()
    }
    // Durable lastError path (sync pull failure with nested decoy + useful code).
    const issued = configStore.get('sync:deviceAuth') as string
    const relayBody = JSON.stringify({ error: 'pairing-required', nested: { deviceSecret: DECOY } })
    const origFetch2 = globalThis.fetch
    ;(globalThis as unknown as { fetch: unknown }).fetch = (async (url: string) => {
      if (String(url).includes('/sync/pull')) {
        return { ok: false, status: 403, text: async () => relayBody } as never
      }
      return { ok: true, json: async () => ({ operations: [], cursor: 0 }) } as never
    }) as never
    try {
      const err = await syncService.sync().then(
        () => null,
        (e: unknown) => e as Error
      )
      expect(err).not.toBeNull()
      expect(String(err?.message)).toMatch(/pairing-required/)
      expect(String(err?.message)).not.toContain(DECOY)
      const durable = readLastErrorDurable()
      expect(durable).toMatch(/pairing-required/)
      expect(durable).not.toContain(DECOY)
      expect(durable).not.toContain(issued)
    } finally {
      ;(globalThis as unknown as { fetch: unknown }).fetch = origFetch2
    }
  })
})
