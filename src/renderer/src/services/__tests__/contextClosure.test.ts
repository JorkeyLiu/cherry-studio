import { isValidContextClosureCacheHit, isValidContextClosureResponse } from '@renderer/services/contextClosure'
import type { FetchContextClosureRequest, FetchContextClosureResponse } from '@shared/chatDb'
import { describe, expect, it } from 'vitest'

function makeClosure(
  overrides: Partial<FetchContextClosureResponse['closure']> & { messages?: any[]; blocks?: any[] } = {}
): FetchContextClosureResponse {
  const messages = overrides.messages ?? [
    { id: 'u1', role: 'user', topicId: 't1' },
    { id: 'a1', role: 'assistant', askId: 'u1', topicId: 't1' },
    { id: 'u2', role: 'user', topicId: 't1' }
  ]
  const blocks = overrides.blocks ?? []
  const baseFirst = messages.length > 0 ? messages[0].id : null
  const baseLast = messages.length > 0 ? messages[messages.length - 1].id : null
  // Default to whole-topic: 2 turns (u1+a1, u2) -> selected===total, boundary null
  const closure: any = {
    completeness: 'context-closure',
    topicId: 't1',
    anchorGroupKey: 'u1',
    firstMessageId: baseFirst,
    lastMessageId: baseLast,
    returnedCount: messages.length,
    totalTurnCount: 2,
    selectedTurnCount: 2,
    boundaryMessageId: null,
    ...overrides
  }
  // Remove messages/blocks from closure overrides if present
  delete closure.messages
  delete closure.blocks
  // Ensure first/last coherent when overrides change count
  if (overrides.returnedCount !== undefined) {
    closure.returnedCount = overrides.returnedCount
  }
  if (overrides.firstMessageId !== undefined) closure.firstMessageId = overrides.firstMessageId
  if (overrides.lastMessageId !== undefined) closure.lastMessageId = overrides.lastMessageId
  if (overrides.totalTurnCount !== undefined) closure.totalTurnCount = overrides.totalTurnCount
  if (overrides.selectedTurnCount !== undefined) closure.selectedTurnCount = overrides.selectedTurnCount
  if (overrides.boundaryMessageId !== undefined) closure.boundaryMessageId = overrides.boundaryMessageId
  return { messages: messages as any, blocks: blocks as any, closure } as FetchContextClosureResponse
}

describe('isValidContextClosureResponse', () => {
  const req: FetchContextClosureRequest = { topicId: 't1', anchorGroupKey: 'u1' }

  it('accepts valid context-closure with coherent IDs/count', () => {
    const res = makeClosure()
    expect(isValidContextClosureResponse(req, res)).toBe(true)
  })

  it('rejects wrong completeness', () => {
    const res = makeClosure({ completeness: 'window' as any })
    expect(isValidContextClosureResponse(req, res)).toBe(false)
  })

  it('rejects wrong topicId', () => {
    const res = makeClosure({ topicId: 'other' } as any)
    expect(isValidContextClosureResponse(req, res)).toBe(false)
  })

  it('rejects wrong anchorGroupKey', () => {
    const res = makeClosure({ anchorGroupKey: 'other' } as any)
    expect(isValidContextClosureResponse(req, res)).toBe(false)
  })

  it('rejects malformed first/last/count (mismatch)', () => {
    const res = makeClosure({ firstMessageId: 'wrong' } as any)
    expect(isValidContextClosureResponse(req, res)).toBe(false)
  })

  it('rejects count mismatch', () => {
    const res = makeClosure({ returnedCount: 999 } as any)
    expect(isValidContextClosureResponse(req, res)).toBe(false)
  })

  it('rejects empty with non-null bounds', () => {
    const res = makeClosure({
      messages: [],
      blocks: [],
      returnedCount: 0,
      firstMessageId: 'u1' as any,
      lastMessageId: 'u1' as any,
      totalTurnCount: 1 as any,
      selectedTurnCount: 1 as any,
      boundaryMessageId: null as any
    })
    expect(isValidContextClosureResponse(req, res)).toBe(false)
  })

  it('rejects non-empty with null bounds', () => {
    const res = makeClosure({ firstMessageId: null as any, lastMessageId: null as any })
    expect(isValidContextClosureResponse(req, res)).toBe(false)
  })

  it('rejects missing anchor row (messages do not contain anchor)', () => {
    const messages = [
      { id: 'x1', role: 'user', topicId: 't1' },
      { id: 'x2', role: 'assistant', askId: 'x1', topicId: 't1' }
    ]
    const res = makeClosure({ messages: messages as any })
    // anchor u1 not in messages
    expect(isValidContextClosureResponse(req, res)).toBe(false)
  })

  it('rejects viewport window masquerading as closure', () => {
    const res: any = { ...makeClosure(), window: { completeness: 'window' } }
    expect(isValidContextClosureResponse(req, res)).toBe(false)
  })

  it('rejects when block.messageId not in messages', () => {
    const blocks: any = [{ id: 'b1', messageId: 'nonexistent' }]
    const res = makeClosure({ blocks } as any)
    expect(isValidContextClosureResponse(req, res)).toBe(false)
  })

  it('rejects empty closure with null bounds (LOCK-R06-004: empty is NOT_FOUND, never valid success)', () => {
    const res: FetchContextClosureResponse = {
      messages: [],
      blocks: [],
      closure: {
        completeness: 'context-closure',
        topicId: 't1',
        anchorGroupKey: 'empty-anchor',
        firstMessageId: null,
        lastMessageId: null,
        returnedCount: 0,
        totalTurnCount: 1,
        selectedTurnCount: 1,
        boundaryMessageId: null
      }
    }
    const r2: FetchContextClosureRequest = { topicId: 't1', anchorGroupKey: 'empty-anchor' }
    // LOCK-R06-004: anchor-based closure success is always non-empty; missing topic/anchor is NOT_FOUND
    expect(isValidContextClosureResponse(r2, res)).toBe(false)
  })

  it('rejects unknown role anchor (null/tool/unknown cannot resolve as own-id) — LOCK-R06-005', () => {
    const cases: Array<{ role: any; id: string }> = [
      { role: null, id: 'x-null' },
      { role: 'tool', id: 'x-tool' },
      { role: 'unknown', id: 'x-unknown' },
      { role: '', id: 'x-empty' }
    ]
    for (const c of cases) {
      const messages = [
        { id: 'u1', role: 'user', topicId: 't1' },
        { id: c.id, role: c.role, topicId: 't1' },
        { id: 'a1', role: 'assistant', askId: 'u1', topicId: 't1' }
      ]
      const res = makeClosure({ messages: messages as any, anchorGroupKey: c.id } as any)
      const r: FetchContextClosureRequest = { topicId: 't1', anchorGroupKey: c.id }
      // Same-length closure with unknown-role anchor must be rejected (no turn); Main would NOT_FOUND
      expect(isValidContextClosureResponse(r, res)).toBe(false)
    }
  })

  it('still accepts valid user/assistant/system anchors after unknown-role tightening', () => {
    // user anchor
    expect(isValidContextClosureResponse({ topicId: 't1', anchorGroupKey: 'u1' }, makeClosure())).toBe(true)
    // assistant askId anchor
    const aMessages = [
      { id: 'aOrphan', role: 'assistant', askId: 'u-orphan', topicId: 't1' },
      { id: 'u2', role: 'user', topicId: 't1' }
    ]
    const aRes = makeClosure({
      messages: aMessages as any,
      anchorGroupKey: 'u-orphan',
      totalTurnCount: 2,
      selectedTurnCount: 2,
      boundaryMessageId: null
    } as any)
    // firstMessageId/lastMessageId must match for aRes; makeClosure computes from messages
    expect(isValidContextClosureResponse({ topicId: 't1', anchorGroupKey: 'u-orphan' }, aRes)).toBe(true)
    // system own-id anchor
    const sMessages = [
      { id: 's1', role: 'system', topicId: 't1' },
      { id: 'u1', role: 'user', topicId: 't1' }
    ]
    const sRes = makeClosure({
      messages: sMessages as any,
      anchorGroupKey: 's1',
      totalTurnCount: 2,
      selectedTurnCount: 2,
      boundaryMessageId: null
    } as any)
    expect(isValidContextClosureResponse({ topicId: 't1', anchorGroupKey: 's1' }, sRes)).toBe(true)
    // orphan assistant own-id anchor (no askId)
    const orphanMsgs = [
      { id: 'aNoAsk', role: 'assistant', askId: null, topicId: 't1' },
      { id: 'u1', role: 'user', topicId: 't1' }
    ]
    const oRes = makeClosure({
      messages: orphanMsgs as any,
      anchorGroupKey: 'aNoAsk',
      totalTurnCount: 2,
      selectedTurnCount: 2,
      boundaryMessageId: null
    } as any)
    expect(isValidContextClosureResponse({ topicId: 't1', anchorGroupKey: 'aNoAsk' }, oRes)).toBe(true)
  })

  // LOCK-001 authoritative counts and boundary
  it('rejects missing totalTurnCount/selectedTurnCount/boundaryMessageId', () => {
    const base = makeClosure()
    const missingTotal: any = { ...base, closure: { ...base.closure } }
    delete missingTotal.closure.totalTurnCount
    expect(isValidContextClosureResponse(req, missingTotal)).toBe(false)
    const missingSelected: any = { ...base, closure: { ...base.closure } }
    delete missingSelected.closure.selectedTurnCount
    expect(isValidContextClosureResponse(req, missingSelected)).toBe(false)
    const missingBoundary: any = { ...base, closure: { ...base.closure } }
    delete missingBoundary.closure.boundaryMessageId
    expect(isValidContextClosureResponse(req, missingBoundary)).toBe(false)
  })

  it('rejects totalTurnCount/selectedTurnCount <1 or non-integer or selected>total', () => {
    expect(isValidContextClosureResponse(req, makeClosure({ totalTurnCount: 0 as any }))).toBe(false)
    expect(isValidContextClosureResponse(req, makeClosure({ totalTurnCount: 1.5 as any }))).toBe(false)
    expect(isValidContextClosureResponse(req, makeClosure({ selectedTurnCount: 0 as any }))).toBe(false)
    expect(isValidContextClosureResponse(req, makeClosure({ selectedTurnCount: 1.5 as any }))).toBe(false)
    expect(
      isValidContextClosureResponse(
        req,
        makeClosure({ totalTurnCount: 2, selectedTurnCount: 3, boundaryMessageId: 'u1' as any })
      )
    ).toBe(false)
  })

  it('rejects boundaryMessageId not null when selected===total (whole-topic)', () => {
    const res = makeClosure({ totalTurnCount: 2, selectedTurnCount: 2, boundaryMessageId: 'u1' as any })
    expect(isValidContextClosureResponse(req, res)).toBe(false)
  })

  it('rejects boundaryMessageId null when selected<total (partial)', () => {
    const msgs = [
      { id: 'u1', role: 'user', topicId: 't1' },
      { id: 'a1', role: 'assistant', askId: 'u1', topicId: 't1' },
      { id: 'u2', role: 'user', topicId: 't1' },
      { id: 'a2', role: 'assistant', askId: 'u2', topicId: 't1' }
    ]
    // 2 turns, anchor at second turn => partial: selected 1 < total 2, boundary must be u2 not null
    const req2: FetchContextClosureRequest = { topicId: 't1', anchorGroupKey: 'u2' }
    const res2 = makeClosure({
      messages: [msgs[2], msgs[3]] as any,
      anchorGroupKey: 'u2',
      totalTurnCount: 2,
      selectedTurnCount: 1,
      boundaryMessageId: null as any
    } as any)
    expect(isValidContextClosureResponse(req2, res2)).toBe(false)
  })

  it('rejects boundaryMessageId not equal to firstMessageId when partial', () => {
    const res = makeClosure({ totalTurnCount: 5, selectedTurnCount: 2, boundaryMessageId: 'wrong' as any })
    expect(isValidContextClosureResponse(req, res)).toBe(false)
  })

  it('rejects unknown closure key', () => {
    const res: any = makeClosure({ extraField: 123 } as any)
    // extraField will be inside closure because makeClosure spreads overrides into closure
    expect(isValidContextClosureResponse(req, res)).toBe(false)
  })

  it('rejects unknown response root key (LOCK-001 mirror Shared fail-closed)', () => {
    const base = makeClosure()
    const withExtra: any = { ...base, extraRoot: 123 }
    expect(isValidContextClosureResponse(req, withExtra)).toBe(false)
    const withWindow: any = { ...base, window: { completeness: 'window' } }
    expect(isValidContextClosureResponse(req, withWindow)).toBe(false)
    const withHasMore: any = { ...base, hasMore: true }
    expect(isValidContextClosureResponse(req, withHasMore)).toBe(false)
  })

  it('accepts valid partial with boundary equals firstMessageId', () => {
    const msgs = [
      { id: 'u1', role: 'user', topicId: 't1' },
      { id: 'a1', role: 'assistant', askId: 'u1', topicId: 't1' },
      { id: 'u2', role: 'user', topicId: 't1' }
    ]
    // partial: total 2, selected 1, boundary = firstMessageId = u2, messages slice from u2 onward
    const res = makeClosure({
      messages: [msgs[2]] as any,
      anchorGroupKey: 'u2',
      totalTurnCount: 2,
      selectedTurnCount: 1,
      boundaryMessageId: 'u2'
    } as any)
    const req2: FetchContextClosureRequest = { topicId: 't1', anchorGroupKey: 'u2' }
    expect(isValidContextClosureResponse(req2, res)).toBe(true)
  })
})

describe('isValidContextClosureCacheHit', () => {
  it('valid when same topic and anchor and coherent', () => {
    const res = makeClosure()
    expect(isValidContextClosureCacheHit(res, 't1', 'u1')).toBe(true)
  })
  it('invalid when anchor mismatch', () => {
    const res = makeClosure()
    expect(isValidContextClosureCacheHit(res, 't1', 'u2')).toBe(false)
  })
  it('invalid when topic mismatch', () => {
    const res = makeClosure()
    expect(isValidContextClosureCacheHit(res, 't2', 'u1')).toBe(false)
  })
  it('invalid when completeness wrong', () => {
    const res = makeClosure({ completeness: 'window' as any } as any)
    expect(isValidContextClosureCacheHit(res, 't1', 'u1')).toBe(false)
  })
  it('invalid when anchorGroupKey null', () => {
    const res = makeClosure()
    expect(isValidContextClosureCacheHit(res, 't1', null)).toBe(false)
  })
  it('rejects empty closure even with null bounds (LOCK-R06-004)', () => {
    const res: FetchContextClosureResponse = {
      messages: [],
      blocks: [],
      closure: {
        completeness: 'context-closure',
        topicId: 't1',
        anchorGroupKey: 'u1',
        firstMessageId: null,
        lastMessageId: null,
        returnedCount: 0,
        totalTurnCount: 1,
        selectedTurnCount: 1,
        boundaryMessageId: null
      }
    }
    expect(isValidContextClosureCacheHit(res, 't1', 'u1')).toBe(false)
  })
  it('rejects when fingerprint indicates same-length mutation (LOCK-R06-006)', () => {
    const res = makeClosure()
    // fingerprint mismatch should fail hit
    expect(isValidContextClosureCacheHit(res, 't1', 'u1', 'fp-current', 'fp-cached-different')).toBe(false)
    // matching fingerprints still valid
    expect(isValidContextClosureCacheHit(res, 't1', 'u1', 'fp-same', 'fp-same')).toBe(true)
    // missing fingerprint (null) does not trigger fingerprint check — still valid if other checks pass
    expect(isValidContextClosureCacheHit(res, 't1', 'u1', null, null)).toBe(true)
  })
  it('rejects when counts invalid or boundary mismatch (LOCK-001)', () => {
    const badCounts = makeClosure({ totalTurnCount: 0 as any })
    expect(isValidContextClosureCacheHit(badCounts, 't1', 'u1')).toBe(false)
    const badSelected = makeClosure({ totalTurnCount: 2, selectedTurnCount: 3, boundaryMessageId: 'u1' as any })
    expect(isValidContextClosureCacheHit(badSelected, 't1', 'u1')).toBe(false)
    const badBoundaryWhole = makeClosure({ totalTurnCount: 2, selectedTurnCount: 2, boundaryMessageId: 'u1' as any })
    expect(isValidContextClosureCacheHit(badBoundaryWhole, 't1', 'u1')).toBe(false)
    const badBoundaryPartial = makeClosure({ totalTurnCount: 5, selectedTurnCount: 2, boundaryMessageId: null as any })
    expect(isValidContextClosureCacheHit(badBoundaryPartial, 't1', 'u1')).toBe(false)
    const badBoundaryNotFirst = makeClosure({
      totalTurnCount: 5,
      selectedTurnCount: 2,
      boundaryMessageId: 'wrong' as any
    })
    expect(isValidContextClosureCacheHit(badBoundaryNotFirst, 't1', 'u1')).toBe(false)
  })
  it('rejects unknown closure key in cache hit', () => {
    const res: any = makeClosure({ extra: 123 } as any)
    expect(isValidContextClosureCacheHit(res, 't1', 'u1')).toBe(false)
  })
  it('rejects unknown response root key in cache hit (LOCK-001 mirror Shared)', () => {
    const base: any = makeClosure()
    const withExtra: any = { ...base, extraRoot: 123 }
    expect(isValidContextClosureCacheHit(withExtra, 't1', 'u1')).toBe(false)
    const withWindow: any = { ...base, window: { completeness: 'window' } }
    expect(isValidContextClosureCacheHit(withWindow, 't1', 'u1')).toBe(false)
    const withHasMore: any = { ...base, hasMore: true }
    expect(isValidContextClosureCacheHit(withHasMore, 't1', 'u1')).toBe(false)
  })
})
