import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')
vi.mock('@main/config', () => ({ DATA_PATH: '/mock/data' }))

import { isSuccess, validateChatDbResult } from '@shared/chatDb'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { runMigrations } from '../migration'
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-insert-groups-'))
}
function rmrf(dir: string): void {
  realFs.rmSync(dir, { recursive: true, force: true })
}
function openTestDb(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  return db
}
function wrapDrizzle(sqlite: Database.Database): BetterSQLite3Database<typeof schema> {
  return drizzle(sqlite, { schema })
}
let counter = 0
function uid(): string {
  return `g${++counter}-${Date.now()}`
}
function okValue<T>(result: { ok: boolean; value?: T; error?: unknown }): T {
  if (!isSuccess(result as any)) throw new Error(`Expected success, got: ${JSON.stringify((result as any).error)}`)
  return (result as any).value as T
}
function failError(result: { ok: boolean; error?: any }): any {
  if (isSuccess(result as any)) throw new Error('Expected failure')
  return (result as any).error
}
function makeMessageJson(topicId: string, overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `m-${uid()}`,
    topicId,
    role: 'user',
    content: 'Hello',
    status: 'success',
    createdAt: new Date().toISOString(),
    ...overrides
  }
}
function makeBlockJson(messageId: string, type = 'main_text', overrides?: Record<string, unknown>) {
  return {
    id: `b-${uid()}`,
    messageId,
    type,
    content: type === 'main_text' ? `content-${uid()}` : null,
    status: 'success',
    createdAt: new Date().toISOString(),
    ...overrides
  }
}

describe('insertMessageGroups — stable intents, atomic multi-group', () => {
  let sqlite: Database.Database
  let db: BetterSQLite3Database<typeof schema>
  let agg: ChatDbAggregateService
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir()
    const dbPath = realPath.join(tmpDir, 'chat.db')
    sqlite = openTestDb(dbPath)
    db = wrapDrizzle(sqlite)
    runMigrations(db, sqlite)
    agg = new ChatDbAggregateService(db, sqlite)
  })

  afterEach(() => {
    sqlite.close()
    rmrf(tmpDir)
  })

  it('after-group-tail from user lands after full answer group (contiguous)', () => {
    const topic = `t-${uid()}`
    const userId = `u-${uid()}`
    const a1 = `a1-${uid()}`
    const a2 = `a2-${uid()}`
    const after = `after-${uid()}`
    agg.appendMessage(topic, makeMessageJson(topic, { id: userId, role: 'user' }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: a1, role: 'assistant', askId: userId }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: a2, role: 'assistant', askId: userId }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: after, role: 'user' }) as any, [])
    const newId = `n-${uid()}`
    const res = agg.insertMessageGroups(topic, [
      {
        entries: [{ message: makeMessageJson(topic, { id: newId }) as any, blocks: [] }],
        intent: { kind: 'after-group-tail', messageId: userId } as any
      }
    ])
    expect(res.ok).toBe(true)
    validateChatDbResult('chatdb:insert-message-groups', res)
    const order = okValue(agg.fetchMessages(topic)).messages.map((m: any) => m.id)
    expect(order).toEqual([userId, a1, a2, newId, after])
  })

  it('after-group-tail includes non-contiguous same-askId members', () => {
    const topic = `t-${uid()}`
    const userId = `u-${uid()}`
    const a1 = `a1-${uid()}`
    const uMid = `umid-${uid()}`
    const a2 = `a2-${uid()}`
    agg.appendMessage(topic, makeMessageJson(topic, { id: userId, role: 'user' }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: a1, role: 'assistant', askId: userId }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: uMid, role: 'user' }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: a2, role: 'assistant', askId: userId }) as any, [])
    const newId = `n-${uid()}`
    const res = agg.insertMessageGroups(topic, [
      {
        entries: [{ message: makeMessageJson(topic, { id: newId }) as any, blocks: [] }],
        intent: { kind: 'after-group-tail', messageId: a1 } as any
      }
    ])
    expect(res.ok).toBe(true)
    const order = okValue(agg.fetchMessages(topic)).messages.map((m: any) => m.id)
    expect(order).toEqual([userId, a1, uMid, a2, newId])
  })

  it('before-message inserts immediately before surviving anchor; topic-tail appends', () => {
    const topic = `t-${uid()}`
    const m0 = `m0-${uid()}`
    const m1 = `m1-${uid()}`
    agg.appendMessage(topic, makeMessageJson(topic, { id: m0 }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: m1 }) as any, [])
    const beforeId = `b-${uid()}`
    const tailId = `tl-${uid()}`
    const res = agg.insertMessageGroups(topic, [
      {
        entries: [{ message: makeMessageJson(topic, { id: beforeId }) as any, blocks: [] }],
        intent: { kind: 'before-message', messageId: m1 } as any
      },
      {
        entries: [{ message: makeMessageJson(topic, { id: tailId }) as any, blocks: [] }],
        intent: { kind: 'topic-tail' } as any
      }
    ])
    expect(res.ok).toBe(true)
    const order = okValue(agg.fetchMessages(topic)).messages.map((m: any) => m.id)
    expect(order).toEqual([m0, beforeId, m1, tailId])
  })

  it('multiple restore groups restore pre-delete relation atomically', () => {
    const topic = `t-${uid()}`
    const ids = [`r0-${uid()}`, `r1-${uid()}`, `r2-${uid()}`, `r3-${uid()}`, `r4-${uid()}`]
    for (const id of ids) agg.appendMessage(topic, makeMessageJson(topic, { id }) as any, [])
    // Simulate two deleted runs restored before r2 and r4 (same shape as delete snapshot anchors)
    const g1 = `g1-${uid()}`
    const g2 = `g2-${uid()}`
    const res = agg.insertMessageGroups(topic, [
      {
        entries: [{ message: makeMessageJson(topic, { id: g1 }) as any, blocks: [] }],
        intent: { kind: 'before-message', messageId: ids[2] } as any
      },
      {
        entries: [{ message: makeMessageJson(topic, { id: g2 }) as any, blocks: [] }],
        intent: { kind: 'before-message', messageId: ids[4] } as any
      }
    ])
    expect(res.ok).toBe(true)
    const order = okValue(agg.fetchMessages(topic)).messages.map((m: any) => m.id)
    expect(order).toEqual([ids[0], ids[1], g1, ids[2], ids[3], g2, ids[4]])
  })

  it('missing anchor fails whole transaction with no partial writes', () => {
    const topic = `t-${uid()}`
    const m0 = `m0-${uid()}`
    agg.appendMessage(topic, makeMessageJson(topic, { id: m0 }) as any, [])
    const before = okValue(agg.fetchMessages(topic)).messages.length
    const res = agg.insertMessageGroups(topic, [
      {
        entries: [{ message: makeMessageJson(topic, { id: `n1-${uid()}` }) as any, blocks: [] }],
        intent: { kind: 'before-message', messageId: m0 } as any
      },
      {
        entries: [{ message: makeMessageJson(topic, { id: `n2-${uid()}` }) as any, blocks: [] }],
        intent: { kind: 'before-message', messageId: 'missing-anchor' } as any
      }
    ])
    expect(res.ok).toBe(false)
    expect(failError(res).code).toBe('NOT_FOUND')
    expect(okValue(agg.fetchMessages(topic)).messages.length).toBe(before)
  })

  it('cross-topic anchor fails with no partial writes', () => {
    const t1 = `t1-${uid()}`
    const t2 = `t2-${uid()}`
    const m1 = `m1-${uid()}`
    const m2 = `m2-${uid()}`
    agg.appendMessage(t1, makeMessageJson(t1, { id: m1 }) as any, [])
    agg.appendMessage(t2, makeMessageJson(t2, { id: m2 }) as any, [])
    const before = okValue(agg.fetchMessages(t1)).messages.length
    const res = agg.insertMessageGroups(t1, [
      {
        entries: [{ message: makeMessageJson(t1, { id: `n-${uid()}` }) as any, blocks: [] }],
        intent: { kind: 'before-message', messageId: m2 } as any
      }
    ])
    expect(res.ok).toBe(false)
    expect(failError(res).code).toBe('NOT_FOUND')
    expect(okValue(agg.fetchMessages(t1)).messages.length).toBe(before)
  })

  it('ID collision fails closed with rollback (no silent patch)', () => {
    const topic = `t-${uid()}`
    const m0 = `m0-${uid()}`
    agg.appendMessage(topic, makeMessageJson(topic, { id: m0 }) as any, [])
    const before = okValue(agg.fetchMessages(topic)).messages.map((m: any) => m.id)
    const res = agg.insertMessageGroups(topic, [
      {
        entries: [{ message: makeMessageJson(topic, { id: m0, content: 'patched' }) as any, blocks: [] }],
        intent: { kind: 'topic-tail' } as any
      }
    ])
    expect(res.ok).toBe(false)
    expect(failError(res).code).toBe('CONFLICT_ERROR')
    expect(okValue(agg.fetchMessages(topic)).messages.map((m: any) => m.id)).toEqual(before)
  })

  it('persists blocks/file refs in order and returns FileCleanupResult', () => {
    const topic = `t-${uid()}`
    const m0 = `m0-${uid()}`
    agg.appendMessage(topic, makeMessageJson(topic, { id: m0 }) as any, [])
    const uNew = `un-${uid()}`
    const userMsg = makeMessageJson(topic, { id: uNew, role: 'user' })
    const userBlock = makeBlockJson(uNew, 'main_text')
    const res = agg.insertMessageGroups(topic, [
      {
        entries: [{ message: userMsg as any, blocks: [userBlock as any] }],
        intent: { kind: 'topic-tail' } as any
      }
    ])
    expect(res.ok).toBe(true)
    const value = okValue(res) as { affectedFileIds: string[]; remainingReferenceCounts: Record<string, number> }
    expect(value.affectedFileIds).toEqual([])
    validateChatDbResult('chatdb:insert-message-groups', res)
    const fetched = okValue(agg.fetchMessages(topic))
    expect(fetched.messages.map((m: any) => m.id)).toEqual([m0, uNew])
    expect(fetched.blocks.map((b: any) => b.id)).toContain(userBlock.id)
  })
})
