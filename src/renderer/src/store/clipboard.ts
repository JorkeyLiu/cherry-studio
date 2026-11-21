import type { PayloadAction } from '@reduxjs/toolkit'
import { createSlice } from '@reduxjs/toolkit'
import type {
  ClipboardItem,
  ClipboardMode,
  ClipboardSegmentSnapshot,
  ClipboardState,
  ClipboardTreeCapture,
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
        /** Ordinary group content. A tree capture carries none (explicit kind). */
        items?: ClipboardItem[]
        sourceTopicId: string
        sourceBranchId: string | null
        segmentSnapshots?: ClipboardSegmentSnapshot[]
        sourceProjection?: StagedCutSourceProjection | null
        /** Opt-in tree capture; absent means this publication is not a tree one. */
        tree?: ClipboardTreeCapture | null
      }>
    ) {
      const { mode, items, sourceTopicId, sourceBranchId, segmentSnapshots, sourceProjection, tree } = action.payload
      state.mode = mode
      state.items = items ?? []
      state.sourceTopicId = sourceTopicId
      state.sourceBranchId = sourceBranchId
      state.timestamp = Date.now()
      state.segmentSnapshots = segmentSnapshots ?? []
      // Content kind is explicit and mutually exclusive: a publication that
      // carries no tree capture REPLACES any previous one, so an ordinary
      // copy/cut can never leave a stale tree payload behind for paste.
      if (typeof tree !== 'undefined' && tree !== null) {
        state.tree = tree
      } else {
        delete (state as { tree?: unknown }).tree
      }
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
      delete (state as { tree?: unknown }).tree
    }
  }
})

export const { setClipboard, clearClipboard } = clipboardSlice.actions

export default clipboardSlice.reducer
