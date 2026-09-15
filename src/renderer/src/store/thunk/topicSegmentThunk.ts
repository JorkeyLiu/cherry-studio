import { loggerService } from '@logger'
import { createAsyncThunk } from '@reduxjs/toolkit'
import { dbService } from '@renderer/services/db'
import { captureDeletionGeneration, isDeletionStale } from '@renderer/services/topicDeletionInvalidation'
import { addSegment, removeSegment, replaceSegmentsForTopic, updateSegment } from '@renderer/store/topicSegment'
import type { ClipboardSegmentSnapshot, SegmentSnapshot } from '@renderer/types/editMode'
import type { TopicSegment } from '@renderer/types/topicSegment'
import { convergeTopicSegmentCatalog, mapSegmentWireToTopicSegment } from '@renderer/utils/topicSegmentCatalog'
import { getSegmentColor } from '@renderer/utils/topicSegmentColor'

import type { AppDispatch, RootState } from '../index'

const logger = loggerService.withContext('topicSegmentThunk')

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
      // DB-first enriched: converge from the Main wire authority fields.
      const wire = await dbService.replaceSegmentMembership(segId, newMessageIds)
      if (wire === null) {
        dispatch(removeSegment(segId))
      } else {
        dispatch(
          updateSegment({
            id: segId,
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
      }
    }
  }
}

let loadTopicSegmentsSeq = 0
const latestSegmentLoadByTopic = new Map<string, number>()

export const loadTopicSegmentsThunk = createAsyncThunk<void, string, { dispatch: AppDispatch; state: RootState }>(
  'topicSegments/loadForTopic',
  async (topicId: string, { dispatch, getState }) => {
    const capturedDeletionGeneration = captureDeletionGeneration(topicId)
    const capturedApplicabilityGeneration: number =
      (getState() as any)?.residentRegistry?.entries?.[topicId]?.applicabilityGeneration ?? 0
    const requestSeq = ++loadTopicSegmentsSeq
    latestSegmentLoadByTopic.set(topicId, requestSeq)
    const segmentsRaw = await dbService.listSegments(topicId)
    if (isDeletionStale(topicId, capturedDeletionGeneration)) return
    if (latestSegmentLoadByTopic.get(topicId) !== requestSeq) return
    const currentApplicabilityGeneration: number =
      (getState() as any)?.residentRegistry?.entries?.[topicId]?.applicabilityGeneration ?? 0
    if (currentApplicabilityGeneration !== capturedApplicabilityGeneration) return
    const segments = segmentsRaw.map((segment) => {
      const mapped: TopicSegment = {
        id: segment.id,
        topicId: segment.topicId,
        name: segment.name ?? '',
        messageIds: [...segment.messageIds],
        createdAt: segment.createdAt ?? new Date().toISOString(),
        updatedAt: segment.updatedAt ?? new Date().toISOString(),
        sortOrder: segment.sortOrder,
        firstMessageId: segment.firstMessageId,
        lastMessageId: segment.lastMessageId,
        messageCount: segment.messageCount
      }
      if (typeof segment.color === 'string') {
        mapped.color = segment.color
      }
      return mapped
    })
    // Just-before-publication stale check — ensures no newer generation slipped in
    if (isDeletionStale(topicId, capturedDeletionGeneration)) return
    if (latestSegmentLoadByTopic.get(topicId) !== requestSeq) return
    if (
      ((getState() as any)?.residentRegistry?.entries?.[topicId]?.applicabilityGeneration ?? 0) !==
      capturedApplicabilityGeneration
    )
      return
    // Atomic replacement — no eager clear before paired payload is valid.
    // Never marks joint residency alone; only updates segment projection.
    // Standalone replacement invalidates resident state atomically via centralized
    // rootReducer in the same dispatch — no follow-up mark dispatch.
    dispatch(replaceSegmentsForTopic({ topicId, segments }))
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
        const wire = await dbService.replaceSegmentMembership(segId, newMessageIds)
        if (wire === null) {
          dispatch(removeSegment(segId))
        } else {
          dispatch(
            updateSegment({
              id: segId,
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
        }
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
 * Batch convergence: all Main mutations first, then exactly one
 * list+replace per affected topic so shifted siblings converge. The single
 * upsert/replace wires cannot carry siblings. listSegments failure never
 * rolls back the successful Main mutations: fall back to the per-wire
 * add/update/remove so restored segments stay visible.
 */
export const restoreSegmentsAfterUndo = async (
  dispatch: AppDispatch,
  getState: () => RootState,
  segmentSnapshots: SegmentSnapshot[]
): Promise<void> => {
  if (!segmentSnapshots || segmentSnapshots.length === 0) return

  const affectedTopics = new Set<string>()
  const fallbackRemoves: { topicId: string; id: string }[] = []
  const fallbackUpdates: { id: string; changes: Partial<TopicSegment>; topicId: string }[] = []
  const fallbackAdds: { segment: TopicSegment; topicId: string }[] = []

  for (const snap of segmentSnapshots) {
    affectedTopics.add(snap.topicId)
    const state = getState()
    const existingSegment = state.topicSegments.segments.entities[snap.id]

    if (existingSegment) {
      // Segment still exists — restore original messageIds.
      const wire = await dbService.replaceSegmentMembership(snap.id, snap.messageIds)
      if (wire === null) {
        fallbackRemoves.push({ topicId: snap.topicId, id: snap.id })
      } else {
        fallbackUpdates.push({
          topicId: snap.topicId,
          id: snap.id,
          changes: {
            messageIds: [...wire.messageIds],
            sortOrder: wire.sortOrder,
            firstMessageId: wire.firstMessageId,
            lastMessageId: wire.lastMessageId,
            messageCount: wire.messageCount,
            updatedAt: wire.updatedAt ?? new Date().toISOString()
          }
        })
      }
    } else {
      // Segment was removed (all messages were deleted) — recreate from snapshot.
      // Authority order/boundaries come from Main, not the snapshot guess.
      const wire = await dbService.upsertSegment(snap.id, snap.topicId, snap.name, snap.messageIds, snap.color)
      const restoredSegment = mapSegmentWireToTopicSegment(wire)
      // Preserve snapshot createdAt when Main carries none (fallback path only;
      // the converged list carries authority createdAt on success).
      if (wire.createdAt == null) restoredSegment.createdAt = snap.createdAt
      if (wire.name == null) restoredSegment.name = snap.name
      fallbackAdds.push({ topicId: snap.topicId, segment: restoredSegment })
    }
  }

  for (const topicId of affectedTopics) {
    try {
      await convergeTopicSegmentCatalog(dispatch, topicId)
    } catch (error) {
      logger.warn('[restoreSegmentsAfterUndo] catalog convergence failed, keeping per-wire fallback', error as Error)
      for (const r of fallbackRemoves.filter((f) => f.topicId === topicId)) dispatch(removeSegment(r.id))
      for (const u of fallbackUpdates.filter((f) => f.topicId === topicId))
        dispatch(updateSegment({ id: u.id, changes: u.changes }))
      for (const a of fallbackAdds.filter((f) => f.topicId === topicId)) dispatch(addSegment(a.segment))
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
 * Batch convergence: all Main upserts first, then exactly one list+replace
 * per affected topic. listSegments failure never rolls back the successful
 * Main mutations: fall back to per-wire adds.
 */
export const restoreTargetSegments = async (dispatch: AppDispatch, snapshots: TopicSegment[]): Promise<void> => {
  if (!snapshots || snapshots.length === 0) return
  const affectedTopics = new Set<string>()
  const fallbackAdds: { segment: TopicSegment; topicId: string }[] = []
  for (const snap of snapshots) {
    affectedTopics.add(snap.topicId)
    const wire = await dbService.upsertSegment(snap.id, snap.topicId, snap.name, snap.messageIds, snap.color)
    const restored = mapSegmentWireToTopicSegment(wire)
    if (wire.createdAt == null) restored.createdAt = snap.createdAt
    if (wire.name == null) restored.name = snap.name
    fallbackAdds.push({ topicId: snap.topicId, segment: restored })
  }
  for (const topicId of affectedTopics) {
    try {
      await convergeTopicSegmentCatalog(dispatch, topicId)
    } catch (error) {
      logger.warn('[restoreTargetSegments] catalog convergence failed, keeping per-wire fallback', error as Error)
      for (const a of fallbackAdds.filter((f) => f.topicId === topicId)) dispatch(addSegment(a.segment))
    }
  }
}
