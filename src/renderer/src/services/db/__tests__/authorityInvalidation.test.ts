import {
  computeClosureFingerprint,
  getCachedContextClosure,
  getClosureLoadGeneration,
  getFreshValidatedClosure,
  getGlobalBlockGeneration,
  isAcceptedClosureForRoute,
  resetAllClosureStateForTests,
  setCachedContextClosureWithFingerprint,
  subscribeClosureInvalidations
} from '@renderer/services/contextClosure'
import type { AppendMessageResponse, FetchContextClosureResponse, UpdateMessageAndBlocksResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  consumeAppendAckInvalidation,
  consumeUpdateAckInvalidation,
  isAuthorityInvalidationEffect
} from '../authorityInvalidation'

const source = 't-source'
const target = 't-target'
const unrelated = 't-unrelated'
const sourceBranch = 'b-source'
const uncachedBranch = 'b-in-flight'
const anchor = 'u1'

function makeResp(topicId: string, messageId = 'u1'): FetchContextClosureResponse {
  return {
    messages: [
      { id: messageId, role: 'user', topicId, blocks: [] },
      { id: `a-${messageId}`, role: 'assistant', askId: messageId, topicId, blocks: [] }
    ],
    blocks: [],
    closure: {
      completeness: 'context-closure',
      topicId,
      anchorGroupKey: messageId,
      firstMessageId: messageId,
      lastMessageId: `a-${messageId}`,
      returnedCount: 2,
      totalTurnCount: 1,
      selectedTurnCount: 1,
      foldedMessageIds: [],
      boundaryMessageId: null
    }
  } as FetchContextClosureResponse
}

function appendAck(effect: unknown): AppendMessageResponse {
  return {
    topicId: source,
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

function seedFresh(topicId: string, branchId?: string | null): FetchContextClosureResponse {
  const response = makeResp(topicId)
  const fingerprint = computeClosureFingerprint(response.messages as any)
  setCachedContextClosureWithFingerprint(topicId, response, fingerprint, branchId)
  expect(getFreshValidatedClosure(topicId, anchor, fingerprint, branchId)).toBe(response)
  return response
}

function seedRoutes(): void {
  seedFresh(source)
  seedFresh(source, sourceBranch)
  seedFresh(target)
  seedFresh(unrelated)
  // Registered but never cached: this is the in-flight branch race boundary.
  expect(getClosureLoadGeneration(source, uncachedBranch)).toBe(0)
}

describe('isAuthorityInvalidationEffect', () => {
  it('accepts exactly a non-empty duplicate-free topic set', () => {
    expect(isAuthorityInvalidationEffect({ scope: 'topics', topicIds: [source, target] })).toBe(true)
  })

  it('rejects the legacy global shape, malformed sets, unknown keys, and non-objects', () => {
    for (const v of [
      {},
      { scope: 'all' },
      { scope: 'partial', topicIds: [source] },
      { scope: 'topics' },
      { scope: 'topics', topicIds: [] },
      { scope: 'topics', topicIds: source },
      { scope: 'topics', topicIds: [''] },
      { scope: 'topics', topicIds: ['  '] },
      { scope: 'topics', topicIds: [42] },
      { scope: 'topics', topicIds: [source, source] },
      { scope: 'topics', topicIds: [source], revision: 1 }
    ]) {
      expect(isAuthorityInvalidationEffect(v)).toBe(false)
    }
    for (const v of [null, undefined, 'topics', 42, [], new Date()]) {
      expect(isAuthorityInvalidationEffect(v)).toBe(false)
    }
  })
})

type AuthorityAck = AppendMessageResponse | UpdateMessageAndBlocksResponse

describe.each([
  {
    label: 'append',
    makeAck: (effect: unknown): AuthorityAck => appendAck(effect),
    consume: (ack: AuthorityAck | null | undefined) => consumeAppendAckInvalidation(ack as AppendMessageResponse | null)
  },
  {
    label: 'update',
    makeAck: (effect: unknown): AuthorityAck => updateAck(effect),
    consume: (ack: AuthorityAck | null | undefined) =>
      consumeUpdateAckInvalidation(ack as UpdateMessageAndBlocksResponse | null)
  }
])('$label authority acknowledgment', ({ makeAck, consume }) => {
  beforeEach(() => {
    resetAllClosureStateForTests()
    seedRoutes()
  })

  it('invalidates source + target routes exactly once while unrelated cache and in-flight guards remain fresh', () => {
    const unrelatedResponse = getCachedContextClosure(unrelated)
    const unrelatedGenerationBefore = getClosureLoadGeneration(unrelated)
    const sourceGenerationBefore = getClosureLoadGeneration(source)
    const targetGenerationBefore = getClosureLoadGeneration(target)
    const uncachedGenerationBefore = getClosureLoadGeneration(source, uncachedBranch)
    const globalBeforeValid = getGlobalBlockGeneration()
    const validListener = vi.fn()
    const unsubscribeValid = subscribeClosureInvalidations(validListener)

    expect(consume(makeAck({ scope: 'topics', topicIds: [source, target] }))).toBe(true)
    unsubscribeValid()

    expect(getClosureLoadGeneration(source)).toBe(sourceGenerationBefore + 1)
    expect(getClosureLoadGeneration(source, sourceBranch)).toBe(1)
    expect(getClosureLoadGeneration(source, uncachedBranch)).toBe(uncachedGenerationBefore + 1)
    expect(getClosureLoadGeneration(target)).toBe(targetGenerationBefore + 1)
    expect(getClosureLoadGeneration(unrelated)).toBe(unrelatedGenerationBefore)
    expect(getCachedContextClosure(source)).toBeNull()
    expect(getCachedContextClosure(source, sourceBranch)).toBeNull()
    expect(getCachedContextClosure(target)).toBeNull()
    expect(getCachedContextClosure(unrelated)).toBe(unrelatedResponse)
    expect(getFreshValidatedClosure(unrelated, anchor)).toBe(unrelatedResponse)
    expect(getGlobalBlockGeneration()).toBe(globalBeforeValid)
    expect(validListener).toHaveBeenCalledOnce()
  })

  it('rejects stale affected in-flight publication but permits unrelated publication', async () => {
    const sourceAtFetch = getClosureLoadGeneration(source, uncachedBranch)
    const unrelatedAtFetch = getClosureLoadGeneration(unrelated)
    const globalAtFetch = getGlobalBlockGeneration()

    expect(consume(makeAck({ scope: 'topics', topicIds: [source, target] }))).toBe(true)

    const publish = async (topicId: string, branchId: string | null, generationAtFetch: number) => {
      const response = makeResp(topicId, 'u-new')
      const fingerprint = computeClosureFingerprint(response.messages as any)
      if (getClosureLoadGeneration(topicId, branchId) !== generationAtFetch) return false
      if (getGlobalBlockGeneration() !== globalAtFetch) return false
      setCachedContextClosureWithFingerprint(topicId, response, fingerprint, branchId)
      return true
    }

    await expect(publish(source, uncachedBranch, sourceAtFetch)).resolves.toBe(false)
    expect(getCachedContextClosure(source, uncachedBranch)).toBeNull()
    await expect(publish(unrelated, null, unrelatedAtFetch)).resolves.toBe(true)
    expect(getFreshValidatedClosure(unrelated, 'u-new')?.closure.topicId).toBe(unrelated)
  })

  it('retains an already-accepted UI closure while strict cache freshness requires revalidation', () => {
    const accepted = getCachedContextClosure(source)
    expect(consume(makeAck({ scope: 'topics', topicIds: [source, target] }))).toBe(true)
    expect(getFreshValidatedClosure(source, anchor)).toBeNull()
    expect(isAcceptedClosureForRoute(accepted, source, anchor)).toBe(true)
  })

  it('falls back globally for a malformed success effect but never mutates a frozen ack', () => {
    const malformed = Object.freeze(makeAck({ scope: 'all' }))
    const before = getGlobalBlockGeneration()
    expect(consume(malformed)).toBe(false)
    expect(getGlobalBlockGeneration()).toBe(before + 1)
    expect(malformed.contextInvalidation).toEqual({ scope: 'all' })
  })

  it('does nothing for a non-ack because unwrap rejects Main failures first', () => {
    const before = getGlobalBlockGeneration()
    expect(consume(null)).toBe(false)
    expect(consume(undefined)).toBe(false)
    expect(getGlobalBlockGeneration()).toBe(before)
    expect(getClosureLoadGeneration(source)).toBe(0)
    expect(getFreshValidatedClosure(source, anchor)).not.toBeNull()
  })
})
