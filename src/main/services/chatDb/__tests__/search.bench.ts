/**
 * Search Benchmark — 10k Corpus LIKE vs FTS Comparison
 *
 * LOCK-5129: Reports p50/p95 for normalized LIKE scan and hybrid FTS
 * candidate path on deterministic 10k corpus. Correctness parity is
 * mandatory and verified BEFORE any timing. No unstable absolute CI
 * thresholds.
 *
 * Discovery: this file matches the repository `*.bench.ts` convention and is
 * only collected by `vitest bench` (see vitest.config.ts benchmark.include).
 * Normal `pnpm test` never executes it.
 *
 * Run with:
 *   npx vitest bench --run --project main src/main/services/chatDb/__tests__/search.bench.ts
 *
 * Benchmark corpus:
 * - 10,000 MAIN_TEXT blocks with varied content
 * - Mix of ASCII, CJK, markdown, long/short content
 * - 10 representative query fixtures
 *
 * Measurements:
 * - Normalized LIKE baseline (scan all blocks)
 * - Hybrid FTS+LIKE path (our implementation)
 * - Correctness parity: identical block IDs and order across ALL cursor pages
 * - Index size and build timing
 * - p50/p95/mean per method + speedups (LOCK-5129 evidence)
 */

import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterAll, bench, describe, vi } from 'vitest'

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
// Setup — deterministic 10k corpus
// ---------------------------------------------------------------------------

const tempDir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-bench-'))
const sqlite = new Database(realPath.join(tempDir, 'chat.db'))
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')
sqlite.pragma('synchronous = NORMAL')
sqlite.pragma('busy_timeout = 5000')

registerChatDbNormalize(sqlite)
runMigrations(drizzle(sqlite, { schema }), sqlite)

const buildStart = performance.now()
generateCorpus(sqlite, 10_000)
const buildTime = performance.now() - buildStart

const normalizedSize = sqlite.prepare('SELECT COUNT(*) as count FROM message_blocks_normalized').get() as {
  count: number
}
const ftsSize = sqlite.prepare('SELECT COUNT(*) as count FROM message_blocks_fts').get() as { count: number }

console.log(
  `\n=== Benchmark Corpus ===\n` +
    `Blocks: 10,000\n` +
    `Normalized rows: ${normalizedSize.count}\n` +
    `FTS rows: ${ftsSize.count}\n` +
    `Build time: ${buildTime.toFixed(1)}ms`
)

const searchRepo = new SearchRepository(sqlite)

function cleanup(): void {
  try {
    sqlite.close()
  } catch {
    /* already closed */
  }
  realFs.rmSync(tempDir, { recursive: true, force: true })
}
process.once('exit', cleanup)

// ---------------------------------------------------------------------------
// Correctness parity — mandatory, runs BEFORE any timing (LOCK-5129)
// ---------------------------------------------------------------------------

const parityErrors: string[] = []
for (const fixture of QUERY_FIXTURES) {
  // Complete hybrid results across ALL cursor pages (pageSize clamp = 100)
  const hybridResults = hybridSearchAll(searchRepo, fixture.keywords, fixture.matchMode)

  // Complete LIKE semantic baseline (full scan + identical regex filter,
  // ordered by (messageCreatedAt, messageId, blockId) DESC to match production)
  const baselineBlockIds = likeSearch(sqlite, fixture.keywords, fixture.matchMode).map((r) => r.block_id)

  // No duplicates across pages (block-level cursor correctness)
  if (new Set(hybridResults).size !== hybridResults.length) {
    parityErrors.push(`${fixture.name}: duplicate block IDs across cursor pages`)
    continue
  }

  // Direct ordered block ID parity — fully cursor-drained hybrid sequence
  // compared to baseline BEFORE any sorting. Both are in
  // (messageCreatedAt DESC, messageId DESC, blockId DESC) order.
  if (
    hybridResults.length !== baselineBlockIds.length ||
    hybridResults.some((id, idx) => id !== baselineBlockIds[idx])
  ) {
    parityErrors.push(
      `${fixture.name}: ordered parity mismatch (hybrid=${hybridResults.length}, baseline=${baselineBlockIds.length})`
    )
  }
}

if (parityErrors.length > 0) {
  cleanup()
  throw new Error(`Benchmark aborted — correctness parity failed BEFORE timing:\n${parityErrors.join('\n')}`)
}

console.log(`Parity: ${QUERY_FIXTURES.length}/${QUERY_FIXTURES.length} fixtures passed complete ordered parity`)

// ---------------------------------------------------------------------------
// p50/p95 measurement + report (LOCK-5129)
// ---------------------------------------------------------------------------

const WARMUP_ROUNDS = 3
const MEASURE_ROUNDS = 10
const likeTimings: number[] = []
const ftsTimings: number[] = []

// Warmup
for (let i = 0; i < WARMUP_ROUNDS; i++) {
  for (const fixture of QUERY_FIXTURES) {
    likeSearch(sqlite, fixture.keywords, fixture.matchMode)
    searchRepo.search({
      keywords: fixture.keywords,
      matchMode: fixture.matchMode,
      sortOrder: 'newest',
      pageSize: 100
    })
  }
}

// Measure
for (let round = 0; round < MEASURE_ROUNDS; round++) {
  for (const fixture of QUERY_FIXTURES) {
    // LIKE baseline
    const likeStart = performance.now()
    likeSearch(sqlite, fixture.keywords, fixture.matchMode)
    likeTimings.push(performance.now() - likeStart)

    // FTS hybrid
    const ftsStart = performance.now()
    searchRepo.search({
      keywords: fixture.keywords,
      matchMode: fixture.matchMode,
      sortOrder: 'newest',
      pageSize: 100
    })
    ftsTimings.push(performance.now() - ftsStart)
  }
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)]
}

const likeP50 = percentile(likeTimings, 50)
const likeP95 = percentile(likeTimings, 95)
const ftsP50 = percentile(ftsTimings, 50)
const ftsP95 = percentile(ftsTimings, 95)
const likeMean = likeTimings.reduce((a, b) => a + b, 0) / likeTimings.length
const ftsMean = ftsTimings.reduce((a, b) => a + b, 0) / ftsTimings.length

console.log(
  `\n=== Performance Results (LOCK-5129) ===\n` +
    `LIKE baseline:  p50=${likeP50.toFixed(2)}ms  p95=${likeP95.toFixed(2)}ms  mean=${likeMean.toFixed(2)}ms\n` +
    `FTS hybrid:     p50=${ftsP50.toFixed(2)}ms  p95=${ftsP95.toFixed(2)}ms  mean=${ftsMean.toFixed(2)}ms\n` +
    `Speedup (p50):  ${(likeP50 / ftsP50).toFixed(2)}x\n` +
    `Speedup (p95):  ${(likeP95 / ftsP95).toFixed(2)}x\n` +
    `Samples: ${likeTimings.length} per method`
)

// ---------------------------------------------------------------------------
// Vitest bench tasks — standard tinybench comparison output
// ---------------------------------------------------------------------------

describe('search 10k corpus — LIKE vs hybrid FTS (10 query fixtures)', () => {
  afterAll(() => {
    cleanup()
  })

  bench(
    'normalized LIKE full-scan baseline',
    () => {
      for (const fixture of QUERY_FIXTURES) {
        likeSearch(sqlite, fixture.keywords, fixture.matchMode)
      }
    },
    { warmupIterations: 2, iterations: 5 }
  )

  bench(
    'hybrid FTS+LIKE (SearchRepository)',
    () => {
      for (const fixture of QUERY_FIXTURES) {
        searchRepo.search({
          keywords: fixture.keywords,
          matchMode: fixture.matchMode,
          sortOrder: 'newest',
          pageSize: 100
        })
      }
    },
    { warmupIterations: 2, iterations: 5 }
  )
})
