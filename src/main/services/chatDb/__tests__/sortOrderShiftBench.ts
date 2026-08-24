/**
 * Sort-order shift controlled scale curve — pure helpers (measurement-only M1).
 *
 * On-demand diagnostic companion to the existing chat DB bench harness area that
 * measures middle/batch insert `sort_order` shift scaling via isolated temporary
 * SQLite + existing MessagesRepository insertAt/insertManyAt APIs.
 *
 * This module is the pure, side-effect-free half:
 *
 *   - gate + scale matrix validation (deterministic, fail-loud on unknown input),
 *   - bounded scale matrix (topic sizes 100/500/1000 × batch sizes 1/10/50,
 *     insertion index floor(N/2); directional diagnostic evidence, NOT an
 *     adopted threshold),
 *   - expected shifted-row count helper (N - index for single, N - index for
 *     batch regardless of batch size on dense topic),
 *   - per-combo timing stats, metric grid builder, sample-count fail-fast guard,
 *   - benchmark identity + provenance constants.
 *
 * This file is intentionally NOT a *.test.ts / *.bench.ts file so it is never
 * collected directly by Vitest. It imports no native modules, so its focused
 * unit tests stay in the core lane (`pnpm test:main:core`).
 */

import type { BenchmarkMetric } from './benchResult'

// ---------------------------------------------------------------------------
// Env gate — the diagnostic runs ONLY when explicitly enabled
// ---------------------------------------------------------------------------

/** Environment variable that enables the on-demand sort-order shift benchmark. */
export const SORT_ORDER_SHIFT_BENCH_ENV = 'SORT_ORDER_SHIFT_BENCH'

/**
 * Deterministically resolve the SORT_ORDER_SHIFT_BENCH gate.
 *
 * - unset / empty / whitespace-only → disabled (default; no temp DB, no corpus,
 *   no artifact);
 * - `1` or `true` (case-insensitive) → enabled;
 * - any other non-empty value → throws loudly, so a misconfigured gate can
 *   never silently run — or silently skip — the diagnostic.
 */
export function resolveSortOrderShiftGate(value: string | undefined): boolean {
  if (value === undefined || value.trim().length === 0) return false
  const normalized = value.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true') return true
  throw new Error(
    `SORT_ORDER_SHIFT_BENCH must be '1'/'true' to enable or unset/empty to skip ` +
      `(got '${value}'). Enable only through the canonical \`pnpm bench:sort-order-shift\` script.`
  )
}

// ---------------------------------------------------------------------------
// Bounded scale matrix — directional diagnostic evidence, NOT a threshold
// ---------------------------------------------------------------------------

/**
 * Topic sizes for the bounded scale matrix.
 * Three points (100, 500, 1000) keep the harness bounded and make the
 * `topic size` axis visible in `benchmark.scale`. Values are directional
 * diagnostic evidence only; no threshold, capacity, or default is adopted
 * from this matrix.
 */
export const SORT_ORDER_SHIFT_TOPIC_SIZES = [100, 500, 1000] as const

/**
 * Batch sizes for the bounded scale matrix.
 * Three points (1, 10, 50) keep the harness bounded and make the `batch size`
 * axis visible. Batch size 1 exercises the single middle-insert path
 * (`insertAt`); 10/50 exercise the batch middle-insert path (`insertManyAt`).
 * Directional evidence only; no adopted threshold.
 */
export const SORT_ORDER_SHIFT_BATCH_SIZES = [1, 10, 50] as const

export type SortOrderShiftTopicSize = (typeof SORT_ORDER_SHIFT_TOPIC_SIZES)[number]
export type SortOrderShiftBatchSize = (typeof SORT_ORDER_SHIFT_BATCH_SIZES)[number]

/** Warmup rounds per combo before any measurement (each round covers one insert). */
export const SORT_ORDER_SHIFT_WARMUP_ROUNDS = 3

/** Measured rounds per combo (enough samples for a meaningful p95, bounded). */
export const SORT_ORDER_SHIFT_MEASURE_ROUNDS = 20

/** Stable schema-v1 artifact id — separate from search/runtime bench ids. */
export const SORT_ORDER_SHIFT_BENCH_ID = 'chatdb-sort-order-shift'

/** Human-readable benchmark name carried in the schema-v1 artifact. */
export const SORT_ORDER_SHIFT_BENCH_NAME =
  'Sort-order shift — middle/batch insert scale diagnostic (deterministic temp DB)'

/** Explicit safe canonical command recorded in the artifact `environment.command`. */
export const SORT_ORDER_SHIFT_COMMAND = 'pnpm bench:sort-order-shift'

/** Stats emitted per combo, in deterministic row order. */
export const SORT_ORDER_SHIFT_STATS = ['p50', 'p95', 'mean', 'max'] as const

export type SortOrderShiftStat = (typeof SORT_ORDER_SHIFT_STATS)[number]

/**
 * Single bounded matrix entry.
 *
 * `index` is floor(N/2) for the given topic size — the middle insertion point.
 * `id` is a stable ASCII id embedded verbatim in metric ids (`n${N}-b${B}`).
 */
export interface SortOrderShiftCombo {
  /** Topic size N (number of messages before the insert). */
  topicSize: SortOrderShiftTopicSize
  /** Batch size M (number of messages inserted; 1 = single middle insert). */
  batchSize: SortOrderShiftBatchSize
  /** Insertion index floor(N/2). */
  index: number
  /** Stable ASCII combo id, e.g. `n100-b1`. */
  id: string
  /** Human-readable combo name. */
  name: string
}

/**
 * Deterministic bounded matrix: every topic size × every batch size, ordered
 * by topicSize ascending then batchSize ascending. `index` is floor(N/2).
 * The matrix is bounded (3×3 = 9 combos) and is directional diagnostic
 * evidence only; no threshold or capacity is adopted from it.
 */
export const SORT_ORDER_SHIFT_COMBOS: readonly SortOrderShiftCombo[] = (() => {
  const combos: SortOrderShiftCombo[] = []
  for (const topicSize of SORT_ORDER_SHIFT_TOPIC_SIZES) {
    for (const batchSize of SORT_ORDER_SHIFT_BATCH_SIZES) {
      const index = Math.floor(topicSize / 2)
      combos.push({
        topicSize,
        batchSize,
        index,
        id: `n${topicSize}-b${batchSize}`,
        name: `N=${topicSize} M=${batchSize} idx=${index}`
      })
    }
  }
  return combos
})()

/**
 * Expected shifted-row count for a dense topic.
 *
 * For a dense zero-based topic of size N, inserting at `index` shifts every
 * sibling at or after `index`, i.e. `N - index` rows. For batch inserts the
 * same `N - index` rows are shifted by M (`sort_order += M`), so the count is
 * independent of M — the trigger counts rows, not the increment.
 */
export function expectedShiftedCount(topicSize: number, index: number): number {
  return topicSize - index
}

/** Per-combo timing samples keyed by combo id. */
export type SortOrderShiftSamples = ReadonlyMap<string, readonly number[]>

/** Per-combo shifted-row count samples (one count per measured round, but all equal for dense). */
export type SortOrderShiftCountSamples = ReadonlyMap<string, readonly number[]>

export interface TimingStats {
  p50: number
  p95: number
  mean: number
  max: number
}

/**
 * Compute p50 / p95 / mean / max from a sample set using the nearest-rank
 * percentile semantics — the same ceiling-index formula the pooled metrics use.
 * Throws on an empty sample set.
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

const COMBO_ID_PATTERN = /^n\d+-b\d+$/

function validateComboId(comboId: string): void {
  if (!COMBO_ID_PATTERN.test(comboId)) {
    throw new Error(
      `buildSortOrderShiftMetrics: combo id '${comboId}' is not a stable ASCII id ` + `(must match ${COMBO_ID_PATTERN})`
    )
  }
}

/**
 * Build the per-combo metric rows in deterministic order: combos in the order
 * given, then stats (`p50`, `p95`, `mean`, `max`). Metric ids are
 * `combo.<comboId>.insert.<stat>` (unit `ms`) and `combo.<comboId>.shiftedCount`
 * (unitless count). Shifted counts are expected values (N - index) and are
 * finite integers; timing values are finite milliseconds.
 */
export function buildSortOrderShiftMetrics(
  combos: readonly SortOrderShiftCombo[],
  samples: SortOrderShiftSamples,
  shiftedCounts: ReadonlyMap<string, number>
): BenchmarkMetric[] {
  const metrics: BenchmarkMetric[] = []
  const seenIds = new Set<string>()
  for (const combo of combos) {
    validateComboId(combo.id)
    if (seenIds.has(combo.id)) {
      throw new Error(`buildSortOrderShiftMetrics: duplicate combo id '${combo.id}'`)
    }
    seenIds.add(combo.id)
    const comboSamples = samples.get(combo.id)
    if (comboSamples === undefined) {
      throw new Error(`buildSortOrderShiftMetrics: no samples recorded for combo '${combo.id}'`)
    }
    const shifted = shiftedCounts.get(combo.id)
    if (shifted === undefined) {
      throw new Error(`buildSortOrderShiftMetrics: no shiftedCount recorded for combo '${combo.id}'`)
    }
    if (!Number.isInteger(shifted) || shifted < 0 || !Number.isFinite(shifted)) {
      throw new Error(
        `buildSortOrderShiftMetrics: combo '${combo.id}' shiftedCount is not a finite non-negative integer: ${shifted}`
      )
    }
    const stats = computeTimingStats(comboSamples)
    for (const stat of SORT_ORDER_SHIFT_STATS) {
      metrics.push({
        id: `combo.${combo.id}.insert.${stat}`,
        name: `Combo ${combo.name} insert ${stat}`,
        value: stats[stat],
        unit: 'ms'
      })
    }
    metrics.push({
      id: `combo.${combo.id}.shiftedCount`,
      name: `Combo ${combo.name} shifted rows (expected N-index)`,
      value: shifted
    })
  }
  return metrics
}

// ---------------------------------------------------------------------------
// Sample-count fail-fast guard
// ---------------------------------------------------------------------------

/** Recorded outcome of a successful sample-count validation (fail-fast guard). */
export interface SortOrderShiftSampleValidation {
  /** Always `true` — the guard throws before returning on any mismatch. */
  ok: true
  /** Every combo id verified to hold exactly `expectedCount` samples. */
  verifiedCombos: readonly string[]
  /** The exact sample count every verified combo matched. */
  expectedCount: number
}

/**
 * Fail-fast completeness guard: every combo must have exactly `expectedCount`
 * measured samples before any artifact is built. Wired in after the measure
 * rounds and before result construction.
 */
export function assertSortOrderShiftSampleCounts(
  combos: readonly SortOrderShiftCombo[],
  samples: SortOrderShiftSamples,
  expectedCount: number
): SortOrderShiftSampleValidation {
  for (const combo of combos) {
    const comboSamples = samples.get(combo.id)
    if (comboSamples === undefined) {
      throw new Error(
        `assertSortOrderShiftSampleCounts: no samples recorded for combo '${combo.id}' ` + `(expected ${expectedCount})`
      )
    }
    if (comboSamples.length !== expectedCount) {
      throw new Error(
        `assertSortOrderShiftSampleCounts: combo '${combo.id}' has ${comboSamples.length} samples, ` +
          `expected exactly ${expectedCount}`
      )
    }
  }
  return {
    ok: true,
    verifiedCombos: combos.map((c) => c.id),
    expectedCount
  }
}

/** Scale metadata contributed by the bounded matrix (all values finite numbers). */
export function sortOrderShiftScale(): Record<string, number> {
  return {
    combos: SORT_ORDER_SHIFT_COMBOS.length,
    topicSizeMin: Math.min(...SORT_ORDER_SHIFT_TOPIC_SIZES),
    topicSizeMid: SORT_ORDER_SHIFT_TOPIC_SIZES[1],
    topicSizeMax: Math.max(...SORT_ORDER_SHIFT_TOPIC_SIZES),
    batchSizeMin: Math.min(...SORT_ORDER_SHIFT_BATCH_SIZES),
    batchSizeMid: SORT_ORDER_SHIFT_BATCH_SIZES[1],
    batchSizeMax: Math.max(...SORT_ORDER_SHIFT_BATCH_SIZES),
    warmupRounds: SORT_ORDER_SHIFT_WARMUP_ROUNDS,
    measureRounds: SORT_ORDER_SHIFT_MEASURE_ROUNDS
  }
}
