import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import ToolPopover from '../ToolPopover'

// Mock antd Popover to simulate antd trigger="click" + controlled open double-drive.
// Real antd Popover with trigger click will call onOpenChange(!open) on any click that
// bubbles from the Popover's React tree (portal events still bubble via React).
// We emulate by having an outer container with onClick/onMouseDown/onMouseUp toggling.
// If ToolPopover's content container correctly stopPropagation, inner clicks won't reach outer.
vi.mock('antd', async () => {
  const actual: any = await vi.importActual('antd')
  return {
    ...actual,
    Popover: ({ children, content, open, onOpenChange }: any) => (
      <div
        data-testid="mock-popover"
        data-open={String(open)}
        onClick={() => onOpenChange?.(!open)}
        onMouseDown={() => onOpenChange?.(!open)}
        onMouseUp={() => onOpenChange?.(!open)}>
        <div data-testid="mock-popover-content-wrap">{content}</div>
        <div data-testid="mock-popover-trigger">{children}</div>
      </div>
    )
  }
})

describe('ToolPopover', () => {
  it('renders children and content', () => {
    const onOpenChange = vi.fn()
    const { getByTestId, getByText } = render(
      <ToolPopover open={false} onOpenChange={onOpenChange} content={<div>hello content</div>}>
        <button>trigger</button>
      </ToolPopover>
    )
    expect(getByText('trigger')).toBeInTheDocument()
    expect(getByText('hello content')).toBeInTheDocument()
    expect(getByTestId('mock-popover').getAttribute('data-open')).toBe('false')
  })

  it('calls onOpenChange(false) on Escape when open', () => {
    const onOpenChange = vi.fn()
    render(
      <ToolPopover open={true} onOpenChange={onOpenChange} content={<div>content</div>}>
        <button>trigger</button>
      </ToolPopover>
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onOpenChange).toHaveBeenCalledTimes(1)
  })

  it('does not call onOpenChange on Escape when closed', () => {
    const onOpenChange = vi.fn()
    render(
      <ToolPopover open={false} onOpenChange={onOpenChange} content={<div>content</div>}>
        <button>trigger</button>
      </ToolPopover>
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('supports Esc alias', () => {
    const onOpenChange = vi.fn()
    render(
      <ToolPopover open={true} onOpenChange={onOpenChange} content={<div>content</div>}>
        <button>trigger</button>
      </ToolPopover>
    )
    fireEvent.keyDown(window, { key: 'Esc' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('cleans listener on unmount and when closed', () => {
    const onOpenChange = vi.fn()
    const { unmount, rerender } = render(
      <ToolPopover open={true} onOpenChange={onOpenChange} content={<div>content</div>}>
        <button>trigger</button>
      </ToolPopover>
    )
    rerender(
      <ToolPopover open={false} onOpenChange={onOpenChange} content={<div>content</div>}>
        <button>trigger</button>
      </ToolPopover>
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onOpenChange).not.toHaveBeenCalled()

    rerender(
      <ToolPopover open={true} onOpenChange={onOpenChange} content={<div>content</div>}>
        <button>trigger</button>
      </ToolPopover>
    )
    unmount()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('forwards outside click via onOpenChange', () => {
    const onOpenChange = vi.fn()
    const { getByTestId } = render(
      <ToolPopover open={true} onOpenChange={onOpenChange} content={<div>content</div>}>
        <button>trigger</button>
      </ToolPopover>
    )
    fireEvent.click(getByTestId('mock-popover'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  describe('content container stops propagation (prevents antd trigger + controlled double-drive)', () => {
    it('inner click inside content does not bubble to outer toggle', () => {
      const onOpenChange = vi.fn()
      const { getByTestId } = render(
        <ToolPopover
          open={true}
          onOpenChange={onOpenChange}
          content={
            <div>
              <button data-testid="inner-btn">inner</button>
            </div>
          }>
          <button>trigger</button>
        </ToolPopover>
      )
      // Clicking inner button should be stopped by PopoverContent's onClick stopPropagation
      fireEvent.click(getByTestId('inner-btn'))
      expect(onOpenChange).not.toHaveBeenCalled()
      // Also clicking the content container itself should not bubble
      fireEvent.click(getByTestId('tool-popover-content'))
      expect(onOpenChange).not.toHaveBeenCalled()
    })

    it('inner mousedown inside content does not bubble (mousedown is necessary for antd trigger)', () => {
      const onOpenChange = vi.fn()
      const { getByTestId } = render(
        <ToolPopover
          open={true}
          onOpenChange={onOpenChange}
          content={
            <div>
              <button data-testid="inner-btn2">inner2</button>
            </div>
          }>
          <button>trigger</button>
        </ToolPopover>
      )
      fireEvent.mouseDown(getByTestId('inner-btn2'))
      expect(onOpenChange).not.toHaveBeenCalled()
      fireEvent.mouseDown(getByTestId('tool-popover-content'))
      expect(onOpenChange).not.toHaveBeenCalled()
    })

    it('inner mouseup inside content does not bubble', () => {
      const onOpenChange = vi.fn()
      const { getByTestId } = render(
        <ToolPopover open={true} onOpenChange={onOpenChange} content={<div>content</div>}>
          <button>trigger</button>
        </ToolPopover>
      )
      fireEvent.mouseUp(getByTestId('tool-popover-content'))
      expect(onOpenChange).not.toHaveBeenCalled()
    })

    it('trigger click still bubbles to outer (control remains)', () => {
      const onOpenChange = vi.fn()
      const { getByText, getByTestId } = render(
        <ToolPopover open={true} onOpenChange={onOpenChange} content={<div>content</div>}>
          <button>triggerBtn</button>
        </ToolPopover>
      )
      // trigger button is outside content container, so its click should still reach outer toggle
      fireEvent.click(getByText('triggerBtn'))
      // outer handler toggles !open => false when open true
      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(getByTestId('mock-popover').getAttribute('data-open')).toBe('true')
    })
  })
})
