import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/**
 * Accepted display frame: the single visual truth for one committed route.
 *
 * The conversation surface has two route identities that disagree during a
 * switch: the selected intent (Redux `activeBranchId`, already the target)
 * and the displayed route (the controller's committed DOM, still the old
 * route until the target window commits). Boundary, anchor highlight, fork
 * chrome and reference dividers must all follow the displayed route — never
 * the selected intent alone — or the old window visibly loses its boundary
 * before the target arrives.
 *
 * The frame carries the window identity implicitly (the caller renders the
 * committed `viewportState.window` for the displayed route) plus an explicit
 * context visual with a ready/pending distinction: `pending: true` means the
 * target route's closure is not accepted yet (show no boundary), which is
 * different from an authoritative ready `null` boundary (empty/anchorless
 * route, legitimately no boundary). Requests, token counts and permissions
 * keep using the selected authority and never read this visual projection.
 */

export interface DisplayContextVisual {
  boundaryMessageId: string | null
  anchorGroupKey: string | null
  pending: boolean
}

export const PENDING_CONTEXT_VISUAL: DisplayContextVisual = {
  boundaryMessageId: null,
  anchorGroupKey: null,
  pending: true
}

const RETAINED_ROUTE_CAP = 120

export function displayFrameKey(topicId: string, route: string | null): string {
  return `${topicId}::${route ?? 'main'}`
}

/**
 * Pure frame resolution (focused-test entry).
 *
 * Settled (displayed key equals selected key): the live selected visual
 * belongs to the displayed route, so adopt it — including an authoritative
 * ready `null` (true none clears the previous route's boundary) and
 * same-route anchor/fold updates (no frozen display).
 *
 * In flight (keys differ): keep the displayed route's retained visual so the
 * old window never blanks or borrows another route's boundary while the
 * target loads or its closure is still pending. No retained entry, or a
 * retained anchor that no longer matches the displayed route's persisted
 * anchor (stale session: deletion transfer, branch inheritance, A→B→A
 * revisits), resolves to explicit pending — never to a stale boundary.
 */
export function resolveAcceptedContextVisual(args: {
  displayedKey: string
  selectedKey: string
  live: DisplayContextVisual
  retainedForDisplayed: DisplayContextVisual | null
  persistedAnchorForDisplayed: string | null
}): DisplayContextVisual {
  if (args.displayedKey === args.selectedKey) return args.live
  const retained = args.retainedForDisplayed
  if (!retained) return { ...PENDING_CONTEXT_VISUAL }
  if (retained.anchorGroupKey !== args.persistedAnchorForDisplayed) return { ...PENDING_CONTEXT_VISUAL }
  return retained
}

/**
 * Accepted-frame hook: settled adoptions are recorded per route key; the
 * in-flight frame reads the displayed route's retained visual.
 *
 * Render-pure: the retained map is read during render and written in an
 * effect, so concurrent renders never observe a half-written frame.
 */
export function useAcceptedDisplayFrame(args: {
  displayedKey: string
  selectedKey: string
  live: DisplayContextVisual
  persistedAnchorForDisplayed: string | null
}): DisplayContextVisual {
  const { displayedKey, selectedKey, live, persistedAnchorForDisplayed } = args
  const retainedRef = useRef<Map<string, DisplayContextVisual>>(new Map())
  const settled = displayedKey === selectedKey
  const retainedForDisplayed = retainedRef.current.get(displayedKey) ?? null

  useEffect(() => {
    if (!settled) return
    const prev = retainedRef.current.get(selectedKey)
    if (
      prev &&
      prev.boundaryMessageId === live.boundaryMessageId &&
      prev.anchorGroupKey === live.anchorGroupKey &&
      prev.pending === live.pending
    ) {
      return
    }
    retainedRef.current.set(selectedKey, { ...live })
    if (retainedRef.current.size > RETAINED_ROUTE_CAP) {
      const oldest = retainedRef.current.keys().next()
      if (!oldest.done) retainedRef.current.delete(oldest.value)
    }
  }, [settled, selectedKey, live])

  return useMemo(
    () =>
      resolveAcceptedContextVisual({
        displayedKey,
        selectedKey,
        live,
        retainedForDisplayed,
        persistedAnchorForDisplayed
      }),
    [displayedKey, selectedKey, live, retainedForDisplayed, persistedAnchorForDisplayed]
  )
}

/**
 * Route-local fold browse state for the conversation surface.
 *
 * Opening a folded block is view-only browsing: it never changes context
 * participation, is never persisted or synced, and resets when the ACCEPTED
 * display route changes — so an expansion can neither describe another
 * route's surface nor be cleared from under the still-visible old window
 * while a switch is in flight (the reset key is the displayed key, never
 * the selected intent alone).
 */
export function useRouteLocalFoldBrowse(displayedKey: string): {
  expandedFoldSectionIds: ReadonlySet<string>
  toggleExpandFoldSection: (sectionId: string) => void
} {
  const [expandedFoldSectionIds, setExpandedFoldSectionIds] = useState<ReadonlySet<string>>(() => new Set())

  const toggleExpandFoldSection = useCallback((sectionId: string) => {
    setExpandedFoldSectionIds((prev) => {
      const next = new Set(prev)
      if (next.has(sectionId)) next.delete(sectionId)
      else next.add(sectionId)
      return next
    })
  }, [])

  useEffect(() => {
    setExpandedFoldSectionIds((prev) => (prev.size === 0 ? prev : new Set()))
  }, [displayedKey])

  return useMemo(
    () => ({ expandedFoldSectionIds, toggleExpandFoldSection }),
    [expandedFoldSectionIds, toggleExpandFoldSection]
  )
}
