import { Popover } from 'antd'
import { type FC, type ReactNode, useEffect } from 'react'
import styled from 'styled-components'

interface ToolPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  content: ReactNode
  children: ReactNode
  width?: number
}

/**
 * Lightweight unified Inputbar tool Popover shell.
 * Visual/position reuses InputbarSettings antd Popover: top placement, no arrow.
 * Not a generic menu framework - each tool renders its own content.
 */
const ToolPopover: FC<ToolPopoverProps> = ({ open, onOpenChange, content, children, width = 297 }) => {
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Esc') {
        onOpenChange(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onOpenChange])

  const stopPropagation = (e: React.SyntheticEvent) => {
    e.stopPropagation()
  }

  return (
    <Popover
      placement="top"
      trigger="click"
      arrow={false}
      open={open}
      onOpenChange={onOpenChange}
      content={
        <PopoverContent
          onClick={stopPropagation}
          onMouseDown={stopPropagation}
          onMouseUp={stopPropagation}
          data-testid="tool-popover-content">
          {content}
        </PopoverContent>
      }
      styles={{ root: { width } }}>
      <Trigger>{children}</Trigger>
    </Popover>
  )
}

const Trigger = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  vertical-align: middle;
  line-height: 0;
  flex-shrink: 0;
`

const PopoverContent = styled.div`
  width: 100%;
  box-sizing: border-box;
  padding: 4px 12px 12px;
  user-select: none;

  .ant-divider {
    margin: 8px 0;
  }
`

export default ToolPopover
