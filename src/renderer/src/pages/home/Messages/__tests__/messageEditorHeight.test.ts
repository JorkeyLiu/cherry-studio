import { describe, expect, it } from 'vitest'

import {
  estimateMessageEditorAutoHeight,
  getMessageEditorHeightBounds,
  MESSAGE_EDITOR_HEIGHT_MIN,
  parseMessageEditorHeight,
  resolveMessageEditorHeight
} from '../messageEditorHeight'

describe('parseMessageEditorHeight', () => {
  it('accepts finite positive numbers', () => {
    expect(parseMessageEditorHeight(340)).toBe(340)
    expect(parseMessageEditorHeight(40.4)).toBe(40.4)
  })

  it('accepts numeric strings', () => {
    expect(parseMessageEditorHeight('420')).toBe(420)
  })

  it('rejects missing, corrupt and non-positive payloads', () => {
    expect(parseMessageEditorHeight(null)).toBeNull()
    expect(parseMessageEditorHeight(undefined)).toBeNull()
    expect(parseMessageEditorHeight('')).toBeNull()
    expect(parseMessageEditorHeight('not-a-number')).toBeNull()
    expect(parseMessageEditorHeight(Number.NaN)).toBeNull()
    expect(parseMessageEditorHeight(Number.POSITIVE_INFINITY)).toBeNull()
    expect(parseMessageEditorHeight(0)).toBeNull()
    expect(parseMessageEditorHeight(-50)).toBeNull()
    expect(parseMessageEditorHeight({})).toBeNull()
  })
})

describe('getMessageEditorHeightBounds', () => {
  it('exposes ONE single lower bound: a one-line floor, not an arbitrary minimum', () => {
    // Measured runtime geometry (14px type at 1.6 line-height): one .cm-line
    // is 22.4px plus 8px of content padding (~30.4px natural). The floor is
    // that line plus normal slack — far below any historical 96/220 pin.
    expect(MESSAGE_EDITOR_HEIGHT_MIN).toBe(40)
    const { min } = getMessageEditorHeightBounds(768)
    expect(min).toBe(MESSAGE_EDITOR_HEIGHT_MIN)
  })

  it('caps the maximum at 52vh with a responsive minimum', () => {
    // 52vh of 600 = 312: display clamps, intent is untouched (caller-owned).
    expect(resolveMessageEditorHeight(500, 600)).toBe(312)
  })

  it('never traps a small window: min yields when the maximum drops below it', () => {
    const { min, max } = getMessageEditorHeightBounds(60)
    expect(min).toBeLessThanOrEqual(max)
    expect(resolveMessageEditorHeight(340, 60)).toBe(max)
  })

  it('keeps a large manual intent once the window grows again', () => {
    expect(resolveMessageEditorHeight(500, 1200)).toBe(500)
  })
})

describe('resolveMessageEditorHeight (the single auto+manual resolver)', () => {
  it('floors a short one-line measurement at the one-line floor (no large empty area)', () => {
    // A one-line draft naturally measures ~30px: it renders at the 40px
    // floor with only normal slack below the text.
    expect(resolveMessageEditorHeight(30, 768)).toBe(MESSAGE_EDITOR_HEIGHT_MIN)
    expect(resolveMessageEditorHeight(34, 768)).toBe(MESSAGE_EDITOR_HEIGHT_MIN)
  })

  it('resolves the SAME bounds for manual heights as for adaptive ones', () => {
    // Automatic and manual are only ways to supply a desired height into one
    // resolver: identical inputs resolve identically through either path.
    expect(resolveMessageEditorHeight(60, 768)).toBe(60)
    expect(resolveMessageEditorHeight(260, 768)).toBe(260)
    expect(resolveMessageEditorHeight(20, 768)).toBe(MESSAGE_EDITOR_HEIGHT_MIN)
  })

  it('passes through mid-range heights unchanged', () => {
    expect(resolveMessageEditorHeight(260, 768)).toBe(260)
  })

  it('caps long content at the 52vh maximum', () => {
    // 52vh of 768 = 399 (floored).
    expect(resolveMessageEditorHeight(1200, 768)).toBe(399)
  })

  it('grows and shrinks with the desired height (no sticky direction)', () => {
    expect(resolveMessageEditorHeight(300, 768)).toBe(300)
    expect(resolveMessageEditorHeight(79, 768)).toBe(79)
  })

  it('falls back to the one-line floor on invalid input without throwing', () => {
    expect(resolveMessageEditorHeight(Number.NaN, 768)).toBe(MESSAGE_EDITOR_HEIGHT_MIN)
    expect(resolveMessageEditorHeight(-40, 768)).toBe(MESSAGE_EDITOR_HEIGHT_MIN)
  })
})

describe('estimateMessageEditorAutoHeight', () => {
  it('estimates a short single-line draft exactly at the one-line floor (no large-height flash)', () => {
    expect(estimateMessageEditorAutoHeight('hello', 768)).toBe(MESSAGE_EDITOR_HEIGHT_MIN)
  })

  it('estimates a two-line draft just above the floor (actual natural growth)', () => {
    const two = estimateMessageEditorAutoHeight('one\ntwo', 768)
    expect(two).toBeGreaterThan(MESSAGE_EDITOR_HEIGHT_MIN)
    expect(two).toBeLessThan(MESSAGE_EDITOR_HEIGHT_MIN + 40)
  })

  it('estimates a long draft at the maximum it will measure into', () => {
    const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')
    expect(estimateMessageEditorAutoHeight(long, 768)).toBe(399)
  })

  it('estimates an empty draft at the floor', () => {
    expect(estimateMessageEditorAutoHeight('', 768)).toBe(MESSAGE_EDITOR_HEIGHT_MIN)
  })
})
