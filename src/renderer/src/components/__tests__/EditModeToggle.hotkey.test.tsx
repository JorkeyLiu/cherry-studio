/**
 * EditModeToggle global hotkey (Cmd/Ctrl+E) while an editable is focused.
 *
 * - Registration passes explicit opt-in through the real `useShortcut`
 *   wrapper: `enableOnFormTags: true` (INPUT/TEXTAREA/SELECT) plus
 *   `enableOnContentEditable: true` (contenteditable/ProseMirror/Tiptap),
 *   with `preventDefault: true` preserved.
 * - Behavioral: with focus in a textarea or a contenteditable editor node,
 *   the toggle combo still dispatches the toggle exactly once and prevents
 *   the native/default action — the same as outside inputs.
 */
import { createEvent, fireEvent, render } from '@testing-library/react'
import type * as ReactHotkeysHookModule from 'react-hotkeys-hook'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks, capturedHotkeys } = vi.hoisted(() => ({
  mocks: {
    dispatch: vi.fn(),
    enabled: { current: false }
  },
  capturedHotkeys: [] as Array<{ keys: string; options: Record<string, unknown> }>
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('antd', () => ({
  Tooltip: ({ children }: any) => <div data-testid="tooltip">{children}</div>
}))

vi.mock('lucide-react', () => ({
  Edit3: () => <span data-testid="edit-icon" />
}))

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => mocks.dispatch,
  useAppSelector: (selector: (state: any) => any) =>
    selector({
      editMode: { enabled: mocks.enabled.current },
      shortcuts: {
        shortcuts: [{ key: 'toggle_edit_mode', shortcut: ['CommandOrControl', 'E'], enabled: true }]
      }
    })
}))

// Capture the options the real `useShortcut` wrapper forwards, while still
// running the real react-hotkeys-hook implementation for behavioral proof.
vi.mock('react-hotkeys-hook', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactHotkeysHookModule>()
  return {
    ...actual,
    useHotkeys: (keys: string, callback: (e: KeyboardEvent) => void, options?: any, deps?: any) => {
      capturedHotkeys.push({ keys, options: { ...options } })
      return actual.useHotkeys(keys, callback, options, deps)
    }
  }
})

const { default: EditModeToggle } = await import('../EditModeToggle')

function renderToggle() {
  return render(
    <>
      <EditModeToggle />
      <textarea data-testid="composer" />
      <div data-testid="tiptap" contentEditable className="ProseMirror tiptap" />
      <select data-testid="select">
        <option value="a">a</option>
      </select>
    </>
  )
}

describe('EditModeToggle hotkey registration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedHotkeys.length = 0
    mocks.enabled.current = false
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })

  it('registers toggle_edit_mode with form tags + contenteditable enabled and preventDefault', () => {
    renderToggle()
    const entry = capturedHotkeys.find(({ keys }) => keys !== 'none')
    expect(entry).toBeDefined()
    // CommandOrControl maps to meta/ctrl by platform; either is one binding.
    expect(entry!.keys).toMatch(/^(meta|ctrl)\+e$/)
    expect(entry!.options.enableOnFormTags).toBe(true)
    expect(entry!.options.enableOnContentEditable).toBe(true)
  })
})

describe('EditModeToggle hotkey behavior with focused editables', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedHotkeys.length = 0
    mocks.enabled.current = false
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })

  it('toggles once with preventDefault while a textarea is focused', () => {
    const { getByTestId } = renderToggle()
    const composer = getByTestId('composer') as HTMLTextAreaElement
    composer.focus()
    expect(document.activeElement).toBe(composer)

    // Only one of meta/ctrl matches the platform binding; firing both must
    // still produce exactly one toggle.
    const metaEvent = createEvent.keyDown(composer, { key: 'e', metaKey: true })
    fireEvent(composer, metaEvent)
    const ctrlEvent = createEvent.keyDown(composer, { key: 'e', ctrlKey: true })
    fireEvent(composer, ctrlEvent)

    expect(mocks.dispatch).toHaveBeenCalledTimes(1)
    const prevented = [metaEvent, ctrlEvent].some((e) => e.defaultPrevented)
    expect(prevented).toBe(true)
  })

  it('toggles once with preventDefault while a contenteditable editor node is focused', () => {
    const { getByTestId } = renderToggle()
    const editor = getByTestId('tiptap')
    editor.focus()
    expect(document.activeElement).toBe(editor)

    const metaEvent = createEvent.keyDown(editor, { key: 'e', metaKey: true })
    fireEvent(editor, metaEvent)
    const ctrlEvent = createEvent.keyDown(editor, { key: 'e', ctrlKey: true })
    fireEvent(editor, ctrlEvent)

    expect(mocks.dispatch).toHaveBeenCalledTimes(1)
    const prevented = [metaEvent, ctrlEvent].some((e) => e.defaultPrevented)
    expect(prevented).toBe(true)
  })

  it('still toggles when nothing editable is focused', () => {
    renderToggle()
    const metaEvent = createEvent.keyDown(document.body, { key: 'e', metaKey: true })
    fireEvent(document.body, metaEvent)
    const ctrlEvent = createEvent.keyDown(document.body, { key: 'e', ctrlKey: true })
    fireEvent(document.body, ctrlEvent)

    expect(mocks.dispatch).toHaveBeenCalledTimes(1)
  })

  it('toggles once while a SELECT is focused', () => {
    const { getByTestId } = renderToggle()
    const select = getByTestId('select')
    select.focus()
    expect(document.activeElement).toBe(select)

    const metaEvent = createEvent.keyDown(select, { key: 'e', metaKey: true })
    fireEvent(select, metaEvent)
    const ctrlEvent = createEvent.keyDown(select, { key: 'e', ctrlKey: true })
    fireEvent(select, ctrlEvent)

    expect(mocks.dispatch).toHaveBeenCalledTimes(1)
  })
})
