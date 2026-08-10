/**
 * Pure lane state-transition policy (Phase 2 of the Native ABI Runtime Lane
 * refactor — policy core only).
 *
 * A *lane* is a command run that guarantees the better-sqlite3 binding is in a
 * specific ABI state while it executes. This module is the pure, side-effect-
 * free policy layer of the runtime-lane refactor: it decides *whether* a lane
 * must be rebuilt and *what to do* about it, while every actual operation (a
 * real runtime SQL check, a real source rebuild) is delegated to the injected
 * `LaneAdapter`. No process is spawned, no signal is registered, and no lock
 * is acquired here — the later command-lifecycle runner consumes this policy
 * and provides the live seams.
 *
 * Contracts honored:
 *  - ABI is a runtime contract (LOCK-001): this module never infers a lane
 *    from directories, tests, imports, or module graphs. It only consults the
 *    injected read-only check and the explicit rebuild.
 *  - native:check:* stays read-only (LOCK-002): `check` is only ever used as a
 *    probe. Binding state is switched exclusively through `rebuild`, and only
 *    when the target check failed — check, then rebuild + check.
 *  - Local outer Node lanes restore the Electron ABI 145 default afterwards
 *    (LOCK-003); `shouldRestoreElectron` encodes that policy (a Node lane that
 *    is not CI), and CI skips restoration. Original-command failure precedence
 *    (LOCK-006) is a later lifecycle concern and deliberately absent here.
 *
 * Every result retains the full check/rebuild reports (structured diagnostics
 * and failure lines) so callers can print or aggregate them without re-running
 * any probe.
 */

import { runCheck } from './check'
import type { LaneId } from './lock'
import { runRebuild } from './rebuild'
import type { CheckReport, Effects, RebuildReport } from './types'

/** The injected adapter: read-only check + explicit rebuild, both delegated. */
export interface LaneAdapter {
  /** Read-only lane check (native:check:* semantics; never rebuilds or switches). */
  check(lane: LaneId): CheckReport
  /** Explicit lane rebuild (native:rebuild:* semantics). */
  rebuild(lane: LaneId): Promise<RebuildReport>
}

/** Real adapter wiring: delegates to the existing `runCheck` / `runRebuild`. */
export function createLaneAdapter(effects: Effects): LaneAdapter {
  return {
    check: (lane) => runCheck(effects, lane),
    rebuild: async (lane) => runRebuild(effects, lane)
  }
}

/**
 * Result of ensuring a target lane. The `'ok'` case self-narrows on `rebuilt`:
 * `rebuilt: false` carries no rebuild report (the initial read-only check
 * already passed), while `rebuilt: true` requires the performed rebuild report
 * alongside the initial check and the post-rebuild verification. `'rebuild-failed'`
 * retains the initial check and the failed rebuild report; `'verify-failed'`
 * retains them plus the post-rebuild check that failed. All reports keep their
 * structured diagnostics and failure lines.
 */
export type LaneEnsureResult =
  | {
      status: 'ok'
      lane: LaneId
      /** False = the initial read-only check already passed; no rebuild ran. */
      rebuilt: false
      /** The read-only check that passed. */
      check: CheckReport
      /** Verification; the same report as `check` (no rebuild ran). */
      verify: CheckReport
    }
  | {
      status: 'ok'
      lane: LaneId
      /** True = a rebuild was performed and the post-rebuild check passed. */
      rebuilt: true
      /** The initial (failing) read-only check. */
      check: CheckReport
      /** The rebuild that was performed. */
      rebuild: RebuildReport
      /** Post-rebuild verification. */
      verify: CheckReport
    }
  | { status: 'rebuild-failed'; lane: LaneId; check: CheckReport; rebuild: RebuildReport }
  | { status: 'verify-failed'; lane: LaneId; check: CheckReport; rebuild: RebuildReport; verify: CheckReport }

/**
 * Ensure the target lane: run the read-only check; only when it fails, run the
 * explicit rebuild and verify the lane again with a fresh check. Returns a
 * structured result that retains every check/rebuild report.
 */
export async function ensureLane(adapter: LaneAdapter, lane: LaneId): Promise<LaneEnsureResult> {
  const check = adapter.check(lane)
  if (check.ok) {
    return { status: 'ok', lane, rebuilt: false, check, verify: check }
  }
  const rebuild = await adapter.rebuild(lane)
  if (!rebuild.ok) {
    return { status: 'rebuild-failed', lane, check, rebuild }
  }
  const verify = adapter.check(lane)
  if (!verify.ok) {
    return { status: 'verify-failed', lane, check, rebuild, verify }
  }
  return { status: 'ok', lane, rebuilt: true, check, rebuild, verify }
}

/**
 * Pure policy (LOCK-003): an outer local Node lane must restore the Electron
 * ABI 145 default afterwards. True only for a Node lane running outside CI;
 * Electron lanes and CI runs skip restoration.
 */
export function shouldRestoreElectron(policy: { lane: LaneId; ci: boolean }): boolean {
  return policy.lane === 'node' && !policy.ci
}

/** Why an Electron restoration was skipped. */
export type ElectronRestoreSkipReason = 'non-node-lane' | 'ci-skip'

/** Result of applying the restoration policy to a lane run. */
export type ElectronRestoreRunResult =
  | { status: 'skipped'; reason: ElectronRestoreSkipReason }
  | { status: 'performed'; result: LaneEnsureResult }

/**
 * Apply the restoration policy and run the Electron restore only when it
 * applies. The applicability predicate is single-sourced in
 * `shouldRestoreElectron` (LOCK-003); this only maps a negative answer to the
 * matching skip reason. When skipped, the adapter is never consulted.
 */
export async function maybeRestoreElectron(
  adapter: LaneAdapter,
  policy: { lane: LaneId; ci: boolean }
): Promise<ElectronRestoreRunResult> {
  if (!shouldRestoreElectron(policy)) {
    return {
      status: 'skipped',
      reason: policy.lane !== 'node' ? 'non-node-lane' : 'ci-skip'
    }
  }
  return { status: 'performed', result: await ensureLane(adapter, 'electron') }
}

/**
 * Restore the local Electron ABI 145 default (LOCK-003) through the adapter:
 * check Electron read-only, then rebuild + re-verify only when the check
 * fails. Whether restoration applies at all is
 * `shouldRestoreElectron` / `maybeRestoreElectron`'s decision, not this
 * operation's.
 */
export async function restoreElectronLane(adapter: LaneAdapter): Promise<LaneEnsureResult> {
  return ensureLane(adapter, 'electron')
}
