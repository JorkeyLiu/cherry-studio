import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import { createMessageViewportGroupModel, flattenMessageGroupRange, getMessageGroupById } from '../messageGroups'

const message = (id: string, role: Message['role'], askId?: string): Message => ({
  id,
  role,
  askId,
  assistantId: 'assistant',
  topicId: 'topic',
  createdAt: '2026-07-19T00:00:00.000Z',
  status: role === 'user' ? UserMessageStatus.SUCCESS : AssistantMessageStatus.SUCCESS,
  blocks: []
})

describe('createMessageViewportGroupModel', () => {
  it('keeps each user message in an independent visual group', () => {
    const model = createMessageViewportGroupModel([message('u1', 'user'), message('u2', 'user')])

    expect(model.groups.map((group) => group.messages.map(({ id }) => id))).toEqual([['u1'], ['u2']])
  })

  it('keeps consecutive multi-model assistant replies with the same askId together', () => {
    const model = createMessageViewportGroupModel([
      message('u1', 'user'),
      message('a1', 'assistant', 'u1'),
      message('a2', 'assistant', 'u1')
    ])

    expect(model.groups.map((group) => group.messages.map(({ id }) => id))).toEqual([['u1'], ['a1', 'a2']])
    expect(model.groups[1].range).toEqual({ start: 1, end: 2 })
  })

  it('keeps existing group keys stable when unrelated messages are prepended or appended', () => {
    const existing = [message('u1', 'user'), message('a1', 'assistant', 'u1'), message('a2', 'assistant', 'u1')]
    const original = createMessageViewportGroupModel(existing)
    const extended = createMessageViewportGroupModel([message('older', 'user'), ...existing, message('newer', 'user')])

    // Keys of the original groups must not change after prepending/appending
    expect(extended.groups[1].key).toBe(original.groups[0].key)
    expect(extended.groups[2].key).toBe(original.groups[1].key)
    // Range shifts with the new insertion positions
    expect(extended.groups[2].range).toEqual({ start: 2, end: 3 })
  })

  it('separates different, missing, empty, and non-consecutive askIds', () => {
    const model = createMessageViewportGroupModel([
      message('a1', 'assistant', 'ask-1'),
      message('a2', 'assistant', 'ask-2'),
      message('a3', 'assistant'),
      message('a4', 'assistant', ''),
      message('u1', 'user'),
      message('a5', 'assistant', 'ask-1')
    ])

    expect(model.groups.map((group) => group.messages.map(({ id }) => id))).toEqual([
      ['a1'],
      ['a2'],
      ['a3'],
      ['a4'],
      ['u1'],
      ['a5']
    ])
    // Non-consecutive groups sharing the same semanticKey must have distinct keys
    expect(model.groups[0].key).not.toBe(model.groups[5].key)
  })

  it('locates a target group and flattens bounded mixed group ranges', () => {
    const model = createMessageViewportGroupModel([
      message('u1', 'user'),
      message('a1', 'assistant', 'u1'),
      message('a2', 'assistant', 'u1'),
      message('u2', 'user'),
      message('a3', 'assistant', 'u2')
    ])

    expect(getMessageGroupById(model, 'a2')).toBe(model.groups[1])
    expect(model.messageIndexToGroup[2]).toBe(model.groups[1])
    expect(getMessageGroupById(model, 'missing')).toBeUndefined()
    expect(flattenMessageGroupRange(model, 1, 2).map(({ id }) => id)).toEqual(['a1', 'a2', 'u2'])
    expect(flattenMessageGroupRange(model, -2, 99).map(({ id }) => id)).toEqual(['u1', 'a1', 'a2', 'u2', 'a3'])
    expect(flattenMessageGroupRange(model, 3, 1)).toEqual([])
  })
})
