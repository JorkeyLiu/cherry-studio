/**
 * Cross-topic history reference is a first-class sync entity: creating a
 * reference captures the target topic + its one coherent relation tuple in the
 * SAME transaction, the target's own suffix/branches capture like an ordinary
 * topic (no local-only suppression), and the referenced prefix is never copied.
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

function outboxRows(): Array<{ entityId: string; entityType: string; op: string; payloadJson: string | null }> {
  return db
    .select({
      entityId: schema.syncOutbox.entityId,
      entityType: schema.syncOutbox.entityType,
      op: schema.syncOutbox.op,
      payloadJson: schema.syncOutbox.payloadJson
    })
    .from(schema.syncOutbox)
    .all()
}

describe('cross-topic history reference sync capture', () => {
  it('captures the target topic + coherent relation on creation and the own suffix afterwards', () => {
    const source = 't-ref-sync-src'
    agg.appendMessage(source, msgJson('m-s0', source) as never, [blockJson('b-s0', 'm-s0') as never])
    agg.appendMessage(source, msgJson('m-s1', source) as never, [blockJson('b-s1', 'm-s1') as never])

    const created = agg.createReferencedTopic(source, null, 't-ref-sync-dst', 'm-s1', 'assistant-1')
    expect(created.ok).toBe(true)

    const afterCreate = outboxRows()
    // Target topic captured (ordinary entity).
    expect(afterCreate.some((r) => r.entityType === 'topic' && r.entityId === 't-ref-sync-dst')).toBe(true)
    // The relation itself captured as ONE coherent tuple keyed by target.
    const refOps = afterCreate.filter((r) => r.entityType === 'topic_reference')
    expect(refOps).toHaveLength(1)
    expect(refOps[0].entityId).toBe('t-ref-sync-dst')
    expect(JSON.parse(refOps[0].payloadJson as string)).toEqual({
      targetTopicId: 't-ref-sync-dst',
      sourceTopicId: source,
      sourceBranchId: null,
      anchorMessageId: 'm-s1'
    })
    // The referenced prefix is never copied: no source message/block rows are
    // duplicated onto the target (`topic_id` of the prefix stays the source).
    const targetMessages = sqlite.prepare('SELECT id FROM messages WHERE topic_id = ?').all('t-ref-sync-dst') as Array<{
      id: string
    }>
    expect(targetMessages).toHaveLength(0)

    // Append to the reference target (own suffix): captured normally now.
    agg.appendMessage('t-ref-sync-dst', msgJson('m-d0', 't-ref-sync-dst') as never, [
      blockJson('b-d0', 'm-d0') as never
    ])
    const afterTarget = outboxRows()
    expect(afterTarget.some((r) => r.entityId === 'm-d0' && r.entityType === 'message')).toBe(true)
    expect(afterTarget.some((r) => r.entityId === 'b-d0' && r.entityType === 'message_block')).toBe(true)
    // An ordinary topic still captures (no suppression regression).
    agg.appendMessage('t-ordinary', msgJson('m-o0', 't-ordinary') as never, [blockJson('b-o0', 'm-o0') as never])
    const afterOrdinary = outboxRows()
    expect(afterOrdinary.some((r) => r.entityId === 't-ordinary')).toBe(true)
    expect(afterOrdinary.some((r) => r.entityId === 'm-o0')).toBe(true)
  })

  it('captures a target-delete relation tombstone coherently with the topic delete', () => {
    const source = 't-ref-del-src'
    agg.appendMessage(source, msgJson('m-del-0', source) as never, [blockJson('b-del-0', 'm-del-0') as never])
    const created = agg.createReferencedTopic(source, null, 't-ref-del-dst', 'm-del-0')
    expect(created.ok).toBe(true)

    const deleted = agg.hardDeleteTopic('t-ref-del-dst')
    expect(deleted.ok).toBe(true)

    const rows = outboxRows()
    expect(rows.some((r) => r.entityType === 'topic' && r.entityId === 't-ref-del-dst' && r.op === 'delete')).toBe(true)
    expect(
      rows.some((r) => r.entityType === 'topic_reference' && r.entityId === 't-ref-del-dst' && r.op === 'delete')
    ).toBe(true)
    // Relation row cascaded with the target (no orphan relation).
    const relRow = sqlite
      .prepare('SELECT target_topic_id FROM topic_references WHERE target_topic_id = ?')
      .get('t-ref-del-dst')
    expect(relRow).toBeUndefined()
  })

  it('keeps the target and relation when the SOURCE topic is deleted (dangling reference semantics)', () => {
    const source = 't-ref-src-del'
    agg.appendMessage(source, msgJson('m-sd-0', source) as never, [blockJson('b-sd-0', 'm-sd-0') as never])
    const created = agg.createReferencedTopic(source, null, 't-ref-src-del-dst', 'm-sd-0')
    expect(created.ok).toBe(true)

    const deleted = agg.hardDeleteTopic(source)
    expect(deleted.ok).toBe(true)

    const relRow = sqlite
      .prepare('SELECT source_topic_id FROM topic_references WHERE target_topic_id = ?')
      .get('t-ref-src-del-dst') as { source_topic_id: string } | undefined
    expect(relRow?.source_topic_id).toBe(source)
    const target = sqlite.prepare('SELECT id FROM topics WHERE id = ?').get('t-ref-src-del-dst')
    expect(target).toBeDefined()
    // No relation tombstone for the surviving target.
    const tomb = sqlite
      .prepare('SELECT key FROM sync_state WHERE key = ?')
      .get('tombstone:topic_reference:t-ref-src-del-dst')
    expect(tomb).toBeUndefined()
  })
})
