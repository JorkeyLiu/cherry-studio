import { isMac } from '@renderer/config/constant'
import { EditorView, type Extension, Prec } from '@uiw/react-codemirror'

/**
 * Cmd+S (macOS) / Ctrl+S (other platforms) for the existing-message editor.
 *
 * The editor already exposes a save action (the save button next to cancel) for
 * BOTH roles, and this binds that same action to the platform mod+S — nothing
 * else: it never resends, and plain typing is untouched. It uses the same
 * `Prec.highest(EditorView.domEventHandlers(...))` mechanism as the resend
 * binding (`messageEditorResendShortcut.ts`) so one editor owns all of its
 * mod-key bindings in the same way: the handler sees the event before the
 * engine keymap and before the native default.
 *
 * Taking the event here does two things at once: it prevents the native
 * Save Page default and stops the event from bubbling past the editor, and it
 * runs the save action exactly once (the engine keymap never sees the key, so
 * no second action and no inserted character).
 *
 * Save only applies while this editor exists: the bottom new-message composer
 * and every other editor are untouched by this binding.
 */
export const MESSAGE_EDITOR_SAVE_SHORTCUT = 'Mod+S' as const

interface SaveShortcutOptions {
  /** Existing submission guard: true while a save/resend is in flight. */
  isDisabled: () => boolean
  /** The existing save action (same callback as the save button). */
  onSave: () => void
}

export interface SaveShortcutHandlerOptions extends SaveShortcutOptions {
  /**
   * Platform mod convention: Cmd on macOS, Ctrl everywhere else. Defaults to
   * the app platform and is only overridden by tests.
   */
  useMetaKey?: boolean
}

/**
 * Keydown decision for the save shortcut. Returns true when the event is
 * consumed (propagation and the native/engine default never run).
 */
export const createMessageEditorSaveKeyDownHandler =
  ({ isDisabled, onSave, useMetaKey = isMac }: SaveShortcutHandlerOptions) =>
  (event: KeyboardEvent): boolean => {
    // `toLowerCase` keeps Caps Lock ('S') from disabling the shortcut.
    if (event.key.toLowerCase() !== 's') return false
    // Never save while an IME composition is being confirmed.
    if (event.isComposing || event.keyCode === 229) return false
    const modPressed = useMetaKey ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
    // Exactly the platform mod: no Shift/Alt combination is this shortcut, and
    // the opposite platform modifier must not act as a second binding.
    if (!modPressed || event.shiftKey || event.altKey) return false
    // Consume before acting: the platform modifier has no second meaning in
    // the editor, and neither the native Save Page default nor an outer
    // handler may also run.
    event.preventDefault()
    event.stopPropagation()
    // Existing guards: a disabled editor (already saving/resending) consumes
    // the key without a second submission.
    if (isDisabled()) return true
    onSave()
    return true
  }

/**
 * Extensions for one editor instance: the save shortcut for every role (both
 * roles have the save button).
 */
export const createMessageEditorSaveExtensions = ({ isDisabled, onSave }: SaveShortcutOptions): Extension[] => [
  Prec.highest(
    EditorView.domEventHandlers({
      keydown: createMessageEditorSaveKeyDownHandler({ isDisabled, onSave })
    })
  )
]
