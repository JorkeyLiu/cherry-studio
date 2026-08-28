/**
 * M5 file dual-state consistency — pure synthetic diagnostic helpers.
 *
 * Measurement-only and inactive by default. The model is deliberately limited
 * to finite numbers, booleans, and closed enum values. It describes synthetic
 * Main reference/catalog/physical-state relationships only; it is not a
 * production state machine and never represents user data.
 */

import type { BenchmarkGate, BenchmarkMetric } from './benchResult'

export const M5_FILE_DUAL_BENCH_ENV = 'M5_FILE_DUAL_BENCH'
export const M5_FILE_DUAL_SCALE_ENV = 'M5_FILE_DUAL_SCALE'
export const M5_FILE_DUAL_COMMAND = 'pnpm bench:m5-file-dual-state'
export const M5_FILE_DUAL_BENCH_NAME =
  'M5 file dual-state consistency (synthetic, measurement-only, directional L3 only)'

export type M5ProfileKey = 'small' | 'medium'
export type M5ScenarioKey = 'aligned' | 'catalog-drift' | 'physical-missing' | 'degraded-marker'
export type M5AttachmentState = 'aligned' | 'catalog-drift' | 'physical-missing' | 'degraded-marker'

export interface M5Profile {
  readonly key: M5ProfileKey
  readonly references: number
  readonly profileCode: number
}

export interface M5Scenario {
  readonly key: M5ScenarioKey
  readonly referenceCount: number
  readonly catalogCount: number
  readonly physicalPresentCount: number
  readonly degradedMarkerCount: number
  readonly catalogAligned: boolean
  readonly physicalAligned: boolean
  readonly attachmentState: M5AttachmentState
}

export interface M5ScenarioParity {
  readonly key: M5ScenarioKey
  readonly catalogDelta: number
  readonly physicalDelta: number
  readonly catalogAligned: boolean
  readonly physicalAligned: boolean
  readonly degradedMarkerCount: number
  readonly isAligned: boolean
  readonly isDivergent: boolean
  readonly isDegraded: boolean
  readonly markerSemanticsValid: boolean
}

export interface M5Summary {
  readonly scenarios: readonly M5ScenarioParity[]
  readonly metrics: readonly BenchmarkMetric[]
  readonly gates: readonly BenchmarkGate[]
}

export const M5_FILE_DUAL_PROFILES: Readonly<Record<M5ProfileKey, M5Profile>> = {
  small: { key: 'small', references: 100, profileCode: 0 },
  medium: { key: 'medium', references: 1_000, profileCode: 1 }
}

export const DEFAULT_M5_FILE_DUAL_SCALE: M5ProfileKey = 'medium'
export const M5_SCENARIO_COUNT = 4
export const M5_MAX_DETAIL_BYTES = 256

const EXPECTED_M5_SCENARIO_PARITY: Readonly<
  Record<
    M5ScenarioKey,
    Pick<
      M5ScenarioParity,
      'catalogDelta' | 'physicalDelta' | 'isAligned' | 'isDivergent' | 'isDegraded' | 'markerSemanticsValid'
    >
  >
> = {
  aligned: {
    catalogDelta: 0,
    physicalDelta: 0,
    isAligned: true,
    isDivergent: false,
    isDegraded: false,
    markerSemanticsValid: true
  },
  'catalog-drift': {
    catalogDelta: 1,
    physicalDelta: 0,
    isAligned: false,
    isDivergent: true,
    isDegraded: false,
    markerSemanticsValid: true
  },
  'physical-missing': {
    catalogDelta: 0,
    physicalDelta: 1,
    isAligned: false,
    isDivergent: true,
    isDegraded: false,
    markerSemanticsValid: true
  },
  'degraded-marker': {
    catalogDelta: 1,
    physicalDelta: 1,
    isAligned: false,
    isDivergent: true,
    isDegraded: true,
    markerSemanticsValid: true
  }
}

export function resolveM5FileDualGate(value: string | undefined): boolean {
  if (value === undefined || value.trim().length === 0) return false
  const normalized = value.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true') return true
  throw new Error(
    `${M5_FILE_DUAL_BENCH_ENV} must be '1'/'true' to enable or unset/empty to skip ` +
      `(got '${value}'). Enable only through the canonical \`${M5_FILE_DUAL_COMMAND}\` script.`
  )
}

export function resolveM5FileDualScale(value: string | undefined): M5ProfileKey {
  if (value === undefined || value.trim().length === 0) return DEFAULT_M5_FILE_DUAL_SCALE
  const key = value.trim()
  if (key === 'small' || key === 'medium') return key
  throw new Error(
    `${M5_FILE_DUAL_SCALE_ENV} must be one of: small, medium ` +
      `(got '${value}'). The default profile is '${DEFAULT_M5_FILE_DUAL_SCALE}'.`
  )
}

export function m5ScaleMetadata(profile: M5Profile): Record<string, number> {
  return {
    references: profile.references,
    profileCode: profile.profileCode,
    scenarioCount: M5_SCENARIO_COUNT
  }
}

function assertFiniteNonNegativeInteger(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error(`${name} must be a finite non-negative integer`)
  }
}

function assertScenarioCounts(referenceCount: number, catalogCount: number, physicalPresentCount: number): void {
  assertFiniteNonNegativeInteger(referenceCount, 'referenceCount')
  assertFiniteNonNegativeInteger(catalogCount, 'catalogCount')
  assertFiniteNonNegativeInteger(physicalPresentCount, 'physicalPresentCount')
  if (catalogCount > referenceCount) throw new Error('catalogCount cannot exceed referenceCount')
  if (physicalPresentCount > referenceCount) throw new Error('physicalPresentCount cannot exceed referenceCount')
}

/** Build the fixed, deterministic four-state synthetic matrix for one profile. */
export function buildM5Scenarios(profile: M5Profile): readonly M5Scenario[] {
  assertFiniteNonNegativeInteger(profile.references, 'profile.references')
  return [
    {
      key: 'aligned',
      referenceCount: profile.references,
      catalogCount: profile.references,
      physicalPresentCount: profile.references,
      degradedMarkerCount: 0,
      catalogAligned: true,
      physicalAligned: true,
      attachmentState: 'aligned'
    },
    {
      key: 'catalog-drift',
      referenceCount: profile.references,
      catalogCount: profile.references - 1,
      physicalPresentCount: profile.references,
      degradedMarkerCount: 0,
      catalogAligned: false,
      physicalAligned: true,
      attachmentState: 'catalog-drift'
    },
    {
      key: 'physical-missing',
      referenceCount: profile.references,
      catalogCount: profile.references,
      physicalPresentCount: profile.references - 1,
      degradedMarkerCount: 0,
      catalogAligned: true,
      physicalAligned: false,
      attachmentState: 'physical-missing'
    },
    {
      key: 'degraded-marker',
      referenceCount: profile.references,
      catalogCount: profile.references - 1,
      physicalPresentCount: profile.references - 1,
      degradedMarkerCount: 1,
      catalogAligned: false,
      physicalAligned: false,
      attachmentState: 'degraded-marker'
    }
  ] as const
}

export function calculateM5ScenarioParity(scenario: M5Scenario): M5ScenarioParity {
  assertScenarioCounts(scenario.referenceCount, scenario.catalogCount, scenario.physicalPresentCount)
  assertFiniteNonNegativeInteger(scenario.degradedMarkerCount, 'degradedMarkerCount')

  const catalogDelta = scenario.referenceCount - scenario.catalogCount
  const physicalDelta = scenario.referenceCount - scenario.physicalPresentCount
  const isDegraded = scenario.attachmentState === 'degraded-marker'
  const markerSemanticsValid = isDegraded
    ? scenario.degradedMarkerCount === 1 && catalogDelta > 0 && physicalDelta > 0
    : scenario.degradedMarkerCount === 0
  const isAligned = catalogDelta === 0 && physicalDelta === 0 && !isDegraded

  return {
    key: scenario.key,
    catalogDelta,
    physicalDelta,
    catalogAligned: scenario.catalogAligned,
    physicalAligned: scenario.physicalAligned,
    degradedMarkerCount: scenario.degradedMarkerCount,
    isAligned,
    isDivergent: !isAligned,
    isDegraded,
    markerSemanticsValid
  }
}

export function calculateM5ScenarioParitySet(scenarios: readonly M5Scenario[]): readonly M5ScenarioParity[] {
  return scenarios.map(calculateM5ScenarioParity)
}

function boundedDetail(detail: string): string {
  if (detail.length === 0) throw new Error('M5 gate detail must be non-empty')
  if (Buffer.byteLength(detail, 'utf8') > M5_MAX_DETAIL_BYTES) {
    throw new Error(`M5 gate detail exceeds ${M5_MAX_DETAIL_BYTES} UTF-8 bytes`)
  }
  if (/[\\/]/.test(detail)) throw new Error('M5 gate detail must not contain path segments')
  return detail
}

export function buildM5FileDualStateMetrics(
  scenarios: readonly M5ScenarioParity[],
  referenceCount: number
): BenchmarkMetric[] {
  assertFiniteNonNegativeInteger(referenceCount, 'referenceCount')
  const alignedCount = scenarios.filter((scenario) => scenario.isAligned).length
  const divergentCount = scenarios.filter((scenario) => scenario.isDivergent).length
  const degradedCount = scenarios.filter((scenario) => scenario.isDegraded).length
  const catalogParityCount = scenarios.filter((scenario) => scenario.catalogDelta === 0).length
  const physicalParityCount = scenarios.filter((scenario) => scenario.physicalDelta === 0).length
  const degradedMarkerCount = scenarios.reduce((count, scenario) => count + scenario.degradedMarkerCount, 0)

  const metrics: BenchmarkMetric[] = [
    { id: 'scenario.count', name: 'Synthetic scenario count', value: scenarios.length },
    { id: 'reference.count', name: 'Synthetic Main file reference count per scenario', value: referenceCount },
    { id: 'scenario.aligned.count', name: 'Aligned scenario count', value: alignedCount },
    { id: 'scenario.divergent.count', name: 'Divergent scenario count', value: divergentCount },
    { id: 'scenario.degraded.count', name: 'Degraded marker scenario count', value: degradedCount },
    { id: 'catalog.parity.count', name: 'Catalog parity scenario count', value: catalogParityCount },
    {
      id: 'physical.parity.count',
      name: 'Synthetic physical presence parity scenario count',
      value: physicalParityCount
    },
    { id: 'degraded.marker.count', name: 'Synthetic degraded attachment marker count', value: degradedMarkerCount }
  ]
  assertM5FiniteMetrics(metrics)
  return metrics
}

export interface M5GateInputs {
  readonly scenarios: readonly M5ScenarioParity[]
  readonly expectedScenarioCount: number
  readonly expectedReferenceCount: number
  readonly observedReferenceCount: number
  readonly metrics: readonly BenchmarkMetric[]
}

export function buildM5FileDualStateGates(inputs: M5GateInputs): BenchmarkGate[] {
  const { scenarios, expectedScenarioCount, expectedReferenceCount, observedReferenceCount, metrics } = inputs
  const alignedCount = scenarios.filter((scenario) => scenario.isAligned).length
  const divergentCount = scenarios.filter((scenario) => scenario.isDivergent).length
  const degradedCount = scenarios.filter((scenario) => scenario.isDegraded).length
  const markersValid = scenarios.every((scenario) => scenario.markerSemanticsValid)
  const markerCount = scenarios.reduce((count, scenario) => count + scenario.degradedMarkerCount, 0)
  const markerCardinalityPassed =
    markerCount === 1 && scenarios.every((scenario) => scenario.degradedMarkerCount === (scenario.isDegraded ? 1 : 0))
  const finitePassed = metrics.every((metric) => Number.isFinite(metric.value) && metric.value >= 0)
  const privacyPassed = assertM5PrivacyInvariants(metrics, false)
  const scenarioKeys = scenarios.map((scenario) => scenario.key)
  const hasClosedScenarioSet =
    scenarios.length === M5_SCENARIO_COUNT &&
    new Set(scenarioKeys).size === M5_SCENARIO_COUNT &&
    scenarioKeys.every((key) => key in EXPECTED_M5_SCENARIO_PARITY)
  const classificationsMatch =
    hasClosedScenarioSet &&
    scenarios.every((scenario) => {
      const expected = EXPECTED_M5_SCENARIO_PARITY[scenario.key]
      return (
        expected !== undefined &&
        scenario.catalogDelta === expected.catalogDelta &&
        scenario.physicalDelta === expected.physicalDelta &&
        scenario.isAligned === expected.isAligned &&
        scenario.isDivergent === expected.isDivergent &&
        scenario.isDegraded === expected.isDegraded &&
        scenario.degradedMarkerCount === (scenario.isDegraded ? 1 : 0) &&
        scenario.markerSemanticsValid === expected.markerSemanticsValid
      )
    })
  const derivedParityMatches =
    classificationsMatch &&
    scenarios.every((scenario) => {
      const derivedAligned = scenario.catalogDelta === 0 && scenario.physicalDelta === 0 && !scenario.isDegraded
      const derivedDivergent = scenario.catalogDelta !== 0 || scenario.physicalDelta !== 0 || scenario.isDegraded
      const catalogAlignmentMatches = scenario.catalogAligned === (scenario.catalogDelta === 0)
      const physicalAlignmentMatches = scenario.physicalAligned === (scenario.physicalDelta === 0)
      return (
        scenario.isAligned === derivedAligned &&
        scenario.isDivergent === derivedDivergent &&
        catalogAlignmentMatches &&
        physicalAlignmentMatches
      )
    })
  const parityPassed = hasClosedScenarioSet && classificationsMatch && derivedParityMatches
  const completenessPassed =
    scenarios.length === expectedScenarioCount &&
    observedReferenceCount === expectedReferenceCount &&
    alignedCount === 1 &&
    divergentCount === expectedScenarioCount - 1 &&
    degradedCount === 1

  return [
    {
      id: 'scenario.completeness',
      name: 'Synthetic scenario and reference completeness',
      kind: 'correctness',
      passed: completenessPassed,
      detail: boundedDetail(
        `scenarios=${scenarios.length} expected=${expectedScenarioCount} references=${observedReferenceCount}`
      )
    },
    {
      id: 'parity.divergence',
      name: 'Canonical reference/catalog/physical parity and divergence classification',
      kind: 'correctness',
      passed: parityPassed,
      detail: boundedDetail(
        `closed=${hasClosedScenarioSet ? 'true' : 'false'} classified=${classificationsMatch ? 'true' : 'false'} derived=${derivedParityMatches ? 'true' : 'false'}`
      )
    },
    {
      id: 'degraded.marker',
      name: 'Degraded attachment marker semantics',
      kind: 'correctness',
      passed: markersValid && degradedCount === 1 && markerCardinalityPassed,
      detail: boundedDetail(
        `degraded=${degradedCount} markerCount=${markerCount} markers=${
          markersValid && markerCardinalityPassed ? 'valid' : 'invalid'
        }`
      )
    },
    {
      id: 'metrics.finite',
      name: 'All M5 metric values finite and non-negative',
      kind: 'correctness',
      passed: finitePassed,
      detail: boundedDetail(`finite=${finitePassed ? 'true' : 'false'}`)
    },
    {
      id: 'output.privacy',
      name: 'Closed numeric-only privacy output',
      kind: 'correctness',
      passed: privacyPassed,
      detail: boundedDetail(`privacy=${privacyPassed ? 'valid' : 'invalid'}`)
    }
  ]
}

export function summarizeM5FileDualState(profile: M5Profile, observedReferenceCount = profile.references): M5Summary {
  const scenarios = calculateM5ScenarioParitySet(buildM5Scenarios({ ...profile, references: observedReferenceCount }))
  const metrics = buildM5FileDualStateMetrics(scenarios, observedReferenceCount)
  const gates = buildM5FileDualStateGates({
    scenarios,
    expectedScenarioCount: M5_SCENARIO_COUNT,
    expectedReferenceCount: profile.references,
    observedReferenceCount,
    metrics
  })
  return { scenarios, metrics, gates }
}

export function assertM5FiniteMetrics(metrics: readonly BenchmarkMetric[]): void {
  for (const metric of metrics) {
    if (!Number.isFinite(metric.value) || metric.value < 0) {
      throw new Error(`M5 metric ${metric.id} must be finite and non-negative`)
    }
  }
}

/** Return false instead of throwing when called by gate construction. */
export function assertM5PrivacyInvariants(metrics: readonly BenchmarkMetric[], throwOnFailure = true): boolean {
  try {
    for (const metric of metrics) {
      if (!/^[A-Za-z0-9._]+$/.test(metric.id)) throw new Error(`M5 metric id is not closed: ${metric.id}`)
      if (/[\\/]/.test(metric.name)) throw new Error(`M5 metric name contains a path segment: ${metric.id}`)
      if (!Number.isFinite(metric.value) || metric.value < 0) {
        throw new Error(`M5 metric ${metric.id} must be finite and non-negative`)
      }
      if (metric.unit !== undefined && metric.unit !== 'count') {
        throw new Error(`M5 metric ${metric.id} has an unexpected unit`)
      }
    }
    return true
  } catch (error) {
    if (throwOnFailure) throw error
    return false
  }
}
