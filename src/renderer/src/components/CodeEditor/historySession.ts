import { historyField } from '@codemirror/commands'
import type { EditorView } from '@codemirror/view'

import type { EditorHistorySnapshot } from './types'

/**
 * Native-history session helpers (local editing-session scope).
 *
 * CodeMirror's `history()` extension owns the single canonical undo/redo
 * stack, but a fresh `EditorState` starts with an empty stack — so every
 * engine remount (source<->preview, inline<->expanded) would reset history.
 * These helpers carry the live stack across the remount inside the owning
 * component only:
 *
 * - `captureEditorHistory` serializes the stack via the field's own
 *   `toJSON` (done/undone `HistEvent`s with changes + selections).
 * - `toHistoryInitialState` rebuilds the `@uiw/react-codemirror`
 *   `initialState` (`EditorState.fromJSON(json, config, { history })`),
 *   which deserializes the stack via `historyField.fromJSON` while every
 *   other extension (theme, keymaps, handlers) comes fresh from the current
 *   props — no stale closures are resurrected.
 *
 * The snapshot is ephemeral component-local state: it never leaves the
 * editing session, is never persisted, and is only applied when its document
 * still matches the mount document (so a parent-draft write that landed
 * while no engine was mounted correctly starts a fresh history instead of
 * reapplying an obsolete document).
 */

/** `EditorState` without importing the transitive-only `@codemirror/state`. */
type HistoryStateHost = EditorView['state']

const HISTORY_FIELD_NAME = 'history'

/**
 * Capture the live engine's native history plus its document.
 * Returns null when the state carries no history field or serialization
 * fails — callers keep the previous snapshot in that case.
 */
export function captureEditorHistory(state: HistoryStateHost): EditorHistorySnapshot | null {
  try {
    if (state.field(historyField, false) == null) return null
    const json = state.toJSON({ [HISTORY_FIELD_NAME]: historyField })
    if (!json || typeof json !== 'object') return null
    return { json, doc: state.doc.toString() }
  } catch {
    return null
  }
}

/**
 * Build the `@uiw/react-codemirror` `initialState` restoring a snapshot.
 * Returns undefined when there is no snapshot or the snapshot document no
 * longer matches the mount document.
 */
export function toHistoryInitialState(
  snapshot: EditorHistorySnapshot | null | undefined,
  mountDoc: string
): { json: unknown; fields: Record<string, typeof historyField> } | undefined {
  if (!snapshot || snapshot.doc !== mountDoc) return undefined
  try {
    const json = (snapshot.json ?? {}) as Record<string, unknown>
    return { json: { ...json, doc: mountDoc }, fields: { [HISTORY_FIELD_NAME]: historyField } }
  } catch {
    return undefined
  }
}
