import { useCallback, useEffect, useRef, useState } from 'react'
import { styled } from 'styled-components'

interface ResizableHandleProps {
  /** The CSS variable name to update during resize, e.g. '--assistants-width' */
  cssVar: string
  /** Called with the final width when drag ends (for persistence) */
  onResizeEnd: (width: number) => void
  /** Optional: called continuously during drag with current width */
  onResizing?: (width: number) => void
  /** Minimum width in px (default: 180) */
  minWidth?: number
  /** Maximum width in px (default: 600) */
  maxWidth?: number
  /** Side of the panel: 'left' means handle is on the right edge of a left panel; 'right' means handle is on the left edge of a right panel */
  side: 'left' | 'right'
}

const HANDLE_WIDTH = 6
const HANDLE_HOVER_WIDTH = 8

const ResizableHandle = ({
  cssVar,
  onResizeEnd,
  onResizing,
  minWidth = 180,
  maxWidth = 600,
  side
}: ResizableHandleProps) => {
  const isDragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)
  const [isActive, setIsActive] = useState(false)

  const getCurrentWidth = useCallback(() => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim()
    return parseInt(raw) || 275
  }, [cssVar])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      isDragging.current = true
      startX.current = e.clientX
      startWidth.current = getCurrentWidth()
      setIsActive(true)

      document.documentElement.setAttribute('data-resizing', 'true')
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const handleMouseMove = (ev: MouseEvent) => {
        if (!isDragging.current) return
        const delta = ev.clientX - startX.current
        // For 'left' side handle: panel is to the left, so drag right = +delta
        // For 'right' side handle: panel is to the right, so drag left = +delta
        const newWidth = side === 'left' ? startWidth.current + delta : startWidth.current - delta
        const clamped = Math.max(minWidth, Math.min(maxWidth, newWidth))
        document.documentElement.style.setProperty(cssVar, `${clamped}px`)
        onResizing?.(clamped)
      }

      const handleMouseUp = () => {
        isDragging.current = false
        setIsActive(false)
        document.documentElement.removeAttribute('data-resizing')
        document.body.style.cursor = ''
        document.body.style.userSelect = ''

        const finalWidth = getCurrentWidth()
        onResizeEnd(finalWidth)

        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [cssVar, getCurrentWidth, minWidth, maxWidth, side, onResizeEnd, onResizing]
  )

  useEffect(() => {
    return () => {
      document.documentElement.removeAttribute('data-resizing')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setIsActive(false)
    }
  }, [])

  return <Handle $isActive={isActive} $side={side} onMouseDown={handleMouseDown} />
}

const Handle = styled.div<{ $isActive: boolean; $side: 'left' | 'right' }>`
  width: ${HANDLE_WIDTH}px;
  min-width: ${HANDLE_WIDTH}px;
  height: 100%;
  cursor: col-resize;
  position: relative;
  z-index: 10;
  flex-shrink: 0;
  align-self: stretch;
  transition: width 0.15s ease, background-color 0.15s ease;

  &::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    ${({ $side }) => ($side === 'left' ? 'right: -2px;' : 'left: -2px;')}
    width: 2px;
    background: transparent;
    transition: background-color 0.15s ease;
  }

  &:hover {
    width: ${HANDLE_HOVER_WIDTH}px;
    min-width: ${HANDLE_HOVER_WIDTH}px;

    &::after {
      background: var(--color-border, #e0e0e0);
    }
  }

  ${({ $isActive }) =>
    $isActive &&
    `
    width: ${HANDLE_HOVER_WIDTH}px;
    min-width: ${HANDLE_HOVER_WIDTH}px;
    background: transparent;

    &::after {
      background: var(--color-primary, #00b96b);
      width: 2px;
    }
  `}
`

export default ResizableHandle
