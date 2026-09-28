/**
 * useClipboardKeyboard entry mapping (BRANCH-12 keyboard contract).
 *
 * The edit-mode keyboard layer routes strictly:
 * - Meta/Ctrl+C → copy, Meta/Ctrl+X → cut, Meta/Ctrl+V → paste,
 *   Meta/Ctrl+Backspace → delete;
 * - unmodified Backspace/Delete never reach a mutation entry (zero calls);
 * - while a text input is focused every shortcut yields to the browser
 *   (zero calls).
 *
 * Permission substance behind these entries (immutable/mixed/unknown
 * selections fail closed with zero `cutMessages` / `deleteSelectedMessages` /
 * IPC calls while copy still calls) is covered at the handler/service level
 * in `ClipboardService.cutGate.test.ts` with the real gate logic; this file
 * pins the keyboard-to-handler mapping those gates sit behind.
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
    isEnabled: { current: true }
  }
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() }) }
}))

vi.mock('@renderer/context/EditModeContext', () => ({
  useEditMode: () => ({
    isEnabled: spies.isEnabled.current,
    handleCopy: spies.handleCopy,
    handleCut: spies.handleCut,
    handlePaste: spies.handlePaste,
    handleDelete: spies.handleDelete,
    handleUndo: spies.handleUndo,
    handleRedo: spies.handleRedo,
    handleMoveFocus: spies.handleMoveFocus,
    handleExtendSelection: spies.handleExtendSelection,
    handleClearSelection: spies.handleClearSelection
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

describe('useClipboardKeyboard entry mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    spies.isEnabled.current = true
    // jsdom focus residue must not leak between cases.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })

  it('routes Meta/Ctrl+C to copy', () => {
    render(<Harness />)
    keyOnBody('c', { metaKey: true })
    keyOnBody('c', { ctrlKey: true })
    expect(spies.handleCopy).toHaveBeenCalledTimes(2)
    expect(spies.handleCut).not.toHaveBeenCalled()
    expect(spies.handleDelete).not.toHaveBeenCalled()
  })

  it('routes Meta/Ctrl+X to cut', () => {
    render(<Harness />)
    keyOnBody('x', { metaKey: true })
    keyOnBody('x', { ctrlKey: true })
    expect(spies.handleCut).toHaveBeenCalledTimes(2)
    expect(spies.handleCopy).not.toHaveBeenCalled()
    expect(spies.handleDelete).not.toHaveBeenCalled()
  })

  it('routes Meta/Ctrl+Backspace to delete', () => {
    render(<Harness />)
    keyOnBody('Backspace', { metaKey: true })
    keyOnBody('Backspace', { ctrlKey: true })
    expect(spies.handleDelete).toHaveBeenCalledTimes(2)
    expect(spies.handleCut).not.toHaveBeenCalled()
    expect(spies.handleCopy).not.toHaveBeenCalled()
  })

  it('unmodified Backspace/Delete never reach a mutation entry', () => {
    render(<Harness />)
    keyOnBody('Backspace')
    keyOnBody('Delete')
    expect(spies.handleDelete).not.toHaveBeenCalled()
    expect(spies.handleCut).not.toHaveBeenCalled()
    expect(spies.handleCopy).not.toHaveBeenCalled()
    expect(spies.handlePaste).not.toHaveBeenCalled()
  })

  it('yields every shortcut to the browser while a text input is focused', () => {
    const { container } = render(
      <>
        <Harness />
        <input data-testid="text-input" />
      </>
    )
    const input = container.querySelector('[data-testid="text-input"]') as HTMLInputElement
    input.focus()
    expect(document.activeElement).toBe(input)

    keyOnBody('x', { metaKey: true })
    keyOnBody('c', { metaKey: true })
    keyOnBody('Backspace', { metaKey: true })
    expect(spies.handleCut).not.toHaveBeenCalled()
    expect(spies.handleCopy).not.toHaveBeenCalled()
    expect(spies.handleDelete).not.toHaveBeenCalled()
  })

  it('registers no entries while edit mode is disabled', () => {
    spies.isEnabled.current = false
    render(<Harness />)
    keyOnBody('x', { metaKey: true })
    keyOnBody('c', { metaKey: true })
    keyOnBody('Backspace', { metaKey: true })
    expect(spies.handleCut).not.toHaveBeenCalled()
    expect(spies.handleCopy).not.toHaveBeenCalled()
    expect(spies.handleDelete).not.toHaveBeenCalled()
  })
})
