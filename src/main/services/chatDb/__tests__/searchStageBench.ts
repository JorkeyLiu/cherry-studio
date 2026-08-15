/**
 * Search stage attribution benchmark — pure helpers.
 *
 * On-demand diagnostic companion to search.bench.ts that attributes the 50k
 * fixture cost to the private SearchRepository stages (collectCandidates /
 * applyExactFilter / fetchResults) with enough samples for a meaningful p95.
 * This module is the pure, side-effect-free half of that benchmark:
 *
 *   - gate + scale + round validation (deterministic, fail-loud on unknown
 *     input so a misconfigured run can never measure the wrong thing),
 *   - the deterministic per-fixture metric grid builder (stages, whole/like,
 *     fidelity, candidate/exact counts),
 *   - the fidelity arithmetic (per-round stageSum-minus-whole deltas;
 *     `parseKeywords` is excluded from the stage sum and therefore absorbed
 *     into the delta — no parse timing is added),
 *   - the sample-count fail-fast guard that runs before artifact construction.
 *
 * This file is intentionally NOT a *.test.ts / *.bench.ts file so it is never
 * collected directly by Vitest. It imports only type-only native modules and
 * the existing pure search bench helpers, so the focused unit tests stay in
 * the core lane (`pnpm test:main:core`).
 */

import type { BenchmarkMetric } from './benchResult'
import type { SearchBenchProfileKey } from './searchBenchHarness'
import { QUERY_FIXTURES, SEARCH_BENCH_PROFILES } from './searchBenchHarness'
import { computeTimingStats, type SearchFixtureDescriptor } from './searchBenchMetrics'

// ---------------------------------------------------------------------------
// Env gate — the diagnostic runs ONLY when explicitly enabled
// ---------------------------------------------------------------------------

/** Environment variable that enables the on-demand search stage benchmark. */
export const SEARCH_STAGE_BENCH_ENV = 'SEARCH_STAGE_BENCH'

/**
 * Deterministically resolve the SEARCH_STAGE_BENCH gate.
 *
 * - unset / empty / whitespace-only → disabled (the default; the diagnostic
 *   benchmark body never runs and no corpus/artifact side effects occur);
 * - `1` or `true` (case-insensitive) → enabled;
 * - any other non-empty value → throws loudly, so a misconfigured gate can
 *   never silently run — or silently skip — the diagnostic.
 */
export function resolveSearchStageGate(value: string | undefined): boolean {
  if (value === undefined || value.trim().length === 0) return false
  const normalized = value.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true') return true
  throw new Error(
    `SEARCH_STAGE_BENCH must be '1'/'true' to enable or unset/empty to skip ` +
      `(got '${value}'). Enable only through the canonical \`pnpm bench:search-stage\` script.`
  )
}

// ---------------------------------------------------------------------------
// Scale — the stage benchmark is a 50k-only diagnostic
// ---------------------------------------------------------------------------

/** The only corpus profile the stage benchmark may measure. */
export const SEARCH_STAGE_PROFILE_KEY: SearchBenchProfileKey = '50k'

/**
 * Deterministically resolve the corpus profile for the stage benchmark.
 *
 * The diagnostic attributes a fixed 50k fixture cost; 50k is both the default
 * (unset/empty) and the only accepted explicit value. Any other profile
 * (1k/10k/unknown) throws loudly instead of measuring a different scale than
 * the operator requested — the diagnostic never silently degrades to a
 * smaller corpus.
 */
export function resolveSearchStageScale(value: string | undefined): SearchBenchProfileKey {
  if (value === undefined || value.trim().length === 0) return SEARCH_STAGE_PROFILE_KEY
  const key = value.trim()
  if (key === SEARCH_STAGE_PROFILE_KEY) return SEARCH_STAGE_PROFILE_KEY
  throw new Error(
    `The search stage benchmark only supports the 50k profile ` + `(SEARCH_BENCH_SCALE='50k' or unset); got '${value}'.`
  )
}

// ---------------------------------------------------------------------------
// Fixed rounds, page size, identity, and provenance
// ---------------------------------------------------------------------------

/** Warmup rounds before any measurement (each round covers all fixtures). */
export const SEARCH_STAGE_WARMUP_ROUNDS = 5

/** Measured rounds per fixture (50 samples per fixture/stage for a meaningful p95). */
export const SEARCH_STAGE_MEASURE_ROUNDS = 50

/** Page size used by both the whole `search()` call and the bridge fetchResults. */
export const SEARCH_STAGE_PAGE_SIZE = 100

/** Stable schema-v1 artifact id — separate from the search bench profile ids. */
export const SEARCH_STAGE_BENCH_ID = 'chatdb-search-stage-50k'

/** Human-readable benchmark name carried in the schema-v1 artifact. */
export const SEARCH_STAGE_BENCH_NAME = 'Search — 50k corpus stage attribution (collect/filter/fetch)'

/** Explicit safe canonical command recorded in the artifact `environment.command`. */
export const SEARCH_STAGE_COMMAND = 'pnpm bench:search-stage'

// ---------------------------------------------------------------------------
// Metric grid vocabulary
// ---------------------------------------------------------------------------

/** The three individually timed stages, in measurement order. */
export const SEARCH_STAGE_TIMED_STAGES = ['collect', 'filter', 'fetch'] as const

/** Every per-fixture timing group, in deterministic metric row order. */
export const SEARCH_STAGE_GROUPS = ['collect', 'filter', 'fetch', 'whole', 'like', 'fidelity'] as const

/** Stats emitted per fixture/group, in deterministic row order. */
export const SEARCH_STAGE_STATS = ['p50', 'p95', 'mean', 'max'] as const

export type SearchStageGroup = (typeof SEARCH_STAGE_GROUPS)[number]
export type SearchStageStat = (typeof SEARCH_STAGE_STATS)[number]

/** Per-fixture timing samples collected over the measured rounds. */
export interface StageRoundSamples {
  collect: number[]
  filter: number[]
  fetch: number[]
  whole: number[]
  like: number[]
}

/** Readonly per-fixture sample grid consumed by the metric builder. */
export type SearchStageFixtureSamples = ReadonlyMap<string, Readonly<StageRoundSamples>>

/** Non-sensitive numeric context counts per fixture. */
export interface SearchStageCounts {
  candidateCount: number
  exactCount: number
}

/** Readonly per-fixture count grid consumed by the metric builder. */
export type SearchStageFixtureCounts = ReadonlyMap<string, Readonly<SearchStageCounts>>

// ---------------------------------------------------------------------------
// Fidelity arithmetic
// ---------------------------------------------------------------------------

/**
 * Per-round instrumentation fidelity deltas: `(collect + filter + fetch) -
 * whole` for the same round. `parseKeywords` is excluded from the stage sum
 * (it is not timed individually) and is therefore absorbed into the delta —
 * no parse timing is added. A positive delta is the combined cost of the
 * bridge recomposition and the per-stage call boundaries on top of the
 * production `search()` call; values are finite and may be negative when the
 * warm stage calls beat the pooled whole call. Fails loudly on length
 * mismatch so a truncated measurement can never produce a misleading metric.
 */
export function deriveFidelitySamples(samples: StageRoundSamples): number[] {
  const { collect, filter, fetch, whole } = samples
  if (collect.length !== whole.length || filter.length !== whole.length || fetch.length !== whole.length) {
    throw new Error('deriveFidelitySamples: stage sample arrays must all have the same length as the whole samples')
  }
  return whole.map((_, index) => collect[index] + filter[index] + fetch[index] - whole[index])
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
      `buildSearchStageMetrics: fixture id '${fixtureId}' is not a stable ASCII id ` +
        `(must match ${FIXTURE_ID_PATTERN})`
    )
  }
}

function groupLabel(group: SearchStageGroup): string {
  switch (group) {
    case 'collect':
      return 'collectCandidates'
    case 'filter':
      return 'applyExactFilter'
    case 'fetch':
      return 'fetchResults'
    case 'whole':
      return 'whole search()'
    case 'like':
      return 'LIKE baseline'
    case 'fidelity':
      return 'fidelity stageSum-minus-whole (parseKeywords excluded from sum, in delta)'
  }
}

/**
 * Build the per-fixture stage metric rows in deterministic order: fixtures in
 * the order given, then groups (`collect`, `filter`, `fetch`, `whole`,
 * `like`, `fidelity`), then stats (`p50`, `p95`, `mean`, `max`), followed by
 * the two non-sensitive numeric context count rows. Metric ids are
 * `fixture.<fixtureId>.<group>.<stat>` (timing rows, unit `ms`) and
 * `fixture.<fixtureId>.<candidateCount|exactCount>` (unitless context rows);
 * they are unique by construction. Missing fixture entries, empty sample
 * sets, duplicate fixture ids, or non-ASCII fixture ids fail fast.
 */
export function buildSearchStageMetrics(
  fixtures: readonly SearchFixtureDescriptor[],
  samples: SearchStageFixtureSamples,
  counts: SearchStageFixtureCounts
): BenchmarkMetric[] {
  const metrics: BenchmarkMetric[] = []
  const seenIds = new Set<string>()
  for (const fixture of fixtures) {
    validateFixtureId(fixture.id)
    if (seenIds.has(fixture.id)) {
      throw new Error(`buildSearchStageMetrics: duplicate fixture id '${fixture.id}'`)
    }
    seenIds.add(fixture.id)
    const fixtureSamples = samples.get(fixture.id)
    if (fixtureSamples === undefined) {
      throw new Error(`buildSearchStageMetrics: no samples recorded for fixture '${fixture.id}'`)
    }
    for (const group of SEARCH_STAGE_GROUPS) {
      const values = group === 'fidelity' ? deriveFidelitySamples(fixtureSamples) : fixtureSamples[group]
      const stats = computeTimingStats(values)
      for (const stat of SEARCH_STAGE_STATS) {
        metrics.push({
          id: `fixture.${fixture.id}.${group}.${stat}`,
          name: `Fixture ${fixture.name} ${groupLabel(group)} ${stat}`,
          value: stats[stat],
          unit: 'ms'
        })
      }
    }

    const fixtureCounts = counts.get(fixture.id)
    if (fixtureCounts === undefined) {
      throw new Error(`buildSearchStageMetrics: no counts recorded for fixture '${fixture.id}'`)
    }
    metrics.push({
      id: `fixture.${fixture.id}.candidateCount`,
      name: `Fixture ${fixture.name} candidate count`,
      value: fixtureCounts.candidateCount
    })
    metrics.push({
      id: `fixture.${fixture.id}.exactCount`,
      name: `Fixture ${fixture.name} exact count`,
      value: fixtureCounts.exactCount
    })
  }
  return metrics
}

// ---------------------------------------------------------------------------
// Sample-count fail-fast guard
// ---------------------------------------------------------------------------

/** Recorded outcome of a successful sample-count validation (fail-fast guard). */
export interface SearchStageSampleValidation {
  /** Always `true` — the guard throws before returning on any mismatch. */
  ok: true
  /** Every fixture id verified to hold exactly `expectedCount` samples per group. */
  verifiedFixtures: readonly string[]
  /** The exact sample count every verified group matched. */
  expectedCount: number
  /** The groups verified per fixture, in deterministic order. */
  verifiedGroups: readonly string[]
}

/**
 * Fail-fast completeness guard: every fixture must have exactly
 * `expectedCount` measured samples for every timed stage (`collect`, `filter`,
 * `fetch`), for `whole` and `like`, and — via the fidelity derivation — for
 * `fidelity`, before any artifact is built. Wired into the bench file after
 * the measure rounds and before result construction, so a truncated or
 * partial measurement aborts instead of emitting a misleading artifact.
 *
 * Returns the recorded validation outcome (the verified fixture ids and
 * groups plus the exact expected count) so the artifact's `samples.complete`
 * gate can report the actual validation result instead of a hardcoded
 * constant. The original assertion error is NOT swallowed: a mismatch still
 * throws before anything is returned, and because the guard runs before
 * artifact emission a false `samples.complete` gate can never be written.
 */
export function assertSearchStageSampleCounts(
  fixtures: readonly SearchFixtureDescriptor[],
  samples: SearchStageFixtureSamples,
  expectedCount: number
): SearchStageSampleValidation {
  for (const fixture of fixtures) {
    const fixtureSamples = samples.get(fixture.id)
    if (fixtureSamples === undefined) {
      throw new Error(
        `assertSearchStageSampleCounts: no samples recorded for fixture '${fixture.id}' ` +
          `(expected ${expectedCount} per group)`
      )
    }
    for (const group of SEARCH_STAGE_GROUPS) {
      const values = group === 'fidelity' ? deriveFidelitySamples(fixtureSamples) : fixtureSamples[group]
      const count = values.length
      if (count !== expectedCount) {
        throw new Error(
          `assertSearchStageSampleCounts: fixture '${fixture.id}' group '${group}' has ${count} samples, ` +
            `expected exactly ${expectedCount}`
        )
      }
    }
  }
  return {
    ok: true,
    verifiedFixtures: fixtures.map((fixture) => fixture.id),
    expectedCount,
    verifiedGroups: [...SEARCH_STAGE_GROUPS]
  }
}

/** The real harness fixtures as stable ASCII descriptors (id = name). */
export const SEARCH_STAGE_FIXTURES: SearchFixtureDescriptor[] = QUERY_FIXTURES.map((fixture) => ({
  id: fixture.name,
  name: fixture.name
}))

/** Scale metadata contributed by the deterministic 50k corpus profile. */
export function searchStageScale(): { blocks: number; profileCode: number } {
  const profile = SEARCH_BENCH_PROFILES[SEARCH_STAGE_PROFILE_KEY]
  return { blocks: profile.blocks, profileCode: profile.profileCode }
}
