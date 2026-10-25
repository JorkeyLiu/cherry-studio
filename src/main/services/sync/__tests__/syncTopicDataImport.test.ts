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
})
