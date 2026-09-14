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

  it('validates FileCleanupResult response shape', () => {
    expect(() =>
      validateChatDbResult(CHANNEL, { ok: true, value: { affectedFileIds: [], remainingReferenceCounts: {} } })
    ).not.toThrow()
    expect(() => validateChatDbResult(CHANNEL, { ok: true, value: { affectedFileIds: [] } })).toThrow(ValidationError)
  })
})
