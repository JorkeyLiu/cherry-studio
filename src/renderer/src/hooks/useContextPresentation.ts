import { useContextClosure } from '@renderer/hooks/useContextClosure'
import { useLoadedTopicMessages } from '@renderer/hooks/useMessageOperations'
import { isAcceptedClosureForRoute } from '@renderer/services/contextClosure'
import { type ContextInfo, resolveSharedContextInfo } from '@renderer/services/contextInfoService'
import {
  getComposedOverlayBlocks,
  getExecutionOverlayVersion,
  routeKeyForExecutionOverlay,
  subscribeExecutionOverlay,
  tryHandoffAfterClosure
} from '@renderer/services/executionOverlayRegistry'
import { useAppSelector } from '@renderer/store'
import { selectMessageBlocksByIds } from '@renderer/store/messageBlock'
import type { Assistant } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { createSnapshotBlockMap, type SnapshotBlockMap } from '@renderer/utils/messageUtils/snapshotBlocks'
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { shallowEqual } from 'react-redux'

/**
 * Chat-scoped context presentation (route B).
 *
 * Single accepted model for one route: identity (topic/route/anchor) plus the
 * accepted full closure snapshot plus the execution-owned overlay. It drives
 * the same accepted result for counts/highlight/divider/token estimate:
 * - accepted closure: bodies come from the closure's own block snapshot
 *   (never from the ordinary `messageBlocks` hydration — that write path is
 *   exited), overlaid with execution bodies for accepted members only;
 * - cold/pending route: authority-pending with no viewport-count authority;
 *   the loaded projection supplies the pending snapshot only;
 * - empty/anchorless route: the legitimate bounded fallback.
 *
 * Identity fail-closed: a retained projection for another topic/route/anchor
 * never displays. Route leave releases the UI-held snapshot (unsubscribe)
 * without terminating the execution. New accepted closures attempt the
 * terminal handoff; failed revalidations retain the accepted projection.
 */
export function useContextPresentation(options: {
  topicId: string
  anchorGroupKey: string | null
  branchId?: string | null
  topicMessages: Message[]
  assistant: Assistant | undefined
}): {
  sharedContextInfo: ContextInfo
  blockSnapshot: SnapshotBlockMap
  freshClosure: ReturnType<typeof useContextClosure>['closure']
} {
  const { topicId, anchorGroupKey, branchId, topicMessages, assistant } = options
  const route = typeof branchId === 'string' && branchId.length > 0 ? branchId : null
  const routeKey = routeKeyForExecutionOverlay(topicId, route)

  const { closure: acceptedClosure } = useContextClosure(topicId, anchorGroupKey, route)

  const freshClosure = useMemo(() => {
    if (!acceptedClosure) return null
    if (!isAcceptedClosureForRoute(acceptedClosure, topicId, anchorGroupKey)) {
      return null
    }
    return acceptedClosure
  }, [acceptedClosure, topicId, anchorGroupKey])

  // Execution overlay subscription: route-scoped, version-bumped only by
  // executions on this route (throttle/RAF piggyback, no new timer).
  // The version is a real memo input below: an execution delta must recompose
  // the snapshot (same cadence as the streaming mirror, no new timer). While
  // the composed overlay content is unchanged the registry returns a stable
  // reference, so consumers never re-derive spuriously.
  const overlayVersion = useSyncExternalStore(
    (listener) => subscribeExecutionOverlay(routeKey, listener),
    () => getExecutionOverlayVersion(routeKey)
  )

  // Accepted member block ids (roster only — membership never comes from the overlay).
  const acceptedMemberBlockIds = useMemo(
    () => (freshClosure ? freshClosure.messages.flatMap((m: { blocks?: readonly string[] }) => m.blocks ?? []) : []),

    [freshClosure]
  )

  // Pending-path loaded snapshot only (no accepted closure): the loaded
  // topic's referenced blocks. Never used for authority, only to keep the
  // pending projection's explicit snapshot shape.
  const pendingBlockIds = useMemo(
    () => (freshClosure ? [] : topicMessages.flatMap((m) => m.blocks ?? [])),
    [freshClosure, topicMessages]
  )
  const pendingBlocks = useAppSelector((state) => selectMessageBlocksByIds(state, pendingBlockIds), shallowEqual)

  const blockSnapshot = useMemo(() => {
    if (!freshClosure) {
      return createSnapshotBlockMap(pendingBlocks)
    }
    const base = createSnapshotBlockMap((freshClosure.blocks ?? []) as never[])
    const overlay = getComposedOverlayBlocks(routeKey, acceptedMemberBlockIds)
    if (overlay.size === 0) return base
    const composed = new Map(base)
    for (const [blockId, block] of overlay) {
      if (base.has(blockId)) {
        composed.set(blockId, block)
      }
    }
    return composed
  }, [freshClosure, pendingBlocks, topicId, route, acceptedMemberBlockIds, overlayVersion])

  const sharedContextInfo = useMemo(
    () => resolveSharedContextInfo(topicMessages, assistant, topicId, freshClosure as never, branchId, blockSnapshot),
    [topicMessages, assistant, topicId, freshClosure, branchId, blockSnapshot]
  )

  // Terminal handoff: a newly accepted closure retires retained execution
  // overlays only when Main ordering proves it already contains them.
  useEffect(() => {
    if (freshClosure) {
      tryHandoffAfterClosure(topicId, route, freshClosure as never)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freshClosure])

  return { sharedContextInfo, blockSnapshot, freshClosure }
}

/** Loaded topic messages for the presentation input (stable empty identity while non-resident). */
export function usePresentationTopicMessages(topicId: string): Message[] {
  const loaded = useLoadedTopicMessages(topicId)
  return useMemo(() => (loaded ?? []) as Message[], [loaded])
}
