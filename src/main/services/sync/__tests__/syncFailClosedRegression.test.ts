/**
 * Fail-closed regression tests for the third audit correction pass
 * (LOCK-PERSONAL-001/005/006/010):
 * 1. EnsureTopic capture depends on actual pre-mutation row existence —
 *    an existing-but-untracked topic no-op emits no outbox/clock and never
 *    overwrites row identity; a true creation still emits.
 * 2. Field-clock reads/writes tolerate ONLY a proven pre-migration missing
 *    table; any other failure rolls back the enclosing transaction.
 * 3. Conflict-log persistence/eviction failures roll back the incoming
 *    operation (no sync_applied/clock/cursor advance) with a durable
 *    sync-cycle error that preserves the original failure.
 *
 * Failure injection uses real SQLite seams (triggers, DROP COLUMN/TABLE) on
 * throwaway in-memory databases — no mocks of SyncService internals.
 */
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
    set: (k: string, v: unknown) => configStore.set(k, v)
  },
  ConfigKeys: {}
}))

import { IpcChannel } from '@shared/IpcChannel'
import { eq } from 'drizzle-orm'

import { chatDbService } from '../../chatDb'
import { ChatDbAggregateService } from '../../chatDb/ChatDbAggregateService'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { handleChatDbSuccessForSync } from '../chatDbHook'
import { syncService } from '../SyncService'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>
let aggregate: ChatDbAggregateService

const T0 = 1_700_000_000_000

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

function seedTopicRaw(id: string, name: string, assistantId: string | null, createdAt: string): void {
  sqlite
    .prepare('INSERT INTO topics (id, name, assistant_id, created_at, updated_at, extra) VALUES (?,?,?,?,?,?)')
    .run(id, name, assistantId, createdAt, createdAt, null)
}

function entityClock(entityType: string, entityId: string): { timestamp: number; operationId: string } | null {
  const row = db
    .select()
    .from(schema.syncEntityClock)
    .where(eq(schema.syncEntityClock.entityType, entityType as never))
    .all()
    .find((r) => r.entityId === entityId)
  return row ? { timestamp: row.timestamp, operationId: row.operationId } : null
}

function fieldClock(
  entityType: string,
  entityId: string,
  field: string
): { timestamp: number; operationId: string } | null {
  const row = db
    .select()
    .from(schema.syncFieldClock)
    .where(eq(schema.syncFieldClock.entityType, entityType as never))
    .all()
    .find((r) => r.entityId === entityId && r.field === field)
  return row ? { timestamp: row.timestamp, operationId: row.operationId } : null
}

function isApplied(operationId: string): boolean {
  return !!db.select().from(schema.syncApplied).where(eq(schema.syncApplied.operationId, operationId)).get()
}

function topicName(id: string): unknown {
  return (sqlite.prepare('SELECT name FROM topics WHERE id=?').get(id) as { name: unknown } | undefined)?.name
}

function stateValue(key: string): string | null {
  return db.select().from(schema.syncState).where(eq(schema.syncState.key, key)).get()?.value ?? null
}

function applyTopicUpsert(id: string, opId: string, ts: number, name: string): boolean {
  return syncService.applyIncomingOperation({
    id: opId,
    entityType: 'topic',
    op: 'upsert',
    entityId: id,
    timestamp: ts,
    deviceId: 'remote-device',
    payload: { id, name }
  } as never)
}

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
  sqlite = openInMemory()
  db = drizzle(sqlite, { schema })
  runMigrations(db as never, sqlite)
  ;(chatDbService as never as { sqlite: unknown }).sqlite = sqlite
  ;(chatDbService as never as { db: unknown }).db = db
  aggregate = new ChatDbAggregateService(db)
  syncService.clearAllForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
  try {
    sqlite.close()
  } catch {}
  ;(chatDbService as never as { sqlite: unknown }).sqlite = null
  ;(chatDbService as never as { db: unknown }).db = null
})

describe('finding 1: EnsureTopic existence-based capture', () => {
  it('existing-but-untracked topic no-op emits no outbox/clock and preserves row identity', () => {
    seedTopicRaw('t-legacy', 'Orig', 'a-orig', '2020-01-01T00:00:00.000Z')
    expect(entityClock('topic', 't-legacy')).toBeNull()

    const result = aggregate.ensureTopic('t-legacy', 'a-other', 'Stale')
    expect(result.ok).toBe(true)
    // No sync intent for a pre-existing row, even though it was untracked.
    expect(syncService.listOutbox()).toHaveLength(0)
    expect(entityClock('topic', 't-legacy')).toBeNull()
    // Create-only: existing assistantId/name are never overwritten.
    const row = sqlite.prepare('SELECT name, assistant_id FROM topics WHERE id=?').get('t-legacy') as {
      name: string
      assistant_id: string
    }
    expect(row.name).toBe('Orig')
    expect(row.assistant_id).toBe('a-orig')
  })

  it('post-commit hook also skips an existing-but-untracked EnsureTopic no-op (stale row)', () => {
    seedTopicRaw('t-legacy-hook', 'Orig', 'a-orig', '2020-01-01T00:00:00.000Z')
    const before = syncService.listOutbox().length
    handleChatDbSuccessForSync(IpcChannel.ChatDb_EnsureTopic, {
      topicId: 't-legacy-hook',
      assistantId: 'a-other',
      name: 'Stale'
    })
    expect(syncService.listOutbox()).toHaveLength(before)
    expect(entityClock('topic', 't-legacy-hook')).toBeNull()
  })

  it('true creation still emits outbox + entity clock', () => {
    const result = aggregate.ensureTopic('t-brand-new', 'a1', 'New')
    expect(result.ok).toBe(true)
    const outbox = syncService.listOutbox()
    expect(outbox).toHaveLength(1)
    expect(outbox[0].entityType).toBe('topic')
    expect(outbox[0].entityId).toBe('t-brand-new')
    expect(entityClock('topic', 't-brand-new')).not.toBeNull()
  })

  it('no stale EnsureTopic overwrite: no-op after a newer remote value emits nothing', () => {
    expect(applyTopicUpsert('t-stale', 'op-remote-1', T0, 'Remote')).toBe(true)
    expect(topicName('t-stale')).toBe('Remote')
    const result = aggregate.ensureTopic('t-stale', 'a-x', 'StaleLocal')
    expect(result.ok).toBe(true)
    // No fresh snapshot means no LWW contest against the newer remote value.
    expect(syncService.listOutbox()).toHaveLength(0)
    expect(topicName('t-stale')).toBe('Remote')
  })
})

describe('finding 2: field-clock fail-closed', () => {
  it('field-clock write failure rolls back the incoming apply (no applied/clock/row change)', () => {
    expect(applyTopicUpsert('t-fc', 'op-fc-1', T0, 'A')).toBe(true)
    expect(topicName('t-fc')).toBe('A')
    sqlite.exec(
      `CREATE TRIGGER inject_fieldclock_fail BEFORE INSERT ON sync_field_clock BEGIN SELECT RAISE(ABORT, 'injected-fieldclock-write-fail'); END`
    )
    expect(() => applyTopicUpsert('t-fc', 'op-fc-2', T0 + 10, 'B')).toThrow(/injected-fieldclock-write-fail/)
    // Full rollback: row, entity clock, field clock, applied marker, conflicts.
    expect(topicName('t-fc')).toBe('A')
    expect(entityClock('topic', 't-fc')).toEqual({ timestamp: T0, operationId: 'op-fc-1' })
    expect(fieldClock('topic', 't-fc', 'name')).toEqual({ timestamp: T0, operationId: 'op-fc-1' })
    expect(isApplied('op-fc-2')).toBe(false)
    expect(syncService.getConflictCount()).toBe(0)
  })

  it('field-clock read failure (non-missing-table) rolls back instead of first-write-wins', () => {
    expect(applyTopicUpsert('t-fr', 'op-fr-1', T0, 'A')).toBe(true)
    sqlite.exec('ALTER TABLE sync_field_clock DROP COLUMN timestamp')
    expect(() => applyTopicUpsert('t-fresh-after-corrupt', 'op-fr-2', T0 + 10, 'B')).toThrow(/no such column/i)
    expect(topicName('t-fresh-after-corrupt')).toBeUndefined()
    expect(isApplied('op-fr-2')).toBe(false)
    expect(entityClock('topic', 't-fresh-after-corrupt')).toBeNull()
  })

  it('proven pre-migration missing table is still tolerated (first-write wins)', () => {
    // Genuine pre-006 database: migration_state proves 006 never applied.
    sqlite.exec("DELETE FROM migration_state WHERE key = '006_sync_field_merge'")
    sqlite.exec('DROP TABLE sync_field_clock')
    expect(applyTopicUpsert('t-pre006', 'op-pre006-1', T0, 'A')).toBe(true)
    expect(topicName('t-pre006')).toBe('A')
    expect(entityClock('topic', 't-pre006')).toEqual({ timestamp: T0, operationId: 'op-pre006-1' })
    expect(isApplied('op-pre006-1')).toBe(true)
  })

  it('post-006 damage (migration applied, table missing) fails closed instead of first-write-wins', () => {
    sqlite.exec('DROP TABLE sync_field_clock')
    expect(() => applyTopicUpsert('t-post006', 'op-post006-1', T0, 'A')).toThrow(/no such table/i)
    expect(topicName('t-post006')).toBeUndefined()
    expect(isApplied('op-post006-1')).toBe(false)
    expect(entityClock('topic', 't-post006')).toBeNull()
  })
})

describe('finding 3: conflict-log fail-closed', () => {
  it('conflict persistence failure rolls back the incoming apply with nothing advanced', () => {
    expect(applyTopicUpsert('t-cf', 'op-cf-1', T0, 'A')).toBe(true)
    sqlite.exec(
      `CREATE TRIGGER inject_conflict_fail BEFORE INSERT ON sync_conflict_log BEGIN SELECT RAISE(ABORT, 'injected-conflict-fail'); END`
    )
    // Newer same-field value would win and must record the loser — injection aborts it.
    expect(() => applyTopicUpsert('t-cf', 'op-cf-2', T0 + 10, 'B')).toThrow(/injected-conflict-fail/)
    expect(topicName('t-cf')).toBe('A')
    expect(entityClock('topic', 't-cf')).toEqual({ timestamp: T0, operationId: 'op-cf-1' })
    expect(fieldClock('topic', 't-cf', 'name')).toEqual({ timestamp: T0, operationId: 'op-cf-1' })
    expect(isApplied('op-cf-2')).toBe(false)
    expect(syncService.getConflictCount()).toBe(0)
  })

  it('conflict eviction failure rolls back at the bound instead of silently dropping', () => {
    const now = new Date().toISOString()
    for (let i = 0; i < 100; i++) {
      db.insert(schema.syncConflictLog)
        .values({
          id: `seed-conflict-${i}`,
          entityType: 'topic',
          entityId: 't-evict',
          field: 'name',
          loserValueJson: JSON.stringify(`L${i}`),
          loserTimestamp: T0,
          loserOperationId: 'op-evict-seed',
          winnerTimestamp: T0 + 1,
          winnerOperationId: 'op-evict-winner',
          createdAt: now
        })
        .run()
    }
    expect(syncService.getConflictCount()).toBe(100)
    expect(applyTopicUpsert('t-evict', 'op-evict-1', T0, 'A')).toBe(true)
    sqlite.exec(
      `CREATE TRIGGER inject_evict_fail BEFORE DELETE ON sync_conflict_log BEGIN SELECT RAISE(ABORT, 'injected-evict-fail'); END`
    )
    // 101st record forces eviction of the oldest — injection aborts the delete.
    expect(() => applyTopicUpsert('t-evict', 'op-evict-2', T0 + 10, 'B')).toThrow(/injected-evict-fail/)
    expect(topicName('t-evict')).toBe('A')
    expect(isApplied('op-evict-2')).toBe(false)
    expect(syncService.getConflictCount()).toBe(100)
  })

  it('sync cycle holds cursor and records a durable error preserving the original failure', async () => {
    configStore.set('sync:token', '')
    configStore.set('sync:deviceCode', 'ABCD2345')
    configStore.set('sync:deviceAuth', 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90')
    expect(applyTopicUpsert('t-cycle', 'op-cycle-1', T0, 'A')).toBe(true)
    db.insert(schema.syncState)
      .values({ key: 'cursor', value: '0' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: '0' } })
      .run()
    sqlite.exec(
      `CREATE TRIGGER inject_cycle_conflict_fail BEFORE INSERT ON sync_conflict_log BEGIN SELECT RAISE(ABORT, 'injected-cycle-conflict-fail'); END`
    )
    const { syncClient } = await import('../SyncClient')
    vi.spyOn(syncClient, 'push').mockImplementation(async () => ({ acceptedIds: [], cursor: 0 }) as never)
    vi.spyOn(syncClient, 'pull').mockImplementation(async () => {
      return {
        operations: [
          {
            seq: 1,
            id: 'op-cycle-2',
            entityType: 'topic',
            op: 'upsert',
            entityId: 't-cycle',
            timestamp: T0 + 10,
            deviceId: 'remote-device',
            payload: { id: 't-cycle', name: 'B' }
          }
        ],
        cursor: 1
      } as never
    })
    await expect(syncService.sync()).rejects.toThrow(/injected-cycle-conflict-fail/)
    // Cursor held, durable error preserves the original failure, winner not committed.
    expect(stateValue('cursor')).toBe('0')
    const lastError = stateValue('lastError') ?? ''
    expect(lastError).toContain('apply failed')
    expect(lastError).toContain('injected-cycle-conflict-fail')
    expect(topicName('t-cycle')).toBe('A')
    expect(isApplied('op-cycle-2')).toBe(false)
    expect(syncService.getConflictCount()).toBe(0)
  })
})
