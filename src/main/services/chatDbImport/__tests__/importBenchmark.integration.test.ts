/**
 * Phase 4.2 integration/benchmark — deterministic 10,000-message real
 * candidate build (LOCK-B1..B6).
 *
 * Proves that candidate lifecycle (CandidateDbResource + real ChatDbService +
 * real migrations), the data plane (createImportDataPlane), and the
 * order-preserving writer together build and seal a complete 10k-message
 * SQLite candidate with:
 * - exact topic/message/block/segment/membership/file-reference counts,
 * - exact first/middle/last order (messages, sibling blocks, memberships),
 * - PRAGMA integrity_check = 'ok' and an empty foreign_key_check,
 * - a candidate file that persists after seal,
 * - source/candidate stats accounting, and
 * - measured elapsed wall-clock time (test benchmark, NOT a production
 *   performance threshold — LOCK-B6).
 *
 * Also proves live-DB isolation (LOCK-B4): a real sentinel live chat.db in a
 * SEPARATE temp root plus a sentinel file at the candidate root's adjacent
 * live path remain byte-for-byte and logically unchanged throughout build,
 * seal, and discard.
 *
 * A second scenario (LOCK-B5) writes partial pages, then discards the
 * candidate: the candidate directory is removed and the live DB is unchanged.
 *
 * No orchestration mocks are used (LOCK-B1); no production file is modified.
 */

import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

// Mock @main/config so importing chatDb modules never touches getDataPath().
// Every resource in this file injects an explicit temp dataRoot (LOCK-B1).
vi.mock('@main/config', () => ({ DATA_PATH: '/mock/data' }))

import type { JsonObject } from '@shared/chatDb'
import type { ReadPageResponse } from '@shared/chatImport/types'
import Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { CandidateDbResource, getCandidateRoot } from '../candidateDb'
import { type ChatImportDataPlane, createImportDataPlane } from '../importDataPlane'

// ---------------------------------------------------------------------------
// Fixture dimensions (LOCK-B2) — all deterministic, no randomness
// ---------------------------------------------------------------------------

/** Topics in the source stream. */
const TOPIC_COUNT = 25
/** Embedded messages per topic. */
const MESSAGES_PER_TOPIC = 400
/** Exactly 10,000 messages (LOCK-B2). */
const TOTAL_MESSAGES = TOPIC_COUNT * MESSAGES_PER_TOPIC
/** Topics per source page → 5 topic pages of 2,000 embedded messages each. */
const TOPICS_PER_PAGE = 5
/** Every Nth message carries a second (sibling) block. */
const EXTRA_BLOCK_EVERY = 10
/** Extra sibling blocks: 1,000 (file/image/tool cycling). */
const EXTRA_BLOCK_COUNT = TOTAL_MESSAGES / EXTRA_BLOCK_EVERY
/** Total candidate blocks: 10,000 base + 1,000 extras. */
const TOTAL_BLOCKS = TOTAL_MESSAGES + EXTRA_BLOCK_COUNT
/** Globally ID-paginated block page size → 11 block pages. */
const BLOCK_PAGE_SIZE = 1000
/** Every Nth message carries a structured model + unknown overflow key. */
const STRUCTURED_MODEL_EVERY = 100
/** Ordered members per per-topic segment. */
const SEGMENT_MEMBER_COUNT = 10
/** 25 per-topic segments + 1 empty segment (LOCK-B2). */
const TOTAL_SEGMENTS = TOPIC_COUNT + 1
const TOTAL_MEMBERSHIPS = TOPIC_COUNT * SEGMENT_MEMBER_COUNT
/** Source `files` rows streamed (count-diagnostic only), 2 pages of 500. */
const SOURCE_FILE_RECORDS = EXTRA_BLOCK_COUNT
const FILES_PAGE_SIZE = 500

/** Generous ceiling so a pathological hang fails fast. NOT a perf threshold. */
const BENCHMARK_CEILING_MS = 120_000

const BENCH_CREATED_AT = '2020-01-01T00:00:00.000Z'
const STRUCTURED_MODEL = { id: 'bench-model', name: 'Bench Model', provider: 'bench', group: 'bench' }

/** file/image extras project file references; tool extras do not. */
const EXPECTED_FILE_REFERENCES = (() => {
  let n = 0
  for (let e = 0; e < EXTRA_BLOCK_COUNT; e++) {
    if (e % 3 !== 2) n++ // 0 → file, 1 → image, 2 → tool
  }
  return n
})()

/** 5 topic + 11 block + 1 segment + 2 files pages. */
const EXPECTED_PAGE_COUNT =
  TOPIC_COUNT / TOPICS_PER_PAGE + TOTAL_BLOCKS / BLOCK_PAGE_SIZE + 1 + SOURCE_FILE_RECORDS / FILES_PAGE_SIZE

// ---------------------------------------------------------------------------
// Deterministic ID scheme (zero-padded so global ID order is lexicographic)
// ---------------------------------------------------------------------------

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}
const topicIdOf = (t: number): string => `t-${pad(t, 2)}`
const messageIdOf = (g: number): string => `m-${pad(g, 5)}`
const baseBlockIdOf = (g: number): string => `b-${pad(g, 5)}`
/** Extras use an `x-` prefix, sorting after every base `b-` ID, so globally
 *  ID-paginated block pages split sibling blocks across pages (LOCK-B2). */
const extraBlockIdOf = (e: number): string => `x-${pad(e, 4)}`
const fileIdOf = (e: number): string => `file-${pad(e, 4)}`
const hasExtraBlock = (g: number): boolean => g % EXTRA_BLOCK_EVERY === 0
const extraTypeOf = (e: number): 'file' | 'image' | 'tool' => (['file', 'image', 'tool'] as const)[e % 3]

// ---------------------------------------------------------------------------
// Fixture page builders (built lazily per page; not retained — LOCK-B6)
// ---------------------------------------------------------------------------

function page(tableName: string, items: JsonObject[], hasMore: boolean): ReadPageResponse {
  return { tableName, items, cursor: hasMore ? 'next' : null, hasMore }
}

function buildMessage(g: number): JsonObject {
  const topicIndex = Math.floor(g / MESSAGES_PER_TOPIC)
  const blocks = hasExtraBlock(g)
    ? [extraBlockIdOf(g / EXTRA_BLOCK_EVERY), baseBlockIdOf(g)] // extra first: deliberate non-ID sibling order
    : [baseBlockIdOf(g)]
  const message: JsonObject = {
    id: messageIdOf(g),
    topicId: topicIdOf(topicIndex),
    role: g % 2 === 0 ? 'user' : 'assistant',
    status: 'success',
    assistantId: 'asst-bench',
    createdAt: BENCH_CREATED_AT,
    blocks
  }
  if (g % STRUCTURED_MODEL_EVERY === 0) {
    message.model = { ...STRUCTURED_MODEL }
    message.benchUnknownKey = { globalIndex: g }
  }
  return message
}

/** Topic page p: 5 topics, each embedding its 400 messages in REVERSED
 *  array order (non-ID order) so sortOrder = array index is provable. */
function buildTopicPage(p: number): JsonObject[] {
  const topics: JsonObject[] = []
  for (let t = p * TOPICS_PER_PAGE; t < (p + 1) * TOPICS_PER_PAGE; t++) {
    const messages: JsonObject[] = []
    for (let i = 0; i < MESSAGES_PER_TOPIC; i++) {
      const g = t * MESSAGES_PER_TOPIC + (MESSAGES_PER_TOPIC - 1 - i)
      messages.push(buildMessage(g))
    }
    topics.push({ id: topicIdOf(t), messages })
  }
  return topics
}

function buildBlockRow(sortedIndex: number): JsonObject {
  if (sortedIndex < TOTAL_MESSAGES) {
    const g = sortedIndex
    return {
      id: baseBlockIdOf(g),
      messageId: messageIdOf(g),
      type: 'main_text',
      content: `bench message ${g}`,
      status: 'success',
      createdAt: BENCH_CREATED_AT
    }
  }
  const e = sortedIndex - TOTAL_MESSAGES
  const messageId = messageIdOf(e * EXTRA_BLOCK_EVERY)
  const type = extraTypeOf(e)
  if (type === 'tool') {
    return {
      id: extraBlockIdOf(e),
      messageId,
      type: 'tool',
      content: { toolName: 'bench', callIndex: e },
      status: 'success',
      createdAt: BENCH_CREATED_AT,
      toolId: `tool-${e}`
    }
  }
  return {
    id: extraBlockIdOf(e),
    messageId,
    type,
    content: null,
    file: { id: fileIdOf(e), name: `f${e}.bin`, path: `/bench/f${e}.bin`, type, size: e },
    benchExtraKey: e,
    status: 'success',
    createdAt: BENCH_CREATED_AT
  }
}

/** Block page b (globally ID-sorted: all b-* ascending, then all x-*). */
function buildBlockPage(b: number): JsonObject[] {
  const items: JsonObject[] = []
  for (let i = b * BLOCK_PAGE_SIZE; i < Math.min((b + 1) * BLOCK_PAGE_SIZE, TOTAL_BLOCKS); i++) {
    items.push(buildBlockRow(i))
  }
  return items
}

/** 25 per-topic segments (members = first 10 topic messages, REVERSED order)
 *  plus one empty segment (LOCK-B2). */
function buildSegmentsPage(): JsonObject[] {
  const segments: JsonObject[] = []
  for (let t = 0; t < TOPIC_COUNT; t++) {
    const messageIds: string[] = []
    for (let i = SEGMENT_MEMBER_COUNT - 1; i >= 0; i--) {
      messageIds.push(messageIdOf(t * MESSAGES_PER_TOPIC + i))
    }
    segments.push({
      id: `s-${pad(t, 2)}`,
      topicId: topicIdOf(t),
      name: `Bench segment ${t}`,
      messageIds,
      createdAt: BENCH_CREATED_AT,
      updatedAt: BENCH_CREATED_AT,
      color: '#123456'
    })
  }
  segments.push({
    id: 's-empty',
    topicId: topicIdOf(0),
    name: 'Empty bench segment',
    messageIds: [],
    createdAt: BENCH_CREATED_AT,
    updatedAt: BENCH_CREATED_AT
  })
  return segments
}

function buildFilesPage(p: number): JsonObject[] {
  const items: JsonObject[] = []
  for (let e = p * FILES_PAGE_SIZE; e < Math.min((p + 1) * FILES_PAGE_SIZE, SOURCE_FILE_RECORDS); e++) {
    items.push({ id: fileIdOf(e), name: `f${e}.bin`, size: e })
  }
  return items
}

/** Stream every page through the data plane in LOCK-D1 entity order. */
function streamAllPages(plane: ChatImportDataPlane): void {
  const topicPages = TOPIC_COUNT / TOPICS_PER_PAGE
  for (let p = 0; p < topicPages; p++) {
    plane.processPage(page('topics', buildTopicPage(p), p < topicPages - 1))
  }
  const blockPages = Math.ceil(TOTAL_BLOCKS / BLOCK_PAGE_SIZE)
  for (let b = 0; b < blockPages; b++) {
    plane.processPage(page('message_blocks', buildBlockPage(b), b < blockPages - 1))
  }
  plane.processPage(page('topic_segments', buildSegmentsPage(), false))
  const filesPages = Math.ceil(SOURCE_FILE_RECORDS / FILES_PAGE_SIZE)
  for (let p = 0; p < filesPages; p++) {
    plane.processPage(page('files', buildFilesPage(p), p < filesPages - 1))
  }
}

// ---------------------------------------------------------------------------
// Live sentinel DB (real SQLite, separate temp root — LOCK-B1/B4)
// ---------------------------------------------------------------------------

interface LiveSentinel {
  dbPath: string
  bytes: Buffer
}

function createLiveSentinelDb(liveRoot: string): LiveSentinel {
  const dbPath = realPath.join(liveRoot, 'chat.db')
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  runMigrations(drizzle(sqlite, { schema }), sqlite)
  sqlite
    .prepare('INSERT INTO topics (id, name, created_at) VALUES (?, ?, ?)')
    .run('live-topic', 'LIVE-SENTINEL', BENCH_CREATED_AT)
  sqlite
    .prepare('INSERT INTO messages (id, topic_id, role, content, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('live-message', 'live-topic', 'user', 'live sentinel message', 0, BENCH_CREATED_AT)
  sqlite.close() // checkpoints + removes WAL/SHM → stable bytes
  return { dbPath, bytes: realFs.readFileSync(dbPath) }
}

function assertLiveSentinelUnchanged(sentinel: LiveSentinel): void {
  // Byte-for-byte file identity.
  expect(realFs.readFileSync(sentinel.dbPath).equals(sentinel.bytes)).toBe(true)
  expect(realFs.existsSync(`${sentinel.dbPath}-wal`)).toBe(false)
  expect(realFs.existsSync(`${sentinel.dbPath}-shm`)).toBe(false)
  // Logical rows unchanged.
  const sqlite = new Database(sentinel.dbPath, { readonly: true })
  try {
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM topics').get() as { n: number }).n).toBe(1)
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(1)
    const topic = sqlite.prepare('SELECT name FROM topics WHERE id = ?').get('live-topic') as { name: string }
    expect(topic.name).toBe('LIVE-SENTINEL')
  } finally {
    sqlite.close()
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const SESSION_ID = 'bench-4202-10k-session'

function countOf(sqlite: Database.Database, table: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

describe('chatDbImport Phase 4.2 — 10k-message candidate integration benchmark', () => {
  let liveRoot: string
  let dataRoot: string
  let sentinel: LiveSentinel
  let adjacentSentinelPath: string
  let resource: CandidateDbResource | null

  beforeEach(() => {
    // Separate temp roots for the live DB and the candidate build (LOCK-B1).
    liveRoot = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-bench-live-'))
    dataRoot = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-bench-candidate-'))
    sentinel = createLiveSentinelDb(liveRoot)
    // Also guard the live path adjacent to the candidate root (LOCK-B4).
    adjacentSentinelPath = realPath.join(dataRoot, 'chat.db')
    realFs.writeFileSync(adjacentSentinelPath, 'ADJACENT-LIVE-SENTINEL', 'utf-8')
    resource = null
  })

  afterEach(async () => {
    if (resource && resource.getState() !== 'discarded') {
      try {
        await resource.discard()
      } catch {
        // best-effort cleanup; temp roots are removed below regardless
      }
    }
    realFs.rmSync(liveRoot, { recursive: true, force: true })
    realFs.rmSync(dataRoot, { recursive: true, force: true })
  })

  it(
    'builds and seals a complete 10,000-message candidate with exact counts, order, integrity, and timing',
    async () => {
      resource = new CandidateDbResource({ sessionId: SESSION_ID, dataRoot })
      await resource.initialize() // real ChatDbService + real migrations (LOCK-B1)

      const plane = createImportDataPlane(resource.getDatabase() as BetterSQLite3Database<typeof schema>)

      // --- Benchmark: full page stream + finalize + seal (LOCK-B3/B6) ---
      const startedAt = performance.now()
      streamAllPages(plane)
      const finalized = plane.finalize()
      resource.seal()
      const elapsedMs = performance.now() - startedAt

      expect(elapsedMs).toBeGreaterThan(0)
      expect(elapsedMs).toBeLessThan(BENCHMARK_CEILING_MS)
      // Reporter-safe benchmark emission (test stdout only; no production log).
      process.stdout.write(
        `[chatdb-import-benchmark] 10k-message candidate build+finalize+seal: ${elapsedMs.toFixed(1)} ms ` +
          `(${TOTAL_MESSAGES} messages, ${TOTAL_BLOCKS} blocks, ${EXPECTED_PAGE_COUNT} pages)\n`
      )

      // --- Stats accounting (LOCK-B3) ---
      expect(finalized.sourceReadStats).toEqual({
        topicRecordCount: TOPIC_COUNT,
        blockRecordCount: TOTAL_BLOCKS,
        segmentRecordCount: TOTAL_SEGMENTS,
        sourceFileRecordCount: SOURCE_FILE_RECORDS
      })
      expect(finalized.candidateImportStats).toEqual({
        topicCount: TOPIC_COUNT,
        messageCount: TOTAL_MESSAGES,
        blockCount: TOTAL_BLOCKS,
        segmentCount: TOTAL_SEGMENTS,
        segmentMembershipCount: TOTAL_MEMBERSHIPS,
        fileReferenceCount: EXPECTED_FILE_REFERENCES,
        pageCount: EXPECTED_PAGE_COUNT,
        elapsedMs: 0 // the plane does not self-time; the test measures elapsed
      })

      // --- Sealed candidate persists on disk (LOCK-B3) ---
      const candidateDbPath = resource.getDbPath()
      expect(resource.getState()).toBe('sealed')
      expect(realFs.existsSync(candidateDbPath)).toBe(true)
      expect(candidateDbPath.startsWith(getCandidateRoot(dataRoot) + realPath.sep)).toBe(true)

      // --- Verify the sealed candidate via direct SQL (LOCK-B3) ---
      const sqlite = new Database(candidateDbPath, { readonly: true })
      try {
        // Exact counts.
        expect(countOf(sqlite, 'topics')).toBe(TOPIC_COUNT)
        expect(countOf(sqlite, 'messages')).toBe(TOTAL_MESSAGES)
        expect(countOf(sqlite, 'message_blocks')).toBe(TOTAL_BLOCKS)
        expect(countOf(sqlite, 'topic_segments')).toBe(TOTAL_SEGMENTS)
        expect(countOf(sqlite, 'topic_segment_messages')).toBe(TOTAL_MEMBERSHIPS)
        expect(countOf(sqlite, 'file_references')).toBe(EXPECTED_FILE_REFERENCES)

        // Representative first/middle/last message order per topic: embedded
        // arrays were REVERSED, so sortOrder i → global index (last - i).
        const messageAt = sqlite.prepare('SELECT id FROM messages WHERE topic_id = ? AND sort_order = ?')
        for (const t of [0, 12, TOPIC_COUNT - 1]) {
          const base = t * MESSAGES_PER_TOPIC
          expect((messageAt.get(topicIdOf(t), 0) as { id: string }).id).toBe(messageIdOf(base + 399))
          expect((messageAt.get(topicIdOf(t), 200) as { id: string }).id).toBe(messageIdOf(base + 199))
          expect((messageAt.get(topicIdOf(t), 399) as { id: string }).id).toBe(messageIdOf(base))
        }

        // Sibling block order survives the b-*/x-* page split: extras were
        // listed FIRST in message.blocks, so x-* gets sortOrder 0.
        const blocksOf = sqlite.prepare(
          'SELECT id, sort_order AS sortOrder FROM message_blocks WHERE message_id = ? ORDER BY sort_order ASC'
        )
        for (const g of [0, 5000, 9990]) {
          const e = g / EXTRA_BLOCK_EVERY
          expect(blocksOf.all(messageIdOf(g))).toEqual([
            { id: extraBlockIdOf(e), sortOrder: 0 },
            { id: baseBlockIdOf(g), sortOrder: 1 }
          ])
        }
        expect(blocksOf.all(messageIdOf(1))).toEqual([{ id: baseBlockIdOf(1), sortOrder: 0 }])

        // Membership order = messageIds array index (reversed member lists).
        const membersOf = sqlite.prepare(
          'SELECT message_id AS messageId, sort_order AS sortOrder FROM topic_segment_messages ' +
            'WHERE segment_id = ? ORDER BY sort_order ASC'
        )
        const firstSegment = membersOf.all('s-00') as Array<{ messageId: string; sortOrder: number }>
        expect(firstSegment).toHaveLength(SEGMENT_MEMBER_COUNT)
        expect(firstSegment[0]).toEqual({ messageId: messageIdOf(9), sortOrder: 0 })
        expect(firstSegment[9]).toEqual({ messageId: messageIdOf(0), sortOrder: 9 })
        const lastSegment = membersOf.all(`s-${pad(TOPIC_COUNT - 1, 2)}`) as Array<{ messageId: string }>
        expect(lastSegment[0].messageId).toBe(messageIdOf((TOPIC_COUNT - 1) * MESSAGES_PER_TOPIC + 9))

        // Empty segment retained with zero memberships.
        expect(sqlite.prepare('SELECT id FROM topic_segments WHERE id = ?').get('s-empty')).toBeDefined()
        expect(membersOf.all('s-empty')).toEqual([])

        // Structured model round-trip: column null, modelId promoted, extra keeps object.
        const modelMsg = sqlite
          .prepare('SELECT model, model_id AS modelId, extra FROM messages WHERE id = ?')
          .get(messageIdOf(0)) as { model: string | null; modelId: string; extra: string }
        expect(modelMsg.model).toBeNull()
        expect(modelMsg.modelId).toBe(STRUCTURED_MODEL.id)
        const modelExtra = JSON.parse(modelMsg.extra)
        expect(modelExtra.model).toEqual(STRUCTURED_MODEL)
        expect(modelExtra.benchUnknownKey).toEqual({ globalIndex: 0 })

        // Tool block: object content in extra.content; column content null.
        const toolBlock = sqlite
          .prepare('SELECT content, extra FROM message_blocks WHERE id = ?')
          .get(extraBlockIdOf(2)) as { content: string | null; extra: string }
        expect(toolBlock.content).toBeNull()
        expect(JSON.parse(toolBlock.extra).content).toEqual({ toolName: 'bench', callIndex: 2 })

        // File reference projected from a file-typed sibling block.
        const fileRef = sqlite
          .prepare('SELECT file_id AS fileId, file_name AS fileName FROM file_references WHERE block_id = ?')
          .get(extraBlockIdOf(0)) as { fileId: string; fileName: string }
        expect(fileRef).toEqual({ fileId: fileIdOf(0), fileName: 'f0.bin' })

        // Integrity (LOCK-B3): full check ok, FK check empty.
        expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok')
        expect(sqlite.pragma('foreign_key_check')).toEqual([])
      } finally {
        sqlite.close()
      }

      // --- Live DB isolation throughout build + seal (LOCK-B4) ---
      assertLiveSentinelUnchanged(sentinel)
      expect(realFs.readFileSync(adjacentSentinelPath, 'utf-8')).toBe('ADJACENT-LIVE-SENTINEL')
    },
    BENCHMARK_CEILING_MS
  )

  it(
    'discards an interrupted candidate after partial pages: directory removed, live DB unchanged',
    async () => {
      resource = new CandidateDbResource({ sessionId: SESSION_ID, dataRoot })
      await resource.initialize()

      const plane = createImportDataPlane(resource.getDatabase() as BetterSQLite3Database<typeof schema>)

      // Partial stream (LOCK-B5): 2 of 5 topic pages (4,000 messages) and
      // 2 of 11 block pages (2,000 base blocks); no finalize, no seal.
      plane.processPage(page('topics', buildTopicPage(0), true))
      plane.processPage(page('topics', buildTopicPage(1), true))
      plane.processPage(page('message_blocks', buildBlockPage(0), true))
      plane.processPage(page('message_blocks', buildBlockPage(1), true))

      const partialStats = plane.getCandidateImportStats()
      expect(partialStats.messageCount).toBe(2 * TOPICS_PER_PAGE * MESSAGES_PER_TOPIC)
      expect(partialStats.blockCount).toBe(2 * BLOCK_PAGE_SIZE)

      const candidateDir = resource.getCandidateDir()
      const candidateDbPath = resource.getDbPath()
      expect(realFs.existsSync(candidateDbPath)).toBe(true)

      // Interruption → discard the candidate (LOCK-B5).
      await resource.discard()

      expect(resource.getState()).toBe('discarded')
      expect(realFs.existsSync(candidateDir)).toBe(false)
      expect(realFs.existsSync(candidateDbPath)).toBe(false)
      expect(realFs.existsSync(`${candidateDbPath}-wal`)).toBe(false)
      expect(realFs.existsSync(`${candidateDbPath}-shm`)).toBe(false)

      // Live DB unchanged through partial build + discard (LOCK-B4/B5).
      assertLiveSentinelUnchanged(sentinel)
      expect(realFs.readFileSync(adjacentSentinelPath, 'utf-8')).toBe('ADJACENT-LIVE-SENTINEL')
    },
    BENCHMARK_CEILING_MS
  )
})
