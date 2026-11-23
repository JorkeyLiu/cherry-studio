/**
 * ONE branch catalog request per topic for the whole chat surface.
 *
 * Every chat-surface consumer (top selector, message-flow fork dividers, the
 * conversation navigation list) projects the Main-authoritative Redux catalog
 * by its own `branchId`. Before this shell each consumer also requested that
 * catalog on mount/topic change through `useBranchTree`, so one topic
 * activation issued one identical `listBranches` read per mounted consumer
 * (two with navigation off, three with it on). `ChatBranchCatalogProvider`
 * (mounted by `Chat` around navbar + message flow) now owns that single
 * request; an explicit mutation refresh (`requestTopicBranches`) stays a
 * separate one-shot request and is never folded into it.
 *
 * Harness: real provider, real `useBranchTree` consumers, real Redux store and
 * real thunks; only the data source is mocked. The three consumers are light
 * stubs of the surface roles (they call the real hook with the route each role
 * owns) — no component-internal rendering is mirrored here.
 */
import { configureStore } from '@reduxjs/toolkit'
import type { TopicBranchWire } from '@renderer/services/db/types'
import { rootReducer } from '@renderer/store'
import { selectTopicBranches } from '@renderer/store/topicBranch'
import { act, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks, logCalls } = vi.hoisted(() => ({
  logCalls: { error: vi.fn(), warn: vi.fn() },
  mocks: {
    createBranch: vi.fn(),
    moveSelectedTurnsToNewBranch: vi.fn(),
    deleteBranch: vi.fn(),
    listBranches: vi.fn(),
    fetchMessagesWindow: vi.fn(),
    resolveContextClosure: vi.fn(),
    pushBranchCreateAction: vi.fn(),
    pushBranchMoveAction: vi.fn(),
    pushBranchDeleteAction: vi.fn(),
    handleScrollSnapshotCleared: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      info: vi.fn(),
      warn: (...args: unknown[]) => logCalls.warn(...args),
      error: (...args: unknown[]) => logCalls.error(...args),
      debug: vi.fn(),
      silly: vi.fn()
    })
  }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    createBranch: mocks.createBranch,
    moveSelectedTurnsToNewBranch: mocks.moveSelectedTurnsToNewBranch,
    listBranches: mocks.listBranches,
    fetchMessagesWindow: mocks.fetchMessagesWindow,
    resolveContextClosure: mocks.resolveContextClosure
  }
}))

vi.mock('@renderer/services/db/DbService', () => ({
  dbService: {
    deleteBranch: mocks.deleteBranch,
    listBranches: mocks.listBranches
  }
}))

vi.mock('@renderer/services/branchOperationHistory', () => ({
  pushBranchCreateAction: mocks.pushBranchCreateAction,
  pushBranchMoveAction: mocks.pushBranchMoveAction,
  pushBranchDeleteAction: mocks.pushBranchDeleteAction
}))

vi.mock('@renderer/services/scrollSnapshotCache', () => ({
  handleScrollSnapshotCleared: mocks.handleScrollSnapshotCleared
}))

vi.mock('@renderer/store/thunk/topicSegmentThunk', () => ({ loadTopicSegmentsThunk: vi.fn() }))
vi.mock('@renderer/utils/queue', () => ({ getTopicQueue: () => ({ add: vi.fn() }), waitForTopicQueue: vi.fn() }))
vi.mock('@renderer/utils/abortController', () => ({ addAbortController: vi.fn() }))
vi.mock('swr', () => ({ mutate: vi.fn() }))

import { ChatBranchCatalogProvider, requestTopicBranches } from '../ChatBranchCatalog'
import { useBranchTree } from '../Messages/useBranchTree'

type Any = any

const TOPIC_A = 'topic-A'
const TOPIC_B = 'topic-B'
const TOPIC_Z = 'topic-Z'
const WAIT = { timeout: 5000 }

function wire(
  topicId: string,
  id: string,
  parentBranchId: string | null,
  anchor: string,
  createdAt: string
): TopicBranchWire {
  return { id, topicId, parentBranchId, anchorMessageId: anchor, name: id, createdAt, updatedAt: createdAt }
}

/** Topic A: level-1 root plus one child under it (the route ladder). */
const CATALOG_A = [
  wire(TOPIC_A, 'b-root', null, 'm-001', '2026-01-01T00:00:01.000Z'),
  wire(TOPIC_A, 'b-child', 'b-root', 'm-002', '2026-01-01T00:00:02.000Z')
]
const CATALOG_B = [wire(TOPIC_B, 'b-b', null, 'm-101', '2026-01-01T00:00:03.000Z')]
const CATALOG_Z = [wire(TOPIC_Z, 'b-z', null, 'm-201', '2026-01-01T00:00:04.000Z')]

/** Every render of a consumer, by role, with the route it derived. */
const observed: Record<string, { branchIds: string[]; path: string[]; children: string[]; catalog: Any }> = {}

function resetObserved(): void {
  for (const key of Object.keys(observed)) delete observed[key]
}

/**
 * Stand-in for one surface role: calls the real projection hook with the route
 * that role owns (navbar = selected route, messages = displayed route,
 * navigation = selected route) and reports what it derived.
 */
function BranchConsumer({ role, topicId, branchId }: { role: string; topicId: string; branchId: string | null }) {
  const tree = useBranchTree(topicId, branchId)
  observed[role] = {
    branchIds: tree.branches.map((b) => b.id),
    path: tree.path.map((b) => b.id),
    children: tree.children.map((b) => b.id),
    catalog: tree.branches
  }
  return (
    <div
      data-testid={`consumer-${role}`}
      data-path={tree.path.map((b) => b.id).join('>')}
      data-children={tree.children.map((b) => b.id).join(',')}
      data-nodes={tree.branches.map((b) => b.id).join(',')}
    />
  )
}

interface SurfaceProps {
  store: Any
  topicId: string
  routes: { navbar: string | null; messages: string | null; navigation: string | null }
  /** The third consumer only mounts while the setting is on. */
  messageNavigation: boolean
  /** An extra consumer addressing a topic the shell does not own. */
  foreignTopicId?: string
}

function Surface({ store, topicId, routes, messageNavigation, foreignTopicId }: SurfaceProps) {
  const body: ReactNode = (
    <ChatBranchCatalogProvider topicId={topicId}>
      <BranchConsumer role="navbar" topicId={topicId} branchId={routes.navbar} />
      <BranchConsumer role="messages" topicId={topicId} branchId={routes.messages} />
      {messageNavigation && <BranchConsumer role="navigation" topicId={topicId} branchId={routes.navigation} />}
      {foreignTopicId ? <BranchConsumer role="foreign" topicId={foreignTopicId} branchId={null} /> : null}
    </ChatBranchCatalogProvider>
  )
  return <Provider store={store}>{body}</Provider>
}

function makeStore(): Any {
  const store = configureStore({ reducer: rootReducer as Any })
  return store
}

/** Thunk dispatches only (inner catalog actions are plain objects). */
function thunkDispatches(dispatchSpy: Any): Any[] {
  return dispatchSpy.mock.calls.filter((call: Any[]) => typeof call[0] === 'function')
}

const reads = (): Any[] => mocks.listBranches.mock.calls.map((call: Any[]) => call[0])

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('ChatBranchCatalogProvider single surface request', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetObserved()
    mocks.listBranches.mockImplementation(async (topicId: string) => ({
      topicId,
      branches: topicId === TOPIC_B ? CATALOG_B : topicId === TOPIC_Z ? CATALOG_Z : CATALOG_A
    }))
  })

  it('requests the catalog once per topic with navigation off and with navigation on', async () => {
    for (const messageNavigation of [false, true]) {
      vi.clearAllMocks()
      resetObserved()
      const store = makeStore()
      const dispatchSpy = vi.spyOn(store, 'dispatch')

      const { unmount } = render(
        <Surface
          store={store}
          topicId={TOPIC_A}
          routes={{ navbar: null, messages: null, navigation: null }}
          messageNavigation={messageNavigation}
        />
      )

      await waitFor(() => expect(screen.getByTestId('consumer-navbar').dataset.nodes).toBe('b-root,b-child'), WAIT)

      // ONE read for the surface, whatever the consumer count: navbar +
      // messages (2) or navbar + messages + navigation (3).
      expect(reads()).toEqual([TOPIC_A])
      expect(thunkDispatches(dispatchSpy)).toHaveLength(1)
      const consumerCount = messageNavigation ? 3 : 2
      expect(store.getState().topicBranch.catalogFetchSeqByTopic[TOPIC_A]).toBe(1)
      expect(consumerCount).toBe(Object.keys(observed).length)

      // Mounting/unmounting the third consumer is not a catalog event.
      unmount()
    }
  })

  it('does not read again for the same topic, a rerender, or a branch-only route change', async () => {
    const store = makeStore()
    const dispatchSpy = vi.spyOn(store, 'dispatch')
    const { rerender } = render(
      <Surface
        store={store}
        topicId={TOPIC_A}
        routes={{ navbar: null, messages: 'b-root', navigation: 'b-root' }}
        messageNavigation
      />
    )
    await waitFor(() => expect(observed.navigation?.branchIds).toEqual(['b-root', 'b-child']), WAIT)
    expect(reads()).toEqual([TOPIC_A])
    expect(thunkDispatches(dispatchSpy)).toHaveLength(1)

    // Same topic, new branch ids only: the catalog is shared state, not a
    // route input, so every role re-derives without a read.
    rerender(
      <Surface
        store={store}
        topicId={TOPIC_A}
        routes={{ navbar: 'b-child', messages: 'b-root', navigation: 'b-child' }}
        messageNavigation
      />
    )
    expect(reads()).toEqual([TOPIC_A])
    expect(thunkDispatches(dispatchSpy)).toHaveLength(1)
    // Each role derives its own path/children from the same catalog.
    expect(screen.getByTestId('consumer-navbar').dataset.path).toBe('b-root>b-child')
    expect(screen.getByTestId('consumer-navbar').dataset.children).toBe('')
    expect(screen.getByTestId('consumer-messages').dataset.path).toBe('b-root')
    expect(screen.getByTestId('consumer-messages').dataset.children).toBe('b-child')
    expect(screen.getByTestId('consumer-navigation').dataset.path).toBe('b-root>b-child')
    // Same catalog object for every role: one surface fact, no per-consumer copy.
    expect(observed.navbar.catalog).toBe(observed.messages.catalog)
    expect(observed.navigation.catalog).toBe(observed.messages.catalog)

    // A real topic change is exactly one new request for the new topic.
    rerender(
      <Surface
        store={store}
        topicId={TOPIC_B}
        routes={{ navbar: null, messages: null, navigation: null }}
        messageNavigation
      />
    )
    await waitFor(() => expect(reads()).toEqual([TOPIC_A, TOPIC_B]), WAIT)
    expect(thunkDispatches(dispatchSpy)).toHaveLength(2)
    await waitFor(() => expect(observed.navigation?.branchIds).toEqual(['b-b']), WAIT)
  })

  it('keeps an explicit mutation refresh a separate read that publishes', async () => {
    const store = makeStore()
    const dispatchSpy = vi.spyOn(store, 'dispatch')
    render(
      <Surface
        store={store}
        topicId={TOPIC_A}
        routes={{ navbar: null, messages: null, navigation: null }}
        messageNavigation
      />
    )
    await waitFor(() => expect(observed.navbar?.branchIds).toEqual(['b-root', 'b-child']), WAIT)
    expect(reads()).toEqual([TOPIC_A])

    // Post-write refresh (create/rename/delete/copy): the shell's per-topic
    // request never suppresses it, so Main is read again and the projection
    // follows the published catalog.
    mocks.listBranches.mockImplementation(async (topicId: string) => ({
      topicId,
      branches: [wire(TOPIC_A, 'b-new', null, 'm-003', '2026-01-01T00:00:05.000Z')]
    }))
    await act(async () => {
      requestTopicBranches(store.dispatch, TOPIC_A)
      await waitFor(() => expect(reads()).toEqual([TOPIC_A, TOPIC_A]), WAIT)
    })

    expect(thunkDispatches(dispatchSpy)).toHaveLength(2)
    await waitFor(
      () => expect(selectTopicBranches(store.getState(), TOPIC_A).map((b: Any) => b.id)).toEqual(['b-new']),
      WAIT
    )
    await waitFor(() => expect(observed.navbar?.branchIds).toEqual(['b-new']), WAIT)
  })

  it('publishes only the latest response of a rapid topic A → B → A switch', async () => {
    const firstA = deferred<Any>()
    const pendingB = deferred<Any>()
    const secondA = deferred<Any>()
    mocks.listBranches
      .mockImplementationOnce(() => firstA.promise)
      .mockImplementationOnce(() => pendingB.promise)
      .mockImplementationOnce(() => secondA.promise)

    const store = makeStore()
    const { rerender } = render(
      <Surface
        store={store}
        topicId={TOPIC_A}
        routes={{ navbar: null, messages: null, navigation: null }}
        messageNavigation={false}
      />
    )
    await waitFor(() => expect(reads()).toHaveLength(1), WAIT)

    rerender(
      <Surface
        store={store}
        topicId={TOPIC_B}
        routes={{ navbar: null, messages: null, navigation: null }}
        messageNavigation={false}
      />
    )
    await waitFor(() => expect(reads()).toHaveLength(2), WAIT)

    rerender(
      <Surface
        store={store}
        topicId={TOPIC_A}
        routes={{ navbar: null, messages: null, navigation: null }}
        messageNavigation={false}
      />
    )
    await waitFor(() => expect(reads()).toHaveLength(3), WAIT)

    // The re-addressed topic's read lands first, then the abandoned ones: the
    // older A read must not overwrite the newer projection (catalog fetch
    // sequence, unchanged), and the B read publishes only for B.
    await act(async () => {
      secondA.resolve({
        topicId: TOPIC_A,
        branches: [wire(TOPIC_A, 'b-latest', null, 'm-004', '2026-01-01T00:00:06.000Z')]
      })
      await waitFor(() => expect(observed.navbar?.branchIds).toEqual(['b-latest']), WAIT)
    })
    await act(async () => {
      firstA.resolve({
        topicId: TOPIC_A,
        branches: [wire(TOPIC_A, 'b-stale', null, 'm-005', '2026-01-01T00:00:07.000Z')]
      })
      pendingB.resolve({ topicId: TOPIC_B, branches: CATALOG_B })
      await waitFor(() => expect(observed.navbar?.branchIds).toEqual(['b-latest']), WAIT)
    })
    await new Promise((r) => setTimeout(r, 50))

    expect(selectTopicBranches(store.getState(), TOPIC_A).map((b: Any) => b.id)).toEqual(['b-latest'])
    expect(selectTopicBranches(store.getState(), TOPIC_B).map((b: Any) => b.id)).toEqual(['b-b'])
    expect(observed.navbar.branchIds).toEqual(['b-latest'])
  })

  it('scopes the request to its own topic: another topic keeps its own read', async () => {
    vi.clearAllMocks()
    resetObserved()
    const store = makeStore()
    render(
      <Surface
        store={store}
        topicId={TOPIC_A}
        routes={{ navbar: null, messages: null, navigation: null }}
        messageNavigation={false}
        foreignTopicId={TOPIC_Z}
      />
    )
    // Child effects run before the shell's, so the foreign consumer's own
    // request lands first — but each topic is read exactly once.
    await waitFor(() => expect([...reads()].sort()).toEqual([TOPIC_A, TOPIC_Z].sort()), WAIT)
    await waitFor(() => expect(observed.foreign?.branchIds).toEqual(['b-z']), WAIT)
    // The shell's read is for its own topic only.
    expect(store.getState().topicBranch.catalogFetchSeqByTopic[TOPIC_A]).toBe(1)
    expect(store.getState().topicBranch.catalogFetchSeqByTopic[TOPIC_Z]).toBe(1)
  })

  it('keeps a consumer mounted without the shell loading its own catalog', async () => {
    const store = makeStore()
    render(
      <Provider store={store}>
        <BranchConsumer role="standalone" topicId={TOPIC_A} branchId={null} />
      </Provider>
    )
    await waitFor(() => expect(reads()).toEqual([TOPIC_A]), WAIT)
    await waitFor(() => expect(observed.standalone?.branchIds).toEqual(['b-root', 'b-child']), WAIT)
  })
})
