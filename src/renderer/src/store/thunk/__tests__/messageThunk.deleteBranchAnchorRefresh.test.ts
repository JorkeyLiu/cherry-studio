/**
 * Delete-time branch catalog convergence.
 *
 * Main moves a branch's inheritance anchor to the nearest surviving
 * predecessor inside the same delete transaction, and the resulting catalog
 * rides that transaction's acknowledgment. The renderer branch catalog is a
 * Main projection, so the acknowledgment publishes it directly: no follow-up
 * listBranches for the semantic delete path. Stale in-flight fetches (or an
 * older same-topic fetch resolving late) must never overwrite a newer
 * authority catalog.
 *
 * Real Redux store + real thunk. Only the data source, cleanup, and anchor
 * transfer are mocked.
 */
import { configureStore } from '@reduxjs/toolkit'
import { rootReducer } from '@renderer/store'
import { fetchTopicBranchesThunk } from '@renderer/store/thunk/messageThunk'
import { branchesReceived, selectCatalogRevision, selectTopicBranches } from '@renderer/store/topicBranch'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    deleteMessagesWithDependents: vi.fn(),
    listBranches: vi.fn(),
    consumeFileCleanupResult: vi.fn(async () => {}),
    transferAnchorsWithAuthorityGroupKeys: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    deleteMessagesWithDependents: mocks.deleteMessagesWithDependents,
    listBranches: mocks.listBranches
  }
}))
vi.mock('@renderer/services/db/topicTrashLifecycle', () => ({
  consumeFileCleanupResult: mocks.consumeFileCleanupResult
}))
vi.mock('@renderer/services/anchorService', () => ({
  transferAnchorsWithAuthorityGroupKeys: mocks.transferAnchorsWithAuthorityGroupKeys,
  buildGroupList: vi.fn(() => []),
  transferAnchorsAfterDeletion: vi.fn()
}))
vi.mock('@renderer/store/thunk/topicSegmentThunk', () => ({ loadTopicSegmentsThunk: vi.fn() }))
vi.mock('@renderer/utils/queue', () => ({ getTopicQueue: () => ({ add: vi.fn() }), waitForTopicQueue: vi.fn() }))
vi.mock('@renderer/utils/abortController', () => ({ addAbortController: vi.fn() }))
vi.mock('swr', () => ({ mutate: vi.fn() }))
vi.mock('i18next', () => ({
  default: { use: vi.fn().mockReturnThis(), init: vi.fn(), t: (k: string) => k },
  t: (k: string) => k
}))

const emptyDeleteResponse = (topicId: string, deletedMessageIds: string[], anchorMessageId: string) => ({
  topicId,
  branchId: null,
  branches: [branchWire(topicId, anchorMessageId)],
  affectedFileIds: [],
  remainingReferenceCounts: {},
  deletedMessageIds,
  deletedBlockIds: [],
  previousUserMessageIds: [],
  remainingUserMessageIds: [],
  segments: [],
  restoreGroups: [
    {
      messages: [],
      blocks: [],
      entries: [],
      positionIndex: 0,
      anchorMessageId: null
    }
  ],
  segmentSnapshots: [],
  boundarySnapshots: []
})

const branchWire = (topicId: string, anchorMessageId: string) => ({
  id: `${topicId}-branch-1`,
  topicId,
  parentBranchId: null,
  anchorMessageId,
  inheritedBoundary: { kind: 'message', messageId: anchorMessageId },
  name: 'B1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('delete convergence publishes the ack catalog without a follow-up list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('staged-cut source delete replaces the removed anchor from the ack and lists nothing', async () => {
    const topicId = 't-anchor-advance'
    const removedAnchor = 'msg-anchor'
    const survivingPredecessor = 'msg-predecessor'
    const store = configureStore({ reducer: rootReducer })

    // Renderer projection before the delete: the branch is anchored on a
    // message that the upcoming cut removes.
    store.dispatch(branchesReceived({ topicId, branches: [branchWire(topicId, removedAnchor)] as any }))
    expect(selectTopicBranches(store.getState(), topicId)[0].anchorMessageId).toBe(removedAnchor)

    const { executeStagedCutSourceDelete } = await import('../messageThunk')
    mocks.deleteMessagesWithDependents.mockResolvedValue(
      emptyDeleteResponse(topicId, [removedAnchor], survivingPredecessor)
    )

    await executeStagedCutSourceDelete(store.dispatch, store.getState as any, {
      sourceTopicId: topicId,
      sourceBranchId: null,
      rootIds: [removedAnchor],
      sourceProjection: { sourceTopicId: topicId, sourceBranchId: null, loadedMessageIds: [removedAnchor] }
    })

    // No supplementary catalog read: the ack already carried the complete catalog.
    expect(mocks.listBranches).not.toHaveBeenCalled()
    const catalog = selectTopicBranches(store.getState(), topicId)
    expect(catalog).toHaveLength(1)
    // Stale removed anchor is gone; the divider can attach to a displayed message.
    expect(catalog[0].anchorMessageId).toBe(survivingPredecessor)
  })

  it('keeps the catalog from the ack when Main reports no boundary move', async () => {
    const topicId = 't-anchor-unchanged'
    const anchor = 'msg-anchor'
    const store = configureStore({ reducer: rootReducer })
    store.dispatch(branchesReceived({ topicId, branches: [branchWire(topicId, anchor)] as any }))

    const { executeStagedCutSourceDelete } = await import('../messageThunk')
    mocks.deleteMessagesWithDependents.mockResolvedValue(emptyDeleteResponse(topicId, ['msg-other'], anchor))

    await executeStagedCutSourceDelete(store.dispatch, store.getState as any, {
      sourceTopicId: topicId,
      sourceBranchId: null,
      rootIds: ['msg-other'],
      sourceProjection: { sourceTopicId: topicId, sourceBranchId: null, loadedMessageIds: ['msg-other'] }
    })

    expect(mocks.listBranches).not.toHaveBeenCalled()
    expect(selectTopicBranches(store.getState(), topicId)[0].anchorMessageId).toBe(anchor)
  })

  it('an in-flight fetch resolving after an authority publish never overwrites it', async () => {
    const topicId = 't-stale-fetch'
    const store = configureStore({ reducer: rootReducer })
    store.dispatch(branchesReceived({ topicId, branches: [branchWire(topicId, 'm-old')] as any }))

    const gate = deferred<{ branches: unknown[] }>()
    mocks.listBranches.mockReturnValueOnce(gate.promise)
    const pending = store.dispatch(fetchTopicBranchesThunk(topicId) as any)

    // Authority publish lands while the fetch is in flight.
    store.dispatch(branchesReceived({ topicId, branches: [branchWire(topicId, 'm-new')] as any }))
    const revisionAfterAuthority = selectCatalogRevision(store.getState() as any, topicId)

    gate.resolve({ branches: [branchWire(topicId, 'm-old')] })
    await pending

    expect(selectCatalogRevision(store.getState() as any, topicId)).toBe(revisionAfterAuthority)
    expect(selectTopicBranches(store.getState(), topicId)[0].anchorMessageId).toBe('m-new')
  })

  it('same-topic concurrent fetches resolve in order: the late loser discards', async () => {
    const topicId = 't-fetch-order'
    const store = configureStore({ reducer: rootReducer })

    const first = deferred<{ branches: unknown[] }>()
    const second = deferred<{ branches: unknown[] }>()
    mocks.listBranches.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const pendingFirst = store.dispatch(fetchTopicBranchesThunk(topicId) as any)
    const pendingSecond = store.dispatch(fetchTopicBranchesThunk(topicId) as any)

    // Newer fetch resolves first and publishes.
    second.resolve({ branches: [branchWire(topicId, 'm-second')] })
    await pendingSecond
    expect(selectTopicBranches(store.getState(), topicId)[0].anchorMessageId).toBe('m-second')

    // Older fetch resolving late must not overwrite the newer catalog.
    first.resolve({ branches: [branchWire(topicId, 'm-first')] })
    await pendingFirst
    expect(selectTopicBranches(store.getState(), topicId)[0].anchorMessageId).toBe('m-second')
  })
})
