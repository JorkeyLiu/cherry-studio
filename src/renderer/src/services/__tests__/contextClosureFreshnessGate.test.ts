import {
  bumpAndInvalidate,
  bumpAndInvalidateAll,
  bumpClosureGeneration,
  clearCachedContextClosure,
  computeClosureFingerprint,
  getCurrentClosureGeneration,
  getFreshValidatedClosure,
  resetAllClosureStateForTests,
  setCachedContextClosureWithFingerprint
} from '@renderer/services/contextClosure'
import type { FetchContextClosureResponse } from '@shared/chatDb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('freshness-gated cache helper (LOCK-R06-006)', () => {
  beforeEach(() => {
    resetAllClosureStateForTests()
    vi.clearAllMocks()
  })

  it('returns fresh closure when structural + anchor + generation + fingerprint match', () => {
    const topicId = 't1'
    const anchor = 'u1'
    const msgs = [
      { id: 'u1', role: 'user', topicId, blocks: ['b1'] },
      { id: 'a1', role: 'assistant', askId: 'u1', topicId, blocks: [] }
    ]
    const fp = computeClosureFingerprint(msgs as any)
    const resp = makeResp(topicId, anchor, ['u1', 'a1'])
    setCachedContextClosureWithFingerprint(topicId, resp as any, fp)
    const fresh = getFreshValidatedClosure(topicId, anchor, fp)
    expect(fresh).not.toBeNull()
    expect(fresh?.closure.anchorGroupKey).toBe(anchor)
  })

  it('fail-closed: structural invalid (wrong anchor) -> null even though cache exists', () => {
    const topicId = 't1'
    const anchor = 'u1'
    const msgs = [
      { id: 'u1', role: 'user', topicId, blocks: [] },
      { id: 'a1', role: 'assistant', askId: 'u1', topicId, blocks: [] }
    ]
    const fp = computeClosureFingerprint(msgs as any)
    const resp = makeResp(topicId, anchor, ['u1', 'a1'])
    setCachedContextClosureWithFingerprint(topicId, resp as any, fp)
    // request with different anchor should be rejected
    const fresh = getFreshValidatedClosure(topicId, 'u9', fp)
    expect(fresh).toBeNull()
  })

  it('fail-closed: generation mismatch -> null (full-closure outside-viewport same-length mutation)', () => {
    const topicId = 't-gen'
    const anchor = 'u1'
    // viewport fingerprint computed from visible last 2 messages (window truncated)
    const viewportMsgs = [
      { id: 'a8', role: 'assistant', askId: 'u7', topicId, status: 'success', blocks: [] },
      { id: 'u9', role: 'user', topicId, status: 'success', blocks: [] }
    ]
    const viewportFp = computeClosureFingerprint(viewportMsgs as any)
    // closure is anchor-to-newest 20 messages, but viewport only shows last 2; at cache time fingerprint stored is viewportFp
    const resp = makeResp(topicId, anchor, ['u1', 'a1', 'u2', 'a2', 'u9'])
    setCachedContextClosureWithFingerprint(topicId, resp as any, viewportFp)
    // No mutation yet -> fresh
    expect(getFreshValidatedClosure(topicId, anchor, viewportFp)).not.toBeNull()
    // Simulate same-length mutation outside viewport: an old message's status changed, viewport fingerprint unchanged, but generation bumped via middleware
    bumpAndInvalidate(topicId) // this clears cache; but to test generation mismatch while cache still present, we use bump without clear
    // For this test, we want cache still present but generation mismatched: use bump without clear
    // Reset: re-cache then bump only generation
    setCachedContextClosureWithFingerprint(topicId, resp as any, viewportFp)
    bumpClosureGeneration(topicId)
    // viewport fingerprint still same (outside mutation not visible), but generation advanced -> helper must fail
    const freshAfter = getFreshValidatedClosure(topicId, anchor, viewportFp)
    expect(freshAfter).toBeNull()
  })

  it('fail-closed: fingerprint mismatch -> null (same-length visible mutation)', () => {
    const topicId = 't-fp2'
    const anchor = 'u1'
    const msgsA = [
      { id: 'u1', role: 'user', topicId, status: 'success', blocks: ['b1'] },
      { id: 'a1', role: 'assistant', askId: 'u1', topicId, status: 'success', blocks: [] }
    ]
    const fpA = computeClosureFingerprint(msgsA as any)
    const resp = makeResp(topicId, anchor, ['u1', 'a1'])
    setCachedContextClosureWithFingerprint(topicId, resp as any, fpA)
    const msgsB = [
      { id: 'u1', role: 'user', topicId, status: 'success', blocks: ['b1'] },
      { id: 'a1', role: 'assistant', askId: 'u1', topicId, status: 'pending', blocks: [] }
    ]
    const fpB = computeClosureFingerprint(msgsB as any)
    expect(fpB).not.toBe(fpA)
    expect(getFreshValidatedClosure(topicId, anchor, fpB)).toBeNull()
    // matching still fresh
    expect(getFreshValidatedClosure(topicId, anchor, fpA)).not.toBeNull()
  })

  it('conservative: viewport fingerprint cannot prove full closure freshness, generation is required', () => {
    const topicId = 't-outside'
    const anchor = 'u1'
    // Cache closure from anchor u1 to newest, includes early messages not in viewport
    const earlyMsgs = [
      { id: 'u1', role: 'user', topicId, status: 'success', blocks: [] },
      { id: 'a1', role: 'assistant', askId: 'u1', topicId, status: 'success', blocks: [] },
      { id: 'u2', role: 'user', topicId, status: 'success', blocks: [] },
      { id: 'a2', role: 'assistant', askId: 'u2', topicId, status: 'success', blocks: [] }
    ]
    // Viewport only has last 2 messages (windowed)
    const viewport = earlyMsgs.slice(-2)
    const viewportFp = computeClosureFingerprint(viewport as any)
    const resp = makeResp(
      topicId,
      anchor,
      earlyMsgs.map((m) => m.id)
    )
    setCachedContextClosureWithFingerprint(topicId, resp as any, viewportFp)
    // Mutate early message outside viewport (same length): change status of a1
    const earlyMutated = [...earlyMsgs]
    earlyMutated[1] = { ...earlyMutated[1], status: 'pending' } as any
    // Viewport fingerprint unchanged (still last 2)
    const viewportFpAfter = computeClosureFingerprint(viewport as any)
    expect(viewportFpAfter).toBe(viewportFp)
    // Without generation bump, fingerprint-only check would incorrectly claim fresh
    // With generation bump (middleware), it is correctly invalidated
    bumpClosureGeneration(topicId)
    expect(getFreshValidatedClosure(topicId, anchor, viewportFpAfter)).toBeNull()
    // After refetch with new fingerprint (if viewport had changed) or after generation reset, fresh would require new cache
    clearCachedContextClosure(topicId)
    resetAllClosureStateForTests()
    const freshFp2 = computeClosureFingerprint(viewport as any)
    setCachedContextClosureWithFingerprint(topicId, resp as any, freshFp2)
    expect(getFreshValidatedClosure(topicId, anchor, freshFp2)).not.toBeNull()
  })

  it('in-flight race: generation changed during fetch -> discard publication', async () => {
    const topicId = 't-race'
    const anchor = 'u1'
    const msgs = [
      { id: 'u1', role: 'user', topicId, blocks: [] },
      { id: 'a1', role: 'assistant', askId: 'u1', topicId, blocks: [] }
    ]
    const fp = computeClosureFingerprint(msgs as any)
    const resp = makeResp(topicId, anchor, ['u1', 'a1'])
    // Simulate fetch start
    const genAtFetch = getCurrentClosureGeneration(topicId)
    setCachedContextClosureWithFingerprint(topicId, resp as any, fp)
    // Mutation happens during fetch (e.g., user sent new message, middleware bumped)
    bumpClosureGeneration(topicId)
    const curGenNow = getCurrentClosureGeneration(topicId)
    expect(curGenNow).not.toBe(genAtFetch)
    // Helper should now consider cached entry stale
    const fresh = getFreshValidatedClosure(topicId, anchor, fp)
    expect(fresh).toBeNull()
    // Since cache was bumped via bumpAndInvalidate it was cleared, fresh is null. Test bump without clear path:
    resetAllClosureStateForTests()
    setCachedContextClosureWithFingerprint(topicId, resp as any, fp)
    const gen2 = getCurrentClosureGeneration(topicId)
    bumpClosureGeneration(topicId) // bump only
    const fresh2 = getFreshValidatedClosure(topicId, anchor, fp)
    expect(fresh2).toBeNull()
    expect(gen2).not.toBe(getCurrentClosureGeneration(topicId))
  })

  it('middleware invalidation: bumpAndInvalidateAll clears all topics block change', () => {
    const topics = ['tA', 'tB']
    for (const t of topics) {
      const fp = computeClosureFingerprint([{ id: 'u1', role: 'user', topicId: t, blocks: [] }] as any)
      const resp = makeResp(t, 'u1', ['u1'])
      setCachedContextClosureWithFingerprint(t, resp as any, fp)
      expect(getFreshValidatedClosure(t, 'u1', fp)).not.toBeNull()
    }
    bumpAndInvalidateAll()
    for (const t of topics) {
      const fp = computeClosureFingerprint([{ id: 'u1', role: 'user', topicId: t, blocks: [] }] as any)
      expect(getFreshValidatedClosure(t, 'u1', fp)).toBeNull()
    }
  })
})
