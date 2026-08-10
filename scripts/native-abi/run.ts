/**
 * Native ABI runtime-lane coordinator (Phase 4 of the Native ABI Runtime Lane
 * refactor — the concrete runner composing the existing preparation and
 * finalization policies).
 *
 * `runLane` composes `runLanePreparation` (Phase 3a) and `finalizeOuterLane`
 * (Phase 3b) into a single explicit API a later CLI wrapper consumes. Given an
 * explicit lane and an explicit child command, it returns a structured,
 * discriminated result whose `exitCode` is the deterministic final exit code:
 *
 *  - `nested`              — a valid same-checkout same-lane inherited lease
 *                            (LOCK-004): the child executes with the inherited
 *                            lease env and its outcome is returned verbatim.
 *                            Nothing is locked, ensured, rebuilt, restored, or
 *                            released — the outer acquisition owns those.
 *  - `lane-conflict`       — a valid same-checkout OPPOSITE-lane lease
 *                            (LOCK-007): a deterministic nonzero result; the
 *                            child never spawns and the lock is never touched.
 *  - `preparation-failure` — the checkout root could not be resolved or the
 *                            outer lock could not be acquired: a deterministic
 *                            nonzero result carrying the full preparation
 *                            reason. No spawn and no release (no outer
 *                            ownership exists).
 *  - `outer-prepared`      — the outer lock is held and the requested lane is
 *                            ensured: `finalizeOuterLane` runs the child with
 *                            the prepared lease env, restores the local
 *                            Electron ABI 145 default per LOCK-003 (local Node
 *                            lanes only, CI skips), and releases the held lock
 *                            exactly once through `releaseLock` with the
 *                            returned checkout root / ownership token / lock
 *                            path.
 *  - `target-lane-failure` — the outer lock is held but the requested lane
 *                            could not be ensured: `finalizeOuterLane` runs
 *                            with `childRequired: false`, mapping the ensure
 *                            diagnostic to a concise error string. Because
 *                            outer ownership exists, restoration and release
 *                            still run according to policy.
 *
 * Contracts honored:
 *  - The lane is explicit (LOCK-001): this module never infers a lane from
 *    directories, tests, imports, or the child command name — it is always
 *    passed in.
 *  - native:check:* stays read-only (LOCK-002): the only rebuild path is the
 *    preparation ensure seam and the restoration adapter; the coordinator
 *    itself never triggers a rebuild implicitly.
 *  - The release is never attempted when preparation did not acquire outer
 *    ownership: only `outer-prepared` and `target-lane-failure` hold the lock
 *    and only those paths call the finalizer (which releases exactly once).
 *  - Exit-code precedence (LOCK-006) is the finalizer's pure decision: a
 *    failing child outcome, a preserved target preparation failure, a failed
 *    restoration, then a failed release. Every result carries the full
 *    structured statuses so no failure hides behind the compressed exit code.
 *  - SIGINT/SIGTERM are captured by a single coordinator lifecycle guard for
 *    the whole run: installed before lane preparation (so a signal during
 *    lock acquisition, target ensure/rebuild, child execution, Electron
 *    restoration, or lock release can never terminate the coordinator before
 *    cleanup completes) and disposed in a top-level finally. The coordinator
 *    never exits from a signal handler, retains the first signal, and lets
 *    preparation/finalization complete. A signal latched before the requested
 *    child starts skips that command — the child is reported as a synthetic
 *    signaled outcome through the finalizer path while restoration/release
 *    still run — and a captured signal is otherwise the deterministic signaled
 *    runner outcome (conventional 128 + signal number) when the child itself
 *    did not already fail; restore/release diagnostics stay on the result.
 *
 * Concrete module outputs are mapped into the pure finalizer contracts at the
 * integration boundary only — `ProcessOutcome` mirrors `ChildResult`, the
 * concrete restoration outcome maps to `RestoreResult` (with the full
 * `LaneEnsureResult` diagnostics preserved), and `LockReleaseResult` mirrors
 * `ReleaseResult`. There is no second ABI state machine here: the coordinator
 * only composes the existing policies.
 *
 * All real I/O is injectable (`PreparationSeams`, `Effects`,
 * `ProcessExecutorSeams`); when an injection is absent, the real wiring from
 * the phase modules is used. The caller's environment is never mutated: the
 * env given to lane preparation and to canonical child commands is sanitized
 * by `stripElectronRunAsNode`, so an ambient `ELECTRON_RUN_AS_NODE` can never
 * leak into a lane child — only the controlled Electron probe env built by
 * effects.ts sets it, explicitly.
 */

import { createEffects } from './effects'
import {
  conventionalExitCode,
  createProcessExecutorSeams,
  executeProcess,
  type ProcessExecutorSeams,
  type ProcessOutcome
} from './executor'
import {
  CHILD_SPAWN_ERROR_EXIT_CODE,
  type ChildRun,
  type FinalizeOperations,
  finalizeOuterLane,
  type FinalizeOuterLaneResult,
  type RestoreResult
} from './finalize'
import { createLaneAdapter, type ElectronRestoreRunResult, type LaneEnsureResult, maybeRestoreElectron } from './lanes'
import type { LaneLease } from './lease'
import { type LaneId, type LockAcquireResult, type LockFs, type LockOwner, releaseLock } from './lock'
import {
  createLockService,
  createPreparationSeams,
  type LaneEnsureOutcome,
  type PreparationFailureReason,
  type PreparationSeams,
  runLanePreparation
} from './prepare'
import type { Effects } from './types'

// ---------------------------------------------------------------------------
// Deterministic exit codes for the non-finalizer outcomes
// ---------------------------------------------------------------------------

/**
 * Deterministic final exit code when a valid same-checkout opposite-lane lease
 * conflicts (LOCK-007). The lane is never silently switched under another
 * owner's lease.
 */
export const LANE_CONFLICT_EXIT_CODE = 5

/**
 * Deterministic final exit code when preparation failed before any lane work
 * ran (root unresolvable or outer lock unacquirable). No outer ownership
 * exists, so nothing is restored or released.
 */
export const PREPARATION_FAILURE_EXIT_CODE = 6

// ---------------------------------------------------------------------------
// Canonical child environment sanitization
// ---------------------------------------------------------------------------

/**
 * Env var that must never reach a canonical lane child command. It is valid
 * only inside the controlled Electron probe child environment built by
 * effects.ts (`spawnElectronProbe` sets it explicitly); an ambient inherited
 * value would make `pnpm dev` run Electron as plain Node and leave
 * `electron.app` undefined.
 */
export const ELECTRON_RUN_AS_NODE_ENV = 'ELECTRON_RUN_AS_NODE'

/**
 * Return an env suitable for lane preparation and canonical child execution:
 * the caller's env without an ambient `ELECTRON_RUN_AS_NODE`. The input is
 * never mutated — when the variable is absent the same reference is returned
 * (there is nothing to strip), and when present a copy without it is returned
 * so every other variable is preserved intact. Only the controlled probe env
 * built by effects.ts may set `ELECTRON_RUN_AS_NODE`, so this sanitizer
 * deliberately leaves probe env construction outside its contract.
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

/** Options for `runLane`. */
export interface RunLaneOptions {
  /** Explicit ABI lane; never inferred (LOCK-001). */
  lane: LaneId
  /** Explicit executable path or command name (never shell-parsed). */
  command: string
  /** Explicit argv (never shell-parsed). */
  args: readonly string[]
  /** Working directory for the child; default `process.cwd()`. */
  cwd?: string
  /** Environment inspected for an inherited lease and passed to the child; default `process.env`. Never mutated; an ambient `ELECTRON_RUN_AS_NODE` is stripped before lane preparation and child execution. */
  env?: NodeJS.ProcessEnv
  /** Explicit checkout root passed to preparation; default resolved from the project root. */
  checkoutRoot?: string
  /** CI policy flag (LOCK-003); default `process.env.CI === 'true'`. */
  ci?: boolean
  /** Preparation seams (resolver/lease/lock/ensure); default `createPreparationSeams()`. */
  preparationSeams?: PreparationSeams
  /** Injected lock I/O seam shared by default acquisition and release; default real `createLockFs()`. */
  lockFs?: LockFs
  /** Effects used to build the restoration adapter; default `createEffects()`. */
  effects?: Effects
  /** Process executor seams (spawn + parent signal registration); default `createProcessExecutorSeams()`. The same `onSignal` seam also registers the coordinator lifecycle signal guard (preparation through release). */
  processSeams?: ProcessExecutorSeams
}

/** Result of a nested lane run (LOCK-004): the child ran under the inherited lease env. */
export interface NestedRunResult {
  status: 'nested'
  lane: LaneId
  checkoutRoot: string
  /** The inherited lease that proved we are inside the outer lane. */
  lease: LaneLease
  /** The child outcome under the inherited lease env (no finalizer ran). */
  child: ProcessOutcome
  /**
   * SIGINT/SIGTERM captured by the coordinator lifecycle guard while the
   * nested child ran (the guard coexists with the executor's forwarding
   * handlers and never leaks). A failing or signaled child stays the
   * precedence authority; a child that exited 0 after a captured signal
   * yields the conventional signal exit code.
   */
  lifecycleSignal?: FinalizerSignal
  /** Final exit code: the child outcome's own deterministic code, unless the child exited 0 after a captured lifecycle signal. */
  exitCode: number
}

/** Result of a valid same-checkout opposite-lane lease (LOCK-007): no spawn, no release. */
export interface LaneConflictRunResult {
  status: 'lane-conflict'
  lane: LaneId
  checkoutRoot: string
  /** The valid opposite-lane lease that caused the conflict. */
  lease: LaneLease
  exitCode: number
}

/** Result when preparation failed before any lane work: no spawn, no release. */
export interface PreparationFailureRunResult {
  status: 'preparation-failure'
  lane: LaneId
  checkoutRoot: string
  /** The full preparation failure reason (root-resolution or lock-acquire diagnostics). */
  reason: PreparationFailureReason
  exitCode: number
}

/** Result of a completed outer lane run: child executed, then restore/release per policy. */
export interface OuterRunResult {
  status: 'outer'
  lane: LaneId
  checkoutRoot: string
  acquire: LockAcquireResult & { acquired: true }
  owner: LockOwner
  /** Ownership proof passed to `releaseLock` by the finalizer. */
  token: string
  /** The lock file path the finalizer released. */
  lockPath: string
  /** The lane ensure report from preparation (the requested lane was ensured). */
  ensure: LaneEnsureResult
  /**
   * Concrete restoration outcome when the restore adapter resolved (present
   * only for a local outer Node lane whose restoration ran; absent when the
   * policy skipped it or the restore seam rejected — the mapped finalizer view
   * is always in `finalize.restore`).
   */
  restoreDetail?: ElectronRestoreRunResult
  /** Full finalizer result: child/restore/release statuses plus the deterministic exit code. */
  finalize: FinalizeOuterLaneResult
  /**
   * SIGINT/SIGTERM captured by the coordinator lifecycle guard for the whole
   * run (preparation, child, restore, and release — including a signal that
   * latched before the child started). Present only when such a signal
   * arrived; a child-produced failure (or a preserved target preparation
   * failure) stays the precedence authority and is never replaced by this
   * exit code.
   */
  lifecycleSignal?: FinalizerSignal
  exitCode: number
}

/** Result when the outer lock was held but the requested lane could not be ensured. */
export interface TargetLaneFailureRunResult {
  status: 'target-lane-failure'
  lane: LaneId
  checkoutRoot: string
  acquire: LockAcquireResult & { acquired: true }
  owner: LockOwner
  token: string
  lockPath: string
  /** The ensure outcome that failed (or rejected) the target lane. */
  ensure: LaneEnsureOutcome
  /** Same contract as `OuterRunResult.restoreDetail`. */
  restoreDetail?: ElectronRestoreRunResult
  /** Full finalizer result: restore/release statuses plus the deterministic exit code. */
  finalize: FinalizeOuterLaneResult
  /**
   * SIGINT/SIGTERM captured by the coordinator lifecycle guard for the whole
   * run (preparation, restore, and release). Present only when such a signal
   * arrived; the preserved target preparation failure stays the precedence
   * authority and is never replaced by this exit code.
   */
  lifecycleSignal?: FinalizerSignal
  exitCode: number
}

/**
 * SIGINT/SIGTERM captured by the coordinator lifecycle guard. The guard is
 * installed before lane preparation and stays active through lock acquisition,
 * target ensure/rebuild, child execution, Electron restoration, and lock
 * release, so a signal can never terminate the coordinator before cleanup
 * completes; it is disposed in a top-level `finally`. The coordinator retains
 * the first signal and never calls `process.exit` from a handler. A captured
 * signal is surfaced as a deterministic signaled runner outcome — the
 * conventional `128 + signalNumber` exit code — when the child itself did not
 * already produce a failing outcome; restore/release diagnostics stay visible
 * on the run result.
 */
export interface FinalizerSignal {
  /** The first captured signal (repeated signals are retained once). */
  signal: NodeJS.Signals
  /** Deterministic conventional exit code: 128 + signal number. */
  exitCode: number
}

/** Discriminated result of `runLane`. */
export type RunLaneResult =
  | NestedRunResult
  | LaneConflictRunResult
  | PreparationFailureRunResult
  | OuterRunResult
  | TargetLaneFailureRunResult

// ---------------------------------------------------------------------------
// Contract mapping helpers
// ---------------------------------------------------------------------------

/** Deterministic exit code of a child outcome when no finalizer runs (nested path). */
function childOutcomeExitCode(outcome: ProcessOutcome): number {
  if (outcome.kind === 'exited') {
    return outcome.code
  }
  if (outcome.kind === 'signaled') {
    return outcome.exitCode
  }
  return CHILD_SPAWN_ERROR_EXIT_CODE
}

/**
 * Map the concrete restoration adapter output into the pure finalizer's
 * `RestoreResult` contract. The finalizer decides whether restoration applies
 * (LOCK-003); the adapter decides the outcome — a performed run is ok only
 * when the Electron lane ensured. The full concrete diagnostics stay in
 * `restoreDetail` on the run result.
 */
function mapRestoreResult(run: ElectronRestoreRunResult): RestoreResult {
  if (run.status === 'skipped') {
    return { status: 'skipped', reason: run.reason }
  }
  return { status: 'performed', ok: run.result.status === 'ok' }
}

/**
 * Concise target-lane failure diagnostic for the finalizer's
 * `targetPreparationFailure` (the full ensure outcome stays on the run result
 * for reporting).
 */
function targetLaneFailureMessage(ensure: LaneEnsureOutcome): string {
  switch (ensure.status) {
    case 'rejected':
      return ensure.error
    case 'rebuild-failed':
      return `lane rebuild failed: ${ensure.rebuild.failures.join('; ') || 'rebuild did not produce a verified binding'}`
    case 'verify-failed':
      return `lane post-rebuild verification failed: ${ensure.verify.failures.join('; ') || 'post-rebuild check did not pass'}`
    case 'ok':
      // Defensive: preparation reports target-lane-failure only on a non-ok ensure.
      return 'lane ensure completed without a lane failure'
  }
}

// ---------------------------------------------------------------------------
// Finalizer wiring (shared by the outer-ownership paths)
// ---------------------------------------------------------------------------

/** Input for the shared finalizer wiring used by `outer-prepared` and `target-lane-failure`. */
interface RunFinalizerInput {
  lane: LaneId
  ci: boolean
  /** True = the child command runs; false = the target lane preparation failed. */
  childRequired: boolean
  /** Concise target preparation failure diagnostic (used when `childRequired` is false). */
  targetPreparationFailure?: { error: string }
  command: string
  args: readonly string[]
  cwd: string
  /** Env the child inherits: the prepared lease env of the held outer acquisition. */
  childEnv: NodeJS.ProcessEnv
  checkoutRoot: string
  token: string
  lockPath: string
  effects: Effects
  processSeams: ProcessExecutorSeams
  /** Lock I/O seam passed to `releaseLock`; default real `createLockFs()`. */
  lockFs?: LockFs
}

/** Result of the shared finalizer wiring. */
interface RunFinalizerResult {
  /** The full finalizer result (child/restore/release/exitCode). */
  finalize: FinalizeOuterLaneResult
  /** The concrete restore outcome when the restore adapter resolved; undefined when skipped/rejected. */
  restoreDetail: ElectronRestoreRunResult | undefined
  /** SIGINT/SIGTERM captured by the coordinator lifecycle guard; undefined when none arrived. */
  lifecycleSignal: FinalizerSignal | undefined
}

/**
 * Parent signals captured for the duration of the coordinator lifecycle.
 * These are the same signals the executor forwards to a running child (LOCK:
 * child signal behavior stays executor-owned); the lifecycle guard
 * additionally captures them so a signal arriving before the child starts,
 * during preparation, or after the executor unregistered its forwarding
 * handlers can never terminate the coordinator before restore/release
 * complete.
 */
const LIFECYCLE_CAPTURED_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM']

/** Live guard state returned by `installLifecycleSignalGuard`. */
interface LifecycleSignalGuard {
  /** The first captured signal; undefined when none arrived during the run. */
  captured: FinalizerSignal | undefined
  /** Unregister every installed handler (idempotent). */
  dispose(): void
}

/**
 * Install the coordinator lifecycle signal guard. SIGINT/SIGTERM arriving at
 * any point before the coordinator returns — during outer lock acquisition,
 * target lane ensure/rebuild, child execution, Electron restoration, or lock
 * release — would otherwise terminate the coordinator mid-flight: a dying
 * process never restores the Electron ABI or releases the lock. The guard:
 *
 *  - never calls `process.exit` — it only retains the first signal;
 *  - never forwards to a child — the executor owns forwarding while the child
 *    runs (the guard and the executor handlers coexist without
 *    double-forwarding);
 *  - records only the first signal (repeated signals are retained once and
 *    never re-run any operation — preparation and finalization are each a
 *    single awaited call);
 *  - unregisters every handler from `dispose`, which the caller invokes in
 *    the top-level `finally` so no listener leaks past the run.
 *
 * Registration failures are best-effort: an unregisterable signal must never
 * abort the run (cleanup still must complete); handlers registered so far stay
 * active.
 */
function installLifecycleSignalGuard(seams: ProcessExecutorSeams): LifecycleSignalGuard {
  const guard: LifecycleSignalGuard = { captured: undefined, dispose: () => {} }
  const unregisters: Array<() => void> = []
  for (const signal of LIFECYCLE_CAPTURED_SIGNALS) {
    try {
      unregisters.push(
        seams.onSignal(signal, () => {
          if (guard.captured === undefined) {
            guard.captured = { signal, exitCode: conventionalExitCode(signal) }
          }
        })
      )
    } catch {
      // Best-effort capture: continue with the handlers registered so far.
    }
  }
  guard.dispose = () => {
    for (const unregister of unregisters) {
      unregister()
    }
    unregisters.length = 0
  }
  return guard
}

/**
 * Deterministic exit code of a nested lane run: the child's own outcome is
 * returned verbatim, except that a child which exited 0 after the lifecycle
 * guard captured a signal yields the conventional signal exit code. A failing
 * or signaled child stays the precedence authority (LOCK-006 at the
 * coordinator boundary).
 */
function nestedRunExitCode(child: ProcessOutcome, lifecycleSignal: FinalizerSignal | undefined): number {
  if (lifecycleSignal !== undefined && child.kind === 'exited' && child.code === 0) {
    return lifecycleSignal.exitCode
  }
  return childOutcomeExitCode(child)
}

/**
 * Synthetic signaled child outcome used when the lifecycle guard latched a
 * signal before the requested child could start: the command never runs, and
 * the finalizer reports this outcome in place of a spawn while restoration and
 * release still run per policy.
 */
function syntheticSignaledOutcome(signal: FinalizerSignal): ProcessOutcome {
  return { kind: 'signaled', signal: signal.signal, exitCode: signal.exitCode }
}

/**
 * True when the finalizer's child run itself produced a failing outcome: a
 * nonzero child exit, a signaled child (the conventional exit code is always
 * nonzero), a spawn error, or a target preparation failure (no child ran).
 * These stay the precedence authority (LOCK-006) over a later-captured
 * finalizer signal.
 */
function childProducedFailure(child: ChildRun): boolean {
  if (!child.ran) {
    return true
  }
  const outcome = child.outcome
  if (outcome.kind === 'exited') {
    return outcome.code !== 0
  }
  if (outcome.kind === 'signaled') {
    return outcome.exitCode !== 0
  }
  return true
}

/**
 * Deterministic final exit code of a run whose lifecycle guard captured a
 * signal: a child-produced failure (or preserved target preparation failure)
 * keeps its own code; an otherwise successful child surfaces the captured
 * signal as the conventional 128 + signal runner outcome. Restore/release
 * failures are never hidden — their statuses stay on the finalize result — but
 * the signal is the runner outcome whenever the child itself did not fail.
 */
function runExitCode(finalize: FinalizeOuterLaneResult, lifecycleSignal: FinalizerSignal | undefined): number {
  if (lifecycleSignal === undefined) {
    return finalize.exitCode
  }
  if (childProducedFailure(finalize.child)) {
    return finalize.exitCode
  }
  return lifecycleSignal.exitCode
}

/**
 * Wire the concrete executor, restoration adapter, and lock release into the
 * pure finalizer's operation seams and run it:
 *
 *  - `runChild` executes the child with `childEnv` (the prepared lease env) —
 *    unless the lifecycle guard already latched a signal, in which case the
 *    requested command never spawns and the child is reported as a synthetic
 *    signaled outcome while restoration/release still run;
 *  - `restore` runs `maybeRestoreElectron` over `createLaneAdapter(effects)`
 *    and maps the concrete outcome into the finalizer contract;
 *  - `release` releases the held lock through `releaseLock` with the returned
 *    checkout root / token / lock path.
 *
 * The finalizer owns the LOCK-003 restore decision and the LOCK-006 exit-code
 * precedence; it releases the lock exactly once on both outer-ownership paths.
 *
 * The lifecycle signal guard is installed by the coordinator (before
 * preparation) and passed in here — `runFinalizer` never installs its own
 * guard, so the same guard state covers preparation and finalization and is
 * disposed exactly once in the coordinator's top-level `finally`.
 */
async function runFinalizer(input: RunFinalizerInput, guard: LifecycleSignalGuard): Promise<RunFinalizerResult> {
  let restoreDetail: ElectronRestoreRunResult | undefined
  // A signal latched before the child would start (during lock acquisition or
  // target ensure/rebuild) skips the requested command: `runChild` reports the
  // synthetic signaled outcome instead of spawning, while restoration and
  // release still run per policy.
  const latched = guard.captured
  const runChild: FinalizeOperations['runChild'] =
    latched !== undefined
      ? () => Promise.resolve(syntheticSignaledOutcome(latched))
      : () =>
          executeProcess(input.processSeams, {
            command: input.command,
            args: input.args,
            cwd: input.cwd,
            env: input.childEnv
          })
  const operations: FinalizeOperations = {
    runChild,
    restore: async () => {
      const concrete = await maybeRestoreElectron(createLaneAdapter(input.effects), {
        lane: input.lane,
        ci: input.ci
      })
      restoreDetail = concrete
      return mapRestoreResult(concrete)
    },
    release: () =>
      releaseLock({
        checkoutRoot: input.checkoutRoot,
        token: input.token,
        lockPath: input.lockPath,
        ...(input.lockFs !== undefined ? { fs: input.lockFs } : {})
      })
  }
  const finalize = await finalizeOuterLane({
    lane: input.lane,
    ci: input.ci,
    childRequired: input.childRequired,
    ...(input.targetPreparationFailure !== undefined
      ? { targetPreparationFailure: input.targetPreparationFailure }
      : {}),
    lockPath: input.lockPath,
    operations
  })
  return { finalize, restoreDetail, lifecycleSignal: guard.captured }
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

/**
 * Run one explicit ABI lane to completion and return a structured, discriminated
 * result whose `exitCode` is the deterministic final exit code.
 *
 * CI resolves from the explicit `ci` option first, otherwise from
 * `process.env.CI === 'true'`. The caller's environment is never mutated and
 * is sanitized by `stripElectronRunAsNode` before lane preparation and child
 * execution, so an ambient `ELECTRON_RUN_AS_NODE` can never reach a canonical
 * child command: the nested child inherits the sanitized env (the lease is
 * already there), and the outer child inherits the prepared lease env built
 * from the sanitized base.
 *
 * The coordinator lifecycle signal guard is installed before preparation and
 * disposed in the top-level `finally`, so a SIGINT/SIGTERM during lock
 * acquisition, target ensure/rebuild, child execution, Electron restoration,
 * or lock release can never terminate the coordinator before cleanup
 * completes. A signal latched before the requested child starts skips that
 * command (synthetic signaled outcome through the finalizer path) while
 * restoration/release still run.
 */
export async function runLane(options: RunLaneOptions): Promise<RunLaneResult> {
  const lane = options.lane
  const command = options.command
  const args = options.args
  const cwd = options.cwd ?? process.cwd()
  const runEnv = options.env ?? process.env
  // The caller's env is never mutated: when ELECTRON_RUN_AS_NODE is absent it
  // is passed through by reference, and when present it is copied without that
  // key (canonical lane child commands must not inherit an ambient
  // ELECTRON_RUN_AS_NODE — valid only in the controlled probe env built by
  // effects.ts). Sanitize once here so lane preparation (lease classification
  // and outer child lease-env construction) and the nested child spawn all
  // operate on the sanitized base.
  const sanitizedRunEnv = stripElectronRunAsNode(runEnv)
  const ci = options.ci ?? process.env.CI === 'true'

  const preparationSeams =
    options.preparationSeams ??
    createPreparationSeams(options.lockFs !== undefined ? { lock: createLockService(options.lockFs) } : {})
  const effects = options.effects ?? createEffects()
  const processSeams = options.processSeams ?? createProcessExecutorSeams()

  const guard = installLifecycleSignalGuard(processSeams)
  try {
    const preparation = await runLanePreparation({
      lane,
      checkoutRoot: options.checkoutRoot,
      env: sanitizedRunEnv,
      resolver: preparationSeams.resolver,
      lease: preparationSeams.lease,
      lock: preparationSeams.lock,
      ensure: preparationSeams.ensure
    })

    switch (preparation.status) {
      case 'nested': {
        // LOCK-004: already inside the outer lane's acquisition. Execute the
        // child with the inherited lease env and return its outcome verbatim —
        // no lock, ensure, restore, or release is this coordinator's job here.
        // The lifecycle guard coexists with the executor's forwarding handlers
        // while the child runs; a child that exits 0 after a captured signal
        // yields the conventional signal exit code.
        const child = await executeProcess(processSeams, { command, args, cwd, env: sanitizedRunEnv })
        const lifecycleSignal = guard.captured
        return {
          status: 'nested',
          lane,
          checkoutRoot: preparation.checkoutRoot,
          lease: preparation.lease,
          child,
          ...(lifecycleSignal !== undefined ? { lifecycleSignal } : {}),
          exitCode: nestedRunExitCode(child, lifecycleSignal)
        }
      }

      case 'lane-conflict':
        // LOCK-007: a valid same-checkout opposite-lane lease is an explicit
        // conflict. Never spawn the child and never touch the lock.
        return {
          status: 'lane-conflict',
          lane,
          checkoutRoot: preparation.checkoutRoot,
          lease: preparation.lease,
          exitCode: LANE_CONFLICT_EXIT_CODE
        }

      case 'preparation-failure':
        // No outer ownership exists: nothing to run, restore, or release.
        return {
          status: 'preparation-failure',
          lane,
          checkoutRoot: preparation.checkoutRoot,
          reason: preparation.reason,
          exitCode: PREPARATION_FAILURE_EXIT_CODE
        }

      case 'outer-prepared': {
        // The outer lock is held and the lane is ensured: run the child under
        // the prepared lease env, then restore/release per LOCK-003/LOCK-006.
        const { finalize, restoreDetail, lifecycleSignal } = await runFinalizer(
          {
            lane,
            ci,
            childRequired: true,
            command,
            args,
            cwd,
            childEnv: preparation.leaseEnv,
            checkoutRoot: preparation.checkoutRoot,
            token: preparation.token,
            lockPath: preparation.lockPath,
            effects,
            processSeams,
            lockFs: options.lockFs
          },
          guard
        )
        return {
          status: 'outer',
          lane,
          checkoutRoot: preparation.checkoutRoot,
          acquire: preparation.acquire,
          owner: preparation.owner,
          token: preparation.token,
          lockPath: preparation.lockPath,
          ensure: preparation.ensure,
          ...(restoreDetail !== undefined ? { restoreDetail } : {}),
          finalize,
          ...(lifecycleSignal !== undefined ? { lifecycleSignal } : {}),
          exitCode: runExitCode(finalize, lifecycleSignal)
        }
      }

      case 'target-lane-failure': {
        // The outer lock is held but the lane could not be ensured: the child
        // never runs; the preserved failure still restores and releases per
        // policy because outer ownership exists.
        const { finalize, restoreDetail, lifecycleSignal } = await runFinalizer(
          {
            lane,
            ci,
            childRequired: false,
            targetPreparationFailure: { error: targetLaneFailureMessage(preparation.ensure) },
            command,
            args,
            cwd,
            childEnv: preparation.leaseEnv,
            checkoutRoot: preparation.checkoutRoot,
            token: preparation.token,
            lockPath: preparation.lockPath,
            effects,
            processSeams,
            lockFs: options.lockFs
          },
          guard
        )
        return {
          status: 'target-lane-failure',
          lane,
          checkoutRoot: preparation.checkoutRoot,
          acquire: preparation.acquire,
          owner: preparation.owner,
          token: preparation.token,
          lockPath: preparation.lockPath,
          ensure: preparation.ensure,
          ...(restoreDetail !== undefined ? { restoreDetail } : {}),
          finalize,
          ...(lifecycleSignal !== undefined ? { lifecycleSignal } : {}),
          exitCode: runExitCode(finalize, lifecycleSignal)
        }
      }
    }
  } finally {
    guard.dispose()
  }
}
