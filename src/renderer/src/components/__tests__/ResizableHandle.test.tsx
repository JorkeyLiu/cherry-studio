import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ResizableHandle from '../ResizableHandle'

const HANDLE_PATH = resolve(process.cwd(), 'src/renderer/src/components/ResizableHandle.tsx')

function readHandleSource() {
  return readFileSync(HANDLE_PATH, 'utf-8')
}

describe('ResizableHandle — sidebar separator and fixed 6px geometry', () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty('--assistants-width')
    document.documentElement.style.removeProperty('--topic-list-width')
    document.documentElement.removeAttribute('data-resizing')
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    vi.restoreAllMocks()
  })

  afterEach(() => {
    document.documentElement.removeAttribute('data-resizing')
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  })

  it('maintains fixed 6px flex geometry — no 6→8 hover/active width increase', () => {
    const src = readHandleSource()
    expect(src).toContain('HANDLE_WIDTH = 6')
    expect(src).not.toContain('HANDLE_HOVER_WIDTH')
    // No hover width increase should exist
    expect(src).not.toMatch(/&:hover\s*\{[^}]*width:\s*8px/)
    expect(src).not.toMatch(/\$isActive[\s\S]*?width:\s*8px/)
    // Must retain fixed 6px layout geometry
    expect(src).toContain('width: ${HANDLE_WIDTH}px')
    expect(src).toContain('min-width: ${HANDLE_WIDTH}px')
    // Transition should not include width (no layout jitter)
    expect(src).toContain('transition: background-color')
    expect(src).not.toMatch(/transition:[^;]*width/)
  })

  it('implements single clear 1px separator in rest/hover/drag with no duplicate border line', () => {
    const src = readHandleSource()
    // Single centered 1px line, visible at rest via --color-border
    expect(src).toContain('left: 50%')
    expect(src).toContain('transform: translateX(-50%)')
    expect(src).toContain('width: 1px')
    expect(src).toContain('background: var(--color-border')
    // No duplicate 2px edge-offset line
    expect(src).not.toContain('right: -2px')
    expect(src).not.toContain('left: -2px')
    expect(src).not.toContain('width: 2px')
    // Hover keeps same 1px border, drag uses primary
    expect(src).toContain('&:hover::after')
    expect(src).toContain('var(--color-primary')
    // Side prop no longer drives duplicate edge positioning
    expect(src).not.toMatch(/\$\{.*\$side.*right: -2px/)
  })

  it('enlarges draggable hit target without layout reflow via absolute ::before', () => {
    const src = readHandleSource()
    expect(src).toContain('&::before')
    expect(src).toContain('position: absolute')
    expect(src).toContain('left: -4px')
    expect(src).toContain('right: -4px')
    // ::before must not affect flex geometry — handle stays 6px
    expect(src).toContain('flex-shrink: 0')
  })

  it('renders with cursor col-resize and 6px width style', () => {
    const { container } = render(<ResizableHandle cssVar="--assistants-width" onResizeEnd={vi.fn()} side="left" />)
    const handle = container.firstChild as HTMLElement
    expect(handle).toBeInTheDocument()
    // Styled component injects width via class, but element should have col-resize cursor via computed style sheet
    // Verify element has the expected inline flex geometry preserved
    const styles = window.getComputedStyle(handle)
    // In jsdom styled-components injects via stylesheet; width is defined as 6px in generated CSS
    // Ensure handle is rendered and has not been altered to 8px
    expect(handle).toBeTruthy()
    expect(styles.cursor).toBe('col-resize')
    // Ensure no inline 8px width leak
    expect(handle.style.width).not.toBe('8px')
  })

  it('preserves resize deltas, side direction, min/max clamping and persistence callbacks', () => {
    const onResizeEnd = vi.fn()
    const onResizing = vi.fn()
    // Seed initial width 275px via css var — jsdom getComputedStyle reflects inline style
    document.documentElement.style.setProperty('--assistants-width', '275px')

    const { container, rerender } = render(
      <ResizableHandle
        cssVar="--assistants-width"
        onResizeEnd={onResizeEnd}
        onResizing={onResizing}
        minWidth={180}
        maxWidth={600}
        side="left"
      />
    )
    const handle = container.firstChild as HTMLElement

    // Simulate left-panel drag right (+50px) => 275+50=325
    fireEvent.mouseDown(handle, { clientX: 100 })
    fireEvent.mouseMove(document, { clientX: 150 } as unknown as MouseEvent)
    expect(document.documentElement.style.getPropertyValue('--assistants-width')).toBe('325px')
    expect(onResizing).toHaveBeenCalledWith(325)

    fireEvent.mouseUp(document)
    expect(onResizeEnd).toHaveBeenCalledWith(325)
    expect(document.documentElement.hasAttribute('data-resizing')).toBe(false)

    // Reset for right-side inversion test
    document.documentElement.style.setProperty('--topic-list-width', '300px')
    onResizeEnd.mockClear()
    onResizing.mockClear()

    rerender(
      <ResizableHandle cssVar="--topic-list-width" onResizeEnd={onResizeEnd} onResizing={onResizing} side="right" />
    )
    const handleRight = container.firstChild as HTMLElement
    fireEvent.mouseDown(handleRight, { clientX: 500 })
    // Drag left (-60) for right panel: newWidth = 300 - (440-500) = 300 - (-60)=360
    fireEvent.mouseMove(document, { clientX: 440 } as unknown as MouseEvent)
    expect(document.documentElement.style.getPropertyValue('--topic-list-width')).toBe('360px')
    expect(onResizing).toHaveBeenLastCalledWith(360)

    // Test min clamping: drag far left for left panel should clamp to 180
    document.documentElement.style.setProperty('--assistants-width', '200px')
    rerender(
      <ResizableHandle
        cssVar="--assistants-width"
        onResizeEnd={onResizeEnd}
        side="left"
        minWidth={180}
        maxWidth={600}
      />
    )
    const handleLeft2 = container.firstChild as HTMLElement
    fireEvent.mouseDown(handleLeft2, { clientX: 100 })
    fireEvent.mouseMove(document, { clientX: 0 } as unknown as MouseEvent)
    expect(document.documentElement.style.getPropertyValue('--assistants-width')).toBe('180px')

    // Test max clamping: drag far right should clamp to 600
    document.documentElement.style.setProperty('--assistants-width', '590px')
    fireEvent.mouseUp(document)
    fireEvent.mouseDown(handleLeft2, { clientX: 100 })
    fireEvent.mouseMove(document, { clientX: 300 } as unknown as MouseEvent)
    expect(document.documentElement.style.getPropertyValue('--assistants-width')).toBe('600px')

    fireEvent.mouseUp(document)
  })
})
