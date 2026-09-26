import { globSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Deterministic renderer test lane planner.
 *
 * The renderer suite keeps its exact Vitest test set (the renderer glob in
 * RENDERER_TEST_GLOB) and all existing Vitest semantics (project renderer,
 * root caps maxThreads=2 / maxForks=1, Shiki poolMatchGlobs fork isolation).
 * Local runs only change how the set is invoked: N bounded normal
 * explicit-file shards plus one dedicated Shiki invocation, each as a
 * canonical same-lane child (pnpm native:run node -- vitest run).
 *
 * CI keeps the single full invocation with no explicit file partition.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const RENDERER_TEST_GLOB = 'src/renderer/**/*.{test,spec}.{ts,tsx}'

/** Renderer file that must run alone to keep its forks isolation. */
export const SHIKI_FILE = 'src/renderer/src/services/__tests__/ShikiStreamTokenizer.test.ts'

/** Upper bound for normal shards; Vitest worker caps are never raised. */
export const MAX_NORMAL_SHARDS = 3

/** Threads retained per normal Vitest process (vitest.config.ts root cap). */
export const NORMAL_THREADS_PER_PROCESS = 2

/** Forks retained by the dedicated Shiki process (root cap). */
export const SHIKI_FORKS = 1

export type RendererMode = 'local' | 'ci'

export interface SplitRendererFiles {
  shiki: string
  normal: string[]
}

export interface RendererInvocation {
  kind: 'normal' | 'shiki' | 'full'
  label: string
  files: string[]
}

export interface RendererPlan {
  mode: RendererMode
  invocations: RendererInvocation[]
  totalFiles: number
  normalFiles: number
}

/**
 * Repository CI convention: any truthy `CI` env value enables CI mode, except
 * the explicit falsy spellings `''`, `'0'`, and `'false'` (case-insensitive).
 * Matches GitHub (`CI: true` -> `'true'`) and the `playwright.config.ts`
 * truthy use while staying fail-safe for local shells where `CI` is unset.
 */
export function isCI(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CI
  if (raw === undefined || raw === null) {
    return false
  }
  if (typeof raw !== 'string') {
    return Boolean(raw)
  }
  const normalized = raw.trim().toLowerCase()
  if (normalized === '' || normalized === '0' || normalized === 'false') {
    return false
  }
  return true
}

/** Enumerate exactly the renderer Vitest test set, normalized and sorted. */
export function enumerateRendererTestFiles(
  glob: (pattern: string, options: { cwd: string }) => string[] = globSync,
  cwd: string = REPO_ROOT
): string[] {
  return glob(RENDERER_TEST_GLOB, { cwd })
    .map((file) => file.split(sep).join('/'))
    .sort()
}

/**
 * Split the enumerated set into the dedicated Shiki file plus normal files.
 * Fail-closed: empty enumeration or a missing Shiki file throws.
 */
export function splitRendererFiles(allFiles: readonly string[]): SplitRendererFiles {
  if (allFiles.length === 0) {
    throw new Error('renderer enumeration is empty - refusing to run an empty suite')
  }
  if (!allFiles.includes(SHIKI_FILE)) {
    throw new Error(`required Shiki file absent from renderer enumeration: ${SHIKI_FILE}`)
  }
  const normal = allFiles.filter((file) => file !== SHIKI_FILE)
  return { shiki: SHIKI_FILE, normal }
}

/**
 * Bounded normal shard count so the total theoretical workers never exceed
 * capacity: `normalShards * 2 + 1 (Shiki) <= cpus`, capped at 3, floored at 1.
 * Empty normal sets yield 0 shards; otherwise the count is also capped by the
 * file count so no empty shard is created.
 */
export function computeNormalShardCount(cpuCount: number, normalFileCount: number): number {
  if (normalFileCount === 0) {
    return 0
  }
  const effectiveCpu = Number.isFinite(cpuCount) && cpuCount > 0 ? Math.floor(cpuCount) : 1
  const bounded = Math.max(1, Math.min(MAX_NORMAL_SHARDS, Math.floor((effectiveCpu - 1) / NORMAL_THREADS_PER_PROCESS)))
  return Math.min(bounded, normalFileCount)
}

/**
 * Deterministic count-balanced round-robin partition over the sorted normal
 * set. The union of shards equals the input with no gaps and no overlap;
 * shard sizes differ by at most one.
 */
export function partitionNormalFiles(normalFilesSorted: readonly string[], shardCount: number): string[][] {
  if (shardCount <= 0) {
    return []
  }
  const shards: string[][] = Array.from({ length: shardCount }, () => [])
  normalFilesSorted.forEach((file, index) => {
    shards[index % shardCount].push(file)
  })
  return shards
}

/** Plan the renderer run: CI gets one full invocation, local gets N+1 shards. */
export function planRendererRun(options: {
  allFiles: readonly string[]
  cpuCount: number
  env?: NodeJS.ProcessEnv
}): RendererPlan {
  const env = options.env ?? process.env
  if (isCI(env)) {
    return {
      mode: 'ci',
      invocations: [{ kind: 'full', label: 'full', files: [] }],
      totalFiles: options.allFiles.length,
      normalFiles: Math.max(0, options.allFiles.length - 1)
    }
  }
  const sorted = [...options.allFiles].sort()
  const { shiki, normal } = splitRendererFiles(sorted)
  const shardCount = computeNormalShardCount(options.cpuCount, normal.length)
  const partitions = partitionNormalFiles(normal, shardCount)
  const invocations: RendererInvocation[] = partitions.map((files, index) => ({
    kind: 'normal',
    label: `normal-${index + 1}/${partitions.length}`,
    files
  }))
  invocations.push({ kind: 'shiki', label: 'shiki', files: [shiki] })
  return {
    mode: 'local',
    invocations,
    totalFiles: sorted.length,
    normalFiles: normal.length
  }
}

/**
 * Canonical same-lane child argv for one invocation. Every child executes as
 * argv with no shell through `pnpm native:run node -- vitest ...` so it
 * inherits the outer Node-lane lease as a nested run. `extraArgs` (e.g.
 * `--update`) are forwarded before the explicit file list; the CI full
 * invocation carries no files.
 */
export function buildChildArgv(invocation: RendererInvocation, extraArgs: readonly string[] = []): string[] {
  return ['native:run', 'node', '--', 'vitest', 'run', '--project', 'renderer', ...extraArgs, ...invocation.files]
}

/** The canonical child executable; always `pnpm`, never a shell string. */
export const CHILD_COMMAND = 'pnpm'
