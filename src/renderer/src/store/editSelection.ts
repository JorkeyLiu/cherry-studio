import { getMessageGroups } from '@renderer/hooks/useMessageGroup'
import type { Message } from '@renderer/types/newMessage'

import type { RootState } from './index'
import { selectActiveBranchId } from './topicBranch'

/**
 * PROJ-13 (B): edit-selection mutability.
 *
 * `selectedGroupIds` (askIds) resolve through the CURRENT loaded projection
 * (`messageIdsByTopic[topicId]` order, same grouping as the edit UI) to the
 * full loaded member list of every selected group. A selection is writable
 * only when every selected group resolves AND every resolved message is in
 * the current route `mutableMessageIds` capability:
 *
 * - selected ID absent from the resident projection (capability unknown,
 *   route-switch residue, window-cropped incompleteness) → fail-closed;
 * - route mismatch between the stored capability and the active route →
 *   fail-closed;
 * - one shared member anywhere in the selection blocks the WHOLE batch
 *   (never skip-and-partially-write).
 *
 * Read-only copy/export stays unrestricted (authority reads).
 */

function loadedMessagesOf(state: RootState, topicId: string): Message[] | null {
  try {
    const slice = (state as unknown as { messages?: { messageIdsByTopic?: Record<string, string[]> } }).messages
    const ids = slice?.messageIdsByTopic?.[topicId]
    if (!Array.isArray(ids)) return null
    const entities = (state as unknown as { messages?: { entities?: Record<string, Message | undefined> } }).messages
      ?.entities
    if (!entities) return null
    const out: Message[] = []
    for (const id of ids) {
      const m = entities[id]
      if (m) out.push(m)
    }
    return out
  } catch {
    return null
  }
}

/**
 * Resolve selected group IDs to their loaded member message IDs.
 * Returns null when any selected group is absent from the current loaded
 * projection (fail-closed: unknown/stale/cropped selections never write).
 */
export function resolveEditSelectionMessageIds(
  state: RootState,
  topicId: string,
  selectedGroupIds: string[]
): string[] | null {
  if (!Array.isArray(selectedGroupIds) || selectedGroupIds.length === 0) return null
  const loaded = loadedMessagesOf(state, topicId)
  if (!loaded) return null
  const groups = getMessageGroups(loaded)
  const byAskId = new Map(groups.map((g) => [g.askId, g]))
  const out: string[] = []
  for (const askId of selectedGroupIds) {
    const group = byAskId.get(askId)
    if (!group || group.messages.length === 0) return null
    for (const m of group.messages) out.push(m.id)
  }
  return out
}

/** Read the ambient edit-mode selection from state (may be absent in tests). */
export function readEditSelectionGroupIds(state: RootState): string[] | null {
  const selected = (state as unknown as { editMode?: { selectedGroupIds?: unknown } }).editMode?.selectedGroupIds
  if (!Array.isArray(selected)) return null
  const ids = selected.filter((id): id is string => typeof id === 'string' && id.length > 0)
  if (ids.length !== selected.length) return null
  return ids
}

/**
 * True only when the edit selection is fully writable through the active
 * route. Fail-closed on every unknown: non-resident capability, route
 * mismatch, unresolvable selection, or any non-mutable member.
 *
 * `selectedGroupIds` defaults to the ambient state selection; callers that
 * already hold the selection (delete/clipboard paths) pass it explicitly so
 * the gate binds to the exact requested set, never a stale store copy.
 */
export function selectIsEditSelectionMutable(state: RootState, topicId: string, selectedGroupIds?: string[]): boolean {
  try {
    const ids = selectedGroupIds ?? readEditSelectionGroupIds(state)
    if (!ids || ids.length === 0) return false
    const resolved = resolveEditSelectionMessageIds(state, topicId, ids)
    if (!resolved || resolved.length === 0) return false
    const route = selectActiveBranchId(state, topicId)
    const slice = (state as unknown as { messages?: { mutableRouteByTopic?: Record<string, string | null> } }).messages
    const storedRoute = slice?.mutableRouteByTopic?.[topicId] ?? null
    if (storedRoute !== route) return false
    const mutable = (state as unknown as { messages?: { mutableMessageIdsByTopic?: Record<string, string[]> } })
      .messages?.mutableMessageIdsByTopic?.[topicId]
    if (!Array.isArray(mutable)) return false
    const mutableSet = new Set(mutable)
    const loadedIds = (state as unknown as { messages?: { messageIdsByTopic?: Record<string, string[]> } }).messages
      ?.messageIdsByTopic?.[topicId]
    if (!Array.isArray(loadedIds)) return false
    const loadedSet = new Set(loadedIds)
    for (const id of resolved) {
      if (!mutableSet.has(id) || !loadedSet.has(id)) return false
    }
    return true
  } catch {
    return false
  }
}

/** Throw fail-closed unless the edit selection is fully writable. */
export function requireEditSelectionMutable(state: RootState, topicId: string, selectedGroupIds?: string[]): string[] {
  const ids = selectedGroupIds ?? readEditSelectionGroupIds(state) ?? []
  const resolved = resolveEditSelectionMessageIds(state, topicId, ids)
  if (!resolved || !selectIsEditSelectionMutable(state, topicId, ids)) {
    throw new Error(`Edit selection in topic ${topicId} is immutable through this route`)
  }
  return resolved
}
