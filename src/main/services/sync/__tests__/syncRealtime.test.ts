/**
 * Realtime closure focused tests (Node lane, no Electron):
 * - Relay SSE protocol: header auth, notification-only cursor hint, heartbeat,
 *   no operation payload, emit-after-commit, connection cleanup.
 * - SSE hint parser: ignores comments/malformed frames, emits integer cursors.
 * - Auto coalescing: concurrent triggers serialize without surfacing
 *   `already in progress`; manual sync() semantics untouched (throws when busy).
 */
import Database from 'better-sqlite3'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { createRelayServer } from '../../../../../scripts/sync-relay/server'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')
vi.mock('@main/config', () => ({ DATA_PATH: '/tmp' }))

const relayToken = 'rt-token-1'

function validOp(id: string, n: number): Record<string, unknown> {
  return {
    id,
    entityType: 'topic',
    op: 'upsert',
    entityId: `t-${id}`,
    timestamp: 1000 + n,
    deviceId: 'd1',
    payload: { id: `t-${id}`, name: `N${n}` }
  }
}

describe('relay SSE notification-only', () => {
  let db: Database.Database
  let server: ReturnType<typeof createRelayServer>
  let baseUrl: string
  let codeA = ''
  let secretA = ''

  beforeAll(async () => {
    const { createRelayServer } = await import('../../../../../scripts/sync-relay/server')
    db = new Database(':memory:')
    const { ensureRelaySchema } = await import('../../../../../scripts/sync-relay/server')
    ensureRelaySchema(db)
    server = createRelayServer(db, { token: relayToken })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }
    baseUrl = `http://127.0.0.1:${addr.port}`
    // Register two devices and pair them so the data plane is reachable.
    // Registrations carry their real client device ids (operation identity
    // binding: push deviceId must equal the registered client id).
    const authed = { Authorization: `Bearer ${relayToken}`, 'Content-Type': 'application/json' }
    const regA = (await (
      await fetch(`${baseUrl}/sync/register`, {
        method: 'POST',
        headers: authed,
        body: JSON.stringify({ deviceId: 'd1' })
      })
    ).json()) as { deviceCode: string; deviceSecret: string }
    const regB = (await (
      await fetch(`${baseUrl}/sync/register`, {
        method: 'POST',
        headers: authed,
        body: JSON.stringify({ deviceId: 'd2' })
      })
    ).json()) as { deviceCode: string; deviceSecret: string }
    codeA = regA.deviceCode
    secretA = regA.deviceSecret
    const req = (await (
      await fetch(`${baseUrl}/sync/pair/request`, {
        method: 'POST',
        headers: { ...authed, 'x-sync-device-code': regB.deviceCode, 'x-sync-device-secret': regB.deviceSecret },
        body: JSON.stringify({ targetCode: codeA })
      })
    ).json()) as { requestId: string }
    const accept = await fetch(`${baseUrl}/sync/pair/accept`, {
      method: 'POST',
      headers: { ...authed, 'x-sync-device-code': codeA, 'x-sync-device-secret': secretA },
      body: JSON.stringify({ requestId: req.requestId })
    })
    expect(accept.status).toBe(200)
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    try {
      db.close()
    } catch {}
  })

  it('rejects subscribe without Bearer token', async () => {
    const res = await fetch(`${baseUrl}/sync/subscribe?cursor=0`)
    expect(res.status).toBe(401)
    await res.text().catch(() => '')
  })

  it('rejects subscribe with invalid cursor framing', async () => {
    const res = await fetch(`${baseUrl}/sync/subscribe?cursor=-1`, {
      headers: { Authorization: `Bearer ${relayToken}` }
    })
    expect(res.status).toBe(400)
    await res.text().catch(() => '')
  })

  it('emits cursor-hint only after successful push commit, with heartbeat', async () => {
    const controller = new AbortController()
    const res = await fetch(`${baseUrl}/sync/subscribe?cursor=0`, {
      headers: {
        Authorization: `Bearer ${relayToken}`,
        Accept: 'text/event-stream',
        'x-sync-device-code': codeA,
        'x-sync-device-secret': secretA
      },
      signal: controller.signal
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type') ?? '').toContain('text/event-stream')
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const readChunk = async (timeoutMs: number): Promise<string | null> => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const { done, value } = await reader.read()
        if (done) return null
        buffer += decoder.decode(value, { stream: true })
        if (buffer.includes('\n\n')) {
          const out = buffer
          buffer = ''
          return out
        }
      }
      return null
    }
    // Initial connected comment (no operations).
    const first = await readChunk(5000)
    expect(first).not.toBeNull()
    expect(first!).toContain(': connected')
    expect(first!).not.toContain('operations')
    // Successful push emits exactly a cursor hint with no operation payload.
    const pushRes = await fetch(`${baseUrl}/sync/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${relayToken}`,
        'x-sync-device-code': codeA,
        'x-sync-device-secret': secretA
      },
      body: JSON.stringify({ deviceId: 'd1', operations: [validOp('sse-op-1', 1)] })
    })
    expect(pushRes.status).toBe(200)
    const hint = await readChunk(5000)
    expect(hint).not.toBeNull()
    expect(hint!).toContain('event: sync')
    expect(hint!).toContain('"cursor"')
    expect(hint!).not.toContain('operations')
    expect(hint!).not.toContain('sse-op-1')
    controller.abort()
    try {
      await reader.cancel()
    } catch {}
  })
})

describe('SSE hint parser', () => {
  it('ignores comments, non-sync events, and malformed frames', async () => {
    const { parseSseCursorHints } = await import('../syncSubscriber')
    const buf =
      ': connected\n\n: heartbeat\n\nevent: sync\ndata: {"cursor": 7}\n\nevent: other\ndata: {"cursor": 99}\n\nevent: sync\ndata: not-json\n\nevent: sync\ndata: {"cursor": -1}\n\nevent: sync\ndata: {"cursor": 8, "operations": []}\n\npartial'
    const { hints, rest } = parseSseCursorHints(buf)
    // Negative cursor dropped; operations key ignored (hint still valid).
    expect(hints).toEqual([7, 8])
    expect(rest).toBe('partial')
  })
})

describe('auto coalescing vs manual semantics', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces concurrent automatic work instead of failing already-in-progress', async () => {
    vi.useFakeTimers()
    const { SyncAutoService } = await import('../syncAuto')
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const svc = new SyncAutoService({
      getConfig: () => ({ endpoint: 'http://127.0.0.1:9', token: 't', enabled: true }),
      isAttached: () => true,
      getCredentials: () => ({
        deviceCode: 'ABCD2345',
        deviceSecret: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
      }),
      runSync: async () => {
        calls += 1
        if (calls === 1) await gate
        return { ok: true }
      },
      createSubscriber: () =>
        ({
          start: () => {},
          stop: () => {},
          isActive: () => false
        }) as never
    })
    // Avoid real network subscriber: start registers config + dummy subscriber.
    svc.start()
    svc.notifyRemote()
    // Remote debounce is 200ms; advance past it to start the first cycle.
    await vi.advanceTimersByTimeAsync(250)
    // While the first cycle is gated, two more triggers must coalesce.
    svc.notifyRemote()
    svc.notifyLocalChange()
    await vi.advanceTimersByTimeAsync(900)
    expect(calls).toBe(1)
    release()
    // Let the coalesced second cycle run.
    await vi.advanceTimersByTimeAsync(1000)
    // Microtask drain for the async loop.
    await Promise.resolve()
    expect(calls).toBe(2)
    svc.stopSync()
  })

  it('refresh on (re)connect triggers a strict pull cycle without manual action', async () => {
    const { SyncAutoService } = await import('../syncAuto')
    let calls = 0
    const svc = new SyncAutoService({
      getConfig: () => ({ endpoint: 'http://127.0.0.1:9', token: 't', enabled: true }),
      isAttached: () => true,
      getCredentials: () => ({
        deviceCode: 'ABCD2345',
        deviceSecret: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
      }),
      runSync: async () => {
        calls += 1
        return { ok: true }
      },
      createSubscriber: () =>
        ({
          start: () => {},
          stop: () => {},
          isActive: () => false
        }) as never
    })
    svc.start()
    // Initial connect pulls once; a second refresh (reconnect) pulls again.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(calls).toBe(1)
    svc.refresh()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(calls).toBe(2)
    svc.stopSync()
  })

  it('manual sync() still throws already-in-progress when busy', async () => {
    const { syncService } = await import('../SyncService')
    const original = (syncService as unknown as { statusSyncing: boolean }).statusSyncing
    ;(syncService as unknown as { statusSyncing: boolean }).statusSyncing = true
    try {
      await expect(syncService.sync()).rejects.toThrow('already in progress')
    } finally {
      ;(syncService as unknown as { statusSyncing: boolean }).statusSyncing = false
      void original
    }
  })

  it('enqueue listener fires on insert but not on duplicate', async () => {
    const DatabaseCtor = (await import('better-sqlite3')).default
    const { drizzle } = await import('drizzle-orm/better-sqlite3')
    const { chatDbService } = await import('../../chatDb')
    const { runMigrations } = await import('../../chatDb/migration')
    const schema = await import('../../chatDb/schema')
    const { syncService } = await import('../SyncService')
    const sqlite = new DatabaseCtor(':memory:')
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    const db = drizzle(sqlite, { schema })
    runMigrations(db as any, sqlite)
    ;(chatDbService as unknown as { sqlite: unknown }).sqlite = sqlite
    ;(chatDbService as unknown as { db: unknown }).db = db
    syncService.clearAllForTests()
    let fires = 0
    const unsub = syncService.onEnqueue(() => {
      fires += 1
    })
    try {
      const op = {
        id: 'rt-enq-1',
        entityType: 'topic' as const,
        op: 'upsert' as const,
        entityId: 't-rt-enq',
        timestamp: Date.now(),
        deviceId: 'd1',
        payload: { id: 't-rt-enq', name: 'R' }
      }
      syncService.enqueueOperation(op as any)
      expect(fires).toBe(1)
      syncService.enqueueOperation(op as any)
      expect(fires).toBe(1)
    } finally {
      unsub()
      try {
        sqlite.close()
      } catch {}
      ;(chatDbService as unknown as { sqlite: unknown }).sqlite = null
      ;(chatDbService as unknown as { db: unknown }).db = null
    }
  })
})

describe('relay idempotent push acknowledgement', () => {
  let db: Database.Database
  let server: ReturnType<typeof createRelayServer>
  let baseUrl: string
  const token = 'idem-token-1'
  let codeA = ''
  let secretA = ''

  beforeAll(async () => {
    const { createRelayServer } = await import('../../../../../scripts/sync-relay/server')
    db = new Database(':memory:')
    const { ensureRelaySchema } = await import('../../../../../scripts/sync-relay/server')
    ensureRelaySchema(db)
    server = createRelayServer(db, { token })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }
    baseUrl = `http://127.0.0.1:${addr.port}`
    const authed = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const regA = (await (
      await fetch(`${baseUrl}/sync/register`, {
        method: 'POST',
        headers: authed,
        body: JSON.stringify({ deviceId: 'd1' })
      })
    ).json()) as { deviceCode: string; deviceSecret: string }
    const regB = (await (
      await fetch(`${baseUrl}/sync/register`, {
        method: 'POST',
        headers: authed,
        body: JSON.stringify({ deviceId: 'd2' })
      })
    ).json()) as { deviceCode: string; deviceSecret: string }
    codeA = regA.deviceCode
    secretA = regA.deviceSecret
    const req = (await (
      await fetch(`${baseUrl}/sync/pair/request`, {
        method: 'POST',
        headers: { ...authed, 'x-sync-device-code': regB.deviceCode, 'x-sync-device-secret': regB.deviceSecret },
        body: JSON.stringify({ targetCode: codeA })
      })
    ).json()) as { requestId: string }
    const accept = await fetch(`${baseUrl}/sync/pair/accept`, {
      method: 'POST',
      headers: { ...authed, 'x-sync-device-code': codeA, 'x-sync-device-secret': secretA },
      body: JSON.stringify({ requestId: req.requestId })
    })
    expect(accept.status).toBe(200)
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    try {
      db.close()
    } catch {}
  })

  const push = async (ops: Record<string, unknown>[]): Promise<Response> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-sync-device-code': codeA,
      'x-sync-device-secret': secretA
    }
    const res = await fetch(`${baseUrl}/sync/push`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ deviceId: 'd1', operations: ops })
    })
    return res
  }

  it('replays identical lost-push-response without stranding (same ack, no seq growth)', async () => {
    const op = validOp('idem-op-1', 11)
    const first = await push([op])
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as { acceptedIds: string[]; cursor: number }
    expect(firstBody.acceptedIds).toEqual(['idem-op-1'])
    // Lost response replay: identical retry proves presence and is accepted.
    const second = await push([op])
    expect(second.status).toBe(200)
    const secondBody = (await second.json()) as { acceptedIds: string[]; cursor: number }
    expect(secondBody.acceptedIds).toEqual(['idem-op-1'])
    expect(secondBody.cursor).toBe(firstBody.cursor)
  })

  it('rejects mismatched ID collision without accepting', async () => {
    const op = validOp('idem-op-collide', 12)
    const first = await push([op])
    expect(first.status).toBe(200)
    const colliding = { ...op, entityId: 't-other', payload: { id: 't-other', name: 'X' } }
    const second = await push([colliding])
    expect(second.status).toBe(409)
    const body = (await second.json()) as { error: string }
    expect(body.error).toMatch(/collision/)
  })
})

describe('SyncService clears only confirmed current-chunk IDs', () => {
  it('lost-push-response replay clears retained outbox instead of stranding', async () => {
    vi.useRealTimers()
    const DatabaseCtor = (await import('better-sqlite3')).default
    const { drizzle } = await import('drizzle-orm/better-sqlite3')
    const { chatDbService } = await import('../../chatDb')
    const { runMigrations } = await import('../../chatDb/migration')
    const { syncService } = await import('../SyncService')
    const { syncClient } = await import('../SyncClient')
    const { eq } = await import('drizzle-orm')
    const schema = await import('../../chatDb/schema')
    const sqlite = new DatabaseCtor(':memory:')
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    const db = drizzle(sqlite, { schema })
    runMigrations(db as any, sqlite)
    ;(chatDbService as unknown as { sqlite: unknown }).sqlite = sqlite
    ;(chatDbService as unknown as { db: unknown }).db = db
    const configStore = new Map<string, unknown>()
    const { configManager } = await import('../../ConfigManager')
    const origGet = configManager.get.bind(configManager)
    const origSet = configManager.set.bind(configManager)
    vi.spyOn(configManager, 'get').mockImplementation(((k: string, def?: unknown) => {
      if (k === 'sync:endpoint') return 'http://127.0.0.1:9'
      if (k === 'sync:token') return ''
      if (k === 'sync:enabled') return true
      if (k === 'sync:deviceCode') return 'ABCD2345'
      if (k === 'sync:deviceAuth') return 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
      return origGet(k as never, def as never)
    }) as never)
    vi.spyOn(configManager, 'set').mockImplementation(((k: string, v: unknown) => {
      configStore.set(k, v)
      return origSet(k as never, v as never)
    }) as never)
    try {
      syncService.clearAllForTests()
      syncService.enqueueOperation({
        id: 'replay-op-1',
        entityType: 'topic',
        op: 'upsert',
        entityId: 't-replay',
        timestamp: Date.now(),
        deviceId: 'd1',
        payload: { id: 't-replay', name: 'R' }
      } as any)
      expect(syncService.listOutbox().length).toBe(1)
      // Idempotent relay replay: same chunk IDs proven present.
      const pushSpy = vi.spyOn(syncClient, 'push').mockResolvedValue({ acceptedIds: ['replay-op-1'], cursor: 1 })
      const pullSpy = vi.spyOn(syncClient, 'pull').mockResolvedValue({ operations: [], cursor: 0 } as never)
      await syncService.sync()
      expect(syncService.listOutbox().length).toBe(0)
      const cursorRow = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
      // Empty pull leaves no durable cursor row; effective cursor is still 0.
      expect(cursorRow?.value ?? '0').toBe('0')
      pushSpy.mockRestore()
      pullSpy.mockRestore()
    } finally {
      vi.restoreAllMocks()
      try {
        sqlite.close()
      } catch {}
      ;(chatDbService as unknown as { sqlite: unknown }).sqlite = null
      ;(chatDbService as unknown as { db: unknown }).db = null
      void configStore
    }
  })
})

describe('SSE CRLF framing', () => {
  it('parses CRLF-delimited hints identically to LF', async () => {
    const { parseSseCursorHints } = await import('../syncSubscriber')
    const crlf =
      ': connected\r\n\r\n: heartbeat\r\n\r\nevent: sync\r\ndata: {"cursor": 21}\r\n\r\nevent: sync\r\ndata: {"cursor": 22}\r\n\r\npartial'
    const { hints, rest } = parseSseCursorHints(crlf)
    expect(hints).toEqual([21, 22])
    expect(rest).toBe('partial')
  })

  it('parses mixed LF/CRLF chunk boundaries across appends', async () => {
    const { parseSseCursorHints } = await import('../syncSubscriber')
    const first = parseSseCursorHints('event: sync\r\ndata: {"cursor": 5}\r\n')
    expect(first.hints).toEqual([])
    const second = parseSseCursorHints(`${first.rest}\r\n`)
    expect(second.hints).toEqual([5])
  })
})

describe('endpoint transport security', () => {
  it('accepts http and https for loopback and non-loopback hosts with a warning predicate for plaintext LAN', async () => {
    const shared = await import('../../../../../packages/shared/sync/endpoint')
    // Both transports are accepted everywhere; plaintext non-loopback HTTP
    // is an explicit supported transport with a visible UI warning.
    expect(shared.validateSyncEndpointUrl('http://example.com')).toBeNull()
    expect(shared.validateSyncEndpointUrl('http://192.168.1.10:3000')).toBeNull()
    expect(shared.validateSyncEndpointUrl('http://localhost:3000')).toBeNull()
    expect(shared.validateSyncEndpointUrl('http://127.0.0.1:3030')).toBeNull()
    expect(shared.validateSyncEndpointUrl('http://[::1]:3030')).toBeNull()
    expect(shared.validateSyncEndpointUrl('https://example.com')).toBeNull()
    expect(shared.validateSyncEndpointUrl('https://192.168.1.10/sync')).toBeNull()
    expect(shared.validateSyncEndpointUrl('ftp://example.com')).not.toBeNull()
    expect(shared.validateSyncEndpointUrl('not-a-url')).not.toBeNull()
    // Malformed authority forms without an explicit http(s):// prefix fail.
    expect(shared.validateSyncEndpointUrl('http:example.com')).not.toBeNull()
    expect(shared.validateSyncEndpointUrl('http:///example.com')).not.toBeNull()
    expect(shared.validateSyncEndpointUrl('HTTP://192.168.1.10:3000')).toBeNull()
    // Warning predicate: only non-loopback http warns; loopback http,
    // https, malformed, and invalid input never warn.
    expect(shared.isNonLoopbackHttpEndpoint('http://192.168.1.10:3000')).toBe(true)
    expect(shared.isNonLoopbackHttpEndpoint('http://example.com')).toBe(true)
    expect(shared.isNonLoopbackHttpEndpoint('http://localhost:3000')).toBe(false)
    expect(shared.isNonLoopbackHttpEndpoint('http://127.0.0.1:3030')).toBe(false)
    expect(shared.isNonLoopbackHttpEndpoint('http://[::1]:3030')).toBe(false)
    expect(shared.isNonLoopbackHttpEndpoint('https://192.168.1.10:3000')).toBe(false)
    expect(shared.isNonLoopbackHttpEndpoint('https://example.com')).toBe(false)
    expect(shared.isNonLoopbackHttpEndpoint('http:example.com')).toBe(false)
    expect(shared.isNonLoopbackHttpEndpoint('http:///example.com')).toBe(false)
    expect(shared.isNonLoopbackHttpEndpoint('not-a-url')).toBe(false)
    expect(shared.isNonLoopbackHttpEndpoint('')).toBe(false)
    const { validateEndpointUrl } = await import('../SyncClient')
    expect(validateEndpointUrl('http://192.168.1.10:3030')).toBeNull()
    expect(validateEndpointUrl('http://127.0.0.1:3030')).toBeNull()
    expect(validateEndpointUrl('https://192.168.1.10:3030')).toBeNull()
    expect(validateEndpointUrl('http:example.com')).not.toBeNull()
    expect(validateEndpointUrl('http:///example.com')).not.toBeNull()
  })
})

describe('auto bounded retry with active subscriber', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries transient pull/push failures with backoff then succeeds', async () => {
    vi.useFakeTimers()
    const { SyncAutoService, SYNC_AUTO_RETRY_MAX_ATTEMPTS } = await import('../syncAuto')
    let calls = 0
    const svc = new SyncAutoService({
      getConfig: () => ({ endpoint: 'http://127.0.0.1:9', token: 't', enabled: true }),
      isAttached: () => true,
      getCredentials: () => ({
        deviceCode: 'ABCD2345',
        deviceSecret: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
      }),
      runSync: async () => {
        calls += 1
        if (calls <= 2) throw new Error('pull failed 500: transient')
        return { ok: true }
      },
      createSubscriber: () => ({ start: () => {}, stop: () => {}, isActive: () => true }) as never
    })
    svc.start()
    // Initial (re)connect cycle fails transiently, then bounded retries run.
    // First retry delay is 1000ms, second is 2000ms.
    await vi.advanceTimersByTimeAsync(1100)
    expect(calls).toBeGreaterThanOrEqual(2)
    await vi.advanceTimersByTimeAsync(2500)
    expect(calls).toBe(3)
    expect(SYNC_AUTO_RETRY_MAX_ATTEMPTS).toBeGreaterThanOrEqual(2)
    svc.stopSync()
  })

  it('gives up after bounded attempts and stays truthful', async () => {
    vi.useFakeTimers()
    const { SyncAutoService, SYNC_AUTO_RETRY_MAX_ATTEMPTS } = await import('../syncAuto')
    let calls = 0
    const svc = new SyncAutoService({
      getConfig: () => ({ endpoint: 'http://127.0.0.1:9', token: 't', enabled: true }),
      isAttached: () => true,
      getCredentials: () => ({
        deviceCode: 'ABCD2345',
        deviceSecret: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
      }),
      runSync: async () => {
        calls += 1
        throw new Error('push failed: network down')
      },
      createSubscriber: () => ({ start: () => {}, stop: () => {}, isActive: () => true }) as never
    })
    svc.start()
    // Initial cycle + bounded retries only (stay below the 30s
    // reconciliation interval so the count proves the retry bound alone).
    await vi.advanceTimersByTimeAsync(20000)
    expect(calls).toBe(1 + SYNC_AUTO_RETRY_MAX_ATTEMPTS)
    svc.stopSync()
  })
})

describe('auto cancellation and reconciliation lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stop during in-flight work prevents continuation after close', async () => {
    const { SyncAutoService } = await import('../syncAuto')
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const svc = new SyncAutoService({
      getConfig: () => ({ endpoint: 'http://127.0.0.1:9', token: 't', enabled: true }),
      isAttached: () => true,
      getCredentials: () => ({
        deviceCode: 'ABCD2345',
        deviceSecret: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
      }),
      runSync: async () => {
        calls += 1
        await gate
        return { ok: true }
      },
      createSubscriber: () => ({ start: () => {}, stop: () => {}, isActive: () => false }) as never
    })
    svc.start()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls).toBe(1)
    svc.stopSync()
    release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    // No post-stop continuation: exactly the in-flight cycle, no retry/follow-up.
    expect(calls).toBe(1)
    expect(svc.isAutoRunning()).toBe(false)
  })

  it('reconciliation triggers the strict cycle and stops without leak', async () => {
    vi.useFakeTimers()
    const { SyncAutoService, SYNC_AUTO_RECONCILE_MS } = await import('../syncAuto')
    expect(SYNC_AUTO_RECONCILE_MS).toBeGreaterThanOrEqual(15000)
    let calls = 0
    const svc = new SyncAutoService({
      getConfig: () => ({ endpoint: 'http://127.0.0.1:9', token: 't', enabled: true }),
      isAttached: () => true,
      getCredentials: () => ({
        deviceCode: 'ABCD2345',
        deviceSecret: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
      }),
      runSync: async () => {
        calls += 1
        return { ok: true }
      },
      createSubscriber: () => ({ start: () => {}, stop: () => {}, isActive: () => true }) as never
    })
    svc.start()
    // Initial (re)connect cycle.
    await vi.advanceTimersByTimeAsync(10)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(SYNC_AUTO_RECONCILE_MS)
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(SYNC_AUTO_RECONCILE_MS)
    expect(calls).toBe(3)
    const atStop = calls
    svc.stopSync()
    await vi.advanceTimersByTimeAsync(SYNC_AUTO_RECONCILE_MS * 2)
    expect(calls).toBe(atStop)
  })

  it('disabled config starts no reconciliation timer', async () => {
    vi.useFakeTimers()
    const { SyncAutoService } = await import('../syncAuto')
    let calls = 0
    const svc = new SyncAutoService({
      getConfig: () => ({ endpoint: '', token: undefined, enabled: false }),
      isAttached: () => true,
      getCredentials: () => ({
        deviceCode: 'ABCD2345',
        deviceSecret: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
      }),
      runSync: async () => {
        calls += 1
        return { ok: true }
      },
      createSubscriber: () => ({ start: () => {}, stop: () => {}, isActive: () => false }) as never
    })
    svc.start()
    await vi.advanceTimersByTimeAsync(120000)
    expect(calls).toBe(0)
    svc.stopSync()
  })
})
