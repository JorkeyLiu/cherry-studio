import { loggerService } from '@logger'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { useAppSelector } from '@renderer/store'
import { selectHistoryReferenceForTopic } from '@renderer/store/newMessage'
import { selectActiveBranchId } from '@renderer/store/topicBranch'
import type { RouteScopedSegment } from '@renderer/utils/topicSegmentRoute'
import { projectSegmentsOntoRoute } from '@renderer/utils/topicSegmentRoute'
import { loadWholeTopicSnapshot } from '@renderer/utils/topicSnapshot'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useTopicSegments } from './useTopicSegments'

const logger = loggerService.withContext('useRouteScopedSegments')

/** Coalescing window shared with the conversation-navigation refetch pattern. */
export const ROUTE_SEGMENTS_REFRESH_DEBOUNCE_MS = 250

export interface RouteScopedSegmentsResult {
  /** Topic-wide catalog projected onto the active route, ordered by first reachable route position. */
  segments: RouteScopedSegment[]
  /** Token identifying the route the projection is valid for (`topic::branch`). */
  routeKey: string
}

interface TopicWithUpdatedAt {
  id: string
  updatedAt?: string
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
 * - same-route authority changes (topic `updatedAt`, MESSAGE_COMPLETE, and the
 *   resident reference relation for a reference target) coalesce into a
 *   debounced refetch that keeps the current list visible while pending.
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
  const referenceToken = historyReference
    ? `${historyReference.sourceTopicId}|${historyReference.sourceBranchId ?? 'main'}|${historyReference.anchorMessageId}|${historyReference.status}|${historyReference.boundaryMessageId ?? ''}`
    : ''

  const hasCatalog = orderedSegmentsForTopic.length > 0
  const activeRouteKey = `${topicId}::${activeBranchId ?? 'main'}`

  const [routeMessageIds, setRouteMessageIds] = useState<readonly string[]>([])
  const [snapshotKey, setSnapshotKey] = useState<string>('')

  const generationRef = useRef(0)
  const mountedRef = useRef(true)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const topicRef = useRef(topicId)
  const branchRef = useRef<string | null>(activeBranchId)
  const hasCatalogRef = useRef(hasCatalog)
  // Baseline for the same-route refresh triggers. It is seeded from the latest
  // rendered values by the route effect (which is the fetch that establishes
  // the baseline), so a legitimate initial `undefined` updatedAt / "no
  // reference" token never swallows the first real change — including the
  // catalog-arrival case where only the route effect re-runs.
  const latestUpdatedAtRef = useRef<string | undefined>(topicUpdatedAt)
  const latestReferenceTokenRef = useRef<string>(referenceToken)
  const updatedAtBaselineRef = useRef<string | undefined>(topicUpdatedAt)
  const referenceBaselineRef = useRef<string>(referenceToken)
  topicRef.current = topicId
  branchRef.current = activeBranchId
  hasCatalogRef.current = hasCatalog
  latestUpdatedAtRef.current = topicUpdatedAt
  latestReferenceTokenRef.current = referenceToken

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
      try {
        const snap = await loadWholeTopicSnapshot(targetTopicId, targetBranchId)
        if (!mountedRef.current || gen !== generationRef.current) return
        if (targetTopicId !== topicRef.current || targetBranchId !== branchRef.current) return
        setRouteMessageIds(snap.messages.map((message) => message.id))
        setSnapshotKey(targetRouteKey)
      } catch (error) {
        // Fail-closed: the route-boundary guard has already hidden the old
        // list; a background refetch failure retains the last good projection.
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
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = undefined
    }
    const gen = generationRef.current + 1
    generationRef.current = gen
    setRouteMessageIds([])
    setSnapshotKey('')
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
  const segments = useMemo(
    () => (isSnapshotCurrent && hasCatalog ? projectSegmentsOntoRoute(routeMessageIds, orderedSegmentsForTopic) : []),
    [isSnapshotCurrent, hasCatalog, routeMessageIds, orderedSegmentsForTopic]
  )

  return useMemo(() => ({ segments, routeKey: activeRouteKey }), [segments, activeRouteKey])
}
