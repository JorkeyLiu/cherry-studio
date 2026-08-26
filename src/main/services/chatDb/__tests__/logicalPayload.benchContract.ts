/**
 * Phase 4 C-01 — Logical Retained Payload Benchmark Contract (pure, shared)
 *
 * Pure deterministic metric/gate contract builder consumed by both the
 * benchmark emitter (`logicalPayload.bench.ts`) and its regression tests
 * (`logicalPayload.test.ts`). The emitter emits the exact arrays returned by
 * this builder; tests assert the actual builder output. No runtime cache,
 * threshold, or persistence behavior.
 */

import type { aggregateLogicalPayload } from '@shared/chatDb/logicalPayload'
import { B01_MAX_TOPICS, B02_MAX_BYTES, B05_CALIBRATION_CANDIDATE_BYTES } from '@shared/chatDb/logicalPayload'

import type { BenchmarkGate, BenchmarkMetric } from './benchResult'
import { type getLogicalPayloadProfileMatrix, SYNTHETIC_PROFILE_IDS } from './logicalPayload'

export const PROFILE_PREFIX_BY_ID: Record<string, string> = {
  [SYNTHETIC_PROFILE_IDS.countFirst]: 'countFirst',
  [SYNTHETIC_PROFILE_IDS.byteFirst]: 'byteFirst',
  [SYNTHETIC_PROFILE_IDS.oversizedSingle]: 'oversizedSingle',
  [SYNTHETIC_PROFILE_IDS.boundaryExact]: 'boundaryExact',
  [SYNTHETIC_PROFILE_IDS.bothBound]: 'bothBound',
  [SYNTHETIC_PROFILE_IDS.variedShape]: 'variedShape',
  [SYNTHETIC_PROFILE_IDS.byteBoundary]: 'byteBoundary',
  [SYNTHETIC_PROFILE_IDS.b02ExactEquality]: 'b02ExactEquality'
}

export function bindingToNumeric(binding: string): number {
  switch (binding) {
    case 'none':
      return 0
    case 'count-first':
      return 1
    case 'byte-first':
      return 2
    case 'both':
      return 3
    default:
      return -1
  }
}

export interface BuildMetricsParams {
  profileMatrix: ReturnType<typeof getLogicalPayloadProfileMatrix>
  aggregatesById: Map<string, ReturnType<typeof aggregateLogicalPayload>>
  combinedAgg: ReturnType<typeof aggregateLogicalPayload>
}

export function buildLogicalPayloadMetrics(params: BuildMetricsParams): BenchmarkMetric[] {
  const { profileMatrix, aggregatesById, combinedAgg } = params

  function requireAgg(id: string): ReturnType<typeof aggregateLogicalPayload> {
    const agg = aggregatesById.get(id)
    if (!agg) throw new Error(`missing aggregate for profile ${id}`)
    return agg
  }

  const metrics: BenchmarkMetric[] = []

  // Per-topic bytes — for every matrix profile (preserves existing ids)
  for (const { id } of profileMatrix) {
    const prefix = PROFILE_PREFIX_BY_ID[id] ?? id.replace(/[^a-zA-Z0-9]/g, '_')
    const agg = requireAgg(id)
    agg.perTopic.forEach((p, idx) => {
      metrics.push({
        id: `${prefix}.topic.${idx}.bytes`,
        name: `${prefix} topic ${idx} bytes (${p.topicId})`,
        value: p.byteLength,
        unit: 'bytes'
      })
    })
  }

  // Aggregate + binding metrics per profile (numeric-only)
  for (const { id } of profileMatrix) {
    const prefix = PROFILE_PREFIX_BY_ID[id] ?? id.replace(/[^a-zA-Z0-9]/g, '_')
    const agg = requireAgg(id)
    const displayPrefix =
      prefix === 'countFirst'
        ? 'Count-first'
        : prefix === 'byteFirst'
          ? 'Byte-first'
          : prefix === 'oversizedSingle'
            ? 'Oversized single'
            : prefix === 'boundaryExact'
              ? 'Boundary-exact'
              : prefix === 'bothBound'
                ? 'Both-bound'
                : prefix === 'variedShape'
                  ? 'Varied-shape'
                  : prefix === 'byteBoundary'
                    ? 'Byte-boundary'
                    : prefix === 'b02ExactEquality'
                      ? 'B02-exact-equality'
                      : prefix
    metrics.push(
      {
        id: `${prefix}.aggregate.bytes`,
        name: `${displayPrefix} aggregate bytes`,
        value: agg.aggregateBytes,
        unit: 'bytes'
      },
      { id: `${prefix}.topicCount`, name: `${displayPrefix} topic count`, value: agg.topicCount },
      {
        id: `${prefix}.isCountBound`,
        name: `${displayPrefix} is count-bound (1=true)`,
        value: agg.isCountBound ? 1 : 0
      },
      {
        id: `${prefix}.isByteBound`,
        name: `${displayPrefix} is byte-bound (1=true)`,
        value: agg.isByteBound ? 1 : 0
      },
      {
        id: `${prefix}.binding`,
        name: `${displayPrefix} binding enum (0=none,1=count,2=byte,3=both)`,
        value: bindingToNumeric(agg.binding)
      },
      {
        id: `${prefix}.oversizedCount`,
        name: `${displayPrefix} oversized topic count`,
        value: agg.oversizedTopicIds.length
      }
    )
    // Extra per-topic oversized flag for single-topic profiles
    if (agg.perTopic.length === 1) {
      metrics.push({
        id: `${prefix}.topic.0.isOversized`,
        name: `${displayPrefix} topic 0 is oversized (1=true)`,
        value: agg.oversizedTopicIds.length > 0 ? 1 : 0
      })
    }
  }

  metrics.push(
    {
      id: 'combined.aggregate.bytes',
      name: 'Combined aggregate bytes',
      value: combinedAgg.aggregateBytes,
      unit: 'bytes'
    },
    { id: 'combined.topicCount', name: 'Combined topic count', value: combinedAgg.topicCount }
  )

  metrics.push(
    { id: 'calibrationCandidate.B01_maxTopics', name: 'B-01 calibration candidate max topics', value: B01_MAX_TOPICS },
    {
      id: 'calibrationCandidate.B02_maxBytes',
      name: 'B-02 calibration candidate max bytes',
      value: B02_MAX_BYTES,
      unit: 'bytes'
    },
    {
      id: 'calibrationCandidate.B05_maxBytes',
      name: 'B-05 calibration candidate max bytes',
      value: B05_CALIBRATION_CANDIDATE_BYTES,
      unit: 'bytes'
    }
  )

  return metrics
}

export interface BuildGatesParams {
  profileMatrix: ReturnType<typeof getLogicalPayloadProfileMatrix>
  aggregatesById: Map<string, ReturnType<typeof aggregateLogicalPayload>>
  correctnessErrors: string[]
  orphanRejectionPassed: boolean
  nonFiniteRejectionPassed: boolean
}

export function buildLogicalPayloadGates(params: BuildGatesParams): BenchmarkGate[] {
  const { profileMatrix, aggregatesById, correctnessErrors, orphanRejectionPassed, nonFiniteRejectionPassed } = params

  function requireAgg(id: string): ReturnType<typeof aggregateLogicalPayload> {
    const agg = aggregatesById.get(id)
    if (!agg) throw new Error(`missing aggregate for profile ${id}`)
    return agg
  }

  const countFirstAgg = requireAgg(SYNTHETIC_PROFILE_IDS.countFirst)
  const byteFirstAgg = requireAgg(SYNTHETIC_PROFILE_IDS.byteFirst)
  const oversizedAgg = requireAgg(SYNTHETIC_PROFILE_IDS.oversizedSingle)
  const boundaryExactAgg = requireAgg(SYNTHETIC_PROFILE_IDS.boundaryExact)
  const bothBoundAgg = requireAgg(SYNTHETIC_PROFILE_IDS.bothBound)
  const variedShapeAgg = requireAgg(SYNTHETIC_PROFILE_IDS.variedShape)
  const byteBoundaryAgg = requireAgg(SYNTHETIC_PROFILE_IDS.byteBoundary)
  const b02ExactEqualityAgg = requireAgg(SYNTHETIC_PROFILE_IDS.b02ExactEquality)

  return [
    {
      id: 'correctness.canonical',
      name: 'Canonical encoding invariants (lexicographic keys, compact JSON, byteLength, determinism)',
      kind: 'correctness',
      passed: correctnessErrors.length === 0,
      detail: correctnessErrors.length === 0 ? 'canonical probe passed' : correctnessErrors.join('; ')
    },
    {
      id: 'correctness.orphan-rejection',
      name: 'Orphan block rejection (LOCK-C01-006)',
      kind: 'correctness',
      passed: orphanRejectionPassed,
      detail: orphanRejectionPassed ? 'orphan block correctly rejected' : 'orphan block rejection FAILED'
    },
    {
      id: 'correctness.nonfinite-rejection',
      name: 'Non-finite and unsupported value rejection',
      kind: 'correctness',
      passed: nonFiniteRejectionPassed,
      detail: nonFiniteRejectionPassed ? 'non-finite rejected' : 'non-finite rejection FAILED'
    },
    {
      id: 'matrix.complete',
      name: 'Full 8-profile deterministic matrix enumerated (getLogicalPayloadProfileMatrix)',
      kind: 'correctness',
      passed:
        profileMatrix.length === 8 &&
        profileMatrix.every((p) => aggregatesById.has(p.id)) &&
        new Set(profileMatrix.map((p) => p.id)).size === 8,
      detail: `matrix ids=${profileMatrix.map((p) => p.id).join(',')} count=${profileMatrix.length}`
    },
    {
      id: 'binding.count-first',
      name: 'Synthetic count-first profile demonstrates B-01 binding (count-first)',
      kind: 'correctness',
      passed: countFirstAgg.binding === 'count-first',
      detail: `count-first binding=${countFirstAgg.binding} count=${countFirstAgg.topicCount} aggregate=${countFirstAgg.aggregateBytes}`
    },
    {
      id: 'binding.byte-first',
      name: 'Synthetic byte-first profile demonstrates B-02 binding (byte-first)',
      kind: 'correctness',
      passed: byteFirstAgg.binding === 'byte-first',
      detail: `byte-first binding=${byteFirstAgg.binding} count=${byteFirstAgg.topicCount} aggregate=${byteFirstAgg.aggregateBytes}`
    },
    {
      id: 'binding.oversized',
      name: 'Synthetic oversized single-topic demonstrates B-05 calibration candidate classification (>32 MiB)',
      kind: 'correctness',
      passed:
        oversizedAgg.oversizedTopicIds.length === 1 &&
        (oversizedAgg.perTopic[0]?.byteLength ?? 0) > B05_CALIBRATION_CANDIDATE_BYTES,
      detail: `oversized bytes=${oversizedAgg.perTopic[0]?.byteLength} calibrationCandidate=${B05_CALIBRATION_CANDIDATE_BYTES}`
    },
    {
      id: 'binding.boundary-exact',
      name: 'Boundary-exact profile at B-01 limit (8 topics) is non-binding (equality not bound)',
      kind: 'correctness',
      passed:
        boundaryExactAgg.binding === 'none' &&
        boundaryExactAgg.topicCount === B01_MAX_TOPICS &&
        !boundaryExactAgg.isCountBound &&
        !boundaryExactAgg.isByteBound,
      detail: `boundary-exact binding=${boundaryExactAgg.binding} count=${boundaryExactAgg.topicCount} aggregate=${boundaryExactAgg.aggregateBytes}`
    },
    {
      id: 'binding.both-bound',
      name: 'Both-bound profile demonstrates simultaneous B-01 and B-02 binding (both)',
      kind: 'correctness',
      passed: bothBoundAgg.binding === 'both' && bothBoundAgg.isCountBound && bothBoundAgg.isByteBound,
      detail: `both-bound binding=${bothBoundAgg.binding} count=${bothBoundAgg.topicCount} aggregate=${bothBoundAgg.aggregateBytes}`
    },
    {
      id: 'binding.varied-shape',
      name: 'Varied-shape multi-topic profile is non-binding with deterministic heterogeneous byte distribution',
      kind: 'correctness',
      passed:
        variedShapeAgg.binding === 'none' &&
        variedShapeAgg.topicCount === 3 &&
        variedShapeAgg.oversizedTopicIds.length === 0,
      detail: `varied-shape binding=${variedShapeAgg.binding} count=${variedShapeAgg.topicCount} aggregate=${variedShapeAgg.aggregateBytes}`
    },
    {
      id: 'binding.byte-boundary',
      name: 'Byte-boundary small profile is non-binding (minimal byte payload)',
      kind: 'correctness',
      passed: byteBoundaryAgg.binding === 'none' && byteBoundaryAgg.topicCount === 2 && !byteBoundaryAgg.isByteBound,
      detail: `byte-boundary binding=${byteBoundaryAgg.binding} count=${byteBoundaryAgg.topicCount} aggregate=${byteBoundaryAgg.aggregateBytes}`
    },
    {
      id: 'binding.b02-exact-equality',
      name: 'B02 exact equality profile is non-binding at canonical bytes exactly 32 MiB (strict > threshold)',
      kind: 'correctness',
      passed:
        b02ExactEqualityAgg.binding === 'none' &&
        b02ExactEqualityAgg.aggregateBytes === B02_MAX_BYTES &&
        !b02ExactEqualityAgg.isByteBound &&
        b02ExactEqualityAgg.oversizedTopicIds.length === 0 &&
        (b02ExactEqualityAgg.perTopic[0]?.byteLength ?? 0) === B02_MAX_BYTES,
      detail: `b02-exact equality binding=${b02ExactEqualityAgg.binding} bytes=${b02ExactEqualityAgg.aggregateBytes} isByteBound=${String(b02ExactEqualityAgg.isByteBound)}`
    }
  ]
}

export interface BuildContractParams extends BuildMetricsParams, BuildGatesParams {}

export function buildLogicalPayloadBenchmarkContract(params: BuildContractParams): {
  metrics: BenchmarkMetric[]
  gates: BenchmarkGate[]
} {
  return {
    metrics: buildLogicalPayloadMetrics(params),
    gates: buildLogicalPayloadGates(params)
  }
}
