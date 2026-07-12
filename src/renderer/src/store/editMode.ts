import type { PayloadAction } from '@reduxjs/toolkit'
import { createSlice } from '@reduxjs/toolkit'
import type { EditModeState } from '@renderer/types/editMode'

const initialState: EditModeState = {
  enabled: false,
  selectedGroupIds: [],
  lastSelectedIndex: null,
  focusedIndex: null,
  isProcessing: false
}

const editModeSlice = createSlice({
  name: 'editMode',
  initialState,
  reducers: {
    toggleEditMode(state, action: PayloadAction<boolean>) {
      state.enabled = action.payload
      if (!action.payload) {
        state.selectedGroupIds = []
        state.lastSelectedIndex = null
        state.focusedIndex = null
      }
    },
    setSelectedGroupIds(state, action: PayloadAction<string[]>) {
      state.selectedGroupIds = action.payload
    },
    setLastSelectedIndex(state, action: PayloadAction<number | null>) {
      state.lastSelectedIndex = action.payload
    },
    setFocusedIndex(state, action: PayloadAction<number | null>) {
      state.focusedIndex = action.payload
    },
    clearSelection(state) {
      state.selectedGroupIds = []
      state.lastSelectedIndex = null
      state.focusedIndex = null
    },
    startProcessing(state) {
      state.isProcessing = true
    },
    finishProcessing(state) {
      state.isProcessing = false
    },
    moveFocusSelection(state, action: PayloadAction<{ groupId: string; index: number }>) {
      state.selectedGroupIds = [action.payload.groupId]
      state.lastSelectedIndex = action.payload.index
      state.focusedIndex = action.payload.index
    }
  }
})

export const {
  toggleEditMode,
  setSelectedGroupIds,
  setLastSelectedIndex,
  setFocusedIndex,
  clearSelection,
  startProcessing,
  finishProcessing,
  moveFocusSelection
} = editModeSlice.actions

export default editModeSlice.reducer
