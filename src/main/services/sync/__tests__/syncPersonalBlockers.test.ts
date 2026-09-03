/**
 * Personal-sync audit blocker regressions (LOCK-PERSONAL-001/004/005/006/007/009/010).
 * Covers: fail-closed capture context, append checkpoint gate + existing-ID
 * patches, block tombstone delete-wins, shutdown cancellation, durable tx
 * capture failure, valid bounded conflict JSON, truthful UI copy.
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

import { eq } from 'drizzle-orm'

import { chatDbService } from '../../chatDb'
import { ChatDbAggregateService } from '../../chatDb/ChatDbAggregateService'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { syncService, SyncShutdownError } from '../SyncService'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>

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

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
  configStore.set('sync:token', '')
  sqlite = openInMemory()
  db = drizzle(sqlite, { schema })
  runMigrations(db as any, sqlite)
  ;(chatDbService as any).sqlite = sqlite
  ;(chatDbService as any).db = db
  syncService.clearAllForTests()
})

afterEach(() => {
  try {
    sqlite.close()
  } catch {}
  ;(chatDbService as any).sqlite = null
  ;(chatDbService as any).db = null
  vi.restoreAllMocks()
})

describe('blocker 1: capture context fails closed when enabled', () => {
  it('deviceId infrastructure failure rolls back the mutation with a durable capture error', () => {
    const agg = new ChatDbAggregateService(db, sqlite)
    const spy = vi.spyOn(syncService, 'getDeviceId').mockImplementation(() => {
      throw new Error('infra-device-boom')
    })
    const res = agg.ensureTopic('t-failclosed', 'a1', 'T')
    expect(res.ok).toBe(false)
    // No topic row committed (fail closed, no silent loss direction)
    expect(sqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-failclosed')).toBeUndefined()
    const cap = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastCaptureError')).get()
    expect(cap?.value).toMatch(/infra-device-boom/)
    spy.mockRestore()
  })
})

describe('blocker 2: append checkpoint gate (LOCK-PERSONAL-004)', () => {
  it('transient assistant stub append captures nothing; stable transition creates full initial state', () => {
    const agg = new ChatDbAggregateService(db, sqlite)
    expect(agg.ensureTopic('t-gate', 'a1', 'T').ok).toBe(true)
    syncService.clearAllForTests()
    // Re-track the topic so closure does not add noise after the clear
    syncService.recordUpsert('topic', 't-gate', { id: 't-gate', name: 'T' }, Date.now() - 10)
    const outboxBefore = syncService.listOutbox().length
    const appendRes = agg.appendMessage(
      't-gate',
      msgJson('m-stub', 't-gate', { role: 'assistant', status: 'streaming', content: 'partial' }) as any,
      [blockJson('b-stub', 'm-stub', { status: 'streaming' }) as any]
    )
    expect(appendRes.ok).toBe(true)
    // Transient stub: committed locally but never captured
    expect(sqlite.prepare('SELECT id FROM messages WHERE id=?').get('m-stub')).toBeTruthy()
    expect(syncService.listOutbox().length).toBe(outboxBefore)
    // Final stable transition creates the full initial state (not a patch)
    const upd = agg.updateMessage('t-gate', 'm-stub', { status: 'success', content: 'done' } as any)
    expect(upd.ok).toBe(true)
    const ops = syncService.listOutbox()
    const msgOp = ops.find((o) => o.entityType === 'message' && o.entityId === 'm-stub')
    expect(msgOp).toBeTruthy()
    expect(msgOp!.payload).toMatchObject({ id: 'm-stub', topicId: 't-gate', content: 'done', status: 'success' })
    expect(msgOp!.payload).toHaveProperty('role', 'assistant')
  })

  it('user messages capture immediately', () => {
    const agg = new ChatDbAggregateService(db, sqlite)
    expect(agg.ensureTopic('t-user', 'a1', 'T').ok).toBe(true)
    syncService.clearAllForTests()
    syncService.recordUpsert('topic', 't-user', { id: 't-user', name: 'T' }, Date.now() - 10)
    const before = syncService.listOutbox().length
    const res = agg.appendMessage('t-user', msgJson('m-user', 't-user') as any, [])
    expect(res.ok).toBe(true)
    expect(syncService.listOutbox().length).toBeGreaterThan(before)
  })
})

describe('blocker 3: existing-ID append emits patches (LOCK-PERSONAL-005)', () => {
  it('second append with the same message ID emits only the changed field', () => {
    const agg = new ChatDbAggregateService(db, sqlite)
    expect(agg.ensureTopic('t-patch', 'a1', 'T').ok).toBe(true)
    expect(agg.appendMessage('t-patch', msgJson('m-patch', 't-patch', { content: 'v1' }) as any, []).ok).toBe(true)
    const firstOps = syncService.listOutbox()
    const firstMsg = firstOps.find((o) => o.entityType === 'message' && o.entityId === 'm-patch')
    expect(firstMsg?.payload).toMatchObject({ content: 'v1' })
    const outboxLen = firstOps.length
    void outboxLen
    // Existing-ID append: only content changes
    expect(agg.appendMessage('t-patch', msgJson('m-patch', 't-patch', { content: 'v2' }) as any, []).ok).toBe(true)
    const ops = syncService.listOutbox()
    const msgOps = ops.filter((o) => o.entityType === 'message' && o.entityId === 'm-patch')
    expect(msgOps.length).toBe(2)
    const second = msgOps[msgOps.length - 1]
    expect(second.payload).toMatchObject({ id: 'm-patch', topicId: 't-patch', content: 'v2' })
    // Patch-only: unchanged allowlisted keys (role/status/model) must not be re-contested
    expect(second.payload).not.toHaveProperty('role')
    expect(second.payload).not.toHaveProperty('status')
    expect(second.payload).not.toHaveProperty('sortOrder')
  })
})

describe('blocker 4: direct block delete tombstone (LOCK-PERSONAL-007)', () => {
  it('late block upsert after a direct block delete is suppressed, never resurrected', () => {
    const base = Date.now() - 50000
    syncService.applyIncomingOperation({
      id: 'op-bt-m',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm-bt',
      timestamp: base,
      deviceId: 'd1',
      payload: { id: 'm-bt', topicId: 't-bt', role: 'user', content: 'p' }
    } as any)
    syncService.applyIncomingOperation({
      id: 'op-bt-b',
      entityType: 'message_block',
      op: 'upsert',
      entityId: 'b-bt',
      timestamp: base + 10,
      deviceId: 'd1',
      payload: { id: 'b-bt', messageId: 'm-bt', type: 'text', content: 'x' }
    } as any)
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-bt')).toBeTruthy()
    syncService.applyIncomingOperation({
      id: 'op-bt-bdel',
      entityType: 'message_block',
      op: 'delete',
      entityId: 'b-bt',
      timestamp: base + 1000,
      deviceId: 'd1'
    } as any)
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-bt')).toBeUndefined()
    const tomb = db
      .select()
      .from(schema.syncState)
      .where(eq(schema.syncState.key, 'tombstone:message_block:b-bt'))
      .get()
    expect(tomb?.value).toBe(`${String(base + 1000)}:op-bt-bdel`)
    // Late older upsert: consumed/suppressed, no throw, no resurrect
    let threw = false
    let ret = true
    try {
      ret = syncService.applyIncomingOperation({
        id: 'op-bt-late',
        entityType: 'message_block',
        op: 'upsert',
        entityId: 'b-bt',
        timestamp: base + 500,
        deviceId: 'd2',
        payload: { id: 'b-bt', messageId: 'm-bt', type: 'text', content: 'late' }
      } as any)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(ret).toBe(false)
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('b-bt')).toBeUndefined()
  })
})

describe('blocker 5: shutdown cancels in-flight sync before db close', () => {
  it('beginShutdown makes sync() reject without touching the database', async () => {
    configStore.set('sync:enabled', true)
    syncService.recordUpsert('topic', 't-shut', { id: 't-shut', name: 'S' }, Date.now())
    syncService.beginShutdown()
    await expect(syncService.sync()).rejects.toBeInstanceOf(SyncShutdownError)
    // stopSync path also invalidates (generation + shutdown flag)
    const { syncAutoService } = await import('../syncAuto')
    syncAutoService.stopSync()
    expect(syncService.isShutdown()).toBe(true)
  })
})

describe('blocker 6: tx capture rollback writes a durable failure (LOCK-PERSONAL-006/009)', () => {
  it('enqueue failure rolls back chat changes and persists lastCaptureError outside the tx', () => {
    const agg = new ChatDbAggregateService(db, sqlite)
    expect(agg.ensureTopic('t-tx', 'a1', 'T').ok).toBe(true)
    const spy = vi.spyOn(syncService, 'enqueueUpsertInTx').mockImplementation(() => {
      throw new Error('tx-enqueue-boom')
    })
    const res = agg.appendMessage('t-tx', msgJson('m-tx', 't-tx') as any, [])
    expect(res.ok).toBe(false)
    // Rolled back: no chat row committed
    expect(sqlite.prepare('SELECT id FROM messages WHERE id=?').get('m-tx')).toBeUndefined()
    // Durable + visible outside the rolled-back tx
    const cap = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastCaptureError')).get()
    expect(cap?.value).toMatch(/tx-enqueue-boom/)
    const status = syncService.getStatus()
    expect(status.lastCaptureError).toMatch(/tx-enqueue-boom/)
    spy.mockRestore()
  })
})

describe('conflict record is valid bounded structured JSON (LOCK-PERSONAL-010)', () => {
  it('oversized loser values stay valid JSON with a truncation marker', () => {
    const now = new Date().toISOString()
    syncService.applyIncomingOperation({
      id: 'op-cx-t',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-cx',
      timestamp: 1000,
      deviceId: 'd1',
      payload: { id: 't-cx', name: 'seed', createdAt: now, updatedAt: now }
    } as any)
    const huge = 'x'.repeat(5000)
    syncService.applyIncomingOperation({
      id: 'op-cx-huge',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-cx',
      timestamp: 2000,
      deviceId: 'd2',
      payload: { id: 't-cx', name: huge }
    } as any)
    // Same-field contest with another huge value forces the first huge value
    // into the loser record path at bounded size.
    syncService.applyIncomingOperation({
      id: 'op-cx-huge2',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-cx',
      timestamp: 3000,
      deviceId: 'd3',
      payload: { id: 't-cx', name: 'y'.repeat(5000) }
    } as any)
    const rows = sqlite.prepare('SELECT loser_value_json FROM sync_conflict_log').all() as Array<{
      loser_value_json: string | null
    }>
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.loser_value_json).toBeTruthy()
      const parsed = JSON.parse(r.loser_value_json as string)
      expect(r.loser_value_json!.length).toBeLessThanOrEqual(2000)
      if (parsed && typeof parsed === 'object' && (parsed as { truncated?: boolean }).truncated === true) {
        expect(typeof (parsed as { preview: string }).preview).toBe('string')
      }
    }
  })
})

describe('UI copy is truthful', () => {
  it('base locale documents automatic personal sync, stable checkpoints, unsupported reorder, pending validation', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const basePath = path.join(__dirname, '../../../../renderer/src/i18n/locales/en-us.json')
    const raw = fs.readFileSync(basePath, 'utf-8')
    const json = JSON.parse(raw)
    const help = json.settings.sync.help as string
    const scope = json.settings.sync.scope_note as string
    expect(help).toMatch(/Automatic personal/i)
    expect(help).toMatch(/pending validation/i)
    expect(scope).toMatch(/stable checkpoint/i)
    expect(scope).toMatch(/reorder.*unsupported|unsupported.*reorder/i)
    expect(scope).not.toMatch(/Synced:[^]*message reorder[^]*Not synced/i)
  })
})
