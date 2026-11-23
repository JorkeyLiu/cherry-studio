import { type RouteScopedSegmentsResult, useRouteScopedSegments } from '@renderer/hooks/useRouteScopedSegments'
import { createContext, type FC, type ReactNode, use } from 'react'

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
 * This is caller-local structure, not authority: it publishes nothing to Redux
 * and holds no persistence, mirroring the projection/authority boundary.
 */
const ChatRouteStructureContext = createContext<RouteScopedSegmentsResult | null>(null)

interface ChatRouteStructureProviderProps {
  topicId: string
  children: ReactNode
}

export const ChatRouteStructureProvider: FC<ChatRouteStructureProviderProps> = ({ topicId, children }) => {
  const routeStructure = useRouteScopedSegments(topicId)
  return <ChatRouteStructureContext value={routeStructure}>{children}</ChatRouteStructureContext>
}

/**
 * Read the chat surface's single route structure projection.
 *
 * Fail-fast: there is exactly one owner (`ChatRouteStructureProvider` mounted by
 * `Chat`), so a consumer outside it is a wiring defect, never a state to guess.
 */
export function useChatRouteStructure(): RouteScopedSegmentsResult {
  const value = use(ChatRouteStructureContext)
  if (!value) {
    throw new Error('useChatRouteStructure must be used inside ChatRouteStructureProvider')
  }
  return value
}
