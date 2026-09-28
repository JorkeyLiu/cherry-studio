/**
 * EditModeActionBar zero-selection contract:
 * - Enabling edit mode shows the floating toolbar even with zero groups
 *   selected (mode state is the single source of truth).
 * - Closing the toolbar exits edit mode via toggleEditMode(false), so the
 *   selection clears through the existing mode-exit semantics (and the
 *   navbar toggle stays synchronized).
 */
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const { editModeValue } = vi.hoisted(() => ({
  editModeValue: {
    current: null as any
  }
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() }) }
}))

vi.mock('@renderer/context/EditModeContext', () => ({
  useEditMode: () => editModeValue.current
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

const { default: EditModeActionBar } = await import('../EditModeActionBar')

function setEditMode(selectedGroupIds: string[]) {
  editModeValue.current = {
    isEnabled: true,
    selectedGroupIds,
    selectedGroups: selectedGroupIds.map((askId) => ({ askId, messages: [{ id: askId }] })),
    hasClipboard: false,
    canUndo: false,
    canRedo: false,
    isSelectionMutable: false,
    handleCopy: vi.fn(),
    handleCut: vi.fn(),
    handlePaste: vi.fn(),
    handleDelete: vi.fn(),
    handleUndo: vi.fn(),
    handleRedo: vi.fn(),
    handleClearSelection: vi.fn(),
    toggleEditMode: vi.fn()
  }
}

describe('EditModeActionBar zero-selection visibility + close exits mode', () => {
  it('renders the toolbar with zero groups selected', () => {
    setEditMode([])
    const { container } = render(<EditModeActionBar />)
    // Previously returned null here; the bar must stay mounted on mode state.
    expect(container.firstChild).not.toBeNull()
    expect(container.querySelector('[data-testid="edit-close-btn"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="edit-copy-btn"]')).not.toBeNull()
  })

  it('toolbar close exits edit mode (mode-exit semantics clear the selection)', () => {
    setEditMode([])
    const { container } = render(<EditModeActionBar />)
    fireEvent.click(container.querySelector('[data-testid="edit-close-btn"]') as Element)
    expect(editModeValue.current.toggleEditMode).toHaveBeenCalledTimes(1)
    expect(editModeValue.current.toggleEditMode).toHaveBeenCalledWith(false)
    // Clearing flows through toggleEditMode(false), not a bare clear call.
    expect(editModeValue.current.handleClearSelection).not.toHaveBeenCalled()
  })

  it('toolbar close exits edit mode with a non-empty selection too', () => {
    setEditMode(['u1'])
    const { container } = render(<EditModeActionBar />)
    fireEvent.click(container.querySelector('[data-testid="edit-close-btn"]') as Element)
    expect(editModeValue.current.toggleEditMode).toHaveBeenCalledWith(false)
    expect(editModeValue.current.handleClearSelection).not.toHaveBeenCalled()
  })
})
