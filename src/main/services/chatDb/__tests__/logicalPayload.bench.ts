/**
 * Phase 4 C-01 — Logical Retained Payload Calibration Benchmark (measurement-only)
 *
 * Deterministic synthetic calibration profiles exercising the full
 * `getLogicalPayloadProfileMatrix()` 8-profile matrix (count-first,
 * byte-first, both-bound, oversized, equality/non-binding boundary and
 * varied-shape cases). Emits schema-v1 numeric-only metrics for every topic
 * and aggregate/profile binding results with correctness gates and
 * deterministic scale metadata.
 *
 * Uses the existing benchmark result emitter (benchResult.ts) and main bench
 * conventions. No runtime cache behavior. Profiles are synthetic and
 * explicitly labeled `synthetic-*` — not adoption evidence (LOCK-C01-002).
 * B-01 (8 topics), B-02 (32 MiB), and B-05 are calibration candidates only,
 * not production thresholds or cache/eviction behavior (LOCK-001).
 */

import { afterAll, bench, describe, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

import { utf8ByteLength } from '@shared/chatDb'
import {
  aggregateLogicalPayload,
  B01_MAX_TOPICS,
  B02_MAX_BYTES,
  B05_CALIBRATION_CANDIDATE_BYTES,
  canonicalizeLogicalPayload,
  LOGICAL_PAYLOAD_ACCOUNTING_VERSION
} from '@shared/chatDb/logicalPayload'

import {
  BENCH_RESULT_SCHEMA_VERSION,
  type BenchmarkResult,
  collectEnvironmentMetadata,
  emitBenchmarkResultAfterSuccessfulTasks
} from './benchResult'
import { createSyntheticTopic, getLogicalPayloadProfileMatrix, SYNTHETIC_PROFILE_IDS } from './logicalPayload'
import { buildLogicalPayloadBenchmarkContract } from './logicalPayload.benchContract'

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
  if (byteLength !== utf8ByteLength(canonicalJson)) {
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

// Deterministic synthetic profiles — full matrix (8 profiles)
const profileMatrix = getLogicalPayloadProfileMatrix()

const aggregatesById = new Map<string, ReturnType<typeof aggregateLogicalPayload>>()
for (const { id, topics } of profileMatrix) {
  aggregatesById.set(id, aggregateLogicalPayload(topics))
}

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

// Combined view for overall scale (not a binding participant; just scale traceability) — full matrix flattened
const combinedTopics = profileMatrix.flatMap((p) => p.topics)
const combinedAgg = aggregateLogicalPayload(combinedTopics)

console.log(
  `\n=== Logical Retained Payload Calibration (phase4-logical-payload-v1) ===\n` +
    `Accounting version: ${LOGICAL_PAYLOAD_ACCOUNTING_VERSION}\n` +
    `B-01 calibration candidate max topics: ${B01_MAX_TOPICS}  B-02 calibration candidate max bytes: ${B02_MAX_BYTES} (${(B02_MAX_BYTES / (1024 * 1024)).toFixed(0)} MiB)  B-05 calibration candidate: ${B05_CALIBRATION_CANDIDATE_BYTES}\n` +
    profileMatrix
      .map(({ id }) => {
        const agg = requireAgg(id)
        const oversized = agg.oversizedTopicIds.length > 0 ? ` oversized=${agg.oversizedTopicIds.length}` : ''
        return `Profile ${id}: ${agg.topicCount} topics, aggregate ${agg.aggregateBytes} bytes (${(agg.aggregateBytes / (1024 * 1024)).toFixed(2)} MiB), binding=${agg.binding}${oversized}`
      })
      .join('\n') +
    `\nCombined: ${combinedAgg.topicCount} topics, aggregate ${combinedAgg.aggregateBytes} bytes`
)

// ---------------------------------------------------------------------------
// Metrics & gates — pure shared contract (emitter uses builder output directly)
// ---------------------------------------------------------------------------

const { metrics, gates } = buildLogicalPayloadBenchmarkContract({
  profileMatrix,
  aggregatesById,
  combinedAgg,
  correctnessErrors,
  orphanRejectionPassed,
  nonFiniteRejectionPassed
})

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
      boundaryExact_topics: boundaryExactAgg.topicCount,
      boundaryExact_messagesPerTopic: 10,
      boundaryExact_blockSize: 1024,
      bothBound_topics: bothBoundAgg.topicCount,
      bothBound_messagesPerTopic: 550,
      bothBound_blockSize: 16 * 1024,
      variedShape_topics: variedShapeAgg.topicCount,
      byteBoundary_topics: byteBoundaryAgg.topicCount,
      byteBoundary_messagesPerTopic: 1,
      byteBoundary_blockSize: 1024,
      b02ExactEquality_topics: b02ExactEqualityAgg.topicCount,
      b02ExactEquality_aggregateBytes: b02ExactEqualityAgg.aggregateBytes,
      combined_topics: combinedAgg.topicCount,
      matrix_profileCount: profileMatrix.length,
      B01_maxTopics: B01_MAX_TOPICS,
      B02_maxBytes: B02_MAX_BYTES,
      B05_calibrationCandidateBytes: B05_CALIBRATION_CANDIDATE_BYTES,
      accountingVersionCode: 1
    }
  },
  environment: collectEnvironmentMetadata({ command: 'pnpm bench:logical-payload' }),
  metrics,
  gates
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
      const topics = profileMatrix.find((p) => p.id === SYNTHETIC_PROFILE_IDS.countFirst)?.topics ?? []
      aggregateLogicalPayload(topics)
    },
    { warmupIterations: 2, iterations: 5 }
  )

  bench(
    'aggregate accounting full matrix (8 profiles, 37 topics)',
    () => {
      for (const { topics } of profileMatrix) {
        aggregateLogicalPayload(topics)
      }
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
