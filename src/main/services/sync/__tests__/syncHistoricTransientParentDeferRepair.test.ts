/**
 * Narrow historic transient-parent defer repair: only the exact old
 * `updateBlocks: sync closure: parent message <id> transient (pending), defer`
 * string may clear, and only with authoritative closure proof after a
 * successful sync drained the outbox. Genuine/unknown failures are preserved.
 */
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
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
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { checkHistoricParentClosureProof, parseHistoricTransientParentDeferError } from '../syncHistoricCaptureRepair'
import { syncService } from '../SyncService'
import { seedRegisteredAttachedSyncService } from './helpers/syncTestRegistration'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>

const T = 9_000_000
const CHANNEL = 'chan-historic'
const TOPIC = 't-historic'
const PARENT = 'm-historic-parent'
const TEXT_BLOCK = 'b-historic-text'
const IMAGE_BLOCK = 'b-historic-image'
const FILE_ID = 'file-historic-1'

const TOPIC_FIELDS = [
  'name',
  'assistantId',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'pinned',
  'prompt',
  'isNameManuallyEdited'
]
const MESSAGE_FIELDS = [
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
const TEXT_FIELDS = ['type', 'content', 'status', 'createdAt', 'updatedAt']
const IMAGE_FIELDS = ['type', 'content', 'status', 'createdAt', 'updatedAt', 'assetIds']
const FILE_ASSET_FIELDS = ['mimeType', 'originalName', 'createdAt']

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

function seedEntity(entityType: string, entityId: string, ts = T): void {
  db.insert(schema.syncEntityClock)
    .values({ entityType, entityId, timestamp: ts, operationId: `op-${entityId}` })
    .run()
}

function seedFields(entityType: string, entityId: string, fields: readonly string[], ts = T): void {
  for (const field of fields) {
    db.insert(schema.syncFieldClock)
      .values({ entityType, entityId, field, timestamp: ts, operationId: `op-${entityId}` })
      .run()
  }
}

function seedMembership(childType: 'message' | 'message_block', childId: string, parentId: string): void {
  db.insert(schema.syncMembershipClock)
    .values({
      childEntityType: childType,
      childEntityId: childId,
      parentId,
      timestamp: T,
      operationId: `op-${childId}`
    })
    .run()
}

function seedFrame(kind: string, parentId: string, childIds: string[]): void {
  db.insert(schema.syncParentOrderFrame)
    .values({
      kind,
      parentId,
      frameVersion: 'parent-order-frame-v1',
      orderedChildIdsJson: JSON.stringify(childIds),
      timestamp: T + 10,
      operationId: `op-frame-${parentId}`
    })
    .run()
}

function seedState(key: string, value: string): void {
  db.insert(schema.syncState)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.syncState.key, set: { value } })
    .run()
}

function historicError(parentId: string): string {
  return `updateBlocks: sync closure: parent message ${parentId} transient (pending), defer`
}

/** Proven closure: stable parent + text (5 clocks) + image (6 clocks + refs/asset/completed job). */
function seedProvenClosure(): string {
  sqlite
    .prepare('INSERT INTO topics (id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?)')
    .run(TOPIC, 'Historic', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', null, null)
  sqlite
    .prepare(
      'INSERT INTO messages (id, topic_id, branch_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    )
    .run(
      PARENT,
      TOPIC,
      null,
      'assistant',
      'final',
      'success',
      null,
      null,
      null,
      'assistant-1',
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      0,
      null
    )
  sqlite
    .prepare(
      'INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)'
    )
    .run(
      TEXT_BLOCK,
      PARENT,
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
      'INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)'
    )
    .run(IMAGE_BLOCK, PARENT, 'image', null, 'success', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 1, null)
  db.insert(schema.fileReferences)
    .values({ id: `ref-${FILE_ID}`, blockId: IMAGE_BLOCK, fileId: FILE_ID })
    .run()
  db.insert(schema.syncFileAsset)
    .values({
      id: FILE_ID,
      sha256: 'a'.repeat(64),
      byteLength: 12,
      extension: '.png',
      mimeType: 'image/png',
      originalName: 'historic.png',
      createdAt: '2026-01-01T00:00:00.000Z',
      version: 1,
      updatedAt: T
    })
    .run()
  db.insert(schema.syncAttachmentJob)
    .values({
      assetId: FILE_ID,
      sha256: 'a'.repeat(64),
      byteLength: 12,
      channelId: CHANNEL,
      state: 'completed',
      attempts: 0,
      lastError: null,
      createdAt: T,
      updatedAt: T
    })
    .run()
  seedEntity('topic', TOPIC)
  seedFields('topic', TOPIC, TOPIC_FIELDS)
  seedEntity('message', PARENT)
  seedFields('message', PARENT, MESSAGE_FIELDS)
  seedMembership('message', PARENT, TOPIC)
  seedEntity('message_block', TEXT_BLOCK)
  seedFields('message_block', TEXT_BLOCK, TEXT_FIELDS)
  seedMembership('message_block', TEXT_BLOCK, PARENT)
  seedEntity('message_block', IMAGE_BLOCK)
  seedFields('message_block', IMAGE_BLOCK, IMAGE_FIELDS)
  seedMembership('message_block', IMAGE_BLOCK, PARENT)
  seedEntity('file_asset', FILE_ID)
  seedFields('file_asset', FILE_ID, FILE_ASSET_FIELDS)
  seedFrame('messageBlock', PARENT, [TEXT_BLOCK, IMAGE_BLOCK])
  seedFrame('topicMessage', TOPIC, [PARENT])
  seedState('cursor', '48')
  seedState('sync:channelKey', CHANNEL)
  seedState('lastSyncAt', new Date('2026-10-10T00:00:00.000Z').toISOString())
  const err = historicError(PARENT)
  seedState('lastCaptureError', err)
  return err
}

function readCaptureError(): string | null {
  const row = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastCaptureError')).get() as
    | { value: string | null }
    | undefined
  return row?.value ?? null
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
  syncService.clearAllForTests()
  seedRegisteredAttachedSyncService(configStore, db)
})

afterEach(() => {
  vi.restoreAllMocks()
  try {
    sqlite.close()
  } catch {}
  ;(chatDbService as never as { sqlite: unknown }).sqlite = null
  ;(chatDbService as never as { db: unknown }).db = null
})

describe('parseHistoricTransientParentDeferError', () => {
  it('parses only the exact historic updateBlocks pending grammar', () => {
    expect(parseHistoricTransientParentDeferError(historicError(PARENT))).toBe(PARENT)
  })

  it('rejects other channels, statuses, and malformed values', () => {
    expect(parseHistoricTransientParentDeferError(null)).toBeNull()
    expect(parseHistoricTransientParentDeferError('')).toBeNull()
    expect(
      parseHistoricTransientParentDeferError(
        `chatdb:update-blocks: sync closure: parent message ${PARENT} transient (pending), defer`
      )
    ).toBeNull()
    expect(
      parseHistoricTransientParentDeferError(
        `updateBlocks: sync closure: parent message ${PARENT} transient (streaming), defer`
      )
    ).toBeNull()
    expect(
      parseHistoricTransientParentDeferError('updateBlocks: unsupported block(s) not representable for sync, skipped')
    ).toBeNull()
    expect(
      parseHistoricTransientParentDeferError(`updateBlocks: sync closure: parent message  transient (pending), defer`)
    ).toBeNull()
  })
})

describe('historic transient-parent defer repair', () => {
  it('repairs the known historic defer once the closure proves captured and the outbox drained', () => {
    const observed = seedProvenClosure()
    expect(readCaptureError()).toBe(observed)
    expect(checkHistoricParentClosureProof(db as never, PARENT).eligible).toBe(true)
    expect(syncService.maybeRepairHistoricTransientParentDeferCapture()).toBe(true)
    expect(readCaptureError()).toBeNull()
    expect(syncService.getStatus().lastCaptureError).toBeNull()
  })

  it('preserves genuine unsupported failures even with a proven closure', () => {
    seedProvenClosure()
    seedState(
      'lastCaptureError',
      'updateBlocks: unsupported block(s) not representable for sync, skipped without partial payload: b-x'
    )
    expect(syncService.maybeRepairHistoricTransientParentDeferCapture()).toBe(false)
    expect(readCaptureError()).toContain('unsupported block')
  })

  it('preserves the historic string when the parent is still transient', () => {
    const observed = seedProvenClosure()
    sqlite.prepare('UPDATE messages SET status=? WHERE id=?').run('pending', PARENT)
    expect(syncService.maybeRepairHistoricTransientParentDeferCapture()).toBe(false)
    expect(readCaptureError()).toBe(observed)
  })

  it('preserves the historic string when a pending outbox row remains', () => {
    const observed = seedProvenClosure()
    db.insert(schema.syncOutbox)
      .values({
        id: 'op-pending-1',
        entityType: 'message',
        op: 'upsert',
        entityId: PARENT,
        timestamp: T,
        deviceId: 'd1',
        payloadJson: '{}',
        createdAt: new Date().toISOString()
      })
      .run()
    expect(syncService.maybeRepairHistoricTransientParentDeferCapture()).toBe(false)
    expect(readCaptureError()).toBe(observed)
  })

  it('preserves the historic string when the parent is tombstoned', () => {
    const observed = seedProvenClosure()
    seedState('tombstone:message:m-historic-parent', `${T}:op-m-historic-parent`)
    expect(syncService.maybeRepairHistoricTransientParentDeferCapture()).toBe(false)
    expect(readCaptureError()).toBe(observed)
  })

  it('preserves the historic string when the completed media job is on a wrong channel', () => {
    const observed = seedProvenClosure()
    sqlite.prepare('UPDATE sync_attachment_job SET channel_id=? WHERE asset_id=?').run('chan-other', FILE_ID)
    const proof = checkHistoricParentClosureProof(db as never, PARENT)
    expect(proof.eligible).toBe(false)
    expect(proof.reason).toBe('job-pending')
    expect(db.select().from(schema.syncOutbox).all()).toHaveLength(0)
    expect(syncService.maybeRepairHistoricTransientParentDeferCapture()).toBe(false)
    expect(readCaptureError()).toBe(observed)
    expect(db.select().from(schema.syncOutbox).all()).toHaveLength(0)
  })

  it('preserves the historic string when the current channel is unbound with a completed media job', () => {
    const observed = seedProvenClosure()
    sqlite.prepare('DELETE FROM sync_state WHERE key=?').run('sync:channelKey')
    const proof = checkHistoricParentClosureProof(db as never, PARENT)
    expect(proof.eligible).toBe(false)
    expect(proof.reason).toBe('job-pending')
    expect(db.select().from(schema.syncOutbox).all()).toHaveLength(0)
    expect(syncService.maybeRepairHistoricTransientParentDeferCapture()).toBe(false)
    expect(readCaptureError()).toBe(observed)
    expect(db.select().from(schema.syncOutbox).all()).toHaveLength(0)
  })

  it('proves a text-only closure without a bound channel, proving the channel binding is media-only', () => {
    seedProvenClosure()
    sqlite.prepare('DELETE FROM message_blocks WHERE id=?').run(IMAGE_BLOCK)
    sqlite.prepare('DELETE FROM sync_parent_order_frame WHERE kind=? AND parent_id=?').run('messageBlock', PARENT)
    seedFrame('messageBlock', PARENT, [TEXT_BLOCK])
    sqlite.prepare('DELETE FROM sync_state WHERE key=?').run('sync:channelKey')
    const proof = checkHistoricParentClosureProof(db as never, PARENT)
    expect(proof.eligible).toBe(true)
    expect(proof.reason).toBe('eligible')
  })
})
