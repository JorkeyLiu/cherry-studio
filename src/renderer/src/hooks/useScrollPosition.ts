import { throttle } from 'lodash-es'
import { useCallback, useEffect, useMemo, useRef } from 'react'

/**
 * Find the ID of the first visible message element in the scroll container.
 * "First visible" means the element closest to the container top.
 */
const findFirstVisibleMessageId = (container: HTMLElement | null): string | null => {
  if (!container) return null
  const containerRect = container.getBoundingClientRect()
  // Exclude message-group-* containers — their IDs are not valid message IDs
  const elements = container.querySelectorAll('[id^="message-"]:not([id^="message-group-"])')

  let closestId: string | null = null
  let minDistance = Infinity
  for (const el of elements) {
    const rect = el.getBoundingClientRect()
    // Skip hidden elements (folded messages in groups have display:none → height 0)
    if (rect.height === 0) continue
    const distance = Math.abs(rect.top - containerRect.top)
    if (distance < minDistance) {
      minDistance = distance
      closestId = el.id.replace('message-', '')
    }
  }
  return closestId
}

/**
 * A custom hook that manages scroll position persistence for a container element
 * @param key - A unique identifier used to store/retrieve the scroll position
 * @returns An object containing:
 *  - containerRef: React ref for the scrollable container
 *  - handleScroll: Throttled scroll event handler that saves scroll position
 *  - getSavedPosition: Retrieve the saved scroll position with optional anchor message ID
 */
export default function useScrollPosition(key: string, throttleWait?: number) {
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollKey = useMemo(() => `scroll:${key}`, [key])
  const scrollKeyRef = useRef(scrollKey)

  useEffect(() => {
    scrollKeyRef.current = scrollKey
  }, [scrollKey])

  const handleScroll = throttle(() => {
    const container = containerRef.current
    if (!container) return
    const position = container.scrollTop
    const anchorId = findFirstVisibleMessageId(container)
    window.requestAnimationFrame(() => {
      window.keyv.set(scrollKeyRef.current, { scrollTop: position, anchorId })
    })
  }, throttleWait ?? 100)

  const getSavedPosition = useCallback(() => {
    const saved = window.keyv.get(scrollKeyRef.current)
    if (saved && typeof saved === 'object' && 'scrollTop' in saved) {
      return saved as { scrollTop: number; anchorId: string | null }
    }
    // Backward compatibility: if saved is a plain number
    if (typeof saved === 'number') {
      return { scrollTop: saved, anchorId: null }
    }
    return null
  }, [])

  const clearSavedPosition = useCallback(() => {
    window.keyv.remove(scrollKeyRef.current)
  }, [])

  useEffect(() => {
    return () => handleScroll.cancel()
  }, [handleScroll])

  return { containerRef, handleScroll, getSavedPosition, clearSavedPosition }
}
