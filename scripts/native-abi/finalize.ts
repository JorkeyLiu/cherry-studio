/**
 * Pure finalization policy for an outer native ABI lane (Phase 3b of the
 * Native ABI Runtime Lane refactor — finalization policy core only).
 *
 * `finalizeOuterLane` completes an outer lane run after preparation: it
 * executes the lane child only when requested, restores the local Electron
 * ABI 145 default after the child outcome (or target preparation failure) and
 * before the lock release when the LOCK-003 policy applies, releases the
 * outer lock exactly once, and returns a deterministic structured result with
 * a deterministic final exit code (LOCK-006 precedence).
 *
 * This module is deliberately pure and self-contained: it defines its own
 * injected operation seams (`FinalizeOperations`) and result types and makes
 * no filesystem or process imports. The concrete executor, lane adapter, and
 * lock modules are wired later by the runner phase; the operation seam is the
 * single integration point. The child process outcome shape mirrors the
 * executor contract and the release result mirrors the lock module contract,
 * so the future integration maps one-to-one.
 *
 * Policy honored here (pure decisions):
 *  - The lane is explicit (LOCK-001): the child runs only when
 *    `childRequired` says so — nothing is inferred from directories, tests,
 *    or imports.
 *  - Local outer Node lanes restore the Electron ABI 145 default afterwards
 *    (LOCK-003): restoration runs only for `lane === 'node' && !ci`, after
 *    the child outcome (or target preparation failure) and before the
 *    release. CI Node lanes and Electron lanes skip restoration without
 *    consulting the restore seam.
 *  - Target preparation failures preserve the diagnostic, never run the
 *    child, and — when the outer lock is held (local Node) — still restore
 *    and release.
 *  - The outer lock is released exactly once whenever outer ownership exists
 *    (both the child-required and the target-preparation-failure paths).
 *  - Exit-code precedence (LOCK-006), highest first:
 *      1. a failing child outcome — `exited(code != 0)` preserves the code, a
 *         `signaled` outcome with a nonzero `exitCode` uses its deterministic
 *         exit code, `spawn-error` maps to `CHILD_SPAWN_ERROR_EXIT_CODE` —
 *         always wins over later restore and release failures;
 *      2. a preserved target preparation failure maps to
 *         `TARGET_PREPARATION_FAILURE_EXIT_CODE` and outranks restore/release
 *         failures;
 *      3. a failed restoration (performed-but-not-ok, or a rejected restore
 *         seam) maps to `RESTORE_FAILURE_EXIT_CODE` when the child succeeded;
 *      4. a failed release maps to `RELEASE_FAILURE_EXIT_CODE` — release
 *         failures are observable and never swallowed;
 *      5. everything ok maps to 0.
 *    The structured result always carries the full child/restore/release
 *    statuses, so no failure is hidden behind the compressed exit code.
 *
 * Out of scope in this phase: child execution (`runChild` is an optional
 * injected seam), signal registration, real filesystem/process I/O, and the
 * nested / lane-conflict / pre-lock-preparation-failure pass-throughs — those
 * hold no outer lock (no restore, no release) and are handled by the runner
 * phase.
 */

/** The ABI lanes (mirrors the lock module's `LaneId`; kept local so this pure module has no concrete imports). */
export type LaneId = 'node' | 'electron'

/** Deterministic final exit code for a child that never spawned (spawn-error outcome). */
export const CHILD_SPAWN_ERROR_EXIT_CODE = 1
/** Deterministic final exit code when the target lane preparation failed (the child never ran). */
export const TARGET_PREPARATION_FAILURE_EXIT_CODE = 2
/** Deterministic final exit code when the Electron ABI 145 restoration failed (LOCK-003). */
export const RESTORE_FAILURE_EXIT_CODE = 3
/** Deterministic final exit code when the outer lock release failed (LOCK-006). */
export const RELEASE_FAILURE_EXIT_CODE = 4

/** Why an Electron restoration was skipped (LOCK-003). */
export type RestoreSkipReason = 'non-node-lane' | 'ci-skip'

/** Result of the injected restoration operation. */
export type RestoreResult =
  | { status: 'skipped'; reason: RestoreSkipReason }
  | { status: 'performed'; ok: boolean }
  | { status: 'rejected'; error: string }

/** Result of the injected lock release (mirrors the lock module's `LockReleaseResult` shape, including `lockPath`). */
export type ReleaseResult =
  | { released: true; lockPath: string }
  | { released: false; reason: 'absent' | 'not-owner' | 'error'; error?: string; lockPath: string }

/**
 * Discriminated outcome of a child run (mirrors the executor's
 * `ProcessOutcome` contract): `exited` preserves the child code, `signaled`
 * carries the terminating `NodeJS.Signals` and the deterministic conventional
 * `exitCode`, and `spawn-error` carries the message and the errno code when
 * known.
 */
export type ChildResult =
  | { kind: 'exited'; code: number }
  | { kind: 'signaled'; signal: NodeJS.Signals; exitCode: number }
  | { kind: 'spawn-error'; message: string; code?: string }

/** The child run recorded in the finalization result. */
export type ChildRun =
  | { ran: true; outcome: ChildResult }
  | { ran: false; reason: 'target-preparation-failure'; error: string }

/** Diagnostic carried when the target lane preparation failed (no child ran). */
export interface TargetPreparationFailure {
  error: string
}

/**
 * The injected operation seams. `restore` and `release` are mandatory;
 * `runChild` is optional so callers may either let the finalizer execute the
 * child or supply its outcome directly via `FinalizeOuterLaneParams.child`.
 */
export interface FinalizeOperations {
  /** Perform the Electron ABI 145 restoration (called only when the LOCK-003 policy applies). */
  restore(): Promise<RestoreResult>
  /** Release the outer lock (called exactly once when outer ownership exists). */
  release(): ReleaseResult
  /** Execute the lane child to completion (optional; see `FinalizeOuterLaneParams`). */
  runChild?(): Promise<ChildResult>
}

/** Params for `finalizeOuterLane`. */
export interface FinalizeOuterLaneParams {
  /** Explicit lane (LOCK-001; never inferred). */
  lane: LaneId
  /** CI policy flag (LOCK-003): true skips the Electron restoration. */
  ci: boolean
  /** True = the child command runs; false = the target lane preparation failed. */
  childRequired: boolean
  /**
   * Child outcome used verbatim when `childRequired` is true and no
   * `runChild` seam is provided. Ignored when `runChild` is provided or
   * `childRequired` is false.
   */
  child?: ChildResult
  /** Target preparation failure diagnostic (used when `childRequired` is false). */
  targetPreparationFailure?: TargetPreparationFailure
  /**
   * Lock file path surfaced in the release result when the release seam
   * rejects and returns no result to carry one (defaults to `''` when absent).
   */
  lockPath?: string
  /** Operation seams. */
  operations: FinalizeOperations
}

/** Structured result of an outer lane finalization. */
export interface FinalizeOuterLaneResult {
  lane: LaneId
  /** The child run: the executed outcome when requested; never for a target preparation failure. */
  child: ChildRun
  /** Electron restoration status per the LOCK-003 policy. */
  restore: RestoreResult
  /** The single lock release attempt. */
  release: ReleaseResult
  /** Deterministic final exit code (LOCK-006 precedence; see `computeFinalizeExitCode`). */
  exitCode: number
}

/**
 * Pure LOCK-003 policy: a local outer Node lane must restore the Electron
 * ABI 145 default afterwards. True only for a Node lane outside CI; Electron
 * lanes and CI runs skip restoration. Mirrors the lane module's
 * `shouldRestoreElectron`; the runner phase single-sources this when it wires
 * the real restore seam.
 */
export function shouldRestoreElectron(policy: { lane: LaneId; ci: boolean }): boolean {
  return policy.lane === 'node' && !policy.ci
}

/** Human-readable diagnostic from an unknown seam rejection. */
function rejectionMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Input to `computeFinalizeExitCode`. */
export interface FinalizeExitCodeInput {
  child: ChildRun
  restore: RestoreResult
  release: ReleaseResult
}

/**
 * Deterministic final exit code (LOCK-006). Precedence, highest first: a
 * failing child outcome, a preserved target preparation failure, a failed
 * restoration, a failed release, then success (0). A child that exited 0 — or
 * was signaled with a conventional `exitCode` of 0 — is a success for
 * precedence purposes even when restore/release later fail: the first
 * applicable failure below the child wins.
 */
export function computeFinalizeExitCode(input: FinalizeExitCodeInput): number {
  const { child, restore, release } = input

  if (child.ran) {
    const outcome = child.outcome
    if (outcome.kind === 'exited' && outcome.code !== 0) {
      return outcome.code
    }
    if (outcome.kind === 'signaled' && outcome.exitCode !== 0) {
      return outcome.exitCode
    }
    if (outcome.kind === 'spawn-error') {
      return CHILD_SPAWN_ERROR_EXIT_CODE
    }
  } else {
    // The command never ran: the preserved target preparation failure is the
    // run's original failure and outranks later restore/release failures.
    return TARGET_PREPARATION_FAILURE_EXIT_CODE
  }

  // The child exited 0: a failed restoration is the next failure.
  if (restore.status === 'rejected' || (restore.status === 'performed' && !restore.ok)) {
    return RESTORE_FAILURE_EXIT_CODE
  }

  // A failed release is observable and never swallowed (LOCK-006).
  if (!release.released) {
    return RELEASE_FAILURE_EXIT_CODE
  }

  return 0
}

/**
 * Finalize an outer lane run:
 *
 *  1. Run the child only when requested (`childRequired`): through the
 *     `runChild` seam when provided, otherwise the supplied `child` outcome
 *     is used verbatim (a missing outcome is a deterministic spawn-error). A
 *     rejecting `runChild` seam is a deterministic spawn-error outcome.
 *  2. Restore the local Electron ABI 145 default (LOCK-003) only for a Node
 *     lane outside CI, after the child outcome (or target preparation
 *     failure) and before the release. CI Node lanes and Electron lanes skip
 *     restoration without consulting the seam.
 *  3. Release the outer lock exactly once (outer ownership exists on both the
 *     child-required and the target-preparation-failure paths); a rejecting
 *     release seam is an observable `'error'` release result.
 *
 * The structured result always preserves the child/restore/release statuses
 * alongside the deterministic exit code.
 */
export async function finalizeOuterLane(params: FinalizeOuterLaneParams): Promise<FinalizeOuterLaneResult> {
  const { lane, ci, childRequired, operations } = params

  // 1. Child outcome: run only when requested.
  let child: ChildRun
  if (childRequired) {
    let outcome: ChildResult
    if (operations.runChild !== undefined) {
      try {
        outcome = await operations.runChild()
      } catch (error) {
        outcome = { kind: 'spawn-error', message: rejectionMessage(error) }
      }
    } else {
      outcome = params.child ?? { kind: 'spawn-error', message: 'no child result supplied and no runChild seam' }
    }
    child = { ran: true, outcome }
  } else {
    child = {
      ran: false,
      reason: 'target-preparation-failure',
      error: params.targetPreparationFailure?.error ?? ''
    }
  }

  // 2. Restore (LOCK-003): local outer Node only, after the child outcome and
  //    before the release.
  let restore: RestoreResult
  if (shouldRestoreElectron({ lane, ci })) {
    try {
      restore = await operations.restore()
    } catch (error) {
      restore = { status: 'rejected', error: rejectionMessage(error) }
    }
  } else {
    restore = { status: 'skipped', reason: lane !== 'node' ? 'non-node-lane' : 'ci-skip' }
  }

  // 3. Release the outer lock exactly once (outer ownership).
  let release: ReleaseResult
  try {
    release = operations.release()
  } catch (error) {
    // A rejecting seam returns no result to carry the lock path; surface the
    // caller-supplied one when given ('' when unknown) so the result keeps
    // mirroring the lock module's `LockReleaseResult` shape.
    release = {
      released: false,
      reason: 'error',
      error: rejectionMessage(error),
      lockPath: params.lockPath ?? ''
    }
  }

  return {
    lane,
    child,
    restore,
    release,
    exitCode: computeFinalizeExitCode({ child, restore, release })
  }
}
