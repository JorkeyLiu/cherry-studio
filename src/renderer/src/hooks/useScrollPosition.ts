import { findFirstVisibleMessageId } from '@renderer/pages/home/Messages/domVisibility'
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
 *  - clearSavedPosition: Clear the saved scroll position
 */
export default function useScrollPosition(key: string, throttleWait?: number) {
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollKey = useMemo(() => `scroll:${key}`, [key])
  const scrollKeyRef = useRef(scrollKey)

  useEffect(() => {
    scrollKeyRef.current = scrollKey
  }, [scrollKey])

  const persistScrollPosition = useMemo(
    () =>
      throttle((snapshot: SavedScrollPosition) => {
        window.keyv.set(scrollKeyRef.current, snapshot)
      }, throttleWait ?? 100),
    [throttleWait]
  )

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
    if (saved && typeof saved === 'object' && 'scrollTop' in saved) {
      // Support legacy saved positions without isAtBottom
      if (!('isAtBottom' in saved)) {
        return { ...(saved as Omit<SavedScrollPosition, 'isAtBottom'>), isAtBottom: false }
      }
      return saved as SavedScrollPosition
    }
    // Backward compatibility: if saved is a plain number
    if (typeof saved === 'number') {
      return { scrollTop: saved, anchorId: null, isAtBottom: false }
    }
    return null
  }, [])

  const clearSavedPosition = useCallback(() => {
    window.keyv.remove(scrollKeyRef.current)
  }, [])

  useEffect(() => {
    return () => {
      persistScrollPosition.flush()
      persistScrollPosition.cancel()
    }
  }, [persistScrollPosition])

  return { containerRef, handleScroll, getSavedPosition, clearSavedPosition }
}
