import { Dropdown } from 'antd'

import { useSelectionContextMenu } from './useSelectionContextMenu'

interface ContextMenuProps {
  children: React.ReactNode
}

// FIXME: Why does this component name look like a generic component but is not customizable at all?
const ContextMenu: React.FC<ContextMenuProps> = ({ children }) => {
  const { items, onOpenChange } = useSelectionContextMenu()

  return (
    <Dropdown onOpenChange={onOpenChange} menu={{ items }} trigger={['contextMenu']}>
      {children}
    </Dropdown>
  )
}

export default ContextMenu
