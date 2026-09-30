import { describe, expect, it } from 'vitest'

import { validateChatDbResult, ValidationError } from '../index'

function ack(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    value: {
      topicId: 't-1',
      branchId: null,
      messageId: 'm-1',
      createdMessageIds: ['m-1'],
      mutableMessageIds: ['m-1'],
      ...overrides
    }
  }
}

describe('append-message creation acknowledgment result', () => {
  it('accepts a main-route new-row acknowledgment', () => {
    expect(() => validateChatDbResult('chatdb:append-message', ack())).not.toThrow()
  })

  it('accepts a branch-route acknowledgment', () => {
    expect(() =>
      validateChatDbResult(
        'chatdb:append-message',
        ack({ branchId: 'b-1', messageId: 'c-1', createdMessageIds: ['c-1'], mutableMessageIds: ['c-1'] })
      )
    ).not.toThrow()
  })

  it('accepts an existing-id patch acknowledgment (empty delta)', () => {
    expect(() =>
      validateChatDbResult('chatdb:append-message', ack({ createdMessageIds: [], mutableMessageIds: [] }))
    ).not.toThrow()
  })

  it('rejects a null success value', () => {
    expect(() => validateChatDbResult('chatdb:append-message', { ok: true, value: null })).toThrow(ValidationError)
  })

  it('rejects an unknown key in the success value', () => {
    expect(() => validateChatDbResult('chatdb:append-message', ack({ extra: 1 }))).toThrow(ValidationError)
  })

  it('rejects empty topicId / messageId', () => {
    expect(() => validateChatDbResult('chatdb:append-message', ack({ topicId: '' }))).toThrow(ValidationError)
    expect(() => validateChatDbResult('chatdb:append-message', ack({ messageId: '' }))).toThrow(ValidationError)
  })

  it('rejects an empty-string branchId (must be null or a non-empty id)', () => {
    expect(() => validateChatDbResult('chatdb:append-message', ack({ branchId: '' }))).toThrow(ValidationError)
  })

  it('rejects more than one created id (one append creates at most one row)', () => {
    expect(() =>
      validateChatDbResult(
        'chatdb:append-message',
        ack({ createdMessageIds: ['m-1', 'm-2'], mutableMessageIds: ['m-1', 'm-2'] })
      )
    ).toThrow(ValidationError)
  })

  it('rejects a created id that does not equal messageId', () => {
    expect(() =>
      validateChatDbResult('chatdb:append-message', ack({ createdMessageIds: ['other'], mutableMessageIds: [] }))
    ).toThrow(ValidationError)
  })

  it('rejects a capability id outside the created delta', () => {
    expect(() =>
      validateChatDbResult('chatdb:append-message', ack({ createdMessageIds: [], mutableMessageIds: ['m-1'] }))
    ).toThrow(ValidationError)
    expect(() =>
      validateChatDbResult(
        'chatdb:append-message',
        ack({ createdMessageIds: ['m-1'], mutableMessageIds: ['m-1', 'ghost'] })
      )
    ).toThrow(ValidationError)
  })

  it('rejects missing or mistyped delta arrays', () => {
    const full = ack() as { value: Record<string, unknown>; ok: boolean }
    const withoutDelta = { ...full.value }
    delete withoutDelta.mutableMessageIds
    expect(() => validateChatDbResult('chatdb:append-message', { ok: true, value: withoutDelta })).toThrow(
      ValidationError
    )
    expect(() =>
      validateChatDbResult('chatdb:append-message', { ok: true, value: { ...full.value, createdMessageIds: 'm-1' } })
    ).toThrow(ValidationError)
    expect(() =>
      validateChatDbResult('chatdb:append-message', { ok: true, value: { ...full.value, mutableMessageIds: [''] } })
    ).toThrow(ValidationError)
  })
})
