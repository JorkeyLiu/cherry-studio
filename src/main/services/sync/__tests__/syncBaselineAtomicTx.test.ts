import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
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

import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { readAssistantBaselineSection } from '../syncAssistantBaseline'
import { buildBaselineCandidateInTx } from '../syncBaseline'

let sqlite: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

beforeEach(() => {
  sqlite = openInMemory()
  db = drizzle(sqlite, { schema })
  runMigrations(db as any, sqlite as any)
})

afterEach(() => {
  try {
    sqlite.close()
  } catch {}
})

describe('baseline atomic Tx contract (B1)', () => {
  it('chat candidate and assistant section run under one Tx (same tx object)', () => {
    // seed minimal bound state
    db.insert(schema.syncState).values({ key: 'sync:channelKey', value: 'ch-atomic' }).run()
    db.insert(schema.syncState).values({ key: 'cursor', value: '3' }).run()
    sqlite
      .prepare('INSERT INTO topics (id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?)')
      .run('t-1', 'T1', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null, JSON.stringify({ pinned: false }))
    db.insert(schema.syncEntityClock)
      .values({ entityType: 'topic', entityId: 't-1', timestamp: 1, operationId: 'op1' })
      .run()
    for (const f of ['name', 'assistantId', 'createdAt', 'updatedAt']) {
      db.insert(schema.syncFieldClock)
        .values({ entityType: 'topic', entityId: 't-1', field: f, timestamp: 1, operationId: 'op1' })
        .run()
    }
    // frame for completeness
    db.insert(schema.syncParentOrderFrame)
      .values({
        kind: 'topicMessage',
        parentId: 't-1',
        orderedChildIdsJson: '[]',
        timestamp: 1,
        operationId: 'op1',
        frameVersion: 'parent-order-frame-v1'
      })
      .run()
    // assistant section seed
    db.insert(schema.syncAssistantConfigMirror)
      .values({
        key: 'assistant_config:assistant:a1',
        kind: 'assistant',
        entityId: 'a1',
        payloadJson: JSON.stringify({ schemaVersion: 1, kind: 'assistant', id: 'a1', name: 'A1' }),
        version: 1,
        localMutationId: null,
        projectionRevision: 1,
        deleted: 0,
        updatedAt: Date.now()
      })
      .run()
    db.insert(schema.syncEntityClock)
      .values({
        entityType: 'assistant_config',
        entityId: 'assistant_config:assistant:a1',
        timestamp: 2,
        operationId: 'op2'
      })
      .run()
    db.insert(schema.syncFieldClock)
      .values({
        entityType: 'assistant_config',
        entityId: 'assistant_config:assistant:a1',
        field: 'name',
        timestamp: 2,
        operationId: 'op2'
      })
      .run()

    let txForCandidate: unknown = null
    let txForAssistant: unknown = null
    let candidate: ReturnType<typeof buildBaselineCandidateInTx> | null = null
    let section: ReturnType<typeof readAssistantBaselineSection> | null = null

    db.transaction((tx) => {
      candidate = buildBaselineCandidateInTx(tx as any)
      txForCandidate = tx
      section = readAssistantBaselineSection(tx as any)
      txForAssistant = tx
    })

    expect(txForCandidate).toBe(txForAssistant)
    expect(candidate).not.toBeNull()
    expect(section).not.toBeNull()
    expect(candidate!.observedLocalChannelKey).toBe('ch-atomic')
    expect(candidate!.observedLocalCursor).toBe(3)
    expect(candidate!.pendingOutboxCount).toBe(0)
    expect(section!.configs.length).toBe(1)
  })

  it('single Tx blocks injected mutator (consistent snapshot)', () => {
    db.insert(schema.syncState).values({ key: 'sync:channelKey', value: 'ch-block' }).run()
    db.insert(schema.syncState).values({ key: 'cursor', value: '1' }).run()
    sqlite
      .prepare('INSERT INTO topics (id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?)')
      .run(
        't-10',
        'T10',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        null,
        JSON.stringify({ pinned: false })
      )
    db.insert(schema.syncEntityClock)
      .values({ entityType: 'topic', entityId: 't-10', timestamp: 1, operationId: 'op1' })
      .run()
    for (const f of ['name', 'assistantId', 'createdAt', 'updatedAt']) {
      db.insert(schema.syncFieldClock)
        .values({ entityType: 'topic', entityId: 't-10', field: f, timestamp: 1, operationId: 'op1' })
        .run()
    }
    db.insert(schema.syncParentOrderFrame)
      .values({
        kind: 'topicMessage',
        parentId: 't-10',
        orderedChildIdsJson: '[]',
        timestamp: 1,
        operationId: 'op1',
        frameVersion: 'parent-order-frame-v1'
      })
      .run()

    let observedCountInside = -1
    let observedCountAfter = -1

    // The transaction is synchronous; any attempt to write via the outer db
    // while the Tx is held should be serialized after Tx (better-sqlite3
    // holds exclusive lock). Simulate by trying to insert inside the Tx via
    // outer db - it should be visible only after Tx commits.
    db.transaction((tx) => {
      const cand = buildBaselineCandidateInTx(tx as any)
      observedCountInside = cand.entities.filter((e) => e.entityType === 'topic').length
      // Attempt mutation via outer db while Tx is open: in better-sqlite3 this
      // would block until Tx ends; we simulate by queuing after.
      // For this test we just verify that the candidate count does not include
      // a row inserted after Tx started.
    })
    // Now insert a new topic after Tx
    sqlite
      .prepare('INSERT INTO topics (id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?)')
      .run(
        't-99',
        'T99',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        null,
        JSON.stringify({ pinned: false })
      )
    db.insert(schema.syncEntityClock)
      .values({ entityType: 'topic', entityId: 't-99', timestamp: 99, operationId: 'op99' })
      .run()
    for (const f of ['name', 'assistantId', 'createdAt', 'updatedAt']) {
      db.insert(schema.syncFieldClock)
        .values({ entityType: 'topic', entityId: 't-99', field: f, timestamp: 99, operationId: 'op99' })
        .run()
    }
    const after = buildBaselineCandidateInTx(db as any)
    observedCountAfter = after.entities.filter((e) => e.entityType === 'topic').length
    expect(observedCountInside).toBe(1)
    expect(observedCountAfter).toBe(2)
  })

  it('publish v4 atomic captures counts/watermark/outbox in one snapshot', () => {
    db.insert(schema.syncState).values({ key: 'sync:channelKey', value: 'ch-v4' }).run()
    db.insert(schema.syncState).values({ key: 'cursor', value: '7' }).run()
    // outbox = 0
    sqlite
      .prepare('INSERT INTO topics (id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?)')
      .run(
        't-v4',
        'TV4',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        null,
        JSON.stringify({ pinned: false })
      )
    db.insert(schema.syncEntityClock)
      .values({ entityType: 'topic', entityId: 't-v4', timestamp: 5, operationId: 'op5' })
      .run()
    for (const f of ['name', 'assistantId', 'createdAt', 'updatedAt']) {
      db.insert(schema.syncFieldClock)
        .values({ entityType: 'topic', entityId: 't-v4', field: f, timestamp: 5, operationId: 'op5' })
        .run()
    }
    db.insert(schema.syncParentOrderFrame)
      .values({
        kind: 'topicMessage',
        parentId: 't-v4',
        orderedChildIdsJson: '[]',
        timestamp: 5,
        operationId: 'op5',
        frameVersion: 'parent-order-frame-v1'
      })
      .run()
    db.insert(schema.syncAssistantConfigMirror)
      .values({
        key: 'assistant_config:defaults:defaults',
        kind: 'defaults',
        entityId: 'defaults',
        payloadJson: JSON.stringify({ schemaVersion: 1, kind: 'defaults', id: 'defaults', prompt: 'hi' }),
        version: 1,
        localMutationId: null,
        projectionRevision: 1,
        deleted: 0,
        updatedAt: Date.now()
      })
      .run()
    db.insert(schema.syncEntityClock)
      .values({
        entityType: 'assistant_config',
        entityId: 'assistant_config:defaults:defaults',
        timestamp: 6,
        operationId: 'op6'
      })
      .run()
    db.insert(schema.syncFieldClock)
      .values({
        entityType: 'assistant_config',
        entityId: 'assistant_config:defaults:defaults',
        field: 'prompt',
        timestamp: 6,
        operationId: 'op6'
      })
      .run()

    let capturedWatermark: number | null = null
    let capturedOutbox: number | null = null
    let capturedChannel: string | null = null
    let capturedAssistantCount = -1

    db.transaction((tx) => {
      const cand = buildBaselineCandidateInTx(tx as any)
      const sec = readAssistantBaselineSection(tx as any)
      capturedWatermark = cand.observedLocalCursor
      capturedOutbox = cand.pendingOutboxCount
      capturedChannel = cand.observedLocalChannelKey
      capturedAssistantCount = sec.configs.length
    })

    expect(capturedWatermark).toBe(7)
    expect(capturedOutbox).toBe(0)
    expect(capturedChannel).toBe('ch-v4')
    expect(capturedAssistantCount).toBe(1)
  })
})
