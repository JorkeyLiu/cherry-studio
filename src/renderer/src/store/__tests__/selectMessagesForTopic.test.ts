import type { Message } from '@renderer/types/newMessage'
import { UserMessageStatus } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import type { RootState } from '../index'
import { selectMessagesForTopic } from '../newMessage'

function makeMessage(overrides: Partial<Message> & { id: string }): Message {
  return {
    role: 'user',
    assistantId: 'assistant-1',
    topicId: 'topic-1',
    createdAt: '2025-01-01T00:00:00Z',
    status: UserMessageStatus.SUCCESS,
    blocks: [],
    ...overrides
  }
}

function makeState(entities: Record<string, Message>, messageIdsByTopic: Record<string, string[]>): RootState {
  return {
    messages: {
      ids: Object.keys(entities),
      entities,
      messageIdsByTopic,
      currentTopicId: null,
      loadingByTopic: {},
      fulfilledByTopic: {},
      displayCount: 10
    }
  } as unknown as RootState
}

describe('selectMessagesForTopic', () => {
  it('returns the same reference when inputs have not changed', () => {
    const msg1 = makeMessage({ id: 'msg-1' })
    const msg2 = makeMessage({ id: 'msg-2', role: 'assistant', topicId: 'topic-1' })

    const state = makeState({ 'msg-1': msg1, 'msg-2': msg2 }, { 'topic-1': ['msg-1', 'msg-2'] })

    const first = selectMessagesForTopic(state, 'topic-1')
    const second = selectMessagesForTopic(state, 'topic-1')

    // Same call with same state → must return the exact same reference
    expect(first).toBe(second)
    expect(first).toHaveLength(2)
  })

  it('returns the same reference when a different topic is affected', () => {
    const msg1 = makeMessage({ id: 'msg-1', topicId: 'topic-1' })
    const msg2 = makeMessage({ id: 'msg-2', role: 'assistant', topicId: 'topic-2' })
    const msg3 = makeMessage({ id: 'msg-3', topicId: 'topic-2' })

    const state = makeState(
      { 'msg-1': msg1, 'msg-2': msg2, 'msg-3': msg3 },
      { 'topic-1': ['msg-1'], 'topic-2': ['msg-2', 'msg-3'] }
    )

    const first = selectMessagesForTopic(state, 'topic-1')

    // Simulate an update to a message in topic-2 — creates a new entities reference
    const updatedMsg3 = { ...msg3, updatedAt: '2025-06-01T00:00:00Z' }
    const newState = makeState(
      { 'msg-1': msg1, 'msg-2': msg2, 'msg-3': updatedMsg3 },
      { 'topic-1': ['msg-1'], 'topic-2': ['msg-2', 'msg-3'] }
    )

    const second = selectMessagesForTopic(newState, 'topic-1')

    // topic-1 messages didn't change → should return the same reference
    expect(first).toBe(second)
  })

  it('returns a new reference when a message in the topic changes', () => {
    const msg1 = makeMessage({ id: 'msg-1' })
    const msg2 = makeMessage({ id: 'msg-2', role: 'assistant', topicId: 'topic-1' })

    const state = makeState({ 'msg-1': msg1, 'msg-2': msg2 }, { 'topic-1': ['msg-1', 'msg-2'] })

    const first = selectMessagesForTopic(state, 'topic-1')

    // Update msg2 — different entity reference
    const updatedMsg2 = { ...msg2, updatedAt: '2025-06-01T00:00:00Z' }
    const newState = makeState({ 'msg-1': msg1, 'msg-2': updatedMsg2 }, { 'topic-1': ['msg-1', 'msg-2'] })

    const second = selectMessagesForTopic(newState, 'topic-1')

    // msg2 in topic-1 changed → must return a new reference
    expect(first).not.toBe(second)
    expect(second).toHaveLength(2)
  })

  it('returns an empty array for a nonexistent topic', () => {
    const state = makeState({}, {})
    const result = selectMessagesForTopic(state, 'nonexistent')
    expect(result).toEqual([])
  })
})
