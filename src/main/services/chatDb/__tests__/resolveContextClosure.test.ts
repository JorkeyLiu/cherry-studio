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

  it('inherit maps in-range source index; out-of-range/missing falls back to CURRENT-contextCount default (never clamp)', () => {
    const src = `t-${uid()}`
    const dst = `t-${uid()}`
    seedTurns(agg, src, ['u1', 'u2', 'u3', 'u4'])
    seedTurns(agg, dst, ['v1', 'v2', 'v3'])
    // in-range: source u1 index 0 -> v1
    const inRange = agg.resolveContextClosure({
      topicId: dst,
      intent: 'inherit',
      sourceTopicId: src,
      sourceAnchorGroupKey: 'u1',
      contextCount: 99
    })
    expect(okValue(inRange).resolvedAnchorGroupKey).toBe('v1')
    // out-of-range: source u4 index 3 beyond 3-turn target. Old clamp would
    // give v3 (last); new fallback gives CURRENT-contextCount default:
    // N=2 -> index max(0,3-2)=1 -> v2; null -> first -> v1.
    const fallbackN2 = agg.resolveContextClosure({
      topicId: dst,
      intent: 'inherit',
      sourceTopicId: src,
      sourceAnchorGroupKey: 'u4',
      contextCount: 2
    })
    expect(okValue(fallbackN2).resolvedAnchorGroupKey).toBe('v2')
    const fallbackNull = agg.resolveContextClosure({
      topicId: dst,
      intent: 'inherit',
      sourceTopicId: src,
      sourceAnchorGroupKey: 'u4',
      contextCount: null
    })
    expect(okValue(fallbackNull).resolvedAnchorGroupKey).toBe('v1')
    // invalid source anchor -> target default (contextCount 1 -> v3)
    const fallback = agg.resolveContextClosure({
      topicId: dst,
      intent: 'inherit',
      sourceTopicId: src,
      sourceAnchorGroupKey: 'ghost',
      contextCount: 1
    })
    expect(okValue(fallback).resolvedAnchorGroupKey).toBe('v3')
  })

  it('inherit on a branch route falls back to CURRENT-contextCount default when the source index is outside the branch prefix', () => {
    const topicId = `t-${uid()}`
    seedTurns(agg, topicId, ['u1', 'u2', 'u3', 'u4', 'u5'])
    // Branch fork at u3: effective branch route holds the strict 3-turn
    // prefix u1..u3; source anchor u5 (index 4) is excluded from it.
    const branchId = okValue(agg.createBranch(topicId, null, 'u3', 'B-above')).branch.id
    // Old clamp would give u3 (last); new fallback: N=2 -> u2, null -> u1.
    const fallbackN2 = agg.resolveContextClosure({
      topicId,
      branchId,
      intent: 'inherit',
      sourceTopicId: topicId,
      sourceAnchorGroupKey: 'u5',
      contextCount: 2
    })
    expect(okValue(fallbackN2).resolvedAnchorGroupKey).toBe('u2')
    const fallbackNull = agg.resolveContextClosure({
      topicId,
      branchId,
      intent: 'inherit',
      sourceTopicId: topicId,
      sourceAnchorGroupKey: 'u5',
      contextCount: null
    })
    expect(okValue(fallbackNull).resolvedAnchorGroupKey).toBe('u1')
    // In-range control on the same branch: source u2 index 1 maps to u2.
    const inRange = agg.resolveContextClosure({
      topicId,
      branchId,
      intent: 'inherit',
      sourceTopicId: topicId,
      sourceAnchorGroupKey: 'u2',
      contextCount: 2
    })
    expect(okValue(inRange).resolvedAnchorGroupKey).toBe('u2')
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

  /** Message-level fold of one message (the live participation authority). */
  function foldMessage(topicId: string, messageId: string, folded = true, branchId?: string | null): void {
    okValue(agg.updateMessage(topicId, messageId, { folded } as any, branchId ? { branchId } : undefined))
  }

  it('fold parity: the resolver closure and the fetch closure derive the same participating counts and divider', () => {
    const topicId = `t-${uid()}`
    seedTurns(agg, topicId, ['u1', 'u2', 'u3', 'u4'])
    // The whole third turn is folded at message level: it stops participating,
    // and the default selection skips it instead of landing on it.
    foldMessage(topicId, 'u3')
    foldMessage(topicId, 'a-u3')

    const resolved = okValue(
      agg.resolveContextClosure({ topicId, intent: 'reanchor-default', contextCount: 2, detail: 'closure' })
    ) as unknown as ResolveContextClosureResponse
    // Participating turns are u1, u2 and u4: the last-2 default starts at u2.
    expect(resolved.resolvedAnchorGroupKey).toBe('u2')
    expect(resolved.closure.firstMessageId).toBe('u2')
    expect(resolved.closure.anchorGroupKey).toBe('u2')
    // Participating turns: 3 (turns 1, 2 and 4). Window = turns 2..4 → 2.
    expect(resolved.closure.totalTurnCount).toBe(3)
    expect(resolved.closure.selectedTurnCount).toBe(2)
    // Divider names the first PARTICIPATING row of the window (u2): turn 3 is
    // fully folded, so its hidden rows can never carry the divider.
    expect(resolved.closure.boundaryMessageId).toBe('u2')
    expect(resolved.closure.foldedMessageIds.sort()).toEqual(['a-u3', 'u3'])
    expect(() =>
      validateChatDbResult('chatdb:resolve-context-closure', { ok: true, value: resolved } as any)
    ).not.toThrow()

    // Same anchor through the other producer → identical participating shape.
    const fetched = okValue(agg.fetchContextClosure({ topicId, anchorGroupKey: 'u2' }))
    expect(fetched.closure.totalTurnCount).toBe(resolved.closure.totalTurnCount)
    expect(fetched.closure.selectedTurnCount).toBe(resolved.closure.selectedTurnCount)
    expect(fetched.closure.boundaryMessageId).toBe(resolved.closure.boundaryMessageId)
    expect(fetched.closure.firstMessageId).toBe(resolved.closure.firstMessageId)
    expect(fetched.closure.foldedMessageIds.sort()).toEqual(resolved.closure.foldedMessageIds)
    expect(() =>
      validateChatDbResult('chatdb:fetch-context-closure', { ok: true, value: fetched } as any)
    ).not.toThrow()

    // Unfolding restores the pre-fold participation (context restored in place).
    foldMessage(topicId, 'u3', false)
    foldMessage(topicId, 'a-u3', false)
    const expanded = okValue(agg.fetchContextClosure({ topicId, anchorGroupKey: 'u2' }))
    expect(expanded.closure.totalTurnCount).toBe(4)
    expect(expanded.closure.selectedTurnCount).toBe(3)
    expect(expanded.closure.boundaryMessageId).toBe('u2')
    expect(expanded.closure.foldedMessageIds).toEqual([])
  })

  it('default selection skips a folded middle turn: five raw turns resolve 3/4', () => {
    const topicId = `t-${uid()}`
    seedTurns(agg, topicId, ['u1', 'u2', 'u3', 'u4', 'u5'])
    foldMessage(topicId, 'u3')
    foldMessage(topicId, 'a-u3')
    const resolved = okValue(
      agg.resolveContextClosure({ topicId, intent: 'reanchor-default', contextCount: 3, detail: 'closure' })
    ) as unknown as ResolveContextClosureResponse
    // Participating turns are u1, u2, u4, u5: the last-3 default starts at u2.
    expect(resolved.resolvedAnchorGroupKey).toBe('u2')
    expect(resolved.closure.anchorGroupKey).toBe('u2')
    expect(resolved.closure.firstMessageId).toBe('u2')
    expect(resolved.closure.totalTurnCount).toBe(4)
    expect(resolved.closure.selectedTurnCount).toBe(3)
    expect(resolved.closure.boundaryMessageId).toBe('u2')
    expect(() =>
      validateChatDbResult('chatdb:resolve-context-closure', { ok: true, value: resolved } as any)
    ).not.toThrow()
  })

  it('default selection skips multiple and trailing folds; one flagged row folds its whole turn', () => {
    const topicId = `t-${uid()}`
    seedTurns(agg, topicId, ['u1', 'u2', 'u3', 'u4'])
    // Only the assistant row is flagged: read normalizes to the whole turn.
    foldMessage(topicId, 'a-u2')
    // Trailing fold.
    foldMessage(topicId, 'u4')
    foldMessage(topicId, 'a-u4')
    const resolved = okValue(
      agg.resolveContextClosure({ topicId, intent: 'reanchor-default', contextCount: 2, detail: 'closure' })
    ) as unknown as ResolveContextClosureResponse
    // Participating turns are u1, u3: the last-2 default starts at u1.
    expect(resolved.resolvedAnchorGroupKey).toBe('u1')
    expect(resolved.closure.foldedMessageIds.sort()).toEqual(['a-u2', 'a-u4', 'u2', 'u4'])
    expect(resolved.closure.totalTurnCount).toBe(2)
    expect(resolved.closure.selectedTurnCount).toBe(2)
    // Window covers all participating history: folding alone adds no divider.
    expect(resolved.closure.boundaryMessageId).toBeNull()
  })

  it('default selection with N beyond the participating count starts at the first participating turn', () => {
    const topicId = `t-${uid()}`
    seedTurns(agg, topicId, ['u1', 'u2', 'u3'])
    foldMessage(topicId, 'u1')
    foldMessage(topicId, 'a-u1')
    const resolved = okValue(
      agg.resolveContextClosure({ topicId, intent: 'reanchor-default', contextCount: 10, detail: 'closure' })
    ) as unknown as ResolveContextClosureResponse
    expect(resolved.resolvedAnchorGroupKey).toBe('u2')
    expect(resolved.closure.totalTurnCount).toBe(2)
    expect(resolved.closure.selectedTurnCount).toBe(2)
    expect(resolved.closure.boundaryMessageId).toBeNull()
  })

  it('all-folded and empty routes keep the degenerate default contract', () => {
    const topicId = `t-${uid()}`
    seedTurns(agg, topicId, ['u1', 'u2', 'u3', 'u4'])
    for (const id of ['u1', 'u2', 'u3', 'u4']) {
      foldMessage(topicId, id)
      foldMessage(topicId, `a-${id}`)
    }
    const resolved = okValue(
      agg.resolveContextClosure({ topicId, intent: 'reanchor-default', contextCount: 2, detail: 'closure' })
    ) as unknown as ResolveContextClosureResponse
    // No participating turn: the raw tail position is kept, and the window
    // still reports a coherent non-zero participation count.
    expect(resolved.resolvedAnchorGroupKey).toBe('u3')
    expect(resolved.closure.anchorGroupKey).toBe('u3')
    expect(resolved.closure.totalTurnCount).toBe(1)
    expect(resolved.closure.selectedTurnCount).toBe(1)
    expect(resolved.closure.boundaryMessageId).toBeNull()
    expect(resolved.closure.foldedMessageIds).toHaveLength(8)

    const emptyId = `t-${uid()}`
    agg.ensureTopic(emptyId, 'asst-1', 'empty')
    const empty = okValue(
      agg.resolveContextClosure({ topicId: emptyId, intent: 'reanchor-default', contextCount: 2, detail: 'closure' })
    ) as unknown as ResolveContextClosureResponse
    expect(empty.resolvedAnchorGroupKey).toBeNull()
    expect(empty.changed).toBe(false)
    expect(empty.closure.totalTurnCount).toBe(0)
  })

  it('anchor-only default and closure default agree on folded history; manual anchors are never recomputed', () => {
    const topicId = `t-${uid()}`
    seedTurns(agg, topicId, ['u1', 'u2', 'u3', 'u4'])
    foldMessage(topicId, 'u3')
    foldMessage(topicId, 'a-u3')

    const anchorOnly = okValue(
      agg.resolveContextClosure({ topicId, intent: 'reanchor-default', contextCount: 2, detail: 'anchor' })
    ) as unknown as ResolveContextClosureResponse
    expect(anchorOnly.resolvedAnchorGroupKey).toBe('u2')
    const closure = okValue(
      agg.resolveContextClosure({ topicId, intent: 'reanchor-default', contextCount: 2, detail: 'closure' })
    ) as unknown as ResolveContextClosureResponse
    expect(closure.resolvedAnchorGroupKey).toBe(anchorOnly.resolvedAnchorGroupKey)

    // Establish without an anchor lands on the same participating default.
    const est = okValue(
      agg.resolveContextClosure({ topicId, intent: 'establish', contextCount: 2, detail: 'anchor' })
    ) as unknown as ResolveContextClosureResponse
    expect(est.resolvedAnchorGroupKey).toBe('u2')
    // Unlimited context starts at the first participating turn.
    const all = okValue(
      agg.resolveContextClosure({ topicId, intent: 'reanchor-default', contextCount: null, detail: 'anchor' })
    ) as unknown as ResolveContextClosureResponse
    expect(all.resolvedAnchorGroupKey).toBe('u1')
    // A stored manual anchor is preserved even when its turn is folded.
    const kept = okValue(
      agg.resolveContextClosure({
        topicId,
        intent: 'establish',
        contextCount: 2,
        currentAnchorGroupKey: 'u3',
        detail: 'anchor'
      })
    ) as unknown as ResolveContextClosureResponse
    expect(kept.resolvedAnchorGroupKey).toBe('u3')
    expect(kept.changed).toBe(false)
  })

  it('branch-route default skips folds on the effective route in anchor-only and closure detail', () => {
    const topicId = `t-${uid()}`
    seedTurns(agg, topicId, ['u1', 'u2'])
    const b1 = okValue(agg.createBranch(topicId, null, 'a-u2', 'B1')).branch.id
    agg.appendMessage(topicId, makeMsg(topicId, 'bu', 'user') as any, [makeBlock('bu') as any], undefined, undefined, {
      branchId: b1
    })
    agg.appendMessage(
      topicId,
      makeMsg(topicId, 'ba', 'assistant', 'bu') as any,
      [makeBlock('ba') as any],
      undefined,
      undefined,
      { branchId: b1 }
    )
    // Fold the branch-owned trailing turn: the effective route (u1, u2, bu)
    // has two participating turns, so the last-2 default starts at u1.
    foldMessage(topicId, 'bu', true, b1)
    foldMessage(topicId, 'ba', true, b1)

    const closure = okValue(
      agg.resolveContextClosure({
        topicId,
        branchId: b1,
        intent: 'reanchor-default',
        contextCount: 2,
        detail: 'closure'
      })
    ) as unknown as ResolveContextClosureResponse
    expect(closure.resolvedAnchorGroupKey).toBe('u1')
    expect(closure.closure.totalTurnCount).toBe(2)
    expect(closure.closure.selectedTurnCount).toBe(2)
    expect(closure.closure.boundaryMessageId).toBeNull()

    const anchorOnly = okValue(
      agg.resolveContextClosure({
        topicId,
        branchId: b1,
        intent: 'reanchor-default',
        contextCount: 2,
        detail: 'anchor'
      })
    ) as unknown as ResolveContextClosureResponse
    expect(anchorOnly.resolvedAnchorGroupKey).toBe(closure.resolvedAnchorGroupKey)
  })

  it('whole-topic snapshot carries the authority folded exclusion set', () => {
    const topicId = `t-${uid()}`
    seedTurns(agg, topicId, ['u1', 'u2'])
    foldMessage(topicId, 'u2')
    foldMessage(topicId, 'a-u2')
    const snapshot = okValue(agg.fetchWholeTopicSnapshot({ topicId }))
    expect(snapshot.snapshot.completeness).toBe('whole-topic')
    expect(snapshot.snapshot.foldedMessageIds.slice().sort()).toEqual(['a-u2', 'u2'])
    expect(() =>
      validateChatDbResult('chatdb:fetch-whole-topic-snapshot', { ok: true, value: snapshot } as any)
    ).not.toThrow()
    // Unfolding clears it again: the same read path reports no exclusions.
    foldMessage(topicId, 'u2', false)
    foldMessage(topicId, 'a-u2', false)
    expect(okValue(agg.fetchWholeTopicSnapshot({ topicId })).snapshot.foldedMessageIds).toEqual([])
  })
})
