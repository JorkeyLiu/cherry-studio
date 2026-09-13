/**
 * Promotion-time membership mint subunit.
 * - Transient message/block first promotion to stable+supported mints its first
 *   membership from the same-tx stable upsert clock (never createdAt/clock/guess).
 * - Same-tx entity/field capture + membership insert-if-absent + parent frame
 *   refresh/enqueue are atomic; failure rolls back everything.
 * - Same-parent re-promotion reuses the first tuple; different tuple conflicts
 *   fail closed; paths without a trustworthy op stay unversioned/partial.
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

import { chatDbService } from '../../chatDb'
import { ChatDbAggregateService } from '../../chatDb/ChatDbAggregateService'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { captureLocalSyncBaselineCandidate } from '../syncBaseline'
import { syncService } from '../SyncService'
import { seedRegisteredAttachedSyncService } from './helpers/syncTestRegistration'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>
let agg: ChatDbAggregateService

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

function membershipOf(
  childType: string,
  childId: string
): { parentId: string; timestamp: number; operationId: string } | null {
  const r = sqlite
    .prepare(
      `SELECT parent_id as parentId, timestamp, operation_id as operationId FROM sync_membership_clock WHERE child_entity_type=? AND child_entity_id=?`
    )
    .get(childType, childId) as { parentId: string; timestamp: number; operationId: string } | undefined
  return r ?? null
}

function outboxFor(entityId: string): { id: string; timestamp: number } | null {
  const r = db
    .select()
    .from(schema.syncOutbox)
    .all()
    .find((row) => row.entityId === entityId)
  return r ? { id: r.id, timestamp: r.timestamp } : null
}

function topicFrameOf(topicId: string): { orderedChildIds: string[]; timestamp: number; operationId: string } | null {
  const r = sqlite
    .prepare(
      `SELECT ordered_child_ids_json AS json, timestamp, operation_id AS operationId FROM sync_parent_order_frame WHERE kind='topicMessage' AND parent_id=?`
    )
    .get(topicId) as { json: string; timestamp: number; operationId: string } | undefined
  if (!r) return null
  return { orderedChildIds: JSON.parse(r.json) as string[], timestamp: r.timestamp, operationId: r.operationId }
}

function blockFrameOf(messageId: string): { orderedChildIds: string[]; timestamp: number; operationId: string } | null {
  const r = sqlite
    .prepare(
      `SELECT ordered_child_ids_json AS json, timestamp, operation_id AS operationId FROM sync_parent_order_frame WHERE kind='messageBlock' AND parent_id=?`
    )
    .get(messageId) as { json: string; timestamp: number; operationId: string } | undefined
  if (!r) return null
  return { orderedChildIds: JSON.parse(r.json) as string[], timestamp: r.timestamp, operationId: r.operationId }
}

function frameOpsFor(entityId: string) {
  return db
    .select()
    .from(schema.syncOutbox)
    .all()
    .filter((r) => r.op === 'order_frame' && r.entityId === entityId)
}

function stableBlock(id: string, messageId: string): Record<string, unknown> {
  return {
    id,
    messageId,
    type: 'text',
    content: `c-${id}`,
    status: 'success',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01'
  }
}

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
  configStore.set('sync:token', '')
  sqlite = openInMemory()
  db = drizzle(sqlite, { schema })
  runMigrations(db as never, sqlite)
  ;(chatDbService as never as { sqlite: unknown }).sqlite = sqlite
  ;(chatDbService as never as { db: unknown }).db = db
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

describe('promotion-time membership mint — message', () => {
  it('transient message promotion mints membership from the emitted stable upsert clock; topic frame emitted and baseline complete for that case', () => {
    const T0 = 7_000_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(T0)
    expect(agg.ensureTopic('t-prom-m', 'assistant-1', 'T').ok).toBe(true)
    // Transient assistant stub captures nothing (legitimate skip).
    expect(
      agg.appendMessage(
        't-prom-m',
        { id: 'm-prom', topicId: 't-prom-m', role: 'assistant', content: 'draft', status: 'pending' } as never,
        []
      ).ok
    ).toBe(true)
    expect(membershipOf('message', 'm-prom')).toBeNull()
    expect(outboxFor('m-prom')).toBeNull()

    vi.spyOn(Date, 'now').mockReturnValue(T0 + 100)
    const promote = agg.updateMessage('t-prom-m', 'm-prom', { status: 'success', content: 'final' } as never)
    expect(promote.ok).toBe(true)

    const mem = membershipOf('message', 'm-prom')
    expect(mem).not.toBeNull()
    expect(mem!.parentId).toBe('t-prom-m')
    const out = outboxFor('m-prom')
    expect(out).not.toBeNull()
    // Membership source is exactly the emitted stable upsert clock.
    expect(mem!.timestamp).toBe(out!.timestamp)
    expect(mem!.operationId).toBe(out!.id)

    const frame = topicFrameOf('t-prom-m')!
    expect(frame).not.toBeNull()
    expect(frame.orderedChildIds).toEqual(['m-prom'])
    const frameOps = frameOpsFor('t-prom-m')
    expect(frameOps.length).toBeGreaterThanOrEqual(1)
    expect(frameOps[frameOps.length - 1].id).toBe(frame.operationId)

    // Baseline for this isolated case has no unversioned/missing/incomplete.
    const cand = captureLocalSyncBaselineCandidate(db as never) as {
      completeness: { state: string; reasons: string[] }
      manifest: {
        unversionedMembershipCount: number
        missingOrderFrameCount: number
        incompleteOrderFrameCount: number
      }
    }
    expect(cand.manifest.unversionedMembershipCount).toBe(0)
    expect(cand.manifest.missingOrderFrameCount).toBe(0)
    expect(cand.manifest.incompleteOrderFrameCount).toBe(0)
    expect(cand.completeness.reasons).not.toContain('unversioned-membership')
    expect(cand.completeness.reasons).not.toContain('missing-order-frame')
    expect(cand.completeness.reasons).not.toContain('incomplete-order-frame')
  })

  it('stable->transient->stable reuses the first membership without re-minting', () => {
    const T0 = 7_100_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(T0)
    expect(agg.ensureTopic('t-reuse', 'assistant-1', 'T').ok).toBe(true)
    expect(
      agg.appendMessage(
        't-reuse',
        { id: 'm-reuse', topicId: 't-reuse', role: 'assistant', content: 'd', status: 'pending' } as never,
        []
      ).ok
    ).toBe(true)
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 10)
    expect(agg.updateMessage('t-reuse', 'm-reuse', { status: 'success', content: 's1' } as never).ok).toBe(true)
    const first = membershipOf('message', 'm-reuse')!
    expect(first).not.toBeNull()

    // Stable->transient exclusion keeps the user edit successful but drops the frame.
    expect(agg.updateMessage('t-reuse', 'm-reuse', { status: 'streaming' } as never).ok).toBe(true)
    expect(topicFrameOf('t-reuse')).toBeNull()
    expect(membershipOf('message', 'm-reuse')).toEqual(first)

    // Second promotion reuses the first tuple (no new clock).
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 20)
    expect(agg.updateMessage('t-reuse', 'm-reuse', { status: 'success', content: 's2' } as never).ok).toBe(true)
    expect(membershipOf('message', 'm-reuse')).toEqual(first)
    expect(topicFrameOf('t-reuse')!.orderedChildIds).toEqual(['m-reuse'])
  })

  it('promotion transaction failure rolls back membership/entity/frame/outbox together', () => {
    const T0 = 7_200_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(T0)
    expect(agg.ensureTopic('t-rb', 'assistant-1', 'T').ok).toBe(true)
    expect(
      agg.appendMessage(
        't-rb',
        { id: 'm-rb', topicId: 't-rb', role: 'assistant', content: 'd', status: 'pending' } as never,
        []
      ).ok
    ).toBe(true)
    // Poison the sibling scan: a malformed block extra makes the promotion's
    // same-tx frame refresh throw, so the whole promotion must roll back.
    sqlite
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run('b-rb-bad', 'm-rb', 'text', 'bad', 'success', '2026-01-01', '2026-01-01', 0, 'not-json')
    const outboxBefore = db.select().from(schema.syncOutbox).all().length
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 10)
    const res = agg.updateMessage('t-rb', 'm-rb', { status: 'success', content: 's' } as never)
    expect(res.ok).toBe(false)
    // No partial survives: message stays transient, no membership, no outbox growth.
    expect((sqlite.prepare(`SELECT status FROM messages WHERE id=?`).get('m-rb') as { status: string }).status).toBe(
      'pending'
    )
    expect(membershipOf('message', 'm-rb')).toBeNull()
    expect(membershipOf('message_block', 'b-rb-bad')).toBeNull()
    expect(db.select().from(schema.syncOutbox).all().length).toBe(outboxBefore)
  })

  it('existing conflicting membership fails closed with no partial mutation', () => {
    const T0 = 7_300_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(T0)
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?,?,?,?)`)
      .run('t-cf', 'T', '2026-01-01', '2026-01-01')
    sqlite
      .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?,?,?,?)`)
      .run('t-other', 'O', '2026-01-01', '2026-01-01')
    sqlite
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
      )
      .run('m-cf', 't-cf', 'assistant', 'd', 'pending', '2026-01-01', '2026-01-01', 0)
    // Conflicting retained membership under a different parent.
    sqlite
      .prepare(
        `INSERT INTO sync_membership_clock (child_entity_type, child_entity_id, parent_id, timestamp, operation_id) VALUES (?,?,?,?,?)`
      )
      .run('message', 'm-cf', 't-other', T0, 'op-conflict-parent')
    const outboxBefore = db.select().from(schema.syncOutbox).all().length
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 10)
    const res = agg.updateMessage('t-cf', 'm-cf', { status: 'success', content: 's' } as never)
    expect(res.ok).toBe(false)
    expect((sqlite.prepare(`SELECT status FROM messages WHERE id=?`).get('m-cf') as { status: string }).status).toBe(
      'pending'
    )
    expect(membershipOf('message', 'm-cf')).toEqual({
      parentId: 't-other',
      timestamp: T0,
      operationId: 'op-conflict-parent'
    })
    expect(db.select().from(schema.syncOutbox).all().length).toBe(outboxBefore)
  })
})

describe('promotion-time membership mint — blocks', () => {
  it('promotion parent mints but pre-existing stable untracked siblings stay entity-only/unversioned (no rescan backfill); single per-parent frame decision', () => {
    const T0 = 7_400_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(T0)
    expect(agg.ensureTopic('t-prom-b', 'assistant-1', 'T').ok).toBe(true)
    expect(
      agg.appendMessage(
        't-prom-b',
        { id: 'm-pb', topicId: 't-prom-b', role: 'assistant', content: 'd', status: 'pending' } as never,
        []
      ).ok
    ).toBe(true)
    // Two stable-supported siblings committed while the parent is transient:
    // they are untracked before the promotion tx and join the same stable
    // checkpoint as entity-only evidence only — never versioned with the
    // rescan op clock.
    sqlite
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
      )
      .run('b-pb-1', 'm-pb', 'text', 'one', 'success', '2026-01-01', '2026-01-01', 0)
    sqlite
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
      )
      .run('b-pb-2', 'm-pb', 'text', 'two', 'success', '2026-01-01', '2026-01-01', 1)
    expect(membershipOf('message_block', 'b-pb-1')).toBeNull()
    expect(membershipOf('message_block', 'b-pb-2')).toBeNull()

    const frameBefore = frameOpsFor('m-pb').length
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 50)
    const promote = agg.updateMessage('t-prom-b', 'm-pb', { status: 'success', content: 'final' } as never)
    expect(promote.ok).toBe(true)

    // Promotion parent mints from its own same-tx stable upsert clock.
    const memMsg = membershipOf('message', 'm-pb')!
    expect(memMsg).not.toBeNull()
    expect(memMsg.parentId).toBe('t-prom-b')
    expect(memMsg.operationId).toBe(outboxFor('m-pb')!.id)

    // Pre-existing stable siblings: entity evidence captured but no membership.
    for (const bid of ['b-pb-1', 'b-pb-2']) {
      expect(outboxFor(bid)).not.toBeNull()
      expect(membershipOf('message_block', bid)).toBeNull()
    }

    // Single per-parent frame decision: the messageBlock frame cannot complete
    // without trustworthy sibling membership, so it stays invalidated (0 op)
    // while the user mutation succeeds. At most one attempt per parent.
    const ops = frameOpsFor('m-pb')
    expect(ops.length - frameBefore).toBeLessThanOrEqual(1)
    expect(blockFrameOf('m-pb')).toBeNull()

    // Topic frame still mints: the single promoted message has membership.
    expect(topicFrameOf('t-prom-b')!.orderedChildIds).toEqual(['m-pb'])

    // Baseline for this isolated case is truthfully partial (unversioned siblings).
    const cand = captureLocalSyncBaselineCandidate(db as never) as {
      completeness: { state: string; reasons: string[] }
      manifest: { unversionedMembershipCount: number }
    }
    expect(cand.manifest.unversionedMembershipCount).toBeGreaterThan(0)
    expect(cand.completeness.reasons).toContain('unversioned-membership')
  })

  it('normal atomic final via updateMessageAndBlocks carrying all blocks mints every requested block and completes both frames', () => {
    const T0 = 7_450_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(T0)
    expect(agg.ensureTopic('t-atomic', 'assistant-1', 'T').ok).toBe(true)
    expect(
      agg.appendMessage(
        't-atomic',
        { id: 'm-at', topicId: 't-atomic', role: 'assistant', content: 'd', status: 'pending' } as never,
        []
      ).ok
    ).toBe(true)
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 10)
    const res = agg.updateMessageAndBlocks(
      't-atomic',
      { id: 'm-at', status: 'success', content: 'final' } as never,
      [stableBlock('b-at-1', 'm-at') as never, stableBlock('b-at-2', 'm-at') as never],
      []
    )
    expect(res.ok).toBe(true)
    expect(membershipOf('message', 'm-at')!.parentId).toBe('t-atomic')
    for (const bid of ['b-at-1', 'b-at-2']) {
      const mem = membershipOf('message_block', bid)!
      expect(mem).not.toBeNull()
      expect(mem.parentId).toBe('m-at')
      expect(mem.operationId).toBe(outboxFor(bid)!.id)
    }
    expect(topicFrameOf('t-atomic')!.orderedChildIds).toEqual(['m-at'])
    expect(blockFrameOf('m-at')!.orderedChildIds).toEqual(['b-at-1', 'b-at-2'])
    const cand = captureLocalSyncBaselineCandidate(db as never) as {
      completeness: { state: string; reasons: string[] }
      manifest: {
        unversionedMembershipCount: number
        missingOrderFrameCount: number
        incompleteOrderFrameCount: number
      }
    }
    expect(cand.manifest.unversionedMembershipCount).toBe(0)
    expect(cand.manifest.missingOrderFrameCount).toBe(0)
    expect(cand.manifest.incompleteOrderFrameCount).toBe(0)
  })

  it('updateBlocks transient->stable promotion mints; updateMessageAndBlocks promotion mints message plus requested blocks', () => {
    const T0 = 7_500_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(T0)
    expect(agg.ensureTopic('t-prom-u', 'assistant-1', 'T').ok).toBe(true)
    expect(
      agg.appendMessage(
        't-prom-u',
        { id: 'm-pu', topicId: 't-prom-u', role: 'user', content: 'p', status: 'success' } as never,
        []
      ).ok
    ).toBe(true)
    sqlite
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
      )
      .run('b-pu-1', 'm-pu', 'text', 'draft', 'pending', '2026-01-01', '2026-01-01', 0)
    expect(membershipOf('message_block', 'b-pu-1')).toBeNull()
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 10)
    expect(agg.updateBlocks([{ ...stableBlock('b-pu-1', 'm-pu'), content: 'final' } as never]).ok).toBe(true)
    const memBlk = membershipOf('message_block', 'b-pu-1')!
    expect(memBlk.parentId).toBe('m-pu')
    expect(memBlk.operationId).toBe(outboxFor('b-pu-1')!.id)
    expect(blockFrameOf('m-pu')!.orderedChildIds).toEqual(['b-pu-1'])

    // updateMessageAndBlocks message promotion plus a requested stable block.
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 20)
    expect(
      agg.appendMessage(
        't-prom-u',
        { id: 'm-pu2', topicId: 't-prom-u', role: 'assistant', content: 'd', status: 'pending' } as never,
        []
      ).ok
    ).toBe(true)
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 30)
    const res = agg.updateMessageAndBlocks(
      't-prom-u',
      { id: 'm-pu2', status: 'success', content: 'final2' } as never,
      [stableBlock('b-pu2-1', 'm-pu2') as never],
      []
    )
    expect(res.ok).toBe(true)
    expect(membershipOf('message', 'm-pu2')!.parentId).toBe('t-prom-u')
    expect(membershipOf('message_block', 'b-pu2-1')!.parentId).toBe('m-pu2')
    expect(membershipOf('message', 'm-pu2')!.operationId).toBe(outboxFor('m-pu2')!.id)
    expect(membershipOf('message_block', 'b-pu2-1')!.operationId).toBe(outboxFor('b-pu2-1')!.id)
  })

  it('path without a trustworthy same-tx op stays unversioned with truthful partial (unsupported promotion)', () => {
    const T0 = 7_600_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(T0)
    expect(agg.ensureTopic('t-prom-x', 'assistant-1', 'T').ok).toBe(true)
    expect(
      agg.appendMessage(
        't-prom-x',
        { id: 'm-px', topicId: 't-prom-x', role: 'assistant', content: 'd', status: 'pending' } as never,
        []
      ).ok
    ).toBe(true)
    // Unsupported structured block never emits a sync op, so no membership.
    const unsupported = {
      id: 'b-px-u',
      messageId: 'm-px',
      type: 'tool',
      content: 'x',
      status: 'success',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01'
    }
    sqlite
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
      )
      .run('b-px-u', 'm-px', 'tool', 'x', 'success', '2026-01-01', '2026-01-01', 0)
    void unsupported
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 10)
    const promote = agg.updateMessage('t-prom-x', 'm-px', { status: 'success', content: 'final' } as never)
    expect(promote.ok).toBe(true)
    expect(membershipOf('message', 'm-px')).not.toBeNull()
    expect(membershipOf('message_block', 'b-px-u')).toBeNull()
    // Excluded child keeps the parent frame invalidated with 0 op.
    expect(blockFrameOf('m-px')).toBeNull()
    const cand = captureLocalSyncBaselineCandidate(db as never) as {
      completeness: { state: string; reasons: string[] }
    }
    expect(cand.completeness.state).not.toBe('complete')
  })
})
