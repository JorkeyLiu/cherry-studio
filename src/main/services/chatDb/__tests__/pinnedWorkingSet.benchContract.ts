/**
 * Phase 4 — Pinned working-set full-matrix benchmark contract (pure, shared)
 *
 * Pure deterministic metric/gate contract builder consumed by both the
 * benchmark emitter (`pinnedWorkingSet.bench.ts`) and its regression tests
 * (`pinnedWorkingSet.test.ts`). The emitter emits the exact arrays returned by
 * this builder; tests assert the actual builder output. No runtime cache,
 * threshold, or persistence behavior. Synthetic calibration inputs are
 * directional, non-adopting per program governance.
 *
 * This expands the prior single-matrix emission to the existing deterministic
 * full three-matrix set (matrix-standard-v1 / matrix-small-v1 / matrix-large-v1)
 * sharing pure construction so contracts cannot drift. Benchmark identity,
 * schema v1, canonical phase4-logical-payload-v1 accounting, numeric-only
 * artifact rules, and directional/non-adoption semantics are preserved.
 */

import {
  BENCH_RESULT_SCHEMA_VERSION,
  type BenchmarkEnvironment,
  type BenchmarkGate,
  type BenchmarkMetric,
  type BenchmarkResult
} from './benchResult'
import {
  type HeapCoverageLimit,
  PINNED_WORKING_SET_MATRICES,
  type PinnedWorkingSetAccounting
} from './pinnedWorkingSet'

export const PINNED_WORKING_SET_BENCHMARK_ID = 'pinned-working-set-calibration' as const
export const PINNED_WORKING_SET_BENCHMARK_NAME =
  'Pinned working-set / evictable-set / unlimited-context enlargement calibration — phase4-logical-payload-v1 synthetic matrix (Node lane, directional)' as const

export const MATRIX_METRIC_PREFIX_BY_ID: Record<string, string> = {
  'matrix-standard-v1': 'standard',
  'matrix-small-v1': 'small',
  'matrix-large-v1': 'large'
}

export const MATRIX_DISPLAY_PREFIX_BY_ID: Record<string, string> = {
  'matrix-standard-v1': 'Standard',
  'matrix-small-v1': 'Small',
  'matrix-large-v1': 'Large'
}

function prefixForMatrix(matrixId: string): string {
  return MATRIX_METRIC_PREFIX_BY_ID[matrixId] ?? matrixId.replace(/[^a-zA-Z0-9]/g, '_')
}

function displayForMatrix(matrixId: string): string {
  return MATRIX_DISPLAY_PREFIX_BY_ID[matrixId] ?? matrixId
}

export interface BuildMetricsParams {
  matrixAccountings: Array<{ matrixId: string; accounting: PinnedWorkingSetAccounting }>
  heapCoverage: HeapCoverageLimit
}

export function buildPinnedWorkingSetMetrics(params: BuildMetricsParams): BenchmarkMetric[] {
  const { matrixAccountings, heapCoverage } = params

  const metrics: BenchmarkMetric[] = []

  for (const { matrixId, accounting } of matrixAccountings) {
    const prefix = prefixForMatrix(matrixId)
    const display = displayForMatrix(matrixId)

    // Per-topic bytes — pinned
    accounting.pinned.perTopic.forEach((p, idx) => {
      metrics.push({
        id: `${prefix}.pinned.topic.${idx}.bytes`,
        name: `${display} matrix pinned partition topic ${idx} bytes (${p.topicId})`,
        value: p.byteLength,
        unit: 'bytes'
      })
    })

    // Per-topic bytes — evictable
    accounting.evictable.perTopic.forEach((p, idx) => {
      metrics.push({
        id: `${prefix}.evictable.topic.${idx}.bytes`,
        name: `${display} matrix evictable partition topic ${idx} bytes (${p.topicId})`,
        value: p.byteLength,
        unit: 'bytes'
      })
    })

    // Per-topic bytes — unlimited variant
    accounting.unlimited.perTopic.forEach((p, idx) => {
      metrics.push({
        id: `${prefix}.unlimited.topic.${idx}.bytes`,
        name: `${display} matrix unlimited-context variant topic ${idx} bytes (${p.topicId})`,
        value: p.byteLength,
        unit: 'bytes'
      })
    })

    // Aggregate + partition metrics (numeric-only, directional synthetic)
    metrics.push(
      {
        id: `${prefix}.pinned.aggregate.bytes`,
        name: `${display} matrix pinned partition aggregate bytes (directional synthetic)`,
        value: accounting.pinned.aggregateBytes,
        unit: 'bytes'
      },
      {
        id: `${prefix}.pinned.topicCount`,
        name: `${display} matrix pinned partition topic count (directional synthetic)`,
        value: accounting.pinned.topicCount,
        unit: 'count'
      },
      {
        id: `${prefix}.evictable.aggregate.bytes`,
        name: `${display} matrix evictable partition aggregate bytes (directional synthetic)`,
        value: accounting.evictable.aggregateBytes,
        unit: 'bytes'
      },
      {
        id: `${prefix}.evictable.topicCount`,
        name: `${display} matrix evictable partition topic count (directional synthetic)`,
        value: accounting.evictable.topicCount,
        unit: 'count'
      },
      {
        id: `${prefix}.combined.aggregate.bytes`,
        name: `${display} matrix combined working-set aggregate bytes (pinned+evictable, directional synthetic)`,
        value: accounting.combined.aggregateBytes,
        unit: 'bytes'
      },
      {
        id: `${prefix}.combined.topicCount`,
        name: `${display} matrix combined working-set topic count (directional synthetic)`,
        value: accounting.combined.topicCount,
        unit: 'count'
      },
      {
        id: `${prefix}.unlimited.aggregate.bytes`,
        name: `${display} matrix unlimited-context enlargement aggregate bytes (directional synthetic)`,
        value: accounting.unlimited.aggregateBytes,
        unit: 'bytes'
      },
      {
        id: `${prefix}.unlimited.topicCount`,
        name: `${display} matrix unlimited-context enlargement topic count (directional synthetic)`,
        value: accounting.unlimited.topicCount,
        unit: 'count'
      },
      {
        id: `${prefix}.enlargement.ratio.unlimitedOverPinned`,
        name: `${display} matrix unlimited-context enlargement ratio = unlimited / pinned (directional synthetic)`,
        value: accounting.enlargementRatio,
        unit: 'ratio'
      }
    )
  }

  metrics.push({
    id: 'heap.measurable',
    name: 'Heap/amplification measurable in this lane (1=measurable, 0=not measurable — Node lane reports logical bytes only)',
    value: heapCoverage.measurable ? 1 : 0,
    unit: 'count'
  })

  return metrics
}

export interface BuildGatesParams {
  matrixAccountings: Array<{ matrixId: string; accounting: PinnedWorkingSetAccounting }>
  heapCoverage: HeapCoverageLimit
  correctnessErrors: string[]
  orphanRejectionPassed: boolean
  nonFiniteRejectionPassed: boolean
}

export function buildPinnedWorkingSetGates(params: BuildGatesParams): BenchmarkGate[] {
  const { matrixAccountings, heapCoverage, correctnessErrors, orphanRejectionPassed, nonFiniteRejectionPassed } = params

  const matrixIds = matrixAccountings.map((m) => m.matrixId)
  const expectedIds = PINNED_WORKING_SET_MATRICES.map((m) => m.id)

  const matrixCompletePassed =
    matrixAccountings.length === PINNED_WORKING_SET_MATRICES.length &&
    matrixAccountings.every((m) => PINNED_WORKING_SET_MATRICES.some((def) => def.id === m.matrixId)) &&
    new Set(matrixIds).size === PINNED_WORKING_SET_MATRICES.length

  const partitionSumPassed = matrixAccountings.every(
    (m) =>
      m.accounting.combinedCheck &&
      m.accounting.combined.aggregateBytes ===
        m.accounting.pinned.aggregateBytes + m.accounting.evictable.aggregateBytes
  )

  const pinnedEvictableExplicitPassed = matrixAccountings.every((m) => {
    const def = PINNED_WORKING_SET_MATRICES.find((d) => d.id === m.matrixId)
    if (!def) return false
    return (
      m.accounting.pinned.topicCount === def.pinned.topics &&
      m.accounting.evictable.topicCount === def.evictable.topics &&
      m.accounting.pinned.topicCount > 0 &&
      m.accounting.evictable.topicCount > 0 &&
      def.pinned.topicPrefix !== def.evictable.topicPrefix
    )
  })

  const unlimitedEnlargementPassed = matrixAccountings.every(
    (m) =>
      Number.isFinite(m.accounting.enlargementRatio) &&
      m.accounting.enlargementRatio > 1 &&
      m.accounting.unlimited.aggregateBytes > m.accounting.pinned.aggregateBytes
  )

  const logicalBytesFinitePassed = matrixAccountings.every((m) =>
    [
      m.accounting.pinned.aggregateBytes,
      m.accounting.evictable.aggregateBytes,
      m.accounting.combined.aggregateBytes,
      m.accounting.unlimited.aggregateBytes,
      m.accounting.enlargementRatio
    ].every((v) => Number.isFinite(v) && v > 0)
  )

  return [
    {
      id: 'correctness.canonical',
      name: 'Canonical encoding invariants (lexicographic keys, compact JSON, byteLength, determinism)',
      kind: 'correctness',
      passed: correctnessErrors.length === 0,
      detail:
        correctnessErrors.length === 0
          ? 'canonical probe passed (pinned working-set harness)'
          : correctnessErrors.join('; ')
    },
    {
      id: 'correctness.orphan-rejection',
      name: 'Orphan block rejection (phase4-logical-payload-v1)',
      kind: 'correctness',
      passed: orphanRejectionPassed,
      detail: orphanRejectionPassed ? 'orphan block correctly rejected' : 'orphan block rejection FAILED'
    },
    {
      id: 'correctness.nonfinite-rejection',
      name: 'Non-finite and unsupported value rejection (fail-closed)',
      kind: 'correctness',
      passed: nonFiniteRejectionPassed,
      detail: nonFiniteRejectionPassed ? 'non-finite rejected (fail-closed)' : 'non-finite rejection FAILED'
    },
    {
      id: 'matrix.complete',
      name: 'Full 3-matrix deterministic set enumerated (pinnedWorkingSet.MATRICES)',
      kind: 'correctness',
      passed: matrixCompletePassed,
      detail: `matrix ids=${matrixIds.join(',')} expected=${expectedIds.join(',')} count=${matrixIds.length}`
    },
    {
      id: 'correctness.partition-sum',
      name: 'Pinned + evictable aggregate equals combined working-set aggregate for all matrices (deterministic sum check, shared entities duplicated per topic)',
      kind: 'correctness',
      passed: partitionSumPassed,
      detail: matrixAccountings
        .map(
          (m) =>
            `${m.matrixId}: pinned ${m.accounting.pinned.aggregateBytes} + evictable ${m.accounting.evictable.aggregateBytes} = ${m.accounting.pinned.aggregateBytes + m.accounting.evictable.aggregateBytes}; combined ${m.accounting.combined.aggregateBytes} — ${m.accounting.combinedCheck ? 'exact match' : 'MISMATCH'}`
        )
        .join(' | ')
    },
    {
      id: 'correctness.pinned-evictable-explicit',
      name: 'Synthetic matrices explicitly partition pinned vs evictable sets for all matrices (both non-empty, distinct prefixes, directional synthetic)',
      kind: 'correctness',
      passed: pinnedEvictableExplicitPassed,
      detail:
        matrixAccountings
          .map((m) => {
            const def = PINNED_WORKING_SET_MATRICES.find((d) => d.id === m.matrixId)
            return `${m.matrixId}: pinned ${m.accounting.pinned.topicCount} (${def?.pinned.topicPrefix}), evictable ${m.accounting.evictable.topicCount} (${def?.evictable.topicPrefix})`
          })
          .join(' | ') + ' — all synthetic, directional, non-adopting'
    },
    {
      id: 'correctness.unlimited-enlargement',
      name: 'Unlimited-context enlargement variant explicit and distinct from pinned working set for all matrices (enlargement ratio finite >0, demonstrates anchor-to-end growth without truncation)',
      kind: 'correctness',
      passed: unlimitedEnlargementPassed,
      detail:
        matrixAccountings
          .map((m) => {
            const def = PINNED_WORKING_SET_MATRICES.find((d) => d.id === m.matrixId)
            return `${m.matrixId}: unlimited ${m.accounting.unlimited.aggregateBytes} bytes (${def?.unlimited.topics} topics × ${def?.unlimited.messagesPerTopic} msgs × ${def?.unlimited.blockContentSize} B) vs pinned ${m.accounting.pinned.aggregateBytes} bytes — ratio ${m.accounting.enlargementRatio.toFixed(3)}x`
          })
          .join(' | ') + ' (directional synthetic, not adopted window/closure bound; unlimited measured not truncated)'
    },
    {
      id: 'correctness.logical-bytes-finite',
      name: 'All logical-byte metrics finite and positive for all matrices (fail-closed on invalid/non-finite)',
      kind: 'correctness',
      passed: logicalBytesFinitePassed,
      detail:
        matrixAccountings
          .map(
            (m) =>
              `${m.matrixId}: pinned ${m.accounting.pinned.aggregateBytes}, evictable ${m.accounting.evictable.aggregateBytes}, combined ${m.accounting.combined.aggregateBytes}, unlimited ${m.accounting.unlimited.aggregateBytes}, ratio ${m.accounting.enlargementRatio.toFixed(3)}`
          )
          .join(' | ') + ' — all finite positive; invalid hedged by fail-closed validation'
    },
    {
      id: 'coverage.heap-amplification',
      name: 'Heap/amplification coverage limit stated (Node lane cannot safely measure renderer heap without production/E2E coupling; logical bytes and enlargement ratio reported; heap omitted rather than substituting Node heap proxy)',
      kind: 'correctness',
      passed: !heapCoverage.measurable,
      detail: heapCoverage.reason + ' — C-02 one-profile/GC-sensitive remains separate; no production claim substituted'
    }
  ]
}

export interface BuildContractParams extends BuildMetricsParams, BuildGatesParams {}

export function buildPinnedWorkingSetBenchmarkContract(params: BuildContractParams): {
  metrics: BenchmarkMetric[]
  gates: BenchmarkGate[]
} {
  return {
    metrics: buildPinnedWorkingSetMetrics(params),
    gates: buildPinnedWorkingSetGates(params)
  }
}

export interface AssembleBenchmarkResultParams extends BuildContractParams {
  scale: Record<string, number>
  environment: BenchmarkEnvironment
}

/**
 * Pure shared assembly that produces the exact schema-v1 BenchmarkResult the
 * emitter writes. Both the emitter and tests consume this so the full-matrix
 * accounting, scale, stable id, metrics and gates cannot drift.
 */
export function assemblePinnedWorkingSetBenchmarkResult(params: AssembleBenchmarkResultParams): BenchmarkResult {
  const { metrics, gates } = buildPinnedWorkingSetBenchmarkContract(params)
  return {
    schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
    benchmark: {
      id: PINNED_WORKING_SET_BENCHMARK_ID,
      name: PINNED_WORKING_SET_BENCHMARK_NAME,
      scale: params.scale
    },
    environment: params.environment,
    metrics,
    gates
  }
}
