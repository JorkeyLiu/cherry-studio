/**
 * Per-fixture search benchmark metric construction (L3 measurement rows).
 *
 * Pure functions that turn per-fixture timing samples (collected by
 * search.bench.ts across the existing 10 measure rounds) into deterministic
 * schema-v1 metric rows. This file is intentionally NOT a *.test.ts /
 * *.bench.ts file so it is never collected directly by Vitest.
 *
 * The 8 pooled aggregate metrics (`like.*`, `fts.*`, `speedup.*`) are built
 * inline in search.bench.ts and are deliberately untouched here. This module
 * only produces the 80 per-fixture L3 rows — 10 fixtures × 2 methods (like,
 * fts) × 4 stats (p50, p95, mean, max) — that attribute the pooled p95 tail
 * to concrete query fixtures. Every value is a finite millisecond number;
 * missing or empty sample sets fail fast so a degenerate measurement can
 * never reach artifact emission.
 */

import type { BenchmarkMetric } from './benchResult'

/** Methods measured per fixture, in benchmark measurement order (LIKE first, then hybrid FTS). */
export const SEARCH_BENCH_METHODS = ['like', 'fts'] as const

/** Stats emitted per fixture/method, in deterministic row order. */
export const SEARCH_FIXTURE_STATS = ['p50', 'p95', 'mean', 'max'] as const

export type SearchBenchMethod = (typeof SEARCH_BENCH_METHODS)[number]
export type SearchFixtureStat = (typeof SEARCH_FIXTURE_STATS)[number]

/** Fixture descriptor consumed by the metric builder. */
export interface SearchFixtureDescriptor {
  /** Stable ASCII fixture id, used verbatim in metric ids (e.g. `simple-ascii`). */
  id: string
  /** Human-readable fixture name used in metric row names. */
  name: string
}

/** Per-fixture timing samples keyed by the fixture's stable ASCII id. */
export type SearchFixtureSamples = ReadonlyMap<string, Readonly<Record<SearchBenchMethod, readonly number[]>>>

export interface TimingStats {
  p50: number
  p95: number
  mean: number
  max: number
}

/**
 * The fixture id is embedded verbatim in metric ids, so it must be a stable
 * ASCII id — lowercase letters/digits, hyphen-separated segments only.
 */
const FIXTURE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function validateFixtureId(fixtureId: string): void {
  if (!FIXTURE_ID_PATTERN.test(fixtureId)) {
    throw new Error(
      `buildPerFixtureSearchMetrics: fixture id '${fixtureId}' is not a stable ASCII id ` +
        `(must match ${FIXTURE_ID_PATTERN})`
    )
  }
}

/**
 * Compute p50 / p95 / mean / max from a sample set using the benchmark's
 * nearest-rank percentile semantics — the same ceiling-index formula the
 * pooled metrics use. Throws on an empty sample set: a fixture/method with no
 * measurements must never produce metric rows.
 */
export function computeTimingStats(samples: readonly number[]): TimingStats {
  if (samples.length === 0) {
    throw new Error('computeTimingStats: empty sample set (no measurements recorded)')
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const percentile = (p: number): number => {
    const idx = Math.ceil((p / 100) * sorted.length) - 1
    return sorted[Math.max(0, idx)]
  }
  return {
    p50: percentile(50),
    p95: percentile(95),
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    max: sorted[sorted.length - 1]
  }
}

function methodLabel(method: SearchBenchMethod): string {
  return method === 'like' ? 'LIKE' : 'hybrid FTS'
}

/**
 * Build the per-fixture metric rows in deterministic order: fixtures in the
 * order given, then methods (`like`, `fts`), then stats (`p50`, `p95`,
 * `mean`, `max`). Metric ids are `fixture.<fixtureId>.<method>.<stat>` and
 * are unique by construction. Missing fixture entries, empty sample sets,
 * duplicate fixture ids, or non-ASCII fixture ids fail fast.
 */
export function buildPerFixtureSearchMetrics(
  fixtures: readonly SearchFixtureDescriptor[],
  samples: SearchFixtureSamples
): BenchmarkMetric[] {
  const metrics: BenchmarkMetric[] = []
  const seenIds = new Set<string>()
  for (const fixture of fixtures) {
    validateFixtureId(fixture.id)
    if (seenIds.has(fixture.id)) {
      throw new Error(`buildPerFixtureSearchMetrics: duplicate fixture id '${fixture.id}'`)
    }
    seenIds.add(fixture.id)
    const fixtureSamples = samples.get(fixture.id)
    if (fixtureSamples === undefined) {
      throw new Error(`buildPerFixtureSearchMetrics: no samples recorded for fixture '${fixture.id}'`)
    }
    for (const method of SEARCH_BENCH_METHODS) {
      const stats = computeTimingStats(fixtureSamples[method])
      for (const stat of SEARCH_FIXTURE_STATS) {
        metrics.push({
          id: `fixture.${fixture.id}.${method}.${stat}`,
          name: `Fixture ${fixture.name} ${methodLabel(method)} ${stat}`,
          value: stats[stat],
          unit: 'ms'
        })
      }
    }
  }
  return metrics
}

/**
 * Fail-fast completeness guard for the measured sample grid: every fixture
 * must have exactly `expectedCount` measured samples per method before any
 * artifact is built. Wired into search.bench.ts after the measure rounds and
 * before result construction, so a truncated/partial measurement aborts
 * instead of emitting a misleading artifact.
 */
export function assertFixtureSampleCounts(
  fixtures: readonly SearchFixtureDescriptor[],
  samples: SearchFixtureSamples,
  expectedCount: number
): void {
  for (const fixture of fixtures) {
    const fixtureSamples = samples.get(fixture.id)
    if (fixtureSamples === undefined) {
      throw new Error(
        `assertFixtureSampleCounts: no samples recorded for fixture '${fixture.id}' ` +
          `(expected ${expectedCount} per method)`
      )
    }
    for (const method of SEARCH_BENCH_METHODS) {
      const count = fixtureSamples[method].length
      if (count !== expectedCount) {
        throw new Error(
          `assertFixtureSampleCounts: fixture '${fixture.id}' method '${method}' has ${count} samples, ` +
            `expected exactly ${expectedCount}`
        )
      }
    }
  }
}
