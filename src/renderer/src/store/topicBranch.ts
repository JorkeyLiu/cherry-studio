import { loggerService } from '@logger'
import type { PayloadAction } from '@reduxjs/toolkit'
import { createSlice } from '@reduxjs/toolkit'
import type { TopicBranchWire } from '@renderer/services/db/types'

import type { RootState } from './index'

const logger = loggerService.withContext('topicBranch')

/**
 * Renderer branch-tree projection for topic-internal branches (016 model).
 *
 * - `branchesByTopic[topicId]` is the Main-authoritative branch catalog for
 *   one LOGICAL topic (empty/missing = never branched / not yet loaded).
 * - `activeBranchIdByTopic[topicId]` is the active route: null/undefined =
 *   main route, non-null = that branch's effective route. Switching branches
 *   never changes the active topic, sidebar selection, or topic ordering.
 * - `activeTopic` stays the logical Topic object. Branches are NEVER added
 *   to assistants.topics and NEVER become the active topic.
 */

interface TopicBranchState {
  /** Branch catalog per logical topic. */
  branchesByTopic: Record<string, TopicBranchWire[]>
  /** Active route per logical topic (absent = main route). */
  activeBranchIdByTopic: Record<string, string | null>
  /** Monotonic route generation per topic: stale route fetches discard. */
  routeGenerationByTopic: Record<string, number>
}

const initialState: TopicBranchState = {
  branchesByTopic: {},
  activeBranchIdByTopic: {},
  routeGenerationByTopic: {}
}

function isValidBranchWire(value: unknown): value is TopicBranchWire {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const rec = value as Record<string, unknown>
  return (
    typeof rec.id === 'string' &&
    rec.id.length > 0 &&
    typeof rec.topicId === 'string' &&
    rec.topicId.length > 0 &&
    (rec.parentBranchId === null || typeof rec.parentBranchId === 'string') &&
    typeof rec.anchorMessageId === 'string' &&
    rec.anchorMessageId.length > 0
  )
}

export const topicBranchSlice = createSlice({
  name: 'topicBranch',
  initialState,
  reducers: {
    /**
     * Replace the branch catalog for one logical topic (Main-authoritative).
     * Prunes a stale active branch that no longer exists (branch deleted
     * elsewhere): the route falls back to main.
     */
    branchesReceived(state, action: PayloadAction<{ topicId: string; branches: TopicBranchWire[] }>) {
      const { topicId, branches } = action.payload
      if (typeof topicId !== 'string' || topicId.length === 0) {
        logger.warn('[branchesReceived] Ignoring catalog with missing topicId')
        return
      }
      const valid = Array.isArray(branches) ? branches.filter(isValidBranchWire) : []
      state.branchesByTopic[topicId] = valid
      const active = state.activeBranchIdByTopic[topicId]
      if (typeof active === 'string' && active.length > 0 && !valid.some((b) => b.id === active)) {
        state.activeBranchIdByTopic[topicId] = null
        state.routeGenerationByTopic[topicId] = (state.routeGenerationByTopic[topicId] ?? 0) + 1
      }
    },
    /**
     * Switch the active route of one logical topic. `branchId` null selects
     * the main route. Advances the route generation so stale route fetches
     * cannot overwrite the new route. Never touches topic identity.
     */
    activeBranchSet(state, action: PayloadAction<{ topicId: string; branchId: string | null }>) {
      const { topicId, branchId } = action.payload
      if (typeof topicId !== 'string' || topicId.length === 0) {
        logger.warn('[activeBranchSet] Ignoring route switch with missing topicId')
        return
      }
      state.activeBranchIdByTopic[topicId] = typeof branchId === 'string' && branchId.length > 0 ? branchId : null
      state.routeGenerationByTopic[topicId] = (state.routeGenerationByTopic[topicId] ?? 0) + 1
    },
    /**
     * Reset the active route to main (e.g. after deleting the last branch
     * the topic is indistinguishable from never-branched). Advances the
     * route generation.
     */
    activeBranchReset(state, action: PayloadAction<{ topicId: string }>) {
      const { topicId } = action.payload
      state.activeBranchIdByTopic[topicId] = null
      state.routeGenerationByTopic[topicId] = (state.routeGenerationByTopic[topicId] ?? 0) + 1
    },
    /**
     * Drop all branch state for topics (actual topic switch/deletion:
     * activeBranch resets to main; catalogs for deleted topics are
     * removed). Sidebar/topic identity is owned elsewhere.
     */
    branchesRemoved(state, action: PayloadAction<{ topicIds: string[] }>) {
      for (const id of action.payload.topicIds) {
        delete state.branchesByTopic[id]
        delete state.activeBranchIdByTopic[id]
        delete state.routeGenerationByTopic[id]
      }
    },
    branchesCleared(state) {
      state.branchesByTopic = {}
      state.activeBranchIdByTopic = {}
      state.routeGenerationByTopic = {}
    }
  }
})

export const { branchesReceived, activeBranchSet, activeBranchReset, branchesRemoved, branchesCleared } =
  topicBranchSlice.actions
export default topicBranchSlice.reducer

const selectTopicBranchState = (state: RootState): TopicBranchState =>
  (state as unknown as { topicBranch?: TopicBranchState }).topicBranch ?? initialState

/** Branch catalog for one logical topic ([] when unloaded or never branched). */
export const selectTopicBranches = (state: RootState, topicId: string): TopicBranchWire[] =>
  selectTopicBranchState(state).branchesByTopic[topicId] ?? []

/** Active route of one logical topic (null = main route). */
export const selectActiveBranchId = (state: RootState, topicId: string): string | null =>
  selectTopicBranchState(state).activeBranchIdByTopic[topicId] ?? null

/** Route generation for stale-fetch guards (0 when never switched). */
export const selectRouteGeneration = (state: RootState, topicId: string): number =>
  selectTopicBranchState(state).routeGenerationByTopic[topicId] ?? 0

/** One branch node by ID within its topic (undefined when unknown). */
export const selectBranchNode = (
  state: RootState,
  topicId: string,
  branchId: string | null
): TopicBranchWire | undefined => {
  if (branchId === null) return undefined
  return selectTopicBranches(state, topicId).find((b) => b.id === branchId)
}

/**
 * Breadcrumb path for a route: root-first branch nodes from the level-1
 * ancestor down to the addressed branch. [] for the main route. Cycle-safe:
 * stops on a repeated node.
 */
export const selectBranchPath = (state: RootState, topicId: string, branchId: string | null): TopicBranchWire[] => {
  if (branchId === null) return []
  const branches = selectTopicBranches(state, topicId)
  const byId = new Map(branches.map((b) => [b.id, b]))
  const leafFirst: TopicBranchWire[] = []
  const seen = new Set<string>()
  let current: string | null = branchId
  for (let depth = 0; depth < 64 && current !== null; depth++) {
    if (seen.has(current)) break
    seen.add(current)
    const node = byId.get(current)
    if (!node) break
    leafFirst.push(node)
    current = node.parentBranchId
  }
  // Unknown branch → []. A broken chain returns the resolvable suffix.
  return leafFirst.reverse()
}

/**
 * Direct child branches of one parent route, grouped by anchor message ID.
 * `parentBranchId` null addresses the level-1 branches of the main route.
 * Deterministic order per anchor: (createdAt, id).
 */
export const selectChildrenByAnchor = (
  state: RootState,
  topicId: string,
  parentBranchId: string | null
): Map<string, TopicBranchWire[]> => {
  const map = new Map<string, TopicBranchWire[]>()
  for (const b of selectTopicBranches(state, topicId)) {
    if ((b.parentBranchId ?? null) !== parentBranchId) continue
    const list = map.get(b.anchorMessageId) ?? []
    list.push(b)
    map.set(b.anchorMessageId, list)
  }
  for (const list of map.values()) {
    list.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id))
  }
  return map
}

/**
 * All direct child branches across the addressed route (the route's own
 * level plus every ancestor level), grouped by anchor message ID. Feeds the
 * fork dividers of the effective route view.
 */
export const selectRouteChildrenByAnchor = (
  state: RootState,
  topicId: string,
  branchId: string | null
): Map<string, TopicBranchWire[]> => {
  const map = new Map<string, TopicBranchWire[]>()
  const push = (b: TopicBranchWire): void => {
    const list = map.get(b.anchorMessageId) ?? []
    list.push(b)
    map.set(b.anchorMessageId, list)
  }
  const path = selectBranchPath(state, topicId, branchId)
  const levels: (string | null)[] = [null, ...path.map((b) => b.id)]
  for (const level of levels) {
    for (const [, list] of selectChildrenByAnchor(state, topicId, level)) {
      for (const b of list) push(b)
    }
  }
  for (const list of map.values()) {
    list.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id))
  }
  return map
}

/** Direct child branches of one parent route (flat, deterministic order). */
export const selectBranchChildren = (
  state: RootState,
  topicId: string,
  parentBranchId: string | null
): TopicBranchWire[] => {
  const out: TopicBranchWire[] = []
  for (const [, list] of selectChildrenByAnchor(state, topicId, parentBranchId)) {
    out.push(...list)
  }
  out.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id))
  return out
}
