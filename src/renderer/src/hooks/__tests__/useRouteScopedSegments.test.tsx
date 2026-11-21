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
    listSegments: vi.fn().mockResolvedValue([])
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

import {
  deriveRouteTurnMap,
  ROUTE_SEGMENTS_REFRESH_DEBOUNCE_MS,
  segmentCatalogChromeToken,
  useRouteScopedSegments
} from '../useRouteScopedSegments'

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

  it('orders the projected groups by first reachable route position, not catalog order', async () => {
    const store = makeStore()
    // Catalog creation order says s-created-first, but m20 sits after m2 on the route.
    seedCatalog(store, TOPIC, [seg('s-created-first', 0, ['m20']), seg('s-created-second', 1, ['m2'])])
    mockLoadSnapshot.mockResolvedValue(snapshot(MAIN))

    setBranch(store, TOPIC, null)
    const { result } = renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })

    await waitFor(() =>
      expect(result.current.segments.map((s) => s.id)).toEqual(['s-created-second', 's-created-first'])
    )
    // Only the list order changes; navigation targets stay the route-reachable firsts.
    expect(result.current.segments.map((s) => s.firstMessageId)).toEqual(['m2', 'm20'])
    // The authority catalog itself keeps its own order.
    const state = store.getState()
    expect(state.topicSegments.segmentsByTopic[TOPIC]).toEqual(['s-created-first', 's-created-second'])
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
    // The parent route reaches p2, so that is its navigation target.
    expect(result.current.segments[0].firstMessageId).toBe('p2')

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

    cDeferred.resolve(snapshot(ROUTE_C))
    await waitFor(() => expect(result.current.segments).toEqual([]))
  })

  it('exposes currency: false while the new route snapshot is pending, true once accepted', async () => {
    const store = makeStore()
    seedCatalog(store, TOPIC, [seg('s-main', 0, ['m29'])])
    const cDeferred = deferred<Any>()
    mockLoadSnapshot.mockImplementation(async (_t: string, branch: string | null) => {
      if (branch === 'C') return cDeferred.promise
      return snapshot(MAIN)
    })

    setBranch(store, TOPIC, null)
    const { result } = renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(result.current.isCurrent).toBe(true))
    expect(result.current.routeKey).toBe(`${TOPIC}::main`)

    // Switch route: projection is pending, so currency drops while the
    // drawer list stays intentionally empty (fail-closed navigation).
    act(() => setBranch(store, TOPIC, 'C'))
    expect(result.current.isCurrent).toBe(false)
    expect(result.current.segments).toEqual([])
    expect(result.current.routeKey).toBe(`${TOPIC}::C`)

    cDeferred.resolve(snapshot(ROUTE_C))
    await waitFor(() => expect(result.current.isCurrent).toBe(true))
    expect(result.current.routeKey).toBe(`${TOPIC}::C`)
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
    mainDeferred.resolve(snapshot(MAIN))
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
    const state = store.getState()
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

  it('refetches when the accepted catalog gains a group over newly committed route rows', async () => {
    const store = makeStore()
    seedCatalog(store, TOPIC, [seg('s-old', 0, ['m5'])])
    mockLoadSnapshot.mockResolvedValue(snapshot(MAIN))

    setBranch(store, TOPIC, null)
    const { result } = renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(result.current.segments.map((s) => s.id)).toEqual(['s-old']))

    // A committed collection mutation (tree paste) appends four rows AND a group
    // that only those rows describe. The group is new-only: intersecting it with
    // the hook's cached route ids (which predate the rows) drops it entirely —
    // the reported missing group/rail DOM — until the route is re-read.
    mockLoadSnapshot.mockResolvedValue(snapshot([...MAIN, 'n1', 'n2', 'n3', 'n4']))
    act(() => {
      seedCatalog(store, TOPIC, [seg('s-old', 0, ['m5']), seg('s-new', 1, ['n1', 'n2', 'n3', 'n4'])])
    })

    // No switch, no MESSAGE_COMPLETE, no updatedAt: only the accepted catalog
    // moved, and the projection follows it onto the re-read route.
    await waitFor(() => expect(result.current.segments.map((s) => s.id)).toEqual(['s-old', 's-new']), { timeout: 5000 })
    expect(result.current.isCurrent).toBe(true)
    expect(mockLoadSnapshot).toHaveBeenCalledTimes(2)
    expect(result.current.segments[1].firstMessageId).toBe('n1')
    expect(result.current.segments[1].messageCount).toBe(4)
    // The pre-existing group is untouched by the re-read.
    expect(result.current.segments[0].memberIds).toEqual(['m5'])
    // The re-read feeds nothing back: its own result never changes the catalog,
    // so no further read is scheduled (no refetch loop).
    await new Promise((r) => setTimeout(r, ROUTE_SEGMENTS_REFRESH_DEBOUNCE_MS + 150))
    expect(mockLoadSnapshot).toHaveBeenCalledTimes(2)
  })

  it('does not adopt a route snapshot read that began before the committed catalog change', async () => {
    const store = makeStore()
    seedCatalog(store, TOPIC, [seg('s-old', 0, ['m5'])])
    const first = deferred<Any>()
    let call = 0
    mockLoadSnapshot.mockImplementation(async () => {
      call += 1
      if (call === 1) return first.promise
      return snapshot([...MAIN, 'n1', 'n2', 'n3', 'n4'])
    })

    setBranch(store, TOPIC, null)
    const { result } = renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })

    // The commit publishes its catalog while the first read is still in flight.
    act(() => {
      seedCatalog(store, TOPIC, [seg('s-old', 0, ['m5']), seg('s-new', 1, ['n1', 'n2', 'n3', 'n4'])])
    })
    // That read resolves inside the coalescing window, before the re-read is
    // issued: its route ids predate the commit, so adopting it would intersect
    // the NEW catalog with OLD rows and hide the new group again.
    await act(async () => {
      first.resolve(snapshot(MAIN))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(result.current.isCurrent).toBe(false)
    expect(result.current.segments).toEqual([])

    await waitFor(() => expect(result.current.segments.map((s) => s.id)).toEqual(['s-old', 's-new']), { timeout: 5000 })
  })

  it("does not refetch when another topic's catalog changes", async () => {
    const store = makeStore()
    seedCatalog(store, TOPIC, [seg('s-prefix', 0, ['m5'])])
    mockLoadSnapshot.mockResolvedValue(snapshot(MAIN))

    setBranch(store, TOPIC, null)
    renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(mockLoadSnapshot).toHaveBeenCalledTimes(1))

    act(() => {
      store.dispatch({
        type: 'topicSegments/replaceSegmentsForTopic',
        payload: { topicId: 'OTHER', segments: [seg('s-other', 0, ['x1'], { topicId: 'OTHER' })] }
      })
    })
    await new Promise((r) => setTimeout(r, ROUTE_SEGMENTS_REFRESH_DEBOUNCE_MS + 150))
    expect(mockLoadSnapshot).toHaveBeenCalledTimes(1)
  })

  it('does not refetch when the same accepted catalog is republished', async () => {
    const store = makeStore()
    seedCatalog(store, TOPIC, [seg('s-prefix', 0, ['m5'])])
    mockLoadSnapshot.mockResolvedValue(snapshot(MAIN))

    setBranch(store, TOPIC, null)
    renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(mockLoadSnapshot).toHaveBeenCalledTimes(1))

    // An identical read-after convergence (fresh entities, same content) must
    // not schedule another read: the trigger is value equality, never identity.
    act(() => seedCatalog(store, TOPIC, [seg('s-prefix', 0, ['m5'])]))
    await new Promise((r) => setTimeout(r, ROUTE_SEGMENTS_REFRESH_DEBOUNCE_MS + 150))
    expect(mockLoadSnapshot).toHaveBeenCalledTimes(1)
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

  it('refetches when the materialized chain layers of the same relation change', async () => {
    const store = makeStore()
    seedCatalog(store, TOPIC, [seg('s-prefix', 0, ['m5'])])
    mockLoadSnapshot.mockResolvedValue(snapshot(MAIN))

    setBranch(store, TOPIC, null)
    renderHook(() => useRouteScopedSegments(TOPIC), { wrapper: wrapperFor(store) })
    await waitFor(() => expect(mockLoadSnapshot).toHaveBeenCalledTimes(1))

    const single = {
      sourceTopicId: 'SRC',
      sourceBranchId: null,
      anchorMessageId: 'm9',
      sourceName: 'Source',
      status: 'available' as const,
      boundaryMessageId: 'm9'
    }
    act(() => {
      store.dispatch(newMessagesActions.historyReferenceSet({ topicId: TOPIC, reference: single }))
    })
    await waitFor(() => expect(mockLoadSnapshot).toHaveBeenCalledTimes(2), { timeout: 5000 })

    // Re-dispatching the same relation (equivalent token) does not refetch.
    act(() => {
      store.dispatch(newMessagesActions.historyReferenceSet({ topicId: TOPIC, reference: { ...single } }))
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(mockLoadSnapshot).toHaveBeenCalledTimes(2)

    // A deeper layer entering the route is a same-route authority change.
    act(() => {
      store.dispatch(
        newMessagesActions.historyReferenceSet({
          topicId: TOPIC,
          reference: {
            ...single,
            layers: [
              { ...single, targetTopicId: TOPIC },
              {
                targetTopicId: 'SRC',
                sourceTopicId: 'SRC-ROOT',
                sourceBranchId: null,
                anchorMessageId: 'm-ancestor',
                sourceName: 'Root',
                status: 'available',
                boundaryMessageId: 'm-ancestor'
              }
            ]
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

describe('deriveRouteTurnMap', () => {
  const msg = (id: string, role: string, askId?: string) => ({ id, role, askId }) as Any

  it('maps user + same-askId answers to one turn index', () => {
    const map = deriveRouteTurnMap([
      msg('u1', 'user'),
      msg('a1', 'assistant', 'u1'),
      msg('a2', 'assistant', 'u1'),
      msg('u2', 'user'),
      msg('a3', 'assistant', 'u2')
    ])
    expect(map.get('u1')).toBe(0)
    expect(map.get('a1')).toBe(0)
    expect(map.get('a2')).toBe(0)
    expect(map.get('u2')).toBe(1)
    expect(map.get('a3')).toBe(1)
  })

  it('gives system messages and dangling askId answers their own turn', () => {
    const map = deriveRouteTurnMap([msg('s', 'system'), msg('dangling', 'assistant', 'missing-u')])
    expect(map.get('s')).toBe(0)
    expect(map.get('dangling')).toBe(1)
  })

  it('ignores assistant messages without askId', () => {
    const map = deriveRouteTurnMap([msg('orphan', 'assistant'), msg('u1', 'user')])
    expect(map.has('orphan')).toBe(false)
    expect(map.get('u1')).toBe(0)
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
