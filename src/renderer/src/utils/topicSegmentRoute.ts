import type { TopicSegment } from '@renderer/types/topicSegment'

/**
 * A topic-wide authority segment projected onto one effective route.
 *
 * This is a caller-local, read-only view derived at render time. It never
 * rewrites the persisted catalog (order, membership, boundaries and counts
 * stay untouched); only the projection fields below are route-scoped.
 */
export interface RouteScopedSegment {
  id: string
  name: string
  color?: string
  sortOrder: number
  /** Reachable members, in effective-route order (not catalog array order). */
  memberIds: string[]
  /** Reachable member count = |members ∩ route|; never the topic-wide count. */
  messageCount: number
  /** First reachable member in effective-route order (navigation target); null when empty. */
  firstMessageId: string | null
}

function compareAuthority(a: RouteScopedSegment, b: RouteScopedSegment): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
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
 * - a segment wholly inside the inherited ancestor prefix is preserved.
 *
 * Pure: it never mutates the input catalog and never writes back trimmed
 * membership/counts/order.
 */
export function projectSegmentsOntoRoute(
  routeMessageIds: readonly string[],
  segments: readonly TopicSegment[]
): RouteScopedSegment[] {
  if (routeMessageIds.length === 0 || segments.length === 0) return []

  const projected: RouteScopedSegment[] = []
  for (const segment of segments) {
    if (segment.messageIds.length === 0) continue
    const members = new Set(segment.messageIds)
    const memberIds: string[] = []
    for (const id of routeMessageIds) {
      if (members.has(id)) memberIds.push(id)
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
    projected.push(item)
  }

  // Authority catalog order, never route-membership order.
  return projected.sort(compareAuthority)
}
