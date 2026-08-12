/**
 * `pnpm ui:observe` — deterministic diagnostic UI observation entrypoint.
 *
 * Launches the built Cherry Chat app through the repository's Playwright
 * Electron runtime with a unique disposable profile, runs exactly ONE plain
 * async observation scenario, captures screenshots/text artifacts into a
 * unique output directory, and cleans up exactly what it owns (even on
 * scenario failure). This is DIAGNOSTIC evidence only — it never establishes
 * regression completion; only the repository Playwright E2E suite does.
 *
 * Exit codes:
 *   0  PASS (or an explicitly requested --help / --list)
 *   1  scenario / setup / cleanup failure (original nonzero exit preserved)
 *   2  usage error (bad flags, missing or unresolvable scenario)
 *
 * The package script wraps this entrypoint in the canonical Electron ABI lane:
 *   pnpm ui:observe  =  pnpm native:run electron -- pnpm ui:observe:run
 */
import { fileURLToPath } from 'node:url'

import * as path from 'path'

import { parseUiObserveArgs } from './args'
import { builtinScenarioEntries } from './builtin-scenarios'
import { normalizeScenarioExport, resolveScenario, sanitizeArtifactName } from './scenario'
import {
  DEFAULT_SCENARIO_TIMEOUT_MS,
  type ObservationRunResult,
  type ObservationSessionOptions,
  runObservationSession
} from './session'

const EXIT_PASS = 0
const EXIT_FAIL = 1
const EXIT_USAGE = 2

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Local `YYYYMMDD-HHmmss` timestamp for unique output directory names (ASCII). */
function formatTimestamp(date: Date): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

function resolveOutputDir(scenarioName: string, explicitDir?: string): string {
  if (explicitDir !== undefined) return path.resolve(explicitDir)
  const envBase = process.env.UI_OBSERVE_OUTPUT_DIR
  const base =
    envBase !== undefined && envBase.length > 0
      ? path.resolve(envBase)
      : path.join(process.cwd(), 'test-results', 'ui-observe')
  const stamp = formatTimestamp(new Date())
  const dirName = `${sanitizeArtifactName(scenarioName)}-${stamp}-${Math.random().toString(36).slice(2, 8)}`
  return path.join(base, dirName)
}

const HELP_TEXT = `usage: pnpm ui:observe <scenario> [options]

Runs one diagnostic UI observation scenario against a fresh disposable
Cherry Chat profile (Playwright Electron). Diagnostic evidence only —
never regression proof.

  pnpm ui:observe --help                 show this help (no app launch)
  pnpm ui:observe --list                 list built-in scenarios (no app launch)
  pnpm ui:observe app-ready              run the built-in 'app-ready' scenario
  pnpm ui:observe ./scenarios/x.ts       run a TypeScript scenario file

options:
  --output-dir <dir>  artifact output directory; used exactly as given (not
                      auto-suffixed), so a repeated run with the same explicit
                      directory overwrites prior artifacts
                      (default: test-results/ui-observe/<scenario>-<timestamp>)
  --timeout-ms <ms>   scenario body timeout (default: ${DEFAULT_SCENARIO_TIMEOUT_MS})

exit codes:
  0  pass (or an explicitly requested --help / --list)
  1  scenario, setup, or cleanup failure
  2  usage error

scenario contract (TypeScript, loaded with the repo tsx runtime — no eval):
  default-export a function (context) => Promise<void>, or an object
  { name?, description?, run(context) }. The context provides:
    context.page          ready Playwright Electron main-window Page
    context.electronApp   the launched ElectronApplication
    context.session       { userDataDir, runtimeAppDataPath, chatDbPath,
                            ownedTmpRoot, mockPort, outputDir }
    context.capture(name)    screenshot PNG into the output dir (returns path)
    context.writeText(name, content)  UTF-8 text artifact (returns path)

guarantees:
  unique disposable profile + owned temp root (never real user data)
  runtime appDataPath asserted to exactly match the profile before any step
  mock OpenAI provider seeded (no live APIs), readiness verified
  ownership-scoped cleanup in a finally, even on scenario failure
  no fixed CDP port, no broad process kills
  explicit --output-dir is caller-controlled and never auto-suffixed; repeated
  use of the same explicit directory may overwrite prior artifacts (LOCK-OBS-006)

prerequisite: a fresh production build (pnpm build) — like E2E.
`

function listText(): string {
  const lines = builtinScenarioEntries.map((entry) => {
    const scenario = normalizeScenarioExport(entry.module, entry.name)
    return `  ${entry.name.padEnd(20)}${scenario.description ?? ''}`
  })
  return ['built-in scenarios:', ...lines].join('\n')
}

/** Injectable dependencies for deterministic CLI tests (defaults preserve the public CLI exactly). */
export interface UiObserveCliDeps {
  /** Session runner; defaults to the real `runObservationSession`. */
  runSession?: (options: ObservationSessionOptions) => Promise<ObservationRunResult>
  /** Explicit process exit used only by the `scenarioPending` branch; defaults to `process.exit`. */
  forceExit?: (code: number) => void
  /** Stream flush awaited before the explicit exit; defaults to the internal flush helper. */
  flushStreams?: () => Promise<void>
}

export async function uiObserveCli(
  argv: readonly string[],
  io: { stdout: (text: string) => void; stderr: (text: string) => void },
  deps: UiObserveCliDeps = {}
): Promise<number> {
  // Smallest test seam: tests inject the session runner and the exit/flush
  // hooks; the defaults are the real behavior, so `main()` below is unchanged.
  const runSession = deps.runSession ?? runObservationSession
  const forceExit = deps.forceExit ?? ((code: number) => process.exit(code))
  const flushStreams = deps.flushStreams ?? flushProcessStreams

  const parsed = parseUiObserveArgs(argv)
  if (!parsed.ok) {
    io.stderr(`[ui-observe] ${parsed.error}\n\n${HELP_TEXT}`)
    return EXIT_USAGE
  }

  const command = parsed.command
  if (command.kind === 'help') {
    io.stdout(HELP_TEXT)
    return EXIT_PASS
  }
  if (command.kind === 'list') {
    io.stdout(`${listText()}\n`)
    return EXIT_PASS
  }

  const log = (line: string) => io.stdout(`${line}\n`)

  let resolved
  try {
    resolved = await resolveScenario(command.scenario, process.cwd(), builtinScenarioEntries)
  } catch (error) {
    io.stderr(`[ui-observe] ${error instanceof Error ? error.message : String(error)}\n`)
    return EXIT_USAGE
  }

  const scenarioName = resolved.scenario.name ?? resolved.source
  const outputDir = resolveOutputDir(scenarioName, command.outputDir)
  const timeoutMs = command.timeoutMs ?? DEFAULT_SCENARIO_TIMEOUT_MS

  log(`[ui-observe] scenario: ${scenarioName}`)
  log(`[ui-observe] source: ${resolved.source}`)
  log(`[ui-observe] output dir: ${outputDir}`)
  log(`[ui-observe] timeout: ${timeoutMs}ms`)

  const result = await runSession({
    scenario: resolved.scenario,
    scenarioSource: resolved.source,
    outputDir,
    timeoutMs,
    log
  })

  log(`[ui-observe] result: ${result.ok ? 'PASS' : 'FAIL'} (${result.durationMs}ms)`)
  for (const artifact of result.artifacts) {
    log(`[ui-observe] ${artifact.kind === 'png' ? 'screenshot' : 'artifact'}: ${artifact.path}`)
  }
  log(`[ui-observe] manifest: ${path.join(result.outputDir, 'manifest.json')}`)

  if (!result.ok) {
    if (result.error !== null) io.stderr(`[ui-observe] error: ${result.error}\n`)
    if (result.cleanupError !== null) io.stderr(`[ui-observe] cleanup error: ${result.cleanupError}\n`)
    if (result.scenarioPending) {
      // The scenario body timed out and was STILL pending after all cleanup
      // completed inside runObservationSession (cleanup-before-exit). Its
      // abandoned promise may hold event-loop handles that would keep the CLI
      // alive forever; exit explicitly after flushing the final report.
      io.stderr(`[ui-observe] scenario '${result.scenarioName}' still pending after cleanup — exiting explicitly\n`)
      await flushStreams()
      forceExit(EXIT_FAIL)
    }
    return EXIT_FAIL
  }
  return EXIT_PASS
}

/**
 * Flush both process output streams so the final failure report is not lost
 * when the CLI force-exits (the scenarioPending branch above). Writes are
 * drained before the process terminates; no-op when already drained.
 */
function flushProcessStreams(): Promise<void> {
  const flush = (stream: NodeJS.WriteStream): Promise<void> =>
    new Promise((resolve) => {
      if (stream.writableLength === 0) {
        resolve()
        return
      }
      stream.write('', () => resolve())
    })
  return Promise.all([flush(process.stdout), flush(process.stderr)]).then(() => undefined)
}

async function main(): Promise<void> {
  process.exitCode = await uiObserveCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text)
  })
}

const entry = process.argv[1]
if (entry != null && fileURLToPath(import.meta.url) === path.resolve(entry)) {
  main().catch((error) => {
    process.stderr.write(`[ui-observe] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = EXIT_FAIL
  })
}
