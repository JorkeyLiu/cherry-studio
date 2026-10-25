import { loggerService } from '@logger'
import { dbService } from '@renderer/services/db'
import { useAppDispatch, useAppSelector, useAppStore } from '@renderer/store'
import { requireIdsMutableForRoute, selectRouteCapability } from '@renderer/store/routeAnswerGroup'
import { selectActiveBranchId } from '@renderer/store/topicBranch'
import type { TopicSegment } from '@renderer/types/topicSegment'
import { uuid } from '@renderer/utils'
import { convergeTopicSegmentCatalog, mapSegmentWireToTopicSegment } from '@renderer/utils/topicSegmentCatalog'
import { getSegmentColor } from '@renderer/utils/topicSegmentColor'
import { useCallback, useMemo } from 'react'

/**
 * Compatibility helper: index of first messageId present in a loaded index map.
 * NOT an authority catalog primitive — catalog ordering/boundaries/navigation
 * must use authority sortOrder/firstMessageId/lastMessageId/messageCount.
 * Retained only for explicit loaded-local continuity callers; unused by catalog.
 */
export function getSegmentFirstMessageIndex(messageIds: string[], indexMap: Map<string, number>): number {
  for (const id of messageIds) {
    const index = indexMap.get(id)
    if (index !== undefined) return index
  }
  return Infinity
}

const logger = loggerService.withContext('useTopicSegments')

export function useTopicSegments(topicId: string) {
  const dispatch = useAppDispatch()
  const appStore = useAppStore()

  const segmentsEntities = useAppSelector((state) => state.topicSegments.segments.entities)
  const segmentsByTopic = useAppSelector((state) => state.topicSegments.segmentsByTopic)

  const messageIdsForTopic = useAppSelector((state) => state.messages.messageIdsByTopic[topicId] || [])
  const activeBranchId = useAppSelector((state) => selectActiveBranchId(state, topicId))
  // BRANCH-12 capability snapshot from the same store the UI reads —
  // every member must be owned through the active route (zero IPC calls otherwise).
  const routeCapability = useAppSelector((state) => selectRouteCapability(state, topicId))

  const segmentsForTopic = useMemo(() => {
    const ids = segmentsByTopic[topicId] || []
    return ids.map((id) => segmentsEntities[id]).filter(Boolean)
  }, [segmentsEntities, segmentsByTopic, topicId])

  const messageIndexById = useMemo(() => {
    const map = new Map<string, number>()
    messageIdsForTopic.forEach((id, index) => map.set(id, index))
    return map
  }, [messageIdsForTopic])

  const orderedSegmentsForTopic = useMemo(() => {
    // Authority catalog order: Main sortOrder asc, then stable id.
    // Never derived from loaded messageIdsByTopic/windowed indexes.
    return [...segmentsForTopic].sort((a, b) => {
      const ao = typeof a.sortOrder === 'number' && Number.isFinite(a.sortOrder) ? a.sortOrder : Infinity
      const bo = typeof b.sortOrder === 'number' && Number.isFinite(b.sortOrder) ? b.sortOrder : Infinity
      if (ao !== bo) return ao - bo
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
  }, [segmentsForTopic])

  const getSegmentsForTopic = useCallback(
    (tid: string) => {
      const ids = segmentsByTopic[tid] || []
      return ids.map((id) => segmentsEntities[id]).filter(Boolean)
    },
    [segmentsEntities, segmentsByTopic]
  )

  const createSegment = useCallback(
    async (tid: string, name: string, messageIds: string[]): Promise<TopicSegment> => {
      // BRANCH-12: every member must be owned through the active route.
      // Fail closed with
      // zero IPC calls; Main validates the addressed route atomically.
      // Cross-topic intents stay Main-decided (this hook only holds the
      // capability of its own topic).
      if (tid === topicId) {
        requireIdsMutableForRoute(routeCapability, tid, messageIds)
      }
      // DB-first with read-after catalog convergence through the ONE explicit
      // segment-catalog publication path (preserves the resident message
      // window, installs the full authority catalog, no transient blank).
      // Genuine list failure throws typed after fenced invalidation; stale
      // reads discard silently — never a fabricated single-wire success.
      const id = uuid()
      const color = getSegmentColor(id)
      const wire = await dbService.upsertSegment(
        id,
        tid,
        name,
        messageIds,
        color,
        tid === topicId ? activeBranchId : null
      )
      const segment = mapSegmentWireToTopicSegment(wire)
      await convergeTopicSegmentCatalog(dispatch, tid, appStore.getState)
      logger.info(`Created segment "${name}" with ${segment.messageCount} messages`)
      return segment
    },
    [dispatch, topicId, activeBranchId, routeCapability, appStore]
  )

  const updateSegmentName = useCallback(
    async (segmentId: string, name: string) => {
      // DB-first metadata mutation converged through the ONE shared authority
      // catalog publication (preserves the resident window, installs the full
      // catalog). Never a raw `updateSegment` with messageIds — that would
      // invalidate residency and blank until reload.
      const before = appStore.getState() as any
      const existing = before?.topicSegments?.segments?.entities?.[segmentId]
      const tid: string = typeof existing?.topicId === 'string' ? existing.topicId : topicId
      await dbService.updateSegmentMetadata(segmentId, name)
      await convergeTopicSegmentCatalog(dispatch, tid, appStore.getState)
    },
    [dispatch, appStore, topicId]
  )

  const updateSegmentMessageIds = useCallback(
    async (segmentId: string, newMessageIds: string[]) => {
      // BRANCH-12: membership replacement mutates message relations —
      // fail closed with zero IPC calls unless every member is owned.
      // The segment's topic is the hook topic; Main validates atomically.
      requireIdsMutableForRoute(routeCapability, topicId, newMessageIds)
      // DB-first with catalog convergence through the preserving publication
      // path (empty membership deletes in Main; the converged list reflects
      // it). No raw update/remove — those would invalidate the resident
      // window and blank until reload.
      await dbService.replaceSegmentMembership(segmentId, newMessageIds, activeBranchId)
      await convergeTopicSegmentCatalog(dispatch, topicId, appStore.getState)
    },
    [dispatch, activeBranchId, routeCapability, topicId, appStore]
  )

  const deleteSegment = useCallback(
    async (segmentId: string) => {
      // DB-first dissolve with catalog convergence through the preserving
      // publication path. No raw remove — it would invalidate residency.
      const before = appStore.getState() as any
      const existing = before?.topicSegments?.segments?.entities?.[segmentId]
      const tid: string = typeof existing?.topicId === 'string' ? existing.topicId : topicId
      await dbService.deleteSegment(segmentId)
      await convergeTopicSegmentCatalog(dispatch, tid, appStore.getState)
      logger.info(`Deleted segment ${segmentId}`)
    },
    [dispatch, appStore, topicId]
  )

  const getSegmentForMessage = useCallback(
    (messageId: string): TopicSegment | undefined => {
      return segmentsForTopic.find((seg) => seg.messageIds.includes(messageId))
    },
    [segmentsForTopic]
  )

  const getSegmentMessageRange = useCallback(
    (segmentId: string): { firstMessageId: string; lastMessageId: string } | undefined => {
      // Authority boundaries: never array endpoints/loaded indexes.
      const segment = segmentsEntities[segmentId]
      if (!segment || segment.firstMessageId === null || segment.lastMessageId === null) return undefined
      return {
        firstMessageId: segment.firstMessageId,
        lastMessageId: segment.lastMessageId
      }
    },
    [segmentsEntities]
  )

  const isMessageFirstInSegment = useCallback(
    (messageId: string): TopicSegment | undefined => {
      // Authority first boundary; membership includes stays on full messageIds.
      return segmentsForTopic.find((seg) => seg.firstMessageId === messageId)
    },
    [segmentsForTopic]
  )

  const isMessageLastInSegment = useCallback(
    (messageId: string): TopicSegment | undefined => {
      // Authority last boundary; membership includes stays on full messageIds.
      return segmentsForTopic.find((seg) => seg.lastMessageId === messageId)
    },
    [segmentsForTopic]
  )

  const isMessageInSegment = useCallback(
    (messageId: string): TopicSegment | undefined => {
      return segmentsForTopic.find((seg) => seg.messageIds.includes(messageId))
    },
    [segmentsForTopic]
  )

  return useMemo(
    () => ({
      segmentsForTopic,
      orderedSegmentsForTopic,
      messageIndexById,
      getSegmentsForTopic,
      createSegment,
      updateSegmentName,
      updateSegmentMessageIds,
      deleteSegment,
      getSegmentForMessage,
      getSegmentMessageRange,
      isMessageFirstInSegment,
      isMessageLastInSegment,
      isMessageInSegment
    }),
    [
      segmentsForTopic,
      orderedSegmentsForTopic,
      messageIndexById,
      getSegmentsForTopic,
      createSegment,
      updateSegmentName,
      updateSegmentMessageIds,
      deleteSegment,
      getSegmentForMessage,
      getSegmentMessageRange,
      isMessageFirstInSegment,
      isMessageLastInSegment,
      isMessageInSegment
    ]
  )
}
