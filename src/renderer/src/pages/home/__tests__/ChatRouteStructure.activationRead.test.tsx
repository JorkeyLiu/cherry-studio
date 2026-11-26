/**
 * Topic-activation read ownership — real bootstrap publication + real provider.
 *
 * Cold topic activation issues ONE real bounded window read carrying
 * `includeStructure: true` (the resident bootstrap) instead of a second
 * structure-only probe once the catalog arrives. Both halves are REAL here:
 * - the bootstrap is the production `loadTopicMessagesThunk` (real `newMessage`
 *   / `topicBranch` / `residentRegistry` / `topicSegments` reducers through the
 *   root reducer, real joint publication, real StoreSync follow-up);
 * - the consumer is the production `ChatRouteStructureProvider` and the real
 *   `useRouteScopedSegments` acceptance path.
 * Only the Main-side data source (`dbService.fetchMessagesWindow`) and heavy
 * unrelated modules are mocked, so neither owner is mocked away.
 *
 * Proven here:
 * - cold main with a catalog: exactly one real window read, and the same
 *   response's catalog + route qualification becomes the surface's accepted
 *   structure (no follow-up `latest limit 1` probe);
 * - cold topic with no segments: one read, no probe, no permanent hold;
 * - saved-anchor around restore in flight: the bootstrap adopts that single
 *   around read, publishes its structure, and never issues a latest read;
 * - resident return: the cache hit delivers no structure (no false handoff),
 *   so the surface's own per-route probe still runs exactly once per mount;
 * - same-ID metadata/catalog republication: no second bootstrap dispatch;
 * - branch switch / A→B→A during the read: the old window and its structure are
 *   discarded (no projection, no acceptance);
 * - bootstrap failure: the gate is released, so a later catalog arrival still
 *   triggers exactly one probe that becomes current.
 * Implementation regression evidence for the activation-read contract: the
 * boundary is renderer-local (surface ownership), so this durable renderer
 * suite is the boundary-matched proof and no Electron/E2E asset is added.
 */
import { configureStore } from '@reduxjs/toolkit'
import type { FetchMessagesWindowRequest, FetchMessagesWindowResponse } from '@shared/chatDb'
import { act, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    fetchMessagesWindow: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))
vi.mock('@renderer/services/db/sendTimingDiagnostics', () => ({
  createSendDiagnosticsContext: vi.fn(() => ({ correlationId: 'c', ordinal: 1 })),
  elapsedMs: vi.fn(() => 0)
}))
vi.mock('@renderer/services/anchorService', () => ({
  ensureTopicAnchorEstablished: vi.fn(),
  anchorKeyForRoute: (t: string, b?: string | null) => (typeof b === 'string' && b.length > 0 ? `${t}:${b}` : t),
  buildGroupList: vi.fn(() => []),
  transferAnchorsAfterDeletion: vi.fn()
}))
vi.mock('@renderer/services/db', () => ({
  dbService: {
    fetchMessagesWindow: mocks.fetchMessagesWindow,
    fetchMessages: vi.fn(),
    resolveContextClosure: vi.fn(),
    createBranch: vi.fn(),
    listBranches: vi.fn(),
    appendMessage: vi.fn(),
    deleteMessagesWithSegments: vi.fn(),
    resetMessagesForResend: vi.fn(),
    updateMessageAndBlocks: vi.fn(),
    selectAnswerMessage: vi.fn(),
    updateMessage: vi.fn(),
    listSegments: vi.fn(async () => []),
    upsertSegment: vi.fn(),
    updateSegmentMetadata: vi.fn(),
    replaceSegmentMembership: vi.fn(),
    deleteSegment: vi.fn()
  }
}))
vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({ consumeFileCleanupResult: vi.fn() }))
vi.mock('@renderer/store/thunk/topicSegmentThunk', () => ({
  loadTopicSegmentsThunk: vi.fn(() => () => Promise.resolve())
}))
vi.mock('@renderer/aiCore/chunk/AiSdkToChunkAdapter', () => ({ AiSdkToChunkAdapter: class {} }))
vi.mock('@renderer/utils/queue', () => ({ getTopicQueue: () => ({ add: vi.fn() }), waitForTopicQueue: vi.fn() }))
// Immediate passthrough so the single window read settles in test order (the
// FIFO serializer is not what this suite proves).
vi.mock('@renderer/utils/windowReadQueue', () => ({
  runTopicWindowRead: (_t: string, _k: string, read: () => unknown) => read()
}))
vi.mock('@renderer/hooks/useModel', () => ({ getModel: vi.fn() }))
vi.mock('@renderer/services/ApiService', () => ({ transformMessagesAndFetch: vi.fn() }))
vi.mock('@renderer/services/messageStreaming/BlockManager', () => ({ BlockManager: class {} }))
vi.mock('@renderer/services/messageStreaming/callbacks', () => ({ createCallbacks: vi.fn(() => ({})) }))
vi.mock('@renderer/services/StreamProcessingService', () => ({ createStreamProcessor: vi.fn(() => vi.fn()) }))
vi.mock('@renderer/services/SpanManagerService', () => ({ endSpan: vi.fn() }))
vi.mock('@renderer/utils/abortController', () => ({ addAbortController: vi.fn() }))
vi.mock('@renderer/utils/messageUtils/create', () => ({
  createAssistantMessage: vi.fn(),
  createTranslationBlock: vi.fn(),
  resetAssistantMessage: vi.fn((m: unknown) => m)
}))
vi.mock('swr', () => ({ mutate: vi.fn() }))
vi.mock('i18next', () => ({
  default: { use: vi.fn().mockReturnThis(), init: vi.fn(), t: (k: string) => k } as Any,
  t: (k: string) => k
}))
vi.mock('i18n', () => ({
  default: { use: vi.fn().mockReturnThis(), init: vi.fn(), t: (k: string) => k } as Any,
  t: (k: string) => k
}))

import {
  ROUTE_SEGMENTS_REFRESH_DEBOUNCE_MS,
  ROUTE_STRUCTURE_WINDOW_LIMIT
} from '@renderer/hooks/useRouteScopedSegments'
import { rootReducer } from '@renderer/store'
import {
  bumpGeneration,
  publishResidentComplete,
  selectGeneration,
  selectResidentEntry
} from '@renderer/store/residentRegistry'
import { dispatchDeferredRouteWindowRead } from '@renderer/store/thunk/messageThunk'

import { ChatRouteStructureProvider, useChatRouteStructure } from '../ChatRouteStructure'

type Any = any

const TOPIC = 'T'
const WAIT = { timeout: 5000 }

let observed: { probe: string[]; current: string }

function RouteProbe() {
  const route = useChatRouteStructure()
  const ids = route.segments.map((segment) => segment.id).join('|')
  observed.current = `${route.routeKey}:${route.isCurrent}:${ids}`
  observed.probe.push(observed.current)
  return <div data-testid="route-probe">{observed.current}</div>
}

function Surface({ store }: { store: Any }) {
  return createElement(
    Provider,
    { store } as Any,
    createElement(ChatRouteStructureProvider, { topicId: TOPIC } as Any, createElement(RouteProbe))
  )
}

function makeStore(preloaded?: Any) {
  return configureStore({ reducer: rootReducer as Any, ...(preloaded ? { preloadedState: preloaded } : {}) })
}

interface GroupSpec {
  id: string
  members: string[]
}

/** Bundled catalog entry (neutral authority segment). */
function catalogEntry(group: GroupSpec, index: number, ownerBranchId: string | null = null): Any {
  return {
    id: group.id,
    topicId: TOPIC,
    name: `g-${group.id}`,
    color: null,
    messageIds: [...group.members],
    headerMessageId: group.members[0] ?? null,
    ownerTopicId: TOPIC,
    ownerBranchId,
    sortOrder: index,
    createdAt: null,
    updatedAt: null,
    firstMessageId: group.members[0] ?? null,
    lastMessageId: group.members[group.members.length - 1] ?? null,
    messageCount: group.members.length
  }
}

function catalog(groups: GroupSpec[], ownerBranchId: string | null = null): Any[] {
  return groups.map((group, index) => catalogEntry(group, index, ownerBranchId))
}

/** Same-transaction structure block echoing the addressed route. */
function structureFor(request: FetchMessagesWindowRequest, groups: GroupSpec[]): Any {
  const branchId = (request as { branchId?: string | null }).branchId ?? null
  return {
    catalog: catalog(groups, branchId),
    route: {
      topicId: request.topicId,
      branchId,
      qualifications: groups.map((group) => ({
        segmentId: group.id,
        headerInRoute: group.members.length > 0,
        headerOwnedByRoute: true,
        routeMemberMessageIds: [...group.members]
      }))
    }
  }
}

/** Main window response echoing the request bounds (strictly validated). */
function windowResponse(
  request: FetchMessagesWindowRequest,
  messageIds: string[],
  groups: GroupSpec[]
): FetchMessagesWindowResponse {
  const messages = messageIds.map((id) => ({ id, topicId: TOPIC, role: 'user', blocks: [] }))
  const kind = request.kind
  const windowMeta: Any = {
    kind,
    completeness: 'window',
    topicId: request.topicId,
    anchorMessageId: kind === 'around' ? (request as Any).anchorMessageId : null,
    requested:
      kind === 'latest'
        ? { limit: (request as Any).limit }
        : { before: (request as Any).before, after: (request as Any).after },
    firstMessageId: messageIds.length > 0 ? messageIds[0] : null,
    lastMessageId: messageIds.length > 0 ? messageIds[messageIds.length - 1] : null,
    returnedCount: messageIds.length,
    hasMoreBefore: false,
    hasMoreAfter: false
  }
  return {
    messages,
    blocks: [],
    window: windowMeta,
    mutableMessageIds: [],
    reference: null,
    structure: structureFor(request, groups)
  } as unknown as FetchMessagesWindowResponse
}
/**
 * No bootstrap window was published for the topic.
 *
 * The activation read's own `setCurrentTopicId` marks the topic current with
 * an empty index (existing production behavior), so "nothing published" is
 * proven by an empty index with no message entities, no installed catalog,
 * and no resident claim.
 */
function expectNoBootstrapPublication(store: Any): void {
  const state = store.getState()
  expect(state.messages.messageIdsByTopic[TOPIC]).toEqual([])
  expect(state.messages.entities).toEqual({})
  expect(state.topicSegments.segmentsByTopic[TOPIC]).toBeUndefined()
  expect(selectResidentEntry(state, TOPIC)?.residentTopic).toBe(false)
}

function requests(): FetchMessagesWindowRequest[] {
  return mocks.fetchMessagesWindow.mock.calls.map((call) => call[0] as FetchMessagesWindowRequest)
}

function readCount(): number {
  return mocks.fetchMessagesWindow.mock.calls.length
}

/** Latest request shape used for seeding a resident hit. */
const latestRequest: FetchMessagesWindowRequest = {
  kind: 'latest',
  topicId: TOPIC,
  branchId: null,
  limit: 10,
  includeStructure: true
} as FetchMessagesWindowRequest

/**
 * Seed an already-resident topic exactly as production publishes it: one
 * applicability generation + one joint window/catalog publication (real
 * registry, `newMessage` and `topicSegments` reducers).
 */
function seedResident(store: Any, groups: GroupSpec[]): void {
  store.dispatch(bumpGeneration(TOPIC))
  const generation = selectGeneration(store.getState(), TOPIC)
  store.dispatch(
    publishResidentComplete({
      topicId: TOPIC,
      generation,
      windowResponse: windowResponse(latestRequest, ['u1'], groups),
      segments: catalog(groups),
      route: null
    } as Any)
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  observed = { probe: [], current: '' }
})

describe('topic activation read ownership (cold main with catalog)', () => {
  it('issues ONE real window read and consumes its route structure in place', async () => {
    const store = makeStore()
    const groups: GroupSpec[] = [{ id: 's-main', members: ['u1', 'a1'] }]
    mocks.fetchMessagesWindow.mockImplementation(async (request: FetchMessagesWindowRequest) =>
      windowResponse(request, ['u1', 'a1'], groups)
    )

    render(<Surface store={store} />)

    await waitFor(() => expect(screen.getByTestId('route-probe').textContent).toBe('T::main:true:s-main'), WAIT)

    // Cold activation = ONE real window read. The structure-only `latest limit 1`
    // probe never runs: the bootstrap response's catalog + route qualification
    // is accepted by the surface in the same publication.
    expect(readCount()).toBe(1)
    const request = requests()[0]
    expect(request).toMatchObject({
      kind: 'latest',
      topicId: TOPIC,
      branchId: null,
      includeStructure: true
    })
    // A real bounded window (displayCount), not the structural probe size.
    expect((request as Any).limit).not.toBe(ROUTE_STRUCTURE_WINDOW_LIMIT)
    expect((request as Any).limit).toBe(10)

    // Joint publication installed the window index and the mapped catalog...
    expect(store.getState().messages.messageIdsByTopic[TOPIC]).toEqual(['u1', 'a1'])
    expect(store.getState().topicSegments.segmentsByTopic[TOPIC]).toEqual(['s-main'])
    // ...and the same accepted structure is current for the addressed route.
    expect(screen.getByTestId('route-probe').textContent).toBe('T::main:true:s-main')
  })

  it('cold topic with no segments reads once and never fabricates a probe', async () => {
    const store = makeStore()
    mocks.fetchMessagesWindow.mockImplementation(async (request: FetchMessagesWindowRequest) =>
      windowResponse(request, [], [])
    )

    render(<Surface store={store} />)

    await waitFor(() => expect(store.getState().messages.messageIdsByTopic[TOPIC]).toEqual([]), WAIT)
    expect(readCount()).toBe(1)
    expect(requests()[0]).toMatchObject({ kind: 'latest', includeStructure: true })
    // Known-empty catalog: no-catalog no-probe semantics preserved, and the
    // surface is not "current" for a route it never accepted.
    expect(screen.getByTestId('route-probe').textContent).toBe('T::main:false:')

    await act(() => new Promise((resolve) => setTimeout(resolve, ROUTE_SEGMENTS_REFRESH_DEBOUNCE_MS + 150)))
    expect(readCount()).toBe(1)
    expect(screen.getByTestId('route-probe').textContent).toBe('T::main:false:')
  })
})

describe('topic activation read ownership (saved-anchor around adoption)', () => {
  it('adopts the single in-flight around restore and never issues a latest read', async () => {
    const store = makeStore()
    const groups: GroupSpec[] = [{ id: 's-main', members: ['m1'] }]
    const aroundRead = deferred<FetchMessagesWindowResponse>()
    mocks.fetchMessagesWindow.mockImplementation((request: FetchMessagesWindowRequest) => {
      if (request.kind !== 'around') throw new Error('a latest read must never compete with the adopted around restore')
      return aroundRead.promise
    })

    // Saved-anchor restore registered synchronously before the activation read
    // (exactly what the mounted conversation does for a saved anchor).
    const receiptPromise = dispatchDeferredRouteWindowRead(store.dispatch as Any, () => store.getState(), TOPIC, null, {
      kind: 'around',
      anchorMessageId: 'm1',
      before: 10,
      after: 19
    })

    render(<Surface store={store} />)

    await waitFor(() => expect(readCount()).toBe(1), WAIT)
    expect(requests()[0]).toMatchObject({
      kind: 'around',
      topicId: TOPIC,
      branchId: null,
      anchorMessageId: 'm1',
      before: 10,
      after: 19,
      includeStructure: true
    })

    aroundRead.resolve(
      windowResponse(
        { kind: 'around', topicId: TOPIC, branchId: null, anchorMessageId: 'm1', before: 10, after: 19 } as Any,
        ['m1'],
        groups
      )
    )

    const receipt = await receiptPromise
    expect(receipt).toBeDefined()
    expect((receipt as Any).route).toBe(null)
    await waitFor(() => expect(screen.getByTestId('route-probe').textContent).toBe('T::main:true:s-main'), WAIT)

    // Single-flight around only: one read total, and never a latest window.
    expect(readCount()).toBe(1)
    expect(requests().every((request) => request.kind === 'around')).toBe(true)
    expect(store.getState().messages.messageIdsByTopic[TOPIC]).toEqual(['m1'])
  })
})

describe('topic activation read ownership (resident return)', () => {
  it('a cache hit delivers no structure, so the surface probe still runs exactly once per mount', async () => {
    const store = makeStore()
    const groups: GroupSpec[] = [{ id: 's-main', members: ['u1'] }]
    seedResident(store, groups)
    mocks.fetchMessagesWindow.mockImplementation(async (request: FetchMessagesWindowRequest) =>
      windowResponse(request, ['u1'], groups)
    )

    const first = render(<Surface store={store} />)
    await waitFor(() => expect(screen.getByTestId('route-probe').textContent).toBe('T::main:true:s-main'), WAIT)
    expect(readCount()).toBe(1)
    expect(requests()[0]).toMatchObject({
      kind: 'latest',
      topicId: TOPIC,
      branchId: null,
      limit: ROUTE_STRUCTURE_WINDOW_LIMIT,
      includeStructure: true
    })

    // Returning to the topic is a fetchless residency hit: no bootstrap
    // structure is delivered, so the independent structural probe is required
    // and runs once per mount again.
    first.unmount()
    render(<Surface store={store} />)
    await waitFor(() => expect(readCount()).toBe(2), WAIT)
    await waitFor(() => expect(screen.getByTestId('route-probe').textContent).toBe('T::main:true:s-main'), WAIT)
    expect(requests()[1]).toMatchObject({ kind: 'latest', limit: ROUTE_STRUCTURE_WINDOW_LIMIT })
  })
})

describe('topic activation read ownership (republication and route currency)', () => {
  it('does not re-dispatch the activation read for a same-ID metadata or identical catalog update', async () => {
    const store = makeStore({ assistants: { assistants: [{ id: 'asst', topics: [{ id: TOPIC, updatedAt: 't0' }] }] } })
    const groups: GroupSpec[] = [{ id: 's-main', members: ['u1'] }]
    mocks.fetchMessagesWindow.mockImplementation(async (request: FetchMessagesWindowRequest) =>
      windowResponse(request, ['u1'], groups)
    )
    // Count activation thunk dispatches only (thunk-shaped dispatches).
    const dispatchSpy = vi.spyOn(store, 'dispatch')
    const activationDispatches = () => dispatchSpy.mock.calls.filter((call) => typeof call[0] === 'function').length

    render(<Surface store={store} />)
    await waitFor(() => expect(screen.getByTestId('route-probe').textContent).toBe('T::main:true:s-main'), WAIT)
    expect(readCount()).toBe(1)
    expect(activationDispatches()).toBe(1)

    // Same-ID metadata update: the existing same-route authority refresh owns
    // its debounced re-read; the activation read is never re-dispatched.
    act(() => {
      store.dispatch({ type: 'assistants/updateTopicUpdatedAt', payload: { topicId: TOPIC } })
    })
    await waitFor(() => expect(readCount()).toBe(2), WAIT)
    expect(requests()[1]).toMatchObject({ kind: 'latest', limit: ROUTE_STRUCTURE_WINDOW_LIMIT })
    expect(activationDispatches()).toBe(1)

    // Identical catalog republication is value-equal: no read at all.
    act(() => {
      store.dispatch({
        type: 'topicSegments/replaceSegmentsForTopic',
        payload: { topicId: TOPIC, segments: catalog(groups) }
      })
    })
    await act(() => new Promise((resolve) => setTimeout(resolve, ROUTE_SEGMENTS_REFRESH_DEBOUNCE_MS + 150)))
    expect(readCount()).toBe(2)
    expect(activationDispatches()).toBe(1)
    expect(screen.getByTestId('route-probe').textContent).toBe('T::main:true:s-main')
  })

  it('discards the old route window and its structure when the branch switches mid-read', async () => {
    const store = makeStore()
    const groups: GroupSpec[] = [{ id: 's-main', members: ['u1', 'a1'] }]
    const bootstrapRead = deferred<FetchMessagesWindowResponse>()
    mocks.fetchMessagesWindow.mockImplementation((request: FetchMessagesWindowRequest) => {
      if ((request as Any).branchId === null) return bootstrapRead.promise
      return Promise.resolve(windowResponse(request, ['c1'], [{ id: 's-child', members: ['c1'] }]))
    })

    render(<Surface store={store} />)
    await waitFor(() => expect(readCount()).toBe(1), WAIT)

    act(() => {
      store.dispatch({ type: 'topicBranch/activeBranchSet', payload: { topicId: TOPIC, branchId: 'C' } })
    })
    bootstrapRead.resolve(windowResponse(requests()[0], ['u1', 'a1'], groups))
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))

    // No publish of the old-route window, no catalog install, no accepted
    // structure under the new route.
    expectNoBootstrapPublication(store)
    expect(readCount()).toBe(1)
    expect(screen.getByTestId('route-probe').textContent).toBe('T::C:false:')
  })

  it('discards a read that returns after an A→B→A excursion (route value equal, generation moved)', async () => {
    const store = makeStore()
    const groups: GroupSpec[] = [{ id: 's-main', members: ['u1', 'a1'] }]
    const bootstrapRead = deferred<FetchMessagesWindowResponse>()
    mocks.fetchMessagesWindow.mockImplementation((request: FetchMessagesWindowRequest) => {
      if ((request as Any).branchId === null) return bootstrapRead.promise
      return Promise.resolve(windowResponse(request, ['c1'], [{ id: 's-child', members: ['c1'] }]))
    })

    render(<Surface store={store} />)
    await waitFor(() => expect(readCount()).toBe(1), WAIT)

    act(() => {
      store.dispatch({ type: 'topicBranch/activeBranchSet', payload: { topicId: TOPIC, branchId: 'C' } })
      store.dispatch({ type: 'topicBranch/activeBranchSet', payload: { topicId: TOPIC, branchId: null } })
    })
    expect(store.getState().topicBranch.routeGenerationByTopic[TOPIC]).toBe(2)
    bootstrapRead.resolve(windowResponse(requests()[0], ['u1', 'a1'], groups))
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))

    // Route value is equal again (A→B→A), but the generation moved: the window
    // and its structure are discarded all the same.
    expectNoBootstrapPublication(store)
    expect(readCount()).toBe(1)
    expect(screen.getByTestId('route-probe').textContent).toBe('T::main:false:')
  })

  it('releases the gate after a failed bootstrap so a later catalog arrival probes exactly once', async () => {
    const store = makeStore()
    const groups: GroupSpec[] = [{ id: 's-main', members: ['u1', 'a1'] }]
    mocks.fetchMessagesWindow.mockImplementationOnce(() => Promise.reject(new Error('bootstrap read failed')))
    mocks.fetchMessagesWindow.mockImplementation(async (request: FetchMessagesWindowRequest) =>
      windowResponse(request, ['u1', 'a1'], groups)
    )

    render(<Surface store={store} />)
    await waitFor(() => expect(readCount()).toBe(1), WAIT)
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))

    // Failed activation: nothing published, no structure, no permanent hold.
    expectNoBootstrapPublication(store)
    expect(screen.getByTestId('route-probe').textContent).toBe('T::main:false:')
    expect(readCount()).toBe(1)

    // An independent catalog arrival (StoreSync/another writer) still triggers
    // the surface's own structural read, which becomes current.
    act(() => {
      store.dispatch({
        type: 'topicSegments/replaceSegmentsForTopic',
        payload: { topicId: TOPIC, segments: catalog(groups) }
      })
    })
    await waitFor(() => expect(readCount()).toBe(2), WAIT)
    await waitFor(() => expect(screen.getByTestId('route-probe').textContent).toBe('T::main:true:s-main'), WAIT)
    expect(requests()[1]).toMatchObject({ kind: 'latest', limit: ROUTE_STRUCTURE_WINDOW_LIMIT })
    expect(readCount()).toBe(2)
  })
})
