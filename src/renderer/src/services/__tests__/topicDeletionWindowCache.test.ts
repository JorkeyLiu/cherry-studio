import {
  captureDeletionGeneration,
  getDeletionGeneration,
  resetAllDeletionGenerationsForTests,
  subscribeDeletionGeneration
} from '@renderer/services/topicDeletionInvalidation'
import { beforeEach, describe, expect, it } from 'vitest'

describe('topicDeletion mounted Messages windowCache immediate invalidation', () => {
  beforeEach(() => {
    resetAllDeletionGenerationsForTests()
  })

  it('populated windowCache for deleted topic is cleared immediately on generation advance without new load; unrelated topic cache preserved', async () => {
    // Simulate Messages.windowCacheRef per mounted instance: Map<topicId, FetchMessagesWindowResponse>
    const windowCacheRef = { current: new Map<string, unknown>() }
    const topicDeleted = 't-cache-deleted'
    const topicOther = 't-cache-other'

    // Populate cache for both topics (as loadMoreMessages would after successful window fetch)
    const fakeWindowDeleted = {
      window: { topicId: topicDeleted, kind: 'around', anchorMessageId: 'm1', before: 10, after: 1 },
      messages: [],
      blocks: []
    }
    const fakeWindowOther = {
      window: { topicId: topicOther, kind: 'around', anchorMessageId: 'm2', before: 10, after: 1 },
      messages: [],
      blocks: []
    }
    windowCacheRef.current.set(topicDeleted, fakeWindowDeleted)
    windowCacheRef.current.set(topicOther, fakeWindowOther)
    expect(windowCacheRef.current.has(topicDeleted)).toBe(true)
    expect(windowCacheRef.current.has(topicOther)).toBe(true)

    // Mounted Messages instance subscribes for its topic (topicDeleted)
    const unsubscribe = subscribeDeletionGeneration(topicDeleted, () => {
      windowCacheRef.current.delete(topicDeleted)
    })

    // Other topic subscription (simulating another Messages instance for other topic) should not clear deleted's cache
    const unsubscribeOther = subscribeDeletionGeneration(topicOther, () => {
      windowCacheRef.current.delete(topicOther)
    })

    // Simulate authoritative deletion: bump generation for topicDeleted
    // This mimics topicDeletionInvalidation.bumpDeletionGeneration -> notify
    const { bumpDeletionGeneration } = await import('@renderer/services/topicDeletionInvalidation')
    const genBefore = getDeletionGeneration(topicDeleted)
    expect(genBefore).toBe(0)
    bumpDeletionGeneration(topicDeleted)
    expect(getDeletionGeneration(topicDeleted)).toBe(1)

    // Without any new load, the deleted topic's window cache must be cleared immediately
    expect(windowCacheRef.current.has(topicDeleted)).toBe(false)
    // Unrelated topic's cache must remain (per-topic precise, not global clear)
    expect(windowCacheRef.current.has(topicOther)).toBe(true)

    // Capture generation staleness ensures in-flight around-window would discard
    const captured = captureDeletionGeneration(topicOther)
    bumpDeletionGeneration(topicOther)
    expect(windowCacheRef.current.has(topicOther)).toBe(false)
    expect(captureDeletionGeneration(topicOther) !== captured).toBe(true)

    unsubscribe()
    unsubscribeOther()
  })

  it('subscription is per-topic and unsubscribe stops clearing', async () => {
    const windowCacheRef = { current: new Map<string, unknown>() }
    const topicId = 't-sub-unsub'
    windowCacheRef.current.set(topicId, { window: {} })
    const { bumpDeletionGeneration } = await import('@renderer/services/topicDeletionInvalidation')
    let callCount = 0
    const unsub = subscribeDeletionGeneration(topicId, () => {
      callCount++
      windowCacheRef.current.delete(topicId)
    })
    bumpDeletionGeneration(topicId)
    expect(callCount).toBe(1)
    expect(windowCacheRef.current.has(topicId)).toBe(false)
    // Re-populate and unsubscribe, then bump again should not fire
    windowCacheRef.current.set(topicId, { window: {} })
    unsub()
    bumpDeletionGeneration(topicId)
    expect(callCount).toBe(1)
    expect(windowCacheRef.current.has(topicId)).toBe(true)
  })
})
