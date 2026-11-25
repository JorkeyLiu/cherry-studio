import { readFileSync } from 'node:fs'
import { globSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Deterministic main-process test lane manifests.
 *
 * The main test suite is split into two mutually exclusive lanes so that
 * `pnpm test:main` never schedules all main tests through one unbounded
 * Vitest invocation:
 *
 * - `core`:   every main test not matched by the native predicate. Runs in the
 *             threads pool capped at 2 workers.
 * - `native`: direct better-sqlite3 importers and explicit unmock-style
 *             real-environment tests (`vi.unmock` / `vi.doUnmock`). Runs in
 *             the forks pool capped at 1 worker so the native binding is
 *             never loaded in a thread-pool worker.
 *
 * All path sets are resolved against this repository at config-load time, so
 * the manifests never depend on machine-local state.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const MAIN_TEST_GLOB = 'src/main/**/*.{test,spec}.{ts,tsx}'

const DIRECT_SQLITE_IMPORT_RE = /from\s+['"]better-sqlite3['"]|require\(\s*['"]better-sqlite3['"]\)/
const UNMOCK_RE = /\bvi\.(unmock|doUnmock)\(/

export interface MainLanes {
  core: string[]
  native: string[]
}

function readFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8')
}

export function enumerateMainTestFiles(): string[] {
  return globSync(MAIN_TEST_GLOB, { cwd: REPO_ROOT })
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
 * A file is native when it directly imports better-sqlite3 or explicitly
 * restores real node modules (`vi.unmock` / `vi.doUnmock`). Pure-FS tests that
 * only `vi.mock` + `importActual` node modules stay in core: they never load
 * the better-sqlite3 binding in a thread-pool worker.
 */
export function classifyMainTestFiles(): MainLanes {
  const native: string[] = []
  const core: string[] = []

  for (const relativePath of enumerateMainTestFiles()) {
    if (directlyImportsBetterSqlite3(relativePath) || unmocksRealNodeModules(relativePath)) {
      native.push(relativePath)
    } else {
      core.push(relativePath)
    }
  }

  return { core, native }
}
