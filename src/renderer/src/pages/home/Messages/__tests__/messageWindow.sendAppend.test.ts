import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import { chooseNavigationWindow, resolveFlowScrollTarget, resolveMessageNavigation } from '../messageNavigation'
import {
  applyWindowTransition,
  MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT,
  type MessageWindow,
  type WindowTransitionIntent
} from '../messageWindow'

const CAP = MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT

const userMsg = (id: string): Message => ({
  id,
  role: 'user',
  assistantId: 'assistant',
  topicId: 'topic',
  createdAt: '2026-07-19T00:00:00.000Z',
  status: UserMessageStatus.SUCCESS,
  blocks: []
})
const assistantMsg = (id: string, askId: string): Message => ({
  id,
  role: 'assistant',
  askId,
  assistantId: 'assistant',
  topicId: 'topic',
  createdAt: '2026-07-19T00:00:00.000Z',
  status: AssistantMessageStatus.SUCCESS,
  blocks: []
})

/** 36 chronological rows alternating user/assistant: 36 visual groups. */
const pairRows = (pairs: number): Message[] => {
  const rows: Message[] = []
  for (let i = 0; i < pairs; i++) {
    rows.push(userMsg(`u${i}`))
    rows.push(assistantMsg(`a${i}`, `ask-${i}`))
  }
  return rows
}

const ids = (w: { displayMessages: Message[] }) => w.displayMessages.map(({ id }) => id)

const reconciledOf = (
  intent: Extract<WindowTransitionIntent, { kind: 'append' }>
): { window: MessageWindow; followsAppendedTail: boolean } => {
  const outcome = applyWindowTransition(intent)
  if (outcome.kind !== 'reconciled') throw new Error(`expected reconciled, got ${outcome.kind}`)
  return outcome
}

/** Parked full-range window: every loaded group mounted (page 36, cap 50). */
const parkedFull = (rows: Message[], capacity: number): MessageWindow => {
  const outcome = applyWindowTransition({ kind: 'initial', messages: rows, budget: capacity })
  if (outcome.kind !== 'window') throw new Error('expected window')
  return outcome.window
}

describe('send-append intent: tail reveal without budget reset', () => {
  it('send after the append lands keeps the loaded oldest and mounts the real tail (0..37, not 26..37)', () => {
    const before = pairRows(18)
    const current = parkedFull(before, 50)
    expect(current.groupCount).toBe(36)
    expect(current.oldestMessageId).toBe('u0')

    const after = [...before, userMsg('u18')]
    const { window, followsAppendedTail } = reconciledOf({
      kind: 'append',
      messages: after,
      currentWindow: current,
      options: { atPhysicalBottom: true }
    })
    expect(window.oldestMessageId).toBe('u0')
    expect(window.newestMessageId).toBe('u18')
    expect(window.groupCount).toBe(37)
    expect(window.groupCapacity).toBe(50)
    expect(ids(window)[0]).toBe('u18')
    expect(ids(window).at(-1)).toBe('u0')
    expect(followsAppendedTail).toBe(true)
  })

  it('send before the append lands is stable: the parked window is returned as-is', () => {
    const rows = pairRows(18)
    const current = parkedFull(rows, 50)
    const { window, followsAppendedTail } = reconciledOf({
      kind: 'append',
      messages: rows,
      currentWindow: current,
      options: { atPhysicalBottom: true }
    })
    expect(ids(window)).toEqual(ids(current))
    expect(window.oldestMessageId).toBe('u0')
    // No growth past the committed tail: no follow verdict.
    expect(followsAppendedTail).toBe(false)
  })

  it('a browsing range in the middle keeps its oldest and still reaches the new tail', () => {
    const rows = pairRows(18)
    // Middle browsing range u5..a12 (committed while reading, not parked).
    const middle = applyWindowTransition({
      kind: 'target',
      messages: rows,
      targetId: 'u8',
      older: 3,
      newer: 4
    })
    if (middle.kind !== 'window') throw new Error('expected window')
    const oldestBefore = middle.window.oldestMessageId
    const after = [...rows, userMsg('u18')]
    const { window } = reconciledOf({ kind: 'append', messages: after, currentWindow: middle.window })
    expect(window.oldestMessageId).toBe(oldestBefore)
    expect(window.newestMessageId).toBe('u18')
    // Never a newest-N budget re-slice.
    expect(window.groupCount).toBeGreaterThan(10)
  })

  it('beyond the hard cap only the older edge trims, by the excess', () => {
    const rows = pairRows(105)
    // 210 groups; the parked full window holds the newest 200 (oldest 10).
    const current = parkedFull(rows, CAP)
    expect(current.groupCount).toBe(CAP)
    expect(current.range).toEqual({ oldestGroupIndex: 10, newestGroupIndex: 209 })
    const after = [...rows, userMsg('ux'), assistantMsg('ax', 'ask-x')]
    const { window } = reconciledOf({ kind: 'append', messages: after, currentWindow: current })
    expect(window.groupCount).toBe(CAP)
    expect(window.groupCapacity).toBe(CAP)
    expect(window.newestMessageId).toBe('ax')
    expect(window.range).toEqual({ oldestGroupIndex: 12, newestGroupIndex: 211 })
  })

  it('no committed range resolves: falls back to current capacity, never the initial budget', () => {
    const rows = pairRows(18)
    const current = parkedFull(rows, 50)
    const unrelated = pairRows(10).map((m, i) => ({ ...m, id: `other-${i}` }))
    const { window } = reconciledOf({ kind: 'append', messages: unrelated, currentWindow: current })
    expect(window.groupCapacity).toBe(50)
    expect(window.groupCount).toBeLessThanOrEqual(50)
  })

  it('without a measured physical bottom the follow verdict stays false (never steals scroll)', () => {
    const before = pairRows(18)
    const current = parkedFull(before, 50)
    const after = [...before, userMsg('u18')]
    const { followsAppendedTail } = reconciledOf({ kind: 'append', messages: after, currentWindow: current })
    expect(followsAppendedTail).toBe(false)
  })
})

describe('send-bottom navigation: same bottom geometry, append window derivation', () => {
  it('resolves and scrolls exactly like an explicit bottom', () => {
    const rows = pairRows(18)
    const resolved = resolveMessageNavigation(rows, { kind: 'send-bottom', source: 'imperative' })
    expect(resolved).toEqual({ kind: 'send-bottom' })
    const container = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400, scrollTo: () => {} }
    expect(resolveFlowScrollTarget(resolved!, container)).toEqual({ top: 600 })
    expect(resolveFlowScrollTarget({ kind: 'bottom' }, container)).toEqual({ top: 600 })
  })

  it('send-bottom extends the current range to the tail instead of resetting to the budget', () => {
    const before = pairRows(18)
    const current = parkedFull(before, 50)
    const after = [...before, userMsg('u18')]
    const window = chooseNavigationWindow(after, current, { kind: 'send-bottom' }, 10)
    expect(window).not.toBeNull()
    expect(window!.oldestMessageId).toBe('u0')
    expect(window!.newestMessageId).toBe('u18')
    // The budget-10 reset would have mounted only the newest 10 groups.
    expect(window!.groupCount).toBe(37)
  })

  it('explicit go-latest still resets to the initial budget', () => {
    const before = pairRows(18)
    const current = parkedFull(before, 50)
    const after = [...before, userMsg('u18')]
    const window = chooseNavigationWindow(after, current, { kind: 'bottom' }, 10)
    expect(window).not.toBeNull()
    expect(window!.groupCount).toBe(10)
    expect(window!.newestMessageId).toBe('u18')
    expect(window!.oldestMessageId).not.toBe('u0')
  })

  it('send-bottom with no committed window falls back to the initial-budget latest', () => {
    const rows = pairRows(18)
    const window = chooseNavigationWindow(rows, null, { kind: 'send-bottom' }, 10)
    expect(window).not.toBeNull()
    expect(window!.groupCount).toBe(10)
  })
})
