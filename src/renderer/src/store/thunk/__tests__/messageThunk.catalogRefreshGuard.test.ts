/**
 * Mutation acks carry the Main-authoritative branch catalog.
 *
 * `createBranchThunk`, `moveSelectedTurnsToNewBranchThunk`, and
 * `deleteBranchSubtree` publish the same-transaction catalog from the
 * mutation acknowledgment via `publishBranchCatalogAck` — no follow-up
 * `listBranches` read. Every accepted ack bumps the catalog revision, so an
 * older in-flight guarded read (`refreshBranchCatalogGuarded`, the same
 * entry as `fetchTopicBranchesThunk`) discards instead of overwriting it. A
 * missing/malformed/foreign/duplicated ack catalog keeps the projection and
 * never fails the committed mutation.
 *
 * Real Redux store + real thunks; only the data source (and the
 * history/snapshot side channels) are mocked. No source-text assertions.
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

describe('mutation acks publish the catalog with no listBranches follow-up', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listBranches.mockReset()
    mocks.fetchMessagesWindow.mockResolvedValue({
      messages: [],
      blocks: [],
      window: { kind: 'latest' },
      mutableMessageIds: []
    })
  })

  it('createBranchThunk: publishes the ack catalog with no listBranches follow-up', async () => {
    const topicId = 't-create-ack'
    const fresh = configureStore({ reducer: rootReducer })
    const { createBranchThunk } = await import('../messageThunk')

    mocks.createBranch.mockResolvedValueOnce({
      branch: { id: 'nb', anchorMessageId: 'm0' },
      messages: [],
      blocks: [],
      branches: [wire(topicId, 'nb', 'm0')]
    })
    const res = await createBranchThunk(topicId, null, 'm0', 'B2')(fresh.dispatch as any, fresh.getState as any)

    expect(res).not.toBeNull()
    expect(mocks.listBranches).not.toHaveBeenCalled()
    expect(selectTopicBranches(fresh.getState() as any, topicId).map((b: { id: string }) => b.id)).toEqual(['nb'])
  })

  it('moveSelectedTurnsToNewBranchThunk: publishes the ack catalog with no listBranches follow-up', async () => {
    const topicId = 't-1'
    const fresh = configureStore({ reducer: rootReducer, preloadedState: movePreloadedState() })
    const { moveSelectedTurnsToNewBranchThunk } = await import('../messageThunk')

    mocks.moveSelectedTurnsToNewBranch.mockResolvedValueOnce({
      branch: { id: 'nb', anchorMessageId: 'aA' },
      movedMessageIds: ['uB', 'aB', 'uC', 'aC'],
      anchorMessageId: 'aA',
      messages: [],
      blocks: [],
      branches: [wire(topicId, 'nb', 'aA')],
      historySnapshot: {
        kind: 'move',
        branch: {
          id: 'nb',
          parentBranchId: null,
          anchorMessageId: 'aA',
          name: 'Moved',
          createdAt: null,
          updatedAt: null,
          overflow: {}
        },
        sourceBranchId: null,
        movedMessageIds: ['uB', 'aB', 'uC', 'aC'],
        sourceOrderBefore: LOADED,
        reparented: []
      }
    })
    const res = await moveSelectedTurnsToNewBranchThunk(
      topicId,
      null,
      ['uB', 'uC'],
      'Moved'
    )(fresh.dispatch as any, fresh.getState as any)

    expect(res).not.toBeNull()
    expect(mocks.listBranches).not.toHaveBeenCalled()
    expect(selectTopicBranches(fresh.getState() as any, topicId).map((b: { id: string }) => b.id)).toEqual(['nb'])
  })

  it('deleteBranchSubtree: publishes the ack catalog with no listBranches follow-up', async () => {
    const topicId = 't-guard-sub'
    const { deleteBranchSubtree } = await import('@renderer/services/db/branchSubtree')
    try {
      store.dispatch(branchesReceived({ topicId, branches: [wire(topicId, 'b-old', 'm-old')] }) as never)

      mocks.deleteBranch.mockResolvedValueOnce({
        topicId,
        branches: [wire(topicId, 'b-ack', 'm-ack')],
        deletedBranchIds: ['b-old'],
        deletedMessageIds: [],
        deletedBlockIds: [],
        affectedFileIds: [],
        remainingReferenceCounts: {},
        historySnapshot: {
          kind: 'delete',
          rootBranchId: 'b-old',
          branches: [],
          messages: [],
          blocks: [],
          fileReferences: [],
          segments: [],
          segmentsAfter: [],
          segmentOrder: [],
          boundaries: []
        }
      })
      const res = await deleteBranchSubtree(topicId, 'b-old', null)

      expect(res).toEqual({ deletedBranchIds: ['b-old'], fallbackBranchId: null })
      expect(mocks.listBranches).not.toHaveBeenCalled()
      expect((store.getState() as any).topicBranch.branchesByTopic[topicId].map((b: { id: string }) => b.id)).toEqual([
        'b-ack'
      ])
    } finally {
      store.dispatch(branchesRemoved({ topicIds: [topicId] }))
    }
  })

  it('an in-flight guarded read resolving after a mutation ack keeps the ack catalog', async () => {
    const topicId = 't-ack-wins'
    const fresh = configureStore({ reducer: rootReducer })
    const { createBranchThunk, fetchTopicBranchesThunk } = await import('../messageThunk')

    mocks.createBranch.mockResolvedValueOnce({
      branch: { id: 'nb', anchorMessageId: 'm0' },
      messages: [],
      blocks: [],
      branches: [wire(topicId, 'nb', 'm0')]
    })
    const gate = deferred<{ branches: unknown[] }>()
    mocks.listBranches.mockImplementationOnce(() => gate.promise)
    const pendingFetch = (fresh.dispatch as any)(fetchTopicBranchesThunk(topicId))
    await flush()
    expect(mocks.listBranches).toHaveBeenCalledWith(topicId)

    // The mutation commits while the independent read is in flight: the ack
    // publish bumps the catalog revision, so the late loser must discard.
    const res = await createBranchThunk(topicId, null, 'm0', 'B2')(fresh.dispatch as any, fresh.getState as any)
    expect(res).not.toBeNull()

    gate.resolve({ branches: [wire(topicId, 'b-stale', 'm-stale')] })
    await pendingFetch

    expect(selectTopicBranches(fresh.getState() as any, topicId).map((b: { id: string }) => b.id)).toEqual(['nb'])
  })

  it('wrong-topic, malformed, missing, and duplicated ack catalogs keep the projection', async () => {
    const topicId = 't-ack-guard'
    const fresh = configureStore({ reducer: rootReducer })
    const { publishBranchCatalogAck } = await import('../messageThunk')

    fresh.dispatch(branchesReceived({ topicId, branches: [wire(topicId, 'b-keep', 'm-keep')] }) as never)
    const kept = () =>
      expect(selectTopicBranches(fresh.getState() as any, topicId).map((b: { id: string }) => b.id)).toEqual(['b-keep'])

    // Missing catalog.
    expect(publishBranchCatalogAck(fresh.dispatch as any, topicId, {})).toBe(false)
    kept()
    // Non-array catalog.
    expect(publishBranchCatalogAck(fresh.dispatch as any, topicId, { branches: 'nope' })).toBe(false)
    kept()
    // Foreign entry.
    expect(
      publishBranchCatalogAck(fresh.dispatch as any, topicId, { branches: [wire('t-foreign', 'b-x', 'm-x')] })
    ).toBe(false)
    kept()
    // Malformed entry (empty anchor).
    expect(
      publishBranchCatalogAck(fresh.dispatch as any, topicId, {
        branches: [{ id: 'b-x', topicId, parentBranchId: null, anchorMessageId: '' }]
      })
    ).toBe(false)
    kept()
    // Duplicated id.
    expect(
      publishBranchCatalogAck(fresh.dispatch as any, topicId, {
        branches: [wire(topicId, 'b-x', 'm-x'), wire(topicId, 'b-x', 'm-x')]
      })
    ).toBe(false)
    kept()
    // Wrong topic echo.
    expect(publishBranchCatalogAck(fresh.dispatch as any, topicId, { topicId: 't-other', branches: [] })).toBe(false)
    kept()
    // A valid ack still publishes after the rejections.
    expect(
      publishBranchCatalogAck(fresh.dispatch as any, topicId, { branches: [wire(topicId, 'b-new', 'm-new')] })
    ).toBe(true)
    expect(selectTopicBranches(fresh.getState() as any, topicId).map((b: { id: string }) => b.id)).toEqual(['b-new'])
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
