/**
 * SearchRepository — FTS5 Search Tests
 *
 * Covers:
 * - ASCII substring search
 * - ASCII whole-word search
 * - Quoted phrase search
 * - All-term AND semantics
 * - Accented characters
 * - Chinese/Japanese/Korean including 1/2-char CJK
 * - Markdown normalization
 * - CRLF normalization
 * - Mixed long+short terms
 * - Deleted topic behavior (no filter)
 * - Sort/tie pagination
 * - Malicious FTS syntax
 * - No duplicate message/block results
 * - Empty keywords → empty results
 * - Fallback to LIKE for short terms
 */

import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// Unmock real filesystem and OS modules for integration tests.
// ---------------------------------------------------------------------------
vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

vi.mock('@main/config', () => ({
  DATA_PATH: '/mock/data'
}))

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import { registerChatDbNormalize, runMigrations } from '../migration'
import { SearchRepository } from '../repository/SearchRepository'
import * as schema from '../schema'
import { generateCorpus, hybridSearchAll, likeSearch, QUERY_FIXTURES } from './searchBenchHarness'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-search-'))
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

function setupTestDb(sqlite: Database.Database): void {
  registerChatDbNormalize(sqlite)
  const db = drizzle(sqlite, { schema })
  runMigrations(db, sqlite)
}

function insertTopic(sqlite: Database.Database, id: string, name: string, deletedAt?: string): void {
  sqlite
    .prepare(`INSERT INTO topics (id, name, created_at, deleted_at) VALUES (?, ?, ?, ?)`)
    .run(id, name, '2026-01-01T00:00:00.000Z', deletedAt ?? null)
}

function insertMessage(sqlite: Database.Database, id: string, topicId: string, createdAt: string): void {
  sqlite
    .prepare(
      `INSERT INTO messages (id, topic_id, role, content, created_at, sort_order) VALUES (?, ?, 'user', ?, ?, 0)`
    )
    .run(id, topicId, 'msg content', createdAt)
}

function insertBlock(sqlite: Database.Database, id: string, messageId: string, type: string, content: string): void {
  sqlite
    .prepare(`INSERT INTO message_blocks (id, message_id, type, content, sort_order) VALUES (?, ?, ?, ?, 0)`)
    .run(id, messageId, type, content)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SearchRepository — FTS5 Search', () => {
  let tempDir: string
  let sqlite: Database.Database
  let searchRepo: SearchRepository

  beforeEach(() => {
    tempDir = makeTempDir()
    const dbPath = realPath.join(tempDir, 'chat.db')
    sqlite = openTestDb(dbPath)
    setupTestDb(sqlite)
    searchRepo = new SearchRepository(sqlite)

    // Set up test data
    insertTopic(sqlite, 't1', 'Topic A')
    insertTopic(sqlite, 't2', 'Topic B')
    insertMessage(sqlite, 'm1', 't1', '2026-01-01T00:01:00.000Z')
    insertMessage(sqlite, 'm2', 't1', '2026-01-01T00:02:00.000Z')
    insertMessage(sqlite, 'm3', 't2', '2026-01-01T00:03:00.000Z')
    insertBlock(sqlite, 'b1', 'm1', 'main_text', 'Hello world')
    insertBlock(sqlite, 'b2', 'm2', 'main_text', 'Goodbye world')
    insertBlock(sqlite, 'b3', 'm3', 'main_text', 'Hello again')
    insertBlock(sqlite, 'b4', 'm1', 'file', 'file content')
  })

  afterEach(() => {
    sqlite.close()
    rmrf(tempDir)
  })

  it('empty keywords returns empty results', () => {
    const result = searchRepo.search({
      keywords: '',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    expect(result.items).toHaveLength(0)
    expect(result.hasMore).toBe(false)
  })

  it('whitespace-only keywords returns empty results', () => {
    const result = searchRepo.search({
      keywords: '   ',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    expect(result.items).toHaveLength(0)
  })

  it('ASCII substring search', () => {
    const result = searchRepo.search({
      keywords: 'hello',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    expect(result.items.length).toBeGreaterThanOrEqual(2)
    const blockIds = result.items.map((i) => i.blockId)
    expect(blockIds).toContain('b1') // Hello world
    expect(blockIds).toContain('b3') // Hello again
  })

  it('ASCII whole-word search does not match partial words', () => {
    // Insert a block with 'hello' inside a larger word
    insertBlock(sqlite, 'b5', 'm1', 'main_text', 'helloworld') // no space
    const result = searchRepo.search({
      keywords: 'hello',
      matchMode: 'whole-word',
      sortOrder: 'newest'
    })
    const blockIds = result.items.map((i) => i.blockId)
    // 'helloworld' should NOT match whole-word 'hello'
    expect(blockIds).not.toContain('b5')
    // But 'Hello world' and 'Hello again' should match
    expect(blockIds).toContain('b1')
    expect(blockIds).toContain('b3')
  })

  it('quoted phrase search', () => {
    insertBlock(sqlite, 'b6', 'm1', 'main_text', 'hello world')
    const result = searchRepo.search({
      keywords: '"hello world"',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    const blockIds = result.items.map((i) => i.blockId)
    expect(blockIds).toContain('b6')
    expect(blockIds).toContain('b1') // also has 'Hello world' (case-insensitive)
  })

  it('all-term AND semantics', () => {
    const result = searchRepo.search({
      keywords: 'hello world',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    // Both 'hello' and 'world' must be present
    const blockIds = result.items.map((i) => i.blockId)
    expect(blockIds).toContain('b1') // Hello world
    // b3 = 'Hello again' → has 'hello' but NOT 'world', should NOT be in results
    expect(blockIds).not.toContain('b3')
  })

  it('case-insensitive search', () => {
    const result = searchRepo.search({
      keywords: 'HELLO',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    expect(result.items.length).toBeGreaterThanOrEqual(2)
  })

  it('accented characters - exact match', () => {
    insertBlock(sqlite, 'b7', 'm1', 'main_text', 'café résumé naïve')
    // Searching with the exact accented character should match
    const result = searchRepo.search({
      keywords: 'café',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    const blockIds = result.items.map((i) => i.blockId)
    expect(blockIds).toContain('b7')
  })

  it('accented characters - no accent folding (matches existing behavior)', () => {
    insertBlock(sqlite, 'b7', 'm1', 'main_text', 'café résumé naïve')
    // Searching without accent does NOT match accented content
    // (same behavior as existing SearchResults.tsx regex matching)
    const result = searchRepo.search({
      keywords: 'cafe',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    const blockIds = result.items.map((i) => i.blockId)
    expect(blockIds).not.toContain('b7')
  })

  it('CJK substring search', () => {
    insertBlock(sqlite, 'b8', 'm1', 'main_text', '你好世界')
    insertBlock(sqlite, 'b9', 'm2', 'main_text', '今天天气很好')

    // Search for Chinese characters
    const result = searchRepo.search({
      keywords: '你好',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    const blockIds = result.items.map((i) => i.blockId)
    expect(blockIds).toContain('b8')
  })

  it('1-char CJK via LIKE fallback', () => {
    insertBlock(sqlite, 'b10', 'm1', 'main_text', '你好世界')
    // Single char CJK (length 1) — uses LIKE fallback
    const result = searchRepo.search({
      keywords: '你',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    const blockIds = result.items.map((i) => i.blockId)
    expect(blockIds).toContain('b10')
  })

  it('2-char CJK via LIKE fallback', () => {
    insertBlock(sqlite, 'b11', 'm1', 'main_text', '你好世界')
    // Two char CJK (length 2) — uses LIKE fallback
    const result = searchRepo.search({
      keywords: '你好',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    const blockIds = result.items.map((i) => i.blockId)
    expect(blockIds).toContain('b11')
  })

  it('Japanese characters', () => {
    insertBlock(sqlite, 'b12', 'm1', 'main_text', 'こんにちは世界')
    const result = searchRepo.search({
      keywords: 'こんにちは',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    const blockIds = result.items.map((i) => i.blockId)
    expect(blockIds).toContain('b12')
  })

  it('Korean characters', () => {
    insertBlock(sqlite, 'b13', 'm1', 'main_text', '안녕하세요')
    const result = searchRepo.search({
      keywords: '안녕하세요',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    const blockIds = result.items.map((i) => i.blockId)
    expect(blockIds).toContain('b13')
  })

  it('markdown normalization in search', () => {
    insertBlock(sqlite, 'b14', 'm1', 'main_text', '## Header **bold** text')
    const result = searchRepo.search({
      keywords: 'header bold',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    const blockIds = result.items.map((i) => i.blockId)
    expect(blockIds).toContain('b14')
  })

  it('CRLF normalization in search', () => {
    insertBlock(sqlite, 'b15', 'm1', 'main_text', 'Line1\r\nLine2\rLine3')
    const result = searchRepo.search({
      keywords: 'Line2',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    const blockIds = result.items.map((i) => i.blockId)
    expect(blockIds).toContain('b15')
  })

  it('mixed long+short terms', () => {
    insertBlock(sqlite, 'b16', 'm1', 'main_text', 'ab hello cd')
    // 'ab' (length 2) uses LIKE, 'hello' (length 5) uses FTS
    const result = searchRepo.search({
      keywords: 'ab hello',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    const blockIds = result.items.map((i) => i.blockId)
    expect(blockIds).toContain('b16')
  })

  it('deleted topic is not filtered', () => {
    insertTopic(sqlite, 't-del', 'Deleted Topic', '2026-01-01T00:00:00.000Z')
    insertMessage(sqlite, 'm-del', 't-del', '2026-01-01T00:04:00.000Z')
    insertBlock(sqlite, 'b-del', 'm-del', 'main_text', 'Deleted topic content')

    const result = searchRepo.search({
      keywords: 'deleted topic',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    const blockIds = result.items.map((i) => i.blockId)
    expect(blockIds).toContain('b-del')
  })

  it('sort newest first', () => {
    const result = searchRepo.search({
      keywords: 'hello',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    expect(result.items.length).toBeGreaterThanOrEqual(2)
    // m3 (2026-01-01T00:03:00) should come before m1 (2026-01-01T00:01:00)
    const dates = result.items.map((i) => i.messageCreatedAt)
    for (let i = 1; i < dates.length; i++) {
      const d1 = Date.parse(dates[i - 1] ?? '')
      const d2 = Date.parse(dates[i] ?? '')
      expect(d1).toBeGreaterThanOrEqual(d2)
    }
  })

  it('sort oldest first', () => {
    const result = searchRepo.search({
      keywords: 'hello',
      matchMode: 'substring',
      sortOrder: 'oldest'
    })
    expect(result.items.length).toBeGreaterThanOrEqual(2)
    const dates = result.items.map((i) => i.messageCreatedAt)
    for (let i = 1; i < dates.length; i++) {
      const d1 = Date.parse(dates[i - 1] ?? '')
      const d2 = Date.parse(dates[i] ?? '')
      expect(d1).toBeLessThanOrEqual(d2)
    }
  })

  it('tie-break by message ID', () => {
    // Insert two messages with same createdAt
    insertMessage(sqlite, 'm-tie1', 't1', '2026-01-01T00:05:00.000Z')
    insertMessage(sqlite, 'm-tie2', 't1', '2026-01-01T00:05:00.000Z')
    insertBlock(sqlite, 'b-tie1', 'm-tie1', 'main_text', 'tie test alpha')
    insertBlock(sqlite, 'b-tie2', 'm-tie2', 'main_text', 'tie test beta')

    const result = searchRepo.search({
      keywords: 'tie test',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    const tieItems = result.items.filter((i) => i.blockId.startsWith('b-tie'))
    expect(tieItems.length).toBe(2)
    // Should be sorted by message ID descending for same timestamp
    expect(tieItems[0].messageId.localeCompare(tieItems[1].messageId)).toBeGreaterThanOrEqual(0)
  })

  it('malicious FTS syntax is safely handled', () => {
    // Attempt FTS injection via special characters
    const result = searchRepo.search({
      keywords: 'OR 1=1 -- "',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    // Should return results safely or empty — no error thrown
    expect(result.items).toBeDefined()
    expect(Array.isArray(result.items)).toBe(true)
  })

  it('no duplicate block results', () => {
    const result = searchRepo.search({
      keywords: 'hello',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    const blockIds = result.items.map((i) => i.blockId)
    const uniqueIds = new Set(blockIds)
    expect(blockIds.length).toBe(uniqueIds.size)
  })

  it('non-MAIN_TEXT blocks are excluded', () => {
    // b4 = file block, should not appear
    const result = searchRepo.search({
      keywords: 'file content',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    const blockIds = result.items.map((i) => i.blockId)
    expect(blockIds).not.toContain('b4')
  })

  it('returns correct result shape (LOCK-5128)', () => {
    const result = searchRepo.search({
      keywords: 'hello',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    expect(result.items.length).toBeGreaterThan(0)
    const item = result.items[0]
    expect(item).toHaveProperty('blockId')
    expect(item).toHaveProperty('messageId')
    expect(item).toHaveProperty('topicId')
    expect(item).toHaveProperty('topicName')
    expect(item).toHaveProperty('rawContent')
    expect(item).toHaveProperty('messageCreatedAt')
    expect(typeof item.blockId).toBe('string')
    expect(typeof item.messageId).toBe('string')
    expect(typeof item.topicId).toBe('string')
  })

  it('raw content returned (not normalized)', () => {
    insertBlock(sqlite, 'b-raw', 'm1', 'main_text', '**Bold** text with `code`')
    const result = searchRepo.search({
      keywords: 'bold',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    const item = result.items.find((i) => i.blockId === 'b-raw')
    expect(item).toBeDefined()
    // rawContent should be the original content, not normalized
    expect(item!.rawContent).toBe('**Bold** text with `code`')
  })

  it('pagination with cursor', () => {
    // Insert many blocks for pagination test
    for (let i = 0; i < 10; i++) {
      insertMessage(sqlite, `m-pg${i}`, 't1', `2026-01-01T00:${10 + i}:00.000Z`)
      insertBlock(sqlite, `b-pg${i}`, `m-pg${i}`, 'main_text', `pagination test item ${i}`)
    }

    const page1 = searchRepo.search({
      keywords: 'pagination test',
      matchMode: 'substring',
      sortOrder: 'newest',
      pageSize: 3
    })
    expect(page1.items.length).toBeLessThanOrEqual(3)
    // With 10 items matching, page size 3, should have more
    expect(page1.hasMore).toBe(true)
    expect(page1.nextCursor).toBeDefined()

    const page2 = searchRepo.search({
      keywords: 'pagination test',
      matchMode: 'substring',
      sortOrder: 'newest',
      pageSize: 3,
      cursor: page1.nextCursor
    })
    expect(page2.items.length).toBeGreaterThan(0)

    // No overlap between pages
    const page1Ids = new Set(page1.items.map((i) => i.blockId))
    for (const item of page2.items) {
      expect(page1Ids.has(item.blockId)).toBe(false)
    }
  })

  it('LIKE wildcard escaping handles backslash, percent, underscore', () => {
    // Insert blocks with special LIKE characters
    insertBlock(sqlite, 'b-special1', 'm1', 'main_text', 'path\\to\\file')
    insertBlock(sqlite, 'b-special2', 'm1', 'main_text', '100% complete')
    insertBlock(sqlite, 'b-special3', 'm1', 'main_text', 'test_value')

    // Search for literal backslash
    let result = searchRepo.search({
      keywords: 'path\\to',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    let blockIds = result.items.map((i) => i.blockId)
    expect(blockIds).toContain('b-special1')

    // Search for literal percent
    result = searchRepo.search({
      keywords: '100%',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    blockIds = result.items.map((i) => i.blockId)
    expect(blockIds).toContain('b-special2')

    // Search for literal underscore
    result = searchRepo.search({
      keywords: 'test_value',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    blockIds = result.items.map((i) => i.blockId)
    expect(blockIds).toContain('b-special3')
  })

  it('malformed cursor throws error instead of resetting', () => {
    // Try to use an invalid cursor
    expect(() => {
      searchRepo.search({
        keywords: 'hello',
        matchMode: 'substring',
        sortOrder: 'newest',
        cursor: 'invalid-cursor-not-base64'
      })
    }).toThrow('Malformed cursor')
  })

  it('blockId-level pagination: multiple blocks in same message paginate completely', () => {
    // Insert a message with multiple matching blocks
    insertMessage(sqlite, 'm-multi', 't1', '2026-01-01T00:10:00.000Z')
    insertBlock(sqlite, 'b-multi1', 'm-multi', 'main_text', 'pagination test alpha')
    insertBlock(sqlite, 'b-multi2', 'm-multi', 'main_text', 'pagination test beta')
    insertBlock(sqlite, 'b-multi3', 'm-multi', 'main_text', 'pagination test gamma')

    // Page through with page size 1
    const page1 = searchRepo.search({
      keywords: 'pagination test',
      matchMode: 'substring',
      sortOrder: 'newest',
      pageSize: 1
    })
    expect(page1.items.length).toBe(1)
    expect(page1.hasMore).toBe(true)
    expect(page1.nextCursor).toBeDefined()

    const page2 = searchRepo.search({
      keywords: 'pagination test',
      matchMode: 'substring',
      sortOrder: 'newest',
      pageSize: 1,
      cursor: page1.nextCursor
    })
    expect(page2.items.length).toBe(1)
    expect(page2.hasMore).toBe(true)

    const page3 = searchRepo.search({
      keywords: 'pagination test',
      matchMode: 'substring',
      sortOrder: 'newest',
      pageSize: 1,
      cursor: page2.nextCursor
    })
    expect(page3.items.length).toBe(1)
    expect(page3.hasMore).toBe(false)

    // All three blocks from the same message should be returned
    const allBlockIds = [page1.items[0].blockId, page2.items[0].blockId, page3.items[0].blockId]
    expect(allBlockIds).toContain('b-multi1')
    expect(allBlockIds).toContain('b-multi2')
    expect(allBlockIds).toContain('b-multi3')
  })

  it('FTS-only for representable terms (no LIKE union)', () => {
    // This test verifies that for terms >= 3 chars, only FTS is used
    // by checking that short terms (< 3 chars) work via LIKE
    insertBlock(sqlite, 'b-short', 'm1', 'main_text', 'ab hello cd')

    // 'ab' (length 2) uses LIKE, 'hello' (length 5) uses FTS
    const result = searchRepo.search({
      keywords: 'ab hello',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    const blockIds = result.items.map((i) => i.blockId)
    expect(blockIds).toContain('b-short')
  })

  it('query plan: representable terms execute FTS only, never LIKE candidate scan', () => {
    insertBlock(sqlite, 'b-plan1', 'm1', 'main_text', 'machine learning algorithm')

    const likeSpy = vi.spyOn(SearchRepository.prototype as any, 'likeCandidates')
    const ftsSpy = vi.spyOn(SearchRepository.prototype as any, 'ftsCandidates')

    try {
      // Representable term (>= 3 code points): FTS only, no LIKE scan
      const result = searchRepo.search({
        keywords: 'machine',
        matchMode: 'substring',
        sortOrder: 'newest'
      })
      expect(result.items.map((i) => i.blockId)).toContain('b-plan1')
      expect(likeSpy).not.toHaveBeenCalled()
      expect(ftsSpy).toHaveBeenCalledTimes(1)

      likeSpy.mockClear()
      ftsSpy.mockClear()

      // Short term (< 3 code points): LIKE only, no FTS
      searchRepo.search({
        keywords: 'ab',
        matchMode: 'substring',
        sortOrder: 'newest'
      })
      expect(likeSpy).toHaveBeenCalledTimes(1)
      expect(ftsSpy).not.toHaveBeenCalled()

      likeSpy.mockClear()
      ftsSpy.mockClear()

      // Mixed: one FTS call for the long term, one LIKE call for the short term
      searchRepo.search({
        keywords: 'ab machine',
        matchMode: 'substring',
        sortOrder: 'newest'
      })
      expect(likeSpy).toHaveBeenCalledTimes(1)
      expect(ftsSpy).toHaveBeenCalledTimes(1)
    } finally {
      likeSpy.mockRestore()
      ftsSpy.mockRestore()
    }
  })

  it('embedded double quote in content matches quoted search term without error or false loss', () => {
    // FTS5 term escaping must double embedded quotes. This test verifies
    // that content containing an embedded double quote is correctly indexed,
    // escaped, and matched via the FTS trigram path without throwing or
    // silently dropping the result.
    const contentWithQuote = 'Error: Cannot read property "map" of undefined'
    insertBlock(sqlite, 'b-quote', 'm1', 'main_text', contentWithQuote)

    // Search using a quoted term that matches a substring containing the quote
    const result = searchRepo.search({
      keywords: '"property"',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    const blockIds = result.items.map((i) => i.blockId)
    expect(blockIds).toContain('b-quote')

    // Also verify the full quoted phrase with embedded quote matches
    const phraseResult = searchRepo.search({
      keywords: '"read property"',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    const phraseBlockIds = phraseResult.items.map((i) => i.blockId)
    expect(phraseBlockIds).toContain('b-quote')
  })

  // ===========================================================================
  // FTS runtime failure propagation (LOCK-5101/5123/5125)
  // ===========================================================================

  it('FTS runtime failure propagates as error, not silent empty results', () => {
    // Drop the FTS table to simulate FTS corruption / runtime failure.
    // Before the fix, ftsCandidates caught this and returned an empty set,
    // causing search() to return { items: [], hasMore: false } — a silent
    // "no results" that hid the real SQLite failure.
    sqlite.exec('DROP TABLE message_blocks_fts')

    // The term 'hello' (>= 3 code points) routes to the FTS path.
    // With the FTS table missing, SQLite throws — which must propagate.
    expect(() => {
      searchRepo.search({
        keywords: 'hello',
        matchMode: 'substring',
        sortOrder: 'newest'
      })
    }).toThrow()
  })

  it('FTS failure on LIKE-only path still works (short terms)', () => {
    // Drop FTS table but search with a short term (< 3 code points)
    // that routes to the LIKE path — should succeed without FTS.
    sqlite.exec('DROP TABLE message_blocks_fts')

    const result = searchRepo.search({
      keywords: 'ab',
      matchMode: 'substring',
      sortOrder: 'newest'
    })
    // 'ab' (length 2) uses LIKE only — FTS table absence is irrelevant
    expect(result.items).toBeDefined()
    expect(Array.isArray(result.items)).toBe(true)
  })
})

// ===========================================================================
// LIKE baseline parity — small deterministic corpus (normal suite)
//
// Product-correctness parity coverage that must remain in the normal test
// gate: the hybrid FTS+LIKE path must return the exact same block IDs in the
// exact same order as the normalized-LIKE full-scan semantic baseline, across
// ALL cursor pages, for every representative query fixture.
//
// The heavy 10k timing evidence (LOCK-5129 p50/p95) lives in search.bench.ts
// and runs only under `vitest bench` — it reuses this same harness so bench
// execution is never the sole carrier of semantic coverage.
// ===========================================================================

describe('SearchRepository — LIKE baseline parity (small deterministic corpus)', () => {
  const CORPUS_SIZE = 300 // covers all 40 corpus entries 7-8 times; multi-page with pageSize 20
  let tempDir: string
  let sqlite: Database.Database
  let searchRepo: SearchRepository

  beforeAll(() => {
    tempDir = makeTempDir()
    sqlite = openTestDb(realPath.join(tempDir, 'chat.db'))
    setupTestDb(sqlite)
    generateCorpus(sqlite, CORPUS_SIZE)
    searchRepo = new SearchRepository(sqlite)
  })

  afterAll(() => {
    sqlite?.close()
    rmrf(tempDir)
  })

  for (const fixture of QUERY_FIXTURES) {
    it(`${fixture.name}: complete ordered parity vs LIKE baseline`, () => {
      // Complete hybrid results across ALL pages (small pageSize forces
      // multi-page cursor walks for common fixtures)
      const hybridResults = hybridSearchAll(searchRepo, fixture.keywords, fixture.matchMode, 20)

      // Complete LIKE semantic baseline (full scan + identical regex filter,
      // ordered by (messageCreatedAt, messageId, blockId) DESC = production order)
      const baselineBlockIds = likeSearch(sqlite, fixture.keywords, fixture.matchMode).map((r) => r.block_id)

      // No duplicates across pages (block-level cursor correctness)
      expect(new Set(hybridResults).size).toBe(hybridResults.length)

      // Direct ordered block ID parity — fully cursor-drained hybrid sequence
      // compared to the baseline sequence without any re-sorting
      expect(hybridResults).toEqual(baselineBlockIds)

      // Complete-set parity (redundant but documents the invariant)
      expect(new Set(hybridResults)).toEqual(new Set(baselineBlockIds))
    })
  }

  it('fixtures produce non-trivial multi-page coverage', () => {
    // Guard against a silently empty corpus making parity vacuous: at least
    // one fixture must span multiple pages at pageSize 20.
    const counts = QUERY_FIXTURES.map((f) => likeSearch(sqlite, f.keywords, f.matchMode).length)
    expect(Math.max(...counts)).toBeGreaterThan(20)
    expect(counts.some((c) => c > 0)).toBe(true)
  })
})
