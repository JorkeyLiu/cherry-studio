import { loggerService } from '@logger'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { useAppSelector } from '@renderer/store'
import { selectHistoryReferenceForTopic } from '@renderer/store/newMessage'
import { selectActiveBranchId } from '@renderer/store/topicBranch'
import type { Message } from '@renderer/types/newMessage'
import type { TopicSegment } from '@renderer/types/topicSegment'
import { fetchRouteChromeWires } from '@renderer/utils/routeCommittedChrome'
import type { RouteAuthorityAddress, RouteScopedSegment } from '@renderer/utils/topicSegmentRoute'
import { projectSegmentsOntoRoute } from '@renderer/utils/topicSegmentRoute'
import { loadWholeTopicSnapshot } from '@renderer/utils/topicSnapshot'
import type { SegmentRouteQualification } from '@shared/chatDb'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { getMessageGroups } from './useMessageGroup'
import { useTopicSegments } from './useTopicSegments'

const logger = loggerService.withContext('useRouteScopedSegments')

/** Coalescing window shared with the conversation-navigation refetch pattern. */
export const ROUTE_SEGMENTS_REFRESH_DEBOUNCE_MS = 250

export interface RouteScopedSegmentsResult {
  /** Topic-wide catalog projected onto the active route, ordered by first reachable route position. */
  segments: RouteScopedSegment[]
  /** Token identifying the route the projection is valid for (`topic::branch`). */
  routeKey: string
  /**
   * Whether `segments` is the accepted projection for `routeKey`
   * (`snapshotKey === routeKey` with a catalog). While a route switch is
   * pending this is false and `segments` is intentionally empty so
   * navigation surfaces (drawer) hide rather than list the previous route.
   * In-flow chrome MUST NOT blank on this signal: it must keep rendering
   * the retained previous route's entries while the mounted window still
   * belongs to that route, so the visible window and the group structure
   * always belong to the same accepted route.
   */
  isCurrent: boolean
}

interface TopicWithUpdatedAt {
  id: string
  updatedAt?: string
}
/**
 * Derive message id -> turn index from a whole-route snapshot through
 * `getMessageGroups` length semantics (user + same-askId answers = one turn,
 * a system message = one turn, a dangling askId group = one turn, assistant
 * messages without askId are ignored and map to no turn). Runs over the
 * route-ordered snapshot so group boundaries follow the effective route, and
 * mirrors Main `groupEffectiveTurnsInTx` without a Main/shared change.
 */
export function deriveRouteTurnMap(messages: readonly Message[]): ReadonlyMap<string, number> {
  const groups = getMessageGroups([...messages])
  const map = new Map<string, number>()
  groups.forEach((group, index) => {
    for (const msg of group.messages) map.set(msg.id, index)
  })
  return map
}

/**
 * Chrome-relevant identity of a topic's ACCEPTED segment catalog.
 *
 * The catalog is the only authority that decides which route rows belong to a
 * group, so an accepted catalog change (membership, order, display fields, head
 * identity, head owner) can change THIS route's projection even when the route
 * itself never moved: a committed paste appends rows that a group gains while
 * this hook's cached whole-route id set still predates them, and intersecting
 * the new catalog with those old ids silently drops the new group.
 *
 * Value equality is the point: two reads that accept the same catalog produce
 * the same token, so a repeated/identical publication (including a
 * qualification-only read, which never writes this slice) triggers nothing and
 * the refetch cannot feed itself.
 *
 * Excluded on purpose:
 * - `createdAt`/`updatedAt` — materialization timestamps (a wire without them
 *   synthesizes them per publication); they never describe chrome.
 * - `firstMessageId`/`lastMessageId`/`messageCount` — derived from the same
 *   authority membership that is already part of the token.
 * - `route` — the route-qualified view of whichever route the READER addressed;
 *   this hook reads its own qualification and never consumes the catalog's.
 * - `folded` — retired wire-compat field, never live state.
 */
export function segmentCatalogChromeToken(segments: readonly TopicSegment[]): string {
  const parts: string[] = []
  for (const segment of segments) {
    parts.push(
      [
        segment.id,
        segment.name,
        segment.color ?? '',
        `${segment.sortOrder}`,
        segment.headerMessageId ?? '',
        segment.ownerTopicId ?? '',
        segment.ownerBranchId ?? '',
        segment.messageIds.join(',')
      ].join('|')
    )
  }
  return parts.join(';')
}

/**
 * Derive the Inputbar segment navigation list for the ACTIVE route only.
 *
 * The segment catalog is topic-wide, so this hook NEVER filters or rewrites it
 * (the same catalog also drives Messages decoration and segment
 * editing/overlap checks). Instead it reads the caller-local whole-route
 * snapshot (`loadWholeTopicSnapshot`, the same one-shot `whole-topic`
 * capability ConversationNavigation consumes) and projects the catalog onto
 * that route: members in effective-route order, count = intersection,
 * navigation target = first reachable member, 0-intersection segments hidden,
 * and rows ordered by each segment's first reachable route position (catalog
 * `sortOrder`/`id` only breaks equal-position ties) so the list reads
 * top-to-bottom like the conversation. It therefore never misses an off-screen
 * valid member the way a partial loaded window would.
 *
 * Refresh/guard mirror the ConversationNavigation pattern:
 * - the route key is derived synchronously every render, so a topic/branch
 *   switch hides the previous route's list on the very first frame, before any
 *   effect runs and while the new snapshot is still pending;
 * - stale async completions are discarded by generation + route identity and
 *   can never backfill the previous route under the new key;
 * - same-route authority changes (topic `updatedAt`, MESSAGE_COMPLETE, the
 *   resident reference relation for a reference target, and any accepted
 *   change of this topic's segment catalog) coalesce into a debounced refetch
 *   that keeps the current list visible while pending. The catalog trigger is
 *   what makes a committed collection mutation (paste/restore/undo of rows a
 *   group gains) visible WITHOUT a switch: the projection intersects the NEW
 *   catalog with this hook's cached route id set, so the catalog must be
 *   announced after the commit published its rows. The signal is the accepted
 *   catalog's own content identity — value-equal republication (including a
 *   qualification-only read, which never writes that slice) triggers nothing,
 *   so the refetch cannot feed itself.
 */
export function useRouteScopedSegments(topicId: string): RouteScopedSegmentsResult {
  const { orderedSegmentsForTopic } = useTopicSegments(topicId)
  const activeBranchId = useAppSelector((state) => selectActiveBranchId(state, topicId))
  const topicUpdatedAt = useAppSelector((state) => {
    if (!topicId) return undefined
    const assistants = (
      state as {
        assistants?: { assistants?: Array<{ topics?: TopicWithUpdatedAt[] }> }
      }
    )?.assistants?.assistants
    for (const assistant of assistants ?? []) {
      const topic = assistant.topics?.find((candidate) => candidate.id === topicId)
      if (topic) return topic.updatedAt
    }
    return undefined
  })
  const historyReference = useAppSelector((state) => selectHistoryReferenceForTopic(state, topicId))
  // The token covers the relation AND every materialized chain layer, so a
  // deeper layer appearing/disappearing (an upstream boundary entering or
  // leaving the route) also invalidates the route list like any other
  // authority change of the same route.
  const referenceToken = historyReference
    ? [
        `${historyReference.sourceTopicId}|${historyReference.sourceBranchId ?? 'main'}|${historyReference.anchorMessageId}|${historyReference.status}|${historyReference.boundaryMessageId ?? ''}`,
        ...(historyReference.layers ?? []).map(
          (layer) =>
            `${layer.targetTopicId}:${layer.sourceTopicId}:${layer.sourceBranchId ?? 'main'}:${layer.anchorMessageId}:${layer.boundaryMessageId ?? ''}`
        )
      ].join(',')
    : ''

  const hasCatalog = orderedSegmentsForTopic.length > 0
  // Accepted-catalog identity for the same-route refresh trigger (see
  // `segmentCatalogChromeToken`). Value-based, so an identical accepted catalog
  // never causes a read.
  const catalogToken = useMemo(() => segmentCatalogChromeToken(orderedSegmentsForTopic), [orderedSegmentsForTopic])
  const activeRouteKey = `${topicId}::${activeBranchId ?? 'main'}`

  const [routeMessageIds, setRouteMessageIds] = useState<readonly string[]>([])
  const [snapshotKey, setSnapshotKey] = useState<string>('')
  /**
   * Turn index per message id, derived from the SAME whole-route snapshot as
   * `routeMessageIds` (keyed by `snapshotKey`, so it can never describe a
   * route the ids do not). Drives `turnCount` on the projection; unknown
   * until the snapshot lands, and cleared with the projection on switch.
   */
  const [routeTurnMap, setRouteTurnMap] = useState<ReadonlyMap<string, number> | undefined>(undefined)
  /**
   * Main-computed route qualification per group id, keyed by the route it was
   * addressed to. A SEPARATE caller-local read (`listSegments(topic, branch)`)
   * that never touches the topic-wide authority catalog: the catalog stays
   * complete and route-independent, and this cache is keyed by routeKey so a
   * cross-route backfill can never masquerade as the current route's authority.
   */
  const [routeBlocks, setRouteBlocks] = useState<ReadonlyMap<string, SegmentRouteQualification>>(
    () => new Map<string, SegmentRouteQualification>()
  )
  const [routeBlocksKey, setRouteBlocksKey] = useState<string>('')

  const generationRef = useRef(0)
  const mountedRef = useRef(true)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const topicRef = useRef(topicId)
  const branchRef = useRef<string | null>(activeBranchId)
  const hasCatalogRef = useRef(hasCatalog)
  // Baseline for the same-route refresh triggers. It is seeded from the latest
  // rendered values by the route effect (which is the fetch that establishes
  // the baseline), so a legitimate initial `undefined` updatedAt / "no
  // reference" token / empty catalog token never swallows the first real change
  // — including the catalog-arrival case where only the route effect re-runs.
  const latestUpdatedAtRef = useRef<string | undefined>(topicUpdatedAt)
  const latestReferenceTokenRef = useRef<string>(referenceToken)
  const updatedAtBaselineRef = useRef<string | undefined>(topicUpdatedAt)
  const referenceBaselineRef = useRef<string>(referenceToken)
  const latestCatalogTokenRef = useRef<string>(catalogToken)
  const catalogBaselineRef = useRef<string>(catalogToken)
  topicRef.current = topicId
  branchRef.current = activeBranchId
  hasCatalogRef.current = hasCatalog
  latestUpdatedAtRef.current = topicUpdatedAt
  latestReferenceTokenRef.current = referenceToken
  latestCatalogTokenRef.current = catalogToken

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      generationRef.current += 1
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = undefined
      }
    }
  }, [])

  const fetchRouteSnapshot = useCallback(
    async (targetTopicId: string, targetBranchId: string | null, targetRouteKey: string, gen: number) => {
      // Accepted-catalog identity this read was launched for. The read resolves
      // the route's rows, so it may only be adopted while the catalog it will be
      // intersected with is still the accepted one: a later commit that changed
      // group membership (and published its rows) has already scheduled a newer
      // read, and adopting this one would intersect the NEW catalog with rows
      // that predate it — the new group silently missing until a switch.
      const startedCatalogToken = latestCatalogTokenRef.current
      try {
        const [snap, wires] = await Promise.all([
          loadWholeTopicSnapshot(targetTopicId, targetBranchId),
          // Route qualification: the SAME wires the route-window pipelines bind
          // at commit time (single-flight shared — one IPC for concurrent
          // hook + commit reads, so both derive identical chrome fields).
          // Caller-local only — never touches the topic-wide authority catalog.
          fetchRouteChromeWires(targetTopicId, targetBranchId)
        ])
        if (!mountedRef.current || gen !== generationRef.current) return
        if (targetTopicId !== topicRef.current || targetBranchId !== branchRef.current) return
        if (startedCatalogToken !== latestCatalogTokenRef.current) return
        setRouteMessageIds(snap.messages.map((message) => message.id))
        setRouteTurnMap(deriveRouteTurnMap(snap.messages))
        setSnapshotKey(targetRouteKey)
        const blocks = new Map<string, SegmentRouteQualification>()
        for (const wire of wires) {
          // Only the block addressed to THIS route is authority; anything else
          // is stale cache and the projection ignores it (see freshBlock).
          if (wire.route && wire.route.topicId === targetTopicId) {
            blocks.set(wire.id, wire.route)
          }
        }
        setRouteBlocks(blocks)
        setRouteBlocksKey(targetRouteKey)
      } catch (error) {
        // Fail-closed: the route-boundary guard has already hidden the old
        // list; a background refetch failure retains the last good projection.
        // Route blocks keep their keyed cache: without a fresh read the
        // projection derives authority from catalog metadata instead of
        // pretending a failed fetch is current.
        if (!mountedRef.current || gen !== generationRef.current) return
        if (targetTopicId !== topicRef.current || targetBranchId !== branchRef.current) return
        logger.warn('Route-scoped segment snapshot read failed', error as Error)
      }
    },
    []
  )

  const scheduleDebouncedRefetch = useCallback(() => {
    const targetTopic = topicRef.current
    const targetBranch = branchRef.current
    const targetRouteKey = `${targetTopic}::${targetBranch ?? 'main'}`
    if (!targetTopic || !hasCatalogRef.current) return
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = undefined
      if (!mountedRef.current) return
      if (topicRef.current !== targetTopic || branchRef.current !== targetBranch) return
      if (!hasCatalogRef.current) return
      const gen = generationRef.current + 1
      generationRef.current = gen
      void fetchRouteSnapshot(targetTopic, targetBranch, targetRouteKey, gen)
    }, ROUTE_SEGMENTS_REFRESH_DEBOUNCE_MS)
  }, [fetchRouteSnapshot])

  // 1) mount / topic or branch switch: drop the previous route's projection at
  // once and load the new route. The synchronous key guard below already hides
  // the old list on the first render under the new key, before this runs. This
  // fetch also (re)establishes the same-route refresh baseline.
  useEffect(() => {
    updatedAtBaselineRef.current = latestUpdatedAtRef.current
    referenceBaselineRef.current = latestReferenceTokenRef.current
    catalogBaselineRef.current = latestCatalogTokenRef.current
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = undefined
    }
    const gen = generationRef.current + 1
    generationRef.current = gen
    setRouteMessageIds([])
    setRouteTurnMap(undefined)
    setSnapshotKey('')
    // Drop the previous route's qualification with its projection: until the
    // new route's read lands, authority derives from catalog metadata (the
    // blocks key disagrees, so no stale block can masquerade as current).
    setRouteBlocks(new Map<string, SegmentRouteQualification>())
    setRouteBlocksKey('')
    if (!topicId || !hasCatalog) return
    void fetchRouteSnapshot(topicId, activeBranchId, `${topicId}::${activeBranchId ?? 'main'}`, gen)
  }, [topicId, activeBranchId, hasCatalog, fetchRouteSnapshot])

  // 2) same-route authority mutation metadata: refetch when the current
  // topic's updatedAt changes (baseline seeded by the route effect above).
  useEffect(() => {
    if (!topicId) return
    if (topicUpdatedAt === updatedAtBaselineRef.current) return
    updatedAtBaselineRef.current = topicUpdatedAt
    scheduleDebouncedRefetch()
  }, [topicId, topicUpdatedAt, scheduleDebouncedRefetch])

  // 2b) resident reference relation: a reference target's effective route
  // (foreign read-only prefix) depends on the live source relation. When the
  // resident relation changes (status/boundary/source identity), refetch the
  // route so an invalidated source is reflected without a stale list.
  useEffect(() => {
    if (!topicId) return
    if (referenceToken === referenceBaselineRef.current) return
    referenceBaselineRef.current = referenceToken
    scheduleDebouncedRefetch()
  }, [topicId, referenceToken, scheduleDebouncedRefetch])

  // 2c) accepted segment catalog changed for THIS topic: the collection
  // authority that decides which route rows belong to a group just moved (a
  // committed paste/restore/undo added rows a group — possibly a brand-new
  // group — gains). The cached whole-route id set predates those rows, so a
  // projection of the new catalog against it would drop the new group until a
  // switch. Re-read the route after the commit published its rows and its
  // catalog. Value-equal republication never reaches here, and neither read
  // (whole-route snapshot, route qualification) writes the catalog, so this
  // cannot feed itself.
  useEffect(() => {
    if (!topicId) return
    if (catalogToken === catalogBaselineRef.current) return
    catalogBaselineRef.current = catalogToken
    scheduleDebouncedRefetch()
  }, [topicId, catalogToken, scheduleDebouncedRefetch])

  // 3) terminal streaming: MESSAGE_COMPLETE (filtered by topicId) coalesces
  // into the same same-route refetch.
  useEffect(() => {
    if (!topicId) return
    const handler = (payload: { topicId?: string } | undefined) => {
      if (!payload || payload.topicId !== topicId) return
      scheduleDebouncedRefetch()
    }
    const unsubscribe = EventEmitter.on(EVENT_NAMES.MESSAGE_COMPLETE, handler)
    return () => {
      unsubscribe()
    }
  }, [topicId, scheduleDebouncedRefetch])

  const isSnapshotCurrent = snapshotKey === activeRouteKey
  // Blocks are currency-checked independently: a fresh snapshot with a stale
  // (or failed) qualification read still projects — authority then derives
  // from catalog metadata, and the next refresh baseline re-reads both.
  const isBlocksCurrent = routeBlocksKey === activeRouteKey
  const authority = useMemo<RouteAuthorityAddress>(
    () => ({ topicId, branchId: activeBranchId, blocks: isBlocksCurrent ? routeBlocks : undefined }),
    [topicId, activeBranchId, isBlocksCurrent, routeBlocks]
  )
  const isCurrent = isSnapshotCurrent && hasCatalog
  // The turn map is derived from the same snapshot as the ids and shares its
  // currency gate: without a fresh snapshot the projection carries no counts.
  const turnMap = isSnapshotCurrent ? routeTurnMap : undefined
  const segments = useMemo(
    () => (isCurrent ? projectSegmentsOntoRoute(routeMessageIds, orderedSegmentsForTopic, authority, turnMap) : []),
    [isCurrent, routeMessageIds, orderedSegmentsForTopic, authority, turnMap]
  )

  return useMemo(() => ({ segments, routeKey: activeRouteKey, isCurrent }), [segments, activeRouteKey, isCurrent])
}
