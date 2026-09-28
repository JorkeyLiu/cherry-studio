/**
 * Escape coherence with "toolbar close exits mode":
 * - Escape with a non-empty selection clears the selection (edit mode stays).
 * - Escape with an already-empty selection exits edit mode via
 *   toggleEditMode(false) — the same mode-exit path as toolbar close.
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

describe('useClipboardKeyboard Escape coherence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    spies.isEnabled.current = true
    spies.selectedGroupIds.current = []
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })

  it('Escape with a selection clears it without exiting edit mode', () => {
    spies.selectedGroupIds.current = ['g1']
    render(<Harness />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(spies.handleClearSelection).toHaveBeenCalledTimes(1)
    expect(spies.toggleEditMode).not.toHaveBeenCalled()
  })

  it('Escape with an empty selection exits edit mode (toolbar-close parity)', () => {
    spies.selectedGroupIds.current = []
    render(<Harness />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(spies.toggleEditMode).toHaveBeenCalledTimes(1)
    expect(spies.toggleEditMode).toHaveBeenCalledWith(false)
    expect(spies.handleClearSelection).not.toHaveBeenCalled()
  })
})
