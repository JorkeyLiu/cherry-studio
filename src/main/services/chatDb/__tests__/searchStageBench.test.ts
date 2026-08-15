/**
 * Focused pure tests for the search stage attribution benchmark helpers
 * (searchStageBench.ts): env gate / scale / round validation, the 260-row
 * deterministic metric grid (10 fixtures × 26 rows), id uniqueness/order and
 * finite-value invariants, stage fidelity arithmetic, sample-count fail-fast,
 * and the default skip (no-side-effect) semantics where testable.
 *
 * Pure logic — imports no native module and performs no filesystem work, so
 * mainLanes.ts classifies it into the core lane (`pnpm test:main:core`).
 */

import { describe, expect, it } from 'vitest'

import { BENCH_RESULT_SCHEMA_VERSION, type BenchmarkResult, validateBenchmarkResult } from './benchResult'
import { SEARCH_BENCH_PROFILES } from './searchBenchHarness'
import { computeTimingStats, type SearchFixtureDescriptor } from './searchBenchMetrics'
import {
  assertSearchStageSampleCounts,
  buildSearchStageMetrics,
  deriveFidelitySamples,
  resolveSearchStageGate,
  resolveSearchStageScale,
  SEARCH_STAGE_BENCH_ID,
  SEARCH_STAGE_BENCH_NAME,
  SEARCH_STAGE_COMMAND,
  SEARCH_STAGE_FIXTURES,
  SEARCH_STAGE_GROUPS,
  SEARCH_STAGE_MEASURE_ROUNDS,
  SEARCH_STAGE_PAGE_SIZE,
  SEARCH_STAGE_PROFILE_KEY,
  SEARCH_STAGE_STATS,
  SEARCH_STAGE_TIMED_STAGES,
  SEARCH_STAGE_WARMUP_ROUNDS,
  searchStageScale,
  type StageRoundSamples
} from './searchStageBench'

/** Mutable per-fixture sample grid used by the test fixtures. */
type MutableFixtureSamples = Map<string, StageRoundSamples>

/**
 * Deterministic 50-sample grid for the 10 real fixtures with distinct values
 * per group so stats are exact and every row is distinguishable. Fidelity
 * (collect + filter + fetch − whole) is positive overall and exact.
 */
function fixtureSamples(): MutableFixtureSamples {
  const samples: MutableFixtureSamples = new Map()
  SEARCH_STAGE_FIXTURES.forEach((fixture, index) => {
    const base = index * 1000
    samples.set(fixture.id, {
      collect: Array.from({ length: SEARCH_STAGE_MEASURE_ROUNDS }, (_, i) => base + i),
      filter: Array.from({ length: SEARCH_STAGE_MEASURE_ROUNDS }, (_, i) => base + i + 0.25),
      fetch: Array.from({ length: SEARCH_STAGE_MEASURE_ROUNDS }, (_, i) => base + i + 0.5),
      whole: Array.from({ length: SEARCH_STAGE_MEASURE_ROUNDS }, (_, i) => base + i + 1),
      like: Array.from({ length: SEARCH_STAGE_MEASURE_ROUNDS }, (_, i) => base + i + 2)
    })
  })
  return samples
}

/** Deterministic 50-round stable counts for the 10 real fixtures. */
function fixtureCounts(): Map<string, { candidateCount: number; exactCount: number }> {
  const counts = new Map<string, { candidateCount: number; exactCount: number }>()
  SEARCH_STAGE_FIXTURES.forEach((fixture, index) => {
    counts.set(fixture.id, { candidateCount: 100 + index * 10, exactCount: 50 + index * 5 })
  })
  return counts
}

/** Expected 260 metric ids in fixture-major / group / stat order, then counts. */
const EXPECTED_IDS: string[] = SEARCH_STAGE_FIXTURES.flatMap((fixture) => [
  ...SEARCH_STAGE_GROUPS.flatMap((group) => SEARCH_STAGE_STATS.map((stat) => `fixture.${fixture.id}.${group}.${stat}`)),
  `fixture.${fixture.id}.candidateCount`,
  `fixture.${fixture.id}.exactCount`
])

describe('resolveSearchStageGate (default skip / on-demand enable)', () => {
  it('is disabled by default (unset/empty) so the diagnostic body never runs', () => {
    expect(resolveSearchStageGate(undefined)).toBe(false)
    expect(resolveSearchStageGate('')).toBe(false)
    expect(resolveSearchStageGate('   ')).toBe(false)
  })

  it('enables only on the explicit 1/true values, case-insensitively', () => {
    expect(resolveSearchStageGate('1')).toBe(true)
    expect(resolveSearchStageGate('true')).toBe(true)
    expect(resolveSearchStageGate('TRUE')).toBe(true)
    expect(resolveSearchStageGate(' True ')).toBe(true)
  })

  it('rejects any other non-empty value loudly (never silent skip or run)', () => {
    for (const bad of ['yes', '0', 'false', 'enabled', 'on', '--enable']) {
      expect(() => resolveSearchStageGate(bad)).toThrow(/SEARCH_STAGE_BENCH/)
    }
  })
})

describe('resolveSearchStageScale (50k-only diagnostic)', () => {
  it('defaults to the 50k profile when unset or empty', () => {
    expect(resolveSearchStageScale(undefined)).toBe('50k')
    expect(resolveSearchStageScale('')).toBe('50k')
    expect(resolveSearchStageScale(' 50k ')).toBe('50k')
  })

  it('accepts only the explicit 50k profile', () => {
    expect(resolveSearchStageScale('50k')).toBe('50k')
  })

  it('rejects every other profile loudly instead of measuring a smaller corpus', () => {
    for (const bad of ['1k', '10k', '120k', '50000', '10K']) {
      expect(() => resolveSearchStageScale(bad)).toThrow(/only supports the 50k profile/)
    }
  })

  it('declares the fixed rounds, page size, identity, and provenance', () => {
    expect(SEARCH_STAGE_WARMUP_ROUNDS).toBe(5)
    expect(SEARCH_STAGE_MEASURE_ROUNDS).toBe(50)
    expect(SEARCH_STAGE_PAGE_SIZE).toBe(100)
    expect(SEARCH_STAGE_PROFILE_KEY).toBe('50k')
    expect(SEARCH_STAGE_BENCH_ID).toBe('chatdb-search-stage-50k')
    expect(SEARCH_STAGE_BENCH_NAME).toContain('stage attribution')
    expect(SEARCH_STAGE_COMMAND).toBe('pnpm bench:search-stage')
    // Audit F3: the canonical artifact command must be path-free.
    expect(SEARCH_STAGE_COMMAND).not.toMatch(/[\\/]/)
  })

  it('reuses the deterministic 50k corpus profile without disturbing search bench identities', () => {
    expect(searchStageScale()).toEqual({ blocks: 50_000, profileCode: 2 })
    expect(SEARCH_BENCH_PROFILES['50k'].blocks).toBe(50_000)
    // The stage benchmark id is separate from every search bench profile id.
    const profileIds = Object.values(SEARCH_BENCH_PROFILES).map((p) => p.id)
    expect(profileIds).not.toContain(SEARCH_STAGE_BENCH_ID)
    // The default search bench scale and profiles stay untouched.
    expect(SEARCH_BENCH_PROFILES['10k']).toBeDefined()
  })

  it('declares the fixed vocabulary (3 timed stages, 6 groups, 4 stats)', () => {
    expect(SEARCH_STAGE_TIMED_STAGES).toEqual(['collect', 'filter', 'fetch'])
    expect(SEARCH_STAGE_GROUPS).toEqual(['collect', 'filter', 'fetch', 'whole', 'like', 'fidelity'])
    expect(SEARCH_STAGE_STATS).toEqual(['p50', 'p95', 'mean', 'max'])
  })
})

describe('deriveFidelitySamples', () => {
  it('computes per-round (collect + filter + fetch) - whole deltas', () => {
    const samples: StageRoundSamples = {
      collect: [10, 20],
      filter: [5, 5],
      fetch: [3, 3],
      whole: [15, 30],
      like: [999, 999]
    }
    expect(deriveFidelitySamples(samples)).toEqual([3, -2])
  })

  it('allows finite negative deltas (warm stage calls can beat the pooled whole call)', () => {
    const samples: StageRoundSamples = {
      collect: [1],
      filter: [1],
      fetch: [1],
      whole: [5],
      like: [1]
    }
    expect(deriveFidelitySamples(samples)).toEqual([-2])
  })

  it('fails loudly on mismatched stage/whole lengths', () => {
    const samples: StageRoundSamples = {
      collect: [1, 2],
      filter: [1],
      fetch: [1],
      whole: [1],
      like: [1]
    }
    expect(() => deriveFidelitySamples(samples)).toThrow(/must all have the same length/)
  })
})

describe('buildSearchStageMetrics', () => {
  it('builds exactly 260 rows for the 10 real fixtures (10 × (6×4 stats + 2 counts))', () => {
    expect(SEARCH_STAGE_FIXTURES).toHaveLength(10)
    const metrics = buildSearchStageMetrics(SEARCH_STAGE_FIXTURES, fixtureSamples(), fixtureCounts())
    expect(metrics).toHaveLength(260)
  })

  it('emits deterministic ids in fixture-major / group / stat / count order', () => {
    const metrics = buildSearchStageMetrics(SEARCH_STAGE_FIXTURES, fixtureSamples(), fixtureCounts())
    expect(metrics.map((m) => m.id)).toEqual(EXPECTED_IDS)
  })

  it('assigns unique ids (no duplicates)', () => {
    const metrics = buildSearchStageMetrics(SEARCH_STAGE_FIXTURES, fixtureSamples(), fixtureCounts())
    const ids = metrics.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('carries finite values; ms unit on timing rows, no unit on count rows', () => {
    const metrics = buildSearchStageMetrics(SEARCH_STAGE_FIXTURES, fixtureSamples(), fixtureCounts())
    for (const metric of metrics) {
      expect(Number.isFinite(metric.value)).toBe(true)
      if (metric.id.endsWith('.candidateCount') || metric.id.endsWith('.exactCount')) {
        expect(metric.unit).toBeUndefined()
      } else {
        expect(metric.unit).toBe('ms')
      }
    }
  })

  it('derives every timing row value from computeTimingStats over the same samples', () => {
    const samples = fixtureSamples()
    const metrics = buildSearchStageMetrics(SEARCH_STAGE_FIXTURES, samples, fixtureCounts())
    for (const fixture of SEARCH_STAGE_FIXTURES) {
      const fixtureSamples = samples.get(fixture.id)!
      for (const group of SEARCH_STAGE_GROUPS) {
        const values = group === 'fidelity' ? deriveFidelitySamples(fixtureSamples) : fixtureSamples[group]
        const stats = computeTimingStats(values)
        for (const stat of SEARCH_STAGE_STATS) {
          const row = metrics.find((m) => m.id === `fixture.${fixture.id}.${group}.${stat}`)
          expect(row?.value).toBe(stats[stat])
        }
      }
    }
  })

  it('spot-checks exact fidelity stats for the first fixture (2i - 0.25 over i=0..49)', () => {
    const metrics = buildSearchStageMetrics(SEARCH_STAGE_FIXTURES, fixtureSamples(), fixtureCounts())
    const fidelity = metrics.filter((m) => m.id.startsWith('fixture.simple-ascii.fidelity.'))
    expect(fidelity.map((m) => [m.id, m.value])).toEqual([
      ['fixture.simple-ascii.fidelity.p50', 47.75],
      ['fixture.simple-ascii.fidelity.p95', 93.75],
      ['fixture.simple-ascii.fidelity.mean', 48.75],
      ['fixture.simple-ascii.fidelity.max', 97.75]
    ])
  })

  it('names rows deterministically with fixture, group label, and stat', () => {
    const metrics = buildSearchStageMetrics(SEARCH_STAGE_FIXTURES, fixtureSamples(), fixtureCounts())
    const byId = new Map(metrics.map((m) => [m.id, m.name]))
    expect(byId.get('fixture.simple-ascii.collect.p50')).toBe('Fixture simple-ascii collectCandidates p50')
    expect(byId.get('fixture.simple-ascii.fetch.max')).toBe('Fixture simple-ascii fetchResults max')
    expect(byId.get('fixture.simple-ascii.whole.p95')).toBe('Fixture simple-ascii whole search() p95')
    expect(byId.get('fixture.simple-ascii.like.mean')).toBe('Fixture simple-ascii LIKE baseline mean')
    expect(byId.get('fixture.simple-ascii.fidelity.p50')).toBe(
      'Fixture simple-ascii fidelity stageSum-minus-whole (parseKeywords excluded from sum, in delta) p50'
    )
    expect(byId.get('fixture.simple-ascii.candidateCount')).toBe('Fixture simple-ascii candidate count')
    expect(byId.get('fixture.simple-ascii.exactCount')).toBe('Fixture simple-ascii exact count')
  })

  it('carries the recorded candidate/exact counts verbatim', () => {
    const counts = fixtureCounts()
    const metrics = buildSearchStageMetrics(SEARCH_STAGE_FIXTURES, fixtureSamples(), counts)
    for (const fixture of SEARCH_STAGE_FIXTURES) {
      const expected = counts.get(fixture.id)!
      expect(metrics.find((m) => m.id === `fixture.${fixture.id}.candidateCount`)?.value).toBe(expected.candidateCount)
      expect(metrics.find((m) => m.id === `fixture.${fixture.id}.exactCount`)?.value).toBe(expected.exactCount)
    }
  })

  it('throws when samples are missing entirely for a fixture', () => {
    const samples = fixtureSamples()
    samples.delete('technical')
    expect(() => buildSearchStageMetrics(SEARCH_STAGE_FIXTURES, samples, fixtureCounts())).toThrow(
      /no samples recorded for fixture 'technical'/
    )
  })

  it('throws when a per-group sample set is empty (fail-fast)', () => {
    const samples = fixtureSamples()
    samples.get('simple-ascii')!.whole = []
    expect(() => buildSearchStageMetrics(SEARCH_STAGE_FIXTURES, samples, fixtureCounts())).toThrow(/empty sample set/)
  })

  it('throws when counts are missing for a fixture', () => {
    const counts = fixtureCounts()
    counts.delete('rare-term')
    expect(() => buildSearchStageMetrics(SEARCH_STAGE_FIXTURES, fixtureSamples(), counts)).toThrow(
      /no counts recorded for fixture 'rare-term'/
    )
  })

  it('throws on duplicate fixture ids', () => {
    const fixtures: SearchFixtureDescriptor[] = [SEARCH_STAGE_FIXTURES[0], { id: 'simple-ascii', name: 'duplicate' }]
    expect(() => buildSearchStageMetrics(fixtures, fixtureSamples(), fixtureCounts())).toThrow(
      /duplicate fixture id 'simple-ascii'/
    )
  })

  it('throws on a non-ASCII / space-bearing fixture id', () => {
    const samples = fixtureSamples()
    samples.set('bad id', {
      collect: [1],
      filter: [1],
      fetch: [1],
      whole: [1],
      like: [1]
    })
    const counts = fixtureCounts()
    counts.set('bad id', { candidateCount: 1, exactCount: 1 })
    const fixtures: SearchFixtureDescriptor[] = [{ id: 'bad id', name: 'bad' }]
    expect(() => buildSearchStageMetrics(fixtures, samples, counts)).toThrow(/not a stable ASCII id/)
  })
})

describe('assertSearchStageSampleCounts', () => {
  it('passes and records the validation outcome when every fixture/group has the exact expected count', () => {
    const outcome = assertSearchStageSampleCounts(SEARCH_STAGE_FIXTURES, fixtureSamples(), 50)
    expect(outcome.ok).toBe(true)
    expect(outcome.verifiedFixtures).toEqual(SEARCH_STAGE_FIXTURES.map((fixture) => fixture.id))
    expect(outcome.expectedCount).toBe(50)
    expect(outcome.verifiedGroups).toEqual([...SEARCH_STAGE_GROUPS])
  })

  it('throws when a fixture has fewer samples than expected', () => {
    const samples = fixtureSamples()
    samples.get('technical')!.fetch = [1, 2, 3]
    expect(() => assertSearchStageSampleCounts(SEARCH_STAGE_FIXTURES, samples, 50)).toThrow(
      /fixture 'technical' group 'fetch' has 3 samples, expected exactly 50/
    )
  })

  it('throws when a fixture has more samples than expected', () => {
    const samples = fixtureSamples()
    samples.get('short-term')!.like = Array.from({ length: 51 }, (_, i) => i)
    expect(() => assertSearchStageSampleCounts(SEARCH_STAGE_FIXTURES, samples, 50)).toThrow(
      /fixture 'short-term' group 'like' has 51 samples, expected exactly 50/
    )
  })

  it('throws when a fixture has no samples entry at all', () => {
    const samples = fixtureSamples()
    samples.delete('rare-term')
    expect(() => assertSearchStageSampleCounts(SEARCH_STAGE_FIXTURES, samples, 50)).toThrow(
      /no samples recorded for fixture 'rare-term'/
    )
  })

  it('fails when any timed stage input is truncated (fail-fast before metric build)', () => {
    const samples = fixtureSamples()
    samples.get('cjk-full')!.fetch = samples.get('cjk-full')!.fetch.slice(0, 49)
    expect(() => assertSearchStageSampleCounts(SEARCH_STAGE_FIXTURES, samples, 50)).toThrow(
      /fixture 'cjk-full' group 'fetch' has 49 samples, expected exactly 50/
    )
  })

  it('guards the derived fidelity group length as well', () => {
    const samples = fixtureSamples()
    // Fidelity is derived from collect/filter/fetch/whole, so its length is
    // implied by the stage lengths; the guard still verifies it explicitly
    // and records it in the validated groups.
    const outcome = assertSearchStageSampleCounts(SEARCH_STAGE_FIXTURES, samples, 50)
    expect(outcome.ok).toBe(true)
    expect(outcome.verifiedGroups).toContain('fidelity')
  })
})

describe('stage-shaped schema-v1 artifact (closed contract)', () => {
  /** The exact artifact shape the bench file builds from real measurement. */
  function stageResult(): BenchmarkResult {
    const scale = searchStageScale()
    const samples = fixtureSamples()
    const counts = fixtureCounts()
    const metrics = buildSearchStageMetrics(SEARCH_STAGE_FIXTURES, samples, counts)
    // Mirrors the bench file: the gate reports the guard's actual recorded
    // validation outcome (the guard throws on any mismatch before returning).
    const sampleValidation = assertSearchStageSampleCounts(SEARCH_STAGE_FIXTURES, samples, SEARCH_STAGE_MEASURE_ROUNDS)
    return {
      schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
      benchmark: {
        id: SEARCH_STAGE_BENCH_ID,
        name: SEARCH_STAGE_BENCH_NAME,
        scale: {
          blocks: scale.blocks,
          profileCode: scale.profileCode,
          queryFixtures: SEARCH_STAGE_FIXTURES.length,
          warmupRounds: SEARCH_STAGE_WARMUP_ROUNDS,
          measureRounds: SEARCH_STAGE_MEASURE_ROUNDS,
          pageSize: SEARCH_STAGE_PAGE_SIZE
        }
      },
      environment: {
        timestamp: '2026-08-15T06:00:00.000Z',
        node: 'v24.11.1',
        pnpm: '10.27.0',
        abiLane: 'node',
        abi: '137',
        command: SEARCH_STAGE_COMMAND,
        git: { commit: '0'.repeat(40), dirty: true }
      },
      metrics,
      gates: [
        { id: 'parity.ordered', name: 'Ordered parity', kind: 'correctness', passed: true },
        { id: 'parity.no-duplicates', name: 'No duplicates', kind: 'correctness', passed: true },
        { id: 'parity.bridge-vs-search', name: 'Bridge parity', kind: 'correctness', passed: true },
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
        { id: 'counts.stable', name: 'Counts stable', kind: 'correctness', passed: true }
      ]
    }
  }

  it('validates against the closed schema v1 contract', () => {
    expect(validateBenchmarkResult(stageResult())).toEqual([])
  })

  it('carries the explicit canonical path-free command in environment', () => {
    const result = stageResult()
    expect(result.environment.command).toBe('pnpm bench:search-stage')
    expect(result.environment.command).not.toMatch(/[\\/]/)
  })

  it('derives the samples.complete gate from the recorded validation outcome, not a constant', () => {
    const result = stageResult()
    const gate = result.gates.find((g) => g.id === 'samples.complete')
    // The gate value comes from the actual guard run over the recorded
    // samples (any mismatch would have thrown before the artifact was built).
    const outcome = assertSearchStageSampleCounts(SEARCH_STAGE_FIXTURES, fixtureSamples(), 50)
    expect(gate).toMatchObject({ kind: 'correctness', passed: outcome.ok })
    expect(gate?.detail).toContain(`${outcome.verifiedFixtures.length}/10 fixtures`)
    expect(gate?.detail).toContain(`exactly ${SEARCH_STAGE_MEASURE_ROUNDS} samples`)
    expect(gate?.detail).toContain(`${outcome.verifiedGroups.length} groups`)
    // The gate id is stable; a truncated sample grid must never reach it.
    expect(gate?.id).toBe('samples.complete')
  })

  it('never serializes message content, credentials, or path fields', () => {
    const forbidden = [
      'content',
      'credential',
      'credentials',
      'password',
      'secret',
      'token',
      'apiKey',
      'dbPath',
      'dbSize',
      'profile',
      'userData',
      'attachment',
      'raw'
    ]
    const leafKeys: string[] = []
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) collect(item)
      } else if (typeof value === 'object' && value !== null) {
        for (const [key, child] of Object.entries(value)) {
          leafKeys.push(key)
          collect(child)
        }
      }
    }
    collect(stageResult())
    for (const sensitive of forbidden) {
      expect(leafKeys).not.toContain(sensitive)
    }
    expect(JSON.stringify(stageResult())).not.toContain('Lorem ipsum')
  })

  it('records exactly 260 finite unique metrics and the deterministic scale', () => {
    const result = stageResult()
    expect(result.metrics).toHaveLength(260)
    const ids = result.metrics.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const metric of result.metrics) {
      expect(Number.isFinite(metric.value)).toBe(true)
    }
    expect(result.benchmark.scale).toEqual({
      blocks: 50_000,
      profileCode: 2,
      queryFixtures: 10,
      warmupRounds: 5,
      measureRounds: 50,
      pageSize: 100
    })
    expect(result.benchmark.id).toBe('chatdb-search-stage-50k')
  })

  it('keeps the stage benchmark id outside the search bench profile family', () => {
    const profileIds = Object.values(SEARCH_BENCH_PROFILES).map((p) => p.id)
    expect(profileIds).not.toContain(SEARCH_STAGE_BENCH_ID)
  })
})
