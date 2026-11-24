import { getGlobalBlockGeneration, resetAllClosureStateForTests } from '@renderer/services/contextClosure'
import type { AppendMessageResponse, UpdateMessageAndBlocksResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  consumeAppendAckInvalidation,
  consumeUpdateAckInvalidation,
  isAuthorityInvalidationEffect
} from '../authorityInvalidation'

// The consume helpers always invalidate conservatively on a real success ack
// (scope 'all' bump); a malformed effect on a success ack still bumps to avoid
// serving stale closures. Only a non-ack (null/undefined — unwrap would have
// thrown before reaching the helper) consumes nothing.

function appendAck(effect: unknown): AppendMessageResponse {
  return {
    topicId: 't-1',
    branchId: null,
    messageId: 'm-1',
    createdMessageIds: ['m-1'],
    mutableMessageIds: ['m-1'],
    contextInvalidation: effect as AppendMessageResponse['contextInvalidation']
  }
}

function updateAck(effect: unknown): UpdateMessageAndBlocksResponse {
  return {
    affectedFileIds: [],
    remainingReferenceCounts: {},
    contextInvalidation: effect as UpdateMessageAndBlocksResponse['contextInvalidation']
  }
}

describe('isAuthorityInvalidationEffect', () => {
  it('accepts exactly { scope: all }', () => {
    expect(isAuthorityInvalidationEffect({ scope: 'all' })).toBe(true)
  })

  it('rejects missing scope, unknown scope, unknown keys, and non-objects', () => {
    for (const v of [{}, { scope: 'partial' }, { scope: 'all', revision: 1 }, { revision: 1 }]) {
      expect(isAuthorityInvalidationEffect(v)).toBe(false)
    }
    for (const v of [null, undefined, 'all', 42, ['all'], new Date()]) {
      expect(isAuthorityInvalidationEffect(v)).toBe(false)
    }
  })
})

describe('consumeAppendAckInvalidation', () => {
  beforeEach(() => {
    resetAllClosureStateForTests()
  })

  it('bumps once and reports true for a well-formed success ack', () => {
    const before = getGlobalBlockGeneration()
    expect(consumeAppendAckInvalidation(appendAck({ scope: 'all' }))).toBe(true)
    expect(getGlobalBlockGeneration()).toBe(before + 1)
  })

  it('bumps conservatively and reports false for a malformed effect on a success ack', () => {
    const before = getGlobalBlockGeneration()
    expect(consumeAppendAckInvalidation(appendAck({ scope: 'partial' }))).toBe(false)
    expect(getGlobalBlockGeneration()).toBe(before + 1)
  })

  it('does not bump for a non-ack (Main failure never reaches the helper)', () => {
    const before = getGlobalBlockGeneration()
    expect(consumeAppendAckInvalidation(null)).toBe(false)
    expect(consumeAppendAckInvalidation(undefined)).toBe(false)
    expect(getGlobalBlockGeneration()).toBe(before)
  })

  it('never throws: a bump failure still reports without breaking the write path', () => {
    const before = getGlobalBlockGeneration()
    // A frozen ack object must not break consumption.
    const frozen = Object.freeze(appendAck({ scope: 'all' }))
    expect(consumeAppendAckInvalidation(frozen)).toBe(true)
    expect(getGlobalBlockGeneration()).toBe(before + 1)
    expect(() => consumeAppendAckInvalidation(appendAck({ scope: 'all' }) as unknown as null)).not.toThrow()
  })
})

describe('consumeUpdateAckInvalidation', () => {
  beforeEach(() => {
    resetAllClosureStateForTests()
  })

  it('bumps once and reports true for a well-formed success response', () => {
    const before = getGlobalBlockGeneration()
    expect(consumeUpdateAckInvalidation(updateAck({ scope: 'all' }))).toBe(true)
    expect(getGlobalBlockGeneration()).toBe(before + 1)
  })

  it('bumps conservatively and reports false for a malformed effect on a success response', () => {
    const before = getGlobalBlockGeneration()
    expect(consumeUpdateAckInvalidation(updateAck({ scope: 'topic' }))).toBe(false)
    expect(getGlobalBlockGeneration()).toBe(before + 1)
  })

  it('does not bump for a non-response', () => {
    const before = getGlobalBlockGeneration()
    expect(consumeUpdateAckInvalidation(null)).toBe(false)
    expect(consumeUpdateAckInvalidation(undefined)).toBe(false)
    expect(getGlobalBlockGeneration()).toBe(before)
  })
})
