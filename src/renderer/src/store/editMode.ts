import type { PayloadAction } from '@reduxjs/toolkit'
import { createSlice } from '@reduxjs/toolkit'
import type { EditModeState } from '@renderer/types/editMode'

const initialState: EditModeState = {
  enabled: false,
  selectedGroupIds: [],
  lastSelectedIndex: null
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
      }
    },
    setSelectedGroupIds(state, action: PayloadAction<string[]>) {
      state.selectedGroupIds = action.payload
    },
    setLastSelectedIndex(state, action: PayloadAction<number | null>) {
      state.lastSelectedIndex = action.payload
    },
    clearSelection(state) {
      state.selectedGroupIds = []
      state.lastSelectedIndex = null
    }
  }
})

export const { toggleEditMode, setSelectedGroupIds, setLastSelectedIndex, clearSelection } = editModeSlice.actions

export default editModeSlice.reducer
