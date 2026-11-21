import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import {
  applyWindowTransition,
  buildRouteViewport,
  createLatestMessageWindow,
  createOldestMessageWindow,
  createTargetMessageWindow,
  derivePaginationWindow,
  followsAppendedTailCommit,
  MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT,
  type MessageWindow,
  reconcileMessageWindow,
  type WindowTransitionIntent
} from '../messageWindow'

const CAP = MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT

const message = (id: string, role: Message['role'] = 'user', askId?: string): Message => ({
  id,
  role,
  askId,
  assistantId: 'assistant',
  topicId: 'topic',
  createdAt: '2026-07-19T00:00:00.000Z',
  status: role === 'user' ? UserMessageStatus.SUCCESS : AssistantMessageStatus.SUCCESS,
  blocks: []
})

const users = (count: number): Message[] => Array.from({ length: count }, (_, i) => message(`m${i}`))
const ids = (w: { displayMessages: Message[] }) => w.displayMessages.map(({ id }) => id)

const windowOf = (intent: WindowTransitionIntent): MessageWindow => {
  const outcome = applyWindowTransition(intent)
  if (outcome.kind !== 'window') throw new Error(`expected window, got ${outcome.kind}`)
  return outcome.window
}

describe('window transition intent: boundary and capacity contract', () => {
  it('initial intent uses the initial display budget (10), not the hard cap', () => {
    const window = windowOf({ kind: 'initial', messages: users(14), budget: 10 })
    expect(window.groupCapacity).toBe(10)
    expect(window.groupCount).toBe(10)
    expect(window.edge).toBe('latest')
    expect(ids(window)).toEqual(['m13', 'm12', 'm11', 'm10', 'm9', 'm8', 'm7', 'm6', 'm5', 'm4'])
  })

  it('latest intent with an over-cap budget clamps to the 200 hard cap', () => {
    const window = windowOf({ kind: 'latest', messages: users(250), budget: 1000 })
    expect(window.groupCapacity).toBe(CAP)
    expect(window.groupCount).toBe(CAP)
    expect(window.range).toEqual({ oldestGroupIndex: 50, newestGroupIndex: 249 })
  })

  it('same-route append 14→16→18 at the physical bottom retains the oldest boundary with one follow verdict', () => {
    const atBottom = { atPhysicalBottom: true }
    let previous = users(14)
    let current = windowOf({ kind: 'initial', messages: previous, budget: 10 })
    for (const next of [users(16), users(18)]) {
      const outcome = applyWindowTransition({
        kind: 'reconcile',
        messages: next,
        previousMessages: previous,
        currentWindow: current,
        options: atBottom
      })
      if (outcome.kind !== 'reconciled') throw new Error('expected reconciled')
      expect(outcome.followsAppendedTail).toBe(true)
      expect(outcome.window.oldestMessageId).toBe('m4')
      expect(outcome.window.newestMessageId).toBe(next.at(-1)?.id)
      // Legacy compat reports the SAME verdict for the same commit.
      expect(followsAppendedTailCommit(next, previous, current, atBottom)).toBe(outcome.followsAppendedTail)
      expect(ids(reconcileMessageWindow(next, previous, current, atBottom))).toEqual(ids(outcome.window))
      previous = next
      current = outcome.window
    }
    expect(current.groupCapacity).toBe(14)
  })

  it('held reading row suppresses follow and stays resident (reading retain wins)', () => {
    const previous = users(14)
    const current = windowOf({ kind: 'initial', messages: previous, budget: 10 })
    const next = users(16)
    const outcome = applyWindowTransition({
      kind: 'reconcile',
      messages: next,
      previousMessages: previous,
      currentWindow: current,
      options: { retainMessageId: 'm4', atPhysicalBottom: false }
    })
    if (outcome.kind !== 'reconciled') throw new Error('expected reconciled')
    expect(outcome.followsAppendedTail).toBe(false)
    expect(ids(outcome.window)).toContain('m4')
    expect(ids(outcome.window)).toEqual(ids(current))
  })

  it('explicit go-latest resets to the initial budget and drops the browsing target', () => {
    const loaded = users(16)
    const paged = windowOf({ kind: 'initial', messages: users(14), budget: 10 })
    expect(paged.paginationTarget).toBeUndefined()
    const reset = windowOf({ kind: 'latest', messages: loaded, budget: 10 })
    expect(ids(reset)).toEqual(['m15', 'm14', 'm13', 'm12', 'm11', 'm10', 'm9', 'm8', 'm7', 'm6'])
    expect(reset.paginationTarget).toBeUndefined()
    expect(reset.edge).toBe('latest')
  })

  it('exhausted authority still traverses resident-but-undisplayed older groups locally', () => {
    const window = windowOf({
      kind: 'initial',
      messages: users(30),
      budget: 10,
      authoritative: { hasMoreBefore: false, hasMoreAfter: false }
    })
    expect(window.hasMoreOlder).toBe(true)
    expect(window.hasMoreNewer).toBe(false)
    expect(window.authoritativeHasMoreBefore).toBe(false)
  })

  it('paginate intent grows the loaded edge and keeps authority mapping per edge', () => {
    const loaded = users(40)
    const current = windowOf({
      kind: 'latest',
      messages: loaded,
      budget: 10,
      authoritative: { hasMoreBefore: true, hasMoreAfter: false }
    })
    const intent: WindowTransitionIntent = {
      kind: 'paginate',
      direction: 'older',
      messages: loaded,
      currentWindow: current,
      additionalGroupCount: 20,
      responseWindow: { hasMoreBefore: false, hasMoreAfter: false },
      retainMessageId: null
    }
    const outcome = applyWindowTransition(intent)
    if (outcome.kind !== 'paginated') throw new Error('expected paginated')
    expect(outcome.transition.status).toBe('accepted')
    if (outcome.transition.status !== 'accepted') throw new Error('expected accepted')
    expect(outcome.transition.window.range).toEqual({ oldestGroupIndex: 10, newestGroupIndex: 39 })
    expect(outcome.transition.window.authoritativeHasMoreBefore).toBe(false)
    // Legacy entry accepts identically for the same input.
    expect(derivePaginationWindow(intent).status).toBe('accepted')
  })

  it('target and restore intents resolve the navigation quotas (older 10 / newer 19)', () => {
    const loaded = users(50)
    const target = windowOf({ kind: 'target', messages: loaded, targetId: 'm20', older: 10, newer: 19 })
    expect(target.range).toEqual({ oldestGroupIndex: 10, newestGroupIndex: 39 })
    expect(ids(target).indexOf('m20')).toBe(19)

    const restored = applyWindowTransition({
      kind: 'restore',
      loaded,
      anchors: ['m20'],
      older: 10,
      newer: 19,
      authoritative: { hasMoreBefore: true, hasMoreAfter: true }
    })
    if (restored.kind !== 'restored') throw new Error('expected restored')
    expect(restored.empty).toBe(false)
    expect(restored.window?.range).toEqual({ oldestGroupIndex: 10, newestGroupIndex: 39 })

    const empty = applyWindowTransition({ kind: 'restore', loaded: [], anchors: [], older: 10, newer: 19 })
    if (empty.kind !== 'restored') throw new Error('expected restored')
    expect(empty.empty).toBe(true)
    expect(empty.window?.displayMessages).toEqual([])
  })

  it('legacy constructors delegate to the same mechanism as their intents', () => {
    const loaded = users(50)
    expect(ids(windowOf({ kind: 'latest', messages: loaded, budget: 10 }))).toEqual(
      ids(createLatestMessageWindow(loaded, 10))
    )
    expect(ids(windowOf({ kind: 'top', messages: loaded, budget: 10 }))).toEqual(
      ids(createOldestMessageWindow(loaded, 10))
    )
    expect(ids(windowOf({ kind: 'target', messages: loaded, targetId: 'm20', older: 10, newer: 19 }))).toEqual(
      ids(createTargetMessageWindow(loaded, 'm20', 10, 19))
    )
    const anchors = ['m20'] as const
    const viaIntent = applyWindowTransition({
      kind: 'restore',
      loaded,
      anchors: [...anchors],
      older: 10,
      newer: 19,
      authoritative: { hasMoreBefore: true, hasMoreAfter: true }
    })
    const viaLegacy = buildRouteViewport(loaded, [...anchors], { hasMoreBefore: true, hasMoreAfter: true }, 10, 19)
    if (viaIntent.kind !== 'restored') throw new Error('expected restored')
    expect(ids({ displayMessages: viaIntent.window?.displayMessages ?? [] })).toEqual(
      ids({ displayMessages: viaLegacy.window?.displayMessages ?? [] })
    )
  })
})
