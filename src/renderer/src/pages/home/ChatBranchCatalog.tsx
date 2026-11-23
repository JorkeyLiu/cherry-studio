import type { AppDispatch } from '@renderer/store'
import { useAppDispatch } from '@renderer/store'
import * as messageThunkModule from '@renderer/store/thunk/messageThunk'
import { createContext, type FC, type ReactNode, use, useEffect } from 'react'

// The branch loader is resolved at runtime with a fail-safe: unit harnesses
// that stub the thunk module with a partial mock (no branch export) surface a
// missing-export error on property access — that must not crash the mount.
// Production always provides the real thunk.
type BranchLoader = (topicId: string) => (dispatch: AppDispatch) => Promise<void>
function resolveBranchLoader(): BranchLoader | undefined {
  try {
    const fn = (messageThunkModule as unknown as Record<string, unknown>).fetchTopicBranchesThunk
    return typeof fn === 'function' ? (fn as BranchLoader) : undefined
  } catch {
    return undefined
  }
}

/**
 * Request a branch catalog refresh for top navigation and fork dividers
 * outside a hook (creation/rename/delete flows). This is a one-shot request,
 * never suppressed by the mount-time single request below: an explicit
 * mutation refresh must reach Main and publish its own catalog.
 */
export function requestTopicBranches(dispatch: AppDispatch, topicId: string): void {
  const loadBranches = resolveBranchLoader()
  if (loadBranches !== undefined) {
    void dispatch(loadBranches(topicId))
  }
}

/**
 * The topic whose branch catalog the surrounding chat shell owns (`null`
 * outside a shell).
 */
const ChatBranchCatalogContext = createContext<string | null>(null)

interface ChatBranchCatalogProviderProps {
  topicId: string
  children: ReactNode
}

/**
 * Surface-owned branch catalog request, shared by every chat-surface consumer.
 *
 * The catalog is Main-authoritative Redux state (`topicBranch.branchesByTopic`)
 * and every chat surface derives its own path/children from it by its own
 * branchId. Each consumer used to request that catalog on mount/topic change
 * through `useBranchTree`, so one topic activation issued one identical
 * `listBranches` read per mounted consumer — the top selector, the message
 * flow's fork dividers, and (when enabled) the conversation navigation list.
 * `Chat` mounts this provider around the whole surface (navbar + message flow)
 * so the catalog is requested exactly ONCE per topic change; consumers then
 * project the already-loaded catalog through their existing selectors.
 *
 * Ordering is deliberately unchanged: a newer request only supersedes an older
 * one through the store's catalog fetch sequence, exactly as before — this
 * provider adds no cache, no TTL, and no in-flight dedupe.
 *
 * The scope owns the current topic only for its own payload: a consumer
 * addressing a different topic falls back to its own request (see
 * `useBranchTree`), and a surface mounted without this shell keeps loading
 * itself, so no branch tree is ever silently unloaded.
 */
export const ChatBranchCatalogProvider: FC<ChatBranchCatalogProviderProps> = ({ topicId, children }) => {
  const dispatch = useAppDispatch()
  useEffect(() => {
    requestTopicBranches(dispatch, topicId)
  }, [dispatch, topicId])
  return <ChatBranchCatalogContext value={topicId}>{children}</ChatBranchCatalogContext>
}

/**
 * Topic of the surrounding chat shell's catalog request (`null` when no shell
 * is mounted above the caller).
 */
export function useChatBranchCatalogTopic(): string | null {
  return use(ChatBranchCatalogContext)
}
