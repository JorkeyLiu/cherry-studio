import { describe, expect, it } from 'vitest'

import { validateChatDbRequest, validateChatDbResult } from '../index'

/**
 * Resend attempt technical carrier (SYNC-DATA-055 issuer slice):
 * optional `resendAttemptId` on the six protected write requests plus the
 * strictly-closed per-message attempt mapping on the reset success response.
 * IpcChannel strings unchanged; unknown keys still fail closed.
 */

const ATTEMPT = 'attempt-issuer-1'

describe('resend attempt carrier — six protected write requests', () => {
  it('append-message accepts an omitted carrier (ordinary path unchanged)', () => {
    expect(() =>
      validateChatDbRequest('chatdb:append-message', {
        topicId: 't-1',
        message: { id: 'm-1' },
        blocks: []
      })
    ).not.toThrow()
  })

  it('append-message accepts a well-formed carrier', () => {
    expect(() =>
      validateChatDbRequest('chatdb:append-message', {
        topicId: 't-1',
        message: { id: 'm-1' },
        blocks: [],
        resendAttemptId: ATTEMPT
      })
    ).not.toThrow()
  })

  it('update-message accepts a well-formed carrier and rejects colon/empty/unknown keys', () => {
    expect(() =>
      validateChatDbRequest('chatdb:update-message', {
        topicId: 't-1',
        messageId: 'm-1',
        updates: { content: 'x' },
        resendAttemptId: ATTEMPT
      })
    ).not.toThrow()
    expect(() =>
      validateChatDbRequest('chatdb:update-message', {
        topicId: 't-1',
        messageId: 'm-1',
        updates: { content: 'x' },
        resendAttemptId: 'bad:colon'
      })
    ).toThrow()
    expect(() =>
      validateChatDbRequest('chatdb:update-message', {
        topicId: 't-1',
        messageId: 'm-1',
        updates: { content: 'x' },
        resendAttemptId: ''
      })
    ).toThrow()
    expect(() =>
      validateChatDbRequest('chatdb:update-message', {
        topicId: 't-1',
        messageId: 'm-1',
        updates: { content: 'x' },
        resendAttemptId: ATTEMPT,
        askId: 'm-user-1'
      })
    ).toThrow()
  })

  it('update-message-and-blocks accepts a well-formed carrier and rejects unknown keys', () => {
    expect(() =>
      validateChatDbRequest('chatdb:update-message-and-blocks', {
        topicId: 't-1',
        messageUpdates: { id: 'm-1' },
        blocksToUpdate: [],
        resendAttemptId: ATTEMPT
      })
    ).not.toThrow()
    expect(() =>
      validateChatDbRequest('chatdb:update-message-and-blocks', {
        topicId: 't-1',
        messageUpdates: { id: 'm-1' },
        blocksToUpdate: [],
        resendAttemptId: ATTEMPT,
        extra: 'nope'
      })
    ).toThrow()
  })

  it('block write requests accept a well-formed carrier and reject malformed ones', () => {
    expect(() =>
      validateChatDbRequest('chatdb:update-blocks', {
        blocks: [{ id: 'b-1', messageId: 'm-1' }],
        resendAttemptId: ATTEMPT
      })
    ).not.toThrow()
    expect(() =>
      validateChatDbRequest('chatdb:update-single-block', {
        blockId: 'b-1',
        updates: { content: 'x' },
        resendAttemptId: ATTEMPT
      })
    ).not.toThrow()
    expect(() =>
      validateChatDbRequest('chatdb:bulk-add-blocks', {
        blocks: [{ id: 'b-1', messageId: 'm-1' }],
        resendAttemptId: ATTEMPT
      })
    ).not.toThrow()
    expect(() =>
      validateChatDbRequest('chatdb:bulk-add-blocks', {
        blocks: [{ id: 'b-1', messageId: 'm-1' }],
        resendAttemptId: 'has:colon'
      })
    ).toThrow()
    expect(() =>
      validateChatDbRequest('chatdb:update-blocks', {
        blocks: [{ id: 'b-1', messageId: 'm-1' }],
        diagnostics: { correlationId: 'x', ordinal: 1 },
        resendAttemptId: ATTEMPT
      })
    ).not.toThrow()
  })
})

describe('resend attempt mapping — reset success response roundtrip', () => {
  const cleanup = { affectedFileIds: ['f-1'], remainingReferenceCounts: { 'f-1': 0 } }

  it('accepts cleanup facts plus a strictly-closed mapping', () => {
    expect(() =>
      validateChatDbResult('chatdb:reset-messages-for-resend', {
        ok: true,
        value: { ...cleanup, attempts: [{ messageId: 'm-1', attemptId: ATTEMPT }] }
      })
    ).not.toThrow()
  })

  it('accepts an empty mapping (no messages reset)', () => {
    expect(() =>
      validateChatDbResult('chatdb:reset-messages-for-resend', { ok: true, value: { ...cleanup, attempts: [] } })
    ).not.toThrow()
  })

  it('rejects a missing mapping, unknown value keys, and non-closed entries', () => {
    expect(() =>
      validateChatDbResult('chatdb:reset-messages-for-resend', { ok: true, value: { ...cleanup } })
    ).toThrow()
    expect(() =>
      validateChatDbResult('chatdb:reset-messages-for-resend', {
        ok: true,
        value: { ...cleanup, attempts: [], watermark: 3 }
      })
    ).toThrow()
    expect(() =>
      validateChatDbResult('chatdb:reset-messages-for-resend', {
        ok: true,
        value: { ...cleanup, attempts: [{ messageId: 'm-1', attemptId: ATTEMPT, askId: 'u-1' }] }
      })
    ).toThrow()
    expect(() =>
      validateChatDbResult('chatdb:reset-messages-for-resend', {
        ok: true,
        value: { ...cleanup, attempts: [{ messageId: 'm-1', attemptId: 'bad:colon' }] }
      })
    ).toThrow()
    expect(() =>
      validateChatDbResult('chatdb:reset-messages-for-resend', {
        ok: true,
        value: {
          ...cleanup,
          attempts: [
            { messageId: 'm-1', attemptId: ATTEMPT },
            { messageId: 'm-1', attemptId: 'attempt-2' }
          ]
        }
      })
    ).toThrow()
  })
})
