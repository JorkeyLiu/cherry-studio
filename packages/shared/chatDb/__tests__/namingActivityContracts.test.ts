import { describe, expect, it } from 'vitest'

import { validateChatDbRequest, validateChatDbResult } from '../index'

function namingValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    topic: { id: 't1', name: 'Topic', isNameManuallyEdited: false },
    messageCount: 2,
    firstMessage: { id: 'm1', blocks: ['b1'] },
    latestMessages: [
      { id: 'm1', blocks: ['b1'] },
      { id: 'm2', blocks: [] }
    ],
    blocks: [{ id: 'b1', messageId: 'm1' }],
    naming: {
      completeness: 'naming-context',
      topicId: 't1',
      firstMessageId: 'm1',
      lastMessageId: 'm2',
      returnedLatestCount: 2
    },
    ...overrides
  }
}

function activityValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageCount: 3,
    latestMessageId: 'm3',
    latestMessageCreatedAt: '2026-09-01T00:00:00.000Z',
    activity: { completeness: 'topic-activity', topicId: 't1' },
    ...overrides
  }
}

describe('bounded naming/activity contracts — exactness', () => {
  it('naming request accepts only { topicId }', () => {
    expect(() => validateChatDbRequest('chatdb:fetch-topic-naming-context', { topicId: 't1' })).not.toThrow()
    expect(() => validateChatDbRequest('chatdb:fetch-topic-naming-context', { topicId: '' })).toThrow()
    expect(() => validateChatDbRequest('chatdb:fetch-topic-naming-context', { topicId: 't1', extra: 1 })).toThrow()
  })

  it('activity request accepts only { topicId }', () => {
    expect(() => validateChatDbRequest('chatdb:fetch-topic-activity', { topicId: 't1' })).not.toThrow()
    expect(() => validateChatDbRequest('chatdb:fetch-topic-activity', { topicId: 't1', limit: 5 })).toThrow()
  })

  it('naming success validates strict discriminator and bounds', () => {
    expect(() =>
      validateChatDbResult('chatdb:fetch-topic-naming-context', { ok: true, value: namingValue() })
    ).not.toThrow()
  })

  it('naming rejects wrong completeness and oversized latest', () => {
    const wrong = namingValue({
      naming: {
        completeness: 'whole-topic',
        topicId: 't1',
        firstMessageId: 'm1',
        lastMessageId: 'm2',
        returnedLatestCount: 2
      }
    })
    expect(() => validateChatDbResult('chatdb:fetch-topic-naming-context', { ok: true, value: wrong })).toThrow()
    const oversized = namingValue({
      latestMessages: [1, 2, 3, 4, 5, 6].map((i) => ({ id: `m${i}` })),
      naming: {
        completeness: 'naming-context',
        topicId: 't1',
        firstMessageId: 'm1',
        lastMessageId: 'm6',
        returnedLatestCount: 6
      }
    })
    expect(() => validateChatDbResult('chatdb:fetch-topic-naming-context', { ok: true, value: oversized })).toThrow()
  })

  it('naming rejects returnedLatestCount mismatch and unknown keys', () => {
    const mismatch = namingValue({
      naming: {
        completeness: 'naming-context',
        topicId: 't1',
        firstMessageId: 'm1',
        lastMessageId: 'm2',
        returnedLatestCount: 1
      }
    })
    expect(() => validateChatDbResult('chatdb:fetch-topic-naming-context', { ok: true, value: mismatch })).toThrow()
    const unknown = namingValue({ extra: 1 })
    expect(() => validateChatDbResult('chatdb:fetch-topic-naming-context', { ok: true, value: unknown })).toThrow()
  })

  it('naming empty topic requires null bounds and empty arrays', () => {
    const empty = namingValue({
      messageCount: 0,
      firstMessage: null,
      latestMessages: [],
      blocks: [],
      naming: {
        completeness: 'naming-context',
        topicId: 't1',
        firstMessageId: null,
        lastMessageId: null,
        returnedLatestCount: 0
      }
    })
    expect(() => validateChatDbResult('chatdb:fetch-topic-naming-context', { ok: true, value: empty })).not.toThrow()
    const badEmpty = namingValue({
      messageCount: 0,
      firstMessage: null,
      latestMessages: [],
      blocks: [],
      naming: {
        completeness: 'naming-context',
        topicId: 't1',
        firstMessageId: 'm1',
        lastMessageId: null,
        returnedLatestCount: 0
      }
    })
    expect(() => validateChatDbResult('chatdb:fetch-topic-naming-context', { ok: true, value: badEmpty })).toThrow()
  })

  it('activity success validates discriminator and empty nulls', () => {
    expect(() =>
      validateChatDbResult('chatdb:fetch-topic-activity', { ok: true, value: activityValue() })
    ).not.toThrow()
    const empty = activityValue({ messageCount: 0, latestMessageId: null, latestMessageCreatedAt: null })
    expect(() => validateChatDbResult('chatdb:fetch-topic-activity', { ok: true, value: empty })).not.toThrow()
  })

  it('activity rejects wrong completeness, unknown keys, and non-empty null id', () => {
    const wrong = activityValue({ activity: { completeness: 'window', topicId: 't1' } })
    expect(() => validateChatDbResult('chatdb:fetch-topic-activity', { ok: true, value: wrong })).toThrow()
    const unknown = activityValue({ extra: 1 })
    expect(() => validateChatDbResult('chatdb:fetch-topic-activity', { ok: true, value: unknown })).toThrow()
    const badNonEmpty = activityValue({ latestMessageId: null })
    expect(() => validateChatDbResult('chatdb:fetch-topic-activity', { ok: true, value: badNonEmpty })).toThrow()
    const badEmpty = activityValue({ messageCount: 0, latestMessageId: 'm1', latestMessageCreatedAt: null })
    expect(() => validateChatDbResult('chatdb:fetch-topic-activity', { ok: true, value: badEmpty })).toThrow()
  })
})
