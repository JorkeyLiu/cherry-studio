/**
 * PROJ-13 (B2) EditModeActionBar permission gating.
 *
 * - Immutable/mixed selections: Cut/Delete disabled, Copy stays enabled.
 * - Fully private selections: all actions enabled.
 */
import { render } from '@testing-library/react'
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

function setEditMode(isSelectionMutable: boolean) {
  editModeValue.current = {
    selectedGroupIds: ['u1'],
    selectedGroups: [{ askId: 'u1', messages: [{ id: 'u1' }] }],
    hasClipboard: true,
    canUndo: true,
    canRedo: true,
    isSelectionMutable,
    handleCopy: vi.fn(),
    handleCut: vi.fn(),
    handlePaste: vi.fn(),
    handleDelete: vi.fn(),
    handleUndo: vi.fn(),
    handleRedo: vi.fn(),
    handleClearSelection: vi.fn()
  }
}

describe('EditModeActionBar permission gating', () => {
  it('disables Cut/Delete but keeps Copy enabled on immutable selections', () => {
    setEditMode(false)
    const { container } = render(<EditModeActionBar />)
    const button = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null
    expect(button('edit-copy-btn')).toBeEnabled()
    expect(button('edit-cut-btn')).toBeDisabled()
    expect(button('edit-delete-btn')).toBeDisabled()
    // Paste stays clipboard-gated; undo/redo stay stack-gated.
    expect(button('edit-paste-btn')).toBeEnabled()
  })

  it('enables all actions on fully private selections', () => {
    setEditMode(true)
    const { container } = render(<EditModeActionBar />)
    const button = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null
    for (const id of ['edit-copy-btn', 'edit-cut-btn', 'edit-paste-btn', 'edit-delete-btn']) {
      expect(button(id)).toBeEnabled()
    }
  })
})
