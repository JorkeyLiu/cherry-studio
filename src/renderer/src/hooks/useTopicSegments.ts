import { loggerService } from '@logger'
import { dbService } from '@renderer/services/db'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { addSegment, removeSegment, updateSegment } from '@renderer/store/topicSegment'
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

  const segmentsEntities = useAppSelector((state) => state.topicSegments.segments.entities)
  const segmentsByTopic = useAppSelector((state) => state.topicSegments.segmentsByTopic)

  const messageIdsForTopic = useAppSelector((state) => state.messages.messageIdsByTopic[topicId] || [])

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
      // DB-first with read-after catalog convergence: the single upsert wire
      // cannot carry shifted siblings, so follow with exactly one list+replace.
      // listSegments failure must not roll back the successful Main mutation:
      // keep at least the new wire visible and log via the safe logger.
      const id = uuid()
      const color = getSegmentColor(id)
      const wire = await dbService.upsertSegment(id, tid, name, messageIds, color)
      const segment = mapSegmentWireToTopicSegment(wire)
      try {
        await convergeTopicSegmentCatalog(dispatch, tid)
      } catch (error) {
        logger.warn('[createSegment] catalog convergence failed, keeping new segment wire', error as Error)
        dispatch(addSegment(segment))
      }
      logger.info(`Created segment "${name}" with ${segment.messageCount} messages`)
      return segment
    },
    [dispatch]
  )

  const updateSegmentName = useCallback(
    async (segmentId: string, name: string) => {
      // DB-first enriched: Redux converges from the Main wire, not fabricated now.
      const wire = await dbService.updateSegmentMetadata(segmentId, name)
      const changes: Record<string, unknown> = {
        name: wire.name ?? name,
        messageIds: [...wire.messageIds],
        sortOrder: wire.sortOrder,
        firstMessageId: wire.firstMessageId,
        lastMessageId: wire.lastMessageId,
        messageCount: wire.messageCount,
        createdAt: wire.createdAt ?? undefined,
        updatedAt: wire.updatedAt ?? new Date().toISOString()
      }
      // Omit color unless the wire carries a legal string (never `color: undefined`).
      if (typeof wire.color === 'string') {
        changes.color = wire.color
      }
      dispatch(updateSegment({ id: segmentId, changes: changes as any }))
    },
    [dispatch]
  )

  const updateSegmentMessageIds = useCallback(
    async (segmentId: string, newMessageIds: string[]) => {
      // DB-first enriched: empty membership deletes per repo semantics (null wire).
      const wire = await dbService.replaceSegmentMembership(segmentId, newMessageIds)
      if (wire === null) {
        dispatch(removeSegment(segmentId))
        return
      }
      dispatch(
        updateSegment({
          id: segmentId,
          changes: {
            messageIds: [...wire.messageIds],
            sortOrder: wire.sortOrder,
            firstMessageId: wire.firstMessageId,
            lastMessageId: wire.lastMessageId,
            messageCount: wire.messageCount,
            updatedAt: wire.updatedAt ?? new Date().toISOString()
          }
        })
      )
    },
    [dispatch]
  )

  const deleteSegment = useCallback(
    async (segmentId: string) => {
      // DB-first
      await dbService.deleteSegment(segmentId)
      dispatch(removeSegment(segmentId))
      logger.info(`Deleted segment ${segmentId}`)
    },
    [dispatch]
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
