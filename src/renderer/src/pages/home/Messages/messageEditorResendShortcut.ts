import { isMac } from '@renderer/config/constant'
import { EditorView, type Extension, Prec } from '@uiw/react-codemirror'

/**
 * Cmd+Enter (macOS) / Ctrl+Enter (other platforms) for the existing-message
 * editor.
 *
 * The editor already exposes a resend action for user messages (the green
 * send button next to save/cancel). This binds the same action to the platform
 * mod+Enter — nothing else: plain Enter keeps inserting a newline, and
 * assistant edits (which have no resend action) get no binding at all.
 *
 * The binding is added with `Prec.highest` because the editor's own keymap
 * handles `Enter` and `Mod-Enter` at default precedence; a default-precedence
 * handler would never see the event. Taking the event here also means the
 * shortcut runs the resend action exactly once (the keymap default never
 * runs, so no line is inserted alongside).
 */
export const MESSAGE_EDITOR_RESEND_SHORTCUT = 'Mod+Enter' as const

interface ResendShortcutOptions {
  /** The message role that owns this editor instance. */
  role: string
  /** Existing submission guard: true while a save/resend is in flight. */
  isDisabled: () => boolean
  /** The existing resend action (same callback as the resend button). */
  onResend: () => void
}

export interface ResendShortcutHandlerOptions {
  isDisabled: () => boolean
  onResend: () => void
  /**
   * Platform mod convention: Cmd on macOS, Ctrl everywhere else. Defaults to
   * the app platform and is only overridden by tests.
   */
  useMetaKey?: boolean
}

/**
 * Keydown decision for the resend shortcut. Returns true when the event is
 * consumed (propagation and the editor default never run).
 */
export const createMessageEditorResendKeyDownHandler =
  ({ isDisabled, onResend, useMetaKey = isMac }: ResendShortcutHandlerOptions) =>
  (event: KeyboardEvent): boolean => {
    if (event.key !== 'Enter') return false
    // Never submit while an IME composition is being confirmed.
    if (event.isComposing || event.keyCode === 229) return false
    const modPressed = useMetaKey ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
    // Exactly the platform mod: no Shift/Alt combination is this shortcut, and
    // the opposite platform modifier must not act as a second binding.
    if (!modPressed || event.shiftKey || event.altKey) return false
    // Consume before acting: the platform modifier has no second meaning in
    // the editor, and the default binding must not also run.
    event.preventDefault()
    event.stopPropagation()
    // Existing guards: a disabled editor (already saving/resending) consumes
    // the key without a second submission.
    if (isDisabled()) return true
    onResend()
    return true
  }

/**
 * Extensions for one editor instance: the resend shortcut for user messages,
 * nothing for every other role.
 */
export const createMessageEditorResendExtensions = ({
  role,
  isDisabled,
  onResend
}: ResendShortcutOptions): Extension[] => {
  if (role !== 'user') return []
  return [
    Prec.highest(
      EditorView.domEventHandlers({
        keydown: createMessageEditorResendKeyDownHandler({ isDisabled, onResend })
      })
    )
  ]
}
