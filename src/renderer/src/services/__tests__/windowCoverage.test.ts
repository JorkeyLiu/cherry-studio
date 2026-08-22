import { describe, expect, it } from 'vitest'

import { isExactWindowMatch, isWindowCovering } from '../windowCoverage'

function makeWindow(kind: 'latest' | 'around', overrides: Record<string, any> = {}) {
  const base = {
    messages: [],
    blocks: [],
    window: {
      kind,
      completeness: 'window' as const,
      topicId: 't1',
      anchorMessageId: kind === 'around' ? 'm2' : null,
      requested: kind === 'latest' ? { limit: 20 } : { before: 10, after: 10 },
      firstMessageId: 'm1',
      lastMessageId: 'm3',
      returnedCount: 3,
      hasMoreBefore: true,
      hasMoreAfter: true
    }
  }
  return {
    ...base,
    window: { ...base.window, ...overrides, requested: { ...base.window.requested, ...overrides.requested } }
  } as any
}

describe('windowCoverage helpers', () => {
  it('latest: covering when cached limit >= requested', () => {
    const cached = makeWindow('latest', { requested: { limit: 20 } })
    expect(isWindowCovering(cached, { kind: 'latest', topicId: 't1', limit: 10 }, 't1')).toBe(true)
  })
  it('latest: not covering when cached limit < requested', () => {
    const cached = makeWindow('latest', { requested: { limit: 5 } })
    expect(isWindowCovering(cached, { kind: 'latest', topicId: 't1', limit: 10 }, 't1')).toBe(false)
  })
  it('around: covering when anchor matches and before/after sufficient', () => {
    const cached = makeWindow('around', { anchorMessageId: 'm2', requested: { before: 10, after: 10 } })
    expect(
      isWindowCovering(cached, { kind: 'around', topicId: 't1', anchorMessageId: 'm2', before: 5, after: 5 }, 't1')
    ).toBe(true)
  })
  it('around: not covering when anchor differs', () => {
    const cached = makeWindow('around', { anchorMessageId: 'm2' })
    expect(
      isWindowCovering(cached, { kind: 'around', topicId: 't1', anchorMessageId: 'm9', before: 5, after: 5 }, 't1')
    ).toBe(false)
  })
  it('around: not covering when before insufficient', () => {
    const cached = makeWindow('around', { requested: { before: 5, after: 10 } })
    expect(
      isWindowCovering(cached, { kind: 'around', topicId: 't1', anchorMessageId: 'm2', before: 10, after: 5 }, 't1')
    ).toBe(false)
  })
  it('rejects when topicId mismatches current generation', () => {
    const cached = makeWindow('latest', { topicId: 't1' })
    expect(isWindowCovering(cached, { kind: 'latest', topicId: 't1', limit: 10 }, 't2')).toBe(false)
  })
  it('rejects when completeness is not window', () => {
    const cached = makeWindow('latest', { completeness: 'whole-topic' as any })
    expect(isWindowCovering(cached, { kind: 'latest', topicId: 't1', limit: 10 }, 't1')).toBe(false)
  })
  it('rejects null cached', () => {
    expect(isWindowCovering(null, { kind: 'latest', topicId: 't1', limit: 10 }, 't1')).toBe(false)
  })
  it('isExactWindowMatch requires exact requested equality', () => {
    const cached = makeWindow('latest', { requested: { limit: 20 } })
    expect(isExactWindowMatch(cached, { kind: 'latest', topicId: 't1', limit: 20 })).toBe(true)
    expect(isExactWindowMatch(cached, { kind: 'latest', topicId: 't1', limit: 10 })).toBe(false)
    const cachedAround = makeWindow('around', { anchorMessageId: 'm2', requested: { before: 10, after: 10 } })
    expect(
      isExactWindowMatch(cachedAround, { kind: 'around', topicId: 't1', anchorMessageId: 'm2', before: 10, after: 10 })
    ).toBe(true)
    expect(
      isExactWindowMatch(cachedAround, { kind: 'around', topicId: 't1', anchorMessageId: 'm2', before: 10, after: 5 })
    ).toBe(false)
  })
  it('latest: fail-closed when cached requested.limit missing (no fallback to returnedCount)', () => {
    const malformed = {
      messages: [],
      blocks: [],
      window: {
        kind: 'latest' as const,
        completeness: 'window' as const,
        topicId: 't1',
        anchorMessageId: null,
        requested: {} as any,
        firstMessageId: 'm1',
        lastMessageId: 'm3',
        returnedCount: 20,
        hasMoreBefore: false,
        hasMoreAfter: false
      }
    } as any
    expect(isWindowCovering(malformed, { kind: 'latest', topicId: 't1', limit: 10 }, 't1')).toBe(false)
    const missingLimit = makeWindow('latest', { requested: { limit: undefined as any } })
    // force remove limit
    delete missingLimit.window.requested.limit
    expect(isWindowCovering(missingLimit, { kind: 'latest', topicId: 't1', limit: 5 }, 't1')).toBe(false)
  })
  it('latest: fail-closed when cached requested.limit out of bounds', () => {
    for (const bad of [0, 101, NaN, '10' as any, null as any]) {
      const c = makeWindow('latest', { requested: { limit: bad } })
      expect(isWindowCovering(c, { kind: 'latest', topicId: 't1', limit: 5 }, 't1')).toBe(false)
    }
  })
  it('around: fail-closed when cached requested.before/after missing (no fallback to 0)', () => {
    const emptyReq = {
      messages: [],
      blocks: [],
      window: {
        kind: 'around' as const,
        completeness: 'window' as const,
        topicId: 't1',
        anchorMessageId: 'm2',
        requested: {} as any,
        firstMessageId: 'm1',
        lastMessageId: 'm3',
        returnedCount: 1,
        hasMoreBefore: false,
        hasMoreAfter: false
      }
    } as any
    expect(
      isWindowCovering(emptyReq, { kind: 'around', topicId: 't1', anchorMessageId: 'm2', before: 1, after: 1 }, 't1')
    ).toBe(false)
    const missingBefore = {
      messages: [],
      blocks: [],
      window: {
        kind: 'around' as const,
        completeness: 'window' as const,
        topicId: 't1',
        anchorMessageId: 'm2',
        requested: { after: 10 } as any,
        firstMessageId: 'm1',
        lastMessageId: 'm3',
        returnedCount: 1,
        hasMoreBefore: false,
        hasMoreAfter: false
      }
    } as any
    expect(
      isWindowCovering(
        missingBefore,
        { kind: 'around', topicId: 't1', anchorMessageId: 'm2', before: 5, after: 5 },
        't1'
      )
    ).toBe(false)
    const missingAfter = {
      messages: [],
      blocks: [],
      window: {
        kind: 'around' as const,
        completeness: 'window' as const,
        topicId: 't1',
        anchorMessageId: 'm2',
        requested: { before: 10 } as any,
        firstMessageId: 'm1',
        lastMessageId: 'm3',
        returnedCount: 1,
        hasMoreBefore: false,
        hasMoreAfter: false
      }
    } as any
    expect(
      isWindowCovering(
        missingAfter,
        { kind: 'around', topicId: 't1', anchorMessageId: 'm2', before: 5, after: 5 },
        't1'
      )
    ).toBe(false)
  })
  it('around: fail-closed when cached requested has limit instead of before/after', () => {
    const malformed = {
      messages: [],
      blocks: [],
      window: {
        kind: 'around' as const,
        completeness: 'window' as const,
        topicId: 't1',
        anchorMessageId: 'm2',
        requested: { limit: 10 } as any,
        firstMessageId: 'm1',
        lastMessageId: 'm3',
        returnedCount: 1,
        hasMoreBefore: false,
        hasMoreAfter: false
      }
    } as any
    expect(
      isWindowCovering(malformed, { kind: 'around', topicId: 't1', anchorMessageId: 'm2', before: 5, after: 5 }, 't1')
    ).toBe(false)
  })
})
