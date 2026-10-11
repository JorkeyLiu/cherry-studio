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
 *
 * Viewport-local canonical VISUAL ROW index (steady-scroll path):
 *   - Production `displayMessages` are newest-first (column-reverse view model;
 *     see `messageWindow.toReversed`). The rendered visual order is oldest-first
 *     top-to-bottom: the outer flow is newest-group-first under `column-reverse`
 *     (so the oldest group paints at the top) and each group's inner messages
 *     stay oldest-first in normal grid flow. Fold hides unselected siblings
 *     (`display:none`); dividers/gaps carry no message identity.
 *   - `createVisibleAnchorCache` builds the visible canonical rows ONCE per
 *     row/window/fold change: pointer-only membership from the window order,
 *     one style + rect read per member row, then a single sort by live top.
 *     The sorted order is reused for every scroll capture (ordinary scrolling
 *     never reorders rows; late height changes shift tops but keep ordering).
 *   - Routine captures pay O(log N) rect reads (binary lower-bound on live
 *     tops) + O(1) validation of the two boundary neighbours — never a
 *     per-row scan and never a bounded-guess skip/validate/extend window.
 *     Stale geometry (unmeasurable probe, failed validation) fails closed to
 *     the exact full-list scan, which preserves identical semantics.
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
 * Raw message-row lookup by stable message id.
 *
 * Contract: `document.getElementById` requires the RAW id string — never
 * `CSS.escape` it. Writers use raw `id={'message-'+message.id}`, so readers
 * must use raw `getElementById('message-'+messageId)`. `CSS.escape` is only
 * for `querySelector`/selector contexts. Returns the connected row or null.
 *
 * The registry (`messageElements`) holds the same canonical outer element:
 * each message renders an outer fold wrapper plus an inner content box under
 * the same `message-<id>` (plus `data-message-id` on the inner box), and
 * `getElementById` returns the first in document order — the outer wrapper.
 * Keeper geometry (`resolveRealMessageBox`) intentionally measures the inner
 * box instead; anchor membership stays on this canonical outer row.
 */
export const getMessageRowById = (messageId: string): HTMLElement | null => {
  try {
    const el = document.getElementById(`message-${messageId}`)
    if (!(el instanceof HTMLElement)) return null
    return el.isConnected ? el : null
  } catch {
    return null
  }
}

/**
 * Builds the visual-order anchor-row membership from the stable newest-first
 * display ids plus the live element registry.
 *
 * Visual order is oldest-first top-to-bottom (the reverse of the newest-first
 * `displayMessages` consumed by the column-reverse view; group inner order is
 * oldest-first in normal flow). O(N) cheap pointer lookups only — no selector,
 * no style, no geometry. Missing/detached ids are skipped (cheap
 * `isConnected`, no layout). Hidden/fold rows STAY listed here; the visible
 * cache below filters them once at build time, so this membership alone is
 * never used directly for geometry.
 */
export const buildVisualAnchorMembership = (
  displayNewestFirst: readonly string[],
  registry: ReadonlyMap<string, HTMLElement>
): HTMLElement[] => {
  const rows: HTMLElement[] = []
  for (let i = displayNewestFirst.length - 1; i >= 0; i--) {
    const id = displayNewestFirst[i]
    let el: HTMLElement | undefined
    try {
      el = registry.get(id)
    } catch {
      el = undefined
    }
    if (!(el instanceof HTMLElement)) continue
    try {
      if (!el.isConnected) continue
    } catch {
      continue
    }
    rows.push(el)
  }
  return rows
}

/**
 * Measurable-container check for cache builds (inline `display:none` / hidden
 * ancestor walk plus connectedness). Mirrors the keeper capturer's hidden
 * guard without importing it. Never infers hidden from zero rects alone, so
 * visible jsdom surfaces keep building.
 */
const isContainerMeasurable = (container: HTMLElement | null): container is HTMLElement => {
  if (!container) return false
  try {
    if (!container.isConnected) return false
  } catch {
    return false
  }
  try {
    let el: HTMLElement | null = container
    while (el) {
      try {
        const style = el.style as CSSStyleDeclaration | undefined
        if (style && style.display === 'none') return false
        if (el.hidden === true) return false
      } catch {}
      el = el.parentElement
    }
  } catch {}
  return true
}

/** Window shape the visible cache reads membership from (only `displayMessages`). */
export interface VisibleAnchorWindow {
  readonly displayMessages: readonly { readonly id: string }[]
}

export interface VisibleAnchorCacheInput {
  container: HTMLElement | null
  window: VisibleAnchorWindow | null | undefined
  registry: ReadonlyMap<string, HTMLElement>
  /** Bumped by `registerMessageElement` on actual set/delete (O(1) compare). */
  registryVersion: number
  /** Bumped by the projection commit effect on fold-selection change (O(1) compare). */
  foldVersion: number
}

export interface VisibleAnchorCacheStats {
  /** Number of O(N) rebuilds performed. */
  builds: number
  /** Cached visible row count. */
  visible: number
  /** Membership size at the last rebuild. */
  lastBuildMembers: number
  /** Visible size at the last rebuild. */
  lastBuildVisible: number
}

const EMPTY_VISIBLE_ROWS: readonly HTMLElement[] = []

/**
 * Viewport-local canonical VISUAL ROW index.
 *
 * Rebuilds (O(N) style + rect reads plus one in-memory sort by live top) only
 * when the window reference, registry version, or fold version changes — i.e.
 * on row/window/fold commits, never on ordinary scroll. The fast path is a
 * pure O(1) key comparison with no style, no rect, no allocation. While the
 * container is unmeasurable (detached/hidden route) the build defers and keeps
 * returning the stale rows without adopting the new key, so a hidden rebuild
 * can never poison the index; the next visible capture rebuilds.
 *
 * Stable rows may change height late (images/markdown) without invalidating
 * the cached ORDER: only tops shift, top-to-bottom ordering is preserved, and
 * the binary search re-reads live geometry on the cached order.
 */
export const createVisibleAnchorCache = (): {
  getVisibleRows: (input: VisibleAnchorCacheInput) => readonly HTMLElement[]
  stats: () => VisibleAnchorCacheStats
} => {
  let cachedRows: readonly HTMLElement[] = EMPTY_VISIBLE_ROWS
  let cachedWindow: VisibleAnchorWindow | null | undefined = undefined
  let cachedRegistryVersion = -1
  let cachedFoldVersion = -1
  let hasCache = false
  let builds = 0
  let lastBuildMembers = 0
  let lastBuildVisible = 0

  const getVisibleRows = (input: VisibleAnchorCacheInput): readonly HTMLElement[] => {
    const { container, window: anchorWindow, registry, registryVersion, foldVersion } = input
    if (
      hasCache &&
      anchorWindow === cachedWindow &&
      registryVersion === cachedRegistryVersion &&
      foldVersion === cachedFoldVersion
    ) {
      return cachedRows
    }
    const display = anchorWindow?.displayMessages
    if (!display || display.length === 0) {
      cachedRows = EMPTY_VISIBLE_ROWS
      cachedWindow = anchorWindow
      cachedRegistryVersion = registryVersion
      cachedFoldVersion = foldVersion
      hasCache = true
      lastBuildMembers = 0
      lastBuildVisible = 0
      builds += 1
      return cachedRows
    }
    // Hidden/detached route: keep the stale index and stay dirty. The capture
    // paths already guard hidden containers; adopting zero-box geometry here
    // would poison reactivation.
    if (!isContainerMeasurable(container)) {
      return hasCache ? cachedRows : EMPTY_VISIBLE_ROWS
    }
    // Membership: visual (oldest-first) pointer join, no style/rect.
    const members: HTMLElement[] = []
    for (let i = display.length - 1; i >= 0; i--) {
      let id: string | undefined
      try {
        id = display[i]?.id
      } catch {
        id = undefined
      }
      if (typeof id !== 'string' || id.length === 0) continue
      let el: HTMLElement | undefined
      try {
        el = registry.get(id)
      } catch {
        el = undefined
      }
      if (!(el instanceof HTMLElement)) continue
      try {
        if (!el.isConnected) continue
      } catch {
        continue
      }
      members.push(el)
    }
    lastBuildMembers = members.length
    // Visible filter + live-top capture (one style + one rect per member),
    // then a single in-memory sort establishes true visual order. Ordinary
    // scrolling never reorders, so this order is reused until the next
    // row/window/fold commit.
    const measured: { element: HTMLElement; top: number; bottom: number }[] = []
    for (const el of members) {
      let displayStyle: string | undefined
      try {
        displayStyle = window.getComputedStyle(el).display
      } catch {
        continue
      }
      if (displayStyle === 'none') continue
      let top = NaN
      let bottom = NaN
      try {
        const r = el.getBoundingClientRect()
        top = r.top
        bottom = r.bottom
      } catch {
        continue
      }
      if (!Number.isFinite(top) || !Number.isFinite(bottom)) continue
      if (!(bottom - top > 0)) continue
      measured.push({ element: el, top, bottom })
    }
    measured.sort((a, b) => a.top - b.top || a.bottom - b.bottom)
    cachedRows = measured.map((m) => m.element)
    cachedWindow = anchorWindow
    cachedRegistryVersion = registryVersion
    cachedFoldVersion = foldVersion
    hasCache = true
    lastBuildVisible = cachedRows.length
    builds += 1
    return cachedRows
  }

  const stats = (): VisibleAnchorCacheStats => ({
    builds,
    visible: cachedRows.length,
    lastBuildMembers,
    lastBuildVisible
  })

  return { getVisibleRows, stats }
}

/**
 * Finds the stable viewport-top content anchor among registered message
 * elements. See module header for crossing-first semantics.
 *
 * When `orderedRows` (the cached visible visual rows, oldest-first, one
 * canonical outer element per visible message id) is supplied, the anchor
 * resolves through the exact ordered core (`locateAnchorRowElement`: binary
 * lower-bound on live tops + O(1) neighbour validation, never a per-row
 * scan). Without it, the exact full-list scan below applies (same semantics;
 * exceptional no-registry path only).
 */
export const findFirstVisibleMessage = (
  container: HTMLElement | null,
  elements: Map<string, HTMLElement>,
  orderedRows?: readonly HTMLElement[]
): { element: HTMLElement; rect: DOMRect } | null => {
  if (!container) return null
  if (orderedRows && orderedRows.length > 0) {
    try {
      const located = locateAnchorRowElement(container, orderedRows)
      if (located && located.element.isConnected && container.contains(located.element)) {
        return { element: located.element, rect: located.element.getBoundingClientRect() }
      }
    } catch {
      // fail through to the exact scan below
    }
  }
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

interface LiveRowGeometry {
  element: HTMLElement
  top: number
  bottom: number
}

const liveRowGeometry = (el: HTMLElement): LiveRowGeometry | null => {
  try {
    if (!el.isConnected) return null
  } catch {
    return null
  }
  let top = NaN
  let bottom = NaN
  try {
    const r = el.getBoundingClientRect()
    top = r.top
    bottom = r.bottom
  } catch {
    return null
  }
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return null
  if (!(bottom - top > 0)) return null
  return { element: el, top, bottom }
}

/**
 * Exact ordered rendered-row geometry lookup (the steady-scroll anchor path).
 *
 * `rows` must be the cached visible visual rows (oldest-first top-to-bottom
 * as rendered; see `createVisibleAnchorCache`). Production message rows lay
 * out in normal block flow with no overlaps, so visible-row tops are strictly
 * increasing and a binary lower-bound on live `rect.top` finds the exact
 * crossing/first-below neighbours. Gaps (inter-row spacing), dividers, and
 * loaders at the container top need no special case: no message row crosses
 * the edge there, so the first row below the edge wins by construction.
 *
 * Routine cost is O(log N) rect reads plus O(1) full-visibility validation of
 * at most the two boundary neighbours (style + rect + intersection),
 * preserving the exact crossing-first / first-below semantics of
 * `pickViewportTopAnchor`. There are no skip limits, no validation radius, no
 * extend budget, and no presumed maximum hidden run: hidden/fold membership
 * is filtered once at cache build time, so any unmeasurable probe or failed
 * neighbour validation here means a stale index and fails closed (null) so
 * callers take the exact full-list scan with identical semantics. Overlays
 * never disturb this path (geometry, not hit-testing), so no hit-test
 * fallback exists here by design.
 */
export const locateAnchorRowElement = (
  container: HTMLElement,
  rows: readonly HTMLElement[]
): { element: HTMLElement; top: number; containerTop: number } | null => {
  const n = rows.length
  if (n === 0) return null
  let containerTop: number
  try {
    const containerRect = container.getBoundingClientRect()
    containerTop = containerRect.top
    if (!Number.isFinite(containerTop) || !Number.isFinite(containerRect.bottom)) return null
  } catch {
    return null
  }

  // Binary lower-bound: first index whose live row top is at/after the edge.
  // Every probe reflects real visible geometry; an unmeasurable probe means a
  // stale index (visibility/membership changed without a rebuild) and fails
  // closed to the exact scan instead of guessing.
  let lo = 0
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const probed = liveRowGeometry(rows[mid])
    if (!probed) return null
    if (probed.top < containerTop) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  const fb = lo

  // Exact neighbours: at most one crossing row can exist (normal flow, no
  // overlaps), so a crossing predecessor IS the answer; otherwise the
  // successor is the smallest top at/after the edge (first below) —
  // identical to `pickViewportTopAnchor`. A neighbour that fails the display
  // check or is unmeasurable means a stale index (visibility/membership
  // changed without a rebuild) and fails closed to the exact scan. A
  // measurable neighbour that simply does not intersect the viewport (the
  // normal above-gap or below-viewport case) is skipped, not fatal.
  let windowContainerRect: DOMRect
  try {
    windowContainerRect = container.getBoundingClientRect()
  } catch {
    return null
  }
  const candidates: ViewportTopCandidate[] = []
  const neighbourElements: HTMLElement[] = []
  for (const index of fb - 1 >= 0 ? [fb - 1, fb] : [fb]) {
    if (index < 0 || index >= n) continue
    const el = rows[index]
    let displayStyle: string | undefined
    try {
      displayStyle = window.getComputedStyle(el).display
    } catch {
      return null
    }
    if (displayStyle === 'none') return null
    let r: DOMRect
    try {
      r = el.getBoundingClientRect()
    } catch {
      return null
    }
    if (!Number.isFinite(r.top) || !Number.isFinite(r.bottom) || !(r.bottom - r.top > 0)) return null
    if (!isElementVisibleInViewport(el, windowContainerRect)) continue
    candidates.push({ id: messageIdOf(el.id), top: r.top, bottom: r.bottom })
    neighbourElements.push(el)
  }
  const picked = pickViewportTopAnchor(candidates, windowContainerRect.top)
  if (!picked) return null
  for (let k = 0; k < candidates.length; k++) {
    if (candidates[k].id === picked.id) {
      const el = neighbourElements[k]
      try {
        if (el.isConnected) return { element: el, top: picked.top, containerTop: windowContainerRect.top }
      } catch {
        return null
      }
    }
  }
  return null
}

/**
 * Ordered rendered-row anchor id + intra-row offset (steady-scroll path).
 * Thin wrapper over `locateAnchorRowElement`; see it for the algorithm and
 * complexity contract.
 */
export const findAnchorInOrderedRows = (
  container: HTMLElement,
  rows: readonly HTMLElement[]
): { messageId: string; intraRowOffset: number } | null => {
  let located: { element: HTMLElement; top: number; containerTop: number } | null = null
  try {
    located = locateAnchorRowElement(container, rows)
  } catch {
    return null
  }
  if (!located) return null
  return { messageId: messageIdOf(located.element.id), intraRowOffset: located.top - located.containerTop }
}

/**
 * Finds the viewport-top content anchor id plus its intra-row offset.
 * Shares `pickViewportTopAnchor` semantics across all paths.
 *
 * With `opts.orderedRows` (the cached visible visual rows via
 * `createVisibleAnchorCache`) the exact ordered core resolves with O(log N)
 * rects + O(1) neighbour validation — the steady-scroll path for row, gap,
 * and divider tops alike, including folded states. A null core result falls
 * through to the exact DOM scan (identical semantics; exceptional stale or
 * no-registry geometries only, never the routine gap). Without ordered rows
 * the exact full-list scan applies directly.
 */
export const findViewportTopAnchorWithOffset = (
  container: HTMLElement | null,
  opts?: { orderedRows?: readonly HTMLElement[] }
): { messageId: string; intraRowOffset: number } | null => {
  if (!container) return null
  const ordered = opts?.orderedRows
  if (ordered && ordered.length > 0) {
    try {
      const fast = findAnchorInOrderedRows(container, ordered)
      if (fast) return fast
    } catch {
      // fail through to the exact scan below
    }
  }
  const containerRect = container.getBoundingClientRect()
  // Exclude message-group-* containers — their IDs are not valid message IDs
  const elements = container.querySelectorAll('[id^="message-"]:not([id^="message-group-"])')

  // Deduplicate same-id nested wrappers (outer fold wrapper + inner content
  // box) to the geometrically correct row: smallest top wins. The registry
  // path holds one canonical element per id; this scan matches it
  // geometrically for DOM-sourced rows.
  const byIdTop = new Map<string, ViewportTopCandidate>()
  for (const el of elements) {
    if (!(el instanceof HTMLElement)) continue
    if (!isElementVisibleInViewport(el, containerRect)) continue
    const rect = el.getBoundingClientRect()
    const id = messageIdOf(el.id)
    const prev = byIdTop.get(id)
    if (!prev || rect.top < prev.top) byIdTop.set(id, { id, top: rect.top, bottom: rect.bottom })
  }
  const candidates: ViewportTopCandidate[] = [...byIdTop.values()]
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
