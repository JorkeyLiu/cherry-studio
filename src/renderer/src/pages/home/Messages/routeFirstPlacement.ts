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
import type { HistoryReferenceMeta } from '@shared/chatDb'

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

/** Projected window of the CURRENT render commit (never a previous commit's). */
export interface TargetProjectionWindow {
  readonly oldestMessageId?: string
  readonly newestMessageId?: string
  readonly displayMessages: readonly { readonly id: string; readonly topicId?: string }[]
}

/** Minimal session identity the readiness gate compares against. */
export interface TargetProjectionSession {
  readonly topicId: string
  readonly routeId: string | null
  readonly epoch: number
}

export interface TargetProjectionReadinessInput {
  /** The transition plan/epoch this layout pass would place. */
  pending: TargetProjectionSession
  /**
   * Controller's rendered (DOM) provenance record - which topic/route window
   * the committed DOM belongs to. `null` = dirty/unknown render.
   */
  rendered: {
    readonly epoch: number
    readonly topicId: string
    readonly routeId: string | null
    readonly windowId: string
  } | null
  /** `viewportState.window` of the render commit that owns this layout pass. */
  window: TargetProjectionWindow | null | undefined
  /** Main window receipt's reference facts for the addressed topic, if any. */
  reference: HistoryReferenceMeta | null | undefined
  /**
   * The target topic's loaded projection (`undefined` = not resident, i.e. no
   * completeness fact). An explicit `[]` is a proven empty projection.
   */
  loadedProjection: readonly unknown[] | undefined
  /** A window read for the target topic is still in flight. */
  windowReadBusy: boolean
}

/**
 * `ready` = the session's own committed projection is in this render commit;
 * `waiting` = the projection this pass would place is not the target's yet;
 * `observed-empty` = the session's own window is committed AND the target's
 * resident projection is proven empty.
 */
export type TargetProjectionReadiness = 'ready' | 'waiting' | 'observed-empty'

const targetProjectionWindowIdentity = (window: TargetProjectionWindow): string =>
  `${String(window.oldestMessageId ?? '')}::${String(window.newestMessageId ?? '')}::${window.displayMessages.length}`

/** Main's materialized reference layers, nearest first, or null when untrusted. */
const resolveReferenceLayers = (
  reference: HistoryReferenceMeta | null | undefined,
  targetTopicId: string
): readonly HistoryReferenceMeta[] | null => {
  if (!reference || reference.status !== 'available' || reference.sourceTopicId === targetTopicId) return null
  if (reference.layers === undefined) return [reference]
  if (!Array.isArray(reference.layers) || reference.layers.length === 0) return null
  let expectedTarget = targetTopicId
  for (const layer of reference.layers) {
    if (
      !layer ||
      layer.targetTopicId !== expectedTarget ||
      layer.status !== 'available' ||
      typeof layer.sourceTopicId !== 'string' ||
      layer.sourceTopicId.length === 0 ||
      layer.sourceTopicId === expectedTarget ||
      typeof layer.boundaryMessageId !== 'string' ||
      layer.boundaryMessageId.length === 0
    ) {
      return null
    }
    expectedTarget = layer.sourceTopicId
  }
  const nearest = reference.layers[0]
  if (nearest.sourceTopicId !== reference.sourceTopicId || nearest.boundaryMessageId !== reference.boundaryMessageId) {
    return null
  }
  return reference.layers
}

/**
 * A reference target's canonical foreign prefix is ordered oldest layer first
 * in normal flow, hence nearest layer first in `displayMessages`. A layer may
 * be absent when the captured endpoint truncates it; a materialized layer must
 * end at its own Main-provided boundary. The target-owned suffix (possibly
 * empty) is the newest-to-oldest prefix before those foreign rows.
 */
const isCanonicalReferencePrefix = (
  rows: readonly { readonly id: string; readonly topicId?: string }[],
  layers: readonly HistoryReferenceMeta[]
): boolean => {
  let layerIndex = 0
  while (layerIndex < layers.length && layers[layerIndex].sourceTopicId !== rows[0].topicId) layerIndex += 1
  if (layerIndex >= layers.length) return false
  let currentTopicId = rows[0].topicId
  let segmentStart = 0
  for (let index = 1; index <= rows.length; index += 1) {
    const row = rows[index]
    if (row && row.topicId === currentTopicId) continue
    if (rows[segmentStart].id !== layers[layerIndex].boundaryMessageId) return false
    if (!row) return true
    while (layerIndex < layers.length && layers[layerIndex].sourceTopicId !== row.topicId) layerIndex += 1
    if (layerIndex >= layers.length) return false
    currentTopicId = row.topicId
    segmentStart = index
  }
  return false
}

/**
 * The committed window belongs to the current effective route when it is all
 * target-topic rows, or target-owned newest rows followed by the Main-attested
 * canonical foreign prefix. Foreign rows never authorize readiness by
 * themselves: an outgoing/stale window, unknown source, broken layer order, or
 * wrong boundary stays `waiting`.
 */
const isCurrentProjectedWindow = (
  window: TargetProjectionWindow,
  topicId: string,
  reference: HistoryReferenceMeta | null | undefined
): boolean => {
  const rows = window.displayMessages
  let foreignStart = 0
  while (foreignStart < rows.length) {
    const row = rows[foreignStart]
    if (!row || typeof row.id !== 'string' || typeof row.topicId !== 'string') return false
    if (row.topicId !== topicId) break
    foreignStart += 1
  }
  if (foreignStart === rows.length) return true
  const layers = resolveReferenceLayers(reference, topicId)
  return layers !== null && isCanonicalReferencePrefix(rows.slice(foreignStart), layers)
}

/**
 * Readiness of the target projection for the atomic first placement.
 *
 * The pre-paint placement/reveal may only complete on the target projection
 * this transaction actually committed - never on a projection that is still
 * being fetched, not committed yet, or proven only by a previous commit's
 * state. Order matters:
 * - Provenance (`rendered` epoch/topic/route/window identity) must be this
 *   session's exact committed window, or the projection cannot be attributed
 *   to it at all.
 * - The window must be the target route's own rows or its Main-attested
 *   canonical reference prefix plus target-owned suffix. A stale outgoing
 *   window (including A->B->A) stays `waiting`.
 * - A committed non-empty window is immediately `ready`: its rows render in
 *   the same React commit as the window, and unrelated in-flight reads
 *   (topic-level window reads, pagination) cannot delay the atomic reveal.
 * - An empty own window is `observed-empty` only when a read is not in flight
 *   and the target's resident projection is proven empty (`[]`). Otherwise it
 *   is a transient pre-commit projection - `waiting`.
 *
 * Nothing is placed, revealed, acked, or committed while `waiting`; the
 * projection/read/reference commit re-runs the layout pass through the same
 * reactive deps (no timer, no frame poll). No container geometry is consulted
 * (`scrollHeight == clientHeight` is legal for short real content) and no
 * speaker asserts emptiness from the absence of DOM rows.
 */
export const resolveTargetProjectionReadiness = (input: TargetProjectionReadinessInput): TargetProjectionReadiness => {
  const win = input.window
  if (!win || !Array.isArray(win.displayMessages)) return 'waiting'
  const rendered = input.rendered
  if (!rendered) return 'waiting'
  if (rendered.epoch !== input.pending.epoch) return 'waiting'
  if (rendered.topicId !== input.pending.topicId) return 'waiting'
  if (rendered.routeId !== input.pending.routeId) return 'waiting'
  if (rendered.windowId !== targetProjectionWindowIdentity(win)) return 'waiting'
  if (!isCurrentProjectedWindow(win, input.pending.topicId, input.reference)) return 'waiting'
  if (win.displayMessages.length > 0) return 'ready'
  if (input.windowReadBusy) return 'waiting'
  if (!input.loadedProjection) return 'waiting'
  return input.loadedProjection.length === 0 ? 'observed-empty' : 'waiting'
}
