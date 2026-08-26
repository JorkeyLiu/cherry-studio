import {
  bumpClosureGeneration,
  bumpGlobalBlockGeneration,
  computeClosureFingerprint,
  enforceContextClosureRetention,
  getAllCachedTopicIds,
  getCachedClosureFingerprint,
  getCachedClosureGeneration,
  getCachedContextClosure,
  getClosureLoadGeneration,
  getCurrentClosureGeneration,
  getFreshValidatedClosure,
  getGlobalBlockGeneration,
  resetAllClosureStateForTests,
  setCachedContextClosureWithFingerprint
} from '@renderer/services/contextClosure'
import type { FetchContextClosureResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it } from 'vitest'

function makeResp(topicId = 't1', anchor = 'u1', ids: string[] = ['u1', 'a1', 'u2']): FetchContextClosureResponse {
  const messages = ids.map((id) => ({
    id,
    role: id.startsWith('u') ? 'user' : 'assistant',
    topicId,
    ...(id.startsWith('a') ? { askId: 'u1' } : {})
  }))
  return {
    messages: messages as any,
    blocks: [],
    closure: {
      completeness: 'context-closure' as const,
      topicId,
      anchorGroupKey: anchor,
      firstMessageId: ids[0] ?? null,
      lastMessageId: ids[ids.length - 1] ?? null,
      returnedCount: ids.length
    }
  } as any
}

describe('B-09 active-topic-only retention (contextClosure)', () => {
  beforeEach(() => {
    resetAllClosureStateForTests()
  })

  it('retains active entry and atomically clears inactive closures/fingerprints/generations', () => {
    const topics = ['t1', 't2', 't3']
    for (const t of topics) {
      const msgs = [{ id: 'u1', role: 'user', topicId: t, blocks: [] }]
      const fp = computeClosureFingerprint(msgs as any)
      const resp = makeResp(t, 'u1')
      setCachedContextClosureWithFingerprint(t, resp, fp)
    }
    expect(getAllCachedTopicIds().sort()).toEqual(['t1', 't2', 't3'])
    enforceContextClosureRetention('t2')
    expect(getAllCachedTopicIds()).toEqual(['t2'])
    expect(getCachedContextClosure('t2')).not.toBeNull()
    expect(getCachedContextClosure('t1')).toBeNull()
    expect(getCachedContextClosure('t3')).toBeNull()
    expect(getCachedClosureFingerprint('t2')).not.toBeNull()
    expect(getCachedClosureFingerprint('t1')).toBeNull()
    expect(getCachedClosureFingerprint('t3')).toBeNull()
    expect(getCachedClosureGeneration('t2')).toBeDefined()
    expect(getCachedClosureGeneration('t1')).toBeUndefined()
    expect(getCachedClosureGeneration('t3')).toBeUndefined()
  })

  it('preserves per-topic load generations and global block generation after trimming', () => {
    // prepare generations
    bumpClosureGeneration('t1') // gen 1
    bumpClosureGeneration('t1') // gen 2
    bumpClosureGeneration('t2') // gen 1
    bumpGlobalBlockGeneration() // global 1
    bumpGlobalBlockGeneration() // global 2
    const genT1Before = getClosureLoadGeneration('t1')
    const genT2Before = getClosureLoadGeneration('t2')
    const genT3Before = getClosureLoadGeneration('t3')
    const globalBefore = getGlobalBlockGeneration()
    // cache entries for t1,t2
    for (const t of ['t1', 't2'] as const) {
      const fp = computeClosureFingerprint([{ id: 'u1', role: 'user', topicId: t, blocks: [] }] as any)
      setCachedContextClosureWithFingerprint(t, makeResp(t, 'u1'), fp)
      // cachedGenerations snapshot at set time equals current load generation
      expect(getCachedClosureGeneration(t)).toBe(getClosureLoadGeneration(t))
    }
    // also set t3 generation to 5 without cache (should remain)
    bumpClosureGeneration('t3')
    bumpClosureGeneration('t3')
    const genT3AfterBump = getClosureLoadGeneration('t3')
    enforceContextClosureRetention('t1')
    // inactive t2 cache cleared but generations preserved
    expect(getClosureLoadGeneration('t1')).toBe(genT1Before)
    expect(getClosureLoadGeneration('t2')).toBe(genT2Before)
    expect(getClosureLoadGeneration('t3')).toBe(genT3AfterBump)
    void genT3Before // unused guard
    expect(getGlobalBlockGeneration()).toBe(globalBefore)
    expect(getCachedContextClosure('t1')).not.toBeNull()
    expect(getCachedContextClosure('t2')).toBeNull()
    expect(getCurrentClosureGeneration('t2')).toBe(genT2Before)
  })

  it('does not bump/invalidate active cache merely due to trimming — active remains fresh', () => {
    const tActive = 't-active'
    const fp = computeClosureFingerprint([{ id: 'u1', role: 'user', topicId: tActive, blocks: [] }] as any)
    const resp = makeResp(tActive, 'u1')
    setCachedContextClosureWithFingerprint(tActive, resp, fp)
    // add inactive
    setCachedContextClosureWithFingerprint('t-other', makeResp('t-other', 'u1'), 'fp-other')
    const genBefore = getClosureLoadGeneration(tActive)
    const cachedGenBefore = getCachedClosureGeneration(tActive)
    const globalBefore = getGlobalBlockGeneration()
    enforceContextClosureRetention(tActive)
    expect(getClosureLoadGeneration(tActive)).toBe(genBefore)
    expect(getCachedClosureGeneration(tActive)).toBe(cachedGenBefore)
    expect(getGlobalBlockGeneration()).toBe(globalBefore)
    expect(getFreshValidatedClosure(tActive, 'u1', fp)).not.toBeNull()
  })

  it('evicted inactive causes cache miss/fallback; republish after eviction succeeds and remains single', () => {
    const fp1 = computeClosureFingerprint([{ id: 'u1', role: 'user', topicId: 't1', blocks: [] }] as any)
    const fp2 = computeClosureFingerprint([{ id: 'u1', role: 'user', topicId: 't2', blocks: [] }] as any)
    setCachedContextClosureWithFingerprint('t1', makeResp('t1', 'u1'), fp1)
    setCachedContextClosureWithFingerprint('t2', makeResp('t2', 'u1'), fp2)
    // activate t1 -> t2 evicted
    enforceContextClosureRetention('t1')
    expect(getFreshValidatedClosure('t2', 'u1', fp2)).toBeNull()
    expect(getCachedContextClosure('t2')).toBeNull()
    // fallback would fetch; simulate republish for t2 after re-activation
    // first re-activate t2 (prunes t1)
    enforceContextClosureRetention('t2')
    expect(getCachedContextClosure('t1')).toBeNull()
    // publish new closure for t2 (even though t2 is now active, generation unchanged)
    const fp2b = computeClosureFingerprint([
      { id: 'u1', role: 'user', status: 'success', topicId: 't2', blocks: [] }
    ] as any)
    const resp2b = makeResp('t2', 'u1', ['u1', 'a1'])
    setCachedContextClosureWithFingerprint('t2', resp2b as any, fp2b)
    expect(getFreshValidatedClosure('t2', 'u1', fp2b)).not.toBeNull()
    expect(getAllCachedTopicIds()).toEqual(['t2'])
  })

  it('inactive eviction preserves stale in-flight protection: generation mismatch still discards stale publication', () => {
    const topicInactive = 't-evicted'
    const fp = computeClosureFingerprint([{ id: 'u1', role: 'user', topicId: topicInactive, blocks: [] }] as any)
    setCachedContextClosureWithFingerprint(topicInactive, makeResp(topicInactive, 'u1'), fp)
    // Capture generation at fetch start for inactive topic
    const generationAtFetch = getClosureLoadGeneration(topicInactive)
    const globalAtFetch = getGlobalBlockGeneration()
    // Activate other topic -> prune inactive cache but preserve its generation
    enforceContextClosureRetention('t-active-other')
    // Verify generation preserved (not reset)
    expect(getClosureLoadGeneration(topicInactive)).toBe(generationAtFetch)
    expect(getGlobalBlockGeneration()).toBe(globalAtFetch)
    // Now mutate inactive topic (outside viewport) -> bump generation
    bumpClosureGeneration(topicInactive)
    expect(getClosureLoadGeneration(topicInactive)).not.toBe(generationAtFetch)
    // Simulate hook guard: stale publication should be discarded via generation mismatch
    const curGenNow = getClosureLoadGeneration(topicInactive)
    const wouldPublish = curGenNow === generationAtFetch && getGlobalBlockGeneration() === globalAtFetch
    expect(wouldPublish).toBe(false)
    // Also global mismatch case: ensure global bump also discards
    resetAllClosureStateForTests()
    const fp2 = computeClosureFingerprint([{ id: 'u1', role: 'user', topicId: 'tX', blocks: [] }] as any)
    setCachedContextClosureWithFingerprint('tX', makeResp('tX', 'u1'), fp2)
    const genAtFetch2 = getClosureLoadGeneration('tX')
    const globAtFetch2 = getGlobalBlockGeneration()
    enforceContextClosureRetention('tY')
    bumpGlobalBlockGeneration()
    const curGlob = getGlobalBlockGeneration()
    expect(curGlob).not.toBe(globAtFetch2)
    const wouldPublish2 = getClosureLoadGeneration('tX') === genAtFetch2 && curGlob === globAtFetch2
    expect(wouldPublish2).toBe(false)
  })

  it('retains only active when active not previously cached — clears all', () => {
    setCachedContextClosureWithFingerprint('t1', makeResp('t1', 'u1'), 'fp1')
    setCachedContextClosureWithFingerprint('t2', makeResp('t2', 'u1'), 'fp2')
    enforceContextClosureRetention('t-new') // active not in cache
    expect(getAllCachedTopicIds()).toEqual([])
    expect(getCachedContextClosure('t1')).toBeNull()
    expect(getCachedContextClosure('t2')).toBeNull()
    // publish for new active then succeeds
    const fpNew = computeClosureFingerprint([{ id: 'u1', role: 'user', topicId: 't-new', blocks: [] }] as any)
    setCachedContextClosureWithFingerprint('t-new', makeResp('t-new', 'u1'), fpNew)
    expect(getAllCachedTopicIds()).toEqual(['t-new'])
  })

  it('no-op when activeTopicId empty preserves cache (guard)', () => {
    const fp = computeClosureFingerprint([{ id: 'u1', role: 'user', topicId: 't1', blocks: [] }] as any)
    setCachedContextClosureWithFingerprint('t1', makeResp('t1', 'u1'), fp)
    enforceContextClosureRetention('')
    expect(getAllCachedTopicIds()).toEqual(['t1'])
    enforceContextClosureRetention(null as any)
    expect(getAllCachedTopicIds()).toEqual(['t1'])
  })

  it('unlimited contextCount semantics unchanged — large closure still valid after retention', () => {
    const manyIds = Array.from({ length: 120 }, (_, i) => (i % 2 === 0 ? `u${i}` : `a${i}`))
    const respLarge = makeResp('t-big', 'u0', manyIds)
    const fpLarge = computeClosureFingerprint(
      manyIds.map((id) => ({
        id,
        role: id.startsWith('u') ? 'user' : 'assistant',
        topicId: 't-big',
        blocks: []
      })) as any
    )
    setCachedContextClosureWithFingerprint('t-big', respLarge, fpLarge)
    setCachedContextClosureWithFingerprint('t-other', makeResp('t-other', 'u1'), 'fp')
    enforceContextClosureRetention('t-big')
    expect(getFreshValidatedClosure('t-big', 'u0', fpLarge)).not.toBeNull()
    expect((getFreshValidatedClosure('t-big', 'u0', fpLarge) as any).closure.returnedCount).toBe(120)
  })
})
