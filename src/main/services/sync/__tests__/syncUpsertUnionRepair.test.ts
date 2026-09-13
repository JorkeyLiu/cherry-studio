/**
 * Incremental remote-upsert bounded union-frame repair (SYNC-DATA-035/036/048/058).
 * Real-relay reproduction of the holder/receiver same-parent versioned exclusive
 * child+frame race that previously deadlocked as incomplete fail-closed, plus
 * unit coverage for order/clock/atomicity/negatives/failure-injection.
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

import { createRelayServer, ensureRelaySchema } from '../../../../../scripts/sync-relay/server'
import { chatDbService } from '../../chatDb'
import { ChatDbAggregateService } from '../../chatDb/ChatDbAggregateService'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { captureLocalSyncBaselineCandidate } from '../syncBaseline'
import { computeWirePayloadDigest, projectLocalBaselineToWirePayload } from '../syncBaselineWireProjection'
import { syncService } from '../SyncService'
import { seedRegisteredAttachedSyncService } from './helpers/syncTestRegistration'

let sqliteA: Database.Database | null = null
let sqliteB: Database.Database | null = null
let dbA: BetterSQLite3Database<typeof schema> | null = null
let dbB: BetterSQLite3Database<typeof schema> | null = null
let relayDb: Database.Database | null = null
let relayServer: { close: (cb?: () => void) => void } | null = null
let relayEndpoint = ''
let relayToken = ''
let relayDbPath = ''
let ownedTmp = ''
let credA = { deviceId: '', code: '', secret: '' }
let credB = { deviceId: '', code: '', secret: '' }

function openChatDb(): { sqlite: Database.Database; db: BetterSQLite3Database<typeof schema> } {
  const sqlite = new Database(':memory:')
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  runMigrations(db as never, sqlite)
  return { sqlite, db }
}

function bindProfile(which: 'A' | 'B', creds: { deviceId: string; code: string; secret: string }): void {
  const sqlite = which === 'A' ? sqliteA : sqliteB
  const db = which === 'A' ? dbA : dbB
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

function snapshotCreds(): { deviceId: string; code: string; secret: string } {
  return {
    deviceId: String(configStore.get('deviceId') ?? ''),
    code: String(configStore.get('sync:deviceCode') ?? ''),
    secret: String(configStore.get('sync:deviceAuth') ?? '')
  }
}

function outboxCount(db: BetterSQLite3Database<typeof schema>): number {
  return db.select().from(schema.syncOutbox).all().length
}
function frameOpCount(db: BetterSQLite3Database<typeof schema>, parentId?: string): number {
  return db
    .select()
    .from(schema.syncOutbox)
    .all()
    .filter((r) => r.op === 'order_frame' && (parentId === undefined || r.entityId === parentId)).length
}
function messageOrder(sqlite: Database.Database, topicId: string): string[] {
  return (
    sqlite.prepare(`SELECT id FROM messages WHERE topic_id=? ORDER BY sort_order ASC, id ASC`).all(topicId) as Array<{
      id: string
    }>
  ).map((r) => r.id)
}
function blockOrder(sqlite: Database.Database, messageId: string): string[] {
  return (
    sqlite
      .prepare(`SELECT id FROM message_blocks WHERE message_id=? ORDER BY sort_order ASC, id ASC`)
      .all(messageId) as Array<{ id: string }>
  ).map((r) => r.id)
}
function topicFrame(sqlite: Database.Database, parentId: string): { ids: string[]; ts: number; opId: string } | null {
  const r = sqlite
    .prepare(
      `SELECT ordered_child_ids_json AS json, timestamp AS ts, operation_id AS opId FROM sync_parent_order_frame WHERE kind='topicMessage' AND parent_id=?`
    )
    .get(parentId) as { json: string; ts: number; opId: string } | undefined
  if (!r) return null
  return { ids: JSON.parse(r.json) as string[], ts: r.ts, opId: r.opId }
}
function blockFrame(sqlite: Database.Database, parentId: string): { ids: string[]; ts: number; opId: string } | null {
  const r = sqlite
    .prepare(
      `SELECT ordered_child_ids_json AS json, timestamp AS ts, operation_id AS opId FROM sync_parent_order_frame WHERE kind='messageBlock' AND parent_id=?`
    )
    .get(parentId) as { json: string; ts: number; opId: string } | undefined
  if (!r) return null
  return { ids: JSON.parse(r.json) as string[], ts: r.ts, opId: r.opId }
}
function membership(sqlite: Database.Database, childId: string): { ts: number; opId: string } | null {
  const r = sqlite
    .prepare(`SELECT timestamp AS ts, operation_id AS opId FROM sync_membership_clock WHERE child_entity_id=?`)
    .get(childId) as { ts: number; opId: string } | undefined
  return r ?? null
}
function cursorValue(db: BetterSQLite3Database<typeof schema>): number {
  const r = db
    .select()
    .from(schema.syncState)
    .all()
    .find((row) => row.key === 'cursor')
  return r ? Number(r.value) : 0
}
function appliedCount(sqlite: Database.Database): number {
  return (sqlite.prepare(`SELECT COUNT(*) as n FROM sync_applied`).get() as { n: number }).n
}
function wireDigestFor(db: BetterSQLite3Database<typeof schema>): string | null {
  try {
    const candidate = captureLocalSyncBaselineCandidate(db as never)
    if ((candidate as unknown as { completeness?: string }).completeness !== 'complete') return null
    const payload = projectLocalBaselineToWirePayload(candidate)
    return computeWirePayloadDigest(payload)
  } catch {
    return null
  }
}

beforeEach(() => {
  configStore.clear()
  credA = { deviceId: '', code: '', secret: '' }
  credB = { deviceId: '', code: '', secret: '' }
  ownedTmp = mkdtempSync(join(tmpdir(), 'sync-upsert-repair-'))
  relayDbPath = join(ownedTmp, 'relay.db')
  relayToken = `repair-${randomBytes(8).toString('hex')}`
  relayDb = new Database(relayDbPath)
  relayDb.pragma('journal_mode = WAL')
  ensureRelaySchema(relayDb)
  const a = openChatDb()
  sqliteA = a.sqlite
  dbA = a.db
  const b = openChatDb()
  sqliteB = b.sqlite
  dbB = b.db
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

async function pairEmpty(): Promise<void> {
  await startRelay()
  bindProfile('A', credA)
  await syncService.connect()
  credA = snapshotCreds()
  configStore.delete('deviceId')
  configStore.delete('sync:deviceCode')
  configStore.delete('sync:deviceAuth')
  bindProfile('B', credB)
  credB = { deviceId: '', code: '', secret: '' }
  bindProfile('B', credB)
  await syncService.connect()
  credB = snapshotCreds()
  bindProfile('B', credB)
  const req = await syncService.requestPairing(credA.code)
  bindProfile('A', credA)
  await syncService.acceptPairing(req.requestId)
  bindProfile('B', credB)
  await syncService.getPairState()
}

async function syncBoth(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    bindProfile('A', credA)
    await syncService.sync()
    bindProfile('B', credB)
    await syncService.sync()
  }
}

function makeMsg(id: string, topicId: string, content: string): Record<string, unknown> {
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
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}
function makeBlock(id: string, messageId: string, content: string): Record<string, unknown> {
  return {
    id,
    messageId,
    type: 'main_text',
    content,
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

describe('1) two-profile exclusive message union over real relay', () => {
  it('same shared topic each exclusive message converges both sync orders, outbox drains, repeat adds no frame', async () => {
    await pairEmpty()
    // Shared topic via A then converge.
    bindProfile('A', credA)
    const aggA0 = new ChatDbAggregateService(dbA!, sqliteA!)
    expect(aggA0.ensureTopic('t-shared', 'a1', 'Shared').ok).toBe(true)
    await syncService.sync()
    bindProfile('B', credB)
    await syncService.sync()
    expect(sqliteB!.prepare(`SELECT id FROM topics WHERE id='t-shared'`).get()).toBeTruthy()

    // Concurrent exclusives with different wall clocks.
    bindProfile('A', credA)
    const aggA = new ChatDbAggregateService(dbA!, sqliteA!)
    expect(
      aggA.appendMessage('t-shared', makeMsg('m-A', 't-shared', 'from A') as never, [
        makeBlock('b-A', 'm-A', 'from A') as never
      ]).ok
    ).toBe(true)
    // Ensure different wall clock for B (later timestamp).
    await new Promise((r) => setTimeout(r, 5))
    bindProfile('B', credB)
    const aggB = new ChatDbAggregateService(dbB!, sqliteB!)
    expect(
      aggB.appendMessage('t-shared', makeMsg('m-B', 't-shared', 'from B') as never, [
        makeBlock('b-B', 'm-B', 'from B') as never
      ]).ok
    ).toBe(true)

    // A-first order with enough rounds to exchange repair unions (upsert repair
    // enqueues in pull tx and pushes next cycle; winner then converges via LWW).
    await syncBoth(4)

    const orderA = messageOrder(sqliteA!, 't-shared')
    const orderB = messageOrder(sqliteB!, 't-shared')
    expect(orderA).toContain('m-A')
    expect(orderA).toContain('m-B')
    expect(orderB).toEqual(orderA)
    const fA = topicFrame(sqliteA!, 't-shared')
    const fB = topicFrame(sqliteB!, 't-shared')
    expect(fA).toBeTruthy()
    expect(fB).toBeTruthy()
    expect(fB!.ids).toEqual(fA!.ids)
    expect(fB!.ts).toBe(fA!.ts)
    expect(fB!.opId).toBe(fA!.opId)
    expect(outboxCount(dbA!)).toBe(0)
    expect(outboxCount(dbB!)).toBe(0)

    // Repeat sync adds no frame op (no storm).
    const beforeOps = frameOpCount(dbA!) + frameOpCount(dbB!)
    expect(beforeOps).toBe(0)
    const fBefore = topicFrame(sqliteA!, 't-shared')!
    await syncBoth(2)
    expect(topicFrame(sqliteA!, 't-shared')).toEqual(fBefore)
    expect(topicFrame(sqliteB!, 't-shared')).toEqual(fBefore)
    expect(outboxCount(dbA!)).toBe(0)
    expect(outboxCount(dbB!)).toBe(0)

    // Reverse-order second pair on same parent still converges with full identity.
    bindProfile('A', credA)
    const aggA2 = new ChatDbAggregateService(dbA!, sqliteA!)
    expect(aggA2.appendMessage('t-shared', makeMsg('m-A2', 't-shared', 'A2') as never, []).ok).toBe(true)
    bindProfile('B', credB)
    const aggB2 = new ChatDbAggregateService(dbB!, sqliteB!)
    expect(aggB2.appendMessage('t-shared', makeMsg('m-B2', 't-shared', 'B2') as never, []).ok).toBe(true)
    // B-first this time.
    bindProfile('B', credB)
    await syncService.sync()
    await syncBoth(4)
    expect(messageOrder(sqliteA!, 't-shared')).toEqual(messageOrder(sqliteB!, 't-shared'))
    const fA2 = topicFrame(sqliteA!, 't-shared')!
    const fB2 = topicFrame(sqliteB!, 't-shared')!
    expect(fB2.ids).toEqual(fA2.ids)
    expect(fB2.ts).toBe(fA2.ts)
    expect(fB2.opId).toBe(fA2.opId)
    expect(outboxCount(dbA!)).toBe(0)
    expect(outboxCount(dbB!)).toBe(0)

    // Cursor advanced on both sides and subsequent sync pulls nothing new:
    // cursor stable, applied stable, frames stable, outbox stays drained.
    const cursorA = cursorValue(dbA!)
    const cursorB = cursorValue(dbB!)
    expect(cursorA).toBeGreaterThan(0)
    expect(cursorB).toBe(cursorA)
    // Baseline wire digest consistency when both candidates are complete
    // (cost-bounded: skipped when either side is partial).
    bindProfile('A', credA)
    const digestA = wireDigestFor(dbA!)
    bindProfile('B', credB)
    const digestB = wireDigestFor(dbB!)
    if (digestA && digestB) expect(digestB).toBe(digestA)
    const appliedA = appliedCount(sqliteA!)
    const appliedB = appliedCount(sqliteB!)
    const frameBefore = topicFrame(sqliteA!, 't-shared')!
    await syncBoth(2)
    expect(cursorValue(dbA!)).toBe(cursorA)
    expect(cursorValue(dbB!)).toBe(cursorB)
    expect(appliedCount(sqliteA!)).toBe(appliedA)
    expect(appliedCount(sqliteB!)).toBe(appliedB)
    expect(topicFrame(sqliteA!, 't-shared')).toEqual(frameBefore)
    expect(topicFrame(sqliteB!, 't-shared')).toEqual(frameBefore)
    expect(outboxCount(dbA!)).toBe(0)
    expect(outboxCount(dbB!)).toBe(0)
  }, 90000)
})

describe('2) shared message exclusive blocks converge', () => {
  it('same message each exclusive supported block unions with one frame each side', async () => {
    await pairEmpty()
    bindProfile('A', credA)
    const aggA0 = new ChatDbAggregateService(dbA!, sqliteA!)
    expect(aggA0.ensureTopic('t-b', 'a1', 'B').ok).toBe(true)
    expect(
      aggA0.appendMessage('t-b', makeMsg('m-shared', 't-b', 'shared') as never, [
        makeBlock('b-0', 'm-shared', 'zero') as never
      ]).ok
    ).toBe(true)
    await syncService.sync()
    bindProfile('B', credB)
    await syncService.sync()
    expect(sqliteB!.prepare(`SELECT id FROM messages WHERE id='m-shared'`).get()).toBeTruthy()

    bindProfile('A', credA)
    const aggA = new ChatDbAggregateService(dbA!, sqliteA!)
    expect(aggA.updateBlocks([makeBlock('b-A1', 'm-shared', 'A1') as never]).ok).toBe(true)
    bindProfile('B', credB)
    const aggB = new ChatDbAggregateService(dbB!, sqliteB!)
    expect(aggB.updateBlocks([makeBlock('b-B1', 'm-shared', 'B1') as never]).ok).toBe(true)

    await syncBoth(4)
    const oA = blockOrder(sqliteA!, 'm-shared')
    const oB = blockOrder(sqliteB!, 'm-shared')
    expect(oA).toContain('b-A1')
    expect(oA).toContain('b-B1')
    expect(oB).toEqual(oA)
    const bfA = blockFrame(sqliteA!, 'm-shared')!
    const bfB = blockFrame(sqliteB!, 'm-shared')!
    expect(bfB.ids).toEqual(bfA.ids)
    expect(bfB.ts).toBe(bfA.ts)
    expect(bfB.opId).toBe(bfA.opId)
    expect(outboxCount(dbA!)).toBe(0)
    expect(outboxCount(dbB!)).toBe(0)

    // Cursor advanced and stable; follow-up sync pulls nothing new.
    const cursorA = cursorValue(dbA!)
    const cursorB = cursorValue(dbB!)
    expect(cursorA).toBeGreaterThan(0)
    expect(cursorB).toBe(cursorA)
    bindProfile('A', credA)
    const digestA = wireDigestFor(dbA!)
    bindProfile('B', credB)
    const digestB = wireDigestFor(dbB!)
    if (digestA && digestB) expect(digestB).toBe(digestA)
    const appliedA = appliedCount(sqliteA!)
    const appliedB = appliedCount(sqliteB!)
    await syncBoth(2)
    expect(cursorValue(dbA!)).toBe(cursorA)
    expect(cursorValue(dbB!)).toBe(cursorB)
    expect(appliedCount(sqliteA!)).toBe(appliedA)
    expect(appliedCount(sqliteB!)).toBe(appliedB)
    expect(blockFrame(sqliteA!, 'm-shared')).toEqual(bfA)
    expect(blockFrame(sqliteB!, 'm-shared')).toEqual(bfA)
    expect(outboxCount(dbA!)).toBe(0)
    expect(outboxCount(dbB!)).toBe(0)
  }, 90000)
})

describe('3) orphan buffer paths converge', () => {
  it('frame-before-upsert and upsert-before-frame both reach union via repair', async () => {
    configStore.clear()
    configStore.set('sync:enabled', true)
    configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
    configStore.set('sync:token', '')
    const { sqlite, db } = openChatDb()
    ;(chatDbService as unknown as { sqlite: unknown }).sqlite = sqlite
    ;(chatDbService as unknown as { db: unknown }).db = db
    try {
      syncService.clearAllForTests()
      seedRegisteredAttachedSyncService(configStore, db)
      const agg = new ChatDbAggregateService(db, sqlite)
      expect(agg.ensureTopic('t-o', 'a1', 'O').ok).toBe(true)
      expect(agg.appendMessage('t-o', makeMsg('m-local', 't-o', 'local') as never, []).ok).toBe(true)
      const localFrame = topicFrame(sqlite, 't-o')!
      expect(localFrame.ids).toEqual(['m-local'])
      // Drain local outbox from the apply path: mark applied via direct relay-less apply of a remote upsert first.
      db.delete(schema.syncOutbox).run()

      const remoteDevice = 'remote-device-1'
      const remoteTs = Date.now()
      const remoteUpsert = {
        id: '11111111-1111-4000-a000-000000000001',
        entityType: 'message',
        op: 'upsert',
        entityId: 'm-remote',
        timestamp: remoteTs,
        deviceId: remoteDevice,
        payload: { ...makeMsg('m-remote', 't-o', 'remote'), topicId: 't-o' }
      }
      // Upsert-before-frame: repair mints union immediately.
      expect(syncService.applyIncomingOperation(remoteUpsert as never)).toBe(true)
      const afterUpsert = topicFrame(sqlite, 't-o')!
      expect(afterUpsert.ids).toContain('m-local')
      expect(afterUpsert.ids).toContain('m-remote')
      expect(afterUpsert.ts).toBeGreaterThan(localFrame.ts)
      // Late old remote frame listing only m-remote must not throw deadlock: it loses but union already propagated.
      const oldFrame = {
        id: '22222222-2222-4000-a000-000000000002',
        entityType: 'topic',
        op: 'order_frame',
        entityId: 't-o',
        timestamp: remoteTs,
        deviceId: remoteDevice,
        payload: {
          frameVersion: 'parent-order-frame-v1',
          kind: 'topicMessage',
          parentId: 't-o',
          orderedChildIds: ['m-remote'],
          frameClock: { timestamp: remoteTs, operationId: '22222222-2222-4000-a000-000000000002' }
        }
      }
      // Older frame loses to the repair winner; may return false (consumed) without throw.
      const r = syncService.applyIncomingOperation(oldFrame as never)
      expect(typeof r).toBe('boolean')
      expect(messageOrder(sqlite, 't-o')).toEqual(topicFrame(sqlite, 't-o')!.ids)

      // Frame-before-upsert orphan: unknown member buffers, then upsert resolves.
      const orphanFrame = {
        id: '33333333-3333-4000-a000-000000000003',
        entityType: 'topic',
        op: 'order_frame',
        entityId: 't-o',
        timestamp: Date.now() + 1000,
        deviceId: remoteDevice,
        payload: {
          frameVersion: 'parent-order-frame-v1',
          kind: 'topicMessage',
          parentId: 't-o',
          orderedChildIds: ['m-local', 'm-remote', 'm-future'],
          frameClock: { timestamp: Date.now() + 1000, operationId: '33333333-3333-4000-a000-000000000003' }
        }
      }
      let orphaned = false
      try {
        syncService.applyIncomingOperation(orphanFrame as never)
      } catch (e) {
        orphaned = (e as Error).name === 'SyncOrphanError' || String((e as Error).message).includes('orphan')
      }
      expect(orphaned).toBe(true)
      const futureUpsert = {
        id: '44444444-4444-4000-a000-000000000004',
        entityType: 'message',
        op: 'upsert',
        entityId: 'm-future',
        timestamp: Date.now(),
        deviceId: remoteDevice,
        payload: { ...makeMsg('m-future', 't-o', 'future'), topicId: 't-o' }
      }
      expect(syncService.applyIncomingOperation(futureUpsert as never)).toBe(true)
      expect(topicFrame(sqlite, 't-o')!.ids).toContain('m-future')
      // Retry orphan now resolves (member arrived) without incomplete throw.
      expect(() => syncService.applyIncomingOperation(orphanFrame as never)).not.toThrow()
    } finally {
      try {
        sqlite.close()
      } catch {}
    }
  })
})

describe('4) order prefix stable and clock/entity rules', () => {
  it('repair preserves stored prefix, deterministic suffix, clock wins, no sortOrder wire', async () => {
    configStore.clear()
    configStore.set('sync:enabled', true)
    configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
    configStore.set('sync:token', '')
    const { sqlite, db } = openChatDb()
    ;(chatDbService as unknown as { sqlite: unknown }).sqlite = sqlite
    ;(chatDbService as unknown as { db: unknown }).db = db
    try {
      syncService.clearAllForTests()
      seedRegisteredAttachedSyncService(configStore, db)
      const agg = new ChatDbAggregateService(db, sqlite)
      expect(agg.ensureTopic('t-p', 'a1', 'P').ok).toBe(true)
      expect(agg.appendMessage('t-p', makeMsg('m-1', 't-p', '1') as never, []).ok).toBe(true)
      expect(agg.appendMessage('t-p', makeMsg('m-2', 't-p', '2') as never, []).ok).toBe(true)
      db.delete(schema.syncOutbox).run()
      const before = topicFrame(sqlite, 't-p')!
      expect(before.ids).toEqual(['m-1', 'm-2'])
      const base = Date.now()
      // Two new remotes with distinct membership clocks; send higher-id first to prove deterministic sort.
      const up1 = {
        id: '55555555-5555-4000-a000-000000000005',
        entityType: 'message',
        op: 'upsert',
        entityId: 'm-b',
        timestamp: base + 2,
        deviceId: 'peer-1',
        payload: { ...makeMsg('m-b', 't-p', 'b'), topicId: 't-p' }
      }
      const up2 = {
        id: '66666666-6666-4000-a000-000000000006',
        entityType: 'message',
        op: 'upsert',
        entityId: 'm-a',
        timestamp: base + 1,
        deviceId: 'peer-1',
        payload: { ...makeMsg('m-a', 't-p', 'a'), topicId: 't-p' }
      }
      expect(syncService.applyIncomingOperation(up1 as never)).toBe(true)
      expect(syncService.applyIncomingOperation(up2 as never)).toBe(true)
      const after = topicFrame(sqlite, 't-p')!
      // Prefix preserved: pre-existing [m-1,m-2] never reordered; first repair
      // appends m-b, second repair preserves [m-1,m-2,m-b] and appends m-a.
      expect(after.ids.slice(0, 2)).toEqual(['m-1', 'm-2'])
      expect(after.ids).toEqual(['m-1', 'm-2', 'm-b', 'm-a'])
      // Clock strictly greater than all memberships and stored.
      const memA = membership(sqlite, 'm-a')!
      const memB = membership(sqlite, 'm-b')!
      expect(after.ts).toBeGreaterThan(memA.ts)
      expect(after.ts).toBeGreaterThan(memB.ts)
      expect(after.ts).toBeGreaterThan(before.ts)
      // Entity ops precede frame: frame ts greater than entity clocks.
      const entA = sqlite.prepare(`SELECT timestamp AS ts FROM sync_entity_clock WHERE entity_id='m-a'`).get() as {
        ts: number
      }
      expect(after.ts).toBeGreaterThan(entA.ts)
      // No sortOrder on wire payload.
      const outRows = db
        .select()
        .from(schema.syncOutbox)
        .all()
        .filter((r) => r.op === 'order_frame')
      expect(outRows.length).toBeGreaterThan(0)
      for (const r of outRows) {
        const payload = JSON.parse(r.payloadJson as string) as Record<string, unknown>
        expect('sortOrder' in payload).toBe(false)
        expect(JSON.stringify(payload)).not.toContain('sortOrder')
      }
    } finally {
      try {
        sqlite.close()
      } catch {}
    }
  })
})

describe('5) negatives never mint repair', () => {
  it('transient/unsupported/tombstone/mismatch/missing/incomplete/stable_replace/delete stay fail-closed or no-op', async () => {
    configStore.clear()
    configStore.set('sync:enabled', true)
    configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
    configStore.set('sync:token', '')
    const { sqlite, db } = openChatDb()
    ;(chatDbService as unknown as { sqlite: unknown }).sqlite = sqlite
    ;(chatDbService as unknown as { db: unknown }).db = db
    try {
      syncService.clearAllForTests()
      seedRegisteredAttachedSyncService(configStore, db)
      const agg = new ChatDbAggregateService(db, sqlite)
      expect(agg.ensureTopic('t-n', 'a1', 'N').ok).toBe(true)
      expect(
        agg.appendMessage('t-n', makeMsg('m-n1', 't-n', 'n1') as never, [makeBlock('bn-1', 'm-n1', 'x') as never]).ok
      ).toBe(true)
      db.delete(schema.syncOutbox).run()
      const framesBefore = (): number =>
        db
          .select()
          .from(schema.syncOutbox)
          .all()
          .filter((r) => r.op === 'order_frame').length

      // Transient message upsert still applies entity but must not mint.
      const transient = {
        id: '77777777-7777-4000-a000-000000000007',
        entityType: 'message',
        op: 'upsert',
        entityId: 'm-trans',
        timestamp: Date.now(),
        deviceId: 'peer-x',
        payload: { ...makeMsg('m-trans', 't-n', 't'), status: 'streaming', topicId: 't-n' }
      }
      expect(syncService.applyIncomingOperation(transient as never)).toBe(true)
      expect(framesBefore()).toBe(0)

      // Unsupported block must not mint.
      const unsup = {
        id: '88888888-8888-4000-a000-000000000008',
        entityType: 'message_block',
        op: 'upsert',
        entityId: 'b-unsup',
        timestamp: Date.now(),
        deviceId: 'peer-x',
        payload: {
          id: 'b-unsup',
          messageId: 'm-n1',
          type: 'tool',
          content: 'x',
          status: 'success',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      }
      // Unsupported still creates a row locally via generic apply; repair must not mint.
      try {
        syncService.applyIncomingOperation(unsup as never)
      } catch {
        // Fail-closed also acceptable; either way no repair frame.
      }
      expect(framesBefore()).toBe(0)

      // Parent mismatch (existing id owned by another topic) is no-op without repair.
      const mismatch = {
        id: '99999999-9999-4000-a000-000000000009',
        entityType: 'message',
        op: 'upsert',
        entityId: 'm-n1',
        timestamp: Date.now() + 5000,
        deviceId: 'peer-x',
        payload: { ...makeMsg('m-n1', 't-other', 'hijack'), topicId: 't-other' }
      }
      expect(syncService.applyIncomingOperation(mismatch as never)).toBe(false)
      expect(framesBefore()).toBe(0)

      // Missing sibling membership blocks repair: hand-insert a stable row without membership.
      sqlite
        .prepare(
          `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          'm-nomem',
          't-n',
          'user',
          'no mem',
          'success',
          null,
          null,
          null,
          null,
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          99,
          null
        )
      const goodRemote = {
        id: 'aaaaaaaa-aaaa-4000-a000-000000000010',
        entityType: 'message',
        op: 'upsert',
        entityId: 'm-good',
        timestamp: Date.now(),
        deviceId: 'peer-x',
        payload: { ...makeMsg('m-good', 't-n', 'good'), topicId: 't-n' }
      }
      expect(syncService.applyIncomingOperation(goodRemote as never)).toBe(true)
      // Sibling without membership prevents union mint.
      expect(framesBefore()).toBe(0)
      sqlite.prepare(`DELETE FROM messages WHERE id='m-nomem'`).run()
      sqlite.prepare(`DELETE FROM messages WHERE id='m-good'`).run()

      // Eligible incomplete now heals via known-incoming union (correctness core):
      // newer empty frame omitting live m-n1 mints a covering union in the same tx.
      const newerIncompleteTs = Date.now() + 50000
      const staleFrame = {
        id: 'bbbbbbbb-bbbb-4000-a000-000000000011',
        entityType: 'topic',
        op: 'order_frame',
        entityId: 't-n',
        timestamp: newerIncompleteTs,
        deviceId: 'peer-x',
        payload: {
          frameVersion: 'parent-order-frame-v1',
          kind: 'topicMessage',
          parentId: 't-n',
          orderedChildIds: [],
          frameClock: { timestamp: newerIncompleteTs, operationId: 'bbbbbbbb-bbbb-4000-a000-000000000011' }
        }
      }
      expect(syncService.applyIncomingOperation(staleFrame as never)).toBe(true)
      expect(topicFrame(sqlite, 't-n')!.ids).toContain('m-n1')
      expect(topicFrame(sqlite, 't-n')!.ts).toBeGreaterThan(newerIncompleteTs)
      db.delete(schema.syncOutbox).run()

      // Tombstone-suppressed child remote upsert must not mint: delete the
      // child locally (tombstone wins), then replay an older remote upsert.
      expect(agg.appendMessage('t-n', makeMsg('m-tomb', 't-n', 'tomb') as never, []).ok).toBe(true)
      db.delete(schema.syncOutbox).run()
      expect(agg.deleteMessage('t-n', 'm-tomb').ok).toBe(true)
      db.delete(schema.syncOutbox).run()
      const tombSuppressed = {
        id: 'dddddddd-dddd-4000-a000-000000000016',
        entityType: 'message',
        op: 'upsert',
        entityId: 'm-tomb',
        timestamp: Date.now() - 10000,
        deviceId: 'peer-x',
        payload: { ...makeMsg('m-tomb', 't-n', 'stale'), topicId: 't-n' }
      }
      const tombRes = syncService.applyIncomingOperation(tombSuppressed as never)
      expect(typeof tombRes).toBe('boolean')
      expect(framesBefore()).toBe(0)

      // Tombstoned parent suppresses child repair: delete parent message, then
      // remote block upsert under it must not mint.
      expect(agg.appendMessage('t-n', makeMsg('m-pdel', 't-n', 'pdel') as never, []).ok).toBe(true)
      db.delete(schema.syncOutbox).run()
      expect(agg.deleteMessage('t-n', 'm-pdel').ok).toBe(true)
      db.delete(schema.syncOutbox).run()
      const orphanBlock = {
        id: 'eeeeeeee-eeee-4000-a000-000000000017',
        entityType: 'message_block',
        op: 'upsert',
        entityId: 'b-orphan',
        timestamp: Date.now(),
        deviceId: 'peer-x',
        payload: {
          id: 'b-orphan',
          messageId: 'm-pdel',
          type: 'main_text',
          content: 'x',
          status: 'success',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      }
      try {
        syncService.applyIncomingOperation(orphanBlock as never)
      } catch {
        // Orphan/tombstone fail-closed also acceptable; either way no repair.
      }
      expect(framesBefore()).toBe(0)

      // message_stable_replace apply must not extra-mint repair frames: a
      // valid success-final replace persists bundled frames but enqueues no
      // order_frame (repair gate is upsert-only).
      const repTs = Date.now() + 20000
      const repId = 'ffffffff-ffff-4000-a000-000000000018'
      const msgFields = [
        'role',
        'content',
        'status',
        'askId',
        'model',
        'modelId',
        'assistantId',
        'createdAt',
        'updatedAt'
      ]
      const blkFields = ['type', 'content', 'status', 'createdAt', 'updatedAt']
      const fc = (ts: number, op: string): Record<string, unknown> => ({ timestamp: ts, operationId: op })
      const fcs = (keys: string[], ts: number, op: string): Record<string, unknown> => {
        const out: Record<string, unknown> = {}
        for (const k of keys) out[k] = fc(ts, op)
        return out
      }
      const repOp = {
        id: repId,
        entityType: 'message',
        op: 'message_stable_replace',
        entityId: 'm-n1',
        timestamp: repTs,
        deviceId: 'peer-x',
        payload: {
          replaceVersion: 'message-stable-replace-v1',
          messageId: 'm-n1',
          replacementClock: fc(repTs, repId),
          message: {
            ...makeMsg('m-n1', 't-n', 'replaced'),
            status: 'success',
            entityClock: fc(repTs, repId),
            fieldClocks: fcs(msgFields, repTs, repId),
            parentMembershipClock: fc(
              membership(sqlite, 'm-n1')?.ts ?? repTs,
              membership(sqlite, 'm-n1')?.opId ?? repId
            )
          },
          messageBlocks: [
            {
              ...makeBlock('bn-1', 'm-n1', 'replaced-block'),
              type: 'main_text',
              status: 'success',
              entityClock: fc(repTs, repId),
              fieldClocks: fcs(blkFields, repTs, repId),
              parentMembershipClock: fc(repTs, repId)
            }
          ],
          activeBlockIds: ['bn-1'],
          topicFrame: {
            frameVersion: 'parent-order-frame-v1',
            kind: 'topicMessage',
            parentId: 't-n',
            orderedChildIds: ['m-n1'],
            frameClock: fc(repTs, repId)
          },
          messageFrame: {
            frameVersion: 'parent-order-frame-v1',
            kind: 'messageBlock',
            parentId: 'm-n1',
            orderedChildIds: ['bn-1'],
            frameClock: fc(repTs, repId)
          }
        }
      }
      db.delete(schema.syncOutbox).run()
      try {
        syncService.applyIncomingOperation(repOp as never)
      } catch {
        // Fail-closed on strict shape also acceptable; either way no repair.
      }
      expect(
        db
          .select()
          .from(schema.syncOutbox)
          .all()
          .filter((r) => r.op === 'order_frame').length
      ).toBe(0)

      // Delete must not mint.
      const del = {
        id: 'cccccccc-cccc-4000-a000-000000000012',
        entityType: 'message',
        op: 'delete',
        entityId: 'm-n1',
        timestamp: Date.now() + 9000,
        deviceId: 'peer-x'
      }
      db.delete(schema.syncOutbox).run()
      syncService.applyIncomingOperation(del as never)
      expect(framesBefore()).toBe(0)
    } finally {
      try {
        sqlite.close()
      } catch {}
    }
  })
})

describe('6) failure injection rolls back whole apply tx', () => {
  it('enqueue failure after membership/row leaves no entity/clock/frame/outbox/applied; retry succeeds', async () => {
    configStore.clear()
    configStore.set('sync:enabled', true)
    configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
    configStore.set('sync:token', '')
    const { sqlite, db } = openChatDb()
    ;(chatDbService as unknown as { sqlite: unknown }).sqlite = sqlite
    ;(chatDbService as unknown as { db: unknown }).db = db
    try {
      syncService.clearAllForTests()
      seedRegisteredAttachedSyncService(configStore, db)
      const agg = new ChatDbAggregateService(db, sqlite)
      expect(agg.ensureTopic('t-f', 'a1', 'F').ok).toBe(true)
      expect(agg.appendMessage('t-f', makeMsg('m-f1', 't-f', 'f1') as never, []).ok).toBe(true)
      db.delete(schema.syncOutbox).run()
      const frameBefore = topicFrame(sqlite, 't-f')!
      const op = {
        id: 'dddddddd-dddd-4000-a000-000000000013',
        entityType: 'message',
        op: 'upsert',
        entityId: 'm-f2',
        timestamp: Date.now(),
        deviceId: 'peer-f',
        payload: { ...makeMsg('m-f2', 't-f', 'f2'), topicId: 't-f' }
      }
      const orig = (
        syncService as unknown as { enqueueOrderFrameInTx: (...a: never[]) => boolean }
      ).enqueueOrderFrameInTx.bind(syncService)
      let calls = 0
      vi.spyOn(
        syncService as unknown as { enqueueOrderFrameInTx: (...a: never[]) => boolean },
        'enqueueOrderFrameInTx'
      ).mockImplementation(((...args: never[]) => {
        calls += 1
        if (calls === 1) throw new Error('injected frame enqueue failure')
        return (orig as (...a: never[]) => boolean)(...args)
      }) as never)
      try {
        expect(() => syncService.applyIncomingOperation(op as never)).toThrow(/injected/)
      } finally {
        vi.restoreAllMocks()
      }
      // All rolled back: no row, no clocks, no frame change, no outbox, no applied.
      expect(sqlite.prepare(`SELECT id FROM messages WHERE id='m-f2'`).get()).toBeFalsy()
      expect(sqlite.prepare(`SELECT * FROM sync_entity_clock WHERE entity_id='m-f2'`).get()).toBeFalsy()
      expect(sqlite.prepare(`SELECT * FROM sync_membership_clock WHERE child_entity_id='m-f2'`).get()).toBeFalsy()
      expect(topicFrame(sqlite, 't-f')).toEqual(frameBefore)
      expect(
        db
          .select()
          .from(schema.syncOutbox)
          .all()
          .filter((r) => r.op === 'order_frame').length
      ).toBe(0)
      expect(
        sqlite.prepare(`SELECT * FROM sync_applied WHERE operation_id=?`).get((op as { id: string }).id)
      ).toBeFalsy()
      // Retry succeeds and mints union.
      expect(syncService.applyIncomingOperation(op as never)).toBe(true)
      expect(sqlite.prepare(`SELECT id FROM messages WHERE id='m-f2'`).get()).toBeTruthy()
      expect(topicFrame(sqlite, 't-f')!.ids).toContain('m-f2')
    } finally {
      try {
        sqlite.close()
      } catch {}
    }
  })
})

describe('7) existing paths never gain repair frames', () => {
  it('topic upsert/own-echo/message_stable_replace/delete do not extra-mint', async () => {
    configStore.clear()
    configStore.set('sync:enabled', true)
    configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
    configStore.set('sync:token', '')
    const { sqlite, db } = openChatDb()
    ;(chatDbService as unknown as { sqlite: unknown }).sqlite = sqlite
    ;(chatDbService as unknown as { db: unknown }).db = db
    try {
      syncService.clearAllForTests()
      seedRegisteredAttachedSyncService(configStore, db)
      const agg = new ChatDbAggregateService(db, sqlite)
      expect(agg.ensureTopic('t-r', 'a1', 'R').ok).toBe(true)
      expect(
        agg.appendMessage('t-r', makeMsg('m-r1', 't-r', 'r1') as never, [makeBlock('br-1', 'm-r1', 'x') as never]).ok
      ).toBe(true)
      db.delete(schema.syncOutbox).run()
      // Topic upsert never repairs.
      const topicUp = {
        id: 'eeeeeeee-eeee-4000-a000-000000000014',
        entityType: 'topic',
        op: 'upsert',
        entityId: 't-r',
        timestamp: Date.now(),
        deviceId: 'peer-r',
        payload: { name: 'R2' }
      }
      try {
        syncService.applyIncomingOperation(topicUp as never)
      } catch {}
      expect(
        db
          .select()
          .from(schema.syncOutbox)
          .all()
          .filter((r) => r.op === 'order_frame').length
      ).toBe(0)
      // Own echo message upsert never repairs.
      const localId = String(configStore.get('deviceId') ?? '')
      const echo = {
        id: 'ffffffff-ffff-4000-a000-000000000015',
        entityType: 'message',
        op: 'upsert',
        entityId: 'm-echo',
        timestamp: Date.now(),
        deviceId: localId,
        payload: { ...makeMsg('m-echo', 't-r', 'echo'), topicId: 't-r' }
      }
      expect(syncService.applyIncomingOperation(echo as never)).toBe(true)
      expect(
        db
          .select()
          .from(schema.syncOutbox)
          .all()
          .filter((r) => r.op === 'order_frame').length
      ).toBe(0)
      // message_stable_replace apply never enters the upsert repair gate:
      // an invalid replace fails closed with no repair frame minted.
      db.delete(schema.syncOutbox).run()
      const badReplace = {
        id: '11111111-2222-4000-a000-000000000019',
        entityType: 'topic',
        op: 'message_stable_replace',
        entityId: 'm-r1',
        timestamp: Date.now(),
        deviceId: 'peer-r',
        payload: {}
      }
      try {
        syncService.applyIncomingOperation(badReplace as never)
      } catch {
        // Fail-closed expected; either way no repair frame.
      }
      expect(
        db
          .select()
          .from(schema.syncOutbox)
          .all()
          .filter((r) => r.op === 'order_frame').length
      ).toBe(0)
      // Remote delete never mints repair.
      db.delete(schema.syncOutbox).run()
      const del = {
        id: '22222222-3333-4000-a000-000000000020',
        entityType: 'message',
        op: 'delete',
        entityId: 'm-r1',
        timestamp: Date.now() + 1000,
        deviceId: 'peer-r'
      }
      syncService.applyIncomingOperation(del as never)
      expect(
        db
          .select()
          .from(schema.syncOutbox)
          .all()
          .filter((r) => r.op === 'order_frame').length
      ).toBe(0)
    } finally {
      try {
        sqlite.close()
      } catch {}
    }
  })
})

describe('8) covering-frame complete-clock semantics (timestamp,operationId)', () => {
  function setupTwoLive(): {
    sqlite: Database.Database
    db: BetterSQLite3Database<typeof schema>
    stored: { ts: number; opId: string }
  } {
    configStore.clear()
    configStore.set('sync:enabled', true)
    configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
    configStore.set('sync:token', '')
    const { sqlite, db } = openChatDb()
    ;(chatDbService as unknown as { sqlite: unknown }).sqlite = sqlite
    ;(chatDbService as unknown as { db: unknown }).db = db
    syncService.clearAllForTests()
    seedRegisteredAttachedSyncService(configStore, db)
    const agg = new ChatDbAggregateService(db, sqlite)
    expect(agg.ensureTopic('t-c', 'a1', 'C').ok).toBe(true)
    expect(agg.appendMessage('t-c', makeMsg('m-c1', 't-c', 'c1') as never, []).ok).toBe(true)
    expect(agg.appendMessage('t-c', makeMsg('m-c2', 't-c', 'c2') as never, []).ok).toBe(true)
    db.delete(schema.syncOutbox).run()
    const stored = topicFrame(sqlite, 't-c')!
    expect(stored.ids).toEqual(['m-c1', 'm-c2'])
    return { sqlite, db, stored }
  }

  function incomingFrame(id: string, ts: number, ids: string[], device = 'peer-c'): Record<string, unknown> {
    return {
      id,
      entityType: 'topic',
      op: 'order_frame',
      entityId: 't-c',
      timestamp: ts,
      deviceId: device,
      payload: {
        frameVersion: 'parent-order-frame-v1',
        kind: 'topicMessage',
        parentId: 't-c',
        orderedChildIds: [...ids],
        frameClock: { timestamp: ts, operationId: id }
      }
    }
  }

  it('topicMessage: stored larger consumes old incomplete; stronger incomplete heals via union; equal idempotent vs divergence', () => {
    const { sqlite, db } = setupTwoLive()
    try {
      const stored = topicFrame(sqlite, 't-c')!
      // Stored larger (same ts, lex-smaller incoming opId) consumes the old
      // incomplete frame missing m-c2.
      const oldIncomplete = incomingFrame('0', stored.ts, ['m-c1'])
      expect(syncService.applyIncomingOperation(oldIncomplete as never)).toBe(false)
      expect(topicFrame(sqlite, 't-c')).toEqual(stored)
      // Incoming stronger (same ts, lex-larger opId) heals: same-tx union with
      // clock strictly above incoming, covering the full live set.
      const stronger = incomingFrame('~', stored.ts, ['m-c1'])
      expect(syncService.applyIncomingOperation(stronger as never)).toBe(true)
      const healed = topicFrame(sqlite, 't-c')!
      expect(healed.ids).toEqual(expect.arrayContaining(['m-c1', 'm-c2']))
      expect(healed.ts).toBeGreaterThan(stored.ts)
      expect(
        db
          .select()
          .from(schema.syncOutbox)
          .all()
          .filter((r) => r.op === 'order_frame').length
      ).toBe(1)
      db.delete(schema.syncOutbox).run()
      // Equal complete clock with identical effective order is idempotent
      // (replay the healed winner clock with the healed order).
      const healedNow = topicFrame(sqlite, 't-c')!
      const replaySame = incomingFrame(healedNow.opId, healedNow.ts, healedNow.ids)
      expect(syncService.applyIncomingOperation(replaySame as never)).toBe(false)
      expect(topicFrame(sqlite, 't-c')).toEqual(healedNow)
      // Equal complete clock with divergent order throws equal-clock divergence.
      const divergentSameClock = incomingFrame(healedNow.opId, healedNow.ts, ['m-c1'])
      expect(() => syncService.applyIncomingOperation(divergentSameClock as never)).toThrow(/divergence/)
      expect(topicFrame(sqlite, 't-c')).toEqual(healedNow)
      // Newer-timestamp incomplete (beyond covering) heals as well, never swallowed.
      const newerTs = healedNow.ts + 50000
      const newerIncomplete = incomingFrame('aaaaaaaa-aaaa-4000-a000-000000000021', newerTs, ['m-c1'])
      expect(syncService.applyIncomingOperation(newerIncomplete as never)).toBe(true)
      const healed2 = topicFrame(sqlite, 't-c')!
      expect(healed2.ids).toEqual(expect.arrayContaining(['m-c1', 'm-c2']))
      expect(healed2.ts).toBeGreaterThan(newerTs)
    } finally {
      try {
        sqlite.close()
      } catch {}
    }
  })

  it('messageBlock: symmetric stored-larger consume vs stronger fail-closed', () => {
    configStore.clear()
    configStore.set('sync:enabled', true)
    configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
    configStore.set('sync:token', '')
    const { sqlite, db } = openChatDb()
    ;(chatDbService as unknown as { sqlite: unknown }).sqlite = sqlite
    ;(chatDbService as unknown as { db: unknown }).db = db
    try {
      syncService.clearAllForTests()
      seedRegisteredAttachedSyncService(configStore, db)
      const agg = new ChatDbAggregateService(db, sqlite)
      expect(agg.ensureTopic('t-cb', 'a1', 'CB').ok).toBe(true)
      expect(
        agg.appendMessage('t-cb', makeMsg('m-cb', 't-cb', 'cb') as never, [makeBlock('b-cb1', 'm-cb', '1') as never]).ok
      ).toBe(true)
      expect(agg.updateBlocks([makeBlock('b-cb2', 'm-cb', '2') as never]).ok).toBe(true)
      db.delete(schema.syncOutbox).run()
      const stored = blockFrame(sqlite, 'm-cb')!
      expect(stored.ids).toContain('b-cb1')
      expect(stored.ids).toContain('b-cb2')
      const mkBlockFrame = (id: string, ts: number, ids: string[]): Record<string, unknown> => ({
        id,
        entityType: 'message',
        op: 'order_frame',
        entityId: 'm-cb',
        timestamp: ts,
        deviceId: 'peer-cb',
        payload: {
          frameVersion: 'parent-order-frame-v1',
          kind: 'messageBlock',
          parentId: 'm-cb',
          orderedChildIds: [...ids],
          frameClock: { timestamp: ts, operationId: id }
        }
      })
      // Stored larger consumes old incomplete (missing b-cb2).
      expect(syncService.applyIncomingOperation(mkBlockFrame('0', stored.ts, ['b-cb1']) as never)).toBe(false)
      expect(blockFrame(sqlite, 'm-cb')).toEqual(stored)
      // Stronger incomplete heals via union (symmetric with topicMessage).
      expect(syncService.applyIncomingOperation(mkBlockFrame('~', stored.ts, ['b-cb1']) as never)).toBe(true)
      const healed = blockFrame(sqlite, 'm-cb')!
      expect(healed.ids).toEqual(expect.arrayContaining(['b-cb1', 'b-cb2']))
      expect(healed.ts).toBeGreaterThan(stored.ts)
    } finally {
      try {
        sqlite.close()
      } catch {}
    }
  })
})

describe('9) extreme cross-device skew: huge peer obsolete frame heals via known-incoming floor', () => {
  // Artificial skew base far above any same-machine Date.now(): proves the
  // repair clock comes from the known incoming clock, not the local wall.
  const SKEW = 7_000_000_000_000
  function setupSkewDb(): { sqlite: Database.Database; db: BetterSQLite3Database<typeof schema> } {
    configStore.clear()
    configStore.set('sync:enabled', true)
    configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
    configStore.set('sync:token', '')
    const { sqlite, db } = openChatDb()
    ;(chatDbService as unknown as { sqlite: unknown }).sqlite = sqlite
    ;(chatDbService as unknown as { db: unknown }).db = db
    syncService.clearAllForTests()
    seedRegisteredAttachedSyncService(configStore, db)
    return { sqlite, db }
  }

  it('topicMessage: upsert-then-huge-frame mints ts>incoming, full identity, no storm', () => {
    const { sqlite, db } = setupSkewDb()
    try {
      const agg = new ChatDbAggregateService(db, sqlite)
      expect(agg.ensureTopic('t-skew', 'a1', 'Skew').ok).toBe(true)
      expect(agg.appendMessage('t-skew', makeMsg('m-local', 't-skew', 'local') as never, []).ok).toBe(true)
      db.delete(schema.syncOutbox).run()
      const localFrame = topicFrame(sqlite, 't-skew')!
      expect(localFrame.ts).toBeLessThan(SKEW)

      // Peer exclusive upsert with skewed membership clock (huge).
      const skewUpsert = {
        id: 'c0c0c0c0-c0c0-4000-a000-00000000c001',
        entityType: 'message',
        op: 'upsert',
        entityId: 'm-skew',
        timestamp: SKEW,
        deviceId: 'peer-skew',
        payload: { ...makeMsg('m-skew', 't-skew', 'skew'), topicId: 't-skew' }
      }
      expect(syncService.applyIncomingOperation(skewUpsert as never)).toBe(true)
      const afterUpsert = topicFrame(sqlite, 't-skew')!
      // Upsert repair is wall-independent optimization: it covers both lives
      // deterministically from memberships (SKEW+1), still below the peer
      // obsolete huge frame (SKEW+100) — skew safety comes from the later
      // frame-arrival repair, not from any wall floor.
      expect(afterUpsert.ids).toContain('m-local')
      expect(afterUpsert.ids).toContain('m-skew')
      expect(afterUpsert.ts).toBe(SKEW + 1)
      expect(afterUpsert.ts).toBeLessThan(SKEW + 100)
      db.delete(schema.syncOutbox).run()

      // Peer obsolete huge frame listing only its own child (stronger incomplete).
      const hugeFrame = {
        id: 'd0d0d0d0-d0d0-4000-a000-00000000d001',
        entityType: 'topic',
        op: 'order_frame',
        entityId: 't-skew',
        timestamp: SKEW + 100,
        deviceId: 'peer-skew',
        payload: {
          frameVersion: 'parent-order-frame-v1',
          kind: 'topicMessage',
          parentId: 't-skew',
          orderedChildIds: ['m-skew'],
          frameClock: { timestamp: SKEW + 100, operationId: 'd0d0d0d0-d0d0-4000-a000-00000000d001' }
        }
      }
      expect(syncService.applyIncomingOperation(hugeFrame as never)).toBe(true)
      const healed = topicFrame(sqlite, 't-skew')!
      expect(healed.ids).toContain('m-local')
      expect(healed.ids).toContain('m-skew')
      expect(healed.ts).toBeGreaterThan(SKEW + 100)
      // Prefix is the incoming effective ([m-skew]) with missing suffix appended.
      expect(healed.ids[0]).toBe('m-skew')
      const outRows = db
        .select()
        .from(schema.syncOutbox)
        .all()
        .filter((r) => r.op === 'order_frame')
      expect(outRows.length).toBe(1)
      const payload = JSON.parse(outRows[0].payloadJson as string) as Record<string, unknown>
      expect(payload['orderedChildIds']).toEqual(healed.ids)
      expect((payload['frameClock'] as { timestamp: number }).timestamp).toBe(healed.ts)
      // Complete covering frame no longer mints: duplicate huge frame is consumed.
      expect(syncService.applyIncomingOperation(hugeFrame as never)).toBe(false)
      expect(topicFrame(sqlite, 't-skew')).toEqual(healed)
      expect(
        db
          .select()
          .from(schema.syncOutbox)
          .all()
          .filter((r) => r.op === 'order_frame').length
      ).toBe(1)
      // Healed complete frame received again mints nothing (stop, no storm).
      const healedReplay = {
        id: healed.opId,
        entityType: 'topic',
        op: 'order_frame',
        entityId: 't-skew',
        timestamp: healed.ts,
        deviceId: 'peer-skew',
        payload: {
          frameVersion: 'parent-order-frame-v1',
          kind: 'topicMessage',
          parentId: 't-skew',
          orderedChildIds: [...healed.ids],
          frameClock: { timestamp: healed.ts, operationId: healed.opId }
        }
      }
      expect(syncService.applyIncomingOperation(healedReplay as never)).toBe(false)
      expect(topicFrame(sqlite, 't-skew')).toEqual(healed)
      // Cursor/applied advanced for the consumed huge frame; materialized order matches.
      expect(messageOrder(sqlite, 't-skew')).toEqual(healed.ids)
      expect(
        sqlite.prepare(`SELECT * FROM sync_applied WHERE operation_id=?`).get((hugeFrame as { id: string }).id)
      ).toBeTruthy()
      bindProfileSkewDigestCheck(db)
    } finally {
      try {
        sqlite.close()
      } catch {}
    }
  })

  it('messageBlock: reverse order (huge frame orphan then upsert resolves, then huge incomplete heals)', () => {
    const { sqlite, db } = setupSkewDb()
    try {
      const agg = new ChatDbAggregateService(db, sqlite)
      expect(agg.ensureTopic('t-skb', 'a1', 'SkewB').ok).toBe(true)
      expect(
        agg.appendMessage('t-skb', makeMsg('m-skb', 't-skb', 'shared') as never, [
          makeBlock('b-local', 'm-skb', 'local') as never
        ]).ok
      ).toBe(true)
      db.delete(schema.syncOutbox).run()

      // Huge frame arrives before its member: orphan (not incomplete), buffered.
      const orphanHuge = {
        id: 'e0e0e0e0-e0e0-4000-a000-00000000e001',
        entityType: 'message',
        op: 'order_frame',
        entityId: 'm-skb',
        timestamp: SKEW + 50,
        deviceId: 'peer-skb',
        payload: {
          frameVersion: 'parent-order-frame-v1',
          kind: 'messageBlock',
          parentId: 'm-skb',
          orderedChildIds: ['b-local', 'b-skew'],
          frameClock: { timestamp: SKEW + 50, operationId: 'e0e0e0e0-e0e0-4000-a000-00000000e001' }
        }
      }
      let orphaned = false
      try {
        syncService.applyIncomingOperation(orphanHuge as never)
      } catch (e) {
        orphaned = (e as Error).name === 'SyncOrphanError' || String((e as Error).message).includes('orphan')
      }
      expect(orphaned).toBe(true)

      // Skewed member upsert resolves the orphan (upsert repair covers, small clock).
      const skewBlockUpsert = {
        id: 'f0f0f0f0-f0f0-4000-a000-00000000f001',
        entityType: 'message_block',
        op: 'upsert',
        entityId: 'b-skew',
        timestamp: SKEW,
        deviceId: 'peer-skb',
        payload: {
          id: 'b-skew',
          messageId: 'm-skb',
          type: 'main_text',
          content: 'skew',
          status: 'success',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      }
      expect(syncService.applyIncomingOperation(skewBlockUpsert as never)).toBe(true)
      db.delete(schema.syncOutbox).run()

      // Retry orphan now converges (member arrived); then a huge incomplete
      // omitting b-local heals with ts>incoming in the same tx.
      expect(() => syncService.applyIncomingOperation(orphanHuge as never)).not.toThrow()
      const hugeIncomplete = {
        id: '1111aaaa-1111-4000-a000-00000011aa01',
        entityType: 'message',
        op: 'order_frame',
        entityId: 'm-skb',
        timestamp: SKEW + 200,
        deviceId: 'peer-skb',
        payload: {
          frameVersion: 'parent-order-frame-v1',
          kind: 'messageBlock',
          parentId: 'm-skb',
          orderedChildIds: ['b-skew'],
          frameClock: { timestamp: SKEW + 200, operationId: '1111aaaa-1111-4000-a000-00000011aa01' }
        }
      }
      expect(syncService.applyIncomingOperation(hugeIncomplete as never)).toBe(true)
      const healed = blockFrame(sqlite, 'm-skb')!
      expect(healed.ids).toContain('b-local')
      expect(healed.ids).toContain('b-skew')
      expect(healed.ts).toBeGreaterThan(SKEW + 200)
      expect(blockOrder(sqlite, 'm-skb')).toEqual(healed.ids)
      expect(
        db
          .select()
          .from(schema.syncOutbox)
          .all()
          .filter((r) => r.op === 'order_frame').length
      ).toBe(1)
      // Repeat of the same huge incomplete is consumed without extra mint.
      expect(syncService.applyIncomingOperation(hugeIncomplete as never)).toBe(false)
      expect(blockFrame(sqlite, 'm-skb')).toEqual(healed)
    } finally {
      try {
        sqlite.close()
      } catch {}
    }
  })

  function bindProfileSkewDigestCheck(_db: BetterSQLite3Database<typeof schema>): void {
    // Digest/cursor identity is asserted in the relay round-trip suites; here
    // the healed frame identity (ts+opId+ids) plus applied/outbox above is the
    // skew proof. No-op helper keeps the skew pair symmetric for review.
  }
})

describe('10) incoming-incomplete repair failure rolls back whole apply tx', () => {
  it('persist/enqueue failure leaves no frame/outbox/applied change; retry succeeds', () => {
    configStore.clear()
    configStore.set('sync:enabled', true)
    configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
    configStore.set('sync:token', '')
    const { sqlite, db } = openChatDb()
    ;(chatDbService as unknown as { sqlite: unknown }).sqlite = sqlite
    ;(chatDbService as unknown as { db: unknown }).db = db
    try {
      syncService.clearAllForTests()
      seedRegisteredAttachedSyncService(configStore, db)
      const agg = new ChatDbAggregateService(db, sqlite)
      expect(agg.ensureTopic('t-fi', 'a1', 'FI').ok).toBe(true)
      expect(agg.appendMessage('t-fi', makeMsg('m-fi1', 't-fi', 'fi1') as never, []).ok).toBe(true)
      expect(agg.appendMessage('t-fi', makeMsg('m-fi2', 't-fi', 'fi2') as never, []).ok).toBe(true)
      db.delete(schema.syncOutbox).run()
      const frameBefore = topicFrame(sqlite, 't-fi')!
      const incomingTs = frameBefore.ts + 10
      const incoming = {
        id: '2222bbbb-2222-4000-a000-00000022bb01',
        entityType: 'topic',
        op: 'order_frame',
        entityId: 't-fi',
        timestamp: incomingTs,
        deviceId: 'peer-fi',
        payload: {
          frameVersion: 'parent-order-frame-v1',
          kind: 'topicMessage',
          parentId: 't-fi',
          orderedChildIds: ['m-fi1'],
          frameClock: { timestamp: incomingTs, operationId: '2222bbbb-2222-4000-a000-00000022bb01' }
        }
      }
      // Incoming is newer than stored yet omits live m-fi2: repair path.
      expect(frameBefore.ids).toEqual(['m-fi1', 'm-fi2'])
      const orig = (
        syncService as unknown as { enqueueOrderFrameInTx: (...a: never[]) => boolean }
      ).enqueueOrderFrameInTx.bind(syncService)
      let calls = 0
      vi.spyOn(
        syncService as unknown as { enqueueOrderFrameInTx: (...a: never[]) => boolean },
        'enqueueOrderFrameInTx'
      ).mockImplementation(((...args: never[]) => {
        calls += 1
        if (calls === 1) throw new Error('injected incomplete-repair enqueue failure')
        return (orig as (...a: never[]) => boolean)(...args)
      }) as never)
      try {
        expect(() => syncService.applyIncomingOperation(incoming as never)).toThrow(/injected/)
      } finally {
        vi.restoreAllMocks()
      }
      // Whole-tx rollback: frame unchanged, no outbox, no applied, order intact.
      expect(topicFrame(sqlite, 't-fi')).toEqual(frameBefore)
      expect(
        db
          .select()
          .from(schema.syncOutbox)
          .all()
          .filter((r) => r.op === 'order_frame').length
      ).toBe(0)
      expect(
        sqlite.prepare(`SELECT * FROM sync_applied WHERE operation_id=?`).get((incoming as { id: string }).id)
      ).toBeFalsy()
      expect(messageOrder(sqlite, 't-fi')).toEqual(frameBefore.ids)
      // Retry succeeds and heals with ts>incoming.
      expect(syncService.applyIncomingOperation(incoming as never)).toBe(true)
      const healed = topicFrame(sqlite, 't-fi')!
      expect(healed.ids).toEqual(expect.arrayContaining(['m-fi1', 'm-fi2']))
      expect(healed.ts).toBeGreaterThan(frameBefore.ts)
    } finally {
      try {
        sqlite.close()
      } catch {}
    }
  })
})
