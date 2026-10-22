import {
  bumpAndInvalidate,
  getFreshValidatedClosure,
  isAcceptedClosureForRoute,
  resetAllClosureStateForTests
} from '@renderer/services/contextClosure'
import { resolveSharedContextInfo } from '@renderer/services/contextInfoService'
import type { FetchContextClosureResponse } from '@shared/chatDb'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchClosureMock, dispatchMock, getStateMock, upsertManyBlocksMock, topicMessagesMap, messagesForTopicMap } =
  vi.hoisted(() => {
    const topicMessagesMap = new Map<string, unknown[]>()
    const messagesForTopicMap = new Map<string, unknown[]>()
    return {
      fetchClosureMock: vi.fn(),
      dispatchMock: vi.fn(),
      getStateMock: vi.fn(),
      upsertManyBlocksMock: vi.fn((blocks: unknown) => ({ type: 'messageBlocks/upsertManyBlocks', payload: blocks })),
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
  captureDeletionGeneration: () => 0,
  isDeletionStale: () => false
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
    selectLoadedMessagesForTopic: (_state: unknown, topicId: string) => messagesForTopicMap.get(topicId) ?? []
  }
})

vi.mock('@renderer/services/AssistantService', () => ({
  getAssistantSettings: (assistant: any) => ({
    contextCount: assistant?.settings?.contextCount ?? 25,
    contextWindowAnchor: assistant?.settings?.contextWindowAnchor ?? {}
  })
}))

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
    blocks: [],
    ...(id.startsWith('a') ? { askId: ids[0] } : {})
  }))
  const userCount = ids.filter((id) => id.startsWith('u')).length || 1
  const totalTurnCount = counts?.total ?? userCount
  const selectedTurnCount = counts?.selected ?? totalTurnCount
  const isWhole = selectedTurnCount === totalTurnCount
  return {
    messages: messages as any,
    blocks: [],
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

function assistantWithAnchor(routeKey: string, groupKey: string | null): any {
  return {
    id: 'asst-1',
    settings: {
      contextCount: 5,
      contextWindowAnchor: groupKey ? { [routeKey]: { kind: 'active', groupKey } } : {}
    }
  }
}

describe('accepted complete-route projection retention (root regression correction)', () => {
  beforeEach(() => {
    resetAllClosureStateForTests()
    vi.clearAllMocks()
    topicMessagesMap.clear()
    messagesForTopicMap.clear()
    getStateMock.mockReturnValue(makeAssistantState({ 't-retain': 'u1' }) as any)
    fetchClosureMock.mockReset()
    dispatchMock.mockReset()
  })

  it('ordinary streamed content invalidation retains accepted counts/boundary (no blank interim), cache stays strict', async () => {
    const topicId = 't-retain'
    const anchor = 'u1'
    const viewport = [{ id: 'u1', role: 'user', topicId, blocks: [] }]
    topicMessagesMap.set(topicId, viewport as any)
    messagesForTopicMap.set(topicId, viewport as any)

    // Accepted complete projection: 4/6 with boundary u1 (partial window).
    const accepted = makeResp(topicId, anchor, ['u1', 'a1', 'u2', 'a2'], { total: 6, selected: 4 })
    // Boundary for partial must be firstMessageId per validator.
    expect(accepted.closure.boundaryMessageId).toBe('u1')
    fetchClosureMock.mockResolvedValueOnce(accepted)
    const { result } = renderHook(({ t, a }) => useContextClosure(t, a), {
      initialProps: { t: topicId, a: anchor }
    })
    await waitFor(() => expect(result.current.closure).not.toBeNull())
    expect(result.current.closure?.closure.selectedTurnCount).toBe(4)
    expect(result.current.closure?.closure.totalTurnCount).toBe(6)
    const retainedRef = result.current.closure
    fetchClosureMock.mockClear()

    // Ordinary streamed text/status update: genuine block write bumps strict
    // generation (cache invalidated) WITHOUT changing turn structure.
    // Defer the background refetch so we can observe the retained gap.
    let resolveBg!: (v: FetchContextClosureResponse) => void
    const bgDeferred = new Promise<FetchContextClosureResponse>((res) => {
      resolveBg = res
    })
    fetchClosureMock.mockImplementationOnce(() => bgDeferred)
    await act(async () => {
      bumpAndInvalidate(topicId)
      await Promise.resolve()
      await new Promise((r) => setTimeout(r, 0))
    })
    // Strict cache freshness rejects (request/cache stays strict).
    expect(getFreshValidatedClosure(topicId, anchor, undefined, null)).toBeNull()
    // UI acceptance RETAINS (no blank, no 0 reset, same counts/boundary).
    await waitFor(() => expect(fetchClosureMock).toHaveBeenCalledTimes(1))
    expect(result.current.closure).not.toBeNull()
    expect(result.current.closure).toBe(retainedRef)
    expect(result.current.closure?.closure.selectedTurnCount).toBe(4)
    expect(result.current.closure?.closure.totalTurnCount).toBe(6)
    expect(result.current.closure?.closure.boundaryMessageId).toBe('u1')
    // Shared projection from retained accepted: authoritative, not pending,
    // never viewport-derived.
    const info = resolveSharedContextInfo(
      viewport as any,
      assistantWithAnchor(topicId, anchor),
      topicId,
      result.current.closure as any,
      null
    )
    expect(info.isAuthoritativePending).toBe(false)
    expect(info.contextCount).toEqual({ current: 4, max: 6 })
    expect(info.boundaryMessageId).toBe('u1')

    // Full authoritative result arrives: atomically replaces in one commit
    // (no empty interim observed — retained until commit).
    const next = makeResp(topicId, anchor, ['u1', 'a1', 'u2', 'a2'], { total: 6, selected: 4 })
    await act(async () => {
      resolveBg(next)
      await bgDeferred
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(() => expect(result.current.closure?.closure.totalTurnCount).toBe(6))
    // Same structural counts → commit accepted (reference may be new fetch
    // object, but counts/boundary stable, never blank).
    expect(result.current.closure?.closure.selectedTurnCount).toBe(4)
    expect(result.current.closure?.closure.boundaryMessageId).toBe('u1')
  })

  it('structurally new accepted closure atomically replaces (old retained until commit, never empty)', async () => {
    const topicId = 't-retain'
    const anchor = 'u1'
    const viewport = [{ id: 'u1', role: 'user', topicId, blocks: [] }]
    topicMessagesMap.set(topicId, viewport as any)
    messagesForTopicMap.set(topicId, viewport as any)

    const first = makeResp(topicId, anchor, ['u1', 'a1'], { total: 2, selected: 2 })
    fetchClosureMock.mockResolvedValueOnce(first)
    const { result } = renderHook(({ t, a }) => useContextClosure(t, a), {
      initialProps: { t: topicId, a: anchor }
    })
    await waitFor(() => expect(result.current.closure).not.toBeNull())
    expect(result.current.closure?.closure.totalTurnCount).toBe(2)
    fetchClosureMock.mockClear()

    // Structural append invalidates; background fetch deferred.
    let resolveBg!: (v: FetchContextClosureResponse) => void
    const bgDeferred = new Promise<FetchContextClosureResponse>((res) => {
      resolveBg = res
    })
    fetchClosureMock.mockImplementationOnce(() => bgDeferred)
    await act(async () => {
      bumpAndInvalidate(topicId)
      await Promise.resolve()
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(() => expect(fetchClosureMock).toHaveBeenCalledTimes(1))
    // Old retained (2/2), never empty interim.
    expect(result.current.closure?.closure.totalTurnCount).toBe(2)
    expect(result.current.closure?.closure.selectedTurnCount).toBe(2)

    // New authoritative result (3/3) commits atomically.
    const grown = makeResp(topicId, anchor, ['u1', 'a1', 'u2', 'a2'], { total: 3, selected: 3 })
    // Fix boundary for whole-window: null.
    expect(grown.closure.boundaryMessageId).toBeNull()
    await act(async () => {
      resolveBg(grown)
      await bgDeferred
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(() => expect(result.current.closure?.closure.totalTurnCount).toBe(3))
    expect(result.current.closure?.closure.selectedTurnCount).toBe(3)
  })

  it('cold/new route with no accepted projection stays pending (no viewport counts), anchorless empty route uses fallback', async () => {
    const viewport = [
      { id: 'u1', role: 'user', topicId: 't-cold', blocks: [] },
      { id: 'a1', role: 'assistant', askId: 'u1', topicId: 't-cold', blocks: [] }
    ]
    // Persisted anchor exists but no accepted yet → pending (hide, no counts).
    const pending = resolveSharedContextInfo(viewport as any, assistantWithAnchor('t-cold', 'u1'), 't-cold', null, null)
    expect(pending.isAuthoritativePending).toBe(true)
    expect(pending.contextCount).toEqual({ current: 0, max: null })
    expect(pending.boundaryMessageId).toBeNull()
    expect(pending.uiMessages).toEqual([])
    // NON-EMPTY route without any persisted anchor (branch-establishment
    // transition): the loaded viewport must never become the authoritative
    // current/max (it would report e.g. 7/7 for a 49-turn route).
    const anchorlessNonEmpty = resolveSharedContextInfo(
      viewport as any,
      assistantWithAnchor('t-cold', null),
      't-cold',
      null,
      null
    )
    expect(anchorlessNonEmpty.isAuthoritativePending).toBe(true)
    expect(anchorlessNonEmpty.contextCount).toEqual({ current: 0, max: null })
    expect(anchorlessNonEmpty.boundaryMessageId).toBeNull()
    expect(anchorlessNonEmpty.anchorGroupKey).toBeNull()
    // EMPTY route keeps the legitimate anchorless 0/0 fallback (I-1).
    const emptyRoute = resolveSharedContextInfo([], assistantWithAnchor('t-cold', null), 't-cold', null, null)
    expect(emptyRoute.isAuthoritativePending).toBe(false)
    expect(emptyRoute.contextCount).toEqual({ current: 0, max: 0 })
    expect(emptyRoute.anchorGroupKey).toBeNull()
  })

  it('route/anchor rapid change never leaks previous-route counts (fail-closed)', async () => {
    const topicA = 't-route-a'
    const topicB = 't-route-b'
    for (const tid of [topicA, topicB]) {
      const msgs = [{ id: 'u1', role: 'user', topicId: tid, blocks: [] }]
      topicMessagesMap.set(tid, msgs as any)
      messagesForTopicMap.set(tid, msgs as any)
    }
    getStateMock.mockReturnValue(makeAssistantState({ [topicA]: 'u1', [topicB]: 'u1' }) as any)
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
    const { result, rerender } = renderHook(({ t, a }) => useContextClosure(t, a), {
      initialProps: { t: topicA, a: 'u1' }
    })
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      rerender({ t: topicB, a: 'u1' })
      await Promise.resolve()
      await new Promise((r) => setTimeout(r, 0))
    })
    // During/after rapid switch, never display previous-route counts.
    // Accepted for B not yet arrived → null (pending), not A's closure.
    expect(result.current.closure?.closure.topicId).not.toBe(topicA)
    // Late A result ignored.
    await act(async () => {
      resolveA(makeResp(topicA, 'u1', ['u1', 'a1'], { total: 9, selected: 9 }))
      await deferredA
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(result.current.closure?.closure.topicId).not.toBe(topicA)
    // B arrives → accepted for B only.
    await act(async () => {
      resolveB(makeResp(topicB, 'u1', ['u1', 'a1'], { total: 3, selected: 3 }))
      await deferredB
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(() => expect(result.current.closure).not.toBeNull())
    expect(result.current.closure?.closure.topicId).toBe(topicB)
    // Acceptance helper rejects cross-identity display.
    expect(isAcceptedClosureForRoute(result.current.closure, topicA, 'u1')).toBe(false)
    expect(isAcceptedClosureForRoute(result.current.closure, topicB, 'u1')).toBe(true)
    expect(isAcceptedClosureForRoute(result.current.closure, topicB, 'other-anchor')).toBe(false)
  })

  it('invalid/deleted anchor authoritative response fail-closes (no previous counts)', async () => {
    const topicId = 't-retain'
    const anchor = 'u1'
    const viewport = [{ id: 'u1', role: 'user', topicId, blocks: [] }]
    topicMessagesMap.set(topicId, viewport as any)
    messagesForTopicMap.set(topicId, viewport as any)
    const seed = makeResp(topicId, anchor, ['u1', 'a1'], { total: 2, selected: 2 })
    fetchClosureMock.mockResolvedValueOnce(seed)
    const { result } = renderHook(({ t, a }) => useContextClosure(t, a), {
      initialProps: { t: topicId, a: anchor }
    })
    await waitFor(() => expect(result.current.closure).not.toBeNull())
    fetchClosureMock.mockClear()

    // Anchor deleted in authority: next fetch returns structurally invalid
    // for the current anchor (missing anchor row) → fail-closed to null.
    const invalidForAnchor = makeResp(topicId, 'u1', ['u9', 'a9'], { total: 2, selected: 2 })
    // Force anchor-row miss: messages do not contain 'u1'.
    expect(invalidForAnchor.messages.every((m: any) => m.id !== 'u1')).toBe(true)
    fetchClosureMock.mockResolvedValueOnce(invalidForAnchor)
    await act(async () => {
      bumpAndInvalidate(topicId)
      await Promise.resolve()
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(() => expect(result.current.closure).toBeNull())
    // And the shared projection from null + persisted anchor is pending
    // (hide), never previous-route counts.
    const info = resolveSharedContextInfo(
      viewport as any,
      assistantWithAnchor(topicId, anchor),
      topicId,
      result.current.closure as any,
      null
    )
    expect(info.isAuthoritativePending).toBe(true)
    expect(info.boundaryMessageId).toBeNull()
  })

  it('same IDs with updated block/message objects produce new projection (no id-only freeze)', async () => {
    // Regression guard for the removed Chat id-only stabilization memo: an
    // equality check on message IDs alone would discard same-ID updated
    // blocks/message objects, leaving the history token-estimate input stale.
    // resolveSharedContextInfo must return new references when the accepted
    // closure carries new Message instances, even with identical IDs.
    const topicId = 't-retain'
    const anchor = 'u1'
    const first = makeResp(topicId, anchor, ['u1', 'a1', 'u2', 'a2'], { total: 6, selected: 4 })
    const viewport = [{ id: 'u1', role: 'user', topicId, blocks: [] }]
    const infoA = resolveSharedContextInfo(
      viewport as any,
      assistantWithAnchor(topicId, anchor),
      topicId,
      first as any,
      null
    )
    // Same IDs, but brand-new Message object identities (simulating updated
    // block refs / content / re-fetched instances).
    const second = makeResp(topicId, anchor, ['u1', 'a1', 'u2', 'a2'], { total: 6, selected: 4 })
    expect(second.messages).not.toBe(first.messages)
    const infoB = resolveSharedContextInfo(
      viewport as any,
      assistantWithAnchor(topicId, anchor),
      topicId,
      second as any,
      null
    )
    expect(infoB).not.toBe(infoA)
    expect(infoB.uiMessages).not.toBe(infoA.uiMessages)
    expect(infoB.tokenEstimationMessages).not.toBe(infoA.tokenEstimationMessages)
    // Counts/boundary stable, but the token input arrays are fresh objects.
    expect(infoB.contextCount).toEqual({ current: 4, max: 6 })
    expect(infoB.boundaryMessageId).toBe('u1')
  })

  it('transient read error retains accepted (no blank), retries on next signal', async () => {
    const topicId = 't-retain'
    const anchor = 'u1'
    const viewport = [{ id: 'u1', role: 'user', topicId, blocks: [] }]
    topicMessagesMap.set(topicId, viewport as any)
    messagesForTopicMap.set(topicId, viewport as any)
    const seed = makeResp(topicId, anchor, ['u1', 'a1'], { total: 2, selected: 2 })
    fetchClosureMock.mockResolvedValueOnce(seed)
    const { result } = renderHook(({ t, a }) => useContextClosure(t, a), {
      initialProps: { t: topicId, a: anchor }
    })
    await waitFor(() => expect(result.current.closure).not.toBeNull())
    fetchClosureMock.mockClear()
    fetchClosureMock.mockRejectedValueOnce(new Error('db transient'))
    await act(async () => {
      bumpAndInvalidate(topicId)
      await Promise.resolve()
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
    })
    // Retained despite transient failure.
    expect(result.current.closure?.closure.totalTurnCount).toBe(2)
    // Next signal retries and commits.
    const recovered = makeResp(topicId, anchor, ['u1', 'a1'], { total: 2, selected: 2 })
    fetchClosureMock.mockResolvedValueOnce(recovered)
    await act(async () => {
      bumpAndInvalidate(topicId)
      await Promise.resolve()
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(() => expect(result.current.closure).not.toBeNull())
    expect(result.current.closure?.closure.totalTurnCount).toBe(2)
  })
})
