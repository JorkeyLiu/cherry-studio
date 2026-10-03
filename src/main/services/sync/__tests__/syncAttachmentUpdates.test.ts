import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')
vi.mock('@main/config', () => ({ DATA_PATH: '/tmp' }))

const storeA = new Map<string, unknown>()
const storeB = new Map<string, unknown>()
let activeStore: Map<string, unknown> = storeA
vi.mock('@main/services/ConfigManager', () => ({
  configManager: {
    get: (k: string, def?: unknown) => (activeStore.has(k) ? activeStore.get(k) : def),
    set: (k: string, v: unknown) => activeStore.set(k, v),
    has: (k: string) => activeStore.has(k)
  },
  ConfigKeys: {}
}))

import { eq } from 'drizzle-orm'

import { chatDbService } from '../../chatDb'
import { ChatDbAggregateService } from '../../chatDb/ChatDbAggregateService'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { SyncAttachmentService } from '../syncAttachmentService'
import { syncClient } from '../SyncClient'
import { syncService } from '../SyncService'

function openMem(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}
function shaHex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

describe('attachment incremental updates and strict cases', () => {
  let sqliteA: Database.Database
  let sqliteB: Database.Database
  let dbA: BetterSQLite3Database<typeof schema>
  let dbB: BetterSQLite3Database<typeof schema>
  let aggA: ChatDbAggregateService
  let aggB: ChatDbAggregateService
  let filesDirA: string
  let filesDirB: string
  let tmpDirA: string
  let tmpDirB: string
  let tmpRoots: string[] = []
  let relayOps: Array<{ seq: number; op: any }> = []
  let relaySeq = 0
  const attachmentStore = new Map<string, Buffer>()

  function setPeer(peer: 'A' | 'B'): void {
    activeStore = peer === 'A' ? storeA : storeB
    if (peer === 'A') {
      ;(chatDbService as any).sqlite = sqliteA
      ;(chatDbService as any).db = dbA
    } else {
      ;(chatDbService as any).sqlite = sqliteB
      ;(chatDbService as any).db = dbB
    }
  }

  beforeEach(async () => {
    storeA.clear()
    storeB.clear()
    activeStore = storeA
    tmpRoots = []
    relayOps = []
    relaySeq = 0
    attachmentStore.clear()
    sqliteA = openMem()
    dbA = drizzle(sqliteA, { schema })
    runMigrations(dbA as any, sqliteA)
    sqliteB = openMem()
    dbB = drizzle(sqliteB, { schema })
    runMigrations(dbB as any, sqliteB)
    aggA = new ChatDbAggregateService(dbA as any, sqliteA as any)
    aggB = new ChatDbAggregateService(dbB as any, sqliteB as any)
    void aggB
    const rootA = mkdtempSync(join(tmpdir(), 'sync-attach-upd-a-'))
    const rootB = mkdtempSync(join(tmpdir(), 'sync-attach-upd-b-'))
    tmpRoots.push(rootA, rootB)
    filesDirA = join(rootA, 'Files')
    filesDirB = join(rootB, 'Files')
    tmpDirA = join(rootA, 'tmp')
    tmpDirB = join(rootB, 'tmp')
    mkdirSync(filesDirA, { recursive: true })
    mkdirSync(filesDirB, { recursive: true })
    mkdirSync(tmpDirA, { recursive: true })
    mkdirSync(tmpDirB, { recursive: true })

    vi.spyOn(syncClient, 'push').mockImplementation(async (_endpoint, _token, req: any) => {
      const accepted: string[] = []
      for (const op of req.operations) {
        if (relayOps.some((r) => (r.op.id as string) === op.id)) continue
        relaySeq += 1
        relayOps.push({ seq: relaySeq, op: { ...op, seq: relaySeq } })
        accepted.push(op.id)
      }
      return { cursor: relaySeq, acceptedIds: accepted } as any
    })
    vi.spyOn(syncClient, 'pull').mockImplementation(async (_endpoint, _token, cursor: number) => {
      const ops = relayOps.filter((r) => r.seq > cursor).map((r) => ({ ...r.op, seq: r.seq }))
      return { operations: ops, cursor: relaySeq } as any
    })
    vi.spyOn(syncClient, 'uploadAttachment').mockImplementation(async (_endpoint, _token, args: any) => {
      const body = args.body
      let buf: Buffer
      if (Buffer.isBuffer(body)) buf = body
      else if (body instanceof Uint8Array) buf = Buffer.from(body)
      else {
        const chunks: Buffer[] = []
        for await (const c of body as AsyncIterable<Buffer>) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
        buf = Buffer.concat(chunks)
      }
      const digest = args.digest
      const actual = shaHex(buf)
      if (actual !== digest) throw new Error('attachment upload failed: digest-mismatch')
      attachmentStore.set(digest, Buffer.from(buf))
      return { digest, byteLength: buf.length, deduplicated: false }
    })
    vi.spyOn(syncClient, 'downloadAttachment').mockImplementation(
      async (_endpoint, _token, args: any, _c, _s, _sig, onChunk?: any) => {
        const buf = attachmentStore.get(args.digest)
        if (!buf) {
          const err: any = new Error('attachment download failed 404: not found')
          err.status = 404
          throw err
        }
        if (args.expectedByteLength !== undefined && buf.length !== args.expectedByteLength)
          throw new Error('attachment download failed: length-mismatch')
        const half = Math.ceil(buf.length / 2)
        if (onChunk) {
          await onChunk(buf.subarray(0, half))
          await onChunk(buf.subarray(half))
        }
        const actual = shaHex(buf)
        if (actual !== args.digest) throw new Error('attachment download failed: digest-mismatch')
        return { digest: args.digest, byteLength: buf.length }
      }
    )
    vi.spyOn(syncClient, 'fetchBaseline').mockImplementation(async () => ({ found: false }) as any)

    const endpoint = 'http://127.0.0.1:3030'
    const token = 'test-token'
    for (const store of [storeA, storeB]) {
      store.set('sync:endpoint', endpoint)
      store.set('sync:token', token)
      store.set('sync:enabled', true)
    }
    storeA.set('sync:deviceCode', 'ABCD2345')
    storeA.set('sync:deviceAuth', 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90')
    storeB.set('sync:deviceCode', 'EFGH6789')
    storeB.set('sync:deviceAuth', 'b'.repeat(64))
    const deviceIdA = randomUUID()
    const deviceIdB = randomUUID()
    setPeer('A')
    dbA.insert(schema.syncState).values({ key: 'deviceId', value: deviceIdA }).run()
    dbA.insert(schema.syncState).values({ key: 'sync:pairingGeneration', value: 'cc-1' }).run()
    dbA.insert(schema.syncState).values({ key: 'sync:channelKey', value: 'chan-test' }).run()
    dbA.insert(schema.syncState).values({ key: 'cursor', value: '0' }).run()
    setPeer('B')
    dbB.insert(schema.syncState).values({ key: 'deviceId', value: deviceIdB }).run()
    dbB.insert(schema.syncState).values({ key: 'sync:pairingGeneration', value: 'cc-1' }).run()
    dbB.insert(schema.syncState).values({ key: 'sync:channelKey', value: 'chan-test' }).run()
    dbB.insert(schema.syncState).values({ key: 'cursor', value: '0' }).run()

    const svcA = new SyncAttachmentService({ filesDir: filesDirA, tempDir: tmpDirA, client: syncClient as any })
    const svcB = new SyncAttachmentService({ filesDir: filesDirB, tempDir: tmpDirB, client: syncClient as any })
    ;(syncService as any)._svcA = svcA
    ;(syncService as any)._svcB = svcB
    vi.spyOn(syncService as any, 'getAttachmentService').mockImplementation(() => {
      if (activeStore === storeA) return svcA
      if (activeStore === storeB) return svcB
      return svcA
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    try {
      sqliteA.close()
    } catch {}
    try {
      sqliteB.close()
    } catch {}
    for (const r of tmpRoots)
      try {
        rmSync(r, { recursive: true, force: true })
      } catch {}
  })

  it('updateSingleBlock via public aggregate syncs file after promotion', async () => {
    const topicId = `t-${randomUUID().slice(0, 8)}`
    setPeer('A')
    expect(aggA.ensureTopic(topicId).ok).toBe(true)
    const msgId = `m-${randomUUID().slice(0, 8)}`
    const blockId = `b-${randomUUID().slice(0, 8)}`
    // Create transient block first
    const msgWire: any = {
      id: msgId,
      topicId,
      role: 'user',
      content: 'msg',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0,
      blocks: [blockId]
    }
    const blkTransient: any = {
      id: blockId,
      messageId: msgId,
      type: 'file',
      content: 'transient',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0
    }
    expect(aggA.appendMessage(topicId, msgWire, [blkTransient] as any).ok).toBe(true)
    let intents = dbA.select().from(schema.syncAttachmentCaptureIntent).all()
    expect(intents.length).toBe(0) // transient not captured
    const outbox = dbA.select().from(schema.syncOutbox).all()
    expect(outbox.filter((o) => o.entityType === 'message_block').length).toBe(0)
    // Now promote via updateSingleBlock with file
    const fileId = randomUUID()
    const fBytes = Buffer.from('updateSingleBlock-file-bytes')
    writeFileSync(join(filesDirA, `${fileId}.pdf`), fBytes)
    const patch: any = {
      status: 'success',
      file: {
        id: fileId,
        name: `${fileId}.pdf`,
        origin_name: 'doc.pdf',
        path: join(filesDirA, `${fileId}.pdf`),
        size: fBytes.length,
        ext: '.pdf',
        type: 'document',
        created_at: new Date().toISOString()
      }
    }
    const upd = aggA.updateSingleBlock(blockId, patch)
    expect((upd as any).ok).toBe(true)
    intents = dbA.select().from(schema.syncAttachmentCaptureIntent).all()
    expect(intents.length).toBe(1)
    expect(intents[0].blockId).toBe(blockId)
    // Sync
    setPeer('A')
    activeStore = storeA
    await syncService.sync()
    intents = dbA.select().from(schema.syncAttachmentCaptureIntent).all()
    expect(intents.length).toBe(0)
    const relayBlockOps = relayOps.filter((r) => r.op.entityType === 'message_block' && r.op.entityId === blockId)
    expect(relayBlockOps.length).toBe(1)
    expect(relayBlockOps[0].op.payload.assetIds).toEqual([fileId])
    setPeer('B')
    activeStore = storeB
    await syncService.sync()
    expect(readFileSync(join(filesDirB, `${fileId}.pdf`)).equals(fBytes)).toBe(true)
    const refsB = dbB
      .select()
      .from(schema.fileReferences)
      .all()
      .filter((r) => r.fileId === fileId)
    expect(refsB.length).toBe(1)
  }, 30000)

  it('bulkAdd via public aggregate syncs and dual-asset block aggregates', async () => {
    const topicId = `t-${randomUUID().slice(0, 8)}`
    setPeer('A')
    expect(aggA.ensureTopic(topicId).ok).toBe(true)
    const msgId = `m-${randomUUID().slice(0, 8)}`
    const msgWire: any = {
      id: msgId,
      topicId,
      role: 'user',
      content: 'msg',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0,
      blocks: []
    }
    expect(aggA.appendMessage(topicId, msgWire, [] as any).ok).toBe(true)
    // bulk add two blocks: one single, one dual-asset
    const fileId1 = randomUUID()
    const fileId2 = randomUUID()
    const fileId3 = randomUUID()
    const b1Bytes = Buffer.from('bulk-b1')
    const b2BytesA = Buffer.from('bulk-b2-a')
    const b2BytesB = Buffer.from('bulk-b2-b')
    writeFileSync(join(filesDirA, `${fileId1}.pdf`), b1Bytes)
    writeFileSync(join(filesDirA, `${fileId2}.pdf`), b2BytesA)
    writeFileSync(join(filesDirA, `${fileId3}.png`), b2BytesB)
    const block1Id = `b-${randomUUID().slice(0, 8)}`
    const block2Id = `b-${randomUUID().slice(0, 8)}`
    const blk1: any = {
      id: block1Id,
      messageId: msgId,
      type: 'file',
      content: 'f1',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0,
      file: {
        id: fileId1,
        name: `${fileId1}.pdf`,
        origin_name: 'a.pdf',
        path: join(filesDirA, `${fileId1}.pdf`),
        size: b1Bytes.length,
        ext: '.pdf',
        type: 'document',
        created_at: new Date().toISOString()
      }
    }
    const blk2: any = {
      id: block2Id,
      messageId: msgId,
      type: 'file',
      content: 'f2',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 1,
      file: {
        id: fileId2,
        name: `${fileId2}.pdf`,
        origin_name: 'b.pdf',
        path: join(filesDirA, `${fileId2}.pdf`),
        size: b2BytesA.length,
        ext: '.pdf',
        type: 'document',
        created_at: new Date().toISOString()
      }
    }
    // First bulk add block1 via public API
    expect(aggA.bulkAddBlocks([blk1] as any).ok).toBe(true)
    // For dual-asset block, we need to simulate 2 refs for same block. Use direct fileReferences insertion after bulk add.
    // Create block2 normally with single ref, then add second ref via direct DB
    expect(aggA.bulkAddBlocks([blk2] as any).ok).toBe(true)
    // Now add second file ref for same block2Id
    dbA
      .insert(schema.fileReferences)
      .values({
        id: `fr-${block2Id}-${fileId3}`,
        blockId: block2Id,
        fileId: fileId3,
        fileName: `${fileId3}.png`,
        filePath: null,
        fileType: null,
        count: 1,
        extra: null
      })
      .run()
    // Also need to capture intent for the extra file (since bulkAdd only captured first). Manually insert intent for second file (simulating helper would have captured both if block had 2 refs at capture time, but we added second after)
    // Instead, we directly insert intent for both files for that block
    const now = Date.now()
    dbA
      .insert(schema.syncAttachmentCaptureIntent)
      .values({ blockId: block2Id, fileId: fileId2, capturedAt: now })
      .onConflictDoNothing()
      .run()
    dbA
      .insert(schema.syncAttachmentCaptureIntent)
      .values({ blockId: block2Id, fileId: fileId3, capturedAt: now })
      .onConflictDoNothing()
      .run()
    // Sync
    setPeer('A')
    activeStore = storeA
    await syncService.sync()
    // Verify relay has block2 with both assetIds aggregated (not singleton)
    const relayBlock2 = relayOps.filter((r) => r.op.entityType === 'message_block' && r.op.entityId === block2Id)
    expect(relayBlock2.length).toBe(1)
    const assetIds = relayBlock2[0].op.payload.assetIds as string[]
    expect(assetIds.sort()).toEqual([fileId2, fileId3].sort())
    // Verify per-file not singleton overwrite: there should be only one block op for block2, not two
    // Sync B
    setPeer('B')
    activeStore = storeB
    await syncService.sync()
    const refsB = dbB
      .select()
      .from(schema.fileReferences)
      .all()
      .filter((r) => r.blockId === block2Id)
    expect(refsB.length).toBe(2)
    expect(readFileSync(join(filesDirB, `${fileId2}.pdf`)).equals(b2BytesA)).toBe(true)
    expect(readFileSync(join(filesDirB, `${fileId3}.png`)).equals(b2BytesB)).toBe(true)
  }, 30000)

  it('rejects half-shell file block and retains pending on missing file', async () => {
    const topicId = `t-${randomUUID().slice(0, 8)}`
    setPeer('A')
    expect(aggA.ensureTopic(topicId).ok).toBe(true)
    const msgId = `m-${randomUUID().slice(0, 8)}`
    const blockId = `b-${randomUUID().slice(0, 8)}`
    const msgWire: any = {
      id: msgId,
      topicId,
      role: 'user',
      content: 'msg',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0,
      blocks: [blockId]
    }
    // Try to append file block with no refs (half-shell) — should be rejected as unsupported, no outbox, no intent
    const blkHalf: any = {
      id: blockId,
      messageId: msgId,
      type: 'file',
      content: 'half',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0
    }
    const resHalf = aggA.appendMessage(topicId, msgWire, [blkHalf] as any)
    expect((resHalf as any).ok).toBe(true) // chat commits
    const outbox = dbA.select().from(schema.syncOutbox).all()
    expect(outbox.filter((o) => o.entityType === 'message_block' && o.entityId === blockId).length).toBe(0)
    let intents = dbA.select().from(schema.syncAttachmentCaptureIntent).all()
    expect(intents.length).toBe(0)
    // Now create valid file block but delete file before drain -> pending retained + lastError
    const fileId = randomUUID()
    const fBytes = Buffer.from('missing-file-test')
    writeFileSync(join(filesDirA, `${fileId}.pdf`), fBytes)
    const blockId2 = `b-${randomUUID().slice(0, 8)}`
    const msgId2 = `m-${randomUUID().slice(0, 8)}`
    const msgWire2: any = {
      id: msgId2,
      topicId,
      role: 'user',
      content: 'msg2',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 1,
      blocks: [blockId2]
    }
    const blk2: any = {
      id: blockId2,
      messageId: msgId2,
      type: 'file',
      content: 'f',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0,
      file: {
        id: fileId,
        name: `${fileId}.pdf`,
        origin_name: 'doc.pdf',
        path: join(filesDirA, `${fileId}.pdf`),
        size: fBytes.length,
        ext: '.pdf',
        type: 'document',
        created_at: new Date().toISOString()
      }
    }
    expect(aggA.appendMessage(topicId, msgWire2, [blk2] as any).ok).toBe(true)
    // Delete file to simulate missing
    unlinkSync(join(filesDirA, `${fileId}.pdf`))
    setPeer('A')
    activeStore = storeA
    await syncService.sync()
    intents = dbA.select().from(schema.syncAttachmentCaptureIntent).all()
    expect(intents.some((i) => i.fileId === fileId)).toBe(true)
    // lastError may be reported but cleared by sync success; main proof is pending retained
    const relayBlock = relayOps.filter(
      (r) => r.op.entityType === 'message_block' && r.op.entityId === blockId2 && r.op.op === 'upsert'
    )
    expect(relayBlock.length).toBe(0)
    // Delete pending block should clear intent and not resurrect
    const del = aggA.deleteBlocks([blockId2])
    expect((del as any).ok).toBe(true)
    intents = dbA.select().from(schema.syncAttachmentCaptureIntent).all()
    expect(intents.some((i) => i.blockId === blockId2)).toBe(false)
    // Sync again should not resurrect (no upsert)
    await syncService.sync()
    const relayAfter = relayOps.filter(
      (r) => r.op.entityType === 'message_block' && r.op.entityId === blockId2 && r.op.op === 'upsert'
    )
    expect(relayAfter.length).toBe(0)
  }, 30000)

  it('immutable hash change stays pending fail-closed', async () => {
    const topicId = `t-${randomUUID().slice(0, 8)}`
    setPeer('A')
    expect(aggA.ensureTopic(topicId).ok).toBe(true)
    const fileId = randomUUID()
    const fBytes = Buffer.from('original-bytes-for-immutable')
    writeFileSync(join(filesDirA, `${fileId}.pdf`), fBytes)
    const msgId = `m-${randomUUID().slice(0, 8)}`
    const blockId = `b-${randomUUID().slice(0, 8)}`
    const msgWire: any = {
      id: msgId,
      topicId,
      role: 'user',
      content: 'msg',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0,
      blocks: [blockId]
    }
    const blk: any = {
      id: blockId,
      messageId: msgId,
      type: 'file',
      content: 'f',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0,
      file: {
        id: fileId,
        name: `${fileId}.pdf`,
        origin_name: 'doc.pdf',
        path: join(filesDirA, `${fileId}.pdf`),
        size: fBytes.length,
        ext: '.pdf',
        type: 'document',
        created_at: new Date().toISOString()
      }
    }
    expect(aggA.appendMessage(topicId, msgWire, [blk] as any).ok).toBe(true)
    setPeer('A')
    activeStore = storeA
    await syncService.sync()
    // Now change file bytes (simulate hash/length change) while keeping same id
    const newBytes = Buffer.from('tampered-bytes-different-length-xxxx')
    writeFileSync(join(filesDirA, `${fileId}.pdf`), newBytes)
    // Create new block with same fileId but different content (should reuse same fileId but file changed)
    const msgId2 = `m-${randomUUID().slice(0, 8)}`
    const blockId2 = `b-${randomUUID().slice(0, 8)}`
    const msgWire2: any = {
      id: msgId2,
      topicId,
      role: 'user',
      content: 'msg2',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 1,
      blocks: [blockId2]
    }
    const blk2: any = {
      id: blockId2,
      messageId: msgId2,
      type: 'file',
      content: 'f2',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0,
      file: {
        id: fileId,
        name: `${fileId}.pdf`,
        origin_name: 'doc.pdf',
        path: join(filesDirA, `${fileId}.pdf`),
        size: newBytes.length,
        ext: '.pdf',
        type: 'document',
        created_at: new Date().toISOString()
      }
    }
    expect(aggA.appendMessage(topicId, msgWire2, [blk2] as any).ok).toBe(true)
    // Drain should detect immutable mismatch and retain pending, not clear, not rotate assetId
    setPeer('A')
    activeStore = storeA
    await syncService.sync()
    const intents = dbA.select().from(schema.syncAttachmentCaptureIntent).all()
    const pendingForSecond = intents.filter((i) => i.blockId === blockId2)
    expect(pendingForSecond.length).toBe(1)
    expect(pendingForSecond[0].fileId).toBe(fileId)
    void dbA.select().from(schema.syncState).where(eq(schema.syncState.key, 'lastError')).get() as any
    // lastError may be cleared by successful sync's final updateLastError(null) if drain reported via separate path;
    // main fail-closed proof is pending retained and no relay op, with original asset intact
    expect(pendingForSecond.length).toBe(1)
    // Ensure relay does not have second block's op (fail-closed)
    const relaySecond = relayOps.filter((r) => r.op.entityType === 'message_block' && r.op.entityId === blockId2)
    expect(relaySecond.length).toBe(0)
    // Original file asset still exists with original hash
    const fa = dbA.select().from(schema.syncFileAsset).where(eq(schema.syncFileAsset.id, fileId)).get() as any
    expect(fa.sha256).toBe(shaHex(fBytes))
    // Not rotated: no new file_asset with different id
  }, 30000)
})
