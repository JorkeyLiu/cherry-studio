import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')
vi.mock('@main/config', () => ({ DATA_PATH: '/mock/data' }))

import { isSuccess } from '@shared/chatDb'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { runMigrations, TOPIC_SEGMENT_MESSAGES_MESSAGE_ID_UNIQ_INDEX } from '../migration'
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-insert-anchor-segment-'))
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
  return `s${++counter}-${Date.now()}`
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

describe('insertMessagesAfterAnchor — segment auto-membership', () => {
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

  it('middle insert joins the anchor group in route order, not appended', () => {
    const topic = `t-${uid()}`
    const u0 = `u0-${uid()}`
    const a1 = `a1-${uid()}`
    const a2 = `a2-${uid()}`
    const m3 = `m3-${uid()}`
    agg.appendMessage(topic, makeMessageJson(topic, { id: u0, role: 'user' }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: a1, role: 'assistant', askId: u0 }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: a2, role: 'assistant', askId: u0 }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: m3, role: 'user' }) as any, [])
    const segId = `seg-${uid()}`
    const created = agg.upsertSegment({
      segmentId: segId,
      topicId: topic,
      branchId: null,
      name: 'g',
      messageIds: [u0, a1, a2, m3]
    })
    expect(created.ok).toBe(true)

    const unew = `unew-${uid()}`
    const anew = `anew-${uid()}`
    const res = agg.insertMessagesAfterAnchor(topic, a1, [
      { message: makeMessageJson(topic, { id: unew, role: 'user' }) as any, blocks: [] },
      { message: makeMessageJson(topic, { id: anew, role: 'assistant', askId: unew }) as any, blocks: [] }
    ])
    expect(res.ok).toBe(true)
    const value = okValue(res) as any
    expect(value.insertedMessageIds).toEqual([unew, anew])

    // Durable route order: the pair sits after the anchor group tail (a2), before m3.
    const order = okValue(agg.fetchMessages(topic)).messages.map((m: any) => m.id)
    expect(order).toEqual([u0, a1, a2, unew, anew, m3])

    // Authoritative group membership follows the same route order (spliced, not appended).
    const catalog = okValue(agg.listSegments(topic))
    expect(catalog.map((s: any) => s.id)).toEqual([segId])
    expect((catalog[0] as any).messageIds).toEqual([u0, a1, a2, unew, anew, m3])
  })

  it('anchor outside every group preserves the old behavior (no catalog write)', () => {
    const topic = `t-${uid()}`
    const m0 = `m0-${uid()}`
    const m1 = `m1-${uid()}`
    agg.appendMessage(topic, makeMessageJson(topic, { id: m0 }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: m1 }) as any, [])
    const segId = `seg-${uid()}`
    const created = agg.upsertSegment({ segmentId: segId, topicId: topic, branchId: null, name: 'g', messageIds: [m0] })
    expect(created.ok).toBe(true)

    const n1 = `n1-${uid()}`
    const n2 = `n2-${uid()}`
    const res = agg.insertMessagesAfterAnchor(topic, m1, [
      { message: makeMessageJson(topic, { id: n1 }) as any, blocks: [] },
      { message: makeMessageJson(topic, { id: n2 }) as any, blocks: [] }
    ])
    expect(res.ok).toBe(true)
    const order = okValue(agg.fetchMessages(topic)).messages.map((m: any) => m.id)
    expect(order).toEqual([m0, m1, n1, n2])
    const catalog = okValue(agg.listSegments(topic))
    expect((catalog[0] as any).messageIds).toEqual([m0])
  })

  it('rejects atomically when group authority forbids membership (no partial messages or membership)', () => {
    const topic = `t-${uid()}`
    const m0 = `m0-${uid()}`
    const m1 = `m1-${uid()}`
    const m2 = `m2-${uid()}`
    agg.appendMessage(topic, makeMessageJson(topic, { id: m0, role: 'user' }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: m1, role: 'user' }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: m2, role: 'user' }) as any, [])
    const branchId = (okValue(agg.createBranch(topic, null, m1, 'B1')).branch as { id: string }).id
    const c0 = `c0-${uid()}`
    agg.appendMessage(topic, makeMessageJson(topic, { id: c0, role: 'user' }) as any, [], undefined, undefined, {
      branchId
    })
    const segId = `seg-${uid()}`
    const created = agg.upsertSegment({
      segmentId: segId,
      topicId: topic,
      branchId: null,
      name: 'g',
      messageIds: [m0, m1, m2]
    })
    expect(created.ok).toBe(true)
    const beforeRoute = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: topic, branchId, limit: 20 }))
    const beforeIds = beforeRoute.messages.map((m: any) => m.id)

    // Fork-boundary message insert is allowed, but the anchor group belongs to
    // another route, so auto-membership is impossible: fail closed with zero writes.
    const n1 = `n1-${uid()}`
    const n2 = `n2-${uid()}`
    const res = agg.insertMessagesAfterAnchor(
      topic,
      m1,
      [
        { message: makeMessageJson(topic, { id: n1, role: 'user' }) as any, blocks: [] },
        { message: makeMessageJson(topic, { id: n2, role: 'user' }) as any, blocks: [] }
      ],
      branchId
    )
    expect(res.ok).toBe(false)
    expect(failError(res).code).toBe('VALIDATION_ERROR')
    const afterRoute = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: topic, branchId, limit: 20 }))
    expect(afterRoute.messages.map((m: any) => m.id)).toEqual(beforeIds)
    const catalog = okValue(agg.listSegments(topic))
    expect((catalog[0] as any).messageIds).toEqual([m0, m1, m2])
  })

  it('fails closed with zero writes when the anchor is filed under more than one group (legacy overlap)', () => {
    const topic = `t-${uid()}`
    const m0 = `m0-${uid()}`
    const m1 = `m1-${uid()}`
    const m2 = `m2-${uid()}`
    agg.appendMessage(topic, makeMessageJson(topic, { id: m0, role: 'user' }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: m1, role: 'user' }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: m2, role: 'user' }) as any, [])
    const s1 = `s1-${uid()}`
    const s2 = `s2-${uid()}`
    expect(
      agg.upsertSegment({ segmentId: s1, topicId: topic, branchId: null, name: 'first', messageIds: [m0, m1] }).ok
    ).toBe(true)
    expect(
      agg.upsertSegment({ segmentId: s2, topicId: topic, branchId: null, name: 'second', messageIds: [m2] }).ok
    ).toBe(true)
    // Legacy overlap: file m1 under s2 as well. Every guarded writer would
    // reject this, and the new unique index physically forbids it, so the
    // fixture first drops back to the pre-021 shape (the legacy state under
    // test) and inserts the conflicting row with raw SQL.
    sqlite.exec(`DROP INDEX IF EXISTS ${TOPIC_SEGMENT_MESSAGES_MESSAGE_ID_UNIQ_INDEX}`)
    sqlite
      .prepare(`INSERT INTO topic_segment_messages (segment_id, message_id, sort_order) VALUES (?, ?, ?)`)
      .run(s2, m1, 1)
    const beforeIds = okValue(agg.fetchMessages(topic)).messages.map((m: any) => m.id)

    const n1 = `n1-${uid()}`
    const n2 = `n2-${uid()}`
    const res = agg.insertMessagesAfterAnchor(topic, m1, [
      { message: makeMessageJson(topic, { id: n1, role: 'user' }) as any, blocks: [] },
      { message: makeMessageJson(topic, { id: n2, role: 'user' }) as any, blocks: [] }
    ])
    expect(res.ok).toBe(false)
    expect(failError(res).code).toBe('VALIDATION_ERROR')
    // Zero writes: route unchanged, and the legacy overlap is surfaced exactly
    // as-is — never silently picked, merged, or repaired.
    expect(okValue(agg.fetchMessages(topic)).messages.map((m: any) => m.id)).toEqual(beforeIds)
    const catalog = okValue(agg.listSegments(topic))
    const byId = new Map(catalog.map((s: any) => [s.id, s.messageIds]))
    expect(byId.get(s1)).toEqual([m0, m1])
    expect(byId.get(s2)).toEqual([m2, m1])
  })

  it('branch route read and route-qualified catalog include the inserted pair', () => {
    const topic = `t-${uid()}`
    const m0 = `m0-${uid()}`
    agg.appendMessage(topic, makeMessageJson(topic, { id: m0, role: 'user' }) as any, [])
    const branchId = (okValue(agg.createBranch(topic, null, m0, 'B1')).branch as { id: string }).id
    const c0 = `c0-${uid()}`
    agg.appendMessage(topic, makeMessageJson(topic, { id: c0, role: 'user' }) as any, [], undefined, undefined, {
      branchId
    })
    const segId = `seg-${uid()}`
    expect(
      agg.upsertSegment({ segmentId: segId, topicId: topic, branchId, name: 'branch group', messageIds: [c0] }).ok
    ).toBe(true)

    const n1 = `n1-${uid()}`
    const n2 = `n2-${uid()}`
    const res = agg.insertMessagesAfterAnchor(
      topic,
      c0,
      [
        { message: makeMessageJson(topic, { id: n1, role: 'user' }) as any, blocks: [] },
        { message: makeMessageJson(topic, { id: n2, role: 'user' }) as any, blocks: [] }
      ],
      branchId
    )
    expect(res.ok).toBe(true)

    const effective = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: topic, branchId, limit: 20 }))
    expect(effective.messages.map((m: any) => m.id)).toEqual([m0, c0, n1, n2])
    expect(new Set(effective.mutableMessageIds)).toEqual(new Set([c0, n1, n2]))

    const catalog = okValue(agg.listSegments(topic, branchId))
    const wire = (catalog as any[]).find((s) => s.id === segId)
    expect(wire.messageIds).toEqual([c0, n1, n2])
    expect(wire.route.routeMemberMessageIds).toEqual([c0, n1, n2])
  })
})
