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
  /** S3.2: Explicit old-topic scroll save callback. Called before topic/reset
   *  so the previous topic's scroll position is snapshotted to the old key
   *  before the transition resets viewport state. The callback is the
   *  existing useScrollPosition.savePosition — it cancels the pending
   *  throttle, snapshots the current DOM scroll, and writes to the current
   *  scroll key (which still points to the old topic at call time). */
  saveOldTopicScrollPosition: () => void
}

/**
 * Renderer-local topic transition coordinator.
 *
 * Replaces key-driven full Messages subtree remounting with an explicit
 * transition owner. When the topic prop changes, this hook orchestrates
 * the deterministic phase ordering:
 *
 *   1. Save/flush old-topic scroll position (explicit savePosition call)
 *   2. Increment transition epoch (stale callback rejection for A→B→A)
 *   3. Reset viewport (topic/reset action → generation advance, stale rejection)
 *   4. Clear timers (loadMoreMessages, loadNewerMessages, etc.)
 *   5. Reset bootstrap phase to 'idle' for new-topic activation
 *   6. Reset saved-restore-handled flag for new topic's scroll restore
 *   7. Reset onFirstUpdate fired ref so first-update fires per topic
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
  transitionEpochRef,
  saveOldTopicScrollPosition
}: TopicTransitionOptions): void {
  const prevTopicIdRef = useRef(topicId)

  // S3.1 Blocker 2 correction: use useLayoutEffect instead of useEffect
  // so the viewport reset runs synchronously before the browser paints.
  // A passive useEffect would permit the old topic's viewport to commit
  // and paint under the new topic's identity before cleanup fires.
  useLayoutEffect(() => {
    if (prevTopicIdRef.current !== topicId) {
      // S3.2: Explicit old-topic scroll save BEFORE any transition state
      // changes. The scroll key still points to the old topic at this
      // point, so savePosition snapshots the old topic's DOM scroll to
      // the old key. This replaces the implicit passive cleanup in
      // useScrollPosition's key-change effect.
      saveOldTopicScrollPosition()

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
