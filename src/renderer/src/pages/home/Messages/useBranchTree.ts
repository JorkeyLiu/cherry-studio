import { requestTopicBranches, useChatBranchCatalogTopic } from '@renderer/pages/home/ChatBranchCatalog'
import type { TopicBranchWire } from '@renderer/services/db/types'
import type { RootState } from '@renderer/store'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { selectRouteGeneration, selectTopicBranches } from '@renderer/store/topicBranch'
import { useEffect, useMemo } from 'react'

/**
 * Request a branch catalog refresh for top navigation and fork dividers
 * outside the hook (creation/rename/delete flows). Delegates to the chat
 * surface's request, which shares the mount-safe loader resolution: a no-op
 * when the thunk module is partially stubbed. An explicit mutation refresh is
 * never suppressed by the shell's per-topic request.
 */
export { requestTopicBranches }

/**
 * Branch-tree projection for the currently viewed route.
 *
 * `branchId` is the ACTIVE route (null = main route) — owned by the caller
 * (activeBranchId state), not derived here, so the hook stays a pure
 * projection over the stable catalog reference. The catalog request does not
 * live here: the chat shell (`ChatBranchCatalogProvider`) owns the surface's
 * single request per topic change, and every consumer projects that same
 * Redux catalog; the hook only requests one itself when no shell covers its
 * topic. All derived values are memoized; the sidebar is untouched (flat
 * logical topics). This feeds only the unified top selector and the fork
 * dividers.
 */
export function useBranchTree(
  topicId: string,
  branchId: string | null
): {
  /** All branch nodes of the logical topic (empty when never branched). */
  branches: TopicBranchWire[]
  /** Active branch node (undefined on the main route). */
  activeNode: TopicBranchWire | undefined
  /** Breadcrumb path: root-first nodes down to the active branch ([] on main). */
  path: TopicBranchWire[]
  /** Direct children of the active route level (flat, deterministic order). */
  children: TopicBranchWire[]
  /** Direct child branches across the addressed route, grouped by anchor. */
  childrenByAnchor: Map<string, TopicBranchWire[]>
  /** Anchor of the active branch (null on the main route). */
  ownAnchorMessageId: string | null
  /** Route generation for stale-fetch guards. */
  routeGeneration: number
  /** True when the topic has any branch. */
  hasBranches: boolean
} {
  const dispatch = useAppDispatch()
  // Stable state references only (catalog array identity is store-stable).
  const branches = useAppSelector((state: RootState) => selectTopicBranches(state, topicId))
  const routeGeneration = useAppSelector((state: RootState) => selectRouteGeneration(state, topicId))

  const shellCatalogTopic = useChatBranchCatalogTopic()

  useEffect(() => {
    // Shell-covered topic: its one request per topic change is the read.
    if (shellCatalogTopic === topicId) return
    requestTopicBranches(dispatch, topicId)
  }, [dispatch, shellCatalogTopic, topicId])

  return useMemo(() => {
    const byId = new Map(branches.map((b) => [b.id, b]))
    // Breadcrumb path (cycle-safe).
    const leafFirst: TopicBranchWire[] = []
    if (branchId !== null) {
      const seen = new Set<string>()
      let current: string | null = branchId
      for (let depth = 0; depth < 64 && current !== null; depth++) {
        if (seen.has(current)) break
        seen.add(current)
        const node = byId.get(current)
        if (!node) break
        leafFirst.push(node)
        current = node.parentBranchId ?? null
      }
    }
    const path = leafFirst.reverse()
    const activeNode = branchId !== null ? byId.get(branchId) : undefined
    // Children of the active level + every ancestor level, by anchor.
    const byParent = new Map<string | null, TopicBranchWire[]>()
    for (const b of branches) {
      const key = b.parentBranchId ?? null
      const list = byParent.get(key) ?? []
      list.push(b)
      byParent.set(key, list)
    }
    const childrenByAnchor = new Map<string, TopicBranchWire[]>()
    const push = (b: TopicBranchWire): void => {
      const list = childrenByAnchor.get(b.anchorMessageId) ?? []
      list.push(b)
      childrenByAnchor.set(b.anchorMessageId, list)
    }
    const levels: (string | null)[] = [null, ...path.map((b) => b.id)]
    for (const level of levels) {
      for (const b of byParent.get(level) ?? []) push(b)
    }
    for (const list of childrenByAnchor.values()) {
      list.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id))
    }
    const children = [...(byParent.get(branchId) ?? [])].sort(
      (a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id)
    )
    return {
      branches,
      activeNode,
      path,
      children,
      childrenByAnchor,
      ownAnchorMessageId: activeNode?.anchorMessageId ?? null,
      routeGeneration,
      hasBranches: branches.length > 0
    }
  }, [branches, branchId, routeGeneration])
}
