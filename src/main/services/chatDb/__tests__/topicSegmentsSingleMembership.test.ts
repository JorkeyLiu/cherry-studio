/**
 * Single-membership writer guards: a message belongs to at most one group.
 * addMessages / replaceMessageIds reject any id already filed under a
 * different group with zero writes (ChatDbValidationError); upsertSegment and
 * replaceSegmentMembership inherit the same atomic rejection through the
 * repository choke point. Same-group rewrites stay allowed.
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

import { isSuccess } from '@shared/chatDb'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { ChatDbValidationError } from '../errors'
import { runMigrations } from '../migration'
import { createRepositories } from '../repository/factory'
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-seg-single-'))
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
  return `s${++counter}-${Date.now()}`
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
    id: `m-${uid()}`,
    topicId,
    role: 'user',
    content: 'Hello',
    status: 'success',
    createdAt: new Date().toISOString(),
    ...overrides
  }
}

describe('topic segment single-membership writer guards', () => {
  let sqlite: Database.Database
  let db: BetterSQLite3Database<typeof schema>
  let agg: ChatDbAggregateService
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir()
    const dbPath = realPath.join(tmpDir, 'chat.db')
    sqlite = openTestDb(dbPath)
    db = wrapDrizzle(sqlite)
    runMigrations(db, sqlite)
    agg = new ChatDbAggregateService(db, sqlite)
  })

  afterEach(() => {
    sqlite.close()
    rmrf(tmpDir)
  })

  function seedTopicWithGroups(): { topic: string; m0: string; m1: string; m2: string; segA: string; segB: string } {
    const topic = `t-${uid()}`
    const m0 = `m0-${uid()}`
    const m1 = `m1-${uid()}`
    const m2 = `m2-${uid()}`
    agg.appendMessage(topic, makeMessageJson(topic, { id: m0 }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: m1 }) as any, [])
    agg.appendMessage(topic, makeMessageJson(topic, { id: m2 }) as any, [])
    const segA = `seg-a-${uid()}`
    const segB = `seg-b-${uid()}`
    okValue(agg.upsertSegment({ segmentId: segA, topicId: topic, name: 'A', messageIds: [m0, m1], branchId: null }))
    okValue(agg.upsertSegment({ segmentId: segB, topicId: topic, name: 'B', messageIds: [m2], branchId: null }))
    return { topic, m0, m1, m2, segA, segB }
  }

  function memberIds(segmentId: string): string[] {
    return createRepositories(db).segments.getMessageIds(segmentId)
  }

  it('addMessages rejects a foreign-filed id with zero writes', () => {
    const { m1, m2, segA, segB } = seedTopicWithGroups()
    const repos = createRepositories(db)
    expect(() => repos.segments.addMessages(segB, [m1])).toThrow(ChatDbValidationError)
    // Zero writes: neither group changed.
    expect(memberIds(segB)).toEqual([m2])
    expect(memberIds(segA)).toContain(m1)
  })

  it('replaceMessageIds rejects a foreign-filed id and keeps existing membership', () => {
    const { m0, m1, m2, segA, segB } = seedTopicWithGroups()
    const repos = createRepositories(db)
    expect(() => repos.segments.replaceMessageIds(segB, [m0, m2])).toThrow(ChatDbValidationError)
    expect(memberIds(segB)).toEqual([m2])
    expect(memberIds(segA)).toEqual([m0, m1])
  })

  it('upsertSegment rejects a new group sharing a member (atomic, no group created)', () => {
    const { topic, m1, m2, segA } = seedTopicWithGroups()
    const segC = `seg-c-${uid()}`
    const result = agg.upsertSegment({
      segmentId: segC,
      topicId: topic,
      name: 'C',
      messageIds: [m1, m2],
      branchId: null
    })
    expect(result.ok).toBe(false)
    expect(failCode(result)).toBe('VALIDATION_ERROR')
    expect(createRepositories(db).segments.getById(segC).found).toBe(false)
    expect(memberIds(segA)).toContain(m1)
  })

  it('replaceSegmentMembership rejects a foreign-filed id and keeps existing membership', () => {
    const { m0, m2, segB } = seedTopicWithGroups()
    const result = agg.replaceSegmentMembership({ segmentId: segB, messageIds: [m0, m2], branchId: null })
    expect(result.ok).toBe(false)
    expect(failCode(result)).toBe('VALIDATION_ERROR')
    expect(memberIds(segB)).toEqual([m2])
  })

  it('same-group rewrites stay allowed (idempotent add, identical replace)', () => {
    const { m2, segB } = seedTopicWithGroups()
    const repos = createRepositories(db)
    expect(repos.segments.addMessages(segB, [m2])).toEqual({ affected: 0 })
    expect(memberIds(segB)).toEqual([m2])
    expect(() => repos.segments.replaceMessageIds(segB, [m2])).not.toThrow()
    expect(memberIds(segB)).toEqual([m2])
  })
})
