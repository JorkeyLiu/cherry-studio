import { isMac } from '@renderer/config/constant'

/**
 * Cmd+F (macOS) / Ctrl+F (other platforms) for the existing-message editor.
 *
 * The editor already exposes its own find/replace toggle (the toolbar find
 * button), and this binds that same toggle to the platform mod+F anywhere
 * inside the editor's own surface — content, toolbar and both find/replace
 * fields. Nothing else: it never opens another panel and it never replaces
 * text.
 *
 * The press is taken in the CAPTURE phase by the surface that carries this
 * handler, so it is consumed before the engine's own keydown handler on the
 * content node and before the app shortcut layer, which listens on the
 * document at bubble time and does not consult `defaultPrevented`. Consuming
 * it therefore means both `preventDefault` (no native Find dialog) and
 * `stopPropagation` (no chat-wide message search opening behind the editor's
 * own find bar). Outside the editor's surface this binding never runs: the
 * chat-wide shortcut keeps owning platform mod+F everywhere else.
 */
export const MESSAGE_EDITOR_FIND_SHORTCUT = 'Mod+F' as const

interface FindShortcutOptions {
  /** The existing find/replace toggle (same action as the toolbar button). */
  onToggle: () => void
}

export interface FindShortcutHandlerOptions extends FindShortcutOptions {
  /**
   * Platform mod convention: Cmd on macOS, Ctrl everywhere else. Defaults to
   * the app platform and is only overridden by tests.
   */
  useMetaKey?: boolean
}

/**
 * Keydown decision for the find/replace shortcut. Returns true when the event
 * is consumed (propagation and the native/engine default never run).
 */
export const createMessageEditorFindKeyDownHandler =
  ({ onToggle, useMetaKey = isMac }: FindShortcutHandlerOptions) =>
  (event: KeyboardEvent): boolean => {
    // `toLowerCase` keeps Caps Lock ('F') from disabling the shortcut.
    if (event.key.toLowerCase() !== 'f') return false
    // Never toggle while an IME composition is being confirmed: the
    // composition window owns the key.
    if (event.isComposing || event.keyCode === 229) return false
    const modPressed = useMetaKey ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
    // Exactly the platform mod: no Shift/Alt combination is this shortcut, and
    // the opposite platform modifier must not act as a second binding.
    if (!modPressed || event.shiftKey || event.altKey) return false
    // Consume before acting: the platform modifier has no second meaning in
    // the editor, and neither the native Find dialog nor an outer handler may
    // also run.
    event.preventDefault()
    event.stopPropagation()
    onToggle()
    return true
  }
