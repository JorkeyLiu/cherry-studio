import {
  bumpAndInvalidate,
  bumpAndInvalidateAll,
  computeClosureFingerprint,
  ensureClosureGeneration,
  getCachedContextClosure,
  getClosureLoadGeneration,
  getFreshValidatedClosure,
  getGlobalBlockGeneration,
  resetAllClosureStateForTests,
  setCachedContextClosureWithFingerprint
} from '@renderer/services/contextClosure'
import { closureInvalidationMiddleware } from '@renderer/store'
import { markClosureReadOnly, withClosureTopics } from '@renderer/store/closureOwnership'
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

  it('fresh branch race: bare-topic mutation rejects original uncached in-flight, post-mutation fetch accepted; sibling invalidated, unrelated + read-only retained', async () => {
    const topicId = 't-parent-race'
    const freshBranch = 'b-fresh'
    const sibBranch = 'b-sib'
    const anchor = 'u1'
    const otherTopic = 't-unrelated'

    // Fresh branch has never been cached; authority read registers its generation (init-only).
    expect(getCachedContextClosure(topicId, freshBranch)).toBeNull()
    ensureClosureGeneration(topicId, freshBranch)
    const generationAtFetch = getClosureLoadGeneration(topicId, freshBranch)
    const globalAtFetch = getGlobalBlockGeneration()
    expect(generationAtFetch).toBe(0)
    // Read-start path also registers (miss, but tracked for later bare-topic bump).
    expect(getFreshValidatedClosure(topicId, anchor, undefined, freshBranch)).toBeNull()
    expect(getClosureLoadGeneration(topicId, freshBranch)).toBe(0)

    // Seed cached sibling routes + unrelated topic (all fresh before mutation).
    const fp = computeClosureFingerprint([{ id: 'u1', role: 'user', blocks: [] }] as any)
    setCachedContextClosureWithFingerprint(topicId, makeResp(topicId, anchor), fp, null)
    setCachedContextClosureWithFingerprint(topicId, makeResp(topicId, anchor), fp, sibBranch)
    setCachedContextClosureWithFingerprint(otherTopic, makeResp(otherTopic, anchor), fp)
    expect(getFreshValidatedClosure(topicId, anchor, undefined, null)).not.toBeNull()
    expect(getFreshValidatedClosure(topicId, anchor, undefined, sibBranch)).not.toBeNull()
    expect(getFreshValidatedClosure(otherTopic, anchor, undefined, null)).not.toBeNull()

    // Uncached branch in-flight fetch dispatched after the read.
    let resolveFetch: (v: FetchContextClosureResponse) => void
    const deferred = new Promise<FetchContextClosureResponse>((res) => {
      resolveFetch = res
    })
    const fetchPromise = deferred.then((response) => {
      if (getClosureLoadGeneration(topicId, freshBranch) !== generationAtFetch) {
        return { published: false, reason: 'generation' }
      }
      if (getGlobalBlockGeneration() !== globalAtFetch) return { published: false, reason: 'global' }
      setCachedContextClosureWithFingerprint(topicId, response as any, fp, freshBranch)
      return { published: true }
    })

    // Parent-prefix mutation between dispatch and publication (bare-topic).
    bumpAndInvalidate(topicId)

    // Original snapshot must be rejected (branch bumped 0 -> 1 even though never cached).
    expect(getClosureLoadGeneration(topicId, freshBranch)).not.toBe(generationAtFetch)
    resolveFetch!(makeResp(topicId, anchor) as any)
    const staleResult = await fetchPromise
    expect(staleResult.published).toBe(false)
    expect(getCachedContextClosure(topicId, freshBranch)).toBeNull()

    // Parent mutation invalidates cached sibling routes, not unrelated topics.
    expect(getFreshValidatedClosure(topicId, anchor, undefined, null)).toBeNull()
    expect(getFreshValidatedClosure(topicId, anchor, undefined, sibBranch)).toBeNull()
    expect(getFreshValidatedClosure(otherTopic, anchor, undefined, null)).not.toBeNull()

    // Post-mutation fetch for the same branch is accepted.
    const genAfter = getClosureLoadGeneration(topicId, freshBranch)
    const globAfter = getGlobalBlockGeneration()
    const freshResp = makeResp(topicId, anchor)
    // Simulate second fetch publication guard passing.
    expect(getClosureLoadGeneration(topicId, freshBranch)).toBe(genAfter)
    expect(getGlobalBlockGeneration()).toBe(globAfter)
    setCachedContextClosureWithFingerprint(topicId, freshResp as any, fp, freshBranch)
    expect(getFreshValidatedClosure(topicId, anchor, undefined, freshBranch)).not.toBeNull()

    // Read-only publication never invalidates: same-topic read-only hydration retains.
    const runMiddleware = (action: unknown) =>
      (closureInvalidationMiddleware as any)({} as any)((a: unknown) => a)(action)
    const genOtherBefore = getClosureLoadGeneration(otherTopic)
    runMiddleware(
      markClosureReadOnly(
        withClosureTopics({ type: 'messageBlocks/upsertManyBlocks', payload: [{ id: 'b-ro' }] }, otherTopic)
      )
    )
    expect(getClosureLoadGeneration(otherTopic)).toBe(genOtherBefore)
    expect(getFreshValidatedClosure(otherTopic, anchor, undefined, null)).not.toBeNull()
    // Read-only for the parent topic would likewise retain the fresh branch (no bump).
    const genBranchBeforeRO = getClosureLoadGeneration(topicId, freshBranch)
    runMiddleware(
      markClosureReadOnly(
        withClosureTopics({ type: 'messageBlocks/upsertManyBlocks', payload: [{ id: 'b-ro2' }] }, topicId)
      )
    )
    expect(getClosureLoadGeneration(topicId, freshBranch)).toBe(genBranchBeforeRO)
    expect(getFreshValidatedClosure(topicId, anchor, undefined, freshBranch)).not.toBeNull()
  })
})
