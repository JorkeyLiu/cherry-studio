import type { PayloadAction } from '@reduxjs/toolkit'
import { createSlice } from '@reduxjs/toolkit'
import type {
  ClipboardItem,
  ClipboardMode,
  ClipboardSegmentSnapshot,
  ClipboardState,
  StagedCutSourceProjection
} from '@renderer/types/editMode'

const initialState: ClipboardState = {
  mode: null,
  items: [],
  sourceTopicId: null,
  sourceBranchId: null,
  timestamp: 0,
  segmentSnapshots: []
}

const clipboardSlice = createSlice({
  name: 'clipboard',
  initialState,
  reducers: {
    setClipboard(
      state,
      action: PayloadAction<{
        mode: ClipboardMode
        items: ClipboardItem[]
        sourceTopicId: string
        sourceBranchId: string | null
        segmentSnapshots?: ClipboardSegmentSnapshot[]
        sourceProjection?: StagedCutSourceProjection | null
      }>
    ) {
      const { mode, items, sourceTopicId, sourceBranchId, segmentSnapshots, sourceProjection } = action.payload
      state.mode = mode
      state.items = items
      state.sourceTopicId = sourceTopicId
      state.sourceBranchId = sourceBranchId
      state.timestamp = Date.now()
      state.segmentSnapshots = segmentSnapshots ?? []
      // Preserve undefined (legacy/missing) vs null vs object distinctly:
      // copy leaves this undefined; cut always sets the eligibility object.
      if (typeof sourceProjection !== 'undefined') {
        state.sourceProjection = sourceProjection
      } else {
        delete (state as { sourceProjection?: unknown }).sourceProjection
      }
    },
    clearClipboard(state) {
      state.mode = null
      state.items = []
      state.sourceTopicId = null
      state.sourceBranchId = null
      state.timestamp = 0
      state.segmentSnapshots = []
      delete (state as { sourceProjection?: unknown }).sourceProjection
    }
  }
})

export const { setClipboard, clearClipboard } = clipboardSlice.actions

export default clipboardSlice.reducer
