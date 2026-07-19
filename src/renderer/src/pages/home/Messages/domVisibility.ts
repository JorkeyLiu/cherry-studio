/**
 * Shared DOM visibility helpers for message elements.
 *
 * Used by:
 *   - `findFirstVisibleMessage` in Messages.tsx (load-more anchoring)
 *   - `findFirstVisibleMessageId` in useScrollPosition.ts (scroll position saving)
 *
 * Centralizing the visibility logic prevents two divergent implementations
 * from drifting apart (e.g. one filtering folded messages, the other not).
 */

/**
 * Determines whether an element should be considered "visible" for anchoring
 * and scroll-position purposes.
 *
 * Filters out:
 *   - Elements with `display: none` (e.g. folded siblings in multi-model groups)
 *   - Elements with zero rendered height
 *   - Elements that do not intersect the container viewport
 *
 * @param el - The candidate element
 * @param containerRect - The bounding rect of the scroll container
 * @returns `true` when the element intersects the container viewport with non-zero height
 */
export const isElementVisibleInViewport = (el: HTMLElement, containerRect: DOMRect): boolean => {
  // display:none → getComputedStyle is the authoritative check
  // (offsetHeight can be 0 for other reasons, so we check computed style first)
  const style = window.getComputedStyle(el)
  if (style.display === 'none') return false

  const rect = el.getBoundingClientRect()

  // Zero-height elements are not visible (includes visibility:hidden which also yields 0)
  if (rect.height === 0) return false

  // Check intersection with the container viewport
  const visibleHeight = Math.min(rect.bottom, containerRect.bottom) - Math.max(rect.top, containerRect.top)
  return visibleHeight > 0
}

/**
 * Finds the first visible message element closest to the container top.
 *
 * Skips elements that are disconnected, hidden (display:none), zero-height,
 * or outside the container viewport.
 *
 * @param container - The scroll container element (e.g. #messages)
 * @param elements - A map of message ID → registered HTMLElement
 * @returns The element and its bounding rect, or null if no visible element found
 */
export const findFirstVisibleMessage = (
  container: HTMLElement | null,
  elements: Map<string, HTMLElement>
): { element: HTMLElement; rect: DOMRect } | null => {
  if (!container) return null
  const containerRect = container.getBoundingClientRect()

  let closest: { element: HTMLElement; rect: DOMRect } | null = null
  let minDistance = Infinity
  for (const el of elements.values()) {
    if (!isElementVisibleInViewport(el, containerRect)) continue
    const rect = el.getBoundingClientRect()
    const distance = Math.abs(rect.top - containerRect.top)
    if (distance < minDistance) {
      minDistance = distance
      closest = { element: el, rect }
    }
  }
  return closest
}

/**
 * Finds the ID of the first visible message element in the scroll container.
 * Query-based variant: scans the DOM for `[id^="message-"]` elements.
 *
 * Used by useScrollPosition for scroll-position anchor persistence.
 *
 * @param container - The scroll container element
 * @returns The message ID (without the `message-` prefix), or null
 */
export const findFirstVisibleMessageId = (container: HTMLElement | null): string | null => {
  if (!container) return null
  const containerRect = container.getBoundingClientRect()
  // Exclude message-group-* containers — their IDs are not valid message IDs
  const elements = container.querySelectorAll('[id^="message-"]:not([id^="message-group-"])')

  let closestId: string | null = null
  let minDistance = Infinity
  for (const el of elements) {
    if (!(el instanceof HTMLElement)) continue
    if (!isElementVisibleInViewport(el, containerRect)) continue
    const rect = el.getBoundingClientRect()
    const distance = Math.abs(rect.top - containerRect.top)
    if (distance < minDistance) {
      minDistance = distance
      closestId = el.id.replace('message-', '')
    }
  }
  return closestId
}
