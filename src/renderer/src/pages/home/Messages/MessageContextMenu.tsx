import { useSelectionContextMenu } from '@renderer/components/ContextMenu/useSelectionContextMenu'
import { useEditModeContextMenuItems } from '@renderer/components/EditModeContextMenu/useEditModeContextMenuItems'
import { useEditMode } from '@renderer/context/EditModeContext'
import type { MenuProps } from 'antd'
import { Dropdown } from 'antd'
import { cloneElement, isValidElement, memo, useCallback, useEffect, useState } from 'react'

interface MessageContextMenuProps {
  children: React.ReactNode
  topicId: string
}

/**
 * Stable context-menu host for the message list (PERF-100).
 *
 * Previously Messages.tsx swapped <ContextMenu> and <EditModeContextMenu> at
 * the older-paging wrapper child position on every edit-mode toggle, remounting the
 * whole ScrollContainer / MessageGroup / MessageItem / Markdown subtree.
 *
 * This host renders a single Dropdown wrapper in both modes so the message
 * subtree keeps its DOM identity across an edit-mode flip:
 * - normal mode: selection-text copy / quote (shared selection menu behavior)
 * - edit mode:   edit-mode selection operations (copy/cut/paste/delete/
 *                segment/undo/redo, shared edit-mode menu behavior)
 *
 * Excluded-area context-menu suppression is handled by MessageItem's own
 * onContextMenu handler, which stops propagation inside edit mode.
 */
const MessageContextMenu: React.FC<MessageContextMenuProps> = ({ children, topicId }) => {
  const { isEnabled } = useEditMode()
  const { items: selectionItems, onOpenChange: selectionMenuOpenChange } = useSelectionContextMenu()
  const editModeMenu = useEditModeContextMenuItems(topicId)

  // Controlled open: the single stable host never remounts across edit-mode
  // flips, so an uncontrolled popup would survive the flip with swapped
  // items (residual menu on shortcut exit + re-enter).
  const [open, setOpen] = useState(false)

  const items: MenuProps['items'] = isEnabled ? editModeMenu.items : selectionItems

  const onOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next)
      // Selection capture only applies in normal mode; edit-mode selection is
      // managed by the edit-mode slice through MessageItem's click/context
      // handlers.
      if (!isEnabled) {
        selectionMenuOpenChange(next)
      }
    },
    [isEnabled, selectionMenuOpenChange]
  )

  // Dismiss any open menu when the edit-mode lifecycle flips (exit or
  // re-enter, including the toggle_edit_mode shortcut path which dispatches
  // the same toggleEditMode action) or when the topic changes: reopening
  // always requires a fresh right-click.
  useEffect(() => {
    setOpen(false)
  }, [isEnabled, topicId])

  // Blank-click dismissal inside the host. rc-trigger closes a
  // trigger=['contextMenu'] popup on bubbled click (rc-dropdown defaults
  // hideAction to ['click'] when trigger contains 'contextMenu'), but the
  // edit-mode turn capture (EditTurn handleClickCapture) stopPropagation()s
  // the click for selection, so the bubbled close never fires — while the
  // window-level mousedown hook (useWinClick) deliberately ignores
  // inside-target presses. A capture-phase dismiss on the trigger child runs
  // outer-first, before the inner stopPropagation, and never prevents or
  // selects: selection/scroll behavior is untouched.
  const handleDismissCapture = useCallback(() => {
    setOpen(false)
  }, [])

  // Single-child contract shared with rc-trigger (Children.only); the cloned
  // element keeps type/key/props so the ScrollContainer subtree never
  // remounts. ScrollContainer carries no own onClickCapture.
  const triggerNode = isValidElement<{ onClickCapture?: React.MouseEventHandler }>(children)
    ? cloneElement(children, { onClickCapture: handleDismissCapture })
    : children

  return (
    <Dropdown open={open} onOpenChange={onOpenChange} menu={{ items }} trigger={['contextMenu']}>
      {triggerNode}
    </Dropdown>
  )
}

export default memo(MessageContextMenu)
