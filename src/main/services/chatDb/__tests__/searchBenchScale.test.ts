/**
 * Focused tests for the PERF-004 search benchmark scale-profile selection
 * (searchBenchHarness.ts): deterministic 1k/10k profile resolution, default
 * preservation (command compatibility), safe rejection of invalid profile
 * input, and the scale metadata both profiles contribute to the schema-v1
 * artifact (blocks / profileCode / benchmark id + name).
 *
 * This file is pure parsing/metadata logic — it imports no native module and
 * performs no filesystem work, so mainLanes.ts classifies it into the core
 * lane; it runs under `pnpm test:main:core`.
 */

import { describe, expect, it } from 'vitest'

import { DEFAULT_SEARCH_BENCH_SCALE, resolveSearchBenchScale, SEARCH_BENCH_PROFILES } from './searchBenchHarness'

describe('search bench scale profiles (PERF-004)', () => {
  it('declares exactly the two fast deterministic corpus scales 1k and 10k', () => {
    expect(Object.keys(SEARCH_BENCH_PROFILES).sort()).toEqual(['10k', '1k'])
  })

  it('keeps the 10k profile identical to the pre-existing benchmark identity', () => {
    const profile = SEARCH_BENCH_PROFILES['10k']
    expect(profile.blocks).toBe(10_000)
    expect(profile.id).toBe('chatdb-search-10k')
    expect(profile.name).toBe('Search — 10k corpus LIKE vs hybrid FTS')
    // Unset/empty input must keep the legacy default (command compatibility).
    expect(DEFAULT_SEARCH_BENCH_SCALE).toBe('10k')
  })

  it('adds a fast 1k profile with distinct scale metadata', () => {
    const one = SEARCH_BENCH_PROFILES['1k']
    const ten = SEARCH_BENCH_PROFILES['10k']
    expect(one.blocks).toBe(1_000)
    expect(one.blocks).toBeLessThan(ten.blocks)
    expect(one.id).toBe('chatdb-search-1k')
    expect(one.name).toBe('Search — 1k corpus LIKE vs hybrid FTS')
    expect(one.profileCode).toBe(0)
    expect(ten.profileCode).toBe(1)
    expect(one.profileCode).not.toBe(ten.profileCode)
  })

  it('resolves the 10k default when the env value is absent or empty', () => {
    expect(resolveSearchBenchScale(undefined)).toBe('10k')
    expect(resolveSearchBenchScale('')).toBe('10k')
    expect(resolveSearchBenchScale('   ')).toBe('10k')
  })

  it('resolves every declared profile deterministically', () => {
    for (const key of Object.keys(SEARCH_BENCH_PROFILES) as Array<keyof typeof SEARCH_BENCH_PROFILES>) {
      expect(resolveSearchBenchScale(key)).toBe(key)
      // Same input always yields the same profile.
      expect(resolveSearchBenchScale(key)).toBe(resolveSearchBenchScale(key))
    }
  })

  it('accepts whitespace-padded declared values after trimming', () => {
    expect(resolveSearchBenchScale(' 1k ')).toBe('1k')
    expect(resolveSearchBenchScale('\t10k\n')).toBe('10k')
  })

  it('rejects unknown profile values loudly instead of silently falling back', () => {
    // 50k/120k are out of scope for this first slice; case variants and
    // unrelated strings must never silently select the default profile.
    const invalid = ['50k', '120k', '10K', '1K', 'n1', 's0-20', '--help']
    for (const bad of invalid) {
      expect(() => resolveSearchBenchScale(bad)).toThrow(/SEARCH_BENCH_SCALE/)
      expect(() => resolveSearchBenchScale(bad)).toThrow(/1k/)
      expect(() => resolveSearchBenchScale(bad)).toThrow(/10k/)
    }
  })
})
