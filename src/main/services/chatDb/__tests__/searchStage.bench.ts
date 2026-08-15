/**
 * Search Stage Attribution Benchmark — On-Demand Diagnostic (50k fixture)
 *
 * MEASUREMENT-ONLY (PERF-LOCK-003/007): attributes the deterministic 50k
 * fixture cost to the SearchRepository stages (collectCandidates /
 * applyExactFilter / fetchResults) with enough samples for a meaningful p95.
 * No production SQL/search behavior, index, schema, threshold, 120k, or CI
 * change; no wrappers/proxies are added to production code. The existing
 * search.bench.ts and its artifact contract are untouched.
 *
 * ENV-GATED (default skip): the diagnostic body runs ONLY when
 * `SEARCH_STAGE_BENCH=1` is set (the canonical `pnpm bench:search-stage`
 * script sets the gate + the 50k profile). Under the default
 * `pnpm bench:main:native` the file registers a single SKIPPED task and
 * performs ZERO setup — no temp DB, no corpus, no migrations, no artifact.
 *
 *   SEARCH_STAGE_BENCH=1 SEARCH_BENCH_SCALE=50k \
 *     pnpm native:run node -- vitest bench --run --project main-native \
 *       src/main/services/chatDb/__tests__/searchStage.bench.ts
 *   # or simply: pnpm bench:search-stage
 *
 * METHODOLOGY (instrumentation semantics):
 *  - A typed bench-only bridge (`stageBridge`) calls the private stage methods
 *    directly. TypeScript `private` members are ordinary prototype methods at
 *    runtime (search.test.ts already spies on them), so the single cast
 *    exposes the exact production method bodies — the bridge contains no
 *    wrapper or proxy inside any timed body.
 *  - Each measured round runs, per fixture, in a FIXED interleaving:
 *      1. `whole`  — production `search()` (parseKeywords → collectCandidates
 *                    → applyExactFilter → fetchResults), newest sort,
 *                    pageSize 100, no cursor;
 *      2. `like`   — the normalized LIKE full-scan semantic baseline;
 *      3. bridge   — parseKeywords (not timed individually) then the three
 *                    timed stages collectCandidates / applyExactFilter /
 *                    fetchResults in exact production order with the same
 *                    newest/pageSize-100/no-cursor parameters;
 *      4. fetch split — immediately after the bridge `fetchResults` window,
 *         the same filtered set is re-fetched through a bench-only
 *         `fetchResultsSplit` helper that reproduces the production no-cursor
 *         fetch query/result assembly and records three separate windows:
 *         `fetch-prepare` (ids array + dynamic IN SQL build + prepare()),
 *         `fetch-execute-materialize` (the statement.all() call: SQLite
 *         execute/order + native row materialization), and `fetch-assemble`
 *         (hasMore/slice/map/cursor-encode/response construction). Sorting is
 *         intentionally NOT measured as a separate candidate-sort window — it
 *         happens inside the SQLite ORDER BY within
 *         `fetch-execute-materialize`.
 *    `whole` and `like` are recorded in the same round as the stages so the
 *    fidelity metric is a same-round comparison.
 *  - Fidelity = per-round (collect + filter + fetch) − whole; it quantifies
 *    the combined bridge recomposition cost + per-stage call boundaries over
 *    the pooled production call. `parseKeywords` is excluded from the stage
 *    sum (it is not timed individually), so its cost is absorbed into the
 *    delta — no parse timing is added. Statement/cache state is exactly what
 *    production methods use (the same prepared statements, same order), so
 *    the stage samples and the whole sample share comparable cache warmth.
 *    Stage sub-work inside the FTS/LIKE candidate loops and the batch
 *    IN-query loop remains intentionally indivisible.
 *  - Fetch attribution = per-round (fetch-prepare + fetch-execute-materialize
 *    + fetch-assemble) − fetch; the split covers exactly the production fetch
 *    work, so the delta quantifies the split/measurement boundary overhead
 *    (finite, may be negative). The split response is parity-checked against
 *    the production bridge fetchResults (ordered items, cursor, hasMore,
 *    totalCount) BEFORE timing; the split helper only implements the
 *    no-cursor path the benchmark actually measures and fails loudly on any
 *    other input.
 *  - 5 warmup rounds + 50 measured rounds per fixture; the exact sample
 *    counts are asserted BEFORE any metric or artifact is built (fail-fast).
 *  - Complete ordered parity (hybrid cursor-drained vs LIKE baseline, all
 *    10 fixtures, no duplicates) plus bridge-vs-search first-page parity and
 *    fetch-split-vs-bridge first-page parity run BEFORE any timing; a failure
 *    aborts with no artifact.
 *  - Candidate/exact counts are recorded as non-sensitive numeric context
 *    metrics; message content and paths are never represented.
 *
 * Artifact: schema-v1 (`benchResult.ts` closed contract), stable id
 * `chatdb-search-stage-50k`, emitted only after every registered tinybench
 * task completed successfully (audit F1). The `samples.complete` gate
 * records the sample-count guard's actual validation outcome. The
 * `environment.command` is the explicit canonical `pnpm bench:search-stage`
 * (never argv-derived).
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

import type { SearchMessagesResponse, SearchResultItem } from '@shared/chatDb'
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
  assertSearchStageSampleCounts,
  buildSearchStageMetrics,
  deriveFetchAttributionSamples,
  resolveSearchStageGate,
  resolveSearchStageScale,
  SEARCH_STAGE_BENCH_ENV,
  SEARCH_STAGE_BENCH_ID,
  SEARCH_STAGE_BENCH_NAME,
  SEARCH_STAGE_COMMAND,
  SEARCH_STAGE_FIXTURES,
  SEARCH_STAGE_MEASURE_ROUNDS,
  SEARCH_STAGE_PAGE_SIZE,
  SEARCH_STAGE_WARMUP_ROUNDS,
  type SearchStageFixtureCounts,
  type SearchStageFixtureSamples,
  type StageRoundSamples
} from './searchStageBench'

// ---------------------------------------------------------------------------
// Env gate — the diagnostic body is inert unless explicitly enabled
// ---------------------------------------------------------------------------

const stageEnabled = resolveSearchStageGate(process.env[SEARCH_STAGE_BENCH_ENV])

if (!stageEnabled) {
  // Default collection: zero setup (no temp DB, no corpus, no migrations, no
  // artifact) and a single self-documenting skipped task. Run the diagnostic
  // only through the canonical `pnpm bench:search-stage` script.
  describe('search stage attribution (on-demand diagnostic)', () => {
    bench.skip(
      'stage attribution skipped — enable via pnpm bench:search-stage (SEARCH_STAGE_BENCH=1 + 50k profile)',
      () => {}
    )
  })
} else {
  // -------------------------------------------------------------------------
  // Setup — deterministic 50k corpus (reused from searchBenchHarness)
  // -------------------------------------------------------------------------

  const scaleKey = resolveSearchStageScale(process.env[SEARCH_BENCH_SCALE_ENV])
  const profile = SEARCH_BENCH_PROFILES[scaleKey]

  const tempDir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-stage-bench-'))
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
    `\n=== Search Stage Attribution (on-demand diagnostic) ===\n` +
      `Profile: ${scaleKey} (${SEARCH_BENCH_SCALE_ENV}=${scaleKey}, ${SEARCH_STAGE_BENCH_ENV}=1)\n` +
      `Blocks: ${profile.blocks.toLocaleString('en-US')}\n` +
      `Normalized rows: ${normalizedSize.count}\n` +
      `FTS rows: ${ftsSize.count}\n` +
      `Build time: ${buildTime.toFixed(1)}ms\n` +
      `Rounds: ${SEARCH_STAGE_WARMUP_ROUNDS} warmup + ${SEARCH_STAGE_MEASURE_ROUNDS} measured per fixture`
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

  interface SearchStageBridge {
    parseKeywords(keywords: string): string[]
    collectCandidates(terms: string[]): Set<string>
    applyExactFilter(candidateIds: Set<string>, terms: string[], matchMode: 'whole-word' | 'substring'): Set<string>
    fetchResults(
      blockIds: Set<string>,
      sortOrder: 'newest' | 'oldest',
      pageSize: number,
      cursor: { createdAt: string; messageId: string; blockId: string } | null
    ): SearchMessagesResponse
    encodeCursor(createdAt: string, messageId: string, blockId: string): string
  }

  /** Single cast exposing the exact production prototype methods; no wrapper. */
  function stageBridge(repo: SearchRepository): SearchStageBridge {
    return repo as unknown as SearchStageBridge
  }

  const bridge = stageBridge(searchRepo)

  // -------------------------------------------------------------------------
  // Fetch split — bench-only reproduction of the no-cursor fetch path
  // -------------------------------------------------------------------------

  /** The three separate timing windows recorded by `fetchResultsSplit`. */
  interface FetchSplitTiming {
    prepareMs: number
    executeMaterializeMs: number
    assembleMs: number
  }

  interface FetchSplitOutcome {
    /** Full first-page response — parity-verified against the bridge fetchResults. */
    response: SearchMessagesResponse
    timing: FetchSplitTiming
  }

  /**
   * Bench-only reproduction of the private SearchRepository.fetchResults
   * no-cursor path, split into three honest timing windows:
   *
   *  1. `prepare` — ids array, sort direction, dynamic IN SQL build, and
   *     `prepare()` (statement preparation);
   *  2. `execute-materialize` — the `statement.all()` call: SQLite execute +
   *     ORDER BY + LIMIT and native row materialization;
   *  3. `assemble` — hasMore/slice/map/cursor-encode/response construction
   *     (post-return JS result assembly).
   *
   * The query text, bind order, and response shape mirror the production
   * no-cursor branch exactly (encodeCursor is the real production method via
   * the bridge), so the sum of the three windows covers the same work as the
   * whole bridge `fetchResults` call and the per-round delta
   * `(prepare + execute-materialize + assemble) − fetch` is a faithful split
   * overhead measurement. Sorting is inside the SQLite ORDER BY within the
   * execute-materialize window — there is no separate candidate-sort window.
   * Only the no-cursor path is reproduced (the benchmark never uses a cursor);
   * any other input fails loudly instead of silently measuring a different
   * path. The empty-ids short circuit mirrors production exactly.
   */
  function fetchResultsSplit(
    sqlite: Database.Database,
    encodeCursor: (createdAt: string, messageId: string, blockId: string) => string,
    blockIds: Set<string>,
    sortOrder: 'newest' | 'oldest',
    pageSize: number,
    cursor: { createdAt: string; messageId: string; blockId: string } | null
  ): FetchSplitOutcome {
    if (cursor !== null) {
      throw new Error('fetchResultsSplit: only the no-cursor path is reproduced (the benchmark never uses a cursor)')
    }
    const prepareStart = performance.now()
    const idsArray = Array.from(blockIds)
    if (idsArray.length === 0) {
      const prepareMs = performance.now() - prepareStart
      return {
        response: { items: [], hasMore: false, totalCount: 0 },
        timing: { prepareMs, executeMaterializeMs: 0, assembleMs: 0 }
      }
    }
    const sortDir = sortOrder === 'newest' ? 'DESC' : 'ASC'
    // Mirrors SearchRepository.fetchResults base query verbatim.
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
      WHERE nb.block_id IN (${idsArray.map(() => '?').join(',')})
    `
    const query = `${baseQuery} ORDER BY m.created_at ${sortDir}, m.id ${sortDir}, nb.block_id ${sortDir} LIMIT ?`
    const statement = sqlite.prepare(query)
    const prepareMs = performance.now() - prepareStart

    const executeStart = performance.now()
    const rows = statement.all(...idsArray, pageSize + 1) as Array<{
      block_id: string
      message_id: string
      topic_id: string
      topic_name: string | null
      raw_content: string
      message_created_at: string | null
    }>
    const executeMaterializeMs = performance.now() - executeStart

    const assembleStart = performance.now()
    const hasMore = rows.length > pageSize
    const pagedRows = hasMore ? rows.slice(0, pageSize) : rows
    const items: SearchResultItem[] = pagedRows.map((row) => ({
      blockId: row.block_id,
      messageId: row.message_id,
      topicId: row.topic_id,
      topicName: row.topic_name,
      rawContent: row.raw_content,
      messageCreatedAt: row.message_created_at
    }))
    let nextCursor: string | undefined
    if (hasMore && items.length > 0) {
      const last = items[items.length - 1]
      nextCursor = encodeCursor(last.messageCreatedAt ?? '', last.messageId, last.blockId)
    }
    const response: SearchMessagesResponse = { items, nextCursor, hasMore, totalCount: blockIds.size }
    const assembleMs = performance.now() - assembleStart

    return { response, timing: { prepareMs, executeMaterializeMs, assembleMs } }
  }

  // -------------------------------------------------------------------------
  // Correctness parity — mandatory, runs BEFORE any timing
  // -------------------------------------------------------------------------

  const parityErrors: string[] = []
  const bridgeParityErrors: string[] = []
  const splitParityErrors: string[] = []
  for (const fixture of QUERY_FIXTURES) {
    // Complete hybrid results across ALL cursor pages (pageSize clamp = 100)
    const hybridResults = hybridSearchAll(searchRepo, fixture.keywords, fixture.matchMode)

    // Complete LIKE semantic baseline in the production order
    const baselineBlockIds = likeSearch(sqlite, fixture.keywords, fixture.matchMode).map((r) => r.block_id)

    if (new Set(hybridResults).size !== hybridResults.length) {
      parityErrors.push(`${fixture.name}: duplicate block IDs across cursor pages`)
      continue
    }

    if (
      hybridResults.length !== baselineBlockIds.length ||
      hybridResults.some((id, idx) => id !== baselineBlockIds[idx])
    ) {
      parityErrors.push(
        `${fixture.name}: ordered parity mismatch (hybrid=${hybridResults.length}, baseline=${baselineBlockIds.length})`
      )
      continue
    }

    // Bridge recomposition must reproduce the production first page exactly.
    const terms = bridge.parseKeywords(fixture.keywords)
    const candidates = bridge.collectCandidates(terms)
    const filtered = bridge.applyExactFilter(candidates, terms, fixture.matchMode)
    const bridgePage = bridge.fetchResults(filtered, 'newest', SEARCH_STAGE_PAGE_SIZE, null)
    const prodPage = searchRepo.search({
      keywords: fixture.keywords,
      matchMode: fixture.matchMode,
      sortOrder: 'newest',
      pageSize: SEARCH_STAGE_PAGE_SIZE
    })
    const bridgeIds = bridgePage.items.map((item) => item.blockId)
    const prodIds = prodPage.items.map((item) => item.blockId)
    if (
      bridgeIds.length !== prodIds.length ||
      bridgeIds.some((id, idx) => id !== prodIds[idx]) ||
      bridgePage.nextCursor !== prodPage.nextCursor ||
      bridgePage.totalCount !== prodPage.totalCount
    ) {
      bridgeParityErrors.push(
        `${fixture.name}: bridge recomposition mismatch vs production search ` +
          `(bridge=${bridgeIds.length}/${bridgePage.totalCount} cursor=${bridgePage.nextCursor ?? 'none'}, ` +
          `prod=${prodIds.length}/${prodPage.totalCount} cursor=${prodPage.nextCursor ?? 'none'})`
      )
    }

    // The fetch split must preserve the full first-page response semantics of
    // the same bridge fetchResults call: ordered items, cursor, hasMore,
    // totalCount. This proves the split reproduces the production no-cursor
    // fetch path exactly enough for the attribution delta to be meaningful.
    const splitOutcome = fetchResultsSplit(
      sqlite,
      bridge.encodeCursor,
      filtered,
      'newest',
      SEARCH_STAGE_PAGE_SIZE,
      null
    )
    const splitPage = splitOutcome.response
    const splitIds = splitPage.items.map((item) => item.blockId)
    if (
      splitIds.length !== bridgeIds.length ||
      splitIds.some((id, idx) => id !== bridgeIds[idx]) ||
      splitPage.hasMore !== bridgePage.hasMore ||
      splitPage.totalCount !== bridgePage.totalCount ||
      splitPage.nextCursor !== bridgePage.nextCursor
    ) {
      splitParityErrors.push(
        `${fixture.name}: fetch split mismatch vs bridge fetchResults ` +
          `(split=${splitIds.length}/${splitPage.totalCount} more=${splitPage.hasMore}, ` +
          `bridge=${bridgeIds.length}/${bridgePage.totalCount} more=${bridgePage.hasMore})`
      )
    }
  }

  if (parityErrors.length > 0 || bridgeParityErrors.length > 0 || splitParityErrors.length > 0) {
    cleanup()
    throw new Error(
      `Benchmark aborted — correctness parity failed BEFORE timing:\n` +
        [...parityErrors, ...bridgeParityErrors, ...splitParityErrors].join('\n')
    )
  }

  console.log(
    `Parity: ${QUERY_FIXTURES.length}/${QUERY_FIXTURES.length} fixtures passed complete ordered parity; ` +
      `bridge recomposition and fetch split first page (items/cursor/hasMore/totalCount) match production search`
  )

  // -------------------------------------------------------------------------
  // Measurement — fixed interleaving, per round per fixture
  // -------------------------------------------------------------------------

  const samples = new Map<string, StageRoundSamples>()
  for (const fixture of QUERY_FIXTURES) {
    samples.set(fixture.name, {
      collect: [],
      filter: [],
      fetch: [],
      'fetch-prepare': [],
      'fetch-execute-materialize': [],
      'fetch-assemble': [],
      whole: [],
      like: []
    })
  }
  const counts = new Map<string, { candidateCount: number[]; exactCount: number[] }>()
  for (const fixture of QUERY_FIXTURES) {
    counts.set(fixture.name, { candidateCount: [], exactCount: [] })
  }

  // Warmup
  for (let i = 0; i < SEARCH_STAGE_WARMUP_ROUNDS; i++) {
    for (const fixture of QUERY_FIXTURES) {
      likeSearch(sqlite, fixture.keywords, fixture.matchMode)
      searchRepo.search({
        keywords: fixture.keywords,
        matchMode: fixture.matchMode,
        sortOrder: 'newest',
        pageSize: SEARCH_STAGE_PAGE_SIZE
      })
    }
  }

  // Measure — fixed interleaving per round/fixture: whole search() →
  // likeSearch → bridge stages (parseKeywords → collect → filter → fetch) →
  // fetch split (prepare → execute-materialize → assemble) on the same
  // filtered set, so the attribution delta is a same-round comparison.
  for (let round = 0; round < SEARCH_STAGE_MEASURE_ROUNDS; round++) {
    for (const fixture of QUERY_FIXTURES) {
      const fixtureSamples = samples.get(fixture.name)!
      const fixtureCounts = counts.get(fixture.name)!

      const wholeStart = performance.now()
      searchRepo.search({
        keywords: fixture.keywords,
        matchMode: fixture.matchMode,
        sortOrder: 'newest',
        pageSize: SEARCH_STAGE_PAGE_SIZE
      })
      fixtureSamples.whole.push(performance.now() - wholeStart)

      const likeStart = performance.now()
      likeSearch(sqlite, fixture.keywords, fixture.matchMode)
      fixtureSamples.like.push(performance.now() - likeStart)

      const terms = bridge.parseKeywords(fixture.keywords)
      const collectStart = performance.now()
      const candidates = bridge.collectCandidates(terms)
      fixtureSamples.collect.push(performance.now() - collectStart)

      const filterStart = performance.now()
      const filtered = bridge.applyExactFilter(candidates, terms, fixture.matchMode)
      fixtureSamples.filter.push(performance.now() - filterStart)

      const fetchStart = performance.now()
      bridge.fetchResults(filtered, 'newest', SEARCH_STAGE_PAGE_SIZE, null)
      fixtureSamples.fetch.push(performance.now() - fetchStart)

      // The fetch split measures the same filtered set in three separate
      // windows immediately after the whole bridge fetch window (comparable
      // cache warmth); the split response is thrown away here — parity was
      // proven before timing.
      const splitOutcome = fetchResultsSplit(
        sqlite,
        bridge.encodeCursor,
        filtered,
        'newest',
        SEARCH_STAGE_PAGE_SIZE,
        null
      )
      fixtureSamples['fetch-prepare'].push(splitOutcome.timing.prepareMs)
      fixtureSamples['fetch-execute-materialize'].push(splitOutcome.timing.executeMaterializeMs)
      fixtureSamples['fetch-assemble'].push(splitOutcome.timing.assembleMs)

      // Counts are read OUTSIDE the timed windows (O(1) Set.size).
      fixtureCounts.candidateCount.push(candidates.size)
      fixtureCounts.exactCount.push(filtered.size)
    }
  }

  // Fail-fast completeness guard — exact sample counts BEFORE result build.
  // The recorded validation outcome drives the artifact `samples.complete`
  // gate, so the gate reflects the actual guard result, not a constant.
  const sampleValidation = assertSearchStageSampleCounts(SEARCH_STAGE_FIXTURES, samples, SEARCH_STAGE_MEASURE_ROUNDS)

  // Count determinism + structural subset invariant (exact ⊂ candidates).
  const countErrors: string[] = []
  for (const fixture of QUERY_FIXTURES) {
    const fixtureCounts = counts.get(fixture.name)!
    const candidateCount = fixtureCounts.candidateCount[0]
    const exactCount = fixtureCounts.exactCount[0]
    if (new Set(fixtureCounts.candidateCount).size !== 1 || new Set(fixtureCounts.exactCount).size !== 1) {
      countErrors.push(`${fixture.name}: candidate/exact counts not stable across rounds`)
    }
    if (candidateCount < exactCount) {
      countErrors.push(`${fixture.name}: exact count ${exactCount} exceeds candidate count ${candidateCount}`)
    }
  }

  // -------------------------------------------------------------------------
  // Console report (per-fixture attribution)
  // -------------------------------------------------------------------------

  const stageLines = QUERY_FIXTURES.map((fixture) => {
    const fixtureSamples = samples.get(fixture.name)!
    const fixtureCounts = counts.get(fixture.name)!
    const summary = (values: number[]): string => {
      const sorted = [...values].sort((a, b) => a - b)
      const percentile = (p: number): number => {
        const idx = Math.ceil((p / 100) * sorted.length) - 1
        return sorted[Math.max(0, idx)]
      }
      return `p50=${percentile(50).toFixed(2)} p95=${percentile(95).toFixed(2)}`
    }
    return (
      `  ${fixture.name.padEnd(15)} collect ${summary(fixtureSamples.collect).padEnd(28)}` +
      `filter ${summary(fixtureSamples.filter).padEnd(28)}` +
      `fetch ${summary(fixtureSamples.fetch)}` +
      `  (candidates=${fixtureCounts.candidateCount[0]}, exact=${fixtureCounts.exactCount[0]})\n` +
      `  ${' '.repeat(15)} prep ${summary(fixtureSamples['fetch-prepare']).padEnd(28)}` +
      `exec ${summary(fixtureSamples['fetch-execute-materialize']).padEnd(28)}` +
      `asm ${summary(fixtureSamples['fetch-assemble'])}  ` +
      `fetchSplitΔ=${summary(deriveFetchAttributionSamples(fixtureSamples))}`
    )
  }).join('\n')

  console.log(
    `\n=== Stage attribution + fetch split (${SEARCH_STAGE_MEASURE_ROUNDS} rounds/fixture) ===\n${stageLines}`
  )

  // -------------------------------------------------------------------------
  // Schema-v1 artifact (closed contract) — built here, written only by the
  // file-level afterAll below after every registered task completed (audit F1)
  // -------------------------------------------------------------------------

  const stageSamples: SearchStageFixtureSamples = samples
  const stageCounts: SearchStageFixtureCounts = new Map(
    QUERY_FIXTURES.map((fixture) => {
      const fixtureCounts = counts.get(fixture.name)!
      return [
        fixture.name,
        { candidateCount: fixtureCounts.candidateCount[0], exactCount: fixtureCounts.exactCount[0] }
      ]
    })
  )

  const stageMetrics = buildSearchStageMetrics(SEARCH_STAGE_FIXTURES, stageSamples, stageCounts)

  const stageBenchmarkResult: BenchmarkResult = {
    schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
    benchmark: {
      id: SEARCH_STAGE_BENCH_ID,
      name: SEARCH_STAGE_BENCH_NAME,
      scale: {
        blocks: profile.blocks,
        profileCode: profile.profileCode,
        queryFixtures: QUERY_FIXTURES.length,
        warmupRounds: SEARCH_STAGE_WARMUP_ROUNDS,
        measureRounds: SEARCH_STAGE_MEASURE_ROUNDS,
        pageSize: SEARCH_STAGE_PAGE_SIZE
      }
    },
    environment: collectEnvironmentMetadata({ command: SEARCH_STAGE_COMMAND }),
    metrics: stageMetrics,
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
      },
      {
        id: 'parity.bridge-vs-search',
        name: 'Bridge recomposition and fetch split first page match production search (ordered items, cursor, hasMore, totalCount)',
        kind: 'correctness',
        passed: bridgeParityErrors.length === 0 && splitParityErrors.length === 0,
        detail:
          bridgeParityErrors.length === 0 && splitParityErrors.length === 0
            ? `bridge recomposition and fetch split first page match production search for all ${QUERY_FIXTURES.length} fixtures`
            : [...bridgeParityErrors, ...splitParityErrors].join('; ')
      },
      {
        id: 'samples.complete',
        name: `Exactly ${SEARCH_STAGE_MEASURE_ROUNDS} samples per fixture/stage`,
        kind: 'correctness',
        passed: sampleValidation.ok,
        detail:
          `${sampleValidation.verifiedFixtures.length}/${SEARCH_STAGE_FIXTURES.length} fixtures recorded with ` +
          `exactly ${sampleValidation.expectedCount} samples in each of ` +
          `${sampleValidation.verifiedGroups.length} groups (fail-fast guard passed before artifact build)`
      },
      {
        id: 'counts.stable',
        name: 'Candidate/exact counts stable across rounds and exact ⊆ candidates',
        kind: 'correctness',
        passed: countErrors.length === 0,
        detail: countErrors.length === 0 ? 'all fixtures stable' : countErrors.join('; ')
      }
    ]
  }

  // -------------------------------------------------------------------------
  // Vitest bench tasks — comparison output; the authoritative metrics and
  // gates are the artifact above
  // -------------------------------------------------------------------------

  describe(`search stage attribution — 50k corpus (${QUERY_FIXTURES.length} query fixtures)`, () => {
    bench(
      'whole search() — all fixtures',
      () => {
        for (const fixture of QUERY_FIXTURES) {
          searchRepo.search({
            keywords: fixture.keywords,
            matchMode: fixture.matchMode,
            sortOrder: 'newest',
            pageSize: SEARCH_STAGE_PAGE_SIZE
          })
        }
      },
      { warmupIterations: 1, iterations: 2 }
    )

    bench(
      'likeSearch baseline — all fixtures',
      () => {
        for (const fixture of QUERY_FIXTURES) {
          likeSearch(sqlite, fixture.keywords, fixture.matchMode)
        }
      },
      { warmupIterations: 1, iterations: 2 }
    )
  })

  afterAll((suite) => {
    const artifactPath = emitBenchmarkResultAfterSuccessfulTasks(suite, stageBenchmarkResult)
    if (artifactPath !== null) {
      console.log(`Result artifact: ${artifactPath}`)
    }
    cleanup()
  })
}
