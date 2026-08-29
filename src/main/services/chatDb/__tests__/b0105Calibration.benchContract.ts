/** Pure schema-v1 metric and gate contract for the B-01–B-05 calibration. */

import { B01_MAX_TOPICS, B02_MAX_BYTES } from '@shared/chatDb/logicalPayload'

import {
  assertB0105FiniteSummary,
  assertB0105PrivacySummary,
  B0105_CALIBRATION_BENCHMARK_ID,
  B0105_CALIBRATION_BENCHMARK_NAME,
  B0105_SCENARIO_COUNT,
  type B0105CalibrationSummary,
  b0105ExpectedCandidateValues
} from './b0105Calibration'
import {
  BENCH_RESULT_SCHEMA_VERSION,
  type BenchmarkEnvironment,
  type BenchmarkGate,
  type BenchmarkMetric,
  type BenchmarkResult
} from './benchResult'

export function buildB0105CalibrationMetrics(summary: B0105CalibrationSummary): BenchmarkMetric[] {
  const scenario = (key: B0105CalibrationSummary['scenarios'][number]['key']) => {
    const found = summary.scenarios.find((item) => item.key === key)
    if (found === undefined) throw new Error(`missing B0105 scenario ${key}`)
    return found.accounting
  }

  const countBound = scenario('count-bound')
  const byteBound = scenario('byte-bound')
  const boundaryExact = scenario('boundary-exact')
  const b02ExactEquality = scenario('b02-exact-equality')
  const oversized = scenario('oversized-single')
  const lruOrderValid = summary.lruSamples.every((sample, index) => sample.rank === index)
  const ttlEligibleCount = summary.ttlSamples.filter((sample) => sample.ttlEligible).length
  const ttlExactBoundaryCount = summary.ttlSamples.filter(
    (sample) => sample.idleMinutes === summary.scale.ttlMinutes
  ).length
  const candidates = b0105ExpectedCandidateValues()

  const metrics: BenchmarkMetric[] = [
    { id: 'scenario.count', name: 'Synthetic scenario count', value: summary.scenarios.length },
    { id: 'countBound.topicCount', name: 'Synthetic count-bound topic count', value: countBound.topicCount },
    {
      id: 'countBound.aggregateBytes',
      name: 'Synthetic count-bound aggregate logical bytes',
      value: countBound.aggregateBytes,
      unit: 'bytes'
    },
    { id: 'byteBound.topicCount', name: 'Synthetic byte-bound topic count', value: byteBound.topicCount },
    {
      id: 'byteBound.aggregateBytes',
      name: 'Synthetic byte-bound aggregate logical bytes',
      value: byteBound.aggregateBytes,
      unit: 'bytes'
    },
    { id: 'boundaryExact.topicCount', name: 'Synthetic exact-boundary topic count', value: boundaryExact.topicCount },
    {
      id: 'boundaryExact.aggregateBytes',
      name: 'Synthetic exact-boundary aggregate logical bytes',
      value: boundaryExact.aggregateBytes,
      unit: 'bytes'
    },
    {
      id: 'b02ExactEquality.aggregateBytes',
      name: 'Synthetic B-02 exact-equality aggregate logical bytes',
      value: b02ExactEquality.aggregateBytes,
      unit: 'bytes'
    },
    { id: 'oversized.topicCount', name: 'Synthetic oversized topic count', value: oversized.oversizedTopicIds.length },
    {
      id: 'oversized.bytes',
      name: 'Synthetic oversized topic logical bytes',
      value: oversized.perTopic[0]?.byteLength ?? 0,
      unit: 'bytes'
    },
    { id: 'ttl.sampleCount', name: 'Synthetic TTL sample count', value: summary.ttlSamples.length },
    { id: 'ttl.eligibleCount', name: 'Synthetic TTL-eligible sample count', value: ttlEligibleCount },
    { id: 'ttl.exactBoundaryCount', name: 'Synthetic TTL exact-boundary sample count', value: ttlExactBoundaryCount },
    { id: 'lru.sampleCount', name: 'Synthetic LRU sample count', value: summary.lruSamples.length },
    { id: 'lru.orderValid', name: 'Synthetic numeric LRU order valid (1=true)', value: lruOrderValid ? 1 : 0 },
    {
      id: 'fit.budgetBytes',
      name: 'Synthetic fit-step budget candidate bytes',
      value: summary.fit.budgetBytes,
      unit: 'bytes'
    },
    {
      id: 'fit.initialBytes',
      name: 'Synthetic fit-step initial logical bytes',
      value: summary.fit.initialBytes,
      unit: 'bytes'
    },
    {
      id: 'fit.finalBytes',
      name: 'Synthetic fit-step final logical bytes',
      value: summary.fit.finalBytes,
      unit: 'bytes'
    },
    { id: 'fit.stepCount', name: 'Synthetic fit-step count', value: summary.fit.steps.length },
    { id: 'fit.removedCount', name: 'Synthetic fit-step arithmetic removed count', value: summary.fit.removedCount },
    {
      id: 'fit.fitsBudget',
      name: 'Synthetic fit-step result fits candidate budget (1=true)',
      value: summary.fit.fitsBudget ? 1 : 0
    },
    {
      id: 'oversized.excludedCount',
      name: 'Synthetic oversized excluded count',
      value: summary.oversizedExcludedCount
    },
    {
      id: 'calibrationCandidate.B01_maxTopics',
      name: 'B-01 calibration candidate max topics',
      value: candidates.maxTopics
    },
    {
      id: 'calibrationCandidate.B02_maxBytes',
      name: 'B-02 calibration candidate max bytes',
      value: candidates.maxBytes,
      unit: 'bytes'
    },
    {
      id: 'calibrationCandidate.B05_maxBytes',
      name: 'B-05 calibration candidate max bytes',
      value: candidates.oversizedBytes,
      unit: 'bytes'
    }
  ]
  assertB0105FiniteSummary(summary)
  return metrics
}

export function buildB0105CalibrationGates(summary: B0105CalibrationSummary): BenchmarkGate[] {
  const countBound = summary.scenarios.find((item) => item.key === 'count-bound')?.accounting
  const byteBound = summary.scenarios.find((item) => item.key === 'byte-bound')?.accounting
  const boundaryExact = summary.scenarios.find((item) => item.key === 'boundary-exact')?.accounting
  const b02ExactEquality = summary.scenarios.find((item) => item.key === 'b02-exact-equality')?.accounting
  const oversized = summary.scenarios.find((item) => item.key === 'oversized-single')?.accounting
  const candidates = b0105ExpectedCandidateValues()
  const ttlPassed = summary.ttlSamples.every(
    (sample) => sample.ttlEligible === sample.idleMinutes > summary.scale.ttlMinutes
  )
  const lruPassed = summary.lruSamples.every(
    (sample, index, samples) =>
      sample.rank === index &&
      (index === 0 ||
        sample.lastAccessMinute > samples[index - 1].lastAccessMinute ||
        (sample.lastAccessMinute === samples[index - 1].lastAccessMinute &&
          sample.topicId > samples[index - 1].topicId))
  )
  const scenarioChecks = [
    summary.scenarios.length === B0105_SCENARIO_COUNT,
    countBound?.isCountBound === true,
    countBound?.isByteBound === false,
    countBound?.binding === 'count-first',
    byteBound?.isByteBound === true,
    byteBound?.isCountBound === false,
    byteBound?.binding === 'byte-first',
    boundaryExact?.binding === 'none',
    boundaryExact?.topicCount === B01_MAX_TOPICS,
    (boundaryExact?.aggregateBytes ?? Number.POSITIVE_INFINITY) < B02_MAX_BYTES,
    b02ExactEquality?.binding === 'none',
    b02ExactEquality?.aggregateBytes === B02_MAX_BYTES,
    b02ExactEquality?.isByteBound === false,
    oversized?.oversizedTopicIds.length === 1,
    summary.oversizedExcludedCount === 1,
    (oversized?.perTopic[0]?.byteLength ?? 0) > candidates.oversizedBytes,
    summary.lruSamples.every((sample) => byteBound?.perTopic.some((topic) => topic.topicId === sample.topicId) === true)
  ]
  const scenarioPassed = scenarioChecks.every(Boolean)
  const fitPassed =
    summary.fit.steps.length === summary.lruSamples.length &&
    summary.fit.finalBytes <= summary.fit.budgetBytes &&
    summary.fit.removedCount === summary.fit.steps.filter((step) => !step.included).length

  return [
    {
      id: 'matrix.complete',
      name: 'Complete deterministic B-01–B-05 synthetic scenario matrix',
      kind: 'correctness',
      passed: scenarioPassed,
      detail: `scenarios=${summary.scenarios.length} expected=${B0105_SCENARIO_COUNT} checks=${
        scenarioChecks
          .map((check, index) => (check ? '' : String(index)))
          .filter(Boolean)
          .join(',') || 'all'
      }`
    },
    {
      id: 'ttl.synthetic',
      name: 'Synthetic TTL eligibility uses strict idle-time comparison',
      kind: 'correctness',
      passed: ttlPassed,
      detail: `samples=${summary.ttlSamples.length} eligible=${summary.ttlSamples.filter((sample) => sample.ttlEligible).length}`
    },
    {
      id: 'lru.synthetic',
      name: 'Synthetic numeric LRU ordering is deterministic with lexical topic-ID tie-break',
      kind: 'correctness',
      passed: lruPassed,
      detail: `samples=${summary.lruSamples.length} ordered=${lruPassed ? 'true' : 'false'}`
    },
    {
      id: 'fit.steps',
      name: 'Synthetic fit-step arithmetic reaches the candidate byte budget',
      kind: 'correctness',
      passed: fitPassed,
      detail: `initial=${summary.fit.initialBytes} final=${summary.fit.finalBytes} removed=${summary.fit.removedCount}`
    },
    {
      id: 'oversized.exclusion',
      name: 'Synthetic single oversized topic is classified and excluded',
      kind: 'correctness',
      passed:
        oversized?.oversizedTopicIds.length === summary.oversizedExcludedCount && summary.oversizedExcludedCount === 1,
      detail: `excluded=${summary.oversizedExcludedCount}`
    },
    {
      id: 'metrics.finite',
      name: 'All B-01–B-05 calibration metrics are finite and non-negative',
      kind: 'correctness',
      passed: (() => {
        try {
          assertB0105FiniteSummary(summary)
          return true
        } catch {
          return false
        }
      })(),
      detail: 'finite numeric-only summary'
    },
    {
      id: 'output.privacy',
      name: 'Closed numeric-only synthetic calibration output',
      kind: 'correctness',
      passed: (() => {
        try {
          assertB0105PrivacySummary(summary)
          return true
        } catch {
          return false
        }
      })(),
      detail: 'numeric-only helper output'
    }
  ]
}

export interface AssembleB0105ResultParams {
  readonly summary: B0105CalibrationSummary
  readonly environment: BenchmarkEnvironment
}

export function assembleB0105CalibrationResult(params: AssembleB0105ResultParams): BenchmarkResult {
  return {
    schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
    benchmark: {
      id: B0105_CALIBRATION_BENCHMARK_ID,
      name: B0105_CALIBRATION_BENCHMARK_NAME,
      scale: {
        profileCode: params.summary.scale.profileCode,
        ttlMinutes: params.summary.scale.ttlMinutes,
        retentionTopicCount: params.summary.scale.retentionTopicCount,
        scenarioCount: B0105_SCENARIO_COUNT
      }
    },
    environment: params.environment,
    metrics: buildB0105CalibrationMetrics(params.summary),
    gates: buildB0105CalibrationGates(params.summary)
  }
}
