import {
  bumpAndInvalidate,
  bumpAndInvalidateAll,
  getCachedContextClosure,
  getClosureInvalidationListenerCountForTests,
  getFreshValidatedClosure,
  resetAllClosureStateForTests
} from '@renderer/services/contextClosure'
import type { FetchContextClosureResponse } from '@shared/chatDb'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  fetchClosureMock,
  dispatchMock,
  getStateMock,
  upsertManyBlocksMock,
  selectLoadedMessagesForTopicMock,
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
    selectLoadedMessagesForTopicMock: vi.fn(
      (_state: unknown, topicId: string) => messagesForTopicMap.get(topicId) ?? []
    ),
    captureDeletionGenerationMock: vi.fn(() => 0),
    isDeletionStaleMock: vi.fn(() => false),
    topicMessagesMap,
    messagesForTopicMap
  }
})

vi.mock('@renderer/hooks/useMessageOperations', () => ({
  useLoadedTopicMessages: (topicId: string) => topicMessagesMap.get(topicId) ?? []
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
    selectLoadedMessagesForTopic: selectLoadedMessagesForTopicMock
  }
})

const { useContextClosure } = await import('../useContextClosure')

function makeResp(
  topicId: string,
  anchor: string,
  ids: string[] = ['u1', 'a1'],
  counts?: { total: number; selected: number }
): FetchContextClosureResponse {
  const messages = ids.map((id) => ({
    id,
    role: id.startsWith('u') ? 'user' : 'assistant',
    topicId,
    ...(id.startsWith('a') ? { askId: ids[0] } : {})
  }))
  const userCount = ids.filter((id) => id.startsWith('u')).length || 1
  const totalTurnCount = counts?.total ?? userCount
  const selectedTurnCount = counts?.selected ?? totalTurnCount
  const isWhole = selectedTurnCount === totalTurnCount
  return {
    messages: messages as any,
    blocks: [{ id: `b-${topicId}-${ids[0]}`, messageId: ids[0], type: 'main_text', content: `c-${ids[0]}` }] as any,
    closure: {
      completeness: 'context-closure' as const,
      topicId,
      anchorGroupKey: anchor,
      firstMessageId: ids[0] ?? null,
      lastMessageId: ids[ids.length - 1] ?? null,
      returnedCount: ids.length,
      totalTurnCount,
      selectedTurnCount,
      boundaryMessageId: isWhole ? null : (ids[0] ?? null)
    }
  } as any
}

function makeAssistantState(anchorMap: Record<string, string>) {
  const anchorObj = Object.fromEntries(
    Object.entries(anchorMap).map(([topicId, groupKey]) => [topicId, { kind: 'active', groupKey }])
  )
  return {
    assistants: {
      assistants: [
        {
          id: 'asst-1',
          topics: Object.keys(anchorMap).map((id) => ({ id })),
          settings: { contextWindowAnchor: anchorObj }
        }
      ]
    },
    messages: { entities: {}, messageIdsByTopic: {} },
    messageBlocks: { entities: {} }
  }
}

describe('semantic reactive refresh (viewport-independent, no fingerprint)', () => {
  beforeEach(() => {
    resetAllClosureStateForTests()
    vi.clearAllMocks()
    topicMessagesMap.clear()
    messagesForTopicMap.clear()
    getStateMock.mockReturnValue(
      makeAssistantState({ 't-stream': 'u1', 't-out': 'u1', 't-a': 'u1', 't-b': 'u1' }) as any
    )
    captureDeletionGenerationMock.mockReturnValue(0)
    isDeletionStaleMock.mockReturnValue(false)
    fetchClosureMock.mockReset()
    dispatchMock.mockReset()
    upsertManyBlocksMock.mockClear()
  })

  it('deferred initial fetch invalidated during streaming with unchanged viewport length: stale rejected THEN fresh fetched/counts recovered', async () => {
    const topicId = 't-stream'
    const anchor = 'u1'
    // Viewport length fixed at 1 for the whole test (no length change).
    const viewport = [{ id: 'u1', role: 'user', topicId, blocks: [] }]
    topicMessagesMap.set(topicId, viewport as any)
    messagesForTopicMap.set(topicId, viewport as any)

    let resolveFirst!: (v: FetchContextClosureResponse) => void
    let resolveSecond!: (v: FetchContextClosureResponse) => void
    const firstDeferred = new Promise<FetchContextClosureResponse>((res) => {
      resolveFirst = res
    })
    const secondDeferred = new Promise<FetchContextClosureResponse>((res) => {
      resolveSecond = res
    })
    let callIndex = 0
    fetchClosureMock.mockImplementation(() => {
      callIndex += 1
      if (callIndex === 1) return firstDeferred
      return secondDeferred
    })

    const { result } = renderHook(({ t, a }) => useContextClosure(t, a), {
      initialProps: { t: topicId, a: anchor }
    })

    await act(async () => {
      await Promise.resolve()
    })
    expect(fetchClosureMock).toHaveBeenCalledTimes(1)
    expect(viewport.length).toBe(1)

    // Streaming/final block+message updates invalidate WITHOUT viewport length change.
    await act(async () => {
      bumpAndInvalidate(topicId)
      await Promise.resolve()
    })
    // Reactive refresh: second fetch starts despite unchanged viewport length.
    await waitFor(() => expect(fetchClosureMock).toHaveBeenCalledTimes(2))
    expect(viewport.length).toBe(1)
    // Viewport-independent proof: length never changed, yet refetch occurred.
    expect(topicMessagesMap.get(topicId)?.length).toBe(1)

    // Stale first snapshot resolves with old authority (1/1) — must be rejected.
    const staleResp = makeResp(topicId, anchor, ['u1', 'a1'], { total: 1, selected: 1 })
    await act(async () => {
      resolveFirst(staleResp)
      await firstDeferred
      await new Promise((r) => setTimeout(r, 0))
    })
    // Stale discarded: no cache publication from stale seq.
    expect(getCachedContextClosure(topicId)).toBeNull()
    expect(result.current.closure).toBeNull()

    // Fresh authority resolves (2/2) — accepted and counts recovered.
    const freshResp = makeResp(topicId, anchor, ['u1', 'a1', 'u2', 'a2'], { total: 2, selected: 2 })
    await act(async () => {
      resolveSecond(freshResp)
      await secondDeferred
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(() => expect(result.current.closure).not.toBeNull())
    expect(result.current.closure?.closure.totalTurnCount).toBe(2)
    expect(result.current.closure?.closure.selectedTurnCount).toBe(2)
    expect(getCachedContextClosure(topicId)).not.toBeNull()
    expect(getFreshValidatedClosure(topicId, anchor, undefined, null)?.closure.totalTurnCount).toBe(2)
    // Still no viewport length change throughout.
    expect(topicMessagesMap.get(topicId)?.length).toBe(1)
  })

  it('true outside-viewport mutation triggers refresh; read-only window merge does NOT fetch extra', async () => {
    const topicId = 't-out'
    const anchor = 'u1'
    const viewport = [
      { id: 'u1', role: 'user', topicId, blocks: [] },
      { id: 'a1', role: 'assistant', askId: 'u1', topicId, blocks: [] }
    ]
    topicMessagesMap.set(topicId, viewport as any)
    messagesForTopicMap.set(topicId, viewport as any)

    const seedResp = makeResp(topicId, anchor, ['u1', 'a1'], { total: 5, selected: 5 })
    fetchClosureMock.mockResolvedValueOnce(seedResp)
    const { result, rerender } = renderHook(({ t, a }) => useContextClosure(t, a), {
      initialProps: { t: topicId, a: anchor }
    })
    await waitFor(() => expect(result.current.closure).not.toBeNull())
    expect(fetchClosureMock).toHaveBeenCalledTimes(1)
    fetchClosureMock.mockClear()

    // True content mutation outside viewport, same viewport length: must refetch.
    const freshAfterMut = makeResp(topicId, anchor, ['u1', 'a1'], { total: 6, selected: 6 })
    fetchClosureMock.mockResolvedValueOnce(freshAfterMut)
    await act(async () => {
      bumpAndInvalidate(topicId)
      await Promise.resolve()
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(() => expect(fetchClosureMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(result.current.closure).not.toBeNull())
    expect(result.current.closure?.closure.totalTurnCount).toBe(6)
    fetchClosureMock.mockClear()

    // Read-only window merge (viewport growth, no generation bump): must NOT fetch extra.
    const grown = [
      ...viewport,
      { id: 'u2', role: 'user', topicId, blocks: [] },
      { id: 'a2', role: 'assistant', askId: 'u2', topicId, blocks: [] }
    ]
    topicMessagesMap.set(topicId, grown as any)
    messagesForTopicMap.set(topicId, grown as any)
    await act(async () => {
      rerender({ t: topicId, a: anchor })
      await Promise.resolve()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(fetchClosureMock).not.toHaveBeenCalled()
    expect(result.current.closure).not.toBeNull()
    expect(result.current.closure?.closure.totalTurnCount).toBe(6)

    // Global unknown-ownership mutation also refreshes the current route.
    const afterGlobal = makeResp(topicId, anchor, ['u1', 'a1'], { total: 7, selected: 7 })
    fetchClosureMock.mockResolvedValueOnce(afterGlobal)
    await act(async () => {
      bumpAndInvalidateAll()
      await Promise.resolve()
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(() => expect(fetchClosureMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(result.current.closure?.closure.totalTurnCount).toBe(7))
  })

  it('route switch ignores old results and subscriptions do not leak', async () => {
    const topicA = 't-a'
    const topicB = 't-b'
    for (const tid of [topicA, topicB]) {
      const msgs = [{ id: 'u1', role: 'user', topicId: tid, blocks: [] }]
      topicMessagesMap.set(tid, msgs as any)
      messagesForTopicMap.set(tid, msgs as any)
    }
    let resolveA!: (v: FetchContextClosureResponse) => void
    let resolveB!: (v: FetchContextClosureResponse) => void
    const deferredA = new Promise<FetchContextClosureResponse>((res) => {
      resolveA = res
    })
    const deferredB = new Promise<FetchContextClosureResponse>((res) => {
      resolveB = res
    })
    fetchClosureMock.mockImplementation((req: any) => {
      if (req.topicId === topicA) return deferredA
      if (req.topicId === topicB) return deferredB
      return Promise.resolve(makeResp(req.topicId, req.anchorGroupKey))
    })
    getStateMock.mockReturnValue(makeAssistantState({ [topicA]: 'u1', [topicB]: 'u1' }) as any)

    const { result, rerender, unmount } = renderHook(({ t, a }) => useContextClosure(t, a), {
      initialProps: { t: topicA, a: 'u1' }
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(fetchClosureMock).toHaveBeenCalledTimes(1)
    expect(getClosureInvalidationListenerCountForTests()).toBe(1)

    await act(async () => {
      rerender({ t: topicB, a: 'u1' })
      await Promise.resolve()
    })
    await waitFor(() => expect(fetchClosureMock).toHaveBeenCalledTimes(2))
    // Same hook instance after route switch: still exactly one subscription (no leak).
    expect(getClosureInvalidationListenerCountForTests()).toBe(1)

    // Old route result resolves late — must be ignored (seq/route guard).
    const staleA = makeResp(topicA, 'u1', ['u1', 'a1'], { total: 9, selected: 9 })
    await act(async () => {
      resolveA(staleA)
      await deferredA
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(getCachedContextClosure(topicA)).toBeNull()
    expect(result.current.closure?.closure.topicId).not.toBe(topicA)

    // Current route resolves — accepted.
    const freshB = makeResp(topicB, 'u1', ['u1', 'a1'], { total: 3, selected: 3 })
    await act(async () => {
      resolveB(freshB)
      await deferredB
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(() => expect(result.current.closure).not.toBeNull())
    expect(result.current.closure?.closure.topicId).toBe(topicB)
    expect(getCachedContextClosure(topicB)).not.toBeNull()
    expect(getCachedContextClosure(topicA)).toBeNull()

    // Mutating the old route never leaks into the current route.
    fetchClosureMock.mockClear()
    await act(async () => {
      bumpAndInvalidate(topicA)
      await Promise.resolve()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(fetchClosureMock).not.toHaveBeenCalled()
    expect(result.current.closure?.closure.topicId).toBe(topicB)

    unmount()
    expect(getClosureInvalidationListenerCountForTests()).toBe(0)
  })

  it('null route/anchor keeps empty behavior (no fetch, null closure)', async () => {
    const msgs = [{ id: 'u1', role: 'user', topicId: 't-stream', blocks: [] }]
    topicMessagesMap.set('t-stream', msgs as any)
    const { result } = renderHook(({ t, a }: { t: string; a: string | null }) => useContextClosure(t, a), {
      initialProps: { t: 't-stream', a: null }
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(fetchClosureMock).not.toHaveBeenCalled()
    expect(result.current.closure).toBeNull()
    expect(result.current.loading).toBe(false)

    const { result: emptyTopic } = renderHook(({ t, a }: { t: string; a: string | null }) => useContextClosure(t, a), {
      initialProps: { t: '', a: 'u1' }
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(emptyTopic.current.closure).toBeNull()
  })
})
