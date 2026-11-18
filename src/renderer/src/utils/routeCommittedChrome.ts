import { dbService } from '@renderer/services/db'
import type { TopicSegment } from '@renderer/types/topicSegment'
import { resolvePresentationStartMessageId } from '@renderer/utils/routeGroupPresentation'
import type { RouteAuthorityAddress, RouteScopedSegment } from '@renderer/utils/topicSegmentRoute'
import type { ListSegmentsResponse, SegmentWire } from '@shared/chatDb'

/**
 * Route-window co-commit chrome (Goal A): the lightweight route qualification
 * a window commit binds in the SAME synchronous batch as the window itself.
 *
 * A route switch reveals its window BEFORE the scoped-chrome hook accepts the
 * new route's projection (the hook reads the whole-topic snapshot with bodies
 * plus this same qualification). In that window-first skew the display kept the
 * outgoing structure and the late qualification then added/moved the 32px
 * group header rows after reveal. This module lets a route-window pipeline
 * fetch ONLY the lightweight qualification (`listSegments`, segment metadata
 * plus Main-computed per-group route blocks — no message bodies, no full
 * preload) alongside its window fetch and publish the projected structure
 * through the commit's own `onPublish` (which runs synchronously inside the
 * atomic commit, before `window/apply`). React batches both state updates into
 * one render: the first visible frame already hosts the target route's group
 * structure, and the hook later accepts the byte-identical projection (same
 * single-flight wires) with no visible change.
 *
 * Fail-closed throughout: a failed qualification fetch publishes nothing and
 * the commit proceeds with the pre-existing retained/hook behavior; a group
 * without a fresh route-addressed block is omitted (never invented).
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

/**
 * Single-flight route qualification reads. The scoped-chrome hook and every
 * route-window pipeline address the same (topic, branch): concurrent callers
 * share ONE IPC round-trip, so the committed projection and the hook's later
 * acceptance derive from the identical wire set. Entries are dropped on
 * settle — only concurrent in-flight reads are shared, never retained data.
 */
const inflightChromeWires = new Map<string, Promise<ListSegmentsResponse>>()

export function fetchRouteChromeWires(topicId: string, branchId: string | null): Promise<ListSegmentsResponse> {
  const key = committedChromeRouteKey(topicId, branchId)
  const existing = inflightChromeWires.get(key)
  if (existing) return existing
  const pending = dbService.listSegments(topicId, branchId).finally(() => {
    if (inflightChromeWires.get(key) === pending) inflightChromeWires.delete(key)
  })
  inflightChromeWires.set(key, pending)
  return pending
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
 * Project the authority catalog onto the addressed route from the lightweight
 * qualification wires alone (no whole-route id set, no bodies).
 *
 * Derivation mirrors `projectSegmentsOntoRoute` field-for-field, with the
 * route-member source the Main-computed `route.routeMemberMessageIds`
 * (members of this group on the addressed route's effective sequence, in
 * ROUTE-effective order — the same order the hook intersects, so both
 * projections are byte-identical and acceptance changes nothing visible).
 * A group with no fresh route-addressed block, or with zero reachable
 * members, is omitted exactly like the hook's 0-intersection rule. List order
 * is catalog order; the hook's route-position ordering takes over (invisibly
 * — the drawer is closed mid-switch) when it accepts the same route.
 */
export function projectCommittedChromeSegments(args: {
  topicId: string
  branchId: string | null
  catalog: readonly TopicSegment[]
  wires: readonly SegmentWire[]
}): CommittedChromeProjection | null {
  const { topicId, branchId, catalog, wires } = args
  if (catalog.length === 0 || wires.length === 0) return null
  const routeKey = committedChromeRouteKey(topicId, branchId)
  const byId = new Map<string, SegmentWire>()
  for (const wire of wires) byId.set(wire.id, wire)
  const authority: RouteAuthorityAddress = { topicId, branchId }
  const segments: RouteScopedSegment[] = []
  for (const segment of catalog) {
    if (segment.messageIds.length === 0) continue
    const wire = byId.get(segment.id)
    if (!wire) continue
    // A block addressed to another route is stale cache, never authority —
    // the group is omitted rather than projected from the wrong route.
    const block = wire.route
    const freshBlock =
      block && block.topicId === authority.topicId && (block.branchId ?? null) === (authority.branchId ?? null)
        ? block
        : undefined
    if (!freshBlock) continue
    // Stable head from Main, never re-derived from a renderer window (same
    // fallback as the hook's projection for legacy catalog rows).
    const headerMessageId = segment.headerMessageId ?? segment.firstMessageId ?? null
    const memberIds = [...freshBlock.routeMemberMessageIds]
    if (memberIds.length === 0) continue
    const headerInRoute = freshBlock.headerInRoute
    // Route-stable normal-flow slot from the wire's ROUTE-effective member
    // order (never catalog order, never a window): the same derivation the
    // scoped hook runs, so the committed structure and the hook's later
    // acceptance agree exactly. Independent of `headerInRoute`: the slot is
    // where the group's row lives, the head identity decides what it shows.
    const presentationStartMessageId = resolvePresentationStartMessageId({ routeMemberIds: memberIds })

    // Mutation authority is the Main-computed route qualification verbatim —
    // the same source the hook's projection prefers — so the committed
    // structure and the hook's later acceptance agree exactly.
    const headerOwnedByRoute = freshBlock.headerOwnedByRoute
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
    segments.push(item)
  }
  if (segments.length === 0) return null
  return { routeKey, segments }
}
