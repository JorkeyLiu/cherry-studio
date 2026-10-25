import { describe, expect, it } from 'vitest'

import { validateChatDbRequest, validateChatDbResult, ValidationError } from '../index'

const CHANNEL = 'chatdb:insert-message-groups' as const

function entry(messageId: string, blockId?: string) {
  return {
    message: { id: messageId, topicId: 't-1', role: 'user' },
    blocks: blockId ? [{ id: blockId, messageId }] : []
  }
}

describe('insert-message-groups request validation', () => {
  it('accepts each intent kind', () => {
    expect(() =>
      validateChatDbRequest(CHANNEL, {
        topicId: 't-1',
        groups: [{ entries: [entry('m-1')], intent: { kind: 'after-group-tail', messageId: 'a-1' } }]
      })
    ).not.toThrow()
    expect(() =>
      validateChatDbRequest(CHANNEL, {
        topicId: 't-1',
        groups: [{ entries: [entry('m-2')], intent: { kind: 'before-message', messageId: 'a-2' } }]
      })
    ).not.toThrow()
    expect(() =>
      validateChatDbRequest(CHANNEL, {
        topicId: 't-1',
        groups: [{ entries: [entry('m-3')], intent: { kind: 'topic-tail' } }]
      })
    ).not.toThrow()
  })

  it('rejects unknown top-level and group/intent keys', () => {
    expect(() =>
      validateChatDbRequest(CHANNEL, {
        topicId: 't-1',
        groups: [{ entries: [entry('m-1')], intent: { kind: 'topic-tail' } }],
        extra: 1
      })
    ).toThrow(ValidationError)
    expect(() =>
      validateChatDbRequest(CHANNEL, {
        topicId: 't-1',
        groups: [{ entries: [entry('m-1')], intent: { kind: 'topic-tail' }, extra: 1 }]
      })
    ).toThrow(ValidationError)
    expect(() =>
      validateChatDbRequest(CHANNEL, {
        topicId: 't-1',
        groups: [{ entries: [entry('m-1')], intent: { kind: 'topic-tail', messageId: 'x' } }]
      })
    ).toThrow(ValidationError)
  })

  it('rejects missing fields and empty IDs/groups/entries', () => {
    expect(() => validateChatDbRequest(CHANNEL, { groups: [] })).toThrow(ValidationError)
    expect(() => validateChatDbRequest(CHANNEL, { topicId: '', groups: [] })).toThrow(ValidationError)
    expect(() => validateChatDbRequest(CHANNEL, { topicId: 't-1', groups: [] })).toThrow(ValidationError)
    expect(() =>
      validateChatDbRequest(CHANNEL, { topicId: 't-1', groups: [{ intent: { kind: 'topic-tail' } }] })
    ).toThrow(ValidationError)
    expect(() =>
      validateChatDbRequest(CHANNEL, {
        topicId: 't-1',
        groups: [{ entries: [] as never[], intent: { kind: 'topic-tail' } }]
      })
    ).toThrow(ValidationError)
    expect(() =>
      validateChatDbRequest(CHANNEL, {
        topicId: 't-1',
        groups: [{ entries: [entry('m-1')], intent: { kind: 'before-message', messageId: '' } }]
      })
    ).toThrow(ValidationError)
    expect(() =>
      validateChatDbRequest(CHANNEL, {
        topicId: 't-1',
        groups: [{ entries: [entry('m-1')], intent: { kind: 'after-group-tail' } }]
      })
    ).toThrow(ValidationError)
  })

  it('rejects duplicate message IDs across groups', () => {
    expect(() =>
      validateChatDbRequest(CHANNEL, {
        topicId: 't-1',
        groups: [
          { entries: [entry('m-dup')], intent: { kind: 'topic-tail' } },
          { entries: [entry('m-dup')], intent: { kind: 'topic-tail' } }
        ]
      })
    ).toThrow(ValidationError)
  })

  it('validates batch insertion acknowledgment response shape', () => {
    const good = {
      affectedFileIds: [],
      remainingReferenceCounts: {},
      topicId: 't-1',
      branchId: null,
      insertedMessages: [{ id: 'm-1', topicId: 't-1' }],
      insertedBlocks: [],
      insertedMessageIds: ['m-1'],
      mutableMessageIds: ['m-1'],
      groups: [{ insertedMessageIds: ['m-1'], beforeMessageId: null, nextMessageId: null }]
    }
    expect(() => validateChatDbResult(CHANNEL, { ok: true, value: good })).not.toThrow()
    expect(() => validateChatDbResult(CHANNEL, { ok: true, value: { affectedFileIds: [] } })).toThrow(ValidationError)
    // Mutable ids must be a subset of inserted ids.
    expect(() => validateChatDbResult(CHANNEL, { ok: true, value: { ...good, mutableMessageIds: ['ghost'] } })).toThrow(
      ValidationError
    )
    // Flat ids must match wires in order.
    expect(() =>
      validateChatDbResult(CHANNEL, { ok: true, value: { ...good, insertedMessageIds: ['other'] } })
    ).toThrow(ValidationError)
    // Group runs must concatenate to the flat ids in order.
    expect(() =>
      validateChatDbResult(CHANNEL, {
        ok: true,
        value: { ...good, groups: [{ insertedMessageIds: ['other'], beforeMessageId: null, nextMessageId: null }] }
      })
    ).toThrow(ValidationError)
  })
})
