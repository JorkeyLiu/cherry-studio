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
  detectHeapPrecisionLabel,
  getC02MixedHeapProfileMatrix,
  HEAP_METHOD_CODE,
  HEAP_PRECISION_CODE,
  isC02MixedHeapProfile,
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
        anchorGroupKey: SENTINEL_ANCHOR_HEAP_INJECT,
        contextBoundaryPresent: true,
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
    // Required finite metrics/gates/scales preserved
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
        anchorGroupKey: SENTINEL_ANCHOR_MIXED_INJECT,
        contextBoundaryPresent: true,
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

    // Allocations carry malicious free-text anchors/paths/reasons that must NOT appear in artifact
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
        anchorGroupKey: SENTINEL_ANCHOR_UNIFORM,
        contextBoundaryPresent: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: c02ExpectedVisibleCount(uniformProfile),
        globalDisplayMessages: c02ExpectedVisibleCount(uniformProfile)
      },
      productionPath: SENTINEL_PRODUCTION_UNIFORM,
      productionPathComplete: true
    }
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
        anchorGroupKey: SENTINEL_ANCHOR_MIXED,
        contextBoundaryPresent: true,
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
        anchorGroupKey: 'SENTINEL_MALICIOUS_ANCHOR_SHOULD_NOT_LEAK_3',
        contextBoundaryPresent: true,
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
        precision: 'precise'
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
        precision: 'precise'
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
        precision: 'precise'
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
    const alloc = (topicsCreated: number, messagesCreated: number, anchor: string, prod: string): any => ({
      topicsCreated,
      messagesCreated,
      blocksCreated: messagesCreated,
      usedTypedPath: true,
      reduxVerified: true,
      projectionStats: {
        reduxMessages: messagesCreated,
        reduxBlocks: messagesCreated,
        groupCount: 50,
        displayMessages: 50,
        anchorGroupKey: anchor,
        contextBoundaryPresent: true,
        finalTopicDomProof: true,
        groupExactMatched: true,
        groupsWithFinalTopic: 50,
        globalDisplayMessages: 50
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
      alloc(
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
      alloc(
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
    // Matrix via the same multi builder consolidates both
    const multi = buildC02MultiBenchmarkResult(env, [
      {
        profileId: C02_HEAP_PROFILE_IDS.default,
        profile: uniformProfile,
        logicalBytes: uniformBytes,
        rendererLogicalBytes: uniformBytes,
        heapBefore: heapU,
        heapAfter: heapUAfter,
        allocation: alloc(
          uniformProfile.syntheticTopics,
          uniformProfile.syntheticTopics * uniformProfile.syntheticMessagesPerTopic,
          'SENTINEL_UNIFORM_ANCHOR2',
          'SENTINEL_PROD2'
        ),
        informativeness: { informative: true, reason: 'SENTINEL_REASON2' },
        precision: 'precise'
      },
      {
        profileId: C02_MIXED_HEAP_PROFILE_IDS.countPressure,
        profile: mixedProfile,
        logicalBytes: mixedBytes,
        rendererLogicalBytes: mixedBytes,
        heapBefore: heapM,
        heapAfter: heapMAfter,
        allocation: alloc(
          mixedProfile.topicSpecs.length,
          c02MixedTotalMessages(mixedProfile),
          'SENTINEL_MIXED_ANCHOR2',
          'SENTINEL_PROD2'
        ),
        informativeness: { informative: true, reason: 'SENTINEL_REASON2' },
        precision: 'precise'
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
