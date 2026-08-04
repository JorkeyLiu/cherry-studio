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

import Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import { runMigrations } from '../../chatDb/migration'
import * as schema from '../../chatDb/schema'
import { CandidateDbResource, getCandidateRoot } from '../candidateDb'
import { computeMessageTargetId } from '../identity/messageIdentity'
import { createImportDataPlane } from '../importDataPlane'
// Deterministic 10k fixture shared with the Phase 4.3.4 verification
// benchmark (same source stream, same LOCK-B2 dimensions).
import {
  baseBlockIdOf,
  BENCH_CREATED_AT,
  BLOCK_PAGE_SIZE,
  buildBlockPage,
  buildTopicPage,
  EXPECTED_FILE_REFERENCES,
  EXPECTED_PAGE_COUNT,
  EXTRA_BLOCK_EVERY,
  extraBlockIdOf,
  fileIdOf,
  messageIdOf,
  MESSAGES_PER_TOPIC,
  pad,
  page,
  SEGMENT_MEMBER_COUNT,
  SOURCE_FILE_RECORDS,
  streamAllPages,
  STRUCTURED_MODEL,
  TOPIC_COUNT,
  topicIdOf,
  TOPICS_PER_PAGE,
  TOTAL_BLOCKS,
  TOTAL_MEMBERSHIPS,
  TOTAL_MESSAGES,
  TOTAL_SEGMENTS
} from './benchmarkFixture10k'

/** Generous ceiling so a pathological hang fails fast. NOT a perf threshold. */
const BENCHMARK_CEILING_MS = 120_000

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

/** Deterministic L2 target ID of the message at global index `g` (LOCK-MID-1). */
function messageTargetIdOf(g: number): string {
  return computeMessageTargetId(topicIdOf(Math.floor(g / MESSAGES_PER_TOPIC)), messageIdOf(g))
}

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

      // LOCK-FTS-3: defer the derived search projection before any page
      // write — bulk import must not pay per-row trigger/FTS maintenance.
      const deferStartedAt = performance.now()
      resource.deferFtsProjection()
      const deferMs = performance.now() - deferStartedAt

      // Structural proof (LOCK-FTS-3/7): derived objects are ABSENT while
      // the import writes pages — no triggers, no FTS, no normalized table.
      {
        const sqlite = resource.getSqlite() as Database.Database
        const derived = sqlite
          .prepare(
            "SELECT name, type FROM sqlite_master WHERE name IN ('message_blocks_normalized', " +
              "'message_blocks_normalized_message_id_idx', 'message_blocks_fts', " +
              "'message_blocks_normalized_insert', 'message_blocks_normalized_update', " +
              "'message_blocks_normalized_delete')"
          )
          .all() as Array<{ name: string; type: string }>
        expect(derived).toEqual([])
        // migration_state 003 remains recorded (LOCK-FTS-3): the deferral
        // never unsets the migration — explicit rebuild is mandatory.
        expect(
          (
            sqlite
              .prepare("SELECT COUNT(*) AS n FROM migration_state WHERE key = '003_fts5_normalized_search'")
              .get() as {
              n: number
            }
          ).n
        ).toBe(1)
      }

      const plane = createImportDataPlane(resource.getDatabase() as BetterSQLite3Database<typeof schema>)

      // --- Benchmark: full page stream + finalize + rebuild + seal (LOCK-B3/B6) ---
      const startedAt = performance.now()
      streamAllPages(plane)
      const pagesMs = performance.now() - startedAt
      const finalized = plane.finalize()

      // LOCK-FTS-7: while deferred, the page stream wrote ZERO derived rows
      // (trigger absence during writes is proven structurally — no wall-clock
      // threshold is asserted for the write cost shape).
      {
        const sqlite = resource.getSqlite() as Database.Database
        const normalizedExists = sqlite
          .prepare('SELECT COUNT(*) AS n FROM sqlite_master WHERE type = ? AND name = ?')
          .get('table', 'message_blocks_normalized') as { n: number }
        expect(normalizedExists.n).toBe(0)
      }

      // LOCK-FTS-4: rebuild exactly once AFTER finalize and BEFORE seal.
      const rebuildStartedAt = performance.now()
      resource.rebuildFtsProjection()
      const rebuildMs = performance.now() - rebuildStartedAt
      resource.seal()
      const elapsedMs = performance.now() - startedAt

      expect(elapsedMs).toBeGreaterThan(0)
      expect(elapsedMs).toBeLessThan(BENCHMARK_CEILING_MS)
      // Reporter-safe benchmark emission (test stdout only; no production log).
      process.stdout.write(
        `[chatdb-import-benchmark] 10k-message candidate build+finalize+seal: ${elapsedMs.toFixed(1)} ms ` +
          `(defer: ${deferMs.toFixed(1)} ms, pages: ${pagesMs.toFixed(1)} ms, rebuild: ${rebuildMs.toFixed(1)} ms, ` +
          `${TOTAL_MESSAGES} messages, ${TOTAL_BLOCKS} blocks, ${EXPECTED_PAGE_COUNT} pages)\n`
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

        // LOCK-FTS-4/7: rebuilt projection counts match the canonical
        // MAIN_TEXT/content-not-null source (10,000 base blocks; the 1,000
        // extra tool/file/image sibling blocks are never projected).
        const canonicalMainText = (
          sqlite
            .prepare("SELECT COUNT(*) AS n FROM message_blocks WHERE type = 'main_text' AND content IS NOT NULL")
            .get() as { n: number }
        ).n
        expect(canonicalMainText).toBe(TOTAL_MESSAGES)
        expect(countOf(sqlite, 'message_blocks_normalized')).toBe(canonicalMainText)
        expect(countOf(sqlite, 'message_blocks_fts')).toBe(canonicalMainText)
        // The message_id join index exists again after the rebuild.
        const rebuiltIndex = sqlite
          .prepare(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' " +
              "AND name = 'message_blocks_normalized_message_id_idx'"
          )
          .get() as { n: number }
        expect(rebuiltIndex.n).toBe(1)
        // The three sync triggers are restored (LOCK-FTS-6).
        for (const trigger of [
          'message_blocks_normalized_insert',
          'message_blocks_normalized_update',
          'message_blocks_normalized_delete'
        ]) {
          expect(
            (
              sqlite
                .prepare('SELECT COUNT(*) AS n FROM sqlite_master WHERE type = ? AND name = ?')
                .get('trigger', trigger) as {
                n: number
              }
            ).n
          ).toBe(1)
        }
        // Search projection query parity (LOCK-FTS-7): the rebuilt FTS index
        // returns the exact canonical MAIN_TEXT block set for a content term.
        const ftsMatches = sqlite
          .prepare('SELECT COUNT(*) AS n FROM message_blocks_fts WHERE message_blocks_fts MATCH \'"bench message"\'')
          .get() as { n: number }
        expect(ftsMatches.n).toBe(canonicalMainText)

        // Representative first/middle/last message order per topic: embedded
        // arrays were REVERSED, so sortOrder i → global index (last - i).
        // Candidate ids are deterministic targets (LOCK-MID-1).
        const messageAt = sqlite.prepare('SELECT id FROM messages WHERE topic_id = ? AND sort_order = ?')
        for (const t of [0, 12, TOPIC_COUNT - 1]) {
          const base = t * MESSAGES_PER_TOPIC
          expect((messageAt.get(topicIdOf(t), 0) as { id: string }).id).toBe(messageTargetIdOf(base + 399))
          expect((messageAt.get(topicIdOf(t), 200) as { id: string }).id).toBe(messageTargetIdOf(base + 199))
          expect((messageAt.get(topicIdOf(t), 399) as { id: string }).id).toBe(messageTargetIdOf(base))
        }

        // Sibling block order survives the b-*/x-* page split: extras were
        // listed FIRST in message.blocks, so x-* gets sortOrder 0. Block
        // message_id is the owner's target (LOCK-REF-1).
        const blocksOf = sqlite.prepare(
          'SELECT id, sort_order AS sortOrder FROM message_blocks WHERE message_id = ? ORDER BY sort_order ASC'
        )
        for (const g of [0, 5000, 9990]) {
          const e = g / EXTRA_BLOCK_EVERY
          expect(blocksOf.all(messageTargetIdOf(g))).toEqual([
            { id: extraBlockIdOf(e), sortOrder: 0 },
            { id: baseBlockIdOf(g), sortOrder: 1 }
          ])
        }
        expect(blocksOf.all(messageTargetIdOf(1))).toEqual([{ id: baseBlockIdOf(1), sortOrder: 0 }])

        // Membership order = messageIds array index (reversed member lists);
        // memberships persist as target IDs (LOCK-REF-1).
        const membersOf = sqlite.prepare(
          'SELECT message_id AS messageId, sort_order AS sortOrder FROM topic_segment_messages ' +
            'WHERE segment_id = ? ORDER BY sort_order ASC'
        )
        const firstSegment = membersOf.all('s-00') as Array<{ messageId: string; sortOrder: number }>
        expect(firstSegment).toHaveLength(SEGMENT_MEMBER_COUNT)
        expect(firstSegment[0]).toEqual({ messageId: messageTargetIdOf(9), sortOrder: 0 })
        expect(firstSegment[9]).toEqual({ messageId: messageTargetIdOf(0), sortOrder: 9 })
        const lastSegment = membersOf.all(`s-${pad(TOPIC_COUNT - 1, 2)}`) as Array<{ messageId: string }>
        expect(lastSegment[0].messageId).toBe(messageTargetIdOf((TOPIC_COUNT - 1) * MESSAGES_PER_TOPIC + 9))

        // Empty segment retained with zero memberships.
        expect(sqlite.prepare('SELECT id FROM topic_segments WHERE id = ?').get('s-empty')).toBeDefined()
        expect(membersOf.all('s-empty')).toEqual([])

        // Structured model round-trip: column null, modelId promoted, extra keeps object.
        const modelMsg = sqlite
          .prepare('SELECT model, model_id AS modelId, extra FROM messages WHERE id = ?')
          .get(messageTargetIdOf(0)) as { model: string | null; modelId: string; extra: string }
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
      // LOCK-FTS-3: defer the derived projection before writing pages — the
      // partial build must never pay per-row trigger/FTS maintenance.
      resource.deferFtsProjection()

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
