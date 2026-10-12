import { beforeEach, describe, expect, it } from 'vitest'

import {
  getMessageEditorHeightBounds,
  MESSAGE_EDITOR_HEIGHT_DEFAULT,
  MESSAGE_EDITOR_HEIGHT_MIN,
  MESSAGE_EDITOR_HEIGHT_STORAGE_KEY,
  parseMessageEditorHeight,
  readMessageEditorHeight,
  resolveMessageEditorDisplayHeight,
  writeMessageEditorHeight
} from '../messageEditorHeight'

beforeEach(() => {
  localStorage.clear()
})

describe('parseMessageEditorHeight', () => {
  it('accepts finite positive numbers', () => {
    expect(parseMessageEditorHeight(340)).toBe(340)
    expect(parseMessageEditorHeight(220.4)).toBe(220.4)
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

describe('message editor height preference', () => {
  it('reads back the last committed height', () => {
    writeMessageEditorHeight(412)
    expect(localStorage.getItem(MESSAGE_EDITOR_HEIGHT_STORAGE_KEY)).toBe('412')
    expect(readMessageEditorHeight()).toBe(412)
  })

  it('rounds fractional commits', () => {
    writeMessageEditorHeight(300.6)
    expect(readMessageEditorHeight()).toBe(301)
  })

  it('falls back to null on corrupt storage and drops the entry', () => {
    localStorage.setItem(MESSAGE_EDITOR_HEIGHT_STORAGE_KEY, 'not-json{{{')
    expect(readMessageEditorHeight()).toBeNull()
    expect(localStorage.getItem(MESSAGE_EDITOR_HEIGHT_STORAGE_KEY)).toBeNull()
  })

  it('falls back to null on wrong-schema payloads and drops the entry', () => {
    localStorage.setItem(MESSAGE_EDITOR_HEIGHT_STORAGE_KEY, JSON.stringify({ height: 400 }))
    expect(readMessageEditorHeight()).toBeNull()
    expect(localStorage.getItem(MESSAGE_EDITOR_HEIGHT_STORAGE_KEY)).toBeNull()
  })

  it('ignores invalid writes and keeps the previous preference', () => {
    writeMessageEditorHeight(400)
    writeMessageEditorHeight(Number.NaN)
    writeMessageEditorHeight(-10)
    expect(readMessageEditorHeight()).toBe(400)
  })
})

describe('resolveMessageEditorDisplayHeight', () => {
  it('defaults when nothing is stored', () => {
    expect(resolveMessageEditorDisplayHeight(null)).toBe(MESSAGE_EDITOR_HEIGHT_DEFAULT)
  })

  it('clamps to the 52vh maximum without rewriting storage', () => {
    // 52vh of 600 = 312 < stored 500: display clamps, storage keeps intent.
    writeMessageEditorHeight(500)
    expect(resolveMessageEditorDisplayHeight(readMessageEditorHeight(), 600)).toBe(312)
    expect(readMessageEditorHeight()).toBe(500)
  })

  it('never clamps below the responsive minimum on short viewports', () => {
    const { min, max } = getMessageEditorHeightBounds(300)
    expect(min).toBeLessThanOrEqual(MESSAGE_EDITOR_HEIGHT_MIN)
    expect(min).toBeLessThanOrEqual(max)
    expect(resolveMessageEditorDisplayHeight(340, 300)).toBe(max)
  })

  it('keeps the saved preference once the window grows again', () => {
    writeMessageEditorHeight(500)
    expect(resolveMessageEditorDisplayHeight(readMessageEditorHeight(), 1200)).toBe(500)
  })
})
