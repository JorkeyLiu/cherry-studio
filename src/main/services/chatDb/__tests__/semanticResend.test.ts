import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { isSuccess } from '@shared/chatDb'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')
vi.mock('@main/config', () => ({ DATA_PATH: '/mock/data' }))
const { mockCleanTopic } = vi.hoisted(() => ({ mockCleanTopic: vi.fn() }))
vi.mock('../../SpanCacheService', () => ({ spanCacheService: { cleanTopic: mockCleanTopic } }))

import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { runMigrations } from '../migration'
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-sem-'))
}
function rmrf(dir: string): void {
  realFs.rmSync(dir, { recursive: true, force: true })
}
let counter = 0
function uid(): string {
  return `s${++counter}-${Date.now()}`
}
function okValue<T>(r: { ok: boolean; value?: T; error?: unknown }): T {
  if (!isSuccess(r as any)) throw new Error(`Expected success: ${JSON.stringify((r as any).error)}`)
  return (r as any).value as T
}
const MODEL_A = { id: 'model-a', provider: 'p', name: 'A', group: 'g' }
const MODEL_B = { id: 'model-b', provider: 'p', name: 'B', group: 'g' }
const MODEL_C = { id: 'model-c', provider: 'p', name: 'C', group: 'g' }

function userMsg(topicId: string, id: string, mentions?: unknown[]) {
  const base: Record<string, unknown> = {
    id,
    topicId,
    role: 'user',
    status: 'success',
    createdAt: new Date().toISOString(),
    blocks: []
  }
  if (mentions !== undefined) base.mentions = mentions as unknown as never
  return base
}
function asstMsg(topicId: string, id: string, askId: string, model: unknown, modelId?: string) {
  const m: Record<string, unknown> = {
    id,
    topicId,
    role: 'assistant',
    assistantId: 'as-1',
    askId,
    status: 'success',
    createdAt: new Date().toISOString(),
    model: model as never,
    blocks: []
  }
  if (modelId !== undefined) m.modelId = modelId
  return m
}
function blk(messageId: string, id: string) {
  return {
    id,
    messageId,
    type: 'main_text',
    content: `c-${id}`,
    status: 'success',
    createdAt: new Date().toISOString()
  }
}

describe('semantic resend/regenerate', () => {
  let tmpDir: string
  let sqlite: Database.Database
  let db: BetterSQLite3Database<typeof schema>
  let agg: ChatDbAggregateService
  beforeEach(() => {
    tmpDir = makeTempDir()
    sqlite = new Database(realPath.join(tmpDir, 't.db'))
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    db = drizzle(sqlite, { schema })
    runMigrations(db, sqlite)
    agg = new ChatDbAggregateService(db)
    mockCleanTopic.mockReset().mockResolvedValue(undefined)
  })
  afterEach(() => {
    try {
      sqlite.close()
    } catch {}
    rmrf(tmpDir)
  })

  function seedTopic(topicId: string) {
    agg.ensureTopic(topicId, 'as-1')
  }

  it('resend single no-mention resets to currentModel', () => {
    const t = `t-${uid()}`
    seedTopic(t)
    agg.appendMessage(t, userMsg(t, 'u1') as any, [blk('u1', 'bu1') as any])
    agg.appendMessage(t, asstMsg(t, 'a1', 'u1', MODEL_A, 'model-a') as any, [blk('a1', 'ba1') as any])
    const res = agg.resendUserMessages(t, 'u1', 'as-1', MODEL_B as any)
    expect(res.ok).toBe(true)
    const v = okValue(res)
    expect(v.askId).toBe('u1')
    expect(v.executionMessages).toHaveLength(1)
    expect((v.executionMessages[0].message as Record<string, unknown>).id).toBe('a1')
    expect((v.executionMessages[0].message as Record<string, unknown>).modelId).toBe('model-b')
    expect(v.attempts).toHaveLength(1)
    expect(v.attempts[0].messageId).toBe('a1')
    expect(v.removedBlockIds).toContain('ba1')
    expect(v.userMessage.id).toBe('u1')
    expect(v.userBlocks.map((b) => (b as Record<string, unknown>).id)).toContain('bu1')
  })

  it('resend multi preserves each model', () => {
    const t = `t-${uid()}`
    seedTopic(t)
    agg.appendMessage(t, userMsg(t, 'u1') as any, [])
    agg.appendMessage(t, asstMsg(t, 'a1', 'u1', MODEL_A, 'model-a') as any, [blk('a1', 'ba1') as any])
    agg.appendMessage(t, asstMsg(t, 'a2', 'u1', MODEL_B, 'model-b') as any, [blk('a2', 'ba2') as any])
    const res = agg.resendUserMessages(t, 'u1', 'as-1', MODEL_C as any)
    const v = okValue(res)
    expect(v.executionMessages).toHaveLength(2)
    const byId = new Map(v.executionMessages.map((e) => [(e.message as Record<string, unknown>).id, e.message]))
    expect((byId.get('a1') as Record<string, unknown>).modelId).toBe('model-a')
    expect((byId.get('a2') as Record<string, unknown>).modelId).toBe('model-b')
    expect(v.removedBlockIds.sort()).toEqual(['ba1', 'ba2'])
  })

  it('resend window-independent: full authority group beyond loaded projection', () => {
    const t = `t-${uid()}`
    seedTopic(t)
    agg.appendMessage(t, userMsg(t, 'u1') as any, [])
    for (const id of ['a1', 'a2', 'a3']) {
      agg.appendMessage(t, asstMsg(t, id, 'u1', { id: `model-${id}` }) as any, [blk(id, `b-${id}`) as any])
    }
    const res = agg.resendUserMessages(t, 'u1', 'as-1', MODEL_A as any)
    const v = okValue(res)
    expect(v.executionMessages).toHaveLength(3)
    expect(v.attempts.map((a) => a.messageId).sort()).toEqual(['a1', 'a2', 'a3'])
  })

  it('resend mentions creates missing models only', () => {
    const t = `t-${uid()}`
    seedTopic(t)
    agg.appendMessage(t, userMsg(t, 'u1', [MODEL_A]) as any, [])
    agg.appendMessage(t, asstMsg(t, 'a1', 'u1', MODEL_A, 'model-a') as any, [])
    const res = agg.resendUserMessages(t, 'u1', 'as-1', MODEL_C as any)
    // mentions=[A], existing has A → no creation, single+mentions preserves own model
    const v = okValue(res)
    expect(v.executionMessages).toHaveLength(1)
    expect(v.createdMessageIds).toHaveLength(0)
  })

  it('resend mentions addition creates missing member', () => {
    const t = `t-${uid()}`
    seedTopic(t)
    agg.appendMessage(t, userMsg(t, 'u1', [MODEL_A, MODEL_B]) as any, [])
    agg.appendMessage(t, asstMsg(t, 'a1', 'u1', MODEL_A, 'model-a') as any, [])
    const res = agg.resendUserMessages(t, 'u1', 'as-1', MODEL_C as any)
    const v = okValue(res)
    expect(v.executionMessages).toHaveLength(2)
    expect(v.createdMessageIds).toHaveLength(1)
    const created = v.executionMessages.find((e) =>
      v.createdMessageIds.includes((e.message as Record<string, unknown>).id as string)
    )
    expect((created!.message as Record<string, unknown>).modelId).toBe('model-b')
  })

  it('resend no existing creates currentModel member', () => {
    const t = `t-${uid()}`
    seedTopic(t)
    agg.appendMessage(t, userMsg(t, 'u1') as any, [blk('u1', 'bu1') as any])
    const res = agg.resendUserMessages(t, 'u1', 'as-1', MODEL_A as any)
    const v = okValue(res)
    expect(v.executionMessages).toHaveLength(1)
    expect(v.createdMessageIds).toHaveLength(1)
    expect((v.executionMessages[0].message as Record<string, unknown>).modelId).toBe('model-a')
    expect((v.executionMessages[0].message as Record<string, unknown>).askId).toBe('u1')
  })

  it('regenerate preserves own modelId, else overrides to current', () => {
    const t = `t-${uid()}`
    seedTopic(t)
    agg.appendMessage(t, userMsg(t, 'u1') as any, [])
    agg.appendMessage(t, asstMsg(t, 'a1', 'u1', MODEL_A, 'model-a') as any, [blk('a1', 'ba1') as any])
    agg.appendMessage(t, { ...asstMsg(t, 'a2', 'u1', null), modelId: null } as any, [])
    const r1 = okValue(agg.regenerateAssistantMessage(t, 'a1', 'as-1', MODEL_C as any))
    expect((r1.executionMessages[0].message as Record<string, unknown>).modelId).toBe('model-a')
    const r2 = okValue(agg.regenerateAssistantMessage(t, 'a2', 'as-1', MODEL_C as any))
    expect((r2.executionMessages[0].message as Record<string, unknown>).modelId).toBe('model-c')
    expect(r1.executionMessages).toHaveLength(1)
  })

  it('regenerate self-modelId without currentModel succeeds; missing both fails closed', () => {
    const t = `t-${uid()}`
    seedTopic(t)
    agg.appendMessage(t, userMsg(t, 'u1') as any, [])
    agg.appendMessage(t, asstMsg(t, 'a1', 'u1', MODEL_A, 'model-a') as any, [blk('a1', 'ba1') as any])
    // Self-modelId path: omit currentModel entirely, Main preserves own model.
    const self = agg.regenerateAssistantMessage(t, 'a1', 'as-1', undefined as any)
    expect(self.ok).toBe(true)
    const sv = okValue(self)
    expect((sv.executionMessages[0].message as Record<string, unknown>).modelId).toBe('model-a')
    // Configured path still succeeds and overrides when selected lacks modelId.
    agg.appendMessage(t, { ...asstMsg(t, 'a2', 'u1', null), modelId: null } as any, [])
    const cfg = okValue(agg.regenerateAssistantMessage(t, 'a2', 'as-1', MODEL_C as any))
    expect((cfg.executionMessages[0].message as Record<string, unknown>).modelId).toBe('model-c')
    // No modelId + no currentModel fails closed typed (CONFLICT), never silent.
    // Use a fresh no-modelId member so the self-model path cannot apply.
    agg.appendMessage(t, { ...asstMsg(t, 'a3', 'u1', null), modelId: null } as any, [])
    const bad = agg.regenerateAssistantMessage(t, 'a3', 'as-1', undefined as any)
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect((bad as unknown as { error: { code: string } }).error.code).toBe('CONFLICT_ERROR')
    }
  })

  it('cross-topic/missing/role fails closed with rollback', () => {
    const t1 = `t-${uid()}`
    const t2 = `t-${uid()}`
    seedTopic(t1)
    seedTopic(t2)
    agg.appendMessage(t1, userMsg(t1, 'u1') as any, [blk('u1', 'bu1') as any])
    agg.appendMessage(t1, asstMsg(t1, 'a1', 'u1', MODEL_A, 'model-a') as any, [blk('a1', 'ba1') as any])
    const before = okValue(agg.fetchMessages(t1))
    const badTopic = agg.resendUserMessages(t2, 'u1', 'as-1', MODEL_A as any)
    expect(badTopic.ok).toBe(false)
    const badRole = agg.resendUserMessages(t1, 'a1', 'as-1', MODEL_A as any)
    expect(badRole.ok).toBe(false)
    const badRegen = agg.regenerateAssistantMessage(t1, 'u1', 'as-1', MODEL_A as any)
    expect(badRegen.ok).toBe(false)
    const after = okValue(agg.fetchMessages(t1))
    expect(after.messages.length).toBe(before.messages.length)
    expect(after.blocks.length).toBe(before.blocks.length)
  })

  it('low-level parity: same reset body, frame invalidation, intent rows', () => {
    const t = `t-${uid()}`
    seedTopic(t)
    agg.appendMessage(t, userMsg(t, 'u1') as any, [])
    agg.appendMessage(t, asstMsg(t, 'a1', 'u1', MODEL_A, 'model-a') as any, [blk('a1', 'ba1') as any])
    const low = okValue(
      agg.resetMessagesForResend(
        t,
        [{ message: { id: 'a1', status: 'pending', blocks: [] } as any, blocks: [] }],
        ['ba1']
      )
    )
    expect(low.attempts).toHaveLength(1)
    // semantic on same shape also yields one attempt + same cleanup keys
    agg.appendMessage(t, asstMsg(t, 'a2', 'u1', MODEL_A, 'model-a') as any, [blk('a2', 'ba2') as any])
    const sem = okValue(agg.regenerateAssistantMessage(t, 'a2', 'as-1', MODEL_A as any))
    expect(sem.attempts).toHaveLength(1)
    expect(Object.keys(sem).sort()).toEqual(
      expect.arrayContaining(['affectedFileIds', 'remainingReferenceCounts', 'attempts', 'executionMessages'])
    )
  })

  it('strict snapshot: incomplete currentModel fails closed with no writes', () => {
    const t = `t-${uid()}`
    seedTopic(t)
    agg.appendMessage(t, userMsg(t, 'u1') as any, [blk('u1', 'bu1') as any])
    agg.appendMessage(t, asstMsg(t, 'a1', 'u1', MODEL_A, 'model-a') as any, [blk('a1', 'ba1') as any])
    agg.appendMessage(t, { ...asstMsg(t, 'a2', 'u1', null), modelId: null } as any, [])
    const before = okValue(agg.fetchMessages(t))
    const idOnly = { id: 'model-x' } as any
    const missingProvider = { id: 'm', name: 'N', group: 'g' } as any
    for (const bad of [idOnly, missingProvider, { id: '', provider: 'p', name: 'N', group: 'g' }]) {
      const r = agg.resendUserMessages(t, 'u1', 'as-1', bad)
      expect(r.ok).toBe(false)
      if (!r.ok) expect((r as unknown as { error: { code: string } }).error.code).toBe('CONFLICT_ERROR')
    }
    const regenBad = agg.regenerateAssistantMessage(t, 'a2', 'as-1', idOnly)
    expect(regenBad.ok).toBe(false)
    if (!regenBad.ok) {
      expect((regenBad as unknown as { error: { code: string } }).error.code).toBe('CONFLICT_ERROR')
    }
    const after = okValue(agg.fetchMessages(t))
    expect(after.messages.length).toBe(before.messages.length)
    expect(after.blocks.length).toBe(before.blocks.length)
  })

  it('execution message.model roundtrips full four fields plus extras', () => {
    const t = `t-${uid()}`
    seedTopic(t)
    const extra = { ...MODEL_A, capabilities: [{ type: 'vision' }], pricing: { input: 1 } }
    const u = `${t}-u1`
    // No-existing create path carries the full snapshot verbatim.
    agg.appendMessage(t, userMsg(t, u) as any, [])
    const created = okValue(agg.resendUserMessages(t, u, 'as-1', extra as any))
    const createdModel = (created.executionMessages[0].message as Record<string, unknown>).model as Record<
      string,
      unknown
    >
    expect(createdModel).toMatchObject({ id: 'model-a', provider: 'p', name: 'A', group: 'g' })
    expect(createdModel.capabilities).toEqual([{ type: 'vision' }])
    // Single no-mention override path replaces with the full currentModel.
    const t2 = `t-${uid()}`
    seedTopic(t2)
    const u2 = `${t2}-u1`
    const a2 = `${t2}-a1`
    agg.appendMessage(t2, userMsg(t2, u2) as any, [])
    agg.appendMessage(t2, asstMsg(t2, a2, u2, MODEL_B, 'model-b') as any, [])
    const overridden = okValue(agg.resendUserMessages(t2, u2, 'as-1', extra as any))
    const overModel = (overridden.executionMessages[0].message as Record<string, unknown>).model as Record<
      string,
      unknown
    >
    expect(overModel).toMatchObject({ id: 'model-a', provider: 'p', name: 'A', group: 'g' })
    expect((overridden.executionMessages[0].message as Record<string, unknown>).modelId).toBe('model-a')
  })

  it('mention-create roundtrips full mention model; id-only mention fails closed', () => {
    // Full mention creates a member whose execution model is the full snapshot.
    const t = `t-${uid()}`
    seedTopic(t)
    const u = `${t}-u1`
    const a = `${t}-a1`
    agg.appendMessage(t, userMsg(t, u, [MODEL_A, MODEL_B]) as any, [])
    agg.appendMessage(t, asstMsg(t, a, u, MODEL_A, 'model-a') as any, [])
    const res = okValue(agg.resendUserMessages(t, u, 'as-1', MODEL_C as any))
    expect(res.createdMessageIds).toHaveLength(1)
    const createdEntry = res.executionMessages.find((e) =>
      res.createdMessageIds.includes((e.message as Record<string, unknown>).id as string)
    )!
    const createdModel = (createdEntry.message as Record<string, unknown>).model as Record<string, unknown>
    expect(createdModel).toMatchObject({ id: 'model-b', provider: 'p', name: 'B', group: 'g' })
    // Id-only authority mention must fail closed (CONFLICT) with no partial writes.
    const t2 = `t-${uid()}`
    seedTopic(t2)
    const u2 = `${t2}-u1`
    agg.appendMessage(t2, userMsg(t2, u2, [{ id: 'model-id-only' }]) as any, [])
    const before = okValue(agg.fetchMessages(t2))
    const bad = agg.resendUserMessages(t2, u2, 'as-1', MODEL_A as any)
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect((bad as unknown as { error: { code: string } }).error.code).toBe('CONFLICT_ERROR')
    }
    const after = okValue(agg.fetchMessages(t2))
    expect(after.messages.length).toBe(before.messages.length)
    expect(after.blocks.length).toBe(before.blocks.length)
  })
})
