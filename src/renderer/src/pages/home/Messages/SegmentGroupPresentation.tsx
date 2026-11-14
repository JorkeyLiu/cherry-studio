import type { TopicSegment } from '@renderer/types/topicSegment'
import { createContext, type ReactNode, use, useLayoutEffect, useRef, useState } from 'react'

/**
 * Group-level presentation owner for topic-segment chrome.
 *
 * One mounted topic-segment group is ONE presentation entity, but it can be
 * physically shattered by the flow composition: the same segment may be
 * carried by several turn runs (a boundary divider between two of its turns,
 * a differing turn id, a viewport-partial membership), and those runs can sit
 * inside different `SelectionBlock` ranges. Wrapping them in a per-group
 * physical parent would reparent the cross-segment `SelectionBlock` (which
 * already spans dividers and segments), so the group's presentation is
 * anchored instead of wrapped:
 *
 * - the GROUP HEADER ROW is in normal flow inside the group's elected header
 *   run — the stable host that already survives fold, expand and edit-mode
 *   changes — and occupies the same row height in both presentation states;
 * - the CONTINUOUS RAIL is ONE absolutely positioned overlay element inside
 *   that header row, spanning from the header down to the group's last mounted
 *   run. It covers the group's internal divider heights, so the boundary is a
 *   single unbroken line with a single interaction surface (one hit target,
 *   one group menu, one hover state) instead of one mark per run.
 *
 * The span is measured, never inferred: every carrying run host registers itself
 * here, and this one manager owns a single shared ResizeObserver plus one
 * coalesced layout pass over all registered groups. No per-run observers, no
 * per-control measurement, no second scroll owner: the overlay only publishes
 * geometry (top/height) to the owning group, and fold/expand geometry stays
 * with the existing shared viewport controller.
 */

/** Row height every group header occupies in flow, in both states. */
export const SEGMENT_GROUP_HEADER_HEIGHT_PX = 32
/** Label pill height (unchanged group-header shape). */
export const SEGMENT_GROUP_PILL_HEIGHT_PX = 24
/**
 * Where the rail starts inside the header row: just below the pill (4px
 * clearance), exactly the offset the per-run rule used before this redesign.
 */
export const SEGMENT_GROUP_RAIL_TOP_PX = 28
/** Rail stops this far above the group's last message row (unchanged trim). */
export const SEGMENT_GROUP_RAIL_TAIL_TRIM_PX = 12

export interface SegmentGroupGeometry {
  /** Rail top inside the group header row. */
  top: number
  /** Rail length covering the group's mounted extent (including dividers). */
  height: number
}

interface RunRegistration {
  isHeader: boolean
  /** This run carries the group's authority last mounted member. */
  endsGroup: boolean
}

const rectOf = (element: HTMLElement): DOMRect | null => {
  try {
    const rect = element.getBoundingClientRect()
    if (!Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) return null
    return rect
  } catch {
    return null
  }
}

export interface SegmentGroupLayoutManager {
  registerRun(groupId: string, element: HTMLElement, registration: RunRegistration): () => void
  subscribe(groupId: string, listener: () => void): () => void
  getGeometry(groupId: string): SegmentGroupGeometry | null
  /** Synchronous pass; used before paint by the provider's layout effect. */
  measure(): void
  /**
   * Start (or resume) one activation: attach DOM observation and queue a
   * coalesced pass. Idempotent, because every activation calls it.
   */
  resume(): void
  /**
   * End an activation without invalidating the instance: disconnect the
   * observer, cancel the queued frame and drop activation-scoped
   * registrations. `resume()` makes the same instance live again.
   */
  suspend(): void
}

/**
 * One manager per mounted message flow. Its state is DOM-derived and
 * unbuffered by React: geometry is a projection of live layout, never a
 * persisted or authoritative value.
 */
export function createSegmentGroupLayoutManager(): SegmentGroupLayoutManager {
  const runs = new Map<string, Map<HTMLElement, RunRegistration>>()
  const geometries = new Map<string, SegmentGroupGeometry>()
  const listeners = new Map<string, Set<() => void>>()
  let resizeObserver: ResizeObserver | null = null
  let frame: number | null = null
  /**
   * Observation is activation-scoped, never instance-scoped: React Activity
   * hides a route by tearing its effects down while keeping component state
   * and refs, and StrictMode replays a mount the same way. Both hand the same
   * manager instance to the next activation, so a teardown pauses observation
   * instead of invalidating the manager. A freshly created manager is already
   * active; `suspend` pauses it for the teardown interval and `resume` brings
   * the same instance back.
   */
  let active = true

  const notify = (groupId: string) => {
    const set = listeners.get(groupId)
    if (!set) return
    for (const listener of set) listener()
  }

  const connect = () => {
    if (resizeObserver || typeof ResizeObserver !== 'function') return
    try {
      resizeObserver = new ResizeObserver(() => schedule())
    } catch {
      resizeObserver = null
    }
  }

  const observe = (element: HTMLElement) => {
    // A registration that lands before the activation pass is picked up by
    // `resume`, which observes every already-registered element.
    if (!active) return
    connect()
    if (!resizeObserver) return
    try {
      resizeObserver.observe(element)
    } catch {
      // An unobservable node simply falls back to the commit-time pass.
    }
  }

  const unobserve = (element: HTMLElement) => {
    if (!resizeObserver) return
    try {
      resizeObserver.unobserve(element)
    } catch {
      // Ignore: the element may already be detached.
    }
  }

  const stopFrame = () => {
    if (frame === null) return
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
    frame = null
  }

  const schedule = () => {
    if (!active || frame !== null) return
    if (typeof requestAnimationFrame === 'function') {
      frame = requestAnimationFrame(() => {
        frame = null
        measure()
      })
      return
    }
    frame = 0
    void Promise.resolve().then(() => {
      if (frame === null) return
      frame = null
      measure()
    })
  }

  function measure(): void {
    if (!active) return
    for (const groupId of [...runs.keys()]) {
      const registrations = runs.get(groupId)
      if (!registrations || registrations.size === 0) continue
      let header: HTMLElement | null = null
      let topmost: { element: HTMLElement; top: number } | null = null
      let bottom = -Infinity
      let endsGroup = false
      for (const [element, registration] of registrations) {
        if (!element.isConnected) continue
        if (registration.isHeader) header = element
        if (registration.endsGroup) endsGroup = true
        const rect = rectOf(element)
        if (!rect) continue
        bottom = Math.max(bottom, rect.bottom)
        if (!topmost || rect.top < topmost.top) topmost = { element, top: rect.top }
      }
      // A partial mounted group whose own first member is outside the window
      // still has exactly one anchor: its elected header run renders last
      // in newest→oldest order, i.e. at the group's mounted visual top.
      const anchor = header ?? topmost?.element ?? null
      if (!anchor) continue
      const anchorRect = rectOf(anchor)
      const next: SegmentGroupGeometry = {
        top: SEGMENT_GROUP_RAIL_TOP_PX,
        height:
          !anchorRect || !Number.isFinite(bottom)
            ? 0
            : Math.max(
                0,
                bottom - anchorRect.top - SEGMENT_GROUP_RAIL_TOP_PX - (endsGroup ? SEGMENT_GROUP_RAIL_TAIL_TRIM_PX : 0)
              )
      }
      const previous = geometries.get(groupId)
      if (previous && previous.top === next.top && Math.abs(previous.height - next.height) < 0.5) continue
      geometries.set(groupId, next)
      notify(groupId)
    }
  }

  return {
    registerRun(groupId, element, registration) {
      let set = runs.get(groupId)
      if (!set) {
        set = new Map()
        runs.set(groupId, set)
      }
      set.set(element, registration)
      observe(element)
      schedule()
      return () => {
        const current = runs.get(groupId)
        if (!current) return
        current.delete(element)
        unobserve(element)
        if (current.size === 0) {
          runs.delete(groupId)
          geometries.delete(groupId)
          notify(groupId)
          return
        }
        schedule()
      }
    },
    subscribe(groupId, listener) {
      let set = listeners.get(groupId)
      if (!set) {
        set = new Set()
        listeners.set(groupId, set)
      }
      set.add(listener)
      return () => {
        const current = listeners.get(groupId)
        if (!current) return
        current.delete(listener)
        if (current.size === 0) listeners.delete(groupId)
      }
    },
    getGeometry(groupId) {
      return geometries.get(groupId) ?? null
    },
    measure,
    resume() {
      if (active) {
        schedule()
        return
      }
      active = true
      connect()
      // Runs re-register in their own child layout effects before this
      // activation pass, so anything already registered is observed here.
      for (const registered of runs.values()) {
        for (const element of registered.keys()) observe(element)
      }
      schedule()
    },
    suspend() {
      active = false
      stopFrame()
      try {
        resizeObserver?.disconnect()
      } catch {
        // Ignore: teardown must never throw.
      }
      resizeObserver = null
      // Registrations, geometry and subscribers all belong to the effect tree
      // being torn down: a revealed flow re-registers and re-subscribes in its
      // own layout effects, while a hidden one holds no DOM node, listener or
      // pending frame.
      runs.clear()
      geometries.clear()
      listeners.clear()
    }
  }
}

const SegmentGroupLayoutContext = createContext<SegmentGroupLayoutManager | null>(null)

/**
 * Flow-level owner of the group presentation registry. Rendered above the
 * run/selection composition (it adds no DOM node of its own), it owns the
 * single manager instance and re-runs one coalesced layout pass per commit so
 * structural changes (paging, dividers, mounts) and streaming growth share
 * the same measurement path.
 */
export const SegmentGroupPresentationProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const managerRef = useRef<SegmentGroupLayoutManager | null>(null)
  if (!managerRef.current) managerRef.current = createSegmentGroupLayoutManager()
  const manager = managerRef.current

  // One activation per committed mount. React Activity hides a route by
  // tearing its effects down while preserving the component instance, and
  // StrictMode replays the same mount/cleanup cycle, so this cleanup also runs
  // for a hidden-but-alive flow. Observation is therefore paused and resumed
  // on the SAME manager: runs that re-register on return keep a live registry
  // instead of talking to a permanently disposed one.
  useLayoutEffect(() => {
    manager.resume()
    return () => manager.suspend()
  }, [manager])

  // Registered runs sit below this provider's children, so child layout
  // effects (registration) run before this pass: the first commit already
  // measures the real span instead of flashing an empty rail.
  useLayoutEffect(() => {
    manager.measure()
  })

  return <SegmentGroupLayoutContext value={manager}>{children}</SegmentGroupLayoutContext>
}

export const useSegmentGroupLayoutManager = (): SegmentGroupLayoutManager | null => use(SegmentGroupLayoutContext)

/**
 * Live geometry subscription for the group's rail overlay. A group with no
 * registered run (empty or fully unmounted) simply has no geometry and paints
 * nothing.
 */
export const useSegmentGroupGeometry = (groupId: string): SegmentGroupGeometry | null => {
  const manager = useSegmentGroupLayoutManager()
  const [geometry, setGeometry] = useState<SegmentGroupGeometry | null>(() =>
    manager ? manager.getGeometry(groupId) : null
  )

  useLayoutEffect(() => {
    if (!manager) return
    setGeometry(manager.getGeometry(groupId))
    return manager.subscribe(groupId, () => setGeometry(manager.getGeometry(groupId)))
  }, [manager, groupId])

  return geometry
}

/**
 * Group-level presentation facts resolved ABOVE the run/selection composition:
 * one entry per mounted group, independent of how many runs carry it and
 * independent of selection chunking.
 */
export interface SegmentGroupPresentation {
  segment: TopicSegment
  /** The group's authority first message is inside the mounted window. */
  firstMounted: boolean
  /** The group's authority last message is inside the mounted window. */
  lastMounted: boolean
}
