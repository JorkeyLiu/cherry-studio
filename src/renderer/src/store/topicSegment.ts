import { createEntityAdapter, createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { TopicSegment } from '@renderer/types/topicSegment'

const topicSegmentAdapter = createEntityAdapter<TopicSegment>()

interface TopicSegmentsState {
  segments: ReturnType<typeof topicSegmentAdapter.getInitialState>
  segmentsByTopic: Record<string, string[]>
}

const initialState: TopicSegmentsState = {
  segments: topicSegmentAdapter.getInitialState(),
  segmentsByTopic: {}
}

const topicSegmentSlice = createSlice({
  name: 'topicSegments',
  initialState,
  reducers: {
    addSegment: (state, action: PayloadAction<TopicSegment>) => {
      topicSegmentAdapter.addOne(state.segments, action.payload)
      const { topicId, id } = action.payload
      if (!state.segmentsByTopic[topicId]) {
        state.segmentsByTopic[topicId] = []
      }
      state.segmentsByTopic[topicId].push(id)
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
      topicSegmentAdapter.upsertMany(state.segments, action.payload)
      for (const seg of action.payload) {
        if (!state.segmentsByTopic[seg.topicId]) {
          state.segmentsByTopic[seg.topicId] = []
        }
        if (!state.segmentsByTopic[seg.topicId].includes(seg.id)) {
          state.segmentsByTopic[seg.topicId].push(seg.id)
        }
      }
    },
    clearSegmentsForTopic: (state, action: PayloadAction<string>) => {
      const topicId = action.payload
      const ids = state.segmentsByTopic[topicId] || []
      topicSegmentAdapter.removeMany(state.segments, ids)
      delete state.segmentsByTopic[topicId]
    }
  }
})

export const { addSegment, updateSegment, removeSegment, loadSegments, clearSegmentsForTopic } =
  topicSegmentSlice.actions

export const topicSegmentSelectors = topicSegmentAdapter.getSelectors<{
  topicSegments: TopicSegmentsState
}>((state) => state.topicSegments.segments)

export default topicSegmentSlice.reducer
