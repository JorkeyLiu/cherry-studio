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
import { runMigrations } from '../migration'
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-branch-'))
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
function makeBlockJson(messageId: string, type: string, overrides?: Record<string, unknown>): Record<string, unknown> {
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

describe('branchMessagesToTopic — S6.2c-1 Main-authoritative anchor branch', () => {
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

  it('clones exact prefix through anchor inclusive, deterministic order', () => {
    const source = `t-src-${uid()}`
    const target = `t-dst-${uid()}`
    const msgs: string[] = []
    for (let i = 0; i < 5; i++) {
      const msg = makeMessageJson(source, { id: `m-${i}-${uid()}`, content: `msg-${i}` })
      msgs.push(msg.id as string)
      agg.appendMessage(source, msg as any, [
        makeBlockJson(msg.id as string, 'main_text', { content: `c-${i}` }) as any
      ])
    }
    // Branch at middle anchor (index 2)
    const anchor = msgs[2]
    const res = agg.branchMessagesToTopic(source, target, anchor, 'assistant-1')
    expect(res.ok).toBe(true)
    const { messages, blocks } = okValue(res)
    expect(messages.length).toBe(3)
    // Deterministic order preserved: first 3 ids in source order
    const sourceOrder = msgs.slice(0, 3)
    // Verify cloned messages content matches source prefix in order
    // Fetch target to confirm persistence
    const fetched = okValue(agg.fetchMessages(target))
    expect(fetched.messages.length).toBe(3)
    // IDs must be fresh
    for (const m of fetched.messages) {
      expect(sourceOrder).not.toContain(m.id)
    }
    // Content preserved in order
    for (let i = 0; i < 3; i++) {
      expect((fetched.messages[i] as any).content).toBe(`msg-${i}`)
    }
    // Response mirrors persisted
    expect(messages.length).toBe(fetched.messages.length)
    expect(blocks.length).toBe(fetched.blocks.length)
  })

  it('branch at last anchor clones full topic; branch at first clones single', () => {
    const source = `t-src-${uid()}`
    const target1 = `t-dst1-${uid()}`
    const target2 = `t-dst2-${uid()}`
    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      const msg = makeMessageJson(source, { id: `m-${i}-${uid()}` })
      ids.push(msg.id as string)
      agg.appendMessage(source, msg as any, [])
    }
    const full = agg.branchMessagesToTopic(source, target1, ids[3])
    expect(full.ok).toBe(true)
    expect(okValue(full).messages.length).toBe(4)
    const single = agg.branchMessagesToTopic(source, target2, ids[0])
    expect(single.ok).toBe(true)
    expect(okValue(single).messages.length).toBe(1)
  })

  it('remaps askId to cloned parent when included, otherwise unset (null)', () => {
    const source = `t-src-${uid()}`
    const targetIncluded = `t-dst-inc-${uid()}`
    const userId = `u-${uid()}`
    const asstId = `a-${uid()}`
    const outsideUser = `u-out-${uid()}`
    agg.appendMessage(source, makeMessageJson(source, { id: userId, role: 'user' }) as any, [])
    agg.appendMessage(source, makeMessageJson(source, { id: outsideUser, role: 'user' }) as any, [])
    // Assistant that references userId (included)
    agg.appendMessage(source, makeMessageJson(source, { id: asstId, role: 'assistant', askId: userId }) as any, [
      makeBlockJson(asstId, 'main_text') as any
    ])
    // Branch inclusive of assistant (full prefix includes userId)
    const resInc = agg.branchMessagesToTopic(source, targetIncluded, asstId)
    expect(resInc.ok).toBe(true)
    const fetchedInc = okValue(agg.fetchMessages(targetIncluded))
    const clonedAsstInc = fetchedInc.messages.find((m: any) => m.role === 'assistant')
    expect(clonedAsstInc).toBeDefined()
    const clonedUserId = fetchedInc.messages.find(
      (m: any) => m.role === 'user' && m.content === 'Hello' && fetchedInc.messages.indexOf(m) === 0
    )?.id
    // AskId should be remapped to cloned user id, not original
    expect((clonedAsstInc as any).askId).toBe(clonedUserId)
    expect((clonedAsstInc as any).askId).not.toBe(userId)

    // Create a source where assistant's askId is outside the prefix (branch before its parent)
    const source2 = `t-src2-${uid()}`
    const target2 = `t-dst2-${uid()}`
    const u2 = `u2-${uid()}`
    // Order: u2, then a2 referencing outside askId (simulate by using askId that is not in source prefix due to being earlier but we branch at u2 only)
    // Instead branch at u2, assistant not included, so askId outside case is tested by branching at earlier message where later assistant not cloned
    // For outside askId inclusion, create source where assistant exists but we branch before its askId parent (parent not in prefix)
    const lonelyUser = `u-alone-${uid()}`
    const lonelyAsst = `a-alone-${uid()}`
    agg.appendMessage(source2, makeMessageJson(source2, { id: lonelyUser, role: 'user' }) as any, [])
    agg.appendMessage(source2, makeMessageJson(source2, { id: u2, role: 'user' }) as any, [])
    // Assistant whose askId points to lonelyUser, but we will branch at u2 (which is after lonelyUser but assistant askId is lonelyUser -> included? need outside)
    // To get outside, create assistant referencing a non-prefix id
    agg.appendMessage(
      source2,
      makeMessageJson(source2, { id: lonelyAsst, role: 'assistant', askId: 'nonexistent-parent' }) as any,
      []
    )
    const resOutsideAsk = agg.branchMessagesToTopic(source2, target2, lonelyAsst)
    expect(resOutsideAsk.ok).toBe(true)
    const fetchedOutsideAsk = okValue(agg.fetchMessages(target2))
    const clonedLonelyAsst = fetchedOutsideAsk.messages.find((m: any) => m.id !== lonelyUser && m.role === 'assistant')
    // askId should be unset (null)
    expect((clonedLonelyAsst as any).askId === null || (clonedLonelyAsst as any).askId === undefined).toBe(true)
  })

  it('clones blocks with fresh IDs preserving order/content and file references', () => {
    const source = `t-src-${uid()}`
    const target = `t-dst-${uid()}`
    const msgId = `m-${uid()}`
    const blk1 = makeBlockJson(msgId, 'main_text', { id: `b1-${uid()}`, content: 'hello world', status: 'success' })
    const blk2 = makeBlockJson(msgId, 'file', {
      id: `b2-${uid()}`,
      file: { id: 'file-1', name: 'a.pdf', path: '/a.pdf', type: 'application/pdf' }
    })
    agg.appendMessage(source, makeMessageJson(source, { id: msgId }) as any, [blk1 as any, blk2 as any])
    const res = agg.branchMessagesToTopic(source, target, msgId)
    expect(res.ok).toBe(true)
    const fetched = okValue(agg.fetchMessages(target))
    expect(fetched.blocks.length).toBe(2)
    // Fresh IDs
    expect(fetched.blocks.map((b: any) => b.id)).not.toContain(blk1.id)
    expect(fetched.blocks.map((b: any) => b.id)).not.toContain(blk2.id)
    // Order preserved
    expect((fetched.blocks[0] as any).content).toBe('hello world')
    // File reference cloned
    const fileRefs = agg.listFileRefsByFile('file-1')
    expect(fileRefs.ok).toBe(true)
    expect(okValue(fileRefs).length).toBeGreaterThanOrEqual(1)
    expect(okValue(fileRefs).some((r: any) => r.fileId === 'file-1')).toBe(true)
  })

  it('IDs are fresh and askId remap deterministic', () => {
    const source = `t-src-${uid()}`
    const target = `t-dst-${uid()}`
    const u1 = `u-${uid()}`
    const a1 = `a-${uid()}`
    agg.appendMessage(source, makeMessageJson(source, { id: u1, role: 'user' }) as any, [])
    agg.appendMessage(source, makeMessageJson(source, { id: a1, role: 'assistant', askId: u1 }) as any, [])
    const res = agg.branchMessagesToTopic(source, target, a1)
    expect(res.ok).toBe(true)
    const fetched = okValue(agg.fetchMessages(target))
    const ids = fetched.messages.map((m: any) => m.id)
    expect(new Set(ids).size).toBe(2)
    expect(ids).not.toContain(u1)
    expect(ids).not.toContain(a1)
    const clonedA = fetched.messages.find((m: any) => m.role === 'assistant') as any
    const clonedU = fetched.messages.find((m: any) => m.role === 'user') as any
    expect(clonedA.askId).toBe(clonedU.id)
  })

  it('missing anchor fails with no partial target writes (rollback)', () => {
    const source = `t-src-${uid()}`
    const target = `t-dst-${uid()}`
    const msg = makeMessageJson(source, { id: `m-${uid()}` })
    agg.appendMessage(source, msg as any, [])
    // Pre-seed target with one message to detect partial writes
    const preMsg = makeMessageJson(target, { id: `pre-${uid()}` })
    // Ensure target exists via branch ensure then add pre message? Use append instead
    agg.appendMessage(target, preMsg as any, [])
    const before = okValue(agg.fetchMessages(target)).messages.length
    const res = agg.branchMessagesToTopic(source, target, 'nonexistent-anchor')
    expect(res.ok).toBe(false)
    expect(failError(res).code).toBe('NOT_FOUND')
    const after = okValue(agg.fetchMessages(target)).messages.length
    expect(after).toBe(before) // no partial writes
    // also ensure target not created when source missing? but we already have rollback
  })

  it('cross-topic anchor fails with no partial writes', () => {
    const source = `t-src-${uid()}`
    const other = `t-other-${uid()}`
    const target = `t-dst-${uid()}`
    const otherMsg = makeMessageJson(other, { id: `m-other-${uid()}` })
    agg.appendMessage(other, otherMsg as any, [])
    const srcMsg = makeMessageJson(source, { id: `m-src-${uid()}` })
    agg.appendMessage(source, srcMsg as any, [])
    const res = agg.branchMessagesToTopic(source, target, otherMsg.id as string)
    expect(res.ok).toBe(false)
    expect(failError(res).code).toBe('NOT_FOUND')
    // target should be empty or not created with messages (ensure creates empty topic, but no messages)
    const fetched = okValue(agg.fetchMessages(target))
    // Since we called ensure, topic exists but has zero messages
    expect(fetched.messages.length).toBe(0)
  })

  it('source topic missing fails explicitly', () => {
    const res = agg.branchMessagesToTopic('missing-source', `t-dst-${uid()}`, 'any-anchor')
    expect(res.ok).toBe(false)
    expect(failError(res).code).toBe('NOT_FOUND')
  })

  it('returns wire messages/blocks without completeness/window claim and no second read needed', () => {
    const source = `t-src-${uid()}`
    const target = `t-dst-${uid()}`
    const msg = makeMessageJson(source, { id: `m-${uid()}` })
    agg.appendMessage(source, msg as any, [makeBlockJson(msg.id as string, 'main_text', { content: 'c' }) as any])
    const res = agg.branchMessagesToTopic(source, target, msg.id as string)
    expect(res.ok).toBe(true)
    const val = okValue(res) as any
    expect(val.messages).toBeDefined()
    expect(val.blocks).toBeDefined()
    expect(val.window).toBeUndefined()
    expect(val.completeness).toBeUndefined()
    // Validate shape via wireAdapters: messages have blocks arrays of new ids
    expect(Array.isArray(val.messages)).toBe(true)
    expect(Array.isArray(val.blocks)).toBe(true)
  })
})
