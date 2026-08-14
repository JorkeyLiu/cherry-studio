/**
 * Focused tests for the PERF-001 machine-readable benchmark result contract
 * (benchResult.ts): environment/git metadata collection, schema validation,
 * serialization round-trip, output-path behavior, and the closed-schema
 * guarantee that no sensitive or raw data fields can enter artifacts.
 *
 * Also locks the audit remedies: F1 completion-order gate (artifact emitted
 * only after every registered bench task passed), F2 pnpm truthfulness
 * (non-pnpm UAs never labeled as pnpm), F3 explicit safe canonical command
 * (no argv fallback, path-bearing commands rejected), and F4 millisecond
 * naming with collision-safe auto filenames.
 *
 * This test performs real filesystem work, so it restores the real node
 * modules (tests/main.setup.ts mocks node:fs/node:path/node:os globally) —
 * the same unmock pattern the bench files use; mainLanes.ts classifies this
 * file into the main-native lane as a result.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')

import {
  allBenchTasksCompletedSuccessfully,
  BENCH_RESULT_SCHEMA_VERSION,
  type BenchmarkResult,
  collectEnvironmentMetadata,
  collectGitMetadata,
  emitBenchmarkResultAfterSuccessfulTasks,
  extractPackageManagerVersion,
  formatTimestamp,
  resolveResultsDir,
  validateBenchmarkResult,
  writeBenchmarkResult
} from './benchResult'

const USER_AGENT = 'pnpm/10.27.0 npm/? node/v24.11.1 darwin arm64'

/** A realistic artifact as the two chatDb bench files produce. */
function realisticResult(): BenchmarkResult {
  return {
    schemaVersion: BENCH_RESULT_SCHEMA_VERSION,
    benchmark: {
      id: 'chatdb-search-10k',
      name: 'Search — 10k corpus LIKE vs hybrid FTS',
      scale: { blocks: 10_000, queryFixtures: 10, warmupRounds: 3, measureRounds: 10, pageSize: 100 }
    },
    environment: {
      timestamp: '2026-08-13T04:00:00.000Z',
      node: 'v24.11.1',
      pnpm: '10.27.0',
      abiLane: 'node',
      abi: '137',
      command: 'pnpm bench:main:native',
      git: { commit: '2691e1ef0e862cdb8e2e497d6436d0b9656d0ef3', dirty: true }
    },
    metrics: [
      { id: 'like.p50', name: 'LIKE baseline p50', value: 12.34, unit: 'ms' },
      { id: 'like.p95', name: 'LIKE baseline p95', value: 45.67, unit: 'ms' },
      { id: 'fts.p50', name: 'Hybrid FTS p50', value: 5.67, unit: 'ms' },
      { id: 'fts.p95', name: 'Hybrid FTS p95', value: 21.09, unit: 'ms' },
      { id: 'speedup.p50', name: 'LIKE/FTS speedup p50', value: 2.18, unit: 'x' }
    ],
    gates: [
      {
        id: 'parity.ordered',
        name: 'Full ordered block-ID parity across all cursor pages',
        kind: 'correctness',
        passed: true,
        detail: '10/10 fixtures passed complete ordered parity'
      },
      {
        id: 'parity.no-duplicates',
        name: 'No duplicate block IDs across cursor pages',
        kind: 'correctness',
        passed: true
      },
      { id: 'cold-open.p95-500ms', name: 'Cold DB open p95 < 500ms', kind: 'threshold', passed: true }
    ]
  }
}

/** Keys that must never appear anywhere in a result artifact (PERF-LOCK-006/007). */
const SENSITIVE_KEYS = [
  'content',
  'credential',
  'credentials',
  'password',
  'secret',
  'token',
  'apiKey',
  'dbPath',
  'dbSize',
  'profile',
  'userData',
  'attachment',
  'raw'
]

function collectLeafKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectLeafKeys(item, out)
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      out.push(key)
      collectLeafKeys(child, out)
    }
  }
  return out
}

describe('formatTimestamp', () => {
  it('formats as YYYYMMDD-HHmmss.SSS in local time', () => {
    expect(formatTimestamp(new Date(2026, 7, 13, 9, 8, 7))).toBe('20260813-090807.000')
    expect(formatTimestamp(new Date(2026, 7, 13, 9, 8, 7, 123))).toBe('20260813-090807.123')
  })
})

describe('extractPackageManagerVersion', () => {
  it('parses the pnpm version from npm_config_user_agent', () => {
    expect(extractPackageManagerVersion(USER_AGENT)).toBe('10.27.0')
    expect(extractPackageManagerVersion('pnpm/9.15.4 node/v24.11.1 darwin arm64')).toBe('9.15.4')
  })

  it('never labels a non-pnpm package-manager version as pnpm', () => {
    // Audit F2: an npm/yarn/bun version must never appear in the pnpm field.
    expect(extractPackageManagerVersion('npm/11.0.0 node/v24.11.1 darwin arm64')).toBe('unknown')
    expect(extractPackageManagerVersion('yarn/1.22.22 node/v24.11.1 darwin arm64')).toBe('unknown')
    expect(extractPackageManagerVersion('bun/1.2.3 node/v24.11.1 darwin arm64')).toBe('unknown')
    expect(extractPackageManagerVersion('corepack/1.2.3 npm/11.0.0 node/v24.11.1')).toBe('unknown')
  })

  it('returns unknown for empty/absent user agents', () => {
    expect(extractPackageManagerVersion(undefined)).toBe('unknown')
    expect(extractPackageManagerVersion('')).toBe('unknown')
    expect(extractPackageManagerVersion('   ')).toBe('unknown')
  })
})

describe('collectEnvironmentMetadata', () => {
  const originalUserAgent = process.env.npm_config_user_agent

  beforeAll(() => {
    process.env.npm_config_user_agent = USER_AGENT
  })

  afterAll(() => {
    if (originalUserAgent === undefined) {
      delete process.env.npm_config_user_agent
    } else {
      process.env.npm_config_user_agent = originalUserAgent
    }
  })

  it('collects the full reproducibility block from the running process', () => {
    const env = collectEnvironmentMetadata({ command: 'pnpm bench:main:native' })
    expect(env.node).toBe(process.version)
    expect(env.pnpm).toBe('10.27.0')
    expect(env.abiLane).toBe(process.versions.electron === undefined ? 'node' : 'electron')
    expect(env.abi).toBe(String(process.versions.modules))
    expect(env.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(env.command).toBe('pnpm bench:main:native')
    expect(env.git.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(typeof env.git.dirty).toBe('boolean')
  })

  it('requires an explicit canonical command and never derives one from argv', () => {
    // Audit F3: the old argv fallback leaked process paths into artifacts.
    expect(() => collectEnvironmentMetadata({ command: '' })).toThrow(/command/)
    expect(() => collectEnvironmentMetadata({ command: '   ' })).toThrow(/command/)
  })

  it('respects injected git metadata', () => {
    const env = collectEnvironmentMetadata({ command: 'pnpm bench:main:native', git: { commit: 'abc', dirty: true } })
    expect(env.git).toEqual({ commit: 'abc', dirty: true })
  })
})

describe('collectGitMetadata', () => {
  it('returns commit and dirty=false for a clean porcelain output', () => {
    const runner = (args: string[]): string => {
      if (args[0] === 'rev-parse') return 'abc123'
      if (args[0] === 'status') return ''
      throw new Error(`unexpected args: ${args.join(' ')}`)
    }
    expect(collectGitMetadata(runner)).toEqual({ commit: 'abc123', dirty: false })
  })

  it('marks dirty=true when porcelain lists changes', () => {
    const runner = (args: string[]): string => {
      if (args[0] === 'rev-parse') return 'abc123'
      if (args[0] === 'status') return ' M docs/performance-program.md\n'
      throw new Error(`unexpected args: ${args.join(' ')}`)
    }
    expect(collectGitMetadata(runner)).toEqual({ commit: 'abc123', dirty: true })
  })

  it('falls back to empty commit + dirty=false when git is unavailable', () => {
    const runner = (): string => {
      throw new Error('git not found')
    }
    expect(collectGitMetadata(runner)).toEqual({ commit: '', dirty: false })
  })
})

describe('validateBenchmarkResult', () => {
  it('accepts a realistic artifact with no problems', () => {
    expect(validateBenchmarkResult(realisticResult())).toEqual([])
  })

  it('rejects non-object values', () => {
    expect(validateBenchmarkResult(null)).not.toEqual([])
    expect(validateBenchmarkResult('x')).not.toEqual([])
    expect(validateBenchmarkResult([1, 2])).not.toEqual([])
  })

  it('rejects a wrong schema version', () => {
    const result = realisticResult()
    result.schemaVersion = 2 as unknown as 1
    expect(validateBenchmarkResult(result).join('\n')).toContain('schemaVersion')
  })

  it('rejects unknown top-level fields (closed schema)', () => {
    const result = realisticResult() as unknown as Record<string, unknown>
    result.content = 'sensitive message content'
    result.credentials = { password: 'hunter2' }
    expect(validateBenchmarkResult(result).join('\n')).toContain('content')
    expect(validateBenchmarkResult(result).join('\n')).toContain('credentials')
  })

  it('rejects unknown nested fields', () => {
    const result = realisticResult()
    ;(result.benchmark as unknown as Record<string, unknown>).dbSize = 42
    ;(result.environment as unknown as Record<string, unknown>).userDataPath = '/Users/x'
    const problems = validateBenchmarkResult(result).join('\n')
    expect(problems).toContain('benchmark.dbSize')
    expect(problems).toContain('environment.userDataPath')
  })

  it('rejects a missing benchmark id', () => {
    const result = realisticResult()
    result.benchmark.id = ''
    expect(validateBenchmarkResult(result).join('\n')).toContain('benchmark.id')
  })

  it('rejects non-finite scale and metric values', () => {
    const result = realisticResult()
    result.benchmark.scale = { blocks: Number.NaN }
    expect(validateBenchmarkResult(result).join('\n')).toContain('benchmark.scale.blocks')

    const result2 = realisticResult()
    result2.metrics[0].value = Number.POSITIVE_INFINITY
    expect(validateBenchmarkResult(result2).join('\n')).toContain('metrics[0].value')
  })

  it('rejects empty metrics and gates arrays', () => {
    const noMetrics = realisticResult()
    noMetrics.metrics = []
    expect(validateBenchmarkResult(noMetrics).join('\n')).toContain('metrics')

    const noGates = realisticResult()
    noGates.gates = []
    expect(validateBenchmarkResult(noGates).join('\n')).toContain('gates')
  })

  it('rejects a bad gate kind and a missing passed flag', () => {
    const result = realisticResult()
    result.gates[0].kind = 'warning' as never
    expect(validateBenchmarkResult(result).join('\n')).toContain('gates[0].kind')

    const result2 = realisticResult()
    delete (result2.gates[1] as Partial<BenchmarkResult['gates'][number]>).passed
    expect(validateBenchmarkResult(result2).join('\n')).toContain('gates[1].passed')
  })

  it('rejects a bad abiLane', () => {
    const result = realisticResult()
    result.environment.abiLane = 'threads' as never
    expect(validateBenchmarkResult(result).join('\n')).toContain('environment.abiLane')
  })

  it('rejects a non-ISO-8601 environment timestamp', () => {
    const result = realisticResult()
    result.environment.timestamp = '2026-08-13 04:00:00'
    expect(validateBenchmarkResult(result).join('\n')).toContain('environment.timestamp')
  })

  it('rejects an empty metric unit', () => {
    const result = realisticResult()
    result.metrics[0].unit = ''
    expect(validateBenchmarkResult(result).join('\n')).toContain('metrics[0].unit')
  })

  it('rejects an empty gate detail', () => {
    const result = realisticResult()
    result.gates[0].detail = ''
    expect(validateBenchmarkResult(result).join('\n')).toContain('gates[0].detail')
  })

  describe('environment.command path-bearing misuse policy (audit F3)', () => {
    it('accepts a safe canonical command without path segments', () => {
      const result = realisticResult()
      result.environment.command = 'pnpm bench:main:native'
      expect(validateBenchmarkResult(result)).toEqual([])
    })

    it('accepts a plain canonical form with no paths', () => {
      const result = realisticResult()
      result.environment.command = 'vitest bench --run --project main-native'
      expect(validateBenchmarkResult(result)).toEqual([])
    })

    it('rejects an absolute POSIX command path', () => {
      const result = realisticResult()
      result.environment.command = '/usr/local/bin/vitest bench --run --project main-native'
      expect(validateBenchmarkResult(result).join('\n')).toContain('environment.command')
    })

    it('rejects a relative path-bearing command', () => {
      const result = realisticResult()
      result.environment.command = './node_modules/.bin/vitest bench'
      expect(validateBenchmarkResult(result).join('\n')).toContain('environment.command')
    })

    it('rejects a Windows drive-path command', () => {
      const result = realisticResult()
      result.environment.command = 'C:\\tools\\vitest bench'
      expect(validateBenchmarkResult(result).join('\n')).toContain('environment.command')
    })
  })
})

describe('resolveResultsDir', () => {
  const originalEnvDir = process.env.BENCH_RESULTS_DIR

  afterEach(() => {
    if (originalEnvDir === undefined) {
      delete process.env.BENCH_RESULTS_DIR
    } else {
      process.env.BENCH_RESULTS_DIR = originalEnvDir
    }
  })

  it('defaults to <cwd>/test-results/bench-results', () => {
    expect(resolveResultsDir()).toBe(path.join(process.cwd(), 'test-results', 'bench-results'))
  })

  it('honors the BENCH_RESULTS_DIR env var', () => {
    process.env.BENCH_RESULTS_DIR = '/tmp/bench-out'
    expect(resolveResultsDir()).toBe('/tmp/bench-out')
  })

  it('prefers an explicit dir over the env var', () => {
    process.env.BENCH_RESULTS_DIR = '/tmp/env-out'
    expect(resolveResultsDir('/tmp/explicit-out')).toBe('/tmp/explicit-out')
  })
})

describe('writeBenchmarkResult', () => {
  let tempDir: string

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-result-test-'))
  })

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('writes a pretty-printed JSON artifact that round-trips exactly', () => {
    const result = realisticResult()
    const filePath = writeBenchmarkResult(result, { dir: tempDir, fileName: 'chatdb-search-10k-20260813-090000.json' })
    expect(filePath).toBe(path.join(tempDir, 'chatdb-search-10k-20260813-090000.json'))

    const raw = fs.readFileSync(filePath, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(JSON.parse(raw)).toEqual(result)
  })

  it('uses the default `<id>-<timestamp>.json` file name when none is given', () => {
    const filePath = writeBenchmarkResult(realisticResult(), { dir: tempDir })
    const fileName = path.basename(filePath)
    expect(fileName).toMatch(/^chatdb-search-10k-\d{8}-\d{6}\.\d{3}\.json$/)
    expect(fs.existsSync(filePath)).toBe(true)
  })

  it('never silently overwrites an existing auto-generated artifact (audit F4)', () => {
    const fixed = new Date(2026, 7, 13, 9, 8, 7, 42)
    const first = writeBenchmarkResult(realisticResult(), { dir: tempDir, date: fixed })
    const second = writeBenchmarkResult(realisticResult(), { dir: tempDir, date: fixed })
    expect(path.basename(first)).toBe('chatdb-search-10k-20260813-090807.042.json')
    expect(path.basename(second)).toBe('chatdb-search-10k-20260813-090807.042-1.json')
    expect(fs.existsSync(first)).toBe(true)
    expect(fs.existsSync(second)).toBe(true)
    expect(JSON.parse(fs.readFileSync(first, 'utf8'))).toEqual(realisticResult())
    expect(JSON.parse(fs.readFileSync(second, 'utf8'))).toEqual(realisticResult())
  })

  it('uses an explicit file name exactly as given, even on collision', () => {
    const fileName = 'explicit-name.json'
    const first = writeBenchmarkResult(realisticResult(), { dir: tempDir, fileName })
    const second = writeBenchmarkResult(realisticResult(), { dir: tempDir, fileName })
    expect(path.basename(first)).toBe(fileName)
    expect(path.basename(second)).toBe(fileName)
  })

  it('creates nested output directories', () => {
    const nested = path.join(tempDir, 'nested', 'deeper')
    const filePath = writeBenchmarkResult(realisticResult(), { dir: nested, fileName: 'a.json' })
    expect(fs.existsSync(filePath)).toBe(true)
  })

  it('throws on schema validation failure and writes nothing', () => {
    const result = realisticResult()
    result.metrics[0].value = Number.NaN
    expect(() => writeBenchmarkResult(result, { dir: tempDir, fileName: 'should-not-exist.json' })).toThrow(/schema v1/)
    expect(fs.existsSync(path.join(tempDir, 'should-not-exist.json'))).toBe(false)
  })

  it('throws on a path-bearing command and writes nothing', () => {
    const result = realisticResult()
    result.environment.command = '/tmp/vitest bench --run --project main-native'
    expect(() => writeBenchmarkResult(result, { dir: tempDir, fileName: 'path-command.json' })).toThrow(
      /environment\.command/
    )
    expect(fs.existsSync(path.join(tempDir, 'path-command.json'))).toBe(false)
  })

  it('never serializes sensitive or raw-data fields', () => {
    const filePath = writeBenchmarkResult(realisticResult(), { dir: tempDir, fileName: 'closed-schema.json' })
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>
    const raw = fs.readFileSync(filePath, 'utf8')

    expect(Object.keys(parsed).sort()).toEqual(['benchmark', 'environment', 'gates', 'metrics', 'schemaVersion'])

    const leafKeys = collectLeafKeys(parsed)
    for (const sensitive of SENSITIVE_KEYS) {
      expect(leafKeys).not.toContain(sensitive)
    }

    // Raw message content and machine-local paths must not leak into artifacts.
    expect(raw).not.toContain('Benchmark message content')
    expect(raw).not.toContain('Lorem ipsum')
    expect(raw).not.toContain(tempDir)
    expect(raw).not.toContain(process.cwd())
  })
})

// ---------------------------------------------------------------------------
// Vitest bench lifecycle gate (audit F1) — artifact only after successful
// benchmark tasks. This is the completion-order integration structure the two
// bench files rely on: a file-level `afterAll` hook passes the suite here, and
// emission is suppressed unless every registered leaf task reached 'pass'.
// ---------------------------------------------------------------------------

describe('allBenchTasksCompletedSuccessfully', () => {
  const passingLeaf = { type: 'test', result: { state: 'pass' } }
  const runStuckLeaf = { type: 'test', result: { state: 'run' } }

  it('returns true when every registered leaf task passed', () => {
    expect(allBenchTasksCompletedSuccessfully({ tasks: [passingLeaf, passingLeaf] })).toBe(true)
  })

  it('returns false when a leaf task is stuck at run (silently swallowed failure)', () => {
    expect(allBenchTasksCompletedSuccessfully({ tasks: [passingLeaf, runStuckLeaf] })).toBe(false)
  })

  it('returns false when a leaf task explicitly failed', () => {
    expect(allBenchTasksCompletedSuccessfully({ tasks: [{ type: 'test', result: { state: 'fail' } }] })).toBe(false)
  })

  it('returns false when a leaf task has no result (skipped/never ran)', () => {
    expect(allBenchTasksCompletedSuccessfully({ tasks: [{ type: 'test' }] })).toBe(false)
  })

  it('recurses into nested suites', () => {
    const nestedWithFailure = { type: 'suite', tasks: [passingLeaf, { type: 'suite', tasks: [runStuckLeaf] }] }
    expect(allBenchTasksCompletedSuccessfully({ tasks: [passingLeaf, nestedWithFailure] })).toBe(false)
    const allPassing = { type: 'suite', tasks: [passingLeaf, passingLeaf] }
    expect(allBenchTasksCompletedSuccessfully({ tasks: [allPassing] })).toBe(true)
  })

  it('returns false for an empty suite (nothing to gate on)', () => {
    expect(allBenchTasksCompletedSuccessfully({ tasks: [] })).toBe(false)
  })
})

describe('emitBenchmarkResultAfterSuccessfulTasks', () => {
  let tempDir: string

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-gate-test-'))
  })

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('writes the artifact when every registered task completed successfully', () => {
    const suite = { tasks: [{ type: 'test', result: { state: 'pass' } }] }
    const filePath = emitBenchmarkResultAfterSuccessfulTasks(suite, realisticResult(), {
      dir: tempDir,
      fileName: 'gate-ok.json'
    })
    expect(filePath).toBe(path.join(tempDir, 'gate-ok.json'))
    if (filePath === null) {
      throw new Error('expected an artifact path when all tasks passed')
    }
    expect(fs.existsSync(filePath)).toBe(true)
  })

  it('writes nothing when any registered task did not complete successfully', () => {
    const suite = { tasks: [{ type: 'test', result: { state: 'run' } }] }
    const filePath = emitBenchmarkResultAfterSuccessfulTasks(suite, realisticResult(), {
      dir: tempDir,
      fileName: 'gate-blocked.json'
    })
    expect(filePath).toBeNull()
    expect(fs.existsSync(path.join(tempDir, 'gate-blocked.json'))).toBe(false)
  })

  it('writes nothing for an empty suite', () => {
    const filePath = emitBenchmarkResultAfterSuccessfulTasks({ tasks: [] }, realisticResult(), {
      dir: tempDir,
      fileName: 'gate-empty.json'
    })
    expect(filePath).toBeNull()
    expect(fs.existsSync(path.join(tempDir, 'gate-empty.json'))).toBe(false)
  })
})
