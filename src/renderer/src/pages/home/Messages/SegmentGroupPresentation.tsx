import { useTopicSegments } from '@renderer/hooks/useTopicSegments'
import type { TopicSegment } from '@renderer/types/topicSegment'
import { createContext, type ReactNode, use, useLayoutEffect, useRef, useState } from 'react'
import styled from 'styled-components'

import { INTERACTION_RAIL_LINE_WIDTH_PX, INTERACTION_RAIL_OUTSET_PX, InteractionRailLine } from './GroupInteractionRail'

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
 * - the group's NORMAL-FLOW SLOT is one real in-flow row inside the group's
 *   slot host run — the one mounted run containing the group's route-stable
 *   presentation start (its first member in effective-route order, the member
 *   every route that still reaches the group also reaches at the same place) —
 *   the stable host that already survives fold, expand and edit-mode changes.
 *   The slot occupies the same row per state: the GROUP HEADER ROW (pill,
 *   hit target, menu, mutation authority) when the group's stable head resolves
 *   on the current route — zero-height, sharing the slot run's first message
 *   content band while bodies are shown (its own `32px` only while they are
 *   hidden) — otherwise the equal-height continuation row (rail only, no head
 *   identity). A mounted window without the slot hosts NO row: no temporary
 *   one is ever elected from mounted fragments;
 * - the CONTINUOUS RAIL is ONE absolutely positioned overlay element. It lives
 *   inside the slot row (header or continuation), spanning from the slot down to
 *   the group's last mounted run; when the slot itself is outside the mounted
 *   window it lives as a rail-only continuation inside the group's visual-top
 *   carrying run, with zero in-flow occupancy. Either way it covers the group's
 *   internal divider heights, so the boundary is a single unbroken line instead
 *   of one mark per run. Only the header variant carries the interaction
 *   surface (hit target, group menu, hover); both continuations are visual
 *   only.
 *
 * The span is measured, never inferred: every carrying run host registers itself
 * here, and this one manager owns a single shared ResizeObserver plus one
 * coalesced layout pass over all registered groups. No per-run observers, no
 * per-control measurement, no second scroll owner: the overlay only publishes
 * geometry (top/height) to the owning group, and fold/expand geometry stays
 * with the existing shared viewport controller.
 */

/**
 * Row height every group's normal-flow slot occupies while a collapsed browse
 * block hides its bodies: the header row (pill, hit target, menu, mutation
 * authority) when the group's stable head resolves on the current route,
 * otherwise the equal-height continuation row (rail only, no head identity).
 * Expanded runs share the first message's content band instead (zero in-flow
 * height) — see `SEGMENT_GROUP_PILL_BAND_TOP_PX`. One constant, so the two
 * collapsed presentations can never drift.
 */
export const SEGMENT_GROUP_HEADER_HEIGHT_PX = 32
/** Label pill height (unchanged group-header shape). */
export const SEGMENT_GROUP_PILL_HEIGHT_PX = 24
/**
 * Where the label pill sits when the expanded header shares the first
 * message's own content band: flush with that content's top (the message
 * container's own `10px` top padding), so the group's chrome top equals the
 * first bubble's top instead of sitting below it. The pill's left border
 * joins the rail's right edge (see `TabContainer`), and the rail starts
 * at this same offset — one attached shape, no floating seam.
 */
export const SEGMENT_GROUP_PILL_BAND_TOP_PX = 10
/**
 * Where the rail starts inside the header row: at the pill's own top, so the
 * line and the label read as one continuous boundary. The pill's left border
 * sits on the rail's right edge (no overlap), and the rail runs down from
 * that joint.
 */
export const SEGMENT_GROUP_RAIL_TOP_PX = SEGMENT_GROUP_PILL_BAND_TOP_PX
/**
 * Inter-pair clearance — single truth lives in pairedGroupSizing
 * (PAIRED_GROUP_GAP_PX = 10). Both widths shrink by the same t and the spare
 * distributes as gap >= 10; the minimum pair never collapses the gap.
 */
export const SEGMENT_GROUP_PILL_GAP_PX = 10
/**
 * The label pill's attached left edge, relative to its run host: exactly the
 * rail's right edge (the 2px line spans the host's `[-10,-8]` gutter, the 8px
 * hit target `[-10,-2]`) — the pill's own left border joins the line, so no
 * opaque chip crosses the rail and no connector stem is needed. Previously
 * `-9` (pill border on the rail center: an opaque chip overpainting half the
 * line); one pixel right puts the border on the line's outer edge instead.
 */
export const SEGMENT_GROUP_PILL_LEFT_PX = -8
/**
 * Absolute cap for the label pill: past this width the name truncates
 * (ellipsis, full name on `title`) however wide the free gap is. Rename and
 * menu access travel with the pill (inline rename on the name, group menu on
 * right-click/rail), so a clamped pill never loses its controls.
 */
export const SEGMENT_GROUP_PILL_MAX_W_PX = 280
/**
 * Legacy fixed floor (120) — retained only as a compatibility export.
 * Paired sizing no longer uses it: Lm is the measured first-grapheme +
 * ellipsis + chrome width, actions always mounted. Do not use as a clamp.
 */
export const SEGMENT_GROUP_PILL_MIN_W_PX = 120
/** Rail stops this far above the group's last message row (unchanged trim). */
export const SEGMENT_GROUP_RAIL_TAIL_TRIM_PX = 12
export interface SegmentGroupGeometry {
  /** Rail top inside the group header row. */
  top: number
  /** Rail length covering the group's mounted extent (including dividers). */
  height: number
  /**
   * Stable identity of the run the span is measured relative to: the header
   * run's `runId` for a headed group, otherwise the `runId` of the
   * geometrically topmost carrying run. Top/height and owner publish
   * atomically with one equality — a changed owner with identical numbers
   * still notifies, and a run may paint the rail-only continuation only when
   * this equals its own `runId`.
   */
  anchorRunId: string
}

interface RunRegistration {
  /**
   * Stable identity of the carrying run (the composition's `deriveTurnKey`
   * of that run): the geometry owner is published as this id, never as an
   * order or index, so the rail-only continuation can gate on it.
   */
  runId: string
  /**
   * This run mounts the group's route-stable presentation slot and hosts its
   * ONE in-flow slot row — the header row when the group's stable head
   * resolves on this route (zero-height, sharing the first message's content
   * band while bodies are shown; its own `32px` only while they are hidden),
   * the equal-height continuation row otherwise (at most one per group per
   * commit). Either way it is the group's measured geometry
   * anchor. A carrying run without the slot registers `false`: it is a
   * rail-geometry carrier (and may host the rail-only continuation) but never
   * slot occupancy.
   */
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
  /**
   * Register a node that occupies part of the group's mounted extent without
   * being one of its carrying run hosts: a collapsed fold block's summary row
   * stands in for the whole turns it hides and sits ABOVE the group's header
   * run. Range members widen the measured span (top and bottom) only — they
   * never elect a header and never end a group, because the group's chrome
   * still belongs to its runs. Without them a fully folded group measures a
   * zero-length rail: its run hosts keep their place in flow but contribute no
   * body height. Same lifecycle as `registerRun` (observed, cleared by
   * `suspend`, so a hidden route holds no node).
   */
  registerRangeMember(groupId: string, element: HTMLElement): () => void
  subscribe(groupId: string, listener: () => void): () => void
  getGeometry(groupId: string): SegmentGroupGeometry | null
  /**
   * First rendered message id of the group's header-registered slot run, or
   * `null` when the slot run has no rendered message (collapsed browse
   * block, unmounted window). Read during the coalesced pass; subscribed
   * like geometry.
   */
  getSlotFirstMessageId(groupId: string): string | null
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
  /**
   * Nodes that occupy part of a group's extent without being a carrying run
   * (see `registerRangeMember`). Kept separate from `runs` so measurement can
   * widen the span without ever electing a header or ending a group from them.
   */
  const rangeMembers = new Map<string, Set<HTMLElement>>()
  const geometries = new Map<string, SegmentGroupGeometry>()
  /** Slot run first rendered message per group (see `getSlotFirstMessageId`). */
  const slotFirstByGroup = new Map<string, string>()
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
    const groupIds = new Set<string>([...runs.keys(), ...rangeMembers.keys()])
    for (const groupId of groupIds) {
      const registrations = runs.get(groupId)
      const members = rangeMembers.get(groupId)
      if ((!registrations || registrations.size === 0) && (!members || members.size === 0)) continue
      let header: HTMLElement | null = null
      let headerRunId = ''
      let topmost: { element: HTMLElement; top: number; runId: string } | null = null
      /** Topmost RANGE member: the span's upper bound, never a header. */
      let rangeTop = Infinity
      let bottom = -Infinity
      let endsGroup = false
      if (registrations) {
        for (const [element, registration] of registrations) {
          if (!element.isConnected) continue
          if (registration.isHeader) {
            header = element
            headerRunId = registration.runId
          }
          if (registration.endsGroup) endsGroup = true
          const rect = rectOf(element)
          if (!rect) continue
          bottom = Math.max(bottom, rect.bottom)
          if (!topmost || rect.top < topmost.top) topmost = { element, top: rect.top, runId: registration.runId }
        }
      }
      if (members) {
        for (const element of members) {
          if (!element.isConnected) continue
          const rect = rectOf(element)
          if (!rect) continue
          rangeTop = Math.min(rangeTop, rect.top)
          bottom = Math.max(bottom, rect.bottom)
        }
      }
      // A mounted group whose route-stable slot is outside the window has no
      // slot run at all: the anchor is the topmost carrying run by rect — the
      // group's mounted visual top, the same run this geometry is relative
      // to. The anchor's stable run identity publishes WITH the numbers (see
      // `anchorRunId`): the rail-only continuation paints only in the run
      // matching it, so the composition never elects a carrier of its own.
      // Geometry is still published for that carrier — a rail with no slot
      // occupancy — so the visible group range keeps one continuous line
      // without a temporary `32px` row.
      const anchor = header ?? topmost?.element ?? null
      const anchorRunId = header ? headerRunId : (topmost?.runId ?? '')
      if (!anchor) continue
      const anchorRect = rectOf(anchor)
      // The rail starts AT the slot row's pill top and passes behind the pill:
      // the expanded pill sits at `SEGMENT_GROUP_RAIL_TOP_PX` (flush with the
      // first message's content top), while a collapsed browse block keeps its
      // own `32px` row with the pill at that row's top — read from the anchor
      // run's own DOM attribute, the same projection-of-live-layout the rest of
      // this pass already is. When a range member sits ABOVE the anchor (a
      // collapsed fold block's summary standing in for the group's bodies),
      // the span starts there instead, so the published `top` becomes negative
      // relative to the slot row and the ONE rail still covers everything the
      // group shows.
      const pillOffset = anchor.getAttribute('data-seg-bodies-hidden') === 'true' ? 0 : SEGMENT_GROUP_RAIL_TOP_PX
      const railTopAbs = anchorRect ? Math.min(anchorRect.top + pillOffset, rangeTop) : rangeTop
      const next: SegmentGroupGeometry = {
        top: anchorRect && Number.isFinite(railTopAbs) ? railTopAbs - anchorRect.top : SEGMENT_GROUP_RAIL_TOP_PX,
        height:
          !Number.isFinite(railTopAbs) || !Number.isFinite(bottom)
            ? 0
            : Math.max(0, bottom - railTopAbs - (endsGroup ? SEGMENT_GROUP_RAIL_TAIL_TRIM_PX : 0)),
        anchorRunId
      }
      // The expanded pill shares the slot run's first message content band:
      // publish that message so exactly its content reserves room. A mid-turn
      // group start still reads the run's own first message (not the authority
      // presentation start); a collapsed block reads no message at all.
      // Tracked independently from the rail geometry: either change notifies.
      const slotFirst =
        header && header.isConnected
          ? (header.querySelector('[data-message-id]')?.getAttribute('data-message-id') ?? null)
          : null
      const previousFirst = slotFirstByGroup.get(groupId) ?? null
      const firstChanged = previousFirst !== slotFirst
      if (firstChanged) {
        if (slotFirst === null) slotFirstByGroup.delete(groupId)
        else slotFirstByGroup.set(groupId, slotFirst)
      }
      const previous = geometries.get(groupId)
      if (
        !firstChanged &&
        previous &&
        previous.anchorRunId === next.anchorRunId &&
        Math.abs(previous.top - next.top) < 0.5 &&
        Math.abs(previous.height - next.height) < 0.5
      ) {
        continue
      }
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
        const removed = current.get(element)
        current.delete(element)
        unobserve(element)
        if (current.size === 0) {
          runs.delete(groupId)
          geometries.delete(groupId)
          slotFirstByGroup.delete(groupId)
          notify(groupId)
          return
        }
        // The removed run owned the published span (or the slot-first
        // mapping): drop the publication synchronously so no remaining run
        // can paint the stale owner against its own coordinates. The
        // scheduled pass re-elects ownership from the survivors; a non-owner
        // leaving takes only the coalesced path below.
        const ownedAnchor = removed !== undefined && geometries.get(groupId)?.anchorRunId === removed.runId
        const ownedSlot = removed?.isHeader === true && slotFirstByGroup.has(groupId)
        if (ownedAnchor || ownedSlot) {
          if (ownedAnchor) geometries.delete(groupId)
          if (ownedSlot) slotFirstByGroup.delete(groupId)
          notify(groupId)
        }
        schedule()
      }
    },
    registerRangeMember(groupId, element) {
      let set = rangeMembers.get(groupId)
      if (!set) {
        set = new Set()
        rangeMembers.set(groupId, set)
      }
      set.add(element)
      observe(element)
      schedule()
      return () => {
        const current = rangeMembers.get(groupId)
        if (!current) return
        current.delete(element)
        unobserve(element)
        if (current.size === 0) rangeMembers.delete(groupId)
        // The group's runs still own its chrome: dropping the last range member
        // narrows the span back to the runs instead of erasing the group.
        const registered = runs.get(groupId)
        if (!registered || registered.size === 0) {
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
    getSlotFirstMessageId(groupId) {
      return slotFirstByGroup.get(groupId) ?? null
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
      for (const members of rangeMembers.values()) {
        for (const element of members) observe(element)
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
      rangeMembers.clear()
      geometries.clear()
      slotFirstByGroup.clear()
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
 * The slot run's first RENDERED message: the expanded label pill sits flush
 * with exactly this message's content top, so only its content reserves room.
 * This is the DOM-first message of the header-registered run — not the
 * authority presentation start: a segment may validly start mid-turn
 * (edit-mode selection groups arbitrary subsets), and then the pill still
 * sits at the run's top while the presentation start belongs to a later
 * message. Reading the run's own first `[data-message-id]` keeps the mapping
 * honest in both cases without duplicating the slot-election rule. Published
 * by the same coalesced measurement pass as the rail geometry (no per-message
 * observers, no render side-effects); a collapsed browse block has no rendered
 * messages, so it publishes `null` and no message reserves room.
 */
export const useSegmentSlotFirstMessageId = (groupId: string | undefined): string | null => {
  const manager = useSegmentGroupLayoutManager()
  const [firstId, setFirstId] = useState<string | null>(() =>
    manager && groupId ? manager.getSlotFirstMessageId(groupId) : null
  )

  useLayoutEffect(() => {
    if (!manager || !groupId) {
      setFirstId(null)
      return
    }
    setFirstId(manager.getSlotFirstMessageId(groupId))
    return manager.subscribe(groupId, () => setFirstId(manager.getSlotFirstMessageId(groupId)))
  }, [manager, groupId])

  return firstId
}
/**
 * Whether this message carries the group's expanded label pill: true exactly
 * for the slot run's first rendered message while bodies are shown. One
 * shared composition (segment membership + slot-first mapping) so the
 * message container (which reserves room against the bubble body for user
 * messages, whose header is absolutely positioned and reserves nothing) and
 * the header (which indents the in-flow avatar/name row) can never disagree
 * about which message is headed.
 */
export const useIsHeadedFirstMessage = (topicId: string, messageId: string): boolean => {
  const { isMessageInSegment } = useTopicSegments(topicId)
  const slotFirstId = useSegmentSlotFirstMessageId(isMessageInSegment(messageId)?.id)
  return slotFirstId !== null && slotFirstId === messageId
}
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

/**
 * Rail-only continuation carrier: the absolutely positioned overlay a group
 * paints when its route-stable slot is OUTSIDE the mounted window. Every
 * eligible carrying run mounts one, but only the run whose stable identity
 * matches the manager's published anchor paints it (see `anchorRunId`) —
 * the composition never elects a carrier of its own. It contributes ZERO
 * in-flow height — the group keeps one continuous rail across its mounted
 * extent but never a temporary `32px` row. Visual only: no hit target, no
 * group menu, no hover state.
 */
const ContinuationRail = styled.div<{ $top: number; $height: number }>`
   position: absolute;
   // Same base as the group rail: the shared outset, fully inside the gutter.
   left: -${INTERACTION_RAIL_OUTSET_PX}px;
   top: ${(props) => props.$top}px;
   height: ${(props) => props.$height}px;
   width: ${INTERACTION_RAIL_LINE_WIDTH_PX}px;
  pointer-events: none;
  isolation: isolate;
`

export const GroupRailContinuation: React.FC<{ groupId: string; color: string; runId: string }> = ({
  groupId,
  color,
  runId
}) => {
  const geometry = useSegmentGroupGeometry(groupId)
  if (!geometry || geometry.height <= 0) return null
  // Ownership gate: only the published anchor paints. A stale, missing or
  // unregistered anchor matches no run, so no run paints stale geometry
  // against another coordinate system.
  if (geometry.anchorRunId !== runId) return null
  return (
    <ContinuationRail
      $top={geometry.top}
      $height={geometry.height}
      data-testid="topic-segment-rail-continuation"
      data-segment-id={groupId}
      data-run-id={runId}>
      <InteractionRailLine $color={color} $active={false} />
    </ContinuationRail>
  )
}
/**
 * The group's normal-flow slot when its stable head resolves on ANOTHER route
 * (a route-truncated residual): the same occupied row the header row takes, so
 * a route switch that crosses a fork inside the group leaves the slot — and
 * every shared row around it — exactly where it was.
 *
 * It is ONE real in-flow slot row — zero-height sharing the content band while
 * bodies are shown (its own `32px` only while they are hidden) — holding only
 * and no head identity invented for this route (the head stays a fact of its
 * owning route; `headerMessageId`/`headerOwnedByRoute` never leak across). The
 * residual group is never hidden: its reachable members render below the slot
 * and its rail keeps the group's boundary.
 *
 * The slot row is the group's measured geometry anchor (its carrying run
 * registers as the slot host), so the rail keeps the header variant's offset
 * from the row top (`SEGMENT_GROUP_RAIL_TOP_PX`) and the two presentations are
 * geometrically interchangeable.
 */
const SlotContinuationRow = styled.div`
  position: relative;
  height: 0;
  pointer-events: none;
  // Collapsed browse view: bodies are hidden, so the slot keeps its own row
  // exactly like the collapsed header variant — no other rule changes.
  [data-seg-bodies-hidden='true'] & {
    height: ${SEGMENT_GROUP_HEADER_HEIGHT_PX}px;
  }
  // Out-of-flow rail paint must not be clipped: the rail spans the group's rows
  // below this one, so no overflow/contain clipping may be introduced here.
  isolation: isolate;
`

export const GroupSlotContinuation: React.FC<{ groupId: string; color: string }> = ({ groupId, color }) => {
  const geometry = useSegmentGroupGeometry(groupId)
  return (
    <SlotContinuationRow data-testid="topic-segment-slot-continuation" data-segment-id={groupId}>
      {geometry && geometry.height > 0 ? (
        <ContinuationRail
          $top={geometry.top}
          $height={geometry.height}
          data-testid="topic-segment-rail-continuation"
          data-segment-id={groupId}>
          <InteractionRailLine $color={color} $active={false} />
        </ContinuationRail>
      ) : null}
    </SlotContinuationRow>
  )
}
