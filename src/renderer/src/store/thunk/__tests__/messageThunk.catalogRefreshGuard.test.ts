/**
 * Post-write catalog reads share one guarded entry.
 *
 * `createBranchThunk`, `moveSelectedTurnsToNewBranchThunk`, and
 * `deleteBranchSubtree` used to read `listBranches` and publish unguarded, so
 * a read started before a semantic ack but resolving after it overwrote the
 * newer authority catalog. All three now go through
 * `refreshBranchCatalogGuarded` (same entry as `fetchTopicBranchesThunk`):
 * once a newer authority catalog is accepted, every older in-flight catalog
 * read discards instead of publishing.
 *
 * Table-driven over the three entries with one deferred-race runner: gate
 * the read, accept an authority ack mid-await, resolve the stale read, and
 * assert the projection keeps the ack catalog. Real Redux store + real
 * thunks; only the data source (and the history/snapshot side channels) are
 * mocked. No source-text assertions.
 */
import { configureStore } from '@reduxjs/toolkit'
import store from '@renderer/store'
import { rootReducer } from '@renderer/store'
import { branchesReceived, branchesRemoved, selectTopicBranches } from '@renderer/store/topicBranch'
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
vi.mock('i18next', () => ({
  default: { use: vi.fn().mockReturnThis(), init: vi.fn(), t: (k: string) => k },
  t: (k: string) => k
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0))

const wire = (topicId: string, id: string, anchorMessageId: string) => ({
  id,
  topicId,
  parentBranchId: null,
  anchorMessageId,
  inheritedBoundary: { kind: 'message' as const, messageId: anchorMessageId },
  name: id,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
})

const ackDeleteResponse = (topicId: string, branches: unknown[]) => ({
  topicId,
  branchId: null,
  branches,
  affectedFileIds: [],
  remainingReferenceCounts: {},
  deletedMessageIds: [],
  deletedBlockIds: [],
  previousUserMessageIds: [],
  remainingUserMessageIds: [],
  segments: [],
  restoreGroups: [],
  segmentSnapshots: [],
  boundarySnapshots: []
})

function turnEntities(ids: string[]): Record<string, any> {
  const entities: Record<string, any> = {}
  for (let i = 0; i < ids.length; i += 2) {
    const u = ids[i]
    const a = ids[i + 1]
    entities[u] = { id: u, role: 'user', askId: null }
    if (a) entities[a] = { id: a, role: 'assistant', askId: u }
  }
  return entities
}

const LOADED = ['uA', 'aA', 'uB', 'aB', 'uC', 'aC', 'uD', 'aD']

function movePreloadedState() {
  return {
    topicBranch: {
      branchesByTopic: {},
      activeBranchIdByTopic: {},
      routeGenerationByTopic: { 't-1': 1 },
      deletionFallbackByTopic: {},
      catalogRevisionByTopic: {},
      catalogFetchSeqByTopic: {}
    },
    messages: {
      entities: turnEntities(LOADED),
      ids: LOADED,
      messageIdsByTopic: { 't-1': LOADED },
      mutableMessageIdsByTopic: { 't-1': LOADED },
      mutableRouteByTopic: { 't-1': null },
      displayCount: 20,
      loadingByTopic: {},
      currentTopicId: 't-1'
    },
    messageBlocks: { entities: {}, ids: [] },
    editMode: { enabled: true, selectedGroupIds: ['uB', 'uC'], lastSelectedIndex: null, focusedIndex: null },
    topicSegments: { segmentsByTopic: {}, segments: { entities: {} } },
    assistants: { assistants: [] }
  } as any
}

describe('post-write catalog reads share the guarded entry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listBranches.mockReset()
    mocks.createBranch.mockResolvedValue({
      branch: { id: 'nb', anchorMessageId: 'm0' },
      messages: [],
      blocks: []
    })
    mocks.moveSelectedTurnsToNewBranch.mockResolvedValue({
      branch: { id: 'nb', anchorMessageId: 'aA' },
      movedMessageIds: ['uB', 'aB', 'uC', 'aC'],
      anchorMessageId: 'aA',
      messages: [],
      blocks: []
    })
    mocks.deleteBranch.mockResolvedValue({ deletedBranchIds: ['b-old'] })
    mocks.fetchMessagesWindow.mockResolvedValue({
      messages: [],
      blocks: [],
      window: { kind: 'latest' },
      mutableMessageIds: []
    })
  })

  it('createBranchThunk: gated read resolving after an authority ack keeps the ack catalog', async () => {
    const topicId = 't-create-guard'
    const fresh = configureStore({ reducer: rootReducer })
    const { createBranchThunk, publishDeleteAuthorityCatalog } = await import('../messageThunk')

    const gate = deferred<{ branches: unknown[] }>()
    mocks.listBranches.mockImplementationOnce(() => gate.promise)
    const pending = createBranchThunk(topicId, null, 'm0', 'B2')(fresh.dispatch as any, fresh.getState as any)
    await flush()

    // A semantic ack for the same topic lands while the create read is in flight.
    publishDeleteAuthorityCatalog(
      fresh.dispatch as any,
      topicId,
      ackDeleteResponse(topicId, [wire(topicId, 'b-ack', 'm-ack')]) as any
    )
    gate.resolve({ branches: [wire(topicId, 'b-stale', 'm-stale')] })
    const res = await pending

    expect(res).not.toBeNull()
    expect(mocks.listBranches).toHaveBeenCalledWith(topicId)
    expect(selectTopicBranches(fresh.getState() as any, topicId).map((b: { id: string }) => b.id)).toEqual(['b-ack'])
  })

  it('moveSelectedTurnsToNewBranchThunk: gated read resolving after an authority ack keeps the ack catalog', async () => {
    const topicId = 't-1'
    const fresh = configureStore({ reducer: rootReducer, preloadedState: movePreloadedState() })
    const { moveSelectedTurnsToNewBranchThunk, publishDeleteAuthorityCatalog } = await import('../messageThunk')

    const gate = deferred<{ branches: unknown[] }>()
    mocks.listBranches.mockImplementationOnce(() => gate.promise)
    const pending = moveSelectedTurnsToNewBranchThunk(
      topicId,
      null,
      ['uB', 'uC'],
      'Moved'
    )(fresh.dispatch as any, fresh.getState as any)
    // Wait until the thunk's guarded read is actually in flight (the thunk
    // awaits a dynamic import before reaching listBranches): the ack must
    // land DURING the read await, not before the read starts.
    for (let i = 0; i < 50 && mocks.listBranches.mock.calls.length === 0; i++) await flush()
    expect(mocks.listBranches).toHaveBeenCalledWith(topicId)

    // A semantic ack for the same topic lands while the move read is in
    // flight. The ack bumps only the catalog revision (route generation is
    // untouched while the active route still resolves), so the committed
    // move proceeds to its guarded catalog read, which must discard itself.
    publishDeleteAuthorityCatalog(
      fresh.dispatch as any,
      topicId,
      ackDeleteResponse(topicId, [wire(topicId, 'b-ack', 'm-ack')]) as any
    )
    gate.resolve({ branches: [wire(topicId, 'b-stale', 'm-stale')] })
    const res = await pending
    expect(res).not.toBeNull()
    expect(mocks.listBranches).toHaveBeenCalledWith(topicId)
    expect(selectTopicBranches(fresh.getState() as any, topicId).map((b: { id: string }) => b.id)).toEqual(['b-ack'])
  })

  it('deleteBranchSubtree: gated read resolving after an authority ack keeps the ack catalog', async () => {
    const topicId = 't-guard-sub'
    const { deleteBranchSubtree } = await import('@renderer/services/db/branchSubtree')
    const { publishDeleteAuthorityCatalog } = await import('../messageThunk')
    try {
      store.dispatch(branchesReceived({ topicId, branches: [wire(topicId, 'b-old', 'm-old')] }) as never)

      const gate = deferred<{ branches: unknown[] }>()
      mocks.listBranches.mockImplementationOnce(() => gate.promise)
      const pending = deleteBranchSubtree(topicId, 'b-old', null)
      await flush()

      // A semantic ack for the same topic lands while the subtree read is in flight.
      publishDeleteAuthorityCatalog(
        store.dispatch as any,
        topicId,
        ackDeleteResponse(topicId, [wire(topicId, 'b-ack', 'm-ack')]) as any
      )
      gate.resolve({ branches: [wire(topicId, 'b-stale', 'm-stale')] })
      const res = await pending

      expect(res).toEqual({ deletedBranchIds: ['b-old'], fallbackBranchId: null })
      expect(mocks.listBranches).toHaveBeenCalledWith(topicId)
      expect((store.getState() as any).topicBranch.branchesByTopic[topicId].map((b: { id: string }) => b.id)).toEqual([
        'b-ack'
      ])
    } finally {
      store.dispatch(branchesRemoved({ topicIds: [topicId] }))
    }
  })

  it('fetchTopicBranchesThunk still publishes a fresh read with no concurrent ack', async () => {
    const topicId = 't-fetch-fresh'
    const fresh = configureStore({ reducer: rootReducer })
    const { fetchTopicBranchesThunk } = await import('../messageThunk')

    mocks.listBranches.mockResolvedValueOnce({ branches: [wire(topicId, 'b-fresh', 'm-fresh')] })
    await (fresh.dispatch as any)(fetchTopicBranchesThunk(topicId))

    expect(selectTopicBranches(fresh.getState() as any, topicId).map((b: { id: string }) => b.id)).toEqual(['b-fresh'])
  })
})
