import { defaultKeymap } from '@codemirror/commands'
import { isMac } from '@renderer/config/constant'
import { EditorState, EditorView, keymap } from '@uiw/react-codemirror'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createMessageEditorSaveExtensions, createMessageEditorSaveKeyDownHandler } from '../messageEditorSaveShortcut'

const makeEvent = (init: KeyboardEventInit & { isComposing?: boolean } = {}) => {
  const event = new KeyboardEvent('keydown', {
    key: 's',
    bubbles: true,
    cancelable: true,
    ...init
  })
  if (init.isComposing) Object.defineProperty(event, 'isComposing', { value: true })
  return event
}

describe('message editor save keydown handler', () => {
  const setup = (options: { disabled?: boolean; useMetaKey?: boolean } = {}) => {
    const onSave = vi.fn()
    const handler = createMessageEditorSaveKeyDownHandler({
      isDisabled: () => options.disabled ?? false,
      onSave,
      // Ctrl convention by default so both platform conventions are explicit.
      useMetaKey: options.useMetaKey ?? false
    })
    return { handler, onSave }
  }

  it('Ctrl+S saves exactly once, consumes the event and stops it from bubbling', () => {
    const { handler, onSave } = setup()
    const event = makeEvent({ ctrlKey: true })
    expect(handler(event)).toBe(true)
    expect(onSave).toHaveBeenCalledTimes(1)
    // Consumed before the native Save Page default and before any outer handler.
    expect(event.defaultPrevented).toBe(true)
    expect(event.cancelBubble).toBe(true)
  })

  it('Cmd+S saves on the macOS convention', () => {
    const { handler, onSave } = setup({ useMetaKey: true })
    const event = makeEvent({ metaKey: true })
    expect(handler(event)).toBe(true)
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('follows the platform convention: the other platform modifier never saves', () => {
    const mac = setup({ useMetaKey: true })
    expect(mac.handler(makeEvent({ ctrlKey: true }))).toBe(false)
    expect(mac.onSave).not.toHaveBeenCalled()

    const other = setup({ useMetaKey: false })
    expect(other.handler(makeEvent({ metaKey: true }))).toBe(false)
    expect(other.onSave).not.toHaveBeenCalled()
  })

  it('defaults to the app platform convention', () => {
    const onSave = vi.fn()
    const handler = createMessageEditorSaveKeyDownHandler({ isDisabled: () => false, onSave })
    const event = makeEvent(isMac ? { metaKey: true } : { ctrlKey: true })
    expect(handler(event)).toBe(true)
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('never saves during IME composition', () => {
    const { handler, onSave } = setup()
    const composing = makeEvent({ ctrlKey: true, isComposing: true })
    expect(handler(composing)).toBe(false)
    expect(composing.defaultPrevented).toBe(false)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('ignores every combination that is not exactly the platform mod+S', () => {
    const { handler, onSave } = setup()
    // Plain "s" is typing.
    expect(handler(makeEvent())).toBe(false)
    // Extra modifiers are not this shortcut.
    expect(handler(makeEvent({ ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(handler(makeEvent({ ctrlKey: true, altKey: true }))).toBe(false)
    expect(handler(makeEvent({ ctrlKey: true, metaKey: true }))).toBe(false)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('Caps Lock does not disable the shortcut', () => {
    const { handler, onSave } = setup()
    expect(handler(makeEvent({ key: 'S', ctrlKey: true }))).toBe(true)
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('nothing but "s" is handled — Enter stays a newline and never saves', () => {
    const { handler, onSave } = setup()
    expect(handler(makeEvent({ key: 'Enter', ctrlKey: true }))).toBe(false)
    expect(handler(makeEvent({ key: 'Enter' }))).toBe(false)
    expect(handler(makeEvent({ key: 'a', ctrlKey: true }))).toBe(false)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('keeps the existing disabled guard: consumed without a second submission', () => {
    const { handler, onSave } = setup({ disabled: true })
    const event = makeEvent({ ctrlKey: true })
    expect(handler(event)).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    // A disabled editor does not act, but the native default is still blocked.
    expect(onSave).not.toHaveBeenCalled()
  })
})

describe('message editor save shortcut wiring in a live engine', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  const mountEngine = (options: { disabled?: boolean } = {}) => {
    const onSave = vi.fn()
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const extension = createMessageEditorSaveExtensions({
      isDisabled: () => options.disabled ?? false,
      onSave
    })
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'draft',
        // The editor's real keymap is present at default precedence: the
        // shortcut must still win, and typing/Enter must keep their behavior.
        extensions: [keymap.of(defaultKeymap), ...extension]
      })
    })
    return { view, onSave }
  }

  const press = (view: EditorView, init: KeyboardEventInit & { isComposing?: boolean } = {}) => {
    const event = makeEvent(init)
    view.contentDOM.dispatchEvent(event)
    return event
  }

  const platformMod = isMac ? { key: 's', metaKey: true } : { key: 's', ctrlKey: true }

  it('platform mod+S invokes save once, inserts nothing and blocks the native default', () => {
    const { view, onSave } = mountEngine()
    const event = press(view, platformMod)
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
    // No character from the engine default: the event never reached it.
    expect(view.state.doc.toString()).toBe('draft')
    view.destroy()
  })

  it('plain "s" types and never saves', () => {
    const { view, onSave } = mountEngine()
    const event = press(view, { key: 's' })
    expect(onSave).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
    view.destroy()
  })

  it('Enter keeps the engine newline behavior and never saves', () => {
    const { view, onSave } = mountEngine()
    press(view, { key: 'Enter' })
    expect(onSave).not.toHaveBeenCalled()
    expect(view.state.doc.toString()).not.toBe('draft')
    expect(view.state.doc.toString()).toContain('\n')
    view.destroy()
  })

  it('platform mod+S during composition neither saves nor consumes', () => {
    const { view, onSave } = mountEngine()
    const event = press(view, { ...platformMod, isComposing: true })
    expect(onSave).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
    view.destroy()
  })

  it('a disabled editor consumes the shortcut without saving', () => {
    const { view, onSave } = mountEngine({ disabled: true })
    const event = press(view, platformMod)
    expect(event.defaultPrevented).toBe(true)
    expect(onSave).not.toHaveBeenCalled()
    view.destroy()
  })
})
