import type { EditorView } from '@codemirror/view'
import type { BasicSetupOptions, Extension } from '@uiw/react-codemirror'

export interface CodeEditorHandles {
  save?: () => void
  scrollToLine?: (lineNumber: number, options?: { highlight?: boolean }) => void
  getContent?: () => string
  /**
   * Focus the live editor view without moving the outer viewport.
   * Optional: only implemented by CodeEditorImpl; other consumers unaffected.
   */
  focus?: (options?: { preventScroll?: boolean }) => void
  /**
   * Direct access to the live CodeMirror view for selection-aware operations
   * (toolbar formatting, find navigation). Optional engine access: returns
   * null before mount. Callers must treat view reads as local UI state and
   * never persist engine objects.
   */
  getView?: () => EditorView | null
}

/**
 * Serializable native-history session captured from a live engine.
 *
 * Ephemeral and component-local: produced by `captureEditorHistory` from the
 * current view state immediately before the engine unmounts (preview / expand
 * / collapse) and consumed once as `@uiw/react-codemirror` `initialState` on
 * the next mount of the same editing session. Never persisted, never shared
 * across editor instances, never written back to saved content.
 */
export interface EditorHistorySnapshot {
  /** `EditorState.toJSON({ history: historyField })` output. */
  json: unknown
  /** Document text the history was captured against (restore gate). */
  doc: string
}

/** Native undo/redo stack depths driving toolbar disabled states. */
export interface EditorHistoryDepths {
  undo: number
  redo: number
}

export interface CodeEditorProps {
  ref?: React.RefObject<CodeEditorHandles | null>
  /** Value used in controlled mode, e.g., code blocks. */
  value: string
  /** Placeholder when the editor content is empty. */
  placeholder?: string | HTMLElement
  /**
   * Code language string.
   * - Case-insensitive.
   * - Supports common names: javascript, json, python, etc.
   * - Supports aliases: c#/csharp, objective-c++/obj-c++/objc++, etc.
   * - Supports file extensions: .cpp/cpp, .js/js, .py/py, etc.
   */
  language: string
  /** Fired when ref.save() is called or the save shortcut is triggered. */
  onSave?: (newContent: string) => void
  /** Fired when the editor content changes. */
  onChange?: (newContent: string) => void
  /** Fired when the editor loses focus. */
  onBlur?: (newContent: string) => void
  /** Fired when the editor content height changes (natural wrapped content height at the current width). */
  onHeightChange?: (contentHeight: number) => void
  /**
   * Native spellcheck for the editable surface. Undefined preserves the
   * previous behavior (no content-attributes extension).
   */
  spellcheck?: boolean
  /**
   * Captures keydown inside the editor (IME-aware handling lives with the
   * caller). Return true to prevent the default CodeMirror handling.
   */
  onEditorKeyDown?: (event: KeyboardEvent) => boolean
  /** Observes native paste inside the editor (caller routes to PasteService). */
  onEditorPaste?: (event: ClipboardEvent) => void
  /** Observes native focus inside the editor (caller tracks focus ownership). */
  onEditorFocus?: () => void
  /** Observes native contextmenu inside the editor (caller preserves behavior). */
  onEditorContextMenu?: (event: MouseEvent) => void
  /** Fired once the live editor view is created (ready for focus/selection). */
  onEditorReady?: () => void
  /**
   * Ephemeral native-history session for the current editing session.
   * When provided, the next engine mount restores it as its initial history
   * (only when the snapshot document still matches the mount document).
   * Optional: only MessageEditor provides it; every other consumer keeps the
   * exact previous behavior with a fresh history per mount.
   */
  historySnapshot?: EditorHistorySnapshot | null
  /**
   * Reports live native undo/redo depths: once on engine mount and whenever
   * a transaction changes them. Must be identity-stable (the engine
   * subscribes once); depths drive toolbar disabled states. Optional: only
   * MessageEditor subscribes.
   */
  onHistoryChange?: (depths: EditorHistoryDepths) => void
  /**
   * Fixed editor height, not exceeding maxHeight.
   * Only works when expanded is false.
   */
  height?: string
  /**
   * Maximum editor height.
   * Only works when expanded is false.
   */
  maxHeight?: string
  /** Minimum editor height. */
  minHeight?: string
  /** Editor options that extend BasicSetupOptions. */
  options?: {
    /**
     * Whether to enable special treatment for stream response.
     * @default false
     */
    stream?: boolean
    /**
     * Whether to enable linting.
     * @default false
     */
    lint?: boolean
    /**
     * Whether to enable keymap.
     * @default false
     */
    keymap?: boolean
  } & BasicSetupOptions
  /** Additional extensions for CodeMirror. */
  extensions?: Extension[]
  /** Font size that overrides the app setting. */
  fontSize?: number
  /** Style overrides for the editor, passed directly to CodeMirror's style property. */
  style?: React.CSSProperties
  /** CSS class name appended to the default `code-editor` class. */
  className?: string
  /**
   * Whether the editor view is editable.
   * @default true
   */
  editable?: boolean
  /**
   * Set the editor state to read only but keep some user interactions, e.g., keymaps.
   * @default false
   */
  readOnly?: boolean
  /**
   * Whether the editor is expanded.
   * If true, the height and maxHeight props are ignored.
   * @default true
   */
  expanded?: boolean
  /**
   * Whether the code lines are wrapped.
   * @default true
   */
  wrapped?: boolean
}
