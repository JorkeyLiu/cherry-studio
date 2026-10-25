import type { TopicSegment } from '@renderer/types/topicSegment'

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
  /** First reachable member in effective-route order (navigation target); null when empty. */
  firstMessageId: string | null
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
  segments: readonly TopicSegment[]
): RouteScopedSegment[] {
  if (routeMessageIds.length === 0 || segments.length === 0) return []

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

    const item: RouteScopedSegment = {
      id: segment.id,
      name: segment.name,
      sortOrder: segment.sortOrder,
      memberIds,
      messageCount: memberIds.length,
      firstMessageId: memberIds[0] ?? null
    }
    if (typeof segment.color === 'string') item.color = segment.color
    projected.push({ segment: item, routePosition })
  }

  // Effective-route position of the first reachable member, never catalog order.
  return projected.sort(compareRoutePosition).map((entry) => entry.segment)
}
