/**
 * newMessages.updateManyMessages — PERF-100 plural foldSelected commit.
 *
 * Verifies:
 *  1. ONE reducer action commits every patch via the adapter's `updateMany`
 *     (single state transition / single store notification).
 *  2. Message order/IDs are preserved.
 *  3. Existing entities keep untouched fields.
 *  4. Unknown message IDs are skipped (defensive), known ones updated.
 */

import { describe, expect, it } from 'vitest'

import reducer, { newMessagesActions } from '../newMessage'

interface MessageLike {
  id: string
  role?: string
  askId?: string
  foldSelected?: boolean
  status?: string
  blocks?: string[]
}

function makeMessage(id: string, overrides: Partial<MessageLike> = {}): MessageLike {
  return { id, role: 'assistant', askId: 'ask-1', foldSelected: false, status: 'success', blocks: [], ...overrides }
}

function seedState(messages: MessageLike[]) {
  const topicId = 'topic-1'
  let state = reducer(undefined, { type: '@@INIT' })
  state = reducer(
    state,
    newMessagesActions.messagesReceived({
      topicId,
      messages: messages as never
    })
  )
  return { state, topicId }
}

describe('newMessages.updateManyMessages (PERF-100)', () => {
  it('commits every foldSelected patch in ONE reducer action while preserving order/IDs', () => {
    const { state, topicId } = seedState([
      makeMessage('a-1', { foldSelected: true }),
      makeMessage('a-2', { foldSelected: false }),
      makeMessage('a-3', { foldSelected: false })
    ])

    const next = reducer(
      state,
      newMessagesActions.updateManyMessages({
        topicId,
        updates: [
          { messageId: 'a-1', updates: { foldSelected: false } },
          { messageId: 'a-2', updates: { foldSelected: true } },
          { messageId: 'a-3', updates: { foldSelected: false } }
        ]
      })
    )

    // Single adapter updateMany: all patches land in one reducer pass.
    expect(next.entities['a-1']?.foldSelected).toBe(false)
    expect(next.entities['a-2']?.foldSelected).toBe(true)
    expect(next.entities['a-3']?.foldSelected).toBe(false)
    // Exactly one selected.
    const selected = Object.values(next.entities).filter((m) => (m as MessageLike)?.foldSelected === true)
    expect(selected).toHaveLength(1)
    // Order/IDs preserved.
    expect(next.messageIdsByTopic[topicId]).toEqual(['a-1', 'a-2', 'a-3'])
  })

  it('preserves untouched fields on updated entities', () => {
    const { state, topicId } = seedState([
      makeMessage('a-1', { status: 'success', blocks: ['b-1'] }),
      makeMessage('a-2', { status: 'processing', blocks: ['b-2'] })
    ])

    const next = reducer(
      state,
      newMessagesActions.updateManyMessages({
        topicId,
        updates: [{ messageId: 'a-2', updates: { foldSelected: true } }]
      })
    )

    expect(next.entities['a-2']?.status).toBe('processing')
    expect(next.entities['a-2']?.blocks).toEqual(['b-2'])
    expect(next.entities['a-2']?.foldSelected).toBe(true)
    // Unrelated entity untouched.
    expect(next.entities['a-1']?.status).toBe('success')
    expect(next.entities['a-1']?.foldSelected).toBe(false)
  })

  it('skips unknown message IDs without throwing', () => {
    const { state, topicId } = seedState([makeMessage('a-1')])

    const next = reducer(
      state,
      newMessagesActions.updateManyMessages({
        topicId,
        updates: [
          { messageId: 'missing-1', updates: { foldSelected: true } },
          { messageId: 'a-1', updates: { foldSelected: true } }
        ]
      })
    )

    expect(next.entities['a-1']?.foldSelected).toBe(true)
    expect(next.entities['missing-1']).toBeUndefined()
  })
})
