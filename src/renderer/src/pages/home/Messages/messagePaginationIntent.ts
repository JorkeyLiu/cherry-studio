/**
 * Pending older-edge pagination intent (InfiniteScroll latch fix).
 *
 * `react-infinite-scroll-component` locks its internal `actionTriggered` when
 * `next` fires without a `dataLength` change. `loadMoreMessages` used to drop
 * that call when the viewport was temporarily non-user (`navigation` active
 * or `scrollMode` anchoring/programmatic for divider/top restores), so the
 * latch never released and later scrolls never retried.
 *
 * This module records a route/topic/generation-bound intent when `next` is
 * dropped for temporary ownership reasons, and decides a single replay once
 * the committed viewport returns to `navigation idle + scrollMode user`.
 * Route/topic/deletion/resident generation changes discard. Successful
 * replay, missing `hasMore`, leaving the oldest edge, and request failure all
 * clear (replay clears before starting, so at most once). The existing
 * `loading.older` guard still prevents duplicates.
 *
 * Replay must read the *committed* viewport state (effect input), never a
 * stale `viewportStateRef` captured before `scroll/end`, otherwise a
 * user-cancelled stabilizer would early-return again.
 */

import { isAtOldest } from './columnReverseGeometry'
import { canHandleUserViewportScroll } from './messageNavigation'
import type { MessageViewportState } from './messageViewportReducer'
import type { PreferredRestoreAnchorSnapshot } from './routeRestoreAnchor'

export interface PendingOlderEdgeIntent {
  topicId: string
  routeId: string | null
  topicGeneration: number
  deletionGeneration: number
  residentGeneration: number
  /**
   * Detached preferred-anchor snapshot (stable identity + targetOffset only,
   * never a live ref). Copied at queue time from the active route-restore
   * anchor; null/undefined for ordinary user pagination (behavior unchanged).
   * The existing five-tuple guard above still prevents cross-generation use.
   */
  preferredAnchor?: PreferredRestoreAnchorSnapshot | null
}

export interface PendingOlderEdgeLive {
  topicId: string
  routeId: string | null
  topicGeneration: number
  deletionGeneration: number
  residentGeneration: number
  hasMoreOlder: boolean
  loadingOlder: boolean
}

export type PendingOlderDiscardReason =
  | 'route'
  | 'topic'
  | 'topic-generation'
  | 'deletion'
  | 'resident'
  | 'has-more'
  | 'loading'
  | 'not-user'
  | 'left-oldest'

/**
 * Decide whether an InfiniteScroll `next` call dropped for temporary scroll
 * ownership should be queued. Only the non-user gate qualifies: missing
 * `hasMore` or an active load are steady states, never queued.
 */
export const shouldQueueOlderIntent = (
  state: Pick<MessageViewportState, 'navigation' | 'scrollMode'> & {
    window?: { hasMoreOlder?: boolean } | null
    loading?: { older?: boolean }
  }
): boolean => {
  if (!state.window?.hasMoreOlder) return false
  if (state.loading?.older) return false
  return !canHandleUserViewportScroll(state)
}

export const createPendingOlderIntent = (live: {
  topicId: string
  routeId: string | null
  topicGeneration: number
  deletionGeneration: number
  residentGeneration: number
  preferredAnchor?: PreferredRestoreAnchorSnapshot | null
}): PendingOlderEdgeIntent => ({
  topicId: live.topicId,
  routeId: live.routeId,
  topicGeneration: live.topicGeneration,
  deletionGeneration: live.deletionGeneration,
  residentGeneration: live.residentGeneration,
  // Detached value copy: stable identity + targetOffset only, never the live
  // anchor ref/object, so clearing the active anchor cannot mutate the queue.
  preferredAnchor: live.preferredAnchor
    ? live.preferredAnchor.kind === 'divider-row'
      ? {
          kind: 'divider-row',
          dividerKey: live.preferredAnchor.dividerKey,
          targetOffset: live.preferredAnchor.targetOffset
        }
      : {
          kind: 'message-row',
          messageId: live.preferredAnchor.messageId,
          targetOffset: live.preferredAnchor.targetOffset
        }
    : null
})

/**
 * Pure discard/replay decision against the *committed* viewport state.
 * Returns `{ action: 'replay' }` only when every binding still matches, the
 * viewport is user-idle, `hasMoreOlder` holds, no load is active, and the
 * container still rests at the oldest edge. Otherwise returns keep (still
 * blocked on loading/user) or discard with the reason.
 */
export const decidePendingOlderReplay = (args: {
  pending: PendingOlderEdgeIntent
  live: PendingOlderEdgeLive
  committed: Pick<MessageViewportState, 'navigation' | 'scrollMode' | 'topicGeneration'>
  atOldestEdge: boolean
}): { action: 'replay' } | { action: 'keep' } | { action: 'discard'; reason: PendingOlderDiscardReason } => {
  const { pending, live, committed } = args
  if (live.topicId !== pending.topicId) return { action: 'discard', reason: 'topic' }
  if (live.routeId !== pending.routeId) return { action: 'discard', reason: 'route' }
  if (live.topicGeneration !== pending.topicGeneration || committed.topicGeneration !== pending.topicGeneration) {
    return { action: 'discard', reason: 'topic-generation' }
  }
  if (live.deletionGeneration !== pending.deletionGeneration) return { action: 'discard', reason: 'deletion' }
  if (live.residentGeneration !== pending.residentGeneration) return { action: 'discard', reason: 'resident' }
  if (!live.hasMoreOlder) return { action: 'discard', reason: 'has-more' }
  if (live.loadingOlder) return { action: 'keep' }
  if (!canHandleUserViewportScroll(committed)) return { action: 'keep' }
  if (!args.atOldestEdge) return { action: 'discard', reason: 'left-oldest' }
  return { action: 'replay' }
}

/** Oldest-edge check for the committed container geometry (single call-site helper). */
export const isStillAtOldestEdge = (
  container: { scrollTop: number; scrollHeight: number; clientHeight: number } | null | undefined,
  thresholdPx?: number
): boolean => {
  if (!container) return true
  return isAtOldest(
    { scrollTop: container.scrollTop, scrollHeight: container.scrollHeight, clientHeight: container.clientHeight },
    thresholdPx
  )
}
