import {
  clearCachedContextClosure,
  computeClosureFingerprint,
  getCachedClosureFingerprint,
  getCachedContextClosure,
  isValidContextClosureCacheHit,
  isValidContextClosureResponse,
  setCachedContextClosure,
  setCachedContextClosureWithFingerprint
} from '@renderer/services/contextClosure'
import { describe, expect, it } from 'vitest'

function makeResp(topicId = 't1', anchor = 'u1', ids: string[] = ['u1', 'a1', 'u2']): any {
  const messages = ids.map((id) => ({
    id,
    role: id.startsWith('u') ? 'user' : 'assistant',
    topicId,
    ...(id.startsWith('a') ? { askId: 'u1' } : {})
  }))
  return {
    messages,
    blocks: [],
    closure: {
      completeness: 'context-closure' as const,
      topicId,
      anchorGroupKey: anchor,
      firstMessageId: ids[0] ?? null,
      lastMessageId: ids[ids.length - 1] ?? null,
      returnedCount: ids.length,
      totalTurnCount: 2,
      selectedTurnCount: 2,
      boundaryMessageId: null
    }
  }
}

describe('closure cache stale/in-flight', () => {
  it('rejects stale in-flight with mismatched anchor (same generation, different anchor)', () => {
    const req = { topicId: 't1', anchorGroupKey: 'u1' }
    const resForU1 = makeResp('t1', 'u1')
    const resForU2 = makeResp('t1', 'u2', ['u2', 'a2'])
    expect(isValidContextClosureResponse(req, resForU1)).toBe(true)
    expect(isValidContextClosureResponse(req, resForU2)).toBe(false)
    // stale response for old anchor should not publish when current anchor is u2
    const currentReq = { topicId: 't1', anchorGroupKey: 'u2' }
    expect(isValidContextClosureResponse(currentReq, resForU1)).toBe(false)
  })

  it('cache hit invalid when topic/anchor mismatch', () => {
    const res = makeResp('t1', 'u1')
    setCachedContextClosure('t1', res)
    const hit = getCachedContextClosure('t1')
    expect(hit?.closure.anchorGroupKey).toBe('u1')
    // mismatched current anchor => should be considered invalid for publish
    const reqMismatch = { topicId: 't1', anchorGroupKey: 'u9' }
    expect(isValidContextClosureResponse(reqMismatch, hit as any)).toBe(false)
    clearCachedContextClosure('t1')
    expect(getCachedContextClosure('t1')).toBeNull()
  })

  it('unbounded closure (contextCount=null) still validated without cap', () => {
    const manyIds = Array.from({ length: 150 }, (_, i) => (i % 2 === 0 ? `u${i}` : `a${i}`))
    const res = makeResp('t1', 'u0', manyIds)
    // returnedCount 150 would be >100 which is invalid for window but valid for closure (no bound)
    const req = { topicId: 't1', anchorGroupKey: 'u0' }
    expect(isValidContextClosureResponse(req, res)).toBe(true)
    expect(res.closure.returnedCount).toBe(150)
  })

  it('viewport window masquerading rejected', () => {
    const res: any = { ...makeResp(), window: { completeness: 'window' } }
    const req = { topicId: 't1', anchorGroupKey: 'u1' }
    expect(isValidContextClosureResponse(req, res)).toBe(false)
  })

  it('same-length mutation invalidates closure via fingerprint (LOCK-R06-006)', () => {
    const topicId = 't-fp'
    clearCachedContextClosure(topicId)
    // Initial authoritative messages: u1, a1 (status success)
    const initialMsgs = [
      { id: 'u1', role: 'user', topicId, status: 'success', blocks: ['b1'] },
      { id: 'a1', role: 'assistant', askId: 'u1', topicId, status: 'success', blocks: [] }
    ]
    const fp1 = computeClosureFingerprint(initialMsgs as any)
    const resp = makeResp(topicId, 'u1', ['u1', 'a1'])
    // publish with fingerprint fp1
    setCachedContextClosureWithFingerprint(topicId, resp, fp1)
    expect(getCachedContextClosure(topicId)).not.toBeNull()
    expect(getCachedClosureFingerprint(topicId)).toBe(fp1)
    // Same length but status mutated (e.g., a1 reverted to pending) -> fingerprint changes
    const mutatedMsgs = [
      { id: 'u1', role: 'user', topicId, status: 'success', blocks: ['b1'] },
      { id: 'a1', role: 'assistant', askId: 'u1', topicId, status: 'pending', blocks: [] }
    ]
    const fp2 = computeClosureFingerprint(mutatedMsgs as any)
    expect(fp2).not.toBe(fp1)
    // Cache hit with same anchor but different fingerprint must be rejected (needs refetch)
    const cached = getCachedContextClosure(topicId)!
    const storedFp = getCachedClosureFingerprint(topicId)!
    expect(isValidContextClosureCacheHit(cached as any, topicId, 'u1', fp2, storedFp)).toBe(false)
    // After clearing (invalidation), hit no longer exists
    clearCachedContextClosure(topicId)
    expect(getCachedContextClosure(topicId)).toBeNull()
  })

  it('ordering/role/id mutation also changes fingerprint even at same length', () => {
    const msgsA = [
      { id: 'u1', role: 'user', topicId: 't1', status: 'success', blocks: [] },
      { id: 'a1', role: 'assistant', askId: 'u1', topicId: 't1', status: 'success', blocks: [] },
      { id: 'u2', role: 'user', topicId: 't1', status: 'success', blocks: [] }
    ]
    const msgsB = [
      { id: 'u1', role: 'user', topicId: 't1', status: 'success', blocks: [] },
      // role mutated from assistant to system but same id — fingerprint must differ
      { id: 'a1', role: 'system', topicId: 't1', status: 'success', blocks: [] },
      { id: 'u2', role: 'user', topicId: 't1', status: 'success', blocks: [] }
    ]
    const fpA = computeClosureFingerprint(msgsA as any)
    const fpB = computeClosureFingerprint(msgsB as any)
    expect(fpA).not.toBe(fpB)
    // swapped order
    const reordered = [msgsA[2], msgsA[0], msgsA[1]]
    const fpReorder = computeClosureFingerprint(reordered as any)
    expect(fpReorder).not.toBe(fpA)
  })
})
