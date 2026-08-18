import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import type { MessageViewportGroup } from '../messageGroups'
import { type MessageViewportProjectedGroup, projectMessageViewportGroups } from '../messageViewportProjection'
import {
  createLatestMessageWindow,
  createOldestMessageWindow,
  createTargetMessageWindow,
  expandMessageWindowNewer,
  expandMessageWindowOlder,
  reconcileMessageWindow
} from '../messageWindow'

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

// ---------------------------------------------------------------------------
// Faithful pre-2B reference projection (the exact old MessagesContent logic).
// getGroupedMessages operated on the reversed displayMessages and each group
// was reversed again; keys were `assistant${askId}` / `${role}${id}` with a
// `_${displayIndex}` suffix for repeated non-adjacent base keys; `index` was
// the viewport-local displayMessages position (0 = newest).
// ---------------------------------------------------------------------------
const oldGetGroupedMessages = (messages: Message[]): Record<string, (Message & { index: number })[]> => {
  const groups: Record<string, (Message & { index: number })[]> = {}
  messages.forEach((message, index) => {
    let key = message.role === 'assistant' && message.askId ? 'assistant' + message.askId : message.role + message.id
    if (key && !groups[key]) {
      groups[key] = []
    } else if (key && groups[key]) {
      const prevMessage = messages[index - 1]
      if (prevMessage) {
        const prevKey =
          prevMessage.role === 'assistant' && prevMessage.askId
            ? 'assistant' + prevMessage.askId
            : prevMessage.role + prevMessage.id
        if (prevKey !== key) {
          key = key + '_' + index
          groups[key] = []
        }
      }
    }
    groups[key].push({ ...message, index })
  })
  return groups
}

const oldProjection = (displayMessages: Message[]): MessageViewportProjectedGroup[] => {
  const grouped = Object.entries(oldGetGroupedMessages(displayMessages))
  const newGrouped: Record<string, (Message & { index: number })[]> = {}
  grouped.forEach(([key, group]) => {
    newGrouped[key] = group.toReversed()
  })
  return Object.entries(newGrouped)
}

/** Normalizes either projection into a comparable structural shape. */
const shape = (projection: MessageViewportProjectedGroup[]) =>
  projection.map(([key, groupMessages]) => ({
    key,
    messageIds: groupMessages.map(({ id }) => id),
    indexes: groupMessages.map(({ index }) => index)
  }))

const expectProjectionEqualsOld = (displayMessages: Message[], displayGroups: MessageViewportGroup[]): void => {
  const threaded = projectMessageViewportGroups(displayMessages, displayGroups)
  expect(shape(threaded)).toEqual(shape(oldProjection(displayMessages)))
}

describe('projectMessageViewportGroups (old projection equivalence)', () => {
  it('reproduces the old projection for a latest window with multi-model groups and singletons', () => {
    const messages = [
      message('u0'),
      message('a0', 'assistant', 'ask1'),
      message('a1', 'assistant', 'ask1'),
      message('u1'),
      message('a2', 'assistant', 'ask2'),
      message('u2'),
      message('a3', 'assistant', 'ask2')
    ]
    const window = createLatestMessageWindow(messages, 3)

    expectProjectionEqualsOld(window.displayMessages, window.displayGroups)
  })

  it('reproduces the old projection for a full-topic latest window (all groups visible)', () => {
    const messages = [
      message('u0'),
      message('a0', 'assistant', 'ask0'),
      message('a1', 'assistant', 'ask0'),
      message('u1'),
      message('u2')
    ]
    const window = createLatestMessageWindow(messages, 10)

    expectProjectionEqualsOld(window.displayMessages, window.displayGroups)
  })

  it('reproduces the old projection for an all-singleton window', () => {
    const window = createLatestMessageWindow(
      Array.from({ length: 8 }, (_, i) => message(`m${i}`)),
      5
    )

    expectProjectionEqualsOld(window.displayMessages, window.displayGroups)
  })

  it('reproduces the old projection for an empty window', () => {
    const window = createLatestMessageWindow([], 3)

    expect(projectMessageViewportGroups(window.displayMessages, window.displayGroups)).toEqual([])
    expectProjectionEqualsOld(window.displayMessages, window.displayGroups)
  })

  it('reproduces the old projection for the oldest (fixed) window', () => {
    const messages = [
      message('u0'),
      message('a0', 'assistant', 'ask0'),
      message('a1', 'assistant', 'ask0'),
      message('u1'),
      message('a2', 'assistant', 'ask2'),
      message('u2'),
      message('u3')
    ]
    const window = createOldestMessageWindow(messages, 4)

    expectProjectionEqualsOld(window.displayMessages, window.displayGroups)
  })

  it('reproduces the old projection for a target-navigation window (interior slice)', () => {
    const messages = Array.from({ length: 30 }, (_, i) => message(`m${i}`))
    const window = createTargetMessageWindow(messages, 'm15', 4, 6)

    expectProjectionEqualsOld(window.displayMessages, window.displayGroups)
  })

  it('reproduces the old projection after expand-older and expand-newer', () => {
    const messages = Array.from({ length: 20 }, (_, i) => message(`m${i}`))
    const middle = createTargetMessageWindow(messages, 'm10', 2, 2)
    const older = expandMessageWindowOlder(messages, middle, 3)
    const newer = expandMessageWindowNewer(messages, older, 2)

    expectProjectionEqualsOld(older.displayMessages, older.displayGroups)
    expectProjectionEqualsOld(newer.displayMessages, newer.displayGroups)
  })

  it('reproduces the old projection after reconcile (latest edge following appended groups)', () => {
    const previous = Array.from({ length: 6 }, (_, i) => message(`m${i}`))
    const current = createLatestMessageWindow(previous, 3)
    const next = [...previous, message('m6'), message('m7')]
    const reconciled = reconcileMessageWindow(next, previous, current)

    expectProjectionEqualsOld(reconciled.displayMessages, reconciled.displayGroups)
  })

  it('reproduces the old projection after reconcile (fixed edge refreshing in place)', () => {
    const previous = Array.from({ length: 8 }, (_, i) => message(`m${i}`))
    const current = createTargetMessageWindow(previous, 'm3', 1, 1)
    const updatedTarget = { ...previous[3], createdAt: '2026-07-19T01:00:00.000Z' }
    const next = [...previous.slice(0, 3), updatedTarget, ...previous.slice(4), message('m8')]
    const reconciled = reconcileMessageWindow(next, previous, current)

    expectProjectionEqualsOld(reconciled.displayMessages, reconciled.displayGroups)
  })

  it('reproduces old non-adjacent repeated askId fragment keys with the display-index suffix', () => {
    // Chronological: u0, a0/a1 (ask0), u1, a2/a3 (ask0 again). The old grouping
    // kept the NEWEST ask0 run as the base group, gave the older run's first
    // message (a1) a `_${displayIndex}` group, and joined the older run's
    // remaining message (a0) back into the newest ask0 group.
    const messages = [
      message('u0'),
      message('a0', 'assistant', 'ask0'),
      message('a1', 'assistant', 'ask0'),
      message('u1'),
      message('a2', 'assistant', 'ask0'),
      message('a3', 'assistant', 'ask0')
    ]
    const window = createLatestMessageWindow(messages, 6)

    const threaded = projectMessageViewportGroups(window.displayMessages, window.displayGroups)
    const keys = threaded.map(([key]) => key)
    expect(keys).toEqual(['assistantask0', 'useru1', 'assistantask0_3', 'useru0'])
    // Exact message order and viewport-local index per group.
    expect(threaded.map(([key, groupMessages]) => [key, groupMessages.map(({ id, index }) => [id, index])])).toEqual([
      [
        'assistantask0',
        [
          ['a0', 4],
          ['a2', 1],
          ['a3', 0]
        ]
      ],
      ['useru1', [['u1', 2]]],
      ['assistantask0_3', [['a1', 3]]],
      ['useru0', [['u0', 5]]]
    ])
    expectProjectionEqualsOld(window.displayMessages, window.displayGroups)
  })

  it('joins the remaining messages of a later same-base run into the newest base group', () => {
    // Old grouping: the newest ask9 run is the base group; the older run's
    // first message (a2) opens `assistantask9_3` and a1/a0 rejoin the newest
    // group because their immediate predecessor shares the base key.
    const messages = [
      message('u0'),
      message('a0', 'assistant', 'ask9'),
      message('a1', 'assistant', 'ask9'),
      message('a2', 'assistant', 'ask9'),
      message('u1'),
      message('a3', 'assistant', 'ask9'),
      message('a4', 'assistant', 'ask9'),
      message('u2')
    ]
    const window = createLatestMessageWindow(messages, 8)

    const threaded = projectMessageViewportGroups(window.displayMessages, window.displayGroups)
    expect(threaded.map(([key, groupMessages]) => [key, groupMessages.map(({ id, index }) => [id, index])])).toEqual([
      ['useru2', [['u2', 0]]],
      [
        'assistantask9',
        [
          ['a0', 6],
          ['a1', 5],
          ['a3', 2],
          ['a4', 1]
        ]
      ],
      ['useru1', [['u1', 3]]],
      ['assistantask9_4', [['a2', 4]]],
      ['useru0', [['u0', 7]]]
    ])
    expectProjectionEqualsOld(window.displayMessages, window.displayGroups)
  })

  it('renders newest group first with oldest-first message order and viewport-local indices', () => {
    const messages = [
      message('u0'),
      message('a0', 'assistant', 'ask1'),
      message('a1', 'assistant', 'ask1'),
      message('u1')
    ]
    const window = createLatestMessageWindow(messages, 3)

    const projection = projectMessageViewportGroups(window.displayMessages, window.displayGroups)

    // Newest group first (u1 index 0, a1/a0 index 1/2, u0 index 3).
    expect(projection.map(([key]) => key)).toEqual(['useru1', 'assistantask1', 'useru0'])
    // Per-group message order is oldest-first (the reversed accumulation order).
    expect(projection[1][1].map(({ id }) => id)).toEqual(['a0', 'a1'])
    // Exact viewport-local indices: newest message is 0.
    expect(projection[0][1][0].index).toBe(0)
    expect(projection[1][1].map(({ index }) => index)).toEqual([2, 1])
  })

  it('keeps displayMessages untouched (no mutation, no reordering)', () => {
    const messages = [
      message('u0'),
      message('a0', 'assistant', 'ask1'),
      message('a1', 'assistant', 'ask1'),
      message('u1')
    ]
    const window = createLatestMessageWindow(messages, 3)
    const displayMessagesBefore = window.displayMessages.map((m) => m.id)

    projectMessageViewportGroups(window.displayMessages, window.displayGroups)

    expect(window.displayMessages.map((m) => m.id)).toEqual(displayMessagesBefore)
  })
})
