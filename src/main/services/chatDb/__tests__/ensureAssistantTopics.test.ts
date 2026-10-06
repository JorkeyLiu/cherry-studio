/**
 * ensureAssistantTopics — atomic find-or-create for one ordinary assistant.
 * Real better-sqlite3, no mocks. Covers spec A/D Main behavior.
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
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-ensure-asst-'))
}
function rmrf(dir: string): void {
  realFs.rmSync(dir, { recursive: true, force: true })
}

describe('ensureAssistantTopics', () => {
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

  it('true-empty creates ONE default topic from the candidate', () => {
    const res = agg.ensureAssistantTopics('a-1', 't-cand-1', 'Default Topic')
    expect(res.ok).toBe(true)
    if (!isSuccess(res)) throw new Error('expected success')
    expect(res.value.created).toBe(true)
    expect(res.value.topics).toHaveLength(1)
    expect(res.value.topics[0]?.id).toBe('t-cand-1')
    expect(res.value.topics[0]?.assistantId).toBe('a-1')
    expect(res.value.topics[0]?.name).toBe('Default Topic')
    expect(countTopics()).toBe(1)
  })

  it('existing live topics return complete and preserve metadata verbatim without mutation', () => {
    expect(agg.ensureTopic('t-live-1', 'a-2', 'First').ok).toBe(true)
    expect(agg.updateTopicMetadata('t-live-1', undefined, true, undefined, undefined).ok).toBe(true)
    expect(agg.ensureTopic('t-live-2', 'a-2', 'Second').ok).toBe(true)
    const before = sqlite
      .prepare("SELECT id, updated_at as updatedAt FROM topics WHERE assistant_id = 'a-2' ORDER BY id")
      .all() as Array<{ id: string; updatedAt: string }>

    const res = agg.ensureAssistantTopics('a-2', 't-unused-cand', 'Unused')
    expect(res.ok).toBe(true)
    if (!isSuccess(res)) throw new Error('expected success')
    expect(res.value.created).toBe(false)
    expect(res.value.topics).toHaveLength(2)
    const first = res.value.topics.find((t) => t.id === 't-live-1')
    expect(first?.pinned).toBe(true)
    expect(first?.name).toBe('First')
    // No stale overwrite: updatedAt unchanged, no new row.
    const after = sqlite
      .prepare("SELECT id, updated_at as updatedAt FROM topics WHERE assistant_id = 'a-2' ORDER BY id")
      .all() as Array<{ id: string; updatedAt: string }>
    expect(after).toEqual(before)
    expect(countTopics()).toBe(2)
  })

  it('soft-deleted topics are excluded: empty live creates new', () => {
    expect(agg.ensureTopic('t-del-1', 'a-3', 'Gone').ok).toBe(true)
    expect(agg.softDeleteTopic('t-del-1').ok).toBe(true)
    const res = agg.ensureAssistantTopics('a-3', 't-cand-3', 'Fresh')
    expect(res.ok).toBe(true)
    if (!isSuccess(res)) throw new Error('expected success')
    expect(res.value.created).toBe(true)
    expect(res.value.topics.map((t) => t.id)).toEqual(['t-cand-3'])
  })

  it('candidate collision with another assistant fails closed without write', () => {
    expect(agg.ensureTopic('t-shared', 'a-other', 'Other').ok).toBe(true)
    const before = countTopics()
    const res = agg.ensureAssistantTopics('a-4', 't-shared', 'Hijack')
    expect(res.ok).toBe(false)
    expect(countTopics()).toBe(before)
  })

  it('candidate collision with a soft-deleted topic fails closed without resurrect', () => {
    expect(agg.ensureTopic('t-dead', 'a-5', 'Dead').ok).toBe(true)
    expect(agg.softDeleteTopic('t-dead').ok).toBe(true)
    const before = countTopics()
    const res = agg.ensureAssistantTopics('a-5', 't-dead', 'Reuse')
    expect(res.ok).toBe(false)
    expect(countTopics()).toBe(before)
    const row = sqlite.prepare("SELECT deleted_at as d FROM topics WHERE id = 't-dead'").get() as { d: string | null }
    expect(row.d).not.toBeNull()
  })

  it('repeat with different candidates returns the same first topic with ONE SQL row', () => {
    const first = agg.ensureAssistantTopics('a-6', 't-first', 'First')
    expect(first.ok).toBe(true)
    const second = agg.ensureAssistantTopics('a-6', 't-second-different', 'Second')
    expect(second.ok).toBe(true)
    if (!isSuccess(first) || !isSuccess(second)) throw new Error('expected success')
    expect(first.value.topics[0]?.id).toBe('t-first')
    expect(second.value.created).toBe(false)
    expect(second.value.topics.map((t) => t.id)).toEqual(['t-first'])
    const rows = sqlite
      .prepare("SELECT id FROM topics WHERE assistant_id = 'a-6' AND deleted_at IS NULL")
      .all() as Array<{ id: string }>
    expect(rows.map((r) => r.id)).toEqual(['t-first'])
  })

  it('replay does not refresh the existing row (no stale overwrite)', () => {
    const first = agg.ensureAssistantTopics('a-7', 't-r1', 'R1')
    expect(first.ok).toBe(true)
    const before = sqlite.prepare("SELECT updated_at as u FROM topics WHERE id = 't-r1'").get() as { u: string }
    const second = agg.ensureAssistantTopics('a-7', 't-r2', 'R2')
    expect(second.ok).toBe(true)
    if (!isSuccess(second)) throw new Error('expected success')
    expect(second.value.created).toBe(false)
    const after = sqlite.prepare("SELECT updated_at as u FROM topics WHERE id = 't-r1'").get() as { u: string }
    expect(after.u).toBe(before.u)
  })
})
