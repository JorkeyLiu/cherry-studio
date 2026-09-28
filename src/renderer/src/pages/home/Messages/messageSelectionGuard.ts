import { useEffect } from 'react'

/**
 * Boundary-aware native-selection guard for the message list.
 *
 * - Ordinary text selection wholly within one `[data-message-id]` container
 *   is preserved.
 * - A native range spanning multiple message containers is cleared, so Shift
 *   multi-select (and Shift+drag) never leaves a native text selection behind.
 * - In edit mode selection-only semantics take precedence: native text
 *   selection inside messages is suppressed at `selectstart`/`mousedown`
 *   time (the click-capture path still performs group selection).
 */

const MESSAGE_SELECTOR = '[data-message-id]'

function nodeToElement(node: Node | null): Element | null {
  if (!node) return null
  if (node instanceof Element) return node
  return node.parentElement
}

function messageContainerOf(node: Node | null): Element | null {
  const el = nodeToElement(node)
  return el?.closest?.(MESSAGE_SELECTOR) ?? null
}

/**
 * Pure predicate: does `selection` currently span more than one message
 * container? Collapsed, empty, or single-container selections return false.
 * Endpoints outside any message container are treated as distinct from a
 * message container (cross-boundary), but a selection wholly outside
 * messages is left alone (returns false) — this guard only polices ranges
 * that touch message content.
 */
export function isCrossMessageNativeSelection(selection: Selection | null): boolean {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false
  const anchorContainer = messageContainerOf(selection.anchorNode)
  const focusContainer = messageContainerOf(selection.focusNode)
  // Wholly outside the message list: not our concern.
  if (!anchorContainer && !focusContainer) return false
  return anchorContainer !== focusContainer
}

/**
 * Enforce the boundary: clear a cross-message native range, retain anything
 * else (collapsed, single-message, or outside-messages selections).
 * Returns true when a range was cleared.
 */
export function clampCrossMessageNativeSelection(selection: Selection | null): boolean {
  if (!isCrossMessageNativeSelection(selection)) return false
  selection!.removeAllRanges()
  return true
}

/** Always-on guard: keep the document selection from spanning messages. */
export function useCrossMessageSelectionGuard(): void {
  useEffect(() => {
    const onSelectionChange = () => {
      clampCrossMessageNativeSelection(document.getSelection())
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [])
}

/**
 * Edit-mode suppression: while enabled, prevent native text-range creation
 * inside message containers (including Shift multi-select mousedowns).
 * Group selection still flows through the click-capture path.
 */
export function useEditModeNativeSelectionSuppression(
  isEditMode: boolean,
  scrollContainerRef: React.RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    if (!isEditMode) return
    const el = scrollContainerRef.current
    if (!el) return
    const onSelectStart = (e: Event) => {
      e.preventDefault()
    }
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest?.(MESSAGE_SELECTOR)) {
        // Stop the browser from opening a native text range (Shift+click /
        // drag); the subsequent click-capture performs group selection.
        e.preventDefault()
      }
    }
    el.addEventListener('selectstart', onSelectStart)
    el.addEventListener('mousedown', onMouseDown)
    return () => {
      el.removeEventListener('selectstart', onSelectStart)
      el.removeEventListener('mousedown', onMouseDown)
    }
  }, [isEditMode, scrollContainerRef])
}
