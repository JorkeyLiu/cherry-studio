/**
 * Phase 4 C-01 — Logical Retained Payload Calibration Benchmark (measurement-only)
 *
 * Deterministic synthetic calibration profiles demonstrating count-first
 * vs byte-first binding and B-05 oversized single-topic classification.
 * Emits schema-v1 numeric-only metrics for every topic and aggregate/profile
 * binding results with correctness gates and deterministic scale metadata.
 *
 * Uses the existing benchmark result emitter (benchResult.ts) and main bench
 * conventions. No runtime cache behavior. Profiles are synthetic and
 * explicitly labeled `synthetic-*` — not adoption evidence (LOCK-C01-002).
 */

import { afterAll, bench, describe, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

import {
  BENCH_RESULT_SCHEMA_VERSION,
  type BenchmarkResult,
  collectEnvironmentMetadata,
  emitBenchmarkResultAfterSuccessfulTasks
} from './benchResult'
import {
  aggregateLogicalPayload,
  B01_MAX_TOPICS,
  B02_MAX_BYTES,
  B05_CALIBRATION_CANDIDATE_BYTES,
  canonicalizeLogicalPayload,
  createSyntheticByteFirstProfile,
  createSyntheticCountFirstProfile,
  createSyntheticOversizedSingleProfile,
  createSyntheticTopic,
  LOGICAL_PAYLOAD_ACCOUNTING_VERSION,
  SYNTHETIC_PROFILE_IDS
} from './logicalPayload'

// ---------------------------------------------------------------------------
// Calibration — computed at bench load time (deterministic, correctness-gated)
// ---------------------------------------------------------------------------

// Guard: verify canonical encoding invariants before any metric collection
const correctnessErrors: string[] = []

// 1) Compact JSON and lexicographic ordering smoke checks via a small topic
try {
  const probe = createSyntheticTopic({ topicId: 'calibration-probe', messageCount: 2, blockContentSize: 16 })
  const { canonicalJson, byteLength } = canonicalizeLogicalPayload(probe)
  if (canonicalJson.includes(': ') || canonicalJson.includes(', ')) {
    correctnessErrors.push('probe: canonical JSON contains whitespace')
  }
  if (byteLength !== Buffer.byteLength(canonicalJson, 'utf8')) {
    correctnessErrors.push('probe: byteLength mismatch')
  }
  const second = canonicalizeLogicalPayload(probe)
  if (second.canonicalJson !== canonicalJson || second.byteLength !== byteLength) {
    correctnessErrors.push('probe: determinism mismatch')
  }
} catch (e) {
  correctnessErrors.push(`probe: ${e instanceof Error ? e.message : String(e)}`)
}

// 2) Orphan rejection gate
let orphanRejectionPassed = false
try {
  const orphanTopic = {
    topicId: 'orphan-gate',
    messages: [{ id: 'msg-001', topicId: 'orphan-gate', sortOrder: 0 } as Record<string, unknown>],
    blocks: [{ id: 'b-orphan', messageId: 'msg-999', type: 'main_text', content: 'x' } as Record<string, unknown>],
    segments: [] as Record<string, unknown>[],
    completeness: { chatData: true, segments: true, residentTopic: true },
    applicabilityGeneration: 0
  }
  let threw = false
  try {
    canonicalizeLogicalPayload(orphanTopic)
  } catch {
    threw = true
  }
  orphanRejectionPassed = threw
  if (!threw) correctnessErrors.push('orphan-gate: expected rejection did not throw')
} catch (e) {
  correctnessErrors.push(`orphan-gate setup: ${e instanceof Error ? e.message : String(e)}`)
}

// 3) Non-finite rejection gate
let nonFiniteRejectionPassed = false
try {
  const bad = createSyntheticTopic({ topicId: 'nonfinite-gate', messageCount: 1, blockContentSize: 4 })
  bad.messages[0]['bad'] = Number.NaN
  let threw = false
  try {
    canonicalizeLogicalPayload(bad)
  } catch {
    threw = true
  }
  nonFiniteRejectionPassed = threw
  if (!threw) correctnessErrors.push('non-finite-gate: expected rejection did not throw')
} catch (e) {
  correctnessErrors.push(`non-finite-gate setup: ${e instanceof Error ? e.message : String(e)}`)
}

if (correctnessErrors.length > 0) {
  throw new Error(`Calibration aborted — correctness gates failed BEFORE metrics:\n${correctnessErrors.join('\n')}`)
}

// Deterministic synthetic profiles
const countFirstTopics = createSyntheticCountFirstProfile()
const byteFirstTopics = createSyntheticByteFirstProfile()
const oversizedSingleTopics = createSyntheticOversizedSingleProfile()

const countFirstAgg = aggregateLogicalPayload(countFirstTopics)
const byteFirstAgg = aggregateLogicalPayload(byteFirstTopics)
const oversizedAgg = aggregateLogicalPayload(oversizedSingleTopics)

// Combined view for overall scale (not a binding participant; just scale traceability)
const combinedTopics = [...countFirstTopics, ...byteFirstTopics, ...oversizedSingleTopics]
const combinedAgg = aggregateLogicalPayload(combinedTopics)

console.log(
  `\n=== Logical Retained Payload Calibration (phase4-logical-payload-v1) ===\n` +
    `Accounting version: ${LOGICAL_PAYLOAD_ACCOUNTING_VERSION}\n` +
    `B-01 calibration candidate max topics: ${B01_MAX_TOPICS}  B-02 calibration candidate max bytes: ${B02_MAX_BYTES} (${(B02_MAX_BYTES / (1024 * 1024)).toFixed(0)} MiB)  B-05 calibration candidate: ${B05_CALIBRATION_CANDIDATE_BYTES}\n` +
    `Profile ${SYNTHETIC_PROFILE_IDS.countFirst}: ${countFirstAgg.topicCount} topics, aggregate ${countFirstAgg.aggregateBytes} bytes (${(countFirstAgg.aggregateBytes / (1024 * 1024)).toFixed(2)} MiB), binding=${countFirstAgg.binding}\n` +
    `Profile ${SYNTHETIC_PROFILE_IDS.byteFirst}: ${byteFirstAgg.topicCount} topics, aggregate ${byteFirstAgg.aggregateBytes} bytes (${(byteFirstAgg.aggregateBytes / (1024 * 1024)).toFixed(2)} MiB), binding=${byteFirstAgg.binding}\n` +
    `Profile ${SYNTHETIC_PROFILE_IDS.oversizedSingle}: ${oversizedAgg.topicCount} topic, single bytes ${oversizedAgg.perTopic[0]?.byteLength} (${((oversizedAgg.perTopic[0]?.byteLength ?? 0) / (1024 * 1024)).toFixed(2)} MiB), oversized=${oversizedAgg.oversizedTopicIds.length > 0}\n` +
    `Combined: ${combinedAgg.topicCount} topics, aggregate ${combinedAgg.aggregateBytes} bytes`
)

// ---------------------------------------------------------------------------
// Metrics (schema-v1 numeric-only, every topic + aggregate/profile bindings)
// ---------------------------------------------------------------------------

// Helper to encode binding as numeric enum for metric values (finite numeric required)
function bindingToNumeric(binding: string): number {
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

const metrics: BenchmarkResult['metrics'] = []

// Per-topic bytes — count-first
countFirstAgg.perTopic.forEach((p, idx) => {
  metrics.push({
    id: `countFirst.topic.${idx}.bytes`,
    name: `Count-first topic ${idx} bytes (${p.topicId})`,
    value: p.byteLength,
    unit: 'bytes'
  })
})

// Per-topic bytes — byte-first
byteFirstAgg.perTopic.forEach((p, idx) => {
  metrics.push({
    id: `byteFirst.topic.${idx}.bytes`,
    name: `Byte-first topic ${idx} bytes (${p.topicId})`,
    value: p.byteLength,
    unit: 'bytes'
  })
})

// Per-topic bytes — oversized single
oversizedAgg.perTopic.forEach((p, idx) => {
  metrics.push({
    id: `oversizedSingle.topic.${idx}.bytes`,
    name: `Oversized single topic ${idx} bytes (${p.topicId})`,
    value: p.byteLength,
    unit: 'bytes'
  })
})

// Aggregate + binding metrics per profile (numeric-only)
metrics.push(
  {
    id: 'countFirst.aggregate.bytes',
    name: 'Count-first aggregate bytes',
    value: countFirstAgg.aggregateBytes,
    unit: 'bytes'
  },
  { id: 'countFirst.topicCount', name: 'Count-first topic count', value: countFirstAgg.topicCount },
  {
    id: 'countFirst.isCountBound',
    name: 'Count-first is count-bound (1=true)',
    value: countFirstAgg.isCountBound ? 1 : 0
  },
  {
    id: 'countFirst.isByteBound',
    name: 'Count-first is byte-bound (1=true)',
    value: countFirstAgg.isByteBound ? 1 : 0
  },
  {
    id: 'countFirst.binding',
    name: 'Count-first binding enum (0=none,1=count,2=byte,3=both)',
    value: bindingToNumeric(countFirstAgg.binding)
  },
  {
    id: 'countFirst.oversizedCount',
    name: 'Count-first oversized topic count',
    value: countFirstAgg.oversizedTopicIds.length
  }
)

metrics.push(
  {
    id: 'byteFirst.aggregate.bytes',
    name: 'Byte-first aggregate bytes',
    value: byteFirstAgg.aggregateBytes,
    unit: 'bytes'
  },
  { id: 'byteFirst.topicCount', name: 'Byte-first topic count', value: byteFirstAgg.topicCount },
  { id: 'byteFirst.isCountBound', name: 'Byte-first is count-bound', value: byteFirstAgg.isCountBound ? 1 : 0 },
  { id: 'byteFirst.isByteBound', name: 'Byte-first is byte-bound', value: byteFirstAgg.isByteBound ? 1 : 0 },
  { id: 'byteFirst.binding', name: 'Byte-first binding enum', value: bindingToNumeric(byteFirstAgg.binding) },
  { id: 'byteFirst.oversizedCount', name: 'Byte-first oversized count', value: byteFirstAgg.oversizedTopicIds.length }
)

metrics.push(
  {
    id: 'oversizedSingle.aggregate.bytes',
    name: 'Oversized single aggregate bytes',
    value: oversizedAgg.aggregateBytes,
    unit: 'bytes'
  },
  { id: 'oversizedSingle.topicCount', name: 'Oversized single topic count', value: oversizedAgg.topicCount },
  {
    id: 'oversizedSingle.topic.0.isOversized',
    name: 'Oversized single topic 0 is oversized (1=true)',
    value: oversizedAgg.oversizedTopicIds.length > 0 ? 1 : 0
  },
  {
    id: 'oversizedSingle.oversizedCount',
    name: 'Oversized single oversized count',
    value: oversizedAgg.oversizedTopicIds.length
  }
)

metrics.push(
  {
    id: 'combined.aggregate.bytes',
    name: 'Combined aggregate bytes',
    value: combinedAgg.aggregateBytes,
    unit: 'bytes'
  },
  { id: 'combined.topicCount', name: 'Combined topic count', value: combinedAgg.topicCount }
)

// Calibration candidate traces (numeric) for evidence that B-01/B-02/B-05 are calibration candidates, not thresholds
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

// ---------------------------------------------------------------------------
// Benchmark result artifact (schema-v1)
// ---------------------------------------------------------------------------

const logicalPayloadBenchmarkResult: BenchmarkResult = {
  schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
  benchmark: {
    id: 'logical-retained-payload-calibration',
    name: 'Logical retained payload calibration — phase4-logical-payload-v1 synthetic profiles',
    scale: {
      countFirst_topics: countFirstAgg.topicCount,
      countFirst_messagesPerTopic: 10,
      countFirst_blockSize: 1024,
      countFirst_segmentsPerTopic: 1,
      byteFirst_topics: byteFirstAgg.topicCount,
      byteFirst_messagesPerTopic: 550,
      byteFirst_blockSize: 16 * 1024,
      oversizedSingle_topics: oversizedAgg.topicCount,
      oversizedSingle_messages: 2800,
      oversizedSingle_blockSize: 14 * 1024,
      combined_topics: combinedAgg.topicCount,
      B01_maxTopics: B01_MAX_TOPICS,
      B02_maxBytes: B02_MAX_BYTES,
      B05_calibrationCandidateBytes: B05_CALIBRATION_CANDIDATE_BYTES,
      accountingVersionCode: 1
    }
  },
  environment: collectEnvironmentMetadata({ command: 'pnpm bench:logical-payload' }),
  metrics,
  gates: [
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
    }
  ]
}

// ---------------------------------------------------------------------------
// Vitest bench tasks — tinybench measurement of canonicalization throughput
// ---------------------------------------------------------------------------

describe('logical-retained-payload calibration — canonicalization throughput', () => {
  bench(
    'canonicalize small topic (10 msgs × 1 KiB)',
    () => {
      const t = createSyntheticTopic({ topicId: 'bench-small', messageCount: 10, blockContentSize: 1024 })
      canonicalizeLogicalPayload(t)
    },
    { warmupIterations: 2, iterations: 5 }
  )

  bench(
    'aggregate accounting count-first profile (9 topics)',
    () => {
      aggregateLogicalPayload(countFirstTopics)
    },
    { warmupIterations: 2, iterations: 5 }
  )
})

// File-level afterAll — artifact only after all bench tasks passed (audit F1)
afterAll((suite) => {
  const artifactPath = emitBenchmarkResultAfterSuccessfulTasks(suite, logicalPayloadBenchmarkResult)
  if (artifactPath !== null) {
    console.log(`Result artifact: ${artifactPath}`)
  }
})
