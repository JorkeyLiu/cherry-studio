/**
 * One-shot seed baseline first close (SYNC-CC-026): adoption tx, orchestration,
 * and seed receiver gates. Main-native integration, no E2E fixture.
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
import { adoptSeedBaselineOnce } from '../syncSeedAdoption'
import { syncService } from '../SyncService'

let sqliteA: Database.Database | null = null
let sqliteB: Database.Database | null = null
let dbA: BetterSQLite3Database<typeof schema> | null = null
let dbB: BetterSQLite3Database<typeof schema> | null = null
let aggA: ChatDbAggregateService | null = null
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
  // Ordinary stable supported history without any sync clocks/frames (legacy).
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

beforeEach(() => {
  configStore.clear()
  credA = { deviceId: '', code: '', secret: '' }
  credB = { deviceId: '', code: '', secret: '' }
  ownedTmp = mkdtempSync(join(tmpdir(), 'sync-seed-'))
  relayDbPath = join(ownedTmp, 'relay.db')
  relayToken = `seed-${randomBytes(8).toString('hex')}`
  relayDb = new Database(relayDbPath)
  relayDb.pragma('journal_mode = WAL')
  ensureRelaySchema(relayDb)
  const a = openChatDb()
  sqliteA = a.sqlite
  dbA = a.db
  aggA = new ChatDbAggregateService(dbA, sqliteA)
  void aggA
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
  aggA = null
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

function bindUnitDb(sqlite: Database.Database, db: BetterSQLite3Database<typeof schema>): void {
  ;(chatDbService as unknown as { sqlite: unknown }).sqlite = sqlite
  ;(chatDbService as unknown as { db: unknown }).db = db
  configStore.set('deviceId', 'seed-unit-device')
}

function setBoundState(db: BetterSQLite3Database<typeof schema>): void {
  db.insert(schema.syncState)
    .values({ key: 'sync:channelKey', value: 'test-seed-channel' })
    .onConflictDoUpdate({ target: schema.syncState.key, set: { value: 'test-seed-channel' } })
    .run()
  db.insert(schema.syncState)
    .values({ key: 'cursor', value: '0' })
    .onConflictDoUpdate({ target: schema.syncState.key, set: { value: '0' } })
    .run()
}

describe('seed adoption tx', () => {
  it('mints full-state clocks + membership + frames and reaches complete; restart idempotent', () => {
    const { sqlite, db } = openChatDb()
    try {
      setBoundState(db)
      bindUnitDb(sqlite, db)
      insertLegacyHistory(sqlite)
      const before = captureLocalSyncBaselineCandidate(db as never)
      expect(before.completeness.state).toBe('partial')
      expect(before.completeness.reasons).toContain('unversioned-entity')
      const first = adoptSeedBaselineOnce(db as never, syncService as never)
      expect(first.kind).toBe('adopted')
      const after = captureLocalSyncBaselineCandidate(db as never)
      expect(after.completeness.reasons).not.toContain('unversioned-entity')
      expect(after.completeness.reasons).not.toContain('unversioned-field')
      expect(after.completeness.reasons).not.toContain('unversioned-membership')
      expect(after.completeness.reasons).not.toContain('missing-order-frame')
      expect(after.completeness.reasons).not.toContain('incomplete-order-frame')
      // Clocks + membership + frames present.
      expect(sqlite.prepare(`SELECT COUNT(*) as n FROM sync_entity_clock`).get()).toBeTruthy()
      expect(
        (sqlite.prepare(`SELECT COUNT(*) as n FROM sync_membership_clock`).get() as { n: number }).n
      ).toBeGreaterThan(0)
      expect(
        (sqlite.prepare(`SELECT COUNT(*) as n FROM sync_parent_order_frame`).get() as { n: number }).n
      ).toBeGreaterThan(0)
      // Outbox carries full-state upserts (allowlist, no sortOrder) + frames.
      const outbox = db.select().from(schema.syncOutbox).all()
      expect(outbox.length).toBeGreaterThan(0)
      for (const row of outbox) {
        if (row.op === 'upsert' && row.payloadJson) {
          expect(row.payloadJson).not.toContain('sortOrder')
        }
      }
      // Adoption ops sit in outbox until the post-tx drain; simulate the drain
      // (relay push clears outbox) and the candidate must then be complete.
      db.delete(schema.syncOutbox).run()
      const drained = captureLocalSyncBaselineCandidate(db as never)
      expect(drained.completeness.state).toBe('complete')
      // Restart/idempotent: existing clocks never rewritten, second run no-op.
      const entityBefore = sqlite
        .prepare(
          `SELECT entity_type, entity_id, timestamp, operation_id FROM sync_entity_clock ORDER BY entity_type, entity_id`
        )
        .all()
      const second = adoptSeedBaselineOnce(db as never, syncService as never)
      expect(second.kind).toBe('already-adopted')
      const entityAfter = sqlite
        .prepare(
          `SELECT entity_type, entity_id, timestamp, operation_id FROM sync_entity_clock ORDER BY entity_type, entity_id`
        )
        .all()
      expect(entityAfter).toEqual(entityBefore)
    } finally {
      try {
        sqlite.close()
      } catch {}
    }
  })

  it('unsupported/transient/orphan preconditions defer with 0 writes', () => {
    const { sqlite, db } = openChatDb()
    try {
      setBoundState(db)
      bindUnitDb(sqlite, db)
      insertLegacyHistory(sqlite)
      // Unsupported block + transient message + orphan block.
      sqlite
        .prepare(
          `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(
          'seed-bad',
          'seed-m1',
          'image',
          'x',
          'success',
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          1,
          null
        )
      sqlite
        .prepare(
          `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          'seed-trans',
          'seed-t1',
          'assistant',
          't',
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
      const outboxBefore = db.select().from(schema.syncOutbox).all().length
      const clocksBefore = (sqlite.prepare(`SELECT COUNT(*) as n FROM sync_entity_clock`).get() as { n: number }).n
      const res = adoptSeedBaselineOnce(db as never, syncService as never)
      expect(res.kind).toBe('deferred')
      expect(db.select().from(schema.syncOutbox).all().length).toBe(outboxBefore)
      expect((sqlite.prepare(`SELECT COUNT(*) as n FROM sync_entity_clock`).get() as { n: number }).n).toBe(
        clocksBefore
      )
    } finally {
      try {
        sqlite.close()
      } catch {}
    }
  })

  it('injected clock failure rolls back with zero partial outbox/clocks/frames', () => {
    const { sqlite, db } = openChatDb()
    try {
      setBoundState(db)
      bindUnitDb(sqlite, db)
      insertLegacyHistory(sqlite)
      sqlite.exec(
        `CREATE TRIGGER inject_seed_fail BEFORE INSERT ON sync_entity_clock BEGIN SELECT RAISE(ABORT, 'injected-seed-fail'); END`
      )
      const res = adoptSeedBaselineOnce(db as never, syncService as never)
      expect(res.kind).toBe('deferred')
      expect(db.select().from(schema.syncOutbox).all().length).toBe(0)
      expect((sqlite.prepare(`SELECT COUNT(*) as n FROM sync_entity_clock`).get() as { n: number }).n).toBe(0)
      expect((sqlite.prepare(`SELECT COUNT(*) as n FROM sync_field_clock`).get() as { n: number }).n).toBe(0)
      expect((sqlite.prepare(`SELECT COUNT(*) as n FROM sync_membership_clock`).get() as { n: number }).n).toBe(0)
      expect((sqlite.prepare(`SELECT COUNT(*) as n FROM sync_parent_order_frame`).get() as { n: number }).n).toBe(0)
    } finally {
      try {
        sqlite.exec(`DROP TRIGGER IF EXISTS inject_seed_fail`)
      } catch {}
      try {
        sqlite.close()
      } catch {}
    }
  })

  it('field-only repair retains existing membership and only fills missing clocks', () => {
    const { sqlite, db } = openChatDb()
    try {
      setBoundState(db)
      bindUnitDb(sqlite, db)
      insertLegacyHistory(sqlite)
      // Pre-seed a valid membership for seed-m1 so adoption must not rewrite it.
      const existingTs = 123456
      const existingOp = '00000000-0000-4000-a000-000000000001'
      db.insert(schema.syncMembershipClock)
        .values({
          childEntityType: 'message',
          childEntityId: 'seed-m1',
          parentId: 'seed-t1',
          timestamp: existingTs,
          operationId: existingOp
        })
        .run()
      // Pre-seed entity clock for seed-m1 but leave one field clock missing (e.g. role).
      // Insert entity clock and a subset of field clocks for seed-m1 (topic field clocks omitted for brevity).
      db.insert(schema.syncEntityClock)
        .values({ entityType: 'message', entityId: 'seed-m1', timestamp: existingTs, operationId: existingOp })
        .run()
      // Insert field clocks for all except 'role' to force field-only repair.
      const fields = [
        'content',
        'status',
        'askId',
        'model',
        'modelId',
        'assistantId',
        'createdAt',
        'updatedAt'
      ] as const
      for (const f of fields) {
        db.insert(schema.syncFieldClock)
          .values({
            entityType: 'message',
            entityId: 'seed-m1',
            field: f,
            timestamp: existingTs,
            operationId: existingOp
          })
          .run()
      }
      const outboxBefore = db.select().from(schema.syncOutbox).all().length
      const res = adoptSeedBaselineOnce(db as never, syncService as never)
      expect(res.kind).toBe('adopted')
      // Existing membership unchanged.
      const mem = syncService.getMembershipClockInTx(db as never, 'message', 'seed-m1')
      expect(mem).toBeTruthy()
      expect(mem!.timestamp).toBe(existingTs)
      expect(mem!.operationId).toBe(existingOp)
      // Field clocks now complete; entity clock advances to adoption time, membership preserved.
      const entityRow = sqlite
        .prepare(
          `SELECT timestamp, operation_id as operationId FROM sync_entity_clock WHERE entity_type='message' AND entity_id='seed-m1'`
        )
        .get() as { timestamp: number; operationId: string } | undefined
      expect(entityRow).toBeTruthy()
      expect(entityRow!.timestamp).toBeGreaterThan(existingTs)
      const fieldRole = sqlite
        .prepare(
          `SELECT timestamp FROM sync_field_clock WHERE entity_type='message' AND entity_id='seed-m1' AND field='role'`
        )
        .get() as { timestamp: number } | undefined
      expect(fieldRole).toBeTruthy()
      // Outbox should contain exactly the repaired missing field (role) plus other unversioned entities.
      expect(db.select().from(schema.syncOutbox).all().length).toBeGreaterThan(outboxBefore)
    } finally {
      try {
        sqlite.close()
      } catch {}
    }
  })

  it('adoption clock is monotonic over existing entity/field/membership/frame/high-water maxima', () => {
    const { sqlite, db } = openChatDb()
    try {
      setBoundState(db)
      bindUnitDb(sqlite, db)
      insertLegacyHistory(sqlite)
      // Seed a high existing clock far above wall so maxObserved governs.
      const highTs = 9_000_000_000_000
      db.insert(schema.syncEntityClock)
        .values({
          entityType: 'topic',
          entityId: 'seed-high',
          timestamp: highTs,
          operationId: '00000000-0000-4000-a000-000000000002'
        })
        .run()
      db.insert(schema.syncFrameHighWater)
        .values({ kind: 'topicMessage', parentId: 'seed-t1', maxTimestamp: highTs })
        .run()
      const wallBefore = Date.now()
      const res = adoptSeedBaselineOnce(db as never, syncService as never)
      expect(res.kind).toBe('adopted')
      const minted = sqlite
        .prepare(`SELECT timestamp FROM sync_entity_clock WHERE entity_type='topic' AND entity_id='seed-t1'`)
        .get() as { timestamp: number } | undefined
      expect(minted).toBeTruthy()
      expect(minted!.timestamp).toBeGreaterThan(highTs)
      expect(minted!.timestamp).toBeGreaterThanOrEqual(wallBefore)
      expect(minted!.timestamp).toBeLessThan(Number.MAX_SAFE_INTEGER)
      // Frame clocks strictly above entity clock.
      const frame = sqlite
        .prepare(`SELECT timestamp FROM sync_parent_order_frame WHERE kind='topicMessage' AND parent_id='seed-t1'`)
        .get() as { timestamp: number } | undefined
      expect(frame).toBeTruthy()
      expect(frame!.timestamp).toBeGreaterThan(minted!.timestamp)
    } finally {
      try {
        sqlite.close()
      } catch {}
    }
  })

  it('MAX_SAFE exhaustion fail-closes with 0 writes', () => {
    const { sqlite, db } = openChatDb()
    try {
      setBoundState(db)
      bindUnitDb(sqlite, db)
      insertLegacyHistory(sqlite)
      db.insert(schema.syncEntityClock)
        .values({
          entityType: 'topic',
          entityId: 'seed-high',
          timestamp: Number.MAX_SAFE_INTEGER - 1,
          operationId: '00000000-0000-4000-a000-000000000003'
        })
        .run()
      const outboxBefore = db.select().from(schema.syncOutbox).all().length
      const res = adoptSeedBaselineOnce(db as never, syncService as never)
      expect(res.kind).toBe('deferred')
      expect((res as { reason?: string }).reason).toBe('seed-adoption-tx-failed')
      expect(db.select().from(schema.syncOutbox).all().length).toBe(outboxBefore)
      expect(
        (sqlite.prepare(`SELECT COUNT(*) as n FROM sync_entity_clock WHERE entity_id='seed-t1'`).get() as { n: number })
          .n
      ).toBe(0)
    } finally {
      try {
        sqlite.close()
      } catch {}
    }
  })

  it('local tombstone present defers with 0 writes and stable reason', () => {
    const { sqlite, db } = openChatDb()
    try {
      setBoundState(db)
      bindUnitDb(sqlite, db)
      insertLegacyHistory(sqlite)
      db.insert(schema.syncState)
        .values({ key: 'tombstone:topic:seed-t1', value: '123:00000000-0000-4000-a000-000000000004' })
        .run()
      const outboxBefore = db.select().from(schema.syncOutbox).all().length
      const res = adoptSeedBaselineOnce(db as never, syncService as never)
      expect(res.kind).toBe('deferred')
      expect((res as { reason?: string }).reason).toBe('seed-tombstone-present')
      expect(db.select().from(schema.syncOutbox).all().length).toBe(outboxBefore)
      expect((sqlite.prepare(`SELECT COUNT(*) as n FROM sync_entity_clock`).get() as { n: number }).n).toBe(0)
    } finally {
      try {
        sqlite.close()
      } catch {}
    }
  })

  it('local replacement register present defers with 0 writes and stable reason', () => {
    const { sqlite, db } = openChatDb()
    try {
      setBoundState(db)
      bindUnitDb(sqlite, db)
      insertLegacyHistory(sqlite)
      db.insert(schema.syncStableReplaceRegister)
        .values({
          messageId: 'seed-m1',
          timestamp: 1,
          operationId: '00000000-0000-4000-a000-000000000005',
          activeBlockIdsJson: '[]',
          payloadHash: 'abc'
        })
        .run()
      const outboxBefore = db.select().from(schema.syncOutbox).all().length
      const res = adoptSeedBaselineOnce(db as never, syncService as never)
      expect(res.kind).toBe('deferred')
      expect((res as { reason?: string }).reason).toBe('seed-replacement-present')
      expect(db.select().from(schema.syncOutbox).all().length).toBe(outboxBefore)
      expect((sqlite.prepare(`SELECT COUNT(*) as n FROM sync_entity_clock`).get() as { n: number }).n).toBe(0)
    } finally {
      try {
        sqlite.close()
      } catch {}
    }
  })
})

describe('seed orchestration over real relay', () => {
  it('Accept pending -> adopt -> drain -> barrier -> single PUT; B blank bootstraps N and N+1', async () => {
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
    // B requests A; A (holder) accepts.
    bindProfile('B', credB)
    const req = await syncService.requestPairing(credA.code)
    bindProfile('A', credA)
    const accepted = await syncService.acceptPairing(req.requestId)
    expect(typeof accepted.channelId).toBe('string')
    expect(syncService.hasSeedBaselineIntentForTests()).toBe(true)
    // B observes the new channel (as the UI pairing poll would) so its local
    // channelKey binds and cursor-0 sync takes the baseline bootstrap path.
    bindProfile('B', credB)
    await syncService.getPairState()
    bindProfile('A', credA)
    // Legacy history on the holder only (B stays blank for the receiver close).
    insertLegacyHistory(sqliteA!)
    // Dedicated seed flow: adopt + drain + single PUT (no tx held on network).
    bindProfile('A', credA)
    let putCount = 0
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: unknown) => {
      try {
        const url = String((input as Request)?.url ?? input)
        if (url.includes('/sync/baseline') && (init as { method?: string })?.method === 'PUT') putCount += 1
      } catch {}
      return origFetch(input as never, init as never)
    }) as typeof fetch
    try {
      const res = await syncService.runSeedBaselineIfPending()
      expect(res.kind).toBe('published')
    } finally {
      globalThis.fetch = origFetch
    }
    expect(putCount).toBe(1)
    expect(syncService.hasSeedBaselineIntentForTests()).toBe(false)
    const cursorA = dbA!.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
    const n = Number(cursorA?.value ?? 0)
    expect(n).toBeGreaterThan(0)
    // B blank bootstraps to N via production sync, then N+1 after A appends.
    bindProfile('B', credB)
    await syncService.sync()
    const cursorB = dbB!.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
    expect(Number(cursorB?.value ?? -1)).toBe(n)
    expect(sqliteB!.prepare(`SELECT id FROM topics WHERE id='seed-t1'`).get()).toBeTruthy()
    // N+1: holder appends one message via production path, B pulls it.
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
    // Ordinary second sync without pending never PUTs again.
    let secondPuts = 0
    globalThis.fetch = (async (input: unknown, init?: unknown) => {
      try {
        const url = String((input as Request)?.url ?? input)
        if (url.includes('/sync/baseline') && (init as { method?: string })?.method === 'PUT') secondPuts += 1
      } catch {}
      return origFetch(input as never, init as never)
    }) as typeof fetch
    try {
      bindProfile('B', credB)
      await syncService.sync()
    } finally {
      globalThis.fetch = origFetch
    }
    expect(secondPuts).toBe(0)
  }, 60000)
})

describe('seed receiver first close over real relay', () => {
  function keepMsg(id: string, topicId: string, content: string): Record<string, unknown> {
    return {
      id,
      topicId,
      role: 'user',
      content,
      status: 'success',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z'
    }
  }

  function keepBlock(id: string, messageId: string, content: string): Record<string, unknown> {
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

  function ensureKeepOutbox(): void {
    const agg = new ChatDbAggregateService(dbB!, sqliteB!)
    const ensured = agg.ensureTopic('b-keep-topic', 'a1', 'Keep Topic')
    if (!ensured.ok) throw new Error('ensureTopic failed for b-keep-topic')
    expect(
      agg.appendMessage('b-keep-topic', keepMsg('b-keep-msg', 'b-keep-topic', 'keep me') as never, [
        keepBlock('b-keep-blk', 'b-keep-msg', 'keep me') as never
      ]).ok
    ).toBe(true)
  }

  function readCursorB(): number {
    const row = dbB!.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
    return row ? Number(row.value) : 0
  }

  function outboxCountB(): number {
    return dbB!.select().from(schema.syncOutbox).all().length
  }

  function lastErrorB(): string | null {
    const row = dbB!.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastError')).get()
    return (row?.value as string | null) ?? null
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
    // B observes the new channel so cursor-0 sync bootstraps from the baseline.
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

  it('strict-identical unversioned rows adopt via existing apply and install clocks', async () => {
    const n = await pairAndSeedPublish()
    bindProfile('B', credB)
    ensureKeepOutbox()
    const keepOps = outboxCountB()
    expect(keepOps).toBeGreaterThan(0)
    // Same IDs/parents/field values as the seed baseline, but no clocks.
    insertLegacyHistory(sqliteB!)
    await syncService.sync()
    // Bootstrap committed N, then the keep outbox pushed: cursor == head.
    expect(readCursorB()).toBe(n + keepOps)
    expect(lastErrorB()).toBeNull()
    // Clocks installed as metadata repair; values untouched.
    const entity = sqliteB!
      .prepare(`SELECT timestamp FROM sync_entity_clock WHERE entity_type='message' AND entity_id='seed-m1'`)
      .get() as { timestamp: number } | undefined
    expect(entity).toBeTruthy()
    const mem = sqliteB!
      .prepare(
        `SELECT parent_id AS parentId FROM sync_membership_clock WHERE child_entity_type='message' AND child_entity_id='seed-m1'`
      )
      .get() as { parentId: string } | undefined
    expect(mem?.parentId).toBe('seed-t1')
    const row = sqliteB!.prepare(`SELECT content FROM messages WHERE id='seed-m1'`).get() as {
      content: string
    }
    expect(row.content).toBe('hello')
    expect(
      (sqliteB!.prepare(`SELECT COUNT(*) as n FROM sync_parent_order_frame`).get() as { n: number }).n
    ).toBeGreaterThan(0)
    expect(outboxCountB()).toBe(0)
  }, 60000)

  it('exclusive unversioned row under a baseline parent fails the whole tx closed', async () => {
    await pairAndSeedPublish()
    bindProfile('B', credB)
    ensureKeepOutbox()
    insertLegacyHistory(sqliteB!)
    // Locally-exclusive unversioned message under the baseline topic seed-t1.
    sqliteB!
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'seed-extra',
        'seed-t1',
        'user',
        'extra',
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
    const outboxBefore = outboxCountB()
    expect(outboxBefore).toBeGreaterThan(0)
    await expect(syncService.sync()).rejects.toThrow()
    // cursor/outbox unchanged; exclusive row retained; whole-tx rollback proven
    // by zero installed clocks (no partial merge); no union performed.
    expect(readCursorB()).toBe(0)
    expect(outboxCountB()).toBe(outboxBefore)
    expect(sqliteB!.prepare(`SELECT id FROM messages WHERE id='seed-extra'`).get()).toBeTruthy()
    expect(sqliteB!.prepare(`SELECT * FROM sync_entity_clock WHERE entity_id='seed-m1'`).get()).toBeFalsy()
    // No seed-parent frames from the failed merge (B's own keep frames remain).
    expect(sqliteB!.prepare(`SELECT * FROM sync_parent_order_frame WHERE parent_id='seed-t1'`).get()).toBeFalsy()
    expect(sqliteB!.prepare(`SELECT * FROM sync_parent_order_frame WHERE parent_id='seed-m1'`).get()).toBeFalsy()
    expect(lastErrorB()).toContain('baseline bootstrap failed')
  }, 60000)

  it('seed failure retains the recovery intent (deferred, still pending)', async () => {
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
    expect(syncService.hasSeedBaselineIntentForTests()).toBe(true)
    insertLegacyHistory(sqliteA!)
    // Unsupported member breaks the 0-write precondition.
    sqliteA!
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'seed-bad',
        'seed-m1',
        'image',
        'x',
        'success',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        1,
        null
      )
    bindProfile('A', credA)
    const outboxBefore = dbA!.select().from(schema.syncOutbox).all().length
    const res = await syncService.runSeedBaselineIfPending()
    expect(res.kind).toBe('deferred')
    // 0 writes from the deferred adoption; intent retained for recovery.
    expect(dbA!.select().from(schema.syncOutbox).all().length).toBe(outboxBefore)
    expect(syncService.hasSeedBaselineIntentForTests()).toBe(true)
  }, 60000)

  it('same-ID value divergence with no clocks fails the whole tx closed', async () => {
    await pairAndSeedPublish()
    bindProfile('B', credB)
    ensureKeepOutbox()
    insertLegacyHistory(sqliteB!)
    sqliteB!.prepare(`UPDATE messages SET content='tampered' WHERE id='seed-m1'`).run()
    const outboxBefore = outboxCountB()
    expect(outboxBefore).toBeGreaterThan(0)
    await expect(syncService.sync()).rejects.toThrow()
    expect(readCursorB()).toBe(0)
    expect(outboxCountB()).toBe(outboxBefore)
    const row = sqliteB!.prepare(`SELECT content FROM messages WHERE id='seed-m1'`).get() as {
      content: string
    }
    expect(row.content).toBe('tampered')
    expect(lastErrorB()).toContain('baseline bootstrap failed')
  }, 60000)
})
