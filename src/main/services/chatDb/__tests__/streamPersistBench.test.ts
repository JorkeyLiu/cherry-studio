import { describe, expect, it } from 'vitest'

import {
  assertStreamPersistSampleCounts,
  buildStreamPersistMetrics,
  deriveStreamPersistDifferentialSamples,
  resolveStreamPersistGate,
  STREAM_PERSIST_MEASURE_ROUNDS,
  STREAM_PERSIST_PROFILES,
  streamPersistContent,
  type StreamPersistLaneSamples,
  type StreamPersistProfileKey,
  streamPersistStats
} from './streamPersistBench'

describe('resolveStreamPersistGate', () => {
  it('disabled for unset/empty, enabled for 1/true, throws otherwise', () => {
    expect(resolveStreamPersistGate(undefined)).toBe(false)
    expect(resolveStreamPersistGate('')).toBe(false)
    expect(resolveStreamPersistGate('1')).toBe(true)
    expect(resolveStreamPersistGate('true')).toBe(true)
    expect(resolveStreamPersistGate('TRUE')).toBe(true)
    expect(() => resolveStreamPersistGate('2')).toThrow(/STREAM_PERSIST_BENCH/)
    expect(() => resolveStreamPersistGate('on')).toThrow(/STREAM_PERSIST_BENCH/)
  })
})

describe('streamPersistContent', () => {
  it('growth content grows monotonically with the round index', () => {
    const c1 = streamPersistContent('growth', 1)
    const c2 = streamPersistContent('growth', 2)
    const cMax = streamPersistContent('growth', STREAM_PERSIST_MEASURE_ROUNDS)
    expect(c1.length).toBeLessThan(c2.length)
    expect(c2.length).toBeLessThan(cMax.length)
  })

  it('nochange and completion content is identical across rounds', () => {
    expect(streamPersistContent('nochange', 1)).toBe(streamPersistContent('nochange', 5))
    expect(streamPersistContent('completion', 1)).toBe(streamPersistContent('completion', 5))
    expect(streamPersistContent('nochange', 1)).toBe(streamPersistContent('completion', 1))
  })
})

describe('deriveStreamPersistDifferentialSamples', () => {
  it('computes per-round triggerOn − baseOnly and fails on length mismatch', () => {
    expect(deriveStreamPersistDifferentialSamples({ triggerOn: [2, 3, 4], baseOnly: [1, 1, 1] })).toEqual([1, 2, 3])
    expect(() => deriveStreamPersistDifferentialSamples({ triggerOn: [1, 2], baseOnly: [1] })).toThrow(/same length/)
  })
})

describe('streamPersistStats', () => {
  it('computes nearest-rank p50/p95/mean/min/max and throws on empty', () => {
    const stats = streamPersistStats([1, 2, 3, 4, 5, 6, 7, 8])
    expect(stats.min).toBe(1)
    expect(stats.max).toBe(8)
    expect(stats.mean).toBe(4.5)
    // Nearest-rank percentile: index = ceil(p/100 * n) − 1 (n=8 → p50 index 3 = 4).
    expect(stats.p50).toBe(4)
    expect(stats.p95).toBe(8)
    expect(() => streamPersistStats([])).toThrow(/empty/)
  })
})

describe('buildStreamPersistMetrics + assertStreamPersistSampleCounts', () => {
  function validSamples(count: number): Map<StreamPersistProfileKey, StreamPersistLaneSamples> {
    const map = new Map<StreamPersistProfileKey, StreamPersistLaneSamples>()
    for (const profile of STREAM_PERSIST_PROFILES) {
      map.set(profile, {
        triggerOn: Array.from({ length: count }, () => 1),
        baseOnly: Array.from({ length: count }, () => 1)
      })
    }
    return map
  }

  it('builds a metric row for every profile/lane/stat and differential', () => {
    const metrics = buildStreamPersistMetrics(validSamples(3))
    expect(metrics.length).toBeGreaterThan(0)
    const ids = new Set(metrics.map((m) => m.id))
    expect(ids.size).toBe(metrics.length)
    expect(metrics.every((m) => Number.isFinite(m.value))).toBe(true)
  })

  it('fails fast on a missing profile sample set', () => {
    const map = validSamples(3)
    map.delete('growth')
    expect(() => buildStreamPersistMetrics(map)).toThrow(/no samples recorded for profile 'growth'/)
  })

  it('sample-count guard passes for exact counts and throws on mismatch', () => {
    const ok = assertStreamPersistSampleCounts(
      validSamples(STREAM_PERSIST_MEASURE_ROUNDS),
      STREAM_PERSIST_MEASURE_ROUNDS
    )
    expect(ok.ok).toBe(true)
    expect(ok.verifiedProfiles).toHaveLength(STREAM_PERSIST_PROFILES.length)
    expect(() => assertStreamPersistSampleCounts(validSamples(3), STREAM_PERSIST_MEASURE_ROUNDS)).toThrow(
      /has 3 samples, expected exactly/
    )
  })
})
