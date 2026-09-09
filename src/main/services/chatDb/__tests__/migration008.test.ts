/**
 * Migration 008_sync_channel_reset (SYNC-CC-013): superseded
 * invite/founder/trust pairing state is discarded without migration burden —
 * the local trust mirror is dropped and the pre-channel global cursor is
 * cleared so cursor values are never reused across channels. Local chats,
 * outbox intent, clocks, and conflict records are preserved.
 */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@main/config', () => ({ DATA_PATH: '/tmp' }))

import { MIGRATIONS, runMigrations } from '../migration'

let sqlite: Database.Database

function openDb(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  return s
}

beforeEach(() => {
  sqlite = openDb()
})

afterEach(() => {
  try {
    sqlite.close()
  } catch {}
})

describe('008_sync_channel_reset', () => {
  it('is registered with reset semantics', () => {
    expect(MIGRATIONS[7].key).toBe('008_sync_channel_reset')
    expect(MIGRATIONS[7].sql.join(' ')).toContain('DROP TABLE IF EXISTS sync_trusted_devices')
  })

  it('drops the obsolete trust mirror and clears the pre-channel cursor, preserving business data', () => {
    const db = drizzle(sqlite, {})
    runMigrations(db as never, sqlite)
    // Simulate legacy pairing state on top of the migrated schema.
    sqlite.exec(
      `CREATE TABLE sync_trusted_devices (device_id TEXT PRIMARY KEY, device_name TEXT, trusted_at TEXT, source TEXT)`
    )
    sqlite
      .prepare(`INSERT INTO sync_trusted_devices (device_id, trusted_at, source) VALUES (?, ?, ?)`)
      .run('legacy-device', new Date().toISOString(), 'pairing-accept')
    sqlite.prepare(`INSERT INTO sync_state (key, value) VALUES (?, ?)`).run('cursor', '41')
    sqlite.prepare(`INSERT INTO sync_state (key, value) VALUES (?, ?)`).run('sync:channelKey', 'legacy-channel')
    // Seed business data that must survive: a chat topic, an outbox intent,
    // and an entity clock.
    sqlite
      .prepare(`INSERT INTO topics (id, assistant_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run('t-keep', 'asst-1', 'Keep', '2026-01-01', '2026-01-01')
    sqlite
      .prepare(
        `INSERT INTO sync_outbox (id, entity_type, op, entity_id, timestamp, device_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('op-keep', 'topic', 'upsert', 't-keep', 1000, 'dev-1', JSON.stringify({ id: 't-keep' }), '2026-01-01')
    sqlite
      .prepare(`INSERT INTO sync_entity_clock (entity_type, entity_id, timestamp, operation_id) VALUES (?, ?, ?, ?)`)
      .run('topic', 't-keep', 1000, 'op-keep')

    // Re-run migrations from a state where 008 is pending (simulate upgrade
    // by removing only the 008 marker).
    sqlite.prepare(`DELETE FROM migration_state WHERE key = '008_sync_channel_reset'`).run()
    const applied = runMigrations(db as never, sqlite)
    expect(applied).toBe(1)

    const tables = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
      name: string
    }>
    expect(tables.map((t) => t.name)).not.toContain('sync_trusted_devices')
    const state = sqlite.prepare(`SELECT key, value FROM sync_state`).all() as Array<{
      key: string
      value: string
    }>
    expect(state.some((r) => r.key === 'cursor')).toBe(false)
    expect(state.some((r) => r.key === 'sync:channelKey')).toBe(false)
    // Business data preserved.
    expect((sqlite.prepare(`SELECT COUNT(*) as n FROM topics`).get() as { n: number }).n).toBe(1)
    expect((sqlite.prepare(`SELECT COUNT(*) as n FROM sync_outbox`).get() as { n: number }).n).toBe(1)
    expect((sqlite.prepare(`SELECT COUNT(*) as n FROM sync_entity_clock`).get() as { n: number }).n).toBe(1)
  })
})
