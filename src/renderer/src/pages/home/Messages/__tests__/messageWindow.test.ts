import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

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

const users = (count: number): Message[] => Array.from({ length: count }, (_, index) => message(`m${index}`))
const ids = (window: { displayMessages: Message[] }) => window.displayMessages.map(({ id }) => id)

describe('messageWindow', () => {
  it('initializes the latest group window with derived boundaries', () => {
    const window = createLatestMessageWindow(users(8), 3)

    expect(ids(window)).toEqual(['m7', 'm6', 'm5'])
    expect(window.range).toEqual({ oldestGroupIndex: 5, newestGroupIndex: 7 })
    expect(window.groupCapacity).toBe(3)
    expect(window.groupCount).toBe(3)
    expect(window.oldestMessageId).toBe('m5')
    expect(window.newestMessageId).toBe('m7')
    expect(window.hasMoreOlder).toBe(true)
    expect(window.hasMoreNewer).toBe(false)
  })

  it('initializes the oldest group window anchored at the first groups', () => {
    const window = createOldestMessageWindow(users(8), 3)

    expect(ids(window)).toEqual(['m2', 'm1', 'm0'])
    expect(window.range).toEqual({ oldestGroupIndex: 0, newestGroupIndex: 2 })
    expect(window.edge).toBe('fixed')
    expect(window.groupCapacity).toBe(3)
    expect(window.groupCount).toBe(3)
    expect(window.oldestMessageId).toBe('m0')
    expect(window.newestMessageId).toBe('m2')
    expect(window.hasMoreOlder).toBe(false)
    expect(window.hasMoreNewer).toBe(true)
  })

  it('oldest window returns empty when no messages exist', () => {
    const window = createOldestMessageWindow([], 3)

    expect(window.displayMessages).toEqual([])
    expect(window.range).toBeNull()
    expect(window.edge).toBe('fixed')
  })

  it('places an interior target with 10 visually older and 19 visually newer groups', () => {
    const window = createTargetMessageWindow(users(50), 'm20', 10, 19)

    expect(window.range).toEqual({ oldestGroupIndex: 10, newestGroupIndex: 39 })
    expect(window.groupCount).toBe(30)
    expect(ids(window).indexOf('m20')).toBe(19)
    expect(window.hasMoreOlder).toBe(true)
    expect(window.hasMoreNewer).toBe(true)
  })

  it('fills a missing target quota from the opposite edge at both ends', () => {
    expect(createTargetMessageWindow(users(40), 'm3', 10, 19).range).toEqual({
      oldestGroupIndex: 0,
      newestGroupIndex: 29
    })
    expect(createTargetMessageWindow(users(40), 'm37', 10, 19).range).toEqual({
      oldestGroupIndex: 10,
      newestGroupIndex: 39
    })
  })

  it('never splits a multi-model assistant group', () => {
    const messages = [
      message('u0'),
      message('a0', 'assistant', 'ask'),
      message('a1', 'assistant', 'ask'),
      message('u1'),
      message('u2')
    ]

    expect(ids(createLatestMessageWindow(messages, 3))).toEqual(['u2', 'u1', 'a1', 'a0'])
    expect(ids(createTargetMessageWindow(messages, 'a0', 0, 0))).toEqual(['a1', 'a0'])
  })

  it('extends older and newer in group-sized batches', () => {
    const messages = users(10)
    const middle = createTargetMessageWindow(messages, 'm5', 1, 1)
    const older = expandMessageWindowOlder(messages, middle, 2)
    const newer = expandMessageWindowNewer(messages, older, 3)

    expect(older.range).toEqual({ oldestGroupIndex: 2, newestGroupIndex: 6 })
    expect(older.groupCount).toBe(5)
    expect(newer.range).toEqual({ oldestGroupIndex: 2, newestGroupIndex: 9 })
    expect(newer.groupCount).toBe(8)
    expect(newer.hasMoreOlder).toBe(true)
    expect(newer.hasMoreNewer).toBe(false)
  })

  it('keeps capacity and follows appended groups when reconciling a latest window', () => {
    const previous = users(6)
    const current = createLatestMessageWindow(previous, 3)
    const next = [...previous, message('m6'), message('m7')]
    const reconciled = reconcileMessageWindow(next, previous, current)

    expect(ids(reconciled)).toEqual(['m7', 'm6', 'm5'])
    expect(reconciled.groupCapacity).toBe(3)
    expect(reconciled.groupCount).toBe(3)
    expect(reconciled.hasMoreOlder).toBe(true)
    expect(reconciled.hasMoreNewer).toBe(false)
  })

  it('refreshes a historical range without following appended groups', () => {
    const previous = users(8)
    const current = createTargetMessageWindow(previous, 'm3', 1, 1)
    const updatedTarget = { ...previous[3], createdAt: '2026-07-19T01:00:00.000Z' }
    const next = [...previous.slice(0, 3), updatedTarget, ...previous.slice(4), message('m8')]
    const reconciled = reconcileMessageWindow(next, previous, current)

    expect(ids(reconciled)).toEqual(ids(current))
    expect(reconciled.displayMessages.find(({ id }) => id === 'm3')).toBe(updatedTarget)
    expect(reconciled.hasMoreOlder).toBe(true)
    expect(reconciled.hasMoreNewer).toBe(true)
  })

  it('uses the same target helper result for saved restore and ordinary navigation', () => {
    const messages = users(45)
    const savedRestore = createTargetMessageWindow(messages, 'm22', 10, 19)
    const ordinaryNavigation = createTargetMessageWindow(messages, 'm22', 10, 19)

    expect(ordinaryNavigation).toEqual(savedRestore)
  })

  it('grows an unsaturated latest window without losing its capacity', () => {
    const initial = users(1)
    let window = createLatestMessageWindow(initial, 3)
    const twoGroups = [...initial, message('m1')]

    window = reconcileMessageWindow(twoGroups, initial, window)
    expect(ids(window)).toEqual(['m1', 'm0'])
    expect(window.groupCapacity).toBe(3)

    const threeGroups = [...twoGroups, message('m2')]
    window = reconcileMessageWindow(threeGroups, twoGroups, window)
    expect(ids(window)).toEqual(['m2', 'm1', 'm0'])
    expect(window.groupCapacity).toBe(3)
  })

  it('grows an unsaturated target window without following the latest edge', () => {
    const previous = users(2)
    const current = createTargetMessageWindow(previous, 'm0', 1, 2)
    const next = [...previous, message('m2'), message('m3')]
    const reconciled = reconcileMessageWindow(next, previous, current)

    expect(ids(reconciled)).toEqual(['m3', 'm2', 'm1', 'm0'])
    expect(reconciled.groupCapacity).toBe(4)
    expect(reconciled.edge).toBe('fixed')

    const appended = [...next, message('m4')]
    const reconciledAgain = reconcileMessageWindow(appended, next, reconciled)
    expect(ids(reconciledAgain)).toEqual(['m3', 'm2', 'm1', 'm0'])
    expect(reconciledAgain.hasMoreNewer).toBe(true)
  })

  describe('displayGroups (Phase 2B)', () => {
    it('createLatestMessageWindow populates displayGroups matching the sliced groups', () => {
      const messages = [
        message('u0'),
        message('a0', 'assistant', 'ask'),
        message('a1', 'assistant', 'ask'),
        message('u1'),
        message('u2')
      ]
      const window = createLatestMessageWindow(messages, 2)

      // displayGroups should contain the sliced viewport groups
      expect(window.displayGroups.length).toBe(window.groupCount)
      // Each group's messages should flatten to the same IDs as displayMessages (reversed)
      const flattenedGroupIds = window.displayGroups
        .flatMap((g) => g.messages)
        .map((m) => m.id)
        .reverse()
      expect(flattenedGroupIds).toEqual(ids(window))
    })

    it('empty window carries an empty displayGroups array', () => {
      const window = createLatestMessageWindow([], 3)
      expect(window.displayGroups).toEqual([])
      expect(window.displayMessages).toEqual([])
    })

    it('createOldestMessageWindow populates displayGroups consistently', () => {
      const window = createOldestMessageWindow(users(8), 3)
      expect(window.displayGroups.length).toBe(3)
      const flattenedGroupIds = window.displayGroups
        .flatMap((g) => g.messages)
        .map((m) => m.id)
        .reverse()
      expect(flattenedGroupIds).toEqual(ids(window))
    })

    it('createTargetMessageWindow populates displayGroups for target navigation', () => {
      const window = createTargetMessageWindow(users(50), 'm20', 10, 19)
      expect(window.displayGroups.length).toBe(window.groupCount)
      const flattenedGroupIds = window.displayGroups
        .flatMap((g) => g.messages)
        .map((m) => m.id)
        .reverse()
      expect(flattenedGroupIds).toEqual(ids(window))
    })

    it('expandMessageWindowOlder populates displayGroups with expanded range', () => {
      const messages = users(10)
      const middle = createTargetMessageWindow(messages, 'm5', 1, 1)
      const older = expandMessageWindowOlder(messages, middle, 2)
      expect(older.displayGroups.length).toBe(older.groupCount)
      const flattenedGroupIds = older.displayGroups
        .flatMap((g) => g.messages)
        .map((m) => m.id)
        .reverse()
      expect(flattenedGroupIds).toEqual(ids(older))
    })

    it('expandMessageWindowNewer populates displayGroups with expanded range', () => {
      const messages = users(10)
      const middle = createTargetMessageWindow(messages, 'm5', 1, 1)
      const newer = expandMessageWindowNewer(messages, middle, 2)
      expect(newer.displayGroups.length).toBe(newer.groupCount)
      const flattenedGroupIds = newer.displayGroups
        .flatMap((g) => g.messages)
        .map((m) => m.id)
        .reverse()
      expect(flattenedGroupIds).toEqual(ids(newer))
    })

    it('reconcileMessageWindow populates displayGroups for latest edge', () => {
      const previous = users(6)
      const current = createLatestMessageWindow(previous, 3)
      const next = [...previous, message('m6'), message('m7')]
      const reconciled = reconcileMessageWindow(next, previous, current)
      expect(reconciled.displayGroups.length).toBe(reconciled.groupCount)
      const flattenedGroupIds = reconciled.displayGroups
        .flatMap((g) => g.messages)
        .map((m) => m.id)
        .reverse()
      expect(flattenedGroupIds).toEqual(ids(reconciled))
    })

    it('reconcileMessageWindow populates displayGroups for fixed edge', () => {
      const previous = users(8)
      const current = createTargetMessageWindow(previous, 'm3', 1, 1)
      const next = [
        ...previous.slice(0, 3),
        { ...previous[3], createdAt: '2026-07-19T01:00:00.000Z' },
        ...previous.slice(4),
        message('m8')
      ]
      const reconciled = reconcileMessageWindow(next, previous, current)
      expect(reconciled.displayGroups.length).toBe(reconciled.groupCount)
      const flattenedGroupIds = reconciled.displayGroups
        .flatMap((g) => g.messages)
        .map((m) => m.id)
        .reverse()
      expect(flattenedGroupIds).toEqual(ids(reconciled))
    })

    it('group keys in displayGroups are stable across window operations', () => {
      const messages = [
        message('u0'),
        message('a0', 'assistant', 'ask'),
        message('a1', 'assistant', 'ask'),
        message('u1'),
        message('a2', 'assistant', 'ask2'),
        message('u2')
      ]
      const latest = createLatestMessageWindow(messages, 3)
      const expanded = expandMessageWindowOlder(messages, latest, 1)

      // Group keys for overlapping messages should be the same
      const latestKeys = new Set(latest.displayGroups.map((g) => g.key))
      const expandedKeys = new Set(expanded.displayGroups.map((g) => g.key))
      for (const key of latestKeys) {
        expect(expandedKeys.has(key)).toBe(true)
      }
    })
  })
})
