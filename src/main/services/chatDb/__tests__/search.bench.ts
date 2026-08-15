/**
 * Search Benchmark — Deterministic Corpus (1k / 10k) LIKE vs FTS Comparison
 *
 * LOCK-5129: Reports p50/p95 for normalized LIKE scan and hybrid FTS
 * candidate path on a deterministic corpus. Correctness parity is mandatory
 * and verified BEFORE any timing. No unstable absolute CI thresholds.
 *
 * PERF-004 first slice: the corpus profile is parameterized and selected via
 * the SEARCH_BENCH_SCALE environment variable — `1k` (fast deterministic
 * scale) or `10k` (pre-existing scale). Unset/empty selects the 10k default,
 * so `pnpm bench:main:native` behaves exactly as before. Both profiles carry
 * their scale in the schema-v1 artifact (`benchmark.scale.blocks` +
 * `scale.profileCode`, and the profile-specific benchmark id). Unknown
 * profile values fail loudly at load time; the benchmark never silently
 * measures a different scale than requested.
 *
 * Run with:
 *   npx vitest bench --run --project main-native src/main/services/chatDb/__tests__/search.bench.ts           # 10k (default)
 *   SEARCH_BENCH_SCALE=1k npx vitest bench --run --project main-native src/main/services/chatDb/__tests__/search.bench.ts
 *
 * Benchmark corpus (per profile):
 * - 1,000 or 10,000 MAIN_TEXT blocks with varied content
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
import {
  BENCH_RESULT_SCHEMA_VERSION,
  type BenchmarkResult,
  collectEnvironmentMetadata,
  emitBenchmarkResultAfterSuccessfulTasks
} from './benchResult'
import {
  generateCorpus,
  hybridSearchAll,
  likeSearch,
  QUERY_FIXTURES,
  resolveSearchBenchScale,
  SEARCH_BENCH_PROFILES,
  SEARCH_BENCH_SCALE_ENV
} from './searchBenchHarness'

// ---------------------------------------------------------------------------
// Setup — deterministic corpus (profile-selected scale, PERF-004)
// ---------------------------------------------------------------------------

const scaleKey = resolveSearchBenchScale(process.env[SEARCH_BENCH_SCALE_ENV])
const profile = SEARCH_BENCH_PROFILES[scaleKey]

const tempDir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-bench-'))
const sqlite = new Database(realPath.join(tempDir, 'chat.db'))
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')
sqlite.pragma('synchronous = NORMAL')
sqlite.pragma('busy_timeout = 5000')

registerChatDbNormalize(sqlite)
runMigrations(drizzle(sqlite, { schema }), sqlite)

const buildStart = performance.now()
generateCorpus(sqlite, profile.blocks)
const buildTime = performance.now() - buildStart

const normalizedSize = sqlite.prepare('SELECT COUNT(*) as count FROM message_blocks_normalized').get() as {
  count: number
}
const ftsSize = sqlite.prepare('SELECT COUNT(*) as count FROM message_blocks_fts').get() as { count: number }

console.log(
  `\n=== Benchmark Corpus ===\n` +
    `Profile: ${scaleKey} (${SEARCH_BENCH_SCALE_ENV}=${scaleKey})\n` +
    `Blocks: ${profile.blocks.toLocaleString('en-US')}\n` +
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
// PERF-001 machine-readable result artifact (schema v1) — the result DATA is
// built here (after the parity gate passed and the timings were collected),
// but the artifact is WRITTEN only by the file-level afterAll below, and only
// when every registered tinybench task completed successfully (audit F1).
// Parity/threshold failures already aborted collection before this point, so
// no artifact can be produced by a failed run (docs/performance-program.md
// §5.1). The tinybench tasks below are comparison output; the authoritative
// metrics and gates for this benchmark are the ones recorded here.
// ---------------------------------------------------------------------------

const searchBenchmarkResult: BenchmarkResult = {
  schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
  benchmark: {
    id: profile.id,
    name: profile.name,
    scale: {
      blocks: profile.blocks,
      profileCode: profile.profileCode,
      queryFixtures: QUERY_FIXTURES.length,
      warmupRounds: WARMUP_ROUNDS,
      measureRounds: MEASURE_ROUNDS,
      pageSize: 100
    }
  },
  environment: collectEnvironmentMetadata({ command: 'pnpm bench:main:native' }),
  metrics: [
    { id: 'like.p50', name: 'LIKE baseline p50', value: likeP50, unit: 'ms' },
    { id: 'like.p95', name: 'LIKE baseline p95', value: likeP95, unit: 'ms' },
    { id: 'like.mean', name: 'LIKE baseline mean', value: likeMean, unit: 'ms' },
    { id: 'fts.p50', name: 'Hybrid FTS p50', value: ftsP50, unit: 'ms' },
    { id: 'fts.p95', name: 'Hybrid FTS p95', value: ftsP95, unit: 'ms' },
    { id: 'fts.mean', name: 'Hybrid FTS mean', value: ftsMean, unit: 'ms' },
    { id: 'speedup.p50', name: 'LIKE/FTS speedup p50', value: likeP50 / ftsP50, unit: 'x' },
    { id: 'speedup.p95', name: 'LIKE/FTS speedup p95', value: likeP95 / ftsP95, unit: 'x' }
  ],
  gates: [
    {
      id: 'parity.ordered',
      name: 'Full ordered block-ID parity across all cursor pages',
      kind: 'correctness',
      passed: parityErrors.length === 0,
      detail: `${QUERY_FIXTURES.length}/${QUERY_FIXTURES.length} fixtures passed complete ordered parity`
    },
    {
      id: 'parity.no-duplicates',
      name: 'No duplicate block IDs across cursor pages',
      kind: 'correctness',
      passed: parityErrors.length === 0
    }
  ]
}

// ---------------------------------------------------------------------------
// Vitest bench tasks — standard tinybench comparison output
// ---------------------------------------------------------------------------

describe(`search ${scaleKey} corpus — LIKE vs hybrid FTS (${QUERY_FIXTURES.length} query fixtures)`, () => {
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

// File-level afterAll: Vitest bench mode runs file-level hooks but NOT
// describe-level hooks, and the artifact gate must observe every bench task
// above — so emission + cleanup live here. The write is gated on ALL
// registered tasks completing with state 'pass' (audit F1); a silently
// swallowed throwing task stays at 'run' and suppresses the artifact.
afterAll((suite) => {
  const artifactPath = emitBenchmarkResultAfterSuccessfulTasks(suite, searchBenchmarkResult)
  if (artifactPath !== null) {
    console.log(`Result artifact: ${artifactPath}`)
  }
  cleanup()
})
