/**
 * Injectable child-process executor (bounded process primitive for the Native
 * ABI Runtime Lane lifecycle).
 *
 * Runs an explicit executable + argv without enabling shell parsing, inherits a supplied
 * environment, preserves exit/signal/spawn outcomes, forwards parent
 * SIGINT/SIGTERM to a running child, waits for child completion, and always
 * unregisters the parent signal handlers. It does not acquire locks, inspect
 * leases, ensure/restore lanes, or touch the repository ABI state — the later
 * lifecycle runner calls this module while holding a lane lease and owns
 * cleanup/finalization.
 *
 * Contracts honored:
 *  - Commands are explicit executable + argv; no shell string parsing and no
 *    directory/import ABI inference.
 *  - Outcomes are a discriminated union: `exited(code)`, `signaled(signal,
 *    exitCode)` with a deterministic conventional exit-code mapping (128 +
 *    signal number), or `spawn-error(message, code?)` — easy precedence logic
 *    for the lifecycle runner.
 *  - On parent SIGINT/SIGTERM the same signal is forwarded to the running
 *    child; `process.exit` is never called (cleanup/finalization is the later
 *    lifecycle runner's job), and SIGKILL stays uncatchable and unforwarded.
 *  - Parent signal listeners are unregistered in every settlement path and an
 *    error/close race never double-settles the outcome.
 *  - A caller-supplied signal that cannot be registered (unsupported or
 *    uncatchable on the platform) is a spawn-error outcome, never a rejected
 *    promise or a leaked listener: every already-registered handler is
 *    unregistered first and the child stays observed.
 *
 * All I/O goes through the injected `ProcessExecutorSeams` so the outcome and
 * forwarding logic is deterministically testable with fakes (Vitest scripts
 * project); the real wiring lives in `createProcessExecutorSeams()`.
 */

import type { SpawnOptions } from 'node:child_process'
import { spawn } from 'node:child_process'
import os from 'node:os'

/**
 * Structural subset of `ChildProcess` the executor relies on. `ChildProcess`
 * satisfies it structurally; tests inject faithful fakes.
 */
export interface SpawnedChild {
  readonly pid?: number
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  on(event: 'error', listener: (error: Error) => void): this
}

/** The injected I/O seam: child spawn + parent signal registration. */
export interface ProcessExecutorSeams {
  /** Spawn `command` with explicit `args` (never shell-parsed). */
  spawn(command: string, args: readonly string[], options: SpawnOptions): SpawnedChild
  /** Register a parent-process signal handler; the returned function unregisters it. */
  onSignal(signal: NodeJS.Signals, handler: () => void): () => void
}

/** Options for `executeProcess`. */
export interface ExecuteOptions {
  /** Explicit executable path or command name (never shell-parsed). */
  command: string
  /** Explicit argv (never shell-parsed). */
  args: readonly string[]
  /** Environment inherited by the child; default `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Working directory for the child; default `process.cwd()`. */
  cwd?: string
  /** stdio for the child; default `'inherit'` (real wiring preserves stdio inheritance). */
  stdio?: SpawnOptions['stdio']
  /** Parent signals forwarded to a running child; default `['SIGINT', 'SIGTERM']`. */
  forwardedSignals?: readonly NodeJS.Signals[]
}

/** Windows command shims used by the repository's native ABI lanes. */
const WINDOWS_CMD_SHIMS = new Set([
  'pnpm',
  'pnpm.cmd',
  'vitest',
  'vitest.cmd',
  'electron-vite',
  'electron-vite.cmd',
  'dotenv',
  'dotenv.cmd',
  'tsx',
  'tsx.cmd',
  'playwright',
  'playwright.cmd'
])

/**
 * Discriminated outcome of a child run. `kind` is the single source the later
 * lifecycle precedence logic switches on:
 *  - `exited`: the child exited on its own with `code`.
 *  - `signaled`: the child was terminated by `signal`; `exitCode` is the
 *    deterministic conventional mapping (128 + signal number).
 *  - `spawn-error`: the child never ran; `code` is the errno code when known
 *    (e.g. `ENOENT`).
 */
export type ProcessOutcome =
  | { kind: 'exited'; code: number }
  | { kind: 'signaled'; signal: NodeJS.Signals; exitCode: number }
  | { kind: 'spawn-error'; message: string; code?: string }

/**
 * Stable signal-name → number fallback for the conventional exit-code mapping,
 * used only when the platform's `os.constants.signals` table lacks a known
 * signal (e.g. minimal libc or Windows builds). Numbers follow the conventional
 * Linux/glibc table so `128 + number` stays deterministic across platforms; the
 * platform table remains authoritative when it does define the signal.
 */
export const FALLBACK_SIGNAL_NUMBERS: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGSTKFLT: 16,
  SIGCHLD: 17,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
  SIGTTIN: 21,
  SIGTTOU: 22,
  SIGURG: 23,
  SIGXCPU: 24,
  SIGXFSZ: 25,
  SIGVTALRM: 26,
  SIGPROF: 27,
  SIGWINCH: 28,
  SIGIO: 29,
  SIGPWR: 30,
  SIGSYS: 31
}

/**
 * Deterministic conventional exit-code mapping for a termination signal:
 * `128 + signalNumber` (SIGINT → 130, SIGTERM → 143, SIGKILL → 137). The
 * platform table is authoritative; `FALLBACK_SIGNAL_NUMBERS` covers known
 * signals the platform lacks, and anything unknown falls back to 1 so the
 * mapping stays total and deterministic.
 */
export function conventionalExitCode(signal: NodeJS.Signals): number {
  const platformNumber = (os.constants.signals as Record<string, number | undefined>)[signal]
  const signalNumber = platformNumber ?? FALLBACK_SIGNAL_NUMBERS[signal]
  return signalNumber === undefined ? 1 : 128 + signalNumber
}

/** errno code from a Node error, if any. */
function errnoCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error) {
    const code = (error as NodeJS.ErrnoException).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

/** Real wiring: `node:child_process` spawn + `process.on`/`off` signal registration. */
export function createProcessExecutorSeams(): ProcessExecutorSeams {
  return {
    spawn: (command, args, options) => {
      // Windows package shims are .cmd files. Node cannot execute a .cmd file
      // directly with spawn(), so route the fixed lane commands through the
      // system command interpreter while preserving their explicit argv.
      if (process.platform === 'win32' && WINDOWS_CMD_SHIMS.has(command)) {
        return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command, ...args], options)
      }
      return spawn(command, args, options)
    },
    onSignal: (signal, handler) => {
      process.on(signal, handler)
      return () => {
        process.off(signal, handler)
      }
    }
  }
}

/**
 * Run a child process to completion and return its discriminated outcome.
 *
 * The child is spawned with the supplied (or defaulted) cwd/env/stdio and the
 * explicit argv. While it runs, parent `forwardedSignals` (default SIGINT and
 * SIGTERM) are forwarded to the child. `process.exit` is never called: when the
 * child settles, the parent signal listeners are unregistered and the promise
 * resolves; whatever the parent does next belongs to the lifecycle runner.
 *
 * Settlement is single-shot: the first `close`/`error` event resolves the
 * outcome and unregisters the signal handlers, so an `error` followed by
 * `close` (the documented spawn-failure tail) never double-settles.
 */
export function executeProcess(seams: ProcessExecutorSeams, options: ExecuteOptions): Promise<ProcessOutcome> {
  const forwardedSignals = options.forwardedSignals ?? ['SIGINT', 'SIGTERM']

  let child: SpawnedChild
  try {
    child = seams.spawn(options.command, options.args, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      stdio: options.stdio ?? 'inherit'
    })
  } catch (error) {
    // A synchronous spawn failure (e.g. an invalid stdio option) is the same
    // observable outcome as an async 'error' event.
    return Promise.resolve({
      kind: 'spawn-error',
      message: error instanceof Error ? error.message : String(error),
      code: errnoCode(error)
    })
  }

  return new Promise<ProcessOutcome>((resolve) => {
    let settled = false
    const unregisters: Array<() => void> = []
    const settle = (outcome: ProcessOutcome): void => {
      if (settled) {
        return
      }
      settled = true
      for (const unregister of unregisters) {
        unregister()
      }
      resolve(outcome)
    }

    // Observe the child before anything else so it is never left unobserved,
    // even when signal registration fails below.
    child.on('error', (error) => {
      settle({
        kind: 'spawn-error',
        message: error instanceof Error ? error.message : String(error),
        code: errnoCode(error)
      })
    })

    child.on('close', (code, signal) => {
      if (signal !== null) {
        settle({ kind: 'signaled', signal, exitCode: conventionalExitCode(signal) })
      } else if (code !== null) {
        settle({ kind: 'exited', code })
      } else {
        // Defensive fail-closed tail: a close with neither an exit code nor a
        // termination signal is the documented spawn-failure tail ('close'
        // after 'error' with null/null) or an unknowable termination; it must
        // never masquerade as a clean exit. When 'error' already settled the
        // outcome, this is a no-op.
        settle({ kind: 'spawn-error', message: 'child closed without an exit code or termination signal' })
      }
    })

    // Forward parent signals to the running child. Nothing is registered when
    // the spawn already failed (pid undefined): there is no child to forward
    // to. kill() on a dead child is a no-op returning false, and the `settled`
    // guard stops forwarding after the outcome resolved.
    if (child.pid !== undefined) {
      try {
        for (const signal of forwardedSignals) {
          unregisters.push(
            seams.onSignal(signal, () => {
              if (!settled) {
                child.kill(signal)
              }
            })
          )
        }
      } catch (error) {
        // A caller-supplied signal that cannot be registered (unsupported or
        // uncatchable on this platform) must never reject the promise or leak
        // the handlers registered earlier in this loop: `settle` unregisters
        // every handler registered so far and resolves the same discriminated
        // spawn-error outcome the API uses for a child that never ran. The
        // child stays observed by the listeners attached above.
        settle({
          kind: 'spawn-error',
          message: `unable to register parent signal handler: ${error instanceof Error ? error.message : String(error)}`,
          code: errnoCode(error)
        })
      }
    }
  })
}
