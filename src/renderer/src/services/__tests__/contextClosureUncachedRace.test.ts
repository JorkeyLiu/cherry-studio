import {
  bumpAndInvalidateAll,
  computeClosureFingerprint,
  getCachedContextClosure,
  getClosureLoadGeneration,
  getGlobalBlockGeneration,
  resetAllClosureStateForTests,
  setCachedContextClosureWithFingerprint
} from '@renderer/services/contextClosure'
import type { FetchContextClosureResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

function makeResp(topicId = 't-uncached', anchor = 'u1'): FetchContextClosureResponse {
  const messages = [
    { id: 'u1', role: 'user', topicId, blocks: ['b1'] },
    { id: 'a1', role: 'assistant', askId: 'u1', topicId, blocks: [] }
  ]
  return {
    messages: messages as any,
    blocks: [{ id: 'b1', messageId: 'u1', type: 'main_text', content: 'hi' }] as any,
    closure: {
      completeness: 'context-closure' as const,
      topicId,
      anchorGroupKey: anchor,
      firstMessageId: 'u1',
      lastMessageId: 'a1',
      returnedCount: 2,
      totalTurnCount: 1,
      selectedTurnCount: 1,
      boundaryMessageId: null
    }
  } as any
}

describe('uncached in-flight block mutation race (LOCK-R06-006 global epoch)', () => {
  beforeEach(() => {
    resetAllClosureStateForTests()
    vi.clearAllMocks()
  })

  it('deferred fetch: uncached topic, block mutation during fetch discards stale publication (no upsert, no cache)', async () => {
    const topicId = 't-uncached'
    const anchor = 'u1'
    // Ensure no cached closure
    expect(getCachedContextClosure(topicId)).toBeNull()
    expect(getGlobalBlockGeneration()).toBe(0)
    expect(getClosureLoadGeneration(topicId)).toBe(0)

    // Simulate hook fetch start: capture generation + global + fingerprint
    const generationAtFetch = getClosureLoadGeneration(topicId)
    const globalAtFetch = getGlobalBlockGeneration()
    const fingerprintAtFetch = computeClosureFingerprint([
      { id: 'u1', role: 'user', blocks: ['b1'] },
      { id: 'a1', role: 'assistant', askId: 'u1', blocks: [] }
    ] as any)

    // Deferred fetch promise (simulates dbService.fetchContextClosure)
    let resolveFetch: (v: FetchContextClosureResponse) => void
    const deferred = new Promise<FetchContextClosureResponse>((res) => {
      resolveFetch = res
    })

    // Start fetch (no await)
    const fetchPromise = deferred.then((response) => {
      // Hook's freshness re-read before publication (mirrors useContextClosure guard)
      const curGenNow = getClosureLoadGeneration(topicId)
      if (curGenNow !== generationAtFetch) return { published: false, reason: 'generation' }
      if (getGlobalBlockGeneration() !== globalAtFetch) return { published: false, reason: 'global' }
      // Simulate second guard before upsert
      if (getClosureLoadGeneration(topicId) !== generationAtFetch) return { published: false, reason: 'generation2' }
      if (getGlobalBlockGeneration() !== globalAtFetch) return { published: false, reason: 'global2' }
      // Would dispatch upsertManyBlocks and cache
      setCachedContextClosureWithFingerprint(topicId, response as any, fingerprintAtFetch)
      return { published: true }
    })

    // During in-flight, dispatch a block mutation (messageBlocks/*) -> bumpAndInvalidateAll advances global even though topic has no cache entry
    bumpAndInvalidateAll()
    expect(getGlobalBlockGeneration()).toBe(1)
    expect(getCachedContextClosure(topicId)).toBeNull() // still no cache, but global advanced

    // Resolve stale response (contains old blocks)
    const staleResp = makeResp(topicId, anchor)
    resolveFetch!(staleResp as any)
    const result = await fetchPromise

    // Must discard publication: no stale block upsert and no cache publication
    expect(result.published).toBe(false)
    expect(result.reason).toMatch(/global/)
    expect(getCachedContextClosure(topicId)).toBeNull()
  })

  it('same fetch without interleaving block mutation publishes successfully', async () => {
    const topicId = 't-uncached2'
    const anchor = 'u1'
    expect(getCachedContextClosure(topicId)).toBeNull()
    const generationAtFetch = getClosureLoadGeneration(topicId)
    const globalAtFetch = getGlobalBlockGeneration()
    const fp = computeClosureFingerprint([{ id: 'u1', role: 'user', blocks: [] }] as any)
    let resolveFetch: (v: FetchContextClosureResponse) => void
    const deferred = new Promise<FetchContextClosureResponse>((res) => {
      resolveFetch = res
    })
    const fetchPromise = deferred.then((response) => {
      if (getClosureLoadGeneration(topicId) !== generationAtFetch) return { published: false }
      if (getGlobalBlockGeneration() !== globalAtFetch) return { published: false }
      setCachedContextClosureWithFingerprint(topicId, response as any, fp)
      return { published: true }
    })
    // No block mutation during fetch
    const resp = makeResp(topicId, anchor)
    resolveFetch!(resp as any)
    const result = await fetchPromise
    expect(result.published).toBe(true)
    expect(getCachedContextClosure(topicId)).not.toBeNull()
    expect(getCachedContextClosure(topicId)?.closure.topicId).toBe(topicId)
  })

  it('bumpAndInvalidateAll advances global even when no cache entry exists (covers uncached active fetch)', () => {
    const topicId = 't-no-cache'
    expect(getCachedContextClosure(topicId)).toBeNull()
    const before = getGlobalBlockGeneration()
    bumpAndInvalidateAll()
    expect(getGlobalBlockGeneration()).toBe(before + 1)
    // Second bump also advances
    bumpAndInvalidateAll()
    expect(getGlobalBlockGeneration()).toBe(before + 2)
  })
})
