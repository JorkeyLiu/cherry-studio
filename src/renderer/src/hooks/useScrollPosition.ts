import { COLUMN_REVERSE_BOTTOM_THRESHOLD_PX, isAtBottom } from '@renderer/pages/home/Messages/columnReverseGeometry'
import { findViewportTopAnchorWithOffset } from '@renderer/pages/home/Messages/domVisibility'
import {
  handleScrollSnapshotCleared,
  handleScrollSnapshotRead,
  handleScrollSnapshotSaved,
  isScrollSnapshotInvalidated
} from '@renderer/services/scrollSnapshotCache'
import { subscribeDeletionGeneration } from '@renderer/services/topicDeletionInvalidation'
import { throttle } from 'lodash'
import { useCallback, useEffect, useMemo, useRef } from 'react'

/**
 * Route-local scroll snapshot (v2 schema).
 * - `messageId` is the canonical route saved ROW anchor (alias `anchorId`
 *   retained for legacy reads). It never carries fork-divider or context
 *   meaning; those anchors live in their own modules.
 * - `intraRowOffset` is `anchorTop - containerTop` (negative when the anchor
 *   row crosses the top edge). Legacy snapshots without it fall back to
 *   anchor-vicinity restore.
 * - `rawScrollTop` is the exact container scrollTop for scrollTop fallback.
 */
export interface SavedScrollPosition {
  scrollTop: number
  anchorId: string | null
  messageId?: string | null
  intraRowOffset?: number | null
  rawScrollTop?: number
  isAtBottom: boolean
}

const BOTTOM_THRESHOLD = COLUMN_REVERSE_BOTTOM_THRESHOLD_PX // px (single column-reverse primitive)

// --- Scroll ownership (programmatic restore guard) ---
// While a programmatic restore holds the token, scroll events must NOT be
// recorded as user scrolling. Reuses the viewport scroll-token concept at the
// hook layer: depth > 0 means "programmatic owns the scroll".
let programmaticScrollDepth = 0

/** True while a programmatic restore holds scroll ownership. */
export const isProgrammaticScrollOwned = (): boolean => programmaticScrollDepth > 0

/**
 * Hold scroll ownership during a programmatic restore. Returns a release
 * function; always pair with try/finally. Re-entrant (depth counted).
 */
export const holdProgrammaticScrollOwnership = (): (() => void) => {
  programmaticScrollDepth += 1
  let released = false
  return () => {
    if (released) return
    released = true
    programmaticScrollDepth = Math.max(0, programmaticScrollDepth - 1)
  }
}

// --- Synchronous OLD-route saver registry ---
// The top selector lives outside Messages and has no container access. Before
// it dispatches a route change it must synchronously persist the OLD route's
// snapshot (never rely on the 100ms throttle trailing or key-change effect
// flush, which only replays a stale trailing snapshot). Messages registers
// its synchronous saver; the top selector invokes it.
let syncRouteSaver: (() => void) | null = null

export const registerRouteScrollSaver = (saver: (() => void) | null): void => {
  syncRouteSaver = saver
}

/** Synchronously persist the OLD route snapshot before a route leaves. No-op when unmounted. */
export const saveRouteScrollSync = (): void => {
  try {
    syncRouteSaver?.()
  } catch {
    // fail-closed: route switch proceeds without a fresh snapshot
  }
}

const normalizeSaved = (saved: unknown): SavedScrollPosition | null => {
  if (saved && typeof saved === 'object' && 'scrollTop' in (saved as Record<string, unknown>)) {
    const rec = saved as Record<string, unknown>
    const anchorId = typeof rec.anchorId === 'string' ? rec.anchorId : null
    const messageId = typeof rec.messageId === 'string' ? rec.messageId : anchorId
    const intraRaw = rec.intraRowOffset
    const intraRowOffset = typeof intraRaw === 'number' && Number.isFinite(intraRaw) ? intraRaw : null
    const rawRaw = rec.rawScrollTop
    const rawScrollTop =
      typeof rawRaw === 'number' && Number.isFinite(rawRaw)
        ? rawRaw
        : typeof rec.scrollTop === 'number'
          ? rec.scrollTop
          : 0
    const isAtBottom = 'isAtBottom' in rec ? !!(rec.isAtBottom as boolean) : false
    const scrollTop = typeof rec.scrollTop === 'number' ? rec.scrollTop : rawScrollTop
    return { scrollTop, anchorId, messageId, intraRowOffset, rawScrollTop, isAtBottom }
  }
  if (typeof saved === 'number') {
    // Backward compatibility: plain number = raw scrollTop only
    return {
      scrollTop: saved,
      anchorId: null,
      messageId: null,
      intraRowOffset: null,
      rawScrollTop: saved,
      isAtBottom: false
    }
  }
  return null
}

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

  const captureSnapshot = useCallback((): SavedScrollPosition | null => {
    const container = containerRef.current
    if (!container) return null
    const scrollTop = container.scrollTop
    const anchor = findViewportTopAnchorWithOffset(container)
    const messageId = anchor?.messageId ?? null
    return {
      scrollTop,
      anchorId: messageId,
      messageId,
      intraRowOffset: anchor ? anchor.intraRowOffset : null,
      rawScrollTop: scrollTop,
      // Column-reverse: bottom (newest) is scrollTop ≈ 0 — single primitive.
      isAtBottom: isAtBottom(scrollTop, BOTTOM_THRESHOLD)
    }
  }, [])

  const persistScrollPosition = useMemo(
    () =>
      throttle((snapshot: SavedScrollPosition) => {
        if (isProgrammaticScrollOwned()) return
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
  // This is only a best-effort fallback: route switches must call
  // savePosition/saveRouteScrollSync synchronously BEFORE the key changes so
  // the OLD route snapshot is fresh and never depends on this flush.
  // Flush respects invalidation so a hard-deleted key is not recreated.
  useEffect(() => {
    scrollKeyRef.current = scrollKey
    return () => {
      if (isProgrammaticScrollOwned()) {
        persistScrollPosition.cancel()
        return
      }
      persistScrollPosition.flush()
      persistScrollPosition.cancel()
    }
  }, [scrollKey, persistScrollPosition])

  const handleScroll = useCallback(() => {
    if (isProgrammaticScrollOwned()) return
    const snapshot = captureSnapshot()
    if (!snapshot) return
    persistScrollPosition(snapshot)
  }, [captureSnapshot, persistScrollPosition])

  const getSavedPosition = useCallback((): SavedScrollPosition | null => {
    const saved = window.keyv.get(scrollKeyRef.current)
    const result = normalizeSaved(saved)
    if (result !== null) {
      const available = handleScrollSnapshotRead(scrollKeyRef.current)
      if (!available) return null
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
   * Route switches call this synchronously BEFORE dispatching the new route
   * so the OLD route key receives a fresh viewport-top snapshot.
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

    const snapshot = captureSnapshot()
    if (!snapshot) return

    window.keyv.set(k, snapshot)
    handleScrollSnapshotSaved(k)
  }, [captureSnapshot, persistScrollPosition])

  // Register the synchronous OLD-route saver while mounted so the top
  // selector can persist the outgoing route before dispatching.
  useEffect(() => {
    registerRouteScrollSaver(savePosition)
    return () => {
      if (syncRouteSaver === savePosition) registerRouteScrollSaver(null)
    }
  }, [savePosition])

  return { containerRef, handleScroll, getSavedPosition, clearSavedPosition, savePosition }
}
