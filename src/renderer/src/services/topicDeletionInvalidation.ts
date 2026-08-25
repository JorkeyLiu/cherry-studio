/**
 * topicDeletionInvalidation — renderer-owned fail-closed deletion generation.
 *
 * Ensures window/context projections cannot survive authoritative hard deletion
 * and that in-flight responses are discarded before publication.
 *
 * - Per-topic monotonic generation, bumped only on SUCCESSFUL authoritative
 *   hard deletion / bulk purge / empty-trash / assistant reset.
 * - Bumping atomically clears window completeness and closure cache for that topic
 *   (so no cached hit remains valid) and advances closure generation.
 * - In-flight fetches capture generation at request start; before any join/action
 *   they compare captured vs current and discard if mismatch (fail-closed).
 * - Soft-delete never bumps; preserves resident projection.
 * - Bulk deletions use authoritative affected IDs from Main result; no guessing.
 * - Permanent deletion also purges resident Redux projections precisely:
 *   message IDs/entities for the deleted topic, blocks referenced only by those
 *   messages, topic segments, window completeness/cache, closure cache/generation,
 *   and topic loading/fulfilled markers. Entities belonging to other topics are preserved.
 * - Generation is bumped BEFORE Redux removal so in-flight responses discard.
 */

import {
  clearAllLatestWindowCompleteness,
  clearLatestWindowCompleteness
} from '@renderer/pages/home/Messages/messageWindow'
import { bumpAndInvalidate, clearCachedContextClosure } from '@renderer/services/contextClosure'
import store from '@renderer/store'
import { removeManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions } from '@renderer/store/newMessage'
import { clearSegmentsForTopic } from '@renderer/store/topicSegment'

const deletionGenerations = new Map<string, number>()

// Minimal per-topic generation subscription for renderer window caches.
// Each mounted Messages instance subscribes for its topic and clears its
// local windowCacheRef immediately when the authoritative generation
// advances. Epoch-only, no StoreSync involvement.
const deletionListeners = new Map<string, Set<(nextGeneration: number) => void>>()

function notifyDeletionGeneration(topicId: string, nextGeneration: number): void {
  const listeners = deletionListeners.get(topicId)
  if (!listeners || listeners.size === 0) return
  for (const cb of [...listeners]) {
    try {
      cb(nextGeneration)
    } catch {
      // best-effort, never throw
    }
  }
}

export function getDeletionGeneration(topicId: string): number {
  return deletionGenerations.get(topicId) ?? 0
}

export function getDeletionGenerationsSnapshot(): Map<string, number> {
  return new Map(deletionGenerations)
}

/**
 * Subscribe to authoritative deletion generation advances for a specific topic.
 * The callback is invoked synchronously on each successful bump for that topic
 * with the new generation. Returns an unsubscribe function. The subscription
 * is per-topic and does not affect unrelated topics.
 */
export function subscribeDeletionGeneration(topicId: string, listener: (nextGeneration: number) => void): () => void {
  if (typeof topicId !== 'string' || topicId.length === 0 || typeof listener !== 'function') {
    return () => {}
  }
  let set = deletionListeners.get(topicId)
  if (!set) {
    set = new Set()
    deletionListeners.set(topicId, set)
  }
  set.add(listener)
  // Current-state-safe: if deletion already occurred before subscription,
  // invoke immediately so stale projections are invalidated synchronously.
  // The callback must be idempotent; duplicate work is safe and the
  // unsubscribe still correctly removes the listener.
  const currentGen = deletionGenerations.get(topicId) ?? 0
  if (currentGen !== 0) {
    try {
      listener(currentGen)
    } catch {
      // best-effort
    }
  }
  return () => {
    const s = deletionListeners.get(topicId)
    if (!s) return
    s.delete(listener)
    if (s.size === 0) deletionListeners.delete(topicId)
  }
}

export function bumpDeletionGeneration(topicId: string): number {
  const next = (deletionGenerations.get(topicId) ?? 0) + 1
  deletionGenerations.set(topicId, next)
  // Invalidate renderer projections for this topic atomically.
  clearLatestWindowCompleteness(topicId)
  // bumpAndInvalidate clears closure cache and advances its generation; for
  // topics with no cached entry, explicit clear ensures no phantom hit.
  try {
    bumpAndInvalidate(topicId)
  } catch {
    clearCachedContextClosure(topicId)
  }
  // Notify per-topic subscribers immediately (epoch advance).
  notifyDeletionGeneration(topicId, next)
  return next
}

export function invalidateTopicDeletion(topicId: string): void {
  bumpDeletionGeneration(topicId)
  purgeResidentProjectionsForTopics([topicId])
}

export function invalidateTopicsDeletion(topicIds: string[]): void {
  const valid = topicIds.filter((id) => typeof id === 'string' && id.length > 0)
  if (valid.length === 0) return
  // Bump generation BEFORE Redux removal so in-flight responses discard.
  for (const id of valid) {
    bumpDeletionGeneration(id)
  }
  purgeResidentProjectionsForTopics(valid)
}

/**
 * Precisely clear topic-owned resident Redux projections for the deleted topics.
 * Preserves entities that belong to other topics (exclusive block removal).
 * Assumes generation has already been bumped.
 */
function purgeResidentProjectionsForTopics(deletedTopicIds: string[]): void {
  if (!Array.isArray(deletedTopicIds) || deletedTopicIds.length === 0) return
  const validIds = deletedTopicIds.filter((id) => typeof id === 'string' && id.length > 0)
  if (validIds.length === 0) return
  try {
    const state = store.getState()
    // Build set of blockIds referenced by non-deleted topics for exclusivity check.
    // Includes both message.blocks references and orphan blocks whose messageId
    // belongs to a surviving topic's resident messageIds (partial projection).
    const otherTopicBlockIds = new Set<string>()
    const survivingMessageIds = new Set<string>()
    for (const [tid, mids] of Object.entries(state.messages.messageIdsByTopic)) {
      if (validIds.includes(tid)) continue
      for (const mid of mids) {
        survivingMessageIds.add(mid)
        const msg = state.messages.entities[mid]
        if (msg?.blocks) {
          for (const bid of msg.blocks) otherTopicBlockIds.add(bid)
        }
      }
    }
    // Include orphan blocks for surviving topics (partial projection).
    for (const block of Object.values(state.messageBlocks.entities) as Array<
      { id: string; messageId?: string } | undefined
    >) {
      if (block && typeof block.messageId === 'string' && survivingMessageIds.has(block.messageId)) {
        otherTopicBlockIds.add(block.id)
      }
    }

    for (const topicId of validIds) {
      const messageIds = (state.messages.messageIdsByTopic[topicId] as string[] | undefined) ?? []
      if (messageIds.length > 0) {
        const blockIdsForTopic: string[] = []
        for (const mid of messageIds) {
          const msg = state.messages.entities[mid]
          if (msg?.blocks) blockIdsForTopic.push(...msg.blocks)
        }
        // Also include orphan blocks whose messageId belongs to this deleted topic
        // even if the message entity is missing (partial projection).
        const messageIdSet = new Set(messageIds)
        for (const block of Object.values(state.messageBlocks.entities) as Array<
          { id: string; messageId?: string } | undefined
        >) {
          if (block && typeof block.messageId === 'string' && messageIdSet.has(block.messageId)) {
            blockIdsForTopic.push(block.id)
          }
        }
        const exclusiveBlockIds = blockIdsForTopic.filter((bid) => !otherTopicBlockIds.has(bid))
        // Remove messages first (removes from messageIdsByTopic and entities)
        store.dispatch(newMessagesActions.removeMessages({ topicId, messageIds }))
        if (exclusiveBlockIds.length > 0) {
          // Deduplicate
          const unique = [...new Set(exclusiveBlockIds)]
          store.dispatch(removeManyBlocks(unique))
        }
      }
      // Segments
      store.dispatch(clearSegmentsForTopic(topicId))
      // Loading / fulfilled markers
      store.dispatch(newMessagesActions.setTopicLoading({ topicId, loading: false }))
      store.dispatch(newMessagesActions.setTopicFulfilled({ topicId, fulfilled: false }))
      // Current topic marker
      if (state.messages.currentTopicId === topicId) {
        store.dispatch(newMessagesActions.setCurrentTopicId(null))
      }
    }
  } catch {
    // projection purge is best-effort; never throw
  }
}

/**
 * Fail-closed check: stale if current generation differs from captured.
 */
export function isDeletionStale(topicId: string, capturedGeneration: number): boolean {
  return (deletionGenerations.get(topicId) ?? 0) !== capturedGeneration
}

/**
 * Capture current generation for an in-flight request.
 */
export function captureDeletionGeneration(topicId: string): number {
  return getDeletionGeneration(topicId)
}

/** For tests: reset all deletion generations. */
export function resetAllDeletionGenerationsForTests(): void {
  deletionGenerations.clear()
  deletionListeners.clear()
}

/** For tests/diagnostics: clear all and window/closure (not part of product flow). */
export function resetAllDeletionStateForTests(): void {
  deletionGenerations.clear()
  deletionListeners.clear()
  clearAllLatestWindowCompleteness()
}

/** For tests: reset only the generation subscription state. */
export function resetDeletionGenerationSubscriptionsForTests(): void {
  deletionListeners.clear()
}
