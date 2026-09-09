import { readFileSync } from 'node:fs'
import { globSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Deterministic main-process test lane manifests (LOCK-TEST-001..006).
 *
 * The main test suite is split into three mutually exclusive lanes so that
 * `pnpm test:main` never schedules all main tests through one unbounded
 * Vitest invocation:
 *
 * - `core`:   every main test that is neither heavy nor matched by the native
 *             predicate. Runs in the threads pool capped at 2 workers. Tests
 *             that mock node modules and restore them with `importActual` may
 *             stay here by design: they never load the better-sqlite3 binding,
 *             and the native predicate intentionally does not classify "every
 *             real-filesystem test" as native.
 * - `native`: direct better-sqlite3 importers, explicit unmock-style
 *             real-environment tests (`vi.unmock` / `vi.doUnmock`), and the
 *             legacy fork-pinned promotion files. Runs in the forks pool capped
 *             at 1 worker so the native binding is never loaded in a thread
 *             pool worker (LOCK-ABI-2).
 * - `heavy`:  exactly the three heavyweight suites (two 10k-message SQLite
 *             integration benchmarks and recoveryV2's 236,196-combination
 *             exhaustive sweep). Runs in a single bounded-memory fork process
 *             (LOCK-MEM-4).
 *
 * All path sets are resolved against this repository at config-load time, so
 * the manifests never depend on machine-local state.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const MAIN_TEST_GLOB = 'src/main/**/*.{test,spec}.{ts,tsx}'
export const MAIN_BENCH_GLOB = 'src/main/**/*.bench.{ts,tsx}'

/** Heavy lane — must contain exactly these three files. */
export const HEAVY_FILES: readonly string[] = [
  'src/main/services/chatDbImport/promotion/__tests__/recoveryV2.test.ts',
  'src/main/services/chatDbImport/__tests__/importBenchmark.integration.test.ts',
  'src/main/services/chatDbImport/verification/__tests__/verificationBenchmark.integration.test.ts'
]

/**
 * Files that were previously routed to the forks pool via the deprecated
 * `poolMatchGlobs` main routing. Retained as an explicit seed so the intent
 * is auditable; every entry is additionally matched by the direct
 * better-sqlite3 import or `vi.unmock`/`vi.doUnmock` predicate below.
 */
export const LEGACY_FORK_PINNED_FILES: readonly string[] = [
  'src/main/services/chatDbImport/promotion/__tests__/execution.test.ts',
  'src/main/services/chatDbImport/promotion/__tests__/recoveryExecutorV2.test.ts',
  'src/main/services/chatDbImport/promotion/__tests__/rollbackV2.test.ts',
  'src/main/services/chatDbImport/promotion/__tests__/rollback.test.ts',
  'src/main/services/chatDbImport/promotion/__tests__/artifactProbe.test.ts',
  'src/main/services/chatDbImport/promotion/__tests__/install.test.ts',
  'src/main/services/chatDbImport/promotion/__tests__/preparation.test.ts',
  'src/main/services/chatDbImport/promotion/__tests__/replacementVerifier.test.ts',
  'src/main/services/chatDbImport/promotion/__tests__/snapshot.test.ts'
]

const DIRECT_SQLITE_IMPORT_RE = /from\s+['"]better-sqlite3['"]|require\(\s*['"]better-sqlite3['"]\)/
const UNMOCK_RE = /\bvi\.(unmock|doUnmock)\(/

export interface MainLanes {
  core: string[]
  native: string[]
  heavy: string[]
}

export interface MainBenchLanes {
  core: string[]
  native: string[]
  heavy: string[]
}

function readFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8')
}

export function enumerateMainTestFiles(): string[] {
  return globSync(MAIN_TEST_GLOB, { cwd: REPO_ROOT })
    .map((file) => file.split(sep).join('/'))
    .sort()
}

export function enumerateMainBenchFiles(): string[] {
  return globSync(MAIN_BENCH_GLOB, { cwd: REPO_ROOT })
    .map((file) => file.split(sep).join('/'))
    .sort()
}

/** True when the file directly loads the better-sqlite3 native binding. */
export function directlyImportsBetterSqlite3(relativePath: string): boolean {
  return DIRECT_SQLITE_IMPORT_RE.test(readFile(relativePath))
}

/** True when the file restores real node modules via vi.unmock / vi.doUnmock (real-environment tests). */
export function unmocksRealNodeModules(relativePath: string): boolean {
  return UNMOCK_RE.test(readFile(relativePath))
}

/**
 * Classify every main test file into exactly one lane.
 *
 * Predicate order: heavy first (explicit set), then native, then core.
 * A file is native when it is in the legacy fork-pinned set, directly imports
 * better-sqlite3, or explicitly restores real node modules (`vi.unmock` /
 * `vi.doUnmock`). Pure-FS tests that only `vi.mock` + `importActual` node
 * modules are intentionally NOT classified native — they may stay in core.
 */
export function classifyMainTestFiles(): MainLanes {
  const heavy = [...HEAVY_FILES].sort()
  const heavySet = new Set(heavy)
  const native: string[] = []
  const core: string[] = []

  for (const relativePath of enumerateMainTestFiles()) {
    if (heavySet.has(relativePath)) {
      continue
    }
    if (
      LEGACY_FORK_PINNED_FILES.includes(relativePath) ||
      directlyImportsBetterSqlite3(relativePath) ||
      unmocksRealNodeModules(relativePath)
    ) {
      native.push(relativePath)
    } else {
      core.push(relativePath)
    }
  }

  return { core, native, heavy }
}

/** Classify main bench files with the same native/heavy predicate. */
export function classifyMainBenchFiles(): MainBenchLanes {
  const heavySet = new Set(HEAVY_FILES)
  const heavy: string[] = []
  const native: string[] = []
  const core: string[] = []

  for (const relativePath of enumerateMainBenchFiles()) {
    if (heavySet.has(relativePath)) {
      heavy.push(relativePath)
    } else if (
      LEGACY_FORK_PINNED_FILES.includes(relativePath) ||
      directlyImportsBetterSqlite3(relativePath) ||
      unmocksRealNodeModules(relativePath)
    ) {
      native.push(relativePath)
    } else {
      core.push(relativePath)
    }
  }

  return { core, native, heavy }
}
