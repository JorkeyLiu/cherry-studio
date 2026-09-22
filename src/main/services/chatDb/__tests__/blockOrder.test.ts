/**
 * Bounded persistence/order regression — deterministic block order fix.
 *
 * Each block persisted/upserted with an authoritative message.blocks order
 * must receive explicit sortOrder matching that array BEFORE repository
 * normalization, so THINKING remains above MAIN_TEXT across DB reloads,
 * variant switching, and deletion/reload.
 *
 * Tests are deterministic and use IDs whose lexicographic order opposes the
 * desired display order — before the fix, the repository's (sortOrder, id)
 * tie-break would invert THINKING/MAIN_TEXT when sortOrder defaults to 0.
 */

import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')
vi.mock('@main/config', () => ({ DATA_PATH: '/mock/data' }))
vi.mock('../../SpanCacheService', () => ({
  spanCacheService: { cleanTopic: vi.fn().mockResolvedValue(undefined) }
}))

import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'

import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { runMigrations } from '../migration'
import * as schema from '../schema'

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-blockorder-'))
}
function rmrf(dir: string): void {
  realFs.rmSync(dir, { recursive: true, force: true })
}
function openTestDb(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  return db
}
function wrapDrizzle(sqlite: Database.Database): BetterSQLite3Database<typeof schema> {
  return drizzle(sqlite, { schema })
}

describe('blockOrder — bounded persistence/order fix', () => {
  let tmpDir: string
  let sqlite: Database.Database
  let db: BetterSQLite3Database<typeof schema>
  let agg: ChatDbAggregateService

  beforeEach(() => {
    tmpDir = makeTempDir()
    sqlite = openTestDb(realPath.join(tmpDir, 'test.db'))
    db = wrapDrizzle(sqlite)
    runMigrations(db, sqlite)
    agg = new ChatDbAggregateService(db)
  })
  afterEach(() => {
    try {
      sqlite.close()
    } catch {}
    rmrf(tmpDir)
  })

  function okValue<T>(r: { ok: boolean; value?: T; error?: unknown }): T {
    if (!r.ok) throw new Error(`expected ok: ${JSON.stringify((r as any).error)}`)
    return (r as any).value as T
  }

  it('wire/repository round-trip preserves supplied order when IDs oppose lexicographic order (appendMessage)', () => {
    const topicId = 't-append-order'
    const thinkingId = 'b-zzz-thinking'
    const mainTextId = 'b-aaa-main'
    const msgId = 'm-append-1'
    const msgJson: any = {
      id: msgId,
      topicId,
      role: 'assistant',
      content: 'hi',
      status: 'success',
      blocks: [thinkingId, mainTextId]
    }
    const thinkingBlock: any = {
      id: thinkingId,
      messageId: msgId,
      type: 'thinking',
      content: 'thinking content',
      status: 'success'
    }
    const mainBlock: any = {
      id: mainTextId,
      messageId: msgId,
      type: 'main_text',
      content: 'answer',
      status: 'success'
    }
    thinkingBlock.sortOrder = 0
    mainBlock.sortOrder = 0

    const res = agg.appendMessage(topicId, msgJson, [thinkingBlock, mainBlock])
    expect(res.ok).toBe(true)

    const fetched = okValue(agg.fetchMessages(topicId))
    expect(fetched.messages).toHaveLength(1)
    expect(fetched.messages[0].blocks).toEqual([thinkingId, mainTextId])
    expect(fetched.blocks.map((b: any) => b.id)).toEqual([thinkingId, mainTextId])
    const re = okValue(agg.fetchMessages(topicId))
    expect(re.blocks.map((b: any) => b.id)).toEqual([thinkingId, mainTextId])
  })

  it('wire/repository round-trip preserves supplied order on updateMessageAndBlocks (variant switching / re-order)', () => {
    const topicId = 't-update-order'
    const thinkingId = 'b-zzz-thinking'
    const mainTextId = 'b-aaa-main'
    const msgId = 'm-update-1'
    const msgJson: any = { id: msgId, topicId, role: 'assistant', status: 'success', blocks: [thinkingId, mainTextId] }
    const tBlk: any = {
      id: thinkingId,
      messageId: msgId,
      type: 'thinking',
      content: 't',
      status: 'success',
      sortOrder: 0
    }
    const mBlk: any = {
      id: mainTextId,
      messageId: msgId,
      type: 'main_text',
      content: 'm',
      status: 'success',
      sortOrder: 0
    }
    expect(agg.appendMessage(topicId, msgJson, [tBlk, mBlk]).ok).toBe(true)

    const updBlocks: any[] = [
      { id: thinkingId, messageId: msgId, type: 'thinking', content: 't2', status: 'success', sortOrder: 0 },
      { id: mainTextId, messageId: msgId, type: 'main_text', content: 'm2', status: 'success', sortOrder: 0 }
    ]
    const upd = agg.updateMessageAndBlocks(topicId, { id: msgId, blocks: [thinkingId, mainTextId] } as any, updBlocks)
    expect(upd.ok).toBe(true)
    const fetched = okValue(agg.fetchMessages(topicId))
    expect(fetched.messages[0].blocks).toEqual([thinkingId, mainTextId])
    expect(fetched.blocks.map((b: any) => b.id)).toEqual([thinkingId, mainTextId])

    const swapped: any = agg.updateMessageAndBlocks(topicId, { id: msgId, blocks: [mainTextId, thinkingId] } as any, [
      { id: mainTextId, messageId: msgId, type: 'main_text', content: 'm3', status: 'success', sortOrder: 0 },
      { id: thinkingId, messageId: msgId, type: 'thinking', content: 't3', status: 'success', sortOrder: 0 }
    ])
    expect(swapped.ok).toBe(true)
    const afterSwap = okValue(agg.fetchMessages(topicId))
    expect(afterSwap.messages[0].blocks).toEqual([mainTextId, thinkingId])
    expect(afterSwap.blocks.map((b: any) => b.id)).toEqual([mainTextId, thinkingId])

    const restore: any = agg.updateMessageAndBlocks(topicId, { id: msgId, blocks: [thinkingId, mainTextId] } as any, [
      { id: thinkingId, messageId: msgId, type: 'thinking', content: 't4', status: 'success', sortOrder: 0 },
      { id: mainTextId, messageId: msgId, type: 'main_text', content: 'm4', status: 'success', sortOrder: 0 }
    ])
    expect(restore.ok).toBe(true)
    const restored = okValue(agg.fetchMessages(topicId))
    expect(restored.messages[0].blocks).toEqual([thinkingId, mainTextId])
  })

  it('deletion/reload preserves supplied order for survivors (shared boundary, not UI special-case)', () => {
    const topicId = 't-delete-order'
    const thinkingId = 'b-zzz-thinking'
    const mainTextId = 'b-aaa-main'
    const extraId = 'b-mmm-extra'
    const msgId = 'm-del-1'
    const msgJson: any = {
      id: msgId,
      topicId,
      role: 'assistant',
      status: 'success',
      blocks: [thinkingId, mainTextId, extraId]
    }
    const bTh: any = {
      id: thinkingId,
      messageId: msgId,
      type: 'thinking',
      content: 't',
      status: 'success',
      sortOrder: 0
    }
    const bMain: any = {
      id: mainTextId,
      messageId: msgId,
      type: 'main_text',
      content: 'm',
      status: 'success',
      sortOrder: 0
    }
    const bExtra: any = {
      id: extraId,
      messageId: msgId,
      type: 'main_text',
      content: 'e',
      status: 'success',
      sortOrder: 0
    }
    expect(agg.appendMessage(topicId, msgJson, [bTh, bMain, bExtra]).ok).toBe(true)
    let fetched = okValue(agg.fetchMessages(topicId))
    expect(fetched.messages[0].blocks).toEqual([thinkingId, mainTextId, extraId])

    const delRes = agg.updateMessageAndBlocks(
      topicId,
      { id: msgId, blocks: [thinkingId, mainTextId] } as any,
      [],
      [extraId]
    )
    expect(delRes.ok).toBe(true)

    fetched = okValue(agg.fetchMessages(topicId))
    expect(fetched.messages[0].blocks).toEqual([thinkingId, mainTextId])
    expect(fetched.blocks.map((b: any) => b.id)).toEqual([thinkingId, mainTextId])

    const bExtra2: any = {
      id: extraId,
      messageId: msgId,
      type: 'main_text',
      content: 'e2',
      status: 'success',
      sortOrder: 0
    }
    const reAdd = agg.updateMessageAndBlocks(topicId, { id: msgId, blocks: [thinkingId, mainTextId, extraId] } as any, [
      bExtra2
    ])
    expect(reAdd.ok).toBe(true)
    fetched = okValue(agg.fetchMessages(topicId))
    expect(fetched.messages[0].blocks).toEqual([thinkingId, mainTextId, extraId])
  })

  it('preserves handling for block writes that lack an accompanying ordered message block list', () => {
    // Use lex-matching IDs so that the existing tie-break (sortOrder, id)
    // does not invert the desired order when no authoritative list is
    // supplied. This verifies the no-authoritative path is preserved
    // (no crash, no explicit sortOrder assignment via authoritative map)
    // while the authoritative paths above prove deterministic order when
    // IDs oppose lex order.
    const topicId = 't-no-authoritative'
    const msgId = 'm-no-auth-1'
    const b1Id = 'b-aaa-a'
    const b2Id = 'b-zzz-b'
    const msgJson: any = { id: msgId, topicId, role: 'assistant', status: 'success', blocks: [b1Id, b2Id] }
    const b1: any = { id: b1Id, messageId: msgId, type: 'main_text', content: 'one', status: 'success', sortOrder: 0 }
    const b2: any = { id: b2Id, messageId: msgId, type: 'main_text', content: 'two', status: 'success', sortOrder: 0 }
    expect(agg.appendMessage(topicId, msgJson, [b1, b2]).ok).toBe(true)
    let fetched = okValue(agg.fetchMessages(topicId))
    expect(fetched.blocks.map((x: any) => x.id)).toEqual([b1Id, b2Id])

    const updBlocksNoAuth: any[] = [
      { id: b1Id, messageId: msgId, type: 'main_text', content: 'one-updated', status: 'success' },
      { id: b2Id, messageId: msgId, type: 'main_text', content: 'two-updated', status: 'success' }
    ]
    const r1 = agg.updateBlocks(updBlocksNoAuth as any)
    expect(r1.ok).toBe(true)
    fetched = okValue(agg.fetchMessages(topicId))
    // Preserved handling: no authoritative list, so existing tie-break
    // is retained; with lex-matching IDs this still equals desired order.
    expect(fetched.blocks.map((x: any) => x.id)).toEqual([b1Id, b2Id])

    const b3Id = 'b-zzz-c'
    const b3: any = { id: b3Id, messageId: msgId, type: 'main_text', content: 'three', status: 'success' }
    const r2 = agg.bulkAddBlocks([b3] as any)
    expect(r2.ok).toBe(true)
    fetched = okValue(agg.fetchMessages(topicId))
    // Preserved handling: bulkAddBlocks lacks authoritative list, so
    // repository normalization uses (sortOrder, id) tie-break. With incoming
    // sortOrder 0 (default) the new block interleaves lexically among
    // existing 0 entries, not strictly appended — this is the existing
    // preserved behavior, not the deterministic authoritative fix.
    expect(fetched.blocks.map((x: any) => x.id)).toEqual([b1Id, b3Id, b2Id])
  })

  it('updateMessageAndBlocks without blocks field preserves no-op authoritative handling', () => {
    const topicId = 't-no-blocks-field'
    const msgId = 'm-no-blocks-1'
    const b1Id = 'b-zzz-a2'
    const b2Id = 'b-aaa-b2'
    const msgJson: any = { id: msgId, topicId, role: 'assistant', status: 'success', blocks: [b1Id, b2Id] }
    const b1: any = { id: b1Id, messageId: msgId, type: 'thinking', content: 't', status: 'success', sortOrder: 0 }
    const b2: any = { id: b2Id, messageId: msgId, type: 'main_text', content: 'm', status: 'success', sortOrder: 0 }
    expect(agg.appendMessage(topicId, msgJson, [b1, b2]).ok).toBe(true)

    const upd = agg.updateMessageAndBlocks(topicId, { id: msgId } as any, [
      { id: b1Id, messageId: msgId, type: 'thinking', content: 't-new', status: 'success' } as any
    ])
    expect(upd.ok).toBe(true)
    const fetched = okValue(agg.fetchMessages(topicId))
    expect(fetched.messages[0].blocks).toEqual([b1Id, b2Id])
  })
})
