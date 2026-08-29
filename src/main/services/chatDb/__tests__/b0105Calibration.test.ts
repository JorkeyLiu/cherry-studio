/** Focused pure tests for the B-01–B-05 synthetic calibration contract. */

import { aggregateLogicalPayload, B02_MAX_BYTES } from '@shared/chatDb/logicalPayload'
import { describe, expect, it } from 'vitest'

import {
  B0105_CALIBRATION_COMMAND,
  B0105_CALIBRATION_ENV,
  B0105_CALIBRATION_SCALE_ENV,
  B0105_SCALES,
  buildB0105LruSamples,
  buildB0105TtlSamples,
  computeB0105FitAccounting,
  DEFAULT_B0105_SCALE,
  resolveB0105Gate,
  resolveB0105Scale,
  summarizeB0105Calibration
} from './b0105Calibration'
import {
  assembleB0105CalibrationResult,
  buildB0105CalibrationGates,
  buildB0105CalibrationMetrics
} from './b0105Calibration.benchContract'
import { validateBenchmarkResult } from './benchResult'
import { createSyntheticB02ExactEqualityProfile, createSyntheticTopic } from './logicalPayload'

describe('B0105 environment and scale contracts', () => {
  it('is inert unless explicitly enabled', () => {
    expect(resolveB0105Gate(undefined)).toBe(false)
    expect(resolveB0105Gate('')).toBe(false)
    expect(resolveB0105Gate('  ')).toBe(false)
    expect(resolveB0105Gate('1')).toBe(true)
    expect(resolveB0105Gate(' TRUE ')).toBe(true)
    for (const value of ['0', 'false', 'yes', 'on'])
      expect(() => resolveB0105Gate(value)).toThrow(B0105_CALIBRATION_ENV)
  })

  it('resolves only bounded scale profiles', () => {
    expect(DEFAULT_B0105_SCALE).toBe('medium')
    expect(resolveB0105Scale(undefined)).toBe('medium')
    expect(resolveB0105Scale(' small ')).toBe('small')
    expect(resolveB0105Scale('MEDIUM')).toBe('medium')
    expect(B0105_CALIBRATION_SCALE_ENV).toBe('B0105_CALIBRATION_SCALE')
    expect(() => resolveB0105Scale('large')).toThrow(B0105_CALIBRATION_SCALE_ENV)
    expect(Object.values(B0105_SCALES).every((scale) => Number.isFinite(scale.ttlMinutes))).toBe(true)
  })

  it('declares a stable path-free command', () => {
    expect(B0105_CALIBRATION_COMMAND).toBe('pnpm bench:b0105-calibration')
    expect(B0105_CALIBRATION_COMMAND).not.toMatch(/[\\/]/)
  })
})

describe('B0105 synthetic accounting', () => {
  it('builds deterministic scenario, TTL, LRU, fit, and oversized evidence', () => {
    const first = summarizeB0105Calibration(B0105_SCALES.small)
    const second = summarizeB0105Calibration(B0105_SCALES.small)
    expect(first).toEqual(second)
    expect(first.scenarios.map((scenario) => scenario.key)).toEqual([
      'count-bound',
      'byte-bound',
      'boundary-exact',
      'b02-exact-equality',
      'oversized-single'
    ])
    expect(first.scenarios[0].accounting.isCountBound).toBe(true)
    expect(first.scenarios[1].accounting.isByteBound).toBe(true)
    expect(first.scenarios[2].accounting.binding).toBe('none')
    expect(first.scenarios[3].accounting.aggregateBytes).toBe(B02_MAX_BYTES)
    expect(first.scenarios[3].accounting.isByteBound).toBe(false)
    expect(first.scenarios[4].accounting.oversizedTopicIds).toHaveLength(1)
    expect(first.scenarios[4].accounting.perTopic[0].byteLength).toBeGreaterThan(B02_MAX_BYTES)
    expect(first.fit.fitsBudget).toBe(true)
    expect(first.fit.removedCount).toBeGreaterThan(0)
    expect(first.oversizedExcludedCount).toBe(1)
  })

  it('uses strict TTL eligibility and deterministic lexical topic-ID LRU tie-breaking', () => {
    const scale = B0105_SCALES.small
    const ttl = buildB0105TtlSamples(scale)
    expect(ttl.find((sample) => sample.idleMinutes === scale.ttlMinutes)?.ttlEligible).toBe(false)
    expect(ttl.filter((sample) => sample.ttlEligible)).toHaveLength(2)

    const lru = buildB0105LruSamples(scale)
    expect(lru.map((sample) => sample.topicId)).toEqual([
      'synthetic-byte-first-topic-01',
      'synthetic-byte-first-topic-02',
      'synthetic-byte-first-topic-00',
      'synthetic-byte-first-topic-03'
    ])
    expect(lru.map((sample) => sample.rank)).toEqual([0, 1, 2, 3])
  })

  it('maps LRU payload accounting by topic ID rather than ordinal', () => {
    const summary = summarizeB0105Calibration(B0105_SCALES.small)
    const byteBound = summary.scenarios.find((scenario) => scenario.key === 'byte-bound')?.accounting
    expect(byteBound).toBeDefined()
    expect(summary.fit.steps.map((step) => step.topicBytes)).toEqual(
      summary.lruSamples.map(
        (sample) => byteBound?.perTopic.find((topic) => topic.topicId === sample.topicId)?.byteLength
      )
    )
  })

  it('keeps fit-step arithmetic numeric and fails closed on invalid values', () => {
    expect(computeB0105FitAccounting([6, 5, 4], 10)).toMatchObject({
      initialBytes: 15,
      finalBytes: 9,
      removedCount: 1,
      fitsBudget: true
    })
    expect(() => computeB0105FitAccounting([1, Number.NaN])).toThrow(/finite/)
    expect(() => computeB0105FitAccounting([1], 0)).toThrow(/positive/)
  })
})

describe('B0105 schema-v1 contract', () => {
  it('builds finite closed metrics and passing correctness gates', () => {
    const summary = summarizeB0105Calibration(B0105_SCALES.medium)
    const metrics = buildB0105CalibrationMetrics(summary)
    const gates = buildB0105CalibrationGates(summary)
    expect(metrics.length).toBeGreaterThan(0)
    expect(new Set(metrics.map((metric) => metric.id)).size).toBe(metrics.length)
    expect(metrics.every((metric) => Number.isFinite(metric.value))).toBe(true)
    expect(gates.filter((gate) => !gate.passed)).toEqual([])
    expect(gates.every((gate) => !/[\\/]/.test(gate.detail ?? ''))).toBe(true)
  })

  it('covers mutually exclusive binding and exact B-02 boundary semantics', () => {
    const summary = summarizeB0105Calibration(B0105_SCALES.small)
    const byKey = new Map(summary.scenarios.map((scenario) => [scenario.key, scenario.accounting]))
    expect(byKey.get('count-bound')).toMatchObject({ binding: 'count-first', isCountBound: true, isByteBound: false })
    expect(byKey.get('byte-bound')).toMatchObject({ binding: 'byte-first', isCountBound: false, isByteBound: true })
    expect(byKey.get('b02-exact-equality')).toMatchObject({
      aggregateBytes: B02_MAX_BYTES,
      binding: 'none',
      isByteBound: false
    })

    const exact = createSyntheticB02ExactEqualityProfile()[0]
    const over = createSyntheticTopic({
      topicId: exact.topicId,
      messageCount: 1,
      blockContentSize: (exact.blocks[0].content as string).length + 1,
      segmentCount: 0
    })
    expect(aggregateLogicalPayload([over])).toMatchObject({
      aggregateBytes: B02_MAX_BYTES + 1,
      binding: 'byte-first',
      isByteBound: true
    })
  })

  it('assembles a valid numeric-only schema-v1 artifact', () => {
    const summary = summarizeB0105Calibration(B0105_SCALES.small)
    const result = assembleB0105CalibrationResult({
      summary,
      environment: {
        timestamp: '2026-08-29T00:00:00.000Z',
        node: 'v24.11.1',
        pnpm: '10.27.0',
        abiLane: 'node',
        abi: '137',
        command: B0105_CALIBRATION_COMMAND,
        git: { commit: '', dirty: false }
      }
    })
    expect(validateBenchmarkResult(result)).toEqual([])
    expect(JSON.stringify(result)).not.toMatch(/"(?:path|content|credential|raw|profile)"\s*:/i)
  })
})
