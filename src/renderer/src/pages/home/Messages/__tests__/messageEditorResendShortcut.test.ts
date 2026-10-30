import { defaultKeymap } from '@codemirror/commands'
import { isMac } from '@renderer/config/constant'
import { EditorState, EditorView, keymap, Prec } from '@uiw/react-codemirror'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createMessageEditorResendExtensions,
  createMessageEditorResendKeyDownHandler
} from '../messageEditorResendShortcut'

const makeEvent = (init: KeyboardEventInit & { isComposing?: boolean } = {}) => {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    ...init
  })
  if (init.isComposing) Object.defineProperty(event, 'isComposing', { value: true })
  return event
}

describe('message editor resend keydown handler', () => {
  const setup = (options: { disabled?: boolean; useMetaKey?: boolean } = {}) => {
    const onResend = vi.fn()
    const onSave = vi.fn()
    const handler = createMessageEditorResendKeyDownHandler({
      isDisabled: () => options.disabled ?? false,
      onResend,
      // Ctrl convention by default so both platform conventions are explicit.
      useMetaKey: options.useMetaKey ?? false
    })
    return { handler, onResend, onSave }
  }

  it('Ctrl+Enter resends exactly once on the non-mac convention and consumes the event', () => {
    const { handler, onResend } = setup({ useMetaKey: false })
    const event = makeEvent({ ctrlKey: true })
    expect(handler(event)).toBe(true)
    expect(onResend).toHaveBeenCalledTimes(1)
    // Consumed before the editor default: no line is also inserted.
    expect(event.defaultPrevented).toBe(true)
    expect(event.cancelBubble).toBe(true)
  })

  it('Cmd+Enter resends exactly once on the macOS convention', () => {
    const { handler, onResend } = setup({ useMetaKey: true })
    const event = makeEvent({ metaKey: true })
    expect(handler(event)).toBe(true)
    expect(onResend).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('follows the platform convention: the other platform modifier never resends', () => {
    const mac = setup({ useMetaKey: true })
    expect(mac.handler(makeEvent({ ctrlKey: true }))).toBe(false)
    expect(mac.onResend).not.toHaveBeenCalled()

    const other = setup({ useMetaKey: false })
    expect(other.handler(makeEvent({ metaKey: true }))).toBe(false)
    expect(other.onResend).not.toHaveBeenCalled()
  })

  it('defaults to the app platform convention', () => {
    const onResend = vi.fn()
    const handler = createMessageEditorResendKeyDownHandler({ isDisabled: () => false, onResend })
    const event = makeEvent(isMac ? { metaKey: true } : { ctrlKey: true })
    expect(handler(event)).toBe(true)
    expect(onResend).toHaveBeenCalledTimes(1)
  })

  it('plain Enter is not consumed (it stays a newline) and never resends', () => {
    const { handler, onResend } = setup()
    const event = makeEvent()
    expect(handler(event)).toBe(false)
    expect(onResend).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('never resends during IME composition', () => {
    const { handler, onResend } = setup()
    const composing = makeEvent({ ctrlKey: true, isComposing: true })
    expect(handler(composing)).toBe(false)
    expect(composing.defaultPrevented).toBe(false)
    expect(onResend).not.toHaveBeenCalled()
  })

  it('ignores every combination that is not exactly the platform mod+Enter', () => {
    const { handler, onResend } = setup({ useMetaKey: false })
    // Extra modifiers are not this shortcut.
    expect(handler(makeEvent({ ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(handler(makeEvent({ ctrlKey: true, altKey: true }))).toBe(false)
    expect(handler(makeEvent({ ctrlKey: true, metaKey: true }))).toBe(false)
    expect(handler(makeEvent({ shiftKey: true }))).toBe(false)
    expect(onResend).not.toHaveBeenCalled()
  })

  it('nothing but Enter is handled', () => {
    const { handler, onResend } = setup()
    expect(handler(makeEvent({ key: 's', ctrlKey: true }))).toBe(false)
    expect(handler(makeEvent({ key: 'Escape' }))).toBe(false)
    expect(onResend).not.toHaveBeenCalled()
  })

  it('keeps the existing disabled guard: consumed without a second submission', () => {
    const { handler, onResend } = setup({ disabled: true })
    const event = makeEvent({ ctrlKey: true })
    expect(handler(event)).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(onResend).not.toHaveBeenCalled()
  })
})

describe('message editor resend shortcut wiring in a live engine', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  const mountEngine = (role: string, options: { engineDefaults?: boolean } = {}) => {
    const onResend = vi.fn()
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const extension = createMessageEditorResendExtensions({
      role,
      isDisabled: () => false,
      onResend
    })
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'draft',
        // The editor's real keymap is present at default precedence: it binds
        // Mod-Enter (the platform mod, Cmd on macOS / Ctrl elsewhere), so the
        // shortcut must win and Enter must keep its newline behavior. It is
        // omitted where a stand-down case must be observable, because the
        // engine default would otherwise consume the same key.
        extensions: [...((options.engineDefaults ?? true) ? [keymap.of(defaultKeymap)] : []), ...extension]
      })
    })
    return { view, onResend }
  }

  const press = (view: EditorView, init: KeyboardEventInit & { isComposing?: boolean } = {}) => {
    const event = makeEvent(init)
    view.contentDOM.dispatchEvent(event)
    return event
  }

  // Platform mod convention: Cmd on macOS, Ctrl elsewhere. This is the same
  // predicate the binding uses, so each dispatch uses the real platform key.
  const platformMod = () => (isMac ? { metaKey: true } : { ctrlKey: true })
  const otherPlatformMod = () => (isMac ? { ctrlKey: true } : { metaKey: true })

  it('user platform mod+Enter beats the engine default, resends once, inserts nothing', () => {
    const { view, onResend } = mountEngine('user')
    const event = press(view, platformMod())
    expect(onResend).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
    // No blank line from the engine default binding.
    expect(view.state.doc.toString()).toBe('draft')
    view.destroy()
  })

  it('user opposite platform mod+Enter never resends', () => {
    const { view, onResend } = mountEngine('user')
    const event = press(view, otherPlatformMod())
    expect(onResend).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
    view.destroy()
  })

  it('user plain Enter inserts a newline and never resends', () => {
    const { view, onResend } = mountEngine('user')
    press(view)
    expect(onResend).not.toHaveBeenCalled()
    expect(view.state.doc.toString()).not.toBe('draft')
    expect(view.state.doc.toString()).toContain('\n')
    view.destroy()
  })

  it('user platform mod+Enter during composition neither resends nor consumes', () => {
    const { view, onResend } = mountEngine('user', { engineDefaults: false })
    const event = press(view, { ...platformMod(), isComposing: true })
    expect(onResend).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
    view.destroy()
  })

  it('assistant edits get no resend shortcut (save/cancel only)', () => {
    // No binding is registered for this role at all…
    expect(
      createMessageEditorResendExtensions({ role: 'assistant', isDisabled: () => false, onResend: vi.fn() })
    ).toEqual([])
    // …and the editor is left untouched by the key.
    const { view, onResend } = mountEngine('assistant', { engineDefaults: false })
    const event = press(view, platformMod())
    expect(onResend).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
    view.destroy()
  })
})

describe('message editor resend shortcut platform conventions in a live engine', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  // The renderer test environment has no Electron preload, so `isMac` is false
  // here and the app default would only ever exercise the non-mac convention.
  // These cases mount the handler with an explicit convention (the same option
  // the app leaves at its platform default) so BOTH branches run through a real
  // engine, including the macOS one, on any host.
  const mountEngineForConvention = (useMetaKey: boolean) => {
    const onResend = vi.fn()
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'draft',
        extensions: [
          // Competing default-precedence binding for the same key: if it ran,
          // it would insert a line alongside the submission.
          keymap.of([
            {
              key: useMetaKey ? 'Meta-Enter' : 'Ctrl-Enter',
              run: (target) => {
                target.dispatch({ changes: { from: target.state.doc.length, insert: '\n' } })
                return true
              }
            }
          ]),
          Prec.highest(
            EditorView.domEventHandlers({
              keydown: createMessageEditorResendKeyDownHandler({
                isDisabled: () => false,
                onResend,
                useMetaKey
              })
            })
          )
        ]
      })
    })
    return { view, onResend }
  }

  it('macOS Meta+Enter beats the engine binding, resends once and inserts nothing', () => {
    const { view, onResend } = mountEngineForConvention(true)
    const event = makeEvent({ metaKey: true })
    view.contentDOM.dispatchEvent(event)
    expect(onResend).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
    expect(view.state.doc.toString()).toBe('draft')
    view.destroy()
  })

  it('non-mac Ctrl+Enter beats the engine binding, resends once and inserts nothing', () => {
    const { view, onResend } = mountEngineForConvention(false)
    const event = makeEvent({ ctrlKey: true })
    view.contentDOM.dispatchEvent(event)
    expect(onResend).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
    expect(view.state.doc.toString()).toBe('draft')
    view.destroy()
  })
})
