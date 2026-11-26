import { type RouteScopedSegmentsResult, useRouteScopedSegments } from '@renderer/hooks/useRouteScopedSegments'
import { useAppStore } from '@renderer/store'
import { loadTopicMessagesThunk } from '@renderer/store/thunk/messageThunk'
import { createContext, type FC, type ReactNode, use, useEffect, useRef } from 'react'

/**
 * Surface-owned route structure read, shared by every chat-surface consumer.
 *
 * The scoped hook is a caller-local structural read (one minimal latest window
 * per route, latest-window rows never committed). Two chat surfaces used to
 * invoke it independently — `Messages` for in-flow group chrome and
 * `TopicSegmentDrawer` for the composer's navigation list — which issued two
 * identical `fetchMessagesWindow({ kind: 'latest', limit: 1,
 * includeStructure: true })` reads per route activation for the same route
 * input. This provider is the ONE invocation for the chat surface: the value it
 * publishes is identical for both consumers, so they can never disagree about
 * the route, and a route activation costs one structural read instead of two.
 *
 * The value is the hook's own memoized result (`RouteScopedSegmentsResult`):
 * its identity only changes when `segments` / `routeKey` / `isCurrent` change,
 * so provider re-renders from an unrelated Chat render cannot fan out to
 * consumers. Consumers read the same semantics the hook documents:
 * - `segments` is the ACCEPTED projection for `routeKey`; it is intentionally
 *   empty while a route switch is pending (navigation surfaces hide rather
 *   than list the previous route);
 * - `isCurrent` is that acceptance flag (`pending` is its negation);
 * - retention of the previous route's in-flow chrome stays a display concern
 *   of `Messages` (`useRetainedRouteSegments`), never a second read.
 *
 * The value is also the ONE owner of a committed deferred window structure.
 * `acceptCommittedStructure` is the synchronous write entry used by `Messages`
 * from the four receipt-guarded atomic `onPublish` sites; the committed
 * snapshot it publishes is the same retention fallback the drawer and
 * in-flow chrome read. No second local state or projection writer is kept in
 * `Messages`, and no new global bus/cache/clock is introduced.
 *
 * This provider also owns the topic ACTIVATION read. A cold topic's
 * activation window is a real bounded read (`loadTopicMessagesThunk`) carrying
 * `includeStructure` in its own Main transaction; the thunk hands that same
 * route structure back after the joint publication, and this provider accepts
 * it through `acceptCommittedStructure` before the catalog-driven effect can
 * issue a second structural probe. The handoff exists only on a successful
 * publication — resident hits, stale discards, and failures deliver nothing,
 * so the hook's own per-route probe still runs exactly once. `useActiveTopic`
 * therefore keeps no hidden loading side effect.
 *
 * This is caller-local structure, not authority: it publishes nothing to Redux
 * and holds no persistence, mirroring the projection/authority boundary.
 */
export type ChatRouteStructureValue = RouteScopedSegmentsResult

const ChatRouteStructureContext = createContext<ChatRouteStructureValue | null>(null)

interface ChatRouteStructureProviderProps {
  topicId: string
  children: ReactNode
}

export const ChatRouteStructureProvider: FC<ChatRouteStructureProviderProps> = ({ topicId, children }) => {
  const routeStructure = useRouteScopedSegments(topicId)
  const appStore = useAppStore()
  // The hook's accept entry is a stable single owner; the ref keeps the
  // activation effect independent of render identity.
  const acceptCommittedStructureRef = useRef(routeStructure.acceptCommittedStructure)
  acceptCommittedStructureRef.current = routeStructure.acceptCommittedStructure
  // One activation read per selected topic id. Messages' own bootstrap effects
  // run first (child before parent), so an in-flight saved-anchor around restore
  // is registered before this dispatch and is adopted rather than competed with.
  // A genuine A→B→A is a new id and re-activates; a same-ID metadata update
  // (object identity change) never re-runs this effect.
  useEffect(() => {
    if (!topicId) return
    void appStore.dispatch(
      loadTopicMessagesThunk(topicId, false, {
        onPublishedStructure: (handoff) => {
          acceptCommittedStructureRef.current(
            handoff.topicId,
            handoff.route,
            handoff.structure,
            handoff.reference,
            handoff.routeGeneration
          )
        }
      })
    )
  }, [appStore, topicId])
  return <ChatRouteStructureContext value={routeStructure}>{children}</ChatRouteStructureContext>
}

/**
 * Read the chat surface's single route structure projection.
 *
 * Fail-fast: there is exactly one owner (`ChatRouteStructureProvider` mounted by
 * `Chat`), so a consumer outside it is a wiring defect, never a state to guess.
 */
export function useChatRouteStructure(): ChatRouteStructureValue {
  const value = use(ChatRouteStructureContext)
  if (!value) {
    throw new Error('useChatRouteStructure must be used inside ChatRouteStructureProvider')
  }
  return value
}
