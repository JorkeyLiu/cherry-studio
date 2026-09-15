import { dbService } from '@renderer/services/db'
import type { AppDispatch } from '@renderer/store'
import { replaceSegmentsForTopic } from '@renderer/store/topicSegment'
import type { TopicSegment } from '@renderer/types/topicSegment'
import type { SegmentWire } from '@shared/chatDb'

/**
 * Map a Main SegmentWire to a renderer TopicSegment (all authority fields).
 * JSON-safety: omit the optional `color` own property unless the wire
 * carries a legal string (never `color: undefined`).
 */
export function mapSegmentWireToTopicSegment(wire: SegmentWire): TopicSegment {
  const segment: TopicSegment = {
    id: wire.id,
    topicId: wire.topicId,
    name: wire.name ?? '',
    messageIds: [...wire.messageIds],
    createdAt: wire.createdAt ?? new Date().toISOString(),
    updatedAt: wire.updatedAt ?? new Date().toISOString(),
    sortOrder: wire.sortOrder,
    firstMessageId: wire.firstMessageId,
    lastMessageId: wire.lastMessageId,
    messageCount: wire.messageCount
  }
  if (typeof wire.color === 'string') {
    segment.color = wire.color
  }
  return segment
}

/**
 * Renderer-internal catalog convergence: read-after list + full replace.
 * Never changes the Main contract (`chatdb:upsert-segment` stays single-wire);
 * it only re-reads the authority catalog so shifted siblings converge.
 * Throws on list failure — callers keep the local catalog or at least the
 * new wire visible and log via their existing safe logger.
 */
export async function convergeTopicSegmentCatalog(dispatch: AppDispatch, topicId: string): Promise<TopicSegment[]> {
  const wires = await dbService.listSegments(topicId)
  const segments = wires.map(mapSegmentWireToTopicSegment)
  dispatch(replaceSegmentsForTopic({ topicId, segments }))
  return segments
}
