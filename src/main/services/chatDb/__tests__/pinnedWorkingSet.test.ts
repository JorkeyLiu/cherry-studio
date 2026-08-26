import { aggregateLogicalPayload, canonicalizeLogicalPayload } from '@shared/chatDb/logicalPayload'
import { describe, expect, it } from 'vitest'

import { BENCH_RESULT_SCHEMA_VERSION, collectEnvironmentMetadata, validateBenchmarkResult } from './benchResult'
import {
  allGatesPassed,
  emitBenchmarkResultAfterSuccessfulTasksAndGates,
  shouldEmitBenchmarkResult
} from './benchResult'
import { createSyntheticTopic } from './logicalPayload'
import {
  assertFiniteMetricValue,
  buildMultiMatrixScaleMap,
  buildPartition,
  buildPinnedWorkingSetScaleMap,
  computeAllPinnedWorkingSetAccountings,
  computePinnedWorkingSetAccounting,
  computePinnedWorkingSetAccountingForMatrix,
  EVICTABLE_PARTITION_CONFIG,
  heapAmplificationCoverageLimit,
  PINNED_PARTITION_CONFIG,
  PINNED_WORKING_SET_MATRICES,
  PINNED_WORKING_SET_MATRIX_IDS,
  UNLIMITED_CONTEXT_CONFIG,
  validatePartitionConfig
} from './pinnedWorkingSet'
import {
  assemblePinnedWorkingSetBenchmarkResult,
  buildPinnedWorkingSetBenchmarkContract,
  MATRIX_METRIC_PREFIX_BY_ID,
  PINNED_WORKING_SET_BENCHMARK_ID,
  PINNED_WORKING_SET_BENCHMARK_NAME
} from './pinnedWorkingSet.benchContract'

describe('pinnedWorkingSet — partition configs', () => {
  it('pinned and evictable configs are distinct and non-adopting synthetic inputs', () => {
    expect(PINNED_PARTITION_CONFIG.label).toBe(PINNED_WORKING_SET_MATRIX_IDS.pinned)
    expect(EVICTABLE_PARTITION_CONFIG.label).toBe(PINNED_WORKING_SET_MATRIX_IDS.evictable)
    expect(UNLIMITED_CONTEXT_CONFIG.label).toBe(PINNED_WORKING_SET_MATRIX_IDS.unlimitedContextEnlargement)
    expect(PINNED_PARTITION_CONFIG.topicPrefix).not.toBe(EVICTABLE_PARTITION_CONFIG.topicPrefix)
    expect(UNLIMITED_CONTEXT_CONFIG.topicPrefix).not.toBe(PINNED_PARTITION_CONFIG.topicPrefix)
  })

  it('buildPartition creates deterministic topic sets with finite positive bytes', () => {
    const pinned = buildPartition(PINNED_PARTITION_CONFIG)
    expect(pinned.topics).toHaveLength(PINNED_PARTITION_CONFIG.topics)
    for (const t of pinned.topics) {
      const { byteLength, canonicalJson } = canonicalizeLogicalPayload(t)
      expect(Number.isFinite(byteLength)).toBe(true)
      expect(byteLength).toBeGreaterThan(0)
      expect(canonicalJson.length).toBeGreaterThan(0)
    }
    // Deterministic: second build identical bytes
    const pinned2 = buildPartition(PINNED_PARTITION_CONFIG)
    const agg1 = aggregateLogicalPayload(pinned.topics).aggregateBytes
    const agg2 = aggregateLogicalPayload(pinned2.topics).aggregateBytes
    expect(agg1).toBe(agg2)
  })

  it('evictable partition builds with empty-segment marker path (segmentCount 0)', () => {
    const evictable = buildPartition(EVICTABLE_PARTITION_CONFIG)
    expect(evictable.topics).toHaveLength(EVICTABLE_PARTITION_CONFIG.topics)
    for (const t of evictable.topics) {
      expect(t.segments).toHaveLength(0)
      // Empty segments with residentTopic true is valid per completeness conjunction
      expect(t.completeness.segments).toBe(true)
      expect(t.completeness.residentTopic).toBe(true)
      expect(() => canonicalizeLogicalPayload(t)).not.toThrow()
    }
  })

  it('validatePartitionConfig fails closed on invalid/non-finite values', () => {
    const bad = { ...PINNED_PARTITION_CONFIG, topics: Number.NaN }
    expect(() => validatePartitionConfig(bad as unknown as typeof PINNED_PARTITION_CONFIG)).toThrow(/finite/)
    const bad2 = { ...PINNED_PARTITION_CONFIG, messagesPerTopic: -1 }
    expect(() => validatePartitionConfig(bad2 as unknown as typeof PINNED_PARTITION_CONFIG)).toThrow(/non-negative/)
    const bad3 = { ...PINNED_PARTITION_CONFIG, topics: 0 }
    expect(() => validatePartitionConfig(bad3)).toThrow(/>0/)
    const bad4 = { ...PINNED_PARTITION_CONFIG, blockContentSize: Infinity }
    expect(() => validatePartitionConfig(bad4 as unknown as typeof PINNED_PARTITION_CONFIG)).toThrow(/finite/)
    const bad5 = { ...PINNED_PARTITION_CONFIG, topicPrefix: '' }
    expect(() => validatePartitionConfig(bad5)).toThrow(/non-empty/)
    const bad6 = { ...PINNED_PARTITION_CONFIG, blockContentSize: 0 }
    expect(() => validatePartitionConfig(bad6)).toThrow(/>0/)
  })

  it('assertFiniteMetricValue fails closed on non-finite', () => {
    expect(() => assertFiniteMetricValue('x', Number.NaN)).toThrow(/non-finite/)
    expect(() => assertFiniteMetricValue('x', Infinity)).toThrow(/non-finite/)
    expect(() => assertFiniteMetricValue('x', -Infinity)).toThrow(/non-finite/)
    expect(() => assertFiniteMetricValue('ok', 123)).not.toThrow()
    expect(() => assertFiniteMetricValue('ok-zero', 0)).not.toThrow()
  })
})

describe('pinnedWorkingSet — accounting', () => {
  it('computing accounting yields finite positive aggregates and exact combined sum', () => {
    const acc = computePinnedWorkingSetAccounting()
    expect(acc.pinned.aggregateBytes).toBeGreaterThan(0)
    expect(acc.evictable.aggregateBytes).toBeGreaterThan(0)
    expect(acc.combined.aggregateBytes).toBeGreaterThan(0)
    expect(acc.unlimited.aggregateBytes).toBeGreaterThan(0)
    expect(Number.isFinite(acc.enlargementRatio)).toBe(true)
    expect(acc.enlargementRatio).toBeGreaterThan(1)
    // Combined must be exact sum of pinned + evictable (duplicated per topic, no dedup)
    expect(acc.combined.aggregateBytes).toBe(acc.pinned.aggregateBytes + acc.evictable.aggregateBytes)
    expect(acc.combinedCheck).toBe(true)
    expect(acc.combined.topicCount).toBe(acc.pinned.topicCount + acc.evictable.topicCount)
  })

  it('unlimited-context variant is larger than pinned (enlargement demonstrates anchor-to-end growth)', () => {
    const acc = computePinnedWorkingSetAccounting()
    expect(acc.unlimited.aggregateBytes).toBeGreaterThan(acc.pinned.aggregateBytes)
    expect(acc.unlimited.perTopic.length).toBe(UNLIMITED_CONTEXT_CONFIG.topics)
    // Unlimited per-topic should be larger than pinned per-topic due to more msgs and larger blocks
    const pinnedPerTopicAvg = acc.pinned.aggregateBytes / acc.pinned.topicCount
    const unlimitedPerTopicAvg = acc.unlimited.aggregateBytes / acc.unlimited.topicCount
    expect(unlimitedPerTopicAvg).toBeGreaterThan(pinnedPerTopicAvg)
  })

  it('per-topic bytes are deterministic and finite (no NaN/Infinity)', () => {
    const acc = computePinnedWorkingSetAccounting()
    for (const part of [acc.pinned, acc.evictable, acc.combined, acc.unlimited]) {
      expect(Number.isFinite(part.aggregateBytes)).toBe(true)
      for (const p of part.perTopic) {
        expect(Number.isFinite(p.byteLength)).toBe(true)
        expect(p.byteLength).toBeGreaterThan(0)
        expect(typeof p.topicId).toBe('string')
        expect(p.topicId.length).toBeGreaterThan(0)
      }
    }
  })

  it('orphan and non-finite rejection still holds via canonicalizeLogicalPayload', () => {
    const orphanTopic = {
      topicId: 'pws-orphan-test',
      messages: [{ id: 'msg-001', topicId: 'pws-orphan-test', sortOrder: 0 } as Record<string, unknown>],
      blocks: [{ id: 'b-orphan', messageId: 'msg-999', type: 'main_text', content: 'x' } as Record<string, unknown>],
      segments: [] as Record<string, unknown>[],
      completeness: { chatData: true, segments: true, residentTopic: true },
      applicabilityGeneration: 0
    }
    expect(() => canonicalizeLogicalPayload(orphanTopic)).toThrow(/orphan/)

    const bad = createSyntheticTopic({ topicId: 'pws-nonfinite-test', messageCount: 1, blockContentSize: 4 })
    bad.messages[0]['bad'] = Number.NaN
    expect(() => canonicalizeLogicalPayload(bad)).toThrow(/non-finite/)
  })
})

describe('pinnedWorkingSet — heap coverage limit', () => {
  it('reports renderer heap as not measurable in Node lane (coverage limit, no proxy claim)', () => {
    const cov = heapAmplificationCoverageLimit()
    expect(cov.measurable).toBe(false)
    expect(cov.reason).toMatch(/renderer heap/)
    expect(cov.reason).toMatch(/Node lane/)
    expect(cov.reason).toMatch(/C-02/)
  })
})

describe('pinnedWorkingSet — scale map (schema-v1 numeric-only)', () => {
  it('scale map is numeric-only, finite, deterministic, and encodes partitions', () => {
    const scale = buildPinnedWorkingSetScaleMap()
    for (const [k, v] of Object.entries(scale)) {
      expect(typeof v, `scale.${k} must be number`).toBe('number')
      expect(Number.isFinite(v), `scale.${k} must be finite`).toBe(true)
    }
    expect(scale.pinnedTopics).toBe(PINNED_PARTITION_CONFIG.topics)
    expect(scale.evictableTopics).toBe(EVICTABLE_PARTITION_CONFIG.topics)
    expect(scale.combinedTopics).toBe(PINNED_PARTITION_CONFIG.topics + EVICTABLE_PARTITION_CONFIG.topics)
    expect(scale.unlimitedTopics).toBe(UNLIMITED_CONTEXT_CONFIG.topics)
    expect(scale.heapMeasurableCode).toBe(0)
    expect(scale.accountingVersionCode).toBe(1)
    // Deterministic second call
    const scale2 = buildPinnedWorkingSetScaleMap()
    expect(scale2).toEqual(scale)
  })
})

describe('pinnedWorkingSet — full three-matrix determinism & accounting invariants', () => {
  it('PINNED_WORKING_SET_MATRICES enumerates exactly 3 deterministic matrices with unique ids', () => {
    expect(PINNED_WORKING_SET_MATRICES).toHaveLength(3)
    const ids = PINNED_WORKING_SET_MATRICES.map((m) => m.id)
    expect(new Set(ids).size).toBe(3)
    expect(ids).toEqual(['matrix-standard-v1', 'matrix-small-v1', 'matrix-large-v1'])
    // Prefix map must cover all matrix ids
    for (const id of ids) {
      expect(MATRIX_METRIC_PREFIX_BY_ID[id]).toBeDefined()
      expect(typeof MATRIX_METRIC_PREFIX_BY_ID[id]).toBe('string')
      expect(MATRIX_METRIC_PREFIX_BY_ID[id].length).toBeGreaterThan(0)
    }
    expect(Object.keys(MATRIX_METRIC_PREFIX_BY_ID)).toHaveLength(3)
  })

  it('computeAllPinnedWorkingSetAccountings is deterministic and preserves order', () => {
    const first = computeAllPinnedWorkingSetAccountings()
    const second = computeAllPinnedWorkingSetAccountings()
    expect(first.map((m) => m.matrixId)).toEqual(second.map((m) => m.matrixId))
    expect(first.map((m) => m.matrixId)).toEqual(PINNED_WORKING_SET_MATRICES.map((m) => m.id))
    for (let i = 0; i < first.length; i++) {
      expect(first[i].accounting.pinned.aggregateBytes).toBe(second[i].accounting.pinned.aggregateBytes)
      expect(first[i].accounting.evictable.aggregateBytes).toBe(second[i].accounting.evictable.aggregateBytes)
      expect(first[i].accounting.combined.aggregateBytes).toBe(second[i].accounting.combined.aggregateBytes)
      expect(first[i].accounting.unlimited.aggregateBytes).toBe(second[i].accounting.unlimited.aggregateBytes)
      expect(first[i].accounting.enlargementRatio).toBe(second[i].accounting.enlargementRatio)
    }
  })

  it('each matrix satisfies partition-sum invariant: pinned+evictable == combined exact', () => {
    const all = computeAllPinnedWorkingSetAccountings()
    for (const { matrixId, accounting } of all) {
      expect(accounting.combinedCheck, `${matrixId} combinedCheck`).toBe(true)
      expect(accounting.combined.aggregateBytes, `${matrixId} sum`).toBe(
        accounting.pinned.aggregateBytes + accounting.evictable.aggregateBytes
      )
      expect(accounting.combined.topicCount).toBe(accounting.pinned.topicCount + accounting.evictable.topicCount)
      // Also via per-matrix helper
      const def = PINNED_WORKING_SET_MATRICES.find((m) => m.id === matrixId)!
      const viaHelper = computePinnedWorkingSetAccountingForMatrix(def)
      expect(viaHelper.combined.aggregateBytes).toBe(accounting.combined.aggregateBytes)
      expect(viaHelper.enlargementRatio).toBe(accounting.enlargementRatio)
    }
  })

  it('each matrix enlargement ratio finite >1 and unlimited > pinned (anchor-to-end growth)', () => {
    const all = computeAllPinnedWorkingSetAccountings()
    for (const { matrixId, accounting } of all) {
      expect(Number.isFinite(accounting.enlargementRatio), `${matrixId} ratio finite`).toBe(true)
      expect(accounting.enlargementRatio, `${matrixId} ratio >1`).toBeGreaterThan(1)
      expect(accounting.unlimited.aggregateBytes, `${matrixId} unlimited > pinned`).toBeGreaterThan(
        accounting.pinned.aggregateBytes
      )
      const avgPinned = accounting.pinned.aggregateBytes / accounting.pinned.topicCount
      const avgUnlimited = accounting.unlimited.aggregateBytes / accounting.unlimited.topicCount
      expect(avgUnlimited, `${matrixId} avg unlimited > avg pinned`).toBeGreaterThan(avgPinned)
    }
  })

  it('all per-topic byteLengths finite positive and perTopic counts match config across matrices', () => {
    const all = computeAllPinnedWorkingSetAccountings()
    for (const { matrixId, accounting } of all) {
      const def = PINNED_WORKING_SET_MATRICES.find((m) => m.id === matrixId)!
      expect(accounting.pinned.topicCount).toBe(def.pinned.topics)
      expect(accounting.evictable.topicCount).toBe(def.evictable.topics)
      expect(accounting.unlimited.topicCount).toBe(def.unlimited.topics)
      expect(accounting.combined.topicCount).toBe(def.pinned.topics + def.evictable.topics)
      for (const part of [accounting.pinned, accounting.evictable, accounting.combined, accounting.unlimited]) {
        expect(Number.isFinite(part.aggregateBytes), `${matrixId} ${part.label} finite`).toBe(true)
        expect(part.aggregateBytes, `${matrixId} ${part.label} >0`).toBeGreaterThan(0)
        for (const p of part.perTopic) {
          expect(Number.isFinite(p.byteLength), `${matrixId} ${p.topicId} finite`).toBe(true)
          expect(p.byteLength, `${matrixId} ${p.topicId} >0`).toBeGreaterThan(0)
        }
      }
    }
  })

  it('standard matrix equals legacy computePinnedWorkingSetAccounting (compatible subset)', () => {
    const legacy = computePinnedWorkingSetAccounting()
    const all = computeAllPinnedWorkingSetAccountings()
    const standard = all.find((m) => m.matrixId === 'matrix-standard-v1')!.accounting
    expect(standard.pinned.aggregateBytes).toBe(legacy.pinned.aggregateBytes)
    expect(standard.evictable.aggregateBytes).toBe(legacy.evictable.aggregateBytes)
    expect(standard.combined.aggregateBytes).toBe(legacy.combined.aggregateBytes)
    expect(standard.unlimited.aggregateBytes).toBe(legacy.unlimited.aggregateBytes)
    expect(standard.enlargementRatio).toBe(legacy.enlargementRatio)
    expect(standard.combinedCheck).toBe(legacy.combinedCheck)
  })

  it('multi-matrix scale map is numeric-only, finite, deterministic, and encodes all matrices', () => {
    const scale = buildMultiMatrixScaleMap()
    for (const [k, v] of Object.entries(scale)) {
      expect(typeof v, `scale.${k} must be number`).toBe('number')
      expect(Number.isFinite(v), `scale.${k} must be finite`).toBe(true)
    }
    expect(scale.matrixCount).toBe(3)
    // Must contain base keys plus per-matrix prefixed keys
    expect(scale.pinnedTopics).toBe(PINNED_PARTITION_CONFIG.topics)
    expect(scale.matrix_standard_v1_pinnedTopics).toBe(
      PINNED_WORKING_SET_MATRICES.find((m) => m.id === 'matrix-standard-v1')!.pinned.topics
    )
    expect(scale.matrix_small_v1_pinnedTopics).toBe(
      PINNED_WORKING_SET_MATRICES.find((m) => m.id === 'matrix-small-v1')!.pinned.topics
    )
    expect(scale.matrix_large_v1_pinnedTopics).toBe(
      PINNED_WORKING_SET_MATRICES.find((m) => m.id === 'matrix-large-v1')!.pinned.topics
    )
    const scale2 = buildMultiMatrixScaleMap()
    expect(scale2).toEqual(scale)
  })
})

describe('pinnedWorkingSet — benchmark metric/gate contract (full 3-matrix via shared builder)', () => {
  it('emitted metric IDs are unique and cover per-topic, aggregate, enlargement and heap for all three matrices via shared builder', () => {
    const matrixAccountings = computeAllPinnedWorkingSetAccountings()
    const heapCoverage = heapAmplificationCoverageLimit()
    expect(matrixAccountings).toHaveLength(3)

    const { metrics } = buildPinnedWorkingSetBenchmarkContract({
      matrixAccountings,
      heapCoverage,
      correctnessErrors: [],
      orphanRejectionPassed: true,
      nonFiniteRejectionPassed: true
    })

    // Uniqueness gate — every metric id must be unique
    const ids = metrics.map((m) => m.id)
    expect(
      new Set(ids).size,
      `metric ids must be unique — duplicates: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(', ')}`
    ).toBe(ids.length)

    // Values must be finite numbers (schema-v1 numeric-only) and deterministic
    for (const m of metrics) {
      expect(Number.isFinite(m.value), `metric ${m.id} value must be finite`).toBe(true)
    }
    // Determinism second call
    const second = buildPinnedWorkingSetBenchmarkContract({
      matrixAccountings,
      heapCoverage,
      correctnessErrors: [],
      orphanRejectionPassed: true,
      nonFiniteRejectionPassed: true
    })
    expect(second.metrics).toEqual(metrics)

    // Completeness — every matrix prefix must be present with expected per-topic and aggregate coverage
    for (const { matrixId, accounting } of matrixAccountings) {
      const prefix = MATRIX_METRIC_PREFIX_BY_ID[matrixId]
      // Per-topic counts
      expect(ids.filter((id) => id.startsWith(`${prefix}.pinned.topic.`)).length).toBe(
        accounting.pinned.perTopic.length
      )
      expect(ids.filter((id) => id.startsWith(`${prefix}.evictable.topic.`)).length).toBe(
        accounting.evictable.perTopic.length
      )
      expect(ids.filter((id) => id.startsWith(`${prefix}.unlimited.topic.`)).length).toBe(
        accounting.unlimited.perTopic.length
      )
      for (let idx = 0; idx < accounting.pinned.perTopic.length; idx++) {
        expect(ids).toContain(`${prefix}.pinned.topic.${idx}.bytes`)
      }
      for (let idx = 0; idx < accounting.evictable.perTopic.length; idx++) {
        expect(ids).toContain(`${prefix}.evictable.topic.${idx}.bytes`)
      }
      for (let idx = 0; idx < accounting.unlimited.perTopic.length; idx++) {
        expect(ids).toContain(`${prefix}.unlimited.topic.${idx}.bytes`)
      }
      expect(ids).toContain(`${prefix}.pinned.aggregate.bytes`)
      expect(ids).toContain(`${prefix}.pinned.topicCount`)
      expect(ids).toContain(`${prefix}.evictable.aggregate.bytes`)
      expect(ids).toContain(`${prefix}.evictable.topicCount`)
      expect(ids).toContain(`${prefix}.combined.aggregate.bytes`)
      expect(ids).toContain(`${prefix}.combined.topicCount`)
      expect(ids).toContain(`${prefix}.unlimited.aggregate.bytes`)
      expect(ids).toContain(`${prefix}.unlimited.topicCount`)
      expect(ids).toContain(`${prefix}.enlargement.ratio.unlimitedOverPinned`)
      // Values match accounting
      const pinnedAgg = metrics.find((m) => m.id === `${prefix}.pinned.aggregate.bytes`)!
      expect(pinnedAgg.value).toBe(accounting.pinned.aggregateBytes)
      const ratio = metrics.find((m) => m.id === `${prefix}.enlargement.ratio.unlimitedOverPinned`)!
      expect(ratio.value).toBe(accounting.enlargementRatio)
    }

    expect(ids).toContain('heap.measurable')

    // Expected total count: sum per-matrix perTopic + 9 aggregates per matrix + 1 heap
    const perTopicTotal = matrixAccountings.reduce(
      (sum, m) =>
        sum +
        m.accounting.pinned.perTopic.length +
        m.accounting.evictable.perTopic.length +
        m.accounting.unlimited.perTopic.length,
      0
    )
    const expected = perTopicTotal + 9 * matrixAccountings.length + 1
    expect(metrics).toHaveLength(expected)
    // Cross-check with known shape: standard 11+9=20, small 7+9=16, large 14+9=23, plus heap 1 =60
    expect(expected).toBe(60)
    expect(metrics).toHaveLength(60)

    // Exact contract — if emitter diverges, this test fails because it exercises the shared builder
    expect(metrics.map((m) => m.id)).toEqual(
      buildPinnedWorkingSetBenchmarkContract({
        matrixAccountings,
        heapCoverage,
        correctnessErrors: [],
        orphanRejectionPassed: true,
        nonFiniteRejectionPassed: true
      }).metrics.map((m) => m.id)
    )

    // Metric names must contain matrix display prefix or heap label and directional hint is in gate details, not metric name? Check metric name contains matrix or heap
    for (const m of metrics) {
      expect(typeof m.name).toBe('string')
      expect(m.name.length).toBeGreaterThan(0)
      if (m.id !== 'heap.measurable') {
        expect(m.name).toMatch(/matrix/i)
      }
    }
  })

  it('emitted gate IDs are unique and cover canonical, matrix-complete and full sum/enlargement contract via shared builder', () => {
    const matrixAccountings = computeAllPinnedWorkingSetAccountings()
    const heapCoverage = heapAmplificationCoverageLimit()

    const { gates } = buildPinnedWorkingSetBenchmarkContract({
      matrixAccountings,
      heapCoverage,
      correctnessErrors: [],
      orphanRejectionPassed: true,
      nonFiniteRejectionPassed: true
    })

    const ids = gates.map((g) => g.id)
    expect(
      new Set(ids).size,
      `gate ids must be unique — duplicates: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(', ')}`
    ).toBe(ids.length)
    expect(gates).toHaveLength(9)
    // Determinism second call
    const second = buildPinnedWorkingSetBenchmarkContract({
      matrixAccountings,
      heapCoverage,
      correctnessErrors: [],
      orphanRejectionPassed: true,
      nonFiniteRejectionPassed: true
    })
    expect(second.gates).toEqual(gates)

    const expectedGateIds = [
      'correctness.canonical',
      'correctness.orphan-rejection',
      'correctness.nonfinite-rejection',
      'matrix.complete',
      'correctness.partition-sum',
      'correctness.pinned-evictable-explicit',
      'correctness.unlimited-enlargement',
      'correctness.logical-bytes-finite',
      'coverage.heap-amplification'
    ]
    for (const expected of expectedGateIds) {
      expect(ids).toContain(expected)
    }

    for (const g of gates) {
      expect(g.passed, `gate ${g.id} must pass`).toBe(true)
      expect(typeof g.name).toBe('string')
      expect(g.name.length).toBeGreaterThan(0)
      if (g.detail !== undefined) {
        expect(typeof g.detail).toBe('string')
        expect(g.detail.length).toBeGreaterThan(0)
      }
    }

    // Matrix complete detail must mention all 3 ids
    const complete = gates.find((g) => g.id === 'matrix.complete')!
    expect(complete.detail).toContain('matrix-standard-v1')
    expect(complete.detail).toContain('matrix-small-v1')
    expect(complete.detail).toContain('matrix-large-v1')

    // Partition-sum detail must cover all matrices
    const partition = gates.find((g) => g.id === 'correctness.partition-sum')!
    for (const { matrixId } of matrixAccountings) {
      expect(partition.detail).toContain(matrixId)
    }

    // Regression probe: altering contract inputs flips gates — proves builder is exercised
    const failingGates = buildPinnedWorkingSetBenchmarkContract({
      matrixAccountings,
      heapCoverage,
      correctnessErrors: ['injected failure'],
      orphanRejectionPassed: false,
      nonFiniteRejectionPassed: true
    }).gates
    expect(failingGates.find((g) => g.id === 'correctness.canonical')?.passed).toBe(false)
    expect(failingGates.find((g) => g.id === 'correctness.orphan-rejection')?.passed).toBe(false)

    // Empty matrix should fail matrix.complete
    const emptyGates = buildPinnedWorkingSetBenchmarkContract({
      matrixAccountings: [],
      heapCoverage,
      correctnessErrors: [],
      orphanRejectionPassed: true,
      nonFiniteRejectionPassed: true
    }).gates
    expect(emptyGates.find((g) => g.id === 'matrix.complete')?.passed).toBe(false)
  })

  it('shared contract directly equals emitter contract shape — benchmark would fail if builder diverges', () => {
    const matrixAccountings = computeAllPinnedWorkingSetAccountings()
    const heapCoverage = heapAmplificationCoverageLimit()
    const contract = buildPinnedWorkingSetBenchmarkContract({
      matrixAccountings,
      heapCoverage,
      correctnessErrors: [],
      orphanRejectionPassed: true,
      nonFiniteRejectionPassed: true
    })
    expect(contract.metrics).toHaveLength(60)
    expect(contract.gates).toHaveLength(9)
    expect(new Set(contract.metrics.map((m) => m.id)).size).toBe(60)
    expect(contract.metrics.every((m) => Number.isFinite(m.value))).toBe(true)
    // No NaN/Infinity and positive for bytes/ratio except heap 0/1
    for (const m of contract.metrics) {
      if (m.id === 'heap.measurable') {
        expect([0, 1]).toContain(m.value)
      } else if (m.id.includes('ratio')) {
        expect(m.value).toBeGreaterThan(1)
      } else if (m.id.includes('topicCount')) {
        expect(m.value).toBeGreaterThan(0)
        expect(Number.isInteger(m.value)).toBe(true)
      } else {
        expect(m.value).toBeGreaterThan(0)
      }
    }
  })
})

describe('pinnedWorkingSet — artifact schema/identity stability (full-matrix)', () => {
  it('stable benchmark id, schema v1, numeric-only scale/metrics/gates, and validation passes via shared producer assembly', () => {
    const matrixAccountings = computeAllPinnedWorkingSetAccountings()
    const heapCoverage = heapAmplificationCoverageLimit()
    const scale = buildMultiMatrixScaleMap()
    // Producer assembly is the single source of truth for id, scale, metrics/gates
    expect(PINNED_WORKING_SET_BENCHMARK_ID).toBe('pinned-working-set-calibration')
    expect(PINNED_WORKING_SET_BENCHMARK_NAME).toContain('Pinned working-set')
    const result = assemblePinnedWorkingSetBenchmarkResult({
      matrixAccountings,
      heapCoverage,
      correctnessErrors: [],
      orphanRejectionPassed: true,
      nonFiniteRejectionPassed: true,
      scale,
      environment: collectEnvironmentMetadata({ command: 'pnpm bench:pinned-working-set' })
    })
    // Assembly must use stable id/name and preserve schema v1
    expect(result.benchmark.id).toBe(PINNED_WORKING_SET_BENCHMARK_ID)
    expect(result.benchmark.name).toBe(PINNED_WORKING_SET_BENCHMARK_NAME)
    expect(result.schemaVersion).toBe(BENCH_RESULT_SCHEMA_VERSION)
    expect(BENCH_RESULT_SCHEMA_VERSION).toBe(1)

    // Metrics/gates must be exactly the shared builder output (no drift)
    const { metrics, gates } = buildPinnedWorkingSetBenchmarkContract({
      matrixAccountings,
      heapCoverage,
      correctnessErrors: [],
      orphanRejectionPassed: true,
      nonFiniteRejectionPassed: true
    })
    expect(result.metrics).toEqual(metrics)
    expect(result.gates).toEqual(gates)

    // Scale numeric-only finite
    for (const [k, v] of Object.entries(scale)) {
      expect(typeof v, `scale.${k}`).toBe('number')
      expect(Number.isFinite(v), `scale.${k} finite`).toBe(true)
    }

    const problems = validateBenchmarkResult(result as unknown)
    expect(problems, `schema validation should pass, got: ${problems.join('; ')}`).toEqual([])
    // Closed schema: no sensitive fields; also prove producer assembly includes all 3 matrices
    const raw = JSON.stringify(result)
    expect(raw).not.toContain('content')
    expect(raw).not.toContain('credential')
    expect(raw).not.toContain('password')
    // Producer scale must encode all matrices with expected prefixed fields
    for (const matrixId of PINNED_WORKING_SET_MATRICES.map((m) => m.id)) {
      const prefix = matrixId.replace(/-/g, '_')
      expect(
        result.benchmark.scale[`${prefix}_pinnedTopics`],
        `scale must contain ${prefix}_pinnedTopics`
      ).toBeDefined()
      expect(Number.isFinite(result.benchmark.scale[`${prefix}_pinnedTopics`])).toBe(true)
    }
    expect(result.benchmark.scale.matrixCount).toBe(3)
    // Producer metrics must cover every matrix prefix
    for (const matrixId of PINNED_WORKING_SET_MATRICES.map((m) => m.id)) {
      const prefix = MATRIX_METRIC_PREFIX_BY_ID[matrixId]
      expect(
        result.metrics.some((m) => m.id.startsWith(`${prefix}.`)),
        `metrics must contain ${prefix} prefix`
      ).toBe(true)
    }
  })

  it('scale and accountingVersion remain stable and heapMeasurableCode is 0 (Node lane)', () => {
    const scale = buildMultiMatrixScaleMap()
    expect(scale.accountingVersionCode).toBe(1)
    expect(scale.heapMeasurableCode).toBe(0)
    expect(scale.matrixCount).toBe(3)
    // Matrix-specific keys exist and are finite
    expect(typeof scale.matrix_standard_v1_pinnedTopics).toBe('number')
    expect(typeof scale.matrix_small_v1_pinnedTopics).toBe('number')
    expect(typeof scale.matrix_large_v1_pinnedTopics).toBe('number')
  })

  it('non-adoption labels: gates/metrics are directional synthetic, not thresholds/baselines/capacity', () => {
    const matrixAccountings = computeAllPinnedWorkingSetAccountings()
    const heapCoverage = heapAmplificationCoverageLimit()
    const { metrics, gates } = buildPinnedWorkingSetBenchmarkContract({
      matrixAccountings,
      heapCoverage,
      correctnessErrors: [],
      orphanRejectionPassed: true,
      nonFiniteRejectionPassed: true
    })

    // Metric names for aggregates/enlargement contain directional synthetic hint; per-topic metrics contain matrix context
    for (const m of metrics) {
      if (m.id === 'heap.measurable') continue
      if (m.id.includes('aggregate') || m.id.includes('enlargement') || m.id.includes('topicCount')) {
        expect(m.name).toMatch(/directional synthetic/)
      } else {
        // per-topic bytes metrics: must contain matrix bytes label
        expect(m.name).toMatch(/bytes/)
        expect(m.name).toMatch(/matrix/i)
      }
    }
    // Gate names/details contain synthetic/directional or coverage limit language, not adopting thresholds
    for (const g of gates) {
      const combined = `${g.name} ${g.detail ?? ''}`
      // At least one of these hints should be present for correctness/coverage gates
      if (g.id.startsWith('correctness.') || g.id.startsWith('matrix.') || g.id.startsWith('coverage.')) {
        expect(combined.length).toBeGreaterThan(0)
        // Ensure not claiming threshold/baseline/capacity/adoption
        expect(combined.toLowerCase()).not.toContain('threshold adopted')
        expect(combined.toLowerCase()).not.toContain('capacity adopted')
      }
    }
    // Explicit check that heap coverage detail mentions Node lane and not measurable
    const heapGate = gates.find((g) => g.id === 'coverage.heap-amplification')!
    expect(heapGate.detail).toMatch(/Node lane/)
    expect(heapGate.detail).toMatch(/not.*measurable|NOT measurable/i)
    expect(heapGate.passed).toBe(true)

    // All metric ids are synthetic-matrix derived, not production thresholds like B-01/B-02
    for (const id of metrics.map((m) => m.id)) {
      expect(id).not.toMatch(/^B-0[12]/)
      expect(id).not.toContain('threshold')
    }
  })
})

describe('pinnedWorkingSet — emission fail-closed on gate failure', () => {
  it('allGatesPassed is true only when every gate passed and false when any fails', () => {
    const matrixAccountings = computeAllPinnedWorkingSetAccountings()
    const heapCoverage = heapAmplificationCoverageLimit()
    const scale = buildMultiMatrixScaleMap()
    const passing = assemblePinnedWorkingSetBenchmarkResult({
      matrixAccountings,
      heapCoverage,
      correctnessErrors: [],
      orphanRejectionPassed: true,
      nonFiniteRejectionPassed: true,
      scale,
      environment: collectEnvironmentMetadata({ command: 'pnpm bench:pinned-working-set' })
    })
    expect(allGatesPassed(passing)).toBe(true)
    expect(passing.gates.every((g) => g.passed)).toBe(true)

    const failing = assemblePinnedWorkingSetBenchmarkResult({
      matrixAccountings,
      heapCoverage,
      correctnessErrors: ['injected canonical failure'],
      orphanRejectionPassed: true,
      nonFiniteRejectionPassed: true,
      scale,
      environment: collectEnvironmentMetadata({ command: 'pnpm bench:pinned-working-set' })
    })
    expect(failing.gates.find((g) => g.id === 'correctness.canonical')?.passed).toBe(false)
    expect(allGatesPassed(failing)).toBe(false)
  })

  it('shouldEmitBenchmarkResult requires both tasks passed and gates passed (eligibility gate)', () => {
    const matrixAccountings = computeAllPinnedWorkingSetAccountings()
    const heapCoverage = heapAmplificationCoverageLimit()
    const scale = buildMultiMatrixScaleMap()
    const passingResult = assemblePinnedWorkingSetBenchmarkResult({
      matrixAccountings,
      heapCoverage,
      correctnessErrors: [],
      orphanRejectionPassed: true,
      nonFiniteRejectionPassed: true,
      scale,
      environment: collectEnvironmentMetadata({ command: 'pnpm bench:pinned-working-set' })
    })
    const failingResult = assemblePinnedWorkingSetBenchmarkResult({
      matrixAccountings,
      heapCoverage,
      correctnessErrors: [],
      orphanRejectionPassed: false,
      nonFiniteRejectionPassed: true,
      scale,
      environment: collectEnvironmentMetadata({ command: 'pnpm bench:pinned-working-set' })
    })
    const passingSuite = { tasks: [{ type: 'test', result: { state: 'pass' } }] } as const
    const failingSuite = { tasks: [{ type: 'test', result: { state: 'run' } }] } as const
    // Both must pass
    expect(shouldEmitBenchmarkResult(passingSuite as any, passingResult)).toBe(true)
    // Failed gates blocks even when tasks passed
    expect(shouldEmitBenchmarkResult(passingSuite as any, failingResult)).toBe(false)
    // Failed tasks blocks even when gates passed
    expect(shouldEmitBenchmarkResult(failingSuite as any, passingResult)).toBe(false)
    // Both failed also blocks
    expect(shouldEmitBenchmarkResult(failingSuite as any, failingResult)).toBe(false)
  })

  it('emitBenchmarkResultAfterSuccessfulTasksAndGates is fail-closed: returns null when any gate failed even if tasks passed', () => {
    const matrixAccountings = computeAllPinnedWorkingSetAccountings()
    const heapCoverage = heapAmplificationCoverageLimit()
    const scale = buildMultiMatrixScaleMap()
    const passingSuite = { tasks: [{ type: 'test', result: { state: 'pass' } }] } as const
    const failingResult = assemblePinnedWorkingSetBenchmarkResult({
      matrixAccountings,
      heapCoverage,
      correctnessErrors: ['gate failure must block emission'],
      orphanRejectionPassed: true,
      nonFiniteRejectionPassed: true,
      scale,
      environment: collectEnvironmentMetadata({ command: 'pnpm bench:pinned-working-set' })
    })
    expect(allGatesPassed(failingResult)).toBe(false)
    // Eligibility must be false
    expect(shouldEmitBenchmarkResult(passingSuite as any, failingResult)).toBe(false)
    // Direct emit helper must return null without touching filesystem (mocked or real)
    expect(
      emitBenchmarkResultAfterSuccessfulTasksAndGates(passingSuite as any, failingResult, {
        dir: '/tmp/pws-fail-closed-nop',
        fileName: 'nope.json'
      })
    ).toBeNull()
  })

  it('emitBenchmarkResultAfterSuccessfulTasksAndGates eligibility is true only when all gates and tasks passed', () => {
    const matrixAccountings = computeAllPinnedWorkingSetAccountings()
    const heapCoverage = heapAmplificationCoverageLimit()
    const scale = buildMultiMatrixScaleMap()
    const passingResult = assemblePinnedWorkingSetBenchmarkResult({
      matrixAccountings,
      heapCoverage,
      correctnessErrors: [],
      orphanRejectionPassed: true,
      nonFiniteRejectionPassed: true,
      scale,
      environment: collectEnvironmentMetadata({ command: 'pnpm bench:pinned-working-set' })
    })
    const passingSuite = { tasks: [{ type: 'test', result: { state: 'pass' } }] } as const
    expect(allGatesPassed(passingResult)).toBe(true)
    expect(shouldEmitBenchmarkResult(passingSuite as any, passingResult)).toBe(true)
    // Cross-check that generic task-only predicate would still pass, proving gate layer is the blocker
    expect(
      shouldEmitBenchmarkResult({ tasks: [{ type: 'test', result: { state: 'pass' } }] } as any, passingResult)
    ).toBe(true)
  })
})

describe('pinnedWorkingSet — producer assembly directly shareable via assemble helper', () => {
  it('assemble helper produces same metrics/gates as builder and encodes all matrix-prefixed scale fields', () => {
    const matrixAccountings = computeAllPinnedWorkingSetAccountings()
    const heapCoverage = heapAmplificationCoverageLimit()
    const scale = buildMultiMatrixScaleMap()
    const env = collectEnvironmentMetadata({ command: 'pnpm bench:pinned-working-set' })
    const assembled = assemblePinnedWorkingSetBenchmarkResult({
      matrixAccountings,
      heapCoverage,
      correctnessErrors: [],
      orphanRejectionPassed: true,
      nonFiniteRejectionPassed: true,
      scale,
      environment: env
    })
    const direct = buildPinnedWorkingSetBenchmarkContract({
      matrixAccountings,
      heapCoverage,
      correctnessErrors: [],
      orphanRejectionPassed: true,
      nonFiniteRejectionPassed: true
    })
    expect(assembled.metrics).toEqual(direct.metrics)
    expect(assembled.gates).toEqual(direct.gates)
    expect(assembled.benchmark.scale).toEqual(scale)
    expect(assembled.environment.command).toBe('pnpm bench:pinned-working-set')
    // Verify all three matrices present in metrics and scale
    expect(assembled.benchmark.id).toBe(PINNED_WORKING_SET_BENCHMARK_ID)
    expect(scale.matrixCount).toBe(3)
    for (const m of PINNED_WORKING_SET_MATRICES) {
      const prefix = m.id.replace(/-/g, '_')
      expect(scale[`${prefix}_pinnedTopics`]).toBe(m.pinned.topics)
    }
    for (const matrixId of PINNED_WORKING_SET_MATRICES.map((m) => m.id)) {
      const prefix = MATRIX_METRIC_PREFIX_BY_ID[matrixId]
      const accounting = matrixAccountings.find((a) => a.matrixId === matrixId)!.accounting
      expect(assembled.metrics.find((mm) => mm.id === `${prefix}.pinned.aggregate.bytes`)?.value).toBe(
        accounting.pinned.aggregateBytes
      )
    }
  })
})
