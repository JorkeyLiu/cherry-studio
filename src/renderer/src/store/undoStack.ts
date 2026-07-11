import type { PayloadAction } from '@reduxjs/toolkit'
import { createSlice, current } from '@reduxjs/toolkit'
import type { UndoAction, UndoStackState } from '@renderer/types/editMode'

const MAX_STACK_SIZE = 50

const initialState: UndoStackState = {
  undoStack: [],
  redoStack: []
}

const undoStackSlice = createSlice({
  name: 'undoStack',
  initialState,
  reducers: {
    pushUndoAction(state, action: PayloadAction<UndoAction>) {
      state.undoStack.push(action.payload)
      if (state.undoStack.length > MAX_STACK_SIZE) {
        state.undoStack.shift()
      }
      state.redoStack = []
    },
    prepareUndo(state) {
      if (state.undoStack.length === 0) return
      const lastAction = current(state.undoStack).at(-1)!
      state.undoStack.pop()
      state.redoStack.push(lastAction)
    },
    prepareRedo(state) {
      if (state.redoStack.length === 0) return
      const lastAction = current(state.redoStack).at(-1)!
      state.redoStack.pop()
      state.undoStack.push(lastAction)
    },
    clearUndoStack(state) {
      state.undoStack = []
      state.redoStack = []
    }
  }
})

export const { pushUndoAction, prepareUndo, prepareRedo, clearUndoStack } = undoStackSlice.actions

export default undoStackSlice.reducer
