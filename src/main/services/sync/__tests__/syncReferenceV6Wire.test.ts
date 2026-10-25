/**
 * Baseline v6: cross-topic history reference projection, wire compatibility,
 * apply, and receiver-union adoption.
 *
 * Positive: a relation is declared explicitly (v6 inventory), validates, and
 * round-trips through the strict validator, digest, merge input, and merge core
 * with ONE coherent tuple per target topic.
 * Negative: unknown wire versions, partial tuples, relation without its target
 * topic, and a mismatched manifest all fail closed.
 * Compatibility: v1-v5 parsing/digest behavior is unchanged (v5 payload still
 * validates and digests identically); v5 is never silently upgraded.
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
    set: (k: string, v: unknown) => configStore.set(k, v),
    has: (k: string) => configStore.has(k)
  },
  ConfigKeys: {}
}))

import {
  computeSyncDigest,
  INVENTORY_VERSION_V5,
  PAYLOAD_SCHEMA_V5,
  SCOPE_V5,
  validateEnvelopeAny,
  validatePayloadAny,
  validatePayloadV6,
  ValidationError,
  WIRE_VERSION_V6
} from '@shared/sync'

import { chatDbService } from '../../chatDb'
import { ChatDbAggregateService } from '../../chatDb/ChatDbAggregateService'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { captureLocalSyncBaselineCandidate } from '../syncBaseline'
import { mergeValidatedBaselineInTx } from '../syncBaselineApply'
import { mapWireEnvelopeToMergeInput } from '../syncBaselineWireApply'
import {
  computeWirePayloadDigestV5,
  computeWirePayloadDigestV6,
  projectLocalBaselineToWirePayloadV5,
  projectLocalBaselineToWirePayloadV6
} from '../syncBaselineWireProjection'
import { adoptReceiverExclusiveInTx } from '../syncReceiverUnion'
import { adoptSeedBaselineOnce } from '../syncSeedAdoption'
import { syncService } from '../SyncService'
import { seedRegisteredAttachedSyncService } from './helpers/syncTestRegistration'

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

function openChatDb(): { sqlite: Database.Database; db: BetterSQLite3Database<typeof schema> } {
  const sqlite = new Database(':memory:')
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  runMigrations(db as never, sqlite)
  return { sqlite, db }
}
function bindSingleton(sqlite: Database.Database, db: BetterSQLite3Database<typeof schema>): void {
  ;(chatDbService as unknown as { sqlite: unknown }).sqlite = sqlite
  ;(chatDbService as unknown as { db: unknown }).db = db
}
function drainOutbox(sqlite: Database.Database): void {
  // Simulate a drained publisher barrier (outbox empty, clocks retained).
  sqlite.prepare('DELETE FROM sync_outbox').run()
}
function seedBound(db: BetterSQLite3Database<typeof schema>): void {
  db.insert(schema.syncState).values({ key: 'sync:channelKey', value: 'chan-ref-test' }).run()
  db.insert(schema.syncState).values({ key: 'cursor', value: '0' }).run()
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
    content: `content-${id}`,
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>
let agg: ChatDbAggregateService

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
  const opened = openChatDb()
  sqlite = opened.sqlite
  db = opened.db
  bindSingleton(sqlite, db)
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

describe('baseline v6 reference wire', () => {
  it('projects a live reference, validates strictly, and digests payload-only', () => {
    const src = 't-v6-src'
    agg.appendMessage(src, msgJson('m-v6-0', src) as never, [blockJson('b-v6-0', 'm-v6-0') as never])
    const created = agg.createReferencedTopic(src, null, 't-v6-dst', 'm-v6-0')
    expect(created.ok).toBe(true)
    seedBound(db)
    drainOutbox(sqlite)

    const candidate = captureLocalSyncBaselineCandidate(db)
    expect(candidate.references).toHaveLength(1)
    expect(candidate.references[0].targetTopicId).toBe('t-v6-dst')
    expect(candidate.references[0].entityClock).not.toBeNull()
    expect(candidate.completeness.state).toBe('complete')

    const payload = projectLocalBaselineToWirePayloadV6(candidate)
    expect(payload.payloadSchema).toBe('chat-core-baseline-v6')
    expect(payload.topicReferences).toEqual([
      {
        targetTopicId: 't-v6-dst',
        sourceTopicId: src,
        sourceBranchId: null,
        anchorMessageId: 'm-v6-0',
        entityClock: payload.topicReferences[0].entityClock
      }
    ])
    expect(payload.manifest.liveCounts.topicReference).toBe(1)
    expect(payload.manifest.tombstoneCounts.topicReference).toBe(0)

    const digest = computeWirePayloadDigestV6(payload)
    const envelope = {
      wireVersion: WIRE_VERSION_V6,
      channelId: 'chan-ref-test',
      watermark: 0,
      digestScheme: 'jcs-sha256-v1',
      digest,
      payload
    }
    const validated = validateEnvelopeAny(envelope)
    expect(validated.wireVersion).toBe(WIRE_VERSION_V6)
    expect(computeSyncDigest(validated.payload, sha256Hex)).toBe(digest)

    // Every prefix row stays owned by the source topic: nothing copied.
    expect(payload.messages.every((m) => m.topicId === src)).toBe(true)
  })

  it('rejects unknown versions, partial tuples, an orphan relation, and a tampered manifest', () => {
    const src = 't-v6-neg-src'
    agg.appendMessage(src, msgJson('m-v6-n0', src) as never, [blockJson('b-v6-n0', 'm-v6-n0') as never])
    agg.createReferencedTopic(src, null, 't-v6-neg-dst', 'm-v6-n0')
    seedBound(db)
    drainOutbox(sqlite)
    const payload = projectLocalBaselineToWirePayloadV6(captureLocalSyncBaselineCandidate(db))

    // Unknown version fails closed (never downgraded/silently accepted).
    expect(() =>
      validateEnvelopeAny({
        wireVersion: 'sync-baseline-wire-v999',
        channelId: 'chan',
        watermark: 0,
        digestScheme: 'jcs-sha256-v1',
        digest: 'a'.repeat(64),
        payload
      })
    ).toThrow(ValidationError)

    // Incoherent tuple (anchor dropped) fails closed.
    const partial = structuredClone(payload)
    delete (partial.topicReferences[0] as unknown as Record<string, unknown>).anchorMessageId
    expect(() => validatePayloadV6(partial)).toThrow(ValidationError)

    // Relation whose target topic is not live in the same payload fails closed.
    const orphan = structuredClone(payload)
    orphan.topics = orphan.topics.filter((t) => t.id !== 't-v6-neg-dst')
    expect(() => validatePayloadV6(orphan)).toThrow(ValidationError)

    // Manifest count mismatch fails closed even when the digest is recomputed.
    const tampered = structuredClone(payload)
    tampered.manifest.liveCounts.topicReference = 0
    expect(() => validatePayloadV6(tampered)).toThrow(ValidationError)

    // A v5 payload (no references) still validates and digests exactly as before.
    const v5 = projectLocalBaselineToWirePayloadV5(captureLocalSyncBaselineCandidate(db))
    expect(v5.payloadSchema).toBe(PAYLOAD_SCHEMA_V5)
    expect(v5.inventoryVersion).toBe(INVENTORY_VERSION_V5)
    expect(v5.scope).toBe(SCOPE_V5)
    expect(validatePayloadAny(v5)).toBeTruthy()
    expect(computeWirePayloadDigestV5(v5)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('applies the reference to a receiver and keeps the tuple coherent across replays', () => {
    const src = 't-v6-apply-src'
    agg.appendMessage(src, msgJson('m-v6-a0', src) as never, [blockJson('b-v6-a0', 'm-v6-a0') as never])
    agg.createReferencedTopic(src, null, 't-v6-apply-dst', 'm-v6-a0')
    seedBound(db)
    drainOutbox(sqlite)
    const payload = projectLocalBaselineToWirePayloadV6(captureLocalSyncBaselineCandidate(db))
    const digest = computeWirePayloadDigestV6(payload)
    const envelope = {
      wireVersion: WIRE_VERSION_V6,
      channelId: 'chan-ref-test',
      watermark: 0,
      digestScheme: 'jcs-sha256-v1',
      digest,
      payload
    }

    // Receiver database.
    const rx = openChatDb()
    try {
      const mapped = mapWireEnvelopeToMergeInput(envelope)
      expect(mapped.input.entities.some((e) => e.entityType === 'topic_reference')).toBe(true)
      const res1 = mergeValidatedBaselineInTx(rx.db as never, mapped.input)
      expect(res1.inserted).toBeGreaterThan(0)
      const rel = rx.sqlite
        .prepare('SELECT target_topic_id, source_topic_id, source_branch_id, anchor_message_id FROM topic_references')
        .all() as Array<{
        target_topic_id: string
        source_topic_id: string
        source_branch_id: string | null
        anchor_message_id: string
      }>
      expect(rel).toHaveLength(1)
      expect(rel[0]).toEqual({
        target_topic_id: 't-v6-apply-dst',
        source_topic_id: src,
        source_branch_id: null,
        anchor_message_id: 'm-v6-a0'
      })
      // Replay is idempotent (no duplicate tuple, no rewrite).
      const res2 = mergeValidatedBaselineInTx(rx.db as never, mapWireEnvelopeToMergeInput(envelope).input)
      expect(res2.inserted).toBe(0)
      expect((rx.sqlite.prepare('SELECT COUNT(*) AS c FROM topic_references').get() as { c: number }).c).toBe(1)
    } finally {
      rx.sqlite.close()
    }
  })

  it('adopts a fully-local reference relation through seed adoption before publish', () => {
    const src = 't-v6-seed-src'
    agg.appendMessage(src, msgJson('m-v6-s0', src) as never, [blockJson('b-v6-s0', 'm-v6-s0') as never])
    agg.createReferencedTopic(src, null, 't-v6-seed-dst', 'm-v6-s0')
    seedBound(db)
    // Fully-local pre-sync state: business rows only, no clocks/outbox/frames.
    sqlite.prepare("DELETE FROM sync_outbox WHERE entity_id IN ('t-v6-seed-dst')").run()
    sqlite.prepare("DELETE FROM sync_entity_clock WHERE entity_id = 't-v6-seed-dst'").run()
    sqlite.prepare("DELETE FROM sync_field_clock WHERE entity_id = 't-v6-seed-dst'").run()
    sqlite.prepare("DELETE FROM sync_parent_order_frame WHERE parent_id = 't-v6-seed-dst'").run()
    sqlite.prepare("DELETE FROM sync_frame_high_water WHERE parent_id = 't-v6-seed-dst'").run()

    const before = captureLocalSyncBaselineCandidate(db)
    expect(before.references[0].entityClock).toBeNull()

    const result = adoptSeedBaselineOnce(db as never, syncService as never)
    expect(result.kind).toBe('adopted')

    const after = captureLocalSyncBaselineCandidate(db)
    expect(after.references[0].entityClock).not.toBeNull()
    expect(after.references[0].sourceTopicId).toBe(src)
    expect(after.references[0].anchorMessageId).toBe('m-v6-s0')
    const outbox = sqlite
      .prepare("SELECT op FROM sync_outbox WHERE entity_type='topic_reference' AND entity_id='t-v6-seed-dst'")
      .get() as { op: string } | undefined
    expect(outbox?.op).toBe('upsert')
  })

  it('adopts a fully-local reference relation on bootstrap instead of syncing a bare target topic', () => {
    const src = 't-v6-union-src'
    agg.appendMessage(src, msgJson('m-v6-u0', src) as never, [blockJson('b-v6-u0', 'm-v6-u0') as never])
    agg.createReferencedTopic(src, null, 't-v6-union-dst', 'm-v6-u0')

    // Simulate a pre-sync (fully local) reference: strip every clock/outbox
    // artifact while the business rows stay.
    sqlite.prepare("DELETE FROM sync_outbox WHERE entity_id IN ('t-v6-union-dst','m-v6-u0','b-v6-u0')").run()
    sqlite
      .prepare(
        "DELETE FROM sync_entity_clock WHERE entity_id IN ('t-v6-union-dst') AND entity_type IN ('topic','topic_reference')"
      )
      .run()
    sqlite.prepare("DELETE FROM sync_entity_clock WHERE entity_id = 't-v6-union-dst'").run()
    sqlite.prepare("DELETE FROM sync_field_clock WHERE entity_id = 't-v6-union-dst'").run()
    sqlite.prepare("DELETE FROM sync_parent_order_frame WHERE parent_id = 't-v6-union-dst'").run()
    sqlite.prepare("DELETE FROM sync_frame_high_water WHERE parent_id = 't-v6-union-dst'").run()

    const candidate = captureLocalSyncBaselineCandidate(db)
    expect(candidate.references[0].entityClock).toBeNull()
    expect(candidate.completeness.reasons).toContain('unversioned-entity')

    // Incoming baseline from the peer carrying the source topic only.
    const incoming = {
      entities: [
        {
          entityType: 'topic' as const,
          entityId: src,
          payload: candidate.entities.find((e) => e.entityType === 'topic' && e.entityId === src)!.payload,
          entityClock: { timestamp: 10, operationId: 'op-src' },
          fieldClocks: candidate.entities
            .find((e) => e.entityType === 'topic' && e.entityId === src)!
            .fieldClocks.map((f) => ({ ...f, timestamp: 10, operationId: 'op-src' }))
        }
      ],
      tombstones: [],
      orderFrames: []
    }

    const union = adoptReceiverExclusiveInTx(db as never, incoming, 'device-local', 1_000)
    expect(union.adopted).toBeGreaterThan(0)

    const refClock = sqlite
      .prepare(
        "SELECT timestamp, operation_id FROM sync_entity_clock WHERE entity_type='topic_reference' AND entity_id='t-v6-union-dst'"
      )
      .get() as { timestamp: number; operation_id: string } | undefined
    expect(refClock).toBeDefined()
    const outboxRef = sqlite
      .prepare("SELECT op FROM sync_outbox WHERE entity_type='topic_reference' AND entity_id='t-v6-union-dst'")
      .get() as { op: string } | undefined
    expect(outboxRef?.op).toBe('upsert')

    // The adopted relation is now publishable (no unversioned reference left).
    const after = captureLocalSyncBaselineCandidate(db)
    expect(after.references[0].entityClock).not.toBeNull()
  })
})
