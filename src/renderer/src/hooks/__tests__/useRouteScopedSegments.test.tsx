import { configureStore } from '@reduxjs/toolkit'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockLoadSnapshot } = vi.hoisted(() => ({ mockLoadSnapshot: vi.fn() }))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() }) }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    upsertSegment: vi.fn(),
    updateSegmentMetadata: vi.fn(),
    replaceSegmentMembership: vi.fn(),
    deleteSegment: vi.fn(),
    listSegments: vi.fn()
  }
}))

vi.mock('@renderer/utils/topicSegmentColor', () => ({
  getSegmentColor: (id: string) => `color-${id}`
}))

vi.mock('@renderer/utils/topicSnapshot', () => ({
  loadWholeTopicSnapshot: (...args: unknown[]) => mockLoadSnapshot(...args)
}))

import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { rootReducer } from '@renderer/store'
import { newMessagesActions } from '@renderer/store/newMessage'

import { useRouteScopedSegments } from '../useRouteScopedSegments'

type Any = any

const MAIN = Array.from({ length: 30 }, (_, i) => `m${i}`)
const ROUTE_P = [...MAIN.slice(0, 16), 'p1', 'p2']
const ROUTE_C = [...MAIN.slice(0, 16), 'p1', 'c1']

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

function snapshot(ids: string[]) {
  return { messages: ids.map((id) => ({ id })), blocks: [], blocksById: new Map(), snapshot: {} } as Any
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

describe('useRouteScopedSegments route scope and guards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('projects the topic-wide catalog onto the active route (child isolation)', async () => {
    const store = makeStore()
    setBranch(store, TOPIC, 'C')
    seedCatalog(store, TOPIC, [seg('s-prefix', 0, ['m5', 'm6']), seg('s-parent-only', 1, ['p2'])])
    mockLoadSnapshot.mockResolvedValue(snapshot(ROUTE_C))

    const { result } = renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })

    await waitFor(() => expect(result.current.segments.map((s) => s.id)).toEqual(['s-prefix']))
    expect(result.current.segments[0].messageCount).toBe(2)
    expect(result.current.segments[0].firstMessageId).toBe('m5')
    expect(mockLoadSnapshot).toHaveBeenCalledWith(TOPIC, 'C')
  })

  it('shows the parent-only segment on the parent route but hides it on the child route', async () => {
    const store = makeStore()
    seedCatalog(store, TOPIC, [seg('s-parent-only', 0, ['p2'])])
    mockLoadSnapshot.mockImplementation(async (_t: string, branch: string | null) =>
      snapshot(branch === 'C' ? ROUTE_C : ROUTE_P)
    )

    setBranch(store, TOPIC, 'P')
    const { result } = renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(result.current.segments.map((s) => s.id)).toEqual(['s-parent-only']))

    act(() => setBranch(store, TOPIC, 'C'))
    await waitFor(() => expect(result.current.segments).toEqual([]))
    expect(mockLoadSnapshot).toHaveBeenCalledWith(TOPIC, 'C')
  })

  it('hides the previous route list on the first frame of a branch switch, before the new snapshot resolves', async () => {
    const store = makeStore()
    seedCatalog(store, TOPIC, [seg('s-main', 0, ['m29'])])
    const cDeferred = deferred<Any>()
    mockLoadSnapshot.mockImplementation(async (_t: string, branch: string | null) => {
      if (branch === 'C') return cDeferred.promise
      return snapshot(MAIN)
    })

    setBranch(store, TOPIC, null)
    const { result } = renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(result.current.segments.map((s) => s.id)).toEqual(['s-main']))

    // Switch route: the very next render (still snapshot-pending) must be empty.
    act(() => setBranch(store, TOPIC, 'C'))
    expect(result.current.segments).toEqual([])

    cDeferred.resolve(snapshot(ROUTE_C) as Any)
    await waitFor(() => expect(result.current.segments).toEqual([]))
  })

  it('discards a stale async completion that resolves after a route switch (no backfill)', async () => {
    const store = makeStore()
    seedCatalog(store, TOPIC, [seg('s-main', 0, ['m29']), seg('s-child', 1, ['c1'])])
    const mainDeferred = deferred<Any>()
    let call = 0
    mockLoadSnapshot.mockImplementation(async () => {
      call += 1
      if (call === 1) return mainDeferred.promise
      return snapshot(ROUTE_C)
    })

    setBranch(store, TOPIC, null)
    const { result } = renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })

    act(() => setBranch(store, TOPIC, 'C'))
    await waitFor(() => expect(result.current.segments.map((s) => s.id)).toEqual(['s-child']))

    // Superseded main-route read resolves late and must be discarded.
    mainDeferred.resolve(snapshot(MAIN) as Any)
    await new Promise((r) => setTimeout(r, 30))
    expect(result.current.segments.map((s) => s.id)).toEqual(['s-child'])
  })

  it('keeps the projected count/metadata read-only (catalog never rewritten)', async () => {
    const store = makeStore()
    seedCatalog(store, TOPIC, [
      seg('s-cross', 0, ['m14', 'm15', 'p1', 'p2'], { firstMessageId: 'm14', lastMessageId: 'p2', messageCount: 4 }),
      seg('s-other', 1, ['p2'])
    ])
    mockLoadSnapshot.mockResolvedValue(snapshot(ROUTE_C))

    setBranch(store, TOPIC, 'C')
    const { result } = renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(result.current.segments.map((s) => s.id)).toEqual(['s-cross']))

    // Projection reflects the intersection only.
    expect(result.current.segments[0].messageCount).toBe(3)
    expect(result.current.segments[0].memberIds).toEqual(['m14', 'm15', 'p1'])

    // Persisted authority catalog (order/membership/counts/entities) is unchanged.
    const state = store.getState() as Any
    expect(state.topicSegments.segmentsByTopic[TOPIC]).toEqual(['s-cross', 's-other'])
    expect(state.topicSegments.segments.entities['s-cross'].messageCount).toBe(4)
    expect(state.topicSegments.segments.entities['s-cross'].messageIds).toEqual(['m14', 'm15', 'p1', 'p2'])
    expect(state.topicSegments.segments.entities['s-other'].messageCount).toBe(1)
    expect(state.topicSegments.segments.entities['s-other']).toBeTruthy()
  })

  it('resolves off-screen members from the whole-route read, not the loaded window', async () => {
    const store = makeStore()
    seedCatalog(store, TOPIC, [seg('s-offscreen', 0, ['m0'])])
    // Loaded window holds only the tail; the whole-route read holds the head.
    store.dispatch(newMessagesActions.messagesReceived({ topicId: TOPIC, messages: [{ id: 'm29' }] as Any }))
    mockLoadSnapshot.mockResolvedValue(snapshot(ROUTE_C))

    setBranch(store, TOPIC, 'C')
    const { result } = renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(result.current.segments.map((s) => s.id)).toEqual(['s-offscreen']))
    expect(result.current.segments[0].firstMessageId).toBe('m0')
  })

  it('refetches the same route when MESSAGE_COMPLETE reports for the topic', async () => {
    const store = makeStore()
    seedCatalog(store, TOPIC, [seg('s-prefix', 0, ['m5'])])
    mockLoadSnapshot.mockResolvedValue(snapshot(MAIN))

    setBranch(store, TOPIC, null)
    renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(mockLoadSnapshot).toHaveBeenCalledTimes(1))

    act(() => {
      void EventEmitter.emit(EVENT_NAMES.MESSAGE_COMPLETE, { topicId: TOPIC })
    })
    await waitFor(() => expect(mockLoadSnapshot).toHaveBeenCalledTimes(2), { timeout: 5000 })
  })

  it('refetches when the resident reference relation changes for the topic', async () => {
    const store = makeStore()
    seedCatalog(store, TOPIC, [seg('s-prefix', 0, ['m5'])])
    mockLoadSnapshot.mockResolvedValue(snapshot(MAIN))

    setBranch(store, TOPIC, null)
    renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(mockLoadSnapshot).toHaveBeenCalledTimes(1))

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
    await waitFor(() => expect(mockLoadSnapshot).toHaveBeenCalledTimes(2), { timeout: 5000 })

    // Status flips to missing (source invalidated) -> another refetch.
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
    await waitFor(() => expect(mockLoadSnapshot).toHaveBeenCalledTimes(3), { timeout: 5000 })
  })

  it('does not read the whole-route snapshot when the topic has no segments', async () => {
    const store = makeStore()
    setBranch(store, TOPIC, null)
    mockLoadSnapshot.mockResolvedValue(snapshot(MAIN))

    const { result } = renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await new Promise((r) => setTimeout(r, 30))
    expect(result.current.segments).toEqual([])
    expect(mockLoadSnapshot).not.toHaveBeenCalled()
  })

  it('does not swallow the first reference change when the catalog arrives after mount', async () => {
    const store = makeStore()
    setBranch(store, TOPIC, null)
    mockLoadSnapshot.mockResolvedValue(snapshot(MAIN))

    // No catalog yet: the route effect does not fetch, but it seeds the
    // same-route refresh baselines from the resident reference relation.
    renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await new Promise((r) => setTimeout(r, 30))
    expect(mockLoadSnapshot).not.toHaveBeenCalled()

    // Catalog arrives: the route effect re-runs (hasCatalog flip) and fetches,
    // re-seeding the baseline from the current reference token.
    act(() => seedCatalog(store, TOPIC, [seg('s-prefix', 0, ['m5'])]))
    await waitFor(() => expect(mockLoadSnapshot).toHaveBeenCalledTimes(1))

    // A genuine reference change must still refetch (not be swallowed).
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
    await waitFor(() => expect(mockLoadSnapshot).toHaveBeenCalledTimes(2), { timeout: 5000 })
  })
})
