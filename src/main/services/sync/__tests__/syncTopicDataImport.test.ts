/**
 * Topic-JSON import sync coverage: an imported topic must synchronize its FULL
 * content — main and branch-owned messages/blocks, every branch node, and
 * supported local attachments — not just main rows and counts.
 *
 * The JSON export/import format keeps its existing product behavior: foreign
 * prefixes are materialized and no reference relation is created. Only the
 * sync capture changed.
 */
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')
vi.mock('@main/config', () => ({ DATA_PATH: '/tmp' }))

const configStore = new Map<string, unknown>()
vi.mock('@main/services/ConfigManager', () => ({
  configManager: {
    get: (k: string, def?: unknown) => (configStore.has(k) ? configStore.get(k) : def),
    set: (k: string, v: unknown) => configStore.set(k, v),
    has: (k: string) => configStore.has(k)
  },
  ConfigKeys: {}
}))

import { isSuccess } from '@shared/chatDb'

import { chatDbService } from '../../chatDb'
import { ChatDbAggregateService } from '../../chatDb/ChatDbAggregateService'
import { runMigrations } from '../../chatDb/migration'
import { createRepositories } from '../../chatDb/repository/factory'
import * as schema from '../../chatDb/schema'
import { syncService } from '../SyncService'
import { seedRegisteredAttachedSyncService } from './helpers/syncTestRegistration'

function openChatDb(): { sqlite: Database.Database; db: BetterSQLite3Database<typeof schema> } {
  const sqlite = new Database(':memory:')
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  runMigrations(db as never, sqlite)
  return { sqlite, db }
}
function ok<T>(res: unknown): T {
  if (!isSuccess(res as never)) throw new Error(`expected success: ${JSON.stringify(res)}`)
  return (res as { value: T }).value
}
function msgJson(id: string, topicId: string, overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    topicId,
    role: 'user',
    content: `content-${id}`,
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}
function blockJson(id: string, messageId: string, overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    messageId,
    type: 'main_text',
    content: `content-${id}`,
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>
let agg: ChatDbAggregateService

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
  const opened = openChatDb()
  sqlite = opened.sqlite
  db = opened.db
  ;(chatDbService as unknown as { sqlite: unknown }).sqlite = sqlite
  ;(chatDbService as unknown as { db: unknown }).db = db
  syncService.clearAllForTests()
  seedRegisteredAttachedSyncService(configStore, db)
  agg = new ChatDbAggregateService(db, sqlite)
})

afterEach(() => {
  vi.restoreAllMocks()
  try {
    sqlite.close()
  } catch {}
  ;(chatDbService as never as { sqlite: unknown }).sqlite = null
  ;(chatDbService as never as { db: unknown }).db = null
})

describe('topic-data JSON import full-content sync capture', () => {
  it('captures imported branches, branch-owned content, and supported local attachments', () => {
    // --- source topic with a branch + branch-owned message + a file block ---
    const srcTopic = 't-json-src'
    agg.appendMessage(srcTopic, msgJson('m-json-u0', srcTopic) as never, [blockJson('b-json-0', 'm-json-u0') as never])
    const branch = ok<{ branch: { id: string } }>(agg.createBranch(srcTopic, null, 'm-json-u0', 'L1') as never)
    const branchId = branch.branch.id
    agg.appendMessage(
      srcTopic,
      msgJson('m-json-b1', srcTopic, { content: 'branch-owned' }) as never,
      [blockJson('b-json-b1', 'm-json-b1') as never],
      undefined,
      undefined,
      { branchId }
    )
    agg.appendMessage(srcTopic, msgJson('m-json-u2', srcTopic) as never, [
      blockJson('b-json-file', 'm-json-u2', {
        type: 'file',
        content: null,
        file: { id: 'file-json-1', name: 'a.txt', path: '/tmp/a.txt', type: 'text/plain' }
      }) as never
    ])
    const exported = ok<{ payload: unknown }>(agg.exportTopicData({ topicId: srcTopic }) as never)

    // Drop the source capture so only the import is measured.
    sqlite.prepare('DELETE FROM sync_outbox').run()

    const imported = ok<{ topic: { id: string }; branchCount: number }>(
      agg.importTopicData({ payload: exported.payload, assistantId: 'assistant-import' } as never) as never
    )
    expect(imported.branchCount).toBe(1)

    const repos = createRepositories(db)
    const newBranches = repos.branches.listByTopic(imported.topic.id)
    expect(newBranches).toHaveLength(1)
    const newBranchId = newBranches[0].id
    const newMessages = repos.messages.listAllByTopic(imported.topic.id)
    const branchOwned = newMessages.find((m) => m.branchId === newBranchId)
    expect(branchOwned).toBeDefined()

    const outbox = db
      .select({
        entityType: schema.syncOutbox.entityType,
        entityId: schema.syncOutbox.entityId,
        op: schema.syncOutbox.op,
        payloadJson: schema.syncOutbox.payloadJson
      })
      .from(schema.syncOutbox)
      .all()

    // Every imported branch node is captured.
    expect(outbox.some((r) => r.entityType === 'topic_branch' && r.entityId === newBranchId)).toBe(true)
    // Branch-owned message captured with its immutable owner in the payload.
    const branchMsgOp = outbox.find((r) => r.entityType === 'message' && r.entityId === branchOwned!.id)
    expect(branchMsgOp).toBeDefined()
    expect(JSON.parse(branchMsgOp!.payloadJson as string).branchId).toBe(newBranchId)
    // Membership clock binds the branch owner (not the topic).
    const membership = sqlite
      .prepare('SELECT parent_id FROM sync_membership_clock WHERE child_entity_id = ?')
      .get(branchOwned!.id) as { parent_id: string } | undefined
    expect(membership?.parent_id).toBe(newBranchId)
    // Branch suffix frame captured (empty suffix for this branch).
    const frames = outbox.filter((r) => r.op === 'order_frame')
    expect(frames.length).toBeGreaterThan(0)

    // Supported local attachment: durable capture intent + no shell block op.
    const fileBlock = newMessages.flatMap((m) => repos.blocks.listByMessage(m.id)).find((b) => b.type === 'file')
    expect(fileBlock).toBeDefined()
    const intent = sqlite
      .prepare('SELECT block_id, file_id FROM sync_attachment_capture_intent WHERE block_id = ?')
      .get(fileBlock!.id) as { block_id: string; file_id: string } | undefined
    expect(intent?.file_id).toBe('file-json-1')
    expect(outbox.some((r) => r.entityType === 'message_block' && r.entityId === fileBlock!.id)).toBe(false)
    // File reference identity survives import (bytes resolve later via drain).
    const ref = sqlite.prepare('SELECT file_id FROM file_references WHERE block_id = ?').get(fileBlock!.id) as
      | { file_id: string }
      | undefined
    expect(ref?.file_id).toBe('file-json-1')

    // No device-local path leaks into any captured payload.
    for (const row of outbox) {
      const payload = row.payloadJson ?? ''
      expect(payload).not.toContain('/tmp/a.txt')
      expect(payload).not.toContain('filePath')
      expect(payload).not.toContain('"path"')
    }
  })

  it('keeps the portable result container through a JSON import (outbox payload + local rows)', () => {
    // One success assistant turn carrying a full portable result container plus
    // deliberately non-portable local-only keys that must never be captured.
    const srcTopic = 't-json-meta-src'
    const answerId = 'm-json-meta-answer'
    agg.appendMessage(
      srcTopic,
      msgJson(answerId, srcTopic, {
        role: 'assistant',
        model: { id: 'mock-model', name: 'Mock Model', group: 'Mock' },
        modelId: 'mock-model',
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        metrics: { completion_tokens: 7, time_completion_millsec: 900, time_first_token_millsec: 120 },
        mentions: [{ id: 'mock-model', name: 'Mock Model' }],
        useful: true,
        apiKey: 'sk-local-only-must-not-sync',
        pricing: { input_per_million_tokens: 3, output_per_million_tokens: 9, currencySymbol: '$' }
      }) as never,
      [
        blockJson('b-json-meta-think', answerId, {
          type: 'thinking',
          content: 'reasoning',
          thinking_millsec: 2200
        }) as never,
        blockJson('b-json-meta-text', answerId) as never
      ]
    )
    const exported = ok<{ payload: unknown }>(agg.exportTopicData({ topicId: srcTopic }) as never)
    sqlite.prepare('DELETE FROM sync_outbox').run()
    const imported = ok<{ topic: { id: string } }>(
      agg.importTopicData({ payload: exported.payload, assistantId: 'assistant-import' } as never) as never
    )

    const repos = createRepositories(db)
    const importedAnswer = repos.messages.listAllByTopic(imported.topic.id).find((m) => m.role === 'assistant')
    expect(importedAnswer).toBeDefined()
    const importedBlocks = repos.blocks.listByMessage(importedAnswer!.id)
    const thinking = importedBlocks.find((b) => b.type === 'thinking')
    // The measured thinking duration survives import locally (portable overflow).
    const thinkingMs = (thinking as unknown as { thinking_millsec?: number } | undefined)?.thinking_millsec
    expect(thinkingMs).toBe(2200)

    const outbox = db
      .select({
        entityType: schema.syncOutbox.entityType,
        entityId: schema.syncOutbox.entityId,
        payloadJson: schema.syncOutbox.payloadJson
      })
      .from(schema.syncOutbox)
      .all()

    // …and the sanitized container is what the outbox would hand a receiver.
    const messageOp = outbox.find((r) => r.entityType === 'message' && r.entityId === importedAnswer!.id)
    expect(messageOp, 'the imported answer must be captured').toBeDefined()
    const payload = JSON.parse(messageOp!.payloadJson as string) as Record<string, unknown>
    const resultMeta = payload.resultMeta as Record<string, unknown>
    expect(resultMeta, 'the captured message carries resultMeta').toBeDefined()
    expect(resultMeta.usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 })
    expect(resultMeta.metrics).toMatchObject({ completion_tokens: 7, time_completion_millsec: 900 })
    expect(resultMeta.mentions).toEqual([{ id: 'mock-model', name: 'Mock Model' }])
    expect(resultMeta.useful).toBe(true)
    expect(resultMeta.model).toMatchObject({ id: 'mock-model', name: 'Mock Model', group: 'Mock' })
    for (const forbidden of ['apiKey', 'pricing']) {
      expect(resultMeta[forbidden], `local-only ${forbidden} must never be captured`).toBeUndefined()
      expect(payload[forbidden], `local-only ${forbidden} must never be captured`).toBeUndefined()
    }

    const blockOp = outbox.find((r) => r.entityType === 'message_block' && r.entityId === thinking!.id)
    expect(blockOp, 'the thinking block must be captured').toBeDefined()
    const blockMeta = (JSON.parse(blockOp!.payloadJson as string) as Record<string, unknown>).resultMeta as Record<
      string,
      unknown
    >
    // Wire field name for the block's measured thinking duration.
    expect(blockMeta).toMatchObject({ thinkingMs: 2200 })
  })
})
