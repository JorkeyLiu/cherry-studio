import { beforeEach, describe, expect, it, vi } from 'vitest'

const { dispatchMock, listBranchesMock, deleteBranchMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  listBranchesMock: vi.fn(),
  deleteBranchMock: vi.fn()
}))

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
  branchesReceived: (payload: unknown) => ({ type: 'topicBranch/branchesReceived', payload })
}))

vi.mock('../DbService', () => ({
  dbService: {
    listBranches: (...args: unknown[]) => listBranchesMock(...args),
    deleteBranch: (...args: unknown[]) => deleteBranchMock(...args)
  }
}))

import { deleteBranchSubtree } from '../branchSubtree'

describe('deleteBranchSubtree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listBranchesMock.mockResolvedValue({ topicId: 't-1', branches: [] })
  })

  it('deletes one branch subtree in Main, refreshes the catalog, and falls back to the nearest surviving ancestor', async () => {
    deleteBranchMock.mockResolvedValue({ deletedBranchIds: ['b-1', 'b-2'] })
    const result = await deleteBranchSubtree('t-1', 'b-1', 'b-2')
    expect(deleteBranchMock).toHaveBeenCalledWith('t-1', 'b-1')
    expect(result.deletedBranchIds).toEqual(['b-1', 'b-2'])
    // Active route was deleted: parent b-1 also deleted -> fallback is main (null).
    expect(result.fallbackBranchId).toBeNull()
    expect(listBranchesMock).toHaveBeenCalledWith('t-1')
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'topicBranch/branchesReceived' }))
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'topicBranch/activeBranchReset' }))
  })

  it('keeps the active route when it survives outside the deleted subtree', async () => {
    deleteBranchMock.mockResolvedValue({ deletedBranchIds: ['b-9'] })
    const result = await deleteBranchSubtree('t-1', 'b-9', 'b-2')
    expect(result.fallbackBranchId).toBe('b-2')
    expect(dispatchMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'topicBranch/activeBranchReset' }))
  })

  it('deleting the last branch restores the never-branched state (fallback main)', async () => {
    deleteBranchMock.mockResolvedValue({ deletedBranchIds: ['b-1'] })
    const result = await deleteBranchSubtree('t-1', 'b-1', 'b-1')
    expect(result.fallbackBranchId).toBeNull()
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'topicBranch/activeBranchReset' }))
  })
})
