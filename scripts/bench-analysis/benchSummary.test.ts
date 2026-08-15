/**
 * Focused tests for the read-only schema-v1 benchmark artifact summary
 * consumer (benchSummary.ts).
 *
 * Covers the accepted/rejected file contract, deterministic grouping of
 * comparable metrics by scale, directional curve labels, run variance
 * (sufficient and explicit insufficient data), the spacing-aware knee
 * candidate, confounded scale handling, determinism of the whole report, and
 * the privacy guard (forbidden leaf keys never enter the analysis).
 *
 * Runs in the `scripts` Vitest project (real node modules — the scripts
 * project has no fs mocks). Valid artifacts are written through the real
 * schema-v1 writer so they round-trip the closed contract. Each describe
 * block reads from its own temp subdirectory so fixtures never cross-
 * contaminate.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  BENCH_RESULT_SCHEMA_VERSION,
  type BenchmarkMetric,
  type BenchmarkResult,
  writeBenchmarkResult
} from '../../src/main/services/chatDb/__tests__/benchResult'
import { SEARCH_BENCH_PROFILES } from '../../src/main/services/chatDb/__tests__/searchBenchHarness'
import {
  analysisScale,
  BENCH_SUMMARY_NOTICE,
  computeCurve,
  computeKnee,
  curveDirection,
  deriveBenchmarkFamily,
  detectForbiddenFields,
  groupSeries,
  readBenchmarkArtifactDirectory,
  SCALE_METADATA_KEYS,
  SEARCH_BENCH_FAMILY_ID,
  summarizeBenchmarkDirectory,
  validateArtifactFile
} from './benchSummary'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function searchArtifact(
  scale: Record<string, number>,
  metrics: BenchmarkMetric[],
  overrides: Partial<BenchmarkResult> = {}
): BenchmarkResult {
  return {
    schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
    benchmark: { id: 'chatdb-search', name: 'Search — FTS scale comparison', scale },
    environment: {
      timestamp: '2026-08-15T04:00:00.000Z',
      node: 'v24.11.1',
      pnpm: '10.27.0',
      abiLane: 'node',
      abi: '137',
      command: 'pnpm bench:main:native',
      git: { commit: 'b815b7652e5a0f788dbea84d0be4b11887e8a0c9', dirty: false }
    },
    metrics,
    gates: [{ id: 'parity.ordered', name: 'Full ordered block-ID parity', kind: 'correctness', passed: true }],
    ...overrides
  }
}

function searchMetrics(
  likeP50: number,
  likeP95: number,
  ftsP50: number,
  ftsP95: number,
  speedupP50: number
): BenchmarkMetric[] {
  return [
    { id: 'like.p50', name: 'LIKE baseline p50', value: likeP50, unit: 'ms' },
    { id: 'like.p95', name: 'LIKE baseline p95', value: likeP95, unit: 'ms' },
    { id: 'fts.p50', name: 'Hybrid FTS p50', value: ftsP50, unit: 'ms' },
    { id: 'fts.p95', name: 'Hybrid FTS p95', value: ftsP95, unit: 'ms' },
    { id: 'speedup.p50', name: 'LIKE/FTS speedup p50', value: speedupP50, unit: 'x' }
  ]
}

/** Three-point increasing search curve: 1k / 2k / 10k corpus. */
function threePointSearchArtifacts(): BenchmarkResult[] {
  return [
    searchArtifact({ blocks: 1000 }, searchMetrics(3.0, 5.0, 2.0, 4.0, 1.5)),
    searchArtifact({ blocks: 2000 }, searchMetrics(3.2, 5.4, 2.1, 4.2, 1.5)),
    searchArtifact({ blocks: 10_000 }, searchMetrics(12.0, 16.0, 4.8, 10.8, 2.6))
  ]
}

let tempDir: string

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-summary-test-'))
})

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

/** Create a fresh per-describe subdirectory. */
function freshSubdir(name: string): string {
  const dir = path.join(tempDir, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Write a valid artifact through the real schema-v1 writer; returns its file name. */
function writeValidInto(dir: string, result: BenchmarkResult, fileName: string): string {
  const fullPath = writeBenchmarkResult(result, { dir, fileName })
  return path.basename(fullPath)
}

function seriesOf(report: ReturnType<typeof summarizeBenchmarkDirectory>, metricId: string) {
  const series = report.series.find((s) => s.metricId === metricId)
  if (series === undefined) throw new Error(`no series for metric '${metricId}'`)
  return series
}

// ---------------------------------------------------------------------------
// validateArtifactFile — malformed / incompatible / privacy-sensitive
// ---------------------------------------------------------------------------

describe('validateArtifactFile', () => {
  it('accepts a realistic schema-v1 artifact', () => {
    const raw = JSON.stringify(searchArtifact({ blocks: 10_000 }, searchMetrics(12, 16, 4.8, 10.8, 2.6)))
    const verdict = validateArtifactFile(raw)
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.result.benchmark.id).toBe('chatdb-search')
  })

  it('rejects non-JSON text with a parse reason', () => {
    const verdict = validateArtifactFile('{ not json')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('not valid JSON')
  })

  it('rejects an incompatible schema version explicitly', () => {
    const verdict = validateArtifactFile('{"schemaVersion": 2}')
    expect(verdict).toEqual({ ok: false, reason: 'incompatible schemaVersion 2 (only schemaVersion 1 is supported)' })
  })

  it('rejects unknown closed-schema fields as schema violations', () => {
    const raw = JSON.stringify({ ...searchArtifact({ blocks: 1000 }, searchMetrics(3, 5, 2, 4, 1.5)), extra: 1 })
    const verdict = validateArtifactFile(raw)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.reason).toContain('schema violation')
      expect(verdict.reason).toContain('extra')
    }
  })

  it('rejects privacy-sensitive artifacts with the offending keys named', () => {
    const raw = JSON.stringify({
      ...searchArtifact({ blocks: 1000 }, searchMetrics(3, 5, 2, 4, 1.5)),
      content: 'sensitive message content',
      credentials: { password: 'hunter2' }
    })
    const verdict = validateArtifactFile(raw)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe('forbidden fields present: content, credentials, password')
  })
})

describe('detectForbiddenFields', () => {
  it('finds forbidden leaf keys anywhere in the value and sorts them', () => {
    expect(detectForbiddenFields({ a: { b: { content: 'x' } }, password: 'y', apiKey: 'z' })).toEqual([
      'apiKey',
      'content',
      'password'
    ])
  })

  it('returns an empty list for a clean value', () => {
    expect(detectForbiddenFields({ a: { b: 1 } })).toEqual([])
    expect(detectForbiddenFields([{ name: 'ok' }])).toEqual([])
  })

  it('scans inside arrays', () => {
    expect(detectForbiddenFields({ list: [{ token: 't' }] })).toEqual(['token'])
  })
})

// ---------------------------------------------------------------------------
// Directory reading — mixed acceptance/rejection
// ---------------------------------------------------------------------------

describe('readBenchmarkArtifactDirectory', () => {
  it('accepts valid artifacts, rejects malformed/incompatible/sensitive ones, and ignores non-json files', () => {
    const dir = freshSubdir('mixed')

    writeValidInto(dir, searchArtifact({ blocks: 1000 }, searchMetrics(3, 5, 2, 4, 1.5)), 'a-valid.json')
    fs.writeFileSync(path.join(dir, 'b-broken.json'), '{ nope', 'utf8')
    fs.writeFileSync(path.join(dir, 'c-future.json'), '{"schemaVersion": 2}', 'utf8')
    fs.writeFileSync(
      path.join(dir, 'd-unknown.json'),
      JSON.stringify({ ...searchArtifact({ blocks: 1000 }, searchMetrics(3, 5, 2, 4, 1.5)), foo: 1 }),
      'utf8'
    )
    fs.writeFileSync(
      path.join(dir, 'e-sensitive.json'),
      JSON.stringify({ ...searchArtifact({ blocks: 1000 }, searchMetrics(3, 5, 2, 4, 1.5)), content: 'x' }),
      'utf8'
    )
    fs.writeFileSync(path.join(dir, 'f-notes.txt'), 'not an artifact', 'utf8')
    fs.mkdirSync(path.join(dir, 'g-dir.json'))

    const scan = readBenchmarkArtifactDirectory(dir)

    const statuses = Object.fromEntries(scan.files.map((f) => [f.file, f.status]))
    expect(statuses['a-valid.json']).toBe('accepted')
    expect(statuses['b-broken.json']).toBe('rejected')
    expect(statuses['c-future.json']).toBe('rejected')
    expect(statuses['d-unknown.json']).toBe('rejected')
    expect(statuses['e-sensitive.json']).toBe('rejected')
    expect('f-notes.txt' in statuses).toBe(false)
    expect(statuses['g-dir.json']).toBe('rejected')

    const rejected = scan.files.filter((f) => f.status === 'rejected')
    expect(rejected.find((f) => f.file === 'b-broken.json')?.reason).toContain('not valid JSON')
    expect(rejected.find((f) => f.file === 'c-future.json')?.reason).toContain('incompatible schemaVersion 2')
    expect(rejected.find((f) => f.file === 'd-unknown.json')?.reason).toContain('schema violation')
    expect(rejected.find((f) => f.file === 'e-sensitive.json')?.reason).toContain('forbidden fields present: content')
    expect(rejected.find((f) => f.file === 'g-dir.json')?.reason).toBe('not a regular file')

    // Only the valid artifact contributes data; file list is in code-unit order.
    expect(scan.artifacts.map((a) => a.file)).toEqual(['a-valid.json'])
    expect(scan.files.map((f) => f.file)).toEqual([
      'a-valid.json',
      'b-broken.json',
      'c-future.json',
      'd-unknown.json',
      'e-sensitive.json',
      'g-dir.json'
    ])
  })
})

// ---------------------------------------------------------------------------
// Curve direction, series grouping, determinism
// ---------------------------------------------------------------------------

describe('summarizeBenchmarkDirectory — valid multi-scale data', () => {
  let dir: string

  beforeAll(() => {
    dir = freshSubdir('scales')
    for (const [index, result] of threePointSearchArtifacts().entries()) {
      writeValidInto(dir, result, `search-scale-${index}.json`)
    }
  })

  function report() {
    return summarizeBenchmarkDirectory(dir)
  }

  it('groups comparable metrics by (benchmark id, metric id, unit)', () => {
    const r = report()
    expect(r.series.map((s) => s.metricId)).toEqual(['fts.p50', 'fts.p95', 'like.p50', 'like.p95', 'speedup.p50'])
    for (const series of r.series) {
      expect(series.benchmarkId).toBe('chatdb-search')
      expect(series.runs).toBe(3)
      expect(series.scalePoints).toBe(3)
    }
  })

  it('reports increasing curve direction along the single varying scale axis', () => {
    const likeP50 = seriesOf(report(), 'like.p50')
    expect(likeP50.curve).toEqual({
      kind: 'curve',
      curve: {
        axis: 'blocks',
        points: [
          { scale: 1000, value: 3 },
          { scale: 2000, value: 3.2 },
          { scale: 10_000, value: 12 }
        ],
        direction: 'increasing'
      }
    })
  })

  it('reports the speedup series as increasing too (unit x is handled uniformly)', () => {
    const speedup = seriesOf(report(), 'speedup.p50')
    expect(speedup.unit).toBe('x')
    expect(speedup.curve.kind).toBe('curve')
    if (speedup.curve.kind === 'curve') expect(speedup.curve.curve.direction).toBe('increasing')
  })

  it('reports the single interior knee candidate with the spacing-aware slope-change magnitude', () => {
    // Points (1000, 3), (2000, 3.2), (10_000, 12). With exactly three points
    // there is only one interior inspection candidate (index 1). Its magnitude
    // is the adjacent piecewise-linear slope change:
    //   right slope (2k→10k span) - left slope (1k→2k span)
    // = (12 - 3.2) / (10_000 - 2_000) - (3.2 - 3) / (2_000 - 1_000)
    // = 8.8/8000 - 0.2/1000
    const likeP50 = seriesOf(report(), 'like.p50')
    expect(likeP50.knee).toEqual({
      kind: 'reported',
      candidate: {
        index: 1,
        scale: 2000,
        value: 3.2,
        slopeChange: (12 - 3.2) / (10_000 - 2_000) - (3.2 - 3) / (2_000 - 1_000)
      }
    })
  })

  it('reports explicit insufficient variance data when a scale point has a single run', () => {
    const likeP50 = seriesOf(report(), 'like.p50')
    const singleRun = likeP50.variance.find((v) => v.scale.blocks === 1000)
    expect(singleRun?.variance.kind).toBe('insufficient')
    if (singleRun?.variance.kind === 'insufficient') {
      expect(singleRun.variance.reason).toContain('single run')
    }
  })

  it('emits a deterministic report across repeated runs', () => {
    const first = JSON.stringify(summarizeBenchmarkDirectory(dir))
    const second = JSON.stringify(summarizeBenchmarkDirectory(dir))
    expect(second).toBe(first)
  })

  it('never embeds threshold, gate, or regression semantics in the analysis output', () => {
    const r = report()
    expect(r.notice).toBe(BENCH_SUMMARY_NOTICE)
    const seriesJson = JSON.stringify(r.series)
    expect(seriesJson).not.toMatch(/threshold|regression|\bgate\b|\bpassed\b|\bfailed\b/)
  })
})

// ---------------------------------------------------------------------------
// Run variance with repeated runs at one scale point
// ---------------------------------------------------------------------------

describe('summarizeBenchmarkDirectory — run variance', () => {
  let dir: string

  beforeAll(() => {
    dir = freshSubdir('variance')
    // Two runs at the same 10k scale point, plus one 1k run.
    writeValidInto(dir, searchArtifact({ blocks: 10_000 }, searchMetrics(10, 14, 4, 9, 2.0)), 'variance-run-a.json')
    writeValidInto(dir, searchArtifact({ blocks: 10_000 }, searchMetrics(14, 18, 5, 10, 2.4)), 'variance-run-b.json')
    writeValidInto(dir, searchArtifact({ blocks: 1000 }, searchMetrics(3, 5, 2, 4, 1.5)), 'variance-1k.json')
  })

  function report() {
    return summarizeBenchmarkDirectory(dir)
  }

  it('computes deterministic variance statistics for the 10k scale point', () => {
    const likeP50 = seriesOf(report(), 'like.p50')
    const tenK = likeP50.variance.find((v) => v.scale.blocks === 10_000)
    expect(tenK?.variance.kind).toBe('sufficient')
    if (tenK?.variance.kind === 'sufficient') {
      expect(tenK.variance.runs).toBe(2)
      expect(tenK.variance.values).toEqual([10, 14])
      expect(tenK.variance.min).toBe(10)
      expect(tenK.variance.max).toBe(14)
      expect(tenK.variance.range).toBe(4)
      expect(tenK.variance.mean).toBe(12)
      expect(tenK.variance.stddev).toBe(2)
      expect(tenK.variance.cv).toBeCloseTo(2 / 12, 12)
    }
  })

  it('aggregates repeated runs at a scale point with the mean for the curve', () => {
    const likeP50 = seriesOf(report(), 'like.p50')
    expect(likeP50.curve).toEqual({
      kind: 'curve',
      curve: {
        axis: 'blocks',
        points: [
          { scale: 1000, value: 3 },
          { scale: 10_000, value: (10 + 14) / 2 }
        ],
        direction: 'increasing'
      }
    })
  })
})

// ---------------------------------------------------------------------------
// Insufficient data
// ---------------------------------------------------------------------------

describe('insufficient data handling', () => {
  it('single artifact: curve and knee are explicit insufficient, variance per scale point too', () => {
    const dir = freshSubdir('single')
    writeValidInto(dir, searchArtifact({ blocks: 10_000 }, searchMetrics(12, 16, 4.8, 10.8, 2.6)), 'single-10k.json')

    const report = summarizeBenchmarkDirectory(dir)
    const likeP50 = report.series.find((s) => s.metricId === 'like.p50')
    expect(likeP50).toBeDefined()
    if (likeP50 === undefined) return

    expect(likeP50.curve).toEqual({
      kind: 'insufficient',
      reason: expect.stringContaining('at least 2 distinct scale points')
    })
    expect(likeP50.knee).toEqual({ kind: 'insufficient', reason: expect.stringContaining('no unconfounded curve') })
    expect(likeP50.variance).toHaveLength(1)
    expect(likeP50.variance[0].variance.kind).toBe('insufficient')
  })

  it('curveDirection is deterministic for all sign patterns', () => {
    expect(curveDirection([1, 2, 3])).toBe('increasing')
    expect(curveDirection([3, 2, 1])).toBe('decreasing')
    expect(curveDirection([2, 2, 2])).toBe('flat')
    expect(curveDirection([1, 3, 2])).toBe('non-monotonic')
  })
})

// ---------------------------------------------------------------------------
// Confounded scale, non-monotonic curves, knee edge cases
// ---------------------------------------------------------------------------

describe('confounded and non-monotonic curves', () => {
  it('reports confounded when more than one scale dimension varies', () => {
    const artifacts = [
      searchArtifact({ blocks: 1000, pageSize: 100 }, searchMetrics(3, 5, 2, 4, 1.5)),
      searchArtifact({ blocks: 2000, pageSize: 50 }, searchMetrics(6, 9, 3, 6, 2.0))
    ]
    const series = groupSeries(artifacts.map((result, index) => ({ file: `conf-${index}.json`, result })))
    const likeP50 = series.find((s) => s.metricId === 'like.p50')
    expect(likeP50?.curve).toEqual({ kind: 'confounded', axes: ['blocks', 'pageSize'] })
    if (likeP50?.curve.kind === 'confounded') {
      expect(likeP50.knee).toEqual({ kind: 'insufficient', reason: 'no unconfounded curve to inspect' })
    }
  })

  it('reports non-monotonic direction and refuses a knee for non-monotonic curves', () => {
    const points = [
      { scale: { blocks: 1000 }, value: 3 },
      { scale: { blocks: 2000 }, value: 12 },
      { scale: { blocks: 10_000 }, value: 5 }
    ]
    const curve = computeCurve(points)
    expect(curve.kind).toBe('curve')
    if (curve.kind === 'curve') {
      expect(curve.curve.direction).toBe('non-monotonic')
      const knee = computeKnee(curve)
      expect(knee).toEqual({ kind: 'insufficient', reason: expect.stringContaining('monotonic') })
    }
  })

  it('refuses a knee with fewer than three scale points', () => {
    const points = [
      { scale: { blocks: 1000 }, value: 3 },
      { scale: { blocks: 10_000 }, value: 12 }
    ]
    const curve = computeCurve(points)
    expect(curve.kind).toBe('curve')
    const knee = computeKnee(curve)
    expect(knee).toEqual({ kind: 'insufficient', reason: expect.stringContaining('at least 3 distinct scale points') })
  })

  it('refuses a knee for a flat curve even with enough points', () => {
    const points = [
      { scale: { blocks: 1000 }, value: 5 },
      { scale: { blocks: 2000 }, value: 5 },
      { scale: { blocks: 10_000 }, value: 5 }
    ]
    const curve = computeCurve(points)
    expect(curve.kind).toBe('curve')
    if (curve.kind === 'curve') {
      expect(curve.curve.direction).toBe('flat')
      const knee = computeKnee(curve)
      expect(knee).toEqual({ kind: 'insufficient', reason: expect.stringContaining('monotonic') })
    }
  })

  it('resolves knee ties to the lowest scale point', () => {
    // Nonuniform spacing (1000, 2000, 4000, 10_000) with slopes 1 → 3 → 5:
    // the adjacent slope change at interior indices 1 and 2 is +2 and +2
    // (equal magnitude); the lower-scale interior point wins.
    const points = [
      { scale: { blocks: 1000 }, value: 0 },
      { scale: { blocks: 2000 }, value: 1000 },
      { scale: { blocks: 4000 }, value: 7000 },
      { scale: { blocks: 10_000 }, value: 37_000 }
    ]
    const curve = computeCurve(points)
    expect(curve.kind).toBe('curve')
    if (curve.kind === 'curve') {
      expect(curve.curve.direction).toBe('increasing')
      expect(computeKnee(curve)).toEqual({
        kind: 'reported',
        candidate: {
          index: 1,
          scale: 2000,
          value: 1000,
          slopeChange: (7000 - 1000) / (4000 - 2000) - (1000 - 0) / (2000 - 1000)
        }
      })
    }
  })

  it('reports a signed slope change for a strictly decreasing curve', () => {
    // Points (1000, 3000), (2000, 2000), (4000, 1000) are strictly decreasing,
    // so the monotonic knee gate accepts the single interior candidate
    // (index 1). Left slope (1k→2k span) = (2000-3000)/1000 = -1; right slope
    // (2k→4k span) = (1000-2000)/2000 = -0.5; the signed slope change
    // (right − left) is +0.5 — the curve flattens as it descends.
    const points = [
      { scale: { blocks: 1000 }, value: 3000 },
      { scale: { blocks: 2000 }, value: 2000 },
      { scale: { blocks: 4000 }, value: 1000 }
    ]
    const curve = computeCurve(points)
    expect(curve.kind).toBe('curve')
    if (curve.kind === 'curve') {
      expect(curve.curve.direction).toBe('decreasing')
      expect(computeKnee(curve)).toEqual({
        kind: 'reported',
        candidate: {
          index: 1,
          scale: 2000,
          value: 2000,
          slopeChange: 0.5
        }
      })
    }
  })

  it('treats a differing key set between scale records as a varying axis', () => {
    const points: { scale: Record<string, number>; value: number }[] = [
      { scale: { blocks: 1000 }, value: 3 },
      { scale: { blocks: 2000, pageSize: 100 }, value: 6 }
    ]
    const curve = computeCurve(points)
    // 'pageSize' present in one record but not the other → varies → confounded.
    expect(curve).toEqual({ kind: 'confounded', axes: ['blocks', 'pageSize'] })
  })
})

// ---------------------------------------------------------------------------
// Unit is part of the series identity
// ---------------------------------------------------------------------------

describe('series identity includes unit', () => {
  it('splits the same metric id into separate series when the unit differs', () => {
    const a = searchArtifact({ blocks: 1000 }, [{ id: 'm', name: 'metric without unit', value: 1 }])
    const b = searchArtifact({ blocks: 10_000 }, [{ id: 'm', name: 'metric with unit', value: 2, unit: 'ms' }])
    const series = groupSeries([
      { file: 'a.json', result: a },
      { file: 'b.json', result: b }
    ])
    expect(series).toHaveLength(2)
    const noUnit = series.find((s) => s.unit === null)
    const ms = series.find((s) => s.unit === 'ms')
    expect(noUnit).toBeDefined()
    expect(ms).toBeDefined()
    if (noUnit !== undefined) expect(noUnit.runs).toBe(1)
    if (ms !== undefined) expect(ms.runs).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// PERF-004 audit F1–F3 regression coverage — real emitter-shaped artifacts
// ---------------------------------------------------------------------------

/**
 * Build a search-bench artifact shaped exactly like the real emitter
 * (search.bench.ts + searchBenchHarness.ts): profile id/name/blocks/
 * profileCode from `SEARCH_BENCH_PROFILES`, plus the full scale-key set the
 * benchmark records (queryFixtures/warmupRounds/measureRounds/pageSize) and
 * the metric set it emits. `scaleOverrides` lets tests remove `profileCode`
 * to reproduce pre-PERF-004 "old" artifacts.
 */
function realSearchArtifact(
  profileKey: keyof typeof SEARCH_BENCH_PROFILES,
  likeP50: number,
  ftsP50: number,
  scaleOverrides: { profileCode?: boolean; extraKey?: [string, number] } = {}
): BenchmarkResult {
  const profile = SEARCH_BENCH_PROFILES[profileKey]
  const scale: Record<string, number> = {
    blocks: profile.blocks,
    queryFixtures: 10,
    warmupRounds: 3,
    measureRounds: 10,
    pageSize: 100
  }
  if (scaleOverrides.profileCode !== false) scale.profileCode = profile.profileCode
  if (scaleOverrides.extraKey !== undefined) scale[scaleOverrides.extraKey[0]] = scaleOverrides.extraKey[1]
  return {
    schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
    benchmark: { id: profile.id, name: profile.name, scale },
    environment: {
      timestamp: '2026-08-15T04:00:00.000Z',
      node: 'v24.11.1',
      pnpm: '10.27.0',
      abiLane: 'node',
      abi: '137',
      command: 'pnpm bench:main:native',
      git: { commit: 'b2583f3a4255541c2008c6c4a1b290a8933cfa01', dirty: true }
    },
    metrics: [
      { id: 'like.p50', name: 'LIKE baseline p50', value: likeP50, unit: 'ms' },
      { id: 'like.p95', name: 'LIKE baseline p95', value: likeP50 * 1.4, unit: 'ms' },
      { id: 'like.mean', name: 'LIKE baseline mean', value: likeP50 * 1.1, unit: 'ms' },
      { id: 'fts.p50', name: 'Hybrid FTS p50', value: ftsP50, unit: 'ms' },
      { id: 'fts.p95', name: 'Hybrid FTS p95', value: ftsP50 * 1.5, unit: 'ms' },
      { id: 'fts.mean', name: 'Hybrid FTS mean', value: ftsP50 * 1.2, unit: 'ms' },
      { id: 'speedup.p50', name: 'LIKE/FTS speedup p50', value: likeP50 / ftsP50, unit: 'x' },
      { id: 'speedup.p95', name: 'LIKE/FTS speedup p95', value: (likeP50 * 1.4) / (ftsP50 * 1.5), unit: 'x' }
    ],
    gates: [{ id: 'parity.ordered', name: 'Full ordered block-ID parity', kind: 'correctness', passed: true }]
  }
}

describe('deriveBenchmarkFamily (PERF-004 F1)', () => {
  it('maps every real profile id to the single search family', () => {
    const ids = Object.values(SEARCH_BENCH_PROFILES).map((profile) => profile.id)
    expect(ids).toHaveLength(3)
    for (const id of ids) expect(deriveBenchmarkFamily(id)).toBe('chatdb-search')
  })

  it('maps to the family exactly when SEARCH_BENCH_PROFILES has at least one declared profile', () => {
    expect(SEARCH_BENCH_PROFILES['1k'].id).toBe('chatdb-search-1k')
    expect(SEARCH_BENCH_PROFILES['10k'].id).toBe('chatdb-search-10k')
    expect(SEARCH_BENCH_PROFILES['50k'].id).toBe('chatdb-search-50k')
    expect(SEARCH_BENCH_FAMILY_ID).toBe('chatdb-search')
  })

  it('keeps unknown benchmark ids as their own family (no fuzzy matching)', () => {
    expect(deriveBenchmarkFamily('chatdb-sqlite-runtime')).toBe('chatdb-sqlite-runtime')
    expect(deriveBenchmarkFamily('chatdb-search')).toBe('chatdb-search')
    expect(deriveBenchmarkFamily('some-random-id')).toBe('some-random-id')
  })
})

describe('analysisScale / SCALE_METADATA_KEYS (PERF-004 F2)', () => {
  it('excludes profileCode and keeps every physical dimension', () => {
    expect(SCALE_METADATA_KEYS.has('profileCode')).toBe(true)
    const real = {
      blocks: 10_000,
      profileCode: 1,
      queryFixtures: 10,
      warmupRounds: 3,
      measureRounds: 10,
      pageSize: 100
    }
    expect(analysisScale(real)).toEqual({
      blocks: 10_000,
      measureRounds: 10,
      pageSize: 100,
      queryFixtures: 10,
      warmupRounds: 3
    })
    expect(analysisScale(real)).toEqual(analysisScale(analysisScale(real))) // idempotent
  })

  it('leaves scales without metadata keys untouched apart from key sorting', () => {
    expect(analysisScale({ pageSize: 100, blocks: 1000 })).toEqual({ blocks: 1000, pageSize: 100 })
  })
})

describe('real 1k + 10k artifacts form one cross-scale family curve (PERF-004 F1/F3)', () => {
  let dir: string

  beforeAll(() => {
    dir = freshSubdir('real-family')
    writeValidInto(dir, realSearchArtifact('1k', 1.35, 0.8), 'real-1k.json')
    writeValidInto(dir, realSearchArtifact('10k', 12.5, 4.9), 'real-10k.json')
  })

  it('groups both real profile ids into one chatdb-search family series per metric', () => {
    const r = summarizeBenchmarkDirectory(dir)
    const likeP50 = seriesOf(r, 'like.p50')
    expect(likeP50.benchmarkId).toBe('chatdb-search')
    expect(likeP50.runs).toBe(2)
    expect(likeP50.scalePoints).toBe(2)
    expect(r.series.filter((s) => s.benchmarkId === 'chatdb-search')).toHaveLength(8)
  })

  it('reports a blocks curve containing both real scale points', () => {
    const likeP50 = seriesOf(summarizeBenchmarkDirectory(dir), 'like.p50')
    expect(likeP50.curve).toEqual({
      kind: 'curve',
      curve: {
        axis: 'blocks',
        points: [
          { scale: 1000, value: 1.35 },
          { scale: 10_000, value: 12.5 }
        ],
        direction: 'increasing'
      }
    })
  })

  it('does not treat profileCode as a dimension axis', () => {
    const r = summarizeBenchmarkDirectory(dir)
    for (const series of r.series) {
      if (series.curve.kind === 'curve') expect(series.curve.curve.axis).toBe('blocks')
    }
  })

  it('keeps the knee explicit insufficient for only two scale points', () => {
    const likeP50 = seriesOf(summarizeBenchmarkDirectory(dir), 'like.p50')
    expect(likeP50.knee).toEqual({
      kind: 'insufficient',
      reason: expect.stringContaining('at least 3 distinct scale points')
    })
  })

  it('never embeds profileCode in reported variance scale records', () => {
    const r = summarizeBenchmarkDirectory(dir)
    for (const series of r.series) {
      for (const variance of series.variance) expect(variance.scale.profileCode).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// Real 1k + 10k + 50k emitter-shaped artifacts — one family, one blocks
// curve, and a corrected spacing-aware knee (PERF-004 second slice)
// ---------------------------------------------------------------------------

describe('real 1k + 10k + 50k artifacts form one family with a spacing-aware knee (PERF-004)', () => {
  /** Values exactly on a straight line through the nonuniform 1k/10k/50k x spacing. */
  let lineDir: string
  /** Values with a genuine change in adjacent slope at the 10k interior point. */
  let kneeDir: string

  beforeAll(() => {
    lineDir = freshSubdir('real-family-3k-line')
    // likeP50 = 0.001 * blocks → exactly on a line: (1k, 1), (10k, 10), (50k, 50).
    writeValidInto(lineDir, realSearchArtifact('1k', 1, 0.5), 'line-1k.json')
    writeValidInto(lineDir, realSearchArtifact('10k', 10, 5), 'line-10k.json')
    writeValidInto(lineDir, realSearchArtifact('50k', 50, 25), 'line-50k.json')

    kneeDir = freshSubdir('real-family-3k-knee')
    // 1.35 → 12.5 is a shallow 1k→10k slope; 12.5 → 200 is a much steeper
    // 10k→50k slope, so the adjacent slope change at the 10k point is nonzero.
    writeValidInto(kneeDir, realSearchArtifact('1k', 1.35, 0.8), 'knee-1k.json')
    writeValidInto(kneeDir, realSearchArtifact('10k', 12.5, 4.9), 'knee-10k.json')
    writeValidInto(kneeDir, realSearchArtifact('50k', 200, 40), 'knee-50k.json')
  })

  it('groups all three real profile ids into one chatdb-search family series per metric', () => {
    const r = summarizeBenchmarkDirectory(kneeDir)
    const likeP50 = seriesOf(r, 'like.p50')
    expect(likeP50.benchmarkId).toBe('chatdb-search')
    expect(likeP50.runs).toBe(3)
    expect(likeP50.scalePoints).toBe(3)
    // 8 metrics × 3 profiles, all under one family.
    expect(r.series.filter((s) => s.benchmarkId === 'chatdb-search')).toHaveLength(8)
    for (const series of r.series) expect(series.runs).toBe(3)
  })

  it('reports a blocks curve with all three real scale points ascending', () => {
    const likeP50 = seriesOf(summarizeBenchmarkDirectory(kneeDir), 'like.p50')
    expect(likeP50.curve).toEqual({
      kind: 'curve',
      curve: {
        axis: 'blocks',
        points: [
          { scale: 1000, value: 1.35 },
          { scale: 10_000, value: 12.5 },
          { scale: 50_000, value: 200 }
        ],
        direction: 'increasing'
      }
    })
  })

  it('does not treat profileCode as a dimension axis across all three profiles', () => {
    const r = summarizeBenchmarkDirectory(kneeDir)
    for (const series of r.series) {
      if (series.curve.kind === 'curve') expect(series.curve.curve.axis).toBe('blocks')
    }
  })

  it('a straight line at nonuniform 1k/10k/50k spacing produces exactly zero knee magnitude', () => {
    const likeP50 = seriesOf(summarizeBenchmarkDirectory(lineDir), 'like.p50')
    expect(likeP50.knee).toEqual({
      kind: 'reported',
      candidate: {
        index: 1,
        scale: 10_000,
        value: 10,
        slopeChange: 0
      }
    })
    // All derived linear metrics stay (effectively) zero-magnitude too;
    // the multiplier products round identically on both adjacent slopes.
    for (const id of ['like.p95', 'like.mean', 'fts.p50', 'fts.p95', 'fts.mean']) {
      const series = seriesOf(summarizeBenchmarkDirectory(lineDir), id)
      expect(series.knee.kind).toBe('reported')
      if (series.knee.kind === 'reported') {
        expect(series.knee.candidate.index).toBe(1)
        expect(series.knee.candidate.scale).toBe(10_000)
        expect(series.knee.candidate.slopeChange).toBeCloseTo(0, 12)
      }
    }
  })

  it('reports the deterministic interior knee candidate for a genuine slope change', () => {
    const likeP50 = seriesOf(summarizeBenchmarkDirectory(kneeDir), 'like.p50')
    const expectedSlopeChange = (200 - 12.5) / (50_000 - 10_000) - (12.5 - 1.35) / (10_000 - 1_000)
    expect(likeP50.knee).toEqual({
      kind: 'reported',
      candidate: {
        index: 1,
        scale: 10_000,
        value: 12.5,
        slopeChange: expectedSlopeChange
      }
    })
    expect(expectedSlopeChange).toBeGreaterThan(0.003)
  })

  it('is deterministic across repeated runs for the three-point set', () => {
    const first = JSON.stringify(summarizeBenchmarkDirectory(kneeDir))
    const second = JSON.stringify(summarizeBenchmarkDirectory(kneeDir))
    expect(second).toBe(first)
  })

  it('never embeds profileCode in reported variance scale records for the 50k point', () => {
    const r = summarizeBenchmarkDirectory(kneeDir)
    for (const series of r.series) {
      const fifty = series.variance.find((v) => v.scale.blocks === 50_000)
      expect(fifty).toBeDefined()
      if (fifty !== undefined) expect(fifty.scale.profileCode).toBeUndefined()
    }
  })
})

describe('old/new profileCode drift merges as the same scale (PERF-004 F2)', () => {
  let dir: string

  beforeAll(() => {
    dir = freshSubdir('real-drift')
    // Pre-PERF-004 10k artifact: no profileCode key at all.
    writeValidInto(dir, realSearchArtifact('10k', 9.7, 3.5, { profileCode: false }), 'drift-old-10k-a.json')
    writeValidInto(dir, realSearchArtifact('10k', 14.0, 5.2, { profileCode: false }), 'drift-old-10k-b.json')
    // Post-PERF-004 10k artifact: profileCode present.
    writeValidInto(dir, realSearchArtifact('10k', 22.4, 9.4), 'drift-new-10k.json')
  })

  it('merges old and new 10k runs into one variance scale point (3 runs)', () => {
    const likeP50 = seriesOf(summarizeBenchmarkDirectory(dir), 'like.p50')
    expect(likeP50.scalePoints).toBe(1)
    expect(likeP50.variance).toHaveLength(1)
    const tenK = likeP50.variance[0]
    expect(tenK.variance.kind).toBe('sufficient')
    if (tenK.variance.kind === 'sufficient') {
      expect(tenK.variance.runs).toBe(3)
      expect(tenK.variance.values).toEqual([9.7, 14, 22.4])
    }
  })

  it('cannot create a false curve or an undefined scale point from drift alone', () => {
    const likeP50 = seriesOf(summarizeBenchmarkDirectory(dir), 'like.p50')
    expect(likeP50.curve).toEqual({
      kind: 'insufficient',
      reason: expect.stringContaining('at least 2 distinct scale points')
    })
    // A non-curve verdict structurally guarantees every point would carry a
    // defined scale coordinate; drift never yields axis 'profileCode'.
    expect(likeP50.curve.kind).not.toBe('curve')
  })

  it('still forms the cross-scale curve when a 1k artifact is added to the drifted 10k set', () => {
    const mixed = freshSubdir('real-drift-mixed')
    writeValidInto(mixed, realSearchArtifact('1k', 1.35, 0.8), 'mixed-1k.json')
    writeValidInto(mixed, realSearchArtifact('10k', 9.7, 3.5, { profileCode: false }), 'mixed-old-10k.json')
    writeValidInto(mixed, realSearchArtifact('10k', 22.4, 9.4), 'mixed-new-10k.json')

    const likeP50 = seriesOf(summarizeBenchmarkDirectory(mixed), 'like.p50')
    expect(likeP50.curve).toEqual({
      kind: 'curve',
      curve: {
        axis: 'blocks',
        points: [
          { scale: 1000, value: 1.35 },
          { scale: 10_000, value: (9.7 + 22.4) / 2 }
        ],
        direction: 'increasing'
      }
    })
    expect(likeP50.knee).toEqual({
      kind: 'insufficient',
      reason: expect.stringContaining('at least 3 distinct scale points')
    })
  })

  it('is deterministic across repeated runs', () => {
    const first = JSON.stringify(summarizeBenchmarkDirectory(dir))
    const second = JSON.stringify(summarizeBenchmarkDirectory(dir))
    expect(second).toBe(first)
  })
})

describe('computeCurve never emits undefined scale coordinates (PERF-004 F2)', () => {
  it('reports insufficient for same-blocks old/new profileCode drift instead of a malformed curve', () => {
    const points: { scale: Record<string, number>; value: number }[] = [
      { scale: { blocks: 10_000, queryFixtures: 10, warmupRounds: 3, measureRounds: 10, pageSize: 100 }, value: 9.7 },
      {
        scale: { blocks: 10_000, profileCode: 1, queryFixtures: 10, warmupRounds: 3, measureRounds: 10, pageSize: 100 },
        value: 22.4
      }
    ]
    const curve = computeCurve(points)
    expect(curve).toEqual({ kind: 'insufficient', reason: expect.stringContaining('at least 2 distinct scale points') })
  })

  it('derives the blocks axis for cross-scale drift, with both coordinates defined', () => {
    const points: { scale: Record<string, number>; value: number }[] = [
      { scale: { blocks: 1000, profileCode: 0, queryFixtures: 10 }, value: 1.35 },
      { scale: { blocks: 10_000, queryFixtures: 10 }, value: 12.5 }
    ]
    const curve = computeCurve(points)
    expect(curve.kind).toBe('curve')
    if (curve.kind === 'curve') {
      expect(curve.curve.axis).toBe('blocks')
      expect(curve.curve.points).toEqual([
        { scale: 1000, value: 1.35 },
        { scale: 10_000, value: 12.5 }
      ])
      for (const point of curve.curve.points) expect(typeof point.scale).toBe('number')
    }
  })

  it('reports confounded when drift occurs in a non-excluded dimension even with profileCode present', () => {
    const points: { scale: Record<string, number>; value: number }[] = [
      { scale: { blocks: 1000, profileCode: 0, pageSize: 100 }, value: 3 },
      { scale: { blocks: 2000, profileCode: 1 }, value: 6 }
    ]
    expect(computeCurve(points)).toEqual({ kind: 'confounded', axes: ['blocks', 'pageSize'] })
  })
})
