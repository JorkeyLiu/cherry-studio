import { describe, expect, it } from 'vitest'

import { validateChatDbRequest, validateChatDbResult, ValidationError } from '../index'

describe('S6.1 windowed reads — contract validation', () => {
  describe('latest window request', () => {
    it('accepts valid latest { kind, topicId, limit }', () => {
      expect(() =>
        validateChatDbRequest('chatdb:fetch-messages-window', { kind: 'latest', topicId: 't1', limit: 20 })
      ).not.toThrow()
    })
    it('accepts boundary limits 1 and 100', () => {
      expect(() =>
        validateChatDbRequest('chatdb:fetch-messages-window', { kind: 'latest', topicId: 't1', limit: 1 })
      ).not.toThrow()
      expect(() =>
        validateChatDbRequest('chatdb:fetch-messages-window', { kind: 'latest', topicId: 't1', limit: 100 })
      ).not.toThrow()
    })
    it('rejects missing limit', () => {
      expect(() =>
        validateChatDbRequest('chatdb:fetch-messages-window', { kind: 'latest', topicId: 't1' } as any)
      ).toThrow(ValidationError)
    })
    it('rejects limit 0 and 101', () => {
      expect(() =>
        validateChatDbRequest('chatdb:fetch-messages-window', { kind: 'latest', topicId: 't1', limit: 0 })
      ).toThrow(ValidationError)
      expect(() =>
        validateChatDbRequest('chatdb:fetch-messages-window', { kind: 'latest', topicId: 't1', limit: 101 })
      ).toThrow(ValidationError)
    })
    it('rejects limit fractional and non-number', () => {
      expect(() =>
        validateChatDbRequest('chatdb:fetch-messages-window', { kind: 'latest', topicId: 't1', limit: 1.5 })
      ).toThrow(ValidationError)
      expect(() =>
        validateChatDbRequest('chatdb:fetch-messages-window', { kind: 'latest', topicId: 't1', limit: '20' } as any)
      ).toThrow(ValidationError)
    })
    it('rejects latest with around fields', () => {
      expect(() =>
        validateChatDbRequest('chatdb:fetch-messages-window', {
          kind: 'latest',
          topicId: 't1',
          limit: 10,
          anchorMessageId: 'm1'
        } as any)
      ).toThrow(ValidationError)
      expect(() =>
        validateChatDbRequest('chatdb:fetch-messages-window', {
          kind: 'latest',
          topicId: 't1',
          limit: 10,
          before: 5
        } as any)
      ).toThrow(ValidationError)
    })
    it('rejects unknown field', () => {
      expect(() =>
        validateChatDbRequest('chatdb:fetch-messages-window', {
          kind: 'latest',
          topicId: 't1',
          limit: 10,
          unknown: 1
        } as any)
      ).toThrow(ValidationError)
    })
    it('rejects missing topicId and invalid kind', () => {
      expect(() => validateChatDbRequest('chatdb:fetch-messages-window', { kind: 'latest', limit: 10 } as any)).toThrow(
        ValidationError
      )
      expect(() =>
        validateChatDbRequest('chatdb:fetch-messages-window', { kind: 'bogus', topicId: 't1', limit: 10 } as any)
      ).toThrow(ValidationError)
    })
  })

  describe('around window request', () => {
    it('accepts valid around { kind, topicId, anchorMessageId, before, after }', () => {
      expect(() =>
        validateChatDbRequest('chatdb:fetch-messages-window', {
          kind: 'around',
          topicId: 't1',
          anchorMessageId: 'm1',
          before: 10,
          after: 10
        })
      ).not.toThrow()
    })
    it('rejects missing before/after', () => {
      expect(() =>
        validateChatDbRequest('chatdb:fetch-messages-window', {
          kind: 'around',
          topicId: 't1',
          anchorMessageId: 'm1',
          before: 5
        } as any)
      ).toThrow(ValidationError)
      expect(() =>
        validateChatDbRequest('chatdb:fetch-messages-window', {
          kind: 'around',
          topicId: 't1',
          anchorMessageId: 'm1',
          after: 5
        } as any)
      ).toThrow(ValidationError)
    })
    it('rejects before/after out of 1..100', () => {
      expect(() =>
        validateChatDbRequest('chatdb:fetch-messages-window', {
          kind: 'around',
          topicId: 't1',
          anchorMessageId: 'm1',
          before: 0,
          after: 10
        })
      ).toThrow(ValidationError)
      expect(() =>
        validateChatDbRequest('chatdb:fetch-messages-window', {
          kind: 'around',
          topicId: 't1',
          anchorMessageId: 'm1',
          before: 10,
          after: 101
        })
      ).toThrow(ValidationError)
    })
    it('rejects around with limit', () => {
      expect(() =>
        validateChatDbRequest('chatdb:fetch-messages-window', {
          kind: 'around',
          topicId: 't1',
          anchorMessageId: 'm1',
          before: 5,
          after: 5,
          limit: 10
        } as any)
      ).toThrow(ValidationError)
    })
    it('rejects empty anchorMessageId', () => {
      expect(() =>
        validateChatDbRequest('chatdb:fetch-messages-window', {
          kind: 'around',
          topicId: 't1',
          anchorMessageId: '',
          before: 5,
          after: 5
        })
      ).toThrow(ValidationError)
    })
  })

  describe('window result validation', () => {
    const baseSuccess = {
      ok: true as const,
      value: {
        messages: [{ id: 'm1' }],
        blocks: [{ id: 'b1', messageId: 'm1' }],
        window: {
          kind: 'latest' as const,
          completeness: 'window' as const,
          topicId: 't1',
          anchorMessageId: null,
          requested: { limit: 10 },
          firstMessageId: 'm1',
          lastMessageId: 'm1',
          returnedCount: 1,
          hasMoreBefore: false,
          hasMoreAfter: false
        }
      }
    }
    it('accepts valid latest window result', () => {
      expect(() => validateChatDbResult('chatdb:fetch-messages-window', baseSuccess)).not.toThrow()
    })
    it('accepts valid around window result', () => {
      const around = {
        ok: true as const,
        value: {
          messages: [{ id: 'm2' }],
          blocks: [],
          window: {
            kind: 'around' as const,
            completeness: 'window' as const,
            topicId: 't1',
            anchorMessageId: 'm2',
            requested: { before: 5, after: 5 },
            firstMessageId: 'm2',
            lastMessageId: 'm2',
            returnedCount: 1,
            hasMoreBefore: true,
            hasMoreAfter: true
          }
        }
      }
      expect(() => validateChatDbResult('chatdb:fetch-messages-window', around)).not.toThrow()
    })
    it('accepts empty window (null bounds, 0 count)', () => {
      const empty = {
        ok: true as const,
        value: {
          messages: [],
          blocks: [],
          window: {
            kind: 'latest' as const,
            completeness: 'window' as const,
            topicId: 't1',
            anchorMessageId: null,
            requested: { limit: 10 },
            firstMessageId: null,
            lastMessageId: null,
            returnedCount: 0,
            hasMoreBefore: false,
            hasMoreAfter: false
          }
        }
      }
      expect(() => validateChatDbResult('chatdb:fetch-messages-window', empty)).not.toThrow()
    })
    it('rejects empty window with non-null bounds', () => {
      const bad = {
        ok: true as const,
        value: {
          messages: [],
          blocks: [],
          window: {
            kind: 'latest' as const,
            completeness: 'window' as const,
            topicId: 't1',
            anchorMessageId: null,
            requested: { limit: 10 },
            firstMessageId: 'm1',
            lastMessageId: null,
            returnedCount: 0,
            hasMoreBefore: false,
            hasMoreAfter: false
          }
        }
      }
      expect(() => validateChatDbResult('chatdb:fetch-messages-window', bad)).toThrow(ValidationError)
    })
    it('rejects completeness not "window"', () => {
      const bad = {
        ...baseSuccess,
        value: { ...baseSuccess.value, window: { ...baseSuccess.value.window, completeness: 'whole-topic' as any } }
      }
      expect(() => validateChatDbResult('chatdb:fetch-messages-window', bad)).toThrow(ValidationError)
    })
    it('rejects unknown window key', () => {
      const bad = {
        ...baseSuccess,
        value: { ...baseSuccess.value, window: { ...baseSuccess.value.window, unknown: 1 } as any }
      }
      expect(() => validateChatDbResult('chatdb:fetch-messages-window', bad)).toThrow(ValidationError)
    })
    it('rejects missing window', () => {
      const bad = { ok: true as const, value: { messages: [], blocks: [] } as any }
      expect(() => validateChatDbResult('chatdb:fetch-messages-window', bad)).toThrow(ValidationError)
    })
    it('rejects plain-object violation and unknown value key', () => {
      const bad = {
        ok: true as const,
        value: { messages: [], blocks: [], window: baseSuccess.value.window, extra: 1 } as any
      }
      expect(() => validateChatDbResult('chatdb:fetch-messages-window', bad)).toThrow(ValidationError)
    })
    it('rejects latest window with empty requested', () => {
      const bad = {
        ok: true as const,
        value: {
          messages: [],
          blocks: [],
          window: {
            kind: 'latest' as const,
            completeness: 'window' as const,
            topicId: 't1',
            anchorMessageId: null,
            requested: {} as any,
            firstMessageId: null,
            lastMessageId: null,
            returnedCount: 0,
            hasMoreBefore: false,
            hasMoreAfter: false
          }
        }
      }
      expect(() => validateChatDbResult('chatdb:fetch-messages-window', bad)).toThrow(ValidationError)
    })
    it('rejects latest window with before/after instead of limit', () => {
      const bad = {
        ok: true as const,
        value: {
          messages: [{ id: 'm1' }],
          blocks: [],
          window: {
            kind: 'latest' as const,
            completeness: 'window' as const,
            topicId: 't1',
            anchorMessageId: null,
            requested: { before: 5, after: 5 } as any,
            firstMessageId: 'm1',
            lastMessageId: 'm1',
            returnedCount: 1,
            hasMoreBefore: false,
            hasMoreAfter: false
          }
        }
      }
      expect(() => validateChatDbResult('chatdb:fetch-messages-window', bad)).toThrow(ValidationError)
    })
    it('rejects latest window missing limit', () => {
      const bad = {
        ok: true as const,
        value: {
          messages: [{ id: 'm1' }],
          blocks: [],
          window: {
            kind: 'latest' as const,
            completeness: 'window' as const,
            topicId: 't1',
            anchorMessageId: null,
            requested: { limit: undefined } as any,
            firstMessageId: 'm1',
            lastMessageId: 'm1',
            returnedCount: 1,
            hasMoreBefore: false,
            hasMoreAfter: false
          }
        }
      }
      delete bad.value.window.requested.limit
      expect(() => validateChatDbResult('chatdb:fetch-messages-window', bad)).toThrow(ValidationError)
    })
    it('rejects latest window with limit out of bounds', () => {
      for (const lim of [0, 101, 1.5, '10' as any]) {
        const bad = {
          ok: true as const,
          value: {
            messages: [],
            blocks: [],
            window: {
              kind: 'latest' as const,
              completeness: 'window' as const,
              topicId: 't1',
              anchorMessageId: null,
              requested: { limit: lim } as any,
              firstMessageId: null,
              lastMessageId: null,
              returnedCount: 0,
              hasMoreBefore: false,
              hasMoreAfter: false
            }
          }
        }
        expect(() => validateChatDbResult('chatdb:fetch-messages-window', bad)).toThrow(ValidationError)
      }
    })
    it('rejects around window with empty requested', () => {
      const bad = {
        ok: true as const,
        value: {
          messages: [],
          blocks: [],
          window: {
            kind: 'around' as const,
            completeness: 'window' as const,
            topicId: 't1',
            anchorMessageId: 'm1',
            requested: {} as any,
            firstMessageId: 'm1',
            lastMessageId: 'm1',
            returnedCount: 1,
            hasMoreBefore: false,
            hasMoreAfter: false
          }
        }
      }
      expect(() => validateChatDbResult('chatdb:fetch-messages-window', bad)).toThrow(ValidationError)
    })
    it('rejects around window with limit instead of before/after', () => {
      const bad = {
        ok: true as const,
        value: {
          messages: [{ id: 'm1' }],
          blocks: [],
          window: {
            kind: 'around' as const,
            completeness: 'window' as const,
            topicId: 't1',
            anchorMessageId: 'm1',
            requested: { limit: 10 } as any,
            firstMessageId: 'm1',
            lastMessageId: 'm1',
            returnedCount: 1,
            hasMoreBefore: false,
            hasMoreAfter: false
          }
        }
      }
      expect(() => validateChatDbResult('chatdb:fetch-messages-window', bad)).toThrow(ValidationError)
    })
    it('rejects around window missing before', () => {
      const bad = {
        ok: true as const,
        value: {
          messages: [{ id: 'm1' }],
          blocks: [],
          window: {
            kind: 'around' as const,
            completeness: 'window' as const,
            topicId: 't1',
            anchorMessageId: 'm1',
            requested: { after: 5 } as any,
            firstMessageId: 'm1',
            lastMessageId: 'm1',
            returnedCount: 1,
            hasMoreBefore: false,
            hasMoreAfter: false
          }
        }
      }
      expect(() => validateChatDbResult('chatdb:fetch-messages-window', bad)).toThrow(ValidationError)
    })
    it('rejects around window missing after', () => {
      const bad = {
        ok: true as const,
        value: {
          messages: [{ id: 'm1' }],
          blocks: [],
          window: {
            kind: 'around' as const,
            completeness: 'window' as const,
            topicId: 't1',
            anchorMessageId: 'm1',
            requested: { before: 5 } as any,
            firstMessageId: 'm1',
            lastMessageId: 'm1',
            returnedCount: 1,
            hasMoreBefore: false,
            hasMoreAfter: false
          }
        }
      }
      expect(() => validateChatDbResult('chatdb:fetch-messages-window', bad)).toThrow(ValidationError)
    })
    it('rejects around window with before/after out of bounds', () => {
      for (const badReq of [
        { before: 0, after: 5 },
        { before: 5, after: 101 },
        { before: 1.5, after: 5 }
      ]) {
        const bad = {
          ok: true as const,
          value: {
            messages: [{ id: 'm1' }],
            blocks: [],
            window: {
              kind: 'around' as const,
              completeness: 'window' as const,
              topicId: 't1',
              anchorMessageId: 'm1',
              requested: badReq as any,
              firstMessageId: 'm1',
              lastMessageId: 'm1',
              returnedCount: 1,
              hasMoreBefore: false,
              hasMoreAfter: false
            }
          }
        }
        expect(() => validateChatDbResult('chatdb:fetch-messages-window', bad)).toThrow(ValidationError)
      }
    })
    it('rejects kind/requested mismatch — latest kind with around requested shape', () => {
      const bad = {
        ok: true as const,
        value: {
          messages: [{ id: 'm1' }],
          blocks: [],
          window: {
            kind: 'latest' as const,
            completeness: 'window' as const,
            topicId: 't1',
            anchorMessageId: 'm1',
            requested: { before: 5, after: 5 } as any,
            firstMessageId: 'm1',
            lastMessageId: 'm1',
            returnedCount: 1,
            hasMoreBefore: false,
            hasMoreAfter: false
          }
        }
      }
      expect(() => validateChatDbResult('chatdb:fetch-messages-window', bad)).toThrow(ValidationError)
    })
    it('rejects kind/requested mismatch — around kind with latest requested shape', () => {
      const bad = {
        ok: true as const,
        value: {
          messages: [{ id: 'm1' }],
          blocks: [],
          window: {
            kind: 'around' as const,
            completeness: 'window' as const,
            topicId: 't1',
            anchorMessageId: 'm1',
            requested: { limit: 10 } as any,
            firstMessageId: 'm1',
            lastMessageId: 'm1',
            returnedCount: 1,
            hasMoreBefore: false,
            hasMoreAfter: false
          }
        }
      }
      expect(() => validateChatDbResult('chatdb:fetch-messages-window', bad)).toThrow(ValidationError)
    })
  })
})
