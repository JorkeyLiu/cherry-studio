/**
 * Delete-time branch catalog convergence.
 *
 * Main moves a branch's inheritance anchor to the nearest surviving
 * predecessor inside the same delete transaction (deleted anchor → boundary
 * before it). The renderer branch catalog is a Main projection, so a delete
 * that leaves the renderer copy holding the removed anchor id makes the fork
 * divider unplaceable: `findAnchorsWithChildren` only places a divider on a
 * message that is still displayed, so the divider silently disappears while
 * the branch itself stays reachable.
 *
 * This suite proves the shared semantic-delete convergence re-reads the
 * Main-authoritative catalog (advanced anchor) as part of the same post-commit
 * step, for the staged-cut source delete the edit-mode cut/paste gesture uses.
 */
import { configureStore } from '@reduxjs/toolkit'
import { rootReducer } from '@renderer/store'
import { branchesReceived, selectTopicBranches } from '@renderer/store/topicBranch'
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

const emptyDeleteResponse = (deletedMessageIds: string[]) => ({
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
  segmentSnapshots: []
})

const branchWire = (topicId: string, anchorMessageId: string) => ({
  id: `${topicId}-branch-1`,
  topicId,
  parentBranchId: null,
  anchorMessageId,
  name: 'B1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
})

describe('delete convergence refreshes the branch catalog after Main moves an anchor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('staged-cut source delete replaces the removed anchor with the Main-advanced anchor', async () => {
    const topicId = 't-anchor-advance'
    const removedAnchor = 'msg-anchor'
    const survivingPredecessor = 'msg-predecessor'
    const store = configureStore({ reducer: rootReducer })

    // Renderer projection before the delete: the branch is anchored on a
    // message that the upcoming cut removes.
    store.dispatch(branchesReceived({ topicId, branches: [branchWire(topicId, removedAnchor)] as any }))
    expect(selectTopicBranches(store.getState(), topicId)[0].anchorMessageId).toBe(removedAnchor)

    const { executeStagedCutSourceDelete } = await import('../messageThunk')
    mocks.deleteMessagesWithDependents.mockResolvedValue(emptyDeleteResponse([removedAnchor]))
    // Main already committed the boundary advance; listBranches is the only
    // authority the renderer projection may follow.
    mocks.listBranches.mockResolvedValue({
      branches: [branchWire(topicId, survivingPredecessor)],
      routeGeneration: 1
    })

    await executeStagedCutSourceDelete(store.dispatch, store.getState as any, {
      sourceTopicId: topicId,
      sourceBranchId: null,
      rootIds: [removedAnchor],
      sourceProjection: { sourceTopicId: topicId, sourceBranchId: null, loadedMessageIds: [removedAnchor] }
    })

    expect(mocks.listBranches).toHaveBeenCalledExactlyOnceWith(topicId)
    const catalog = selectTopicBranches(store.getState(), topicId)
    expect(catalog).toHaveLength(1)
    // Stale removed anchor is gone; the divider can attach to a displayed message.
    expect(catalog[0].anchorMessageId).toBe(survivingPredecessor)
  })

  it('keeps the catalog when Main reports no boundary move', async () => {
    const topicId = 't-anchor-unchanged'
    const anchor = 'msg-anchor'
    const store = configureStore({ reducer: rootReducer })
    store.dispatch(branchesReceived({ topicId, branches: [branchWire(topicId, anchor)] as any }))

    const { executeStagedCutSourceDelete } = await import('../messageThunk')
    mocks.deleteMessagesWithDependents.mockResolvedValue(emptyDeleteResponse(['msg-other']))
    mocks.listBranches.mockResolvedValue({ branches: [branchWire(topicId, anchor)], routeGeneration: 1 })

    await executeStagedCutSourceDelete(store.dispatch, store.getState as any, {
      sourceTopicId: topicId,
      sourceBranchId: null,
      rootIds: ['msg-other'],
      sourceProjection: { sourceTopicId: topicId, sourceBranchId: null, loadedMessageIds: ['msg-other'] }
    })

    expect(mocks.listBranches).toHaveBeenCalledExactlyOnceWith(topicId)
    expect(selectTopicBranches(store.getState(), topicId)[0].anchorMessageId).toBe(anchor)
  })
})
