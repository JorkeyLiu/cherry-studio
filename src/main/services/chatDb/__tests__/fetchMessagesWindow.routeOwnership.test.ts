/**
 * fetchMessagesWindow around route-ownership symmetry.
 *
 * Root fix: main around must validate the anchor against the main effective
 * sequence (owner equality), symmetric with the branch path (effective
 * findIndex). A branch-owned suffix ID fails typed NOT_FOUND on main; a
 * main-owned post-fork ID fails typed NOT_FOUND on a descendant branch that
 * does not reference it. Own exclusive IDs return windows containing anchor.
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
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { runMigrations } from '../migration'
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-window-owner-'))
}
function rmrf(dir: string): void {
  realFs.rmSync(dir, { recursive: true, force: true })
}
function openFileDb(): { sqlite: Database.Database; db: BetterSQLite3Database<typeof schema>; dir: string } {
  const dir = makeTempDir()
  const sqlite = new Database(realPath.join(dir, 'chat.db'))
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  return { sqlite, db, dir }
}
function failError(result: { ok: boolean; error?: { code?: string } }): { code?: string } {
  return (result as { ok: false; error: { code?: string } }).error ?? {}
}
function okValue<T>(result: { ok: boolean; value?: T; error?: unknown }): T {
  if (!isSuccess(result as never)) throw new Error(`Expected success: ${JSON.stringify(result)}`)
  return (result as { value: T }).value
}
function msgJson(id: string, topicId: string): Record<string, unknown> {
  return {
    id,
    topicId,
    role: 'user',
    content: `content-${id}`,
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
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
function seedTopic(agg: ChatDbAggregateService, topicId: string, ids: string[]): void {
  expect(agg.ensureTopic(topicId, 'assistant-1', `topic-${topicId}`).ok).toBe(true)
  for (const id of ids) {
    expect(agg.appendMessage(topicId, msgJson(id, topicId) as never, [blockJson(`b-${id}`, id) as never]).ok).toBe(true)
  }
}
function seedBranchSuffix(agg: ChatDbAggregateService, topicId: string, branchId: string, ids: string[]): void {
  for (const id of ids) {
    expect(
      agg.appendMessage(
        topicId,
        msgJson(id, topicId) as never,
        [blockJson(`b-${id}`, id) as never],
        undefined,
        undefined,
        {
          branchId
        } as never
      ).ok
    ).toBe(true)
  }
}

describe('fetchMessagesWindow around route ownership', () => {
  let sqlite: Database.Database
  let db: BetterSQLite3Database<typeof schema>
  let agg: ChatDbAggregateService
  let dir: string

  beforeEach(() => {
    const opened = openFileDb()
    sqlite = opened.sqlite
    db = opened.db
    dir = opened.dir
    runMigrations(db, sqlite)
    agg = new ChatDbAggregateService(db, sqlite)
  })
  afterEach(() => {
    try {
      sqlite.close()
    } catch {}
    rmrf(dir)
  })

  it('main around a branch-owned suffix ID rejects typed NOT_FOUND (no mixed window)', () => {
    seedTopic(agg, 't1', ['m0', 'm1', 'm2'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm1', 'B1')).branch as { id: string }).id
    seedBranchSuffix(agg, 't1', b1, ['b-owned-0'])
    const res = agg.fetchMessagesWindow({
      kind: 'around',
      topicId: 't1',
      anchorMessageId: 'b-owned-0',
      before: 10,
      after: 10
    })
    expect(res.ok).toBe(false)
    expect(failError(res).code).toBe('NOT_FOUND')
  })

  it('branch around a main-owned post-fork ID rejects typed NOT_FOUND', () => {
    seedTopic(agg, 't1', ['m0', 'm1', 'm2-post'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm1', 'B1')).branch as { id: string }).id
    seedBranchSuffix(agg, 't1', b1, ['b-owned-0'])
    const res = agg.fetchMessagesWindow({
      kind: 'around',
      topicId: 't1',
      branchId: b1,
      anchorMessageId: 'm2-post',
      before: 10,
      after: 10
    })
    expect(res.ok).toBe(false)
    expect(failError(res).code).toBe('NOT_FOUND')
  })

  it('main around its own exclusive post-fork ID returns a window containing the anchor', () => {
    seedTopic(agg, 't1', ['m0', 'm1', 'm2-post'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm1', 'B1')).branch as { id: string }).id
    seedBranchSuffix(agg, 't1', b1, ['b-owned-0'])
    const res = okValue(
      agg.fetchMessagesWindow({ kind: 'around', topicId: 't1', anchorMessageId: 'm2-post', before: 10, after: 10 })
    )
    expect(res.window.anchorMessageId).toBe('m2-post')
    expect(res.messages.map((m) => (m as { id: string }).id)).toContain('m2-post')
    expect(res.messages.map((m) => (m as { id: string }).id)).not.toContain('b-owned-0')
  })

  it('branch around its own exclusive suffix ID returns a window containing the anchor and excluding foreign main suffix', () => {
    seedTopic(agg, 't1', ['m0', 'm1', 'm2-post'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm1', 'B1')).branch as { id: string }).id
    seedBranchSuffix(agg, 't1', b1, ['b-owned-0'])
    const res = okValue(
      agg.fetchMessagesWindow({
        kind: 'around',
        topicId: 't1',
        branchId: b1,
        anchorMessageId: 'b-owned-0',
        before: 10,
        after: 10
      })
    )
    expect(res.window.anchorMessageId).toBe('b-owned-0')
    expect(res.messages.map((m) => (m as { id: string }).id)).toContain('b-owned-0')
    expect(res.messages.map((m) => (m as { id: string }).id)).not.toContain('m2-post')
  })

  it('shared fork anchor stays addressable from both routes', () => {
    seedTopic(agg, 't1', ['m0', 'm1', 'm2-post'])
    const b1 = (okValue(agg.createBranch('t1', null, 'm1', 'B1')).branch as { id: string }).id
    seedBranchSuffix(agg, 't1', b1, ['b-owned-0'])
    const onMain = okValue(
      agg.fetchMessagesWindow({ kind: 'around', topicId: 't1', anchorMessageId: 'm1', before: 10, after: 10 })
    )
    expect(onMain.messages.map((m) => (m as { id: string }).id)).toContain('m1')
    const onBranch = okValue(
      agg.fetchMessagesWindow({
        kind: 'around',
        topicId: 't1',
        branchId: b1,
        anchorMessageId: 'm1',
        before: 10,
        after: 10
      })
    )
    expect(onBranch.messages.map((m) => (m as { id: string }).id)).toContain('m1')
  })
})
