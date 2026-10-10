/**
 * listLiveAssistantTopics — pure authoritative read-only directory.
 * Real better-sqlite3, no mocks. Proves: ALL live topics in
 * (createdAt, id) order, soft-deleted + foreign-assistant rows excluded,
 * zero mutation (counts + timestamps unchanged), unknown assistant reads
 * empty without creating, and owner lookup resolves without writes.
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

import { isSuccess } from '@shared/chatDb'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { runMigrations } from '../migration'
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-list-live-'))
}
function rmrf(dir: string): void {
  realFs.rmSync(dir, { recursive: true, force: true })
}

describe('listLiveAssistantTopics', () => {
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
    rmrf(tmpDir)
  })

  function countTopics(): number {
    const row = sqlite.prepare('SELECT COUNT(*) as c FROM topics').get() as { c: number }
    return row.c
  }

  it('returns ALL 4 live topics vs a stale Redux-1 projection, excluding soft-deleted and foreign rows', () => {
    for (const id of ['t-live-1', 't-live-2', 't-live-3', 't-live-4']) {
      expect(agg.ensureTopic(id, 'a-9', `Name-${id}`).ok).toBe(true)
    }
    expect(agg.ensureTopic('t-dead-1', 'a-9', 'Dead').ok).toBe(true)
    expect(agg.softDeleteTopic('t-dead-1', 'Dead').ok).toBe(true)
    expect(agg.ensureTopic('t-foreign-1', 'a-other', 'Foreign').ok).toBe(true)

    const before = sqlite
      .prepare("SELECT id, updated_at as updatedAt FROM topics WHERE assistant_id = 'a-9' ORDER BY id")
      .all() as Array<{ id: string; updatedAt: string }>

    const res = agg.listLiveAssistantTopics('a-9')
    expect(res.ok).toBe(true)
    if (!isSuccess(res)) throw new Error('expected success')
    expect(res.value.assistantId).toBe('a-9')
    expect(res.value.topics.map((t) => t.id)).toEqual(['t-live-1', 't-live-2', 't-live-3', 't-live-4'])

    // Pure read: no rows added/removed, no stale overwrite of timestamps.
    expect(countTopics()).toBe(6)
    const after = sqlite
      .prepare("SELECT id, updated_at as updatedAt FROM topics WHERE assistant_id = 'a-9' ORDER BY id")
      .all() as Array<{ id: string; updatedAt: string }>
    expect(after).toEqual(before)
  })

  it('unknown assistant reads authoritative empty without creating (no resurrection)', () => {
    const res = agg.listLiveAssistantTopics('a-missing')
    expect(res.ok).toBe(true)
    if (!isSuccess(res)) throw new Error('expected success')
    expect(res.value.topics).toEqual([])
    expect(countTopics()).toBe(0)
  })

  it('rejects empty assistantId without touching storage', () => {
    const res = agg.listLiveAssistantTopics('')
    expect(res.ok).toBe(false)
    expect(countTopics()).toBe(0)
  })

  it('getTopicAssistantId resolves the owner without writes', () => {
    expect(agg.ensureTopic('t-own-1', 'a-own', 'Owned').ok).toBe(true)
    expect(agg.getTopicAssistantId('t-own-1')).toBe('a-own')
    expect(agg.getTopicAssistantId('t-nope')).toBeNull()
    expect(countTopics()).toBe(1)
  })
})
