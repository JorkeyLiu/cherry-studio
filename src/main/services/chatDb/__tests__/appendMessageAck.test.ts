/**
 * appendMessage Main-issued creation acknowledgment.
 *
 * - A genuinely new owned row returns the normalized addressed route, the
 *   authoritative row identity, and the created/capability delta limited to
 *   that row — derived in the same root transaction.
 * - An existing same-route id patches in place and returns an empty delta.
 * - A non-owner existing id through another route fails closed
 *   (VALIDATION_ERROR) with zero mutation and no acknowledgment.
 * - Owner appends stay allowed while a live descendant references the prefix.
 * - Every success envelope validates against the shared result contract.
 */
import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import type { ChatDbFailure, ChatDbResult } from '@shared/chatDb'
import { isFailure, isSuccess, validateChatDbResult } from '@shared/chatDb'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')
vi.mock('@main/config', () => ({ DATA_PATH: '/mock/data' }))
const configStore = new Map<string, unknown>()
vi.mock('@main/services/ConfigManager', () => ({
  configManager: {
    get: (k: string, def?: unknown) => (configStore.has(k) ? configStore.get(k) : def),
    set: (k: string, v: unknown) => configStore.set(k, v),
    has: (k: string) => configStore.has(k)
  },
  ConfigKeys: {}
}))
vi.mock('../../SpanCacheService', () => ({
  spanCacheService: { cleanTopic: vi.fn().mockResolvedValue(undefined) }
}))

import { seedRegisteredAttachedSyncService } from '../../sync/__tests__/helpers/syncTestRegistration'
import { chatDbService } from '..'
import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { runMigrations } from '../migration'
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-append-ack-'))
}
function rmrf(dir: string): void {
  realFs.rmSync(dir, { recursive: true, force: true })
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
function blockJson(id: string, messageId: string): Record<string, unknown> {
  return {
    id,
    messageId,
    type: 'main_text',
    content: `block-${id}`,
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}
function expectSuccess<T>(r: ChatDbResult<T>): asserts r is { ok: true; value: T } {
  expect(r.ok).toBe(true)
  if (r.ok !== true) throw new Error(`expected success, got: ${JSON.stringify(r.error)}`)
}

function expectFailure<T>(r: ChatDbResult<T>): asserts r is ChatDbFailure {
  expect(r.ok).toBe(false)
  if (r.ok !== false) throw new Error('expected failure, got success')
}

function branchOf(sqlite: Database.Database, id: string): string | null | undefined {
  const row = sqlite.prepare('SELECT branch_id AS b FROM messages WHERE id=?').get(id) as
    | { b: string | null }
    | undefined
  return row?.b
}

describe('appendMessage creation acknowledgment', () => {
  let sqlite: Database.Database
  let db: BetterSQLite3Database<typeof schema>
  let agg: ChatDbAggregateService
  let dir: string
  beforeEach(() => {
    configStore.clear()
    const openedDir = makeTempDir()
    const openedSqlite = new Database(realPath.join(openedDir, 'chat.db'))
    openedSqlite.pragma('journal_mode = WAL')
    openedSqlite.pragma('foreign_keys = ON')
    const openedDb = drizzle(openedSqlite, { schema })
    runMigrations(openedDb as never, openedSqlite)
    sqlite = openedSqlite
    db = openedDb
    dir = openedDir
    ;(chatDbService as unknown as { sqlite: unknown }).sqlite = sqlite
    ;(chatDbService as unknown as { db: unknown }).db = db
    seedRegisteredAttachedSyncService(configStore as never, db)
    agg = new ChatDbAggregateService(db, sqlite)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    try {
      sqlite.close()
    } catch {}
    rmrf(dir)
    ;(chatDbService as never as { sqlite: unknown }).sqlite = null
    ;(chatDbService as never as { db: unknown }).db = null
  })

  it('acknowledges a new main owner row with route, identity, and delta', () => {
    expect(agg.ensureTopic('t1', 'assistant-1', 'topic-t1').ok).toBe(true)
    const res = agg.appendMessage('t1', msgJson('m0', 't1') as never, [blockJson('b-m0', 'm0') as never])
    expectSuccess(res)
    if (!isSuccess(res)) throw new Error('expected success')
    expect(res.value).toEqual({
      topicId: 't1',
      branchId: null,
      messageId: 'm0',
      createdMessageIds: ['m0'],
      mutableMessageIds: ['m0']
    })
    expect(branchOf(sqlite, 'm0')).toBeNull()
    expect(() => validateChatDbResult('chatdb:append-message', res)).not.toThrow()
  })

  it('treats an explicitly pinned null branchId as the main route', () => {
    expect(agg.ensureTopic('t1', 'assistant-1', 'topic-t1').ok).toBe(true)
    const res = agg.appendMessage('t1', msgJson('m0', 't1') as never, [], undefined, undefined, { branchId: null })
    expectSuccess(res)
    if (!isSuccess(res)) throw new Error('expected success')
    expect(res.value.branchId).toBeNull()
    expect(res.value.createdMessageIds).toEqual(['m0'])
    expect(branchOf(sqlite, 'm0')).toBeNull()
  })

  it('acknowledges a new branch-owned row with the branch echo', () => {
    expect(agg.ensureTopic('t1', 'assistant-1', 'topic-t1').ok).toBe(true)
    expect(agg.appendMessage('t1', msgJson('m0', 't1') as never, []).ok).toBe(true)
    const created = agg.createBranch('t1', null, 'm0', 'B1')
    expectSuccess(created)
    if (!isSuccess(created)) throw new Error('expected branch')
    const b1 = (created.value.branch as { id: string }).id
    const res = agg.appendMessage('t1', msgJson('c0', 't1') as never, [], undefined, undefined, { branchId: b1 })
    expectSuccess(res)
    if (!isSuccess(res)) throw new Error('expected success')
    expect(res.value).toEqual({
      topicId: 't1',
      branchId: b1,
      messageId: 'c0',
      createdMessageIds: ['c0'],
      mutableMessageIds: ['c0']
    })
    expect(branchOf(sqlite, 'c0')).toBe(b1)
    expect(() => validateChatDbResult('chatdb:append-message', res)).not.toThrow()
  })

  it('returns an empty delta when patching a pre-existing same-route id', () => {
    expect(agg.ensureTopic('t1', 'assistant-1', 'topic-t1').ok).toBe(true)
    expect(agg.appendMessage('t1', msgJson('m0', 't1') as never, []).ok).toBe(true)
    const res = agg.appendMessage('t1', msgJson('m0', 't1', { content: 'patched' }) as never, [])
    expectSuccess(res)
    if (!isSuccess(res)) throw new Error('expected success')
    expect(res.value).toEqual({
      topicId: 't1',
      branchId: null,
      messageId: 'm0',
      createdMessageIds: [],
      mutableMessageIds: []
    })
    const row = sqlite.prepare('SELECT content AS c FROM messages WHERE id=?').get('m0') as { c: string }
    expect(row.c).toBe('patched')
    expect(() => validateChatDbResult('chatdb:append-message', res)).not.toThrow()
  })

  it('rejects a non-owner existing id through another route with zero mutation', () => {
    expect(agg.ensureTopic('t1', 'assistant-1', 'topic-t1').ok).toBe(true)
    expect(agg.appendMessage('t1', msgJson('m0', 't1') as never, []).ok).toBe(true)
    const created = agg.createBranch('t1', null, 'm0', 'B1')
    expectSuccess(created)
    if (!isSuccess(created)) throw new Error('expected branch')
    const b1 = (created.value.branch as { id: string }).id
    const res = agg.appendMessage('t1', msgJson('m0', 't1', { content: 'evil' }) as never, [], undefined, undefined, {
      branchId: b1
    })
    expectFailure(res)
    if (!isFailure(res)) throw new Error('expected failure')
    expect(res.error.code).toBe('VALIDATION_ERROR')
    const row = sqlite.prepare('SELECT content AS c FROM messages WHERE id=?').get('m0') as { c: string }
    expect(row.c).toBe('content-m0')
    expect(branchOf(sqlite, 'm0')).toBeNull()
  })

  it('still acknowledges a new owner row while a live descendant references the prefix', () => {
    expect(agg.ensureTopic('t1', 'assistant-1', 'topic-t1').ok).toBe(true)
    expect(agg.appendMessage('t1', msgJson('m0', 't1') as never, []).ok).toBe(true)
    expect(agg.appendMessage('t1', msgJson('m1', 't1') as never, []).ok).toBe(true)
    const created = agg.createBranch('t1', null, 'm1', 'B1')
    expectSuccess(created)
    if (!isSuccess(created)) throw new Error('expected branch')
    const b1 = (created.value.branch as { id: string }).id
    expect(agg.appendMessage('t1', msgJson('c0', 't1') as never, [], undefined, undefined, { branchId: b1 }).ok).toBe(
      true
    )
    // The owner appends a genuinely new main row after the fork: acknowledged.
    const res = agg.appendMessage('t1', msgJson('m2', 't1') as never, [])
    expectSuccess(res)
    if (!isSuccess(res)) throw new Error('expected success')
    expect(res.value.createdMessageIds).toEqual(['m2'])
    expect(res.value.mutableMessageIds).toEqual(['m2'])
    expect(res.value.branchId).toBeNull()
    expect(branchOf(sqlite, 'm2')).toBeNull()
    expect(() => validateChatDbResult('chatdb:append-message', res)).not.toThrow()
  })

  it('rejects an unknown branch with zero writes and no acknowledgment', () => {
    expect(agg.ensureTopic('t1', 'assistant-1', 'topic-t1').ok).toBe(true)
    const res = agg.appendMessage(
      't1',
      msgJson('m0', 't1') as never,
      [blockJson('b-m0', 'm0') as never],
      undefined,
      undefined,
      {
        branchId: 'missing-branch'
      }
    )
    expectFailure(res)
    if (!isFailure(res)) throw new Error('expected failure')
    expect(sqlite.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).toEqual({ c: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS c FROM message_blocks').get() as { c: number }).toEqual({ c: 0 })
  })

  it('rejects a foreign-topic branch with zero writes and no acknowledgment', () => {
    expect(agg.ensureTopic('t1', 'assistant-1', 'topic-t1').ok).toBe(true)
    expect(agg.ensureTopic('t2', 'assistant-1', 'topic-t2').ok).toBe(true)
    expect(agg.appendMessage('t1', msgJson('m0', 't1') as never, []).ok).toBe(true)
    const created = agg.createBranch('t1', null, 'm0', 'B1')
    expectSuccess(created)
    if (!isSuccess(created)) throw new Error('expected branch')
    const b1 = (created.value.branch as { id: string }).id
    const res = agg.appendMessage(
      't2',
      msgJson('x0', 't2') as never,
      [blockJson('b-x0', 'x0') as never],
      undefined,
      undefined,
      {
        branchId: b1
      }
    )
    expectFailure(res)
    if (!isFailure(res)) throw new Error('expected failure')
    expect(branchOf(sqlite, 'x0')).toBeUndefined()
  })

  it('rejects a deleted branch with zero writes and no acknowledgment', () => {
    expect(agg.ensureTopic('t1', 'assistant-1', 'topic-t1').ok).toBe(true)
    expect(agg.appendMessage('t1', msgJson('m0', 't1') as never, []).ok).toBe(true)
    const created = agg.createBranch('t1', null, 'm0', 'B1')
    expectSuccess(created)
    if (!isSuccess(created)) throw new Error('expected branch')
    const b1 = (created.value.branch as { id: string }).id
    expect(agg.deleteBranch('t1', b1).ok).toBe(true)
    const res = agg.appendMessage('t1', msgJson('c0', 't1') as never, [], undefined, undefined, { branchId: b1 })
    expectFailure(res)
    if (!isFailure(res)) throw new Error('expected failure')
    expect(branchOf(sqlite, 'c0')).toBeUndefined()
  })

  it('rejects a branch append into a trashed topic with zero writes', () => {
    expect(agg.ensureTopic('t1', 'assistant-1', 'topic-t1').ok).toBe(true)
    expect(agg.appendMessage('t1', msgJson('m0', 't1') as never, []).ok).toBe(true)
    const created = agg.createBranch('t1', null, 'm0', 'B1')
    expectSuccess(created)
    if (!isSuccess(created)) throw new Error('expected branch')
    const b1 = (created.value.branch as { id: string }).id
    expect(agg.softDeleteTopic('t1').ok).toBe(true)
    const res = agg.appendMessage(
      't1',
      msgJson('c0', 't1') as never,
      [blockJson('b-c0', 'c0') as never],
      undefined,
      undefined,
      { branchId: b1 }
    )
    expectFailure(res)
    if (!isFailure(res)) throw new Error('expected failure')
    expect(branchOf(sqlite, 'c0')).toBeUndefined()
    expect(sqlite.prepare('SELECT COUNT(*) AS c FROM message_blocks WHERE id=?').get('b-c0') as { c: number }).toEqual({
      c: 0
    })
  })

  it('still acknowledges a main append on a soft-deleted topic (existing frame semantics)', () => {
    expect(agg.ensureTopic('t1', 'assistant-1', 'topic-t1').ok).toBe(true)
    expect(agg.appendMessage('t1', msgJson('m0', 't1') as never, []).ok).toBe(true)
    expect(agg.softDeleteTopic('t1').ok).toBe(true)
    const res = agg.appendMessage('t1', msgJson('m1', 't1') as never, [blockJson('b-m1', 'm1') as never])
    expectSuccess(res)
    if (!isSuccess(res)) throw new Error('expected success')
    expect(res.value.branchId).toBeNull()
    expect(res.value.createdMessageIds).toEqual(['m1'])
    expect(branchOf(sqlite, 'm1')).toBeNull()
    expect(() => validateChatDbResult('chatdb:append-message', res)).not.toThrow()
  })

  it('rejects a branch append with a missing anchor with zero writes', () => {
    expect(agg.ensureTopic('t1', 'assistant-1', 'topic-t1').ok).toBe(true)
    expect(agg.appendMessage('t1', msgJson('m0', 't1') as never, []).ok).toBe(true)
    const created = agg.createBranch('t1', null, 'm0', 'B1')
    expectSuccess(created)
    if (!isSuccess(created)) throw new Error('expected branch')
    const b1 = (created.value.branch as { id: string }).id
    expect(agg.deleteMessage('t1', 'm0').ok).toBe(true)
    const res = agg.appendMessage(
      't1',
      msgJson('c0', 't1') as never,
      [blockJson('b-c0', 'c0') as never],
      undefined,
      undefined,
      { branchId: b1 }
    )
    expectFailure(res)
    if (!isFailure(res)) throw new Error('expected failure')
    expect(branchOf(sqlite, 'c0')).toBeUndefined()
    expect(sqlite.prepare('SELECT COUNT(*) AS c FROM message_blocks WHERE id=?').get('b-c0') as { c: number }).toEqual({
      c: 0
    })
  })
})
