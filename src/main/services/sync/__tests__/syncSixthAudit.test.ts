/**
 * Sixth-audit regressions (LOCK-PERSONAL-001/004/006/009/010):
 * migration-aware missing-table tolerance lives in syncFailClosedRegression
 * finding 2 + syncMigrationProof (same applyIncomingOperation/isTrackedEntity
 * entrypoints, same DROP/DELETE-marker triggers) and is not repeated here.
 * 2. Stable promotion captures exact committed stable descendants
 *    (transient assistant + stable block append, then message promotion).
 * 3. Conflict JSON final serialized form stays within the declared bound and
 *    parseable even for escaping-heavy values.
 * 4. Post-commit fallback DB read failures record durable capture errors
 *    instead of silent no-op skips (and never emit deletes).
 * 5. Conflict-count/status reads fail closed on damaged metadata instead of
 *    fabricating zero/null.
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

const T0 = 1_700_000_000_000

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

function msgJson(id: string, topicId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    topicId,
    role: 'user',
    content: 'hi',
    status: 'success',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra
  } as Record<string, unknown>
}

function blockJson(id: string, messageId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    messageId,
    type: 'text',
    content: 'body',
    status: 'success',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra
  } as Record<string, unknown>
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
  configStore.set('sync:token', '')
  configStore.set('sync:deviceCode', 'ABCD2345')
  configStore.set('sync:deviceAuth', 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90')
  sqlite = openInMemory()
  db = drizzle(sqlite, { schema })
  runMigrations(db as never, sqlite)
  ;(chatDbService as never as { sqlite: unknown }).sqlite = sqlite
  ;(chatDbService as never as { db: unknown }).db = db
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

describe('finding 2: stable promotion captures committed stable descendants', () => {
  it('transient assistant append + stable block, then promotion captures parent before child', () => {
    const agg = new ChatDbAggregateService(db, sqlite)
    expect(agg.ensureTopic('t-prom', 'a1', 'T').ok).toBe(true)
    const stub = agg.appendMessage(
      't-prom',
      msgJson('m-prom', 't-prom', { role: 'assistant', status: 'pending', content: 'partial' }) as any,
      [blockJson('b-prom', 'm-prom', { status: 'success', content: 'stable-body' }) as any]
    )
    expect(stub.ok).toBe(true)
    // Transient skip: neither the parent nor the committed stable block captured yet.
    expect(syncService.listOutbox().some((o) => o.entityId === 'm-prom')).toBe(false)
    expect(syncService.listOutbox().some((o) => o.entityId === 'b-prom')).toBe(false)
    // The stable block row IS committed locally (append upserts before the gate).
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-prom')).toBeTruthy()

    const promoted = agg.updateMessage('t-prom', 'm-prom', { status: 'success', content: 'done' } as any)
    expect(promoted.ok).toBe(true)
    const ops = syncService.listOutbox()
    const msgOp = ops.find((o) => o.entityType === 'message' && o.entityId === 'm-prom')
    const blkOp = ops.find((o) => o.entityType === 'message_block' && o.entityId === 'b-prom')
    expect(msgOp).toBeTruthy()
    expect(blkOp).toBeTruthy()
    // Parent-before-child ordering for relay seq.
    expect(msgOp!.timestamp).toBeLessThanOrEqual(blkOp!.timestamp)
    // No transient rows emitted: every outbox payload status is stable.
    for (const o of ops) {
      const st = o.payload?.status
      if (st !== undefined) expect(['success', 'error', 'paused']).toContain(st)
    }
    // No transient assistant emission for the stub itself: exactly one message op.
    expect(ops.filter((o) => o.entityType === 'message' && o.entityId === 'm-prom')).toHaveLength(1)
  })
})

describe('finding 3: conflict JSON final bound with escaping-heavy values', () => {
  it('escaping-heavy loser stays valid JSON within 2000 chars and bytes', () => {
    const heavy = `${'a"\\b'.repeat(600)}${'中'.repeat(200)}`
    expect(applyTopicUpsert('t-esc', 'op-esc-1', T0, heavy)).toBe(true)
    expect(applyTopicUpsert('t-esc', 'op-esc-2', T0 + 10, 'short-winner')).toBe(true)
    const rows = db.select().from(schema.syncConflictLog).all()
    expect(rows).toHaveLength(1)
    const stored = rows[0].loserValueJson as string
    expect(() => JSON.parse(stored)).not.toThrow()
    expect(stored.length).toBeLessThanOrEqual(2000)
    expect(Buffer.byteLength(stored, 'utf8')).toBeLessThanOrEqual(2000)
    const parsed = JSON.parse(stored) as { truncated?: boolean }
    expect(parsed.truncated).toBe(true)
  })
})

describe('finding 4: fallback DB read failures are durable, never silent skips or deletes', () => {
  it('corrupt messages metadata on UpdateMessage records a durable capture failure', () => {
    const agg = new ChatDbAggregateService(db, sqlite)
    expect(agg.ensureTopic('t-fb', 'a1', 'T').ok).toBe(true)
    expect(agg.appendMessage('t-fb', msgJson('m-fb', 't-fb') as any, []).ok).toBe(true)
    const before = syncService.listOutbox().length
    sqlite.exec('ALTER TABLE messages DROP COLUMN status')
    handleChatDbSuccessForSync(IpcChannel.ChatDb_UpdateMessage, {
      topicId: 't-fb',
      messageId: 'm-fb',
      updates: { content: 'new' }
    })
    expect(syncService.listOutbox().length).toBe(before)
    expect(stateValue('lastCaptureError')).toMatch(/ChatDb_UpdateMessage|no such column/i)
  })

  it('corrupt block metadata on delete never emits a remote delete', () => {
    const agg = new ChatDbAggregateService(db, sqlite)
    expect(agg.ensureTopic('t-fbdel', 'a1', 'T').ok).toBe(true)
    expect(agg.appendMessage('t-fbdel', msgJson('m-fbdel', 't-fbdel') as any, [])).toBeTruthy()
    const before = syncService.listOutbox().length
    sqlite.exec('ALTER TABLE message_blocks DROP COLUMN status')
    handleChatDbSuccessForSync(IpcChannel.ChatDb_DeleteBlocks, { blockIds: ['b-missing'] })
    expect(syncService.listOutbox().length).toBe(before)
    // Either a durable failure (infra read) or a truthful unknown-skip; never a delete op.
    expect(syncService.listOutbox().some((o) => o.op === 'delete')).toBe(false)
  })
})

describe('finding 5: conflict-count/status fail closed on damaged metadata', () => {
  it('damaged conflict log throws instead of fabricating zero; status exposes durable error', () => {
    expect(applyTopicUpsert('t-cc', 'op-cc-1', T0, 'A')).toBe(true)
    sqlite.exec('ALTER TABLE sync_conflict_log DROP COLUMN loser_value_json')
    expect(() => syncService.getConflictCount()).toThrow()
    expect(() => syncService.getStatus()).toThrow()
    expect(stateValue('lastError')).toMatch(/status read failed/i)
  })

  it('proven pre-006 absence still reports truthful zero without throwing', () => {
    sqlite.exec("DELETE FROM migration_state WHERE key = '006_sync_field_merge'")
    sqlite.exec('DROP TABLE sync_conflict_log')
    expect(syncService.getConflictCount()).toBe(0)
    const status = syncService.getStatus()
    expect(status.conflictCount).toBe(0)
  })
})
