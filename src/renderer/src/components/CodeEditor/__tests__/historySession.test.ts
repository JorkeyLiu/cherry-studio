import { history, historyField, redo, redoDepth, undo, undoDepth } from '@codemirror/commands'
// EditorState is re-exported from the direct `@uiw/react-codemirror` entry
// (no transitive-only `@codemirror/state` import).
import { EditorState } from '@uiw/react-codemirror'
import { describe, expect, it } from 'vitest'

import { captureEditorHistory, toHistoryInitialState } from '../historySession'

interface MinimalTransaction {
  changes?: { from: number; to: number; insert?: string }[] | { from: number; to: number; insert?: string }
  selection?: { anchor: number; head: number }
}

/** Command target surface, derived from the real command (no transitive-only imports). */
type UndoTarget = Parameters<typeof undo>[0]

/** Real EditorState host exposing the view-like `{ state, dispatch }` surface commands need. */
function makeHost(doc: string) {
  let state = EditorState.create({ doc, extensions: [history()] })
  const transact = (transaction: MinimalTransaction) => {
    state = state.update(transaction).state
  }
  const host: UndoTarget = {
    get state() {
      return state
    },
    dispatch: (transaction) => {
      state = state.update(transaction).state
    }
  }
  return { host, transact, getState: () => state }
}

/** View-like over an explicitly held state, typed for the real commands. */
function viewOver(get: () => EditorState, set: (state: EditorState) => void): UndoTarget {
  return {
    get state() {
      return get()
    },
    dispatch: (transaction) => {
      set(get().update(transaction).state)
    }
  }
}

describe('CodeEditor native history session (real EditorState)', () => {
  it('captures a serializable session after typing and restores undo/redo on a fresh state', () => {
    const { host, transact } = makeHost('')
    transact({ changes: { from: 0, to: 0, insert: 'hello' } })
    expect(host.state.doc.toString()).toBe('hello')
    expect(undoDepth(host.state)).toBe(1)

    const snapshot = captureEditorHistory(host.state)
    expect(snapshot).not.toBeNull()
    expect(snapshot?.doc).toBe('hello')

    // Fresh mount of the same document restores the session exactly the way
    // the production `initialState` path does through @uiw/react-codemirror.
    const initial = toHistoryInitialState(snapshot, 'hello')
    expect(initial).toBeDefined()
    const restored = EditorState.fromJSON(initial?.json, { doc: 'hello', extensions: [history()] }, initial?.fields)
    expect(restored.doc.toString()).toBe('hello')
    expect(undoDepth(restored)).toBe(1)
    expect(redoDepth(restored)).toBe(0)

    // Drive the real commands against the restored state.
    let current: EditorState = restored
    const viewLike = viewOver(
      () => current,
      (next) => {
        current = next
      }
    )
    expect(undo(viewLike)).toBe(true)
    expect(current.doc.toString()).toBe('')
    expect(redo(viewLike)).toBe(true)
    expect(current.doc.toString()).toBe('hello')
  })

  it('preserves the redo stack across the session round trip', () => {
    const { host, transact } = makeHost('')
    transact({ changes: { from: 0, to: 0, insert: 'hello' } })
    expect(undo(host)).toBe(true)
    expect(host.state.doc.toString()).toBe('')
    expect(redoDepth(host.state)).toBe(1)

    const snapshot = captureEditorHistory(host.state)
    const initial = toHistoryInitialState(snapshot, '')
    expect(initial).toBeDefined()
    const restored = EditorState.fromJSON(initial?.json, { doc: '', extensions: [history()] }, initial?.fields)
    expect(undoDepth(restored)).toBe(0)
    expect(redoDepth(restored)).toBe(1)

    let current: EditorState = restored
    const viewLike = viewOver(
      () => current,
      (next) => {
        current = next
      }
    )
    expect(redo(viewLike)).toBe(true)
    expect(current.doc.toString()).toBe('hello')
  })

  it('drops the session when the document moved on while unmounted', () => {
    const { host, transact } = makeHost('')
    transact({ changes: { from: 0, to: 0, insert: 'hello' } })
    const snapshot = captureEditorHistory(host.state)
    // The parent draft changed while no engine was mounted: restoring the
    // stale history under the new document would corrupt positions, so the
    // next mount starts fresh and the edited text owns the remount.
    expect(toHistoryInitialState(snapshot, 'EDITED WHILE UNMOUNTED')).toBeUndefined()
  })

  it('returns null when the state carries no history field, and undefined for empty snapshots', () => {
    const bare = EditorState.create({ doc: 'plain' })
    expect(bare.field(historyField, false)).toBeUndefined()
    expect(captureEditorHistory(bare)).toBeNull()
    expect(toHistoryInitialState(null, 'plain')).toBeUndefined()
    expect(toHistoryInitialState(undefined, 'plain')).toBeUndefined()
  })
})
