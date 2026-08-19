import type { Dispatch, MutableRefObject } from 'react'
import { useLayoutEffect, useRef } from 'react'

import type { MessageViewportAction } from '../pages/home/Messages/messageViewportReducer'

export interface TopicTransitionOptions {
  /** Current topic ID from props */
  topicId: string
  /** Viewport reducer dispatch for topic/reset */
  viewportDispatch: Dispatch<MessageViewportAction>
  /** Callback to reset bootstrap phase to 'idle' */
  resetBootstrapPhase: () => void
  /** Callback to clear all topic-scoped timers */
  clearTimers: () => void
  /** Callback to reset saved-restore-handled flag for new topic activation */
  resetSavedRestore: () => void
  /** Callback to reset onFirstUpdate fired ref so it fires once per topic */
  resetOnFirstUpdate: () => void
  /** Ref whose .current is incremented on every detected topic transition.
   *  Async completion guards compare captured epoch against this ref to
   *  reject stale callbacks that outlive a topic change — even when the
   *  same topic ID is revisited (A→B→A). */
  transitionEpochRef: MutableRefObject<number>
}

/**
 * Renderer-local topic transition coordinator.
 *
 * Replaces key-driven full Messages subtree remounting with an explicit
 * transition owner. When the topic prop changes, this hook orchestrates
 * the deterministic phase ordering:
 *
 *   1. Save/flush scroll position (handled by useScrollPosition key change)
 *   2. Reset viewport (topic/reset action → generation advance, stale rejection)
 *   3. Clear timers (loadMoreMessages, loadNewerMessages, etc.)
 *   4. Reset bootstrap phase to 'idle' for new-topic activation
 *   5. Reset saved-restore-handled flag for new topic's scroll restore
 *   6. Reset onFirstUpdate fired ref so first-update fires per topic
 *
 * Uses useLayoutEffect (not useEffect) so that the viewport reset and all
 * cleanup run synchronously before the browser paints. This prevents the old
 * topic's viewport from ever being visible under the new topic's identity.
 *
 * The Messages component remains mounted across topic changes. The viewport
 * reducer's topicGeneration and navigation.generation advances ensure
 * stale work from the old topic cannot commit into the new topic.
 *
 * This hook does NOT:
 * - Manage scroll persistence (useScrollPosition handles that via key change)
 * - Trigger loadTopicMessagesThunk (useActiveTopic dispatches that)
 * - Manage bootstrap restore (the existing bootstrap effect handles that)
 * - Introduce any persistent transition store or cross-process coordination
 */
export function useTopicTransition({
  topicId,
  viewportDispatch,
  resetBootstrapPhase,
  clearTimers,
  resetSavedRestore,
  resetOnFirstUpdate,
  transitionEpochRef
}: TopicTransitionOptions): void {
  const prevTopicIdRef = useRef(topicId)

  // S3.1 Blocker 2 correction: use useLayoutEffect instead of useEffect
  // so the viewport reset runs synchronously before the browser paints.
  // A passive useEffect would permit the old topic's viewport to commit
  // and paint under the new topic's identity before cleanup fires.
  useLayoutEffect(() => {
    if (prevTopicIdRef.current !== topicId) {
      prevTopicIdRef.current = topicId

      // Increment transition epoch so async completion guards can detect
      // stale callbacks — even when the same topic ID is revisited (A→B→A).
      transitionEpochRef.current += 1

      // Phase 1: Reset viewport state — advances topicGeneration and
      // navigation.generation, invalidating all stale loads and navigations
      // from the previous topic.
      viewportDispatch({ type: 'topic/reset' })

      // Phase 2: Clear topic-scoped timers (loadMoreMessages, loadNewerMessages)
      clearTimers()

      // Phase 3: Reset bootstrap phase so the new topic's activation
      // can run its own bootstrap (pending > saved restore > default).
      resetBootstrapPhase()

      // Phase 4: Reset saved-restore-handled flag so the new topic can
      // restore its own scroll position on first bootstrap.
      resetSavedRestore()

      // Phase 5: Reset onFirstUpdate fired ref so the callback fires
      // once for the new topic, not suppressed by the old topic's flag.
      resetOnFirstUpdate()
    }
  })
}
