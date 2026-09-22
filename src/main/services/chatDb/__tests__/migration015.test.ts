/**
 * Migration 015_thinking_block_order_repair:
 * - Idempotent compatibility repair for inverted THINKING/MAIN_TEXT order
 * - Product decision: for assistant message with exactly two blocks consisting
 *   of exactly one THINKING and one MAIN_TEXT, canonical order is THINKING then MAIN_TEXT
 * - Repair only rows whose current authoritative order (sort_order ASC, id ASC) is MAIN_TEXT then THINKING
 * - Skip any other block count/type, tools/citations/images/etc, already-correct pairs
 * - Atomically updates message_blocks.sort_order to 0/1; message.blocks reconstructed from authority
 * - Registry count 15, idempotent, upgrade preserves rows, focused scenarios
 */
import * as realFs from 'node:fs'

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')
vi.mock('@main/config', () => ({ DATA_PATH: '/tmp' }))
vi.mock('../../SpanCacheService', () => ({
  spanCacheService: { cleanTopic: vi.fn().mockResolvedValue(undefined) }
}))

import { ChatDbAggregateService } from '../ChatDbAggregateService'
import { MIGRATIONS, runMigrations } from '../migration'
import * as schema from '../schema'

let sqlite: Database.Database
let tempDirs: string[] = []

function openDb(): Database.Database {
  const s = new Database(':memory:')
  s.pragma('journal_mode = WAL')
  s.pragma('foreign_keys = ON')
  return s
}

function insertTopic(id: string): void {
  sqlite
    .prepare(`INSERT INTO topics (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
    .run(id, 't', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
}
function insertMessage(id: string, topicId: string): void {
  sqlite
    .prepare(
      `INSERT INTO messages (id, topic_id, role, content, status, sort_order, extra) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, topicId, 'assistant', null, 'success', 0, null)
}
function insertMessageWithRole(id: string, topicId: string, role: string): void {
  sqlite
    .prepare(
      `INSERT INTO messages (id, topic_id, role, content, status, sort_order, extra) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, topicId, role, null, 'success', 0, null)
}
function insertBlock(id: string, messageId: string, type: string, sortOrder: number): void {
  sqlite
    .prepare(`INSERT INTO message_blocks (id, message_id, type, content, sort_order, extra) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, messageId, type, `${type}-content`, sortOrder, null)
}
function fetchBlockOrders(messageId: string): Array<{ id: string; type: string; sort_order: number }> {
  return sqlite
    .prepare(`SELECT id, type, sort_order FROM message_blocks WHERE message_id=? ORDER BY sort_order ASC, id ASC`)
    .all(messageId) as any
}
function fetchRawOrders(messageId: string): Array<{ id: string; sort_order: number }> {
  return sqlite.prepare(`SELECT id, sort_order FROM message_blocks WHERE message_id=?`).all(messageId) as any
}

beforeEach(() => {
  sqlite = openDb()
  tempDirs = []
})
afterEach(() => {
  try {
    sqlite.close()
  } catch {}
  for (const dir of tempDirs) {
    try {
      realFs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

describe('015_thinking_block_order_repair', () => {
  it('is registered as 15th migration with correct repair DDL and history preserved', () => {
    expect(MIGRATIONS.length).toBe(15)
    expect(MIGRATIONS[14].key).toBe('015_thinking_block_order_repair')
    const joined = MIGRATIONS[14].sql.join(' ')
    expect(joined).toContain('UPDATE message_blocks')
    expect(joined).toContain("type = 'thinking'")
    expect(joined).toContain("type = 'main_text'")
    expect(joined).toContain('ROW_NUMBER() OVER (PARTITION BY message_id ORDER BY sort_order ASC, id ASC)')
    expect(joined).toContain('COUNT(*) = 2')
    expect(joined).toContain("SUM(CASE WHEN type = 'thinking'")
    expect(joined).toContain("SUM(CASE WHEN type = 'main_text'")
    expect(joined).toContain("r1.type = 'main_text' AND r2.type = 'thinking'")
    expect(joined).toContain('sort_order = CASE')
    expect(joined).toContain('JOIN messages')
    expect(joined).toContain("role = 'assistant'")
    // History not rewritten
    expect(MIGRATIONS[13].key).toBe('014_sync_resend_attempt')
    expect(MIGRATIONS[12].key).toBe('013_sync_stable_replace_register')
  })

  it('fresh database applies 15 migrations and empty DB is no-op', () => {
    const db = drizzle(sqlite, { schema })
    const applied = runMigrations(db as never, sqlite)
    expect(applied).toBe(15)
    // No blocks, no change, second run is no-op
    const second = runMigrations(db as never, sqlite)
    expect(second).toBe(0)
  })

  it('upgrade from pre-015 keeps existing rows and adds repair', () => {
    const db = drizzle(sqlite, { schema })
    runMigrations(db as never, sqlite)
    sqlite.prepare(`DELETE FROM migration_state WHERE key='015_thinking_block_order_repair'`).run()
    // Simulate existing rows before repair
    insertTopic('t-pre015')
    insertMessage('m-pre015', 't-pre015')
    // Correct pair should survive upgrade unchanged
    insertBlock('b-th-correct', 'm-pre015', 'thinking', 0)
    insertBlock('b-main-correct', 'm-pre015', 'main_text', 1)
    const applied = runMigrations(db as never, sqlite)
    expect(applied).toBe(1)
    const orders = fetchBlockOrders('m-pre015')
    expect(orders.map((r) => r.id)).toEqual(['b-th-correct', 'b-main-correct'])
    expect(orders[0].sort_order).toBe(0)
    expect(orders[1].sort_order).toBe(1)
  })

  it('repairs lex-opposed IDs with tied 0/0 (thinkingId > mainTextId) via authoritative sort_order+id', () => {
    const db = drizzle(sqlite, { schema })
    runMigrations(db as never, sqlite)
    sqlite.prepare(`DELETE FROM migration_state WHERE key='015_thinking_block_order_repair'`).run()
    insertTopic('t-lex')
    insertMessage('m-lex', 't-lex')
    const thinkingId = 'b-zzz-thinking'
    const mainId = 'b-aaa-main'
    // Both 0, lex order makes main first -> inverted
    insertBlock(thinkingId, 'm-lex', 'thinking', 0)
    insertBlock(mainId, 'm-lex', 'main_text', 0)
    let ordered = fetchBlockOrders('m-lex')
    expect(ordered[0].id).toBe(mainId)
    expect(ordered[1].id).toBe(thinkingId)

    const applied = runMigrations(db as never, sqlite)
    expect(applied).toBe(1)

    ordered = fetchBlockOrders('m-lex')
    expect(ordered.map((r) => r.id)).toEqual([thinkingId, mainId])
    expect(ordered[0].sort_order).toBe(0)
    expect(ordered[1].sort_order).toBe(1)
    // Aggregate reconstruction: message.blocks reflects repaired authority
    const agg = new ChatDbAggregateService(drizzle(sqlite, { schema }) as any)
    const res = agg.fetchMessages('t-lex') as any
    expect(res.ok).toBe(true)
    expect(res.value.messages[0].blocks).toEqual([thinkingId, mainId])
  })

  it('repairs already normalized dense 0/1 legacy inversion (main 0, thinking 1)', () => {
    const db = drizzle(sqlite, { schema })
    runMigrations(db as never, sqlite)
    sqlite.prepare(`DELETE FROM migration_state WHERE key='015_thinking_block_order_repair'`).run()
    insertTopic('t-dense')
    insertMessage('m-dense', 't-dense')
    const thinkingId = 'b-th-dense'
    const mainId = 'b-main-dense'
    insertBlock(mainId, 'm-dense', 'main_text', 0)
    insertBlock(thinkingId, 'm-dense', 'thinking', 1)
    let ordered = fetchBlockOrders('m-dense')
    expect(ordered[0].type).toBe('main_text')
    expect(ordered[1].type).toBe('thinking')

    const applied = runMigrations(db as never, sqlite)
    expect(applied).toBe(1)

    ordered = fetchBlockOrders('m-dense')
    expect(ordered.map((r) => r.type)).toEqual(['thinking', 'main_text'])
    expect(ordered[0].id).toBe(thinkingId)
    expect(ordered[0].sort_order).toBe(0)
    expect(ordered[1].id).toBe(mainId)
    expect(ordered[1].sort_order).toBe(1)

    // idempotent second run no-op
    const second = runMigrations(db as never, sqlite)
    expect(second).toBe(0)
    const afterSecond = fetchBlockOrders('m-dense')
    expect(afterSecond).toEqual(ordered)
  })

  it('idempotent second run preserves repaired rows and marker', () => {
    const db = drizzle(sqlite, { schema })
    runMigrations(db as never, sqlite)
    sqlite.prepare(`DELETE FROM migration_state WHERE key='015_thinking_block_order_repair'`).run()
    insertTopic('t-idem')
    insertMessage('m-idem', 't-idem')
    insertBlock('b-main-idem', 'm-idem', 'main_text', 0)
    insertBlock('b-th-idem', 'm-idem', 'thinking', 1)
    expect(runMigrations(db as never, sqlite)).toBe(1)
    const first = fetchRawOrders('m-idem').sort((a, b) => a.sort_order - b.sort_order)
    // Second explicit re-run without deleting marker should be no-op
    expect(runMigrations(db as never, sqlite)).toBe(0)
    const second = fetchRawOrders('m-idem').sort((a, b) => a.sort_order - b.sort_order)
    expect(second).toEqual(first)
    // Delete marker and re-apply: still idempotent (no further change because already correct)
    sqlite.prepare(`DELETE FROM migration_state WHERE key='015_thinking_block_order_repair'`).run()
    expect(runMigrations(db as never, sqlite)).toBe(1)
    const third = fetchRawOrders('m-idem').sort((a, b) => a.sort_order - b.sort_order)
    expect(third).toEqual(first)
  })

  it('skips already-correct pair (thinking 0, main 1) no-op', () => {
    const db = drizzle(sqlite, { schema })
    runMigrations(db as never, sqlite)
    sqlite.prepare(`DELETE FROM migration_state WHERE key='015_thinking_block_order_repair'`).run()
    insertTopic('t-correct')
    insertMessage('m-correct', 't-correct')
    const thinkingId = 'b-th-ok'
    const mainId = 'b-main-ok'
    insertBlock(thinkingId, 'm-correct', 'thinking', 0)
    insertBlock(mainId, 'm-correct', 'main_text', 1)
    const before = fetchRawOrders('m-correct')
    const applied = runMigrations(db as never, sqlite)
    expect(applied).toBe(1)
    const after = fetchRawOrders('m-correct')
    // Sort by id for stable compare, but sort_order values unchanged
    expect(after.sort((a, b) => a.id.localeCompare(b.id))).toEqual(before.sort((a, b) => a.id.localeCompare(b.id)))
    const ordered = fetchBlockOrders('m-correct')
    expect(ordered.map((r) => r.id)).toEqual([thinkingId, mainId])
    expect(ordered[0].sort_order).toBe(0)
    expect(ordered[1].sort_order).toBe(1)
  })

  it('skips complex multi-block and other type combos no-op', () => {
    const db = drizzle(sqlite, { schema })
    runMigrations(db as never, sqlite)
    sqlite.prepare(`DELETE FROM migration_state WHERE key='015_thinking_block_order_repair'`).run()
    // 3 blocks: thinking + main_text + tool -> skip
    insertTopic('t-complex')
    insertMessage('m-3blocks', 't-complex')
    insertBlock('b-th-3', 'm-3blocks', 'thinking', 0)
    insertBlock('b-main-3', 'm-3blocks', 'main_text', 1)
    insertBlock('b-tool-3', 'm-3blocks', 'tool', 2)
    // 2 blocks but tool+thinking -> skip
    insertMessage('m-tool-th', 't-complex')
    insertBlock('b-th-tool', 'm-tool-th', 'thinking', 0)
    insertBlock('b-tool-only', 'm-tool-th', 'tool', 1)
    // 2 blocks both main_text -> skip
    insertMessage('m-2main', 't-complex')
    insertBlock('b-main-a', 'm-2main', 'main_text', 0)
    insertBlock('b-main-b', 'm-2main', 'main_text', 1)
    // 2 blocks citation+main -> skip
    insertMessage('m-cite', 't-complex')
    insertBlock('b-cite', 'm-cite', 'citation', 0)
    insertBlock('b-main-cite', 'm-cite', 'main_text', 1)
    // 2 blocks thinking+image -> skip
    insertMessage('m-img', 't-complex')
    insertBlock('b-th-img', 'm-img', 'thinking', 0)
    insertBlock('b-img', 'm-img', 'image', 1)
    // inverted but with count 3 should not be repaired even though first two are inverted? Already covered by count !=2
    const beforeOrders = new Map<string, any[]>()
    for (const mid of ['m-3blocks', 'm-tool-th', 'm-2main', 'm-cite', 'm-img']) {
      beforeOrders.set(mid, fetchRawOrders(mid))
    }
    const applied = runMigrations(db as never, sqlite)
    expect(applied).toBe(1)
    for (const mid of ['m-3blocks', 'm-tool-th', 'm-2main', 'm-cite', 'm-img']) {
      const after = fetchRawOrders(mid)
      const before = beforeOrders.get(mid)!
      expect(after.sort((a, b) => a.id.localeCompare(b.id))).toEqual(before.sort((a, b) => a.id.localeCompare(b.id)))
    }
    // Verify authoritative orders unchanged for 3-block message (remains thinking, main, tool)
    const threeOrdered = fetchBlockOrders('m-3blocks')
    expect(threeOrdered.map((r) => r.id)).toEqual(['b-th-3', 'b-main-3', 'b-tool-3'])
  })

  it('preserves ChatDbAggregateService authoritative-write ordering fix for new writes after migration', () => {
    const db = drizzle(sqlite, { schema })
    runMigrations(db as never, sqlite)
    const agg = new ChatDbAggregateService(db as any)
    const topicId = 't-agg-fix'
    const thinkingId = 'b-zzz-thinking-agg'
    const mainId = 'b-aaa-main-agg'
    const msgId = 'm-agg-1'
    const msgJson: any = { id: msgId, topicId, role: 'assistant', status: 'success', blocks: [thinkingId, mainId] }
    const tBlk: any = {
      id: thinkingId,
      messageId: msgId,
      type: 'thinking',
      content: 't',
      status: 'success',
      sortOrder: 0
    }
    const mBlk: any = { id: mainId, messageId: msgId, type: 'main_text', content: 'm', status: 'success', sortOrder: 0 }
    const res = agg.appendMessage(topicId, msgJson, [tBlk, mBlk])
    expect(res.ok).toBe(true)
    const fetched = (agg.fetchMessages(topicId) as any).value
    expect(fetched.messages[0].blocks).toEqual([thinkingId, mainId])
    expect(fetched.blocks.map((b: any) => b.id)).toEqual([thinkingId, mainId])
  })

  it('does not repair inverted user-role message — negative regression (assistant-only constraint)', () => {
    const db = drizzle(sqlite, { schema })
    runMigrations(db as never, sqlite)
    sqlite.prepare(`DELETE FROM migration_state WHERE key='015_thinking_block_order_repair'`).run()
    insertTopic('t-user-neg')
    // Inverted pair on user message (role='user' should NOT be repaired)
    insertMessageWithRole('m-user-neg', 't-user-neg', 'user')
    const thinkingId = 'b-th-user-neg'
    const mainId = 'b-main-user-neg'
    insertBlock(mainId, 'm-user-neg', 'main_text', 0)
    insertBlock(thinkingId, 'm-user-neg', 'thinking', 1)
    let ordered = fetchBlockOrders('m-user-neg')
    expect(ordered[0].type).toBe('main_text')
    expect(ordered[1].type).toBe('thinking')
    const before = fetchRawOrders('m-user-neg').sort((a, b) => a.id.localeCompare(b.id))
    // Also insert a control assistant inverted pair that SHOULD be repaired in the same run
    insertMessageWithRole('m-assistant-ctrl', 't-user-neg', 'assistant')
    const aThinkingId = 'b-th-ctrl'
    const aMainId = 'b-main-ctrl'
    insertBlock(aMainId, 'm-assistant-ctrl', 'main_text', 0)
    insertBlock(aThinkingId, 'm-assistant-ctrl', 'thinking', 1)

    const applied = runMigrations(db as never, sqlite)
    expect(applied).toBe(1)

    // User message remains inverted / unchanged
    ordered = fetchBlockOrders('m-user-neg')
    expect(ordered.map((r) => r.id)).toEqual([mainId, thinkingId])
    expect(ordered.map((r) => r.type)).toEqual(['main_text', 'thinking'])
    const afterUser = fetchRawOrders('m-user-neg').sort((a, b) => a.id.localeCompare(b.id))
    expect(afterUser).toEqual(before)
    expect(afterUser.find((r) => r.id === thinkingId)!.sort_order).toBe(1)
    expect(afterUser.find((r) => r.id === mainId)!.sort_order).toBe(0)

    // Assistant control is repaired to thinking=0, main=1
    const assistantOrdered = fetchBlockOrders('m-assistant-ctrl')
    expect(assistantOrdered.map((r) => r.type)).toEqual(['thinking', 'main_text'])
    expect(assistantOrdered[0].id).toBe(aThinkingId)
    expect(assistantOrdered[0].sort_order).toBe(0)
    expect(assistantOrdered[1].id).toBe(aMainId)
    expect(assistantOrdered[1].sort_order).toBe(1)
  })
})
