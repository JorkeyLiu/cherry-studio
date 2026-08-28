/**
 * Pure deterministic tests for PERF-C02 heap calibration helper
 * (tests/e2e/utils/perfHeapCalibration.ts). Runs in Node e2e-utils lane.
 */
import { describe, expect, it } from 'vitest'

import {
  buildC02BenchmarkResult,
  buildC02MixedBenchmarkResult,
  buildC02MixedScaleMap,
  buildC02MixedSyntheticTopics,
  buildC02MixedSyntheticTopicsWithPrefix,
  buildC02MultiBenchmarkResult,
  buildC02MultiScaleMap,
  buildC02ScaleMap,
  buildC02SyntheticTopics,
  buildC02SyntheticTopicsWithPrefix,
  C02_BENCHMARK_ID,
  C02_DEFAULT_CONTEXTCOUNT,
  C02_HEAP_PROFILE_IDS,
  C02_HEAP_PROFILES,
  C02_MIXED_HEAP_PROFILE_IDS,
  C02_MIXED_HEAP_PROFILES,
  C02_MIXED_HEAP_PROFILE_ORDER,
  C02_PRODUCTION_WINDOW_MAX,
  C02_PRODUCTION_WINDOW_MIN,
  c02ExpectedProjectedTotalForTopics,
  c02ExpectedVisibleCount,
  c02ExpectedVisibleCountForTopic,
  c02ExpectedProjectedTotal,
  c02HeapGateEnabled,
  c02MixedExpectedProjectedTotal,
  c02MixedExpectedVisibleCountForSpec,
  c02MixedTotalMessages,
  c02PerTopicExpectedVisibleCounts,
  canonicalBytesForTopic,
  canonicalBytesForTopics,
  classifyEffectiveHeapDeltaInformative,
  classifyHeapDeltaInformative,
  computeHeapAmplification,
  DEFAULT_C02_HEAP_PROFILE,
  deriveEffectiveHeapInformative,
  deriveFinalTopicDomProof,
  deriveGroupCountExact,
  detectHeapPrecisionLabel,
  getC02MixedHeapProfileMatrix,
  HEAP_METHOD_CODE,
  HEAP_PRECISION_CODE,
  isC02ContextEvidenceValid,
  isC02ExactTopicOwned,
  isC02MixedHeapProfile,
  isC02ProductionPathComplete,
  isC02WholeTopicWindow,
  isEffectiveHeapDeltaInformative,
  PERF_C02_HEAP_ENV,
  RENDERER_HEAP_METHOD,
  resolveC02HeapProfiles,
  resolveC02HeapProfile,
  validateC02MixedHeapProfile,
  validateHeapSample,
  validateLogicalBytes,
  validateSyntheticTopics,
  type RendererHeapSample
} from './perfHeapCalibration'
import { validateBenchmarkResult, type BenchmarkResult } from '../../../src/main/services/chatDb/__tests__/benchResult'

const ORIGINAL_ENV = process.env[PERF_C02_HEAP_ENV]

function withEnv(value: string | undefined, fn: () => void): void {
  const previous = process.env[PERF_C02_HEAP_ENV]
  if (value === undefined) delete process.env[PERF_C02_HEAP_ENV]
  else process.env[PERF_C02_HEAP_ENV] = value
  try {
    fn()
  } finally {
    if (previous === undefined) delete process.env[PERF_C02_HEAP_ENV]
    else process.env[PERF_C02_HEAP_ENV] = previous
  }
}

describe('c02HeapGateEnabled', () => {
  it('is false when unset or empty (default-off, inert)', () => {
    withEnv(undefined, () => expect(c02HeapGateEnabled()).toBe(false))
    withEnv('', () => expect(c02HeapGateEnabled()).toBe(false))
    withEnv('   ', () => expect(c02HeapGateEnabled()).toBe(false))
  })

  it('is true for any non-empty value (invalid values reach resolver)', () => {
    withEnv('1', () => expect(c02HeapGateEnabled()).toBe(true))
    withEnv('true', () => expect(c02HeapGateEnabled()).toBe(true))
    withEnv('TRUE', () => expect(c02HeapGateEnabled()).toBe(true))
    withEnv('bogus', () => expect(c02HeapGateEnabled()).toBe(true))
  })
})

describe('resolveC02HeapProfile', () => {
  it('resolves 1 and true to the default profile', () => {
    withEnv('1', () => {
      const p = resolveC02HeapProfile()
      expect(p).toEqual(DEFAULT_C02_HEAP_PROFILE)
    })
    withEnv('true', () => {
      const p = resolveC02HeapProfile()
      expect(p).toEqual(DEFAULT_C02_HEAP_PROFILE)
    })
    withEnv('TRUE', () => {
      const p = resolveC02HeapProfile()
      expect(p.syntheticTopics).toBe(2)
    })
  })

  it('throws on unsupported non-empty value', () => {
    withEnv('bogus', () => expect(() => resolveC02HeapProfile()).toThrow(/unsupported/))
    withEnv('0', () => expect(() => resolveC02HeapProfile()).toThrow(/unsupported/))
    withEnv('scan', () => expect(() => resolveC02HeapProfile()).toThrow(/unsupported/))
  })
})

describe('canonicalBytesForTopics', () => {
  it('returns finite positive bytes for the default synthetic profile', () => {
    const topics = buildC02SyntheticTopics(DEFAULT_C02_HEAP_PROFILE)
    const bytes = canonicalBytesForTopics(topics)
    expect(Number.isFinite(bytes)).toBe(true)
    expect(bytes).toBeGreaterThan(0)
    // Deterministic — same input same bytes
    const bytes2 = canonicalBytesForTopics(buildC02SyntheticTopics(DEFAULT_C02_HEAP_PROFILE))
    expect(bytes).toBe(bytes2)
  })

  it('is monotonic with blockContentBytes', () => {
    const small = buildC02SyntheticTopics({ ...DEFAULT_C02_HEAP_PROFILE, blockContentBytes: 256 })
    const large = buildC02SyntheticTopics({ ...DEFAULT_C02_HEAP_PROFILE, blockContentBytes: 1024 })
    expect(canonicalBytesForTopics(small)).toBeLessThan(canonicalBytesForTopics(large))
  })

  it('single topic bytes equals topic helper', () => {
    const topics = buildC02SyntheticTopics(DEFAULT_C02_HEAP_PROFILE)
    const single = canonicalBytesForTopic(topics[0]!)
    expect(single).toBeGreaterThan(0)
    const aggregate = canonicalBytesForTopics([topics[0]!])
    expect(aggregate).toBe(single)
  })

  it('all synthetic topics pass validation', () => {
    const topics = buildC02SyntheticTopics(DEFAULT_C02_HEAP_PROFILE)
    expect(validateSyntheticTopics(topics)).toEqual([])
  })

  it('rejects empty topics', () => {
    expect(validateSyntheticTopics([]).length).toBeGreaterThan(0)
  })
})

describe('validateHeapSample', () => {
  const valid: RendererHeapSample = {
    method: RENDERER_HEAP_METHOD,
    usedJSHeapSize: 50_000_000,
    totalJSHeapSize: 100_000_000,
    jsHeapSizeLimit: 2_000_000_000
  }

  it('passes for a valid performance.memory sample', () => {
    expect(validateHeapSample(valid)).toEqual([])
  })

  it('fails when sample is null (unsupported environment)', () => {
    const problems = validateHeapSample(null)
    expect(problems.length).toBeGreaterThan(0)
    expect(problems[0]).toMatch(/unavailable/)
  })

  it('fails when used exceeds total', () => {
    const bad = { ...valid, usedJSHeapSize: 150_000_000, totalJSHeapSize: 100_000_000 }
    expect(validateHeapSample(bad).join(' ')).toMatch(/must not exceed/)
  })

  it('fails on non-finite values', () => {
    const bad = { ...valid, usedJSHeapSize: NaN }
    expect(validateHeapSample(bad).length).toBeGreaterThan(0)
  })
})

describe('validateLogicalBytes', () => {
  it('passes for positive finite', () => {
    expect(validateLogicalBytes(12345)).toEqual([])
  })
  it('fails for non-positive', () => {
    expect(validateLogicalBytes(0).length).toBeGreaterThan(0)
    expect(validateLogicalBytes(-1).length).toBeGreaterThan(0)
    expect(validateLogicalBytes(NaN).length).toBeGreaterThan(0)
  })
})

describe('computeHeapAmplification', () => {
  it('computes delta and ratios separately', () => {
    const before: RendererHeapSample = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 10_000_000,
      totalJSHeapSize: 50_000_000,
      jsHeapSizeLimit: 2_000_000_000
    }
    const after: RendererHeapSample = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 12_000_000,
      totalJSHeapSize: 50_000_000,
      jsHeapSizeLimit: 2_000_000_000
    }
    const amp = computeHeapAmplification(before, after, 1_000_000)
    expect(amp.heapDeltaBytes).toBe(2_000_000)
    expect(amp.deltaRatio).toBeCloseTo(2)
    expect(amp.absoluteRatio).toBeCloseTo(12)
  })

  it('returns 0 ratios when logicalBytes is 0', () => {
    const s: RendererHeapSample = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 10_000_000,
      totalJSHeapSize: 50_000_000,
      jsHeapSizeLimit: 2_000_000_000
    }
    const amp = computeHeapAmplification(s, s, 0)
    expect(amp.deltaRatio).toBe(0)
    expect(amp.absoluteRatio).toBe(0)
  })

  it('handles negative delta (GC) as finite', () => {
    const before: RendererHeapSample = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 12_000_000,
      totalJSHeapSize: 50_000_000,
      jsHeapSizeLimit: 2_000_000_000
    }
    const after: RendererHeapSample = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 10_000_000,
      totalJSHeapSize: 50_000_000,
      jsHeapSizeLimit: 2_000_000_000
    }
    const amp = computeHeapAmplification(before, after, 1_000_000)
    expect(amp.heapDeltaBytes).toBe(-2_000_000)
    expect(Number.isFinite(amp.deltaRatio)).toBe(true)
  })
})

describe('classifyHeapDeltaInformative', () => {
  it('marks zero delta as inconclusive, not amplification 0 evidence', () => {
    const r = classifyHeapDeltaInformative(0)
    expect(r.informative).toBe(false)
    expect(r.reason).toMatch(/bucketed|inconclusive/i)
    expect(r.reason).toMatch(/not amplification 0/)
  })

  it('marks negative delta as inconclusive (GC noise)', () => {
    const r = classifyHeapDeltaInformative(-5000)
    expect(r.informative).toBe(false)
    expect(r.reason).toMatch(/negative|GC/i)
  })

  it('marks non-finite delta as inconclusive', () => {
    expect(classifyHeapDeltaInformative(NaN).informative).toBe(false)
    expect(classifyHeapDeltaInformative(Infinity).informative).toBe(false)
  })

  it('marks finite positive delta as informative', () => {
    const r = classifyHeapDeltaInformative(12345)
    expect(r.informative).toBe(true)
    expect(r.reason).toMatch(/informative/)
  })

  it('never allows zero to be claimed as amplification 0', () => {
    // The caller must check informative before using deltaRatio as evidence.
    const amp = computeHeapAmplification(
      {
        method: RENDERER_HEAP_METHOD,
        usedJSHeapSize: 10_000_000,
        totalJSHeapSize: 50_000_000,
        jsHeapSizeLimit: 2_000_000_000
      },
      {
        method: RENDERER_HEAP_METHOD,
        usedJSHeapSize: 10_000_000,
        totalJSHeapSize: 50_000_000,
        jsHeapSizeLimit: 2_000_000_000
      },
      500_000
    )
    expect(amp.deltaRatio).toBe(0)
    const cls = classifyHeapDeltaInformative(amp.heapDeltaBytes)
    expect(cls.informative).toBe(false)
    // Artifact must not treat this as passed amplification 0
  })
})

describe('classifyEffectiveHeapDeltaInformative — single authoritative definition', () => {
  it('effective = precise && finite positive delta', () => {
    expect(classifyEffectiveHeapDeltaInformative(1000, 'precise').informative).toBe(true)
    expect(classifyEffectiveHeapDeltaInformative(0, 'precise').informative).toBe(false)
    expect(classifyEffectiveHeapDeltaInformative(-10, 'precise').informative).toBe(false)
    expect(classifyEffectiveHeapDeltaInformative(NaN, 'precise').informative).toBe(false)
  })

  it('bucketed positive delta is inconclusive (not valid amplification) — raw heap.delta remains diagnostic but ratio must be 0', () => {
    const r = classifyEffectiveHeapDeltaInformative(5000, 'bucketed')
    expect(r.informative).toBe(false)
    expect(r.reason).toMatch(/bucketed|precise/i)
    // Effective boolean is the single value for metric/gate/ratio
    expect(isEffectiveHeapDeltaInformative(5000, 'bucketed')).toBe(false)
    expect(isEffectiveHeapDeltaInformative(5000, 'precise')).toBe(true)
  })

  it('unsupported precision is inconclusive even with positive delta', () => {
    expect(classifyEffectiveHeapDeltaInformative(5000, 'unsupported').informative).toBe(false)
    expect(isEffectiveHeapDeltaInformative(5000, 'unsupported')).toBe(false)
  })

  it('zero/negative/non-finite are inconclusive regardless of precision', () => {
    expect(classifyEffectiveHeapDeltaInformative(0, 'precise').informative).toBe(false)
    expect(classifyEffectiveHeapDeltaInformative(-1, 'precise').informative).toBe(false)
    expect(classifyEffectiveHeapDeltaInformative(Infinity, 'precise').informative).toBe(false)
    expect(classifyEffectiveHeapDeltaInformative(0, 'bucketed').informative).toBe(false)
  })

  it('bucketed delta must not be emitted as valid amplification — caller must use effective for ratio', () => {
    const before: RendererHeapSample = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 10_000_000,
      totalJSHeapSize: 50_000_000,
      jsHeapSizeLimit: 2_000_000_000
    }
    const after: RendererHeapSample = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 10_010_000,
      totalJSHeapSize: 50_000_000,
      jsHeapSizeLimit: 2_000_000_000
    }
    const amp = computeHeapAmplification(before, after, 500_000)
    expect(amp.heapDeltaBytes).toBe(10_000)
    // Raw diagnostic exists
    expect(amp.deltaRatio).toBeCloseTo(0.02)
    // But effective with bucketed is not valid
    const effBucketed = classifyEffectiveHeapDeltaInformative(amp.heapDeltaBytes, 'bucketed')
    expect(effBucketed.informative).toBe(false)
    const effectiveDeltaRatio = effBucketed.informative ? amp.deltaRatio : 0
    expect(effectiveDeltaRatio).toBe(0)
    // With precise it becomes valid
    const effPrecise = classifyEffectiveHeapDeltaInformative(amp.heapDeltaBytes, 'precise')
    expect(effPrecise.informative).toBe(true)
    expect(effPrecise.informative ? amp.deltaRatio : 0).toBeCloseTo(0.02)
  })
})

describe('detectHeapPrecisionLabel', () => {
  it('returns precise only with exact --enable-precise-memory-info token', () => {
    expect(
      detectHeapPrecisionLabel(['electron', '--enable-precise-memory-info', '--no-sandbox'], RENDERER_HEAP_METHOD)
    ).toBe('precise')
    expect(detectHeapPrecisionLabel(['--enable-precise-memory-info'], RENDERER_HEAP_METHOD)).toBe('precise')
  })

  it('returns bucketed when flag absent but method available', () => {
    expect(detectHeapPrecisionLabel(['electron', '--no-sandbox'], RENDERER_HEAP_METHOD)).toBe('bucketed')
    expect(detectHeapPrecisionLabel([], RENDERER_HEAP_METHOD)).toBe('bucketed')
  })

  it('returns bucketed for substring and variant forms — exact token required', () => {
    expect(detectHeapPrecisionLabel(['electron', '--enable-precise-memory-info-foo'], RENDERER_HEAP_METHOD)).toBe(
      'bucketed'
    )
    expect(detectHeapPrecisionLabel(['electron', 'enable-precise-memory-info'], RENDERER_HEAP_METHOD)).toBe('bucketed')
    expect(detectHeapPrecisionLabel(['electron', '--enable-precise-memory-info=true'], RENDERER_HEAP_METHOD)).toBe(
      'bucketed'
    )
    expect(detectHeapPrecisionLabel(['electron', '--enable-precise-memory-info '], RENDERER_HEAP_METHOD)).toBe(
      'bucketed'
    )
    expect(detectHeapPrecisionLabel(['electron', '--foo-enable-precise-memory-info'], RENDERER_HEAP_METHOD)).toBe(
      'bucketed'
    )
    expect(detectHeapPrecisionLabel(['electron', '--ENABLE-PRECISE-MEMORY-INFO'], RENDERER_HEAP_METHOD)).toBe(
      'bucketed'
    )
  })

  it('returns unsupported when method unsupported', () => {
    expect(detectHeapPrecisionLabel(['electron', '--enable-precise-memory-info'], 'unsupported')).toBe('unsupported')
  })

  it('returns unsupported when method not performance.memory', () => {
    expect(detectHeapPrecisionLabel(['electron'], 'other')).toBe('unsupported')
  })

  it('returns unsupported regardless of flag when method is not performance.memory', () => {
    expect(detectHeapPrecisionLabel(['--enable-precise-memory-info'], 'unsupported')).toBe('unsupported')
    expect(detectHeapPrecisionLabel(['--enable-precise-memory-info'], 'other')).toBe('unsupported')
  })
})

describe('buildC02ScaleMap', () => {
  it('produces finite numeric scale map for performance.memory with precise', () => {
    const map = buildC02ScaleMap(DEFAULT_C02_HEAP_PROFILE, RENDERER_HEAP_METHOD, 'precise')
    for (const [k, v] of Object.entries(map)) {
      expect(Number.isFinite(v), `scale.${k} must be finite`).toBe(true)
    }
    expect(map.heapMethodCode).toBe(HEAP_METHOD_CODE[RENDERER_HEAP_METHOD])
    expect(map.heapPrecisionCode).toBe(HEAP_PRECISION_CODE.precise)
    expect(map.syntheticTopics).toBe(2)
    expect(map.syntheticMessagesTotal).toBe(200)
  })

  it('maps bucketed and unsupported precision codes', () => {
    const bucketed = buildC02ScaleMap(DEFAULT_C02_HEAP_PROFILE, RENDERER_HEAP_METHOD, 'bucketed')
    expect(bucketed.heapPrecisionCode).toBe(HEAP_PRECISION_CODE.bucketed)
    const unsupported = buildC02ScaleMap(DEFAULT_C02_HEAP_PROFILE, 'unsupported', 'unsupported')
    expect(unsupported.heapMethodCode).toBe(-1)
    expect(unsupported.heapPrecisionCode).toBe(-1)
  })

  it('maps unsupported method to -1', () => {
    const map = buildC02ScaleMap(DEFAULT_C02_HEAP_PROFILE, 'unsupported')
    expect(map.heapMethodCode).toBe(-1)
  })
})

describe('c02ExpectedVisibleCount — production latest-window clamp 1..100 (calibration must measure actual projection)', () => {
  it('mirrors production clampWindowLimit max 100', () => {
    expect(C02_PRODUCTION_WINDOW_MAX).toBe(100)
    expect(C02_PRODUCTION_WINDOW_MIN).toBe(1)
  })

  it('caps large profile 150 to 100 while retaining logical payload 150', () => {
    const large = C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.large]!
    expect(large.syntheticMessagesPerTopic).toBe(150)
    expect(c02ExpectedVisibleCount(large)).toBe(100)
    expect(c02ExpectedProjectedTotal(large)).toBe(large.syntheticTopics * 100)
    // canonical logical bytes remain on full 150 (retained payload), not truncated
    const topics = buildC02SyntheticTopics(large)
    const logical = canonicalBytesForTopics(topics)
    expect(logical).toBeGreaterThan(0)
    // Logical for large must be > logical for default 100 (proves retained > projected)
    const defaultTopics = buildC02SyntheticTopics(C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.default]!)
    expect(logical).toBeGreaterThan(canonicalBytesForTopics(defaultTopics))
  })

  it('leaves small/default/boundary within cap unchanged (50→50, 100→100, 30→30)', () => {
    expect(c02ExpectedVisibleCount(C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.small]!)).toBe(50)
    expect(c02ExpectedVisibleCount(C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.default]!)).toBe(100)
    expect(c02ExpectedVisibleCount(C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.boundary]!)).toBe(30)
    expect(c02ExpectedProjectedTotal(C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.small]!)).toBe(50)
    expect(c02ExpectedProjectedTotal(C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.default]!)).toBe(200)
    expect(c02ExpectedProjectedTotal(C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.boundary]!)).toBe(60)
  })

  it('clamps edge values to 1..100 contract', () => {
    expect(c02ExpectedVisibleCount({ syntheticMessagesPerTopic: 0 } as any)).toBe(1)
    expect(c02ExpectedVisibleCount({ syntheticMessagesPerTopic: 1 } as any)).toBe(1)
    expect(c02ExpectedVisibleCount({ syntheticMessagesPerTopic: 100 } as any)).toBe(100)
    expect(c02ExpectedVisibleCount({ syntheticMessagesPerTopic: 101 } as any)).toBe(100)
    expect(c02ExpectedVisibleCount({ syntheticMessagesPerTopic: 150 } as any)).toBe(100)
    expect(c02ExpectedVisibleCount({ syntheticMessagesPerTopic: 1000 } as any)).toBe(100)
  })
})

describe('constants', () => {
  it('benchmark id is distinct and stable', () => {
    expect(C02_BENCHMARK_ID).toBe('chatdb-c02-renderer-heap-e2e')
    expect(C02_BENCHMARK_ID).not.toBe('chatdb-stream-render-e2e-n1')
  })

  it('restores original env', () => {
    expect(process.env[PERF_C02_HEAP_ENV]).toBe(ORIGINAL_ENV)
  })
})

describe('mixed resident-topic distribution — deterministic heterogeneous shapes (measurement-only, non-adopting)', () => {
  it('all mixed profiles are deterministic and canonicalize', () => {
    for (const id of C02_MIXED_HEAP_PROFILE_ORDER) {
      const profile = C02_MIXED_HEAP_PROFILES[id]!
      expect(validateC02MixedHeapProfile(profile)).toEqual([])
      const topics = buildC02MixedSyntheticTopics(profile)
      expect(topics.length).toBe(profile.topicSpecs.length)
      expect(validateSyntheticTopics(topics)).toEqual([])
      const bytes = canonicalBytesForTopics(topics)
      expect(Number.isFinite(bytes) && bytes > 0).toBe(true)
      // Deterministic — same input same bytes
      const bytes2 = canonicalBytesForTopics(buildC02MixedSyntheticTopics(profile))
      expect(bytes).toBe(bytes2)
    }
  })

  it('count-pressure vs byte-pressure vs balanced vs oversizedContrast have distinct byte/count shapes', () => {
    const count = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.countPressure]!
    const byte = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.bytePressure]!
    const balanced = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.balanced]!
    const oversized = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.oversizedContrast]!

    // Partition shape: topic counts reflect B-01/B-05 relevant shapes
    expect(count.topicSpecs.length).toBe(8) // B-01 count shape (max 8)
    expect(byte.topicSpecs.length).toBe(3) // byte pressure fewer topics, larger aggregate
    expect(balanced.topicSpecs.length).toBe(4)
    expect(oversized.topicSpecs.length).toBe(4)

    // Byte-pressure aggregate > balanced > count? Verified via canonical bytes monotonic check
    const countBytes = canonicalBytesForTopics(buildC02MixedSyntheticTopics(count))
    const byteBytes = canonicalBytesForTopics(buildC02MixedSyntheticTopics(byte))
    const balancedBytes = canonicalBytesForTopics(buildC02MixedSyntheticTopics(balanced))
    const oversizedBytes = canonicalBytesForTopics(buildC02MixedSyntheticTopics(oversized))

    // All finite and distinct enough to demonstrate meaningful shapes
    for (const b of [countBytes, byteBytes, balancedBytes, oversizedBytes]) {
      expect(Number.isFinite(b) && b > 0).toBe(true)
    }
    // Byte-pressure has larger average block size, thus larger bytes than count-pressure despite fewer topics
    expect(byteBytes).toBeGreaterThan(countBytes)
    // Oversized contrast dominated by single large topic: its largest topic alone > any small topic
    const oversizedTopics = buildC02MixedSyntheticTopics(oversized)
    const largestOversizedTopicBytes = canonicalBytesForTopic(oversizedTopics[0]!)
    const smallTopicBytes = canonicalBytesForTopic(oversizedTopics[1]!)
    expect(largestOversizedTopicBytes).toBeGreaterThan(smallTopicBytes * 5)
    // Balanced heterogeneous per-topic bytes are monotonically increasing with spec order
    const balancedTopics = buildC02MixedSyntheticTopics(balanced)
    const balancedPerTopicBytes = balancedTopics.map(canonicalBytesForTopic)
    for (let i = 1; i < balancedPerTopicBytes.length; i++) {
      expect(balancedPerTopicBytes[i]).toBeGreaterThan(balancedPerTopicBytes[i - 1]!)
    }
  })

  it('mixed expected visible and projected totals respect production window clamp (100)', () => {
    const oversized = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.oversizedContrast]!
    // 200 → clamped 100, 20 → 20
    expect(c02MixedExpectedVisibleCountForSpec(oversized.topicSpecs[0]!)).toBe(100)
    expect(c02MixedExpectedVisibleCountForSpec(oversized.topicSpecs[1]!)).toBe(20)
    expect(c02MixedExpectedProjectedTotal(oversized)).toBe(100 + 20 + 20 + 20) // 160
    expect(c02MixedTotalMessages(oversized)).toBe(200 + 20 + 20 + 20) // 260 logical retained > projected
    // Count-pressure all 30 → total 8*30=240 both logical and projected (under cap)
    const count = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.countPressure]!
    expect(c02MixedExpectedProjectedTotal(count)).toBe(8 * 30)
    expect(c02MixedTotalMessages(count)).toBe(8 * 30)
    // Byte-pressure: 150→100, 150→100, 100→100 => total 300
    const byte = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.bytePressure]!
    expect(c02MixedExpectedProjectedTotal(byte)).toBe(100 + 100 + 100)
    // Logical bytes retain full 150+150+100=400, projected 300 demonstrates window truncation
    expect(c02MixedTotalMessages(byte)).toBe(150 + 150 + 100)
    expect(c02MixedTotalMessages(byte)).toBeGreaterThan(c02MixedExpectedProjectedTotal(byte))
  })

  it('mixed scale maps are finite scalar-only, privacy-safe, and deterministic', () => {
    for (const { id, profile } of getC02MixedHeapProfileMatrix()) {
      const scale = buildC02MixedScaleMap(profile, RENDERER_HEAP_METHOD, 'precise')
      for (const [k, v] of Object.entries(scale)) {
        expect(Number.isFinite(v), `mixed scale.${id}.${k} must be finite`).toBe(true)
      }
      expect(scale.syntheticTopics).toBe(profile.topicSpecs.length)
      expect(scale.syntheticMessagesTotal).toBe(c02MixedTotalMessages(profile))
      expect(scale.mixedDistribution).toBe(1)
      expect(scale.heapMethodCode).toBe(HEAP_METHOD_CODE[RENDERER_HEAP_METHOD])
      expect(scale.heapPrecisionCode).toBe(HEAP_PRECISION_CODE.precise)
      // Per-topic breakdown present, no content/IDs beyond numeric sizes
      for (let i = 0; i < profile.topicSpecs.length; i++) {
        const spec = profile.topicSpecs[i]!
        expect(scale[`mixed_topic_${String(i).padStart(2, '0')}_messages`]).toBe(spec.messageCount)
        expect(scale[`mixed_topic_${String(i).padStart(2, '0')}_blockBytes`]).toBe(spec.blockContentBytes)
      }
      // No non-scalar values, no hidden content — allow metric names like blockContentBytes/blockBytes but not message content
      const json = JSON.stringify(scale)
      expect(json).not.toContain('aaaa')
      expect(json).not.toMatch(/"content"\s*:/i)
      expect(json).not.toMatch(/credential/i)
    }
  })

  it('mixed matrix is deterministic, isolated ids, and selector grammar is fail-closed', () => {
    const matrix = getC02MixedHeapProfileMatrix()
    expect(matrix.length).toBe(4)
    expect(matrix.map((e) => e.id)).toEqual(C02_MIXED_HEAP_PROFILE_ORDER)
    // Isolated ids via prefix
    const prefix = 'c02-mixed-test'
    const topicsA = buildC02MixedSyntheticTopicsWithPrefix(
      C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.balanced]!,
      prefix
    )
    const topicsB = buildC02MixedSyntheticTopicsWithPrefix(
      C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.balanced]!,
      'other-prefix'
    )
    expect(topicsA[0]!.topicId).not.toBe(topicsB[0]!.topicId)
    expect(isC02MixedHeapProfile(C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.balanced]!)).toBe(true)
    expect(isC02MixedHeapProfile(C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.small]!)).toBe(false)
  })

  it('mixed resolver: mixed, all-mixed, short names, and comma lists are deterministic and fail-closed', () => {
    const withEnv = (value: string | undefined, fn: () => void) => {
      const prev = process.env[PERF_C02_HEAP_ENV]
      if (value === undefined) delete process.env[PERF_C02_HEAP_ENV]
      else process.env[PERF_C02_HEAP_ENV] = value
      try {
        fn()
      } finally {
        if (prev === undefined) delete process.env[PERF_C02_HEAP_ENV]
        else process.env[PERF_C02_HEAP_ENV] = prev
      }
    }
    withEnv('mixed', () => {
      const res = resolveC02HeapProfiles()
      expect(res.map((r) => r.id)).toEqual(C02_MIXED_HEAP_PROFILE_ORDER)
    })
    withEnv('all-mixed', () => {
      const res = resolveC02HeapProfiles()
      expect(res.map((r) => r.id)).toEqual(C02_MIXED_HEAP_PROFILE_ORDER)
    })
    withEnv('mixed-count', () => {
      const res = resolveC02HeapProfiles()
      expect(res.length).toBe(1)
      expect(res[0]!.id).toBe(C02_MIXED_HEAP_PROFILE_IDS.countPressure)
    })
    withEnv('mixed-balanced', () => {
      const res = resolveC02HeapProfiles()
      expect(res[0]!.id).toBe(C02_MIXED_HEAP_PROFILE_IDS.balanced)
    })
    withEnv('mixed-count,mixed-byte', () => {
      const res = resolveC02HeapProfiles()
      expect(res.map((r) => r.id)).toEqual([
        C02_MIXED_HEAP_PROFILE_IDS.countPressure,
        C02_MIXED_HEAP_PROFILE_IDS.bytePressure
      ])
    })
    withEnv('small,mixed-balanced', () => {
      const res = resolveC02HeapProfiles()
      expect(res.map((r) => r.id)).toEqual([C02_HEAP_PROFILE_IDS.small, C02_MIXED_HEAP_PROFILE_IDS.balanced])
    })
    withEnv('mixed-count,', () => expect(() => resolveC02HeapProfiles()).toThrow(/empty profile token/))
    withEnv('mixed-count,mixed-count', () => expect(() => resolveC02HeapProfiles()).toThrow(/duplicate/))
    withEnv('bogus-mixed', () => expect(() => resolveC02HeapProfiles()).toThrow(/unknown profile id/))
    withEnv('mixed', () =>
      expect(() => resolveC02HeapProfile()).toThrow(/singular resolver expects exactly one profile/)
    )
  })

  it('mixed canonical bytes relate deterministically to heap amplification contract (finite scalar ratios)', () => {
    const profile = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.balanced]!
    const topics = buildC02MixedSyntheticTopics(profile)
    const logicalBytes = canonicalBytesForTopics(topics)
    const heapBefore: RendererHeapSample = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 20_000_000,
      totalJSHeapSize: 80_000_000,
      jsHeapSizeLimit: 2_000_000_000
    }
    const heapAfter: RendererHeapSample = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 22_500_000,
      totalJSHeapSize: 80_000_000,
      jsHeapSizeLimit: 2_000_000_000
    }
    const amp = computeHeapAmplification(heapBefore, heapAfter, logicalBytes)
    expect(Number.isFinite(amp.deltaRatio) && Number.isFinite(amp.absoluteRatio)).toBe(true)
    expect(amp.heapDeltaBytes).toBe(2_500_000)
    // Effective requires precise
    const effPrecise = classifyEffectiveHeapDeltaInformative(amp.heapDeltaBytes, 'precise')
    const effBucketed = classifyEffectiveHeapDeltaInformative(amp.heapDeltaBytes, 'bucketed')
    expect(effPrecise.informative).toBe(true)
    expect(effBucketed.informative).toBe(false)
    expect(isEffectiveHeapDeltaInformative(amp.heapDeltaBytes, 'precise')).toBe(true)
    expect(isEffectiveHeapDeltaInformative(amp.heapDeltaBytes, 'bucketed')).toBe(false)
  })

  it('privacy: mixed topics contain no content leakage beyond synthetic deterministic ascii, and artifact scale is scalar-only', () => {
    const profile = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.countPressure]!
    const topics = buildC02MixedSyntheticTopics(profile)
    const canonicals = topics.map((t) => t.blocks[0] as Record<string, unknown>)
    for (const b of canonicals) {
      expect(typeof b.content).toBe('string')
      expect(String(b.content)).toBe('a'.repeat(512))
    }
    // Scale map JSON must not contain message content beyond numeric sizes
    const scale = buildC02MixedScaleMap(profile, RENDERER_HEAP_METHOD, 'precise')
    const scaleJson = JSON.stringify(scale)
    expect(scaleJson).not.toContain('aaaa')
    // BenchResult scale validation: finite, non-empty, no NaN
    for (const v of Object.values(scale)) {
      expect(Number.isFinite(v)).toBe(true)
    }
  })
})

describe('C02 complete BenchmarkResult artifact — schema-v1 privacy and structure (uniform + mixed)', () => {
  const SENTINEL_TOPIC_HEAP = 'c02-heap-topic-01'
  const SENTINEL_TOPIC_MIXED = 'c02-mixed-topic-03'
  const SENTINEL_CONTENT = 'aaaa'
  const SENTINEL_PATH = '/tmp/SENTINEL_PATH_SHOULD_NOT_LEAK'
  const SENTINEL_CREDENTIAL = 'SENTINEL_CREDENTIAL_apiKey_12345_sk_sentinel'
  const SENTINEL_HISTORY = 'SENTINEL_HISTORY_messages_history_should_not_leak'

  function makeTestEnvironment(): BenchmarkResult['environment'] {
    return {
      timestamp: new Date().toISOString(),
      node: 'v24.11.1',
      pnpm: '10.27.0',
      abiLane: 'electron',
      abi: '145',
      command: 'pnpm test:e2e',
      git: { commit: 'abc123def456abc123def456abc123def456abcd', dirty: false }
    }
  }

  function makeHeapPair(deltaBytes: number): { before: RendererHeapSample; after: RendererHeapSample } {
    const before: RendererHeapSample = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 20_000_000,
      totalJSHeapSize: 80_000_000,
      jsHeapSizeLimit: 2_000_000_000
    }
    const after: RendererHeapSample = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 20_000_000 + deltaBytes,
      totalJSHeapSize: 80_000_000,
      jsHeapSizeLimit: 2_000_000_000
    }
    return { before, after }
  }

  it('uniform representative artifact validates, is scalar-only, and excludes all sensitive sentinels and dynamic topic IDs', () => {
    const profile = C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.default]!
    const topics = buildC02SyntheticTopics(profile)
    const logicalBytes = canonicalBytesForTopics(topics)
    const rendererLogicalBytes = logicalBytes
    const { before: heapBefore, after: heapAfter } = makeHeapPair(2_500_000)
    const informativeness = classifyEffectiveHeapDeltaInformative(
      heapAfter.usedJSHeapSize - heapBefore.usedJSHeapSize,
      'precise'
    )
    const expectedVisible = c02ExpectedVisibleCount(profile)
    const expectedProjected = c02ExpectedProjectedTotal(profile)
    // Allocation intentionally contains topic-ID-like anchor to prove redaction — artifact must NOT echo it
    const allocation = {
      topicsCreated: profile.syntheticTopics,
      messagesCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      blocksCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: expectedProjected,
        reduxBlocks: expectedProjected,
        groupCount: expectedVisible,
        displayMessages: expectedVisible,
        anchorGroupKey: SENTINEL_TOPIC_HEAP,
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: expectedVisible,
        globalDisplayMessages: expectedVisible
      },
      productionPath:
        'canonical user path complete: assistants/addTopic (live assistant ID) → ChatDb ensureTopic/pasteMessagesToTopic → newMessages/setDisplayCount (when required) → [data-testid="topic-item"][data-topic-id] click → HomePage setActiveTopic → useActiveTopic → loadTopicMessagesThunk → Chat/Messages production projections (createLatestMessageWindow → createMessageViewportGroupModel → projectMessageViewportGroups + computeContextInfo) observed via DOM #messages [data-stable-group-id]/[data-message-id]/[data-context-boundary]; productionPath complete — final synthetic topic owns #messages DOM (scoped 100/100, global 100/100 via #messages [data-message-id]), groups exact 100/100 (owned 100/100 via #messages [data-stable-group-id]), contextBoundary inside #messages anchorPresent=1 finalTopicOwned=1 (final-topic-owned, [id^="message-"] fallback diagnostic-only excluded)',
      productionPathComplete: true
    }
    const environment = makeTestEnvironment()
    const result = buildC02BenchmarkResult(
      environment,
      profile,
      logicalBytes,
      rendererLogicalBytes,
      heapBefore,
      heapAfter,
      allocation,
      informativeness,
      'precise'
    )
    const problems = validateBenchmarkResult(result)
    expect(problems, `uniform artifact must validate: ${problems.join('; ')}`).toEqual([])
    for (const m of result.metrics) {
      expect(Number.isFinite(m.value), `metric ${m.id} must be finite`).toBe(true)
    }
    for (const v of Object.values(result.benchmark.scale)) {
      expect(Number.isFinite(v), 'scale value must be finite').toBe(true)
    }
    const json = JSON.stringify(result)
    // Privacy: no topic IDs, content, paths, credentials, histories
    expect(json).not.toContain('c02-heap-topic')
    expect(json).not.toContain('c02-mixed-topic')
    expect(json).not.toContain(SENTINEL_TOPIC_HEAP)
    expect(json).not.toContain(SENTINEL_CONTENT)
    expect(json).not.toContain(SENTINEL_PATH)
    expect(json).not.toContain(SENTINEL_CREDENTIAL)
    expect(json).not.toContain(SENTINEL_HISTORY)
    expect(json).not.toContain(SENTINEL_PATH)
    expect(json).not.toContain('/tmp')
    // Dynamic topic ID from allocation.anchorGroupKey must not leak even though allocation contained it
    expect(json.includes(SENTINEL_TOPIC_HEAP)).toBe(false)
  })

  it('mixed representative artifact validates, is scalar-only, and excludes all sensitive sentinels and dynamic topic IDs', () => {
    const profile = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.balanced]!
    const topics = buildC02MixedSyntheticTopics(profile)
    const logicalBytes = canonicalBytesForTopics(topics)
    const rendererLogicalBytes = logicalBytes
    const { before: heapBefore, after: heapAfter } = makeHeapPair(2_500_000)
    const informativeness = classifyEffectiveHeapDeltaInformative(
      heapAfter.usedJSHeapSize - heapBefore.usedJSHeapSize,
      'precise'
    )
    const lastSpec = profile.topicSpecs[profile.topicSpecs.length - 1]!
    const expectedVisible = c02MixedExpectedVisibleCountForSpec(lastSpec)
    const expectedProjected = c02MixedExpectedProjectedTotal(profile)
    const allocation = {
      topicsCreated: profile.topicSpecs.length,
      messagesCreated: c02MixedTotalMessages(profile),
      blocksCreated: c02MixedTotalMessages(profile),
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: expectedProjected,
        reduxBlocks: expectedProjected,
        groupCount: expectedVisible,
        displayMessages: expectedVisible,
        anchorGroupKey: SENTINEL_TOPIC_MIXED,
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: expectedVisible,
        globalDisplayMessages: expectedVisible
      },
      productionPath:
        'canonical user path complete (mixed): assistants/addTopic (live assistant ID) → ChatDb ensureTopic/pasteMessagesToTopic → newMessages/setDisplayCount (when required) → [data-testid="topic-item"][data-topic-id] click → HomePage setActiveTopic → useActiveTopic → loadTopicMessagesThunk → Chat/Messages production projections (createLatestMessageWindow → createMessageViewportGroupModel → projectMessageViewportGroups + computeContextInfo) observed via DOM #messages [data-stable-group-id]/[data-message-id]/[data-context-boundary]; productionPath complete — mixed distribution (4 topics heterogeneous: 20×512B, 50×1024B, 100×2048B, 150×4096B) final synthetic topic owns #messages DOM (scoped 100/100, global 100/100 via #messages [data-message-id]), groups exact 100/100 (owned 100/100 via #messages [data-stable-group-id]), contextBoundary inside #messages anchorPresent=1 finalTopicOwned=1 (final-topic-owned, [id^="message-"] fallback diagnostic-only excluded)',
      productionPathComplete: true
    }
    const environment = makeTestEnvironment()
    const result = buildC02MixedBenchmarkResult(
      environment,
      profile,
      logicalBytes,
      rendererLogicalBytes,
      heapBefore,
      heapAfter,
      allocation,
      informativeness,
      'precise'
    )
    const problems = validateBenchmarkResult(result)
    expect(problems, `mixed artifact must validate: ${problems.join('; ')}`).toEqual([])
    for (const m of result.metrics) {
      expect(Number.isFinite(m.value), `metric ${m.id} must be finite`).toBe(true)
    }
    for (const v of Object.values(result.benchmark.scale)) {
      expect(Number.isFinite(v), 'scale value must be finite').toBe(true)
    }
    const json = JSON.stringify(result)
    expect(json).not.toContain('c02-heap-topic')
    expect(json).not.toContain('c02-mixed-topic')
    expect(json).not.toContain(SENTINEL_TOPIC_MIXED)
    expect(json).not.toContain(SENTINEL_CONTENT)
    expect(json).not.toContain(SENTINEL_PATH)
    expect(json).not.toContain(SENTINEL_CREDENTIAL)
    expect(json).not.toContain(SENTINEL_HISTORY)
    expect(json).not.toContain(SENTINEL_PATH)
    expect(json).not.toContain('/tmp')
  })
})

describe('C02 privacy seam regression — builders must not leak arbitrary free-text inputs (productionPath, informativeness reason, anchor) — uniform and mixed complete artifacts', () => {
  const SENTINEL_TOPIC_HEAP_INJECT = 'SENTINEL_TOPIC_HEAP_INJECT_c02-heap-topic-99_SHOULD_NOT_LEAK'
  const SENTINEL_TOPIC_MIXED_INJECT = 'SENTINEL_TOPIC_MIXED_INJECT_c02-mixed-topic-99_SHOULD_NOT_LEAK'
  const SENTINEL_CONTENT_INJECT = 'SENTINEL_CONTENT_INJECT_aaaa_content_should_not_leak_789'
  const SENTINEL_PATH_INJECT = 'SENTINEL_PATH_INJECT_/tmp/malicious/path/should_not_leak_123'
  const SENTINEL_CRED_INJECT = 'SENTINEL_CRED_INJECT_sk_sentinel_apiKey_should_not_leak_999'
  const SENTINEL_HISTORY_INJECT = 'SENTINEL_HISTORY_INJECT_history_payload_should_not_leak_456'
  const SENTINEL_ANCHOR_HEAP_INJECT = `SENTINEL_ANCHOR_HEAP_INJECT_${SENTINEL_TOPIC_HEAP_INJECT}_anchor`
  const SENTINEL_ANCHOR_MIXED_INJECT = `SENTINEL_ANCHOR_MIXED_INJECT_${SENTINEL_TOPIC_MIXED_INJECT}_anchor`
  const SENTINEL_REASON_HEAP_INJECT = `MALICIOUS_REASON_HEAP ${SENTINEL_PATH_INJECT}_REASON ${SENTINEL_CRED_INJECT}_REASON ${SENTINEL_HISTORY_INJECT}_REASON ${SENTINEL_CONTENT_INJECT}_REASON ${SENTINEL_TOPIC_HEAP_INJECT}_REASON ${SENTINEL_ANCHOR_HEAP_INJECT}_REASON`
  const SENTINEL_REASON_MIXED_INJECT = `MALICIOUS_REASON_MIXED ${SENTINEL_PATH_INJECT}_MIXED_REASON ${SENTINEL_CRED_INJECT}_MIXED_REASON ${SENTINEL_HISTORY_INJECT}_MIXED_REASON ${SENTINEL_CONTENT_INJECT}_MIXED_REASON ${SENTINEL_TOPIC_MIXED_INJECT}_MIXED_REASON ${SENTINEL_ANCHOR_MIXED_INJECT}_MIXED_REASON`
  const SENTINEL_PRODUCTION_HEAP_INJECT = `MALICIOUS_PRODUCTION_PATH_HEAP ${SENTINEL_PATH_INJECT} ${SENTINEL_CRED_INJECT} ${SENTINEL_HISTORY_INJECT} ${SENTINEL_CONTENT_INJECT} ${SENTINEL_TOPIC_HEAP_INJECT} ${SENTINEL_ANCHOR_HEAP_INJECT} with topic id c02-heap-topic-01 and content aaaa and history`
  const SENTINEL_PRODUCTION_MIXED_INJECT = `MALICIOUS_PRODUCTION_PATH_MIXED ${SENTINEL_PATH_INJECT} ${SENTINEL_CRED_INJECT} ${SENTINEL_HISTORY_INJECT} ${SENTINEL_CONTENT_INJECT} ${SENTINEL_TOPIC_MIXED_INJECT} ${SENTINEL_ANCHOR_MIXED_INJECT} with topic id c02-mixed-topic-03 and content aaaa and history`

  function makeTestEnvironment(): BenchmarkResult['environment'] {
    return {
      timestamp: new Date().toISOString(),
      node: 'v24.11.1',
      pnpm: '10.27.0',
      abiLane: 'electron',
      abi: '145',
      command: 'pnpm test:e2e',
      git: { commit: 'abc123def456abc123def456abc123def456abcd', dirty: false }
    }
  }

  function makeHeapPair(deltaBytes: number): { before: RendererHeapSample; after: RendererHeapSample } {
    const before: RendererHeapSample = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 20_000_000,
      totalJSHeapSize: 80_000_000,
      jsHeapSizeLimit: 2_000_000_000
    }
    const after: RendererHeapSample = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 20_000_000 + deltaBytes,
      totalJSHeapSize: 80_000_000,
      jsHeapSizeLimit: 2_000_000_000
    }
    return { before, after }
  }

  it('uniform complete artifact excludes all injected free-text sentinels while retaining required finite metrics/gates/scales and fixed stage categories', () => {
    const profile = C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.default]!
    const topics = buildC02SyntheticTopics(profile)
    const logicalBytes = canonicalBytesForTopics(topics)
    const rendererLogicalBytes = logicalBytes
    const { before: heapBefore, after: heapAfter } = makeHeapPair(2_500_000)
    // Deliberately supply distinct sentinels through every formerly artifact-facing free-text input
    const informativeness = { informative: true, reason: SENTINEL_REASON_HEAP_INJECT }
    const expectedVisible = c02ExpectedVisibleCount(profile)
    const expectedProjected = c02ExpectedProjectedTotal(profile)
    // Anchor must be valid per LOCK-004 (contain lastTopicId) while still injecting sentinel for privacy — valid owned anchor that also contains sentinel should be redacted and still yield complete via derived predicate.
    const validOwnedAnchorHeap = `c02-heap-topic-01-${SENTINEL_ANCHOR_HEAP_INJECT}`
    const allocation = {
      topicsCreated: profile.syntheticTopics,
      messagesCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      blocksCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: expectedProjected,
        reduxBlocks: expectedProjected,
        groupCount: expectedVisible,
        displayMessages: expectedVisible,
        anchorGroupKey: validOwnedAnchorHeap,
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: expectedVisible,
        globalDisplayMessages: expectedVisible
      },
      productionPath: SENTINEL_PRODUCTION_HEAP_INJECT,
      productionPathComplete: true
    }
    const environment = makeTestEnvironment()
    const result = buildC02BenchmarkResult(
      environment,
      profile,
      logicalBytes,
      rendererLogicalBytes,
      heapBefore,
      heapAfter,
      allocation,
      informativeness,
      'precise'
    )
    const problems = validateBenchmarkResult(result)
    expect(problems, `uniform injected artifact must validate: ${problems.join('; ')}`).toEqual([])
    for (const m of result.metrics) {
      expect(Number.isFinite(m.value), `metric ${m.id} must be finite`).toBe(true)
    }
    for (const v of Object.values(result.benchmark.scale)) {
      expect(Number.isFinite(v), 'scale value must be finite').toBe(true)
    }
    // Required finite metrics/gates/scales preserved — derived predicate now valid per owned anchor
    const ids = result.metrics.map((m) => m.id)
    expect(ids).toContain('logical.bytes')
    expect(ids).toContain('heap.delta')
    expect(ids).toContain('heap.amplification.deltaRatio')
    expect(ids).toContain('calibration.complete')
    expect(result.metrics.find((m) => m.id === 'calibration.complete')?.value).toBe(1)
    expect(result.gates.find((g) => g.id === 'heap.deltaInformative')?.passed).toBe(true)
    expect(result.gates.find((g) => g.id === 'allocation.resident')?.passed).toBe(true)
    expect(result.gates.find((g) => g.id === 'productionPath.complete')?.passed).toBe(true)
    expect(result.gates.find((g) => g.id === 'calibration.complete')?.passed).toBe(true)
    // Fixed stage categories and scalar proof preserved — derived solely from whitelisted labels + scalars
    const json = JSON.stringify(result)
    // Must contain fixed safe categories, not raw sentinels
    expect(json).toContain('heapDelta-effective-precise-positive-informative')
    expect(json).toContain('canonical-production-path-complete')
    expect(json).toContain('performance.memory')
    // Precision scalar proof preserved
    expect(json).toContain('precise')
    // Scalar proof: heapDelta value present as finite number detail
    expect(json).toContain(String(2_500_000))
    // Injected sentinels must be absent — every formerly free-text input is injected
    for (const sentinel of [
      SENTINEL_TOPIC_HEAP_INJECT,
      SENTINEL_CONTENT_INJECT,
      SENTINEL_PATH_INJECT,
      SENTINEL_CRED_INJECT,
      SENTINEL_HISTORY_INJECT,
      SENTINEL_ANCHOR_HEAP_INJECT,
      SENTINEL_REASON_HEAP_INJECT,
      SENTINEL_PRODUCTION_HEAP_INJECT,
      SENTINEL_TOPIC_MIXED_INJECT,
      SENTINEL_ANCHOR_MIXED_INJECT
    ]) {
      expect(json, `uniform artifact must NOT contain sentinel ${sentinel}`).not.toContain(sentinel)
    }
    // Also ensure no raw path/history fragments leak via generic substrings that would be in sentinels
    expect(json).not.toContain('SENTINEL_')
    expect(json).not.toContain('/tmp/malicious')
    expect(json).not.toContain('sk_sentinel')
    expect(json).not.toContain('MALICIOUS_REASON')
    expect(json).not.toContain('MALICIOUS_PRODUCTION')
    // Topic ID leakage must be absent even though anchor contained it and productionPath contained topic IDs
    expect(json).not.toContain('c02-heap-topic-99')
    expect(json).not.toContain('c02-heap-topic-01')
    expect(json).not.toContain('c02-mixed-topic')
  })

  it('mixed complete artifact excludes all injected free-text sentinels while retaining required finite metrics/gates/scales and fixed stage categories', () => {
    const profile = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.balanced]!
    const topics = buildC02MixedSyntheticTopics(profile)
    const logicalBytes = canonicalBytesForTopics(topics)
    const rendererLogicalBytes = logicalBytes
    const { before: heapBefore, after: heapAfter } = makeHeapPair(2_500_000)
    const informativeness = { informative: true, reason: SENTINEL_REASON_MIXED_INJECT }
    const lastSpec = profile.topicSpecs[profile.topicSpecs.length - 1]!
    const expectedVisible = c02MixedExpectedVisibleCountForSpec(lastSpec)
    const expectedProjected = c02MixedExpectedProjectedTotal(profile)
    // Anchor must be valid per LOCK-004 (contain lastTopicId c02-mixed-topic-03) while still injecting sentinel — valid owned anchor redacted and still yields complete.
    const validOwnedAnchorMixed = `c02-mixed-topic-03-${SENTINEL_ANCHOR_MIXED_INJECT}`
    const allocation = {
      topicsCreated: profile.topicSpecs.length,
      messagesCreated: c02MixedTotalMessages(profile),
      blocksCreated: c02MixedTotalMessages(profile),
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: expectedProjected,
        reduxBlocks: expectedProjected,
        groupCount: expectedVisible,
        displayMessages: expectedVisible,
        anchorGroupKey: validOwnedAnchorMixed,
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: expectedVisible,
        globalDisplayMessages: expectedVisible
      },
      productionPath: SENTINEL_PRODUCTION_MIXED_INJECT,
      productionPathComplete: true
    }
    const environment = makeTestEnvironment()
    const result = buildC02MixedBenchmarkResult(
      environment,
      profile,
      logicalBytes,
      rendererLogicalBytes,
      heapBefore,
      heapAfter,
      allocation,
      informativeness,
      'precise'
    )
    const problems = validateBenchmarkResult(result)
    expect(problems, `mixed injected artifact must validate: ${problems.join('; ')}`).toEqual([])
    for (const m of result.metrics) {
      expect(Number.isFinite(m.value), `metric ${m.id} must be finite`).toBe(true)
    }
    for (const v of Object.values(result.benchmark.scale)) {
      expect(Number.isFinite(v), 'scale value must be finite').toBe(true)
    }
    const ids = result.metrics.map((m) => m.id)
    expect(ids).toContain('logical.bytes')
    expect(ids).toContain('heap.delta')
    expect(ids).toContain('heap.amplification.deltaRatio')
    expect(ids).toContain('calibration.complete')
    expect(result.metrics.find((m) => m.id === 'calibration.complete')?.value).toBe(1)
    expect(result.gates.find((g) => g.id === 'heap.deltaInformative')?.passed).toBe(true)
    expect(result.gates.find((g) => g.id === 'allocation.resident')?.passed).toBe(true)
    expect(result.gates.find((g) => g.id === 'productionPath.complete')?.passed).toBe(true)
    const json = JSON.stringify(result)
    expect(json).toContain('heapDelta-effective-precise-positive-informative')
    expect(json).toContain('canonical-production-path-complete')
    expect(json).toContain('performance.memory')
    expect(json).toContain(String(2_500_000))
    for (const sentinel of [
      SENTINEL_TOPIC_MIXED_INJECT,
      SENTINEL_CONTENT_INJECT,
      SENTINEL_PATH_INJECT,
      SENTINEL_CRED_INJECT,
      SENTINEL_HISTORY_INJECT,
      SENTINEL_ANCHOR_MIXED_INJECT,
      SENTINEL_REASON_MIXED_INJECT,
      SENTINEL_PRODUCTION_MIXED_INJECT,
      SENTINEL_TOPIC_HEAP_INJECT,
      SENTINEL_ANCHOR_HEAP_INJECT
    ]) {
      expect(json, `mixed artifact must NOT contain sentinel ${sentinel}`).not.toContain(sentinel)
    }
    expect(json).not.toContain('SENTINEL_')
    expect(json).not.toContain('/tmp/malicious')
    expect(json).not.toContain('sk_sentinel')
    expect(json).not.toContain('MALICIOUS_REASON')
    expect(json).not.toContain('MALICIOUS_PRODUCTION')
    expect(json).not.toContain('c02-mixed-topic-99')
    expect(json).not.toContain('c02-mixed-topic-03')
    expect(json).not.toContain('c02-heap-topic')
  })

  it('uniform builder maps unknown/inconclusive inputs to safe generic fixed labels without leaking raw strings', () => {
    const profile = C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.small]!
    const topics = buildC02SyntheticTopics(profile)
    const logicalBytes = canonicalBytesForTopics(topics)
    const { before: heapBefore, after: heapAfter } = makeHeapPair(0) // zero delta triggers inconclusive
    const SENTINEL_UNKNOWN_REASON = 'SENTINEL_UNKNOWN_REASON_credential_leak_attempt'
    const SENTINEL_UNKNOWN_PATH = 'SENTINEL_UNKNOWN_PATH_/etc/passwd_should_not_leak'
    const informativeness = { informative: false, reason: SENTINEL_UNKNOWN_REASON }
    const allocation = {
      topicsCreated: profile.syntheticTopics,
      messagesCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      blocksCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: c02ExpectedProjectedTotal(profile),
        reduxBlocks: c02ExpectedProjectedTotal(profile),
        groupCount: 0,
        displayMessages: 0,
        anchorGroupKey: 'SENTINEL_ANCHOR_UNKNOWN_SHOULD_NOT_LEAK',
        contextBoundaryPresent: false,
        contextBoundaryInsideMessages: false,
        finalTopicDomProof: false,
        groupExactMatched: false,
        groupsWithFinalTopic: 0,
        globalDisplayMessages: 0
      },
      productionPath: SENTINEL_UNKNOWN_PATH,
      productionPathComplete: false
    }
    const environment = makeTestEnvironment()
    const result = buildC02BenchmarkResult(
      environment,
      profile,
      logicalBytes,
      logicalBytes,
      heapBefore,
      heapAfter,
      allocation,
      informativeness,
      'bucketed'
    )
    const problems = validateBenchmarkResult(result)
    expect(problems).toEqual([])
    const json = JSON.stringify(result)
    for (const s of [SENTINEL_UNKNOWN_REASON, SENTINEL_UNKNOWN_PATH, 'SENTINEL_ANCHOR_UNKNOWN_SHOULD_NOT_LEAK']) {
      expect(json).not.toContain(s)
    }
    expect(json).not.toContain('SENTINEL_')
    // Must map to safe generic inconclusive labels, not raw
    expect(json).toContain('heapDelta-inconclusive-zero-quantized')
    expect(json).toContain('canonical-production-path-partial')
    // Scalar proof still present
    expect(json).toContain('heapDelta=0')
    expect(json).toContain('bucketed')
  })
})
describe('C02 ACTIVE E2E call-graph — sanitized multi builder with heterogeneous mixed+uniform and malicious IDs (blocker 2/3/4)', () => {
  const SENTINEL_MALICIOUS_ID = 'SENTINEL_MALICIOUS_ID_../../../etc/passwd_credential_leak_sk_999_history_payload'
  const SENTINEL_MALICIOUS_ID2 = 'bad-id-with-SENTINEL_CRED_sk_malicious_123_and_/tmp/evil_path'
  const SENTINEL_CONTENT = 'aaaa'
  const SENTINEL_PATH = '/tmp/SENTINEL_PATH_SHOULD_NOT_LEAK_MIXED'
  const SENTINEL_CRED = 'SENTINEL_CRED_apiKey_malicious_should_not_leak'
  const SENTINEL_HISTORY = 'SENTINEL_HISTORY_payload_should_not_leak_matrix'
  const SENTINEL_ANCHOR_MIXED = 'SENTINEL_ANCHOR_c02-mixed-topic-99_SHOULD_NOT_LEAK'
  const SENTINEL_ANCHOR_UNIFORM = 'SENTINEL_ANCHOR_c02-heap-topic-99_SHOULD_NOT_LEAK'
  const SENTINEL_REASON_MIXED = `MALICIOUS_REASON_MIXED ${SENTINEL_PATH} ${SENTINEL_CRED} ${SENTINEL_HISTORY} ${SENTINEL_MALICIOUS_ID}`
  const SENTINEL_REASON_UNIFORM = `MALICIOUS_REASON_UNIFORM ${SENTINEL_PATH} ${SENTINEL_CRED} ${SENTINEL_HISTORY} ${SENTINEL_MALICIOUS_ID2}`
  const SENTINEL_PRODUCTION_MIXED = `MALICIOUS_PRODUCTION_MIXED ${SENTINEL_PATH} ${SENTINEL_CRED} ${SENTINEL_HISTORY} ${SENTINEL_CONTENT} ${SENTINEL_ANCHOR_MIXED} c02-mixed-topic-01`
  const SENTINEL_PRODUCTION_UNIFORM = `MALICIOUS_PRODUCTION_UNIFORM ${SENTINEL_PATH} ${SENTINEL_CRED} ${SENTINEL_HISTORY} ${SENTINEL_CONTENT} ${SENTINEL_ANCHOR_UNIFORM} c02-heap-topic-01`

  function makeTestEnvironment(): BenchmarkResult['environment'] {
    return {
      timestamp: new Date().toISOString(),
      node: 'v24.11.1',
      pnpm: '10.27.0',
      abiLane: 'electron',
      abi: '145',
      command: 'pnpm test:e2e',
      git: { commit: 'abc123def456abc123def456abc123def456abcd', dirty: false }
    }
  }
  function makeHeapPair(deltaBytes: number): { before: RendererHeapSample; after: RendererHeapSample } {
    const before: RendererHeapSample = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 20_000_000,
      totalJSHeapSize: 80_000_000,
      jsHeapSizeLimit: 2_000_000_000
    }
    const after: RendererHeapSample = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 20_000_000 + deltaBytes,
      totalJSHeapSize: 80_000_000,
      jsHeapSizeLimit: 2_000_000_000
    }
    return { before, after }
  }

  it('heterogeneous matrix (uniform small + mixed balanced + malicious raw ID) validates, uses real mixed workload, and blocks all sentinel leakage via safe keys/details/metrics/gates/scale', () => {
    const uniformProfile = C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.small]!
    const mixedProfile = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.balanced]!

    // Real workload via actual mixed builder — verify cardinalities/bytes are heterogeneous and deterministic
    const uniformTopics = buildC02SyntheticTopics(uniformProfile)
    const mixedTopics = buildC02MixedSyntheticTopics(mixedProfile)
    const uniformBytes = canonicalBytesForTopics(uniformTopics)
    const mixedBytes = canonicalBytesForTopics(mixedTopics)
    expect(uniformTopics.length).toBe(uniformProfile.syntheticTopics)
    expect(mixedTopics.length).toBe(mixedProfile.topicSpecs.length)
    expect(c02MixedTotalMessages(mixedProfile)).toBe(20 + 50 + 100 + 150)
    expect(c02MixedExpectedProjectedTotal(mixedProfile)).toBe(20 + 50 + 100 + 100) // last 150 clamped to 100
    expect(mixedBytes).toBeGreaterThan(uniformBytes) // heterogeneous byte shape
    expect(Number.isFinite(uniformBytes) && uniformBytes > 0).toBe(true)
    expect(Number.isFinite(mixedBytes) && mixedBytes > 0).toBe(true)

    // Allocations carry malicious free-text anchors/paths/reasons that must NOT appear in artifact — anchors are made valid per LOCK-004 (contain lastTopicId) while still injecting sentinel for privacy, so derived predicate valid and artifact redacts sentinel.
    const validUniformAnchorForSmall = `c02-heap-topic-00-${SENTINEL_ANCHOR_UNIFORM}`
    const uniformAllocation = {
      topicsCreated: uniformProfile.syntheticTopics,
      messagesCreated: uniformProfile.syntheticTopics * uniformProfile.syntheticMessagesPerTopic,
      blocksCreated: uniformProfile.syntheticTopics * uniformProfile.syntheticMessagesPerTopic,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: c02ExpectedProjectedTotal(uniformProfile),
        reduxBlocks: c02ExpectedProjectedTotal(uniformProfile),
        groupCount: c02ExpectedVisibleCount(uniformProfile),
        displayMessages: c02ExpectedVisibleCount(uniformProfile),
        anchorGroupKey: validUniformAnchorForSmall,
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: c02ExpectedVisibleCount(uniformProfile),
        globalDisplayMessages: c02ExpectedVisibleCount(uniformProfile)
      },
      productionPath: SENTINEL_PRODUCTION_UNIFORM,
      productionPathComplete: true
    }
    const validMixedAnchorForBalanced = `c02-mixed-topic-03-${SENTINEL_ANCHOR_MIXED}`
    const mixedAllocation = {
      topicsCreated: mixedProfile.topicSpecs.length,
      messagesCreated: c02MixedTotalMessages(mixedProfile),
      blocksCreated: c02MixedTotalMessages(mixedProfile),
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: c02MixedExpectedProjectedTotal(mixedProfile),
        reduxBlocks: c02MixedExpectedProjectedTotal(mixedProfile),
        groupCount: c02MixedExpectedVisibleCountForSpec(mixedProfile.topicSpecs[mixedProfile.topicSpecs.length - 1]!),
        displayMessages: c02MixedExpectedVisibleCountForSpec(
          mixedProfile.topicSpecs[mixedProfile.topicSpecs.length - 1]!
        ),
        anchorGroupKey: validMixedAnchorForBalanced,
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: c02MixedExpectedVisibleCountForSpec(
          mixedProfile.topicSpecs[mixedProfile.topicSpecs.length - 1]!
        ),
        globalDisplayMessages: c02MixedExpectedVisibleCountForSpec(
          mixedProfile.topicSpecs[mixedProfile.topicSpecs.length - 1]!
        )
      },
      productionPath: SENTINEL_PRODUCTION_MIXED,
      productionPathComplete: true
    }
    // Third entry uses malicious raw ID to prove scale-key safety via whitelist
    const maliciousUniformProfile = C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.default]!
    const maliciousTopics = buildC02SyntheticTopics(maliciousUniformProfile)
    const maliciousBytes = canonicalBytesForTopics(maliciousTopics)
    const validMaliciousAnchor = `c02-heap-topic-01-SENTINEL_MALICIOUS_ANCHOR_SHOULD_NOT_LEAK_3`
    const maliciousAllocation = {
      topicsCreated: maliciousUniformProfile.syntheticTopics,
      messagesCreated: maliciousUniformProfile.syntheticTopics * maliciousUniformProfile.syntheticMessagesPerTopic,
      blocksCreated: maliciousUniformProfile.syntheticTopics * maliciousUniformProfile.syntheticMessagesPerTopic,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: c02ExpectedProjectedTotal(maliciousUniformProfile),
        reduxBlocks: c02ExpectedProjectedTotal(maliciousUniformProfile),
        groupCount: c02ExpectedVisibleCount(maliciousUniformProfile),
        displayMessages: c02ExpectedVisibleCount(maliciousUniformProfile),
        anchorGroupKey: validMaliciousAnchor,
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: c02ExpectedVisibleCount(maliciousUniformProfile),
        globalDisplayMessages: c02ExpectedVisibleCount(maliciousUniformProfile)
      },
      productionPath: 'SENTINEL_MALICIOUS_PRODUCTION_PATH_SHOULD_NOT_LEAK_3 /tmp/bogus',
      productionPathComplete: true
    }

    const environment = makeTestEnvironment()
    const heapUniform = makeHeapPair(2_000_000)
    const heapMixed = makeHeapPair(3_500_000)
    const heapMalicious = makeHeapPair(1_500_000)
    const infoUniform = classifyEffectiveHeapDeltaInformative(
      heapUniform.after.usedJSHeapSize - heapUniform.before.usedJSHeapSize,
      'precise'
    )
    const infoMixed = classifyEffectiveHeapDeltaInformative(
      heapMixed.after.usedJSHeapSize - heapMixed.before.usedJSHeapSize,
      'precise'
    )
    const infoMalicious = classifyEffectiveHeapDeltaInformative(
      heapMalicious.after.usedJSHeapSize - heapMalicious.before.usedJSHeapSize,
      'precise'
    )
    // Override informativeness reasons with malicious sentinels to prove redaction (builder must ignore raw reason)
    const maliciousInfoUniform = { informative: infoUniform.informative, reason: SENTINEL_REASON_UNIFORM }
    const maliciousInfoMixed = { informative: infoMixed.informative, reason: SENTINEL_REASON_MIXED }
    const maliciousInfoMalicious = {
      informative: infoMalicious.informative,
      reason: 'SENTINEL_MALICIOUS_REASON_THIRD_SHOULD_NOT_LEAK'
    }

    // THIS is the exact shared active builder used by E2E emission: buildC02MultiBenchmarkResult
    const result = buildC02MultiBenchmarkResult(environment, [
      {
        profileId: C02_HEAP_PROFILE_IDS.small,
        profile: uniformProfile,
        logicalBytes: uniformBytes,
        rendererLogicalBytes: uniformBytes,
        heapBefore: heapUniform.before,
        heapAfter: heapUniform.after,
        allocation: uniformAllocation,
        informativeness: maliciousInfoUniform,
        precision: 'precise',
        finalTopicId: 'c02-heap-topic-00'
      },
      {
        profileId: C02_MIXED_HEAP_PROFILE_IDS.balanced,
        profile: mixedProfile,
        logicalBytes: mixedBytes,
        rendererLogicalBytes: mixedBytes,
        heapBefore: heapMixed.before,
        heapAfter: heapMixed.after,
        allocation: mixedAllocation,
        informativeness: maliciousInfoMixed,
        precision: 'precise',
        finalTopicId: 'c02-mixed-topic-03'
      },
      {
        profileId: SENTINEL_MALICIOUS_ID,
        profile: maliciousUniformProfile,
        logicalBytes: maliciousBytes,
        rendererLogicalBytes: maliciousBytes,
        heapBefore: heapMalicious.before,
        heapAfter: heapMalicious.after,
        allocation: maliciousAllocation,
        informativeness: maliciousInfoMalicious,
        precision: 'precise',
        finalTopicId: 'c02-heap-topic-01'
      }
    ])

    const problems = validateBenchmarkResult(result)
    expect(problems, `heterogeneous matrix artifact must validate: ${problems.join('; ')}`).toEqual([])
    for (const m of result.metrics) {
      expect(Number.isFinite(m.value), `metric ${m.id} must be finite`).toBe(true)
    }
    for (const v of Object.values(result.benchmark.scale)) {
      expect(Number.isFinite(v), 'scale value must be finite').toBe(true)
    }
    // Scale correctness: heterogeneous workload sizes observable via safe keys, malicious ID not leaked as key
    const scale = result.benchmark.scale as Record<string, number>
    expect(scale.profileCount).toBe(3)
    // Safe whitelisted keys present for the two good profiles (derived via safe labels)
    expect(scale['c02_small_v1_topics']).toBe(uniformProfile.syntheticTopics)
    expect(scale['c02_mixed_balanced_v1_topics']).toBe(mixedProfile.topicSpecs.length)
    expect(scale['c02_mixed_balanced_v1_messagesTotal']).toBe(c02MixedTotalMessages(mixedProfile))
    expect(scale['c02_mixed_balanced_v1_projectedTotal']).toBe(c02MixedExpectedProjectedTotal(mixedProfile))
    // Mixed per-topic breakdown present (real heterogeneous workload)
    expect(scale['c02_mixed_balanced_v1_t00_messages']).toBe(20)
    expect(scale['c02_mixed_balanced_v1_t03_messages']).toBe(150)
    // Malicious raw ID must NOT appear as scale key — whitelisted to generic
    const scaleJsonForKeys = JSON.stringify(scale)
    expect(scaleJsonForKeys).not.toContain(SENTINEL_MALICIOUS_ID)
    expect(scaleJsonForKeys).not.toContain('SENTINEL_MALICIOUS')
    expect(scaleJsonForKeys).not.toContain('../../../')
    // Generic safe key for unknown profile is present (whitelist mapping)
    expect(scale['unknown_profile_generic_topics']).toBeDefined()
    // Validate that buildC02MultiScaleMap directly also sanitizes (same whitelist)
    const directScale = buildC02MultiScaleMap(
      [
        { id: C02_HEAP_PROFILE_IDS.small, profile: uniformProfile },
        { id: C02_MIXED_HEAP_PROFILE_IDS.balanced, profile: mixedProfile },
        { id: SENTINEL_MALICIOUS_ID2, profile: C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.boundary]! }
      ],
      RENDERER_HEAP_METHOD,
      'precise'
    )
    const directJson = JSON.stringify(directScale)
    expect(directJson).not.toContain(SENTINEL_MALICIOUS_ID2)
    expect(directJson).not.toContain('SENTINEL_CRED')
    expect(directJson).not.toContain('/tmp/evil')
    expect(directScale['unknown_profile_generic_topics']).toBeDefined()

    const json = JSON.stringify(result)
    // Full sentinel absence across details/metrics/gates/scale keys
    for (const sentinel of [
      SENTINEL_MALICIOUS_ID,
      SENTINEL_MALICIOUS_ID2,
      SENTINEL_CONTENT,
      SENTINEL_PATH,
      SENTINEL_CRED,
      SENTINEL_HISTORY,
      SENTINEL_ANCHOR_MIXED,
      SENTINEL_ANCHOR_UNIFORM,
      SENTINEL_REASON_MIXED,
      SENTINEL_REASON_UNIFORM,
      SENTINEL_PRODUCTION_MIXED,
      SENTINEL_PRODUCTION_UNIFORM,
      'SENTINEL_MALICIOUS_ANCHOR_SHOULD_NOT_LEAK_3',
      'SENTINEL_MALICIOUS_PRODUCTION_PATH_SHOULD_NOT_LEAK_3',
      'SENTINEL_MALICIOUS_REASON_THIRD_SHOULD_NOT_LEAK',
      'c02-heap-topic',
      'c02-mixed-topic',
      '/tmp/SENTINEL',
      '/tmp/bogus',
      '/tmp/evil'
    ]) {
      expect(json, `matrix artifact must NOT contain sentinel ${sentinel}`).not.toContain(sentinel)
    }
    expect(json).not.toContain('SENTINEL_')
    expect(json).not.toContain('MALICIOUS_REASON')
    expect(json).not.toContain('MALICIOUS_PRODUCTION')
    // Safe fixed categories preserved (whitelisted labels)
    expect(json).toContain('heapDelta-effective-precise-positive-informative')
    expect(json).toContain('canonical-production-path-complete')
    // Finite scalar metrics/gates preserved for each entry
    const metricIds = result.metrics.map((m) => m.id)
    expect(metricIds).toContain('c02_small_v1.logical.bytes')
    expect(metricIds).toContain('c02_mixed_balanced_v1.logical.bytes')
    expect(metricIds).toContain('unknown_profile_generic.logical.bytes')
    for (const id of [
      'c02_small_v1.heap.delta',
      'c02_mixed_balanced_v1.heap.delta',
      'unknown_profile_generic.heap.delta'
    ]) {
      const mv = result.metrics.find((m) => m.id === id)
      expect(mv, `metric ${id} must exist`).toBeDefined()
      expect(Number.isFinite(mv!.value)).toBe(true)
    }
    // Calibration complete gates for each entry via safe labels
    expect(result.gates.find((g) => g.id === 'c02_small_v1.calibration.complete')?.passed).toBe(true)
    expect(result.gates.find((g) => g.id === 'c02_mixed_balanced_v1.calibration.complete')?.passed).toBe(true)
    expect(result.gates.find((g) => g.id === 'unknown_profile_generic.calibration.complete')?.passed).toBe(true)
    expect(result.gates.find((g) => g.id === 'calibration.matrix.complete')?.passed).toBe(true)
  })

  it('single and matrix active builders share one sanitized surface — uniform and mixed single both validate and stay finite with no leakage', () => {
    const uniformProfile = C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.default]!
    const mixedProfile = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.countPressure]!
    const uniformTopics = buildC02SyntheticTopics(uniformProfile)
    const mixedTopics = buildC02MixedSyntheticTopics(mixedProfile)
    const uniformBytes = canonicalBytesForTopics(uniformTopics)
    const mixedBytes = canonicalBytesForTopics(mixedTopics)
    const env = {
      timestamp: new Date().toISOString(),
      node: 'v24.11.1',
      pnpm: '10.27.0',
      abiLane: 'electron' as const,
      abi: '145',
      command: 'pnpm test:e2e',
      git: { commit: 'abc123def456abc123def456abc123def456abcd', dirty: false }
    }
    const heapU = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 30_000_000,
      totalJSHeapSize: 80_000_000,
      jsHeapSizeLimit: 2_000_000_000
    } as RendererHeapSample
    const heapUAfter = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 32_000_000,
      totalJSHeapSize: 80_000_000,
      jsHeapSizeLimit: 2_000_000_000
    } as RendererHeapSample
    const heapM = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 40_000_000,
      totalJSHeapSize: 80_000_000,
      jsHeapSizeLimit: 2_000_000_000
    } as RendererHeapSample
    const heapMAfter = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 43_000_000,
      totalJSHeapSize: 80_000_000,
      jsHeapSizeLimit: 2_000_000_000
    } as RendererHeapSample
    // alloc helpers must be valid per LOCK-004 branches — anchors contain lastTopicId for ownership, group counts equal expectedVisible per profile (derived predicate), still injecting sentinel for privacy but redacted.
    const uniformExpectedVisible = c02ExpectedVisibleCount(uniformProfile)
    const uniformLastTopicId = `c02-heap-topic-${String(uniformProfile.syntheticTopics - 1).padStart(2, '0')}`
    const mixedExpectedVisibleForCountPressure = c02MixedExpectedVisibleCountForSpec(
      mixedProfile.topicSpecs[mixedProfile.topicSpecs.length - 1]!
    )
    const mixedLastTopicId = `c02-mixed-topic-${String(mixedProfile.topicSpecs.length - 1).padStart(2, '0')}`
    const allocUniform = (
      topicsCreated: number,
      messagesCreated: number,
      anchorSentinel: string,
      prod: string
    ): any => ({
      topicsCreated,
      messagesCreated,
      blocksCreated: messagesCreated,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: c02ExpectedProjectedTotal(uniformProfile),
        reduxBlocks: c02ExpectedProjectedTotal(uniformProfile),
        groupCount: uniformExpectedVisible,
        displayMessages: uniformExpectedVisible,
        anchorGroupKey: `${uniformLastTopicId}-${anchorSentinel}`,
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: uniformExpectedVisible,
        globalDisplayMessages: uniformExpectedVisible
      },
      productionPath: prod,
      productionPathComplete: true
    })
    const allocMixed = (topicsCreated: number, messagesCreated: number, anchorSentinel: string, prod: string): any => ({
      topicsCreated,
      messagesCreated,
      blocksCreated: messagesCreated,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: c02MixedExpectedProjectedTotal(mixedProfile),
        reduxBlocks: c02MixedExpectedProjectedTotal(mixedProfile),
        groupCount: mixedExpectedVisibleForCountPressure,
        displayMessages: mixedExpectedVisibleForCountPressure,
        anchorGroupKey: `${mixedLastTopicId}-${anchorSentinel}`,
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: mixedExpectedVisibleForCountPressure,
        globalDisplayMessages: mixedExpectedVisibleForCountPressure
      },
      productionPath: prod,
      productionPathComplete: true
    })
    const resUniform = buildC02BenchmarkResult(
      env,
      uniformProfile,
      uniformBytes,
      uniformBytes,
      heapU,
      heapUAfter,
      allocUniform(
        uniformProfile.syntheticTopics,
        uniformProfile.syntheticTopics * uniformProfile.syntheticMessagesPerTopic,
        'SENTINEL_UNIFORM_ANCHOR',
        'SENTINEL_UNIFORM_PROD_/tmp/leak'
      ),
      { informative: true, reason: 'SENTINEL_UNIFORM_REASON' },
      'precise'
    )
    const resMixed = buildC02MixedBenchmarkResult(
      env,
      mixedProfile,
      mixedBytes,
      mixedBytes,
      heapM,
      heapMAfter,
      allocMixed(
        mixedProfile.topicSpecs.length,
        c02MixedTotalMessages(mixedProfile),
        'SENTINEL_MIXED_ANCHOR',
        'SENTINEL_MIXED_PROD_/tmp/leak'
      ),
      { informative: true, reason: 'SENTINEL_MIXED_REASON' },
      'precise'
    )
    for (const r of [resUniform, resMixed]) {
      const problems = validateBenchmarkResult(r)
      expect(problems).toEqual([])
      for (const m of r.metrics) expect(Number.isFinite(m.value)).toBe(true)
      const j = JSON.stringify(r)
      expect(j).not.toContain('SENTINEL_')
      expect(j).not.toContain('/tmp/leak')
      expect(j).not.toContain('c02-heap-topic')
      expect(j).not.toContain('c02-mixed-topic')
    }
    // Matrix via the same multi builder consolidates both — valid per LOCK-004 with owned anchors and correct expectedVisible
    const multi = buildC02MultiBenchmarkResult(env, [
      {
        profileId: C02_HEAP_PROFILE_IDS.default,
        profile: uniformProfile,
        logicalBytes: uniformBytes,
        rendererLogicalBytes: uniformBytes,
        heapBefore: heapU,
        heapAfter: heapUAfter,
        allocation: allocUniform(
          uniformProfile.syntheticTopics,
          uniformProfile.syntheticTopics * uniformProfile.syntheticMessagesPerTopic,
          'SENTINEL_UNIFORM_ANCHOR2',
          'SENTINEL_PROD2'
        ),
        informativeness: { informative: true, reason: 'SENTINEL_REASON2' },
        precision: 'precise',
        finalTopicId: 'c02-heap-topic-01'
      },
      {
        profileId: C02_MIXED_HEAP_PROFILE_IDS.countPressure,
        profile: mixedProfile,
        logicalBytes: mixedBytes,
        rendererLogicalBytes: mixedBytes,
        heapBefore: heapM,
        heapAfter: heapMAfter,
        allocation: allocMixed(
          mixedProfile.topicSpecs.length,
          c02MixedTotalMessages(mixedProfile),
          'SENTINEL_MIXED_ANCHOR2',
          'SENTINEL_PROD2'
        ),
        informativeness: { informative: true, reason: 'SENTINEL_REASON2' },
        precision: 'precise',
        finalTopicId: 'c02-mixed-topic-07'
      }
    ])
    expect(validateBenchmarkResult(multi)).toEqual([])
    const mj = JSON.stringify(multi)
    expect(mj).not.toContain('SENTINEL_')
    expect(mj).toContain('c02_default_v1.logical.bytes')
    expect(mj).toContain('c02_mixed_count_v1.logical.bytes')
  })
})

describe('C-02 E2E activation seam — canonical single-source and per-topic window clamp (bounded correction)', () => {
  it('mixed balanced 20/50/100/150 computes per-topic waits 20/50/100/100, not four 100s (clamp 1..100)', () => {
    const balanced = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.balanced]!
    // Balanced spec: 20/50/100/150 — last 150 clamped to 100
    expect(balanced.topicSpecs.map((s) => s.messageCount)).toEqual([20, 50, 100, 150])
    const topics = buildC02MixedSyntheticTopics(balanced)
    // Cross-check: syntheticTopics messages lengths match specs
    expect(topics.map((t) => t.messages.length)).toEqual([20, 50, 100, 150])
    const perTopic = c02PerTopicExpectedVisibleCounts(topics)
    expect(perTopic).toEqual([20, 50, 100, 100])
    // Final-topic-specific expected retained only for final ownership check
    const finalOnly = c02ExpectedVisibleCountForTopic(topics[topics.length - 1]!)
    expect(finalOnly).toBe(100)
    // Cross-validate against mixed spec helper — must agree
    const perTopicViaSpec = balanced.topicSpecs.map(c02MixedExpectedVisibleCountForSpec)
    expect(perTopic).toEqual(perTopicViaSpec)
    // Projected total = sum of per-topic clamped (20+50+100+100=270), logical retained = 20+50+100+150=320
    expect(c02ExpectedProjectedTotalForTopics(topics)).toBe(270)
    expect(c02MixedExpectedProjectedTotal(balanced)).toBe(270)
    expect(c02MixedTotalMessages(balanced)).toBe(320)
    // Uniform still deterministic: 2×100 -> [100,100] projected 200
    const uniform = C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.default]!
    const uTopics = buildC02SyntheticTopics(uniform)
    expect(c02PerTopicExpectedVisibleCounts(uTopics)).toEqual([100, 100])
    expect(c02ExpectedProjectedTotalForTopics(uTopics)).toBe(200)
  })

  it('canonical topic IDs share exact prefix through the same syntheticTopics used for canonicalBytesForTopics (uniform and mixed, single and matrix prefixes)', () => {
    // Single uniform: default prefix c02-heap-topic
    const uniform = C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.default]!
    const uSingle = buildC02SyntheticTopics(uniform)
    const uSingleBytes = canonicalBytesForTopics(uSingle)
    expect(Number.isFinite(uSingleBytes) && uSingleBytes > 0).toBe(true)
    expect(uSingle.every((t) => t.topicId.startsWith('c02-heap-topic-'))).toBe(true)
    // Single mixed: prefix c02-mixed-topic — same array feeds both accounting and activation
    const mixedBalanced = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.balanced]!
    const mSingle = buildC02MixedSyntheticTopicsWithPrefix(mixedBalanced, 'c02-mixed-topic')
    const mSingleBytes = canonicalBytesForTopics(mSingle)
    expect(Number.isFinite(mSingleBytes) && mSingleBytes > 0).toBe(true)
    expect(mSingle.every((t) => t.topicId.startsWith('c02-mixed-topic-'))).toBe(true)
    // Single canonical payload is sole message/block source: activation must derive from same objects
    // Verify that per-topic helper reads topicId/messages directly — no recomputed blockContentBytes drift
    expect(mSingle[0]!.topicId).toBe('c02-mixed-topic-00')
    expect(mSingle[0]!.messages.length).toBe(20)
    expect((mSingle[0]!.blocks[0] as Record<string, unknown>).content).toBe('a'.repeat(512))
    expect(c02ExpectedVisibleCountForTopic(mSingle[0]!)).toBe(20)
    expect(c02PerTopicExpectedVisibleCounts(mSingle)).toEqual([20, 50, 100, 100])

    // Matrix uniform/mixed isolated prefixes — same array for accounting and activation, no default mutation
    const matrixUniformPrefix = 'c02-c02-small-v1-topic'
    const small = C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.small]!
    const uMatrix = buildC02SyntheticTopicsWithPrefix(small, matrixUniformPrefix)
    expect(uMatrix[0]!.topicId).toBe(`${matrixUniformPrefix}-00`)
    expect(canonicalBytesForTopics(uMatrix)).toBeGreaterThan(0)
    expect(c02PerTopicExpectedVisibleCounts(uMatrix)).toEqual([50])

    const matrixMixedPrefix = 'c02-c02-mixed-balanced-v1-topic'
    const mMatrix = buildC02MixedSyntheticTopicsWithPrefix(mixedBalanced, matrixMixedPrefix)
    expect(mMatrix[0]!.topicId).toBe(`${matrixMixedPrefix}-00`)
    expect(mMatrix[mMatrix.length - 1]!.topicId).toBe(`${matrixMixedPrefix}-03`)
    expect(canonicalBytesForTopics(mMatrix)).toBeGreaterThan(0)
    // Per-topic derived from same matrix topics — heterogeneous shape preserved
    expect(c02PerTopicExpectedVisibleCounts(mMatrix)).toEqual([20, 50, 100, 100])
    expect(c02ExpectedProjectedTotalForTopics(mMatrix)).toBe(270)
    // Ensure uniform vs mixed prefixes do not collide and IDs are deterministic
    expect(uMatrix[0]!.topicId).not.toBe(mMatrix[0]!.topicId)
  })

  it('per-topic helper mirrors production clamp 1..100 for edge counts and oversized contrast', () => {
    // Oversized contrast: 200→100, 20→20 etc.
    const oversized = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.oversizedContrast]!
    const topics = buildC02MixedSyntheticTopics(oversized)
    expect(c02PerTopicExpectedVisibleCounts(topics)).toEqual([100, 20, 20, 20])
    expect(c02ExpectedProjectedTotalForTopics(topics)).toBe(160)
    // Edge: 0→1 (clamp min), 1→1, 100→100, 1000→100
    const edgeTopics = [
      {
        topicId: 'c02-heap-topic-00',
        messages: Array.from({ length: 0 }, (_, i) => ({ id: `id-${i}` })),
        blocks: [],
        segments: [],
        completeness: { chatData: true, segments: true, residentTopic: true },
        applicabilityGeneration: 0
      },
      {
        topicId: 'c02-heap-topic-01',
        messages: Array.from({ length: 1 }, (_, i) => ({ id: `id-${i}` })),
        blocks: [],
        segments: [],
        completeness: { chatData: true, segments: true, residentTopic: true },
        applicabilityGeneration: 0
      },
      {
        topicId: 'c02-heap-topic-02',
        messages: Array.from({ length: 100 }, (_, i) => ({ id: `id-${i}` })),
        blocks: [],
        segments: [],
        completeness: { chatData: true, segments: true, residentTopic: true },
        applicabilityGeneration: 0
      },
      {
        topicId: 'c02-heap-topic-03',
        messages: Array.from({ length: 1000 }, (_, i) => ({ id: `id-${i}` })),
        blocks: [],
        segments: [],
        completeness: { chatData: true, segments: true, residentTopic: true },
        applicabilityGeneration: 0
      }
    ] as unknown as import('./perfHeapCalibration').LogicalPayloadTopicInput[]
    expect(c02PerTopicExpectedVisibleCounts(edgeTopics)).toEqual([1, 1, 100, 100])
  })
})

describe('C02 harness predicate correction — whole-topic divider (LOCK-004)', () => {
  it('C02_DEFAULT_CONTEXTCOUNT mirrors production DEFAULT_CONTEXTCOUNT 25', () => {
    expect(C02_DEFAULT_CONTEXTCOUNT).toBe(25)
  })

  it('isC02WholeTopicWindow: 20 and 25 are whole-topic, 26 and 50 are not; invalid counts are not whole-topic', () => {
    expect(isC02WholeTopicWindow(20)).toBe(true)
    expect(isC02WholeTopicWindow(25)).toBe(true)
    expect(isC02WholeTopicWindow(26)).toBe(false)
    expect(isC02WholeTopicWindow(50)).toBe(false)
    expect(isC02WholeTopicWindow(0)).toBe(false)
    expect(isC02WholeTopicWindow(-1)).toBe(false)
    expect(isC02WholeTopicWindow(1)).toBe(true)
    expect(isC02WholeTopicWindow(100)).toBe(false)
    expect(isC02WholeTopicWindow(NaN)).toBe(false)
    expect(isC02WholeTopicWindow(Infinity)).toBe(false)
    expect(isC02WholeTopicWindow(20.5)).toBe(false)
    expect(isC02WholeTopicWindow(0.5)).toBe(false)
    expect(isC02WholeTopicWindow(-5 as any)).toBe(false)
  })

  it('(a) boundary-present validation: partial window >25 requires divider with final-topic-owned anchor', () => {
    const lastTopicId = 'c02-mixed-topic-03'
    const expectedVisibleFinal = 50 // >25 => partial, divider required
    const validEvidence = {
      contextBoundaryPresent: true,
      contextBoundaryInsideMessages: true,
      anchorGroupKey: `${lastTopicId}-msg-00010-group`,
      lastTopicId,
      expectedVisibleFinal
    }
    expect(isC02ContextEvidenceValid(validEvidence)).toBe(true)
    // Missing divider for partial window must be invalid
    const missingForPartial = {
      contextBoundaryPresent: false,
      contextBoundaryInsideMessages: false,
      anchorGroupKey: null,
      lastTopicId,
      expectedVisibleFinal
    }
    expect(isC02ContextEvidenceValid(missingForPartial)).toBe(false)
    // Present but not insideMessages must be invalid
    expect(
      isC02ContextEvidenceValid({
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: false,
        anchorGroupKey: `${lastTopicId}-msg-00010-group`,
        lastTopicId,
        expectedVisibleFinal
      })
    ).toBe(false)
    // Present but anchor not final-topic-owned must be invalid
    expect(
      isC02ContextEvidenceValid({
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        anchorGroupKey: 'other-topic-msg-00000-group',
        lastTopicId,
        expectedVisibleFinal
      })
    ).toBe(false)
    // Present but anchor null must be invalid
    expect(
      isC02ContextEvidenceValid({
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        anchorGroupKey: null,
        lastTopicId,
        expectedVisibleFinal
      })
    ).toBe(false)

    // Full productionPathComplete requires ownership proof too
    const fullEvidence = {
      reduxVerified: true,
      finalTopicDomProof: true,
      groupCountExact: true,
      groupOwnershipProof: true,
      contextBoundaryPresent: true,
      contextBoundaryInsideMessages: true,
      anchorGroupKey: `${lastTopicId}-msg-00010-group`,
      lastTopicId,
      expectedVisibleFinal
    }
    expect(isC02ProductionPathComplete(fullEvidence)).toBe(true)
    // Same but missing context => false
    expect(
      isC02ProductionPathComplete({
        ...fullEvidence,
        contextBoundaryPresent: false,
        contextBoundaryInsideMessages: false,
        anchorGroupKey: null
      })
    ).toBe(false)
  })

  it('(b) valid boundary-absent whole-topic window: 20 <=25 without divider and null anchor is valid', () => {
    const lastTopicId = 'c02-mixed-topic-03'
    const expectedVisibleFinal = 20 // <=25 => whole-topic, divider absent by design
    const wholeTopicValidEvidence = {
      contextBoundaryPresent: false,
      contextBoundaryInsideMessages: false,
      anchorGroupKey: null,
      lastTopicId,
      expectedVisibleFinal
    }
    expect(isC02ContextEvidenceValid(wholeTopicValidEvidence)).toBe(true)

    const fullWholeTopicEvidence = {
      reduxVerified: true,
      finalTopicDomProof: true,
      groupCountExact: true,
      groupOwnershipProof: true,
      contextBoundaryPresent: false,
      contextBoundaryInsideMessages: false,
      anchorGroupKey: null,
      lastTopicId,
      expectedVisibleFinal
    }
    expect(isC02ProductionPathComplete(fullWholeTopicEvidence)).toBe(true)

    // Oversized-contrast final topic concrete: 20 messages -> 20 visible -> whole-topic
    const oversized = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.oversizedContrast]!
    const topics = buildC02MixedSyntheticTopics(oversized)
    const finalTopic = topics[topics.length - 1]!
    const finalVisible = c02ExpectedVisibleCountForTopic(finalTopic)
    expect(finalVisible).toBe(20)
    expect(isC02WholeTopicWindow(finalVisible)).toBe(true)
    expect(
      isC02ContextEvidenceValid({
        contextBoundaryPresent: false,
        contextBoundaryInsideMessages: false,
        anchorGroupKey: null,
        lastTopicId: finalTopic.topicId,
        expectedVisibleFinal: finalVisible
      })
    ).toBe(true)
    // Strict present for whole-topic must be rejected — decisive whole-topic branch requires no divider anywhere (LOCK-004)
    expect(
      isC02ContextEvidenceValid({
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        anchorGroupKey: `${finalTopic.topicId}-msg-00000`,
        lastTopicId: finalTopic.topicId,
        expectedVisibleFinal: finalVisible
      })
    ).toBe(false)
    // Outside/global divider for whole-topic also rejected
    expect(
      isC02ContextEvidenceValid({
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: false,
        anchorGroupKey: null,
        lastTopicId: finalTopic.topicId,
        expectedVisibleFinal: finalVisible
      })
    ).toBe(false)
  })

  it('remains false for invalid/missing evidence outside explicitly valid condition', () => {
    const lastTopicId = 'c02-mixed-topic-03'
    // Whole-topic but missing other proofs => incomplete
    const wholeTopicButReduxFalse = {
      reduxVerified: false,
      finalTopicDomProof: true,
      groupCountExact: true,
      groupOwnershipProof: true,
      contextBoundaryPresent: false,
      contextBoundaryInsideMessages: false,
      anchorGroupKey: null,
      lastTopicId,
      expectedVisibleFinal: 20
    }
    expect(isC02ProductionPathComplete(wholeTopicButReduxFalse)).toBe(false)

    const wholeTopicButFinalDomFalse = {
      reduxVerified: true,
      finalTopicDomProof: false,
      groupCountExact: true,
      groupOwnershipProof: true,
      contextBoundaryPresent: false,
      contextBoundaryInsideMessages: false,
      anchorGroupKey: null,
      lastTopicId,
      expectedVisibleFinal: 20
    }
    expect(isC02ProductionPathComplete(wholeTopicButFinalDomFalse)).toBe(false)

    const wholeTopicButGroupNotExact = {
      reduxVerified: true,
      finalTopicDomProof: true,
      groupCountExact: false,
      groupOwnershipProof: false,
      contextBoundaryPresent: false,
      contextBoundaryInsideMessages: false,
      anchorGroupKey: null,
      lastTopicId,
      expectedVisibleFinal: 20
    }
    expect(isC02ProductionPathComplete(wholeTopicButGroupNotExact)).toBe(false)

    // Partial window missing divider remains false (not whole-topic)
    const partialMissing = {
      reduxVerified: true,
      finalTopicDomProof: true,
      groupCountExact: true,
      groupOwnershipProof: true,
      contextBoundaryPresent: false,
      contextBoundaryInsideMessages: false,
      anchorGroupKey: null,
      lastTopicId,
      expectedVisibleFinal: 100
    }
    expect(isC02ProductionPathComplete(partialMissing)).toBe(false)
    expect(
      isC02ContextEvidenceValid({
        contextBoundaryPresent: false,
        contextBoundaryInsideMessages: false,
        anchorGroupKey: null,
        lastTopicId,
        expectedVisibleFinal: 100
      })
    ).toBe(false)

    // Whole-topic with spurious anchor (should not happen) is not considered valid whole-topic absent
    expect(
      isC02ContextEvidenceValid({
        contextBoundaryPresent: false,
        contextBoundaryInsideMessages: false,
        anchorGroupKey: 'spurious-anchor',
        lastTopicId,
        expectedVisibleFinal: 20
      })
    ).toBe(false)
    // Whole-topic with divider present but anchor not owned => strict fails, whole-topic branch requires absent, so false
    expect(
      isC02ContextEvidenceValid({
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        anchorGroupKey: 'other-id',
        lastTopicId,
        expectedVisibleFinal: 20
      })
    ).toBe(false)

    // Balanced final topic 100 (partial) must not be considered whole-topic
    const balanced = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.balanced]!
    const balTopics = buildC02MixedSyntheticTopics(balanced)
    const balFinalVisible = c02ExpectedVisibleCountForTopic(balTopics[balTopics.length - 1]!)
    expect(balFinalVisible).toBe(100)
    expect(isC02WholeTopicWindow(balFinalVisible)).toBe(false)
    expect(
      isC02ContextEvidenceValid({
        contextBoundaryPresent: false,
        contextBoundaryInsideMessages: false,
        anchorGroupKey: null,
        lastTopicId: balTopics[balTopics.length - 1]!.topicId,
        expectedVisibleFinal: balFinalVisible
      })
    ).toBe(false)
  })
})

describe('C02 audit correction — decisive whole-topic, hardened visible, global/outside rejection, builder whole-topic success', () => {
  it('whole-topic strict-divider rejection: 20 with divider inside and owned anchor is invalid (decisive branch)', () => {
    const lastTopicId = 'c02-heap-topic-00'
    const expectedVisibleFinal = 20
    expect(isC02WholeTopicWindow(expectedVisibleFinal)).toBe(true)
    // Strict divider that would be valid for partial is rejected for whole-topic
    expect(
      isC02ContextEvidenceValid({
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        anchorGroupKey: `${lastTopicId}-group`,
        lastTopicId,
        expectedVisibleFinal
      })
    ).toBe(false)
    expect(
      isC02ProductionPathComplete({
        reduxVerified: true,
        finalTopicDomProof: true,
        groupCountExact: true,
        groupOwnershipProof: true,
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        anchorGroupKey: `${lastTopicId}-group`,
        lastTopicId,
        expectedVisibleFinal
      })
    ).toBe(false)
  })

  it('whole-topic outside/global-divider rejection: 20 with divider outside #messages is invalid', () => {
    const lastTopicId = 'c02-heap-topic-00'
    const expectedVisibleFinal = 20
    expect(isC02WholeTopicWindow(expectedVisibleFinal)).toBe(true)
    // Global/outside divider: present true but inside false — invalid for whole-topic and partial
    expect(
      isC02ContextEvidenceValid({
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: false,
        anchorGroupKey: null,
        lastTopicId,
        expectedVisibleFinal
      })
    ).toBe(false)
    // Even with anchor, outside divider is invalid
    expect(
      isC02ContextEvidenceValid({
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: false,
        anchorGroupKey: `${lastTopicId}-group`,
        lastTopicId,
        expectedVisibleFinal
      })
    ).toBe(false)
    expect(
      isC02ProductionPathComplete({
        reduxVerified: true,
        finalTopicDomProof: true,
        groupCountExact: true,
        groupOwnershipProof: true,
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: false,
        anchorGroupKey: null,
        lastTopicId,
        expectedVisibleFinal
      })
    ).toBe(false)
    // Partial window with global divider also invalid
    const partialOutside = {
      contextBoundaryPresent: true,
      contextBoundaryInsideMessages: false,
      anchorGroupKey: `${lastTopicId}-group`,
      lastTopicId,
      expectedVisibleFinal: 50
    }
    expect(isC02WholeTopicWindow(50)).toBe(false)
    expect(isC02ContextEvidenceValid(partialOutside)).toBe(false)
  })

  it('invalid visible counts are rejected for both branches (0, negative, NaN, Infinity, non-integer)', () => {
    const lastTopicId = 'c02-heap-topic-00'
    const validStrict = {
      contextBoundaryPresent: true,
      contextBoundaryInsideMessages: true,
      anchorGroupKey: `${lastTopicId}-group`,
      lastTopicId
    }
    const validWhole = {
      contextBoundaryPresent: false,
      contextBoundaryInsideMessages: false,
      anchorGroupKey: null,
      lastTopicId
    }
    const invalidCounts: number[] = [0, -1, -5, NaN, Infinity, -Infinity, 0.5, 20.5, 25.1, 101, 150]
    for (const c of invalidCounts) {
      expect(isC02WholeTopicWindow(c), `isWholeTopic ${String(c)} should be false`).toBe(false)
      expect(
        isC02ContextEvidenceValid({ ...validStrict, expectedVisibleFinal: c }),
        `strict with invalid count ${String(c)} should be false`
      ).toBe(false)
      expect(
        isC02ContextEvidenceValid({ ...validWhole, expectedVisibleFinal: c }),
        `whole with invalid count ${String(c)} should be false`
      ).toBe(false)
      expect(
        isC02ProductionPathComplete({
          reduxVerified: true,
          finalTopicDomProof: true,
          groupCountExact: true,
          groupOwnershipProof: true,
          contextBoundaryPresent: false,
          contextBoundaryInsideMessages: false,
          anchorGroupKey: null,
          lastTopicId,
          expectedVisibleFinal: c
        }),
        `productionPath with invalid count ${String(c)} should be false`
      ).toBe(false)
    }
    // Boundary valid counts still work
    expect(isC02WholeTopicWindow(1)).toBe(true)
    expect(isC02WholeTopicWindow(25)).toBe(true)
    expect(isC02WholeTopicWindow(26)).toBe(false)
    expect(isC02ContextEvidenceValid({ ...validWhole, expectedVisibleFinal: 1 })).toBe(true)
    expect(isC02ContextEvidenceValid({ ...validWhole, expectedVisibleFinal: 25 })).toBe(true)
    expect(isC02ContextEvidenceValid({ ...validStrict, expectedVisibleFinal: 26 })).toBe(true)
  })

  it('builder output where all correctness gates pass for valid whole-topic allocation (uniform)', () => {
    const profile = {
      syntheticTopics: 1,
      syntheticMessagesPerTopic: 20,
      blockContentBytes: 512,
      segmentCountPerTopic: 0,
      applicabilityGeneration: 0
    }
    const topics = buildC02SyntheticTopics(profile as any)
    const logicalBytes = canonicalBytesForTopics(topics)
    const rendererLogicalBytes = logicalBytes
    const heapBefore = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 20_000_000,
      totalJSHeapSize: 80_000_000,
      jsHeapSizeLimit: 2_000_000_000
    } as RendererHeapSample
    const heapAfter = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 22_500_000,
      totalJSHeapSize: 80_000_000,
      jsHeapSizeLimit: 2_000_000_000
    } as RendererHeapSample
    const informativeness = classifyEffectiveHeapDeltaInformative(
      heapAfter.usedJSHeapSize - heapBefore.usedJSHeapSize,
      'precise'
    )
    expect(informativeness.informative).toBe(true)
    const expectedVisible = c02ExpectedVisibleCount(profile as any)
    expect(expectedVisible).toBe(20)
    expect(isC02WholeTopicWindow(expectedVisible)).toBe(true)
    const allocation = {
      topicsCreated: profile.syntheticTopics,
      messagesCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      blocksCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: expectedVisible,
        reduxBlocks: expectedVisible,
        groupCount: expectedVisible,
        displayMessages: expectedVisible,
        anchorGroupKey: null,
        contextBoundaryPresent: false,
        contextBoundaryInsideMessages: false,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: expectedVisible,
        globalDisplayMessages: expectedVisible
      },
      productionPath: 'canonical whole-topic valid no divider',
      productionPathComplete: true
    }
    // Verify predicate itself is true for this allocation
    expect(
      isC02ContextEvidenceValid({
        contextBoundaryPresent: allocation.projectionStats.contextBoundaryPresent,
        contextBoundaryInsideMessages: allocation.projectionStats.contextBoundaryInsideMessages!,
        anchorGroupKey: allocation.projectionStats.anchorGroupKey,
        lastTopicId: 'c02-heap-topic-00',
        expectedVisibleFinal: expectedVisible
      })
    ).toBe(true)
    const environment = {
      timestamp: new Date().toISOString(),
      node: 'v24.11.1',
      pnpm: '10.27.0',
      abiLane: 'electron' as const,
      abi: '145',
      command: 'pnpm test:e2e',
      git: { commit: 'abc123def456abc123def456abc123def456abcd', dirty: false }
    }
    const result = buildC02BenchmarkResult(
      environment,
      profile as any,
      logicalBytes,
      rendererLogicalBytes,
      heapBefore,
      heapAfter,
      allocation,
      informativeness,
      'precise'
    )
    const problems = validateBenchmarkResult(result)
    expect(problems, `uniform whole-topic artifact must validate: ${problems.join('; ')}`).toEqual([])
    // All correctness gates that depend on context must pass for valid whole-topic
    expect(result.gates.find((g) => g.id === 'projection.contextBoundaryExplicit')?.passed).toBe(true)
    expect(result.gates.find((g) => g.id === 'productionPath.complete')?.passed).toBe(true)
    expect(result.gates.find((g) => g.id === 'allocation.resident')?.passed).toBe(true)
    expect(result.gates.find((g) => g.id === 'calibration.complete')?.passed).toBe(true)
    expect(result.metrics.find((m) => m.id === 'calibration.complete')?.value).toBe(1)
  })

  it('builder output where all correctness gates pass for valid whole-topic allocation (mixed)', () => {
    const profile = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.oversizedContrast]!
    const topics = buildC02MixedSyntheticTopics(profile)
    const logicalBytes = canonicalBytesForTopics(topics)
    const rendererLogicalBytes = logicalBytes
    const heapBefore = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 20_000_000,
      totalJSHeapSize: 80_000_000,
      jsHeapSizeLimit: 2_000_000_000
    } as RendererHeapSample
    const heapAfter = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 22_500_000,
      totalJSHeapSize: 80_000_000,
      jsHeapSizeLimit: 2_000_000_000
    } as RendererHeapSample
    const informativeness = classifyEffectiveHeapDeltaInformative(
      heapAfter.usedJSHeapSize - heapBefore.usedJSHeapSize,
      'precise'
    )
    expect(informativeness.informative).toBe(true)
    const lastSpec = profile.topicSpecs[profile.topicSpecs.length - 1]!
    const expectedVisible = c02MixedExpectedVisibleCountForSpec(lastSpec)
    expect(expectedVisible).toBe(20)
    expect(isC02WholeTopicWindow(expectedVisible)).toBe(true)
    const expectedProjected = c02MixedExpectedProjectedTotal(profile)
    const allocation = {
      topicsCreated: profile.topicSpecs.length,
      messagesCreated: c02MixedTotalMessages(profile),
      blocksCreated: c02MixedTotalMessages(profile),
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: expectedProjected,
        reduxBlocks: expectedProjected,
        groupCount: expectedVisible,
        displayMessages: expectedVisible,
        anchorGroupKey: null,
        contextBoundaryPresent: false,
        contextBoundaryInsideMessages: false,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: expectedVisible,
        globalDisplayMessages: expectedVisible
      },
      productionPath: 'canonical whole-topic valid no divider mixed',
      productionPathComplete: true
    }
    expect(
      isC02ContextEvidenceValid({
        contextBoundaryPresent: allocation.projectionStats.contextBoundaryPresent,
        contextBoundaryInsideMessages: allocation.projectionStats.contextBoundaryInsideMessages!,
        anchorGroupKey: allocation.projectionStats.anchorGroupKey,
        lastTopicId: `c02-mixed-topic-${String(profile.topicSpecs.length - 1).padStart(2, '0')}`,
        expectedVisibleFinal: expectedVisible
      })
    ).toBe(true)
    const environment = {
      timestamp: new Date().toISOString(),
      node: 'v24.11.1',
      pnpm: '10.27.0',
      abiLane: 'electron' as const,
      abi: '145',
      command: 'pnpm test:e2e',
      git: { commit: 'abc123def456abc123def456abc123def456abcd', dirty: false }
    }
    const result = buildC02MixedBenchmarkResult(
      environment,
      profile,
      logicalBytes,
      rendererLogicalBytes,
      heapBefore,
      heapAfter,
      allocation,
      informativeness,
      'precise'
    )
    const problems = validateBenchmarkResult(result)
    expect(problems, `mixed whole-topic artifact must validate: ${problems.join('; ')}`).toEqual([])
    expect(result.gates.find((g) => g.id === 'projection.contextBoundaryExplicit')?.passed).toBe(true)
    expect(result.gates.find((g) => g.id === 'productionPath.complete')?.passed).toBe(true)
    expect(result.gates.find((g) => g.id === 'allocation.resident')?.passed).toBe(true)
    expect(result.gates.find((g) => g.id === 'calibration.complete')?.passed).toBe(true)
    expect(result.metrics.find((m) => m.id === 'calibration.complete')?.value).toBe(1)
  })
})

describe('C02 builder-interface integrity — fail-closed on invalid/omitted context evidence (LOCK-004)', () => {
  function makeTestEnvironment(): BenchmarkResult['environment'] {
    return {
      timestamp: new Date().toISOString(),
      node: 'v24.11.1',
      pnpm: '10.27.0',
      abiLane: 'electron',
      abi: '145',
      command: 'pnpm test:e2e',
      git: { commit: 'abc123def456abc123def456abc123def456abcd', dirty: false }
    }
  }
  function makeHeapPair(deltaBytes: number): { before: RendererHeapSample; after: RendererHeapSample } {
    const before: RendererHeapSample = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 20_000_000,
      totalJSHeapSize: 80_000_000,
      jsHeapSizeLimit: 2_000_000_000
    }
    const after: RendererHeapSample = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 20_000_000 + deltaBytes,
      totalJSHeapSize: 80_000_000,
      jsHeapSizeLimit: 2_000_000_000
    }
    return { before, after }
  }

  it('uniform builder: caller productionPathComplete true with invalid context evidence cannot yield complete (partial window missing divider, whole-topic with spurious divider, outside/global divider)', () => {
    const profile = C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.small]! // 50 => partial >25
    const topics = buildC02SyntheticTopics(profile)
    const logicalBytes = canonicalBytesForTopics(topics)
    const { before: heapBefore, after: heapAfter } = makeHeapPair(2_500_000)
    const informativeness = classifyEffectiveHeapDeltaInformative(
      heapAfter.usedJSHeapSize - heapBefore.usedJSHeapSize,
      'precise'
    )
    expect(informativeness.informative).toBe(true)
    const expectedVisible = c02ExpectedVisibleCount(profile)
    expect(expectedVisible).toBe(50)
    expect(isC02WholeTopicWindow(expectedVisible)).toBe(false)
    // Case A: partial window missing divider but caller claims complete true — must fail closed to incomplete
    const allocationMissingDivider: any = {
      topicsCreated: profile.syntheticTopics,
      messagesCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      blocksCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: c02ExpectedProjectedTotal(profile),
        reduxBlocks: c02ExpectedProjectedTotal(profile),
        groupCount: expectedVisible,
        displayMessages: expectedVisible,
        anchorGroupKey: null,
        contextBoundaryPresent: false,
        contextBoundaryInsideMessages: false,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: expectedVisible,
        globalDisplayMessages: expectedVisible
      },
      productionPath: 'spurious caller claim complete with missing divider',
      productionPathComplete: true
    }
    const resultA = buildC02BenchmarkResult(
      makeTestEnvironment(),
      profile,
      logicalBytes,
      logicalBytes,
      heapBefore,
      heapAfter,
      allocationMissingDivider,
      informativeness,
      'precise'
    )
    expect(validateBenchmarkResult(resultA)).toEqual([])
    expect(resultA.metrics.find((m) => m.id === 'projection.productionPathComplete')?.value).toBe(0)
    expect(resultA.metrics.find((m) => m.id === 'calibration.complete')?.value).toBe(0)
    expect(resultA.gates.find((g) => g.id === 'projection.contextBoundaryExplicit')?.passed).toBe(false)
    expect(resultA.gates.find((g) => g.id === 'productionPath.complete')?.passed).toBe(false)
    expect(resultA.gates.find((g) => g.id === 'allocation.resident')?.passed).toBe(false)
    expect(resultA.gates.find((g) => g.id === 'calibration.complete')?.passed).toBe(false)
    const jsonA = JSON.stringify(resultA)
    expect(jsonA).toContain('whole-topic windows (1..25) require no divider anywhere + null anchor')
    expect(jsonA).toContain('partial windows require divider inside #messages + final-owned anchor')

    // Case B: whole-topic window 20 with spurious divider inside but caller true — must be incomplete (decisive whole-topic branch)
    const wholeProfile = {
      syntheticTopics: 1,
      syntheticMessagesPerTopic: 20,
      blockContentBytes: 512,
      segmentCountPerTopic: 0,
      applicabilityGeneration: 0
    } as C02HeapProfile
    const wholeTopics = buildC02SyntheticTopics(wholeProfile as any)
    const wholeBytes = canonicalBytesForTopics(wholeTopics)
    const wholeExpected = c02ExpectedVisibleCount(wholeProfile as any)
    expect(wholeExpected).toBe(20)
    expect(isC02WholeTopicWindow(wholeExpected)).toBe(true)
    const allocationSpuriousDivider: any = {
      topicsCreated: 1,
      messagesCreated: 20,
      blocksCreated: 20,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: 20,
        reduxBlocks: 20,
        groupCount: 20,
        displayMessages: 20,
        anchorGroupKey: 'c02-heap-topic-00-group',
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: 20,
        globalDisplayMessages: 20
      },
      productionPath: 'spurious divider for whole-topic but caller true',
      productionPathComplete: true
    }
    const resultB = buildC02BenchmarkResult(
      makeTestEnvironment(),
      wholeProfile as any,
      wholeBytes,
      wholeBytes,
      heapBefore,
      heapAfter,
      allocationSpuriousDivider,
      informativeness,
      'precise'
    )
    expect(validateBenchmarkResult(resultB)).toEqual([])
    expect(resultB.metrics.find((m) => m.id === 'calibration.complete')?.value).toBe(0)
    expect(resultB.gates.find((g) => g.id === 'calibration.complete')?.passed).toBe(false)

    // Case C: partial window with global/outside divider (present true but inside false) — invalid even with caller true
    const allocationOutside: any = {
      topicsCreated: profile.syntheticTopics,
      messagesCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      blocksCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: c02ExpectedProjectedTotal(profile),
        reduxBlocks: c02ExpectedProjectedTotal(profile),
        groupCount: expectedVisible,
        displayMessages: expectedVisible,
        anchorGroupKey: null,
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: false,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: expectedVisible,
        globalDisplayMessages: expectedVisible
      },
      productionPath: 'outside divider global but caller true',
      productionPathComplete: true
    }
    const resultC = buildC02BenchmarkResult(
      makeTestEnvironment(),
      profile,
      logicalBytes,
      logicalBytes,
      heapBefore,
      heapAfter,
      allocationOutside,
      informativeness,
      'precise'
    )
    expect(resultC.metrics.find((m) => m.id === 'calibration.complete')?.value).toBe(0)
    expect(resultC.gates.find((g) => g.id === 'projection.contextBoundaryExplicit')?.passed).toBe(false)
  })

  it('mixed builder: caller productionPathComplete true with invalid context evidence cannot yield complete', () => {
    const profile = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.balanced]! // last 150->100 partial
    const topics = buildC02MixedSyntheticTopics(profile)
    const logicalBytes = canonicalBytesForTopics(topics)
    const { before: heapBefore, after: heapAfter } = makeHeapPair(2_500_000)
    const informativeness = classifyEffectiveHeapDeltaInformative(
      heapAfter.usedJSHeapSize - heapBefore.usedJSHeapSize,
      'precise'
    )
    const expectedVisible = c02MixedExpectedVisibleCountForSpec(profile.topicSpecs[profile.topicSpecs.length - 1]!)
    expect(expectedVisible).toBe(100)
    expect(isC02WholeTopicWindow(expectedVisible)).toBe(false)
    const allocationInvalid: any = {
      topicsCreated: profile.topicSpecs.length,
      messagesCreated: c02MixedTotalMessages(profile),
      blocksCreated: c02MixedTotalMessages(profile),
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: c02MixedExpectedProjectedTotal(profile),
        reduxBlocks: c02MixedExpectedProjectedTotal(profile),
        groupCount: expectedVisible,
        displayMessages: expectedVisible,
        anchorGroupKey: null,
        contextBoundaryPresent: false,
        contextBoundaryInsideMessages: false,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: expectedVisible,
        globalDisplayMessages: expectedVisible
      },
      productionPath: 'mixed invalid missing divider but caller true',
      productionPathComplete: true
    }
    const result = buildC02MixedBenchmarkResult(
      makeTestEnvironment(),
      profile,
      logicalBytes,
      logicalBytes,
      heapBefore,
      heapAfter,
      allocationInvalid,
      informativeness,
      'precise'
    )
    expect(validateBenchmarkResult(result)).toEqual([])
    expect(result.metrics.find((m) => m.id === 'calibration.complete')?.value).toBe(0)
    expect(result.gates.find((g) => g.id === 'calibration.complete')?.passed).toBe(false)
    expect(result.gates.find((g) => g.id === 'projection.contextBoundaryExplicit')?.passed).toBe(false)
    const json = JSON.stringify(result)
    expect(json).toContain('whole-topic windows (1..25) require no divider anywhere + null anchor')
    expect(json).toContain('partial windows require divider inside #messages + final-owned anchor')
  })

  it('multi builder: caller productionPathComplete true with invalid context evidence cannot yield complete per-entry and matrix fails', () => {
    const uniformProfile = C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.small]! // 50 partial
    const uniformTopics = buildC02SyntheticTopics(uniformProfile)
    const uniformBytes = canonicalBytesForTopics(uniformTopics)
    const heapValid = makeHeapPair(2_000_000)
    const heapInvalid = makeHeapPair(2_000_000)
    const infoValid = classifyEffectiveHeapDeltaInformative(
      heapValid.after.usedJSHeapSize - heapValid.before.usedJSHeapSize,
      'precise'
    )
    const infoInvalid = classifyEffectiveHeapDeltaInformative(
      heapInvalid.after.usedJSHeapSize - heapInvalid.before.usedJSHeapSize,
      'precise'
    )
    const expectedVisibleUniform = c02ExpectedVisibleCount(uniformProfile)
    const validAllocation: any = {
      topicsCreated: uniformProfile.syntheticTopics,
      messagesCreated: uniformProfile.syntheticTopics * uniformProfile.syntheticMessagesPerTopic,
      blocksCreated: uniformProfile.syntheticTopics * uniformProfile.syntheticMessagesPerTopic,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: c02ExpectedProjectedTotal(uniformProfile),
        reduxBlocks: c02ExpectedProjectedTotal(uniformProfile),
        groupCount: expectedVisibleUniform,
        displayMessages: expectedVisibleUniform,
        anchorGroupKey: 'c02-heap-topic-00-group',
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: expectedVisibleUniform,
        globalDisplayMessages: expectedVisibleUniform
      },
      productionPath: 'valid partial',
      productionPathComplete: true
    }
    // Include lastTopicId ownership: for uniform small, lastTopicId is c02-heap-topic-00, anchor contains it so valid
    const invalidAllocation: any = {
      topicsCreated: uniformProfile.syntheticTopics,
      messagesCreated: uniformProfile.syntheticTopics * uniformProfile.syntheticMessagesPerTopic,
      blocksCreated: uniformProfile.syntheticTopics * uniformProfile.syntheticMessagesPerTopic,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: c02ExpectedProjectedTotal(uniformProfile),
        reduxBlocks: c02ExpectedProjectedTotal(uniformProfile),
        groupCount: expectedVisibleUniform,
        displayMessages: expectedVisibleUniform,
        anchorGroupKey: null,
        contextBoundaryPresent: false,
        contextBoundaryInsideMessages: false,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: expectedVisibleUniform,
        globalDisplayMessages: expectedVisibleUniform
      },
      productionPath: 'invalid missing divider but caller true',
      productionPathComplete: true
    }
    const result = buildC02MultiBenchmarkResult(makeTestEnvironment(), [
      {
        profileId: C02_HEAP_PROFILE_IDS.small,
        profile: uniformProfile,
        logicalBytes: uniformBytes,
        rendererLogicalBytes: uniformBytes,
        heapBefore: heapValid.before,
        heapAfter: heapValid.after,
        allocation: validAllocation,
        informativeness: infoValid,
        precision: 'precise',
        finalTopicId: 'c02-heap-topic-00'
      },
      {
        profileId: C02_HEAP_PROFILE_IDS.default,
        profile: C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.default]!,
        logicalBytes: uniformBytes,
        rendererLogicalBytes: uniformBytes,
        heapBefore: heapInvalid.before,
        heapAfter: heapInvalid.after,
        allocation: invalidAllocation,
        informativeness: infoInvalid,
        precision: 'precise',
        finalTopicId: 'c02-heap-topic-01'
      }
    ])
    expect(validateBenchmarkResult(result)).toEqual([])
    const validMetric = result.metrics.find((m) => m.id === 'c02_small_v1.calibration.complete')
    const invalidMetric = result.metrics.find((m) => m.id === 'c02_default_v1.calibration.complete')
    expect(validMetric?.value).toBe(1)
    expect(invalidMetric?.value).toBe(0)
    const validGate = result.gates.find((g) => g.id === 'c02_small_v1.calibration.complete')
    const invalidGate = result.gates.find((g) => g.id === 'c02_default_v1.calibration.complete')
    expect(validGate?.passed).toBe(true)
    expect(invalidGate?.passed).toBe(false)
    expect(result.gates.find((g) => g.id === 'calibration.matrix.complete')?.passed).toBe(false)
  })

  it('omission of contextBoundaryInsideMessages fails closed via throw for uniform, mixed, and multi builders', () => {
    const profile = C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.default]!
    const topics = buildC02SyntheticTopics(profile)
    const logicalBytes = canonicalBytesForTopics(topics)
    const { before: heapBefore, after: heapAfter } = makeHeapPair(2_500_000)
    const informativeness = classifyEffectiveHeapDeltaInformative(
      heapAfter.usedJSHeapSize - heapBefore.usedJSHeapSize,
      'precise'
    )
    const baseAllocation: any = {
      topicsCreated: profile.syntheticTopics,
      messagesCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      blocksCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: c02ExpectedProjectedTotal(profile),
        reduxBlocks: c02ExpectedProjectedTotal(profile),
        groupCount: 100,
        displayMessages: 100,
        anchorGroupKey: 'c02-heap-topic-01-group',
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: 100,
        globalDisplayMessages: 100
      },
      productionPath: 'omitted inside signal',
      productionPathComplete: true
    }
    delete baseAllocation.projectionStats.contextBoundaryInsideMessages
    expect(() =>
      buildC02BenchmarkResult(
        makeTestEnvironment(),
        profile,
        logicalBytes,
        logicalBytes,
        heapBefore,
        heapAfter,
        baseAllocation,
        informativeness,
        'precise'
      )
    ).toThrow(/fail-closed.*contextBoundaryInsideMessages is required/)
    expect(() =>
      buildC02BenchmarkResult(
        makeTestEnvironment(),
        profile,
        logicalBytes,
        logicalBytes,
        heapBefore,
        heapAfter,
        {
          ...baseAllocation,
          projectionStats: { ...baseAllocation.projectionStats, contextBoundaryInsideMessages: undefined as any }
        },
        informativeness,
        'precise'
      )
    ).toThrow(/fail-closed/)

    const mixedProfile = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.balanced]!
    const mixedTopics = buildC02MixedSyntheticTopics(mixedProfile)
    const mixedBytes = canonicalBytesForTopics(mixedTopics)
    const mixedBase: any = {
      topicsCreated: mixedProfile.topicSpecs.length,
      messagesCreated: c02MixedTotalMessages(mixedProfile),
      blocksCreated: c02MixedTotalMessages(mixedProfile),
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: c02MixedExpectedProjectedTotal(mixedProfile),
        reduxBlocks: c02MixedExpectedProjectedTotal(mixedProfile),
        groupCount: 100,
        displayMessages: 100,
        anchorGroupKey: 'c02-mixed-topic-03-group',
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: 100,
        globalDisplayMessages: 100
      },
      productionPath: 'mixed omitted',
      productionPathComplete: true
    }
    delete mixedBase.projectionStats.contextBoundaryInsideMessages
    expect(() =>
      buildC02MixedBenchmarkResult(
        makeTestEnvironment(),
        mixedProfile,
        mixedBytes,
        mixedBytes,
        heapBefore,
        heapAfter,
        mixedBase,
        informativeness,
        'precise'
      )
    ).toThrow(/fail-closed.*contextBoundaryInsideMessages/)

    const multiEntries: any = [
      {
        profileId: C02_HEAP_PROFILE_IDS.small,
        profile: C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.small]!,
        logicalBytes: mixedBytes,
        rendererLogicalBytes: mixedBytes,
        heapBefore,
        heapAfter,
        allocation: mixedBase,
        informativeness,
        precision: 'precise' as const,
        finalTopicId: 'c02-heap-topic-00'
      }
    ]
    expect(() => buildC02MultiBenchmarkResult(makeTestEnvironment(), multiEntries)).toThrow(/fail-closed/)
  })

  it('wording-sensitive: artifact metric/gate names and details explicitly state both valid branches (whole-topic 1..25 no-divider/null-anchor and partial inside-divider/final-owned) with mandatory inside signal', () => {
    const profile = C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.small]!
    const topics = buildC02SyntheticTopics(profile)
    const logicalBytes = canonicalBytesForTopics(topics)
    const { before: heapBefore, after: heapAfter } = makeHeapPair(2_500_000)
    const informativeness = classifyEffectiveHeapDeltaInformative(
      heapAfter.usedJSHeapSize - heapBefore.usedJSHeapSize,
      'precise'
    )
    const expectedVisible = c02ExpectedVisibleCount(profile)
    const allocationValid: any = {
      topicsCreated: profile.syntheticTopics,
      messagesCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      blocksCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: c02ExpectedProjectedTotal(profile),
        reduxBlocks: c02ExpectedProjectedTotal(profile),
        groupCount: expectedVisible,
        displayMessages: expectedVisible,
        anchorGroupKey: 'c02-heap-topic-00-group',
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: expectedVisible,
        globalDisplayMessages: expectedVisible
      },
      productionPath: 'valid',
      productionPathComplete: true
    }
    const result = buildC02BenchmarkResult(
      makeTestEnvironment(),
      profile,
      logicalBytes,
      logicalBytes,
      heapBefore,
      heapAfter,
      allocationValid,
      informativeness,
      'precise'
    )
    const json = JSON.stringify(result)
    // Metrics and gates must contain both branch descriptions
    expect(json).toContain('whole-topic windows (1..25) require no divider anywhere + null anchor')
    expect(json).toContain('partial windows require divider inside #messages + final-owned anchor')
    expect(json).toContain('explicit inside signal mandatory')
    expect(json).toContain('fail-closed')
    // ProductionPath metric name must indicate derived per LOCK-004 branches
    const prodMetric = result.metrics.find((m) => m.id === 'projection.productionPathComplete')
    expect(prodMetric?.name).toContain(
      'whole-topic (1..25) no-divider/null-anchor branch and partial inside-divider/final-owned branch'
    )
    const contextGate = result.gates.find((g) => g.id === 'projection.contextBoundaryExplicit')
    expect(contextGate?.name).toContain('whole-topic windows (1..25) require no divider anywhere + null anchor')
    expect(contextGate?.name).toContain('partial windows require divider inside #messages + final-owned anchor')
    // Mixed also wording-sensitive
    const mixedProfile = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.oversizedContrast]! // whole-topic final 20
    const mixedTopics = buildC02MixedSyntheticTopics(mixedProfile)
    const mixedBytes = canonicalBytesForTopics(mixedTopics)
    const mixedExpected = c02MixedExpectedVisibleCountForSpec(
      mixedProfile.topicSpecs[mixedProfile.topicSpecs.length - 1]!
    )
    expect(mixedExpected).toBe(20)
    const mixedAlloc: any = {
      topicsCreated: mixedProfile.topicSpecs.length,
      messagesCreated: c02MixedTotalMessages(mixedProfile),
      blocksCreated: c02MixedTotalMessages(mixedProfile),
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: c02MixedExpectedProjectedTotal(mixedProfile),
        reduxBlocks: c02MixedExpectedProjectedTotal(mixedProfile),
        groupCount: mixedExpected,
        displayMessages: mixedExpected,
        anchorGroupKey: null,
        contextBoundaryPresent: false,
        contextBoundaryInsideMessages: false,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: mixedExpected,
        globalDisplayMessages: mixedExpected
      },
      productionPath: 'whole-topic valid',
      productionPathComplete: true
    }
    const mixedResult = buildC02MixedBenchmarkResult(
      makeTestEnvironment(),
      mixedProfile,
      mixedBytes,
      mixedBytes,
      heapBefore,
      heapAfter,
      mixedAlloc,
      informativeness,
      'precise'
    )
    const mixedJson = JSON.stringify(mixedResult)
    expect(mixedJson).toContain('whole-topic windows (1..25) require no divider anywhere + null anchor')
    expect(mixedJson).toContain('partial windows require divider inside #messages + final-owned anchor')
  })
})

describe('C-02 harness correctness audit — matrix identity, inside signal type, mixed divider rejection (LOCK-004)', () => {
  function makeHeapPair(deltaBytes: number): { before: RendererHeapSample; after: RendererHeapSample } {
    const before: RendererHeapSample = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 20_000_000,
      totalJSHeapSize: 80_000_000,
      jsHeapSizeLimit: 2_000_000_000
    }
    const after: RendererHeapSample = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 20_000_000 + deltaBytes,
      totalJSHeapSize: 80_000_000,
      jsHeapSizeLimit: 2_000_000_000
    }
    return { before, after }
  }
  function makeTestEnvironment(): BenchmarkResult['environment'] {
    return {
      timestamp: new Date().toISOString(),
      node: 'v24.11.1',
      pnpm: '10.27.0',
      abiLane: 'electron',
      abi: '145',
      command: 'pnpm test:e2e',
      git: { commit: 'abc123def456abc123def456abc123def456abcd', dirty: false }
    }
  }

  it('matrix partial topic identity: isolated prefix with actual finalTopicId yields complete artifact, reconstructed incompatible ID fails', () => {
    // Use isolated matrix prefix c02-c02-small-v1-topic-00 (partial 50 >25) — builder must use actual ID
    const profile = C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.small]! // 1 topic x50 partial
    const isolatedPrefix = 'c02-c02-small-v1-topic'
    const syntheticTopics = buildC02SyntheticTopicsWithPrefix(profile, isolatedPrefix)
    const logicalBytes = canonicalBytesForTopics(syntheticTopics)
    const finalTopicId = syntheticTopics[syntheticTopics.length - 1]!.topicId // c02-c02-small-v1-topic-00
    expect(finalTopicId).toBe('c02-c02-small-v1-topic-00')
    const expectedVisible = c02ExpectedVisibleCount(profile) // 50 partial
    const expectedProjected = c02ExpectedProjectedTotal(profile)
    const { before: heapBefore, after: heapAfter } = makeHeapPair(2_500_000)
    const informativeness = classifyEffectiveHeapDeltaInformative(2_500_000, 'precise')
    const validAllocation: any = {
      topicsCreated: profile.syntheticTopics,
      messagesCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      blocksCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: expectedProjected,
        reduxBlocks: expectedProjected,
        groupCount: expectedVisible,
        displayMessages: expectedVisible,
        anchorGroupKey: `${finalTopicId}-group-00`,
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: expectedVisible,
        globalDisplayMessages: expectedVisible
      },
      productionPath: 'valid isolated partial',
      productionPathComplete: true
    }
    // Correct actual ID -> complete =1
    const resultCorrect = buildC02MultiBenchmarkResult(makeTestEnvironment(), [
      {
        profileId: C02_HEAP_PROFILE_IDS.small,
        profile,
        logicalBytes,
        rendererLogicalBytes: logicalBytes,
        heapBefore,
        heapAfter,
        allocation: validAllocation,
        informativeness,
        precision: 'precise',
        finalTopicId
      }
    ])
    expect(validateBenchmarkResult(resultCorrect)).toEqual([])
    expect(resultCorrect.metrics.find((m) => m.id === 'c02_small_v1.calibration.complete')?.value).toBe(1)
    expect(resultCorrect.gates.find((g) => g.id === 'c02_small_v1.calibration.complete')?.passed).toBe(true)
    // Incompatible reconstructed ID (legacy c02-heap-topic-00) does NOT match anchor containing isolated ID -> incomplete
    const reconstructedWrongId = `c02-heap-topic-${String(profile.syntheticTopics - 1).padStart(2, '0')}` // c02-heap-topic-00
    expect(reconstructedWrongId).not.toBe(finalTopicId)
    const resultWrong = buildC02MultiBenchmarkResult(makeTestEnvironment(), [
      {
        profileId: C02_HEAP_PROFILE_IDS.small,
        profile,
        logicalBytes,
        rendererLogicalBytes: logicalBytes,
        heapBefore,
        heapAfter,
        allocation: validAllocation,
        informativeness,
        precision: 'precise',
        finalTopicId: reconstructedWrongId
      }
    ])
    expect(validateBenchmarkResult(resultWrong)).toEqual([])
    expect(resultWrong.metrics.find((m) => m.id === 'c02_small_v1.calibration.complete')?.value).toBe(0)
    expect(resultWrong.gates.find((g) => g.id === 'c02_small_v1.calibration.complete')?.passed).toBe(false)
    // Missing finalTopicId is now fail-closed (no reconstructed fallback) — mandatory interface
    expect(() =>
      buildC02MultiBenchmarkResult(makeTestEnvironment(), [
        {
          profileId: C02_HEAP_PROFILE_IDS.small,
          profile,
          logicalBytes,
          rendererLogicalBytes: logicalBytes,
          heapBefore,
          heapAfter,
          allocation: validAllocation,
          informativeness,
          precision: 'precise'
          // no finalTopicId -> must throw fail-closed
        } as any
      ])
    ).toThrow(/fail-closed.*finalTopicId is required/)
    // Empty / whitespace also fail-closed
    expect(() =>
      buildC02MultiBenchmarkResult(makeTestEnvironment(), [
        {
          profileId: C02_HEAP_PROFILE_IDS.small,
          profile,
          logicalBytes,
          rendererLogicalBytes: logicalBytes,
          heapBefore,
          heapAfter,
          allocation: validAllocation,
          informativeness,
          precision: 'precise',
          finalTopicId: ''
        } as any
      ])
    ).toThrow(/fail-closed.*finalTopicId is required/)
    expect(() =>
      buildC02MultiBenchmarkResult(makeTestEnvironment(), [
        {
          profileId: C02_HEAP_PROFILE_IDS.small,
          profile,
          logicalBytes,
          rendererLogicalBytes: logicalBytes,
          heapBefore,
          heapAfter,
          allocation: validAllocation,
          informativeness,
          precision: 'precise',
          finalTopicId: '   '
        } as any
      ])
    ).toThrow(/fail-closed.*finalTopicId is required/)
  })

  it('matrix mixed partial identity: heterogeneous 20/50/100/150 with isolated prefix and actual final ID yields complete', () => {
    const profile = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.balanced]!
    const isolatedPrefix = 'c02-c02-mixed-balanced-v1-topic'
    const syntheticTopics = buildC02MixedSyntheticTopicsWithPrefix(profile, isolatedPrefix)
    const logicalBytes = canonicalBytesForTopics(syntheticTopics)
    const finalTopicId = syntheticTopics[syntheticTopics.length - 1]!.topicId // c02-c02-mixed-balanced-v1-topic-03
    expect(finalTopicId).toBe('c02-c02-mixed-balanced-v1-topic-03')
    const lastSpec = profile.topicSpecs[profile.topicSpecs.length - 1]!
    const expectedVisible = c02MixedExpectedVisibleCountForSpec(lastSpec) // 100 partial
    const expectedProjected = c02MixedExpectedProjectedTotal(profile)
    const { before: heapBefore, after: heapAfter } = makeHeapPair(3_000_000)
    const informativeness = classifyEffectiveHeapDeltaInformative(3_000_000, 'precise')
    const allocation: any = {
      topicsCreated: profile.topicSpecs.length,
      messagesCreated: c02MixedTotalMessages(profile),
      blocksCreated: c02MixedTotalMessages(profile),
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: expectedProjected,
        reduxBlocks: expectedProjected,
        groupCount: expectedVisible,
        displayMessages: expectedVisible,
        anchorGroupKey: `${finalTopicId}-anchor`,
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: expectedVisible,
        globalDisplayMessages: expectedVisible
      },
      productionPath: 'mixed isolated valid',
      productionPathComplete: true
    }
    const result = buildC02MultiBenchmarkResult(makeTestEnvironment(), [
      {
        profileId: C02_MIXED_HEAP_PROFILE_IDS.balanced,
        profile,
        logicalBytes,
        rendererLogicalBytes: logicalBytes,
        heapBefore,
        heapAfter,
        allocation,
        informativeness,
        precision: 'precise',
        finalTopicId
      }
    ])
    expect(validateBenchmarkResult(result)).toEqual([])
    expect(result.metrics.find((m) => m.id === 'c02_mixed_balanced_v1.calibration.complete')?.value).toBe(1)
  })

  it('matrix finalTopicId mandatory — compile-time required, runtime fail-closed, actual isolated partial IDs yield correct complete', () => {
    // Compile-time: finalTopicId is required (no optional). The following would be a TS error:
    // @ts-expect-error finalTopicId is mandatory — no reconstructed fallback allowed
    const _compileTimeMissing: Parameters<typeof buildC02MultiBenchmarkResult>[1][number] = {
      profileId: C02_HEAP_PROFILE_IDS.small,
      profile: C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.small]!,
      logicalBytes: 123,
      rendererLogicalBytes: 123,
      heapBefore: makeHeapPair(1000).before,
      heapAfter: makeHeapPair(1000).after,
      allocation: {} as any,
      informativeness: { informative: true, reason: 'x' },
      precision: 'precise'
    }
    void _compileTimeMissing
    // Runtime fail-closed for any bypass via any/cast (undefined, null, empty, whitespace)
    const profile = C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.small]!
    const isolatedPrefix = 'c02-c02-small-v1-topic'
    const syntheticTopics = buildC02SyntheticTopicsWithPrefix(profile, isolatedPrefix)
    const logicalBytes = canonicalBytesForTopics(syntheticTopics)
    const finalTopicId = syntheticTopics[0]!.topicId // c02-c02-small-v1-topic-00
    const expectedVisible = c02ExpectedVisibleCount(profile)
    const expectedProjected = c02ExpectedProjectedTotal(profile)
    const { before: heapBefore, after: heapAfter } = makeHeapPair(2_500_000)
    const informativeness = classifyEffectiveHeapDeltaInformative(2_500_000, 'precise')
    const allocation: any = {
      topicsCreated: profile.syntheticTopics,
      messagesCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      blocksCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: expectedProjected,
        reduxBlocks: expectedProjected,
        groupCount: expectedVisible,
        displayMessages: expectedVisible,
        anchorGroupKey: `${finalTopicId}-group`,
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: expectedVisible,
        globalDisplayMessages: expectedVisible
      },
      productionPath: 'valid partial mandatory ID',
      productionPathComplete: true
    }
    for (const badId of [undefined, null, '', '   '] as any[]) {
      expect(() =>
        buildC02MultiBenchmarkResult(makeTestEnvironment(), [
          {
            profileId: C02_HEAP_PROFILE_IDS.small,
            profile,
            logicalBytes,
            rendererLogicalBytes: logicalBytes,
            heapBefore,
            heapAfter,
            allocation,
            informativeness,
            precision: 'precise',
            finalTopicId: badId
          } as any
        ])
      ).toThrow(/fail-closed.*finalTopicId is required/)
    }
    // Actual isolated ID yields correct partial profile completion (50 partial -> complete 1)
    const result = buildC02MultiBenchmarkResult(makeTestEnvironment(), [
      {
        profileId: C02_HEAP_PROFILE_IDS.small,
        profile,
        logicalBytes,
        rendererLogicalBytes: logicalBytes,
        heapBefore,
        heapAfter,
        allocation,
        informativeness,
        precision: 'precise',
        finalTopicId
      }
    ])
    expect(validateBenchmarkResult(result)).toEqual([])
    expect(result.metrics.find((m) => m.id === 'c02_small_v1.calibration.complete')?.value).toBe(1)
    expect(result.gates.find((g) => g.id === 'c02_small_v1.calibration.complete')?.passed).toBe(true)
    // Matrix mixed+uniform with both actual IDs also yields per-profile complete and matrix complete
    const mixedProfile = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.balanced]!
    const mixedPrefix = 'c02-c02-mixed-balanced-v1-topic'
    const mixedTopics = buildC02MixedSyntheticTopicsWithPrefix(mixedProfile, mixedPrefix)
    const mixedBytes = canonicalBytesForTopics(mixedTopics)
    const mixedFinalId = mixedTopics[mixedTopics.length - 1]!.topicId
    const mixedExpectedVisible = c02MixedExpectedVisibleCountForSpec(
      mixedProfile.topicSpecs[mixedProfile.topicSpecs.length - 1]!
    )
    const mixedExpectedProjected = c02MixedExpectedProjectedTotal(mixedProfile)
    const { before: heapBefore2, after: heapAfter2 } = makeHeapPair(3_000_000)
    const informativeness2 = classifyEffectiveHeapDeltaInformative(3_000_000, 'precise')
    const mixedAlloc: any = {
      topicsCreated: mixedProfile.topicSpecs.length,
      messagesCreated: c02MixedTotalMessages(mixedProfile),
      blocksCreated: c02MixedTotalMessages(mixedProfile),
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: mixedExpectedProjected,
        reduxBlocks: mixedExpectedProjected,
        groupCount: mixedExpectedVisible,
        displayMessages: mixedExpectedVisible,
        anchorGroupKey: `${mixedFinalId}-anchor`,
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: mixedExpectedVisible,
        globalDisplayMessages: mixedExpectedVisible
      },
      productionPath: 'mixed valid',
      productionPathComplete: true
    }
    const multiResult = buildC02MultiBenchmarkResult(makeTestEnvironment(), [
      {
        profileId: C02_HEAP_PROFILE_IDS.small,
        profile,
        logicalBytes,
        rendererLogicalBytes: logicalBytes,
        heapBefore,
        heapAfter,
        allocation,
        informativeness,
        precision: 'precise',
        finalTopicId
      },
      {
        profileId: C02_MIXED_HEAP_PROFILE_IDS.balanced,
        profile: mixedProfile,
        logicalBytes: mixedBytes,
        rendererLogicalBytes: mixedBytes,
        heapBefore: heapBefore2,
        heapAfter: heapAfter2,
        allocation: mixedAlloc,
        informativeness: informativeness2,
        precision: 'precise',
        finalTopicId: mixedFinalId
      }
    ])
    expect(validateBenchmarkResult(multiResult)).toEqual([])
    expect(multiResult.gates.find((g) => g.id === 'calibration.matrix.complete')?.passed).toBe(true)
  })

  it('activation result type completeness: every projectionStats must contain mandatory boolean contextBoundaryInsideMessages', () => {
    const profile = C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.small]!
    const topics = buildC02SyntheticTopics(profile)
    const logicalBytes = canonicalBytesForTopics(topics)
    const { before: heapBefore, after: heapAfter } = makeHeapPair(2_500_000)
    const informativeness = classifyEffectiveHeapDeltaInformative(2_500_000, 'precise')
    const makeAllocation = (inside: boolean | undefined): any => ({
      topicsCreated: profile.syntheticTopics,
      messagesCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      blocksCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: c02ExpectedProjectedTotal(profile),
        reduxBlocks: c02ExpectedProjectedTotal(profile),
        groupCount: 50,
        displayMessages: 50,
        anchorGroupKey: 'c02-heap-topic-00-group',
        contextBoundaryPresent: true,
        // inside intentionally omitted or set
        ...(inside !== undefined ? { contextBoundaryInsideMessages: inside } : {}),
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: 50,
        globalDisplayMessages: 50
      },
      productionPath: 'test',
      productionPathComplete: true
    })
    // Missing -> throw fail-closed
    const allocMissing: any = makeAllocation(undefined)
    delete allocMissing.projectionStats.contextBoundaryInsideMessages
    expect(() =>
      buildC02BenchmarkResult(
        makeTestEnvironment(),
        profile,
        logicalBytes,
        logicalBytes,
        heapBefore,
        heapAfter,
        allocMissing,
        informativeness,
        'precise'
      )
    ).toThrow(/contextBoundaryInsideMessages is required/)
    // Explicit false (valid type, but for partial 50 with anchor owned, false inside makes it incomplete, not thrown)
    const allocFalse = makeAllocation(false)
    const resultFalse = buildC02BenchmarkResult(
      makeTestEnvironment(),
      profile,
      logicalBytes,
      logicalBytes,
      heapBefore,
      heapAfter,
      allocFalse,
      informativeness,
      'precise'
    )
    expect(validateBenchmarkResult(resultFalse)).toEqual([])
    expect(resultFalse.metrics.find((m) => m.id === 'calibration.complete')?.value).toBe(0)
    // True inside with correct anchor -> complete
    const allocTrue = makeAllocation(true)
    const resultTrue = buildC02BenchmarkResult(
      makeTestEnvironment(),
      profile,
      logicalBytes,
      logicalBytes,
      heapBefore,
      heapAfter,
      allocTrue,
      informativeness,
      'precise'
    )
    expect(resultTrue.metrics.find((m) => m.id === 'calibration.complete')?.value).toBe(1)
    // Multi builder also fail-closed when omitted (with actual finalTopicId present, still fails on inside signal)
    const multiMissing: any = [
      {
        profileId: C02_HEAP_PROFILE_IDS.small,
        profile,
        logicalBytes,
        rendererLogicalBytes: logicalBytes,
        heapBefore,
        heapAfter,
        allocation: allocMissing,
        informativeness,
        precision: 'precise' as const,
        finalTopicId: 'c02-heap-topic-01'
      }
    ]
    expect(() => buildC02MultiBenchmarkResult(makeTestEnvironment(), multiMissing)).toThrow(
      /contextBoundaryInsideMessages is required/
    )
  })

  it('simultaneous inside+outside divider rejection: mixed evidence invalidates both whole-topic and partial branches', () => {
    // Whole-topic 20 with no divider valid, but mixed inside+outside must be invalid
    const wholeTopicValid = isC02ContextEvidenceValid({
      contextBoundaryPresent: false,
      contextBoundaryInsideMessages: false,
      anchorGroupKey: null,
      lastTopicId: 'c02-heap-topic-00',
      expectedVisibleFinal: 20
    })
    expect(wholeTopicValid).toBe(true)
    // Simulate DOM mixed encoding: present true inside false (hasOutside) with null anchor -> must be invalid for whole-topic and partial
    const wholeTopicWithOutside = isC02ContextEvidenceValid({
      contextBoundaryPresent: true,
      contextBoundaryInsideMessages: false,
      anchorGroupKey: null,
      lastTopicId: 'c02-heap-topic-00',
      expectedVisibleFinal: 20
    })
    expect(wholeTopicWithOutside).toBe(false)
    const wholeTopicWithInsideWrongly = isC02ContextEvidenceValid({
      contextBoundaryPresent: true,
      contextBoundaryInsideMessages: true,
      anchorGroupKey: 'c02-heap-topic-00-group',
      lastTopicId: 'c02-heap-topic-00',
      expectedVisibleFinal: 20
    })
    expect(wholeTopicWithInsideWrongly).toBe(false)
    // Partial 50 valid case
    const partialValid = isC02ContextEvidenceValid({
      contextBoundaryPresent: true,
      contextBoundaryInsideMessages: true,
      anchorGroupKey: 'c02-heap-topic-00-group',
      lastTopicId: 'c02-heap-topic-00',
      expectedVisibleFinal: 50
    })
    expect(partialValid).toBe(true)
    // Partial with outside encoded as present true inside false -> invalid even though anchor would have been owned
    const partialMixedRejected = isC02ContextEvidenceValid({
      contextBoundaryPresent: true,
      contextBoundaryInsideMessages: false,
      anchorGroupKey: null,
      lastTopicId: 'c02-heap-topic-00',
      expectedVisibleFinal: 50
    })
    expect(partialMixedRejected).toBe(false)
    // Also partial with inside true but anchor not owned -> invalid
    const partialBadAnchor = isC02ContextEvidenceValid({
      contextBoundaryPresent: true,
      contextBoundaryInsideMessages: true,
      anchorGroupKey: 'other-topic-group',
      lastTopicId: 'c02-heap-topic-00',
      expectedVisibleFinal: 50
    })
    expect(partialBadAnchor).toBe(false)
    // Matrix builder with mixed inside+outside encoding must yield incomplete
    const profile = C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.small]!
    const topics = buildC02SyntheticTopics(profile)
    const logicalBytes = canonicalBytesForTopics(topics)
    const { before: heapBefore, after: heapAfter } = makeHeapPair(2_500_000)
    const informativeness = classifyEffectiveHeapDeltaInformative(2_500_000, 'precise')
    const finalTopicId = topics[topics.length - 1]!.topicId
    const mixedAllocation: any = {
      topicsCreated: profile.syntheticTopics,
      messagesCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      blocksCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: c02ExpectedProjectedTotal(profile),
        reduxBlocks: c02ExpectedProjectedTotal(profile),
        groupCount: 50,
        displayMessages: 50,
        anchorGroupKey: null,
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: false, // mixed encoded as outside
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: 50,
        globalDisplayMessages: 50
      },
      productionPath: 'mixed rejected',
      productionPathComplete: true // caller true but derived must fail
    }
    const result = buildC02MultiBenchmarkResult(makeTestEnvironment(), [
      {
        profileId: C02_HEAP_PROFILE_IDS.small,
        profile,
        logicalBytes,
        rendererLogicalBytes: logicalBytes,
        heapBefore,
        heapAfter,
        allocation: mixedAllocation,
        informativeness,
        precision: 'precise',
        finalTopicId
      }
    ])
    expect(result.metrics.find((m) => m.id === 'c02_small_v1.calibration.complete')?.value).toBe(0)
    expect(result.gates.find((g) => g.id === 'c02_small_v1.calibration.complete')?.passed).toBe(false)
  })
})

describe('C-02 audit — fail-closed derivation from measured heap, exact DOM/group, and collision-safe ownership (LOCK-004 correction)', () => {
  function makeHeapPair(deltaBytes: number): { before: RendererHeapSample; after: RendererHeapSample } {
    const before: RendererHeapSample = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 20_000_000,
      totalJSHeapSize: 80_000_000,
      jsHeapSizeLimit: 2_000_000_000
    }
    const after: RendererHeapSample = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 20_000_000 + deltaBytes,
      totalJSHeapSize: 80_000_000,
      jsHeapSizeLimit: 2_000_000_000
    }
    return { before, after }
  }
  function makeTestEnvironment(): BenchmarkResult['environment'] {
    return {
      timestamp: new Date().toISOString(),
      node: 'v24.11.1',
      pnpm: '10.27.0',
      abiLane: 'electron',
      abi: '145',
      command: 'pnpm test:e2e',
      git: { commit: 'abc123def456abc123def456abc123def456abcd', dirty: false }
    }
  }

  it('isC02ExactTopicOwned is collision-safe: substring prefix does not own', () => {
    // Exact match
    expect(isC02ExactTopicOwned('c02-heap-topic-01-group', 'c02-heap-topic-01')).toBe(true)
    expect(
      isC02ExactTopicOwned('18:c02-heap-topic-01-msg-00000|18:c02-heap-topic-01-msg-00001', 'c02-heap-topic-01')
    ).toBe(true)
    expect(isC02ExactTopicOwned('c02-heap-topic-01', 'c02-heap-topic-01')).toBe(true)
    // Collision: topic 01 substring inside 011 must NOT own
    expect(isC02ExactTopicOwned('c02-heap-topic-011-group', 'c02-heap-topic-01')).toBe(false)
    expect(isC02ExactTopicOwned('18:c02-heap-topic-011-msg-00000', 'c02-heap-topic-01')).toBe(false)
    expect(isC02ExactTopicOwned('c02-heap-topic-011', 'c02-heap-topic-01')).toBe(false)
    // Different prefix
    expect(isC02ExactTopicOwned('c02-c02-small-v1-topic-00-group', 'c02-heap-topic-00')).toBe(false)
    // Null / empty
    expect(isC02ExactTopicOwned(null, 'c02-heap-topic-01')).toBe(false)
    expect(isC02ExactTopicOwned('', 'c02-heap-topic-01')).toBe(false)
    expect(isC02ExactTopicOwned('c02-heap-topic-01-group', '')).toBe(false)
    // Ensure before boundary: topic inside longer alphanumeric without separator is not owned
    expect(isC02ExactTopicOwned('xc02-heap-topic-01-group', 'c02-heap-topic-01')).toBe(false)
  })

  it('deriveEffectiveHeapInformative is pure: measured delta + precision only, caller boolean cannot override', () => {
    // Finite positive + precise => true
    expect(deriveEffectiveHeapInformative(5000, 'precise')).toBe(true)
    expect(classifyEffectiveHeapDeltaInformative(5000, 'precise').informative).toBe(true)
    // Zero with precise still false
    expect(deriveEffectiveHeapInformative(0, 'precise')).toBe(false)
    expect(isEffectiveHeapDeltaInformative(0, 'precise')).toBe(false)
    // Positive with bucketed false even if caller says true
    expect(deriveEffectiveHeapInformative(5000, 'bucketed')).toBe(false)
    expect(isEffectiveHeapDeltaInformative(5000, 'bucketed')).toBe(false)
    // Negative with precise false
    expect(deriveEffectiveHeapInformative(-100, 'precise')).toBe(false)
    // Non-finite false
    expect(deriveEffectiveHeapInformative(NaN, 'precise')).toBe(false)
    expect(deriveEffectiveHeapInformative(Infinity, 'precise')).toBe(false)
  })

  it('deriveGroupCountExact and deriveFinalTopicDomProof are pure scalar derivations', () => {
    expect(deriveGroupCountExact(50, 50)).toBe(true)
    expect(deriveGroupCountExact(49, 50)).toBe(false)
    expect(deriveGroupCountExact(0, 50)).toBe(false)
    expect(deriveFinalTopicDomProof(50, 50, 50)).toBe(true)
    expect(deriveFinalTopicDomProof(50, 50, 50)).toBe(true)
    expect(deriveFinalTopicDomProof(49, 50, 50)).toBe(false)
    expect(deriveFinalTopicDomProof(50, 49, 50)).toBe(false)
    // Missing/null/non-finite global evidence is inconclusive and must not be converted to scoped equality (fail-closed)
    expect(deriveFinalTopicDomProof(50, undefined as any, 50)).toBe(false)
    expect(deriveFinalTopicDomProof(50, null as any, 50)).toBe(false)
    expect(deriveFinalTopicDomProof(50, NaN as any, 50)).toBe(false)
    expect(deriveFinalTopicDomProof(50, Infinity as any, 50)).toBe(false)
    expect(deriveFinalTopicDomProof(0, 0, 50)).toBe(false)
  })

  it('uniform builder cannot serialize complete with contradictory heap: caller informative true but measured delta zero/negative/bucketed', () => {
    const profile = C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.small]! // 50 partial
    const topics = buildC02SyntheticTopics(profile)
    const logicalBytes = canonicalBytesForTopics(topics)
    const expectedVisible = c02ExpectedVisibleCount(profile)
    // Valid DOM/group/context evidence so only heap should block
    const validAllocation: any = {
      topicsCreated: profile.syntheticTopics,
      messagesCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      blocksCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: c02ExpectedProjectedTotal(profile),
        reduxBlocks: c02ExpectedProjectedTotal(profile),
        groupCount: expectedVisible,
        displayMessages: expectedVisible,
        anchorGroupKey: `c02-heap-topic-00-group`,
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: expectedVisible,
        globalDisplayMessages: expectedVisible
      },
      productionPath: 'valid partial',
      productionPathComplete: true
    }
    // Case 1: zero delta with caller true but precise — must be incomplete (derived heap false)
    const zeroPair = makeHeapPair(0)
    const callerTrue = { informative: true, reason: 'caller claims informative' }
    const resultZero = buildC02BenchmarkResult(
      makeTestEnvironment(),
      profile,
      logicalBytes,
      logicalBytes,
      zeroPair.before,
      zeroPair.after,
      validAllocation,
      callerTrue,
      'precise'
    )
    expect(validateBenchmarkResult(resultZero)).toEqual([])
    expect(resultZero.metrics.find((m) => m.id === 'heap.deltaInformative')?.value).toBe(0)
    expect(resultZero.metrics.find((m) => m.id === 'heap.amplification.deltaRatio')?.value).toBe(0)
    expect(resultZero.gates.find((g) => g.id === 'heap.deltaInformative')?.passed).toBe(false)
    expect(resultZero.metrics.find((m) => m.id === 'calibration.complete')?.value).toBe(0)
    expect(resultZero.gates.find((g) => g.id === 'calibration.complete')?.passed).toBe(false)
    // Case 2: positive delta but bucketed precision with caller true — must be incomplete and ratio 0
    const positivePair = makeHeapPair(5000)
    const resultBucketed = buildC02BenchmarkResult(
      makeTestEnvironment(),
      profile,
      logicalBytes,
      logicalBytes,
      positivePair.before,
      positivePair.after,
      validAllocation,
      callerTrue,
      'bucketed'
    )
    expect(resultBucketed.metrics.find((m) => m.id === 'heap.deltaInformative')?.value).toBe(0)
    expect(resultBucketed.metrics.find((m) => m.id === 'heap.amplification.deltaRatio')?.value).toBe(0)
    expect(resultBucketed.metrics.find((m) => m.id === 'calibration.complete')?.value).toBe(0)
    expect(resultBucketed.gates.find((g) => g.id === 'heap.deltaInformative')?.passed).toBe(false)
    // Case 3: negative delta with caller true — incomplete
    const negPair = makeHeapPair(-5000)
    const resultNeg = buildC02BenchmarkResult(
      makeTestEnvironment(),
      profile,
      logicalBytes,
      logicalBytes,
      negPair.before,
      negPair.after,
      validAllocation,
      callerTrue,
      'precise'
    )
    expect(resultNeg.metrics.find((m) => m.id === 'calibration.complete')?.value).toBe(0)
    expect(resultNeg.gates.find((g) => g.id === 'heap.deltaInformative')?.passed).toBe(false)
  })

  it('uniform builder cannot complete with false DOM/group counts even when caller booleans true', () => {
    const profile = C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.small]!
    const topics = buildC02SyntheticTopics(profile)
    const logicalBytes = canonicalBytesForTopics(topics)
    const expectedVisible = c02ExpectedVisibleCount(profile) // 50
    const goodHeap = makeHeapPair(2500)
    const callerTrueInfo = { informative: true, reason: 'x' }
    // Allocation with correct heap but groupCount mismatched (49 vs 50) yet caller groupExactMatched true
    const allocGroupMismatch: any = {
      topicsCreated: profile.syntheticTopics,
      messagesCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      blocksCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: c02ExpectedProjectedTotal(profile),
        reduxBlocks: c02ExpectedProjectedTotal(profile),
        groupCount: expectedVisible - 1, // 49 mismatch
        displayMessages: expectedVisible,
        anchorGroupKey: `c02-heap-topic-00-group`,
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true, // caller true but derived from counts will be true for displayMessages, but group fails
        groupExactMatched: true, // lie — derived must still fail
        groupsWithFinalTopic: expectedVisible,
        globalDisplayMessages: expectedVisible
      },
      productionPath: 'group mismatch but caller true',
      productionPathComplete: true
    }
    const resultGroup = buildC02BenchmarkResult(
      makeTestEnvironment(),
      profile,
      logicalBytes,
      logicalBytes,
      goodHeap.before,
      goodHeap.after,
      allocGroupMismatch,
      callerTrueInfo,
      'precise'
    )
    expect(resultGroup.metrics.find((m) => m.id === 'calibration.complete')?.value).toBe(0)
    expect(resultGroup.gates.find((g) => g.id === 'calibration.complete')?.passed).toBe(false)
    expect(resultGroup.gates.find((g) => g.id === 'productionPath.complete')?.passed).toBe(false)
    // Allocation with displayMessages mismatched but caller finalTopicDomProof true
    const allocDomMismatch: any = {
      topicsCreated: profile.syntheticTopics,
      messagesCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      blocksCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: c02ExpectedProjectedTotal(profile),
        reduxBlocks: c02ExpectedProjectedTotal(profile),
        groupCount: expectedVisible,
        displayMessages: expectedVisible - 1, // 49 mismatch
        anchorGroupKey: `c02-heap-topic-00-group`,
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true, // caller lie
        groupExactMatched: true,
        groupsWithFinalTopic: expectedVisible,
        globalDisplayMessages: expectedVisible
      },
      productionPath: 'dom mismatch but caller true',
      productionPathComplete: true
    }
    const resultDom = buildC02BenchmarkResult(
      makeTestEnvironment(),
      profile,
      logicalBytes,
      logicalBytes,
      goodHeap.before,
      goodHeap.after,
      allocDomMismatch,
      callerTrueInfo,
      'precise'
    )
    expect(resultDom.metrics.find((m) => m.id === 'projection.finalTopicDomProof')?.value).toBe(0)
    expect(resultDom.gates.find((g) => g.id === 'projection.finalTopicOwnership')?.passed).toBe(false)
    expect(resultDom.metrics.find((m) => m.id === 'calibration.complete')?.value).toBe(0)
    // Also global mismatch: scoped correct but global wrong
    const allocGlobalMismatch: any = {
      topicsCreated: profile.syntheticTopics,
      messagesCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      blocksCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: c02ExpectedProjectedTotal(profile),
        reduxBlocks: c02ExpectedProjectedTotal(profile),
        groupCount: expectedVisible,
        displayMessages: expectedVisible,
        anchorGroupKey: `c02-heap-topic-00-group`,
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: expectedVisible,
        globalDisplayMessages: expectedVisible + 10 // mismatch
      },
      productionPath: 'global mismatch',
      productionPathComplete: true
    }
    const resultGlobal = buildC02BenchmarkResult(
      makeTestEnvironment(),
      profile,
      logicalBytes,
      logicalBytes,
      goodHeap.before,
      goodHeap.after,
      allocGlobalMismatch,
      callerTrueInfo,
      'precise'
    )
    expect(resultGlobal.metrics.find((m) => m.id === 'projection.finalTopicDomProof')?.value).toBe(0)
    expect(resultGlobal.gates.find((g) => g.id === 'projection.finalTopicOwnership')?.passed).toBe(false)
    expect(resultGlobal.metrics.find((m) => m.id === 'calibration.complete')?.value).toBe(0)
  })

  it('uniform builder cannot complete with substring-collision anchor ownership even when caller booleans true', () => {
    const profile = C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.small]!
    const topics = buildC02SyntheticTopics(profile)
    const logicalBytes = canonicalBytesForTopics(topics)
    const expectedVisible = c02ExpectedVisibleCount(profile) // 50 partial
    const heap = makeHeapPair(2500)
    const info = { informative: true, reason: 'x' }
    // Collision anchor: contains substring `c02-heap-topic-00` as prefix of `c02-heap-topic-001` ? Simulate with `c02-heap-topic-00` inside `c02-heap-topic-001-group`
    // Expected topic suffix for small is c02-heap-topic-00. Collision anchor pretends to own but is actually `c02-heap-topic-001-group` (extra `1`)
    const collisionAnchor = 'c02-heap-topic-001-group' // contains `c02-heap-topic-00` + `1` => not exact
    expect(isC02ExactTopicOwned(collisionAnchor, 'c02-heap-topic-00')).toBe(false)
    expect(collisionAnchor.includes('c02-heap-topic-00')).toBe(true) // old substring would have passed
    const allocCollision: any = {
      topicsCreated: profile.syntheticTopics,
      messagesCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      blocksCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: c02ExpectedProjectedTotal(profile),
        reduxBlocks: c02ExpectedProjectedTotal(profile),
        groupCount: expectedVisible,
        displayMessages: expectedVisible,
        anchorGroupKey: collisionAnchor,
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: expectedVisible,
        globalDisplayMessages: expectedVisible
      },
      productionPath: 'collision anchor',
      productionPathComplete: true
    }
    const resultCollision = buildC02BenchmarkResult(
      makeTestEnvironment(),
      profile,
      logicalBytes,
      logicalBytes,
      heap.before,
      heap.after,
      allocCollision,
      info,
      'precise'
    )
    expect(resultCollision.gates.find((g) => g.id === 'projection.contextBoundaryExplicit')?.passed).toBe(false)
    expect(resultCollision.metrics.find((m) => m.id === 'calibration.complete')?.value).toBe(0)
    expect(resultCollision.gates.find((g) => g.id === 'calibration.complete')?.passed).toBe(false)
    // Exact anchor must still pass
    const exactAnchor = 'c02-heap-topic-00-group'
    const allocExact: any = {
      ...allocCollision,
      projectionStats: { ...allocCollision.projectionStats, anchorGroupKey: exactAnchor }
    }
    const resultExact = buildC02BenchmarkResult(
      makeTestEnvironment(),
      profile,
      logicalBytes,
      logicalBytes,
      heap.before,
      heap.after,
      allocExact,
      info,
      'precise'
    )
    expect(resultExact.gates.find((g) => g.id === 'projection.contextBoundaryExplicit')?.passed).toBe(true)
    expect(resultExact.metrics.find((m) => m.id === 'calibration.complete')?.value).toBe(1)
  })

  it('mixed builder cannot complete with contradictory heap/DOM/group/collision even when caller booleans true, valid exact passes', () => {
    const profile = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.balanced]!
    const topics = buildC02MixedSyntheticTopics(profile)
    const logicalBytes = canonicalBytesForTopics(topics)
    const lastSpec = profile.topicSpecs[profile.topicSpecs.length - 1]!
    const expectedVisible = c02MixedExpectedVisibleCountForSpec(lastSpec) // 100
    const expectedProjected = c02MixedExpectedProjectedTotal(profile)
    const heapGood = makeHeapPair(3000)
    const callerTrue = { informative: true, reason: 'x' }

    // Heap zero with caller true -> incomplete, ratio 0
    const zeroHeap = makeHeapPair(0)
    const allocValidForHeap: any = {
      topicsCreated: profile.topicSpecs.length,
      messagesCreated: c02MixedTotalMessages(profile),
      blocksCreated: c02MixedTotalMessages(profile),
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: expectedProjected,
        reduxBlocks: expectedProjected,
        groupCount: expectedVisible,
        displayMessages: expectedVisible,
        anchorGroupKey: `c02-mixed-topic-03-group`,
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: expectedVisible,
        globalDisplayMessages: expectedVisible
      },
      productionPath: 'valid',
      productionPathComplete: true
    }
    const resultZero = buildC02MixedBenchmarkResult(
      makeTestEnvironment(),
      profile,
      logicalBytes,
      logicalBytes,
      zeroHeap.before,
      zeroHeap.after,
      allocValidForHeap,
      callerTrue,
      'precise'
    )
    expect(resultZero.metrics.find((m) => m.id === 'heap.deltaInformative')?.value).toBe(0)
    expect(resultZero.metrics.find((m) => m.id === 'heap.amplification.deltaRatio')?.value).toBe(0)
    expect(resultZero.metrics.find((m) => m.id === 'calibration.complete')?.value).toBe(0)

    // Group mismatch with caller true
    const allocGroupBad: any = {
      ...allocValidForHeap,
      projectionStats: {
        ...allocValidForHeap.projectionStats,
        groupCount: expectedVisible - 5,
        groupExactMatched: true
      }
    }
    const resultGroup = buildC02MixedBenchmarkResult(
      makeTestEnvironment(),
      profile,
      logicalBytes,
      logicalBytes,
      heapGood.before,
      heapGood.after,
      allocGroupBad,
      callerTrue,
      'precise'
    )
    expect(resultGroup.metrics.find((m) => m.id === 'calibration.complete')?.value).toBe(0)

    // DOM mismatch
    const allocDomBad: any = {
      ...allocValidForHeap,
      projectionStats: {
        ...allocValidForHeap.projectionStats,
        displayMessages: expectedVisible - 1,
        finalTopicDomProof: true
      }
    }
    const resultDom = buildC02MixedBenchmarkResult(
      makeTestEnvironment(),
      profile,
      logicalBytes,
      logicalBytes,
      heapGood.before,
      heapGood.after,
      allocDomBad,
      callerTrue,
      'precise'
    )
    expect(resultDom.metrics.find((m) => m.id === 'projection.finalTopicDomProof')?.value).toBe(0)
    expect(resultDom.metrics.find((m) => m.id === 'calibration.complete')?.value).toBe(0)

    // Collision anchor
    const collisionAnchor = 'c02-mixed-topic-03-extra-1-group'.replace('c02-mixed-topic-03', 'c02-mixed-topic-031') // simulate collision with extra digit
    // Actually we need anchor that contains substring `c02-mixed-topic-03` but with extra char: `c02-mixed-topic-031-group`
    const badAnchor = 'c02-mixed-topic-031-group'
    expect(badAnchor.includes('c02-mixed-topic-03')).toBe(true)
    expect(isC02ExactTopicOwned(badAnchor, 'c02-mixed-topic-03')).toBe(false)
    const allocCollision: any = {
      ...allocValidForHeap,
      projectionStats: { ...allocValidForHeap.projectionStats, anchorGroupKey: badAnchor }
    }
    const resultCollision = buildC02MixedBenchmarkResult(
      makeTestEnvironment(),
      profile,
      logicalBytes,
      logicalBytes,
      heapGood.before,
      heapGood.after,
      allocCollision,
      callerTrue,
      'precise'
    )
    expect(resultCollision.gates.find((g) => g.id === 'projection.contextBoundaryExplicit')?.passed).toBe(false)
    expect(resultCollision.metrics.find((m) => m.id === 'calibration.complete')?.value).toBe(0)

    // Valid exact anchor passes with correct heap and DOM
    const resultValid = buildC02MixedBenchmarkResult(
      makeTestEnvironment(),
      profile,
      logicalBytes,
      logicalBytes,
      heapGood.before,
      heapGood.after,
      allocValidForHeap,
      { informative: true, reason: 'x' },
      'precise'
    )
    expect(validateBenchmarkResult(resultValid)).toEqual([])
    expect(resultValid.metrics.find((m) => m.id === 'calibration.complete')?.value).toBe(1)
    expect(resultValid.gates.find((g) => g.id === 'calibration.complete')?.passed).toBe(true)
  })

  it('matrix builder cannot complete entries with contradictory heap/DOM/collision even when caller true per-entry, matrix incomplete, valid matrix complete', () => {
    const uniformProfile = C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.small]! // 50
    const uniformBytes = canonicalBytesForTopics(buildC02SyntheticTopics(uniformProfile))
    const expectedUniformVisible = c02ExpectedVisibleCount(uniformProfile)
    const mixedProfile = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.balanced]!
    const mixedBytes = canonicalBytesForTopics(buildC02MixedSyntheticTopics(mixedProfile))
    const expectedMixedVisible = c02MixedExpectedVisibleCountForSpec(
      mixedProfile.topicSpecs[mixedProfile.topicSpecs.length - 1]!
    )
    // Entry 0 valid, Entry 1 has zero delta with caller true -> per-entry incomplete, matrix incomplete
    const heapValid = makeHeapPair(2500)
    const heapZero = makeHeapPair(0)
    const callerTrue = { informative: true, reason: 'caller true lie' }
    const validUniformAlloc: any = {
      topicsCreated: uniformProfile.syntheticTopics,
      messagesCreated: uniformProfile.syntheticTopics * uniformProfile.syntheticMessagesPerTopic,
      blocksCreated: uniformProfile.syntheticTopics * uniformProfile.syntheticMessagesPerTopic,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: c02ExpectedProjectedTotal(uniformProfile),
        reduxBlocks: c02ExpectedProjectedTotal(uniformProfile),
        groupCount: expectedUniformVisible,
        displayMessages: expectedUniformVisible,
        anchorGroupKey: `c02-heap-topic-00-group`,
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: expectedUniformVisible,
        globalDisplayMessages: expectedUniformVisible
      },
      productionPath: 'valid uniform',
      productionPathComplete: true
    }
    const zeroMixedAlloc: any = {
      topicsCreated: mixedProfile.topicSpecs.length,
      messagesCreated: c02MixedTotalMessages(mixedProfile),
      blocksCreated: c02MixedTotalMessages(mixedProfile),
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: c02MixedExpectedProjectedTotal(mixedProfile),
        reduxBlocks: c02MixedExpectedProjectedTotal(mixedProfile),
        groupCount: expectedMixedVisible,
        displayMessages: expectedMixedVisible,
        anchorGroupKey: `c02-mixed-topic-03-group`,
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: expectedMixedVisible,
        globalDisplayMessages: expectedMixedVisible
      },
      productionPath: 'valid mixed but heap zero',
      productionPathComplete: true
    }
    const resultOneBad = buildC02MultiBenchmarkResult(makeTestEnvironment(), [
      {
        profileId: C02_HEAP_PROFILE_IDS.small,
        profile: uniformProfile,
        logicalBytes: uniformBytes,
        rendererLogicalBytes: uniformBytes,
        heapBefore: heapValid.before,
        heapAfter: heapValid.after,
        allocation: validUniformAlloc,
        informativeness: callerTrue,
        precision: 'precise',
        finalTopicId: 'c02-heap-topic-00'
      },
      {
        profileId: C02_MIXED_HEAP_PROFILE_IDS.balanced,
        profile: mixedProfile,
        logicalBytes: mixedBytes,
        rendererLogicalBytes: mixedBytes,
        heapBefore: heapZero.before,
        heapAfter: heapZero.after,
        allocation: zeroMixedAlloc,
        informativeness: callerTrue, // lie, but measured delta 0 => derived false
        precision: 'precise',
        finalTopicId: 'c02-mixed-topic-03'
      }
    ])
    expect(resultOneBad.metrics.find((m) => m.id === 'c02_small_v1.calibration.complete')?.value).toBe(1)
    expect(resultOneBad.metrics.find((m) => m.id === 'c02_mixed_balanced_v1.calibration.complete')?.value).toBe(0)
    expect(resultOneBad.gates.find((g) => g.id === 'c02_small_v1.calibration.complete')?.passed).toBe(true)
    expect(resultOneBad.gates.find((g) => g.id === 'c02_mixed_balanced_v1.calibration.complete')?.passed).toBe(false)
    expect(resultOneBad.gates.find((g) => g.id === 'calibration.matrix.complete')?.passed).toBe(false)
    expect(resultOneBad.metrics.find((m) => m.id === 'c02_mixed_balanced_v1.heap.deltaInformative')?.value).toBe(0)
    expect(
      resultOneBad.metrics.find((m) => m.id === 'c02_mixed_balanced_v1.heap.amplification.deltaRatio')?.value
    ).toBe(0)

    // Collision anchor in matrix entry with caller true must fail
    const collisionAlloc: any = {
      ...validUniformAlloc,
      projectionStats: { ...validUniformAlloc.projectionStats, anchorGroupKey: 'c02-heap-topic-001-group' } // collision
    }
    const resultCollision = buildC02MultiBenchmarkResult(makeTestEnvironment(), [
      {
        profileId: C02_HEAP_PROFILE_IDS.small,
        profile: uniformProfile,
        logicalBytes: uniformBytes,
        rendererLogicalBytes: uniformBytes,
        heapBefore: heapValid.before,
        heapAfter: heapValid.after,
        allocation: collisionAlloc,
        informativeness: callerTrue,
        precision: 'precise',
        finalTopicId: 'c02-heap-topic-00'
      }
    ])
    expect(resultCollision.metrics.find((m) => m.id === 'c02_small_v1.calibration.complete')?.value).toBe(0)
    expect(resultCollision.gates.find((g) => g.id === 'c02_small_v1.calibration.complete')?.passed).toBe(false)

    // Group mismatch in matrix
    const groupBadAlloc: any = {
      ...validUniformAlloc,
      projectionStats: {
        ...validUniformAlloc.projectionStats,
        groupCount: expectedUniformVisible - 1,
        groupExactMatched: true
      }
    }
    const resultGroupBad = buildC02MultiBenchmarkResult(makeTestEnvironment(), [
      {
        profileId: C02_HEAP_PROFILE_IDS.small,
        profile: uniformProfile,
        logicalBytes: uniformBytes,
        rendererLogicalBytes: uniformBytes,
        heapBefore: heapValid.before,
        heapAfter: heapValid.after,
        allocation: groupBadAlloc,
        informativeness: callerTrue,
        precision: 'precise',
        finalTopicId: 'c02-heap-topic-00'
      }
    ])
    expect(resultGroupBad.metrics.find((m) => m.id === 'c02_small_v1.calibration.complete')?.value).toBe(0)

    // Valid matrix both entries pass
    const heapMixedValid = makeHeapPair(3000)
    const validMixedAlloc2: any = {
      topicsCreated: mixedProfile.topicSpecs.length,
      messagesCreated: c02MixedTotalMessages(mixedProfile),
      blocksCreated: c02MixedTotalMessages(mixedProfile),
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: c02MixedExpectedProjectedTotal(mixedProfile),
        reduxBlocks: c02MixedExpectedProjectedTotal(mixedProfile),
        groupCount: expectedMixedVisible,
        displayMessages: expectedMixedVisible,
        anchorGroupKey: `c02-mixed-topic-03-group`,
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: expectedMixedVisible,
        globalDisplayMessages: expectedMixedVisible
      },
      productionPath: 'valid mixed 2',
      productionPathComplete: true
    }
    const resultValidMatrix = buildC02MultiBenchmarkResult(makeTestEnvironment(), [
      {
        profileId: C02_HEAP_PROFILE_IDS.small,
        profile: uniformProfile,
        logicalBytes: uniformBytes,
        rendererLogicalBytes: uniformBytes,
        heapBefore: heapValid.before,
        heapAfter: heapValid.after,
        allocation: validUniformAlloc,
        informativeness: { informative: true, reason: 'x' },
        precision: 'precise',
        finalTopicId: 'c02-heap-topic-00'
      },
      {
        profileId: C02_MIXED_HEAP_PROFILE_IDS.balanced,
        profile: mixedProfile,
        logicalBytes: mixedBytes,
        rendererLogicalBytes: mixedBytes,
        heapBefore: heapMixedValid.before,
        heapAfter: heapMixedValid.after,
        allocation: validMixedAlloc2,
        informativeness: { informative: true, reason: 'x' },
        precision: 'precise',
        finalTopicId: 'c02-mixed-topic-03'
      }
    ])
    expect(validateBenchmarkResult(resultValidMatrix)).toEqual([])
    expect(resultValidMatrix.gates.find((g) => g.id === 'calibration.matrix.complete')?.passed).toBe(true)
    expect(resultValidMatrix.metrics.find((m) => m.id === 'c02_small_v1.calibration.complete')?.value).toBe(1)
    expect(resultValidMatrix.metrics.find((m) => m.id === 'c02_mixed_balanced_v1.calibration.complete')?.value).toBe(1)
  })
})

describe('C02 global display count mandatory — fail-closed completeness across uniform/mixed/matrix (LOCK-004)', () => {
  function makeHeapPair(deltaBytes: number): { before: RendererHeapSample; after: RendererHeapSample } {
    const before: RendererHeapSample = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 20_000_000,
      totalJSHeapSize: 80_000_000,
      jsHeapSizeLimit: 2_000_000_000
    }
    const after: RendererHeapSample = {
      method: RENDERER_HEAP_METHOD,
      usedJSHeapSize: 20_000_000 + deltaBytes,
      totalJSHeapSize: 80_000_000,
      jsHeapSizeLimit: 2_000_000_000
    }
    return { before, after }
  }
  function makeTestEnvironment(): BenchmarkResult['environment'] {
    return {
      timestamp: new Date().toISOString(),
      node: 'v24.11.1',
      pnpm: '10.27.0',
      abiLane: 'electron',
      abi: '145',
      command: 'pnpm test:e2e',
      git: { commit: 'abc123def456abc123def456abc123def456abcd', dirty: false }
    }
  }

  it('uniform: missing/null/non-finite globalDisplayMessages cannot produce complete artifacts', () => {
    const profile = C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.small]! // 50 partial >25
    const topics = buildC02SyntheticTopics(profile)
    const logicalBytes = canonicalBytesForTopics(topics)
    const expectedVisible = c02ExpectedVisibleCount(profile)
    const heap = makeHeapPair(2500)
    const info = { informative: true, reason: 'x' }
    const baseAllocation = {
      topicsCreated: profile.syntheticTopics,
      messagesCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      blocksCreated: profile.syntheticTopics * profile.syntheticMessagesPerTopic,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: c02ExpectedProjectedTotal(profile),
        reduxBlocks: c02ExpectedProjectedTotal(profile),
        groupCount: expectedVisible,
        displayMessages: expectedVisible,
        anchorGroupKey: 'c02-heap-topic-00-group',
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: expectedVisible,
        globalDisplayMessages: expectedVisible
      },
      productionPath: 'valid partial',
      productionPathComplete: true
    }
    for (const badGlobal of [undefined, null, NaN, Infinity, -Infinity] as any[]) {
      const alloc: any = {
        ...baseAllocation,
        projectionStats: { ...baseAllocation.projectionStats, globalDisplayMessages: badGlobal }
      }
      // Pure derivation must be false
      expect(deriveFinalTopicDomProof(expectedVisible, badGlobal as any, expectedVisible)).toBe(false)
      const result = buildC02BenchmarkResult(
        makeTestEnvironment(),
        profile,
        logicalBytes,
        logicalBytes,
        heap.before,
        heap.after,
        alloc,
        info,
        'precise'
      )
      expect(validateBenchmarkResult(result)).toEqual([])
      expect(result.metrics.find((m) => m.id === 'projection.finalTopicDomProof')?.value).toBe(0)
      expect(result.gates.find((g) => g.id === 'projection.finalTopicOwnership')?.passed).toBe(false)
      expect(result.metrics.find((m) => m.id === 'calibration.complete')?.value).toBe(0)
      expect(result.gates.find((g) => g.id === 'calibration.complete')?.passed).toBe(false)
      expect(result.gates.find((g) => g.id === 'productionPath.complete')?.passed).toBe(false)
      expect(result.gates.find((g) => g.id === 'allocation.resident')?.passed).toBe(false)
    }
    // Valid finite global still passes
    const validResult = buildC02BenchmarkResult(
      makeTestEnvironment(),
      profile,
      logicalBytes,
      logicalBytes,
      heap.before,
      heap.after,
      baseAllocation as any,
      info,
      'precise'
    )
    expect(validResult.metrics.find((m) => m.id === 'calibration.complete')?.value).toBe(1)
    expect(validResult.gates.find((g) => g.id === 'calibration.complete')?.passed).toBe(true)
  })

  it('mixed: missing/null/non-finite globalDisplayMessages cannot produce complete artifacts', () => {
    const profile = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.balanced]! // last 100 partial
    const topics = buildC02MixedSyntheticTopics(profile)
    const logicalBytes = canonicalBytesForTopics(topics)
    const lastSpec = profile.topicSpecs[profile.topicSpecs.length - 1]!
    const expectedVisible = c02MixedExpectedVisibleCountForSpec(lastSpec)
    const expectedProjected = c02MixedExpectedProjectedTotal(profile)
    const heap = makeHeapPair(3000)
    const info = { informative: true, reason: 'x' }
    const baseAllocation = {
      topicsCreated: profile.topicSpecs.length,
      messagesCreated: c02MixedTotalMessages(profile),
      blocksCreated: c02MixedTotalMessages(profile),
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: expectedProjected,
        reduxBlocks: expectedProjected,
        groupCount: expectedVisible,
        displayMessages: expectedVisible,
        anchorGroupKey: 'c02-mixed-topic-03-group',
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: expectedVisible,
        globalDisplayMessages: expectedVisible
      },
      productionPath: 'valid mixed',
      productionPathComplete: true
    }
    for (const badGlobal of [undefined, null, NaN, Infinity] as any[]) {
      const alloc: any = {
        ...baseAllocation,
        projectionStats: { ...baseAllocation.projectionStats, globalDisplayMessages: badGlobal }
      }
      expect(deriveFinalTopicDomProof(expectedVisible, badGlobal as any, expectedVisible)).toBe(false)
      const result = buildC02MixedBenchmarkResult(
        makeTestEnvironment(),
        profile,
        logicalBytes,
        logicalBytes,
        heap.before,
        heap.after,
        alloc,
        info,
        'precise'
      )
      expect(validateBenchmarkResult(result)).toEqual([])
      expect(result.metrics.find((m) => m.id === 'projection.finalTopicDomProof')?.value).toBe(0)
      expect(result.metrics.find((m) => m.id === 'calibration.complete')?.value).toBe(0)
      expect(result.gates.find((g) => g.id === 'calibration.complete')?.passed).toBe(false)
    }
    const validResult = buildC02MixedBenchmarkResult(
      makeTestEnvironment(),
      profile,
      logicalBytes,
      logicalBytes,
      heap.before,
      heap.after,
      baseAllocation as any,
      info,
      'precise'
    )
    expect(validResult.metrics.find((m) => m.id === 'calibration.complete')?.value).toBe(1)
  })

  it('matrix: missing/null/non-finite globalDisplayMessages per entry cannot produce complete artifacts', () => {
    const uniformProfile = C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.small]!
    const uniformTopics = buildC02SyntheticTopics(uniformProfile)
    const uniformBytes = canonicalBytesForTopics(uniformTopics)
    const uniformVisible = c02ExpectedVisibleCount(uniformProfile)
    const mixedProfile = C02_MIXED_HEAP_PROFILES[C02_MIXED_HEAP_PROFILE_IDS.balanced]!
    const mixedTopics = buildC02MixedSyntheticTopics(mixedProfile)
    const mixedBytes = canonicalBytesForTopics(mixedTopics)
    const mixedVisible = c02MixedExpectedVisibleCountForSpec(
      mixedProfile.topicSpecs[mixedProfile.topicSpecs.length - 1]!
    )
    const heapValid = makeHeapPair(2500)
    const info = { informative: true, reason: 'x' }
    const validUniformAlloc: any = {
      topicsCreated: uniformProfile.syntheticTopics,
      messagesCreated: uniformProfile.syntheticTopics * uniformProfile.syntheticMessagesPerTopic,
      blocksCreated: uniformProfile.syntheticTopics * uniformProfile.syntheticMessagesPerTopic,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: c02ExpectedProjectedTotal(uniformProfile),
        reduxBlocks: c02ExpectedProjectedTotal(uniformProfile),
        groupCount: uniformVisible,
        displayMessages: uniformVisible,
        anchorGroupKey: 'c02-heap-topic-00-group',
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: uniformVisible,
        globalDisplayMessages: uniformVisible
      },
      productionPath: 'valid uniform',
      productionPathComplete: true
    }
    const validMixedAlloc: any = {
      topicsCreated: mixedProfile.topicSpecs.length,
      messagesCreated: c02MixedTotalMessages(mixedProfile),
      blocksCreated: c02MixedTotalMessages(mixedProfile),
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: c02MixedExpectedProjectedTotal(mixedProfile),
        reduxBlocks: c02MixedExpectedProjectedTotal(mixedProfile),
        groupCount: mixedVisible,
        displayMessages: mixedVisible,
        anchorGroupKey: 'c02-mixed-topic-03-group',
        contextBoundaryPresent: true,
        contextBoundaryInsideMessages: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: mixedVisible,
        globalDisplayMessages: mixedVisible
      },
      productionPath: 'valid mixed',
      productionPathComplete: true
    }
    for (const badGlobal of [undefined, null, NaN, Infinity] as any[]) {
      const badUniformAlloc: any = {
        ...validUniformAlloc,
        projectionStats: { ...validUniformAlloc.projectionStats, globalDisplayMessages: badGlobal }
      }
      const resultOneBad = buildC02MultiBenchmarkResult(makeTestEnvironment(), [
        {
          profileId: C02_HEAP_PROFILE_IDS.small,
          profile: uniformProfile,
          logicalBytes: uniformBytes,
          rendererLogicalBytes: uniformBytes,
          heapBefore: heapValid.before,
          heapAfter: heapValid.after,
          allocation: badUniformAlloc,
          informativeness: info,
          precision: 'precise',
          finalTopicId: 'c02-heap-topic-00'
        },
        {
          profileId: C02_MIXED_HEAP_PROFILE_IDS.balanced,
          profile: mixedProfile,
          logicalBytes: mixedBytes,
          rendererLogicalBytes: mixedBytes,
          heapBefore: heapValid.before,
          heapAfter: heapValid.after,
          allocation: validMixedAlloc,
          informativeness: info,
          precision: 'precise',
          finalTopicId: 'c02-mixed-topic-03'
        }
      ])
      expect(resultOneBad.metrics.find((m) => m.id === 'c02_small_v1.calibration.complete')?.value).toBe(0)
      expect(resultOneBad.gates.find((g) => g.id === 'c02_small_v1.calibration.complete')?.passed).toBe(false)
      expect(resultOneBad.gates.find((g) => g.id === 'calibration.matrix.complete')?.passed).toBe(false)

      const badMixedAlloc: any = {
        ...validMixedAlloc,
        projectionStats: { ...validMixedAlloc.projectionStats, globalDisplayMessages: badGlobal }
      }
      const resultMixedBad = buildC02MultiBenchmarkResult(makeTestEnvironment(), [
        {
          profileId: C02_HEAP_PROFILE_IDS.small,
          profile: uniformProfile,
          logicalBytes: uniformBytes,
          rendererLogicalBytes: uniformBytes,
          heapBefore: heapValid.before,
          heapAfter: heapValid.after,
          allocation: validUniformAlloc,
          informativeness: info,
          precision: 'precise',
          finalTopicId: 'c02-heap-topic-00'
        },
        {
          profileId: C02_MIXED_HEAP_PROFILE_IDS.balanced,
          profile: mixedProfile,
          logicalBytes: mixedBytes,
          rendererLogicalBytes: mixedBytes,
          heapBefore: heapValid.before,
          heapAfter: heapValid.after,
          allocation: badMixedAlloc,
          informativeness: info,
          precision: 'precise',
          finalTopicId: 'c02-mixed-topic-03'
        }
      ])
      expect(resultMixedBad.metrics.find((m) => m.id === 'c02_mixed_balanced_v1.calibration.complete')?.value).toBe(0)
      expect(resultMixedBad.gates.find((g) => g.id === 'calibration.matrix.complete')?.passed).toBe(false)
    }
    // Both valid still complete
    const bothValid = buildC02MultiBenchmarkResult(makeTestEnvironment(), [
      {
        profileId: C02_HEAP_PROFILE_IDS.small,
        profile: uniformProfile,
        logicalBytes: uniformBytes,
        rendererLogicalBytes: uniformBytes,
        heapBefore: heapValid.before,
        heapAfter: heapValid.after,
        allocation: validUniformAlloc,
        informativeness: info,
        precision: 'precise',
        finalTopicId: 'c02-heap-topic-00'
      },
      {
        profileId: C02_MIXED_HEAP_PROFILE_IDS.balanced,
        profile: mixedProfile,
        logicalBytes: mixedBytes,
        rendererLogicalBytes: mixedBytes,
        heapBefore: heapValid.before,
        heapAfter: heapValid.after,
        allocation: validMixedAlloc,
        informativeness: info,
        precision: 'precise',
        finalTopicId: 'c02-mixed-topic-03'
      }
    ])
    expect(bothValid.gates.find((g) => g.id === 'calibration.matrix.complete')?.passed).toBe(true)
  })
})
