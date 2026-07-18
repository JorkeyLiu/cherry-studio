import { useEffect, useRef, useState } from 'react'
import styled from 'styled-components'

interface SelectionBoxProps {
  isMultiSelectMode: boolean
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  messageElements: Map<string, HTMLElement>
  handleSelectMessage: (messageId: string, selected: boolean) => void
}

const SelectionBox: React.FC<SelectionBoxProps> = ({
  isMultiSelectMode,
  scrollContainerRef,
  messageElements,
  handleSelectMessage
}) => {
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [dragCurrent, setDragCurrent] = useState({ x: 0, y: 0 })
  const [isMouseDown, setIsMouseDown] = useState(false)

  const dragSelectedIds = useRef<Set<string>>(new Set())

  const DRAG_THRESHOLD = 5

  useEffect(() => {
    let handleMouseMoveTimer: NodeJS.Timeout
    if (!isMultiSelectMode) return

    const updateDragPos = (e: MouseEvent) => {
      const container = scrollContainerRef.current!
      if (!container) return { x: 0, y: 0 }
      const rect = container.getBoundingClientRect()
      return {
        x: e.clientX - rect.left + container.scrollLeft,
        y: e.clientY - rect.top + container.scrollTop
      }
    }

    const handleMouseDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.ant-checkbox-wrapper')) return
      if ((e.target as HTMLElement).closest('.MessageFooter')) return

      e.preventDefault()

      setIsMouseDown(true)
      const pos = updateDragPos(e)
      setDragStart(pos)
      setDragCurrent(pos)
      dragSelectedIds.current.clear()
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (!isMouseDown) return

      const pos = updateDragPos(e)

      const deltaX = Math.abs(pos.x - dragStart.x)
      const deltaY = Math.abs(pos.y - dragStart.y)
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY)

      if (!isDragging && distance > DRAG_THRESHOLD) {
        setIsDragging(true)
        document.body.classList.add('no-select')
      }

      if (!isDragging) return

      e.preventDefault()
      setDragCurrent(pos)

      const left = Math.min(dragStart.x, pos.x)
      const right = Math.max(dragStart.x, pos.x)
      const top = Math.min(dragStart.y, pos.y)
      const bottom = Math.max(dragStart.y, pos.y)

      const newSelectedIds = new Set<string>()

      messageElements.forEach((el, id) => {
        const checkbox = el.querySelector('input[type="checkbox"]') as HTMLInputElement | null
        const isAlreadySelected = checkbox?.checked || false

        if (!checkbox) return

        if (dragSelectedIds.current.has(id)) return

        const rect = el.getBoundingClientRect()
        const container = scrollContainerRef.current!
        const eTop = rect.top - container.getBoundingClientRect().top + container.scrollTop
        const eLeft = rect.left - container.getBoundingClientRect().left + container.scrollLeft
        const eBottom = eTop + rect.height
        const eRight = eLeft + rect.width

        const isInSelectionBox = !(eRight < left || eLeft > right || eBottom < top || eTop > bottom)

        if (isInSelectionBox && !isAlreadySelected) {
          handleSelectMessage(id, true)
          dragSelectedIds.current.add(id)
          newSelectedIds.add(id)
          el.classList.add('selection-highlight')
          handleMouseMoveTimer = setTimeout(() => el.classList.remove('selection-highlight'), 300)
        }
      })
    }

    const handleMouseUp = () => {
      setIsMouseDown(false)
      if (isDragging) {
        setIsDragging(false)
        document.body.classList.remove('no-select')
      }
    }

    const container = scrollContainerRef.current!
    container?.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      container?.removeEventListener('mousedown', handleMouseDown)
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('no-select')
      clearTimeout(handleMouseMoveTimer)
    }
  }, [isMultiSelectMode, isDragging, isMouseDown, dragStart, scrollContainerRef, messageElements, handleSelectMessage])

  if (!isDragging || !isMultiSelectMode) return null

  return (
    <SelectionBoxContainer
      style={{
        left: Math.min(dragStart.x, dragCurrent.x),
        top: Math.min(dragStart.y, dragCurrent.y),
        width: Math.abs(dragCurrent.x - dragStart.x),
        height: Math.abs(dragCurrent.y - dragStart.y)
      }}
    />
  )
}

const SelectionBoxContainer = styled.div`
  position: absolute;
  border: 1px dashed var(--color-primary);
  background-color: rgba(0, 114, 245, 0.1);
  pointer-events: none;
  z-index: 100;
`

export default SelectionBox
