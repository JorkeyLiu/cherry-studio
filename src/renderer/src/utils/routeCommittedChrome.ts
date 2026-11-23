import type { TopicSegment } from '@renderer/types/topicSegment'
import { resolvePresentationStartMessageId } from '@renderer/utils/routeGroupPresentation'
import type { RouteScopedSegment } from '@renderer/utils/topicSegmentRoute'
import type { FetchMessagesWindowStructure } from '@shared/chatDb'

/**
 * Route-window co-commit chrome (Goal A): the target route's structure bound
 * in the SAME synchronous batch as the window itself.
 *
 * A route switch reveals its window BEFORE the scoped-chrome hook accepts the
 * new route's projection (the hook reads the bundled window structure in a
 * caller-local minimal latest read). In that window-first skew the display
 * kept the outgoing structure and the late acceptance then added/moved the
 * 32px group header rows after reveal. Every route-window pipeline fetches the
 * bundled structure (`includeStructure: true` — neutral catalog plus
 * Main-computed per-group route blocks, no second IPC, no store-catalog join)
 * alongside its window fetch and publishes the projected structure through the
 * commit's own `onPublish` (which runs synchronously inside the atomic commit,
 * before `window/apply`). React batches both state updates into one render:
 * the first visible frame already hosts the target route's group structure,
 * and the hook later accepts the byte-identical projection (same bundled
 * semantics) with no visible change.
 *
 * Fail-closed throughout: a missing structure or route-echo mismatch publishes
 * nothing and the commit proceeds with the pre-existing retained/hook
 * behavior; a group without a fresh route-addressed qualification is omitted
 * (never invented).
 */

/** Route key shape shared with the scoped-chrome hook (`topic::branch`). */
export function committedChromeRouteKey(topicId: string, branchId: string | null): string {
  return `${topicId}::${branchId ?? 'main'}`
}

/** A committed target-route structure, published in the window commit batch. */
export interface CommittedChromeProjection {
  routeKey: string
  segments: RouteScopedSegment[]
}

/** Minimal catalog slice shape; structurally satisfied by the store state. */
export interface TopicSegmentCatalogState {
  topicSegments: {
    segments: { entities: Record<string, TopicSegment | undefined> }
    segmentsByTopic: Record<string, string[] | undefined>
  }
}

/**
 * Ordered authority catalog for one topic, mirroring `useTopicSegments`:
 * Main sortOrder ascending, stable id tie-break. Never derived from a loaded
 * window. Pure read of the committed store state at commit time.
 */
export function selectOrderedSegmentsForTopic(state: TopicSegmentCatalogState, topicId: string): TopicSegment[] {
  const ids = state.topicSegments.segmentsByTopic[topicId] ?? []
  const entities = state.topicSegments.segments.entities
  const list: TopicSegment[] = []
  for (const id of ids) {
    const segment = entities[id]
    if (segment) list.push(segment)
  }
  return list.sort((a, b) => {
    const ao = typeof a.sortOrder === 'number' && Number.isFinite(a.sortOrder) ? a.sortOrder : Infinity
    const bo = typeof b.sortOrder === 'number' && Number.isFinite(b.sortOrder) ? b.sortOrder : Infinity
    if (ao !== bo) return ao - bo
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/**
 * Project the committed chrome directly from a bundled window structure
 * (same-transaction catalog + qualification — no store catalog, no second
 * IPC). The catalog stays neutral: route data never rewrites the topic
 * catalog. Empty catalog is known-empty; an empty projection returns null so
 * the caller can apply the same-route clear semantic (never a cross-route
 * clear).
 */
export function projectCommittedChromeFromStructure(args: {
  topicId: string
  branchId: string | null
  structure: FetchMessagesWindowStructure
}): CommittedChromeProjection | null {
  const { topicId, branchId, structure } = args
  // Route echo must match the addressed route; otherwise fail closed (never
  // project a stale/other-route structure).
  if (structure.route.topicId !== topicId) return null
  if ((structure.route.branchId ?? null) !== (branchId ?? null)) return null
  if (structure.catalog.length === 0) return null
  if (structure.route.qualifications.length === 0) return null
  const routeKey = committedChromeRouteKey(topicId, branchId)
  const qualById = new Map<string, FetchMessagesWindowStructure['route']['qualifications'][number]>(
    structure.route.qualifications.map((q) => [q.segmentId, q] as [string, typeof q])
  )
  const segments: RouteScopedSegment[] = []
  for (const wire of structure.catalog) {
    if (wire.messageIds.length === 0) continue
    const q = qualById.get(wire.id)
    if (!q) continue
    const memberIds = [...q.routeMemberMessageIds]
    if (memberIds.length === 0) continue
    const headerMessageId = wire.headerMessageId ?? wire.firstMessageId ?? null
    const presentationStartMessageId = resolvePresentationStartMessageId({ routeMemberIds: memberIds })
    const item: RouteScopedSegment = {
      id: wire.id,
      name: wire.name ?? '',
      sortOrder: wire.sortOrder,
      memberIds,
      messageCount: memberIds.length,
      firstMessageId: memberIds[0] ?? null,
      headerMessageId,
      headerInRoute: q.headerInRoute,
      headerOwnedByRoute: q.headerOwnedByRoute,
      presentationStartMessageId
    }
    if (typeof wire.color === 'string') item.color = wire.color
    // Main-computed turn total rides the qualification verbatim. Absent
    // stays absent (unknown-hidden) — never the member count.
    if (typeof q.turnCount === 'number') item.turnCount = q.turnCount
    segments.push(item)
  }
  if (segments.length === 0) return null
  return { routeKey, segments }
}
