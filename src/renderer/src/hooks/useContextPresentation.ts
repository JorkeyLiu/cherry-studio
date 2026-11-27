import { useContextClosure } from '@renderer/hooks/useContextClosure'
import { useLoadedTopicMessages } from '@renderer/hooks/useMessageOperations'
import { isAcceptedClosureForRoute } from '@renderer/services/contextClosure'
import { type ContextInfo, resolveSharedContextInfo } from '@renderer/services/contextInfoService'
import { getClosureReadReceipt } from '@renderer/services/executionOverlayReadReceipt'
import {
  getComposedOverlayBlocks,
  getExecutionOverlayVersion,
  routeKeyForExecutionOverlay,
  subscribeExecutionOverlay,
  tryHandoffAfterClosure
} from '@renderer/services/executionOverlayRegistry'
import type { Assistant } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { createSnapshotBlockMap } from '@renderer/utils/messageUtils/snapshotBlocks'
import { useEffect, useMemo, useSyncExternalStore } from 'react'

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
 *   pending carries no block snapshot (the derivation default empty Map);
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

  // Accepted base hydration (level 1): snapshot bodies from the closure's own
  // blocks only. Depends on the stable blocks input alone, so execution
  // overlay version bumps never re-hydrate it.
  const acceptedBase = useMemo(
    () => (freshClosure ? createSnapshotBlockMap((freshClosure.blocks ?? []) as unknown as never[]) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [freshClosure?.blocks]
  )

  const blockSnapshot = useMemo(() => {
    if (!acceptedBase) {
      // Pending: no snapshot from the ordinary store. The shared derivation
      // defaults a missing snapshot to an empty Map; pending lists are empty
      // so no consumer reads through it.
      return undefined
    }
    const overlay = getComposedOverlayBlocks(routeKey, acceptedMemberBlockIds)
    if (overlay.size === 0) return acceptedBase
    const composed = new Map(acceptedBase)
    for (const [blockId, block] of overlay) {
      if (acceptedBase.has(blockId)) {
        composed.set(blockId, block)
      }
    }
    return composed
    // overlayVersion is a real memo input: an execution delta must recompose
    // the snapshot (same cadence as the streaming mirror, no new timer).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acceptedBase, routeKey, acceptedMemberBlockIds, overlayVersion])

  const sharedContextInfo = useMemo(
    () => resolveSharedContextInfo(topicMessages, assistant, topicId, freshClosure as never, branchId, blockSnapshot),
    [topicMessages, assistant, topicId, freshClosure, branchId, blockSnapshot]
  )

  // Terminal handoff: a newly accepted closure retires retained execution
  // overlays only via its own read receipt (exact response object → witness
  // captured when that read was issued). Witness-less, stale, failed, or
  // other-route reads retain. Still an effect — never during render.
  useEffect(() => {
    if (freshClosure) {
      tryHandoffAfterClosure(topicId, route, freshClosure as never, getClosureReadReceipt(freshClosure) ?? null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freshClosure])

  return { sharedContextInfo }
}

/** Loaded topic messages for the presentation input (stable empty identity while non-resident). */
export function usePresentationTopicMessages(topicId: string): Message[] {
  const loaded = useLoadedTopicMessages(topicId)
  return useMemo(() => (loaded ?? []) as Message[], [loaded])
}
