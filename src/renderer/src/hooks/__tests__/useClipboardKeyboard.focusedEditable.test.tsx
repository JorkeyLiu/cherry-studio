/**
 * useClipboardKeyboard focus matrix: edit-mode commands vs. focused editors.
 *
 * When edit mode is enabled and an editable element (INPUT, TEXTAREA,
 * contenteditable, ProseMirror/Tiptap) is focused:
 * - Escape REMAINS an edit-mode command: nonempty selection clears first
 *   (mode stays); empty selection exits mode. Both preventDefault.
 * - Every other text-editing key is owned by the focused editor: zero
 *   edit-mode mutation/navigation calls and no preventDefault by this hook:
 *   Cmd/Ctrl+C/X/V/Z/Shift+Z, Cmd/Ctrl+Backspace, ArrowUp/Down,
 *   Shift+ArrowUp/Down, ordinary typing, Enter, Tab, Backspace/Delete,
 *   select-all (Cmd/Ctrl+A).
 */
import { createEvent, fireEvent, render } from '@testing-library/react'
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

function allSpies() {
  return [
    spies.handleCopy,
    spies.handleCut,
    spies.handlePaste,
    spies.handleDelete,
    spies.handleUndo,
    spies.handleRedo,
    spies.handleMoveFocus,
    spies.handleExtendSelection,
    spies.handleClearSelection,
    spies.toggleEditMode
  ]
}

function expectZeroEditCalls() {
  for (const spy of allSpies()) {
    expect(spy).not.toHaveBeenCalled()
  }
}

/** Dispatch on the focused target and return the event for defaultPrevented checks. */
function keyOn(target: Element, key: string, opts: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {}) {
  const event = createEvent.keyDown(target, { key, ...opts })
  fireEvent(target, event)
  return event
}

describe('useClipboardKeyboard focused-editable matrix', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    spies.isEnabled.current = true
    spies.selectedGroupIds.current = []
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })

  it.each([['textarea'], ['prosemirror']])(
    'Escape with a selection clears it (mode stays) while %s is focused',
    (kind) => {
      spies.selectedGroupIds.current = ['g1']
      const { getByTestId } = render(
        <>
          <Harness />
          <textarea data-testid="textarea" />
          <div data-testid="prosemirror" contentEditable className="ProseMirror tiptap" />
        </>
      )
      const target = getByTestId(kind)
      target.focus()
      expect(document.activeElement).toBe(target)

      const event = keyOn(target, 'Escape')
      expect(event.defaultPrevented).toBe(true)
      expect(spies.handleClearSelection).toHaveBeenCalledTimes(1)
      expect(spies.toggleEditMode).not.toHaveBeenCalled()
    }
  )

  it.each([['textarea'], ['prosemirror']])('Escape with an empty selection exits mode while %s is focused', (kind) => {
    spies.selectedGroupIds.current = []
    const { getByTestId } = render(
      <>
        <Harness />
        <textarea data-testid="textarea" />
        <div data-testid="prosemirror" contentEditable className="ProseMirror tiptap" />
      </>
    )
    const target = getByTestId(kind)
    target.focus()
    expect(document.activeElement).toBe(target)

    const event = keyOn(target, 'Escape')
    expect(event.defaultPrevented).toBe(true)
    expect(spies.toggleEditMode).toHaveBeenCalledTimes(1)
    expect(spies.toggleEditMode).toHaveBeenCalledWith(false)
    expect(spies.handleClearSelection).not.toHaveBeenCalled()
  })

  it.each([['textarea'], ['prosemirror']])(
    'edit-command keys owned by the focused %s produce zero calls and no preventDefault',
    (kind) => {
      spies.selectedGroupIds.current = ['g1']
      const { getByTestId } = render(
        <>
          <Harness />
          <textarea data-testid="textarea" />
          <div data-testid="prosemirror" contentEditable className="ProseMirror tiptap" />
        </>
      )
      const target = getByTestId(kind)
      target.focus()
      expect(document.activeElement).toBe(target)

      const events = [
        keyOn(target, 'c', { metaKey: true }),
        keyOn(target, 'x', { metaKey: true }),
        keyOn(target, 'v', { metaKey: true }),
        keyOn(target, 'z', { metaKey: true }),
        keyOn(target, 'z', { metaKey: true, shiftKey: true }),
        keyOn(target, 'c', { ctrlKey: true }),
        keyOn(target, 'z', { ctrlKey: true }),
        keyOn(target, 'Backspace', { metaKey: true }),
        keyOn(target, 'Backspace', { ctrlKey: true }),
        keyOn(target, 'ArrowUp'),
        keyOn(target, 'ArrowDown'),
        keyOn(target, 'ArrowUp', { shiftKey: true }),
        keyOn(target, 'ArrowDown', { shiftKey: true })
      ]

      expectZeroEditCalls()
      for (const event of events) {
        expect(event.defaultPrevented).toBe(false)
      }
    }
  )

  it.each([['textarea'], ['prosemirror']])(
    'ordinary editing keys in a focused %s never reach edit-mode entries',
    (kind) => {
      const { getByTestId } = render(
        <>
          <Harness />
          <textarea data-testid="textarea" />
          <div data-testid="prosemirror" contentEditable className="ProseMirror tiptap" />
        </>
      )
      const target = getByTestId(kind)
      target.focus()
      expect(document.activeElement).toBe(target)

      const events = [
        keyOn(target, 'a'),
        keyOn(target, 'Enter'),
        keyOn(target, 'Tab'),
        keyOn(target, 'Backspace'),
        keyOn(target, 'Delete'),
        keyOn(target, 'a', { metaKey: true }),
        keyOn(target, 'e', { metaKey: true })
      ]

      // NOTE: mod+E is the global edit-mode toggle owned by EditModeToggle's
      // own hotkey registration, not by this hook — this hook must not act on it.
      expectZeroEditCalls()
      for (const event of events) {
        expect(event.defaultPrevented).toBe(false)
      }
    }
  )

  it('Escape on a focused plain INPUT stays an edit-mode command', () => {
    spies.selectedGroupIds.current = []
    const { container } = render(
      <>
        <Harness />
        <input data-testid="text-input" />
      </>
    )
    const input = container.querySelector('[data-testid="text-input"]') as HTMLInputElement
    input.focus()
    expect(document.activeElement).toBe(input)

    const event = keyOn(input, 'Escape')
    expect(event.defaultPrevented).toBe(true)
    expect(spies.toggleEditMode).toHaveBeenCalledWith(false)
  })
})
