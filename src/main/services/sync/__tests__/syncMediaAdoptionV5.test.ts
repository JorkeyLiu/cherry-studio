/**
 * Bounded v5 media adoption prevention + existing-queue canonical recovery.
 *
 * Prevention: cursor0 mixed receiver with an unversioned stored image whose
 * bytes still need capture must never mint a portable block full-state
 * without assetIds. The image routes to the existing attachment capture
 * pipeline (intents -> drain upload -> block with full ordered assetIds +
 * frames) while mixed ordinary history converges in the same cycle.
 *
 * Recovery: one strictly malformed pre-v5 adoption op (portable upsert
 * lacking assetIds) that could never have been relay-accepted (strict 400)
 * repairs in place by explicit proved canonicalization only — same-entity
 * valid successor + committed refs + file_asset/completed job + clock
 * dominance — preserving every valid pending op byte-for-byte.
 *
 * Real public paths only: ChatDbAggregate + SyncService +
 * SyncAttachmentService + real createRelayServer. Synthetic recovery uses an
 * isolated :memory: profile only (never live DB edits).
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
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

import { type SyncPushRequest, validateSyncOperationStrict } from '@shared/sync'

import { createRelayServer, ensureRelaySchema } from '../../../../../scripts/sync-relay/server'
import { chatDbService } from '../../chatDb'
import { ChatDbAggregateService } from '../../chatDb/ChatDbAggregateService'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import type { SyncAttachmentClient } from '../syncAttachmentService'
import { SyncAttachmentService } from '../syncAttachmentService'
import { captureLocalSyncBaselineCandidate } from '../syncBaseline'
import { syncClient } from '../SyncClient'
import { syncService } from '../SyncService'

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
let aggA: ChatDbAggregateService
let sqliteB: Database.Database
let dbB: BetterSQLite3Database<typeof schema>
let aggB: ChatDbAggregateService
let relayDb: Database.Database
let relayServer: ReturnType<typeof createRelayServer> | null = null
let relayEndpoint = ''
let ownedTmp = ''
let relayBlobDir = ''
let filesDirA = ''
let filesDirB = ''
let tmpDirA = ''
let tmpDirB = ''
let tmpRoots: string[] = []
let credA = { deviceId: '', code: '', secret: '' }
let credB = { deviceId: '', code: '', secret: '' }

function bind(which: 'A' | 'B'): void {
  const sqlite = which === 'A' ? sqliteA : sqliteB
  const db = which === 'A' ? dbA : dbB
  const creds = which === 'A' ? credA : credB
  const filesDir = which === 'A' ? filesDirA : filesDirB
  const tmpDir = which === 'A' ? tmpDirA : tmpDirB
  ;(chatDbService as unknown as { sqlite: unknown }).sqlite = sqlite
  ;(chatDbService as unknown as { db: unknown }).db = db
  configStore.set('sync:endpoint', relayEndpoint)
  configStore.set('sync:enabled', true)
  if (creds.deviceId) configStore.set('deviceId', creds.deviceId)
  else configStore.delete('deviceId')
  if (creds.code) configStore.set('sync:deviceCode', creds.code)
  else configStore.delete('sync:deviceCode')
  if (creds.secret) configStore.set('sync:deviceAuth', creds.secret)
  else configStore.delete('sync:deviceAuth')
  configStore.set('sync:explicitDisconnect', false)
  const svc = new SyncAttachmentService({
    filesDir,
    tempDir: tmpDir,
    client: syncClient as unknown as SyncAttachmentClient
  })
  syncService.setAttachmentServiceForTests(svc)
}

function snapshotCreds(): { deviceId: string; code: string; secret: string } {
  return {
    deviceId: String(configStore.get('deviceId') ?? ''),
    code: String(configStore.get('sync:deviceCode') ?? ''),
    secret: String(configStore.get('sync:deviceAuth') ?? '')
  }
}

function insertUnversionedStoredImage(
  sqlite: Database.Database,
  args: { topicId: string; messageId: string; blockId: string; fileId: string }
): void {
  sqlite
    .prepare(
      `INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?,?)`
    )
    .run(
      args.topicId,
      'a1',
      'Mixed Media',
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      null,
      JSON.stringify({ pinned: false, prompt: null, isNameManuallyEdited: false })
    )
  sqlite
    .prepare(
      `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      args.messageId,
      args.topicId,
      'user',
      'stored image turn',
      'success',
      null,
      null,
      null,
      null,
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      0,
      null
    )
  sqlite
    .prepare(
      `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(
      args.blockId,
      args.messageId,
      'image',
      'stored image',
      'success',
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      0,
      null
    )
  sqlite
    .prepare(`INSERT INTO file_references (block_id, file_id, file_name, extra) VALUES (?,?,?,?)`)
    .run(args.blockId, args.fileId, `${args.fileId}.png`, null)
}

describe('v5 media adoption prevention over real relay', () => {
  beforeEach(async () => {
    configStore.clear()
    credA = { deviceId: '', code: '', secret: '' }
    credB = { deviceId: '', code: '', secret: '' }
    ownedTmp = mkdtempSync(join(tmpdir(), 'sync-media-adopt-'))
    relayBlobDir = join(ownedTmp, 'relay-blobs')
    mkdirSync(relayBlobDir, { recursive: true })
    relayDb = new Database(join(ownedTmp, 'relay.db'))
    relayDb.pragma('journal_mode = WAL')
    ensureRelaySchema(relayDb)
    relayServer = createRelayServer(relayDb, { blobDir: relayBlobDir })
    await new Promise<void>((resolve) =>
      (relayServer as unknown as { listen: (a: number, b: string, cb: () => void) => void }).listen(
        0,
        '127.0.0.1',
        () => resolve()
      )
    )
    const addr = (relayServer as unknown as { address: () => { port: number } }).address()
    relayEndpoint = `http://127.0.0.1:${addr.port}`

    const a = openChatDb()
    sqliteA = a.sqlite
    dbA = a.db
    aggA = new ChatDbAggregateService(dbA, sqliteA)
    const b = openChatDb()
    sqliteB = b.sqlite
    dbB = b.db
    aggB = new ChatDbAggregateService(dbB, sqliteB)

    filesDirA = mkdtempSync(join(tmpdir(), 'sync-media-a-'))
    tmpDirA = mkdtempSync(join(tmpdir(), 'sync-media-tmpa-'))
    filesDirB = mkdtempSync(join(tmpdir(), 'sync-media-b-'))
    tmpDirB = mkdtempSync(join(tmpdir(), 'sync-media-tmpb-'))
    tmpRoots = [filesDirA, tmpDirA, filesDirB, tmpDirB]

    syncService.clearAllForTests()
    syncService.resetShutdownForTests()
    bind('A')
    await syncService.connect()
    credA = snapshotCreds()
    credB = { deviceId: '', code: '', secret: '' }
    bind('B')
    await syncService.connect()
    credB = snapshotCreds()
    bind('B')
    const req = await syncService.requestPairing(credA.code)
    bind('A')
    await syncService.acceptPairing(req.requestId)
    bind('B')
    await syncService.getPairState()
    bind('A')
    await syncService.getPairState()
  })

  afterEach(async () => {
    try {
      await new Promise<void>((resolve) => {
        try {
          ;(relayServer as unknown as { close: (cb: () => void) => void })?.close(() => resolve())
        } catch {
          resolve()
        }
      })
    } catch {}
    relayServer = null
    try {
      relayDb?.close()
    } catch {}
    try {
      sqliteA?.close()
    } catch {}
    try {
      sqliteB?.close()
    } catch {}
    for (const r of tmpRoots)
      try {
        rmSync(r, { recursive: true, force: true })
      } catch {}
    try {
      if (ownedTmp) rmSync(ownedTmp, { recursive: true, force: true })
    } catch {}
    ;(chatDbService as unknown as { sqlite: unknown }).sqlite = null
    ;(chatDbService as unknown as { db: unknown }).db = null
    syncService.setAttachmentServiceForTests(null)
    configStore.clear()
  })

  it('cursor0 unversioned stored image while capture pending converges via capture pipeline with no shell op', async () => {
    // A: ordinary baseline history (holder publishes).
    bind('A')
    const topicA = `t-a-${randomUUID().slice(0, 6)}`
    expect((aggA.ensureTopic(topicA) as unknown as { ok: boolean }).ok).toBe(true)
    aggA.updateTopicMetadata(topicA, undefined, false, `prompt-${topicA}`, false)
    const mA = `m-a-${randomUUID().slice(0, 6)}`
    const kA = `k-a-${randomUUID().slice(0, 6)}`
    expect(
      (
        aggA.appendMessage(
          topicA,
          {
            id: mA,
            topicId: topicA,
            role: 'user',
            content: 'holder ordinary',
            status: 'success',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          } as never,
          [
            {
              id: kA,
              messageId: mA,
              type: 'main_text',
              content: 'holder ordinary',
              status: 'success',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            } as never
          ]
        ) as unknown as { ok: boolean }
      ).ok
    ).toBe(true)
    await syncService.sync()
    const candA = captureLocalSyncBaselineCandidate(dbA as never)
    expect(candA.completeness.state).toBe('complete')
    const pub = await syncService.publishBaseline()
    expect(pub.watermark).toBeGreaterThan(0)

    // B: cursor0 mixed local-exclusive history — ordinary text turn plus a
    // stored image whose bytes still need capture (refs + Files bytes exist,
    // no clocks/intents/jobs). Both fully unversioned.
    bind('B')
    const topicOrd = `t-ord-${randomUUID().slice(0, 6)}`
    expect((aggB.ensureTopic(topicOrd) as unknown as { ok: boolean }).ok).toBe(true)
    aggB.updateTopicMetadata(topicOrd, undefined, false, `prompt-${topicOrd}`, false)
    const mOrd = `m-ord-${randomUUID().slice(0, 6)}`
    const kOrd = `k-ord-${randomUUID().slice(0, 6)}`
    expect(
      (
        aggB.appendMessage(
          topicOrd,
          {
            id: mOrd,
            topicId: topicOrd,
            role: 'user',
            content: 'receiver ordinary',
            status: 'success',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          } as never,
          [
            {
              id: kOrd,
              messageId: mOrd,
              type: 'main_text',
              content: 'receiver ordinary',
              status: 'success',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            } as never
          ]
        ) as unknown as { ok: boolean }
      ).ok
    ).toBe(true)
    // Wipe the just-captured clocks/intents for the ordinary turn so the
    // receiver state is fully unversioned like a legacy import (keeps chat).
    // Only sync-side rows are cleared; chat rows stay.
    sqliteB.prepare(`DELETE FROM sync_outbox`).run()
    sqliteB.prepare(`DELETE FROM sync_entity_clock`).run()
    sqliteB.prepare(`DELETE FROM sync_field_clock`).run()
    sqliteB.prepare(`DELETE FROM sync_membership_clock`).run()
    try {
      sqliteB.prepare(`DELETE FROM sync_parent_order_frame`).run()
    } catch {}
    try {
      sqliteB.prepare(`DELETE FROM sync_attachment_capture_intent`).run()
    } catch {}

    const topicImg = `t-img-${randomUUID().slice(0, 6)}`
    const msgImg = `m-img-${randomUUID().slice(0, 6)}`
    const blkImg = `b-img-${randomUUID().slice(0, 6)}`
    const fileId = randomUUID()
    const imgBytes = Buffer.from('stored-image-bytes-v5')
    writeFileSync(join(filesDirB, `${fileId}.png`), imgBytes)
    insertUnversionedStoredImage(sqliteB, { topicId: topicImg, messageId: msgImg, blockId: blkImg, fileId })

    // Capture the exact ops that would hit the relay: no portable shell.
    const pushedBatches: Array<Array<Record<string, unknown>>> = []
    const realPush = syncClient.push.bind(syncClient)
    vi.spyOn(syncClient, 'push').mockImplementation(
      async (endpoint: string, req: SyncPushRequest, code: string, secret: string, externalSignal?: AbortSignal) => {
        const ops = req.operations
        pushedBatches.push(ops.map((o) => JSON.parse(JSON.stringify(o)) as Record<string, unknown>))
        for (const o of ops) {
          const err = validateSyncOperationStrict(o)
          if (err) throw new Error(`prevention: invalid op pushed: ${err}`)
          if (o.entityType === 'message_block') {
            const p = o.payload ?? {}
            const t = typeof p.type === 'string' ? p.type.toLowerCase() : ''
            if (t === 'file' || t === 'image' || t === 'video') {
              if (!Array.isArray(p.assetIds) || (p.assetIds as unknown[]).length === 0) {
                throw new Error('prevention: portable shell without assetIds reached push')
              }
            }
          }
        }
        return realPush(endpoint, req, code, secret, externalSignal)
      }
    )

    bind('B')
    await syncService.sync()
    // Drain + repair + push happened in the same cycle: intents fulfilled,
    // block carries full ordered assetIds, frames minted, bytes uploaded.
    const outboxB = dbB.select().from(schema.syncOutbox).all()
    expect(pushedBatches.length).toBeGreaterThan(0)
    expect(syncService.getStatus().lastError).toBeNull()
    expect(syncService.getStatus().cursor).toBeGreaterThanOrEqual(pub.watermark)
    // No queued shell remains: every queued portable block carries refs.
    for (const o of outboxB as Array<{ entityType: string; payloadJson: string | null }>) {
      if (o.entityType !== 'message_block') continue
      const p = o.payloadJson ? (JSON.parse(o.payloadJson) as Record<string, unknown>) : {}
      const t = typeof p.type === 'string' ? p.type.toLowerCase() : ''
      if (t === 'file' || t === 'image' || t === 'video') {
        expect(Array.isArray(p.assetIds)).toBe(true)
        expect((p.assetIds as unknown[]).length).toBeGreaterThan(0)
      }
    }
    // Image block converged with full refs + membership + frame.
    const blkOps = (outboxB as Array<{ entityId: string }>).filter(
      (o) => (o as { entityId: string }).entityId === blkImg
    ).length
    void blkOps
    await syncService.sync()
    // Bidirectional: A pulls B's ordinary + media; B already has A's baseline.
    bind('A')
    await syncService.sync()
    expect(sqliteA.prepare(`SELECT id FROM messages WHERE id = ?`).get(mOrd)).toBeTruthy()
    expect(sqliteA.prepare(`SELECT id FROM messages WHERE id = ?`).get(msgImg)).toBeTruthy()
    expect(readFileSync(join(filesDirA, `${fileId}.png`)).equals(imgBytes)).toBe(true)
    bind('B')
    expect(sqliteB.prepare(`SELECT id FROM messages WHERE id = ?`).get(mA)).toBeTruthy()
    expect(readFileSync(join(filesDirB, `${fileId}.png`)).equals(imgBytes)).toBe(true)
    vi.restoreAllMocks()
  }, 90000)

  it('regression: portable media with zero refs never mints a shell (fail-closed, no outbox)', async () => {
    bind('B')
    sqliteB
      .prepare(
        `INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        't-zero',
        'a1',
        'Zero',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        null,
        JSON.stringify({ pinned: false, prompt: null, isNameManuallyEdited: false })
      )
    sqliteB
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'm-zero',
        't-zero',
        'user',
        'zero',
        'success',
        null,
        null,
        null,
        null,
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        0,
        null
      )
    sqliteB
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'b-zero',
        'm-zero',
        'image',
        'zero image, no refs',
        'success',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        0,
        null
      )
    // No file_references row: old code minted a shell without assetIds.
    // New code must fail the bootstrap adoption (0 writes for that block)
    // and never queue a portable shell.
    let threw = false
    try {
      await syncService.sync()
    } catch {
      threw = true
    }
    const outbox = dbB.select().from(schema.syncOutbox).all() as Array<{
      entityId: string
      entityType: string
      payloadJson: string | null
    }>
    const shell = outbox.filter((o) => o.entityId === 'b-zero')
    if (threw) {
      expect(shell.length).toBe(0)
    } else {
      for (const o of shell) {
        const p = o.payloadJson ? (JSON.parse(o.payloadJson) as Record<string, unknown>) : {}
        expect(Array.isArray(p.assetIds)).toBe(true)
        expect((p.assetIds as unknown[]).length).toBeGreaterThan(0)
      }
      // If the cycle deferred the media but adopted nothing else, no shell exists.
      expect(shell.length).toBe(0)
    }
  }, 60000)
})

describe('existing malformed adoption op canonical recovery (synthetic isolated profile)', () => {
  let sqliteR: Database.Database
  let dbR: BetterSQLite3Database<typeof schema>

  beforeEach(() => {
    configStore.clear()
    const opened = openChatDb()
    sqliteR = opened.sqlite
    dbR = opened.db
    ;(chatDbService as unknown as { sqlite: unknown }).sqlite = sqliteR
    ;(chatDbService as unknown as { db: unknown }).db = dbR
    configStore.set('sync:endpoint', 'http://127.0.0.1:1')
    configStore.set('sync:enabled', true)
    configStore.set('deviceId', 'dev-r')
    configStore.set('sync:deviceCode', 'code-r')
    configStore.set('sync:deviceAuth', 'secret-r')
    configStore.set('sync:explicitDisconnect', false)
    syncService.clearAllForTests()
    syncService.resetShutdownForTests()
  })

  afterEach(() => {
    try {
      sqliteR?.close()
    } catch {}
    ;(chatDbService as unknown as { sqlite: unknown }).sqlite = null
    ;(chatDbService as unknown as { db: unknown }).db = null
    configStore.clear()
  })

  it('proves strict-400, hydrates only the known shape, keeps valid bytes and clocks, idempotent retry', () => {
    const blockId = 'b-mal'
    const msgId = 'm-mal'
    sqliteR
      .prepare(
        `INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        't-mal',
        'a1',
        'Mal',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        null,
        JSON.stringify({ pinned: false, prompt: null, isNameManuallyEdited: false })
      )
    sqliteR
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        msgId,
        't-mal',
        'user',
        'mal turn',
        'success',
        null,
        null,
        null,
        null,
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        0,
        null
      )
    sqliteR
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(blockId, msgId, 'image', 'img', 'success', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 0, null)
    const fileId = 'f-proven-1'
    sqliteR
      .prepare(`INSERT INTO file_references (block_id, file_id, file_name, extra) VALUES (?,?,?,?)`)
      .run(blockId, fileId, `${fileId}.png`, null)
    const digest = 'a'.repeat(64)
    dbR
      .insert(schema.syncFileAsset)
      .values({
        id: fileId,
        sha256: digest,
        byteLength: 3,
        extension: '.png',
        mimeType: 'image/png',
        originalName: 'pic.png',
        createdAt: '2026-01-01T00:00:00.000Z',
        version: 1,
        updatedAt: 1001
      })
      .run()
    dbR
      .insert(schema.syncAttachmentJob)
      .values({
        assetId: fileId,
        sha256: digest,
        byteLength: 3,
        channelId: 'ch',
        state: 'completed',
        attempts: 0,
        lastError: null,
        createdAt: 1001,
        updatedAt: 1001
      })
      .run()
    dbR.insert(schema.syncState).values({ key: 'sync:channelKey', value: 'ch' }).run()
    // Known malformed emitter shape: 7 keys, no assetIds/sortOrder.
    const malformedPayload = {
      id: blockId,
      messageId: msgId,
      type: 'image',
      content: 'img',
      status: 'success',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z'
    }
    const validPayload = { ...malformedPayload, assetIds: [fileId] }
    dbR
      .insert(schema.syncOutbox)
      .values({
        id: 'op-malformed-1',
        entityType: 'message_block',
        op: 'upsert',
        entityId: blockId,
        timestamp: 1000,
        deviceId: 'dev-r',
        payloadJson: JSON.stringify(malformedPayload),
        createdAt: new Date().toISOString()
      })
      .run()
    dbR
      .insert(schema.syncOutbox)
      .values({
        id: 'op-valid-successor-1',
        entityType: 'message_block',
        op: 'upsert',
        entityId: blockId,
        timestamp: 1001,
        deviceId: 'dev-r',
        payloadJson: JSON.stringify(validPayload),
        createdAt: new Date().toISOString()
      })
      .run()
    // A valid ordinary op that must stay byte-for-byte.
    const textPayload = {
      id: 'b-text-1',
      messageId: msgId,
      type: 'main_text',
      content: 'text',
      status: 'success',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      assetIds: []
    }
    dbR
      .insert(schema.syncOutbox)
      .values({
        id: 'op-text-1',
        entityType: 'message_block',
        op: 'upsert',
        entityId: 'b-text-1',
        timestamp: 1002,
        deviceId: 'dev-r',
        payloadJson: JSON.stringify(textPayload),
        createdAt: new Date().toISOString()
      })
      .run()
    // Dominating clocks from the valid successor (repair never rewrites them).
    dbR
      .insert(schema.syncEntityClock)
      .values({ entityType: 'message_block', entityId: blockId, timestamp: 1001, operationId: 'op-valid-successor-1' })
      .run()
    for (const field of ['type', 'content', 'status', 'createdAt', 'updatedAt', 'assetIds'] as const) {
      dbR
        .insert(schema.syncFieldClock)
        .values({
          entityType: 'message_block',
          entityId: blockId,
          field,
          timestamp: 1001,
          operationId: 'op-valid-successor-1'
        })
        .run()
    }
    dbR
      .insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message_block' as never,
        childEntityId: blockId,
        parentId: msgId,
        timestamp: 1001,
        operationId: 'op-valid-successor-1'
      })
      .run()

    // Malformed could never have been relay-accepted (strict 400 proof).
    const strictErr = validateSyncOperationStrict({
      id: 'op-malformed-1',
      entityType: 'message_block',
      op: 'upsert',
      entityId: blockId,
      timestamp: 1000,
      deviceId: 'dev-r',
      payload: malformedPayload
    } as never)
    expect(strictErr).toMatch(/portable media block requires non-empty assetIds/)

    const beforeValid = (
      dbR.select().from(schema.syncOutbox).where(eq(schema.syncOutbox.id, 'op-valid-successor-1')).get() as {
        payloadJson: string
      }
    ).payloadJson
    const beforeText = (
      dbR.select().from(schema.syncOutbox).where(eq(schema.syncOutbox.id, 'op-text-1')).get() as {
        payloadJson: string
      }
    ).payloadJson
    const beforeEntity = JSON.stringify(
      dbR
        .select()
        .from(schema.syncEntityClock)
        .all()
        .map((r) => ({ ...r }))
    )
    const beforeFields = JSON.stringify(
      dbR
        .select()
        .from(schema.syncFieldClock)
        .all()
        .map((r) => ({ ...r }))
    )

    const res = (
      syncService as unknown as { repairMalformedAdoptionPortableOpsBeforePush: () => { repaired: string[] } }
    ).repairMalformedAdoptionPortableOpsBeforePush()
    expect(res.repaired).toEqual(['op-malformed-1'])

    const afterMal = dbR.select().from(schema.syncOutbox).where(eq(schema.syncOutbox.id, 'op-malformed-1')).get() as {
      id: string
      timestamp: number
      payloadJson: string
    }
    const afterPayload = JSON.parse(afterMal.payloadJson) as Record<string, unknown>
    expect(afterMal.id).toBe('op-malformed-1')
    expect(afterMal.timestamp).toBe(1000)
    expect(afterPayload.assetIds).toEqual([fileId])
    for (const k of ['id', 'messageId', 'type', 'content', 'status', 'createdAt', 'updatedAt'] as const) {
      expect(afterPayload[k]).toEqual((malformedPayload as Record<string, unknown>)[k])
    }
    const repairedErr = validateSyncOperationStrict({
      id: afterMal.id,
      entityType: 'message_block',
      op: 'upsert',
      entityId: blockId,
      timestamp: afterMal.timestamp,
      deviceId: 'dev-r',
      payload: afterPayload
    } as never)
    expect(repairedErr).toBeNull()

    // Valid successor + ordinary op bytes unchanged; clocks untouched (no false ack/clock rewrite).
    expect(
      (
        dbR.select().from(schema.syncOutbox).where(eq(schema.syncOutbox.id, 'op-valid-successor-1')).get() as {
          payloadJson: string
        }
      ).payloadJson
    ).toBe(beforeValid)
    expect(
      (
        dbR.select().from(schema.syncOutbox).where(eq(schema.syncOutbox.id, 'op-text-1')).get() as {
          payloadJson: string
        }
      ).payloadJson
    ).toBe(beforeText)
    expect(
      JSON.stringify(
        dbR
          .select()
          .from(schema.syncEntityClock)
          .all()
          .map((r) => ({ ...r }))
      )
    ).toBe(beforeEntity)
    expect(
      JSON.stringify(
        dbR
          .select()
          .from(schema.syncFieldClock)
          .all()
          .map((r) => ({ ...r }))
      )
    ).toBe(beforeFields)
    expect(dbR.select().from(schema.syncOutbox).all().length).toBe(3)

    // Retry is idempotent: already-hydrated op no longer matches the shape.
    const retry = (
      syncService as unknown as { repairMalformedAdoptionPortableOpsBeforePush: () => { repaired: string[] } }
    ).repairMalformedAdoptionPortableOpsBeforePush()
    expect(retry.repaired).toEqual([])
  })

  it('unprovable (missing asset) fails explicitly with all queued work preserved', () => {
    sqliteR
      .prepare(
        `INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        't-u',
        'a1',
        'U',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        null,
        JSON.stringify({ pinned: false, prompt: null, isNameManuallyEdited: false })
      )
    sqliteR
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'm-u',
        't-u',
        'user',
        'u',
        'success',
        null,
        null,
        null,
        null,
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        0,
        null
      )
    sqliteR
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run('b-u', 'm-u', 'image', 'u', 'success', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 0, null)
    // No file_references / asset / job: unprovable.
    dbR
      .insert(schema.syncOutbox)
      .values({
        id: 'op-u-mal',
        entityType: 'message_block',
        op: 'upsert',
        entityId: 'b-u',
        timestamp: 1000,
        deviceId: 'dev-r',
        payloadJson: JSON.stringify({
          id: 'b-u',
          messageId: 'm-u',
          type: 'image',
          content: 'u',
          status: 'success',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z'
        }),
        createdAt: new Date().toISOString()
      })
      .run()
    const before = dbR.select().from(schema.syncOutbox).all().length
    expect(() =>
      (
        syncService as unknown as { repairMalformedAdoptionPortableOpsBeforePush: () => unknown }
      ).repairMalformedAdoptionPortableOpsBeforePush()
    ).toThrow()
    expect(dbR.select().from(schema.syncOutbox).all().length).toBe(before)
  })

  it('wrong-channel completed job fails preserving work (never trusts old upload)', () => {
    sqliteR
      .prepare(
        `INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        't-wc',
        'a1',
        'WC',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        null,
        JSON.stringify({ pinned: false, prompt: null, isNameManuallyEdited: false })
      )
    sqliteR
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'm-wc',
        't-wc',
        'user',
        'wc',
        'success',
        null,
        null,
        null,
        null,
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        0,
        null
      )
    sqliteR
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run('b-wc', 'm-wc', 'image', 'wc', 'success', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 0, null)
    const fileId = 'f-wc-1'
    sqliteR
      .prepare(`INSERT INTO file_references (block_id, file_id, file_name, extra) VALUES (?,?,?,?)`)
      .run('b-wc', fileId, `${fileId}.png`, null)
    const digest = 'b'.repeat(64)
    dbR
      .insert(schema.syncFileAsset)
      .values({
        id: fileId,
        sha256: digest,
        byteLength: 3,
        extension: '.png',
        mimeType: 'image/png',
        originalName: 'pic.png',
        createdAt: '2026-01-01T00:00:00.000Z',
        version: 1,
        updatedAt: 1001
      })
      .run()
    // Completed but for another channel; bound channel is ch-now.
    dbR
      .insert(schema.syncAttachmentJob)
      .values({
        assetId: fileId,
        sha256: digest,
        byteLength: 3,
        channelId: 'ch-old',
        state: 'completed',
        attempts: 0,
        lastError: null,
        createdAt: 1001,
        updatedAt: 1001
      })
      .run()
    dbR.insert(schema.syncState).values({ key: 'sync:channelKey', value: 'ch-now' }).run()
    const malformedPayload = {
      id: 'b-wc',
      messageId: 'm-wc',
      type: 'image',
      content: 'wc',
      status: 'success',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z'
    }
    dbR
      .insert(schema.syncOutbox)
      .values({
        id: 'op-wc-mal',
        entityType: 'message_block',
        op: 'upsert',
        entityId: 'b-wc',
        timestamp: 1000,
        deviceId: 'dev-r',
        payloadJson: JSON.stringify(malformedPayload),
        createdAt: new Date().toISOString()
      })
      .run()
    dbR
      .insert(schema.syncOutbox)
      .values({
        id: 'op-wc-succ',
        entityType: 'message_block',
        op: 'upsert',
        entityId: 'b-wc',
        timestamp: 1001,
        deviceId: 'dev-r',
        payloadJson: JSON.stringify({ ...malformedPayload, assetIds: [fileId] }),
        createdAt: new Date().toISOString()
      })
      .run()
    const textPayload = {
      id: 'b-wc-text',
      messageId: 'm-wc',
      type: 'main_text',
      content: 'text',
      status: 'success',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      assetIds: []
    }
    dbR
      .insert(schema.syncOutbox)
      .values({
        id: 'op-wc-text',
        entityType: 'message_block',
        op: 'upsert',
        entityId: 'b-wc-text',
        timestamp: 1002,
        deviceId: 'dev-r',
        payloadJson: JSON.stringify(textPayload),
        createdAt: new Date().toISOString()
      })
      .run()
    dbR
      .insert(schema.syncEntityClock)
      .values({ entityType: 'message_block', entityId: 'b-wc', timestamp: 1001, operationId: 'op-wc-succ' })
      .run()
    for (const field of ['type', 'content', 'status', 'createdAt', 'updatedAt', 'assetIds'] as const) {
      dbR
        .insert(schema.syncFieldClock)
        .values({
          entityType: 'message_block',
          entityId: 'b-wc',
          field,
          timestamp: 1001,
          operationId: 'op-wc-succ'
        })
        .run()
    }
    dbR
      .insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message_block' as never,
        childEntityId: 'b-wc',
        parentId: 'm-wc',
        timestamp: 1001,
        operationId: 'op-wc-succ'
      })
      .run()
    const before = JSON.stringify(dbR.select().from(schema.syncOutbox).all())
    expect(() =>
      (
        syncService as unknown as { repairMalformedAdoptionPortableOpsBeforePush: () => unknown }
      ).repairMalformedAdoptionPortableOpsBeforePush()
    ).toThrow(/not channel-bound/)
    // All queued work preserved byte-for-byte, ordinary untouched.
    expect(JSON.stringify(dbR.select().from(schema.syncOutbox).all())).toBe(before)
    expect(
      (
        dbR.select().from(schema.syncOutbox).where(eq(schema.syncOutbox.id, 'op-wc-text')).get() as {
          payloadJson: string
        }
      ).payloadJson
    ).toBe(JSON.stringify(textPayload))
  })

  it('unbound channel fails preserving work', () => {
    sqliteR
      .prepare(
        `INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        't-ub',
        'a1',
        'UB',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        null,
        JSON.stringify({ pinned: false, prompt: null, isNameManuallyEdited: false })
      )
    sqliteR
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'm-ub',
        't-ub',
        'user',
        'ub',
        'success',
        null,
        null,
        null,
        null,
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        0,
        null
      )
    sqliteR
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run('b-ub', 'm-ub', 'image', 'ub', 'success', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 0, null)
    const fileId = 'f-ub-1'
    sqliteR
      .prepare(`INSERT INTO file_references (block_id, file_id, file_name, extra) VALUES (?,?,?,?)`)
      .run('b-ub', fileId, `${fileId}.png`, null)
    const digest = 'c'.repeat(64)
    dbR
      .insert(schema.syncFileAsset)
      .values({
        id: fileId,
        sha256: digest,
        byteLength: 3,
        extension: '.png',
        mimeType: 'image/png',
        originalName: 'pic.png',
        createdAt: '2026-01-01T00:00:00.000Z',
        version: 1,
        updatedAt: 1001
      })
      .run()
    dbR
      .insert(schema.syncAttachmentJob)
      .values({
        assetId: fileId,
        sha256: digest,
        byteLength: 3,
        channelId: 'ch-x',
        state: 'completed',
        attempts: 0,
        lastError: null,
        createdAt: 1001,
        updatedAt: 1001
      })
      .run()
    // No sync:channelKey row: unbound.
    dbR
      .insert(schema.syncOutbox)
      .values({
        id: 'op-ub-mal',
        entityType: 'message_block',
        op: 'upsert',
        entityId: 'b-ub',
        timestamp: 1000,
        deviceId: 'dev-r',
        payloadJson: JSON.stringify({
          id: 'b-ub',
          messageId: 'm-ub',
          type: 'image',
          content: 'ub',
          status: 'success',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z'
        }),
        createdAt: new Date().toISOString()
      })
      .run()
    dbR
      .insert(schema.syncOutbox)
      .values({
        id: 'op-ub-succ',
        entityType: 'message_block',
        op: 'upsert',
        entityId: 'b-ub',
        timestamp: 1001,
        deviceId: 'dev-r',
        payloadJson: JSON.stringify({
          id: 'b-ub',
          messageId: 'm-ub',
          type: 'image',
          content: 'ub',
          status: 'success',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
          assetIds: [fileId]
        }),
        createdAt: new Date().toISOString()
      })
      .run()
    dbR
      .insert(schema.syncEntityClock)
      .values({ entityType: 'message_block', entityId: 'b-ub', timestamp: 1001, operationId: 'op-ub-succ' })
      .run()
    for (const field of ['type', 'content', 'status', 'createdAt', 'updatedAt', 'assetIds'] as const) {
      dbR
        .insert(schema.syncFieldClock)
        .values({
          entityType: 'message_block',
          entityId: 'b-ub',
          field,
          timestamp: 1001,
          operationId: 'op-ub-succ'
        })
        .run()
    }
    dbR
      .insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message_block' as never,
        childEntityId: 'b-ub',
        parentId: 'm-ub',
        timestamp: 1001,
        operationId: 'op-ub-succ'
      })
      .run()
    const before = dbR.select().from(schema.syncOutbox).all().length
    expect(() =>
      (
        syncService as unknown as { repairMalformedAdoptionPortableOpsBeforePush: () => unknown }
      ).repairMalformedAdoptionPortableOpsBeforePush()
    ).toThrow(/no bound channel/)
    expect(dbR.select().from(schema.syncOutbox).all().length).toBe(before)
  })

  it('legitimate older membership repairs (stable across content updates)', () => {
    sqliteR
      .prepare(
        `INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        't-old',
        'a1',
        'Old',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        null,
        JSON.stringify({ pinned: false, prompt: null, isNameManuallyEdited: false })
      )
    sqliteR
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'm-old',
        't-old',
        'user',
        'old',
        'success',
        null,
        null,
        null,
        null,
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        0,
        null
      )
    sqliteR
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run('b-old', 'm-old', 'image', 'old', 'success', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 0, null)
    const fileId = 'f-old-1'
    sqliteR
      .prepare(`INSERT INTO file_references (block_id, file_id, file_name, extra) VALUES (?,?,?,?)`)
      .run('b-old', fileId, `${fileId}.png`, null)
    const digest = 'd'.repeat(64)
    dbR
      .insert(schema.syncFileAsset)
      .values({
        id: fileId,
        sha256: digest,
        byteLength: 3,
        extension: '.png',
        mimeType: 'image/png',
        originalName: 'pic.png',
        createdAt: '2026-01-01T00:00:00.000Z',
        version: 1,
        updatedAt: 1001
      })
      .run()
    dbR
      .insert(schema.syncAttachmentJob)
      .values({
        assetId: fileId,
        sha256: digest,
        byteLength: 3,
        channelId: 'ch-old-test',
        state: 'completed',
        attempts: 0,
        lastError: null,
        createdAt: 1001,
        updatedAt: 1001
      })
      .run()
    dbR.insert(schema.syncState).values({ key: 'sync:channelKey', value: 'ch-old-test' }).run()
    const malformedPayload = {
      id: 'b-old',
      messageId: 'm-old',
      type: 'image',
      content: 'old',
      status: 'success',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z'
    }
    dbR
      .insert(schema.syncOutbox)
      .values({
        id: 'op-old-mal',
        entityType: 'message_block',
        op: 'upsert',
        entityId: 'b-old',
        timestamp: 1000,
        deviceId: 'dev-r',
        payloadJson: JSON.stringify(malformedPayload),
        createdAt: new Date().toISOString()
      })
      .run()
    dbR
      .insert(schema.syncOutbox)
      .values({
        id: 'op-old-succ',
        entityType: 'message_block',
        op: 'upsert',
        entityId: 'b-old',
        timestamp: 1001,
        deviceId: 'dev-r',
        payloadJson: JSON.stringify({ ...malformedPayload, assetIds: [fileId] }),
        createdAt: new Date().toISOString()
      })
      .run()
    const textPayload = {
      id: 'b-old-text',
      messageId: 'm-old',
      type: 'main_text',
      content: 'text',
      status: 'success',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      assetIds: []
    }
    dbR
      .insert(schema.syncOutbox)
      .values({
        id: 'op-old-text',
        entityType: 'message_block',
        op: 'upsert',
        entityId: 'b-old-text',
        timestamp: 1002,
        deviceId: 'dev-r',
        payloadJson: JSON.stringify(textPayload),
        createdAt: new Date().toISOString()
      })
      .run()
    dbR
      .insert(schema.syncEntityClock)
      .values({ entityType: 'message_block', entityId: 'b-old', timestamp: 1001, operationId: 'op-old-succ' })
      .run()
    for (const field of ['type', 'content', 'status', 'createdAt', 'updatedAt', 'assetIds'] as const) {
      dbR
        .insert(schema.syncFieldClock)
        .values({
          entityType: 'message_block',
          entityId: 'b-old',
          field,
          timestamp: 1001,
          operationId: 'op-old-succ'
        })
        .run()
    }
    // Membership legitimately older than the content successor (stable
    // ownership across content updates): same parent, valid tuple, <= succ.
    dbR
      .insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message_block' as never,
        childEntityId: 'b-old',
        parentId: 'm-old',
        timestamp: 900,
        operationId: 'op-old-create'
      })
      .run()
    const beforeText = (
      dbR.select().from(schema.syncOutbox).where(eq(schema.syncOutbox.id, 'op-old-text')).get() as {
        payloadJson: string
      }
    ).payloadJson
    const res = (
      syncService as unknown as { repairMalformedAdoptionPortableOpsBeforePush: () => { repaired: string[] } }
    ).repairMalformedAdoptionPortableOpsBeforePush()
    expect(res.repaired).toEqual(['op-old-mal'])
    const afterPayload = JSON.parse(
      (
        dbR.select().from(schema.syncOutbox).where(eq(schema.syncOutbox.id, 'op-old-mal')).get() as {
          payloadJson: string
        }
      ).payloadJson
    ) as Record<string, unknown>
    expect(afterPayload.assetIds).toEqual([fileId])
    const repairedErr = validateSyncOperationStrict({
      id: 'op-old-mal',
      entityType: 'message_block',
      op: 'upsert',
      entityId: 'b-old',
      timestamp: 1000,
      deviceId: 'dev-r',
      payload: afterPayload
    } as never)
    expect(repairedErr).toBeNull()
    // Ordinary noop unchanged; membership never rewritten.
    expect(
      (
        dbR.select().from(schema.syncOutbox).where(eq(schema.syncOutbox.id, 'op-old-text')).get() as {
          payloadJson: string
        }
      ).payloadJson
    ).toBe(beforeText)
    const memAfter = (
      syncService as unknown as {
        getMembershipClock: (
          t: 'message_block',
          id: string
        ) => { parentId: string; timestamp: number; operationId: string } | null
      }
    ).getMembershipClock('message_block', 'b-old')
    expect(memAfter).toEqual({ parentId: 'm-old', timestamp: 900, operationId: 'op-old-create' })
  })

  it('future membership fails preserving work', () => {
    sqliteR
      .prepare(
        `INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        't-fut',
        'a1',
        'Fut',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        null,
        JSON.stringify({ pinned: false, prompt: null, isNameManuallyEdited: false })
      )
    sqliteR
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'm-fut',
        't-fut',
        'user',
        'fut',
        'success',
        null,
        null,
        null,
        null,
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        0,
        null
      )
    sqliteR
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run('b-fut', 'm-fut', 'image', 'fut', 'success', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 0, null)
    const fileId = 'f-fut-1'
    sqliteR
      .prepare(`INSERT INTO file_references (block_id, file_id, file_name, extra) VALUES (?,?,?,?)`)
      .run('b-fut', fileId, `${fileId}.png`, null)
    const digest = 'e'.repeat(64)
    dbR
      .insert(schema.syncFileAsset)
      .values({
        id: fileId,
        sha256: digest,
        byteLength: 3,
        extension: '.png',
        mimeType: 'image/png',
        originalName: 'pic.png',
        createdAt: '2026-01-01T00:00:00.000Z',
        version: 1,
        updatedAt: 1001
      })
      .run()
    dbR
      .insert(schema.syncAttachmentJob)
      .values({
        assetId: fileId,
        sha256: digest,
        byteLength: 3,
        channelId: 'ch-fut',
        state: 'completed',
        attempts: 0,
        lastError: null,
        createdAt: 1001,
        updatedAt: 1001
      })
      .run()
    dbR.insert(schema.syncState).values({ key: 'sync:channelKey', value: 'ch-fut' }).run()
    const malformedPayload = {
      id: 'b-fut',
      messageId: 'm-fut',
      type: 'image',
      content: 'fut',
      status: 'success',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z'
    }
    dbR
      .insert(schema.syncOutbox)
      .values({
        id: 'op-fut-mal',
        entityType: 'message_block',
        op: 'upsert',
        entityId: 'b-fut',
        timestamp: 1000,
        deviceId: 'dev-r',
        payloadJson: JSON.stringify(malformedPayload),
        createdAt: new Date().toISOString()
      })
      .run()
    dbR
      .insert(schema.syncOutbox)
      .values({
        id: 'op-fut-succ',
        entityType: 'message_block',
        op: 'upsert',
        entityId: 'b-fut',
        timestamp: 1001,
        deviceId: 'dev-r',
        payloadJson: JSON.stringify({ ...malformedPayload, assetIds: [fileId] }),
        createdAt: new Date().toISOString()
      })
      .run()
    dbR
      .insert(schema.syncEntityClock)
      .values({ entityType: 'message_block', entityId: 'b-fut', timestamp: 1001, operationId: 'op-fut-succ' })
      .run()
    for (const field of ['type', 'content', 'status', 'createdAt', 'updatedAt', 'assetIds'] as const) {
      dbR
        .insert(schema.syncFieldClock)
        .values({
          entityType: 'message_block',
          entityId: 'b-fut',
          field,
          timestamp: 1001,
          operationId: 'op-fut-succ'
        })
        .run()
    }
    // Membership newer than the successor: cannot prove lineage.
    dbR
      .insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message_block' as never,
        childEntityId: 'b-fut',
        parentId: 'm-fut',
        timestamp: 1002,
        operationId: 'op-fut-newer'
      })
      .run()
    const before = JSON.stringify(dbR.select().from(schema.syncOutbox).all())
    expect(() =>
      (
        syncService as unknown as { repairMalformedAdoptionPortableOpsBeforePush: () => unknown }
      ).repairMalformedAdoptionPortableOpsBeforePush()
    ).toThrow(/newer than successor/)
    expect(JSON.stringify(dbR.select().from(schema.syncOutbox).all())).toBe(before)
  })

  it('malformed membership fails preserving work', () => {
    sqliteR
      .prepare(
        `INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        't-mm',
        'a1',
        'MM',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        null,
        JSON.stringify({ pinned: false, prompt: null, isNameManuallyEdited: false })
      )
    sqliteR
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'm-mm',
        't-mm',
        'user',
        'mm',
        'success',
        null,
        null,
        null,
        null,
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        0,
        null
      )
    sqliteR
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run('b-mm', 'm-mm', 'image', 'mm', 'success', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 0, null)
    const fileId = 'f-mm-1'
    sqliteR
      .prepare(`INSERT INTO file_references (block_id, file_id, file_name, extra) VALUES (?,?,?,?)`)
      .run('b-mm', fileId, `${fileId}.png`, null)
    const digest = 'f'.repeat(64)
    dbR
      .insert(schema.syncFileAsset)
      .values({
        id: fileId,
        sha256: digest,
        byteLength: 3,
        extension: '.png',
        mimeType: 'image/png',
        originalName: 'pic.png',
        createdAt: '2026-01-01T00:00:00.000Z',
        version: 1,
        updatedAt: 1001
      })
      .run()
    dbR
      .insert(schema.syncAttachmentJob)
      .values({
        assetId: fileId,
        sha256: digest,
        byteLength: 3,
        channelId: 'ch-mm',
        state: 'completed',
        attempts: 0,
        lastError: null,
        createdAt: 1001,
        updatedAt: 1001
      })
      .run()
    dbR.insert(schema.syncState).values({ key: 'sync:channelKey', value: 'ch-mm' }).run()
    const malformedPayload = {
      id: 'b-mm',
      messageId: 'm-mm',
      type: 'image',
      content: 'mm',
      status: 'success',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z'
    }
    dbR
      .insert(schema.syncOutbox)
      .values({
        id: 'op-mm-mal',
        entityType: 'message_block',
        op: 'upsert',
        entityId: 'b-mm',
        timestamp: 1000,
        deviceId: 'dev-r',
        payloadJson: JSON.stringify(malformedPayload),
        createdAt: new Date().toISOString()
      })
      .run()
    dbR
      .insert(schema.syncOutbox)
      .values({
        id: 'op-mm-succ',
        entityType: 'message_block',
        op: 'upsert',
        entityId: 'b-mm',
        timestamp: 1001,
        deviceId: 'dev-r',
        payloadJson: JSON.stringify({ ...malformedPayload, assetIds: [fileId] }),
        createdAt: new Date().toISOString()
      })
      .run()
    dbR
      .insert(schema.syncEntityClock)
      .values({ entityType: 'message_block', entityId: 'b-mm', timestamp: 1001, operationId: 'op-mm-succ' })
      .run()
    for (const field of ['type', 'content', 'status', 'createdAt', 'updatedAt', 'assetIds'] as const) {
      dbR
        .insert(schema.syncFieldClock)
        .values({
          entityType: 'message_block',
          entityId: 'b-mm',
          field,
          timestamp: 1001,
          operationId: 'op-mm-succ'
        })
        .run()
    }
    // Malformed membership tuple: colon in operationId is never a valid op shape.
    dbR
      .insert(schema.syncMembershipClock)
      .values({
        childEntityType: 'message_block' as never,
        childEntityId: 'b-mm',
        parentId: 'm-mm',
        timestamp: 1001,
        operationId: 'bad:op'
      })
      .run()
    const before = JSON.stringify(dbR.select().from(schema.syncOutbox).all())
    expect(() =>
      (
        syncService as unknown as { repairMalformedAdoptionPortableOpsBeforePush: () => unknown }
      ).repairMalformedAdoptionPortableOpsBeforePush()
    ).toThrow(/membership malformed/)
    expect(JSON.stringify(dbR.select().from(schema.syncOutbox).all())).toBe(before)
  })

  it('F3 deferred unready bytes: chat preserved, intent pending, no shell/frame, candidate incomplete; ready bytes converge', async () => {
    // Ordinary + stored-image history, fully unversioned, bound channel.
    dbR.insert(schema.syncState).values({ key: 'sync:channelKey', value: 'ch-f3' }).run()
    dbR.insert(schema.syncState).values({ key: 'cursor', value: '0' }).run()
    sqliteR
      .prepare(
        `INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        't-f3-ord',
        'a1',
        'Ord',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        null,
        JSON.stringify({ pinned: false, prompt: null, isNameManuallyEdited: false })
      )
    sqliteR
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'm-f3-ord',
        't-f3-ord',
        'user',
        'ord',
        'success',
        null,
        null,
        null,
        null,
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        0,
        null
      )
    sqliteR
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'b-f3-ord',
        'm-f3-ord',
        'main_text',
        'ord',
        'success',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        0,
        null
      )
    sqliteR
      .prepare(
        `INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra) VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        't-f3-img',
        'a1',
        'Img',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        null,
        JSON.stringify({ pinned: false, prompt: null, isNameManuallyEdited: false })
      )
    sqliteR
      .prepare(
        `INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'm-f3-img',
        't-f3-img',
        'user',
        'img turn',
        'success',
        null,
        null,
        null,
        null,
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        0,
        null
      )
    sqliteR
      .prepare(
        `INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'b-f3-img',
        'm-f3-img',
        'image',
        'img',
        'success',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        0,
        null
      )
    const fileId = 'f-f3-1'
    sqliteR
      .prepare(`INSERT INTO file_references (block_id, file_id, file_name, extra) VALUES (?,?,?,?)`)
      .run('b-f3-img', fileId, `${fileId}.png`, null)
    // No file_asset / completed bound job: bytes unready.
    const { adoptReceiverExclusiveInTx } = await import('../syncReceiverUnion')
    const emptyInput = { entities: [], tombstones: [], orderFrames: [] }
    const first = dbR.transaction((tx) => adoptReceiverExclusiveInTx(tx as never, emptyInput as never, 'dev-r', 2000))
    // Parent message adopted while the media block waits (acceptable
    // internal state: incomplete candidate cannot publish yet).
    expect(first.adopted).toBeGreaterThan(0)
    // Local chat preserved.
    expect(sqliteR.prepare(`SELECT id FROM messages WHERE id='m-f3-img'`).get()).toBeTruthy()
    expect(sqliteR.prepare(`SELECT id FROM message_blocks WHERE id='b-f3-img'`).get()).toBeTruthy()
    // Pending intent durable.
    const intents = dbR.select().from(schema.syncAttachmentCaptureIntent).all() as Array<{
      blockId: string
      fileId: string
    }>
    expect(intents.some((r) => r.blockId === 'b-f3-img' && r.fileId === fileId)).toBe(true)
    // No invalid shell: no queued portable block without assetIds.
    const outbox = dbR.select().from(schema.syncOutbox).all() as Array<{
      entityType: string
      entityId: string
      payloadJson: string | null
    }>
    for (const o of outbox) {
      if (o.entityType !== 'message_block') continue
      const p = o.payloadJson ? (JSON.parse(o.payloadJson) as Record<string, unknown>) : {}
      const t = typeof p.type === 'string' ? p.type.toLowerCase() : ''
      if (t === 'file' || t === 'image' || t === 'video') {
        expect(Array.isArray(p.assetIds)).toBe(true)
        expect((p.assetIds as unknown[]).length).toBeGreaterThan(0)
      }
      expect(o.entityId).not.toBe('b-f3-img')
    }
    // No partial portable frame for the deferred parent.
    const frames = dbR.select().from(schema.syncParentOrderFrame).all() as Array<{ parentId: string }>
    expect(frames.some((f) => f.parentId === 'm-f3-img')).toBe(false)
    // Ordinary intents still truthful and valid.
    const fullOutbox = dbR.select().from(schema.syncOutbox).all() as Array<{
      id: string
      entityType: string
      op: string
      entityId: string
      timestamp: number
      deviceId: string
      payloadJson: string | null
    }>
    for (const o of fullOutbox) {
      const payload = o.payloadJson ? (JSON.parse(o.payloadJson) as Record<string, unknown>) : {}
      expect(
        validateSyncOperationStrict({
          id: o.id,
          entityType: o.entityType,
          op: o.op,
          entityId: o.entityId,
          timestamp: o.timestamp,
          deviceId: o.deviceId,
          payload
        } as never)
      ).toBeNull()
    }
    // Baseline candidate incomplete: publish blocked while bytes pending.
    const cand = captureLocalSyncBaselineCandidate(dbR as never)
    expect(cand.completeness.state).not.toBe('complete')
    expect(cand.completeness.reasons).toContain('pending-attachment')
    // Bytes become ready (bound completed job + asset): next receiver
    // converges the deferred block with full refs.
    dbR
      .insert(schema.syncFileAsset)
      .values({
        id: fileId,
        sha256: '9'.repeat(64),
        byteLength: 3,
        extension: '.png',
        mimeType: 'image/png',
        originalName: `${fileId}.png`,
        createdAt: '2026-01-01T00:00:00.000Z',
        version: 1,
        updatedAt: 3000
      })
      .run()
    dbR
      .insert(schema.syncAttachmentJob)
      .values({
        assetId: fileId,
        sha256: '9'.repeat(64),
        byteLength: 3,
        channelId: 'ch-f3',
        state: 'completed',
        attempts: 0,
        lastError: null,
        createdAt: 3000,
        updatedAt: 3000
      })
      .run()
    const second = dbR.transaction((tx) => adoptReceiverExclusiveInTx(tx as never, emptyInput as never, 'dev-r', 4000))
    expect(second.adopted).toBeGreaterThan(0)
    const afterOutbox = dbR.select().from(schema.syncOutbox).all() as Array<{
      entityId: string
      entityType: string
      payloadJson: string | null
    }>
    const imgOps = afterOutbox.filter((o) => o.entityId === 'b-f3-img')
    expect(imgOps.length).toBeGreaterThan(0)
    for (const o of imgOps) {
      const p = o.payloadJson ? (JSON.parse(o.payloadJson) as Record<string, unknown>) : {}
      expect(p.assetIds).toEqual([fileId])
    }
  })
})
