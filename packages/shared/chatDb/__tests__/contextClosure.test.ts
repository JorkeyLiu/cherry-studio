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
          returnedCount: 1,
          totalTurnCount: 1,
          selectedTurnCount: 1,
          boundaryMessageId: null
        }
      }
    }
    it('accepts valid success', () => {
      expect(() => validateChatDbResult('chatdb:fetch-context-closure', baseSuccess)).not.toThrow()
    })
    it('accepts valid partial success with boundary equals firstMessageId', () => {
      const partial = {
        ok: true as const,
        value: {
          messages: [{ id: 'm1' }, { id: 'm2' }],
          blocks: [],
          closure: {
            completeness: 'context-closure' as const,
            topicId: 't1',
            anchorGroupKey: 'g1',
            firstMessageId: 'm1',
            lastMessageId: 'm2',
            returnedCount: 2,
            totalTurnCount: 5,
            selectedTurnCount: 2,
            boundaryMessageId: 'm1'
          }
        }
      }
      expect(() => validateChatDbResult('chatdb:fetch-context-closure', partial)).not.toThrow()
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
            returnedCount: 0,
            totalTurnCount: 1,
            selectedTurnCount: 1,
            boundaryMessageId: null
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
            returnedCount: 0,
            totalTurnCount: 1,
            selectedTurnCount: 1,
            boundaryMessageId: null
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
            returnedCount: 2,
            totalTurnCount: 2,
            selectedTurnCount: 2,
            boundaryMessageId: null
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
              returnedCount: rc,
              totalTurnCount: 1,
              selectedTurnCount: 1,
              boundaryMessageId: null
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
        totalTurnCount = 1
        selectedTurnCount = 1
        boundaryMessageId = null
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

    // LOCK-001 authoritative counts and boundary
    it('rejects missing totalTurnCount/selectedTurnCount/boundaryMessageId', () => {
      const missingTotal = {
        ...baseSuccess,
        value: { ...baseSuccess.value, closure: { ...baseSuccess.value.closure, totalTurnCount: undefined } as any }
      }
      delete missingTotal.value.closure.totalTurnCount
      expect(() => validateChatDbResult('chatdb:fetch-context-closure', missingTotal)).toThrow(ValidationError)
      const missingSelected = {
        ...baseSuccess,
        value: { ...baseSuccess.value, closure: { ...baseSuccess.value.closure, selectedTurnCount: undefined } as any }
      }
      delete missingSelected.value.closure.selectedTurnCount
      expect(() => validateChatDbResult('chatdb:fetch-context-closure', missingSelected)).toThrow(ValidationError)
      const missingBoundary = {
        ...baseSuccess,
        value: { ...baseSuccess.value, closure: { ...baseSuccess.value.closure, boundaryMessageId: undefined } as any }
      }
      delete missingBoundary.value.closure.boundaryMessageId
      expect(() => validateChatDbResult('chatdb:fetch-context-closure', missingBoundary)).toThrow(ValidationError)
    })
    it('rejects totalTurnCount/selectedTurnCount <1 or non-integer', () => {
      for (const badVal of [0, -1, 1.5, '1' as any, null as any]) {
        const bad = {
          ...baseSuccess,
          value: {
            ...baseSuccess.value,
            closure: {
              ...baseSuccess.value.closure,
              totalTurnCount: badVal,
              selectedTurnCount: 1,
              boundaryMessageId: null
            } as any
          }
        }
        expect(() => validateChatDbResult('chatdb:fetch-context-closure', bad)).toThrow(ValidationError)
        const bad2 = {
          ...baseSuccess,
          value: {
            ...baseSuccess.value,
            closure: {
              ...baseSuccess.value.closure,
              totalTurnCount: 5,
              selectedTurnCount: badVal,
              boundaryMessageId: 'm1'
            } as any
          }
        }
        expect(() => validateChatDbResult('chatdb:fetch-context-closure', bad2)).toThrow(ValidationError)
      }
    })
    it('rejects selectedTurnCount > totalTurnCount', () => {
      const bad = {
        ...baseSuccess,
        value: {
          ...baseSuccess.value,
          closure: {
            ...baseSuccess.value.closure,
            totalTurnCount: 2,
            selectedTurnCount: 3,
            boundaryMessageId: 'm1'
          } as any
        }
      }
      expect(() => validateChatDbResult('chatdb:fetch-context-closure', bad)).toThrow(ValidationError)
    })
    it('rejects boundaryMessageId not null when selected===total (whole-topic)', () => {
      const bad = {
        ...baseSuccess,
        value: {
          ...baseSuccess.value,
          closure: {
            ...baseSuccess.value.closure,
            totalTurnCount: 2,
            selectedTurnCount: 2,
            boundaryMessageId: 'm1'
          } as any
        }
      }
      expect(() => validateChatDbResult('chatdb:fetch-context-closure', bad)).toThrow(ValidationError)
    })
    it('rejects boundaryMessageId null when selected<total (partial)', () => {
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
            lastMessageId: 'm2',
            returnedCount: 2,
            totalTurnCount: 5,
            selectedTurnCount: 2,
            boundaryMessageId: null
          }
        }
      }
      expect(() => validateChatDbResult('chatdb:fetch-context-closure', bad)).toThrow(ValidationError)
    })
    it('rejects boundaryMessageId not equal to firstMessageId when partial', () => {
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
            lastMessageId: 'm2',
            returnedCount: 2,
            totalTurnCount: 5,
            selectedTurnCount: 2,
            boundaryMessageId: 'wrong'
          }
        }
      }
      expect(() => validateChatDbResult('chatdb:fetch-context-closure', bad)).toThrow(ValidationError)
    })
    it('rejects unknown closure key for new fields', () => {
      const bad = {
        ...baseSuccess,
        value: { ...baseSuccess.value, closure: { ...baseSuccess.value.closure, extraField: 123 } as any }
      }
      expect(() => validateChatDbResult('chatdb:fetch-context-closure', bad)).toThrow(ValidationError)
    })
  })
})
