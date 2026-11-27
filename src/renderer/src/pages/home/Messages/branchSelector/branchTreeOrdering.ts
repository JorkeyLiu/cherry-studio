import type { TopicBranchWire } from '@renderer/services/db/types'

import { BRANCH_TREE_ROOT_ID, type BranchTreeIndex } from './branchTreeModel'

/** Message-position ranks keyed by parent route (null is the main route). */
export type BranchAnchorRanks = ReadonlyMap<string | null, ReadonlyMap<string, number>>

/**
 * Presentation adapter for the top selector's sibling order.
 *
 * The tree builder remains the owner of grouping and route structure. This
 * layer only replaces each existing child list with a message-position order,
 * using the original catalog position for equal or unavailable ranks.
 */
export function orderBranchTreeIndexByAnchorRanks(
  index: BranchTreeIndex,
  branches: readonly TopicBranchWire[],
  ranks?: BranchAnchorRanks
): BranchTreeIndex {
  const catalogPosition = new Map<string, number>()
  branches.forEach((branch, position) => {
    if (!catalogPosition.has(branch.id)) catalogPosition.set(branch.id, position)
  })

  const childrenOf = new Map<string, TopicBranchWire[]>()
  index.childrenOf.forEach((children, parentKey) => {
    const parentBranchId = parentKey === BRANCH_TREE_ROOT_ID ? null : parentKey
    const routeRanks = ranks?.get(parentBranchId)
    const ordered = [...children].sort((a, b) => {
      const aRank = routeRanks?.get(a.anchorMessageId)
      const bRank = routeRanks?.get(b.anchorMessageId)
      if (aRank !== undefined && bRank !== undefined) {
        if (aRank !== bRank) return aRank - bRank
      } else if (aRank !== undefined) {
        return -1
      } else if (bRank !== undefined) {
        return 1
      }
      return (
        (catalogPosition.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (catalogPosition.get(b.id) ?? Number.MAX_SAFE_INTEGER)
      )
    })
    childrenOf.set(parentKey, ordered)
  })

  return { ...index, childrenOf }
}
