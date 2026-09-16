import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

vi.mock('@main/config', () => ({ DATA_PATH: '/mock/data' }))
const { mockCleanTopic } = vi.hoisted(() => ({ mockCleanTopic: vi.fn() }))
vi.mock('../../SpanCacheService', () => ({ spanCacheService: { cleanTopic: mockCleanTopic } }))

import type { ResolveContextClosureResponse } from '@shared/chatDb'
import { ERR_NOT_FOUND, ERR_VALIDATION, isSuccess, validateChatDbResult } from '@shared/chatDb'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { runMigrations } from '../migration'
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-resolve-'))
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
  return `r${++counter}-${Date.now()}`
}
function okValue<T>(r: { ok: boolean; value?: T; error?: unknown }): T {
  if (!isSuccess(r as any)) throw new Error(`Expected success: ${JSON.stringify((r as any).error)}`)
  return (r as any).value as T
}
function failCode(r: { ok: boolean; error?: { code?: string } }): string {
  return (r as any).error.code as string
}
function makeMsg(topicId: string, id: string, role: 'user' | 'assistant' | 'system', askId?: string | null) {
  const base: Record<string, unknown> = {
    id,
    topicId,
    role,
    content: `${role}-${id}`,
    status: 'success',
    createdAt: new Date().toISOString()
  }
  if (askId !== undefined) base.askId = askId
  return base
}
function makeBlock(messageId: string) {
  return {
    id: `b-${uid()}`,
    messageId,
    type: 'main_text',
    content: `block-${messageId}`,
    status: 'success',
    createdAt: new Date().toISOString()
  }
}
function seedTurns(agg: ChatDbAggregateService, topicId: string, ids: string[]) {
  for (const id of ids) {
    const u = makeMsg(topicId, id, 'user')
    agg.appendMessage(topicId, u as any, [makeBlock(id) as any])
    const aId = `a-${id}`
    const a = makeMsg(topicId, aId, 'assistant', id)
    agg.appendMessage(topicId, a as any, [makeBlock(aId) as any])
  }
}

describe('ChatDbAggregateService — resolve-context-closure authority resolver', () => {
  let tmpDir: string
  let sqlite: Database.Database
  let db: BetterSQLite3Database<typeof schema>
  let agg: ChatDbAggregateService

  beforeEach(() => {
    tmpDir = makeTempDir()
    sqlite = openTestDb(realPath.join(tmpDir, 'test.db'))
    db = wrapDrizzle(sqlite)
    runMigrations(db, sqlite)
    agg = new ChatDbAggregateService(db, sqlite)
    mockCleanTopic.mockReset().mockResolvedValue(undefined)
  })
  afterEach(() => {
    try {
      sqlite.close()
    } catch {}
    rmrf(tmpDir)
  })

  it('establish preserves a valid current anchor', () => {
    const topicId = `t-${uid()}`
    seedTurns(agg, topicId, ['u1', 'u2', 'u3'])
    const res = agg.resolveContextClosure({
      topicId,
      intent: 'establish',
      contextCount: 1,
      currentAnchorGroupKey: 'u1'
    })
    expect(res.ok).toBe(true)
    const v = okValue(res) as unknown as ResolveContextClosureResponse
    expect(v.resolvedAnchorGroupKey).toBe('u1')
    expect(v.changed).toBe(false)
    expect(v.closure.anchorGroupKey).toBe('u1')
    expect(v.closure.totalTurnCount).toBe(3)
    expect(v.closure.selectedTurnCount).toBe(3)
    expect(v.closure.boundaryMessageId).toBeNull()
    expect(() => validateChatDbResult('chatdb:resolve-context-closure', res)).not.toThrow()
  })

  it('establish repairs a ghost to the default index (null=>0, N=>max(0,total-max(1,floor(N))))', () => {
    const topicId = `t-${uid()}`
    seedTurns(agg, topicId, ['u1', 'u2', 'u3'])
    const res = agg.resolveContextClosure({
      topicId,
      intent: 'establish',
      contextCount: 2,
      currentAnchorGroupKey: 'ghost'
    })
    const v = okValue(res) as unknown as ResolveContextClosureResponse
    expect(v.resolvedAnchorGroupKey).toBe('u2')
    expect(v.changed).toBe(true)
    expect(v.closure.selectedTurnCount).toBe(2)
    // null => 0 (whole topic)
    const resNull = agg.resolveContextClosure({
      topicId,
      intent: 'establish',
      contextCount: null,
      currentAnchorGroupKey: 'ghost'
    })
    expect(okValue(resNull).resolvedAnchorGroupKey).toBe('u1')
  })

  it('reanchor-default always resolves to default even when current is valid', () => {
    const topicId = `t-${uid()}`
    seedTurns(agg, topicId, ['u1', 'u2', 'u3'])
    const res = agg.resolveContextClosure({
      topicId,
      intent: 'reanchor-default',
      contextCount: 1,
      currentAnchorGroupKey: 'u1'
    })
    const v = okValue(res)
    expect(v.resolvedAnchorGroupKey).toBe('u3')
    expect(v.changed).toBe(true)
  })

  it('move by messageId resolves user and assistant askId-or-own turns; groupKey resolves canonically', () => {
    const topicId = `t-${uid()}`
    seedTurns(agg, topicId, ['u1', 'u2'])
    // assistant message a-u2 belongs to u2 turn
    const byAssistant = agg.resolveContextClosure({ topicId, intent: 'move', messageId: 'a-u2' })
    expect(okValue(byAssistant).resolvedAnchorGroupKey).toBe('u2')
    const byGroup = agg.resolveContextClosure({ topicId, intent: 'move', groupKey: 'u1' })
    expect(okValue(byGroup).resolvedAnchorGroupKey).toBe('u1')
    expect(() => validateChatDbResult('chatdb:resolve-context-closure', byAssistant)).not.toThrow()
  })

  it('move rejects ignored roles as validation and missing targets as NOT_FOUND', () => {
    const topicId = `t-${uid()}`
    seedTurns(agg, topicId, ['u1'])
    const missing = agg.resolveContextClosure({ topicId, intent: 'move', messageId: 'nope' })
    expect(missing.ok).toBe(false)
    expect(failCode(missing)).toBe(ERR_NOT_FOUND)
    const ghostGroup = agg.resolveContextClosure({ topicId, intent: 'move', groupKey: 'ghost' })
    expect(ghostGroup.ok).toBe(false)
    expect(failCode(ghostGroup)).toBe(ERR_NOT_FOUND)
    // Insert an ignored-role row directly to prove validation rejection
    const toolMsg = {
      id: 'tool-1',
      topicId,
      role: 'tool',
      content: 'x',
      status: 'success',
      createdAt: new Date().toISOString()
    }
    agg.appendMessage(topicId, toolMsg as any, [])
    const ignored = agg.resolveContextClosure({ topicId, intent: 'move', messageId: 'tool-1' })
    expect(ignored.ok).toBe(false)
    expect(failCode(ignored)).toBe(ERR_VALIDATION)
  })

  it('inherit maps valid source index with clamp; invalid source uses target default', () => {
    const src = `t-${uid()}`
    const dst = `t-${uid()}`
    seedTurns(agg, src, ['u1', 'u2', 'u3', 'u4'])
    seedTurns(agg, dst, ['v1', 'v2'])
    // source u3 is index 2; target has 2 turns -> clamp to last (v2)
    const clamped = agg.resolveContextClosure({
      topicId: dst,
      intent: 'inherit',
      sourceTopicId: src,
      sourceAnchorGroupKey: 'u3',
      contextCount: 99
    })
    expect(okValue(clamped).resolvedAnchorGroupKey).toBe('v2')
    // in-range: source u1 index 0 -> v1
    const inRange = agg.resolveContextClosure({
      topicId: dst,
      intent: 'inherit',
      sourceTopicId: src,
      sourceAnchorGroupKey: 'u1',
      contextCount: 99
    })
    expect(okValue(inRange).resolvedAnchorGroupKey).toBe('v1')
    // invalid source anchor -> target default (contextCount 1 -> v2)
    const fallback = agg.resolveContextClosure({
      topicId: dst,
      intent: 'inherit',
      sourceTopicId: src,
      sourceAnchorGroupKey: 'ghost',
      contextCount: 1
    })
    expect(okValue(fallback).resolvedAnchorGroupKey).toBe('v2')
  })

  it('missing source/target topics are NOT_FOUND; existing empty target succeeds null', () => {
    const src = `t-${uid()}`
    seedTurns(agg, src, ['u1'])
    const missingTarget = agg.resolveContextClosure({ topicId: 'nope', intent: 'establish', contextCount: 2 })
    expect(missingTarget.ok).toBe(false)
    expect(failCode(missingTarget)).toBe(ERR_NOT_FOUND)
    const missingSource = agg.resolveContextClosure({
      topicId: src,
      intent: 'inherit',
      sourceTopicId: 'nope',
      contextCount: 2
    })
    expect(missingSource.ok).toBe(false)
    expect(failCode(missingSource)).toBe(ERR_NOT_FOUND)
    // empty existing target
    const emptyId = `t-${uid()}`
    agg.ensureTopic(emptyId, 'asst-1', 'empty')
    const empty = agg.resolveContextClosure({
      topicId: emptyId,
      intent: 'establish',
      contextCount: 2,
      currentAnchorGroupKey: 'u1'
    })
    expect(empty.ok).toBe(true)
    const v = okValue(empty) as unknown as ResolveContextClosureResponse
    expect(v.resolvedAnchorGroupKey).toBeNull()
    expect(v.changed).toBe(true)
    expect(v.closure.totalTurnCount).toBe(0)
    expect(() => validateChatDbResult('chatdb:resolve-context-closure', empty)).not.toThrow()
    // empty with no current anchor -> changed false
    const emptyClean = agg.resolveContextClosure({ topicId: emptyId, intent: 'establish', contextCount: 2 })
    expect(okValue(emptyClean).changed).toBe(false)
  })

  it('same-snapshot closure counts and boundary match the resolved anchor', () => {
    const topicId = `t-${uid()}`
    seedTurns(agg, topicId, ['u1', 'u2', 'u3'])
    const v = okValue(
      agg.resolveContextClosure({ topicId, intent: 'establish', contextCount: 2 })
    ) as unknown as ResolveContextClosureResponse
    expect(v.closure.totalTurnCount).toBe(3)
    expect(v.closure.selectedTurnCount).toBe(2)
    expect(v.closure.boundaryMessageId).toBe(v.closure.firstMessageId)
    expect(v.closure.returnedCount).toBe(v.messages.length)
  })
})
