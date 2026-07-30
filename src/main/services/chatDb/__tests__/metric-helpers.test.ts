/**
 * Focused tests for metric helper functions used by sqlite-runtime.perf.bench.ts.
 *
 * Validates percentile, sortTimings, mean, sum, and opsPerSec calculations
 * against known inputs so the benchmark output is trustworthy.
 */

import { describe, expect, it } from 'vitest'

import { mean, opsPerSec, percentile, sortTimings, sum } from './benchMetrics'

describe('percentile', () => {
  it('returns 0 for empty array', () => {
    expect(percentile([], 50)).toBe(0)
  })

  it('returns the single element for a one-element array', () => {
    expect(percentile([42], 50)).toBe(42)
    expect(percentile([42], 95)).toBe(42)
  })

  it('computes p50 for even-length array', () => {
    // [1, 2, 3, 4] → idx = ceil(0.5 * 4) - 1 = 1 → 2
    expect(percentile([1, 2, 3, 4], 50)).toBe(2)
  })

  it('computes p50 for odd-length array', () => {
    // [1, 2, 3, 4, 5] → idx = ceil(0.5 * 5) - 1 = 2 → 3
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3)
  })

  it('computes p95 correctly', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i + 1)
    // p95 → idx = ceil(0.95 * 100) - 1 = 94 → 95
    expect(percentile(arr, 95)).toBe(95)
  })

  it('computes p99 correctly', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i + 1)
    // p99 → idx = ceil(0.99 * 100) - 1 = 98 → 99
    expect(percentile(arr, 99)).toBe(99)
  })

  it('returns first element for p0 or very low percentiles', () => {
    expect(percentile([10, 20, 30], 1)).toBe(10)
  })

  it('returns last element for p100', () => {
    expect(percentile([10, 20, 30], 100)).toBe(30)
  })
})

describe('sortTimings', () => {
  it('returns sorted copy without mutating original', () => {
    const original = [3, 1, 2]
    const sorted = sortTimings(original)
    expect(sorted).toEqual([1, 2, 3])
    expect(original).toEqual([3, 1, 2])
  })

  it('handles empty array', () => {
    expect(sortTimings([])).toEqual([])
  })

  it('handles already sorted array', () => {
    expect(sortTimings([1, 2, 3])).toEqual([1, 2, 3])
  })
})

describe('mean', () => {
  it('returns 0 for empty array', () => {
    expect(mean([])).toBe(0)
  })

  it('computes mean correctly', () => {
    expect(mean([10, 20, 30])).toBe(20)
  })

  it('computes mean for single element', () => {
    expect(mean([42])).toBe(42)
  })

  it('computes mean with fractional result', () => {
    expect(mean([1, 2])).toBe(1.5)
  })
})

describe('sum', () => {
  it('returns 0 for empty array', () => {
    expect(sum([])).toBe(0)
  })

  it('computes sum correctly', () => {
    expect(sum([10, 20, 30])).toBe(60)
  })

  it('computes sum for single element', () => {
    expect(sum([42])).toBe(42)
  })

  it('computes sum with fractional values', () => {
    expect(sum([1.5, 2.5, 3.0])).toBeCloseTo(7.0)
  })
})

describe('opsPerSec', () => {
  it('returns 0 for zero elapsed', () => {
    expect(opsPerSec(10, 0)).toBe(0)
  })

  it('returns 0 for zero ops', () => {
    expect(opsPerSec(0, 1000)).toBe(0)
  })

  it('returns 0 for negative values', () => {
    expect(opsPerSec(-1, 1000)).toBe(0)
    expect(opsPerSec(10, -1000)).toBe(0)
  })

  it('computes ops/sec correctly', () => {
    // 10 ops in 1000ms → 10 ops/sec
    expect(opsPerSec(10, 1000)).toBe(10)
  })

  it('computes ops/sec with fractional result', () => {
    // 5 ops in 2000ms → 2.5 ops/sec
    expect(opsPerSec(5, 2000)).toBe(2.5)
  })

  it('computes ops/sec for sub-second elapsed', () => {
    // 100 ops in 50ms → 2000 ops/sec
    expect(opsPerSec(100, 50)).toBe(2000)
  })

  it('matches the corrected throughput formula (not mean-based overstatement)', () => {
    // Simulate: 50 ops, each taking 10ms mean → total elapsed ≈ 500ms
    // Old (wrong): 50 / (10 / 1000) = 5000 ops/sec (overstated by 50x)
    // Correct: 50 / (500 / 1000) = 100 ops/sec
    const totalOps = 50
    const meanMs = 10
    const totalElapsedMs = totalOps * meanMs // 500ms
    expect(opsPerSec(totalOps, totalElapsedMs)).toBe(100)
  })
})
