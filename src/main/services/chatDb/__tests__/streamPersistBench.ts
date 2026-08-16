/**
 * PERF-STREAM-ATTR-001 streaming-persistence differential benchmark — pure
 * helpers (LOCK-STREAM-ATTR-001..006).
 *
 * Node-lane companion to the production-build E2E attribution spec that
 * measures the deterministic SQLite base-table write versus the
 * normalized/FTS trigger projection via two equivalent deterministic temp
 * databases: one trigger-maintained (production schema), one with the three
 * sync triggers dropped (base-only write + explicit projection rebuild).
 * Both DBs run the identical deterministic update sequences; the differential
 * `triggerOn − baseOnly` is an honest per-round ESTIMATE of the
 * projection-trigger cost of each streaming write — NOT direct trigger-body
 * profiling (better-sqlite3 does not expose trigger-body time separately from
 * the UPDATE; LOCK-STREAM-ATTR-006).
 *
 * This module is the pure, side-effect-free half of that benchmark:
 *
 *   - the env gate resolver (default skip; canonical `pnpm bench:stream-persist`),
 *   - the deterministic profile vocabulary (growth / no-change / completion),
 *   - the content/session builders (synthetic, no user data),
 *   - the per-round differential arithmetic,
 *   - the metric grid builder and the sample-count fail-fast guard.
 *
 * This file is intentionally NOT a *.test.ts / *.bench.ts file so it is never
 * collected directly by Vitest. It imports no native modules, so its focused
 * unit tests stay in the core lane (`pnpm test:main:core`).
 */

import type { BenchmarkGate, BenchmarkMetric } from './benchResult'

// ---------------------------------------------------------------------------
// Env gate — the diagnostic runs ONLY when explicitly enabled
// ---------------------------------------------------------------------------

/** Environment variable that enables the on-demand streaming-persistence benchmark. */
export const STREAM_PERSIST_BENCH_ENV = 'STREAM_PERSIST_BENCH'

/**
 * Deterministically resolve the STREAM_PERSIST_BENCH gate.
 *
 * - unset / empty / whitespace-only → disabled (the default; no temp DBs,
 *   no corpus, no artifact);
 * - `1` or `true` (case-insensitive) → enabled;
 * - any other non-empty value → throws loudly, so a misconfigured gate can
 *   never silently run — or silently skip — the diagnostic.
 */
export function resolveStreamPersistGate(value: string | undefined): boolean {
  if (value === undefined || value.trim().length === 0) return false
  const normalized = value.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true') return true
  throw new Error(
    `STREAM_PERSIST_BENCH must be '1'/'true' to enable or unset/empty to skip ` +
      `(got '${value}'). Enable only through the canonical \`pnpm bench:stream-persist\` script.`
  )
}

// ---------------------------------------------------------------------------
// Fixed rounds, profile vocabulary, identity, and provenance
// ---------------------------------------------------------------------------

/** Warmup rounds per profile/lane before any measurement. */
export const STREAM_PERSIST_WARMUP_ROUNDS = 10

/** Measured rounds per profile/lane (a meaningful p50/p95 needs >= 40). */
export const STREAM_PERSIST_MEASURE_ROUNDS = 40

/** Corpus scale: messages+blocks pre-seeded in each temp DB. */
export const STREAM_PERSIST_CORPUS_BLOCKS = 200

/** Stable schema-v1 artifact id — the `chatdb-stream-persist-*` family (LOCK-STREAM-ATTR-004). */
export const STREAM_PERSIST_NODE_BENCH_ID = 'chatdb-stream-persist-node'

/** Human-readable benchmark name carried in the schema-v1 artifact. */
export const STREAM_PERSIST_NODE_BENCH_NAME =
  'Streaming persistence — base-table write vs trigger projection differential (deterministic temp DB)'

/** Explicit safe canonical command recorded in the artifact `environment.command`. */
export const STREAM_PERSIST_NODE_COMMAND = 'pnpm bench:stream-persist'

/** The three deterministic update profiles, in deterministic row order. */
export const STREAM_PERSIST_PROFILES = ['growth', 'nochange', 'completion'] as const

export type StreamPersistProfileKey = (typeof STREAM_PERSIST_PROFILES)[number]

/** Stats emitted per profile/lane, in deterministic row order. */
export const STREAM_PERSIST_STATS = ['p50', 'p95', 'mean', 'min', 'max'] as const

/** Differential stats (per-round triggerOn − baseOnly), in deterministic order. */
export const STREAM_PERSIST_DIFF_STATS = ['p50', 'p95', 'mean'] as const

/**
 * Deterministic synthetic content for the streaming block update at round
 * `i` (1-based) of a profile. Never user data.
 *
 * - `growth`: the accumulated-content profile — each round carries the FULL
 *   accumulated text seen so far, mirroring the production throttle that
 *   resends the whole accumulated stream content per flush. Content length
 *   grows monotonically to `MEASURE_ROUNDS` segments.
 * - `nochange` / `completion`: identical fixed content on every round —
 *   mirroring a redundant flush where the stored content stays the same but
 *   the UPDATE statement still fires the content trigger.
 */
export function streamPersistContent(key: StreamPersistProfileKey, roundIndex: number): string {
  switch (key) {
    case 'growth':
      return Array.from(
        { length: STREAM_PERSIST_MEASURE_ROUNDS },
        (_, j) => `paragraph-${j} deterministic filler words `
      )
        .slice(0, roundIndex)
        .join('')
        .trimEnd()
    case 'nochange':
    case 'completion':
      return 'identical fixed streaming paragraph content (unchanged across rounds)'
  }
}

/** Deterministic status value for the completion profile flush. */
export const STREAM_PERSIST_COMPLETION_STATUS = 'success'

/** Deterministic streaming status for the pre-completion rows. */
export const STREAM_PERSIST_STREAMING_STATUS = 'streaming'

// ---------------------------------------------------------------------------
// Sample record + differential arithmetic
// ---------------------------------------------------------------------------

/** Per-profile timing samples for one lane. */
export interface StreamPersistLaneSamples {
  triggerOn: number[]
  baseOnly: number[]
}

/** Per-call projection-row-op counts (changes − 1) recorded per lane. */
export interface StreamPersistOpCounts {
  triggerOn: number[]
  baseOnly: number[]
}

/**
 * Per-round differential (triggerOn − baseOnly). The two lanes run the
 * identical deterministic content sequence in lockstep rounds, so pairing by
 * index is exact. Values are finite and may be negative (the honest estimate;
 * never a threshold). Fails loudly on length mismatch so a truncated
 * measurement can never produce a misleading metric.
 */
export function deriveStreamPersistDifferentialSamples(sample: StreamPersistLaneSamples): number[] {
  const { triggerOn, baseOnly } = sample
  if (triggerOn.length !== baseOnly.length) {
    throw new Error('deriveStreamPersistDifferentialSamples: triggerOn and baseOnly must have the same length')
  }
  return triggerOn.map((value, index) => value - baseOnly[index])
}

// ---------------------------------------------------------------------------
// Metric grid builder
// ---------------------------------------------------------------------------

const PROFILE_LABEL: Record<StreamPersistProfileKey, string> = {
  growth: 'accumulated-content growth (steady streaming proxy)',
  nochange: 'identical-content rewrite (redundant projection rewrite proxy)',
  completion: 'completion-style flush (unchanged content + status flip)'
}

/** Compute the deviation of observation `value` from `baseline`, percent-form. */
export function deviationPct(value: number, baseline: number): number {
  return Math.round((value / baseline) * 1000) / 10
}

/** p50/p95/mean/min/max stats from a finite sample set (nearest-rank p50/p95). */
export function streamPersistStats(samples: readonly number[]): Record<'p50' | 'p95' | 'mean' | 'min' | 'max', number> {
  if (samples.length === 0) {
    throw new Error('streamPersistStats: empty sample set (no measurements recorded)')
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
    min: sorted[0],
    max: sorted[sorted.length - 1]
  }
}

function laneStatsMetricRows(
  profile: StreamPersistProfileKey,
  lane: 'triggerOn' | 'baseOnly',
  stats: Record<'p50' | 'p95' | 'mean' | 'min' | 'max', number>
): BenchmarkMetric[] {
  const prefix = `profile.${profile}.${lane}`
  const label = `${PROFILE_LABEL[profile]} — ${lane === 'triggerOn' ? 'trigger-maintained lane' : 'base-only lane'}`
  return [
    { id: `${prefix}.p50`, name: `${label} p50`, value: stats.p50, unit: 'ms' },
    { id: `${prefix}.p95`, name: `${label} p95`, value: stats.p95, unit: 'ms' },
    { id: `${prefix}.mean`, name: `${label} mean`, value: stats.mean, unit: 'ms' },
    { id: `${prefix}.min`, name: `${label} min`, value: stats.min, unit: 'ms' },
    { id: `${prefix}.max`, name: `${label} max`, value: stats.max, unit: 'ms' }
  ]
}

function diffStatsMetricRows(
  profile: StreamPersistProfileKey,
  stats: Record<'p50' | 'p95' | 'mean' | 'min' | 'max', number>
): BenchmarkMetric[] {
  const prefix = `profile.${profile}.differential`
  const label = `${PROFILE_LABEL[profile]} — per-round triggerOn − baseOnly estimate`
  return [
    { id: `${prefix}.p50`, name: `${label} p50`, value: stats.p50, unit: 'ms' },
    { id: `${prefix}.p95`, name: `${label} p95`, value: stats.p95, unit: 'ms' },
    { id: `${prefix}.mean`, name: `${label} mean`, value: stats.mean, unit: 'ms' }
  ]
}

/**
 * Build the full per-profile metric grid in deterministic order. Missing
 * samples, empty sets, or unknown profiles fail fast.
 */
export function buildStreamPersistMetrics(
  samples: ReadonlyMap<StreamPersistProfileKey, StreamPersistLaneSamples>
): BenchmarkMetric[] {
  const metrics: BenchmarkMetric[] = []
  for (const profile of STREAM_PERSIST_PROFILES) {
    const laneSamples = samples.get(profile)
    if (!laneSamples) {
      throw new Error(`buildStreamPersistMetrics: no samples recorded for profile '${profile}'`)
    }
    metrics.push(...laneStatsMetricRows(profile, 'triggerOn', streamPersistStats(laneSamples.triggerOn)))
    metrics.push(...laneStatsMetricRows(profile, 'baseOnly', streamPersistStats(laneSamples.baseOnly)))
    metrics.push(
      ...diffStatsMetricRows(profile, streamPersistStats(deriveStreamPersistDifferentialSamples(laneSamples)))
    )
  }
  return metrics
}

/** Recorded outcome of a successful sample-count validation (fail-fast guard). */
export interface StreamPersistSampleValidation {
  /** Always `true` — the guard throws before returning on any mismatch. */
  ok: true
  /** Every profile verified to hold exactly `expectedCount` measured samples per lane. */
  verifiedProfiles: readonly StreamPersistProfileKey[]
  /** The exact sample count every verified lane matched. */
  expectedCount: number
  /** The lanes verified per profile, in deterministic order. */
  verifiedLanes: readonly string[]
}

/**
 * Fail-fast completeness guard: every profile must have exactly
 * `expectedCount` measured samples for BOTH lanes before any artifact is
 * built. Wired in after the measure rounds and before result construction.
 * Returns the recorded validation outcome for the artifact's `samples.complete`
 * gate; the original assertion error is NOT swallowed.
 */
export function assertStreamPersistSampleCounts(
  samples: ReadonlyMap<StreamPersistProfileKey, StreamPersistLaneSamples>,
  expectedCount: number
): StreamPersistSampleValidation {
  for (const profile of STREAM_PERSIST_PROFILES) {
    const laneSamples = samples.get(profile)
    if (!laneSamples) {
      throw new Error(
        `assertStreamPersistSampleCounts: no samples recorded for profile '${profile}' ` +
          `(expected ${expectedCount} per lane)`
      )
    }
    for (const lane of ['triggerOn', 'baseOnly'] as const) {
      if (laneSamples[lane].length !== expectedCount) {
        throw new Error(
          `assertStreamPersistSampleCounts: profile '${profile}' lane '${lane}' has ` +
            `${laneSamples[lane].length} samples, expected exactly ${expectedCount}`
        )
      }
    }
  }
  return {
    ok: true,
    verifiedProfiles: [...STREAM_PERSIST_PROFILES],
    expectedCount,
    verifiedLanes: ['triggerOn', 'baseOnly']
  }
}

/** Scale metadata contributed by the deterministic profile set. */
export function streamPersistScale(): {
  warmupRounds: number
  measureRounds: number
  corpusBlocks: number
  profileCode: number
} {
  return {
    warmupRounds: STREAM_PERSIST_WARMUP_ROUNDS,
    measureRounds: STREAM_PERSIST_MEASURE_ROUNDS,
    corpusBlocks: STREAM_PERSIST_CORPUS_BLOCKS,
    profileCode: 0
  }
}

export interface StreamPersistGates {
  seedParity: boolean
  postBaseParity: boolean
  projectionEquivalence: boolean
  projectionOps: boolean
  samplesComplete: boolean
  abi137: boolean
  schemaV1: boolean
}

/**
 * Build the L1 correctness/parity gate list for the artifact. All gates are
 * structural/correctness assertions (LOCK-STREAM-ATTR-005); numeric timings
 * are never gates.
 */
export function buildStreamPersistGates(gates: StreamPersistGates, detail: Record<string, string>): BenchmarkGate[] {
  return [
    {
      id: 'parity.seed',
      name: 'seed parity — base tables and projections equal before timing',
      kind: 'correctness',
      passed: gates.seedParity,
      detail: detail.seedParity
    },
    {
      id: 'parity.postBase',
      name: 'base-table parity after the update sequences (base-only lane wrote identical content)',
      kind: 'correctness',
      passed: gates.postBaseParity,
      detail: detail.postBaseParity
    },
    {
      id: 'parity.projectionEquivalence',
      name: 'projection equivalence — explicit rebuild of the base-only lane equals the trigger-maintained projection',
      kind: 'correctness',
      passed: gates.projectionEquivalence,
      detail: detail.projectionEquivalence
    },
    {
      id: 'counts.projectionOps',
      name: 'projection row-op accounting — trigger-on updates report strictly more changed rows than base-only (derived DELETE+INSERT rows) and the projection stays a 1:1 pair',
      kind: 'correctness',
      passed: gates.projectionOps,
      detail: detail.projectionOps
    },
    {
      id: 'samples.complete',
      name: 'sample completeness — every profile/lane holds exactly the measured round count',
      kind: 'correctness',
      passed: gates.samplesComplete,
      detail: detail.samplesComplete
    },
    {
      id: 'environment.node137',
      name: 'measured runtime is the Node ABI 137 lane with the safe canonical command',
      kind: 'correctness',
      passed: gates.abi137,
      detail: detail.abi137
    },
    {
      id: 'privacy.schemaV1',
      name: 'artifact complies with the PERF-001 schema v1 closed set',
      kind: 'correctness',
      passed: gates.schemaV1,
      detail:
        'metrics/gates/scale carry only numbers and fixed strings; no message content, credentials, paths, or raw DB sizes (enforced at write time)'
    }
  ]
}
