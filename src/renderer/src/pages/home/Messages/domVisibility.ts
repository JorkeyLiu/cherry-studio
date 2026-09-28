/**
 * Shared DOM visibility helpers for message elements.
 *
 * Used by:
 *   - `findFirstVisibleMessage` in Messages.tsx (load-more anchoring)
 *   - `findFirstVisibleMessageId` in useScrollPosition.ts (scroll position saving)
 *
 * Stable "viewport-top content anchor" semantics (single implementation):
 *   1. Prefer the row crossing the container top edge
 *      (`rect.top <= containerTop` and `rect.bottom > containerTop`).
 *      When several cross (overlap), the topmost (smallest top) wins.
 *   2. Otherwise the visible row with the smallest top at/after the top edge
 *      (first row below the edge). This is NOT a `min(abs(top - containerTop))`
 *      midpoint model: a far-above row near the edge in absolute distance must
 *      never beat the actual crossing/below row.
 *
 * Both pickers share the pure `pickViewportTopAnchor` core so map-based and
 * query-based call sites cannot drift apart.
 */

export interface ViewportTopCandidate {
  id: string
  top: number
  bottom: number
}

export interface ViewportTopAnchor extends ViewportTopCandidate {
  /** top - containerTop (negative when the row crosses the top edge). */
  intraRowOffset: number
}

/**
 * Pure viewport-top content anchor choice. `containerTop` is the container's
 * top in the same coordinate space as candidate tops/bottoms.
 * Returns null when no candidate is supplied; callers filter visibility first.
 */
export const pickViewportTopAnchor = (
  candidates: readonly ViewportTopCandidate[],
  containerTop: number
): ViewportTopAnchor | null => {
  if (candidates.length === 0) return null
  // Crossing candidates first: row straddles the top edge.
  let crossing: ViewportTopAnchor | null = null
  for (const c of candidates) {
    if (c.top <= containerTop && c.bottom > containerTop) {
      const anchor: ViewportTopAnchor = { ...c, intraRowOffset: c.top - containerTop }
      if (!crossing || anchor.top < crossing.top) crossing = anchor
    }
  }
  if (crossing) return crossing
  // Otherwise the smallest top at/after the edge (first row below the edge).
  let below: ViewportTopAnchor | null = null
  for (const c of candidates) {
    if (c.top < containerTop) continue
    const anchor: ViewportTopAnchor = { ...c, intraRowOffset: c.top - containerTop }
    if (!below || anchor.top < below.top) below = anchor
  }
  if (below) return below
  // All candidates are above the edge but the caller considered them visible
  // (degenerate overlap): fall back to the lowest bottom (nearest to edge).
  let nearest: ViewportTopAnchor | null = null
  for (const c of candidates) {
    const anchor: ViewportTopAnchor = { ...c, intraRowOffset: c.top - containerTop }
    if (!nearest || anchor.bottom > nearest.bottom) nearest = anchor
  }
  return nearest
}

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

/** Extract the stable message id from a `message-<id>` element id. */
const messageIdOf = (elementId: string): string => elementId.replace(/^message-/, '')

/**
 * Finds the stable viewport-top content anchor among registered message
 * elements. See module header for crossing-first semantics.
 */
export const findFirstVisibleMessage = (
  container: HTMLElement | null,
  elements: Map<string, HTMLElement>
): { element: HTMLElement; rect: DOMRect } | null => {
  if (!container) return null
  const containerRect = container.getBoundingClientRect()

  const candidates: ViewportTopCandidate[] = []
  const byId = new Map<string, { element: HTMLElement; rect: DOMRect }>()
  for (const el of elements.values()) {
    if (!isElementVisibleInViewport(el, containerRect)) continue
    const rect = el.getBoundingClientRect()
    const id = el.id ? messageIdOf(el.id) : ''
    candidates.push({ id, top: rect.top, bottom: rect.bottom })
    if (!byId.has(id)) byId.set(id, { element: el, rect })
  }
  const picked = pickViewportTopAnchor(candidates, containerRect.top)
  if (!picked) return null
  return byId.get(picked.id) ?? null
}

/**
 * Finds the viewport-top content anchor id plus its intra-row offset.
 * Query-based variant: scans the DOM for `[id^="message-"]` elements.
 * Shares `pickViewportTopAnchor` with the map-based picker (same semantics).
 */
export const findViewportTopAnchorWithOffset = (
  container: HTMLElement | null
): { messageId: string; intraRowOffset: number } | null => {
  if (!container) return null
  const containerRect = container.getBoundingClientRect()
  // Exclude message-group-* containers — their IDs are not valid message IDs
  const elements = container.querySelectorAll('[id^="message-"]:not([id^="message-group-"])')

  const candidates: ViewportTopCandidate[] = []
  for (const el of elements) {
    if (!(el instanceof HTMLElement)) continue
    if (!isElementVisibleInViewport(el, containerRect)) continue
    const rect = el.getBoundingClientRect()
    candidates.push({ id: messageIdOf(el.id), top: rect.top, bottom: rect.bottom })
  }
  const picked = pickViewportTopAnchor(candidates, containerRect.top)
  if (!picked) return null
  return { messageId: picked.id, intraRowOffset: picked.intraRowOffset }
}

/**
 * Finds the ID of the stable viewport-top content anchor in the scroll container.
 * Query-based variant (same crossing-first semantics as `findFirstVisibleMessage`).
 *
 * Used by useScrollPosition for scroll-position anchor persistence.
 */
export const findFirstVisibleMessageId = (container: HTMLElement | null): string | null => {
  return findViewportTopAnchorWithOffset(container)?.messageId ?? null
}
