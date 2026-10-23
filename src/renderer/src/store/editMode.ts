import type { PayloadAction } from '@reduxjs/toolkit'
import { createSlice } from '@reduxjs/toolkit'
import type { EditModeState } from '@renderer/types/editMode'

const initialState: EditModeState = {
  enabled: false,
  selectedGroupIds: [],
  lastSelectedIndex: null,
  focusedIndex: null,
  anchorGroupId: null,
  focusedGroupId: null,
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
        state.anchorGroupId = null
        state.focusedGroupId = null
      }
    },
    setSelectedGroupIds(state, action: PayloadAction<string[]>) {
      state.selectedGroupIds = action.payload
    },
    setLastSelectedIndex(state, action: PayloadAction<number | null>) {
      state.lastSelectedIndex = action.payload
      state.anchorGroupId = null
    },
    setFocusedIndex(state, action: PayloadAction<number | null>) {
      state.focusedIndex = action.payload
      state.focusedGroupId = null
    },
    setAnchorGroupId(state, action: PayloadAction<string | null>) {
      state.anchorGroupId = action.payload
    },
    setFocusedGroupId(state, action: PayloadAction<string | null>) {
      state.focusedGroupId = action.payload
    },
    clearSelection(state) {
      state.selectedGroupIds = []
      state.lastSelectedIndex = null
      state.focusedIndex = null
      state.anchorGroupId = null
      state.focusedGroupId = null
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
      state.anchorGroupId = action.payload.groupId
      state.focusedGroupId = action.payload.groupId
    },
    /**
     * One atomic Shift-range step: range ids, stable anchor/endpoint ids and
     * their loaded indices are published in a single reducer pass, so no
     * subscriber ever observes a half-applied range (e.g. a new range paired
     * with the previous endpoint id) between per-field actions of a key repeat.
     */
    extendSelectionRange(
      state,
      action: PayloadAction<{
        rangeGroupIds: string[]
        anchorGroupId: string | null
        focusedGroupId: string | null
        anchorIndex: number
        focusedIndex: number
      }>
    ) {
      state.selectedGroupIds = action.payload.rangeGroupIds
      state.lastSelectedIndex = action.payload.anchorIndex
      state.focusedIndex = action.payload.focusedIndex
      state.anchorGroupId = action.payload.anchorGroupId
      state.focusedGroupId = action.payload.focusedGroupId
    }
  }
})

export const {
  toggleEditMode,
  setSelectedGroupIds,
  setLastSelectedIndex,
  setFocusedIndex,
  setAnchorGroupId,
  setFocusedGroupId,
  clearSelection,
  startProcessing,
  finishProcessing,
  moveFocusSelection,
  extendSelectionRange
} = editModeSlice.actions

export default editModeSlice.reducer
