import { isGroupHeadOwnedByRoute } from '@renderer/store/routeAnswerGroup'
import type { TopicSegment } from '@renderer/types/topicSegment'
import type { SegmentRouteQualification } from '@shared/chatDb'

import { resolvePresentationStartMessageId } from './routeGroupPresentation'

/**
 * A topic-wide authority segment projected onto one effective route.
 *
 * This is a caller-local, read-only view derived at render time. It never
 * rewrites the persisted catalog (order, membership, boundaries and counts
 * stay untouched); only the projection fields below are route-scoped, and the
 * array handed to the navigator is ordered by route position (see
 * `projectSegmentsOntoRoute`), not by catalog order.
 */
export interface RouteScopedSegment {
  id: string
  name: string
  color?: string
  /** Catalog sortOrder; carried through, and used only to break equal-position ties. */
  sortOrder: number
  /** Reachable members, in effective-route order (not catalog array order). */
  memberIds: string[]
  /** Reachable member count = |members ∩ route|; never the topic-wide count. */
  messageCount: number
  /**
   * Conversation turn count over the route-reachable members: user + same
   * askId answers count as one turn, a system message is one turn, a
   * dangling askId group is one turn, assistant messages without askId are
   * ignored (mirrors `getMessageGroups` length semantics). Includes
   * folded/off-window members; residual groups count current-route reachable
   * members only. Absent on projections whose inputs carry no message
   * roles (commit-time lightweight qualification) — consumers must treat
   * unknown as hidden, never fall back to the catalog message count.
   */
  turnCount?: number
  // Group-level fold is retired: context participation is decided per MESSAGE
  // (`Message.folded`), never per segment. A group is a structural/browsing
  // object, so the route projection carries no fold state to trim or preserve.
  /** First reachable member in effective-route order (window complement); null when empty. */
  firstMessageId: string | null
  /**
   * Stable head identity from Main (the member that was first when the group
   * was created), never re-derived from a renderer window. Null only when the
   * group has no head. The drawer's navigation target is this head — never
   * the first reachable member — so an unloaded head still navigates (the
   * unified path loads its window and settles on its marker when folded).
   */
  headerMessageId: string | null
  /**
   * The group head resolves inside the addressed route's effective sequence.
   * The drawer lists only head-in-route groups; a headless residual keeps its
   * members naturally rendered in the rail but gets no navigation entry.
   */
  headerInRoute: boolean
  /**
   * The group head is owned by the addressed route (owner topic AND branch
   * equality). Only an owning route may change the group's metadata or
   * membership; a non-owner route may still read and navigate.
   */
  headerOwnedByRoute: boolean
  /**
   * Route-stable NORMAL-FLOW slot of this group on the addressed route: the
   * group's first member in effective-route order. It is derived ONLY from the
   * complete route (never from a mounted window), and it is the one member
   * every route that still reaches this group also reaches at the same place —
   * a route's own suffix can only sit after every shared member. The mounted
   * composition hosts the group's one `32px` row at the run containing this
   * message (the header row when `headerInRoute`, an equal-height continuation
   * otherwise), so crossing a fork inside the group never moves that row; a
   * window without it hosts no row at all.
   */
  presentationStartMessageId: string | null
}

/**
 * Addressed route for the authority overlay of {@link projectSegmentsOntoRoute}.
 *
 * `blocks` carries the Main-computed route qualification per group id and wins
 * verbatim over derivation whenever present. Without it the two booleans are
 * derived from Main-returned catalog metadata (stable head + head owner)
 * against the whole-route id set — never from a loaded window.
 */
export interface RouteAuthorityAddress {
  topicId: string
  branchId: string | null
  blocks?: ReadonlyMap<string, SegmentRouteQualification>
}

/**
 * A segment plus its place on the current route, for ordering the projection.
 *
 * `routePosition` is the effective-route index of the segment's first reachable
 * member — the same member the navigator would jump to — so the projected list
 * reads top-to-bottom like the conversation.
 */
interface ProjectedSegment {
  segment: RouteScopedSegment
  routePosition: number
}

/**
 * Route order first (where the group starts on THIS route), then the catalog
 * `sortOrder`/`id` only as a deterministic tie-break for segments that start at
 * the same route position. Catalog order never decides the list by itself.
 */
function compareRoutePosition(a: ProjectedSegment, b: ProjectedSegment): number {
  if (a.routePosition !== b.routePosition) return a.routePosition - b.routePosition
  if (a.segment.sortOrder !== b.segment.sortOrder) return a.segment.sortOrder - b.segment.sortOrder
  return a.segment.id < b.segment.id ? -1 : a.segment.id > b.segment.id ? 1 : 0
}

/**
 * Project the topic-wide authority segment catalog onto one effective route.
 *
 * The segment catalog is topic-wide (effective-route membership is a Main
 * concern; the same catalog also drives Messages decoration and segment
 * editing/overlap checks), so a segment is only reachable on a route when at
 * least one of its members is on that route. This derives that intersection:
 * - members are projected in effective-route order (not the segment's own
 *   member order), so navigation and counts follow the visible route;
 * - a 0-intersection segment is omitted — it belongs to another route (a
 *   parent-only suffix after this route's fork anchor, or a sibling route);
 * - a segment that spans a fork keeps only the reachable intersection and its
 *   first reachable member, so a navigation target is never off-route;
 * - a segment wholly inside the inherited ancestor prefix is preserved;
 * - the returned list is ordered by each segment's first reachable route
 *   position (catalog `sortOrder`/`id` only breaks equal-position ties), so the
 *   navigator follows the conversation instead of catalog creation order.
 *
 * Pure: it never mutates the input catalog and never writes back trimmed
 * membership/counts/order.
 */
export function projectSegmentsOntoRoute(
  routeMessageIds: readonly string[],
  segments: readonly TopicSegment[],
  route?: RouteAuthorityAddress,
  turnMap?: ReadonlyMap<string, number>
): RouteScopedSegment[] {
  if (routeMessageIds.length === 0 || segments.length === 0) return []
  const routeIdSet = new Set(routeMessageIds)

  const projected: ProjectedSegment[] = []
  for (const segment of segments) {
    if (segment.messageIds.length === 0) continue
    const members = new Set(segment.messageIds)
    const memberIds: string[] = []
    // Position of the first reachable member; the earliest occurrence wins, so
    // a duplicated route id can never shift the group later.
    let routePosition = -1
    for (let position = 0; position < routeMessageIds.length; position++) {
      const id = routeMessageIds[position]
      if (!members.has(id)) continue
      if (memberIds.length === 0) routePosition = position
      memberIds.push(id)
    }
    if (memberIds.length === 0) continue
    // Stable head from Main, never re-derived from a renderer window. Legacy
    // catalog rows predate the head contract: fall back to the authority
    // first member exactly like the catalog mapping does.
    const headerMessageId = segment.headerMessageId ?? segment.firstMessageId ?? null
    // The route set IS the whole-route history (the same one-shot read the
    // navigator consumes), never a loaded window — so head presence here is a
    // full-history fact. A Main route block wins verbatim when present.
    const block = route?.blocks?.get(segment.id)
    // A block that disagrees with the addressed route is stale cache, not
    // authority: ignore it and derive from catalog metadata instead.
    const freshBlock =
      block && block.topicId === route?.topicId && (block.branchId ?? null) === (route?.branchId ?? null)
        ? block
        : undefined
    const headerInRoute =
      freshBlock !== undefined ? freshBlock.headerInRoute : headerMessageId !== null && routeIdSet.has(headerMessageId)
    // Mutation authority through the single group-capability helper: the
    // Main-resolved head owner against the addressed route (topic AND
    // branch). Fail-closed — missing owner metadata is never owned. Never a
    // loaded first member, never the selection mutability of this window.
    const headerOwnedByRoute =
      freshBlock !== undefined
        ? freshBlock.headerOwnedByRoute
        : headerMessageId !== null &&
          route !== undefined &&
          isGroupHeadOwnedByRoute(segment, route.topicId, route.branchId)
    // Route-stable normal-flow slot, resolved from the SAME complete-route
    // authority order (`memberIds` is the whole route, never a window) through
    // the single shared derivation. It is independent of `headerInRoute`: the
    // slot is where the group's row lives, the head identity decides what that
    // row shows.
    const presentationStartMessageId = resolvePresentationStartMessageId({ routeMemberIds: memberIds })
    const item: RouteScopedSegment = {
      id: segment.id,
      name: segment.name,
      sortOrder: segment.sortOrder,
      memberIds,
      messageCount: memberIds.length,
      firstMessageId: memberIds[0] ?? null,
      headerMessageId,
      headerInRoute,
      headerOwnedByRoute,
      presentationStartMessageId
    }
    if (typeof segment.color === 'string') item.color = segment.color
    // Conversation turns over the reachable members through the caller-supplied
    // turn map (message id -> turn index, derived from the same whole-route
    // snapshot with getMessageGroups length semantics). Distinct mapped turns
    // only; unmapped members (assistant messages without askId) are excluded.
    // Without a map the count stays unknown — never the member count.
    if (turnMap !== undefined) {
      const turns = new Set<number>()
      for (const id of memberIds) {
        const turn = turnMap.get(id)
        if (turn !== undefined) turns.add(turn)
      }
      if (turns.size > 0) item.turnCount = turns.size
    }
    projected.push({ segment: item, routePosition })
  }

  // Effective-route position of the first reachable member, never catalog order.
  return projected.sort(compareRoutePosition).map((entry) => entry.segment)
}
