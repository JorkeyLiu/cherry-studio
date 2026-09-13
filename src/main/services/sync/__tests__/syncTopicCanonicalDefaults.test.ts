/**
 * Topic canonical sync defaults: sparse payload materializes
 * pinned=false, prompt=null, isNameManuallyEdited=false; explicit values
 * including null are never overwritten. First ensureTopic capture carries
 * 8 field clocks; legacy 5-clock rows capture as partial/unversioned-field
 * and never project, while full 8-clock rows complete/project. A legacy
 * partial candidate is skip/ineligible at publish eligibility, never throw.
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

import { chatDbService } from '../../chatDb'
import { ChatDbAggregateService } from '../../chatDb/ChatDbAggregateService'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { captureLocalSyncBaselineCandidate } from '../syncBaseline'
import { projectLocalBaselineToWirePayload, SyncBaselineWireProjectionError } from '../syncBaselineWireProjection'
import { syncService } from '../SyncService'
import { seedRegisteredAttachedSyncService } from './helpers/syncTestRegistration'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>
let agg: ChatDbAggregateService

const T = 9_000_000
const TOPIC_CLOCKED_8 = [
  'name',
  'assistantId',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'pinned',
  'prompt',
  'isNameManuallyEdited'
]
const TOPIC_CLOCKED_5 = ['name', 'assistantId', 'createdAt', 'updatedAt', 'deletedAt']

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

function seedEntityClock(type: string, id: string, ts = T, op?: string): void {
  db.insert(schema.syncEntityClock)
    .values({ entityType: type, entityId: id, timestamp: ts, operationId: op ?? `op-${id}` })
    .run()
}

function seedField(type: string, id: string, field: string, ts = T, op?: string): void {
  db.insert(schema.syncFieldClock)
    .values({ entityType: type, entityId: id, field, timestamp: ts, operationId: op ?? `op-${id}` })
    .run()
}

function seedBound(cursor = '7', channel = 'chan-1'): void {
  sqlite.prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)').run('cursor', cursor)
  sqlite.prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)').run('sync:channelKey', channel)
}

function seedFrame(parentId: string, ts = T + 10, op?: string): void {
  sqlite
    .prepare(
      'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run('topicMessage', parentId, 'parent-order-frame-v1', JSON.stringify([]), ts, op ?? `op-frame-${parentId}`)
}

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
  configStore.set('sync:token', '')
  sqlite = openInMemory()
  db = drizzle(sqlite, { schema })
  runMigrations(db as never, sqlite)
  ;(chatDbService as never as { sqlite: unknown }).sqlite = sqlite
  ;(chatDbService as never as { db: unknown }).db = db
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

describe('topic canonical sync defaults', () => {
  it('sparse ensureTopic capture materializes 8-key defaults with 8 field clocks', () => {
    const res = agg.ensureTopic('t-canon', 'assistant-1', 'Canon')
    expect(res.ok).toBe(true)
    const outbox = db.select().from(schema.syncOutbox).all()
    expect(outbox.length).toBeGreaterThan(0)
    const topicOp = outbox.find((o) => o.entityType === 'topic' && o.entityId === 't-canon')
    expect(topicOp).toBeTruthy()
    const payload = JSON.parse(topicOp!.payloadJson as string) as Record<string, unknown>
    // 8 clocked keys + id.
    expect(payload.pinned).toBe(false)
    expect(payload.prompt).toBeNull()
    expect(payload.isNameManuallyEdited).toBe(false)
    for (const k of ['name', 'assistantId', 'createdAt', 'updatedAt', 'deletedAt']) {
      expect(Object.prototype.hasOwnProperty.call(payload, k)).toBe(true)
    }
    const clocks = db
      .select()
      .from(schema.syncFieldClock)
      .all()
      .filter((r) => r.entityType === 'topic' && r.entityId === 't-canon')
    expect(clocks.map((r) => r.field).sort()).toEqual([...TOPIC_CLOCKED_8].sort())
    expect(clocks.length).toBe(8)
  })

  it('explicit values including null are retained in baseline capture', () => {
    sqlite
      .prepare('INSERT INTO topics (id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?)')
      .run(
        't-explicit',
        'Explicit',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        null,
        JSON.stringify({ pinned: true, prompt: null, isNameManuallyEdited: true })
      )
    seedEntityClock('topic', 't-explicit')
    for (const f of TOPIC_CLOCKED_8) seedField('topic', 't-explicit', f)
    seedFrame('t-explicit')
    seedBound()
    const candidate = captureLocalSyncBaselineCandidate(db)
    const payload = candidate.entities.find((e) => e.entityId === 't-explicit')!.payload
    expect(payload.pinned).toBe(true)
    expect(payload.prompt).toBeNull()
    expect(payload.isNameManuallyEdited).toBe(true)
  })

  it('legacy 5-clock row captures 8-key payload as partial/unversioned-field and never projects', () => {
    sqlite
      .prepare('INSERT INTO topics (id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?)')
      .run('t-legacy', 'Legacy', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null, null)
    seedEntityClock('topic', 't-legacy')
    for (const f of TOPIC_CLOCKED_5) seedField('topic', 't-legacy', f)
    seedFrame('t-legacy')
    seedBound()
    const candidate = captureLocalSyncBaselineCandidate(db)
    const entity = candidate.entities.find((e) => e.entityId === 't-legacy')!
    // Payload complemented to 8 clocked keys with canonical defaults.
    expect(entity.payload.pinned).toBe(false)
    expect(entity.payload.prompt).toBeNull()
    expect(entity.payload.isNameManuallyEdited).toBe(false)
    expect(entity.fieldClocks.length).toBe(5)
    expect(candidate.manifest.unversionedFieldCount).toBe(3)
    expect(candidate.completeness.state).toBe('partial')
    expect(candidate.completeness.reasons).toContain('unversioned-field')
    expect(() => projectLocalBaselineToWirePayload(candidate)).toThrow(SyncBaselineWireProjectionError)
  })

  it('full 8-clock row captures complete and projects', () => {
    sqlite
      .prepare('INSERT INTO topics (id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?)')
      .run('t-full', 'Full', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null, null)
    seedEntityClock('topic', 't-full')
    for (const f of TOPIC_CLOCKED_8) seedField('topic', 't-full', f)
    seedFrame('t-full')
    seedBound()
    const candidate = captureLocalSyncBaselineCandidate(db)
    expect(candidate.completeness.state).toBe('complete')
    expect(candidate.manifest.unversionedFieldCount).toBe(0)
    const payload = projectLocalBaselineToWirePayload(candidate)
    const topic = payload.topics.find((t) => t.id === 't-full')!
    expect(topic.pinned).toBe(false)
    expect(topic.prompt).toBeNull()
    expect(topic.isNameManuallyEdited).toBe(false)
  })

  it('legacy partial candidate is skip/ineligible at publish eligibility, never throws', async () => {
    const channel = 'chan-legacy-partial'
    const cursor = 5
    db.insert(schema.syncState)
      .values({ key: 'sync:channelKey', value: channel })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: channel } })
      .run()
    db.insert(schema.syncState)
      .values({ key: 'cursor', value: String(cursor) })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: String(cursor) } })
      .run()
    sqlite
      .prepare('INSERT INTO topics (id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?)')
      .run('t-leg-pub', 'LegPub', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null, null)
    seedEntityClock('topic', 't-leg-pub')
    for (const f of TOPIC_CLOCKED_5) seedField('topic', 't-leg-pub', f)
    seedFrame('t-leg-pub')
    const res = await syncService.publishBaselineIfEligible()
    expect(res.kind).toBe('skipped')
    if (res.kind === 'skipped') {
      expect(res.reason).toBe('candidate-ineligible')
    }
  })
})
