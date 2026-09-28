/**
 * Neutral Escape-consumption contract between the open Inputbar ToolPopover
 * and the edit-mode Escape layer (useClipboardKeyboard).
 *
 * The popover's window listener runs in the capture phase so the marker is
 * always visible to the hook's bubble-phase listener, independent of listener
 * registration order. Only the cooperating edit-mode layer reads the marker;
 * unrelated Escape handlers are unaffected.
 *
 * Dependency-free by design: this module imports no React, store, i18n, or
 * edit-mode context so lightweight ToolPopover consumers (e.g. Inputbar tool
 * buttons) never pull the edit-mode hook graph.
 */
export const TOOL_POPOVER_ESCAPE_CONSUMED = '__cherryToolPopoverEscapeConsumed'

export type MarkedKeyboardEvent = KeyboardEvent & { [TOOL_POPOVER_ESCAPE_CONSUMED]?: boolean }
