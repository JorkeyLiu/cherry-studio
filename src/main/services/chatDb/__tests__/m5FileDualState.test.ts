/** Focused pure contract tests for the M5 synthetic file dual-state helper. */

import { describe, expect, it } from 'vitest'

import { validateBenchmarkResult } from './benchResult'
import {
  assertM5FiniteMetrics,
  assertM5PrivacyInvariants,
  buildM5FileDualStateGates,
  buildM5FileDualStateMetrics,
  buildM5Scenarios,
  calculateM5ScenarioParity,
  calculateM5ScenarioParitySet,
  DEFAULT_M5_FILE_DUAL_SCALE,
  M5_FILE_DUAL_BENCH_ENV,
  M5_FILE_DUAL_COMMAND,
  M5_FILE_DUAL_PROFILES,
  M5_FILE_DUAL_SCALE_ENV,
  M5_SCENARIO_COUNT,
  m5ScaleMetadata,
  resolveM5FileDualGate,
  resolveM5FileDualScale,
  summarizeM5FileDualState
} from './m5FileDualState'

describe('M5 file dual-state env and profile contracts', () => {
  it('is inert unless explicitly enabled with 1 or true', () => {
    expect(resolveM5FileDualGate(undefined)).toBe(false)
    expect(resolveM5FileDualGate('')).toBe(false)
    expect(resolveM5FileDualGate('  ')).toBe(false)
    expect(resolveM5FileDualGate('1')).toBe(true)
    expect(resolveM5FileDualGate(' TRUE ')).toBe(true)
    for (const value of ['0', 'false', 'yes', 'on', '2']) {
      expect(() => resolveM5FileDualGate(value)).toThrow(M5_FILE_DUAL_BENCH_ENV)
    }
  })

  it('resolves only bounded small and medium profiles', () => {
    expect(DEFAULT_M5_FILE_DUAL_SCALE).toBe('medium')
    expect(resolveM5FileDualScale(undefined)).toBe('medium')
    expect(resolveM5FileDualScale(' small ')).toBe('small')
    expect(resolveM5FileDualScale('medium')).toBe('medium')
    expect(M5_FILE_DUAL_SCALE_ENV).toBe('M5_FILE_DUAL_SCALE')
    expect(() => resolveM5FileDualScale('large')).toThrow(M5_FILE_DUAL_SCALE_ENV)
    expect(M5_FILE_DUAL_PROFILES.small.references).toBe(100)
    expect(M5_FILE_DUAL_PROFILES.medium.references).toBe(1_000)
    expect(Object.values(m5ScaleMetadata(M5_FILE_DUAL_PROFILES.medium)).every(Number.isFinite)).toBe(true)
  })

  it('declares a path-free canonical M5 command', () => {
    expect(M5_FILE_DUAL_COMMAND).toBe('pnpm bench:m5-file-dual-state')
    expect(M5_FILE_DUAL_COMMAND).not.toMatch(/[\\/]/)
  })
})

describe('M5 deterministic scenario and parity model', () => {
  it('builds the same bounded scenario matrix for repeated calls', () => {
    const profile = M5_FILE_DUAL_PROFILES.small
    expect(buildM5Scenarios(profile)).toEqual(buildM5Scenarios(profile))
    expect(buildM5Scenarios(profile)).toHaveLength(M5_SCENARIO_COUNT)
    expect(buildM5Scenarios(profile).map((scenario) => scenario.key)).toEqual([
      'aligned',
      'catalog-drift',
      'physical-missing',
      'degraded-marker'
    ])
  })

  it('classifies aligned, catalog drift, physical missing, and degraded marker states', () => {
    const states = calculateM5ScenarioParitySet(buildM5Scenarios(M5_FILE_DUAL_PROFILES.small))
    expect(states.map((state) => [state.isAligned, state.isDivergent, state.isDegraded])).toEqual([
      [true, false, false],
      [false, true, false],
      [false, true, false],
      [false, true, true]
    ])
    expect(states[1].catalogDelta).toBe(1)
    expect(states[2].physicalDelta).toBe(1)
    expect(states[3].markerSemanticsValid).toBe(true)
  })

  it('requires degraded markers to accompany both synthetic divergences', () => {
    const scenario = buildM5Scenarios(M5_FILE_DUAL_PROFILES.small).find((item) => item.key === 'degraded-marker')!
    expect(calculateM5ScenarioParity({ ...scenario, catalogCount: scenario.referenceCount })).toMatchObject({
      isDegraded: true,
      markerSemanticsValid: false
    })
  })

  it('requires exactly one marker for the degraded scenario', () => {
    const scenario = buildM5Scenarios(M5_FILE_DUAL_PROFILES.small).find((item) => item.key === 'degraded-marker')!
    expect(calculateM5ScenarioParity({ ...scenario, degradedMarkerCount: 0 }).markerSemanticsValid).toBe(false)
    expect(calculateM5ScenarioParity({ ...scenario, degradedMarkerCount: 2 }).markerSemanticsValid).toBe(false)
  })

  it('fails the parity gate for a wrong closed scenario map', () => {
    const profile = M5_FILE_DUAL_PROFILES.small
    const scenarios = calculateM5ScenarioParitySet(buildM5Scenarios(profile))
    const metrics = buildM5FileDualStateMetrics(scenarios, profile.references)
    const gates = buildM5FileDualStateGates({
      scenarios: scenarios.map((scenario) =>
        scenario.key === 'catalog-drift' ? { ...scenario, physicalDelta: 1 } : scenario
      ),
      expectedScenarioCount: M5_SCENARIO_COUNT,
      expectedReferenceCount: profile.references,
      observedReferenceCount: profile.references,
      metrics
    })
    expect(gates.find((gate) => gate.id === 'parity.divergence')?.passed).toBe(false)
  })

  it('fails the parity gate when catalog or physical alignment booleans disagree with deltas', () => {
    const profile = M5_FILE_DUAL_PROFILES.small
    const scenarios = calculateM5ScenarioParitySet(buildM5Scenarios(profile))
    const metrics = buildM5FileDualStateMetrics(scenarios, profile.references)

    for (const field of ['catalogAligned', 'physicalAligned'] as const) {
      const mutatedScenarios = scenarios.map((scenario) =>
        scenario.key === 'aligned' ? { ...scenario, [field]: false } : scenario
      )
      const gates = buildM5FileDualStateGates({
        scenarios: mutatedScenarios,
        expectedScenarioCount: M5_SCENARIO_COUNT,
        expectedReferenceCount: profile.references,
        observedReferenceCount: profile.references,
        metrics
      })

      expect(gates.find((gate) => gate.id === 'parity.divergence')).toMatchObject({
        passed: false,
        detail: expect.stringContaining('derived=false')
      })
    }
  })
})

describe('M5 metrics, gates, and closed-output invariants', () => {
  it('derives parity/divergence/degraded counts without raw identifiers', () => {
    const profile = M5_FILE_DUAL_PROFILES.medium
    const summary = summarizeM5FileDualState(profile)
    expect(summary.metrics.map((metric) => metric.id)).toEqual([
      'scenario.count',
      'reference.count',
      'scenario.aligned.count',
      'scenario.divergent.count',
      'scenario.degraded.count',
      'catalog.parity.count',
      'physical.parity.count',
      'degraded.marker.count'
    ])
    expect(summary.metrics.map((metric) => metric.value)).toEqual([4, 1_000, 1, 3, 1, 2, 2, 1])
    expect(summary.gates.every((gate) => gate.passed)).toBe(true)
    const metricFields = new Set(['id', 'name', 'value', 'unit'])
    const gateFields = new Set(['id', 'name', 'kind', 'passed', 'detail'])
    expect(summary.metrics.every((metric) => Object.keys(metric).every((key) => metricFields.has(key)))).toBe(true)
    expect(summary.gates.every((gate) => Object.keys(gate).every((key) => gateFields.has(key)))).toBe(true)
    const serializedOutput = JSON.stringify({ metrics: summary.metrics, gates: summary.gates })
    expect(serializedOutput).not.toMatch(/"(?:path|content|credential|rawId)"\s*:/i)

    const malformedMetricOutput = JSON.parse(serializedOutput) as {
      metrics: Array<Record<string, unknown>>
      gates: Array<Record<string, unknown>>
    }
    malformedMetricOutput.metrics[0].rawId = 'synthetic-raw-id'
    expect(Object.keys(malformedMetricOutput.metrics[0])).not.toEqual(Object.keys(summary.metrics[0]))
  })

  it('emits finite numeric metrics and explicit physical booleans as counts only', () => {
    const scenarios = calculateM5ScenarioParitySet(buildM5Scenarios(M5_FILE_DUAL_PROFILES.small))
    const metrics = buildM5FileDualStateMetrics(scenarios, 100)
    expect(() => assertM5FiniteMetrics(metrics)).not.toThrow()
    expect(metrics.some((metric) => metric.id.includes('size'))).toBe(false)
    expect(metrics.some((metric) => metric.id.includes('physical.present'))).toBe(false)
    expect(() => assertM5PrivacyInvariants(metrics)).not.toThrow()
  })

  it('rejects negative metric values in finite and privacy gates', () => {
    const metrics = [{ id: 'negative', name: 'Negative metric', value: -1 }]
    expect(() => assertM5FiniteMetrics(metrics)).toThrow('finite and non-negative')
    expect(() => assertM5PrivacyInvariants(metrics)).toThrow('finite and non-negative')

    const profile = M5_FILE_DUAL_PROFILES.small
    const summary = summarizeM5FileDualState(profile)
    const gates = buildM5FileDualStateGates({
      scenarios: summary.scenarios,
      expectedScenarioCount: M5_SCENARIO_COUNT,
      expectedReferenceCount: profile.references,
      observedReferenceCount: profile.references,
      metrics: [...summary.metrics, ...metrics]
    })
    expect(gates.find((gate) => gate.id === 'metrics.finite')?.passed).toBe(false)
    expect(gates.find((gate) => gate.id === 'output.privacy')?.passed).toBe(false)
  })

  it('fails the degraded marker gate for marker cardinality zero or greater than one', () => {
    const profile = M5_FILE_DUAL_PROFILES.small
    const scenarios = calculateM5ScenarioParitySet(buildM5Scenarios(profile))
    for (const degradedMarkerCount of [0, 2]) {
      const mutatedScenarios = scenarios.map((scenario) =>
        scenario.key === 'degraded-marker' ? { ...scenario, degradedMarkerCount } : scenario
      )
      const gates = buildM5FileDualStateGates({
        scenarios: mutatedScenarios,
        expectedScenarioCount: M5_SCENARIO_COUNT,
        expectedReferenceCount: profile.references,
        observedReferenceCount: profile.references,
        metrics: buildM5FileDualStateMetrics(mutatedScenarios, profile.references)
      })
      expect(gates.find((gate) => gate.id === 'degraded.marker')).toMatchObject({
        passed: false,
        detail: expect.stringMatching(new RegExp(`degraded=1 markerCount=${degradedMarkerCount} .*invalid`))
      })
    }
  })

  it('fails closed for wrong observed reference count', () => {
    const profile = M5_FILE_DUAL_PROFILES.small
    const summary = summarizeM5FileDualState(profile, 99)
    expect(summary.gates.find((gate) => gate.id === 'scenario.completeness')?.passed).toBe(false)
  })

  it('keeps a schema-v1 result closed and numeric-only', () => {
    const profile = M5_FILE_DUAL_PROFILES.small
    const summary = summarizeM5FileDualState(profile)
    const result = {
      schemaVersion: 1,
      benchmark: {
        id: 'chatdb-m5-file-dual-state',
        name: 'M5 synthetic file dual-state diagnostic',
        scale: m5ScaleMetadata(profile)
      },
      environment: {
        timestamp: '2026-08-28T00:00:00.000Z',
        node: 'v24.11.1',
        pnpm: '10.27.0',
        abiLane: 'node',
        abi: '137',
        command: M5_FILE_DUAL_COMMAND,
        git: { commit: '', dirty: false }
      },
      metrics: summary.metrics,
      gates: summary.gates
    }
    expect(validateBenchmarkResult(result)).toEqual([])
    for (const unsafeField of ['path', 'content', 'credential', 'rawId']) {
      expect(
        validateBenchmarkResult({
          ...result,
          metrics: [...result.metrics, { id: 'unsafe', name: 'unsafe', value: 1, [unsafeField]: 'blocked' }]
        })
      ).not.toEqual([])
    }
  })
})
