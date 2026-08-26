import { findFirstVisibleMessageId } from '@renderer/pages/home/Messages/domVisibility'
import {
  handleScrollSnapshotCleared,
  handleScrollSnapshotRead,
  handleScrollSnapshotSaved,
  isScrollSnapshotInvalidated
} from '@renderer/services/scrollSnapshotCache'
import { subscribeDeletionGeneration } from '@renderer/services/topicDeletionInvalidation'
import { throttle } from 'lodash'
import { useCallback, useEffect, useMemo, useRef } from 'react'

interface SavedScrollPosition {
  scrollTop: number
  anchorId: string | null
  isAtBottom: boolean
}

const BOTTOM_THRESHOLD = 50 // px

/**
 * A custom hook that manages scroll position persistence for a container element
 * @param key - A unique identifier used to store/retrieve the scroll position
 * @returns An object containing:
 *  - containerRef: React ref for the scrollable container
 *  - handleScroll: Throttled scroll event handler that saves scroll position
 *  - getSavedPosition: Retrieve the saved scroll position with optional anchor message ID
 *  - clearSavedPosition: Remove the persisted scroll position for this key
 *  - savePosition: Immediately persist the current scroll position (non-throttled),
 *    intended for post-navigation snapshot persistence
 */
export default function useScrollPosition(key: string, throttleWait?: number) {
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollKey = useMemo(() => `scroll:${key}`, [key])
  const scrollKeyRef = useRef(scrollKey)

  const persistScrollPosition = useMemo(
    () =>
      throttle((snapshot: SavedScrollPosition) => {
        const k = scrollKeyRef.current
        if (isScrollSnapshotInvalidated(k)) {
          try {
            window.keyv.remove(k)
          } catch {}
          return
        }
        window.keyv.set(k, snapshot)
        handleScrollSnapshotSaved(k)
      }, throttleWait ?? 100),
    [throttleWait]
  )

  // Durably block pending trailing writes for hard-deleted topics: subscribe to
  // authoritative deletion generation and cancel any pending throttle trailing
  // when the topic is hard-deleted. Hard-delete also marks the scroll key as
  // invalidated in the cache so late flushes cannot recreate the snapshot.
  const topicIdForDeletion = useMemo(() => {
    if (!key.startsWith('topic-')) return null
    return key.slice('topic-'.length)
  }, [key])

  useEffect(() => {
    if (!topicIdForDeletion) return
    return subscribeDeletionGeneration(topicIdForDeletion, () => {
      persistScrollPosition.cancel()
    })
  }, [topicIdForDeletion, persistScrollPosition])

  // Update scrollKeyRef on key change. On cleanup (key change or unmount),
  // flush the pending trailing snapshot to the OLD key (scrollKeyRef still
  // points to it), then cancel to prevent any subsequent timer from firing.
  // This ensures the user's last scroll position is not lost on topic switch.
  // Flush respects invalidation so a hard-deleted key is not recreated.
  useEffect(() => {
    scrollKeyRef.current = scrollKey
    return () => {
      persistScrollPosition.flush()
      persistScrollPosition.cancel()
    }
  }, [scrollKey, persistScrollPosition])

  const handleScroll = useCallback(() => {
    const container = containerRef.current
    if (!container) return

    const scrollTop = container.scrollTop
    const snapshot: SavedScrollPosition = {
      scrollTop,
      anchorId: findFirstVisibleMessageId(container),
      // In column-reverse layout, scrollTop ≈ 0 means at the bottom (newest messages)
      isAtBottom: Math.abs(scrollTop) <= BOTTOM_THRESHOLD
    }

    persistScrollPosition(snapshot)
  }, [persistScrollPosition])

  const getSavedPosition = useCallback((): SavedScrollPosition | null => {
    const saved = window.keyv.get(scrollKeyRef.current)
    let result: SavedScrollPosition | null = null
    if (saved && typeof saved === 'object' && 'scrollTop' in saved) {
      // Support legacy saved positions without isAtBottom
      if (!('isAtBottom' in saved)) {
        result = { ...(saved as Omit<SavedScrollPosition, 'isAtBottom'>), isAtBottom: false }
      } else {
        result = saved as SavedScrollPosition
      }
    } else if (typeof saved === 'number') {
      // Backward compatibility: if saved is a plain number
      result = { scrollTop: saved, anchorId: null, isAtBottom: false }
    }
    if (result !== null) {
      handleScrollSnapshotRead(scrollKeyRef.current)
    }
    return result
  }, [])

  const clearSavedPosition = useCallback(() => {
    window.keyv.remove(scrollKeyRef.current)
    handleScrollSnapshotCleared(scrollKeyRef.current)
  }, [])

  /**
   * Immediately persist the current scroll position, bypassing throttle.
   * Cancels any pending throttle trailing first to prevent a subsequent
   * timer or unmount flush from overwriting this explicit save.
   * Use this after programmatic navigations that bypass the scroll event
   * handler (e.g. message navigation transactions) so the new position
   * is available for saved-position restore on topic switch.
   */
  const savePosition = useCallback(() => {
    persistScrollPosition.cancel()

    const k = scrollKeyRef.current
    if (isScrollSnapshotInvalidated(k)) {
      try {
        window.keyv.remove(k)
      } catch {}
      return
    }

    const container = containerRef.current
    if (!container) return

    const scrollTop = container.scrollTop
    const snapshot: SavedScrollPosition = {
      scrollTop,
      anchorId: findFirstVisibleMessageId(container),
      isAtBottom: Math.abs(scrollTop) <= BOTTOM_THRESHOLD
    }

    window.keyv.set(k, snapshot)
    handleScrollSnapshotSaved(k)
  }, [persistScrollPosition])

  return { containerRef, handleScroll, getSavedPosition, clearSavedPosition, savePosition }
}
