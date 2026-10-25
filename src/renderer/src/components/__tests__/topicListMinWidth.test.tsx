/**
 * Home sidebar drag bound (renderer): dragging either sidebar handle
 * narrower must stop at the unified 220px minimum — no clipping below, no
 * rebound — and the persisted width must be the clamped value.
 */
import { fireEvent, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SIDEBAR_MIN_WIDTH } from '../../store/settings'
import ResizableHandle from '../ResizableHandle'

describe('ResizableHandle — home sidebars 220px minimum', () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty('--assistants-width')
    document.documentElement.style.removeProperty('--topic-list-width')
    document.documentElement.removeAttribute('data-resizing')
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    vi.restoreAllMocks()
  })

  it('stops the left pane at the bound during drag and persists the clamped width', () => {
    const onResizeEnd = vi.fn()
    const onResizing = vi.fn()
    document.documentElement.style.setProperty('--assistants-width', '260px')

    const { container } = render(
      <ResizableHandle
        cssVar="--assistants-width"
        minWidth={SIDEBAR_MIN_WIDTH}
        onResizeEnd={onResizeEnd}
        onResizing={onResizing}
        side="left"
      />
    )
    const handle = container.firstChild as HTMLElement

    // Left-panel handle: dragging left shrinks (newWidth = start + delta).
    fireEvent.mouseDown(handle, { clientX: 500 })
    // Small shrink stays above the bound and tracks the pointer.
    fireEvent.mouseMove(document, { clientX: 480 } as unknown as MouseEvent)
    expect(document.documentElement.style.getPropertyValue('--assistants-width')).toBe('240px')

    // Drag far past the bound (incl. old 150px saved width region):
    // rendered width stops at 220px, no clipping.
    fireEvent.mouseMove(document, { clientX: 100 } as unknown as MouseEvent)
    expect(document.documentElement.style.getPropertyValue('--assistants-width')).toBe('220px')
    expect(onResizing).toHaveBeenLastCalledWith(220)

    fireEvent.mouseUp(document)
    expect(onResizeEnd).toHaveBeenCalledWith(220)
    // Persisted value is the bound itself — nothing narrower is stored.
    expect(onResizeEnd.mock.calls[0][0]).toBeGreaterThanOrEqual(220)
  })

  it('stops the right pane at the bound during drag and persists the clamped width', () => {
    const onResizeEnd = vi.fn()
    const onResizing = vi.fn()
    document.documentElement.style.setProperty('--topic-list-width', '260px')

    const { container } = render(
      <ResizableHandle
        cssVar="--topic-list-width"
        minWidth={SIDEBAR_MIN_WIDTH}
        onResizeEnd={onResizeEnd}
        onResizing={onResizing}
        side="right"
      />
    )
    const handle = container.firstChild as HTMLElement

    // Right-panel handle: dragging right shrinks (newWidth = start - delta).
    fireEvent.mouseDown(handle, { clientX: 500 })
    // Small shrink stays above the bound and tracks the pointer.
    fireEvent.mouseMove(document, { clientX: 520 } as unknown as MouseEvent)
    expect(document.documentElement.style.getPropertyValue('--topic-list-width')).toBe('240px')

    // Drag far past the bound: rendered width stops at 220px, no clipping.
    fireEvent.mouseMove(document, { clientX: 900 } as unknown as MouseEvent)
    expect(document.documentElement.style.getPropertyValue('--topic-list-width')).toBe('220px')
    expect(onResizing).toHaveBeenLastCalledWith(220)

    fireEvent.mouseUp(document)
    expect(onResizeEnd).toHaveBeenCalledWith(220)
    // Persisted value is the bound itself — nothing narrower is stored.
    expect(onResizeEnd.mock.calls[0][0]).toBeGreaterThanOrEqual(220)
  })

  it('preserves larger widths on a small drag', () => {
    const onResizeEnd = vi.fn()
    document.documentElement.style.setProperty('--topic-list-width', '300px')

    const { container } = render(
      <ResizableHandle
        cssVar="--topic-list-width"
        minWidth={SIDEBAR_MIN_WIDTH}
        onResizeEnd={onResizeEnd}
        side="right"
      />
    )
    const handle = container.firstChild as HTMLElement

    fireEvent.mouseDown(handle, { clientX: 500 })
    fireEvent.mouseMove(document, { clientX: 480 } as unknown as MouseEvent)
    expect(document.documentElement.style.getPropertyValue('--topic-list-width')).toBe('320px')

    fireEvent.mouseUp(document)
    expect(onResizeEnd).toHaveBeenCalledWith(320)
  })
})
