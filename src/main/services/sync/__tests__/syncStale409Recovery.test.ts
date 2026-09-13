/**
 * Bounded stale-409 recovery for `publishBaselineIfEligible`:
 * - Ordinary eligible publish stays single-PUT with no resync.
 * - First PUT 409 -> one sequential `sync()` to head -> fresh recapture ->
 *   exactly one second PUT; success returns `published` and clears errors.
 * - Second-attempt barrier block stops truthfully with no third PUT.
 * - Manual `sync()` never PUTs.
 *
 * Mocked SyncClient transport only; production `SyncService.sync` /
 * `publishBaseline` / `publishBaselineIfEligible` run unmocked.
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
    set: (k: string, v: unknown) => {
      configStore.set(k, v)
    }
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
const CHANNEL = 'ch-stale-409'
const CURSOR_N = 5

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>

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

function seedPublishableTopic(topicId = 'stale-409-topic-1', ts = 7, op = 's409op7'): void {
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

function mockEmptyPull(): void {
  vi.spyOn(syncClient, 'pull').mockImplementation(async () => ({ operations: [], cursor: CURSOR_N }) as never)
}

function conflict409(): Error & { cause?: unknown } {
  const err = new Error('baseline publish failed 409: {"error":"baseline-conflict"}') as Error & {
    cause?: unknown
  }
  ;(err as { cause?: unknown }).cause = { status: 409 }
  return err
}

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', ENDPOINT)
  configStore.set('sync:token', '')
  sqlite = new Database(':memory:')
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
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

describe('stale-409 bounded recovery', () => {
  it('ordinary eligible publish stays single-PUT with no resync when non-conflicting', async () => {
    bindChannel(CHANNEL)
    setCursor(CURSOR_N)
    seedPublishableTopic()
    mockEmptyPull()
    vi.spyOn(syncClient, 'publishBaseline').mockImplementation(async (_e, _t, envelope) => {
      const raw = JSON.stringify(envelope)
      const { parseEnvelopeJson } = await import('@shared/sync')
      return { envelope: parseEnvelopeJson(raw), rawText: raw }
    })
    const syncSpy = vi.spyOn(syncService, 'sync')
    const res = await syncService.publishBaselineIfEligible()
    expect(res.kind).toBe('published')
    expect(vi.mocked(syncClient.publishBaseline)).toHaveBeenCalledTimes(1)
    expect(syncSpy).not.toHaveBeenCalled()
    expect(readLastError()).toBeNull()
  })

  it('first 409 -> sequential sync -> fresh recapture -> second PUT success returns published', async () => {
    bindChannel(CHANNEL)
    setCursor(CURSOR_N)
    seedPublishableTopic()
    mockEmptyPull()
    const events: string[] = []
    const putMock = vi.spyOn(syncClient, 'publishBaseline').mockImplementation(async (_e, _t, envelope) => {
      events.push('put')
      if (putMock.mock.calls.length === 1) throw conflict409()
      const raw = JSON.stringify(envelope)
      const { parseEnvelopeJson } = await import('@shared/sync')
      return { envelope: parseEnvelopeJson(raw), rawText: raw }
    })
    const origSync = syncService.sync.bind(syncService)
    const syncSpy = vi.spyOn(syncService, 'sync').mockImplementation(async () => {
      events.push('sync')
      return origSync()
    })
    const res = await syncService.publishBaselineIfEligible()
    expect(res).toMatchObject({ kind: 'published', watermark: CURSOR_N, channelId: CHANNEL })
    expect(putMock).toHaveBeenCalledTimes(2)
    expect(syncSpy).toHaveBeenCalledTimes(1)
    // Strict order: first PUT loses, then the resync runs, then the fresh PUT wins.
    expect(events).toEqual(['put', 'sync', 'put'])
    // Successful second publish clears errors through the normal publish path.
    expect(readLastError()).toBeNull()
    expect(readCursor()).toBe(CURSOR_N)
    expect(db.select().from(schema.syncOutbox).all()).toHaveLength(0)
    // No recursion into publishBaselineIfEligible and no tight retry: the
    // budget above is the whole story.
    expect(syncSpy.mock.calls.length).toBe(1)
  })

  it('second-attempt barrier block stops truthfully with no third PUT', async () => {
    bindChannel(CHANNEL)
    setCursor(CURSOR_N)
    seedPublishableTopic()
    // Pull plan: first barrier pull empty (PUT reaches relay and 409s),
    // recovery sync pull empty (sync succeeds), second barrier pull non-empty
    // so the fresh attempt barrier-blocks before any second PUT.
    let pulls = 0
    vi.spyOn(syncClient, 'pull').mockImplementation(async () => {
      pulls += 1
      if (pulls <= 2) return { operations: [], cursor: CURSOR_N } as never
      return { operations: [{ seq: CURSOR_N + 1 }], cursor: CURSOR_N + 1 } as never
    })
    const putMock = vi.spyOn(syncClient, 'publishBaseline').mockRejectedValue(conflict409())
    const syncSpy = vi.spyOn(syncService, 'sync')
    const res = await syncService.publishBaselineIfEligible()
    expect(res).toMatchObject({ kind: 'needs-sync', reason: 'barrier-blocked' })
    expect(putMock).toHaveBeenCalledTimes(1)
    expect(syncSpy).toHaveBeenCalledTimes(1)
    expect(readCursor()).toBe(CURSOR_N)
  })

  it('manual sync() success never PUTs by itself', async () => {
    bindChannel(CHANNEL)
    setCursor(CURSOR_N)
    seedPublishableTopic()
    vi.spyOn(syncClient, 'fetchBaseline').mockResolvedValue({ found: false })
    vi.spyOn(syncClient, 'push').mockResolvedValue({ cursor: CURSOR_N, acceptedIds: [] } as never)
    vi.spyOn(syncClient, 'pull').mockResolvedValue({ operations: [], cursor: CURSOR_N } as never)
    const putMock = vi.spyOn(syncClient, 'publishBaseline')
    await syncService.sync()
    expect(putMock).not.toHaveBeenCalled()
    expect(readLastError()).toBeNull()
  })
})
