/**
 * Focused tests for the PERF-004 search benchmark scale-profile selection
 * (searchBenchHarness.ts): deterministic 1k/10k/50k profile resolution,
 * default preservation (command compatibility), safe rejection of invalid
 * profile input, and the scale metadata each profile contributes to the
 * schema-v1 artifact (blocks / profileCode / benchmark id + name).
 *
 * This file is pure parsing/metadata logic — it imports no native module and
 * performs no filesystem work, so mainLanes.ts classifies it into the core
 * lane; it runs under `pnpm test:main:core`.
 */

import { describe, expect, it } from 'vitest'

import { DEFAULT_SEARCH_BENCH_SCALE, resolveSearchBenchScale, SEARCH_BENCH_PROFILES } from './searchBenchHarness'

describe('search bench scale profiles (PERF-004)', () => {
  it('declares exactly the three deterministic corpus scales 1k, 10k, and 50k', () => {
    expect(Object.keys(SEARCH_BENCH_PROFILES).sort()).toEqual(['10k', '1k', '50k'])
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

  it('adds an on-demand 50k profile with distinct scale metadata and a stable identity', () => {
    const fifty = SEARCH_BENCH_PROFILES['50k']
    const ten = SEARCH_BENCH_PROFILES['10k']
    expect(fifty.blocks).toBe(50_000)
    expect(fifty.blocks).toBeGreaterThan(ten.blocks)
    expect(fifty.id).toBe('chatdb-search-50k')
    expect(fifty.name).toBe('Search — 50k corpus LIKE vs hybrid FTS')
    expect(fifty.profileCode).toBe(2)
    // 50k must not disturb the 1k/10k identities or the default.
    expect(DEFAULT_SEARCH_BENCH_SCALE).toBe('10k')
    expect(Object.values(SEARCH_BENCH_PROFILES).map((p) => p.profileCode)).toEqual([0, 1, 2])
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
    expect(resolveSearchBenchScale(' 50k\n')).toBe('50k')
  })

  it('rejects unknown profile values loudly instead of silently falling back', () => {
    // 120k and unrelated dimensions are out of scope; case variants and
    // unrelated strings must never silently select the default profile.
    const invalid = ['120k', '50000', '10K', '1K', '50K', 'n1', 's0-20', '--help']
    for (const bad of invalid) {
      expect(() => resolveSearchBenchScale(bad)).toThrow(/SEARCH_BENCH_SCALE/)
      expect(() => resolveSearchBenchScale(bad)).toThrow(/1k/)
      expect(() => resolveSearchBenchScale(bad)).toThrow(/10k/)
    }
  })
})
