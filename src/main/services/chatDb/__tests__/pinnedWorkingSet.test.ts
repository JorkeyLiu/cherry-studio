import { describe, expect, it } from 'vitest'

import { aggregateLogicalPayload, canonicalizeLogicalPayload, createSyntheticTopic } from './logicalPayload'
import {
  assertFiniteMetricValue,
  buildPartition,
  buildPinnedWorkingSetScaleMap,
  computePinnedWorkingSetAccounting,
  EVICTABLE_PARTITION_CONFIG,
  heapAmplificationCoverageLimit,
  PINNED_PARTITION_CONFIG,
  PINNED_WORKING_SET_MATRIX_IDS,
  UNLIMITED_CONTEXT_CONFIG,
  validatePartitionConfig
} from './pinnedWorkingSet'

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
