/**
 * CLI tests for the read-only schema-v1 benchmark artifact summary entrypoint
 * (`benchSummaryCli`). The directory resolver and streams are injected so the
 * tests never depend on the real cwd or global process output.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  BENCH_RESULT_SCHEMA_VERSION,
  type BenchmarkMetric,
  type BenchmarkResult,
  writeBenchmarkResult
} from '../../src/main/services/chatDb/__tests__/benchResult'
import { SEARCH_BENCH_PROFILES } from '../../src/main/services/chatDb/__tests__/searchBenchHarness'
import { benchSummaryCli } from './cli'

function io() {
  return {
    stdout: vi.fn<(text: string) => void>(),
    stderr: vi.fn<(text: string) => void>()
  }
}

function searchArtifact(scale: Record<string, number>, metrics: BenchmarkMetric[]): BenchmarkResult {
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
    gates: [{ id: 'parity.ordered', name: 'Full ordered block-ID parity', kind: 'correctness', passed: true }]
  }
}

let tempDir: string

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-summary-cli-test-'))
  writeBenchmarkResult(searchArtifact({ blocks: 1000 }, [{ id: 'like.p50', name: 'LIKE p50', value: 3, unit: 'ms' }]), {
    dir: tempDir,
    fileName: 'a-1k.json'
  })
  writeBenchmarkResult(
    searchArtifact({ blocks: 10_000 }, [{ id: 'like.p50', name: 'LIKE p50', value: 12, unit: 'ms' }]),
    {
      dir: tempDir,
      fileName: 'b-10k.json'
    }
  )
})

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('benchSummaryCli', () => {
  it('prints help and exits 0 for --help alone', () => {
    const writers = io()
    const result = benchSummaryCli(['--help'], writers, { cwd: tempDir })
    expect(result.code).toBe(0)
    expect(result.report).toBeNull()
    expect(writers.stdout.mock.calls.join('\n')).toContain('usage:')
    expect(writers.stderr).not.toHaveBeenCalled()
  })

  it('rejects --help combined with other arguments as a usage error', () => {
    const writers = io()
    const result = benchSummaryCli(['--help', '--dir', '/x'], writers, { cwd: tempDir })
    expect(result.code).toBe(2)
    expect(writers.stderr.mock.calls.join('\n')).toContain('cannot be combined')
  })

  it('rejects an unknown option as a usage error', () => {
    const writers = io()
    const result = benchSummaryCli(['--nope'], writers, { cwd: tempDir })
    expect(result.code).toBe(2)
    expect(writers.stderr.mock.calls.join('\n')).toContain("unknown option '--nope'")
  })

  it('rejects a positional argument as a usage error', () => {
    const writers = io()
    const result = benchSummaryCli(['some.json'], writers, { cwd: tempDir })
    expect(result.code).toBe(2)
    expect(writers.stderr.mock.calls.join('\n')).toContain("unexpected positional argument 'some.json'")
  })

  it('rejects an empty --dir value as a usage error', () => {
    const writers = io()
    const result = benchSummaryCli(['--dir='], writers, { cwd: tempDir })
    expect(result.code).toBe(2)
    expect(writers.stderr.mock.calls.join('\n')).toContain("'--dir' requires a directory path")
  })

  it('analyzes the given --dir and prints deterministic machine-readable JSON', () => {
    const writers = io()
    const result = benchSummaryCli(['--dir', tempDir], writers, { cwd: tempDir })
    expect(result.code).toBe(0)
    expect(result.report).not.toBeNull()

    const output = writers.stdout.mock.calls.join('')
    const parsed = JSON.parse(output) as {
      scope: { dir: string; filesScanned: number; accepted: number; rejected: number }
      series: {
        metricId: string
        curve:
          | { kind: 'curve'; curve: { axis: string; direction: string } }
          | { kind: 'insufficient'; reason: string }
          | { kind: 'confounded'; axes: string[] }
      }[]
      notice: string
    }
    expect(parsed.scope.dir).toBe(tempDir)
    expect(parsed.scope.filesScanned).toBe(2)
    expect(parsed.scope.accepted).toBe(2)
    expect(parsed.scope.rejected).toBe(0)
    expect(parsed.series).toHaveLength(1)
    expect(parsed.series[0].metricId).toBe('like.p50')
    if (parsed.series[0].curve.kind === 'curve') {
      expect(parsed.series[0].curve.curve.axis).toBe('blocks')
      expect(parsed.series[0].curve.curve.direction).toBe('increasing')
    }
    expect(parsed.notice.length).toBeGreaterThan(0)
    expect(writers.stderr).not.toHaveBeenCalled()
  })

  it('supports the --dir=<dir> form and resolves relative values against the injected cwd', () => {
    fs.mkdirSync(path.join(tempDir, 'relative-results'))
    const writers = io()
    const result = benchSummaryCli(['--dir=relative-results'], writers, { cwd: tempDir })
    expect(result.code).toBe(0)
    expect(result.report?.scope.dir).toBe(path.join(tempDir, 'relative-results'))
    expect(result.report?.scope.filesScanned).toBe(0)
    expect(writers.stdout.mock.calls.join('')).toContain('filesScanned')
  })

  it('exits 1 when the analysis directory does not exist', () => {
    const writers = io()
    const result = benchSummaryCli(['--dir', path.join(tempDir, 'does-not-exist')], writers, { cwd: tempDir })
    expect(result.code).toBe(1)
    expect(result.report).toBeNull()
    expect(writers.stderr.mock.calls.join('\n')).toContain('failed to analyze')
    expect(writers.stdout).not.toHaveBeenCalled()
  })

  it('uses an injected resolver for the default directory', () => {
    const writers = io()
    const resolveDir = vi.fn<(explicit: string | undefined, cwd: string) => string>().mockReturnValue(tempDir)
    const result = benchSummaryCli([], writers, { cwd: tempDir, resolveDir })
    expect(result.code).toBe(0)
    expect(resolveDir).toHaveBeenCalledWith(undefined, tempDir)
    expect(result.report?.scope.dir).toBe(tempDir)
  })
})

// ---------------------------------------------------------------------------
// PERF-004 F1/F3 regression: the CLI forms one cross-scale family from real
// emitter profile ids (chatdb-search-1k + chatdb-search-10k +
// chatdb-search-50k), with a blocks curve and no profileCode axis.
// ---------------------------------------------------------------------------

function realSearchResult(profileKey: keyof typeof SEARCH_BENCH_PROFILES, likeP50: number): BenchmarkResult {
  const profile = SEARCH_BENCH_PROFILES[profileKey]
  return {
    schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
    benchmark: {
      id: profile.id,
      name: profile.name,
      scale: {
        blocks: profile.blocks,
        profileCode: profile.profileCode,
        queryFixtures: 10,
        warmupRounds: 3,
        measureRounds: 10,
        pageSize: 100
      }
    },
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
      { id: 'fts.p50', name: 'Hybrid FTS p50', value: likeP50 / 2, unit: 'ms' }
    ],
    gates: [{ id: 'parity.ordered', name: 'Full ordered block-ID parity', kind: 'correctness', passed: true }]
  }
}

describe('benchSummaryCli — real PERF-004 profile ids form one family', () => {
  let familyDir: string

  beforeAll(() => {
    familyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-summary-cli-family-'))
    writeBenchmarkResult(realSearchResult('1k', 1.35), { dir: familyDir, fileName: 'chatdb-search-1k-run.json' })
    writeBenchmarkResult(realSearchResult('10k', 12.5), { dir: familyDir, fileName: 'chatdb-search-10k-run.json' })
    writeBenchmarkResult(realSearchResult('50k', 200), { dir: familyDir, fileName: 'chatdb-search-50k-run.json' })
  })

  afterAll(() => {
    fs.rmSync(familyDir, { recursive: true, force: true })
  })

  it('reports one chatdb-search family series with a blocks curve containing all three points and a knee', () => {
    const writers = io()
    const result = benchSummaryCli(['--dir', familyDir], writers, { cwd: familyDir })
    expect(result.code).toBe(0)
    expect(result.report).not.toBeNull()
    expect(writers.stderr).not.toHaveBeenCalled()

    const parsed = JSON.parse(writers.stdout.mock.calls.join('')) as {
      series: {
        benchmarkId: string
        metricId: string
        runs: number
        scalePoints: number
        curve:
          | { kind: 'curve'; curve: { axis: string; points: { scale: number }[]; direction: string } }
          | { kind: 'insufficient'; reason: string }
          | { kind: 'confounded'; axes: string[] }
        knee: { kind: string }
      }[]
    }
    expect(parsed.series).toHaveLength(2)
    const likeP50 = parsed.series.find((s) => s.metricId === 'like.p50')
    expect(likeP50?.benchmarkId).toBe('chatdb-search')
    expect(likeP50?.runs).toBe(3)
    expect(likeP50?.scalePoints).toBe(3)
    if (likeP50?.curve.kind === 'curve') {
      expect(likeP50.curve.curve.axis).toBe('blocks')
      expect(likeP50.curve.curve.points.map((p) => p.scale)).toEqual([1000, 10_000, 50_000])
      expect(likeP50.curve.curve.direction).toBe('increasing')
    }
    // Three points → a single interior knee inspection candidate (index 1).
    expect(likeP50?.knee.kind).toBe('reported')
  })
})
