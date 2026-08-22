/**
 * Phase 5 §5.10 — Pinned working-set / evictable-set / unlimited-context
 * enlargement calibration harness (measurement-only, Node lane).
 *
 * Generates a schema-v1 retained artifact in `test-results/bench-results`
 * with a new unique benchmark id, using existing closed schema-v1 fields
 * only. Models the documented synthetic matrix with explicit pinned/
 * evictable partitions and an unlimited-context variant, reports logical
 * bytes (phase4-logical-payload-v1) where safely measurable, and fails
 * closed on invalid/non-finite data.
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
import { canonicalizeLogicalPayload, createSyntheticTopic } from './logicalPayload'
import {
  assertFiniteMetricValue,
  buildPinnedWorkingSetScaleMap,
  computePinnedWorkingSetAccounting,
  EVICTABLE_PARTITION_CONFIG,
  heapAmplificationCoverageLimit,
  PINNED_PARTITION_CONFIG,
  PINNED_WORKING_SET_ACCOUNTING_VERSION,
  PINNED_WORKING_SET_MATRIX_IDS,
  UNLIMITED_CONTEXT_CONFIG
} from './pinnedWorkingSet'

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

// Deterministic synthetic matrix accounting
const accounting = computePinnedWorkingSetAccounting()
const heapCoverage = heapAmplificationCoverageLimit()
const scale = buildPinnedWorkingSetScaleMap()

// Validate all metric values are finite before emission (fail-closed)
for (const part of [accounting.pinned, accounting.evictable, accounting.combined, accounting.unlimited]) {
  assertFiniteMetricValue(`${part.label}.aggregate`, part.aggregateBytes)
  assertFiniteMetricValue(`${part.label}.topicCount`, part.topicCount)
  for (const p of part.perTopic) {
    assertFiniteMetricValue(`${part.label}.perTopic.${p.topicId}`, p.byteLength)
  }
}
assertFiniteMetricValue('enlargementRatio', accounting.enlargementRatio)

console.log(
  `\n=== Pinned Working-Set Calibration (phase4-logical-payload-v1) ===\n` +
    `Accounting version: ${PINNED_WORKING_SET_ACCOUNTING_VERSION}\n` +
    `Matrix: pinned ${accounting.pinned.topicCount} topics, evictable ${accounting.evictable.topicCount} topics, combined ${accounting.combined.topicCount}, unlimited-variant ${accounting.unlimited.topicCount}\n` +
    `Pinned aggregate ${accounting.pinned.aggregateBytes} bytes (${(accounting.pinned.aggregateBytes / 1024).toFixed(1)} KiB)\n` +
    `Evictable aggregate ${accounting.evictable.aggregateBytes} bytes (${(accounting.evictable.aggregateBytes / 1024).toFixed(1)} KiB)\n` +
    `Combined aggregate ${accounting.combined.aggregateBytes} bytes (${(accounting.combined.aggregateBytes / 1024).toFixed(1)} KiB) — sum check ${accounting.combinedCheck ? 'pass' : 'FAIL'}\n` +
    `Unlimited-context enlargement aggregate ${accounting.unlimited.aggregateBytes} bytes (${(accounting.unlimited.aggregateBytes / 1024).toFixed(1)} KiB) — ratio vs pinned ${accounting.enlargementRatio.toFixed(2)}x\n` +
    `Heap/amplification: ${heapCoverage.measurable ? 'measurable' : 'NOT measurable in Node lane — ' + heapCoverage.reason}\n` +
    `All profiles synthetic, directional, non-adopting per program governance; no window/eviction bound selected.`
)

// ---------------------------------------------------------------------------
// Metrics (schema-v1 numeric-only, explicit partitions)
// ---------------------------------------------------------------------------

const metrics: BenchmarkResult['metrics'] = []

// Per-topic bytes — pinned
accounting.pinned.perTopic.forEach((p, idx) => {
  metrics.push({
    id: `pinned.topic.${idx}.bytes`,
    name: `Pinned partition topic ${idx} bytes (${p.topicId})`,
    value: p.byteLength,
    unit: 'bytes'
  })
})

// Per-topic bytes — evictable
accounting.evictable.perTopic.forEach((p, idx) => {
  metrics.push({
    id: `evictable.topic.${idx}.bytes`,
    name: `Evictable partition topic ${idx} bytes (${p.topicId})`,
    value: p.byteLength,
    unit: 'bytes'
  })
})

// Per-topic bytes — unlimited variant
accounting.unlimited.perTopic.forEach((p, idx) => {
  metrics.push({
    id: `unlimited.topic.${idx}.bytes`,
    name: `Unlimited-context variant topic ${idx} bytes (${p.topicId})`,
    value: p.byteLength,
    unit: 'bytes'
  })
})

// Aggregate + partition metrics (numeric-only, directional synthetic)
metrics.push(
  {
    id: 'pinned.aggregate.bytes',
    name: 'Pinned partition aggregate bytes (directional synthetic)',
    value: accounting.pinned.aggregateBytes,
    unit: 'bytes'
  },
  {
    id: 'pinned.topicCount',
    name: 'Pinned partition topic count (directional synthetic)',
    value: accounting.pinned.topicCount,
    unit: 'count'
  },
  {
    id: 'evictable.aggregate.bytes',
    name: 'Evictable partition aggregate bytes (directional synthetic)',
    value: accounting.evictable.aggregateBytes,
    unit: 'bytes'
  },
  {
    id: 'evictable.topicCount',
    name: 'Evictable partition topic count (directional synthetic)',
    value: accounting.evictable.topicCount,
    unit: 'count'
  },
  {
    id: 'combined.aggregate.bytes',
    name: 'Combined working-set aggregate bytes (pinned+evictable, directional synthetic)',
    value: accounting.combined.aggregateBytes,
    unit: 'bytes'
  },
  {
    id: 'combined.topicCount',
    name: 'Combined working-set topic count (directional synthetic)',
    value: accounting.combined.topicCount,
    unit: 'count'
  },
  {
    id: 'unlimited.aggregate.bytes',
    name: 'Unlimited-context enlargement aggregate bytes (directional synthetic)',
    value: accounting.unlimited.aggregateBytes,
    unit: 'bytes'
  },
  {
    id: 'unlimited.topicCount',
    name: 'Unlimited-context enlargement topic count (directional synthetic)',
    value: accounting.unlimited.topicCount,
    unit: 'count'
  },
  {
    id: 'enlargement.ratio.unlimitedOverPinned',
    name: 'Unlimited-context enlargement ratio = unlimited / pinned (directional synthetic)',
    value: accounting.enlargementRatio,
    unit: 'ratio'
  },
  {
    id: 'heap.measurable',
    name: 'Heap/amplification measurable in this lane (1=measurable, 0=not measurable — Node lane reports logical bytes only)',
    value: heapCoverage.measurable ? 1 : 0,
    unit: 'count'
  }
)

// ---------------------------------------------------------------------------
// Benchmark result artifact (schema-v1, new unique id, existing fields only)
// ---------------------------------------------------------------------------

const pinnedWorkingSetBenchmarkResult: BenchmarkResult = {
  schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
  benchmark: {
    id: 'pinned-working-set-calibration',
    name: 'Pinned working-set / evictable-set / unlimited-context enlargement calibration — phase4-logical-payload-v1 synthetic matrix (Node lane, directional)',
    scale
  },
  environment: collectEnvironmentMetadata({ command: 'pnpm bench:pinned-working-set' }),
  metrics,
  gates: [
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
      id: 'correctness.partition-sum',
      name: 'Pinned + evictable aggregate equals combined working-set aggregate (deterministic sum check, shared entities duplicated per topic)',
      kind: 'correctness',
      passed: accounting.combinedCheck,
      detail: `pinned ${accounting.pinned.aggregateBytes} + evictable ${accounting.evictable.aggregateBytes} = ${accounting.pinned.aggregateBytes + accounting.evictable.aggregateBytes}; combined ${accounting.combined.aggregateBytes} — ${accounting.combinedCheck ? 'exact match (deterministic)' : 'MISMATCH — harness fails closed'}`
    },
    {
      id: 'correctness.pinned-evictable-explicit',
      name: 'Synthetic matrix explicitly partitions pinned vs evictable sets (both non-empty, distinct prefixes)',
      kind: 'correctness',
      passed:
        accounting.pinned.topicCount === PINNED_PARTITION_CONFIG.topics &&
        accounting.evictable.topicCount === EVICTABLE_PARTITION_CONFIG.topics &&
        accounting.pinned.topicCount > 0 &&
        accounting.evictable.topicCount > 0,
      detail: `pinned ${PINNED_WORKING_SET_MATRIX_IDS.pinned}: ${accounting.pinned.topicCount} topics (${PINNED_PARTITION_CONFIG.topicPrefix}), evictable ${PINNED_WORKING_SET_MATRIX_IDS.evictable}: ${accounting.evictable.topicCount} topics (${EVICTABLE_PARTITION_CONFIG.topicPrefix}) — both synthetic, directional, non-adopting`
    },
    {
      id: 'correctness.unlimited-enlargement',
      name: 'Unlimited-context enlargement variant explicit and distinct from pinned working set (enlargement ratio finite >0, demonstrates anchor-to-end growth without truncation)',
      kind: 'correctness',
      passed:
        Number.isFinite(accounting.enlargementRatio) &&
        accounting.enlargementRatio > 1 &&
        accounting.unlimited.aggregateBytes > accounting.pinned.aggregateBytes,
      detail: `unlimited ${PINNED_WORKING_SET_MATRIX_IDS.unlimitedContextEnlargement}: ${accounting.unlimited.aggregateBytes} bytes (${UNLIMITED_CONTEXT_CONFIG.topics} topics × ${UNLIMITED_CONTEXT_CONFIG.messagesPerTopic} msgs × ${UNLIMITED_CONTEXT_CONFIG.blockContentSize} B) vs pinned ${accounting.pinned.aggregateBytes} bytes — ratio ${accounting.enlargementRatio.toFixed(3)}x (directional synthetic, not adopted window/closure bound; unlimited measured not truncated)`
    },
    {
      id: 'correctness.logical-bytes-finite',
      name: 'All logical-byte metrics finite and positive (fail-closed on invalid/non-finite)',
      kind: 'correctness',
      passed: [
        accounting.pinned.aggregateBytes,
        accounting.evictable.aggregateBytes,
        accounting.combined.aggregateBytes,
        accounting.unlimited.aggregateBytes,
        accounting.enlargementRatio
      ].every((v) => Number.isFinite(v) && v > 0),
      detail: `pinned ${accounting.pinned.aggregateBytes}, evictable ${accounting.evictable.aggregateBytes}, combined ${accounting.combined.aggregateBytes}, unlimited ${accounting.unlimited.aggregateBytes}, ratio ${accounting.enlargementRatio.toFixed(3)} — all finite positive; invalid hedged by fail-closed validation`
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

// ---------------------------------------------------------------------------
// Vitest bench tasks — tinybench measurement of canonicalization throughput
// for the pinned matrix (deterministic, not a threshold)
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
    'aggregate pinned working-set matrix (pinned+evictable+unlimited partitions)',
    () => {
      computePinnedWorkingSetAccounting()
    },
    { warmupIterations: 1, iterations: 3 }
  )
})

// File-level afterAll — artifact only after all bench tasks passed
afterAll((suite) => {
  const artifactPath = emitBenchmarkResultAfterSuccessfulTasks(suite, pinnedWorkingSetBenchmarkResult)
  if (artifactPath !== null) {
    console.log(`Result artifact: ${artifactPath}`)
  }
})
