import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

vi.mock('@main/config', () => ({ DATA_PATH: '/mock/data' }))

const { mockCleanTopic } = vi.hoisted(() => ({
  mockCleanTopic: vi.fn()
}))
vi.mock('../../SpanCacheService', () => ({
  spanCacheService: { cleanTopic: mockCleanTopic }
}))

import { isSuccess, type TopicDataExportPayload, validateChatDbResult } from '@shared/chatDb'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { runMigrations } from '../migration'
import { createRepositories } from '../repository/factory'
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-topic-data-'))
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
function uid(prefix = 'x'): string {
  return `${prefix}${++counter}-${Date.now()}`
}

function okValue<T>(result: { ok: boolean; value?: T; error?: unknown }): T {
  if (!isSuccess(result as any)) throw new Error(`Expected success, got: ${JSON.stringify((result as any).error)}`)
  return (result as any).value as T
}
function failCode(result: { ok: boolean; error?: any }): string {
  if (isSuccess(result as any)) throw new Error('Expected failure')
  return (result as any).error.code as string
}

function makeMessageJson(topicId: string, overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `m-${uid('m')}`,
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
    id: `b-${uid('b')}`,
    messageId,
    type,
    content: type === 'main_text' ? `content-${uid('c')}` : null,
    status: 'success',
    createdAt: new Date().toISOString(),
    ...overrides
  }
}

const TABLES = [
  'topics',
  'messages',
  'message_blocks',
  'topic_branches',
  'topic_segments',
  'topic_segment_messages',
  'file_references'
]

describe('topic-data JSON exchange (whole-logical-topic export/import)', () => {
  let tmpDir: string
  let sqlite: Database.Database
  let db: BetterSQLite3Database<typeof schema>
  let agg: ChatDbAggregateService

  beforeEach(() => {
    tmpDir = makeTempDir()
    sqlite = openTestDb(realPath.join(tmpDir, 'test.db'))
    db = wrapDrizzle(sqlite)
    runMigrations(db, sqlite)
    agg = new ChatDbAggregateService(db)
    mockCleanTopic.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    try {
      sqlite.close()
    } catch {
      // ignore
    }
    rmrf(tmpDir)
  })

  function tableCounts(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const table of TABLES) {
      out[table] = (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
    }
    return out
  }

  function append(
    topicId: string,
    message: Record<string, unknown>,
    blocks: Record<string, unknown>[],
    branchId?: string | null
  ) {
    const res = agg.appendMessage(topicId, message as any, blocks as any, undefined, undefined, {
      branchId: branchId ?? null
    })
    expect(res.ok).toBe(true)
  }

  interface Seed {
    topicId: string
    assistantId: string
    ids: Record<string, string>
    branchL1: string
    branchL2: string
    branchS1: string
    segId: string
  }

  function seedRichTopicFull(): Seed {
    const assistantId = `assistant-source-${uid('a')}`
    const topicId = `t-${uid('t')}`
    agg.ensureTopic(topicId, assistantId, 'Source topic')
    expect(agg.updateTopicMetadata(topicId, undefined, true, 'custom-prompt').ok).toBe(true)

    const ids: Record<string, string> = {}
    const addMain = (key: string, overrides: Record<string, unknown>, extraBlocks: Record<string, unknown>[] = []) => {
      const msg = makeMessageJson(topicId, overrides)
      ids[key] = msg.id as string
      const main = makeBlockJson(ids[key], 'main_text', { content: `text-${key}` })
      append(topicId, msg, [main, ...extraBlocks.map((b) => ({ ...b, messageId: ids[key] }))])
    }
    addMain('u1', { role: 'user', content: 'u1' })
    addMain('a1', { role: 'assistant', content: 'a1', askId: ids.u1 })
    addMain('u2', { role: 'user', content: 'u2' })
    // Structured model object round-trips through overflow (column null, modelId extracted).
    addMain('a2a', { role: 'assistant', content: 'a2a', askId: ids.u2, model: { id: 'model-x', name: 'Model X' } })
    addMain('a2b', { role: 'assistant', content: 'a2b', askId: ids.u2 })

    const l1 = okValue(agg.createBranch(topicId, null, ids.a1, 'L1'))
    const branchL1 = (l1.branch as { id: string }).id
    const addBranch = (
      key: string,
      branchId: string,
      overrides: Record<string, unknown>,
      extraBlocks: Record<string, unknown>[] = []
    ) => {
      const msg = makeMessageJson(topicId, overrides)
      ids[key] = msg.id as string
      const main = makeBlockJson(ids[key], 'main_text', { content: `text-${key}` })
      append(topicId, msg, [main, ...extraBlocks.map((b) => ({ ...b, messageId: ids[key] }))], branchId)
    }
    addBranch('u3', branchL1, { role: 'user', content: 'u3' })
    addBranch('a3', branchL1, { role: 'assistant', content: 'a3', askId: ids.u3 }, [
      {
        id: `b-${uid('b')}`,
        type: 'tool',
        content: { tool: 'search', result: 'ok' },
        status: 'success',
        createdAt: new Date().toISOString()
      }
    ])

    const l2 = okValue(agg.createBranch(topicId, branchL1, ids.u3, 'L2'))
    const branchL2 = (l2.branch as { id: string }).id
    addBranch('u4', branchL2, { role: 'user', content: 'u4' })

    const s1 = okValue(agg.createBranch(topicId, null, ids.a1, 'S1'))
    const branchS1 = (s1.branch as { id: string }).id
    addBranch('u5', branchS1, { role: 'user', content: 'u5' })

    // Post-fork main row (excluded from branch routes, included in export).
    addMain('u6', { role: 'user', content: 'u6' }, [
      {
        id: `b-${uid('b')}`,
        type: 'file',
        content: null,
        status: 'success',
        createdAt: new Date().toISOString(),
        file: { id: 'file-attach-1', name: 'a.txt', path: '/tmp/a.txt', type: 'text/plain' }
      }
    ])

    const segId = `seg-${uid('s')}`
    expect(agg.upsertSegment(segId, topicId, 'Seg', [ids.u1, ids.a1], undefined).ok).toBe(true)

    return { topicId, assistantId, ids, branchL1, branchL2, branchS1, segId }
  }

  function exportPayload(topicId: string): TopicDataExportPayload {
    const result = agg.exportTopicData({ topicId })
    expect(result.ok).toBe(true)
    const payload = okValue(result).payload
    expect(() => validateChatDbResult('chatdb:export-topic-data', { ok: true, value: { payload } })).not.toThrow()
    // Proves JSON transport safety (export must survive stringify/parse).
    return JSON.parse(JSON.stringify(payload)) as TopicDataExportPayload
  }

  it('export fails NOT_FOUND for a missing topic and creates nothing', () => {
    const before = tableCounts()
    const result = agg.exportTopicData({ topicId: 'missing-topic' })
    expect(result.ok).toBe(false)
    expect(failCode(result)).toBe('NOT_FOUND')
    expect(tableCounts()).toEqual(before)
  })

  it('exports an empty topic and re-imports it as an empty new topic', () => {
    const assistantId = `assistant-empty-${uid('a')}`
    const topicId = `t-${uid('t')}`
    agg.ensureTopic(topicId, assistantId, 'Empty')
    const payload = exportPayload(topicId)
    expect(payload.messages).toEqual([])
    expect(payload.blocks).toEqual([])
    expect(payload.branches).toEqual([])
    expect(payload.segments).toEqual([])
    expect(payload.fileReferences).toEqual([])

    const targetAssistant = `assistant-target-${uid('a')}`
    const imported = okValue(agg.importTopicData({ payload, assistantId: targetAssistant }))
    expect(imported.topic.id).not.toBe(topicId)
    expect(imported.topic.assistantId).toBe(targetAssistant)
    expect(imported.messageCount).toBe(0)
    expect(imported.branchCount).toBe(0)
    expect(() => validateChatDbResult('chatdb:import-topic-data', { ok: true, value: imported })).not.toThrow()
  })

  it('round-trips all branches, segments, file refs, and blocks with remapped relationships', () => {
    const seed = seedRichTopicFull()
    const payload = exportPayload(seed.topicId)

    // Payload shape: everything owned, nothing scoped or credentialed.
    expect(payload.format).toBe('cherry-chat-topic-data')
    expect(payload.version).toBe(1)
    expect(payload.messages).toHaveLength(10)
    expect(payload.blocks).toHaveLength(12)
    expect(payload.branches).toHaveLength(3)
    expect(payload.segments).toHaveLength(1)
    expect(payload.fileReferences).toHaveLength(1)
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain(seed.assistantId)
    expect(serialized).not.toContain(seed.topicId)
    const sensitiveKey = /"(api[_-]?key|token|secret|password|credential)/i
    const collectKeys = (value: unknown, keys: string[]): string[] => {
      if (Array.isArray(value)) {
        for (const entry of value) collectKeys(entry, keys)
      } else if (value !== null && typeof value === 'object') {
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
          keys.push(key)
          collectKeys(entry, keys)
        }
      }
      return keys
    }
    for (const key of collectKeys(payload, [])) {
      expect(key).not.toMatch(sensitiveKey)
    }

    const targetAssistant = `assistant-target-${uid('a')}`
    const imported = okValue(agg.importTopicData({ payload, assistantId: targetAssistant }))
    expect(imported.messageCount).toBe(10)
    expect(imported.blockCount).toBe(12)
    expect(imported.branchCount).toBe(3)
    expect(imported.segmentCount).toBe(1)
    expect(imported.fileReferenceCount).toBe(1)

    const repos = createRepositories(db)
    const newTopicId = imported.topic.id
    expect(newTopicId).not.toBe(seed.topicId)
    expect(imported.topic.assistantId).toBe(targetAssistant)

    // All entity IDs are disjoint from the source.
    const newMessages = repos.messages.listAllByTopic(newTopicId)
    const newBlocks = repos.blocks.listByMessages(newMessages.map((m) => m.id))
    const flatBlocks = [...newBlocks.values()].flat()
    const newBranches = repos.branches.listByTopic(newTopicId)
    const newSegments = repos.segments.listByTopic(newTopicId)
    const oldIds = new Set([
      ...payload.messages.map((m) => m.id),
      ...payload.blocks.map((b) => b.id),
      ...payload.branches.map((b) => b.id),
      ...payload.segments.map((s) => s.id)
    ])
    for (const m of newMessages) expect(oldIds.has(m.id)).toBe(false)
    for (const b of flatBlocks) expect(oldIds.has(b.id)).toBe(false)
    for (const b of newBranches) expect(oldIds.has(b.id)).toBe(false)
    for (const s of newSegments) expect(oldIds.has(s.id)).toBe(false)

    const byContent = new Map(newMessages.map((m) => [m.content, m]))
    const nu1 = byContent.get('u1')!
    const na1 = byContent.get('a1')!
    const na2a = byContent.get('a2a')!
    const na2b = byContent.get('a2b')!
    const nu3 = byContent.get('u3')!
    const nu4 = byContent.get('u4')!
    const nu5 = byContent.get('u5')!

    // askId remapped to the NEW user ids; assistant bindings rebound.
    expect(na1.askId).toBe(nu1.id)
    expect(na2a.askId).toBe(byContent.get('u2')!.id)
    expect(na2b.askId).toBe(byContent.get('u2')!.id)
    for (const m of newMessages) expect(m.assistantId).toBe(targetAssistant)
    expect(nu1.branchId).toBeNull()
    expect(nu3.branchId).not.toBeNull()

    // Branch parents + anchors remapped; sibling/nested structure preserved.
    const branchByName = new Map(newBranches.map((b) => [b.name, b]))
    const nL1 = branchByName.get('L1')!
    const nL2 = branchByName.get('L2')!
    const nS1 = branchByName.get('S1')!
    expect(nL1.parentBranchId).toBeNull()
    expect(nL1.anchorMessageId).toBe(na1.id)
    expect(nL2.parentBranchId).toBe(nL1.id)
    expect(nL2.anchorMessageId).toBe(nu3.id)
    expect(nS1.parentBranchId).toBeNull()
    expect(nS1.anchorMessageId).toBe(na1.id)
    expect(byContent.get('u3')!.branchId).toBe(nL1.id)
    expect(nu4.branchId).toBe(nL2.id)
    expect(nu5.branchId).toBe(nS1.id)

    // Effective nested route resolves through the remapped prefix.
    const l2Snap = okValue(agg.fetchWholeTopicSnapshot({ topicId: newTopicId, branchId: nL2.id }))
    expect(l2Snap.messages.map((m: any) => m.content)).toEqual(['u1', 'a1', 'u3', 'u4'])

    // Segments + membership remapped in order; order/timestamps preserved.
    expect(newSegments).toHaveLength(1)
    expect(repos.segments.getMessageIds(newSegments[0].id)).toEqual([nu1.id, na1.id])
    const oldByContent = new Map(payload.messages.map((m) => [m.content, m]))
    for (const m of newMessages) {
      const old = oldByContent.get(m.content) as any
      expect(m.sortOrder).toBe(old.sortOrder)
      expect(m.createdAt).toBe(old.createdAt)
    }

    // File reference keeps the attachment identity on the NEW block.
    const refs = repos.fileRefs.listByMessages(newMessages.map((m) => m.id))
    const flatRefs = [...refs.values()].flat()
    expect(flatRefs).toHaveLength(1)
    expect(flatRefs[0].fileId).toBe('file-attach-1')
    expect(flatRefs[0].fileName).toBe('a.txt')
    const u6 = byContent.get('u6')!
    expect(flatRefs[0].blockId).not.toBe(payload.fileReferences[0].blockId)
    expect(flatBlocks.find((b) => b.id === flatRefs[0].blockId)?.messageId).toBe(u6.id)

    // Tool block structured content round-trips through overflow.
    const a3 = byContent.get('a3')!
    const a3Blocks = [...repos.blocks.listByMessages([a3.id]).values()].flat()
    const tool = a3Blocks.find((b) => b.type === 'tool')!
    expect(tool.content).toBeNull()
    expect(tool.overflow.content).toEqual({ tool: 'search', result: 'ok' })

    // Structured model metadata round-trips (modelId column + model overflow).
    expect(na2a.modelId).toBe('model-x')
    expect(na2a.model).toBeNull()
    expect(na2a.overflow.model).toEqual({ id: 'model-x', name: 'Model X' })

    // Topic overflow (pinned/prompt) survives; source assistant never required.
    expect(imported.topic.pinned).toBe(true)
    expect(imported.topic.prompt).toBe('custom-prompt')
  })

  it('repeated imports stay fully disjoint with rewritten relationships', () => {
    const seed = seedRichTopicFull()
    const payload = exportPayload(seed.topicId)
    const targetAssistant = `assistant-target-${uid('a')}`
    const first = okValue(agg.importTopicData({ payload, assistantId: targetAssistant }))
    const second = okValue(agg.importTopicData({ payload, assistantId: targetAssistant }))
    expect(second.topic.id).not.toBe(first.topic.id)

    const repos = createRepositories(db)
    const collect = (topicId: string) => {
      const messages = repos.messages.listByTopic(topicId)
      void messages
      const all = repos.messages.listAllByTopic(topicId)
      const blocks = [...repos.blocks.listByMessages(all.map((m) => m.id)).values()].flat()
      const branches = repos.branches.listByTopic(topicId)
      const segments = repos.segments.listByTopic(topicId)
      const refs = [...repos.fileRefs.listByMessages(all.map((m) => m.id)).values()].flat()
      return {
        messages: all.map((m) => m.id),
        blocks: blocks.map((b) => b.id),
        branches: branches.map((b) => b.id),
        segments: segments.map((s) => s.id),
        refs: refs.map((r) => r.id)
      }
    }
    const a = collect(first.topic.id)
    const b = collect(second.topic.id)
    for (const key of Object.keys(a) as Array<keyof typeof a>) {
      expect(a[key]).toHaveLength(b[key].length)
      expect(new Set([...a[key], ...b[key]]).size).toBe(a[key].length * 2)
    }
    // Same relationships under fresh ids: L2 anchor is still the u3 copy.
    const branchName = (topicId: string, name: string) =>
      repos.branches.listByTopic(topicId).find((branch) => branch.name === name)!
    const contentId = (topicId: string, content: string) =>
      repos.messages.listAllByTopic(topicId).find((m) => m.content === content)!.id
    expect(branchName(second.topic.id, 'L2').anchorMessageId).toBe(contentId(second.topic.id, 'u3'))
  })

  it('exports the full topic beyond windowed/projection bounds', () => {
    const assistantId = `assistant-big-${uid('a')}`
    const topicId = `t-${uid('t')}`
    agg.ensureTopic(topicId, assistantId, 'Big')
    for (let i = 0; i < 35; i++) {
      const msg = makeMessageJson(topicId, { role: i % 2 === 0 ? 'user' : 'assistant', content: `m-${i}` })
      const res = agg.appendMessage(topicId, msg as any, [makeBlockJson(msg.id as string) as any])
      expect(res.ok).toBe(true)
    }
    const payload = exportPayload(topicId)
    expect(payload.messages).toHaveLength(35)
    expect(payload.blocks).toHaveLength(35)
    expect(payload.messages.map((m) => m.content)).toEqual(Array.from({ length: 35 }, (_, i) => `m-${i}`))
  })

  it('preserves a dangling branch anchor without repair', () => {
    const seed = seedRichTopicFull()
    const payload = exportPayload(seed.topicId)
    // Drop one main message to orphan the L1/S1 anchors (valid missing-anchor state).
    const dropped = payload.messages.find((m) => m.content === 'a1')!.id
    const pruned: TopicDataExportPayload = {
      ...payload,
      messages: payload.messages.filter((m) => m.id !== dropped),
      blocks: payload.blocks.filter((b) => b.messageId !== dropped),
      // Segment membership must stay resolvable (only anchors may dangle).
      segments: payload.segments.map((s) => ({
        ...s,
        messageIds: s.messageIds.filter((id) => id !== dropped)
      }))
    }
    const targetAssistant = `assistant-target-${uid('a')}`
    const imported = okValue(agg.importTopicData({ payload: pruned, assistantId: targetAssistant }))
    expect(imported.branchCount).toBe(3)
    const repos = createRepositories(db)
    const l1 = repos.branches.listByTopic(imported.topic.id).find((b) => b.name === 'L1')!
    // The missing anchor id is preserved verbatim (never repaired or dropped).
    expect(l1.anchorMessageId).toBe(dropped)
    // Resolution of the orphaned route fails closed; metadata survives.
    const resolved = agg.fetchWholeTopicSnapshot({ topicId: imported.topic.id, branchId: l1.id })
    expect(resolved.ok).toBe(false)
    expect(failCode(resolved)).toBe('NOT_FOUND')
    expect(repos.branches.listByTopic(imported.topic.id)).toHaveLength(3)
  })

  it('rejects an anchor owned by the wrong parent route with zero writes', () => {
    const seed = seedRichTopicFull()
    const payload = exportPayload(seed.topicId)
    // Reparent L1 (main-forked) onto L2 while keeping its main anchor.
    const l1 = payload.branches.find((b) => b.name === 'L1')!
    const l2 = payload.branches.find((b) => b.name === 'L2')!
    const tampered: TopicDataExportPayload = {
      ...payload,
      branches: payload.branches.map((b) => (b.id === l1.id ? { ...b, parentBranchId: l2.id } : b))
    }
    const before = tableCounts()
    const result = agg.importTopicData({ payload: tampered, assistantId: `assistant-target-${uid('a')}` })
    expect(result.ok).toBe(false)
    expect(failCode(result)).toBe('VALIDATION_ERROR')
    expect(tableCounts()).toEqual(before)
  })

  it('rolls back every malformed payload without partial rows', () => {
    const seed = seedRichTopicFull()
    const base = exportPayload(seed.topicId)
    const target = () => `assistant-target-${uid('a')}`
    const clone = (): TopicDataExportPayload => JSON.parse(JSON.stringify(base))

    const cases: Array<{ name: string; payload: unknown; assistantId?: string }> = [
      { name: 'null payload', payload: null },
      { name: 'string payload', payload: 'nope' },
      { name: 'array payload', payload: [] },
      { name: 'wrong format', payload: { ...clone(), format: 'other' } },
      { name: 'unsupported version', payload: { ...clone(), version: 2 } },
      {
        name: 'missing messages',
        payload: (() => {
          const p = clone()
          delete (p as any).messages
          return p
        })()
      },
      {
        name: 'duplicate message ids',
        payload: (() => {
          const p = clone()
          p.messages = [...p.messages, { ...p.messages[0] }]
          return p
        })()
      },
      {
        name: 'block with unknown message',
        payload: (() => {
          const p = clone()
          p.blocks = [...p.blocks, { ...p.blocks[0], id: `b-${uid('b')}`, messageId: 'missing' }]
          return p
        })()
      },
      {
        name: 'branch with unknown parent',
        payload: (() => {
          const p = clone()
          p.branches = [...p.branches, { ...p.branches[0], id: `br-${uid('r')}`, parentBranchId: 'missing' }]
          return p
        })()
      },
      {
        name: 'branch parent cycle',
        payload: (() => {
          const p = clone()
          const [first, second] = p.branches
          p.branches = [
            { ...first, parentBranchId: second.id },
            { ...second, parentBranchId: first.id }
          ]
          return p
        })()
      },
      {
        name: 'branch self parent',
        payload: (() => {
          const p = clone()
          p.branches = [{ ...p.branches[0], parentBranchId: p.branches[0].id }]
          return p
        })()
      },
      {
        name: 'segment with unknown message',
        payload: (() => {
          const p = clone()
          p.segments = [{ ...p.segments[0], id: `seg-${uid('s')}`, messageIds: ['missing'] }]
          return p
        })()
      },
      {
        name: 'segment with duplicate members',
        payload: (() => {
          const p = clone()
          const member = p.segments[0].messageIds[0]
          p.segments = [{ ...p.segments[0], id: `seg-${uid('s')}`, messageIds: [member, member] }]
          return p
        })()
      },
      {
        name: 'file ref with unknown block',
        payload: (() => {
          const p = clone()
          p.fileReferences = [{ ...p.fileReferences[0], id: `fr-${uid('f')}`, blockId: 'missing' }]
          return p
        })()
      },
      { name: 'empty assistant', payload: clone(), assistantId: '' }
    ]

    for (const { name, payload, assistantId } of cases) {
      const before = tableCounts()
      const result = agg.importTopicData({ payload: payload as any, assistantId: assistantId ?? target() })
      expect(result.ok, name).toBe(false)
      expect(['VALIDATION_ERROR', 'NOT_FOUND', 'FOREIGN_KEY_VIOLATION', 'CONFLICT_ERROR']).toContain(failCode(result))
      expect(tableCounts(), name).toEqual(before)
    }
  })

  it('imports a hand-built empty segment without memberships', () => {
    const assistantId = `assistant-hand-${uid('a')}`
    const topicId = `t-${uid('t')}`
    agg.ensureTopic(topicId, assistantId, 'Hand')
    const msg = makeMessageJson(topicId, { role: 'user', content: 'solo' })
    append(topicId, msg, [makeBlockJson(msg.id as string)])
    const payload = exportPayload(topicId)
    const withEmpty: TopicDataExportPayload = {
      ...payload,
      segments: [
        ...payload.segments,
        {
          id: `seg-${uid('s')}`,
          name: 'Empty',
          messageIds: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          sortOrder: 0
        }
      ]
    }
    const imported = okValue(agg.importTopicData({ payload: withEmpty, assistantId: `assistant-t2-${uid('a')}` }))
    expect(imported.segmentCount).toBe(1)
    const repos = createRepositories(db)
    const segments = repos.segments.listByTopic(imported.topic.id)
    expect(segments).toHaveLength(1)
    expect(segments[0].name).toBe('Empty')
    expect(repos.segments.getMessageIds(segments[0].id)).toEqual([])
  })

  it('rejects an unknown message branchId with zero writes (F1)', () => {
    const seed = seedRichTopicFull()
    const payload = exportPayload(seed.topicId)
    const tampered: TopicDataExportPayload = {
      ...payload,
      messages: payload.messages.map((m, i) => (i === 0 ? { ...m, branchId: 'branch-missing' } : m))
    }
    const before = tableCounts()
    const result = agg.importTopicData({ payload: tampered, assistantId: `assistant-target-${uid('a')}` })
    expect(result.ok).toBe(false)
    expect(failCode(result)).toBe('VALIDATION_ERROR')
    expect(tableCounts()).toEqual(before)
  })

  it('rejects the Main-only trash-retention marker from topic overflow (F2)', () => {
    const seed = seedRichTopicFull()
    const payload = exportPayload(seed.topicId)
    const tampered: TopicDataExportPayload = {
      ...payload,
      topic: { ...payload.topic, l2TrashRetentionStartedAt: new Date().toISOString() } as typeof payload.topic
    }
    const before = tableCounts()
    const result = agg.importTopicData({ payload: tampered, assistantId: `assistant-target-${uid('a')}` })
    expect(result.ok).toBe(false)
    expect(failCode(result)).toBe('VALIDATION_ERROR')
    expect(tableCounts()).toEqual(before)
  })

  it('rejects wrongly typed known overflow keys but preserves unknown opaque content (F3)', () => {
    const seed = seedRichTopicFull()
    const base = exportPayload(seed.topicId)
    const clone = (): TopicDataExportPayload => JSON.parse(JSON.stringify(base))
    const target = () => `assistant-target-${uid('a')}`

    // Wrong types on the only overflow keys with a shared typed contract.
    const badTopic: TopicDataExportPayload = { ...clone(), topic: { ...clone().topic, pinned: 'yes' as never } }
    const badPrompt: TopicDataExportPayload = { ...clone(), topic: { ...clone().topic, prompt: 42 as never } }
    const badEdited: TopicDataExportPayload = {
      ...clone(),
      topic: { ...clone().topic, isNameManuallyEdited: 'yes' as never }
    }
    const badColor: TopicDataExportPayload = {
      ...clone(),
      segments: clone().segments.map((s) => ({ ...s, color: 42 as never }))
    }
    for (const [name, payload] of [
      ['pinned', badTopic],
      ['prompt', badPrompt],
      ['isNameManuallyEdited', badEdited],
      ['color', badColor]
    ] as const) {
      const before = tableCounts()
      const result = agg.importTopicData({ payload, assistantId: target() })
      expect(result.ok, name).toBe(false)
      expect(failCode(result)).toBe('VALIDATION_ERROR')
      expect(tableCounts(), name).toEqual(before)
    }

    // Unknown opaque overflow (including local-only foldSelected/useful)
    // survives the round-trip verbatim.
    const withOpaque: TopicDataExportPayload = {
      ...clone(),
      topic: { ...clone().topic, customOpaque: { nested: [1, 2] } } as typeof base.topic,
      messages: clone().messages.map((m) => ({ ...m, foldSelected: true, useful: false }) as typeof m)
    }
    const imported = okValue(agg.importTopicData({ payload: withOpaque, assistantId: target() }))
    const repos = createRepositories(db)
    const created = repos.topics.getById(imported.topic.id)
    expect(created.found).toBe(true)
    if (created.found) {
      expect(created.data.overflow.customOpaque).toEqual({ nested: [1, 2] })
    }
    const newMessages = repos.messages.listAllByTopic(imported.topic.id)
    expect(newMessages.length).toBeGreaterThan(0)
    expect(newMessages[0].overflow.foldSelected).toBe(true)
  })

  it('rejects duplicate ordering keys within one scope but preserves sparse gaps (F4)', () => {
    const seed = seedRichTopicFull()
    const base = exportPayload(seed.topicId)
    const clone = (): TopicDataExportPayload => JSON.parse(JSON.stringify(base))
    const target = () => `assistant-target-${uid('a')}`

    // Duplicate message sortOrder inside the same route owner.
    const dupMessage: TopicDataExportPayload = clone()
    const mainMessages = dupMessage.messages.filter((m) => m.branchId === null)
    expect(mainMessages.length).toBeGreaterThanOrEqual(2)
    dupMessage.messages = dupMessage.messages.map((m) =>
      m.id === mainMessages[1].id ? { ...m, sortOrder: mainMessages[0].sortOrder } : m
    )
    {
      const before = tableCounts()
      const result = agg.importTopicData({ payload: dupMessage, assistantId: target() })
      expect(result.ok).toBe(false)
      expect(failCode(result)).toBe('VALIDATION_ERROR')
      expect(tableCounts()).toEqual(before)
    }

    // Duplicate block sortOrder inside the same parent message.
    const dupBlock: TopicDataExportPayload = clone()
    const firstMessageId = dupBlock.messages[0].id
    const siblingBlocks = dupBlock.blocks.filter((b) => b.messageId === firstMessageId)
    // Seed a message with two blocks when the fixture has only singletons.
    if (siblingBlocks.length < 2) {
      const extra = { ...dupBlock.blocks[0], id: `b-${uid('b')}`, sortOrder: 999 }
      dupBlock.blocks = [...dupBlock.blocks, extra]
      const withSiblings = dupBlock.blocks.filter((b) => b.messageId === firstMessageId)
      dupBlock.blocks = dupBlock.blocks.map((b) =>
        b.id === withSiblings[1].id ? { ...b, sortOrder: withSiblings[0].sortOrder } : b
      )
    } else {
      dupBlock.blocks = dupBlock.blocks.map((b) =>
        b.id === siblingBlocks[1].id ? { ...b, sortOrder: siblingBlocks[0].sortOrder } : b
      )
    }
    {
      const before = tableCounts()
      const result = agg.importTopicData({ payload: dupBlock, assistantId: target() })
      expect(result.ok).toBe(false)
      expect(failCode(result)).toBe('VALIDATION_ERROR')
      expect(tableCounts()).toEqual(before)
    }

    // Duplicate segment sortOrder inside the same topic.
    const dupSegment: TopicDataExportPayload = {
      ...clone(),
      segments: [
        {
          id: `seg-${uid('s')}`,
          name: 'S1',
          messageIds: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          sortOrder: 7
        },
        {
          id: `seg-${uid('s')}`,
          name: 'S2',
          messageIds: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          sortOrder: 7
        }
      ]
    }
    {
      const before = tableCounts()
      const result = agg.importTopicData({ payload: dupSegment, assistantId: target() })
      expect(result.ok).toBe(false)
      expect(failCode(result)).toBe('VALIDATION_ERROR')
      expect(tableCounts()).toEqual(before)
    }

    // Same sortOrder across different owners stays legal; sparse gaps import verbatim.
    const sparse: TopicDataExportPayload = clone()
    sparse.messages = sparse.messages.map((m, i) => ({ ...m, sortOrder: i * 10 }))
    const imported = okValue(agg.importTopicData({ payload: sparse, assistantId: target() }))
    expect(imported.messageCount).toBe(sparse.messages.length)
    const repos = createRepositories(db)
    const orders = repos.messages
      .listAllByTopic(imported.topic.id)
      .map((m) => m.sortOrder)
      .sort((a, b) => a - b)
    expect(orders).toEqual(sparse.messages.map((m) => m.sortOrder).sort((a, b) => a - b))
  })
})
