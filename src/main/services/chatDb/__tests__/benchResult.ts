/**
 * PERF-001 machine-readable benchmark result contract (schema v1).
 *
 * Small, repository-native JSON summary artifacts emitted by the Vitest
 * benchmark suites (`search.bench.ts`, `sqlite-runtime.perf.bench.ts`) at the
 * end of a complete run. The schema is closed: it carries benchmark identity
 * and scale, reproducibility metadata (command, timestamp, Node and pnpm
 * versions, ABI lane, git commit + worktree-dirty state), metric values, and
 * correctness/threshold gate outcomes — and nothing else. No message content,
 * credentials, user paths, attachment content, raw database sizes, or profile
 * data can be represented (PERF-LOCK-006/007).
 *
 * Emission contract (audit F1): artifacts are written only after every
 * registered tinybench task completed successfully. The bench files wire the
 * write into a file-level Vitest `afterAll` hook via
 * `emitBenchmarkResultAfterSuccessfulTasks` — Vitest bench mode runs
 * file-level hooks but not describe-level hooks, and a throwing benchmark
 * task is silently swallowed (the run can exit 0 with the task stuck at
 * state `'run'`), so the gate is the only thing that keeps "artifact exists"
 * synonymous with "the complete benchmark task run finished".
 *
 * Reproducibility truthfulness (audit F2/F3): the pnpm version is parsed
 * only from a genuine `pnpm/` package-manager user agent — an npm/yarn/other
 * version is never labeled as pnpm. The canonical `command` is an explicit
 * safe canonical command (e.g. `pnpm bench:main:native`) required from every
 * caller; it is never derived from the process argv, and path-bearing command
 * strings are rejected at validation time so machine-local paths cannot leak
 * into artifacts.
 *
 * Storage policy: artifacts are written to a gitignored repository-local
 * directory (`test-results/bench-results/` by default, matching the existing
 * `test-results/` artifact convention used by Playwright and `ui:observe`),
 * overridable via the `BENCH_RESULTS_DIR` environment variable. Default file
 * names carry millisecond precision and never silently overwrite an existing
 * artifact (audit F4). Large or raw data is never written here and never
 * committed.
 *
 * This file is intentionally NOT a *.test.ts / *.bench.ts file so it is never
 * collected by Vitest as a test or benchmark.
 */

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

/** PERF-001 result artifact schema version. Bump only with the documented contract (docs/performance-measurement.md §3). */
export const BENCH_RESULT_SCHEMA_VERSION = 1 as const

/** Default gitignored repository-local artifact directory (relative to the run cwd). */
export const DEFAULT_BENCH_RESULTS_DIR = 'test-results/bench-results'

/** Env var that overrides the artifact output directory (mirrors UI_OBSERVE_OUTPUT_DIR style). */
export const BENCH_RESULTS_DIR_ENV = 'BENCH_RESULTS_DIR'

export interface BenchmarkGate {
  id: string
  name: string
  kind: 'correctness' | 'threshold'
  passed: boolean
  detail?: string
}

export interface BenchmarkMetric {
  id: string
  name: string
  value: number
  unit?: string
}

export interface BenchmarkEnvironment {
  /** ISO-8601 run timestamp (UTC). */
  timestamp: string
  /** Node runtime version, e.g. `v24.11.1`. */
  node: string
  /**
   * pnpm version, e.g. `10.27.0`. Parsed ONLY from a genuine `pnpm/`
   * package-manager user agent; `'unknown'` for any other package manager
   * (npm/yarn/bun/...) or an absent UA — a non-pnpm version is never labeled
   * as pnpm (audit F2).
   */
  pnpm: string
  /** ABI lane the benchmark ran under. */
  abiLane: 'node' | 'electron'
  /** Runtime ABI version (`process.versions.modules`), e.g. `137` (Node) / `145` (Electron). */
  abi: string
  /**
   * Explicit safe canonical command that produced the run (e.g.
   * `pnpm bench:main:native`). Never derived from the process argv; must not
   * contain path segments (audit F3).
   */
  command: string
  git: {
    /** Full HEAD commit SHA; empty string when git metadata is unavailable. */
    commit: string
    /** True when the worktree has uncommitted changes at run time. */
    dirty: boolean
  }
}

export interface BenchmarkResult {
  schemaVersion: typeof BENCH_RESULT_SCHEMA_VERSION
  benchmark: {
    /** Stable artifact/baseline identity — used in the artifact file name. */
    id: string
    name: string
    /** Deterministic benchmark scale (corpus counts, rounds, batch sizes, ...). */
    scale: Record<string, number>
  }
  environment: BenchmarkEnvironment
  metrics: BenchmarkMetric[]
  gates: BenchmarkGate[]
}

/**
 * `YYYYMMDD-HHmmss.SSS` local timestamp for artifact file names (ASCII,
 * sortable, millisecond precision). Milliseconds keep same-second runs
 * distinct (audit F4); `writeBenchmarkResult` additionally appends a numeric
 * suffix when the exact file already exists so artifacts never silently
 * overwrite each other.
 */
export function formatTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    `.${String(date.getMilliseconds()).padStart(3, '0')}`
  )
}

/** Default artifact file name: `<benchmark.id>-<YYYYMMDD-HHmmss.SSS>.json`. */
export function defaultResultFileName(result: BenchmarkResult, date: Date = new Date()): string {
  return `${result.benchmark.id}-${formatTimestamp(date)}.json`
}

export type GitCommandRunner = (args: string[]) => string

/** Default runner executes `git <args>` in the current working directory. */
export const defaultGitRunner: GitCommandRunner = (args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

/**
 * Read HEAD commit + worktree-dirty state.
 *
 * When git is unavailable, returns `{ commit: '', dirty: false }`; an empty
 * commit means "git metadata unavailable" and `dirty` is only meaningful when
 * the commit is non-empty.
 */
export function collectGitMetadata(runner: GitCommandRunner = defaultGitRunner): BenchmarkEnvironment['git'] {
  try {
    const commit = runner(['rev-parse', 'HEAD'])
    const porcelain = runner(['status', '--porcelain'])
    return { commit, dirty: porcelain.length > 0 }
  } catch {
    return { commit: '', dirty: false }
  }
}

/**
 * Extract the pnpm version from `npm_config_user_agent` — and ONLY when the
 * user agent genuinely identifies pnpm as its first token (`pnpm/<version>`),
 * e.g. `pnpm/10.27.0 npm/? node/v24.11.1 darwin arm64` → `10.27.0`. Any other
 * package-manager UA (npm, yarn, bun, ...) or an absent/empty user agent
 * returns `'unknown'`: an npm (or other) version must never be labeled as the
 * pnpm version (audit F2).
 */
export function extractPackageManagerVersion(userAgent: string | undefined): string {
  if (userAgent === undefined || userAgent.length === 0) return 'unknown'
  const token = userAgent.trim().split(/\s+/)[0]
  if (token === undefined || token.length === 0 || !token.startsWith('pnpm/')) return 'unknown'
  const version = token.slice('pnpm/'.length)
  return version.length > 0 ? version : 'unknown'
}

export interface CollectEnvironmentOptions {
  /**
   * Explicit safe canonical command that produced the benchmark run (e.g.
   * `pnpm bench:main:native`). REQUIRED — never derived from the process
   * argv, so argv paths cannot leak into artifacts (audit F3).
   */
  command: string
  /** Pre-collected git metadata (test seam); defaults to `collectGitMetadata()`. */
  git?: BenchmarkEnvironment['git']
}

/** Collect the reproducibility metadata block from the running process. */
export function collectEnvironmentMetadata(options: CollectEnvironmentOptions): BenchmarkEnvironment {
  const command = options.command.trim()
  if (command.length === 0) {
    throw new Error(
      'collectEnvironmentMetadata: an explicit non-empty canonical command is required (never derived from argv)'
    )
  }
  return {
    timestamp: new Date().toISOString(),
    node: process.version,
    pnpm: extractPackageManagerVersion(process.env.npm_config_user_agent),
    abiLane: process.versions.electron === undefined ? 'node' : 'electron',
    abi: String(process.versions.modules),
    command,
    git: options.git ?? collectGitMetadata()
  }
}

// ---------------------------------------------------------------------------
// Schema validation — closed set, rejects unknown fields and bad types
// ---------------------------------------------------------------------------

const RESULT_KEYS = ['schemaVersion', 'benchmark', 'environment', 'metrics', 'gates'] as const
const BENCHMARK_KEYS = ['id', 'name', 'scale'] as const
const ENVIRONMENT_KEYS = ['timestamp', 'node', 'pnpm', 'abiLane', 'abi', 'command', 'git'] as const
const GIT_KEYS = ['commit', 'dirty'] as const
const METRIC_KEYS = ['id', 'name', 'value', 'unit'] as const
const GATE_KEYS = ['id', 'name', 'kind', 'passed', 'detail'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  const allowedSet = new Set(allowed)
  return Object.keys(value).filter((key) => !allowedSet.has(key))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value)
}

/** `new Date().toISOString()` shape: `YYYY-MM-DDTHH:mm:ss.sssZ` (UTC). */
const ISO_8601_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * Path-bearing command detector: any `/` or `\` in the canonical command is
 * rejected. Safe canonical commands (`pnpm bench:main:native`, `vitest bench
 * --run --project main-native`) contain no path segments, while argv-derived
 * or ad-hoc commands typically embed absolute/relative paths that must never
 * leak into artifacts (audit F3).
 */
const PATH_BEARING_COMMAND_PATTERN = /[\\/]/

/**
 * Validate an unknown value against the PERF-001 schema v1 contract.
 * Returns a list of human-readable problems (empty list = valid).
 */
export function validateBenchmarkResult(value: unknown): string[] {
  const problems: string[] = []
  const at = (p: string): string => `result.${p}`

  if (!isRecord(value)) return ['result must be a JSON object']

  if (value.schemaVersion !== BENCH_RESULT_SCHEMA_VERSION) {
    problems.push(`${at('schemaVersion')} must be exactly ${BENCH_RESULT_SCHEMA_VERSION}`)
  }
  for (const key of unknownKeys(value, RESULT_KEYS)) {
    problems.push(`${at(key)} is not a permitted field (schema is closed)`)
  }

  if (!isRecord(value.benchmark)) {
    problems.push(`${at('benchmark')} must be an object`)
  } else {
    const benchmark = value.benchmark
    for (const key of unknownKeys(benchmark, BENCHMARK_KEYS)) {
      problems.push(`${at(`benchmark.${key}`)} is not a permitted field (schema is closed)`)
    }
    if (!isNonEmptyString(benchmark.id)) {
      problems.push(`${at('benchmark.id')} must be a non-empty string`)
    }
    if (!isNonEmptyString(benchmark.name)) {
      problems.push(`${at('benchmark.name')} must be a non-empty string`)
    }
    if (!isRecord(benchmark.scale)) {
      problems.push(`${at('benchmark.scale')} must be an object`)
    } else {
      for (const [scaleKey, scaleValue] of Object.entries(benchmark.scale)) {
        if (!isFiniteNumber(scaleValue)) {
          problems.push(`${at(`benchmark.scale.${scaleKey}`)} must be a finite number`)
        }
      }
    }
  }

  if (!isRecord(value.environment)) {
    problems.push(`${at('environment')} must be an object`)
  } else {
    const environment = value.environment
    for (const key of unknownKeys(environment, ENVIRONMENT_KEYS)) {
      problems.push(`${at(`environment.${key}`)} is not a permitted field (schema is closed)`)
    }
    if (!isNonEmptyString(environment.timestamp)) {
      problems.push(`${at('environment.timestamp')} must be a non-empty string`)
    } else if (!ISO_8601_UTC_PATTERN.test(environment.timestamp)) {
      problems.push(`${at('environment.timestamp')} must be an ISO-8601 UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)`)
    }
    if (!isNonEmptyString(environment.node)) {
      problems.push(`${at('environment.node')} must be a non-empty string`)
    }
    if (!isNonEmptyString(environment.pnpm)) {
      problems.push(`${at('environment.pnpm')} must be a non-empty string`)
    }
    if (environment.abiLane !== 'node' && environment.abiLane !== 'electron') {
      problems.push(`${at('environment.abiLane')} must be 'node' or 'electron'`)
    }
    if (!isNonEmptyString(environment.abi)) {
      problems.push(`${at('environment.abi')} must be a non-empty string`)
    }
    if (!isNonEmptyString(environment.command)) {
      problems.push(`${at('environment.command')} must be a non-empty string`)
    } else if (PATH_BEARING_COMMAND_PATTERN.test(environment.command)) {
      problems.push(
        `${at('environment.command')} must be a safe canonical command without path segments (no argv/absolute paths)`
      )
    }
    if (!isRecord(environment.git)) {
      problems.push(`${at('environment.git')} must be an object`)
    } else {
      const git = environment.git
      for (const key of unknownKeys(git, GIT_KEYS)) {
        problems.push(`${at(`environment.git.${key}`)} is not a permitted field (schema is closed)`)
      }
      if (typeof git.commit !== 'string') {
        problems.push(`${at('environment.git.commit')} must be a string`)
      }
      if (typeof git.dirty !== 'boolean') {
        problems.push(`${at('environment.git.dirty')} must be a boolean`)
      }
    }
  }

  if (!Array.isArray(value.metrics) || value.metrics.length === 0) {
    problems.push(`${at('metrics')} must be a non-empty array`)
  } else {
    value.metrics.forEach((metric, index) => {
      const atMetric = at(`metrics[${index}]`)
      if (!isRecord(metric)) {
        problems.push(`${atMetric} must be an object`)
        return
      }
      for (const key of unknownKeys(metric, METRIC_KEYS)) {
        problems.push(`${atMetric}.${key} is not a permitted field (schema is closed)`)
      }
      if (!isNonEmptyString(metric.id)) problems.push(`${atMetric}.id must be a non-empty string`)
      if (!isNonEmptyString(metric.name)) problems.push(`${atMetric}.name must be a non-empty string`)
      if (!isFiniteNumber(metric.value)) problems.push(`${atMetric}.value must be a finite number`)
      if (metric.unit !== undefined) {
        if (typeof metric.unit !== 'string' || metric.unit.length === 0) {
          problems.push(`${atMetric}.unit must be a non-empty string when present`)
        }
      }
    })
  }

  if (!Array.isArray(value.gates) || value.gates.length === 0) {
    problems.push(`${at('gates')} must be a non-empty array`)
  } else {
    value.gates.forEach((gate, index) => {
      const atGate = at(`gates[${index}]`)
      if (!isRecord(gate)) {
        problems.push(`${atGate} must be an object`)
        return
      }
      for (const key of unknownKeys(gate, GATE_KEYS)) {
        problems.push(`${atGate}.${key} is not a permitted field (schema is closed)`)
      }
      if (!isNonEmptyString(gate.id)) problems.push(`${atGate}.id must be a non-empty string`)
      if (!isNonEmptyString(gate.name)) problems.push(`${atGate}.name must be a non-empty string`)
      if (gate.kind !== 'correctness' && gate.kind !== 'threshold') {
        problems.push(`${atGate}.kind must be 'correctness' or 'threshold'`)
      }
      if (typeof gate.passed !== 'boolean') problems.push(`${atGate}.passed must be a boolean`)
      if (gate.detail !== undefined) {
        if (typeof gate.detail !== 'string' || gate.detail.length === 0) {
          problems.push(`${atGate}.detail must be a non-empty string when present`)
        }
      }
    })
  }

  return problems
}

// ---------------------------------------------------------------------------
// Output path resolution + writer
// ---------------------------------------------------------------------------

export interface WriteBenchmarkResultOptions {
  /** Output directory; overrides the env-var and default resolution. */
  dir?: string
  /**
   * Exact file name, used as given (a repeated run with the same explicit
   * name may overwrite the prior artifact — the auto-generated default never
   * overwrites). Defaults to `defaultResultFileName(result)`.
   */
  fileName?: string
  /**
   * Timestamp used for the auto-generated default file name (test seam for
   * deterministic naming and collision behavior). Defaults to `new Date()`.
   */
  date?: Date
}

/**
 * Resolve the artifact output directory: explicit option > `BENCH_RESULTS_DIR`
 * env var > `<cwd>/test-results/bench-results/` (gitignored repository-local).
 */
export function resolveResultsDir(explicitDir?: string): string {
  if (explicitDir !== undefined && explicitDir.length > 0) return path.resolve(explicitDir)
  const envDir = process.env[BENCH_RESULTS_DIR_ENV]
  if (envDir !== undefined && envDir.length > 0) return path.resolve(envDir)
  return path.resolve(process.cwd(), DEFAULT_BENCH_RESULTS_DIR)
}

/**
 * Return `filePath` unchanged when it does not exist; otherwise append a
 * numeric suffix (`-1`, `-2`, ...) before the extension until a free name is
 * found, so an auto-generated artifact never silently overwrites an existing
 * one (audit F4).
 */
export function uniqueArtifactPath(filePath: string): string {
  if (!fs.existsSync(filePath)) return filePath
  const extension = path.extname(filePath)
  const stem = filePath.slice(0, -extension.length)
  for (let suffix = 1; ; suffix++) {
    const candidate = `${stem}-${suffix}${extension}`
    if (!fs.existsSync(candidate)) return candidate
  }
}

/**
 * Validate and write a benchmark result artifact (pretty-printed JSON, one
 * trailing newline). Returns the absolute path of the written file. Throws
 * when the result fails schema validation or the file cannot be written —
 * a degenerate metric or an unrepresentable field must fail loudly.
 */
export function writeBenchmarkResult(result: BenchmarkResult, options: WriteBenchmarkResultOptions = {}): string {
  const problems = validateBenchmarkResult(result)
  if (problems.length > 0) {
    throw new Error(`Benchmark result rejected by schema v${BENCH_RESULT_SCHEMA_VERSION}:\n- ${problems.join('\n- ')}`)
  }
  const dir = resolveResultsDir(options.dir)
  fs.mkdirSync(dir, { recursive: true })
  let filePath: string
  if (options.fileName !== undefined && options.fileName.length > 0) {
    filePath = path.join(dir, options.fileName)
  } else {
    filePath = uniqueArtifactPath(path.join(dir, defaultResultFileName(result, options.date)))
  }
  fs.writeFileSync(filePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  return filePath
}

// ---------------------------------------------------------------------------
// Vitest bench lifecycle gate — artifact only after successful bench tasks
// ---------------------------------------------------------------------------

/**
 * Minimal structural view of a Vitest task tree (suite or leaf task) as seen
 * from a file-level `afterAll` hook in bench mode. Only the fields the
 * completion gate reads are declared; vitest's `Readonly<Suite | File>` is
 * structurally assignable to this.
 */
export interface BenchResultTaskLike {
  /** Vitest task kind: `test` / `suite` / `custom` (bench tasks are `test` with `meta.benchmark`). */
  type?: string
  /** Post-run result; `state` is `'pass'` only after a successful run. */
  result?: { state?: string }
  /** Child tasks for suite-like tasks. */
  tasks?: readonly BenchResultTaskLike[]
}

/** Minimal structural view of the file/suite passed to a file-level `afterAll` hook. */
export interface BenchResultSuiteLike {
  tasks: readonly BenchResultTaskLike[]
}

function collectBenchLeafTasks(tasks: readonly BenchResultTaskLike[]): BenchResultTaskLike[] {
  const leaves: BenchResultTaskLike[] = []
  for (const task of tasks) {
    if (task.type === 'suite' && Array.isArray(task.tasks)) {
      leaves.push(...collectBenchLeafTasks(task.tasks))
    } else {
      leaves.push(task)
    }
  }
  return leaves
}

/**
 * True when the suite registered at least one benchmark task and every leaf
 * task completed with state `'pass'`. Vitest 3.2.4 bench mode silently
 * swallows throwing benchmark tasks (the run can exit 0 with the failed task
 * stuck at state `'run'`), so an artifact must never be emitted from a suite
 * where any leaf is not `'pass'` (audit F1).
 */
export function allBenchTasksCompletedSuccessfully(suite: BenchResultSuiteLike): boolean {
  const leaves = collectBenchLeafTasks(suite.tasks)
  return leaves.length > 0 && leaves.every((task) => task.result?.state === 'pass')
}

/**
 * True when every gate in the result passed. An empty gate set is treated as
 * not passing so a missing gate set cannot silently enable emission.
 */
export function allGatesPassed(result: BenchmarkResult): boolean {
  return result.gates.length > 0 && result.gates.every((gate) => gate.passed)
}

/**
 * True when both the Vitest bench-task gate and the calibration-gate set
 * passed. Used as the eligibility predicate for fail-closed artifact
 * emission — a single failing correctness gate must prevent artifact creation.
 */
export function shouldEmitBenchmarkResult(suite: BenchResultSuiteLike, result: BenchmarkResult): boolean {
  return allBenchTasksCompletedSuccessfully(suite) && allGatesPassed(result)
}

/**
 * Emit the result artifact only when every registered benchmark task in the
 * suite completed successfully. Wire this into a file-level Vitest `afterAll`
 * hook (describe-level hooks do not run in bench mode) so the artifact is
 * written strictly after the benchmark tasks finished and only on success.
 * Returns the artifact path, or null when the gate failed and nothing was
 * written.
 */
export function emitBenchmarkResultAfterSuccessfulTasks(
  suite: BenchResultSuiteLike,
  result: BenchmarkResult,
  options: WriteBenchmarkResultOptions = {}
): string | null {
  if (!allBenchTasksCompletedSuccessfully(suite)) {
    return null
  }
  return writeBenchmarkResult(result, options)
}

/**
 * Emit the result artifact only when every registered benchmark task completed
 * successfully AND every calibration gate in the result passed. This is the
 * fail-closed path for calibration harnesses: a failed gate must not produce
 * an artifact even when tasks completed. Returns null when either gate fails.
 */
export function emitBenchmarkResultAfterSuccessfulTasksAndGates(
  suite: BenchResultSuiteLike,
  result: BenchmarkResult,
  options: WriteBenchmarkResultOptions = {}
): string | null {
  if (!shouldEmitBenchmarkResult(suite, result)) {
    return null
  }
  return writeBenchmarkResult(result, options)
}
