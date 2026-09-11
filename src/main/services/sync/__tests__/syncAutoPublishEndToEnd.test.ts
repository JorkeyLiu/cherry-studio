/**
 * Auto local-mutation -> SyncAuto debounce/drain -> production sync ->
 * production publishBaselineIfEligible -> real relay PUT/persist ->
 * B cursor=0 bootstrap -> N+1 pull贯通回归.
 *
 * Evidence level: main-native integration (not Playwright E2E).
 * Two real SQLite chat DBs (migrated via `runMigrations`) + the singleton
 * production `SyncService`/`ChatDbAggregateService` + the real reference
 * relay (`createRelayServer`) over loopback HTTP. No SyncClient/HTTP/DB mock:
 * pairing/push/pull/baseline all go through real `fetch`. The singleton is
 * time-sliced between profiles (sequential bind) because one process owns one
 * global `chatDbService`/`configManager`; no concurrent isolation is claimed.
 *
 * `SyncAutoService` runs with its default live `runSync`/`tryPublishBaseline`
 * (production `SyncService.sync` / `publishBaselineIfEligible`); only the
 * existing `SyncAutoDeps.createSubscriber` seam is injected with a noop
 * subscriber to avoid test SSE. No test-only API is added. Real timers with
 * bounded polling are used; fake timers are never installed because they
 * would freeze real `fetch`.
 *
 * Single-PUT proof uses a delegating `fetch` counter (observation only, no
 * behavior change, no production change): every `PUT /sync/baseline` that
 * reaches the relay is counted, then the request is forwarded to the real
 * `fetch`. One valid auto PUT is proven by count==1 plus relay `GET`
 * returning the same envelope after quiescence.
 *
 * Remote/reconcile/manual never-PUT is not re-proven here; the existing
 * `syncAutoPublish.test.ts` state machine already covers it. This regression
 * focuses on the local auto path only. No Electron/preload/UI/multi-process/
 * SSE/restart/latency-SLA claim is made.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
    set: (k: string, v: unknown) => {
      configStore.set(k, v)
    },
    has: (k: string) => configStore.has(k)
  },
  ConfigKeys: {}
}))

import { eq } from 'drizzle-orm'

import { createRelayServer } from '../../../../../scripts/sync-relay/server'
import { ensureRelaySchema } from '../../../../../scripts/sync-relay/server'
import { chatDbService } from '../../chatDb'
import { ChatDbAggregateService } from '../../chatDb/ChatDbAggregateService'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { SyncAutoService } from '../syncAuto'
import { syncService } from '../SyncService'

let sqliteA: Database.Database | null = null
let sqliteB: Database.Database | null = null
let dbA: BetterSQLite3Database<typeof schema> | null = null
let dbB: BetterSQLite3Database<typeof schema> | null = null
let aggA: ChatDbAggregateService | null = null
let aggB: ChatDbAggregateService | null = null
let relayDb: Database.Database | null = null
let relayServer: { close: (cb?: () => void) => void } | null = null
let relayEndpoint = ''
let relayToken = ''
let relayDbPath = ''
let ownedTmp = ''

interface ProfileCreds {
  deviceId: string
  code: string
  secret: string
}

let credA: ProfileCreds = { deviceId: '', code: '', secret: '' }
let credB: ProfileCreds = { deviceId: '', code: '', secret: '' }

function openChatDb(): { sqlite: Database.Database; db: BetterSQLite3Database<typeof schema> } {
  const sqlite = new Database(':memory:')
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  runMigrations(db as never, sqlite)
  return { sqlite, db }
}

function bindProfile(which: 'A' | 'B'): void {
  const sqlite = which === 'A' ? sqliteA : sqliteB
  const db = which === 'A' ? dbA : dbB
  const creds = which === 'A' ? credA : credB
  if (!sqlite || !db) throw new Error('profile not initialized')
  ;(chatDbService as unknown as { sqlite: unknown }).sqlite = sqlite
  ;(chatDbService as unknown as { db: unknown }).db = db
  configStore.set('sync:endpoint', relayEndpoint)
  configStore.set('sync:token', relayToken)
  configStore.set('sync:enabled', true)
  if (creds.deviceId) configStore.set('deviceId', creds.deviceId)
  else configStore.delete('deviceId')
  if (creds.code) configStore.set('sync:deviceCode', creds.code)
  else configStore.delete('sync:deviceCode')
  if (creds.secret) configStore.set('sync:deviceAuth', creds.secret)
  else configStore.delete('sync:deviceAuth')
  configStore.set('sync:explicitDisconnect', false)
}

function snapshotCreds(): ProfileCreds {
  return {
    deviceId: String(configStore.get('deviceId') ?? ''),
    code: String(configStore.get('sync:deviceCode') ?? ''),
    secret: String(configStore.get('sync:deviceAuth') ?? '')
  }
}

function readCursor(which: 'A' | 'B'): number {
  const db = which === 'A' ? dbA : dbB
  const row = db!.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
  return row ? Number(row.value) : 0
}

function readChannel(which: 'A' | 'B'): string | null {
  const db = which === 'A' ? dbA : dbB
  const row = db!.select().from(schema.syncState).where(eq(schema.syncState.key, 'sync:channelKey')).get()
  return (row?.value as string | null) ?? null
}

function outboxCount(which: 'A' | 'B'): number {
  const db = which === 'A' ? dbA : dbB
  return db!.select().from(schema.syncOutbox).all().length
}

function lastError(which: 'A' | 'B'): string | null {
  const db = which === 'A' ? dbA : dbB
  const row = db!.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastError')).get()
  return (row?.value as string | null) ?? null
}

function authedHeaders(creds: ProfileCreds): Record<string, string> {
  return {
    Authorization: `Bearer ${relayToken}`,
    'Content-Type': 'application/json',
    'x-sync-device-code': creds.code,
    'x-sync-device-secret': creds.secret
  }
}

async function relayGetBaseline(creds: ProfileCreds): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${relayEndpoint}/sync/baseline`, { headers: authedHeaders(creds) })
  return { status: res.status, json: (await res.json()) as unknown }
}

function msgJson(id: string, topicId: string, content: string): Record<string, unknown> {
  return {
    id,
    topicId,
    role: 'user',
    content,
    status: 'success',
    askId: null,
    model: null,
    modelId: null,
    assistantId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z'
  }
}

function ensureFullTopic(agg: ChatDbAggregateService, topicId: string, name: string): void {
  const ensured = agg.ensureTopic(topicId, 'a1', name)
  if (!ensured.ok) throw new Error(`ensureTopic failed for ${topicId}`)
  const updated = agg.updateTopicMetadata(topicId, undefined, false, `prompt-${topicId}`, false)
  if (!updated.ok) throw new Error(`updateTopicMetadata failed for ${topicId}`)
}

function blockJson(id: string, messageId: string, content: string): Record<string, unknown> {
  return {
    id,
    messageId,
    type: 'main_text',
    content,
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    sortOrder: 0
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await cond()) return
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`)
    await sleepMs(100)
  }
}

beforeEach(() => {
  configStore.clear()
  credA = { deviceId: '', code: '', secret: '' }
  credB = { deviceId: '', code: '', secret: '' }
  ownedTmp = mkdtempSync(join(tmpdir(), 'sync-auto-pub-e2e-'))
  relayDbPath = join(ownedTmp, 'relay.db')
  relayToken = `auto-e2e-${randomBytes(8).toString('hex')}`
  relayDb = new Database(relayDbPath)
  relayDb.pragma('journal_mode = WAL')
  ensureRelaySchema(relayDb)
  const a = openChatDb()
  sqliteA = a.sqlite
  dbA = a.db
  aggA = new ChatDbAggregateService(dbA, sqliteA)
  const b = openChatDb()
  sqliteB = b.sqlite
  dbB = b.db
  aggB = new ChatDbAggregateService(dbB, sqliteB)
  syncService.clearAllForTests()
  syncService.resetShutdownForTests()
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (relayServer) {
    await new Promise<void>((resolve) => {
      try {
        relayServer!.close(() => resolve())
      } catch {
        resolve()
      }
    })
    relayServer = null
  }
  try {
    relayDb?.close()
  } catch {}
  relayDb = null
  try {
    sqliteA?.close()
  } catch {}
  try {
    sqliteB?.close()
  } catch {}
  sqliteA = null
  sqliteB = null
  dbA = null
  dbB = null
  aggA = null
  aggB = null
  ;(chatDbService as unknown as { sqlite: unknown }).sqlite = null
  ;(chatDbService as unknown as { db: unknown }).db = null
  try {
    if (ownedTmp) rmSync(ownedTmp, { recursive: true, force: true })
  } catch {}
  ownedTmp = ''
  relayEndpoint = ''
})

async function startRelay(): Promise<void> {
  if (!relayDb) throw new Error('relay db not initialized')
  const server = createRelayServer(relayDb, { token: relayToken })
  relayServer = server as unknown as { close: (cb?: () => void) => void }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as { port: number }
  relayEndpoint = `http://127.0.0.1:${addr.port}`
}

describe('auto local mutation -> debounce/drain -> publish -> B bootstrap -> N+1', () => {
  it('real aggregate mutation drives auto PUT once; B bootstraps and pulls N+1', async () => {
    await startRelay()

    // Same paired channel via production connect/request/accept/getPairState.
    bindProfile('A')
    await syncService.connect()
    credA = snapshotCreds()
    expect(credA.code.length).toBeGreaterThan(0)

    configStore.delete('deviceId')
    configStore.delete('sync:deviceCode')
    configStore.delete('sync:deviceAuth')
    bindProfile('B')
    credB = { deviceId: '', code: '', secret: '' }
    bindProfile('B')
    await syncService.connect()
    credB = snapshotCreds()
    expect(credB.code.length).toBeGreaterThan(0)
    expect(credB.code).not.toBe(credA.code)

    bindProfile('B')
    const req = await syncService.requestPairing(credA.code)
    expect(typeof req.requestId).toBe('string')
    bindProfile('A')
    const accepted = await syncService.acceptPairing(req.requestId)
    expect(typeof accepted.channelId).toBe('string')
    bindProfile('B')
    await syncService.getPairState()
    const channelA = (() => {
      bindProfile('A')
      return readChannel('A')
    })()
    const channelB = (() => {
      bindProfile('B')
      return readChannel('B')
    })()
    expect(channelA).toBeTruthy()
    expect(channelB).toBe(channelA)
    const channelId = channelA as string

    // B pre-existing local rows + outbox (protection fixture).
    bindProfile('B')
    ensureFullTopic(aggB!, 'b-keep-topic', 'Keep Topic')
    expect(
      aggB!.appendMessage('b-keep-topic', msgJson('b-keep-msg', 'b-keep-topic', 'keep me') as never, [
        blockJson('b-keep-blk', 'b-keep-msg', 'keep me') as never
      ]).ok
    ).toBe(true)
    expect(outboxCount('B')).toBeGreaterThan(0)
    const bKeepOutboxBefore = outboxCount('B')

    // A supported complete base dataset before auto starts (no intent yet).
    bindProfile('A')
    ensureFullTopic(aggA!, 'auto-topic-1', 'Auto One')
    expect(
      aggA!.appendMessage('auto-topic-1', msgJson('auto-m1', 'auto-topic-1', 'auto one') as never, [
        blockJson('auto-b1', 'auto-m1', 'auto one') as never
      ]).ok
    ).toBe(true)
    expect(
      aggA!.appendMessage('auto-topic-1', msgJson('auto-m2', 'auto-topic-1', 'auto two') as never, [
        blockJson('auto-b2', 'auto-m2', 'auto two') as never
      ]).ok
    ).toBe(true)
    ensureFullTopic(aggA!, 'auto-topic-2', 'Auto Empty')
    ensureFullTopic(aggA!, 'auto-topic-tomb', 'Tomb Holder')
    expect(
      aggA!.appendMessage('auto-topic-tomb', msgJson('auto-mt-gone', 'auto-topic-tomb', 'gone message') as never, []).ok
    ).toBe(true)
    expect(aggA!.deleteMessage('auto-topic-tomb', 'auto-mt-gone').ok).toBe(true)
    expect(sqliteA!.prepare("SELECT id FROM messages WHERE id='auto-mt-gone'").get()).toBeFalsy()

    // Delegating PUT counter: observation only, real fetch still runs.
    const realFetch = globalThis.fetch
    let baselinePutCount = 0
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      try {
        const url = typeof input === 'string' ? input : String((input as { url?: unknown })?.url ?? '')
        const method = String(
          init?.method ?? (typeof input !== 'string' ? (input as { method?: unknown })?.method : undefined) ?? 'GET'
        ).toUpperCase()
        if (method === 'PUT' && url.includes('/sync/baseline')) baselinePutCount += 1
      } catch {}
      return realFetch(input as never, init)
    }) as typeof fetch

    let auto: SyncAutoService | null = null
    try {
      // Live auto: default production runSync/tryPublishBaseline, noop subscriber only.
      bindProfile('A')
      auto = new SyncAutoService({
        createSubscriber: () => ({ start: () => {}, stop: () => {} }) as never
      })
      auto.start()

      // Initial auto cycle drains the base ops with no local intent: no PUT.
      await waitFor(() => outboxCount('A') === 0 && readCursor('A') > 0, 15000, 'initial auto drain')
      bindProfile('A')
      expect(lastError('A')).toBeNull()
      const missing = await relayGetBaseline(credA)
      expect(missing.status).toBe(404)
      expect(baselinePutCount).toBe(0)

      // Real aggregate local mutation triggers onEnqueue/local intent via production subscription.
      bindProfile('A')
      expect(
        aggA!.appendMessage('auto-topic-1', msgJson('auto-m3', 'auto-topic-1', 'auto three') as never, [
          blockJson('auto-b3', 'auto-m3', 'auto three') as never
        ]).ok
      ).toBe(true)
      expect(auto.hasLocalPublishIntentForTests()).toBe(true)

      // Auto debounce/drain publishes: outbox drains, cursor/head truthful, relay GET envelope appears.
      await waitFor(
        async () => {
          bindProfile('A')
          if (outboxCount('A') !== 0) return false
          const got = await relayGetBaseline(credA)
          return got.status === 200
        },
        20000,
        'auto baseline publish'
      )
      bindProfile('A')
      expect(lastError('A')).toBeNull()
      const headN = readCursor('A')
      expect(headN).toBeGreaterThan(0)
      const fetched = await relayGetBaseline(credA)
      expect(fetched.status).toBe(200)
      const envelope = fetched.json as { watermark: number; channelId: string; digest: string }
      expect(envelope.watermark).toBe(headN)
      expect(envelope.channelId).toBe(channelId)
      expect(typeof envelope.digest).toBe('string')
      expect(baselinePutCount).toBe(1)

      // Quiescence: no second PUT without a new local trigger.
      await sleepMs(2000)
      bindProfile('A')
      expect(baselinePutCount).toBe(1)
      const refetched = await relayGetBaseline(credA)
      expect((refetched.json as { digest: string }).digest).toBe(envelope.digest)

      // Stop A auto, then one more op-log change becomes N+1 via explicit manual sync (never PUTs).
      auto.stopSync()
      auto = null
      syncService.resetShutdownForTests()
      bindProfile('A')
      expect(
        aggA!.appendMessage('auto-topic-1', msgJson('auto-m4', 'auto-topic-1', 'auto four') as never, [
          blockJson('auto-b4', 'auto-m4', 'auto four') as never
        ]).ok
      ).toBe(true)
      await syncService.sync()
      expect(lastError('A')).toBeNull()
      const headAfter = readCursor('A')
      expect(headAfter).toBeGreaterThan(headN)
      expect(baselinePutCount).toBe(1)

      // B bootstraps from cursor 0 with its own outbox pending.
      bindProfile('B')
      expect(readCursor('B')).toBe(0)
      expect(outboxCount('B')).toBe(bKeepOutboxBefore)
      await syncService.sync()
      expect(lastError('B')).toBeNull()

      // Representative convergence: baseline rows + N+1, tombstone, order, membership/frames.
      const bTopic1 = sqliteB!.prepare("SELECT id FROM topics WHERE id='auto-topic-1'").get() as
        | { id: string }
        | undefined
      expect(bTopic1?.id).toBe('auto-topic-1')
      const bTopic2 = sqliteB!.prepare("SELECT id FROM topics WHERE id='auto-topic-2'").get() as
        | { id: string }
        | undefined
      expect(bTopic2?.id).toBe('auto-topic-2')
      const bM1 = sqliteB!.prepare("SELECT id, content FROM messages WHERE id='auto-m1'").get() as
        | { id: string; content: string }
        | undefined
      expect(bM1?.content).toBe('auto one')
      const bB1 = sqliteB!.prepare("SELECT id, content FROM message_blocks WHERE id='auto-b1'").get() as
        | { id: string; content: string }
        | undefined
      expect(bB1?.content).toBe('auto one')
      const bM3 = sqliteB!.prepare("SELECT id, content FROM messages WHERE id='auto-m3'").get() as
        | { id: string; content: string }
        | undefined
      expect(bM3?.content).toBe('auto three')
      const bM4 = sqliteB!.prepare("SELECT id, content FROM messages WHERE id='auto-m4'").get() as
        | { id: string; content: string }
        | undefined
      expect(bM4?.content).toBe('auto four')
      expect(sqliteB!.prepare("SELECT id FROM messages WHERE id='auto-mt-gone'").get()).toBeFalsy()
      expect(sqliteB!.prepare("SELECT id FROM message_blocks WHERE message_id='auto-mt-gone'").all()).toHaveLength(0)
      const ordered = (
        sqliteB!
          .prepare("SELECT id FROM messages WHERE topic_id='auto-topic-1' ORDER BY sort_order ASC")
          .all() as Array<{
          id: string
        }>
      ).map((r) => r.id)
      expect(ordered).toEqual(['auto-m1', 'auto-m2', 'auto-m3', 'auto-m4'])
      const memM1 = sqliteB!
        .prepare('SELECT parent_id FROM sync_membership_clock WHERE child_entity_type=? AND child_entity_id=?')
        .get('message', 'auto-m1') as { parent_id: string } | undefined
      expect(memM1?.parent_id).toBe('auto-topic-1')
      const frameTopic = dbB!
        .select()
        .from(schema.syncParentOrderFrame)
        .all()
        .find((r) => r.kind === 'topicMessage' && r.parentId === 'auto-topic-1')
      expect(frameTopic).toBeTruthy()
      // Incremental order_frame convergence (SYNC-DATA-048): N+1 (m4)
      // minted a winning frame plus a matching order_frame op, so B's winning
      // frame advances past the auto-published snapshot.
      expect(JSON.parse(frameTopic!.orderedChildIdsJson)).toEqual(['auto-m1', 'auto-m2', 'auto-m3', 'auto-m4'])
      const frameEmpty = dbB!
        .select()
        .from(schema.syncParentOrderFrame)
        .all()
        .find((r) => r.kind === 'topicMessage' && r.parentId === 'auto-topic-2')
      expect(frameEmpty).toBeTruthy()
      expect(JSON.parse(frameEmpty!.orderedChildIdsJson)).toEqual([])

      // B pre-existing rows preserved; outbox pushed; cursor advanced past N.
      const bKeep = sqliteB!.prepare("SELECT id FROM topics WHERE id='b-keep-topic'").get() as
        | { id: string }
        | undefined
      expect(bKeep?.id).toBe('b-keep-topic')
      const bKeepMsg = sqliteB!.prepare("SELECT id FROM messages WHERE id='b-keep-msg'").get() as
        | { id: string }
        | undefined
      expect(bKeepMsg?.id).toBe('b-keep-msg')
      expect(outboxCount('B')).toBe(0)
      expect(readCursor('B')).toBeGreaterThanOrEqual(headAfter)
      const aM1 = sqliteA!.prepare("SELECT id FROM messages WHERE id='auto-m1'").get() as { id: string } | undefined
      expect(aM1?.id).toBe('auto-m1')
      expect(readChannel('A')).toBe(channelId)
      expect(readChannel('B')).toBe(channelId)
    } finally {
      try {
        auto?.stopSync()
      } catch {}
      try {
        syncService.resetShutdownForTests()
      } catch {}
      globalThis.fetch = realFetch
    }
  }, 60000)
})
