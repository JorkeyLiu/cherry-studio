import { configureStore } from '@reduxjs/toolkit'
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
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

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

// The drawer's layer contract is covered by its own suite; here only the
// listed route entries matter, so antd's popover is reduced to a passthrough.
vi.mock('antd', () => ({
  Popover: ({ content, children, zIndex }: Any) => (
    <div data-testid="drawer-popover" data-z-index={zIndex}>
      <div data-testid="drawer-trigger">{children}</div>
      <div data-testid="drawer-content">{content}</div>
    </div>
  )
}))

// This suite owns the shared-surface projection semantics, not the activation
// read. The provider's activation dispatch is stubbed here so the suite's
// structural-read assertions stay about the scoped hook; the real activation
// handoff is proven end-to-end (real thunk publication + real provider accept)
// in ChatRouteStructure.activationRead.test.tsx.
vi.mock('@renderer/store/thunk/messageThunk', () => ({
  loadTopicMessagesThunk: vi.fn(() => () => Promise.resolve())
}))
import { useRetainedRouteSegments } from '@renderer/hooks/useRetainedRouteSegments'
import {
  ROUTE_SEGMENTS_REFRESH_DEBOUNCE_MS,
  ROUTE_STRUCTURE_WINDOW_LIMIT
} from '@renderer/hooks/useRouteScopedSegments'
import { rootReducer } from '@renderer/store'

import { ChatRouteStructureProvider, useChatRouteStructure } from '../ChatRouteStructure'
import TopicSegmentDrawer from '../Messages/TopicSegmentDrawer'

type Any = any

const TOPIC = 'T'
const WAIT = { timeout: 5000 }

function seg(id: string, sortOrder: number, messageIds: string[]) {
  return {
    id,
    topicId: TOPIC,
    name: `g-${id}`,
    messageIds,
    color: '#fff',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sortOrder,
    firstMessageId: messageIds[0] ?? null,
    lastMessageId: messageIds[messageIds.length - 1] ?? null,
    messageCount: messageIds.length
  }
}

function group(id: string, members: string[]) {
  return { id, members }
}

function structure(topicId: string, branchId: string | null, groups: ReturnType<typeof group>[]) {
  const catalog = groups.map((g, index) => ({
    id: g.id,
    topicId,
    name: `g-${g.id}`,
    messageIds: g.members,
    headerMessageId: g.members[0] ?? null,
    ownerTopicId: topicId,
    ownerBranchId: null,
    createdAt: null,
    updatedAt: null,
    sortOrder: index,
    firstMessageId: g.members[0] ?? null,
    lastMessageId: g.members[g.members.length - 1] ?? null,
    messageCount: g.members.length
  }))
  const qualifications = groups.map((g) => ({
    segmentId: g.id,
    headerInRoute: g.members.length > 0,
    headerOwnedByRoute: true,
    routeMemberMessageIds: [...g.members]
  }))
  return {
    messages: [],
    blocks: [],
    window: {
      kind: 'latest',
      completeness: 'window',
      topicId,
      requested: { limit: ROUTE_STRUCTURE_WINDOW_LIMIT },
      firstMessageId: null,
      lastMessageId: null,
      returnedCount: 0,
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

function seedCatalog(store: Any, segments: Any[]) {
  store.dispatch({ type: 'topicSegments/replaceSegmentsForTopic', payload: { topicId: TOPIC, segments } })
}

function setBranch(store: Any, branchId: string | null) {
  store.dispatch({ type: 'topicBranch/activeBranchSet', payload: { topicId: TOPIC, branchId } })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const observed = {
  /** One entry per `Messages`-shaped consumer render (the retained projection). */
  messages: [] as Array<{ route: Any; segments: string[]; isDisplayCurrent: boolean }>,
  /** One entry per independent context read (shared-value identity probe). */
  probe: [] as Any[]
}

/**
 * Stand-in for `Messages`: consumes the surface value exactly as the flow
 * chrome does — the accepted projection feeds `useRetainedRouteSegments` with
 * the displayed route key — without mounting the 10k-line component.
 */
function MessagesLikeConsumer({ displayedKey }: { displayedKey: string }) {
  const route = useChatRouteStructure()
  const retained = useRetainedRouteSegments(
    TOPIC,
    route.routeKey,
    route.segments,
    route.isCurrent,
    displayedKey,
    route.committedChrome ?? null
  )
  observed.messages.push({
    route,
    segments: retained.segments.map((s) => s.id),
    isDisplayCurrent: retained.isDisplayCurrent
  })
  return <div data-testid="flow-chrome">{retained.segments.map((s) => s.id).join(',')}</div>
}

function RouteValueProbe() {
  const route = useChatRouteStructure()
  observed.probe.push(route)
  return <div data-testid="route-probe">{`${route.routeKey}:${route.isCurrent}`}</div>
}

function Surface({ store, displayedKey }: { store: Any; displayedKey: string }) {
  return createElement(
    Provider,
    { store } as Any,
    createElement(
      ChatRouteStructureProvider,
      { topicId: TOPIC } as Any,
      createElement(MessagesLikeConsumer, { displayedKey }),
      createElement(RouteValueProbe),
      createElement(TopicSegmentDrawer)
    )
  )
}

const lastMessageObservation = () => observed.messages[observed.messages.length - 1]
const lastProbe = () => observed.probe[observed.probe.length - 1]

describe('ChatRouteStructureProvider shared surface read', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    observed.messages.length = 0
    observed.probe.length = 0
    mockListSegments.mockResolvedValue([])
    mockWholeSnapshot.mockResolvedValue({ messages: [], blocks: [], snapshot: {} })
  })

  it('issues ONE structural read per route input and hands every consumer the same value', async () => {
    const store = makeStore()
    setBranch(store, null)
    seedCatalog(store, [seg('s-main', 0, ['m1'])])
    mockFetchWindow.mockResolvedValue(structure(TOPIC, null, [group('s-main', ['m1'])]))

    render(<Surface store={store} displayedKey={`${TOPIC}::main`} />)

    await waitFor(() => expect(screen.getByText('g-s-main')).toBeTruthy(), WAIT)

    // Both surface consumers read the projection through ONE scoped invocation:
    // a single minimal latest structure read, never one per consumer.
    expect(mockFetchWindow).toHaveBeenCalledTimes(1)
    expect(mockFetchWindow.mock.calls[0][0]).toMatchObject({
      kind: 'latest',
      topicId: TOPIC,
      branchId: null,
      limit: ROUTE_STRUCTURE_WINDOW_LIMIT,
      includeStructure: true
    })
    expect(mockWholeSnapshot).not.toHaveBeenCalled()
    expect(mockListSegments).not.toHaveBeenCalled()

    // The two consumers hold the same value object: no divergence between the
    // in-flow chrome and the drawer, and no second read behind either surface.
    expect(lastMessageObservation().route).toBe(lastProbe())
    expect(lastMessageObservation().route.segments.map((s: Any) => s.id)).toEqual(['s-main'])
    expect(lastMessageObservation().isDisplayCurrent).toBe(true)
    expect(screen.getByTestId('route-probe').textContent).toBe(`${TOPIC}::main:true`)
  })

  it('does not re-read for an identical catalog republication and keeps the value identity', async () => {
    const store = makeStore()
    setBranch(store, null)
    seedCatalog(store, [seg('s-main', 0, ['m1'])])
    mockFetchWindow.mockResolvedValue(structure(TOPIC, null, [group('s-main', ['m1'])]))

    const { rerender } = render(<Surface store={store} displayedKey={`${TOPIC}::main`} />)
    await waitFor(() => expect(screen.getByText('g-s-main')).toBeTruthy(), WAIT)
    await waitFor(() => expect(mockFetchWindow).toHaveBeenCalledTimes(1), WAIT)

    const acceptedValue = lastProbe()
    const rendersAtAccept = observed.probe.length
    // Same value-based catalog identity: the refresh trigger is value equality,
    // so a re-publication never becomes a read.
    act(() => seedCatalog(store, [seg('s-main', 0, ['m1'])]))
    // A surface re-render re-runs the provider, but the hook's memoized result
    // keeps its identity, so the context value never fans out a new projection.
    act(() => rerender(<Surface store={store} displayedKey={`${TOPIC}::main`} />))
    await new Promise((r) => setTimeout(r, ROUTE_SEGMENTS_REFRESH_DEBOUNCE_MS + 150))

    expect(mockFetchWindow).toHaveBeenCalledTimes(1)
    expect(observed.probe.slice(rendersAtAccept - 1).every((value) => value === acceptedValue)).toBe(true)
    expect(lastMessageObservation().route).toBe(lastProbe())
  })

  it('blanks the drawer while a route switch is pending, keeps the retained flow chrome, and discards a stale completion', async () => {
    const store = makeStore()
    setBranch(store, null)
    seedCatalog(store, [seg('s-main', 0, ['m1']), seg('s-child', 1, ['c1'])])

    const childDeferred = deferred<Any>()
    mockFetchWindow.mockImplementation(async (req: Any) => {
      if (req.branchId === 'C') return childDeferred.promise
      return structure(TOPIC, null, [group('s-main', ['m1'])])
    })

    const { rerender } = render(<Surface store={store} displayedKey={`${TOPIC}::main`} />)
    await waitFor(() => expect(screen.getByText('g-s-main')).toBeTruthy(), WAIT)
    expect(mockFetchWindow).toHaveBeenCalledTimes(1)

    // Route switch: the surface value flips to pending synchronously (`segments`
    // empty, `isCurrent` false). Navigation hides at once; the displayed window
    // still belongs to the old route, so its retained chrome keeps the old
    // structure read-only (never blanked, never the incoming route's).
    act(() => setBranch(store, 'C'))
    expect(screen.queryByText('g-s-main')).toBeNull()
    expect(screen.getByTestId('flow-chrome').textContent).toBe('s-main')
    expect(lastMessageObservation().isDisplayCurrent).toBe(false)
    expect(lastMessageObservation().route.isCurrent).toBe(false)
    expect(lastMessageObservation().route.segments).toEqual([])
    expect(mockFetchWindow).toHaveBeenCalledTimes(2)
    expect(mockFetchWindow.mock.calls[1][0]).toMatchObject({ branchId: 'C', limit: 1, includeStructure: true })

    // Abandon the pending route before its response lands: the re-addressed
    // route resolves normally, then the stale completion arrives and must be
    // discarded by the hook's generation/route guards (one read per route input,
    // no backfill, no re-render of the surface value).
    act(() => setBranch(store, null))
    await waitFor(() => expect(mockFetchWindow).toHaveBeenCalledTimes(3), WAIT)
    rerender(<Surface store={store} displayedKey={`${TOPIC}::main`} />)
    await waitFor(() => expect(screen.getByText('g-s-main')).toBeTruthy(), WAIT)

    act(() => childDeferred.resolve(structure(TOPIC, 'C', [group('s-child', ['c1'])])))
    await new Promise((r) => setTimeout(r, 50))

    expect(screen.queryByText('g-s-child')).toBeNull()
    expect(screen.getByText('g-s-main')).toBeTruthy()
    expect(mockFetchWindow).toHaveBeenCalledTimes(3)
    expect(lastMessageObservation().route.routeKey).toBe(`${TOPIC}::main`)
    expect(lastMessageObservation().route.isCurrent).toBe(true)
    expect(lastMessageObservation().isDisplayCurrent).toBe(true)
  })

  it('shares an accepted deferred structure: drawer follows selection, retained headers follow the displayed window', async () => {
    const store = makeStore()
    setBranch(store, null)
    seedCatalog(store, [seg('s-main', 0, ['m1']), seg('s-child', 1, ['c1'])])
    const childRead = deferred<Any>()
    mockFetchWindow.mockImplementation(async (req: Any) =>
      req.branchId === 'C' ? childRead.promise : structure(TOPIC, null, [group('s-main', ['m1'])])
    )

    const { rerender } = render(<Surface store={store} displayedKey={`${TOPIC}::main`} />)
    await waitFor(() => expect(screen.getByText('g-s-main')).toBeTruthy(), WAIT)

    act(() => setBranch(store, 'C'))
    expect(screen.queryByText('g-s-main')).toBeNull()
    expect(screen.getByTestId('flow-chrome').textContent).toBe('s-main')
    expect(lastMessageObservation().isDisplayCurrent).toBe(false)

    // Acceptance is the same owner's single write; the direct read issued by
    // the route effect is still pending and must not overwrite it.
    const accepted = structure(TOPIC, 'C', [group('s-child', ['c1'])])
    act(() => void lastProbe().acceptCommittedStructure(TOPIC, 'C', accepted.structure))
    expect(screen.getByText('g-s-child')).toBeTruthy()
    expect(screen.getByTestId('route-probe').textContent).toBe(`${TOPIC}::C:true`)
    // Displayed window still belongs to main: old headers remain, read-only.
    expect(screen.getByTestId('flow-chrome').textContent).toBe('s-main')
    expect(lastMessageObservation().isDisplayCurrent).toBe(false)

    // Window commits for the accepted route in the same visible batch.
    rerender(<Surface store={store} displayedKey={`${TOPIC}::C`} />)
    expect(screen.getByTestId('flow-chrome').textContent).toBe('s-child')
    expect(lastMessageObservation().isDisplayCurrent).toBe(true)

    act(() => childRead.resolve(structure(TOPIC, 'C', [group('s-stale', ['x'])])))
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.getByTestId('flow-chrome').textContent).toBe('s-child')
    expect(screen.queryByText('g-s-stale')).toBeNull()
  })

  it('supports the reverse skew: accepted main drawer with a displayed child window stays read-only', async () => {
    const store = makeStore()
    setBranch(store, null)
    seedCatalog(store, [seg('s-main', 0, ['m1']), seg('s-child', 1, ['c1'])])
    mockFetchWindow.mockImplementation(async (req: Any) =>
      req.branchId === 'C'
        ? structure(TOPIC, 'C', [group('s-child', ['c1'])])
        : structure(TOPIC, null, [group('s-main', ['m1'])])
    )

    const { rerender } = render(<Surface store={store} displayedKey={`${TOPIC}::main`} />)
    await waitFor(() => expect(screen.getByText('g-s-main')).toBeTruthy(), WAIT)

    // Selected C first: co-commit its deferred structure and advance the
    // displayed window to C, establishing child chrome in the shared owner.
    act(() => setBranch(store, 'C'))
    const child = structure(TOPIC, 'C', [group('s-child', ['c1'])])
    act(() => void lastProbe().acceptCommittedStructure(TOPIC, 'C', child.structure, undefined, 2))
    expect(screen.getByText('g-s-child')).toBeTruthy()
    rerender(<Surface store={store} displayedKey={`${TOPIC}::C`} />)
    expect(screen.getByTestId('flow-chrome').textContent).toBe('s-child')
    expect(lastMessageObservation().isDisplayCurrent).toBe(true)

    // Reverse direction: selection returns to main while the displayed window
    // still holds child rows. The drawer is selected-only; retained headers
    // keep the displayed route's projection and remain read-only.
    act(() => setBranch(store, null))
    const main = structure(TOPIC, null, [group('s-main', ['m1'])])
    act(() => void lastProbe().acceptCommittedStructure(TOPIC, null, main.structure, undefined, 3))
    expect(screen.getByText('g-s-main')).toBeTruthy()
    expect(screen.queryByText('g-s-child')).toBeNull()
    expect(screen.getByTestId('flow-chrome').textContent).toBe('s-child')
    expect(lastMessageObservation().isDisplayCurrent).toBe(false)
    expect(lastMessageObservation().segments).toEqual(['s-child'])

    rerender(<Surface store={store} displayedKey={`${TOPIC}::main`} />)
    expect(screen.getByTestId('flow-chrome').textContent).toBe('s-main')
    expect(lastMessageObservation().isDisplayCurrent).toBe(true)
  })

  it('co-commits a receipt-first window with selected drawer and displayed headers in one render', async () => {
    const store = makeStore()
    setBranch(store, null)
    seedCatalog(store, [seg('s-main', 0, ['m1']), seg('s-child', 1, ['c1'])])
    const childRead = deferred<Any>()
    mockFetchWindow.mockImplementation(async (req: Any) =>
      req.branchId === 'C' ? childRead.promise : structure(TOPIC, null, [group('s-main', ['m1'])])
    )

    const { rerender } = render(<Surface store={store} displayedKey={`${TOPIC}::main`} />)
    await waitFor(() => expect(screen.getByText('g-s-main')).toBeTruthy(), WAIT)
    act(() => setBranch(store, 'C'))

    const accepted = structure(TOPIC, 'C', [group('s-child', ['c1'])])
    act(() => {
      void lastProbe().acceptCommittedStructure(TOPIC, 'C', accepted.structure)
      rerender(<Surface store={store} displayedKey={`${TOPIC}::C`} />)
    })

    expect(screen.getByText('g-s-child')).toBeTruthy()
    expect(screen.getByTestId('flow-chrome').textContent).toBe('s-child')
    expect(lastMessageObservation().isDisplayCurrent).toBe(true)
    expect(lastMessageObservation().route).toBe(lastProbe())
    expect(mockFetchWindow).toHaveBeenCalledTimes(2)
  })

  it('fails fast when a consumer is mounted outside the surface provider', () => {
    expect(() => renderHook(() => useChatRouteStructure())).toThrow(/ChatRouteStructureProvider/)
  })
})
