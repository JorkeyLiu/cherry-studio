import { createEntityAdapter, createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { TopicSegment } from '@renderer/types/topicSegment'

import { publishResidentComplete, retentionEvict } from './residentRegistry'

const topicSegmentAdapter = createEntityAdapter<TopicSegment>()

interface TopicSegmentsState {
  segments: ReturnType<typeof topicSegmentAdapter.getInitialState>
  segmentsByTopic: Record<string, string[]>
}

const initialState: TopicSegmentsState = {
  segments: topicSegmentAdapter.getInitialState(),
  segmentsByTopic: {}
}

function isEmptySegment(seg: TopicSegment): boolean {
  return (
    seg.messageCount === 0 || seg.messageIds.length === 0 || seg.firstMessageId === null || seg.lastMessageId === null
  )
}

function compareAuthority(a: TopicSegment, b: TopicSegment): number {
  const ao = typeof a.sortOrder === 'number' && Number.isFinite(a.sortOrder) ? a.sortOrder : Infinity
  const bo = typeof b.sortOrder === 'number' && Number.isFinite(b.sortOrder) ? b.sortOrder : Infinity
  if (ao !== bo) return ao - bo
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function resortTopic(state: TopicSegmentsState, topicId: string): void {
  const ids = Object.values(state.segments.entities)
    .filter((s): s is TopicSegment => !!s && s.topicId === topicId && !isEmptySegment(s))
    .sort(compareAuthority)
    .map((s) => s.id)
  state.segmentsByTopic[topicId] = ids
}

const topicSegmentSlice = createSlice({
  name: 'topicSegments',
  initialState,
  reducers: {
    addSegment: (state, action: PayloadAction<TopicSegment>) => {
      // Fail closed on empty: never store a phantom; remove any existing entity.
      if (isEmptySegment(action.payload)) {
        const existing = state.segments.entities[action.payload.id]
        if (existing) {
          state.segmentsByTopic[existing.topicId] = state.segmentsByTopic[existing.topicId]?.filter(
            (id) => id !== action.payload.id
          )
          topicSegmentAdapter.removeOne(state.segments, action.payload.id)
        }
        return
      }
      topicSegmentAdapter.addOne(state.segments, action.payload)
      resortTopic(state, action.payload.topicId)
    },
    /**
     * Update segment fields. Note: `topicId` should NOT be changed via this action,
     * as `segmentsByTopic` index is not updated on change.
     */
    updateSegment: (state, action: PayloadAction<{ id: string; changes: Partial<TopicSegment> }>) => {
      topicSegmentAdapter.updateOne(state.segments, action.payload)
    },
    removeSegment: (state, action: PayloadAction<string>) => {
      const segment = state.segments.entities[action.payload]
      if (segment) {
        state.segmentsByTopic[segment.topicId] = state.segmentsByTopic[segment.topicId]?.filter(
          (id) => id !== action.payload
        )
        topicSegmentAdapter.removeOne(state.segments, action.payload)
      }
    },
    loadSegments: (state, action: PayloadAction<TopicSegment[]>) => {
      // Empty readbacks remove rather than store (no phantom).
      const affected = new Set<string>()
      for (const seg of action.payload) {
        affected.add(seg.topicId)
        if (isEmptySegment(seg)) {
          const existing = state.segments.entities[seg.id]
          if (existing) {
            topicSegmentAdapter.removeOne(state.segments, seg.id)
          }
        } else {
          topicSegmentAdapter.upsertOne(state.segments, seg)
        }
      }
      // Maintain authority (sortOrder,id) order consistently.
      for (const topicId of affected) {
        resortTopic(state, topicId)
      }
    },
    clearSegmentsForTopic: (state, action: PayloadAction<string>) => {
      const topicId = action.payload
      const ids = state.segmentsByTopic[topicId] || []
      topicSegmentAdapter.removeMany(state.segments, ids)
      delete state.segmentsByTopic[topicId]
    },
    replaceSegmentsForTopic: (state, action: PayloadAction<{ topicId: string; segments: TopicSegment[] }>) => {
      const { topicId, segments } = action.payload
      const oldIds = state.segmentsByTopic[topicId] || []
      topicSegmentAdapter.removeMany(state.segments, oldIds)
      // No phantom: filter empty readbacks before storing.
      const nonEmpty = segments.filter((s) => !isEmptySegment(s))
      topicSegmentAdapter.upsertMany(state.segments, nonEmpty)
      // Authority (sortOrder ASC, id ASC) including equal-sortOrder tie.
      state.segmentsByTopic[topicId] = [...nonEmpty].sort(compareAuthority).map((s) => s.id)
    }
  },
  extraReducers: (builder) => {
    builder.addCase(publishResidentComplete, (state, action) => {
      const { topicId, segments } = action.payload
      const oldIds = state.segmentsByTopic[topicId] || []
      topicSegmentAdapter.removeMany(state.segments, oldIds)
      const incoming = segments.filter((s) => !isEmptySegment(s))
      topicSegmentAdapter.upsertMany(state.segments, incoming)
      state.segmentsByTopic[topicId] = [...incoming].sort(compareAuthority).map((s) => s.id)
    })
    builder.addCase(retentionEvict, (state, action) => {
      const topicId = action.payload
      const ids = state.segmentsByTopic[topicId]
      if (ids !== undefined) {
        if (ids.length > 0) {
          topicSegmentAdapter.removeMany(state.segments, ids)
        }
        delete state.segmentsByTopic[topicId]
      }
    })
  }
})

export const {
  addSegment,
  updateSegment,
  removeSegment,
  loadSegments,
  clearSegmentsForTopic,
  replaceSegmentsForTopic
} = topicSegmentSlice.actions

export const topicSegmentSelectors = topicSegmentAdapter.getSelectors<{
  topicSegments: TopicSegmentsState
}>((state) => state.topicSegments.segments)

export default topicSegmentSlice.reducer
