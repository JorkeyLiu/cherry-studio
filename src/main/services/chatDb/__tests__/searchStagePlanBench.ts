/**
 * Search fetch query-plan attribution benchmark — pure helpers.
 *
 * On-demand diagnostic companion that compiles the production-shaped
 * no-cursor search fetch SQL (`SearchRepository.fetchResults` newest path:
 * normalized block join block/message/topic, IN exact block IDs, ORDER BY
 * m.created_at DESC, m.id DESC, nb.block_id DESC, LIMIT pageSize+1) with
 * EXPLAIN QUERY PLAN and EXPLAIN twice per fixture and emits ONLY bounded
 * classified numeric structure plus deterministic correctness gates.
 *
 * This module is the pure, side-effect-free half of that benchmark:
 *
 *   - gate + scale validation (deterministic, fail-loud on unknown input so a
 *     misconfigured run can never silently run — or skip — the diagnostic),
 *   - the shape-agnostic, privacy-safe plan classifier: EXPLAIN QUERY PLAN
 *     rows are classified into finite `search` / `scan` /
 *     `tempBtreeOrderBy` / `other` counts and EXPLAIN bytecode rows into
 *     finite `openEphemeral` / `sort` / `sorter` / `makeRecord` / `idxInsert`
 *     / `resultRow` / `seek` / `other` counts. Raw planner detail strings,
 *     p4 payloads, and comments are read transiently and discarded — only the
 *     bounded counts survive. The classifier never asserts a specific plan
 *     shape (e.g. searches===4 / scans===0 / tempBtree===1): those are
 *     observations that future legitimate plan changes may alter.
 *   - the repeated-run determinism comparison (EXPLAIN/EQP run 1 vs run 2
 *     must classify identically),
 *   - the classifier invariant check (bucket sums equal totals; every count a
 *     finite non-negative integer) and the fail-fast sample/classifier
 *     completeness guard that runs before artifact construction,
 *   - the deterministic per-fixture metric grid builder (exactCount + EQP and
 *     opcode classification rows, 15 rows per fixture).
 *
 * The schema-v1 artifact records NO timing metrics and NO timing gates: this
 * diagnostic is structural, not a measurement. The bench file registers one
 * tinybench task solely so the artifact is emitted only after every registered
 * task completed successfully (audit F1 completion emission); that task's
 * tinybench comparison timing is incidental and is never recorded in the
 * artifact.
 *
 * This file is intentionally NOT a *.test.ts / *.bench.ts file so it is never
 * collected directly by Vitest. It imports only type-only native modules and
 * the existing pure search bench helpers, so the focused unit tests stay in
 * the core lane (`pnpm test:main:core`).
 */

import type { BenchmarkMetric } from './benchResult'
import type { SearchBenchProfileKey } from './searchBenchHarness'
import { QUERY_FIXTURES, SEARCH_BENCH_PROFILES } from './searchBenchHarness'
import type { SearchFixtureDescriptor } from './searchBenchMetrics'

// ---------------------------------------------------------------------------
// Env gate — the diagnostic runs ONLY when explicitly enabled
// ---------------------------------------------------------------------------

/** Environment variable that enables the on-demand fetch query-plan benchmark. */
export const SEARCH_STAGE_PLAN_BENCH_ENV = 'SEARCH_STAGE_PLAN_BENCH'

/**
 * Deterministically resolve the SEARCH_STAGE_PLAN_BENCH gate.
 *
 * - unset / empty / whitespace-only → disabled (the default; the diagnostic
 *   benchmark body never runs and no corpus/artifact side effects occur);
 * - `1` or `true` (case-insensitive) → enabled;
 * - any other non-empty value → throws loudly, so a misconfigured gate can
 *   never silently run — or silently skip — the diagnostic.
 */
export function resolveSearchStagePlanGate(value: string | undefined): boolean {
  if (value === undefined || value.trim().length === 0) return false
  const normalized = value.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true') return true
  throw new Error(
    `SEARCH_STAGE_PLAN_BENCH must be '1'/'true' to enable or unset/empty to skip ` +
      `(got '${value}'). Enable only through the canonical \`pnpm bench:search-stage-plan\` script.`
  )
}

// ---------------------------------------------------------------------------
// Scale — the plan benchmark is a 50k-only diagnostic
// ---------------------------------------------------------------------------

/** The only corpus profile the fetch query-plan benchmark may attribute. */
export const SEARCH_STAGE_PLAN_PROFILE_KEY: SearchBenchProfileKey = '50k'

/**
 * Deterministically resolve the corpus profile for the plan benchmark.
 *
 * The diagnostic attributes a fixed 50k fixture cost; 50k is both the default
 * (unset/empty) and the only accepted explicit value. Any other profile
 * (1k/10k/unknown) throws loudly instead of planning a different scale than
 * the operator requested — the diagnostic never silently degrades to a
 * smaller corpus.
 */
export function resolveSearchStagePlanScale(value: string | undefined): SearchBenchProfileKey {
  if (value === undefined || value.trim().length === 0) return SEARCH_STAGE_PLAN_PROFILE_KEY
  const key = value.trim()
  if (key === SEARCH_STAGE_PLAN_PROFILE_KEY) return SEARCH_STAGE_PLAN_PROFILE_KEY
  throw new Error(
    `The search fetch query-plan benchmark only supports the 50k profile ` +
      `(SEARCH_BENCH_SCALE='50k' or unset); got '${value}'.`
  )
}

// ---------------------------------------------------------------------------
// Fixed dimensions, identity, and provenance
// ---------------------------------------------------------------------------

/** Page size of the production-shaped no-cursor fetch query being planned. */
export const SEARCH_STAGE_PLAN_PAGE_SIZE = 100

/** Repeated EXPLAIN / EXPLAIN QUERY PLAN runs per fixture (determinism check). */
export const SEARCH_STAGE_PLAN_PLANNER_RUNS = 2

/** Stable schema-v1 artifact id — separate from the search bench profile ids. */
export const SEARCH_STAGE_PLAN_BENCH_ID = 'chatdb-search-stage-plan-50k'

/** Human-readable benchmark name carried in the schema-v1 artifact. */
export const SEARCH_STAGE_PLAN_BENCH_NAME =
  'Search — 50k corpus fetch query-plan structure attribution (bounded classified counts)'

/** Explicit safe canonical command recorded in the artifact `environment.command`. */
export const SEARCH_STAGE_PLAN_COMMAND = 'pnpm bench:search-stage-plan'

// ---------------------------------------------------------------------------
// Shape-agnostic plan classification (privacy-safe: only counts survive)
// ---------------------------------------------------------------------------

/**
 * Minimal row shape read from `EXPLAIN QUERY PLAN` output. Only the `detail`
 * string is consulted (the SQLite EQP columns are `id` / `parent` / `notused`
 * / `detail`); it is stringified defensively so the classifier is
 * shape-agnostic across SQLite versions. The raw detail string is used only
 * for the in-memory category decision and is never retained or emitted.
 */
export interface ExplainQueryPlanRow {
  detail?: unknown
}

/** Same idea for `EXPLAIN` bytecode rows: only the `opcode` column is read. */
export interface ExplainBytecodeRow {
  opcode?: unknown
}

/**
 * Finite bounded classification of one EXPLAIN QUERY PLAN result.
 *
 * The named buckets are keyword-prefix categories only; every row that does
 * not match a known category lands in `other`, so `total` always equals
 * `search + scan + tempBtreeOrderBy + other`. No assertion is made about any
 * individual bucket value — those are observations, not thresholds.
 */
export interface EqpClassification {
  total: number
  search: number
  scan: number
  tempBtreeOrderBy: number
  other: number
}

/**
 * Finite bounded classification of one EXPLAIN bytecode result.
 *
 * `sort` counts the exact `Sort` opcode, `sorter` counts every `Sorter*`
 * family opcode, and `seek` counts every `Seek*` family opcode; the buckets
 * are pairwise disjoint and every unmatched opcode lands in `other`, so
 * `total` always equals the sum of all buckets.
 */
export interface OpcodeClassification {
  total: number
  openEphemeral: number
  sort: number
  sorter: number
  makeRecord: number
  idxInsert: number
  resultRow: number
  seek: number
  other: number
}

/**
 * Classify EXPLAIN QUERY PLAN rows into bounded finite counts.
 *
 * Category decision (in order): `SEARCH ...` → search, `SCAN ...` → scan,
 * `USE TEMP B-TREE FOR ORDER BY` → tempBtreeOrderBy, anything else → other.
 * Every row is counted exactly once (total === rows.length) and the raw
 * detail strings are discarded after classification.
 */
export function classifyExplainQueryPlanRows(rows: readonly ExplainQueryPlanRow[]): EqpClassification {
  let search = 0
  let scan = 0
  let tempBtreeOrderBy = 0
  let other = 0
  for (const row of rows) {
    const detail = row.detail === undefined || row.detail === null ? '' : String(row.detail)
    if (detail.startsWith('SEARCH')) {
      search += 1
    } else if (detail.startsWith('SCAN')) {
      scan += 1
    } else if (detail.includes('USE TEMP B-TREE FOR ORDER BY')) {
      tempBtreeOrderBy += 1
    } else {
      other += 1
    }
  }
  return { total: rows.length, search, scan, tempBtreeOrderBy, other }
}

/**
 * Classify EXPLAIN bytecode rows into bounded finite counts.
 *
 * Category decision (exact/prefix match): `OpenEphemeral` → openEphemeral,
 * `Sort` → sort, `Sorter*` → sorter, `MakeRecord` → makeRecord, `IdxInsert` →
 * idxInsert, `ResultRow` → resultRow, `Seek*` → seek, anything else → other.
 * Every row is counted exactly once (total === rows.length) and the raw
 * opcode strings are discarded after classification.
 */
export function classifyExplainBytecodeRows(rows: readonly ExplainBytecodeRow[]): OpcodeClassification {
  let openEphemeral = 0
  let sort = 0
  let sorter = 0
  let makeRecord = 0
  let idxInsert = 0
  let resultRow = 0
  let seek = 0
  let other = 0
  for (const row of rows) {
    const opcode = row.opcode === undefined || row.opcode === null ? '' : String(row.opcode)
    if (opcode === 'OpenEphemeral') {
      openEphemeral += 1
    } else if (opcode === 'Sort') {
      sort += 1
    } else if (opcode.startsWith('Sorter')) {
      sorter += 1
    } else if (opcode === 'MakeRecord') {
      makeRecord += 1
    } else if (opcode === 'IdxInsert') {
      idxInsert += 1
    } else if (opcode === 'ResultRow') {
      resultRow += 1
    } else if (opcode.startsWith('Seek')) {
      seek += 1
    } else {
      other += 1
    }
  }
  return { total: rows.length, openEphemeral, sort, sorter, makeRecord, idxInsert, resultRow, seek, other }
}

/**
 * Per-fixture planner collection: the two repeated EXPLAIN QUERY PLAN runs and
 * the two repeated EXPLAIN bytecode runs, plus the exact block count the
 * production no-cursor query plans over. Run 1 is the reported representative
 * for metrics; run 2 exists solely for the repeated-plan determinism gate.
 */
export interface SearchStagePlanFixtureClassification {
  exactCount: number
  eqpRun1: EqpClassification
  eqpRun2: EqpClassification
  opcodeRun1: OpcodeClassification
  opcodeRun2: OpcodeClassification
}

/** Readonly per-fixture planner grid consumed by the metric builder. */
export type SearchStagePlanClassifications = ReadonlyMap<string, Readonly<SearchStagePlanFixtureClassification>>

function classificationsEqual<T extends object>(a: T, b: T): boolean {
  const aEntries = Object.entries(a)
  const bEntries = Object.entries(b)
  if (aEntries.length !== bEntries.length) return false
  for (const [key, value] of aEntries) {
    if ((b as Record<string, unknown>)[key] !== value) return false
  }
  return true
}

/**
 * True when both EXPLAIN runs of a fixture classify identically (EQP and
 * bytecode independently). Repeated-plan classification determinism is a
 * gateable property; the plan itself is not.
 */
export function searchPlanRunsIdentical(plan: Readonly<SearchStagePlanFixtureClassification>): {
  eqp: boolean
  opcode: boolean
} {
  return {
    eqp: classificationsEqual(plan.eqpRun1, plan.eqpRun2),
    opcode: classificationsEqual(plan.opcodeRun1, plan.opcodeRun2)
  }
}

// ---------------------------------------------------------------------------
// Classifier invariants — bucket sums must equal totals, counts finite
// ---------------------------------------------------------------------------

/**
 * Structural invariants for an EQP classification: the named bucket sum must
 * equal `total` (full classification coverage) and every count must be a
 * finite non-negative integer. Returns the violation messages (empty list =
 * valid).
 */
export function eqpClassificationInvariantErrors(c: EqpClassification): string[] {
  const problems: string[] = []
  const namedSum = c.search + c.scan + c.tempBtreeOrderBy + c.other
  if (namedSum !== c.total) {
    problems.push(`EQP bucket sum ${namedSum} != total ${c.total}`)
  }
  for (const [key, value] of Object.entries(c)) {
    if (!Number.isInteger(value) || value < 0) {
      problems.push(`EQP count '${key}' is not a finite non-negative integer: ${value}`)
    }
  }
  return problems
}

/**
 * Structural invariants for an opcode classification: the named bucket sum
 * must equal `total` and every count must be a finite non-negative integer.
 * Returns the violation messages (empty list = valid).
 */
export function opcodeClassificationInvariantErrors(c: OpcodeClassification): string[] {
  const problems: string[] = []
  const namedSum = c.openEphemeral + c.sort + c.sorter + c.makeRecord + c.idxInsert + c.resultRow + c.seek + c.other
  if (namedSum !== c.total) {
    problems.push(`opcode bucket sum ${namedSum} != total ${c.total}`)
  }
  for (const [key, value] of Object.entries(c)) {
    if (!Number.isInteger(value) || value < 0) {
      problems.push(`opcode count '${key}' is not a finite non-negative integer: ${value}`)
    }
  }
  return problems
}

/** Combined invariant violations across all four stored classifications of a fixture. */
export function planInvariantErrors(plan: Readonly<SearchStagePlanFixtureClassification>): string[] {
  return [
    ...eqpClassificationInvariantErrors(plan.eqpRun1),
    ...eqpClassificationInvariantErrors(plan.eqpRun2),
    ...opcodeClassificationInvariantErrors(plan.opcodeRun1),
    ...opcodeClassificationInvariantErrors(plan.opcodeRun2)
  ]
}

// ---------------------------------------------------------------------------
// Metric grid builder
// ---------------------------------------------------------------------------

/**
 * The fixture id is embedded verbatim in metric ids, so it must be a stable
 * ASCII id — lowercase letters/digits, hyphen-separated segments only.
 */
const FIXTURE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function validateFixtureId(fixtureId: string): void {
  if (!FIXTURE_ID_PATTERN.test(fixtureId)) {
    throw new Error(
      `buildSearchStagePlanMetrics: fixture id '${fixtureId}' is not a stable ASCII id ` +
        `(must match ${FIXTURE_ID_PATTERN})`
    )
  }
}

/**
 * Build the per-fixture plan metric rows in deterministic order: fixtures in
 * the order given, then per fixture `exactCount` plus the EQP rows (`total`,
 * `search`, `scan`, `tempBtreeOrderBy`, `other`) plus the opcode rows
 * (`total`, `openEphemeral`, `sort`, `sorter`, `makeRecord`, `idxInsert`,
 * `resultRow`, `seek`, `other`) — 15 unitless finite count rows per fixture
 * (150 rows for the 10 stable fixtures). Metric ids are
 * `fixture.<fixtureId>.<row>` and are unique by construction. Missing fixture
 * entries, duplicate fixture ids, or non-ASCII fixture ids fail fast. The
 * reported classification is run 1 (run 2 is verified identical by the
 * `plan.repeat-determinism` gate). Raw planner strings never enter metric
 * names — only static category labels and fixture names.
 */
export function buildSearchStagePlanMetrics(
  fixtures: readonly SearchFixtureDescriptor[],
  plans: SearchStagePlanClassifications
): BenchmarkMetric[] {
  const metrics: BenchmarkMetric[] = []
  const seenIds = new Set<string>()
  for (const fixture of fixtures) {
    validateFixtureId(fixture.id)
    if (seenIds.has(fixture.id)) {
      throw new Error(`buildSearchStagePlanMetrics: duplicate fixture id '${fixture.id}'`)
    }
    seenIds.add(fixture.id)
    const plan = plans.get(fixture.id)
    if (plan === undefined) {
      throw new Error(`buildSearchStagePlanMetrics: no classification recorded for fixture '${fixture.id}'`)
    }
    const eqp = plan.eqpRun1
    const opcode = plan.opcodeRun1
    const prefix = `fixture.${fixture.id}`
    metrics.push({
      id: `${prefix}.exactCount`,
      name: `Fixture ${fixture.name} exact block count`,
      value: plan.exactCount
    })
    metrics.push({
      id: `${prefix}.eqpTotal`,
      name: `Fixture ${fixture.name} EXPLAIN QUERY PLAN total rows`,
      value: eqp.total
    })
    metrics.push({
      id: `${prefix}.eqpSearch`,
      name: `Fixture ${fixture.name} EXPLAIN QUERY PLAN SEARCH rows`,
      value: eqp.search
    })
    metrics.push({
      id: `${prefix}.eqpScan`,
      name: `Fixture ${fixture.name} EXPLAIN QUERY PLAN SCAN rows`,
      value: eqp.scan
    })
    metrics.push({
      id: `${prefix}.eqpTempBtreeOrderBy`,
      name: `Fixture ${fixture.name} EXPLAIN QUERY PLAN temp-btree-for-order-by rows`,
      value: eqp.tempBtreeOrderBy
    })
    metrics.push({
      id: `${prefix}.eqpOther`,
      name: `Fixture ${fixture.name} EXPLAIN QUERY PLAN other rows`,
      value: eqp.other
    })
    metrics.push({
      id: `${prefix}.opcodeTotal`,
      name: `Fixture ${fixture.name} EXPLAIN opcode total`,
      value: opcode.total
    })
    metrics.push({
      id: `${prefix}.opcodeOpenEphemeral`,
      name: `Fixture ${fixture.name} EXPLAIN opcode OpenEphemeral count`,
      value: opcode.openEphemeral
    })
    metrics.push({
      id: `${prefix}.opcodeSort`,
      name: `Fixture ${fixture.name} EXPLAIN opcode Sort count`,
      value: opcode.sort
    })
    metrics.push({
      id: `${prefix}.opcodeSorter`,
      name: `Fixture ${fixture.name} EXPLAIN opcode Sorter-family count`,
      value: opcode.sorter
    })
    metrics.push({
      id: `${prefix}.opcodeMakeRecord`,
      name: `Fixture ${fixture.name} EXPLAIN opcode MakeRecord count`,
      value: opcode.makeRecord
    })
    metrics.push({
      id: `${prefix}.opcodeIdxInsert`,
      name: `Fixture ${fixture.name} EXPLAIN opcode IdxInsert count`,
      value: opcode.idxInsert
    })
    metrics.push({
      id: `${prefix}.opcodeResultRow`,
      name: `Fixture ${fixture.name} EXPLAIN opcode ResultRow count`,
      value: opcode.resultRow
    })
    metrics.push({
      id: `${prefix}.opcodeSeek`,
      name: `Fixture ${fixture.name} EXPLAIN opcode Seek-family count`,
      value: opcode.seek
    })
    metrics.push({
      id: `${prefix}.opcodeOther`,
      name: `Fixture ${fixture.name} EXPLAIN opcode other count`,
      value: opcode.other
    })
  }
  return metrics
}

// ---------------------------------------------------------------------------
// Fail-fast sample/classifier completeness guard
// ---------------------------------------------------------------------------

/** Recorded outcome of a successful completeness + invariant validation. */
export interface SearchStagePlanSampleValidation {
  /** Always `true` — the guard throws before returning on any mismatch. */
  ok: true
  /** Every fixture id verified to hold a complete, invariant-clean classification. */
  verifiedFixtures: readonly string[]
  /** The exact fixture count the guard validated against. */
  expectedFixtureCount: number
  /** True when every fixture's EQP/opcode bucket sums equal their totals. */
  invariantsVerified: boolean
}

/**
 * Fail-fast sample/classifier completeness guard: every fixture must have a
 * recorded classification whose exactCount is a finite non-negative integer
 * and whose EQP/opcode bucket sums equal their totals (full classification
 * coverage), before any artifact is built. Wired into the bench file after
 * planner collection and before result construction, so a missing or
 * degenerate fixture aborts instead of emitting a misleading artifact.
 *
 * Returns the recorded validation outcome (the verified fixture ids, the
 * expected fixture count, and the invariant verification result) so the
 * artifact's `plan.classifier-complete` and `plan.classifier-invariants`
 * gates can report the actual validation result instead of a hardcoded
 * constant. The original assertion error is NOT swallowed: a mismatch still
 * throws before anything is returned, and because the guard runs before
 * artifact emission a false gate can never be written.
 */
export function assertSearchStagePlanCompleteness(
  fixtures: readonly SearchFixtureDescriptor[],
  plans: SearchStagePlanClassifications
): SearchStagePlanSampleValidation {
  for (const fixture of fixtures) {
    const plan = plans.get(fixture.id)
    if (plan === undefined) {
      throw new Error(`assertSearchStagePlanCompleteness: no classification recorded for fixture '${fixture.id}'`)
    }
    if (!Number.isInteger(plan.exactCount) || plan.exactCount < 0) {
      throw new Error(
        `assertSearchStagePlanCompleteness: fixture '${fixture.id}' exactCount is not a finite non-negative integer: ${plan.exactCount}`
      )
    }
    const invariantProblems = planInvariantErrors(plan)
    if (invariantProblems.length > 0) {
      throw new Error(
        `assertSearchStagePlanCompleteness: fixture '${fixture.id}' classifier invariants violated: ` +
          invariantProblems.join('; ')
      )
    }
  }
  return {
    ok: true,
    verifiedFixtures: fixtures.map((fixture) => fixture.id),
    expectedFixtureCount: fixtures.length,
    invariantsVerified: true
  }
}

/**
 * Fail-fast corpus non-vacuity guard (audit F1): the normalized
 * `message_blocks_normalized` row count must exactly equal the profile's
 * expected block count, and at least one fixture must record a positive exact
 * block count, before any artifact is built. An empty or truncated corpus
 * would otherwise emit an all-zero artifact whose parity/duplicate gates pass
 * vacuously; this guard makes that impossible by aborting first.
 *
 * Wired into the bench file immediately after the completeness guard, before
 * the metric grid and artifact are constructed. Throws on the first violated
 * condition; returns nothing on success.
 */
export function assertSearchStagePlanNonVacuity(
  normalizedRows: number,
  expectedBlocks: number,
  plans: SearchStagePlanClassifications
): void {
  if (normalizedRows !== expectedBlocks) {
    throw new Error(
      `assertSearchStagePlanNonVacuity: normalized message_blocks_normalized row count ${normalizedRows} ` +
        `does not equal the expected profile block count ${expectedBlocks}`
    )
  }
  const hasPositiveExactCount = [...plans.values()].some((plan) => plan.exactCount > 0)
  if (!hasPositiveExactCount) {
    throw new Error(
      'assertSearchStagePlanNonVacuity: no fixture recorded a positive exact block count — the run is vacuously empty'
    )
  }
}

/** The real harness fixtures as stable ASCII descriptors (id = name). */
export const SEARCH_STAGE_PLAN_FIXTURES: SearchFixtureDescriptor[] = QUERY_FIXTURES.map((fixture) => ({
  id: fixture.name,
  name: fixture.name
}))

/** Scale metadata contributed by the deterministic 50k corpus profile. */
export function searchStagePlanScale(): { blocks: number; profileCode: number } {
  const profile = SEARCH_BENCH_PROFILES[SEARCH_STAGE_PLAN_PROFILE_KEY]
  return { blocks: profile.blocks, profileCode: profile.profileCode }
}
