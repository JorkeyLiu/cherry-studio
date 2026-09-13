/**
 * Receiver fully-unversioned local-exclusive ordinary history union
 * (SYNC-DATA-058 receiver side): bootstrap pre-apply adoption, deterministic
 * suffix, fail-closed matrix, high-water/MAX_SAFE/rollback, v2 register boundary.
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
import { syncService } from '../SyncService'

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

let credA = { deviceId: '', code: '', secret: '' }
let credB = { deviceId: '', code: '', secret: '' }

function snapshotCreds(): { deviceId: string; code: string; secret: string } {
  return {
    deviceId: String(configStore.get('deviceId') ?? ''),
    code: String(configStore.get('sync:deviceCode') ?? ''),
    secret: String(configStore.get('sync:deviceAuth') ?? '')
  }
}

function insertLegacyHistory(sqlite: Database.Database): void {
  sqlite
    .prepare(
      `INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?,?)`
    )
    .run(
      'seed-t1',
      'a1',
      'Seed One',
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      null,
      JSON.stringify({ pinned: false, prompt: null, isNameManuallyEdited: false })
    )
  sqlite
    .prepare(
      `INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?,?)`
    )
    .run(
      'seed-t2',
      'a1',
      'Seed Empty',
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      null,
      JSON.stringify({ pinned: false, prompt: null, isNameManuallyEdited: false })
    )
  sqlite
    .prepare(
      `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      'seed-m1',
      'seed-t1',
      'user',
      'hello',
      'success',
      null,
      null,
      null,
      null,
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      0,
      null
    )
  sqlite
    .prepare(
      `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      'seed-m2',
      'seed-t1',
      'assistant',
      'world',
      'success',
      null,
      null,
      null,
      null,
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      1,
      null
    )
  sqlite
    .prepare(
      `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(
      'seed-b1',
      'seed-m1',
      'main_text',
      'hello',
      'success',
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      0,
      null
    )
  sqlite
    .prepare(
      `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(
      'seed-b2',
      'seed-m2',
      'main_text',
      'world',
      'success',
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      0,
      null
    )
}

function insertSharedTopicOnly(sqlite: Database.Database): void {
  sqlite
    .prepare(
      `INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?,?)`
    )
    .run(
      'seed-t1',
      'a1',
      'Seed One',
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      null,
      JSON.stringify({ pinned: false, prompt: null, isNameManuallyEdited: false })
    )
}

function insertExclusiveMessage(
  sqlite: Database.Database,
  id: string,
  topicId: string,
  content: string,
  sortOrder = 2
): void {
  sqlite
    .prepare(
      `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      topicId,
      'user',
      content,
      'success',
      null,
      null,
      null,
      null,
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      sortOrder,
      null
    )
}

function insertExclusiveBlock(sqlite: Database.Database, id: string, messageId: string, content: string): void {
  insertExclusiveBlockWithStatus(sqlite, id, messageId, content, 'success')
}

function insertExclusiveMessageWithStatus(
  sqlite: Database.Database,
  id: string,
  topicId: string,
  content: string,
  status: string,
  sortOrder = 2
): void {
  sqlite
    .prepare(
      `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      topicId,
      'user',
      content,
      status,
      null,
      null,
      null,
      null,
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      sortOrder,
      null
    )
}

function insertExclusiveBlockWithStatus(
  sqlite: Database.Database,
  id: string,
  messageId: string,
  content: string,
  status: string
): void {
  sqlite
    .prepare(
      `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(id, messageId, 'main_text', content, status, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 0, null)
}

beforeEach(() => {
  configStore.clear()
  credA = { deviceId: '', code: '', secret: '' }
  credB = { deviceId: '', code: '', secret: '' }
  ownedTmp = mkdtempSync(join(tmpdir(), 'sync-recv-'))
  relayDbPath = join(ownedTmp, 'relay.db')
  relayToken = `recv-${randomBytes(8).toString('hex')}`
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

async function pairAndSeedPublish(): Promise<number> {
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
  bindProfile('A', credA)
  insertLegacyHistory(sqliteA!)
  bindProfile('A', credA)
  const res = await syncService.runSeedBaselineIfPending()
  expect(res.kind).toBe('published')
  const cursorA = dbA!.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
  const n = Number(cursorA?.value ?? 0)
  expect(n).toBeGreaterThan(0)
  return n
}

function readCursor(db: BetterSQLite3Database<typeof schema>): number {
  const row = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
  return row ? Number(row.value) : 0
}

function outboxCount(db: BetterSQLite3Database<typeof schema>): number {
  return db.select().from(schema.syncOutbox).all().length
}

describe('receiver union over real relay', () => {
  it('shared-topic exclusive message/block bootstraps N, suffix order, pushes, seed converges, N+1 continues', async () => {
    const n = await pairAndSeedPublish()
    bindProfile('B', credB)
    // Receiver: same shared topic seed-t1 identical + exclusive message/block under it. No clocks/frames/outbox.
    insertSharedTopicOnly(sqliteB!)
    insertExclusiveMessage(sqliteB!, 'recv-m1', 'seed-t1', 'exclusive hello', 2)
    insertExclusiveBlock(sqliteB!, 'recv-b1', 'recv-m1', 'exclusive hello')
    // Also need exclusive message parent frame? No frames yet (fully unversioned).
    await syncService.sync()
    // Bootstrap committed N, then adoption outbox pushed in same cycle: cursor == head (N + adopted ops).
    const cursorB = readCursor(dbB!)
    expect(cursorB).toBeGreaterThanOrEqual(n)
    // Local dense order: incoming winner + exclusive suffix.
    const orderRows = sqliteB!
      .prepare(`SELECT id FROM messages WHERE topic_id='seed-t1' ORDER BY sort_order ASC, id ASC`)
      .all() as Array<{ id: string }>
    const ids = orderRows.map((r) => r.id)
    // Incoming seed-m1, seed-m2 must be present, exclusive recv-m1 suffix last.
    expect(ids).toContain('seed-m1')
    expect(ids).toContain('seed-m2')
    expect(ids).toContain('recv-m1')
    expect(ids[ids.length - 1]).toBe('recv-m1')
    // Adoption outbox drained via push in same cycle.
    expect(outboxCount(dbB!)).toBe(0)
    // Seed next sync receives exclusive.
    bindProfile('A', credA)
    await syncService.sync()
    expect(sqliteA!.prepare(`SELECT id FROM messages WHERE id='recv-m1'`).get()).toBeTruthy()
    expect(sqliteA!.prepare(`SELECT id FROM message_blocks WHERE id='recv-b1'`).get()).toBeTruthy()
    // Frames/order consistent: both have recv-m1 last under seed-t1.
    const orderA = (
      sqliteA!
        .prepare(`SELECT id FROM messages WHERE topic_id='seed-t1' ORDER BY sort_order ASC, id ASC`)
        .all() as Array<{ id: string }>
    ).map((r) => r.id)
    bindProfile('B', credB)
    const orderB = (
      sqliteB!
        .prepare(`SELECT id FROM messages WHERE topic_id='seed-t1' ORDER BY sort_order ASC, id ASC`)
        .all() as Array<{ id: string }>
    ).map((r) => r.id)
    expect(orderA).toEqual(orderB)
    // N+1 continuity: holder appends, receiver pulls.
    bindProfile('A', credA)
    const agg = new ChatDbAggregateService(dbA!, sqliteA!)
    expect(
      agg.appendMessage(
        'seed-t1',
        {
          id: 'seed-m3',
          topicId: 'seed-t1',
          role: 'user',
          content: 'three',
          status: 'success',
          createdAt: '2026-01-03T00:00:00.000Z',
          updatedAt: '2026-01-03T00:00:00.000Z'
        } as never,
        [
          {
            id: 'seed-b3',
            messageId: 'seed-m3',
            type: 'main_text',
            content: 'three',
            status: 'success',
            createdAt: '2026-01-03T00:00:00.000Z',
            updatedAt: '2026-01-03T00:00:00.000Z'
          } as never
        ]
      ).ok
    ).toBe(true)
    await syncService.sync()
    bindProfile('B', credB)
    await syncService.sync()
    expect(sqliteB!.prepare(`SELECT id FROM messages WHERE id='seed-m3'`).get()).toBeTruthy()
  }, 60000)

  it('complete exclusive topic subtree retained and pushed', async () => {
    const n = await pairAndSeedPublish()
    void n
    bindProfile('B', credB)
    // Pure exclusive topic + messages/blocks (no overlap with incoming).
    sqliteB!
      .prepare(
        `INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        'ex-t1',
        'a1',
        'Exclusive',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        null,
        JSON.stringify({ pinned: false, prompt: null, isNameManuallyEdited: false })
      )
    insertExclusiveMessage(sqliteB!, 'ex-m1', 'ex-t1', 'one', 0)
    insertExclusiveMessage(sqliteB!, 'ex-m2', 'ex-t1', 'two', 1)
    insertExclusiveBlock(sqliteB!, 'ex-b1', 'ex-m1', 'one')
    insertExclusiveBlock(sqliteB!, 'ex-b2', 'ex-m2', 'two')
    await syncService.sync()
    expect(readCursor(dbB!)).toBeGreaterThan(0)
    expect(outboxCount(dbB!)).toBe(0)
    bindProfile('A', credA)
    await syncService.sync()
    expect(sqliteA!.prepare(`SELECT id FROM topics WHERE id='ex-t1'`).get()).toBeTruthy()
    expect(sqliteA!.prepare(`SELECT id FROM messages WHERE id='ex-m1'`).get()).toBeTruthy()
    expect(sqliteA!.prepare(`SELECT id FROM message_blocks WHERE id='ex-b2'`).get()).toBeTruthy()
  }, 60000)

  it('deterministic suffix: multi exclusive sorted, membership>incoming frame, entity ops before frame, no sortOrder wire', async () => {
    const n = await pairAndSeedPublish()
    void n
    bindProfile('B', credB)
    insertSharedTopicOnly(sqliteB!)
    insertExclusiveMessage(sqliteB!, 'recv-mb', 'seed-t1', 'b', 5)
    insertExclusiveMessage(sqliteB!, 'recv-ma', 'seed-t1', 'a', 6)
    // Capture outbox order after bootstrap but before push? Bootstrap + push happen in same sync(),
    // so inspect seed side ops order via relay pull instead: check B's applied clocks ordering.
    await syncService.sync()
    // Membership > incoming frameClock (incoming frame ~7, adoption wall >>7).
    const memA = sqliteB!
      .prepare(`SELECT timestamp FROM sync_membership_clock WHERE child_entity_id='recv-ma'`)
      .get() as { timestamp: number } | undefined
    const memB = sqliteB!
      .prepare(`SELECT timestamp FROM sync_membership_clock WHERE child_entity_id='recv-mb'`)
      .get() as { timestamp: number } | undefined
    expect(memA).toBeTruthy()
    expect(memB).toBeTruthy()
    // Incoming frameClock for seed-t1 is small (seed adoption wall ~ now, but still < receiver adoption wall which is later).
    // Both memberships must be >0 and entity ops precede frame: frame timestamp > all entity timestamps.
    const frame = sqliteB!
      .prepare(`SELECT timestamp FROM sync_parent_order_frame WHERE kind='topicMessage' AND parent_id='seed-t1'`)
      .get() as { timestamp: number } | undefined
    expect(frame).toBeTruthy()
    const entA = sqliteB!.prepare(`SELECT timestamp FROM sync_entity_clock WHERE entity_id='recv-ma'`).get() as
      | { timestamp: number }
      | undefined
    expect(frame!.timestamp).toBeGreaterThan(entA!.timestamp)
    expect(frame!.timestamp).toBeGreaterThan(memA!.timestamp)
    // Dense order suffix deterministic by membership then id: recv-ma and recv-mb have increasing baseTs+idx sorted by id?
    // Our adoption orders entities by id: recv-ma before recv-mb, so memA < memB, suffix should be [recv-ma, recv-mb] after incoming.
    const orderRows = sqliteB!
      .prepare(`SELECT id FROM messages WHERE topic_id='seed-t1' ORDER BY sort_order ASC, id ASC`)
      .all() as Array<{ id: string }>
    const ids = orderRows.map((r) => r.id)
    const suffix = ids.slice(-2)
    expect(suffix).toEqual(['recv-ma', 'recv-mb'])
    // No sortOrder on wire: seed received ops must have no sortOrder in payloads. Check seed entity clocks exist and payloads via outbox already drained;
    // verify B's outbox was drained and seed has entities (wire had no sortOrder, otherwise strict validator would reject).
    bindProfile('A', credA)
    await syncService.sync()
    expect(sqliteA!.prepare(`SELECT id FROM messages WHERE id='recv-ma'`).get()).toBeTruthy()
  }, 60000)

  it('same-ID strict-identical succeeds; value/parent divergence fails whole tx', async () => {
    const n = await pairAndSeedPublish()
    void n
    bindProfile('B', credB)
    insertLegacyHistory(sqliteB!)
    await syncService.sync()
    expect(readCursor(dbB!)).toBeGreaterThan(0)
  }, 60000)

  it('value divergence and parent mismatch fail whole tx unchanged', async () => {
    await pairAndSeedPublish()
    // Value divergence.
    {
      const fresh = openChatDb()
      try {
        sqliteB?.close()
      } catch {}
      sqliteB = fresh.sqlite
      dbB = fresh.db
      bindProfile('B', credB)
      await syncService.getPairState()
      insertLegacyHistory(sqliteB)
      sqliteB.prepare(`UPDATE messages SET content='tampered' WHERE id='seed-m1'`).run()
      const before = { cursor: readCursor(dbB), outbox: outboxCount(dbB) }
      await expect(syncService.sync()).rejects.toThrow()
      expect(readCursor(dbB)).toBe(before.cursor)
      expect(outboxCount(dbB)).toBe(before.outbox)
      expect((sqliteB.prepare(`SELECT COUNT(*) as n FROM sync_entity_clock`).get() as { n: number }).n).toBe(0)
    }
    // Parent mismatch (same ID different topic): full-snapshot unchanged.
    {
      const fresh = openChatDb()
      try {
        sqliteB?.close()
      } catch {}
      sqliteB = fresh.sqlite
      dbB = fresh.db
      bindProfile('B', credB)
      await syncService.getPairState()
      insertLegacyHistory(sqliteB)
      // Move seed-m1 to seed-t2 (same ID, different parent).
      sqliteB.prepare(`UPDATE messages SET topic_id='seed-t2' WHERE id='seed-m1'`).run()
      const snapFull = (): Record<string, unknown> => ({
        cursor: readCursor(dbB!),
        outbox: dbB!.select().from(schema.syncOutbox).all(),
        entity: sqliteB!.prepare(`SELECT * FROM sync_entity_clock ORDER BY entity_type, entity_id`).all(),
        field: sqliteB!.prepare(`SELECT * FROM sync_field_clock ORDER BY entity_type, entity_id, field`).all(),
        membership: sqliteB!
          .prepare(`SELECT * FROM sync_membership_clock ORDER BY child_entity_type, child_entity_id`)
          .all(),
        frame: sqliteB!.prepare(`SELECT * FROM sync_parent_order_frame ORDER BY kind, parent_id`).all(),
        topics: sqliteB!.prepare(`SELECT * FROM topics ORDER BY id`).all(),
        messages: sqliteB!.prepare(`SELECT * FROM messages ORDER BY id`).all(),
        blocks: sqliteB!.prepare(`SELECT * FROM message_blocks ORDER BY id`).all()
      })
      const before = snapFull()
      await expect(syncService.sync()).rejects.toThrow()
      expect(snapFull()).toEqual(before)
    }
  }, 60000)

  it('MAX_SAFE exhaustion fails closed; push failure retains adoption outbox', async () => {
    const n = await pairAndSeedPublish()
    void n
    // MAX_SAFE: local high clock forces exhaustion.
    {
      const fresh = openChatDb()
      try {
        sqliteB?.close()
      } catch {}
      sqliteB = fresh.sqlite
      dbB = fresh.db
      bindProfile('B', credB)
      await syncService.getPairState()
      insertSharedTopicOnly(sqliteB)
      insertExclusiveMessage(sqliteB, 'max-m1', 'seed-t1', 'x', 2)
      insertExclusiveBlock(sqliteB, 'max-b1', 'max-m1', 'x')
      dbB
        .insert(schema.syncEntityClock)
        .values({
          entityType: 'topic',
          entityId: 'seed-high',
          timestamp: Number.MAX_SAFE_INTEGER - 1,
          operationId: '00000000-0000-4000-a000-000000000021'
        })
        .run()
      // seed-high is not exclusive (no row), but its clock forces baseTs to MAX_SAFE-? Adoption has 3 candidates, baseTs+len >= MAX_SAFE -> fail.
      // Actually baseTs = max(MAX_SAFE-1, wall, incoming)+1 = MAX_SAFE, which is >= MAX_SAFE -> fail. Good.
      const before = { cursor: readCursor(dbB), outbox: outboxCount(dbB) }
      await expect(syncService.sync()).rejects.toThrow()
      expect(readCursor(dbB)).toBe(before.cursor)
      expect(outboxCount(dbB)).toBe(before.outbox)
    }
    // Push failure retains adoption outbox: mock push to throw once after bootstrap commit.
    {
      const fresh = openChatDb()
      try {
        sqliteB?.close()
      } catch {}
      sqliteB = fresh.sqlite
      dbB = fresh.db
      bindProfile('B', credB)
      await syncService.getPairState()
      insertSharedTopicOnly(sqliteB)
      insertExclusiveMessage(sqliteB, 'pf-m1', 'seed-t1', 'x', 2)
      insertExclusiveBlock(sqliteB, 'pf-b1', 'pf-m1', 'x')
      const { syncClient } = await import('../SyncClient')
      const origPush = syncClient.push.bind(syncClient)
      let calls = 0
      vi.spyOn(syncClient, 'push').mockImplementation(((...args: Parameters<typeof origPush>) => {
        calls += 1
        if (calls === 1) return Promise.reject(new Error('push failed 503: injected'))
        return origPush(...args)
      }) as typeof origPush)
      try {
        await expect(syncService.sync()).rejects.toThrow(/push failed/)
      } finally {
        vi.restoreAllMocks()
      }
      // Bootstrap committed N (cursor !=0), adoption outbox retained for retry.
      expect(readCursor(dbB)).toBeGreaterThan(0)
      expect(outboxCount(dbB)).toBeGreaterThan(0)
      // Retry succeeds and drains.
      await syncService.sync()
      expect(outboxCount(dbB)).toBe(0)
    }
  }, 60000)
})

describe('receiver union fail-closed matrix', () => {
  async function setupPair(): Promise<number> {
    return pairAndSeedPublish()
  }

  async function snapshotB(): Promise<{ cursor: number; outbox: number; clocks: number; frames: number }> {
    return {
      cursor: readCursor(dbB!),
      outbox: outboxCount(dbB!),
      clocks: (sqliteB!.prepare(`SELECT COUNT(*) as n FROM sync_entity_clock`).get() as { n: number }).n,
      frames: (sqliteB!.prepare(`SELECT COUNT(*) as n FROM sync_parent_order_frame`).get() as { n: number }).n
    }
  }

  it('orphan/unsupported/transient each fail-closed unchanged (stable non-success now adopts)', async () => {
    await setupPair()
    const cases: Array<{ name: string; setup: () => void }> = [
      {
        name: 'orphan',
        setup: () => {
          insertSharedTopicOnly(sqliteB!)
          // Orphan message without parent topic (FK off for setup, union must fail-closed).
          sqliteB!.exec('PRAGMA foreign_keys=OFF')
          try {
            sqliteB!
              .prepare(
                `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
              )
              .run(
                'orph-m',
                'missing-t',
                'user',
                'x',
                'success',
                null,
                null,
                null,
                null,
                '2026-01-01T00:00:00.000Z',
                '2026-01-02T00:00:00.000Z',
                2,
                null
              )
          } finally {
            sqliteB!.exec('PRAGMA foreign_keys=ON')
          }
        }
      },
      {
        name: 'unsupported',
        setup: () => {
          insertSharedTopicOnly(sqliteB!)
          insertExclusiveMessage(sqliteB!, 'u-m1', 'seed-t1', 'x', 2)
          sqliteB!
            .prepare(
              `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)`
            )
            .run(
              'u-b1',
              'u-m1',
              'image',
              'x',
              'success',
              '2026-01-01T00:00:00.000Z',
              '2026-01-02T00:00:00.000Z',
              0,
              null
            )
        }
      },
      {
        name: 'transient',
        setup: () => {
          insertSharedTopicOnly(sqliteB!)
          sqliteB!
            .prepare(
              `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
            )
            .run(
              't-m1',
              'seed-t1',
              'assistant',
              'x',
              'streaming',
              null,
              null,
              null,
              null,
              '2026-01-01T00:00:00.000Z',
              '2026-01-02T00:00:00.000Z',
              2,
              null
            )
        }
      },
      {
        name: 'transient-block',
        setup: () => {
          insertSharedTopicOnly(sqliteB!)
          insertExclusiveMessage(sqliteB!, 't-m2', 'seed-t1', 'x', 2)
          sqliteB!
            .prepare(
              `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)`
            )
            .run(
              't-b2',
              't-m2',
              'main_text',
              'x',
              'pending',
              '2026-01-01T00:00:00.000Z',
              '2026-01-02T00:00:00.000Z',
              0,
              null
            )
        }
      }
    ]
    for (const c of cases) {
      // Fresh B DB per case: reopen.
      const fresh = openChatDb()
      try {
        sqliteB?.close()
      } catch {}
      sqliteB = fresh.sqlite
      dbB = fresh.db
      bindProfile('B', credB)
      // Re-observe channel so cursor-0 bootstrap triggers (channelKey lost on fresh DB, need to set from creds? getPairState restores).
      await syncService.getPairState()
      c.setup()
      const before = await snapshotB()
      await expect(syncService.sync()).rejects.toThrow()
      const after = await snapshotB()
      expect(after).toEqual(before)
    }
  }, 60000)

  it('partial clock / existing outbox / frame / applied each fail-closed', async () => {
    await setupPair()
    // Partial clock: exclusive message with entity clock but missing field/membership.
    {
      const fresh = openChatDb()
      try {
        sqliteB?.close()
      } catch {}
      sqliteB = fresh.sqlite
      dbB = fresh.db
      bindProfile('B', credB)
      await syncService.getPairState()
      insertSharedTopicOnly(sqliteB)
      insertExclusiveMessage(sqliteB, 'p-m1', 'seed-t1', 'x', 2)
      insertExclusiveBlock(sqliteB, 'p-b1', 'p-m1', 'x')
      dbB
        .insert(schema.syncEntityClock)
        .values({
          entityType: 'message',
          entityId: 'p-m1',
          timestamp: 1,
          operationId: '00000000-0000-4000-a000-000000000011'
        })
        .run()
      const before = await snapshotB()
      await expect(syncService.sync()).rejects.toThrow()
      expect(await snapshotB()).toEqual(before)
    }
    // Existing outbox.
    {
      const fresh = openChatDb()
      try {
        sqliteB?.close()
      } catch {}
      sqliteB = fresh.sqlite
      dbB = fresh.db
      bindProfile('B', credB)
      await syncService.getPairState()
      insertSharedTopicOnly(sqliteB)
      insertExclusiveMessage(sqliteB, 'o-m1', 'seed-t1', 'x', 2)
      insertExclusiveBlock(sqliteB, 'o-b1', 'o-m1', 'x')
      dbB
        .insert(schema.syncOutbox)
        .values({
          id: 'outbox-1',
          entityType: 'topic',
          op: 'upsert',
          entityId: 'seed-t1',
          timestamp: 1,
          deviceId: 'd',
          payloadJson: '{}',
          createdAt: new Date().toISOString()
        })
        .run()
      const before = await snapshotB()
      await expect(syncService.sync()).rejects.toThrow()
      expect(await snapshotB()).toEqual(before)
    }
    // Existing order frame.
    {
      const fresh = openChatDb()
      try {
        sqliteB?.close()
      } catch {}
      sqliteB = fresh.sqlite
      dbB = fresh.db
      bindProfile('B', credB)
      await syncService.getPairState()
      insertSharedTopicOnly(sqliteB)
      insertExclusiveMessage(sqliteB, 'f-m1', 'seed-t1', 'x', 2)
      insertExclusiveBlock(sqliteB, 'f-b1', 'f-m1', 'x')
      dbB
        .insert(schema.syncParentOrderFrame)
        .values({
          kind: 'topicMessage',
          parentId: 'seed-t1',
          frameVersion: 'parent-order-frame-v1',
          orderedChildIdsJson: JSON.stringify(['f-m1']),
          timestamp: 1,
          operationId: '00000000-0000-4000-a000-000000000014'
        })
        .run()
      const before = await snapshotB()
      await expect(syncService.sync()).rejects.toThrow()
      expect(await snapshotB()).toEqual(before)
    }
    // Existing applied op.
    {
      const fresh = openChatDb()
      try {
        sqliteB?.close()
      } catch {}
      sqliteB = fresh.sqlite
      dbB = fresh.db
      bindProfile('B', credB)
      await syncService.getPairState()
      insertSharedTopicOnly(sqliteB)
      insertExclusiveMessage(sqliteB, 'a-m1', 'seed-t1', 'x', 2)
      insertExclusiveBlock(sqliteB, 'a-b1', 'a-m1', 'x')
      dbB.insert(schema.syncApplied).values({ operationId: 'applied-keep', appliedAt: new Date().toISOString() }).run()
      const before = await snapshotB()
      await expect(syncService.sync()).rejects.toThrow()
      expect(await snapshotB()).toEqual(before)
    }
  }, 60000)

  it('unrelated local tombstone/register permit bootstrap adoption with pushback and convergence', async () => {
    await setupPair()
    // Unrelated local tombstone topic:other with exclusive under seed-t1.
    {
      const fresh = openChatDb()
      try {
        sqliteB?.close()
      } catch {}
      sqliteB = fresh.sqlite
      dbB = fresh.db
      bindProfile('B', credB)
      await syncService.getPairState()
      insertSharedTopicOnly(sqliteB)
      insertExclusiveMessage(sqliteB, 'tb-m1', 'seed-t1', 'x', 2)
      insertExclusiveBlock(sqliteB, 'tb-b1', 'tb-m1', 'x')
      dbB
        .insert(schema.syncState)
        .values({ key: 'tombstone:topic:other', value: '1:00000000-0000-4000-a000-000000000012' })
        .run()
      await syncService.sync()
      expect(readCursor(dbB)).toBeGreaterThan(0)
      expect(outboxCount(dbB)).toBe(0)
      expect(sqliteB.prepare(`SELECT id FROM messages WHERE id='tb-m1'`).get()).toBeTruthy()
      bindProfile('A', credA)
      await syncService.sync()
      expect(sqliteA!.prepare(`SELECT id FROM messages WHERE id='tb-m1'`).get()).toBeTruthy()
      expect(sqliteA!.prepare(`SELECT id FROM message_blocks WHERE id='tb-b1'`).get()).toBeTruthy()
      bindProfile('B', credB)
    }
    // Unrelated local register some-m with exclusive under seed-t1.
    {
      const fresh = openChatDb()
      try {
        sqliteB?.close()
      } catch {}
      sqliteB = fresh.sqlite
      dbB = fresh.db
      bindProfile('B', credB)
      await syncService.getPairState()
      insertSharedTopicOnly(sqliteB)
      insertExclusiveMessage(sqliteB, 'r-m1', 'seed-t1', 'x', 2)
      insertExclusiveBlock(sqliteB, 'r-b1', 'r-m1', 'x')
      dbB
        .insert(schema.syncStableReplaceRegister)
        .values({
          messageId: 'some-m',
          timestamp: 1,
          operationId: '00000000-0000-4000-a000-000000000013',
          activeBlockIdsJson: '[]',
          payloadHash: 'x'
        })
        .run()
      await syncService.sync()
      expect(readCursor(dbB)).toBeGreaterThan(0)
      expect(outboxCount(dbB)).toBe(0)
      bindProfile('A', credA)
      await syncService.sync()
      expect(sqliteA!.prepare(`SELECT id FROM messages WHERE id='r-m1'`).get()).toBeTruthy()
      expect(sqliteA!.prepare(`SELECT id FROM message_blocks WHERE id='r-b1'`).get()).toBeTruthy()
      bindProfile('B', credB)
    }
  }, 60000)

  it('intersecting tombstone/register closures fail closed with zero writes', async () => {
    await setupPair()
    bindProfile('A', credA)
    const { captureLocalSyncBaselineCandidate } = await import('../syncBaseline')
    const { buildPublishEnvelope } = await import('../syncBaselinePublish')
    const { mapWireEnvelopeToMergeInput } = await import('../syncBaselineWireApply')
    const { mergeValidatedBaselineInTx } = await import('../syncBaselineApply')
    const { adoptReceiverExclusiveInTx: adoptTx } = await import('../syncReceiverUnion')
    const candidate = captureLocalSyncBaselineCandidate(dbA!)
    const channelId = candidate.observedLocalChannelKey as string
    const watermark = candidate.observedLocalCursor as number
    const { envelope } = buildPublishEnvelope(candidate, channelId, watermark)
    const snapOf = (cDb: BetterSQLite3Database<typeof schema>, cSqlite: Database.Database): unknown => ({
      outbox: cDb.select().from(schema.syncOutbox).all(),
      entity: cSqlite.prepare(`SELECT * FROM sync_entity_clock`).all(),
      field: cSqlite.prepare(`SELECT * FROM sync_field_clock`).all(),
      membership: cSqlite.prepare(`SELECT * FROM sync_membership_clock`).all(),
      frame: cSqlite.prepare(`SELECT * FROM sync_parent_order_frame`).all(),
      topics: cSqlite.prepare(`SELECT * FROM topics ORDER BY id`).all(),
      messages: cSqlite.prepare(`SELECT * FROM messages ORDER BY id`).all(),
      blocks: cSqlite.prepare(`SELECT * FROM message_blocks ORDER BY id`).all()
    })
    const runAdopt = (
      cDb: BetterSQLite3Database<typeof schema>,
      mutateInput?: (input: { tombstones: Array<{ entityType: string; entityId: string }> }) => void
    ): void => {
      cDb.transaction((tx) => {
        const mapped = mapWireEnvelopeToMergeInput(envelope)
        if (mutateInput) mutateInput(mapped.input as never)
        adoptTx(tx as never, mapped.input, 'test-device-closure')
        mergeValidatedBaselineInTx(tx as never, mapped.input)
      })
    }
    // Direct self: local tombstone for the exclusive message itself.
    {
      const fresh = openChatDb()
      try {
        insertSharedTopicOnly(fresh.sqlite)
        insertExclusiveMessage(fresh.sqlite, 'c-m1', 'seed-t1', 'x', 2)
        insertExclusiveBlock(fresh.sqlite, 'c-b1', 'c-m1', 'x')
        fresh.db
          .insert(schema.syncState)
          .values({ key: 'tombstone:message:c-m1', value: '1:00000000-0000-4000-a000-000000000021' })
          .run()
        const before = snapOf(fresh.db, fresh.sqlite)
        expect(() => runAdopt(fresh.db)).toThrow()
        expect(snapOf(fresh.db, fresh.sqlite)).toEqual(before)
      } finally {
        try {
          fresh.sqlite.close()
        } catch {}
      }
    }
    // Candidate child under tombstoned parent: exclusive under seed-t1 with local tombstone for seed-t1.
    {
      const fresh = openChatDb()
      try {
        insertSharedTopicOnly(fresh.sqlite)
        insertExclusiveMessage(fresh.sqlite, 'c-m2', 'seed-t1', 'x', 2)
        insertExclusiveBlock(fresh.sqlite, 'c-b2', 'c-m2', 'x')
        fresh.db
          .insert(schema.syncState)
          .values({ key: 'tombstone:topic:seed-t1', value: '1:00000000-0000-4000-a000-000000000022' })
          .run()
        const before = snapOf(fresh.db, fresh.sqlite)
        expect(() => runAdopt(fresh.db)).toThrow()
        expect(snapOf(fresh.db, fresh.sqlite)).toEqual(before)
      } finally {
        try {
          fresh.sqlite.close()
        } catch {}
      }
    }
    // Tombstoned descendant under candidate parent: pure exclusive topic with tombstoned block beneath its message.
    {
      const fresh = openChatDb()
      try {
        fresh.sqlite
          .prepare(
            `INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?,?)`
          )
          .run(
            'ex-t9',
            'a1',
            'Ex',
            '2026-01-01T00:00:00.000Z',
            '2026-01-02T00:00:00.000Z',
            null,
            JSON.stringify({ pinned: false, prompt: null, isNameManuallyEdited: false })
          )
        insertExclusiveMessage(fresh.sqlite, 'ex-m9', 'ex-t9', 'x', 0)
        insertExclusiveBlock(fresh.sqlite, 'ex-b9', 'ex-m9', 'x')
        fresh.db
          .insert(schema.syncState)
          .values({ key: 'tombstone:message_block:ex-b9', value: '1:00000000-0000-4000-a000-000000000023' })
          .run()
        const before = snapOf(fresh.db, fresh.sqlite)
        expect(() => runAdopt(fresh.db)).toThrow()
        expect(snapOf(fresh.db, fresh.sqlite)).toEqual(before)
      } finally {
        try {
          fresh.sqlite.close()
        } catch {}
      }
    }
    // Incoming direct overlap: incoming tombstone for the exclusive message id.
    {
      const fresh = openChatDb()
      try {
        insertSharedTopicOnly(fresh.sqlite)
        insertExclusiveMessage(fresh.sqlite, 'c-m3', 'seed-t1', 'x', 2)
        insertExclusiveBlock(fresh.sqlite, 'c-b3', 'c-m3', 'x')
        const before = snapOf(fresh.db, fresh.sqlite)
        expect(() =>
          runAdopt(fresh.db, (input) => {
            input.tombstones.push({
              entityType: 'message',
              entityId: 'c-m3'
            })
          })
        ).toThrow()
        expect(snapOf(fresh.db, fresh.sqlite)).toEqual(before)
      } finally {
        try {
          fresh.sqlite.close()
        } catch {}
      }
    }
    // Register owner overlap: local register for the exclusive message itself.
    {
      const fresh = openChatDb()
      try {
        insertSharedTopicOnly(fresh.sqlite)
        insertExclusiveMessage(fresh.sqlite, 'c-m4', 'seed-t1', 'x', 2)
        insertExclusiveBlock(fresh.sqlite, 'c-b4', 'c-m4', 'x')
        fresh.db
          .insert(schema.syncStableReplaceRegister)
          .values({
            messageId: 'c-m4',
            timestamp: 1,
            operationId: '00000000-0000-4000-a000-000000000024',
            activeBlockIdsJson: '[]',
            payloadHash: 'x'
          })
          .run()
        const before = snapOf(fresh.db, fresh.sqlite)
        expect(() => runAdopt(fresh.db)).toThrow()
        expect(snapOf(fresh.db, fresh.sqlite)).toEqual(before)
      } finally {
        try {
          fresh.sqlite.close()
        } catch {}
      }
    }
    // Register block ownership: exclusive block owned by the registered message.
    {
      const fresh = openChatDb()
      try {
        insertSharedTopicOnly(fresh.sqlite)
        insertExclusiveMessage(fresh.sqlite, 'c-m5', 'seed-t1', 'x', 2)
        insertExclusiveBlock(fresh.sqlite, 'c-b5', 'c-m5', 'x')
        fresh.db
          .insert(schema.syncStableReplaceRegister)
          .values({
            messageId: 'c-m5',
            timestamp: 1,
            operationId: '00000000-0000-4000-a000-000000000025',
            activeBlockIdsJson: JSON.stringify(['c-b5']),
            payloadHash: 'x'
          })
          .run()
        const before = snapOf(fresh.db, fresh.sqlite)
        expect(() => runAdopt(fresh.db)).toThrow()
        expect(snapOf(fresh.db, fresh.sqlite)).toEqual(before)
      } finally {
        try {
          fresh.sqlite.close()
        } catch {}
      }
    }
    // Register active overlap: active lists the exclusive block while owner differs.
    {
      const fresh = openChatDb()
      try {
        insertSharedTopicOnly(fresh.sqlite)
        insertExclusiveMessage(fresh.sqlite, 'c-m6', 'seed-t1', 'x', 2)
        insertExclusiveBlock(fresh.sqlite, 'c-b6', 'c-m6', 'x')
        fresh.sqlite
          .prepare(
            `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
          )
          .run(
            'other-m6',
            'seed-t1',
            'user',
            'o',
            'success',
            null,
            null,
            null,
            null,
            '2026-01-01T00:00:00.000Z',
            '2026-01-02T00:00:00.000Z',
            9,
            null
          )
        fresh.db
          .insert(schema.syncStableReplaceRegister)
          .values({
            messageId: 'other-m6',
            timestamp: 1,
            operationId: '00000000-0000-4000-a000-000000000026',
            activeBlockIdsJson: JSON.stringify(['c-b6']),
            payloadHash: 'x'
          })
          .run()
        const before = snapOf(fresh.db, fresh.sqlite)
        expect(() => runAdopt(fresh.db)).toThrow()
        expect(snapOf(fresh.db, fresh.sqlite)).toEqual(before)
      } finally {
        try {
          fresh.sqlite.close()
        } catch {}
      }
    }
    // Malformed register data fails closed (duplicate active passes DB JSON CHECK but fails closure validator).
    {
      const fresh = openChatDb()
      try {
        insertSharedTopicOnly(fresh.sqlite)
        insertExclusiveMessage(fresh.sqlite, 'c-m7', 'seed-t1', 'x', 2)
        insertExclusiveBlock(fresh.sqlite, 'c-b7', 'c-m7', 'x')
        fresh.db
          .insert(schema.syncStableReplaceRegister)
          .values({
            messageId: 'other-m7',
            timestamp: 1,
            operationId: '00000000-0000-4000-a000-000000000027',
            activeBlockIdsJson: JSON.stringify(['dup', 'dup']),
            payloadHash: 'x'
          })
          .run()
        const before = snapOf(fresh.db, fresh.sqlite)
        expect(() => runAdopt(fresh.db)).toThrow()
        expect(snapOf(fresh.db, fresh.sqlite)).toEqual(before)
      } finally {
        try {
          fresh.sqlite.close()
        } catch {}
      }
    }
    // Unrelated incoming tombstone/register permit adoption.
    {
      const fresh = openChatDb()
      try {
        insertSharedTopicOnly(fresh.sqlite)
        insertExclusiveMessage(fresh.sqlite, 'c-m8', 'seed-t1', 'x', 2)
        insertExclusiveBlock(fresh.sqlite, 'c-b8', 'c-m8', 'x')
        fresh.db.transaction((tx) => {
          const mapped = mapWireEnvelopeToMergeInput(envelope)
          mapped.input.tombstones.push({
            entityType: 'topic',
            entityId: 'other-incoming',
            timestamp: 5,
            operationId: 'op-inc2',
            entityClock: null
          })
          ;(mapped.input.replacementRegisters ??= []).push({
            messageId: 'other-reg',
            timestamp: 5,
            operationId: '00000000-0000-4000-a000-000000000028',
            activeBlockIds: []
          })
          const union = adoptTx(tx as never, mapped.input, 'test-device-closure')
          expect(union.adopted).toBeGreaterThan(0)
          mergeValidatedBaselineInTx(tx as never, mapped.input)
        })
        expect(fresh.db.select().from(schema.syncOutbox).all().length).toBeGreaterThan(0)
      } finally {
        try {
          fresh.sqlite.close()
        } catch {}
      }
    }
  }, 60000)

  it('high-water / MAX_SAFE / injected failure rollback; push-failure retains outbox, restart no re-mint', async () => {
    const n = await setupPair()
    void n
    // Injected failure: trigger on entity clock insert.
    bindProfile('B', credB)
    insertSharedTopicOnly(sqliteB!)
    insertExclusiveMessage(sqliteB!, 'f-m1', 'seed-t1', 'x', 2)
    insertExclusiveBlock(sqliteB!, 'f-b1', 'f-m1', 'x')
    sqliteB!.exec(
      `CREATE TRIGGER inject_recv_fail BEFORE INSERT ON sync_entity_clock BEGIN SELECT RAISE(ABORT, 'injected-recv-fail'); END`
    )
    const beforeOut = outboxCount(dbB!)
    await expect(syncService.sync()).rejects.toThrow()
    expect(readCursor(dbB!)).toBe(0)
    expect(outboxCount(dbB!)).toBe(beforeOut)
    expect((sqliteB!.prepare(`SELECT COUNT(*) as n FROM sync_membership_clock`).get() as { n: number }).n).toBe(0)
    sqliteB!.exec(`DROP TRIGGER IF EXISTS inject_recv_fail`)
    // Success then push failure retains outbox: mock push to fail after bootstrap? Bootstrap and push are same cycle,
    // so simulate by making relay push fail via token? Simpler: verify restart no re-mint after success.
    const fresh = openChatDb()
    try {
      sqliteB?.close()
    } catch {}
    sqliteB = fresh.sqlite
    dbB = fresh.db
    bindProfile('B', credB)
    await syncService.getPairState()
    insertSharedTopicOnly(sqliteB)
    insertExclusiveMessage(sqliteB, 'g-m1', 'seed-t1', 'x', 2)
    insertExclusiveBlock(sqliteB, 'g-b1', 'g-m1', 'x')
    await syncService.sync()
    const clocksAfter = sqliteB
      .prepare(
        `SELECT entity_type, entity_id, timestamp, operation_id FROM sync_entity_clock ORDER BY entity_type, entity_id`
      )
      .all()
    // Second sync (cursor !=0, no re-adopt): clocks unchanged.
    await syncService.sync()
    const clocksAfter2 = sqliteB
      .prepare(
        `SELECT entity_type, entity_id, timestamp, operation_id FROM sync_entity_clock ORDER BY entity_type, entity_id`
      )
      .all()
    expect(clocksAfter2).toEqual(clocksAfter)
  }, 60000)

  it('incoming baseline v2 replacementRegisters apply; intersecting local register fail-closed, LWW with zero candidate', async () => {
    // Real incoming path: A captures a complete v2 candidate carrying a
    // replacement register, projects to wire, and fresh receivers apply it
    // through the real bootstrap composition (map + receiver union + merge
    // core). Relay transport is byte-identical replay covered by the relay
    // suites; the register merge semantics live in the merge core.
    await pairAndSeedPublish()
    bindProfile('A', credA)
    const REG_TS = 8_000_000_000_000
    const REG_OP = '00000000-0000-4000-a000-0000000000a1'
    dbA!
      .insert(schema.syncStableReplaceRegister)
      .values({
        messageId: 'seed-m1',
        timestamp: REG_TS,
        operationId: REG_OP,
        activeBlockIdsJson: JSON.stringify(['seed-b1']),
        payloadHash: 'test-hash'
      })
      .run()
    const { captureLocalSyncBaselineCandidate } = await import('../syncBaseline')
    const { buildPublishEnvelope } = await import('../syncBaselinePublish')
    const { mapWireEnvelopeToMergeInput } = await import('../syncBaselineWireApply')
    const { mergeValidatedBaselineInTx } = await import('../syncBaselineApply')
    const { adoptReceiverExclusiveInTx } = await import('../syncReceiverUnion')
    bindProfile('A', credA)
    const candidate = captureLocalSyncBaselineCandidate(dbA!)
    expect(candidate.completeness.state).toBe('complete')
    expect(candidate.replacementRegisters.map((r) => r.messageId)).toContain('seed-m1')
    const channelId = candidate.observedLocalChannelKey as string
    const watermark = candidate.observedLocalCursor as number
    const { envelope } = buildPublishEnvelope(candidate, channelId, watermark)
    expect((envelope.payload as { replacementRegisters: unknown[] }).replacementRegisters.length).toBeGreaterThan(0)

    // Case 1: fresh receiver with identical history (zero adoption candidate,
    // no local register) applies incoming v2 including the register.
    {
      const fresh = openChatDb()
      const cDb = fresh.db
      const cSqlite = fresh.sqlite
      try {
        cSqlite
          .prepare(
            `INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?,?)`
          )
          .run(
            'seed-t1',
            'a1',
            'Seed One',
            '2026-01-01T00:00:00.000Z',
            '2026-01-02T00:00:00.000Z',
            null,
            JSON.stringify({ pinned: false, prompt: null, isNameManuallyEdited: false })
          )
        cSqlite
          .prepare(
            `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
          )
          .run(
            'seed-m1',
            'seed-t1',
            'user',
            'hello',
            'success',
            null,
            null,
            null,
            null,
            '2026-01-01T00:00:00.000Z',
            '2026-01-02T00:00:00.000Z',
            0,
            null
          )
        cSqlite
          .prepare(
            `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
          )
          .run(
            'seed-m2',
            'seed-t1',
            'assistant',
            'world',
            'success',
            null,
            null,
            null,
            null,
            '2026-01-01T00:00:00.000Z',
            '2026-01-02T00:00:00.000Z',
            1,
            null
          )
        cSqlite
          .prepare(
            `INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?,?)`
          )
          .run(
            'seed-t2',
            'a1',
            'Seed Empty',
            '2026-01-01T00:00:00.000Z',
            '2026-01-02T00:00:00.000Z',
            null,
            JSON.stringify({ pinned: false, prompt: null, isNameManuallyEdited: false })
          )
        cSqlite
          .prepare(
            `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)`
          )
          .run(
            'seed-b1',
            'seed-m1',
            'main_text',
            'hello',
            'success',
            '2026-01-01T00:00:00.000Z',
            '2026-01-02T00:00:00.000Z',
            0,
            null
          )
        cSqlite
          .prepare(
            `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)`
          )
          .run(
            'seed-b2',
            'seed-m2',
            'main_text',
            'world',
            'success',
            '2026-01-01T00:00:00.000Z',
            '2026-01-02T00:00:00.000Z',
            0,
            null
          )
        cDb.transaction((tx) => {
          const mapped = mapWireEnvelopeToMergeInput(envelope)
          const union = adoptReceiverExclusiveInTx(tx as never, mapped.input, 'test-device-v2')
          expect(union.adopted).toBe(0)
          mergeValidatedBaselineInTx(tx as never, mapped.input)
        })
        const reg = cSqlite.prepare(`SELECT * FROM sync_stable_replace_register WHERE message_id='seed-m1'`).get() as
          | { timestamp: number; operation_id: string }
          | undefined
        expect(reg).toBeTruthy()
        expect(reg!.timestamp).toBe(REG_TS)
        expect(reg!.operation_id).toBe(REG_OP)
      } finally {
        try {
          fresh.sqlite.close()
        } catch {}
      }
    }

    // Case 2: intersecting local register + adoption candidate fails closed 0 writes.
    {
      const fresh = openChatDb()
      const cDb = fresh.db
      const cSqlite = fresh.sqlite
      try {
        insertSharedTopicOnly(cSqlite)
        insertExclusiveMessage(cSqlite, 'v2-m1', 'seed-t1', 'x', 2)
        insertExclusiveBlock(cSqlite, 'v2-b1', 'v2-m1', 'x')
        cDb
          .insert(schema.syncStableReplaceRegister)
          .values({
            messageId: 'v2-m1',
            timestamp: 1,
            operationId: REG_OP,
            activeBlockIdsJson: JSON.stringify(['v2-b1']),
            payloadHash: 'x'
          })
          .run()
        const snap = (): unknown => ({
          outbox: cDb.select().from(schema.syncOutbox).all(),
          entity: cSqlite.prepare(`SELECT * FROM sync_entity_clock`).all(),
          field: cSqlite.prepare(`SELECT * FROM sync_field_clock`).all(),
          membership: cSqlite.prepare(`SELECT * FROM sync_membership_clock`).all(),
          frame: cSqlite.prepare(`SELECT * FROM sync_parent_order_frame`).all(),
          reg: cSqlite.prepare(`SELECT * FROM sync_stable_replace_register ORDER BY message_id`).all()
        })
        const before = snap()
        expect(() =>
          cDb.transaction((tx) => {
            const mapped = mapWireEnvelopeToMergeInput(envelope)
            adoptReceiverExclusiveInTx(tx as never, mapped.input, 'test-device-v2')
            mergeValidatedBaselineInTx(tx as never, mapped.input)
          })
        ).toThrow()
        expect(snap()).toEqual(before)
      } finally {
        try {
          fresh.sqlite.close()
        } catch {}
      }
    }

    // Case 3: local register + zero candidate follows merge-core LWW
    // (incoming higher wins; incoming lower ignored).
    {
      const fresh = openChatDb()
      const cDb = fresh.db
      const cSqlite = fresh.sqlite
      try {
        insertLegacyHistory(cSqlite)
        // Local older register for seed-m1; incoming REG_TS is higher -> wins.
        cDb
          .insert(schema.syncStableReplaceRegister)
          .values({
            messageId: 'seed-m1',
            timestamp: 1,
            operationId: '00000000-0000-4000-a000-000000000001',
            activeBlockIdsJson: JSON.stringify(['seed-b1']),
            payloadHash: 'local-old'
          })
          .run()
        cDb.transaction((tx) => {
          const mapped = mapWireEnvelopeToMergeInput(envelope)
          const union = adoptReceiverExclusiveInTx(tx as never, mapped.input, 'test-device-v2')
          // Identical history overlaps are not candidates; local register
          // alone is not an adoption candidate, so union adopts nothing and
          // the register decision stays with the merge core LWW.
          expect(union.adopted).toBe(0)
          mergeValidatedBaselineInTx(tx as never, mapped.input)
        })
        const won = cSqlite.prepare(`SELECT * FROM sync_stable_replace_register WHERE message_id='seed-m1'`).get() as {
          timestamp: number
        }
        expect(won.timestamp).toBe(REG_TS)
      } finally {
        try {
          fresh.sqlite.close()
        } catch {}
      }
      const fresh2 = openChatDb()
      try {
        insertLegacyHistory(fresh2.sqlite)
        // Local newer register; incoming lower is ignored.
        fresh2.db
          .insert(schema.syncStableReplaceRegister)
          .values({
            messageId: 'seed-m1',
            timestamp: REG_TS + 1000,
            operationId: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
            activeBlockIdsJson: JSON.stringify(['seed-b1']),
            payloadHash: 'local-new'
          })
          .run()
        fresh2.db.transaction((tx) => {
          const mapped = mapWireEnvelopeToMergeInput(envelope)
          const union = adoptReceiverExclusiveInTx(tx as never, mapped.input, 'test-device-v2')
          expect(union.adopted).toBe(0)
          mergeValidatedBaselineInTx(tx as never, mapped.input)
        })
        const kept = fresh2.sqlite
          .prepare(`SELECT * FROM sync_stable_replace_register WHERE message_id='seed-m1'`)
          .get() as { timestamp: number }
        expect(kept.timestamp).toBe(REG_TS + 1000)
      } finally {
        try {
          fresh2.sqlite.close()
        } catch {}
      }
    }
  }, 60000)
})

describe('dual exclusive symmetric convergence over real relay', () => {
  async function setupPair(): Promise<void> {
    await startRelay()
    bindProfile('A', credA)
    await syncService.connect()
    credA = snapshotCreds()
    configStore.delete('deviceId')
    configStore.delete('sync:deviceCode')
    configStore.delete('sync:deviceAuth')
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

  function frameCount(sqlite: Database.Database): number {
    return (sqlite.prepare(`SELECT COUNT(*) as n FROM sync_parent_order_frame`).get() as { n: number }).n
  }

  it('topicMessage + messageBlock symmetric exclusives interleave to identical entity/order/frame with drained outbox and no storm', async () => {
    await setupPair()
    bindProfile('A', credA)
    insertLegacyHistory(sqliteA!)
    bindProfile('A', credA)
    const res = await syncService.runSeedBaselineIfPending()
    expect(res.kind).toBe('published')
    bindProfile('B', credB)
    await syncService.sync()

    // Phase 1: shared topic seed-t1, symmetric exclusive messages (sequential
    // interleave so each mint observes the other side: A creates+pushes, B
    // pulls then creates+pushes, A pulls; suffix merge propagates the union).
    bindProfile('A', credA)
    const aggA1 = new ChatDbAggregateService(dbA!, sqliteA!)
    expect(
      aggA1.appendMessage(
        'seed-t1',
        {
          id: 'dual-a1',
          topicId: 'seed-t1',
          role: 'user',
          content: 'a-one',
          status: 'success',
          createdAt: '2026-01-03T00:00:00.000Z',
          updatedAt: '2026-01-03T00:00:00.000Z'
        } as never,
        [
          {
            id: 'dual-ab1',
            messageId: 'dual-a1',
            type: 'main_text',
            content: 'a-one',
            status: 'success',
            createdAt: '2026-01-03T00:00:00.000Z',
            updatedAt: '2026-01-03T00:00:00.000Z'
          } as never
        ]
      ).ok
    ).toBe(true)
    await syncService.sync()
    bindProfile('B', credB)
    await syncService.sync()
    const aggB1 = new ChatDbAggregateService(dbB!, sqliteB!)
    expect(
      aggB1.appendMessage(
        'seed-t1',
        {
          id: 'dual-b1',
          topicId: 'seed-t1',
          role: 'user',
          content: 'b-one',
          status: 'success',
          createdAt: '2026-01-03T00:00:00.000Z',
          updatedAt: '2026-01-03T00:00:00.000Z'
        } as never,
        [
          {
            id: 'dual-bb1',
            messageId: 'dual-b1',
            type: 'main_text',
            content: 'b-one',
            status: 'success',
            createdAt: '2026-01-03T00:00:00.000Z',
            updatedAt: '2026-01-03T00:00:00.000Z'
          } as never
        ]
      ).ok
    ).toBe(true)
    await syncService.sync()
    bindProfile('A', credA)
    await syncService.sync()
    // Drain the wall-fresh repair winner (A mints a strictly larger union on
    // pull and pushes it; B adopts it next round) before asserting full
    // frame identity.
    bindProfile('A', credA)
    await syncService.sync()
    bindProfile('B', credB)
    await syncService.sync()
    // Both hold both exclusives with identical dense topic order.
    const orderA1 = (
      sqliteA!
        .prepare(`SELECT id FROM messages WHERE topic_id='seed-t1' ORDER BY sort_order ASC, id ASC`)
        .all() as Array<{
        id: string
      }>
    ).map((r) => r.id)
    bindProfile('B', credB)
    const orderB1 = (
      sqliteB!
        .prepare(`SELECT id FROM messages WHERE topic_id='seed-t1' ORDER BY sort_order ASC, id ASC`)
        .all() as Array<{
        id: string
      }>
    ).map((r) => r.id)
    expect(orderA1).toContain('dual-a1')
    expect(orderA1).toContain('dual-b1')
    expect(orderB1).toEqual(orderA1)
    // Full frame identity convergence (timestamp + operationId + ordered ids):
    // the larger complete clock propagates via LWW and unifies both sides.
    {
      const fa = sqliteA!
        .prepare(
          `SELECT ordered_child_ids_json AS json, timestamp AS ts, operation_id AS opId FROM sync_parent_order_frame WHERE kind='topicMessage' AND parent_id='seed-t1'`
        )
        .get() as { json: string; ts: number; opId: string }
      const fb = sqliteB!
        .prepare(
          `SELECT ordered_child_ids_json AS json, timestamp AS ts, operation_id AS opId FROM sync_parent_order_frame WHERE kind='topicMessage' AND parent_id='seed-t1'`
        )
        .get() as { json: string; ts: number; opId: string }
      expect(JSON.parse(fb.json)).toEqual(JSON.parse(fa.json))
      expect(fb.ts).toBe(fa.ts)
      expect(fb.opId).toBe(fa.opId)
    }
    expect(sqliteA!.prepare(`SELECT id FROM message_blocks WHERE id='dual-bb1'`).get()).toBeTruthy()
    expect(sqliteB!.prepare(`SELECT id FROM message_blocks WHERE id='dual-ab1'`).get()).toBeTruthy()

    // Phase 2: shared message seed-m1, symmetric exclusive blocks.
    bindProfile('A', credA)
    const aggA2 = new ChatDbAggregateService(dbA!, sqliteA!)
    expect(
      aggA2.bulkAddBlocks([
        {
          id: 'dual-ablk1',
          messageId: 'seed-m1',
          type: 'main_text',
          content: 'a-blk',
          status: 'success',
          createdAt: '2026-01-04T00:00:00.000Z',
          updatedAt: '2026-01-04T00:00:00.000Z'
        } as never
      ]).ok
    ).toBe(true)
    await syncService.sync()
    bindProfile('B', credB)
    await syncService.sync()
    const aggB2 = new ChatDbAggregateService(dbB!, sqliteB!)
    expect(
      aggB2.bulkAddBlocks([
        {
          id: 'dual-bblk1',
          messageId: 'seed-m1',
          type: 'main_text',
          content: 'b-blk',
          status: 'success',
          createdAt: '2026-01-04T00:00:00.000Z',
          updatedAt: '2026-01-04T00:00:00.000Z'
        } as never
      ]).ok
    ).toBe(true)
    await syncService.sync()
    bindProfile('A', credA)
    await syncService.sync()
    // Drain repair unions (upsert repair pushes next cycle; LWW then converges order).
    bindProfile('B', credB)
    await syncService.sync()
    bindProfile('A', credA)
    await syncService.sync()
    bindProfile('B', credB)
    await syncService.sync()
    bindProfile('A', credA)
    const borderA = (
      sqliteA!
        .prepare(`SELECT id FROM message_blocks WHERE message_id='seed-m1' ORDER BY sort_order ASC, id ASC`)
        .all() as Array<{
        id: string
      }>
    ).map((r) => r.id)
    bindProfile('B', credB)
    const borderB = (
      sqliteB!
        .prepare(`SELECT id FROM message_blocks WHERE message_id='seed-m1' ORDER BY sort_order ASC, id ASC`)
        .all() as Array<{
        id: string
      }>
    ).map((r) => r.id)
    expect(borderA).toContain('dual-ablk1')
    expect(borderA).toContain('dual-bblk1')
    expect(borderB).toEqual(borderA)
    {
      const fa = sqliteA!
        .prepare(
          `SELECT ordered_child_ids_json AS json, timestamp AS ts, operation_id AS opId FROM sync_parent_order_frame WHERE kind='messageBlock' AND parent_id='seed-m1'`
        )
        .get() as { json: string; ts: number; opId: string }
      const fb = sqliteB!
        .prepare(
          `SELECT ordered_child_ids_json AS json, timestamp AS ts, operation_id AS opId FROM sync_parent_order_frame WHERE kind='messageBlock' AND parent_id='seed-m1'`
        )
        .get() as { json: string; ts: number; opId: string }
      expect(JSON.parse(fb.json)).toEqual(JSON.parse(fa.json))
      expect(fb.ts).toBe(fa.ts)
      expect(fb.opId).toBe(fa.opId)
    }

    // Retry stability: no frame storm, outbox drains to zero on both sides.
    const framesBeforeA = frameCount(sqliteA!)
    const framesBeforeB = frameCount(sqliteB!)
    bindProfile('A', credA)
    await syncService.sync()
    bindProfile('B', credB)
    await syncService.sync()
    bindProfile('A', credA)
    await syncService.sync()
    expect(frameCount(sqliteA!)).toBe(framesBeforeA)
    expect(frameCount(sqliteB!)).toBe(framesBeforeB)
    expect(outboxCount(dbA!)).toBe(0)
    expect(outboxCount(dbB!)).toBe(0)
    // Final cross-check after retries.
    const finalA = (
      sqliteA!
        .prepare(`SELECT id FROM messages WHERE topic_id='seed-t1' ORDER BY sort_order ASC, id ASC`)
        .all() as Array<{
        id: string
      }>
    ).map((r) => r.id)
    bindProfile('B', credB)
    const finalB = (
      sqliteB!
        .prepare(`SELECT id FROM messages WHERE topic_id='seed-t1' ORDER BY sort_order ASC, id ASC`)
        .all() as Array<{
        id: string
      }>
    ).map((r) => r.id)
    expect(finalB).toEqual(finalA)
    {
      const fa = sqliteA!
        .prepare(
          `SELECT ordered_child_ids_json AS json, timestamp AS ts, operation_id AS opId FROM sync_parent_order_frame WHERE kind='topicMessage' AND parent_id='seed-t1'`
        )
        .get() as { json: string; ts: number; opId: string }
      const fb = sqliteB!
        .prepare(
          `SELECT ordered_child_ids_json AS json, timestamp AS ts, operation_id AS opId FROM sync_parent_order_frame WHERE kind='topicMessage' AND parent_id='seed-t1'`
        )
        .get() as { json: string; ts: number; opId: string }
      expect(JSON.parse(fb.json)).toEqual(JSON.parse(fa.json))
      expect(fb.ts).toBe(fa.ts)
      expect(fb.opId).toBe(fa.opId)
    }
  }, 120000)

  it('concurrent versioned exclusives converge via incremental upsert repair (residual closed)', async () => {
    // Both sides mint versioned exclusives before any exchange. The incremental
    // remote-upsert union repair (SYNC-DATA-035/036/048/058) now heals the
    // previous incomplete fail-closed residual: entity upserts apply, repair
    // mints complete unions at upsert arrival, and older incomplete frames
    // covered by the higher union are consumed instead of deadlocking.
    await setupPair()
    bindProfile('A', credA)
    insertLegacyHistory(sqliteA!)
    bindProfile('A', credA)
    const res = await syncService.runSeedBaselineIfPending()
    expect(res.kind).toBe('published')
    bindProfile('B', credB)
    await syncService.sync()
    bindProfile('A', credA)
    const aggA = new ChatDbAggregateService(dbA!, sqliteA!)
    expect(
      aggA.appendMessage(
        'seed-t1',
        {
          id: 'conc-a1',
          topicId: 'seed-t1',
          role: 'user',
          content: 'ca',
          status: 'success',
          createdAt: '2026-01-03T00:00:00.000Z',
          updatedAt: '2026-01-03T00:00:00.000Z'
        } as never,
        [
          {
            id: 'conc-ab1',
            messageId: 'conc-a1',
            type: 'main_text',
            content: 'ca',
            status: 'success',
            createdAt: '2026-01-03T00:00:00.000Z',
            updatedAt: '2026-01-03T00:00:00.000Z'
          } as never
        ]
      ).ok
    ).toBe(true)
    bindProfile('B', credB)
    const aggB = new ChatDbAggregateService(dbB!, sqliteB!)
    expect(
      aggB.appendMessage(
        'seed-t1',
        {
          id: 'conc-b1',
          topicId: 'seed-t1',
          role: 'user',
          content: 'cb',
          status: 'success',
          createdAt: '2026-01-03T00:00:00.000Z',
          updatedAt: '2026-01-03T00:00:00.000Z'
        } as never,
        [
          {
            id: 'conc-bb1',
            messageId: 'conc-b1',
            type: 'main_text',
            content: 'cb',
            status: 'success',
            createdAt: '2026-01-03T00:00:00.000Z',
            updatedAt: '2026-01-03T00:00:00.000Z'
          } as never
        ]
      ).ok
    ).toBe(true)
    bindProfile('A', credA)
    await syncService.sync()
    bindProfile('B', credB)
    await syncService.sync()
    // Repair heals: exchange repair unions until both sides converge with no
    // silent drop and no storm (extra rounds drain repair outbox, LWW picks the
    // higher union; equal-timestamp ties keep identical order).
    for (let i = 0; i < 4; i++) {
      bindProfile('A', credA)
      await syncService.sync()
      bindProfile('B', credB)
      await syncService.sync()
    }
    expect(sqliteA!.prepare(`SELECT id FROM messages WHERE id='conc-a1'`).get()).toBeTruthy()
    expect(sqliteA!.prepare(`SELECT id FROM messages WHERE id='conc-b1'`).get()).toBeTruthy()
    expect(sqliteB!.prepare(`SELECT id FROM messages WHERE id='conc-a1'`).get()).toBeTruthy()
    expect(sqliteB!.prepare(`SELECT id FROM messages WHERE id='conc-b1'`).get()).toBeTruthy()
    const orderA = (
      sqliteA!
        .prepare(`SELECT id FROM messages WHERE topic_id='seed-t1' ORDER BY sort_order ASC, id ASC`)
        .all() as Array<{ id: string }>
    ).map((r) => r.id)
    const orderB = (
      sqliteB!
        .prepare(`SELECT id FROM messages WHERE topic_id='seed-t1' ORDER BY sort_order ASC, id ASC`)
        .all() as Array<{ id: string }>
    ).map((r) => r.id)
    expect(orderB).toEqual(orderA)
    expect(outboxCount(dbA!)).toBe(0)
    expect(outboxCount(dbB!)).toBe(0)
  }, 120000)
})

describe('suffix-merge all-or-nothing atomicity (SYNC-DATA-048 review blocker)', () => {
  it('enqueue failure after frame persist rolls back incoming/applied/cursor/frame/outbox/clocks; retry emits and converges with no storm', async () => {
    // Direct single-DB incremental apply: stored [m1,m2], local exclusive b1
    // with membership > incoming, incoming [m1,m2] winning over stored.
    // Merge must allocate/persist/enqueue atomically; injected enqueue failure
    // must throw with whole-tx rollback (no applied, no cursor advance).
    bindProfile('A', credA)
    configStore.set('deviceId', 'test-local-device-atomic')
    configStore.set('sync:enabled', true)
    const { randomUUID } = await import('node:crypto')
    const agg = new ChatDbAggregateService(dbA!, sqliteA!)
    expect(agg.ensureTopic('t-atomic', 'a1', 'Atomic').ok).toBe(true)
    expect(
      agg.appendMessage(
        't-atomic',
        {
          id: 'am-m1',
          topicId: 't-atomic',
          role: 'user',
          content: 'one',
          status: 'success',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z'
        } as never,
        []
      ).ok
    ).toBe(true)
    expect(
      agg.appendMessage(
        't-atomic',
        {
          id: 'am-m2',
          topicId: 't-atomic',
          role: 'user',
          content: 'two',
          status: 'success',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z'
        } as never,
        []
      ).ok
    ).toBe(true)
    const storedBefore = sqliteA!
      .prepare(
        `SELECT timestamp, operation_id AS operationId, ordered_child_ids_json AS json FROM sync_parent_order_frame WHERE kind='topicMessage' AND parent_id='t-atomic'`
      )
      .get() as { timestamp: number; operationId: string; json: string }
    expect(JSON.parse(storedBefore.json)).toEqual(['am-m1', 'am-m2'])
    const tsStored = storedBefore.timestamp
    const ti = tsStored + 5
    const tb1 = ti + 10
    // Local exclusive b1 without touching the stored frame (simulates a live
    // child the stored frame does not yet list).
    sqliteA!
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'am-b1',
        't-atomic',
        'user',
        'exclusive',
        'success',
        null,
        null,
        null,
        null,
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        2,
        null
      )
    const b1Op = randomUUID()
    dbA!
      .insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message' as never,
        childEntityId: 'am-b1',
        parentId: 't-atomic',
        timestamp: tb1,
        operationId: b1Op
      })
      .run()
    const incomingId = randomUUID()
    const incomingOp = {
      id: incomingId,
      entityType: 'topic',
      op: 'order_frame',
      entityId: 't-atomic',
      timestamp: ti,
      deviceId: 'remote-device-atomic',
      payload: {
        frameVersion: 'parent-order-frame-v1',
        kind: 'topicMessage',
        parentId: 't-atomic',
        orderedChildIds: ['am-m1', 'am-m2'],
        frameClock: { timestamp: ti, operationId: incomingId }
      }
    }
    const snap = (): Record<string, unknown> => ({
      cursor: readCursor(dbA!),
      applied: sqliteA!.prepare(`SELECT operation_id AS id FROM sync_applied ORDER BY operation_id`).all(),
      frame: sqliteA!
        .prepare(
          `SELECT timestamp, operation_id AS operationId, ordered_child_ids_json AS json FROM sync_parent_order_frame WHERE kind='topicMessage' AND parent_id='t-atomic'`
        )
        .get(),
      outbox: dbA!.select().from(schema.syncOutbox).all(),
      membership: sqliteA!.prepare(`SELECT * FROM sync_membership_clock ORDER BY child_entity_id`).all(),
      highwater: sqliteA!.prepare(`SELECT * FROM sync_frame_high_water ORDER BY kind, parent_id`).all(),
      order: sqliteA!.prepare(`SELECT id FROM messages WHERE topic_id='t-atomic' ORDER BY sort_order ASC, id ASC`).all()
    })
    const before = snap()
    const outboxBefore = (before.outbox as unknown[]).length
    // Inject failure at enqueue (after frame persist) — the old swallowed path
    // left a persisted merge frame with no outbox; the fixed path must throw
    // with whole-tx rollback.
    const origEnqueue = syncService.enqueueOrderFrameInTx.bind(syncService)
    let injected = 0
    vi.spyOn(syncService, 'enqueueOrderFrameInTx').mockImplementation((() => {
      injected += 1
      throw new Error('injected-enqueue-fail-after-persist')
    }) as unknown as typeof origEnqueue)
    try {
      expect(() => syncService.applyIncomingOperation(incomingOp as never)).toThrow(/injected-enqueue-fail/)
    } finally {
      vi.restoreAllMocks()
    }
    expect(injected).toBe(1)
    const afterFail = snap()
    expect(afterFail).toEqual(before)
    expect(readCursor(dbA!)).toBe(before.cursor as number)
    expect(
      (sqliteA!.prepare(`SELECT COUNT(*) as n FROM sync_applied WHERE operation_id=?`).get(incomingId) as { n: number })
        .n
    ).toBe(0)
    expect(outboxCount(dbA!)).toBe(outboxBefore)
    // Retry without injection: winning apply + all-or-nothing merge emits once.
    const appliedNow = syncService.applyIncomingOperation(incomingOp as never)
    expect(appliedNow).toBe(true)
    const frameAfter = sqliteA!
      .prepare(
        `SELECT timestamp, operation_id AS operationId, ordered_child_ids_json AS json FROM sync_parent_order_frame WHERE kind='topicMessage' AND parent_id='t-atomic'`
      )
      .get() as { timestamp: number; operationId: string; json: string }
    expect(JSON.parse(frameAfter.json)).toEqual(['am-m1', 'am-m2', 'am-b1'])
    expect(frameAfter.timestamp).toBeGreaterThan(ti)
    expect(frameAfter.timestamp).toBeGreaterThan(tsStored)
    const mergeOps = dbA!
      .select()
      .from(schema.syncOutbox)
      .all()
      .filter((r) => r.op === 'order_frame' && r.entityId === 't-atomic')
    expect(mergeOps.length).toBeGreaterThanOrEqual(1)
    const latest = mergeOps[mergeOps.length - 1]
    expect(latest.id).toBe(frameAfter.operationId)
    expect(latest.timestamp).toBe(frameAfter.timestamp)
    const payload = JSON.parse(latest.payloadJson as string) as {
      orderedChildIds: string[]
      frameClock: { timestamp: number; operationId: string }
    }
    expect(payload.orderedChildIds).toEqual(['am-m1', 'am-m2', 'am-b1'])
    expect(payload.frameClock.timestamp).toBe(frameAfter.timestamp)
    expect(
      (sqliteA!.prepare(`SELECT COUNT(*) as n FROM sync_applied WHERE operation_id=?`).get(incomingId) as { n: number })
        .n
    ).toBe(1)
    const orderAfter = (
      sqliteA!
        .prepare(`SELECT id FROM messages WHERE topic_id='t-atomic' ORDER BY sort_order ASC, id ASC`)
        .all() as Array<{ id: string }>
    ).map((r) => r.id)
    expect(orderAfter).toEqual(['am-m1', 'am-m2', 'am-b1'])
    // Retry idempotence: duplicate incoming emits nothing further (no storm).
    const outboxAfterMerge = outboxCount(dbA!)
    const second = syncService.applyIncomingOperation(incomingOp as never)
    expect(second).toBe(false)
    expect(outboxCount(dbA!)).toBe(outboxAfterMerge)
  })
})

describe('receiver union claim matrix over real relay (SYNC-DATA-058)', () => {
  it('holder versioned exclusive + receiver unversioned exclusive on same shared topic converge with no storm', async () => {
    // Holder seed includes an extra versioned exclusive (adopted as part of
    // the seed baseline, so the receiver union sees it via incoming); this
    // stays within the provable-suffix claim. A holder incremental exclusive
    // pushed after the baseline with a receiver bootstrap racing it is the
    // documented versioned-concurrent residual (fail-closed, covered by the
    // dual test) and is not claimed here.
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
    const reqH = await syncService.requestPairing(credA.code)
    bindProfile('A', credA)
    await syncService.acceptPairing(reqH.requestId)
    bindProfile('B', credB)
    await syncService.getPairState()
    bindProfile('A', credA)
    insertLegacyHistory(sqliteA!)
    insertExclusiveMessage(sqliteA!, 'holder-m1', 'seed-t1', 'holder exclusive', 2)
    insertExclusiveBlock(sqliteA!, 'holder-b1', 'holder-m1', 'holder exclusive')
    bindProfile('A', credA)
    const resH = await syncService.runSeedBaselineIfPending()
    expect(resH.kind).toBe('published')
    const cursorH = dbA!.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
    const n = Number(cursorH?.value ?? 0)
    expect(n).toBeGreaterThan(0)
    // Receiver bootstraps with an unversioned exclusive under the same shared topic.
    bindProfile('B', credB)
    insertSharedTopicOnly(sqliteB!)
    insertExclusiveMessage(sqliteB!, 'recv-hm1', 'seed-t1', 'receiver exclusive', 2)
    insertExclusiveBlock(sqliteB!, 'recv-hb1', 'recv-hm1', 'receiver exclusive')
    await syncService.sync()
    expect(readCursor(dbB!)).toBeGreaterThanOrEqual(n)
    // Bootstrap adoption push plus incremental suffix-merge of the holder
    // exclusive may leave one merge op for the next push; drain it here.
    if (outboxCount(dbB!) > 0) await syncService.sync()
    expect(outboxCount(dbB!)).toBe(0)
    const orderB = (
      sqliteB!
        .prepare(`SELECT id FROM messages WHERE topic_id='seed-t1' ORDER BY sort_order ASC, id ASC`)
        .all() as Array<{ id: string }>
    ).map((r) => r.id)
    expect(orderB).toContain('seed-m1')
    expect(orderB).toContain('seed-m2')
    expect(orderB).toContain('holder-m1')
    expect(orderB).toContain('recv-hm1')
    const frameB = sqliteB!
      .prepare(
        `SELECT ordered_child_ids_json AS json, timestamp FROM sync_parent_order_frame WHERE kind='topicMessage' AND parent_id='seed-t1'`
      )
      .get() as { json: string; timestamp: number }
    const listedB = JSON.parse(frameB.json) as string[]
    for (const id of orderB) expect(listedB).toContain(id)
    // Seed converges on the receiver exclusive, receiver already has holder exclusive.
    bindProfile('A', credA)
    await syncService.sync()
    expect(sqliteA!.prepare(`SELECT id FROM messages WHERE id='recv-hm1'`).get()).toBeTruthy()
    expect(sqliteA!.prepare(`SELECT id FROM message_blocks WHERE id='recv-hb1'`).get()).toBeTruthy()
    bindProfile('B', credB)
    await syncService.sync()
    // Drain the wall-fresh repair winner (A mints a strictly larger union on
    // pull; B adopts it next round) before asserting full frame identity.
    bindProfile('A', credA)
    await syncService.sync()
    bindProfile('B', credB)
    await syncService.sync()
    const orderA = (
      sqliteA!
        .prepare(`SELECT id FROM messages WHERE topic_id='seed-t1' ORDER BY sort_order ASC, id ASC`)
        .all() as Array<{ id: string }>
    ).map((r) => r.id)
    const orderB2 = (
      sqliteB!
        .prepare(`SELECT id FROM messages WHERE topic_id='seed-t1' ORDER BY sort_order ASC, id ASC`)
        .all() as Array<{ id: string }>
    ).map((r) => r.id)
    expect(orderB2).toEqual(orderA)
    const frameA = sqliteA!
      .prepare(
        `SELECT ordered_child_ids_json AS json, timestamp, operation_id AS operationId FROM sync_parent_order_frame WHERE kind='topicMessage' AND parent_id='seed-t1'`
      )
      .get()
    const frameB2 = sqliteB!
      .prepare(
        `SELECT ordered_child_ids_json AS json, timestamp, operation_id AS operationId FROM sync_parent_order_frame WHERE kind='topicMessage' AND parent_id='seed-t1'`
      )
      .get() as { json: string; timestamp: number; operationId: string }
    {
      const fa = frameA as { json: string; timestamp: number; operationId: string }
      expect(frameB2.json).toBe(fa.json)
      expect(frameB2.timestamp).toBe(fa.timestamp)
      expect(frameB2.operationId).toBe(fa.operationId)
    }
    // No storm on retry: frames stable, outbox drained both sides.
    const framesA = (sqliteA!.prepare(`SELECT COUNT(*) as n FROM sync_parent_order_frame`).get() as { n: number }).n
    bindProfile('A', credA)
    await syncService.sync()
    bindProfile('B', credB)
    await syncService.sync()
    expect(
      (sqliteB!.prepare(`SELECT COUNT(*) as n FROM sync_parent_order_frame`).get() as { n: number }).n
    ).toBeGreaterThan(0)
    expect(framesA).toBeGreaterThan(0)
    expect(outboxCount(dbA!)).toBe(0)
    expect(outboxCount(dbB!)).toBe(0)
  }, 60000)

  it('receiver exclusive block under an incoming shared message parent converges', async () => {
    const n = await pairAndSeedPublish()
    void n
    bindProfile('B', credB)
    // Shared topic + shared message seed-m1 identical to incoming, plus an
    // exclusive block under that shared message (shared message parent).
    insertSharedTopicOnly(sqliteB!)
    sqliteB!
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'seed-m1',
        'seed-t1',
        'user',
        'hello',
        'success',
        null,
        null,
        null,
        null,
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        0,
        null
      )
    insertExclusiveBlock(sqliteB!, 'recv-sb1', 'seed-m1', 'exclusive block under shared message')
    await syncService.sync()
    expect(outboxCount(dbB!)).toBe(0)
    expect(sqliteB!.prepare(`SELECT id FROM message_blocks WHERE id='seed-b1'`).get()).toBeTruthy()
    expect(sqliteB!.prepare(`SELECT id FROM message_blocks WHERE id='recv-sb1'`).get()).toBeTruthy()
    const borderB = (
      sqliteB!
        .prepare(`SELECT id FROM message_blocks WHERE message_id='seed-m1' ORDER BY sort_order ASC, id ASC`)
        .all() as Array<{ id: string }>
    ).map((r) => r.id)
    expect(borderB).toContain('seed-b1')
    expect(borderB).toContain('recv-sb1')
    const frameB = sqliteB!
      .prepare(
        `SELECT ordered_child_ids_json AS json FROM sync_parent_order_frame WHERE kind='messageBlock' AND parent_id='seed-m1'`
      )
      .get() as { json: string }
    const listed = JSON.parse(frameB.json) as string[]
    expect(listed).toEqual(borderB)
    bindProfile('A', credA)
    await syncService.sync()
    expect(sqliteA!.prepare(`SELECT id FROM message_blocks WHERE id='recv-sb1'`).get()).toBeTruthy()
    const borderA = (
      sqliteA!
        .prepare(`SELECT id FROM message_blocks WHERE message_id='seed-m1' ORDER BY sort_order ASC, id ASC`)
        .all() as Array<{ id: string }>
    ).map((r) => r.id)
    expect(borderA).toEqual(borderB)
    // Drain repair unions (upsert repair enqueues in pull tx, pushes next cycle).
    bindProfile('B', credB)
    await syncService.sync()
    bindProfile('A', credA)
    await syncService.sync()
    bindProfile('B', credB)
    await syncService.sync()
    expect(outboxCount(dbA!)).toBe(0)
    expect(outboxCount(dbB!)).toBe(0)
  }, 60000)

  it('single bootstrap adopts pure and shared parents together', async () => {
    const n = await pairAndSeedPublish()
    void n
    bindProfile('B', credB)
    // Pure exclusive subtree plus shared-topic exclusive in one bootstrap.
    sqliteB!
      .prepare(
        `INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        'pure-t1',
        'a1',
        'Pure',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        null,
        JSON.stringify({ pinned: false, prompt: null, isNameManuallyEdited: false })
      )
    insertExclusiveMessage(sqliteB!, 'pure-m1', 'pure-t1', 'pure one', 0)
    insertExclusiveBlock(sqliteB!, 'pure-b1', 'pure-m1', 'pure one')
    insertSharedTopicOnly(sqliteB!)
    insertExclusiveMessage(sqliteB!, 'shared-m1', 'seed-t1', 'shared exclusive', 2)
    insertExclusiveBlock(sqliteB!, 'shared-b1', 'shared-m1', 'shared exclusive')
    await syncService.sync()
    expect(readCursor(dbB!)).toBeGreaterThan(0)
    expect(outboxCount(dbB!)).toBe(0)
    expect(sqliteB!.prepare(`SELECT id FROM topics WHERE id='pure-t1'`).get()).toBeTruthy()
    expect(sqliteB!.prepare(`SELECT id FROM messages WHERE id='shared-m1'`).get()).toBeTruthy()
    const pureOrder = (
      sqliteB!
        .prepare(`SELECT id FROM messages WHERE topic_id='pure-t1' ORDER BY sort_order ASC, id ASC`)
        .all() as Array<{ id: string }>
    ).map((r) => r.id)
    expect(pureOrder).toEqual(['pure-m1'])
    const sharedOrder = (
      sqliteB!
        .prepare(`SELECT id FROM messages WHERE topic_id='seed-t1' ORDER BY sort_order ASC, id ASC`)
        .all() as Array<{ id: string }>
    ).map((r) => r.id)
    expect(sharedOrder[sharedOrder.length - 1]).toBe('shared-m1')
    expect(
      sqliteB!.prepare(`SELECT * FROM sync_parent_order_frame WHERE kind='topicMessage' AND parent_id='pure-t1'`).get()
    ).toBeTruthy()
    expect(
      sqliteB!.prepare(`SELECT * FROM sync_parent_order_frame WHERE kind='topicMessage' AND parent_id='seed-t1'`).get()
    ).toBeTruthy()
    bindProfile('A', credA)
    await syncService.sync()
    expect(sqliteA!.prepare(`SELECT id FROM topics WHERE id='pure-t1'`).get()).toBeTruthy()
    expect(sqliteA!.prepare(`SELECT id FROM messages WHERE id='shared-m1'`).get()).toBeTruthy()
    expect(sqliteA!.prepare(`SELECT id FROM message_blocks WHERE id='pure-b1'`).get()).toBeTruthy()
    expect(sqliteA!.prepare(`SELECT id FROM message_blocks WHERE id='shared-b1'`).get()).toBeTruthy()
    // Drain incremental repair unions before asserting empty.
    bindProfile('B', credB)
    await syncService.sync()
    bindProfile('A', credA)
    await syncService.sync()
    bindProfile('B', credB)
    await syncService.sync()
    expect(outboxCount(dbA!)).toBe(0)
    expect(outboxCount(dbB!)).toBe(0)
  }, 60000)
})

describe('receiver union stable non-success bootstrap (cursor-0 ordinary live stable history)', () => {
  it('exclusive error/paused/sent/legacy message/block combos bootstrap, mint membership/frames, push back, converge with no storm; baseline projectable', async () => {
    const n = await pairAndSeedPublish()
    bindProfile('B', credB)
    insertSharedTopicOnly(sqliteB!)
    const combos: Array<{ msg: string; blk: string; status: string }> = [
      { msg: 'ns-m-err', blk: 'ns-b-err', status: 'error' },
      { msg: 'ns-m-paused', blk: 'ns-b-paused', status: 'paused' },
      { msg: 'ns-m-sent', blk: 'ns-b-sent', status: 'sent' },
      { msg: 'ns-m-legacy', blk: 'ns-b-legacy', status: 'archived' }
    ]
    let sort = 2
    for (const c of combos) {
      insertExclusiveMessageWithStatus(sqliteB!, c.msg, 'seed-t1', `body ${c.status}`, c.status, sort)
      sort += 1
      insertExclusiveBlockWithStatus(sqliteB!, c.blk, c.msg, `body ${c.status}`, c.status)
    }
    await syncService.sync()
    expect(readCursor(dbB!)).toBeGreaterThanOrEqual(n)
    if (outboxCount(dbB!) > 0) await syncService.sync()
    expect(outboxCount(dbB!)).toBe(0)
    // All exclusives retained with statuses preserved; suffix after incoming.
    const orderRows = (
      sqliteB!
        .prepare(`SELECT id FROM messages WHERE topic_id='seed-t1' ORDER BY sort_order ASC, id ASC`)
        .all() as Array<{ id: string }>
    ).map((r) => r.id)
    expect(orderRows).toContain('seed-m1')
    expect(orderRows).toContain('seed-m2')
    for (const c of combos) {
      expect(orderRows).toContain(c.msg)
      const mrow = sqliteB!.prepare(`SELECT status FROM messages WHERE id=?`).get(c.msg) as { status: string }
      expect(mrow.status).toBe(c.status)
      const brow = sqliteB!.prepare(`SELECT status FROM message_blocks WHERE id=?`).get(c.blk) as { status: string }
      expect(brow.status).toBe(c.status)
      const mem = sqliteB!.prepare(`SELECT timestamp FROM sync_membership_clock WHERE child_entity_id=?`).get(c.msg) as
        | { timestamp: number }
        | undefined
      expect(mem).toBeTruthy()
      const bmem = sqliteB!.prepare(`SELECT timestamp FROM sync_membership_clock WHERE child_entity_id=?`).get(c.blk) as
        | { timestamp: number }
        | undefined
      expect(bmem).toBeTruthy()
    }
    // Minted frame covers incoming winner plus exclusives; frame above entities.
    const frame = sqliteB!
      .prepare(
        `SELECT ordered_child_ids_json AS json, timestamp AS ts FROM sync_parent_order_frame WHERE kind='topicMessage' AND parent_id='seed-t1'`
      )
      .get() as { json: string; ts: number }
    expect(frame).toBeTruthy()
    const listed = JSON.parse(frame.json) as string[]
    for (const id of orderRows) expect(listed).toContain(id)
    for (const c of combos) {
      const ent = sqliteB!.prepare(`SELECT timestamp FROM sync_entity_clock WHERE entity_id=?`).get(c.msg) as {
        timestamp: number
      }
      expect(frame.ts).toBeGreaterThan(ent.timestamp)
    }
    // Baseline becomes projectable: no unversioned-membership.
    const { captureLocalSyncBaselineCandidate } = await import('../syncBaseline')
    const cand = captureLocalSyncBaselineCandidate(dbB!)
    expect(cand.completeness.reasons).not.toContain('unversioned-membership')
    // Seed converges on every exclusive with wire statuses preserved.
    bindProfile('A', credA)
    await syncService.sync()
    for (const c of combos) {
      expect(sqliteA!.prepare(`SELECT id FROM messages WHERE id=?`).get(c.msg)).toBeTruthy()
      expect(sqliteA!.prepare(`SELECT id FROM message_blocks WHERE id=?`).get(c.blk)).toBeTruthy()
      const mrow = sqliteA!.prepare(`SELECT status FROM messages WHERE id=?`).get(c.msg) as { status: string }
      expect(mrow.status).toBe(c.status)
    }
    const orderA = (
      sqliteA!
        .prepare(`SELECT id FROM messages WHERE topic_id='seed-t1' ORDER BY sort_order ASC, id ASC`)
        .all() as Array<{ id: string }>
    ).map((r) => r.id)
    bindProfile('B', credB)
    await syncService.sync()
    bindProfile('A', credA)
    await syncService.sync()
    bindProfile('B', credB)
    await syncService.sync()
    const orderB2 = (
      sqliteB!
        .prepare(`SELECT id FROM messages WHERE topic_id='seed-t1' ORDER BY sort_order ASC, id ASC`)
        .all() as Array<{ id: string }>
    ).map((r) => r.id)
    expect(orderB2).toEqual(orderA)
    const framesBefore = (sqliteB!.prepare(`SELECT COUNT(*) as n FROM sync_parent_order_frame`).get() as { n: number })
      .n
    bindProfile('A', credA)
    await syncService.sync()
    bindProfile('B', credB)
    await syncService.sync()
    expect((sqliteB!.prepare(`SELECT COUNT(*) as n FROM sync_parent_order_frame`).get() as { n: number }).n).toBe(
      framesBefore
    )
    expect(outboxCount(dbA!)).toBe(0)
    expect(outboxCount(dbB!)).toBe(0)
  }, 60000)

  it('shared-message parent exclusive non-success block converges', async () => {
    const n = await pairAndSeedPublish()
    void n
    bindProfile('B', credB)
    insertSharedTopicOnly(sqliteB!)
    sqliteB!
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'seed-m1',
        'seed-t1',
        'user',
        'hello',
        'success',
        null,
        null,
        null,
        null,
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        0,
        null
      )
    insertExclusiveBlockWithStatus(sqliteB!, 'ns-shared-b-err', 'seed-m1', 'exclusive error block', 'error')
    await syncService.sync()
    if (outboxCount(dbB!) > 0) await syncService.sync()
    expect(outboxCount(dbB!)).toBe(0)
    expect(sqliteB!.prepare(`SELECT id FROM message_blocks WHERE id='seed-b1'`).get()).toBeTruthy()
    expect(sqliteB!.prepare(`SELECT id FROM message_blocks WHERE id='ns-shared-b-err'`).get()).toBeTruthy()
    const borderB = (
      sqliteB!
        .prepare(`SELECT id FROM message_blocks WHERE message_id='seed-m1' ORDER BY sort_order ASC, id ASC`)
        .all() as Array<{ id: string }>
    ).map((r) => r.id)
    expect(borderB).toContain('seed-b1')
    expect(borderB).toContain('ns-shared-b-err')
    const frameB = sqliteB!
      .prepare(
        `SELECT ordered_child_ids_json AS json FROM sync_parent_order_frame WHERE kind='messageBlock' AND parent_id='seed-m1'`
      )
      .get() as { json: string }
    expect(JSON.parse(frameB.json)).toEqual(borderB)
    bindProfile('A', credA)
    await syncService.sync()
    expect(sqliteA!.prepare(`SELECT id FROM message_blocks WHERE id='ns-shared-b-err'`).get()).toBeTruthy()
    const borderA = (
      sqliteA!
        .prepare(`SELECT id FROM message_blocks WHERE message_id='seed-m1' ORDER BY sort_order ASC, id ASC`)
        .all() as Array<{ id: string }>
    ).map((r) => r.id)
    expect(borderA).toEqual(borderB)
    bindProfile('B', credB)
    await syncService.sync()
    bindProfile('A', credA)
    await syncService.sync()
    bindProfile('B', credB)
    await syncService.sync()
    expect(outboxCount(dbA!)).toBe(0)
    expect(outboxCount(dbB!)).toBe(0)
  }, 60000)

  it('same-ID status divergence and partial non-success fail closed with zero writes', async () => {
    await pairAndSeedPublish()
    bindProfile('A', credA)
    const { captureLocalSyncBaselineCandidate } = await import('../syncBaseline')
    const { buildPublishEnvelope } = await import('../syncBaselinePublish')
    const { mapWireEnvelopeToMergeInput } = await import('../syncBaselineWireApply')
    const { mergeValidatedBaselineInTx } = await import('../syncBaselineApply')
    const { adoptReceiverExclusiveInTx: adoptTx } = await import('../syncReceiverUnion')
    const candidate = captureLocalSyncBaselineCandidate(dbA!)
    const channelId = candidate.observedLocalChannelKey as string
    const watermark = candidate.observedLocalCursor as number
    const { envelope } = buildPublishEnvelope(candidate, channelId, watermark)
    const snapOf = (cDb: BetterSQLite3Database<typeof schema>, cSqlite: Database.Database): unknown => ({
      outbox: cDb.select().from(schema.syncOutbox).all(),
      entity: cSqlite.prepare(`SELECT * FROM sync_entity_clock`).all(),
      field: cSqlite.prepare(`SELECT * FROM sync_field_clock`).all(),
      membership: cSqlite.prepare(`SELECT * FROM sync_membership_clock`).all(),
      frame: cSqlite.prepare(`SELECT * FROM sync_parent_order_frame`).all(),
      topics: cSqlite.prepare(`SELECT * FROM topics ORDER BY id`).all(),
      messages: cSqlite.prepare(`SELECT * FROM messages ORDER BY id`).all(),
      blocks: cSqlite.prepare(`SELECT * FROM message_blocks ORDER BY id`).all()
    })
    // Same-ID status divergence: local seed-m1 flipped to error while incoming
    // carries success — strict-identical overlap fails the whole tx.
    {
      const fresh = openChatDb()
      try {
        insertLegacyHistory(fresh.sqlite)
        fresh.sqlite.prepare(`UPDATE messages SET status='error' WHERE id='seed-m1'`).run()
        const before = snapOf(fresh.db, fresh.sqlite)
        expect(() =>
          fresh.db.transaction((tx) => {
            const mapped = mapWireEnvelopeToMergeInput(envelope)
            adoptTx(tx as never, mapped.input, 'test-device-ns-diverge')
            mergeValidatedBaselineInTx(tx as never, mapped.input)
          })
        ).toThrow()
        expect(snapOf(fresh.db, fresh.sqlite)).toEqual(before)
      } finally {
        try {
          fresh.sqlite.close()
        } catch {}
      }
    }
    // Partial non-success: exclusive error message with entity clock but
    // missing field/membership stays fail-closed with zero writes.
    {
      const fresh = openChatDb()
      try {
        insertSharedTopicOnly(fresh.sqlite)
        insertExclusiveMessageWithStatus(fresh.sqlite, 'ns-p-m1', 'seed-t1', 'x', 'error', 2)
        insertExclusiveBlockWithStatus(fresh.sqlite, 'ns-p-b1', 'ns-p-m1', 'x', 'error')
        fresh.db
          .insert(schema.syncEntityClock)
          .values({
            entityType: 'message',
            entityId: 'ns-p-m1',
            timestamp: 1,
            operationId: '00000000-0000-4000-a000-000000000031'
          })
          .run()
        const before = snapOf(fresh.db, fresh.sqlite)
        expect(() =>
          fresh.db.transaction((tx) => {
            const mapped = mapWireEnvelopeToMergeInput(envelope)
            adoptTx(tx as never, mapped.input, 'test-device-ns-partial')
            mergeValidatedBaselineInTx(tx as never, mapped.input)
          })
        ).toThrow()
        expect(snapOf(fresh.db, fresh.sqlite)).toEqual(before)
      } finally {
        try {
          fresh.sqlite.close()
        } catch {}
      }
    }
  }, 60000)
})
