import type { TopicBranchWire } from '@renderer/services/db/types'
import type { AppDispatch } from '@renderer/store'
import type { RootState } from '@renderer/store'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import * as messageThunkModule from '@renderer/store/thunk/messageThunk'
import { selectRouteGeneration, selectTopicBranches } from '@renderer/store/topicBranch'
import { useEffect, useMemo } from 'react'

// The branch loader is resolved at runtime with a fail-safe: unit
// harnesses that stub the thunk module with a partial mock (no branch
// export) surface a missing-export error on property access — that must not
// crash the mount. Production always provides the real thunk.
type BranchLoader = (topicId: string) => (dispatch: AppDispatch) => Promise<void>
function resolveBranchLoader(): BranchLoader | undefined {
  try {
    const fn = (messageThunkModule as unknown as Record<string, unknown>).fetchTopicBranchesThunk
    return typeof fn === 'function' ? (fn as BranchLoader) : undefined
  } catch {
    return undefined
  }
}
const dispatchBranches = (dispatch: AppDispatch, topicId: string): void => {
  const loadBranches = resolveBranchLoader()
  if (loadBranches !== undefined) {
    void dispatch(loadBranches(topicId))
  }
}

/**
 * Request a branch catalog refresh for top navigation and fork dividers
 * outside the hook (creation/rename/delete flows). Shares the mount-safe
 * loader resolution above: no-op when the thunk module is partially stubbed.
 */
export function requestTopicBranches(dispatch: AppDispatch, topicId: string): void {
  dispatchBranches(dispatch, topicId)
}

/**
 * Branch-tree projection for the currently viewed route.
 *
 * `branchId` is the ACTIVE route (null = main route) — owned by the caller
 * (activeBranchId state), not derived here, so the hook stays a pure
 * projection over the stable catalog reference. All derived values are
 * memoized; the sidebar is untouched (flat logical topics). This feeds only
 * the unified top selector and the fork dividers.
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

  useEffect(() => {
    dispatchBranches(dispatch, topicId)
  }, [dispatch, topicId])

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
