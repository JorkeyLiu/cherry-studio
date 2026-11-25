import { configureStore } from '@reduxjs/toolkit'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFetchWindow, mockWholeSnapshot, mockListSegments } = vi.hoisted(() => ({
  mockFetchWindow: vi.fn(),
  mockWholeSnapshot: vi.fn(),
  mockListSegments: vi.fn()
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() }) }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    upsertSegment: vi.fn(),
    updateSegmentMetadata: vi.fn(),
    replaceSegmentMembership: vi.fn(),
    deleteSegment: vi.fn(),
    listSegments: (...args: unknown[]) => mockListSegments(...args),
    fetchMessagesWindow: (...args: unknown[]) => mockFetchWindow(...args),
    fetchWholeTopicSnapshot: (...args: unknown[]) => mockWholeSnapshot(...args)
  }
}))

vi.mock('@renderer/utils/topicSegmentColor', () => ({
  getSegmentColor: (id: string) => `color-${id}`
}))

import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { rootReducer } from '@renderer/store'
import { newMessagesActions } from '@renderer/store/newMessage'
import { projectCommittedChromeFromStructure } from '@renderer/utils/routeCommittedChrome'

import {
  ROUTE_SEGMENTS_REFRESH_DEBOUNCE_MS,
  ROUTE_STRUCTURE_WINDOW_LIMIT,
  segmentCatalogChromeToken,
  useRouteScopedSegments
} from '../useRouteScopedSegments'

type Any = any

function seg(id: string, sortOrder: number, messageIds: string[], extra: Any = {}) {
  return {
    id,
    topicId: 'T',
    name: id,
    messageIds,
    color: `color-${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sortOrder,
    firstMessageId: messageIds[0] ?? null,
    lastMessageId: messageIds[messageIds.length - 1] ?? null,
    messageCount: messageIds.length,
    ...extra
  }
}

function group(
  id: string,
  members: string[],
  opts: {
    header?: string | null
    owned?: boolean
    catalogMembers?: string[]
    sortOrder?: number
    turnCount?: number
  } = {}
) {
  return { id, members, ...opts }
}

function structure(
  topicId: string,
  branchId: string | null,
  groups: ReturnType<typeof group>[],
  opts: { windowIds?: string[] } = {}
) {
  const catalog = groups.map((g, index) => {
    const catalogMembers = g.catalogMembers ?? g.members
    return {
      id: g.id,
      topicId,
      name: `g-${g.id}`,
      messageIds: catalogMembers,
      headerMessageId: g.header !== undefined ? g.header : (catalogMembers[0] ?? null),
      ownerTopicId: topicId,
      ownerBranchId: null,
      createdAt: null,
      updatedAt: null,
      sortOrder: g.sortOrder ?? index,
      firstMessageId: catalogMembers[0] ?? null,
      lastMessageId: catalogMembers[catalogMembers.length - 1] ?? null,
      messageCount: catalogMembers.length
    }
  })
  const qualifications = groups.map((g) => ({
    segmentId: g.id,
    headerInRoute: g.members.length > 0,
    headerOwnedByRoute: g.owned ?? true,
    routeMemberMessageIds: [...g.members],
    ...(g.turnCount !== undefined ? { turnCount: g.turnCount } : {})
  }))
  return {
    messages: (opts.windowIds ?? []).map((id) => ({ id })),
    blocks: [],
    window: {
      kind: 'latest',
      completeness: 'window',
      topicId,
      requested: { limit: ROUTE_STRUCTURE_WINDOW_LIMIT },
      firstMessageId: null,
      lastMessageId: null,
      returnedCount: opts.windowIds?.length ?? 0,
      hasMoreBefore: true,
      hasMoreAfter: false
    },
    mutableMessageIds: [],
    reference: null,
    structure: { catalog, route: { topicId, branchId, qualifications } }
  } as Any
}

function makeStore() {
  return configureStore({ reducer: rootReducer as Any })
}

function seedCatalog(store: Any, topicId: string, segments: Any[]) {
  store.dispatch({ type: 'topicSegments/replaceSegmentsForTopic', payload: { topicId, segments } })
}

function setBranch(store: Any, topicId: string, branchId: string | null) {
  store.dispatch({ type: 'topicBranch/activeBranchSet', payload: { topicId, branchId } })
}

function seedTopic(store: Any) {
  const assistantId = store.getState().assistants.assistants[0].id
  store.dispatch({
    type: 'assistants/addTopic',
    payload: {
      assistantId,
      topic: {
        id: TOPIC,
        assistantId,
        name: TOPIC,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    }
  })
}

const wrapperFor =
  (store: Any) =>
  ({ children }: { children: React.ReactNode }) =>
    createElement(Provider, { store, children } as Any)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const TOPIC = 'T'
const WAIT = { timeout: 5000 }

describe('useRouteScopedSegments bundled-structure scope and guards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListSegments.mockResolvedValue([])
    mockWholeSnapshot.mockResolvedValue({ messages: [], blocks: [], snapshot: {} })
  })

  it('reads one minimal latest structure window and ignores the window rows', async () => {
    const store = makeStore()
    setBranch(store, TOPIC, null)
    seedCatalog(store, TOPIC, [seg('s-prefix', 0, ['m5', 'm6'])])
    // Window carries only unrelated tail rows; the projection must come from
    // the bundled structure alone (never the small window as whole-topic).
    mockFetchWindow.mockResolvedValue(structure(TOPIC, null, [group('s-prefix', ['m5', 'm6'])], { windowIds: ['x1'] }))

    const { result } = renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })

    await waitFor(() => expect(result.current.segments.map((s) => s.id)).toEqual(['s-prefix']), WAIT)
    expect(mockFetchWindow).toHaveBeenCalledTimes(1)
    const req = mockFetchWindow.mock.calls[0][0]
    expect(req).toMatchObject({
      kind: 'latest',
      topicId: TOPIC,
      limit: ROUTE_STRUCTURE_WINDOW_LIMIT,
      includeStructure: true
    })
    expect(result.current.segments[0].memberIds).toEqual(['m5', 'm6'])
    expect(result.current.segments[0].messageCount).toBe(2)
    // No whole-snapshot or extra qualification IPC.
    expect(mockWholeSnapshot).not.toHaveBeenCalled()
    expect(mockListSegments).not.toHaveBeenCalled()
  })

  it('keeps child isolation through the bundled qualification (branch echo)', async () => {
    const store = makeStore()
    seedCatalog(store, TOPIC, [seg('s-parent-only', 0, ['p2'])])
    mockFetchWindow.mockImplementation(async (req: Any) =>
      req.branchId === 'C'
        ? structure(TOPIC, 'C', [group('s-parent-only', [], { owned: false })])
        : structure(TOPIC, null, [group('s-parent-only', ['p2'])])
    )

    setBranch(store, TOPIC, null)
    const { result } = renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(result.current.segments.map((s) => s.id)).toEqual(['s-parent-only']), WAIT)
    expect(mockFetchWindow.mock.calls[0][0]).toMatchObject({ branchId: null })

    act(() => setBranch(store, TOPIC, 'C'))
    await waitFor(() => expect(result.current.segments).toEqual([]), WAIT)
    expect(mockFetchWindow.mock.calls[mockFetchWindow.mock.calls.length - 1][0]).toMatchObject({ branchId: 'C' })
  })

  it('takes mutation authority verbatim from the qualification (non-owner read-only)', async () => {
    const store = makeStore()
    setBranch(store, TOPIC, 'C')
    seedCatalog(store, TOPIC, [seg('s-cross', 0, ['m1'])])
    mockFetchWindow.mockResolvedValue(structure(TOPIC, 'C', [group('s-cross', ['m1'], { owned: false })]))

    const { result } = renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(result.current.segments.map((s) => s.id)).toEqual(['s-cross']), WAIT)
    expect(result.current.segments[0].headerOwnedByRoute).toBe(false)
  })

  it('matches the committed projection byte-identically for the same structure', async () => {
    const store = makeStore()
    setBranch(store, TOPIC, null)
    seedCatalog(store, TOPIC, [seg('s-a', 0, ['m1']), seg('s-b', 1, ['m2'])])
    const response = structure(TOPIC, null, [group('s-a', ['m1']), group('s-b', ['m2'])])
    mockFetchWindow.mockResolvedValue(response)

    const { result } = renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(result.current.segments.map((s) => s.id)).toEqual(['s-a', 's-b']), WAIT)
    const committed = projectCommittedChromeFromStructure({
      topicId: TOPIC,
      branchId: null,
      structure: response.structure
    })
    expect(result.current.segments).toEqual(committed?.segments)
  })

  it('carries the Main-computed turnCount verbatim, absent stays hidden', async () => {
    const store = makeStore()
    setBranch(store, TOPIC, null)
    seedCatalog(store, TOPIC, [seg('s-a', 0, ['m1', 'm2']), seg('s-b', 1, ['m3'])])
    mockFetchWindow.mockResolvedValue(
      structure(TOPIC, null, [group('s-a', ['m1', 'm2'], { turnCount: 2 }), group('s-b', ['m3'])])
    )

    const { result } = renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(result.current.segments.map((s) => s.id)).toEqual(['s-a', 's-b']), WAIT)
    expect(result.current.segments[0].turnCount).toBe(2)
    expect('turnCount' in result.current.segments[1]).toBe(false)
  })

  it('lists an off-screen head from the bundled qualification, not the loaded window', async () => {
    const store = makeStore()
    setBranch(store, TOPIC, null)
    seedCatalog(store, TOPIC, [seg('s-offscreen', 0, ['m0'])])
    store.dispatch(newMessagesActions.messagesReceived({ topicId: TOPIC, messages: [{ id: 'm29' }] as Any }))
    // Window holds only the tail; the bundled qualification still reaches the head.
    mockFetchWindow.mockResolvedValue(structure(TOPIC, null, [group('s-offscreen', ['m0'])], { windowIds: ['m29'] }))

    const { result } = renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(result.current.segments.map((s) => s.id)).toEqual(['s-offscreen']), WAIT)
    expect(result.current.segments[0].headerInRoute).toBe(true)
  })

  it('fail-closed on route-echo mismatch: keeps the last good projection', async () => {
    const store = makeStore()
    setBranch(store, TOPIC, null)
    seedCatalog(store, TOPIC, [seg('s-old', 0, ['m5'])])
    mockFetchWindow.mockResolvedValue(structure(TOPIC, null, [group('s-old', ['m5'])]))

    const { result } = renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(result.current.segments.map((s) => s.id)).toEqual(['s-old']), WAIT)

    // Stale/other-route structure under the requested address: ignored.
    const stale = structure(TOPIC, 'other-branch', [group('s-evil', ['x'])])
    mockFetchWindow.mockResolvedValueOnce(stale)
    act(() => {
      void EventEmitter.emit(EVENT_NAMES.MESSAGE_COMPLETE, { topicId: TOPIC })
    })
    await waitFor(() => expect(mockFetchWindow).toHaveBeenCalledTimes(2), WAIT)
    await new Promise((r) => setTimeout(r, 50))
    expect(result.current.segments.map((s) => s.id)).toEqual(['s-old'])
    expect(result.current.isCurrent).toBe(true)
  })

  it('fail-closed on missing structure: keeps the last good projection with no backfill', async () => {
    const store = makeStore()
    setBranch(store, TOPIC, null)
    seedCatalog(store, TOPIC, [seg('s-old', 0, ['m5'])])
    mockFetchWindow.mockResolvedValue(structure(TOPIC, null, [group('s-old', ['m5'])]))

    const { result } = renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(result.current.segments.map((s) => s.id)).toEqual(['s-old']), WAIT)

    mockFetchWindow.mockResolvedValueOnce({ messages: [], blocks: [], window: {}, mutableMessageIds: [] } as Any)
    act(() => {
      void EventEmitter.emit(EVENT_NAMES.MESSAGE_COMPLETE, { topicId: TOPIC })
    })
    await waitFor(() => expect(mockFetchWindow).toHaveBeenCalledTimes(2), WAIT)
    await new Promise((r) => setTimeout(r, 50))
    expect(result.current.segments.map((s) => s.id)).toEqual(['s-old'])
    expect(mockListSegments).not.toHaveBeenCalled()
    expect(mockWholeSnapshot).not.toHaveBeenCalled()
  })

  it('hides the previous route list on the first frame of a branch switch', async () => {
    const store = makeStore()
    seedCatalog(store, TOPIC, [seg('s-main', 0, ['m1'])])
    const cDeferred = deferred<Any>()
    mockFetchWindow.mockImplementation(async (req: Any) => {
      if (req.branchId === 'C') return cDeferred.promise
      return structure(TOPIC, null, [group('s-main', ['m1'])])
    })

    setBranch(store, TOPIC, null)
    const { result } = renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(result.current.segments.map((s) => s.id)).toEqual(['s-main']), WAIT)

    act(() => setBranch(store, TOPIC, 'C'))
    expect(result.current.segments).toEqual([])
    expect(result.current.isCurrent).toBe(false)

    cDeferred.resolve(structure(TOPIC, 'C', []))
    await waitFor(() => expect(result.current.isCurrent).toBe(true), WAIT)
    expect(result.current.segments).toEqual([])
  })

  it('discards a stale async completion that resolves after a route switch (no backfill)', async () => {
    const store = makeStore()
    seedCatalog(store, TOPIC, [seg('s-main', 0, ['m1']), seg('s-child', 1, ['c1'])])
    const mainDeferred = deferred<Any>()
    let call = 0
    mockFetchWindow.mockImplementation(async () => {
      call += 1
      if (call === 1) return mainDeferred.promise
      return structure(TOPIC, 'C', [group('s-child', ['c1'])])
    })

    setBranch(store, TOPIC, null)
    const { result } = renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })

    act(() => setBranch(store, TOPIC, 'C'))
    await waitFor(() => expect(result.current.segments.map((s) => s.id)).toEqual(['s-child']), WAIT)

    mainDeferred.resolve(structure(TOPIC, null, [group('s-main', ['m1'])]))
    await new Promise((r) => setTimeout(r, 30))
    expect(result.current.segments.map((s) => s.id)).toEqual(['s-child'])
  })

  it('refetches the same route when MESSAGE_COMPLETE reports for the topic', async () => {
    const store = makeStore()
    seedCatalog(store, TOPIC, [seg('s-prefix', 0, ['m5'])])
    mockFetchWindow.mockResolvedValue(structure(TOPIC, null, [group('s-prefix', ['m5'])]))

    setBranch(store, TOPIC, null)
    renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(mockFetchWindow).toHaveBeenCalledTimes(1), WAIT)

    act(() => {
      void EventEmitter.emit(EVENT_NAMES.MESSAGE_COMPLETE, { topicId: TOPIC })
    })
    await waitFor(() => expect(mockFetchWindow).toHaveBeenCalledTimes(2), WAIT)
  })

  it('refetches when the accepted catalog gains a group over newly committed rows', async () => {
    const store = makeStore()
    seedCatalog(store, TOPIC, [seg('s-old', 0, ['m5'])])
    mockFetchWindow.mockResolvedValue(structure(TOPIC, null, [group('s-old', ['m5'])]))

    setBranch(store, TOPIC, null)
    const { result } = renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(result.current.segments.map((s) => s.id)).toEqual(['s-old']), WAIT)

    mockFetchWindow.mockResolvedValue(structure(TOPIC, null, [group('s-old', ['m5']), group('s-new', ['n1', 'n2'])]))
    act(() => {
      seedCatalog(store, TOPIC, [seg('s-old', 0, ['m5']), seg('s-new', 1, ['n1', 'n2'])])
    })

    await waitFor(() => expect(result.current.segments.map((s) => s.id)).toEqual(['s-old', 's-new']), WAIT)
    expect(result.current.isCurrent).toBe(true)
    expect(mockFetchWindow).toHaveBeenCalledTimes(2)
    // The re-read feeds nothing back: the bundled read never writes the
    // catalog, so no further read is scheduled (no refetch loop).
    await new Promise((r) => setTimeout(r, ROUTE_SEGMENTS_REFRESH_DEBOUNCE_MS + 150))
    expect(mockFetchWindow).toHaveBeenCalledTimes(2)
  })

  it('does not refetch when the same accepted catalog is republished or another topic changes', async () => {
    const store = makeStore()
    seedCatalog(store, TOPIC, [seg('s-prefix', 0, ['m5'])])
    mockFetchWindow.mockResolvedValue(structure(TOPIC, null, [group('s-prefix', ['m5'])]))

    setBranch(store, TOPIC, null)
    renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(mockFetchWindow).toHaveBeenCalledTimes(1), WAIT)

    act(() => seedCatalog(store, TOPIC, [seg('s-prefix', 0, ['m5'])]))
    act(() => {
      store.dispatch({
        type: 'topicSegments/replaceSegmentsForTopic',
        payload: { topicId: 'OTHER', segments: [seg('s-other', 0, ['x1'], { topicId: 'OTHER' })] }
      })
    })
    await new Promise((r) => setTimeout(r, ROUTE_SEGMENTS_REFRESH_DEBOUNCE_MS + 150))
    expect(mockFetchWindow).toHaveBeenCalledTimes(1)
  })

  it('refetches when the resident reference relation changes for the topic', async () => {
    const store = makeStore()
    seedCatalog(store, TOPIC, [seg('s-prefix', 0, ['m5'])])
    mockFetchWindow.mockResolvedValue(structure(TOPIC, null, [group('s-prefix', ['m5'])]))

    setBranch(store, TOPIC, null)
    renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(mockFetchWindow).toHaveBeenCalledTimes(1), WAIT)

    act(() => {
      store.dispatch(
        newMessagesActions.historyReferenceSet({
          topicId: TOPIC,
          reference: {
            sourceTopicId: 'SRC',
            sourceBranchId: null,
            anchorMessageId: 'm9',
            sourceName: 'Source',
            status: 'available',
            boundaryMessageId: 'm9'
          }
        })
      )
    })
    await waitFor(() => expect(mockFetchWindow).toHaveBeenCalledTimes(2), WAIT)

    act(() => {
      store.dispatch(
        newMessagesActions.historyReferenceSet({
          topicId: TOPIC,
          reference: {
            sourceTopicId: 'SRC',
            sourceBranchId: null,
            anchorMessageId: 'm9',
            sourceName: null,
            status: 'missing',
            boundaryMessageId: null
          }
        })
      )
    })
    await waitFor(() => expect(mockFetchWindow).toHaveBeenCalledTimes(3), WAIT)
  })

  it('accepts a present-but-empty bundled structure as known-empty for the same route', async () => {
    const store = makeStore()
    setBranch(store, TOPIC, null)
    seedCatalog(store, TOPIC, [seg('s-old', 0, ['m5'])])
    mockFetchWindow.mockResolvedValue(structure(TOPIC, null, [group('s-old', ['m5'])]))

    const { result } = renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(result.current.segments.map((s) => s.id)).toEqual(['s-old']), WAIT)

    // Same-transaction zero reachable members: clears the same route instead
    // of lingering the previous entries.
    mockFetchWindow.mockResolvedValue(structure(TOPIC, null, [group('s-old', [])]))
    act(() => {
      void EventEmitter.emit(EVENT_NAMES.MESSAGE_COMPLETE, { topicId: TOPIC })
    })
    await waitFor(() => expect(mockFetchWindow).toHaveBeenCalledTimes(2), WAIT)
    await waitFor(() => expect(result.current.segments).toEqual([]), WAIT)
    expect(result.current.isCurrent).toBe(true)
  })

  it('does not read when the topic has no segments', async () => {
    const store = makeStore()
    setBranch(store, TOPIC, null)
    mockFetchWindow.mockResolvedValue(structure(TOPIC, null, [group('s-x', ['m1'])]))

    const { result } = renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await new Promise((r) => setTimeout(r, 30))
    expect(result.current.segments).toEqual([])
    expect(mockFetchWindow).not.toHaveBeenCalled()
  })
})

describe('useRouteScopedSegments committed-structure acceptance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchWindow.mockReset()
    mockListSegments.mockReset().mockResolvedValue([])
    mockWholeSnapshot.mockReset().mockResolvedValue({ messages: [], blocks: [], snapshot: {} })
  })

  const reference = {
    sourceTopicId: 'SRC',
    sourceBranchId: null,
    anchorMessageId: 'r1',
    sourceName: 'Source',
    status: 'available' as const,
    boundaryMessageId: 'r1'
  }

  /** Store catalog that has the SAME chrome token as the bundled wire catalog. */
  function catalogSeg(id: string, sortOrder: number, messageIds: string[]) {
    return {
      ...seg(id, sortOrder, messageIds),
      name: `g-${id}`,
      color: undefined,
      headerMessageId: messageIds[0] ?? null,
      ownerTopicId: TOPIC,
      ownerBranchId: null
    }
  }

  function seedReference(store: Any) {
    store.dispatch(newMessagesActions.historyReferenceSet({ topicId: TOPIC, reference }))
  }

  it('accepts a committed window immediately, cancels the publication debounce and rejects a late same-route read', async () => {
    const store = makeStore()
    setBranch(store, TOPIC, null)
    seedTopic(store)
    seedCatalog(store, TOPIC, [catalogSeg('s-old', 0, ['m5'])])
    const lateRead = deferred<Any>()
    mockFetchWindow.mockImplementationOnce(() => lateRead.promise)

    const { result } = renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(mockFetchWindow).toHaveBeenCalledTimes(1), WAIT)

    // Same common publication: catalog + reference already dispatched when the
    // onPublish acceptance reaches the owner.
    const nextStructure = structure(TOPIC, null, [group('s-new', ['n1'])])
    act(() => {
      seedCatalog(store, TOPIC, [catalogSeg('s-new', 0, ['n1'])])
      seedReference(store)
    })
    act(() => result.current.acceptCommittedStructure(TOPIC, null, nextStructure.structure, reference))

    expect(result.current.segments.map((s) => s.id)).toEqual(['s-new'])
    expect(result.current.isCurrent).toBe(true)
    expect(result.current.committedChrome?.routeKey).toBe(`${TOPIC}::main`)
    expect(result.current.committedChrome?.segments.map((s) => s.id)).toEqual(['s-new'])

    // The read that started before acceptance is stale even though it names the
    // same route; its generation was superseded at acceptance.
    act(() => lateRead.resolve(structure(TOPIC, null, [group('s-old', ['m5'])])))
    await new Promise((r) => setTimeout(r, ROUTE_SEGMENTS_REFRESH_DEBOUNCE_MS + 100))
    expect(mockFetchWindow).toHaveBeenCalledTimes(1)
    expect(result.current.segments.map((s) => s.id)).toEqual(['s-new'])

    // Real terminal refresh is NOT swallowed by the rebaseline.
    mockFetchWindow.mockResolvedValue(nextStructure)
    act(() => {
      void EventEmitter.emit(EVENT_NAMES.MESSAGE_COMPLETE, { topicId: TOPIC })
    })
    await waitFor(() => expect(mockFetchWindow).toHaveBeenCalledTimes(2), WAIT)

    // A genuine later catalog mutation is still merged, not mistaken for the
    // accepted publication's catalog.
    act(() => seedCatalog(store, TOPIC, [catalogSeg('s-catalog', 0, ['c1'])]))
    await waitFor(() => expect(mockFetchWindow).toHaveBeenCalledTimes(3), WAIT)
    await waitFor(() => expect(result.current.segments.map((s) => s.id)).toEqual(['s-new']), WAIT)

    // The topic's own updatedAt is likewise a real same-route signal, even
    // though the acceptance already rebaselined catalog and reference.
    act(() => store.dispatch({ type: 'assistants/updateTopicUpdatedAt', payload: { topicId: TOPIC } }))
    await waitFor(() => expect(mockFetchWindow).toHaveBeenCalledTimes(4), WAIT)
    await waitFor(() => expect(result.current.segments.map((s) => s.id)).toEqual(['s-new']), WAIT)
  })

  it('does not let the route effect read or erase an acceptance that lands with the catalog arrival', async () => {
    const store = makeStore()
    setBranch(store, TOPIC, null)
    // No catalog yet: the hook's initial read is intentionally not issued.
    mockFetchWindow.mockResolvedValue(structure(TOPIC, null, [group('s-x', ['x1'])]))
    const { result } = renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    expect(mockFetchWindow).not.toHaveBeenCalled()

    const nextStructure = structure(TOPIC, null, [group('s-arrived', ['a1'])])
    act(() => {
      seedCatalog(store, TOPIC, [catalogSeg('s-arrived', 0, ['a1'])])
      result.current.acceptCommittedStructure(TOPIC, null, nextStructure.structure)
    })

    expect(result.current.segments.map((s) => s.id)).toEqual(['s-arrived'])
    expect(result.current.isCurrent).toBe(true)
    await new Promise((r) => setTimeout(r, ROUTE_SEGMENTS_REFRESH_DEBOUNCE_MS + 100))
    expect(mockFetchWindow).not.toHaveBeenCalled()
  })

  it('keeps a real refresh when the current catalog token is already ahead of the receipt', async () => {
    const store = makeStore()
    setBranch(store, TOPIC, null)
    seedCatalog(store, TOPIC, [catalogSeg('s-old', 0, ['m5'])])
    mockFetchWindow.mockResolvedValue(structure(TOPIC, null, [group('s-old', ['m5'])]))
    const { result } = renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(mockFetchWindow).toHaveBeenCalledTimes(1), WAIT)

    const receipt = structure(TOPIC, null, [group('s-old', ['m5'])])
    mockFetchWindow.mockResolvedValue(structure(TOPIC, null, [group('s-new', ['n1'])]))
    act(() => {
      // A later mutation changed the store catalog; no receipt-bound token can
      // prove this receipt is current, so the refresh must survive.
      seedCatalog(store, TOPIC, [catalogSeg('s-old', 0, ['m5']), catalogSeg('s-new', 1, ['n1'])])
      result.current.acceptCommittedStructure(TOPIC, null, receipt.structure)
    })
    await waitFor(() => expect(mockFetchWindow).toHaveBeenCalledTimes(2), WAIT)
    await waitFor(() => expect(result.current.segments.map((s) => s.id)).toEqual(['s-new']), WAIT)
  })

  it('present-empty clears only the accepted route; missing and route-echo mismatch fail closed', async () => {
    const store = makeStore()
    setBranch(store, TOPIC, null)
    seedCatalog(store, TOPIC, [catalogSeg('s-old', 0, ['m5'])])
    mockFetchWindow.mockResolvedValue(structure(TOPIC, null, [group('s-old', ['m5'])]))
    const { result } = renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(result.current.segments.map((s) => s.id)).toEqual(['s-old']), WAIT)

    act(() =>
      result.current.acceptCommittedStructure(TOPIC, null, structure(TOPIC, null, [group('s-old', ['m5'])]).structure)
    )
    act(() => result.current.acceptCommittedStructure(TOPIC, null, null))
    act(() =>
      result.current.acceptCommittedStructure(TOPIC, null, structure(TOPIC, 'other', [group('s-x', ['x'])]).structure)
    )
    expect(result.current.segments.map((s) => s.id)).toEqual(['s-old'])
    expect(result.current.committedChrome?.segments.map((s) => s.id)).toEqual(['s-old'])

    act(() =>
      result.current.acceptCommittedStructure(TOPIC, null, structure(TOPIC, null, [group('s-old', [])]).structure)
    )
    expect(result.current.segments).toEqual([])
    expect(result.current.isCurrent).toBe(true)
    expect(result.current.committedChrome).toBeNull()
  })

  it('rejects an old acceptance after A-B-A and never backfills under the returned route', async () => {
    const store = makeStore()
    setBranch(store, TOPIC, null)
    seedCatalog(store, TOPIC, [catalogSeg('s-main', 0, ['m1']), catalogSeg('s-child', 1, ['c1'])])
    let call = 0
    mockFetchWindow.mockImplementation(async () => {
      call += 1
      if (call === 1) return structure(TOPIC, null, [group('s-main', ['m1'])])
      if (call === 2) return structure(TOPIC, 'C', [group('s-child', ['c1'])])
      return structure(TOPIC, null, [group('s-returned', ['r1'])])
    })
    const { result } = renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(result.current.segments.map((s) => s.id)).toEqual(['s-main']), WAIT)
    const staleMain = structure(TOPIC, null, [group('s-main', ['m1'])])

    act(() => setBranch(store, TOPIC, 'C'))
    expect(result.current.segments).toEqual([])
    act(() => result.current.acceptCommittedStructure(TOPIC, null, staleMain.structure))
    expect(result.current.segments).toEqual([])
    await waitFor(() => expect(result.current.segments.map((s) => s.id)).toEqual(['s-child']), WAIT)

    act(() => setBranch(store, TOPIC, null))
    expect(result.current.segments).toEqual([])
    await waitFor(() => expect(mockFetchWindow).toHaveBeenCalledTimes(3), WAIT)
    expect(result.current.routeKey).toBe(`${TOPIC}::main`)
    await waitFor(() => expect(result.current.segments.map((s) => s.id)).toEqual(['s-returned']), WAIT)

    // The old receipt carries the pre-excursion routeGeneration token. Under
    // the returned (identical) route value it still must not re-accept.
    act(() => result.current.acceptCommittedStructure(TOPIC, null, staleMain.structure, undefined, 1))
    expect(result.current.segments.map((s) => s.id)).toEqual(['s-returned'])
    expect(result.current.committedChrome).toBeNull()
  })
})

describe('segmentCatalogChromeToken', () => {
  it('ignores materialization timestamps and per-reader route qualification', () => {
    const base = seg('s1', 0, ['m1', 'm2'])
    expect(segmentCatalogChromeToken([{ ...base, createdAt: 'x', updatedAt: 'y' }])).toBe(
      segmentCatalogChromeToken([{ ...base, createdAt: 'a', updatedAt: 'b' }])
    )
  })

  it('changes on membership, order and head identity', () => {
    const base = seg('s1', 0, ['m1', 'm2'])
    const token = segmentCatalogChromeToken([base])
    expect(segmentCatalogChromeToken([seg('s1', 0, ['m1', 'm2', 'n1'])])).not.toBe(token)
    expect(segmentCatalogChromeToken([seg('s1', 1, ['m1', 'm2'])])).not.toBe(token)
    expect(segmentCatalogChromeToken([{ ...base, headerMessageId: 'm2' }])).not.toBe(token)
    expect(segmentCatalogChromeToken([base, seg('s2', 1, ['m3'])])).not.toBe(token)
  })
})
