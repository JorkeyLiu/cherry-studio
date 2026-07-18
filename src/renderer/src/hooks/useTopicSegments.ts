import { loggerService } from '@logger'
import db from '@renderer/databases'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { addSegment, removeSegment, updateSegment } from '@renderer/store/topicSegment'
import type { TopicSegment } from '@renderer/types/topicSegment'
import { uuid } from '@renderer/utils'
import { getSegmentColor } from '@renderer/utils/topicSegmentColor'
import { useCallback, useMemo } from 'react'

/**
 * Returns the index of the first message in the segment that still exists in the ordered list.
 * Iterates through messageIds to find the first one present in the index map,
 * which is more robust than using messageIds[0] directly (it may have been deleted).
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
    return [...segmentsForTopic].sort((a, b) => {
      const aIndex = getSegmentFirstMessageIndex(a.messageIds, messageIndexById)
      const bIndex = getSegmentFirstMessageIndex(b.messageIds, messageIndexById)
      return aIndex - bIndex
    })
  }, [segmentsForTopic, messageIndexById])

  const getSegmentsForTopic = useCallback(
    (tid: string) => {
      const ids = segmentsByTopic[tid] || []
      return ids.map((id) => segmentsEntities[id]).filter(Boolean)
    },
    [segmentsEntities, segmentsByTopic]
  )

  const createSegment = useCallback(
    async (tid: string, name: string, messageIds: string[]): Promise<TopicSegment> => {
      const now = new Date().toISOString()
      const id = uuid()
      const segment: TopicSegment = {
        id,
        topicId: tid,
        name,
        messageIds,
        color: getSegmentColor(id),
        createdAt: now,
        updatedAt: now
      }
      // DB-first: write to DB before updating Redux
      await db.topic_segments.put(segment)
      dispatch(addSegment(segment))
      logger.info(`Created segment "${name}" with ${messageIds.length} messages`)
      return segment
    },
    [dispatch]
  )

  const updateSegmentName = useCallback(
    async (segmentId: string, name: string) => {
      const now = new Date().toISOString()
      // DB-first
      await db.topic_segments.update(segmentId, { name, updatedAt: now })
      dispatch(updateSegment({ id: segmentId, changes: { name, updatedAt: now } }))
    },
    [dispatch]
  )

  const updateSegmentMessageIds = useCallback(
    async (segmentId: string, newMessageIds: string[]) => {
      const now = new Date().toISOString()
      // DB-first
      await db.topic_segments.update(segmentId, { messageIds: newMessageIds, updatedAt: now })
      dispatch(updateSegment({ id: segmentId, changes: { messageIds: newMessageIds, updatedAt: now } }))
    },
    [dispatch]
  )

  const deleteSegment = useCallback(
    async (segmentId: string) => {
      // DB-first
      await db.topic_segments.delete(segmentId)
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
      const segment = segmentsEntities[segmentId]
      if (!segment || segment.messageIds.length === 0) return undefined
      return {
        firstMessageId: segment.messageIds[0],
        lastMessageId: segment.messageIds[segment.messageIds.length - 1]
      }
    },
    [segmentsEntities]
  )

  const isMessageFirstInSegment = useCallback(
    (messageId: string): TopicSegment | undefined => {
      return segmentsForTopic.find((seg) => seg.messageIds[0] === messageId)
    },
    [segmentsForTopic]
  )

  const isMessageLastInSegment = useCallback(
    (messageId: string): TopicSegment | undefined => {
      return segmentsForTopic.find((seg) => seg.messageIds[seg.messageIds.length - 1] === messageId)
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
