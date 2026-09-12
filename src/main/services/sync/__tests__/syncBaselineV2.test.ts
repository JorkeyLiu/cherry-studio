/**
 * Baseline v2 (SYNC-DATA-056 / §10B / §15-15): capture/projection/publish/
 * fetch/apply/bootstrap with replacementRegisters.
 * Covers: same-snapshot register capture, v2 projection sort/count/digest,
 * wire apply LWW + exact-replay idempotent + divergent rollback, retirement
 * barrier via tombstones, publish v2 + fetch v1/v2 + bootstrap N+1.
 */
import { createHash } from 'node:crypto'

import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
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
    set: (k: string, v: unknown) => configStore.set(k, v)
  },
  ConfigKeys: {}
}))

import {
  computeSyncDigest,
  INVENTORY_VERSION_V2,
  PAYLOAD_SCHEMA_V2,
  SCOPE_V2,
  validateEnvelope,
  validatePayload,
  verifyEnvelopeDigest,
  verifySyncDigest,
  WIRE_VERSION_V2
} from '@shared/sync'

import { chatDbService } from '../../chatDb'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { captureLocalSyncBaselineCandidate } from '../syncBaseline'
import { mergeValidatedBaselineInTx } from '../syncBaselineApply'
import { assertBarrierSnapshotProof, buildPublishEnvelope } from '../syncBaselinePublish'
import { applyWireSyncEnvelopeInTx } from '../syncBaselineWireApply'
import { computeWirePayloadDigest, projectLocalBaselineToWirePayload } from '../syncBaselineWireProjection'
import { syncClient } from '../SyncClient'
import { syncService } from '../SyncService'
import { seedRegisteredAttachedSyncService } from './helpers/syncTestRegistration'

let sqlite: Database.Database
let db: BetterSQLite3Database<typeof schema>

function hashHex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function openInMemory(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

const T = 9_000_000

function insertTopic(id: string): void {
  sqlite
    .prepare('INSERT INTO topics (id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?)')
    .run(
      id,
      `Topic ${id}`,
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      null,
      JSON.stringify({ pinned: true, prompt: 'keep', isNameManuallyEdited: false })
    )
}

function insertMessage(id: string, topicId: string): void {
  sqlite
    .prepare(
      'INSERT INTO messages (id, topic_id, role, content, status, created_at, updated_at, sort_order) VALUES (?,?,?,?,?,?,?,?)'
    )
    .run(id, topicId, 'user', `content-${id}`, 'success', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 0)
}

function insertBlock(id: string, messageId: string): void {
  sqlite
    .prepare(
      'INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)'
    )
    .run(
      id,
      messageId,
      'main_text',
      `body-${id}`,
      'success',
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      0,
      null
    )
}

function seedEntityClock(type: string, id: string, ts = T, op?: string): void {
  db.insert(schema.syncEntityClock)
    .values({ entityType: type, entityId: id, timestamp: ts, operationId: op ?? `op-${id}` })
    .run()
}

function seedField(type: string, id: string, field: string, ts = T, op?: string): void {
  db.insert(schema.syncFieldClock)
    .values({ entityType: type, entityId: id, field, timestamp: ts, operationId: op ?? `op-${id}` })
    .run()
}

function seedFullTopic(id: string): void {
  for (const f of [
    'name',
    'assistantId',
    'createdAt',
    'updatedAt',
    'deletedAt',
    'pinned',
    'prompt',
    'isNameManuallyEdited'
  ])
    seedField('topic', id, f)
}

function seedFullMessage(id: string): void {
  for (const f of ['role', 'content', 'status', 'askId', 'model', 'modelId', 'assistantId', 'createdAt', 'updatedAt'])
    seedField('message', id, f)
}

function seedFullBlock(id: string): void {
  for (const f of ['type', 'content', 'status', 'createdAt', 'updatedAt']) seedField('message_block', id, f)
}

function seedMembership(childType: 'message' | 'message_block', childId: string, parentId: string): void {
  db.insert(schema.syncMembershipClock)
    .values({
      childEntityType: childType,
      childEntityId: childId,
      parentId,
      timestamp: T,
      operationId: `op-${childId}`
    })
    .run()
}

function seedFrame(kind: 'topicMessage' | 'messageBlock', parentId: string, ordered: string[]): void {
  sqlite
    .prepare(
      'INSERT OR REPLACE INTO sync_parent_order_frame (kind, parent_id, frame_version, ordered_child_ids_json, timestamp, operation_id) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(kind, parentId, 'parent-order-frame-v1', JSON.stringify(ordered), T + 10, `op-frame-${parentId}`)
}

function seedBound(channel = 'chan-v2', cursor = '7'): void {
  sqlite.prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)').run('cursor', cursor)
  sqlite.prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES(?, ?)').run('sync:channelKey', channel)
}

function seedCompleteChain(tid: string, mid: string, bid: string): void {
  insertTopic(tid)
  insertMessage(mid, tid)
  insertBlock(bid, mid)
  seedEntityClock('topic', tid)
  seedEntityClock('message', mid)
  seedEntityClock('message_block', bid)
  seedFullTopic(tid)
  seedFullMessage(mid)
  seedFullBlock(bid)
  seedMembership('message', mid, tid)
  seedMembership('message_block', bid, mid)
  seedFrame('topicMessage', tid, [mid])
  seedFrame('messageBlock', mid, [bid])
}

function seedRegister(messageId: string, ts: number, op: string, active: string[]): void {
  sqlite
    .prepare(
      'INSERT OR REPLACE INTO sync_stable_replace_register (message_id, timestamp, operation_id, active_block_ids_json, payload_hash) VALUES (?, ?, ?, ?, ?)'
    )
    .run(messageId, ts, op, JSON.stringify(active), `hash-${messageId}-${op}`)
}

function readRegister(messageId: string): any {
  return sqlite.prepare('SELECT * FROM sync_stable_replace_register WHERE message_id=?').get(messageId)
}

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
  configStore.set('sync:token', '')
  sqlite = openInMemory()
  db = drizzle(sqlite, { schema })
  runMigrations(db as any, sqlite)
  ;(chatDbService as any).sqlite = sqlite
  ;(chatDbService as any).db = db
  syncService.clearAllForTests()
  syncService.resetShutdownForTests()
  seedRegisteredAttachedSyncService(configStore, db)
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
  try {
    sqlite.close()
  } catch {}
  ;(chatDbService as any).sqlite = null
  ;(chatDbService as any).db = null
})

describe('baseline v2 capture/projection', () => {
  it('captures the full register set in the same snapshot and projects sorted v2 with count+digest', () => {
    seedCompleteChain('t-v2', 'm-v2', 'b-v2')
    seedRegister('m-v2', T + 20, 'op-rep-1', ['b-v2'])
    seedRegister('m-other', T + 5, 'op-rep-0', [])
    seedBound()
    const candidate = captureLocalSyncBaselineCandidate(db)
    expect(candidate.completeness.state).toBe('complete')
    expect(candidate.replacementRegisters).toHaveLength(2)
    // Lexical order locally; wire projection enforces UTF-8 byte lex.
    const payload = projectLocalBaselineToWirePayload(candidate)
    expect(payload.payloadSchema).toBe(PAYLOAD_SCHEMA_V2)
    expect(payload.inventoryVersion).toBe(INVENTORY_VERSION_V2)
    expect(payload.scope).toBe(SCOPE_V2)
    expect(payload.replacementRegisters.map((r) => r.messageId)).toEqual(['m-other', 'm-v2'])
    expect(payload.manifest.replacementCount).toBe(2)
    expect(() => validatePayload(payload)).not.toThrow()
    const digest = computeWirePayloadDigest(payload)
    expect(typeof digest).toBe('string')
    // Tampering the register array breaks the payload-only digest.
    const tampered = JSON.parse(JSON.stringify(payload))
    tampered.replacementRegisters[0].activeBlockIds.push('b-evil')
    expect(() => validatePayload(tampered)).not.toThrow()
    expect(verifySyncDigest(tampered, digest, hashHex)).toBe(false)
  })

  it('empty register table projects v2 with zero count', () => {
    seedCompleteChain('t-e', 'm-e', 'b-e')
    seedBound()
    const candidate = captureLocalSyncBaselineCandidate(db)
    expect(candidate.replacementRegisters).toEqual([])
    const payload = projectLocalBaselineToWirePayload(candidate)
    expect(payload.replacementRegisters).toEqual([])
    expect(payload.manifest.replacementCount).toBe(0)
    expect(() => validatePayload(payload)).not.toThrow()
  })
})

describe('baseline v2 wire apply', () => {
  function buildV2Envelope(channel: string, watermark: number, registers: any[]): any {
    // The caller seeds its own complete chain before invoking; here we only
    // ensure the channel/cursor binding then project the current snapshot and
    // deterministically patch the register vector before re-signing. Patching
    // keeps entity/frame closure intact because registers do not participate
    // in parent closure.
    seedBound(channel, String(watermark))
    const candidate = captureLocalSyncBaselineCandidate(db)
    if (candidate.completeness.state !== 'complete') {
      throw new Error(`test setup candidate not complete: ${candidate.completeness.reasons.join(',')}`)
    }
    const payload = projectLocalBaselineToWirePayload(candidate) as any
    payload.replacementRegisters = registers
    payload.manifest.replacementCount = registers.length
    const digest = computeWirePayloadDigest(payload)
    return {
      wireVersion: WIRE_VERSION_V2,
      channelId: channel,
      watermark,
      digestScheme: 'jcs-sha256-v1',
      digest,
      payload
    }
  }

  it('v2 bootstrap atomically merges a winning register', () => {
    seedCompleteChain('t-a', 'm-a', 'b-a')
    seedBound('chan-a', '0')
    const envelope = buildV2Envelope('chan-a', 3, [
      { messageId: 'm-a', replacementClock: { timestamp: T + 50, operationId: 'op-win' }, activeBlockIds: ['b-a'] }
    ])
    expect(() => validateEnvelope(envelope)).not.toThrow()
    expect(verifyEnvelopeDigest(envelope, hashHex)).toBe(true)
    db.transaction((tx) => {
      const out = applyWireSyncEnvelopeInTx(tx as any, envelope, { expectedChannelId: 'chan-a' })
      expect(out.watermark).toBe(3)
    })
    const reg = readRegister('m-a')
    expect(reg.timestamp).toBe(T + 50)
    expect(reg.operation_id).toBe('op-win')
    expect(JSON.parse(reg.active_block_ids_json)).toEqual(['b-a'])
  })

  it('equal-clock exact replay is idempotent; divergence rolls back atomically', () => {
    seedCompleteChain('t-d', 'm-d', 'b-d')
    seedRegister('m-d', T + 50, 'op-same', ['b-d'])
    seedBound('chan-d', '0')
    const beforeTopics = sqlite.prepare('SELECT count(*) as c FROM topics').get() as { c: number }
    const candidate = captureLocalSyncBaselineCandidate(db)
    expect(() =>
      db.transaction((tx) => {
        mergeValidatedBaselineInTx(tx as any, {
          entities: [],
          tombstones: [],
          orderFrames: [],
          replacementRegisters: [
            { messageId: 'm-d', timestamp: T + 50, operationId: 'op-same', activeBlockIds: ['b-d'] }
          ]
        })
      })
    ).not.toThrow()
    expect(JSON.parse(readRegister('m-d').active_block_ids_json)).toEqual(['b-d'])
    // Divergent equal clock: same clock, different active set must fail closed.
    expect(() =>
      db.transaction((tx) => {
        mergeValidatedBaselineInTx(tx as any, {
          entities: [],
          tombstones: [],
          orderFrames: [],
          replacementRegisters: [{ messageId: 'm-d', timestamp: T + 50, operationId: 'op-same', activeBlockIds: [] }]
        })
      })
    ).toThrow(/divergence/)
    // Rollback preserved prior state.
    expect(JSON.parse(readRegister('m-d').active_block_ids_json)).toEqual(['b-d'])
    const afterTopics = sqlite.prepare('SELECT count(*) as c FROM topics').get() as { c: number }
    expect(afterTopics.c).toBe(beforeTopics.c)
    void candidate
  })

  it('losing register clock is consumed without change', () => {
    seedCompleteChain('t-l', 'm-l', 'b-l')
    seedRegister('m-l', T + 100, 'op-new', ['b-l'])
    seedBound('chan-l', '0')
    expect(() =>
      db.transaction((tx) => {
        mergeValidatedBaselineInTx(tx as any, {
          entities: [],
          tombstones: [],
          orderFrames: [],
          replacementRegisters: [
            { messageId: 'm-l', timestamp: T + 10, operationId: 'op-old', activeBlockIds: ['b-l'] }
          ]
        })
      })
    ).not.toThrow()
    const reg = readRegister('m-l')
    expect(reg.timestamp).toBe(T + 100)
    expect(reg.operation_id).toBe('op-new')
  })
})

describe('baseline v2 publish/fetch/bootstrap N+1', () => {
  it('publish builds v2, fetch accepts v1/v2, bootstrap commits N then pulls N+1', async () => {
    seedCompleteChain('t-p', 'm-p', 'b-p')
    seedRegister('m-p', T + 20, 'op-rep-p', ['b-p'])
    seedBound('chan-p', '5')
    db.insert(schema.syncState)
      .values({ key: 'cursor', value: '5' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: '5' } })
      .run()
    const candidate = captureLocalSyncBaselineCandidate(db)
    const proof = assertBarrierSnapshotProof(candidate, 'chan-p', 5)
    const { envelope, digest } = buildPublishEnvelope(candidate, 'chan-p', proof.watermarkN)
    expect(envelope.wireVersion).toBe(WIRE_VERSION_V2)
    expect(envelope.payload.replacementRegisters.map((r) => r.messageId)).toContain('m-p')
    expect(envelope.digest).toBe(digest)
    expect(() => validateEnvelope(envelope)).not.toThrow()
    // Fetch accepts v1 and v2 raw text.
    const v1PayloadForFetch = {
      payloadSchema: 'chat-core-baseline-v1',
      inventoryVersion: 'topic-message-stable-block-order-v1',
      orderFrameVersion: 'parent-order-frame-v1',
      scope: 'chat-core-baseline-v1:topic-message-stable-block-order-v1',
      topics: [],
      messages: [],
      messageBlocks: [],
      tombstones: [],
      orderFrames: [],
      manifest: {
        payloadSchema: 'chat-core-baseline-v1',
        inventoryVersion: 'topic-message-stable-block-order-v1',
        orderFrameVersion: 'parent-order-frame-v1',
        scope: 'chat-core-baseline-v1:topic-message-stable-block-order-v1',
        liveCounts: { topic: 0, message: 0, messageBlock: 0 },
        tombstoneCounts: { topic: 0, message: 0, messageBlock: 0 },
        frameCounts: { topicMessage: 0, messageBlock: 0 },
        completeness: 'complete'
      }
    } as never
    const v1Raw = JSON.stringify({
      wireVersion: 'sync-baseline-wire-v1',
      channelId: 'chan-p',
      watermark: 5,
      digestScheme: 'jcs-sha256-v1',
      digest: computeSyncDigest(v1PayloadForFetch, hashHex),
      payload: {
        payloadSchema: 'chat-core-baseline-v1',
        inventoryVersion: 'topic-message-stable-block-order-v1',
        orderFrameVersion: 'parent-order-frame-v1',
        scope: 'chat-core-baseline-v1:topic-message-stable-block-order-v1',
        topics: [],
        messages: [],
        messageBlocks: [],
        tombstones: [],
        orderFrames: [],
        manifest: {
          payloadSchema: 'chat-core-baseline-v1',
          inventoryVersion: 'topic-message-stable-block-order-v1',
          orderFrameVersion: 'parent-order-frame-v1',
          scope: 'chat-core-baseline-v1:topic-message-stable-block-order-v1',
          liveCounts: { topic: 0, message: 0, messageBlock: 0 },
          tombstoneCounts: { topic: 0, message: 0, messageBlock: 0 },
          frameCounts: { topicMessage: 0, messageBlock: 0 },
          completeness: 'complete'
        }
      }
    })
    const { parseEnvelopeJson } = await import('@shared/sync')
    expect(() => parseEnvelopeJson(v1Raw)).not.toThrow()
    expect(() => parseEnvelopeJson(JSON.stringify(envelope))).not.toThrow()
    // Bootstrap via sync(): cursor 0 device fetches v2, merges register, commits N, pulls N+1.
    // Reset to a fresh cursor-0 receiver holding the same chain shape minus register.
    sqlite.prepare('DELETE FROM sync_stable_replace_register WHERE message_id=?').run('m-p')
    db.insert(schema.syncState)
      .values({ key: 'cursor', value: '0' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: '0' } })
      .run()
    db.insert(schema.syncState)
      .values({ key: 'sync:channelKey', value: 'chan-p' })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: 'chan-p' } })
      .run()
    const fetchMock = vi.spyOn(syncClient, 'fetchBaseline').mockResolvedValue({
      found: true,
      envelope: envelope as never,
      rawText: JSON.stringify(envelope)
    })
    vi.spyOn(syncClient, 'push').mockResolvedValue({ cursor: 5, acceptedIds: [] })
    const pullOrder: number[] = []
    vi.spyOn(syncClient, 'pull').mockImplementation(async (_e, _t, cursor) => {
      pullOrder.push(cursor)
      expect(cursor).toBe(5)
      return { operations: [], cursor: 5 } as never
    })
    await syncService.sync()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const cursorRow = db.select().from(schema.syncState).where(eq(schema.syncState.key, 'cursor')).get()
    expect(cursorRow?.value).toBe('5')
    expect(pullOrder).toEqual([5])
    const reg = readRegister('m-p')
    expect(reg).toBeTruthy()
    expect(JSON.parse(reg.active_block_ids_json)).toEqual(['b-p'])
  })
})
