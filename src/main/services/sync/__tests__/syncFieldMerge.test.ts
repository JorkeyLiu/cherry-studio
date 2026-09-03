/**
 * Field-level merge + transactional outbox (LOCK-PERSONAL-005/006/010):
 * cross-field convergence, deterministic same-field conflicts with bounded
 * safe records, patch immutability/denylist, stale-full preservation,
 * and same-transaction atomicity of mutation + sync intent.
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

import { chatDbService } from '../../chatDb'
import { ChatDbAggregateService } from '../../chatDb/ChatDbAggregateService'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { syncService } from '../SyncService'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>
let aggregate: ChatDbAggregateService

const T0 = 1_700_000_000_000

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

function bindPrimary(): void {
  ;(chatDbService as any).sqlite = sqlite
  ;(chatDbService as any).db = db
  aggregate = new ChatDbAggregateService(db)
}

function openSecond(): { sqlite: Database.Database; db: BetterSQLite3Database<typeof schema> } {
  const s2 = openInMemory()
  const d2 = drizzle(s2, { schema })
  runMigrations(d2 as any, s2)
  return { sqlite: s2, db: d2 }
}

function withDb(target: { sqlite: Database.Database; db: BetterSQLite3Database<typeof schema> }, fn: () => void): void {
  const prevSqlite = (chatDbService as any).sqlite
  const prevDb = (chatDbService as any).db
  ;(chatDbService as any).sqlite = target.sqlite
  ;(chatDbService as any).db = target.db
  try {
    fn()
  } finally {
    ;(chatDbService as any).sqlite = prevSqlite
    ;(chatDbService as any).db = prevDb
  }
}

function seedTopicMessageBlock(now: string): void {
  sqlite
    .prepare(`INSERT INTO topics (id, name, created_at, updated_at, extra) VALUES (?,?,?,?,?)`)
    .run('t1', 'T', now, now, null)
  sqlite
    .prepare(
      `INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
    )
    .run('m1', 't1', 'user', 'hello', 'sent', now, now, 0)
  sqlite
    .prepare(
      `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
    )
    .run('b1', 'm1', 'text', 'block-hi', 'sent', now, now, 0)
}

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
  sqlite = openInMemory()
  db = drizzle(sqlite, { schema })
  runMigrations(db as any, sqlite)
  bindPrimary()
  syncService.clearAllForTests()
})

afterEach(() => {
  try {
    sqlite.close()
  } catch {}
  ;(chatDbService as any).sqlite = null
  ;(chatDbService as any).db = null
})

describe('cross-field convergence', () => {
  it('concurrent topic name + pinned updates on two devices converge preserving both', () => {
    const second = openSecond()
    try {
      const now = new Date().toISOString()
      seedTopicMessageBlock(now)
      withDb(second, () => {
        second.sqlite
          .prepare(`INSERT INTO topics (id, name, created_at, updated_at, extra) VALUES (?,?,?,?,?)`)
          .run('t1', 'T', now, now, null)
      })
      // Device A renames; device B pins — independent fields, overlapping time.
      const opA: any = {
        id: 'op-aaa-name',
        entityType: 'topic',
        op: 'upsert',
        entityId: 't1',
        timestamp: T0,
        deviceId: 'dev-a',
        payload: { id: 't1', name: 'Renamed-by-A' }
      }
      const opB: any = {
        id: 'op-zzz-pin',
        entityType: 'topic',
        op: 'upsert',
        entityId: 't1',
        timestamp: T0 + 5,
        deviceId: 'dev-b',
        payload: { id: 't1', pinned: true }
      }
      expect(syncService.applyIncomingOperation(opA)).toBe(true)
      withDb(second, () => {
        expect(syncService.applyIncomingOperation(opB)).toBe(true)
      })
      // Exchange: B receives A's rename, A receives B's pin.
      withDb(second, () => {
        expect(syncService.applyIncomingOperation({ ...opA, id: 'op-aaa-name-x' })).toBe(true)
      })
      expect(syncService.applyIncomingOperation({ ...opB, id: 'op-zzz-pin-x' })).toBe(true)
      for (const target of [
        { sqlite, label: 'A' },
        { sqlite: second.sqlite, label: 'B' }
      ]) {
        const row = target.sqlite.prepare(`SELECT name, extra FROM topics WHERE id=?`).get('t1') as any
        expect(row.name).toBe('Renamed-by-A')
        expect(JSON.parse(row.extra).pinned).toBe(true)
      }
      // No conflict recorded: different fields never contest.
      expect(syncService.getConflictCount()).toBe(0)
    } finally {
      try {
        second.sqlite.close()
      } catch {}
      bindPrimary()
    }
  })

  it('concurrent message content + status patches merge by field', () => {
    const now = new Date().toISOString()
    seedTopicMessageBlock(now)
    const opContent: any = {
      id: 'op-m-content',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm1',
      timestamp: T0,
      deviceId: 'dev-a',
      payload: { id: 'm1', topicId: 't1', content: 'edited-content' }
    }
    const opStatus: any = {
      id: 'op-m-status',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm1',
      timestamp: T0 + 5,
      deviceId: 'dev-b',
      payload: { id: 'm1', topicId: 't1', status: 'success' }
    }
    expect(syncService.applyIncomingOperation(opContent)).toBe(true)
    expect(syncService.applyIncomingOperation(opStatus)).toBe(true)
    const row = sqlite.prepare(`SELECT content, status FROM messages WHERE id=?`).get('m1') as any
    expect(row.content).toBe('edited-content')
    expect(row.status).toBe('success')
  })
})

describe('same-field deterministic conflicts', () => {
  it('later timestamp wins and the loser is recorded once, surfaced in status', () => {
    const now = new Date().toISOString()
    seedTopicMessageBlock(now)
    const first: any = {
      id: 'op-conf-first',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't1',
      timestamp: T0,
      deviceId: 'dev-a',
      payload: { id: 't1', name: 'first' }
    }
    const secondOp: any = {
      id: 'op-conf-second',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't1',
      timestamp: T0 + 10,
      deviceId: 'dev-b',
      payload: { id: 't1', name: 'second' }
    }
    expect(syncService.applyIncomingOperation(first)).toBe(true)
    expect(syncService.applyIncomingOperation(secondOp)).toBe(true)
    const row = sqlite.prepare(`SELECT name FROM topics WHERE id=?`).get('t1') as any
    expect(row.name).toBe('second')
    expect(syncService.getConflictCount()).toBe(1)
    const rec = sqlite
      .prepare(`SELECT entity_type, entity_id, field, loser_value_json FROM sync_conflict_log`)
      .get() as any
    expect(rec.entity_type).toBe('topic')
    expect(rec.entity_id).toBe('t1')
    expect(rec.field).toBe('name')
    expect(JSON.parse(rec.loser_value_json)).toBe('first')
    const status = syncService.getStatus()
    expect(status.conflictCount).toBe(1)
  })

  it('equal timestamps break ties by operation id deterministically', () => {
    const now = new Date().toISOString()
    seedTopicMessageBlock(now)
    const low: any = {
      id: 'op-aaa-low',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm1',
      timestamp: T0,
      deviceId: 'dev-a',
      payload: { id: 'm1', topicId: 't1', content: 'low' }
    }
    const high: any = {
      id: 'op-zzz-high',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm1',
      timestamp: T0,
      deviceId: 'dev-b',
      payload: { id: 'm1', topicId: 't1', content: 'high' }
    }
    // Apply higher first, then lower must lose without mutating.
    expect(syncService.applyIncomingOperation(high)).toBe(true)
    expect(syncService.applyIncomingOperation(low)).toBe(false)
    const row = sqlite.prepare(`SELECT content FROM messages WHERE id=?`).get('m1') as any
    expect(row.content).toBe('high')
    expect(syncService.getConflictCount()).toBe(1)
  })

  it('conflict log is bounded and stores only safe scalar values', () => {
    const now = new Date().toISOString()
    seedTopicMessageBlock(now)
    for (let i = 0; i < 130; i++) {
      const ts = T0 + i
      syncService.applyIncomingOperation({
        id: `op-bound-${String(i).padStart(4, '0')}`,
        entityType: 'topic',
        op: 'upsert',
        entityId: 't1',
        timestamp: ts,
        deviceId: 'dev-x',
        payload: { id: 't1', name: `v${i}` }
      } as any)
    }
    const count = (sqlite.prepare(`SELECT COUNT(*) as c FROM sync_conflict_log`).get() as any).c as number
    expect(count).toBeLessThanOrEqual(100)
    const rows = sqlite.prepare(`SELECT loser_value_json FROM sync_conflict_log`).all() as any[]
    for (const r of rows) {
      expect(r.loser_value_json ?? '').not.toMatch(/file_path|credential|password|secret/i)
    }
  })
})

describe('patch safety: immutability, denylist, tombstones, stale full', () => {
  it('message patch cannot reparent: topicId preserved, no mutation', () => {
    const now = new Date().toISOString()
    seedTopicMessageBlock(now)
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?,?,?,?)`)
      .run('t2', 'Other', now, now)
    const evil: any = {
      id: 'op-evil-reparent',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm1',
      timestamp: T0 + 50,
      deviceId: 'dev-evil',
      payload: { id: 'm1', topicId: 't2', content: 'moved' }
    }
    expect(syncService.applyIncomingOperation(evil)).toBe(false)
    const row = sqlite.prepare(`SELECT topic_id, content FROM messages WHERE id=?`).get('m1') as any
    expect(row.topic_id).toBe('t1')
    expect(row.content).toBe('hello')
  })

  it('denied fields are rejected, never stored', () => {
    const bad: any = {
      id: 'op-denied-1',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-denied',
      timestamp: T0,
      deviceId: 'dev-a',
      payload: { id: 't-denied', contextWindowAnchor: 'x' }
    }
    expect(() => syncService.applyIncomingOperation(bad)).toThrow()
    expect(syncService.getConflictCount()).toBe(0)
  })

  it('tombstone delete still wins over a stale late patch (LWW)', () => {
    const now = new Date().toISOString()
    seedTopicMessageBlock(now)
    syncService.applyIncomingOperation({
      id: 'op-del-m1',
      entityType: 'message',
      op: 'delete',
      entityId: 'm1',
      timestamp: T0 + 100,
      deviceId: 'dev-a'
    } as any)
    // Stale relative to the delete: suppressed, never resurrects.
    const stale: any = {
      id: 'op-stale-patch',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm1',
      timestamp: T0 + 99,
      deviceId: 'dev-b',
      payload: { id: 'm1', topicId: 't1', content: 'late-edit' }
    }
    expect(syncService.applyIncomingOperation(stale)).toBe(false)
    expect(sqlite.prepare(`SELECT id FROM messages WHERE id=?`).get('m1')).toBeUndefined()
    // Newer than the delete: deterministic LWW resurrects (same rule as the
    // higher-operation-ID tombstone test).
    const fresh: any = {
      id: 'op-fresh-patch',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm1',
      timestamp: T0 + 101,
      deviceId: 'dev-b',
      payload: { id: 'm1', topicId: 't1', content: 'recreated' }
    }
    expect(syncService.applyIncomingOperation(fresh)).toBe(true)
    const row = sqlite.prepare(`SELECT content FROM messages WHERE id=?`).get('m1') as any
    expect(row.content).toBe('recreated')
  })

  it('stale full snapshot does not wipe a newer independent patch field', () => {
    const now = new Date().toISOString()
    seedTopicMessageBlock(now)
    // Newer independent patch wins its field first.
    expect(
      syncService.applyIncomingOperation({
        id: 'op-new-patch',
        entityType: 'message',
        op: 'upsert',
        entityId: 'm1',
        timestamp: T0 + 100,
        deviceId: 'dev-a',
        payload: { id: 'm1', topicId: 't1', content: 'new-content' }
      } as any)
    ).toBe(true)
    // Stale full snapshot (older timestamp, all fields incl. sortOrder).
    // Never-before-seen fields may still apply (first-write wins), but the
    // newer independent patch field must survive with a conflict record.
    const staleFull: any = {
      id: 'op-stale-full',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm1',
      timestamp: T0 + 10,
      deviceId: 'dev-old',
      payload: {
        id: 'm1',
        topicId: 't1',
        role: 'user',
        content: 'stale-content',
        status: 'sent',
        createdAt: now,
        updatedAt: now,
        sortOrder: 0
      }
    }
    expect(syncService.applyIncomingOperation(staleFull)).toBe(true)
    const row = sqlite.prepare(`SELECT content FROM messages WHERE id=?`).get('m1') as any
    expect(row.content).toBe('new-content')
    const conflict = sqlite
      .prepare(`SELECT loser_value_json FROM sync_conflict_log WHERE entity_id=? AND field=?`)
      .get('m1', 'content') as any
    expect(JSON.parse(conflict.loser_value_json)).toBe('stale-content')
    // A stale patch touching ONLY the clocked field loses wholesale.
    const staleNarrow: any = {
      id: 'op-stale-narrow',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm1',
      timestamp: T0 + 11,
      deviceId: 'dev-old',
      payload: { id: 'm1', topicId: 't1', content: 'stale-again' }
    }
    expect(syncService.applyIncomingOperation(staleNarrow)).toBe(false)
    const row2 = sqlite.prepare(`SELECT content FROM messages WHERE id=?`).get('m1') as any
    expect(row2.content).toBe('new-content')
  })
})

describe('transactional outbox via aggregate', () => {
  it('updateMessage captures a patch-only payload atomically with the mutation', () => {
    const now = new Date().toISOString()
    seedTopicMessageBlock(now)
    const res = aggregate.updateMessage('t1', 'm1', { content: 'patched' } as unknown as JsonObject)
    expect(res.ok).toBe(true)
    const outbox = syncService.listOutbox()
    const msgOps = outbox.filter((o) => o.entityType === 'message' && o.entityId === 'm1')
    expect(msgOps).toHaveLength(1)
    // Patch-only: identity + changed field, never sortOrder/role/status.
    expect(Object.keys(msgOps[0].payload ?? {}).sort()).toEqual(['content', 'id', 'topicId'].sort())
    // Closure captured the untracked topic parent first.
    const kinds = outbox.map((o) => `${o.entityType}/${o.entityId}`)
    expect(kinds).toContain('topic/t1')
    expect(kinds.indexOf('topic/t1')).toBeLessThan(kinds.indexOf('message/m1'))
    // Field clocks advanced for the patched field only.
    const clocks = sqlite.prepare(`SELECT field FROM sync_field_clock WHERE entity_id=?`).all('m1') as any[]
    expect(clocks.map((c) => c.field)).toContain('content')
    expect(clocks.map((c) => c.field)).not.toContain('status')
  })

  it('failed mutation leaves no partial sync intent (rollback, not post-commit loss)', () => {
    const now = new Date().toISOString()
    seedTopicMessageBlock(now)
    const before = syncService.listOutbox().length
    // Duplicate block IDs abort the whole batch transaction.
    const res = aggregate.bulkAddBlocks([
      { id: 'b-new-1', messageId: 'm1', type: 'text', content: 'a' },
      { id: 'b-new-1', messageId: 'm1', type: 'text', content: 'b' }
    ] as unknown as JsonObject[])
    expect(res.ok).toBe(false)
    expect(syncService.listOutbox()).toHaveLength(before)
    expect(sqlite.prepare(`SELECT id FROM message_blocks WHERE id=?`).get('b-new-1')).toBeUndefined()
  })

  it('intent and mutation share one transaction: crash between them rolls back both', () => {
    const now = new Date().toISOString()
    seedTopicMessageBlock(now)
    // Simulate an interrupted point between mutation and intent: a throw
    // after the row write but before commit must roll back BOTH.
    expect(() =>
      db.transaction((tx) => {
        tx.insert(schema.topics).values({ id: 't-crash', name: 'Crash', createdAt: now, updatedAt: now }).run()
        syncService.enqueueUpsertInTx(tx as any, 'topic', 't-crash', { id: 't-crash', name: 'Crash' }, T0, 'dev-a')
        throw new Error('simulated crash between mutation and outbox')
      })
    ).toThrow(/simulated crash/)
    expect(sqlite.prepare(`SELECT id FROM topics WHERE id=?`).get('t-crash')).toBeUndefined()
    expect(syncService.listOutbox().filter((o) => o.entityId === 't-crash')).toHaveLength(0)
  })

  it('unsupported reorder captures nothing', () => {
    const now = new Date().toISOString()
    seedTopicMessageBlock(now)
    sqlite
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
      )
      .run('m2', 't1', 'user', 'second', 'sent', now, now, 1)
    const res = aggregate.reorderMessages('t1', ['m2', 'm1'])
    expect(res.ok).toBe(true)
    expect(syncService.listOutbox()).toHaveLength(0)
  })

  it('delete via aggregate enqueues tombstone intent atomically', () => {
    const now = new Date().toISOString()
    seedTopicMessageBlock(now)
    const del = aggregate.deleteMessage('t1', 'm1')
    expect(del.ok).toBe(true)
    const outbox = syncService.listOutbox()
    expect(outbox.some((o) => o.entityType === 'message' && o.entityId === 'm1' && o.op === 'delete')).toBe(true)
    // Unknown ids never emit a remote delete.
    const foreign = aggregate.deleteMessage('t1', 'm-ghost')
    expect(foreign.ok).toBe(true)
    expect(syncService.listOutbox().some((o) => o.entityId === 'm-ghost')).toBe(false)
  })
})
