import { loggerService } from '@logger'
import type { PayloadAction } from '@reduxjs/toolkit'
import { createSlice } from '@reduxjs/toolkit'
import type { TopicBranchWire } from '@renderer/services/db/types'
import { createTransform } from 'redux-persist'

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

export interface TopicBranchState {
  /** Branch catalog per logical topic. */
  branchesByTopic: Record<string, TopicBranchWire[]>
  /** Active route per logical topic (absent = main route). */
  activeBranchIdByTopic: Record<string, string | null>
  /** Monotonic route generation per topic: stale route fetches discard. */
  routeGenerationByTopic: Record<string, number>
  /**
   * One-shot deletion-fallback reload intent per logical topic.
   * Set by `deleteBranchSubtree` together with the active-fallback switch
   * when the active route was deleted; consumed exactly once by the Messages
   * route owner which performs an explicit `latest` reload. Never persisted
   * across relaunch (stripped by the persist transform; rehydrate always
   * yields `{}`). `route` is the fallback route, `deletedBranchIds`
   * identifies the removed subtree whose scroll snapshots must not influence
   * the recovery.
   */
  deletionFallbackByTopic: Record<string, { route: string | null; intentId: number; deletedBranchIds: string[] }>
}

const initialState: TopicBranchState = {
  branchesByTopic: {},
  activeBranchIdByTopic: {},
  routeGenerationByTopic: {},
  deletionFallbackByTopic: {}
}

/**
 * Persisted wire for the topicBranch slice: the one-shot
 * `deletionFallbackByTopic` intent is runtime-only and never reaches storage.
 */
export type TopicBranchPersistedState = Omit<TopicBranchState, 'deletionFallbackByTopic'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * redux -> storage: strip the one-shot fallback, keep branches/active/generation.
 */
export function topicBranchInboundForPersist(state: TopicBranchState): TopicBranchPersistedState {
  return {
    branchesByTopic: state.branchesByTopic ?? {},
    activeBranchIdByTopic: state.activeBranchIdByTopic ?? {},
    routeGenerationByTopic: state.routeGenerationByTopic ?? {}
  }
}

/**
 * storage -> redux: discard any persisted fallback (old wires included),
 * retain branches/active/generation, default missing maps to `{}`.
 */
export function topicBranchOutboundFromPersist(stored: unknown): TopicBranchState {
  const record: Record<string, unknown> = isRecord(stored) ? stored : {}
  const branchesByTopic = isRecord(record.branchesByTopic)
    ? (record.branchesByTopic as TopicBranchState['branchesByTopic'])
    : {}
  const activeBranchIdByTopic = isRecord(record.activeBranchIdByTopic)
    ? (record.activeBranchIdByTopic as TopicBranchState['activeBranchIdByTopic'])
    : {}
  const routeGenerationByTopic = isRecord(record.routeGenerationByTopic)
    ? (record.routeGenerationByTopic as TopicBranchState['routeGenerationByTopic'])
    : {}
  return {
    branchesByTopic,
    activeBranchIdByTopic,
    routeGenerationByTopic,
    deletionFallbackByTopic: {}
  }
}

/**
 * Narrow persist transform for `topicBranch` only: the slice must stay
 * persisted (branches/active survive relaunch) while the one-shot fallback
 * never crosses a restart. The slice itself handles no `persist/REHYDRATE`
 * action so `autoMergeLevel1` merges the inbound slice instead of skipping it
 * as reducer-modified.
 */
export const topicBranchPersistTransform = createTransform<TopicBranchState, TopicBranchPersistedState>(
  (inboundState) => topicBranchInboundForPersist(inboundState),
  (outboundState) => topicBranchOutboundFromPersist(outboundState),
  { whitelist: ['topicBranch'] }
)

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
        // Backward-compatible: persisted states predating the one-shot
        // deletion intent carry no `deletionFallbackByTopic` field.
        if (state.deletionFallbackByTopic) {
          delete state.deletionFallbackByTopic[id]
        }
      }
    },
    branchesCleared(state) {
      state.branchesByTopic = {}
      state.activeBranchIdByTopic = {}
      state.routeGenerationByTopic = {}
      state.deletionFallbackByTopic = {}
    },
    /**
     * One-shot deletion-fallback intent: the active route was deleted and the
     * caller already switched `activeBranchId` to `route`. Messages consumes
     * it once with an explicit `latest` windowed read (never the generic
     * snapshot-around path). Overwrites any unconsumed intent for the topic.
     */
    deletionFallbackRequested(
      state,
      action: PayloadAction<{ topicId: string; route: string | null; deletedBranchIds: string[] }>
    ) {
      const { topicId, route, deletedBranchIds } = action.payload
      if (typeof topicId !== 'string' || topicId.length === 0) {
        logger.warn('[deletionFallbackRequested] Ignoring intent with missing topicId')
        return
      }
      if (!state.deletionFallbackByTopic) {
        state.deletionFallbackByTopic = {}
      }
      const prev = state.deletionFallbackByTopic[topicId]
      const intentId = (prev?.intentId ?? 0) + 1
      state.deletionFallbackByTopic[topicId] = {
        route: typeof route === 'string' && route.length > 0 ? route : null,
        intentId,
        deletedBranchIds: Array.isArray(deletedBranchIds) ? [...deletedBranchIds] : []
      }
    },
    /**
     * Consume a deletion-fallback intent exactly once. Only the matching
     * `intentId` clears; stale consumes are no-ops so a newer intent is never
     * dropped by an older consumer.
     */
    deletionFallbackConsumed(state, action: PayloadAction<{ topicId: string; intentId: number }>) {
      const { topicId, intentId } = action.payload
      const current = state.deletionFallbackByTopic?.[topicId]
      if (current && current.intentId === intentId) {
        delete state.deletionFallbackByTopic[topicId]
      }
    }
  }
})

export const {
  branchesReceived,
  activeBranchSet,
  activeBranchReset,
  branchesRemoved,
  branchesCleared,
  deletionFallbackRequested,
  deletionFallbackConsumed
} = topicBranchSlice.actions
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

/** One-shot deletion-fallback intent for a topic (undefined when none pending). */
export const selectDeletionFallbackIntent = (
  state: RootState,
  topicId: string
): { route: string | null; intentId: number; deletedBranchIds: string[] } | undefined =>
  selectTopicBranchState(state).deletionFallbackByTopic?.[topicId]

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
