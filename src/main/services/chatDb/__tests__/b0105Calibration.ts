/**
 * B-01–B-05 synthetic calibration helpers.
 *
 * This module is measurement-only. It models candidate-boundary accounting,
 * synthetic idle-time eligibility, numeric recency ordering, fit-step
 * arithmetic, and single-topic oversized classification without implementing
 * retention, eviction, TTL, LRU, admission, persistence, or runtime policy.
 */

import {
  type AggregateAccounting,
  aggregateLogicalPayload,
  B01_MAX_TOPICS,
  B02_MAX_BYTES,
  B05_CALIBRATION_CANDIDATE_BYTES,
  type LogicalPayloadTopicInput
} from '@shared/chatDb/logicalPayload'

import {
  createSyntheticB02ExactEqualityProfile,
  createSyntheticBoundaryExactProfile,
  createSyntheticByteFirstProfile,
  createSyntheticCountFirstProfile,
  createSyntheticOversizedSingleProfile
} from './logicalPayload'

export const B0105_CALIBRATION_ENV = 'B0105_CALIBRATION'
export const B0105_CALIBRATION_SCALE_ENV = 'B0105_CALIBRATION_SCALE'
export const B0105_CALIBRATION_COMMAND = 'pnpm bench:b0105-calibration'
export const B0105_CALIBRATION_BENCHMARK_ID = 'b0105-calibration'
export const B0105_CALIBRATION_BENCHMARK_NAME =
  'B-01–B-05 synthetic retention-boundary calibration (measurement-only, directional)'

export type B0105ScaleKey = 'small' | 'medium'
export type B0105ScenarioKey =
  | 'count-bound'
  | 'byte-bound'
  | 'boundary-exact'
  | 'b02-exact-equality'
  | 'oversized-single'

export interface B0105Scale {
  readonly key: B0105ScaleKey
  readonly profileCode: number
  readonly clockNowMinute: number
  readonly ttlMinutes: number
  readonly retentionTopicCount: number
}

export interface B0105ScenarioAccounting {
  readonly key: B0105ScenarioKey
  readonly accounting: AggregateAccounting
}

export interface B0105ClockSample {
  readonly ordinal: number
  readonly lastAccessMinute: number
  readonly idleMinutes: number
  readonly ttlEligible: boolean
}

export interface B0105LruSample {
  readonly topicId: string
  readonly ordinal: number
  readonly lastAccessMinute: number
  readonly rank: number
}

export interface B0105FitStep {
  readonly rank: number
  readonly topicBytes: number
  readonly remainingBytes: number
  readonly included: boolean
}

export interface B0105FitAccounting {
  readonly budgetBytes: number
  readonly initialBytes: number
  readonly finalBytes: number
  readonly steps: readonly B0105FitStep[]
  readonly removedCount: number
  readonly fitsBudget: boolean
}

export interface B0105CalibrationSummary {
  readonly scale: B0105Scale
  readonly scenarios: readonly B0105ScenarioAccounting[]
  readonly ttlSamples: readonly B0105ClockSample[]
  readonly lruSamples: readonly B0105LruSample[]
  readonly fit: B0105FitAccounting
  readonly oversizedExcludedCount: number
}

export const B0105_SCALES: Readonly<Record<B0105ScaleKey, B0105Scale>> = {
  small: {
    key: 'small',
    profileCode: 0,
    clockNowMinute: 180,
    ttlMinutes: 30,
    retentionTopicCount: 4
  },
  medium: {
    key: 'medium',
    profileCode: 1,
    clockNowMinute: 360,
    ttlMinutes: 30,
    retentionTopicCount: 4
  }
}

export const DEFAULT_B0105_SCALE: B0105ScaleKey = 'medium'
export const B0105_SCENARIO_COUNT = 5
export const B0105_TTL_SAMPLE_COUNT = 4
export const B0105_FIT_BUDGET_BYTES = B02_MAX_BYTES

export function resolveB0105Gate(value: string | undefined): boolean {
  if (value === undefined || value.trim().length === 0) return false
  const normalized = value.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true') return true
  throw new Error(
    `${B0105_CALIBRATION_ENV} must be '1'/'true' to enable or unset/empty to skip (got '${value}'). ` +
      `Enable only through the canonical \`${B0105_CALIBRATION_COMMAND}\` script.`
  )
}

export function resolveB0105Scale(value: string | undefined): B0105ScaleKey {
  if (value === undefined || value.trim().length === 0) return DEFAULT_B0105_SCALE
  const normalized = value.trim().toLowerCase()
  if (normalized === 'small' || normalized === 'medium') return normalized
  throw new Error(
    `${B0105_CALIBRATION_SCALE_ENV} must be one of: small, medium (got '${value}'). ` +
      `The default profile is '${DEFAULT_B0105_SCALE}'.`
  )
}

export function b0105ScaleMetadata(scale: B0105Scale): Record<string, number> {
  return {
    profileCode: scale.profileCode,
    scenarioCount: B0105_SCENARIO_COUNT,
    ttlSampleCount: B0105_TTL_SAMPLE_COUNT,
    ttlMinutes: scale.ttlMinutes,
    retentionTopicCount: scale.retentionTopicCount
  }
}

function scenarioTopics(key: B0105ScenarioKey): LogicalPayloadTopicInput[] {
  switch (key) {
    case 'count-bound':
      return createSyntheticCountFirstProfile()
    case 'byte-bound':
      return createSyntheticByteFirstProfile()
    case 'boundary-exact':
      return createSyntheticBoundaryExactProfile()
    case 'b02-exact-equality':
      return createSyntheticB02ExactEqualityProfile()
    case 'oversized-single':
      return createSyntheticOversizedSingleProfile()
  }
}

export function buildB0105ScenarioAccountings(): readonly B0105ScenarioAccounting[] {
  return (['count-bound', 'byte-bound', 'boundary-exact', 'b02-exact-equality', 'oversized-single'] as const).map(
    (key) => ({
      key,
      accounting: aggregateLogicalPayload(scenarioTopics(key))
    })
  )
}

export function buildB0105TtlSamples(scale: B0105Scale): readonly B0105ClockSample[] {
  const offsets = [scale.ttlMinutes + 1, scale.ttlMinutes, 1, scale.ttlMinutes + 10]
  return offsets.map((idleMinutes, ordinal) => ({
    ordinal,
    lastAccessMinute: scale.clockNowMinute - idleMinutes,
    idleMinutes,
    ttlEligible: idleMinutes > scale.ttlMinutes
  }))
}

export function buildB0105LruSamples(scale: B0105Scale): readonly B0105LruSample[] {
  const samples = [
    { topicId: 'synthetic-byte-first-topic-00', lastAccessMinute: scale.clockNowMinute - 5 },
    { topicId: 'synthetic-byte-first-topic-02', lastAccessMinute: scale.clockNowMinute - 20 },
    { topicId: 'synthetic-byte-first-topic-01', lastAccessMinute: scale.clockNowMinute - 20 },
    { topicId: 'synthetic-byte-first-topic-03', lastAccessMinute: scale.clockNowMinute - 1 }
  ]
  return samples
    .map((sample, ordinal) => ({ ...sample, ordinal, rank: 0 }))
    .sort((a, b) => {
      const recency = a.lastAccessMinute - b.lastAccessMinute
      if (recency !== 0) return recency
      if (a.topicId < b.topicId) return -1
      if (a.topicId > b.topicId) return 1
      return 0
    })
    .map((sample, rank) => ({ ...sample, rank }))
}

export function computeB0105FitAccounting(
  topicBytes: readonly number[],
  budgetBytes = B0105_FIT_BUDGET_BYTES
): B0105FitAccounting {
  if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) throw new Error('fit budget must be finite and positive')
  if (topicBytes.some((bytes) => !Number.isFinite(bytes) || bytes < 0)) {
    throw new Error('fit topic bytes must be finite and non-negative')
  }

  const initialBytes = topicBytes.reduce((sum, bytes) => sum + bytes, 0)
  let remainingBytes = initialBytes
  const steps: B0105FitStep[] = []
  for (const [index, bytes] of topicBytes.entries()) {
    const included = remainingBytes <= budgetBytes
    steps.push({ rank: index, topicBytes: bytes, remainingBytes, included })
    if (!included) remainingBytes -= bytes
  }

  return {
    budgetBytes,
    initialBytes,
    finalBytes: remainingBytes,
    steps,
    removedCount: steps.filter((step) => !step.included).length,
    fitsBudget: remainingBytes <= budgetBytes
  }
}

export function summarizeB0105Calibration(scale: B0105Scale): B0105CalibrationSummary {
  if (!Number.isInteger(scale.retentionTopicCount) || scale.retentionTopicCount <= 0) {
    throw new Error('retentionTopicCount must be a positive integer')
  }

  const scenarios = buildB0105ScenarioAccountings()
  const byteBound = scenarios.find((scenario) => scenario.key === 'byte-bound')
  const oversized = scenarios.find((scenario) => scenario.key === 'oversized-single')
  if (byteBound === undefined || oversized === undefined) throw new Error('B0105 scenario matrix is incomplete')

  const lruSamples = buildB0105LruSamples(scale)
  const byteLengthsByTopicId = new Map(byteBound.accounting.perTopic.map((topic) => [topic.topicId, topic.byteLength]))
  const fit = computeB0105FitAccounting(
    lruSamples.map((sample) => {
      const byteLength = byteLengthsByTopicId.get(sample.topicId)
      if (byteLength === undefined) throw new Error(`missing B0105 payload for LRU topic ${sample.topicId}`)
      return byteLength
    })
  )
  const oversizedExcludedCount = oversized.accounting.oversizedTopicIds.length

  return {
    scale,
    scenarios,
    ttlSamples: buildB0105TtlSamples(scale),
    lruSamples,
    fit,
    oversizedExcludedCount
  }
}

export function assertB0105FiniteSummary(summary: B0105CalibrationSummary): void {
  const numbers = [
    summary.scale.profileCode,
    summary.scale.clockNowMinute,
    summary.scale.ttlMinutes,
    summary.scale.retentionTopicCount,
    summary.fit.budgetBytes,
    summary.fit.initialBytes,
    summary.fit.finalBytes,
    summary.fit.removedCount,
    summary.oversizedExcludedCount,
    ...summary.scenarios.flatMap(({ accounting }) => [
      accounting.aggregateBytes,
      accounting.topicCount,
      accounting.perTopic.length,
      ...accounting.perTopic.map((topic) => topic.byteLength)
    ]),
    ...summary.ttlSamples.flatMap((sample) => [sample.ordinal, sample.lastAccessMinute, sample.idleMinutes]),
    ...summary.lruSamples.flatMap((sample) => [sample.ordinal, sample.lastAccessMinute, sample.rank]),
    ...summary.fit.steps.flatMap((step) => [step.rank, step.topicBytes, step.remainingBytes])
  ]
  if (numbers.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('B0105 summary contains a non-finite or negative numeric value')
  }
}

export function assertB0105PrivacySummary(summary: B0105CalibrationSummary): void {
  assertB0105FiniteSummary(summary)
  for (const scenario of summary.scenarios) {
    if (!/^[a-z0-9-]+$/.test(scenario.key)) throw new Error(`B0105 scenario key is not closed: ${scenario.key}`)
  }
  if (summary.fit.steps.some((step) => !Number.isInteger(step.rank))) {
    throw new Error('B0105 fit ranks must be numeric integers')
  }
}

export function b0105ExpectedCandidateValues(): Readonly<{
  maxTopics: number
  maxBytes: number
  oversizedBytes: number
}> {
  return {
    maxTopics: B01_MAX_TOPICS,
    maxBytes: B02_MAX_BYTES,
    oversizedBytes: B05_CALIBRATION_CANDIDATE_BYTES
  }
}
