import { type MarkedKeyboardEvent, TOOL_POPOVER_ESCAPE_CONSUMED } from '@renderer/utils/toolPopoverEscape'
import { useCallback, useEffect, useRef, useState } from 'react'

const INTERACTIVE_OVERLAY_SELECTOR =
  '.ant-popover, .ant-dropdown, .ant-select-dropdown, .ant-picker-dropdown, .ant-tooltip, .ant-modal-root, .ant-modal-wrap, .ant-drawer, .topview-fullscreen-container'

const OVERLAY_HOST_SELECTOR =
  '.ant-popover, .ant-dropdown, .ant-select-dropdown, .ant-picker-dropdown, .ant-modal-root, .ant-drawer-open, .topview-fullscreen-container'

const INTERACTIVE_OR_EDITABLE_SELECTOR =
  'input, textarea, select, button, a[href], summary, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="textbox"], [role="combobox"], .cm-editor'

const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], [role="textbox"], .cm-editor'

function isEditableElement(el: Element | null): boolean {
  if (!el) return false
  if (el instanceof HTMLElement && el.isContentEditable) return true
  return Boolean(el.closest(EDITABLE_SELECTOR))
}

function isInteractiveOrEditableTarget(el: Element | null, capsuleEl: HTMLElement | null): boolean {
  if (!el) return false
  if (capsuleEl && capsuleEl.contains(el)) return false
  if (el instanceof HTMLElement && el.isContentEditable) return true
  return Boolean(el.closest(INTERACTIVE_OR_EDITABLE_SELECTOR))
}

function hasOpenOverlay(): boolean {
  const nodes = document.querySelectorAll(OVERLAY_HOST_SELECTOR)
  for (const node of nodes) {
    if (
      node.classList.contains('ant-popover-hidden') ||
      node.classList.contains('ant-dropdown-hidden') ||
      node.classList.contains('ant-select-dropdown-hidden')
    ) {
      continue
    }
    if (node instanceof HTMLElement && window.getComputedStyle(node).display === 'none') {
      continue
    }
    return true
  }
  return false
}

export interface UseInputbarIslandOptions {
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  focusTextarea: () => void
  resizeTextArea: (force?: boolean) => void
  islandRef: React.RefObject<HTMLDivElement | null>
  capsuleRef: React.RefObject<HTMLDivElement | null>
}

export function useInputbarIsland({
  expanded,
  onExpandedChange,
  focusTextarea,
  resizeTextArea,
  islandRef,
  capsuleRef
}: UseInputbarIslandOptions) {
  const [internalExpanded, setInternalExpanded] = useState(true)
  const isControlled = expanded !== undefined
  const isExpanded = isControlled ? expanded : internalExpanded
  const isExpandedRef = useRef(isExpanded)
  isExpandedRef.current = isExpanded

  const pointerDownInsideRef = useRef(false)

  const setExpanded = useCallback(
    (next: boolean) => {
      if (!isControlled) {
        setInternalExpanded(next)
      }
      onExpandedChange?.(next)
    },
    [isControlled, onExpandedChange]
  )

  const expandAndFocus = useCallback(() => {
    setExpanded(true)
    requestAnimationFrame(() => {
      resizeTextArea()
      focusTextarea()
    })
  }, [focusTextarea, resizeTextArea, setExpanded])

  const collapse = useCallback(
    (options?: { blurActive?: boolean }) => {
      setExpanded(false)
      if (options?.blurActive) {
        const active = document.activeElement
        if (active instanceof HTMLElement && islandRef.current?.contains(active)) {
          active.blur()
        }
      }
    },
    [islandRef, setExpanded]
  )

  // Intent-based outside click detection: clicking inside the island or an
  // open portal overlay keeps the composer expanded; clicking outside onto the
  // message canvas or sidebar collapses it.
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!isExpandedRef.current) return
      const target = event.target instanceof Element ? event.target : null
      const insideIsland = Boolean(target && islandRef.current?.contains(target))
      const insideOverlay = Boolean(target && target.closest(INTERACTIVE_OVERLAY_SELECTOR))
      pointerDownInsideRef.current = insideIsland || insideOverlay

      if (insideIsland || insideOverlay) return
      if (target && target.closest('[data-testid="content-search-host"]')) return
      // If an AntD popover/dropdown is open, let this outside click dismiss
      // the popover first rather than collapsing the whole composer at once.
      if (hasOpenOverlay()) return
      collapse()
    }

    const handlePointerUp = () => {
      if (!pointerDownInsideRef.current) return
      requestAnimationFrame(() => {
        pointerDownInsideRef.current = false
      })
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('pointerup', handlePointerUp, true)
    document.addEventListener('pointercancel', handlePointerUp, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('pointerup', handlePointerUp, true)
      document.removeEventListener('pointercancel', handlePointerUp, true)
    }
  }, [collapse, islandRef])

  // Intent-based blur capture: covers keyboard Tab leaving the island without
  // collapsing when focus moves to an internal control, a portal overlay, or
  // another OS window (Cmd+Tab).
  const handleIslandBlurCapture = useCallback(() => {
    requestAnimationFrame(() => {
      if (!isExpandedRef.current) return
      if (pointerDownInsideRef.current) return
      if (typeof document.hasFocus === 'function' && !document.hasFocus()) return

      const active = document.activeElement instanceof Element ? document.activeElement : null
      if (active && (islandRef.current?.contains(active) || active.closest(INTERACTIVE_OVERLAY_SELECTOR))) {
        return
      }
      if (hasOpenOverlay()) return
      collapse()
    })
  }, [collapse, islandRef])

  // Keyboard shortcuts:
  // - Expanded: Escape (after IME / ToolPopover / ContentSearch / modal guards) collapses.
  // - Collapsed: Space / Enter (when no other input, button, or overlay holds focus) expands.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return

      if (isExpandedRef.current) {
        if (event.key !== 'Escape' && event.key !== 'Esc') return
        if ((event as MarkedKeyboardEvent)[TOOL_POPOVER_ESCAPE_CONSUMED]) return
        if (hasOpenOverlay() || document.querySelector('[data-testid="content-search-host"]')) return

        const active = document.activeElement instanceof Element ? document.activeElement : null
        if (active && !islandRef.current?.contains(active) && isEditableElement(active)) return

        event.preventDefault()
        collapse({ blurActive: true })
        return
      }

      const isSpace = event.key === ' ' || event.code === 'Space'
      const isEnter = event.key === 'Enter'
      if (!isSpace && !isEnter) return
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (hasOpenOverlay() || document.querySelector('[data-testid="content-search-host"]')) return

      const active = document.activeElement instanceof Element ? document.activeElement : null
      const target = event.target instanceof Element ? event.target : null
      if (
        isInteractiveOrEditableTarget(active, capsuleRef.current) ||
        isInteractiveOrEditableTarget(target, capsuleRef.current)
      ) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      expandAndFocus()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [capsuleRef, collapse, expandAndFocus, islandRef])

  return {
    isExpanded,
    isExpandedRef,
    expandAndFocus,
    collapse,
    handleIslandBlurCapture
  }
}
