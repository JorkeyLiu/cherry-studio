import { describe, expect, it } from 'vitest'

import { getContract, validateChatDbRequest, validateChatDbResult, ValidationError } from '../index'

const DELETE_CHANNEL = 'chatdb:delete-clipboard-tree'

function deleteSnapshot(): Record<string, unknown> {
  return {
    kind: 'clipboard-tree',
    mode: 'delete',
    idMap: [],
    placement: {
      topicId: 't1',
      branchId: null,
      intent: { kind: 'topic-tail' },
      ownerIndex: 0,
      prevOwnerMessageId: null,
      nextOwnerMessageId: 'uB'
    },
    inserted: { messages: [], blocks: [], branches: [], segments: [] },
    sourceRemoved: {
      topicId: 't1',
      branchId: null,
      branches: [],
      messages: [
        {
          id: 'uA',
          topicId: 't1',
          branchId: null,
          role: 'user',
          content: 'c-uA',
          status: 'success',
          askId: null,
          model: null,
          modelId: null,
          assistantId: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          sortOrder: 0,
          overflow: {}
        }
      ],
      blocks: [],
      fileReferences: [],
      segments: [],
      segmentsAfter: [],
      segmentOrder: [],
      ownerOrders: [{ branchId: null, orderedIds: ['uA', 'uB'] }],
      boundaries: []
    }
  }
}

function deleteResultValue(): Record<string, unknown> {
  return {
    affectedFileIds: [],
    remainingReferenceCounts: {},
    topicId: 't1',
    branchId: null,
    deletedMessageIds: ['uA'],
    deletedBranchIds: [],
    snapshot: deleteSnapshot(),
    projections: []
  }
}

const CHANNEL = 'chatdb:fetch-clipboard-tree'

const validBranchOwned = () => ({ topicId: 't1', branchId: 'b-1', capture: 'branch-owned' as const })

const validGroups = () => ({ topicId: 't1', groupIds: ['uA'] })

describe('fetch-clipboard-tree request union', () => {
  it('registers the channel in the contract registry', () => {
    expect(getContract(CHANNEL)).toBeDefined()
  })

  it('accepts the branch-owned shape', () => {
    expect(() => validateChatDbRequest(CHANNEL, validBranchOwned())).not.toThrow()
  })

  it('accepts the selection shape, with and without an explicit route', () => {
    expect(() => validateChatDbRequest(CHANNEL, validGroups())).not.toThrow()
    expect(() => validateChatDbRequest(CHANNEL, { ...validGroups(), branchId: null })).not.toThrow()
    expect(() => validateChatDbRequest(CHANNEL, { ...validGroups(), branchId: 'b-1' })).not.toThrow()
    expect(() => validateChatDbRequest(CHANNEL, { topicId: 't1', groupIds: ['uA', 'a1', 'uB'] })).not.toThrow()
  })

  it('rejects a request that mixes both capture shapes', () => {
    expect(() => validateChatDbRequest(CHANNEL, { ...validBranchOwned(), groupIds: ['uA'] })).toThrow(ValidationError)
    expect(() => validateChatDbRequest(CHANNEL, { ...validBranchOwned(), groupIds: [] })).toThrow(ValidationError)
  })

  it('rejects an unknown capture discriminant', () => {
    expect(() => validateChatDbRequest(CHANNEL, { topicId: 't1', branchId: 'b-1', capture: 'branch' })).toThrow(
      ValidationError
    )
    expect(() => validateChatDbRequest(CHANNEL, { topicId: 't1', branchId: 'b-1', capture: 'branch-own' })).toThrow(
      ValidationError
    )
    expect(() => validateChatDbRequest(CHANNEL, { topicId: 't1', branchId: 'b-1', capture: 'group-ids' })).toThrow(
      ValidationError
    )
    // A non-string discriminant is equally rejected rather than coerced.
    expect(() => validateChatDbRequest(CHANNEL, { topicId: 't1', branchId: 'b-1', capture: 1 })).toThrow(
      ValidationError
    )
  })

  it('rejects a branch-owned shape without an explicit non-empty branchId', () => {
    expect(() => validateChatDbRequest(CHANNEL, { topicId: 't1', capture: 'branch-owned' })).toThrow(ValidationError)
    expect(() => validateChatDbRequest(CHANNEL, { topicId: 't1', branchId: '', capture: 'branch-owned' })).toThrow(
      ValidationError
    )
    expect(() => validateChatDbRequest(CHANNEL, { topicId: 't1', branchId: null, capture: 'branch-owned' })).toThrow(
      ValidationError
    )
  })

  it('rejects a selection shape with missing, empty or duplicate groupIds', () => {
    expect(() => validateChatDbRequest(CHANNEL, { topicId: 't1' })).toThrow(ValidationError)
    expect(() => validateChatDbRequest(CHANNEL, { topicId: 't1', groupIds: [] })).toThrow(ValidationError)
    expect(() => validateChatDbRequest(CHANNEL, { topicId: 't1', groupIds: ['uA', 'uA'] })).toThrow(ValidationError)
    expect(() => validateChatDbRequest(CHANNEL, { topicId: 't1', groupIds: [''] })).toThrow(ValidationError)
  })

  it('rejects unknown keys in both shapes', () => {
    expect(() => validateChatDbRequest(CHANNEL, { ...validBranchOwned(), extra: 1 })).toThrow(ValidationError)
    expect(() => validateChatDbRequest(CHANNEL, { ...validGroups(), extra: 1 })).toThrow(ValidationError)
  })

  it('requires a non-empty topicId in both shapes', () => {
    expect(() => validateChatDbRequest(CHANNEL, { topicId: '', branchId: 'b-1', capture: 'branch-owned' })).toThrow(
      ValidationError
    )
    expect(() => validateChatDbRequest(CHANNEL, { topicId: '', groupIds: ['uA'] })).toThrow(ValidationError)
  })
})

describe('delete-clipboard-tree request and result', () => {
  it('registers the channel in the contract registry', () => {
    expect(getContract(DELETE_CHANNEL)).toBeDefined()
  })

  it('accepts a main-route and an explicit branch route request', () => {
    expect(() =>
      validateChatDbRequest(DELETE_CHANNEL, { topicId: 't1', branchId: null, groupIds: ['uA'] })
    ).not.toThrow()
    expect(() =>
      validateChatDbRequest(DELETE_CHANNEL, { topicId: 't1', branchId: 'b-1', groupIds: ['uA', 'a1'] })
    ).not.toThrow()
  })

  it('rejects a request without an explicit route or with bad groupIds', () => {
    expect(() => validateChatDbRequest(DELETE_CHANNEL, { topicId: 't1', groupIds: ['uA'] })).toThrow(ValidationError)
    expect(() => validateChatDbRequest(DELETE_CHANNEL, { topicId: 't1', branchId: '', groupIds: ['uA'] })).toThrow(
      ValidationError
    )
    expect(() => validateChatDbRequest(DELETE_CHANNEL, { topicId: 't1', branchId: null, groupIds: [] })).toThrow(
      ValidationError
    )
    expect(() =>
      validateChatDbRequest(DELETE_CHANNEL, { topicId: 't1', branchId: null, groupIds: ['uA', 'uA'] })
    ).toThrow(ValidationError)
    expect(() => validateChatDbRequest(DELETE_CHANNEL, { topicId: '', branchId: null, groupIds: ['uA'] })).toThrow(
      ValidationError
    )
    expect(() =>
      validateChatDbRequest(DELETE_CHANNEL, { topicId: 't1', branchId: null, groupIds: ['uA'], extra: 1 })
    ).toThrow(ValidationError)
  })

  it('accepts a complete delete result value', () => {
    expect(() => validateChatDbResult(DELETE_CHANNEL, { ok: true, value: deleteResultValue() })).not.toThrow()
  })

  it('rejects a delete result whose snapshot inserts or drops its removal rows', () => {
    const withInsert = deleteResultValue()
    ;(withInsert.snapshot as Record<string, unknown>).inserted = {
      messages: [{ id: 'x' }],
      blocks: [],
      branches: [],
      segments: []
    }
    expect(() => validateChatDbResult(DELETE_CHANNEL, { ok: true, value: withInsert })).toThrow(ValidationError)
    const withoutRemoval = deleteResultValue()
    ;(withoutRemoval.snapshot as Record<string, unknown>).sourceRemoved = null
    expect(() => validateChatDbResult(DELETE_CHANNEL, { ok: true, value: withoutRemoval })).toThrow(ValidationError)
  })

  it('rejects a delete result with an extra or missing value key', () => {
    expect(() =>
      validateChatDbResult(DELETE_CHANNEL, { ok: true, value: { ...deleteResultValue(), extra: 1 } })
    ).toThrow(ValidationError)
    const missingKey = deleteResultValue()
    delete missingKey.deletedBranchIds
    expect(() => validateChatDbResult(DELETE_CHANNEL, { ok: true, value: missingKey })).toThrow(ValidationError)
  })
})
