import type { PayloadAction } from '@reduxjs/toolkit'
import { createSlice } from '@reduxjs/toolkit'
import type { ClipboardItem, ClipboardMode, ClipboardState } from '@renderer/types/editMode'

const initialState: ClipboardState = {
  mode: null,
  items: [],
  sourceTopicId: null,
  timestamp: 0
}

const clipboardSlice = createSlice({
  name: 'clipboard',
  initialState,
  reducers: {
    setClipboard(state, action: PayloadAction<{ mode: ClipboardMode; items: ClipboardItem[]; sourceTopicId: string }>) {
      const { mode, items, sourceTopicId } = action.payload
      state.mode = mode
      state.items = items
      state.sourceTopicId = sourceTopicId
      state.timestamp = Date.now()
    },
    clearClipboard(state) {
      state.mode = null
      state.items = []
      state.sourceTopicId = null
      state.timestamp = 0
    }
  }
})

export const { setClipboard, clearClipboard } = clipboardSlice.actions

export default clipboardSlice.reducer
