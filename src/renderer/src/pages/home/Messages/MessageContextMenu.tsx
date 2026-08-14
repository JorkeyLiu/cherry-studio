import { useSelectionContextMenu } from '@renderer/components/ContextMenu/useSelectionContextMenu'
import { useEditModeContextMenuItems } from '@renderer/components/EditModeContextMenu/useEditModeContextMenuItems'
import { useEditMode } from '@renderer/context/EditModeContext'
import type { MenuProps } from 'antd'
import { Dropdown } from 'antd'
import { memo, useCallback } from 'react'

interface MessageContextMenuProps {
  children: React.ReactNode
  topicId: string
}

/**
 * Stable context-menu host for the message list (PERF-100).
 *
 * Previously Messages.tsx swapped <ContextMenu> and <EditModeContextMenu> at
 * the InfiniteScroll child position on every edit-mode toggle, remounting the
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

  const items: MenuProps['items'] = isEnabled ? editModeMenu.items : selectionItems

  const onOpenChange = useCallback(
    (open: boolean) => {
      // Selection capture only applies in normal mode; edit-mode selection is
      // managed by the edit-mode slice through MessageItem's click/context
      // handlers.
      if (!isEnabled) {
        selectionMenuOpenChange(open)
      }
    },
    [isEnabled, selectionMenuOpenChange]
  )

  return (
    <Dropdown onOpenChange={onOpenChange} menu={{ items }} trigger={['contextMenu']}>
      {children}
    </Dropdown>
  )
}

export default memo(MessageContextMenu)
