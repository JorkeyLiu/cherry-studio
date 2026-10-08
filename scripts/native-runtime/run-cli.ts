/**
 * Native runtime CLI entry point (`native:run`).
 *
 * Wires the tested `runRuntime` runner (run.ts) into a stable CLI contract:
 *
 *   tsx scripts/native-runtime/run-cli.ts node -- <command> [args...]
 *   tsx scripts/native-runtime/run-cli.ts electron -- <command> [args...]
 *
 * The runner first proves the shared better-sqlite3 Node-API binary works
 * under the requested runtime with a real `:memory:` SQL probe, then spawns
 * the explicit child command with a sanitized environment. There is no ABI
 * rebuild, no ensure, no lock, and no serialized execution — concurrent
 * invocations are safe.
 *
 * Exit codes: the child's own exit code on the completed path, 1 for a probe
 * failure or an unexpected runner rejection, 2 for a usage error.
 *
 * Contracts honored:
 *  - The target runtime is explicit: only `node` or `electron` after the
 *    script path; never inferred from directories, tests, imports, or the
 *    command name.
 *  - The command is an explicit executable + argv after a mandatory `--`
 *    separator; it is never shell-parsed and never inferred.
 *  - `process.exitCode` is set from the structured run result; `process.exit`
 *    is never called before the runner settles.
 *  - Diagnostics are concise and deterministic: target/status/exit plus an
 *    actionable failure line. Full reports and environment variables are never
 *    dumped.
 *
 * All I/O is injectable (the runner and the stdout/stderr seam), so the CLI
 * logic is deterministically testable without touching native bindings or
 * spawning real package commands.
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runRuntime, type RunRuntimeOptions, type RunRuntimeResult } from './run'
import type { Target } from './types'

// ---------------------------------------------------------------------------
// Argv parsing (pure; no I/O)
// ---------------------------------------------------------------------------

/** Result of parsing the CLI argv. */
export type ParseRunArgsResult =
  | { ok: true; target: Target; command: string; args: string[] }
  | { ok: false; error: string }

/**
 * Parse the CLI argv (after `process.argv.slice(2)`):
 *
 *   <node|electron> -- <command> [args...]
 *
 * The target is explicit, the `--` separator is mandatory, and the command
 * after it must be a non-empty string. Everything after the command is
 * forwarded verbatim as the child argv — never shell-parsed.
 */
export function parseRunArgs(argv: readonly string[]): ParseRunArgsResult {
  const [targetArg, separator, command, ...args] = argv
  if (targetArg !== 'node' && targetArg !== 'electron') {
    return { ok: false, error: `invalid target '${String(targetArg)}' - expected 'node' or 'electron'` }
  }
  if (separator !== '--') {
    return { ok: false, error: "missing mandatory '--' separator between the target and the command" }
  }
  if (typeof command !== 'string' || command.length === 0) {
    return { ok: false, error: "missing command after the '--' separator" }
  }
  return { ok: true, target: targetArg, command, args }
}

// ---------------------------------------------------------------------------
// Diagnostics (pure; concise and deterministic)
// ---------------------------------------------------------------------------

/** Concise CLI diagnostics for a run result. */
export interface RunDiagnostics {
  /** Lines printed to stdout for every run (target/status/exit). */
  stdout: string
  /** Actionable failure lines printed to stderr on a failing run. */
  stderr: string
}

/** Deterministic line label width, matching report.ts. */
function line(label: string, value: string): string {
  return `${label.padEnd(18)}${value}`
}

/** Clip a diagnostic to a bounded width so reports never dump huge payloads. */
function clip(text: string, max = 240): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`
}

/** Concise child outcome diagnostic. */
function childLine(child: RunRuntimeResult & { status: 'completed' }): string {
  const outcome = child.child
  if (outcome.kind === 'exited') {
    return line('child:', `exited ${outcome.code}`)
  }
  if (outcome.kind === 'signaled') {
    return line('child:', `signaled ${outcome.signal} (exit ${outcome.exitCode})`)
  }
  return line('child:', `spawn error: ${clip(outcome.message)}`)
}

/**
 * Format a `runRuntime` result into concise, deterministic diagnostics.
 *
 * Every run prints a three-line status block (target/status/exit) to stdout.
 * Failing runs additionally emit actionable failure lines to stderr.
 * Environment variables are never included.
 */
export function formatRunResult(result: RunRuntimeResult): RunDiagnostics {
  const out: string[] = [
    line('command:', `native:run ${result.target}`),
    line('status:', result.status),
    line('exit:', String(result.exitCode))
  ]
  const failures: string[] = []

  if (result.status === 'probe-failure') {
    failures.push(line('probe:', clip(result.error)))
    if (result.closeError !== undefined) {
      failures.push(line('probe close:', clip(result.closeError)))
    }
    failures.push(line('action:', 're-run `pnpm install` to restore the locked better-sqlite3 prebuilds, then retry'))
  } else {
    const outcome = result.child
    const failed =
      outcome.kind === 'exited' ? outcome.code !== 0 : outcome.kind === 'signaled' ? outcome.exitCode !== 0 : true
    if (failed) {
      failures.push(childLine(result))
    }
  }

  return {
    stdout: `${out.join('\n')}\n`,
    stderr: failures.length > 0 ? `${failures.join('\n')}\n` : ''
  }
}

// ---------------------------------------------------------------------------
// CLI logic (injectable runner + I/O seam; never calls process.exit)
// ---------------------------------------------------------------------------

/** The injected runner seam; the real entrypoint wires `runRuntime`. */
export type RunRunner = (options: RunRuntimeOptions) => Promise<RunRuntimeResult>

/** The injected stdout/stderr seam. */
export interface RunCliIo {
  stdout(text: string): void
  stderr(text: string): void
}

function usage(): string {
  return [
    'usage: tsx scripts/native-runtime/run-cli.ts <node|electron> -- <command> [args...]',
    '',
    '  node       probe the shared binary under Node 24, then run <command>',
    '  electron   probe the shared binary under Electron 41.2.1, then run <command>',
    '',
    '  --         mandatory separator; the command after it is an explicit',
    '             executable and argv, never shell-parsed'
  ].join('\n')
}

/**
 * Pure CLI logic: parse argv, run through the injected runner with the
 * inherited cwd/env, print concise diagnostics, and return the deterministic
 * exit code. Never calls `process.exit` — the caller assigns the returned
 * code to `process.exitCode` after the runner settles.
 *
 * Exit codes: 2 for a usage error, 1 for an unexpected runner rejection
 * (concise error on stderr), otherwise the structured run result's final exit
 * code preserved verbatim.
 */
export async function runCli(argv: readonly string[], runner: RunRunner, io: RunCliIo): Promise<number> {
  const parsed = parseRunArgs(argv)
  if (!parsed.ok) {
    io.stderr(`${parsed.error}\n\n${usage()}\n`)
    return 2
  }
  try {
    const result = await runner({
      target: parsed.target,
      command: parsed.command,
      args: parsed.args,
      cwd: process.cwd(),
      env: process.env
    })
    const diagnostics = formatRunResult(result)
    io.stdout(diagnostics.stdout)
    if (diagnostics.stderr.length > 0) {
      io.stderr(diagnostics.stderr)
    }
    return result.exitCode
  } catch (error) {
    io.stderr(`native:run error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

// ---------------------------------------------------------------------------
// Entry point (executed only when this module is the CLI; inert when imported)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2), (options) => runRuntime(options), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text)
  })
}

const entry = process.argv[1]
if (entry != null && fileURLToPath(import.meta.url) === resolve(entry)) {
  main().catch((error) => {
    process.stderr.write(`native:run fatal: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
