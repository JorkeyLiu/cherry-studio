/**
 * Focused pure tests for per-fixture search benchmark metric construction
 * (searchBenchMetrics.ts): stat computation (p50/p95/mean/max), the 80-row
 * deterministic metric grid (10 fixtures × 2 methods × 4 stats), id
 * uniqueness/format, unit/finite-value invariants, and fail-fast behavior for
 * empty/missing sample sets, wrong sample counts, and invalid fixture ids.
 *
 * Pure logic — imports no native module and performs no filesystem work, so
 * mainLanes.ts classifies it into the core lane (`pnpm test:main:core`).
 */

import { describe, expect, it } from 'vitest'

import { QUERY_FIXTURES } from './searchBenchHarness'
import {
  assertFixtureSampleCounts,
  buildPerFixtureSearchMetrics,
  computeTimingStats,
  SEARCH_BENCH_METHODS,
  SEARCH_FIXTURE_STATS,
  type SearchFixtureDescriptor
} from './searchBenchMetrics'

/** The 10 real harness fixtures as stable ASCII descriptors (id = name). */
const FIXTURE_DESCRIPTORS: SearchFixtureDescriptor[] = QUERY_FIXTURES.map((fixture) => ({
  id: fixture.name,
  name: fixture.name
}))

/** Mutable per-fixture sample grid used by the test fixtures. */
type MutableFixtureSamples = Map<string, { like: number[]; fts: number[] }>

/**
 * Deterministic sample grid for the 10 real fixtures: 10 samples per
 * fixture/method with distinct values so stats are exact and every row is
 * distinguishable. Callers may mutate the returned map to simulate missing or
 * truncated measurements; the readonly `SearchFixtureSamples` view is applied
 * at the API boundary when calling the helpers under test.
 */
function fixtureSamples(): MutableFixtureSamples {
  const samples: MutableFixtureSamples = new Map()
  FIXTURE_DESCRIPTORS.forEach((fixture, index) => {
    samples.set(fixture.id, {
      like: Array.from({ length: 10 }, (_, i) => index * 100 + i),
      fts: Array.from({ length: 10 }, (_, i) => index * 100 + i + 0.5)
    })
  })
  return samples
}

/** Expected 80 metric ids in fixture-major / method / stat order. */
const EXPECTED_IDS: string[] = FIXTURE_DESCRIPTORS.flatMap((fixture) =>
  SEARCH_BENCH_METHODS.flatMap((method) =>
    SEARCH_FIXTURE_STATS.map((stat) => `fixture.${fixture.id}.${method}.${stat}`)
  )
)

describe('computeTimingStats', () => {
  it('throws on an empty sample set (fail-fast for missing measurements)', () => {
    expect(() => computeTimingStats([])).toThrow(/empty sample set/)
  })

  it('computes p50/p95/mean/max with the nearest-rank percentile semantics', () => {
    // 1..100: p50 → idx = ceil(0.5 * 100) - 1 = 49 → 50; p95 → idx 94 → 95.
    const samples = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(computeTimingStats(samples)).toEqual({ p50: 50, p95: 95, mean: 50.5, max: 100 })
  })

  it('matches the pooled benchmark formula on an even-length set', () => {
    // [1, 2, 3, 4] → idx = ceil(0.5 * 4) - 1 = 1 → 2 (same as the pooled p50).
    expect(computeTimingStats([1, 2, 3, 4]).p50).toBe(2)
  })

  it('returns the single element for a one-element sample set', () => {
    expect(computeTimingStats([42])).toEqual({ p50: 42, p95: 42, mean: 42, max: 42 })
  })

  it('handles unsorted and fractional samples', () => {
    const stats = computeTimingStats([2.5, 0.5, 1.5, 3.5, 4.5])
    expect(stats.p50).toBe(2.5)
    expect(stats.p95).toBe(4.5)
    expect(stats.mean).toBe(2.5)
    expect(stats.max).toBe(4.5)
  })
})

describe('buildPerFixtureSearchMetrics', () => {
  it('builds exactly 80 rows for the 10 real fixtures (10 × 2 methods × 4 stats)', () => {
    expect(FIXTURE_DESCRIPTORS).toHaveLength(10)
    const metrics = buildPerFixtureSearchMetrics(FIXTURE_DESCRIPTORS, fixtureSamples())
    expect(metrics).toHaveLength(80)
  })

  it('emits deterministic ids in fixture-major / method / stat order', () => {
    const metrics = buildPerFixtureSearchMetrics(FIXTURE_DESCRIPTORS, fixtureSamples())
    expect(metrics.map((m) => m.id)).toEqual(EXPECTED_IDS)
  })

  it('assigns unique ids (no duplicates)', () => {
    const metrics = buildPerFixtureSearchMetrics(FIXTURE_DESCRIPTORS, fixtureSamples())
    const ids = metrics.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('carries the ms unit and finite values on every row', () => {
    const metrics = buildPerFixtureSearchMetrics(FIXTURE_DESCRIPTORS, fixtureSamples())
    for (const metric of metrics) {
      expect(metric.unit).toBe('ms')
      expect(Number.isFinite(metric.value)).toBe(true)
    }
  })

  it('derives every row value from computeTimingStats for the same samples', () => {
    const samples = fixtureSamples()
    const metrics = buildPerFixtureSearchMetrics(FIXTURE_DESCRIPTORS, samples)
    for (const fixture of FIXTURE_DESCRIPTORS) {
      const fixtureSamples = samples.get(fixture.id)!
      for (const method of SEARCH_BENCH_METHODS) {
        const stats = computeTimingStats(fixtureSamples[method])
        for (const stat of SEARCH_FIXTURE_STATS) {
          const row = metrics.find((m) => m.id === `fixture.${fixture.id}.${method}.${stat}`)
          expect(row?.value).toBe(stats[stat])
        }
      }
    }
  })

  it('names rows deterministically with fixture, method, and stat', () => {
    const metrics = buildPerFixtureSearchMetrics(FIXTURE_DESCRIPTORS, fixtureSamples())
    const byId = new Map(metrics.map((m) => [m.id, m.name]))
    expect(byId.get('fixture.simple-ascii.like.p50')).toBe('Fixture simple-ascii LIKE p50')
    expect(byId.get('fixture.simple-ascii.fts.max')).toBe('Fixture simple-ascii hybrid FTS max')
    expect(byId.get('fixture.rare-term.fts.mean')).toBe('Fixture rare-term hybrid FTS mean')
  })

  it('spot-checks exact values for the first fixture (like 0..9, fts 0.5..9.5)', () => {
    const metrics = buildPerFixtureSearchMetrics(FIXTURE_DESCRIPTORS, fixtureSamples())
    const likeRows = metrics.filter((m) => m.id.startsWith('fixture.simple-ascii.like.'))
    expect(likeRows.map((m) => [m.id, m.value])).toEqual([
      ['fixture.simple-ascii.like.p50', 4],
      ['fixture.simple-ascii.like.p95', 9],
      ['fixture.simple-ascii.like.mean', 4.5],
      ['fixture.simple-ascii.like.max', 9]
    ])
  })

  it('throws when samples are missing entirely for a fixture', () => {
    const samples = fixtureSamples()
    samples.delete('technical')
    expect(() => buildPerFixtureSearchMetrics(FIXTURE_DESCRIPTORS, samples)).toThrow(
      /no samples recorded for fixture 'technical'/
    )
  })

  it('throws when a per-method sample set is empty (fail-fast)', () => {
    const samples = new Map<string, { like: number[]; fts: number[] }>()
    for (const fixture of FIXTURE_DESCRIPTORS) {
      samples.set(fixture.id, { like: Array.from({ length: 10 }, (_, i) => i), fts: [] })
    }
    expect(() => buildPerFixtureSearchMetrics(FIXTURE_DESCRIPTORS, samples)).toThrow(/empty sample set/)
  })

  it('throws on duplicate fixture ids', () => {
    const descriptors = [FIXTURE_DESCRIPTORS[0], { id: 'simple-ascii', name: 'duplicate' }]
    expect(() => buildPerFixtureSearchMetrics(descriptors, fixtureSamples())).toThrow(
      /duplicate fixture id 'simple-ascii'/
    )
  })

  it('throws on a non-ASCII / space-bearing fixture id', () => {
    const samples = fixtureSamples()
    samples.set('bad id', { like: [1, 2], fts: [1, 2] })
    const descriptors = [{ id: 'bad id', name: 'bad' }]
    expect(() => buildPerFixtureSearchMetrics(descriptors, samples)).toThrow(/not a stable ASCII id/)
  })
})

describe('assertFixtureSampleCounts', () => {
  it('passes when every fixture/method has exactly the expected count', () => {
    expect(() => assertFixtureSampleCounts(FIXTURE_DESCRIPTORS, fixtureSamples(), 10)).not.toThrow()
  })

  it('throws when a fixture has fewer samples than expected', () => {
    const samples = fixtureSamples()
    samples.get('technical')!.fts = [1, 2, 3]
    expect(() => assertFixtureSampleCounts(FIXTURE_DESCRIPTORS, samples, 10)).toThrow(
      /fixture 'technical' method 'fts' has 3 samples, expected exactly 10/
    )
  })

  it('throws when a fixture has more samples than expected', () => {
    const samples = fixtureSamples()
    samples.get('short-term')!.like = Array.from({ length: 11 }, (_, i) => i)
    expect(() => assertFixtureSampleCounts(FIXTURE_DESCRIPTORS, samples, 10)).toThrow(
      /fixture 'short-term' method 'like' has 11 samples, expected exactly 10/
    )
  })

  it('throws when a fixture has no samples entry at all', () => {
    const samples = fixtureSamples()
    samples.delete('rare-term')
    expect(() => assertFixtureSampleCounts(FIXTURE_DESCRIPTORS, samples, 10)).toThrow(
      /no samples recorded for fixture 'rare-term'/
    )
  })
})
