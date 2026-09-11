/**
 * Baseline publish -> persist -> receiver bootstrap -> N+1 pull贯通回归
 * (SYNC-CC-022/SYNC-DATA-046 + SYNC-CC-023/SYNC-DATA-047 + SYNC-DATA-025/026).
 *
 * Evidence level: main-native integration (not Playwright E2E).
 * `SyncService.publishBaseline()` has no production IPC/preload/UI entry and
 * the task forbids adding one, so the standard Electron E2E fixture cannot
 * explicitly invoke it. This suite stays at the closest real boundary:
 * two real SQLite chat DBs (migrated via `runMigrations`) + the singleton
 * production `SyncService`/`ChatDbAggregateService` + the real reference
 * relay (`createRelayServer`) over loopback HTTP. No SyncClient/HTTP/DB mock:
 * pairing/push/pull/baseline all go through real `fetch`. The singleton is
 * time-sliced between profiles (sequential bind) because one process owns one
 * global `chatDbService`/`configManager`; no concurrent isolation is claimed.
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

import { createRelayServer, ensureRelaySchema } from '../../../../../scripts/sync-relay/server'
import { chatDbService } from '../../chatDb'
import { ChatDbAggregateService } from '../../chatDb/ChatDbAggregateService'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { captureLocalSyncBaselineCandidate } from '../syncBaseline'
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

async function relayPull(
  creds: ProfileCreds,
  deviceId: string,
  cursor: number
): Promise<{ status: number; ops: Array<{ seq: number; id: string }>; cursor: number }> {
  const res = await fetch(`${relayEndpoint}/sync/pull?cursor=${cursor}&deviceId=${encodeURIComponent(deviceId)}`, {
    headers: authedHeaders(creds)
  })
  const body = (await res.json()) as { operations?: Array<{ seq: number; id: string }>; cursor?: number }
  return { status: res.status, ops: body.operations ?? [], cursor: body.cursor ?? -1 }
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
  // Wire projection requires all 8 topic field clocks; ensureTopic alone
  // leaves pinned/prompt/isNameManuallyEdited unclocked, so set them
  // explicitly through the production metadata path.
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

beforeEach(() => {
  configStore.clear()
  credA = { deviceId: '', code: '', secret: '' }
  credB = { deviceId: '', code: '', secret: '' }
  ownedTmp = mkdtempSync(join(tmpdir(), 'sync-baseline-e2e-'))
  relayDbPath = join(ownedTmp, 'relay.db')
  relayToken = `bl-e2e-${randomBytes(8).toString('hex')}`
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

async function restartRelaySameFile(): Promise<void> {
  if (!relayServer || !relayDb) throw new Error('relay not running')
  await new Promise<void>((resolve) => {
    try {
      relayServer!.close(() => resolve())
    } catch {
      resolve()
    }
  })
  relayServer = null
  try {
    relayDb.close()
  } catch {}
  relayDb = new Database(relayDbPath)
  ensureRelaySchema(relayDb)
  await startRelay()
}

describe('baseline publish -> persist -> bootstrap -> N+1', () => {
  it('A publishes a complete baseline over real HTTP; B bootstraps and pulls N+1', async () => {
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
    // Fresh B must not reuse A's identity: credB is empty so bind keeps it empty.
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

    // A real supported dataset: two ordered messages + empty topic + one tombstone.
    bindProfile('A')
    ensureFullTopic(aggA!, 'bl-topic-1', 'Baseline One')
    expect(
      aggA!.appendMessage('bl-topic-1', msgJson('bl-m1', 'bl-topic-1', 'baseline one') as never, [
        blockJson('bl-b1', 'bl-m1', 'baseline one') as never
      ]).ok
    ).toBe(true)
    expect(
      aggA!.appendMessage('bl-topic-1', msgJson('bl-m2', 'bl-topic-1', 'baseline two') as never, [
        blockJson('bl-b2', 'bl-m2', 'baseline two') as never
      ]).ok
    ).toBe(true)
    ensureFullTopic(aggA!, 'bl-topic-2', 'Baseline Empty')
    ensureFullTopic(aggA!, 'bl-topic-tomb', 'Tomb Holder')
    // Message tombstone without blocks: deleting a message that owns blocks
    // would leave orphan block membership (fail-closed candidate), so the
    // complete-shape tombstone here is a block-less message delete.
    expect(
      aggA!.appendMessage('bl-topic-tomb', msgJson('bl-mt-gone', 'bl-topic-tomb', 'gone message') as never, []).ok
    ).toBe(true)
    expect(aggA!.deleteMessage('bl-topic-tomb', 'bl-mt-gone').ok).toBe(true)
    // Tombstone message must be locally absent with blocks removed.
    expect(sqliteA!.prepare("SELECT id FROM messages WHERE id='bl-mt-gone'").get()).toBeFalsy()

    // Normal op-log sync first: relay head=N, A outbox drained.
    bindProfile('A')
    await syncService.sync()
    expect(lastError('A')).toBeNull()
    expect(outboxCount('A')).toBe(0)
    const headN = readCursor('A')
    expect(headN).toBeGreaterThan(0)
    bindProfile('A')
    const headPage = await relayPull(credA, credA.deviceId, 0)
    expect(headPage.status).toBe(200)
    expect(headPage.cursor).toBe(headN)

    // Candidate must be complete before publish; fail with reasons only.
    bindProfile('A')
    const candidate = captureLocalSyncBaselineCandidate(dbA as never)
    if (candidate.completeness.state !== 'complete') {
      throw new Error(`fixture not complete: ${candidate.completeness.reasons.slice().sort().join(',')}`)
    }

    // Explicit production publish over real HTTP.
    bindProfile('A')
    const published = await syncService.publishBaseline()
    expect(published.watermark).toBe(headN)
    expect(published.channelId).toBe(channelId)
    expect(typeof published.digest).toBe('string')

    // Relay persisted the envelope: real GET proves it without size/path output.
    bindProfile('A')
    const fetched = await relayGetBaseline(credA)
    expect(fetched.status).toBe(200)
    const envelope = fetched.json as { watermark: number; channelId: string; digest: string }
    expect(envelope.watermark).toBe(headN)
    expect(envelope.channelId).toBe(channelId)
    expect(envelope.digest).toBe(published.digest)

    // Same-file restart keeps serving the same envelope (single persist check).
    await restartRelaySameFile()
    // Credentials survive the restart on the same file; endpoint changed.
    bindProfile('A')
    const refetched = await relayGetBaseline(credA)
    expect(refetched.status).toBe(200)
    expect((refetched.json as { digest: string }).digest).toBe(published.digest)

    // Post-baseline N+1 operation via normal op-log.
    bindProfile('A')
    expect(
      aggA!.appendMessage('bl-topic-1', msgJson('bl-m3', 'bl-topic-1', 'baseline three') as never, [
        blockJson('bl-b3', 'bl-m3', 'baseline three') as never
      ]).ok
    ).toBe(true)
    await syncService.sync()
    expect(lastError('A')).toBeNull()
    const headAfter = readCursor('A')
    expect(headAfter).toBeGreaterThan(headN)

    // B bootstraps from cursor 0 with its own outbox pending.
    bindProfile('B')
    expect(readCursor('B')).toBe(0)
    expect(outboxCount('B')).toBe(bKeepOutboxBefore)
    await syncService.sync()
    expect(lastError('B')).toBeNull()

    // Representative baseline rows converged on B.
    const bTopic1 = sqliteB!.prepare("SELECT id, name FROM topics WHERE id='bl-topic-1'").get() as
      | { id: string; name: string }
      | undefined
    expect(bTopic1?.id).toBe('bl-topic-1')
    const bTopic2 = sqliteB!.prepare("SELECT id FROM topics WHERE id='bl-topic-2'").get() as { id: string } | undefined
    expect(bTopic2?.id).toBe('bl-topic-2')
    const bM1 = sqliteB!.prepare("SELECT id, content FROM messages WHERE id='bl-m1'").get() as
      | { id: string; content: string }
      | undefined
    expect(bM1?.content).toBe('baseline one')
    const bM2 = sqliteB!.prepare("SELECT id, content FROM messages WHERE id='bl-m2'").get() as
      | { id: string; content: string }
      | undefined
    expect(bM2?.content).toBe('baseline two')
    const bB1 = sqliteB!.prepare("SELECT id, content FROM message_blocks WHERE id='bl-b1'").get() as
      | { id: string; content: string }
      | undefined
    expect(bB1?.content).toBe('baseline one')
    // Tombstone respected: deleted message stays absent on B.
    expect(sqliteB!.prepare("SELECT id FROM messages WHERE id='bl-mt-gone'").get()).toBeFalsy()
    expect(sqliteB!.prepare("SELECT id FROM message_blocks WHERE message_id='bl-mt-gone'").all()).toHaveLength(0)
    // N+1 pulled after the bootstrap cursor.
    const bM3 = sqliteB!.prepare("SELECT id, content FROM messages WHERE id='bl-m3'").get() as
      | { id: string; content: string }
      | undefined
    expect(bM3?.content).toBe('baseline three')
    // Effective order materialized as dense local projection in business order.
    const ordered = (
      sqliteB!.prepare("SELECT id FROM messages WHERE topic_id='bl-topic-1' ORDER BY sort_order ASC").all() as Array<{
        id: string
      }>
    ).map((r) => r.id)
    expect(ordered).toEqual(['bl-m1', 'bl-m2', 'bl-m3'])
    // Membership + winning frames present for the converged parent/children.
    const memM1 = sqliteB!
      .prepare('SELECT parent_id FROM sync_membership_clock WHERE child_entity_type=? AND child_entity_id=?')
      .get('message', 'bl-m1') as { parent_id: string } | undefined
    expect(memM1?.parent_id).toBe('bl-topic-1')
    const frameTopic = dbB!
      .select()
      .from(schema.syncParentOrderFrame)
      .all()
      .find((r) => r.kind === 'topicMessage' && r.parentId === 'bl-topic-1')
    expect(frameTopic).toBeTruthy()
    // Incremental order_frame convergence (SYNC-DATA-048): the N+1 append
    // minted a winning frame plus a matching order_frame op, so B's winning
    // frame advances to the post-replay effective order.
    expect(JSON.parse(frameTopic!.orderedChildIdsJson)).toEqual(['bl-m1', 'bl-m2', 'bl-m3'])
    const frameEmpty = dbB!
      .select()
      .from(schema.syncParentOrderFrame)
      .all()
      .find((r) => r.kind === 'topicMessage' && r.parentId === 'bl-topic-2')
    expect(frameEmpty).toBeTruthy()
    expect(JSON.parse(frameEmpty!.orderedChildIdsJson)).toEqual([])

    // B pre-existing rows preserved; outbox pushed; cursor advanced past N.
    const bKeep = sqliteB!.prepare("SELECT id FROM topics WHERE id='b-keep-topic'").get() as { id: string } | undefined
    expect(bKeep?.id).toBe('b-keep-topic')
    const bKeepMsg = sqliteB!.prepare("SELECT id FROM messages WHERE id='b-keep-msg'").get() as
      | { id: string }
      | undefined
    expect(bKeepMsg?.id).toBe('b-keep-msg')
    expect(outboxCount('B')).toBe(0)
    expect(readCursor('B')).toBeGreaterThanOrEqual(headAfter)
    // A retains its source rows; cursors are per-channel truthful.
    const aM1 = sqliteA!.prepare("SELECT id FROM messages WHERE id='bl-m1'").get() as { id: string } | undefined
    expect(aM1?.id).toBe('bl-m1')
    expect(readChannel('A')).toBe(channelId)
    expect(readChannel('B')).toBe(channelId)
  }, 60000)
})
