import type { Dispatch, PayloadAction } from '@reduxjs/toolkit'
import { createSlice, current } from '@reduxjs/toolkit'
import type { UndoAction, UndoStackState } from '@renderer/types/editMode'

const MAX_STACK_SIZE = 50

/**
 * History replay gate.
 *
 * Undo/redo replays run over an authority round-trip. A branch (or paste)
 * operation that commits *during* that round-trip would land its push between
 * the replay's start and its `commitUndo/RedoAction`, clearing the redo stack
 * and then receiving a redo entry that is no longer LIFO. Such a push is held
 * until the replay finishes and is applied in arrival order afterwards: the new
 * operation still clears redo (its normal semantics), no committed operation
 * loses its history entry, and the cursor stays a true LIFO chain.
 */
let historyReplayDepth = 0
const deferredHistoryPushes: UndoAction[] = []

/** Mark the start of one replay round-trip (undo or redo). */
export function beginHistoryReplay(): void {
  historyReplayDepth += 1
}

/** Mark the end of one replay and release any history push it held back. */
export function endHistoryReplay(dispatch: Dispatch): void {
  historyReplayDepth = Math.max(0, historyReplayDepth - 1)
  if (historyReplayDepth > 0) return
  const queued = deferredHistoryPushes.splice(0)
  for (const action of queued) dispatch(pushUndoAction(action))
}

/**
 * Record one committed operation in history.
 *
 * Every push site goes through here so a push can never interleave with an
 * in-flight replay (see `beginHistoryReplay`).
 */
export function recordUndoAction(dispatch: Dispatch, action: UndoAction): void {
  if (historyReplayDepth > 0) {
    deferredHistoryPushes.push(action)
    return
  }
  dispatch(pushUndoAction(action))
}

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
    /**
     * Commit a completed undo: the addressed action leaves the undo stack and
     * becomes redoable. Addressed by id so a concurrent push during the
     * authority round-trip never corrupts the cursor; an action that is no
     * longer present is a no-op.
     */
    commitUndoAction(state, action: PayloadAction<string>) {
      const index = state.undoStack.findIndex((entry) => entry.id === action.payload)
      if (index === -1) return
      const [committed] = state.undoStack.splice(index, 1)
      state.redoStack.push(committed)
    },
    /** Commit a completed redo: the addressed action becomes undoable again. */
    commitRedoAction(state, action: PayloadAction<string>) {
      const index = state.redoStack.findIndex((entry) => entry.id === action.payload)
      if (index === -1) return
      const [committed] = state.redoStack.splice(index, 1)
      state.undoStack.push(committed)
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

export const { pushUndoAction, prepareUndo, prepareRedo, clearUndoStack, commitUndoAction, commitRedoAction } =
  undoStackSlice.actions

export default undoStackSlice.reducer
