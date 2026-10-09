/**
 * Bounded multi-page candidate integration — deterministic small synthetic
 * source through the real candidate build (LOCK-B1/B3/B4/B5/B6).
 *
 * Right-sized from the former 10k-message benchmark (10k is NOT a product
 * semantic). The bounded fixture crosses every pagination boundary with
 * the minimum pages (2 topic + 3 block + 1 segment + 2 files pages) and
 * proves the contracts that small single-page fixtures cannot:
 * - exact message/sibling-block/membership order across real page
 *   boundaries, including the lexicographic b-prefix/x-prefix sibling split,
 * - FTS defer/rebuild parity: derived objects absent while deferred, zero
 *   derived rows from the page stream, full rebuild + trigger restoration
 *   + FTS MATCH parity,
 * - full-graph integrity: PRAGMA integrity_check = 'ok' and an empty
 *   foreign_key_check on the sealed candidate.
 *
 * Deliberately NOT re-asserted here (covered by the focused small-fixture
 * suites): exact source/candidate count matrices
 * (importDataPlane.test.ts), structured model / tool content / file
 * metadata round-trips (importDataPlane.test.ts round-trip test), and
 * wall-clock timing output (observation only, never a contract).
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
// Deterministic bounded fixture shared with the verification suite (same
// source stream, same minimal multi-page dimensions).
import {
  baseBlockIdOf,
  BENCH_CREATED_AT,
  BLOCK_PAGE_SIZE,
  buildBlockPage,
  buildTopicPage,
  EXPECTED_PAGE_COUNT,
  extraBlockIdOf,
  messageIdOf,
  MESSAGES_PER_TOPIC,
  page,
  SEGMENT_MEMBER_COUNT,
  streamAllPages,
  TOPIC_COUNT,
  topicIdOf,
  TOPICS_PER_PAGE,
  TOTAL_BLOCKS,
  TOTAL_MESSAGES
} from './boundedImportFixture'

/** Generous ceiling so a pathological hang fails fast. NOT a perf threshold. */
const BENCHMARK_CEILING_MS = 60_000

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

const SESSION_ID = 'bench-4202-bounded-session'

/** Deterministic L2 target ID of the message at global index `g` (LOCK-MID-1). */
function messageTargetIdOf(g: number): string {
  return computeMessageTargetId(topicIdOf(Math.floor(g / MESSAGES_PER_TOPIC)), messageIdOf(g))
}

describe('chatDbImport — bounded multi-page candidate integration', () => {
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
    'builds and seals a bounded multi-page candidate with cross-page order, FTS rebuild, and integrity',
    async () => {
      resource = new CandidateDbResource({ sessionId: SESSION_ID, dataRoot })
      await resource.initialize() // real ChatDbService + real migrations (LOCK-B1)

      // LOCK-FTS-3: defer the derived search projection before any page
      // write — bulk import must not pay per-row trigger/FTS maintenance.
      resource.deferFtsProjection()

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

      streamAllPages(plane)
      const finalized = plane.finalize()

      // Invariant evidence: the bounded stream really crossed page
      // boundaries (2 topic + 3 block pages).
      expect(TOPIC_COUNT / TOPICS_PER_PAGE).toBeGreaterThanOrEqual(2)
      expect(Math.ceil(TOTAL_BLOCKS / BLOCK_PAGE_SIZE)).toBeGreaterThanOrEqual(2)
      expect(finalized.candidateImportStats.pageCount).toBe(EXPECTED_PAGE_COUNT)

      // LOCK-FTS-7: while deferred, the page stream wrote ZERO derived rows
      // (trigger absence during writes is proven structurally).
      {
        const sqlite = resource.getSqlite() as Database.Database
        const normalizedExists = sqlite
          .prepare('SELECT COUNT(*) AS n FROM sqlite_master WHERE type = ? AND name = ?')
          .get('table', 'message_blocks_normalized') as { n: number }
        expect(normalizedExists.n).toBe(0)
      }

      // LOCK-FTS-4: rebuild exactly once AFTER finalize and BEFORE seal.
      resource.rebuildFtsProjection()
      resource.seal()

      // --- Sealed candidate persists on disk (LOCK-B3) ---
      const candidateDbPath = resource.getDbPath()
      expect(resource.getState()).toBe('sealed')
      expect(realFs.existsSync(candidateDbPath)).toBe(true)
      expect(candidateDbPath.startsWith(getCandidateRoot(dataRoot) + realPath.sep)).toBe(true)

      // --- Verify the sealed candidate via direct SQL (LOCK-B3) ---
      const sqlite = new Database(candidateDbPath, { readonly: true })
      try {
        // LOCK-FTS-4/7: rebuilt projection counts match the canonical
        // MAIN_TEXT/content-not-null source (24 base blocks; the 4 extra
        // tool/file/image sibling blocks are never projected).
        const canonicalMainText = (
          sqlite
            .prepare("SELECT COUNT(*) AS n FROM message_blocks WHERE type = 'main_text' AND content IS NOT NULL")
            .get() as { n: number }
        ).n
        expect(canonicalMainText).toBe(TOTAL_MESSAGES)
        const countOf = (table: string): number =>
          (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
        expect(countOf('message_blocks_normalized')).toBe(canonicalMainText)
        expect(countOf('message_blocks_fts')).toBe(canonicalMainText)
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

        // Cross-page message order on the first and last topics: embedded
        // arrays were REVERSED, so sortOrder 0 → global last, sortOrder
        // (last) → global first. Candidate ids are deterministic targets
        // (LOCK-MID-1).
        const messageAt = sqlite.prepare('SELECT id FROM messages WHERE topic_id = ? AND sort_order = ?')
        const lastTopic = TOPIC_COUNT - 1
        expect((messageAt.get(topicIdOf(0), 0) as { id: string }).id).toBe(messageTargetIdOf(MESSAGES_PER_TOPIC - 1))
        expect((messageAt.get(topicIdOf(0), MESSAGES_PER_TOPIC - 1) as { id: string }).id).toBe(messageTargetIdOf(0))
        expect((messageAt.get(topicIdOf(lastTopic), 0) as { id: string }).id).toBe(
          messageTargetIdOf(lastTopic * MESSAGES_PER_TOPIC + MESSAGES_PER_TOPIC - 1)
        )
        expect((messageAt.get(topicIdOf(lastTopic), MESSAGES_PER_TOPIC - 1) as { id: string }).id).toBe(
          messageTargetIdOf(lastTopic * MESSAGES_PER_TOPIC)
        )

        // Sibling block order survives the b-prefix/x-prefix page split: extras were
        // listed FIRST in message.blocks, so x-* gets sortOrder 0. Message
        // 0's base block sits on block page 0 while its extra sits on block
        // page 2. Block message_id is the owner's target (LOCK-REF-1).
        const blocksOf = sqlite.prepare(
          'SELECT id, sort_order AS sortOrder FROM message_blocks WHERE message_id = ? ORDER BY sort_order ASC'
        )
        expect(blocksOf.all(messageTargetIdOf(0))).toEqual([
          { id: extraBlockIdOf(0), sortOrder: 0 },
          { id: baseBlockIdOf(0), sortOrder: 1 }
        ])
        expect(blocksOf.all(messageTargetIdOf(1))).toEqual([{ id: baseBlockIdOf(1), sortOrder: 0 }])

        // Membership order = messageIds array index (reversed member lists);
        // memberships persist as target IDs (LOCK-REF-1).
        const membersOf = sqlite.prepare(
          'SELECT message_id AS messageId, sort_order AS sortOrder FROM topic_segment_messages ' +
            'WHERE segment_id = ? ORDER BY sort_order ASC'
        )
        const firstSegment = membersOf.all('s-00') as Array<{ messageId: string; sortOrder: number }>
        expect(firstSegment).toHaveLength(SEGMENT_MEMBER_COUNT)
        expect(firstSegment[0]).toEqual({
          messageId: messageTargetIdOf(SEGMENT_MEMBER_COUNT - 1),
          sortOrder: 0
        })
        expect(firstSegment[SEGMENT_MEMBER_COUNT - 1]).toEqual({
          messageId: messageTargetIdOf(0),
          sortOrder: SEGMENT_MEMBER_COUNT - 1
        })

        // Empty segment retained with zero memberships.
        expect(sqlite.prepare('SELECT id FROM topic_segments WHERE id = ?').get('s-empty')).toBeDefined()
        expect(membersOf.all('s-empty')).toEqual([])

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

      // Partial stream (LOCK-B5): 1 of 2 topic pages and 1 of 3 block
      // pages (block page 0 aligns exactly with topic page 0's messages);
      // no finalize, no seal.
      plane.processPage(page('topics', buildTopicPage(0), true))
      plane.processPage(page('message_blocks', buildBlockPage(0), true))

      const partialStats = plane.getCandidateImportStats()
      expect(partialStats.messageCount).toBe(TOPICS_PER_PAGE * MESSAGES_PER_TOPIC)
      expect(partialStats.blockCount).toBe(BLOCK_PAGE_SIZE)

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
