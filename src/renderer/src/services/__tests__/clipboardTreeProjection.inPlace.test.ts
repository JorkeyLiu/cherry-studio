/**
 * Tree clipboard projection convergence — in-place commit of the command's own
 * route-scoped deltas.
 *
 * Real root reducer + real convergence service; only Main thunks (branch
 * catalog, route load) and the segment catalog are mocked. Promise guarded
 * here: a tree write of the DISPLAYED route never re-images that route.
 * - no `latest` route reload, so every loaded older page and its scroll anchor
 *   survive byte-for-byte in the resident order,
 * - rows of another route never enter this window, and rows owned by an
 *   ancestor route enter only as an inherited prefix (never mutable here),
 * - a route switch or eviction during the async catalog refresh publishes
 *   nothing at all,
 * - a route the command removed falls back and takes a real authority read,
 * - an undisplayed affected topic is evicted, not reloaded.
 */
import { configureStore } from '@reduxjs/toolkit'
import { rootReducer } from '@renderer/store'
import { newMessagesActions } from '@renderer/store/newMessage'
import { setActiveTopic } from '@renderer/store/runtime'
import { activeBranchSet, branchesReceived } from '@renderer/store/topicBranch'
import type { Message } from '@renderer/types/newMessage'
import type { ClipboardTreeRouteProjection } from '@shared/chatDb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    fetchTopicBranchesThunk: vi.fn(),
    loadRouteMessagesThunk: vi.fn(() => ({ type: 'messageThunk/loadRouteMessages' })),
    convergeTopicSegmentCatalog: vi.fn(async () => {})
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  fetchTopicBranchesThunk: mocks.fetchTopicBranchesThunk,
  loadRouteMessagesThunk: mocks.loadRouteMessagesThunk
}))

vi.mock('@renderer/utils/topicSegmentCatalog', () => ({
  convergeTopicSegmentCatalog: mocks.convergeTopicSegmentCatalog
}))

import { convergeAfterClipboardTreeWrite } from '@renderer/services/clipboardTreeProjection'

const TOPIC = 'topic-1'

interface StoreOptions {
  residentIds?: string[]
  residentRoute?: string | null
  residentMutable?: string[]
  branches?: Array<{ id: string; parentBranchId: string | null; anchorMessageId: string }>
  activeRoute?: string | null
  displayed?: boolean
}

function msg(id: string): Message {
  return { id, role: 'user', topicId: TOPIC } as unknown as Message
}

function makeStore(options: StoreOptions = {}) {
  const {
    residentIds = [],
    residentRoute = null,
    residentMutable = [],
    branches = [],
    activeRoute = null,
    displayed = true
  } = options
  const store = configureStore({ reducer: rootReducer })
  if (displayed) {
    store.dispatch(setActiveTopic({ id: TOPIC, name: 'T' } as never))
  }
  if (branches.length > 0) {
    store.dispatch(
      branchesReceived({
        topicId: TOPIC,
        branches: branches.map((b) => ({ ...b, topicId: TOPIC, name: b.id, createdAt: 0 })) as never
      })
    )
  }
  if (activeRoute !== null) store.dispatch(activeBranchSet({ topicId: TOPIC, branchId: activeRoute }))
  if (residentIds.length > 0) {
    store.dispatch(
      newMessagesActions.messagesWindowMerged({
        topicId: TOPIC,
        messages: residentIds.map(msg),
        route: residentRoute,
        mutableMessageIds: residentMutable
      })
    )
  }
  return store
}

type Store = ReturnType<typeof makeStore>

function order(store: Store): string[] {
  return store.getState().messages.messageIdsByTopic[TOPIC] ?? []
}

function mutableIds(store: Store): string[] {
  return [...(store.getState().messages.mutableMessageIdsByTopic[TOPIC] ?? [])].sort()
}

function runConverge(store: Store, projections: ClipboardTreeRouteProjection[], topics: string[] = [TOPIC]) {
  return convergeAfterClipboardTreeWrite(store.dispatch as never, () => store.getState(), topics, 'test', projections)
}

function delta(overrides: Partial<ClipboardTreeRouteProjection> = {}): ClipboardTreeRouteProjection {
  return {
    topicId: TOPIC,
    branchId: null,
    removedMessageIds: [],
    insertedRuns: [],
    mutableMessageIds: [],
    messages: [],
    blocks: [],
    ...overrides
  }
}

describe('convergeAfterClipboardTreeWrite (in-place route delta)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchTopicBranchesThunk.mockReturnValue({ type: 'messageThunk/fetchTopicBranches' })
    mocks.loadRouteMessagesThunk.mockImplementation(() => ({ type: 'messageThunk/loadRouteMessages' }))
    mocks.convergeTopicSegmentCatalog.mockResolvedValue(undefined)
  })

  it('keeps every loaded older page when a paste lands at the displayed route tail', async () => {
    // Two loaded pages; the pre-fix reload replaced all of this with the last page.
    const store = makeStore({ residentIds: ['o1', 'o2', 'o3', 'o4', 'o5'], residentMutable: ['o4', 'o5'] })

    await runConverge(store, [
      delta({
        insertedRuns: [{ messageIds: ['n1', 'n2'], beforeMessageId: 'o5', nextMessageId: null }],
        mutableMessageIds: ['n1', 'n2'],
        messages: [{ id: 'n1' }, { id: 'n2' }],
        blocks: [{ id: 'b1', messageId: 'n1' }]
      })
    ])

    // The core regression: no whole-route reload of the displayed route.
    expect(mocks.loadRouteMessagesThunk).not.toHaveBeenCalled()
    expect(order(store)).toEqual(['o1', 'o2', 'o3', 'o4', 'o5', 'n1', 'n2'])
    expect(store.getState().messages.entities.n1).toBeDefined()
    // Capability committed in the same action, route-qualified.
    expect(mutableIds(store)).toEqual(['n1', 'n2', 'o4', 'o5'])
    expect(store.getState().messages.mutableRouteByTopic[TOPIC]).toBeNull()
    // Row blocks published ahead of the rows.
    expect(store.getState().messageBlocks.entities['b1']).toBeDefined()
    // Chrome convergence still runs last, against the committed window.
    expect(mocks.convergeTopicSegmentCatalog).toHaveBeenCalledTimes(1)
  })

  it('removes only loaded intersections and leaves the window ready for the next older page', async () => {
    const store = makeStore({ residentIds: ['o1', 'o2', 'o3', 'o4'] })

    await runConverge(store, [delta({ removedMessageIds: ['o2', 'never-loaded'] })])

    expect(mocks.loadRouteMessagesThunk).not.toHaveBeenCalled()
    expect(order(store)).toEqual(['o1', 'o3', 'o4'])
    // The next older page request is anchored on a row that is still resident,
    // so its merge still applies cleanly instead of being rejected as stale.
    store.dispatch(
      newMessagesActions.messagesWindowMerged({
        topicId: TOPIC,
        messages: ['page-old', 'o1', 'o3', 'o4'].map(msg),
        route: null,
        mutableMessageIds: []
      })
    )
    expect(order(store)).toEqual(['page-old', 'o1', 'o3', 'o4'])
  })

  it('splices an ancestor-owned run only into the inherited prefix and never makes it mutable here', async () => {
    const store = makeStore({
      residentIds: ['o1', 'o2', 'b1a'],
      residentRoute: 'branch-1',
      residentMutable: ['b1a', 'o2'],
      branches: [{ id: 'branch-1', parentBranchId: null, anchorMessageId: 'o2' }],
      activeRoute: 'branch-1'
    })

    await runConverge(store, [
      // Main route delta: a restored run sits between two main rows.
      delta({
        branchId: null,
        insertedRuns: [{ messageIds: ['r1'], beforeMessageId: 'o2', nextMessageId: 'b1a' }],
        mutableMessageIds: ['r1'],
        messages: [{ id: 'r1' }]
      }),
      // A main row past the fork: its successor is not resident on this route.
      delta({
        branchId: null,
        insertedRuns: [{ messageIds: ['r2'], beforeMessageId: 'o2', nextMessageId: 'main-later' }],
        mutableMessageIds: ['r2'],
        messages: [{ id: 'r2' }]
      })
    ])

    // r1 lands in the inherited prefix; r2 (beyond the fork) injects nothing.
    expect(order(store)).toEqual(['o1', 'o2', 'r1', 'b1a'])
    // Inherited rows stay read-only on this route: only its own rows are mutable.
    expect(mutableIds(store)).toEqual(['b1a', 'o2'])
  })

  it('publishes nothing when the resident route changes during the catalog refresh', async () => {
    const store = makeStore({
      residentIds: ['o1', 'o2'],
      branches: [{ id: 'branch-1', parentBranchId: null, anchorMessageId: 'o2' }]
    })
    mocks.fetchTopicBranchesThunk.mockImplementation(() => {
      // The user switched route while the command's convergence was in flight.
      store.dispatch(activeBranchSet({ topicId: TOPIC, branchId: 'branch-1' }))
      return { type: 'messageThunk/fetchTopicBranches' }
    })

    await runConverge(store, [
      delta({
        insertedRuns: [{ messageIds: ['n1'], beforeMessageId: 'o2', nextMessageId: null }],
        mutableMessageIds: ['n1'],
        messages: [{ id: 'n1' }]
      })
    ])

    expect(order(store)).toEqual(['o1', 'o2'])
    expect(store.getState().messages.entities.n1).toBeUndefined()
    expect(mocks.loadRouteMessagesThunk).not.toHaveBeenCalled()
  })

  it('falls back and takes a real authority read when the command removed the displayed route', async () => {
    const store = makeStore({
      residentIds: ['o1', 'o2'],
      residentRoute: 'branch-1',
      branches: [{ id: 'branch-1', parentBranchId: null, anchorMessageId: 'o2' }],
      activeRoute: 'branch-1'
    })
    // Main no longer has that branch: the refreshed catalog drops it.
    mocks.fetchTopicBranchesThunk.mockImplementation(() => {
      store.dispatch(branchesReceived({ topicId: TOPIC, branches: [] }))
      return { type: 'messageThunk/fetchTopicBranches' }
    })

    await runConverge(store, [delta({ branchId: 'branch-1', removedMessageIds: ['b1a'] })])

    expect(mocks.loadRouteMessagesThunk).toHaveBeenCalledWith(TOPIC, null, { kind: 'latest' })
    expect(store.getState().topicBranch.activeBranchIdByTopic[TOPIC] ?? null).toBeNull()
  })
  it('does not fabricate a window for a displayed topic that has not been loaded yet', async () => {
    const store = makeStore()
    expect(store.getState().messages.messageIdsByTopic[TOPIC]).toBeUndefined()

    await runConverge(store, [
      delta({
        insertedRuns: [{ messageIds: ['n1'], beforeMessageId: null, nextMessageId: null }],
        mutableMessageIds: ['n1'],
        messages: [{ id: 'n1' }]
      })
    ])

    // No resident window means no completeness claim to merge into: the topic's
    // own route load publishes the committed rows instead.
    expect(store.getState().messages.messageIdsByTopic[TOPIC]).toBeUndefined()
    expect(store.getState().messages.entities.n1).toBeUndefined()
  })

  it('evicts an affected topic the user is not displaying instead of loading it', async () => {
    const OTHER = 'topic-other'
    const store = makeStore({ residentIds: ['o1', 'o2'] })
    store.dispatch(
      newMessagesActions.messagesWindowMerged({
        topicId: OTHER,
        messages: [msg('x1')],
        route: null,
        mutableMessageIds: []
      })
    )

    await runConverge(store, [delta({ topicId: OTHER, branchId: null, removedMessageIds: ['x1'] })], [TOPIC, OTHER])

    expect(store.getState().messages.messageIdsByTopic[OTHER]).toBeUndefined()
    expect(mocks.loadRouteMessagesThunk).not.toHaveBeenCalled()
    // The displayed topic was untouched by this command.
    expect(order(store)).toEqual(['o1', 'o2'])
  })

  it('converges the segment catalog only after the committed rows are published', async () => {
    const store = makeStore({ residentIds: ['o1', 'o2'] })
    let orderAtConvergence: string[] | null = null
    mocks.convergeTopicSegmentCatalog.mockImplementation(async () => {
      orderAtConvergence = [...(store.getState().messages.messageIdsByTopic[TOPIC] ?? [])]
    })

    await runConverge(store, [
      delta({
        insertedRuns: [{ messageIds: ['n1'], beforeMessageId: 'o2', nextMessageId: null }],
        mutableMessageIds: ['n1'],
        messages: [{ id: 'n1' }]
      })
    ])

    // The accepted catalog change is what tells a subscribed route-chrome reader
    // to re-read the route. It must be published only once the route's own rows
    // are in place, so that re-read never sees a group whose members the window
    // and Main disagree about.
    expect(orderAtConvergence).toEqual(['o1', 'o2', 'n1'])
  })
})
