/**
 * Tree-preserving clipboard — sync policy on ONE atomic cross-route write.
 *
 * A tree paste is a single Main transaction that can touch two topics at once
 * (target insert + `cut` source removal). The house policy for that write is:
 * - the fresh rows placed on a main route are ordinary sync data: created rows
 *   get upsert intent (with topic membership), removed rows get delete intent
 *   (tombstones);
 * - every included child-branch subtree is local-only: branch-owned suffix rows
 *   never enter the outbox, the membership clocks, or the wire;
 * - a capture failure inside that transaction must leave BOTH sides exactly as
 *   they were — no partial target insert and no partial source removal.
 *
 * These assertions read the real authority tables (`sync_outbox`,
 * `sync_membership_clock`, `messages`, `topic_branches`), not the returned DTO.
 */
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

import { seedRegisteredAttachedSyncService } from '../../sync/__tests__/helpers/syncTestRegistration'
import { syncService } from '../../sync/SyncService'
import { chatDbService } from '..'
import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { runMigrations } from '../migration'
import * as schema from '../schema'

function okValue<T>(result: { ok: boolean; value?: T; error?: unknown }): T {
  if (!isSuccess(result as never))
    throw new Error(`Expected success, got: ${JSON.stringify((result as { error?: unknown }).error)}`)
  return (result as { value: T }).value
}
function openMemoryDb(): { sqlite: Database.Database; db: BetterSQLite3Database<typeof schema> } {
  const sqlite = new Database(':memory:')
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  runMigrations(db as never, sqlite)
  return { sqlite, db }
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
function appendTurn(agg: ChatDbAggregateService, topicId: string, turn: string, branchId: string | null = null): void {
  const userId = `u${turn}`
  const assistantId = `a${turn}`
  const options = branchId === null ? undefined : { branchId }
  expect(
    agg.appendMessage(
      topicId,
      msgJson(userId, topicId) as never,
      [blockJson(`b-${userId}`, userId) as never],
      undefined,
      undefined,
      options
    ).ok
  ).toBe(true)
  expect(
    agg.appendMessage(
      topicId,
      msgJson(assistantId, topicId, { role: 'assistant', askId: userId }) as never,
      [blockJson(`b-${assistantId}`, assistantId) as never],
      undefined,
      undefined,
      options
    ).ok
  ).toBe(true)
}
function seedTopic(agg: ChatDbAggregateService, topicId: string, turns: string[]): void {
  expect(agg.ensureTopic(topicId, 'assistant-1', `topic-${topicId}`).ok).toBe(true)
  for (const turn of turns) appendTurn(agg, topicId, turn)
}

describe('tree-preserving clipboard sync policy', () => {
  let sqlite: Database.Database
  let db: BetterSQLite3Database<typeof schema>
  let agg: ChatDbAggregateService

  beforeEach(() => {
    configStore.clear()
    configStore.set('sync:enabled', true)
    configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
    configStore.set('sync:token', '')
    const opened = openMemoryDb()
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
    ;(chatDbService as unknown as { sqlite: unknown }).sqlite = null
    ;(chatDbService as unknown as { db: unknown }).db = null
  })

  function outboxRows(): Array<{ entityType: string; entityId: string; op: string }> {
    return db
      .select()
      .from(schema.syncOutbox)
      .all()
      .map((row) => ({ entityType: row.entityType, entityId: row.entityId, op: row.op }))
  }
  function opsFor(entityId: string): Array<{ entityType: string; entityId: string; op: string }> {
    return outboxRows().filter((row) => row.entityId === entityId)
  }
  function membershipFor(entityId: string): number {
    return db
      .select()
      .from(schema.syncMembershipClock)
      .all()
      .filter((row) => row.childEntityId === entityId).length
  }
  function countIn(table: string, topicId: string): number {
    return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE topic_id=?`).get(topicId) as { n: number }).n
  }
  /** Source: main route turn A plus child branch F1 anchored at aA owning turn E. */
  function seedSource(): { f1: string } {
    seedTopic(agg, 't1', ['A'])
    const f1 = okValue(agg.createBranch('t1', null, 'aA', 'Fork-1')).branch.id
    appendTurn(agg, 't1', 'E', f1)
    return { f1 }
  }

  function copiedIds(pasted: {
    idMap: Array<{ kind: string; sourceId: string; targetId: string }>
    insertedRootMessageIds: string[]
    insertedBranchIds: string[]
  }): { rootUser: string; rootAssistant: string; branchUser: string; branchAssistant: string; branch: string } {
    const map = (kind: string, sourceId: string): string => {
      const row = pasted.idMap.find((entry) => entry.kind === kind && entry.sourceId === sourceId)
      if (!row) throw new Error(`No ${kind} mapping for ${sourceId}`)
      return row.targetId
    }
    return {
      rootUser: map('message', 'uA'),
      rootAssistant: map('message', 'aA'),
      branchUser: map('message', 'uE'),
      branchAssistant: map('message', 'aE'),
      branch: pasted.insertedBranchIds[0]
    }
  }

  it('captures main-route roots only: pasted branch-owned descendants stay local', () => {
    seedSource()
    seedTopic(agg, 't2', [])
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    const pasted = okValue(
      agg.pasteClipboardTree({
        mode: 'copy',
        payload: tree,
        target: { topicId: 't2', branchId: null, intent: { kind: 'topic-tail' } }
      })
    )
    const ids = copiedIds(pasted)

    // Fresh main-route rows are ordinary sync data (a message upsert, plus the
    // parent block-frame op keyed by the same message id).
    expect(opsFor(ids.rootUser).filter((row) => row.op === 'upsert')).toEqual([
      { entityType: 'message', entityId: ids.rootUser, op: 'upsert' }
    ])
    expect(opsFor(ids.rootAssistant).filter((row) => row.op === 'upsert')).toEqual([
      { entityType: 'message', entityId: ids.rootAssistant, op: 'upsert' }
    ])
    expect(membershipFor(ids.rootUser)).toBe(1)
    expect(membershipFor(ids.rootAssistant)).toBe(1)
    // Branch-owned suffix rows never reach the outbox or a membership clock.
    expect(opsFor(ids.branchUser).filter((row) => row.op === 'upsert')).toEqual([])
    expect(opsFor(ids.branchAssistant).filter((row) => row.op === 'upsert')).toEqual([])
    expect(opsFor(ids.branchUser)).toEqual([])
    expect(opsFor(ids.branchAssistant)).toEqual([])
    expect(membershipFor(ids.branchUser)).toBe(0)
    expect(membershipFor(ids.branchAssistant)).toBe(0)
    // Blocks follow their owner: main block syncs, branch block does not.
    const rootBlock = pasted.idMap.find((row) => row.kind === 'block' && row.sourceId === 'b-uA')?.targetId
    const branchBlock = pasted.idMap.find((row) => row.kind === 'block' && row.sourceId === 'b-uE')?.targetId
    expect(rootBlock).toBeDefined()
    expect(branchBlock).toBeDefined()
    expect(opsFor(String(rootBlock)).filter((row) => row.op === 'upsert')).toHaveLength(1)
    expect(opsFor(String(branchBlock))).toEqual([])
    // The generated branch row is branch domain: local-only.
    expect(opsFor(ids.branch)).toEqual([])
  })

  it('tombstones the cut main-route rows only: removed branch-owned rows stay local', () => {
    const { f1 } = seedSource()
    seedTopic(agg, 't2', [])
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    okValue(
      agg.pasteClipboardTree({
        mode: 'cut',
        payload: tree,
        target: { topicId: 't2', branchId: null, intent: { kind: 'topic-tail' } }
      })
    )
    // The source main-route rows left with a delete intent (tombstone path); the
    // row also carries its earlier upsert/order-frame history from seeding.
    expect(opsFor('uA').filter((row) => row.op === 'delete')).toEqual([
      { entityType: 'message', entityId: 'uA', op: 'delete' }
    ])
    expect(opsFor('aA').filter((row) => row.op === 'delete')).toEqual([
      { entityType: 'message', entityId: 'aA', op: 'delete' }
    ])
    // The removed branch rows were never on the wire, so their removal is silent.
    expect(opsFor('uE')).toEqual([])
    expect(opsFor('aE')).toEqual([])
    expect(opsFor(f1)).toEqual([])
    expect(countIn('messages', 't1')).toBe(0)
  })

  it('rolls back the whole cut when target capture fails mid-transaction', () => {
    seedSource()
    seedTopic(agg, 't2', ['X'])
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    const before = {
      messages: (sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n,
      branches: (sqlite.prepare('SELECT COUNT(*) AS n FROM topic_branches').get() as { n: number }).n,
      blocks: (sqlite.prepare('SELECT COUNT(*) AS n FROM message_blocks').get() as { n: number }).n,
      outbox: outboxRows().length,
      memberships: db.select().from(schema.syncMembershipClock).all().length
    }
    const spy = vi.spyOn(syncService, 'enqueueUpsertInTx').mockImplementationOnce(() => {
      throw new Error('sync enqueue failure')
    })
    const failed = agg.pasteClipboardTree({
      mode: 'cut',
      payload: tree,
      target: { topicId: 't2', branchId: null, intent: { kind: 'topic-tail' } }
    })
    spy.mockRestore()
    expect(failed.ok).toBe(false)
    // No partial target insert and no partial source removal.
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(before.messages)
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM topic_branches').get() as { n: number }).n).toBe(before.branches)
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM message_blocks').get() as { n: number }).n).toBe(before.blocks)
    expect(outboxRows().length).toBe(before.outbox)
    expect(db.select().from(schema.syncMembershipClock).all().length).toBe(before.memberships)
    expect(countIn('messages', 't1')).toBe(4)
    expect(countIn('messages', 't2')).toBe(2)
  })

  it('rolls back both sides when the source delete capture fails after the target rows were written', () => {
    seedSource()
    seedTopic(agg, 't2', ['X'])
    const tree = okValue(agg.fetchClipboardTree({ topicId: 't1', branchId: null, groupIds: ['uA'] })).tree
    const t1Before = (
      sqlite.prepare('SELECT id FROM messages WHERE topic_id=? ORDER BY sort_order ASC').all('t1') as { id: string }[]
    ).map((row) => row.id)
    const outboxBefore = outboxRows()
    // Fail the source delete intent: the target insert and the source deletion
    // have both already run inside the transaction at that point.
    const spy = vi.spyOn(syncService, 'enqueueDeleteInTx').mockImplementationOnce(() => {
      throw new Error('sync delete capture failure')
    })
    const failed = agg.pasteClipboardTree({
      mode: 'cut',
      payload: tree,
      target: { topicId: 't2', branchId: null, intent: { kind: 'topic-tail' } }
    })
    spy.mockRestore()
    expect(failed.ok).toBe(false)
    expect(
      (
        sqlite.prepare('SELECT id FROM messages WHERE topic_id=? ORDER BY sort_order ASC').all('t1') as { id: string }[]
      ).map((row) => row.id)
    ).toEqual(t1Before)
    expect(countIn('messages', 't2')).toBe(2)
    expect(outboxRows()).toEqual(outboxBefore)
    // The unique source rows are back with their original blocks.
    expect(
      (sqlite.prepare('SELECT COUNT(*) AS n FROM message_blocks WHERE message_id=?').get('uA') as { n: number }).n
    ).toBe(1)
  })
})
