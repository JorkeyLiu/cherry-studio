import { describe, expect, it } from 'vitest'

import { validateChatDbRequest, validateChatDbResult, ValidationError } from '../index'

const baseClosure = {
  completeness: 'context-closure',
  topicId: 't1',
  anchorGroupKey: 'u2',
  firstMessageId: 'u2',
  lastMessageId: 'u3',
  returnedCount: 2,
  totalTurnCount: 3,
  selectedTurnCount: 2,
  boundaryMessageId: 'u2'
}

const baseSuccess = (overrides: Record<string, unknown> = {}) => ({
  ok: true as const,
  value: {
    messages: [
      { id: 'u2', role: 'user' },
      { id: 'u3', role: 'user' }
    ],
    blocks: [],
    closure: { ...baseClosure },
    resolvedAnchorGroupKey: 'u2',
    changed: true,
    ...overrides
  }
})

describe('chatdb:resolve-context-closure request validation', () => {
  it('accepts establish with contextCount and current anchor', () => {
    expect(() =>
      validateChatDbRequest('chatdb:resolve-context-closure', {
        topicId: 't1',
        intent: 'establish',
        contextCount: 2,
        currentAnchorGroupKey: 'u1'
      })
    ).not.toThrow()
  })

  it('accepts establish with null contextCount and null current', () => {
    expect(() =>
      validateChatDbRequest('chatdb:resolve-context-closure', {
        topicId: 't1',
        intent: 'establish',
        contextCount: null,
        currentAnchorGroupKey: null
      })
    ).not.toThrow()
  })

  it('rejects establish without contextCount', () => {
    expect(() =>
      validateChatDbRequest('chatdb:resolve-context-closure', { topicId: 't1', intent: 'establish' } as any)
    ).toThrow(ValidationError)
  })

  it('rejects establish with messageId', () => {
    expect(() =>
      validateChatDbRequest('chatdb:resolve-context-closure', {
        topicId: 't1',
        intent: 'establish',
        contextCount: 2,
        messageId: 'm1'
      } as any)
    ).toThrow(ValidationError)
  })

  it('accepts reanchor-default', () => {
    expect(() =>
      validateChatDbRequest('chatdb:resolve-context-closure', {
        topicId: 't1',
        intent: 'reanchor-default',
        contextCount: 5
      })
    ).not.toThrow()
  })

  it('accepts move with messageId', () => {
    expect(() =>
      validateChatDbRequest('chatdb:resolve-context-closure', {
        topicId: 't1',
        intent: 'move',
        messageId: 'm1'
      })
    ).not.toThrow()
  })

  it('accepts move with groupKey', () => {
    expect(() =>
      validateChatDbRequest('chatdb:resolve-context-closure', {
        topicId: 't1',
        intent: 'move',
        groupKey: 'u1'
      })
    ).not.toThrow()
  })

  it('rejects move with both messageId and groupKey', () => {
    expect(() =>
      validateChatDbRequest('chatdb:resolve-context-closure', {
        topicId: 't1',
        intent: 'move',
        messageId: 'm1',
        groupKey: 'u1'
      } as any)
    ).toThrow(ValidationError)
  })

  it('rejects move with neither identifier', () => {
    expect(() =>
      validateChatDbRequest('chatdb:resolve-context-closure', { topicId: 't1', intent: 'move' } as any)
    ).toThrow(ValidationError)
  })

  it('rejects move with contextCount', () => {
    expect(() =>
      validateChatDbRequest('chatdb:resolve-context-closure', {
        topicId: 't1',
        intent: 'move',
        messageId: 'm1',
        contextCount: 2
      } as any)
    ).toThrow(ValidationError)
  })

  it('accepts inherit with source and fallback contextCount', () => {
    expect(() =>
      validateChatDbRequest('chatdb:resolve-context-closure', {
        topicId: 't-new',
        intent: 'inherit',
        sourceTopicId: 't-src',
        sourceAnchorGroupKey: 'u1',
        contextCount: 2
      })
    ).not.toThrow()
  })

  it('rejects inherit without sourceTopicId', () => {
    expect(() =>
      validateChatDbRequest('chatdb:resolve-context-closure', {
        topicId: 't-new',
        intent: 'inherit',
        contextCount: 2
      } as any)
    ).toThrow(ValidationError)
  })

  it('rejects inherit without contextCount', () => {
    expect(() =>
      validateChatDbRequest('chatdb:resolve-context-closure', {
        topicId: 't-new',
        intent: 'inherit',
        sourceTopicId: 't-src'
      } as any)
    ).toThrow(ValidationError)
  })

  it('rejects unknown intent', () => {
    expect(() =>
      validateChatDbRequest('chatdb:resolve-context-closure', { topicId: 't1', intent: 'nope' } as any)
    ).toThrow(ValidationError)
  })

  it('rejects unknown keys', () => {
    expect(() =>
      validateChatDbRequest('chatdb:resolve-context-closure', {
        topicId: 't1',
        intent: 'establish',
        contextCount: 2,
        extra: 1
      } as any)
    ).toThrow(ValidationError)
  })
})

describe('chatdb:resolve-context-closure result validation', () => {
  it('accepts a non-empty success with mirrored anchor', () => {
    expect(() => validateChatDbResult('chatdb:resolve-context-closure', baseSuccess())).not.toThrow()
  })

  it('accepts an empty (null anchor) success with zero counts', () => {
    const empty = {
      ok: true as const,
      value: {
        messages: [],
        blocks: [],
        closure: {
          completeness: 'context-closure',
          topicId: 't1',
          anchorGroupKey: null,
          firstMessageId: null,
          lastMessageId: null,
          returnedCount: 0,
          totalTurnCount: 0,
          selectedTurnCount: 0,
          boundaryMessageId: null
        },
        resolvedAnchorGroupKey: null,
        changed: false
      }
    }
    expect(() => validateChatDbResult('chatdb:resolve-context-closure', empty)).not.toThrow()
  })

  it('rejects mismatched closure.anchorGroupKey vs resolvedAnchorGroupKey', () => {
    const bad = baseSuccess({ resolvedAnchorGroupKey: 'u3' })
    expect(() => validateChatDbResult('chatdb:resolve-context-closure', bad)).toThrow(ValidationError)
  })

  it('rejects non-boolean changed', () => {
    const bad = baseSuccess({ changed: 'yes' })
    expect(() => validateChatDbResult('chatdb:resolve-context-closure', bad)).toThrow(ValidationError)
  })

  it('rejects empty anchor with non-zero counts', () => {
    const bad = {
      ok: true as const,
      value: {
        messages: [],
        blocks: [],
        closure: {
          completeness: 'context-closure',
          topicId: 't1',
          anchorGroupKey: null,
          firstMessageId: null,
          lastMessageId: null,
          returnedCount: 0,
          totalTurnCount: 1,
          selectedTurnCount: 0,
          boundaryMessageId: null
        },
        resolvedAnchorGroupKey: null,
        changed: true
      }
    }
    expect(() => validateChatDbResult('chatdb:resolve-context-closure', bad)).toThrow(ValidationError)
  })

  it('rejects non-empty success with zero returnedCount', () => {
    const bad = {
      ok: true as const,
      value: {
        messages: [],
        blocks: [],
        closure: { ...baseClosure, returnedCount: 0, firstMessageId: null, lastMessageId: null },
        resolvedAnchorGroupKey: 'u2',
        changed: true
      }
    }
    expect(() => validateChatDbResult('chatdb:resolve-context-closure', bad)).toThrow(ValidationError)
  })

  it('rejects unknown top-level keys', () => {
    const bad = baseSuccess({ extra: 1 })
    expect(() => validateChatDbResult('chatdb:resolve-context-closure', bad)).toThrow(ValidationError)
  })
})
