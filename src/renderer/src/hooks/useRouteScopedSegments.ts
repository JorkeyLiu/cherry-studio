import { loggerService } from '@logger'
import { dbService } from '@renderer/services/db'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { useAppSelector, useAppStore } from '@renderer/store'
import { selectHistoryReferenceForTopic } from '@renderer/store/newMessage'
import { selectActiveBranchId } from '@renderer/store/topicBranch'
import {
  type CommittedChromeProjection,
  committedChromeRouteKey,
  projectCommittedChromeFromStructure,
  selectOrderedSegmentsForTopic,
  type TopicSegmentCatalogState
} from '@renderer/utils/routeCommittedChrome'
import type { RouteScopedSegment } from '@renderer/utils/topicSegmentRoute'
import type { FetchMessagesWindowStructure, HistoryReferenceMeta } from '@shared/chatDb'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useTopicSegments } from './useTopicSegments'

const logger = loggerService.withContext('useRouteScopedSegments')

/** Coalescing window shared with the conversation-navigation refetch pattern. */
export const ROUTE_SEGMENTS_REFRESH_DEBOUNCE_MS = 250

/**
 * Minimal latest-window size for the caller-local structural read. The window
 * rows are intentionally ignored (never committed to Redux); only the bundled
 * same-transaction structure is consumed. `1` requests a single viewport group
 * and Main still expands a shared askId run whole, so this never splits a
 * group and never scales with history length.
 */
export const ROUTE_STRUCTURE_WINDOW_LIMIT = 1

export interface RouteScopedSegmentsResult {
  /** Topic-wide catalog projected onto the active route, in bundled catalog order. */
  segments: RouteScopedSegment[]
  /** Token identifying the route the projection is valid for (`topic::branch`). */
  routeKey: string
  /**
   * Whether `segments` is the accepted projection for `routeKey`
   * (`structureKey === routeKey` with a catalog). While a route switch is
   * pending this is false and `segments` is intentionally empty so
   * navigation surfaces (drawer) hide rather than list the previous route.
   * In-flow chrome MUST NOT blank on this signal: it must keep rendering
   * the retained previous route's entries while the mounted window still
   * belongs to that route, so the visible window and the group structure
   * always belong to the same accepted route.
   */
  isCurrent: boolean
  /**
   * Committed window structure owned by this hook (the single chat-surface
   * owner) and shared through the provider. `Messages` reads it as the
   * displayed route's retention fallback; it is never a second projection
   * writer or a second read.
   */
  committedChrome: CommittedChromeProjection | null
  /**
   * Synchronous acceptance of an already-committed deferred window structure.
   * Production callers invoke it only after the receipt late guard and inside
   * the atomic commit's `onPublish`; the hook still re-validates topic/route
   * echo, the current selected route, and (when supplied) the receipt-bound
   * route generation from the existing topicBranch token — an away-and-back
   * excursion therefore cannot re-accept an older receipt. A missing/mismatched
   * structure fails closed; a present-but-empty structure clears only this route.
   */
  acceptCommittedStructure: (
    topicId: string,
    branchId: string | null,
    structure: FetchMessagesWindowStructure | null,
    reference?: HistoryReferenceMeta | null,
    receiptRouteGeneration?: number
  ) => void
}

interface TopicWithUpdatedAt {
  id: string
  updatedAt?: string
}

/**
 * Chrome-relevant identity of a topic's ACCEPTED segment catalog.
 *
 * The catalog is the only authority that decides which route rows belong to a
 * group, so an accepted catalog change (membership, order, display fields, head
 * identity, head owner) can change THIS route's projection even when the route
 * itself never moved: a committed paste appends rows that a group gains while
 * this hook's cached structure predates them, and intersecting the new catalog
 * with those old rows silently drops the new group.
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
 *   this hook reads its own bundled structure and never consumes the catalog's.
 * - `folded` — retired wire-compat field, never live state.
 */
/** Minimal chrome identity slice, satisfied by both store segments and a bundled wire catalog. */
export interface SegmentChromeTokenInput {
  id: string
  name?: string | null
  color?: string | null
  sortOrder: number
  headerMessageId?: string | null
  ownerTopicId?: string | null
  ownerBranchId?: string | null
  messageIds: readonly string[]
}

export function segmentCatalogChromeToken(segments: readonly SegmentChromeTokenInput[]): string {
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

/** Chrome-relevant identity of a resident history reference relation. */
export function routeReferenceChromeToken(reference: HistoryReferenceMeta | null | undefined): string {
  if (!reference) return ''
  return [
    `${reference.sourceTopicId}|${reference.sourceBranchId ?? 'main'}|${reference.anchorMessageId}|${reference.status}|${reference.boundaryMessageId ?? ''}`,
    ...(reference.layers ?? []).map(
      (layer) =>
        `${layer.targetTopicId}:${layer.sourceTopicId}:${layer.sourceBranchId ?? 'main'}:${layer.anchorMessageId}:${layer.boundaryMessageId ?? ''}`
    )
  ].join(',')
}

type RouteRefreshReason = 'updatedAt' | 'reference' | 'catalog' | 'complete'

/**
 * Derive the Inputbar segment navigation list for the ACTIVE route only.
 *
 * The segment catalog is topic-wide, so this hook NEVER filters or rewrites it
 * (the same catalog also drives Messages decoration and segment
 * editing/overlap checks). Instead it performs a caller-local minimal latest
 * window read (`fetchMessagesWindow({ kind: 'latest', limit: 1,
 * includeStructure: true })`) and projects ONLY the bundled same-transaction
 * structure (neutral full catalog + Main-computed route qualification) through
 * `projectCommittedChromeFromStructure`. The returned window rows/blocks are
 * deliberately ignored: they are never committed to Redux, never replace the
 * loaded window, and never trigger bootstrap or generation loading — this is a
 * structural read, not a window read.
 *
 * Turn counts ride bundled qualification verbatim when present; absent
 * remains hidden, never infer from member/catalog count. List order is the
 * bundled catalog order; the
 * committed co-commit path derives the identical projection, so the hook's
 * later acceptance changes nothing visible on the first frame.
 *
 * Refresh/guard mirror the ConversationNavigation pattern:
 * - the route key is derived synchronously every render, so a topic/branch
 *   switch hides the previous route's list on the very first frame, before any
 *   effect runs and while the new structure is still pending;
 * - stale async completions are discarded by generation + route identity and
 *   can never backfill the previous route under the new key;
 * - same-route authority changes (topic `updatedAt`, MESSAGE_COMPLETE, the
 *   resident reference relation for a reference target, and any accepted
 *   change of this topic's segment catalog) coalesce into a debounced refetch
 *   that keeps the current list visible while pending. A missing structure or
 *   a route-echo mismatch fails closed (the last good projection is kept, no
 *   independent backfill); a present-but-empty structure is known-empty and
 *   clears the same route only.
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
  const appStore = useAppStore()
  const historyReference = useAppSelector((state) => selectHistoryReferenceForTopic(state, topicId))
  // The token covers the relation AND every materialized chain layer, so a
  // deeper layer appearing/disappearing (an upstream boundary entering or
  // leaving the route) also invalidates the route list like any other
  // authority change of the same route.
  const referenceToken = routeReferenceChromeToken(historyReference)

  const hasCatalog = orderedSegmentsForTopic.length > 0
  // Accepted-catalog identity for the same-route refresh trigger (see
  // `segmentCatalogChromeToken`). Value-based, so an identical accepted catalog
  // never causes a read.
  const catalogToken = useMemo(() => segmentCatalogChromeToken(orderedSegmentsForTopic), [orderedSegmentsForTopic])
  const activeRouteKey = `${topicId}::${activeBranchId ?? 'main'}`

  const [acceptedSegments, setAcceptedSegments] = useState<RouteScopedSegment[]>([])
  const [structureKey, setStructureKey] = useState<string>('')
  const [committedChrome, setCommittedChrome] = useState<CommittedChromeProjection | null>(null)

  const generationRef = useRef(0)
  const mountedRef = useRef(true)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pendingRefreshReasonsRef = useRef<Set<RouteRefreshReason>>(new Set())
  // Set only by acceptance of the selected route. The route effect skips its
  // clear/refetch when the accepted key still matches the route it is running
  // for (e.g. a same-commit catalog flip), so an accepted window is never
  // erased by an effect that predates it. A real route switch changes the key
  // and clears this marker before any later acceptance can apply.
  const acceptedRouteKeyRef = useRef<string | null>(null)
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

  const fetchRouteStructure = useCallback(
    async (targetTopicId: string, targetBranchId: string | null, targetRouteKey: string, gen: number) => {
      try {
        // Caller-local structural read: a minimal latest window whose rows are
        // never consumed. Only `structure` (same-transaction neutral catalog +
        // route qualification) is projected. No Redux commit, no bootstrap or
        // generation loading is triggered by this direct data-source call.
        const response = await dbService.fetchMessagesWindow({
          kind: 'latest',
          topicId: targetTopicId,
          branchId: targetBranchId,
          limit: ROUTE_STRUCTURE_WINDOW_LIMIT,
          includeStructure: true
        })
        if (!mountedRef.current || gen !== generationRef.current) return
        if (targetTopicId !== topicRef.current || targetBranchId !== branchRef.current) return
        const structure = response.structure ?? null
        // Missing structure fails closed: keep the last good projection, no
        // independent backfill via listSegments/whole-snapshot.
        if (!structure) return
        // Route echo must match the addressed route; otherwise fail closed
        // (never project a stale/other-route structure).
        if (structure.route.topicId !== targetTopicId) return
        if ((structure.route.branchId ?? null) !== (targetBranchId ?? null)) return
        const projected = projectCommittedChromeFromStructure({
          topicId: targetTopicId,
          branchId: targetBranchId,
          structure
        })
        if (!mountedRef.current || gen !== generationRef.current) return
        if (targetTopicId !== topicRef.current || targetBranchId !== branchRef.current) return
        if (projected) {
          setAcceptedSegments(projected.segments)
          setStructureKey(targetRouteKey)
          return
        }
        // Present-but-empty structure is known-empty (empty catalog or zero
        // reachable members): accept the empty projection so the same route
        // clears its stale entries instead of lingering.
        setAcceptedSegments([])
        setStructureKey(targetRouteKey)
      } catch (error) {
        // Fail-closed: the route-boundary guard has already hidden the old
        // list; a background refetch failure retains the last good projection.
        if (!mountedRef.current || gen !== generationRef.current) return
        if (targetTopicId !== topicRef.current || targetBranchId !== branchRef.current) return
        logger.warn('Route-scoped segment structure read failed', error as Error)
      }
    },
    []
  )

  const armDebouncedRefetch = useCallback(() => {
    const targetTopic = topicRef.current
    const targetBranch = branchRef.current
    const targetRouteKey = `${targetTopic}::${targetBranch ?? 'main'}`
    if (!targetTopic || !hasCatalogRef.current) {
      pendingRefreshReasonsRef.current.clear()
      return
    }
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = undefined
      if (!mountedRef.current) return
      if (topicRef.current !== targetTopic || branchRef.current !== targetBranch) return
      if (!hasCatalogRef.current) {
        pendingRefreshReasonsRef.current.clear()
        return
      }
      pendingRefreshReasonsRef.current.clear()
      const gen = generationRef.current + 1
      generationRef.current = gen
      void fetchRouteStructure(targetTopic, targetBranch, targetRouteKey, gen)
    }, ROUTE_SEGMENTS_REFRESH_DEBOUNCE_MS)
  }, [fetchRouteStructure])

  const scheduleDebouncedRefetch = useCallback(
    (reason: RouteRefreshReason) => {
      pendingRefreshReasonsRef.current.add(reason)
      armDebouncedRefetch()
    },
    [armDebouncedRefetch]
  )

  /**
   * Single writer for the surface's committed window structure. Kept in the
   * hook so the provider is the one owner shared by `Messages` and the drawer:
   * no local `useState` copy, no second projection path. Only already-committed
   * deferred windows reach here (production callers invoke it from `onPublish`
   * AFTER the receipt late guard), but the echo/current-route checks are
   * repeated here so an out-of-turn caller can never poison this route.
   *
   * A receipt-bound route generation, when supplied, is checked against the
   * existing topicBranch token before any write. Rebaselines catalog/reference
   * from the LIVE store (`getState`, not a stale render closure) only when the
   * receipt-bound token equals the current one;
   * if the current token has already advanced, the refresh is deliberately
   * kept instead of swallowing a later mutation. No new clock or cache.
   */
  const acceptCommittedStructure = useCallback(
    (
      targetTopicId: string,
      targetBranchId: string | null,
      structure: FetchMessagesWindowStructure | null,
      reference?: HistoryReferenceMeta | null,
      receiptRouteGeneration?: number
    ): void => {
      if (!mountedRef.current || !targetTopicId || !structure) return
      if (targetTopicId !== topicRef.current || (targetBranchId ?? null) !== branchRef.current) return
      if (structure.route.topicId !== targetTopicId) return
      if ((structure.route.branchId ?? null) !== (targetBranchId ?? null)) return
      const state = appStore.getState()
      // Existing route token, not a new clock: a receipt captured before an
      // A-B-A excursion cannot be re-accepted under the same route value.
      if (typeof receiptRouteGeneration === 'number') {
        const currentRouteGeneration =
          (state as unknown as { topicBranch?: { routeGenerationByTopic?: Record<string, number> } }).topicBranch
            ?.routeGenerationByTopic?.[targetTopicId] ?? 0
        if (currentRouteGeneration !== receiptRouteGeneration) return
      }
      const targetRouteKey = committedChromeRouteKey(targetTopicId, targetBranchId)
      if (targetRouteKey !== `${topicRef.current}::${branchRef.current ?? 'main'}`) return
      try {
        const projected = projectCommittedChromeFromStructure({
          topicId: targetTopicId,
          branchId: targetBranchId,
          structure
        })
        // A late direct read for this same route must never overwrite the
        // accepted window; advance the generation BEFORE publishing state.
        generationRef.current += 1
        setAcceptedSegments(projected?.segments ?? [])
        setStructureKey(targetRouteKey)
        acceptedRouteKeyRef.current = targetRouteKey
        setCommittedChrome((prev) => {
          if (projected) return projected
          // Present-but-empty clears only the same route's committed residue.
          return prev && prev.routeKey === targetRouteKey ? null : prev
        })

        const currentCatalogToken = segmentCatalogChromeToken(
          selectOrderedSegmentsForTopic(state as unknown as TopicSegmentCatalogState, targetTopicId)
        )
        if (currentCatalogToken === segmentCatalogChromeToken(structure.catalog)) {
          catalogBaselineRef.current = currentCatalogToken
          latestCatalogTokenRef.current = currentCatalogToken
          pendingRefreshReasonsRef.current.delete('catalog')
        }
        // The reference is receipt-bound at the four production call sites;
        // when omitted (e.g. a direct hook consumer) it is not rebased at all.
        if (reference !== undefined) {
          const currentReferenceToken = routeReferenceChromeToken(selectHistoryReferenceForTopic(state, targetTopicId))
          if (currentReferenceToken === routeReferenceChromeToken(reference)) {
            referenceBaselineRef.current = currentReferenceToken
            latestReferenceTokenRef.current = currentReferenceToken
            pendingRefreshReasonsRef.current.delete('reference')
          }
        }
        if (pendingRefreshReasonsRef.current.size === 0) {
          if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current)
            debounceTimerRef.current = undefined
          }
        } else if (!debounceTimerRef.current) {
          armDebouncedRefetch()
        }
      } catch {
        // Fail-closed: a malformed structure leaves the last accepted state.
      }
    },
    [appStore, armDebouncedRefetch]
  )

  // 1) mount / topic or branch switch: drop the previous route's projection at
  // once and load the new route. The synchronous key guard below already hides
  // the old list on the first render under the new key, before this runs. This
  // fetch also (re)establishes the same-route refresh baseline.
  useEffect(() => {
    const routeKey = `${topicId}::${activeBranchId ?? 'main'}`
    updatedAtBaselineRef.current = latestUpdatedAtRef.current
    referenceBaselineRef.current = latestReferenceTokenRef.current
    catalogBaselineRef.current = latestCatalogTokenRef.current
    // An acceptance for this exact route has already advanced the generation
    // and rebaselined the publication tokens. A same-commit catalog/reference
    // flip must not clear it or re-read the structure we just accepted.
    if (acceptedRouteKeyRef.current === routeKey) return
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = undefined
    }
    pendingRefreshReasonsRef.current.clear()
    acceptedRouteKeyRef.current = null
    const gen = generationRef.current + 1
    generationRef.current = gen
    setAcceptedSegments([])
    setStructureKey('')
    if (!topicId || !hasCatalog) return
    void fetchRouteStructure(topicId, activeBranchId, routeKey, gen)
  }, [topicId, activeBranchId, hasCatalog, fetchRouteStructure])

  // 2) same-route authority mutation metadata: refetch when the current
  // topic's updatedAt changes (baseline seeded by the route effect above).
  useEffect(() => {
    if (!topicId) return
    if (topicUpdatedAt === updatedAtBaselineRef.current) return
    updatedAtBaselineRef.current = topicUpdatedAt
    scheduleDebouncedRefetch('updatedAt')
  }, [topicId, topicUpdatedAt, scheduleDebouncedRefetch])

  // 2b) resident reference relation: a reference target's effective route
  // (foreign read-only prefix) depends on the live source relation. When the
  // resident relation changes (status/boundary/source identity), refetch the
  // route so an invalidated source is reflected without a stale list.
  useEffect(() => {
    if (!topicId) return
    if (referenceToken === referenceBaselineRef.current) return
    referenceBaselineRef.current = referenceToken
    scheduleDebouncedRefetch('reference')
  }, [topicId, referenceToken, scheduleDebouncedRefetch])

  // 2c) accepted segment catalog changed for THIS topic: the collection
  // authority that decides which route rows belong to a group just moved (a
  // committed paste/restore/undo added rows a group — possibly a brand-new
  // group — gains). Re-read the bundled structure after the commit published
  // its rows and its catalog. Value-equal republication never reaches here,
  // and the structure read never writes the catalog, so this cannot feed
  // itself.
  useEffect(() => {
    if (!topicId) return
    if (catalogToken === catalogBaselineRef.current) return
    catalogBaselineRef.current = catalogToken
    scheduleDebouncedRefetch('catalog')
  }, [topicId, catalogToken, scheduleDebouncedRefetch])

  // 3) terminal streaming: MESSAGE_COMPLETE (filtered by topicId) coalesces
  // into the same same-route refetch.
  useEffect(() => {
    if (!topicId) return
    const handler = (payload: { topicId?: string } | undefined) => {
      if (!payload || payload.topicId !== topicId) return
      scheduleDebouncedRefetch('complete')
    }
    const unsubscribe = EventEmitter.on(EVENT_NAMES.MESSAGE_COMPLETE, handler)
    return () => {
      unsubscribe()
    }
  }, [topicId, scheduleDebouncedRefetch])

  const isCurrent = structureKey === activeRouteKey && hasCatalog
  const segments = useMemo(() => (isCurrent ? acceptedSegments : []), [isCurrent, acceptedSegments])

  return useMemo(
    () => ({ segments, routeKey: activeRouteKey, isCurrent, committedChrome, acceptCommittedStructure }),
    [segments, activeRouteKey, isCurrent, committedChrome, acceptCommittedStructure]
  )
}
