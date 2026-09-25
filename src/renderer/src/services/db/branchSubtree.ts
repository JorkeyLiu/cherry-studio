import { loggerService } from '@logger'
import store from '@renderer/store'
import { activeBranchReset, activeBranchSet, branchesReceived } from '@renderer/store/topicBranch'

import { dbService } from './DbService'

const logger = loggerService.withContext('branchSubtree')

function readCatalog(topicId: string): Array<{ id: string; parentBranchId: string | null }> {
  const state = store.getState() as unknown as {
    topicBranch?: { branchesByTopic?: Record<string, Array<{ id: string; parentBranchId: string | null }>> }
  }
  return state.topicBranch?.branchesByTopic?.[topicId] ?? []
}

/**
 * Delete one branch subtree (selected branch + descendants + only their
 * owned messages/blocks/file references) in one Main transaction, then
 * converge the renderer projection. Shared prefixes and sibling branches
 * survive in Main; the catalog refresh below reflects exactly that.
 *
 * The logical topic, sidebar selection, and topic identity are untouched
 * (same topicId throughout). When the active route was deleted, the route
 * falls back to the nearest surviving ancestor (parent first, else main)
 * and the caller reloads that route. After deleting the last branch the
 * topic is indistinguishable from a never-branched topic.
 *
 * @returns The deleted branch IDs (subtree-root first) plus the fallback
 * route the caller should activate.
 */
export async function deleteBranchSubtree(
  topicId: string,
  branchId: string,
  activeBranchId: string | null
): Promise<{ deletedBranchIds: string[]; fallbackBranchId: string | null }> {
  // Capture the parent chain BEFORE deletion for fallback routing.
  const before = readCatalog(topicId)
  const beforeById = new Map(before.map((b) => [b.id, b]))
  const result = await dbService.deleteBranch(topicId, branchId)
  const deleted = new Set(result.deletedBranchIds)
  // Refresh the Main-authoritative catalog first (it prunes a stale active
  // branch automatically when it no longer exists).
  try {
    const catalog = await dbService.listBranches(topicId)
    store.dispatch(branchesReceived({ topicId, branches: catalog.branches }))
  } catch (error) {
    logger.error(`[deleteBranchSubtree] Failed to refresh branch catalog for ${topicId}:`, error as Error)
  }
  const wasActiveDeleted = activeBranchId !== null && deleted.has(activeBranchId)
  let fallback: string | null = null
  if (wasActiveDeleted) {
    // Walk up from the deleted active branch to the nearest survivor
    // (parent first, else main — main always contains every anchor).
    let current: string | null = beforeById.get(activeBranchId)?.parentBranchId ?? null
    while (current !== null && deleted.has(current)) {
      current = beforeById.get(current)?.parentBranchId ?? null
    }
    fallback = current
    if (fallback === null) {
      store.dispatch(activeBranchReset({ topicId }))
    } else {
      store.dispatch(activeBranchSet({ topicId, branchId: fallback }))
    }
  } else if (activeBranchId !== null && !deleted.has(activeBranchId)) {
    fallback = activeBranchId
  } else {
    fallback = null
    if (activeBranchId !== null) {
      store.dispatch(activeBranchReset({ topicId }))
    }
  }
  return { deletedBranchIds: result.deletedBranchIds, fallbackBranchId: fallback }
}
