/**
 * EditModeActionBar keeps the ordinary copy/cut actions only.
 *
 * "Including child branches" is offered by the message context menu's copy/cut
 * submenus (only while relevant), so the toolbar must not carry a hover dropdown
 * or any extra entry:
 * - the icons keep their testids and one click performs the ordinary action,
 * - the tree labels never render from the toolbar,
 * - the cut button keeps its selection-mutability gate (keyboard C/X untouched).
 */
import { fireEvent, render, screen } from '@testing-library/react'
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

type Handlers = {
  handleCopy: ReturnType<typeof vi.fn>
  handleCut: ReturnType<typeof vi.fn>
  handleCopyWithChildren: ReturnType<typeof vi.fn>
  handleCutWithChildren: ReturnType<typeof vi.fn>
}

function setEditMode(isSelectionMutable: boolean): Handlers {
  const handlers: Handlers = {
    handleCopy: vi.fn(),
    handleCut: vi.fn(),
    handleCopyWithChildren: vi.fn(),
    handleCutWithChildren: vi.fn()
  }
  editModeValue.current = {
    selectedGroupIds: ['u1'],
    selectedGroups: [{ askId: 'u1', messages: [{ id: 'u1' }] }],
    hasClipboard: true,
    canUndo: true,
    canRedo: true,
    isSelectionMutable,
    ...handlers,
    handlePaste: vi.fn(),
    handleDelete: vi.fn(),
    handleUndo: vi.fn(),
    handleRedo: vi.fn(),
    handleClearSelection: vi.fn()
  }
  return handlers
}

function button(container: HTMLElement, id: string): HTMLButtonElement {
  const element = container.querySelector(`[data-testid="${id}"]`)
  if (!element) throw new Error(`missing button ${id}`)
  return element as HTMLButtonElement
}

describe('EditModeActionBar copy/cut actions', () => {
  it('performs the ordinary copy action on click and never exposes a tree entry', () => {
    const handlers = setEditMode(true)
    const { container } = render(<EditModeActionBar />)
    const copyButton = button(container, 'edit-copy-btn')
    expect(copyButton).toBeEnabled()

    fireEvent.click(copyButton)
    expect(handlers.handleCopy).toHaveBeenCalledTimes(1)
    expect(handlers.handleCopyWithChildren).not.toHaveBeenCalled()

    // One click, one action: no hover/click dropdown surface at all.
    fireEvent.mouseEnter(copyButton)
    expect(screen.queryByText('chat.edit.copyTreeAction')).toBeNull()
    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(handlers.handleCopyWithChildren).not.toHaveBeenCalled()
  })

  it('performs the ordinary cut action on click when the selection is writable', () => {
    const handlers = setEditMode(true)
    const { container } = render(<EditModeActionBar />)
    const cutButton = button(container, 'edit-cut-btn')
    expect(cutButton).toBeEnabled()

    fireEvent.click(cutButton)
    expect(handlers.handleCut).toHaveBeenCalledTimes(1)
    expect(handlers.handleCutWithChildren).not.toHaveBeenCalled()

    fireEvent.mouseEnter(cutButton)
    expect(screen.queryByText('chat.edit.cutTreeAction')).toBeNull()
    expect(screen.queryByRole('menuitem')).toBeNull()
  })

  it('keeps the cut permission gate and still exposes no tree entry for a non-writable selection', () => {
    const handlers = setEditMode(false)
    const { container } = render(<EditModeActionBar />)
    const cutButton = button(container, 'edit-cut-btn')
    expect(cutButton).toBeDisabled()

    fireEvent.click(cutButton)
    expect(handlers.handleCut).not.toHaveBeenCalled()

    fireEvent.mouseEnter(cutButton)
    expect(screen.queryByText('chat.edit.cutTreeAction')).toBeNull()
    expect(screen.queryByText('chat.edit.copyTreeAction')).toBeNull()
    expect(handlers.handleCutWithChildren).not.toHaveBeenCalled()
  })
})
