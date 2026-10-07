/**
 * Narrow standard runner: probe the shared native runtime, then spawn.
 *
 * `runRuntime` proves the better-sqlite3 13.0.3 shared Node-API binary works
 * under the requested runtime with a real `:memory:` SQL probe
 * (`select 1 as ok` + close) and then spawns the explicit child command with
 * a sanitized environment. There is no ABI rebuild, no ensure, no lock, no
 * lease, no restore, and no serialized execution — concurrent invocations
 * (including concurrent Node and Electron commands) are safe.
 *
 * The caller's environment is never mutated: the env given to the probe and
 * to the child is sanitized by `stripElectronRunAsNode`, so an ambient
 * `ELECTRON_RUN_AS_NODE` can never leak into a real app/child command — only
 * the controlled Electron probe env built by effects.ts sets it, explicitly.
 */

import { PROBE_TIMEOUT_MS } from './constants'
import { createEffects, parseProbeOutput } from './effects'
import {
  conventionalExitCode,
  createProcessExecutorSeams,
  executeProcess,
  type ProcessExecutorSeams,
  type ProcessOutcome
} from './executor'
import type { Effects, Target } from './types'

// ---------------------------------------------------------------------------
// Canonical child environment sanitization
// ---------------------------------------------------------------------------

/**
 * Env var that must never reach a canonical child command. It is valid only
 * inside the controlled Electron probe child environment built by effects.ts
 * (`spawnElectronProbe` sets it explicitly); an ambient inherited value would
 * make `pnpm dev` run Electron as plain Node and leave `electron.app`
 * undefined.
 */
export const ELECTRON_RUN_AS_NODE_ENV = 'ELECTRON_RUN_AS_NODE'

/**
 * Return an env suitable for probing and child execution: the caller's env
 * without an ambient `ELECTRON_RUN_AS_NODE`. The input is never mutated —
 * when the variable is absent the same reference is returned (there is
 * nothing to strip), and when present a copy without it is returned so every
 * other variable is preserved intact. Only the controlled probe env built by
 * effects.ts may set `ELECTRON_RUN_AS_NODE`.
 */
export function stripElectronRunAsNode(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env[ELECTRON_RUN_AS_NODE_ENV] === undefined) {
    return env
  }
  const sanitized = { ...env }
  delete sanitized[ELECTRON_RUN_AS_NODE_ENV]
  return sanitized
}

// ---------------------------------------------------------------------------
// Options and results
// ---------------------------------------------------------------------------

/** Options for `runRuntime`. */
export interface RunRuntimeOptions {
  /** Explicit target runtime; never inferred. */
  target: Target
  /** Explicit executable path or command name (never shell-parsed). */
  command: string
  /** Explicit argv (never shell-parsed). */
  args: readonly string[]
  /** Working directory for the child; default `process.cwd()`. */
  cwd?: string
  /** Environment probed and passed to the child; default `process.env`. Never mutated; an ambient `ELECTRON_RUN_AS_NODE` is stripped. */
  env?: NodeJS.ProcessEnv
  /** Effects used for probing; default `createEffects()`. */
  effects?: Effects
  /** Process executor seams; default `createProcessExecutorSeams()`. */
  processSeams?: ProcessExecutorSeams
}

/** The runtime SQL probe failed: the child never spawned. */
export interface ProbeFailureRunResult {
  status: 'probe-failure'
  target: Target
  /** Concise probe failure diagnostic. */
  error: string
  /** Probe close error preserved alongside the primary error, when present. */
  closeError?: string
  exitCode: number
}

/** The probe passed and the child ran to its own outcome. */
export interface CompletedRunResult {
  status: 'completed'
  target: Target
  child: ProcessOutcome
  exitCode: number
}

/** Discriminated result of `runRuntime`. */
export type RunRuntimeResult = ProbeFailureRunResult | CompletedRunResult

/** Deterministic exit code when the runtime probe fails (no spawn). */
export const PROBE_FAILURE_EXIT_CODE = 1

/** Deterministic exit code when the child never ran (spawn error). */
export const CHILD_SPAWN_ERROR_EXIT_CODE = 1

/** Deterministic exit code of a child outcome. */
export function childOutcomeExitCode(outcome: ProcessOutcome): number {
  if (outcome.kind === 'exited') {
    return outcome.code
  }
  if (outcome.kind === 'signaled') {
    return outcome.exitCode
  }
  return CHILD_SPAWN_ERROR_EXIT_CODE
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function probeNode(effects: Effects): { ok: boolean; error?: string; closeError?: string } {
  const probe = effects.probeNodeBinding()
  if (probe.sqlOk) {
    return { ok: true }
  }
  return { ok: false, error: probe.error ?? 'unknown error', closeError: probe.closeError }
}

function probeElectron(effects: Effects): { ok: boolean; error?: string; closeError?: string } {
  const bin = effects.electronBinPath()
  if (!bin) {
    return { ok: false, error: 'Electron executable not found; run `pnpm install`.' }
  }
  const spawned = effects.spawnElectronProbe(bin, effects.probePath())
  if (spawned.timedOut) {
    return {
      ok: false,
      error: `Electron runtime SQL probe timed out after ${Math.round(PROBE_TIMEOUT_MS / 1000)}s (bounded diagnostic timeout; child terminated, no retry)`
    }
  }
  const probe = parseProbeOutput(spawned.stdout) ?? parseProbeOutput(spawned.stderr)
  if (spawned.code === 0 && probe && probe.ok && probe.sqlOk) {
    return { ok: true }
  }
  const detail = probe
    ? (probe.error ?? `probe exited with code ${spawned.code}`)
    : 'probe produced no parseable output'
  return { ok: false, error: detail, closeError: probe?.closeError }
}

/**
 * Probe the requested runtime and, on success, run the explicit child command
 * to completion. Returns a discriminated result whose `exitCode` is the
 * deterministic final exit code: the child's own outcome code on the
 * `completed` path, `PROBE_FAILURE_EXIT_CODE` when the probe failed (the
 * child never spawns).
 *
 * Signal semantics: parent SIGINT/SIGTERM are forwarded to a running child by
 * the executor; a signaled child yields the conventional `128 + signal`
 * exit code (see `conventionalExitCode`).
 */
export async function runRuntime(options: RunRuntimeOptions): Promise<RunRuntimeResult> {
  const target = options.target
  const command = options.command
  const args = options.args
  const cwd = options.cwd ?? process.cwd()
  const runEnv = options.env ?? process.env
  // Never mutate the caller's env; strip the ambient Electron-as-Node flag so
  // it can never reach the probe or the canonical child command.
  const sanitizedEnv = stripElectronRunAsNode(runEnv)

  const effects = options.effects ?? createEffects()
  const processSeams = options.processSeams ?? createProcessExecutorSeams()

  const probe = target === 'node' ? probeNode(effects) : probeElectron(effects)
  if (!probe.ok) {
    return {
      status: 'probe-failure',
      target,
      error: probe.error ?? 'runtime SQL probe failed',
      ...(probe.closeError !== undefined ? { closeError: probe.closeError } : {}),
      exitCode: PROBE_FAILURE_EXIT_CODE
    }
  }

  const child = await executeProcess(processSeams, { command, args, cwd, env: sanitizedEnv })
  return { status: 'completed', target, child, exitCode: childOutcomeExitCode(child) }
}

export { conventionalExitCode }
