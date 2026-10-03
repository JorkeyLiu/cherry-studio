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
function setPeer(
  peer: 'A' | 'B',
  ctx: {
    sqliteA: Database.Database
    dbA: BetterSQLite3Database<typeof schema>
    sqliteB: Database.Database
    dbB: BetterSQLite3Database<typeof schema>
  }
): void {
  activeStore = peer === 'A' ? storeA : storeB
  if (peer === 'A') {
    ;(chatDbService as any).sqlite = ctx.sqliteA
    ;(chatDbService as any).db = ctx.dbA
  } else {
    ;(chatDbService as any).sqlite = ctx.sqliteB
    ;(chatDbService as any).db = ctx.dbB
  }
}

describe('sync attachment structural mutations (5 insertion + parent delete)', () => {
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
    const rootA = mkdtempSync(join(tmpdir(), 'sync-struct-a-'))
    const rootB = mkdtempSync(join(tmpdir(), 'sync-struct-b-'))
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
      const nextCursor = ops.length > 0 ? ops[ops.length - 1].seq : cursor
      return { operations: ops, cursor: nextCursor } as any
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
    setPeer('A', { sqliteA, dbA, sqliteB, dbB })
    dbA.insert(schema.syncState).values({ key: 'deviceId', value: deviceIdA }).run()
    dbA.insert(schema.syncState).values({ key: 'sync:pairingGeneration', value: 'cc-1' }).run()
    dbA.insert(schema.syncState).values({ key: 'sync:channelKey', value: 'chan-test' }).run()
    dbA.insert(schema.syncState).values({ key: 'cursor', value: '0' }).run()
    setPeer('B', { sqliteA, dbA, sqliteB, dbB })
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

  it('insertMessagesAfterAnchor with file defers block and syncs via drain', async () => {
    const topicId = `t-${randomUUID().slice(0, 8)}`
    setPeer('A', { sqliteA, dbA, sqliteB, dbB })
    expect(aggA.ensureTopic(topicId).ok).toBe(true)
    const anchorId = `m-${randomUUID().slice(0, 8)}`
    const anchorMsg: any = {
      id: anchorId,
      topicId,
      role: 'user',
      content: 'anchor',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0,
      blocks: []
    }
    expect(aggA.appendMessage(topicId, anchorMsg, [] as any).ok).toBe(true)
    const fileId = randomUUID()
    const fBytes = Buffer.from('insertAfterAnchor-file')
    writeFileSync(join(filesDirA, `${fileId}.pdf`), fBytes)
    const msgId = `m-${randomUUID().slice(0, 8)}`
    const blockId = `b-${randomUUID().slice(0, 8)}`
    const msgWire: any = {
      id: msgId,
      topicId,
      role: 'user',
      content: 'with file',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 1,
      blocks: [blockId]
    }
    const blockWire: any = {
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
    setPeer('A', { sqliteA, dbA, sqliteB, dbB })
    const res = aggA.insertMessagesAfterAnchor(topicId, anchorId, [{ message: msgWire, blocks: [blockWire] } as never])
    expect((res as any).ok).toBe(true)
    let intents = dbA.select().from(schema.syncAttachmentCaptureIntent).all()
    expect(intents.some((i) => i.blockId === blockId)).toBe(true)
    expect(
      dbA
        .select()
        .from(schema.syncOutbox)
        .all()
        .filter((o) => o.entityType === 'message_block' && o.entityId === blockId).length
    ).toBe(0)
    setPeer('A', { sqliteA, dbA, sqliteB, dbB })
    activeStore = storeA
    await syncService.sync()
    intents = dbA.select().from(schema.syncAttachmentCaptureIntent).all()
    expect(intents.some((i) => i.blockId === blockId)).toBe(false)
    const relayBlock = relayOps.filter((r) => r.op.entityType === 'message_block' && r.op.entityId === blockId)
    expect(relayBlock.length).toBe(1)
    expect(relayBlock[0].op.payload.assetIds).toEqual([fileId])
    setPeer('B', { sqliteA, dbA, sqliteB, dbB })
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

  it('insertMessageGroups flatBlocks with file/image defers and syncs via drain', async () => {
    const topicId = `t-${randomUUID().slice(0, 8)}`
    setPeer('A', { sqliteA, dbA, sqliteB, dbB })
    expect(aggA.ensureTopic(topicId).ok).toBe(true)
    const fileId = randomUUID()
    const fBytes = Buffer.from('group-file')
    writeFileSync(join(filesDirA, `${fileId}.pdf`), fBytes)
    const imgId = randomUUID()
    const iBytes = Buffer.from('group-image')
    writeFileSync(join(filesDirA, `${imgId}.png`), iBytes)
    const m1 = `m-${randomUUID().slice(0, 8)}`
    const b1 = `b-${randomUUID().slice(0, 8)}`
    const m2 = `m-${randomUUID().slice(0, 8)}`
    const b2 = `b-${randomUUID().slice(0, 8)}`
    const msg1: any = {
      id: m1,
      topicId,
      role: 'user',
      content: 'g1',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0,
      blocks: [b1]
    }
    const blk1: any = {
      id: b1,
      messageId: m1,
      type: 'file',
      content: 'f',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0,
      file: {
        id: fileId,
        name: `${fileId}.pdf`,
        origin_name: 'a.pdf',
        path: join(filesDirA, `${fileId}.pdf`),
        size: fBytes.length,
        ext: '.pdf',
        type: 'document',
        created_at: new Date().toISOString()
      }
    }
    const msg2: any = {
      id: m2,
      topicId,
      role: 'user',
      content: 'g2',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 1,
      blocks: [b2]
    }
    const blk2: any = {
      id: b2,
      messageId: m2,
      type: 'image',
      content: 'i',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0,
      file: {
        id: imgId,
        name: `${imgId}.png`,
        origin_name: 'b.png',
        path: join(filesDirA, `${imgId}.png`),
        size: iBytes.length,
        ext: '.png',
        type: 'image',
        created_at: new Date().toISOString()
      }
    }
    setPeer('A', { sqliteA, dbA, sqliteB, dbB })
    const res = aggA.insertMessageGroups(topicId, [
      { entries: [{ message: msg1, blocks: [blk1] }], intent: { kind: 'topic-tail' } as any },
      { entries: [{ message: msg2, blocks: [blk2] }], intent: { kind: 'topic-tail' } as any }
    ] as never)
    expect((res as any).ok).toBe(true)
    let intents = dbA.select().from(schema.syncAttachmentCaptureIntent).all()
    expect(intents.length).toBe(2)
    setPeer('A', { sqliteA, dbA, sqliteB, dbB })
    activeStore = storeA
    await syncService.sync()
    intents = dbA.select().from(schema.syncAttachmentCaptureIntent).all()
    expect(intents.length).toBe(0)
    expect(relayOps.filter((r) => r.op.entityType === 'message_block' && r.op.entityId === b1).length).toBe(1)
    expect(relayOps.filter((r) => r.op.entityType === 'message_block' && r.op.entityId === b2).length).toBe(1)
    setPeer('B', { sqliteA, dbA, sqliteB, dbB })
    activeStore = storeB
    await syncService.sync()
    expect(readFileSync(join(filesDirB, `${fileId}.pdf`)).equals(fBytes)).toBe(true)
    expect(readFileSync(join(filesDirB, `${imgId}.png`)).equals(iBytes)).toBe(true)
  }, 30000)

  it('branchMessagesToTopic legacy clone with file syncs via drain', async () => {
    const src = `t-${randomUUID().slice(0, 8)}`
    const dst = `t-${randomUUID().slice(0, 8)}`
    setPeer('A', { sqliteA, dbA, sqliteB, dbB })
    expect(aggA.ensureTopic(src).ok).toBe(true)
    const fileId = randomUUID()
    const fBytes = Buffer.from('branch-clone-file')
    writeFileSync(join(filesDirA, `${fileId}.pdf`), fBytes)
    const mSrc = `m-${randomUUID().slice(0, 8)}`
    const bSrc = `b-${randomUUID().slice(0, 8)}`
    const msgSrc: any = {
      id: mSrc,
      topicId: src,
      role: 'user',
      content: 'src',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0,
      blocks: [bSrc]
    }
    const blkSrc: any = {
      id: bSrc,
      messageId: mSrc,
      type: 'file',
      content: 'f',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0,
      file: {
        id: fileId,
        name: `${fileId}.pdf`,
        origin_name: 'c.pdf',
        path: join(filesDirA, `${fileId}.pdf`),
        size: fBytes.length,
        ext: '.pdf',
        type: 'document',
        created_at: new Date().toISOString()
      }
    }
    expect(aggA.appendMessage(src, msgSrc, [blkSrc] as any).ok).toBe(true)
    // Ensure pending before clone sync
    setPeer('A', { sqliteA, dbA, sqliteB, dbB })
    activeStore = storeA
    await syncService.sync()
    // keep relay for clone phase (do not clear, keep seq contiguous)
    // Do branch clone (legacy cross-topic)
    setPeer('A', { sqliteA, dbA, sqliteB, dbB })
    const cloneRes = aggA.branchMessagesToTopic(src, dst, mSrc)
    expect((cloneRes as any).ok).toBe(true)
    const clonedMsgId =
      (cloneRes as any).value?.messages?.[0]?.id ??
      dbA
        .select()
        .from(schema.messages)
        .all()
        .find((m) => m.topicId === dst)?.id
    const clonedBlockRow = dbA
      .select()
      .from(schema.messageBlocks)
      .all()
      .find((b) => b.messageId === clonedMsgId)
    const clonedBlockId = clonedBlockRow?.id as string
    expect(clonedBlockId).toBeTruthy()
    // The cloned file block should have pending intent (deferred)
    let intents = dbA
      .select()
      .from(schema.syncAttachmentCaptureIntent)
      .all()
      .filter((i) => i.blockId === clonedBlockId)
    expect(intents.length).toBe(1)
    expect(intents[0].fileId).toBe(fileId)
    // Drain
    setPeer('A', { sqliteA, dbA, sqliteB, dbB })
    activeStore = storeA
    await syncService.sync()
    intents = dbA
      .select()
      .from(schema.syncAttachmentCaptureIntent)
      .all()
      .filter((i) => i.blockId === clonedBlockId)
    expect(intents.length).toBe(0)
    const relayBlock = relayOps.filter((r) => r.op.entityType === 'message_block' && r.op.entityId === clonedBlockId)
    expect(relayBlock.length).toBe(1)
    expect(relayBlock[0].op.payload.assetIds).toEqual([fileId])
    setPeer('B', { sqliteA, dbA, sqliteB, dbB })
    activeStore = storeB
    await syncService.sync()
    expect(readFileSync(join(filesDirB, `${fileId}.pdf`)).equals(fBytes)).toBe(true)
  }, 30000)

  it('cloneMessagesToTopic double-ref preserves ordered unique assetIds aggregated', async () => {
    const topicId = `t-${randomUUID().slice(0, 8)}`
    setPeer('A', { sqliteA, dbA, sqliteB, dbB })
    expect(aggA.ensureTopic(topicId).ok).toBe(true)
    const fId1 = randomUUID()
    const fId2 = randomUUID()
    const b1 = Buffer.from('double-a')
    const b2 = Buffer.from('double-b')
    writeFileSync(join(filesDirA, `${fId1}.pdf`), b1)
    writeFileSync(join(filesDirA, `${fId2}.png`), b2)
    const mId = `m-${randomUUID().slice(0, 8)}`
    const blkId = `b-${randomUUID().slice(0, 8)}`
    const msg: any = {
      id: mId,
      topicId,
      role: 'user',
      content: 'double',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0,
      blocks: [blkId]
    }
    const blk: any = {
      id: blkId,
      messageId: mId,
      type: 'file',
      content: 'f',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0,
      file: {
        id: fId1,
        name: `${fId1}.pdf`,
        origin_name: 'a.pdf',
        path: join(filesDirA, `${fId1}.pdf`),
        size: b1.length,
        ext: '.pdf',
        type: 'document',
        created_at: new Date().toISOString()
      }
    }
    setPeer('A', { sqliteA, dbA, sqliteB, dbB })
    const res = aggA.cloneMessagesToTopic(topicId, [{ message: msg, blocks: [blk] } as never])
    expect((res as any).ok).toBe(true)
    // Simulate second file ref for same block (dual asset): insert extra fileReference and extra intent before drain
    dbA
      .insert(schema.fileReferences)
      .values({
        id: `fr-${blkId}-${fId2}`,
        blockId: blkId,
        fileId: fId2,
        fileName: `${fId2}.png`,
        filePath: null,
        fileType: null,
        count: 1,
        extra: null
      })
      .run()
    dbA
      .insert(schema.syncAttachmentCaptureIntent)
      .values({ blockId: blkId, fileId: fId2, capturedAt: Date.now() })
      .onConflictDoNothing()
      .run()
    setPeer('A', { sqliteA, dbA, sqliteB, dbB })
    activeStore = storeA
    await syncService.sync()
    const relayBlock = relayOps.filter((r) => r.op.entityType === 'message_block' && r.op.entityId === blkId)
    expect(relayBlock.length).toBe(1)
    const assetIds = relayBlock[0].op.payload.assetIds as string[]
    expect(assetIds.sort()).toEqual([fId1, fId2].sort())
    setPeer('B', { sqliteA, dbA, sqliteB, dbB })
    activeStore = storeB
    await syncService.sync()
    const refsB = dbB
      .select()
      .from(schema.fileReferences)
      .all()
      .filter((r) => r.blockId === blkId)
    expect(refsB.length).toBe(2)
    expect(readFileSync(join(filesDirB, `${fId1}.pdf`)).equals(b1)).toBe(true)
    expect(readFileSync(join(filesDirB, `${fId2}.png`)).equals(b2)).toBe(true)
  }, 30000)

  it('pasteMessagesToTopic with true-branch suffix owner keep and file syncs', async () => {
    const topicId = `t-${randomUUID().slice(0, 8)}`
    setPeer('A', { sqliteA, dbA, sqliteB, dbB })
    expect(aggA.ensureTopic(topicId).ok).toBe(true)
    const anchor = `m-${randomUUID().slice(0, 8)}`
    const am: any = {
      id: anchor,
      topicId,
      role: 'user',
      content: 'anchor',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0,
      blocks: []
    }
    expect(aggA.appendMessage(topicId, am, [] as any).ok).toBe(true)
    const branchRes: any = aggA.createBranch(topicId, null, anchor, 'Branch1')
    expect(branchRes.ok).toBe(true)
    const branchId = branchRes.value.branch.id as string
    const fId = randomUUID()
    const fBytes = Buffer.from('branch-suffix-file')
    writeFileSync(join(filesDirA, `${fId}.pdf`), fBytes)
    const mId = `m-${randomUUID().slice(0, 8)}`
    const bId = `b-${randomUUID().slice(0, 8)}`
    const msg: any = {
      id: mId,
      topicId,
      role: 'user',
      content: 'branch msg',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 1,
      blocks: [bId]
    }
    const blk: any = {
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
    setPeer('A', { sqliteA, dbA, sqliteB, dbB })
    const res = aggA.pasteMessagesToTopic(
      topicId,
      [{ message: msg, blocks: [blk] } as never],
      undefined,
      branchId as any
    )
    expect((res as any).ok).toBe(true)
    let intents = dbA.select().from(schema.syncAttachmentCaptureIntent).all()
    expect(intents.some((i) => i.blockId === bId)).toBe(true)
    const msgRow = dbA
      .select()
      .from(schema.messages)
      .all()
      .find((m) => m.id === mId)
    expect((msgRow as any)?.branchId).toBe(branchId)
    setPeer('A', { sqliteA, dbA, sqliteB, dbB })
    activeStore = storeA
    await syncService.sync()
    intents = dbA.select().from(schema.syncAttachmentCaptureIntent).all()
    expect(intents.some((i) => i.blockId === bId)).toBe(false)
    const relayBlock = relayOps.filter((r) => r.op.entityType === 'message_block' && r.op.entityId === bId)
    expect(relayBlock.length).toBe(1)
    setPeer('B', { sqliteA, dbA, sqliteB, dbB })
    activeStore = storeB
    await syncService.sync()
    const bMsg = dbB
      .select()
      .from(schema.messages)
      .all()
      .find((m) => m.id === mId)
    expect((bMsg as any)?.branchId).toBe(branchId)
    expect(readFileSync(join(filesDirB, `${fId}.pdf`)).equals(fBytes)).toBe(true)
  }, 30000)

  it('pending parent delete clears 021 intent rows and does not resurrect after drain', async () => {
    const topicId = `t-${randomUUID().slice(0, 8)}`
    setPeer('A', { sqliteA, dbA, sqliteB, dbB })
    expect(aggA.ensureTopic(topicId).ok).toBe(true)
    const fId = randomUUID()
    const fBytes = Buffer.from('pending-delete-file')
    writeFileSync(join(filesDirA, `${fId}.pdf`), fBytes)
    const mId = `m-${randomUUID().slice(0, 8)}`
    const bId = `b-${randomUUID().slice(0, 8)}`
    const msg: any = {
      id: mId,
      topicId,
      role: 'user',
      content: 'to delete',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0,
      blocks: [bId]
    }
    const blk: any = {
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
        origin_name: 'del.pdf',
        path: join(filesDirA, `${fId}.pdf`),
        size: fBytes.length,
        ext: '.pdf',
        type: 'document',
        created_at: new Date().toISOString()
      }
    }
    expect(aggA.appendMessage(topicId, msg, [blk] as any).ok).toBe(true)
    let intents = dbA.select().from(schema.syncAttachmentCaptureIntent).all()
    expect(intents.some((i) => i.blockId === bId)).toBe(true)
    const outboxBefore = dbA.select().from(schema.syncOutbox).all()
    const pendingMsgUps = outboxBefore.filter(
      (o) => o.entityType === 'message' && o.entityId === mId && o.op === 'upsert'
    )
    expect(pendingMsgUps.length).toBe(1)
    const pendingBlockUps = outboxBefore.filter((o) => o.entityType === 'message_block' && o.entityId === bId)
    expect(pendingBlockUps.length).toBe(0)
    const beforeIds = new Set(outboxBefore.map((o) => o.id))
    expect(syncService.isKnownEntityInTx(dbA as any, 'message', mId)).toBe(true)
    // block row exists locally, so isKnown returns true via row fallback, but deleteMessage only tombstones the message (parent suppresses child)
    expect(syncService.isKnownEntityInTx(dbA as any, 'message_block', bId)).toBe(true)
    const beforeRelayLen = relayOps.length
    const beforeRelaySeq = relaySeq
    expect(relayOps.map((r) => r.seq)).toEqual(Array.from({ length: relayOps.length }, (_, i) => i + 1))
    setPeer('A', { sqliteA, dbA, sqliteB, dbB })
    const del = aggA.deleteMessage(topicId, mId)
    expect((del as any).ok).toBe(true)
    intents = dbA.select().from(schema.syncAttachmentCaptureIntent).all()
    expect(intents.some((i) => i.blockId === bId)).toBe(false)
    const outboxAfter = dbA.select().from(schema.syncOutbox).all()
    const outboxDeletes = outboxAfter.filter(
      (o) => o.entityType === 'message' && o.entityId === mId && o.op === 'delete'
    )
    expect(outboxDeletes.length).toBe(1)
    const newDelete = outboxAfter.find(
      (o) => !beforeIds.has(o.id) && o.entityType === 'message' && o.entityId === mId && o.op === 'delete'
    )
    expect(newDelete).toBeTruthy()
    expect(newDelete!.payloadJson === null || newDelete!.payloadJson === undefined).toBe(true)
    const blockDeletes = outboxAfter.filter(
      (o) => o.entityType === 'message_block' && o.entityId === bId && o.op === 'delete'
    )
    expect(blockDeletes.length).toBe(0)
    const pendingBeforeSync = dbA.select().from(schema.syncOutbox).all().length
    setPeer('A', { sqliteA, dbA, sqliteB, dbB })
    activeStore = storeA
    await syncService.sync()
    expect(
      relayOps.filter((r) => r.op.entityType === 'message' && r.op.entityId === mId && r.op.op === 'delete').length
    ).toBe(1)
    const relayDeletes = relayOps.filter(
      (r) => r.op.entityType === 'message' && r.op.entityId === mId && r.op.op === 'delete'
    )
    expect(relayDeletes[0].op.payload === undefined || relayDeletes[0].op.payload === null).toBe(true)
    expect(
      relayOps.filter((r) => r.op.entityType === 'message_block' && r.op.entityId === bId && r.op.op === 'upsert')
        .length
    ).toBe(0)
    expect(relayOps.map((r) => r.seq)).toEqual(Array.from({ length: relayOps.length }, (_, i) => i + 1))
    // contiguous delta: relay grew by at least pendingBeforeSync (includes topic/frames + delete) and seq is head
    expect(relayOps.length).toBeGreaterThanOrEqual(beforeRelayLen + 1)
    expect(relaySeq).toBe(relayOps.length > 0 ? relayOps[relayOps.length - 1].seq : 0)
    await syncService.sync()
    expect(
      relayOps.filter((r) => r.op.entityType === 'message_block' && r.op.entityId === bId && r.op.op === 'upsert')
        .length
    ).toBe(0)
    setPeer('B', { sqliteA, dbA, sqliteB, dbB })
    activeStore = storeB
    await syncService.sync()
    expect(
      dbB
        .select()
        .from(schema.messages)
        .all()
        .find((m) => (m as any).id === mId)
    ).toBeFalsy()
    expect(
      dbB
        .select()
        .from(schema.messageBlocks)
        .all()
        .find((b) => (b as any).id === bId)
    ).toBeFalsy()
    const tombRow = dbB
      .select()
      .from(schema.syncState)
      .all()
      .find((r) => r.key === `tombstone:message:${mId}`) as any
    expect(tombRow).toBeTruthy()
    const fakeSeq = relaySeq + 1
    relaySeq = fakeSeq
    relayOps.push({
      seq: fakeSeq,
      op: {
        id: randomUUID(),
        entityType: 'message_block',
        op: 'upsert',
        entityId: bId,
        timestamp: Date.now() - 100000,
        deviceId: 'late-fake',
        payload: {
          id: bId,
          messageId: mId,
          type: 'file',
          content: 'late',
          status: 'success',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          assetIds: [fId]
        },
        seq: fakeSeq
      }
    })
    await syncService.sync()
    expect(
      dbB
        .select()
        .from(schema.messageBlocks)
        .all()
        .find((b) => (b as any).id === bId)
    ).toBeFalsy()
    relayOps.pop()
    relaySeq -= 1
    void pendingBeforeSync
    void beforeRelaySeq
    const fId2 = randomUUID()
    const fBytes2 = Buffer.from('pending-delete-shared')
    writeFileSync(join(filesDirA, `${fId2}.pdf`), fBytes2)
    setPeer('A', { sqliteA, dbA, sqliteB, dbB })
    const mShared = `m-${randomUUID().slice(0, 8)}`
    const bShared1 = `b-${randomUUID().slice(0, 8)}`
    const bShared2 = `b-${randomUUID().slice(0, 8)}`
    const msgShared: any = {
      id: mShared,
      topicId,
      role: 'user',
      content: 'shared2',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 2,
      blocks: [bShared1, bShared2]
    }
    const blkShared1: any = {
      id: bShared1,
      messageId: mShared,
      type: 'file',
      content: 'f',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0,
      file: {
        id: fId2,
        name: `${fId2}.pdf`,
        origin_name: 's1.pdf',
        path: join(filesDirA, `${fId2}.pdf`),
        size: fBytes2.length,
        ext: '.pdf',
        type: 'document',
        created_at: new Date().toISOString()
      }
    }
    const blkShared2: any = {
      id: bShared2,
      messageId: mShared,
      type: 'file',
      content: 'f2',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 1,
      file: {
        id: fId2,
        name: `${fId2}.pdf`,
        origin_name: 's2.pdf',
        path: join(filesDirA, `${fId2}.pdf`),
        size: fBytes2.length,
        ext: '.pdf',
        type: 'document',
        created_at: new Date().toISOString()
      }
    }
    expect(aggA.appendMessage(topicId, msgShared, [blkShared1, blkShared2] as any).ok).toBe(true)
    intents = dbA
      .select()
      .from(schema.syncAttachmentCaptureIntent)
      .all()
      .filter((i) => i.fileId === fId2)
    expect(intents.length).toBe(2)
    const delShared = aggA.deleteMessage(topicId, mShared)
    expect((delShared as any).ok).toBe(true)
    intents = dbA
      .select()
      .from(schema.syncAttachmentCaptureIntent)
      .all()
      .filter((i) => i.fileId === fId2)
    expect(intents.length).toBe(0)
  }, 30000)

  it('deleteBranch subtree clears pending intents per-block without resurrect', async () => {
    const topicId = `t-${randomUUID().slice(0, 8)}`
    setPeer('A', { sqliteA, dbA, sqliteB, dbB })
    expect(aggA.ensureTopic(topicId).ok).toBe(true)
    const anchor = `m-${randomUUID().slice(0, 8)}`
    const am: any = {
      id: anchor,
      topicId,
      role: 'user',
      content: 'anchor',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0,
      blocks: []
    }
    expect(aggA.appendMessage(topicId, am, [] as any).ok).toBe(true)
    // establish ancestor on relay to keep sibling invariant visible after delete
    setPeer('A', { sqliteA, dbA, sqliteB, dbB })
    activeStore = storeA
    await syncService.sync()
    setPeer('B', { sqliteA, dbA, sqliteB, dbB })
    activeStore = storeB
    await syncService.sync()
    setPeer('A', { sqliteA, dbA, sqliteB, dbB })
    const br: any = aggA.createBranch(topicId, null, anchor, 'B1')
    expect(br.ok).toBe(true)
    const branchId = br.value.branch.id as string
    const sib: any = aggA.createBranch(topicId, null, anchor, 'Sibling')
    expect(sib.ok).toBe(true)
    const siblingId = sib.value.branch.id as string
    const fId = randomUUID()
    const fBytes = Buffer.from('branch-pending-delete')
    writeFileSync(join(filesDirA, `${fId}.pdf`), fBytes)
    const mId = `m-${randomUUID().slice(0, 8)}`
    const bId = `b-${randomUUID().slice(0, 8)}`
    const msg: any = {
      id: mId,
      topicId,
      role: 'user',
      content: 'branch file',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 1,
      blocks: [bId]
    }
    const blk: any = {
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
        origin_name: 'b.pdf',
        path: join(filesDirA, `${fId}.pdf`),
        size: fBytes.length,
        ext: '.pdf',
        type: 'document',
        created_at: new Date().toISOString()
      }
    }
    const appendRes: any = (aggA as any).appendMessage(topicId, msg, [blk] as any, undefined, undefined, { branchId })
    expect(appendRes.ok).toBe(true)
    let intents = dbA.select().from(schema.syncAttachmentCaptureIntent).all()
    expect(intents.some((i) => i.blockId === bId)).toBe(true)
    expect(syncService.isKnownEntityInTx(dbA as any, 'topic_branch', branchId)).toBe(true)
    expect(syncService.isKnownEntityInTx(dbA as any, 'message', mId)).toBe(true)
    expect(syncService.isKnownEntityInTx(dbA as any, 'message_block', bId)).toBe(true)
    const outboxBefore = dbA.select().from(schema.syncOutbox).all()
    const beforeIds = new Set(outboxBefore.map((o) => o.id))
    const beforeRelayLen = relayOps.length
    const beforeRelaySeq = relaySeq
    expect(relayOps.map((r) => r.seq)).toEqual(Array.from({ length: relayOps.length }, (_, i) => i + 1))
    const anchorBefore = dbA
      .select()
      .from(schema.messages)
      .all()
      .find((m) => (m as any).id === anchor)
    expect(anchorBefore).toBeTruthy()
    const del = aggA.deleteBranch(topicId, branchId)
    expect((del as any).ok).toBe(true)
    expect(((del as any).value.deletedBranchIds as string[]).includes(branchId)).toBe(true)
    expect(((del as any).value.deletedMessageIds as string[]).includes(mId)).toBe(true)
    intents = dbA.select().from(schema.syncAttachmentCaptureIntent).all()
    expect(intents.some((i) => i.blockId === bId)).toBe(false)
    const outboxAfter = dbA.select().from(schema.syncOutbox).all()
    const branchDeletes = outboxAfter.filter(
      (o) => o.entityType === 'topic_branch' && o.entityId === branchId && o.op === 'delete'
    )
    expect(branchDeletes.length).toBe(1)
    expect(!beforeIds.has(branchDeletes[0].id)).toBe(true)
    expect(branchDeletes[0].payloadJson === null || branchDeletes[0].payloadJson === undefined).toBe(true)
    const msgDeletes = outboxAfter.filter((o) => o.entityType === 'message' && o.entityId === mId && o.op === 'delete')
    expect(msgDeletes.length).toBe(1)
    const blockDeletes = outboxAfter.filter(
      (o) => o.entityType === 'message_block' && o.entityId === bId && o.op === 'delete'
    )
    // block row exists locally so isKnown via row fallback is true -> deleteBranch tombstones the block as well (deferred but locally present)
    expect(blockDeletes.length).toBe(1)
    expect(blockDeletes[0].payloadJson === null || blockDeletes[0].payloadJson === undefined).toBe(true)
    const newOps = outboxAfter.filter((o) => !beforeIds.has(o.id))
    expect(newOps.map((o) => `${o.entityType}:${o.entityId}:${o.op}`).sort()).toEqual(
      [`message:${mId}:delete`, `message_block:${bId}:delete`, `topic_branch:${branchId}:delete`].sort()
    )
    const pendingBeforeSyncBranch = dbA.select().from(schema.syncOutbox).all().length
    setPeer('A', { sqliteA, dbA, sqliteB, dbB })
    activeStore = storeA
    await syncService.sync()
    expect(
      relayOps.filter((r) => r.op.entityType === 'topic_branch' && r.op.entityId === branchId && r.op.op === 'delete')
        .length
    ).toBe(1)
    expect(
      relayOps.filter((r) => r.op.entityType === 'message' && r.op.entityId === mId && r.op.op === 'delete').length
    ).toBe(1)
    expect(
      relayOps.filter((r) => r.op.entityType === 'message_block' && r.op.entityId === bId && r.op.op === 'delete')
        .length
    ).toBe(1)
    expect(relayOps.length).toBeGreaterThanOrEqual(beforeRelayLen + 3)
    expect(relaySeq).toBe(relayOps.length > 0 ? relayOps[relayOps.length - 1].seq : 0)
    void pendingBeforeSyncBranch
    void beforeRelaySeq
    expect(
      relayOps.filter((r) => r.op.entityType === 'message_block' && r.op.entityId === bId && r.op.op === 'upsert')
        .length
    ).toBe(0)
    expect(relayOps.map((r) => r.seq)).toEqual(Array.from({ length: relayOps.length }, (_, i) => i + 1))
    expect(
      dbA
        .select()
        .from(schema.messages)
        .all()
        .find((m) => (m as any).id === anchor)
    ).toBeTruthy()
    expect(
      dbA
        .select()
        .from(schema.topicBranches)
        .all()
        .find((b) => (b as any).id === siblingId)
    ).toBeTruthy()
    setPeer('B', { sqliteA, dbA, sqliteB, dbB })
    activeStore = storeB
    await syncService.sync()
    expect(
      dbB
        .select()
        .from(schema.messages)
        .all()
        .find((m) => (m as any).id === anchor)
    ).toBeTruthy()
    expect(
      dbB
        .select()
        .from(schema.topicBranches)
        .all()
        .find((b) => (b as any).id === branchId)
    ).toBeFalsy()
    expect(
      dbB
        .select()
        .from(schema.topicBranches)
        .all()
        .find((b) => (b as any).id === siblingId)
    ).toBeTruthy()
    expect(
      dbB
        .select()
        .from(schema.messages)
        .all()
        .find((m) => (m as any).id === mId)
    ).toBeFalsy()
    expect(
      dbB
        .select()
        .from(schema.messageBlocks)
        .all()
        .find((b) => (b as any).id === bId)
    ).toBeFalsy()
    const fakeSeq2 = relaySeq + 1
    relaySeq = fakeSeq2
    relayOps.push({
      seq: fakeSeq2,
      op: {
        id: randomUUID(),
        entityType: 'message_block',
        op: 'upsert',
        entityId: bId,
        timestamp: Date.now(),
        deviceId: 'late2',
        payload: {
          id: bId,
          messageId: mId,
          type: 'file',
          content: 'late',
          status: 'success',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          assetIds: [fId]
        },
        seq: fakeSeq2
      }
    })
    await syncService.sync()
    expect(
      dbB
        .select()
        .from(schema.messageBlocks)
        .all()
        .find((b) => (b as any).id === bId)
    ).toBeFalsy()
    relayOps.pop()
    relaySeq -= 1
    setPeer('A', { sqliteA, dbA, sqliteB, dbB })
    activeStore = storeA
    await syncService.sync()
    expect(
      relayOps.filter((r) => r.op.entityType === 'message_block' && r.op.entityId === bId && r.op.op === 'upsert')
        .length
    ).toBe(0)
  }, 30000)

  it('pull mock preserves stored seq and service rejects gap cursor pinned', async () => {
    const topicId = `t-${randomUUID().slice(0, 8)}`
    setPeer('A', { sqliteA, dbA, sqliteB, dbB })
    expect(aggA.ensureTopic(topicId).ok).toBe(true)
    const m0 = `m-${randomUUID().slice(0, 8)}`
    const msg0: any = {
      id: m0,
      topicId,
      role: 'user',
      content: 'gap0',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 0,
      blocks: []
    }
    expect(aggA.appendMessage(topicId, msg0, [] as any).ok).toBe(true)
    const m1 = `m-${randomUUID().slice(0, 8)}`
    const msg1: any = {
      id: m1,
      topicId,
      role: 'user',
      content: 'gap1',
      status: 'success',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sortOrder: 1,
      blocks: []
    }
    expect(aggA.appendMessage(topicId, msg1, [] as any).ok).toBe(true)
    setPeer('A', { sqliteA, dbA, sqliteB, dbB })
    activeStore = storeA
    await syncService.sync()
    expect(relayOps.length).toBeGreaterThanOrEqual(2)
    expect(relayOps.map((r) => r.seq)).toEqual(Array.from({ length: relayOps.length }, (_, i) => i + 1))
    const headSeq = relaySeq
    // simulate gap by removing middle seq
    const gapSeq = 2
    const idx = relayOps.findIndex((r) => r.seq === gapSeq)
    expect(idx).toBeGreaterThanOrEqual(0)
    const removed = relayOps.splice(idx, 1)[0]
    // do NOT adjust relaySeq so head/seq mismatch would be hidden if mock remapped
    setPeer('B', { sqliteA, dbA, sqliteB, dbB })
    activeStore = storeB
    const cursorBefore = Number(
      (
        dbB
          .select()
          .from(schema.syncState)
          .where((await import('drizzle-orm')).eq(schema.syncState.key, 'cursor'))
          .get() as any
      )?.value ?? '0'
    )
    expect(cursorBefore).toBe(0)
    let threw = false
    try {
      await syncService.sync()
    } catch (e) {
      threw = true
      expect(String((e as Error).message)).toMatch(/non-contiguous|gap/)
    }
    expect(threw).toBe(true)
    const cursorAfter = Number(
      (
        dbB
          .select()
          .from(schema.syncState)
          .where((await import('drizzle-orm')).eq(schema.syncState.key, 'cursor'))
          .get() as any
      )?.value ?? '0'
    )
    expect(cursorAfter).toBe(cursorBefore)
    // repair gap and ensure N+1 handoff works
    relayOps.splice(idx, 0, removed)
    expect(relayOps.map((r) => r.seq)).toEqual(Array.from({ length: relayOps.length }, (_, i) => i + 1))
    await syncService.sync()
    const cursorRepaired = Number(
      (
        dbB
          .select()
          .from(schema.syncState)
          .where((await import('drizzle-orm')).eq(schema.syncState.key, 'cursor'))
          .get() as any
      )?.value ?? '0'
    )
    expect(cursorRepaired).toBe(headSeq)
    // stored seq delta baseline check
    expect(relayOps[relayOps.length - 1].seq).toBe(headSeq)
  }, 30000)
})
