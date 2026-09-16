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

import { ERR_NOT_FOUND, ERR_VALIDATION, isSuccess, validateChatDbResult } from '@shared/chatDb'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { runMigrations } from '../migration'
import { BlocksRepository } from '../repository/BlocksRepository'
import { MessagesRepository } from '../repository/MessagesRepository'
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-anchor-'))
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
function okValue<T>(r: { ok: boolean; value?: T; error?: unknown }): T {
  if (!isSuccess(r as any)) throw new Error(`Expected success: ${JSON.stringify((r as any).error)}`)
  return (r as any).value as T
}
function failCode(r: { ok: boolean; error?: { code?: string } }): string {
  return (r as any).error.code as string
}
function makeMsg(topicId: string, id: string, role: string, askId?: string | null) {
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
    agg.appendMessage(topicId, makeMsg(topicId, id, 'user') as any, [makeBlock(id) as any])
    agg.appendMessage(topicId, makeMsg(topicId, `a-${id}`, 'assistant', id) as any, [makeBlock(`a-${id}`) as any])
  }
}

describe('ChatDbAggregateService — resolve-context-closure anchor detail (metadata-only establish)', () => {
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
    vi.restoreAllMocks()
  })

  it('anchor mode performs no full-topic read, no blocks query, and returns only anchor keys', () => {
    const topicId = `t-${uid()}`
    seedTurns(agg, topicId, ['u1', 'u2', 'u3'])
    const listSpy = vi.spyOn(MessagesRepository.prototype, 'listByTopic').mockImplementation(() => {
      throw new Error('listByTopic must not be called in anchor mode')
    })
    const blocksSpy = vi.spyOn(BlocksRepository.prototype, 'listByMessages').mockImplementation(() => {
      throw new Error('blocks must not be queried in anchor mode')
    })
    try {
      const res = agg.resolveContextClosure({
        topicId,
        intent: 'establish',
        contextCount: 2,
        currentAnchorGroupKey: 'ghost',
        detail: 'anchor'
      })
      expect(res.ok).toBe(true)
      const v = okValue(res) as unknown as Record<string, unknown>
      expect(Object.keys(v).sort()).toEqual(['changed', 'resolvedAnchorGroupKey'])
      expect(v.resolvedAnchorGroupKey).toBe('u2')
      expect(v.changed).toBe(true)
      expect(listSpy).not.toHaveBeenCalled()
      expect(blocksSpy).not.toHaveBeenCalled()
      expect(() => validateChatDbResult('chatdb:resolve-context-closure', res)).not.toThrow()
    } finally {
      listSpy.mockRestore()
      blocksSpy.mockRestore()
    }
  })

  it('anchor detail is rejected for non-establish intents', () => {
    const topicId = `t-${uid()}`
    seedTurns(agg, topicId, ['u1'])
    for (const intent of ['reanchor-default', 'move', 'inherit'] as const) {
      const req: Record<string, unknown> = { topicId, intent, detail: 'anchor' }
      if (intent === 'reanchor-default') req.contextCount = 1
      if (intent === 'move') req.groupKey = 'u1'
      if (intent === 'inherit') {
        req.sourceTopicId = topicId
        req.contextCount = 1
      }
      const res = agg.resolveContextClosure(req as any)
      expect(res.ok).toBe(false)
      expect(failCode(res)).toBe(ERR_VALIDATION)
    }
  })

  it('missing topic is NOT_FOUND in anchor mode; empty topic resolves null', () => {
    const missing = agg.resolveContextClosure({
      topicId: 'nope',
      intent: 'establish',
      contextCount: 2,
      detail: 'anchor'
    })
    expect(missing.ok).toBe(false)
    expect(failCode(missing)).toBe(ERR_NOT_FOUND)
    const emptyId = `t-${uid()}`
    agg.ensureTopic(emptyId, 'asst-1', 'empty')
    const empty = agg.resolveContextClosure({
      topicId: emptyId,
      intent: 'establish',
      contextCount: 2,
      currentAnchorGroupKey: 'u1',
      detail: 'anchor'
    })
    expect(empty.ok).toBe(true)
    expect(okValue(empty)).toEqual({ resolvedAnchorGroupKey: null, changed: true })
    const emptyClean = agg.resolveContextClosure({
      topicId: emptyId,
      intent: 'establish',
      contextCount: 2,
      detail: 'anchor'
    })
    expect(okValue(emptyClean)).toEqual({ resolvedAnchorGroupKey: null, changed: false })
  })

  it.each([
    { name: 'valid anchor preserved (finite)', contextCount: 1, current: 'u1' },
    { name: 'ghost repaired (finite)', contextCount: 2, current: 'ghost' },
    { name: 'ghost repaired (null count)', contextCount: null, current: 'ghost' },
    { name: 'no current (finite)', contextCount: 2, current: undefined },
    { name: 'no current (null count)', contextCount: null, current: undefined }
  ])('parity with closure mode: $name', ({ contextCount, current }) => {
    const topicId = `t-${uid()}`
    seedTurns(agg, topicId, ['u1', 'u2', 'u3'])
    const base: Record<string, unknown> = { topicId, intent: 'establish', contextCount }
    if (current !== undefined) base.currentAnchorGroupKey = current
    const closure = okValue(agg.resolveContextClosure({ ...(base as any) })) as {
      resolvedAnchorGroupKey: string | null
      changed: boolean
    }
    const anchor = okValue(agg.resolveContextClosure({ ...(base as any), detail: 'anchor' })) as {
      resolvedAnchorGroupKey: string | null
      changed: boolean
    }
    expect(anchor.resolvedAnchorGroupKey).toBe(closure.resolvedAnchorGroupKey)
    expect(anchor.changed).toBe(closure.changed)
  })

  it('parity with unusual roles and group shapes', () => {
    const topicId = `t-${uid()}`
    // system turn, user turn with two assistants sharing askId, orphan
    // assistant (ghost askId), assistant without askId (own turn), ignored tool row.
    agg.appendMessage(topicId, makeMsg(topicId, 's1', 'system') as any, [makeBlock('s1') as any])
    agg.appendMessage(topicId, makeMsg(topicId, 'u1', 'user') as any, [makeBlock('u1') as any])
    agg.appendMessage(topicId, makeMsg(topicId, 'a1', 'assistant', 'u1') as any, [makeBlock('a1') as any])
    agg.appendMessage(topicId, makeMsg(topicId, 'a2', 'assistant', 'u1') as any, [makeBlock('a2') as any])
    agg.appendMessage(topicId, makeMsg(topicId, 'orphan', 'assistant', 'ghost-user') as any, [
      makeBlock('orphan') as any
    ])
    agg.appendMessage(topicId, makeMsg(topicId, 'solo', 'assistant') as any, [makeBlock('solo') as any])
    agg.appendMessage(topicId, makeMsg(topicId, 'tool-1', 'tool') as any, [])
    agg.appendMessage(topicId, makeMsg(topicId, 'u2', 'user') as any, [makeBlock('u2') as any])
    const cases: Array<{ contextCount: number | null; current?: string }> = [
      { contextCount: null },
      { contextCount: 1 },
      { contextCount: 2 },
      { contextCount: 99 },
      { contextCount: 1, current: 'u1' },
      { contextCount: 99, current: 'u1' },
      { contextCount: 1, current: 'ghost-user' },
      { contextCount: 1, current: 'solo' },
      { contextCount: 1, current: 's1' },
      { contextCount: 1, current: 'tool-1' },
      { contextCount: 1, current: 'ghost' }
    ]
    for (const c of cases) {
      const base: Record<string, unknown> = { topicId, intent: 'establish', contextCount: c.contextCount }
      if (c.current !== undefined) base.currentAnchorGroupKey = c.current
      const closure = okValue(agg.resolveContextClosure({ ...(base as any) })) as {
        resolvedAnchorGroupKey: string | null
        changed: boolean
      }
      const anchor = okValue(agg.resolveContextClosure({ ...(base as any), detail: 'anchor' })) as {
        resolvedAnchorGroupKey: string | null
        changed: boolean
      }
      expect(
        { case: c, anchor },
        `mismatch for contextCount=${String(c.contextCount)} current=${c.current ?? '<absent>'}`
      ).toEqual({
        case: c,
        anchor: { resolvedAnchorGroupKey: closure.resolvedAnchorGroupKey, changed: closure.changed }
      })
    }
  })

  it('topics with only ignored roles resolve null in both modes', () => {
    const topicId = `t-${uid()}`
    agg.appendMessage(topicId, makeMsg(topicId, 'tool-1', 'tool') as any, [])
    agg.appendMessage(topicId, makeMsg(topicId, 'tool-2', 'tool') as any, [])
    const closure = okValue(agg.resolveContextClosure({ topicId, intent: 'establish', contextCount: 2 }))
    const anchor = okValue(
      agg.resolveContextClosure({ topicId, intent: 'establish', contextCount: 2, detail: 'anchor' })
    )
    expect(closure.resolvedAnchorGroupKey).toBeNull()
    expect(anchor.resolvedAnchorGroupKey).toBeNull()
    expect(anchor.changed).toBe(closure.changed)
  })
})
