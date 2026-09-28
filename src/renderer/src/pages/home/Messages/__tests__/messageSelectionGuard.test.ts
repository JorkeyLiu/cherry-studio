/**
 * Boundary-aware native-selection guard:
 * - A native range spanning multiple message containers is cross-message
 *   (cleared/clamped), including Shift multi-select residue.
 * - Ordinary selection wholly within one message is retained.
 * - Collapsed or outside-messages selections are untouched.
 */
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  clampCrossMessageNativeSelection,
  isCrossMessageNativeSelection,
  useCrossMessageSelectionGuard
} from '../messageSelectionGuard'

function mountTwoMessages(): { textA: Text; textB: Text } {
  document.body.innerHTML = ''
  const host = document.createElement('div')
  host.id = 'messages'
  const a = document.createElement('div')
  a.setAttribute('data-message-id', 'm-a')
  a.textContent = 'alpha message one'
  const b = document.createElement('div')
  b.setAttribute('data-message-id', 'm-b')
  b.textContent = 'beta message two'
  host.appendChild(a)
  host.appendChild(b)
  document.body.appendChild(host)
  return { textA: a.firstChild as Text, textB: b.firstChild as Text }
}

function selectRange(startNode: Node, start: number, endNode: Node, end: number): Selection {
  const sel = document.getSelection()!
  sel.removeAllRanges()
  const range = document.createRange()
  range.setStart(startNode, start)
  range.setEnd(endNode, end)
  sel.addRange(range)
  return sel
}

describe('isCrossMessageNativeSelection / clamp', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.getSelection()?.removeAllRanges()
    document.body.innerHTML = ''
  })

  it('flags a range spanning two message containers and clears it', () => {
    const { textA, textB } = mountTwoMessages()
    const sel = selectRange(textA, 1, textB, 3)
    expect(sel.isCollapsed).toBe(false)
    expect(isCrossMessageNativeSelection(sel)).toBe(true)
    expect(clampCrossMessageNativeSelection(sel)).toBe(true)
    expect(sel.rangeCount).toBe(0)
  })

  it('retains ordinary selection wholly within one message', () => {
    const { textA } = mountTwoMessages()
    const sel = selectRange(textA, 1, textA, 4)
    expect(isCrossMessageNativeSelection(sel)).toBe(false)
    expect(clampCrossMessageNativeSelection(sel)).toBe(false)
    expect(sel.rangeCount).toBe(1)
    expect(sel.toString()).toBe('lph')
  })

  it('ignores collapsed and outside-messages selections', () => {
    const { textA } = mountTwoMessages()
    const sel = selectRange(textA, 2, textA, 2)
    expect(isCrossMessageNativeSelection(sel)).toBe(false)

    const outside = document.createElement('div')
    outside.textContent = 'prompt area text'
    document.body.appendChild(outside)
    const sel2 = selectRange(outside.firstChild as Text, 0, outside.firstChild as Text, 6)
    expect(isCrossMessageNativeSelection(sel2)).toBe(false)
    expect(clampCrossMessageNativeSelection(sel2)).toBe(false)
    expect(sel2.rangeCount).toBe(1)
  })
})

describe('useCrossMessageSelectionGuard (selectionchange wiring)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.getSelection()?.removeAllRanges()
    document.body.innerHTML = ''
  })

  it('clears a cross-message range on selectionchange but keeps same-message ranges', () => {
    renderHook(() => useCrossMessageSelectionGuard())
    const { textA, textB } = mountTwoMessages()

    selectRange(textA, 0, textB, 4)
    document.dispatchEvent(new Event('selectionchange'))
    expect(document.getSelection()?.rangeCount).toBe(0)

    const sel = selectRange(textA, 0, textA, 5)
    document.dispatchEvent(new Event('selectionchange'))
    expect(document.getSelection()?.rangeCount).toBe(1)
    expect(sel.toString()).toBe('alpha')
  })
})
