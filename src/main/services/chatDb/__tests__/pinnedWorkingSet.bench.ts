/**
 * Phase 5 §5.10 — Pinned working-set / evictable-set / unlimited-context
 * enlargement calibration harness (measurement-only, Node lane).
 *
 * Generates a schema-v1 retained artifact in `test-results/bench-results`
 * with stable benchmark id `pinned-working-set-calibration`, using existing
 * closed schema-v1 fields only. Models the existing deterministic full
 * three-matrix set (matrix-standard-v1 / matrix-small-v1 / matrix-large-v1)
 * each with explicit pinned/evictable partitions and an unlimited-context
 * variant, reports logical bytes (phase4-logical-payload-v1) where safely
 * measurable, and fails closed on invalid/non-finite data.
 *
 * Prefers Node-lane measurement-only harness — renderer heap is not
 * measured here without production/E2E coupling; coverage limit is stated
 * rather than substituting a production claim (C-02 one-profile/
 * GC-sensitive remains separate).
 *
 * No production chat code, IPC, schema, or governance document is modified.
 * No concrete payload/channel/SQL/cursor/N/K/window/closure/eviction value
 * is selected or adopted per program measurement-only governance.
 * Directional/non-adopting evidence only per program governance.
 * Emission is the full existing three-matrix deterministic set via shared
 * pure contract builder (pinnedWorkingSet.benchContract.ts) so emitter and
 * tests cannot drift.
 */

import { afterAll, bench, describe, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

import { utf8ByteLength } from '@shared/chatDb'
import { canonicalizeLogicalPayload } from '@shared/chatDb/logicalPayload'

import { collectEnvironmentMetadata, emitBenchmarkResultAfterSuccessfulTasksAndGates } from './benchResult'
import { createSyntheticTopic } from './logicalPayload'
import {
  assertFiniteMetricValue,
  buildMultiMatrixScaleMap,
  computeAllPinnedWorkingSetAccountings,
  heapAmplificationCoverageLimit,
  PINNED_WORKING_SET_ACCOUNTING_VERSION
} from './pinnedWorkingSet'
import {
  assemblePinnedWorkingSetBenchmarkResult,
  buildPinnedWorkingSetBenchmarkContract
} from './pinnedWorkingSet.benchContract'

// ---------------------------------------------------------------------------
// Calibration — computed at bench load time (deterministic, correctness-gated)
// ---------------------------------------------------------------------------

const correctnessErrors: string[] = []

// 1) Canonical invariants smoke check
try {
  const probe = createSyntheticTopic({ topicId: 'pws-probe', messageCount: 2, blockContentSize: 16 })
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
    topicId: 'pws-orphan-gate',
    messages: [{ id: 'msg-001', topicId: 'pws-orphan-gate', sortOrder: 0 } as Record<string, unknown>],
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
  const bad = createSyntheticTopic({ topicId: 'pws-nonfinite-gate', messageCount: 1, blockContentSize: 4 })
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
  throw new Error(
    `Pinned working-set calibration aborted — correctness gates failed BEFORE metrics:\n${correctnessErrors.join('\n')}`
  )
}

// Deterministic synthetic full-matrix accounting (existing three matrices)
const matrixAccountings = computeAllPinnedWorkingSetAccountings()
const heapCoverage = heapAmplificationCoverageLimit()
const scale = buildMultiMatrixScaleMap()

// Validate all metric values are finite before emission (fail-closed)
for (const { matrixId, accounting } of matrixAccountings) {
  for (const part of [accounting.pinned, accounting.evictable, accounting.combined, accounting.unlimited]) {
    assertFiniteMetricValue(`${matrixId}.${part.label}.aggregate`, part.aggregateBytes)
    assertFiniteMetricValue(`${matrixId}.${part.label}.topicCount`, part.topicCount)
    for (const p of part.perTopic) {
      assertFiniteMetricValue(`${matrixId}.${part.label}.perTopic.${p.topicId}`, p.byteLength)
    }
  }
  assertFiniteMetricValue(`${matrixId}.enlargementRatio`, accounting.enlargementRatio)
}

console.log(
  `\n=== Pinned Working-Set Calibration (phase4-logical-payload-v1) — full 3-matrix ===\n` +
    `Accounting version: ${PINNED_WORKING_SET_ACCOUNTING_VERSION}\n` +
    matrixAccountings
      .map(
        (m) =>
          `Matrix ${m.matrixId}: pinned ${m.accounting.pinned.topicCount} topics (${m.accounting.pinned.aggregateBytes} bytes), evictable ${m.accounting.evictable.topicCount} topics (${m.accounting.evictable.aggregateBytes} bytes), combined ${m.accounting.combined.aggregateBytes} bytes — sum check ${m.accounting.combinedCheck ? 'pass' : 'FAIL'}, unlimited ${m.accounting.unlimited.aggregateBytes} bytes — ratio vs pinned ${m.accounting.enlargementRatio.toFixed(2)}x`
      )
      .join('\n') +
    `\nHeap/amplification: ${heapCoverage.measurable ? 'measurable' : 'NOT measurable in Node lane — ' + heapCoverage.reason}\n` +
    `All profiles synthetic, directional, non-adopting per program governance; no window/eviction bound selected.`
)

// ---------------------------------------------------------------------------
// Metrics & gates — pure shared contract (emitter uses builder output directly)
// ---------------------------------------------------------------------------

const sharedContractVerified = buildPinnedWorkingSetBenchmarkContract({
  matrixAccountings,
  heapCoverage,
  correctnessErrors,
  orphanRejectionPassed,
  nonFiniteRejectionPassed
})
void sharedContractVerified

// ---------------------------------------------------------------------------
// Benchmark result artifact (schema-v1, stable id, existing fields only)
// — assembled via pure shared contract so emitter and tests cannot drift
// — emission is fail-closed: all gates must pass
// ---------------------------------------------------------------------------

const pinnedWorkingSetBenchmarkResult = assemblePinnedWorkingSetBenchmarkResult({
  matrixAccountings,
  heapCoverage,
  correctnessErrors,
  orphanRejectionPassed,
  nonFiniteRejectionPassed,
  scale,
  environment: collectEnvironmentMetadata({ command: 'pnpm bench:pinned-working-set' })
})

// ---------------------------------------------------------------------------
// Vitest bench tasks — tinybench measurement of canonicalization throughput
// for the pinned matrices (deterministic, not a threshold)
// ---------------------------------------------------------------------------

describe('pinned working-set calibration — canonicalization throughput (directional)', () => {
  bench(
    'canonicalize pinned partition topic (20 msgs × 1 KiB)',
    () => {
      const t = createSyntheticTopic({ topicId: 'bench-pws-pinned', messageCount: 20, blockContentSize: 1024 })
      canonicalizeLogicalPayload(t)
    },
    { warmupIterations: 1, iterations: 3 }
  )

  bench(
    'aggregate pinned working-set matrices (full 3-matrix: pinned+evictable+unlimited per matrix)',
    () => {
      computeAllPinnedWorkingSetAccountings()
    },
    { warmupIterations: 1, iterations: 3 }
  )
})

// File-level afterAll — artifact only after all bench tasks passed AND all gates passed (fail-closed)
afterAll((suite) => {
  const artifactPath = emitBenchmarkResultAfterSuccessfulTasksAndGates(suite, pinnedWorkingSetBenchmarkResult)
  if (artifactPath !== null) {
    console.log(`Result artifact: ${artifactPath}`)
  } else if (!pinnedWorkingSetBenchmarkResult.gates.every((g) => g.passed)) {
    console.warn('Pinned working-set calibration: artifact suppressed — one or more gates failed (fail-closed)')
  }
})
