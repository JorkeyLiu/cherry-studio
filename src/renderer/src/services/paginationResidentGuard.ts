/**
 * Pagination request applicability guards.
 *
 * Older/newer pagination captures the request identity (topic, route value,
 * route generation, viewport generation, resident applicability generation) at
 * request start and discards the response when any of them moved before
 * publication. These helpers centralize those checks so they can be exercised
 * by focused tests without broad component refactor.
 */

export function captureResidentGeneration(getState: () => unknown, topicId: string): number {
  try {
    return residentGenerationOf(getState(), topicId)
  } catch {
    return 0
  }
}

export function shouldDiscardPaginationForResident(capturedGeneration: number, currentGeneration: number): boolean {
  return (currentGeneration ?? 0) !== (capturedGeneration ?? 0)
}

/**
 * Current active-route generation token (`topicBranch/routeGenerationByTopic`),
 * captured at request start. It advances on every route switch — including an
 * away-and-back excursion that returns the SAME route value — so comparing it
 * at publication rejects a page issued for a route the user has since left.
 * 0 means "never switched" and is a legitimate value.
 */
export function captureRouteGeneration(getState: () => unknown, topicId: string): number {
  try {
    return routeGenerationOf(getState(), topicId)
  } catch {
    return 0
  }
}

function routeGenerationOf(state: unknown, topicId: string): number {
  try {
    const raw = (state as { topicBranch?: { routeGenerationByTopic?: Record<string, unknown> } })?.topicBranch
      ?.routeGenerationByTopic?.[topicId]
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
  } catch {
    return 0
  }
}

function residentGenerationOf(state: unknown, topicId: string): number {
  try {
    const raw = (state as { residentRegistry?: { entries?: Record<string, { applicabilityGeneration?: unknown }> } })
      ?.residentRegistry?.entries?.[topicId]?.applicabilityGeneration
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
  } catch {
    return 0
  }
}

/** Request identity captured when a pagination attempt starts. */
export interface PaginationAttemptSnapshot {
  topicId: string
  route: string | null
  routeGeneration: number
  topicGeneration: number
  residentGeneration: number
}

export interface PaginationAttemptApplicabilityInput {
  /** Store state read AT the decision point (same synchronous block as any commit). */
  state: unknown
  /** Identity captured at request start. */
  request: PaginationAttemptSnapshot
  /** Live values read at the decision point. */
  live: { topicId: string; route: string | null; topicGeneration: number }
}

/**
 * Whether an in-flight pagination response may still be applied.
 *
 * True only when the attempt was issued for the still-selected topic, the
 * still-selected route VALUE, the still-current viewport topic generation, the
 * still-current route generation (rejects away-and-back), and the still-current
 * resident applicability generation (the resident projection the page was
 * computed against has not been evicted/replaced since).
 *
 * Deliberately does NOT include request ownership (token/active) — that is the
 * viewport load state's own predicate — and does NOT read any captured
 * component array: `state` is the CURRENT store state at the decision point.
 */
export function isPaginationAttemptApplicable(input: PaginationAttemptApplicabilityInput): boolean {
  const { state, request, live } = input
  if (!request || !live) return false
  if (live.topicId !== request.topicId) return false
  if ((live.route ?? null) !== (request.route ?? null)) return false
  if (live.topicGeneration !== request.topicGeneration) return false
  if (routeGenerationOf(state, request.topicId) !== request.routeGeneration) return false
  if (shouldDiscardPaginationForResident(request.residentGeneration, residentGenerationOf(state, request.topicId))) {
    return false
  }
  return true
}
