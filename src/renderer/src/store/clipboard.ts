import type { PayloadAction } from '@reduxjs/toolkit'
import { createSlice } from '@reduxjs/toolkit'
import type { ClipboardItem, ClipboardMode, ClipboardSegmentSnapshot, ClipboardState } from '@renderer/types/editMode'

const initialState: ClipboardState = {
  mode: null,
  items: [],
  sourceTopicId: null,
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
        segmentSnapshots?: ClipboardSegmentSnapshot[]
      }>
    ) {
      const { mode, items, sourceTopicId, segmentSnapshots } = action.payload
      state.mode = mode
      state.items = items
      state.sourceTopicId = sourceTopicId
      state.timestamp = Date.now()
      state.segmentSnapshots = segmentSnapshots ?? []
    },
    clearClipboard(state) {
      state.mode = null
      state.items = []
      state.sourceTopicId = null
      state.timestamp = 0
      state.segmentSnapshots = []
    }
  }
})

export const { setClipboard, clearClipboard } = clipboardSlice.actions

export default clipboardSlice.reducer
