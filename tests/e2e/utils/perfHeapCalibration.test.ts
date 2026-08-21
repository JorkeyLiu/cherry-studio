/**
 * Pure deterministic tests for PERF-C02 heap calibration helper
 * (tests/e2e/utils/perfHeapCalibration.ts). Runs in Node e2e-utils lane.
 */
import { describe, expect, it } from 'vitest'

import {
  buildC02SyntheticTopics,
  buildC02ScaleMap,
  C02_BENCHMARK_ID,
  c02HeapGateEnabled,
  canonicalBytesForTopic,
  canonicalBytesForTopics,
  classifyEffectiveHeapDeltaInformative,
  classifyHeapDeltaInformative,
  computeHeapAmplification,
  DEFAULT_C02_HEAP_PROFILE,
  detectHeapPrecisionLabel,
  HEAP_METHOD_CODE,
  HEAP_PRECISION_CODE,
  isEffectiveHeapDeltaInformative,
  PERF_C02_HEAP_ENV,
  RENDERER_HEAP_METHOD,
  resolveC02HeapProfile,
  validateHeapSample,
  validateLogicalBytes,
  validateSyntheticTopics,
  type RendererHeapSample
} from './perfHeapCalibration'

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
  it('returns precise when argv contains enable-precise-memory-info', () => {
    expect(
      detectHeapPrecisionLabel(['electron', '--enable-precise-memory-info', '--no-sandbox'], RENDERER_HEAP_METHOD)
    ).toBe('precise')
  })

  it('returns bucketed when flag absent but method available', () => {
    expect(detectHeapPrecisionLabel(['electron', '--no-sandbox'], RENDERER_HEAP_METHOD)).toBe('bucketed')
  })

  it('returns unsupported when method unsupported', () => {
    expect(detectHeapPrecisionLabel(['electron', '--enable-precise-memory-info'], 'unsupported')).toBe('unsupported')
  })

  it('returns unsupported when method not performance.memory', () => {
    expect(detectHeapPrecisionLabel(['electron'], 'other')).toBe('unsupported')
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

describe('constants', () => {
  it('benchmark id is distinct and stable', () => {
    expect(C02_BENCHMARK_ID).toBe('chatdb-c02-renderer-heap-e2e')
    expect(C02_BENCHMARK_ID).not.toBe('chatdb-stream-render-e2e-n1')
  })

  it('restores original env', () => {
    expect(process.env[PERF_C02_HEAP_ENV]).toBe(ORIGINAL_ENV)
  })
})
