/**
 * Metric utility functions for benchmark reporting.
 *
 * Pure functions with no side effects. Used by sqlite-runtime.perf.bench.ts
 * and tested by metric-helpers.test.ts.
 */

/** Compute the p-th percentile from a pre-sorted array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)]
}

/** Return a new sorted copy of timings (ascending). */
export function sortTimings(timings: number[]): number[] {
  return [...timings].sort((a, b) => a - b)
}

/** Compute the arithmetic mean of an array. */
export function mean(timings: number[]): number {
  if (timings.length === 0) return 0
  return timings.reduce((a, b) => a + b, 0) / timings.length
}

/** Sum all values in an array. */
export function sum(timings: number[]): number {
  return timings.reduce((a, b) => a + b, 0)
}

/**
 * Compute operations per second from total operation count and total elapsed
 * wall-clock milliseconds. Uses total elapsed (not mean × count) to avoid
 * overstating throughput by the operation count factor.
 */
export function opsPerSec(totalOps: number, totalElapsedMs: number): number {
  if (totalElapsedMs <= 0 || totalOps <= 0) return 0
  return totalOps / (totalElapsedMs / 1000)
}
