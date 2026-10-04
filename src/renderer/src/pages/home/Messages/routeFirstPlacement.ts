/**
 * First-position plan delivery (pre-paint placement attempt).
 *
 * Minimal shared helper behind the Messages pre-paint layout effect: given the
 * current transition plan, attempt the synchronous first scroll for the
 * current session and record the outcome on the plan + controller.
 *
 * Two explicit rules (no timers, no polling, no forced renders):
 * - Exactly-once per plan: a plan whose `outcome` is already recorded never
 *   re-applies, even across retained same-window recommits and unrelated
 *   re-renders. A stale/wrong-phase plan refuses without touching the newer
 *   session (`refused`).
 * - Completion gating: async completions must not commit or fail before the
 *   pre-paint attempt is observed. `isFirstPlacementAwaitingAttempt()` is the
 *   pure gate the completions use to decide "wait for the placement ack"
 *   versus "proceed" — a refused-while-`positioning` stable commit would
 *   otherwise terminate the live plan before it ever placed (branch→main
 *   dirty terminal: displayed stays on the old route while rendered already
 *   shows the new one, and no future user scroll can save).
 */
import type { RouteViewportController } from './routeViewportController'
import {
  applyViewportFirstPosition,
  type ViewportFirstPositionOutcome,
  type ViewportFirstPositionPlan
} from './viewportTransition'

/** Structural shape of the Messages `transitionPlanRef` payload. */
export interface FirstPlacementPending {
  topicId: string
  routeId: string | null
  epoch: number
  plan: ViewportFirstPositionPlan
  outcome: ViewportFirstPositionOutcome | null
}

/**
 * Attempt result: the recorded first-position outcome, or `refused` when the
 * plan is stale/already-consumed/wrong-phase (never touches the new session).
 */
export type FirstPlacementAttemptResult = ViewportFirstPositionOutcome | 'refused'

/**
 * Attempt the explicit first-position outcome for the current session.
 * Records the outcome on `pending` before notifying the controller, so the
 * async completion's placement ack observes a settled plan.
 */
export const attemptFirstPosition = (
  controller: RouteViewportController,
  pending: FirstPlacementPending,
  container: HTMLElement
): FirstPlacementAttemptResult => {
  // Exactly-once replay: an already-attempted plan never re-applies (the
  // recorded outcome stands); the caller treats it as the attempt result.
  if (pending.outcome !== null) return pending.outcome
  if (!controller.isSessionCurrent(pending.epoch)) return 'refused'
  if (controller.currentPhase !== 'positioning') return 'refused'
  let outcome: ViewportFirstPositionOutcome
  try {
    outcome = applyViewportFirstPosition(container, pending.plan)
  } catch {
    // Fail-closed like the historical inline path: an unmeasurable plan is an
    // unplaced plan (the controller terminalizes visibly, preserving the
    // prior snapshot) — never a silent skip.
    outcome = 'unplaced'
  }
  pending.outcome = outcome
  // Re-guarded: a lost race between the checks above and this call refuses
  // without disturbing the newer session.
  if (!controller.firstPositioned(pending.epoch, outcome)) return 'refused'
  return outcome
}

/**
 * Pure completion gate: true only while the current session's plan is still
 * awaiting its pre-paint placement attempt (`positioning` + session-current +
 * outcome unrecorded). Async completions await the placement ack in exactly
 * this case and proceed otherwise — so a commit can never falsely
 * stable/reveal before positive current-plan placement/alignment, and stale
 * sessions never wait.
 */
export const isFirstPlacementAwaitingAttempt = (
  controller: RouteViewportController,
  pending: FirstPlacementPending | null,
  epoch: number
): boolean => {
  if (!pending || pending.epoch !== epoch) return false
  if (pending.outcome !== null) return false
  if (!controller.isSessionCurrent(epoch)) return false
  return controller.currentPhase === 'positioning'
}
