import { isMac } from '@renderer/config/constant'
import { describe, expect, it, vi } from 'vitest'

import { createMessageEditorFindKeyDownHandler } from '../messageEditorFindShortcut'

const makeEvent = (init: KeyboardEventInit & { isComposing?: boolean } = {}) => {
  const event = new KeyboardEvent('keydown', {
    key: 'f',
    bubbles: true,
    cancelable: true,
    ...init
  })
  if (init.isComposing) Object.defineProperty(event, 'isComposing', { value: true })
  return event
}

describe('message editor find keydown handler', () => {
  const setup = (options: { useMetaKey?: boolean } = {}) => {
    const onToggle = vi.fn()
    const handler = createMessageEditorFindKeyDownHandler({
      onToggle,
      // Ctrl convention by default so both platform conventions are explicit.
      useMetaKey: options.useMetaKey ?? false
    })
    return { handler, onToggle }
  }

  it('Ctrl+F toggles exactly once, consumes the event and stops it from bubbling', () => {
    const { handler, onToggle } = setup()
    const event = makeEvent({ ctrlKey: true })
    expect(handler(event)).toBe(true)
    expect(onToggle).toHaveBeenCalledTimes(1)
    // Consumed for the native Find dialog AND for the app shortcut layer, which
    // listens on the document at bubble time and never checks `defaultPrevented`.
    expect(event.defaultPrevented).toBe(true)
    expect(event.cancelBubble).toBe(true)
  })

  it('Cmd+F toggles on the macOS convention', () => {
    const { handler, onToggle } = setup({ useMetaKey: true })
    const event = makeEvent({ metaKey: true })
    expect(handler(event)).toBe(true)
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('follows the platform convention: the other platform modifier never toggles', () => {
    const mac = setup({ useMetaKey: true })
    expect(mac.handler(makeEvent({ ctrlKey: true }))).toBe(false)
    expect(mac.onToggle).not.toHaveBeenCalled()

    const other = setup({ useMetaKey: false })
    expect(other.handler(makeEvent({ metaKey: true }))).toBe(false)
    expect(other.onToggle).not.toHaveBeenCalled()
  })

  it('defaults to the app platform convention', () => {
    const onToggle = vi.fn()
    const handler = createMessageEditorFindKeyDownHandler({ onToggle })
    expect(handler(makeEvent(isMac ? { metaKey: true } : { ctrlKey: true }))).toBe(true)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('keeps Caps Lock from disabling the shortcut', () => {
    const { handler, onToggle } = setup()
    const event = makeEvent({ key: 'F', ctrlKey: true })
    expect(handler(event)).toBe(true)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('never toggles during IME composition and never consumes the press', () => {
    const { handler, onToggle } = setup()
    const event = makeEvent({ ctrlKey: true, isComposing: true })
    expect(handler(event)).toBe(false)
    expect(onToggle).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('ignores Shift and Alt combinations', () => {
    const { handler, onToggle } = setup()
    expect(handler(makeEvent({ ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(handler(makeEvent({ ctrlKey: true, altKey: true }))).toBe(false)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('leaves plain typing and every other key untouched', () => {
    const { handler, onToggle } = setup()
    const plain = makeEvent()
    expect(handler(plain)).toBe(false)
    expect(plain.defaultPrevented).toBe(false)
    expect(handler(makeEvent({ key: 's', ctrlKey: true }))).toBe(false)
    expect(onToggle).not.toHaveBeenCalled()
  })
})
