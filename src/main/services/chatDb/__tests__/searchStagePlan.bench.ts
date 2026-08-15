/**
 * Search Fetch Query-Plan Attribution Benchmark — On-Demand Diagnostic (50k
 * fixture)
 *
 * STRUCTURE-ONLY (PERF-LOCK-003/007): builds the existing deterministic 50k
 * search corpus once, obtains each fixture's real exact block-id set through
 * the production-stage bridge, verifies full ordered production search parity
 * versus the LIKE baseline (all cursor pages, totalCount, no duplicates), then
 * compiles the production-shaped no-cursor fetch SQL
 * (SearchRepository.fetchResults newest path: normalized block join
 * block/message/topic, IN exact block IDs, ORDER BY m.created_at DESC, m.id
 * DESC, nb.block_id DESC, LIMIT pageSize+1) with EXPLAIN QUERY PLAN and
 * EXPLAIN twice per fixture and emits ONLY bounded classified numeric
 * structure plus deterministic correctness gates. No production SQL/search
 * behavior, index, schema, ANALYZE, cache, threshold, 120k, or CI change; no
 * wrappers/proxies are added to production code. The existing search.bench.ts
 * / searchStage.bench.ts files and their artifact contracts are untouched.
 *
 * ENV-GATED (default skip): the diagnostic body runs ONLY when
 * `SEARCH_STAGE_PLAN_BENCH=1` is set (the canonical `pnpm
 * bench:search-stage-plan` script sets the gate + the 50k profile). Under the
 * default `pnpm bench:main:native` the file registers a single SKIPPED task
 * and performs ZERO setup — no temp DB, no corpus, no migrations, no artifact.
 *
 *   SEARCH_STAGE_PLAN_BENCH=1 SEARCH_BENCH_SCALE=50k \
 *     pnpm native:run node -- vitest bench --run --project main-native \
 *       src/main/services/chatDb/__tests__/searchStagePlan.bench.ts
 *   # or simply: pnpm bench:search-stage-plan
 *
 * METHODOLOGY:
 *  - A typed bench-only bridge (`stagePlanBridge`) calls the private stage
 *    methods (parseKeywords / collectCandidates / applyExactFilter) directly.
 *    TypeScript `private` members are ordinary prototype methods at runtime,
 *    so the single cast exposes the exact production method bodies — no
 *    wrapper or proxy anywhere.
 *  - Complete ordered parity (hybrid cursor-drained vs LIKE baseline, all 10
 *    fixtures, no duplicates, bridge exact-set size vs baseline length) runs
 *    BEFORE any planner collection; a failure aborts with no artifact.
 *  - For every fixture the production-shaped no-cursor SQL is compiled (for
 *    the exact block ids) twice through EXPLAIN QUERY PLAN and twice through
 *    EXPLAIN; each result is classified IN-MEMORY into bounded finite counts
 *    and all raw planner detail/opcode strings are discarded. A fixture with
 *    an empty exact set mirrors production's fetchResults short-circuit: no
 *    query is ever compiled and every plan bucket is zero.
 *  - The repeated-run classification is compared per fixture (EQP and
 *    bytecode independently) BEFORE any result is built; divergence aborts.
 *  - Classifier invariants (bucket sums equal totals, finite non-negative
 *    counts) and sample/classifier completeness (every fixture recorded) are
 *    verified by the fail-fast guard BEFORE the artifact is constructed.
 *
 * The classified counts are DIRECTIONAL structural evidence, never
 * thresholds: no gate asserts a specific plan shape (searches===4 /
 * scans===0 / tempBtree===1 / any bucket formula). Gates cover parity,
 * duplicate-free results, repeated-plan classification determinism, sample/
 * classifier completeness, and classifier invariants only.
 *
 * Artifact: schema-v1 (`benchResult.ts` closed contract), stable id
 * `chatdb-search-stage-plan-50k`, emitted only after every registered
 * tinybench task completed successfully (audit F1). The `plan.classifier-*`
 * gates record the completeness guard's actual validation outcome. The
 * `environment.command` is the explicit canonical `pnpm
 * bench:search-stage-plan` (never argv-derived).
 */

import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterAll, bench, describe, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

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
  SEARCH_BENCH_PROFILES,
  SEARCH_BENCH_SCALE_ENV
} from './searchBenchHarness'
import {
  assertSearchStagePlanCompleteness,
  assertSearchStagePlanNonVacuity,
  buildSearchStagePlanMetrics,
  classifyExplainBytecodeRows,
  classifyExplainQueryPlanRows,
  type ExplainBytecodeRow,
  type ExplainQueryPlanRow,
  resolveSearchStagePlanGate,
  resolveSearchStagePlanScale,
  SEARCH_STAGE_PLAN_BENCH_ENV,
  SEARCH_STAGE_PLAN_BENCH_ID,
  SEARCH_STAGE_PLAN_BENCH_NAME,
  SEARCH_STAGE_PLAN_COMMAND,
  SEARCH_STAGE_PLAN_FIXTURES,
  SEARCH_STAGE_PLAN_PAGE_SIZE,
  SEARCH_STAGE_PLAN_PLANNER_RUNS,
  searchPlanRunsIdentical,
  type SearchStagePlanFixtureClassification
} from './searchStagePlanBench'

// ---------------------------------------------------------------------------
// Env gate — the diagnostic body is inert unless explicitly enabled
// ---------------------------------------------------------------------------

const planEnabled = resolveSearchStagePlanGate(process.env[SEARCH_STAGE_PLAN_BENCH_ENV])

if (!planEnabled) {
  // Default collection: zero setup (no temp DB, no corpus, no migrations, no
  // artifact) and a single self-documenting skipped task. Run the diagnostic
  // only through the canonical `pnpm bench:search-stage-plan` script.
  describe('search fetch query-plan attribution (on-demand diagnostic)', () => {
    bench.skip(
      'plan attribution skipped — enable via pnpm bench:search-stage-plan (SEARCH_STAGE_PLAN_BENCH=1 + 50k profile)',
      () => {}
    )
  })
} else {
  // -------------------------------------------------------------------------
  // Setup — deterministic 50k corpus (reused from searchBenchHarness)
  // -------------------------------------------------------------------------

  const scaleKey = resolveSearchStagePlanScale(process.env[SEARCH_BENCH_SCALE_ENV])
  const profile = SEARCH_BENCH_PROFILES[scaleKey]

  const tempDir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-plan-bench-'))
  const sqlite = new Database(realPath.join(tempDir, 'chat.db'))
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('synchronous = NORMAL')
  sqlite.pragma('busy_timeout = 5000')

  registerChatDbNormalize(sqlite)
  runMigrations(drizzle(sqlite, { schema }), sqlite)

  generateCorpus(sqlite, profile.blocks)

  const normalizedSize = sqlite.prepare('SELECT COUNT(*) as count FROM message_blocks_normalized').get() as {
    count: number
  }

  console.log(
    `\n=== Search Fetch Query-Plan Attribution (on-demand diagnostic) ===\n` +
      `Profile: ${scaleKey} (${SEARCH_BENCH_SCALE_ENV}=${scaleKey}, ${SEARCH_STAGE_PLAN_BENCH_ENV}=1)\n` +
      `Blocks: ${profile.blocks}\n` +
      `Normalized rows: ${normalizedSize.count}\n` +
      `Planner runs: ${SEARCH_STAGE_PLAN_PLANNER_RUNS} per fixture (EXPLAIN QUERY PLAN + EXPLAIN)`
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

  // -------------------------------------------------------------------------
  // Typed bench-only bridge to the private stage methods (no production edits)
  // -------------------------------------------------------------------------

  interface SearchStagePlanBridge {
    parseKeywords(keywords: string): string[]
    collectCandidates(terms: string[]): Set<string>
    applyExactFilter(candidateIds: Set<string>, terms: string[], matchMode: 'whole-word' | 'substring'): Set<string>
  }

  /** Single cast exposing the exact production prototype methods; no wrapper. */
  function stagePlanBridge(repo: SearchRepository): SearchStagePlanBridge {
    return repo as unknown as SearchStagePlanBridge
  }

  const bridge = stagePlanBridge(searchRepo)

  // -------------------------------------------------------------------------
  // Production-shaped no-cursor fetch SQL — bench-only mirror (isolation)
  // -------------------------------------------------------------------------

  /**
   * Mirrors SearchRepository.fetchResults (newest sort, no cursor) verbatim:
   * the same base query, the same ORDER BY, the same LIMIT placeholder. The
   * query text is deliberately duplicated here (isolation over deduplication)
   * so the plan diagnostic never needs a production or shared export.
   */
  function buildNoCursorFetchQuery(idsArray: readonly string[]): string {
    const placeholders = idsArray.map(() => '?').join(',')
    const baseQuery = `
      SELECT
        nb.block_id,
        nb.message_id,
        m.topic_id,
        t.name AS topic_name,
        mb.content AS raw_content,
        m.created_at AS message_created_at
      FROM message_blocks_normalized nb
      INNER JOIN message_blocks mb ON nb.block_id = mb.id
      INNER JOIN messages m ON nb.message_id = m.id
      INNER JOIN topics t ON m.topic_id = t.id
      WHERE nb.block_id IN (${placeholders})
    `
    return `${baseQuery} ORDER BY m.created_at DESC, m.id DESC, nb.block_id DESC LIMIT ?`
  }

  /**
   * Compile the production-shaped no-cursor query twice through EXPLAIN QUERY
   * PLAN and twice through EXPLAIN, classifying every result in-memory into
   * bounded finite counts (raw planner strings are discarded immediately).
   * An empty exact set mirrors the production fetchResults short-circuit —
   * the query is never compiled and every plan bucket is zero.
   */
  function collectPlannerClassifications(
    sqlite: Database.Database,
    idsArray: readonly string[],
    pageSize: number,
    exactCount: number
  ): SearchStagePlanFixtureClassification {
    if (idsArray.length === 0) {
      const emptyEqp = classifyExplainQueryPlanRows([])
      const emptyOpcode = classifyExplainBytecodeRows([])
      return {
        exactCount,
        eqpRun1: emptyEqp,
        eqpRun2: emptyEqp,
        opcodeRun1: emptyOpcode,
        opcodeRun2: emptyOpcode
      }
    }
    const query = buildNoCursorFetchQuery(idsArray)
    const eqpRuns: ReturnType<typeof classifyExplainQueryPlanRows>[] = []
    const opcodeRuns: ReturnType<typeof classifyExplainBytecodeRows>[] = []
    for (let run = 0; run < SEARCH_STAGE_PLAN_PLANNER_RUNS; run++) {
      eqpRuns.push(
        classifyExplainQueryPlanRows(
          sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...idsArray, pageSize + 1) as ExplainQueryPlanRow[]
        )
      )
      opcodeRuns.push(
        classifyExplainBytecodeRows(
          sqlite.prepare(`EXPLAIN ${query}`).all(...idsArray, pageSize + 1) as ExplainBytecodeRow[]
        )
      )
    }
    return {
      exactCount,
      eqpRun1: eqpRuns[0],
      eqpRun2: eqpRuns[1],
      opcodeRun1: opcodeRuns[0],
      opcodeRun2: opcodeRuns[1]
    }
  }

  // -------------------------------------------------------------------------
  // Correctness parity + planner collection — mandatory, runs BEFORE results
  // -------------------------------------------------------------------------

  const parityErrors: string[] = []
  const duplicateErrors: string[] = []
  const determinismErrors: string[] = []
  const plans = new Map<string, SearchStagePlanFixtureClassification>()

  for (const fixture of QUERY_FIXTURES) {
    // Complete hybrid results across ALL cursor pages (pageSize clamp = 100)
    const hybridResults = hybridSearchAll(searchRepo, fixture.keywords, fixture.matchMode)

    // Complete LIKE semantic baseline in the production order
    const baselineBlockIds = likeSearch(sqlite, fixture.keywords, fixture.matchMode).map((r) => r.block_id)

    if (new Set(hybridResults).size !== hybridResults.length) {
      duplicateErrors.push(`${fixture.name}: duplicate block IDs across cursor pages`)
    }

    if (
      hybridResults.length !== baselineBlockIds.length ||
      hybridResults.some((id, idx) => id !== baselineBlockIds[idx])
    ) {
      parityErrors.push(
        `${fixture.name}: ordered parity mismatch (hybrid=${hybridResults.length}, baseline=${baselineBlockIds.length})`
      )
    }

    // Real exact block-id set through the production private-method bridge.
    const terms = bridge.parseKeywords(fixture.keywords)
    const candidates = bridge.collectCandidates(terms)
    const filtered = bridge.applyExactFilter(candidates, terms, fixture.matchMode)

    if (filtered.size !== baselineBlockIds.length) {
      parityErrors.push(
        `${fixture.name}: bridge exact set size ${filtered.size} differs from baseline ${baselineBlockIds.length}`
      )
    }

    const plan = collectPlannerClassifications(sqlite, Array.from(filtered), SEARCH_STAGE_PLAN_PAGE_SIZE, filtered.size)
    const identical = searchPlanRunsIdentical(plan)
    if (!identical.eqp || !identical.opcode) {
      determinismErrors.push(
        `${fixture.name}: repeated EXPLAIN classification diverged (eqp=${identical.eqp}, opcode=${identical.opcode})`
      )
    }
    plans.set(fixture.name, plan)
  }

  if (parityErrors.length > 0 || duplicateErrors.length > 0 || determinismErrors.length > 0) {
    cleanup()
    throw new Error(
      `Benchmark aborted — correctness parity/duplicates/determinism failed BEFORE planner metrics:\n` +
        [...parityErrors, ...duplicateErrors, ...determinismErrors].join('\n')
    )
  }

  console.log(
    `Parity: ${QUERY_FIXTURES.length}/${QUERY_FIXTURES.length} fixtures passed complete ordered parity; ` +
      `no duplicates across cursor pages\n` +
      `Determinism: ${QUERY_FIXTURES.length}/${QUERY_FIXTURES.length} fixtures classified identically across ` +
      `${SEARCH_STAGE_PLAN_PLANNER_RUNS} repeated runs`
  )

  // -------------------------------------------------------------------------
  // Fail-fast completeness + classifier-invariant + corpus non-vacuity guards
  // BEFORE result build (audit F1: no vacuously-empty artifact can be emitted)
  // -------------------------------------------------------------------------

  const sampleValidation = assertSearchStagePlanCompleteness(SEARCH_STAGE_PLAN_FIXTURES, plans)
  assertSearchStagePlanNonVacuity(normalizedSize.count, profile.blocks, plans)

  // -------------------------------------------------------------------------
  // Console report (per-fixture bounded numeric structure only)
  // -------------------------------------------------------------------------

  const planLines = QUERY_FIXTURES.map((fixture) => {
    const plan = plans.get(fixture.name)!
    const eqp = plan.eqpRun1
    const opcode = plan.opcodeRun1
    return (
      `  ${fixture.name.padEnd(15)} exact=${plan.exactCount}  ` +
      `eqp total=${eqp.total} search=${eqp.search} scan=${eqp.scan} tempBtree=${eqp.tempBtreeOrderBy} other=${eqp.other}\n` +
      `  ${' '.repeat(15)} opcode total=${opcode.total} openEphemeral=${opcode.openEphemeral} sort=${opcode.sort} ` +
      `sorter=${opcode.sorter} makeRecord=${opcode.makeRecord} idxInsert=${opcode.idxInsert} ` +
      `resultRow=${opcode.resultRow} seek=${opcode.seek} other=${opcode.other}`
    )
  }).join('\n')

  console.log(`\n=== Per-fixture fetch query-plan classification (${QUERY_FIXTURES.length} fixtures) ===\n${planLines}`)

  // -------------------------------------------------------------------------
  // Schema-v1 artifact (closed contract) — built here, written only by the
  // file-level afterAll below after every registered task completed (audit F1)
  // -------------------------------------------------------------------------

  const planMetrics = buildSearchStagePlanMetrics(SEARCH_STAGE_PLAN_FIXTURES, plans)

  const planBenchmarkResult: BenchmarkResult = {
    schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
    benchmark: {
      id: SEARCH_STAGE_PLAN_BENCH_ID,
      name: SEARCH_STAGE_PLAN_BENCH_NAME,
      scale: {
        blocks: profile.blocks,
        profileCode: profile.profileCode,
        queryFixtures: QUERY_FIXTURES.length,
        plannerRuns: SEARCH_STAGE_PLAN_PLANNER_RUNS,
        pageSize: SEARCH_STAGE_PLAN_PAGE_SIZE
      }
    },
    environment: collectEnvironmentMetadata({ command: SEARCH_STAGE_PLAN_COMMAND }),
    metrics: planMetrics,
    gates: [
      {
        id: 'parity.ordered',
        name: 'Full ordered block-ID parity across all cursor pages (hybrid vs LIKE baseline, exact set size)',
        kind: 'correctness',
        passed: parityErrors.length === 0,
        detail: `${QUERY_FIXTURES.length}/${QUERY_FIXTURES.length} fixtures passed complete ordered parity`
      },
      {
        id: 'parity.no-duplicates',
        name: 'No duplicate block IDs across cursor pages',
        kind: 'correctness',
        passed: duplicateErrors.length === 0,
        detail: duplicateErrors.length === 0 ? 'no duplicate block IDs in any fixture' : duplicateErrors.join('; ')
      },
      {
        id: 'plan.repeat-determinism',
        name: `Repeated EXPLAIN/EQP classification identical across ${SEARCH_STAGE_PLAN_PLANNER_RUNS} runs per fixture`,
        kind: 'correctness',
        passed: determinismErrors.length === 0,
        detail:
          `${QUERY_FIXTURES.length}/${QUERY_FIXTURES.length} fixtures classified identically across ` +
          `${SEARCH_STAGE_PLAN_PLANNER_RUNS} repeated EXPLAIN runs (EQP + bytecode)`
      },
      {
        id: 'plan.classifier-complete',
        name: 'Every fixture classified with finite counts and recorded exactCount',
        kind: 'correctness',
        passed: sampleValidation.ok,
        detail:
          `${sampleValidation.verifiedFixtures.length}/${sampleValidation.expectedFixtureCount} fixtures classified ` +
          `with finite counts (fail-fast guard passed before artifact build)`
      },
      {
        id: 'plan.classifier-invariants',
        name: 'Classifier invariants hold for every fixture (bucket sums equal totals; finite non-negative counts)',
        kind: 'correctness',
        passed: sampleValidation.ok,
        detail: sampleValidation.invariantsVerified
          ? 'EQP and opcode bucket sums equal totals for all fixtures; all counts finite non-negative integers'
          : 'classifier invariants not verified'
      }
    ]
  }

  // -------------------------------------------------------------------------
  // Vitest bench task — comparison output; the authoritative metrics and
  // gates are the artifact above
  // -------------------------------------------------------------------------

  describe(`search fetch query-plan attribution — 50k corpus (${QUERY_FIXTURES.length} query fixtures)`, () => {
    bench(
      'compile + classify fetch query plan for all fixtures',
      () => {
        for (const fixture of QUERY_FIXTURES) {
          const terms = bridge.parseKeywords(fixture.keywords)
          const candidates = bridge.collectCandidates(terms)
          const filtered = bridge.applyExactFilter(candidates, terms, fixture.matchMode)
          collectPlannerClassifications(sqlite, Array.from(filtered), SEARCH_STAGE_PLAN_PAGE_SIZE, filtered.size)
        }
      },
      { warmupIterations: 1, iterations: 2 }
    )
  })

  afterAll((suite) => {
    const artifactPath = emitBenchmarkResultAfterSuccessfulTasks(suite, planBenchmarkResult)
    if (artifactPath !== null) {
      console.log(`Result artifact: ${artifactPath}`)
    }
    cleanup()
  })
}
