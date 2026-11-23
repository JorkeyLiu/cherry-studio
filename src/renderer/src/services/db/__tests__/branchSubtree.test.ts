import { beforeEach, describe, expect, it, vi } from 'vitest'

const { dispatchMock, listBranchesMock, deleteBranchMock, refreshMock, loadRouteMock, publishMock } = vi.hoisted(() => {
  const dispatchMock = vi.fn()
  const listBranchesMock: ReturnType<typeof vi.fn> = vi.fn()
  const deleteBranchMock = vi.fn()
  const refreshMock = vi.fn(async (dispatch: (a: unknown) => unknown, _getState: unknown, topicId: string) => {
    const catalog = (await listBranchesMock(topicId)) as { branches: unknown[] }
    dispatch({ type: 'topicBranch/branchesReceived', payload: { topicId, branches: catalog.branches } })
    return true
  })
  const loadRouteMock = vi.fn(() => ({ type: 'stub/routeLoad' }))
  // Faithful stand-in for the real `publishBranchCatalogAck` (whose own
  // fail-closed semantics are covered with the real helper in
  // messageThunk.catalogRefreshGuard.test.ts): publishes the ack catalog it
  // is handed, so these tests prove the helper passes the mutation ack
  // through and performs no follow-up read.
  const publishMock = vi.fn(
    (dispatch: (a: unknown) => unknown, topicId: string, ack: { topicId?: unknown; branches?: unknown }) => {
      dispatch({ type: 'topicBranch/branchesReceived', payload: { topicId, branches: ack.branches } })
      return true
    }
  )
  return { dispatchMock, listBranchesMock, deleteBranchMock, refreshMock, loadRouteMock, publishMock }
})

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => ({
      topicBranch: {
        branchesByTopic: {
          't-1': [
            { id: 'b-1', parentBranchId: null },
            { id: 'b-2', parentBranchId: 'b-1' }
          ]
        }
      }
    }),
    dispatch: (...args: unknown[]) => {
      dispatchMock(...args)
      return args[0]
    }
  }
}))

vi.mock('@renderer/store/topicBranch', () => ({
  activeBranchReset: (payload: unknown) => ({ type: 'topicBranch/activeBranchReset', payload }),
  activeBranchSet: (payload: unknown) => ({ type: 'topicBranch/activeBranchSet', payload }),
  branchesReceived: (payload: unknown) => ({ type: 'topicBranch/branchesReceived', payload }),
  deletionFallbackRequested: (payload: unknown) => ({ type: 'topicBranch/deletionFallbackRequested', payload }),
  deletionFallbackConsumed: (payload: unknown) => ({ type: 'topicBranch/deletionFallbackConsumed', payload })
}))

vi.mock('../DbService', () => ({
  dbService: {
    listBranches: (...args: unknown[]) => listBranchesMock(...args),
    deleteBranch: (...args: unknown[]) => deleteBranchMock(...args)
  }
}))

vi.mock('@renderer/store/thunk/messageThunk', () => ({
  refreshBranchCatalogGuarded: (...args: unknown[]) => (refreshMock as (...a: unknown[]) => unknown)(...args),
  publishBranchCatalogAck: (...args: unknown[]) => (publishMock as (...a: unknown[]) => unknown)(...args),
  loadRouteMessagesThunk: (...args: unknown[]) => (loadRouteMock as (...a: unknown[]) => unknown)(...args)
}))

import { deleteBranchSubtree } from '../branchSubtree'

/**
 * Delete result as Main reports it: the branch delete returns its own authority
 * snapshot alongside the removed IDs (branch undo/redo replay payload) plus
 * the complete post-commit catalog (topicId + branches) from the same
 * transaction.
 */
const deleteResult = (
  deletedBranchIds: string[],
  branches: Array<{ id: string; parentBranchId: string | null; anchorMessageId: string }> = []
) => ({
  topicId: 't-1',
  affectedFileIds: [] as string[],
  remainingReferenceCounts: {} as Record<string, number>,
  deletedBranchIds,
  deletedMessageIds: [] as string[],
  deletedBlockIds: [] as string[],
  branches: branches.map((b) => ({ ...b, topicId: 't-1' })),
  historySnapshot: {
    kind: 'delete' as const,
    rootBranchId: deletedBranchIds[0],
    branches: deletedBranchIds.map((id, index) => ({
      id,
      parentBranchId: index === 0 ? null : deletedBranchIds[0],
      anchorMessageId: `m-${id}`,
      name: null,
      createdAt: null,
      updatedAt: null,
      overflow: {}
    })),
    messages: [],
    blocks: [],
    fileReferences: [],
    segments: [],
    segmentOrder: [],
    boundaries: []
  }
})

describe('deleteBranchSubtree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listBranchesMock.mockResolvedValue({ topicId: 't-1', branches: [] })
  })

  it('deletes one branch subtree in Main, publishes the ack catalog, and falls back to the nearest surviving ancestor', async () => {
    const ackBranches = [{ id: 'b-3', parentBranchId: null, anchorMessageId: 'm-b3' }]
    const ack = deleteResult(['b-1', 'b-2'], ackBranches)
    deleteBranchMock.mockResolvedValue(ack)
    const result = await deleteBranchSubtree('t-1', 'b-1', 'b-2')
    expect(deleteBranchMock).toHaveBeenCalledWith('t-1', 'b-1')
    expect(result.deletedBranchIds).toEqual(['b-1', 'b-2'])
    // Active route was deleted: parent b-1 also deleted -> fallback is main (null).
    expect(result.fallbackBranchId).toBeNull()
    // No follow-up read: the ack catalog publishes directly.
    expect(listBranchesMock).not.toHaveBeenCalled()
    expect(refreshMock).not.toHaveBeenCalled()
    expect(publishMock).toHaveBeenCalledWith(expect.anything(), 't-1', ack)
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'topicBranch/branchesReceived',
        payload: { topicId: 't-1', branches: ack.branches }
      })
    )
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'topicBranch/activeBranchReset' }))
  })

  it('keeps the active route when it survives outside the deleted subtree', async () => {
    const ack = deleteResult(
      ['b-9'],
      [
        { id: 'b-1', parentBranchId: null, anchorMessageId: 'm-b1' },
        { id: 'b-2', parentBranchId: 'b-1', anchorMessageId: 'm-b2' }
      ]
    )
    deleteBranchMock.mockResolvedValue(ack)
    const result = await deleteBranchSubtree('t-1', 'b-9', 'b-2')
    expect(result.fallbackBranchId).toBe('b-2')
    expect(listBranchesMock).not.toHaveBeenCalled()
    expect(refreshMock).not.toHaveBeenCalled()
    expect(publishMock).toHaveBeenCalledWith(expect.anything(), 't-1', ack)
    expect(dispatchMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'topicBranch/activeBranchReset' }))
  })

  it('deleting the last branch restores the never-branched state (fallback main)', async () => {
    const ack = deleteResult(['b-1'], [{ id: 'b-2', parentBranchId: null, anchorMessageId: 'm-b2' }])
    deleteBranchMock.mockResolvedValue(ack)
    const result = await deleteBranchSubtree('t-1', 'b-1', 'b-1')
    expect(result.fallbackBranchId).toBeNull()
    expect(listBranchesMock).not.toHaveBeenCalled()
    expect(refreshMock).not.toHaveBeenCalled()
    expect(publishMock).toHaveBeenCalledWith(expect.anything(), 't-1', ack)
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'topicBranch/activeBranchReset' }))
  })
})
