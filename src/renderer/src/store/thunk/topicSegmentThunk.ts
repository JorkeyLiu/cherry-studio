import { createAsyncThunk } from '@reduxjs/toolkit'
import db from '@renderer/databases'
import {
  addSegment,
  clearSegmentsForTopic,
  loadSegments,
  removeSegment,
  updateSegment
} from '@renderer/store/topicSegment'
import type { SegmentSnapshot } from '@renderer/types/editMode'
import type { TopicSegment } from '@renderer/types/topicSegment'

import type { AppDispatch, RootState } from '../index'

export const syncSegmentsAfterMessageDeletion = async (
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  messageIds: string[]
): Promise<void> => {
  const state = getState()
  const segmentIds = state.topicSegments.segmentsByTopic[topicId] || []
  for (const segId of segmentIds) {
    const segment = state.topicSegments.segments.entities[segId]
    if (!segment) continue
    const newMessageIds = segment.messageIds.filter((id) => !messageIds.includes(id))
    if (newMessageIds.length === 0) {
      await db.topic_segments.delete(segId)
      dispatch(removeSegment(segId))
    } else if (newMessageIds.length !== segment.messageIds.length) {
      const now = new Date().toISOString()
      await db.topic_segments.update(segId, { messageIds: newMessageIds, updatedAt: now })
      dispatch(updateSegment({ id: segId, changes: { messageIds: newMessageIds, updatedAt: now } }))
    }
  }
}

export const loadTopicSegmentsThunk = createAsyncThunk<void, string, { dispatch: AppDispatch }>(
  'topicSegments/loadForTopic',
  async (topicId: string, { dispatch }) => {
    // Clear stale segment IDs for this topic before loading fresh data
    dispatch(clearSegmentsForTopic(topicId))
    dispatch(loadSegments(await db.topic_segments.where('topicId').equals(topicId).toArray()))
  }
)

export const saveTopicSegmentThunk = createAsyncThunk<void, TopicSegment>(
  'topicSegments/save',
  async (segment: TopicSegment) => {
    await db.topic_segments.put(segment)
  }
)

export const deleteTopicSegmentThunk = createAsyncThunk<void, string>(
  'topicSegments/delete',
  async (segmentId: string) => {
    await db.topic_segments.delete(segmentId)
  }
)

export const clearTopicSegmentsFromDB = async (topicId: string): Promise<void> => {
  const ids = await db.topic_segments.where('topicId').equals(topicId).primaryKeys()
  await db.topic_segments.bulkDelete(ids)
}

export const removeMessageFromSegmentsThunk = createAsyncThunk<
  void,
  { topicId: string; messageId: string },
  { dispatch: AppDispatch; state: RootState }
>('topicSegments/removeMessage', async ({ topicId, messageId }, { dispatch, getState }) => {
  const state = getState()
  const segmentIds = state.topicSegments.segmentsByTopic[topicId] || []
  for (const segId of segmentIds) {
    const segment = state.topicSegments.segments.entities[segId]
    if (segment && segment.messageIds.includes(messageId)) {
      const newMessageIds = segment.messageIds.filter((id: string) => id !== messageId)
      if (newMessageIds.length === 0) {
        await db.topic_segments.delete(segId)
        dispatch(removeSegment(segId))
      } else {
        const now = new Date().toISOString()
        await db.topic_segments.update(segId, { messageIds: newMessageIds, updatedAt: now })
        dispatch(updateSegment({ id: segId, changes: { messageIds: newMessageIds, updatedAt: now } }))
      }
    }
  }
})

/**
 * Collect snapshots of all segments that contain any of the given message IDs.
 * Must be called BEFORE syncSegmentsAfterMessageDeletion to capture the pre-deletion state.
 */
export const collectSegmentSnapshots = (
  getState: () => RootState,
  topicId: string,
  messageIds: string[]
): SegmentSnapshot[] => {
  const state = getState()
  const segmentIds = state.topicSegments.segmentsByTopic[topicId] || []
  const snapshots: SegmentSnapshot[] = []
  for (const segId of segmentIds) {
    const segment = state.topicSegments.segments.entities[segId]
    if (!segment) continue
    const hasAffected = messageIds.some((id) => segment.messageIds.includes(id))
    if (hasAffected) {
      snapshots.push(structuredClone(segment))
    }
  }
  return snapshots
}

/**
 * Restore segment membership after an undo operation.
 * For each snapshot:
 *   - If the segment still exists, restore its original messageIds.
 *   - If the segment was removed (empty after deletion), recreate it from the snapshot.
 */
export const restoreSegmentsAfterUndo = async (
  dispatch: AppDispatch,
  getState: () => RootState,
  segmentSnapshots: SegmentSnapshot[]
): Promise<void> => {
  if (!segmentSnapshots || segmentSnapshots.length === 0) return

  for (const snap of segmentSnapshots) {
    const state = getState()
    const existingSegment = state.topicSegments.segments.entities[snap.id]

    if (existingSegment) {
      // Segment still exists — restore original messageIds
      const now = new Date().toISOString()
      await db.topic_segments.update(snap.id, { messageIds: snap.messageIds, updatedAt: now })
      dispatch(updateSegment({ id: snap.id, changes: { messageIds: snap.messageIds, updatedAt: now } }))
    } else {
      // Segment was removed (all messages were deleted) — recreate from snapshot
      const restoredSegment: TopicSegment = {
        ...snap,
        updatedAt: new Date().toISOString()
      }
      await db.topic_segments.put(restoredSegment)
      dispatch(addSegment(restoredSegment))
    }
  }
}
