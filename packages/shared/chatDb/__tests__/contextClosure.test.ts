import { describe, expect, it } from 'vitest'

import { validateChatDbRequest, validateChatDbResult, ValidationError } from '../index'

describe('S6.3 context closure — contract validation', () => {
  describe('request', () => {
    it('accepts valid { topicId, anchorGroupKey }', () => {
      expect(() =>
        validateChatDbRequest('chatdb:fetch-context-closure', { topicId: 't1', anchorGroupKey: 'g1' })
      ).not.toThrow()
    })
    it('rejects missing topicId', () => {
      expect(() => validateChatDbRequest('chatdb:fetch-context-closure', { anchorGroupKey: 'g1' } as any)).toThrow(
        ValidationError
      )
    })
    it('rejects missing anchorGroupKey', () => {
      expect(() => validateChatDbRequest('chatdb:fetch-context-closure', { topicId: 't1' } as any)).toThrow(
        ValidationError
      )
    })
    it('rejects empty topicId / anchorGroupKey', () => {
      expect(() =>
        validateChatDbRequest('chatdb:fetch-context-closure', { topicId: '', anchorGroupKey: 'g1' })
      ).toThrow(ValidationError)
      expect(() =>
        validateChatDbRequest('chatdb:fetch-context-closure', { topicId: 't1', anchorGroupKey: '' })
      ).toThrow(ValidationError)
    })
    it('rejects non-string anchorGroupKey', () => {
      expect(() =>
        validateChatDbRequest('chatdb:fetch-context-closure', { topicId: 't1', anchorGroupKey: 123 } as any)
      ).toThrow(ValidationError)
    })
    it('rejects unknown field', () => {
      expect(() =>
        validateChatDbRequest('chatdb:fetch-context-closure', {
          topicId: 't1',
          anchorGroupKey: 'g1',
          unknown: 1
        } as any)
      ).toThrow(ValidationError)
    })
    it('rejects extra viewport fields (limit, before, after)', () => {
      expect(() =>
        validateChatDbRequest('chatdb:fetch-context-closure', {
          topicId: 't1',
          anchorGroupKey: 'g1',
          limit: 10
        } as any)
      ).toThrow(ValidationError)
      expect(() =>
        validateChatDbRequest('chatdb:fetch-context-closure', {
          topicId: 't1',
          anchorGroupKey: 'g1',
          before: 5
        } as any)
      ).toThrow(ValidationError)
    })
  })

  describe('result', () => {
    const baseSuccess = {
      ok: true as const,
      value: {
        messages: [{ id: 'm1' }],
        blocks: [{ id: 'b1', messageId: 'm1' }],
        closure: {
          completeness: 'context-closure' as const,
          topicId: 't1',
          anchorGroupKey: 'g1',
          firstMessageId: 'm1',
          lastMessageId: 'm1',
          returnedCount: 1
        }
      }
    }
    it('accepts valid success', () => {
      expect(() => validateChatDbResult('chatdb:fetch-context-closure', baseSuccess)).not.toThrow()
    })
    it('rejects empty closure with supplied anchorGroupKey and returnedCount 0 / null bounds (never a valid success)', () => {
      const empty = {
        ok: true as const,
        value: {
          messages: [],
          blocks: [],
          closure: {
            completeness: 'context-closure' as const,
            topicId: 't1',
            anchorGroupKey: 'g1',
            firstMessageId: null,
            lastMessageId: null,
            returnedCount: 0
          }
        }
      }
      expect(() => validateChatDbResult('chatdb:fetch-context-closure', empty)).toThrow(ValidationError)
    })
    it('rejects empty with non-null bounds', () => {
      const bad = {
        ok: true as const,
        value: {
          messages: [],
          blocks: [],
          closure: {
            completeness: 'context-closure' as const,
            topicId: 't1',
            anchorGroupKey: 'g1',
            firstMessageId: 'm1',
            lastMessageId: null,
            returnedCount: 0
          }
        }
      }
      expect(() => validateChatDbResult('chatdb:fetch-context-closure', bad)).toThrow(ValidationError)
    })
    it('rejects completeness not "context-closure"', () => {
      const bad = {
        ...baseSuccess,
        value: { ...baseSuccess.value, closure: { ...baseSuccess.value.closure, completeness: 'window' as any } }
      }
      expect(() => validateChatDbResult('chatdb:fetch-context-closure', bad)).toThrow(ValidationError)
    })
    it('rejects completeness masquerading as window/answer-group/whole-topic', () => {
      for (const comp of ['window', 'answer-group', 'whole-topic']) {
        const bad = {
          ...baseSuccess,
          value: { ...baseSuccess.value, closure: { ...baseSuccess.value.closure, completeness: comp as any } }
        }
        expect(() => validateChatDbResult('chatdb:fetch-context-closure', bad)).toThrow(ValidationError)
      }
    })
    it('rejects unknown value key', () => {
      const bad = {
        ok: true as const,
        value: { messages: [], blocks: [], closure: baseSuccess.value.closure, hasMore: true } as any
      }
      expect(() => validateChatDbResult('chatdb:fetch-context-closure', bad)).toThrow(ValidationError)
    })
    it('rejects unknown closure key', () => {
      const bad = {
        ...baseSuccess,
        value: { ...baseSuccess.value, closure: { ...baseSuccess.value.closure, hasMore: true } as any }
      }
      expect(() => validateChatDbResult('chatdb:fetch-context-closure', bad)).toThrow(ValidationError)
    })
    it('rejects missing closure', () => {
      const bad = { ok: true as const, value: { messages: [], blocks: [] } as any }
      expect(() => validateChatDbResult('chatdb:fetch-context-closure', bad)).toThrow(ValidationError)
    })
    it('rejects returnedCount mismatch', () => {
      const bad = {
        ...baseSuccess,
        value: {
          ...baseSuccess.value,
          closure: { ...baseSuccess.value.closure, returnedCount: 999 }
        }
      }
      expect(() => validateChatDbResult('chatdb:fetch-context-closure', bad)).toThrow(ValidationError)
    })
    it('rejects firstMessageId not matching first message', () => {
      const bad = {
        ...baseSuccess,
        value: {
          ...baseSuccess.value,
          closure: { ...baseSuccess.value.closure, firstMessageId: 'wrong' }
        }
      }
      expect(() => validateChatDbResult('chatdb:fetch-context-closure', bad)).toThrow(ValidationError)
    })
    it('rejects lastMessageId not matching last message', () => {
      const bad = {
        ok: true as const,
        value: {
          messages: [{ id: 'm1' }, { id: 'm2' }],
          blocks: [],
          closure: {
            completeness: 'context-closure' as const,
            topicId: 't1',
            anchorGroupKey: 'g1',
            firstMessageId: 'm1',
            lastMessageId: 'wrong',
            returnedCount: 2
          }
        }
      }
      expect(() => validateChatDbResult('chatdb:fetch-context-closure', bad)).toThrow(ValidationError)
    })
    it('rejects returnedCount negative and non-integer', () => {
      for (const rc of [-1, 1.5, '1' as any]) {
        const bad = {
          ok: true as const,
          value: {
            messages: [{ id: 'm1' }],
            blocks: [{ id: 'b1', messageId: 'm1' }],
            closure: {
              completeness: 'context-closure' as const,
              topicId: 't1',
              anchorGroupKey: 'g1',
              firstMessageId: 'm1',
              lastMessageId: 'm1',
              returnedCount: rc
            } as any
          }
        }
        expect(() => validateChatDbResult('chatdb:fetch-context-closure', bad)).toThrow(ValidationError)
      }
    })
    it('rejects plain-object violation', () => {
      class Fake {}
      const bad = {
        ok: true as const,
        value: new Fake() as any
      }
      expect(() => validateChatDbResult('chatdb:fetch-context-closure', bad)).toThrow(ValidationError)
    })
    it('rejects class-instance nested closure (plain-object validation)', () => {
      class ClosureFake {
        completeness = 'context-closure' as const
        topicId = 't1'
        anchorGroupKey = 'g1'
        firstMessageId = 'm1'
        lastMessageId = 'm1'
        returnedCount = 1
      }
      const bad = {
        ok: true as const,
        value: {
          messages: [{ id: 'm1' }],
          blocks: [{ id: 'b1', messageId: 'm1' }],
          closure: new ClosureFake() as any
        }
      }
      expect(() => validateChatDbResult('chatdb:fetch-context-closure', bad)).toThrow(ValidationError)
    })
    it('rejects hasMore field in value or closure', () => {
      const bad1 = {
        ok: true as const,
        value: { messages: [], blocks: [], closure: baseSuccess.value.closure, hasMore: false } as any
      }
      expect(() => validateChatDbResult('chatdb:fetch-context-closure', bad1)).toThrow(ValidationError)
      const bad2 = {
        ...baseSuccess,
        value: { ...baseSuccess.value, closure: { ...baseSuccess.value.closure, hasMoreAfter: true } as any }
      }
      expect(() => validateChatDbResult('chatdb:fetch-context-closure', bad2)).toThrow(ValidationError)
    })
  })
})
