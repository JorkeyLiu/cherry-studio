import { useEditMode } from '@renderer/context/EditModeContext'
import { Dropdown } from 'antd'
import { memo } from 'react'

import { useEditModeContextMenuItems } from './useEditModeContextMenuItems'

interface EditModeContextMenuProps {
  children: React.ReactNode
  topicId: string
}

const EditModeContextMenu: React.FC<EditModeContextMenuProps> = ({ children, topicId }) => {
  const { isEnabled } = useEditMode()
  const { items } = useEditModeContextMenuItems(topicId)

  if (!isEnabled) {
    return <>{children}</>
  }

  return (
    <Dropdown menu={{ items }} trigger={['contextMenu']}>
      {children}
    </Dropdown>
  )
}

export default memo(EditModeContextMenu)
