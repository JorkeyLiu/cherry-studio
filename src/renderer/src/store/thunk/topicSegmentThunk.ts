import { createAsyncThunk } from '@reduxjs/toolkit'
import { dbService } from '@renderer/services/db'
import { captureDeletionGeneration, isDeletionStale } from '@renderer/services/topicDeletionInvalidation'
import { replaceSegmentsForTopic } from '@renderer/store/topicSegment'
import type { ClipboardSegmentSnapshot, SegmentSnapshot } from '@renderer/types/editMode'
import type { TopicSegment } from '@renderer/types/topicSegment'
import { convergeTopicSegmentCatalog, isSegmentCatalogConvergenceError } from '@renderer/utils/topicSegmentCatalog'
import { getSegmentColor } from '@renderer/utils/topicSegmentColor'

import store, { type AppDispatch, type RootState } from '../index'
import { requireActiveRouteOf } from '../routeAnswerGroup'

export const syncSegmentsAfterMessageDeletion = async (
  dispatch: AppDispatch,
  getState: () => RootState,
  topicId: string,
  messageIds: string[],
  addressedRoute?: string | null
): Promise<void> => {
  const state = getState()
  const segmentIds = state.topicSegments.segmentsByTopic[topicId] || []
  // Pinned addressed route when the caller supplies one (cut-paste rollback /
  // cut_paste undo target cleanup); omitted retains the existing live-route
  // behavior for ordinary callers. Never re-reads live selection when pinned,
  // so a route switch mid-cleanup cannot retarget the membership write.
  const route = typeof addressedRoute === 'undefined' ? requireActiveRouteOf(getState, topicId) : addressedRoute
  let mutated = false
  for (const segId of segmentIds) {
    const segment = state.topicSegments.segments.entities[segId]
    if (!segment) continue
    const newMessageIds = segment.messageIds.filter((id) => !messageIds.includes(id))
    if (newMessageIds.length === 0) {
      await dbService.deleteSegment({ segmentId: segId, branchId: route })
      mutated = true
    } else if (newMessageIds.length !== segment.messageIds.length) {
      // DB-first: Main mutation only; Redux converges once below through the
      // preserving catalog publication (no raw per-segment dispatches that
      // would invalidate the resident window).
      await dbService.replaceSegmentMembership({
        segmentId: segId,
        messageIds: newMessageIds,
        branchId: route
      })
      mutated = true
    }
  }
  if (!mutated) return
  // Single authority list + preserving publication (message window is the
  // post-deletion projection already committed by the caller). Stale reads
  // discard silently inside converge (no throw); a genuine list failure
  // invalidates fenced and throws typed SegmentCatalogConvergenceError —
  // no partial catalog.
  await convergeTopicSegmentCatalog(dispatch, topicId, getState)
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
        messageCount: segment.messageCount,
        // Stable head identity + head owner from Main (never re-derived from a
        // renderer window). The head identity falls back to the authority
        // first member so old databases keep loading, but owner fields NEVER
        // default: the catalog read is unqualified, so no route block is ever
        // stored here and missing owner metadata stays missing (downstream
        // gates fail closed, never owned).
        headerMessageId: segment.headerMessageId ?? segment.firstMessageId ?? null,
        ...(typeof segment.ownerTopicId === 'string' ? { ownerTopicId: segment.ownerTopicId } : null),
        ...('ownerBranchId' in segment ? { ownerBranchId: segment.ownerBranchId ?? null } : null)
      }
      if (typeof segment.folded === 'boolean') {
        mapped.folded = segment.folded
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
    await dbService.upsertSegment({
      segmentId: segment.id,
      topicId: segment.topicId,
      name: segment.name,
      messageIds: segment.messageIds,
      color: segment.color,
      branchId: requireActiveRouteOf(store.getState, segment.topicId),
      folded: segment.folded
    })
  }
)

export const deleteTopicSegmentThunk = createAsyncThunk<void, string>(
  'topicSegments/delete',
  async (segmentId: string) => {
    const segment = store.getState().topicSegments.segments.entities[segmentId]
    if (!segment) {
      throw new Error(`Segment ${segmentId} is not in the loaded catalog; cannot resolve its addressed route`)
    }
    await dbService.deleteSegment({
      segmentId,
      branchId: requireActiveRouteOf(store.getState, segment.topicId)
    })
  }
)

export const clearTopicSegmentsFromDB = async (topicId: string): Promise<void> => {
  // Each delete states the route it addresses: the topic's addressed route.
  // Groups owned by another route fail closed at Main instead of being
  // dissolved from the wrong route.
  const branchId = requireActiveRouteOf(store.getState, topicId)
  for (const segment of await dbService.listSegments(topicId)) {
    await dbService.deleteSegment({ segmentId: segment.id, branchId })
  }
}

export const removeMessageFromSegmentsThunk = createAsyncThunk<
  void,
  { topicId: string; messageId: string },
  { dispatch: AppDispatch; state: RootState }
>('topicSegments/removeMessage', async ({ topicId, messageId }, { dispatch, getState }) => {
  const state = getState()
  const branchId = requireActiveRouteOf(getState, topicId)
  const segmentIds = state.topicSegments.segmentsByTopic[topicId] || []
  let mutated = false
  for (const segId of segmentIds) {
    const segment = state.topicSegments.segments.entities[segId]
    if (segment && segment.messageIds.includes(messageId)) {
      const newMessageIds = segment.messageIds.filter((id: string) => id !== messageId)
      if (newMessageIds.length === 0) {
        await dbService.deleteSegment({ segmentId: segId, branchId })
        mutated = true
      } else {
        await dbService.replaceSegmentMembership({
          segmentId: segId,
          messageIds: newMessageIds,
          branchId
        })
        mutated = true
      }
    }
  }
  if (!mutated) return
  await convergeTopicSegmentCatalog(dispatch, topicId, getState as () => any)
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
 * upsert/replace wires cannot carry siblings. The convergence list is a
 * route-neutral catalog read (current visible projection); only the
 * mutations carry the addressed route. Convergence uses the preserving
 * catalog publication (no fabricated per-wire fallback; stale discards
 * silently, genuine list failure throws typed and never marks resident
 * complete). Main upsert/replace failures throw unwrapped and stay
 * fail-closed operation failures.
 */
export const restoreSegmentsAfterUndo = async (
  dispatch: AppDispatch,
  getState: () => RootState,
  segmentSnapshots: SegmentSnapshot[],
  addressedRoute?: string | null
): Promise<void> => {
  if (!segmentSnapshots || segmentSnapshots.length === 0) return

  const affectedTopics = new Set<string>()

  for (const snap of segmentSnapshots) {
    affectedTopics.add(snap.topicId)
    const state = getState()
    const existingSegment = state.topicSegments.segments.entities[snap.id]

    if (existingSegment) {
      // Segment still exists — restore original messageIds.
      // Pinned addressed route when the caller supplies one (staged cut_paste
      // undo source restore); omitted retains the live-route behavior for
      // ordinary callers. Explicit null addresses main; never re-reads live
      // selection when pinned.
      const replaceRoute =
        typeof addressedRoute === 'undefined' ? requireActiveRouteOf(getState, snap.topicId) : addressedRoute
      await dbService.replaceSegmentMembership({
        segmentId: snap.id,
        messageIds: snap.messageIds,
        branchId: replaceRoute
      })
    } else {
      // Segment was removed (all messages were deleted) — recreate from snapshot.
      // Authority order/boundaries come from Main, not the snapshot guess.
      // Same pinned-route rule as the replace path above.
      const upsertRoute =
        typeof addressedRoute === 'undefined' ? requireActiveRouteOf(getState, snap.topicId) : addressedRoute
      // Snapshot folded state is restored with its original semantics: a
      // recreate must not silently re-enable folded request context.
      await dbService.upsertSegment({
        segmentId: snap.id,
        topicId: snap.topicId,
        name: snap.name,
        messageIds: snap.messageIds,
        color: snap.color,
        branchId: upsertRoute,
        folded: snap.folded
      })
    }
  }

  let pendingConvergence: unknown = null
  for (const topicId of affectedTopics) {
    try {
      await convergeTopicSegmentCatalog(dispatch, topicId, getState)
    } catch (error) {
      // Multi-topic batch: a typed projection-read failure on one topic must
      // not skip the remaining catalog converges (all Main writes already
      // committed). Record the first and continue; Main-write failures stay
      // unwrapped and abort immediately.
      if (isSegmentCatalogConvergenceError(error)) {
        pendingConvergence = pendingConvergence ?? error
        continue
      }
      throw error
    }
  }
  if (pendingConvergence) throw pendingConvergence
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
        folded: segment.folded === true ? true : undefined,
        originalMessageIds: [...segment.messageIds]
      })
    }
  }

  return snapshots
}

/**
 * Delete segments by their snapshots from DB and Redux.
 * Used by undo to remove target segments that were created during paste.
 * Batch convergence through the preserving catalog publication (no raw
 * per-segment removes that would invalidate the resident window). The delete
 * carries the addressed route the caller pinned (otherwise the topic's live
 * route).
 */
export const deleteSegmentsBySnapshots = async (
  dispatch: AppDispatch,
  snapshots: TopicSegment[],
  addressedRoute?: string | null,
  getState?: () => RootState
): Promise<void> => {
  if (!snapshots || snapshots.length === 0) return
  const gs = getState ?? store.getState
  const affectedTopics = new Set<string>()
  for (const snap of snapshots) {
    affectedTopics.add(snap.topicId)
    // Same pinned-route rule as the restore paths: the route the undo actually
    // addressed when the caller supplies one, otherwise the topic's live route.
    const branchId = typeof addressedRoute === 'undefined' ? requireActiveRouteOf(gs, snap.topicId) : addressedRoute
    await dbService.deleteSegment({ segmentId: snap.id, branchId })
  }
  let pendingConvergence: unknown = null
  for (const topicId of affectedTopics) {
    try {
      await convergeTopicSegmentCatalog(dispatch, topicId, gs as () => any)
    } catch (error) {
      if (isSegmentCatalogConvergenceError(error)) {
        pendingConvergence = pendingConvergence ?? error
        continue
      }
      throw error
    }
  }
  if (pendingConvergence) throw pendingConvergence
}

/**
 * Restore target segments from snapshots to DB and Redux.
 * Used by redo to re-create segments that were created during paste.
 * Batch convergence: all Main upserts first, then exactly one preserving
 * publication per affected topic. The convergence list is a route-neutral
 * catalog read (current visible projection); only the upserts carry the
 * addressed route. No fabricated per-wire fallback; stale discards
 * silently, genuine list failure throws typed. Main upsert failures stay
 * unwrapped fail-closed.
 */
export const restoreTargetSegments = async (
  dispatch: AppDispatch,
  snapshots: TopicSegment[],
  addressedRoute?: string | null,
  getState?: () => RootState
): Promise<void> => {
  if (!snapshots || snapshots.length === 0) return
  const affectedTopics = new Set<string>()
  for (const snap of snapshots) {
    affectedTopics.add(snap.topicId)
    // Pinned addressed route when the caller supplies one (staged cut_paste
    // redo target restore); omitted retains the live-route behavior for
    // ordinary callers. Explicit null addresses main.
    const gsForRoute = getState ?? store.getState
    const route =
      typeof addressedRoute === 'undefined' ? requireActiveRouteOf(gsForRoute, snap.topicId) : addressedRoute
    // Redo/paste target recreate carries the snapshot's folded state verbatim.
    await dbService.upsertSegment({
      segmentId: snap.id,
      topicId: snap.topicId,
      name: snap.name,
      messageIds: snap.messageIds,
      color: snap.color,
      branchId: route,
      folded: snap.folded
    })
  }
  const gs = (getState ?? store.getState) as () => any
  let pendingConvergence: unknown = null
  for (const topicId of affectedTopics) {
    try {
      await convergeTopicSegmentCatalog(dispatch, topicId, gs)
    } catch (error) {
      if (isSegmentCatalogConvergenceError(error)) {
        pendingConvergence = pendingConvergence ?? error
        continue
      }
      throw error
    }
  }
  if (pendingConvergence) throw pendingConvergence
}
