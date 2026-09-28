import type { Message } from '@renderer/types/newMessage'

import type { RootState } from './index'
import { selectActiveBranchId } from './topicBranch'

/**
 * BRANCH-4/9/12: renderer-side answer-group capability helpers.
 *
 * Main SQLite is the final authority (it resolves the complete group,
 * including window-outside members, in one transaction). These helpers are
 * the renderer precheck + UI capability layer only:
 *
 * - single-message checks (`isMutableForActiveRoute`) stay for mutations
 *   that touch exactly one message;
 * - group mutations (select/fold, useful, reorder, append multi-model,
 *   retry-all) must resolve the LOADED assistant members and require every
 *   loaded member mutable through the active route (owner equality).
 *   Reading the loaded user root never requires mutability (BRANCH-12);
 *   only actually-written members gate the UI.
 * - window-outside members are unknown to the renderer; the Main guard is
 *   the authoritative query for them. UI treats unknown capability as
 *   fail-closed (hidden/disabled).
 */

type MessagesSliceShape = {
  mutableRouteByTopic?: Record<string, string | null>
  mutableMessageIdsByTopic?: Record<string, string[]>
  messageIdsByTopic?: Record<string, string[]>
}

function messagesSliceOf(state: RootState): MessagesSliceShape {
  return (state as unknown as { messages?: MessagesSliceShape }).messages ?? {}
}

/**
 * Active route of a logical topic for branch-aware writes/reads
 * (null = main route). Single source: the topicBranch slice. Never throws —
 * an unreadable store resolves to the main route.
 */
export const activeRouteOf = (getState: (() => RootState) | undefined, topicId: string): string | null => {
  try {
    if (typeof getState !== 'function') return null
    return selectActiveBranchId(getState(), topicId)
  } catch {
    return null
  }
}

/**
 * Renderer precheck against the Main-authoritative window capability
 * (mutableMessageIds). Fail-closed: unknown/stale capability, route mismatch,
 * or non-resident IDs are immutable. Never guesses from branchId alone.
 * Thunk entries precheck here; the Main guard remains authoritative and its
 * failure keeps the existing toast path.
 */
export const isMutableForActiveRoute = (state: RootState, topicId: string, messageId: string): boolean => {
  try {
    const route = selectActiveBranchId(state, topicId)
    const slice = messagesSliceOf(state)
    const storedRoute = slice.mutableRouteByTopic?.[topicId] ?? null
    if (storedRoute !== route) return false
    const mutable = slice.mutableMessageIdsByTopic?.[topicId]
    if (!Array.isArray(mutable) || !mutable.includes(messageId)) return false
    const loaded = slice.messageIdsByTopic?.[topicId]
    if (!Array.isArray(loaded) || !loaded.includes(messageId)) return false
    return true
  } catch {
    return false
  }
}

/** Throw fail-closed when the message is not mutable through the active route. */
export const requireMutableForActiveRoute = (state: RootState, topicId: string, messageId: string): void => {
  if (!isMutableForActiveRoute(state, topicId, messageId)) {
    throw new Error(`Message ${messageId} is immutable through this route`)
  }
}

/** Loaded-projection answer group resolved around one member/root ID. */
export interface LoadedAnswerGroup {
  /** Group key: the user root ID (assistant `askId`). */
  askId: string
  /** User root ID when it is in the loaded projection; null otherwise (window-outside/orphan). */
  userRootId: string | null
  /** Loaded assistant member IDs (loaded order). */
  memberIds: string[]
  /** All loaded IDs forming the group (root first when loaded, then members). */
  allIds: string[]
}

/**
 * Resolve the loaded answer group for `memberOrRootId` from the current
 * loaded projection. Returns null when the ID is unknown, has no group key
 * (non-assistant without answers / role without askId), or the loaded
 * projection is absent.
 *
 * The user root joins `allIds` only when it is loaded; a window-outside
 * root stays unknown to the renderer and is decided by the Main guard.
 */
export function resolveLoadedAnswerGroup(
  state: RootState,
  topicId: string,
  memberOrRootId: string
): LoadedAnswerGroup | null {
  try {
    const slice = messagesSliceOf(state)
    const loaded = slice.messageIdsByTopic?.[topicId]
    if (!Array.isArray(loaded) || loaded.length === 0) return null
    const entities = (state as unknown as { messages?: { entities?: Record<string, Message | undefined> } }).messages
      ?.entities
    if (!entities) return null
    const seed = entities[memberOrRootId]
    let askId: string | null = null
    if (seed) {
      if (seed.role === 'assistant' && typeof seed.askId === 'string' && seed.askId.length > 0) {
        askId = seed.askId
      } else if (seed.id === memberOrRootId) {
        // A user/system root addresses its own group key.
        askId = seed.id
      }
    }
    if (!askId) return null
    const loadedSet = new Set(loaded)
    const memberIds: string[] = []
    for (const id of loaded) {
      const m = entities[id]
      if (m && m.role === 'assistant' && m.askId === askId) memberIds.push(id)
    }
    if (memberIds.length === 0) return null
    void loadedSet
    const root = entities[askId]
    const userRootId = root && loaded.includes(askId) ? askId : null
    const allIds = userRootId ? [userRootId, ...memberIds] : [...memberIds]
    return { askId, userRootId, memberIds, allIds }
  } catch {
    return null
  }
}

/**
 * Group-level capability: every loaded assistant member must be mutable
 * through the active route (BRANCH-12 actual-write-target). The loaded user
 * root is a read-only reference and never gates mutability. Unknown
 * capability, route mismatch, or any loaded immutable member fails closed.
 * Window-outside members are decided by the Main guard.
 */
export function isLoadedAnswerGroupMutable(state: RootState, topicId: string, group: LoadedAnswerGroup): boolean {
  for (const id of group.memberIds) {
    if (!isMutableForActiveRoute(state, topicId, id)) return false
  }
  return group.memberIds.length > 0
}

/** Throw fail-closed unless the loaded answer group is fully mutable. */
export function requireLoadedAnswerGroupMutable(state: RootState, topicId: string, group: LoadedAnswerGroup): void {
  if (!isLoadedAnswerGroupMutable(state, topicId, group)) {
    throw new Error(`Answer group ${group.askId} is immutable through this route`)
  }
}

/**
 * Resolve + require in one step for thunk entries: unknown group or any
 * loaded immutable member throws fail-closed before any IPC call.
 */
export function requireAnswerGroupForMember(
  state: RootState,
  topicId: string,
  memberOrRootId: string
): LoadedAnswerGroup {
  const group = resolveLoadedAnswerGroup(state, topicId, memberOrRootId)
  if (!group) {
    throw new Error(`Answer group for ${memberOrRootId} is unknown through this route`)
  }
  requireLoadedAnswerGroupMutable(state, topicId, group)
  return group
}

/** Loaded assistant member IDs for one group key (loaded order; may be empty). */
export function loadedAnswerMemberIds(state: RootState, topicId: string, askId: string): string[] {
  try {
    const slice = messagesSliceOf(state)
    const loaded = slice.messageIdsByTopic?.[topicId]
    if (!Array.isArray(loaded) || loaded.length === 0) return []
    const entities = (state as unknown as { messages?: { entities?: Record<string, Message | undefined> } }).messages
      ?.entities
    if (!entities) return []
    const out: string[] = []
    for (const id of loaded) {
      const m = entities[id]
      if (m && m.role === 'assistant' && m.askId === askId) out.push(id)
    }
    return out
  } catch {
    return []
  }
}

/**
 * Batch/resend precheck (A5): every LOADED answer member of `askId` must be
 * mutable through the active route. Vacuous-true when no member is loaded —
 * window-outside members are decided by the Main per-item guard, and the
 * caller must stop at the first Main failure without claiming atomicity.
 * Known-immutable loaded members throw fail-closed before any IPC call.
 */
export function requireLoadedAnswerMembersMutable(state: RootState, topicId: string, askId: string): void {
  for (const id of loadedAnswerMemberIds(state, topicId, askId)) {
    requireMutableForActiveRoute(state, topicId, id)
  }
}

/** Serializable capability snapshot for hooks without getState access. */
export interface RouteCapabilitySnapshot {
  activeRoute: string | null
  mutableRoute: string | null | undefined
  mutableIds: readonly string[] | undefined
  loadedIds: readonly string[] | undefined
}

/** Select the mutation capability snapshot for one topic (never throws). */
export function selectRouteCapability(state: RootState, topicId: string): RouteCapabilitySnapshot {
  try {
    const slice = messagesSliceOf(state)
    return {
      activeRoute: selectActiveBranchId(state, topicId),
      mutableRoute: slice.mutableRouteByTopic?.[topicId],
      mutableIds: slice.mutableMessageIdsByTopic?.[topicId],
      loadedIds: slice.messageIdsByTopic?.[topicId]
    }
  } catch {
    return { activeRoute: null, mutableRoute: undefined, mutableIds: undefined, loadedIds: undefined }
  }
}

/**
 * Pure segment/batch precheck (B5): every member ID must be mutable through
 * the snapshot's active route. Unknown capability, route mismatch, or any
 * non-mutable/non-loaded member throws fail-closed with zero IPC calls.
 */
export function requireIdsMutableForRoute(snap: RouteCapabilitySnapshot, topicId: string, ids: string[]): void {
  const storedRoute = snap.mutableRoute ?? null
  if (storedRoute !== snap.activeRoute) {
    throw new Error(`Route capability for topic ${topicId} is unknown through this route`)
  }
  if (!Array.isArray(snap.mutableIds)) {
    throw new Error(`Route capability for topic ${topicId} is unknown through this route`)
  }
  const mutable = new Set(snap.mutableIds)
  const loaded = new Set(Array.isArray(snap.loadedIds) ? snap.loadedIds : [])
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0 || !mutable.has(id) || !loaded.has(id)) {
      throw new Error(`Message ${id} is immutable through this route`)
    }
  }
}
