import { createAsyncThunk } from '@reduxjs/toolkit'
import { dbService } from '@renderer/services/db'
import { captureDeletionGeneration, isDeletionStale } from '@renderer/services/topicDeletionInvalidation'
import { markSegmentsLoaded } from '@renderer/store/residentRegistry'
import { addSegment, removeSegment, replaceSegmentsForTopic, updateSegment } from '@renderer/store/topicSegment'
import type { ClipboardSegmentSnapshot, SegmentSnapshot } from '@renderer/types/editMode'
import type { TopicSegment } from '@renderer/types/topicSegment'
import { getSegmentColor } from '@renderer/utils/topicSegmentColor'

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
      await dbService.deleteSegment(segId)
      dispatch(removeSegment(segId))
    } else if (newMessageIds.length !== segment.messageIds.length) {
      const now = new Date().toISOString()
      await dbService.replaceSegmentMembership(segId, newMessageIds)
      dispatch(updateSegment({ id: segId, changes: { messageIds: newMessageIds, updatedAt: now } }))
    }
  }
}

export const loadTopicSegmentsThunk = createAsyncThunk<void, string, { dispatch: AppDispatch; state: RootState }>(
  'topicSegments/loadForTopic',
  async (topicId: string, { dispatch }) => {
    const capturedDeletionGeneration = captureDeletionGeneration(topicId)
    const segmentsRaw = await dbService.listSegments(topicId)
    if (isDeletionStale(topicId, capturedDeletionGeneration)) return
    const segments = segmentsRaw.map((segment) => ({
      ...segment,
      name: segment.name ?? '',
      color: segment.color ?? undefined,
      createdAt: segment.createdAt ?? new Date().toISOString(),
      updatedAt: segment.updatedAt ?? new Date().toISOString()
    }))
    // Atomic replacement — no eager clear before paired payload is valid
    dispatch(replaceSegmentsForTopic({ topicId, segments }))
    dispatch(markSegmentsLoaded(topicId))
  }
)

export const saveTopicSegmentThunk = createAsyncThunk<void, TopicSegment>(
  'topicSegments/save',
  async (segment: TopicSegment) => {
    await dbService.upsertSegment(segment.id, segment.topicId, segment.name, segment.messageIds, segment.color)
  }
)

export const deleteTopicSegmentThunk = createAsyncThunk<void, string>(
  'topicSegments/delete',
  async (segmentId: string) => {
    await dbService.deleteSegment(segmentId)
  }
)

export const clearTopicSegmentsFromDB = async (topicId: string): Promise<void> => {
  for (const segment of await dbService.listSegments(topicId)) await dbService.deleteSegment(segment.id)
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
        await dbService.deleteSegment(segId)
        dispatch(removeSegment(segId))
      } else {
        const now = new Date().toISOString()
        await dbService.replaceSegmentMembership(segId, newMessageIds)
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
      await dbService.replaceSegmentMembership(snap.id, snap.messageIds)
      dispatch(updateSegment({ id: snap.id, changes: { messageIds: snap.messageIds, updatedAt: now } }))
    } else {
      // Segment was removed (all messages were deleted) — recreate from snapshot
      const restoredSegment: TopicSegment = {
        ...snap,
        updatedAt: new Date().toISOString()
      }
      await dbService.upsertSegment(
        restoredSegment.id,
        restoredSegment.topicId,
        restoredSegment.name,
        restoredSegment.messageIds,
        restoredSegment.color
      )
      dispatch(addSegment(restoredSegment))
    }
  }
}

/**
 * Collect snapshots of fully-selected segments for clipboard segment reconstruction.
 * A segment is "fully selected" when ALL of its messageIds are contained in the
 * selectedMessageIds set.
 *
 * Must be called at cut/copy time.
 */
export const collectWholeSelectedSegmentsForClipboard = (
  getState: () => RootState,
  topicId: string,
  selectedMessageIds: string[]
): ClipboardSegmentSnapshot[] => {
  const state = getState()
  const segmentIds = state.topicSegments.segmentsByTopic[topicId] || []
  const selectedSet = new Set(selectedMessageIds)
  const snapshots: ClipboardSegmentSnapshot[] = []

  for (const segId of segmentIds) {
    const segment = state.topicSegments.segments.entities[segId]
    if (!segment) continue
    // Only record if ALL messageIds of the segment are in the selection
    if (segment.messageIds.length > 0 && segment.messageIds.every((id) => selectedSet.has(id))) {
      snapshots.push({
        originalSegmentId: segment.id,
        name: segment.name,
        color: segment.color || getSegmentColor(segment.id),
        originalMessageIds: [...segment.messageIds]
      })
    }
  }

  return snapshots
}

/**
 * Delete segments by their snapshots from DB and Redux.
 * Used by undo to remove target segments that were created during paste.
 */
export const deleteSegmentsBySnapshots = async (dispatch: AppDispatch, snapshots: TopicSegment[]): Promise<void> => {
  for (const snap of snapshots) {
    await dbService.deleteSegment(snap.id)
    dispatch(removeSegment(snap.id))
  }
}

/**
 * Restore target segments from snapshots to DB and Redux.
 * Used by redo to re-create segments that were created during paste.
 */
export const restoreTargetSegments = async (dispatch: AppDispatch, snapshots: TopicSegment[]): Promise<void> => {
  for (const snap of snapshots) {
    await dbService.upsertSegment(snap.id, snap.topicId, snap.name, snap.messageIds, snap.color)
    dispatch(addSegment(snap))
  }
}
