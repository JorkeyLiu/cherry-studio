import { loggerService } from '@logger'
import { handleScrollSnapshotCleared } from '@renderer/services/scrollSnapshotCache'
import store from '@renderer/store'
import {
  activeBranchReset,
  activeBranchSet,
  branchesReceived,
  deletionFallbackRequested
} from '@renderer/store/topicBranch'

import { dbService } from './DbService'

const logger = loggerService.withContext('branchSubtree')

/**
 * Remove route-keyed scroll snapshots for deleted branch routes so a stale
 * deleted-route snapshot (or its throttle-flush recreation) can never feed a
 * later `around` window choice. Best-effort, renderer-local only. The
 * fallback route's own snapshot is intentionally preserved: the deletion
 * recovery bypasses it once with an explicit `latest` read, while future
 * normal top-selector switches still restore the saved history position.
 */
function clearDeletedRouteSnapshots(topicId: string, deletedBranchIds: readonly string[]): void {
  if (!Array.isArray(deletedBranchIds) || deletedBranchIds.length === 0) return
  if (typeof topicId !== 'string' || topicId.length === 0) return
  for (const branchId of deletedBranchIds) {
    if (typeof branchId !== 'string' || branchId.length === 0) continue
    const key = `scroll:topic-${topicId}::${branchId}`
    try {
      const keyv =
        typeof window !== 'undefined'
          ? (window as unknown as { keyv?: { remove?: (k: string) => unknown } })?.keyv
          : undefined
      keyv?.remove?.(key)
    } catch {
      // best-effort
    }
    try {
      handleScrollSnapshotCleared(key)
    } catch {
      // best-effort
    }
  }
}

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
    // Explicit one-shot deletion-fallback intent for the Messages route owner:
    // the fallback route must reload with a `latest` window, never the generic
    // snapshot-around path. Emitted together with the active-fallback switch
    // above so both delete entries share one helper. Deleted-route snapshots
    // are dropped here (the Messages owner repeats the drop after the key
    // change to cover throttle-flush recreation); the fallback route's own
    // snapshot is preserved for future normal switches.
    clearDeletedRouteSnapshots(topicId, result.deletedBranchIds)
    store.dispatch(
      deletionFallbackRequested({ topicId, route: fallback, deletedBranchIds: [...result.deletedBranchIds] })
    )
  } else if (activeBranchId !== null && !deleted.has(activeBranchId)) {
    fallback = activeBranchId
    // Non-active subtree deleted while the active route stays: descendant
    // protection may have shrunk, so the resident capability may be stale
    // (hiding actions that are now valid). Invalidate immediately
    // (fail-closed) and reload capability around the current loaded anchor
    // to retain the browsing position window — never a full reload.
    try {
      const { newMessagesActions } = await import('@renderer/store/newMessage')
      store.dispatch(newMessagesActions.invalidateRouteMutability({ topicId }))
    } catch {
      // best-effort invalidation; reload below still refreshes
    }
    try {
      const state = store.getState() as unknown as {
        messages?: { messageIdsByTopic?: Record<string, string[]> }
      }
      const loaded = state.messages?.messageIdsByTopic?.[topicId] ?? []
      const anchor = loaded.length > 0 ? loaded[Math.floor(loaded.length / 2)] : null
      if (typeof anchor === 'string' && anchor.length > 0) {
        const { loadRouteMessagesThunk } = await import('@renderer/store/thunk/messageThunk')
        await (store.dispatch as unknown as (a: unknown) => Promise<unknown>)(
          loadRouteMessagesThunk(topicId, activeBranchId, {
            kind: 'around',
            anchorMessageId: anchor,
            before: 10,
            after: 19
          }) as unknown as never
        )
      }
    } catch (error) {
      logger.error(`[deleteBranchSubtree] Failed to reload active-route capability for ${topicId}:`, error as Error)
    }
  } else {
    fallback = null
    if (activeBranchId !== null) {
      store.dispatch(activeBranchReset({ topicId }))
    }
  }
  return { deletedBranchIds: result.deletedBranchIds, fallbackBranchId: fallback }
}
