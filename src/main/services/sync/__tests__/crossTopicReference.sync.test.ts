/**
 * Cross-topic history reference local-only boundary: reference-target topics
 * capture NO sync intent (topic, suffix messages, blocks, frames, membership),
 * while an ordinary main topic still captures normally. The source topic's
 * own sync is untouched.
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
    set: (k: string, v: unknown) => configStore.set(k, v),
    has: (k: string) => configStore.has(k)
  },
  ConfigKeys: {}
}))

import { chatDbService } from '../../chatDb'
import { ChatDbAggregateService } from '../../chatDb/ChatDbAggregateService'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { syncService } from '../SyncService'
import { seedRegisteredAttachedSyncService } from './helpers/syncTestRegistration'

function openChatDb(): { sqlite: Database.Database; db: BetterSQLite3Database<typeof schema> } {
  const sqlite = new Database(':memory:')
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  runMigrations(db as never, sqlite)
  return { sqlite, db }
}
function bindSingleton(sqlite: Database.Database, db: BetterSQLite3Database<typeof schema>): void {
  ;(chatDbService as unknown as { sqlite: unknown }).sqlite = sqlite
  ;(chatDbService as unknown as { db: unknown }).db = db
}
function msgJson(id: string, topicId: string, overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    topicId,
    role: 'user',
    content: `content-${id}`,
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}
function blockJson(id: string, messageId: string): Record<string, unknown> {
  return {
    id,
    messageId,
    type: 'main_text',
    content: `content-${id}`,
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>
let agg: ChatDbAggregateService

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
  configStore.set('sync:token', '')
  const opened = openChatDb()
  sqlite = opened.sqlite
  db = opened.db
  bindSingleton(sqlite, db)
  syncService.clearAllForTests()
  seedRegisteredAttachedSyncService(configStore, db)
  agg = new ChatDbAggregateService(db, sqlite)
})

afterEach(() => {
  vi.restoreAllMocks()
  try {
    sqlite.close()
  } catch {}
  ;(chatDbService as never as { sqlite: unknown }).sqlite = null
  ;(chatDbService as never as { db: unknown }).db = null
})

function outboxEntityIds(): { entityId: string; entityType: string }[] {
  return db
    .select({ entityId: schema.syncOutbox.entityId, entityType: schema.syncOutbox.entityType })
    .from(schema.syncOutbox)
    .all()
}

describe('cross-topic reference local-only sync boundary', () => {
  it('captures no sync intent for the reference target, but captures for an ordinary topic', () => {
    // Seed a source topic (this captures normally).
    const source = 't-ref-sync-src'
    agg.appendMessage(source, msgJson('m-s0', source) as never, [blockJson('b-s0', 'm-s0') as never])
    agg.appendMessage(source, msgJson('m-s1', source) as never, [blockJson('b-s1', 'm-s1') as never])

    // Reference creation must capture nothing.
    const created = agg.createReferencedTopic(source, null, 't-ref-sync-dst', 'm-s1', 'assistant-1')
    expect(created.ok).toBe(true)
    expect(outboxEntityIds().some((r) => r.entityId === 't-ref-sync-dst')).toBe(false)

    // Append to the reference target (own suffix): must capture nothing.
    agg.appendMessage('t-ref-sync-dst', msgJson('m-d0', 't-ref-sync-dst') as never, [
      blockJson('b-d0', 'm-d0') as never
    ])
    const afterTarget = outboxEntityIds()
    expect(afterTarget.some((r) => r.entityId === 't-ref-sync-dst')).toBe(false)
    expect(afterTarget.some((r) => r.entityId === 'm-d0')).toBe(false)
    expect(afterTarget.some((r) => r.entityId === 'b-d0')).toBe(false)

    // An ordinary topic still captures (no suppression regression).
    agg.appendMessage('t-ordinary', msgJson('m-o0', 't-ordinary') as never, [blockJson('b-o0', 'm-o0') as never])
    const afterOrdinary = outboxEntityIds()
    expect(afterOrdinary.some((r) => r.entityId === 't-ordinary')).toBe(true)
    expect(afterOrdinary.some((r) => r.entityId === 'm-o0')).toBe(true)
  })
})
