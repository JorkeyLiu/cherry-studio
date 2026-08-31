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
  LOGICAL_PAYLOAD_ACCOUNTING_VERSION,
  type LogicalPayloadTopicInput
} from '@shared/chatDb/logicalPayload'

import {
  BENCH_RESULT_SCHEMA_VERSION,
  type BenchmarkResult,
  collectEnvironmentMetadata,
  emitBenchmarkResultAfterSuccessfulTasksAndGates
} from './benchResult'
import { createSyntheticTopic, getLogicalPayloadProfileMatrix, SYNTHETIC_PROFILE_IDS } from './logicalPayload'
import { buildLogicalPayloadBenchmarkContract } from './logicalPayload.benchContract'

// ---------------------------------------------------------------------------
// Calibration — computed at bench load time (deterministic, correctness-gated)
// ---------------------------------------------------------------------------

// Guard: verify canonical encoding invariants before any metric collection
const correctnessErrors: string[] = []

function findLexicographicViolation(value: unknown, path = '$'): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < (value as unknown[]).length; i++) {
      const violation = findLexicographicViolation((value as unknown[])[i], `${path}[${i}]`)
      if (violation) return violation
    }
    return null
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
    const sorted = [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] !== sorted[i]) {
        return `${path}: keys [${keys.join(',')}] not lexicographically sorted (expected [${sorted.join(',')}])`
      }
    }
    for (const k of keys) {
      const violation = findLexicographicViolation(obj[k], `${path}.${k}`)
      if (violation) return violation
    }
  }
  return null
}

// 1) Compact JSON, recursive lexicographic ordering, UTF-8 byte length, determinism — independent verification
try {
  const probe = createSyntheticTopic({ topicId: 'calibration-probe', messageCount: 2, blockContentSize: 16 })
  const { canonicalJson, byteLength, canonicalFrame } = canonicalizeLogicalPayload(probe)
  if (canonicalJson.includes(': ') || canonicalJson.includes(', ')) {
    correctnessErrors.push('probe: canonical JSON contains whitespace')
  }
  if (canonicalJson.includes('\n')) {
    correctnessErrors.push('probe: canonical JSON contains newline')
  }
  // Independent recursive lexicographic key ordering assertion
  const violation = findLexicographicViolation(canonicalFrame)
  if (violation !== null) {
    correctnessErrors.push(`probe: lexicographic ordering violated at ${violation}`)
  }
  // Independent unsorted-input sorting verification (keys deliberately out of lexical order)
  try {
    const unsortedInput: LogicalPayloadTopicInput = {
      topicId: 'lexicographic-probe',
      messages: [
        {
          z: 'last',
          a: 'first',
          m: 'middle',
          id: 'msg-001',
          sortOrder: 0,
          topicId: 'lexicographic-probe',
          blocks: ['b1']
        } as Record<string, unknown>
      ],
      blocks: [
        { id: 'b1', messageId: 'msg-001', type: 'main_text', content: 'hi', z: 1, a: 0 } as Record<string, unknown>
      ],
      segments: [] as Record<string, unknown>[],
      completeness: { chatData: true, segments: true, residentTopic: true },
      applicabilityGeneration: 0
    }
    const lex = canonicalizeLogicalPayload(unsortedInput)
    const lexViolation = findLexicographicViolation(lex.canonicalFrame)
    if (lexViolation !== null) {
      correctnessErrors.push(`lexicographic-probe: ordering violated at ${lexViolation}`)
    }
    const msgSlice = lex.canonicalJson.slice(lex.canonicalJson.indexOf('"messages"'))
    const aIdx = msgSlice.indexOf('"a"')
    const mIdx = msgSlice.indexOf('"m"')
    const zIdx = msgSlice.indexOf('"z"')
    if (!(aIdx !== -1 && mIdx !== -1 && zIdx !== -1 && aIdx < mIdx && mIdx < zIdx)) {
      correctnessErrors.push('lexicographic-probe: unsorted keys not correctly reordered in canonical JSON (a<m<z)')
    }
  } catch (e) {
    correctnessErrors.push(`lexicographic-probe: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Independent UTF-8 byte length: cross-check byteLength against two independent encoders and known vectors
  const bufferLen = Buffer.byteLength(canonicalJson, 'utf8')
  const encoderLen = new TextEncoder().encode(canonicalJson).byteLength
  if (byteLength !== utf8ByteLength(canonicalJson)) {
    correctnessErrors.push('probe: byteLength mismatch vs utf8ByteLength')
  }
  if (byteLength !== bufferLen) {
    correctnessErrors.push(`probe: byteLength ${byteLength} != Buffer.byteLength ${bufferLen}`)
  }
  if (byteLength !== encoderLen) {
    correctnessErrors.push(`probe: byteLength ${byteLength} != TextEncoder.byteLength ${encoderLen}`)
  }
  // Known-value vector check independent of probe (hard-coded expected UTF-8 byte lengths)
  const knownVectors: Array<[string, number]> = [
    ['', 0],
    ['a', 1],
    ['abc', 3],
    ['é', 2],
    ['文', 3],
    ['😀', 4],
    ['a文😀', 8],
    ['Hello 世界 🌍', 17]
  ]
  for (const [str, expected] of knownVectors) {
    const viaShared = utf8ByteLength(str)
    const viaBuffer = Buffer.byteLength(str, 'utf8')
    const viaEncoder = new TextEncoder().encode(str).byteLength
    if (viaShared !== expected) {
      correctnessErrors.push(`utf8 vector '${str}': utf8ByteLength ${viaShared} != expected ${expected}`)
    }
    if (viaBuffer !== expected) {
      correctnessErrors.push(`utf8 vector '${str}': Buffer.byteLength ${viaBuffer} != expected ${expected}`)
    }
    if (viaEncoder !== expected) {
      correctnessErrors.push(`utf8 vector '${str}': TextEncoder ${viaEncoder} != expected ${expected}`)
    }
    if (viaShared !== viaBuffer || viaShared !== viaEncoder) {
      correctnessErrors.push(
        `utf8 vector '${str}': encoder mismatch shared=${viaShared} buffer=${viaBuffer} encoder=${viaEncoder}`
      )
    }
  }
  // Unicode canonical payload byteLength independent verification
  try {
    const unicodeTopic: LogicalPayloadTopicInput = {
      topicId: 'utf8-probe',
      messages: [{ id: 'msg-001', topicId: 'utf8-probe', sortOrder: 0, blocks: ['b1'] } as Record<string, unknown>],
      blocks: [
        {
          id: 'b1',
          messageId: 'msg-001',
          type: 'main_text',
          content: '中文😀 a',
          status: 'success'
        } as Record<string, unknown>
      ],
      segments: [] as Record<string, unknown>[],
      completeness: { chatData: true, segments: true, residentTopic: true },
      applicabilityGeneration: 0
    }
    const uni = canonicalizeLogicalPayload(unicodeTopic)
    const uniBuffer = Buffer.byteLength(uni.canonicalJson, 'utf8')
    const uniEncoder = new TextEncoder().encode(uni.canonicalJson).byteLength
    if (uni.byteLength !== uniBuffer || uni.byteLength !== uniEncoder) {
      correctnessErrors.push(
        `utf8-probe: byteLength ${uni.byteLength} mismatch buffer ${uniBuffer} encoder ${uniEncoder}`
      )
    }
    if (uni.byteLength <= uni.canonicalJson.length) {
      correctnessErrors.push('utf8-probe: expected byteLength > string length for multibyte content')
    }
  } catch (e) {
    correctnessErrors.push(`utf8-probe: ${e instanceof Error ? e.message : String(e)}`)
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

// File-level afterAll — artifact only after all bench tasks AND gates passed (fail-closed)
afterAll((suite) => {
  const artifactPath = emitBenchmarkResultAfterSuccessfulTasksAndGates(suite, logicalPayloadBenchmarkResult)
  if (artifactPath !== null) {
    console.log(`Result artifact: ${artifactPath}`)
  }
})
