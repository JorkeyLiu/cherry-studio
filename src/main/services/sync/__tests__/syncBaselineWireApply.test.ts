/**
 * Wire baseline direct apply adapter (SYNC-DATA-047): strict envelope/digest
 * via shared baselineWire, mapping (messageBlock→message_block,
 * parentMembershipClock+parentId, frames), single merge-core reuse, dense
 * sortOrder local-only, complete manifest/clock/frame fail-closed. No copied
 * LWW rules; no fabricated local diagnostics.
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
    set: (k: string, v: unknown) => configStore.set(k, v)
  },
  ConfigKeys: {}
}))

import {
  COMPLETENESS_COMPLETE,
  computeSyncDigest,
  DIGEST_SCHEME,
  INVENTORY_VERSION,
  ORDER_FRAME_VERSION,
  PAYLOAD_SCHEMA,
  SCOPE,
  WIRE_VERSION
} from '@shared/sync'
import canonicalize from 'canonicalize'

import { chatDbService } from '../../chatDb'
import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { applyWireSyncEnvelopeInTx, mapWireEnvelopeToMergeInput } from '../syncBaselineWireApply'

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

function topicMessageBlockPayload(): Record<string, unknown> {
  const tClock = { timestamp: 10, operationId: 'wtop10' }
  const mClock = { timestamp: 11, operationId: 'wmsg11' }
  const bClock = { timestamp: 12, operationId: 'wblk12' }
  const mMember = { timestamp: 11, operationId: 'wmsg11' }
  const bMember = { timestamp: 12, operationId: 'wblk12' }
  const fTop = { timestamp: 13, operationId: 'wfrm13' }
  const fBlk = { timestamp: 14, operationId: 'wfrm14' }
  return {
    payloadSchema: PAYLOAD_SCHEMA,
    inventoryVersion: INVENTORY_VERSION,
    orderFrameVersion: ORDER_FRAME_VERSION,
    scope: SCOPE,
    topics: [
      {
        id: 'wt1',
        name: 'Wire Topic',
        assistantId: null,
        createdAt: null,
        updatedAt: null,
        deletedAt: null,
        pinned: null,
        prompt: null,
        isNameManuallyEdited: null,
        entityClock: tClock,
        fieldClocks: {
          name: tClock,
          assistantId: tClock,
          createdAt: tClock,
          updatedAt: tClock,
          deletedAt: tClock,
          pinned: tClock,
          prompt: tClock,
          isNameManuallyEdited: tClock
        }
      }
    ],
    messages: [
      {
        id: 'wm1',
        topicId: 'wt1',
        role: 'user',
        content: 'hi',
        status: 'sent',
        askId: null,
        model: null,
        modelId: null,
        assistantId: null,
        createdAt: null,
        updatedAt: null,
        entityClock: mClock,
        fieldClocks: {
          role: mClock,
          content: mClock,
          status: mClock,
          askId: mClock,
          model: mClock,
          modelId: mClock,
          assistantId: mClock,
          createdAt: mClock,
          updatedAt: mClock
        },
        parentMembershipClock: mMember
      }
    ],
    messageBlocks: [
      {
        id: 'wb1',
        messageId: 'wm1',
        type: 'text',
        content: 'body',
        status: 'sent',
        createdAt: null,
        updatedAt: null,
        entityClock: bClock,
        fieldClocks: { type: bClock, content: bClock, status: bClock, createdAt: bClock, updatedAt: bClock },
        parentMembershipClock: bMember
      }
    ],
    tombstones: [],
    orderFrames: [
      {
        frameVersion: ORDER_FRAME_VERSION,
        kind: 'topicMessage',
        parentId: 'wt1',
        orderedChildIds: ['wm1'],
        frameClock: fTop
      },
      {
        frameVersion: ORDER_FRAME_VERSION,
        kind: 'messageBlock',
        parentId: 'wm1',
        orderedChildIds: ['wb1'],
        frameClock: fBlk
      }
    ],
    manifest: {
      payloadSchema: PAYLOAD_SCHEMA,
      inventoryVersion: INVENTORY_VERSION,
      orderFrameVersion: ORDER_FRAME_VERSION,
      scope: SCOPE,
      liveCounts: { topic: 1, message: 1, messageBlock: 1 },
      tombstoneCounts: { topic: 0, message: 0, messageBlock: 0 },
      frameCounts: { topicMessage: 1, messageBlock: 1 },
      completeness: COMPLETENESS_COMPLETE
    }
  }
}

function makeEnvelope(channelId: string, watermark: number, payload: Record<string, unknown>): Record<string, unknown> {
  const digest = computeSyncDigest(payload as never, hashHex)
  return { wireVersion: WIRE_VERSION, channelId, watermark, digestScheme: DIGEST_SCHEME, digest, payload }
}

function makeEnvelopeUnchecked(
  channelId: string,
  watermark: number,
  payload: Record<string, unknown>
): Record<string, unknown> {
  const canonical = (canonicalize as unknown as (v: unknown) => string)(payload)
  const digest = createHash('sha256').update(new TextEncoder().encode(canonical)).digest('hex')
  return { wireVersion: WIRE_VERSION, channelId, watermark, digestScheme: DIGEST_SCHEME, digest, payload }
}

beforeEach(() => {
  configStore.clear()
  sqlite = openInMemory()
  db = drizzle(sqlite, { schema })
  runMigrations(db as never, sqlite)
  ;(chatDbService as unknown as { sqlite: unknown }).sqlite = sqlite
  ;(chatDbService as unknown as { db: unknown }).db = db
})

afterEach(() => {
  try {
    sqlite.close()
  } catch {}
  ;(chatDbService as unknown as { sqlite: unknown }).sqlite = null
  ;(chatDbService as unknown as { db: unknown }).db = null
})

describe('wire direct apply', () => {
  it('merges topic/message/block with frames and dense sortOrder, preserves outbox/applied', () => {
    db.insert(schema.syncOutbox)
      .values({
        id: 'outbox-keep-1',
        entityType: 'topic',
        op: 'upsert',
        entityId: 'local-t',
        timestamp: 1,
        deviceId: 'd1',
        payloadJson: null,
        createdAt: new Date().toISOString()
      })
      .run()
    db.insert(schema.syncApplied).values({ operationId: 'applied-keep-1', appliedAt: new Date().toISOString() }).run()
    const envelope = makeEnvelope('ch-wire', 7, topicMessageBlockPayload())
    let watermark = -1
    db.transaction((tx) => {
      const out = applyWireSyncEnvelopeInTx(tx as never, envelope, { expectedChannelId: 'ch-wire' })
      watermark = out.watermark
    })
    expect(watermark).toBe(7)
    expect(sqlite.prepare('SELECT id FROM topics WHERE id=?').get('wt1')).toBeTruthy()
    expect(sqlite.prepare('SELECT id FROM messages WHERE id=?').get('wm1')).toBeTruthy()
    expect(sqlite.prepare('SELECT id FROM message_blocks WHERE id=?').get('wb1')).toBeTruthy()
    const msg = sqlite.prepare('SELECT sort_order as sortOrder FROM messages WHERE id=?').get('wm1') as {
      sortOrder: number
    }
    const blk = sqlite.prepare('SELECT sort_order as sortOrder FROM message_blocks WHERE id=?').get('wb1') as {
      sortOrder: number
    }
    expect(msg.sortOrder).toBe(0)
    expect(blk.sortOrder).toBe(0)
    expect(
      db
        .select()
        .from(schema.syncOutbox)
        .all()
        .map((r) => r.id)
    ).toContain('outbox-keep-1')
    expect(
      db
        .select()
        .from(schema.syncApplied)
        .all()
        .map((r) => r.operationId)
    ).toContain('applied-keep-1')
    const frames = db.select().from(schema.syncParentOrderFrame).all()
    expect(frames).toHaveLength(2)
  })

  it('channel mismatch fails closed with no writes', () => {
    const envelope = makeEnvelope('ch-other', 3, topicMessageBlockPayload())
    expect(() =>
      db.transaction((tx) => applyWireSyncEnvelopeInTx(tx as never, envelope, { expectedChannelId: 'ch-wire' }))
    ).toThrow(/channel mismatch/)
    expect(sqlite.prepare("SELECT COUNT(*) as c FROM topics WHERE id='wt1'").get() as { c: number }).toMatchObject({
      c: 0
    })
  })

  it('digest mismatch fails closed with no writes', () => {
    const envelope = makeEnvelope('ch-wire', 3, topicMessageBlockPayload())
    envelope['digest'] = '0'.repeat(64)
    expect(() => db.transaction((tx) => applyWireSyncEnvelopeInTx(tx as never, envelope))).toThrow(/digest mismatch/)
    expect(sqlite.prepare("SELECT COUNT(*) as c FROM topics WHERE id='wt1'").get() as { c: number }).toMatchObject({
      c: 0
    })
  })

  it('missing frame fails closed (manifest/closure strict)', () => {
    const payload = topicMessageBlockPayload()
    payload['orderFrames'] = (payload['orderFrames'] as unknown[]).slice(0, 1)
    const envelope = makeEnvelopeUnchecked('ch-wire', 3, payload)
    expect(() => mapWireEnvelopeToMergeInput(envelope)).toThrow()
    expect(sqlite.prepare("SELECT COUNT(*) as c FROM topics WHERE id='wt1'").get() as { c: number }).toMatchObject({
      c: 0
    })
  })

  it('transient status fails closed', () => {
    const payload = topicMessageBlockPayload() as { messages: Array<Record<string, unknown>> }
    payload.messages[0]['status'] = 'streaming'
    const envelope = makeEnvelopeUnchecked('ch-wire', 3, payload as unknown as Record<string, unknown>)
    expect(() => mapWireEnvelopeToMergeInput(envelope)).toThrow()
  })
})
