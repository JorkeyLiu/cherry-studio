/**
 * Personal multi-device integrity: parent closure for compound-created
 * parents + syncable topic metadata (pinned/prompt/isNameManuallyEdited).
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
import { validateSyncOperationStrict, validateSyncPayloadAllowlist } from '@shared/sync'

import { chatDbService } from '../../chatDb'
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

function seedCompoundCreatedParent(): void {
  // Simulate an unsupported compound-created parent: rows exist in the
  // committed DB but were never sync-tracked (no clock/outbox).
  const now = new Date().toISOString()
  sqlite
    .prepare(`INSERT INTO topics (id, name, created_at, updated_at, extra) VALUES (?,?,?,?,?)`)
    .run('t-compound', 'Compound', now, now, JSON.stringify({ pinned: true }))
  sqlite
    .prepare(
      `INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
    )
    .run('m-compound', 't-compound', 'user', 'orig', 'sent', now, now, 0)
  sqlite
    .prepare(
      `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
    )
    .run('b-compound', 'm-compound', 'text', 'orig-block', 'sent', now, now, 0)
}

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
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
})

describe('parent closure for compound-created parents', () => {
  it('block edit after compound create enqueues topic+message closure before child, no orphan remotely', () => {
    seedCompoundCreatedParent()
    expect(syncService.isTrackedEntity('topic', 't-compound')).toBe(false)

    // Supported child edit goes through the hook after commit.
    sqlite.prepare(`UPDATE message_blocks SET content=? WHERE id=?`).run('edited-block', 'b-compound')
    handleChatDbSuccessForSync(IpcChannel.ChatDb_UpdateSingleBlock, { blockId: 'b-compound' })

    const outbox = syncService.listOutbox()
    const kinds = outbox.map((o) => `${o.entityType}/${o.entityId}`)
    expect(kinds).toContain('topic/t-compound')
    expect(kinds).toContain('message/m-compound')
    expect(kinds).toContain('message_block/b-compound')
    // Parent-before-child push order.
    const idx = (k: string): number => kinds.indexOf(k)
    expect(idx('topic/t-compound')).toBeLessThan(idx('message/m-compound'))
    expect(idx('message/m-compound')).toBeLessThan(idx('message_block/b-compound'))
    // Causal timestamps: parents strictly before child.
    const byKind = Object.fromEntries(outbox.map((o) => [`${o.entityType}/${o.entityId}`, o.timestamp]))
    expect(byKind['topic/t-compound']).toBeLessThan(byKind['message_block/b-compound'])
    expect(byKind['message/m-compound']).toBeLessThan(byKind['message_block/b-compound'])

    // Remote apply in push order must not orphan.
    for (const op of outbox) {
      expect(syncService.applyIncomingOperation({ ...op, deviceId: 'remote-peer', id: `r-${op.id}` } as any)).toBe(true)
    }
  })

  it('message edit after compound create enqueues topic closure before child', () => {
    seedCompoundCreatedParent()
    sqlite.prepare(`UPDATE messages SET content=? WHERE id=?`).run('edited', 'm-compound')
    handleChatDbSuccessForSync(IpcChannel.ChatDb_UpdateMessage, {
      messageId: 'm-compound',
      topicId: 't-compound',
      updates: { content: 'edited' }
    })
    const kinds = syncService.listOutbox().map((o) => `${o.entityType}/${o.entityId}`)
    expect(kinds).toContain('topic/t-compound')
    expect(kinds).toContain('message/m-compound')
    expect(kinds.indexOf('topic/t-compound')).toBeLessThan(kinds.indexOf('message/m-compound'))
  })

  it('proven-absent target is a non-error no-op (no parent closure, no capture error)', () => {
    seedCompoundCreatedParent()
    // Delete the target and its parents: the target row is proven absent, so
    // the fallback must skip before any parent closure (no false capture
    // error). A present target with an unavailable parent stays a durable
    // failure (covered by the transient-parent hook test).
    sqlite.prepare(`DELETE FROM message_blocks WHERE id=?`).run('b-compound')
    sqlite.prepare(`DELETE FROM messages WHERE id=?`).run('m-compound')
    sqlite.prepare(`DELETE FROM topics WHERE id=?`).run('t-compound')
    handleChatDbSuccessForSync(IpcChannel.ChatDb_UpdateSingleBlock, { blockId: 'b-compound' })
    const outbox = syncService.listOutbox()
    expect(outbox.filter((o) => o.entityId === 'b-compound')).toHaveLength(0)
    const lastCapture = sqlite.prepare(`SELECT value FROM sync_state WHERE key='lastCaptureError'`).get() as
      | { value: string }
      | undefined
    const lastError = sqlite.prepare(`SELECT value FROM sync_state WHERE key='lastError'`).get() as
      | { value: string }
      | undefined
    expect(lastCapture).toBeUndefined()
    expect(lastError).toBeUndefined()
  })
})

describe('syncable topic metadata', () => {
  it('topic capture carries pinned/prompt/isNameManuallyEdited and roundtrips remotely', () => {
    const now = new Date().toISOString()
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at, extra) VALUES (?,?,?,?,?)`)
      .run(
        't-meta',
        'Meta',
        now,
        now,
        JSON.stringify({ pinned: true, prompt: 'sys', isNameManuallyEdited: true, future: 'keep-me' })
      )
    handleChatDbSuccessForSync(IpcChannel.ChatDb_UpdateTopicMetadata, {
      topicId: 't-meta',
      pinned: true,
      prompt: 'sys',
      isNameManuallyEdited: true
    })
    const outbox = syncService.listOutbox()
    expect(outbox).toHaveLength(1)
    expect(outbox[0].payload).toMatchObject({ pinned: true, prompt: 'sys', isNameManuallyEdited: true })

    // Remote merge preserves unrelated overflow and applies metadata.
    const remoteSqlite = openInMemory()
    const remoteDb = drizzle(remoteSqlite, { schema })
    runMigrations(remoteDb as any, remoteSqlite)
    const rnow = new Date().toISOString()
    remoteSqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at, extra) VALUES (?,?,?,?,?)`)
      .run('t-meta', 'Meta', rnow, rnow, JSON.stringify({ future: 'keep-me', localOnly: 1 }))
    ;(chatDbService as any).sqlite = remoteSqlite
    ;(chatDbService as any).db = remoteDb
    const op = { ...outbox[0], id: 'op-meta-remote', deviceId: 'remote' } as any
    expect(syncService.applyIncomingOperation(op)).toBe(true)
    const row = remoteSqlite.prepare(`SELECT extra FROM topics WHERE id=?`).get('t-meta') as { extra: string }
    const extra = JSON.parse(row.extra)
    expect(extra.pinned).toBe(true)
    expect(extra.prompt).toBe('sys')
    expect(extra.isNameManuallyEdited).toBe(true)
    expect(extra.future).toBe('keep-me')
    expect(extra.localOnly).toBe(1)
    remoteSqlite.close()
    ;(chatDbService as any).sqlite = sqlite
    ;(chatDbService as any).db = db
  })

  it('absent metadata keys preserve existing overflow (no wipe)', () => {
    const now = new Date().toISOString()
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at, extra) VALUES (?,?,?,?,?)`)
      .run('t-keep', 'K', now, now, JSON.stringify({ pinned: true, prompt: 'keep' }))
    const op: any = {
      id: 'op-keep-partial',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-keep',
      timestamp: Date.now(),
      deviceId: 'remote',
      payload: { id: 't-keep', name: 'K2' }
    }
    expect(syncService.applyIncomingOperation(op)).toBe(true)
    const row = sqlite.prepare(`SELECT extra FROM topics WHERE id=?`).get('t-keep') as { extra: string }
    const extra = JSON.parse(row.extra)
    expect(extra.pinned).toBe(true)
    expect(extra.prompt).toBe('keep')
  })

  it('wrong metadata types are rejected strictly, never silently dropped', () => {
    const badPinned: any = {
      id: 'op-bad-pinned',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-bad',
      timestamp: Date.now(),
      deviceId: 'remote',
      payload: { id: 't-bad', pinned: 'yes' }
    }
    expect(validateSyncOperationStrict(badPinned)).toMatch(/pinned/i)
    expect(() => syncService.applyIncomingOperation(badPinned)).toThrow()
    const badEdited: any = {
      id: 'op-bad-edited',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-bad',
      timestamp: Date.now(),
      deviceId: 'remote',
      payload: { id: 't-bad', isNameManuallyEdited: 1 }
    }
    expect(validateSyncOperationStrict(badEdited)).toMatch(/isNameManuallyEdited/i)
  })

  it('denylist remains enforced: contextWindowAnchor and arbitrary overflow rejected', () => {
    const anchor: any = {
      id: 'op-anchor',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-deny',
      timestamp: Date.now(),
      deviceId: 'remote',
      payload: { id: 't-deny', contextWindowAnchor: 'x' }
    }
    expect(validateSyncPayloadAllowlist(anchor)).toMatch(/allowlisted|denied/i)
    expect(validateSyncOperationStrict(anchor)).not.toBeNull()
    const rogue: any = {
      id: 'op-rogue',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-deny',
      timestamp: Date.now(),
      deviceId: 'remote',
      payload: { id: 't-deny', rogueField: 1 }
    }
    expect(validateSyncPayloadAllowlist(rogue)).toMatch(/not allowlisted/i)
  })
})
