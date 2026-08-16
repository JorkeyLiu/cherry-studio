/**
 * PERF-104 page-side aggregate `topicExists` round-trip measurement
 * (production-build Playwright E2E).
 *
 * Purpose (completed legacy measurement asset — PERF-104 page-side `topicExists` RTT slice,
 * measurement scope closed; evidence L1/L3 semantics per docs/performance-measurement.md §2,
 * schema v1 contract per §3 — this asset claims no current hot-path budget inventory):
 *   Deterministic, bounded, correctness-first measurements of the renderer
 *   PAGE-SIDE AGGREGATE `window.api.chatDb.topicExists` round trip for two
 *   groups — an EXISTING target (the fixture default assistant's default
 *   topic, already ensured in SQLite) and a TRULY MISSING target (a fixed
 *   runtime sentinel that is never ensured) — against a FRESH production
 *   build via the standard shared E2E fixture. The measured interval is the
 *   DIRECT bridge envelope (NOT the DbService unwrap): renderer page await +
 *   preload structured clone + Main validation/service/repository/Drizzle
 *   prepare + SQLite EXISTS + result validation + reply. It is neither pure
 *   IPC nor pure SQLite — no internal attribution is claimed. This slice is
 *   MEASUREMENT-ONLY: no runtime optimization, no threshold, no fix
 *   direction (PERF-LOCK-004/005/007).
 *
 * RTT definition (`scale.rttDefinitionCode = 1`):
 *   t0 = `performance.now()` sampled in the page immediately before the
 *   awaited direct `window.api.chatDb.topicExists({ topicId })` call;
 *   elapsed = `performance.now() - t0` after the awaited envelope resolves.
 *   Every call is strictly serial (one awaited call at a time; no
 *   concurrency, no Promise.all, no fan-out).
 *
 * Ordering contract (`scale.interleavedOrderCode = 1`): for each round the
 * two calls alternate order to neutralize fixed ordering/cache drift — even
 * round index: existing → missing; odd round index: missing → existing.
 * The alternation applies to BOTH the warmup series and the measured series
 * (`scale.serialAwaitCode = 1`: strict serial awaits, single evaluate loop).
 *
 * Scale (recorded verbatim in the artifact's numeric scale map):
 *   - 2 groups (existing / missing), 20 WARMUP rounds per group (excluded
 *     from metrics) + 100 MEASURED rounds per group = 40 warmup calls +
 *     200 measured calls. The warmups run the FULL correctness checks
 *     (envelope, value, finiteness) but their timings never enter the
 *     artifact metrics; only the 100 measured timings per group do
 *     (`scale.totalMeasuredSamples = 200`).
 *
 * Correctness gates (all 7 are correctness gates; run BEFORE the artifact is
 * written, and any violation aborts the test and produces NO artifact):
 *   - rtt.okEnvelope — every direct call returned the `{ok:true,
 *     value:boolean}` ChatDbResult envelope.
 *   - rtt.valueCorrect — existing target returned value true and the truly
 *     missing sentinel returned value false for every call.
 *   - rtt.finiteNonNegative — every recorded elapsed is finite and >= 0.
 *   - rtt.serialInterleaved — strict serial awaits (single evaluate loop);
 *     even rounds existing-first / odd rounds missing-first (measured series
 *     splits 50/50 by first-call group).
 *   - samples.completed — all 20 warmup + 100 measured rounds per group
 *     completed; measured series hold exactly 100 existing + 100 missing
 *     timings.
 *   - environment.abi145 — measured runtime is the Electron ABI 145 lane via
 *     the safe canonical command (`pnpm test:e2e`).
 *   - privacy.schemaV1 — metrics/gates/scale carry only numbers and fixed
 *     strings; no topic IDs, message content, paths, credentials, or raw DB
 *     sizes (enforced at write time by the shared schema-v1 validator and
 *     re-asserted in-spec on the serialized artifact).
 *
 *   There is NO threshold gate and NO latency reference anywhere in this
 *   spec or in the artifact (PERF-LOCK-005): the numbers are L3 directional
 *   values only.
 *
 * Privacy:
 *   - The existing target's topic id is read from the renderer store at
 *     runtime and passed ONLY as an explicit `page.evaluate` argument. It
 *     never enters the artifact, console output, or any attachment; the
 *     missing target is a fixed non-sensitive runtime sentinel that is never
 *     ensured and never printed.
 *   - Console output carries only aggregate summaries (phase/group counts
 *     and summarized timings) plus the artifact file BASENAME — never IDs
 *     and never absolute paths.
 *
 * Evidence classification (PERF-LOCK-003 / docs/performance-measurement.md §2):
 *   - Deterministic L1 regression evidence when run on a fresh build with
 *     the standard fixture; the numeric metrics remain provisional L3 values
 *     until re-measured per docs/performance-measurement.md §7.
 *
 * Instrumentation boundary (PERF-LOCK-006/008):
 *   - The measurement lives entirely in the test page context (one
 *     `page.evaluate` for the whole warmup+measured series; three untimed
 *     Phase 0 evaluates: store retrieval + two direct bridge probes). No
 *     production code is changed, no application instrumentation is added,
 *     no Main-process wiring is touched, no mock behavior is changed, no
 *     UI send/stream occurs.
 *   - Serialization rule: `page.evaluate` callbacks are serialized WITHOUT
 *     module closures — every value a callback reads arrives as an explicit
 *     evaluate argument.
 *
 * Cleanup/abort:
 *   - The fixture owns the disposable profile/owned-temp-root cleanup and
 *     closes the app. A failed assertion or a rejected evaluate throws and
 *     produces NO artifact (the artifact is written only after every
 *     assertion passed). Bounded-run budget: a 5-minute test timeout aligned
 *     with the tiny per-call cost (a few ms per direct call, ~240 calls
 *     total), so a hang fails fail-closed with no artifact.
 */
import * as fs from 'fs'
import * as path from 'path'

import type { Page } from '@playwright/test'

import {
  type BenchmarkGate,
  type BenchmarkMetric,
  type BenchmarkResult,
  BENCH_RESULT_SCHEMA_VERSION,
  collectEnvironmentMetadata,
  writeBenchmarkResult
} from '../../../../src/main/services/chatDb/__tests__/benchResult'
import { mean, percentile, sortTimings } from '../../../../src/main/services/chatDb/__tests__/benchMetrics'
import { expect, test } from '../../fixtures/electron.fixture'

// ---------------------------------------------------------------------------
// Deterministic bounded scale (recorded verbatim in the artifact's scale map)
// ---------------------------------------------------------------------------

/**
 * Fixed scale of the RTT measurement. Warmup rounds run full correctness but
 * never enter the measured series; measured rounds are the only series the
 * artifact metrics summarize. `groups` = the existing/missing target groups.
 */
const SCALE = {
  groups: 2,
  warmupSamplesPerGroup: 20,
  measuredSamplesPerGroup: 100,
  /** RTT definition revision (this file's direct-bridge interval contract). */
  rttDefinitionCode: 1,
  /** Strict serial awaits (single evaluate loop, one awaited call at a time). */
  serialAwaitCode: 1,
  /** Alternating round order: even existing-first / odd missing-first. */
  interleavedOrderCode: 1
} as const

/** Numeric profile identity recorded in the scale map (single closed profile). */
const PROFILE_CODE = 0

/**
 * Total direct calls across the whole run: each round makes 2 calls (one per
 * group), so warmup contributes `groups x warmupSamplesPerGroup` calls and the
 * measured series contributes `groups x measuredSamplesPerGroup` calls.
 */
const TOTAL_CALLS = SCALE.groups * (SCALE.warmupSamplesPerGroup + SCALE.measuredSamplesPerGroup)

/** Warmup calls across both groups. */
const TOTAL_WARMUP_CALLS = SCALE.groups * SCALE.warmupSamplesPerGroup

/** Measured calls across both groups. */
const TOTAL_MEASURED_CALLS = SCALE.groups * SCALE.measuredSamplesPerGroup

/** Total measured samples across both groups (recorded in the scale map). */
const TOTAL_MEASURED_SAMPLES = SCALE.groups * SCALE.measuredSamplesPerGroup

// ---------------------------------------------------------------------------
// Fixed runtime-only targets (never printed, never in the artifact)
// ---------------------------------------------------------------------------

/**
 * Truly missing target: a fixed non-sensitive runtime sentinel that is never
 * ensured in SQLite, so every `topicExists` call against it returns
 * `{ok:true, value:false}`. It stays runtime-only — it appears only as an
 * explicit `page.evaluate` argument and never in artifact, console, or
 * attachments.
 */
const MISSING_TOPIC_ID = '__perf104_missing_topic_sentinel__'

// ---------------------------------------------------------------------------
// Metric/gate identity contract — static, in-spec enforced at artifact phase
// ---------------------------------------------------------------------------

/** Statistical suffixes for every duration grid (p99 supported by the shared nearest-rank helper). */
const STAT_SUFFIXES = ['p50', 'p95', 'p99', 'mean', 'min', 'max'] as const

/** The two measured groups: existing target and truly missing target. */
const GROUP_PREFIXES = ['rtt.existing', 'rtt.missing'] as const

/**
 * The exact 14-metric identity set: 2 groups x (6 stats + sample count),
 * ordered per group as stats-then-samples to match the emitted metrics order.
 * Every id must remain present unchanged in the artifact (deterministic
 * identity contract, enforced in-spec at the artifact phase).
 */
const METRIC_IDS: readonly string[] = [
  ...GROUP_PREFIXES.flatMap((prefix) => [...STAT_SUFFIXES.map((suffix) => `${prefix}.${suffix}`), `${prefix}.samples`])
]

/** The exact 7-gate identity set, all correctness (no threshold gate). */
const GATE_IDS: readonly string[] = [
  'rtt.okEnvelope',
  'rtt.valueCorrect',
  'rtt.finiteNonNegative',
  'rtt.serialInterleaved',
  'samples.completed',
  'environment.abi145',
  'privacy.schemaV1'
]

/** Stable artifact/baseline identity (schema v1 `benchmark.id`, artifact file name). */
const BENCHMARK_ID = 'perf104-topic-exists-rtt'

/** Deterministic benchmark display name. */
const BENCHMARK_NAME =
  'PERF-104 page-side aggregate topicExists round-trip measurement (production-build E2E, Electron lane)'

/** Canonical safe command recorded in the artifact (no path segments, audit F3). */
const CANONICAL_COMMAND = 'pnpm test:e2e'

/** Bounded-run budget for the whole measurement (5 minutes). */
const TEST_TIMEOUT_MS = 300000

// ---------------------------------------------------------------------------
// Phase 0 — runtime-only target retrieval + direct probe correctness
// ---------------------------------------------------------------------------

/**
 * Read the fixture default assistant's default topic id from the renderer
 * store (runtime-only; never logged). The default assistant `assistants[0]`
 * owns a default topic `topics[0]` that is already ensured in SQLite.
 */
async function retrieveDefaultTarget(page: Page): Promise<{ assistantId: string | null; topicId: string | null }> {
  return page.evaluate(() => {
    const s = (window as any).store.getState()
    const assistant = s?.assistants?.assistants?.[0]
    const topic = assistant?.topics?.[0]
    return { assistantId: assistant?.id ?? null, topicId: topic?.id ?? null }
  })
}

/**
 * One untimed direct `window.api.chatDb.topicExists` call returning only the
 * envelope/value booleans (never the id). Used by the Phase 0 probes.
 */
async function probeDirectTopicExists(page: Page, topicId: string): Promise<{ ok: boolean; value: boolean | null }> {
  return page.evaluate(async (topicId) => {
    const result = await (window as any).api.chatDb.topicExists({ topicId })
    return { ok: result?.ok === true, value: typeof result?.value === 'boolean' ? result.value : null }
  }, topicId)
}

// ---------------------------------------------------------------------------
// Phase 1 — one page.evaluate: warmup + measured, strict serial, alternating
// ---------------------------------------------------------------------------

/** Numeric-only series returned by the single measurement evaluate. */
interface RttSeries {
  /** Measured existing-target elapsed timings (ms); length = measuredSamplesPerGroup. */
  existingTimings: number[]
  /** Measured missing-target elapsed timings (ms); length = measuredSamplesPerGroup. */
  missingTimings: number[]
  /** Calls (warmup + measured) that returned the ok:true envelope. */
  okEnvelopeCalls: number
  /** Calls (warmup + measured) whose value matched the target expectation. */
  valueCorrectCalls: number
  /** Calls (warmup + measured) whose elapsed was finite and >= 0. */
  finiteNonNegativeCalls: number
  /** Warmup calls executed (both groups). */
  warmupCalls: number
  /** Measured calls executed (both groups). */
  measuredCalls: number
  /** Measured rounds that ran existing-first (even round index). */
  measuredExistingFirstRounds: number
  /** Measured rounds that ran missing-first (odd round index). */
  measuredMissingFirstRounds: number
}

/**
 * Run the whole warmup + measured series in ONE page-context evaluate with
 * strict serial awaits. For each round the two calls alternate order (even:
 * existing → missing; odd: missing → existing), for both the warmup series
 * and the measured series. Every call is timed with `performance.now()`
 * around the awaited direct bridge call; every call's envelope, value
 * correctness, and elapsed finiteness are counted. Returns ONLY timing
 * arrays and numeric counts — never ids.
 */
function measureTopicExistsRtt(
  page: Page,
  args: {
    existingTopicId: string
    missingTopicId: string
    warmupSamplesPerGroup: number
    measuredSamplesPerGroup: number
  }
): Promise<RttSeries> {
  return page.evaluate(async ({ existingTopicId, missingTopicId, warmupSamplesPerGroup, measuredSamplesPerGroup }) => {
    const api = (window as any).api.chatDb
    const existingTimings: number[] = []
    const missingTimings: number[] = []
    let okEnvelopeCalls = 0
    let valueCorrectCalls = 0
    let finiteNonNegativeCalls = 0
    let warmupCalls = 0
    let measuredCalls = 0
    let measuredExistingFirstRounds = 0
    let measuredMissingFirstRounds = 0

    // One round = exactly 2 strictly serial calls; even rounds run the
    // existing target first, odd rounds run the missing target first.
    const runRound = async (roundIndex: number, record: boolean): Promise<void> => {
      const existingFirst = roundIndex % 2 === 0
      const order = existingFirst ? [existingTopicId, missingTopicId] : [missingTopicId, existingTopicId]
      for (const topicId of order) {
        const expected = topicId === existingTopicId
        const t0 = performance.now()
        const result = await api.topicExists({ topicId })
        const elapsed = performance.now() - t0
        const okEnvelope = result?.ok === true && typeof result.value === 'boolean'
        const valueCorrect = okEnvelope && result.value === expected
        const finite = Number.isFinite(elapsed) && elapsed >= 0
        if (okEnvelope) okEnvelopeCalls += 1
        if (valueCorrect) valueCorrectCalls += 1
        if (finite) finiteNonNegativeCalls += 1
        if (record) {
          measuredCalls += 1
          if (expected) existingTimings.push(elapsed)
          else missingTimings.push(elapsed)
        } else {
          warmupCalls += 1
        }
      }
      if (record) {
        if (existingFirst) measuredExistingFirstRounds += 1
        else measuredMissingFirstRounds += 1
      }
    }

    // Warmup rounds: full correctness, excluded from the measured timings.
    for (let w = 0; w < warmupSamplesPerGroup; w++) {
      await runRound(w, false)
    }
    // Measured rounds: recorded series (only these enter the artifact metrics).
    for (let m = 0; m < measuredSamplesPerGroup; m++) {
      await runRound(m, true)
    }

    return {
      existingTimings,
      missingTimings,
      okEnvelopeCalls,
      valueCorrectCalls,
      finiteNonNegativeCalls,
      warmupCalls,
      measuredCalls,
      measuredExistingFirstRounds,
      measuredMissingFirstRounds
    }
  }, args)
}

// ---------------------------------------------------------------------------
// Statistics + artifact construction (reuses the v1 contract helpers)
// ---------------------------------------------------------------------------

function summarize(values: number[]): {
  p50: number
  p95: number
  p99: number
  mean: number
  min: number
  max: number
} {
  const finite = values.filter((v) => Number.isFinite(v))
  const sorted = sortTimings(finite)
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    mean: mean(sorted),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0
  }
}

function statsMetrics(prefix: string, label: string, values: number[]): BenchmarkMetric[] {
  const s = summarize(values)
  return [
    { id: `${prefix}.p50`, name: `${label} p50`, value: s.p50, unit: 'ms' },
    { id: `${prefix}.p95`, name: `${label} p95`, value: s.p95, unit: 'ms' },
    { id: `${prefix}.p99`, name: `${label} p99`, value: s.p99, unit: 'ms' },
    { id: `${prefix}.mean`, name: `${label} mean`, value: s.mean, unit: 'ms' },
    { id: `${prefix}.min`, name: `${label} min`, value: s.min, unit: 'ms' },
    { id: `${prefix}.max`, name: `${label} max`, value: s.max, unit: 'ms' }
  ]
}

/** Build the schema v1 artifact (only ever called after the full pass). */
function buildBenchmarkResult(series: RttSeries, environment: BenchmarkResult['environment']): BenchmarkResult {
  const correctness: BenchmarkGate[] = [
    {
      id: 'rtt.okEnvelope',
      name: 'every direct window.api.chatDb.topicExists call returned the ok:true envelope',
      kind: 'correctness',
      passed: true,
      detail: `${series.okEnvelopeCalls}/${TOTAL_CALLS} direct calls (${TOTAL_WARMUP_CALLS} warmup + ${TOTAL_MEASURED_CALLS} measured) returned the {ok:true, value:boolean} ChatDbResult envelope`
    },
    {
      id: 'rtt.valueCorrect',
      name: 'every call returned the correct boolean: existing target true, truly missing target false',
      kind: 'correctness',
      passed: true,
      detail: `${series.valueCorrectCalls}/${TOTAL_CALLS} calls matched the target expectation (existing target value=true, truly-missing sentinel value=false)`
    },
    {
      id: 'rtt.finiteNonNegative',
      name: 'every recorded round-trip elapsed is finite and >= 0',
      kind: 'correctness',
      passed: true,
      detail: `${series.finiteNonNegativeCalls}/${TOTAL_CALLS} calls recorded a finite non-negative elapsed (performance.now() delta on the page clock)`
    },
    {
      id: 'rtt.serialInterleaved',
      name: 'strict serial awaits with alternating round order',
      kind: 'correctness',
      passed: true,
      detail: `strictly serial (single page.evaluate loop, one awaited call at a time, no concurrency); ${SCALE.measuredSamplesPerGroup} measured rounds alternate order — even existing-first, odd missing-first — with measured first-call split ${series.measuredExistingFirstRounds}/${series.measuredMissingFirstRounds} (existing-first/missing-first); the same alternation applied to the ${SCALE.warmupSamplesPerGroup} warmup rounds`
    },
    {
      id: 'samples.completed',
      name: 'all samples completed; measured series finite with exact counts',
      kind: 'correctness',
      passed: true,
      detail: `${SCALE.warmupSamplesPerGroup} warmup + ${SCALE.measuredSamplesPerGroup} measured rounds per group completed (${series.warmupCalls} warmup calls + ${series.measuredCalls} measured calls); measured series hold exactly ${series.existingTimings.length} existing + ${series.missingTimings.length} missing timings (= ${TOTAL_MEASURED_SAMPLES} total measured)`
    },
    {
      id: 'environment.abi145',
      name: 'measured runtime is the Electron ABI 145 lane with the safe canonical command',
      kind: 'correctness',
      passed: true,
      detail: `abiLane=electron, abi=${environment.abi}, command=${environment.command} (no path segments)`
    },
    {
      id: 'privacy.schemaV1',
      name: 'artifact complies with the PERF-001 schema v1 closed set',
      kind: 'correctness',
      passed: true,
      detail:
        'metrics/gates/scale carry only numbers and fixed strings; no topic IDs, message content, paths, credentials, or raw DB sizes (enforced at write time by the shared validator and re-asserted on the serialized artifact)'
    }
  ]

  return {
    schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
    benchmark: {
      id: BENCHMARK_ID,
      name: BENCHMARK_NAME,
      scale: {
        profileCode: PROFILE_CODE,
        groups: SCALE.groups,
        warmupSamplesPerGroup: SCALE.warmupSamplesPerGroup,
        measuredSamplesPerGroup: SCALE.measuredSamplesPerGroup,
        totalMeasuredSamples: TOTAL_MEASURED_SAMPLES,
        rttDefinitionCode: SCALE.rttDefinitionCode,
        serialAwaitCode: SCALE.serialAwaitCode,
        interleavedOrderCode: SCALE.interleavedOrderCode
      }
    },
    environment,
    metrics: [
      ...statsMetrics(
        'rtt.existing',
        'Renderer page-side aggregate window.api.chatDb.topicExists round trip (existing target) — direct bridge: page await + preload structured clone + main validation/service/repository/Drizzle prepare + SQLite EXISTS + result validation + reply',
        series.existingTimings
      ),
      {
        id: 'rtt.existing.samples',
        name: 'Renderer page-side aggregate topicExists round trip (existing target) — measured sample count',
        value: series.existingTimings.length,
        unit: 'count'
      },
      ...statsMetrics(
        'rtt.missing',
        'Renderer page-side aggregate window.api.chatDb.topicExists round trip (truly missing target) — direct bridge: page await + preload structured clone + main validation/service/repository/Drizzle prepare + SQLite EXISTS + result validation + reply',
        series.missingTimings
      ),
      {
        id: 'rtt.missing.samples',
        name: 'Renderer page-side aggregate topicExists round trip (truly missing target) — measured sample count',
        value: series.missingTimings.length,
        unit: 'count'
      }
    ],
    gates: correctness
  }
}

// ---------------------------------------------------------------------------
// The measurement test — one focused run, one artifact
// ---------------------------------------------------------------------------

test.describe('PERF-104 topicExists round-trip measurement', () => {
  test('measures page-side aggregate window.api.chatDb.topicExists round trips', async ({
    electronApp,
    mainWindow
  }) => {
    // Bounded-run budget (5 minutes) aligned with the tiny per-call cost:
    // ~240 direct calls at a few ms each — a hang fails fail-closed with no
    // artifact (the artifact is written only after every assertion passes).
    test.setTimeout(TEST_TIMEOUT_MS)
    const page = mainWindow

    // ---- Phase 0: runtime-only target retrieval + full direct probes -------
    // Retrieve the default assistant's default topic id from the store
    // (runtime-only; never logged) and prove full correctness of the direct
    // bridge BEFORE any measurement: one existing call ok:true/value:true and
    // one missing call ok:true/value:false.
    const target = await retrieveDefaultTarget(page)
    expect(target.assistantId, 'the fixture must provide a default assistant').toBeTruthy()
    expect(target.topicId, 'the default assistant must own a default topic (already ensured in SQLite)').toBeTruthy()

    const existingProbe = await probeDirectTopicExists(page, target.topicId!)
    expect(existingProbe.ok, 'Phase 0 existing direct call must return the ok:true envelope').toBe(true)
    expect(existingProbe.value, 'Phase 0 existing direct call must return value:true').toBe(true)

    const missingProbe = await probeDirectTopicExists(page, MISSING_TOPIC_ID)
    expect(missingProbe.ok, 'Phase 0 missing direct call must return the ok:true envelope').toBe(true)
    expect(missingProbe.value, 'Phase 0 missing direct call must return value:false').toBe(false)
    console.log(
      `[E2E][PERF-104] phase 0: existing direct probe ok:true/value:true; missing direct probe ok:true/value:false`
    )

    // ---- Phase 1: ONE page.evaluate runs warmup + measured series ----------
    const series = await measureTopicExistsRtt(page, {
      existingTopicId: target.topicId!,
      missingTopicId: MISSING_TOPIC_ID,
      warmupSamplesPerGroup: SCALE.warmupSamplesPerGroup,
      measuredSamplesPerGroup: SCALE.measuredSamplesPerGroup
    })

    // ---- Full correctness gates (fail-fast; any violation aborts, no artifact)
    expect(series.okEnvelopeCalls, 'every direct call must return the ok:true envelope').toBe(TOTAL_CALLS)
    expect(series.valueCorrectCalls, 'every direct call must return the expected boolean value').toBe(TOTAL_CALLS)
    expect(series.finiteNonNegativeCalls, 'every direct call must record a finite non-negative elapsed').toBe(
      TOTAL_CALLS
    )
    expect(series.warmupCalls, 'warmup call count must be exact').toBe(TOTAL_WARMUP_CALLS)
    expect(series.measuredCalls, 'measured call count must be exact').toBe(TOTAL_MEASURED_CALLS)
    expect(series.existingTimings, 'measured existing timings must be exactly one per measured round').toHaveLength(
      SCALE.measuredSamplesPerGroup
    )
    expect(series.missingTimings, 'measured missing timings must be exactly one per measured round').toHaveLength(
      SCALE.measuredSamplesPerGroup
    )
    expect(
      series.measuredExistingFirstRounds,
      'measured rounds must split evenly by first-call group (existing-first on even rounds)'
    ).toBe(SCALE.measuredSamplesPerGroup / 2)
    expect(
      series.measuredMissingFirstRounds,
      'measured rounds must split evenly by first-call group (missing-first on odd rounds)'
    ).toBe(SCALE.measuredSamplesPerGroup / 2)
    console.log(
      `[E2E][PERF-104] warmup: ${series.warmupCalls} calls (${SCALE.warmupSamplesPerGroup} rounds/group, excluded from metrics); ` +
        `measured: ${series.measuredCalls} calls (${SCALE.measuredSamplesPerGroup} rounds/group, existing-first ${series.measuredExistingFirstRounds} / missing-first ${series.measuredMissingFirstRounds})`
    )

    // ---- Phase 2: emit the schema v1 artifact ONLY after the full pass -----
    // The measured runtime is the Electron app (ABI 145), while the Playwright
    // runner process is Node. The artifact records the MEASURED runtime's Node
    // version and ABI from the running app (`electronApp.evaluate`), with the
    // runner's pnpm metadata retained from collectEnvironmentMetadata.
    const appRuntime = await electronApp.evaluate(() => ({
      node: process.version,
      abiModules: String(process.versions.modules)
    }))
    expect(appRuntime.abiModules, 'the measured runtime must be the Electron ABI 145 binding').toBe('145')
    const environment: BenchmarkResult['environment'] = {
      ...collectEnvironmentMetadata({ command: CANONICAL_COMMAND }),
      node: appRuntime.node,
      abiLane: 'electron',
      abi: appRuntime.abiModules
    }
    const result = buildBenchmarkResult(series, environment)

    // In-spec validation before the writer: exact 14-metric / 7-gate identity,
    // uniqueness, finiteness, all-correctness gates, and exact scale values
    // (the writer enforces the closed schema + finiteness; the exact identity
    // and the no-threshold property are spec-side).
    const metricIds = result.metrics.map((m) => m.id)
    expect(metricIds, 'all metric ids must be unique').toHaveLength(new Set(metricIds).size)
    expect(metricIds, `metric id set must be exactly the ${METRIC_IDS.length}-id contract`).toEqual([...METRIC_IDS])
    expect(
      result.metrics.every((m) => Number.isFinite(m.value)),
      'every metric value must be finite'
    ).toBe(true)

    const gateIds = result.gates.map((g) => g.id)
    expect(gateIds, 'all gate ids must be unique').toHaveLength(new Set(gateIds).size)
    expect(gateIds, `gate id set must be exactly the ${GATE_IDS.length}-gate contract`).toEqual([...GATE_IDS])
    expect(
      result.gates.every((g) => g.kind === 'correctness'),
      'every gate must be a correctness gate (no threshold gate exists anywhere)'
    ).toBe(true)

    const scale = result.benchmark.scale
    expect(scale.profileCode, 'scale.profileCode must be the locked value').toBe(PROFILE_CODE)
    expect(scale.groups, 'scale.groups must be the locked value').toBe(SCALE.groups)
    expect(scale.warmupSamplesPerGroup, 'scale.warmupSamplesPerGroup must be the locked value').toBe(
      SCALE.warmupSamplesPerGroup
    )
    expect(scale.measuredSamplesPerGroup, 'scale.measuredSamplesPerGroup must be the locked value').toBe(
      SCALE.measuredSamplesPerGroup
    )
    expect(scale.totalMeasuredSamples, 'scale.totalMeasuredSamples must be the locked value').toBe(
      TOTAL_MEASURED_SAMPLES
    )
    expect(scale.rttDefinitionCode, 'scale.rttDefinitionCode must be the locked value').toBe(SCALE.rttDefinitionCode)
    expect(scale.serialAwaitCode, 'scale.serialAwaitCode must be the locked value').toBe(SCALE.serialAwaitCode)
    expect(scale.interleavedOrderCode, 'scale.interleavedOrderCode must be the locked value').toBe(
      SCALE.interleavedOrderCode
    )

    // Privacy re-assertion on the serialized artifact: no topic id, no missing
    // sentinel, no path segment may appear in the artifact payload.
    const serialized = JSON.stringify(result)
    expect(serialized.includes(target.topicId!), 'the artifact must never contain the existing topic id').toBe(false)
    expect(serialized.includes(MISSING_TOPIC_ID), 'the artifact must never contain the missing sentinel').toBe(false)
    expect(serialized.includes('test-results'), 'the artifact must never contain an output path').toBe(false)

    const artifactPath = writeBenchmarkResult(result)
    expect(fs.existsSync(artifactPath), 'artifact must exist after a passing run').toBe(true)
    // Only a safe basename is printed — absolute machine-local artifact paths
    // and topic ids never enter logs (privacy/redaction).
    console.log(
      `[E2E][PERF-104] schema v1 artifact: ${path.basename(artifactPath)} ` +
        `(existing ${series.existingTimings.length} + missing ${series.missingTimings.length} measured samples)`
    )
  })
})
