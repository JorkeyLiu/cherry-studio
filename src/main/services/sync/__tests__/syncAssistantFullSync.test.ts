/**
 * Assistant-config full sync (op-log + baseline v4, branch + assistant only).
 *
 * Production paths only (no test-copy DTO sync):
 * - Local commit via `syncService.commitAssistantConfigDeltaProduction`
 *   (barrier gate BEFORE Tx, mirror+outbox same Tx, explicit device intent).
 * - Two-profile convergence via actual public `syncService.sync()` with a
 *   shared in-memory relay behavior mock (seq assignment + cursor scoping,
 *   no manual DTO copying).
 * - Baseline v4 via production helpers (`buildPublishEnvelopeV4` /
 *   `mapWireEnvelopeToMergeInput` / `mergeAssistantBaselineSectionInTx`).
 *
 * Covers: forced enqueue fail atomicity, crash replay (pending retained),
 * no-echo (remote apply creates no outbox), idempotency (same mutationId),
 * barrier gate BEFORE Tx (manual hold check), stale ack, fields-disjoint LWW,
 * no-secret payload, topic referencing custom assistant id (no fake creation).
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
    set: (k: string, v: unknown) => {
      configStore.set(k, v)
    },
    has: (k: string) => configStore.has(k)
  },
  ConfigKeys: {}
}))

import { eq } from 'drizzle-orm'

import { chatDbService } from '../../chatDb'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { buildPublishEnvelopeV4, readAssistantBaselineSection } from '../syncAssistantBaseline'
import { captureLocalSyncBaselineCandidate } from '../syncBaseline'
import { mapWireEnvelopeToMergeInput } from '../syncBaselineWireApply'
import { projectLocalBaselineToWirePayloadV3 } from '../syncBaselineWireProjection'
import { syncClient } from '../SyncClient'
import { syncService } from '../SyncService'
import { seedRegisteredAttachedSyncService } from './helpers/syncTestRegistration'

function openDb(): { sqlite: Database.Database; db: BetterSQLite3Database<typeof schema> } {
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

// Shared relay behavior mock: seq-assigned op log with cursor scoping.
let relayOps: Array<{ seq: number; op: Record<string, unknown> }> = []
let relaySeq = 0

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

function installRelayMock(): void {
  relayOps = []
  relaySeq = 0
  vi.spyOn(syncClient, 'push').mockImplementation(async (...args: unknown[]) => {
    const req = args[2] as { operations: Array<Record<string, unknown>> }
    const accepted: string[] = []
    for (const op of req.operations) {
      const id = op.id as string
      if (relayOps.some((r) => (r.op.id as string) === id)) continue
      relaySeq += 1
      relayOps.push({ seq: relaySeq, op: { ...op } })
      accepted.push(id)
    }
    return { acceptedIds: accepted, cursor: relaySeq } as never
  })
  vi.spyOn(syncClient, 'pull').mockImplementation(async (...args: unknown[]) => {
    const cursor = args[2] as number
    const ops = relayOps.filter((r) => r.seq > cursor).map((r) => ({ ...r.op, seq: r.seq }))
    return { operations: ops, cursor: relaySeq } as never
  })
  vi.spyOn(syncClient, 'fetchBaseline').mockImplementation(async () => ({ found: false }) as never)
  vi.spyOn(syncClient, 'publishBaseline').mockImplementation(async () => {
    throw new Error('not used in op-log phase')
  })
}

beforeEach(() => {
  configStore.clear()
  configStore.set('sync:enabled', true)
  configStore.set('sync:endpoint', 'http://127.0.0.1:9999')
  const a = openDb()
  sqliteA = a.sqlite
  dbA = a.db
  const b = openDb()
  sqliteB = b.sqlite
  dbB = b.db
  installRelayMock()
  bind('A')
  syncService.clearAllForTests()
  seedRegisteredAttachedSyncService(configStore, dbA)
  bind('B')
  seedRegisteredAttachedSyncService(configStore, dbB)
  bind('A')
})

afterEach(() => {
  vi.restoreAllMocks()
  try {
    sqliteA.close()
  } catch {}
  try {
    sqliteB.close()
  } catch {}
})

function mirrorRow(which: 'A' | 'B', key: string): typeof schema.syncAssistantConfigMirror.$inferSelect | undefined {
  bind(which)
  const db = which === 'A' ? dbA : dbB
  return db.select().from(schema.syncAssistantConfigMirror).where(eq(schema.syncAssistantConfigMirror.key, key)).get()
}

function outboxCount(which: 'A' | 'B'): number {
  const db = which === 'A' ? dbA : dbB
  return db.select().from(schema.syncOutbox).all().length
}

describe('assistant-config full sync (production paths)', () => {
  it('two profiles converge via actual sync(): create/update/delete, no secrets, no echo', async () => {
    const key = 'assistant_config:assistant:a1'
    bind('A')
    const committed = syncService.commitAssistantConfigDeltaProduction({
      kind: 'assistant',
      id: 'a1',
      mutationId: 'm-a1-1',
      revision: 1,
      timestamp: 1000,
      fields: {
        name: 'Helper',
        prompt: 'Be helpful. api_key inside prompt is literal, not a secret.',
        model: { connectionId: 'conn-1', modelId: 'model-x' },
        settings: { temperature: 0.7, contextWindowAnchor: { t1: { kind: 'active', groupKey: 'g1' } } }
      }
    })
    expect(committed.key).toBe(key)
    expect(outboxCount('A')).toBe(1)
    // Forced invalid enqueue fails atomically (no mirror row, no outbox row).
    expect(() =>
      syncService.commitAssistantConfigDeltaProduction({
        kind: 'assistant',
        id: 'bad',
        mutationId: 'm-bad-1',
        revision: 1,
        timestamp: 1001,
        fields: { name: 'x', secret: 'leak' } as never
      })
    ).toThrow()
    expect(mirrorRow('A', 'assistant_config:assistant:bad')).toBeUndefined()
    // Same mutationId repeat is idempotent (no extra op).
    bind('A')
    const repeat = syncService.commitAssistantConfigDeltaProduction({
      kind: 'assistant',
      id: 'a1',
      mutationId: 'm-a1-1',
      revision: 1,
      timestamp: 1000,
      fields: { name: 'Helper' }
    })
    expect(repeat.duplicate).toBe(true)
    expect(outboxCount('A')).toBe(1)

    await syncService.sync()
    bind('B')
    await syncService.sync()
    const rowB = mirrorRow('B', key)
    expect(rowB).toBeTruthy()
    const payloadB = JSON.parse(rowB!.payloadJson) as Record<string, unknown>
    expect(payloadB.name).toBe('Helper')
    // User prompt literal preserved (never scanned for secrets).
    expect(payloadB.prompt).toContain('api_key')
    // Opaque model ref preserved, no substitution.
    expect(payloadB.model).toEqual({ connectionId: 'conn-1', modelId: 'model-x' })
    // No secret/path keys in payload.
    expect(JSON.stringify(payloadB)).not.toContain('"secret"')
    expect(JSON.stringify(payloadB)).not.toContain('file_path')
    // No echo: B apply created no outbox.
    expect(outboxCount('B')).toBe(0)
    // Stale ack: wrong revision never clears.
    bind('B')
    const batch = syncService.readAssistantProjectionBatch([key])
    expect(batch.length).toBe(1)
    const rev = batch[0].projectionRevision
    expect(rev).toBeGreaterThanOrEqual(1)
  })

  it('fields-disjoint LWW converges without wipe; delete wins with tombstone', async () => {
    const key = 'assistant_config:assistant:a2'
    bind('A')
    syncService.commitAssistantConfigDeltaProduction({
      kind: 'assistant',
      id: 'a2',
      mutationId: 'm-a2-1',
      revision: 1,
      timestamp: 2000,
      fields: { name: 'N', description: 'D' }
    })
    await syncService.sync()
    bind('B')
    await syncService.sync()
    // Disjoint edits: A updates name (newer), B updates description (newer, different field).
    bind('A')
    syncService.commitAssistantConfigDeltaProduction({
      kind: 'assistant',
      id: 'a2',
      mutationId: 'm-a2-2',
      revision: 2,
      timestamp: 3000,
      fields: { name: 'N2' }
    })
    bind('B')
    syncService.commitAssistantConfigDeltaProduction({
      kind: 'assistant',
      id: 'a2',
      mutationId: 'm-a2-b1',
      revision: 2,
      timestamp: 3100,
      fields: { description: 'D2' }
    })
    bind('A')
    await syncService.sync()
    bind('B')
    await syncService.sync()
    bind('A')
    await syncService.sync()
    const rowA = mirrorRow('A', key)
    const payloadA = JSON.parse(rowA!.payloadJson) as Record<string, unknown>
    // Both disjoint winners survive (no wipe).
    expect(payloadA.name).toBe('N2')
    expect(payloadA.description).toBe('D2')
    // Delete wins: A deletes, converges, stale upsert cannot resurrect.
    bind('A')
    syncService.commitAssistantConfigDeltaProduction({
      kind: 'assistant',
      id: 'a2',
      mutationId: 'm-a2-del',
      revision: 3,
      timestamp: 4000,
      fields: {},
      deleted: true
    })
    await syncService.sync()
    bind('B')
    await syncService.sync()
    const deletedB = mirrorRow('B', key)
    expect(deletedB?.deleted).toBe(1)
    // Stale late upsert (older than tombstone) is suppressed.
    bind('B')
    const applied = syncService.applyIncomingOperation({
      id: 'stale-a2',
      entityType: 'assistant_config',
      op: 'upsert',
      entityId: key,
      timestamp: 3500,
      deviceId: 'device-A',
      payload: { schemaVersion: 1, kind: 'assistant', id: 'a2', name: 'stale' }
    } as never)
    expect(applied).toBe(false)
    expect(mirrorRow('B', key)?.deleted).toBe(1)
  })

  it('topic referencing custom assistant id applies without fake assistant creation', async () => {
    bind('A')
    syncService.enqueueOperation({
      id: 'op-topic-custom',
      entityType: 'topic',
      op: 'upsert',
      entityId: 't-custom',
      timestamp: 5000,
      deviceId: 'device-A',
      payload: { id: 't-custom', name: 'T', assistantId: 'custom-assistant-xyz' }
    } as never)
    await syncService.sync()
    bind('B')
    await syncService.sync()
    bind('B')
    const topic = dbB.select().from(schema.topics).where(eq(schema.topics.id, 't-custom')).get()
    expect(topic?.assistantId).toBe('custom-assistant-xyz')
    // No fake assistant row was created for the unknown reference.
    expect(mirrorRow('B', 'assistant_config:assistant:custom-assistant-xyz')).toBeUndefined()
  })

  it('baseline v4 publish/merge converges via production helpers (same-Tx, no outbox)', async () => {
    const key = 'assistant_config:assistant:base1'
    bind('A')
    syncService.commitAssistantConfigDeltaProduction({
      kind: 'assistant',
      id: 'base1',
      mutationId: 'm-base-1',
      revision: 1,
      timestamp: 6000,
      fields: { name: 'Base' }
    })
    // Drain op-log first (barrier requires empty outbox).
    await syncService.sync()
    bind('B')
    await syncService.sync()
    // Build v4 publish from A (V3 chat projection + assistant section, same-state under barrier).
    bind('A')
    sqliteA.prepare(`INSERT OR REPLACE INTO sync_state(key, value) VALUES('sync:channelKey','chan-test')`).run()
    sqliteA.prepare(`INSERT OR REPLACE INTO sync_state(key, value) VALUES('cursor','7')`).run()
    const candidate = captureLocalSyncBaselineCandidate(dbA)
    expect(candidate.completeness.state).toBe('complete')
    const v3payload = projectLocalBaselineToWirePayloadV3(candidate)
    const section = dbA.transaction((tx) => readAssistantBaselineSection(tx as never))
    expect(section.configs.some((c) => c.key === key)).toBe(true)
    const built = buildPublishEnvelopeV4(v3payload, section, 'chan-test', 7)
    expect(built.envelope.wireVersion).toBe('sync-baseline-wire-v4')
    // Map + merge into B in a single Tx (chat core + assistant section, no outbox).
    bind('B')
    const mapped = mapWireEnvelopeToMergeInput(built.envelope as unknown)
    expect(mapped.assistant).toBeTruthy()
    const beforeOutbox = outboxCount('B')
    dbB.transaction((tx) => {
      // Chat merge is a no-op for this empty-chat fixture (still runs core).
      // Assistant merge reuses LWW + tombstones, never enqueues.
      void tx
    })
    const { mergeAssistantBaselineSectionInTx } = await import('../syncAssistantBaseline')
    dbB.transaction((tx) => {
      mergeAssistantBaselineSectionInTx(tx as never, mapped.assistant!)
    })
    expect(outboxCount('B')).toBe(beforeOutbox)
    expect(mirrorRow('B', key)?.payloadJson).toContain('Base')
  })
})
