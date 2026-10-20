/**
 * Conditional usage-only write (`updateMessage` + `usageCondition`).
 *
 * The optional user-prompt token estimate is display metadata computed AFTER the
 * user message is persisted, so Main must decide inside ONE transaction whether
 * the result still describes the prompt. Real better-sqlite3, no repository mocks:
 * every case proves the row's actual authority state after the call.
 *
 *   - matching source, no usage          → applied, usage persisted
 *   - already-owned usage                → rejected 'usage-present', value kept
 *   - edited text / changed attachments  → rejected 'source-changed', still absent
 *   - reordered blocks                   → applied (order-insensitive multiset)
 *   - deleted target                     → rejected 'target-missing' (no throw)
 *   - assistant row                      → rejected 'not-user-message'
 *   - foreign route                      → fail-closed error (BRANCH-4)
 *   - ordinary patch                     → unchanged null result
 */
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
vi.mock('../../SpanCacheService', () => ({
  spanCacheService: { cleanTopic: mockCleanTopic }
}))

import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { runMigrations } from '../migration'
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-usage-'))
}

let counter = 0
function uid(): string {
  return `a${++counter}-${Date.now()}`
}

function okValue<T>(result: { ok: boolean; value?: T; error?: unknown }): T {
  if (!result.ok) throw new Error(`Expected success: ${JSON.stringify(result.error)}`)
  return result.value as T
}

const usage = { prompt_tokens: 4, completion_tokens: 4, total_tokens: 6 }

describe('updateMessage conditional usage write', () => {
  let tmpDir: string
  let sqlite: Database.Database
  let db: BetterSQLite3Database<typeof schema>
  let agg: ChatDbAggregateService

  beforeEach(() => {
    tmpDir = makeTempDir()
    sqlite = new Database(realPath.join(tmpDir, 'test.db'))
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
    } catch {
      // ignore
    }
    realFs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /** Append a user message with one MAIN_TEXT block (+ optional attachments). */
  function seedUserPrompt(options: { text?: string; fileIds?: string[]; branchId?: string | null } = {}): {
    topicId: string
    messageId: string
    textBlockId: string
  } {
    const topicId = `t-${uid()}`
    const messageId = `m-${uid()}`
    const textBlockId = `b-${uid()}`
    const blocks: Record<string, unknown>[] = [
      {
        id: textBlockId,
        messageId,
        type: 'main_text',
        content: options.text ?? 'hello',
        status: 'success',
        createdAt: new Date().toISOString()
      }
    ]
    for (const fileId of options.fileIds ?? []) {
      blocks.push({
        id: `b-${uid()}`,
        messageId,
        type: 'file',
        content: '',
        status: 'success',
        createdAt: new Date().toISOString(),
        file: { id: fileId, name: `${fileId}.txt`, path: `/tmp/${fileId}.txt`, type: 'text' }
      })
    }
    const result = agg.appendMessage(
      topicId,
      {
        id: messageId,
        topicId,
        role: 'user',
        content: options.text ?? 'hello',
        status: 'success',
        createdAt: new Date().toISOString()
      } as never,
      blocks as never,
      // Tail append: `undefined` insert index (Main rejects a literal -1 index).
      undefined,
      undefined,
      { branchId: options.branchId ?? null }
    )
    okValue(result)
    return { topicId, messageId, textBlockId }
  }

  function readMessage(topicId: string, messageId: string): Record<string, unknown> {
    const fetched = okValue(agg.fetchMessages(topicId))
    const row = (fetched.messages as Record<string, unknown>[]).find((m) => m.id === messageId)
    if (!row) throw new Error(`message ${messageId} not found`)
    return row
  }

  it('applies the usage when the source still matches and no usage exists', () => {
    const { topicId, messageId } = seedUserPrompt({ text: 'hello', fileIds: ['file-1'] })

    const outcome = okValue(
      agg.updateMessage(topicId, messageId, { usage } as never, {
        usageCondition: { textContents: ['hello'], fileIds: ['file-1'] }
      })
    )

    expect(outcome).toEqual({ applied: true })
    expect(readMessage(topicId, messageId).usage).toEqual(usage)
  })

  it('is order-insensitive for the estimated source (multiset comparison)', () => {
    const topicId = `t-${uid()}`
    const messageId = `m-${uid()}`
    okValue(
      agg.appendMessage(
        topicId,
        {
          id: messageId,
          topicId,
          role: 'user',
          content: 'firstsecond',
          status: 'success',
          createdAt: new Date().toISOString()
        } as never,
        [
          {
            id: `b-${uid()}`,
            messageId,
            type: 'main_text',
            content: 'first',
            status: 'success',
            sortOrder: 0,
            createdAt: new Date().toISOString()
          },
          {
            id: `b-${uid()}`,
            messageId,
            type: 'main_text',
            content: 'second',
            status: 'success',
            sortOrder: 1,
            createdAt: new Date().toISOString()
          }
        ] as never,
        undefined
      )
    )

    const outcome = okValue(
      agg.updateMessage(topicId, messageId, { usage } as never, {
        usageCondition: { textContents: ['second', 'first'], fileIds: [] }
      })
    )
    expect(outcome).toEqual({ applied: true })
    expect(readMessage(topicId, messageId).usage).toEqual(usage)
  })

  it('rejects when usage is already owned, keeping the existing value', () => {
    const { topicId, messageId } = seedUserPrompt({ text: 'hello' })
    const owned = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 1 }
    okValue(agg.updateMessage(topicId, messageId, { usage: owned } as never))

    const outcome = okValue(
      agg.updateMessage(topicId, messageId, { usage } as never, {
        usageCondition: { textContents: ['hello'], fileIds: [] }
      })
    )

    expect(outcome).toEqual({ applied: false, rejection: 'usage-present' })
    expect(readMessage(topicId, messageId).usage).toEqual(owned)
  })

  it('rejects an estimate whose text source changed (edited prompt), leaving usage absent', () => {
    const { topicId, messageId, textBlockId } = seedUserPrompt({ text: 'original prompt' })
    // The user edits the prompt (message content + its MAIN_TEXT block) before
    // the estimate lands — the real edit path writes both.
    okValue(
      agg.updateMessageAndBlocks(
        topicId,
        { id: messageId, content: 'edited prompt' } as never,
        [
          {
            id: textBlockId,
            messageId,
            type: 'main_text',
            content: 'edited prompt',
            status: 'success'
          }
        ] as never
      )
    )

    const outcome = okValue(
      agg.updateMessage(topicId, messageId, { usage } as never, {
        usageCondition: { textContents: ['original prompt'], fileIds: [] }
      })
    )

    expect(outcome).toEqual({ applied: false, rejection: 'source-changed' })
    expect(readMessage(topicId, messageId).usage).toBeUndefined()
  })

  it('rejects an estimate whose attachment set changed (attachment removed)', () => {
    const { topicId, messageId } = seedUserPrompt({ text: 'with file', fileIds: ['file-1'] })

    const outcome = okValue(
      agg.updateMessage(
        topicId,
        messageId,
        { usage } as never,
        // The estimate was taken with the attachment; the authority prompt no
        // longer has it.
        { usageCondition: { textContents: ['with file'], fileIds: ['file-1', 'file-2'] } }
      )
    )

    expect(outcome).toEqual({ applied: false, rejection: 'source-changed' })
    expect(readMessage(topicId, messageId).usage).toBeUndefined()
  })

  it('rejects a deleted target as a no-op (no throw, nothing recreated)', () => {
    const { topicId, messageId } = seedUserPrompt({ text: 'gone soon' })
    okValue(agg.deleteMessage(topicId, messageId))

    const outcome = okValue(
      agg.updateMessage(topicId, messageId, { usage } as never, {
        usageCondition: { textContents: ['gone soon'], fileIds: [] }
      })
    )

    expect(outcome).toEqual({ applied: false, rejection: 'target-missing' })
    expect(okValue(agg.fetchMessages(topicId)).messages).toHaveLength(0)
  })

  it('rejects a non-user row', () => {
    const topicId = `t-${uid()}`
    const messageId = `m-${uid()}`
    okValue(
      agg.appendMessage(
        topicId,
        {
          id: messageId,
          topicId,
          role: 'assistant',
          content: '',
          status: 'success',
          askId: 'user-1',
          createdAt: new Date().toISOString()
        } as never,
        []
      )
    )

    const outcome = okValue(
      agg.updateMessage(topicId, messageId, { usage } as never, { usageCondition: { textContents: [], fileIds: [] } })
    )

    expect(outcome).toEqual({ applied: false, rejection: 'not-user-message' })
    expect(readMessage(topicId, messageId).usage).toBeUndefined()
  })

  it('fails closed when the message is addressed through another route', () => {
    // Main-route owned row addressed through a branch route: the BRANCH-4 owner
    // equality guard rejects (never silently ok), and no usage is written.
    const { topicId, messageId } = seedUserPrompt({ text: 'main owned' })

    const result = agg.updateMessage(topicId, messageId, { usage } as never, {
      branchId: 'branch-1',
      usageCondition: { textContents: ['main owned'], fileIds: [] }
    })

    expect(result.ok).toBe(false)
    expect(readMessage(topicId, messageId).usage).toBeUndefined()
  })

  it('leaves the ordinary unconditional patch unchanged (null result)', () => {
    const { topicId, messageId } = seedUserPrompt({ text: 'plain' })

    const outcome = okValue(agg.updateMessage(topicId, messageId, { content: 'updated' } as never))

    expect(outcome).toBeNull()
    expect(readMessage(topicId, messageId).content).toBe('updated')
  })
})
