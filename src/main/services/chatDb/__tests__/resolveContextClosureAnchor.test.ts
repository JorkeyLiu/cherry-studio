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

describe('ChatDbAggregateService — resolve-context-closure anchor detail (metadata-only, all intents)', () => {
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

  it('anchor detail is accepted for every intent (no illegal-combination rejection)', () => {
    const topicId = `t-${uid()}`
    seedTurns(agg, topicId, ['u1'])
    const srcId = `t-${uid()}`
    seedTurns(agg, srcId, ['s1'])
    const cases: Array<Record<string, unknown>> = [
      { topicId, intent: 'establish', contextCount: 1, detail: 'anchor' },
      { topicId, intent: 'reanchor-default', contextCount: 1, detail: 'anchor' },
      { topicId, intent: 'move', groupKey: 'u1', detail: 'anchor' },
      { topicId, intent: 'move', messageId: 'u1', detail: 'anchor' },
      { topicId, intent: 'inherit', sourceTopicId: srcId, contextCount: 1, detail: 'anchor' }
    ]
    for (const req of cases) {
      const res = agg.resolveContextClosure(req as any)
      expect(res.ok).toBe(true)
      expect(() => validateChatDbResult('chatdb:resolve-context-closure', res)).not.toThrow()
      const v = okValue(res) as unknown as Record<string, unknown>
      expect(Object.keys(v).sort()).toEqual(['changed', 'resolvedAnchorGroupKey'])
    }
  })

  it('anchor move/inherit/reanchor-default perform no full-topic read and no blocks query', () => {
    const topicId = `t-${uid()}`
    seedTurns(agg, topicId, ['u1', 'u2', 'u3'])
    const srcId = `t-${uid()}`
    seedTurns(agg, srcId, ['s1', 's2', 's3', 's4'])
    const listSpy = vi.spyOn(MessagesRepository.prototype, 'listByTopic').mockImplementation(() => {
      throw new Error('listByTopic must not be called in anchor mode')
    })
    const blocksSpy = vi.spyOn(BlocksRepository.prototype, 'listByMessages').mockImplementation(() => {
      throw new Error('blocks must not be queried in anchor mode')
    })
    try {
      const requests: Array<Record<string, unknown>> = [
        { topicId, intent: 'reanchor-default', contextCount: 1, detail: 'anchor' },
        { topicId, intent: 'move', messageId: 'u2', detail: 'anchor' },
        { topicId, intent: 'move', groupKey: 'u2', detail: 'anchor' },
        {
          topicId,
          intent: 'inherit',
          sourceTopicId: srcId,
          sourceAnchorGroupKey: 's3',
          contextCount: 99,
          detail: 'anchor'
        },
        {
          topicId,
          intent: 'inherit',
          sourceTopicId: srcId,
          sourceAnchorGroupKey: 'ghost',
          contextCount: 1,
          detail: 'anchor'
        }
      ]
      for (const req of requests) {
        const res = agg.resolveContextClosure(req as any)
        expect(res.ok).toBe(true)
        const v = okValue(res) as unknown as Record<string, unknown>
        expect(Object.keys(v).sort()).toEqual(['changed', 'resolvedAnchorGroupKey'])
        expect('messages' in v).toBe(false)
        expect('blocks' in v).toBe(false)
        expect('closure' in v).toBe(false)
        expect(() => validateChatDbResult('chatdb:resolve-context-closure', res)).not.toThrow()
      }
      expect(listSpy).not.toHaveBeenCalled()
      expect(blocksSpy).not.toHaveBeenCalled()
    } finally {
      listSpy.mockRestore()
      blocksSpy.mockRestore()
    }
  })

  it('anchor parity with closure mode for reanchor-default / move / inherit', () => {
    const topicId = `t-${uid()}`
    seedTurns(agg, topicId, ['u1', 'u2', 'u3'])
    const srcId = `t-${uid()}`
    seedTurns(agg, srcId, ['s1', 's2', 's3', 's4'])
    const cases: Array<{ anchorReq: Record<string, unknown>; closureReq: Record<string, unknown> }> = [
      {
        anchorReq: { topicId, intent: 'reanchor-default', contextCount: 1, detail: 'anchor' },
        closureReq: { topicId, intent: 'reanchor-default', contextCount: 1 }
      },
      {
        anchorReq: { topicId, intent: 'reanchor-default', contextCount: null, detail: 'anchor' },
        closureReq: { topicId, intent: 'reanchor-default', contextCount: null }
      },
      {
        anchorReq: { topicId, intent: 'move', messageId: 'u2', detail: 'anchor' },
        closureReq: { topicId, intent: 'move', messageId: 'u2' }
      },
      {
        anchorReq: { topicId, intent: 'move', messageId: 'a-u2', detail: 'anchor' },
        closureReq: { topicId, intent: 'move', messageId: 'a-u2' }
      },
      {
        anchorReq: { topicId, intent: 'move', groupKey: 'u1', detail: 'anchor' },
        closureReq: { topicId, intent: 'move', groupKey: 'u1' }
      },
      {
        anchorReq: {
          topicId,
          intent: 'inherit',
          sourceTopicId: srcId,
          sourceAnchorGroupKey: 's3',
          contextCount: 99,
          detail: 'anchor'
        },
        closureReq: {
          topicId,
          intent: 'inherit',
          sourceTopicId: srcId,
          sourceAnchorGroupKey: 's3',
          contextCount: 99
        }
      },
      {
        anchorReq: {
          topicId,
          intent: 'inherit',
          sourceTopicId: srcId,
          sourceAnchorGroupKey: 's1',
          contextCount: 99,
          detail: 'anchor'
        },
        closureReq: {
          topicId,
          intent: 'inherit',
          sourceTopicId: srcId,
          sourceAnchorGroupKey: 's1',
          contextCount: 99
        }
      },
      {
        anchorReq: {
          topicId,
          intent: 'inherit',
          sourceTopicId: srcId,
          sourceAnchorGroupKey: 'ghost',
          contextCount: 1,
          detail: 'anchor'
        },
        closureReq: {
          topicId,
          intent: 'inherit',
          sourceTopicId: srcId,
          sourceAnchorGroupKey: 'ghost',
          contextCount: 1
        }
      }
    ]
    for (const { anchorReq, closureReq } of cases) {
      const closure = okValue(agg.resolveContextClosure({ ...(closureReq as any) })) as {
        resolvedAnchorGroupKey: string | null
        changed: boolean
      }
      const anchor = okValue(agg.resolveContextClosure({ ...(anchorReq as any) })) as {
        resolvedAnchorGroupKey: string | null
        changed: boolean
      }
      expect({ req: anchorReq, anchor }, `mismatch for ${JSON.stringify(anchorReq)}`).toEqual({
        req: anchorReq,
        anchor: { resolvedAnchorGroupKey: closure.resolvedAnchorGroupKey, changed: closure.changed }
      })
    }
  })

  it('anchor move/inherit preserve stale and error semantics (NOT_FOUND / validation)', () => {
    const topicId = `t-${uid()}`
    seedTurns(agg, topicId, ['u1'])
    // Missing message target is NOT_FOUND.
    const missing = agg.resolveContextClosure({ topicId, intent: 'move', messageId: 'nope', detail: 'anchor' })
    expect(missing.ok).toBe(false)
    expect(failCode(missing)).toBe(ERR_NOT_FOUND)
    // Ghost groupKey is NOT_FOUND.
    const ghost = agg.resolveContextClosure({ topicId, intent: 'move', groupKey: 'ghost', detail: 'anchor' })
    expect(ghost.ok).toBe(false)
    expect(failCode(ghost)).toBe(ERR_NOT_FOUND)
    // Ignored roles reject as validation.
    agg.appendMessage(topicId, makeMsg(topicId, 'tool-1', 'tool') as any, [])
    const ignored = agg.resolveContextClosure({ topicId, intent: 'move', messageId: 'tool-1', detail: 'anchor' })
    expect(ignored.ok).toBe(false)
    expect(failCode(ignored)).toBe(ERR_VALIDATION)
    // Missing source topic is NOT_FOUND; missing target topic is NOT_FOUND.
    const missingSource = agg.resolveContextClosure({
      topicId,
      intent: 'inherit',
      sourceTopicId: 'nope',
      contextCount: 1,
      detail: 'anchor'
    })
    expect(missingSource.ok).toBe(false)
    expect(failCode(missingSource)).toBe(ERR_NOT_FOUND)
    const missingTarget = agg.resolveContextClosure({
      topicId: 'nope',
      intent: 'inherit',
      sourceTopicId: topicId,
      contextCount: 1,
      detail: 'anchor'
    })
    expect(missingTarget.ok).toBe(false)
    expect(failCode(missingTarget)).toBe(ERR_NOT_FOUND)
    // Stale semantics: changed mirrors (resolved !== current).
    const same = okValue(
      agg.resolveContextClosure({
        topicId,
        intent: 'move',
        messageId: 'u1',
        currentAnchorGroupKey: 'u1',
        detail: 'anchor'
      })
    ) as { resolvedAnchorGroupKey: string | null; changed: boolean }
    expect(same.resolvedAnchorGroupKey).toBe('u1')
    expect(same.changed).toBe(false)
    const stale = okValue(
      agg.resolveContextClosure({
        topicId,
        intent: 'reanchor-default',
        contextCount: 1,
        currentAnchorGroupKey: 'ghost',
        detail: 'anchor'
      })
    ) as { resolvedAnchorGroupKey: string | null; changed: boolean }
    expect(stale.resolvedAnchorGroupKey).toBe('u1')
    expect(stale.changed).toBe(true)
  })

  it('anchor move groupKey resolves an assistant own-id to its askId turn key', () => {
    const topicId = `t-${uid()}`
    agg.appendMessage(topicId, makeMsg(topicId, 's1', 'system') as any, [makeBlock('s1') as any])
    agg.appendMessage(topicId, makeMsg(topicId, 'u1', 'user') as any, [makeBlock('u1') as any])
    agg.appendMessage(topicId, makeMsg(topicId, 'orphan', 'assistant', 'ghost-user') as any, [
      makeBlock('orphan') as any
    ])
    const closure = okValue(agg.resolveContextClosure({ topicId, intent: 'move', groupKey: 'orphan' })) as {
      resolvedAnchorGroupKey: string | null
    }
    const anchor = okValue(
      agg.resolveContextClosure({ topicId, intent: 'move', groupKey: 'orphan', detail: 'anchor' })
    ) as {
      resolvedAnchorGroupKey: string | null
      changed: boolean
    }
    expect(closure.resolvedAnchorGroupKey).toBe('ghost-user')
    expect(anchor.resolvedAnchorGroupKey).toBe(closure.resolvedAnchorGroupKey)
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

  it('establish normalizes a non-canonical assistant own-id to its askId turn key (anchor/closure parity)', () => {
    const topicId = `t-${uid()}`
    seedTurns(agg, topicId, ['u1', 'u2'])
    // a-u1 is an assistant own-id whose canonical turn key is its askId u1.
    // Closure first (full read allowed); spies guard the anchor call only.
    const closure = okValue(
      agg.resolveContextClosure({ topicId, intent: 'establish', contextCount: 1, currentAnchorGroupKey: 'a-u1' })
    ) as { resolvedAnchorGroupKey: string | null; changed: boolean }
    expect(closure.resolvedAnchorGroupKey).toBe('u1')
    expect(closure.changed).toBe(true)
    const listSpy = vi.spyOn(MessagesRepository.prototype, 'listByTopic').mockImplementation(() => {
      throw new Error('listByTopic must not be called in anchor mode')
    })
    const blocksSpy = vi.spyOn(BlocksRepository.prototype, 'listByMessages').mockImplementation(() => {
      throw new Error('blocks must not be queried in anchor mode')
    })
    try {
      const anchor = okValue(
        agg.resolveContextClosure({
          topicId,
          intent: 'establish',
          contextCount: 1,
          currentAnchorGroupKey: 'a-u1',
          detail: 'anchor'
        })
      ) as { resolvedAnchorGroupKey: string | null; changed: boolean }
      expect(anchor.resolvedAnchorGroupKey).toBe('u1')
      expect(anchor.changed).toBe(true)
      expect(anchor.resolvedAnchorGroupKey).toBe(closure.resolvedAnchorGroupKey)
      expect(anchor.changed).toBe(closure.changed)
      expect(listSpy).not.toHaveBeenCalled()
      expect(blocksSpy).not.toHaveBeenCalled()
      expect(() =>
        validateChatDbResult('chatdb:resolve-context-closure', { ok: true, value: anchor } as any)
      ).not.toThrow()
    } finally {
      listSpy.mockRestore()
      blocksSpy.mockRestore()
    }
  })

  it('inherit clamps a source index beyond the target turn count to the target last turn (anchor/closure parity, no full read)', () => {
    const targetId = `t-${uid()}`
    seedTurns(agg, targetId, ['u1', 'u2'])
    const sourceId = `t-${uid()}`
    seedTurns(agg, sourceId, ['s1', 's2', 's3', 's4'])
    // Source s4 is index 3; target has 2 turns so index 3 clamps to last turn u2.
    const closure = okValue(
      agg.resolveContextClosure({
        topicId: targetId,
        intent: 'inherit',
        sourceTopicId: sourceId,
        sourceAnchorGroupKey: 's4',
        contextCount: 1
      })
    ) as { resolvedAnchorGroupKey: string | null; changed: boolean }
    expect(closure.resolvedAnchorGroupKey).toBe('u2')
    // Stale-current closure baseline before spies (closure needs the full read).
    const closureStale = okValue(
      agg.resolveContextClosure({
        topicId: targetId,
        intent: 'inherit',
        sourceTopicId: sourceId,
        sourceAnchorGroupKey: 's4',
        contextCount: 1,
        currentAnchorGroupKey: 'u1'
      })
    ) as { resolvedAnchorGroupKey: string | null; changed: boolean }
    expect(closureStale.resolvedAnchorGroupKey).toBe('u2')
    expect(closureStale.changed).toBe(true)
    const listSpy = vi.spyOn(MessagesRepository.prototype, 'listByTopic').mockImplementation(() => {
      throw new Error('listByTopic must not be called in anchor mode')
    })
    const blocksSpy = vi.spyOn(BlocksRepository.prototype, 'listByMessages').mockImplementation(() => {
      throw new Error('blocks must not be queried in anchor mode')
    })
    try {
      const anchor = okValue(
        agg.resolveContextClosure({
          topicId: targetId,
          intent: 'inherit',
          sourceTopicId: sourceId,
          sourceAnchorGroupKey: 's4',
          contextCount: 1,
          detail: 'anchor'
        })
      ) as { resolvedAnchorGroupKey: string | null; changed: boolean }
      expect(anchor.resolvedAnchorGroupKey).toBe('u2')
      expect(anchor.resolvedAnchorGroupKey).toBe(closure.resolvedAnchorGroupKey)
      expect(anchor.changed).toBe(closure.changed)
      // Stale-current variant keeps the clamped key with changed:true.
      const anchorStale = okValue(
        agg.resolveContextClosure({
          topicId: targetId,
          intent: 'inherit',
          sourceTopicId: sourceId,
          sourceAnchorGroupKey: 's4',
          contextCount: 1,
          currentAnchorGroupKey: 'u1',
          detail: 'anchor'
        })
      ) as { resolvedAnchorGroupKey: string | null; changed: boolean }
      expect(anchorStale.resolvedAnchorGroupKey).toBe('u2')
      expect(anchorStale.changed).toBe(true)
      expect(anchorStale.changed).toBe(closureStale.changed)
      expect(listSpy).not.toHaveBeenCalled()
      expect(blocksSpy).not.toHaveBeenCalled()
    } finally {
      listSpy.mockRestore()
      blocksSpy.mockRestore()
    }
  })
})
