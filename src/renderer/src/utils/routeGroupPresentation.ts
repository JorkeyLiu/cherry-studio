/**
 * Route-stable group presentation resolution (pure, window-independent).
 *
 * A topic-segment group is ONE route projection entity with two INDEPENDENT
 * route facts:
 *
 * - the group's STABLE HEAD IDENTITY (`headerMessageId` + `headerInRoute` +
 *   `headerOwnedByRoute`, all resolved by Main from the complete effective
 *   route). It decides which message the group is addressed by, which message
 *   the drawer navigates to, and which route may mutate the group;
 * - the group's NORMAL-FLOW SLOT: the one `32px` row the group owns in normal
 *   flow. It is anchored on the group's FIRST member in effective-route order
 *   (see {@link resolvePresentationStartMessageId}), because that is the member
 *   every route that still reaches this group also reaches, at the same place:
 *   a route's own suffix can only sit AFTER every shared member. Routing a
 *   group across a fork therefore never moves its slot.
 *
 * The slot decides WHERE the row is; the route qualification decides WHAT the
 * row shows (see {@link resolveGroupSlotHost}):
 *
 * - the group's stable head resolves on this route ⇒ the real header row (pill,
 *   rail hit target, group menu, mutation authority) renders IN the slot — the
 *   row is anchored at the route's first member, never at the head's own later
 *   position;
 * - the head resolves only on ANOTHER route (a route-truncated residual) ⇒ an
 *   equal-height continuation row renders in the SAME slot: the group keeps its
 *   structural boundary and continuous rail without inventing a head identity
 *   for this route, and without hiding its reachable members;
 * - the slot is outside the mounted window ⇒ no row at all: a rail-only
 *   continuation carrier reports geometry with zero in-flow occupancy.
 *
 * The mounted window only crops the slot: it never elects one. A window whose
 * first mounted member is not the slot's message elects nothing, so pagination
 * can never turn a mounted fragment into the group's flow start.
 *
 * This file is intentionally dependency-free (primitives in, primitives out)
 * so the production layout and the unit probes share one derivation.
 */

/**
 * Route-stable normal-flow slot of one projected group: the group's first
 * member in effective-route order.
 *
 * `routeMemberIds` must be the group's members in the addressed route's
 * effective order (the whole route, never a mounted window or a pagination
 * fragment). Returns null for an unreachable group — such a projection is
 * omitted entirely, so a null slot must never be hosted anywhere.
 */
export function resolvePresentationStartMessageId(input: { routeMemberIds: readonly string[] }): string | null {
  const first = input.routeMemberIds[0]
  if (first === undefined || first.length === 0) return null
  return first
}

/**
 * How the group's route-stable normal-flow slot is hosted in one commit.
 *
 * - `header`: the slot is mounted and the group's stable head resolves on this
 *   route — the real header row renders in it;
 * - `continuation`: the slot is mounted but the head lives on another route —
 *   an equal-height continuation row renders in it (same `32px`, same flow
 *   position, no head identity invented);
 * - `rail-only`: no slot row (the slot is outside the mounted window); the
 *   group's visual-top carrying run may still paint the continuous rail with
 *   zero in-flow occupancy;
 * - `none`: the group has no mounted member at all — a stale qualification, so
 *   nothing is hosted (fail-closed).
 */
export type GroupSlotHost = 'header' | 'continuation' | 'rail-only' | 'none'

export function resolveGroupSlotHost(input: {
  /** At least one member of this group is mounted in the current window. */
  hasMountedMember: boolean
  /** The run mounting the route-stable slot message is mounted. */
  slotInWindow: boolean
  /** The group's stable head resolves inside the addressed route. */
  headerInRoute: boolean
}): GroupSlotHost {
  if (!input.hasMountedMember) return 'none'
  if (!input.slotInWindow) return 'rail-only'
  return input.headerInRoute ? 'header' : 'continuation'
}

/**
 * Minimal carrying-run shape the slot lookup needs: only the mounted message
 * ids per run. Runs stay opaque otherwise, so the helper never depends on flow
 * composition, selection chunking, or React.
 */
export interface StableStartCarryingRun {
  messageIds?: readonly string[]
}

/**
 * Index of the run mounting the group's route-stable slot message, in the
 * caller's run order. Returns -1 when no mounted run contains it — the window
 * does not contain the slot, so the composition must host no slot row at all
 * (a rail-only continuation at best) instead of electing a temporary one from
 * the mounted fragments.
 */
export function findStableStartRunIndex(
  runs: readonly (readonly StableStartCarryingRun[])[],
  stableStartMessageId: string | null
): number {
  if (stableStartMessageId === null || stableStartMessageId.length === 0) return -1
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index]
    for (const entry of run) {
      if (entry.messageIds?.includes(stableStartMessageId) === true) return index
    }
  }
  return -1
}
