import { TOOL_POPOVER_ESCAPE_CONSUMED } from '@renderer/utils/toolPopoverEscape'
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
      // IME composition owns Escape first: never dismiss the popover while
      // the user is composing text.
      if (e.isComposing) return
      if (e.key === 'Escape' || e.key === 'Esc') {
        // A cooperating Escape already consumed by another open popover on
        // this same event owns it: one Escape closes one popover only.
        if ((e as KeyboardEvent & { [TOOL_POPOVER_ESCAPE_CONSUMED]?: boolean })[TOOL_POPOVER_ESCAPE_CONSUMED]) return
        onOpenChange(false)
        // Capture-phase consumed marker for the edit-mode Escape layer
        // (useClipboardKeyboard): one Escape closes the popover only and must
        // not simultaneously clear selection or exit edit mode. Only the
        // cooperating edit-mode layer reads this marker; no stopPropagation
        // so unrelated Escape handlers are unaffected.
        ;(e as KeyboardEvent & { [TOOL_POPOVER_ESCAPE_CONSUMED]?: boolean })[TOOL_POPOVER_ESCAPE_CONSUMED] = true
      }
    }
    // Capture phase: runs before the edit-mode bubble-phase listener
    // regardless of mount/registration order, so the marker above is always
    // visible to it on the same keydown event.
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
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
