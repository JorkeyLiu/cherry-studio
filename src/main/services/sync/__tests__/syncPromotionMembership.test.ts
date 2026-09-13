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

describe('promotion-scoped sibling supplement — ordinary success blocks', () => {
  function insertBlock(id: string, messageId: string, status: string, sortOrder: number, type = 'text'): void {
    sqlite
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(id, messageId, type, `c-${id}`, status, '2026-01-01', '2026-01-01', sortOrder)
  }

  function baselineSummary(): {
    unversionedMembershipCount: number
    missingOrderFrameCount: number
    incompleteOrderFrameCount: number
    reasons: string[]
  } {
    const cand = captureLocalSyncBaselineCandidate(db as never) as {
      completeness: { reasons: string[] }
      manifest: {
        unversionedMembershipCount: number
        missingOrderFrameCount: number
        incompleteOrderFrameCount: number
      }
    }
    return {
      unversionedMembershipCount: cand.manifest.unversionedMembershipCount,
      missingOrderFrameCount: cand.manifest.missingOrderFrameCount,
      incompleteOrderFrameCount: cand.manifest.incompleteOrderFrameCount,
      reasons: cand.completeness.reasons
    }
  }

  it('updateBlocks promotion versions a missing-clock stable sibling, keeps an existing clock, completes the frame and clears unversioned-membership', () => {
    const T0 = 7_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(T0)
    expect(agg.ensureTopic('t-supp', 'assistant-1', 'T').ok).toBe(true)
    expect(
      agg.appendMessage(
        't-supp',
        { id: 'm-supp', topicId: 't-supp', role: 'user', content: 'p', status: 'success' } as never,
        []
      ).ok
    ).toBe(true)

    // Seeded sibling via the ordinary path: trustworthy clock, must be preserved.
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 10)
    expect(agg.updateBlocks([stableBlock('b-supp-b-seed', 'm-supp') as never]).ok).toBe(true)
    const seededBefore = membershipOf('message_block', 'b-supp-b-seed')!
    expect(seededBefore).not.toBeNull()
    expect(seededBefore.parentId).toBe('m-supp')

    // Untracked stable sibling (missing clock) + transient sibling, same parent.
    insertBlock('b-supp-a-keep', 'm-supp', 'success', 0)
    insertBlock('b-supp-c-prom', 'm-supp', 'pending', 0)
    expect(membershipOf('message_block', 'b-supp-a-keep')).toBeNull()
    expect(membershipOf('message_block', 'b-supp-c-prom')).toBeNull()

    // Before the promotion the isolated baseline is partial for unversioned-membership.
    expect(baselineSummary().reasons).toContain('unversioned-membership')

    vi.spyOn(Date, 'now').mockReturnValue(T0 + 20)
    expect(agg.updateBlocks([{ ...stableBlock('b-supp-c-prom', 'm-supp'), content: 'final' } as never]).ok).toBe(true)

    // Promoted block mints from its own same-tx stable upsert clock.
    const memProm = membershipOf('message_block', 'b-supp-c-prom')!
    expect(memProm.parentId).toBe('m-supp')
    expect(memProm.operationId).toBe(outboxFor('b-supp-c-prom')!.id)
    expect(memProm.timestamp).toBe(outboxFor('b-supp-c-prom')!.timestamp)

    // Missing-clock stable sibling is supplemented in the same tx with its own clock.
    const memKeep = membershipOf('message_block', 'b-supp-a-keep')!
    expect(memKeep.parentId).toBe('m-supp')
    expect(memKeep.operationId).toBe(outboxFor('b-supp-a-keep')!.id)
    expect(memKeep.timestamp).toBe(outboxFor('b-supp-a-keep')!.timestamp)

    // Existing clock is never rewritten.
    expect(membershipOf('message_block', 'b-supp-b-seed')).toEqual(seededBefore)

    // Parent frame carries the complete stable order (sort tie → id ASC).
    const frame = blockFrameOf('m-supp')!
    expect(frame).not.toBeNull()
    expect(frame.orderedChildIds).toEqual(['b-supp-a-keep', 'b-supp-b-seed', 'b-supp-c-prom'])
    const frameOps = frameOpsFor('m-supp')
    expect(frameOps.length).toBeGreaterThanOrEqual(1)
    expect(frameOps[frameOps.length - 1].id).toBe(frame.operationId)

    // Baseline no longer reports the sibling unversioned-membership cause.
    const after = baselineSummary()
    expect(after.unversionedMembershipCount).toBe(0)
    expect(after.missingOrderFrameCount).toBe(0)
    expect(after.incompleteOrderFrameCount).toBe(0)
    expect(after.reasons).not.toContain('unversioned-membership')
    expect(after.reasons).not.toContain('missing-order-frame')
    expect(after.reasons).not.toContain('incomplete-order-frame')
  })

  it('updateMessageAndBlocks block promotion versions an unrequested stable sibling and completes the frame', () => {
    const T0 = 7_800_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(T0)
    expect(agg.ensureTopic('t-amb', 'assistant-1', 'T').ok).toBe(true)
    expect(
      agg.appendMessage(
        't-amb',
        { id: 'm-amb', topicId: 't-amb', role: 'user', content: 'p', status: 'success' } as never,
        []
      ).ok
    ).toBe(true)
    insertBlock('b-amb-keep', 'm-amb', 'success', 0)
    insertBlock('b-amb-prom', 'm-amb', 'pending', 0)
    expect(baselineSummary().reasons).toContain('unversioned-membership')

    vi.spyOn(Date, 'now').mockReturnValue(T0 + 10)
    const res = agg.updateMessageAndBlocks(
      't-amb',
      { id: 'm-amb', status: 'success', content: 'final' } as never,
      [{ ...stableBlock('b-amb-prom', 'm-amb'), content: 'final' } as never],
      []
    )
    expect(res.ok).toBe(true)

    const memProm = membershipOf('message_block', 'b-amb-prom')!
    expect(memProm.parentId).toBe('m-amb')
    expect(memProm.operationId).toBe(outboxFor('b-amb-prom')!.id)
    const memKeep = membershipOf('message_block', 'b-amb-keep')!
    expect(memKeep.parentId).toBe('m-amb')
    expect(memKeep.operationId).toBe(outboxFor('b-amb-keep')!.id)

    expect(blockFrameOf('m-amb')!.orderedChildIds).toEqual(['b-amb-keep', 'b-amb-prom'])
    const after = baselineSummary()
    expect(after.unversionedMembershipCount).toBe(0)
    expect(after.missingOrderFrameCount).toBe(0)
    expect(after.incompleteOrderFrameCount).toBe(0)
    expect(after.reasons).not.toContain('unversioned-membership')
  })

  it('updateSingleBlock promotion versions a missing-clock stable sibling and completes the frame', () => {
    const T0 = 7_900_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(T0)
    expect(agg.ensureTopic('t-single', 'assistant-1', 'T').ok).toBe(true)
    expect(
      agg.appendMessage(
        't-single',
        { id: 'm-single', topicId: 't-single', role: 'user', content: 'p', status: 'success' } as never,
        []
      ).ok
    ).toBe(true)
    insertBlock('b-single-keep', 'm-single', 'success', 0)
    insertBlock('b-single-prom', 'm-single', 'pending', 0)

    vi.spyOn(Date, 'now').mockReturnValue(T0 + 10)
    expect(agg.updateSingleBlock('b-single-prom', { status: 'success', content: 'final' } as never).ok).toBe(true)

    const memProm = membershipOf('message_block', 'b-single-prom')!
    expect(memProm.parentId).toBe('m-single')
    const memKeep = membershipOf('message_block', 'b-single-keep')!
    expect(memKeep.parentId).toBe('m-single')
    expect(memKeep.operationId).toBe(outboxFor('b-single-keep')!.id)
    expect(blockFrameOf('m-single')!.orderedChildIds).toEqual(['b-single-keep', 'b-single-prom'])
    const after = baselineSummary()
    expect(after.unversionedMembershipCount).toBe(0)
    expect(after.reasons).not.toContain('unversioned-membership')
  })

  it('updateMessageAndBlocks promotion supplements a tracked-but-unversioned sibling with its own new same-tx clock', () => {
    const T0 = 8_100_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(T0)
    expect(agg.ensureTopic('t-amb-tu', 'assistant-1', 'T').ok).toBe(true)
    expect(
      agg.appendMessage(
        't-amb-tu',
        { id: 'm-amb-tu', topicId: 't-amb-tu', role: 'user', content: 'p', status: 'success' } as never,
        []
      ).ok
    ).toBe(true)
    insertBlock('b-amb-tu-keep', 'm-amb-tu', 'success', 0)
    insertBlock('b-amb-tu-prom', 'm-amb-tu', 'pending', 0)
    const outboxRowsFor = (id: string) =>
      db
        .select()
        .from(schema.syncOutbox)
        .all()
        .filter((r) => r.entityId === id)

    // Tx1: pure message edit (no block promotion) — ordinary rescan stays
    // entity-only: keep becomes tracked (outbox) but remains unversioned, no frame.
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 10)
    expect(
      agg.updateMessageAndBlocks('t-amb-tu', { id: 'm-amb-tu', status: 'success', content: 'edit1' } as never, [], [])
        .ok
    ).toBe(true)
    expect(membershipOf('message_block', 'b-amb-tu-keep')).toBeNull()
    const keepOutboxTx1 = outboxFor('b-amb-tu-keep')
    expect(keepOutboxTx1).not.toBeNull()
    // Stable message creation leaves an empty order frame as the baseline;
    // the entity-only rescan must not advance it.
    expect(blockFrameOf('m-amb-tu')!.orderedChildIds).toEqual([])

    // Tx2: ordinary transient→success promotion must supplement the now
    // tracked-but-unversioned sibling with its own new same-tx upsert clock.
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 20)
    expect(
      agg.updateMessageAndBlocks(
        't-amb-tu',
        { id: 'm-amb-tu', status: 'success', content: 'edit2' } as never,
        [{ ...stableBlock('b-amb-tu-prom', 'm-amb-tu'), content: 'final' } as never],
        []
      ).ok
    ).toBe(true)

    const memProm = membershipOf('message_block', 'b-amb-tu-prom')!
    expect(memProm.parentId).toBe('m-amb-tu')
    expect(memProm.operationId).toBe(outboxFor('b-amb-tu-prom')!.id)
    expect(memProm.timestamp).toBe(outboxFor('b-amb-tu-prom')!.timestamp)

    const memKeep = membershipOf('message_block', 'b-amb-tu-keep')!
    expect(memKeep.parentId).toBe('m-amb-tu')
    // New same-tx upsert: membership binds a keep outbox row, but never the
    // Tx1 entity-only row and never the promoted block's op.
    const keepRows = outboxRowsFor('b-amb-tu-keep')
    expect(keepRows.length).toBeGreaterThanOrEqual(2)
    expect(memKeep.operationId).not.toBe(keepOutboxTx1!.id)
    expect(memKeep.operationId).not.toBe(memProm.operationId)
    const bound = keepRows.find((r) => r.id === memKeep.operationId)
    expect(bound).not.toBeUndefined()
    expect(bound!.timestamp).toBe(memKeep.timestamp)

    expect(blockFrameOf('m-amb-tu')!.orderedChildIds).toEqual(['b-amb-tu-keep', 'b-amb-tu-prom'])
    const after = baselineSummary()
    expect(after.unversionedMembershipCount).toBe(0)
    expect(after.missingOrderFrameCount).toBe(0)
    expect(after.incompleteOrderFrameCount).toBe(0)
    expect(after.reasons).not.toContain('unversioned-membership')
  })

  it('non-promotion edits never supplement missing siblings (stable→stable via updateBlocks; pure message via updateMessageAndBlocks)', () => {
    // Subcase A: ordinary stable→stable edit via updateBlocks mints nothing
    // for the untouched missing-membership sibling (no outbox, no frame).
    const T0 = 8_200_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(T0)
    expect(agg.ensureTopic('t-neg-s', 'assistant-1', 'T').ok).toBe(true)
    expect(
      agg.appendMessage(
        't-neg-s',
        { id: 'm-neg-s', topicId: 't-neg-s', role: 'user', content: 'p', status: 'success' } as never,
        []
      ).ok
    ).toBe(true)
    insertBlock('b-neg-s-keep', 'm-neg-s', 'success', 0)
    insertBlock('b-neg-s-edit', 'm-neg-s', 'success', 1)
    const outboxBeforeA = db.select().from(schema.syncOutbox).all().length
    const frameBeforeA = blockFrameOf('m-neg-s')
    expect(frameBeforeA!.orderedChildIds).toEqual([])
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 10)
    expect(agg.updateBlocks([{ ...stableBlock('b-neg-s-edit', 'm-neg-s'), content: 'edit' } as never]).ok).toBe(true)
    expect(membershipOf('message_block', 'b-neg-s-keep')).toBeNull()
    expect(outboxFor('b-neg-s-keep')).toBeNull()
    expect(membershipOf('message_block', 'b-neg-s-edit')).toBeNull()
    expect(blockFrameOf('m-neg-s')).toEqual(frameBeforeA)
    // Only the edited block's own patch outbox was added; no sibling supplement.
    expect(db.select().from(schema.syncOutbox).all().length).toBe(outboxBeforeA + 1)

    // Subcase B: pure message update via updateMessageAndBlocks stays
    // entity-only (sibling outbox without membership, no frame).
    const T1 = 8_210_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(T1)
    expect(agg.ensureTopic('t-neg-m', 'assistant-1', 'T').ok).toBe(true)
    expect(
      agg.appendMessage(
        't-neg-m',
        { id: 'm-neg-m', topicId: 't-neg-m', role: 'user', content: 'p', status: 'success' } as never,
        []
      ).ok
    ).toBe(true)
    insertBlock('b-neg-m-keep', 'm-neg-m', 'success', 0)
    expect(membershipOf('message_block', 'b-neg-m-keep')).toBeNull()
    expect(outboxFor('b-neg-m-keep')).toBeNull()
    vi.spyOn(Date, 'now').mockReturnValue(T1 + 10)
    expect(
      agg.updateMessageAndBlocks('t-neg-m', { id: 'm-neg-m', status: 'success', content: 'edit' } as never, [], []).ok
    ).toBe(true)
    expect(membershipOf('message_block', 'b-neg-m-keep')).toBeNull()
    expect(outboxFor('b-neg-m-keep')).not.toBeNull()
    expect(blockFrameOf('m-neg-m')!.orderedChildIds).toEqual([])
  })

  it('non-success and unsupported promotions never supplement missing siblings', () => {
    // Subcase C: transient→error via updateBlocks versions only the promoted
    // row; the missing-membership success sibling stays local (no outbox, no frame).
    const T0 = 8_300_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(T0)
    expect(agg.ensureTopic('t-neg-e', 'assistant-1', 'T').ok).toBe(true)
    expect(
      agg.appendMessage(
        't-neg-e',
        { id: 'm-neg-e', topicId: 't-neg-e', role: 'user', content: 'p', status: 'success' } as never,
        []
      ).ok
    ).toBe(true)
    insertBlock('b-neg-e-keep', 'm-neg-e', 'success', 0)
    insertBlock('b-neg-e-prom', 'm-neg-e', 'pending', 1)
    const outboxBeforeE = db.select().from(schema.syncOutbox).all().length
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 10)
    expect(
      agg.updateBlocks([{ ...stableBlock('b-neg-e-prom', 'm-neg-e'), status: 'error', content: 'boom' } as never]).ok
    ).toBe(true)
    expect(membershipOf('message_block', 'b-neg-e-prom')).not.toBeNull()
    expect(membershipOf('message_block', 'b-neg-e-keep')).toBeNull()
    expect(outboxFor('b-neg-e-keep')).toBeNull()
    // Error promotion invalidates the empty baseline frame (null) instead of
    // completing it — either way no supplemented order appears.
    expect(blockFrameOf('m-neg-e')?.orderedChildIds ?? []).toEqual([])
    expect(db.select().from(schema.syncOutbox).all().length).toBe(outboxBeforeE + 1)

    // Subcase D: transient→paused via updateSingleBlock leaves the sibling alone.
    const T1 = 8_310_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(T1)
    expect(agg.ensureTopic('t-neg-p', 'assistant-1', 'T').ok).toBe(true)
    expect(
      agg.appendMessage(
        't-neg-p',
        { id: 'm-neg-p', topicId: 't-neg-p', role: 'user', content: 'p', status: 'success' } as never,
        []
      ).ok
    ).toBe(true)
    insertBlock('b-neg-p-keep', 'm-neg-p', 'success', 0)
    insertBlock('b-neg-p-prom', 'm-neg-p', 'pending', 1)
    vi.spyOn(Date, 'now').mockReturnValue(T1 + 10)
    expect(agg.updateSingleBlock('b-neg-p-prom', { status: 'paused', content: 'wait' } as never).ok).toBe(true)
    expect(membershipOf('message_block', 'b-neg-p-prom')).not.toBeNull()
    expect(membershipOf('message_block', 'b-neg-p-keep')).toBeNull()
    expect(outboxFor('b-neg-p-keep')).toBeNull()
    expect(blockFrameOf('m-neg-p')?.orderedChildIds ?? []).toEqual([])

    // Subcase E: unsupported transient→success via updateMessageAndBlocks
    // versions neither the promoted row nor the missing sibling; the sibling
    // rescan stays entity-only without membership and without a frame.
    const T2 = 8_320_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(T2)
    expect(agg.ensureTopic('t-neg-u', 'assistant-1', 'T').ok).toBe(true)
    expect(
      agg.appendMessage(
        't-neg-u',
        { id: 'm-neg-u', topicId: 't-neg-u', role: 'user', content: 'p', status: 'success' } as never,
        []
      ).ok
    ).toBe(true)
    insertBlock('b-neg-u-keep', 'm-neg-u', 'success', 0)
    sqlite
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)`
      )
      .run('b-neg-u-prom', 'm-neg-u', 'tool', 'x', 'pending', '2026-01-01', '2026-01-01', 1)
    vi.spyOn(Date, 'now').mockReturnValue(T2 + 10)
    expect(
      agg.updateMessageAndBlocks(
        't-neg-u',
        { id: 'm-neg-u', status: 'success', content: 'edit' } as never,
        [
          {
            id: 'b-neg-u-prom',
            messageId: 'm-neg-u',
            type: 'tool',
            content: 'x',
            status: 'success',
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01'
          } as never
        ],
        []
      ).ok
    ).toBe(true)
    expect(membershipOf('message_block', 'b-neg-u-prom')).toBeNull()
    expect(outboxFor('b-neg-u-prom')).toBeNull()
    expect(membershipOf('message_block', 'b-neg-u-keep')).toBeNull()
    expect(blockFrameOf('m-neg-u')?.orderedChildIds ?? []).toEqual([])
  })

  it('promotion sibling supplement is atomic: malformed sibling rolls back the promotion with no partial clock/frame/outbox', () => {
    const T0 = 8_000_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(T0)
    expect(agg.ensureTopic('t-supp-rb', 'assistant-1', 'T').ok).toBe(true)
    expect(
      agg.appendMessage(
        't-supp-rb',
        { id: 'm-supp-rb', topicId: 't-supp-rb', role: 'user', content: 'p', status: 'success' } as never,
        []
      ).ok
    ).toBe(true)
    insertBlock('b-supp-rb-keep', 'm-supp-rb', 'success', 0)
    insertBlock('b-supp-rb-prom', 'm-supp-rb', 'pending', 1)
    // Poison the sibling scan: malformed block extra fails the same-tx
    // supplement/frame work, so the whole promotion must roll back.
    sqlite
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run('b-supp-rb-bad', 'm-supp-rb', 'text', 'bad', 'success', '2026-01-01', '2026-01-01', 2, 'not-json')
    const outboxBefore = db.select().from(schema.syncOutbox).all().length
    // Empty messageBlock frame from the stable message creation persists as
    // the pre-promotion baseline; the failed promotion must not advance it.
    const frameBefore = blockFrameOf('m-supp-rb')

    vi.spyOn(Date, 'now').mockReturnValue(T0 + 10)
    const res = agg.updateBlocks([{ ...stableBlock('b-supp-rb-prom', 'm-supp-rb'), content: 'final' } as never])
    expect(res.ok).toBe(false)
    // No partial survives: promoted row stays transient, no membership, no outbox growth, frame unchanged.
    expect(
      (sqlite.prepare(`SELECT status FROM message_blocks WHERE id=?`).get('b-supp-rb-prom') as { status: string })
        .status
    ).toBe('pending')
    expect(membershipOf('message_block', 'b-supp-rb-prom')).toBeNull()
    expect(membershipOf('message_block', 'b-supp-rb-keep')).toBeNull()
    expect(membershipOf('message_block', 'b-supp-rb-bad')).toBeNull()
    expect(db.select().from(schema.syncOutbox).all().length).toBe(outboxBefore)
    expect(blockFrameOf('m-supp-rb')).toEqual(frameBefore)
  })
})
