/**
 * useClipboardKeyboard undo/redo key casing.
 *
 * Regression: Meta+Shift+Z produces e.key 'Z' (uppercase) on real browsers,
 * which the previous `e.key === 'z'` check missed, so redo never fired.
 * Both undo and redo match case-insensitively; guards are unchanged.
 */
import { fireEvent, render } from '@testing-library/react'
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

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() }) }
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

const { useClipboardKeyboard } = await import('../useClipboardKeyboard')

function Harness() {
  useClipboardKeyboard()
  return null
}

function keyOnBody(key: string, opts: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {}) {
  fireEvent.keyDown(document.body, { key, ...opts })
}

describe('useClipboardKeyboard undo/redo casing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    spies.isEnabled.current = true
    spies.selectedGroupIds.current = []
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })

  it("routes Meta+Shift+'Z' (uppercase) to redo once", () => {
    render(<Harness />)
    keyOnBody('Z', { metaKey: true, shiftKey: true })
    expect(spies.handleRedo).toHaveBeenCalledTimes(1)
    expect(spies.handleUndo).not.toHaveBeenCalled()
  })

  it("routes Ctrl+Shift+'Z' (uppercase) to redo once", () => {
    render(<Harness />)
    keyOnBody('Z', { ctrlKey: true, shiftKey: true })
    expect(spies.handleRedo).toHaveBeenCalledTimes(1)
    expect(spies.handleUndo).not.toHaveBeenCalled()
  })

  it("keeps lowercase 'z' + shift routing to redo", () => {
    render(<Harness />)
    keyOnBody('z', { metaKey: true, shiftKey: true })
    expect(spies.handleRedo).toHaveBeenCalledTimes(1)
    expect(spies.handleUndo).not.toHaveBeenCalled()
  })

  it('preserves Meta+Z undo without shift (lowercase and uppercase)', () => {
    render(<Harness />)
    keyOnBody('z', { metaKey: true })
    expect(spies.handleUndo).toHaveBeenCalledTimes(1)
    expect(spies.handleRedo).not.toHaveBeenCalled()

    vi.clearAllMocks()
    keyOnBody('Z', { metaKey: true })
    expect(spies.handleUndo).toHaveBeenCalledTimes(1)
    expect(spies.handleRedo).not.toHaveBeenCalled()
  })

  it('yields redo to the browser while a text input is focused', () => {
    const { container } = render(
      <>
        <Harness />
        <input data-testid="text-input" />
      </>
    )
    const input = container.querySelector('[data-testid="text-input"]') as HTMLInputElement
    input.focus()
    expect(document.activeElement).toBe(input)

    keyOnBody('Z', { metaKey: true, shiftKey: true })
    expect(spies.handleRedo).not.toHaveBeenCalled()
    expect(spies.handleUndo).not.toHaveBeenCalled()
  })

  it('registers no undo/redo while edit mode is disabled', () => {
    spies.isEnabled.current = false
    render(<Harness />)
    keyOnBody('Z', { metaKey: true, shiftKey: true })
    keyOnBody('z', { metaKey: true })
    expect(spies.handleRedo).not.toHaveBeenCalled()
    expect(spies.handleUndo).not.toHaveBeenCalled()
  })
})
