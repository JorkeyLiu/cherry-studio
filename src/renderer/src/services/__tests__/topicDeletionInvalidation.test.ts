import {
  clearAllLatestWindowCompleteness,
  getLatestWindowCompleteness,
  setLatestWindowCompleteness
} from '@renderer/pages/home/Messages/messageWindow'
import {
  clearAllContextClosureCache,
  getCachedContextClosure,
  getClosureLoadGeneration,
  resetAllClosureStateForTests,
  setCachedContextClosureWithFingerprint
} from '@renderer/services/contextClosure'
import {
  captureDeletionGeneration,
  getDeletionGeneration,
  invalidateTopicDeletion,
  invalidateTopicsDeletion,
  isDeletionStale,
  resetAllDeletionGenerationsForTests
} from '@renderer/services/topicDeletionInvalidation'
import type { FetchContextClosureResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it } from 'vitest'

function makeClosure(topicId: string, anchor: string): FetchContextClosureResponse {
  return {
    messages: [{ id: anchor, role: 'user' } as any, { id: 'a1', role: 'assistant', askId: anchor } as any],
    blocks: [],
    closure: {
      completeness: 'context-closure',
      topicId,
      anchorGroupKey: anchor,
      firstMessageId: anchor,
      lastMessageId: 'a1',
      returnedCount: 2
    }
  }
}

describe('topicDeletionInvalidation', () => {
  beforeEach(() => {
    resetAllDeletionGenerationsForTests()
    clearAllLatestWindowCompleteness()
    resetAllClosureStateForTests()
    clearAllContextClosureCache()
  })

  it('hard delete invalidates window completeness and closure cache', () => {
    const topicId = 't-hard-1'
    setLatestWindowCompleteness(topicId, { hasMoreBefore: true, hasMoreAfter: false })
    const closure = makeClosure(topicId, 'u1')
    setCachedContextClosureWithFingerprint(topicId, closure, 'fp-1')
    expect(getLatestWindowCompleteness(topicId)).toBeDefined()
    expect(getCachedContextClosure(topicId)).not.toBeNull()

    invalidateTopicDeletion(topicId)

    expect(getLatestWindowCompleteness(topicId)).toBeUndefined()
    expect(getCachedContextClosure(topicId)).toBeNull()
  })

  it('in-flight window discards when deletion advances generation', () => {
    const topicId = 't-inflight-window'
    const token = captureDeletionGeneration(topicId)
    expect(isDeletionStale(topicId, token)).toBe(false)
    invalidateTopicDeletion(topicId)
    expect(isDeletionStale(topicId, token)).toBe(true)
    expect(getDeletionGeneration(topicId)).toBe(1)
  })

  it('in-flight closure discards when deletion advances generation', () => {
    const topicId = 't-inflight-closure'
    const token = captureDeletionGeneration(topicId)
    // simulate fetch start captures closure generation and deletion token
    const closureGen = getClosureLoadGeneration(topicId)
    expect(closureGen).toBe(0)
    invalidateTopicDeletion(topicId)
    expect(isDeletionStale(topicId, token)).toBe(true)
    // closure generation should have been bumped via bumpAndInvalidate (plus precise Redux purges may bump further)
    expect(getClosureLoadGeneration(topicId)).toBeGreaterThanOrEqual(1)
  })

  it('bulk delete invalidates all affected topics', () => {
    const ids = ['t-bulk-1', 't-bulk-2', 't-bulk-3']
    for (const id of ids) {
      setLatestWindowCompleteness(id, { hasMoreBefore: true, hasMoreAfter: true })
      setCachedContextClosureWithFingerprint(id, makeClosure(id, 'u1'), 'fp')
    }
    invalidateTopicsDeletion(ids)
    for (const id of ids) {
      expect(getLatestWindowCompleteness(id)).toBeUndefined()
      expect(getCachedContextClosure(id)).toBeNull()
      expect(getDeletionGeneration(id)).toBe(1)
    }
  })

  it('empty bulk does not invalidate unrelated topics', () => {
    const unrelated = 't-unrelated'
    setLatestWindowCompleteness(unrelated, { hasMoreBefore: true, hasMoreAfter: false })
    setCachedContextClosureWithFingerprint(unrelated, makeClosure(unrelated, 'u1'), 'fp')
    invalidateTopicsDeletion([])
    expect(getLatestWindowCompleteness(unrelated)).toBeDefined()
    expect(getCachedContextClosure(unrelated)).not.toBeNull()
  })

  it('failure retention: no bump when deletion fails', () => {
    const topicId = 't-fail-retention'
    const token = captureDeletionGeneration(topicId)
    // simulate failure: do not call invalidate
    expect(isDeletionStale(topicId, token)).toBe(false)
    expect(getLatestWindowCompleteness(topicId)).toBeUndefined()
  })

  it('soft-delete preservation: no invalidation', () => {
    const topicId = 't-soft'
    setLatestWindowCompleteness(topicId, { hasMoreBefore: true, hasMoreAfter: false })
    setCachedContextClosureWithFingerprint(topicId, makeClosure(topicId, 'u1'), 'fp-soft')
    // soft delete does not call invalidate -> cache remains valid
    expect(getLatestWindowCompleteness(topicId)).toBeDefined()
    expect(getCachedContextClosure(topicId)).not.toBeNull()
    expect(getDeletionGeneration(topicId)).toBe(0)
  })

  it('generation is fail-closed before any join/action', () => {
    const topicId = 't-fail-closed'
    const token = captureDeletionGeneration(topicId)
    // simulate successful hard delete before join
    invalidateTopicDeletion(topicId)
    // any subsequent join should check stale and discard
    const shouldDiscard = isDeletionStale(topicId, token)
    expect(shouldDiscard).toBe(true)
  })
})
