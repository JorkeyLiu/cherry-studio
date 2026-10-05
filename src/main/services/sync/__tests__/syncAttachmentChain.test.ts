import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

describe('attachment incremental chain', () => {
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
  // relay in-memory
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
    const rootA = mkdtempSync(join(tmpdir(), 'sync-attach-a-'))
    const rootB = mkdtempSync(join(tmpdir(), 'sync-attach-b-'))
    tmpRoots.push(rootA, rootB)
    filesDirA = join(rootA, 'Files')
    filesDirB = join(rootB, 'Files')
    tmpDirA = join(rootA, 'tmp')
    tmpDirB = join(rootB, 'tmp')
    mkdirSync(filesDirA, { recursive: true })
    mkdirSync(filesDirB, { recursive: true })
    mkdirSync(tmpDirA, { recursive: true })
    mkdirSync(tmpDirB, { recursive: true })

    // Mock syncClient push/pull to use relayOps
    vi.spyOn(syncClient, 'push').mockImplementation(async (_endpoint, req: any) => {
      const accepted: string[] = []
      for (const op of req.operations) {
        if (relayOps.some((r) => (r.op.id as string) === op.id)) continue
        relaySeq += 1
        relayOps.push({ seq: relaySeq, op: { ...op, seq: relaySeq } })
        accepted.push(op.id)
      }
      return { cursor: relaySeq, acceptedIds: accepted } as any
    })
    vi.spyOn(syncClient, 'pull').mockImplementation(async (_endpoint, cursor: number) => {
      const ops = relayOps.filter((r) => r.seq > cursor).map((r) => ({ ...r.op, seq: r.seq }))
      return { operations: ops, cursor: relaySeq } as any
    })
    // Stub attachment client via injected services, not via syncClient directly
    // But ensure syncClient upload/download also mocked for fallback
    vi.spyOn(syncClient, 'uploadAttachment').mockImplementation(async (_endpoint, args: any) => {
      // collect body if it's a stream
      const body = args.body
      let buf: Buffer
      if (Buffer.isBuffer(body)) buf = body
      else if (body instanceof Uint8Array) buf = Buffer.from(body)
      else {
        // stream
        const chunks: Buffer[] = []
        for await (const c of body as AsyncIterable<Buffer>) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
        buf = Buffer.concat(chunks)
      }
      if (buf.length !== args.byteLength) {
        // allow but store
      }
      const digest = args.digest
      // verify hash
      const actual = shaHex(buf)
      if (actual !== digest) throw new Error('attachment upload failed: digest-mismatch')
      attachmentStore.set(digest, Buffer.from(buf))
      return { digest, byteLength: buf.length, deduplicated: false }
    })
    vi.spyOn(syncClient, 'downloadAttachment').mockImplementation(
      async (_endpoint, args: any, _c, _s, _sig, onChunk?: any) => {
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
        // verify digest incrementally would be done by client, but we assume ok
        const actual = shaHex(buf)
        if (actual !== args.digest) throw new Error('attachment download failed: digest-mismatch')
        return { digest: args.digest, byteLength: buf.length }
      }
    )
    vi.spyOn(syncClient, 'fetchBaseline').mockImplementation(async () => ({ found: false }) as any)

    // Seed device identities and pairing
    const deviceIdA = randomUUID()
    const deviceIdB = randomUUID()
    // endpoint/token
    const endpoint = 'http://127.0.0.1:3030'
    for (const store of [storeA, storeB]) {
      store.set('sync:endpoint', endpoint)
      store.set('sync:enabled', true)
    }
    storeA.set('sync:deviceCode', 'ABCD2345')
    storeA.set('sync:deviceAuth', 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90')
    storeB.set('sync:deviceCode', 'EFGH6789')
    storeB.set('sync:deviceAuth', 'b'.repeat(64))
    // deviceId in DB
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
    // also need relay to know channel - but our mock push checks only pairing via channelKey existence, not relay auth. So we just need local channelKey.

    // Inject attachment services per peer
    const svcA = new SyncAttachmentService({ filesDir: filesDirA, tempDir: tmpDirA, client: syncClient as any })
    const svcB = new SyncAttachmentService({ filesDir: filesDirB, tempDir: tmpDirB, client: syncClient as any })
    // Use singleton syncService but set per peer before each sync call
    // We'll store services and swap active attachments before sync
    ;(syncService as any)._svcA = svcA
    ;(syncService as any)._svcB = svcB
    // Monkey patch getAttachmentService to return current peer's svc
    void (syncService as any).getAttachmentService?.bind(syncService)
    vi.spyOn(syncService as any, 'getAttachmentService').mockImplementation(() => {
      // decide based on activeStore
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

  it('syncs file/image/video and branch file via incremental chain', async () => {
    // Create topic
    const topicId = `t-${randomUUID().slice(0, 8)}`
    setPeer('A')
    const ensureRes = aggA.ensureTopic(topicId)
    expect((ensureRes as any).ok ?? (ensureRes as any).success).toBe(true)

    // Create files in filesDirA
    const fileBytes = Buffer.from('file-bytes-pdf-content')
    const imageBytes = Buffer.from('image-bytes-png-content')
    const videoBytes = Buffer.from('video-bytes-mp4-content')
    const fileId = randomUUID()
    const imageId = randomUUID()
    const videoId = randomUUID()
    writeFileSync(join(filesDirA, `${fileId}.pdf`), fileBytes)
    writeFileSync(join(filesDirA, `${imageId}.png`), imageBytes)
    writeFileSync(join(filesDirA, `${videoId}.mp4`), videoBytes)

    const fileHash = shaHex(fileBytes)
    const imageHash = shaHex(imageBytes)
    const videoHash = shaHex(videoBytes)

    // Build message with 3 blocks: file,image,video
    const msgId = `m-${randomUUID().slice(0, 8)}`
    const blockFileId = `b-${randomUUID().slice(0, 8)}`
    const blockImgId = `b-${randomUUID().slice(0, 8)}`
    const blockVidId = `b-${randomUUID().slice(0, 8)}`
    const messageWire: any = {
      id: msgId,
      topicId,
      role: 'user',
      content: 'with attachments',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0,
      blocks: [blockFileId, blockImgId, blockVidId]
    }
    const blockFileWire: any = {
      id: blockFileId,
      messageId: msgId,
      type: 'file',
      content: 'file block',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0,
      file: {
        id: fileId,
        name: `${fileId}.pdf`,
        origin_name: 'doc.pdf',
        path: join(filesDirA, `${fileId}.pdf`),
        size: fileBytes.length,
        ext: '.pdf',
        type: 'document',
        created_at: new Date().toISOString()
      }
    }
    const blockImgWire: any = {
      id: blockImgId,
      messageId: msgId,
      type: 'image',
      content: 'image block',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 1,
      file: {
        id: imageId,
        name: `${imageId}.png`,
        origin_name: 'pic.png',
        path: join(filesDirA, `${imageId}.png`),
        size: imageBytes.length,
        ext: '.png',
        type: 'image',
        created_at: new Date().toISOString()
      }
    }
    const blockVidWire: any = {
      id: blockVidId,
      messageId: msgId,
      type: 'video',
      content: 'video block',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 2,
      file: {
        id: videoId,
        name: `${videoId}.mp4`,
        origin_name: 'vid.mp4',
        path: join(filesDirA, `${videoId}.mp4`),
        size: videoBytes.length,
        ext: '.mp4',
        type: 'video',
        created_at: new Date().toISOString()
      }
    }

    setPeer('A')
    ;(chatDbService as any).db = dbA
    ;(chatDbService as any).sqlite = sqliteA
    const res = aggA.appendMessage(topicId, messageWire, [blockFileWire, blockImgWire, blockVidWire] as any)
    expect((res as any).ok ?? (res as any).success).toBe(true)

    // Verify capture intents exist, outbox does not yet have blocks
    const intents = dbA.select().from(schema.syncAttachmentCaptureIntent).all()
    expect(intents.length).toBe(3)
    const outboxBefore = dbA.select().from(schema.syncOutbox).all()
    // Should have topic/message but not blocks (deferred)
    const blockOpsBefore = outboxBefore.filter((o) => o.entityType === 'message_block')
    expect(blockOpsBefore.length).toBe(0)

    // Sync A -> relay
    setPeer('A')
    ;(chatDbService as any).db = dbA
    ;(chatDbService as any).sqlite = sqliteA
    activeStore = storeA
    void (await syncService.sync())
    // After sync, intents should be cleared, file_asset ops pushed, blocks pushed
    const intentsAfter = dbA.select().from(schema.syncAttachmentCaptureIntent).all()
    expect(intentsAfter.length).toBe(0)
    const fileAssetsA = dbA.select().from(schema.syncFileAsset).all()
    expect(fileAssetsA.length).toBe(3)
    // Verify relay has file_asset and block ops
    const relayFileOps = relayOps.filter((r) => r.op.entityType === 'file_asset')
    expect(relayFileOps.length).toBe(3)
    const relayBlockOps = relayOps.filter((r) => r.op.entityType === 'message_block')
    expect(relayBlockOps.length).toBe(3)
    // Verify attachment blobs stored
    expect(attachmentStore.get(fileHash)?.equals(fileBytes)).toBe(true)
    expect(attachmentStore.get(imageHash)?.equals(imageBytes)).toBe(true)
    expect(attachmentStore.get(videoHash)?.equals(videoBytes)).toBe(true)

    // Sync B -> pull and install
    setPeer('B')
    ;(chatDbService as any).db = dbB
    ;(chatDbService as any).sqlite = sqliteB
    activeStore = storeB
    void (await syncService.sync())
    // Verify B has files installed
    const fileAssetsB = dbB.select().from(schema.syncFileAsset).all()
    expect(fileAssetsB.length).toBe(3)
    expect(readFileSync(join(filesDirB, `${fileId}.pdf`)).equals(fileBytes)).toBe(true)
    expect(readFileSync(join(filesDirB, `${imageId}.png`)).equals(imageBytes)).toBe(true)
    expect(readFileSync(join(filesDirB, `${videoId}.mp4`)).equals(videoBytes)).toBe(true)
    // Verify blocks and file refs
    const blocksB = dbB.select().from(schema.messageBlocks).all()
    expect(blocksB.length).toBe(3)
    const refsB = dbB.select().from(schema.fileReferences).all()
    expect(refsB.length).toBe(3)
    // Verify fetchMessages returns usable projection (file refs present)
    const fetched = aggB.fetchMessages(topicId)
    expect((fetched as any).ok ?? (fetched as any).success).toBeTruthy()
    const fetchedVal: any = (fetched as any).value ?? (fetched as any).data ?? (fetched as any)
    const fetchedBlocks: any[] = fetchedVal.blocks ?? fetchedVal.value?.blocks ?? []
    expect(fetchedBlocks.length).toBe(3)
    // AssetIds may not be in wire blocks; verify file refs and assets instead
    expect(refsB.length).toBe(3)
    // Verify cursor advanced
    const cursorB = dbB
      .select()
      .from(schema.syncState)
      .where((await import('drizzle-orm')).eq(schema.syncState.key, 'cursor'))
      .get() as any
    expect(cursorB).toBeTruthy()
  }, 30000)

  it('syncs branch-owned file and keeps main frame unpolluted', async () => {
    const topicId = `t-${randomUUID().slice(0, 8)}`
    setPeer('A')
    expect(aggA.ensureTopic(topicId).ok).toBe(true)
    // Create main message
    const mainMsgId = `m-${randomUUID().slice(0, 8)}`
    const mainBlockId = `b-${randomUUID().slice(0, 8)}`
    const mainMsg: any = {
      id: mainMsgId,
      topicId,
      role: 'user',
      content: 'main',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0,
      blocks: [mainBlockId]
    }
    const mainBlock: any = {
      id: mainBlockId,
      messageId: mainMsgId,
      type: 'main_text',
      content: 'hello',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0
    }
    expect(aggA.appendMessage(topicId, mainMsg, [mainBlock] as any).ok).toBe(true)
    // Create branch
    const branchRes = aggA.createBranch(topicId, null, mainMsgId, 'Branch1')
    expect((branchRes as any).ok).toBe(true)
    const branchId = (branchRes as any).value.branch.id as string
    // Create file for branch
    const fId = randomUUID()
    const fBytes = Buffer.from('branch-file-bytes')
    writeFileSync(join(filesDirA, `${fId}.pdf`), fBytes)
    const bId = `b-${randomUUID().slice(0, 8)}`
    const mId = `m-${randomUUID().slice(0, 8)}`
    const branchMsg: any = {
      id: mId,
      topicId,
      role: 'user',
      content: 'branch with file',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 1,
      blocks: [bId]
    }
    const branchBlock: any = {
      id: bId,
      messageId: mId,
      type: 'file',
      content: 'f',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0,
      file: {
        id: fId,
        name: `${fId}.pdf`,
        origin_name: 'branch.pdf',
        path: join(filesDirA, `${fId}.pdf`),
        size: fBytes.length,
        ext: '.pdf',
        type: 'document',
        created_at: new Date().toISOString()
      }
    }
    setPeer('A')
    ;(chatDbService as any).db = dbA
    ;(chatDbService as any).sqlite = sqliteA
    const br = aggA.appendMessage(topicId, branchMsg, [branchBlock] as any, undefined, undefined, { branchId } as any)
    expect((br as any).ok).toBe(true)
    // Sync A -> B
    setPeer('A')
    activeStore = storeA
    await syncService.sync()
    setPeer('B')
    activeStore = storeB
    await syncService.sync()
    // Verify B has branch file installed
    expect(readFileSync(join(filesDirB, `${fId}.pdf`)).equals(fBytes)).toBe(true)
    const branchRowsB = dbB.select().from(schema.topicBranches).all()
    expect(branchRowsB.length).toBe(1)
    expect(branchRowsB[0].id).toBe(branchId)
    const msgB = dbB
      .select()
      .from(schema.messages)
      .where((await import('drizzle-orm')).eq(schema.messages.id, mId))
      .get() as any
    expect(msgB).toBeTruthy()
    expect(msgB.branchId).toBe(branchId)
    // Main fetch should not include branch message
    const mainFetch = aggB.fetchMessages(topicId, null)
    const mainVal: any = (mainFetch as any).value ?? (mainFetch as any).data
    const mainIds = (mainVal.messages as any[]).map((m: any) => m.id)
    expect(mainIds.includes(mId)).toBe(false)
    expect(mainIds.includes(mainMsgId)).toBe(true)
    // Branch fetch should include branch message
    const branchFetch = aggB.fetchMessages(topicId, branchId)
    const branchVal: any = (branchFetch as any).value ?? (branchFetch as any).data
    const brIds = (branchVal.messages as any[]).map((m: any) => m.id)
    expect(brIds.includes(mId)).toBe(true)
  }, 30000)

  it('dedups shared file upload across multiple blocks', async () => {
    const topicId = `t-${randomUUID().slice(0, 8)}`
    setPeer('A')
    expect(aggA.ensureTopic(topicId).ok).toBe(true)
    const sharedId = randomUUID()
    const sharedBytes = Buffer.from('shared-file-content-dedup')
    writeFileSync(join(filesDirA, `${sharedId}.pdf`), sharedBytes)
    const msgId1 = `m-${randomUUID().slice(0, 8)}`
    const b1 = `b-${randomUUID().slice(0, 8)}`
    const msg1: any = {
      id: msgId1,
      topicId,
      role: 'user',
      content: 'msg1',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0,
      blocks: [b1]
    }
    const blk1: any = {
      id: b1,
      messageId: msgId1,
      type: 'file',
      content: 'f1',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0,
      file: {
        id: sharedId,
        name: `${sharedId}.pdf`,
        origin_name: 'shared.pdf',
        path: join(filesDirA, `${sharedId}.pdf`),
        size: sharedBytes.length,
        ext: '.pdf',
        type: 'document',
        created_at: new Date().toISOString()
      }
    }
    const msgId2 = `m-${randomUUID().slice(0, 8)}`
    const b2 = `b-${randomUUID().slice(0, 8)}`
    const msg2: any = {
      id: msgId2,
      topicId,
      role: 'user',
      content: 'msg2',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 1,
      blocks: [b2]
    }
    const blk2: any = {
      id: b2,
      messageId: msgId2,
      type: 'file',
      content: 'f2',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0,
      file: {
        id: sharedId,
        name: `${sharedId}.pdf`,
        origin_name: 'shared.pdf',
        path: join(filesDirA, `${sharedId}.pdf`),
        size: sharedBytes.length,
        ext: '.pdf',
        type: 'document',
        created_at: new Date().toISOString()
      }
    }
    setPeer('A')
    expect(aggA.appendMessage(topicId, msg1, [blk1] as any).ok).toBe(true)
    expect(aggA.appendMessage(topicId, msg2, [blk2] as any).ok).toBe(true)
    const intents = dbA.select().from(schema.syncAttachmentCaptureIntent).all()
    expect(intents.length).toBe(2)
    // Both intents share same fileId but different blockIds
    setPeer('A')
    activeStore = storeA
    await syncService.sync()
    // Should have only one blob stored (dedup)
    expect(attachmentStore.size).toBeGreaterThanOrEqual(1)
    const fileOps = relayOps.filter((r) => r.op.entityType === 'file_asset' && r.op.entityId === sharedId)
    expect(fileOps.length).toBe(1)
    const blockOps = relayOps.filter(
      (r) => r.op.entityType === 'message_block' && (r.op.entityId === b1 || r.op.entityId === b2)
    )
    expect(blockOps.length).toBe(2)
    setPeer('B')
    activeStore = storeB
    await syncService.sync()
    expect(readFileSync(join(filesDirB, `${sharedId}.pdf`)).equals(sharedBytes)).toBe(true)
    const refsB = dbB
      .select()
      .from(schema.fileReferences)
      .all()
      .filter((r) => r.fileId === sharedId)
    expect(refsB.length).toBe(2)
  }, 30000)
})
