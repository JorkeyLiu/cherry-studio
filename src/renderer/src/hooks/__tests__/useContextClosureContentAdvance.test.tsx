/**
 * Cold-race regression: a same-block streaming content mirror advancing during
 * an in-flight closure fetch must NOT discard the authoritative response.
 *
 * Real store (real `messageBlocks` reducer + real `closureInvalidationMiddleware`)
 * + real hook guards; only the DB boundary is mocked so a response can be held
 * in flight while a trusted mirror lands (a closure-freshness no-op).
 *
 * Covered:
 * - authoritative structure is accepted (preview counts present, not pending)
 * - the stale response body never overwrites the newer live delta
 * - response blocks are never published into the ordinary store (hydration
 *   exited): a roster block missing from the store stays absent there, and
 *   streaming bodies reach the UI context projection only through the
 *   execution-owned overlay (asserted via the registry composition)
 * - cache is usable after acceptance and no extra fetch is triggered
 * - a structural change during the flight still rejects
 * - accepted-projection retention guards still hold
 * - the same flow through `useContextWindowAnchor` (anchor still persists,
 *   no response blocks published)
 */
import { configureStore } from '@reduxjs/toolkit'
import {
  bumpAndInvalidate,
  getClosureLoadGeneration,
  getClosureSemanticToken,
  getFreshValidatedClosure,
  resetAllClosureStateForTests
} from '@renderer/services/contextClosure'
import { resolveSharedContextInfo } from '@renderer/services/contextInfoService'
import {
  getComposedOverlayBlocks,
  registerExecutionOverlay,
  resetExecutionOverlayForTests,
  routeKeyForExecutionOverlay,
  subscribeExecutionOverlay
} from '@renderer/services/executionOverlayRegistry'
import { closureInvalidationMiddleware } from '@renderer/store'
import assistantsReducer, { updateAssistants } from '@renderer/store/assistants'
import { markClosureContentMirror, withClosureTopics } from '@renderer/store/closureOwnership'
import messageBlocksReducer, { updateOneBlock, upsertOneBlock } from '@renderer/store/messageBlock'
import type { FetchContextClosureResponse } from '@shared/chatDb'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchClosureMock, resolveClosureMock, storeRef, proxy, dispatchFn, topicMessagesMap } = vi.hoisted(() => {
  const storeRef: { current: any } = { current: null }
  // Stable identity across renders: the hook's fetch effect depends on
  // `dispatch`, so a new function per render would refetch on every render.
  const dispatchFn = (action: any) => storeRef.current.dispatch(action)
  const proxy = {
    getState: () => storeRef.current.getState(),
    dispatch: dispatchFn,
    subscribe: (listener: any) => storeRef.current.subscribe(listener)
  }
  return {
    fetchClosureMock: vi.fn(),
    resolveClosureMock: vi.fn(),
    storeRef,
    proxy,
    dispatchFn,
    topicMessagesMap: new Map<string, unknown[]>()
  }
})

vi.mock('@renderer/hooks/useMessageOperations', () => ({
  useLoadedTopicMessages: (topicId: string) => topicMessagesMap.get(topicId) ?? []
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    fetchContextClosure: (...args: any[]) => fetchClosureMock(...args),
    resolveContextClosure: (...args: any[]) => resolveClosureMock(...args)
  }
}))

vi.mock('@renderer/services/topicDeletionInvalidation', () => ({
  captureDeletionGeneration: () => 0,
  isDeletionStale: () => false
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getAssistantSettings: (assistant: any) => ({
    contextCount: assistant?.settings?.contextCount ?? 5,
    contextWindowAnchor: assistant?.settings?.contextWindowAnchor ?? {}
  })
}))

vi.mock('@renderer/store', async () => {
  const actual: any = await vi.importActual('@renderer/store')
  return {
    ...actual,
    default: proxy,
    useAppDispatch: () => dispatchFn
  }
})

const { useContextClosure } = await import('../useContextClosure')
const { useContextWindowAnchor } = await import('../../pages/home/Inputbar/hooks/useContextWindowAnchor')

const TS = '2026-01-01T00:00:00.000Z'
const TOPIC = 't-cold-race'
const ANCHOR = 'u1'

function makeAssistant(anchorMap: Record<string, string | null>): any {
  const anchorObj = Object.fromEntries(
    Object.entries(anchorMap).map(([routeKey, groupKey]) => [routeKey, { kind: 'active', groupKey }])
  )
  return {
    id: 'asst-1',
    name: 'asst',
    topics: [{ id: TOPIC, assistantId: 'asst-1' }],
    settings: { contextCount: 5, contextWindowAnchor: anchorObj }
  }
}

function makeStore(anchorMap: Record<string, string | null>) {
  const store = configureStore({
    reducer: { assistants: assistantsReducer, messageBlocks: messageBlocksReducer },
    middleware: (getDefault) => getDefault().concat(closureInvalidationMiddleware as any)
  })
  store.dispatch(updateAssistants([makeAssistant(anchorMap)]) as any)
  return store
}

function makeResp(
  anchor: string,
  ids: string[],
  counts: { total: number; selected: number },
  blocks: Array<Record<string, unknown>> = []
): FetchContextClosureResponse {
  const messages = ids.map((id) => ({
    id,
    role: id.startsWith('u') ? 'user' : 'assistant',
    topicId: TOPIC,
    blocks: [`${id}-block`],
    ...(id.startsWith('a') ? { askId: ids[0] } : {})
  }))
  const boundaryMessageId = counts.selected === counts.total ? null : ids[0]
  return {
    messages: messages as any,
    blocks: blocks as any,
    closure: {
      completeness: 'context-closure' as const,
      topicId: TOPIC,
      anchorGroupKey: anchor,
      firstMessageId: ids[0] ?? null,
      lastMessageId: ids[ids.length - 1] ?? null,
      returnedCount: ids.length,
      totalTurnCount: counts.total,
      selectedTurnCount: counts.selected,
      foldedMessageIds: [],
      boundaryMessageId
    }
  } as any
}

/** A trusted scheduler mirror: the production content-only path. */
function trustedMirror(id: string, content: string) {
  return markClosureContentMirror(withClosureTopics(updateOneBlock({ id, changes: { content } as any }), TOPIC))
}

function seedLiveBlock(content: string, id = 'a1-block') {
  storeRef.current.dispatch(
    withClosureTopics(
      upsertOneBlock({
        id,
        messageId: 'a1',
        type: 'main_text',
        content,
        status: 'streaming',
        createdAt: TS,
        updatedAt: TS
      } as any),
      TOPIC
    ) as any
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('useContextClosure: content mirror advancing during an in-flight fetch', () => {
  beforeEach(() => {
    resetAllClosureStateForTests()
    resetExecutionOverlayForTests()
    vi.clearAllMocks()
    topicMessagesMap.clear()
    storeRef.current = makeStore({ [TOPIC]: ANCHOR })
    topicMessagesMap.set(TOPIC, [{ id: 'u1', role: 'user', topicId: TOPIC, blocks: [] }])
  })
  it('accepts authoritative structure, publishes no response blocks, keeps the live body, no extra fetch', async () => {
    seedLiveBlock('live-newest')
    const flight = deferred<FetchContextClosureResponse>()
    fetchClosureMock.mockImplementationOnce(() => flight.promise)
    const { result } = renderHook(({ t, a }) => useContextClosure(t, a), {
      initialProps: { t: TOPIC, a: ANCHOR }
    })
    await waitFor(() => expect(fetchClosureMock).toHaveBeenCalledTimes(1))
    const tokenBefore = getClosureSemanticToken(TOPIC, null)
    const genBefore = getClosureLoadGeneration(TOPIC, null)

    // Same-block streaming deltas land while the fetch is in flight: the
    // exempt mirror is a closure-freshness no-op — structural generation
    // does not move and no extra closure read is triggered.
    await act(async () => {
      storeRef.current.dispatch(trustedMirror('a1-block', 'live-newest-2') as any)
      storeRef.current.dispatch(trustedMirror('a1-block', 'live-newest-3') as any)
      await Promise.resolve()
    })
    expect(getClosureLoadGeneration(TOPIC, null)).toBe(genBefore)
    expect(getClosureSemanticToken(TOPIC, null)).toBe(tokenBefore)
    expect(fetchClosureMock).toHaveBeenCalledTimes(1)

    // Authoritative response: structure 2/2 with a body that predates the deltas.
    await act(async () => {
      flight.resolve(
        makeResp(ANCHOR, ['u1', 'a1'], { total: 2, selected: 2 }, [
          { id: 'a1-block', messageId: 'a1', type: 'main_text', content: 'stale-body' },
          { id: 'a2-block', messageId: 'a1', type: 'main_text', content: 'gap-filled' }
        ])
      )
      await flight.promise
      await new Promise((r) => setTimeout(r, 0))
    })

    await waitFor(() => expect(result.current.closure?.closure.totalTurnCount).toBe(2))
    // Accepted structure is authoritative, so the shared projection is not
    // authority-pending (the cold-race symptom was counts hidden).
    const info = resolveSharedContextInfo(
      [{ id: 'u1', role: 'user', topicId: TOPIC, blocks: [] }] as any,
      makeAssistant({ [TOPIC]: ANCHOR }),
      TOPIC,
      result.current.closure as any,
      null
    )
    expect(info.isAuthoritativePending).toBe(false)
    expect(info.contextCount).toEqual({ current: 2, max: 2 })

    // Stale body never overwrote the newer live delta, and nothing was
    // published into the ordinary store: the missing roster block stays
    // absent there (hydration exited). The accepted members' bodies come
    // from the closure snapshot composed with the execution-owned overlay.
    const entities = storeRef.current.getState().messageBlocks.entities
    expect(entities['a1-block']?.content).toBe('live-newest-3')
    expect(entities['a2-block']).toBeUndefined()

    // New mechanism: an execution registered for this route overlays the
    // live body onto the accepted members — the composed overlay shows the
    // current execution text while the ordinary store stays untouched.
    const routeKey = routeKeyForExecutionOverlay(TOPIC, null)
    const unsubscribe = subscribeExecutionOverlay(routeKey, () => {})
    try {
      const execHandle = registerExecutionOverlay({
        topicId: TOPIC,
        route: null,
        messageId: 'a1',
        snapshot: () => ({
          blocks: [{ id: 'a1-block', messageId: 'a1', type: 'main_text', content: 'live-newest-3' } as any]
        })
      })
      execHandle.notifyDelta()
      const overlay = getComposedOverlayBlocks(routeKey, ['a1-block', 'a2-block'])
      expect((overlay.get('a1-block') as { content?: unknown })?.content).toBe('live-newest-3')
      expect(overlay.has('a2-block')).toBe(false)
      execHandle.dispose()
    } finally {
      unsubscribe()
    }

    // Cache usable immediately for the same anchor; still exactly one fetch.
    expect(getFreshValidatedClosure(TOPIC, ANCHOR, undefined, null)).not.toBeNull()
    expect(fetchClosureMock).toHaveBeenCalledTimes(1)

    // Further deltas never trigger an extra closure read (mechanism, not timing).
    await act(async () => {
      storeRef.current.dispatch(trustedMirror('a1-block', 'live-newest-4') as any)
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(fetchClosureMock).toHaveBeenCalledTimes(1)
    expect(result.current.closure?.closure.totalTurnCount).toBe(2)
    expect(storeRef.current.getState().messageBlocks.entities['a1-block']?.content).toBe('live-newest-4')
  })

  it('never publishes response blocks into the ordinary store (unusable ids included)', async () => {
    seedLiveBlock('live')
    const flight = deferred<FetchContextClosureResponse>()
    fetchClosureMock.mockImplementationOnce(() => flight.promise)
    const { result } = renderHook(({ t, a }) => useContextClosure(t, a), {
      initialProps: { t: TOPIC, a: ANCHOR }
    })
    await waitFor(() => expect(fetchClosureMock).toHaveBeenCalledTimes(1))
    await act(async () => {
      storeRef.current.dispatch(trustedMirror('a1-block', 'live-2') as any)
      await Promise.resolve()
    })
    await act(async () => {
      flight.resolve(
        makeResp(ANCHOR, ['u1', 'a1'], { total: 1, selected: 1 }, [
          { id: 'a1-block', messageId: 'a1', content: 'stale' },
          // Passes the response validator (messageId resolves) but has no
          // usable block identity — still never published (hydration exited).
          { messageId: 'a1', content: 'no-identity' } as any
        ])
      )
      await flight.promise
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(() => expect(result.current.closure).not.toBeNull())
    const ids = Object.keys(storeRef.current.getState().messageBlocks.entities)
    expect(ids).toEqual(['a1-block'])
    expect(storeRef.current.getState().messageBlocks.entities['a1-block']?.content).toBe('live-2')
  })

  it('a structural change during the flight still rejects the stale response', async () => {
    const first = deferred<FetchContextClosureResponse>()
    const second = deferred<FetchContextClosureResponse>()
    fetchClosureMock.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    const { result } = renderHook(({ t, a }) => useContextClosure(t, a), {
      initialProps: { t: TOPIC, a: ANCHOR }
    })
    await waitFor(() => expect(fetchClosureMock).toHaveBeenCalledTimes(1))

    // Structural mutation (roster change): invalidates generation and triggers
    // a fresh read — the in-flight response must not be accepted.
    await act(async () => {
      bumpAndInvalidate(TOPIC)
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(() => expect(fetchClosureMock).toHaveBeenCalledTimes(2))

    await act(async () => {
      first.resolve(makeResp(ANCHOR, ['u1', 'a1'], { total: 2, selected: 2 }))
      await first.promise
      await new Promise((r) => setTimeout(r, 0))
    })
    // Stale structural response rejected: no accepted closure / no cache yet.
    expect(result.current.closure).toBeNull()
    expect(getFreshValidatedClosure(TOPIC, ANCHOR, undefined, null)).toBeNull()

    await act(async () => {
      second.resolve(makeResp(ANCHOR, ['u1', 'a1', 'u2', 'a2'], { total: 3, selected: 3 }))
      await second.promise
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(() => expect(result.current.closure?.closure.totalTurnCount).toBe(3))
    expect(getFreshValidatedClosure(TOPIC, ANCHOR, undefined, null)).not.toBeNull()
  })

  it('accepted projection retention is unchanged (old counts kept while a refetch is in flight)', async () => {
    fetchClosureMock.mockResolvedValueOnce(makeResp(ANCHOR, ['u1', 'a1'], { total: 3, selected: 3 }))
    const { result } = renderHook(({ t, a }) => useContextClosure(t, a), {
      initialProps: { t: TOPIC, a: ANCHOR }
    })
    await waitFor(() => expect(result.current.closure?.closure.totalTurnCount).toBe(3))
    const retained = result.current.closure

    const bg = deferred<FetchContextClosureResponse>()
    fetchClosureMock.mockImplementationOnce(() => bg.promise)
    await act(async () => {
      bumpAndInvalidate(TOPIC)
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(() => expect(fetchClosureMock).toHaveBeenCalledTimes(2))
    // Strict cache invalidated, UI acceptance retained.
    expect(getFreshValidatedClosure(TOPIC, ANCHOR, undefined, null)).toBeNull()
    expect(result.current.closure).toBe(retained)

    await act(async () => {
      bg.resolve(makeResp(ANCHOR, ['u1', 'a1'], { total: 3, selected: 3 }))
      await bg.promise
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(result.current.closure?.closure.totalTurnCount).toBe(3)
  })
})

describe('useContextWindowAnchor: content mirror advancing during a resolve', () => {
  beforeEach(() => {
    resetAllClosureStateForTests()
    resetExecutionOverlayForTests()
    vi.clearAllMocks()
    topicMessagesMap.clear()
    storeRef.current = makeStore({ [TOPIC]: ANCHOR })
    topicMessagesMap.set(TOPIC, [{ id: 'u1', role: 'user', topicId: TOPIC, blocks: [] }])
  })

  it('still persists the resolved anchor and keeps the live body without publishing response blocks', async () => {
    // Live streaming block belongs to message 'a2' (the roster row the new
    // anchor resolves to).
    seedLiveBlock('live', 'a2-block')
    const flight = deferred<any>()
    resolveClosureMock.mockImplementationOnce(() => flight.promise)
    const updateSettings = vi.fn()
    const assistant = makeAssistant({ [TOPIC]: ANCHOR })
    const { result } = renderHook(() => useContextWindowAnchor(assistant, TOPIC, undefined, updateSettings))

    let pending: Promise<void> = Promise.resolve()
    await act(async () => {
      pending = result.current.onReanchor()
      // Let the resolve reach the mocked DB boundary.
      await new Promise((r) => setTimeout(r, 0))
    })
    // A same-block streaming delta lands while the resolve is in flight.
    await act(async () => {
      storeRef.current.dispatch(trustedMirror('a2-block', 'live-2') as any)
    })

    flight.resolve({
      resolvedAnchorGroupKey: 'u2',
      messages: makeResp('u2', ['u2', 'a2'], { total: 2, selected: 2 }).messages,
      blocks: [
        { id: 'a2-block', messageId: 'a2', type: 'main_text', content: 'stale-body' },
        { id: 'a3-block', messageId: 'a2', type: 'main_text', content: 'gap-filled' }
      ],
      // Coherent with `messages` (u2 / a2): the validator requires the closure
      // first/last ids to equal the first/last roster row ids.
      closure: {
        completeness: 'context-closure',
        topicId: TOPIC,
        anchorGroupKey: 'u2',
        firstMessageId: 'u2',
        lastMessageId: 'a2',
        returnedCount: 2,
        totalTurnCount: 2,
        selectedTurnCount: 2,
        foldedMessageIds: [],
        boundaryMessageId: null
      }
    })
    await act(async () => {
      await pending
      await new Promise((r) => setTimeout(r, 0))
    })

    // Anchor is still persisted for the new group key (a content delta must not
    // abort an explicitly resolved re-anchor).
    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(updateSettings.mock.calls[0][0].contextWindowAnchor[TOPIC]).toEqual({ kind: 'active', groupKey: 'u2' })
    // Cache readable for the new anchor in the same boundary.
    expect(getFreshValidatedClosure(TOPIC, 'u2', undefined, null)).not.toBeNull()
    const entities = storeRef.current.getState().messageBlocks.entities
    expect(entities['a2-block']?.content).toBe('live-2')
    // Hydration exited: the response's missing roster block is not fabricated
    // into the ordinary store.
    expect(entities['a3-block']).toBeUndefined()
  })
})
