import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

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

/** Helper to extract comparable shape (keys + ids + indexes). */
const shape = (projection: MessageViewportProjectedGroup[]) =>
  projection.map(([key, groupMessages]) => ({
    key,
    messageIds: groupMessages.map(({ id }) => id),
    indexes: groupMessages.map(({ index }) => index)
  }))

describe('projectMessageViewportGroups (canonical viewport groups)', () => {
  it('preserves canonical one-to-one groups for a latest window with multi-model groups and singletons', () => {
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
    const projection = projectMessageViewportGroups(window.displayMessages, window.displayGroups)

    // displayGroups chronological: [a0,a1]=ask1, [u1], [a2? wait capacity 3 => last 3 groups: a2? Actually groups are [u0],[a0,a1],[u1],[a2],[u2],[a3]??? Let's just check shape against displayGroups
    expect(projection.length).toBe(window.displayGroups.length)
    // Newest group first
    expect(projection[0][0]).toBe(window.displayGroups.at(-1)!.key)
    expect(projection.at(-1)![0]).toBe(window.displayGroups[0].key)
    // Per-group oldest-first
    for (const [key, msgs] of projection) {
      const canonical = window.displayGroups.find((g) => g.key === key)!
      expect(msgs.map((m) => m.id)).toEqual(canonical.messages.map((m) => m.id))
    }
  })

  it('produces one-to-one groups for a full-topic latest window (all groups visible)', () => {
    const messages = [
      message('u0'),
      message('a0', 'assistant', 'ask0'),
      message('a1', 'assistant', 'ask0'),
      message('u1'),
      message('u2')
    ]
    const window = createLatestMessageWindow(messages, 10)
    const projection = projectMessageViewportGroups(window.displayMessages, window.displayGroups)

    expect(projection.length).toBe(window.displayGroups.length)
    // newest-first outer order
    expect(projection.map(([k]) => k)).toEqual(window.displayGroups.map((g) => g.key).reverse())
    // each group's messages oldest-first with viewport index
    projection.forEach(([key, msgs]) => {
      const canonical = window.displayGroups.find((g) => g.key === key)!
      expect(msgs.map((m) => m.id)).toEqual(canonical.messages.map((m) => m.id))
    })
  })

  it('produces one-to-one groups for an all-singleton window', () => {
    const window = createLatestMessageWindow(
      Array.from({ length: 8 }, (_, i) => message(`m${i}`)),
      5
    )
    const projection = projectMessageViewportGroups(window.displayMessages, window.displayGroups)
    expect(projection.length).toBe(5)
    expect(projection.map(([k]) => k)).toEqual(window.displayGroups.map((g) => g.key).reverse())
    projection.forEach(([key, msgs]) => {
      expect(msgs).toHaveLength(1)
      const canonical = window.displayGroups.find((g) => g.key === key)!
      expect(msgs[0].id).toBe(canonical.messages[0].id)
    })
  })

  it('produces empty projection for an empty window', () => {
    const window = createLatestMessageWindow([], 3)
    expect(projectMessageViewportGroups(window.displayMessages, window.displayGroups)).toEqual([])
  })

  it('preserves canonical groups for the oldest (fixed) window', () => {
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
    const projection = projectMessageViewportGroups(window.displayMessages, window.displayGroups)
    expect(projection.length).toBe(window.displayGroups.length)
    expect(projection.map(([k]) => k)).toEqual(window.displayGroups.map((g) => g.key).reverse())
  })

  it('preserves canonical groups for a target-navigation window (interior slice)', () => {
    const messages = Array.from({ length: 30 }, (_, i) => message(`m${i}`))
    const window = createTargetMessageWindow(messages, 'm15', 4, 6)
    const projection = projectMessageViewportGroups(window.displayMessages, window.displayGroups)
    expect(projection.length).toBe(window.displayGroups.length)
    expect(projection.map(([k]) => k)).toEqual(window.displayGroups.map((g) => g.key).reverse())
  })

  it('preserves canonical groups after expand-older and expand-newer', () => {
    const messages = Array.from({ length: 20 }, (_, i) => message(`m${i}`))
    const middle = createTargetMessageWindow(messages, 'm10', 2, 2)
    const older = expandMessageWindowOlder(messages, middle, 3)
    const newer = expandMessageWindowNewer(messages, older, 2)

    for (const w of [older, newer]) {
      const projection = projectMessageViewportGroups(w.displayMessages, w.displayGroups)
      expect(projection.length).toBe(w.displayGroups.length)
      expect(projection.map(([k]) => k)).toEqual(w.displayGroups.map((g) => g.key).reverse())
    }
  })

  it('preserves canonical groups after reconcile (latest edge following appended groups)', () => {
    const previous = Array.from({ length: 6 }, (_, i) => message(`m${i}`))
    const current = createLatestMessageWindow(previous, 3)
    const next = [...previous, message('m6'), message('m7')]
    const reconciled = reconcileMessageWindow(next, previous, current)
    const projection = projectMessageViewportGroups(reconciled.displayMessages, reconciled.displayGroups)
    expect(projection.length).toBe(reconciled.displayGroups.length)
    expect(projection.map(([k]) => k)).toEqual(reconciled.displayGroups.map((g) => g.key).reverse())
  })

  it('preserves canonical groups after reconcile (fixed edge refreshing in place)', () => {
    const previous = Array.from({ length: 8 }, (_, i) => message(`m${i}`))
    const current = createTargetMessageWindow(previous, 'm3', 1, 1)
    const updatedTarget = { ...previous[3], createdAt: '2026-07-19T01:00:00.000Z' }
    const next = [...previous.slice(0, 3), updatedTarget, ...previous.slice(4), message('m8')]
    const reconciled = reconcileMessageWindow(next, previous, current)
    const projection = projectMessageViewportGroups(reconciled.displayMessages, reconciled.displayGroups)
    expect(projection.length).toBe(reconciled.displayGroups.length)
    expect(projection.map(([k]) => k)).toEqual(reconciled.displayGroups.map((g) => g.key).reverse())
  })

  it('keeps repeated non-consecutive askId runs as separate canonical groups (no merge/split)', () => {
    // Chronological: u0, a0/a1 (ask0), u1, a2/a3 (ask0 again). Canonical groups: [u0],[a0,a1],[u1],[a2,a3]
    const messages = [
      message('u0'),
      message('a0', 'assistant', 'ask0'),
      message('a1', 'assistant', 'ask0'),
      message('u1'),
      message('a2', 'assistant', 'ask0'),
      message('a3', 'assistant', 'ask0')
    ]
    const window = createLatestMessageWindow(messages, 10)
    // Verify displayGroups is canonical (4 groups, two distinct ask0 runs)
    expect(window.displayGroups.map((g) => g.messages.map((m) => m.id))).toEqual([
      ['u0'],
      ['a0', 'a1'],
      ['u1'],
      ['a2', 'a3']
    ])
    expect(window.displayGroups[1].key).not.toBe(window.displayGroups[3].key)

    const projection = projectMessageViewportGroups(window.displayMessages, window.displayGroups)
    // One-to-one: 4 groups, newest first, no merging
    expect(projection.length).toBe(4)
    expect(projection.map(([k]) => k)).toEqual(window.displayGroups.map((g) => g.key).reverse())
    expect(shape(projection)).toEqual([
      { key: window.displayGroups[3].key, messageIds: ['a2', 'a3'], indexes: [1, 0] },
      { key: window.displayGroups[2].key, messageIds: ['u1'], indexes: [2] },
      { key: window.displayGroups[1].key, messageIds: ['a0', 'a1'], indexes: [4, 3] },
      { key: window.displayGroups[0].key, messageIds: ['u0'], indexes: [5] }
    ])
    // Ensure per-run membership complete (no split of a0/a1 and no merge of a0 into a2/a3)
    const ask0Groups = projection.filter(([, msgs]) => msgs[0].askId === 'ask0')
    expect(ask0Groups).toHaveLength(2)
    expect(ask0Groups[0][1].map((m) => m.id)).toEqual(['a2', 'a3'])
    expect(ask0Groups[1][1].map((m) => m.id)).toEqual(['a0', 'a1'])
  })

  it('keeps a later repeated multi-message askId run separate with complete per-run membership', () => {
    // Chronological: u0, a0/a1/a2 (ask9), u1, a3/a4 (ask9 again), u2
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
    const window = createLatestMessageWindow(messages, 10)
    expect(window.displayGroups.map((g) => g.messages.map((m) => m.id))).toEqual([
      ['u0'],
      ['a0', 'a1', 'a2'],
      ['u1'],
      ['a3', 'a4'],
      ['u2']
    ])
    const projection = projectMessageViewportGroups(window.displayMessages, window.displayGroups)
    expect(projection.length).toBe(5)
    expect(projection.map(([k]) => k)).toEqual(window.displayGroups.map((g) => g.key).reverse())
    // Newest-first: u2, a3/a4, u1, a0/a1/a2, u0
    expect(shape(projection)).toEqual([
      { key: window.displayGroups[4].key, messageIds: ['u2'], indexes: [0] },
      { key: window.displayGroups[3].key, messageIds: ['a3', 'a4'], indexes: [2, 1] },
      { key: window.displayGroups[2].key, messageIds: ['u1'], indexes: [3] },
      { key: window.displayGroups[1].key, messageIds: ['a0', 'a1', 'a2'], indexes: [6, 5, 4] },
      { key: window.displayGroups[0].key, messageIds: ['u0'], indexes: [7] }
    ])
    const ask9Groups = projection.filter(([, msgs]) => msgs[0].askId === 'ask9')
    expect(ask9Groups).toHaveLength(2)
    expect(ask9Groups[0][1]).toHaveLength(2)
    expect(ask9Groups[1][1]).toHaveLength(3)
  })

  it('repeated multi-message askId topology when window is limited to newest groups retains newest run fully', () => {
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
    // capacity 2 => newest 2 groups: [a3,a4], [u2]
    const window = createLatestMessageWindow(messages, 2)
    expect(window.displayGroups.map((g) => g.messages.map((m) => m.id))).toEqual([['a3', 'a4'], ['u2']])
    const projection = projectMessageViewportGroups(window.displayMessages, window.displayGroups)
    expect(projection.map(([, msgs]) => msgs.map((m) => m.id))).toEqual([['u2'], ['a3', 'a4']])
    // indexes are viewport-local
    expect(projection[0][1][0].index).toBe(0)
    expect(projection[1][1].map((m) => m.index)).toEqual([2, 1])
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
    expect(projection.map(([, msgs]) => msgs.map((m) => m.id))).toEqual([['u1'], ['a0', 'a1'], ['u0']])
    // Per-group message order is oldest-first.
    expect(projection[1][1].map(({ id }) => id)).toEqual(['a0', 'a1'])
    // Exact viewport-local indices: newest message is 0.
    expect(projection[0][1][0].index).toBe(0)
    expect(projection[1][1].map(({ index }) => index)).toEqual([2, 1])
    // Keys are canonical.
    expect(projection.map(([k]) => k)).toEqual(window.displayGroups.map((g) => g.key).reverse())
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
    const displayGroupsBefore = window.displayGroups.map((g) => g.key)

    projectMessageViewportGroups(window.displayMessages, window.displayGroups)

    expect(window.displayMessages.map((m) => m.id)).toEqual(displayMessagesBefore)
    expect(window.displayGroups.map((g) => g.key)).toEqual(displayGroupsBefore)
  })

  it('output shape uses canonical group.key and does not merge across non-adjacent runs', () => {
    const messages = [
      message('u0'),
      message('a0', 'assistant', 'askX'),
      message('a1', 'assistant', 'askX'),
      message('u1'),
      message('a2', 'assistant', 'askX'),
      message('a3', 'assistant', 'askX')
    ]
    const window = createLatestMessageWindow(messages, 10)
    const projection = projectMessageViewportGroups(window.displayMessages, window.displayGroups)
    // Keys are exactly canonical keys, no suffix merging
    expect(projection.map(([k]) => k)).toEqual(window.displayGroups.map((g) => g.key).reverse())
    projection.forEach(([key]) => {
      expect(key).not.toMatch(/_\d+$/)
      expect(key).toMatch(/^(assistant:askX:|message:user:)/)
    })
  })
})
