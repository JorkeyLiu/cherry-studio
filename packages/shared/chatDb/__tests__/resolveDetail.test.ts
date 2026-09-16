import { describe, expect, it } from 'vitest'

import { validateChatDbRequest, validateChatDbResult, ValidationError } from '../index'

describe('chatdb:resolve-context-closure detail (anchor split)', () => {
  it('accepts detail anchor for establish and defaults to closure when absent', () => {
    expect(() =>
      validateChatDbRequest('chatdb:resolve-context-closure', {
        topicId: 't1',
        intent: 'establish',
        contextCount: 2,
        detail: 'anchor'
      })
    ).not.toThrow()
    expect(() =>
      validateChatDbRequest('chatdb:resolve-context-closure', {
        topicId: 't1',
        intent: 'establish',
        contextCount: 2
      })
    ).not.toThrow()
  })

  it('rejects detail anchor for non-establish intents and unknown detail values', () => {
    expect(() =>
      validateChatDbRequest('chatdb:resolve-context-closure', {
        topicId: 't1',
        intent: 'reanchor-default',
        contextCount: 1,
        detail: 'anchor'
      })
    ).toThrow(ValidationError)
    expect(() =>
      validateChatDbRequest('chatdb:resolve-context-closure', {
        topicId: 't1',
        intent: 'move',
        groupKey: 'u1',
        detail: 'anchor'
      })
    ).toThrow(ValidationError)
    expect(() =>
      validateChatDbRequest('chatdb:resolve-context-closure', {
        topicId: 't1',
        intent: 'establish',
        contextCount: 2,
        detail: 'everything'
      })
    ).toThrow(ValidationError)
  })

  it('accepts the metadata-only anchor result shape and rejects closure keys mixed into it', () => {
    expect(() =>
      validateChatDbResult('chatdb:resolve-context-closure', {
        ok: true,
        value: { resolvedAnchorGroupKey: 'u2', changed: true }
      })
    ).not.toThrow()
    expect(() =>
      validateChatDbResult('chatdb:resolve-context-closure', {
        ok: true,
        value: { resolvedAnchorGroupKey: null, changed: false }
      })
    ).not.toThrow()
    expect(() =>
      validateChatDbResult('chatdb:resolve-context-closure', {
        ok: true,
        value: { resolvedAnchorGroupKey: 'u2', changed: true, messages: [] }
      })
    ).toThrow(ValidationError)
  })
})
