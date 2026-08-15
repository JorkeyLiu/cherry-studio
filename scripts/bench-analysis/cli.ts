/**
 * Read-only schema-v1 benchmark artifact summary CLI.
 *
 * Reads every `*.json` artifact in a directory (default: the repository
 * benchmark results directory, using the same directory resolution as
 * artifact emission, including the `BENCH_RESULTS_DIR` override), validates
 * each against the closed schema-v1 contract, and prints a deterministic
 * machine-readable JSON summary of directional curve / run variance / knee
 * candidates. The consumer never writes files and never touches production
 * runtime or user data.
 *
 * Run without a package script (matching the repository's `tsx scripts/...`
 * convention):
 *   pnpm exec tsx scripts/bench-analysis/cli.ts --help
 *   pnpm exec tsx scripts/bench-analysis/cli.ts
 *   pnpm exec tsx scripts/bench-analysis/cli.ts --dir test-results/bench-results
 *
 * Exit codes:
 *   0  success (or an explicitly requested --help)
 *   1  directory unreadable or fatal analysis failure
 *   2  usage error (bad flags)
 */
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveResultsDir } from '../../src/main/services/chatDb/__tests__/benchResult'
import { type BenchSummaryReport, summarizeBenchmarkDirectory } from './benchSummary'

const EXIT_PASS = 0
const EXIT_FAIL = 1
const EXIT_USAGE = 2

const HELP_TEXT = `usage: tsx scripts/bench-analysis/cli.ts [options]

Reads schema-v1 benchmark result artifacts from a directory and prints a
deterministic machine-readable JSON summary of directional curve direction,
run variance, and knee candidates. Read-only: never writes files.

  --help                show this help (no analysis)
  --dir <dir>           artifact directory to analyze; used exactly as given
                        (default: BENCH_RESULTS_DIR env var, or
                        <cwd>/test-results/bench-results)

Output is directional L3 analysis only — no thresholds, no regression gate,
no promotion semantics.

exit codes:
  0  success (or --help)
  1  directory unreadable or fatal analysis failure
  2  usage error
`

export interface BenchSummaryCliDeps {
  /** Working directory used to resolve relative --dir values. Defaults to process.cwd(). */
  cwd?: string
  /**
   * Directory resolver; defaults to `--dir` (resolved against the cwd) or
   * `resolveResultsDir()` when absent. Injectable for deterministic tests.
   */
  resolveDir?: (explicitDir: string | undefined, cwd: string) => string
}

function defaultResolveDir(explicitDir: string | undefined, cwd: string): string {
  if (explicitDir !== undefined && explicitDir.length > 0) return path.resolve(cwd, explicitDir)
  return resolveResultsDir()
}

export type BenchSummaryCliResult = { code: number; report: ReturnType<typeof summarizeBenchmarkDirectory> | null }

export function benchSummaryCli(
  argv: readonly string[],
  io: { stdout: (text: string) => void; stderr: (text: string) => void },
  deps: BenchSummaryCliDeps = {}
): BenchSummaryCliResult {
  const cwd = deps.cwd ?? process.cwd()
  const resolveDir = deps.resolveDir ?? defaultResolveDir

  const args = argv.filter((arg) => arg !== '--')

  if (args.some((arg) => arg === '--help' || arg === '-h')) {
    if (args.length !== 1) {
      io.stderr(
        `[bench-summary] '${args.find((arg) => arg === '--help' || arg === '-h')}' cannot be combined with other arguments\n`
      )
      return { code: EXIT_USAGE, report: null }
    }
    io.stdout(HELP_TEXT)
    return { code: EXIT_PASS, report: null }
  }

  let explicitDir: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--dir') {
      const value = args[i + 1]
      if (value === undefined || value.length === 0 || value.startsWith('-')) {
        io.stderr("[bench-summary] '--dir' requires a directory path\n")
        return { code: EXIT_USAGE, report: null }
      }
      explicitDir = value
      i++
      continue
    }
    if (arg.startsWith('--dir=')) {
      const value = arg.slice('--dir='.length)
      if (value.length === 0 || value.startsWith('-')) {
        io.stderr("[bench-summary] '--dir' requires a directory path\n")
        return { code: EXIT_USAGE, report: null }
      }
      explicitDir = value
      continue
    }
    if (arg.startsWith('-')) {
      io.stderr(`[bench-summary] unknown option '${arg}'\n`)
      return { code: EXIT_USAGE, report: null }
    }
    io.stderr(`[bench-summary] unexpected positional argument '${arg}'\n`)
    return { code: EXIT_USAGE, report: null }
  }

  let dir: string
  try {
    dir = resolveDir(explicitDir, cwd)
  } catch (error) {
    io.stderr(`[bench-summary] ${error instanceof Error ? error.message : String(error)}\n`)
    return { code: EXIT_USAGE, report: null }
  }

  let report: BenchSummaryReport
  try {
    report = summarizeBenchmarkDirectory(dir)
  } catch (error) {
    io.stderr(`[bench-summary] failed to analyze '${dir}': ${error instanceof Error ? error.message : String(error)}\n`)
    return { code: EXIT_FAIL, report: null }
  }

  io.stdout(`${JSON.stringify(report, null, 2)}\n`)
  return { code: EXIT_PASS, report }
}

async function main(): Promise<void> {
  const result = benchSummaryCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text)
  })
  process.exitCode = result.code
}

const entry = process.argv[1]
if (entry != null && fileURLToPath(import.meta.url) === path.resolve(entry)) {
  main().catch((error) => {
    process.stderr.write(`[bench-summary] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = EXIT_FAIL
  })
}
