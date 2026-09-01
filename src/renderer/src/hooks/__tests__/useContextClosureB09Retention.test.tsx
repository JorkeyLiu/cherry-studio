import {
  computeClosureFingerprint,
  getAllCachedTopicIds,
  getCachedContextClosure,
  getClosureLoadGeneration,
  getGlobalBlockGeneration,
  resetAllClosureStateForTests,
  setCachedContextClosureWithFingerprint
} from '@renderer/services/contextClosure'
import type { FetchContextClosureResponse } from '@shared/chatDb'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Hoisted shared state ────────────────────────────────────────────────────

const {
  fetchClosureMock,
  dispatchMock,
  getStateMock,
  upsertManyBlocksMock,
  selectMessagesForTopicMock,
  captureDeletionGenerationMock,
  isDeletionStaleMock,
  topicMessagesMap,
  messagesForTopicMap
} = vi.hoisted(() => {
  const topicMessagesMap = new Map<string, unknown[]>()
  const messagesForTopicMap = new Map<string, unknown[]>()
  return {
    fetchClosureMock: vi.fn(),
    dispatchMock: vi.fn(),
    getStateMock: vi.fn(),
    upsertManyBlocksMock: vi.fn((blocks: unknown) => ({ type: 'messageBlocks/upsertManyBlocks', payload: blocks })),
    selectMessagesForTopicMock: vi.fn((_state: unknown, topicId: string) => messagesForTopicMap.get(topicId) ?? []),
    captureDeletionGenerationMock: vi.fn(() => 0),
    isDeletionStaleMock: vi.fn(() => false),
    topicMessagesMap,
    messagesForTopicMap
  }
})

// ── Mocks (must be before hook import) ─────────────────────────────────────

vi.mock('@renderer/hooks/useMessageOperations', () => ({
  useTopicMessages: (topicId: string) => topicMessagesMap.get(topicId) ?? []
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    fetchContextClosure: fetchClosureMock
  }
}))

vi.mock('@renderer/services/topicDeletionInvalidation', () => ({
  captureDeletionGeneration: captureDeletionGenerationMock,
  isDeletionStale: isDeletionStaleMock
}))

vi.mock('@renderer/store', async () => {
  const actual: any = await vi.importActual('@renderer/store')
  return {
    ...actual,
    default: {
      getState: getStateMock,
      dispatch: dispatchMock,
      subscribe: vi.fn()
    },
    useAppDispatch: () => dispatchMock
  }
})

vi.mock('@renderer/store/messageBlock', async () => {
  const actual: any = await vi.importActual('@renderer/store/messageBlock')
  return {
    ...actual,
    upsertManyBlocks: upsertManyBlocksMock
  }
})

vi.mock('@renderer/store/newMessage', async () => {
  const actual: any = await vi.importActual('@renderer/store/newMessage')
  return {
    ...actual,
    selectMessagesForTopic: selectMessagesForTopicMock
  }
})

// ── Import hook after mocks ─────────────────────────────────────────────────

const { useContextClosure } = await import('../useContextClosure')

function makeResp(topicId: string, anchor: string, ids: string[] = ['u1', 'a1', 'u2']): FetchContextClosureResponse {
  const messages = ids.map((id) => ({
    id,
    role: id.startsWith('u') ? 'user' : 'assistant',
    topicId,
    ...(id.startsWith('a') ? { askId: 'u1' } : {})
  }))
  // Coherent authoritative metadata: user-count turns; whole when anchor===first, else partial with boundary==first
  const userCount = ids.filter((id) => id.startsWith('u')).length || 1
  const totalTurnCount = userCount
  const isWhole = anchor === ids[0]
  const selectedTurnCount = isWhole ? totalTurnCount : 1
  const boundaryMessageId = isWhole ? null : (ids[0] ?? null)
  return {
    messages: messages as any,
    blocks: [{ id: `b-${topicId}`, messageId: ids[0], type: 'main_text', content: `block-${topicId}` }] as any,
    closure: {
      completeness: 'context-closure' as const,
      topicId,
      anchorGroupKey: anchor,
      firstMessageId: ids[0] ?? null,
      lastMessageId: ids[ids.length - 1] ?? null,
      returnedCount: ids.length,
      totalTurnCount,
      selectedTurnCount,
      boundaryMessageId
    }
  } as any
}

function makeAssistantState(anchorMap: Record<string, string>) {
  const anchorEntries = Object.entries(anchorMap).map(([topicId, groupKey]) => [topicId, { kind: 'active', groupKey }])
  const anchorObj = Object.fromEntries(anchorEntries)
  return {
    assistants: {
      assistants: [
        {
          id: 'asst-1',
          topics: Object.keys(anchorMap).map((id) => ({ id })),
          settings: {
            contextWindowAnchor: anchorObj
          }
        }
      ]
    },
    messages: {
      entities: {},
      messageIdsByTopic: {}
    },
    messageBlocks: {
      entities: {}
    }
  }
}

describe('B-09 hook-level retention (useContextClosure)', () => {
  beforeEach(() => {
    resetAllClosureStateForTests()
    vi.clearAllMocks()
    topicMessagesMap.clear()
    messagesForTopicMap.clear()
    // Default anchor map with both topics
    getStateMock.mockReturnValue(makeAssistantState({ 't-active': 'u1', 't-stale': 'u1', t1: 'u1', t2: 'u1' }) as any)
    captureDeletionGenerationMock.mockReturnValue(0)
    isDeletionStaleMock.mockReturnValue(false)
    // Default messages for fingerprint stability
    const baseMsgs = [{ id: 'u1', role: 'user', topicId: 't-active', blocks: [] }]
    for (const tid of ['t-active', 't-stale', 't1', 't2']) {
      const msgs = [{ id: 'u1', role: 'user', topicId: tid, blocks: [] }]
      topicMessagesMap.set(tid, msgs as any)
      messagesForTopicMap.set(tid, msgs as any)
    }
    void baseMsgs
    fetchClosureMock.mockReset()
    dispatchMock.mockReset()
    upsertManyBlocksMock.mockClear()
    selectMessagesForTopicMock.mockClear()
  })

  it('activation and switch prune inactive closures — only active cache remains', async () => {
    // Seed both topics with valid closures before mounting hook (simulates prior navigations)
    const fp1 = computeClosureFingerprint([{ id: 'u1', role: 'user', topicId: 't1', blocks: [] }] as any)
    const fp2 = computeClosureFingerprint([{ id: 'u1', role: 'user', topicId: 't2', blocks: [] }] as any)
    setCachedContextClosureWithFingerprint('t1', makeResp('t1', 'u1'), fp1)
    setCachedContextClosureWithFingerprint('t2', makeResp('t2', 'u1'), fp2)
    expect(getAllCachedTopicIds().sort()).toEqual(['t1', 't2'])
    const genT1Before = getClosureLoadGeneration('t1')
    const genT2Before = getClosureLoadGeneration('t2')
    const globalBefore = getGlobalBlockGeneration()

    // Mock fetch to not be called when fresh cache hits (active remains valid without refetch)
    fetchClosureMock.mockRejectedValue(new Error('should not fetch when fresh'))

    // Mount hook for t1 active
    const { rerender, result } = renderHook(({ topicId, anchor }) => useContextClosure(topicId, anchor), {
      initialProps: { topicId: 't1', anchor: 'u1' }
    })

    // Need to await effects
    await act(async () => {
      await Promise.resolve()
    })

    // After activation, only t1 retained; generations/global preserved
    expect(getAllCachedTopicIds()).toEqual(['t1'])
    expect(getCachedContextClosure('t1')).not.toBeNull()
    expect(getCachedContextClosure('t2')).toBeNull()
    expect(getClosureLoadGeneration('t1')).toBe(genT1Before)
    expect(getClosureLoadGeneration('t2')).toBe(genT2Before)
    expect(getGlobalBlockGeneration()).toBe(globalBefore)
    // Hook has fresh closure without fetching
    await waitFor(() => expect(result.current.closure).not.toBeNull())
    expect(result.current.closure?.closure.topicId).toBe('t1')
    expect(fetchClosureMock).not.toHaveBeenCalled()

    // Seed t2 again (simulates refetch after switch) and switch to t2 — should prune t1
    const fp2b = computeClosureFingerprint([{ id: 'u1', role: 'user', topicId: 't2', blocks: [] }] as any)
    setCachedContextClosureWithFingerprint('t2', makeResp('t2', 'u1'), fp2b)

    // Before switch, both exist
    expect(getAllCachedTopicIds().sort()).toEqual(['t1', 't2'])

    await act(async () => {
      rerender({ topicId: 't2', anchor: 'u1' })
      await Promise.resolve()
    })
    // After switch, only t2 remains
    expect(getAllCachedTopicIds()).toEqual(['t2'])
    expect(getCachedContextClosure('t2')).not.toBeNull()
    expect(getCachedContextClosure('t1')).toBeNull()
    await waitFor(() => expect(result.current.closure).not.toBeNull())
    expect(result.current.closure?.closure.topicId).toBe('t2')
  })

  it('deferred stale fetch after topic switch does not publish closure/block data', async () => {
    // No cached entry for stale topic — fetch will be triggered
    resetAllClosureStateForTests()
    // Prepare deferred promises per topic
    let resolveStale!: (v: FetchContextClosureResponse) => void
    let resolveActive!: (v: FetchContextClosureResponse) => void
    const staleDeferred = new Promise<FetchContextClosureResponse>((res) => {
      resolveStale = res
    })
    const activeDeferred = new Promise<FetchContextClosureResponse>((res) => {
      resolveActive = res
    })

    const staleResp = makeResp('t-stale', 'u1', ['u1', 'a1'])
    const activeResp = makeResp('t-active', 'u1', ['u1', 'a1', 'u2'])

    fetchClosureMock.mockImplementation((req: any) => {
      if (req.topicId === 't-stale') return staleDeferred
      if (req.topicId === 't-active') return activeDeferred
      return Promise.resolve(makeResp(req.topicId, req.anchorGroupKey))
    })

    // Update getState anchor map to include both
    getStateMock.mockReturnValue(makeAssistantState({ 't-stale': 'u1', 't-active': 'u1' }) as any)

    const tStaleMsgs = [{ id: 'u1', role: 'user', topicId: 't-stale', blocks: [] }]
    const tActiveMsgs = [{ id: 'u1', role: 'user', topicId: 't-active', blocks: [] }]
    topicMessagesMap.set('t-stale', tStaleMsgs as any)
    messagesForTopicMap.set('t-stale', tStaleMsgs as any)
    topicMessagesMap.set('t-active', tActiveMsgs as any)
    messagesForTopicMap.set('t-active', tActiveMsgs as any)

    const { rerender, result } = renderHook(({ topicId, anchor }) => useContextClosure(topicId, anchor), {
      initialProps: { topicId: 't-stale', anchor: 'u1' }
    })

    // Wait for first fetch to start
    await act(async () => {
      await Promise.resolve()
    })
    expect(fetchClosureMock).toHaveBeenCalledTimes(1)
    expect(fetchClosureMock).toHaveBeenCalledWith({ topicId: 't-stale', anchorGroupKey: 'u1' })
    expect(getCachedContextClosure('t-stale')).toBeNull()

    // Switch to active topic before stale resolves — triggers retention pruning and new fetch
    await act(async () => {
      rerender({ topicId: 't-active', anchor: 'u1' })
      await Promise.resolve()
    })
    // Second fetch started for active
    await waitFor(() => expect(fetchClosureMock).toHaveBeenCalledTimes(2))
    expect(fetchClosureMock).toHaveBeenLastCalledWith({ topicId: 't-active', anchorGroupKey: 'u1' })

    // At this point, only active should be retained (stale had no cache, but after switch stale must not be cached)
    // Resolve stale first — should be discarded via seq/topic guard
    await act(async () => {
      resolveStale(staleResp)
      await staleDeferred
      // allow hook async continuation to run
      await Promise.resolve()
      await new Promise((r) => setTimeout(r, 0))
    })

    // Stale must not have published: no cache for stale, no upsert of stale blocks
    expect(getCachedContextClosure('t-stale')).toBeNull()
    expect(getAllCachedTopicIds()).not.toContain('t-stale')
    expect(upsertManyBlocksMock).not.toHaveBeenCalledWith(staleResp.blocks)
    // Closure should not be stale response
    expect(result.current.closure).not.toEqual(staleResp)
    // Could be null (still loading active) or not stale
    if (result.current.closure) {
      expect(result.current.closure.closure.topicId).not.toBe('t-stale')
    }

    // Now resolve active — should publish successfully
    await act(async () => {
      resolveActive(activeResp)
      await activeDeferred
      await Promise.resolve()
      await new Promise((r) => setTimeout(r, 0))
    })

    await waitFor(() => expect(result.current.closure).not.toBeNull())
    expect(result.current.closure?.closure.topicId).toBe('t-active')
    expect(getCachedContextClosure('t-active')).not.toBeNull()
    expect(getCachedContextClosure('t-stale')).toBeNull()
    expect(getAllCachedTopicIds()).toEqual(['t-active'])
    expect(upsertManyBlocksMock).toHaveBeenCalledWith(activeResp.blocks)
    // Ensure stale blocks never dispatched even after active success
    const allBlockPayloads = upsertManyBlocksMock.mock.calls.map((c: any) => c[0])
    expect(allBlockPayloads.flat().some((b: any) => b?.id === `b-t-stale`)).toBe(false)
  })
})
