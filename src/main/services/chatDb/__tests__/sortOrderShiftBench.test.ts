/**
 * Focused pure tests for the sort-order shift middle/batch insert scale
 * diagnostic helpers (sortOrderShiftBench.ts): env gate (default
 * skip / on-demand enable), the bounded 9-combo matrix (topic size ×
 * batch size, floor(N/2) indices), expectedShiftedCount arithmetic,
 * nearest-rank timing statistics, the 45-row deterministic metric grid
 * (9 combos × 5 rows), id uniqueness/order and finite-value invariants,
 * and the fail-fast sample-count completeness guard.
 *
 * Pure logic — imports no native module and performs no filesystem work,
 * so mainLanes.ts classifies it into the core lane (`pnpm test:main:core`).
 */

import { describe, expect, it } from 'vitest'

import {
  assertSortOrderShiftSampleCounts,
  buildSortOrderShiftMetrics,
  computeTimingStats,
  expectedShiftedCount,
  resolveSortOrderShiftGate,
  SORT_ORDER_SHIFT_BATCH_SIZES,
  SORT_ORDER_SHIFT_BENCH_ENV,
  SORT_ORDER_SHIFT_BENCH_ID,
  SORT_ORDER_SHIFT_BENCH_NAME,
  SORT_ORDER_SHIFT_COMBOS,
  SORT_ORDER_SHIFT_COMMAND,
  SORT_ORDER_SHIFT_MEASURE_ROUNDS,
  SORT_ORDER_SHIFT_STATS,
  SORT_ORDER_SHIFT_TOPIC_SIZES,
  SORT_ORDER_SHIFT_WARMUP_ROUNDS,
  type SortOrderShiftSamples,
  sortOrderShiftScale
} from './sortOrderShiftBench'

/** Expected 45 metric ids in combo-major / stat / shiftedCount order. */
const EXPECTED_IDS: string[] = SORT_ORDER_SHIFT_COMBOS.flatMap((combo) => [
  ...SORT_ORDER_SHIFT_STATS.map((stat) => `combo.${combo.id}.insert.${stat}`),
  `combo.${combo.id}.shiftedCount`
])

/** Mutable per-combo timing sample grid used by the test fixtures. */
type MutableSamples = Map<string, number[]>
type MutableShiftedCounts = Map<string, number>

/**
 * Deterministic 20-sample grid for the 9 real combos with distinct values
 * per combo so stats are exact and every row is distinguishable. Shifted
 * counts are the expected dense-topic value N - floor(N/2).
 */
function fixtureSamples(): MutableSamples {
  const samples: MutableSamples = new Map()
  SORT_ORDER_SHIFT_COMBOS.forEach((combo, index) => {
    const base = index * 1000
    samples.set(
      combo.id,
      Array.from({ length: SORT_ORDER_SHIFT_MEASURE_ROUNDS }, (_, i) => base + i)
    )
  })
  return samples
}

function fixtureShiftedCounts(): MutableShiftedCounts {
  const counts: MutableShiftedCounts = new Map()
  for (const combo of SORT_ORDER_SHIFT_COMBOS) {
    counts.set(combo.id, expectedShiftedCount(combo.topicSize, combo.index))
  }
  return counts
}

describe('resolveSortOrderShiftGate (default skip / on-demand enable)', () => {
  it('is disabled by default (unset/empty/whitespace) so the diagnostic body never runs', () => {
    expect(resolveSortOrderShiftGate(undefined)).toBe(false)
    expect(resolveSortOrderShiftGate('')).toBe(false)
    expect(resolveSortOrderShiftGate('   ')).toBe(false)
    expect(resolveSortOrderShiftGate('\t\n ')).toBe(false)
  })

  it('enables only on the explicit 1/true values, case-insensitively and trimmed', () => {
    expect(resolveSortOrderShiftGate('1')).toBe(true)
    expect(resolveSortOrderShiftGate('true')).toBe(true)
    expect(resolveSortOrderShiftGate('TRUE')).toBe(true)
    expect(resolveSortOrderShiftGate(' True ')).toBe(true)
    expect(resolveSortOrderShiftGate(' 1 ')).toBe(true)
  })

  it('rejects any other non-empty value loudly (never silent skip or run)', () => {
    for (const bad of ['yes', '0', 'false', 'enabled', 'on', '--enable', '2', 'truthy']) {
      expect(() => resolveSortOrderShiftGate(bad)).toThrow(/SORT_ORDER_SHIFT_BENCH/)
    }
  })

  it('declares the stable env, identity, and provenance', () => {
    expect(SORT_ORDER_SHIFT_BENCH_ENV).toBe('SORT_ORDER_SHIFT_BENCH')
    expect(SORT_ORDER_SHIFT_BENCH_ID).toBe('chatdb-sort-order-shift')
    expect(SORT_ORDER_SHIFT_BENCH_NAME).toContain('Sort-order shift')
    expect(SORT_ORDER_SHIFT_COMMAND).toBe('pnpm bench:sort-order-shift')
    expect(SORT_ORDER_SHIFT_COMMAND).not.toMatch(/[\\/]/)
  })
})

describe('bounded scale matrix (9 combos, floor(N/2) indices)', () => {
  it('declares bounded topic and batch size axes', () => {
    expect([...SORT_ORDER_SHIFT_TOPIC_SIZES]).toEqual([100, 500, 1000])
    expect([...SORT_ORDER_SHIFT_BATCH_SIZES]).toEqual([1, 10, 50])
    expect(SORT_ORDER_SHIFT_WARMUP_ROUNDS).toBe(3)
    expect(SORT_ORDER_SHIFT_MEASURE_ROUNDS).toBe(20)
    expect(SORT_ORDER_SHIFT_STATS).toEqual(['p50', 'p95', 'mean', 'max'])
  })

  it('builds exactly 9 combos (3 topic sizes × 3 batch sizes)', () => {
    expect(SORT_ORDER_SHIFT_COMBOS).toHaveLength(9)
    expect(SORT_ORDER_SHIFT_COMBOS.length).toBe(
      SORT_ORDER_SHIFT_TOPIC_SIZES.length * SORT_ORDER_SHIFT_BATCH_SIZES.length
    )
  })

  it('orders combos by topicSize ascending then batchSize ascending', () => {
    const ids = SORT_ORDER_SHIFT_COMBOS.map((c) => c.id)
    expect(ids).toEqual([
      'n100-b1',
      'n100-b10',
      'n100-b50',
      'n500-b1',
      'n500-b10',
      'n500-b50',
      'n1000-b1',
      'n1000-b10',
      'n1000-b50'
    ])
    for (let i = 1; i < SORT_ORDER_SHIFT_COMBOS.length; i++) {
      const prev = SORT_ORDER_SHIFT_COMBOS[i - 1]
      const curr = SORT_ORDER_SHIFT_COMBOS[i]
      const topicOrdered =
        prev.topicSize < curr.topicSize || (prev.topicSize === curr.topicSize && prev.batchSize < curr.batchSize)
      expect(topicOrdered).toBe(true)
    }
  })

  it('sets index to floor(N/2) and embeds stable ASCII id and human-readable name', () => {
    for (const combo of SORT_ORDER_SHIFT_COMBOS) {
      expect(combo.index).toBe(Math.floor(combo.topicSize / 2))
      expect(combo.id).toBe(`n${combo.topicSize}-b${combo.batchSize}`)
      expect(combo.name).toBe(`N=${combo.topicSize} M=${combo.batchSize} idx=${combo.index}`)
      expect(combo.id).toMatch(/^n\d+-b\d+$/)
    }
    // Spot-check exact floor values
    expect(SORT_ORDER_SHIFT_COMBOS.find((c) => c.topicSize === 100)!.index).toBe(50)
    expect(SORT_ORDER_SHIFT_COMBOS.find((c) => c.topicSize === 500)!.index).toBe(250)
    expect(SORT_ORDER_SHIFT_COMBOS.find((c) => c.topicSize === 1000)!.index).toBe(500)
  })

  it('is deterministic and immutable across reads', () => {
    expect(SORT_ORDER_SHIFT_COMBOS).toBe(SORT_ORDER_SHIFT_COMBOS)
    expect([...SORT_ORDER_SHIFT_COMBOS]).toEqual([...SORT_ORDER_SHIFT_COMBOS])
  })
})

describe('expectedShiftedCount (dense topic N - index, independent of batch size)', () => {
  it('returns N - index for dense topics', () => {
    expect(expectedShiftedCount(100, 50)).toBe(50)
    expect(expectedShiftedCount(500, 250)).toBe(250)
    expect(expectedShiftedCount(1000, 500)).toBe(500)
    expect(expectedShiftedCount(10, 0)).toBe(10)
    expect(expectedShiftedCount(10, 10)).toBe(0)
    expect(expectedShiftedCount(0, 0)).toBe(0)
  })

  it('is independent of batch size on a dense topic (same count for every combo of same N)', () => {
    for (const topicSize of SORT_ORDER_SHIFT_TOPIC_SIZES) {
      const expected = topicSize - Math.floor(topicSize / 2)
      for (const batchSize of SORT_ORDER_SHIFT_BATCH_SIZES) {
        const combo = SORT_ORDER_SHIFT_COMBOS.find((c) => c.topicSize === topicSize && c.batchSize === batchSize)!
        expect(expectedShiftedCount(combo.topicSize, combo.index)).toBe(expected)
      }
    }
  })

  it('matches every combo shiftedCount used in metric construction', () => {
    for (const combo of SORT_ORDER_SHIFT_COMBOS) {
      expect(expectedShiftedCount(combo.topicSize, combo.index)).toBe(combo.topicSize - combo.index)
    }
  })
})

describe('computeTimingStats', () => {
  it('throws on an empty sample set (fail-fast for missing measurements)', () => {
    expect(() => computeTimingStats([])).toThrow(/empty sample set/)
  })

  it('computes p50/p95/mean/max with nearest-rank percentile semantics', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(computeTimingStats(samples)).toEqual({ p50: 50, p95: 95, mean: 50.5, max: 100 })
  })

  it('matches the pooled benchmark formula on an even-length set', () => {
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

  it('computes nearest-rank p50/p95 correctly for the bounded 20-round window', () => {
    // 0..19 (n=20): p50 idx = ceil(0.5*20)-1 = 9 → 9 ; p95 idx = ceil(0.95*20)-1 = 18 → 18
    const samples = Array.from({ length: 20 }, (_, i) => i)
    const stats = computeTimingStats(samples)
    expect(stats.p50).toBe(9)
    expect(stats.p95).toBe(18)
    expect(stats.mean).toBe(9.5)
    expect(stats.max).toBe(19)
  })

  it('does not mutate the input array and sorts internally', () => {
    const original = [5, 1, 4, 2, 3]
    const copy = [...original]
    computeTimingStats(original)
    expect(original).toEqual(copy)
  })
})

describe('buildSortOrderShiftMetrics', () => {
  it('builds exactly 45 rows for the 9 combos (9 × (4 stats + 1 count))', () => {
    expect(SORT_ORDER_SHIFT_COMBOS).toHaveLength(9)
    const metrics = buildSortOrderShiftMetrics(
      SORT_ORDER_SHIFT_COMBOS,
      fixtureSamples() as SortOrderShiftSamples,
      fixtureShiftedCounts()
    )
    expect(metrics).toHaveLength(45)
  })

  it('emits deterministic ids in combo-major / stat / shiftedCount order', () => {
    const metrics = buildSortOrderShiftMetrics(
      SORT_ORDER_SHIFT_COMBOS,
      fixtureSamples() as SortOrderShiftSamples,
      fixtureShiftedCounts()
    )
    expect(metrics.map((m) => m.id)).toEqual(EXPECTED_IDS)
  })

  it('assigns unique ids (no duplicates)', () => {
    const metrics = buildSortOrderShiftMetrics(
      SORT_ORDER_SHIFT_COMBOS,
      fixtureSamples() as SortOrderShiftSamples,
      fixtureShiftedCounts()
    )
    const ids = metrics.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('carries finite values; ms unit on timing rows, no unit on shiftedCount rows', () => {
    const metrics = buildSortOrderShiftMetrics(
      SORT_ORDER_SHIFT_COMBOS,
      fixtureSamples() as SortOrderShiftSamples,
      fixtureShiftedCounts()
    )
    for (const metric of metrics) {
      expect(Number.isFinite(metric.value)).toBe(true)
      if (metric.id.endsWith('.shiftedCount')) {
        expect(metric.unit).toBeUndefined()
        expect(Number.isInteger(metric.value)).toBe(true)
        expect(metric.value).toBeGreaterThanOrEqual(0)
      } else {
        expect(metric.unit).toBe('ms')
      }
    }
  })

  it('derives every timing row value from computeTimingStats over the same samples', () => {
    const samples = fixtureSamples()
    const counts = fixtureShiftedCounts()
    const metrics = buildSortOrderShiftMetrics(SORT_ORDER_SHIFT_COMBOS, samples as SortOrderShiftSamples, counts)
    for (const combo of SORT_ORDER_SHIFT_COMBOS) {
      const values = samples.get(combo.id)!
      const stats = computeTimingStats(values)
      for (const stat of SORT_ORDER_SHIFT_STATS) {
        const row = metrics.find((m) => m.id === `combo.${combo.id}.insert.${stat}`)
        expect(row?.value).toBe(stats[stat])
      }
      const countRow = metrics.find((m) => m.id === `combo.${combo.id}.shiftedCount`)
      expect(countRow?.value).toBe(counts.get(combo.id))
    }
  })

  it('carries the expected shiftedCount (N - index) verbatim per combo', () => {
    const counts = fixtureShiftedCounts()
    const metrics = buildSortOrderShiftMetrics(
      SORT_ORDER_SHIFT_COMBOS,
      fixtureSamples() as SortOrderShiftSamples,
      counts
    )
    for (const combo of SORT_ORDER_SHIFT_COMBOS) {
      const row = metrics.find((m) => m.id === `combo.${combo.id}.shiftedCount`)
      expect(row?.value).toBe(combo.topicSize - combo.index)
    }
  })

  it('names rows deterministically with combo name, stat, and shiftedCount label', () => {
    const metrics = buildSortOrderShiftMetrics(
      SORT_ORDER_SHIFT_COMBOS,
      fixtureSamples() as SortOrderShiftSamples,
      fixtureShiftedCounts()
    )
    const byId = new Map(metrics.map((m) => [m.id, m.name]))
    const first = SORT_ORDER_SHIFT_COMBOS[0]
    expect(byId.get(`combo.${first.id}.insert.p50`)).toBe(`Combo ${first.name} insert p50`)
    expect(byId.get(`combo.${first.id}.insert.max`)).toBe(`Combo ${first.name} insert max`)
    expect(byId.get(`combo.${first.id}.shiftedCount`)).toBe(`Combo ${first.name} shifted rows (expected N-index)`)
  })

  it('spot-checks exact values for the first combo (0..19 base 0)', () => {
    const samples = fixtureSamples()
    // First combo n100-b1 base 0 → samples 0..19 → p50 9, p95 18, mean 9.5, max 19, shiftedCount 50
    const metrics = buildSortOrderShiftMetrics(
      SORT_ORDER_SHIFT_COMBOS,
      samples as SortOrderShiftSamples,
      fixtureShiftedCounts()
    )
    const byId = new Map(metrics.map((m) => [m.id, m.value]))
    expect(byId.get('combo.n100-b1.insert.p50')).toBe(9)
    expect(byId.get('combo.n100-b1.insert.p95')).toBe(18)
    expect(byId.get('combo.n100-b1.insert.mean')).toBe(9.5)
    expect(byId.get('combo.n100-b1.insert.max')).toBe(19)
    expect(byId.get('combo.n100-b1.shiftedCount')).toBe(50)
  })

  it('spot-checks exact values for the last combo (base 8000)', () => {
    const metrics = buildSortOrderShiftMetrics(
      SORT_ORDER_SHIFT_COMBOS,
      fixtureSamples() as SortOrderShiftSamples,
      fixtureShiftedCounts()
    )
    const byId = new Map(metrics.map((m) => [m.id, m.value]))
    // Last combo n1000-b50 base 8000 → samples 8000..8019 → p50 8009, p95 8018, mean 8009.5, max 8019, shiftedCount 500
    expect(byId.get('combo.n1000-b50.insert.p50')).toBe(8009)
    expect(byId.get('combo.n1000-b50.insert.p95')).toBe(8018)
    expect(byId.get('combo.n1000-b50.insert.mean')).toBe(8009.5)
    expect(byId.get('combo.n1000-b50.insert.max')).toBe(8019)
    expect(byId.get('combo.n1000-b50.shiftedCount')).toBe(500)
  })

  it('throws when samples are missing entirely for a combo', () => {
    const samples = fixtureSamples()
    samples.delete('n100-b1')
    expect(() =>
      buildSortOrderShiftMetrics(SORT_ORDER_SHIFT_COMBOS, samples as SortOrderShiftSamples, fixtureShiftedCounts())
    ).toThrow(/no samples recorded for combo 'n100-b1'/)
  })

  it('throws when shiftedCount is missing for a combo', () => {
    const counts = fixtureShiftedCounts()
    counts.delete('n500-b10')
    expect(() =>
      buildSortOrderShiftMetrics(SORT_ORDER_SHIFT_COMBOS, fixtureSamples() as SortOrderShiftSamples, counts)
    ).toThrow(/no shiftedCount recorded for combo 'n500-b10'/)
  })

  it('throws when a per-combo sample set is empty (fail-fast via computeTimingStats)', () => {
    const samples = fixtureSamples()
    samples.set('n100-b1', [])
    expect(() =>
      buildSortOrderShiftMetrics(SORT_ORDER_SHIFT_COMBOS, samples as SortOrderShiftSamples, fixtureShiftedCounts())
    ).toThrow(/empty sample set/)
  })

  it('throws on duplicate combo ids', () => {
    const dupCombos = [SORT_ORDER_SHIFT_COMBOS[0], { ...SORT_ORDER_SHIFT_COMBOS[0], name: 'duplicate' }]
    expect(() =>
      buildSortOrderShiftMetrics(
        dupCombos as typeof SORT_ORDER_SHIFT_COMBOS,
        fixtureSamples() as SortOrderShiftSamples,
        fixtureShiftedCounts()
      )
    ).toThrow(/duplicate combo id 'n100-b1'/)
  })

  it('throws on a non-ASCII / invalid combo id', () => {
    const badCombos = [
      { topicSize: 100, batchSize: 1, index: 50, id: 'bad id', name: 'bad' }
    ] as unknown as typeof SORT_ORDER_SHIFT_COMBOS
    const samples: MutableSamples = new Map([['bad id', [1, 2, 3]]])
    const counts: MutableShiftedCounts = new Map([['bad id', 50]])
    expect(() => buildSortOrderShiftMetrics(badCombos, samples as SortOrderShiftSamples, counts)).toThrow(
      /not a stable ASCII id/
    )
  })

  it('throws on non-finite / non-integer / negative shiftedCount', () => {
    const counts = fixtureShiftedCounts()
    counts.set('n100-b1', Number.NaN)
    expect(() =>
      buildSortOrderShiftMetrics(SORT_ORDER_SHIFT_COMBOS, fixtureSamples() as SortOrderShiftSamples, counts)
    ).toThrow(/shiftedCount is not a finite non-negative integer/)
    counts.set('n100-b1', 50.5)
    expect(() =>
      buildSortOrderShiftMetrics(SORT_ORDER_SHIFT_COMBOS, fixtureSamples() as SortOrderShiftSamples, counts)
    ).toThrow(/shiftedCount is not a finite non-negative integer/)
    counts.set('n100-b1', -1)
    expect(() =>
      buildSortOrderShiftMetrics(SORT_ORDER_SHIFT_COMBOS, fixtureSamples() as SortOrderShiftSamples, counts)
    ).toThrow(/shiftedCount is not a finite non-negative integer/)
    counts.set('n100-b1', Infinity)
    expect(() =>
      buildSortOrderShiftMetrics(SORT_ORDER_SHIFT_COMBOS, fixtureSamples() as SortOrderShiftSamples, counts)
    ).toThrow(/shiftedCount is not a finite non-negative integer/)
  })
})

describe('assertSortOrderShiftSampleCounts (fail-fast completeness guard)', () => {
  it('passes and records the validation outcome when every combo has the exact expected count', () => {
    const outcome = assertSortOrderShiftSampleCounts(
      SORT_ORDER_SHIFT_COMBOS,
      fixtureSamples() as SortOrderShiftSamples,
      SORT_ORDER_SHIFT_MEASURE_ROUNDS
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.verifiedCombos).toEqual(SORT_ORDER_SHIFT_COMBOS.map((c) => c.id))
    expect(outcome.expectedCount).toBe(SORT_ORDER_SHIFT_MEASURE_ROUNDS)
  })

  it('throws when a combo has fewer samples than expected (incomplete / truncated)', () => {
    const samples = fixtureSamples()
    samples.set('n500-b1', [1, 2, 3])
    expect(() =>
      assertSortOrderShiftSampleCounts(
        SORT_ORDER_SHIFT_COMBOS,
        samples as SortOrderShiftSamples,
        SORT_ORDER_SHIFT_MEASURE_ROUNDS
      )
    ).toThrow(/combo 'n500-b1' has 3 samples, expected exactly 20/)
  })

  it('throws when a combo has more samples than expected', () => {
    const samples = fixtureSamples()
    samples.set(
      'n100-b50',
      Array.from({ length: 21 }, (_, i) => i)
    )
    expect(() =>
      assertSortOrderShiftSampleCounts(
        SORT_ORDER_SHIFT_COMBOS,
        samples as SortOrderShiftSamples,
        SORT_ORDER_SHIFT_MEASURE_ROUNDS
      )
    ).toThrow(/combo 'n100-b50' has 21 samples, expected exactly 20/)
  })

  it('throws when a combo has no samples entry at all', () => {
    const samples = fixtureSamples()
    samples.delete('n1000-b10')
    expect(() =>
      assertSortOrderShiftSampleCounts(
        SORT_ORDER_SHIFT_COMBOS,
        samples as SortOrderShiftSamples,
        SORT_ORDER_SHIFT_MEASURE_ROUNDS
      )
    ).toThrow(/no samples recorded for combo 'n1000-b10'/)
  })

  it('throws when any combo is truncated by one (fail-fast before metric build)', () => {
    const samples = fixtureSamples()
    const target = SORT_ORDER_SHIFT_COMBOS[5]
    samples.set(target.id, samples.get(target.id)!.slice(0, SORT_ORDER_SHIFT_MEASURE_ROUNDS - 1))
    expect(() =>
      assertSortOrderShiftSampleCounts(
        SORT_ORDER_SHIFT_COMBOS,
        samples as SortOrderShiftSamples,
        SORT_ORDER_SHIFT_MEASURE_ROUNDS
      )
    ).toThrow(/has 19 samples, expected exactly 20/)
  })
})

describe('sortOrderShiftScale (deterministic numeric-only scale metadata)', () => {
  it('is numeric-only, finite, deterministic, and encodes the bounded matrix', () => {
    const scale = sortOrderShiftScale()
    for (const [k, v] of Object.entries(scale)) {
      expect(typeof v, `scale.${k} must be number`).toBe('number')
      expect(Number.isFinite(v), `scale.${k} must be finite`).toBe(true)
    }
    expect(scale.combos).toBe(9)
    expect(scale.topicSizeMin).toBe(100)
    expect(scale.topicSizeMid).toBe(500)
    expect(scale.topicSizeMax).toBe(1000)
    expect(scale.batchSizeMin).toBe(1)
    expect(scale.batchSizeMid).toBe(10)
    expect(scale.batchSizeMax).toBe(50)
    expect(scale.warmupRounds).toBe(SORT_ORDER_SHIFT_WARMUP_ROUNDS)
    expect(scale.measureRounds).toBe(SORT_ORDER_SHIFT_MEASURE_ROUNDS)
    const scale2 = sortOrderShiftScale()
    expect(scale2).toEqual(scale)
  })

  it('round counts match the declared warmup/measure constants and combo count matches the matrix length', () => {
    const scale = sortOrderShiftScale()
    expect(scale.warmupRounds).toBe(3)
    expect(scale.measureRounds).toBe(20)
    expect(scale.combos).toBe(SORT_ORDER_SHIFT_COMBOS.length)
  })
})
