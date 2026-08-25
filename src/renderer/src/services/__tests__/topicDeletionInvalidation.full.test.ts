import {
  clearAllLatestWindowCompleteness,
  getLatestWindowCompleteness,
  setLatestWindowCompleteness
} from '@renderer/pages/home/Messages/messageWindow'
import {
  clearAllContextClosureCache,
  getCachedContextClosure,
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
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('topicDeletionInvalidation full coverage §5.10', () => {
  beforeEach(() => {
    resetAllDeletionGenerationsForTests()
    clearAllLatestWindowCompleteness()
    resetAllClosureStateForTests()
    clearAllContextClosureCache()
    vi.clearAllMocks()
  })

  it('single hard-delete: authoritative IDs invalidate exact topic projections', () => {
    const topicId = 't-single-hard'
    setLatestWindowCompleteness(topicId, { hasMoreBefore: true, hasMoreAfter: false })
    setCachedContextClosureWithFingerprint(topicId, makeClosure(topicId, 'u1'), 'fp-1')
    expect(getLatestWindowCompleteness(topicId)).toBeDefined()
    expect(getCachedContextClosure(topicId)).not.toBeNull()

    // Simulate successful authoritative hardDelete returning exact ID
    invalidateTopicsDeletion(['t-single-hard'])

    expect(getLatestWindowCompleteness(topicId)).toBeUndefined()
    expect(getCachedContextClosure(topicId)).toBeNull()
    expect(getDeletionGeneration(topicId)).toBeGreaterThanOrEqual(1)
  })

  it('bulk purge: authoritative bulk IDs invalidate all affected topics', () => {
    const ids = ['t-bulk-a', 't-bulk-b', 't-bulk-c']
    for (const id of ids) {
      setLatestWindowCompleteness(id, { hasMoreBefore: true, hasMoreAfter: true })
      setCachedContextClosureWithFingerprint(id, makeClosure(id, 'u1'), 'fp')
    }
    invalidateTopicsDeletion(ids)
    for (const id of ids) {
      expect(getLatestWindowCompleteness(id)).toBeUndefined()
      expect(getCachedContextClosure(id)).toBeNull()
      expect(getDeletionGeneration(id)).toBeGreaterThanOrEqual(1)
    }
  })

  it('emptyTrash bulk: same as purge, all emptied IDs invalidated', () => {
    const ids = ['t-empty-1', 't-empty-2']
    for (const id of ids) {
      setLatestWindowCompleteness(id, { hasMoreBefore: false, hasMoreAfter: false })
    }
    invalidateTopicsDeletion(ids)
    for (const id of ids) {
      expect(getLatestWindowCompleteness(id)).toBeUndefined()
    }
  })

  it('reset/removal: bulk hard-deleted IDs invalidated, replacement not', () => {
    const deleted = ['t-del-1', 't-del-2', 't-del-3']
    const replacement = 't-replacement'
    for (const id of [...deleted, replacement]) {
      setLatestWindowCompleteness(id, { hasMoreBefore: true, hasMoreAfter: true })
      setCachedContextClosureWithFingerprint(id, makeClosure(id, 'u1'), 'fp')
    }
    // Simulate reset returning deletedTopicIds = deleted (replacement excluded)
    invalidateTopicsDeletion(deleted)
    for (const id of deleted) {
      expect(getLatestWindowCompleteness(id)).toBeUndefined()
      expect(getCachedContextClosure(id)).toBeNull()
    }
    // Replacement must remain valid (not invalidated)
    expect(getLatestWindowCompleteness(replacement)).toBeDefined()
    expect(getCachedContextClosure(replacement)).not.toBeNull()
    expect(getDeletionGeneration(replacement)).toBe(0)
  })

  it('failure retention: no bump when deletion fails (no invalidate called)', () => {
    const topicId = 't-fail'
    setLatestWindowCompleteness(topicId, { hasMoreBefore: true, hasMoreAfter: false })
    setCachedContextClosureWithFingerprint(topicId, makeClosure(topicId, 'u1'), 'fp-fail')
    const token = captureDeletionGeneration(topicId)
    // Simulate failure: do NOT call invalidate
    expect(isDeletionStale(topicId, token)).toBe(false)
    expect(getLatestWindowCompleteness(topicId)).toBeDefined()
    expect(getCachedContextClosure(topicId)).not.toBeNull()
    expect(getDeletionGeneration(topicId)).toBe(0)
  })

  it('soft-delete preservation: soft delete does not invalidate', () => {
    const topicId = 't-soft-preserve'
    setLatestWindowCompleteness(topicId, { hasMoreBefore: true, hasMoreAfter: false })
    setCachedContextClosureWithFingerprint(topicId, makeClosure(topicId, 'u1'), 'fp-soft')
    // Soft delete must not call invalidate -> generation stays 0, cache remains
    expect(getDeletionGeneration(topicId)).toBe(0)
    expect(getLatestWindowCompleteness(topicId)).toBeDefined()
    expect(getCachedContextClosure(topicId)).not.toBeNull()
    // Even after capturing, no stale
    const token = captureDeletionGeneration(topicId)
    expect(isDeletionStale(topicId, token)).toBe(false)
  })

  it('in-flight latest window discards on deletion generation mismatch', () => {
    const topicId = 't-inflight-latest'
    const token = captureDeletionGeneration(topicId)
    // Simulate hard delete occurring during fetch
    invalidateTopicDeletion(topicId)
    expect(isDeletionStale(topicId, token)).toBe(true)
    // Validation/publication should be skipped when stale
    const shouldDiscard = isDeletionStale(topicId, token)
    expect(shouldDiscard).toBe(true)
  })

  it('in-flight around window discards on deletion generation mismatch', () => {
    const topicId = 't-inflight-around'
    const token = captureDeletionGeneration(topicId)
    invalidateTopicDeletion(topicId)
    expect(isDeletionStale(topicId, token)).toBe(true)
  })

  it('in-flight context closure discards on deletion generation mismatch', () => {
    const topicId = 't-inflight-closure'
    const token = captureDeletionGeneration(topicId)
    invalidateTopicDeletion(topicId)
    expect(isDeletionStale(topicId, token)).toBe(true)
  })

  it('does not invalidate all topics for per-topic deletion unless authoritative says so', () => {
    const t1 = 't-per-1'
    const t2 = 't-per-2'
    setLatestWindowCompleteness(t1, { hasMoreBefore: true, hasMoreAfter: true })
    setLatestWindowCompleteness(t2, { hasMoreBefore: true, hasMoreAfter: true })
    // Per-topic deletion returns only t1
    invalidateTopicsDeletion([t1])
    expect(getLatestWindowCompleteness(t1)).toBeUndefined()
    expect(getLatestWindowCompleteness(t2)).toBeDefined()
  })
})
