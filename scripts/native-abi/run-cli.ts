/**
 * Native ABI runtime-lane CLI entry point (`native:run`).
 *
 * Wires the tested `runLane` coordinator (run.ts) into a stable CLI contract:
 *
 *   tsx scripts/native-abi/run-cli.ts node -- <command> [args...]
 *   tsx scripts/native-abi/run-cli.ts electron -- <command> [args...]
 *
 * Exit codes: 0 = PASS, 1 = FAIL (child/runner/cleanup failure or an
 * unexpected coordinator rejection), 2 = usage error. Every lane outcome also
 * carries the coordinator's deterministic final exit code (run.ts), which this
 * CLI preserves verbatim on `process.exitCode`.
 *
 * Contracts honored:
 *  - The lane is explicit (LOCK-001): only `node` or `electron` after the
 *    script path; never inferred from directories, tests, imports, or the
 *    command name.
 *  - native:check:* stays read-only (LOCK-002): this CLI never runs a check or
 *    a rebuild on its own — the only rebuild/restore paths are the
 *    coordinator's preparation ensure seam and the LOCK-003 restoration
 *    adapter.
 *  - The command is an explicit executable + argv after a mandatory `--`
 *    separator; it is never shell-parsed and never inferred.
 *  - `process.exitCode` is set from the structured run result; `process.exit`
 *    is never called before the coordinator's cleanup (the coordinator itself
 *    owns lock restore/release and signal-guard disposal in a top-level
 *    `finally`).
 *  - Diagnostics are concise and deterministic: lane/status/exit plus an
 *    actionable failure category. Full reports, environment variables, and
 *    lease/lock ownership secrets (the acquisition token) are never dumped.
 *
 * All I/O is injectable (the runner and the stdout/stderr seam), so the CLI
 * logic is deterministically testable without touching native bindings,
 * spawning real package commands, or holding locks. This module does not
 * modify package.json; the `native:run` package script is wired later.
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ProcessOutcome } from './executor'
import type { ReleaseResult, RestoreResult } from './finalize'
import type { LaneId } from './lock'
import type { PreparationFailureReason } from './prepare'
import { runLane, type RunLaneOptions, type RunLaneResult } from './run'

// ---------------------------------------------------------------------------
// Argv parsing (pure; no I/O)
// ---------------------------------------------------------------------------

/** Result of parsing the CLI argv. */
export type ParseRunArgsResult =
  | { ok: true; lane: LaneId; command: string; args: string[] }
  | { ok: false; error: string }

/**
 * Parse the CLI argv (after `process.argv.slice(2)`):
 *
 *   <node|electron> -- <command> [args...]
 *
 * The lane is explicit (LOCK-001), the `--` separator is mandatory, and the
 * command after it must be a non-empty string. Everything after the command is
 * forwarded verbatim as the child argv — never shell-parsed.
 */
export function parseRunArgs(argv: readonly string[]): ParseRunArgsResult {
  const [laneArg, separator, command, ...args] = argv
  if (laneArg !== 'node' && laneArg !== 'electron') {
    return { ok: false, error: `invalid lane '${String(laneArg)}' - expected 'node' or 'electron'` }
  }
  if (separator !== '--') {
    return { ok: false, error: "missing mandatory '--' separator between the lane and the command" }
  }
  if (typeof command !== 'string' || command.length === 0) {
    return { ok: false, error: "missing command after the '--' separator" }
  }
  return { ok: true, lane: laneArg, command, args }
}

// ---------------------------------------------------------------------------
// Diagnostics (pure; concise and deterministic)
// ---------------------------------------------------------------------------

/** Concise CLI diagnostics for a run result. */
export interface RunDiagnostics {
  /** Lines printed to stdout for every run (lane/status/exit). */
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

/** True when the child outcome itself failed (nonzero exit, signal, or spawn error). */
function childFailed(outcome: ProcessOutcome): boolean {
  if (outcome.kind === 'exited') {
    return outcome.code !== 0
  }
  if (outcome.kind === 'signaled') {
    return outcome.exitCode !== 0
  }
  return true
}

/** Concise child outcome diagnostic. */
function childLine(outcome: ProcessOutcome): string {
  if (outcome.kind === 'exited') {
    return line('child:', `exited ${outcome.code}`)
  }
  if (outcome.kind === 'signaled') {
    return line('child:', `signaled ${outcome.signal} (exit ${outcome.exitCode})`)
  }
  return line('child:', `spawn error: ${clip(outcome.message)}`)
}

/** Concise failed-restoration diagnostic (skipped is not a failure and is never printed). */
function restoreLine(restore: RestoreResult): string {
  if (restore.status === 'rejected') {
    return line('restore:', `rejected: ${clip(restore.error)}`)
  }
  return line('restore:', 'FAIL (Electron ABI 145 restoration did not pass)')
}

/** Concise failed-release diagnostic. */
function releaseLine(release: ReleaseResult): string {
  if (release.released) {
    // Defensive: the caller only formats a failed release.
    return line('release:', 'FAIL (unknown)')
  }
  const base = line('release:', `FAIL (${release.reason})`)
  return release.error !== undefined ? `${base} ${clip(release.error)}` : base
}

/** Concise preparation-failure diagnostics (never the lock owner metadata). */
function preparationFailureLines(reason: PreparationFailureReason): string[] {
  switch (reason.kind) {
    case 'root-resolution':
      return [line('preparation:', clip(reason.detail))]
    case 'lock-acquire': {
      const acquire = reason.acquire
      if (acquire.acquired) {
        // Defensive: a preparation failure never carries a successful acquire.
        return [line('lock:', 'acquired but preparation did not complete')]
      }
      if (acquire.reason === 'error') {
        return [line('lock:', clip(acquire.error)), line('lock path:', acquire.lockPath)]
      }
      return [
        line('lock:', `${acquire.reason} - held by another ${acquire.owner.lane} lane`),
        line('lock path:', acquire.lockPath)
      ]
    }
    case 'lock-acquire-rejected':
      return [line('lock:', clip(reason.error)), line('lock path:', reason.lockPath)]
  }
}

/**
 * Format a `runLane` result into concise, deterministic diagnostics.
 *
 * Every run prints a three-line status block (lane/status/exit) to stdout.
 * Failing runs additionally emit actionable failure lines to stderr. Full
 * ensure/rebuild reports, environment variables, and lease/lock ownership
 * secrets (the acquisition token) are never included.
 */
export function formatRunResult(result: RunLaneResult): RunDiagnostics {
  const out: string[] = [
    line('command:', `native:run ${result.lane}`),
    line('status:', result.status),
    line('exit:', String(result.exitCode))
  ]
  const failures: string[] = []

  switch (result.status) {
    case 'nested': {
      if (childFailed(result.child)) {
        failures.push(childLine(result.child))
      }
      if (result.lifecycleSignal !== undefined) {
        failures.push(
          line('signal:', `captured ${result.lifecycleSignal.signal} (exit ${result.lifecycleSignal.exitCode})`)
        )
      }
      break
    }
    case 'lane-conflict': {
      const holder = result.lease.owner.lane
      failures.push(line('conflict:', `a valid ${holder} lane lease holds checkout ${result.checkoutRoot}`))
      failures.push(
        line('action:', `wait for the ${holder} lane to release its lock, or run the ${holder} lane command`)
      )
      break
    }
    case 'preparation-failure': {
      failures.push(...preparationFailureLines(result.reason))
      break
    }
    case 'outer':
    case 'target-lane-failure': {
      const finalize = result.finalize
      if (finalize.child.ran) {
        if (childFailed(finalize.child.outcome)) {
          failures.push(childLine(finalize.child.outcome))
        }
      } else {
        failures.push(line('target lane:', clip(finalize.child.error)))
      }
      if (finalize.restore.status === 'performed' && !finalize.restore.ok) {
        failures.push(restoreLine(finalize.restore))
      } else if (finalize.restore.status === 'rejected') {
        failures.push(restoreLine(finalize.restore))
      }
      if (!finalize.release.released) {
        failures.push(releaseLine(finalize.release))
      }
      if (result.lifecycleSignal !== undefined) {
        failures.push(
          line('signal:', `captured ${result.lifecycleSignal.signal} (exit ${result.lifecycleSignal.exitCode})`)
        )
      }
      break
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

/** The injected runner seam; the real entrypoint wires `runLane`. */
export type RunRunner = (options: RunLaneOptions) => Promise<RunLaneResult>

/** The injected stdout/stderr seam. */
export interface RunCliIo {
  stdout(text: string): void
  stderr(text: string): void
}

function usage(): string {
  return [
    'usage: tsx scripts/native-abi/run-cli.ts <node|electron> -- <command> [args...]',
    '',
    '  node       run <command> under the Node 24 (ABI 137) lane',
    '  electron   run <command> under the Electron 41.2.1 (ABI 145) lane',
    '',
    '  --         mandatory separator; the command after it is an explicit',
    '             executable and argv, never shell-parsed'
  ].join('\n')
}

/**
 * Pure CLI logic: parse argv, run the lane through the injected runner with
 * the inherited cwd/env, print concise diagnostics, and return the
 * deterministic exit code. Never calls `process.exit` — the caller assigns
 * the returned code to `process.exitCode` after the coordinator's cleanup.
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
      lane: parsed.lane,
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
  process.exitCode = await runCli(process.argv.slice(2), (options) => runLane(options), {
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
