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
 * - `rawScrollTop` is the exact container scrollTop for same-route fallback.
 *   It is never used as cross-route visual continuity.
 *
 * Ownership note: this module owns NO transition truth. Whether a scroll may
 * be captured is decided by the single route viewport transition controller
 * (provided via React context at the conversation surface); this hook only
 * accepts an optional `canWrite` gate. Transition-period scrolls and window
 * reconciliations must never write — the only writers are displayed-stable
 * real user scrolls and explicit controller stable commits.
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

// --- Route-local key helpers (pure, no fences, no globals) ---
/** Canonical hook key for a topic route (`topic-<id>::<branch|main>`). */
export const routeScrollKey = (topicId: string, branchId: string | null): string =>
  `topic-${topicId}::${branchId ?? 'main'}`

/** Full storage key (`scroll:<routeKey>`) for an explicit route key. */
export const toScrollKey = (routeKey: string): string =>
  routeKey.startsWith('scroll:') ? routeKey : `scroll:${routeKey}`

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

const readSnapshotForKey = (storageKey: string): SavedScrollPosition | null => {
  let saved: unknown
  try {
    saved = window.keyv.get(storageKey)
  } catch {
    return null
  }
  const result = normalizeSaved(saved)
  if (result !== null) {
    try {
      const available = handleScrollSnapshotRead(storageKey)
      if (!available) return null
    } catch {
      return null
    }
  }
  return result
}

/**
 * Trusted commit of a stable viewport snapshot under an explicit route key.
 * Called ONLY by the route viewport controller's stable completion (or an
 * equivalent explicitly current stable path). Respects hard-deletion
 * invalidation (removes instead of recreating). Returns true when a snapshot
 * stands.
 */
export const commitSnapshotForRoute = (routeKey: string, snapshot: SavedScrollPosition | null): boolean => {
  const k = toScrollKey(routeKey)
  try {
    if (isScrollSnapshotInvalidated(k)) {
      try {
        window.keyv.remove(k)
      } catch {}
      return false
    }
  } catch {
    return false
  }
  if (!snapshot) return false
  try {
    window.keyv.set(k, snapshot)
  } catch {
    return false
  }
  try {
    handleScrollSnapshotSaved(k)
  } catch {}
  return true
}

export interface UseScrollPositionOptions {
  /**
   * Gate for ordinary (user-scroll) writes. The route viewport controller
   * supplies this: writes are accepted only while the displayed route is
   * stable. Omitted = always writable (tests / non-route surfaces).
   */
  canWrite?: () => boolean
}

/**
 * A custom hook that manages scroll position persistence for a container element
 * @param key - A unique identifier used to store/retrieve the scroll position
 * @returns An object containing:
 *  - containerRef: React ref for the scrollable container
 *  - handleScroll: Throttled scroll event handler that saves scroll position
 *    (gated by `canWrite`: transition-period scrolls never persist)
 *  - getSavedPosition: Retrieve the saved scroll position for the current key
 *  - getSnapshotForRoute: Retrieve the saved snapshot for an explicit route key
 *  - clearSavedPosition: Remove the persisted scroll position for this key
 *  - savePosition: Immediately persist the current scroll position (gated)
 *  - captureSnapshot: Capture the live viewport snapshot without persisting
 */
export default function useScrollPosition(key: string, throttleWaitOrOptions?: number | UseScrollPositionOptions) {
  const throttleWait = typeof throttleWaitOrOptions === 'number' ? throttleWaitOrOptions : undefined
  const options: UseScrollPositionOptions =
    typeof throttleWaitOrOptions === 'object' && throttleWaitOrOptions !== null ? throttleWaitOrOptions : {}
  const optionsRef = useRef(options)
  optionsRef.current = options
  const canWrite = useCallback((): boolean => {
    try {
      return optionsRef.current.canWrite?.() ?? true
    } catch {
      return false
    }
  }, [])

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
      // The key is bound at schedule time (not read at write time): a trailing
      // write scheduled under the OLD route can never land under the incoming
      // route identity after a switch. Writes are dropped when the controller
      // gate closes (transition intermediates) or while the key is
      // invalidated by hard deletion.
      throttle((args: { k: string; snapshot: SavedScrollPosition }) => {
        const gate = optionsRef.current.canWrite
        // A present gate that returns false drops the write (transition
        // intermediates never persist); no gate = always writable.
        if (gate) {
          let allowed = false
          try {
            allowed = gate()
          } catch {
            allowed = false
          }
          if (!allowed) return
        }
        if (isScrollSnapshotInvalidated(args.k)) {
          try {
            window.keyv.remove(args.k)
          } catch {}
          return
        }
        window.keyv.set(args.k, args.snapshot)
        handleScrollSnapshotSaved(args.k)
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
  // flush the pending trailing snapshot to the OLD key (the trailing payload
  // carries its own key, bound at schedule time), then cancel to prevent any
  // subsequent timer from firing. Flush is dropped when the controller gate
  // is closed so transient intermediates never become the stable snapshot.
  useEffect(() => {
    scrollKeyRef.current = scrollKey
    return () => {
      const gate = optionsRef.current.canWrite
      if (gate && !gate()) {
        persistScrollPosition.cancel()
        return
      }
      persistScrollPosition.flush()
      persistScrollPosition.cancel()
    }
  }, [scrollKey, persistScrollPosition])

  const handleScroll = useCallback(() => {
    if (!canWrite()) return
    const snapshot = captureSnapshot()
    if (!snapshot) return
    const k = scrollKeyRef.current
    persistScrollPosition({ k, snapshot })
  }, [captureSnapshot, persistScrollPosition, canWrite])

  const getSavedPosition = useCallback((): SavedScrollPosition | null => {
    return readSnapshotForKey(scrollKeyRef.current)
  }, [])

  /**
   * Read the stable snapshot for an explicit route key (target-route reads
   * must never rely on the hook's current key while old DOM remains).
   */
  const getSnapshotForRoute = useCallback((routeKey: string): SavedScrollPosition | null => {
    return readSnapshotForKey(toScrollKey(routeKey))
  }, [])

  const clearSavedPosition = useCallback(() => {
    window.keyv.remove(scrollKeyRef.current)
    handleScrollSnapshotCleared(scrollKeyRef.current)
  }, [])

  /**
   * Immediately persist the current scroll position under the current key,
   * bypassing throttle. Dropped when the controller gate is closed so a
   * transient intermediate never overwrites the stable snapshot.
   */
  const savePosition = useCallback(() => {
    persistScrollPosition.cancel()
    if (!canWrite()) return
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
  }, [captureSnapshot, persistScrollPosition, canWrite])

  return {
    containerRef,
    handleScroll,
    getSavedPosition,
    getSnapshotForRoute,
    clearSavedPosition,
    savePosition,
    captureSnapshot
  }
}
