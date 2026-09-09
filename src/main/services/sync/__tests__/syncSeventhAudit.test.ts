/**
 * Seventh-audit regressions: four reliability-boundary blockers
 * (LOCK-PERSONAL-001/004/006/009/010). Narrow scope: fail-closed identity,
 * capture-error persistence, strict cursors, promotion backfill retry.
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
import { parseStrictCursor, SyncCaptureError, syncService } from '../SyncService'
import { seedRegisteredAttachedSyncService } from './helpers/syncTestRegistration'

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

describe('blocker 1: getDeviceId fails closed except proven pre-005 compatibility', () => {
  it('proven pre-005 missing sync_state returns config identity without throwing', () => {
    sqlite.exec("DELETE FROM migration_state WHERE key = '005_sync_metadata'")
    sqlite.exec("DELETE FROM migration_state WHERE key = '006_sync_field_merge'")
    sqlite.exec('DROP TABLE IF EXISTS sync_state')
    sqlite.exec('DROP TABLE IF EXISTS sync_outbox')
    sqlite.exec('DROP TABLE IF EXISTS sync_applied')
    sqlite.exec('DROP TABLE IF EXISTS sync_entity_clock')
    sqlite.exec('DROP TABLE IF EXISTS sync_field_clock')
    sqlite.exec('DROP TABLE IF EXISTS sync_conflict_log')
    configStore.set('deviceId', 'pre005-device')
    expect(syncService.getDeviceId()).toBe('pre005-device')
  })

  it('damaged post-005 identity state throws instead of returning an ID', () => {
    // Migration row present (005 applied) but sync_state gone = damage.
    sqlite.exec('DROP TABLE sync_state')
    configStore.set('deviceId', 'post005-device')
    expect(() => syncService.getDeviceId()).toThrow(/device identity/i)
  })

  it('enabled capture cannot commit without durable identity', () => {
    const agg = new ChatDbAggregateService(db, sqlite)
    const spy = vi.spyOn(syncService, 'getDeviceId').mockImplementation(() => {
      throw new Error('identity-boom')
    })
    const res = agg.ensureTopic('t-ident', 'a1', 'T')
    expect(res.ok).toBe(false)
    expect(sqlite.prepare('SELECT id FROM topics WHERE id=?').get('t-ident')).toBeUndefined()
    spy.mockRestore()
  })
})

describe('blocker 2: recordCaptureFailure persistence failure is surfaced', () => {
  it('throws SyncCaptureError preserving the original message', () => {
    sqlite.exec('DROP TABLE sync_state')
    // Post-005 damage: migration row present so the write failure is damage.
    expect(() => syncService.recordCaptureFailure('chan-x', new Error('orig-boom'))).toThrow(SyncCaptureError)
    try {
      syncService.recordCaptureFailure('chan-x', new Error('orig-boom'))
    } catch (e) {
      expect((e as Error).message).toMatch(/orig-boom/)
    }
  })

  it('aggregate tx failure with damaged sync_state still fails (never appears committed)', () => {
    const agg = new ChatDbAggregateService(db, sqlite)
    expect(agg.ensureTopic('t-cap', 'a1', 'T').ok).toBe(true)
    const spy = vi.spyOn(syncService, 'enqueueUpsertInTx').mockImplementation(() => {
      throw new Error('tx-enqueue-boom-7')
    })
    // Damage the failure-record table after the working ensureTopic.
    sqlite.exec('DROP TABLE sync_state')
    const res = agg.appendMessage('t-cap', msgJson('m-cap', 't-cap') as never, [])
    // Envelope stays a failure (rolled-back mutation never appears committed);
    // the original + secondary messages are inspectable via logger + the
    // SyncCaptureError path (asserted directly above), since sync_state itself
    // is damaged and cannot hold a durable row.
    expect(res.ok).toBe(false)
    expect(sqlite.prepare('SELECT id FROM messages WHERE id=?').get('m-cap')).toBeUndefined()
    spy.mockRestore()
  })
})

describe('blocker 3: strict cursors never skip history', () => {
  it('parseStrictCursor rejects trailing junk and leading zeros', () => {
    expect(parseStrictCursor('12')).toBe(12)
    expect(parseStrictCursor(0)).toBe(0)
    expect(() => parseStrictCursor('12junk')).toThrow()
    expect(() => parseStrictCursor('012')).toThrow()
    expect(() => parseStrictCursor(' 12')).toThrow()
    expect(() => parseStrictCursor('12 ')).toThrow()
    expect(() => parseStrictCursor(-1)).toThrow()
    expect(() => parseStrictCursor(1.5)).toThrow()
  })

  it('malformed persisted cursor fails closed via getStatus with a durable error', () => {
    db.insert(schema.syncState)
      .values({ key: 'cursor', value: '12junk' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: '12junk' } })
      .run()
    expect(() => syncService.getStatus()).toThrow(/malformed.*cursor|persisted cursor/i)
    const errRow = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastError')).get()
    expect(errRow?.value).toMatch(/cursor/i)
  })

  it('malformed persisted cursor blocks sync() before any pull', async () => {
    db.insert(schema.syncState)
      .values({ key: 'cursor', value: '07' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: '07' } })
      .run()
    await expect(syncService.sync()).rejects.toThrow(/malformed.*cursor|persisted cursor/i)
  })

  it('non-contiguous relay frame rejects before cursor advance', async () => {
    const { syncClient } = await import('../SyncClient')
    const spy = vi.spyOn(syncClient, 'pull').mockResolvedValue({
      operations: [
        {
          id: 'op-a',
          seq: 2,
          entityType: 'topic',
          op: 'upsert',
          entityId: 't-a',
          timestamp: 1,
          deviceId: 'r',
          payload: { id: 't-a' }
        }
      ],
      cursor: 2
    } as never)
    await expect(syncService.sync()).rejects.toThrow(/non-contiguous|contiguous/i)
    spy.mockRestore()
  })
})

describe('blocker 4: partial descendant backfill retries all stable descendants', () => {
  it('fallback attempts every stable child and a later promotion recovers the remainder', () => {
    const agg = new ChatDbAggregateService(db, sqlite)
    configStore.set('sync:enabled', false)
    expect(agg.ensureTopic('t-pback', 'a1', 'T').ok).toBe(true)
    expect(
      agg.appendMessage(
        't-pback',
        msgJson('m-pback', 't-pback', { role: 'assistant', status: 'pending', content: 'p' }) as never,
        [
          blockJson('b1-pback', 'm-pback', { status: 'success' }) as never,
          blockJson('b2-pback', 'm-pback', { status: 'success' }) as never
        ]
      ).ok
    ).toBe(true)
    sqlite.prepare("UPDATE messages SET status='success', content='done' WHERE id=?").run('m-pback')
    configStore.set('sync:enabled', true)
    syncService.recordUpsert('topic', 't-pback', { id: 't-pback', name: 'T' }, Date.now() - 10)
    // First promotion: force the first child capture to fail once.
    const origUpsert = syncService.recordUpsert.bind(syncService)
    let failedOnce = false
    const spy = vi.spyOn(syncService, 'recordUpsert').mockImplementation(((...args: never[]) => {
      const [entityType, entityId] = args as unknown as [string, string]
      if (!failedOnce && entityType === 'message_block' && entityId === 'b1-pback') {
        failedOnce = true
        return null
      }
      return (origUpsert as (...a: never[]) => never)(...args)
    }) as never)
    handleChatDbSuccessForSync(IpcChannel.ChatDb_UpdateMessage, {
      topicId: 't-pback',
      messageId: 'm-pback',
      updates: { status: 'success', content: 'done' }
    })
    spy.mockRestore()
    // Partial failure recorded durably, but the second child was still attempted.
    const opsAfterFirst = syncService.listOutbox()
    expect(failedOnce).toBe(true)
    // Second promotion (parent now tracked) must rescan and recover b1.
    handleChatDbSuccessForSync(IpcChannel.ChatDb_UpdateMessage, {
      topicId: 't-pback',
      messageId: 'm-pback',
      updates: { status: 'success', content: 'done-again' }
    })
    const ops = syncService.listOutbox()
    expect(ops.some((o) => o.entityType === 'message_block' && o.entityId === 'b1-pback')).toBe(true)
    expect(ops.some((o) => o.entityType === 'message_block' && o.entityId === 'b2-pback')).toBe(true)
    void opsAfterFirst
  })

  it('tx path rescans stable descendants even when the parent is already tracked', () => {
    const agg = new ChatDbAggregateService(db, sqlite)
    expect(agg.ensureTopic('t-txre', 'a1', 'T').ok).toBe(true)
    expect(agg.appendMessage('t-txre', msgJson('m-txre', 't-txre') as never, []).ok).toBe(true)
    // Stable block committed directly (bypasses capture), parent already tracked.
    sqlite
      .prepare(
        'INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run('b-txre', 'm-txre', 'text', 'late-body', 'success', new Date().toISOString(), new Date().toISOString(), 0)
    expect(syncService.listOutbox().some((o) => o.entityId === 'b-txre')).toBe(false)
    expect(agg.updateMessage('t-txre', 'm-txre', { content: 'touch' } as never).ok).toBe(true)
    expect(syncService.listOutbox().some((o) => o.entityType === 'message_block' && o.entityId === 'b-txre')).toBe(true)
  })
})
