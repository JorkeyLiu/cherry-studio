/**
 * Conservative baseline auto-publish policy:
 * - Only local-enqueue-triggered auto-sync attempts one publish after an
 *   ordinary `sync()` success; remote/reconnect/reconcile/manual never PUT.
 * - Merged local+remote in one drain publishes at most once.
 * - Sync failure retains intent; ineligible skips consume without PUT;
 *   409/other failures defer without failing the op-log sync or tight retry.
 * - Epoch guard retains a newer local trigger arriving during the PUT barrier.
 * - stop/invalidate clears the in-memory intent with no new timer.
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
    set: (k: string, v: unknown) => configStore.set(k, v)
  },
  ConfigKeys: {}
}))

import { chatDbService } from '../../chatDb'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { syncClient } from '../SyncClient'
import { syncService } from '../SyncService'
import { seedRegisteredAttachedSyncService } from './helpers/syncTestRegistration'

const ENDPOINT = 'http://127.0.0.1:9999'
const CHANNEL = 'ch-auto-pub'
const CURSOR_N = 5
const CODE = 'ABCD2345'
const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

function bindChannel(channelId: string): void {
  db.insert(schema.syncState)
    .values({ key: 'sync:channelKey', value: channelId })
    .onConflictDoUpdate({ target: schema.syncState.key, set: { value: channelId } })
    .run()
}

function setCursor(n: number): void {
  db.insert(schema.syncState)
    .values({ key: 'cursor', value: String(n) })
    .onConflictDoUpdate({ target: schema.syncState.key, set: { value: String(n) } })
    .run()
}

function readCursor(): number {
  const row = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
  return row ? Number(row.value) : 0
}

function readLastError(): string | null {
  const row = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastError')).get()
  return (row?.value as string | null) ?? null
}

function seedPublishableTopic(topicId = 'auto-pub-topic-1', ts = 7, op = 'aupub7'): void {
  sqlite
    .prepare('INSERT INTO topics (id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?)')
    .run(
      topicId,
      `Topic ${topicId}`,
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      null,
      JSON.stringify({ pinned: true, prompt: 'keep', isNameManuallyEdited: false })
    )
  db.insert(schema.syncEntityClock)
    .values({ entityType: 'topic', entityId: topicId, timestamp: ts, operationId: op })
    .run()
  for (const f of [
    'name',
    'assistantId',
    'createdAt',
    'updatedAt',
    'deletedAt',
    'pinned',
    'prompt',
    'isNameManuallyEdited'
  ]) {
    db.insert(schema.syncFieldClock)
      .values({ entityType: 'topic', entityId: topicId, field: f, timestamp: ts, operationId: op })
      .run()
  }
  db.insert(schema.syncParentOrderFrame)
    .values({
      kind: 'topicMessage',
      parentId: topicId,
      frameVersion: 'parent-order-frame-v1',
      orderedChildIdsJson: '[]',
      timestamp: ts,
      operationId: op
    })
    .run()
}

function validDeps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    getConfig: () => ({ endpoint: ENDPOINT, token: undefined, enabled: true }),
    isAttached: () => true,
    getCredentials: () => ({ deviceCode: CODE, deviceSecret: SECRET }),
    createSubscriber: () => ({ start: vi.fn(), stop: vi.fn() }) as never,
    ...overrides
  }
}

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', ENDPOINT)
  configStore.set('sync:token', '')
  sqlite = openInMemory()
  db = drizzle(sqlite, { schema })
  runMigrations(db as never, sqlite)
  ;(chatDbService as unknown as { sqlite: unknown }).sqlite = sqlite
  ;(chatDbService as unknown as { db: unknown }).db = db
  syncService.clearAllForTests()
  syncService.resetShutdownForTests()
  seedRegisteredAttachedSyncService(configStore, db)
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  try {
    sqlite.close()
  } catch {}
  ;(chatDbService as unknown as { sqlite: unknown }).sqlite = null
  ;(chatDbService as unknown as { db: unknown }).db = null
})

describe('syncAuto local intent state machine', () => {
  it('local trigger -> sync success -> single publish attempt, then intent consumed', async () => {
    vi.useFakeTimers()
    const { SyncAutoService } = await import('../syncAuto')
    const runSync = vi.fn(async () => ({ ok: true }))
    const tryPublish = vi.fn(async () => ({ kind: 'published', watermark: 5, digest: 'd', channelId: 'c' }) as never)
    const svc = new SyncAutoService(validDeps({ runSync, tryPublishBaseline: tryPublish }) as never)
    svc.start()
    await vi.advanceTimersByTimeAsync(50)
    expect(runSync).toHaveBeenCalledTimes(1)
    expect(tryPublish).not.toHaveBeenCalled()
    runSync.mockClear()
    svc.notifyLocalChange()
    expect(svc.hasLocalPublishIntentForTests()).toBe(true)
    await vi.advanceTimersByTimeAsync(900)
    await vi.advanceTimersByTimeAsync(50)
    expect(runSync).toHaveBeenCalledTimes(1)
    expect(tryPublish).toHaveBeenCalledTimes(1)
    expect(svc.hasLocalPublishIntentForTests()).toBe(false)
    svc.stopSync()
  })

  it('remote-only trigger never publishes', async () => {
    vi.useFakeTimers()
    const { SyncAutoService } = await import('../syncAuto')
    const runSync = vi.fn(async () => ({ ok: true }))
    const tryPublish = vi.fn(async () => ({ kind: 'published', watermark: 5, digest: 'd', channelId: 'c' }) as never)
    const svc = new SyncAutoService(validDeps({ runSync, tryPublishBaseline: tryPublish }) as never)
    svc.start()
    await vi.advanceTimersByTimeAsync(50)
    runSync.mockClear()
    svc.notifyRemote()
    await vi.advanceTimersByTimeAsync(300)
    await vi.advanceTimersByTimeAsync(50)
    expect(runSync).toHaveBeenCalledTimes(1)
    expect(tryPublish).not.toHaveBeenCalled()
    expect(svc.hasLocalPublishIntentForTests()).toBe(false)
    svc.stopSync()
  })

  it('reconcile-only trigger never publishes', async () => {
    vi.useFakeTimers()
    const { SyncAutoService } = await import('../syncAuto')
    const runSync = vi.fn(async () => ({ ok: true }))
    const tryPublish = vi.fn(async () => ({ kind: 'published', watermark: 5, digest: 'd', channelId: 'c' }) as never)
    const svc = new SyncAutoService(validDeps({ runSync, tryPublishBaseline: tryPublish }) as never)
    svc.start()
    await vi.advanceTimersByTimeAsync(50)
    runSync.mockClear()
    await vi.advanceTimersByTimeAsync(30000)
    await vi.advanceTimersByTimeAsync(50)
    expect(runSync).toHaveBeenCalled()
    expect(tryPublish).not.toHaveBeenCalled()
    svc.stopSync()
  })

  it('reconnect refresh without local intent never publishes', async () => {
    vi.useFakeTimers()
    const { SyncAutoService } = await import('../syncAuto')
    const runSync = vi.fn(async () => ({ ok: true }))
    const tryPublish = vi.fn(async () => ({ kind: 'published', watermark: 5, digest: 'd', channelId: 'c' }) as never)
    const svc = new SyncAutoService(validDeps({ runSync, tryPublishBaseline: tryPublish }) as never)
    svc.start()
    await vi.advanceTimersByTimeAsync(50)
    runSync.mockClear()
    svc.refresh()
    await vi.advanceTimersByTimeAsync(50)
    expect(runSync).toHaveBeenCalled()
    expect(tryPublish).not.toHaveBeenCalled()
    svc.stopSync()
  })

  it('merged local+remote in one drain publishes at most once', async () => {
    vi.useFakeTimers()
    const { SyncAutoService } = await import('../syncAuto')
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runSync = vi.fn(async () => {
      calls += 1
      if (calls === 1) await gate
      return { ok: true }
    })
    const tryPublish = vi.fn(async () => ({ kind: 'published', watermark: 5, digest: 'd', channelId: 'c' }) as never)
    const svc = new SyncAutoService(validDeps({ runSync, tryPublishBaseline: tryPublish }) as never)
    svc.start()
    await vi.advanceTimersByTimeAsync(50)
    expect(calls).toBe(1)
    release()
    await vi.advanceTimersByTimeAsync(50)
    runSync.mockClear()
    tryPublish.mockClear()
    calls = 0
    // New drain: local + remote merged while the first cycle is gated.
    let release2!: () => void
    const gate2 = new Promise<void>((resolve) => {
      release2 = resolve
    })
    runSync.mockImplementation(async () => {
      calls += 1
      if (calls === 1) await gate2
      return { ok: true }
    })
    svc.notifyRemote()
    svc.notifyLocalChange()
    await vi.advanceTimersByTimeAsync(900)
    expect(calls).toBe(1)
    // Second trigger during the gated cycle coalesces.
    svc.notifyRemote()
    await vi.advanceTimersByTimeAsync(900)
    expect(calls).toBe(1)
    release2()
    await vi.advanceTimersByTimeAsync(100)
    expect(tryPublish).toHaveBeenCalledTimes(1)
    svc.stopSync()
  })

  it('sync failure retains intent; next success publishes without extra retry', async () => {
    vi.useFakeTimers()
    const { SyncAutoService } = await import('../syncAuto')
    let attempt = 0
    const runSync = vi.fn(async () => {
      attempt += 1
      if (attempt === 2) throw new Error('transport boom')
      return { ok: true }
    })
    const tryPublish = vi.fn(async () => ({ kind: 'published', watermark: 5, digest: 'd', channelId: 'c' }) as never)
    const svc = new SyncAutoService(validDeps({ runSync, tryPublishBaseline: tryPublish }) as never)
    svc.start()
    await vi.advanceTimersByTimeAsync(50)
    runSync.mockClear()
    tryPublish.mockClear()
    attempt = 1
    svc.notifyLocalChange()
    await vi.advanceTimersByTimeAsync(900)
    await vi.advanceTimersByTimeAsync(50)
    // First post-start cycle fails: no publish, intent retained.
    expect(tryPublish).not.toHaveBeenCalled()
    expect(svc.hasLocalPublishIntentForTests()).toBe(true)
    // Existing bounded retry drives the next attempt (1000ms backoff).
    await vi.advanceTimersByTimeAsync(1500)
    await vi.advanceTimersByTimeAsync(50)
    expect(tryPublish).toHaveBeenCalledTimes(1)
    expect(svc.hasLocalPublishIntentForTests()).toBe(false)
    svc.stopSync()
  })

  it('deferred publish (409/conflict) consumes intent without failing sync or tight retry', async () => {
    vi.useFakeTimers()
    const { SyncAutoService } = await import('../syncAuto')
    const runSync = vi.fn(async () => ({ ok: true }))
    const tryPublish = vi.fn(async () => ({ kind: 'deferred', reason: 'conflict', detail: '409' }) as never)
    const svc = new SyncAutoService(validDeps({ runSync, tryPublishBaseline: tryPublish }) as never)
    svc.start()
    await vi.advanceTimersByTimeAsync(50)
    runSync.mockClear()
    svc.notifyLocalChange()
    await vi.advanceTimersByTimeAsync(900)
    await vi.advanceTimersByTimeAsync(50)
    expect(runSync).toHaveBeenCalledTimes(1)
    expect(tryPublish).toHaveBeenCalledTimes(1)
    expect(svc.hasLocalPublishIntentForTests()).toBe(false)
    // No tight retry: no second sync cycle without a new trigger.
    await vi.advanceTimersByTimeAsync(5000)
    expect(runSync).toHaveBeenCalledTimes(1)
    svc.stopSync()
  })

  it('skipped publish consumes intent without PUT semantics', async () => {
    vi.useFakeTimers()
    const { SyncAutoService } = await import('../syncAuto')
    const runSync = vi.fn(async () => ({ ok: true }))
    const tryPublish = vi.fn(async () => ({ kind: 'skipped', reason: 'watermark-zero', detail: 'N==0' }) as never)
    const svc = new SyncAutoService(validDeps({ runSync, tryPublishBaseline: tryPublish }) as never)
    svc.start()
    await vi.advanceTimersByTimeAsync(50)
    runSync.mockClear()
    svc.notifyLocalChange()
    await vi.advanceTimersByTimeAsync(900)
    await vi.advanceTimersByTimeAsync(50)
    expect(tryPublish).toHaveBeenCalledTimes(1)
    expect(svc.hasLocalPublishIntentForTests()).toBe(false)
    svc.stopSync()
  })

  it('new local trigger during publish is not cleared by the older attempt', async () => {
    vi.useFakeTimers()
    const { SyncAutoService } = await import('../syncAuto')
    const runSync = vi.fn(async () => ({ ok: true }))
    const svcRef: { current: unknown } = { current: null }
    const tryPublish = vi.fn(async () => {
      const svc = svcRef.current as { notifyLocalChange: () => void }
      svc.notifyLocalChange()
      return { kind: 'published', watermark: 5, digest: 'd', channelId: 'c' } as never
    })
    const svc = new SyncAutoService(validDeps({ runSync, tryPublishBaseline: tryPublish }) as never)
    svcRef.current = svc
    svc.start()
    await vi.advanceTimersByTimeAsync(50)
    runSync.mockClear()
    tryPublish.mockClear()
    // Clear the start-up intent state, then set one round intent.
    svc.notifyLocalChange()
    // Reset the seq observation by consuming the pre-publish debounce first.
    await vi.advanceTimersByTimeAsync(900)
    await vi.advanceTimersByTimeAsync(50)
    expect(tryPublish).toHaveBeenCalledTimes(1)
    // The in-publish trigger set a newer seq: intent must be retained.
    expect(svc.hasLocalPublishIntentForTests()).toBe(true)
    svc.stopSync()
  })

  it('stop/start clears intent and timers without leaking further work', async () => {
    vi.useFakeTimers()
    const { SyncAutoService } = await import('../syncAuto')
    const runSync = vi.fn(async () => ({ ok: true }))
    const tryPublish = vi.fn(async () => ({ kind: 'published', watermark: 5, digest: 'd', channelId: 'c' }) as never)
    const svc = new SyncAutoService(validDeps({ runSync, tryPublishBaseline: tryPublish }) as never)
    svc.start()
    await vi.advanceTimersByTimeAsync(50)
    runSync.mockClear()
    svc.notifyLocalChange()
    expect(svc.hasLocalPublishIntentForTests()).toBe(true)
    svc.stopSync()
    expect(svc.hasLocalPublishIntentForTests()).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(runSync).not.toHaveBeenCalled()
    expect(tryPublish).not.toHaveBeenCalled()
    // Restart does not resurrect the old intent.
    const svc2 = new SyncAutoService(validDeps({ runSync, tryPublishBaseline: tryPublish }) as never)
    svc2.start()
    await vi.advanceTimersByTimeAsync(50)
    expect(tryPublish).not.toHaveBeenCalled()
    svc2.stopSync()
    svc.stopSync()
  })
})

describe('publishBaselineIfEligible production eligibility', () => {
  function mockEmptyPull(): void {
    vi.spyOn(syncClient, 'pull').mockImplementation(async () => ({ operations: [], cursor: CURSOR_N }) as never)
  }

  it('eligible complete N>0 publishes once via the strict barrier', async () => {
    bindChannel(CHANNEL)
    setCursor(CURSOR_N)
    seedPublishableTopic()
    mockEmptyPull()
    let puts = 0
    vi.spyOn(syncClient, 'publishBaseline').mockImplementation(async (_e, _t, envelope) => {
      puts += 1
      const raw = JSON.stringify(envelope)
      const { parseEnvelopeJson } = await import('@shared/sync')
      return { envelope: parseEnvelopeJson(raw), rawText: raw }
    })
    const res = await syncService.publishBaselineIfEligible()
    expect(res.kind).toBe('published')
    expect(puts).toBe(1)
    if (res.kind === 'published') {
      expect(res.watermark).toBe(CURSOR_N)
      expect(res.channelId).toBe(CHANNEL)
    }
    expect(readCursor()).toBe(CURSOR_N)
    expect(readLastError()).toBeNull()
  })

  it('unbound channel skips with no PUT and no error status', async () => {
    setCursor(CURSOR_N)
    seedPublishableTopic()
    const putMock = vi.spyOn(syncClient, 'publishBaseline')
    const res = await syncService.publishBaselineIfEligible()
    expect(res).toMatchObject({ kind: 'skipped', reason: 'unbound-channel' })
    expect(putMock).not.toHaveBeenCalled()
    expect(readLastError()).toBeNull()
  })

  it('watermark N==0 skips with no PUT and no error status', async () => {
    bindChannel(CHANNEL)
    setCursor(0)
    seedPublishableTopic()
    const putMock = vi.spyOn(syncClient, 'publishBaseline')
    const res = await syncService.publishBaselineIfEligible()
    expect(res).toMatchObject({ kind: 'skipped', reason: 'watermark-zero' })
    expect(putMock).not.toHaveBeenCalled()
    expect(readLastError()).toBeNull()
  })

  it('partial candidate skips with no PUT and no error status', async () => {
    bindChannel(CHANNEL)
    setCursor(CURSOR_N)
    seedPublishableTopic()
    sqlite
      .prepare(
        'INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run(
        'auto-unversioned-m',
        'auto-pub-topic-1',
        'user',
        'hello',
        'success',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        0
      )
    const putMock = vi.spyOn(syncClient, 'publishBaseline')
    const res = await syncService.publishBaselineIfEligible()
    expect(res).toMatchObject({ kind: 'skipped', reason: 'candidate-ineligible' })
    expect(putMock).not.toHaveBeenCalled()
    expect(readLastError()).toBeNull()
    expect(readCursor()).toBe(CURSOR_N)
  })

  it('outbox not drained returns needs-sync with no PUT (retains intent)', async () => {
    bindChannel(CHANNEL)
    setCursor(CURSOR_N)
    seedPublishableTopic()
    syncService.enqueueOperation({
      id: 'auto-outbox-1',
      entityType: 'topic',
      op: 'upsert',
      entityId: 'auto-pub-topic-1',
      timestamp: 1,
      deviceId: 'd1',
      payload: { id: 'auto-pub-topic-1', name: 'Local' }
    } as never)
    const putMock = vi.spyOn(syncClient, 'publishBaseline')
    const res = await syncService.publishBaselineIfEligible()
    expect(res).toMatchObject({ kind: 'needs-sync', reason: 'outbox-not-drained' })
    expect(putMock).not.toHaveBeenCalled()
  })

  it('busy barrier returns needs-sync with no PUT', async () => {
    bindChannel(CHANNEL)
    setCursor(CURSOR_N)
    seedPublishableTopic()
    ;(syncService as unknown as { statusSyncing: boolean }).statusSyncing = true
    try {
      const putMock = vi.spyOn(syncClient, 'publishBaseline')
      const res = await syncService.publishBaselineIfEligible()
      expect(res).toMatchObject({ kind: 'needs-sync', reason: 'busy' })
      expect(putMock).not.toHaveBeenCalled()
    } finally {
      ;(syncService as unknown as { statusSyncing: boolean }).statusSyncing = false
    }
  })

  it('409 conflict defers without throwing and keeps op-log sync truthful (no retry)', async () => {
    bindChannel(CHANNEL)
    setCursor(CURSOR_N)
    seedPublishableTopic()
    mockEmptyPull()
    const conflict = new Error('baseline publish failed 409: {"error":"baseline-conflict"}') as Error & {
      cause?: unknown
    }
    ;(conflict as { cause?: unknown }).cause = { status: 409 }
    vi.spyOn(syncClient, 'publishBaseline').mockRejectedValue(conflict)
    const res = await syncService.publishBaselineIfEligible()
    expect(res).toMatchObject({ kind: 'deferred', reason: 'conflict' })
    expect(readCursor()).toBe(CURSOR_N)
    expect(db.select().from(schema.syncOutbox).all()).toHaveLength(0)
    expect(readLastError()).toMatch(/409/)
  })

  it('400/transport failure defers without throwing and keeps cursor/outbox truthful', async () => {
    bindChannel(CHANNEL)
    setCursor(CURSOR_N)
    seedPublishableTopic()
    mockEmptyPull()
    const bad = new Error('baseline publish failed 400: {"error":"digest-mismatch"}') as Error & {
      cause?: unknown
    }
    ;(bad as { cause?: unknown }).cause = { status: 400 }
    vi.spyOn(syncClient, 'publishBaseline').mockRejectedValueOnce(bad)
    const first = await syncService.publishBaselineIfEligible()
    expect(first).toMatchObject({ kind: 'deferred', reason: 'publish-failed' })
    expect(readCursor()).toBe(CURSOR_N)
    expect(db.select().from(schema.syncOutbox).all()).toHaveLength(0)
    expect(readLastError()).toMatch(/400/)
    // No immediate re-capture/retry inside the method: exactly one PUT attempt.
    expect(vi.mocked(syncClient.publishBaseline)).toHaveBeenCalledTimes(1)
  })

  it('ordinary sync() success never PUTs by itself (manual path stays publish-free)', async () => {
    bindChannel(CHANNEL)
    setCursor(CURSOR_N)
    seedPublishableTopic()
    vi.spyOn(syncClient, 'fetchBaseline').mockResolvedValue({ found: false })
    vi.spyOn(syncClient, 'push').mockResolvedValue({ cursor: CURSOR_N, acceptedIds: [] } as never)
    vi.spyOn(syncClient, 'pull').mockResolvedValue({ operations: [], cursor: CURSOR_N } as never)
    const putMock = vi.spyOn(syncClient, 'publishBaseline')
    // Outbox empty: sync is pull-only success.
    await syncService.sync()
    expect(putMock).not.toHaveBeenCalled()
    expect(readLastError()).toBeNull()
  })

  it('finding-01: pre-check-to-entry preemption returns needs-sync/busy with no PUT and no lastError overwrite', async () => {
    bindChannel(CHANNEL)
    setCursor(CURSOR_N)
    seedPublishableTopic()
    expect(readLastError()).toBeNull()
    const putMock = vi.spyOn(syncClient, 'publishBaseline')
    // Real window control: initial busy check passes (flag false on entry),
    // then a concurrent sync wins inside the pre-check (listOutbox hook) and
    // holds `statusSyncing` when the barrier entry runs. Structured
    // `instanceof SyncBusyError` classification only — no message strings.
    const realListOutbox = syncService.listOutbox.bind(syncService)
    const listSpy = vi.spyOn(syncService, 'listOutbox').mockImplementation(() => {
      ;(syncService as unknown as { statusSyncing: boolean }).statusSyncing = true
      return realListOutbox()
    })
    let res: unknown
    try {
      res = await syncService.publishBaselineIfEligible()
    } finally {
      ;(syncService as unknown as { statusSyncing: boolean }).statusSyncing = false
      listSpy.mockRestore()
    }
    expect(res).toMatchObject({ kind: 'needs-sync', reason: 'busy' })
    expect(putMock).not.toHaveBeenCalled()
    expect(readLastError()).toBeNull()
    expect(readCursor()).toBe(CURSOR_N)
    expect(db.select().from(schema.syncOutbox).all()).toHaveLength(0)
  })

  it('finding-01: busy error is typed (no string matching) for both sync() and publishBaseline()', async () => {
    const { SyncBusyError } = await import('../SyncService')
    ;(syncService as unknown as { statusSyncing: boolean }).statusSyncing = true
    try {
      await expect(syncService.sync()).rejects.toBeInstanceOf(SyncBusyError)
      await expect(syncService.publishBaseline()).rejects.toBeInstanceOf(SyncBusyError)
      await expect(syncService.sync()).rejects.toThrow(/already in progress/)
    } finally {
      ;(syncService as unknown as { statusSyncing: boolean }).statusSyncing = false
    }
  })
})

describe('finding-01: busy retain has no tight retry and next schedule publishes once', () => {
  it('needs-sync retains intent; next scheduled success publishes at most once', async () => {
    vi.useFakeTimers()
    const { SyncAutoService } = await import('../syncAuto')
    const runSync = vi.fn(async () => ({ ok: true }))
    let publishCalls = 0
    const tryPublish = vi.fn(async () => {
      publishCalls += 1
      if (publishCalls === 1) return { kind: 'needs-sync', reason: 'busy', detail: 'busy' } as never
      return { kind: 'published', watermark: 5, digest: 'd', channelId: 'c' } as never
    })
    const svc = new SyncAutoService(validDeps({ runSync, tryPublishBaseline: tryPublish }) as never)
    svc.start()
    await vi.advanceTimersByTimeAsync(50)
    runSync.mockClear()
    // First local round: sync succeeds, publish loses the window race.
    svc.notifyLocalChange()
    await vi.advanceTimersByTimeAsync(900)
    await vi.advanceTimersByTimeAsync(50)
    expect(runSync).toHaveBeenCalledTimes(1)
    expect(tryPublish).toHaveBeenCalledTimes(1)
    expect(svc.hasLocalPublishIntentForTests()).toBe(true)
    // No tight retry without a new schedule.
    await vi.advanceTimersByTimeAsync(5000)
    expect(runSync).toHaveBeenCalledTimes(1)
    expect(tryPublish).toHaveBeenCalledTimes(1)
    // Next schedule (retained intent merges with the new trigger) publishes once.
    svc.notifyRemote()
    await vi.advanceTimersByTimeAsync(300)
    await vi.advanceTimersByTimeAsync(50)
    expect(runSync).toHaveBeenCalledTimes(2)
    expect(tryPublish).toHaveBeenCalledTimes(2)
    expect(svc.hasLocalPublishIntentForTests()).toBe(false)
    svc.stopSync()
  })
})
