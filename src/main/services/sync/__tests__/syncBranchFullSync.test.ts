/**
 * True-branch full sync closed loop (baseline wire v3 /
 * topic-message-stable-block-order-branch-v3).
 *
 * Production-code paths only, no scaffolds:
 * - aggregate capture: branch create/rename/delete + branch-owned message
 *   upserts carry branchId owner, branchId-bound membership, and
 *   branchSuffix frames alongside main-only topicMessage frames;
 * - incremental ops: topic_branch upsert/delete + branchSuffix order_frame
 *   converge A→B with stable IDs, ownership, and tombstones;
 * - baseline bootstrap: v3 capture → projection → envelope digest →
 *   adapter → single-transaction merge converges both ways with
 *   baseline/incremental equivalence counts (no false complete).
 */
import { createHash } from 'node:crypto'

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
    set: (k: string, v: unknown) => {
      configStore.set(k, v)
    },
    has: (k: string) => configStore.has(k)
  },
  ConfigKeys: {}
}))

import type { SyncOperation } from '@shared/sync'

import { chatDbService } from '../../chatDb'
import { ChatDbAggregateService } from '../../chatDb/ChatDbAggregateService'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { captureLocalSyncBaselineCandidate } from '../syncBaseline'
import { applyWireSyncEnvelopeInTx, mapWireEnvelopeToMergeInput } from '../syncBaselineWireApply'
import { computeWirePayloadDigestV3, projectLocalBaselineToWirePayloadV3 } from '../syncBaselineWireProjection'
import { SyncOrphanError, syncService } from '../SyncService'
import { seedRegisteredAttachedSyncService } from './helpers/syncTestRegistration'

function openChatDb(): { sqlite: Database.Database; db: BetterSQLite3Database<typeof schema> } {
  const sqlite = new Database(':memory:')
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  runMigrations(db as never, sqlite)
  return { sqlite, db }
}

let sqliteA: Database.Database
let dbA: BetterSQLite3Database<typeof schema>
let sqliteB: Database.Database
let dbB: BetterSQLite3Database<typeof schema>
let aggA: ChatDbAggregateService
let aggB: ChatDbAggregateService

function bind(which: 'A' | 'B'): void {
  const sqlite = which === 'A' ? sqliteA : sqliteB
  const db = which === 'A' ? dbA : dbB
  ;(chatDbService as unknown as { sqlite: unknown }).sqlite = sqlite
  ;(chatDbService as unknown as { db: unknown }).db = db
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
  configStore.set('sync:token', '')
  configStore.set('deviceId', which === 'A' ? 'device-A' : 'device-B')
  configStore.set('sync:explicitDisconnect', false)
}

function stableMessage(id: string, topicId: string, role = 'user', content = `c-${id}`): any {
  return {
    id,
    topicId,
    role,
    content,
    status: 'success',
    askId: null,
    model: null,
    modelId: null,
    assistantId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

function stableBlock(id: string, messageId: string): any {
  return {
    id,
    messageId,
    type: 'main_text',
    content: `c-${id}`,
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

function seedTopic(agg: ChatDbAggregateService, topicId: string): void {
  const res = agg.ensureTopic(topicId, 'a1', `Topic ${topicId}`)
  expect(res.ok).toBe(true)
}

/** Drain A's outbox into B via the production apply path, in push order. Returns applied count. */
function drainAToB(): number {
  bind('A')
  const ops = syncService.listOutbox()
  const ids = ops.map((o) => o.id)
  bind('B')
  let applied = 0
  const deferred: SyncOperation[] = []
  for (const op of ops) {
    try {
      const r = syncService.applyIncomingOperation(op)
      if (r) applied += 1
    } catch (e) {
      // Production pull-loop semantics: orphans defer (SyncOrphanError) and
      // retry as later parents in the same drain arrive; non-orphan throws
      // propagate fail-closed.
      if (e instanceof SyncOrphanError) {
        deferred.push(op)
        continue
      }
      throw e
    }
  }
  // In-drain retry mirrors production tryApplyDeferred: a branch upsert
  // ordered before its anchor message defers, then applies once the anchor
  // lands later in the same drain.
  let progress = true
  let pending = deferred
  while (pending.length > 0 && progress) {
    progress = false
    const still: SyncOperation[] = []
    for (const op of pending) {
      try {
        const r = syncService.applyIncomingOperation(op)
        if (r) applied += 1
        progress = true
      } catch (e) {
        if (e instanceof SyncOrphanError) {
          still.push(op)
          continue
        }
        throw e
      }
    }
    if (still.length === pending.length) break
    pending = still
  }
  if (pending.length > 0) {
    throw new SyncOrphanError(`drain blocked on ${String(pending[0].id)}`)
  }
  bind('A')
  syncService.clearOutboxByIds(ids)
  return applied
}

function outboxOps(which: 'A' | 'B'): SyncOperation[] {
  bind(which)
  return syncService.listOutbox()
}

function frameOf(
  sqlite: Database.Database,
  kind: string,
  parentId: string
): { orderedChildIds: string[]; timestamp: number; operationId: string } | null {
  const r = sqlite
    .prepare(
      `SELECT ordered_child_ids_json AS json, timestamp, operation_id AS operationId FROM sync_parent_order_frame WHERE kind=? AND parent_id=?`
    )
    .get(kind, parentId) as { json: string; timestamp: number; operationId: string } | undefined
  if (!r) return null
  return { orderedChildIds: JSON.parse(r.json) as string[], timestamp: r.timestamp, operationId: r.operationId }
}

function membershipOf(
  sqlite: Database.Database,
  childType: string,
  childId: string
): { parentId: string; timestamp: number; operationId: string } | undefined {
  return sqlite
    .prepare(
      `SELECT parent_id AS parentId, timestamp, operation_id AS operationId FROM sync_membership_clock WHERE child_entity_type=? AND child_entity_id=?`
    )
    .get(childType, childId) as { parentId: string; timestamp: number; operationId: string } | undefined
}

function tombstoneOf(sqlite: Database.Database, entityType: string, entityId: string): boolean {
  const prefix =
    entityType === 'topic'
      ? 'tombstone:topic:'
      : entityType === 'message'
        ? 'tombstone:message:'
        : entityType === 'topic_branch'
          ? 'tombstone:topic_branch:'
          : 'tombstone:message_block:'
  return sqlite.prepare(`SELECT key FROM sync_state WHERE key=?`).get(`${prefix}${entityId}`) !== undefined
}

beforeEach(() => {
  configStore.clear()
  const a = openChatDb()
  sqliteA = a.sqlite
  dbA = a.db
  const b = openChatDb()
  sqliteB = b.sqlite
  dbB = b.db
  bind('A')
  syncService.clearAllForTests()
  seedRegisteredAttachedSyncService(configStore, dbA)
  aggA = new ChatDbAggregateService(dbA, sqliteA)
  bind('B')
  syncService.clearAllForTests()
  seedRegisteredAttachedSyncService(configStore, dbB)
  aggB = new ChatDbAggregateService(dbB, sqliteB)
})

afterEach(() => {
  vi.restoreAllMocks()
  try {
    sqliteA.close()
  } catch {}
  try {
    sqliteB.close()
  } catch {}
  ;(chatDbService as never as { sqlite: unknown }).sqlite = null
  ;(chatDbService as never as { db: unknown }).db = null
})

describe('branch capture: create/rename/message/ordering', () => {
  it('captures branch upsert + empty suffix frame atomically with clocks', () => {
    bind('A')
    seedTopic(aggA, 't1')
    const m1 = stableMessage('m1', 't1')
    expect(aggA.appendMessage('t1', m1, [stableBlock('k1', 'm1')]).ok).toBe(true)
    const created = aggA.createBranch('t1', null, 'm1', 'B1')
    expect(created.ok).toBe(true)
    const branchId =
      (created as unknown as { value: { branch: { id: string } } }).value?.branch?.id ??
      (created as unknown as { branch: { id: string } }).branch?.id
    expect(typeof branchId).toBe('string')

    const ops = outboxOps('A')
    const branchUpsert = ops.find((o) => o.entityType === 'topic_branch' && o.op === 'upsert')
    expect(branchUpsert).toBeTruthy()
    expect((branchUpsert!.payload as Record<string, unknown>)['topicId']).toBe('t1')
    expect((branchUpsert!.payload as Record<string, unknown>)['anchorMessageId']).toBe('m1')
    const suffixFrame = ops.find((o) => o.entityType === 'topic_branch' && o.op === 'order_frame')
    expect(suffixFrame).toBeTruthy()
    expect((suffixFrame!.payload as Record<string, unknown>)['kind']).toBe('branchSuffix')
    expect((suffixFrame!.payload as Record<string, unknown>)['orderedChildIds']).toEqual([])

    // Branch entity + field clocks minted in the same tx.
    const eclock = sqliteA
      .prepare(`SELECT timestamp FROM sync_entity_clock WHERE entity_type='topic_branch' AND entity_id=?`)
      .get(branchUpsert!.entityId) as { timestamp: number } | undefined
    expect(eclock).toBeTruthy()
    const fclock = sqliteA
      .prepare(`SELECT COUNT(*) AS n FROM sync_field_clock WHERE entity_type='topic_branch' AND entity_id=?`)
      .get(branchUpsert!.entityId) as { n: number }
    expect(fclock.n).toBe(3) // name/createdAt/updatedAt

    // Rename captures a name upsert (LWW state, identity untouched).
    const renamed = aggA.renameBranch('t1', branchUpsert!.entityId, 'B1-renamed')
    expect(renamed.ok).toBe(true)
    const ops2 = outboxOps('A')
    const renames = ops2.filter((o) => o.entityType === 'topic_branch' && o.op === 'upsert')
    expect(renames.length).toBeGreaterThanOrEqual(2)
    const last = renames[renames.length - 1]
    expect((last.payload as Record<string, unknown>)['name']).toBe('B1-renamed')
    expect((last.payload as Record<string, unknown>)['anchorMessageId']).toBe('m1')
  })

  it('captures branch-owned messages with branchId owner + branch membership + suffix frame', () => {
    bind('A')
    seedTopic(aggA, 't1')
    expect(aggA.appendMessage('t1', stableMessage('m1', 't1'), [stableBlock('k1', 'm1')]).ok).toBe(true)
    const created = aggA.createBranch('t1', null, 'm1', 'B1')
    expect(created.ok).toBe(true)
    const branchId =
      (created as unknown as { value: { branch: { id: string } } }).value?.branch?.id ??
      (created as unknown as { branch: { id: string } }).branch?.id

    const mb = stableMessage('m2', 't1', 'assistant', 'branch answer')
    const res = aggA.appendMessage('t1', mb, [stableBlock('k2', 'm2')], undefined, undefined, { branchId })
    expect(res.ok).toBe(true)

    const ops = outboxOps('A')
    const mUpsert = ops.find((o) => o.entityType === 'message' && o.entityId === 'm2' && o.op === 'upsert')
    expect(mUpsert).toBeTruthy()
    // topicId stays the immutable logical topic; branchId is the owner.
    expect((mUpsert!.payload as Record<string, unknown>)['topicId']).toBe('t1')
    expect((mUpsert!.payload as Record<string, unknown>)['branchId']).toBe(branchId)
    // Membership binds the branch id.
    const mem = membershipOf(sqliteA, 'message', 'm2')
    expect(mem?.parentId).toBe(branchId)
    // Suffix frame carries the owned suffix; topic frame stays main-only.
    const suffix = frameOf(sqliteA, 'branchSuffix', branchId)
    expect(suffix?.orderedChildIds).toEqual(['m2'])
    const topicFrame = frameOf(sqliteA, 'topicMessage', 't1')
    expect(topicFrame?.orderedChildIds).toEqual(['m1'])
  })

  it('local content edits do not advance frames', () => {
    bind('A')
    seedTopic(aggA, 't1')
    expect(aggA.appendMessage('t1', stableMessage('m1', 't1'), [stableBlock('k1', 'm1')]).ok).toBe(true)
    const created = aggA.createBranch('t1', null, 'm1', 'B1')
    expect(created.ok).toBe(true)
    const branchId =
      (created as unknown as { value: { branch: { id: string } } }).value?.branch?.id ??
      (created as unknown as { branch: { id: string } }).branch?.id
    expect(
      aggA.appendMessage(
        't1',
        stableMessage('m2', 't1', 'assistant', 'b'),
        [stableBlock('k2', 'm2')],
        undefined,
        undefined,
        { branchId }
      ).ok
    ).toBeTruthy()
    const before = frameOf(sqliteA, 'branchSuffix', branchId)
    const upd = aggA.updateMessage('t1', 'm2', { content: 'b-edited' } as never, { branchId })
    expect(upd.ok).toBe(true)
    const after = frameOf(sqliteA, 'branchSuffix', branchId)
    expect(after).toEqual(before)
    // ...but the content edit itself is captured.
    const ops = outboxOps('A')
    const edit = ops.find(
      (o) =>
        o.entityType === 'message' &&
        o.entityId === 'm2' &&
        (o.payload as Record<string, unknown>)['content'] === 'b-edited'
    )
    expect(edit).toBeTruthy()
  })
})

describe('incremental A→B branch convergence', () => {
  function seedBranchWorld(): string {
    bind('A')
    seedTopic(aggA, 't1')
    expect(aggA.appendMessage('t1', stableMessage('m1', 't1'), [stableBlock('k1', 'm1')]).ok).toBe(true)
    expect(aggA.appendMessage('t1', stableMessage('m0', 't1', 'assistant', 'a0'), [stableBlock('k0', 'm0')]).ok).toBe(
      true
    )
    const created = aggA.createBranch('t1', null, 'm1', 'B1')
    expect(created.ok).toBe(true)
    const branchId =
      (created as unknown as { value: { branch: { id: string } } }).value?.branch?.id ??
      (created as unknown as { branch: { id: string } }).branch?.id
    expect(
      aggA.appendMessage(
        't1',
        stableMessage('m2', 't1', 'assistant', 'b'),
        [stableBlock('k2', 'm2')],
        undefined,
        undefined,
        { branchId }
      ).ok
    ).toBeTruthy()
    return branchId
  }

  it('branch data converges A→B with stable IDs, ownership, and frames', () => {
    const branchId = seedBranchWorld()
    drainAToB()

    // Branch row present with immutable identity.
    const brow = sqliteB
      .prepare(
        `SELECT id, topic_id AS topicId, parent_branch_id AS parentBranchId, anchor_message_id AS anchor FROM topic_branches WHERE id=?`
      )
      .get(branchId) as { id: string; topicId: string; parentBranchId: string | null; anchor: string } | undefined
    expect(brow?.topicId).toBe('t1')
    expect(brow?.parentBranchId).toBeNull()
    expect(brow?.anchor).toBe('m1')
    // Owned message keeps owner + topic; main messages unchanged.
    const m2 = sqliteB
      .prepare(`SELECT topic_id AS topicId, branch_id AS branchId FROM messages WHERE id='m2'`)
      .get() as {
      topicId: string
      branchId: string | null
    }
    expect(m2.topicId).toBe('t1')
    expect(m2.branchId).toBe(branchId)
    const m1 = sqliteB.prepare(`SELECT branch_id AS branchId FROM messages WHERE id='m1'`).get() as {
      branchId: string | null
    }
    expect(m1.branchId).toBeNull()
    // Frames: suffix on B matches A; topic frame main-only on both.
    expect(frameOf(sqliteB, 'branchSuffix', branchId)?.orderedChildIds).toEqual(['m2'])
    expect(frameOf(sqliteB, 'topicMessage', 't1')?.orderedChildIds).toEqual(
      frameOf(sqliteA, 'topicMessage', 't1')?.orderedChildIds
    )
    // Membership mirrored.
    expect(membershipOf(sqliteB, 'message', 'm2')?.parentId).toBe(branchId)
    expect(membershipOf(sqliteB, 'message', 'm1')?.parentId).toBe('t1')
    // Effective route equality: B resolves the branch route like A.
    bind('A')
    const effA = aggA.fetchMessages('t1', branchId)
    bind('B')
    const effB = aggB.fetchMessages('t1', branchId)
    expect(effB.ok).toBe(true)
    expect(JSON.stringify((effB as unknown as { value: unknown }).value)).toBe(
      JSON.stringify((effA as unknown as { value: unknown }).value)
    )
  })

  it('offline branch rename + message edit converge by LWW both ways', () => {
    const branchId = seedBranchWorld()
    drainAToB()
    // Drain outboxes so the offline window starts clean. B may have a
    // receiver-union repair frame pending (branchSuffix); clear it so the
    // offline window is isolated — production B would have pushed it.
    bind('A')
    syncService.clearOutboxByIds(outboxOps('A').map((o) => o.id))
    bind('B')
    syncService.clearOutboxByIds(outboxOps('B').map((o) => o.id))
    expect(outboxOps('A')).toHaveLength(0)
    expect(outboxOps('B')).toHaveLength(0)

    // Offline: A renames, B edits the branch message content.
    bind('A')
    expect(aggA.renameBranch('t1', branchId, 'A-name').ok).toBe(true)
    bind('B')
    expect(aggB.updateMessage('t1', 'm2', { content: 'b-content' } as never, { branchId }).ok).toBe(true)

    // Sync B→A then A→B (receiver merges both directions).
    bind('B')
    const opsB = syncService.listOutbox()
    const idsB = opsB.map((o) => o.id)
    bind('A')
    for (const op of opsB) syncService.applyIncomingOperation(op)
    bind('B')
    syncService.clearOutboxByIds(idsB)
    drainAToB()

    bind('A')
    const nameA = sqliteA.prepare(`SELECT name FROM topic_branches WHERE id=?`).get(branchId) as { name: string }
    const contentA = sqliteA.prepare(`SELECT content FROM messages WHERE id='m2'`).get() as { content: string }
    bind('B')
    const nameB = sqliteB.prepare(`SELECT name FROM topic_branches WHERE id=?`).get(branchId) as { name: string }
    const contentB = sqliteB.prepare(`SELECT content FROM messages WHERE id='m2'`).get() as { content: string }
    expect(nameA.name).toBe('A-name')
    expect(nameB.name).toBe('A-name')
    expect(contentA.content).toBe('b-content')
    expect(contentB.content).toBe('b-content')
  })

  it('subtree delete converges with tombstones; ancestor and sibling preserved', () => {
    const branchId = seedBranchWorld()
    // Sibling branch on the same anchor.
    bind('A')
    const sib = aggA.createBranch('t1', null, 'm1', 'SIB')
    expect(sib.ok).toBe(true)
    const sibId =
      (sib as unknown as { value: { branch: { id: string } } }).value?.branch?.id ??
      (sib as unknown as { branch: { id: string } }).branch?.id
    expect(
      aggA.appendMessage(
        't1',
        stableMessage('ms', 't1', 'assistant', 's'),
        [stableBlock('ks', 'ms')],
        undefined,
        undefined,
        { branchId: sibId }
      ).ok
    ).toBeTruthy()
    drainAToB()

    // Delete the first subtree on A, sync.
    bind('A')
    expect(aggA.deleteBranch('t1', branchId).ok).toBe(true)
    // Local tombstones for the whole subtree.
    expect(tombstoneOf(sqliteA, 'topic_branch', branchId)).toBe(true)
    expect(tombstoneOf(sqliteA, 'message', 'm2')).toBe(true)
    // Suffix frame removed locally.
    expect(frameOf(sqliteA, 'branchSuffix', branchId)).toBeNull()
    drainAToB()

    // B: subtree gone, ancestor + sibling intact, tombstones replayed.
    const gone = sqliteB.prepare(`SELECT id FROM topic_branches WHERE id=?`).get(branchId)
    expect(gone).toBeUndefined()
    expect(sqliteB.prepare(`SELECT id FROM messages WHERE id='m2'`).get()).toBeUndefined()
    expect(tombstoneOf(sqliteB, 'topic_branch', branchId)).toBe(true)
    expect(tombstoneOf(sqliteB, 'message', 'm2')).toBe(true)
    expect(frameOf(sqliteB, 'branchSuffix', branchId)).toBeNull()
    // Ancestor prefix and sibling subtree preserved.
    expect(sqliteB.prepare(`SELECT id FROM messages WHERE id='m1'`).get()).toBeTruthy()
    expect(sqliteB.prepare(`SELECT id FROM topic_branches WHERE id=?`).get(sibId)).toBeTruthy()
    expect(sqliteB.prepare(`SELECT id FROM messages WHERE id='ms'`).get()).toBeTruthy()
    expect(frameOf(sqliteB, 'branchSuffix', sibId)?.orderedChildIds).toEqual(['ms'])
  })

  it('remote branch upsert with unknown anchor defers (orphan) and applies after the anchor arrives', () => {
    const branchId = seedBranchWorld()
    drainAToB()
    // Craft a nested branch whose anchor m9 does not exist on B yet.
    bind('A')
    expect(
      aggA.appendMessage(
        't1',
        stableMessage('m9', 't1', 'assistant', 'anchor9'),
        [stableBlock('k9', 'm9')],
        undefined,
        undefined,
        { branchId }
      ).ok
    ).toBeTruthy()
    const nested = aggA.createBranch('t1', branchId, 'm9', 'NEST')
    expect(nested.ok).toBe(true)
    const nestedId =
      (nested as unknown as { value: { branch: { id: string } } }).value?.branch?.id ??
      (nested as unknown as { branch: { id: string } }).branch?.id

    bind('A')
    const ops = syncService.listOutbox()
    const nestedUpsert = ops.find((o) => o.entityType === 'topic_branch' && o.entityId === nestedId)
    expect(nestedUpsert).toBeTruthy()
    // Apply the nested branch BEFORE its anchor on B: must defer, not fallback.
    bind('B')
    expect(() => syncService.applyIncomingOperation(nestedUpsert!)).toThrow(SyncOrphanError)
    // No branch row fabricated.
    expect(sqliteB.prepare(`SELECT id FROM topic_branches WHERE id=?`).get(nestedId)).toBeUndefined()
    // Now deliver everything in order: converges.
    drainAToB()
    expect(sqliteB.prepare(`SELECT id FROM topic_branches WHERE id=?`).get(nestedId)).toBeTruthy()
  })

  it('incoming message never falls back to main when its branch is unknown', () => {
    const branchId = seedBranchWorld()
    drainAToB()
    bind('A')
    expect(
      aggA.appendMessage(
        't1',
        stableMessage('mx', 't1', 'assistant', 'x'),
        [stableBlock('kx', 'mx')],
        undefined,
        undefined,
        { branchId }
      ).ok
    ).toBeTruthy()
    const ops = outboxOps('A')
    const mx = ops.find((o) => o.entityType === 'message' && o.entityId === 'mx')
    expect(mx).toBeTruthy()
    // Simulate branch-unknown receiver: drop the branch row + tombstone on B, then apply.
    bind('B')
    sqliteB.prepare(`DELETE FROM topic_branches WHERE id=?`).run(branchId)
    expect(() => syncService.applyIncomingOperation(mx!)).toThrow(SyncOrphanError)
    // No main-route row fabricated.
    expect(sqliteB.prepare(`SELECT id FROM messages WHERE id='mx'`).get()).toBeUndefined()
  })
})

describe('baseline v3 bootstrap both ways + equivalence', () => {
  // hashHex intentionally unused in this file but kept for parity with production
  // helper; reference to avoid TS6133.
  function hashHex(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex')
  }
  void hashHex

  function seedBothSides(): string {
    bind('A')
    seedTopic(aggA, 't1')
    expect(aggA.appendMessage('t1', stableMessage('m1', 't1'), [stableBlock('k1', 'm1')]).ok).toBe(true)
    const created = aggA.createBranch('t1', null, 'm1', 'B1')
    const branchId =
      (created as unknown as { branch: { id: string } }).branch?.id ??
      (created as unknown as { value: { branch: { id: string } } }).value?.branch?.id
    expect(
      aggA.appendMessage(
        't1',
        stableMessage('m2', 't1', 'assistant', 'b'),
        [stableBlock('k2', 'm2')],
        undefined,
        undefined,
        { branchId }
      ).ok
    ).toBeTruthy()
    drainAToB()
    // Seed bound watermark so baseline candidate is complete (production
    // channel/cursor are observed; tests need explicit rows). Also clear
    // receiver-repair frames (branchSuffix) minted during the drain so
    // pendingOutbox does not make the candidate partial.
    for (const which of ['A', 'B'] as const) {
      const sqlite = which === 'A' ? sqliteA : sqliteB
      sqlite.prepare(`INSERT OR REPLACE INTO sync_state(key, value) VALUES('cursor','5')`).run()
      sqlite.prepare(`INSERT OR REPLACE INTO sync_state(key, value) VALUES('sync:channelKey','chan-test')`).run()
    }
    bind('A')
    syncService.clearOutboxByIds(syncService.listOutbox().map((o) => o.id))
    bind('B')
    syncService.clearOutboxByIds(syncService.listOutbox().map((o) => o.id))
    return branchId
  }

  function inventoryCounts(sqlite: Database.Database): Record<string, number> {
    const q = (sql: string): number => (sqlite.prepare(sql).get() as { n: number }).n
    return {
      topics: q(`SELECT COUNT(*) AS n FROM topics`),
      messages: q(`SELECT COUNT(*) AS n FROM messages`),
      blocks: q(`SELECT COUNT(*) AS n FROM message_blocks`),
      branches: (() => {
        try {
          return q(`SELECT COUNT(*) AS n FROM topic_branches`)
        } catch {
          return -1
        }
      })(),
      topicFrames: q(`SELECT COUNT(*) AS n FROM sync_parent_order_frame WHERE kind='topicMessage'`),
      blockFrames: q(`SELECT COUNT(*) AS n FROM sync_parent_order_frame WHERE kind='messageBlock'`),
      suffixFrames: q(`SELECT COUNT(*) AS n FROM sync_parent_order_frame WHERE kind='branchSuffix'`)
    }
  }

  function bootstrapAToFreshC(): Database.Database {
    bind('A')
    // Ensure bound if seedBothSides was not used (defense-in-depth).
    sqliteA.prepare(`INSERT OR REPLACE INTO sync_state(key, value) VALUES('cursor','5')`).run()
    sqliteA.prepare(`INSERT OR REPLACE INTO sync_state(key, value) VALUES('sync:channelKey','chan-test')`).run()
    const candidate = captureLocalSyncBaselineCandidate(dbA)
    expect(candidate.completeness.state).toBe('complete')
    const payload = projectLocalBaselineToWirePayloadV3(candidate)
    // Exact wire spelling for the next units: lowerCamelCase keys, branch counts, digest.
    expect(payload.inventoryVersion).toBe('topic-message-stable-block-order-branch-v3')
    expect(payload.messages.find((m) => m.id === 'm2')?.branchId).toBeTruthy()
    expect(payload.messages.find((m) => m.id === 'm1')?.branchId).toBeNull()
    const digest = computeWirePayloadDigestV3(payload)
    const envelope = {
      wireVersion: 'sync-baseline-wire-v3',
      channelId: 'ch-test',
      watermark: 3,
      digestScheme: 'jcs-sha256-v1',
      digest,
      payload
    }
    const { input } = mapWireEnvelopeToMergeInput(envelope)
    const opened = openChatDb()
    opened.db.transaction((tx) => {
      applyWireSyncEnvelopeInTx(tx as never, envelope)
      void input
    })
    return opened.sqlite
  }

  it('bootstrap A→C matches incremental B exactly (no false complete)', () => {
    seedBothSides()
    const sqliteC = bootstrapAToFreshC()
    try {
      // Baseline+incremental equivalence: same logical inventory on both paths.
      expect(inventoryCounts(sqliteC)).toEqual(inventoryCounts(sqliteB))
      // Branch ownership identical.
      const cBranch = sqliteC
        .prepare(`SELECT topic_id AS t, parent_branch_id AS p, anchor_message_id AS a FROM topic_branches`)
        .all()
      bind('B')
      const bBranch = sqliteB
        .prepare(`SELECT topic_id AS t, parent_branch_id AS p, anchor_message_id AS a FROM topic_branches`)
        .all()
      expect(cBranch).toEqual(bBranch)
    } finally {
      try {
        sqliteC.close()
      } catch {}
    }
  })

  it('bootstrap B→fresh D after subtree delete matches incremental A', () => {
    const branchId = seedBothSides()
    bind('A')
    expect(aggA.deleteBranch('t1', branchId).ok).toBe(true)
    drainAToB()

    bind('B')
    const candidate = captureLocalSyncBaselineCandidate(dbB)
    expect(candidate.completeness.state).toBe('complete')
    const payload = projectLocalBaselineToWirePayloadV3(candidate)
    expect(payload.branches).toHaveLength(0)
    expect(payload.manifest.liveCounts.branch).toBe(0)
    const digest = computeWirePayloadDigestV3(payload)
    const envelope = {
      wireVersion: 'sync-baseline-wire-v3',
      channelId: 'ch-test',
      watermark: 9,
      digestScheme: 'jcs-sha256-v1',
      digest,
      payload
    }
    const opened = openChatDb()
    opened.db.transaction((tx) => {
      applyWireSyncEnvelopeInTx(tx as never, envelope)
    })
    try {
      expect(inventoryCounts(opened.sqlite)).toEqual(inventoryCounts(sqliteA))
      // Original main unchanged on both.
      for (const sqlite of [opened.sqlite, sqliteA]) {
        const m1 = sqlite.prepare(`SELECT branch_id AS b FROM messages WHERE id='m1'`).get() as { b: null }
        expect(m1.b).toBeNull()
      }
    } finally {
      try {
        opened.sqlite.close()
      } catch {}
    }
  })
})

describe('branch reference governance over sync', () => {
  it('stable IDs, owner equality, and immutable identity hold across the wire', () => {
    bind('A')
    seedTopic(aggA, 't1')
    expect(aggA.appendMessage('t1', stableMessage('m1', 't1'), [stableBlock('k1', 'm1')]).ok).toBe(true)
    const created = aggA.createBranch('t1', null, 'm1', 'B1')
    const branchId =
      (created as unknown as { branch: { id: string } }).branch?.id ??
      (created as unknown as { value: { branch: { id: string } } }).value?.branch?.id
    drainAToB()

    // Reparent attempt via forged op: same message id, different owner → rejected, no row.
    bind('B')
    const forged = {
      id: '11111111-1111-4111-8111-111111111111',
      entityType: 'message',
      op: 'upsert',
      entityId: 'm1',
      timestamp: Date.now(),
      deviceId: 'device-X',
      payload: { id: 'm1', topicId: 't1', branchId, role: 'user', content: 'hijack' }
    } as unknown as SyncOperation
    expect(syncService.applyIncomingOperation(forged)).toBe(false)
    const m1 = sqliteB.prepare(`SELECT branch_id AS b, content AS c FROM messages WHERE id='m1'`).get() as {
      b: null
      c: string
    }
    expect(m1.b).toBeNull()
    expect(m1.c).toBe('c-m1')

    // Missing-anchor branch stays governed: forged branch on unknown anchor defers.
    const forgedBranch = {
      id: '22222222-2222-4222-8222-222222222222',
      entityType: 'topic_branch',
      op: 'upsert',
      entityId: 'bx',
      timestamp: Date.now(),
      deviceId: 'device-X',
      payload: { id: 'bx', topicId: 't1', parentBranchId: null, anchorMessageId: 'nope', name: 'X' }
    } as unknown as SyncOperation
    expect(() => syncService.applyIncomingOperation(forgedBranch)).toThrow(SyncOrphanError)
    expect(sqliteB.prepare(`SELECT id FROM topic_branches WHERE id='bx'`).get()).toBeUndefined()
  })
})
