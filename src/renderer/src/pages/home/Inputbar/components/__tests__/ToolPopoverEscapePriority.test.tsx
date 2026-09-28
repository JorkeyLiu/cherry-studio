/**
 * ToolPopover + edit-mode Escape priority regression.
 *
 * Contract under test:
 * - IME composition owns Escape first: composing Escape never dismisses an
 *   open ToolPopover and never triggers edit-mode clear/exit.
 * - An open ToolPopover owns a non-composing Escape next: one Escape closes
 *   the popover only and must not simultaneously clear selection or exit edit
 *   mode (capture-before-bubble, independent of registration order).
 * - Once the popover is closed, the next fresh Escape resumes normal edit
 *   behavior (nonempty clears, empty exits).
 * - One Escape closes exactly one popover when two are open.
 *
 * Methodology: every keydown is dispatched from `document.body` or a focused
 * descendant (textarea/contenteditable), never directly on `window`, so the
 * capture-phase popover listener provably runs before the bubble-phase
 * edit-mode listener. Assertions stay behavioral (callbacks, open state,
 * defaultPrevented) rather than marker internals.
 */
import { createEvent, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { spies } = vi.hoisted(() => ({
  spies: {
    handleCopy: vi.fn(),
    handleCut: vi.fn(),
    handlePaste: vi.fn(),
    handleDelete: vi.fn(),
    handleUndo: vi.fn(),
    handleRedo: vi.fn(),
    handleMoveFocus: vi.fn(),
    handleExtendSelection: vi.fn(),
    handleClearSelection: vi.fn(),
    toggleEditMode: vi.fn(),
    isEnabled: { current: true },
    selectedGroupIds: { current: [] as string[] }
  }
}))

vi.mock('@renderer/context/EditModeContext', () => ({
  useEditMode: () => ({
    isEnabled: spies.isEnabled.current,
    selectedGroupIds: spies.selectedGroupIds.current,
    handleCopy: spies.handleCopy,
    handleCut: spies.handleCut,
    handlePaste: spies.handlePaste,
    handleDelete: spies.handleDelete,
    handleUndo: spies.handleUndo,
    handleRedo: spies.handleRedo,
    handleMoveFocus: spies.handleMoveFocus,
    handleExtendSelection: spies.handleExtendSelection,
    handleClearSelection: spies.handleClearSelection,
    toggleEditMode: spies.toggleEditMode
  })
}))

// Same lightweight antd Popover stand-in as ToolPopover.test.tsx: preserves
// the controlled `open` prop for closed-state assertions without portal behavior.
vi.mock('antd', async () => {
  const actual: any = await vi.importActual('antd')
  return {
    ...actual,
    Popover: ({ children, content, open }: any) => (
      <div data-testid="mock-popover" data-open={String(open)}>
        <div data-testid="mock-popover-content-wrap">{content}</div>
        <div data-testid="mock-popover-trigger">{children}</div>
      </div>
    )
  }
})

const { useClipboardKeyboard } = await import('@renderer/hooks/useClipboardKeyboard')
const { default: ToolPopover } = await import('../ToolPopover')

/** Edit-mode hook harness: rendered before ToolPopover to defeat registration-order assumptions. */
function EditHarness() {
  useClipboardKeyboard()
  return null
}

/** Stateful controlled popover: a close callback truly closes the popover via rerender. */
function StatefulPriority({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <EditHarness />
      <ToolPopover
        open={open}
        onOpenChange={(value) => {
          onOpenChange(value)
          setOpen(value)
        }}
        content={<div>content</div>}>
        <button>trigger</button>
      </ToolPopover>
      <textarea data-testid="composer" />
    </>
  )
}

/** Dispatch Escape from a real descendant target so window capture runs before window bubble. */
function dispatchEscape(target: Element, options: { isComposing?: boolean } = {}) {
  const event = createEvent.keyDown(target, { key: 'Escape' })
  if (options.isComposing !== undefined) {
    Object.defineProperty(event, 'isComposing', { value: options.isComposing, configurable: true })
  }
  fireEvent(target, event)
  return event
}

function blurActiveElement() {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
}

describe('ToolPopover Escape priority', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    spies.isEnabled.current = true
    spies.selectedGroupIds.current = []
    blurActiveElement()
  })

  it('composing Escape from a focused descendant leaves an open popover open', () => {
    const onOpenChange = vi.fn()
    const { getByTestId } = render(
      <>
        <ToolPopover open={true} onOpenChange={onOpenChange} content={<div>content</div>}>
          <button>trigger</button>
        </ToolPopover>
        <textarea data-testid="composer" />
      </>
    )
    const composer = getByTestId('composer') as HTMLTextAreaElement
    composer.focus()
    expect(document.activeElement).toBe(composer)

    const event = dispatchEscape(composer, { isComposing: true })

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
    expect(getByTestId('mock-popover').getAttribute('data-open')).toBe('true')
  })

  it.each([
    ['textarea', 'nonempty'],
    ['textarea', 'empty'],
    ['editor', 'nonempty'],
    ['editor', 'empty']
  ])('composing Escape in focused %s with %s selection triggers no edit command', (kind, selection) => {
    spies.selectedGroupIds.current = selection === 'nonempty' ? ['g1'] : []
    const { getByTestId } = render(
      <>
        <EditHarness />
        <textarea data-testid="textarea" />
        <div data-testid="editor" contentEditable />
      </>
    )
    const target = getByTestId(kind)
    target.focus()
    expect(document.activeElement).toBe(target)

    const event = dispatchEscape(target, { isComposing: true })

    expect(spies.handleClearSelection).not.toHaveBeenCalled()
    expect(spies.toggleEditMode).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('open popover wins over enabled edit mode, then the next Escape resumes clear (nonempty)', () => {
    spies.selectedGroupIds.current = ['g1']
    const onOpenChange = vi.fn()
    const { getByTestId } = render(<StatefulPriority onOpenChange={onOpenChange} />)
    const composer = getByTestId('composer') as HTMLTextAreaElement
    composer.focus()
    expect(document.activeElement).toBe(composer)

    const first = dispatchEscape(composer)

    expect(onOpenChange).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(spies.handleClearSelection).not.toHaveBeenCalled()
    expect(spies.toggleEditMode).not.toHaveBeenCalled()
    expect(first.defaultPrevented).toBe(false)
    expect(getByTestId('mock-popover').getAttribute('data-open')).toBe('false')

    spies.handleClearSelection.mockClear()
    spies.toggleEditMode.mockClear()
    onOpenChange.mockClear()

    const second = dispatchEscape(composer)

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(second.defaultPrevented).toBe(true)
    expect(spies.handleClearSelection).toHaveBeenCalledTimes(1)
    expect(spies.toggleEditMode).not.toHaveBeenCalled()
  })

  it('open popover wins over enabled edit mode, then the next Escape resumes exit (empty)', () => {
    spies.selectedGroupIds.current = []
    const onOpenChange = vi.fn()
    const { getByTestId } = render(<StatefulPriority onOpenChange={onOpenChange} />)
    const composer = getByTestId('composer') as HTMLTextAreaElement
    composer.focus()
    expect(document.activeElement).toBe(composer)

    const first = dispatchEscape(composer)

    expect(onOpenChange).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(spies.handleClearSelection).not.toHaveBeenCalled()
    expect(spies.toggleEditMode).not.toHaveBeenCalled()
    expect(first.defaultPrevented).toBe(false)
    expect(getByTestId('mock-popover').getAttribute('data-open')).toBe('false')

    spies.handleClearSelection.mockClear()
    spies.toggleEditMode.mockClear()
    onOpenChange.mockClear()

    const second = dispatchEscape(composer)

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(second.defaultPrevented).toBe(true)
    expect(spies.toggleEditMode).toHaveBeenCalledTimes(1)
    expect(spies.toggleEditMode).toHaveBeenCalledWith(false)
    expect(spies.handleClearSelection).not.toHaveBeenCalled()
  })

  it('one Escape closes exactly one of two open popovers', () => {
    const onOpenChangeA = vi.fn()
    const onOpenChangeB = vi.fn()
    render(
      <>
        <ToolPopover open={true} onOpenChange={onOpenChangeA} content={<div>a</div>}>
          <button>trigger-a</button>
        </ToolPopover>
        <ToolPopover open={true} onOpenChange={onOpenChangeB} content={<div>b</div>}>
          <button>trigger-b</button>
        </ToolPopover>
      </>
    )

    dispatchEscape(document.body)

    const total = onOpenChangeA.mock.calls.length + onOpenChangeB.mock.calls.length
    expect(total).toBe(1)
    for (const spy of [onOpenChangeA, onOpenChangeB]) {
      if (spy.mock.calls.length > 0) {
        expect(spy).toHaveBeenCalledWith(false)
      }
    }
  })
})
