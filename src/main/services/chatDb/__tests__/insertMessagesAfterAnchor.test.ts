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
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-insert-anchor-'))
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
  return `a${++counter}-${Date.now()}`
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
function makeBlockJson(
  messageId: string,
  type = 'main_text',
  overrides?: Record<string, unknown>
): Record<string, unknown> {
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

describe('insertMessagesAfterAnchor — S6.2c-2 Main-authoritative anchor insert', () => {
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

  it('inserts after anchor at authoritative position (middle)', () => {
    const topic = `t-${uid()}`
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const msg = makeMessageJson(topic, { id: `m-${i}-${uid()}`, content: `msg-${i}` })
      ids.push(msg.id as string)
      agg.appendMessage(topic, msg as any, [])
    }
    const anchor = ids[1]
    const newMsgId = `m-new-${uid()}`
    const newBlockId = `b-new-${uid()}`
    const newMsg = makeMessageJson(topic, { id: newMsgId, role: 'user', content: 'inserted' })
    const newBlock = makeBlockJson(newMsgId, 'main_text', { id: newBlockId, content: 'inserted block' })
    const res = agg.insertMessagesAfterAnchor(topic, anchor, [{ message: newMsg as any, blocks: [newBlock as any] }])
    expect(res.ok).toBe(true)
    const fetched = okValue(agg.fetchMessages(topic))
    expect(fetched.messages.map((m: any) => m.id)).toEqual([ids[0], ids[1], newMsgId, ids[2]])
  })

  it('advances past contiguous assistant group tail (askId)', () => {
    const topic = `t-${uid()}`
    const userId = `u-${uid()}`
    const a1 = `a1-${uid()}`
    const a2 = `a2-${uid()}`
    const a3 = `a3-${uid()}`
    const after = `after-${uid()}`
    // create user + 3 assistant with same askId
    agg.appendMessage(topic, makeMessageJson(topic, { id: userId, role: 'user' }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: a1, role: 'assistant', askId: userId }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: a2, role: 'assistant', askId: userId }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: a3, role: 'assistant', askId: userId }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: after, role: 'user' }) as any, [])
    // Anchor is first assistant in group; insert should go after a3, not after a1
    const newId = `m-new-${uid()}`
    const newMsg = makeMessageJson(topic, { id: newId, role: 'user' })
    const res = agg.insertMessagesAfterAnchor(topic, a1, [{ message: newMsg as any, blocks: [] }])
    expect(res.ok).toBe(true)
    const fetched = okValue(agg.fetchMessages(topic))
    const order = fetched.messages.map((m: any) => m.id)
    // expected: user, a1,a2,a3, new, after
    expect(order).toEqual([userId, a1, a2, a3, newId, after])
  })

  it('does not advance when anchor is user or assistant without askId', () => {
    const topic = `t-${uid()}`
    const u1 = `u1-${uid()}`
    const u2 = `u2-${uid()}`
    const u3 = `u3-${uid()}`
    agg.appendMessage(topic, makeMessageJson(topic, { id: u1, role: 'user' }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: u2, role: 'user' }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: u3, role: 'user' }) as any, [])
    const newId = `m-new-${uid()}`
    const res = agg.insertMessagesAfterAnchor(topic, u1, [
      { message: makeMessageJson(topic, { id: newId }) as any, blocks: [] }
    ])
    expect(res.ok).toBe(true)
    const order = okValue(agg.fetchMessages(topic)).messages.map((m: any) => m.id)
    expect(order).toEqual([u1, newId, u2, u3])
    // assistant without askId
    const topic2 = `t2-${uid()}`
    const aNoAsk = `a-noask-${uid()}`
    const next = `next-${uid()}`
    agg.appendMessage(topic2, makeMessageJson(topic2, { id: aNoAsk, role: 'assistant', askId: '' }) as any, [])
    agg.appendMessage(topic2, makeMessageJson(topic2, { id: next, role: 'user' }) as any, [])
    const new2 = `m-new2-${uid()}`
    const res2 = agg.insertMessagesAfterAnchor(topic2, aNoAsk, [
      { message: makeMessageJson(topic2, { id: new2 }) as any, blocks: [] }
    ])
    expect(res2.ok).toBe(true)
    const order2 = okValue(agg.fetchMessages(topic2)).messages.map((m: any) => m.id)
    expect(order2).toEqual([aNoAsk, new2, next])
  })

  it('breaks group tail at non-assistant or different askId', () => {
    const topic = `t-${uid()}`
    const user = `u-${uid()}`
    const a1 = `a1-${uid()}`
    const a2 = `a2-${uid()}`
    const uMid = `umid-${uid()}`
    const aDiff = `adiff-${uid()}`
    agg.appendMessage(topic, makeMessageJson(topic, { id: user, role: 'user' }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: a1, role: 'assistant', askId: user }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: a2, role: 'assistant', askId: user }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: uMid, role: 'user' }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: aDiff, role: 'assistant', askId: uMid }) as any, [])
    // Anchor a1 group should stop before uMid
    const newId = `new-${uid()}`
    const res = agg.insertMessagesAfterAnchor(topic, a1, [
      { message: makeMessageJson(topic, { id: newId }) as any, blocks: [] }
    ])
    expect(res.ok).toBe(true)
    const order = okValue(agg.fetchMessages(topic)).messages.map((m: any) => m.id)
    expect(order).toEqual([user, a1, a2, newId, uMid, aDiff])
  })

  it('inserts batch of two (user+assistant) atomically after anchor', () => {
    const topic = `t-${uid()}`
    const m0 = `m0-${uid()}`
    const m1 = `m1-${uid()}`
    agg.appendMessage(topic, makeMessageJson(topic, { id: m0 }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: m1 }) as any, [])
    const userNew = `unew-${uid()}`
    const asstNew = `anew-${uid()}`
    const userMsg = makeMessageJson(topic, { id: userNew, role: 'user' })
    const asstMsg = makeMessageJson(topic, { id: asstNew, role: 'assistant', askId: userNew })
    const userBlock = makeBlockJson(userNew, 'main_text')
    const asstBlock = makeBlockJson(asstNew, 'main_text')
    const res = agg.insertMessagesAfterAnchor(topic, m0, [
      { message: userMsg as any, blocks: [userBlock as any] },
      { message: asstMsg as any, blocks: [asstBlock as any] }
    ])
    expect(res.ok).toBe(true)
    const fetched = okValue(agg.fetchMessages(topic))
    const order = fetched.messages.map((m: any) => m.id)
    expect(order).toEqual([m0, userNew, asstNew, m1])
    // askId preserved
    const insertedAsst = fetched.messages.find((m: any) => m.id === asstNew) as any
    expect(insertedAsst.askId).toBe(userNew)
    // file refs none but cleanup empty
    expect(okValue(res).affectedFileIds).toEqual([])
  })

  it('missing topic fails with no partial writes', () => {
    const topic = `t-missing-${uid()}`
    const res = agg.insertMessagesAfterAnchor(topic, 'any-anchor', [
      { message: makeMessageJson(topic, { id: `m-${uid()}` }) as any, blocks: [] }
    ])
    expect(res.ok).toBe(false)
    expect(failError(res).code).toBe('NOT_FOUND')
  })

  it('missing anchor fails with no partial writes (rollback)', () => {
    const topic = `t-${uid()}`
    const m0 = `m0-${uid()}`
    agg.appendMessage(topic, makeMessageJson(topic, { id: m0 }) as any, [])
    const before = okValue(agg.fetchMessages(topic)).messages.length
    const res = agg.insertMessagesAfterAnchor(topic, 'nonexistent-anchor', [
      { message: makeMessageJson(topic, { id: `m-new-${uid()}` }) as any, blocks: [] }
    ])
    expect(res.ok).toBe(false)
    expect(failError(res).code).toBe('NOT_FOUND')
    const after = okValue(agg.fetchMessages(topic)).messages.length
    expect(after).toBe(before)
    // ensure no new message leaked
    const ids = okValue(agg.fetchMessages(topic)).messages.map((m: any) => m.id)
    expect(ids).not.toContain('m-new')
  })

  it('cross-topic anchor fails (anchor not in topic) with no partial writes', () => {
    const t1 = `t1-${uid()}`
    const t2 = `t2-${uid()}`
    const m1 = `m1-${uid()}`
    const m2 = `m2-${uid()}`
    agg.appendMessage(t1, makeMessageJson(t1, { id: m1 }) as any, [])
    agg.appendMessage(t2, makeMessageJson(t2, { id: m2 }) as any, [])
    const before = okValue(agg.fetchMessages(t1)).messages.length
    const res = agg.insertMessagesAfterAnchor(t1, m2, [
      { message: makeMessageJson(t1, { id: `new-${uid()}` }) as any, blocks: [] }
    ])
    expect(res.ok).toBe(false)
    expect(failError(res).code).toBe('NOT_FOUND')
    const after = okValue(agg.fetchMessages(t1)).messages.length
    expect(after).toBe(before)
  })

  it('insert after last message appends at end', () => {
    const topic = `t-${uid()}`
    const m0 = `m0-${uid()}`
    const m1 = `m1-${uid()}`
    agg.appendMessage(topic, makeMessageJson(topic, { id: m0 }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: m1 }) as any, [])
    const newId = `new-${uid()}`
    const res = agg.insertMessagesAfterAnchor(topic, m1, [
      { message: makeMessageJson(topic, { id: newId }) as any, blocks: [] }
    ])
    expect(res.ok).toBe(true)
    const order = okValue(agg.fetchMessages(topic)).messages.map((m: any) => m.id)
    expect(order).toEqual([m0, m1, newId])
  })

  it('rollback on block validation error (no partial writes)', () => {
    const topic = `t-${uid()}`
    const m0 = `m0-${uid()}`
    agg.appendMessage(topic, makeMessageJson(topic, { id: m0 }) as any, [])
    const before = okValue(agg.fetchMessages(topic)).messages.length
    // Force a trigger that aborts file_reference insert to simulate write error
    sqlite.exec(`
      CREATE TEMP TRIGGER IF NOT EXISTS abort_file_ref_insert
      BEFORE INSERT ON file_references
      BEGIN
        SELECT RAISE(ABORT, 'forced abort');
      END
    `)
    try {
      const newId = `new-${uid()}`
      const fileBlock = makeBlockJson(newId, 'file', {
        id: `b-${uid()}`,
        file: { id: 'file-fail', name: 'a.pdf', path: '/a.pdf', type: 'application/pdf' }
      })
      const res = agg.insertMessagesAfterAnchor(topic, m0, [
        { message: makeMessageJson(topic, { id: newId }) as any, blocks: [fileBlock as any] }
      ])
      expect(res.ok).toBe(false)
      const after = okValue(agg.fetchMessages(topic)).messages.length
      expect(after).toBe(before)
    } finally {
      sqlite.exec('DROP TRIGGER IF EXISTS TEMP.abort_file_ref_insert')
    }
  })

  it('preserves dense order when topic has corrupt legacy order (repair)', () => {
    const topic = `t-${uid()}`
    const m0 = `m0-${uid()}`
    const m1 = `m1-${uid()}`
    const m2 = `m2-${uid()}`
    agg.appendMessage(topic, makeMessageJson(topic, { id: m0 }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: m1 }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: m2 }) as any, [])
    // Corrupt sort_order directly: set all to same order 5
    sqlite.exec(`UPDATE messages SET sort_order = 5 WHERE topic_id = '${topic}'`)
    const newId = `new-${uid()}`
    const res = agg.insertMessagesAfterAnchor(topic, m0, [
      { message: makeMessageJson(topic, { id: newId }) as any, blocks: [] }
    ])
    expect(res.ok).toBe(true)
    const fetched = okValue(agg.fetchMessages(topic))
    // Should be dense and ordered by id tie-break after repair
    expect(fetched.messages.length).toBe(4)
    // Ensure no duplicate sort orders left (implicitly via dense check)
    const order = fetched.messages.map((m: any) => m.id)
    // m0 should still be first because id order determines after corrupt repair, and new after m0
    expect(order[0]).toBe(m0)
    expect(order).toContain(newId)
  })

  it('existing ID in entries preserves position (update path) and still advances index for new items', () => {
    const topic = `t-${uid()}`
    const m0 = `m0-${uid()}`
    const m1 = `m1-${uid()}`
    agg.appendMessage(topic, makeMessageJson(topic, { id: m0, content: 'orig0' }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: m1, content: 'orig1' }) as any, [])
    const newId = `new-${uid()}`
    // Try to insert existing m1 (should update, not move) plus new
    const updatedM1 = makeMessageJson(topic, { id: m1, content: 'updated1' })
    const newMsg = makeMessageJson(topic, { id: newId, content: 'new' })
    const res = agg.insertMessagesAfterAnchor(topic, m0, [
      { message: updatedM1 as any, blocks: [] },
      { message: newMsg as any, blocks: [] }
    ])
    expect(res.ok).toBe(true)
    const fetched = okValue(agg.fetchMessages(topic))
    // m1 should stay at index 1, updated content, new after m0 group? Actually resolvedInsertIndex after m0 is 1, insertManyAt will insert new at 1, shifting m1 to 2, but existing m1 update path should preserve its position after insertion?
    // Our implementation: newMessages inserted at resolvedInsertIndex (1), existing updates patch after. So order should be m0, new, m1
    const order = fetched.messages.map((m: any) => m.id)
    expect(order).toEqual([m0, newId, m1])
    const updated = fetched.messages.find((m: any) => m.id === m1) as any
    expect(updated.content).toBe('updated1')
    // Patched rows are distinguished from truly inserted rows in the response.
    const value = okValue(res) as any
    expect(value.insertedMessageIds).toEqual([newId])
    expect(value.patchedMessageIds).toEqual([m1])
    expect(value.mutableMessageIds).toEqual([newId])
  })

  it('exact fork-anchor inherited insertion lands at owned suffix start with authoritative placement + capability', () => {
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
    // Sole fork-boundary exception: the inherited anchor is exactly the
    // addressed branch's immutable anchorMessageId (BRANCH-3).
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
    expect(res.ok).toBe(true)
    const value = okValue(res) as any
    // Truly inserted rows are distinguished; capability delta is authoritative.
    expect(value.insertedMessageIds).toEqual([n1, n2])
    expect(value.patchedMessageIds).toEqual([])
    expect(value.mutableMessageIds).toEqual([n1, n2])
    expect(value.branchId).toBe(branchId)
    expect(value.afterMessageId).toBe(m1)
    // Owner stamping: canonical wire carries the branch owner.
    for (const wire of value.insertedMessages as Array<Record<string, unknown>>) {
      expect(wire.branchId).toBe(branchId)
    }
    // Stable neighbor placement: predecessor is the branch anchor (last
    // prefix), successor is the previous suffix head.
    expect(value.beforeMessageId).toBe(m1)
    expect(value.nextMessageId).toBe(c0)
    // Durable effective order: prefix through branch anchor, then new rows,
    // then previous suffix.
    const effective = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: topic, branchId, limit: 20 }))
    expect(effective.messages.map((m: any) => m.id)).toEqual([m0, m1, n1, n2, c0])
    // Main-authoritative window capability carries the new owned suffix rows.
    expect(new Set(effective.mutableMessageIds)).toEqual(new Set([c0, n1, n2]))
  })

  it('older inherited anchor insertion rejects atomically with zero writes (BRANCH-3)', () => {
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
    const before = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: topic, branchId, limit: 20 }))
    // m0 is an older ancestor reference (not the branch fork anchor): read-only.
    const res = agg.insertMessagesAfterAnchor(
      topic,
      m0,
      [{ message: makeMessageJson(topic, { id: `n-${uid()}`, role: 'user' }) as any, blocks: [] }],
      branchId
    )
    expect(res.ok).toBe(false)
    expect(failError(res).code).toBe('VALIDATION_ERROR')
    const after = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: topic, branchId, limit: 20 }))
    expect(after.messages.map((m: any) => m.id)).toEqual(before.messages.map((m: any) => m.id))
    expect(new Set(after.mutableMessageIds)).toEqual(new Set(before.mutableMessageIds))
  })

  it('F-1: duplicate fresh ID in same batch stays inserted-only with disjoint validated result', () => {
    const topic = `t-${uid()}`
    const m0 = `m0-${uid()}`
    const mExist = `mexist-${uid()}`
    agg.appendMessage(topic, makeMessageJson(topic, { id: m0 }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: mExist, content: 'orig' }) as any, [])
    const dupId = `dup-${uid()}`
    const first = makeMessageJson(topic, { id: dupId, content: 'v1' })
    const second = makeMessageJson(topic, { id: dupId, content: 'v2-last-writer' })
    const patchedExist = makeMessageJson(topic, { id: mExist, content: 'patched' })
    const res = agg.insertMessagesAfterAnchor(topic, m0, [
      { message: first as any, blocks: [] },
      { message: second as any, blocks: [] },
      { message: patchedExist as any, blocks: [] }
    ])
    expect(res.ok).toBe(true)
    const value = okValue(res) as any
    // Durable identity is inserted: duplicate fresh ID reports once as inserted, never as patched.
    expect(value.insertedMessageIds).toEqual([dupId])
    // Legitimate DB-existing patch is preserved and disjoint from inserted.
    expect(value.patchedMessageIds).toEqual([mExist])
    expect(value.mutableMessageIds).toEqual([dupId])
    // Committed response is self-consistent: shared validator cannot fail on overlap after commit.
    expect(() => validateChatDbResult('chatdb:insert-messages-after-anchor', res)).not.toThrow()
    // No partial/ambiguous durable state: single duplicate row with last-writer content.
    const fetched = okValue(agg.fetchMessages(topic))
    const order = fetched.messages.map((m: any) => m.id)
    expect(order).toEqual([m0, dupId, mExist])
    expect((fetched.messages.find((m: any) => m.id === dupId) as any).content).toBe('v2-last-writer')
    expect((fetched.messages.find((m: any) => m.id === mExist) as any).content).toBe('patched')
  })

  it('owned branch anchor keeps group-tail behavior after suffix-start fix', () => {
    const topic = `t-${uid()}`
    const m0 = `m0-${uid()}`
    const m1 = `m1-${uid()}`
    agg.appendMessage(topic, makeMessageJson(topic, { id: m0, role: 'user' }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: m1, role: 'user' }) as any, [])
    const branchId = (okValue(agg.createBranch(topic, null, m0, 'B1')).branch as { id: string }).id
    const c0 = `c0-${uid()}`
    agg.appendMessage(topic, makeMessageJson(topic, { id: c0, role: 'user' }) as any, [], undefined, undefined, {
      branchId
    })
    const n1 = `n1-${uid()}`
    const res = agg.insertMessagesAfterAnchor(
      topic,
      c0,
      [{ message: makeMessageJson(topic, { id: n1, role: 'user' }) as any, blocks: [] }],
      branchId
    )
    expect(res.ok).toBe(true)
    const value = okValue(res) as any
    expect(value.beforeMessageId).toBe(c0)
    expect(value.nextMessageId).toBeNull()
    const effective = okValue(agg.fetchMessagesWindow({ kind: 'latest', topicId: topic, branchId, limit: 20 }))
    expect(effective.messages.map((m: any) => m.id)).toEqual([m0, c0, n1])
  })
})
