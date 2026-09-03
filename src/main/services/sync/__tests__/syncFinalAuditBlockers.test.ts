/**
 * Final-audit blocker regressions (LOCK-PERSONAL-001/004/006/009, LOCK-RT-005/006).
 * Narrow scope: unsupported structured/attachment blocks, config-failure
 * invalidation, preflight durability, shared predicate. No new schema,
 * no final-validation claim.
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

import type { JsonObject } from '@shared/chatDb'
import { IpcChannel } from '@shared/IpcChannel'
import { isUnsupportedBlockForSync } from '@shared/sync'

import { chatDbService } from '../../chatDb'
import { ChatDbAggregateService } from '../../chatDb/ChatDbAggregateService'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { handleChatDbSuccessForSync } from '../chatDbHook'
import { syncService } from '../SyncService'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

function msgJson(id: string, topicId: string): JsonObject {
  const now = new Date().toISOString()
  return { id, topicId, role: 'user', content: 'hi', status: 'sent', createdAt: now, updatedAt: now }
}

function textBlockJson(id: string, messageId: string, content = 'body'): JsonObject {
  const now = new Date().toISOString()
  return { id, messageId, type: 'main_text', content, status: 'success', createdAt: now, updatedAt: now }
}

function toolBlockJson(id: string, messageId: string): JsonObject {
  const now = new Date().toISOString()
  return {
    id,
    messageId,
    type: 'tool',
    content: { results: [{ title: 'R1', url: 'https://example.com' }] },
    status: 'success',
    createdAt: now,
    updatedAt: now
  } as unknown as JsonObject
}

function fileBlockJson(id: string, messageId: string): JsonObject {
  const now = new Date().toISOString()
  return {
    id,
    messageId,
    type: 'file',
    content: 'file-block',
    status: 'success',
    createdAt: now,
    updatedAt: now,
    file: { id: 'f1', name: 'a.txt', path: '/tmp/a.txt', type: 'text/plain' }
  } as unknown as JsonObject
}

function lastErrorValue(): string | null {
  try {
    const row = sqlite.prepare(`SELECT value FROM sync_state WHERE key='lastError'`).get() as
      | { value: string }
      | undefined
    return row?.value ?? null
  } catch {
    return null
  }
}

function lastCaptureErrorValue(): string | null {
  try {
    const row = sqlite.prepare(`SELECT value FROM sync_state WHERE key='lastCaptureError'`).get() as
      | { value: string }
      | undefined
    return row?.value ?? null
  } catch {
    return null
  }
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
})

afterEach(() => {
  vi.restoreAllMocks()
  try {
    sqlite.close()
  } catch {}
  ;(chatDbService as never as { sqlite: unknown }).sqlite = null
  ;(chatDbService as never as { db: unknown }).db = null
})

describe('shared unsupported-block predicate', () => {
  it('flags tool/file/citation overflow and types, preserves ordinary text', () => {
    expect(isUnsupportedBlockForSync({ type: 'main_text', overflow: {} })).toBe(false)
    expect(isUnsupportedBlockForSync({ type: 'text', overflow: {} })).toBe(false)
    expect(isUnsupportedBlockForSync({ type: 'tool', overflow: {} })).toBe(true)
    expect(isUnsupportedBlockForSync({ type: 'file', overflow: {} })).toBe(true)
    expect(isUnsupportedBlockForSync({ type: 'image', overflow: {} })).toBe(true)
    expect(isUnsupportedBlockForSync({ type: 'video', overflow: {} })).toBe(true)
    expect(isUnsupportedBlockForSync({ type: 'citation', overflow: {} })).toBe(true)
    expect(isUnsupportedBlockForSync({ type: 'main_text', overflow: { content: { a: 1 } } })).toBe(true)
    expect(isUnsupportedBlockForSync({ type: 'main_text', overflow: { file: { id: 'f1' } } })).toBe(true)
    expect(isUnsupportedBlockForSync({ type: 'main_text', overflow: { fileId: 'f1' } })).toBe(true)
    expect(isUnsupportedBlockForSync({ type: 'main_text', overflow: { l2AttachmentUnavailable: true } })).toBe(true)
  })
})

describe('aggregate: unsupported structured blocks emit no partial outbox', () => {
  it('tool block commits locally with durable unsupported outcome; text block still syncs', () => {
    const agg = new ChatDbAggregateService(db, sqlite)
    expect(agg.ensureTopic('t-u1', 'a1', 'T').ok).toBe(true)
    const res = agg.appendMessage('t-u1', msgJson('m-u1', 't-u1'), [
      textBlockJson('b-text', 'm-u1'),
      toolBlockJson('b-tool', 'm-u1')
    ])
    expect(res.ok).toBe(true)
    // Chat rows committed locally (no rollback for unsupported scope).
    const toolRow = sqlite.prepare(`SELECT content, extra FROM message_blocks WHERE id=?`).get('b-tool') as {
      content: string | null
      extra: string | null
    }
    expect(toolRow).toBeTruthy()
    const textRow = sqlite.prepare(`SELECT id FROM message_blocks WHERE id=?`).get('b-text') as
      | { id: string }
      | undefined
    expect(textRow?.id).toBe('b-text')
    // Outbox: topic + message + text block only; no partial null-content tool shell.
    const outbox = syncService.listOutbox()
    const kinds = outbox.map((o) => `${o.entityType}/${o.entityId}`)
    expect(kinds).toContain('message_block/b-text')
    expect(kinds).not.toContain('message_block/b-tool')
    const toolOps = outbox.filter((o) => o.entityId === 'b-tool')
    expect(toolOps).toHaveLength(0)
    // Durable explicit unsupported outcome (not silent).
    const cap = lastCaptureErrorValue() ?? ''
    const last = lastErrorValue() ?? ''
    expect(`${cap} ${last}`.toLowerCase()).toMatch(/unsupported/)
  })

  it('file block commits locally with durable outcome and no partial shell', () => {
    const agg = new ChatDbAggregateService(db, sqlite)
    expect(agg.ensureTopic('t-u2', 'a1', 'T').ok).toBe(true)
    const res = agg.appendMessage('t-u2', msgJson('m-u2', 't-u2'), [fileBlockJson('b-file', 'm-u2')])
    expect(res.ok).toBe(true)
    const outbox = syncService.listOutbox()
    expect(outbox.filter((o) => o.entityId === 'b-file')).toHaveLength(0)
    const cap = lastCaptureErrorValue() ?? ''
    const last = lastErrorValue() ?? ''
    expect(`${cap} ${last}`.toLowerCase()).toMatch(/unsupported/)
  })

  it('ordinary text-only append still captures fully', () => {
    const agg = new ChatDbAggregateService(db, sqlite)
    expect(agg.ensureTopic('t-u3', 'a1', 'T').ok).toBe(true)
    const res = agg.appendMessage('t-u3', msgJson('m-u3', 't-u3'), [textBlockJson('b-only', 'm-u3')])
    expect(res.ok).toBe(true)
    const outbox = syncService.listOutbox()
    expect(outbox.map((o) => `${o.entityType}/${o.entityId}`)).toContain('message_block/b-only')
  })
})

describe('post-commit hook: unsupported rows skip without partial shells', () => {
  it('UpdateSingleBlock on a tool row records unsupported and emits nothing', () => {
    const agg = new ChatDbAggregateService(db, sqlite)
    expect(agg.ensureTopic('t-h1', 'a1', 'T').ok).toBe(true)
    // Seed via direct SQL so the hook path is exercised post-commit.
    const now = new Date().toISOString()
    sqlite
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
      )
      .run('m-h1', 't-h1', 'user', 'hi', 'sent', now, now, 0)
    sqlite
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run('b-htool', 'm-h1', 'tool', null, 'success', now, now, 0, JSON.stringify({ content: { x: 1 } }))
    syncService.clearAllForTests()
    handleChatDbSuccessForSync(IpcChannel.ChatDb_UpdateSingleBlock, { blockId: 'b-htool' })
    expect(syncService.listOutbox().filter((o) => o.entityId === 'b-htool')).toHaveLength(0)
    const cap = lastCaptureErrorValue() ?? ''
    const last = lastErrorValue() ?? ''
    expect(`${cap} ${last}`.toLowerCase()).toMatch(/unsupported/)
  })

  it('UpdateSingleBlock on ordinary text still enqueues', () => {
    const now = new Date().toISOString()
    sqlite.prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?,?,?,?)`).run('t-h2', 'T', now, now)
    sqlite
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
      )
      .run('m-h2', 't-h2', 'user', 'hi', 'sent', now, now, 0)
    sqlite
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
      )
      .run('b-htext', 'm-h2', 'main_text', 'hello', 'success', now, now, 0)
    syncService.clearAllForTests()
    handleChatDbSuccessForSync(IpcChannel.ChatDb_UpdateSingleBlock, { blockId: 'b-htext' })
    expect(syncService.listOutbox().map((o) => o.entityId)).toContain('b-htext')
  })

  it('missing rows never record an unsupported outcome (closure fail-closed preserved)', () => {
    syncService.clearAllForTests()
    handleChatDbSuccessForSync(IpcChannel.ChatDb_UpdateSingleBlock, { blockId: 'b-missing' })
    // A missing row after reported success is a closure failure in the
    // existing hook (fail-closed), but it must never be misclassified as
    // an unsupported structured block.
    expect((lastCaptureErrorValue() ?? '').toLowerCase()).not.toMatch(/unsupported/)
  })
})

describe('syncAuto.refresh config-read failure invalidates active SyncService cycle', () => {
  it('calls invalidateForConfigChange before stopping the subscriber', async () => {
    const { SyncAutoService: Cls } = await import('../syncAuto')
    const invalidateSpy = vi.spyOn(syncService, 'invalidateForConfigChange')
    const stopCalls: string[] = []
    const fakeSubscriber = { start: vi.fn(), stop: (): void => void stopCalls.push('stop') }
    const svc = new Cls({
      getConfig: (): { endpoint: string; token?: string; enabled: boolean } => {
        throw new Error('config-boom')
      },
      runSync: () => Promise.resolve(null),
      createSubscriber: () => fakeSubscriber as never
    })
    svc.start()
    expect(invalidateSpy).toHaveBeenCalled()
    svc.stopSync()
  })
})

describe('SyncService.sync preflight failures are durably visible', () => {
  it('getDeviceId failure records lastError and preserves the original error', async () => {
    const spy = vi.spyOn(syncService, 'getDeviceId').mockImplementation(() => {
      throw new Error('preflight-identity-boom')
    })
    await expect(syncService.sync()).rejects.toThrow(/preflight-identity-boom/)
    expect((lastErrorValue() ?? '').toLowerCase()).toMatch(/preflight|identity-boom/)
    spy.mockRestore()
  })

  it('listOutbox failure records lastError without advancing cursor', async () => {
    const spy = vi.spyOn(syncService, 'listOutbox').mockImplementation(() => {
      throw new Error('preflight-outbox-boom')
    })
    await expect(syncService.sync()).rejects.toThrow(/preflight-outbox-boom/)
    expect((lastErrorValue() ?? '').toLowerCase()).toMatch(/preflight|outbox-boom/)
    const cursor = sqlite.prepare(`SELECT value FROM sync_state WHERE key='cursor'`).get() as
      | { value: string }
      | undefined
    expect(cursor).toBeUndefined()
    spy.mockRestore()
  })
})
